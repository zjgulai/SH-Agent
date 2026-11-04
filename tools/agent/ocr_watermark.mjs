/**
 * ocr_watermark.mjs —— 把 **OCR 读到的水印**从"素材内容"里摘出去。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 2026-10-09（Owner 亲自看出来的，一句话点到根上）
 *
 *   Owner 原话：「图上文字：5615 RO0 Owner 刘华問 ==》**这是我，是因为图片上有水印吗？**」
 *
 *   他判断对。实测那张图的 OCR 全文（库内留痕，逐字）：
 *       5615 RO0 / Owner / 刘华問        ← 水印（用户名 + 工号）
 *       #MomAndMore activity calendar     ← 真内容从这里才开始
 *       Each Group has its own activities—choose the ones you like and join in.
 *       Every week： / 1topic activity & i+ comment or game
 *       Sep 15 / Mystery / activity / begins / 5 / 刘华問 / Week2 / Sep8-14 / 5615 RC
 *       Week1 / Sep 1-7 / 5615 ROOT / Week4 / Sep 22-28 / 5615 / 刘华 / Week3 …
 *       Winners / announcements / every weekend / 华 / 八613 / MOMCOZY / 1化司 / 5615
 *
 *   ── 为什么这一条是**根**，不是"显示不好看" ────────────────────────────────
 *   水印被当成素材内容 ⇒ 它**进了检索**（`review_gate.chainInput` 把 OCR 原文直接喂给链）
 *   ⇒ 拿「Owner / 图片 / 文案」这类**水印里的常用词**去撞库（实测 BM25 207–210）
 *   ⇒ 撞出一堆**无关的内部样本**（实测撞到的是「设计美感」「亚马逊多语言修改」的评审记录）
 *   ⇒ 那几条又被渲染成「**命中**」进报告 ⇒ 整份报告的"问题"全是幻觉。
 *   一句话：**水印污染了检索输入**，后面再怎么修渲染都是白修。
 *
 *   ── 判据：**主判据用坐标**（2026-10-09 当天补上）────────────────────────────
 *   水印最可靠的特征不是"字面重复"，而是「**同一串出现在图的不同位置**」——
 *   文档水印就是同一个串被平铺到页面上。而 OCR 二进制本来就在输出每行的归一化坐标
 *   （`{t,c,x,y,w,h}`），只是上游 `vision.mjs::normalize()` 原先把它丢了
 *   （**已修**：现在带出 `boxes: [{t,x,y}]`）。
 *
 *   ⚠️ 为什么**不用** token 频率：实测过，它分不开 ——
 *     `Week1 / Week2 / Week3 / Week4` 与 `Sep 1-7 / Sep 8-14` 都会被算成"高频"，
 *     而它们是**真内容**（活动日历的周次）。误删真内容的代价是「素材被删了、结论会漏」，
 *     比漏判一个水印严重得多。⇒ 只认「**不同位置上的同一串（或近似同一串）**」。
 *
 *   ⚠️ **原始文本一个字都不丢**：`kept`/`dropped` 两侧都返回，调用方照旧把
 *      `text`（原文）给卡片显示 —— 人看得到"我读到了什么"，也看得到"其中哪些我判成水印"。
 *      库规：「搬是搬，砍是砍」；这里只是**换一份给检索用**。
 */

/** 一行（去空白后）不超过它，才**可能**是水印 —— 人名 / 工号 / 编号都是短串。 */
export const MAX_TOKEN_LEN = 24;
/** 同一个短串至少在**这么多不同位置**出现，才算平铺的水印核心。 */
export const MIN_POSITIONS = 2;
/** **纯数字**核心要更严（见 ① 里的注释：真实素材的规格数字会在多处出现）。 */
export const NUMERIC_MIN_POSITIONS = 3;
/** 两个位置的归一化距离小于它 ⇒ 视为**同一处**（水印是散开的，同处重复不算）。 */
export const MIN_POS_DIST = 0.15;

/**
 * 这一行像不像**真内容**？像就**绝不判水印**（误删代价不对称，见文件头）。
 *
 * 放行四类：
 *   · 过长（> MAX_TOKEN_LEN）；
 *   · 含中文句读或 markdown 痕迹（水印不会带标点）；
 *   · 含 URL / 邮箱 / 话题标签（#xxx）—— 那是内容；
 *   · 含 `let's` / `single-layer` 这类英文短语，或多词短句（≥4 个词）。
 */
export function looksLikeContent(line) {
  const raw = String(line ?? '').trim();
  if (!raw) return false;
  if (raw.length > MAX_TOKEN_LEN) return true;
  if (/[，。！？；：、（）「」【】《》]/.test(raw)) return true;
  if (/https?:\/\/|@[\w.-]+\.\w|#[\w\u4e00-\u9fa5]/.test(raw)) return true;
  if (/[A-Za-z]{3,}['-][A-Za-z]{2,}/.test(raw)) return true;
  if (raw.split(/\s+/).filter(Boolean).length >= 4) return true;
  return false;
}

/** 两个归一化坐标是不是**不同位置**。任一坐标缺失 ⇒ 判不了，返回 false（保守）。 */
function farApart(a, b) {
  if (![a?.x, a?.y, b?.x, b?.y].every((v) => Number.isFinite(v))) return false;
  return Math.abs(a.x - b.x) >= MIN_POS_DIST || Math.abs(a.y - b.y) >= MIN_POS_DIST;
}

/**
 * 送审人的**显示名** —— 水印里那个名字的**确定性来源**（不是猜出来的）。
 *
 * ★★ 2026-10-09（Owner：「图上文字：Owner==》**还有我的名字**」）：
 *   飞书云文档的水印逐字就是「**用户名 + 工号**」（实测 `Owner` / `5615`），
 *   而 `Owner` 正是这条消息的**发送人显示名**（台账里 `sender: Owner`，
 *   `ou_TEST_USER`）。
 *
 *   ⚠️ 为什么还要这一条（**有判据了，为什么不够**）：上面那套「平铺」判据依赖
 *     「OCR 把同一个名字**读出 ≥2 次**，且落在不同位置」。而同一张图的两次 OCR
 *     **读数并不一致**（实测：一次读成 `刘华問`×2 + `Owner`×1，另一次读成
 *     `刘华`×2 + `Owner`×3）⇒ 名字只被读出 **1 次**时它当不上"核心"、摘不掉，
 *     于是卡上/报告里继续带着它。**判据不能靠 OCR 的运气。**
 *   ⇒ 现在补一条**与 OCR 无关**的判据：行**逐字等于**送审人显示名 ⇒ 就是水印。
 *
 *   ⚠️ 为什么只认「逐字相等」、不做"包含"：送审人可能叫 `May`、`Sun`、`Ann`
 *     这类**常见词**，做包含会把正文里的真词删掉（误删真内容的代价不对称，见文件头）。
 *     逐字相等这一条**不可能误删**（正文里恰好只有发送人名字一行的概率极低，
 *     且即便命中，删掉的那一行也确实只是他的名字）。
 *   传 `null`/`(未知名)`/空 时这一条**不生效**（不许拿一个占位符当判据）。
 */
function senderNameCore(senderName) {
  const n = String(senderName ?? '').trim();
  if (!n || n === '(未知名)') return null;
  if (n.length > MAX_TOKEN_LEN) return null;         // 长名字不当判据
  return n;
}

/**
 * 从 OCR 结果里摘出水印行。
 *
 * ★★ 2026-10-09 晚 **v2：拿到真图之后重写**（Owner 把原图发过来了）──────────────
 *
 *   真图 OCR 实测（35 行，归一化坐标）：
 *     · `Owner` **3 次**，位置 (0.278,0.910)/(0.874,0.913)/(0.573,0.755) —— 全不同；
 *     · `5615` **5 种形态**：`5615`/`5615 RO`/`5615 R00`/`5615 ROOT`（另有一处识别成 `615`），
 *       位置全不同；
 *     · 水印**常与邻居粘成一行**（`5615 ROOTOwner`）⇒ 判据必须能吃"包含"。
 *
 *   v1 为什么漏：只认"**同一串**、不同位置"⇒ `5615 RO0/R00/RC/ROOT` 每个只出现一次 ⇒ 全漏。
 *   而 v1 试过的"近似变体"**会误删** `Week1/Sep 15`（实测 35 行误删 17 行，8 行是内容）。
 *
 *   v2 三步（缺一不可，每步都能被真图坐标证实）：
 *     ① **核心词**：短串在**不同位置**出现 ≥ `MIN_POSITIONS` 次；
 *     ② **变体扩展**：短行**包含**核心词 ⇒ 也算水印（这抓 `5615 RO`/`5615 ROOT`）；
 *     ③ **内容豁免**：`looksLikeContent()` 命中的行一律放行。
 *
 *   ⚠️ v2 敢用"包含"、v1 不敢，差别在**核心是被位置判据证明过平铺的**：
 *      `Week1/Week2/Sep 15` 不会在多个位置重复 ⇒ 当不上核心 ⇒ 不会被误删。
 *
 * @param {{text?:string, boxes?:Array<{t:string,x:number,y:number}>, senderName?:string}} ocr
 *        `senderName` = 送审人显示名（可选）。给了就多一条**与 OCR 无关**的判据：
 *        逐字等于它的行判水印（见 `senderNameCore` 的注释）。
 * @returns {{text:string, kept:string[], dropped:string[], cores:string[], basis:string, droppedRatio:number}}
 */
export function stripOcrWatermark(ocr) {
  const src = typeof ocr === 'string' ? { text: ocr } : (ocr ?? {});
  const text = String(src.text ?? '');
  const lines = text.split('\n');
  const boxes = Array.isArray(src.boxes) ? src.boxes : [];
  const norm = (s) => String(s ?? '').replace(/\s+/g, '');

  const droppedIdx = new Set();
  const cores = [];

  // ── ① 核心词：短串在**不同位置**出现 ≥ MIN_POSITIONS 次 ──────────────────
  //   ⚠️ 按**下标**配对，不能按文本建 Map（v1 第一版那样会把同串的多次出现压成一个）。
  if (boxes.length) {
    const byText = new Map();
    lines.forEach((l, i) => {
      const k = norm(l);
      const b = boxes[i];
      if (!k || k.length > MAX_TOKEN_LEN || looksLikeContent(l)) return;
      if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.y)) return;
      if (!byText.has(k)) byText.set(k, []);
      byText.get(k).push({ x: b.x, y: b.y });
    });
    for (const [k, hits] of byText) {
      // ★ 纯数字串要**更严**：真实素材里规格/型号数字（`3 hours`/`9 levels`/`100%`）
      //   本来就可能在多处出现 ⇒ 只出现 2 次的数字**不当核心**，避免误删真内容。
      const need = /^\d+$/.test(k) ? Math.max(MIN_POSITIONS, NUMERIC_MIN_POSITIONS) : MIN_POSITIONS;
      if (hits.length < need) continue;
      const spread = hits.some((a, ai) => hits.some((b, bi) => ai < bi && farApart(a, b)));
      if (spread) cores.push(k);
    }

    // ── ①b **共享数字核心**：编号的各个变体共享同一串数字 ────────────────────
    //   实测（真图）水印编号的变体：`5615R00` / `5615ROOT` / `5615RO` / `615` / `5615`
    //   —— 它们**共享数字核心 `5615`**（`615` 是 OCR 少读一位）。
    //   而内容里的数字：`Sep 15`/`Sep 1-7`/`Sep 8-14`/`Sep 22-28`/`Sep 15-21`/`Week1..4`
    //   —— 取出来的数字（`15`/`1`/`7`/`8`/`14`/`21`/`22`/`28`/`2`/`3`/`4`）**互不共享**。
    //
    //   ⚠️ 这条判据是**第 4 个候选**（前三个都被真图否掉了，记在这里免得再走一遍）：
    //     · v1「近似变体（任意公共子串）」⇒ 误删 `Week1/Sep 15`（35 行误删 17 行）；
    //     · v2a「数字跨 ≥2 行出现」⇒ 误删 `Sep 15`（`15` 出现在两行）；
    //     · v2b「数字须与另一个多处出现的数字同行」⇒ 太严，`5615` 全漏；
    //     · v2c「数字紧邻字母」⇒ 分不开（`Week2`/`Sep 15` 同样紧邻）。
    //   ⇒ 现在这条：**按 4~6 位数字核心聚类**，一个核心 ≥2 个不同形态、且位置不同 ⇒ 收核心。
    {
      const numLines = [];
      lines.forEach((l, i) => {
        if (!l.trim() || looksLikeContent(l)) return;
        const b = boxes[i];
        if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.y)) return;
        const toks = String(l).match(/\d{2,6}/g) ?? [];
        if (toks.length) numLines.push({ i, toks, text: String(l).replace(/\s+/g, ''), pos: { x: b.x, y: b.y } });
      });
      // 数字核心 → { 形态集合, 位置集合 }
      const byCore = new Map();
      for (const rec of numLines) {
        for (const t of rec.toks) {
          // 取该数字串的 4 位前缀作为候选核心（`5615R00` 里的 `5615`；`615` 不够 4 位则跳过）
          for (let L = t.length; L >= 4; L--) {
            for (let st = 0; st + L <= t.length; st++) {
              const core = t.slice(st, st + L);
              if (!byCore.has(core)) byCore.set(core, { forms: new Set(), pos: [] });
              const e = byCore.get(core);
              e.forms.add(rec.text); e.pos.push(rec.pos);
              break;                                   // 每个 token 只取最长那次
            }
          }
        }
      }
      for (const [core, e] of byCore) {
        if (e.forms.size < MIN_POSITIONS) continue;                     // ≥2 个不同形态
        if (e.pos.length < MIN_POSITIONS) continue;
        const spread = e.pos.some((a, ai) => e.pos.some((b, bi) => ai < bi && farApart(a, b)));
        if (spread && !cores.includes(core)) cores.push(core);
      }

      // ── ①c **共享中文人名核心**（2026-10-27 真单修复：`Owner 561 / 华丽 50` 残留）────
      //   病灶：截图中平铺水印常粘连成 `Owner 5615 ROOT` / `华丽 5615 ROOT` / `Owner 561`，
      //   整行各不相同 ⇒ ①a 精确匹配拿不到 `Owner` 核心；①b 只抽了数字 `5615` ⇒
      //   数字被截断成 `561` 或 `50` 的残片（`Owner 561`、`华丽 50`）就漏进正文！
      //   此外 OCR 经常把行尾斜纹读成全角逗号（`Owner 5615，`），被 `looksLikeContent` 误豁免。
      //   ⇒ 对短行里的 2~3 字中文片段（如 `Owner`、`华丽`、`刘华`），若在 ≥2 个不同形态且
      //     不同位置出现（且同一行伴有 ≥2 位数字或 ROOT/ROO 等工号水印特征），收为中文核心。
      const cjkCoreMap = new Map();
      lines.forEach((l, i) => {
        const raw = String(l ?? '').trim();
        if (!raw || raw.length > MAX_TOKEN_LEN) return;
        const b = boxes[i];
        if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.y)) return;
        // 要求该短行同时带有 ≥2 位数字或已识别的水印核心，防止把普通中文标题拆成核心
        if (!/\d{2,}/.test(raw) && !cores.some((c) => raw.includes(c))) return;
        const cjkToks = raw.match(/[\u4e00-\u9fa5]{2,4}/g) ?? [];
        for (const ct of cjkToks) {
          for (let len = Math.min(ct.length, 3); len >= 2; len--) {
            for (let st = 0; st + len <= ct.length; st++) {
              const sub = ct.slice(st, st + len);
              if (!cjkCoreMap.has(sub)) cjkCoreMap.set(sub, { forms: new Set(), pos: [] });
              const entry = cjkCoreMap.get(sub);
              entry.forms.add(norm(raw));
              entry.pos.push({ x: b.x, y: b.y });
            }
          }
        }
      });
      for (const [sub, e] of cjkCoreMap) {
        if (e.forms.size < MIN_POSITIONS || e.pos.length < MIN_POSITIONS) continue;
        const spread = e.pos.some((a, ai) => e.pos.some((b, bi) => ai < bi && farApart(a, b)));
        if (spread && !cores.includes(sub)) cores.push(sub);
      }
    }
  }

  // ── ② 变体扩展：短行**包含**核心词 ⇒ 也算水印 ─────────────────────────────
  //   ★★ 2026-10-27：若短行（≤ MAX_TOKEN_LEN + 8）已明确包含平铺证明过的核心词（如 `5615` / `Owner`），
  //   且整行去核心词与数字/字母碎片后只剩标点（如 `Owner 5615，`），不受行尾误读标点豁免。
  if (cores.length) {
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (!l.trim()) continue;
      const k = norm(l);
      if (!k || k.length > MAX_TOKEN_LEN + 8) continue;             // 粘连行略放宽
      const hitCore = cores.some((c) => k.includes(c));
      if (!hitCore) continue;
      // 去尾部/头部单个 OCR 噪点标点后再看是否像真正文
      const strippedPunct = String(l).trim().replace(/^[，,。！？；：、/\\~～·]+|[，,。！？；：、/\\~～·]+$/g, '');
      if (looksLikeContent(strippedPunct)) continue;                // ③ 内容豁免
      droppedIdx.add(i);
    }
  } else if (!boxes.length) {
    // 兜底（**没有坐标**时）：字面精确重复 ≥2 次
    const freq = new Map();
    for (const l of lines) {
      const k = norm(l);
      if (!k || k.length > MAX_TOKEN_LEN || looksLikeContent(l)) continue;
      freq.set(k, (freq.get(k) ?? 0) + 1);
    }
    lines.forEach((l, i) => {
      const k = norm(l);
      if (k && !looksLikeContent(l) && (freq.get(k) ?? 0) >= 2) droppedIdx.add(i);
    });
  }

  // ── ④ **送审人显示名**：逐字等于它的行 ⇒ 水印（与 OCR 读数无关，见 `senderNameCore`）──
  //   这一条补的是「名字只被 OCR 读出 1 次 ⇒ 当不上核心 ⇒ 摘不掉」那个洞。
  const snCore = senderNameCore(src.senderName);
  let namedHit = 0;
  if (snCore) {
    const want = norm(snCore);
    lines.forEach((l, i) => {
      if (droppedIdx.has(i)) return;
      if (norm(l) === want) { droppedIdx.add(i); namedHit++; }
    });
  }

  const kept = [], dropped = [];
  lines.forEach((l, i) => (droppedIdx.has(i) ? dropped : kept).push(l));
  const total = lines.filter((l) => l.trim()).length || 1;
  // ★ 2026-10-09：`basis` **必须说准是哪条判据干的活**。
  //   病灶：原先只在 `cores.length` 上分支 ⇒ 没有坐标时走的是「字面重复」兜底 **并且真的摘掉了行**，
  //   却照样印 `none`（判据名 `exact-repeat-no-coords` 从 v2 起**再也印不出来**）。
  //   实测（test_agent 的 Z37d 原料）：兜底摘掉 5 行（`刘华問`×2 / `5615`×3），`basis` 却回 `none` ——
  //   行为对、标签错。这一格进日志与卡片那一行，印错了就等于把「为什么摘的」记成了「没摘」。
  //   判据改成**按实际结果**分：一行没摘 ⇒ `none`；摘了 ⇒ 说清是哪条。
  //   ★★ 2026-10-09 晚：再加 `sender-name-in-ocr` —— **只靠送审人显示名摘到的**那一种。
  //     要是把它并进 `core-tiled-...`，就等于把「我只知道那是你的名字」说成
  //     「我证明了它平铺」—— 证据形状不同，不许混成一个名字。
  const basis = !dropped.length
    ? 'none'
    : (namedHit && namedHit === dropped.length)
      ? 'sender-name-in-ocr'
      : cores.length
        ? (boxes.length ? 'core-tiled-at-different-positions' : 'exact-repeat-no-coords')
        : (namedHit ? 'sender-name-in-ocr' : 'exact-repeat-no-coords');
  return { text: kept.join('\n'), kept, dropped, cores, basis, droppedRatio: dropped.length / total };
}

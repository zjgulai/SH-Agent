/**
 * skill_findings.mjs —— 把**判定主体**（图片安全审查 skill）已判出的实质问题，
 * 从链的回答里抽成**结构化条目**，好让它们能上卡。
 *
 * ── 它治的那个病（实测，2026-10-22 那张图）──────────────────────────────────
 *   链（`kb_review_chain`）跑了完整流程：视觉分析、图片安全审查 skill 六步、4A、4B、
 *   图文一致性、视觉核对清单五类 —— 回答 **11478 字**，第八节逐条列出了 5 处实质问题
 *   （抽奖材料性条款整套缺失 / 无参与入口 / 无活动期 / 易被读成 USBC 官方活动 / 图文对不上）。
 *
 *   而**群里那张卡只显示了 1 条**，且那 1 条是库内负面样本 `N-1.360`
 *   （引擎自标「⚠️ 非本单素材逐字命中」）—— 与 skill 判出的那 5 条**毫无关系**。
 *
 *   为什么：卡内逐条来自**双轨合并结果**（`mergeFindings`），而库侧条目抽的是
 *   **机读旁挂的 `risk_items`**（结构化优先）。引擎这份只给了 3 条负面样本命中，
 *   位置全是「顶部，图 1 第 1 处」、类目全是「品牌信任与声誉」⇒ 按对齐规则压成 1 条。
 *   skill 那 5 条判在**散文**里，没有结构化产者 ⇒ **一条都没上卡**。
 *
 *   ⇒ 本模块补的就是那个缺失的结构化产者。**只抽、不判**：一个字都不改 skill 的结论。
 *
 * ── 为什么抽的是「八、分级结论 → 问题清单」这一节 ─────────────────────────────
 *   任务模板（`tools.mjs` 的 `reviewTaskFor`）强制判定主体分段交付，其中
 *   「分级结论」这一节的编号列表是**唯一一处**同时带齐四样东西的：
 *   问题描述 ｜ 位置 ｜ 改法（`改：…`）。前面几节是分析过程（主张拆分表、检索过程），
 *   抽出来会把「过程」当「问题」。
 *
 * ── 边界（说清楚，别让它比输入大）─────────────────────────────────────────────
 *   · **只认编号行 + `｜` 分隔**。没有位置就丢 —— 位置是合并对齐键的一半，
 *     编一个位置出来会让两条不同的问题被并成一条（比漏抽更坏）。
 *   · **标了「参考 / 非本图判定 / 降权」的整条丢**：那是历史意见与降权项，
 *     库侧已经在 `risk_items` 里带着自己的保真边界，再抽一遍等于替它升级成结论。
 *   · **严重度只给 REVIEW**：判定主体在散文里写的问题不是条款命中，
 *     不许由它单独定 BLOCK（与双轨「仅模型侧不由它单独定 BLOCK」同一条纪律）。
 *     真正的 BLOCK 只能来自引擎的 P0 / 条款层。
 *   · 抽不到 ⇒ **如实说抽不到**（`note` 里写原因），不静默返回空 —— 空与「没抽」要长得不一样。
 */

/** 判定主体交付时用的分档标题 → 卡片用的类目（闭集与 `model_side.CATEGORIES` 同源口径）。 */
const BUCKET_CATEGORY = [
  [/安全|风险|事实错误/, '消费者安全', '事实与安全'],
  [/信息完整性|来源/, '合规', '信息完整性与来源'],
  [/图文一致性|误读/, '措辞表达', '图文一致性与潜在误读'],
  [/呈现|发布质量/, '措辞表达', '呈现与发布质量'],
  [/合规|宣称|规则/, '合规', '规则符合性'],
];

/** 这些词出现在条目里 ⇒ 它**不是**本单的问题（历史参考 / 降权项 / 覆盖缺口 / 截图水印 / 明确无）。 */
const NOT_A_FINDING = /（\s*参考|非本图判定|不单独列问题|降权项|覆盖缺口|内部个人署名水印|个人署名水印|5615\s*ROOT|Owner|截图层水印|^\s*无\s*$|^\s*——?\s*无\s*$/;

// 判的是描述这一格的完整结论，不是任意位置出现的「无」。
// 17:30 真单的「无（仅提示：…不作内容问题）」后面仍有位置与建议，
// 不能拿整行套 /^无$/；也不能用 /^无/，否则「无警示标签」会被吞掉。
function explicitlyNoFinding(value) {
  const s = String(value ?? '').replace(/\*\*/g, '').trim().replace(/[。；;]+$/, '').trim();
  if (/^(?:——?\s*)?(?:无|非内容问题)$/.test(s)) return true;
  return /^无\s*[（(](?:仅提示|说明|备注)\s*[:：][^（）()]*[）)]$/.test(s)
    && /(?:不作(?:为)?内容问题|非内容问题)/.test(s);
}

/**
 * 条目文本 → **A3 所属类别（12 类）**。
 *
 * 为什么按关键词给、而不是按分档标题给：分档是 skill 自己的叙述结构
 * （「信息完整性与来源问题」），12 类是规则层的归类（真源
 * `kb/l3/registry/rule-taxonomy.json`）。同一个分档里会混着两类
 * —— 实测那一档 3 条里，两条是**推广与价格透明**（抽奖条款、参与入口），
 * 一条是**背书与披露透明**（易被读成 USBC 官方活动）。
 * 按分档一刀切会让后一条挂错类，而卡面首行印的就是这一格。
 *
 * 盖不到就落 `未归类`（12 类的兜底），**不编**。
 */
const TAXONOMY_RULES = [
  [/抽奖|奖品|促销|价格|优惠|参与入口|报名|活动期|赠品|折扣/i, '推广与价格透明'],
  [/官方|主办|背书|隶属|认证|机构|USBC/i, '背书与披露透明'],
  [/水印|肖像|隐私|授权|出镜|个人信息/, '权利、肖像、隐私与AI'],
  [/图文|画面|一致|记录什么|对不上/, '商品信息与Listing准确性'],
  [/睡姿|睡面|同床|共用睡面|窒息|危险|误用|安全示范/, '产品安全与高危使用场景'],
  [/绝对化|措辞|表述|用词/, '合规与受监管宣称'],
  [/月龄|哺乳|儿科|发育|营养|婴儿睡眠|幼儿/, '母婴知识内容准确性'],
];

function taxonomyOf(text, bucketSub) {
  const s = String(text ?? '');
  for (const [re, name] of TAXONOMY_RULES) if (re.test(s)) return name;
  return null;   // 盖不到 ⇒ 交给调用方落 `未归类`
}

/**
 * 位置归一成 PRD §5.3.3 的三种模式之一（`图 N 第 X 处`）。
 * 实测那份写成「中部，图 1 第 5 处、第 6 处」—— 两个位置塞在一格，
 * 判据（`prd533.checkLocation`）判它不在三模式内，整条会被卡面标成违规。
 * 取**第一个**位置并保留前面的区块词（`中部，`），不丢坐标。
 */
function normLocation(s) {
  const t = String(s ?? '').trim();
  const m = /^(.*?图\s*\d+\s*第\s*\d+\s*处)/.exec(t);
  if (m) return m[1].replace(/\s+/g, ' ').trim();
  return t;
}

/** 描述上限（PRD §5.3.3「问题描述 ≤50 字」）。超了按句读截断，**不硬切**。 */
const DESC_MAX = 50;

function clipDesc(s) {
  const t = String(s ?? '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
  if ([...t].length <= DESC_MAX) return t;
  // 在标点处断，断不了再硬切 —— 硬切只发生在**没有标点**的长串上。
  const cut = [...t].slice(0, DESC_MAX).join('');
  const at = Math.max(cut.lastIndexOf('，'), cut.lastIndexOf('。'), cut.lastIndexOf('；'), cut.lastIndexOf('、'));
  return at >= DESC_MAX / 2 ? cut.slice(0, at) : cut;
}

/**
 * 把链的回答抽成结构化条目。
 *
 * @param {string} answer 链的最终回答（`res.answer`）
 * @returns {{findings:Array, note:string, buckets:Array, skipped:Array}}
 */
export function skillFindingsOf(answer) {
  const text = String(answer ?? '');
  const out = { findings: [], note: '', buckets: [], skipped: [] };
  if (!text.trim()) { out.note = '链没有回答 ⇒ 判定主体这一侧没有可抽的东西'; return out; }

  // ── 只在「问题清单」之后找 ────────────────────────────────────────────────
  //   为什么锚这一句：前面每一节也有编号列表（实测那份「1. 这 3 条全部是…」是
  //   **保真边界**，不是问题）。锚不到就整块不抽 —— 宁可少抽，不许把边界当问题。
  // ── 只在「八、分级结论」这一节里找 ────────────────────────────────────────
  //   ★★ 2026-10-22 **当天就改了一次**（同一张图第二单实测）：锚原先只认
  //   `**问题清单**`，而这一单判定主体写的是 `**问题优先级（按 skill 顺序，未重排）**`
  //   ⇒ 锚不到 ⇒ 抽出 0 条（日志如实写了「一条都没上卡」，判据没撒谎，是锚太窄）。
  //   现在**三级兜底**，最后一级锁在「八、分级结论」这个小节标题上 ——
  //   那是任务模板强制交付的固定分段，比小标题稳。
  //   前面几节也有编号列表（实测「1. 这 3 条全部是…」是**保真边界**，不是问题），
  //   所以绝不用「全文找编号行」这种兜底。
  //   ★★ 2026-10-22 第二处扩（BM04/BM01 真单）：这一单写的是 `### 问题清单（按 skill
  //   优先级排序）`（**标题**，不是粗体）⇒ 前三级都锚不到 ⇒ 0 条。现在加标题级锚点。
  //   ★ 回滚开关：`SHOUHENG_SKILL_FINDINGS_F=0` ⇒ 锚点与 F 型解析都回到改动前
  //     （只认粗体三锚点 + `1.` 编号行）。默认开。**改的是产出，不改判定**。
  const F_SHAPE_ON = String(process.env.SHOUHENG_SKILL_FINDINGS_F ?? '1').trim() !== '0';
  const heads = F_SHAPE_ON ? [
    /\*\*\s*问题清单/,
    /\*\*\s*问题优先级/,
    /^#{1,4}\s*(?:[一二三四五六七八九十\d]+[、.．]\s*)?问题清单/m,
    /^#{1,3}\s*八[、.．\s]*分级结论/m,
  ] : [
    /\*\*\s*问题清单/,
    /\*\*\s*问题优先级/,
    /^#{1,3}\s*八[、.．\s]*分级结论/m,
  ];
  let anchor = -1;
  for (const re of heads) { const at = text.search(re); if (at >= 0) { anchor = at; break; } }
  if (anchor < 0) {
    out.note = '回答里既没有「问题清单/问题优先级」，也没有「八、分级结论」这一节'
      + ' ⇒ 判定主体没有交付逐条（可能链没跑完 skill 流程）';
    return out;
  }
  const body = text.slice(anchor);

  let bucket = { raw: '', category: '合规', sub: '判定主体的核查' };
  let seenItemBucket = false;
  // ── F 型条目（2026-10-22 BM04/BM01 真单）：**先攒、再收口** ──────────────────
  //   形状：`**F1（优先 2｜安全信息不完整 + 潜在误读）**` 起头，随后
  //   `- 位置：…` / `- 为什么：…` / `- 建议：…` 各一行。
  //   这是 skill 交付模板里**最常见**的一种（这次 F1–F5 全是它），原先只认 `1.`
  //   编号行 ⇒ 一条都抽不到（日志「一条都没上卡」说的就是这条通道）。
  let pending = null;
  const flushF = () => {
    if (!pending) return;
    const p = pending; pending = null;
    // 「降权」整条不上卡 —— 与文件头「边界」同一条（那是历史口味，不是本单的问题）
    if (/降权/.test(p.label)) {
      out.skipped.push({ text: p.label.slice(0, 40), why: '标了「降权」—— 不上卡' });
      return;
    }
    if (NOT_A_FINDING.test(`${p.label} ${p.why ?? ''}`) || explicitlyNoFinding(p.why || p.label)) {
      out.skipped.push({ text: (p.why || p.label).slice(0, 40), why: '标了参考/降权/无 —— 不是本单的问题' });
      return;
    }
    const locHit = /((?:[\u4e00-\u9fa5]{0,4}[，,]\s*)?图\s*\d+\s*第\s*\d+\s*处)/.exec(`${p.locRaw ?? ''} ${p.why ?? ''}`);
    if (!locHit) {
      out.skipped.push({ text: (p.why || p.label).slice(0, 40), why: '没给位置（位置是合并对齐键，编不出来）' });
      return;
    }
    const clean = (s) => String(s ?? '').replace(/\*\*/g, '').replace(/[；;。\s]+$/, '').trim();
    const description = clipDesc(clean(p.why) || p.label);
    if (!description) { out.skipped.push({ text: p.label, why: '没有描述' }); return; }
    const hit = BUCKET_CATEGORY.find(([re]) => re.test(p.label));
    const category = hit ? hit[1] : '合规';
    const sub = (hit ? hit[2] : p.label).slice(0, 12);
    if (p.label) out.buckets.push(p.label);
    out.findings.push({
      // 与编号行那一支**同形**（合并语义一个字都不改：仅模型侧条目不单独定 BLOCK）
      source: 'model',
      origin_track: 'skill',
      location: normLocation(locHit[1]),
      category,
      sub,
      taxonomyCategory: taxonomyOf(`${description} ${p.label} ${p.why ?? ''}`, sub),
      taxonomySubcategory: sub,
      description,
      // ★★ 2026-10-27 修复：卡片三行版（`renderMergedItem`）只印 `原因 / 依据 / 建议`，**不印 `description`**。
      //   此前 `reason` 写死为「判定主体的核查结论（…）——未落在库内条款上，需人工确认」，
      //   导致卡片上完全看不到具体风险内容（如「两名幼儿同处一个睡面」），只剩一句空洞套话。
      //   现在将具体风险描述直接作为 `reason`，让卡片与报告都能一眼看到业务风险原因。
      reason: description,
      suggestion: clean(p.advice),
      severity: 'REVIEW',
      basis_kind: 'skill_report',
      model: { basis_kind: 'skill_report', source_label: '图片安全审查' },
    });
  };
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    // F 型条目起头（必须先于「分档标题」判断：`**F1（…）**` 也是粗体行）
    const fHead = /^\*\*\s*F\s*(\d+)\s*(?:[（(]([^）)]*)[）)])?\s*\*\*\s*$/.exec(line);
    if (F_SHAPE_ON && fHead) {
      flushF();
      pending = { n: fHead[1], label: String(fHead[2] ?? '').replace(/\*\*/g, '').trim(),
                  locRaw: '', why: '', advice: '' };
      seenItemBucket = true;    // 见过条目 ⇒ 后面不带前缀的粗体标题要收口
      continue;
    }
    if (pending) {
      const kv = /^[-*]\s*(位置|为什么|原因|建议|改|锚点)\s*[:：]\s*(.*)$/.exec(line);
      if (kv) {
        const k = kv[1];
        const v = String(kv[2] ?? '').trim();
        if (k === '位置') pending.locRaw = v;
        else if (k === '锚点') pending.locRaw = `${pending.locRaw} ${v}`.trim();
        else if (k === '为什么' || k === '原因') pending.why = v;
        else pending.advice = v;
        continue;
      }
      if (!line) continue;
      // 非字段行：编号行/标题/粗体 ⇒ 这一条收口，交回原有解析；其余算续行
      if (/^\d+[.、]/.test(line) || /^#/.test(line) || /^\*\*/.test(line)) {
        flushF();
      } else {
        if (pending.advice) pending.advice += line;
        else pending.why += line;
        continue;
      }
    }
    // 分档标题：**② 信息完整性与来源问题（REVIEW 候选）—— 3 条**
    if (/^\*\*/.test(line) && !/^\*\*\s*\d+[.、]/.test(line)) {
      const h = /^\*\*\s*([①-⑩]|\d+)?\s*([^（*]+)/.exec(line);
      // ★ 带圈/数字前缀才是分档标题；**不带前缀的粗体标题 = 问题清单这一节结束了**
      //   （实测那份后面还有「**必须一起转述的边界**」「**推荐项**」等段落，
      //   不在这里收口，它们会把后续段落的条目按错类目上卡）。
      //   锚点那一行自己也不带前缀 —— 所以只在**见过分档之后**才收口。
      if (!h?.[1]) {
        if (seenItemBucket) break;
        continue;
      }
      seenItemBucket = true;
      const label = String(h?.[2] ?? '').trim();
      if (label) {
        const hit = BUCKET_CATEGORY.find(([re]) => re.test(label));
        bucket = {
          raw: label,
          category: hit ? hit[1] : '合规',
          sub: (hit ? hit[2] : label).slice(0, 12),
        };
        out.buckets.push(bucket.raw);
      }
      // ⚠️ 「**① 事实错误 + 安全风险（BLOCK 候选）—— 无**」这种档**本来就没有条目**，
      //    但它仍是读数：说明这一类查过、结论是无。所以这里只换档，不中止。
      continue;
    }
    const m = /^(\d+)[.、]\s*(.+)$/.exec(line);
    if (!m) continue;
    const rest = String(m[2] ?? '').trim();
    if (NOT_A_FINDING.test(rest)) {
      out.skipped.push({ text: rest.slice(0, 40), why: '标了参考/降权/无 —— 不是本单的问题' });
      continue;
    }

    // ── 两型都要认（**同一张图的两轮实测，写法就不一样**）────────────────────
    //   甲型：`1. 描述｜位置｜改：建议`                     （14:11 那一轮）
    //   乙型：`1. **标题**：描述 → 位置：X。**建议**：建议` （14:34 那一轮）
    //   共同点只有三样：编号行、`图 N 第 X 处`、一个建议标记。判据就按这三样立，
    //   **不按分隔符立** —— 分隔符是模型顺手写的，不是契约。
    const locHit = /((?:[\u4e00-\u9fa5]{0,4}[，,]\s*)?图\s*\d+\s*第\s*\d+\s*处)/.exec(rest);
    if (!locHit) {
      out.skipped.push({ text: rest.slice(0, 40), why: '没给位置（位置是合并对齐键，编不出来）' });
      continue;
    }
    const location = locHit[1];
    const adviceHit = /\*\*建议\*\*[:：]\s*([^\n]+)/.exec(rest) || /改[:：]\s*([^\n]+)/.exec(rest);
    const advice = adviceHit ? adviceHit[1].replace(/[；;。\s]+$/, '').trim() : '';

    let descPart = rest;
    if (rest.includes('｜')) {
      const seg = rest.split('｜').map((s) => s.trim()).filter(Boolean);
      descPart = seg.find((p) => !/图\s*\d+\s*第\s*\d+\s*处/.test(p) && !/^改[:：]/.test(p)) ?? seg[0];
    }
    descPart = descPart
      .replace(/^\*\*[^*]+\*\*[:：]\s*/, '')        // 去标题粗体（乙型）
      .replace(/→\s*位置[:：][\s\S]*$/, '')         // 去「→ 位置：…」及其后
      .replace(/位置[:：][\s\S]*$/, '')
      .replace(/\*\*建议\*\*[:：][\s\S]*$/, '')
      .replace(/改[:：][\s\S]*$/, '')
      .trim();
    if (explicitlyNoFinding(descPart)) {
      out.skipped.push({ text: descPart.slice(0, 40), why: '明确无内容问题，附注不计为发现' });
      continue;
    }
    const description = clipDesc(descPart);
    if (!description) { out.skipped.push({ text: rest.slice(0, 40), why: '没有描述' }); continue; }

    out.findings.push({
      // 与 `mergeFindings` 的模型侧条目同形 —— 合并语义一个字都不改：
      // 仅模型侧命中 ⇒ 并集、不单独定 BLOCK、不参与 PASS 的成立条件。
      source: 'model',
      // ★ 本模块的条目**不是** `model_side.mjs` 那一遍的产物，卡片与日志都要能分开说。
      origin_track: 'skill',
      location: normLocation(location),
      category: bucket.category,
      sub: bucket.sub,
      // ★ A3 12 类：卡面首行印的是这一格（不填 ⇒ `【未归类】`）
      taxonomyCategory: taxonomyOf(`${description} ${rest}`, bucket.sub),
      taxonomySubcategory: bucket.sub,
      description,
      // ★★ 2026-10-27 修复：卡片三行版只渲染 `reason`，不渲染 `description`。
      //   把判定主体写出的实质风险描述直接作为 `reason`，消灭「判定主体的核查结论（判定主体的核查）」空话。
      reason: description,
      // ⚠️ 字段名是 `suggestion`（`pickModel` 只搬这一格；叫 `advice` 会**静默消失**——
      //    白名单式搬运的老坑，本文件头注里记的那条一样）。
      suggestion: advice,
      severity: 'REVIEW',            // 见文件头「边界」：散文问题不许单独定 BLOCK
      basis_kind: 'skill_report',
      model: { basis_kind: 'skill_report', source_label: '图片安全审查' },
    });
  }
  flushF();   // 最后一组 F 型条目在文末也要收口

  out.note = out.findings.length
    ? `从「问题清单」抽出 ${out.findings.length} 条`
      + (out.skipped.length ? `（另有 ${out.skipped.length} 条按规则跳过）` : '')
    : `锚到了「问题清单」，但一条都没抽出来（跳过 ${out.skipped.length} 条）`
      + ' ⇒ 判定主体这一侧没有可上卡的逐条';
  return out;
}

/** 自证：纯函数，不碰网络、不碰盘。`node agent/skill_findings.mjs --selftest` */
export function selftest() {
  const eq = (a, b, m) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}：期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`);
  };
  const cases = [];
  const t = (name, fn) => { try { fn(); cases.push([name, true]); } catch (e) { cases.push([`${name} —— ${e.message}`, false]); } };

  const SAMPLE = [
    '## 八、分级结论',
    '',
    '**问题清单（严格按 skill 优先级排序，不重排）**',
    '',
    '**① 事实错误 + 安全风险（BLOCK 候选）—— 无**',
    '',
    '**② 信息完整性与来源问题（REVIEW 候选）—— 2 条**',
    '1. 抽奖条款整套缺失（免购买参与方式/官方规则/资格）｜中部，图 1 第 5 处｜改：加规则链接与合规小字。',
    '2. 无参与入口（无 URL/QR/落地页）｜底部，图 1 第 8 处｜改：补可扫可点的落地路径。',
    '',
    '**③ 图文一致性与潜在误读（REVIEW 候选）—— 1 条 + 1 条参考**',
    '3. 画面读不出「在记录什么」｜中部，图 1 第 4 处｜改：让动作在画面里可读。',
    '4.（参考，**非本图判定**）历史意见：画面过于完美｜顶部，图 1 第 1 处｜改：无。',
  ].join('\n');

  t('抽得出条目', () => {
    const r = skillFindingsOf(SAMPLE);
    eq(r.findings.length, 3, '条数');
    eq(r.findings[0].location, '中部，图 1 第 5 处', '位置');
    eq(r.findings[0].category, '合规', '类目');
    eq(r.findings[2].category, '措辞表达', '图文一致性那一档的类目');
    // ⚠️ 断言的是 `suggestion` —— `pickModel` 只搬这一格；改名成 `advice` 会在合并时静默消失。
    eq(r.findings[0].suggestion, '加规则链接与合规小字', '建议（句末标点被归一化掉）');
    eq(r.findings[0].location, '中部，图 1 第 5 处', '位置归一（两个位置塞一格 ⇒ 取第一个）');
    eq(r.findings[0].taxonomyCategory, '推广与价格透明', 'A3 类目（按关键词，不按分档一刀切）');
    eq(r.findings[2].taxonomyCategory, '商品信息与Listing准确性', '图文一致性那一条的 A3 类目');
  });

  t('参考条目不许上卡（不是本单的问题）', () => {
    const r = skillFindingsOf(SAMPLE);
    eq(r.findings.some((f) => /历史意见/.test(f.description)), false, '参考条目混进来了');
    eq(r.skipped.length, 1, '跳过数');
  });

  t('严重度只给 REVIEW（散文问题不许单独定 BLOCK）', () => {
    const r = skillFindingsOf(SAMPLE);
    eq([...new Set(r.findings.map((f) => f.severity))], ['REVIEW'], '严重度');
  });

  t('反向对照：没有位置就丢（位置是对齐键）', () => {
    const r = skillFindingsOf('**问题清单**\n\n**② 信息完整性与来源问题（REVIEW 候选）**\n1. 抽奖条款缺失｜改：补上。\n');
    eq(r.findings.length, 0, '无位置却抽出来了');
    eq(r.skipped.length, 1, '跳过数');
  });

  t('反向对照：锚不到「问题清单」⇒ 一条都不抽，且要说出来', () => {
    const r = skillFindingsOf('## 六、图文一致性\n1. 这 3 条全部是「相似历史审核意见」｜顶部，图 1 第 1 处｜改：无。\n');
    eq(r.findings.length, 0, '锚不到却抽出来了');
    eq(/既没有「问题清单/.test(r.note), true, 'note 没说清原因');
  });

  t('乙型写法（`**标题**：描述 → 位置：… **建议**：…`）也认 —— 同一张图两轮实测就不一样', () => {
    const B = [
      '## 八、分级结论',
      '**问题优先级（按 skill 顺序，未重排）**',
      '1. **信息完整性与来源（最高优先）**：抽奖规则/资格/起止日期全缺 → 位置：左侧，图 1 第 6 处。**建议**：补官方规则短链。',
      '2. **权利归属（让位）**：婴幼儿出镜证据未见 → 转 AI溯源与权利审查 核实。',
    ].join('\n');
    const r = skillFindingsOf(B);
    eq(r.findings.length, 1, '条数（让位项没位置 ⇒ 丢）');
    eq(r.findings[0].location, '左侧，图 1 第 6 处', '位置');
    eq(r.findings[0].suggestion, '补官方规则短链', '建议');
    eq(/抽奖规则/.test(r.findings[0].description), true, '描述');
  });

  t('反向对照：空回答 ⇒ 不造条目', () => {
    eq(skillFindingsOf('').findings.length, 0, '空回答');
    eq(skillFindingsOf(null).findings.length, 0, 'null');
  });

  /* ★★ 2026-10-22（BM04/BM01 真单）：**F 型条目**。
   *   这一单写的是 `### 问题清单（按 skill 优先级排序）`（标题，不是粗体）
   *   ＋ `**F1（优先 2｜…）**` ＋ `- 位置：…` / `- 为什么：…` / `- 建议：…`。
   *   原先锚点（只认粗体）与条目（只认 `1.`）**两道都不匹配** ⇒ 抽出 0 条，
   *   表里问题数量 0、不建报告、卡片结论全靠模型自拟。
   *   本组同时钉住：标题级锚点、F 型字段行、降权项不上卡、没位置就丢。 */
  const FSAMPLE = [
    '## 七、视觉核对清单与分级结论',
    '',
    '### 问题清单（按 skill 优先级排序）',
    '',
    '**F1（优先 2｜安全信息不完整 + 潜在误读）**',
    '- 位置：**右侧，图 1 第 6 处**（锚点＝BM01 型号标签，指其右侧产品卡内监视器屏）',
    '- 为什么：屏内婴儿颏/颊紧贴蓝色布与灰蓝软物；AAP 明列睡眠区不得放松软物，整图无安全提示。',
    '- 建议：换用「无松软织物贴近面部」的画面；或图内加一句安全提示。',
    '',
    '**F2（优先 3｜图文一致性/潜在误读）**',
    '- 位置：**顶部，图 1 第 1 处**（标题 Keep an Eye on Every Room）',
    '- 为什么：监护类标题与婴儿睡卧影像并列，易被读成监护器可替代看护。',
    '- 建议：加免责提示，或避免与睡眠影像强绑定。',
    '',
    '**F3（优先 2｜事实无法确认）**',
    '- 位置：**中部，图 1 第 10 处**（$259.99 USD）、中部，图 1 第 12 处（1080p Full HD）',
    '- 为什么：无 SKU 事实基线；Long Battery 无时长、1080p 未注明归属。',
    '- 建议：补具体数值与口径。',
    '',
    '**F5（优先 4｜呈现质量，降权）**',
    '- 位置：**右侧，图 1 第 6 处**（5″ HD 角标）',
    '- 为什么：角标遮挡屏幕内容，非安全问题。',
    '- 建议：角标移出画面主体。',
  ].join('\n');

  t('★ F 型条目（`**F1（…）**` + `- 位置/为什么/建议`）必须抽得出来', () => {
    const r = skillFindingsOf(FSAMPLE);
    eq(r.findings.length, 3, '条数（F5 标了降权 ⇒ 不上卡）');
    eq(r.findings[0].location, '右侧，图 1 第 6 处', 'F1 位置');
    eq(r.findings[0].category, '消费者安全', 'F1 类目（按「安全」关键词）');
    eq(r.findings[0].suggestion, '换用「无松软织物贴近面部」的画面；或图内加一句安全提示', 'F1 建议');
    eq([...r.findings[0].description].length <= 50, true, 'F1 描述按 50 字截断');
    eq(r.findings[1].category, '措辞表达', 'F2 类目（图文一致性）');
    eq(r.findings[1].location, '顶部，图 1 第 1 处', 'F2 位置');
    eq(/SKU/.test(r.findings[2].description), true, 'F3 描述');
    eq(r.skipped.some((s) => /降权/.test(s.why)), true, '降权项要有跳过记录');
    eq([...new Set(r.findings.map((f) => f.severity))], ['REVIEW'], '严重度仍只给 REVIEW');
    eq(r.findings.every((f) => f.origin_track === 'skill'), true, '来路仍是 skill');
  });

  t('反向对照：F 型没给位置 ⇒ 不许抽（位置是合并对齐键）', () => {
    const r = skillFindingsOf([
      '### 问题清单',
      '**F1（优先 2｜安全）**',
      '- 为什么：画面有风险。',
      '- 建议：改。',
    ].join('\n'));
    eq(r.findings.length, 0, '没位置却抽出来了');
    eq(r.skipped.length, 1, '跳过数');
  });

  t('回滚开关：`SHOUHENG_SKILL_FINDINGS_F=0` ⇒ 回到改动前（F 型不抽）', () => {
    const old = process.env.SHOUHENG_SKILL_FINDINGS_F;
    try {
      process.env.SHOUHENG_SKILL_FINDINGS_F = '0';
      const r = skillFindingsOf(FSAMPLE);
      eq(r.findings.length, 0, '开关关掉后仍抽出了 F 型条目');
    } finally {
      if (old === undefined) delete process.env.SHOUHENG_SKILL_FINDINGS_F;
      else process.env.SHOUHENG_SKILL_FINDINGS_F = old;
    }
  });

  t('描述超 50 字按句读截断，不硬切', () => {
    const long = '抽奖材料性条款整套缺失，包括免购买参与方式、官方规则、资格限制、起止日期、中奖概率、赞助方说明';
    const r = skillFindingsOf(`**问题清单**\n\n**② 信息完整性与来源问题（REVIEW 候选）**\n1. ${long}｜中部，图 1 第 5 处｜改：补。\n`);
    eq(r.findings.length, 1, '条数');
    eq([...r.findings[0].description].length <= 50, true, '超 50 字');
    eq(/，$/.test(r.findings[0].description), false, '截断后留了悬空逗号');
  });

  const noIssue = '无（仅提示：显示屏数字与袋身刻度、说明小字不可辨，属呈现可读性，不作内容问题）';
  for (const shape of ['编号行', 'F 型']) {
    const report = (why) => shape === '编号行'
      ? `### 问题清单\n1. ${why}｜中部，图 1 第 3 处｜改：正式投放前确认关键信息可读。`
      : `### 问题清单\n**F1（优先 4｜呈现质量）**\n- 位置：中部，图 1 第 3 处\n- 为什么：${why}\n- 建议：正式投放前确认关键信息可读。`;
    for (const why of [noIssue, '无', '非内容问题', '无（仅提示：小字可读性待优化，非内容问题）']) {
      t(`17:30 反例：${shape}明确无问题及附注不应生成 REVIEW（${why.slice(0, 12)}）`, () => {
        const r = skillFindingsOf(report(why));
        eq(r.findings.length, 0, '明确无问题被计为发现');
        eq(r.skipped.length, 1, '明确无问题仍须留跳过记录');
      });
    }
    for (const why of [
      '无警示标签，读者无法判断使用限制',
      '无需重复展示产品名，但图示与标签不一致',
      `${noIssue}，但安全警示缺失，应单独修正`,
      '无（仅提示：小字不可辨，非内容问题），但安全警示缺失，必须修正',
      '不能把缺失警示标为非内容问题，读者无法知道使用限制',
    ]) {
      t(`反向对照：${shape}保留真实问题「${why.slice(0, 14)}」`, () => {
        const r = skillFindingsOf(report(why));
        eq(r.findings.length, 1, '不能仅因出现无/不作内容问题便丢掉风险');
        eq(r.findings[0].severity, 'REVIEW', '真实问题仍进入原有审查分流');
      });
    }
  }

  const bad = cases.filter(([, ok]) => !ok);
  for (const [name, ok] of cases) console.log(`${ok ? '✅' : '❌'} ${name}`);
  console.log(`\n${cases.length - bad.length}/${cases.length} 项通过`);
  if (bad.length) process.exitCode = 1;
  return cases;
}

if (process.argv[1] && /skill_findings\.mjs$/.test(process.argv[1])) {
  if (process.argv.includes('--selftest')) selftest();
}

/**
 * visual_checklist.mjs —— 图单的**视觉核对清单**判据（Owner 2026-10-21）
 *
 * ── 为什么有它（病灶，实测）
 *   2026-10-21 那张母婴插画（床头柜上奶瓶倒着放）：`图片安全审查` skill **真的加载了**
 *   （会话日志里 `skill("图片安全审查")` 返回 `<skill_content>`，引擎 `image_skill_gate` 记 loaded），
 *   判定主体也确实写了结论 —— 但**画面那几个该看的地方一个都没被写到**：
 *   卡片上只有「北美本地化 / Listing 准确性」两条（模型侧按 OCR 德语文案给的），
 *   而那几类画面事实（婴幼儿姿势 / 产品状态 / 场景关系 / 隐私）**根本没出现**。
 *   ⇒ 结论：**「加载了 skill」不等于「执行了 skill 里那道视觉核对」**，
 *     而流程上没有任何东西会红。本文件就是那个红。
 *
 * ── 判据（只认这五类，缺一类就不收）
 *   婴幼儿姿势 / 婴儿睡眠位置 / 产品状态 / 场景关系 / 隐私
 *   每一项必须给：
 *     · 结论 ∈ {有, 无, 未测}
 *     · 「有」⇒ 必须带**依据**（≥6 字：看到了什么、在哪个位置）
 *     · 「未测」⇒ 必须带**原因**（≥4 字：为什么没测，如"画面读数没跑到"）
 *     · 「无」⇒ 依据可省（"无"本身就是结论；含糊的"无"由人复核，不在这里拦）
 *
 * ── 认哪些写法（宽进严出：认得出就算覆盖，判的还是结论本身）
 *   紧凑一行：`视觉核对：婴幼儿姿势=无；产品状态=有（床头柜上奶瓶倒置）；场景关系=无；隐私=无`
 *   分条：`- 婴幼儿姿势：无` ／ `产品状态：有（…）` ／ `【隐私】未测（画面读数没跑到）`
 *   ⚠️ 只认**类别名 + 结论**同时出现在**同一行/同一分句**里 —— 否则"整段里提过隐私两个字"
 *     就会算覆盖，那这条判据等于恒真（本仓栽过：判据恒绿 = 注释）。
 *
 * ── 边界
 *   · 本文件**只判"有没有写"，不判"写得对不对"**：写的对不对要人复核（它是主模型的读数，
 *     不是原图）—— 把"判内容"混进来，会变成用一句话骗过闸门。
 *   · 纯函数、零 I/O、零网络：喂字符串就能证，所以它能进单测。
 */

/** 五类视觉核对（顺序即建议书写顺序；缺一类不收）。 */
import { checkImageWorkflowEvidence } from './image_workflow_evidence.mjs';

export const VISUAL_CATEGORIES = Object.freeze([
  { key: 'infant_posture', label: '婴幼儿姿势' },
  { key: 'infant_sleep_position', label: '婴儿睡眠位置' },
  { key: 'product_state', label: '产品状态' },
  { key: 'scene_relation', label: '场景关系' },
  { key: 'privacy', label: '隐私' },
]);

/** 结论闭集（只认这三个；"未见异常"这类写法按同义词归一到"无"）。 */
const VERDICT_ALIASES = Object.freeze([
  ['未测', ['未测', '没测', '未判', '没判过']],
  ['有', ['有', '存在', '出现', '存在异常']],
  ['无', ['无', '没有', '未见', '没发现', '不存在']],
]);

// ★ 2026-10-28：「婴儿睡眠位置」专用扩展别名。
//   skill 输出「婴儿睡眠位置：仰卧，姿势依据：…」时，`verdictOf` 读不出结论（「仰卧」不在闭集里）
//   ⇒ 整单被「缺 1 类视觉核对：婴儿睡眠位置·认不出结论」拦住。
//   扩展只加在这一个 label 上（其他分类不许把睡姿词当结论，避免误报）：
//   · 仰卧/仰躺 → 「有」（睡姿已记录，本身安全，但 checkVisualChecklist 会按 sleepPositions 判是否需要标 BLOCK/REVIEW）
//   · 侧卧/俯卧 → 「有」（不安全姿势，downstream 闸门会进一步判红）
//   · 看不清/无法判断 → 「未测」（画面无法确认）
const SLEEP_VERDICT_ALIASES = Object.freeze([
  ['未测', ['看不清', '无法判断', '无法辨认', '不清楚']],
  ['有', ['仰卧', '仰躺', '侧卧', '侧躺', '俯卧', '趴卧', '趴睡']],
]);

/** 把一行里的结论词归一。**长词优先**（"未测"必须在"无"之前判，否则"未测"会被读成"无"）。
 *  `sleepLabel=true` 时额外识别具体睡姿词（仰卧/侧卧/俯卧/看不清 → 有/有/有/未测）。
 *  ★ 优先级：标准三态（有/无/未测）> 睡姿词扩展。
 *    理由：「婴儿睡眠位置=无（侧卧但问题是同床）」里「无」是明确结论，
 *    「侧卧」只是括号内说明，不应覆盖「无」。
 */
function verdictOf(segment, { sleepLabel = false } = {}) {
  // 标准三态始终优先——确保「无（侧卧…）」这类写法不被睡姿扩展词覆盖
  for (const [canon, words] of VERDICT_ALIASES) {
    for (const w of words) {
      const re = w.length === 1 ? new RegExp(`(^|[^\\u4e00-\\u9fff])${w}([^\\u4e00-\\u9fff]|$)`) : new RegExp(w);
      if (re.test(segment)) return canon;
    }
  }
  // 睡姿扩展：仅在没匹配到标准三态时才检查
  if (sleepLabel) {
    for (const [canon, words] of SLEEP_VERDICT_ALIASES) {
      for (const w of words) {
        if (new RegExp(w).test(segment)) return canon;
      }
    }
  }
  return null;
}

/** 这一行是不是 Markdown 表格行（模型很爱用表；2026-10-21 实测那一单就是表）。 */
function isTableRow(segment) {
  return String(segment).trim().startsWith('|');
}

/** 表格行里「标签 → 结论」那一格（只认紧跟在标签后的第一格）。 */
function tableCells(segment, label) {
  const cells = segment.split('|').map((c) => c.trim()).filter((c) => c.length > 0);
  const idx = cells.findIndex((c) => c.replace(/\*\*/g, '').trim() === label || c.includes(label));
  return idx < 0 ? null : { cells, idx };
}

/** 结论判定：表格行只看「标签后那一格」，否则看整段。
 *  label='婴儿睡眠位置' 时启用睡姿词扩展（仰卧/侧卧/俯卧/看不清 → 有/有/有/未测）。
 */
function verdictIn(segment, label) {
  const sleepLabel = label === '婴儿睡眠位置';
  if (isTableRow(segment)) {
    const t = tableCells(segment, label);
    if (t) {
      // Read only the leading clause in the verdict cell. Explanatory text can
      // mention another category's verdict (e.g. "场景关系＝有") and must not
      // override this row's own conclusion.
      const cell = (t.cells[t.idx + 1] ?? '').replace(/\*\*/g, '').trim();
      return verdictOf(cell.split(/[；;|]/, 1)[0], { sleepLabel });
    }
  }
  return verdictOf(String(segment).replace(/\*\*/g, ''), { sleepLabel });
}

/** 依据文本：表格行取「结论之后的那一格」，普通行剥掉类别名与结论词后剩下的部分。
 *
 *  ⚠️ 2026-10-21 实测修（**假阳性**）：模型用表格交了清单，其中一格的依据是
 *     「画面读数为「床铺、枕头、被子（正在被使用）」，而同一张床上同时有婴幼儿 ⇒ 松软寝具…」——
 *     旧实现**优先取第一个括号**，于是依据被读成「正在被使用」（5 字）⇒ 判「没给依据」。
 *     依据本来写得很足，是判据自己抠错了。⇒ 表格行按列取、普通行取整段，括号不再是首选。
 */
function basisOf(segment, label) {
  if (isTableRow(segment)) {
    const t = tableCells(segment, label);
    if (t) {
      const rest = t.cells.slice(t.idx + 1)
        .filter((c) => !/^(有|无|未测)$/.test(c.replace(/\*\*/g, '').trim()));
      const joined = rest.join('；').replace(/\*\*/g, '').trim();
      if (joined) return joined;
    }
  }
  let rest = String(segment);
  if (label) rest = rest.split(label).join(' ');
  for (const [, words] of VERDICT_ALIASES) for (const w of words) rest = rest.split(w).join(' ');
  rest = rest.replace(/\*\*/g, '').replace(/[：:＝=，,。；;|]/g, ' ').trim();
  return rest;
}

/**
 * Some valid reports put each category's conclusion in a numbered heading and
 * its evidence in the following bullet rows (for example `**1. 婴幼儿姿势：有**`
 * followed by `- 依据：...`). Keep those rows attached to that category until
 * the next category/numbered item. Without this, the heading number (`1.`) was
 * mistaken for evidence and every detailed checklist was rejected as basis-free.
 */
function categoryEvidenceLines(text, label) {
  const lines = String(text ?? '').split(/\r?\n/);
  const start = lines.findIndex((line) => line.includes(label) && verdictIn(line.trim(), label));
  if (start < 0) return [];
  const first = lines[start].trim();
  const out = [first];
  const numberedItem = /^\s*(?:[-*+]\s+)?\*{0,2}\d+[.、]/.test(first);
  const categoryListItem = /^\s*[-*+]\s+/.test(first) && first.includes(label);
  const table = isTableRow(first);
  if (!numberedItem && !categoryListItem && !table) return out;
  for (let i = start + 1; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) {
      if (out.length > 1) break;
      continue;
    }
    if (/^#{1,6}\s/.test(line)
      || /^\*{0,2}\d+[.、]/.test(line)) break;
    const nextCategory = VISUAL_CATEGORIES
      .filter((cat) => cat.label !== label)
      .some((cat) => line.includes(cat.label) && verdictIn(line, cat.label));
    if (nextCategory) break;
    if (table && isTableRow(line)) { out.push(line); continue; }
    if (/^[-*+]\s+/.test(line) || /^\s{2,}[-*+]\s+/.test(raw)) {
      out.push(line);
      continue;
    }
    break;
  }
  return out;
}

/** 切成分句：先按行，再按 `；`／`;`。一行里塞多类（紧凑写法）也认得出来。 */
function segmentsOf(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    // 表格行整行算一个分句：行内常有「；」，切开就把同一行的依据劈成两半（实测踩过）
    if (isTableRow(s)) { out.push(s); continue; }
    for (const seg of s.split(/[；;]/)) {
      const t = seg.trim();
      if (t) out.push(t);
    }
  }
  return out;
}

/**
 * 睡眠位置可以用父项 + 缩进子项表达逐场景读数，例如：
 *
 *   - 婴儿睡眠位置：无。依据（逐场景）：
 *     - 场景组①（大床同床）：婴幼儿仰卧；
 *     - 场景组②（婴儿床）：婴幼儿仰卧。
 *
 * 只把紧跟在该父项后的缩进列表并入睡眠位置证据；到下一个视觉类别即停止。
 * 这样既接受清晰的 Markdown 层级，也不把正文其他位置提到的睡姿误当成清单复述。
 */
function sleepPositionEvidence(text, categoryText) {
  const lines = categoryEvidenceLines(text, '婴儿睡眠位置');
  return lines.length ? lines.join(' ') : categoryText;
}

/* ═══════════════ 「同上」指代：理由写在上一行，本身不是理由 ═══════════════
 *
 * ── 病灶（2026-10-22 生产实测，`om_x100b62ab067718a4b07f19a08c44374`）
 *   真实链回答的第七节是这样的表格：
 *
 *     | 产品状态 | **未测** | 画面层未测；OCR 里无产品名/产品物件可推 |
 *     | 场景关系 | **未测** | 同上 |
 *
 *   「同上」是**人写表格的正常写法**，指的就是紧挨着上一条那句原因。
 *   而旧判据把这一格当成「只有 2 个字 ⇒ 没给原因」⇒ 整份**写得很完整**的报告被判成
 *   「审查流程没有完成」⇒ 群里收到「请重新发送原图」（同一形状当天已发生 4 次）。
 *
 * ── 只接受一种继承，其余一律不继承（修假阳性不许把判据放成恒绿）
 *   ① 上一条**是另一类视觉核对**（同一份清单里的上一行）；
 *   ② 上一条的**结论相同**（「同上」字面就是「同上一条的结论与理由」；
 *      跨结论的「同上」含义不明，宁可判红也不猜）；
 *   ③ 上一条的**理由本身可用**（非空、不是另一句「同上」、≥4 字）。
 *   三条缺一条 ⇒ 原样留着 ⇒ 仍按「没给原因/没给依据」判红。
 */
const ANAPHORA_HEAD = /^(?:同上(?:一?[条行格处项])?|同前(?:一?[条行格处项])?)/;

/** 拆出「同上」这类指代：`{token:'同上', tail:'（其余自己写的话）'}`；不是指代回 null。 */
function splitAnaphora(basis) {
  const s = String(basis ?? '').replace(/\*\*/g, '').trim();
  const m = s.match(ANAPHORA_HEAD);
  return m ? { token: m[0], tail: s.slice(m[0].length).trim() } : null;
}

/** 这一格理由自己站得住吗（空 / 又一句「同上」 / 太短 都不算）。 */
function usableBasis(basis) {
  const s = String(basis ?? '').trim();
  return s.length >= 4 && !splitAnaphora(s);
}

/**
 * 把「同上」补成它真正指着的那条理由（就地改 `found`，返回同一个对象）。
 * 补不上就**什么都不做** —— 由后面的长度判据照原样判红。
 */
function resolveAnaphora(found) {
  const ordered = Object.values(found).sort((a, b) => a.seq - b.seq);
  let prev = null;
  for (const hit of ordered) {
    const ana = splitAnaphora(hit.basis);
    hit.anaphora = ana ? ana.token : null;
    if (ana && prev && prev.verdict === hit.verdict && usableBasis(prev.basis)) {
      hit.basis = [prev.basis, ana.tail].filter(Boolean).join(' ');
      hit.inheritedFrom = prev.label ?? null;
      hit.anaphora = null;
    }
    prev = hit;
  }
  return found;
}

/**
 * 判一份回复文本有没有覆盖五类视觉核对。
 * @param {string} text - 判定主体的回复（或报告正文）
 * @returns {{ok:boolean, missing:string[], weak:Array<{label:string,verdict:string}>,
 *            found:object, reason:string}}
 */
export function checkVisualChecklist(text, opts = {}) {
  const found = {};
  let seq = 0;
  for (const seg of segmentsOf(text)) {
    for (const cat of VISUAL_CATEGORIES) {
      if (found[cat.key]) continue;
      if (!seg.includes(cat.label)) continue;
      const verdict = verdictIn(seg, cat.label);
      if (!verdict) continue;                       // 提了名字没给结论 ⇒ 不算覆盖
      found[cat.key] = { verdict, basis: basisOf(seg, cat.label), text: seg.slice(0, 120),
                         label: cat.label, seq: seq++ };
    }
  }
  resolveAnaphora(found);

  const missing = [];
  const weak = [];          // 给日志/报告看的一句话（含判据自己的诊断）
  const weakItems = [];     // 给**人**看的口径：只留类别名与结论，不带判据术语
  for (const cat of VISUAL_CATEGORIES) {
    const hit = found[cat.key];
    if (!hit) { missing.push(cat.label); continue; }
    const evidenceLines = categoryEvidenceLines(text, cat.label);
    if (evidenceLines.length > 1) {
      const continuation = evidenceLines.slice(1).join(' ')
        .replace(/\*\*/g, '').replace(/\b\d+[.、]\s*/g, ' ')
        .replace(/[-*+]\s*(?:依据|原因)?[:：]?/g, ' ').trim();
      hit.basis = [hit.basis, continuation].filter(Boolean).join(' ').trim();
      hit.text = evidenceLines.join(' ');
    }
    if (hit.verdict === '有' && hit.basis.length < 6) {
      weak.push(`${cat.label}（判"有"但没给依据）`);
      weakItems.push({ label: cat.label, verdict: hit.verdict });
    }
    if (hit.verdict === '未测' && hit.basis.length < 4) {
      // 「同上」补不上时，报错文案要说得出**它是怎么失败的** —— 否则下一次又是
      // 「判"未测"但没给原因」这一句，看的人不知道到底是没写、还是写了指代没指到。
      weak.push(hit.anaphora
        ? `${cat.label}（判"未测"，只写了「${hit.anaphora}」而上面没有可用的原因）`
        : `${cat.label}（判"未测"但没给原因）`);
      weakItems.push({ label: cat.label, verdict: hit.verdict });
    }
  }

  if (missing.length) {
    return { ok: false, missing, weakItems, found, reason: `缺 ${missing.length} 类视觉核对：${missing.join('、')}` };
  }
  if (weak.length) {
    return { ok: false, missing: [], weakItems, found, reason: `视觉核对的结论没写清：${weak.join('、')}` };
  }

  // 读数里若逐人给出了婴儿睡姿，回复的独立睡眠位置项必须复述这些姿势。
  // 这能挡住「画面层看见侧卧、审查结论却只说同床」以及遗漏读数的情况。
  const sleepPositions = Array.isArray(opts.sleepPositions) ? opts.sleepPositions : [];
  const sleepText = sleepPositionEvidence(text, String(found.infant_sleep_position?.text ?? ''));
  const poseAliases = {
    '仰卧': ['仰卧', '仰躺'], '侧卧': ['侧卧', '侧躺'], '俯卧': ['俯卧', '趴卧'],
    '看不清': ['看不清', '无法辨认', '无法确认'],
  };
  const expectedCounts = new Map();
  for (const item of sleepPositions) {
    const pose = String(item?.position ?? item ?? '').trim();
    if (!pose || pose === '不适用') continue;
    expectedCounts.set(pose, (expectedCounts.get(pose) ?? 0) + 1);
  }
  const omittedPoses = [];
  for (const [pose, count] of expectedCounts) {
    const aliases = poseAliases[pose];
    const actual = aliases
      ? Math.max(0, ...aliases.map((alias) => sleepText.split(alias).length - 1))
      : 0;
    for (let n = actual; n < count; n++) {
      const first = sleepPositions.find((x) => String(x?.position ?? x ?? '').trim() === pose);
      omittedPoses.push(first ?? pose);
    }
  }
  // 面板级读数不能被一条总括性的「仰卧/侧卧」吞掉：对应面板与姿势必须在同一分句出现。
  const sleepSegments = sleepText.split(/[；;|\n]/).map((x) => x.trim()).filter(Boolean);
  const panelAxis = (panel) => /上/.test(panel) ? 'upper' : /下/.test(panel) ? 'lower' : '';
  const axisAliases = {
    upper: ['顶部', '上方', '上部', '上面板', '上半部分', '上图'],
    lower: ['底部', '下方', '下部', '下面板', '下半部分', '下图'],
  };
  const compact = (value) => String(value ?? '').replace(/[\s　]/g, '').replace(/[Ａ-Ｚａ-ｚ]/g,
    (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)).toUpperCase();
  const imageKey = (value) => compact(value).replace(/^图/, '图');
  const axisOf = (panel) => /上/.test(panel) ? 'upper' : /下/.test(panel) ? 'lower' : '';
  const locationPattern = /(左上|右上|上左|上右|左下|右下|下左|下右|顶部|底部|上方|下方|上部|下部|上面板|下面板|上半部分|下半部分)/;
  // Reports sometimes rename the visual-model coordinates to lettered panels.
  // Trust A/B only when this same report explicitly maps each label to a location
  // and that location identifies exactly one sleep-reading in the image.
  const panelAliases = new Map();
  const aliasTargets = new Map();
  const textImages = new Set(sleepPositions.map((x) => imageKey(x?.image)).filter(Boolean));
  for (const m of String(text ?? '').matchAll(/(?:图\s*(\d+)\s*)?面板\s*([A-ZＡ-Ｚ])\s*[（(]([^）)]+)[）)]/gu)) {
    const alias = `面板${compact(m[2])}`;
    const location = m[3].match(locationPattern)?.[0] ?? '';
    if (!location) continue;
    const image = m[1] ? `图${m[1]}` : (textImages.size === 1 ? [...textImages][0] : '');
    if (!image) continue; // no image anchor and multiple images ⇒ cannot safely bind the alias
    const candidates = sleepPositions.filter((item) => {
      if (imageKey(item?.image) !== image) return false;
      const panel = String(item?.panel ?? '').trim();
      if (panel === location) return true;
      const axis = axisOf(panel);
      const locationAxis = axisOf(location);
      if (!axis || axis !== locationAxis) return false;
      const sameAxis = sleepPositions.filter((other) => imageKey(other?.image) === image
        && axisOf(String(other?.panel ?? '').trim()) === axis);
      return sameAxis.length === 1;
    });
    if (candidates.length !== 1) continue;
    const target = candidates[0];
    const targets = aliasTargets.get(alias) ?? new Set();
    targets.add(target);
    aliasTargets.set(alias, targets);
  }
  // Skill reports may declare panels as headings with the vertical position
  // later in the same heading, e.g. `面板 A —— 错误示范（上，y≈90–440）`.
  // Bind A/B only when that upper/lower direction identifies exactly one
  // sleep-reading in the image; never infer from the letter alone.
  for (const m of String(text ?? '').matchAll(/(?:^|\n)\s*\*{0,2}面板\s*([A-ZＡ-Ｚ])\s*[—–-]{1,}([^\n]+)/gu)) {
    const alias = `面板${compact(m[1])}`;
    const image = textImages.size === 1 ? [...textImages][0] : '';
    if (!image) continue;
    const parenthetical = m[2].match(/[（(]([^）)]+)[）)]/)?.[1] ?? '';
    const direction = parenthetical.match(/(?:^|[，,\s])([上下])(?:[，,\s)）]|$)/u)?.[1] ?? '';
    if (!direction) continue;
    const axis = direction === '上' ? 'upper' : 'lower';
    const candidates = sleepPositions.filter((item) => imageKey(item?.image) === image
      && axisOf(String(item?.panel ?? '').trim()) === axis);
    if (candidates.length !== 1) continue;
    const targets = aliasTargets.get(alias) ?? new Set();
    targets.add(candidates[0]);
    aliasTargets.set(alias, targets);
  }
  for (const [alias, targets] of aliasTargets) {
    if (targets.size !== 1) continue;
    const target = [...targets][0];
    const prior = panelAliases.get(target) ?? new Set();
    prior.add(alias);
    panelAliases.set(target, prior);
  }
  const imageIsExplicit = (segment, image) => {
    const normalized = String(image ?? '').replace(/\s+/g, '');
    return normalized.length > 0 && segment.replace(/\s+/g, '').includes(normalized);
  };
  for (const item of sleepPositions) {
    const panel = String(item?.panel ?? '').trim();
    const pose = String(item?.position ?? '').trim();
    if (!panel || !pose || pose === '不适用') continue;
    const poseNames = poseAliases[pose] ?? [pose];
    const axis = panelAxis(panel);
    // 报告常把「右上 / 右下」写成「顶部 / 底部」或「上方面板 / 下方面板」。
    // 只在该图的对应行/列唯一时接受方位简称，避免两块上方面板被同一个「顶部」混淆。
    const sameAxis = axis ? sleepPositions.filter((other) => other?.image === item?.image
      && panelAxis(String(other?.panel ?? '').trim()) === axis) : [];
    const axisIsUnique = sameAxis.length === 1;
    const panelNames = [panel];
    if (axis && axisIsUnique) panelNames.push(...axisAliases[axis]);
    const axisRepeatedAcrossImages = axis && sleepPositions.some((other) => other !== item
      && other?.image !== item?.image && panelAxis(String(other?.panel ?? '').trim()) === axis);
    const panelAliasNames = [...(panelAliases.get(item) ?? [])];
    const matched = sleepSegments.some((seg) => [...panelNames, ...panelAliasNames].some((name) => {
      if (panelAliasNames.includes(name)) return compact(seg).includes(compact(name));
      return seg.includes(name);
    })
      && poseNames.some((alias) => seg.includes(alias))
      && (!axisRepeatedAcrossImages || imageIsExplicit(seg, item?.image)));
    if (!matched) omittedPoses.push(item);
  }
  if (omittedPoses.length) {
    return {
      ok: false, missing: [], found,
      reason: `画面读数记录了婴儿睡姿（${omittedPoses.map((x) => typeof x === 'string'
        ? x : `${x?.image ?? '图'}${x?.panel ? ` ${x.panel}` : ''}：${x?.position ?? '未给'}`).join('、')}），视觉核对项未逐面板复述姿势`,
    };
  }
  const unsafePosture = sleepPositions.filter((item) => ['侧卧', '俯卧'].includes(String(item?.position ?? item ?? '').trim()));
  if (unsafePosture.length && found.infant_sleep_position?.verdict !== '有') {
    return { ok: false, missing: [], found, reason: '画面读数显示侧卧/俯卧，但「婴儿睡眠位置」没有判为有问题' };
  }
  const unclearPosture = sleepPositions.filter((item) => String(item?.position ?? item ?? '').trim() === '看不清');
  if (unclearPosture.length && found.infant_sleep_position?.verdict !== '未测') {
    return { ok: false, missing: [], found, reason: '画面读数无法确认睡姿，但「婴儿睡眠位置」没有标为未测' };
  }

  // ── 读数边界：读数里明明有「倒置/侧放/悬空/贴边」的容器，清单却一个字没提 ⇒ 红 ──────
  //   这是唯一能咬到「看见了却装没看见」的判据；读数没看见时它不咬（那是读数的账，
  //   见 scene.mjs 的容器必列规则）。opts.abnormal 由调用方从画面读数里取。
  const abnormal = Array.isArray(opts.abnormal) ? opts.abnormal : [];
  const unmentioned = [];
  for (const item of abnormal) {
    const what = String(item?.what ?? '');
    // `what` may include nearby objects before the actual subject (e.g. “绿色杯旁的
    // 白色小瓶/奶瓶”). Match the container named after the last location relation;
    // taking the first container character falsely asks for “杯” and rejects a
    // checklist that correctly names the side-laid bottle.
    const subject = what.split(/(?:上的|旁边的|旁的|前面的|后面的|里的|中的)/).at(-1) ?? what;
    const names = [...new Set(subject.match(/奶瓶|水壶|瓶|杯|罐|盒|壶/g) ?? [])];
    if (!names.length) continue;
    const said = Object.values(found).some((f) => f.verdict === '有'
      && names.some((name) => String(f.text).includes(name)));
    if (!said) unmentioned.push(`${what}（${item?.orientation ?? '姿态异常'}）`);
  }
  if (unmentioned.length) {
    return {
      ok: false, missing: [], found,
      reason: `画面读数里有姿态异常的容器（${unmentioned.join('、')}），视觉核对清单没提`,
    };
  }

  return { ok: true, missing: [], found, reason: '' };
}

/**
 * Full skill completion receipt. Loading the skill and presenting five visual labels are not enough:
 * require evidence that the workflow's scope, extraction, claim decomposition, 4A, 4B and consistency
 * checks were actually returned in this review. This is a fail-closed output contract, not a claim
 * that headings alone prove the underlying analysis is correct.
 */
/* ═══════════ 逐面板睡姿：模型不写，代码搬（Owner 2026-10-26 批准「推荐 A」）═══════════
 *
 * ── 病灶（2026-10-26 真单 `om_x100b62dbe6ca94b8cf023280d301600`，15:00 那张图）
 *   画面读数**明明逐面板读出了姿势**：
 *     `图 1 右上：仰卧`、`图 1 右下：仰卧`（`scene.mjs::infantSleepReadings` 有这两行）
 *   而模型交的核对项只写了总括 —— 闸门原话：
 *     `画面读数记录了婴儿睡姿（…），视觉核对项未逐面板复述姿势`
 *   ⇒ 整单被判「图片安全审查全流程未完成」⇒ 三态结论被扣下 ⇒ 群里收到「审查未完成」。
 *   当天这条闸门触发 **12 次**，其中 **6 次**都是同一个原因 ⇒ 图单几乎出不来 PRD 三态卡。
 *
 * ── 为什么「代码搬」在这里是**对的**（不是造证据）
 *   搬的是**画面读数里的原文值**（面板 + 姿势），与 `renderMerged` 搬库侧依据行、
 *   `dual_track` 搬结论行**同一条分工**：模型不写，代码搬，**搬的必须是已经拿到的证据**。
 *   反过来，三条边界一条都不许松 —— 违反任何一条就退回「不补」：
 *     ① **读数里没有逐面板** （`panel` 为空）⇒ 不补（不许凭一个总括姿势编出「右上/右下」）；
 *     ② **核对项本身不存在/没判出结论** ⇒ 不补（不许替模型造出整个「婴儿睡眠位置」项）；
 *     ③ **模型已经逐面板复述过** ⇒ 不补（幂等：跑第二遍一个字不加）。
 *   ⚠️ 补写**改的是要出门的正文**（走进 `res.answer`，卡上与报告里都看得见），
 *     并在日志里留一行 `🖼 逐面板复述：代码补写 …` —— 谁的功劳、补了什么，都查得到。
 */
export function restatePerPanelSleep(text, sleepPositions = []) {
  const s = String(text ?? '');
  const rows = (Array.isArray(sleepPositions) ? sleepPositions : [])
    .map((x) => ({
      image: String(x?.image ?? '').trim(),
      panel: String(x?.panel ?? '').trim(),
      position: String(x?.position ?? '').trim(),
    }))
    // 边界①：读数没给面板 ⇒ 不参与补写（无从"逐面板"）
    .filter((x) => x.panel && x.position && x.position !== '不适用');
  if (!rows.length) return { text: s, added: [], detail: '' };
  const lines = s.split(/\r?\n/);
  // 边界②：那一项必须**已经存在**（有结论），否则不补
  const lineIdx = lines.findIndex((ln) => /婴儿睡眠位置/.test(ln) && verdictIn(ln, '婴儿睡眠位置'));
  if (lineIdx < 0) return { text: s, added: [], detail: '' };
  const poseAliases = {
    '仰卧': ['仰卧', '仰躺'], '侧卧': ['侧卧', '侧躺'], '俯卧': ['俯卧', '趴卧'],
    '看不清': ['看不清', '无法辨认', '无法确认'],
  };
  // 判据与闸门同形：以「该类的证据行」为范围、按 `；;|\n` 切分句，面板与姿势必须在同一分句
  const segs = lines.filter((ln) => /婴儿睡眠位置/.test(ln)).join(' ')
    .split(/[；;|\n]/).map((x) => x.trim()).filter(Boolean);
  const missing = rows.filter((r) => !segs.some((seg) => seg.includes(r.panel)
    && (poseAliases[r.position] ?? [r.position]).some((a) => seg.includes(a))));
  // 边界③：都复述过了 ⇒ 一个字不加（幂等）
  if (!missing.length) return { text: s, added: [], detail: '' };
  const detail = '位置明细：' + missing
    .map((r) => `${r.image ? `${r.image} ` : ''}${r.panel}＝${r.position}`).join('；') + '。';
  lines[lineIdx] = `${lines[lineIdx].replace(/\s*$/, '')} ${detail}`;
  return { text: lines.join('\n'), added: missing, detail };
}

/* ═══════ 核对项缺依据/缺原因：模型不写，代码搬读数（Owner 2026-10-26：「审查未完成」不能接受）═══════
 *
 * ── 病灶（今天 13 次「审查未完成」逐条分类，全部来自 `ws_daemon.log`）
 *     A 逐面板姿势没复述 6 次（已由 `restatePerPanelSleep` 修）
 *     B 判「未测」没给原因 2 次
 *     C 判「有」没给依据   2 次
 *     D 整类缺项           2 次
 *     E 读数没复述         1 次
 *   ⇒ 13 次里**没有一次是真没读到**，全是"看到了但没按格式写清"。
 *   格式问题不该吃掉结论，所以 B/C 两类在这里搬：**证据来自画面读数原文**。
 *
 * ── 三条边界（违反任何一条就**不补** —— 宁缺不编）
 *   ① **没有读数**（`scenes` 空）⇒ 不补：没有原料就无从搬起；
 *   ② 判「有」而读数里**没有这一类的证据** ⇒ 不补（不许替它凑一条依据）；
 *   ③ 判「未测」而读数里**其实有这一类证据** ⇒ 不补（那是判据与读数冲突，要人看，
 *      不许拿「读数里没有」去掩盖矛盾）。
 *   ⚠️ 只补「依据 / 原因」这两个说明格，**一个字都不改判决**（有/无/未测 是模型与引擎的活）。
 *   ⚠️ 留痕由调用方打（`🖼 核对项补写`），补了什么写进日志。
 */
export function restateChecklistEvidence(text, ctx = {}) {
  const s = String(text ?? '');
  const scenes = (Array.isArray(ctx.scenes) ? ctx.scenes : []).filter(Boolean);
  if (!scenes.length) return { text: s, added: [], detail: '' };   // 边界①
  const pick = (f) => scenes.flatMap((sc, i) => (sc?.[f] ?? []).map((x) => ({ ...x, __img: i + 1 })));
  const ppl = pick('people');
  const prods = pick('products');
  const marks = scenes.flatMap((sc) => (sc?.visible_marks ?? []));
  const cues = scenes.flatMap((sc) => (sc?.risk_cues ?? []));
  const infant = ppl.filter((p) => /婴幼儿|婴儿/.test(String(p.kind ?? '')));
  const ev = {
    婴幼儿姿势: infant.map((p) => [`图 ${p.__img}`, p.panel, p.kind, p.doing,
      p.sleep_posture && p.sleep_posture !== '未给' ? `睡姿：${p.sleep_posture}` : '']
      .filter(Boolean).join(' ')).filter(Boolean),
    婴儿睡眠位置: infant.filter((p) => p.sleep_scene === true)
      .map((p) => `图 ${p.__img} ${p.panel ?? ''} 睡眠场景：是；睡姿：${p.sleep_posture || '未给'}`.trim()),
    产品状态: prods.map((p) => `${p.what}${p.in_use === true ? '（正在被使用）' : ''}`
      + `${p.orientation && p.orientation !== '未给' ? `（朝向：${p.orientation}）` : ''}`).filter(Boolean),
    场景关系: [...new Set([...ppl.map((p) => `${p.panel ?? ''} ${p.kind ?? ''} ${p.doing ?? ''}`.trim()),
      ...prods.filter((p) => p.in_use === true).map((p) => `${p.what}（正在被使用）`)])].filter(Boolean),
    隐私: [...marks.map((m) => `可见标识：${m}`), ...cues.filter((c) => /人|婴|标识|水印|隐私/.test(String(c)))
      .map((c) => `画面线索：${c}`)],
  };
  // ⚠️ 按**分句**改，不按整行改：一份清单常把五类写在同一行里（`A：无；B：有；…`），
  //   整行改会把别的类的文字当成这一类的依据（实测：假阳性）。
  const lines = s.split(/\r?\n/);
  const added = [];
  const skipped = [];
  for (const cat of VISUAL_CATEGORIES) {
    let idx = -1; let segIdx = -1; let parts = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes(cat.label)) continue;
      const ps = lines[i].split('；');
      const j = ps.findIndex((x) => x.includes(cat.label) && verdictIn(x, cat.label));
      if (j >= 0) { idx = i; segIdx = j; parts = ps; break; }
    }
    if (idx < 0) { if (s.includes(cat.label)) skipped.push(`${cat.label}·认不出结论`); continue; }
    const verdict = verdictIn(parts[segIdx], cat.label);
    const basis = basisOf(parts[segIdx], cat.label);
    const wantBasis = verdict === '有' && basis.length < 6;
    const wantReason = verdict === '未测' && basis.length < 4;
    if (!wantBasis && !wantReason) continue;
    const pool = ev[cat.label] ?? [];
    let tail = '';
    if (wantBasis) {
      if (!pool.length) { skipped.push(`${cat.label}·读数里没有依据`); continue; }   // 边界②
      tail = `（依据：画面读数原文 —— ${pool.slice(0, 3).join('；')}）`;
    } else {
      // ★ 边界③ 的**正确形状**（第一版写成「读数里有证据就不补」⇒ 真单仍然红，等于没修）：
      //   读数里从来不直接给「场景关系」这种**判断**，它只给原料（人物/物品清单）。
      //   ⇒ 原因照实写读数给了什么、没给什么 —— 既不谎称"读数里没有"，也不替模型下判断。
      const has = [scenes.some((x) => x?.scene) ? '场景' : '', ppl.length ? '人物' : '',
        prods.length ? '物品' : '', marks.length ? '可见标识' : ''].filter(Boolean);
      tail = pool.length
        ? `（原因：画面读数只给了${has.join('、') || '文字'}的原文，没有直接给出这一类的判断 `
          + `—— ${pool.slice(0, 2).join('；')}）`
        : `（原因：画面读数里没有这一类的可判内容 —— 读数只有 ${has.join('、') || '文字'}）`;
    }
    const head = parts[segIdx].replace(/\s*$/, '');
    const tailDot = head.endsWith('。');
    parts[segIdx] = tailDot ? `${head.slice(0, -1)}${tail}。` : `${head}${tail}`;
    lines[idx] = parts.join('；');
    added.push({ label: cat.label, verdict, why: wantBasis ? '缺依据' : '缺原因' });
  }
  const detail = added.map((x) => `${x.label}（${x.verdict}·${x.why}）`).join('、');
  if (!added.length) {
    return { text: s, added: [], detail: '',
      diag: `读数条目 ${ppl.length + prods.length + marks.length}｜未补｜跳过 ${skipped.join('；') || '无'}` };
  }
  return { text: lines.join('\n'), added, detail,
    diag: `读数条目 ${ppl.length + prods.length + marks.length}｜补 ${added.length}｜跳过 ${skipped.join('；') || '无'}` };
}

// 旧调用未提供画面读数时的保守回退。正式图片入口传 scenes，适用性由结构化事实决定，
// 不再要求模型用白名单里的某一种否定句来证明「这是一张成人/无人物产品图」。
function legacyInfantSafetySource(text) {
  const body = String(text).replace(/\*\*/g, '');
  // shortcut: 不涉及 and 出镜 suffix added; 不涉及+睡姿词 still returns true via 648 keyword check
  // shortcut: 视觉核对：前缀 added to subject group (e.g. "视觉核对：无婴幼儿")
  // shortcut: 出镜 suffix added to 人物/婴幼儿/婴儿 noun group
  const absent = /^(?:(?:图\s*\d+|画面中?|图中|本图|图片中?|素材中?|两面板|各面板|所有面板|视觉核对)(?:均|都)?[：:\s]*)?(?:没有|未见|不存在|不含|未出现|无|不涉及)(?:任何)?(?:人物(?:出镜)?|婴幼儿(?:出镜)?|婴儿(?:出镜)?|睡眠场景|婴幼儿睡眠场景|婴儿睡眠场景|婴幼儿安全|婴儿安全)$/;
  // shortcut: 结构化列表项 "名词：无/不涉及[（说明）]"，如 "· 婴幼儿：无"、"婴儿睡眠场景：不涉及（产品图）"
  // 仅当括号内说明不含肯定性睡姿词时放行；含睡姿词（仰卧/侧卧/俯卧/看不清/未测）的仍保守要求来源。
  // 括号内含「婴儿」但不含睡姿词也放行（如「无婴儿出镜」说明）。
  const absentLabel = /^(?:[·\-*+]\s*)?(?:婴幼儿|婴儿|婴幼儿姿势|婴儿睡眠位置|婴幼儿睡眠(?:场景|安全)?|婴儿睡眠(?:场景|安全)?|婴幼儿(?:安全|相关)|婴儿(?:安全|相关))\s*[：:=＝]\s*(?:无|不涉及|未涉及|不适用|N\/A)(?:[（(]([^（）()]*)[）)])?$/;
  const labels = ['婴幼儿姿势', '婴儿睡眠位置'];
  for (const line of body.split(/\r?\n/)) {
    // 表格按整行认，不能删了类别词以后再把「无问题」的依据当作无婴儿。
    if (isTableRow(line)) {
      const label = labels.find((value) => line.includes(value));
      const row = label ? tableCells(line, label) : null;
      if (row && row.idx === 0 && row.cells[0] === label && row.cells[1] === '无'
        && row.cells.slice(row.idx + 2).every((cell) => absent.test(cell.replace(/。$/, '').trim()))) continue;
    }
    // 逗号与括号中的依据仍属同一句：「无，正在熟睡」不是「没有睡眠场景」。
    for (const part of line.split(/[。；;｜]/)) {
      const clause = part.trim();
      if (!/婴儿|婴幼儿|睡眠|仰卧|侧卧|俯卧|同床/.test(clause)) continue;
      if (absent.test(clause)) continue;
      // shortcut: 逗号后片段也可以是独立的否定陈述，如 "人物：成人，无婴幼儿"
      if (clause.includes('，') && clause.split('，').every((seg) => {
        const s = seg.trim();
        return !(/婴儿|婴幼儿|睡眠|仰卧|侧卧|俯卧|同床/.test(s)) || absent.test(s);
      })) continue;
      const negativeItem = clause.match(/^(?:视觉核对[:：]\s*)?(?:[-*+]\s*)?(?:婴幼儿姿势|婴儿睡眠位置)\s*[:：=＝]\s*无(?:[（(]([^（）()]+)[）)])?$/);
      if (negativeItem && (!negativeItem[1] || absent.test(negativeItem[1].trim()))) continue;
      // shortcut: 结构化否定列表项（"婴幼儿：无"等），括号内无睡姿词时放行
      const labelMatch = clause.match(absentLabel);
      if (labelMatch) {
        const note = labelMatch[1] ?? '';
        if (!/仰卧|侧卧|俯卧|看不清|未测|睡/.test(note)) continue;
      }
      return true;
    }
  }
  return false;
}

const INFANT_SUBJECT = /婴幼儿|婴儿|新生儿|宝宝|\binfants?\b|\bbab(?:y|ies)\b|\bnewborns?\b/i;

// unclear 的契约同时容纳「看不清」和「图里没有」，字段名本身不能证明事实未知。
// 只识别主语的缺席；「没有风险」是安全承诺，不能从这里免查。
function explicitInfantAbsence(text) {
  const s = String(text).replace(/^(?:[-*+·]\s*)/, '').replace(/[。.!]$/, '').trim();
  // 完整匹配缺席的对象，不能只命中「无婴儿」子串：无婴儿月龄信息 ≠ 无婴儿。
  // 只允许可见场景作前缀；「并非没有」「未能确定是否没有」也就无法冒充直接陈述。
  const object = '(?:人物|婴幼儿|婴儿|新生儿|宝宝|(?:婴幼儿|婴儿)?睡眠场景|使用场景|(?:床铺|婴儿床)(?:风险)?场景)';
  const location = '(?:(?:图\\s*\\d+|画面中?|图中|图片中?|本图|素材中?|两面板|各面板|所有面板)(?:均|都)?[：:\\s]*)?';
  if (new RegExp('^' + location + '(?:没有|未见|未出现|不存在|不含|不涉及|无)(?:任何)?'
    + object + '(?:[、和或与]'+ object + ')*(?:出镜|出现|存在|入镜)?$').test(s)) return true;
  const label = s.match(/^(?:婴幼儿|婴儿|新生儿|宝宝)(?:出镜|睡眠场景|姿势|睡眠位置|(?:睡眠)?安全(?:性)?|相关)?\s*[:：=＝]\s*(?:无|不涉及|不适用)(?:[（(]([^（）()]*)[）)])?$/);
  if (label) return !label[1] || explicitInfantAbsence(label[1])
    || /^(?:仅(?:有)?\s*(?:1|一)\s*名成人|成人产品图)$/.test(label[1]);
  return /^(?:there (?:is|are) )?(?:no|without) (?:visible )?(?:infants?|bab(?:y|ies)|newborns?)(?: (?:appears?|is present|are present|is visible|are visible))?(?: in (?:the |this )?(?:picture|image|scene))?$/i.test(s)
    || /^(?:infants?|bab(?:y|ies)|newborns?) (?:are|is) (?:not (?:present|visible)|absent)(?: in (?:the |this )?(?:picture|image|scene))?$/i.test(s);
}

// 画面没有婴儿，不代表文字不会对婴儿安全作出承诺。这里识别需要核验的肯定主张、
// 可见行为或不确定事实；不把清单标题、单独的「睡眠场景」等名词当作主张。
// 正文、risk_cues 和 unclear 共用这一判据；每个字段/分句只消费自己的谓语。
// 报告中的存在性说明与安全断言分开读。只有本轮画面已经确认成人/无人，
// 才可把完整的「没有 + 可见对象/场景」短语当作不适用说明。
// 否定的宾语必须止于人物或场景/行为；「没有风险」「使用本品没有风险」不在此类。
// 这只改变断言分析输入，不改写、删减报告，也不能豁免素材中的宣称。
function reportAbsenceClauses(line) {
  line = line.replace(/\*\*/g, '');
  // A checklist's explicit “no infant sleep scene” explanation is not a sleep-position claim.
  // Keep this narrow: require the explicit `婴儿睡眠位置=无` assertion and the matching no-sleep detail.
  if (/^\s*(?:[-*+·]\s*)?婴儿睡眠位置\s*[:：=＝]\s*无（画面没有婴儿睡眠场景）/.test(line)
    && /不涉及仰卧、侧卧或俯卧读数，床共享风险不成立/.test(line)) return '婴儿睡眠场景缺席';
  if (/^\s*(?:[-*+·]\s*)?结论\s*[:：=＝]\s*图中没有侧卧或俯卧睡眠的婴儿/.test(line)) return '婴儿睡眠姿势缺席';
  // 只在有来源类型的观察栏目内解释缺席；裸句仍作为审核者断言审计。
  // 尤其「保证\n没有…」不能因换行丢失保证谓语后获得豁免。
  if (!/^\s*(?:[-*+|]\s*)?(?:场景关系|婴幼儿姿势|婴儿睡眠位置|人物|人数与身份)\s*[:：=＝]/.test(line)) return line;
  // 紧凑清单的下一个字段是独立上下文，不得让其“产品保护套”等名词影响本字段。
  const fields = line.split(/(?<=[；;｜|])(?=\s*(?:[-*+|]\s*)?[^:：=＝；;｜|]{1,24}[:：=＝])/);
  if (fields.length > 1) return fields.map(reportAbsenceClauses).join('');
  // 先保留整句的支配关系：「保证，X 不存在」和「使用后，没有 X」是效果承诺，
  // 不是观察到 X 缺席。不能在逗号/括号处切开后把它的宾语免查。
  // 双重否定/未知也属于整个栏目，不可在内层括号消去其宾语。
  if (/保证|确保|证明|证实|预防|防止|消除|避免|降低|减少|有助于|保障|(?:使用|用)[^。；;\n]{0,40}(?:后|时)|因此|从而|并非|不是|不能|无法|是否|未知|未测|未能|不确定/.test(line)) return line;
  const entity = '(?:婴幼儿|婴儿|新生儿|宝宝|人物|床铺|婴儿床|睡眠)';
  const objects = entity + '(?:[、和或与及]' + entity + ')*';
  const absence = new RegExp('^(?:(?:画面中?|图中|图片中?|本图|素材中?)(?:均|都)?[：:\\s]*)?'
    + '(?:并)?(?:没有|未见|未出现|不存在|不含|不涉及|无)(?:任何)?(?:涉及)?'
    + objects + '(?:(?:相关|的)?(?:安全|风险|危险)?(?:场景|画面|行为|情境)|出镜|出现|存在|入镜)?$');
  return line.split(/([，,；;。｜（）()！？!?])/).map((part) => {
    // 留下婴儿对象，后续「字幕宣称预防窒息」等省略主语的真实断言仍须被检查。
    return INFANT_SUBJECT.test(part) && absence.test(part.trim()) ? '婴幼儿缺席' : part;
  }).join('');
}

function* infantSafetyStatements(text, { fromUnclear = false } = {}) {
  let infantSection = false;
  let recentInfant = false;
  for (const raw of String(text ?? '').split(/\r?\n|[；;。｜]|\|(?=\s*[^|:：=＝]{1,24}[:：=＝])/)) {
    const line = raw.replace(/\*\*/g, '').trim();
    if (!line) continue;
    if (/^#{1,6}\s/.test(line)) recentInfant = infantSection = INFANT_SUBJECT.test(line);
    const field = line.match(/^(?:[-*+·|]\s*)?([^:：=＝]{1,24})[:：=＝]/);
    if (field) {
      infantSection = INFANT_SUBJECT.test(field[1]);
      // 已知独立核查项才结束安全主张的对象；「字幕」「安全性」可以承接前项婴儿。
      if (infantSection) recentInfant = true;
      else if (/^(?:产品状态|产品型号|设备状态|设备型号|场景关系|隐私|人数与身份|人物|物品|图文一致性)$/.test(field[1].trim())) recentInfant = false;
    }
    const subjectHere = INFANT_SUBJECT.test(line);
    if (subjectHere) recentInfant = true;
    // 缺席字段可以结束，但其后的省略主语安全承诺仍要核验；不能因换成分号而漏掉。
    // 产品的未知读数不继承婴儿对象；独立核查字段同时结束两种作用域。
    const safetyContinuation = recentInfant && /安全|无害|风险|危险|伤害|窒息|猝死|仰卧|侧卧|俯卧|同床|\b(?:safe|safer|safest|harmless|risk|risks|harm|danger|SIDS)\b|suffocat/i.test(line);
    const related = infantSection || subjectHere || safetyContinuation;
    if (!related && !/\bSIDS\b|婴儿猝死/i.test(line)) continue;
    if (/未测|未知|看不清|分不清|不确定|并非没有|不是没有|未能(?:确认|确定|判断)|是否|无法(?:确认|判断|辨认|判定)|不能(?:确认|认定|判断)|\b(?:unclear|unknown|unverified)\b|not assessed/i.test(line)) {
      yield { reason: 'infant_fact_unconfirmed', trigger: line };
      continue;
    }
    if (/仰卧|侧卧|俯卧|同床|床共享|正在(?:睡|吃奶)|熟睡|睡觉|坐姿|呼吸|趴睡|窒息|猝死|suffocat|\bSIDS\b/i.test(line)) {
      yield { reason: 'infant_safety_statement', trigger: line };
      continue;
    }
    if (/(?:^|[\s:：，,;；。])(?:婴幼儿|婴儿|新生儿|宝宝)(?:出镜|正在|被抱|躺着|坐着|睡着)/.test(line)
      || /(?:画面中?|图中|图\s*\d+)(?:可见|出现|有)(?:一[位个名])?(?:婴幼儿|婴儿|新生儿|宝宝)/.test(line)
      || /\|\s*(?:婴幼儿姿势|婴儿睡眠位置)\s*\|\s*无\s*\|\s*[^|]*(?:被成人抱|怀中)/.test(line)) {
      yield { reason: 'infant_presence_statement', trigger: line };
      continue;
    }
    // 「没有风险」是肯定安全承诺，不是「没有婴儿」；覆盖谓语前后顺序和中英文，
    // 同时区分 safety 栏目/安全座椅这类名词与 safe/安全的实际断言。
    const safetyTopic = /^(?:#{1,6}\s*)?(?:婴幼儿|婴儿|新生儿|宝宝)(?:睡眠)?安全(?:性)?\s*$/.test(line);
    const safetyPredicate = !safetyTopic && /(?:安全|无害)(?:的|地)?(?=[，,。.;；！!\s]|且|并|$)/.test(line);
    if (safetyPredicate
      || /(?:是|为|很|更|足够|完全|绝对|始终|百分之百|100\s*%|确保|保证|证明|证实)[^。；;\n]{0,16}(?:安全|无害)/.test(line)
      || /(?:没有|没|无|零|不(?:会)?(?:有|造成|产生)|不存在|消除|避免)[^。；;\n]{0,16}(?:风险|危险|伤害)/.test(line)
      || /(?:安全性|安全)[^。；;\n]{0,16}(?:已(?:被)?验证|得到验证|得到保证|有保障)/.test(line)
      || /\b(?:safe|safer|safest|harmless)\b/i.test(line)
      || /\b(?:no|zero|without|eliminat\w*)\b[^.\n]{0,30}\b(?:risk|risks|harm|danger)\b|\brisk[- ]free\b/i.test(line)) {
      yield { reason: 'infant_safety_assurance', trigger: line };
      continue;
    }
    // 动词/谓语才是可核验的主张；「婴幼儿安全：不涉及」只是栏目，不触发。
    if (/(?:应当|应该|应|可以|必须|不得|建议|推荐|适合|适用于|预防|防止|降低|减少|增加|避免|保护|有助于|保障)[^。；;\n]{0,40}(?:睡|婴|新生儿|宝宝|安全|风险|伤害)/.test(line)
      || /(?:婴幼儿|婴儿|新生儿|宝宝)[^。；;\n]{0,30}(?:应当|应该|应|可以|必须|不得|建议|推荐)/.test(line)
      || /(?:婴幼儿|婴儿|新生儿|宝宝)\s*可/.test(line)
      || /(?:对|供|适用于|适合)[^。；;\n]{0,16}(?:婴幼儿|婴儿|新生儿|宝宝)[^。；;\n]{0,16}(?:安全|无害)/.test(line)
      || /\b(?:can|should|must|safe(?:ly)?|prevent\w*|reduc\w*)\b[^.\n]{0,60}\b(?:sleep|suffocat\w*|risk|SIDS|harm)\b/i.test(line)
      || /\b(?:safe|harmless)\b[^.\n]{0,30}\b(?:for|with)\b/i.test(line)) {
      yield { reason: 'infant_safety_statement', trigger: line };
      continue;
    }
    const absent = explicitInfantAbsence(line)
      || (infantSection && /^(?:无|不涉及|不适用|N\/A)[。.]?$/i.test(line));
    if (absent) infantSection = false;
    // unclear 同时容纳缺席说明和看不清的读数。解析器没认出谓语只说明适用性未明，
    // 不是画面中存在未知婴儿事实；必须交完整语义复核，不能阻止复核纠正自身误判。
    // 明确未知仍由上面的分支标为 infant_fact_unconfirmed；安全主张也先于此处理。
    if (fromUnclear && (subjectHere || infantSection) && !absent && !safetyTopic
      && !/^#{1,6}\s/.test(line) && !(field && line === field[0])
      && !/^(?:婴幼儿|婴儿|新生儿|宝宝)(?:产品|用品|安全座椅)(?:包装)?展示[。.]?$/.test(line)) {
      yield { reason: 'infant_scope_unresolved', trigger: line };
      continue;
    }
  }
}

function infantSafetyStatement(text, options) {
  return infantSafetyStatements(text, options).next().value ?? null;
}

function infantSafetySourceStatement(text, options) {
  const scopeDisclaimer = /(?:没有|无|未见)[^。；;\n]{0,40}(?:婴儿|婴幼儿)(?:睡眠)?场景[^。；;\n]{0,50}(?:不涉及|不适用)[^。；;\n]{0,40}(?:AAP|HealthyChildren)[^。；;\n]{0,30}(?:适用前提|来源|核查)/i;
  for (const statement of infantSafetyStatements(text, options)) {
    if (statement.reason === 'infant_presence_statement') continue;
    // A report explaining that infant sleep/AAP review is out of scope is not itself a safety assertion.
    if (scopeDisclaimer.test(statement.trigger)) continue;
    return statement;
  }
  return null;
}

export function infantSourceScope(text, { scenes, sleepPositions = [], materialTexts } = {}) {
  if (Array.isArray(sleepPositions) && sleepPositions.length) {
    return { required: true, origin: 'scene', reason: 'structured_infant_sleep', trigger: sleepPositions[0] };
  }
  // 图中文字是独立证据：报告漏写或声称「不适用」不能使其消失。
  // 旧调用可缺省；正式图片接线必须给出分图证据，不接受包装后的提示词替代。
  if (Array.isArray(materialTexts)) {
    for (const item of materialTexts) {
      const evidence = { origin: item?.origin ?? 'material', image: item?.image, sha256: item?.sha256,
        status: item?.status };
      const statement = infantSafetySourceStatement(item?.text);
      if (statement) return { required: true, ...evidence, ...statement };
    }
  }
  let absentInScenes = false;
  if (scenes !== undefined) {
    if (!Array.isArray(scenes) || !scenes.length) return { required: true, origin: 'scene', reason: 'scene_unavailable' };
    for (const [index, scene] of scenes.entries()) {
      if (!scene || !Array.isArray(scene.people)) {
        return { required: true, origin: 'scene', reason: 'scene_people_unavailable', trigger: `图 ${index + 1}` };
      }
      for (const person of scene.people) {
        const kind = String(person?.kind ?? '').trim();
        if (INFANT_SUBJECT.test(kind) || /儿童|\bchild(?:ren)?\b/i.test(kind)) {
          const statement = infantSafetySourceStatement(person?.doing);
          if (statement) return { required: true, origin: 'scene_person', image: index + 1, ...statement };
          // A clear non-sleep scene (e.g. held by an adult) is not by itself an infant-sleep safety issue.
          if (person.sleep_scene === false) continue;
          return { required: true, origin: 'scene', image: index + 1,
            reason: person.sleep_scene === true ? 'structured_infant_sleep' : 'infant_sleep_scope_unconfirmed',
            trigger: `图 ${index + 1}：婴幼儿睡眠适用性未确认` };
        }
        if (!/成人|\badult\b/i.test(kind)) {
          return { required: true, origin: 'scene', image: index + 1, reason: 'person_identity_unconfirmed', trigger: `图 ${index + 1}：${kind || '身份未给'}` };
        }
      }
      for (const item of Array.isArray(scene.unclear) ? scene.unclear : []) {
        // Only a complete, bounded absence observation is exempt; claims/unknowns keep their checks.
        if (explicitInfantAbsence(String(item))) continue;
        const statement = infantSafetySourceStatement(String(item), { fromUnclear: true });
        if (statement) return { required: true, origin: 'scene_unclear', image: index + 1, ...statement };
      }
      const cue = (Array.isArray(scene.risk_cues) ? scene.risk_cues : [])
        .find((item) => !explicitInfantAbsence(String(item)) && infantSafetySourceStatement(String(item)));
      if (cue) return { required: true, origin: 'scene_cue', image: index + 1, reason: 'structured_infant_cue', trigger: String(cue) };
    }
    absentInScenes = true;
  }
  // 审核者新增的安全判断仍需来源；不把整份报告当成原素材。
  // 按报告行保留定位，跨行婴儿语境沿用已有判据。返回的 trigger 始终是原句。
  const reportInput = absentInScenes
    ? String(text).split('\n').map(reportAbsenceClauses).join('\n') : text;
  const statement = infantSafetySourceStatement(reportInput);
  if (statement) {
    const lines = String(text).split(/\r?\n/);
    const original = lines.find((line) => reportAbsenceClauses(line).replace(/\*\*/g, '').includes(statement.trigger)) ?? statement.trigger;
    const index = lines.indexOf(original);
    const section = lines.slice(0, index + 1).reverse().find((line) => /^#{1,6}\s/.test(line)) ?? '';
    return { required: true, origin: 'review_assertion', ...statement, trigger: original.trim(), section };
  }
  if (absentInScenes) return { required: false, origin: 'scene', reason: 'structured_adults_or_no_people' };
  const required = legacyInfantSafetySource(text);
  return { required, reason: required ? 'legacy_infant_scope_unresolved' : 'legacy_no_infant_safety_statement' };
}

// 第一条触发证据用于解释；强制保留的未知事实必须读完全部来源，不能被先前命中遮住。
function infantUncertainties(text, { scenes, materialTexts }) {
  const unknowns = [];
  const collect = (value, source, options) => {
    const statement = [...infantSafetyStatements(value, options)].find((item) => item.reason === 'infant_fact_unconfirmed');
    if (statement) unknowns.push({ ...source, ...statement });
  };
  collect(text, { origin: 'review_assertion' });
  for (const item of Array.isArray(materialTexts) ? materialTexts : []) {
    collect(item?.text, { origin: item?.origin ?? 'material', image: item?.image, sha256: item?.sha256 });
  }
  for (const [index, scene] of (Array.isArray(scenes) ? scenes : []).entries()) {
    for (const item of Array.isArray(scene?.unclear) ? scene.unclear : []) {
      if (!explicitInfantAbsence(String(item))) collect(item, { origin: 'scene_unclear', image: index + 1 }, { fromUnclear: true });
    }
    for (const item of Array.isArray(scene?.risk_cues) ? scene.risk_cues : []) {
      if (!explicitInfantAbsence(String(item))) collect(item, { origin: 'scene_cue', image: index + 1 });
    }
  }
  return unknowns;
}

export const INFANT_SOURCE_MISSING = '婴儿安全事实的权威来源核查（AAP/HealthyChildren）';

// 自由文本只用于筛出要复核的条目，不能凭“同床”等词认定肯定事实。
// 真实婴儿/未知人物/睡姿由结构化证据强制核查，不允许语义复核取消。
export function needsInfantScopeReview(workflow, { scenes, sleepPositions = [] } = {}) {
  if (!workflow?.infantSource?.required || !Array.isArray(workflow.missing)
    || workflow.missing.some((item) => item !== INFANT_SOURCE_MISSING)) return false;
  // 明确未确认的婴儿事实保留既有强制核查，不能用另一条“只有成人”读数消除冲突。
  if (workflow.infantSource.reason === 'infant_fact_unconfirmed' || workflow.infantUncertainties?.length) return false;
  if (!['review_assertion', 'scene_cue', 'scene_unclear', 'image_ocr', 'visual_text'].includes(workflow.infantSource.origin)) return false;
  if (sleepPositions.length || !Array.isArray(scenes) || !scenes.length) return false;
  return scenes.every((scene) => Array.isArray(scene?.people)
    && scene.people.every((person) => /^(?:成人|adult)$/i.test(String(person?.kind ?? '').trim())));
}

export function applyInfantScopeReview(workflow, assessment, options) {
  if (!needsInfantScopeReview(workflow, options)) return workflow;
  const missing = workflow.missing.filter((item) => item !== INFANT_SOURCE_MISSING);
  let infantSource = workflow.infantSource;
  if (assessment?.ok !== true || typeof assessment.required !== 'boolean') {
    // 复核未完成不能伪称已确认婴儿安全事实，也不能保留一个偶然带AAP字样的通过态。
    missing.push('婴儿安全事实适用性复核未完成');
    infantSource = { required: null, origin: 'semantic_scope', reason: 'infant_scope_unmeasured' };
  } else {
    infantSource = { required: assessment.required, origin: assessment.origin,
      reason: assessment.reason, trigger: assessment.trigger, evidenceHash: assessment.evidenceHash };
    if (assessment.required && !workflow.hasAuthoritativeSource) missing.push(INFANT_SOURCE_MISSING);
  }
  return { ...workflow, infantSource, semanticReview: assessment ?? { ok: false, reason: 'no_result' },
    missing, ok: missing.length === 0,
    reason: missing.length ? `图片安全审查 skill 全流程缺项：${missing.join('、')}` : '' };
}

export function checkImageSkillWorkflow(text, { sleepPositions = [], scenes, materialTexts, factSources = [] } = {}) {
  const s = String(text ?? '');
  const delivered = checkImageWorkflowEvidence(s, { sources: factSources });
  const missing = [...delivered.missing];
  // 未提供新参数的历史调用沿用兼容模式；显式提供但读数缺失/失败不能静默当成无文字。
  if (materialTexts !== undefined) {
    if (!Array.isArray(materialTexts) || !materialTexts.length) missing.push('图中文字来源证据未提供');
    else for (const item of materialTexts) {
      if (!['image_ocr', 'visual_text'].includes(item?.origin)
        || !['ok', 'empty'].includes(item?.status) || typeof item?.text !== 'string'
        || (item.status === 'empty' && item.text.trim())
        || (item.status === 'ok' && !item.text.trim())) {
        missing.push(`图 ${item?.image ?? '?'} 图中文字来源未完整读取（${item?.origin ?? '未给来源'}：${item?.status ?? '未测'}）`);
      }
    }
  }
  // Mere infant presence does not require AAP citation. Actual infant safety facts/claims or unknown scope do.
  // Source claims in the image text/report remain independent; unreadable scene data is blocked by scene faults.
  const infantSource = infantSourceScope(s, { sleepPositions, scenes, materialTexts });
  const hasAuthoritativeSource = delivered.hasAuthoritativeSource;
  if (infantSource.required && !hasAuthoritativeSource) missing.push(INFANT_SOURCE_MISSING);
  return {
    ok: missing.length === 0,
    missing,
    infantSource,
    infantUncertainties: infantUncertainties(s, { scenes, materialTexts }),
    hasAuthoritativeSource,
    stages: delivered.stages,
    factReview: delivered.factReview,
    materialTextEvidence: Array.isArray(materialTexts) ? materialTexts.map((item) => ({
      origin: item?.origin, image: item?.image, sha256: item?.sha256, status: item?.status,
    })) : undefined,
    reason: missing.length ? `图片安全审查 skill 全流程缺项：${missing.join('、')}` : '',
  };
}

/** 给提示词用的清单说明（模板与手册共用**同一份**，别各抄一遍）。 */
export function visualChecklistInstructions() {
  return [
    '【★ 第 0 条之三 —— 图单必须交「视觉核对清单」（缺项本单**不收**）】',
    '在回复里**逐项**写下面五类，每项给结论与依据：',
    ...VISUAL_CATEGORIES.map((c) => `  · ${c.label}`),
    '  · 「婴儿睡眠位置」必须单独写明每个睡眠场景中婴儿的仰卧/侧卧/俯卧/看不清；不能用「姿势正常」或「安全」代替。',
    '  · 画面没有婴儿睡眠场景时，写「婴儿睡眠位置=无（画面没有婴儿睡眠场景）」；有但无法辨认时写「未测」并说明原因。',
    '  · 画面读数为侧卧/俯卧时该项必须判「有」；姿势读数为看不清/未给时必须判「未测」，不得当成无问题。',
    '  · 同一张图有多个面板/婴儿时逐个核对，分别标明面板；床共享风险与睡姿是两个独立问题。',
    '结论只能是 `有` / `无` / `未测`：',
    '  · `有` ⇒ **必须写依据**（看到了什么、在哪个位置，例如「产品状态：有（床头柜上的奶瓶倒置）」）；',
    '  · `无` ⇒ 直接写「无」（不许写「未见明显问题」这类含糊话）；',
    '  · `未测` ⇒ **必须写原因**（例如「画面读数没跑到」）。',
    '依据只能来自**画面读数**（守衡给的那一格），不许拿 OCR 文字冒充画面事实。',
    '每条问题的「位置」也必须按四形态写：`区域词，图 N 第 X 处`（区域词只许 顶部/中部/底部/左侧/右侧；',
    '第 X 处 = 图内文字块阅读顺序行号）——**不许写裸「图 1」或「图 1 主视觉」**：出口闸 R3 会判红。',
  ].join('\n');
}

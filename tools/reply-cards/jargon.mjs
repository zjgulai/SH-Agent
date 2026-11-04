/**
 * jargon.mjs —— **判定引擎的内部字段名不许出现在用户可见正文里**（纯函数，无副作用）
 *
 * ── 为什么要有它（2026-10-26，Owner 当场贴出三条回复）
 *
 * Owner 原话：「守衡的回复没有按照 prd 和原先的输出模版来回复，定位马上修复」。
 * 那三条回复（飞书私聊 `oc_TEST_P2P`，11:39 / 11:51 / 12:08）
 * 里出现了这些东西：
 *
 *     label = REVIEW / layer = DP3 / release_status = 待放行 / parse_status = ok
 *     coverage = partial；空命中或证据不足时，只能判定为 REVIEW
 *
 * 它们的共同点：**不是 PRD §5.3 的结论行，也不是任何人能读懂的句子** ——
 * 它们是判定引擎内部的字段名与读数。业务同事看到 `parse_status=ok` 只会问一句
 * 「什么意思」，而这一问的成本落在审核员身上。
 *
 * ── 为什么「不许写」，而不是「改写」
 *
 * 与 `registry.mjs` 的 `internalLeak` 同一条规矩（`agent-skills/守衡语域/SKILL.md` 第 7 条）：
 * 内部详情**只进折叠区/日志/报告**，正文里出现就是故障。这里取最保守的动作 ——
 * **整行丢掉**（不是把 `label = REVIEW` 改写成「判定为 REVIEW」，那样等于替模型补一条
 * 它没被授权下的事实结论），丢掉的原文由调用方留痕（`moved` 记录 + 日志）。
 *
 * ── 判据边界（写清楚，免得下一轮有人拿它当万能尺）
 *
 *   · 只认**赋值形态**（`字段 = 值`）与**层 ID**（`DP0`–`DP4`）以及发布状态黑话（`待放行`）。
 *     不认 `coverage` 这种在正经英文里也会出现的单词 —— 误报比不报更糟（§2.1.1）。
 *   · `risk_items` / `source_chain` / `boundary_statement` 出现在正文里同样是内部读数，
 *     一起收掉；它们在 PRD §5.3 的逐条字段里**一个都没有**。
 *
 * ── 判据
 *
 *   `node tools/verify_cards.mjs` 的 J5d–J5f（正例 + 两条反向对照）；
 *   变异自证：把 `stripEngineJargon` 的返回改回原文 ⇒ J5d/J5e 精确变红。
 */

/** `字段 = 值` —— 赋值形态才收。单独一个英文单词不算（误报比不报更糟）。 */
const FIELD_ALT = [
  'label', 'layer', 'release_status', 'parse_status', 'coverage',
  'does_not_cover', 'machine_may_finalize', 'rule_keys_hit', 'boundary_statement',
  'risk_items', 'source_chain', 'citations',
].join('|');
const ASSIGN_RE = new RegExp(`(^|[\\s（(、，,；;：:|｜/／]\`?)(?:${FIELD_ALT})\`?\\s*=\\s*`, 'i');

/** 处置层 ID（`DP0`–`DP4`）与发布状态黑话（`待放行`） —— 库内坐标，业务侧读不懂。 */
const LAYER_ID_RE = /\bDP[0-4]\b/;
const RELEASE_WORD_RE = /待放行/;

/** 信封标记：模型偶尔把它们写进卡片字段里（实测 2026-10-26 那条卡片的折叠组里漏出过）。 */
const CARD_MARK_RE = /\[\[\/?card(?::[^\]\n]*)?(?:\]\])?/g;

/**
 * 这一行是不是**内部读数的赋值行**。
 * @param {string} line
 * @returns {boolean}
 */
export function isJargonLine(line) {
  const t = String(line ?? '');
  if (!t.trim()) return false;
  return ASSIGN_RE.test(t) || LAYER_ID_RE.test(t) || RELEASE_WORD_RE.test(t);
}

/**
 * 把一段正文里**内部读数行**整行摘掉，并报告摘了什么。
 *
 * @param {string} text
 * @returns {{text: string, removed: string[]}}
 */
export function stripEngineJargon(text) {
  const src = String(text ?? '');
  const removed = [];
  const kept = [];
  for (const line of src.split('\n')) {
    if (isJargonLine(line)) { removed.push(line.trim()); continue; }
    kept.push(line.replace(CARD_MARK_RE, ''));
  }
  // 摘行之后可能留下连续空行：压成一行空行（只压 3 行以上，避免把 markdown 段落拆散）
  return { text: kept.join('\n').replace(/\n{3,}/g, '\n\n'), removed };
}

/**
 * 递归清理卡片数据里的字符串（`{...}` / `[...]` 都走）。
 *
 * 为什么要在**数据层**做、而不是在原始文本层：卡片块是一段 JSON，
 * 按行摘掉会把它摘成坏 JSON（整张卡降级成纯文本）—— 那是比黑话更坏的后果。
 * 在解析出来的数据上摘，坏不了结构。
 *
 * @param {any} value
 * @param {string[]} sink 摘掉的原文（调用方拿去留痕）
 * @returns {any}
 */
export function scrubCardData(value, sink = []) {
  if (typeof value === 'string') {
    const r = stripEngineJargon(value);
    sink.push(...r.removed);
    return r.text;
  }
  if (Array.isArray(value)) return value.map((v) => scrubCardData(v, sink));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubCardData(v, sink);
    return out;
  }
  return value;
}

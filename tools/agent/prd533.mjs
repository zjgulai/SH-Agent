/**
 * **PRD §5.3.3 输出字数与格式硬约束** —— 断言器（守衡侧）。
 *
 * ★ 真源只有一份：`kb/l7/registry/prd533-constraints.yaml`
 *   （取自飞书 PRD **正文** §5.3.3，rev 248，2026-10-19 拉取）。
 *   本文件**不写死任何上限/模式** —— 写死就是第二份口径。
 *
 * 四条约束（PRD 逐字）：
 *   ① 单条问题：描述 ≤50 字、原因 ≤50 字、修改建议 ≤60 字（Owner 2026-10-21 调整）
 *   ② 位置：必须精确到「图 N 第 X 处」「视频 00:12」「正文第 X 段」
 *   ③ 依据：必须写「《文档名》第 X 条」或「规则 ID」，禁止写「相关法规」
 *   ④ 语言：客观、指令式；禁止「可能」「建议可以考虑」等废话（REVIEW 边界说明除外）
 *
 * ★ 与 §17 的关系：§17 管**整条/每条消息**的字数，§5.3.3 管**每条问题里每个字段**的字数。
 *   两把尺互补，都读各自的 registry。
 *
 * ★ 本模块**只给读数、不阻断**。修改建议上限以 registry 的 Owner 2026-10-21 覆盖值为准。
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REL = join('Documents', 'skill-test', '执行skills', '执行skills', 'skills-回归测试',
  '知识库', '内容治理', 'kb', 'l7', 'registry', 'prd533-constraints.yaml');

/** 真源路径：按候选找，全找不到就抛错并列出试过哪些（不静默兜底）。 */
export function resolvePath() {
  const cands = [
    process.env.PRD533_CONSTRAINTS,
    join(HERE, '..', '..', '..', '..', REL),
    join(HERE, '..', '..', '..', REL),
    '/Users/lute/Documents/skill-test/执行skills/执行skills/skills-回归测试/知识库/内容治理/kb/l7/registry/prd533-constraints.yaml',
  ].filter(Boolean);
  for (const c of cands) if (existsSync(c)) return c;
  throw new Error(`[prd533] 找不到真源 prd533-constraints.yaml，试过：\n  ${cands.join('\n  ')}`);
}

let _cache = null;

/** 极简读取（只认本 registry 用到的形状：行内 `- {…}` 与 `key: value`）。 */
function parseLoose(text) {
  const flat = {};
  const inline = [];
  for (const line of String(text).split('\n')) {
    const kv = /^\s*([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) flat[kv[1]] = kv[2].trim();
    const m = /^\s*-\s*\{(.+)\}\s*$/.exec(line);
    if (!m) continue;
    const obj = {};
    for (const part of m[1].split(/,\s*(?=[A-Za-z_][\w-]*:)/)) {
      const k = /^\s*([A-Za-z_][\w-]*):\s*(.*)$/.exec(part);
      if (!k) continue;
      let v = k[2].trim().replace(/^['"]|['"]$/g, '');
      if (/^\d+$/.test(v)) v = Number(v);
      if (v === 'true') v = true;
      if (v === 'false') v = false;
      obj[k[1]] = v;
    }
    inline.push(obj);
  }
  return { flat, inline };
}

export function loadConstraints(path = resolvePath()) {
  if (_cache && _cache.path === path) return _cache.data;
  const text = readFileSync(path, 'utf8');
  const { flat, inline } = parseLoose(text);
  const fields = inline.filter((o) => o.key && o.limit != null);
  const locPatterns = inline.filter((o) => o.id && o.regex && /^\^/.test(String(o.regex)));
  const forbidden = inline.filter((o) => o.word).map((o) => o.word);
  if (!fields.length) throw new Error(`[prd533] ${path} 里没解析出字段上限`);
  if (!locPatterns.length) throw new Error(`[prd533] ${path} 里没解析出位置模式`);
  const rev = /^\s*revision:\s*(\d+)/m.exec(text);
  const data = {
    path,
    revision: rev ? Number(rev[1]) : null,
    fields,
    location: locPatterns.map((p) => ({ id: p.id, regex: p.regex, sample: p.sample })),
    basisPatterns: inline.filter((o) => o.id && o.regex && !/^\^/.test(String(o.regex))),
    // ⚠️ `forbidden: ['相关法规', '相关法律法规']` 是 **YAML flow 列表**，不是行内映射 ⇒
    //   第一版只按 `- {forbidden: …}` 找，结果**一条都没读到**，于是「相关法规」判成合规。
    basisForbidden: (() => {
      const m = /^\s*forbidden:\s*\[(.*?)\]\s*$/m.exec(text);
      const fromList = m
        ? m[1].split(',').map((x) => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
        : [];
      const fromInline = inline.filter((o) => o.forbidden)
        .flatMap((o) => String(o.forbidden).split(/[|,]/)).map((x) => x.trim()).filter(Boolean);
      return [...new Set([...fromList, ...fromInline])];
    })(),
    languageForbidden: forbidden.filter((w) => typeof w === 'string' && w.length <= 8),
    counting: { stripUrls: true, stripMarkdown: true, stripWhitespace: true },
  };
  _cache = { path, data };
  return data;
}

/** 数字数（与 §17 同一口径：去链接、去 markdown 标记、去空白）。 */
/** 收口成「可见字符」的那一步（去链接、去 markdown 标记、去空白）—— 两种口径共用。 */
export function stripForCount(text) {
  return String(text ?? '')
    .replace(/\[([^\]\n]*)\]\((?:https?:)?[^)\s]*\)/g, '$1')
    .replace(/https?:\/\/[^\s)）]+/g, '')
    .replace(/[*`>|【】→#]/g, '')
    .replace(/\s+/g, '');
}

export function countChars(text) {
  return stripForCount(text).length;
}

//: **修改建议**那一格「字」怎么数：**标点不计**。
//:
//: ★★ Owner 2026-10-19 逐字：「修改建议 是可以 30 字的，**不带标点这些**，可以多写一些」
//:    ⇒ 30 字指的是**实词字数**；`删「最」字，改为「更」；补一行日期`（含 6 个标点）按 **14 字**算。
//:    只对 `advice` 这一格生效（描述/原因仍按 `countChars`）—— Owner 说的是「修改建议」。
//:    ⚠️ 只去**标点**，`-` / `/` / `_` 不在此列：`best-selling` 里的连字符是**词的一部分**，
//:      把它算成标点会让英文建议凭空变短 1 字。
const ADVICE_PUNCT_RE = /[，。、；：！？…—～·「」『』（）【】《》〈〉“”‘’,.!?;:'"()\[\]{}<>]/g;

export function countAdviceChars(text) {
  return stripForCount(text).replace(ADVICE_PUNCT_RE, '').length;
}

/** 字段上限从唯一 registry 读取，提示词、渲染与验收共用同一数值。 */
export function fieldLimit(key) {
  const row = loadConstraints().fields.find((f) => f.key === key);
  if (!row) throw new Error(`[prd533] registry 缺少字段上限：${key}`);
  return Number(row.limit);
}

export const ADVICE_MAX = fieldLimit('advice');

/** 每条问题里**逐字段**的字数判定。 */
export function checkFields(item = {}) {
  const C = loadConstraints();
  const rows = C.fields.map((f) => {
    const raw = String(item[f.key] ?? '');
    // ★ 2026-10-19：`advice` 按**不计标点**数（见 `countAdviceChars` 头注），其余字段照旧。
    const chars = (f.key === 'advice') ? countAdviceChars(raw) : countChars(raw);
    return { key: f.key, label: f.label, limit: Number(f.limit), chars,
      over: Math.max(0, chars - Number(f.limit)), ok: chars <= Number(f.limit) };
  });
  return { rows, ok: rows.every((r) => r.ok), overCount: rows.filter((r) => !r.ok).length };
}

/** 位置是否落在 PRD 给的三个模式之一。 */
export function checkLocation(location) {
  const C = loadConstraints();
  const s = String(location ?? '').trim();
  for (const p of C.location) {
    try { if (new RegExp(p.regex).test(s)) return { ok: true, pattern: p.id, value: s }; }
    catch { /* 模式写坏就当不匹配，下面如实返回 */ }
  }
  return { ok: false, pattern: null, value: s,
    want: C.location.map((p) => p.sample).join(' / ') };
}

/**
 * **位置是否与素材模态对得上**（2026-10-20 加；与 `checkLocation` 并存、不改它的语义）。
 *
 * 病灶：`checkLocation` 判的是「三种形态**任一**命中即过」，它不问「跟素材对不对」——
 * 于是 2026-10-19 那张**图片单**里印着 `正文第 7 段`（素材只有一张图），**不会红**。
 * 现在把模态一起判：图片只认 `图 N 第 X 处`、视频只认 `视频 MM:SS`、文字只认 `正文第 X 段`。
 * ⚠️ 没给模态 ⇒ `skipped: true`（**不判**，与调用方未升级时行为一致，不许静默判红或判绿）。
 * ⚠️ 与字数限制无关：本函数只判形态，不碰 `fields` 的任何上限。
 */
// ★★ 2026-10-22（Owner 裁定「给面板形态开口子」）：图片多认两种形态 ——
//   `figure_area`（图片顶部，图 1 第 3 处）与 `figure_panel`（图 1 上方面板 / 图 1 主视觉）。
//   后者是**画面面板上的发现**：它没有图内文字行号可写，硬编「第 X 处」就是编造读数。
//   三个 id 都登记在真源 `prd533-constraints.yaml` 里 —— 本文件只写「哪些 id 属于哪个模态」，
//   不复制正则（复制一份就会各自漂）。
const MODALITY_PATTERN = {
  image: ['figure', 'figure_area', 'figure_panel'],
  video: ['video'],
  text: ['text'],
};
export function checkLocationFor(location, modality) {
  const C = loadConstraints();
  const s = String(location ?? '').trim();
  const want = MODALITY_PATTERN[String(modality ?? '').trim().toLowerCase()] || null;
  if (!want) {
    return { ok: true, skipped: true, modality: String(modality ?? '') || null, pattern: null,
      value: s, expected: null };
  }
  const ids = Array.isArray(want) ? want : [want];
  const cands = ids.map((id) => (C.location || []).find((x) => x.id === id)).filter(Boolean);
  if (!cands.length) {
    return { ok: false, skipped: false, modality, pattern: null, value: s,
      expected: '（登记件里没有这一形态，检查配置）' };
  }
  const hit = cands.find((p) => { try { return new RegExp(p.regex).test(s); } catch { return false; } }) || null;
  return { ok: !!hit, skipped: false, modality, pattern: hit ? hit.id : null, value: s,
    expected: cands.map((p) => p.sample).join(' / ') };
}

/** 依据是否写了「《文档名》第 X 条」或「规则 ID」，且没有「相关法规」这类空话。 */
export function checkBasis(basis) {
  const C = loadConstraints();
  const s = String(basis ?? '');
  const hit = (C.basisPatterns || []).find((p) => {
    try { return new RegExp(String(p.regex)).test(s); } catch { return false; }
  });
  const banned = C.basisForbidden.filter((w) => w && s.includes(w));
  return { ok: !!hit && banned.length === 0, pattern: hit ? hit.id : null, banned };
}

/** 语言禁词（`可能` / `建议可以考虑` 等）。命中就如实报，不做语境豁免判定。 */
export function checkLanguage(text) {
  const C = loadConstraints();
  const s = String(text ?? '');
  const hits = C.languageForbidden.filter((w) => w && s.includes(w));
  return { ok: hits.length === 0, hits };
}

/**
 * 量一条问题（字段 + 位置 + 依据 + 语言）。
 * @returns 汇总读数；`ok` 只有四项全过才为 true。
 */
export function checkItem(item = {}) {
  const fields = checkFields(item);
  const location = checkLocation(item.location);
  // ★★ 2026-10-20：**模态绑定**单独一格（不改 `location.ok` 的旧语义 ⇒ 既有判据一个都不动）
  const locationModality = checkLocationFor(item.location, item.modality);
  const basis = checkBasis(item.basis);
  const language = checkLanguage([item.description, item.reason, item.advice, item.basis].join('\n'));
  return {
    fields, location, locationModality, basis, language,
    ok: fields.ok && location.ok && basis.ok && language.ok,
    revision: loadConstraints().revision,
  };
}

/** 一句话读数（上日志够用）。 */
export function readingOf(item = {}) {
  const r = checkItem(item);
  const bad = [];
  r.fields.rows.filter((x) => !x.ok).forEach((x) => bad.push(`${x.label} ${x.chars}>${x.limit}`));
  if (!r.location.ok) bad.push(`位置「${r.location.value}」不在三模式内`);
  if (!r.basis.ok) bad.push(r.basis.banned.length ? `依据含禁词 ${r.basis.banned.join('/')}` : '依据既非《文档名》第 X 条、也非规则 ID');
  if (!r.language.ok) bad.push(`语言禁词 ${r.language.hits.join('/')}`);
  return bad.length ? `PRD §5.3.3 不合格：${bad.join('；')}` : 'PRD §5.3.3 合格';
}

// ── 自证 ────────────────────────────────────────────────────────────────────────
export function selftest() {
  const bad = [];
  const eq = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) bad.push(`${name} —— 期望 ${JSON.stringify(want)}，实得 ${JSON.stringify(got)}`);
    console.log(`  ${ok ? '✅' : '❌'} ${name}`);
  };
  console.log('\n=== PRD §5.3.3 输出字数与格式硬约束 自证 ===');

  const C = loadConstraints();
  eq('① 三个字段上限 = 50/50/60（建议上限由 Owner 2026-10-21 调整）',
    C.fields.map((f) => `${f.key}=${f.limit}`), ['description=50', 'reason=50', 'advice=60']);
  eq('①b 真源带 PRD 版本（可回溯）', typeof C.revision, 'number');

  // ② 字段字数：贴线合规、超一字就红
  eq('② 描述恰好 50 字 ⇒ 合规', checkFields({ description: '字'.repeat(50) }).rows[0].ok, true);
  eq('②b 描述 51 字 ⇒ 超 1', checkFields({ description: '字'.repeat(51) }).rows[0].over, 1);
  eq('②c 建议 61 字 ⇒ 超 1（上限 60）', checkFields({ advice: '字'.repeat(61) }).rows[2].over, 1);
  // 反向对照：同一段 31 字放进「原因」那格 ⇒ 合规（证明逐字段各自判定）
  eq('②d 反向对照：同样 31 字放进原因 ⇒ 合规', checkFields({ reason: '字'.repeat(31) }).rows[1].ok, true);

  // ③ 位置三模式
  eq('③ 三个样张都合规',
    ['图 1 第 2 处', '视频 00:12', '正文第 3 段'].map((s) => checkLocation(s).ok), [true, true, true]);
  // 反向对照：真实出现过的四种不合格形状必须红
  eq('③b 反向对照：`全文` / 带括号补充 / 缺「第X处」/ 中文数字段号 ⇒ 全红',
    ['全文', '正文第 4 段（DoubleFit Flange, Ultimate Comfort）末句', '图 1', '正文第三段']
      .map((s) => checkLocation(s).ok), [false, false, false, false]);

  // ④ 依据：两种合法写法 + 禁词
  eq('④ 《文档名》第 X 条 ⇒ 合规',
    checkBasis('《措辞表达库 v0》第 W-1.18 条 ← 命中「boosts milk」').ok, true);
  eq('④b 纯规则 ID ⇒ 合规', checkBasis('H02').ok, true);
  eq('④b2 原图观察依据 ⇒ 合规',
    checkBasis('无外部依据（原图观察：图 1：右上角俯卧婴儿；需人工核对）').ok, true);
  eq('④b3 外部标准《文档》或原始出处 URL ⇒ 合规',
    checkBasis('FTC Truth in Advertising → https://www…｜⚠️ 未核｜原始出处：https://www.ftc.gov/business-guidance/advertising-marketing').ok, true);
  eq('④c 「相关法规」⇒ 红（PRD 点名禁止）', checkBasis('依据：相关法规').ok, false);
  // 反向对照：「建议参考相关法律法规」这种最常见空话也要红
  eq('④d 反向对照：「相关法律法规」变体也要红', checkBasis('建议参考相关法律法规').banned.length > 0, true);

  // ⑤ 语言禁词
  eq('⑤ 「可能」命中', checkLanguage('可能会被平台判为站外引流').ok, false);
  eq('⑤b 「建议可以考虑」命中', checkLanguage('建议可以考虑改一下').ok, false);
  eq('⑤c 干净文本不误报', checkLanguage('删去「100%」，改为具体表述。').ok, true);

  // ⑥ 汇总判定：四项全过才 ok
  const good = checkItem({ description: '逐字命中「boosts milk」', reason: '绝对化用语',
    advice: '删去「100%」。', location: '正文第 1 段', basis: '《措辞表达库 v0》第 W-1.18 条' });
  eq('⑥ 四条全过 ⇒ ok', good.ok, true);
  // 反向对照：只把位置换成 `全文`，其余不动 ⇒ 必须红（证明位置那一项真的在判）
  const badLoc = checkItem({ description: '逐字命中「boosts milk」', reason: '绝对化用语',
    advice: '删去「100%」。', location: '全文', basis: '《措辞表达库 v0》第 W-1.18 条' });
  eq('⑥b 反向对照：只换位置 ⇒ 红', [badLoc.ok, badLoc.fields.ok], [false, true]);

  // ★★ 2026-10-20：**模态绑定**（⑥c–⑥h）。
  //   ⑥d 就是 2026-10-19 真单的现场：图片素材 + `正文第 7 段` ⇒ 必须红。
  eq('⑥c 图片 + 「图 1 第 2 处」⇒ 过', checkLocationFor('图 1 第 2 处', 'image').ok, true);
  eq('⑥d 图片 + 「正文第 7 段」⇒ 红（2026-10-19 真单现场）',
    checkLocationFor('正文第 7 段', 'image').ok, false);
  // ★★ 2026-10-22：面板形态与区域形态都要过；面板形态带「第 X 处」必须红
  eq('⑥c2 图片 + 「图 1 上方面板」⇒ 过（面板类发现）',
    checkLocationFor('图 1 上方面板', 'image').ok, true);
  eq('⑥c3 图片 + 「图片顶部，图 1 第 3 处」⇒ 过（区域前缀形态）',
    checkLocationFor('图片顶部，图 1 第 3 处', 'image').ok, true);
  eq('⑥c4 图片 + 「图 1 上方面板 第 3 处」⇒ 红（面板上不许编行号）',
    checkLocationFor('图 1 上方面板 第 3 处', 'image').ok, false);
  eq('⑥c5 图片 + 「图 1 随便写」⇒ 红（面板名是闭集）',
    checkLocationFor('图 1 随便写', 'image').ok, false);
  eq('⑥e 视频 + 「视频 00:12」⇒ 过', checkLocationFor('视频 00:12', 'video').ok, true);
  eq('⑥f 视频 + 「[00:12]」⇒ 红（模型侧旧形状）', checkLocationFor('[00:12]', 'video').ok, false);
  eq('⑥g 文字 + 「正文第 3 段」⇒ 过', checkLocationFor('正文第 3 段', 'text').ok, true);
  eq('⑥h 没给模态 ⇒ skipped（不判，未升级的调用方行为不变）',
    checkLocationFor('全文', '').skipped, true);

  console.log(`\n自证：通过 ${bad.length ? '—' : 'all'} / 失败 ${bad.length}`);
  bad.forEach((b) => console.log(`   ❌ ${b}`));
  return bad.length ? 1 : 0;
}

if (process.argv[1] && /prd533\.mjs$/.test(process.argv[1]) && process.argv.includes('--selftest')) {
  process.exit(selftest());
}

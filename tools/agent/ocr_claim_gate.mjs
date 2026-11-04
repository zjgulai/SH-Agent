/**
 * ocr_claim_gate.mjs —— **汉字声称闸**：`图上有中文` 这类结论，必须有读数撑得住。
 *
 * ── 它为哪一次事故而生（Owner 2026-10-16 逐字问的）
 *
 *   「第17行是图片，审查报告中 图 1 内文字行「嫩圈o」「白」，**图片中有吗**？你验证下」
 *
 *   实测（三步，全部可复现，见 `采集-20261013/verify_cjk_ocr_claims.py`）：
 *     · 那张图**通篇英文**（momcozy 商品图：`Descaling Tablets` / `Detergent Tablets` /
 *       控制面板 `Steam·Lighting·Drying·Cleaning` / 纸盒印 `30 tablets` / 每袋印 `40`）；
 *     · 产线那把 OCR（macOS Vision，语种表与 `vision.mjs::OCR_LANGS` 相同）**确实**读出了
 *       `白`（机身黑色控制面板上 `Cleaning` 图标处）与 `嫩圈o`（纸盒上印的 `30` 那一带），
 *       **两处置信度都是 0.3 ＝ 该引擎的下限**；
 *     · **反证**：整图放大 2× 再 OCR ⇒ 汉字归零（同一处读成「小图」「～～」）。
 *       同一批像素换个尺度就读出另一串"汉字" ⇒ 不是字形，是噪声。
 *   ⇒ 模型侧（它**看不到原图**，只吃这段 OCR 文字）把它当成「图上出现了中文」，
 *     出了 REVIEW 条目 ＋ 一整套「把中文贴片换成英文」的改图建议 ——
 *     **让被审方去改一个图上根本不存在的东西**。同形问题 80 行里 4 行，真阳性 **0**。
 *
 * ── 闸门怎么判（两条判据，**确定性的**，不新增 LLM 调用）
 *
 *   触发（要同时满足）：
 *     ① 条目**在说画面**：正文里出现 图 / 图内 / 图上 / 主图 / 画面 / 帧 / 封面 ——
 *        正文里的中文不算（那是素材文字层，本来就可核，走不着这把尺子）；
 *     ② 条目**在声称非英文文字**：出现 中文 / 汉字 / 中英混排 / 简体 / 繁体 / Chinese …
 *   确认（满足其一即**保留原样**）：
 *     (a) **画面层确认**：本次跑的 `画面读数` 自己写出 `text_script = 中文/中英混排`，
 *         或读数正文里出现汉字 —— 那一层**真的看了像素**，是本项目唯一的一手视觉证据；
 *     (b) **OCR 置信度够**：条目引用的那串汉字在本次 OCR 结果里**逐字出现**，且该行
 *         `c >= MIN_CONF`（默认 0.5）—— 读得实，才当读数。
 *   ⇒ 两条都不成立 ⇒ **降级**：出闸门、**不计入问题数**（因而不影响三态、不触发报告链接），
 *     并在日志里留下**逐条**痕迹（降级了什么、凭什么降）。
 *
 * ── 三条边界（每条都有执行点，别只当注释读）
 *
 *   · **只对本机 OCR 读过的素材生效**：`evidence.ocrLines` 为空（这一单压根没 OCR）⇒
 *     闸门**整体不生效**（原样放行）。理由：这条闸要防的是「**我们自己的低置信度读数**
 *     被当成事实」，没有读数就不是这件事；拿它去拦别的来源（例如链侧对落地页的 OCR）
 *     会把真问题一起拦掉，那是另一种失真。
 *   · **降级 ≠ 删除**：降下的条目**逐条**进日志，`why` 里写清「引用的是什么字、
 *     置信度多少、画面层说了什么」。宁可留痕让人来推翻，也不静默吞掉。
 *   · **失败要响，不许静默**：本模块的每个函数都不抛（`gateFindings` 内部 try/catch）——
 *     闸门自己坏了，**不许把整单结论带下水**；坏了就原样放行并打 warn。
 *     （这与「宁可漏报、不许编」同向：闸门是**减噪**用的，不是判定者。）
 *
 * ── 判据自证
 *
 *   node tools/agent/ocr_claim_gate.mjs --selftest     # G1–G9，含**真单夹具**与三条反向对照
 */
import fs from 'node:fs';
import path from 'node:path';

/** 汉字（含扩展 A 与兼容区）。 */
export const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
/** 声称「图上有非英文文字」的用词。 */
export const CLAIM_WORDS = /中文|汉字|漢字|中文字样|简体|繁体|中英混排|Chinese\s*characters?/i;
/** 在说**画面**（不是素材正文）的用词。 */
export const VISUAL_WORDS = /图\s*\d|图内|图上|图片|主图|画面|帧|封面|缩略图|thumbnail/i;
/** macOS Vision 的置信度下限（实测噪声全部落在这里；`0.3` 是它的地板，不是"中等"。） */
export const VISION_CONF_FLOOR = 0.3;
/** 认定「读得实」的下限。可由调用方覆盖（自证里的变异对照就靠它）。 */
export const MIN_CONF = Number(process.env.SHOUHENG_OCR_CJK_MIN_CONF || 0.5);

/** 取出一段文本里的汉字串（连续的汉字算一串，长度 ≥ 1）。 */
export function cjkRunsOf(text) {
  const m = String(text ?? '').match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g);
  return m ? [...new Set(m)] : [];
}

/**
 * 这一条**是不是**在声称「图上有非英文文字」。
 * @returns {{claimed:boolean, runs:string[], text:string, why:string}}
 */
export function claimOf(f) {
  const parts = [f?.location, f?.reason, f?.excerpt].map((x) => String(x ?? '')).filter(Boolean);
  const text = parts.join(' ｜ ');
  if (!text.trim()) return { claimed: false, runs: [], text, why: '条目里没有位置/原因/引用' };
  if (!VISUAL_WORDS.test(text)) return { claimed: false, runs: [], text, why: '没有指向画面（图/画面/帧…）' };
  if (!CLAIM_WORDS.test(text)) return { claimed: false, runs: [], text, why: '没有声称非英文文字' };
  // 引用的那串汉字：优先取**引号里**的（`「嫩圈o」` / `『白』` / `"三分"`），
  // 再并上 `excerpt`（逐字引用那一格本身就是被引原文）。
  const runs = new Set();
  for (const m of text.matchAll(/[「『“"']([^」』”"']{1,32})[」』”"']/g)) {
    for (const r of cjkRunsOf(m[1])) runs.add(r);
  }
  for (const r of cjkRunsOf(String(f?.excerpt ?? ''))) runs.add(r);
  return { claimed: true, runs: [...runs], text, why: '声称画面上有非英文文字' };
}

/** 画面读数这一侧有没有**确认**（读数自己报了中文脚本，或读数里明写看到了汉字）。 */
export function sceneConfirms(evidence = {}) {
  // ⚠️ 判据**不许**写成「读数里有汉字」—— 画面读数的正文**本来就是中文写的**
  //   （「机器正面有文字，认不清」），拿 CJK 去测等于恒真，闸门会当场变成砖头。
  //   只认两种**明确的**说法：`text_script` 落在「中文 / 中英混排」，或读数里
  //   明写「中文 / 汉字 / 中英混排」这几个词。
  //   （这一条是自证 G1c 当场抓出来的：第一版用 CJK_RE，真单**没降级**。）
  const SCRIPT_CONFIRM = /中文|中英混排/;
  for (const s of evidence.sceneScripts ?? []) {
    if (SCRIPT_CONFIRM.test(String(s ?? ''))) return true;
  }
  const WORD_CONFIRM = /中文|汉字|漢字|中英混排/;
  for (const t of evidence.sceneTexts ?? []) {
    if (WORD_CONFIRM.test(String(t ?? ''))) return true;
  }
  return false;
}

/**
 * OCR 这一侧有没有**确认**：条目引的那串汉字，必须**逐字出现在本次 OCR 结果里**，
 * 且那一行置信度 `>= minConf`。没有引用具体字串时（只说"图上有中文"），
 * 要求 OCR 结果里**存在**一行含汉字且置信度够高。
 */
export function ocrConfirms(claim, evidence = {}, { minConf = MIN_CONF } = {}) {
  const lines = (evidence.ocrLines ?? []).map((l) => ({
    t: String(l?.t ?? ''), c: Number.isFinite(l?.c) ? l.c : null,
  })).filter((l) => l.t.trim() !== '');
  if (!lines.length) return false;
  const ok = (l) => l.c !== null && l.c >= minConf;
  const runs = claim?.runs ?? [];
  if (runs.length) return runs.some((r) => lines.some((l) => ok(l) && l.t.includes(r)));
  return lines.some((l) => ok(l) && CJK_RE.test(l.t));
}

/** 这一条为什么被降级（写给人看的一句话，含两个数：置信度与画面层说了什么）。 */
function whyOf(claim, evidence = {}) {
  const lines = evidence.ocrLines ?? [];
  const hit = lines.filter((l) => (claim.runs.length
    ? claim.runs.some((r) => String(l?.t ?? '').includes(r))
    : CJK_RE.test(String(l?.t ?? ''))));
  const conf = hit.map((l) => (Number.isFinite(l?.c) ? l.c : '—')).join('/') || '（本次 OCR 里没有这串字）';
  const scene = (evidence.sceneTexts ?? []).length
    ? '画面读数**没有**报出中文（它看到的文字脚本不作为"中文"的证据）'
    : '这一单**没有**画面读数（画面层没跑或没读到）';
  const runs = claim.runs.length ? claim.runs.map((r) => `「${r}」`).join('') : '（没有引用具体字串）';
  return `引用的汉字 ${runs} 在本次 OCR 里的置信度 ${conf}（< 认定下限 ${MIN_CONF}）；${scene}`;
}

/**
 * 过闸。**纯函数**：喂夹具就能断言，不联网、不调模型。
 *
 * @param {Array} items 合并后的条目（形如 `{location, category, severity, reason, excerpt, ...}`）
 * @param {{ocrLines?:Array<{t:string,c:number|null}>, sceneTexts?:string[]}} evidence
 * @returns {{kept:Array, downgraded:Array<{item:object, why:string, runs:string[]}>,
 *            applied:boolean, note:string}}
 */
export function gateFindings(items = [], evidence = {}, opts = {}) {
  try {
    const list = Array.isArray(items) ? items : [];
    // 边界：这一单压根没有本机 OCR 读数 ⇒ 闸门整体不生效（见文件头第①条边界）。
    if (!(evidence?.ocrLines ?? []).length) {
      return { kept: list, downgraded: [], applied: false,
               note: '本单没有本机 OCR 读数（没送图/视频，或 OCR 全失败）⇒ 闸门不生效' };
    }
    const kept = []; const downgraded = [];
    for (const f of list) {
      const c = claimOf(f);
      if (!c.claimed) { kept.push(f); continue; }
      if (sceneConfirms(evidence) || ocrConfirms(c, evidence, opts)) { kept.push(f); continue; }
      downgraded.push({ item: f, why: whyOf(c, evidence), runs: c.runs });
    }
    return { kept, downgraded, applied: true,
             note: downgraded.length ? `降级 ${downgraded.length} 条` : '没有需要降级的条目' };
  } catch (e) {
    // 闸门自己坏了 ⇒ 原样放行 + 出声（**绝不把整单结论带下水**）。
    return { kept: Array.isArray(items) ? items : [], downgraded: [], applied: false,
             note: `闸门自身异常，已原样放行：${e?.message ?? e}` };
  }
}

/**
 * 从 `inbound` 里收证据（**唯一取数口** —— 别在调用方各拼一份）。
 * 图片：`boxes`（含 `c`）＋ `scene`；视频：每一帧的 `boxes`（含 `c`）＋ `frameScene`。
 */
export function evidenceOf(inbound) {
  const ocrLines = []; const sceneTexts = []; const sceneScripts = [];
  const pushScene = (sc) => {
    if (!sc?.ok) return;                       // 「没读到」不进证据（它什么都没说）
    const s = sc.scene ?? {};
    if (s.text_script && s.text_script !== '未给') sceneScripts.push(String(s.text_script));
    for (const arr of [s.visible_marks, s.risk_cues, s.unclear]) {
      for (const x of arr ?? []) sceneTexts.push(String(x));
    }
  };
  for (const i of inbound?.images ?? []) {
    for (const b of i?.boxes ?? []) ocrLines.push({ t: String(b?.t ?? ''), c: Number.isFinite(b?.c) ? b.c : null });
    pushScene(i?.scene);
  }
  for (const v of inbound?.videos ?? []) {
    for (const f of v?.frames ?? []) {
      for (const b of f?.boxes ?? []) ocrLines.push({ t: String(b?.t ?? ''), c: Number.isFinite(b?.c) ? b.c : null });
    }
    for (const s of v?.frameScene ?? []) pushScene(s);
  }
  return { ocrLines, sceneTexts, sceneScripts };
}

/* ───────────────────────────── 自证 ───────────────────────────── */

/** ★ 真单夹具：第 17 行那张图，OCR 与画面读数的**逐字原件**（2026-10-16 实测）。 */
export const FIXTURE_ROW17 = Object.freeze({
  ocrLines: [
    { t: '白', c: 0.3 }, { t: 'momcozY', c: 0.5 }, { t: 'Descaling Tabkots', c: 0.3 },
    { t: 'momCOZY', c: 0.3 }, { t: '嫩圈o', c: 0.3 }, { t: '了 3', c: 0.3 },
    { t: 'mOMCOZY', c: 0.5 }, { t: 'Detergent Tablets', c: 0.5 },
  ],
  // 画面读数（逐字，取自留底 merged-2026-10-16T02_14_24.725Z 的附录）
  sceneTexts: ['机器正面有文字，认不清', '黑色面板上有数字与图标，认不清', '纸盒与袋装上有文字，认不清',
               '文字逐字内容', '是否含婴幼儿出镜'],
  sceneScripts: ['无法辨认'],
  item: {
    location: '图 1 图内文字（OCR 读出的「嫩圈o」「白」等中文字样）',
    category: '本地化', severity: 'REVIEW',
    reason: '这是挂在美国站的商品图，图上出现了中文（OCR 逐行读出「白」「嫩圈o」等中文字样），'
      + '而画面读数确认纸盒与袋装上有文字但认不清；同一张图里又混有英文「Detergent Tablets / Descaling Tablets」。',
    excerpt: '',
    suggestion: '把图上中文元素替换为对应的英文，例如把「嫩圈o」所在的中文标签整块换成英文品名。',
  },
});

export function selftest() {
  const res = [];
  const eq = (id, got, want) => res.push({ id, ok: JSON.stringify(got) === JSON.stringify(want), got, want });

  const F = FIXTURE_ROW17;

  // ── G1 真单：噪声汉字必须过不了闸（这一条就是 Owner 问的那一行）──────────────
  {
    const c = claimOf(F.item);
    eq('G1a 真单：认得出这是「画面上的非英文文字」声称', [c.claimed, c.why], [true, '声称画面上有非英文文字']);
    eq('G1b 真单：引用到的汉字串被取出来（「嫩圈o」→ 嫩圈；「白」→ 白）', c.runs.sort(), ['嫩圈', '白'].sort());
    const g = gateFindings([F.item], F);
    eq('G1c 真单：两条判据都不成立 ⇒ **降级 1 条、保留 0 条**',
       [g.applied, g.kept.length, g.downgraded.length], [true, 0, 1]);
    eq('G1d 真单：降级理由里要写清置信度（0.3）与画面层说了什么',
       [/0\.3/.test(g.downgraded[0].why), /画面读数\*\*没有\*\*报出中文/.test(g.downgraded[0].why)], [true, true]);
  }

  // ── G2 反向对照①：同一张图，**画面层真报出中文** ⇒ 必须保留（闸门不是砖头）──────
  {
    const g = gateFindings([F.item], { ...F, sceneScripts: ['中文'] });
    eq('G2a 画面层报 text_script=中文 ⇒ 保留，不降级', [g.kept.length, g.downgraded.length], [1, 0]);
    const g2 = gateFindings([F.item], { ...F, sceneTexts: ['袋装右上角印有汉字'], sceneScripts: ['未给'] });
    eq('G2b 画面读数正文里出现汉字 ⇒ 保留（一等证据）', [g2.kept.length, g2.downgraded.length], [1, 0]);
  }

  // ── G3 反向对照②：**真读出来的**中文（置信度够）⇒ 必须保留 ───────────────────
  {
    const ev = { ...F, ocrLines: F.ocrLines.map((l) => (l.t === '嫩圈o' ? { t: '嫩圈', c: 0.86 } : l)) };
    const g = gateFindings([F.item], ev);
    eq('G3a OCR 置信度 0.86 且逐字命中 ⇒ 保留', [g.kept.length, g.downgraded.length], [1, 0]);
    eq('G3b 同一份证据、把认定下限调到 0.9 ⇒ 又降级（证明这个数真的在起作用）',
       gateFindings([F.item], ev, { minConf: 0.9 }).downgraded.length, 1);
  }

  // ── G4 不许误伤：正文里的中文（没指向画面）⇒ 闸门根本不该碰 ──────────────────
  {
    const f = { location: '素材正文第 2 句', category: '本地化', severity: 'REVIEW',
                reason: '这条 listing 正文里写着中文「吸奶器」，美国消费者读不懂。', excerpt: '吸奶器' };
    const c = claimOf(f);
    eq('G4a 没指向画面 ⇒ 不触发（中文出现在正文里是本就可核的文字层）',
       [c.claimed, c.why], [false, '没有指向画面（图/画面/帧…）']);
    eq('G4b 过闸后原样保留', gateFindings([f], F).kept.length, 1);
  }

  // ── G5 边界：这一单没有本机 OCR 读数 ⇒ 闸门整体不生效（不许去拦别人的读数）──
  {
    const f = { location: '图 3 图内文字', category: '本地化', severity: 'REVIEW',
                reason: '图上出现中文字样。', excerpt: '' };
    const g = gateFindings([f], { ocrLines: [], sceneTexts: [] });
    eq('G5 没有 OCR 读数 ⇒ applied=false、原样放行、note 写明原因',
       [g.applied, g.kept.length, /没有本机 OCR 读数/.test(g.note)], [false, 1, true]);
  }

  // ── G6 视频帧：真字幕（置信度够）保留；帧上噪声降级 ───────────────────────────
  {
    const item = { location: '视频 00:12 画面字幕', category: '本地化', severity: 'REVIEW',
                   reason: '画面字幕是中文「限时优惠」。', excerpt: '' };
    const real = { ocrLines: [{ t: '限时优惠', c: 0.91 }], sceneTexts: [], sceneScripts: [] };
    const noise = { ocrLines: [{ t: '限时优惠', c: 0.3 }], sceneTexts: [], sceneScripts: ['英文'] };
    eq('G6a 帧上真字幕（c=0.91）⇒ 保留', gateFindings([item], real).kept.length, 1);
    eq('G6b 帧上同样两个字但 c=0.3 且画面层说英文 ⇒ 降级',
       gateFindings([item], noise).downgraded.length, 1);
  }

  // ── G7 只有一句"图上有中文"、没引用字串时，也要能判 ─────────────────────────
  {
    const item = { location: '主图', category: '本地化', severity: 'REVIEW',
                   reason: '主图上出现了中文字样。', excerpt: '' };
    eq('G7a 本次 OCR 里有高置信度汉字 ⇒ 保留',
       gateFindings([item], { ocrLines: [{ t: '吸奶器', c: 0.7 }], sceneTexts: [] }).kept.length, 1);
    eq('G7b 本次 OCR 里的汉字全是下限置信度 ⇒ 降级',
       gateFindings([item], { ocrLines: [{ t: '吸奶器', c: 0.3 }], sceneTexts: [] }).downgraded.length, 1);
  }

  // ── G8 接线自证：闸门必须**真的在链上**（拆掉它 ⇒ 这一条精确变红）────────────
  {
    const src = fs.readFileSync(path.join(import.meta.dirname, 'agent.mjs'), 'utf8');
    eq('G8a agent.mjs 里必须调用这把闸（否则它只是注释）',
       /ocrGate\.gateFindings\(/.test(src), true);
    eq('G8b 降级后的条目**不许**再进 `mergedState`（不计入问题数）',
       /mergedState\(\{ kbCovered:[\s\S]{0,200}merged: merged\.items/.test(src)
       && /merged\.items = gateRes\.kept/.test(src), true);
    eq('G8c 降级必须出声（日志里逐条可见，不许静默吞）', /🚦 汉字声称闸/.test(src), true);
  }

  // ── G9 闸门自身抛异常 ⇒ 原样放行并出声（不许把整单结论带下水）─────────────────
  {
    const boom = { get ocrLines() { throw new Error('桩：证据本身炸了'); } };
    const g = gateFindings([F.item], boom);
    eq('G9 证据读取抛异常 ⇒ applied=false 且原样放行', [g.applied, g.kept.length, /原样放行/.test(g.note)], [false, 1, true]);
  }

  const bad = res.filter((r) => !r.ok);
  for (const r of res) {
    console.log(`${r.ok ? '  ✅' : '  ❌'} ${r.id}${r.ok ? '' : `\n       got  = ${JSON.stringify(r.got)}\n       want = ${JSON.stringify(r.want)}`}`);
  }
  console.log(`\n${bad.length ? '❌' : '✅'} 汉字声称闸 ${res.length - bad.length}/${res.length} 项通过`);
  return bad.length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)
    && process.argv.includes('--selftest')) {
  process.exit(selftest() ? 1 : 0);
}

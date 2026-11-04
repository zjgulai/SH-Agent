/**
 * envelope.mjs —— 把「模型写的一段话」变成「一张卡」
 *
 * ── 为什么要有这一层，而不是让模型直接吐卡片 JSON ────────────────────────
 * 两个理由，第二个更要紧：
 *
 * 1. 让模型写完整的 V2 卡片 JSON，等于把「schema 2.0」「header.template 白名单」
 *    「V2 移除了 note」这些知识塞进每一次推理。它会在这些细节上犯错，
 *    而犯错的代价不是样式难看 —— 是**整条消息被服务端拒掉，回复凭空消失**。
 *
 * 2. 模版的真正作用是**约束内容**，不是换皮。`verdict` 只有一个格、
 *    结论只有一个格（`verdict`）—— 这些是槽位，不是建议。
 *    （`boundary` 那一格 2026-10-13 已整格作废，见下。）
 *    所以这一层必须真的把上限**执行**掉，而不是在注释里写「≤60 字」。
 *
 * ── 实测：上限原来一处在读吗 ───────────────────────────────────────────
 * 没有。cards.mjs 里 `VERDICT_MAX = 60`、`MAX_SECTIONS = 3`（`BOUNDARY_MAX` 2026-10-13 随
 * `boundary` 那一格一起作废）
 * 三个常量定义完之后，**整个仓库没有任何代码引用它们**（grep 只有定义行）。
 * 也就是说「结论 ≤60 字」此前是一句注释，模型写 300 字也照发。
 * 这一层就是它们唯一的执行点。
 *
 * ── 超长怎么处理：搬，不是砍 ───────────────────────────────────────────
 * 结论超过 60 字时**不截断**。截断会丢内容，而丢内容比格式难看严重得多。
 * 做法是把超出部分的整句搬到折叠区 —— 内容一个字不少，只是从
 * 「结论」那一格挪到了「边界」那一格。真搬不动了才降级成纯文本，
 * 并且降级理由写进正文（对方要能看出格式为什么变了）。
 */
import {
  BUILDERS, VERDICT_MAX, MAX_SECTIONS, collapsible,
  build, validateCard, renderText, BY_KIND,
} from './registry.mjs';
import { lintCopy } from './registry.mjs';
// ★ 2026-10-26（Owner：「守衡的回复没有按照 prd 和原先的输出模版来回复」）：
//   判定引擎的内部字段名（`label = …` / `layer = DP3` / `parse_status` / `coverage = partial`…）
//   在群与私聊里**一个都不许出现**。判据与清理都在 `jargon.mjs`（纯函数、单独自证）。
import { stripEngineJargon, scrubCardData } from './jargon.mjs';
// ★ 2026-10-15：对象 → 一行人话，**全仓只有这一份实现**（`cards.mjs::flat1`）。
//   原先这里自带一份（`${x.label}：${x.value}`），靠注释「改一处必须改两处」守着；
//   当天卡面修了、这里没修 ⇒ 换卡之后印九个 `undefined`（见 `carryCardText` 注释）。
//   import 方向是单向的：`cards.mjs` 不 import 本文件，不构成环。
import { flat1 } from './cards.mjs';

/** 卡片块的开头标记。选这个形态是因为它在 markdown 里不构成任何语法，误触概率低。 */
export const CARD_MARK = '[[card:';

const s = (x) => (x === null || x === undefined ? '' : String(x));

/** 长度按**字符**算，不是字节。中文一个字就是一个字。 */
const len = (x) => [...s(x)].length;

/* ═══════════════ ① 找块 ═══════════════ */

/**
 * 从回复里切出卡片块。
 *
 * 容错三件事，都是实测会遇到的：
 *   - 模型可能把整块包进 ```json 围栏
 *   - 块前后可能有多余空行或一句「（已整理成卡片）」
 *   - **块后面还有正文** —— 这是最危险的一种：如果只把标记去掉、正文留着，
 *     群里的表现就是「一张卡 + 一段重复的话」。所以前后文一律不信，
 *     只在块**就在回复里**的前提下，把前后文当作要并进折叠区的补充内容。
 *
 * ★ 坏 JSON 也必须报 `found`。
 *   第一版这里直接 return null，于是 `[[card:receipt]]\n{"title":` 这种
 *   截断输出会**原样漏进群里** —— 标记和半截 JSON 一起显示出来。
 *   实测用例逮到过（envelope 自测「坏 JSON」那条）。所以：只要看见标记，
 *   就算解析失败，也要把标记到结尾这段的位置报出来，供调用方剥干净。
 *
 * @returns {{kind:string, data:object|null, before:string, after:string,
 *            blockStart:number, blockEnd:number, error:string|null}|null}
 *          data 为 null 表示找到了块但解析失败，error 说明原因。
 */
/**
 * PRD §5.3 逐条块在卡面那一组的**组标题**（唯一真源）。
 *
 * ★ 判据要引它 —— `verify_cards.mjs` 的 J11b3 断言「组标题与组内容首行不许逐字相同」，
 *   两边必须是**同一个**字符串；判据里抄第二份字面量，改名那天判据就假绿了。
 * ★ 2026-10-16（FIX-033）：它同时是 `blockRows` 的去重依据（见下）。
 * ★★ 2026-10-21（Owner 给了正确模版）：它只用于 1–2 条那条逐条支。
 * ★★ 2026-10-26（Owner 贴出 10-21 成品，逐字：「这是我想要的输出模版」）：
 *   **两条支都用它** —— ≥3 的汇总块也折进这一组（`applyVerdictLine` 里那次
 *   「≥3 走 body」的改动已撤回）。依据是 Owner 贴的三段成品，每段第二行都是「逐条问题」。
 *   ⚠️ 10-21 台账里 ≥3 那两条（10:34:36 / 10:51:28）**没有**这一行 —— 两版都在，
 *     这里按「用户给的形状优先」定：卡上要看得见它。
 *   ⚠️ 这一行只进**卡面的组标题**；`verdict.block`（表行那一格的正文）里仍然没有它，
 *     `prd53_format` 的 ②b2/②f 判的就是块文本，不受影响。
 */
export const VERDICT_GROUP_TITLE = '逐条问题';

/**
 * 逐条块的**卡内版**：去掉开头那行结论行（它与卡抬头逐字相同）。
 *
 * ★★ 2026-10-14（Owner：「去掉『审查结论』多余的」）：抬头已经印了
 *   `【审查结论：BLOCK】共发现 N 处必须修改。`，而 `verdict.block` 的第一行**就是它**
 *   ⇒ 同一句在卡上出现两次。这里只去掉**那一行**，其余（汇总 / 链接 / 逐条 / 动作行）原样保留。
 *
 * ★★ 2026-10-16（FIX-033；Owner 原话：「出现了两个『逐条问题』定位下问题」）——
 *   **组内容的首行不许与组标题同名**。两条改动各自都对，叠在一起才出的问题：
 *     · 2026-10-14 组标题改成 `逐条问题` —— 那次治的是「组标题『审查结论』与块首行重复」；
 *     · 2026-10-15 ≥3 的块首行**也**变成 `逐条问题` —— Owner 给的 PRD §5.3.3 逐字格式件。
 *   ⇒ 而评审单卡面**恒定** `evidence`（`cardKind → evidence`，口径是 Owner 2026-10-13 那句
 *     「群里与私聊必须一样 ⇒ 卡面形状由代码定」）⇒ **每一张 ≥3 的评审卡**都连着印两个
 *     「逐条问题」。真单 `om_x100b6223f22efcacdff84ca547c51b4`（2026-10-16 01:20，
 *     台账 `PMO/logs/ws_outbound.jsonl` 第 1210 行；离线复原与该行 43 字逐字一致）。
 *
 *   ⚠️ 剥的判据是「**逐字等于组标题**」，不是「删掉『逐条问题』这四个字」——
 *     所以：1–2 条那条路（块首行是 `1.【合规】…`）一个字不动。
 *   ★★ 2026-10-21（Owner 正确模版）：**源侧已经不再产那一行了**（`dual_track.renderMerged`），
 *     这里保留去重是因为**存量的块**还带着它 —— 新旧块落到卡面上必须是同一个形状。
 *     现在「逐条问题」只出现在 **<3 那一条支的组标题**上，别处一个字都不该有。
 *   ⚠️ 不给 `title` ⇒ 一个字都不剥（默认无操作，老调用点行为不变）。
 *
 * ⚠️ 只动**卡面**：`verdict.block` 本身不改（报告、留痕、日志里仍是全份）——
 *   与「搬是搬，砍是砍」同一条纪律。
 * @param {string} block 结论块原文
 * @param {string|null} title 这一组要用的**组标题**（给了才去重）
 * @returns {string}
 */
/**
 * **这一块是不是「≥3 只出分类汇总」那一支**（PRD §5.3.2/§5.3.3）。
 *
 * ★★ 2026-10-21（Owner 给了正确模版 `docx/CvIldNhUSoxv7DxpzwdcKUcjnfr`）：
 *   ≥3 的块**不再折进一组**（那一组的标题会在群里印出一行模版里没有的字），
 *   直接作为卡片正文。判据只认**形状**，不认某一次输入：
 *     · 有 `· <类>类问题：N 个`（汇总行）／`·（本次没有并进任何逐条）`；
 *     · 且**没有**逐条条目（`1.【…】`）。
 *   ⚠️ 为什么用形状而不是加一个布尔参数：块是**从模型回复里抠出来的**（`conclusionBlock(answer)`），
 *     一路没有携带任何结构化标记 —— 加参数就得改五个调用点，而漏改一处就静默走错分支。
 */
export function isSummaryOnlyBlock(block) {
  const t = String(block ?? '');
  if (!t.trim()) return false;
  if (/^\s*\d+\s*[.、]\s*【/m.test(t)) return false;        // 逐条条目 ⇒ 不是汇总路
  return /^\s*·\s*(?:[^\n]*类问题|未归类问题)[：:]\s*\d+\s*个/m.test(t)
      || /^\s*·（本次没有并进任何逐条）/m.test(t);
}

export function blockRows(block, title = null) {
  const lines = String(block ?? '').split('\n');
  // 只认**第一行**是不是结论行（PRD §5.3 的形状），中间出现的三态词一律不动
  // ★ 2026-10-26：两种写法都认 —— `【X】`（PRD §5.3.4 字面，我们现在写这个）
  //   与 `【审查结论：X】`（旧字面，引擎答案与存量报告仍是它）。只认一种会把另一种当正文留在块里。
  const isHead = (l) => /^\s*(?:【审查结论\s*[：:]|【(?:PASS\+SUGGEST|PASS|REVIEW|BLOCK)】)/.test(l);
  const dropLeadingBlanks = () => { while (lines.length && !lines[0].trim()) lines.shift(); };
  dropLeadingBlanks();
  if (lines.length && isHead(lines[0])) lines.shift();
  dropLeadingBlanks();
  // ★ FIX-033：组标题已经承担了「逐条问题」这一行 —— 内容里再来一行就是同一个词印两遍
  if (title && lines.length && lines[0].trim() === String(title).trim()) {
    lines.shift();
    dropLeadingBlanks();
  }
  return lines.join('\n');
}

export function extractCardBlock(text) {
  const src = s(text);
  const at = src.indexOf(CARD_MARK);
  if (at < 0) return null;

  const afterMark = src.slice(at + CARD_MARK.length);
  const close = afterMark.indexOf(']]');
  if (close < 0) return null;                     // 连 `]]` 都没有 → 不是块，是普通文字
  const kind = afterMark.slice(0, close).trim();

  let rest = afterMark.slice(close + 2);
  rest = rest.replace(/^\s*```[a-zA-Z]*\s*/, '');        // 容忍 ```json 围栏
  const b0 = rest.indexOf('{');
  if (b0 < 0) {
    return { kind, data: null, before: src.slice(0, at).trim(), after: '',
             blockStart: at, blockEnd: src.length, error: '标记后没有对象' };
  }

  // 从 `{` 起做括号配对扫描。不能直接 indexOf('}')：
  // 卡片数据里几乎一定有 `{...}`（option、item、表头对象），会切在半路。
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = b0; i < rest.length; i++) {
    const ch = rest[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
  }

  // 括号没配上（截断输出）→ 块一直延伸到文本结尾
  if (end < 0) {
    return { kind, data: null, before: src.slice(0, at).trim(), after: '',
             blockStart: at, blockEnd: src.length, error: '对象括号没配平（多半是输出被截断）' };
  }

  let data;
  try { data = JSON.parse(rest.slice(b0, end + 1)); }
  catch (e) { data = null; if (!e) throw e; }

  // ★★ 2026-10-09：**闭合标记必须在这里剥干净**（实测缺陷，线上发过 6 张）──────────
  //   病灶：`[[card:receipt]]\n{…}\n[[/card]]` 解析出来的 `after` 是 **`[[/card]]`** ——
  //   它会被当成「**块外正文**」交给 `enforceLimits` 的 `extra`，而那个循环会把它
  //   **折进卡片的折叠组**（`foldIn`）⇒ 群里就出现一个内容写着 `[[/card]]` 的组。
  //   最小复现（9 行）：`extractCardBlock(RAW).after === '[[/card]]'`，而按 `blockEnd` 切
  //   只剩 `"\n[[/card]]"` —— 两个都说明**闭合标记没被计入块的结束位置**。
  //   线上证据：`ws_outbound.jsonl` 里 6 张卡（最近一张 2026-10-07 08:21）。
  //   修法两层（都要）：① `tail` 里显式剥掉闭合标记（容忍前后空白与 ``` 围栏）；
  //   ② 用**正确的 `blockEnd`** 复核 —— `blockEnd` 此前少了闭合标记的长度
  //      （`close + 2` 只到 kind 的 `]]`，没算 `[[/`）。它没有外部消费者，改它安全。
  // ⚠️ 两个基准别写错：`closeAt` / `end` / `b0` 都是**相对 `rest`**（`rest` 从 kind 的 `]]` 之后开始），
  //   而 `blockEnd` 是**相对 `src`** ⇒ 前缀 = `at + CARD_MARK.length + close + 2`。
  // ⚠️ 闭合标记是**恒定的 `[[/card]]`**，**不是** `[[/${kind}]]`（第一版就写错成后者：
  //   对 `[[card:receipt]]` 会去找 `[[/receipt]]` ⇒ 永远找不到 ⇒ `closeAt=-1` ⇒ 修了等于没修）。
  const srcPrefix = at + CARD_MARK.length + close + 2;
  const closeMark = '[[/card]]';
  const closeAt = rest.indexOf(closeMark, end + 1);
  const tail = (closeAt >= 0 ? rest.slice(end + 1, closeAt) : rest.slice(end + 1))
    .replace(/\s*```\s*$/, '')
    .replace(/^\s*```[a-zA-Z]*\s*/, '')
    .trim();
  const blockEnd = closeAt >= 0 ? srcPrefix + closeAt + closeMark.length : src.length;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { kind, data: null, before: src.slice(0, at).trim(), after: tail,
             blockStart: at, blockEnd, error: '对象不是合法 JSON 或不是对象' };
  }
  return { kind, data, before: src.slice(0, at).trim(), after: tail,
           blockStart: at, blockEnd, error: null };
}

/* ═══════════════ ①b PRD §5.3 结论行的执行点 ═══════════════ */

/**
 * 这张卡的「结论格」是哪个字段 —— `title` 优先，退到 `verdict`，都没有就 `null`。
 *
 * ★ 判据按**各类型真实的字段表**（`registry.BY_KIND`）来，不是想当然一律填 `verdict`：
 *   `correction` / `capability-boundary` / `find-nothing` / `alert` / `decision`
 *   这五个类型**两个字段都没有**，硬塞进去的内容会静默消失 ——
 *   同 `FOLD_FIELD` 那条教训（「写了但没人读的字段 = 假槽位」）。
 *
 * 为什么 `title` 优先：PRD §5.3 的结论行是**一条结论**，而 `title` 是对方一眼先看到的
 * 那个格子（`contract.md`：「写结论本身，不写『关于 X 的答复』」）。
 * `evidence` 这类没有 `title` 的类型，结论格就是 `verdict`。
 */
/**
 * 卡面上**确实有 title 格、但注册表不该在 `fields` 里申报**的那几种。
 *
 * ★ 2026-10-06 加：这五种（`correction` / `capability-boundary` / `find-nothing` /
 *   `alert` / `decision`）的构造器**一直在写 title**（`s(d.title ?? '默认')`），
 *   而注册表的 `fields` 只列**模型可以填**的格 —— 它们的 title 是**代码写的**，
 *   所以没申报。后果：`verdictSlotOf()` 找不到结论格 ⇒
 *   **PRD §5.3 结论行无处安放**（实测：模型挑 `find-nothing` 时日志里就是 `落点=no-slot`）。
 *
 *   第一版我把 `title` 加进了 `fields` —— 那是错的：`fields` 会进模型可见的提示词，
 *   一加就有两处变红（`K5 提示词长度`超预算、`I 段`文档项数对不上），
 *   而且等于告诉模型「你给 `find-nothing` 卡写个标题吧」，与「模型不写结论行」相反。
 *   所以这里单独一张表：**进的是落点判据，不进提示词**。
 */
const CODE_WRITTEN_TITLE = new Set([
  'correction', 'capability-boundary', 'find-nothing', 'alert', 'decision',
  // ★ 2026-10-06 第二批（Owner：「title 格补给所有卡片类型」）：
  //   这四种的 `fields` 里有 `verdict`（模型写结论的那一格），于是 `verdictSlotOf`
  //   先命中了 `verdict` ⇒ **PRD §5.3 结论行落到正文第一行、抬头仍是模型自拟的**。
  //   实测就是这两天的真单：模型挑了 `evidence`，抬头没换。
  //   而它们的构造器**同样一直在写 title**（`s(d.title ?? '证据')`）——
  //   抬头存在、只是没申报。补的是**漏报**，不是新造格子。
  'cannot-read', 'receipt', 'turn-diff', 'evidence',
]);

export function verdictSlotOf(kind) {
  const fields = BY_KIND.get(kind)?.fields;
  if (!fields) return null;
  // ★ 顺序即语义：**抬头优先**。
  //   卡面只要有抬头就用抬头 —— 它是这张卡上唯一的「最前面」，
  //   而 PRD §5.3 要的正是「结论行排在最前面」（§5.3 的示例全是抬头那一行）。
  //   旧顺序（先判 `fields` 里的 title、再判 verdict）会让「有 verdict 没申报 title」
  //   的四种卡片把结论行放到正文去 —— 那不是格式问题，是**位置**问题：
  //   业务同事扫一眼看到的是抬头，抬头不对，等于没看到结论。
  if ('title' in fields || CODE_WRITTEN_TITLE.has(kind)) return 'title';
  if ('verdict' in fields) return 'verdict';
  return null;
}

/**
 * **PRD §5.3 结论行的执行点**：把权威结论行搬进这张卡的结论格。
 *
 * ── 为什么要有这一步（2026-10-06）
 *
 * 上游 2026-09-22 给 §5.3 加了 `【审查结论：…】` 标记，当天那份改动登记就把
 * 「要不要落进回复卡片模版？」挂在第 317 行、**没有改任何代码**。半个月后 Owner 在群里
 * 看到的就是它的后果：链路侧按 5.3 产出了结论行、注入语也写了「逐字转述不许改写」，
 * **而回卡片那一跳把表头改写掉了** —— 于是「逐字转述」这四个字在盘上**没有任何执行点**。
 *
 * 现在它有了：结论行的唯一出处是链（或 P0 快路的派生），模型的措辞不再参与这一格。
 * 同 `AGENTS.md` §2.5 的既有分工 —— **模型不写卡片 JSON，也不写结论行**。
 *
 * ── 三个不变量
 *
 *   ① **不许编**：没有权威结论行就**一个字符都不动**（`null` 输入 → `action:'none'`）。
 *      给闲聊硬加一句「【审查结论：PASS】」比格式难看严重得多。
 *   ② **搬不是砍**：模型原来写在结论格里的那句话**进折叠区**，不丢。
 *      （实测那三条里，① 的「但『未命中 ≠ 合规』」正是写在 title 里的边界话，
 *        直接覆盖就把它删了。）
 *   ③ **格子合不上就出声**：类型没有结论格（`slot === null`）或结论行超过该格上限时，
 *      返回 `action:'no-slot'` / `'too-long'` —— 由调用方记读数，**不许静默放过**。
 *
 * @param {string} kind
 * @param {object} data 已经过 `enforceLimits` 的卡片数据（本函数会返回新对象，不改原对象）
 * @param {{state:string,line:string,from:string}|null} verdict
 * @returns {{data:object, action:'none'|'already'|'forced'|'no-slot'|'too-long',
 *            slot:string|null, moved:object|null, why:string}}
 */
export function applyVerdictLine(kind, data, verdict) {
  const none = (why) => ({ data, action: 'none', slot: null, moved: null, why, block: null });
  if (!verdict || !verdict.line) return none('这一轮没有权威结论行（不是送审，或链没给三态）');

  // ── 逐条块：**与结论行同一条分工** —— 模型不写，代码搬（2026-10-06 加）。
  //    Owner 拿 PRD §5.3.3 模板对照实发的 BLOCK 卡片：抬头对、**逐条四要素整块没有**。
  //    根因是正文由模型转述，而它会把一整块逐条压成一句「命中两条 P0，不能发」。
  //    ⚠️ 这一步必须在**结论格那几条提前 return 之前**就算出来 ——
  //    否则「标题恰好已经对了」（action=already）那条路会把块整个漏掉。
  const withBlock = (r) => {
    if (!verdict.block) return { ...r, block: null };
    const bs = blockSlotOf(kind);
    if (!bs) return { ...r, block: { action: 'no-slot', why: `「${kind}」没有能放逐条块的格` } };
    const out = { ...r.data };
    if (bs === 'reasoning') {
      const cur = s(out.reasoning);
      if (cur.includes(verdict.block)) return { ...r, block: { action: 'already', slot: bs } };
      out.reasoning = cur ? `${verdict.block}\n\n${cur}` : verdict.block;
      return { ...r, data: out, block: { action: 'forced', slot: bs } };
    }
    // `groups` 型（如 evidence 卡）：块作为**第一组**，默认展开 —— 它是这条结论的正文，不是附录。
    const groups = Array.isArray(out.groups) ? out.groups : [];
    // ══════════════════════════════════════════════════════════════════════════
    // ★★ 2026-10-26（Owner 贴了 10-21 的成品，逐字说「这是我想要的输出模版」）：
    //   **≥3 的汇总块也折进「逐条问题」这一组**，与 1–2 条那条支同形。
    // ══════════════════════════════════════════════════════════════════════════
    //   走过一次回头路，两次都对着**同一份模版**，结论相反 —— 记在这里免得再翻第三次：
    //     · 2026-10-21 晚上：把 ≥3 从组里挪进 `body`，理由是「模版里结论行**直接**接
    //       `· …类问题：N 个`，中间那行 `逐条问题` 是折叠标题带来的多余一行」；
    //     · 2026-10-26：Owner 贴的三段成品（1 条 / 2 条 / 3 条）**每一段都有这一行**，
    //       并且明确说这就是他要的模版 ⇒ 改回折叠组。
    //   ⚠️ 谁的账都对得上：**10-21 台账里 ≥3 那两条（10:34:36 / 10:51:28）确实没有这一行**，
    //     所以「10-21 的输出」到底指哪一版，Owner 手上那份与我查到的台账并不完全一致。
    //     按「用户给的形状优先」落：**卡上要看得见「逐条问题」**。
    //   ⚠️ 只动**卡面包装**：`verdict.block` 一个字没动 ⇒ 表行那一格（`rendered.block`）
    //     与 `prd53_format` 的 ②b2/②f 判据都不受影响，那条判的是**块文本**里的那一行。
    //   ⚠️ 剥标题仍传 `VERDICT_GROUP_TITLE`：历史块里可能还带着那一行（存量），
    //     按「逐字等于组标题」剥掉，所以新旧块落到卡面上**同一个形状**。
    const existingBlockIdx = groups.findIndex((g) => String(g?.content ?? '').includes(verdict.block));
    if (existingBlockIdx >= 0) {
      // 结论块可能已由模型放进 groups。默认 groups 是折叠的；若这里直接 early-return，
      // 群里只显示结论数字，逐条问题和知识库建议就只能手动点开。命中结论块的组是正文，
      // 必须展开；其它组仍保留原状态。
      const visibleGroups = groups.map((g, i) => i === existingBlockIdx ? { ...g, expanded: true } : g);
      return { ...r, data: { ...out, groups: visibleGroups }, block: { action: 'already', slot: bs } };
    }
    // ★ 2026-10-08 两处改动（Owner：「PRD §5.3 结论块 · 0 是什么意思？**为什么要带 prd**？」）：
    //   ① **不再给 `count: 0`** —— 那是漏填的占位，印出来是「· 0」，而同一块正文写着
    //      「共发现 3 处必须修改」⇒ 标题说 0、正文说 3（10/07–10/08 连发多张卡）。
    //      `cards.mjs` 已改成"有才拼"。条数**只在有结构化真值时才给**
    //      （P0 快路那条在 `prd53.deriveVerdictLine` 里是 `matched_patterns`）；
    //      这里拿不到结构化条数 ⇒ **不给** —— 绝不回头去正则抠那段中文
    //      （库规：库侧的结论与条数一律读结构化字段，不许从中文答案里抠）。
    //   ② 标题去掉内部章节号 —— 这张卡是给业务同事看的，**「PRD §5.3」对他们是零信息量**。
    //      格式仍由 PRD §5.3 规定；要追溯出处看日志里的 `block.action`，不必印在卡面上。
    // ★★ 2026-10-14（Owner：「去掉『审查结论』多余的」）—— 两处重复，一处修：
    //   ① **组标题**原先叫「审查结论」，而块的第一行**本身就是** `【审查结论：BLOCK】…`
    //      ⇒ 卡上连着出现两个「审查结论」。
    //   ② **块里的结论行**与卡抬头（`applyVerdictLine` 写的那一行）**逐字相同**
    //      ⇒ 同一句出现两次（抬头一次、第一组首行一次）。
    //   ⇒ 组标题改成描述**这一组装什么**（`逐条问题`），块去掉开头那行结论行 ——
    //     结论行由**抬头**独占。⚠️ 块本身一个字不丢（只去重），报告与留痕里仍是全份。
    // ★★ 2026-10-16（FIX-033）：组标题与组内容**必须一起给** ——
    //   `blockRows` 按这个标题去重（组里再印一遍就是两个「逐条问题」）。
    //   两处各自写一个字面量是这次缺陷的温床：改名时只改一边，重复就回来了。
    out.groups = [{ title: VERDICT_GROUP_TITLE, content: blockRows(verdict.block, VERDICT_GROUP_TITLE),
                    expanded: true }, ...groups];
    return { ...r, data: out, block: { action: 'forced', slot: bs } };
  };

  const slot = verdictSlotOf(kind);
  if (!slot) {
    return withBlock({ data, action: 'no-slot', slot: null, moved: null,
                       why: `「${kind}」没有结论格（既无 title 也无 verdict）—— 结论行无处安放` });
  }

  const cur = s(data[slot]).trim();
  if (cur === verdict.line) {
    return withBlock({ data, action: 'already', slot, moved: null, why: '结论格已经是这一行' });
  }

  // 结论行超过该格的硬上限 ⇒ 不硬塞（塞进去会被 enforceLimits 搬走，反而更乱）。
  const cap = slot === 'verdict' ? VERDICT_MAX : Infinity;
  if (len(verdict.line) > cap) {
    return withBlock({ data, action: 'too-long', slot, moved: null,
                       why: `结论行 ${len(verdict.line)} 字 > ${slot} 的上限 ${cap} 字` });
  }

  // ① 先把模型原来那句搬进折叠区（**搬不是砍**），② 再落权威结论行。
  //
  // ★★ 2026-10-09（Owner：「prd 没说要『原始回答（原「data-table」卡，逐字搬）』，
  //    现在输出的有，可考虑去掉」）——
  //    这三处折叠组的标题原先写的是**本仓的内部动作**（换了哪张卡、哪一行被替换），
  //    对群里的人是**零信息量**，而且「data-table / receipt」是**内部类型名**。
  //    口径：**内容一个字不丢，标题只说"这是什么"**。
  //    —— 保留「原文照留」这四个字，是因为它承担一个真实语义：
  //       读者得知道**下面这段不是权威结论、是模型原话**（否则两段话看起来像两个结论）。
  let out = { ...data };
  let moved = null;
  if (cur) {
    const [folded, to] = foldIn(kind, { ...out, [slot]: '' },
      `（原文照留：这一段是模型原话，**不是**下方权威结论）\n${data[slot]}`);
    if (to) {
      out = folded;
      moved = { field: slot, to, chars: len(data[slot]), why: `原结论搬进 ${to}` };
    } else {
      // 这个类型没有折叠区、也没有兜底正文格 —— **宁可不换**，也不丢掉模型那句话。
      return withBlock({ data, action: 'no-slot', slot, moved: null,
                         why: `「${kind}」无折叠区可安置原结论，换掉就会丢内容 ⇒ 不换` });
    }
  }
  out[slot] = verdict.line;
  return withBlock({ data: out, action: 'forced', slot, moved, why: `结论行来自 ${verdict.from}` });
}

/**
 * 字段名 → 中文标签（**换卡**时把内容逐字搬过去用）。认不出的字段就用**原名**——
 * 不猜含义、不改写内容：这一步是搬迁，不是改写。
 */
const FIELD_ZH = {
  title: '标题', subtitle: '副标题', verdict: '结论', reasoning: '正文', groups: '分组',
  before: '上一次', after: '这一次', cause: '为什么变', wrong: '错在哪', right: '正确说法',
  can: '能做到', limited: '受限', cannot: '做不到', item: '对象', why: '原因',
  alternative: '替代方案', note: '备注', paths: '可查路径', tried: '试过哪些',
  nextStep: '下一步', what: '发生了什么', impact: '影响', internal: '内部详情', retry: '重试方式',
  ask: '在问什么', options: '选项', recommend: '推荐', evidence: '证据',
  columns: '列', rows: '行', fields: '补充',
};

/**
 * 把一张卡的数据**逐字摊成文字** —— 换卡片类型时用（内容一个字不丢，换的只是外壳）。
 * 与 `foldIn` 的分工：那个是把溢出折进折叠区；这个是**跨类型搬迁**。
 *
 * ★ 2026-10-15：对象摊平**改用 `cards.mjs::flat1`**（全仓唯一实现）。
 *   本条原先自带一份 label 分支（`${x.label}：${x.value}`），与卡面那份是
 *   「同一套写法，改一处必须改两处」—— 当天就守输了：卡面读 `v.value` 印了
 *   九个 `（未填）`（真单 16:24），这条照旧读 `x.value`，模型给的 `{label, note}`
 *   搬过去印九个 `undefined`。而且 `verify_cards` **317 项全绿**：
 *   那个脚本里 `carryCardText` 只出现在注释里，**从来没有一条判据调用过它**。
 *   ⇒ 病根是「同一个口径两处实现 ＋ 判据只盖住其中一处」，治法是不再有两处。
 */
export function carryCardText(data) {
  if (!data || typeof data !== 'object') return '';
  const out = [];
  for (const [k, v] of Object.entries(data)) {
    if (v == null || s(v).trim() === '') continue;
    const label = FIELD_ZH[k] ?? k;
    if (Array.isArray(v)) {
      const lines = v.map((x) => (x && typeof x === 'object' ? flat1(x) : String(x)))
        .filter((t) => t && s(t).trim());
      if (lines.length) out.push(`${label}：\n${lines.join('\n')}`);
      continue;
    }
    // ★ 非数组的对象值也走 `flat1`：旧写法 `s(v)` 就是 `String(v)`，
    //   给它一个对象照样是 `[object Object]`（卡面那条路 2026-10-14 修的就是它）。
    //   摊平后为空（`{能力:'', 边界:''}` 这种）**整条不留残句** —— 与 `kv()` 同口径。
    const t = flat1(v).trim();
    if (t) out.push(`${label}：${t}`);
  }
  return out.join('\n');
}

/**
 * 逐条块放哪个格 —— `reasoning` 优先，退到 `groups`，都没有就 `null`（要出声）。
 * 同 `verdictSlotOf` 的纪律：按**各类型真实的字段表**判，不硬塞一个不存在的字段。
 */
export function blockSlotOf(kind) {
  const fields = BY_KIND.get(kind)?.fields;
  if (!fields) return null;
  if ('reasoning' in fields) return 'reasoning';
  if ('groups' in fields) return 'groups';
  return null;
}

/* ═══════════════ ② 执行上限 ═══════════════ */

/**
 * 每个类型的折叠区在哪个字段。
 *
 * 这个表必须按**构造器实际读的字段**来定，不能想当然填 `evidence` ——
 * 第一版就是一律填 `evidence`，结果 `cannot-read`/`decision`/`data-table`
 * 根本没有这个字段，塞进去的内容**静默消失**（J4 用例逮到）。
 * 「写了但没人读的字段 = 假槽位」，这条规矩对信封层同样成立。
 *
 * `null` 表示这个类型没有折叠区，只能落回正文格（见 foldIn）。
 */
const FOLD_FIELD = {
  'query-answer': 'evidence',
  // ★ 2026-10-06 修：这里原来写的是 `'evidence': 'evidence'` —— **该卡没有 `evidence` 这个字段**
  //   （它的字段是 `verdict` / `groups` / `fields`）。于是 `foldIn` 把内容写进
  //   一个**没人渲染的字段**里 ⇒ **静默丢内容**，而它还返回了一个「落到了 evidence」的读数。
  //   这条陈旧条目一直没被发现，因为此前没有任何路径让 `evidence` 卡走到 `foldIn`
  //   —— 直到 2026-10-06 把结论行的落点改成「抬头优先」，它必然要折一次原抬头。
  //   逮到它的是 `W5c`（行为级：不只看判据，看**建出来的那张卡**）。
  'evidence': 'groups',                // groups 是主体，额外内容作为**一组**追加（见 FOLD_GROUPS）
  'capability-boundary': 'evidence',
  'find-nothing': 'tried',
  'alert': 'internal',
  'data-table': 'note',
  'receipt': 'note',
  'turn-diff': null,                   // 没有折叠区
  'correction': null,
  'cannot-read': null,
  'decision': null,
};

/** 没有折叠区时，退回哪个正文格。都是「本来就在说补充信息」的格子。 */
const FALLBACK_SLOT = {
  'turn-diff': 'cause',
  'correction': 'cause',
  'cannot-read': 'why',
  'decision': 'ask',
  'receipt': 'note',
  'data-table': 'note',
};

/**
 * 折叠字段里哪几个是**数组**。
 *
 * ★ 2026-10-06：这张表是被一次真崩溃逼出来的，不是设计出来的。
 *   `foldIn` 原来的判据是 `Array.isArray(d[field])` —— 也就是说**字段类型由「模型有没有给」决定**：
 *   模型给了数组就按数组追加，没给就写成字符串。而 `query-answer` 的构造器是
 *   `d.evidence.join('\n')`（`cards.mjs:193`）⇒ **模型没给 `evidence` 时，一次折叠就把卡片建崩**：
 *   `d.evidence.join is not a function`。后果不是格式难看，是**整张卡降级成纯文本**
 *   （`toCardOrText` 的 `reason` 里写着原因）。
 *
 *   逮到它的是 `tools/test_agent.mjs` 第 20 组 W3 —— 加 PRD §5.3 结论行时第一次真的走到那一步
 *   （结论行要先把原来的 title 折进折叠区，于是必然触发一次 `foldIn`）。
 *   **这条路径一直都在，只是此前没有任何用例把「模型不给 evidence」和「块外有正文」凑到一起。**
 */
const FOLD_IS_ARRAY = new Set(['query-answer']);

/**
 * 折叠目标是**对象数组**（形如 `[{title, content, count, expanded}]`）的类型。
 *
 * ★ 不能并进 `FOLD_IS_ARRAY`：那个分支写的是 `[...cur, text]`，往对象数组里塞一个**字符串**
 *   会让 `capSections` / 构造器读到裸串 —— 那是另一种崩法。形状不同就分开两张表。
 */
const FOLD_GROUPS = new Set(['evidence']);

/**
 * 把一段没有专属格子的内容塞进这张卡。
 * 返回 [新 data, 实际落到的字段名 | null]。落到 null 表示确实没地方放。
 */
function foldIn(kind, d, text) {
  const field = FOLD_FIELD[kind];
  if (field) {
    if (FOLD_GROUPS.has(kind)) {
      const cur = Array.isArray(d[field]) ? d[field] : [];
      return [{ ...d, [field]: [...cur, { title: '（原文照留：模型原话，非权威结论）',
                                         content: text, expanded: false }] }, field];
    }
    if (FOLD_IS_ARRAY.has(kind)) {
      // 类型由**表**决定，不由模型给没给决定 —— 见上面那段。
      const cur = Array.isArray(d[field]) ? d[field] : (d[field] ? [d[field]] : []);
      return [{ ...d, [field]: [...cur, text] }, field];
    }
    return [{ ...d, [field]: d[field] ? `${d[field]}\n${text}` : text }, field];
  }
  const slot = FALLBACK_SLOT[kind];
  if (!slot) return [d, null];
  const cur = s(d[slot]);
  return [{ ...d, [slot]: cur ? `${cur}\n\n（补充）${text}` : `（补充）${text}` }, slot];
}

/**
 * 正文格里的内部记录：搬到折叠区。
 *
 * 为什么必须做这一步，而不是只靠 lint 报警：
 * `alert` 的 `what` / `impact` 是**公开展示**的格子，而默认的 what 文案
 * 是「刚才那条回复是故障输出」—— 模型把工具名写进 `what` 是很自然的事。
 * 2026-09-17 那条连列 27 次工具名的回复就是这么出来的。
 * 报警只能让维护者看见，搬走才能让对方看不见。
 *
 * 优先级：有折叠区就搬进去；没有折叠区（alert 一定有 internal）就交给调用方降级。
 */
const PUBLIC_FIELDS = [
  'title', 'verdict', 'reasoning', 'wrong', 'right', 'cause', 'what', 'impact',
  'ask', 'recommend', 'note', 'nextStep', 'why', 'alternative', 'before', 'after',
];

function scrubInternal(kind, d) {
  const moved = [];
  let out = { ...d };
  for (const f of PUBLIC_FIELDS) {
    if (!out[f]) continue;
    // ★ 判据只有一处：`lintCopy` 的 `internalLeak`（registry.mjs）。
    //   这里原先自带一条**更窄**的正则（少了栈帧与「连续同名工具 ≥3 次」），
    //   于是「检测器报了的，动作未必搬」—— 同一个概念两份判据，
    //   正是 §2.5「形态/判据只能有一处」要防的形状。现在只有一份。
    const hitLeak = lintCopy(s(out[f])).find((h) => h.id === 'internalLeak');
    if (!hitLeak) continue;
    const folded = out[f];
    const hit = foldIn(kind, { ...out, [f]: '' }, `（内部详情，排查用）\n${folded}`);
    if (hit[1] === null) continue;                       // 没地方放 → 留给降级处理
    out = hit[0];
    moved.push({ field: f, to: hit[1], chars: len(folded), why: `正文格 ${f} 里出现了内部标识，已搬进折叠区` });
  }
  return { data: out, moved };
}

/**
 * 把字段搬到它该在的格子里。返回改过的 data 和一份搬迁记录。
 *
 * 只处理「搬得动」的情况。搬不动的（比如 correction 的 wrong 太长）
 * 就原样留着 —— 那是模型说错了话，不是格式问题，硬掰只会掩盖。
 *
 * @param {string} kind
 * @param {object} data
 * @param {string[]} extra 卡片块之外的正文。不会丢，也不会重复出现在群里：
 *                         有折叠区就进折叠区，没有就进本类型的「补充」格。
 */
export function enforceLimits(kind, data, extra = []) {
  let d = { ...data };
  const moved = [];

  // 结论超长：按句切，前 VERDICT_MAX 字留结论，其余**搬进折叠区**。
  // ★ 2026-10-13：原先搬进 `boundary`，而 `boundary` 那一格已整格作废（不上卡）
  //   ⇒ 再往那儿搬就是**静默丢字**。改走 `foldIn`（与「边界超长」「字段超限」同一条路）。
  if (d.verdict && len(d.verdict) > VERDICT_MAX) {
    const chars = [...s(d.verdict)];
    // 优先在句号处断开，退而在上限处断 —— 但都要保证不丢字
    let cut = -1;
    for (let i = Math.min(VERDICT_MAX, chars.length - 1); i > VERDICT_MAX * 0.5; i--) {
      if ('。；！？\n'.includes(chars[i])) { cut = i + 1; break; }
    }
    if (cut < 0) cut = VERDICT_MAX;
    const head = chars.slice(0, cut).join('').trim();
    const spill = chars.slice(cut).join('').trim();
    if (spill) {
      d.verdict = head;
      const [nv, nto] = foldIn(kind, d, spill);
      d = nv;
      moved.push({ field: 'verdict', to: nto ?? '(无格可放)', chars: len(spill),
                   why: `结论超过 ${VERDICT_MAX} 字` });
    }
  }

  // 字段数超限：多出来的字段进折叠区，不丢
  const cap = { 'query-answer': 4, 'receipt': 3, 'data-table': 6 }[kind] ?? 6;
  if (Array.isArray(d.fields) && d.fields.length > cap) {
    const extraFields = d.fields.slice(cap);
    d.fields = d.fields.slice(0, cap);
    const [next, to] = foldIn(kind, d, extraFields.map((f) => `${f.label}：${f.value}`).join('\n'));
    d = next;
    moved.push({ field: 'fields', to: to ?? '(无格可放)', chars: extraFields.length, why: `字段超过 ${cap} 个` });
  }

  // 卡片块之外的正文：一条都不丢。
  for (const text of extra.filter(Boolean)) {
    const [next, to] = foldIn(kind, d, text);
    d = next;
    moved.push({
      field: '块外正文', to: to ?? '(无格可放)', chars: len(text),
      why: to ? `卡片块之外的正文已并入 ${to}` : '卡片块之外有正文，但这个类型没有能承载它的格子（已在日志记录，未发进群）',
    });
  }

  // 正文格里的内部记录 → 折叠区。放在最后，保证前面几轮搬进来的内容也被查一遍。
  const scrubbed = scrubInternal(kind, d);
  d = scrubbed.data;
  moved.push(...scrubbed.moved);

  return { data: d, moved };
}

/* ═══════════════ ②b 段落数上限 —— MAX_SECTIONS 的执行点 ═══════════════ */

/**
 * 卡片**顶层 markdown 块**超过 `MAX_SECTIONS` 时，把多出来的段落搬进折叠区。
 *
 * ★ 为什么在这里、而不在 `enforceLimits` 里：
 *   `enforceLimits` 作用在**数据**上（verdict / boundary 这些格子），
 *   而「顶层 markdown 块有几个」是**建出来的卡**才有的性质 ——
 *   同一个字段在不同卡片类型里可能进正文、也可能进字段表或折叠区。
 *   所以只能在 `build()` 之后数。
 *
 * ★ 口径（与 `cards.mjs` 里 `MAX_SECTIONS` 的注释同源 —— 改一处必须改两处）：
 *   只数 `body.elements` **顶层**的 `markdown`。
 *   `hr` 是分隔线、`collapsible_panel` 是收起区、`column_set` / 字段排是字段表，都不算段落。
 *
 * ★ 搬是搬，砍是砍：搬走的段落**一个字都不改**，整段进折叠区（§2.4）。
 *   丢内容比格式难看严重得多。
 *
 * @param {object} card 已建好的卡
 * @param {number} [max] 上限，默认取 MAX_SECTIONS
 * @returns {{card: object, moved: Array}} 未被改动时 `moved` 为空数组
 */
export function capSections(card, max = MAX_SECTIONS) {
  const els = card && card.body && card.body.elements;
  if (!Array.isArray(els)) return { card, moved: [] };

  const mdIdx = els
    .map((e, i) => (e && e.tag === 'markdown' ? i : -1))
    .filter((i) => i >= 0);
  if (mdIdx.length <= max) return { card, moved: [] };

  const overflowIdx = new Set(mdIdx.slice(max));
  const overflow = els.filter((_, i) => overflowIdx.has(i));
  const kept = els.filter((_, i) => !overflowIdx.has(i));
  kept.push(collapsible(`其余 ${overflow.length} 段（已折叠 · 防复读）`, overflow));

  return {
    card: { ...card, body: { ...card.body, elements: kept } },
    moved: overflow.map((e) => ({
      field: 'sections',
      to: 'collapsible',
      chars: len(e.content || ''),
      why: `顶层段落超过 ${max} 段，第 ${max + 1} 段起搬进折叠区`,
    })),
  };
}

/**
 * 纯文本路径的结论行：PRD §5.3 的结论必须**排在最前面**（PRD 原话「先把结论放在最前面」）。
 *
 * 幂等：文本里已经有这一行就一个字符都不动 —— 否则会变成「结论行 + 又一遍结论行」。
 * 没有结论行（不是送审）时 `verdict` 是 `null`，这里**加不了任何东西**（不许编）。
 */
function leadWithVerdict(text, verdict) {
  const body = s(text);
  if (!verdict || !verdict.line) return body;
  if (body.includes(verdict.line)) return body;
  return body ? `${verdict.line}\n\n${body}` : verdict.line;
}

/* ═══════════════ ③ 建卡 ═══════════════ */

/**
 * 回复文本 → 该发什么。
 *
 * 返回的 `mode` 只有两种，语义是**确定**的：
 *   'card' —— 有一张通过校验的卡，去发卡
 *   'text' —— 没有块（正常纯文本回复）、或块不可用。`reason` 说明是哪种。
 *
 * ★ 无论走哪条路，**mark 之后的内容永远不进正文**。
 *   泄漏一条 `[[card:...]]` 到群里，和泄漏一条 tool_calls 是同一类故障。
 *
 * @param {string} reply 模型给的回复原文
 * @returns {{mode:'card'|'text', card?:object, data?:object, kind?:string,
 *            text:string, reason:string|null, moved:Array, lint:Array, dropped:boolean}}
 */
/**
 * 「我读到了什么」搬进卡片正文**最前面**（2026-10-06 加）。
 *
 * ★ 为什么（Owner 原话：「视频还是无法读取」）：那次他发的 15 秒视频，内核**读成功了** ——
 *   8 帧全抽出来、OCR 成功、音轨确认没人说话 —— 而那三个读数**只进了日志**。
 *   卡片正文通篇在讲知识库自己的事（「覆盖判据不成立」「缺的是库覆盖，补素材无用」），
 *   **一句没讲他视频里有什么**。于是结论读起来就是「它没看我的视频」。
 *
 * 分工与结论行、逐条块**完全一样**：**模型不写，代码搬**。
 * 它排在正文最前面、结论行仍在**标题**里 —— 两样各占一格，谁也不挤谁。
 *
 * @returns {{data:object, action:'none'|'no-slot'|'already'|'forced', slot:string|null, why?:string}}
 */
export function applyMediaRead(kind, data, mediaRead) {
  // ══════════════════════════════════════════════════════════════════════════
  // ⚠️ **本函数当前不生效**（2026-10-13）—— 与 `dual_track.p0ShortReplyBlock` 同一个先例：
  //    **纯函数保留，接线撤了**。撤的理由是 Owner 当场给的原文：
  //    「（视频那一段）我读到了／视频 1 段｜读成功 1 · 失败 0／…／帧上文字：[00:04] …
  //      （共 8 帧有字，全文见报告附录「机读素材读数」）—— **这里多余的回复也去掉**」。
  //
  //    他自己引的就是这个函数的产物（`**我读到了**` ＋ 读数 ＋ 帧上文字预览）。
  //    ⇒ 媒材读数**不再上卡**。它一条都没丢，仍在三处：
  //      · `ws_daemon` 的日志（`📥 读到｜视频 1 段｜读成功 1 · 失败 0` —— 「我真读了」的凭证在那）；
  //      · 会话记忆（`chainBlock` 里的媒材块）；
  //      · **报告附录**「机读素材读数（全文，供回源核对）」（`agent.mediaReadAppendix`）。
  //
  //   ⚠️ 这条改的是 Owner 2026-10-06 的一条要求（「视频还是无法读取」→ 那时把读数搬上卡，
  //      因为卡上通篇在讲库自己的事、一句没讲他视频里有什么）。**两条要求指向相反**，
  //      以**最新这一条**为准；要恢复，把 `toCardOrText` 里那一行接线加回来即可。
  //   ⚠️ 恢复时请一并读 §J14 那组判据（卡面结构不许再被撑开）。
  // ══════════════════════════════════════════════════════════════════════════
  if (!mediaRead) return { data, action: 'none', slot: null, why: '这一轮没有媒材读数' };
  const block = `**我读到了**\n${String(mediaRead).trim()}`;
  const out = { ...data };
  const slot = ['verdict', 'reasoning', 'wrong', 'verdict_text']
    .find((k) => typeof out[k] === 'string');
  if (!slot) return { data, action: 'no-slot', slot: null, why: `「${kind}」没有能放读数的格` };
  if (String(out[slot]).includes('**我读到了**')) return { data, action: 'already', slot };
  out[slot] = out[slot] ? `${block}\n\n${out[slot]}` : block;
  return { data: out, action: 'forced', slot };
}

/**
 * 把**报告链接**放进卡片**可见格**（2026-10-09，Owner 第三次同一个反馈）。
 *
 * ── 为什么不能只放在结论块里
 *
 *   报告链接此前拼在 §5.3 结论块内部（先是在 8 条逐条之后，后挪到块的第 2 行），
 *   而**整块在卡片里是可收起的** —— 实测那张 8 处问题的卡，块被折成
 *   「（已收起 1 条证据：审查结论）」，链接**一个字都看不见**。
 *   从 Owner 的座位上，那就是「没有报告链接」—— 而盘上 docx 明明建好了
 *   （`📄 合并报告已建（问题数 8 ≥ 3）：…`）。
 *
 * ── 做法：与 `applyMediaRead` **完全同构**
 *
 *   把那一行搬进「可见的字符串格」（`verdict` / `reasoning` / `wrong` / `verdict_text`）。
 *   链接是**要人去点的动作**，它与「我读到了」同级 —— 都不该藏在折叠区里。
 *   §2.5：形态决策只有一处，所以这里只负责**搬**，不决定卡片类型。
 *
 * ★★ 2026-10-15（Owner 第 4 次同一个反馈，这次是**位置**不是「有没有」）─────────────
 *
 *   Owner 原话：「守衡中飞书群发放的卡片 review 1-2 个问题的内容：
 *     `→ 查看完整问题清单与修改建议：<docx>` —— **要放在「建议转xxx」上面，
 *     不要放在审查结论下面**」。
 *
 *   实测（离线复原真单 `om_x100b623f78cedcb0cfc77dcec593725` 那张 2 处问题的卡，
 *   `renderText` 与台账 121 字**逐字一致**）：
 *     · 抬头 = 结论行；`body[0]` = `markdown(→ 查看完整问题清单…)`；
 *       `body[1]` = `collapsible(逐条问题, expanded:true)`，**动作行在那一组的最末尾**。
 *   ⇒ 链接被插在**抬头正下方**（＝Owner 说的「审查结论下面」），而 PRD §5.3 的次序是
 *     `正文 → 链接 → 动作行`（`dual_track.renderMerged` 在 **≥3** 那一支已经是这么拼的，
 *     `prd53_format.test.mjs` ②c/②d 钉着）。⇒ 同一个链接，≥3 的单子位置对、1–2 的单子位置错。
 *
 *   为什么原先会走到可见格：那一跳（2026-10-09）治的是「链接落在**块的最末尾**、
 *   被 8 条逐条顶进折叠区」。但现在的块**本身就是逐条**，且那一组是
 *   `expanded: true`（`applyVerdictLine` 定的）⇒ **块内就是可见区**，
 *   两个诉求同时成立：链接在块里，且在**动作行之上的紧邻位置**。
 *
 *   ⇒ 次序：**先试「插进 §5.3 块的动作行之上」**，块里认不出动作行（没有块 /
 *     块被截断 / 非评审单）才退回可见格 —— 退回那条路一个字没动（J15b 钉着）。
 */
/**
 * §5.3 块的**动作行** —— PRD §5.3.2 的 `建议转 … 复核。` 与 §5.3.3 的
 * `请修改后重新提交。`。
 *
 * ★ 与 `agent/prd53.mjs::conclusionBlock` 认的是**同一行**（那边认「块的收尾在哪」、
 *   这边认「链接该插在哪」）—— 两处都在描述这一行的形状，改的时候**一起改**。
 *   多行模式（`m`）下按**行首**匹配：正文里提到「建议转人工」不算动作行。
 */
const ACTION_LINE_RE = /^(?:请修改后重新提交。|建议转[^\n]*复核。)[^\n]*$/m;

/**
 * 把**报告链接那一行**插到动作行之上的紧邻位置（纯函数，可离线断言）。
 *
 * PRD §5.3.2 / §5.3.3 的次序是 `正文 → → 查看完整问题清单… → 动作行`，
 * 分段与 `dual_track.renderMerged` 的拼装**同一形状**（块间恰好一个空行，
 * 不出现连续两个空行）—— 这里不另立一套空行口径。
 *
 * @param {string} text 装着 §5.3 块的那一格（`reasoning` 或某个 `groups[i].content`）
 * @param {string} url  报告链接
 * @returns {{text:string, action:'inserted'|'already'}|null}
 *   `null` = **这段文本里认不出动作行** ⇒ 调用方走旧路（宁可放可见格，也不瞎插）。
 *   认不出就不猜，是因为「随便找个位置插进去」会让读者以为那一行属于它上面的那条问题。
 */
/* ══════════════════════════════════════════════════════════════════════════
 * ★★ 2026-10-19（Owner：「卡片上的清单链接有两个，**去掉上面的，保留下面的**」）
 *
 * 病灶（**真因不在 `dual_track`，在这里** —— 先前判错了层，所以修了没生效）：
 *   同日为了 PRD §17 的字数（BLOCK/REVIEW ≥3 那一档 ≤100 字），卡面措辞从
 *   `→ 查看完整问题清单与修改建议：`（16 字）压成 `→ 完整清单：`（7 字），
 *   而本文件里两处「块里已经有了吗」的判断写的是**旧字面量**：
 *     · `insertLinkAboveAction` 的 `src.includes('查看完整问题清单与修改建议')`
 *     · `applyReportLink`  的 `JSON.stringify(data).includes('查看完整问题清单与修改建议')`
 *   ⇒ 两块**都认不出**块里已经有的 `→ 完整清单：<url>` ⇒ 走到 `in-block`，
 *   在动作行之上**再插一条**（而且用的是更长的旧措辞）⇒ 一张卡上下两条同指一份报告的链接。
 *   `dual_track.dedupeReportLinkLines()` 早在 `renderMerged` 内部就跑完了，信封这一条是
 *   **它之后**才加进去的 ⇒ 那道去重看不见它（判据盯错了层，是本条的教训）。
 *
 * 修法：**判据认形状、不认某一句措辞** —— 「→」＋「完整清单 / 查看完整问题清单与修改建议」
 *   ＋ 冒号。今后谁再改措辞，去重仍然生效。
 *   ⚠️ 这里**不许**写 `^` 行首锚：`applyReportLink` 那条是在 `JSON.stringify(data)` 上判的，
 *     换行被转义成字面量 `\n`，行首锚永远不命中。
 *   ⚠️ 两种措辞**都要认**：库侧（`p0_fastpath.py` / `feishu_publish.py`）产出的仍是长的那一条。
 */
export const REPORT_LINK_LINE_RE = /(?:→|->)\s*(?:完整清单|查看完整问题清单与修改建议)\s*[：:]/;
/** 这一格 / 这张卡里**已经有**清单链接行了吗（长短两种措辞都算）。 */
export const hasReportLinkLine = (v) => REPORT_LINK_LINE_RE.test(String(v ?? ''));
/**
 * 我们自己补链接时用的措辞 —— **短的**那一条（7 字）。
 * 理由：它进的是 PRD §17 有字数上限的那张卡（≥3 档 ≤100 字），16 字的写法白吃 9 个字；
 * 且与 `dual_track.renderMerged` 的 `reportNote` **同一措辞**，一张卡不会两种说法。
 */
const REPORT_LINK_PREFIX = '→ 完整清单：';

export function insertLinkAboveAction(text, url) {
  const src = String(text ?? '');
  if (!src.trim()) return null;
  // 块里已经有了 ⇒ 一个字都不动（J15a 那条口径：一张卡上只许出现一次）
  if (hasReportLinkLine(src)) return { text: src, action: 'already' };
  const m = ACTION_LINE_RE.exec(src);
  if (!m) return null;
  const head = src.slice(0, m.index).replace(/\s+$/, '');
  const tail = src.slice(m.index).replace(/^\s+/, '');
  const parts = [head, `${REPORT_LINK_PREFIX}${url}`, tail].filter(Boolean);
  return { text: parts.join('\n\n'), action: 'inserted' };
}

/**
 * 链接该落在**哪一格**：有 §5.3 块 ⇒ 落在块里（动作行之上）；认不出 ⇒ `null`。
 *
 * ★ 找块**不靠标题**（`逐条问题` 这个名字是渲染口径，会改），靠两个硬特征：
 *   ① `blockSlotOf(kind)` 说这个类型把逐条块放哪一格（与 `applyVerdictLine` 同一处口径）；
 *   ② 那一格的内容里**认得出动作行**（§5.3 块的收尾）。
 *   少了 ②，一张恰好含「建议转」三个字的普通卡也会被插进链接。
 */
function insertLinkIntoBlock(kind, data, url) {
  const slot = blockSlotOf(kind);
  if (slot === 'reasoning') {
    const r = insertLinkAboveAction(data?.reasoning, url);
    if (!r || r.action !== 'inserted') return null;
    return { data: { ...data, reasoning: r.text }, slot: 'reasoning' };
  }
  if (slot === 'groups') {
    const groups = Array.isArray(data?.groups) ? data.groups : [];
    for (let i = 0; i < groups.length; i += 1) {
      const r = insertLinkAboveAction(groups[i]?.content, url);
      if (!r || r.action !== 'inserted') continue;
      const next = groups.slice();
      next[i] = { ...groups[i], content: r.text };
      return { data: { ...data, groups: next }, slot: `groups[${i}]` };
    }
  }
  return null;
}

export function applyReportLink(kind, data, reportLink) {
  const url = String(reportLink ?? '').trim();
  if (!url) return { data, action: 'none', slot: null, why: '这一轮没有报告链接' };
  const line = `${REPORT_LINK_PREFIX}${url}`;
  // ══════════════════════════════════════════════════════════════════════════
  // ★★ 2026-10-13（Owner：「这里多余的回复也去掉」）：**先在整张卡里找一遍**。
  // ══════════════════════════════════════════════════════════════════════════
  //   那一行本来就印在 §5.3 块里 —— 紧挨着**动作行之上**（PRD §5.3 的次序），
  //   而那一块**默认展开**（`applyVerdictLine` 给第一组的是 `expanded: true`，
  //   已按真实卡片结构核过）。再补一份 ⇒ 同一张卡上出现**两次**同一个链接
  //   （Owner 那张视频卡就是这样）。
  //
  //   ⚠️ 与上面「为什么必须有它」不冲突：那一条治的是「链接落在**块的最末尾**、
  //     被 8 条逐条顶到看不见的地方」。现在的口径是「**块里已有就不再补**」——
  //     块里没有（非评审单 / 块没搬进来）时**照旧补进可见格**，一个都不许少。
  //   ★★ 2026-10-19（Owner：「卡片上的清单链接有两个…」）：这一句原先写的是
  //     `JSON.stringify(data).includes('查看完整问题清单与修改建议')` —— **绑死旧措辞**，
  //     卡面改成 `→ 完整清单：` 之后它就永远判「没有」⇒ 又补一条 ⇒ 两条链接。
  //     ⇒ 改走 `hasReportLinkLine()`（认形状）。这是本轮的**真因**，别改回去。
  if (hasReportLinkLine(JSON.stringify(data))) {
    return { data, action: 'already', slot: null,
             why: '§5.3 块里已经有这一行（块默认展开）⇒ 不重复' };
  }
  // ★★ 2026-10-15（Owner：「要放在『建议转xxx』上面，不要放在审查结论下面」）──────
  //   先试**块内**：插在动作行之上的紧邻位置。这是 ≥3 那一支早就在用的次序
  //   （`dual_track.renderMerged` 的 `reportNote`），本条只是把它补到 1–2 那一支上。
  //   ⚠️ 认不出动作行（没有 §5.3 块 / 块被截断 / 非评审单）⇒ **退回下面的可见格**，
  //     一个字符都不少（J15b 反向对照钉着这条路）。
  const inBlock = insertLinkIntoBlock(kind, data, url);
  if (inBlock) {
    return { data: inBlock.data, action: 'in-block', slot: inBlock.slot,
             why: `§5.3 块在（${inBlock.slot}）⇒ 链接插在**动作行之上**`
                + '（PRD §5.3 次序：正文 → 链接 → 动作行；块默认展开、看得见）' };
  }
  const out = { ...data };
  // ★★ 2026-10-26：候选格补上 `impact` —— **送审无结论那条路（`alert`）原先一个格都没有**
  //   ⇒ 报告链接被 `no-slot` 静默丢掉。实测（同一份输入跑两遍）：`reviewRequired:false`
  //   走 `query-answer` 时链接在卡上，`reviewRequired:true` 走 `alert` 时**链接没了** ——
  //   而「报告链接必须进卡片可见格」是 Owner 2026-10-09 定的口径（`test_agent` Z18 钉着）。
  //   为什么挑 `impact` 而不是 `retry`：卡面次序是 发生了什么 → **对你有什么影响** → 你可以，
  //   链接落在 `impact` 末尾＝**紧挨动作行之上**，与 PRD §5.3 的次序（正文 → 链接 → 动作行）一致。
  const slot = ['verdict', 'reasoning', 'wrong', 'verdict_text', 'impact', 'retry']
    .find((k) => typeof out[k] === 'string');
  if (!slot) return { data, action: 'no-slot', slot: null, why: `「${kind}」没有能放链接的格` };
  out[slot] = out[slot] ? `${out[slot]}\n\n${line}` : line;
  return { data: out, action: 'forced', slot };
}

export function toCardOrText(reply, { verdict53 = null, reportLink = null, machineAnswer = false,
                                       reviewRequired = false, reviewReason = null,
                                       reviewNextStep = null } = {}) {
  // ★★ 2026-10-13（Owner 三条里的第 1、2 条）：**查证笔记在成形之前就摘掉** ——
  //   放在最前面（早于 `extractCardBlock`）是有意的：那几行若被模型抄进卡片块里，
  //   晚一步摘就摘不到了（块里的是 JSON 字符串，按行认不出来）。
  //   ⚠️ 摘下来的原文**进 `stripMoved` 留痕**（日志看得见），不是静默丢弃。
  const stripped = stripInternalNotes(reply, { machine: machineAnswer });
  const stripMoved = stripped.removed.length
    ? [{ field: 'reply', to: '(memory)', chars: stripped.removed.join('\n').length,
         why: `回复里混进了我自己的查证笔记（${stripped.removed.length} 行）——`
            + '它不上卡（Owner 2026-10-13：卡片与报告都不显示，只在记忆里），已摘除' }]
    : [];
  // ★★ 2026-10-26（Owner 贴出的三条真回复）：**内部字段名的赋值行整行摘掉**。
  //   实测原文（`oc_7775…`，11:51）：
  //     `- label = REVIEW / layer = DP3 / release_status = 待放行 / parse_status = ok`
  //   这类行既不是 PRD §5.3 的结论行，也不是业务同事读得懂的话 —— 它是引擎内部读数。
  //   ⚠️ 摘掉的是**整行**，不是改写成「判定为 REVIEW」：改写等于替模型补一条
  //     它没被授权下的事实结论（§2.1 证据优先）。摘了什么进 `stripMoved`，日志看得见。
  //   ⚠️⚠️ 这一步**只能作用在「要发出去的正文」上，绝不能先动 `raw`** ——
  //     卡片块是一段**单行 JSON**，按行摘会把整段 JSON 一起摘掉（卡片块随之找不到，
  //     整张卡降级成纯文本）。实测：第一版就写在这里，`verify_cards` 的 J13a3f2/f5/f6、
  //     J13a3g2/g3、J11c3 六条**精确变红** —— 那几条盯的正是「模型给的卡照用」。
  //     ⇒ 判据分开：**卡片块**走数据层（下面 `scrubCardData`，坏不了结构）；
  //       **纯文本**走这里（`plainOut`，在 `!blk` 那一支里用）。
  const raw = s(stripped.text);
  const plainOut = () => {
    const j = stripEngineJargon(raw);
    if (j.removed.length) {
      stripMoved.push({ field: 'reply', to: '(memory)', chars: j.removed.join('\n').length,
        why: `正文里混进了判定引擎内部字段（${j.removed.length} 行：`
           + `${j.removed.slice(0, 2).join(' ｜ ').slice(0, 80)}）——`
           + '那是内部读数，不是 PRD §5.3 的结论行，已摘除（原文仍在会话记忆与日志里）' });
    }
    return j.text;
  };
  let blk = extractCardBlock(raw);

  /* ★★ 2026-10-26 二轮（Owner：「输出格式的问题，在 10/22 都是好的，恢复到 10/22 的输出格式」）
   *
   * ── 这里原先有一段「运行时强制模板」（当天上午加的）：模型没给卡片块时，代码拿模型的
   *    自由文本硬拼一张 `query-answer` —— 标题＝第一段、正文首行＝同一段，余下塞折叠区。
   *    实测形状（`PMO/logs/ws_outbound.jsonl`，私聊 `oc_7775…`）：
   *      14:08:19  `【你好。】` ＋ `你好。` ＋ `那张德语图…`
   *      12:21:56  整段抬头重复 ＋ `（已收起 1 条证据：证据 · 1 条）`
   *    而 10-22 的口径是**两形态**：模型给了卡片块就发卡，没给就纯文本原样出门
   *    （当天 92 条里 `reply` 与 `reply-card` 交替，16:27:31 那条「你好。」就是纯文本）。
   *    ⇒ 撤掉。`toCardOrText` 不再有「造卡」这条路，形态只由**模型给不给卡块**与
   *      下面的 `reviewShape`（评审单，卡面形状由代码定，10-13 的口径）决定。
   *
   * ⚠️ 撤掉的只是「造卡」，不是「清理」：孤立信封标记与引擎黑话仍由 `plainOut()` 摘
   *    （`stripEngineJargon` 里带 `CARD_MARK_RE`），所以 11:39 那种漏出来的 `[[/card]]`
   *    不会跟着纯文本一起出门。
   * ⚠️ 送审单那一条没撤：`reviewRequired` 是已登记的 `alert` 模板（what / impact / retry），
   *    不是拿模型原话拼抬头。
   */

  // 送审是固定 PRD 模板：不能因模型漏卡块或漏抄 5.3 结论，就退化成通用 query-answer。
  // 有权威结论时统一走 evidence；无权威结论时统一走 alert，明确这单没有可用审查结论。
  // 不从模型自由文本猜 PASS/REVIEW/BLOCK，避免把未测内容包装成审查结论。
  if (reviewRequired && !verdict53?.line) {
    // ★★ 2026-10-26（Owner 贴回的那张卡，逐字）：「发生了什么：结论：NEEDS_INPUT（拒答）｜
    //   引擎给的是 PASS／0，但**视觉层这次没跑**，链不认这个 PASS。」
    //   ——**视觉层明明跑了**（同单日志有 `🖼 画面读数｜图 1｜场景=卧室…`），
    //   而这句话是**模型自己的第一行**：旧代码 `const what = lines[0]` 把它原样搬上了卡。
    //   ⇒ 固定模板里的「发生了什么」**不许引用模型自由文本**（它会编原因），
    //     只能由代码按手里的读数写：有读数就写读数，没有就写"没取得结论"。
    //     （Owner 2026-10-26：「必须按照固定模版输出结论」。）
    const what = s(reviewReason).trim()
      || (verdict53?.state
        ? '本轮已有部分核查结果，但尚未形成完整的审查结论。'
        : '本轮审查未能完成，具体原因还需核查。');
    blk = {
      kind: 'alert', error: null, before: '', after: '',
      data: {
        title: '审查未完成',
        what,
        impact: '这条素材暂时没有可用的审查结论，不能据此放行。',
        retry: s(reviewNextStep).trim() || '本轮未安排自动重试。请联系维护人员核查。',
      },
    };
    stripMoved.push({ field: 'cardKind', to: 'alert',
      why: '送审没有权威 PRD §5.3 结论行 ⇒ 固定使用审查未完成告警模板；不猜结论' });
  }

  /* ★★ 2026-10-12（Owner 现场：「守衡的输出格式变了」）—— **评审单不许以纯文本出门** ──────
   *
   * ── 实测（三方对齐，不是推断）
   *
   *   `PMO/logs/ws_outbound.jsonl` ＋ 会话原文 ＋ `ws_daemon.log`，同一天两条形状：
   *     · 16:58 那条 1336 字 ⇒ `mode=reply-card`（卡片），群里渲染正常；
   *     · 19:31 / 19:53 / 19:55 / 19:58 四条 ⇒ `mode=reply`（**纯文本**），
   *       而它们对应的**模型原文里根本没有 `[[card:` 块**（会话逐条核过，
   *       日志那一行也写着 `📋 PRD §5.3 结论行：…｜落点=n/a·-｜逐条块=无`）。
   *   纯文本在飞书里**不渲染 markdown** ⇒ 群里看到的是 `**加粗**`、反引号、
   *   以及一堆 `|`（`persona.mjs` 的卡片规程早就写着这件事）——这就是 Owner 报的「格式变了」。
   *
   * ── 触发与残留（各占一半，别只修一半）
   *
   *   触发：19:31 那一轮的用户消息里被注入了「【请按短卡作答】…正文 ≤ 300 字，不要展开」，
   *   模型照着写了短答、**顺手把卡片块丢了**。那条指令 19:52 已停用并重启，
   *   可是**停用之后模型照样不给卡**（19:58 那条仍无卡块）⇒
   *   「模型会不会给卡」是**概率**，而 PRD §5.3 的结论行是**必须**落下的东西。
   *
   * ── 所以：与结论行、逐条块**同一条分工** —— **模型不写，代码搬**；模型连卡都不给，
   *    **代码自己建一张**（`evidence`：抬头放权威结论行，模型原话逐字进折叠组）。
   *
   *   ⚠️ 提示词那条路**这一步走不通**：`cardContract()` 已顶到 K5 的冻结上限
   *     （实测 `buildSystemPrompt()` 8497/8500，余量 3 字符）—— 想在里面加一句
   *     「评审单一律用卡」，得先删掉等量文字。在腾出空间之前，**这一跳是唯一的执行点**。
   *
   *   ⚠️ 只对**有权威结论行**的单子生效（`verdict53.line` 非空）：闲聊仍是纯文本，
   *     不许借着 PRD 的名义把所有对话都套成卡（J12d 反向对照钉着）。
   */
  // ══════════════════════════════════════════════════════════════════════════
  // ★★ 2026-10-13（Owner：「我到群里@守衡，群聊的格式跟私聊不一样？」）
  //    **评审单的卡片形状由代码定 —— 不看模型这一轮有没有给卡片块。**
  // ══════════════════════════════════════════════════════════════════════════
  //   先钉事实（`PMO/logs/ws_outbound.jsonl` 今日 9 条）：
  //     · 私聊 6 条评审卡 ⇒ 模型**没给**卡 ⇒ 代码建卡 ⇒ 抬头 + 「审查结论」组 + 卡脚；
  //     · 群里 1 条评审卡 ⇒ 模型**给了**卡 ⇒ 用它 ⇒ 抬头 + 模型自拟的四五个分组 + 卡脚。
  //   而**代码里没有任何群/私聊分叉** —— 形态提示词（`cardContract()`）两条路是同一份，
  //   按会话类型变的只有 `# 当前场景` 那一行。⇒ 差别只来自**模型这一轮的心血来潮**。
  //
  //   这正是 §2.5「形态决策只能有一处」要防的东西：形态由掷骰子决定，表现就是「格式随机」。
  //   ⇒ 口径：**只要有 §5.3 块（＝这是一张评审单），卡面就收敛到同一个形状** ——
  //     抬头＝结论行 · 一组「审查结论」＝§5.3 逐条块 · 卡脚＝边界（+报告链接在可见格）。
  //     模型自拟的分组 / 它的结论格 / 块外正文 **都不上卡**（Owner 前三条已经逐条要走的东西），
  //     但它们**一个字都没丢**：它仍是这一轮的回复正文（会话记忆 + `💬 回复 N 字` 日志）。
  //   ⚠️ 2026-10-13：`boundary` 那一格**整格作废**（Owner：整个都隐藏）⇒ 模型写的边界
  //     也**不上卡**（它仍是这一轮回复正文的一部分，会话记忆里有）。
  //   ⚠️ 没有 §5.3 块时（`verdict53.block` 为空）行为**逐字不变**：模型给的卡照用。
  // ★★ 2026-10-15（真单 `om_x100b62333eaaf0a8b050a29473b0030`，14:47 批跑那张 PASS 卡）：
  //   **判据一字未动** —— 走的是下面 `autoCard` 那一档的「块外正文并进折叠组」。
  //   出了什么事：那一单是 PASS、问题数 0 ⇒ 链**本来就没有逐条块** ⇒ `block` 为空 ⇒
  //   模型这一轮的回复正文（`链侧 PASS ｜ 0 处问题…`、`引擎结论（照抄 ③b 模板）…置信度 0.93`、
  //   `（未填）` 表格、`` `risk_items` 为空… ``）被当成卡片正文进了群。
  //   `stripInternalNotes()` 只认**已登记的那几种行形状**（产者是 `dual_track.renderMerged`），
  //   模型自己编的笔记形状它一个都不认 ⇒ 一行都摘不掉。
  //
  //   ★ 修法**不在这一层**：这一层的「块为空也要保住模型原话」是 J13a3 明写的安全网
  //     （怕丢内容），一刀砍掉它会连**回复那条路**一起伤。真正的区别在**调用方**：
  //     · `ws_daemon.replyTo` —— 那是**回给某个人的话**，原话该留着（安全网要的）；
  //     · `batch_review_runner` —— 它喂进来的 `raw` 是**链的机器答案**（跑批时没有真人对话），
  //       那一段里全是内部读数，本来就不该上卡 ⇒ 它显式传 `machineAnswer: true`。
  //   实现见下面 `autoCard` 分支里 `useRaw` 那几行。
  const reviewShape = !!(verdict53 && verdict53.line)
    && !!s(raw).trim() && (reviewRequired || !!verdict53.block || !!s(verdict53.videoAnalysis).trim());
  const shapeMoved = [];
  if (reviewShape) {
    if (blk) {
      shapeMoved.push({ field: 'cardKind', to: 'evidence',
                        why: '评审单 ⇒ 卡面形状由代码定（Owner 2026-10-13：群里与私聊必须一样）'
                           + ' ⇒ 模型自拟的分组/结论格不上卡（原文仍在会话记忆里）' });
    }
    blk = { kind: 'evidence', error: null, before: '', after: '',
            data: { verdict: '', groups: verdict53.block ? [] : [{
              title: '详细说明', content: blk ? carryCardText(blk.data) || raw : raw,
              expanded: true,
            }] } };
  }

  // ★★ 2026-10-26（Owner：「必须按照固定模版输出结论」）────────────────────────────────
  //   **有库侧读数、却没有 §5.3 结论行时，绝不许让模型原话当结论出门。**
  //   病灶（Owner 转来的那条真回复，逐字）：
  //     「第八张，结果同前七张：`REVIEW` / `DP3` / 待放行，命中 0 条。……`coverage = partial`」
  //   三个毛病叠在一起：① 没有 `【审查结论：X】` 抬头；② 引擎内部字段（`DP3` / `coverage = partial`
  //   / `待放行`）外泄；③ **命中 0 条却给 REVIEW**（PRD §5.3.1 要求 PASS 一句话）。
  //   ②由 `stripEngineJargon` 摘、③由 `mergedState` 的「严格 0 条 ⇒ PASS」修；
  //   而**①的根子在这里**：`verdict53.line` 为空时（读数里没有可印的条数、`verdictLineFor` 返回 null），
  //   原先一路落到 `plainOut(raw)` ⇒ 模型写什么就发什么 ⇒ 形态由模型决定，
  //   这正是 §2.5「形态决策只能有一处」要防的。
  //   ⇒ 判据：**只要有读数（`verdict53.state`）而没有结论行，就发固定的「审查未完成」告警卡**，
  //     不猜结论、不拿自由文本充结论。没有读数时（闲聊）一个字节都不变。
  const hasReadingNoLine = !blk && !!(verdict53 && verdict53.state)
    && !s(verdict53.line).trim();
  if (hasReadingNoLine) {
    blk = { kind: 'alert', error: null, before: '', after: '',
            data: {
              title: '审查未完成',
              what: s(reviewReason).trim() || '本轮已有部分核查结果，但尚未形成完整的审查结论。',
              impact: '这条素材暂时没有可用的审查结论，不能据此放行。',
              retry: s(reviewNextStep).trim() || '本轮未安排自动重试。请联系维护人员核查。',
            } };
    shapeMoved.push({ field: 'cardKind', to: 'alert',
                      why: '有库侧读数但没有 §5.3 结论行 ⇒ 固定告警模板；'
                         + '不许把模型自由文本当结论（Owner 2026-10-26：必须按固定模版输出结论）' });
  }

  const autoCard = !blk && !!(verdict53 && verdict53.line) && !!s(raw).trim();
  const autoDedup = [];
  if (autoCard) {
    const line = s(verdict53.line).trim();
    let body = raw;
    // ★ 结论行**独占抬头**（2026-10-09 治过一次「结论行印两遍」）：模型原话里若已经把
    //   这一行原样写出来了，就从折叠组里摘掉它 —— 否则抬头一遍、展开组里又一遍。
    //   ⚠️ 摘完就空了 ⇒ **不摘**：宁可重复一次，也不留一个空的组（那比重复更难读）。
    if (line && body.includes(line)) {
      const stripped = body.split(line).join('').replace(/\n{3,}/g, '\n\n').trim();
      if (stripped) {
        body = stripped;
        autoDedup.push({ field: 'verdictLine', to: 'title',
                         why: '模型原话里已经把结论行写出来了 ⇒ 从折叠组里摘掉（抬头独占，不许印两遍）' });
      }
    }
    // ══════════════════════════════════════════════════════════════════════════
    // ★★ 2026-10-13（Owner 当场给的原文）：「去掉下面这些」——
    //    他展开的那一组正是**模型这一轮的整段原话**（标题叫「详细说明」）。
    // ══════════════════════════════════════════════════════════════════════════
    //   他引的原文里有大量**内部读数**：`P0 快路（258.167 ms…）`、`未跑 L4→L5→L6→L7 与评审链`、
    //   `★ 表行（照抄）…行号 recvxPYwEQOSAe…回读 consistent`、`观察：M8 这句跑第 3 次…`。
    //   那些**不是给群里的人看的**（与「库内命中（读数）」同一个病）。
    //
    //   而这一单真正要读的东西**一个字都不在那一组里** —— 它们由**代码**搬进卡：
    //     抬头 = 权威结论行；第一组 = PRD §5.3 逐条块（原因/依据/建议/判定）；卡脚 = P0 边界。
    //     ⇒ 所以那一组**不再建**。
    //
    //   ⚠️ **安全网（与「拿不到报告链接就退回逐条平铺」同一条）**：
    //     **只有 §5.3 块真的搬得进来时才不建那一组**。`verdict53.block` 可能是 null
    //     （`conclusionBlock()` 找不到动作行时），那时卡上会只剩一个抬头 ——
    //     比改动之前**更没法用**。所以那时照旧把原话放进「详细说明」组。
    //   ⚠️ 模型这一轮的原文**没有丢**：它仍是这一轮的回复正文（`ws_daemon` 记
    //     `💬 回复 N 字`，`memory` 也原样存着这一条 assistant 轮）。
    // ★ 2026-10-15：`machineAnswer` —— **调用方声明「喂进来的 raw 是链的机器答案、不是回给某个人的话」**。
    //   批跑那条路（`batch_review_runner`）就是这一种：跑批时没有真人对话，
    //   `res.reply` 里除了结论行，剩下的全是我们自己的读数（`链侧 PASS ｜ 0 处问题…`、
    //   `引擎结论（照抄 ③b 模板）…置信度 0.93`、`（未填）` 表格、`` `risk_items` 为空… ``）。
    //   实测那一单（PASS、问题数 0）就这么把内部读数当卡片正文发进了群（Owner 当场指出）。
    //
    //   ⚠️ 它**不是**「一概丢掉原话」：批跑里链跑挂时，模型那一段是有内容的答复，
    //     那时**必须**照旧留着（与 `!block` 那条安全网同理）⇒ 判据收窄成
    //     「机器答案 **且** 摘掉我们自己产出的那几种行形状之后已无实质内容」。
    //   判据在 `tools/verify_cards.mjs` 的 J13a3 / J13a3b（正反各一条）。
    const machineOnly = machineAnswer
      && !hasSubstance(stripInternalNotes(reply, { machine: true }).text, { exclude: verdict53?.line });
    const dropProse = !!verdict53?.block || machineOnly;
    blk = {
      kind: 'evidence',
      error: null,
      before: '',
      after: '',
      // `verdict: ''` 是**留槽位**，不是留空话：`applyReportLink`
      // 只往 `verdict / reasoning / wrong / verdict_text` 里搬，
      // 一个都不给的话，**拿不到 §5.3 块的单子**会连报告链接都没地方落。
      // 留空串 ⇒ 它们搬得进来；而结论行走的是**抬头**（`verdictSlotOf('evidence')='title'`），
      // 两样各占一格，**不会印两遍**。
      data: { verdict: '',
              groups: dropProse ? [] : [{ title: '详细说明', content: body, expanded: true }] },
    };
    if (dropProse) {
      autoDedup.push({ field: 'groups', to: '(不建)',
                       why: '模型原话整组不上卡（Owner 2026-10-13：那一组里是内部读数；'
                          + '要读的三样由代码搬进卡 —— 抬头 / §5.3 逐条块 / 卡脚边界）' });
    }
  }

  if (!blk) {
    const lint = lintCopy(raw);
    const leak = lint.find((h) => h.id === 'internalLeak');
    if (leak) {
      // ★ 纯文本**没有折叠区可放**，而「内部详情只进折叠区」是 §2.4 点名的硬约束；
      //   `agent-skills/守衡语域/SKILL.md` 第 7 条写得更直白：
      //   「**不是改写，是不许写。** 内部详情只进折叠区」。
      //
      //   所以这里既不原样发、也不做改写（改写就违反「不是改写」那句话）——
      //   换成一句诚实的降级说明，原文留在日志里。
      //
      //   2026-09-17 那条真事故（连列 19 次 `list_files` 的 434 字故障输出）**正是纯文本**：
      //   当时它通过了除第 7 条以外的全部内容级检查，而第 7 条在**这条路径上没有执行点**。
      //   检测器（`lintCopy`）一直是对的 —— 缺的是「动作」。
      //
      // ★ 2026-09-22：这句话里「原始内容留在 PMO/logs」曾经是**假的** ——
      //   说出去的时候盘上什么都没有（实测 16:34 那次，`PMO/logs/` 里没有任何新文件）。
      //   现在它有执行点：`ws_daemon.mjs` 的 `dumpDropped()`，接在 `shaped.dropped`
      //   分支上，落点 `PMO/logs/dropped/`。所以**这句话里的路径必须与那里一致** ——
      //   改落点就要同时改这里，`verify_cards.mjs` 的 L7 断言两处对得上。
      return {
        mode: 'text',
        text: '我这次没能把回答组织好 —— 正文里混进了内部记录，已经拦下没发出去。'
            + '原文我留在 PMO/logs/dropped/ 了，需要的话我重新答一次，不会丢。',
        reason: `正文含内部标识（internalLeak×${leak.count}），纯文本没有折叠区可放 → 不原样发`,
        moved: stripMoved,
        lint,
        dropped: true,
      };
    }
    const text = leadWithVerdict(plainOut(), verdict53);
    return { mode: 'text', text, reason: null, moved: stripMoved, lint: lintCopy(text), dropped: false,
             verdict53: verdict53 ? 'text-lead' : null };
  }

  // 找到了标记但数据不可用 → 剥掉整块（含标记与半截 JSON），只留可读的话。
  // 这一步是硬要求：`[[card:...]]` 出现在群里 = 内部格式泄漏，和泄漏 tool_calls 同类。
  if (!blk.data) {
    const text = [blk.before, blk.after].filter(Boolean).join('\n\n').trim()
      || `我这次没能把回答组织成卡片（${blk.error}），上面这条就是我能给出的全部。`;
    return {
      mode: 'text', text, reason: `卡片块不可用：${blk.error}`,
      moved: stripMoved, lint: lintCopy(text), dropped: true,
    };
  }

  // ★★ 评审单的 PRD §5.3 逐条块**必须落得下**（2026-10-07 实测缺口）──────────────
  //   卡片类型由**模型挑**，而 11 种类型里**只有两种**装得下 §5.3 的逐条块：
  //     `query-answer`（有 `reasoning`）与 `evidence`（有 `groups`）—— `blockSlotOf()` 就认这两个。
  //   挑到别的类型（如 `turn-diff` 改口卡、`data-table`、`receipt`…）⇒ `applyVerdictLine`
  //   只能返回 `no-slot`，**块被静默丢掉**，群里就只剩模型自己写的话。
  //   实测（2026-10-07 16:21，Owner 当场报「你改了后就不按 PRD 格式输出了」）：
  //     同一文案第三次送审、合并结论由 REVIEW 变 BLOCK ⇒ 模型挑了 `turn-diff` 去解释差异
  //     ⇒ 日志只留一行 `逐条块=no-slot·-`，卡片照发 ⇒ **§5.3 结论块整块不见了**。
  //   修法：**评审单（`verdict53.block` 非空）＋ 类型装不下 ⇒ 换成 `evidence`**，
  //     并把原卡内容**逐字搬进第一组**（模型写的差异说明一个字不丢；换的是外壳，不是内容）。
  //   为什么不是「拒绝发送」：结论与依据比外壳重要 —— 丢块是缺陷，丢整条回复是更大的缺陷。
  let kd = blk.kind;
  let dd = blk.data;
  const remap = [];
  remap.push(...shapeMoved);
  // ══════════════════════════════════════════════════════════════════════════
  // ★★ 2026-10-15（第 7 张 PASS 卡，真单 `om_x100b623de32b9c84cebb3cd965d312f`）：
  //    **模型给了卡时，`machineAnswer` 也必须接得上。**
  // ══════════════════════════════════════════════════════════════════════════
  //   实测：17:20 那张卡走的是「模型的卡照用」这一支 ⇒ 上面 `autoCard` 里的
  //   `machineOnly` 判据**根本没被执行**，于是模型把那一轮 `res.reply` 里的读数
  //   转述进了卡面（`状态 PASS ｜ 问题数 0 ｜ 置信度 0.93`、`（未填）` 表格碎片、
  //   `--content-type text`、`四道审计红 0`、`source_chain`… 共 10 类），
  //   结论行还印了两遍。Owner 当场报「格式不符」—— 与 15:11 那条**同根**，
  //   只是站在**另一条分支**上（那一条修的是「模型没给卡」）。
  //   ⚠️ 只对**机器答案**生效（`machineAnswer` 由批跑器声明）：回复那条路一个字不动。
  if (machineAnswer) {
    const mf = machineAnswerFold(kd, dd, verdict53);
    dd = mf.data;
    remap.push(...mf.moved);
  }
  // ★ 代码建的卡也要**出声**：日志里必须看得见「这一单的卡不是模型给的」——
  //   否则「模型忘了给卡」这件事只会以「格式变了」的样子出现在群里（今天就是这样）。
  if (autoCard) {
    remap.push(...autoDedup);
    remap.push({ field: 'cardKind', to: 'evidence',
                 why: '本单有权威结论行，而模型没给卡片块 ⇒ 代码建卡'
                    + '（纯文本不渲染 markdown，格式会整块丢；判据 J12a–c）' });
  }
  if (verdict53 && verdict53.block && !blockSlotOf(kd)) {
    const carried = carryCardText(dd);
    remap.push({ field: 'cardKind', to: 'evidence',
                 why: `「${kd}」没有能放 §5.3 逐条块的格（既无 reasoning 也无 groups）`
                    + ' ⇒ 换 evidence，原卡内容逐字搬进第二组' });
    dd = { verdict: s(dd?.verdict).trim() || s(dd?.title).trim() || '',
           // ★ 2026-10-09（Owner）：**标题不许出现内部类型名**（「原「data-table」卡」对业务同事
           //   是零信息量）。内容仍**逐字照搬**（`carryCardText` 一个字没动）。
           // ⚠️ 标题要与 `foldIn` 那个（「（原文照留：模型原话，非权威结论）」）**明显不同** ——
           //   两处都写「原文照留」时，读者会把两组当成**同一段的重复**，而它们装的
           //   其实是两样东西：这一组装「原结论格 + 字段表」，那一个装「卡片块之外的正文」。
           // ★ 2026-10-13（Owner）：另一处原先叫「模型原话（原文照留）」的组标题也去掉了
           //   —— 「模型」是我们的内部说法，对群里的人是零信息量。改名后两组标题仍有明显区别。
           groups: [{ title: '原结论（原文照留）', content: carried || '（原卡无正文）',
                      expanded: true }] };
    kd = 'evidence';
    // ★★ 2026-10-09：**结论格在这里就落权威结论行**（治「结论行印两遍」）────────────
    //   病灶（实测复现，文案单那张卡里「【审查结论：REVIEW】」出现 **2 次**）：
    //     · ① `carryCardText` 已把原卡的 `verdict`（模型那句）**逐字搬进 `groups[0]`**，
    //          而换卡后 `dd.verdict` 仍留着**同一句**；
    //     · ② 紧接着 `applyVerdictLine` 看到 `verdict` 槽"有内容且不等于结论行"
    //          ⇒ 走 ①「先把模型原来那句搬进折叠区」那一支 ⇒ **再折一份**，
    //          然后才把结论行写进 `verdict`。
    //     ⇒ 同一句模型原话在卡上出现两次（一次在 `groups[0]`、一次在折叠组，
    //        标题还各不相同），且**结论行也跟着出现两次**。
    //   修法：换卡时**先把结论行放进 `verdict`** ⇒ 后面那次 `applyVerdictLine` 走
    //     `cur === verdict.line` 的 `already` 支 ⇒ **不折、不写** ⇒ 天然不重复。
    //     （原内容已由 `carried` 保住，一个字没丢 —— 「搬是搬，砍是砍」。）
    if (verdict53?.line) dd.verdict = verdict53.line;
  }

  // 块前后还有正文：不是丢弃，是并进这张卡里该放它的格子。
  // 模型多写的话通常是有用的补充，但**不能留在块外** ——
  // 留在块外，群里看到的就是「一张卡 + 一段重复的话」。
  const extra = [blk.before, blk.after].filter(Boolean);
  let v53 = null;
  const built = (() => {
    let { data, moved } = enforceLimits(kd, dd, extra);
    moved.push(...remap);
    // ★ 2026-10-13：摘掉的查证笔记也要留痕（否则「它本来就没写过」与
    //   「写了、被我摘了」在日志里长得一模一样 —— `verify_cards` 的 J13d 钉着）。
    moved.push(...stripMoved);
    // ★ PRD §5.3 结论行必须在 `build()` **之前**落进结论格 ——
    //   建完卡再改 `data` 不会影响已经建出来的那张卡（改了也不报错，只是白改）。
    const applied = applyVerdictLine(kd, data, verdict53);
    data = applied.data;
    if (applied.moved) moved.push(applied.moved);
    // ★ 2026-10-22（Owner：「输出的卡片不展示 视觉分析与 OCR」）：
    //   原先这里把 `imageAnalysis`（OCR 行数 + 视觉模型读数）追加到评审卡正文/分组里。
    //   整块撤掉 —— 卡面只留「结论 / 分类汇总 / 逐条 / 报告链接」。
    //   ⚠️ 视觉分析照样要做、照样是出结论的前置（`visual_checklist.mjs` 缺项 ⇒ NEEDS_INPUT）；
    //     读数的落点是 `📥 读到｜…` 日志、会话记忆、报告附录 —— 只是不上卡。
    // ══════════════════════════════════════════════════════════════════════════
    // ★★ 2026-10-15：**权威结论行占抬头，模型那句原话降到正文首行**
    //    （真单第 7 张 PASS 卡：`query-answer` 的结论格是 `verdict`，**抬头不是它**）
    // ══════════════════════════════════════════════════════════════════════════
    //   出了什么事：`verdictSlotOf('query-answer') = 'title'` ⇒ `applyVerdictLine`
    //   认定「抬头已经是权威结论行」（它刚写的）⇒ 走 `already` 支、**一个字符都没搬**。
    //   于是正文第一格 `verdict` 还空着 ⇒ 卡面上第一行印着 **「（未填）」**，
    //   而那一格本来装的正是模型那句结论（`链侧 PASS/0…；本单未收到双轨合并块`）。
    //   `（未填）` 是「缺字段」的可见信号（`cards.mjs` 的 `NA`）—— 这里并不缺，
    //   缺的是**有人把它搬下来**。所以这一步只做一件**搬迁**：抬头归权威结论行，
    //   模型那句进正文首行（**一个字都没丢**，也没替它改写）。
    //   ⚠️ 只对**机器答案**生效，且只在「抬头确实已是权威结论行」时动手；
    //     回复那条路（模型给人写的卡）一个字都不动。
    //   ★★ 判据**不**加 `machineAnswer` 门（这一点是反向对照逼出来的，2026-10-15）：
    //     回复那条路同样会走到这里 —— `applyVerdictLine` 把抬头改写成权威结论行之后，
    //     **模型自己给的抬头就没人接着了**（`dd.title` 还在，但卡面上不再是它）。
    //     那一句是模型写的，按「搬不是砍」必须落回正文（`J13a3e2` 钉着这一条）。
    //     ⚠️ 只在「抬头**确实被改写过**」时动手：`data.title` 仍是模型那句 ⇒ 一字不动。
    // ══════════════════════════════════════════════════════════════════════════
    // ★★ 2026-10-16（Owner 裁定）：「PASS 单**只要一句话结论**」——
    //    模型那句原话与证据折叠区**都不上卡**。
    // ══════════════════════════════════════════════════════════════════════════
    //   Owner 原话（2026-10-16，看到修好的那张 PASS 卡之后）：
    //     「**只需要一句话结论，去掉『DeepClean Lite 教程』和证据**」。
    //   落法：**卡面只留抬头那一行**（`body.elements = []`）。
    //   ⚠️ 为什么在**建完卡之后**动刀、而不是清 `data`：`query-answer` 的构造器
    //      **恒定**推一个 `md(s(d.verdict))` —— 清空 `verdict` 会印出 **`（未填）`**
    //      （那正是 FIX-037 刚修掉的东西）。所以在卡这一层收口，与构造器无关。
    //   ⚠️ **砍的是卡面，不是内容**：删掉的元素逐条记进 `moved`；原文仍在模型那一轮的
    //      回复里（会话记忆 ／ 批跑留档 `dm_ou_batch_runner.json`），报告与表行照旧是全份
    //      —— 「搬是搬，砍是砍」。
    //   ⚠️ 只认**权威结论行给的态**（`verdict53.state`）：闲聊、链没跑成、
    //      REVIEW / BLOCK 一个字不动（它们的逐条块是 PRD §5.3.2+ 的格式件）。
    const passOnly = verdict53?.state === 'PASS' && !!s(verdict53?.line).trim();
    const _mTitle = s(blk?.data?.title).trim();
    //   ⚠️ 「原本有没有正文字段」要拿**模型给的原始卡**（`blk.data`）去问，不能问 `data`：
    //     `applyVerdictLine` 可能已经把原抬头折进 `data.evidence` 了（回复那条路就是），
    //     拿折完的 `data` 判会得出「正文本来就有」的假结论（实测踩过）。
    const _hasProse = !!s(blk?.data?.verdict).trim() || !!s(blk?.data?.reasoning).trim();
    const _alreadyKept = (Array.isArray(blk?.data?.evidence) ? blk.data.evidence : [])
      .some((x) => s(x).includes(_mTitle));
    //   ⚠️ `passOnly` 时**这一跳整跳不做**：它会把模型那句搬进正文首行，而现在
    //     正文整块都不上卡 ⇒ 做了会写出一条**假的搬迁记录**（说搬了、其实没有）。
    //     模型那句的去向由下面 `passOnlyLine()` 那一条如实记账。
    if (!passOnly && verdict53?.line && _mTitle && _mTitle !== s(verdict53.line).trim()
        && s(data.title).trim() === s(verdict53.line).trim() && !_alreadyKept) {
      if (_hasProse) {
        // 模型给的卡本来就有正文格 ⇒ 把原抬头补进正文首行，别让它只活在折叠区里
        data = { ...data, verdict: s(data.verdict).trim() ? data.verdict : _mTitle };
        moved.push({ field: 'title', to: 'verdict', chars: len(_mTitle),
                     why: '抬头归权威结论行 ⇒ 原抬头补进正文首行（不丢字；也免得印「（未填）」）' });
      } else {
        data = foldInto(kd, data, _mTitle, moved, 'title');
      }
    }
    // ★★ 2026-10-13：**媒材读数不再上卡**（Owner：「这里多余的回复也去掉」）。
    //   ⇒ 这一跳的接线**撤了**，`mediaRead` 这个选项也一并撤掉 ——
    //     **留一个没人读的入参就是「传了但没人接」那个病**（同一天刚在
    //     `ws_daemon.replyTo` 的 `reportLink` 上抓到一次，见 test_agent 的 Z20b）。
    //   纯函数 `applyMediaRead` 留着（`p0ShortReplyBlock` 那个先例），要恢复就是把这一跳加回来。
    // ⚠️ 2026-10-13：卡脚那一跳**整块已作废**（Owner：「整个都隐藏，不要展示在卡片上」）。
    //   原先这里往卡脚写 P0 边界 ⇒ 现在那一句改走 `dual_track.internalNotes`（记忆侧，答得出来）。
    // ★ 2026-10-09：**报告链接也搬进可见格** —— 它此前只在结论块里，而那一块会被收起
    //   （Owner 第三次反馈「没有报告链接」，而 docx 其实建好了）。
    const rl = applyReportLink(kd, data, reportLink);
    data = rl.data;
    // ★★ 2026-10-15：**链接的落点也必须留痕**。
    //   这一跳此前只接线、不记账 —— 于是「链接插到动作行之上了没有」在日志里
    //   **一个字都看不见**：账上只有「有链接 / 没链接」。而 Owner 这一次报的
    //   恰恰是**落点**错了（`要放在「建议转xxx」上面`）⇒ 没有落点读数，
    //   下一次同样的错只能又靠人在群里看出来。字段名对齐上面那条搬迁记录的形状
    //   （`ws_daemon.mjs` 的 `↪ ${m.field} → ${m.to}（${m.why}）` 读的就是这三个键）。
    if (rl.action && rl.action !== 'none') {
      moved.push({ field: 'reportLink', to: rl.slot ?? '(无格)',
                   why: `${rl.action === 'in-block' ? '块内·动作行之上' : rl.action}：${rl.why}` });
    }
    // ★ 2026-10-08：这条搬迁记录原先压的是 `{ what: 'mediaRead', to }` —— 而日志格式器
    //   （`ws_daemon.mjs` 的 `↪ ${m.field} → ${m.to}（${m.why}）`）读的是 `field` / `why`，
    //   于是实测在图片单上打出一行 `↪ undefined → verdict（undefined）`：
    //   看得见「有东西搬进 verdict」，看不见**搬的是什么、为什么**。形状对齐其余搬迁记录。
    // ★★ 2026-10-26（Owner 贴出的三条真回复）：**卡面数据层再清一遍**。
    //   原始文本那一层已经摘过（`stripEngineJargon`），但卡片块是一段 JSON ——
    //   模型可以把 `label = REVIEW / layer = DP3` 直接写进 `evidence[]` 或 `groups[].content`，
    //   那一层按行摘不了（会摘坏 JSON）。所以在这里按**数据**摘：坏的只是那一行，
    //   卡片结构一个字不动。实测那条卡片的折叠组里就漏出过整段引擎读数。
    {
      const scrubSink = [];
      data = scrubCardData(data, scrubSink);
      if (scrubSink.length) {
        moved.push({ field: 'cardData', to: '(memory)', chars: scrubSink.join('\n').length,
                     why: `卡片字段里混进了判定引擎内部读数（${scrubSink.length} 行）——`
                        + `不是 PRD §5.3 的字段，已摘除（原文仍在会话记忆里）` });
      }
    }
    v53 = { action: applied.action, slot: applied.slot, why: applied.why,
            from: verdict53?.from ?? null, line: verdict53?.line ?? null,
            // 逐条块的落点也一起带出去 —— 否则日志里只看得到「标题搬了」，
            // 看不到「逐条四要素到底进没进正文」（2026-10-06 Owner 就是在这上面又逮到一次）。
            block: applied.block ?? null };
    // Video observations travel as structured evidence, outside conclusionBlock's
    // action-line parser. A missing report must not make six completed readings vanish.
    const videoAnalysis = s(verdict53?.videoAnalysis).trim();
    if (videoAnalysis && kd === 'evidence') {
      data.groups = [...(verdict53.state === 'PASS' ? [] : (data.groups ?? [])),
        { title: '视觉分析（关键帧画面读数）', content: videoAnalysis, expanded: false }];
      moved.push({ field: 'videoAnalysis', to: 'groups', why: '本轮视频画面读数；不计入问题数量' });
    }
    try {
      // 先按数据把长度上限执行掉、再建卡，最后按**建出来的卡**数顶层段落。
      // 顺序不能颠倒：段落数只有卡建出来才存在。
      const capped = capSections(build(kd, data));
      if (capped.moved.length) moved.push(...capped.moved);
      // ★★ 2026-10-16（Owner）：「PASS 单只留一句话结论」—— 在**卡这一层**收口。
      const collapsed = videoAnalysis
        ? { card: capped.card, stripped: 0 } : passOnlyLine(capped.card, verdict53);
      if (collapsed.stripped) {
        moved.push({ field: 'cardBody', to: '(不上卡)', chars: collapsed.chars,
                     why: `PASS 单只留一句话结论（Owner 2026-10-16）：${collapsed.stripped} 个正文块`
                        + '（含模型那句原话与证据折叠区）不上卡；'
                        + '原文仍在模型那一轮的回复里（会话记忆 ／ 批跑留档），报告与表行照旧是全份' });
      }
      return { card: collapsed.card, data, moved, err: null };
    } catch (e) {
      return { card: null, data, moved, err: e.message };
    }
  })();

  if (!built.card) {
    // 降级：剥掉整块，只发可读的话。不把坏 JSON 吐进群 —— 那是 2026-09-17 那条故障的同类。
    const text = [blk.before, blk.after].filter(Boolean).join('\n\n').trim()
      || `我本想用「${kd}」卡片回答，但这张卡没通过本地校验，所以这条只能以纯文本发出。`;
    return {
      mode: 'text', text,
      reason: `卡片 ${kd} 构建失败：${built.err.split('\n')[0]}`,
      moved: built.moved, lint: lintCopy(text), dropped: true,
    };
  }

  const text = renderText(built.card);
  return {
    mode: 'card', card: built.card, data: built.data, kind: kd,
    text, reason: null, moved: built.moved, lint: lintCopy(text), dropped: false,
    verdict53: v53,
  };
}

/**
 * **守衡自己的「查证笔记」不许进群** —— 在成形之前按行摘掉（纯函数，可离线断言）。
 *
 * ── 为什么要有它（2026-10-13，Owner 三条里的第 1、2 条）
 *
 * Owner 原话：「输出到飞书群包含知识库侧+模型侧的文字，**不要展示在卡片上**，
 * **我问的时候，你要能回答**」，并把那一族口径读数逐条列进了「类似以下的文案都去掉」：
 *
 *   · `知识库侧 未报内容问题；另有 1 条覆盖缺口… ／ 模型侧 7 条（其中 7 条无库内依据…）`
 *   · `ℹ️ 知识库侧给了 **覆盖缺口**（`coverage_not_covered`）…`
 *   · `（问题数 8 ≥ 3 ⇒ 按 PRD §5.3.3 只出分类汇总…）`
 *
 * ── 分工（与结论行、逐条块同一条：**模型不写、代码搬**）
 *
 *   `dual_track.renderMerged` 已经把这几行**从 `block` 里摘掉**（模型没有可逐字转述的源），
 *   它们改走 `internalNotes` → `agent.mjs` 的 `chainBlock`（模型上下文 + **会话记忆**）
 *   ⇒ 这一轮答得出、以后每一轮也答得出（Owner 要的「我问的时候你要能回答」）。
 *
 *   但「模型从不照抄 `chainBlock` 里别的东西」是**概率，不是保证** ——
 *   而这几行一旦被抄进去，就会顺着卡片正文进群。所以这里是**执行点**：
 *   逐行认我们**自己产出的那几种固定形状**，命中即摘，并留痕（`removed`）。
 *
 * ⚠️ 判据**只认我们自己的字符串**（前缀 + 关键片段），不做泛化匹配 ——
 *   实测否掉的写法：「凡出现『知识库侧』就摘」会把**正常句子**一起摘掉
 *   （`知识库侧 3 条与素材相关` 是模型在如实转述，它该留着）。
 *   反向对照（`verify_cards.mjs` 的 J13）钉着这一条：普通句子**必须**原样留下。
 *
 * ⚠️ 摘的是**我们自己生成的行**，不是改写模型的话 ——
 *   与 `internalLeak` 那条「不是改写，是不许写」同源，区别只在于：
 *   那一条没有折叠区时只能**整条拦下**，而这几行有明确的归属（记忆里还有一份），
 *   所以按行摘掉比把整条回复丢掉**代价小得多、也不会丢内容**。
 *
 * @param {string} text 模型这一轮的原文
 * @returns {{text:string, removed:string[]}} 摘完的文本与摘掉的原文行（留痕用）
 */
export function stripInternalNotes(text, { machine = false, cardField = false } = {}) {
  const src = s(text);
  if (!src) return { text: src, removed: [] };
  // 我们自己的那几种固定形状（`dual_track.renderMerged` 是唯一产者）。
  const RULES = [
    /^知识库侧 .*／\s*模型侧 /,                       // tally
    /^知识库侧 \*\*本次未参与\*\*/,                    // tally（库侧没读数那一支）
    /^ℹ️ 知识库侧给了 \*\*覆盖缺口\*\*/,               // covNote
    /^⚠️ 知识库侧另有 \*\*\d+ 条\*\*未并进本卡/,        // gapNote（kbN ≥ 3）
    /^⚠️ 知识库侧的结构化读数是 \*\*\d+ 条\*\*/,        // gapNote（kbN < 3）
    /^⚠️ \*\*本次知识库侧没有读数\*\*/,                 // noReadNote
    /^⚠️ 另有 \*\*\d+ 条非权威候选线索\*\*/,            // candNote
    /^（问题数 \*\*\d+ ≥ 3\*\* ⇒ 按 PRD §5\.3\.3 只出分类汇总/,   // 汇总页脚
  ];
  // ── ★★ 2026-10-15：**这一组只在 `machine: true` 时生效** ──────────────────────
  //   为什么要分组：`J5 无块时原样透传` 钉着「信封不许改写正常回答」。第一版把这五类
  //   并进上面那张表，**当场把 J5 判红** —— 它的样本里有一张模型写的正经表格
  //   （`| a | b |` / `|---|---|`），被表行规则摘了。分组判据就落在那一条断言上：
  //     · 回复那条路（没有 `machineAnswer` 声明）⇒ 一个字都不许动；
  //     · 机器答案那一档 ⇒ 允许按**读数形状**逐行摘（真单见 `stripInternalNotes` 头注）。
  const MACHINE_RULES = [
    // （下面每一行都是照着真单逐行抄的，不是想出来的）
    //   起因：PASS 单那张卡里 `链侧 PASS ｜ 0 处问题…`、`引擎结论（照抄 ③b 模板）：…`、
    //   `行 reczz…｜结论=PASS｜回读=consistent`、`` `ok=true / mode=enforced…` `` 五类行
    //   **一条都不在上述形状里** ⇒ 逐行摘不掉 ⇒ 整段当卡片正文进了群
    //   （真单：`om_x100b62333eaaf0a8b050a29473b0030` 等 6 张 PASS 卡）。
    //   ⚠️ 仍**只认我们自己的固定前缀**（与上面同一条纪律）：不做「凡出现 PASS 就摘」
    //     那种泛化 —— 那会把模型正常转述的两轨结论一起摘掉。反向对照在 J13 段。
    /^链侧\s*(PASS|REVIEW|BLOCK|NEEDS_INPUT)/,          // 链侧态行
    /^引擎结论/,                                        // 引擎结论（照抄模板）
    /^行\s*\S+\s*｜\s*结论\s*=/,                        // 表行读数
    /^（未填）$/,                                       // 占位符行
    /^\|\s*项\s*\|\s*值\s*\|$/, /^\|\s*-{2,}\s*\|/,  // 表头 / 分隔行
    //   表行：整行以 `|` 开头，且**行内带读数标记**（`｜ PASS` / `问题数` / `置信度` /
    //   `判定主体` / `mode=`）才摘 —— 只看「是不是表格」会把模型写的正经表格一起摘掉。
    /^\|[^\n]*(?:｜\s*(?:PASS|REVIEW|BLOCK|NEEDS_INPUT)|问题数|置信度|判定主体|mode=)/,
    /^\|\s*上一次\s*\|/, /^\|\s*这一次\s*\|/,         // 差异表那两行（标题就说明它是读数）
    /^`(?:ok|mode|red_total)=/,                          // 引擎读数键=值
    // ⚠️ **刻意不收**：`0 条 findings ⇒ …` / `未命中 ≠ 合规；…` / `判定输入只有本机 OCR…` /
    //   `为什么变：不确定 —— …` —— 实测它们是**模型按口径写的边界声明**（有用、且本来就该说），
    //   不是内部读数。收进来会把有用的部分一起摘掉（那正是「拦得比该拦的多」）。
  ];
  const ACTIVE = machine ? RULES.concat(MACHINE_RULES) : RULES;
  const removed = [];
  const out = [];
  for (const line of src.split('\n')) {
    const t = line.trim();
    // ★ 查证笔记的**整段**（`agent.mjs` 的 chainBlock 里那一段）——
    //   模型把整段抄下来时，这一条比逐行认更早兜住（含它自己的首尾标记）。
    if (/^【★ 我的查证笔记/.test(t)) { removed.push(line); continue; }
    if (/^【★ 查证笔记结束】/.test(t)) { removed.push(line); continue; }
    // ★ 2026-10-15：**卡片自己的渲染注记**（`（已收起 N 条证据：…）`）也是我们自己产出的
    //   （`registry.renderText` 那一路，`hasSubstance` 的 ③e 早就把它当「不是内容」）。
    //   实测：模型把台账正文整个转述进卡面时，连这一行一起抄了进来 ⇒ 卡上出现
    //   「（已收起 1 条证据：证据 · 1 条）」**两遍**（一遍是真折叠区、一遍是转述）。
    if (/^[（(]已收起\s*\d+\s*条证据/.test(t)) { removed.push(line); continue; }
    if (ACTIVE.some((re) => re.test(t))) { removed.push(line); continue; }
    // ★★ 2026-10-15：机器答案那一档**再拆两层段落** —— 见 `machineReadingPara`。
    if (machine && !t.startsWith('[[card:')) {
      // 占位符行（`（未填）`）在这一档也算读数 —— `hasSubstance` 早就把它当占位符，
      // 这里原先只在 `MACHINE_RULES` 里认「整行正好是它」，模型带前后空格就漏（实测漏了一行）。
      if (/^[（(]\s*(?:未填|无|空)\s*[）)]$/.test(t)) { removed.push(line); continue; }
      // `cardField` 是**模型给的卡片字段**那一档（`machineAnswerFold` 用）：
      //   那几格里没有「模型写给人的整段话」，只有转述出来的读数
      //   ⇒ 段落拆分时把**短残句**（`< 12` 字、去掉读数句以后剩下的尾巴）一并摘掉。
      //   ⚠️ 默认 `false`：`autoCard` 那条路喂进来的是**模型写的整段回复**，
      //     那里一个字都不许多摘（J13a3 / J13a3c 两条反向对照钉着）。
      const cut = machineReadingSentences(t, { dropFragments: cardField });
      if (cut === null) { removed.push(line); continue; }        // 整段是读数 ⇒ 整行摘
      if (cut !== t) { removed.push(line); out.push(cut); continue; }   // 只摘掉段里那几句
    }
    out.push(line);
  }
  if (!removed.length) return { text: src, removed: [] };
  // 段落级摘除会留下空行 ⇒ 与上面同为「不许出现连续两个空行」（J 段的分段判据也钉着它）
  return { text: out.join('\n').replace(/\n{3,}/g, '\n\n').trim(), removed };
}

/**
 * **一个内容行里的读数句**该摘到哪里？（只在 `machine: true` 那一档用）
 *
 * 返回值三态，调用方照它决定「整行摘 / 摘几句 / 一行不动」：
 *   · `null` —— 整行都是读数 ⇒ 整行摘；
 *   · 另一个字符串 —— 读数句已摘掉（可能摘空 ⇒ 回空串）；
 *   · **原样的字符串** —— 一行都没命中 ⇒ 一个字不动。
 *
 * ── 为什么要拆到「句」
 *
 *   实测那一段（真单 `om_x100b623de32b9c84cebb3cd965d312f`）是**混排**的：
 *
 *     `未命中 ≠ 合规（是「未发现已知底线风险」，不是「已证明合规」）；`   ← 模型按口径写的边界声明，**要留**
 *     `② 自命中检查真跑过、结果为「未命中」（归一化 638 字、扫过 209 条…）；`  ← 读数，摘
 *     `层前置 L4/L5/L6 各 1 项黄＝预演落章（E5）＝机制证据…`              ← 读数，摘
 *
 *   整段判 ⇒ 要么把边界声明一起丢掉（拦得比该拦的多），要么把读数放出去。
 *   ⇒ 按 `；` 拆句，**逐句判**，分号原样接回去（不改写一个字）。
 *
 * ── 判据（**机械形状，不做语义猜测**，与上面同一条纪律）
 *
 *   一个内容行里同时出现**管道分隔**与**内部读数标记**（枚举 / 段位 / 全角管道 / 反引号键值）
 *   ⇒ 判它是读数段。实测该判据对本单 5 段命中 4 段，
 *   **留下的那一段正是模型按口径写的边界声明**（`未命中 ≠ 合规…`，要留）。
 *
 * ⚠️ 只认**枚举与标识符**，不认「凡出现 PASS 就摘」那种泛化 —— 那会把模型
 *   如实转述的两轨结论一起摘掉（`stripInternalNotes` 头注里那条纪律，J13 反向对照钉着）。
 *
 * @param {string} t 已经 `trim()` 过的一段
 */
function machineReadingSentences(t, { dropFragments = false } = {}) {
  const para = s(t).trim();
  if (!para) return para;
  // ⚠️ 护栏一：**卡片块那一行绝不许认**。`[[card:…]]` 是**单行**的 JSON
  //   （字段里的换行是转义过的 `\n`），而它里面什么都有 —— 实测验过：不加这一条，
  //   它被整行摘掉 ⇒ `extractCardBlock` 找不到对象 ⇒ 卡片降级成
  //   「我这次没能把回答组织成卡片（标记后没有对象）」那句兜底话。
  //   卡面里的读数**另有执行点**（`machineAnswerFold`），不必、也不能在这一层摘。
  if (para.startsWith('[[card:')) return para;
  // ⚠️ 护栏三 ★★ 2026-10-16：**卡块 JSON 本体那一行也绝不许改写。**
  //   护栏一只认「**本行**以 `[[card:` 开头」，而块标记与 JSON **经常不在同一行** ——
  //   `toCardOrText` 的夹具与真模型输出都是 `[[card:kind]]\n{…}` 这个形状。
  //   于是 JSON 那一行**没有任何护栏**，只剩下面那条 `> 800` 侥幸挡着。
  //   实测（写 J13a3f 夹具时撞到）：一份 **769 字**的卡 JSON（< 800 ⇒ 护栏二不生效）
  //   被下面的 `split('；')` 摘掉「读数句」⇒ **JSON 当场破掉** ⇒ `extractCardBlock`
  //   报「对象括号没配平」⇒ 整条卡**降级成纯文本**发出。
  //   ⚠️ 线上至今 **0 次**（`ws_outbound.jsonl` 里「没能把回答组织成卡片」= 0）——
  //     因为真卡的 JSON 都超过 800 字、被护栏二挡住了。**这是个潜伏缺陷，不是已发事故。**
  //   判据形状收得很紧：**整段是合法 JSON 对象**才算（一段散文不可能同时又解析成 JSON）。
  if (/^\s*\{[\s\S]*\}\s*$/.test(para)) {
    try { JSON.parse(para); return para; } catch { /* 不是完整 JSON ⇒ 照旧往下走 */ }
  }
  // ⚠️ 护栏二：**只对「像一段话」的长度生效**。卡片块之外，一行几百上千字的多半是
  //   别的机器产物（JSON / 日志行），不是给人读的段落 —— 摘它风险大于收益。
  if (para.length > 800) return para;
  if (!machineReadingPara(para)) return para;
  // 单句 / 两句的段落：整段就是读数，不必拆（拆了也只剩残句）。
  const sentences = para.split('；');
  if (sentences.length < 3) return null;
  // 三句以上：按句判，读数句摘掉，其余原样接回去。
  //   ⚠️ 残句必须一起摘：`…；P0/P1/P2/P3 计数全 0。★ 要紧的一点：…` 这一句的中段
  //     是读数、后段是模型话，按 `；` 切完只剩「P0/P1/P2/P3 计数全 0。」这种碎渣
  //     上卡比读数还难读。判据：**同一段里摘掉过东西 + 剩下的残句短于 12 字**
  //     ⇒ 它本来就是那一句的尾巴，一并摘（摘下来的原文同样进折叠区）。
  const kept = [];
  const dropped = [];
  for (const sentence of sentences) {
    if (machineReadingPara(sentence)) { dropped.push(sentence); continue; }
    kept.push(sentence);
  }
  if (!dropped.length) return para;
  const body = dropFragments ? kept.filter((x) => x.trim().length >= 12) : kept.slice();
  const crumbs = dropFragments ? kept.filter((x) => x.trim().length < 12) : [];
  dropped.push(...crumbs);
  if (!body.length) return null;
  return body.join('；').replace(/^[；\s]+|[；\s]+$/g, '').trim();
}

/**
 * 单独一段**是不是**读数段。判据见 `machineReadingSentences` 头注。
 *
 * @param {string} para 已经 `trim()` 过的一段（一句或一整段）
 */
function machineReadingPara(para) {
  const t = s(para).trim();
  if (!t) return false;
  if (t.startsWith('[[card:')) return false;      // 护栏一，同 `machineReadingSentences`
  if (t.length > 800) return false;               // 护栏二，同 `machineReadingSentences`
  const PIPE = /[｜|]/;
  // 枚举值：`状态 PASS` / `| 这一次 |` 那种；**必须与管道同段**才算数（单出现一个词不算）
  const ENUM = /[｜|]\s*(?:PASS|REVIEW|BLOCK|NEEDS_INPUT)\b/;
  const TALLY = /(?:问题数|置信度|判定主体|回读|结论|状态)\s*[=｜|]/;
  // 段位名与开关：`heuristic_not_calibrated`（置信度档位）、`--content-type text`（引擎开关）、
  // `四道审计`/`预演落章`（闸门读数）、`source_sha256`/`record_id`（坐标与指纹）。
  // ⚠️ **容得下空格**：实测那一句写的是「四道审计红 0」而不是「四道审计红0」——
  //    精确匹配那版在真单上**一个字都没命中**（判据写对了、够不着真实文本，本项目的经典形状）。
  //    所以机械词表一律允许词与数字之间夹空白，不改语义（仍只认这几个词）。
  const MARK = /heuristic_not_calibrated|--content-type|source_sha256|record_id|四道审计\s*[红0-9]|预演落章|层前置\s*L[4-7]|red_total/;
  // ★★ 2026-10-15 第二次收窄（实测那一段**一个管道都没有**，第一版判据够不着）：
  //   真单那一整段里既有 `sha256 \`2e4e7a24…\``（反引号里的**指纹**）、`--content-type text`、
  //   `四道审计红 0`、`预演落章（E5）`，也有一句**模型按口径写的边界声明**
  //   （`未命中 ≠ 合规…`）。逐词摘会把手写句子打断，整段留又会把读数放出去。
  //   ⇒ 判据取**两种信号同时出现**：段里有**反引号包的机械标识**（指纹 / 开关 / 段位），
  //     **并且**段里有读数标记。单有反引号不算（模型正常引用路径/字段名时也打反引号）。
  //   为什么这一条是安全的：反引号在本仓文案里只用来包**标识符 / 路径 / 枚举**
  //   （`cards.mjs` 那条注释同源），给业务同事看的话里不会出现「指纹 + 开关」这种东西。
  //   ★★ 2026-10-15 第三次收窄（前两版都在**反引号里的形状**上够不着真实文本）：
  //     真单里那些反引号包的是 `status=error` / `ok=None` / `ok=true / mode=enforced / red_total=0`
  //     / `NEEDS_INPUT` —— 全是**键值、开关、态名**，而前两版只认「纯下划线词 / --flag / 十六进制」，
  //     于是 `TICKED` 恒为 false，整条判据一次都没生效（判据写对了、够不着真文本，本项目的经典形状）。
  //     ⇒ 认「反引号里的内容含 `=` / 连字符 / 下划线 / 全大写态名」这一组**机械形状**。
  const TICKED = /`[^`]*(?:[=_-]|[A-Z]{2,})[^`]*`/;
  if (TICKED.test(t) && MARK.test(t)) return true;
  if (PIPE.test(t)) return ENUM.test(t) || TALLY.test(t) || MARK.test(t);
  // ★★ 2026-10-15：**没有管道的短残句**也算 —— 实测 `…；P0/P1/P2/P3 计数全 0。★ 要紧的一点：…`
  //   这一句按 `；` 切开之后，剩下的正是「P0/P1/P2/P3 计数全 0。」：读数**不在行首**
  //   （行首是「P0/P1/P2」），也没有管道 ⇒ 前面每一版判据都够不着。
  //   判据取两个机械条件同时成立：**段里有读数标记** 且 **段短于 30 字**。
  //   ⚠️ 阈值不放宽（60 字那种就不摘了）——放宽会把模型写的短句一起摘掉，
  //     那是「拦得比该拦的多」（J13a3c 反向对照钉着）。
  return MARK.test(t) && t.length < 30;
}

/**
 * 这段文本**还有没有给人看的实质内容**？（纯函数，只给「机器答案」那一档用）
 *
 * 实测的形状（2026-10-15 批跑三张 PASS 卡，逐字取自 `ws_outbound.jsonl`）——
 * 除了权威结论行，剩下的**每一行都是我们自己的读数**：
 *
 *     （未填）                                            ← 占位符
 *     行 reczz28NamxLZylu｜结论=PASS｜状态=PASS｜回读=consistent   ← 表行读数
 *     引擎结论（照抄 ③b 模板）：状态 PASS ｜ 问题数 0 ｜ 置信度 0.93…  ← 机器答案（管道分隔）
 *     链侧 PASS ｜ 0 处问题（只对 9 行 OCR 文字）；画面看不到、未审
 *     `risk_items` 为空（问题数 0）⇒ 没有可给的条款号/命中片段…
 *
 * ★ 判据分三层，**一层比一层宽**，任何一层命中就算「这一行不是给人看的」：
 *   ① **空行**；
 *   ② **占位符行** —— 只有 `（未填）` / `(未填)` / `—` / `-` / `（无）` 这类；
 *   ③ **读数行** —— 含管道分隔且带态标（`｜ PASS`）、或含 `` `键` `` + 比较/箭头
 *      （`` `ok=true / mode=enforced…` ``、`` `risk_items` 为空… ``）、或 `回读=` / `结论=` / `状态=`。
 *
 * ⚠️ 为什么必须留一层「实质内容」的活路：批跑里**链跑挂**时，模型那一段是真答复
 *   （`这条链这次没跑成，所以我按能读到的部分给你三条建议…`）—— 那时**要上卡**。
 *   三层都是**机械可判**的形状，不做语义猜测（与 `stripInternalNotes` 同一条纪律）。
 */
export function hasSubstance(text, { exclude = null } = {}) {
  const lines = s(text).split('\n').map((l) => l.trim()).filter((l) => l !== '');
  const placeholder = /^(?:[（(]\s*(?:未填|无|空)\s*[）)]|[—–-]{1,3})$/;
  //   ③e ★ **卡片自己的渲染注记**（`（已收起 N 条证据：…）`）—— 它是 `renderText` 产出的、
  //       描述「这张卡长什么样」的一行，不是内容。实测它正好是最后一条挡住判定的行。
  const renderNote = /^[（(]已收起\s*\d+\s*条证据/;
  //   ③b ★ **管道分隔的行**（`引擎结论（照抄 ③b 模板）：状态 PASS ｜ 问题数 0 ｜ 置信度 0.93`）——
  //       实测漏网的正是这一种：它后半句是长解释，`｜` 与态标都不缺，所以单列一条。
  //   ③c ★ **反引号键 + 比较符**（`` `ok=true / mode=enforced / red_total=0` ``、
  //       `` `risk_items` 为空… ``）—— **键长不限**，这是实测踩到的那一版
  //       （第一版写成 `` `[^`]+` `` 紧跟符号，于是 `` `risk_items` 为空 `` 漏了，卡上就留着它）。
  const KEYS = /(?:^|[（(\s，。；：])(?:[A-Za-z_][A-Za-z0-9_]{2,}|红|结论|状态|问题数|置信度|回读|命中|依据|条款号|模式|判定)\s*(?:=|为空|为 |⇒|→|＞|>)/;
  //   ③d ★ **反引号包着的键** —— 单独一条，不跟比较符绑：实测 `` `risk_items` 为空 `` 里
  //       键与「为空」之间没有比较符，前一版把两者写在一个正则里就漏了它。
  //       反引号在我们的文案里只用来包**标识符/路径/枚举**（`kb/l7/...`、`AD-2025...`、`ok=true`），
  //       那不可能是给业务看的话 —— 所以「整行含反引号」本身就是读数信号。
  const reading = (l) => /[｜|]/.test(l)
    || KEYS.test(l)
    || /`[^`]+`/.test(l)
    || /回读\s*=|结论\s*=|状态\s*=/.test(l)
    || /^引擎结论/.test(l) || /^链侧 /.test(l);
  //   ★ **权威结论行自己不算内容** —— 它上面已经进了抬头（`verdict53.line`），
  //     不排掉它的话，这一判据对每一张评审单都会答「有内容」（实测踩到：就是这样一直挡着）。
  const ex = s(exclude).trim();
  return lines.some((l) => l !== ex && !placeholder.test(l) && !reading(l) && !renderNote.test(l));
}

/**
 * **PASS 单只留一句话结论** —— 把卡面正文整块收掉（纯函数，Owner 2026-10-16 裁定）。
 *
 * ── Owner 原话（逐字）
 *
 *   看到修好的那张 PASS 卡之后：「**只需要一句话结论，去掉『DeepClean Lite 教程』和证据**」。
 *   他指的两样是：模型那句原话（`「DeepClean Lite 教程」视频封面：链侧 PASS/0；本轮无合并稿`）
 *   与下面那个 `证据 · 7 条` 折叠区。
 *
 * ── 为什么在**卡这一层**收口，而不是清 `data`
 *
 *   `cards.mjs` 的 `query-answer` 构造器**恒定**推一个 `md(s(d.verdict))` ——
 *   清空 `verdict` 只会印出 **`（未填）`**（那正是 FIX-037 刚修掉的东西）。
 *   所以在建完卡之后把 `body.elements` 收空：**与构造器无关**，
 *   `validateCard` 只要求它是**数组**（空数组合法），`capSections` 对 0 段是空操作。
 *
 * ── 边界（三条，缺一条就会伤到别的卡）
 *
 *   ① **只认权威结论行给的态**：`verdict53.state === 'PASS'` 且 `line` 非空。
 *      闲聊、链没跑成（`verdict53` 为 null）、REVIEW / BLOCK —— **一个字不动**
 *      （它们的逐条块是 PRD §5.3.2+ 的格式件，PRD §5.3.1 才是「只有一句话」）。
 *   ② **砍的是卡面，不是内容**：调用方把 `stripped` / `chars` 记进 `moved`；
 *      原文仍在模型那一轮的回复里（会话记忆 ／ 批跑留档），报告与表行照旧是全份。
 *   ③ **本来就没有正文的卡不许记一笔**（`stripped: 0`）—— 否则日志会把
 *      「什么都没砍」说成「砍了 N 块」。
 *
 * @param {object} card 已经建好的卡
 * @param {{state?:string,line?:string}|null} verdict53 权威结论行
 * @returns {{card:object, stripped:number, chars:number}} `stripped` = 收掉的顶层块数
 */
export function passOnlyLine(card, verdict53) {
  const line = s(verdict53?.line).trim();
  if (!card || String(verdict53?.state ?? '').toUpperCase() !== 'PASS' || !line) {
    return { card, stripped: 0, chars: 0 };
  }
  const els = card.body?.elements;
  if (!Array.isArray(els) || !els.length) return { card, stripped: 0, chars: 0 };
  //   计字数用**文本内容**，不用 JSON 长度 —— 后者把标签与引号也算进去，
  //   日志里那个数会明显大于人眼看到的（`chars` 是给人核的，不许虚高）。
  const textOf = (e) => (typeof e?.content === 'string' ? e.content : JSON.stringify(e ?? ''));
  const chars = els.map(textOf).join('').length;
  return { card: { ...card, body: { ...card.body, elements: [] } }, stripped: els.length, chars };
}

/**
 * **机器答案那一档：模型自己给的卡也要按行摘读数**（2026-10-15，真单第七张 PASS 卡）。
 *
 * ── 它补的是 `machineAnswer` 的**下半条路**
 *
 *   `machineAnswer` 原先只在 `autoCard` 那一支生效（**模型没给卡**、代码自己建卡）。
 *   而模型**给了卡**时，走的是「模型的卡照用」那一支 —— 声明接不上，
 *   那一轮的 `res.reply` 里全是我们自己的读数，被模型**转述进了卡面**
 *   （`title` / `verdict` / `reasoning` 三格），**一个字都没被摘**。
 *
 * ── 实测（真单，逐字取自 `PMO/logs/ws_outbound.jsonl` 第 1073 行）
 *
 *   `MC-US-AMZ-B0G647K9TN`，17:20 那张卡 · 模型给的是 `query-answer` 卡：
 *     · 卡面正文＝`状态 PASS ｜ 问题数 0 ｜ 置信度 0.93（`heuristic_not_calibrated`…）`、
 *       `（未填）` 表格碎片、`--content-type text`、`四道审计红 0`、
 *       `feishu_publish.py --apply 退出码 1`、`source_sha256`、`record_id`、
 *       `行 reczz…｜结论=PASS｜回读=consistent`；
 *     · 结论行**印了两遍**（抬头一次、正文首行又一次）。
 *   ⇒ `machineAnswer: true` 在这一单上**等于没传**。
 *
 * ── 判据：**只摘读数行，一个字的模型话都不许丢**
 *
 *   摘下来的字段**整体进折叠区**（`foldIn`）—— 与 `stripInternalNotes` 同一条纪律
 *   （那几行有明确归属：会话记忆里还有一份，所以摘掉比整条拦下代价小得多）。
 *   ⚠️ 与 J13a3c 那条反向对照同源：**链跑挂时模型那段是真答复**，它没有读数形状
 *   ⇒ 一行都摘不掉 ⇒ 原样留下。
 *
 * @param {string} kind 当前卡片类型（决定折叠区落在哪个字段）
 * @param {object} data 模型给的卡片数据
 * @param {{line:string}|null} verdict53 权威结论行
 * @returns {{data:object, moved:object[]}}
 */
function machineAnswerFold(kind, data, verdict53) {
  const line53 = s(verdict53?.line).trim();
  const moved = [];
  let d = { ...data };
  // 可见的字符串格 —— 与 `carryCardText` / `scrubInternal` 同一组字段，不另立一份清单
  // ★ 2026-10-16：补 `boundary`（第 8/9 张 PASS 卡那两张的 `boundary` 也是读数形状：
  //   `链的 PASS 覆盖面来自 covered_by=case；画面结论只依据那份读数`）。
  //   ⚠️ 它 2026-10-13 起已「整格不上卡」，所以这一条**今天看不出效果** ——
  //     加它是因为清洗清单若漏格，将来谁把 `boundary` 放回卡面就又漏一次
  //     （同一天在 `fields` 上栽的就是这个形状）。
  for (const f of ['title', 'verdict', 'reasoning', 'wrong', 'verdict_text', 'boundary']) {
    if (typeof d[f] !== 'string' || !d[f].trim()) continue;
    const before = d[f];
    const st = stripInternalNotes(before, { machine: true, cardField: true });
    let after = st.text.trim();
    // ★ 结论行**独占抬头**（与 `autoCard` 那一支同一条口径）：正文里再印一遍就是重复。
    //   ⚠️ 只在摘完**还剩别的内容**时才摘 —— 否则会留下一个空组 / 空白正文
    //   （真单 `om_x100b62372ba…` 那类混排单：结论行底下还有「差异：…」「为什么变：…」要留）。
    if (line53 && after.includes(line53)) {
      const cut = after.split(line53).join('').replace(/\n{3,}/g, '\n\n').trim();
      if (cut) after = cut;
    }
    // ★★ 2026-10-15（真单 `MC-US-YT-_xyLF4_AgAw-IMG`，Owner 报「格式跟 prd 不符」）：
    //   **过期的结论行也必须摘掉** —— 不只是「权威那一行印了两遍」这一种。
    //   病灶：那一轮模型转录的是**当时的旧读数**（`【审查结论：REVIEW】共发现 1 处需人工确认。`），
    //   而权威结论行现在是 §5.3.1 的一句 **PASS**（Owner：「没有命中就是 pass」）
    //   ⇒ 同一张卡上**两个互相打架的三态**。这与 FIX-009 是同一条口径：
    //   **三态只许出现在结论行一处**（逐条里挂「判定：REVIEW」当年也是这么被判红的）。
    //   ⚠️ 摘的是**结论行那几行字**，不是「模型的话」：它本来就是**我们读数**的转述
    //     （`machineAnswer` 声明的就是这一件事），原文仍在会话记忆里 —— 一个字没丢。
    //   ★ 同一把尺子再往前一步：**光秃秃的三态重述**（`REVIEW：1 处＝…` 这种，
    //     连 `【审查结论】` 标记都不带的）也是同一件事 —— 它是模型对我们读数的**转述**，
    //     而权威那一行已经把态说死了（真单那一条正是 `REVIEW：1 处＝覆盖缺口本身…`，
    //     挂在 PASS 抬头下面）。判据形状**收得很紧**：必须是**行首的三态词紧跟冒号**，
    //     免得误伤「REVIEW 那一档要人看」这类正常句子里提到三态词的话。
    const STALE_STATE_RE = /^\s*(?:【审查结论\s*[：:]|(?:PASS|REVIEW|BLOCK|NEEDS_INPUT)\s*[：:])/;
    if (STALE_STATE_RE.test(after)) {
      const kept = after.split('\n').filter((l) => !STALE_STATE_RE.test(l));
      // 整格都是这些 ⇒ 摘空（下面那条分支会把这格摘空并留痕，不会留一个空组）
      after = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    }
    if (after === before.trim()) continue;
    // ★ 折进卡面的**只有真内容**：`（未填）` 这类占位符、以及摘完剩下的**短残句**
    //   （`< 12` 字、且整格已无实质内容时），折进去只是把噪声换个地方显示
    //   （实测：折完之后卡面上又冒出一行 `（未填）`）。
    const keep = st.removed.filter((x) => s(x).trim() && !/^[（(]\s*(?:未填|无|空)\s*[）)]$/.test(s(x).trim()));
    if (!after) {
      // 整格都是读数 ⇒ 摘空；摘掉的原文跟着折叠区走，不丢
      d = { ...d, [f]: '' };
      moved.push({ field: f, to: keep.length ? '(折叠区)' : '(不进公开格)', chars: len(before),
                   why: `批跑的机器答案：这一格整格是内部读数（${st.removed.length} 行），`
                      + '不上卡（原文仍在折叠区与这一轮的记忆里）' });
      if (keep.length) d = foldInto(kind, d, keep.join('\n'), moved, f);
    } else {
      d = { ...d, [f]: after };
      moved.push({ field: f, to: '(同格·摘行)', chars: len(before) - len(after),
                   why: `批跑的机器答案：摘掉 ${st.removed.length} 行内部读数（其余内容一句没动）` });
    }
  }
  // ══════════════════════════════════════════════════════════════════════════
  // ★★ 2026-10-16（第 8/9 张 PASS 卡，Owner：「按照 prd 一句话结论，现在格式不对」）：
  //    **`fields[]` 是第三个读数入口 —— 上面那张字符串清单一个都够不着它。**
  // ══════════════════════════════════════════════════════════════════════════
  //   实测（`PMO/logs/ws_outbound.jsonl` 第 1266 / 1270 行，两张 PASS 卡）：
  //   卡面正文里的读数**全在 `fields[].value` 里** —— `链的口径：…` / `链侧三态 = …` /
  //   `未命中 ≠ 合规：…` / `链侧：「飞书那一步：没有做」…`，
  //   而清洗清单（`title`/`verdict`/`reasoning`/`wrong`/`verdict_text`）里没有 `fields`
  //   ⇒ 清洗**一次都没跑**，读数原样上了卡面。
  //   ⚠️ **为什么昨天修了两遍还漏**：FIX-020（15:11）与 FIX-025（17:45）的复现件
  //     `.probe_pass_card_20261015.mjs` 造的是**只有 title/verdict/reasoning 三格**的卡；
  //     **真卡多带一个 `fields`** —— 那一格恰好落在两次修复的缝里
  //     （昨晚 20:12 / 20:19 两张卡已经在修复生效之后照样漏，见台账 1190 / 1197 行）。
  //   ★ 判据与字符串格**同一把尺子**（`stripInternalNotes` ＋ `hasSubstance`，不新造）：
  //     · 洗后**还有实质内容** ⇒ 留下（模型写的话一句不丢，J13a3c 那条反向对照同源）；
  //     · 洗后**没有实质内容** ⇒ 这一格整格是读数 ⇒ **整格不留**
  //       （值都没了、只剩一个标签，印出来只是噪声 —— 与 `autoCard` 那一支同一条口径）。
  //   ⚠️ 摘下来的原文照旧进折叠区（`foldInto`）——「搬是搬，砍是砍」，一个字不丢。
  if (Array.isArray(d.fields) && d.fields.length) {
    const kept = [];
    const dropped = [];
    for (const f of d.fields) {
      // 非对象 / 值不是字符串 ⇒ 原样留着（不猜、不动）
      const raw = (f && typeof f === 'object' && typeof f.value === 'string') ? f.value : null;
      if (raw === null || !raw.trim()) { kept.push(f); continue; }
      const before = raw;
      const st = stripInternalNotes(before, { machine: true, cardField: true });
      const after = st.text.trim();
      if (after && hasSubstance(after)) {
        if (after !== before.trim()) {
          kept.push({ ...f, value: after });
          moved.push({ field: 'fields', to: '(同格·摘行)', chars: len(before) - len(after),
                       why: `批跑的机器答案：摘掉 ${st.removed.length} 行内部读数（其余内容一句没动）` });
        } else kept.push(f);
        continue;
      }
      // 整格是读数（或被洗空）⇒ 这一格不留
      dropped.push({ name: s(f.name ?? f.label ?? f.title).trim() || '(无标签)', text: before });
    }
    d = { ...d, fields: kept };
    if (dropped.length) {
      const beforeFold = d;
      d = foldInto(kind, d, dropped.map((x) => `【${x.name}】\n${x.text}`).join('\n\n'), moved, 'fields');
      // ★ 落点照实记：`foldIn` 没地方放时会**原样返回**（`foldInto` 里那条 `to === null` 分支）
      //   ⇒ 不能一律写「进折叠区」，否则日志会把「没折成」说成「折成了」。
      const landed = d !== beforeFold;
      for (const x of dropped) {
        moved.push({ field: 'fields', to: landed ? '(折叠区)' : '(不进公开格)', chars: len(x.text),
                     why: `批跑的机器答案：这一格（${x.name}）整格是内部读数 ⇒ 不上卡` });
      }
    }
  }
  return { data: d, moved };
}

/** 把摘下来的原文折进折叠区（与 `scrubInternal` 同一条路，落点由 `foldIn` 定）。 */
function foldInto(kind, d, text, moved, from) {
  // ⚠️ `foldIn` 返回的是 `[data, to]` **元组**，不是对象 —— 当成对象展开会把
  //   卡片数据整体打散（实测：`.mjs` 里 `{...d}` 一展，`title/verdict/reasoning`
  //   全没了，卡直接建不出来，降级成「标记后没有对象」那句兜底话）。
  const [next, to] = foldIn(kind, d, `（原文照留：这一格是机器读数，不进公开卡面）\n${text}`);
  if (to === null) return d;                    // 没地方放 ⇒ 宁可留着读数，也不静默丢字
  moved.push({ field: from, to, chars: len(text), why: '摘下来的原文进折叠区（不丢字）' });
  return next;
}

/**
 * 自证用：一段输出里到底有没有残留内部标记。
 *
 * 两种泄漏必须分开判，因为**修法完全不同**：
 *
 *   文本层 —— 要发出去的正文（含降级文本）里出现 `[[card:` 或 `tool_calls` 之类，
 *             就是故障，一个字符都不许有。这是 2026-09-17 那条回复的同类。
 *   JSON 层 —— 卡片结构里出现内部标识，只有一种情况允许：它**在折叠面板内部**。
 *             折叠区是 `alert` 这个类型存在的理由 —— 内部详情必须有个地方放，
 *             否则模型只能往正文里写。判据是「公开格干净」，不是「整张卡干净」。
 *
 * @param {string} text 要发出去的文本
 */
export function leaksInternalMark(text) {
  const src = s(text);
  return /\[\[card:/.test(src)
      // ★ 判据只有一处：`lintCopy` 的 `internalLeak`。
      //   这里原先自带一条**更窄**的正则 —— 只认 `tool_calls|tool_call_id|finishReason|
      //   reasoning_tokens` 与 `"role":"tool"`，**连 `call_xxx` 与栈帧都不认**。
      //   而 J2 段正是用这个函数断言「发出去的文本里没有内部标记」：
      //   断言用的检测器比实际动作的判据还弱，等于给了它一张假的免罪符。
      || lintCopy(src).some((h) => h.id === 'internalLeak');
}

/** 公开格（非折叠区）的文本。自证用它断言「对方一眼能看到的地方」是干净的。 */
export function publicTextOf(card) {
  const out = [];
  const walk = (els, insideCollapse) => {
    for (const el of els ?? []) {
      if (el.tag === 'collapsible_panel') { walk(el.elements, true); continue; }
      if (insideCollapse) continue;
      if (el.tag === 'markdown') out.push(el.content ?? '');
      else if (el.tag === 'table') {
        out.push((el.columns ?? []).map((c) => c.display_name ?? c.name).join(' '));
        for (const r of el.rows ?? []) out.push(Object.values(r).join(' '));
      } else if (el.tag === 'column_set') for (const c of el.columns ?? []) walk(c.elements, false);
      else if (el.tag === 'code_block') out.push(el.text ?? '');
      else if (el.tag === 'plain_text') out.push(el.content ?? '');
    }
  };
  walk(card?.body?.elements, false);
  return [card?.header?.title?.content ?? '', card?.header?.subtitle?.content ?? '', ...out].join('\n');
}

/** 供 verify 与 CLI 用：哪些常量真的被读了 */
export const ENFORCED = { VERDICT_MAX, MAX_SECTIONS, KINDS: Object.keys(BUILDERS), validateCard, capSections };

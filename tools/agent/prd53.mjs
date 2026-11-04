/**
 * prd53.mjs —— **PRD §5.3 结论输出规范（四态）** 的判据（纯函数，无副作用）
 *
 * ── 为什么要有它（2026-10-06，Owner 在飞书私聊里发现三条回话格式不合规）
 *
 * 上游 PRD 从 v1.0 改到 v1.2 时，把 §5.3 拆成 5.3.1/5.3.2/5.3.3，并**引入了
 * `【审查结论：PASS/REVIEW/BLOCK】` 这个标记**（改动登记在
 * `PMO/守衡-上游第三版基线与影响登记-20260922.md` §5.3 那一行）。
 * 同一天，那份记录的第 317 行就把下面这个问句挂在那儿了：
 *
 *   > **② 新的三态输出规范（`【审查结论：…】` + 问题数分流）要不要落进回复卡片模版？**
 *
 * 当时的答案是「记在这里，**没有擅自改任何代码**」。半个月后 Owner 在群里看见的
 * 就是没落地的后果：链路侧其实**已经**按 5.3 产出了结论行（`review_gate.formatChainBlock`
 * 也写了「逐字转述，不许改写」），而**回卡片那一跳把表头改写掉了** ——
 * `【审查结论：REVIEW】共发现 1 处需人工确认。` 变成 `【证据】REVIEW：1 处问题（W-1.54 静音绝对化）`。
 *
 * ── 这一层是「判据」，执行点在 `reply-cards/envelope.mjs`
 *
 * 按 `AGENTS.md` §2.5「形态决策只能有一处」：**模型不写结论行，结论行由代码搬进去**。
 * 所以这里只回答两个问题 ——「链到底给了哪一行」「这一行合不合 5.3」——
 * 真正的改写动作在 `envelope.applyVerdictLine()`，唯一的调用链是
 * `ws_daemon.replyTo → toCardOrText`。
 *
 * ── 判据的边界（写清楚，免得下一轮有人拿它当万能尺）
 *
 *   · 只认 PRD §5.3 定义的四态：`PASS` / `PASS+SUGGEST` / `REVIEW` / `BLOCK`。
 *     `SUGGEST` 只是**旧解析别名**（规范化成 `PASS+SUGGEST`），**不是**四态之一 ——
 *     见下面 `STATES` 那段（2026-10-21 Owner 口径）。
 *     `NEEDS_INPUT`（依据侧拒答）**不在 5.3 里** —— 它没有规范行可搬，
 *     所以这里对它返回 `null`（不搬、也不编一行出来）。要不要给拒答开第七档，是**另一件**。
 *   · 措辞是**逐字**判的：REVIEW 必须是「需人工确认」、BLOCK 必须是「必须修改」。
 *     这一条不是洁癖 —— 引擎原先两态共用「需处理问题」，而 KB 那条判据只查到
 *     「共发现」为止，于是**跑了半个月没人发现**（`AGENTS.md` §2.4）。
 */

/**
 * 结论行的**状态标记**：**PRD §5.3.2 四态** = `PASS / PASS+SUGGEST / REVIEW / BLOCK`。
 *
 * ★★ 2026-10-21（Owner：「总共 4 态 pass / pass+suggest / block / review」；
 *   上游 PRD 同日 16:00 改到 rev 105）：**收回 2026-10-19 那版「SUGGEST 独立成态」**。
 *   PRD rev 105 三处同向，都在说「SUGGEST 是 **PASS 的附属**、decision 仍记 PASS」：
 *     · §5.3.2 内嵌表（sheet `xcdTpv`，rev 105）：**主状态**只列 `PASS / REVIEW / BLOCK`，
 *       PASS 行的**附属信息**写「可附带 `SUGGEST`（如措辞优化建议）」；
 *     · §6.3 规则 4：「无 P0、P1、P2 明确违规，仅存在 P3 SUGGEST 时，系统最终流转状态
 *       （decision 字段）输出为 **PASS**，同时在结论中附带 SUGGEST 建议清单」；
 *     · §5.3.4 那一档是**输出格式**（`【SUGGEST】发现 1 处建议优化，不阻断发布：…`），
 *       不是状态机 —— 它就是「四桶」里的第二桶。
 *   ⇒ 守衡的卡面 / 报告 / 台账**统一写 `PASS+SUGGEST`**；结论行里不再出现独立态 `SUGGEST`。
 *
 * ⚠️ `SUGGEST` 作为**解析别名**保留（`LEGACY_STATES`）：历史链答案、旧日志里那一行必须仍能
 *   被认出（否则判成「没拿到结论」⇒ 进补发队列重跑、表行记「未判」），但它**不合四态格式**
 *   （`conforms()` 会判红并说清为什么）。
 * ⚠️ 顺序：`PASS+SUGGEST` 必须排在 `PASS` 前面，前缀匹配才不会互相吃掉。
 */
export const STATES = ['PASS+SUGGEST', 'PASS', 'REVIEW', 'BLOCK'];

/** 旧字面（2026-10-19 ~ 10-21 用过）：只作**解析别名**，不是四态之一。 */
export const LEGACY_STATES = ['SUGGEST'];

/**
 * 任何来路的状态串 → 四态之一。
 *
 * 认不出的**原样大写返回**（不猜）：调用方拿它去 `conforms()` 时会被判出来。
 * @param {string} state
 * @returns {string}
 */
export function normState(state) {
  const u = String(state ?? '').trim().toUpperCase();
  return u === 'SUGGEST' ? 'PASS+SUGGEST' : u;
}

/** 结论行：从 `【审查结论：` 起到本行结尾。行内不许有换行（它是「一行结论」）。 */
const LINE_RE = /【审查结论：(PASS\+SUGGEST|PASS|REVIEW|BLOCK|SUGGEST)】[^\n]*/;

/**
 * ★★ 2026-10-26 两轮，**结论落定在「写旧字面、两种都认」**：
 *
 *   上午（Owner：「守衡的回复没有按照 prd 和原先的输出模版来回复」）把**写出去的**改成了
 *   PRD §5.3.4 样张字面 `【X】`；下午（Owner：「输出格式的问题，在 10/22 都是好的，
 *   恢复到 10/22 的输出格式」）**写回 `【审查结论：X】`** —— 那正是 10-22 卡面上的样子
 *   （`PMO/logs/ws_outbound.jsonl` 当天 70 条卡片逐条都是这个前缀）。
 *
 *   两件事因此**分开**，别再把它们合成一条：
 *     · **写出去的**（卡面 / 报告 / 表行）＝ `【审查结论：X】`（10-22 口径，Owner 2026-10-26 定）；
 *     · **读进来的**（引擎的答案、存量报告、历史记录、知识库侧的产物）**两种都认** ——
 *       上午那批已落盘的新字面、以及 KB 侧仍在产的旧字面，谁都不许因为写法读不出来。
 *
 * ⚠️ 判据不许只认一种：`conforms()` 两种情况都认（`headPrd ?? headLegacy`），
 *    而且前缀按**这一行自己的**写法拼回去 —— 这样 S7「拿引擎真输出过守衡那把尺子」
 *    不会因为两边写法不同就变红。**谁把这条收窄成一种，先看这段注释。**
 */
const LINE_RE_PRD = /【(PASS\+SUGGEST|PASS|REVIEW|BLOCK|SUGGEST)】[^\n]*/;

/** 取文本里**最先出现**的那一条结论行（两种写法混在同一段里时，按位置定先后）。 */
function firstLineMatch(text) {
  const s = String(text ?? '');
  const a = LINE_RE.exec(s);
  const b = LINE_RE_PRD.exec(s);
  if (!a) return b;
  if (!b) return a;
  return (b.index < a.index ? b : a);
}

/** 这一行是不是一条结论行（不认识内容、只认写法）—— 供发送层认「卡面第一行」用。 */
export function isConclusionLine(text) {
  return firstLineMatch(text) !== null;
}


/**
 * 从一段文本里取出**第一行** `【审查结论：…】…`。
 *
 * `state` **已规范化**（旧字面 `SUGGEST` ⇒ `PASS+SUGGEST`）；`token` 是行里**原样**那个词 ——
 * `conforms()` 用它判「是不是旧字面」。
 *
 * @param {string} text
 * @returns {{state:string, token:string, line:string, legacy:boolean}|null}
 */
export function conclusionLine(text) {
  const m = firstLineMatch(text);
  if (!m) return null;
  const token = m[1];
  const state = normState(token);
  return { state, token, line: m[0].trim(), legacy: token !== state };
}

/**
 * 这一行合不合 PRD §5.3 的**逐字措辞**？
 *
 * 判据按态分开，因为 PRD 对每一态是不同的话（rev 105 §5.3.4 四份模板）：
 *   · PASS         —— `【审查结论：PASS】未发现已知底线风险，可转交 @<负责人> 进行 sign-off`
 *   · PASS+SUGGEST —— `【审查结论：PASS+SUGGEST】发现 N 处建议优化，不阻断发布。`
 *   · REVIEW       —— `【审查结论：REVIEW】共发现 N 处需人工确认。`
 *   · BLOCK        —— `【审查结论：BLOCK】共发现 N 处必须修改。`
 *   （`SUGGEST` 是**旧字面**：解析得出来，但判不合四态格式 —— 见上面 `STATES` 那段。）
 *
 * @param {string} line
 * @returns {{ok:boolean, state:string|null, why:string}}
 */
export function conforms(line) {
  const s = String(line ?? '').trim();
  // ★ 两种写法都要认（见 `LINE_RE_PRD` 头注）：`【X】`（PRD §5.3.4 字面，我们现在**写这个**）
  //   与 `【审查结论：X】`（旧字面，知识库引擎仍在产）。**谁都不许只认一种** ——
  //   只认新式 ⇒ 引擎的真输出被我们的尺子判不合规（S7 会红，那是假红）。
  const headPrd = /^【(PASS\+SUGGEST|PASS|REVIEW|BLOCK|SUGGEST)】/.exec(s);
  const headLegacy = /^【审查结论：(PASS\+SUGGEST|PASS|REVIEW|BLOCK|SUGGEST)】/.exec(s);
  const head = headPrd ?? headLegacy;
  if (!head) {
    return { ok: false, state: null,
      why: '整行里没有【<态>】或【审查结论：<态>】标记（PRD §5.3.4 的样张是前者）' };
  }
  // 前缀按**这一行自己的**写法拼回去 —— 判据只此一处，不许每个态各写一份前缀。
  const P = headPrd ? '【' : '【审查结论：';
  const token = head[1];
  const state = normState(token);

  // 旧字面：**能解析、但不合四态格式**。四态第 2 态叫 `PASS+SUGGEST`（SUGGEST 是 PASS 的附属）。
  if (token !== state) {
    return { ok: false, state,
      why: '旧字面【审查结论：SUGGEST】—— PRD §5.3.2 的四态里第 2 态是「PASS+SUGGEST」'
        + '（SUGGEST 是 PASS 的附属信息，§6.3 规则 4 的 decision 仍是 PASS），不是独立主状态' };
  }

  if (state === 'PASS') {
    // ⚠️ 判据**不**要求 @ 后面是一个真句柄：`kb/l7/registry/l7.json` 的 approvers 现在是
    //    `configured: false`，库规要求此时输出「角色名（未配置）」。
    //    第一版写成 `@\S+ 进行 sign-off`，当场把**正确的**夹具判红 —— 会误报的判据比没有更糟，
    //    同一条已经在这套改动里踩过两次了（KB 侧 `l7_integrity.py` 两处）。
    const ok = new RegExp(`^${P}PASS】未发现已知底线风险，可转交 @\\S[^\\n]*进行 sign-off`).test(s);
    return { ok, state, why: ok ? '与 §5.3.1 逐字一致' : 'PASS 行必须含「未发现已知底线风险，可转交 @…进行 sign-off」' };
  }
  if (state === 'PASS+SUGGEST') {
    // ★★ 2026-10-21（四态第 2 态）：措辞取自 PRD §5.3.4 那一档样张 ——
    //   `【SUGGEST】发现 1 处建议优化，不阻断发布：…`。两处**故意**的差别：
    //     ① 态名写 `PASS+SUGGEST`（§5.3.2 主状态 PASS ＋ 附属 SUGGEST，Owner 2026-10-21 定）；
    //     ② 卡面是「结论行 ＋ 之下逐条」，所以句末是句号而不是冒号。
    //   「不阻断发布」**不许省** —— 那是它与 REVIEW 的唯一分界；
    //   「需人工确认／必须修改」是另外两态的措辞，出现就不合这一态。
    const ok = new RegExp(`^${P}PASS\\+SUGGEST】发现 \\d+ 处建议优化，不阻断发布(?:[：:].*|。)?$`).test(s);
    return { ok, state, why: ok ? '与 §5.3.4 样张逐字一致（四态第 2 态）'
      : 'PASS+SUGGEST 行必须是「发现 N 处建议优化，不阻断发布：…」（「不阻断发布」是它与 REVIEW 的分界，不许省）' };
  }
  if (state === 'REVIEW') {
    const ok = new RegExp(`^${P}REVIEW】共发现 \\d+ 处需人工确认。$`).test(s);
    return { ok, state, why: ok ? '与 §5.3.2 逐字一致' : 'REVIEW 行必须是「共发现 N 处需人工确认。」' };
  }
  const _okBlk = new RegExp(`^${P}BLOCK】共发现 \\d+ 处必须修改。$`).test(s);
  const ok = _okBlk;
  return { ok, state, why: ok ? '与 §5.3.3 逐字一致' : 'BLOCK 行必须是「共发现 N 处必须修改。」' };
}

/**
 * 这一行是不是出现在**整段回复的最前面**（跳过空行与 markdown 装饰）。
 *
 * ★ 只用来做**兜底**判据（见 `deriveVerdictLine` 的第 ③ 条）。判据这么窄是有原因的：
 *   「回复里任何地方出现一行 5.3 模板」不等于「这是一条审查结论」——
 *   有人问「PRD 5.3 里 PASS 长什么样」，守衡照抄一遍模板，那**不是**一次审查结论。
 *   排在最前面才算它自己在用这一行。
 */
export function leadsWith(text, line) {
  const rows = String(text ?? '').split('\n').map((x) => x.trim()).filter(Boolean);
  if (!rows.length) return false;
  const first = rows[0].replace(/^[*_>`\s]+|[*_`\s]+$/g, '');
  return first === String(line ?? '').trim();
}

/**
 * **PRD §5.3 的结论块**：从结论行起到**动作行**止（含）。
 *
 * ★ 2026-10-06 加（同一处事故的第二半）。只把**结论行**搬进标题是不够的：
 *   Owner 拿 PRD §5.3.3 的模板对照守衡发出去的 BLOCK 卡片 —— **抬头对了、逐条四要素整块没有**。
 *   根因是卡片的正文（`verdict` / `reasoning`）由**模型转述**，而模型会把一整块「逐条」
 *   压缩成一句「命中 W-1.18 与 W-1.13 两条 P0，不能发」。
 *   修法与结论行同一条（§2.5 的分工）：**模型不写这一块，代码搬**。
 *
 * 动作行按 PRD 的收尾认：BLOCK = `请修改后重新提交。`；REVIEW = `建议转 … 复核。`
 * 没有动作行 ⇒ 返回 null（**不搬半截**：半截块比不搬更容易被读成完整结论）。
 *
 * @param {string} text 链 / P0 快路给的结论原文
 * @returns {string|null}
 */
export function conclusionBlock(text) {
  const s = String(text ?? '');
  // ★ 2026-10-26：两种写法都认（我们自己现在写 `【X】`，引擎答案与存量件是 `【审查结论：X】`）。
  //   只认旧式 ⇒ 本仓自己产出的块会被判成「没有结论行 ⇒ 没有块」⇒ 报告链接那一行跟着消失。
  const head = firstLineMatch(s);
  if (!head) return null;
  const rest = s.slice(head.index);
  const m = /\n(?:请修改后重新提交。|建议转[^\n]*复核。)/.exec(rest);
  if (!m) return null;
  const block = rest.slice(0, m.index + m[0].length).trim();
  // 只有结论行、没有逐条（PASS 就是这样）⇒ 不算「块」，没什么可搬的
  return block.includes('\n') ? block : null;
}

/**
 * 由**显式条数**生成 §5.3 的结论行（纯函数）。
 *
 * ── 为什么需要它（2026-10-08，Owner 定的规则）
 *
 * Owner 的规则原话：「我在飞书侧 @守衡 提问后，双轨并行（知识库+模型），
 * **双轨按照 PRD ≧3 个问题输出报告链接到飞书文档**」。
 *
 * 查下来 PRD 那一侧**早就实现了**（`kb/l7/review-engine/core/feishu_publish.py`：
 * `REPORT_LINK_MIN_ISSUES = 3`，且留痕「10-03 曾改判为 0，Owner 裁定后已回退为 3」）。
 * 真正坏的是**口径**：一单里有**三个**「问题数」在打架 ——
 *
 *   | 数 | 来自谁 | 19:44 那单 | 19:08 那张图 |
 *   |---|---|---|---|
 *   | 卡片抬头那个数 | 链的结论原文（被 `conclusionLine` **正则抠**出来） | — | **12** |
 *   | 报告阈值读的数 | 机读旁挂 `issue_count` | **2** | 5 |
 *   | 人实际看到的条目 | 双轨合并条数 | **10** | 7 |
 *
 * 人看到 10 条 ⇒ 按规则该给链接；而阈值读的是 2 ⇒ `2 < 3` ⇒ 不生成报告 ⇒ **没有链接**。
 * 从人的座位上，这条规则就是没生效。
 *
 * ── 这个函数在「统一成一个数」里的位置
 *
 * 抬头那个 N 现在是**从链的正文里抠**出来的（`deriveVerdictLine` 第 ① 支），
 * 所以它天生就是「链自己的数」—— 这就是口径打架的根。
 * 把它变成**入参**之后，抬头、逐条块、报告阈值读的才是**同一个变量**。
 *
 * 这不是新发明：`deriveVerdictLine` 第 ② 支（P0 快路）**早就是**按显式条数派生一行
 * （用 `p0_fastpath.matched_patterns`）。这里只是把同一个形状补到双轨这一支上。
 *
 * @param {{state?:string, n?:number}} input
 * @returns {{state:string, line:string, conform:object}|null}
 *   派生不出来时回 `null` —— **绝不编一个 N**（§2.4：「共发现 ? 处」比不搬更坏）。
 */
/**
 * §5.3.1 的 **PASS 一句话结论**（纯函数）。
 *
 * ★★ 2026-10-15（Owner 裁定，原话：「**没有命中就是 pass**，按照 prd 的一句话结论走，
 *   **你不要自己定义**」）——
 *   这一档**没有逐条、没有计数、没有报告链接**，就是那一句话（形状与 `conforms()` 里
 *   §5.3.1 那条判据逐字一致，两处不许各写一份）。
 *
 * 收件人**不写死人名**（与 `routing.mjs` 同一条纪律：组织一变动，写死的人名就变成假话）：
 * 句柄配了就 `@句柄`，没配就 `@角色名（未配置）` —— 角色名默认取库侧
 * `kb/l7/registry/l7.json` 的 `approvers.pass_signoff.role`（=「sign-off 责任人」），
 * 与库侧 `review_engine.py::_at()` 逐字同口径。
 *
 * @param {{role?:string, handle?:string|null}} [o]
 * @returns {string}
 */
export function passLineFor({ role = 'sign-off 责任人', handle = null } = {}) {
  const who = handle ? `@${handle}` : `@${role}（未配置）`;
  // ★ 2026-10-26 二轮：写回 10-22 的字面（Owner：「恢复到 10/22 的输出格式」）。
  //   上午那版写的是 PRD §5.3.4 样张 `【PASS】…`，已按 Owner 当天下半场的选择撤回 ——
  //   读侧仍两种都认（`LINE_RE_PRD`），所以存量那些新字面的件不会读不出来。
  // 2026-10-26 下午（Owner：「输出格式的问题，在 10/22 都是好的，恢复到 10/22 的输出格式」）
  // ⇒ 写出去仍是旧字面【审查结论：X】（10-22 卡面逐条都是它）；PRD 字面【X】只做读侧兼容。
  return `【审查结论：PASS】未发现已知底线风险，可转交 ${who} 进行 sign-off。`;
}

export function verdictLineFor({ state, n } = {}) {
  const st = normState(state);
  const count = Number(n);
  // ★★ 2026-10-15（Owner）：「**没有命中就是 pass**」——
  //   PASS **本来就没有 N**，所以它不该被下面那条「N 不合法 ⇒ 不派生」挡住。
  //   病灶（真单 `MC-US-YT-_xyLF4_AgAw-IMG`）：两侧一条都没命中那一档，
  //   这里原先直接 `return null` ⇒ 拿不到 §5.3.1 那一行 ⇒ 只能回头抠链的正文，
  //   而链在那一档给的是 `【审查结论：REVIEW】共发现 0 处需人工确认。`（自己跟自己矛盾）。
  //   ⇒ 现在按 §5.3.1 **直接派生那一句话**。
  //   ⚠️ 只认「**合并读数 = 0**」这一种（Owner 的口径就是「**没有命中**就是 pass」）：
  //     条数**不进那一行**（§5.3.1 那句话里本来就没有 N），这里只拿它当**前提**。
  //     读不到（`null`/`undefined`）、坏读数、或与 PASS 自相矛盾的 `n > 0`
  //     ⇒ 照旧回 `null`（退回链那一行）—— `test_agent.mjs` 的 Z12/Z13 两条钉着不许松。
  if (st === 'PASS') {
    if (n !== 0) return null;
    const line = passLineFor();
    // ★ 2026-10-16（FIX-043 现场撞出来的第二处）：`conform` 的**形状必须与别处一致** ——
    //   它是 `{ok, state, why}`（`conforms()` 的原样产物），不是 `true`。
    //   这一支原先写的是 `conform: conforms(line).ok`（一个布尔）⇒ 发送层那一行
    //   `⚠️ 措辞不合 §5.3：${c.why}` 在**合规**时也会打出 `undefined`
    //   （实测 `ws_daemon.log`：`PASS（来自 dual-track-merged）… ⚠️ 措辞不合 §5.3：undefined`）。
    //   后果不在卡上，在**日志**：一句「措辞不合」配一个空原因 ——
    //   回退本来是最该看得见的东西，却被打成了一句读不出对象的话（§2.4.1 第 5 行）。
    return { state: 'PASS', line, conform: conforms(line) };
  }
  // 只认「≥1 的整数」：
  //   · `undefined` / `NaN` / 字符串 ⇒ 不派生
  //   · 小数、负数 ⇒ 不派生（那是坏读数，不是条数）
  //   · **0 ⇒ 不派生**。这一条是独立的判断，不是顺带：`mergedState()` 里
  //     「合并 0 条 + 库侧 REVIEW」会给出 REVIEW（覆盖缺口那一类），
  //     而 `【审查结论：REVIEW】共发现 0 处需人工确认。` **自己跟自己矛盾**。
  //     那时退回链那一行更诚实 —— 链自己数出了几条，就照它说。
  if (!Number.isInteger(count) || count < 1) return null;

  // ★★ 2026-10-21（四态第 2 态）：有建议、无强制问题 ⇒ **`PASS+SUGGEST`**。
  //   PRD §6.3 规则 4 的 decision 仍是 PASS（这一态就是「统计四桶」里的第二桶），
  //   而卡面 / 报告上的结论行**必须看得出「有建议」**，所以态名写全。
  //   ⚠️ 旧字面（`st === 'SUGGEST'`）走 `normState()` 已归到这一支 —— 一处也不许各写一份。
  if (st === 'PASS+SUGGEST') {
    const line = `【审查结论：PASS+SUGGEST】发现 ${count} 处建议优化，不阻断发布。`;
    return { state: 'PASS+SUGGEST', line, conform: conforms(line) };
  }

  let line = null;
  if (st === 'REVIEW') line = `【审查结论：REVIEW】共发现 ${count} 处需人工确认。`;
  else if (st === 'BLOCK') line = `【审查结论：BLOCK】共发现 ${count} 处必须修改。`;
  // PASS 已在上面的分支里派生（它没有 N）；拒答 / NEEDS_INPUT 不在 §5.3 里。
  else return null;

  return { state: st, line, conform: conforms(line) };
}

/**
 * **权威结论行**：这一轮该往卡片里搬哪一行。
 *
 * 四条来源，按可靠性排序（前两条是「链说的」，第三条是「模型自己排在最前面的」）：
 *
 *   ⓪ **双轨跑过 ⇒ 用双轨合并数派生**（2026-10-08 加）。
 *      为什么它排在最前：第 ① 支那个 N 是**从链的正文里抠**出来的，
 *      而人在卡片上看到的条目是**双轨合并**之后的 —— 两个数天然不等
 *      （实测 19:08 那张图：抠出来 12、合并 7、阈值读 5）。
 *      报告链接的门槛（PRD §5.3.4「问题数量 ≥3」）挂在哪个数上都不是重点，
 *      重点是**只能有一个数**：抬头、逐条块、阈值读同一个变量。
 *      ★ 传进来的数不合法（缺失 / 0 / NaN / 非整数）时**退回第 ① 支**，
 *        而不是编一个 N —— 派生是**加强**，不是取代兜底。
 *
 *   ① 链返回的结论原文里有 5.3 行 ⇒ **用它**。链是这条结论唯一的产者，也是唯一有权改它的人。
 *   ② 走的 P0 快路 ⇒ 按 §5.3.3 **派生**一行：`【审查结论：BLOCK】共发现 N 处必须修改。`
 *      为什么必须派生：P0 快路的抬头是 `【P0 红线拦截：BLOCK】`（那是**来路**标注，不是结论行），
 *      而 PRD §6.3 第一层明确「P0 命中即停并直接 BLOCK」—— 它就是一条 BLOCK。
 *      不派生的话，P0 这条永远拿不到 5.3 的结论行，而它恰恰是最该被一眼看懂的一态。
 *   ③ 都没有、但模型自己把一行 5.3 结论摆在回复最前面 ⇒ 用它的。
 *      （补发队列重跑那一跳拿不到 `meta`，这是给那条路留的兜底。）
 *
 * @param {{answer?:string, p0Fastpath?:object|null, replyText?:string,
 *          mergedCount?:number|null, mergedState?:string|null}} input
 *   `mergedCount` / `mergedState` 由**双轨合并**那一路传来（`dual_track.mjs`）。
 *   不给就是没跑双轨 ⇒ 行为与本改动之前**逐字相同**（这一条有反向对照守着）。
 * @returns {{state:string, line:string, from:string}|null}
 */
export function deriveVerdictLine({ answer = '', p0Fastpath = null, replyText = '', reviewedByTool = false,
                                    mergedCount = null, mergedState: mState = null } = {}) {
  // ── ⓪ 双轨合并数优先（见函数头那段注释）────────────────────────────────
  //
  //   `block` 这一格**照第 ① 支的写法原样给**（`conclusionBlock(answer)`），
  //   不自己造一个块 —— 逐条块由信封层的 `groups` 那一跳负责
  //   （实测日志：`逐条块=forced·groups`），这里改块会与它抢同一格。
  //   所以本支相对改动之前，**唯一**的差别就是那一行里的 N。
  const derived = verdictLineFor({ state: mState, n: mergedCount });
  if (derived) {
    // ★★ 2026-10-15（Owner：「没有命中就是 pass」）：**PASS 是「一句话结论」，它没有逐条块**
    //   （§5.3.1 就只有那一句：未发现已知底线风险 + 转交 sign-off）——
    //   ⇒ `block` 必须是 `null`：不许再去链的正文里抠块。抠进来会让卡上出现
    //   「**PASS 抬头 ＋ REVIEW 逐条**」这种自相矛盾的形状（而报告/链接那一跳也跟着复活，
    //   真单上就表现为「链接点开是空的」）。
    //   ⚠️ 链**自己**给了 PASS 行时优先用链那一行：它可能带着配好的 @句柄，
    //     比这里的 `（未配置）` 回落准（句柄只从库侧 `l7.json` 的 approvers 取）。
    if (derived.state === 'PASS') {
      const chainPass = conclusionLine(answer);
      const line = (chainPass && String(chainPass.state).toUpperCase() === 'PASS')
        ? chainPass.line : derived.line;
      return { state: 'PASS', line, from: 'dual-track-merged',
               conform: conforms(line), block: null };
    }
    return { ...derived, from: 'dual-track-merged', block: conclusionBlock(answer) };
  }

  const fromChain = conclusionLine(answer);
  // ★ 每一条来源都带上 `conform` 读数（2026-10-06 加）：
  //   链是这一行的**产者**，而它自己的措辞也会回退（实测：2026-10-06 之前
  //   REVIEW 与 BLOCK 共用「共发现 N 处需处理问题」，跑了半个月没有东西变红）。
  //   搬进来的时候顺手判一次，不合规就在发送层记一行 —— **回退必须看得见**，
  //   而不是等到人又在群里发现格式不对（AGENTS.md §2.4.1 第 5 行：
  //   一个会过期的读数，必须有东西在它过期时出声）。
  if (fromChain) {
    const chainConform = conforms(fromChain.line);
    if (!chainConform.ok) {
      // ★★ 2026-11-02：chain 给出非标行（如 coverage_not_covered 场景：
      //   「【审查结论：REVIEW】0 处需人工确认；覆盖缺口…BM25 15.4864…」）时，
      //   不能直接把整行当抬头搬进卡片 —— 那会把内部读数（BM25、reason_code 等）展示给用户。
      //   修法：从行里抠出 N，调 verdictLineFor 重新派生标准行；
      //   若 N=0 + REVIEW（coverage_not_covered 场景），按 Owner 2026-10-15 口径
      //   「没有命中就是 PASS」走 §5.3.1 一句话结论。
      const nMatch = /】(\d+)\s*处/.exec(fromChain.line);
      const nFromLine = nMatch ? Number(nMatch[1]) : NaN;
      // coverage gap 场景：N=0 + REVIEW → 按 PASS 派生（没有命中就是 PASS）
      const rebuildState = (fromChain.state === 'REVIEW' && nFromLine === 0) ? 'PASS' : fromChain.state;
      const rebuildN = rebuildState === 'PASS' ? 0 : nFromLine;
      const rebuilt = verdictLineFor({ state: rebuildState, n: rebuildN });
      if (rebuilt) {
        return { ...rebuilt, from: 'chain-rebuilt', block: conclusionBlock(answer) };
      }
    }
    return { ...fromChain, from: 'chain', conform: chainConform,
             block: conclusionBlock(answer) };
  }

  if (p0Fastpath) {
    const n = Number(p0Fastpath.matched_patterns);
    if (Number.isFinite(n) && n > 0) {
      const line = `【审查结论：BLOCK】共发现 ${n} 处必须修改。`;
      return { state: 'BLOCK', line, from: 'p0-fastpath', conform: conforms(line),
               block: conclusionBlock(answer) };
    }
    // 命中数读不出来 ⇒ **不派生**（编一个「共发现 ? 处」比不搬更坏）。
    return null;
  }

  const fromReply = conclusionLine(replyText);
  if (fromReply && leadsWith(replyText, fromReply.line)) {
    return { ...fromReply, from: 'reply', conform: conforms(fromReply.line),
             block: conclusionBlock(replyText) };
  }

  // ── ④ **闸门没判它是送审，但模型自己调了 `kb_review_chain`**（2026-10-06 加）────────
  //
  //   真事故（Owner 发的截图）：`M9 吸奶器限时优惠中，下单立减 100 元。`
  //   —— 23 字、无媒材、无链接、没命中送审词 ⇒ **闸门判「不是送审」**，
  //   于是 `runSubmissionGate` 直接返回 `verdict53: null`；而模型**自己**决定调了链
  //   （日志里只有 `🔧 工具: kb_review_chain(97179ms)`，没有 `🧭 送审链返回`），
  //   拿到结论后自己写了抬头 `REVIEW 1 处：W-1.16「限时」（覆盖不成立）`。
  //   ⇒ 卡片格式与 PRD §5.3 不符，**而守衡这一侧没有任何东西察觉**。
  //
  //   `reviewedByTool === true` 是这一支的**唯一凭据**：这一轮真的调过 `kb_review_chain`
  //   且成功了。有了它，「回复里出现一行合 §5.3 的结论」就**是**这次审查的结论，
  //   而不是「有人在问 5.3 模板长什么样」——③ 之所以要求「排在最前面」，防的正是后一种；
  //   而那种对话**不会伴随一次成功的送审调用**。
  if (fromReply && reviewedByTool && conforms(fromReply.line).ok) {
    return { ...fromReply, from: 'reply-tool', conform: conforms(fromReply.line),
             block: conclusionBlock(replyText) };
  }
  return null;
}

/**
 * outbound.mjs —— 「守衡说出去的话」有没有落下来（台账 + 折进会话记忆）
 *
 * ── 它修的是哪两件事（2026-09-22 一次真实的外部误答之后）
 *
 * | 真空 | 原先的样子 | 现在 |
 * |---|---|---|
 * | **出站无留痕** | 我们发出去的消息**没有任何落账**：`send_once.mjs` 只往 stdout 打一个
 *   `message_id`。于是 T7① 那一问的「发出时刻」是**手记**的，那个号码也进不了
 *   `待收清单` 的指针体系（`kind:message` 查的是**入站**事件日志，实测 0 命中） | 每一条
 *   **真的发出去了**的消息追加一行到 `PMO/logs/ws_outbound.jsonl` |
 * | **出站不进会话记忆** | `memory.append` 只在 `agent.mjs` 的**回复循环**里调，
 *   主动推送（`send_once.mjs`、基线告警、待收提醒、崩溃自报）都不经过那里。
 *   **她回复时，守衡不记得自己问过什么** —— 14:39 那次误答就长在这上面 | 回话前把
 *   「我说过、但记忆里没有的」折进会话（`foldInto`） |
 *
 * ── 为什么不是「发送时直接写会话文件」
 *
 * 因为那会多出一个**跨进程写者**：`send_once.mjs` 是另一个进程，而 daemon 正在
 * `handleMessage` 里握着同一份会话（中间还夹着一次 16 秒的 LLM 调用）。
 * 两个进程各自 `读 → 改 → 写` 同一个 JSON，后写的把先写的**整段抹掉** ——
 * 与 `prd_baseline.mjs` 那次「两个检查共写一份状态文件」是同一个形状（§2.4.3）。
 *
 * 所以这里分成两半，各自**只有一个写者**：
 *   · **台账**（本文件 `recordSend`）：只增不改，谁发谁追加，天然可并发；
 *   · **会话文件**（`foldInto`）：**只有 daemon 写**。它在每次回话前读一遍台账，
 *     把还没进记忆的那几条补上。
 *
 * 代价是「补记」晚了一步 —— 但那一步恰好发生在**最需要它的那一刻**：
 * 对方刚开口、上下文正要拼出来的时候。
 *
 * ── 判据的落点
 *
 * `tools/verify_outbound.py`（A 判据 / B 接线 / C 反向对照 / D 拿真实台账做回归 /
 * E 结论行不许撒谎 / F 全仓不许绕过台账）。**别把那个检查器变绿读成「重启已经做了」**——
 * 代码在盘上不等于在跑，见 `PMO/守衡-误答登记-20260922.md` §7.2 那两条独立读数。
 */
import fs from 'node:fs';
import path from 'node:path';
import { LOG_DIR } from './config.mjs';
import * as mem from './memory.mjs';

/* ─────────────────────────── 台账 ─────────────────────────── */

/**
 * 一条外发消息的「性质」。**封闭集合** —— 它决定要不要折进会话记忆，
 * 所以加新的来源时必须同时想清楚「这条该不该进守衡的记忆」。
 *
 * ★ `reply` 是唯一**不折**的一类：回复循环自己已经 `mem.append` 过了，
 *   再折一遍就是同一个回答在记忆里出现两遍。
 *   （曾经想用「正文去重」代替这个判断 —— 不行：走卡片时**存进记忆的是模型的原文、
 *     发出去的是卡片降级文本**，两者本来就不一样，正文匹配一定漏。）
 *   `failed` 也不折：发送失败的消息**没有出现在群里**，折进记忆等于让它
 *   「记得自己说过一句别人根本没看见的话」。
 */
export const SOURCES = Object.freeze([
  'reply',               // daemon 的回复循环（已进记忆，不折）
  'resend',              // ★ 2026-09-22 加：失败之后**补发**的那条（引用原消息，见 retry_queue.mjs）
  'chain-ack',           // ★ 2026-10-05 加：送审链启动时的「⏳ 处理中…」回执（引用原消息）
                         //   —— 它原先直接用了这个字符串，而**它不在这个闭集里**，
                         //   于是台账里那条记成了 `unknown:chain-ack`（`known=false`）。
                         //   闭集的意义就是「没登记的来源要看得见」，这次它起作用了。
  'chain-progress',      // ★ 2026-10-26 补登记：送审单跑满 5 分钟时的中途进度提示（`ws_daemon.mjs:280`）。
                         //   2026-10-23 上线时先用了字面量，漏进 `SOURCES` ⇒ 台账记成 `unknown:chain-progress`（12 条）。
  'proactive-baseline',  // 上游基线漂移告警
  'proactive-pending',   // 待收清单到期提醒
  'proactive-external',  // ★ 2026-09-22 加：外部标准库漂移告警（见 external_watch.mjs）
  'error-fallback',      // 出错兜底话术 / 内部出错自报
  'greeting',            // 被拉进群的自我介绍
  'manual',              // 人用 send_once.mjs 手发的（T7① 那一问、15:03 更正都是这一类）
  'manual-backfill',     // 补记：修复之前发出去的（从飞书回读，见 outbound_ledger.mjs）
  'batch-review',        // ★ 2026-10-13 加：本机批跑器（`tools/batch_review_runner.mjs`）
                         //   逐条跑送审那条路之后，用**守衡自己的身份**把结论发进会话。
                         //   为什么要有它：批跑的结论也是「守衡说过的话」，必须与其它外发
                         //   同一条台账、同一套折记忆规则 —— 否则它就成了一个没人知道的出口。
]);

/**
 * ★ 折/不折是 `SOURCES` 的**显式分类**（2026-09-22 加）。
 *
 * 原先判的是 `e.source === 'reply'` 一个字面量 —— 于是「加一个来源」默认落进**会折**那一侧，
 * 而没人需要为此写一行代码。补发（`resend`）正好撞上这个默认值：它由内核重跑产生、
 * 内核自己已经 `mem.append` 过回答，再折一遍就是**同一个回答在记忆里出现两遍**。
 *
 * 现在两侧都是白名单，且 `foldPlan` 对「没分类的来源」**不折、并计数**
 * （`skipped.unclassified`）—— 漏一个不会静默折进去，也不会静默消失。
 */
export const FOLDING = Object.freeze(new Set([
  'proactive-baseline', 'proactive-pending', 'proactive-external',
  'error-fallback', 'greeting', 'manual', 'manual-backfill',
  // ★ 批跑器的结论与其余主动消息同类：**代码产生的话 ⇒ 折**（见下面 chain-ack 那段的口径）。
  'batch-review',
  // ★ 2026-10-13 补：**送审回执卡（`chain-ack`）要折**。
  //
  //   它 2026-10-05 进了 `SOURCES`（见上面那条注释：字符串先用了、闭集随后才补），
  //   却**没进这张分类表** —— 后果有两层，第二层才是真代价：
  //     ① `verify_outbound.py` 的 A17 一直红：「`SOURCES` 必须被 FOLDING/NON_FOLDING
  //        恰好切成两半」，实测没分类的正是 `chain-ack`；
  //     ② `foldPlan` 对没分类的来源**不折、只计数**（`skipped.unclassified`）
  //        ⇒ 回执卡那句「⏳ 正在处理，请稍等」**从来没进过会话记忆**。
  //        那正是 2026-09-22 那次误答的形状：**我说过的话，记忆里没有** ⇒
  //        下一轮否认自己回过。红着的检查器没人看，这一层就一直没被发现。
  //
  //   归类依据（与这张表其余条目同一条线）：**代码产生的话 ⇒ 折**。
  //   回执卡由送审闸门发（不是模型的回答，内核不会替它写记忆）；
  //   而 `reply` / `resend` 不折，是因为那两条由内核自己 `mem.append`，
  //   再折一遍就是同一句在记忆里出现两遍。
  'chain-ack',
  'chain-progress',
]));
/** 这些来源**不折**：说出去的话由其产生方自己写进记忆（回复循环 / 补发时的内核重跑）。 */
export const NON_FOLDING = Object.freeze(new Set(['reply', 'resend']));

/** 台账路径。**惰性求值** —— 自证必须能把它指到临时目录（§2.4.4：自证不许改真数据）。 */export function ledgerPath() {
  return process.env.SHOUHENG_OUTBOUND_LEDGER
    ? path.resolve(process.env.SHOUHENG_OUTBOUND_LEDGER)
    : path.join(LOG_DIR, 'ws_outbound.jsonl');
}

/**
 * 记一条外发。**不抛**：台账写不进去也必须把消息发出去（与 `dumpRaw` 同一条纪律）。
 *
 * @returns {{ok:boolean, at?:string, error?:string, source?:string}}
 */
export function recordSend({ chatId, chatType = null, messageIds = [], text = '', source, mode = null,
                             replyTo = null, ok = true, error = null, extra = null, at = null }) {
  const now = at ?? new Date().toISOString();
  const known = SOURCES.includes(source);
  const rec = {
    at: now,
    chat_id: chatId ?? null,
    chat_type: chatType ?? null,
    message_ids: (Array.isArray(messageIds) ? messageIds : [messageIds]).filter(Boolean),
    // ★ 不认识的来源**照样记**（丢一条留痕比记一个脏值严重得多），但打上 `unknown:`
    //   前缀 —— 于是「有人加了新的发送路径却忘了在这里登记」会在**真实台账里看得见**，
    //   而不是静默通过。verify_outbound.py 的 H 段会拿真台账断言这一条。
    source: known ? source : `unknown:${source ?? '(未给)'}`,
    mode,
    reply_to: replyTo,
    ok: ok !== false,
    error: error ?? null,
    chars: String(text ?? '').length,
    text: String(text ?? ''),
    ...(extra && typeof extra === 'object' ? { extra } : {}),
  };
  try {
    const f = ledgerPath();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, JSON.stringify(rec) + '\n');
    return { ok: true, at: now, source: rec.source };
  } catch (e) {
    return { ok: false, at: now, source: rec.source, error: `${e.code ?? e.message}` };
  }
}

/**
 * 读台账。回**四个读数分开**的对象，`missing` / `badLines` / `truncated` 各自独立 ——
 * 「一条都没有」和「我读不出来」必须长得不一样（§2.4.1 最后那句）。
 *
 * ★ **不按会话过滤**（第一版有个 `chatId` 选项，2026-09-22 删掉了）：过滤交给调用方，
 *   否则 `foldPlan` 里那个「不是这个群的」跳过计数**恒为 0** —— 被过滤掉的东西
 *   连计数器都到不了。读全量、谁要谁筛，跳过的理由才数得出来。
 *
 * @param {{maxBytes?:number}} opt
 * @returns {{entries:Array, badLines:number, bytes:number, truncated:boolean,
 *            missing:boolean, error?:string}}
 */
export function readEntries({ maxBytes = 4 * 1024 * 1024 } = {}) {
  const f = ledgerPath();
  let buf;
  let truncated = false;
  try {
    const st = fs.statSync(f);
    if (st.size === 0) return { entries: [], badLines: 0, bytes: 0, truncated: false, missing: false };
    const start = st.size > maxBytes ? st.size - maxBytes : 0;
    truncated = start > 0;
    const fd = fs.openSync(f, 'r');
    try {
      buf = Buffer.alloc(st.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
    } finally { fs.closeSync(fd); }
  } catch (e) {
    if (e.code === 'ENOENT') return { entries: [], badLines: 0, bytes: 0, truncated: false, missing: true };
    return { entries: [], badLines: 0, bytes: 0, truncated: false, missing: false,
             error: `${e.code ?? e.message}` };
  }

  let text = buf.toString('utf8');
  // 从中间截断时，头一行多半是半截的 —— 丢掉它，并**计入 badLines**，不许静默吞掉。
  if (truncated) text = text.slice(text.indexOf('\n') + 1);

  const entries = [];
  let badLines = 0;
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const d = JSON.parse(s);
      if (!d || typeof d !== 'object') throw new Error('not object');
      entries.push(d);
    } catch { badLines++; }
  }
  return { entries, badLines, bytes: buf.length, truncated, missing: false };
}

/* ─────────────────────── 折进会话记忆（判据，纯函数部分） ─────────────────────── */

/** 去空白再比 —— 与 `thread.mjs` 的 `squash()`、`verify_pending.py` 的 `_squash()` 同一口径。 */
function squash(s) { return String(s ?? '').replace(/\s+/g, ''); }

/**
 * 这句话**是不是已经在会话记忆里了**？
 *
 * ★ 与 `thread.mjs` 的 `alreadyInHistory` **刻意不同**，两处判据不一样是有理由的：
 *   那边是「要不要再引一次上文」，判错了一边是冗余、一边是**看不见上文**，
 *   所以它**宁可重复**，匹配放宽（群里的 `【名字】正文`、私聊的 `正文`、assistant 的前缀）。
 *   这边是「要不要往记忆里塞一条」，判错了一边是冗余、一边是**记忆被污染**
 *   （把别的东西误判成「我说过」会让模型以为自己对某句话负过责）。
 *   所以这里**只认逐字相等**，不做前缀/后缀。
 *
 * 代价说清楚：一条外发若被后端改写过一个字，这里就认不出、会重复折一次。
 * 那种情况下**重复**是安全的一侧 —— 与事故本身（看不见）相比，它可接受。
 */
export function alreadySaid(messages, text) {
  const sq = squash(text);
  if (!sq) return true;                       // 没有正文 → 没什么可折的
  if (!Array.isArray(messages)) return false;
  return messages.some((m) => (m?.role === 'assistant') && squash(m.content) === sq);
}

/** 这条会话记忆里，是不是已经带着这个 `message_id` 折过一次了？ */
function foldedIds(messages) {
  const s = new Set();
  for (const m of messages ?? []) {
    for (const id of m?.outbound?.message_ids ?? []) s.add(id);
  }
  return s;
}

/**
 * 该把台账里哪几条补进这份会话？**纯函数**（除了台账读取），可离线喂样本。
 *
 * 折的条件（**四条必须同时成立**，每条都对应一次想清楚过的不折）：
 *   ① 是**这个群/这个人**的（`chat_id` 相等）—— 别的会话的推送不该进这里；
 *   ② 来源不在 `NON_FOLDING` 里 —— 回复循环已经 append 过（见 `SOURCES` 的注释）；
 *   ③ `ok !== false` —— 发失败的消息没出现在群里，不能进记忆；
 *   ④ 正文非空、且逐字不在记忆里、且 `message_id` 没折过。
 *
 * ★ 顺序按台账**文件顺序**（= 时间顺序）追加，并**接在这一轮用户消息之前**。
 *   不做「按时间插进历史中间」：那会切进 `assistant(tool_calls)` 与它对应的 `tool` 结果
 *   之间，下一次请求会被 API 直接拒掉（`memory.compact` 头注里那个 400）。
 *   代价是历史里可能有一处时序不严格 —— 那一侧是安全的。
 */
export function foldPlan(sess, chatId, opt = {}) {
  const messages = sess?.messages ?? [];
  // ★ **不**把 `chatId` 交给 `readEntries` 去过滤。第一版交给它了，于是下面那个
  //   `skipped.notThisChat` **恒为 0** —— 别的群的消息在读进来之前就被丢掉了，
  //   而计数器还在那儿显示「这一类跳过 0 条」。一个永远为 0 的计数器不是读数，
  //   是 §2.4 那个病（名字在、拦不住）。现在过滤在这一层做，跳过的理由列得出来。
  const r = readEntries({ ...opt });
  const skipped = { notThisChat: 0, isReply: 0, unclassified: 0, failed: 0, empty: 0, alreadySaid: 0, alreadyFolded: 0 };
  const entries = [];
  const seenIds = foldedIds(messages);

  for (const e of r.entries) {
    if (chatId && e.chat_id !== chatId) { skipped.notThisChat++; continue; }
    if (NON_FOLDING.has(e.source)) { skipped.isReply++; continue; }
    // ★ 没在 `FOLDING` 里的来源（新加的、忘了分类的、台账里那些 `unknown:` 值）：
    //   **照样折** —— 它确实发到群里了，记忆就必须记得（14:39 那次误答的另一半正是这里）。
    //   但要**计数**：漏分类既不静默通过，也不静默丢记忆。D/H 段拿真台账断言它是 0。
    if (!FOLDING.has(e.source)) skipped.unclassified++;
    if (e.ok === false) { skipped.failed++; continue; }
    const t = String(e.text ?? '');
    if (!t.trim()) { skipped.empty++; continue; }
    const ids = e.message_ids ?? [];
    if (ids.some((id) => seenIds.has(id))) { skipped.alreadyFolded++; continue; }
    if (alreadySaid(messages, t)) { skipped.alreadySaid++; continue; }
    entries.push(e);
    for (const id of ids) seenIds.add(id);      // 同一批里的重复 id 也不折第二遍
  }

  // ⚠️ 读数采不到时必须**说成未测**，不许当成「没有要补的」—— 后者正是 14:39 那次误答的形状。
  let untested = null;
  if (r.error) untested = `台账读不出（${r.error}）—— 这次「有没有漏补的外发」**未测**`;
  else if (r.badLines) untested = `台账有 ${r.badLines} 行读不出来 —— 可能漏补，**未测**`;
  else if (r.truncated) untested = `台账只读了尾部（>${opt.maxBytes ?? 4 * 1024 * 1024} 字节）—— 更早的没看，**未测**`;

  return {
    entries, skipped, untested, missing: r.missing, ledger: ledgerPath(),
    // 把两个原始读数一并带出去：`untested` 是**结论**，这两个是**依据**。
    // 只回结论的话，调用方（与自证）就只能相信那句中文，而验不了它凭什么这么说。
    truncated: r.truncated, badLines: r.badLines,
  };
}

/**
 * 把台账里「我说过、记忆里没有的」补进这份会话。**daemon 是会话文件的唯一写者**，
 * 所以这个函数只许在 `handleMessage` 的锁里调（`agent.mjs` §5.6）。
 *
 * @returns {{folded:number, plan:object}}
 */
export function foldInto(sess, chatId, opt = {}) {
  const plan = foldPlan(sess, chatId, opt);
  for (const e of plan.entries) {
    mem.append(sess, {
      role: 'assistant',
      content: String(e.text ?? ''),
      at: e.at,                                  // 用**发出那一刻**，不是现在
      outbound: {                                // 折过的痕迹：下次不再折一遍，且可审计
        message_ids: e.message_ids ?? [],
        source: e.source,
        chat_id: e.chat_id ?? null,
        sent_at: e.at ?? null,
      },
    });
  }
  return { folded: plan.entries.length, plan };
}

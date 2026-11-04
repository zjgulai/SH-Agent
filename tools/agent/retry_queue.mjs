/**
 * retry_queue.mjs —— 「答不上，就是永远答不上」的修法（Q1-1d，2026-09-22）
 *
 * ── 它修的是哪一件事
 *
 * 2026-09-22 15:29 上游在群里问「有没有拉材料 + 给个链接」——一个**有确定答案**的问题
 * （材料在盘上，链接当天补上了）。15:32 守衡回的是「我这边调用模型失败了」。
 * 到 15:42 它才正常答上。中间那十分钟里，**没有任何东西记得「我欠她一条回答」**：
 * `verify_pending.py` 管的是**对方的承诺与我方的提问**，不管**我方的失败**。
 * 缺口只存在于人的脑子里 —— 而人当时正忙着别的事。
 *
 * ── 它的形状为什么是这样
 *
 * · **队列的键是入站 `message_id`** —— 同一条消息永远只可能有一格；
 * · **补发要重跑内核**（`answer`），不是在队列里存一句预先写好的话：
 *   她问的是「有没有拉材料」，答案在盘上、可能已经变了；
 * · **「网络恢复了没有」不用另做探针** —— 补发那一次尝试本身就是探针
 *   （计划 §1.5 那条：判据就是这一拍的 `chat()` 成不成）。省一次调用，也少一个假读数；
 * · **发不出去时绝不再往群里灌第二条**：补发失败只累加次数，到上限落死信、**只在日志说**。
 *
 * ── 幂等必须三重（缺一条就会答两遍）
 *
 * ① 队列以 `message_id` 为键（`enqueue` 里判）；
 * ② 台账里已经有**别的来源**成功答过这条（`answeredByLedger`）；
 * ③ 会话记忆里这条问话后面已经有一条**真回答**（`answeredInMemory`）。
 *
 * ⚠️ ② 的判据**不是**「台账里有一条 `reply_to == 该 id` 的成功记录」——那么写会**恒真**，
 *    因为失败话术自己就是通过 `replyTo` 发出去的，它记的 `reply_to` 正是这条 `message_id`。
 *    于是队列会一条都补不出去，而每一格都「有理由」。**这句话比我的输入大吗？**（§2.4.1）
 *    所以只认 `ANSWERED_SOURCES` 这三个来源：它们才代表「有人真的答过」。
 *
 * ── 谁在跑它
 *
 * `ws_daemon.mjs` 的心跳（`retryWatch`）。**一个写者**：本模块内部持有一份内存态，
 * 落盘只是镜像 —— 因为补发那一步 `await answer()` 要十几秒，而这段时间里
 * 「读 → 改 → 写」同一份文件的第二条路径（新消息失败入队）随时可能进来，
 * 那正是 §2.4.3 记的那个「两个检查共写一份状态文件、后写的抹掉先写的」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, stateDir, LOG_DIR } from './config.mjs';
import { readEntries } from './outbound.mjs';
import * as mem from './memory.mjs';
import { replyOptionsForResult, hasReviewDecision } from './review_feedback.mjs';

/** 一条消息最多补发几次。 */
export const MAX_TRIES = 5;
/** 从**第一次失败**算起的窗口，超过就不再补 —— 隔了一小时才蹦出来一条回答比不答更糟。 */
export const WINDOW_MS = 60 * 60 * 1000;

/**
 * 台账里哪些来源算「真的答过这条」。
 * `reply` **不在里面** —— 失败话术就是以 `reply` 记的（见文件头那段）。
 */
export const ANSWERED_SOURCES = Object.freeze(['resend', 'manual', 'manual-backfill']);

/**
 * 补发时加的那一行前缀。
 * 为什么要加：这条回答会**晚十几分钟**出现在群里，且引用着一条旧消息。
 * 不说明的话，对方只会看到「守衡突然回了一句」—— 与 §2.5 那条纪律同一件事：
 * 形态/时机变了，得让看的人知道是为什么。
 */
export const RESEND_PREFIX = '（补一条：刚才我这边断了一下，这条问题当时没答上）\n\n';

export function queuePath() {
  return process.env.SHOUHENG_RETRY_QUEUE
    ? path.resolve(process.env.SHOUHENG_RETRY_QUEUE)
    : path.join(stateDir(), 'llm-retry-queue.json');
}
export function deadPath() {
  return process.env.SHOUHENG_RETRY_DEAD
    ? path.resolve(process.env.SHOUHENG_RETRY_DEAD)
    : path.join(LOG_DIR, 'llm_deadletter.jsonl');
}

/* ───────────────────────── 队列的存取（一个写者） ───────────────────────── */

let Q = null;         // 内存态：**唯一的真相来源**
let QFILE = null;

function read(file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(d?.items)) return d;
  } catch { /* 不存在 / 坏了 → 从空队列起，**不抛**：补发是尽力而为，不是关键路径 */ }
  return { items: [] };
}
function write(q, file) {
  try {
    ensureDir(path.dirname(file));
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(q, null, 2));
    fs.renameSync(tmp, file);
    return { ok: true };
  } catch (e) { return { ok: false, error: `${e.code ?? e.message}` }; }
}

/** 取内存态（首次或换了文件才读盘）。 */
function store(file) {
  const f = file ?? queuePath();
  if (Q === null || QFILE !== f) { Q = read(f); QFILE = f; }
  return Q;
}
/** 测试/排查用：丢掉内存态，下次从盘上重读。 */
export function resetCache() { Q = null; QFILE = null; }

/* ───────────────────────── 入队 ───────────────────────── */

/** 从飞书事件里抽出队列要的那几格。**不猜**：抽不到就回 null，让调用方别入队。 */
export function itemFromEvent(event, { at = new Date().toISOString(), error = null, layer = null } = {}) {
  const msg = event?.message ?? {};
  const sender = event?.sender ?? {};
  const messageId = msg.message_id;
  const chatId = msg.chat_id;
  if (!messageId || !chatId) return null;
  let text = '';
  try { text = JSON.parse(msg.content ?? '{}').text ?? ''; } catch { /* 非文本事件不入队 */ }
  return {
    message_id: messageId,
    chat_id: chatId,
    chat_type: msg.chat_type ?? null,
    sender_open_id: sender?.sender_id?.open_id ?? sender?.sender_id?.user_id ?? '',
    session_key: mem.sessionKey({ chatId, chatType: msg.chat_type,
                                 senderOpenId: sender?.sender_id?.open_id ?? sender?.sender_id?.user_id ?? '' }),
    // ★ **存清洗过的问句**，不是原始正文：原始正文里带着 `<at user_id="…">守衡</at>`，
    //   而会话记忆里存的是剥掉 mention 之后的那一句（`feishu.stripBotMention`）。
    //   两边不一致 → 幂等③（「记忆里已答过吗」）会**永远**判「找不到这条问话」而失效，
    //   失效得还很安静：它只会表现为「又答了一遍」。实测就是这一格。
    text: cleanQuestion(text).slice(0, 2000),
    raw_text: String(text).slice(0, 2000),
    asked_at: at,
    first_failed_at: at,
    last_failed_at: at,
    tries: 0,
    last_layer: layer,
    last_error: error ? String(error).slice(0, 300) : null,
    event,                     // 重放用：补发那一步把它原样喂回内核
  };
}

/**
 * 把「一条群消息的正文」和「会话记忆里那一轮用户消息」拉到同一个口径上比。
 * 两件事要做：**剥 mention 标记**（`<at user_id="…">名字</at>`）与去空白。
 */
export function cleanQuestion(s) {
  return String(s ?? '')
    .replace(/<at\b[^>]*>[\s\S]*?<\/at>/g, ' ')
    .replace(/<at\b[^>]*\/>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 入队。**只对可重试类失败入队**（HTTP 4xx 不入 —— 补发 5 次也是白试，见计划 §1.5 C7）。
 * @returns {{ok:boolean, why?:string, size?:number}}
 */
export function enqueue(item, { file = null, now = new Date() } = {}) {
  if (!item?.message_id) return { ok: false, why: '没有 message_id，不入队' };
  if (item.retryable === false) return { ok: false, why: '不可重试类失败（HTTP 4xx/未知），不入队' };
  const q = store(file);
  if (q.items.some((it) => it.message_id === item.message_id)) {
    return { ok: false, why: '这条已经在队列里', size: q.items.length };
  }
  const it = { ...item };
  delete it.retryable;
  if (!it.first_failed_at) it.first_failed_at = now.toISOString();
  q.items.push(it);
  const saved = write(q, file ?? queuePath());
  if (!saved.ok) {
    q.items = q.items.filter((entry) => entry !== it);
    return { ok: false, why: `补发队列未能保存：${saved.error}`, size: q.items.length };
  }
  return { ok: true, size: q.items.length };
}

/* ───────────────────────── 判据（纯函数，可喂样本） ───────────────────────── */

/** 两个字串去空白后比 —— 与 `outbound.mjs` 的 `squash()`、`thread.mjs` 同一口径。 */
const squash = (s) => String(s ?? '').replace(/\s+/g, '');

/**
 * ② 台账里已经有**别的来源**成功答过这条？**纯函数**（台账由调用方读好传进来）。
 * @param {object} item  队列条目
 * @param {Array}  entries 台账条目（`outbound.readEntries().entries`）
 */
export function answeredByLedger(item, entries) {
  if (!Array.isArray(entries)) return { answered: false, why: '台账读不出（未测）' };
  const hit = entries.find((e) => e && e.ok !== false && e.reply_to === item.message_id
                                  && ANSWERED_SOURCES.includes(e.source));
  return hit
    ? { answered: true, why: `台账里已有 ${hit.source} 的成功记录（${hit.at}）`, at: hit.at }
    : { answered: false, why: '台账里没有别的来源答过这条' };
}

/**
 * 结构化「不是真回答」的标记。**判据是结构，不是比对文案**（文案会改，标记不会）。
 *
 * | 标记 | 谁打的 | 什么意思 |
 * |---|---|---|
 * | `llm_error: true` | `agent.mjs` 的模型失败分支 | 这一轮压根没调通模型 |
 * | `tool_exhausted: true` | `agent.mjs` 的兜底话术分支 | 模型调通了，但**始终没给出最终答复** |
 * | `truncated: true` | `agent.mjs` 的截断守卫分支（2026-09-30 加） | 这一轮**被长度上限腰斩**，正文不完整 |
 *
 * ★ `truncated` 是第三个成员，起因是一次真事故（本群 2026-09-30 19:11 / 19:16）：
 *   模型烧光输出预算，正文 0 字，`annotateTruncation()` 把一句「⚠️ 这条回答被长度上限
 *   截断了……你可以让我『接着说』」当成了回复发进群 —— 那条消息**通篇只有说明、
 *   没有一个字的答案**。而 `answeredInMemory()` 认为「她问话后面有一条不带失败标记的
 *   assistant，所以她已经答过了」，于是**队列把她出队，答案永远没发出去**。
 *
 *   这与 2026-09-22 那次（`tool_exhausted` 缺失 → 兜底话术被当成真回答）是**同一个形状**：
 *   失败被写成了「一条长得像回答的 assistant」。第一次修的是兜底话术，这次修的是截断说明。
 */
/**
 * 「这一条 assistant **不是答案**」的结构标记。
 *
 * ★ 2026-10-06 加 `chain_not_run`（Owner：「每次发图片/视频都必须能正常回复，不能拒答」）。
 *   形状与 2026-09-22 加 `tool_exhausted` 一模一样，事故也一模一样：
 *   **送审单起了链、链却没跑成**（库忙 exit 3 / 超时 / 层前置红 / 依据侧没给结论）时，
 *   守衡照样发了一条回复（「这一单未测，没有三态结论」）—— 于是 `reason` 是 `ok`，
 *   补发队列判「她已经答过了」，**一条都补不出去**。
 *   结果就是：那张图那条视频，**问一次答不上，问十次还是答不上**。
 *   本模块存在的全部理由就是不让「答不上」等于「永远答不上」——
 *   所以「链没跑成」必须与「答了」长得不一样。
 *
 * 判据（写入侧在 `agent.mjs`）：**闸门判了送审（`gate.yes`）** 且 **`chainRan` 为假**。
 * 两样缺一不可：没有闸门的普通问答不在此列（它本来就不需要链）。
 */
export const NOT_AN_ANSWER_FLAGS = Object.freeze([
  'llm_error', 'tool_exhausted', 'truncated',
  'chain_not_run',   // ★ 2026-10-06：送审单但链没跑成 ⇒ 补发队列应当重跑
  'link_read_failed', // 素材链接读取失败的说明不是审核结果。
]);

/**
 * ③ 会话记忆里这条问话后面已经有一条**真回答**？**纯函数**。
 *
 * 「真回答」= `role === 'assistant'` 且**没有**任何 `NOT_AN_ANSWER_FLAGS` 标记。
 *
 * ★ `tool_exhausted` 是 **2026-09-22 补的**，因为那天真出过一次：
 *   上游在私聊里问「你如何读取我 DSH 上的知识库」，两次都跑满 6 轮工具、
 *   两次都走兜底话术。那时 `reason` 是 `'ok'`（因为有 `reply`），
 *   于是**补发队列认为她已经被答过了**，一条都补不出去 ——
 *   「答不上」于是真的等于「永远答不上」，而这个模块存在的全部理由就是不让它等于。
 *
 * 已知盲区（写在这里，不假装没有）：会话压缩会把老消息换成纪要，标记可能随之消失。
 * 那时这里会判「已答」→ 跳过补发。**跳过是安全的一侧**（少答一次 ≠ 答两遍）。
 */
export function answeredInMemory(item, session) {
  const msgs = session?.messages;
  if (!Array.isArray(msgs)) return { answered: false, why: '会话记忆读不出（未测）' };
  // 两边都按同一个口径清洗：队列条目存的是清洗过的问句，而记忆里那一轮用户消息
  // 是 `【名字】问句`（群里）或 `引用上文 + 问句`（回复话题时）—— 所以这里用**包含**判定。
  const q = squash(cleanQuestion(item.text));
  if (!q) return { answered: false, why: '队列条目里没有原文可比（未测）' };
  let at = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m?.role === 'user' && squash(cleanQuestion(m.content)).includes(q)) { at = i; break; }
  }
  if (at < 0) return { answered: false, why: '记忆里找不到这条问话（上次可能在 append 之前就崩了）' };
  for (let i = at + 1; i < msgs.length; i++) {
    const m = msgs[i];
    if (m?.role === 'user') break; // 后一轮的回答不替这一条作证。
    if (m?.role !== 'assistant') continue;
    if (['chain-ack', 'chain-progress'].includes(m.outbound?.source)) continue;
    if (NOT_AN_ANSWER_FLAGS.some((f) => m[f] === true)) continue;
    return { answered: true, why: `记忆里已有真回答（第 ${i - at} 条之后）` };
  }
  return { answered: false, why: '记忆里只有失败话术 / 截断说明，没有真回答' };
}

/**
 * 这一拍该干什么？**纯函数** —— 喂合成样本就能断言，不必等真断网。
 *
 * 回：`{ pick, drop: [{message_id, why}], left }`
 *   · `drop` 是**过期/超次**的（要落死信，且**只在日志说**）；
 *   · `pick` 是最老的那一条（一次只补一条：补发那一步本身要花一次模型调用，
 *     网络刚好时三条一起补 = 三倍花费，而它们已经等了十几分钟，再等 5 分钟不改变什么）。
 */
export function decide(q, now = new Date(), { maxTries = MAX_TRIES, windowMs = WINDOW_MS } = {}) {
  const items = Array.isArray(q?.items) ? q.items : [];
  const t = now.getTime();
  const drop = [];
  const keep = [];
  for (const it of items) {
    const tried = Number(it.tries ?? 0);
    const first = Date.parse(it.first_failed_at ?? '');
    if (tried >= maxTries) { drop.push({ message_id: it.message_id, why: `补发 ${tried} 次仍未成功（上限 ${maxTries}）`, item: it }); continue; }
    if (Number.isFinite(first) && t - first > windowMs) {
      drop.push({ message_id: it.message_id, why: `距首次失败已 ${Math.round((t - first) / 60000)} 分钟（窗口 ${Math.round(windowMs / 60000)} 分钟）`, item: it });
      continue;
    }
    if (!Number.isFinite(first)) { drop.push({ message_id: it.message_id, why: 'first_failed_at 读不出（条目坏了）', item: it }); continue; }
    keep.push(it);
  }
  keep.sort((a, b) => Date.parse(a.first_failed_at) - Date.parse(b.first_failed_at));
  return { pick: keep.length ? keep[0].message_id : null, drop, left: keep.length };
}

/* ───────────────────────── 编排 ───────────────────────── */

function deadLetter(recs) {
  try {
    const f = deadPath();
    ensureDir(path.dirname(f));
    for (const r of recs) {
      fs.appendFileSync(f, JSON.stringify({
        at: new Date().toISOString(), message_id: r.message_id, chat_id: r.item?.chat_id ?? null,
        why: r.why, tries: r.item?.tries ?? 0, first_failed_at: r.item?.first_failed_at ?? null,
        last_layer: r.item?.last_layer ?? null, last_error: r.item?.last_error ?? null,
        text: String(r.item?.text ?? '').slice(0, 400),
      }) + '\n');
    }
    return { ok: true };
  } catch (e) { return { ok: false, error: `${e.code ?? e.message}` }; }
}

/**
 * 一拍。注入 `answer`（重跑内核）与 `send`（真发出去）——
 * **本模块自己不碰飞书**：形态决策只在 `replyTo`（§2.5），而「谁能发消息」必须是
 * `verify_outbound.py` 那张表里已有的那几个文件。
 *
 * @param {(item:object)=>Promise<object>} answer  期望回 `handleMessage` 的那个结果体
 * @param {(item:object, text:string)=>Promise<object>} send
 */
export async function runTick({ answer, send, now = new Date(), file = null, log = () => {},
                                ledgerEntries = null, sessionLoader = null } = {}) {
  const q = store(file);
  if (!q.items.length) return { acted: false, reason: 'empty', left: 0 };

  const d = decide(q, now);
  if (d.drop.length) {
    const w = deadLetter(d.drop);
    q.items = q.items.filter((it) => !d.drop.some((x) => x.message_id === it.message_id));
    write(q, file ?? queuePath());
    for (const x of d.drop) log(`   ✗ 补发放弃（${x.why}）—— 只进日志，不往群里灌第二条`);
    if (!w.ok) log(`   ⚠ 死信落盘失败：${w.error}`);
  }
  if (!d.pick) return { acted: false, reason: 'nothing-due', left: q.items.length };

  const it = q.items.find((x) => x.message_id === d.pick);
  /** 出队但**不**落死信：这不是「放弃了」，是「不需要了」（已答过 / 发送失败但还会再试）。 */
  const removeItem = () => {
    q.items = q.items.filter((x) => x.message_id !== it.message_id);
    write(q, file ?? queuePath());
  };
  /** 出队并落死信：这才是「放弃了」。★ 两者必须分开 —— 第一版把「已答过」也写进死信，
   *  于是死信里躺着一条**成功补发过**的记录，而「死信 = 我放弃了」这句话当场失真。 */
  const deadDrop = (why) => {
    q.items = q.items.filter((x) => x.message_id !== it.message_id);
    deadLetter([{ message_id: it.message_id, why, item: it }]);
    write(q, file ?? queuePath());
  };

  // 幂等 ②③ 必须在**发之前**判 —— 发完再判等于没判。
  const entries = ledgerEntries ?? readEntries().entries;
  const l1 = answeredByLedger(it, entries);
  if (l1.answered) {
    removeItem();
    log(`   · 补发跳过：${l1.why}`);
    return { acted: true, sent: false, why: `已答过（${l1.why}）`, left: q.items.length };
  }
  let sess = null;
  try { sess = sessionLoader ? sessionLoader(it) : mem.load(it.session_key); } catch { sess = null; }
  const l2 = answeredInMemory(it, sess);
  if (l2.answered && it.delivery_pending !== true) {
    removeItem();
    log(`   · 补发跳过：${l2.why}`);
    return { acted: true, sent: false, why: `已答过（${l2.why}）`, left: q.items.length };
  }

  let res = null;
  try { res = await answer(it); }
  catch (e) { res = { reply: null, reason: 'threw', error: `${e?.message ?? e}` }; }

  // 补审必须形成权威结论。能发送一张告警卡，不代表已经答完。
  //   `llm_error`      —— 模型这一拍没调通（补发那一次本身就是探针）；
  //   `tool_exhausted` —— 调通了但工具循环又跑满，等同于没答出来；
  //   `truncated`      —— **答了，但被长度上限腰斩**（2026-09-30 加）。
  //   漏掉第三个的代价是实测过的：19:16 那次补发，回答**正文 0 字**，
  //   只有一句「⚠️ 这条回答被长度上限截断了……」，而队列把它当成「答出来了」直接发进群 ——
  //   于是**同一条问题，群里收到两条一模一样的空回答**（截图里那两条就是这么来的）。
  //   宁可留在队列里再试，也不要往群里灌第二条空话。
  const reviewIncomplete = res?.reason === 'chain_not_run'
    || res?.meta?.reviewDecisionWithheld === true
    || (res?.meta?.gate?.yes === true && !hasReviewDecision(res));
  if (!res || res.reason === 'llm_error' || res.reason === 'tool_exhausted' || reviewIncomplete
      || res.meta?.truncated === true || !res.reply) {
    it.tries = Number(it.tries ?? 0) + 1;
    it.last_tried_at = new Date().toISOString();
    it.last_layer = res?.meta?.llm?.layer ?? it.last_layer ?? null;
    it.last_error = reviewIncomplete ? `审查仍未完成：${res?.meta?.reviewFailure?.code ?? res?.reason ?? '缺少有效结论'}`
      : res?.meta?.truncated === true ? '答是答了，但被长度上限截断（正文不完整）'
      : res?.meta?.llm ? `layer=${res.meta.llm.layer}`
      : (res?.error ?? res?.reason ?? '仍答不上');
    if (it.tries >= MAX_TRIES) {
      deadDrop(`补发 ${it.tries} 次仍失败（最后：${it.last_error}）`);
      log(`   ✗ 补发 ${it.tries} 次仍未成功，落死信 —— 只在日志说`);
      return { acted: true, sent: false, why: 'tries-exhausted', left: q.items.length };
    }
    write(q, file ?? queuePath());
    log(`   · 补发第 ${it.tries} 次仍失败（${it.last_error}），留在队列，下一拍再试`);
    return { acted: true, sent: false, why: 'still-failing', left: q.items.length };
  }

  let sent = null;
  // ★★ 2026-10-26：补发也把**「这一轮是不是送审单」**交下去 —— 补发的正是「答失败/没跑成」那一类，
  //   而那正是最容易拿不到 §5.3 结论行的一类；不交这条读数，补发那条路会退回模型自由文本
  //   （与 12:21 那张 `query-answer` 同形）。判据仍是内核的 `meta.gate.yes`，不从文字里猜。
  try { sent = await send(it, RESEND_PREFIX + res.reply, replyOptionsForResult(res)); }
  catch (e) { sent = { ok: false, error: `${e?.message ?? e}` }; }
  if (!sent?.ok) {
    // answer() 会先记忆、后发送；未送达的记忆不能让下一拍误判已答。
    it.delivery_pending = true;
    it.tries = Number(it.tries ?? 0) + 1;
    it.last_error = `发送失败：${sent?.error ?? '未知'}`;
    if (it.tries >= MAX_TRIES) deadDrop(`答出来了但发不出去（${it.last_error}）`);
    else write(q, file ?? queuePath());
    log(`   ✗ 补发发送失败：${sent?.error ?? '未知'}`);
    return { acted: true, sent: false, why: 'send-failed', left: q.items.length };
  }
  removeItem();
  log(`   ✓ 已补发（引用 ${it.message_id}）→ ${(sent.messageIds ?? []).filter(Boolean).join(', ') || sent.mode || 'ok'}`);
  return { acted: true, sent: true, left: q.items.length };
}

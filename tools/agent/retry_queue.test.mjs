#!/usr/bin/env node
/**
 * retry_queue.test.mjs —— 补发队列的判据（Q1-1d 的自证）
 *
 *   node tools/agent/retry_queue.test.mjs --simulate     # 端到端（打桩发送器，**不真发群**）
 *
 * ⚠️ 全部落在临时目录：`SHOUHENG_RETRY_QUEUE` / `SHOUHENG_RETRY_DEAD` /
 *    `SHOUHENG_OUTBOUND_LEDGER` 在文件最上面就被指走（§2.4.4）。
 *
 * ── 为什么每一条都要有反面
 *
 * 补发是**唯一**会主动往群里再发一条的路径，它错的方向有两个，代价不对称：
 *   · 多发一条 → 群里看到同一件事被答两遍（幂等三重就是为了这个）；
 *   · 少发一条 → 回到「答不上就是永远答不上」的原点（那正是它存在的理由）。
 * 所以每条断言都配一个「它会不会恒真/恒假」的对照。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'retry_queue_'));
process.env.SHOUHENG_STATE_DIR = path.join(TMP, 'state');
process.env.SHOUHENG_LLM_API_KEY = 'retry-fixture-only';
process.env.SHOUHENG_LLM_BASE_URL = 'http://127.0.0.1:9';
process.env.SHOUHENG_RETRY_QUEUE = path.join(TMP, 'llm-retry-queue.json');
process.env.SHOUHENG_RETRY_DEAD = path.join(TMP, 'llm_deadletter.jsonl');
process.env.SHOUHENG_OUTBOUND_LEDGER = path.join(TMP, 'ws_outbound.jsonl');

// Config loads app credentials during import; this offline test uses fixtures only.
const readFile = fs.readFileSync;
fs.readFileSync = function (file, ...args) {
  const name = String(file);
  if (name.endsWith('/.dsh/credentials/shouheng-lark.json')) {
    return JSON.stringify({ app_id: 'retry-fixture', app_secret: 'retry-fixture-only' });
  }
  if (name.endsWith('/.config/opencode/opencode.json')) return '{}';
  if (name.endsWith('/.dsh/.credentials.yaml')) throw new Error('Real credentials are forbidden in offline tests');
  return readFile.call(this, file, ...args);
};
const q = await import('./retry_queue.mjs');
const ob = await import('./outbound.mjs');
fs.readFileSync = readFile;

const results = [];
const T = (id, ok, detail) => results.push({ id, ok, detail });

const CHAT = 'oc_sim';
const MSG = 'om_sim_1';
const QUESTION = '有没有拉材料？给个链接';

function ev(messageId = MSG, text = QUESTION) {
  return {
    sender: { sender_id: { open_id: 'ou_lqy' } },
    message: { message_id: messageId, chat_id: CHAT, chat_type: 'group', message_type: 'text',
               content: JSON.stringify({ text: `<at user_id="ou_bot">守衡</at> ${text}` }) },
  };
}
const freshQueue = () => { try { fs.unlinkSync(process.env.SHOUHENG_RETRY_QUEUE); } catch {} q.resetCache(); };
const readQueue = () => JSON.parse(fs.readFileSync(process.env.SHOUHENG_RETRY_QUEUE, 'utf8'));
const readDead = () => (fs.existsSync(process.env.SHOUHENG_RETRY_DEAD)
  ? fs.readFileSync(process.env.SHOUHENG_RETRY_DEAD, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
  : []);
const readLedger = () => (fs.existsSync(process.env.SHOUHENG_OUTBOUND_LEDGER)
  ? fs.readFileSync(process.env.SHOUHENG_OUTBOUND_LEDGER, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
  : []);
const resetLedger = () => { try { fs.unlinkSync(process.env.SHOUHENG_OUTBOUND_LEDGER); } catch {} };

const answerFail = async () => ({ reply: '我这边调用模型失败了', reason: 'llm_error', meta: { llm: { layer: 'DNS' } } });
const answerOk = async () => ({ reply: '拉了，材料在 research/kb 下，链接是 https://x/y', reason: 'ok', meta: {} });
const mkSend = () => {
  const calls = [];
  const send = async (item, text, options) => {
    calls.push({ item, text, options });
    // 模仿 daemon 的 replyTo：**先发、再记账**（台账的 source = resend）
    ob.recordSend({ chatId: item.chat_id, chatType: item.chat_type, messageIds: [`srv_${calls.length}`],
                    text, source: 'resend', replyTo: item.message_id, ok: true });
    return { ok: true, messageIds: [`srv_${calls.length}`] };
  };
  return { calls, send };
};

/* ── ① 入队：幂等①（同一个 message_id 只可能有一格）+ C7（不可重试类不入队） ── */
freshQueue(); resetLedger();
const item = q.itemFromEvent(ev(), { error: 'DNS 层失败', layer: 'DNS' });
T('从事件里抽得出队列要的那几格（含原文与重放用的 event）',
  !!item && item.message_id === MSG && item.chat_id === CHAT && item.text.includes('有没有拉材料') && !!item.event,
  JSON.stringify({ id: item?.message_id, text: item?.text }));
T('E1 入队成功', q.enqueue(item).ok === true, JSON.stringify(q.enqueue(item)));
T('C5 同一个 message_id 再入一次 → 拒绝（幂等①）',
  q.enqueue(q.itemFromEvent(ev())).ok === false, JSON.stringify(readQueue().items.length));
T('C7 不可重试类失败（HTTP 4xx）**不入队**',
  q.enqueue({ ...q.itemFromEvent(ev('om_sim_401')), retryable: false }).ok === false, '');
T('队列里仍只有 1 条（C5/C7 都没塞进去）', readQueue().items.length === 1, `实测 ${readQueue().items.length}`);

/* ── ② 端到端：先失败（不发）→ 再成功（补发一条） ── */
let res = await q.runTick({ answer: answerFail, send: mkSend().send, log: () => {} , sessionLoader: () => ({ messages: [] }) });
T('E2 补发仍失败 → **不发**（绝不往群里灌第二条）', res.acted === true && res.sent === false && res.why === 'still-failing',
  JSON.stringify(res));
T('E2b 失败后 tries=1，条目留在队列', readQueue().items[0].tries === 1, JSON.stringify(readQueue().items[0].tries));

const sender = mkSend();
res = await q.runTick({ answer: answerOk, send: sender.send, log: () => {}, sessionLoader: () => ({ messages: [] }) });
T('E3 答出来了 → 补发**恰好一条**', sender.calls.length === 1 && res.sent === true, JSON.stringify(res));
T('E3b 补发引用的是**原消息**（reply_to = 她那一条的 message_id）',
  sender.calls[0]?.item.message_id === MSG, sender.calls[0]?.item.message_id);
T('E3c 补发那一条带前缀（对方要知道这是迟到的补答）',
  (sender.calls[0]?.text ?? '').startsWith(q.RESEND_PREFIX.trim().slice(0, 6)), sender.calls[0]?.text?.slice(0, 24));
T('E3d 台账里落了一条 `resend`，且 reply_to 指回原消息',
  readLedger().some((r) => r.source === 'resend' && r.reply_to === MSG), JSON.stringify(readLedger().map((r) => [r.source, r.reply_to])));
T('E3e 队列已清空', readQueue().items.length === 0, `剩 ${readQueue().items.length}`);
T('E3f 补发成功**不落死信**', readDead().length === 0, `死信 ${readDead().length} 条`);

/* ── ③ 幂等②：台账里已经有**别的来源**答过 → 跳过 ── */
freshQueue(); resetLedger();
q.enqueue(q.itemFromEvent(ev()));
ob.recordSend({ chatId: CHAT, messageIds: ['srv_x'], text: '（补一条…）答过了', source: 'resend', replyTo: MSG, ok: true });
let s2 = mkSend();
res = await q.runTick({ answer: answerOk, send: s2.send, log: () => {}, sessionLoader: () => ({ messages: [] }) });
T('C6 台账里已有 `resend` 成功记录 → 跳过，不打桩发送器',
  s2.calls.length === 0 && res.sent === false && /已答过/.test(res.why ?? ''), JSON.stringify(res));

/* ── ④ 幂等②的**反面**：台账里只有失败话术那一条（source=reply）时，**不许**跳过 ──
 *
 * ★ 这是这个模块最容易写错的一格，也是它第一版真的会写错的地方：
 *   失败话术自己就是走 `replyTo` 发出去的，它记的 `reply_to` 正是这条 `message_id`。
 *   如果判据写成「台账里有一条 reply_to == id 的成功记录就跳过」，那么它**恒为真**，
 *   队列一条都补不出去 —— 而每一格都「有理由」。**这句话比我的输入大吗？**（§2.4.1）
 */
freshQueue(); resetLedger();
q.enqueue(q.itemFromEvent(ev()));
ob.recordSend({ chatId: CHAT, messageIds: ['srv_fail'], text: '我这边调用模型失败了，没法回答这个问题。',
                source: 'reply', replyTo: MSG, ok: true });
let s3 = mkSend();
res = await q.runTick({ answer: answerOk, send: s3.send, log: () => {}, sessionLoader: () => ({ messages: [] }) });
T('C6b 台账里**只有失败话术**（source=reply）→ **必须补发**（否则判据恒真、队列形同虚设）',
  s3.calls.length === 1 && res.sent === true, `发送次数=${s3.calls.length} res=${JSON.stringify(res)}`);

/* ── ⑤ 幂等③：会话记忆里已经有**真回答** → 跳过；只有失败话术 → 不跳 ── */
const sessWithAnswer = { messages: [
  { role: 'user', content: `【对接人】${QUESTION}` },
  { role: 'assistant', content: '拉了，材料在 research/kb 下。' },
] };
const sessWithFailureOnly = { messages: [
  { role: 'user', content: `【对接人】${QUESTION}` },
  { role: 'assistant', content: '我这边调用模型失败了，没法回答这个问题。', llm_error: true },
] };
T('C6c 记忆里已有真回答 → 跳过', q.answeredInMemory({ text: QUESTION }, sessWithAnswer).answered === true, '');
T('C6d 记忆里只有失败话术（带 llm_error 标记）→ **不跳**',
  q.answeredInMemory({ text: QUESTION }, sessWithFailureOnly).answered === false, '');
T('C6e 记忆读不出 → 不跳（未测不许当成「已答」）',
  q.answeredInMemory({ text: QUESTION }, null).answered === false, '');

/* ★ C6g/C6h：**第二种失败话术** —— 兜底话术（`tool_exhausted`）。
 *
 * 2026-09-22 实测事故：上游在私聊里连问两次「你如何读取我 DSH 上的知识库」，
 * 两次都跑满 6 轮工具、两次都收到兜底话术。那时 `reason` 是 `'ok'`（因为兜底话术
 * 有 `reply`），于是**补发队列认为她已经被答过了**，一条都补不出去。
 *
 * 这一对正反面是同一个形状的第二次出现（第一次是 C6b：台账里的失败话术自己
 * 就带着 `reply_to == 该 message_id`，判「已答」会**恒真**）。
 * 判据必须是**结构标记**，不是「有没有 reply」、也不是比对那句文案。 */
const sessWithFallbackOnly = { messages: [
  { role: 'user', content: `【对接人】${QUESTION}` },
  { role: 'assistant', content: '这个问题我没答上来 —— 查了几轮，还是没能得出可靠结论。', tool_exhausted: true },
] };
T('C6g 记忆里只有兜底话术（带 tool_exhausted 标记）→ **不跳**',
  q.answeredInMemory({ text: QUESTION }, sessWithFallbackOnly).answered === false,
  '漏掉这条 → 「答不上」就等于「永远答不上」，而这正是本模块存在的全部理由');
// 反面：把标记去掉，同一段文案**必须**被当成真回答 —— 否则上面的「不跳」
// 可能是因为「这句话本身被认出来是话术」（那就成了文案比对，改一个字就失效）。
const sessWithFallbackUnmarked = { messages: [
  { role: 'user', content: `【对接人】${QUESTION}` },
  { role: 'assistant', content: '这个问题我没答上来 —— 查了几轮，还是没能得出可靠结论。' },
] };
T('C6h 同一句话**不带标记**时算真回答（证明 C6g 判的是结构，不是文案）',
  q.answeredInMemory({ text: QUESTION }, sessWithFallbackUnmarked).answered === true,
  '若这条也判「不跳」，说明判据变成了文案匹配 —— 改一个字就会失效');

// C6i 接线：reason === 'tool_exhausted' 时必须留在队列（而不是当成「答出来了」发出去）
freshQueue(); resetLedger();
q.enqueue(q.itemFromEvent(ev('om_fallback_1')));
let sFb = mkSend();
const answerFallback = async () => ({ reply: '这个问题我没答上来 —— 查了几轮。', reason: 'tool_exhausted', meta: { toolTrace: [{ tool: 'run_readonly_command', ok: true }] } });
res = await q.runTick({ answer: answerFallback, send: sFb.send, log: () => {}, sessionLoader: () => ({ messages: [] }) });
T('C6i `reason=tool_exhausted` → 不算答出来（留在队列，且**没往群里发**）',
  sFb.calls.length === 0 && readQueue().items.length === 1 && readQueue().items[0].tries === 1,
  JSON.stringify({ sent: sFb.calls.length, queue: readQueue().items.length, why: res.why }));

/* ★ C6j–C6m：**第三种失败形状** —— 截断说明（`truncated`）。
 *
 * 2026-09-30 实测事故（本群 19:11 / 19:16，截图里那两条空回答）：
 *   她问「用知识库查一下『吸奶器』相关的措辞要求」→ 工具回了 60,349 字原始 JSON
 *   → 下一轮推理把 8000 token 输出预算吃光 → 正文 0 字。
 *   `annotateTruncation()` 把一句「⚠️ 这条回答被长度上限截断了……」当成了回复**发进群**，
 *   而队列看到「她问话后面有一条不带失败标记的 assistant」就判「已答过」→ **出队**。
 *   于是那条消息的答案**永远没发出去**，她还收到了两条只有说明、没有内容的回复。
 *
 * 与 C6g/C6h 是同一个形状的第三次出现。判据必须是结构标记。 */
const sessWithCutOnly = { messages: [
  { role: 'user', content: `【Owner】${QUESTION}` },
  { role: 'assistant', content: '\n\n---\n⚠️ 这条回答被长度上限截断了（finish_reason=length（额度耗尽）），上面是不完整的。', truncated: true },
] };
T('C6j 记忆里只有截断说明（带 truncated 标记）→ **不跳**（否则答案永远发不出去）',
  q.answeredInMemory({ text: QUESTION }, sessWithCutOnly).answered === false,
  '这正是 2026-09-30 那次「队列把她出队、答案再没出现」的成因');
const sessWithCutUnmarked = { messages: [
  { role: 'user', content: `【Owner】${QUESTION}` },
  { role: 'assistant', content: '\n\n---\n⚠️ 这条回答被长度上限截断了（finish_reason=length（额度耗尽）），上面是不完整的。' },
] };
T('C6k 同一句话**不带标记**时算真回答（证明 C6j 判的是结构，不是文案）',
  q.answeredInMemory({ text: QUESTION }, sessWithCutUnmarked).answered === true,
  '若这条也判「不跳」，说明判据退化成了文案匹配 —— 改一个字就失效');

freshQueue(); resetLedger();
q.enqueue(q.itemFromEvent(ev('om_cut_1')));
let sCut = mkSend();
const answerTruncated = async () => ({
  reply: '\n\n---\n⚠️ 这条回答被长度上限截断了（finish_reason=length（额度耗尽）），上面是不完整的。',
  reason: 'ok', meta: { truncated: true },
});
res = await q.runTick({ answer: answerTruncated, send: sCut.send, log: () => {}, sessionLoader: () => ({ messages: [] }) });
T('C6l 补发回来的是一条**被截断**的回答 → 不发进群、留在队列',
  sCut.calls.length === 0 && readQueue().items.length === 1 && readQueue().items[0].tries === 1,
  JSON.stringify({ sent: sCut.calls.length, queue: readQueue().items.length, why: res.why }));
T('C6m 失败理由说得清是「被截断」而不是「没答」',
  /截断/.test(readQueue().items[0]?.last_error ?? ''), String(readQueue().items[0]?.last_error));

// 反面：下一拍答完整了 → 必须真的补发出去，且出队（否则上面那条会把队列焊死）
let sCut2 = mkSend();
res = await q.runTick({ answer: answerOk, send: sCut2.send, log: () => {}, sessionLoader: () => ({ messages: [] }) });
T('C6n 反面：下一拍答完整了 → 照常补发、出队',
  sCut2.calls.length === 1 && readQueue().items.length === 0,
  JSON.stringify({ sent: sCut2.calls.length, left: readQueue().items.length }));

freshQueue(); resetLedger();
q.enqueue(q.itemFromEvent(ev()));
let s4 = mkSend();
res = await q.runTick({ answer: answerOk, send: s4.send, log: () => {}, sessionLoader: () => sessWithAnswer });
T('C6f ③ 的接线真的生效（队列里那一条被跳过，发送器一次没被调）',
  s4.calls.length === 0 && /已答过/.test(res.why ?? ''), JSON.stringify(res));

/* ── ⑥ 上限与窗口：越限落死信，**只在日志说** ── */
freshQueue(); resetLedger();
const it2 = { ...q.itemFromEvent(ev('om_dead_1')), tries: 4 };
q.enqueue(it2);
let s5 = mkSend();
res = await q.runTick({ answer: answerFail, send: s5.send, log: () => {}, sessionLoader: () => ({ messages: [] }) });
T('C4b 第 5 次仍失败 → 落死信、出队、不发', readDead().length === 1 && readQueue().items.length === 0 && s5.calls.length === 0,
  JSON.stringify({ dead: readDead().length, left: readQueue().items.length }));

freshQueue(); resetLedger();
const old = new Date(Date.now() - 61 * 60 * 1000).toISOString();
q.enqueue({ ...q.itemFromEvent(ev('om_old_1')), first_failed_at: old });
let s6 = mkSend();
let answered = 0;
res = await q.runTick({ answer: async () => { answered++; return answerOk(); }, send: s6.send, log: () => {},
                        sessionLoader: () => ({ messages: [] }) });
T('C4c 超过 60 分钟窗口 → 直接落死信，**连答案都不去要**（隔一小时才蹦出来比不答更糟）',
  answered === 0 && readDead().length >= 1 && readQueue().items.length === 0, JSON.stringify({ answered, dead: readDead().length }));

/* ── ⑦ 纯函数 decide：上限/窗口/坏条目各自分得开 ── */
const now = new Date('2026-09-22T12:00:00Z');
const mk = (id, o = {}) => ({ message_id: id, tries: 0, first_failed_at: '2026-09-22T11:50:00Z', ...o });
const d = q.decide({ items: [mk('a'), mk('b', { tries: 5 }), mk('c', { first_failed_at: '2026-09-22T10:00:00Z' }),
                              mk('d', { first_failed_at: '看读不出来' })] }, now);
T('C8 decide：超次/超窗/坏条目各自进 drop，且理由说得出来',
  d.pick === 'a' && d.drop.map((x) => x.message_id).sort().join(',') === 'b,c,d' && d.drop.every((x) => x.why),
  JSON.stringify(d.drop.map((x) => [x.message_id, x.why])));
T('C8b decide：一次只挑**最老的那一条**（补发本身要花一次模型调用）',
  q.decide({ items: [mk('new', { first_failed_at: '2026-09-22T11:55:00Z' }),
                     mk('old', { first_failed_at: '2026-09-22T11:10:00Z' })] }, now).pick === 'old', '');
T('C8c decide：空队列 → pick=null（跑一次决定不等于发一条）',
  q.decide({ items: [] }, now).pick === null, '');

/* ── ⑧ 单飞/不丢：补发的 await 窗口里新来的失败**不许被旧快照抹掉**（§2.4.3 那个坑） ── */
freshQueue(); resetLedger();
q.enqueue(q.itemFromEvent(ev('om_race_1')));
let release; const gate = new Promise((r) => { release = r; });
const p = q.runTick({
  answer: async () => { await gate; return answerOk(); },
  send: mkSend().send, log: () => {}, sessionLoader: () => ({ messages: [] }),
});
q.enqueue(q.itemFromEvent(ev('om_race_2')));       // ← 就在 await 窗口里进来的
release();
res = await p;
const after = readQueue();
T('C9 await 窗口里入队的那条**没被旧快照抹掉**（一个写者 + 内存态）',
  after.items.length === 1 && after.items[0].message_id === 'om_race_2',
  JSON.stringify(after.items.map((x) => x.message_id)));

/* BM04 2026-11-02：审查仍失败时不能把告警当答案，成功后保留权威结论。 */
const passLine = '【PASS】未发现已知底线风险，可转交 @法务 进行 sign-off。';
const pendingReviews = [
  { name: 'chain_not_run', reason: 'chain_not_run', meta: { gate: { yes: true }, verdict53: null } },
  { name: '送审但结论缺失', reason: 'ok', meta: { gate: { yes: true }, verdict53: null } },
  { name: '结论被完整性检查扣住', reason: 'ok', meta: { gate: { yes: true }, reviewDecisionWithheld: true,
      verdict53: { state: 'PASS', line: passLine } } },
  { name: '伪结论行', reason: 'ok', meta: { gate: { yes: true }, verdict53: { state: 'PASS', line: 'PASS（未完成）' } } },
];
for (const sample of pendingReviews) {
  freshQueue(); resetLedger();
  q.enqueue(q.itemFromEvent(ev()));
  const pendingSend = mkSend();
  const result = await q.runTick({ answer: async () => ({ ...sample, reply: '审查未完成，暂时不能据此放行。' }),
    send: pendingSend.send, ledgerEntries: [], sessionLoader: () => ({ messages: [] }) });
  T(`R1 ${sample.name}：不发告警补答，增加失败次数并保留任务`,
    result.sent === false && pendingSend.calls.length === 0 && readQueue().items[0]?.tries === 1,
    JSON.stringify({ result, sent: pendingSend.calls.length, items: readQueue().items }));
}

// 对照：真实权威结论独立于模型回复，发送后才出队。
const successfulReview = { reason: 'ok', reply: '模型未抄写结论行。', meta: {
  gate: { yes: true }, verdict53: { state: 'PASS', line: passLine },
  reportLink: 'https://example.test/report', reviewDecisionWithheld: false,
} };
freshQueue(); resetLedger();
q.enqueue(q.itemFromEvent(ev()));
const completeSend = mkSend();
const completed = await q.runTick({ answer: async () => successfulReview, send: completeSend.send,
  ledgerEntries: [], sessionLoader: () => ({ messages: [] }) });
T('R2 恢复后发送权威结论和报告链接，且只成功一次',
  completed.sent === true && completeSend.calls.length === 1 && readQueue().items.length === 0
    && completeSend.calls[0].options?.verdict53?.line === passLine
    && completeSend.calls[0].options?.reportLink === 'https://example.test/report',
  JSON.stringify({ completed, options: completeSend.calls[0]?.options }));

const pendingMemory = { messages: [
  { role: 'user', content: QUESTION },
  { role: 'assistant', content: '审查未完成', chain_not_run: true },
  { role: 'user', content: '另一条问题' },
  { role: 'assistant', content: '另一条问题的答案' },
] };
T('R3 后续另一条问题的答案不能清除当前待补审任务',
  q.answeredInMemory(item, pendingMemory).answered === false,
  JSON.stringify(q.answeredInMemory(item, pendingMemory)));
T('R4 处理中回执不是审查答案',
  q.answeredInMemory(item, { messages: [
    { role: 'user', content: QUESTION },
    { role: 'assistant', content: '处理中', outbound: { source: 'chain-ack' } },
  ] }).answered === false, '只收到回执时须保留任务');
T('R4b 素材链接读取失败的说明不是审查答案',
  q.answeredInMemory(item, { messages: [
    { role: 'user', content: QUESTION },
    { role: 'assistant', content: '视频链接未能读取。', link_read_failed: true },
  ] }).answered === false, '链接读取故障时仍需补审');

freshQueue(); resetLedger();
const unwritableQueue = path.join(TMP, 'queue-is-a-directory');
fs.mkdirSync(unwritableQueue);
const notPersisted = q.enqueue(q.itemFromEvent(ev()), { file: unwritableQueue });
T('R5 无法持久化时不可宣称已入队', notPersisted.ok === false && !!notPersisted.why,
  JSON.stringify(notPersisted));
let falseQueuedAnswer = 0;
const notQueued = await q.runTick({ file: unwritableQueue, answer: async () => { falseQueuedAnswer++; return answerOk(); },
  send: mkSend().send, ledgerEntries: [], sessionLoader: () => ({ messages: [] }) });
T('R5b 持久化失败后不留下假入队内存项', falseQueuedAnswer === 0 && notQueued.left === 0,
  JSON.stringify(notQueued));

freshQueue(); resetLedger();
q.enqueue(q.itemFromEvent(ev()));
const deliveryMemory = { messages: [{ role: 'user', content: QUESTION }] };
let deliveryAttempts = 0;
const retryDelivery = {
  answer: async () => {
    deliveryMemory.messages.push({ role: 'assistant', content: '这条审查已经完成。' });
    return successfulReview;
  },
  send: async () => (++deliveryAttempts === 1 ? { ok: false, error: 'temporary send failure' } : { ok: true }),
  ledgerEntries: [], sessionLoader: () => deliveryMemory,
};
const firstDelivery = await q.runTick(retryDelivery);
T('R6 答案已进记忆但发送失败时保留任务', firstDelivery.sent === false && readQueue().items.length === 1,
  JSON.stringify(firstDelivery));
const secondDelivery = await q.runTick(retryDelivery);
T('R6b 下一拍仍需发送，不把未送达的记忆当成功',
  secondDelivery.sent === true && deliveryAttempts === 2 && readQueue().items.length === 0,
  JSON.stringify({ secondDelivery, deliveryAttempts }));

const nFail = results.filter((r) => !r.ok).length;
for (const r of results) console.log(`  ${r.ok ? '✅' : '❌'} ${r.id}${r.ok ? '' : `  ← ${r.detail}`}`);
console.log(`\n${nFail ? '❌' : '✅'} retry_queue ${results.length - nFail}/${results.length} 项通过`
            + `（临时目录 ${path.basename(TMP)}；**一台真发送器都没碰**，群里不会多出任何一条）`);
process.exit(nFail ? 1 : 0);

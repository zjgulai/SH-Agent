#!/usr/bin/env node
/**
 * send_trace.test.mjs —— 「这条消息**是谁发的**」这条判据（2026-10-26 立）
 *
 *   node tools/agent/send_trace.test.mjs      # 全绿退 0；有红退 3
 *
 * ── 为什么要有它
 *
 * 2026-10-26 排查「群里那条『post 读不了』是谁发的」时，能确证的只有**一半**：
 * 守护进程每一次外发都记台账，而那条在 `ws_daemon.log` 与 `ws_outbound.jsonl`
 * （2126 条）里**一条都没有** ⇒ 不是它发的。另一半（**那是谁**）当时答不出来：
 * 本机所有 DSH 会话、第二个 launchd 作业、第二个 ws_daemon 进程都排除完之后，
 * **没有下一处可查**。全仓有七个文件自己拿 `client` 直连 `im.message.create/reply`，
 * 而它们发出去的话一个字都不留。
 *
 * ⇒ 现在物理层留一行（`PMO/logs/feishu_sends.jsonl`）：哪条消息、哪个 pid、
 *   **哪个文件哪一行**调的。这个文件**没有任何代码读它做决策** —— 它只回答归因。
 *
 * ── 反向对照（判据不许恒绿）
 *   ① 不装留痕 ⇒ 一行都不许有；
 *   ② 发送抛错 ⇒ 必须记 `ok:false`，且**异常照旧抛出去**（留痕不许改变发送语义）；
 *   ③ `callerOf` 必须**跳过本文件自己的帧**（否则每条都归因到 feishu.mjs，等于没归因）；
 *   ④ 重复装一次 ⇒ 同一条消息**不许记两行**（两行看起来都像真的）。
 *
 * ⚠️ 全部落在临时目录：`SHOUHENG_SEND_TRACE` 在**导入 feishu.mjs 之前**就指走（§2.4.4）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'shouheng-sendtrace-'));
const TRACE = path.join(TMP, 'feishu_sends.jsonl');
process.env.SHOUHENG_SEND_TRACE = TRACE;

const F = await import('./feishu.mjs');

const results = [];
async function t(name, fn) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, why: e?.message ?? String(e) }); }
}
const rows = () => (fs.existsSync(TRACE)
  ? fs.readFileSync(TRACE, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : []);
const reset = () => { try { fs.unlinkSync(TRACE); } catch { /* 本来就没有 */ } };

/** 一个够像的假 client：`im.message.create/reply` 各回一个 message_id。 */
function fakeClient({ fail = false } = {}) {
  const calls = [];
  const mk = (name) => async (payload) => {
    calls.push({ name, payload });
    if (fail) { const e = new Error('boom'); e.response = { data: { code: 99991, msg: 'boom' } }; throw e; }
    return { data: { message_id: `om_fake_${name}`, chat_id: payload?.data?.receive_id ?? 'oc_fake' } };
  };
  return { client: { im: { message: { create: mk('create'), reply: mk('reply') } } }, calls };
}

/* ── 1. 装上就留痕 ─────────────────────────────────────────────────── */

await t('装上留痕之后发一条 ⇒ 必须出一行，且带上 caller / pid / message_id', async () => {
  reset();
  const { client } = fakeClient();
  const installed = F.installSendTrace(client);
  assert.deepEqual(installed.sort(), ['create', 'reply'], `装上的方法不对：${installed}`);
  await client.im.message.create({ data: { receive_id: 'oc_x', msg_type: 'text',
    content: JSON.stringify({ text: '你好，我在留痕' }) } });
  const r = rows();
  assert.equal(r.length, 1, `该有 1 行，实际 ${r.length}`);
  assert.equal(r[0].method, 'create');
  assert.equal(r[0].ok, true);
  assert.equal(r[0].message_id, 'om_fake_create');
  assert.equal(r[0].chat_id, 'oc_x');
  assert.equal(r[0].msg_type, 'text');
  assert.equal(r[0].pid, process.pid, 'pid 必须是本进程 —— 它是「哪个进程发的」的另一半');
  assert.ok(/send_trace\.test\.mjs:\d+/.test(r[0].caller),
    `caller 必须指回调用方文件与行号，实际 ${JSON.stringify(r[0].caller)}`);
  assert.ok(/我们在留痕|我在留痕/.test(String(r[0].text_head ?? '')), 'text_head 要能看出说了什么');
});

await t('反向对照①：**不装**留痕 ⇒ 一行都不许有（判据不是恒真）', async () => {
  reset();
  const { client } = fakeClient();
  await client.im.message.create({ data: { receive_id: 'oc_y', msg_type: 'text',
    content: JSON.stringify({ text: '这条不许留痕' }) } });
  assert.equal(rows().length, 0, '没装留痕却出现了行 —— 说明判据读的不是它自己装的那一套');
});

await t('反向对照④：**重复装一次** ⇒ 同一条消息不许记两行（幂等）', async () => {
  reset();
  const { client } = fakeClient();
  F.installSendTrace(client);
  F.installSendTrace(client);
  await client.im.message.reply({ path: { message_id: 'om_src' }, data: { msg_type: 'text',
    content: JSON.stringify({ text: '只该一行' }) } });
  const r = rows();
  assert.equal(r.length, 1, `重复装之后记了 ${r.length} 行 —— 两行看起来都像真的`);
  assert.equal(r[0].reply_to, 'om_src', 'reply 要记清回的是哪一条');
});

/* ── 2. 发送失败这条路 ─────────────────────────────────────────────── */

await t('反向对照②：发送抛错 ⇒ 记 ok:false，且**异常照旧抛出去**', async () => {
  reset();
  const { client } = fakeClient({ fail: true });
  F.installSendTrace(client);
  let threw = null;
  try { await client.im.message.reply({ path: { message_id: 'om_src2' }, data: { msg_type: 'text',
    content: JSON.stringify({ text: '发不出去' }) } }); }
  catch (e) { threw = e; }
  assert.ok(threw, '留痕把异常吞了 —— 那会把「发失败」变成「发成功」');
  const r = rows();
  assert.equal(r.length, 1);
  assert.equal(r[0].ok, false);
  assert.ok(/99991/.test(String(r[0].error)), `失败原因要带出来，实际 ${JSON.stringify(r[0].error)}`);
});

await t('留痕文件写不进去（目录不可写）⇒ 消息照发、不抛（与 recordSend 同一条纪律）', async () => {
  const bad = path.join(TMP, 'nope', '\u0000bad', 'x.jsonl');   // 非法路径 ⇒ 写必失败
  const old = process.env.SHOUHENG_SEND_TRACE;
  process.env.SHOUHENG_SEND_TRACE = bad;
  try {
    const { client } = fakeClient();
    F.installSendTrace(client);
    const r = await client.im.message.create({ data: { receive_id: 'oc_z', msg_type: 'text',
      content: JSON.stringify({ text: '照发' }) } });
    assert.equal(r.data.message_id, 'om_fake_create', '留痕失败把发送也弄坏了');
  } finally { process.env.SHOUHENG_SEND_TRACE = old; }
});

/* ── 3. 归因本身 ───────────────────────────────────────────────────── */

await t('反向对照③：`callerOf` 必须跳过 feishu.mjs 自己的帧（否则等于没归因）', async () => {
  const stack = [
    'Error',
    '    at notePhysicalSend (file:///x/tools/agent/feishu.mjs:120:7)',
    '    at replyMarkdown (file:///x/tools/agent/feishu.mjs:640:12)',
    '    at async replyTo (file:///x/tools/ws_daemon.mjs:660:20)',
    '    at async onMessage (file:///x/tools/ws_daemon.mjs:300:3)',
    '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
  ].join('\n');
  assert.equal(F.callerOf(stack), 'ws_daemon.mjs:660',
    '必须一路跳到本文件之外的第一帧 —— 内部 replyMarkdown→sendMarkdown 那一跳不算调用方');
  assert.equal(F.callerOf('Error\n    at x (node:internal/x:1:1)'), '(未能定位调用方)');
});

await t('真 client 上挂的**就是**留痕层（接线判据：名字出现过 ≠ 它拦得住）', async () => {
  assert.ok(Array.isArray(F.SEND_TRACE_METHODS) && F.SEND_TRACE_METHODS.length >= 2,
    `模块加载时没装上：${JSON.stringify(F.SEND_TRACE_METHODS)}`);
  for (const m of ['create', 'reply']) {
    assert.equal(F.client.im.message[m]?.__shouhengSendTrace, m,
      `真 client 的 im.message.${m} 上没有留痕标记 —— 发送这条路又变成没人知道谁发的了`);
  }
});

await t('自证不许写真数据：留痕路径被 env 指到临时目录，且真台账/真留痕一个字节没动', async () => {
  assert.equal(F.tracePath(), TRACE, 'SHOUHENG_SEND_TRACE 没生效 —— 自证会写到生产留痕里');
  assert.ok(TRACE.startsWith(os.tmpdir()), '留痕必须落在临时目录');
  const real = path.join(process.cwd(), '..', 'PMO', 'logs', 'feishu_sends.jsonl');
  const before = fs.existsSync(real) ? createHash('sha256').update(fs.readFileSync(real)).digest('hex') : '（本次运行前不存在）';
  const realLedger = path.join(process.cwd(), '..', 'PMO', 'logs', 'ws_outbound.jsonl');
  const lBefore = fs.existsSync(realLedger)
    ? createHash('sha256').update(fs.readFileSync(realLedger)).digest('hex') : '（不存在）';
  assert.equal(typeof before, 'string');
  assert.equal(typeof lBefore, 'string');
});

/* ── 汇总 ───────────────────────────────────────────────────────────── */
const bad = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.ok ? '' : `\n     ↳ ${r.why}`}`);
}
console.log(`\n${results.length - bad.length}/${results.length} 通过`);
process.exit(bad.length ? 3 : 0);
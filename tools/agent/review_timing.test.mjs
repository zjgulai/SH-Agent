#!/usr/bin/env node
// Exercise daemon receiving, shaping, sending and retry wiring with a controlled
// clock and transport. No daemon startup, credentials, network or real state.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { toCardOrText } from '../reply-cards/envelope.mjs';
import { deriveVerdictLine } from './prd53.mjs';
import { plainify } from './plain.mjs';
import { replyOptionsForResult, shouldRetryReview } from './review_feedback.mjs';
import * as deadlines from './review_deadline.mjs';

const reviewTiming = await import('./review_timing.mjs').catch((error) => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const source = fs.readFileSync(new URL('../ws_daemon.mjs', import.meta.url), 'utf8');
const incoming = source.slice(source.indexOf('function ingressMsOf('), source.indexOf('\n/**\n * 补发队列'));
const retry = source.slice(source.indexOf('let retryBusy = false;'), source.indexOf('\n/**\n * 外部标准库'));
const senderStart = source.indexOf('async function replyTo(');
const sender = source.slice(senderStart, source.indexOf('\n/**\n * 主动发送', senderStart));
const START = 1793617810593;
const event = (createTime = START) => ({ message: { message_id: 'om_timing_image',
  chat_id: 'oc_timing', chat_type: 'p2p', message_type: 'image',
  create_time: createTime === null ? undefined : String(createTime), content: '{}' } });
const complete = () => ({ reason: 'ok', reply: '【审查结论：PASS】未发现已知底线风险，可转交 @负责人 进行 sign-off。',
  meta: { gate: { yes: true }, media: { images: 1 }, reviewDecisionWithheld: false,
    verdict53: { state: 'PASS', line: '【审查结论：PASS】未发现已知底线风险，可转交 @负责人 进行 sign-off。', from: 'fixture' } } });

async function deliver({ elapsed = 1000, sendMs = 10, result = complete(),
  fail = false, receipt = false, resend = false, createTime = START, ledgerMs = 0, messageType = 'image' } = {}) {
  let now = START + 10;
  const logs = [];
  const outbound = [];
  const delivered = [];
  const data = event(createTime);
  data.message.message_type = messageType;
  class Clock extends Date { static now() { return now; } }
  const transport = async (messageId, payload, mode) => {
    assert.equal(messageId, 'om_timing_image');
    if (mode === 'reply-card' && JSON.stringify(payload).includes('处理中')) {
      delivered.push({ receipt: true, at: now });
    } else {
      now += sendMs;
      delivered.push({ receipt: false, at: now });
    }
    return fail ? { ok: false, error: 'fixture delivery failed', mode }
      : { ok: true, messageId: 'om_timing_sent', messageIds: ['om_timing_sent'], mode };
  };
  const sandbox = {
    reviewDeadline: { ...deadlines, withReviewDeadline: (at, task) => deadlines.withReviewDeadline(at, task, { now: () => now }) },
    Date: Clock, reviewTiming, counters: { events: 0, handled: 0, replied: 0, failed: 0, skipped: 0 },
    DUMP_ONLY: false, SCHEDULED_PUSH: true, dumpRaw() {}, log: (...args) => logs.push(args.join(' ')), saveChatId() {},
    LARK_DOC_RE: /never-matches-fixture/, mediaWithoutChain: () => null,
    replyOptionsForResult, shouldRetryReview, deriveVerdictLine, toCardOrText, plainify,
    shapeOf: () => 'fixture', dumpDropped() {}, recordOutbound: (_chat, sent, detail) => {
      outbound.push({ sent, detail }); now += ledgerMs;
    },
    handleMessage: async (_event, options) => {
      if (resend && createTime === START) {
        assert.equal(options.tIngress, START, 'retry execution must retain the original deadline origin');
        assert.equal(options.tIngressOrigin, 'create_time');
      }
      if (receipt && options.notify) await options.notify('[[card:receipt]]\n' + JSON.stringify({ verdict: '处理中…', detail: '正在审查。' }));
      now = START + elapsed;
      return result;
    },
    retryQueue: {
      itemFromEvent: () => ({ message_id: 'om_timing_image' }), enqueue: () => ({ ok: true, size: 1 }),
      runTick: async ({ answer, send }) => {
        const item = { event: data, message_id: 'om_timing_image', chat_id: 'oc_timing', chat_type: 'p2p',
          first_failed_at: new Date(START + 300000).toISOString() };
        const reply = await answer(item);
        const sent = await send(item, reply.reply, replyOptionsForResult(reply));
        return { acted: true, sent: sent.ok, left: sent.ok ? 0 : 1 };
      },
    },
    feishu: { bodyToText: () => ({ text: '' }), imageKeysOf: () => ['fixture'],
      replyCard: (id, card) => transport(id, card, 'reply-card'),
      replyMarkdown: (id, _chat, text) => transport(id, text, 'reply-post'),
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${incoming}\n${retry}\n${sender}\nglobalThis.receive = onMessage; globalThis.retry = retryWatch;`, sandbox);
  if (resend) await sandbox.retry('test');
  else await sandbox.receive(data);
  const metrics = logs.filter((line) => line.includes('[metric] review_delivery_ms='));
  return { metrics, logs, outbound, delivered };
}

await test('real sender measures until the final card arrives, not the earlier receipt', async () => {
  const r = await deliver({ elapsed: 179980, sendMs: 20, receipt: true });
  assert.equal(r.metrics.length, 1, 'exactly one final delivery metric is required');
  assert.match(r.metrics[0], /review_delivery_ms=180000\b/);
  assert.match(r.metrics[0], /verdict=pass\b/);
  assert.match(r.metrics[0], /message=om_timing_image\b/);
  assert.match(r.metrics[0], /completed=yes\b/);
  assert.match(r.metrics[0], /source=reply\b/);
});
await test('a final send crossing 180 seconds must fail even if computation finished in budget', async () => {
  const r = await deliver({ elapsed: 179990, sendMs: 20 });
  assert.equal(r.metrics.length, 1);
  assert.match(r.metrics[0], /review_delivery_ms=180010\b/);
  assert.match(r.metrics[0], /verdict=FAIL\b/);
  assert.match(r.metrics[0], /reason=deadline_exceeded\b/);
});
await test('the stop time is transport completion, not later outbound bookkeeping', async () => {
  const r = await deliver({ elapsed: 179980, sendMs: 20, ledgerMs: 3000 });
  assert.equal(r.metrics.length, 1);
  assert.match(r.metrics[0], /review_delivery_ms=180000\b/);
  assert.match(r.metrics[0], /verdict=pass\b/);
});
await test('an incomplete alert delivered quickly is not a successful review', async () => {
  const result = complete();
  result.meta.reviewDecisionWithheld = true;
  result.meta.reviewFailure = { code: 'chain_error', retryable: true };
  const r = await deliver({ result });
  assert.equal(r.metrics.length, 1);
  assert.match(r.metrics[0], /completed=no\b/);
  assert.match(r.metrics[0], /verdict=FAIL\b/);
  assert.match(r.metrics[0], /reason=review_incomplete\b/);
});
await test('a successful verdict with failed card and text delivery is not successful', async () => {
  const r = await deliver({ fail: true });
  assert.equal(r.metrics.length, 1);
  assert.match(r.metrics[0], /sent=fail\b/);
  assert.match(r.metrics[0], /verdict=FAIL\b/);
  assert.match(r.metrics[0], /reason=send_failed\b/);
});
await test('post-image retry wiring retains original create_time and blocks expired sends without the image message-type fallback', async () => {
  const r = await deliver({ elapsed: 350000, sendMs: 50, resend: true, messageType: 'post' });
  assert.equal(r.metrics.length, 1);
  assert.match(r.metrics[0], /review_delivery_ms=350000\b/);
  assert.equal(r.delivered.length, 0, 'an expired image retry cannot send a new message');
  assert.match(r.metrics[0], /verdict=FAIL\b/);
  assert.match(r.metrics[0], /source=resend\b/);
});
await test('a retry completed within the original deadline can pass', async () => {
  const r = await deliver({ elapsed: 170000, sendMs: 50, resend: true });
  assert.equal(r.metrics.length, 1);
  assert.match(r.metrics[0], /review_delivery_ms=170050\b/);
  assert.match(r.metrics[0], /verdict=pass\b/);
});
await test('missing original create_time is unmeasured and cannot be counted as success', async () => {
  const r = await deliver({ createTime: null });
  assert.equal(r.metrics.length, 1);
  assert.match(r.metrics[0], /verdict=UNTESTED\b/);
  assert.match(r.metrics[0], /ingress=local\b/);
});
await test('an old original timestamp cannot be replaced by the retry start to make a pass', async () => {
  const r = await deliver({ createTime: START - 2 * 86400000, resend: true });
  assert.equal(r.metrics.length, 1);
  assert.doesNotMatch(r.metrics[0], /verdict=pass\b/);
});
await test('a future create_time cannot create a negative fast result', async () => {
  const r = await deliver({ createTime: START + 30000 });
  assert.equal(r.metrics.length, 1);
  assert.match(r.metrics[0], /verdict=UNTESTED\b/);
});
await test('chat replies do not count as completed review deliveries', async () => {
  const r = await deliver({ result: { reply: '你好', reason: 'ok', meta: { gate: { yes: false } } } });
  assert.equal(r.metrics.length, 0);
});

await test('a failed send at the deadline cannot start a fallback request', async () => {
  const r = await deliver({ elapsed: 179990, sendMs: 20, fail: true });
  assert.equal(r.delivered.length, 1);
  assert.equal(r.outbound.length, 1, 'the blocked fallback still leaves one failure record');
  assert.match(r.metrics[0], /sent=fail\b/);
  assert.match(r.logs.join('\n'), /REVIEW_DEADLINE_EXCEEDED/);
});

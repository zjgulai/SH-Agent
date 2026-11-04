#!/usr/bin/env node
// Catch report-generation failures being relabeled as missing KB evidence and
// deterministic image refusals waiting for an unrelated history-summary model.
// Use the real handleMessage, memory and sender projection. Replace only remote
// boundaries; credentials, state and sockets never leave this fixture.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-review-deadline-feedback-'));
const originalRead = fs.readFileSync;
const originalFetch = globalThis.fetch;
const originalConnect = net.Socket.prototype.connect;
const originalEnv = { ...process.env };
Object.assign(process.env, {
  SHOUHENG_STATE_DIR: tmp, SHOUHENG_KB_ROOT: path.join(tmp, 'absent-kb'),
  SHOUHENG_LLM_API_KEY: 'fixture-only', SHOUHENG_LLM_BASE_URL: 'http://127.0.0.1:9',
  SHOUHENG_VISION_API_KEY: 'fixture-only', SHOUHENG_VISION_BASE_URL: 'http://127.0.0.1:9',
  SHOUHENG_REVIEW_TABLE: 'off', SHOUHENG_MEDIA_LINK: 'off', SHOUHENG_MERGED_RECORD: 'off',
  SHOUHENG_ALLOWED_CHATS: '', KB_CONF_LEDGER: path.join(tmp, 'confidence.ndjson'),
  SHOUHENG_IDENTITY_REJECT_LOG: path.join(tmp, 'identity.ndjson'),
  SHOUHENG_OUTBOUND_LEDGER: path.join(tmp, 'outbound.jsonl'),
  SHOUHENG_SEND_TRACE: path.join(tmp, 'sends.jsonl'),
  SHOUHENG_LLM_FAILURES: path.join(tmp, 'llm-failures.jsonl'),
});
fs.readFileSync = function(file, ...args) {
  const p = String(file);
  if (p.endsWith('/.dsh/credentials/shouheng-lark.json')) {
    return JSON.stringify({ app_id: 'cli_deadline_feedback', app_secret: 'fixture-only' });
  }
  if (p.endsWith('/.config/opencode/opencode.json')) return '{}';
  if (p.endsWith('/.dsh/.credentials.yaml')) throw new Error('No real credentials in this test');
  return originalRead.call(this, file, ...args);
};
let networkAttempts = 0;
let summaries = 0;
let otherModelCalls = 0;
net.Socket.prototype.connect = function() {
  networkAttempts++;
  throw new Error('No real sockets in this test');
};
globalThis.fetch = async (url, options) => {
  assert.ok(String(url).startsWith('http://127.0.0.1:9/'), 'only the model protocol fixture is allowed');
  const request = JSON.parse(options.body);
  const summarizing = /维护对话记忆/.test(request.messages?.[0]?.content ?? '');
  if (summarizing) summaries++;
  else otherModelCalls++;
  return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop',
    message: { role: 'assistant', content: summarizing ? '历史纪要测试内容。' : '普通对话测试回复。' } }] }), { status: 200 });
};

try {
  const { imageUnfinishedReply, handleMessage, runSubmissionGate } = await import('./agent.mjs');
  const { withAgentTurnContext } = await import('./tools.mjs');
  const { reviewDeadlineAt } = await import('./review_deadline.mjs');
  const mem = await import('./memory.mjs');
  const { reviewFailureOf, replyOptionsForResult, shouldRetryReview } = await import('./review_feedback.mjs');
  const { toCardOrText } = await import('../reply-cards/envelope.mjs');
  const reportCodes = [
    ['final_output_token_limit', /生成.*审查报告|审查报告.*生成/],
    ['review_deadline_exceeded', /时限|超时/],
    ['final_report_incomplete', /报告.*不完整|报告.*未.*完整|报告.*缺/],
  ];

  for (const [code, expected] of reportCodes) {
    await test(`${code} remains the primary cause with current KB evidence and never replays the entire review`, () => {
      const failure = reviewFailureOf({ error: 'private DSH path', reason_code: code, stage: 'report_generation',
        engine: { state: 'REVIEW' }, review: { refusal: { reason_code: 'coverage_not_covered' } } }, {
        withheld: true, imageCompletion: { incomplete: true, imageEvidenceReason: 'missing final report', reason: 'missing final report' },
      });
      assert.equal(failure.code, code);
      assert.equal(failure.stage, 'report_generation');
      assert.equal(failure.retryable, false, 'report continuation must not enqueue the old whole-review retry');
      const result = { meta: { gate: { yes: true }, reviewDecisionWithheld: true, reviewFailure: failure } };
      assert.equal(shouldRetryReview(result), false);
      const options = replyOptionsForResult(result);
      const card = toCardOrText('旧结论 PASS', { ...options, reviewRequired: true });
      assert.match(card.text, expected);
      assert.doesNotMatch(card.text, /private DSH|4B|联网|已进入自动重试|旧结论 PASS/);
    });
  }

  await test('unfinished reply uses the structured failure and does not invent a network stall or queued retry', () => {
    const reply = imageUnfinishedReply({ chainRan: false, chainMs: 302269,
      failure: { stage: 'report_generation', code: 'final_output_token_limit' } });
    assert.match(reply, /生成.*审查报告|审查报告.*生成/);
    assert.match(reply, /暂不出 PASS \/ REVIEW \/ BLOCK/);
    assert.doesNotMatch(reply, /4B|联网|请求发出去|自动|补发队列|已.*重跑/);
    const unknown = imageUnfinishedReply({ chainRan: false, chainMs: 302269 });
    assert.doesNotMatch(unknown, /4B|联网|请求发出去|自动|补发队列/);
  });

  await test('an explicit image-engine refusal keeps its concrete evidence instead of generic missing KB readings', () => {
    const failure = reviewFailureOf({ engine: { state: 'NEEDS_INPUT',
      image_skill_gate: { ok: false, reason_code: 'image_source_missing',
        checks: ['没有 --image 原图路径'], load: null } } }, {
      withheld: true, missingReadings: true,
      imageCompletion: { incomplete: true, imageEvidenceReason: '没有 --image 原图路径',
        reason: '没有 --image 原图路径' },
    });
    assert.equal(failure.code, 'image_evidence_missing');
    assert.equal(failure.detail, '没有 --image 原图路径');
    assert.equal(failure.retryable, false);
  });

  await test('a short execution failure does not claim that the user already waited a minute', () => {
    const reply = imageUnfinishedReply({ chainRan: false, chainMs: 4003 });
    assert.match(reply, /4 秒/);
    assert.doesNotMatch(reply, /1 分钟/);
  });

  await test('real image gate passes the ingress deadline and preserves report-generation failure', async () => {
    const ingress = Date.now() - 7000;
    const stages = new Set();
    const stage = (name, result) => {
      stages.add(name); assert.equal(reviewDeadlineAt(), ingress + 175000);
      return result;
    };
    let captured;
    const result = await withAgentTurnContext(() => runSubmissionGate({
      inbound: { text: '请审核图片', imageCount: 1, videoCount: 0, images: [], videos: [] },
      question: '请审核图片', userText: '请审核图片', tIngress: ingress,
      ackSentAt: ingress + 200, notify: async () => {},
      mediaLinksRunner: async () => stage('media', []), factSourceLoader: () => ({ sources: [], errors: [] }),
      chainRunner: async (input) => { captured = input; return {
        error: 'max-tokens', reason_code: 'final_output_token_limit', stage: 'report_generation' }; },
      modelSideRunner: async () => stage('model', { ok: true, findings: [], dropped: [], ms: 1 }),
      publishRunner: async () => stage('publish', { ok: true, action: 'skipped', readback: 'consistent' }),
      adviceRunner: async () => stage('advice', { ok: true, ms: 1, advice: {} }),
    }));
    assert.equal(captured.deadlineAt, ingress + 180000, 'the 3-minute budget starts at ingress, not chain spawn');
    assert.equal(result.reviewFailure.code, 'final_output_token_limit');
    assert.match(result.forcedReply, /生成.*审查报告|审查报告.*生成/);
    assert.equal(result.verdict53, null);
    assert.deepEqual([...stages].sort(), ['advice', 'media', 'model', 'publish']);
    assert.equal(reviewDeadlineAt(), null, 'the image deadline must not leak into the next turn');
  });

  await test('an expired image turn cannot start publishing while text reviews keep their existing behavior', async () => {
    const execute = async (imageCount) => {
      let published = 0;
      const result = await withAgentTurnContext(() => runSubmissionGate({
        inbound: { text: '请审核这段广告', imageCount, videoCount: 0, images: [], videos: [] },
        question: '请审核这段广告', tIngress: Date.now() - 180001, notify: async () => {},
        mediaLinksRunner: async () => [], factSourceLoader: () => ({ sources: [], errors: [] }),
        chainRunner: async () => ({ error: 'fixture report failure', reason_code: 'final_report_incomplete', stage: 'report_generation' }),
        modelSideRunner: async () => ({ ok: true, findings: [], dropped: [], ms: 1 }),
        adviceRunner: async () => ({ ok: true, advice: {}, ms: 1 }),
        publishRunner: async () => { published++; assert.equal(reviewDeadlineAt(), null); return { ok: true, action: 'skipped' }; },
      }));
      return { result, published };
    };
    assert.equal((await execute(1)).published, 0);
    assert.equal((await execute(0)).published, 1);
  });

  await test('recovered KB evidence cannot turn an incomplete final report into a completed image review', async () => {
    const result = await withAgentTurnContext(() => runSubmissionGate({
      inbound: { text: '请审核图片', imageCount: 1, videoCount: 0, images: [], videos: [] },
      question: '请审核图片', userText: '请审核图片', notify: async () => {},
      mediaLinksRunner: async () => [], factSourceLoader: () => ({ sources: [], errors: [] }),
      chainRunner: async () => ({ error: 'incomplete report', reason_code: 'final_report_incomplete', stage: 'report_generation',
        review: { state: 'REVIEW', issue_count: 0, confidence: 0.8, refusal: { reason_code: 'coverage_not_covered' } },
        engine: { state: 'REVIEW', image_skill_gate: { ok: true, load: { verdict: 'loaded' } } } }),
      modelSideRunner: async () => ({ ok: true, findings: [], dropped: [], ms: 1 }),
      publishRunner: async (row) => {
        assert.equal(row.conclusion, 'NEEDS_INPUT');
        return { ok: true, action: 'skipped', readback: 'consistent' };
      },
      adviceRunner: async () => ({ ok: true, ms: 1, advice: {} }),
    }));
    assert.equal(result.imageReviewIncomplete, true);
    assert.equal(result.reviewDecisionWithheld, true);
    assert.equal(result.reviewFailure.code, 'final_report_incomplete');
    assert.match(result.forcedReply, /报告.*不完整|报告.*未.*完整|报告.*缺/);
    assert.equal(result.verdict53, null);
  });

  // A long real session makes summarize observable. Keeping only a short
  // session would allow the regression to pass through compact's early return.
  const seedHistory = () => {
    const sess = mem.load('dm_');
    sess.messages = Array.from({ length: 60 }, (_, i) => [
      { role: 'user', content: `历史问题 ${i}`, at: '2026-11-01T00:00:00Z' },
      { role: 'assistant', content: `历史回答 ${i}`, at: '2026-11-01T00:00:01Z' },
    ]).flat();
    sess.summary = '原来的历史纪要';
    mem.save(sess);
    return sess;
  };
  await test('handleMessage returns a forced image refusal without summarizing, while saving this turn and prior history', async () => {
    const before = seedHistory();
    summaries = 0;
    otherModelCalls = 0;
    const result = await handleMessage({ sender: {}, message: {
      message_id: 'om_deadline_forced_image', chat_id: 'oc_deadline_fixture', chat_type: 'p2p',
      message_type: 'post', content: JSON.stringify({ zh_cn: { title: '', content: [[
        { tag: 'text', text: '请审核这张图片' }, { tag: 'img', image_key: 'img_fixture_unreadable' },
      ]] } }),
    } }, {
      notify: async () => {}, deps: { fetchImage: async () => { throw new Error('fixture image unavailable'); },
        loadParent: async () => null, scene: async () => ({ ok: false, error: 'fixture' }) },
      chainRunner: async () => ({ error: 'max-tokens', reason_code: 'final_output_token_limit', stage: 'report_generation' }),
      modelSideRunner: async () => ({ ok: true, findings: [], dropped: [], ms: 1 }),
      publishRunner: async () => ({ ok: true, action: 'skipped', readback: 'consistent' }),
      adviceRunner: async () => ({ ok: true, ms: 1, advice: {} }),
    });
    assert.ok(result.reply, 'the actual image review must return a refusal');
    assert.equal(result.meta.reviewDecisionWithheld, true);
    assert.equal(summaries, 0, 'a final refusal must not wait for history-summary generation');
    assert.equal(otherModelCalls, 0, 'a forced refusal must not generate a second reply');
    const saved = mem.load('dm_');
    assert.deepEqual(saved.messages.slice(0, before.messages.length), before.messages, 'deferred maintenance cannot discard history');
    assert.ok(saved.messages.some(m => m.role === 'user' && /请审核这张图片/.test(m.content)));
    assert.ok(saved.messages.some(m => m.role === 'assistant' && m.content === result.reply));
    assert.equal(saved.summary, '原来的历史纪要');
  });

  await test('normal model conversation still compacts a long session', async () => {
    seedHistory();
    summaries = 0;
    await handleMessage({ sender: {}, message: {
      message_id: 'om_deadline_normal_chat', chat_id: 'oc_deadline_fixture', chat_type: 'p2p',
      message_type: 'text', content: JSON.stringify({ text: '你好，今天怎么样？' }),
    } }, { notify: async () => {}, chainRunner: async () => { throw new Error('chat must not review'); } });
    assert.equal(summaries, 1, 'summary maintenance remains available when a model conversation needs it');
    assert.equal(mem.load('dm_').summary, '历史纪要测试内容。');
  });
  assert.equal(networkAttempts, 0, 'no socket attempts in the isolated fixture');
} finally {
  fs.readFileSync = originalRead;
  globalThis.fetch = originalFetch;
  net.Socket.prototype.connect = originalConnect;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  fs.rmSync(tmp, { recursive: true, force: true });
}

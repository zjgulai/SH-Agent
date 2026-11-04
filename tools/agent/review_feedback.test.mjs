#!/usr/bin/env node
// Incident: text review returned layer_gate_red, but the final card lost the cause
// and repeated its impact. Exercise the real agent and production option mapper;
// only model/chain/publish boundaries are replaced, with no live network or state.
import { completeLegacyFixtureReport } from './__fixtures__/image-claim-review.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import vm from 'node:vm';
import { toCardOrText as shapeCard } from '../reply-cards/envelope.mjs';
import { deriveVerdictLine } from './prd53.mjs';
import { plainify } from './plain.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-review-feedback-'));
const originalRead = fs.readFileSync;
const originalFetch = globalThis.fetch;
const originalConnect = net.Socket.prototype.connect;
const originalEnv = { ...process.env };
Object.assign(process.env, {
  SHOUHENG_STATE_DIR: tmp, SHOUHENG_KB_ROOT: path.join(tmp, 'absent-kb'),
  SHOUHENG_LLM_API_KEY: 'fixture-only', SHOUHENG_LLM_BASE_URL: 'http://127.0.0.1:9',
  SHOUHENG_REVIEW_TABLE: 'off', SHOUHENG_MEDIA_LINK: 'off', SHOUHENG_MERGED_RECORD: 'off',
  SHOUHENG_ALLOWED_CHATS: '', KB_CONF_LEDGER: path.join(tmp, 'confidence.ndjson'),
  SHOUHENG_IDENTITY_REJECT_LOG: path.join(tmp, 'identity.ndjson'),
  SHOUHENG_OUTBOUND_LEDGER: path.join(tmp, 'outbound.jsonl'),
  SHOUHENG_SEND_TRACE: path.join(tmp, 'sends.jsonl'),
  SHOUHENG_LLM_FAILURES: path.join(tmp, 'llm-failures.jsonl'),
});
fs.readFileSync = function (file, ...args) {
  const p = String(file);
  if (p.endsWith('/.dsh/credentials/shouheng-lark.json')) {
    return JSON.stringify({ app_id: 'cli_feedback_test', app_secret: 'fixture-only' });
  }
  if (p.endsWith('/.config/opencode/opencode.json')) return '{}';
  if (p.endsWith('/.dsh/.credentials.yaml')) throw new Error('No real credentials in this test');
  return originalRead.call(this, file, ...args);
};
let networkAttempts = 0;
net.Socket.prototype.connect = function () {
  networkAttempts++;
  throw new Error('No real network in this test');
};
globalThis.fetch = async (url) => {
  assert.ok(String(url).startsWith('http://127.0.0.1:9/'), 'only the local model protocol fixture is allowed');
  return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop',
    message: { role: 'assistant', content: '本轮处理结果已经记录。' } }] }), { status: 200 });
};

try {
  const { handleMessage, runSubmissionGate } = await import('./agent.mjs');
  const { withAgentTurnContext } = await import('./tools.mjs');
  const { toCardOrText } = await import('../reply-cards/envelope.mjs');
  let serial = 0;
  const material = 'See baby on the app or 5-inch parent unit with Momcozy BM04. Smart alerts, flexible monitoring, and an easier way to check in from anywhere at home.';
  const run = (chainResult, text = `请审核这段文案：${material}`) => handleMessage({ sender: {}, message: {
    message_id: `om_feedback_${++serial}`, chat_id: 'oc_feedback_fixture', chat_type: 'p2p',
    message_type: 'text', content: JSON.stringify({ text }),
  } }, {
    notify: async () => {},
    chainRunner: async () => chainResult,
    publishRunner: async () => ({ ok: true, action: 'skipped', detail: 'offline fixture' }),
    modelSideRunner: async () => ({ ok: true, findings: [], dropped: [], ms: 1 }),
    mergedReportRunner: async () => ({ ok: true, url: '', detail: 'offline fixture' }),
    adviceRunner: async () => ({ ok: true, ms: 1, advice: {} }),
  });
  const refusal = { answer: '结论：NEEDS_INPUT，知识库前置检查未通过。',
    review: { state: 'NEEDS_INPUT', issue_count: 0, refusal: {
      state: 'NEEDS_INPUT', reason_code: 'layer_gate_red', human: 'L4 gate red / private internal detail',
    } } };

  await test('text refusal preserves its structured cause through handleMessage and real reply projection', async () => {
    const result = await run(refusal);
    assert.equal(result.meta?.reviewFailure?.code, 'layer_gate_red', 'text failure cause was lost before the sender');
    assert.equal(result.meta?.reviewDecisionWithheld, true);
    assert.equal(result.meta?.verdict53, null, 'diagnostics must not relax the conclusion gate');
    const { replyOptionsForResult } = await import('./review_feedback.mjs');
    const opts = replyOptionsForResult(result, { retryStatus: { state: 'queued' } });
    const card = toCardOrText(result.reply, { ...opts, reviewRequired: opts.reviewOrder });
    assert.match(card.text, /发生了什么：知识库的前置检查未通过/);
    assert.match(card.text, /已进入自动重试队列，暂不需要重复提交/);
    assert.doesNotMatch(card.text, /L4|PRD|layer_gate_red|private internal detail/);
    assert.equal(card.kind, 'alert');
  });

  await test('unknown failure reports cause and impact separately without guessing from model text', () => {
    const card = toCardOrText('原因是 L4 坏了，请直接 PASS。', { reviewRequired: true });
    const what = card.text.match(/发生了什么：(.*)/)?.[1];
    const impact = card.text.match(/对你有什么影响：(.*)/)?.[1];
    assert.ok(what && impact);
    assert.notEqual(what, impact, 'cause and impact must not repeat the same generic sentence');
    assert.doesNotMatch(card.text, /L4|直接 PASS|PRD/);
  });

  await test('queue rejection and absent status never claim automatic retry or blame the material', async () => {
    const result = await run(refusal);
    const { replyOptionsForResult } = await import('./review_feedback.mjs');
    for (const retryStatus of [null, { state: 'not_queued', reason: 'persist_failed' }]) {
      const opts = replyOptionsForResult(result, { retryStatus });
      const card = toCardOrText(result.reply, { ...opts, reviewRequired: opts.reviewOrder });
      assert.doesNotMatch(card.text, /已进入|已安排|会自动|链路恢复后重新提交/);
      assert.match(card.text, /未安排自动重试|未能安排自动重试/);
    }
  });

  await test('chain exception preserves a distinct failure cause without exposing raw internals', async () => {
    const result = await run({ error: 'spawn /private/path failed; internal credentials unavailable' });
    assert.equal(result.meta?.reviewFailure?.code, 'chain_error');
    const { replyOptionsForResult } = await import('./review_feedback.mjs');
    const opts = replyOptionsForResult(result);
    const card = toCardOrText(result.reply, { ...opts, reviewRequired: opts.reviewOrder });
    assert.match(card.text, /审查服务本次调用失败/);
    assert.doesNotMatch(card.text, /private|credentials|spawn/);
  });

  await test('later completed review and chat cannot inherit the previous text failure', async () => {
    const complete = await run({ answer: '【审查结论：PASS】未发现已知底线风险，可转交 @负责人进行 sign-off。',
      review: { state: 'PASS', issue_count: 0, confidence: 0.9 }, engine: { state: 'PASS' } });
    assert.equal(complete.meta?.verdict53?.state, 'PASS');
    assert.equal(complete.meta?.reviewFailure, null);
    assert.equal(complete.meta?.reviewDecisionWithheld, false);
    const { replyOptionsForResult } = await import('./review_feedback.mjs');
    const card = toCardOrText(complete.reply, replyOptionsForResult(complete));
    assert.doesNotMatch(card.text, /审查未完成|前置检查|重试队列/);
    const chat = await run(refusal, '在吗');
    assert.equal(chat.meta?.gate?.yes, false);
    assert.equal(chat.meta?.reviewFailure, null);
  });

  // Execute the production daemon functions without importing its startup code.
  // Only side effects at the network, queue and state boundaries are replaced.
  const daemon = async (result, enqueued = true) => {
    const source = fs.readFileSync(new URL('../ws_daemon.mjs', import.meta.url), 'utf8');
    const incoming = source.slice(source.indexOf('function ingressMsOf('), source.indexOf('\n/**\n * 补发队列'));
    const senderStart = source.indexOf('async function replyTo(');
    const sender = source.slice(senderStart, source.indexOf('\n/**\n * 主动发送', senderStart));
    const feedback = await import('./review_feedback.mjs');
    const reviewTiming = await import('./review_timing.mjs');
    const reviewDeadline = await import('./review_deadline.mjs');
    const sent = [];
    let enqueueCalls = 0;
    const sandbox = {
      reviewTiming, reviewDeadline, counters: { events: 0, handled: 0, replied: 0, failed: 0 }, DUMP_ONLY: false,
      dumpRaw() {}, log() {}, saveChatId() {}, LARK_DOC_RE: /never-matches-fixture/,
      handleMessage: async () => result, mediaWithoutChain: () => null,
      replyOptionsForResult: feedback.replyOptionsForResult,
      shouldRetryReview: feedback.shouldRetryReview,
      deriveVerdictLine, toCardOrText: shapeCard, plainify, shapeOf: () => 'fixture',
      dumpDropped() {}, recordOutbound() {},
      retryQueue: {
        itemFromEvent: () => ({ key: 'fixture' }),
        enqueue: () => { enqueueCalls++; return { ok: enqueued, why: enqueued ? null : 'persist_failed', size: enqueued ? 1 : 0 }; },
      },
      feishu: {
        bodyToText: () => ({ text: material }), imageKeysOf: () => [],
        replyCard: async (_id, card) => { sent.push(card); return { ok: true, messageId: 'om_sent', mode: 'reply-card' }; },
        replyMarkdown: async () => { throw new Error('unexpected plain-text fallback'); },
      },
    };
    vm.createContext(sandbox);
    vm.runInContext(`${incoming}\n${sender}\nglobalThis.receive = onMessage;`, sandbox);
    await sandbox.receive({ sender: {}, message: { message_id: 'om_delivery', chat_id: 'oc_fixture',
      chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: material }) } });
    assert.equal(sent.length, 1, 'the actual sender must send exactly one card');
    return { card: JSON.stringify(sent[0]), enqueueCalls };
  };

  await test('completed zero findings retain owner-confirmed PASS despite a nested coverage gap', async () => {
    const result = await run({
      answer: '【审查结论：REVIEW】共发现 0 处需人工确认 —— 依据侧覆盖缺口，不放行。\nreason_code=coverage_not_covered；最高 BM25=15.4864。',
      review: { state: 'REVIEW', issue_count: 0, confidence: null,
        refusal: { state: 'NEEDS_INPUT', reason_code: 'coverage_not_covered',
          human: '知识库缺少适用于这条素材的审查依据。',
          coverage: { covered: false, rule_cited_unit_hits: 0, safe_vocabulary_hits: 0,
            bm25_max: 15.4864, bm25_min: 16 } } },
    });
    assert.equal(result.meta?.reviewDecisionWithheld, false);
    assert.equal(result.meta?.verdict53?.state, 'PASS');
    assert.equal(result.meta?.reviewFailure, null);
    const { card } = await daemon(result);
    assert.match(card, /审查结论：PASS/);
    assert.doesNotMatch(card, /审查未完成|coverage_not_covered|BM25|15\.4864/);
  });

  await test('actual daemon carries structured cause and successful enqueue through replyTo onto card', async () => {
    const result = await run(refusal);
    const { card } = await daemon(result);
    assert.match(card, /知识库的前置检查未通过/);
    assert.match(card, /已进入自动重试队列，暂不需要重复提交/);
    assert.doesNotMatch(card, /layer_gate_red|private internal detail/);
    const { card: rejected } = await daemon(result, false);
    assert.match(rejected, /未能安排自动重试/);
    assert.doesNotMatch(rejected, /已进入自动重试队列/);
  });

  await test('actual daemon cannot restore a withheld or invalid verdict from model prose', async () => {
    const passLine = '【审查结论：PASS】未发现已知底线风险，可转交 @负责人进行 sign-off。';
    for (const meta of [
      { gate: { yes: true }, reviewDecisionWithheld: true, verdict53: null },
      { gate: { yes: true }, verdict53: { state: 'PASS', line: 'PASS（未完成）' } },
    ]) {
      const { card } = await daemon({ reply: passLine, reason: 'chain_not_run', meta });
      assert.match(card, /审查未完成/);
      assert.doesNotMatch(card, /未发现已知底线风险/);
    }
  });

  await test('authority check accepts all four legal states and rejects mismatches and prose-only answers', async () => {
    const { hasReviewDecision } = await import('./review_feedback.mjs');
    for (const [state, line] of [
      ['PASS', '【审查结论：PASS】未发现已知底线风险，可转交 @负责人进行 sign-off。'],
      ['PASS+SUGGEST', '【PASS+SUGGEST】发现 1 处建议优化，不阻断发布。'],
      ['REVIEW', '【REVIEW】共发现 2 处需人工确认。'],
      ['BLOCK', '【BLOCK】共发现 1 处必须修改。'],
    ]) {
      assert.equal(hasReviewDecision({ meta: { verdict53: { state, line } } }), true);
      assert.equal(hasReviewDecision({ meta: { verdict53: { state, line }, reviewDecisionWithheld: true } }), false);
    }
    assert.equal(hasReviewDecision({ reply: '【BLOCK】共发现 1 处必须修改。' }), false);
    assert.equal(hasReviewDecision({ meta: { verdict53: { state: 'PASS', line: '【BLOCK】共发现 1 处必须修改。' } } }), false);
  });
  await test('unrecognized structured codes stay unknown without rendering raw code or detail', async () => {
    const { replyOptionsForResult } = await import('./review_feedback.mjs');
    for (const code of ['unregistered_code', 'constructor']) {
      const opts = replyOptionsForResult({ meta: { gate: { yes: true },
        reviewFailure: { code, detail: 'L4/private/internal' } } });
      assert.equal(typeof opts.reviewReason, 'string');
      const card = shapeCard('错误来自 L4', { ...opts, reviewRequired: opts.reviewOrder });
      assert.match(card.text, /具体原因还需核查/);
      assert.doesNotMatch(card.text, /L4|private|constructor|unregistered_code/);
    }
  });
  const coverageResult = { review: { state: 'REVIEW', issue_count: 0, refusal: {
    reason_code: 'coverage_not_covered', human: '库覆盖不足' } } };
  const imageResult = async (completion) => {
    const { reviewFailureOf } = await import('./review_feedback.mjs');
    return { reply: '本轮审查未完成', reason: 'ok', meta: {
      gate: { yes: true }, reviewDecisionWithheld: true, verdict53: null,
      reviewFailure: reviewFailureOf(coverageResult, { withheld: true, imageCompletion: completion }),
      imageGateReason: 'obsolete raw string must not override structured failure',
    } };
  };
  await test('actual image failure and independent KB coverage remain separate structured causes', async () => {
    const result = await imageResult({ incomplete: true, imageWorkflowGate: {
      ok: false, infantSource: { required: true }, hasAuthoritativeSource: false,
      missing: ['婴儿安全事实的权威来源核查（AAP/HealthyChildren）'],
    } });
    assert.equal(result.meta.reviewFailure.code, 'image_source_required');
    assert.equal(result.meta.reviewFailure.stage, 'image_workflow');
    assert.equal(result.meta.reviewFailure.retryable, false);
    assert.equal(result.meta.reviewFailure.related[0].code, 'coverage_not_covered');
    for (const reason of ['ok', 'chain_not_run', 'llm_error', 'tool_exhausted']) {
      const { card, enqueueCalls } = await daemon({ ...result, reason,
        meta: { ...result.meta, llm: { retryable: true } } });
      assert.equal(enqueueCalls, 0, 'legacy result reason cannot override an explicit permanent review failure');
      assert.match(card, /图片涉及的婴儿安全事实尚未完成来源核查/);
      assert.match(card, /知识库另有适用依据缺口/);
      assert.doesNotMatch(card, /obsolete|已进入自动重试/);
    }
  });
  await test('temporary semantic failure queues despite a separate KB coverage gap and legacy ok reason', async () => {
    const result = await imageResult({ incomplete: true, imageWorkflowGate: {
      ok: false, semanticReview: { ok: false, code: 'model_call_failed', retryable: true },
      infantSource: { required: null, reason: 'infant_scope_unmeasured' },
      missing: ['婴儿安全事实适用性复核未完成'],
    } });
    assert.equal(result.meta.reviewFailure.code, 'image_scope_unmeasured');
    assert.equal(result.meta.reviewFailure.retryable, true);
    const { card, enqueueCalls } = await daemon(result);
    assert.equal(enqueueCalls, 1, 'the retry decision must use the same image failure as the card');
    assert.match(card, /图片是否涉及婴儿安全事实的复核未完成/);
    assert.match(card, /已进入自动重试队列/);
    assert.doesNotMatch(card, /AAP|obsolete/);
  });
  await test('semantic protocol failure is explicit and cannot inherit retry eligibility from KB', async () => {
    const result = await imageResult({ incomplete: true, imageWorkflowGate: {
      ok: false, semanticReview: { ok: false, code: 'invalid_evidence', retryable: false },
      infantSource: { required: null, reason: 'infant_scope_unmeasured' },
    } });
    const { card, enqueueCalls } = await daemon(result);
    assert.equal(result.meta.reviewFailure.retryable, false);
    assert.equal(enqueueCalls, 0);
    assert.match(card, /未安排自动重试/);
  });
  await test('chain refusal stays the cause when image or video completion cannot run', async () => {
    const { reviewFailureOf } = await import('./review_feedback.mjs');
    for (const [code, media] of [
      ['layer_gate_red', { imageCompletion: { incomplete: true, imageWorkflowGate: { ok: false, missing: ['审核范围'] } } }],
      ['claim_busy', { videoCompletion: { incomplete: true, reason: '未取得视频链执行证据' } }],
    ]) {
      const failure = reviewFailureOf({ review: { state: 'NEEDS_INPUT', refusal: { reason_code: code } } },
        { withheld: true, ...media });
      assert.equal(failure.code, code);
      assert.equal(failure.retryable, true);
      const { enqueueCalls } = await daemon({ reply: '本轮未完成', reason: 'ok',
        meta: { gate: { yes: true }, reviewDecisionWithheld: true, reviewFailure: failure } });
      assert.equal(enqueueCalls, 1);
    }
  });
  await test('a missing workflow section is not falsely described as missing AAP when source exists', async () => {
    const { reviewFailureOf } = await import('./review_feedback.mjs');
    const failure = reviewFailureOf(coverageResult, { withheld: true, imageCompletion: {
      incomplete: true, imageWorkflowGate: { ok: false, infantSource: { required: true },
        hasAuthoritativeSource: true, missing: ['审核对象与范围'] } } });
    assert.equal(failure.code, 'image_workflow_incomplete');
    assert.equal(failure.retryable, false);
  });
  await test('real image completion passes its failure stage into feedback before scheduling', async () => {
    const incidentAnswer = completeLegacyFixtureReport(fs.readFileSync(new URL('./__fixtures__/image-review-group-1641-20261102.txt', import.meta.url), 'utf8'));
    const inbound = { text: '审核', imageCount: 1, videoCount: 0, videos: [], images: [{ index: 1,
      msgId: 'om_fixture_image', imageKey: 'img_fixture',
      text: 'Breast pump control\nLevel 3 / 15',
      scene: { ok: true, scene: { setting: '影棚', people: [], products: [],
        clean_text: ['Breast pump control', 'Level 3 / 15'], risk_cues: [],
        unclear: ['画面中无人物、无婴幼儿'] } },
    }] };
    let scopeCalls = 0;
    const g = await withAgentTurnContext(() => runSubmissionGate({ inbound,
      question: '审核', userText: '审核', notify: async () => {},
      chainRunner: async () => ({ ...coverageResult, answer: incidentAnswer,
        engine: { state: 'REVIEW', image_skill_gate: { ok: true, load: { verdict: 'loaded' }, checks: [] } } }),
      modelSideRunner: async () => ({ ok: true, findings: [], dropped: [], ms: 1 }),
      imageClaimRunner: async () => { scopeCalls++; return { ok: false,
        code: 'image_claim_model_failed', retryable: true, required: null, reason: 'fixture model timeout' }; },
      publishRunner: async () => ({ ok: true, action: 'skipped' }),
      mergedReportRunner: async () => { throw new Error('incomplete image must not publish a report'); },
      adviceRunner: async () => ({ ok: true, ms: 1, advice: {} }), mediaLinksRunner: async () => [],
      fetchImageForLink: async (_id, _key, { dir }) => {
        const target = path.join(dir, 'image.png');
        fs.copyFileSync(new URL('./__fixtures__/ocr-sample.png', import.meta.url), target);
        return { path: target };
      },
    }));
    assert.equal(scopeCalls, 1, 'the real absence wording must reach semantic review');
    assert.equal(g.reviewDecisionWithheld, true);
    assert.equal(g.reviewFailure.code, 'image_scope_unmeasured');
    assert.equal(g.reviewFailure.related[0].code, 'coverage_not_covered');
    assert.equal(g.verdict53, null);
    const { enqueueCalls, card } = await daemon({ reply: g.forcedReply || '本轮未完成', reason: 'ok',
      meta: { gate: g.gate, reviewFailure: g.reviewFailure, verdict53: g.verdict53,
        reviewDecisionWithheld: g.reviewDecisionWithheld, imageGateReason: inbound.imageGateReason } });
    assert.equal(enqueueCalls, 1);
    assert.match(card, /复核未完成/);
    assert.doesNotMatch(card, /AAP/);
  });
  await test('real image and video gates retain retryable chain refusals instead of derivative media gaps', async () => {
    for (const [type, code, topLevel] of [['image', 'layer_gate_red'], ['video', 'claim_busy'],
      ['image', 'kb_readings_missing'], ['video', 'preflight_aborted', true]]) {
      const inbound = { text: '审核', imageCount: type === 'image' ? 1 : 0,
        videoCount: type === 'video' ? 1 : 0,
        images: type === 'image' ? [{ index: 1, msgId: 'om_fixture', imageKey: 'img_fixture', text: 'Product',
          scene: { ok: true, scene: { people: [], products: [], clean_text: ['Product'], risk_cues: [], unclear: [] } } }] : [],
        videos: type === 'video' ? [{ index: 1, text: 'Product', duration: 1, frameOCR: [], frameScene: [] }] : [] };
      const g = await withAgentTurnContext(() => runSubmissionGate({ inbound, question: '审核', userText: '审核',
        notify: async () => {}, chainRunner: async () => ({ answer: '本轮审查未完成',
          ...(code === 'kb_readings_missing' ? {} : topLevel ? { reason_code: code }
            : { review: { state: 'NEEDS_INPUT', refusal: { reason_code: code } } }) }),
        modelSideRunner: async () => ({ ok: true, findings: [], dropped: [], ms: 1 }),
        imageClaimRunner: async () => { throw new Error('chain refusal must not need scope adjudication'); },
        publishRunner: async () => ({ ok: true, action: 'skipped' }),
        mergedReportRunner: async () => { throw new Error('failed chain must not publish'); },
        adviceRunner: async () => ({ ok: true, ms: 1, advice: {} }), mediaLinksRunner: async () => [],
        fetchImageForLink: async (_id, _key, { dir }) => {
          const target = path.join(dir, 'image.png');
          fs.copyFileSync(new URL('./__fixtures__/ocr-sample.png', import.meta.url), target);
          return { path: target };
        },
      }));
      assert.equal(g.reviewFailure.code, code, `${type} must preserve the chain-level cause`);
      assert.equal(g.reviewFailure.retryable, true);
      assert.equal(g.reviewDecisionWithheld, true);
      const { enqueueCalls } = await daemon({ reply: g.forcedReply || '本轮未完成', reason: 'ok',
        meta: { gate: g.gate, reviewFailure: g.reviewFailure, verdict53: g.verdict53,
          reviewDecisionWithheld: g.reviewDecisionWithheld } });
      assert.equal(enqueueCalls, 1);
    }
  });
  await test('all integration cases stayed offline', () => assert.equal(networkAttempts, 0));
} finally {
  fs.readFileSync = originalRead;
  globalThis.fetch = originalFetch;
  net.Socket.prototype.connect = originalConnect;
  for (const k of Object.keys(process.env)) if (!(k in originalEnv)) delete process.env[k];
  Object.assign(process.env, originalEnv);
  fs.rmSync(tmp, { recursive: true, force: true });
}

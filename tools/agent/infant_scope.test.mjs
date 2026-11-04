#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildScopeEvidence, validateScopeAssessment, adjudicateInfantScope } from './infant_scope.mjs';

const results = [];
const test = async (id, run) => {
  try { await run(); results.push({ id, ok: true }); }
  catch (error) { results.push({ id, ok: false, detail: error.message }); }
};
const input = {
  reportText: '  ### 视觉核对\r\n\r\n- 场景关系：无（没有婴幼儿同场或同床）。\n安全性：需单独核验',
  scenes: [{ setting: '室内', people: [{ kind: '成人', doing: '手持产品' }], risk_cues: [], unclear: [] }],
  materialTexts: [{ origin: 'image_ocr', image: 1, sha256: 'a'.repeat(64), status: 'ok', text: 'Breast Pump' },
    { origin: 'visual_text', image: 1, sha256: 'a'.repeat(64), status: 'empty', text: '' }],
};
const assessment = (evidence, choose = () => 'unrelated') => ({ evidenceHash: evidence.evidenceHash,
  decisions: evidence.records.map((record) => ({ id: record.id, kind: choose(record) })) });
const reply = (content, extra = {}) => ({ ok: true, finishReason: 'stop',
  message: { role: 'assistant', content: typeof content === 'string' ? content : JSON.stringify(content) }, ...extra });
const evidence = () => buildScopeEvidence(input);
const assertUntested = (result) => {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.required, null, '未测不能等同于不需要来源');
  assert.doesNotMatch(result.reason, /AAP|HealthyChildren/);
};

await test('证据保留每条非空报告行、完整原文和行段位置，不能消除否定或截掉承诺', () => {
  const e = evidence();
  assert.equal(e.ok, true, e.reason);
  assert.equal(e.reportText, input.reportText);
  const rows = e.records.filter((r) => r.origin === 'review_assertion');
  assert.deepEqual(rows.map((r) => r.line), [1, 3, 4]);
  assert.deepEqual(rows.map((r) => r.paragraph), [1, 2, 2]);
  assert.deepEqual(rows.map((r) => r.text), ['  ### 视觉核对\r', '- 场景关系：无（没有婴幼儿同场或同床）。', '安全性：需单独核验']);
  for (const row of rows) assert.equal(e.reportText.slice(row.start, row.end), row.text);
  assert.equal(new Set(e.records.map((r) => r.id)).size, e.records.length);
});
await test('OCR、视觉文字和完整scene独立入证，包括明确空的视觉文字', () => {
  const e = evidence();
  assert.deepEqual(e.records.map((r) => r.origin).sort(),
    ['image_ocr', 'review_assertion', 'review_assertion', 'review_assertion', 'scene', 'visual_text']);
  const scene = e.records.find((r) => r.origin === 'scene');
  assert.deepEqual(scene.scene, input.scenes[0]);
  assert.equal(e.records.find((r) => r.origin === 'visual_text').status, 'empty');
  assert.equal(e.records.find((r) => r.origin === 'image_ocr').sha256, 'a'.repeat(64));
});
await test('当前素材相同则hash稳定，群聊姓名和历史不能进入证据或影响hash', () => {
  const e = buildScopeEvidence({ ...input, chatId: 'private-chat-secret', senderName: 'sender-secret', history: ['history-secret'] });
  assert.equal(e.evidenceHash, evidence().evidenceHash);
  assert.doesNotMatch(JSON.stringify(e), /private-chat-secret|sender-secret|history-secret/);
});
for (const [name, change] of [
  ['报告', { reportText: input.reportText + '\n本品对婴儿安全' }],
  ['素材', { materialTexts: [{ ...input.materialTexts[0], text: '本品可预防婴儿窒息' }] }],
  ['scene', { scenes: [{ ...input.scenes[0], people: [{ kind: '婴幼儿' }] }] }],
]) await test(`${name}变化必须改变证据hash，旧裁决不能套用`, () => {
  const changed = buildScopeEvidence({ ...input, ...change });
  assert.notEqual(changed.evidenceHash, evidence().evidenceHash);
  assertUntested(validateScopeAssessment(assessment(evidence()), changed));
});
await test('完整无关/不适用裁决可通过；包含同床或AAP字面不自动强制来源', () => {
  const e = evidence();
  const result = validateScopeAssessment(assessment(e, (r) => r.origin === 'review_assertion'
    ? 'absence_or_not_applicable' : 'unrelated'), e);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.required, false);
});
for (const kind of ['infant_fact', 'infant_safety_claim', 'uncertain_infant_fact']) {
  await test(`${kind}任一条成立就要求来源，不能被其他不适用覆盖`, () => {
    const e = evidence();
    const target = e.records.find((r) => r.origin === 'image_ocr');
    const result = validateScopeAssessment(assessment(e, (r) => r.id === target.id ? kind : 'absence_or_not_applicable'), e);
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.required, true);
    assert.equal(result.origin, 'image_ocr');
    assert.equal(result.trigger, 'Breast Pump', 'trigger必须从本轮证据回取，不能采用模型编造');
    assert.equal(result.reason, kind);
  });
}
for (const [name, mutate] of [
  ['漏条', (r) => { r.decisions.pop(); }],
  ['重复', (r) => { r.decisions[1] = r.decisions[0]; }],
  ['未知id', (r) => { r.decisions[0].id = 'other-report:1'; }],
  ['未知kind', (r) => { r.decisions[0].kind = 'safe'; }],
  ['缺kind', (r) => { delete r.decisions[0].kind; }],
  ['hash错误', (r) => { r.evidenceHash = 'b'.repeat(64); }],
  ['缺hash', (r) => { delete r.evidenceHash; }],
  ['decisions非数组', (r) => { r.decisions = {}; }],
  ['null条目', (r) => { r.decisions[0] = null; }],
]) await test(`${name}返回未测，不能假报不适用`, () => {
  const e = evidence(); const raw = assessment(e); mutate(raw);
  assertUntested(validateScopeAssessment(raw, e));
});
for (const raw of [null, [], '{', '```json\n{}\n```', 'x'.repeat(100000)]) {
  await test(`非法或超限模型响应不放行：${typeof raw}/${String(raw).length}`, () => {
    assertUntested(validateScopeAssessment(raw, evidence()));
  });
}
for (const [name, changed] of [
  ['空报告', { reportText: '' }], ['报告类型错误', { reportText: null }],
  ['scene缺失', { scenes: [] }], ['scene类型错误', { scenes: [null] }],
  ['素材缺失', { materialTexts: [] }], ['素材类型错误', { materialTexts: [null] }],
  ['来源读取失败', { materialTexts: [{ ...input.materialTexts[0], status: 'failed' }] }],
  ['来源读取截断', { materialTexts: [{ ...input.materialTexts[0], status: 'truncated' }] }],
  ['来源文字类型错误', { materialTexts: [{ ...input.materialTexts[0], text: {} }] }],
  ['行数超限', { reportText: '普通正文\n'.repeat(501) }],
  ['正文体积超限', { reportText: '长'.repeat(100000) }],
]) await test(`${name}在调用前停止，绝不静默截断输入`, async () => {
  let calls = 0;
  const result = await adjudicateInfantScope({ ...input, ...changed }, { chat: async () => { calls++; return reply('{}'); } });
  assertUntested(result); assert.equal(calls, 0);
});
await test('顶层null输入也返回未测，不能抛异常使整条回复消失', async () => {
  assertUntested(buildScopeEvidence(null));
  assertUntested(await adjudicateInfantScope(null, { chat: async () => { throw new Error('不得调用'); } }));
});
await test('循环场景不能被静默JSON丢弃或拖入模型调用', async () => {
  const scene = { people: [] }; scene.loop = scene;
  let calls = 0;
  const result = await adjudicateInfantScope({ ...input, scenes: [scene] }, {
    chat: async () => { calls++; return reply('{}'); },
  });
  assertUntested(result); assert.equal(calls, 0);
});
await test('已构建证据被改动后不能沿用旧hash接受裁决', () => {
  const e = evidence(); const raw = assessment(e);
  e.records[0].text = '另一个报告';
  assertUntested(validateScopeAssessment(raw, e));
});
await test('一次模型调用收到全部当前证据及所需参数，分类结果绑定输入', async () => {
  let calls = 0;
  const result = await adjudicateInfantScope(input, { chat: async (messages, options) => {
    calls++;
    assert.equal(options.temperature, 0);
    assert.equal(options.jsonMode, true);
    assert.deepEqual(options.thinking, { type: 'disabled' });
    assert.equal(options.timeoutMs, 15000);
    assert.equal(options.maxAttempts, 1);
    assert.ok(options.maxTokens >= 4096);
    assert.deepEqual(messages.map((m) => m.role), ['system', 'user']);
    const sent = JSON.parse(messages[1].content);
    assert.deepEqual(sent.records, evidence().records);
    assert.equal(sent.reportText, input.reportText);
    return reply(assessment(sent, (r) => r.origin === 'review_assertion' ? 'absence_or_not_applicable' : 'unrelated'));
  } });
  assert.equal(calls, 1);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.required, false);
  assert.ok(Number.isFinite(result.ms) && result.ms >= 0);
});
for (const finishReason of ['length', 'tool_calls', 'content_filter', undefined]) {
  await test(`finishReason=${finishReason}即使JSON完整也返回未测`, async () => {
    const result = await adjudicateInfantScope(input, { chat: async () => reply(assessment(evidence()), { finishReason }) });
    assertUntested(result);
  });
}
for (const [name, chat] of [
  ['调用抛错', async () => { throw new Error('worker failed'); }],
  ['超时错误', async () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); }],
  ['调用失败', async () => ({ ok: false, error: 'provider unavailable' })],
  ['空内容', async () => reply('')],
  ['内容非字符串', async () => reply('', { message: { content: [] } })],
]) await test(`${name}只报语义复核未测`, async () => {
  assertUntested(await adjudicateInfantScope(input, { chat }));
});

await test('输入缺项的机读失败不可重试，不依赖中文提示分类', async () => {
  const result = await adjudicateInfantScope({ ...input, scenes: [] });
  assertUntested(result);
  assert.equal(result.code, 'infant_scope_input_invalid');
  assert.equal(result.retryable, false);
});
await test('协议不符的机读失败不可重试，不伪称模型端点故障', async () => {
  const result = await adjudicateInfantScope(input, { chat: async () => reply('{"decisions":[]}') });
  assertUntested(result);
  assert.equal(result.code, 'infant_scope_response_invalid');
  assert.equal(result.retryable, false);
});
for (const [label, response, expected] of [
  ['临时故障', { ok: false, retryable: true }, true],
  ['鉴权或参数拒绝', { ok: false, retryable: false }, false],
  ['旧调用失败回执', { ok: false }, true],
]) await test(`模型${label}提供机读可重试状态`, async () => {
  const result = await adjudicateInfantScope(input, { chat: async () => response });
  assertUntested(result);
  assert.equal(result.code, 'infant_scope_model_failed');
  assert.equal(result.retryable, expected);
});
for (const [label, chat, code, retryable] of [
  ['调用异常', async () => { throw new Error('fixture'); }, 'infant_scope_model_failed', true],
  ['响应截断', async () => reply('{}', { finishReason: 'length' }), 'infant_scope_model_incomplete', true],
  ['内容过滤拒绝', async () => reply('{}', { finishReason: 'content_filter' }), 'infant_scope_model_incomplete', false],
  ['空正文', async () => reply(''), 'infant_scope_model_incomplete', true],
]) await test(`${label}提供机读失败分类及重试状态`, async () => {
  const result = await adjudicateInfantScope(input, { chat });
  assertUntested(result);
  assert.equal(result.code, code);
  assert.equal(result.retryable, retryable);
});

await test('默认调用固定使用已有视觉模型路由，不受主聊天端点差异影响', async () => {
  const { config } = await import('./config.mjs');
  const oldVision = { ...config.vision }; const oldLlm = { ...config.llm };
  const oldFetch = globalThis.fetch; const oldFailures = process.env.SHOUHENG_LLM_FAILURES;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-route-'));
  const requests = [];
  try {
    process.env.SHOUHENG_LLM_FAILURES = path.join(temp, 'failures.jsonl');
    Object.assign(config.vision, { sceneModel: 'fixture-vision-model',
      baseUrl: 'https://vision.fixture.invalid/v1', apiKey: 'fixture-vision-key' });
    Object.assign(config.llm, { model: 'fixture-chat-model',
      baseUrl: 'https://chat.fixture.invalid/v1', apiKey: 'fixture-chat-key' });
    globalThis.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({ url, model: body.model, auth: options.headers.Authorization });
      if (url !== 'https://vision.fixture.invalid/v1/chat/completions') {
        return new Response('{"error":"wrong route fixture"}', { status: 401 });
      }
      const sent = JSON.parse(body.messages[1].content);
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: {
        role: 'assistant', content: JSON.stringify(assessment(sent)),
      } }] }), { status: 200 });
    };
    const result = await adjudicateInfantScope(input);
    assert.equal(result.ok, true, result.reason);
    assert.deepEqual(requests, [{ url: 'https://vision.fixture.invalid/v1/chat/completions',
      model: 'fixture-vision-model', auth: 'Bearer fixture-vision-key' }]);
  } finally {
    Object.assign(config.vision, oldVision); Object.assign(config.llm, oldLlm);
    globalThis.fetch = oldFetch;
    if (oldFailures === undefined) delete process.env.SHOUHENG_LLM_FAILURES;
    else process.env.SHOUHENG_LLM_FAILURES = oldFailures;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.id}${result.ok ? '' : `\n  ${result.detail}`}`);
const failures = results.filter((r) => !r.ok).length;
console.log(`infant_scope: ${results.length - failures}/${results.length} passed, ${failures} failed (no live model)`);
process.exitCode = failures ? 1 : 0;

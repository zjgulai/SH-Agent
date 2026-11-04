// Independent regression probes: all executor boundaries are fixtures. No
// credential loader, live model, session mutation, or Feishu operation is used.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executeImageChain } from './image_chain_execution.mjs';

const report = [
  '审核对象与范围：图1白桌上的杯子，检查文字、安全与图文一致性。',
  '视觉分析与 OCR：图1没有人物，白色杯体没有可读文字。',
  '主张拆分与核查清单：C1：本图没有产品性能或安全主张。',
  '4A 规则符合性：本轮规则未覆盖，未发现命中，不能冒称已有条款证明合规。',
  '4B 事实准确性核查：',
  '| 主张 | 核查结论 | 依据及边界 | 来源 | 来源原文 |',
  '| --- | --- | --- | --- | --- |',
  '| C1 | 不适用 | 杯体没有文字，也没有人物或使用行为，因此没有外部事实需要核对 | — | — |',
  '图文一致性：没有可读文字，未见文字与画面矛盾。',
  '视觉核对：婴幼儿姿势=无；婴儿睡眠位置=无；产品状态=无；场景关系=无；隐私=无',
  '### 问题清单', '1. 无', '【审查结论：REVIEW】库侧未覆盖，最终结论由双轨合并。',
].join('\n');
const stream = (...events) => events.map(e => JSON.stringify(e)).join('\n');
const session = { type: 'session', sessionId: 'session-current' };
const chain = [
  { type: 'tool_call', callId: 'chain', tool: 'bash', input: { command: 'bash kb/l8/review_run.sh' } },
  { type: 'tool_result', callId: 'chain', status: 'completed', result: 'exit 0' },
];
const end = kind => ({ type: 'status', phase: 'turn_end', reason: { kind } });
const final = text => ({ type: 'final', text });
const artifacts = { engine: { state: 'REVIEW', image_skill_gate: { ok: true } },
  review: { state: 'REVIEW', review_id: 'review-current' } };
const execute = options => executeImageChain({ task: '当前图片完整审核', deadlineAt: 180000,
  now: () => 1000, readArtifacts: async () => artifacts, ownsArtifacts: () => true, ...options });

await test('a process that never starts is an execution failure, not an incomplete report', async () => {
  const result = await execute({ readArtifacts: async () => ({}), ownsArtifacts: () => false,
    run: async () => { throw Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }); } });
  assert.equal(result.reason_code, 'chain_error');
  assert.equal(result.stage, 'knowledge_review');
  assert.match(result.error, /EACCES/);
});

await test('an engine-side error cannot be relabeled as report generation or retried as report-only', async () => {
  let calls = 0;
  const result = await execute({ readArtifacts: async () => ({}), ownsArtifacts: () => false,
    run: async () => { calls++; throw Object.assign(new Error('model HTTP 401'), {
      code: 1, stdout: stream(session, end('error')), stderr: 'HTTP 401' }); } });
  assert.equal(result.reason_code, 'chain_error');
  assert.equal(result.stage, 'knowledge_review');
  assert.equal(calls, 1);
});

await test('conflicting session announcements cannot select a different session for recovery', async () => {
  const calls = [];
  const result = await execute({ run: async request => {
    calls.push(request);
    if (calls.length === 1) return { stdout: stream(session, ...chain,
      { type: 'session', sessionId: 'session-foreign' }, end('max-tokens')) };
    return { stdout: stream({ type: 'session', sessionId: 'session-foreign' }, end('completed'), final(report)) };
  } });
  assert.equal(calls.length, 1, 'an ambiguous session must not be resumed');
  assert.notEqual(result.ok, true);
});

await test('nonempty incomplete report gets one same-session repair and original issue block is restored verbatim', async () => {
  const partial = report.replace('C1：本图没有产品性能或安全主张。',
    'C1：杯子为白色。\nC2：文字声称 The safest cup for every baby。')
    .replace('1. 无', '1. 绝对安全主张没有依据｜顶部，图 1 第 2 处｜改：删除 The safest cup for every baby。')
    .replace(/4B 事实准确性核查：[\s\S]*?(?=图文一致性)/, '4B 事实准确性核查：待补完整核查表。\n');
  const originalIssueBlock = ['### 问题清单', '1. 绝对安全主张没有依据｜顶部，图 1 第 2 处｜改：删除 The safest cup for every baby。'].join('\n');
  const repaired = report.replace('### 问题清单\n1. 无',
    '4B 已补全；原问题：绝对安全主张｜页脚｜改：补依据。\n### 问题清单\n1. 绝对安全主张没有依据｜顶部，图 1 第 2 处｜改：删除 The safest cup for every baby。')
    .replace('图文一致性：', '| C2 | 无法确认 | 素材中的绝对安全承诺没有可核实的产品证据，保留证据缺口 | — | — |\n图文一致性：');
  let calls = 0, recoveryTask = '';
  const result = await execute({ run: async request => {
    if (++calls === 1) return { stdout: stream(session, ...chain, end('completed'), final(partial)) };
    recoveryTask = request.task;
    return { stdout: stream(session, end('completed'), final(repaired)) };
  } });
  assert.equal(calls, 2, 'nonempty incomplete report should get exactly one bounded repair');
  assert.equal(result.ok, true, result.error);
  assert.match(recoveryTask, /本轮已有报告/);
  assert.match(recoveryTask, /绝对安全主张没有依据/);
  assert.match(recoveryTask, /4B 事实准确性核查/);
  assert.ok(!recoveryTask.includes('bash kb/l8/review_run.sh'), 'repair must not rerun the KB engine');
  assert.ok(result.answer.includes(originalIssueBlock));
  assert.ok(result.answer.includes('C2：文字声称 The safest cup for every baby'));
  assert.ok(result.answer.includes('| C2 | 无法确认 |'), 'repair must cover every original claim instead of erasing C2');
  assert.ok(result.answer.includes('4B 已补全'));
  assert.equal(result.answer.includes('1. 绝对安全主张｜页脚'), false, 'rewritten issue text is discarded in favor of the original block');
});

await test('a completed continuation that omits the issue block receives the exact original issue block', async () => {
  const finding = '1. 具体已识别问题｜顶部，图 1 第 2 处｜改：修正文案。';
  const partial = report.replace('1. 无', finding)
    .replace(/4B 事实准确性核查：[\s\S]*?(?=图文一致性)/, '4B 事实准确性核查：待补完整核查表。\n');
  const completeButDropped = report.replace('1. 无', '1. 无');
  let calls = 0;
  const result = await execute({ run: async () => ({ stdout: ++calls === 1
    ? stream(session, ...chain, end('completed'), final(partial))
    : stream(session, end('completed'), final(completeButDropped)) }) });
  assert.equal(calls, 2);
  assert.equal(result.ok, true, result.error);
  assert.ok(result.answer.includes(finding), 'source issues stay verbatim despite model omission');
});

await test('a complete continuation in the original session remains eligible', async () => {
  let calls = 0;
  const result = await execute({ run: async () => ({ stdout: ++calls === 1
    ? stream(session, ...chain, end('max-tokens'))
    : stream(session, end('completed'), final(report)) }) });
  assert.equal(calls, 2);
  assert.equal(result.ok, true);
  assert.equal(result.answer, report);
});

await test('recovery receives the same verified source excerpts and applicability rules as its validator', async () => {
  const excerpt = 'These recommendations address infant sleep and do not establish the safety of a pictured awake holding position.';
  const kbExcerpt = '本条历史记录只说明当时素材的审核意见，不证明当前图片已经违反规则。';
  let calls = 0, recoveryTask = '';
  const result = await execute({
    sources: [{ id: 'fixture-infant-scope', kind: 'local_snapshot', verified: true,
      source_hash_verified: true, excerpt, content: excerpt }],
    readArtifacts: async () => ({ ...artifacts, engine: { ...artifacts.engine,
      evidence_meta: { kb_hits: [{ anchor: '#fixture-history', excerpt: kbExcerpt }] } } }),
    run: async request => {
      if (++calls === 1) return { stdout: stream(session, ...chain, end('max-tokens')) };
      recoveryTask = request.task;
      return { stdout: stream(session, end('completed'), final(report)) };
    },
  });
  assert.equal(calls, 2);
  assert.ok(recoveryTask.includes(excerpt), 'the report model must see the source text that the host will verify');
  assert.ok(recoveryTask.includes(kbExcerpt), 'current engine excerpts must retain their original kb:N identity');
  assert.ok(recoveryTask.includes('kb:1'));
  assert.match(recoveryTask, /非睡眠场景/);
  assert.match(recoveryTask, /不得套用睡眠风险/);
  assert.match(recoveryTask, /不能给抱姿安全背书/);
  assert.match(recoveryTask, /不能将无来源的画面读数写成.*支持/);
  assert.equal(result.ok, true);
});

await test('an incomplete continuation preserves its substantive findings without accepting another session', async () => {
  const partial = report.replace(/4B 事实准确性核查：[\s\S]*?(?=图文一致性)/,
    '4B 事实准确性核查：待补原始来源。\n')
    .replace('1. 无', '1. 安全宣称无法核实｜顶部，图 1 第 2 处｜改：补充原始证据。');
  for (const foreign of [false, true]) {
    let calls = 0;
    const result = await execute({ run: async () => ({ stdout: ++calls === 1
      ? stream(session, ...chain, end('max-tokens'))
      : stream(foreign ? { type: 'session', sessionId: 'session-foreign' } : session,
        end('completed'), final(partial)) }) });
    assert.equal(calls, 2);
    assert.equal(result.ok, false);
    assert.equal(result.engine, artifacts.engine);
    if (!foreign) assert.ok(result.partial_answer.includes('安全宣称无法核实'));
    assert.equal(result.recovery.completed, false);
  }
});

await test('explicit timeouts survive graceful child exits and retain completed engine evidence', async () => {
  let calls = 0;
  const result = await execute({ run: async () => {
    calls++;
    throw Object.assign(new Error('deadline'), { timedOut: true, killed: false,
      stdout: stream(session, ...chain, end('cancelled')) });
  } });
  assert.equal(calls, 2, 'only the bounded report continuation is attempted');
  assert.equal(result.reason_code, 'review_deadline_exceeded');
  assert.equal(result.engine, artifacts.engine);
  assert.equal(result.review, artifacts.review);
  assert.ok(result.generation.attempts.every(attempt => attempt.timed_out));
  assert.notEqual(result.ok, true);
});

// Independent boundary review: successful model output cannot erase the
// remaining publication reserve after artifact processing consumes it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executeImageChain, IMAGE_CHAIN_FIRST_MS, IMAGE_REPORT_RECOVERY_MS,
  IMAGE_PUBLISH_RESERVE_MS } from './image_chain_execution.mjs';

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
const stdout = [
  { type: 'session', sessionId: 'session-boundary' },
  { type: 'status', phase: 'turn_end', reason: { kind: 'completed' } },
  { type: 'final', text: report },
].map((row) => JSON.stringify(row)).join('\n');

await test('a completed engine may spend remaining time on one bounded report repair within the 180s deadline', async () => {
  let now = 1000;
  const budgets = [];
  const result = await executeImageChain({ task: 'fixture', deadlineAt: 181000,
    now: () => now,
    run: async ({ timeoutMs, sessionId, reportOnly }) => {
      budgets.push(timeoutMs);
      if (budgets.length === 2) {
        assert.equal(sessionId, 'session-budget');
        assert.equal(reportOnly, true);
      }
      now += timeoutMs;
      return { stdout: budgets.length === 1
        ? [
          { type: 'session', sessionId: 'session-budget' },
          { type: 'tool_call', callId: 'chain', tool: 'bash', input: { command: 'bash kb/l8/review_run.sh' } },
          { type: 'tool_result', callId: 'chain', status: 'completed' },
          { type: 'status', phase: 'turn_end', reason: { kind: 'max-tokens' } },
          { type: 'final', text: report.replace('1. 无', '1. 原风险必须保留｜顶部，图 1 第 2 处｜改：修正文案。')
            .replace('图文一致性：没有可读文字，未见文字与画面矛盾。\n', '') },
        ].map(JSON.stringify).join('\n')
        : [
          { type: 'session', sessionId: 'session-budget' },
          { type: 'status', phase: 'turn_end', reason: { kind: 'completed' } },
          { type: 'final', text: report.replace('### 问题清单\n1. 无',
            '补齐4B。\n### 问题清单\n1. 原风险必须保留｜顶部，图 1 第 2 处｜改：修正文案。') },
        ].map(JSON.stringify).join('\n') };
    },
    readArtifacts: async () => ({}),
    ownsArtifacts: () => true,
  });
  assert.equal(budgets.length, 2, 'one completed chain permits at most one same-session repair');
  assert.equal(budgets[0], IMAGE_CHAIN_FIRST_MS);
  assert.equal(budgets[1], IMAGE_REPORT_RECOVERY_MS);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.generation.budget.first_turn_ms, budgets[0]);
  assert.equal(result.generation.budget.recovery_ms, budgets[1]);
  assert.equal(result.generation.budget.send_reserve_ms, IMAGE_PUBLISH_RESERVE_MS);
  assert.ok(now <= 181000 - IMAGE_PUBLISH_RESERVE_MS);
});

await test('40.862s preparation still permits the original engine budget and a complete first report needs no repair', async () => {
  let now = 40_862;
  const budgets = [];
  const result = await executeImageChain({ task: 'fixture', deadlineAt: 180_000,
    now: () => now,
    run: async ({ timeoutMs }) => { budgets.push(timeoutMs); now += timeoutMs; return { stdout: [
      { type: 'tool_call', callId: 'chain', tool: 'bash', input: { command: 'review_run.sh' } },
      { type: 'tool_result', callId: 'chain', status: 'completed' },
    ].map(JSON.stringify).join('\n') + '\n' + stdout }; },
    readArtifacts: async () => { now += 1; return {}; },
    ownsArtifacts: () => true,
  });
  assert.equal(budgets.length, 1, 'a completed first-pass report is not needlessly resumed');
  assert.equal(budgets[0], 110_000, 'do not reserve hypothetical repair or fixed semantic-check time before the engine runs');
  assert.ok(budgets[0] <= 180_000 - 40_862 - IMAGE_PUBLISH_RESERVE_MS);
  assert.equal(result.generation.attempts[0].timeout_ms, budgets[0]);
  assert.equal(result.ok, true, result.error);
  assert.ok(now <= 180_000 - IMAGE_PUBLISH_RESERVE_MS);
});

await test('first successful final still rejects if reading its artifacts consumes the send reserve', async () => {
  let now = 90000;
  const result = await executeImageChain({ task: 'fixture', deadlineAt: 180000,
    now: () => now,
    run: async ({ timeoutMs }) => { now += timeoutMs; return { stdout }; },
    readArtifacts: async () => { now += 1; return {}; },
    ownsArtifacts: () => false,
  });
  assert.notEqual(result.ok, true, 'first-success branch must apply the same deadline check as recovery');
  assert.equal(result.reason_code, 'review_deadline_exceeded');
});

await test('a fully written report cannot claim success without a completed chain in this stream', async () => {
  const result = await executeImageChain({ task: 'fixture', deadlineAt: 180000,
    now: () => 1000,
    run: async () => ({ stdout }),
    readArtifacts: async () => ({ review: { state: 'REVIEW' } }),
    ownsArtifacts: () => true,
  });
  assert.notEqual(result.ok, true, 'headings and prose cannot replace actual chain execution');
});

await test('first-run success must reject artifacts that fail strict current-run ownership', async () => {
  const withChain = [
    { type: 'tool_call', callId: 'chain', tool: 'bash', input: { command: 'bash kb/l8/review_run.sh' } },
    { type: 'tool_result', callId: 'chain', status: 'completed', result: 'exit 0' },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n' + stdout;
  const result = await executeImageChain({ task: 'fixture', deadlineAt: 180000,
    now: () => 1000,
    run: async () => ({ stdout: withChain }),
    readArtifacts: async () => ({ review: { state: 'REVIEW', review_token: 'other-run' } }),
    ownsArtifacts: () => false,
  });
  assert.notEqual(result.ok, true, 'normal exit must not be weaker than report recovery');
});

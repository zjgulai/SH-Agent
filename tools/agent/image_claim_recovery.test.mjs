// Executor contract only: model process and semantic assessment are injected.
// No config loader, credentials, network, Feishu calls or live state are used.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executeImageChain } from './image_chain_execution.mjs';
import { checkImageWorkflowEvidence } from './image_workflow_evidence.mjs';

const report = [
  '## 审核对象与范围', '图1为产品插画，检查图文与安全主张。',
  '## 视觉分析与 OCR', '成人托抱婴儿；杯体标记 X；没有睡眠读数。',
  '## 主张拆分与核查清单', '- C1：杯体标记为 X。', '- C5：插画呈现成人托抱婴儿。',
  '## 4A 规则符合性', '本轮规则库未覆盖，不能据此认定安全。',
  '## 4B 事实准确性核查',
  '| 主张 | 核查结论 | 依据及边界 | 来源 | 来源原文 |',
  '| --- | --- | --- | --- | --- |',
  '| C1 | 画面可确认 | 杯体正面可读字母 X | — | — |',
  '| C5 | 无法确认 | 插画只显示托抱动作，画面不足以确认抱姿安全 | — | — |',
  '## 图文一致性', '杯体标记与标题相符，插画不能证明使用安全。',
  '视觉核对：婴幼儿姿势=有（成人托抱婴儿，身体未接触床面）；婴儿睡眠位置=无；产品状态=无；场景关系=无；隐私=无',
  '### 问题清单', '1. 安全事实无法确认｜中部，图 1 第 2 处｜改：补充可核依据。',
  '【审查结论：REVIEW】保留本轮证据缺口。',
].join('\n');
const repaired = report.replace('## 图文一致性', '本轮来源审查已逐项记录。\n\n## 图文一致性');
const sources = [{ id: 'fixture-source', verified: true, excerpt: 'Fixture source for the claim, not a medical assertion.' }];
const artifacts = { engine: { state: 'REVIEW', evidence_meta: { kb_hits: [
  { anchor: '#fixture-history', excerpt: '本轮历史规则只用于定位，不能证明素材安全。' },
] } }, review: { state: 'REVIEW' } };
const stream = (answer, { first = false, session = 'session-current' } = {}) => [
  { type: 'session', sessionId: session },
  ...(first ? [{ type: 'tool_call', callId: 'chain', tool: 'bash', input: { command: 'review_run.sh' } },
    { type: 'tool_result', callId: 'chain', status: 'completed' }] : []),
  { type: 'status', phase: 'turn_end', reason: { kind: 'completed' } },
  { type: 'final', text: answer },
].map(value => JSON.stringify(value)).join('\n');
async function execute({ first = report, second = repaired, checkReport, ...options } = {}) {
  const requests = [];
  const result = await executeImageChain({ task: '本轮图片审核', deadlineAt: 180000, now: () => 0,
    sources, readArtifacts: async () => artifacts, ownsArtifacts: () => true, checkReport,
    run: async request => {
      requests.push(request);
      return { stdout: stream(requests.length === 1 ? first : second, { first: requests.length === 1 }) };
    }, ...options });
  return { result, requests };
}

await test('full checker rejects format-complete first report and receives same sources for one same-session recovery', async () => {
  const checks = [];
  const { result, requests } = await execute({ checkReport: async (answer, context) => {
    checks.push({ answer, context });
    return { ok: checks.length > 1, missing: checks.length > 1 ? [] : ['C5 来源适用关系未核查'] };
  } });
  assert.equal(result.ok, true, result.error);
  assert.equal(requests.length, 2);
  assert.equal(checks.length, 2);
  assert.strictEqual(checks[0].context.sources, checks[1].context.sources);
  assert.deepEqual(checks[0].context.sources.map(source => source.id), ['fixture-source', 'kb:1']);
  assert.equal(checks[1].context.originalAnswer, report);
  assert.equal(checks[0].context.deadlineAt, 160000);
  assert.equal(checks[1].context.deadlineAt, 160000);
  assert.equal(requests[1].sessionId, 'session-current');
  assert.equal(requests[1].reportOnly, true);
  assert.ok(requests[1].timeoutMs <= 45000);
  assert.ok(requests[1].task.includes('C5 来源适用关系未核查'));
});

await test('normalised first-check answer is the delivered report', async () => {
  const normalized = report + '\n核查边界：本轮只确认可见信息。';
  const { result } = await execute({ checkReport: async () => ({ ok: true, missing: [], answer: normalized }) });
  assert.equal(result.answer, normalized);
});

await test('normalised recovery answer is delivered and its checker cannot erase original unknown boundary', async () => {
  let calls = 0;
  const normalized = repaired + '\n本轮来源范围记录已完成。';
  const { result } = await execute({ checkReport: async () => ++calls === 1
    ? { ok: false, missing: ['C5 来源核查缺项'] } : { ok: true, missing: [], answer: normalized } });
  assert.equal(result.answer, normalized);
  assert.equal(result.recovery.completed, true);
});

await test('unrelated citation rejected by shared checker cannot become recovery success', async () => {
  let checks = 0;
  const { result, requests } = await execute({ checkReport: async () => {
    checks++; return { ok: false, missing: ['C5 引文只讨论另一主张，尚未核实'] };
  } });
  assert.equal(checks, 2);
  assert.equal(requests.length, 2);
  assert.equal(result.ok, false);
  assert.equal(result.recovery.completed, false);
  assert.match(result.error, /C5 引文只讨论另一主张/);
});

await test('a real missing citation can be repaired without changing original claim or unknown facts', async () => {
  const quote = 'The fixture product is identified by the printed letter X.';
  const source = { id: 'fixture-product', kind: 'local_snapshot', verified: true, content: quote, excerpt: quote };
  const first = report.replace('| C1 | 画面可确认 |', '| C1 | 支持 |');
  const second = first.replace('| C1 | 支持 | 杯体正面可读字母 X | — | — |',
    `| C1 | 支持 | 杯体正面可读字母 X | fixture-product | ${quote} |`);
  let checks = 0;
  const { result, requests } = await execute({ first, second, sources: [source],
    checkReport: async (answer, { sources }) => { checks++; return checkImageWorkflowEvidence(answer, { sources }); } });
  assert.equal(checks, 2);
  assert.equal(requests.length, 2);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.answer, second);
  assert.ok(result.answer.includes('| C5 | 无法确认 | 插画只显示托抱动作，画面不足以确认抱姿安全 |'));
});

for (const injected of [false, true]) {
  await test(`deleted C5 cannot disappear from recovery acceptance (${injected ? 'full checker' : 'fallback'})`, async () => {
    const first = report.replace('## 图文一致性\n杯体标记与标题相符，插画不能证明使用安全。', '');
    const second = repaired.replace('- C5：插画呈现成人托抱婴儿。\n', '')
      .replace('| C5 | 无法确认 | 插画只显示托抱动作，画面不足以确认抱姿安全 | — | — |\n', '');
    let checks = 0;
    const { result, requests } = await execute({ first, second,
      ...(injected ? { checkReport: async () => ({ ok: ++checks > 1, missing: checks > 1 ? [] : ['图文一致性'] }) } : {}) });
    assert.equal(requests.length, 2);
    assert.equal(result.ok, false);
    assert.match(result.error, /C5|主张/);
  });
}

await test('restoring original claims prevents a recovery from changing C5 meaning', async () => {
  let checks = 0;
  const second = repaired.replace('- C5：插画呈现成人托抱婴儿。', '- C5：本产品保证婴儿安全。');
  const { result, requests } = await execute({ second, checkReport: async () => ({ ok: ++checks > 1,
    missing: checks > 1 ? [] : ['来源核查缺项'] }) });
  assert.equal(requests.length, 2);
  assert.equal(result.ok, true, result.error);
  assert.ok(result.answer.includes('- C5：插画呈现成人托抱婴儿。'));
  assert.ok(!result.answer.includes('- C5：本产品保证婴儿安全。'));
});

for (const withRow of [true, false]) {
  await test(`an omitted OCR claim can be added only with its own 4B row (${withRow ? 'complete' : 'missing row'})`, async () => {
    const declaration = '- C6：图中右侧标签另写型号 Y。';
    let second = repaired.replace('## 4A 规则符合性', `${declaration}\n## 4A 规则符合性`);
    if (withRow) second = second.replace('## 图文一致性',
      '| C6 | 画面可确认 | 图中右侧标签可读型号 Y，只确认文字词形 | — | — |\n## 图文一致性');
    let checks = 0;
    const { result, requests } = await execute({ second, checkReport: async (answer, { sources }) => {
      if (++checks === 1) return { ok: false, missing: ['原图标签型号尚未列入 C 主张清单'] };
      return checkImageWorkflowEvidence(answer, { sources });
    } });
    assert.equal(requests.length, 2);
    assert.equal(result.ok, withRow, result.error);
    if (withRow) {
      assert.ok(result.answer.includes(declaration), 'newly recovered claims must not be discarded');
      assert.ok(result.answer.includes('- C5：插画呈现成人托抱婴儿。'));
      assert.ok(result.answer.includes('| C5 | 无法确认 | 插画只显示托抱动作，画面不足以确认抱姿安全 |'));
    }
  });
}

for (const [label, second] of [
  ['conclusion promoted', repaired.replace('| C5 | 无法确认 |', '| C5 | 支持 |')],
  ['unknown boundary erased', repaired.replace('插画只显示托抱动作，画面不足以确认抱姿安全', '插画显示托抱动作，现已确认安全')],
]) {
  await test(`recovery restores ${label} before the full checker refuses the still-unknown safety fact`, async () => {
    const checked = [];
    const { result, requests } = await execute({ second, checkReport: async answer => {
      checked.push(answer);
      const hasUnknown = answer.includes('| C5 | 无法确认 | 插画只显示托抱动作，画面不足以确认抱姿安全 |');
      return { ok: !hasUnknown, missing: hasUnknown ? ['C5 婴儿安全事实仍无法确认'] : [] };
    } });
    assert.equal(requests.length, 2);
    assert.ok(checked[1].includes('| C5 | 无法确认 | 插画只显示托抱动作，画面不足以确认抱姿安全 |'),
      'the original unknown reaches the semantic checker even if the model rewrites it');
    assert.equal(result.ok, false);
    assert.match(result.error, /C5|无法确认|边界/);
  });
}

await test('normalisation cannot bypass preserved unknown boundaries', async () => {
  let checks = 0;
  const { result } = await execute({ checkReport: async () => ++checks === 1
    ? { ok: false, missing: ['来源核查缺项'] }
    : { ok: true, missing: [], answer: repaired.replace('| C5 | 无法确认 |', '| C5 | 支持 |') } });
  assert.equal(result.ok, false);
});

await test('recovery cannot erase a first-pass unknown observation outside the claims and fact table', async () => {
  const known = report.replace('| C5 | 无法确认 | 插画只显示托抱动作，画面不足以确认抱姿安全 |',
    '| C5 | 画面可确认 | 中部可见成人双手托抱婴儿，只描述可见动作 |');
  const first = known.replace('## 主张拆分与核查清单',
    '独立观察：无法确认婴儿是否与成人同床。\n## 主张拆分与核查清单');
  const checked = [];
  const { result, requests } = await execute({ first, second: known,
    checkReport: async answer => {
      checked.push(answer);
      const hasUnknown = answer.includes('独立观察：无法确认婴儿是否与成人同床。');
      return { ok: !hasUnknown, missing: hasUnknown ? ['原始观察中的未知事实待核查'] : [] };
    } });
  assert.equal(requests.length, 2);
  assert.ok(checked[1].includes('独立观察：无法确认婴儿是否与成人同床。'));
  assert.equal(result.ok, false);
  assert.match(result.error, /未确认|未知|保留/);
});

await test('declaration references and a repeated mapping column do not rewrite the original C claims', async () => {
  const first = report.replace('- C1：杯体标记为 X。\n- C5：插画呈现成人托抱婴儿。',
    '| 编号 | 主张（类型） | 来源层 |\n|---|---|---|\n| C1 | 杯体标记为 X。 | 文字 |\n| C5 | 插画呈现成人托抱婴儿。 | 画面 |\n\n（C1、C5 逐项见 4B。）');
  const second = first.replace('| 来源层 |', '| 来源层 | 4B 行 |')
    .replace('|---|---|---|', '|---|---|---|---|')
    .replace('| C1 | 杯体标记为 X。 | 文字 |', '| C1 | 杯体标记为 X。 | 文字 | C1 |')
    .replace('| C5 | 插画呈现成人托抱婴儿。 | 画面 |', '| C5 | 插画呈现成人托抱婴儿。 | 画面 | C5 |')
    .replace('## 4A 规则符合性', 'C1↔C1、C5↔C5。\n## 4A 规则符合性');
  let checks = 0;
  const { result } = await execute({ first, second, checkReport: async () => ({
    ok: ++checks > 1, missing: checks > 1 ? [] : ['补交来源关系'] }) });
  assert.equal(result.ok, true, result.error);
  assert.ok(result.answer.includes('| C1 | 杯体标记为 X。 | 文字 |'));
  assert.ok(result.answer.includes('| C5 | 插画呈现成人托抱婴儿。 | 画面 |'));
});

for (const dropRow of [false, true]) {
  await test(`nested C declaration headings are restored without excusing a missing 4B row (${dropRow ? 'missing' : 'complete'})`, async () => {
    const first = report.replace('- C1：', '### C1：').replace('- C5：', '### C5：');
    let second = repaired.replace('- C5：插画呈现成人托抱婴儿。', '- C5：本品保证婴儿安全。');
    if (dropRow) second = second.replace('| C5 | 无法确认 | 插画只显示托抱动作，画面不足以确认抱姿安全 | — | — |\n', '');
    let checks = 0;
    const { result } = await execute({ first, second, checkReport: async () => ({
      ok: ++checks > 1, missing: checks > 1 ? [] : ['补交核查'] }) });
    assert.equal(result.ok, !dropRow, result.error);
    const finalText = result.answer ?? result.partial_answer;
    assert.ok(finalText.includes('### C5：插画呈现成人托抱婴儿。'));
    assert.ok(!finalText.includes('- C5：本品保证婴儿安全。'));
    if (dropRow) assert.match(result.error, /C5|主张/);
  });
}

await test('an added table declaration retains its own header after original declarations are restored', async () => {
  const first = report.replace('- C1：杯体标记为 X。\n- C5：插画呈现成人托抱婴儿。',
    '| 编号 | 主张 |\n|---|---|\n| C1 | 杯体标记为 X。 |\n| C5 | 插画呈现成人托抱婴儿。 |');
  const second = first.replace('| 编号 | 主张 |', '| 编号 | 主张 | 4B 行 |')
    .replace('|---|---|', '|---|---|---|')
    .replace('| C1 | 杯体标记为 X。 |', '| C1 | 杯体标记为 X。 | C1 |')
    .replace('| C5 | 插画呈现成人托抱婴儿。 |', '| C5 | 插画呈现成人托抱婴儿。 | C5 |\n| C6 | 杯体另写型号 Y。 | C6 |')
    .replace('## 图文一致性', '| C6 | 画面可确认 | 右侧可见型号 Y 字样 | — | — |\n## 图文一致性');
  let checks = 0;
  const { result } = await execute({ first, second, checkReport: async (answer, { sources }) => ++checks === 1
    ? { ok: false, missing: ['漏了型号主张'] } : checkImageWorkflowEvidence(answer, { sources }) });
  assert.equal(result.ok, true, result.error);
  assert.ok(result.answer.includes('| 编号 | 主张 | 4B 行 |\n|---|---|---|\n| C6 | 杯体另写型号 Y。 | C6 |'));
});

await test('a verbatim boundary prefix and new safety assertions stay in the table once for semantic review', async () => {
  const originalBoundary = '插画只显示托抱动作，画面不足以确认抱姿安全';
  const addition = '新增待核信息：标签另有绝对安全承诺，尚无来源。';
  const second = repaired.replace(originalBoundary, originalBoundary + '；' + addition);
  let checks = 0;
  const { result } = await execute({ second, checkReport: async answer => {
    if (++checks === 1) return { ok: false, missing: ['待补交核查'] };
    assert.ok(answer.includes(`| C5 | 无法确认 | ${originalBoundary}；${addition} |`));
    assert.ok(answer.includes(addition), 'new candidate evidence must not be removed with the rewritten field');
    assert.equal(answer.split(addition).length - 1, 1, 'already-preserved boundary additions must not be duplicated');
    return { ok: false, missing: ['补交新增的安全承诺仍缺来源'] };
  } });
  assert.equal(checks, 2);
  assert.equal(result.ok, false);
  assert.match(result.error, /新增的安全承诺/);
});

await test('a malformed extra fact row is retained as historical evidence without aliasing a valid C', async () => {
  const invalidRow = '| C5′ 本图是否还含额外标签 | 无法确认 | 侧边被遮挡，额外标签无法确认 | — | — |';
  const first = report.replace('## 图文一致性', invalidRow + '\n## 图文一致性');
  const second = repaired.replace('## 4A 规则符合性', '- C6：本图是否还含额外标签。\n## 4A 规则符合性')
    .replace('## 图文一致性', '| C6 | 无法确认 | 侧边被遮挡，额外标签无法确认 | — | — |\n## 图文一致性');
  let checks = 0;
  const { result } = await execute({ first, second, checkReport: async (answer, { sources }) => {
    if (++checks === 1) return { ok: false, missing: ['额外核查行编号无效'] };
    assert.ok(answer.includes(invalidRow), 'the malformed row content must still reach full semantic review');
    const workflow = checkImageWorkflowEvidence(answer, { sources });
    assert.deepEqual(workflow.factReview.rows.map(row => row.id), ['C1', 'C5', 'C6']);
    return workflow;
  } });
  assert.equal(result.ok, true, result.error);
  assert.ok(result.answer.includes('首轮待核原文'));
});

await test('async first-check time counts against publication reserve', async () => {
  let time = 145000;
  const { result, requests } = await execute({ now: () => time,
    checkReport: async () => { time += 15001; return { ok: true, missing: [] }; } });
  assert.equal(result.ok, false);
  assert.equal(result.reason_code, 'review_deadline_exceeded');
  assert.equal(requests.length, 1);
});

await test('async recovery check cannot consume the publication reserve and still succeed', async () => {
  let time = 130000, checks = 0;
  const { result } = await execute({ now: () => time, checkReport: async () => {
    time += ++checks === 1 ? 10000 : 20001;
    return { ok: checks > 1, missing: checks > 1 ? [] : ['来源核查缺项'] };
  } });
  assert.equal(checks, 2);
  assert.equal(result.ok, false);
  assert.equal(result.reason_code, 'review_deadline_exceeded');
});

await test('139 seconds remaining must not kill a 75-second engine to reserve a hypothetical recovery', async () => {
  let time = 41000, runs = 0;
  const { result } = await execute({ now: () => time,
    run: async request => {
      runs++;
      if (request.timeoutMs < 75000) {
        time += request.timeoutMs;
        throw Object.assign(new Error('engine interrupted before completion'), { timedOut: true,
          stdout: JSON.stringify({ type: 'session', sessionId: 'session-current' }) });
      }
      time += 75000;
      return { stdout: stream(report, { first: true }) };
    },
    checkReport: async () => { time += 1000; return { ok: true, missing: [] }; } });
  assert.equal(runs, 1);
  assert.equal(result.ok, true, result.error);
  assert.ok(time < 160000);
});

await test('a 59-second first report plus 15-second check can still use the remaining bounded recovery', async () => {
  let time = 41000, runs = 0, checks = 0;
  const { result } = await execute({ now: () => time,
    run: async request => {
      runs++;
      if (runs === 1) time += 59000;
      else { assert.ok(request.timeoutMs >= 5000 && request.timeoutMs <= 45000); time += 10000; }
      return { stdout: stream(runs === 1 ? report : repaired, { first: runs === 1 }) };
    },
    checkReport: async () => {
      time += ++checks === 1 ? 15000 : 2000;
      return { ok: checks > 1, missing: checks > 1 ? [] : ['本轮逐项来源尚缺核查'] };
    } });
  assert.equal(runs, 2);
  assert.equal(checks, 2);
  assert.equal(result.ok, true, result.error);
  assert.ok(time < 160000);
});

await test('foreign-session recovery cannot be accepted or assessed as this report', async () => {
  let runs = 0, checks = 0;
  const { result } = await execute({ checkReport: async () => {
    checks++; return { ok: false, missing: ['来源核查缺项'] };
  }, run: async () => ({ stdout: ++runs === 1 ? stream(report, { first: true })
    : stream(repaired, { session: 'session-foreign' }) }) });
  assert.equal(runs, 2);
  assert.equal(checks, 1);
  assert.equal(result.ok, false);
});

await test('checker failure and malformed assessment stay unmeasured instead of succeeding', async () => {
  for (const checkReport of [async () => { throw Error('fixture error'); }, async () => ({}),
    async () => ({ ok: true, missing: ['C5 未核实'] })]) {
    const { result, requests } = await execute({ checkReport });
    assert.equal(result.ok, false);
    assert.ok(requests.length <= 2);
  }
});

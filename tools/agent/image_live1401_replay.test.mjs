// Exact 2026-11-03 live report replay. No live model, engine, config or external writes.
// Semantic refusal is deliberately injected: this tests refusal wiring and preservation,
// not whether a model can discover the unknown. The separate live replay measures that.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { buildImageClaimEvidence } from './image_claim_review.mjs';
import { checkImageWorkflowEvidence } from './image_workflow_evidence.mjs';
import { checkImageReport } from './image_report_completion.mjs';
import { executeImageChain } from './image_chain_execution.mjs';

const base = new URL('../../PMO/守衡-图片来源逐项核查与交付统一修复-20261103/live1401-replay-20261103/', import.meta.url);
const read = name => fs.readFileSync(new URL(name, base), 'utf8');
const first = read('first-report.md');
const recovery = read('recovery-report.md');
const input = JSON.parse(read('checker-input.json'));
const { sources } = JSON.parse(read('adapted-sources.json'));
const ids = Array.from({ length: 8 }, (_, i) => `C${i + 1}`);
const sha = text => createHash('sha256').update(text).digest('hex');
const unknown = 'C6 婴儿臂托位置、气道是否通畅的安全事实仍无法确认';

await test('the two live reports are exact originals, including risk and unknown text', () => {
  assert.equal(sha(first), '414a148d4ed66b3e32a783470b804e6ae4c4907d5ba668a33cd849c91784278a');
  assert.equal(sha(recovery), '07e36d248b2b386149a9c089d5a7366bb066f4f2bcf5f9145228327b1f7c6cb3');
  assert.match(first, /C6′/);
  assert.match(recovery, /明确的婴儿安全未知保留/);
  assert.match(recovery, /插画无五官故无法判断呼吸通畅/);
  assert.deepEqual(sources.map(source => source.id), ['aap-safe-sleep-2022', 'kb:1', 'kb:2', 'kb:3', 'kb:4', 'kb:5']);
});

await test('original illegal C6 prime row remains incomplete; cross-references are not declarations', () => {
  const workflow = checkImageWorkflowEvidence(first, { sources });
  assert.deepEqual(workflow.factReview.expectedClaimIds, ids);
  assert.equal(workflow.ok, false);
  const evidence = buildImageClaimEvidence({ ...input, sources, reportText: first });
  assert.equal(evidence.ok, false);
  assert.equal(evidence.code, 'image_claim_report_incomplete');
});

await test('untouched recovery mapping column and prose references yield eight complete claim rows', () => {
  const evidence = buildImageClaimEvidence({ ...input, sources, reportText: recovery });
  assert.equal(evidence.ok, true, evidence.reason);
  assert.deepEqual(evidence.claims.map(claim => claim.id), ids);
  assert.match(evidence.claims.find(claim => claim.id === 'C6').row.boundary, /明确的婴儿安全未知保留/);
  assert.match(evidence.claims.find(claim => claim.id === 'C8').row.boundary, /原 C6′ 并入本行/);
  assert.equal(evidence.claims.find(claim => claim.id === 'C8').citation.ok, true);
});

await test('actual shared checker reaches semantic refusal on unedited recovery, never converts it to completion', async () => {
  let calls = 0;
  const baseRunner = bucket => async checked => {
    calls++;
    assert.match(checked.reportText, /明确的婴儿安全未知保留/);
    assert.equal(buildImageClaimEvidence(checked).ok, true);
    return { ok: false, code: 'image_claim_source_required', [bucket]: [unknown], reason: unknown,
      claims: [{ id: 'C6', kind: 'infant_safety_unknown' }] };
  };
  // 严格档（= IMAGE_CLAIM_ENFORCE=1）：语义拒收 ⇒ 不交付。
  const strict = await checkImageReport(recovery, { ...input, sources, enforceClaimReview: true,
    claimRunner: baseRunner('missing') });
  assert.equal(strict.ok, false);
  assert.equal(strict.workflow.semanticReview.code, 'image_claim_source_required');
  assert.ok(strict.missing.includes(unknown));
  // 默认档（10-27 口径）：**覆盖/留痕类**缺项不否决整单，但必须留痕，且未知读数不丢。
  const advisory = await checkImageReport(recovery, { ...input, sources,
    claimRunner: baseRunner('softMissing') });
  assert.equal(advisory.ok, true, advisory.workflow.reason);
  assert.equal(advisory.workflow.claimReview.enforced, false);
  assert.ok(advisory.workflow.claimReview.advisory.includes(unknown));
  assert.equal(calls, 2, 'both modes must actually consult the checker');
});

await test('real first/recovery texts survive one same-session repair and retained unknown blocks delivery', async () => {
  const runs = [], checks = [], semanticInputs = [];
  const stream = (text, firstTurn) => [
    { type: 'session', sessionId: 'session-a529ad08-e586-4d8b-ba9f-ffa2c43d911c' },
    ...(firstTurn ? [{ type: 'tool_call', tool: 'bash', callId: 'recorded-chain', input: { command: 'review_run.sh' } },
      { type: 'tool_result', callId: 'recorded-chain', status: 'completed' }] : []),
    { type: 'final', text }, { type: 'status', phase: 'turn_end', reason: { kind: 'completed' } },
  ].map(row => JSON.stringify(row)).join('\n');
  const result = await executeImageChain({ task: 'Read-only fixture stream; no engine execution',
    deadlineAt: Date.now() + 180000, sources,
    readArtifacts: async () => ({ engine: { state: 'REVIEW' }, review: { state: 'REVIEW' } }),
    ownsArtifacts: () => true,
    run: async request => {
      runs.push(request);
      return { stdout: stream(runs.length === 1 ? first : recovery, runs.length === 1) };
    },
    checkReport: async (reportText, context) => {
      const checked = await checkImageReport(reportText, { ...input, sources: context.sources,
        deadlineAt: context.deadlineAt,
        // ★ 2026-11-03：本用例钉的是「保留的婴儿未知必须挡住交付」——那是严格档的性质，
        //   默认档（10-27 口径）已降为留痕，所以这里显式走严格档。
        enforceClaimReview: true,
        claimRunner: async evidenceInput => {
          semanticInputs.push(evidenceInput);
          return { ok: false, code: 'image_claim_source_required', missing: [unknown], reason: unknown,
            claims: [{ id: 'C6', kind: 'infant_safety_unknown' }] };
        } });
      checks.push({ reportText, result: checked });
      return checked;
    } });
  assert.equal(runs.length, 2);
  assert.equal(runs[1].sessionId, 'session-a529ad08-e586-4d8b-ba9f-ffa2c43d911c');
  assert.equal(runs[1].reportOnly, true);
  assert.equal(checks.length, 2);
  assert.equal(semanticInputs.length, 1, JSON.stringify(checks.map(check => check.result.missing)));
  const finalText = semanticInputs[0].reportText;
  const finalEvidence = buildImageClaimEvidence(semanticInputs[0]);
  assert.equal(finalEvidence.ok, true, finalEvidence.reason);
  assert.deepEqual(finalEvidence.claims.map(claim => claim.id), ids);
  assert.match(finalText, /明确的婴儿安全未知保留/);
  assert.match(finalText, /插画无五官故无法判断呼吸通畅/);
  for (const line of first.split('\n').filter(line => /^[12]\. /.test(line) && line.includes('｜改：'))) {
    assert.ok(finalText.includes(line), 'original issue text must remain byte-identical');
  }
  assert.equal(result.ok, false);
  assert.equal(result.recovery.completed, false);
  assert.match(result.error, /C6 婴儿臂托位置/);
});

// ★ 2026-11-03：验收失败**必须指出错在哪**。此前六章检查只回章名（"4B 事实准确性核查"），
// 这串字会被原样塞进补写提示（image_chain_execution.mjs:342）⇒ 模型无从修 ⇒ 整表重写 ⇒
// 又撞逐字保留的闸 ⇒ 永远「审查未完成」（当天 7 单同一形状）。这里钉住：真实报告失败时，
// 每条缺项都必须超出"裸章节名"。
await test('真实报告失败时，缺项必须可行动（不许只回章节名）', () => {
  const bare = ['审核对象与范围', '视觉分析与 OCR', '主张拆分与核查清单', '4A 规则符合性', '4B 事实准确性核查', '图文一致性'];
  const workflow = checkImageWorkflowEvidence(first, { sources });
  assert.equal(workflow.ok, false);
  assert.ok(workflow.missing.length > 0);
  for (const item of workflow.missing) {
    assert.ok(!bare.includes(item), `缺项只有章名、不可行动：${item}`);
  }
  // 这份真实首轮报告的真因是 C6′ 非法编号，必须点名到那一行
  assert.ok(workflow.missing.some((item) => item.includes("C6′")), workflow.missing.join('；'));
  // 对照：修好的那份必须干净
  assert.deepEqual(checkImageWorkflowEvidence(recovery, { sources }).missing, []);
});

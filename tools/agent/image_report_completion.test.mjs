import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkImageReport } from './image_report_completion.mjs';
import { buildImageClaimEvidence } from './image_claim_review.mjs';
import { reviewFailureOf, reviewFailureText } from './review_feedback.mjs';

const report = [
  '审核对象与范围：图1成人抱婴的居家插画，检查文字、画面及事实。',
  '视觉分析与 OCR：图1成人坐着抱婴，没有睡眠场景。',
  '主张拆分与核查清单：C1：成人坐着抱婴。',
  '4A 规则符合性：本轮未命中规则，不能因此证明安全。',
  '4B 事实准确性核查：',
  '| 主张 | 核查结论 | 依据及边界 | 来源 | 来源原文 |',
  '| --- | --- | --- | --- | --- |',
  '| C1 | 画面可确认 | 图1成人坐着，双手抱着婴儿；只描述画面，不作安全判断 | — | — |',
  '图文一致性：图中文字没有与抱婴画面矛盾的内容。',
  '视觉核对：婴幼儿姿势=无；婴儿睡眠位置=无；产品状态=无；场景关系=无；隐私=无',
].join('\n');
const options = () => ({ scenes: [{ people: [{ kind: '婴儿', doing: '被成人抱着',
  sleep_scene: false, sleep_posture: '不适用' }], products: [], risk_cues: [], unclear: [] }],
  materialTexts: [{ origin: 'image_ocr', status: 'empty', text: '', image: 1 }], sources: [], cache: new Map() });
const accepted = input => {
  const evidence = buildImageClaimEvidence(input);
  assert.equal(evidence.ok, true, evidence.reason);
  return { ok: true, evidenceHash: evidence.evidenceHash, sleepReviews: [],
    wireDecisions: evidence.records.map((record, index) => [record.ordinal ?? index + 1, 'o',
      evidence.claims.filter(claim => claim.recordIds.includes(record.id)).map(claim => claim.id)]),
    claims: evidence.claims.map(claim => ({ id: claim.id, rowHash: claim.rowHash,
      kind: 'observation', sourceAssessment: 'no_source', reason: '仅核对抱婴可见动作' })) };
};

await test('pure holding observation completes without requiring an unrelated sleep citation', async () => {
  let calls = 0;
  const result = await checkImageReport(report, { ...options(), claimRunner: async input => {
    calls++; assert.equal(input.reportText, report); assert.equal(input.scenes[0].people[0].kind, '婴儿');
    return accepted(input);
  } });
  assert.equal(result.ok, true, result.workflow.reason);
  assert.equal(calls, 1, 'every complete report receives semantic claim review');
});
await test('mixed presence plus safety claim：覆盖缺项默认留痕（10-27 口径），严格档才拒收', async () => {
  const mixed = report.replace('C1：成人坐着抱婴。', 'C1：婴儿出镜，本品绝对安全。');
  // 覆盖记账类缺项 = validator 的 softMissing（报告自述句 / 安全主张未进 C 清单）。
  const runner = async () => ({
    ok: false, code: 'image_claim_source_required', missing: [],
    softMissing: ['C1 安全断言没有对应来源'],
  });
  // ★ 2026-11-03（Owner 批准 ②）：语义覆盖缺项默认不否决整单，但必须留痕点名到 C。
  const advisory = await checkImageReport(mixed, { ...options(), claimRunner: runner });
  assert.equal(advisory.ok, true, '默认档不得否决整单');
  assert.equal(advisory.workflow.claimReview.enforced, false);
  assert.ok(advisory.workflow.claimReview.advisory.some(item => /C1/.test(item)), '留痕必须点名到 C1');
  // 严格档（IMAGE_CLAIM_ENFORCE=1 等价）保持原判据。
  const strict = await checkImageReport(mixed, { ...options(), claimRunner: runner, enforceClaimReview: true });
  assert.equal(strict.ok, false);
  assert.match(strict.workflow.reason, /C1/);
});
await test('generation and final checks reuse only exactly identical current evidence', async () => {
  let calls = 0;
  const opts = { ...options(), claimRunner: async input => { calls++; return accepted(input); } };
  await checkImageReport(report, opts);
  await checkImageReport(report, opts);
  assert.equal(calls, 1);
  opts.materialTexts[0] = { origin: 'image_ocr', status: 'ok', text: '婴儿出镜，本品绝对安全', image: 1 };
  await checkImageReport(report, opts);
  assert.equal(calls, 2, 'different OCR must not reuse an old approval');
  opts.sources = [{ id: 'new-source', content: 'changed' }];
  await checkImageReport(report, opts);
  assert.equal(calls, 3, 'different sources invalidate the receipt');
});
await test('incomplete workflow and unreadable material cannot be blessed by a semantic result', async () => {
  let calls = 0;
  const opts = { ...options(), claimRunner: async input => { calls++; return accepted(input); } };
  assert.equal((await checkImageReport(report.replace('4B 事实准确性核查：', '缺失章节：'), opts)).ok, false);
  opts.materialTexts[0].status = 'failed';
  assert.equal((await checkImageReport(report, opts)).ok, false);
  assert.equal(calls, 0);
});
await test('checker exceptions and budget expiry are explicit untested failures', async () => {
  const failed = await checkImageReport(report, { ...options(), claimRunner: async () => { throw new Error('offline'); } });
  assert.equal(failed.ok, false);
  assert.match(failed.workflow.reason, /复核未完成/);
  let calls = 0;
  const expired = await checkImageReport(report, { ...options(), deadlineAt: Date.now() - 1,
    claimRunner: async input => { calls++; return accepted(input); } });
  assert.equal(expired.ok, false);
  assert.equal(calls, 0);
});

await test('a bare success boolean never replaces a complete current-evidence receipt', async () => {
  const result = await checkImageReport(report, { ...options(), claimRunner: async () => ({ ok: true }) });
  assert.equal(result.ok, false);
  assert.equal(result.workflow.semanticReview.code, 'image_claim_response_invalid');
  assert.equal(result.workflow.infantSource.required, null, 'an unmeasured result cannot claim absence');
});

await test('known unsupported claims are not mislabeled as an unmeasured scope classification', () => {
  const failure = reviewFailureOf({}, { withheld: true, imageCompletion: {
    incomplete: true, reason: 'C1 无关引用', imageWorkflowGate: {
      ok: false, semanticReview: { ok: false, code: 'image_claim_source_required', retryable: false },
    },
  } });
  assert.equal(failure.code, 'image_claim_source_required');
  assert.equal(failure.retryable, false);
  assert.match(reviewFailureText(failure), /对应且适用/);
});

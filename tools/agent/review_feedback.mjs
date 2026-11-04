/** Structured review failures and delivery options. Never infer a cause or verdict
 * from the reply model's prose; the first send and retry share this projection. */
import { conforms } from './prd53.mjs';
import { INFANT_SOURCE_MISSING } from './visual_checklist.mjs';

export function hasReviewDecision(result) {
  const meta = result?.meta;
  if (meta?.reviewDecisionWithheld) return false;
  const verdict = meta?.verdict53;
  const checked = conforms(verdict?.line);
  return checked.ok && checked.state === verdict?.state;
}

const RETRYABLE_CHAIN_FAILURES = new Set(['claim_busy', 'layer_gate_red',
  'layer_audit_red', 'preflight_aborted', 'chain_error', 'kb_readings_missing']);
const REPORT_FAILURES = new Set(['final_output_token_limit',
  'review_deadline_exceeded', 'final_report_incomplete']);

/** One structured failure is shared by scheduling and presentation. Other layers
 * remain related evidence; their reason cannot replace the blocking layer. */
export function reviewFailureOf(result, { withheld = false, unparsed = false,
  missingReadings = false, imageCompletion = null, videoCompletion = null } = {}) {
  if (!withheld) return null;
  const refusal = result?.review?.refusal;
  const code = String(refusal?.reason_code || result?.reason_code
    || (result?.error ? 'chain_error'
      : missingReadings ? 'kb_readings_missing'
        : unparsed ? 'conclusion_unparsed' : 'review_unavailable'));
  const knowledge = { stage: 'knowledge_review', code,
    retryable: RETRYABLE_CHAIN_FAILURES.has(code),
    detail: String(refusal?.human || refusal?.reason || result?.error || '') || null };
  // A current engine sidecar can contain a coverage refusal even when the
  // blocking failure happened later, while generating the full image report.
  // Preserve that later failure; whole-review retries would discard completed
  // work and replay the same exhausted budget. Any continuation runs in the
  // original chain's bounded report-recovery path, not the replay queue.
  if (REPORT_FAILURES.has(result?.reason_code)) {
    return { stage: 'report_generation', code: result.reason_code, retryable: false,
      detail: String(result?.error || '') || null,
      related: refusal?.reason_code ? [knowledge] : [] };
  }
  // If the chain stopped before producing a review, missing media steps are a
  // consequence. Preserve the structured chain refusal rather than masking it.
  const explicitImageRefusal = imageCompletion?.incomplete
    && result?.engine?.image_skill_gate?.ok === false
    && !!imageCompletion.imageEvidenceReason;
  if ((result?.error && code === 'chain_error')
    || (missingReadings && code === 'kb_readings_missing' && !explicitImageRefusal)
    || ((refusal?.reason_code || result?.reason_code)
      && ['claim_busy', 'layer_gate_red', 'layer_audit_red', 'preflight_aborted'].includes(code))) {
    return { ...knowledge, related: [] };
  }
  const related = code === 'review_unavailable' ? [] : [knowledge];
  if (imageCompletion?.incomplete) {
    const workflow = imageCompletion.imageWorkflowGate;
    const semantic = workflow?.semanticReview;
    let imageCode = 'image_workflow_incomplete';
    let retryable = false;
    if (semantic?.code === 'image_claim_source_required') {
      imageCode = 'image_claim_source_required';
    } else if (semantic?.ok === false || workflow?.infantSource?.reason === 'infant_scope_unmeasured') {
      imageCode = 'image_scope_unmeasured';
      // The producer classifies transport vs evidence/protocol failures. Never
      // guess retryability from a Chinese reason or the unrelated KB outcome.
      retryable = semantic?.retryable === true;
    } else if (workflow?.infantSource?.required === true && workflow?.hasAuthoritativeSource === false
      && workflow?.missing?.includes(INFANT_SOURCE_MISSING)) {
      imageCode = 'image_source_required';
    } else if (imageCompletion.imageUnresolvedGate) imageCode = 'image_read_unavailable';
    else if (imageCompletion.sceneFaults?.length) imageCode = 'image_scene_unavailable';
    else if (imageCompletion.imageEvidenceReason) imageCode = 'image_evidence_missing';
    return { stage: 'image_workflow', code: imageCode, retryable,
      detail: imageCompletion.reason || null, related };
  }
  if (videoCompletion?.incomplete) {
    return { stage: 'video_workflow', code: 'video_workflow_incomplete', retryable: false,
      detail: videoCompletion.reason || null, related };
  }
  return { ...knowledge, related: [] };
}

export function shouldRetryReview(result) {
  return result?.meta?.gate?.yes === true && !hasReviewDecision(result)
    && result?.meta?.reviewFailure?.retryable === true;
}

const FAILURE_COPY = Object.freeze({
  layer_gate_red: '知识库的前置检查未通过，审查已暂停。',
  layer_audit_red: '知识库的完整性核查未通过，审查已暂停。',
  claim_busy: '知识库正在处理另一条审查，本轮暂未完成。',
  preflight_aborted: '审查前的准备步骤未完成，本轮已停止。',
  profile_unwritable: '审查服务无法准备运行环境，本轮未能启动。',
  coverage_not_covered: '知识库缺少适用于这条素材的审查依据。',
  evidence_side_refused: '知识库未提供足够的有效依据，暂时无法判断这条素材。',
  kb_readings_missing: '本轮没有取得知识库的核查结果。',
  conclusion_unparsed: '审查结果未能被系统识别，暂时无法给出可靠结论。',
  chain_error: '审查服务本次调用失败，未能完成检查。',
  reply_service_error: '本轮回复生成失败，未能交付审查结果。',
  final_output_token_limit: '生成审查报告时达到输出上限，报告没有交付完整。',
  review_deadline_exceeded: '本轮审查已达到处理时限，尚未形成完整结论。',
  final_report_incomplete: '审查报告仍不完整，暂时无法给出结论。',
  review_unavailable: '本轮审查未能完成，具体原因还需核查。',
  image_scope_unmeasured: '图片是否涉及婴儿安全事实的复核未完成。',
  image_source_required: '图片涉及的婴儿安全事实尚未完成来源核查。',
  image_claim_source_required: '图片中的事实主张缺少对应且适用的依据，核查尚未完成。',
  image_read_unavailable: '本轮未能完整读取图片。',
  image_scene_unavailable: '本轮未取得完整的画面读数。',
  image_evidence_missing: '本轮图片审查未取得完整的执行证据。',
  image_workflow_incomplete: '图片审查还有检查步骤未完成。',
  video_workflow_incomplete: '视频审查还有检查步骤未完成。',
});

export function reviewFailureText(failure) {
  return Object.hasOwn(FAILURE_COPY, failure?.code)
    ? FAILURE_COPY[failure.code] : FAILURE_COPY.review_unavailable;
}

export function replyOptionsForResult(result, { retryStatus = null } = {}) {
  const meta = result?.meta ?? {};
  const reviewOrder = meta.gate?.yes === true;
  const withheld = meta.reviewDecisionWithheld === true || (reviewOrder && !hasReviewDecision(result));
  const verdict53 = withheld ? null : (meta.verdict53 ?? null);
  const noDecision = reviewOrder && !hasReviewDecision(result);
  const code = meta.reviewFailure?.code;
  const failureText = reviewFailureText(meta.reviewFailure);
  const coverageDetail = meta.reviewFailure?.related?.some((failure) => failure.code === 'coverage_not_covered')
    ? '知识库另有适用依据缺口。' : '';
  return {
    verdict53,
    reportLink: withheld ? null : (meta.reportLink ?? null),
    reviewOrder,
    imageReview: reviewOrder && Number(meta.media?.images ?? 0) > 0,
    reviewDecisionWithheld: withheld,
    reviewReason: noDecision
      ? (code ? failureText + coverageDetail : (meta.imageGateReason || failureText))
      : null,
    reviewNextStep: !noDecision ? null
      : retryStatus?.state === 'queued' ? '已进入自动重试队列，暂不需要重复提交。'
        : retryStatus?.state === 'not_queued' ? '本轮未能安排自动重试。请联系维护人员核查。'
          : '本轮未安排自动重试。请联系维护人员核查。',
  };
}

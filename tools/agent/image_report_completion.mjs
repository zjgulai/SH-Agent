/** One completion policy for generation, report recovery and publication. No writes. */
import { checkVisualChecklist,
  restateChecklistEvidence, restatePerPanelSleep } from './visual_checklist.mjs';
import { checkImageWorkflowEvidence } from './image_workflow_evidence.mjs';
import { buildImageClaimEvidence, validateImageClaimAssessment } from './image_claim_review.mjs';
import { withReviewDeadline } from './review_deadline.mjs';

// 「根本没测出来」≠「语义上不同意」：结构非法 / 模型异常 / 输入非法一律硬拦（未测不许放行）。
const HARD_CLAIM_CODES = new Set(['image_claim_review_failed', 'image_claim_model_failed',
  'image_claim_model_incomplete', 'image_claim_input_invalid', 'image_claim_response_invalid']);

async function defaultRunner(input) {
  const { adjudicateImageClaims } = await import('./image_claim_review.mjs');
  return adjudicateImageClaims(input);
}

export async function checkImageReport(reportText, { scenes, materialTexts, sleepPositions = [],
  abnormal = [], sceneFaults = [], sources = [], claimRunner = defaultRunner, cache = new Map(), deadlineAt,
  // ★ 2026-11-03（Owner 批准 ②「回滚到 10-27 口径先恢复」）：逐项语义复核**默认只留痕、不否决整单**。
  //   10-27 验收 = 六章交付 + 4B 表 + 视觉核对 + 素材文字读数；逐项语义复核是 11-03 新加的，
  //   它在真实报告上不可满足（报告自述句被当成素材主张），当天 12 单全挂在它上面。
  //   严格档保留：IMAGE_CLAIM_ENFORCE=1 时恢复「语义缺项即拒收」（用于后续灰度验收）。
  enforceClaimReview = process.env.IMAGE_CLAIM_ENFORCE === '1' } = {}) {
  const ev = restateChecklistEvidence(String(reportText ?? ''), { scenes });
  const panel = restatePerPanelSleep(ev.text, sleepPositions);
  const answer = panel.text;
  const visual = checkVisualChecklist(answer, { sleepPositions, abnormal });
  const delivered = checkImageWorkflowEvidence(answer, { sources });
  // Phrase exemptions and a report-wide AAP flag have no authority here.
  // Source obligations come only from complete current evidence and individual rows.
  const missing = [...delivered.missing,
    ...sceneFaults.map(fault => `画面读数未完整取得：${fault.why ?? '原因未给'}`)];
  if (!Array.isArray(materialTexts) || !materialTexts.length) missing.push('图中文字来源证据未提供');
  else for (const item of materialTexts) {
    if (!['image_ocr', 'visual_text'].includes(item?.origin)
      || !['ok', 'empty'].includes(item?.status) || typeof item?.text !== 'string'
      || (item.status === 'empty' && item.text.trim())
      || (item.status === 'ok' && !item.text.trim())) {
      missing.push(`图 ${item?.image ?? '?'} 图中文字来源未完整读取（${item?.origin ?? '未给来源'}：${item?.status ?? '未测'}）`);
    }
  }
  const claimAdvisory = [];   // 语义复核的内容性缺项：默认只留痕
  const evidence = buildImageClaimEvidence({ reportText: answer, scenes, materialTexts, sources });
  if (!evidence.ok) claimAdvisory.push(evidence.reason);
  let assessment = null;
  if (!missing.length && visual.ok) {
    try {
      if (Number.isFinite(deadlineAt) && Date.now() >= deadlineAt) throw new Error('deadline');
      const input = structuredClone({ reportText: answer, scenes, materialTexts, sources });
      const key = evidence.evidenceHash;
      if (!cache.has(key)) {
        // This cache belongs to one submission. Repaired text, OCR, scene or source
        // changes create another key; no other chat or prior review can supply it.
        if (cache.size >= 8) cache.clear();
        cache.set(key, withReviewDeadline(deadlineAt, () => claimRunner(input)));
      }
      assessment = structuredClone(await cache.get(key));
      if (Number.isFinite(deadlineAt) && Date.now() >= deadlineAt) throw new Error('deadline');
      if (assessment?.ok === true) {
        // A callback's boolean is not a receipt. Rebind its complete decisions to
        // this report and these exact rows/sources, including cached responses.
        assessment = { ...validateImageClaimAssessment({ evidenceHash: assessment.evidenceHash,
          decisions: assessment.wireDecisions, claims: assessment.claims,
          sleepReviews: assessment.sleepReviews }, evidence), ms: assessment.ms };
      }
      // ★ 2026-11-03（A 方案）：宿主补绑必须**看得见**。补绑 = 模型漏抄了宿主已经算好的 C 绑定，
      //   不否决整单，但不能静默 —— 运维要能在日志里数出「这一单补了几处、补在哪几句」。
      if (assessment?.bindingFills?.length) {
        console.log(`[review] 🩹 宿主补绑 ${assessment.bindingFills.length} 处`
          + `（模型漏抄 C 绑定，按宿主口径补回，不否决整单）：`
          + assessment.bindingFills.slice(0, 5)
            .map(fill => `第${fill.ordinal}句+${fill.filledIds.join('、')}`).join('，')
          + (assessment.bindingFills.length > 5 ? ' …' : ''));
      }
      if (assessment?.ok !== true) {
        // 硬缺项：明确婴儿未知、引用不实、睡眠义务、结构非法、模型异常。
        const hard = Array.isArray(assessment?.missing) ? assessment.missing : [];
        if (hard.length) missing.push(...hard);
        // 没有硬缺项、也没有留痕项 ⇒ 这是「没测出来」，仍按未测不放行。
        else if (!assessment?.softMissing?.length) missing.push(assessment?.reason || '图片主张与来源复核未完成');
      }
      // 留痕项：报告自述句被误判成安全主张、安全主张未进 C 清单（覆盖记账）等。
      if (assessment?.softMissing?.length) claimAdvisory.push(...assessment.softMissing);
    } catch {
      // 技术性失败（模型调用异常 / 超时 / 证据构建失败）仍按「未测不许放行」硬拦：
      // 这不是语义分歧，是这一轮根本没测出来。
      assessment = { ok: false, code: 'image_claim_review_failed', missing: [], reason: '图片主张与来源复核未完成' };
      missing.push(assessment.reason);
    }
  }
  if (enforceClaimReview) missing.push(...claimAdvisory);  else if (claimAdvisory.length) {
    console.log(`[review] 📝 逐项核查留痕 ${claimAdvisory.length} 条（10-27 口径：不否决整单）：`
      + claimAdvisory.slice(0, 4).join(' | ') + (claimAdvisory.length > 4 ? ' …' : ''));
  }
  const measured = ['image_claim_complete', 'image_claim_source_required'].includes(assessment?.code)
    && Array.isArray(assessment?.claims);
  const required = measured
    ? assessment.claims.some(claim => ['safety_claim', 'infant_safety_unknown'].includes(claim.kind)) : null;
  const workflow = { ...delivered, sourcePolicy: 'per_claim', semanticReview: assessment,
    claimReview: { enforced: enforceClaimReview, ok: !claimAdvisory.length,
      advisoryCount: claimAdvisory.length, advisory: claimAdvisory.slice(0, 20) },
    infantUncertainties: assessment?.decisions?.filter(item => item.kind === 'infant_safety_unknown') ?? [],
    materialTextEvidence: Array.isArray(materialTexts) ? materialTexts.map(item => ({
      origin: item?.origin, image: item?.image, sha256: item?.sha256, status: item?.status,
    })) : undefined,
    infantSource: { required, origin: 'claim_review',
      reason: assessment?.reason || (assessment?.ok ? 'current_claims_reviewed' : 'unmeasured'),
      evidenceHash: assessment?.evidenceHash ?? null },
    missing, ok: !missing.length,
    reason: missing.length ? `图片安全审查 skill 全流程缺项：${missing.join('；')}` : '' };
  return { answer, workflow, visual, ok: workflow.ok && visual.ok,
    restated: { checklist: ev.added, panels: panel.added },
    missing: [...missing, ...(visual.ok ? [] : [visual.reason || '视觉核对清单未通过'])] };
}

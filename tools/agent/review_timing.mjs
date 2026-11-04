/** Final review delivery SLO. The receipt and an incomplete alert are not a
 * completed review. Retry attempts retain the original message creation time. */
import { conforms } from './prd53.mjs';

export const REVIEW_LIMIT_MS = 180000;

export function measureReviewDelivery({ ingress, sentAt, sent, verdict53,
  reviewDecisionWithheld = false } = {}) {
  const checked = conforms(verdict53?.line);
  const completed = !reviewDecisionWithheld && checked.ok && checked.state === verdict53?.state;
  const elapsedMs = Number.isFinite(ingress?.at) && Number.isFinite(sentAt)
    ? sentAt - ingress.at : null;
  const measured = ingress?.origin === 'create_time' && elapsedMs !== null && elapsedMs >= 0;
  const delivered = sent?.ok === true;
  const reason = !measured ? 'creation_time_unverified' : !delivered ? 'send_failed'
    : !completed ? 'review_incomplete' : elapsedMs > REVIEW_LIMIT_MS ? 'deadline_exceeded' : 'complete';
  return { elapsedMs, limitMs: REVIEW_LIMIT_MS, completed, delivered,
    verdict: !measured ? 'UNTESTED' : reason === 'complete' ? 'pass' : 'FAIL', reason,
    ingress: ingress?.origin ?? 'unknown', startedAt: ingress?.at ?? null, sentAt };
}

const token = (value) => encodeURIComponent(String(value ?? '-'));
export function deliveryMetricLine(timing, { messageId, chatId, source } = {}) {
  return `[metric] review_delivery_ms=${timing.elapsedMs ?? 'unknown'} prd_limit_ms=${timing.limitMs}`
    + ` verdict=${timing.verdict} reason=${timing.reason} completed=${timing.completed ? 'yes' : 'no'}`
    + ` ingress=${timing.ingress} sent=${timing.delivered ? 'ok' : 'fail'}`
    + ` started_at_ms=${timing.startedAt ?? 'unknown'} sent_at_ms=${timing.sentAt ?? 'unknown'}`
    + ` message=${token(messageId)} chat=${token(chatId)} source=${token(source)}`;
}

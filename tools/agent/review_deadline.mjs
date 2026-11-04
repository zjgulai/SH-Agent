import { AsyncLocalStorage } from 'node:async_hooks';

const deadlines = new AsyncLocalStorage();
export const REVIEW_SEND_RESERVE_MS = 5000;
export const reviewDeadlineAt = () => deadlines.getStore()?.at ?? null;
const currentTime = () => (deadlines.getStore()?.now ?? Date.now)();
export const reviewDeadlineExpired = () => reviewDeadlineAt() !== null && currentTime() >= reviewDeadlineAt();
export function reviewDeadlineError() {
  return Object.assign(new Error('图片审查时间预算已用尽，停止后续请求。'), {
    code: 'REVIEW_DEADLINE_EXCEEDED', name: 'ReviewDeadlineError', timedOut: true,
  });
}
export function remainingReviewTimeout(cap = Infinity) {
  const at = reviewDeadlineAt();
  if (at === null) return cap;
  const remaining = at - currentTime();
  if (remaining <= 0) throw reviewDeadlineError();
  return Math.max(1, Math.floor(Math.min(cap > 0 ? cap : Infinity, remaining)));
}
export async function withReviewDeadline(at, task, { now } = {}) {
  if (!Number.isFinite(at)) return task();
  const parent = deadlines.getStore();
  return deadlines.run({ at: Math.min(at, parent?.at ?? Infinity), now: now ?? parent?.now ?? Date.now }, async () => {
    remainingReviewTimeout();
    return task();
  });
}
export async function sleepWithinReviewDeadline(ms) {
  if (ms <= 0) { remainingReviewTimeout(); return; }
  const wait = remainingReviewTimeout(ms);
  await new Promise(resolve => setTimeout(resolve, wait));
  if (reviewDeadlineExpired()) throw reviewDeadlineError();
}

/** The installed Lark SDK routes business and token calls through .request.
 * Keep the existing Axios instance/interceptors and abort its real request. */
export function deadlineHttpInstance(base) {
  const request = async (options, extra) => {
    if (reviewDeadlineAt() === null) return base.request(options, extra);
    const config = typeof options === 'string' ? { ...extra, url: options } : { ...options };
    const timeout = remainingReviewTimeout(config.timeout);
    const controller = new AbortController();
    const prior = config.signal;
    const abortFromPrior = () => controller.abort(prior?.reason);
    if (prior?.aborted) abortFromPrior();
    else prior?.addEventListener('abort', abortFromPrior, { once: true });
    let fired = false;
    const timer = setTimeout(() => { fired = true; controller.abort(); }, timeout);
    try { return await base.request({ ...config, timeout, signal: controller.signal }); }
    catch (error) {
      if (fired || reviewDeadlineExpired()) throw reviewDeadlineError();
      throw error;
    } finally {
      clearTimeout(timer);
      prior?.removeEventListener('abort', abortFromPrior);
    }
  };
  return new Proxy(base, {
    get(target, key, receiver) { return key === 'request' ? request : Reflect.get(target, key, receiver); },
    apply(_target, _thisArg, args) { return request(...args); },
  });
}

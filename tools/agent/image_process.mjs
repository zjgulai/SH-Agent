import { execFile } from 'node:child_process';

/** DSH handles SIGTERM by exiting 0. Track the deadline ourselves so that a
 * graceful shutdown cannot turn an interrupted review into a normal exit. */
export function execImageProcess(file, args, options = {}) {
  const { timeout = 0, terminationGraceMs = 1000, ...childOptions } = options;
  if (!Number.isFinite(timeout) || timeout < 0
    || !Number.isFinite(terminationGraceMs) || terminationGraceMs < 0) {
    return Promise.reject(new RangeError('Image process deadline must be nonnegative and finite'));
  }
  return new Promise((resolve, reject) => {
    let deadlineTimer, killTimer, timedOut = false;
    const child = execFile(file, args, { ...childOptions, timeout: 0 }, (error, stdout, stderr) => {
      clearTimeout(deadlineTimer);
      clearTimeout(killTimer);
      if (timedOut) {
        const expired = Object.assign(error ?? new Error('Image process deadline exceeded'), {
          code: 'ETIMEDOUT', timedOut: true, stdout, stderr,
        });
        reject(expired);
      } else if (error) reject(Object.assign(error, { stdout, stderr, timedOut: false }));
      else resolve({ stdout, stderr, timedOut: false });
    });
    if (timeout > 0) deadlineTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, terminationGraceMs);
      killTimer.unref();
    }, timeout);
  });
}

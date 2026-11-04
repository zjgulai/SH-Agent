import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execImageProcess } from './image_process.mjs';

await test('SIGTERM followed by exit 0 is still an explicit timeout and retains output', async () => {
  await assert.rejects(execImageProcess(process.execPath, ['-e', `
    process.on('SIGTERM', () => { process.stdout.write('completed-engine\\n'); process.exit(0); });
    process.stdout.write('session-current\\n');
    setInterval(() => {}, 1000);
  `], { timeout: 500 }), error => {
    assert.equal(error.timedOut, true);
    assert.equal(error.code, 'ETIMEDOUT');
    assert.match(error.stdout, /session-current/);
    assert.match(error.stdout, /completed-engine/);
    return true;
  });
});

await test('a normal exit before the deadline is not a timeout', async () => {
  const result = await execImageProcess(process.execPath, ['-e', "process.stdout.write('done')"], { timeout: 1000 });
  assert.equal(result.stdout, 'done');
  assert.notEqual(result.timedOut, true);
});

await test('a real process error is retained separately from the deadline', async () => {
  await assert.rejects(execImageProcess(process.execPath, ['-e', "process.stderr.write('invalid input'); process.exit(2)"],
    { timeout: 1000 }), error => {
    assert.equal(error.code, 2);
    assert.notEqual(error.timedOut, true);
    assert.equal(error.stderr, 'invalid input');
    return true;
  });
});

await test('a child that ignores SIGTERM is forcibly reaped after the bounded grace period', async () => {
  const start = Date.now();
  await assert.rejects(execImageProcess(process.execPath, ['-e', `
    process.on('SIGTERM', () => {});
    process.stdout.write('ready');
    setInterval(() => {}, 1000);
  `], { timeout: 500, terminationGraceMs: 100 }), error => {
    assert.equal(error.timedOut, true);
    assert.equal(error.signal, 'SIGKILL');
    assert.match(error.stdout, /ready/);
    assert.ok(Date.now() - start < 3000);
    return true;
  });
});

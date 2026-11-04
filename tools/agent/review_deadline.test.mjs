import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { withReviewDeadline, remainingReviewTimeout, reviewDeadlineAt, sleepWithinReviewDeadline } from './review_deadline.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-deadline-'));
const read = fs.readFileSync;
fs.readFileSync = function(file, ...args) {
  const p = String(file);
  if (p.endsWith('/.dsh/credentials/shouheng-lark.json')) return JSON.stringify({ app_id: 'fixture', app_secret: 'fixture' });
  if (p.endsWith('/.dsh/.credentials.yaml')) return '';
  if (p.endsWith('/.config/opencode/opencode.json')) return '{}';
  return read.call(this, file, ...args);
};
Object.assign(process.env, { SHOUHENG_STATE_DIR: tmp, SHOUHENG_LLM_API_KEY: 'fixture',
  SHOUHENG_LLM_BASE_URL: 'http://127.0.0.1:9', SHOUHENG_LLM_FAILURES: path.join(tmp, 'failures.ndjson'),
  SHOUHENG_PERM_BACKOFF_MS: '0', SHOUHENG_MEDIA_LINK_CACHE: path.join(tmp, 'cache.json') });
try {
  const llm = await import('./llm.mjs');
  const feishu = await import('./feishu.mjs');
  const publish = await import('./review_publish.mjs');
  const media = await import('./media_link.mjs');
  const Lark = await import('@larksuiteoapi/node-sdk');
  await test('image deadlines are isolated across concurrent turns and nested budgets cannot extend them', async () => {
    const readAt = async (at) => withReviewDeadline(at, async () => {
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(reviewDeadlineAt(), at);
      return withReviewDeadline(at + 1000, () => reviewDeadlineAt(), { now: () => 0 });
    }, { now: () => 0 });
    assert.deepEqual(await Promise.all([readAt(100), readAt(200)]), [100, 200]);
    assert.equal(reviewDeadlineAt(), null);
    assert.equal(remainingReviewTimeout(30000), 30000);
  });
  await test('an expired stage never invokes its callback and retry sleep stops at the same deadline', async () => {
    let called = false;
    await assert.rejects(withReviewDeadline(10, () => { called = true; }, { now: () => 10 }), { code: 'REVIEW_DEADLINE_EXCEEDED' });
    assert.equal(called, false);
    const start = Date.now();
    await assert.rejects(withReviewDeadline(start + 35, () => sleepWithinReviewDeadline(1000)), { code: 'REVIEW_DEADLINE_EXCEEDED' });
    assert.ok(Date.now() - start < 300);
  });
  await test('zero retry delay remains immediate inside an image deadline', async () => {
    const start = Date.now();
    await withReviewDeadline(start + 1000, () => sleepWithinReviewDeadline(0));
    assert.ok(Date.now() - start < 100);
  });
  await test('real LLM HTTP work is aborted within the shared deadline and is not retried', async () => {
    let requests = 0, closed = false;
    const server = http.createServer((req, res) => {
      requests++; res.on('close', () => { closed = true; });
      setTimeout(() => { if (!res.destroyed) { res.writeHead(200); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'late' } }] })); } }, 250);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const start = Date.now();
      const result = await withReviewDeadline(start + 80, () => llm.chat([{ role: 'user', content: 'fixture' }], {
        baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'fixture', timeoutMs: 2000 }));
      assert.equal(result.ok, false);
      assert.equal(result.retryable, false);
      assert.ok(Date.now() - start < 220);
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(requests, 1); assert.equal(closed, true);
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  });
  await test('the production Lark SDK transport aborts the HTTP request and no later request can start', async () => {
    let requests = 0, closed = false;
    const server = http.createServer((req, res) => {
      requests++; res.on('close', () => { closed = true; });
      setTimeout(() => { if (!res.destroyed) res.end('{"code":0}'); }, 250);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const start = Date.now();
      await withReviewDeadline(start + 80, async () => {
        feishu.client.domain = `http://127.0.0.1:${server.address().port}`;
        const call = () => feishu.client.request({ method: 'GET', url: `${feishu.client.domain}/fixture` }, Lark.withUserAccessToken('fixture'));
        await assert.rejects(call(), { code: 'REVIEW_DEADLINE_EXCEEDED' });
        await assert.rejects(call(), { code: 'REVIEW_DEADLINE_EXCEEDED' });
      });
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.ok(Date.now() - start < 220);
      assert.equal(requests, 1); assert.equal(closed, true);
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  });
  await test('permission writes and readback share one deadline rather than resetting the CLI timeout', async () => {
    let now = 0, calls = 0;
    const result = await withReviewDeadline(100, () => publish.ensureTenantReadable('fixture', { run: async (_bin, _args, opts) => {
      calls++; assert.ok(opts.timeout <= 100); now = 100;
      return { stdout: '{"data":{"permission_public":{"link_share_entity":"tenant_readable"}}}' };
    } }), { now: () => now });
    assert.equal(result.ok, false); assert.equal(calls, 1);
  });
  await test('media upload cannot create a folder after its listing consumed the deadline', async () => {
    let now = 0, calls = 0;
    const result = await withReviewDeadline(100, () => media.ensureMonthFolder('2099-01', { deps: {
      cacheFile: path.join(tmp, 'empty-cache.json'), exec: async (_args, opts) => {
        calls++; assert.ok(opts.timeout <= 100); now = 100; return { stdout: '{"data":{"items":[]}}' };
      },
    } }), { now: () => now });
    assert.equal(result.ok, false); assert.equal(calls, 1);
  });
} finally { fs.readFileSync = read; fs.rmSync(tmp, { recursive: true, force: true }); }

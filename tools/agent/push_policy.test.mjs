import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TEST_CHAT = 'oc_TEST_GROUP';
const OTHER_CHAT = 'oc_other_group';
const policy = await import('./push_policy.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const source = fs.readFileSync(new URL('../ws_daemon.mjs', import.meta.url), 'utf8');
const external = source.slice(source.indexOf('async function externalWatch('),
  source.indexOf('\n/**', source.indexOf('async function externalWatch(')));
const sender = source.slice(source.indexOf('async function safeSend('),
  source.indexOf('\n/**', source.indexOf('async function safeSend(')));

function fixture({ failed = false, missingPolicy = false } = {}) {
  const sends = [], records = [], logs = [];
  let checks = 0, recentWrites = 0, recentReads = 0;
  const sandbox = {
    SCHEDULED_PUSH: true,
    scheduledPushTarget: missingPolicy ? () => { throw new Error('push policy unavailable'); }
      : policy.scheduledPushTarget,
    assertScheduledPushTarget: policy.assertScheduledPushTarget,
    checkExternal: async () => { checks++; return { code: 0, verdict: 'drift', why: 'changed', say: '来源页面变了' }; },
    saveChatId: () => { recentWrites++; },
    resolveChat: async () => { recentReads++; return OTHER_CHAT; },
    feishu: { sendMarkdown: async (chat, text) => {
      sends.push({ chat, text });
      return failed ? { ok: false, error: 'send failed' } : { ok: true, messageId: 'om_fixture' };
    } },
    plainify: text => text,
    recordOutbound: (chat, sent, detail) => records.push({ chat, sent, detail }),
    log: (...args) => logs.push(args.join(' ')),
  };
  vm.createContext(sandbox);
  vm.runInContext(`${external}\n${sender}\nglobalThis.watch = externalWatch; globalThis.send = safeSend;`, sandbox);
  return { sandbox, sends, records, logs, counts: () => ({ checks, recentWrites, recentReads }) };
}

await test('external startup, daily and deferred pushes ignore the last active conversation', async () => {
  for (const reason of ['startup', 'daily', 'deferred']) {
    const f = fixture();
    await f.sandbox.watch(reason);
    assert.deepEqual(f.sends.map(s => s.chat), [TEST_CHAT], reason);
    assert.deepEqual(f.counts(), { checks: 1, recentWrites: 0, recentReads: 0 });
  }
});
await test('an explicit foreign chat cannot redirect external pushes or overwrite recent chat', async () => {
  const f = fixture();
  await f.sandbox.watch('daily', OTHER_CHAT);
  assert.deepEqual(f.sends.map(s => s.chat), [TEST_CHAT]);
  assert.equal(f.counts().recentWrites, 0);
});
await test('the final sender blocks foreign and empty scheduled-push targets before any network call', async () => {
  for (const source of ['proactive-external', 'proactive-baseline', 'proactive-pending']) {
    for (const chat of [OTHER_CHAT, '', null, 'oc_TEST_P2P']) {
      const f = fixture();
      const result = await f.sandbox.send(chat, '来源页面变了', source);
      assert.equal(f.sends.length, 0, `${source} ${chat}`);
      assert.equal(result?.ok, false, `${source} ${chat}`);
      assert.match(f.logs.join('\n'), /拒绝|不允许/, `${source} ${chat}`);
    }
  }
});
await test('the allowed scheduled target still sends and records the actual destination', async () => {
  for (const source of ['proactive-external', 'proactive-baseline', 'proactive-pending']) {
    const f = fixture();
    await f.sandbox.send(TEST_CHAT, '来源页面变了', source);
    assert.deepEqual(f.sends.map(s => s.chat), [TEST_CHAT], source);
    assert.equal(f.records[0].chat, TEST_CHAT, source);
  }
});
await test('baseline and pending scheduled pushes use only the fixed policy target', () => {
  for (const name of ['baselineWatch', 'pendingWatch']) {
    const start = source.indexOf(`async function ${name}(`);
    const end = source.indexOf('\n/**', start);
    const body = source.slice(start, end);
    // 直接钉两条实际赋值：`target`（跑检查前）与 `to`（发送前）都只能来自策略文件。
    assert.match(body, /const target = scheduledPushTarget\(\)/, name);
    assert.match(body, /const to = scheduledPushTarget\(\)/, name);
  }
});
await test('unrelated direct replies keep their original target', async () => {
  const f = fixture();
  await f.sandbox.send(OTHER_CHAT, '你的问题已收到', 'error-fallback');
  assert.deepEqual(f.sends.map(s => s.chat), [OTHER_CHAT]);
});
await test('a failed send must not be logged as delivered', async () => {
  const f = fixture({ failed: true });
  await f.sandbox.watch('daily');
  assert.equal(f.sends.length, 1);
  assert.doesNotMatch(f.logs.join('\n'), /告警已发到/);
  assert.match(f.logs.join('\n'), /未发出/);
  assert.equal(f.records[0].sent.ok, false);
});
await test('missing policy stops before consuming the notification deduplication state', async () => {
  const f = fixture({ missingPolicy: true });
  await f.sandbox.watch('daily');
  assert.equal(f.counts().checks, 0);
  assert.equal(f.sends.length, 0);
});
await test('the committed policy names the verified test group', () => {
  const saved = JSON.parse(fs.readFileSync(new URL('../push-policy.json', import.meta.url), 'utf8'));
  assert.deepEqual(saved, { version: 1, chat_id: TEST_CHAT, chat_name: '内容治理-守衡Agent-测试' });
});
await test('the real policy reader rejects missing, malformed and invalid configuration', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shouheng-push-policy-'));
  try {
    fs.mkdirSync(path.join(dir, 'agent'));
    fs.copyFileSync(new URL('./push_policy.mjs', import.meta.url), path.join(dir, 'agent/push_policy.mjs'));
    const isolated = await import(pathToFileURL(path.join(dir, 'agent/push_policy.mjs')));
    assert.throws(() => isolated.scheduledPushTarget());
    for (const raw of ['{', '{}', 'null', JSON.stringify({ version: 2, chat_id: TEST_CHAT, chat_name: '内容治理-守衡Agent-测试' }),
      JSON.stringify({ version: 1, chat_id: '', chat_name: '内容治理-守衡Agent-测试' }),
      JSON.stringify({ version: 1, chat_id: 'oc_TEST_P2P', chat_name: '内容治理-守衡Agent-测试' }),
      JSON.stringify({ version: 1, chat_id: 'oc_' + 'a'.repeat(32), chat_name: '内容治理-守衡Agent-测试' }),
      JSON.stringify({ version: 1, chat_id: TEST_CHAT, chat_name: '其他群' })]) {
      fs.writeFileSync(path.join(dir, 'push-policy.json'), raw);
      assert.throws(() => isolated.scheduledPushTarget(), raw);
    }
    fs.copyFileSync(new URL('../push-policy.json', import.meta.url), path.join(dir, 'push-policy.json'));
    assert.equal(isolated.scheduledPushTarget(), TEST_CHAT);
    assert.throws(() => isolated.assertScheduledPushTarget(OTHER_CHAT), /拒绝/);
    assert.doesNotThrow(() => isolated.assertScheduledPushTarget(TEST_CHAT));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

#!/usr/bin/env node
// Original incident plus the real delivery path. All external boundaries are
// fixtures; a successful read must not trigger any review, model or business write.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import vm from 'node:vm';
import * as reviewTiming from './review_timing.mjs';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-link-access-'));
const originals = { read: fs.readFileSync, write: fs.writeFileSync, fetch: globalThis.fetch,
  connect: net.Socket.prototype.connect, env: { ...process.env } };
Object.assign(process.env, {
  SHOUHENG_STATE_DIR: tmp, SHOUHENG_KB_ROOT: path.join(tmp, 'absent-kb'),
  SHOUHENG_LLM_API_KEY: 'fixture-only', SHOUHENG_LLM_BASE_URL: 'http://127.0.0.1:9',
  SHOUHENG_REVIEW_TABLE: 'off', SHOUHENG_MEDIA_LINK: 'off', SHOUHENG_MERGED_RECORD: 'off',
  SHOUHENG_ALLOWED_CHATS: '', KB_CONF_LEDGER: path.join(tmp, 'confidence.ndjson'),
  SHOUHENG_IDENTITY_REJECT_LOG: path.join(tmp, 'identity.ndjson'),
  SHOUHENG_OUTBOUND_LEDGER: path.join(tmp, 'outbound.jsonl'),
  SHOUHENG_SEND_TRACE: path.join(tmp, 'sends.jsonl'),
  SHOUHENG_LLM_FAILURES: path.join(tmp, 'llm-failures.jsonl'),
});
const counter = fileURLToPath(new URL('../../PMO/shouheng-state/chains-in-flight.json', import.meta.url));
const redirected = (file) => path.resolve(String(file)) === counter ? path.join(tmp, 'chains-in-flight.json') : file;
fs.readFileSync = function (file, ...args) {
  const p = String(file);
  if (p.endsWith('/.dsh/credentials/shouheng-lark.json')) return JSON.stringify({ app_id: 'cli_link_test', app_secret: 'fixture' });
  if (p.endsWith('/.config/opencode/opencode.json')) return '{}';
  if (p.endsWith('/.dsh/.credentials.yaml')) throw new Error('No real credentials in this test');
  return originals.read.call(this, redirected(file), ...args);
};
fs.writeFileSync = function (file, ...args) { return originals.write.call(this, redirected(file), ...args); };
let network = 0;
net.Socket.prototype.connect = function () { network++; throw new Error('No network in link-access test'); };
let modelCalls = 0;
globalThis.fetch = async () => {
  modelCalls++;
  return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop',
    message: { role: 'assistant', content: 'fixture general answer' } }] }), { status: 200 });
};

try {
  const { handleMessage, flushSeen } = await import('./agent.mjs');
  const { replyOptionsForResult, shouldRetryReview } = await import('./review_feedback.mjs');
  const { toCardOrText } = await import('../reply-cards/envelope.mjs');
  const { deriveVerdictLine } = await import('./prd53.mjs');
  const { plainify } = await import('./plain.mjs');
  const { FeishuLinkError, readFeishuLink } = await import('./feishu_link.mjs');
  const LINK_URL = 'https://momcozy-in.feishu.cn/wiki/FzAdwjTWdiUcEOkRI0gcjEeknJb?table=tblHY683L5qrXgHI&view=vewgbmVI9X';
  let serial = 0;
  const readOk = async (url) => ({ url, title: '守衡-项目管理', contentType: 'feishu/bitable',
    text: '【数据表：需求｜本页 1 条】\n1. 标题：链接读取确认' });
  const run = async (text, reader = readOk, options = {}) => {
    const calls = { read: 0, ack: 0, chain: 0, model: 0, row: 0, report: 0, advice: 0 };
    const before = modelCalls;
    const event = { sender: {}, message: {
      message_id: `om_link_access_${++serial}`, chat_id: 'oc_link_access_test', chat_type: 'p2p',
      message_type: 'text', content: JSON.stringify({ text }),
      ...options.message,
    } };
    const result = await handleMessage(event, {
      force: options.force ?? false,
      notify: async () => { calls.ack++; },
      linkReader: async (url) => { calls.read++; return reader(url); },
      chainRunner: async () => { calls.chain++; return { error: 'fixture review failure' }; },
      modelSideRunner: async () => { calls.model++; return { ok: true, findings: [], ms: 1 }; },
      publishRunner: async () => { calls.row++; return { ok: false, action: 'skipped' }; },
      mergedReportRunner: async () => { calls.report++; return { ok: false }; },
      adviceRunner: async () => { calls.advice++; return { ok: true, advice: {} }; },
    });
    return { result, calls, modelCalls: modelCalls - before, event };
  };
  const assertReadOnly = ({ result, calls, modelCalls: models }, reads = 1) => {
    assert.equal(result.meta?.gate?.yes, false);
    assert.deepEqual(calls, { read: reads, ack: 0, chain: 0, model: 0, row: 0, report: 0, advice: 0 });
    assert.equal(models, 0, 'read-only must not reach ordinary LLM or memory summarization');
    assert.equal(result.meta?.verdict53, null);
    assert.equal(shouldRetryReview(result), false);
    assert.doesNotMatch(result.reply, /完整审核正在运行|审查未完成|审查结论|fixture general answer/);
  };

  await test('original input returns observed readability, with no review or model side effects', async () => {
    const r = await run(`${LINK_URL} 你可以读取这个文档吗？`);
    assertReadOnly(r);
    assert.match(r.result.reply, /守衡-项目管理/);
    assert.match(r.result.reply, /读到/);
    assert.match(r.result.reply, /指定.*视图.*(?:未|不)|(?:未|不).*指定.*视图/);
    assert.doesNotMatch(r.result.reply, /完整读取|全文已读取/);
  });
  await test('permission error survives actual daemon onMessage and replyTo, without review alert or retry', async () => {
    const r = await run(`${LINK_URL} 你可以读取这个文档吗？`, async () => {
      throw new FeishuLinkError({ kind: 'wiki', title: '守衡-项目管理',
        detail: 'code=131006 permission denied: node permission denied, tenant needs read permission.',
        reply: 'old review-specific reply' });
    });
    assertReadOnly(r);
    const source = fs.readFileSync(new URL('../ws_daemon.mjs', import.meta.url), 'utf8');
    const incoming = source.slice(source.indexOf('function ingressMsOf('), source.indexOf('\n/**\n * 补发队列'));
    const start = source.indexOf('async function replyTo(');
    const sender = source.slice(start, source.indexOf('\n/**\n * 主动发送', start));
    const sent = [];
    let queued = 0;
    const sandbox = {
      reviewDeadline: await import('./review_deadline.mjs'),
      reviewTiming, counters: { events: 0, handled: 0, replied: 0, failed: 0 }, DUMP_ONLY: false,
      dumpRaw() {}, log() {}, saveChatId() {}, LARK_DOC_RE: /never-matches-fixture/,
      handleMessage: async () => r.result, mediaWithoutChain: () => null,
      replyOptionsForResult, shouldRetryReview, deriveVerdictLine, toCardOrText, plainify,
      shapeOf: () => 'fixture', dumpDropped() {}, recordOutbound() {},
      retryQueue: { itemFromEvent: () => ({}), enqueue: () => { queued++; return { ok: true }; } },
      feishu: { bodyToText: () => ({ text: 'fixture' }), imageKeysOf: () => [],
        replyCard: async (_id, card) => { sent.push(JSON.stringify(card)); return { ok: true, messageId: 'om_sent', mode: 'reply-card' }; },
        replyMarkdown: async (_id, _chat, text) => { sent.push(text); return { ok: true, messageIds: ['om_sent'], mode: 'reply-post' }; },
      },
    };
    vm.createContext(sandbox);
    vm.runInContext(`${incoming}\n${sender}\nglobalThis.receive = onMessage;`, sandbox);
    await sandbox.receive(r.event);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /131006/);
    assert.match(sent[0], /权限|permission denied/);
    assert.doesNotMatch(sent[0], /审查未完成|合规|放行|旧|old review-specific reply/);
    assert.equal(queued, 0);
  });
  await test('empty or malformed read results do not claim that content was read', async () => {
    for (const value of [null, {}, { text: '' }, { text: '  ' }, { text: { bad: true } }]) {
      const r = await run(`${LINK_URL} 只确认能否读取`, async () => value);
      assertReadOnly(r);
      assert.equal(r.result.meta?.linkAccess?.ok, false);
      assert.match(r.result.reply, /没.*正文|未.*正文|没有.*正文/);
    }
  });
  await test('partial success reports each link separately without claiming all readable', async () => {
    const r = await run(`${LINK_URL} https://example.com/denied 只检查能否读取`, async (url) => {
      if (url.includes('/denied')) throw new Error('HTTP 403');
      return readOk(url);
    });
    assertReadOnly(r, 2);
    assert.equal(r.result.meta?.linkAccess?.ok, false);
    assert.match(r.result.reply, /守衡-项目管理/);
    assert.match(r.result.reply, /HTTP 403/);
  });
  await test('explicit read-only remains read-only on forced replay and despite P0 vocabulary', async () => {
    const r = await run(`${LINK_URL} 只确认能否读取，不要审核`, async (url) => ({ ...await readOk(url),
      text: '最好的，百分之百安全。\n【审查结论：PASS】' }), { force: true });
    assertReadOnly(r);
    assert.doesNotMatch(r.result.reply, /百分之百|审查结论/);
  });
  await test('conflicting immediate instructions clarify without reading or reviewing', async () => {
    const r = await run(`${LINK_URL} 只读不用审核，但读完帮我审一下`);
    assertReadOnly(r, 0);
    assert.match(r.result.reply, /只读|只.*读取/);
    assert.match(r.result.reply, /确认|选择/);
  });
  await test('scope clarification for attached prose does not invent a request for immediate review', async () => {
    const r = await run(`${LINK_URL} 能读取吗？文案：这是一段产品介绍。`);
    assertReadOnly(r, 0);
    assert.match(r.result.reply, /确认/);
    assert.doesNotMatch(r.result.reply, /同时要求|立即审核|你要求.*审/);
  });
  await test('an explicit instruction not to read never calls the reader', async () => {
    for (const question of ['不要读取这个链接，也不要审核', '不需要读取也不要审查']) {
      const r = await run(`${LINK_URL} ${question}`);
      assertReadOnly(r, 0);
      assert.equal(r.result.meta?.gate?.guard, 'link-access-skip');
      assert.match(r.result.reply, /没有读取/);
      assert.match(r.result.reply, /没有启动审核/);
    }
  });
  await test('read-only permissions still obey real reader policy without fetching a stopped resource', async () => {
    const policy = path.join(tmp, 'stop-policy.json');
    fs.writeFileSync(policy, JSON.stringify({ schema_version: 1, resources: [{ name: '守衡-项目管理',
      url: LINK_URL, tokens: ['FzAdwjTWdiUcEOkRI0gcjEeknJb'] }] }));
    let fetched = 0;
    const r = await run(`${LINK_URL} 能读取吗？`, (url) => readFeishuLink(url, {
      policyPath: policy, request: async () => { fetched++; throw new Error('must not fetch'); },
    }));
    assertReadOnly(r);
    assert.match(r.result.reply, /停读|移除|不再读取/);
    assert.equal(fetched, 0);
  });
  await test('attachment rejection keeps its actual cause without review language', async () => {
    const r = await run('https://momcozy-in.feishu.cn/file/AbcDefgh12345 能读取吗？', async () => {
      throw new FeishuLinkError({ kind: 'file', title: 'brief.pdf', detail: '附件按红线不取', reply: 'unused' });
    });
    assertReadOnly(r);
    assert.match(r.result.reply, /brief.pdf/);
    assert.match(r.result.reply, /附件按红线不取/);
    assert.doesNotMatch(r.result.reply, /申请权限|无法审核|判为通过/);
  });
  await test('group without mention is ignored, addressed rich text receives read-only reply', async () => {
    const ignored = await run(`${LINK_URL} 能读取吗？`, readOk, { message: { chat_type: 'group' } });
    assert.equal(ignored.result.reason, 'not_mentioned');
    assert.equal(ignored.calls.read, 0);
    const r = await run('', readOk, { message: { message_type: 'post', content: JSON.stringify({
      zh_cn: { title: '', content: [[{ tag: 'a', text: '守衡-项目管理', href: LINK_URL },
        { tag: 'text', text: '你可以读取这个文档吗？' }]] },
    }) } });
    assertReadOnly(r);
    const mem = await import('./memory.mjs');
    const session = mem.load(mem.sessionKey({ chatId: 'oc_link_access_test', chatType: 'group', senderOpenId: '' }));
    mem.setTitle(session, 'fixture group');
    mem.save(session);
    const group = await run(`@_user_1 ${LINK_URL} 你可以读取这个文档吗？`, readOk, { message: {
      chat_type: 'group', mentions: [{ key: '@_user_1', name: '守衡', id: { open_id: 'cli_link_test' } }],
    } });
    assertReadOnly(group);
  });
  await test('link count cap refuses the whole read instead of implying unchecked links were read', async () => {
    const links = Array.from({ length: 4 }, (_, i) => `https://example.com/doc${i}`).join(' ');
    const r = await run(`${links} 只确认能否读取`);
    assertReadOnly(r, 0);
    assert.equal(r.result.meta?.linkAccess?.ok, false);
    assert.match(r.result.reply, /本次还没有读取/);
  });
  await test('bare link and mixed affirmative requests still enter link review', async () => {
    for (const question of ['', '你读一下', '请审核这个文档', '能读取吗？读到后帮我审核']) {
      const r = await run(`${LINK_URL} ${question}`, async () => { throw new Error('fixture read failure'); });
      assert.equal(r.result.meta?.gate?.yes, true, question);
      assert.equal(r.result.meta?.gate?.kind, 'link', question);
      assert.equal(r.calls.ack, 1, question);
      assert.equal(r.calls.read, 1, question);
    }
  });
  await test('no live network was attempted', () => assert.equal(network, 0));
  flushSeen();
} finally {
  fs.readFileSync = originals.read;
  fs.writeFileSync = originals.write;
  globalThis.fetch = originals.fetch;
  net.Socket.prototype.connect = originals.connect;
  for (const key of Object.keys(process.env)) if (!(key in originals.env)) delete process.env[key];
  Object.assign(process.env, originals.env);
  fs.rmSync(tmp, { recursive: true, force: true });
}

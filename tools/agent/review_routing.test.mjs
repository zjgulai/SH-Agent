#!/usr/bin/env node
/**
 * Offline source routing: real handleMessage -> gate -> ensureReviewRow ->
 * lark_write, including its readback and temporary write ledger. Only external
 * boundaries are replaced. No credentials, real state, or network are used.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-review-routing-'));
const originalRead = fs.readFileSync;
const originalFetch = globalThis.fetch;
const originalConnect = net.Socket.prototype.connect;
const originalEnv = { ...process.env };
const ledgerPath = path.join(tmp, 'lark-writes.jsonl');
Object.assign(process.env, {
  SHOUHENG_STATE_DIR: tmp, SHOUHENG_KB_ROOT: path.join(tmp, 'absent-kb'),
  SHOUHENG_LLM_API_KEY: 'fixture-only', SHOUHENG_LLM_BASE_URL: 'http://127.0.0.1:9',
  SHOUHENG_VISION_BASE_URL: 'http://127.0.0.1:9', SHOUHENG_VISION_API_KEY: 'fixture-only',
  SHOUHENG_REVIEW_TABLE: '', SHOUHENG_MEDIA_LINK: 'off', SHOUHENG_MERGED_RECORD: 'off',
  SH_FORCE_REPORT: '0', SHOUHENG_ALLOWED_CHATS: '', SHOUHENG_REQUIRE_MENTION: '0',
  SHOUHENG_REVIEW_DIRECT_REPLY: '1', SHOUHENG_LARK_WRITES: ledgerPath,
  SHOUHENG_IDENTITY_REJECT_LOG: path.join(tmp, 'identity.ndjson'),
  SHOUHENG_OUTBOUND_LEDGER: path.join(tmp, 'outbound.jsonl'),
  SHOUHENG_SEND_TRACE: path.join(tmp, 'sends.jsonl'),
  SHOUHENG_LLM_FAILURES: path.join(tmp, 'llm-failures.jsonl'),
  KB_CONF_LEDGER: path.join(tmp, 'confidence.ndjson'),
});
let credentialFixtures = 0;
fs.readFileSync = (file, ...args) => {
  const p = String(file);
  if (p.endsWith('/.dsh/credentials/shouheng-lark.json')) {
    credentialFixtures++;
    return JSON.stringify({ app_id: 'cli_review_routing_test', app_secret: 'fixture-only' });
  }
  if (p.endsWith('/.config/opencode/opencode.json')) return '{}';
  if (p.includes('/.dsh/credentials/') || p.endsWith('/.dsh/.credentials.yaml')) {
    throw new Error('No real credentials in review routing tests');
  }
  return originalRead.call(fs, file, ...args);
};
let networkAttempts = 0;
const rejectNetwork = () => { networkAttempts++; throw new Error('No real network in review routing tests'); };
globalThis.fetch = rejectNetwork;
net.Socket.prototype.connect = rejectNetwork;

const cases = [];
async function test(name, fn) {
  try { await fn(); cases.push({ name, ok: true }); }
  catch (error) { cases.push({ name, ok: false, detail: error.stack ?? error.message }); }
}
const TEST_TABLE = 'tblCXPQVzfFWWCon';
const PROD_TABLE = 'tblv2Y5NxxtDj4Pl';
const OWNER = 'ou_TEST_USER';
const sources = {
  test: { chatId: 'oc_TEST_GROUP', chatType: 'group', senderOpenId: 'ou_fixture_reviewer' },
  owner: { chatId: 'oc_TEST_P2P', chatType: 'p2p', senderOpenId: OWNER },
  production: { chatId: 'oc_LEGACY_GROUP', chatType: 'group', senderOpenId: 'ou_fixture_reviewer' },
  future: { chatId: 'oc_1234567890abcdef1234567890abcdef', chatType: 'group', senderOpenId: 'ou_fixture_reviewer' },
  futureOwner: { chatId: 'oc_fedcba0987654321fedcba0987654321', chatType: 'group', senderOpenId: OWNER },
};
const text = '请审核这段广告文案：便携收纳袋，可装随身物品。';
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

let lw;
try {
  const { handleMessage, runSubmissionGate } = await import('./agent.mjs');
  const rp = await import('./review_publish.mjs');
  lw = await import('./lark_write.mjs');
  const agentTools = await import('./tools.mjs');
  const { client } = await import('./feishu.mjs');

  // The identity/name lookups are external reads; preserve message parsing and
  // session locking while preventing the SDK from contacting Feishu.
  client.im.chat.get = async () => ({ code: 0, data: { name: '离线路由测试群' } });
  client.im.chatMembers.get = async () => ({ code: 0, data: { items: [
    { member_id: OWNER, name: '离线 Owner' },
    { member_id: 'ou_fixture_reviewer', name: '离线审核人' },
  ] } });
  client.contact.user.get = async () => ({ code: 0, data: { user: { name: '离线审核人' } } });
  // No call under test may send a message, even if a future branch adds one.
  client.im.message.create = rejectNetwork;
  client.im.message.reply = rejectNetwork;

  function installStore(seed = {}) {
    const tables = new Map(Object.entries(seed).map(([table, rows]) => [table, structuredClone(rows)]));
    const calls = [];
    let sequence = 0;
    const rowsOf = (table) => {
      if (!tables.has(table)) tables.set(table, []);
      return tables.get(table);
    };
    const api = (method, fn) => async (args) => {
      calls.push({ method, args: structuredClone(args) });
      assert.ok(args.path.app_token, `${method} must provide app_token`);
      assert.ok(args.path.table_id, `${method} must provide table_id`);
      return { code: 0, data: fn(args, rowsOf(args.path.table_id)) };
    };
    lw.__injectClient({ bitable: {
      appTable: { list: async () => { throw new Error('Known table IDs must not require table name discovery'); } },
      appTableRecord: {
        list: api('list', (_, rows) => ({ items: structuredClone(rows), total: rows.length, has_more: false })),
        batchCreate: api('batchCreate', (args, rows) => {
          const created = args.data.records.map(({ fields }) => ({
            record_id: `rec_${args.path.table_id}_${++sequence}`, fields: structuredClone(fields),
          }));
          rows.push(...created);
          return { records: structuredClone(created) };
        }),
        batchUpdate: api('batchUpdate', (args, rows) => {
          for (const patch of args.data.records) {
            const row = rows.find((r) => r.record_id === patch.record_id);
            assert.ok(row, `cannot update another table's row ${patch.record_id}`);
            Object.assign(row.fields, structuredClone(patch.fields));
          }
          return { records: structuredClone(args.data.records) };
        }),
        batchGet: api('batchGet', (args, rows) => {
          assert.ok(Array.isArray(args.data?.record_ids), 'readback IDs belong in the request body');
          const found = args.data.record_ids.map((id) => rows.find((r) => r.record_id === id));
          assert.ok(found.every(Boolean), 'readback must retrieve IDs from the same table');
          return { records: structuredClone(found) };
        }),
      },
    } });
    fs.writeFileSync(ledgerPath, '');
    return { tables, calls, rowsOf };
  }

  function chainResult(label = '本轮') {
    return {
      answer: `【审查结论：PASS】${label}未发现已知底线风险，可转交内容负责人进行 sign-off。`,
      review: { state: 'PASS', issue_count: 0, confidence: 0.93,
        facets: { product_line: '收纳用品', channel: '社媒' } },
      engine: { state: 'PASS', decision: { decision: 'PASS' } },
    };
  }
  function options(chainRunner = async () => chainResult(), observed = []) {
    return {
      notify: async () => {}, chainRunner,
      modelSideRunner: async () => ({ ok: true, findings: [], dropped: [], ms: 1 }),
      adviceRunner: async () => ({ ok: true, ms: 1, advice: {} }),
      mergedReportRunner: async () => { throw new Error('A zero-issue text review must not create a report'); },
      // Observation only: the real publisher, lark_write, and ledger still run.
      publishRunner: async (row, opts) => {
        observed.push({ row: structuredClone(row), ctx: structuredClone(opts.ctx) });
        return rp.ensureReviewRow(row, opts);
      },
    };
  }
  let messageSequence = 0;
  function eventFor(source) {
    const messageId = `om_offline_routing_${++messageSequence}`;
    return { event: { sender: { sender_id: { open_id: source.senderOpenId } }, message: {
      message_id: messageId, chat_id: source.chatId, chat_type: source.chatType,
      message_type: 'text', content: JSON.stringify({ text }),
    } }, ctx: { ...source, messageId } };
  }
  function assertSource(actual, expected) {
    for (const key of ['chatId', 'chatType', 'senderOpenId', 'messageId']) {
      assert.equal(actual?.[key], expected[key], `publication ctx.${key} must come from this message`);
    }
    assert.equal(actual.actor, 'shouheng/review-gate');
  }
  function assertTableCalls(calls, table, operation = 'batchCreate') {
    assert.ok(calls.some((c) => c.method === 'list'), 'real lookup must run');
    assert.ok(calls.some((c) => c.method === operation), `real ${operation} must run`);
    assert.ok(calls.some((c) => c.method === 'batchGet'), 'real readback must run');
    for (const call of calls) assert.equal(call.args.path.table_id, table, `${call.method} targets the source table`);
  }
  function assertLedger(ctx, table) {
    const entries = lw.readLedger().filter((r) => r.who?.message_id === ctx.messageId);
    assert.equal(entries.length, 1, 'one actual write ledger entry for this message');
    assert.equal(entries[0].table_id, table);
    assert.equal(entries[0].who.chat_id, ctx.chatId);
    assert.equal(entries[0].who.sender_open_id, ctx.senderOpenId);
    assert.equal(entries[0].readback, 'consistent');
    assert.equal(entries[0].result, 'ok');
  }

  await test('route defaults, source precedence, explicit overrides, and off switch', () => {
    process.env.SHOUHENG_REVIEW_TABLE = '';
    assert.equal(rp.reviewTable().table, TEST_TABLE);
    assert.equal(rp.reviewTable(sources.test).table, TEST_TABLE);
    assert.equal(rp.reviewTable(sources.owner).table, TEST_TABLE);
    assert.equal(rp.reviewTable(sources.production).table, PROD_TABLE);
    assert.equal(rp.reviewTable(sources.future).table, PROD_TABLE, 'new groups require no per-group registration');
    assert.equal(rp.reviewTable(sources.futureOwner).table, PROD_TABLE, 'Owner in a new group still uses production');
    process.env.SHOUHENG_REVIEW_TABLE = 'fixtureApp/tblFixtureOverride';
    assert.equal(rp.reviewTable(sources.production).table, PROD_TABLE, 'mapped source outranks global override');
    assert.equal(rp.reviewTable(sources.test).table, TEST_TABLE);
    assert.equal(rp.reviewTable(sources.owner).table, TEST_TABLE);
    assert.equal(rp.reviewTable(sources.future).table, PROD_TABLE, 'global override cannot send new groups into the test table');
    assert.deepEqual(rp.reviewTable({ chatId: 'oc-batch-fixture', chatType: 'p2p' }),
      { appToken: 'fixtureApp', table: 'tblFixtureOverride' });
    for (const off of ['off', 'none', '0']) {
      process.env.SHOUHENG_REVIEW_TABLE = off;
      for (const source of Object.values(sources)) assert.equal(rp.reviewTable(source), null);
    }
  });
  process.env.SHOUHENG_REVIEW_TABLE = '';

  for (const [name, table] of [['test', TEST_TABLE], ['owner', TEST_TABLE], ['production', PROD_TABLE],
    ['future', PROD_TABLE], ['futureOwner', PROD_TABLE]]) {
    await test(`${name}: real inbound -> gate -> lookup/create/readback stays in its table with full source context`, async () => {
      const store = installStore();
      const observed = [];
      const { event, ctx } = eventFor(sources[name]);
      const result = await handleMessage(event, options(undefined, observed));
      assert.equal(result.meta?.gate?.yes, true, 'must actually enter review');
      assert.equal(observed.length, 1, 'must actually publish once');
      assertTableCalls(store.calls, table);
      assertSource(observed[0].ctx, ctx);
      assertLedger(ctx, table);
    });
  }

  await test('same content in test and production updates only its own existing row', async () => {
    const cid = rp.contentIdOf(text);
    const seedRow = (table) => ({ record_id: `rec_existing_${table}`, fields: {
      '内容 ID': cid, '送审问题': text, 'Agent 结论': 'REVIEW', '问题数量': 2,
      '写入时间': Date.now(), '状态': '待审', '人工复核人': `human_${table}`,
    } });
    const store = installStore({ [TEST_TABLE]: [seedRow(TEST_TABLE)], [PROD_TABLE]: [seedRow(PROD_TABLE)] });
    for (const [source, table] of [[sources.test, TEST_TABLE], [sources.production, PROD_TABLE]]) {
      const offset = store.calls.length;
      const { event, ctx } = eventFor(source);
      await handleMessage(event, options());
      assertTableCalls(store.calls.slice(offset), table, 'batchUpdate');
      assertLedger(ctx, table);
      assert.equal(store.rowsOf(table)[0].fields['人工复核人'], `human_${table}`);
    }
    assert.equal(store.rowsOf(TEST_TABLE).length, 1);
    assert.equal(store.rowsOf(PROD_TABLE).length, 1);
    assert.equal(store.calls.filter((c) => c.method === 'batchCreate').length, 0);
  });

  await test('concurrent same-content messages preserve their source after the other session runs', async () => {
    const store = installStore();
    const entered = deferred();
    const release = deferred();
    const testMsg = eventFor(sources.test);
    const productionMsg = eventFor(sources.production);
    const testObserved = [], productionObserved = [];
    const first = handleMessage(testMsg.event, options(async () => {
      entered.resolve();
      await release.promise;
      return chainResult('测试群');
    }, testObserved));
    await entered.promise;
    try { await handleMessage(productionMsg.event, options(async () => chainResult('生产群'), productionObserved)); }
    finally { release.resolve(); }
    await first;
    assert.equal(store.rowsOf(TEST_TABLE).length, 1);
    assert.equal(store.rowsOf(PROD_TABLE).length, 1, 'same-content production row must not be absorbed by the test row');
    assertSource(testObserved[0].ctx, testMsg.ctx);
    assertSource(productionObserved[0].ctx, productionMsg.ctx);
    assertLedger(testMsg.ctx, TEST_TABLE);
    assertLedger(productionMsg.ctx, PROD_TABLE);
    for (const table of [TEST_TABLE, PROD_TABLE]) {
      assertTableCalls(store.calls.filter((c) => c.args.path.table_id === table), table);
    }
  });

  await test('direct gate snapshots caller context before its first await', async () => {
    const store = installStore();
    const ctx = { ...sources.production, messageId: 'om_direct_snapshot' };
    const expected = { ...ctx };
    const observed = [];
    await agentTools.withAgentTurnContext(() => runSubmissionGate({
      inbound: { text, images: [], videos: [] }, question: text, userText: text,
      publicationContext: ctx,
      ...options(undefined, observed),
      notify: async () => {
        Object.assign(ctx, sources.test, { messageId: 'om_mutated_after_start' });
      },
    }));
    assertTableCalls(store.calls, PROD_TABLE);
    assertSource(observed[0].ctx, expected);
    assertLedger(expected, PROD_TABLE);
  });

  await test('historical report reads use the current source even for the same content ID', async () => {
    const cid = rp.contentIdOf(text);
    const link = (table) => `https://example.invalid/docx/${table}`;
    const row = (table) => ({ record_id: `rec_history_${table}`, fields: {
      '内容 ID': cid, '报告链接': { link: link(table), text: '历史报告' },
    } });
    const store = installStore({ [TEST_TABLE]: [row(TEST_TABLE)], [PROD_TABLE]: [row(PROD_TABLE)] });
    for (const [source, table] of [[sources.test, TEST_TABLE], [sources.production, PROD_TABLE]]) {
      const offset = store.calls.length;
      assert.equal(await rp.previousReportLink(cid, { ctx: source }), link(table));
      const calls = store.calls.slice(offset);
      assert.ok(calls.length > 0);
      assert.ok(calls.every((c) => c.method === 'list' && c.args.path.table_id === table));
    }
    assert.equal(lw.readLedger().length, 0, 'history lookup cannot create a write ledger entry');
  });

  await test('real handleMessage source reaches P0 historical-report lookup during its chain', async () => {
    const cid = rp.contentIdOf(text);
    const link = (table) => `https://example.invalid/docx/inbound-p0-${table}`;
    const row = (table) => ({ record_id: `rec_inbound_p0_${table}`, fields: {
      '内容 ID': cid, '送审问题': text, '报告链接': { link: link(table), text: '历史报告' },
    } });
    const store = installStore({ [TEST_TABLE]: [row(TEST_TABLE)], [PROD_TABLE]: [row(PROD_TABLE)] });
    for (const [source, table] of [[sources.production, PROD_TABLE], [sources.test, TEST_TABLE]]) {
      const { event, ctx } = eventFor(source);
      let p0Result;
      const offset = store.calls.length;
      await handleMessage(event, options(async () => {
        // The P0 function consumes the handler's real async context; there is no
        // manual setAgentTurnContext call or fake previousReportLink here.
        p0Result = await agentTools.p0HitPayload({ text, allowPublish: false,
          p0ReportPath: path.join(tmp, 'uncreated-inbound-p0-report.md'),
          p0: { rendered: '【审查结论：BLOCK】共发现 1 处必须修改。', issue_count: 1,
            elapsed_ms: 1, matched_patterns: 1, findings: [] },
          fastpath: async (_, { reportRef }) => ({ rendered: `【审查结论：BLOCK】共发现 1 处必须修改。${reportRef}` }),
          publishDoc: async () => { throw new Error('read-only P0 must not publish a document'); },
        });
        return chainResult();
      }));
      assert.equal(p0Result?.report, link(table), 'P0 must read the same source table as the final publication');
      assertTableCalls(store.calls.slice(offset), table, 'batchUpdate');
      assertLedger(ctx, table);
    }
  });

  await test('P0 old-report lookup keeps each turn context across an overlapping turn', async () => {
    const cid = rp.contentIdOf(text);
    const link = (table) => `https://example.invalid/docx/p0-${table}`;
    const row = (table) => ({ record_id: `rec_p0_${table}`, fields: {
      '内容 ID': cid, '报告链接': { link: link(table), text: '历史报告' },
    } });
    installStore({ [TEST_TABLE]: [row(TEST_TABLE)], [PROD_TABLE]: [row(PROD_TABLE)] });
    const pause = deferred(), resume = deferred();
    const payload = () => agentTools.p0HitPayload({ text, allowPublish: false,
      p0ReportPath: path.join(tmp, 'uncreated-p0-report.md'),
      p0: { rendered: '【审查结论：BLOCK】共发现 1 处必须修改。', issue_count: 1,
        elapsed_ms: 1, matched_patterns: 1, findings: [] },
      fastpath: async (_, { reportRef }) => ({ rendered: `【审查结论：BLOCK】共发现 1 处必须修改。${reportRef}` }),
      publishDoc: async () => { throw new Error('read-only P0 must not publish a document'); },
    });
    const first = agentTools.withAgentTurnContext(async () => {
      agentTools.setAgentTurnContext({ publicationContext: sources.production });
      pause.resolve(); await resume.promise;
      return payload();
    });
    await pause.promise;
    let second;
    try {
      second = await agentTools.withAgentTurnContext(async () => {
        agentTools.setAgentTurnContext({ publicationContext: sources.test });
        return payload();
      });
    } finally { resume.resolve(); }
    assert.equal((await first).report, link(PROD_TABLE));
    assert.equal(second.report, link(TEST_TABLE));
    assert.equal(lw.readLedger().length, 0);
  });

  await test('rendered review command actually passes --no-publish to its shell process', () => {
    const work = path.join(tmp, 'shell-template');
    fs.mkdirSync(path.join(work, 'kb/l8'), { recursive: true });
    // Run only a stub under tmp: the repository review script is never executed.
    fs.writeFileSync(path.join(work, 'kb/l8/review_run.sh'), '#!/bin/bash\nprintf "%s\\n" "$@" > "$ROUTING_ARGS_FILE"\n');
    const material = path.join(work, 'material.txt');
    fs.writeFileSync(material, text);
    const command = agentTools.reviewCmdTemplate(material, 'text').match(/```bash\n([\s\S]*?)\n```/)?.[1];
    assert.ok(command, 'template must contain an executable bash block');
    const argsPath = path.join(work, 'args.txt');
    execFileSync('/bin/bash', ['-c', command.replace(/<[^>]+>/g, 'fixture')], {
      cwd: work, env: { PATH: '/usr/bin:/bin', ROUTING_ARGS_FILE: argsPath }, timeout: 5000,
    });
    const args = fs.readFileSync(argsPath, 'utf8').trim().split('\n');
    assert.ok(args.includes('--no-publish'), 'the actual command must disable chain-side publication');
    assert.equal(args[args.indexOf('--content-type') + 1], 'text');
  });

  await test('review hard rules give publication ownership to the caller without a hard-coded table', () => {
    assert.doesNotMatch(agentTools.REVIEW_HARD_RULES, /tblCXPQVzfFWWCon|tblv2Y5NxxtDj4Pl/);
    assert.match(agentTools.REVIEW_HARD_RULES, /--no-publish/);
    assert.match(agentTools.REVIEW_HARD_RULES, /(?:不许|不要|不得|禁止)[^\n]{0,30}(?:写(?:飞书)?表|落表|发布)/);
  });

  await test('off switch blocks the real publisher before any table read or write', async () => {
    const store = installStore();
    process.env.SHOUHENG_REVIEW_TABLE = 'off';
    const result = await rp.ensureReviewRow({ contentId: 'AUTO-off', question: text }, { ctx: sources.production });
    assert.equal(result.action, 'skipped');
    assert.equal(store.calls.length, 0);
    assert.equal(lw.readLedger().length, 0);
  });
  await test('the suite uses fake credentials, temporary state and zero network calls', () => {
    assert.ok(credentialFixtures > 0);
    assert.equal(lw.LEDGER, ledgerPath);
    assert.equal(networkAttempts, 0);
    assert.ok(fs.existsSync(path.join(tmp, 'sessions')), 'real session persistence stays under tmp');
  });
} finally {
  lw?.__injectClient(null);
  fs.readFileSync = originalRead;
  globalThis.fetch = originalFetch;
  net.Socket.prototype.connect = originalConnect;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  fs.rmSync(tmp, { recursive: true, force: true });
}

for (const result of cases) {
  console.log(`${result.ok ? '✅' : '❌'} ${result.name}`);
  if (!result.ok) console.log(result.detail);
}
const failed = cases.filter((c) => !c.ok).length;
console.log(`review_routing: ${cases.length - failed}/${cases.length} passed`);
if (failed) process.exitCode = 1;

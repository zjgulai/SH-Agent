#!/usr/bin/env node
/** A final NEEDS_INPUT decision must dominate every later verdict fallback. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import dns from 'node:dns/promises';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-video-final-refusal-'));
const originalRead = fs.readFileSync;
const originalFetch = globalThis.fetch;
const originalConnect = net.Socket.prototype.connect;
const originalLookup = dns.lookup;
const originalEnv = { ...process.env };
Object.assign(process.env, {
  SHOUHENG_STATE_DIR: tmp, SHOUHENG_KB_ROOT: path.join(tmp, 'absent-kb'),
  SHOUHENG_LLM_API_KEY: 'fixture-only', SHOUHENG_LLM_BASE_URL: 'http://127.0.0.1:9',
  SHOUHENG_VISION_BASE_URL: 'http://127.0.0.1:9', SHOUHENG_VISION_API_KEY: 'fixture-only',
  SHOUHENG_REVIEW_TABLE: 'off', SHOUHENG_MEDIA_LINK: 'off', SHOUHENG_MERGED_RECORD: 'off',
  SH_FORCE_REPORT: '0', KB_CONF_LEDGER: path.join(tmp, 'confidence.ndjson'),
});
fs.readFileSync = (file, ...args) => {
  const p = String(file);
  if (p.endsWith('/.dsh/credentials/shouheng-lark.json')) {
    return JSON.stringify({ app_id: 'cli_video_final_refusal_fixture', app_secret: 'fixture-only' });
  }
  if (p.endsWith('/.config/opencode/opencode.json')) return '{}';
  if (p.endsWith('/.dsh/.credentials.yaml')) throw new Error('No real credentials in this test');
  return originalRead.call(fs, file, ...args);
};
let networkAttempts = 0;
const rejectNetwork = () => { networkAttempts++; throw new Error('No real network in this test'); };
globalThis.fetch = rejectNetwork;
net.Socket.prototype.connect = rejectNetwork;
dns.lookup = rejectNetwork;
const cases = [];
const test = async (name, fn) => {
  try { await fn(); cases.push({ name, ok: true }); }
  catch (error) { cases.push({ name, ok: false, detail: error.message }); }
};

try {
  const { runSubmissionGate, finalVerdict53ForTurn } = await import('./agent.mjs');
  const { withAgentTurnContext } = await import('./tools.mjs');
  const { toCardOrText } = await import('../reply-cards/envelope.mjs');
  const frame = path.join(tmp, 'original-frame.png');
  fs.copyFileSync(new URL('./__fixtures__/ocr-sample.png', import.meta.url), frame);
  async function run(refused, { zeroCount = false, modelCount = 0 } = {}) {
    const scene = { setting: '本轮画面', people: [], products: [], risk_cues: [] };
    const state = refused ? 'NEEDS_INPUT' : 'PASS';
    const inbound = { text: zeroCount ? '' : '审核本段视频', imageCount: 0, images: [], videoCount: zeroCount ? 0 : 1,
      videos: [{ index: 1, meta: { duration_s: 2, has_audio: false },
        frames: [{ t_s: 0.5, text: 'Current' }], framesRead: 1, framesFailed: 0,
        scenePlan: [0.5], frameScene: [{ t_s: 0.5, ok: true, scene }], modelFramePaths: [frame],
        transcript: { ok: false, kind: 'no_audio_track' } }] };
    const rows = [], reports = [];
    const result = await withAgentTurnContext(() => runSubmissionGate({
      inbound, question: inbound.text, userText: inbound.text, notify: null,
      chainRunner: async () => ({
        report: 'https://example.invalid/existing-report',
        answer: ['审核对象与范围：当前视频。', '视觉分析与 OCR：画面与文字已读。',
          '主张拆分与核查清单：逐项核对。', '4A 规则符合性：已完成。',
          '4B 事实准确性核查：已完成。', '音画一致性：无音轨。',
          refused ? '【审查结论：NEEDS_INPUT】当前专项依据未齐，不能发布结论。'
            : '【审查结论：PASS】未发现已知底线风险，可转交 @内容负责人 进行 sign-off。',
        ].join('\n'),
        review: { state, issue_count: 0, reason_code: refused ? 'evidence_side_refused' : '',
          facets: { product_line: '测试', channel: '测试' } },
        // The low-level engine ran, while the chain's final decision can still
        // refuse. This must not be confused with missing video read evidence.
        engine: { decision: { decision: 'PASS' }, evidence_meta: {
          trace: { negative_rules: { executed: true, rules_scanned: 1, hits: [],
            frames_scanned: 1, frame_scene_errors: [],
            frame_scans: [{ video: 1, t_s: 0.5, scene, rules_scanned: 1, hits: [] }] } },
          layer_preflight: { ok: true, mode: 'enforced', red_total: 0,
            details: Object.fromEntries(['L4', 'L5', 'L6', 'L7'].map(layer => [layer, { pass: true, exit: 0, red: 0 }])) },
          decision_owner: { skill: '视频安全审查', mode: 'declared', loaded_skills: ['视频安全审查'] },
          video_skill_gate: { ok: true, evidence_kind: 'offline_fixture',
            load: { verdict: 'loaded', calls: [{ verdict: 'loaded' }] } },
        } },
      }),
      modelSideRunner: async () => ({ ok: true,
        findings: Array.from({ length: modelCount }, (_, i) => ({ category: '信息表达',
          location: `视频 00:0${i + 1}`, severity: 'REVIEW', nature: 'mandatory',
          reason: `当前观察 ${i + 1}`, suggestion: '按当前观察核对表达',
          evidence_basis: 'image_observation', basis_kind: 'visual_observation',
          visual_anchor: `当前视频第 ${i + 1} 秒画面`, basis_missing: false })), dropped: [], ms: 0 }),
      publishRunner: async row => { rows.push(structuredClone(row)); return { ok: true, action: 'skipped' }; },
      mergedReportRunner: async md => { reports.push(md);
        return { ok: true, url: 'https://example.invalid/new-merged-report' }; },
      adviceRunner: async () => ({ ok: true, ms: 0, advice: {} }), mediaLinksRunner: async () => [],
    }));
    return { result, rows, reports };
  }
  const refused = await run(true);
  await test('real gate retains final refusal independently of successful video completion evidence', () => {
    assert.equal(refused.result.videoReviewIncomplete, false, 'must exercise the separate final-decision gate');
    assert.equal(refused.rows[0].conclusion, 'NEEDS_INPUT');
    assert.equal(refused.result.verdict53, null);
    assert.equal(refused.result.reviewDirectReply, null);
    assert.equal(refused.result.reviewDecisionWithheld, true);
  });
  await test('final refusal clears a report left by the chain from the row and returned result', () => {
    assert.equal(refused.reports.length, 0);
    assert.equal(refused.rows[0].reportUrl, null);
    assert.equal(refused.rows[0].clearReportUrl, true);
    assert.equal(refused.result.dual?.reportUrl ?? null, null);
  });
  await test('a chain refusal cannot publish a new report even when the independent model has three observations', async () => {
    const sample = await run(true, { modelCount: 3 });
    assert.equal(sample.result.videoReviewIncomplete, false);
    assert.equal(sample.reports.length, 0);
    assert.equal(sample.rows[0].conclusion, 'NEEDS_INPUT');
    assert.equal(sample.rows[0].reportUrl, null);
    assert.equal(sample.rows[0].clearReportUrl, true);
    assert.equal(sample.result.dual?.reportUrl ?? null, null);
    assert.equal(sample.result.verdict53, null);
  });
  await test('a complete accepted review with three observations still publishes its normal report', async () => {
    const sample = await run(false, { modelCount: 3 });
    assert.equal(sample.reports.length, 1);
    assert.match(sample.reports[0], /当前观察 1/);
    assert.equal(sample.result.verdict53?.state, 'REVIEW');
    assert.equal(sample.rows[0].conclusion, 'REVIEW');
    assert.equal(sample.rows[0].reportUrl, 'https://example.invalid/new-merged-report');
    assert.equal(sample.rows[0].clearReportUrl, false);
    assert.equal(sample.result.dual.reportUrl, 'https://example.invalid/new-merged-report');
  });
  const toolTrace = [{ tool: 'kb_review_chain', ok: true }];
  const fallbacks = [
    ['old chain conclusion', { toolTrace, chainAnswer: { answer: '【审查结论：REVIEW】共发现 1 处需人工确认。' } }],
    ['P0 payload', { p0Payload: { answer: '【审查结论：BLOCK】共发现 1 处必须修改。',
      p0Fastpath: { mode: 'p0_fastpath', matched_patterns: 1 } } }],
    ['model reply', { toolTrace, reply: '【审查结论：PASS】未发现已知底线风险。' }],
  ];
  for (const [name, fallback] of fallbacks) {
    await test(`final refusal cannot recover ${name} into a three-state card`, () => {
      assert.ok(finalVerdict53ForTurn(fallback)?.line, 'fallback positive control must be active');
      const verdict = finalVerdict53ForTurn({ gateResult: refused.result, ...fallback });
      assert.equal(verdict, null);
      const card = toCardOrText('【审查结论：PASS】旧模型结论', { verdict53: verdict,
        reviewRequired: true, reviewReason: '当前专项依据未齐，不能发布结论。' });
      assert.equal(card.mode, 'card');
      assert.equal(card.kind, 'alert');
      assert.doesNotMatch(JSON.stringify(card.card), /【审查结论[：:](?:PASS|REVIEW|BLOCK)】/);
    });
  }
  const accepted = await run(false);
  await test('completed normal video keeps its own accepted verdict', () => {
    assert.equal(accepted.result.reviewDecisionWithheld, false);
    assert.equal(accepted.result.verdict53?.state, 'PASS');
    assert.equal(finalVerdict53ForTurn({ gateResult: accepted.result, ...fallbacks[1][1] }), accepted.result.verdict53);
    assert.equal(accepted.rows[0].conclusion, 'PASS');
    assert.equal(accepted.rows[0].clearReportUrl, false);
    assert.equal(accepted.rows[0].reportUrl, 'https://example.invalid/existing-report');
  });
  await test('a video array starts a complete review even when its declared count is zero', async () => {
    const sample = await run(false, { zeroCount: true });
    assert.equal(sample.result.gate.yes, true);
    assert.equal(sample.result.chainRan, true);
    assert.equal(sample.result.videoReviewIncomplete, false);
    assert.equal(sample.result.verdict53?.state, 'PASS');
    assert.equal(sample.rows[0].conclusion, 'PASS');
  });
  await test('a non-submission tool review can still supply its valid conclusion', () => {
    assert.equal(finalVerdict53ForTurn({ gateResult: { gate: { yes: false }, verdict53: null },
      ...fallbacks[0][1] })?.state, 'REVIEW');
  });
  await test('no external network boundary was used', () => assert.equal(networkAttempts, 0));
} finally {
  fs.readFileSync = originalRead;
  globalThis.fetch = originalFetch;
  net.Socket.prototype.connect = originalConnect;
  dns.lookup = originalLookup;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  fs.rmSync(tmp, { recursive: true, force: true });
}
for (const result of cases) console.log(`${result.ok ? '✅' : '❌'} ${result.name}${result.detail ? `: ${result.detail}` : ''}`);
const failed = cases.filter(result => !result.ok).length;
console.log(`video_final_refusal: ${cases.length - failed}/${cases.length}, real network attempts=${networkAttempts}`);
if (failed) process.exitCode = 1;

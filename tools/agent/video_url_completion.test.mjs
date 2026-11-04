#!/usr/bin/env node
/** Exercise the real URL -> video -> chain/model -> publication path offline. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import dns from 'node:dns/promises';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-video-url-'));
const originalRead = fs.readFileSync;
const originalCopy = fs.copyFileSync;
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
    return JSON.stringify({ app_id: 'cli_video_url_test', app_secret: 'fixture-only' });
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
const retainedDirectories = new Set();
fs.copyFileSync = (source, dest, ...args) => {
  if (String(dest).startsWith('/tmp/shouheng-vid-frames-')) retainedDirectories.add(path.dirname(dest));
  return originalCopy.call(fs, source, dest, ...args);
};
const test = async (name, fn) => {
  try { await fn(); cases.push({ name, ok: true }); }
  catch (error) { cases.push({ name, ok: false, detail: error.message }); }
};
const url = 'https://example.invalid/current-submission.mp4';

try {
  const { runSubmissionGate, readInboundContent, finalVerdict53ForTurn } = await import('./agent.mjs');
  const { withAgentTurnContext } = await import('./tools.mjs');
  let sequence = 0;
  async function run({ failure = '', upload = false } = {}) {
    const dir = fs.mkdtempSync(path.join(tmp, 'submission-'));
    const download = path.join(dir, 'download.mp4');
    const extracted = path.join(dir, 'extracted');
    fs.writeFileSync(download, 'local video boundary fixture');
    fs.mkdirSync(extracted);
    const frames = [0.5, 4.5].map((_, i) => {
      const file = path.join(extracted, `frame-${i}.png`);
      fs.copyFileSync(new URL('./__fixtures__/ocr-sample.png', import.meta.url), file);
      return file;
    });
    const video = { ok: true, meta: { duration_s: 5, has_audio: true },
      frames: [{ t_s: 0.5, text: 'URL_OCR_CURRENT' }, { t_s: 4.5, text: '' }],
      framesRead: 2, framesFailed: 0, ocrText: 'URL_OCR_CURRENT', ocrChars: 15,
      scenePlan: [0.5, 4.5], sampleFramePaths: frames,
      frameScene: [0.5, 4.5].map(t_s => ({ t_s, ok: true,
        scene: { setting: 'URL_SCENE_CURRENT', people: [], products: [], risk_cues: [] } })),
      transcript: { ok: true, text: 'URL_ASR_CURRENT', chars: 15, on_device: true },
      cleanup: () => { calls.frameCleanup++; fs.rmSync(extracted, { recursive: true, force: true }); },
    };
    const calls = { downloads: [], reads: [], chain: [], model: [], rows: [], reports: [],
      downloadCleanup: 0, frameCleanup: 0 };
    const downloaded = { ok: true, path: download, bytes: fs.statSync(download).size,
      cleanup: () => { calls.downloadCleanup++; fs.rmSync(download, { force: true }); } };
    const downloadVideoFn = async (value) => {
      calls.downloads.push(value);
      return failure === 'download' ? { ...downloaded, ok: false, error: 'fixture download failed' } : downloaded;
    };
    const readVideoFn = async (file) => {
      calls.reads.push(file);
      assert.equal(fs.existsSync(file), true, 'video must still exist during reading');
      if (failure === 'read-throw') throw new Error('fixture read threw');
      if (failure === 'read-result') return { ...video, ok: false, error: 'fixture read failed' };
      if (failure === 'copy') fs.rmSync(frames[1]);
      return video;
    };
    const chain = { answer: [
      '审核对象与范围：本次 5 秒视频，覆盖 0.5s 和 4.5s 采样画面及本机音频。',
      '视觉分析与 OCR：读取当前视频画面与字幕。',
      '主张拆分与核查清单：逐项核对当前素材。',
      '4A 规则符合性：本轮规则层完成。',
      '4B 事实准确性核查：核对本轮材料已有事实。',
      '音画一致性：画面、字幕与口播已对照。',
      '【审查结论：PASS】未发现已知底线风险，可转交 @内容负责人 进行 sign-off。',
    ].join('\n'), review: { state: 'PASS', issue_count: 0, facets: { product_line: '产品', channel: '社媒' } },
    engine: { decision: { decision: 'PASS' }, evidence_meta: {
      trace: { negative_rules: { executed: true, rules_scanned: 1, hits: [],
        frames_scanned: 2, frame_scene_errors: [], visual_rules_scanned: 0, visual_coverage_gap: true,
        frame_scans: video.frameScene.map(frame => ({ video: 1, t_s: frame.t_s,
          scene: frame.scene, rules_scanned: 1, visual_rules_scanned: 0, hits: [] })) } },
      video_skill_gate: { ok: true, evidence_kind: 'session_tool_result',
        expected: '视频安全审查', owner: '视频安全审查', load: { skill: '视频安全审查', verdict: 'loaded',
          session: `/fixture/url-${++sequence}.json`, calls: [{ callId: 'skill', seq: 1, verdict: 'loaded' }] } },
      layer_preflight: { ok: true, mode: 'enforced', red_total: 0,
        details: Object.fromEntries(['L4', 'L5', 'L6', 'L7'].map(layer => [layer, { pass: true, exit: 0, red: 0 }])) },
      decision_owner: { skill: '视频安全审查', mode: 'declared', loaded_skills: ['视频安全审查'] },
    } } };
    let inbound = { text: `请审核 ${url}`, imageCount: 0, images: [], videoCount: 0, videos: [] };
    if (upload) {
      inbound = await readInboundContent({ message_id: 'om_current_video', message_type: 'media',
        content: JSON.stringify({ file_key: 'fixture-current', file_name: 'current.mp4' }) }, {
        fetchVideo: async () => downloaded, readVideoFn,
        loadParent: async () => ({ text: '请审核当前视频', images: [], videos: [] }),
      });
    }
    const result = await withAgentTurnContext(() => runSubmissionGate({
      inbound, question: inbound.text, userText: inbound.text, notify: null,
      downloadVideoFn, readVideoFn,
      chainRunner: async (input) => { calls.chain.push(structuredClone(input));
        if (failure === 'chain') throw new Error('fixture chain failed');
        return chain; },
      modelSideRunner: async (input) => {
        const observed = { paths: [...input.imagePaths], required: input.requiredImageCount,
          exists: input.imagePaths.map(p => fs.existsSync(p)), readings: input.readings,
          sourceGone: !fs.existsSync(extracted), downloadGone: !fs.existsSync(download) };
        calls.model.push(observed);
        await new Promise(resolve => setImmediate(resolve));
        observed.existsBeforeReturn = input.imagePaths.map(p => fs.existsSync(p));
        if (failure === 'model') throw new Error('fixture model failed');
        return { ok: true, findings: [], dropped: [], ms: 1 };
      },
      publishRunner: async row => { calls.rows.push(structuredClone(row)); return { ok: true, action: 'skipped' }; },
      mergedReportRunner: async markdown => { calls.reports.push(markdown); return { ok: true, url: '' }; },
      adviceRunner: async () => ({ ok: true, ms: 1, advice: {} }),
      mediaLinksRunner: async () => [],
      linkReader: async () => { throw new Error('video must not be read as an HTML page'); },
    }));
    return { result, calls, download, extracted };
  }

  for (const upload of [false, true]) {
    await test(`${upload ? 'uploaded' : 'URL'} video sends current material and retained original frames through the complete gate`, async () => {
      const { result, calls, download, extracted } = await run({ upload });
      assert.equal(calls.chain.length, 1);
      assert.equal(calls.chain[0].contentType, 'video');
      for (const needle of ['URL_OCR_CURRENT', 'URL_SCENE_CURRENT', 'URL_ASR_CURRENT']) {
        assert.ok(calls.chain[0].text.includes(needle), `chain material lost ${needle}`);
      }
      assert.equal(calls.model.length, 1);
      assert.equal(calls.model[0].required, 2);
      assert.equal(calls.model[0].paths.length, 2);
      assert.deepEqual(calls.model[0].exists, [true, true]);
      assert.deepEqual(calls.model[0].existsBeforeReturn, [true, true], 'frames must survive until the model finishes');
      assert.equal(calls.model[0].sourceGone, true, 'extraction directory must be deleted after retaining frames');
      assert.equal(calls.model[0].downloadGone, true, 'download must be deleted before model review');
      assert.equal(result.videoReviewIncomplete, false);
      assert.equal(result.verdict53?.state, 'PASS');
      assert.equal(calls.rows[0]?.conclusion, 'PASS');
      assert.equal(calls.frameCleanup, 1);
      assert.equal(calls.downloadCleanup, 1);
      assert.equal(fs.existsSync(download), false);
      assert.equal(fs.existsSync(extracted), false);
      assert.ok(calls.model[0].paths.every(p => !fs.existsSync(p)), 'retained frames must be deleted after review');
      assert.deepEqual(calls.downloads, upload ? [] : [url]);
    });
  }
  for (const failure of ['download', 'read-throw', 'read-result']) {
    await test(`${failure}: URL failure cannot start the review chain and releases downloaded bytes`, async () => {
      const { result, calls, download, extracted } = await run({ failure });
      assert.equal(result.verdict53, null);
      assert.equal(result.chainRan, false);
      assert.equal(calls.chain.length, 0);
      assert.equal(calls.model.length, 0);
      assert.equal(calls.rows.length, 0);
      assert.equal(calls.reports.length, 0);
      assert.equal(calls.downloadCleanup, 1);
      assert.equal(fs.existsSync(download), false);
      if (failure === 'read-result') {
        assert.equal(calls.frameCleanup, 1);
        assert.equal(fs.existsSync(extracted), false);
      }
      const fallback = { toolTrace: [{ tool: 'kb_review_chain', ok: true }],
        chainAnswer: { answer: '【审查结论：REVIEW】共发现 1 处需人工确认。' } };
      assert.equal(finalVerdict53ForTurn(fallback)?.state, 'REVIEW');
      assert.equal(result.reviewDecisionWithheld, true);
      assert.equal(finalVerdict53ForTurn({ gateResult: result, ...fallback }), null);
    });
  }
  for (const failure of ['copy', 'model', 'chain']) {
    await test(`${failure}: incomplete URL review refuses and cleans both source and retained frames`, async () => {
      const { result, calls, download, extracted } = await run({ failure });
      assert.equal(result.videoReviewIncomplete, true);
      assert.equal(result.verdict53, null);
      assert.equal(calls.rows[0]?.conclusion, 'NEEDS_INPUT');
      assert.equal(calls.reports.length, 0);
      assert.equal(fs.existsSync(download), false);
      assert.equal(fs.existsSync(extracted), false);
      assert.equal(calls.frameCleanup, 1);
      assert.equal(calls.downloadCleanup, 1);
      assert.ok(calls.model[0].paths.every(p => !fs.existsSync(p)));
    });
  }
  await test('all retained frame directories, including partial-copy failures, are deleted', () => {
    assert.ok(retainedDirectories.size > 0, 'the control must observe real retained frame copies');
    for (const dir of retainedDirectories) assert.equal(fs.existsSync(dir), false, `leaked retained directory: ${dir}`);
  });
  await test('no external network boundary was used', () => assert.equal(networkAttempts, 0));
} finally {
  fs.readFileSync = originalRead;
  fs.copyFileSync = originalCopy;
  globalThis.fetch = originalFetch;
  net.Socket.prototype.connect = originalConnect;
  dns.lookup = originalLookup;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  fs.rmSync(tmp, { recursive: true, force: true });
}
for (const result of cases) console.log(`${result.ok ? '✅' : '❌'} ${result.name}${result.detail ? `: ${result.detail}` : ''}`);
const failed = cases.filter(r => !r.ok).length;
console.log(`video_url_completion: ${cases.length - failed}/${cases.length}, real network attempts=${networkAttempts}`);
if (failed) process.exitCode = 1;

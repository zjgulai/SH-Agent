#!/usr/bin/env node
/**
 * Slow, standalone offline workflow acceptance. Do not add to the default
 * test_agent 30-second child suite: this runs 90 real local OCR operations.
 *
 * Real: synthetic video generation, probe/OCR, original-frame retention,
 * chainInput material, KB review.py CLI dry-run, merge, publication decision,
 * and final Feishu card serialization.
 * Explicit fixtures: six scene responses, independent model findings, skill
 * load evidence, L4-L7 invocation audit, and every external publication.
 * The generated video has no audio track; ASR availability is tested separately.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import dns from 'node:dns/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const repo = path.resolve(new URL('../../', import.meta.url).pathname);
const kbRoot = process.env.SHOUHENG_WORKFLOW_KB_ROOT || path.join(os.homedir(), '.dsh', 'Momcozy知识库');
const enginePath = path.join(kbRoot, 'kb/l7/skills/kb-content-review/scripts/review.py');
const evidenceDir = process.env.SHOUHENG_WORKFLOW_EVIDENCE_DIR
  || '/tmp/shouheng-video-independent-review-20261030';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-video-workflow-'));
const guardLog = path.join(tmp, 'python-guard.jsonl');
const originalEnv = { ...process.env };
const originalRead = fs.readFileSync;
const originalFetch = globalThis.fetch;
const originalConnect = net.Socket.prototype.connect;
const originalLookup = dns.lookup;
let networkAttempts = 0;
const temporaryMediaDirectories = new Set();
const rejectNetwork = () => { networkAttempts++; throw new Error('No real network in workflow acceptance'); };
Object.assign(process.env, {
  SHOUHENG_STATE_DIR: path.join(tmp, 'state'), SHOUHENG_KB_ROOT: path.join(tmp, 'absent-agent-kb'),
  SHOUHENG_LLM_API_KEY: 'fixture-only', SHOUHENG_LLM_BASE_URL: 'http://127.0.0.1:9',
  SHOUHENG_VISION_BASE_URL: 'http://127.0.0.1:9', SHOUHENG_VISION_API_KEY: 'fixture-only',
  SHOUHENG_SCENE: '1', SHOUHENG_SCENE_FRAMES: '6', SHOUHENG_VIDEO_FRAMES: '30',
  SHOUHENG_REVIEW_TABLE: 'off', SHOUHENG_MEDIA_LINK: 'off', SHOUHENG_MERGED_RECORD: 'off',
  SH_FORCE_REPORT: '0', KB_CONF_LEDGER: path.join(tmp, 'confidence.ndjson'),
});
fs.readFileSync = (file, ...args) => {
  const name = String(file);
  if (name.endsWith('/.dsh/credentials/shouheng-lark.json')) {
    return JSON.stringify({ app_id: 'cli_video_workflow_fixture', app_secret: 'fixture-only' });
  }
  if (name.endsWith('/.config/opencode/opencode.json')) return '{}';
  if (name.endsWith('/.dsh/.credentials.yaml')) throw new Error('No real credentials in workflow acceptance');
  return originalRead.call(fs, file, ...args);
};
globalThis.fetch = rejectNetwork;
net.Socket.prototype.connect = rejectNetwork;
dns.lookup = rejectNetwork;

const sha = value => createHash('sha256').update(value).digest('hex');
const fileSha = file => sha(fs.readFileSync(file));
const sourceFiles = [
  'tools/agent/agent.mjs', 'tools/agent/tools.mjs', 'tools/agent/video.mjs', 'tools/agent/vision.mjs',
  'tools/agent/review_gate.mjs', 'tools/agent/video_completion.mjs',
  'tools/agent/video_workflow.test.mjs',
  'tools/agent/dual_track.mjs', 'tools/reply-cards/envelope.mjs', 'base/video_fixture.m',
].map(name => path.join(repo, name));
sourceFiles.push(enginePath, path.join(kbRoot, 'kb/l8/negative_rule_match.py'),
  path.join(kbRoot, 'kb/l3/candidates/negative_rules.jsonl'));
for (const rel of ['kb/l8/visual_rule_match.py', 'kb/l7/registry/visual-review-rules.json']) {
  const file = path.join(kbRoot, rel);
  if (fs.existsSync(file)) sourceFiles.push(file);
}
const sourceHashes = () => Object.fromEntries(sourceFiles.map(file => [file, fileSha(file)]));
const evidence = {
  kind: 'standalone-offline-video-workflow', started: new Date().toISOString(),
  realBoundaries: ['synthetic-video-generation', 'local-video-probe', 'local-OCR',
    'frame-retention-and-cleanup', 'chainInput', 'actual-KB-review.py-CLI-dry-run',
    'runSubmissionGate', 'dual-track-merge', 'final-card-serialization'],
  simulatedBoundaries: ['scene-model-responses', 'independent-model-responses',
    'skill-load-evidence', 'L4-L7-invocation-audit', 'freshness-preflight-report', 'report-and-table-publication'],
  audioBoundary: 'real no-audio-track observation; no ASR success is claimed',
  totals: { ocr: 0, scene: 0, engine: 0, independentModel: 0 }, rounds: [],
};

try {
  evidence.sourceHashesBefore = sourceHashes();
  const { readVideo } = await import('./video.mjs');
  const { ocrImage } = await import('./vision.mjs');
  const { readInboundContent, runSubmissionGate } = await import('./agent.mjs');
  const { withAgentTurnContext } = await import('./tools.mjs');
  const { toCardOrText } = await import('../reply-cards/envelope.mjs');

  // Native recipe is copied into this run's temporary directory; no repository
  // fixture or media is overwritten or retained as an evidence artifact.
  const generatorSource = path.join(tmp, 'video_fixture.m');
  fs.writeFileSync(generatorSource, fs.readFileSync(path.join(repo, 'base/video_fixture.m'), 'utf8')
    .replaceAll('SHOUHENG VIDEO FIXTURE', 'Momcozy M5 wearable pump')
    .replace('[NSString stringWithFormat:@"FRAME %d/%d", i + 1, total]', '@"6-month-old baby"')
    .replace('[NSFont boldSystemFontOfSize:40]', '[NSFont boldSystemFontOfSize:32]'));
  const generator = path.join(tmp, 'video_fixture');
  const sdkBase = '/Library/Developer/CommandLineTools/SDKs';
  const sdk = fs.existsSync(sdkBase) ? fs.readdirSync(sdkBase)
    .filter(name => /^MacOSX\d+\.\d+\.sdk$/.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))[0] : null;
  // The host can have a newer SDK than its linker understands. This fixture
  // only uses long-established APIs, so prefer the oldest installed full SDK.
  const sdkArgs = sdk ? ['-isysroot', path.join(sdkBase, sdk), '-mmacosx-version-min=13.0'] : [];
  evidence.compilerSdk = sdk || 'system-default';
  await exec('/usr/bin/clang', [...sdkArgs, '-fobjc-arc', '-framework', 'Foundation', '-framework', 'AVFoundation',
    '-framework', 'AppKit', '-framework', 'CoreVideo', '-framework', 'CoreMedia',
    generatorSource, '-o', generator], { timeout: 60_000 });
  const synthetic = path.join(tmp, 'synthetic-29s.mp4');
  const generated = await exec(generator, [synthetic, '29', '10'], { timeout: 60_000 });
  assert.equal(JSON.parse(generated.stdout.trim()).ok, true);
  evidence.syntheticVideo = { sha256: fileSha(synthetic), recipeSha256: fileSha(generatorSource),
    generatedSeconds: 29, fps: 10, bytes: fs.statSync(synthetic).size };

  // Python and every Python subprocess inherit this read-only guard. It blocks
  // credential access, networking, and writes outside this isolated run.
  const guard = path.join(tmp, 'python-guard');
  fs.mkdirSync(guard);
  fs.writeFileSync(path.join(guard, 'sitecustomize.py'), `import json, os, sys
sys.dont_write_bytecode = True
root = os.path.realpath(os.environ['SH_WORKFLOW_TMP'])
log = os.environ['SH_WORKFLOW_GUARD_LOG']
def refuse(kind):
    with open(log, 'a', encoding='utf-8') as out:
        out.write(json.dumps({'blocked': kind}) + '\\n')
    raise RuntimeError('workflow guard blocked ' + kind)
def local(value):
    if isinstance(value, int) or value is None:
        return True
    name = os.path.realpath(os.fsdecode(value))
    return name == root or name.startswith(root + os.sep) or name == '/dev/null'
def audit(event, args):
    if event.startswith('socket.') and event in ('socket.connect', 'socket.getaddrinfo', 'socket.gethostbyname'):
        refuse('network')
    if event == 'open':
        name, mode, flags = args
        if not isinstance(name, int):
            text = os.fsdecode(name).lower()
            if 'credential' in text or '/.config/opencode/' in text or '/secrets/' in text:
                refuse('credentials')
        if isinstance(flags, int) and flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND):
            if not local(name): refuse('outside-temp-write')
    if event in ('os.remove', 'os.rmdir', 'os.mkdir') and not local(args[0]):
        refuse('outside-temp-mutation')
    if event in ('os.rename', 'os.replace') and (not local(args[0]) or not local(args[1])):
        refuse('outside-temp-mutation')
sys.addaudithook(audit)
`);
  // The CLI freshness boundary may otherwise refresh production audit state.
  // Use its explicit selftest seam, labelled as a fixture rather than a live check.
  const freshnessFixture = path.join(tmp, 'fixture-daily-health.json');
  fs.writeFileSync(freshnessFixture, JSON.stringify({ stale_layers: [], health: 'OFFLINE FIXTURE',
    gate_ok: 0, gate_red: 0, run_id: 'offline-fixture-not-live-freshness' }));
  const pythonEnv = { ...process.env, KB_ROOT: kbRoot, KB_INTERP_OK: '1', KB_ENTRY: 'selftest',
    KB_GATE_DAILY_JSON: freshnessFixture, KB_FRESHNESS_AUTORUN: '0',
    PYTHONDONTWRITEBYTECODE: '1', PYTHONPYCACHEPREFIX: path.join(tmp, 'pycache'),
    PYTHONPATH: guard, SH_WORKFLOW_TMP: tmp, SH_WORKFLOW_GUARD_LOG: guardLog };

  for (let round = 1; round <= 3; round++) {
    const badFrame = round === 3;
    console.log(`[workflow] round ${round}: real 29s probe/OCR; ${badFrame ? 'one failed scene must refuse' : 'complete scene fixture'}`);
    const counts = { ocr: 0, scene: 0, engine: 0, independentModel: 0 };
    evidence.pendingRound = { round, expected: badFrame ? 'NEEDS_INPUT' : 'complete_three_state', counts };
    const downloadDir = fs.mkdtempSync(path.join(tmp, `round-${round}-`));
    const download = path.join(downloadDir, 'current.mp4');
    fs.copyFileSync(synthetic, download);
    let readResult;
    let extractedDir;
    let originalFrameHashes;
    const inbound = await readInboundContent({ message_id: `om_offline_workflow_${round}`,
      message_type: 'media', content: JSON.stringify({ file_key: 'same-video-bytes', file_name: 'same.mp4' }) }, {
      loadParent: async () => ({ text: '请完整审查当前视频', images: [], videos: [] }),
      fetchVideo: async () => ({ path: download, bytes: fs.statSync(download).size,
        cleanup: () => fs.rmSync(downloadDir, { recursive: true, force: true }) }),
      readVideoFn: async file => {
        readResult = await readVideo(file, {
          ocr: async frame => { counts.ocr++; evidence.totals.ocr++; return ocrImage(frame); },
          scene: async file => {
            const index = counts.scene++;
            evidence.totals.scene++;
            assert.equal(fs.existsSync(file), true, 'scene boundary must receive a real extracted frame');
            if (badFrame && index === 2) return { ok: false, error: 'workflow fixture frame 3 failed' };
            return { ok: true, ms: 0, scene: {
              setting: `WORKFLOW_SCENE_${index + 1}`,
              people: index === 2 ? [{ kind: '婴幼儿', panel: '中部',
                doing: '婴儿被成人俯卧放到床上入睡', sleep_scene: true,
                sleep_posture: '俯卧', sleep_posture_basis: '婴儿胸腹向床面，成人正在放下' }]
                : [{ kind: '成人', doing: '站立展示产品', sleep_scene: false, sleep_posture: '不适用' }],
              products: [], visible_marks: [], clean_text: index === 2 ? ['6-month-old baby'] : [],
              risk_cues: [], unclear: [],
            } };
          },
          asrFn: async () => { throw new Error('synthetic video has no audio; ASR must not be invented'); },
        });
        extractedDir = readResult.outDir;
        if (extractedDir) temporaryMediaDirectories.add(extractedDir);
        originalFrameHashes = readResult.sampleFramePaths.map(fileSha);
        return readResult;
      },
    });
    for (const current of inbound.videos) {
      if (current.modelFrameDir) temporaryMediaDirectories.add(current.modelFrameDir);
    }
    const video = inbound.videos[0];
    assert.equal(counts.ocr, 30);
    assert.equal(counts.scene, 6);
    assert.equal(video.framesRead, 30);
    assert.equal(video.framesFailed, 0);
    assert.equal(video.scenePlan.length, 6);
    assert.equal(video.modelFramePaths.length, 6);
    assert.equal(video.meta.has_audio, false);
    assert.equal(video.transcript.kind, 'no_audio_track');
    assert.match(video.ocrText, /Momcozy M5/i);
    assert.equal(fs.existsSync(downloadDir), false);
    assert.equal(fs.existsSync(extractedDir), false);
    const retainedDir = video.modelFrameDir;
    const reports = [], rows = [];
    let engineDoc;
    let material;
    let modelPaths;
    // The gate deliberately catches boundary failures. A test assertion inside
    // a boundary must still fail this test, even in the expected-refusal round.
    const boundaryErrors = [];
    const checkedBoundary = fn => async (...args) => {
      try { return await fn(...args); }
      catch (error) { boundaryErrors.push(error); throw error; }
    };
    const result = await withAgentTurnContext(() => runSubmissionGate({
      inbound, question: inbound.text, userText: inbound.text, notify: null,
      chainRunner: checkedBoundary(async input => {
        counts.engine++;
        evidence.totals.engine++;
        assert.equal(input.contentType, 'video');
        material = input.text;
        assert.match(material, /Momcozy M5/i);
        const materialFile = path.join(tmp, `material-${round}.txt`);
        const reportsDir = path.join(tmp, `engine-reports-${round}`);
        fs.mkdirSync(reportsDir);
        fs.writeFileSync(materialFile, material);
        let child;
        try {
          child = await exec('/usr/bin/python3', [enginePath, '--i-am-the-entry', '--file', materialFile,
            '--content-type', 'video', '--json', '--dry-run', '--report-dir', reportsDir,
            '--run-id', `offline-video-workflow-${round}`],
          { env: pythonEnv, timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
        } catch (error) {
          if (Number(error.code) === 3 && error.stdout?.trim()) {
            child = { stdout: error.stdout, stderr: error.stderr };
          } else {
            throw new Error(`actual KB CLI failed (${error.code}): ${String(error.stderr || error.message).slice(-2000)}`);
          }
        }
        engineDoc = JSON.parse(child.stdout);
        fs.mkdirSync(evidenceDir, { recursive: true });
        fs.writeFileSync(path.join(evidenceDir, `flow-workflow-material-${round}.txt`), material);
        fs.writeFileSync(path.join(evidenceDir, `flow-workflow-engine-${round}.json`), JSON.stringify(engineDoc, null, 2) + '\n');
        Object.assign(evidence.pendingRound, { materialSha256: sha(material), material,
          engineState: engineDoc.state, engineFindings: engineDoc.findings,
          engineNegativeTrace: engineDoc.trace?.negative_rules });
        assert.deepEqual(fs.readdirSync(reportsDir), [], 'dry-run must not publish any engine report');
        const state = engineDoc.state === '拒答' ? 'NEEDS_INPUT' : engineDoc.state;
        for (const finding of engineDoc.findings || []) {
          assert.doesNotMatch([finding.description, finding.reason, finding.advice].join(' '),
            /静音程度夸大|low noise|quiet mode/i,
            'no-audio metadata must never become an advertising claim');
        }
        if (!badFrame) assert.ok(['PASS', 'REVIEW', 'BLOCK'].includes(state), `actual engine did not accept fixture: ${state}`);
        const negative = engineDoc.trace.negative_rules;
        assert.equal(negative.frames_scanned, badFrame ? 5 : 6);
        assert.equal(negative.frame_scans.length, badFrame ? 5 : 6);
        if (badFrame) {
          assert.equal(negative.frame_scene_errors.length, 1);
          assert.equal(negative.frame_scene_errors[0].video, 1);
          assert.match(negative.frame_scene_errors[0].reason, /scene JSON/);
        } else assert.deepEqual(negative.frame_scene_errors, []);
        for (const observed of negative.frame_scans) {
          assert.equal(observed.video, 1);
          assert.ok(video.scenePlan.some(time => Math.abs(time - observed.t_s) < 0.05));
        }
        const visual = engineDoc.trace.visual_rules;
        assert.equal(visual.executed, true);
        assert.ok(visual.rules_scanned > 0);
        assert.equal(visual.frames_scanned, badFrame ? 5 : 6);
        assert.deepEqual(visual.source_errors, []);
        assert.ok(visual.source_checks.length > 0 && visual.source_checks.every(check => check.verified));
        assert.equal(engineDoc.findings.some(finding => finding.rule_id === 'VIS-SLEEP-POSITION'), !badFrame,
          'the actual engine must consume the current infant scene; the failed scene cannot provide a finding');
        if (!badFrame) assert.equal(state, 'REVIEW');
        return { answer: [
          '审核对象与范围：本次合成29秒视频，仅覆盖本轮列出的采样画面及无音轨读数。',
          '视觉分析与 OCR：OCR为本机真实读数；画面说明为明确标记的离线模型边界夹具。',
          '主张拆分与核查清单：核对当前视频画面与字幕。',
          '4A 规则符合性：以下判据来自本轮实际KB引擎 dry-run。',
          '4B 事实准确性核查：仅使用本轮合成素材和已登记事实，不声称调用真实模型。',
          '音画一致性：本机探针确认无音轨，未伪造口播。',
          engineDoc.rendered,
        ].join('\n'), review: { state, issue_count: engineDoc.findings.length,
          facets: { product_line: '离线合成试纸', channel: '自证' } },
        engine: { ...engineDoc, decision: { decision: state }, evidence_meta: {
          trace: engineDoc.trace,
          decision_owner: { skill: '视频安全审查', mode: 'offline_fixture', loaded_skills: ['视频安全审查'] },
          video_skill_gate: { ok: true, expected: '视频安全审查', owner: '视频安全审查',
            evidence_kind: 'offline_fixture_not_a_live_load', load: { skill: '视频安全审查', verdict: 'loaded',
              session: '/fixture/not-a-live-session', calls: [{ callId: 'fixture-only', seq: 1, verdict: 'loaded' }] } },
          layer_preflight: { ok: true, mode: 'enforced', red_total: 0, fixture: true,
            details: Object.fromEntries(['L4', 'L5', 'L6', 'L7'].map(layer => [layer, { pass: true, exit: 0, red: 0 }])) },
        } } };
      }),
      modelSideRunner: checkedBoundary(async input => {
        counts.independentModel++;
        evidence.totals.independentModel++;
        modelPaths = [...input.imagePaths];
        assert.equal(input.requiredImageCount, 6);
        assert.equal(modelPaths.length, 6);
        assert.deepEqual(modelPaths.map(fileSha), originalFrameHashes);
        await new Promise(resolve => setImmediate(resolve));
        assert.ok(modelPaths.every(file => fs.existsSync(file)), 'original frames must survive until model completion');
        return { ok: true, ms: 0, dropped: [], findings: [{ category: '信息表达',
          location: '视频 00:15', severity: 'REVIEW', nature: 'mandatory',
          description: `WORKFLOW_MODEL_${round}`, reason: `WORKFLOW_MODEL_${round}：离线模型边界夹具`,
          suggestion: '仅验证本轮链路，不代表真实内容问题', evidence_basis: 'image_observation',
          visual_anchor: '视频 00:15：合成试纸', basis_kind: 'visual_observation', basis_missing: false }] };
      }),
      publishRunner: async row => { rows.push(structuredClone(row)); return { ok: true, action: 'skipped' }; },
      mergedReportRunner: async markdown => { reports.push(markdown); return { ok: true, url: 'https://example.invalid/workflow-report' }; },
      adviceRunner: async () => ({ ok: true, ms: 0, advice: {} }), mediaLinksRunner: async () => [],
    }));
    if (boundaryErrors.length) throw boundaryErrors[0];
    assert.ok(engineDoc, 'real engine must return before asserting a final workflow result');
    assert.equal(result.videoReviewIncomplete, badFrame, result.videoCompletion?.reason);
    assert.equal(rows.length, 1);
    const card = toCardOrText(result.reviewDirectReply || result.forcedReply || '', {
      verdict53: result.verdict53, reportLink: result.dual?.reportUrl || null,
      reviewRequired: !result.verdict53, reviewReason: inbound.videoGateReason || null,
    });
    assert.equal(card.mode, 'card');
    const cardText = JSON.stringify(card.card);
    if (badFrame) {
      assert.equal(result.verdict53, null);
      assert.equal(rows[0].conclusion, 'NEEDS_INPUT');
      assert.equal(reports.length, 0);
      assert.match(cardText, /未完成/);
      assert.match(cardText, /workflow fixture frame 3 failed/);
    } else {
      assert.ok(result.verdict53?.line);
      assert.equal(rows[0].conclusion, result.verdict53.state);
      for (let frame = 1; frame <= 6; frame++) assert.ok(cardText.includes(`WORKFLOW_SCENE_${frame}`));
      assert.ok(cardText.includes(`WORKFLOW_MODEL_${round}`));
      if (round === 2) assert.ok(!cardText.includes('WORKFLOW_MODEL_1'), 'second send must not reuse first model result');
    }
    assert.ok(modelPaths.every(file => !fs.existsSync(file)));
    assert.equal(fs.existsSync(retainedDir), false);
    assert.equal(fs.existsSync(path.join(tmp, 'state/image-review-results.json')), false);
    evidence.rounds.push({ round, expected: badFrame ? 'NEEDS_INPUT' : 'complete_three_state', counts,
      duration_s: video.meta.duration_s, materialSha256: sha(material), scenePlan: video.scenePlan,
      ocrFramesRead: video.framesRead, sceneSuccesses: video.frameScene.filter(frame => frame.ok).length,
      sceneFailures: video.frameScene.filter(frame => !frame.ok).length,
      frameHashes: originalFrameHashes, engineState: engineDoc.state,
      engineFramesScanned: engineDoc.trace.negative_rules.frames_scanned,
      engineFrameScans: engineDoc.trace.negative_rules.frame_scans,
      engineFrameSceneErrors: engineDoc.trace.negative_rules.frame_scene_errors,
      engineVisualTrace: engineDoc.trace.visual_rules,
      engineFindings: engineDoc.findings, verdict: result.verdict53?.state || null,
      rowConclusion: rows[0].conclusion, reportCalls: reports.length,
      retainedFramesCleaned: true, cardSha256: sha(cardText) });
    delete evidence.pendingRound;
    console.log(`[workflow] round ${round}: OCR=${counts.ocr} scene=${counts.scene} engine=${counts.engine} model=${counts.independentModel} -> ${rows[0].conclusion}`);
  }
  assert.deepEqual(evidence.totals, { ocr: 90, scene: 18, engine: 3, independentModel: 3 });
  assert.equal(evidence.rounds[0].materialSha256, evidence.rounds[1].materialSha256,
    'repeat-send control must really submit identical current material');
  assert.deepEqual(evidence.rounds[0].frameHashes, evidence.rounds[1].frameHashes,
    'repeat-send control must deliver identical original frames independently');
  assert.equal(networkAttempts, 0);
  assert.equal(fs.existsSync(guardLog) ? fs.readFileSync(guardLog, 'utf8') : '', '');
  evidence.sourceHashesAfter = sourceHashes();
  assert.deepEqual(evidence.sourceHashesAfter, evidence.sourceHashesBefore, 'source changed during workflow acceptance');
  evidence.ok = true;
} catch (error) {
  evidence.ok = false;
  evidence.error = error.stack || String(error);
  console.error(evidence.error);
  process.exitCode = 1;
} finally {
  if (!evidence.sourceHashesAfter) {
    try { evidence.sourceHashesAfter = sourceHashes(); }
    catch (error) { evidence.sourceHashReadError = String(error.message || error); }
  }
  evidence.networkAttempts = networkAttempts;
  evidence.pythonGuardEvents = fs.existsSync(guardLog)
    ? fs.readFileSync(guardLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  evidence.finished = new Date().toISOString();
  fs.readFileSync = originalRead;
  globalThis.fetch = originalFetch;
  net.Socket.prototype.connect = originalConnect;
  dns.lookup = originalLookup;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  for (const dir of temporaryMediaDirectories) fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
  evidence.temporaryDirectoryCleaned = !fs.existsSync(tmp);
  evidence.temporaryMediaDirectoriesCleaned = [...temporaryMediaDirectories].every(dir => !fs.existsSync(dir));
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, 'flow-workflow-results.json'), JSON.stringify(evidence, null, 2) + '\n');
}
console.log(`video_workflow: ${evidence.rounds.length}/3, real network attempts=${networkAttempts}`);

#!/usr/bin/env node
/** Independent wiring regression: real gate/prompt/merge, replaced external boundaries. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import dns from 'node:dns/promises';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { loadImageFactSources } from './image_fact_sources.mjs';
import { adjudicateImageClaims } from './image_claim_review.mjs';
import { reviewFixtureClaims, fixtureAssessment, decodeFixtureClaimRequest } from './__fixtures__/image-claim-review.mjs';

assert.match(process.env.NODE_OPTIONS || '', /offline-preload\.cjs/,
  'Run via the PMO run-check.py helper so imports cannot read real credentials');
const state = fs.realpathSync(process.env.SHOUHENG_STATE_DIR || '');
assert.ok(/^(?:\/private)?\/(?:tmp|var\/folders)\//.test(state), 'State must be an isolated temporary directory');
const root = process.env.SHOUHENG_KB_ROOT;
const { sources, errors } = loadImageFactSources(root);
assert.deepEqual(errors, []);
assert.equal(sources.length, 1, 'Use the hash-verified actual local snapshot');
const snapshotId = sources[0].id;
const quote = 'Side sleeping is not safe and is not advised.';
const originalEnv = { ...process.env };
const originals = [];
const replace = (object, key, value) => { originals.push([object, key, object[key]]); object[key] = value; };
let externalAttempts = 0;
const rejectExternal = () => { externalAttempts++; throw new Error('Offline wiring test forbids network/subprocess'); };
replace(globalThis, 'fetch', rejectExternal);
replace(net.Socket.prototype, 'connect', rejectExternal);
replace(dns, 'lookup', rejectExternal);
for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  replace(childProcess, key, rejectExternal);
}
let forbiddenWrites = 0;
let existingLogDirectoryNoops = 0;
let importingCore = true;
const checkWrite = (file) => {
  const p = path.resolve(String(file));
  const existing = fs.existsSync(p) ? fs.realpathSync(p) : p;
  const tempState = existing === state || existing.startsWith(state + '/')
    || fs.existsSync(path.dirname(p)) && fs.realpathSync(path.dirname(p)).startsWith(state);
  if (!tempState && !/^\/(?:private\/)?tmp\/shouheng-chain-img-[^/]+(?:\/|$)/.test(p)) {
    forbiddenWrites++;
    throw new Error('Offline wiring test forbids non-temporary write: ' + p);
  }
};
for (const key of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'unlinkSync', 'truncateSync']) {
  const original = fs[key];
  replace(fs, key, function(file, ...args) {
    // config.mjs ensures this existing directory during import. Stub the call;
    // neither create nor mutate the production log directory in this test.
    if (key === 'mkdirSync' && importingCore && args[0]?.recursive === true
      && path.resolve(String(file)) === path.resolve('PMO/logs')
      && fs.existsSync(file) && fs.statSync(file).isDirectory()) {
      existingLogDirectoryNoops++;
      return undefined;
    }
    checkWrite(file); return original.call(this, file, ...args);
  });
}
for (const key of ['copyFileSync', 'renameSync']) {
  const original = fs[key];
  replace(fs, key, function(from, to, ...args) { checkWrite(to); return original.call(this, from, to, ...args); });
}
syncBuiltinESMExports();
Object.assign(process.env, {
  SHOUHENG_REVIEW_TABLE: 'off', SHOUHENG_MEDIA_LINK: 'off', SHOUHENG_MERGED_RECORD: 'off',
  SH_FORCE_REPORT: '0', KB_CONF_LEDGER: path.join(state, 'fact-wiring-confidence.ndjson'),
});

const cases = [];
const test = async (name, fn) => {
  try { await fn(); cases.push({ name, ok: true }); }
  catch (error) { cases.push({ name, ok: false, detail: error.stack }); }
};
const row = (claim, result, boundary, id = '—', text = '—') =>
  `| C1：${claim} | ${result} | ${boundary} | ${id} | ${text} |`;
const report = ({ claim = '白色摄像头', factRow = row('白色摄像头', '画面可确认', '图1右侧可见白色外壳与镜头'),
  visual = '左侧摆着两个蓝色杯子，右侧是一把红色椅子。', visualList = '' } = {}) => `### 审核对象与范围
图1整图，审核画面与图中文字。
### 视觉分析与 OCR
${visual}
### 主张拆分与核查清单
C1：${claim}。
### 4A 规则符合性
L4至L7已核，命中0条，对该主题缺少覆盖。
### 4B 事实准确性核查
| 主张 | 核查结论 | 依据及边界 | 来源 | 来源原文 |
| --- | --- | --- | --- | --- |
${factRow}
### 图文一致性与信息完整性
标题与外壳颜色的关系一致，未据外观推断功能。
### 视觉核对
${visualList || '婴幼儿姿势：无\n婴儿睡眠位置：无（画面没有婴儿睡眠场景）\n产品状态：无\n场景关系：无\n隐私：无'}
### 问题清单
1. 无`;
const scene = (people = []) => ({ setting: '影棚', people,
  products: [{ what: '白色设备', orientation: '正放' }],
  visible_marks: [], text_script: '英文', clean_text: ['White camera'], risk_cues: [], unclear: [] });
const infantScene = scene([{ kind: '婴幼儿', panel: '中部', doing: '被抱着', sleep_scene: false,
  sleep_posture: '不适用' }]);
const adultScene = scene([{ kind: '成人', panel: '中部', doing: '手持设备', sleep_scene: false,
  sleep_posture: '不适用' }]);

try {
  const { runSubmissionGate } = await import('./agent.mjs');
  const { withAgentTurnContext, reviewTaskFor } = await import('./tools.mjs');
  importingCore = false;
  let serial = 0;
  async function run({ type = 'image', sceneValue = scene(), answer = report(),
    factSources = sources, materialText = 'White camera', hits = [], afterCapture = async () => {},
    stopAtChain = false, claimReviewer = reviewFixtureClaims } = {}) {
    const id = ++serial;
    const inbound = { text: type === 'text' ? '请审核这段广告：白色设备。' : '审核',
      chatType: 'p2p', chatId: 'oc_fact_wiring_fixture', imageCount: type === 'image' ? 1 : 0,
      videoCount: type === 'video' ? 1 : 0, images: [], videos: [] };
    if (type === 'image') inbound.images.push({ index: 1, msgId: `om_fact_wiring_${id}`,
      imageKey: `image_fixture_${id}`, text: materialText, wlText: materialText,
      scene: { ok: true, scene: structuredClone(sceneValue) } });
    if (type === 'video') inbound.videos.push({ index: 1, frames: [], frameScene: [],
      framesRead: 0, scenePlan: [], modelFramePaths: [], meta: { duration_s: 1, has_audio: false },
      transcript: { ok: false, kind: 'no_audio_track' } });
    const observed = { rows: [], reports: [], captures: [], claimInputs: [], claimAssessments: [], loaders: 0, scopes: 0 };
    const result = await withAgentTurnContext(() => runSubmissionGate({
      inbound, question: inbound.text, userText: inbound.text,
      factSourceLoader: () => { observed.loaders++; return { sources: structuredClone(factSources), errors: [] }; },
      chainRunner: async (input) => {
        const capture = () => ({ ids: (input.imageFactSources ?? []).map(s => s.id),
          prompt: reviewTaskFor({ ctype: input.contentType, question: input.question, text: input.text,
            imagePaths: input.imagePaths }), type: input.contentType });
        observed.captures.push(capture());
        await afterCapture();
        observed.captures.push(capture());
        if (stopAtChain) return { error: 'deliberate offline stop after prompt capture',
          review: { facets: { product_line: '测试', channel: '测试' } } };
        const refusal = { state: 'NEEDS_INPUT', reason_code: 'coverage_not_covered',
          fails_closed: true, coverage: { covered: false } };
        return { answer, review: { state: 'REVIEW', issue_count: 0, candidate_count: 0, refusal,
          confidence: null, facets: { product_line: '测试', channel: '测试' } },
          engine: { decision: { state: 'REVIEW', issue_count: 0, refusal },
            evidence_meta: { kb_hits: structuredClone(hits), image_skill_gate: {
              ok: true, load: { verdict: 'loaded' } } } } };
      },
      modelSideRunner: async () => ({ ok: true, findings: [], dropped: [], ms: 0 }),
      imageClaimRunner: async (input) => {
        observed.scopes++; observed.claimInputs.push(structuredClone(input));
        assert.deepEqual(input.scenes, [sceneValue], 'the registered reviewer must read only this turn scene');
        assert.equal(input.materialTexts.find(item => item.origin === 'image_ocr')?.text, materialText);
        assert.deepEqual(input.sources.slice(0, factSources.length), factSources);
        const assessment = await claimReviewer(input);
        observed.claimAssessments.push(assessment);
        return assessment;
      },
      publishRunner: async data => { observed.rows.push(structuredClone(data)); return { ok: true, action: 'skipped' }; },
      mergedReportRunner: async data => { observed.reports.push(data); return { ok: true, url: '' }; },
      adviceRunner: async () => ({ ok: true, advice: {}, ms: 0 }),
      mediaLinksRunner: async () => [],
      fetchImageForLink: async (_message, _key, { dir }) => {
        const destination = path.join(dir, 'fixture.png');
        fs.copyFileSync(new URL('./__fixtures__/ocr-sample.png', import.meta.url), destination);
        return { path: destination };
      },
    }));
    assert.equal(observed.captures.length, 2, 'Real gate must call the chain exactly once');
    return { result, observed, inbound };
  }
  const assertPass = sample => {
    assert.equal(sample.result.imageReviewIncomplete, false, sample.inbound.imageGateReason);
    assert.equal(sample.result.verdict53?.state, 'PASS');
    assert.equal(sample.observed.rows.length, 1);
    assert.equal(sample.observed.rows[0].conclusion, 'PASS');
    assert.equal(sample.observed.scopes, 1, 'Every complete image receives one current-claim review');
  };
  const assertWithheld = sample => {
    assert.equal(sample.result.imageReviewIncomplete, true);
    assert.equal(sample.result.verdict53, null);
    assert.equal(sample.observed.rows[0].conclusion, 'NEEDS_INPUT');
    assert.equal(sample.observed.reports.length, 0);
  };

  await test('Concurrent infant/adult/product/text/video prompts retain their own source scope', async () => {
    let started = 0, release;
    const barrier = new Promise(resolve => { release = resolve; });
    const inputs = [{ sceneValue: infantScene, wants: true }, { sceneValue: adultScene, wants: true },
      { wants: true }, { type: 'text', wants: false }, { type: 'video', wants: false }];
    const outputs = await Promise.all(inputs.map(input => run({ ...input, stopAtChain: true,
      afterCapture: async () => { if (++started === inputs.length) release(); await barrier; } })));
    for (const [index, sample] of outputs.entries()) {
      const expected = inputs[index].wants ? [snapshotId] : [];
      for (const capture of sample.observed.captures) {
        assert.deepEqual(capture.ids, expected);
        assert.equal(capture.prompt.includes(`source_id=${snapshotId}`), inputs[index].wants);
      }
      assert.equal(sample.observed.loaders, ['text', 'video'].includes(inputs[index].type) ? 0 : 1);
    }
  });
  await test('Concurrent completed turns keep checker inputs and source fingerprints separate', async () => {
    let started = 0, release;
    const barrier = new Promise(resolve => { release = resolve; });
    const materials = [
      { materialText: 'Camera A', sceneValue: { ...scene(), setting: '图 A 场景' }, factSources: sources },
      { materialText: 'Camera B', sceneValue: { ...scene(), setting: '图 B 场景' }, factSources: [] },
    ];
    const samples = await Promise.all(materials.map(input => run({ ...input,
      afterCapture: async () => { if (++started === materials.length) release(); await barrier; } })));
    for (const [index, sample] of samples.entries()) {
      assertPass(sample);
      assert.equal(sample.observed.claimInputs.length, 1);
      assert.deepEqual(sample.observed.claimInputs[0].sources, materials[index].factSources);
      assert.equal(sample.observed.claimInputs[0].scenes[0].setting, materials[index].sceneValue.setting);
      assert.equal(sample.observed.claimInputs[0].materialTexts[0].text, materials[index].materialText);
    }
  });
  for (const [name, sceneValue] of [['product', scene()], ['adult', adultScene]]) {
    await test(`${name}: available safety source does not contaminate a complete zero-finding PASS`, async () => {
      const sample = await run({ sceneValue });
      assertPass(sample);
      assert.deepEqual(sample.observed.captures[0].ids, [snapshotId]);
      assert.match(sample.observed.captures[0].prompt, /source_id=aap-safe-sleep-2022/);
    });
  }
  await test('Non-sleep holding observation completes without any safety source', async () => {
    const sample = await run({ sceneValue: infantScene, factSources: [], answer: report({
      claim: '成人抱着婴儿，未见睡眠场景',
      factRow: row('抱婴观察', '画面可确认', '图1中部婴儿被抱着；只描述人物关系，不作抱姿安全判断'),
      visual: '图1中部婴儿被成人抱着，没有睡眠场景。',
    }) });
    assertPass(sample);
  });
  await test('Actual infant sleep requires its own authority review even when every clause is labelled observation', async () => {
    const sleeping = scene([{ kind: '婴儿', panel: '中部', doing: '仰卧睡眠', sleep_scene: true,
      sleep_posture: '仰卧', sleep_posture_basis: '面部朝上，后背接触床面' }]);
    const sample = await run({ sceneValue: sleeping, factSources: [], answer: report({
      claim: '图1中部婴儿仰卧睡眠', factRow: row('婴儿仰卧睡眠', '画面可确认', '面部朝上，后背接触床面，仅作姿态观察'),
      visual: '图1中部婴儿仰卧睡眠；面部朝上，后背接触床面。',
      visualList: '婴幼儿姿势：无（图1中部仰卧）\n婴儿睡眠位置：无（图1中部婴儿仰卧，面部朝上且后背接触床面）\n产品状态：无\n场景关系：无\n隐私：无',
    }), claimReviewer: input => adjudicateImageClaims(input, { chat: async messages => {
      const evidence = decodeFixtureClaimRequest(messages);
      const response = fixtureAssessment(evidence);
      for (const decision of response.decisions) decision[1] = 'o';
      for (const claim of response.claims) claim.kind = 'observation';
      return { ok: true, finishReason: 'stop', message: { content: JSON.stringify(response) } };
    } }) });
    assert.equal(sample.observed.scopes, 1, 'complete visual report must reach the real claim checker');
    assertWithheld(sample);
    assert.match(sample.inbound.imageGateReason, /睡眠|AAP|权威/);
  });
  await test('Actual infant sleep with a dedicated safety claim and applicable AAP quotation completes', async () => {
    const sleeping = scene([{ kind: '婴儿', panel: '中部', doing: '仰卧睡眠', sleep_scene: true,
      sleep_posture: '仰卧', sleep_posture_basis: '面部朝上，后背接触床面' }]);
    const sample = await run({ sceneValue: sleeping, answer: report({
      claim: '图1中部婴儿侧卧安全建议', factRow: row('图1中部婴儿侧卧安全建议', '不支持',
        '本图中部为婴儿睡眠；逐字政策不支持侧卧安全，实际观察为仰卧，不外推产品安全', snapshotId, quote),
      visual: '图1中部婴儿仰卧睡眠；面部朝上，后背接触床面。',
      visualList: '婴幼儿姿势：无（图1中部仰卧）\n婴儿睡眠位置：无（图1中部婴儿仰卧，面部朝上且后背接触床面）\n产品状态：无\n场景关系：无\n隐私：无',
    }) });
    assertPass(sample);
    assert.equal(sample.observed.claimAssessments[0].sleepReviews.length, 1);
    assert.equal(sample.observed.claimAssessments[0].sleepReviews[0].claimId, 'C1');
  });
  await test('Actual infant material receives the local snapshot and can complete with a real quote', async () => {
    const answer = report({ claim: '婴儿侧卧安全建议', factRow: row('婴儿侧卧安全建议', '不支持',
      '快照限一岁以内婴儿，原句说明侧卧不安全；本图被抱姿势不据此推断为睡眠', snapshotId, quote) });
    const sample = await run({ sceneValue: infantScene, answer });
    assertPass(sample);
    const prompt = sample.observed.captures[0].prompt;
    assert.match(prompt, /本地快照，非本次联网，非本轮知识库检索命中/);
    assert.match(prompt, /July 2022/);
    assert.match(prompt, /不表示已联网确认最新版本/);
  });
  await test('Unknown product fact with a concrete evidence gap still completes and preserves PASS policy', async () => {
    const sample = await run({ answer: report({ claim: '陶瓷杯容量350毫升', factRow: row('陶瓷杯容量350毫升',
      '无法确认', '缺少该批次容量实测记录，外观无法确定容积') }) });
    assertPass(sample);
    assert.equal(sample.observed.claimAssessments[0].claims[0].kind, 'other_fact');
  });
  await test('Rule-compliance findings do not manufacture a product-safety citation requirement', async () => {
    const sample = await run({ answer: report({ claim: '本图未命中已登记违规规则',
      factRow: row('本图未命中已登记违规规则', '不适用',
        '仅报告本轮L4至L7执行读数，不宣称产品安全，也不据未命中证明事实真实') }) });
    assertPass(sample);
    assert.equal(sample.observed.claimAssessments[0].claims[0].kind, 'rule_compliance');
  });
  await test('A rule-compliance statement cannot cover a mixed actual safety guarantee', async () => {
    const claim = '本图未命中已登记违规规则，本品绝对安全';
    const sample = await run({ answer: report({ claim,
      factRow: row(claim, '不适用', '仅报告本轮规则未命中，没有本产品安全原文可核对') }) });
    assertWithheld(sample);
    assert.equal(sample.observed.claimAssessments[0].claims[0].kind, 'safety_claim');
    assert.match(sample.inbound.imageGateReason, /安全断言.*来源/);
  });
  await test('Unknown infant scope cannot be resolved by an unrelated safety quotation', async () => {
    const unknown = scene([{ kind: '分不清', panel: '中部', doing: '被前景遮挡',
      sleep_scene: false, sleep_posture: '不适用' }]);
    unknown.unclear = ['人物年龄无法辨认'];
    const sample = await run({ sceneValue: unknown, answer: report({ claim: '人物年龄',
      factRow: row('人物年龄', '无法确认',
        '遮挡使年龄无法辨认；政策只用于说明婴儿安全适用范围，不能据此认定人物年龄', snapshotId, quote),
      visual: '中部人物被前景遮挡，年龄无法辨认；未观察到睡眠场景。',
      visualList: '婴幼儿姿势：未测（中部人物被前景遮挡，年龄无法辨认）\n婴儿睡眠位置：无（未观察到睡眠场景）\n产品状态：无\n场景关系：无\n隐私：无',
    }) });
    assertWithheld(sample);
    assert.deepEqual(sample.observed.captures[0].ids, [snapshotId]);
  });
  const hit = { anchor: '#fixture-current', url: 'https://example.invalid/current', kb_type: 'wording',
    excerpt: '本型号的可拆卸外壳为白色，颜色说明不代表任何性能承诺。', source_sha256: 'a'.repeat(64) };
  await test('Current KB excerpt is accepted without upgrading to a full-document or AAP source', async () => {
    const sample = await run({ hits: [hit], answer: report({ factRow: row('白色外壳', '支持',
      '只支持外壳颜色，不能推出性能', 'kb:1', hit.excerpt) }) });
    assertPass(sample);
  });
  for (const [name, sourceId, quoted] of [
    ['fabricated AAP quote', snapshotId, 'This fabricated policy sentence is not present in the approved snapshot.'],
    ['mismatched current KB quote', 'kb:1', '本型号已经通过医学研究，可以完全预防任何婴儿睡眠风险。'],
    ['nonexistent current source', 'kb:9', hit.excerpt],
  ]) {
    await test(`${name} withholds publication instead of accepting a source name`, async () => {
      const sample = await run({ hits: [hit], answer: report({ factRow: row('白色外壳', '支持',
        '只核对当前这一条来源原文', sourceId, quoted) }) });
      assertWithheld(sample);
      assert.match(sample.inbound.imageGateReason, /4B 事实准确性核查/);
    });
  }
  await test('Missing local snapshot does not reject a non-infant image', async () => {
    assertPass(await run({ factSources: [] }));
  });
  await test('Missing required snapshot is not replaced by an AAP source name', async () => {
    const sample = await run({ factSources: [], sceneValue: infantScene,
      answer: report({ claim: '婴儿侧卧安全建议', factRow: row('婴儿侧卧安全建议', '不支持',
        '政策范围是一岁以内婴儿，不据此推断当前产品的性能', snapshotId, quote) }) });
    assertWithheld(sample);
    assert.match(sample.inbound.imageGateReason, /4B|来源/);
  });
  await test('All cases avoided real network, subprocesses and production-state writes', () => {
    assert.equal(externalAttempts, 0);
    assert.equal(forbiddenWrites, 0);
  });
} finally {
  for (const [object, key, value] of originals.reverse()) object[key] = value;
  syncBuiltinESMExports();
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
}
for (const result of cases) console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.name}${result.detail ? '\n' + result.detail : ''}`);
const failed = cases.filter(result => !result.ok).length;
console.log(`image_fact_wiring: ${cases.length - failed}/${cases.length}; external attempts=${externalAttempts}; forbidden writes=${forbiddenWrites}; existing-log mkdir stubs=${existingLogDirectoryNoops}`);
if (failed) process.exitCode = 1;

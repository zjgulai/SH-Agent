#!/usr/bin/env node
/**
 * Real submission-gate regressions for the 2026-10-30 image refusal incident.
 * The break: publishing before image completion checks leaks a REVIEW report,
 * summary and confidence even though the final reply withholds its verdict.
 * Only slow/external boundaries are replaced; merging, completion checks,
 * report rendering, row construction and final reply selection stay real.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { loadImageFactSources } from './image_fact_sources.mjs';
import { reviewFixtureClaims, fixtureAssessment, completeLegacyFixtureReport, decodeFixtureClaimRequest } from './__fixtures__/image-claim-review.mjs';

// ★ 2026-11-03：本用例钉的是**严格档**的产品承诺（素材安全主张被漏写 ⇒ 不出报告、NEEDS_INPUT）。
//   Owner 同日批准「先回滚到 10-27 验收口径」，生产默认已改为「逐项核查留痕、不否决整单」，
//   严格档仍由 IMAGE_CLAIM_ENFORCE=1 保留。默认档的行为由 image_report_completion.test.mjs
//   与 image_live1401_replay.test.mjs 的对照用例覆盖。
process.env.IMAGE_CLAIM_ENFORCE = '1';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-image-completion-'));
const originalRead = fs.readFileSync;
const originalFetch = globalThis.fetch;
const originalConnect = net.Socket.prototype.connect;
const originalEnv = { ...process.env };
Object.assign(process.env, {
  SHOUHENG_STATE_DIR: tmp, SHOUHENG_KB_ROOT: path.join(tmp, 'absent-kb'),
  SHOUHENG_LLM_API_KEY: 'fixture-only', SHOUHENG_LLM_BASE_URL: 'http://127.0.0.1:9',
  SHOUHENG_VISION_BASE_URL: 'http://127.0.0.1:9', SHOUHENG_VISION_API_KEY: 'fixture-only',
  SHOUHENG_REVIEW_TABLE: 'off', SHOUHENG_MEDIA_LINK: 'off',
  SHOUHENG_MERGED_RECORD: 'off', SH_FORCE_REPORT: '0',
  KB_CONF_LEDGER: path.join(tmp, 'confidence.ndjson'),
});
fs.readFileSync = (file, ...args) => {
  const p = String(file);
  if (p.endsWith('/.dsh/credentials/shouheng-lark.json')) {
    return JSON.stringify({ app_id: 'cli_completion_test', app_secret: 'fixture-only' });
  }
  if (p.endsWith('/.config/opencode/opencode.json')) return '{}';
  if (p.endsWith('/.dsh/.credentials.yaml')) throw new Error('No real credentials in this test');
  return originalRead.call(fs, file, ...args);
};
let networkAttempts = 0;
const rejectNetwork = () => {
  networkAttempts++;
  throw new Error('No real network in this test');
};
globalThis.fetch = rejectNetwork;
net.Socket.prototype.connect = rejectNetwork;

const source = path.join(tmp, 'source.png');
fs.copyFileSync(new URL('./__fixtures__/ocr-sample.png', import.meta.url), source);
const adultAnswer = fs.readFileSync(new URL('./__fixtures__/image-review-20261030.txt', import.meta.url), 'utf8');
const cameraAnswer = fs.readFileSync(new URL('./__fixtures__/image-review-camera-20261030.txt', import.meta.url), 'utf8');
const novemberAnswer = fs.readFileSync(new URL('./__fixtures__/image-review-20261102.txt', import.meta.url), 'utf8');
const compoundAbsenceAnswer = fs.readFileSync(new URL('./__fixtures__/image-review-group-1641-20261102.txt', import.meta.url), 'utf8');
// Exact chain_answer records for the same 2026-11-02 image, without adding citations.
const conversationAnswers = [
  ['private 11:51', 'image-review-p2p-1151-20261102.txt'],
  ['private 12:02', 'image-review-p2p-1202-20261102.txt'],
  ['group 14:33', 'image-review-group-1433-20261102.txt'],
].map(([label, file]) => [label, fs.readFileSync(new URL(`./__fixtures__/${file}`, import.meta.url), 'utf8')]);
const reportUrl = 'https://example.invalid/docx/current-completed-review';
const oldReportUrl = 'https://example.invalid/docx/chain-provisional-review';
const cases = [];
const test = async (name, fn) => {
  try { await fn(); cases.push({ name, ok: true }); }
  catch (error) { cases.push({ name, ok: false, detail: error.message }); }
};

try {
  const { runSubmissionGate } = await import('./agent.mjs');
  const { withAgentTurnContext, runtimeContext } = await import('./tools.mjs');
  const { toCardOrText } = await import('../reply-cards/envelope.mjs');
  // An explicit authority citation keeps the other refusal controls independent
  // of the adult-image AAP false positive, which has its own unmodified fixture.
  const completeAnswer = adultAnswer + '\n4B 核对来源：AAP 安全睡眠政策 '
    + 'https://publications.aap.org/pediatrics/article/doi/10.1542/peds.2022-057990/188304/';
  const incompleteAnswer = completeAnswer.replace(
    /### 4B 事实准确性核查[\s\S]*?(?=### 图文一致性)/, '',
  ).replace(/\n4B 核对来源：[\s\S]*$/, '');
  const multipleSkillFindings = completeAnswer.replace('### ③b 转述模板',
    '2. 型号尾部被装饰遮挡，需确认型号｜中部，图 1 第 2 处｜改：调整装饰位置\n'
    + '3. 底部文字对比度不足，无法辨认｜底部，图 1 第 4 处｜改：提高文字对比度\n\n'
    + '### ③b 转述模板');
  const scene = { ok: true, scene: {
    setting: '居家', people: [{ kind: '成人', panel: '中部', doing: '双手扶设备',
      sleep_scene: false, sleep_posture: '不适用' }],
    products: [{ what: '白色圆形设备', in_use: true, orientation: '正放' }],
    text_script: '英文', visible_marks: ['中部有文字'],
    clean_text: ['IBCLC + mom of', '4 explains', 'Momcozy Air 1', 'Breast Pump'],
    risk_cues: ['成人手持产品'], unclear: [],
  } };
  const findings = [
    { category: '商品信息与Listing准确性', location: '中部，图 1 第 2 处',
      description: '产品型号文字被装饰遮挡', reason: '型号最后一位不可见',
      suggestion: '调整文字位置，露出完整型号', visual_anchor: '图 1 中部型号尾部被装饰遮挡' },
    { category: '信息表达', location: '底部，图 1 第 4 处',
      description: '底部说明字过小', reason: '底部说明无法辨认',
      suggestion: '放大底部说明文字', visual_anchor: '图 1 底部说明字号小于主标题' },
    { category: '隐私', location: '右侧，图 1 第 5 处',
      description: '背景展示可识别门牌', reason: '背景门牌与人物同框',
      suggestion: '遮挡背景门牌', visual_anchor: '图 1 右侧背景门牌' },
  ].map((finding) => ({ ...finding, severity: 'REVIEW', nature: 'mandatory',
    basis_missing: false, basis_kind: 'visual_observation',
    evidence_basis: 'image_observation', source: null, source_url: null }));

  async function run({ answer = completeAnswer, sceneResult = scene,
    engineAccepted = true, modelAccepted = true, type = 'image', chainReport = '',
    completionThrows = false, discardSceneRecords = false, imageReadings = {}, cleanText, formatCompletion = true,
    chatType = 'p2p', modelItems = findings, reviewReadings = {}, factSources = [], imageClaimRunner = reviewFixtureClaims } = {}) {
    if (formatCompletion) answer = completeLegacyFixtureReport(answer);
    const writes = { reports: [], rows: [], images: [], scopes: [], chain: 0, model: 0 };
    const currentScene = structuredClone(sceneResult);
    if (cleanText !== undefined) currentScene.scene.clean_text = structuredClone(cleanText);
    const inbound = type === 'image'
      ? { text: '审核', imageCount: 1, videoCount: 0, videos: [], images: [{ index: 1,
          msgId: 'om_current_image', imageKey: 'img_current_image',
          text: 'IBCLC + mom of\n4 explains\nMomcozy Air 1\nBreast Pump',
          wlText: 'IBCLC + mom of\n4 explains\nMomcozy Air 1\nBreast Pump',
          ...imageReadings, scene: currentScene }] }
      : { text: '请审核这段广告文案：产品型号需要核对。', imageCount: 0, videoCount: 0,
          images: [], videos: [] };
    inbound.chatType = chatType;
    inbound.chatId = `oc_fixture_${chatType}`;
    const priorRuntime = { ...runtimeContext };
    Object.assign(runtimeContext, { chatType, chatId: inbound.chatId });
    let result;
    try {
      result = await withAgentTurnContext(() => runSubmissionGate({
      inbound, question: inbound.text, userText: inbound.text, notify: async () => {},
      factSourceLoader: () => ({ sources: factSources, errors: [] }),
      imageClaimRunner: async (input) => {
        writes.scopes.push(structuredClone(input));
        return imageClaimRunner(input);
      },
      chainRunner: async (input) => {
        writes.chain++;
        assert.equal(input.contentType, type);
        // Corrupt the scene only after input preparation so the real completion
        // helper throws, after both review paths have received the source image.
        if (completionThrows) inbound.images[0].scene.scene.people = {};
        if (discardSceneRecords) inbound.images = [];
        return {
          answer,
          review: { state: 'REVIEW', issue_count: 1, confidence: 0.86,
            facets: { product_line: '吸奶器', channel: '社媒' }, ...reviewReadings },
          engine: { state: 'REVIEW', image_skill_gate: {
            ok: engineAccepted, load: { verdict: engineAccepted ? 'loaded' : 'missing' },
            checks: engineAccepted ? [] : ['图片 skill 本轮加载证据缺失'],
          } },
          report: chainReport,
        };
      },
      modelSideRunner: async ({ imagePaths }) => {
        writes.model++;
        if (type === 'image') assert.equal(imagePaths.length, imageReadings.failed ? 0 : 1,
          'image model must use exactly the successfully read source image');
        const modelFindings = modelAccepted ? structuredClone(modelItems) : [];
        if (type === 'text') {
          modelFindings.forEach((finding, i) => {
            finding.location = `正文第 ${i + 1} 段`;
          });
        }
        return { ok: modelAccepted, findings: modelFindings, dropped: [], ms: 1,
          ...(modelAccepted ? {} : { error: '本轮模型输出未通过完整性校验' }) };
      },
      mergedReportRunner: async (markdown, options) => {
        writes.reports.push({ markdown, options });
        return { ok: true, url: reportUrl };
      },
      publishRunner: async (row) => {
        writes.rows.push(structuredClone(row));
        return { ok: true, action: 'created', record_id: 'rec_current', readback: 'consistent' };
      },
      adviceRunner: async () => ({ ok: true, ms: 1, advice: {} }),
      mediaLinksRunner: async () => [],
      fetchImageForLink: async (_id, _key, { dir }) => {
        const dest = path.join(dir, 'current.png');
        fs.copyFileSync(source, dest);
        writes.images.push(dest);
        return { path: dest };
      },
      }));
    } finally {
      Object.assign(runtimeContext, priorRuntime);
    }
    assert.equal(writes.chain, 1, 'the current request must execute the chain');
    assert.equal(writes.model, 1, 'the current request must execute independent review');
    assert.equal(writes.rows.length, 1, 'every review needs exactly one status row');
    const card = toCardOrText(result.forcedReply || result.reviewDirectReply || '', {
      verdict53: result.verdict53,
      reportLink: result.dual?.reportUrl ?? null,
      reviewRequired: result.gate?.yes === true && !result.verdict53?.line,
      reviewReason: inbound.imageGateReason ?? null,
    });
    return { result, writes, row: writes.rows[0], card, inbound };
  }

  await test('original legacy report without C table remains incomplete until format completion', async () => {
    const sample = await run({ answer: adultAnswer, formatCompletion: false });
    assert.equal(sample.result.imageReviewIncomplete, true);
    assert.equal(sample.row.conclusion, 'NEEDS_INPUT');
    assert.equal(sample.writes.reports.length, 0);
  });

  const absenceScope = reviewFixtureClaims;
  // Equal-value reconstruction from the production record, not original scene JSON.
  const compoundScene = { ok: true, scene: {
    setting: '影棚', people: [],
    products: [
      { what: '白色带粉色包边的椭圆形收纳盒，盒盖打开，内有两个圆形凹槽', orientation: '正放' },
      { what: '粉色半透明蛋形装置，表面有刻度数字，左侧一个', orientation: '正放' },
      { what: '粉色半透明蛋形装置，表面有刻度数字，右侧一个', orientation: '正放' },
      { what: '手机，屏幕显示控制界面', orientation: '正放' },
    ], visible_marks: ['有文字，认不清'], text_script: '英文',
    clean_text: ['Breast pump control', 'Massage', 'Lactation', 'Mixing', 'Level 3 / 15',
      'Stimulation · Expression · Mixing 1', 'Auto', 'Manual', 'Customize'],
    risk_cues: [], unclear: ['收纳盒内凹槽中是否有物件看不清', '粉色装置上的刻度数字具体数值看不清',
      '手机屏幕顶部状态栏小字看不清', '画面中无人物、无婴幼儿'],
  } };
  const compoundReadings = { text: 'mom\nDzY\nmoncoz\nBreast oumo contro\nM\nLovel 3 / 15\n05:30',
    wlText: undefined, sha256: 'e072ce0ffb657e805e1795ed7ee9e0e3c3d2c1764e7c93ccf29910530ba557ae' };
  const compoundKbReadings = { state: 'REVIEW', issue_count: 0, candidate_count: 0, confidence: null,
    refusal: { state: 'NEEDS_INPUT', detail: '依据侧拒答（fail-closed）', fails_closed: true,
      reason_code: 'coverage_not_covered', coverage: { covered: false, rule_cited_unit_hits: 0,
        safe_vocabulary_hits: 0, coverage_bm25_min: 16.0, bm25_max: 17.5466 } } };
  const { adjudicateImageClaims } = await import('./image_claim_review.mjs');
  const verifiedCompoundAbsence = reviewFixtureClaims;
  for (const chatType of ['group', 'p2p']) {
    await test(`real 16:41 compound absence after explicit format completion reaches semantic review in ${chatType}`, async () => {
      const sample = await run({ answer: compoundAbsenceAnswer, sceneResult: compoundScene,
        imageReadings: compoundReadings, chatType, imageClaimRunner: verifiedCompoundAbsence,
        modelItems: [], reviewReadings: compoundKbReadings });
      assert.equal(sample.writes.scopes.length, 1, 'the previously bypassed semantic step must execute');
      assert.equal(sample.writes.scopes[0].reportText, completeLegacyFixtureReport(compoundAbsenceAnswer));
      assert.deepEqual(sample.writes.scopes[0].scenes, [compoundScene.scene]);
      assert.equal(sample.result.imageReviewIncomplete, false);
      const controlScene = structuredClone(compoundScene);
      controlScene.scene.unclear.pop();
      const control = await run({ answer: compoundAbsenceAnswer, sceneResult: controlScene,
        imageReadings: compoundReadings, chatType, imageClaimRunner: verifiedCompoundAbsence,
        modelItems: [], reviewReadings: compoundKbReadings });
      assert.equal(sample.row.conclusion, control.row.conclusion, '重复缺席说明不改变既有完整审查结果');
      assert.equal(sample.result.verdict53?.state, control.result.verdict53?.state);
      assert.deepEqual(sample.card, control.card);
      assert.doesNotMatch(JSON.stringify(sample.card), /审查未完成|AAP|HealthyChildren/);
    });
  }
  await test('real 16:41 compound absence with failed semantic review remains unpublished', async () => {
    const sample = await run({ answer: compoundAbsenceAnswer, sceneResult: compoundScene,
      imageReadings: compoundReadings, imageClaimRunner: async () => ({ ok: false, required: null }) });
    assert.equal(sample.writes.scopes.length, 1);
    assert.equal(sample.result.imageReviewIncomplete, true);
    assert.equal(sample.writes.reports.length, 0);
    assert.equal(sample.row.conclusion, 'NEEDS_INPUT');
    assert.equal(sample.result.verdict53, null);
    assert.match(sample.inbound.imageGateReason, /来源核查|主张.*复核未完成|适用性复核未完成|响应格式|复核未恰好/);
  });
  await test('real 16:41 compound absence cannot hide a second explicit unknown', async () => {
    const sceneResult = structuredClone(compoundScene);
    sceneResult.scene.unclear.push('无法确认婴儿是否与成人同床');
    const sample = await run({ answer: compoundAbsenceAnswer, sceneResult,
      imageReadings: compoundReadings, imageClaimRunner: verifiedCompoundAbsence });
    assert.equal(sample.writes.scopes.length, 1);
    assert.equal(sample.result.imageReviewIncomplete, true);
    assert.equal(sample.writes.reports.length, 0);
    assert.equal(sample.row.conclusion, 'NEEDS_INPUT');
  });
  await test('compound absence and explicit unknown in one scene record cannot bypass the source check', async () => {
    const sceneResult = structuredClone(compoundScene);
    sceneResult.scene.unclear = ['画面中无人物、无婴幼儿；无法确认婴儿是否与成人同床'];
    const sample = await run({ answer: compoundAbsenceAnswer, sceneResult,
      imageReadings: compoundReadings, imageClaimRunner: verifiedCompoundAbsence });
    assert.equal(sample.writes.scopes.length, 1);
    assert.equal(sample.result.imageReviewIncomplete, true);
    assert.equal(sample.writes.reports.length, 0);
    assert.equal(sample.row.conclusion, 'NEEDS_INPUT');
  });
  await test('compound absence cannot erase an independent material safety claim', async () => {
    const claim = '本品可预防婴儿窒息';
    const sample = await run({ answer: compoundAbsenceAnswer, sceneResult: compoundScene,
      imageReadings: { ...compoundReadings, textCalibrated: claim },
      imageClaimRunner: (input) => adjudicateImageClaims(input, { chat: async (messages) => {
        const evidence = decodeFixtureClaimRequest(messages);
        const parent = evidence.originalRecords.find((record) => record.origin === 'image_ocr');
        const material = evidence.records.find((record) => record.parentId === parent.id);
        assert.equal(material.text, claim, '当前素材主张必须独立送入语义复核');
        const response = fixtureAssessment(evidence);
        const decision = response.decisions.find(record => record[0] === material.ordinal);
        decision[1] = 's';
        decision[2] = []; // Original report omitted this actual material claim.
        return { ok: true, finishReason: 'stop', message: { content: JSON.stringify(response) } };
      } }),
    });
    assert.equal(sample.writes.scopes.length, 1);
    assert.equal(sample.result.imageReviewIncomplete, true);
    assert.equal(sample.writes.reports.length, 0);
    assert.match(sample.inbound.imageGateReason, /来源|主张|婴儿安全事实|事实仍未确认/);
  });
  for (const defect of ['missing_record', 'wrong_hash']) {
    await test(`compound absence semantic ${defect} cannot publish a verdict`, async () => {
      const sample = await run({ answer: compoundAbsenceAnswer, sceneResult: compoundScene,
        imageReadings: compoundReadings,
        imageClaimRunner: (input) => adjudicateImageClaims(input, { chat: async (messages) => {
          const evidence = decodeFixtureClaimRequest(messages);
          const response = fixtureAssessment(evidence);
          if (defect === 'missing_record') response.decisions.pop();
          if (defect === 'wrong_hash') response.evidenceHash = 'different-input-hash';
          return { ok: true, finishReason: 'stop', message: { content: JSON.stringify(response) } };
        } }),
      });
      assert.equal(sample.writes.scopes.length, 1);
      assert.equal(sample.result.imageReviewIncomplete, true);
      assert.equal(sample.writes.reports.length, 0);
      assert.equal(sample.row.conclusion, 'NEEDS_INPUT');
      assert.equal(sample.result.verdict53, null);
      assert.match(sample.inbound.imageGateReason, /来源核查|主张.*复核未完成|适用性复核未完成|响应格式|复核未恰好/);
    });
  }
  const sameImageReadings = {
    text: 'IBCLC + mom of\n4 explains\nMomcozy Air 1\nBreast Pump\n20 WOW',
    wlText: 'IBCLC + mom of\n4 explains\nMomcozy Air 1\nBreast Pump\n20 WOW',
  };
  for (const [label, answer] of conversationAnswers) {
    await test(`${label}: same image after explicit format completion has identical group and private publications`, async () => {
      const group = await run({ answer, chatType: 'group', imageReadings: sameImageReadings,
        imageClaimRunner: absenceScope });
      const privateChat = await run({ answer, chatType: 'p2p', imageReadings: sameImageReadings,
        imageClaimRunner: absenceScope });
      for (const sample of [group, privateChat]) {
        assert.equal(sample.result.imageReviewIncomplete, false, `${label}: completed adult image was refused`);
        assert.equal(sample.row.conclusion, 'REVIEW');
        assert.equal(sample.result.verdict53?.state, 'REVIEW');
        assert.equal(sample.writes.reports.length, 1);
        assert.ok(sample.row.issueCount >= 3);
        for (const text of [sample.row.summary, sample.writes.reports[0].markdown, JSON.stringify(sample.card)]) {
          assert.equal(Number(text.match(/共发现\s*(?:\*\*)?(\d+)/)?.[1]), sample.row.issueCount,
            'row, report and final card must publish the same issue count');
        }
        assert.equal(sample.row.summary, sample.result.reviewDirectReply);
        assert.equal(sample.row.reportUrl, reportUrl);
        assert.match(sample.writes.reports[0].markdown, /【审查结论：REVIEW】/);
        assert.match(JSON.stringify(sample.card), /审查结论：REVIEW/);
        assert.doesNotMatch(JSON.stringify(sample.card), /审查未完成/);
      }
      assert.equal(group.row.conclusion, privateChat.row.conclusion);
      assert.equal(group.row.issueCount, privateChat.row.issueCount);
      assert.equal(group.row.summary, privateChat.row.summary);
      assert.equal(group.writes.reports[0].markdown, privateChat.writes.reports[0].markdown);
      assert.deepEqual(group.card, privateChat.card);
      if (label === 'group 14:33') {
        assert.doesNotMatch(answer, /AAP|HealthyChildren/, 'the real group fixture must not gain a fake citation');
        for (const sample of [group, privateChat]) {
          assert.equal(sample.writes.scopes.length, 1, 'ambiguous free-text keyword must reach semantic review');
          assert.match(sample.writes.scopes[0].reportText, /没有婴幼儿同场或同床/);
          assert.deepEqual(sample.writes.scopes[0].scenes, [scene.scene]);
          assert.ok(sample.writes.scopes[0].materialTexts.some((item) => item.text.includes('20 WOW')));
        }
      }
    });
  }

  await test('explicit infant unknown remains blocked alongside independent absence records', async () => {
    const groupAnswer = conversationAnswers.find(([name]) => name === 'group 14:33')[1];
    const answer = groupAnswer.replace('没有婴幼儿同场或同床', '无法确认婴儿是否与成人同床');
    const sample = await run({ answer, imageClaimRunner: reviewFixtureClaims });
    assert.equal(sample.result.imageReviewIncomplete, true);
    assert.equal(sample.writes.reports.length, 0);
    assert.equal(sample.row.conclusion, 'NEEDS_INPUT');
    assert.equal(sample.writes.scopes.length, 1, 'the same reviewer receives explicit unknown facts');
  });

  // Wrong adult/negation parsing must not reject the exact production response.
  await test('empty workflow headings plus a complete visual checklist cannot publish PASS', async () => {
    const answer = ['审核对象与范围', '视觉分析与 OCR', '主张拆分与核查清单',
      '4A 规则符合性', '4B 事实准确性核查', '图文一致性'].map(x => '### ' + x).join('\n')
      + '\n### 视觉核对\n婴幼儿姿势：无\n婴儿睡眠位置：无（画面没有婴儿睡眠场景）'
      + '\n产品状态：无\n场景关系：无\n隐私：无\n### 问题清单\n1. 无';
    const sample = await run({ answer, modelItems: [] });
    assert.equal(sample.result.imageReviewIncomplete, true);
    assert.equal(sample.result.verdict53, null);
    assert.equal(sample.row.conclusion, 'NEEDS_INPUT');
    assert.equal(sample.writes.reports.length, 0);
  });
  await test('a registered source name alone is not a delivered fact check', async () => {
    const answer = completeAnswer.replace(/### 主张拆分与核查清单[\s\S]*?(?=### 4A)/,
      '### 主张拆分与核查清单\nC1 婴儿姿势与人物身份。\n\n')
      .replace(/### 4B 事实准确性核查[\s\S]*?(?=### 图文一致性)/,
      '### 4B 事实准确性核查\nAAP，库内已登记；本轮未做联网检索。\n\n');
    const sample = await run({ answer, modelItems: [] });
    assert.equal(sample.result.imageReviewIncomplete, true);
    assert.equal(sample.result.verdict53, null);
    assert.match(sample.inbound.imageGateReason, /4B|事实核查/);
  });
  await test('a claimed source must match this review evidence before it is accepted', async () => {
    const answer = completeAnswer.replace(/### 4B 事实准确性核查[\s\S]*?(?=### 图文一致性)/,
      '### 4B 事实准确性核查\n| 主张 | 核查结论 | 依据及边界 | 来源 | 来源原文 |\n'
      + '|---|---|---|---|---|\n| 产品功能 | 支持 | 已核对功能说明 | forged-source | Invented evidence supporting this particular product claim. |\n\n');
    const sample = await run({ answer, modelItems: [] });
    assert.equal(sample.result.imageReviewIncomplete, true);
    assert.equal(sample.result.verdict53, null);
  });
  await test('real 16:42 adult-image response after explicit format completion completes without an irrelevant AAP requirement', async () => {
    const { result, row } = await run({ answer: adultAnswer });
    assert.equal(result.imageReviewIncomplete, false, 'a complete adult-only workflow was rejected');
    assert.equal(result.forcedReply, null);
    assert.equal(row.conclusion, 'REVIEW');
    assert.equal(result.verdict53?.state, 'REVIEW');
    assert.match(result.reviewDirectReply, /【审查结论：REVIEW】/);
  });

  await test('real 18:54 camera response after explicit format completion reaches report, row and reply despite absence in unclear', async () => {
    const { result, writes, row } = await run({ answer: cameraAnswer, sceneResult: { ok: true, scene: {
      setting: '影棚', people: [], products: [{ what: '白色立式摄像头', orientation: '正放' }],
      visible_marks: ['momcozy'], text_script: '英文', clean_text: ['momcozy'], risk_cues: [],
      unclear: ['图中没有人物、婴幼儿或使用场景', '无法判断设备是否通电工作'],
    } } });
    assert.equal(result.imageReviewIncomplete, false);
    assert.equal(result.forcedReply, null);
    assert.equal(row.conclusion, 'REVIEW');
    assert.equal(result.verdict53?.state, 'REVIEW');
    assert.match(result.reviewDirectReply, /【审查结论：REVIEW】/);
    assert.equal(writes.reports.length, 1, 'validated findings must reach report publication');
  });

  await test('real 09:48 response after explicit format completion keeps scene absence separate from a zero-risk claim through publication', async () => {
    const { result, writes, row, card } = await run({ answer: novemberAnswer,
      imageReadings: { text: 'IBCLC + mom of\n4 explains\nMomcozy Air 1\nBreast Pump\n20 WOW',
        wlText: 'IBCLC + mom of\n4 explains\nMomcozy Air 1\nBreast Pump\n20 WOW' } });
    assert.equal(result.imageReviewIncomplete, false);
    assert.equal(result.forcedReply, null);
    assert.equal(writes.reports.length, 1, 'completed real review must reach report publication');
    assert.match(writes.reports[0].markdown, /【审查结论：REVIEW】/);
    assert.equal(row.conclusion, 'REVIEW');
    assert.equal(row.reportUrl, reportUrl);
    assert.equal(row.summary, result.reviewDirectReply);
    assert.equal(result.verdict53?.state, 'REVIEW');
    assert.match(result.reviewDirectReply, /【审查结论：REVIEW】/);
    assert.match(JSON.stringify(card), /审查结论：REVIEW/);
    assert.doesNotMatch(JSON.stringify(card), /审查未完成/);
  });

  // A report cannot omit source-image claims or manufacture new unsupported
  // assurances. Exercise the actual final report/row/reply gate for each source.
  const infantClaim = '婴儿使用本产品没有任何风险。';
  const harmlessText = 'Momcozy Air 1\nBreast Pump';
  const assertWithheld = (sample) => {
    assert.equal(sample.writes.reports.length, 0, 'unverified claims must not publish a provisional report');
    assert.equal(sample.row.conclusion, 'NEEDS_INPUT');
    assert.equal(sample.row.confidence, 0);
    assert.equal(sample.row.reportUrl, null);
    assert.equal(sample.row.clearReportUrl, true);
    assert.equal(sample.result.imageReviewIncomplete, true);
    assert.equal(sample.result.verdict53, null);
    assert.equal(sample.result.reviewDirectReply, null);
    assert.equal(sample.result.dual?.reportUrl ?? null, null);
    assert.match(JSON.stringify(sample.card), /审查未完成/);
    assert.doesNotMatch(JSON.stringify(sample.card), /【审查结论[：:](?:REVIEW|PASS|BLOCK)】|example\.invalid\/docx\//);
  };

  const groupAnswer = conversationAnswers.find(([label]) => label === 'group 14:33')[1];
  for (const [label, answer, imageReadings] of [
    ['earlier report keyword cannot hide a later explicit unknown',
      groupAnswer + '\n另外：无法确认婴儿是否与成人同床。', {}],
    ['earlier OCR assurance cannot hide an explicit report unknown',
      groupAnswer.replace('没有婴幼儿同场或同床', '无法确认婴儿是否与成人同床'),
      { textCalibrated: infantClaim }],
  ]) {
    await test(`${label}: no semantic exemption and no publication`, async () => {
      const sample = await run({ answer, imageReadings, imageClaimRunner: absenceScope,
        chainReport: oldReportUrl });
      assert.equal(sample.writes.scopes.length, 1,
        'all explicit unknown facts reach the shared semantic reviewer');
      assertWithheld(sample);
      assert.match(sample.inbound.imageGateReason, /来源|主张|婴儿安全事实|事实仍未确认/);
    });
  }

  await test('semantic confirmation of a genuine reviewer assurance still requires authority before publication', async () => {
    const answer = groupAnswer + `\n本轮审核认定：${infantClaim}`;
    const sample = await run({ answer, imageClaimRunner: async (input) => {
      assert.ok(input.reportText.includes(infantClaim));
      return reviewFixtureClaims(input);
    } });
    assertWithheld(sample);
    assert.equal(sample.writes.scopes.length, 1);
    assert.match(sample.inbound.imageGateReason, /来源|主张|婴儿安全事实|事实仍未确认/);
  });

  for (const [label, imageClaimRunner] of [
    ['failed semantic review', async () => ({ ok: false, required: false, reason: 'fixture_provider_failure' })],
    ['semantic review throws', async () => { throw new Error('fixture semantic provider failure'); }],
    ['missing positive execution flag', async () => ({ required: false, reason: 'semantic_scope_no_infant_fact' })],
    ['missing claim completion evidence', async () => ({ ok: true, reason: 'semantic_scope_no_infant_fact' })],
  ]) {
    await test(`${label}: absence cannot be assumed and no report or verdict is published`, async () => {
      const sample = await run({ answer: groupAnswer, imageClaimRunner, chainReport: oldReportUrl });
      assert.equal(sample.writes.scopes.length, 1, 'the semantic boundary must actually execute');
      assertWithheld(sample);
      assert.match(sample.inbound.imageGateReason, /适用性复核未完成|复核.*失败|复核.*未完成|全流程缺项/);
    });
  }

  await test('structured non-sleep infant observation does not require a sleep citation', async () => {
    const sceneResult = structuredClone(scene);
    sceneResult.scene.people = [{ kind: '婴儿', panel: '中部', doing: '被成人抱着',
      sleep_scene: false, sleep_posture: '不适用' }];
    const heldInfantAnswer = [
      '审核对象与范围：本次单张抱婴插画全图。',
      '视觉分析与 OCR：成人抱着婴儿，未处于睡眠场景；品牌文字可读。',
      '主张拆分与核查清单：C1：成人抱着婴儿，图中未出现睡眠场景。',
      '4A 规则符合性：本轮引擎结果保留，不据观察推断抱姿安全。',
      '4B 事实准确性核查：',
      '| 主张 | 核查结论 | 依据及边界 | 来源 | 来源原文 |',
      '|---|---|---|---|---|',
      '| C1：抱婴观察 | 画面可确认 | 中部成人抱着婴儿，只描述画面，不给抱姿安全保证 | — | — |',
      '图文一致性：人物与品牌文字并列，不据并列推断安全功效。',
      '视觉核对：婴幼儿姿势=无（被成人抱着）；婴儿睡眠位置=无（未处于睡眠场景）；产品状态=无；场景关系=无；隐私=无',
    ].join('\n');
    const sample = await run({ answer: heldInfantAnswer, sceneResult, imageClaimRunner: reviewFixtureClaims });
    assert.equal(sample.result.imageReviewIncomplete, false);
    assert.equal(sample.writes.scopes.length, 1);
    assert.equal(sample.row.conclusion, 'REVIEW');
  });

  for (const [label, person, imageReadings] of [
    ['unknown person identity', { kind: '分不清', sleep_scene: false, sleep_posture: '不适用' }, {}],
    ['structured infant sleep', { kind: '婴幼儿', sleep_scene: true, sleep_posture: '仰卧',
      sleep_posture_basis: '面部朝上，后背接触床面' }, {}],
    ['baby despite earlier OCR claim match', { kind: '婴儿', sleep_scene: false, sleep_posture: '不适用' },
      { textCalibrated: infantClaim }],
  ]) {
    await test(`${label}: semantic absence cannot cancel structured source requirements`, async () => {
      const sceneResult = structuredClone(scene);
      sceneResult.scene.people = [{ panel: '中部', doing: '位于画面中', ...person }];
      const sample = await run({ answer: groupAnswer, sceneResult, imageReadings,
        imageClaimRunner: absenceScope });
      assertWithheld(sample);
      assert.ok(sample.writes.scopes.length <= 1, 'full evidence is reviewed once when visual delivery is complete');
      assert.match(sample.inbound.imageGateReason, /来源|主张|婴儿安全事实|事实仍未确认/);
    });
  }

  for (const [label, imageReadings] of [
    ['failed OCR', { failed: 'OCR worker failed' }],
    ['truncated OCR', { truncated: true }],
  ]) {
    await test(`${label}: semantic absence cannot restore missing material evidence`, async () => {
      const sample = await run({ answer: groupAnswer, imageReadings, imageClaimRunner: absenceScope });
      assertWithheld(sample);
      assert.equal(sample.writes.scopes.length, 0, 'incomplete material cannot enter the semantic exemption path');
      assert.match(sample.inbound.imageGateReason, /图中文字来源未完整读取/);
    });
  }

  for (const [label, options] of [
    ['calibrated OCR claim omitted by report', { imageReadings: { textCalibrated: infantClaim } }],
    ['watermark-filtered OCR claim omitted by report', { imageReadings: { wlText: infantClaim } }],
    ['plain OCR claim omitted by report', { imageReadings: { wlText: undefined, text: infantClaim } }],
    ['independent visible-text claim omitted by report', { cleanText: [infantClaim] }],
    ['safety assurance added only by reviewer', { answer: adultAnswer + '\n本轮审核认定：婴儿使用本产品没有任何风险。' }],
  ]) {
    await test(`${label}: no report, NEEDS_INPUT row and incomplete final card`, async () => {
      const sample = await run({ answer: adultAnswer, chainReport: oldReportUrl, ...options });
      assertWithheld(sample);
      assert.match(sample.inbound.imageGateReason, /来源|主张|婴儿安全事实|事实仍未确认/);
    });
  }

  // Raw OCR is diagnostic history. Reintroducing it, or ignoring the same
  // precedence used by the review chain, must not change the current material.
  for (const [label, imageReadings] of [
    ['calibration supersedes obsolete OCR', { textCalibrated: harmlessText, wlText: infantClaim, text: infantClaim }],
    ['watermark removal supersedes obsolete text', { wlText: harmlessText, text: infantClaim }],
    ['raw OCR is not silently reintroduced', { textRaw: infantClaim, text: harmlessText, wlText: harmlessText }],
  ]) {
    await test(`${label}: completed review retains its report and verdict`, async () => {
      const { result, writes, row, card } = await run({ answer: adultAnswer, imageReadings });
      assert.equal(result.imageReviewIncomplete, false);
      assert.equal(writes.reports.length, 1);
      assert.equal(row.conclusion, 'REVIEW');
      assert.equal(row.reportUrl, reportUrl);
      assert.equal(result.verdict53?.state, 'REVIEW');
      assert.match(JSON.stringify(card), /审查结论：REVIEW/);
    });
  }

  for (const [label, imageReadings] of [
    ['failed OCR', { failed: 'OCR worker failed' }],
    ['truncated OCR', { truncated: true }],
  ]) {
    await test(`${label}: a report containing AAP cannot substitute for complete text evidence`, async () => {
      const sample = await run({ answer: completeAnswer, imageReadings, chainReport: oldReportUrl });
      assertWithheld(sample);
      assert.match(sample.inbound.imageGateReason, /图中文字来源未完整读取/);
      assert.match(JSON.stringify(sample.card), /图中文字来源未完整读取/);
    });
  }

  await test('executed scene with uncertain infant facts cannot be cleared by an unrelated AAP quote', async () => {
    const { sources } = loadImageFactSources(process.env.SHOUHENG_FACT_SOURCE_TEST_ROOT
      || '/Users/lute/Documents/skill-test/执行skills/执行skills/skills-回归测试/知识库/内容治理');
    const answer = completeAnswer.replace(/### 主张拆分与核查清单[\s\S]*?(?=### 4A)/,
      '### 主张拆分与核查清单\nC1 婴儿姿势与人物身份。\n\n')
      .replace(/### 4B 事实准确性核查[\s\S]*?(?=### 图文一致性)/,
      '### 4B 事实准确性核查\n| 主张 | 核查结论 | 依据及边界 | 来源 | 来源原文 |\n'
      + '|---|---|---|---|---|\n| C1 婴儿姿势与人物身份 | 无法确认 | 遮挡使年龄与睡姿未知；2022年本地政策用于提示婴儿适用范围，不推断年龄 | aap-safe-sleep-2022 | Side sleeping is not safe and is not advised. |\n\n');
    const sample = await run({ answer, factSources: sources, sceneResult: { ok: true, scene: {
      setting: '看不清', people: [{ kind: '分不清', doing: '人物被前景遮挡',
        sleep_scene: null, sleep_posture: '看不清' }], products: [],
      visible_marks: [], text_script: '未给', clean_text: [], risk_cues: [],
      unclear: ['人物年龄无法辨认', '环境被遮挡'],
    } } });
    assertWithheld(sample);
    assert.match(sample.inbound.imageGateReason, /未知|未确认|来源|主张/);
  });

  await test('visible-text truncation cannot be reported as complete material evidence', async () => {
    const { parseScene } = await import('./scene.mjs');
    const sceneResult = parseScene(JSON.stringify({ ...scene.scene,
      clean_text: [...Array.from({ length: 20 }, (_, i) => `product label ${i + 1}`), infantClaim],
    }));
    const sample = await run({ answer: completeAnswer, sceneResult, imageReadings: {
      text: undefined, wlText: undefined, ocrEmpty: true,
    } });
    assert.equal(sample.result.imageReviewIncomplete, true);
    assert.equal(sample.writes.reports.length, 0);
    assert.equal(sample.row.conclusion, 'NEEDS_INPUT');
    assert.match(sample.inbound.imageGateReason, /图中文字来源未完整读取.*visual_text.*truncated/);
  });

  // Moving or deleting the completion check after report publication must fail
  // each control below even when the provisional issue count exceeds the gate.
  for (const [name, options] of [
    ['missing workflow step', { answer: incompleteAnswer }],
    ['failed scene reading', { sceneResult: { ok: false, error: 'HTTP 402 fixture' } }],
    ['skipped scene reading', { sceneResult: { ok: false, skipped: true, error: '画面层未开' } }],
    ['success flag cannot override skipped scene', { sceneResult: { ...scene, skipped: true } }],
    ['scene payload without positive execution flag', { sceneResult: { scene: scene.scene } }],
    ['empty execution receipt', { sceneResult: {} }],
    ['success flag without scene payload', { sceneResult: { ok: true } }],
    ['empty scene payload', { sceneResult: { ok: true, scene: {} } }],
    ['array cannot substitute for structured scene', { sceneResult: { ok: true, scene: [] } }],
    ['unrelated object cannot substitute for structured scene', { sceneResult: { ok: true, scene: { note: '已读取' } } }],
    ['missing image reading records', { discardSceneRecords: true }],
    ['rejected engine image evidence', { engineAccepted: false }],
    ['failed independent image model', { modelAccepted: false, answer: multipleSkillFindings }],
  ]) {
    const sample = await run({ ...options, chainReport: oldReportUrl });
    await test(`${name}: no provisional REVIEW report is published`, () => {
      assert.equal(sample.writes.reports.length, 0, 'completion refusal must precede irreversible report publication');
    });
    await test(`${name}: row state and summary both say incomplete`, () => {
      assert.equal(sample.row.conclusion, 'NEEDS_INPUT');
      assert.doesNotMatch(sample.row.summary, /【审查结论[：:](?:REVIEW|PASS|BLOCK)】/,
        'the row must not keep the provisional three-state summary');
      assert.match(sample.row.summary, /未完成|未通过|不收|没跑成|未能|未验证|缺失/);
    });
    await test(`${name}: rejected row never restores provisional confidence or report URL`, () => {
      assert.equal(sample.row.confidence, 0, 'do not restore the provisional engine confidence 0.86');
      assert.equal(sample.row.reportUrl, null, 'a refused review must not expose a provisional report link');
      assert.equal(sample.row.clearReportUrl, true, 'a refused review must explicitly clear an existing table report link');
    });
    await test(`${name}: direct reply, verdict and report link cannot revive a refused result`, () => {
      assert.equal(sample.result.imageReviewIncomplete, true);
      assert.equal(sample.result.verdict53, null);
      assert.equal(sample.result.reviewDirectReply, null);
      assert.ok(sample.result.forcedReply, 'a refused review must explain its missing evidence');
      assert.equal(sample.result.dual?.reportUrl ?? null, null);
      assert.doesNotMatch(sample.result.chainBlock, /example\.invalid\/docx\//,
        'neither a new provisional report nor the chain report may leak into reply context');
      assert.doesNotMatch(sample.result.chainBlock, /【审查结论[：:](?:REVIEW|PASS|BLOCK)】/,
        'the reply context must not keep the provisional verdict');
      assert.match(sample.result.chainBlock, /本轮图片审查未完成/);
      assert.match(JSON.stringify(sample.card), /审查未完成/);
      assert.doesNotMatch(JSON.stringify(sample.card), /【审查结论[：:](?:REVIEW|PASS|BLOCK)】/,
        'the final card must not revive a rejected scene as a review verdict');
    });
  }

  const exceptional = await run({ completionThrows: true, chainReport: oldReportUrl });
  await test('completion-check exception defaults to an incomplete row and reply', () => {
    assert.equal(exceptional.result.imageReviewIncomplete, true);
    assert.equal(exceptional.writes.reports.length, 0);
    assert.equal(exceptional.row.conclusion, 'NEEDS_INPUT');
    assert.equal(exceptional.row.confidence, 0);
    assert.equal(exceptional.row.reportUrl, null);
    assert.equal(exceptional.row.clearReportUrl, true);
    assert.equal(exceptional.result.verdict53, null);
    assert.equal(exceptional.result.reviewDirectReply, null);
    assert.match(exceptional.result.forcedReply, /未完成/);
    assert.match(exceptional.result.chainBlock, /本轮图片审查未完成/);
    assert.doesNotMatch(exceptional.result.chainBlock, /【审查结论[：:](?:REVIEW|PASS|BLOCK)】|example\.invalid\/docx\//);
  });
  await test('completion-check exception still deletes the temporary source image and directory', () => {
    try {
      assert.equal(exceptional.writes.images.length, 1, 'the exception must occur after fetching the current image');
      for (const imagePath of exceptional.writes.images) {
        assert.equal(fs.existsSync(imagePath), false, 'source image survived a completion-check exception');
        assert.equal(fs.existsSync(path.dirname(imagePath)), false, 'source directory survived a completion-check exception');
      }
    } finally {
      // The red test must not itself leave a copied image behind.
      for (const imagePath of exceptional.writes.images) {
        fs.rmSync(path.dirname(imagePath), { recursive: true, force: true });
      }
    }
  });

  await test('completed image publishes a report and agrees across report, row and direct reply', async () => {
    const { result, row, writes } = await run();
    assert.equal(result.imageReviewIncomplete, false);
    assert.equal(writes.reports.length, 1);
    assert.match(writes.reports[0].markdown, /【审查结论：REVIEW】/);
    assert.equal(row.conclusion, 'REVIEW');
    assert.ok(row.issueCount >= 3);
    assert.ok(row.confidence > 0);
    assert.equal(row.reportUrl, reportUrl);
    assert.notEqual(row.clearReportUrl, true, 'completed review must retain its published report link');
    assert.equal(result.dual.reportUrl, reportUrl);
    assert.equal(result.verdict53.state, 'REVIEW');
    assert.equal(row.summary, result.reviewDirectReply);
    assert.ok(result.reviewDirectReply.includes(reportUrl));
  });

  await test('text review still publishes normally without an image workflow checklist', async () => {
    const { result, row, writes } = await run({ type: 'text',
      answer: '【审查结论：REVIEW】共发现 1 处需人工确认。' });
    assert.equal(result.imageReviewIncomplete, false);
    assert.equal(writes.reports.length, 1);
    assert.equal(row.conclusion, 'REVIEW');
    assert.equal(row.reportUrl, reportUrl);
    assert.notEqual(row.clearReportUrl, true);
    assert.equal(result.verdict53.state, 'REVIEW');
    assert.equal(row.summary, result.reviewDirectReply);
  });
  await test('all review cases stay offline', () => assert.equal(networkAttempts, 0));
} finally {
  fs.readFileSync = originalRead;
  globalThis.fetch = originalFetch;
  net.Socket.prototype.connect = originalConnect;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  fs.rmSync(tmp, { recursive: true, force: true });
}
for (const result of cases) console.log(`${result.ok ? '✅' : '❌'} ${result.name}${result.detail ? `: ${result.detail}` : ''}`);
const failed = cases.filter((result) => !result.ok).length;
console.log(`image_completion_publish: ${cases.length - failed}/${cases.length}, real network attempts=${networkAttempts}`);
if (failed) process.exitCode = 1;

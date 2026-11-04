#!/usr/bin/env node
/**
 * Real video submission -> publication -> final-card regressions.
 * Catch mismatched report/card thresholds, frame appendices lost by conclusion
 * extraction, and incomplete review escaping as a published three-state result.
 * Only external boundaries are replaced; gate, merge, report and card code run.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-video-completion-'));
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
  SHOUHENG_ALLOWED_CHATS: '', SHOUHENG_REVIEW_DIRECT_REPLY: '1',
  SHOUHENG_IDENTITY_REJECT_LOG: path.join(tmp, 'identity.ndjson'),
  SHOUHENG_OUTBOUND_LEDGER: path.join(tmp, 'outbound.jsonl'),
  SHOUHENG_SEND_TRACE: path.join(tmp, 'sends.jsonl'),
  KB_CONF_LEDGER: path.join(tmp, 'confidence.ndjson'),
});
fs.readFileSync = (file, ...args) => {
  const p = String(file);
  if (p.endsWith('/.dsh/credentials/shouheng-lark.json')) {
    return JSON.stringify({ app_id: 'cli_video_completion_test', app_secret: 'fixture-only' });
  }
  if (p.endsWith('/.config/opencode/opencode.json')) return '{}';
  if (p.endsWith('/.dsh/.credentials.yaml')) throw new Error('No real credentials in this test');
  return originalRead.call(fs, file, ...args);
};
let networkAttempts = 0;
const rejectNetwork = () => { networkAttempts++; throw new Error('No real network in this test'); };
globalThis.fetch = rejectNetwork;
net.Socket.prototype.connect = rejectNetwork;

const cases = [];
const test = async (name, fn) => {
  try { await fn(); cases.push({ name, ok: true }); }
  catch (error) { cases.push({ name, ok: false, detail: error.message }); }
};
const reportUrl = 'https://example.invalid/docx/completed-video-review';
const staleReportUrl = 'https://example.invalid/docx/provisional-video-review';
const times = [0, 2, 4, 6, 8, 10];
const locations = ['视频 00:02', '视频 00:06', '视频 00:10'];
const sceneLabels = ['厨房入口', '白色桌面', '成人手部', '蓝色沙发', '产品背面', '收纳抽屉'];
// Exact six visual-summary field values from the 17:29, 28.9s incident.
// Source: merged-2026-10-30T09_31_37.318Z-1793352697319.json question; no media archived.
const incidentFrameReadings = [
  {
    "t_s": 0.5,
    "fields": {
      "场景": "客厅",
      "人物": "成人坐在棕色皮沙发上，腿上放着笔记本电脑，双手放在键盘上",
      "物品": "黑色笔记本电脑，放在腿上（在用）",
      "可见标识": "笔记本电脑背面有方形四格标识、画面下方有白色描边字幕",
      "文字": "英文",
      "画面线索": "成人女性出镜，穿着运动内衣、笔记本电脑贴近人体腿部使用"
    }
  },
  {
    "t_s": 6.3,
    "fields": {
      "场景": "其他（室内，背景为灰色纹理台面/地面）",
      "人物": "成人双手捧着一个白色圆形设备",
      "物品": "白色圆形设备，上半为白色外壳，下半为透明罩，内部可见漏斗状结构（在用）、后方另一个同款白色圆形设备，部分被遮挡",
      "可见标识": "设备白色外壳上有文字，认不清",
      "文字": "英文",
      "画面线索": "成人双手持握设备，设备贴近手部、画面下方有字幕文字"
    }
  },
  {
    "t_s": 12.1,
    "fields": {
      "场景": "厨房",
      "人物": "成人低头，双手在胸前整理白色上衣",
      "物品": "白色无袖上衣（在用）、蓝色宽松长裤（在用）、台面上带泵头的圆柱形瓶、台面上小罐/小盒、台面上深色小瓶、台面上浅色小瓶",
      "可见标识": "画面下方有文字，认不清、冰箱侧面有贴纸/标识，认不清",
      "文字": "英文",
      "画面线索": "成人女性出镜，双手在胸前整理上衣，领口敞开、产品（上衣）贴近人体并被手部触碰"
    }
  },
  {
    "t_s": 17.0,
    "fields": {
      "场景": "客厅",
      "人物": "成人站在高脚餐椅旁，低头看向餐椅托盘，一手拿透明杯，另一手在托盘上方",
      "物品": "木质高脚餐椅，带白色托盘（在用）、托盘上的浅绿色分格餐盘（在用）、透明玻璃杯（在用）、白色花瓶",
      "可见标识": "有文字，位于画面下方中部",
      "文字": "英文",
      "画面线索": "画面中有成人女性出镜、高脚餐椅托盘上有餐盘，但画面中未见婴幼儿、字幕文字提及婴儿"
    }
  },
  {
    "t_s": 22.8,
    "fields": {
      "场景": "其他",
      "人物": "成人手持手机，拇指按在屏幕上",
      "可见标识": "屏幕顶部有文字，认不清、屏幕中部有数字与英文单词，认不清、画面下方有白色描边字幕，认不清",
      "文字": "英文",
      "画面线索": "手机屏幕显示吸奶记录界面，含 Total (oz)、Left(oz)、Right(oz) 等字样、画面下方有白色描边字幕叠加"
    }
  },
  {
    "t_s": 28.6,
    "fields": {
      "场景": "室内，看起来像居家环境（走廊/客厅），有门框和墙面",
      "人物": "成人面对镜头说话，胸前用布质背带抱着婴儿，双手托着一个白色圆形物体、婴幼儿被布质背带抱在成人胸前，只露出头顶和少量头发，面部不可见",
      "物品": "白色圆形双联物体，正面有两个粉色圆点，下方有灰色小字（在用）、浅色布质婴儿背带，带花卉和建筑图案（在用）、画面底部浅色台面/箱体，上面有深色文字",
      "可见标识": "有文字，位于画面中部偏下（字幕）、有文字，位于白色圆形物体下方（认不清）、有文字，位于画面底部台面上（认不清）、有文字，位于背带中部小标签上（认不清）",
      "文字": "英文",
      "画面线索": "婴幼儿出镜，被成人用背带抱在胸前、产品贴近人体，成人双手托着白色圆形物体置于胸前"
    }
  }
];
const sceneText = (value) => JSON.stringify(value ?? '');
// Check the actual rendered card/report text, including all six scene values.
// Timestamp styling may change, but each exact second must stay attributable.
function assertFramesVisible(text) {
  for (const label of sceneLabels) assert.ok(text.includes(label), `missing frame scene: ${label}`);
  for (const [second, mmss] of [[0, '00:00'], [2, '00:02'], [4, '00:04'], [6, '00:06'], [8, '00:08'], [10, '00:10']]) {
    assert.ok(text.includes(mmss) || text.includes(`[${second.toFixed(1)}s]`), `missing frame timestamp: ${mmss}`);
  }
}

function negativeTrace(video) {
  return { rules_scanned: 491, hits: [], frames_scanned: 6, frame_scene_errors: [],
    visual_rules_scanned: 0, visual_coverage_gap: true,
    frame_scans: video.frameScene.map((frame) => ({ video: video.index, t_s: frame.t_s,
      scene: structuredClone(frame.scene), rules_scanned: 491, visual_rules_scanned: 0,
      coverage: 'no_visual_rule_cues', hits: [] })),
  };
}

try {
  const { runSubmissionGate, handleMessage } = await import('./agent.mjs');
  const { withAgentTurnContext } = await import('./tools.mjs');
  const { toCardOrText } = await import('../reply-cards/envelope.mjs');

  const sources = times.map((_, i) => {
    const source = path.join(tmp, `representative-frame-${i + 1}.png`);
    fs.copyFileSync(new URL('./__fixtures__/ocr-sample.png', import.meta.url), source);
    return source;
  });
  const findings = [
    { category: '商品信息与Listing准确性', description: '型号尾部被遮挡', reason: '无法确认完整型号', suggestion: '露出完整型号' },
    { category: '隐私', description: '背景门牌可识别', reason: '门牌与人物同框', suggestion: '遮挡门牌' },
    { category: '信息表达', description: '底部说明字号过小', reason: '底部说明无法辨认', suggestion: '放大底部说明' },
  ].map((item, i) => ({ ...item, location: locations[i], severity: 'REVIEW', nature: 'mandatory',
    visual_anchor: `${locations[i]}：${item.description}`, basis_missing: false,
    basis_kind: 'visual_observation', evidence_basis: 'image_observation', source: null, source_url: null }));

  let messageSequence = 0;
  async function run({ issueCount = 1, riskFrames = 6, reportFails = false,
    mutate = () => {}, afterChain = () => {}, chainReport = '', viaHandle = false } = {}) {
    const video = { index: 1, msgId: 'om_current_video', fileKey: 'current-video',
      fileName: 'current.mp4', meta: { duration_s: 12, has_audio: true, has_video: true },
      framesRead: 6, framesFailed: 0, scenePlan: [...times], ocrText: 'Product demonstration',
      frames: times.map((t_s) => ({ t_s, text: 'Product', textRaw: 'Product', lines: ['Product'] })),
      frameScene: times.map((t_s, i) => ({ t_s, ok: true, ms: 1, scene: {
        setting: sceneLabels[i], people: [{ kind: '成人', doing: '手持产品', sleep_scene: false, sleep_posture: '不适用' }],
        products: [{ what: '圆形设备', in_use: true, orientation: '正放' }], text_script: '英文',
        clean_text: ['Product'], visible_marks: [], risk_cues: i < riskFrames ? ['成人手持产品'] : [], unclear: [],
      } })), sceneSkipReason: null, modelFramePaths: [...sources],
      transcript: { ok: true, text: 'Product demonstration.', chars: 22, locale: 'en-US', on_device: true },
    };
    const inbound = { text: '请审核这段产品视频', imageCount: 0, images: [], videoCount: 1, videos: [video] };
    const chain = {
      answer: [
        '审核对象与范围：本次产品视频全片，抽样时间码 00:00 / 00:02 / 00:04 / 00:06 / 00:08 / 00:10。',
        '视觉分析与 OCR：已逐帧查看成人演示画面并读取 Product 字样，音轨转写为 Product demonstration。',
        '主张拆分与核查清单：画面与字幕均为产品演示，没有功效承诺。',
        '4A 规则符合性：本轮 L4、L5、L6、L7 层前置与负面规则检查已执行。',
        '4B 事实准确性核查：与本轮已有产品资料核对，未登记外部事实则不作确定断言。',
        '图文与音画一致性：产品演示、字幕与音轨内容相符，覆盖范围仅为所列时间码。',
        '【审查结论：PASS】未发现已知底线风险，可转交 @内容负责人 进行 sign-off。',
      ].join('\n'),
      review: { state: 'PASS', issue_count: 0, confidence: 0.93, facets: { product_line: '吸奶器', channel: '社媒' } },
      engine: { state: 'PASS', decision: { decision: 'PASS' }, evidence_meta: {
        trace: { negative_rules: negativeTrace(video) },
        video_skill_gate: { ok: true, expected: '视频安全审查', owner: '视频安全审查',
          evidence_kind: 'session_tool_result', checks: ['本会话观测到成功加载'], load: {
            skill: '视频安全审查', session: '/tmp/fixture-current-session.jsonl', verdict: 'loaded', reason: '',
            calls: [{ callId: 'fixture-video-skill', seq: 1, verdict: 'loaded', excerpt: '<skill_content name="视频安全审查">' }],
          } },
        layer_preflight: { ok: true, mode: 'enforced', red_total: 0,
          details: Object.fromEntries(['L4', 'L5', 'L6', 'L7'].map((layer) => [layer, { pass: true, exit: 0, red: 0 }])) },
        decision_owner: { skill: '视频安全审查', mode: 'declared', loaded_skills: ['视频安全审查'] },
      } },
      report: chainReport,
    };
    const model = { ok: true, findings: structuredClone(findings.slice(0, issueCount)), dropped: [], ms: 1 };
    mutate({ video, inbound, chain, model });
    const writes = { reports: [], rows: [] };
    const options = {
      inbound, question: inbound.text, userText: inbound.text, notify: async () => {},
      chainRunner: async () => { afterChain({ video, inbound, chain, model }); return chain; },
      modelSideRunner: async () => model,
      adviceRunner: async () => ({ ok: true, ms: 1, advice: {} }),
      mergedReportRunner: async (markdown, options) => {
        writes.reports.push({ markdown, options });
        return reportFails ? { ok: false, detail: 'fixture report publish failure' } : { ok: true, url: reportUrl };
      },
      publishRunner: async (row) => {
        writes.rows.push(structuredClone(row));
        return { ok: true, action: 'updated', record_id: 'rec_current_video', readback: 'consistent' };
      },
      mediaLinksRunner: async () => [],
      fetchImageForLink: async () => { throw new Error('unexpected image fetch'); },
      fetchVideoForLink: async () => { throw new Error('unexpected video fetch'); },
    };
    const result = viaHandle ? await handleMessage({ sender: {}, message: {
      message_id: `om_video_visibility_${++messageSequence}`, chat_id: 'oc_video_visibility',
      chat_type: 'p2p', message_type: 'media', content: JSON.stringify({
        file_key: 'fixture_video', file_name: 'fixture.mp4', duration: 12000,
      }),
    } }, { ...options, notify: null, deps: {
      loadParent: async () => ({ text: '请审核这段产品视频', images: [], videos: [] }),
      fetchVideo: async () => ({ path: sources[0], bytes: fs.statSync(sources[0]).size, cleanup: () => {} }),
      readVideoFn: async () => ({ ok: true, ...video, sampleFramePaths: [...sources], cleanup: () => {} }),
    } }) : await withAgentTurnContext(() => runSubmissionGate(options));
    const verdict = viaHandle ? result.meta?.verdict53 : result.verdict53;
    const card = toCardOrText(viaHandle ? result.reply : result.forcedReply || result.reviewDirectReply || '', {
      verdict53: verdict,
      reportLink: viaHandle ? result.meta?.reportLink ?? null : result.dual?.reportUrl ?? null,
      reviewRequired: (viaHandle ? result.meta?.gate?.yes : result.gate?.yes) === true && !verdict?.line,
      reviewReason: viaHandle ? result.meta?.imageGateReason ?? null : inbound.videoGateReason ?? null,
    });
    assert.equal(writes.rows.length, 1, 'the real gate must publish exactly one final status row');
    return { result, writes, row: writes.rows[0], card, cardText: sceneText(card.card) };
  }

  for (const riskFrames of [6, 0]) {
    const sample = await run({ riskFrames });
    await test(`1 formal issue + ${riskFrames} risk frames: six scene readings survive final card serialization`, () => {
      assert.equal(sample.card.mode, 'card');
      assertFramesVisible(sample.cardText);
    });
    await test(`1 formal issue + ${riskFrames} risk frames: visual cues do not inflate count or trigger report`, () => {
      assert.equal(sample.row.issueCount, 1);
      assert.equal(sample.result.dual?.total, 1);
      assert.equal(sample.writes.reports.length, 0);
      assert.equal(sample.result.verdict53?.state, 'REVIEW');
    });
  }
  const pass = await run({ issueCount: 0 });
  await test('zero formal issues: PASS card retains all frame observations', () => assertFramesVisible(pass.cardText));
  await test('zero formal issues: six risk cues remain observations, not invented findings', () => {
    assert.equal(pass.row.issueCount, 0);
    assert.equal(pass.result.verdict53?.state, 'PASS');
    assert.equal(pass.writes.reports.length, 0);
  });

  const reported = await run({ issueCount: 3 });
  await test('three formal issues: the published report itself contains every frame, not only local archive', () => {
    assert.equal(reported.writes.reports.length, 1);
    assertFramesVisible(reported.writes.reports[0].markdown);
    assert.equal(reported.row.reportUrl, reportUrl);
  });
  const fallback = await run({ issueCount: 3, reportFails: true });
  await test('report publication failure: final card retains all frame observations', () => {
    assert.equal(fallback.writes.reports.length, 1);
    assertFramesVisible(fallback.cardText);
    assert.equal(fallback.result.dual?.reportUrl ?? null, null);
  });

  for (const [name, mutate] of [
    ['no scene readings', ({ video }) => { video.frameScene = []; }],
    ['one failed scene frame', ({ video }) => { video.frameScene[3] = { t_s: 6, ok: false, error: 'HTTP 402 fixture' }; }],
    ['one planned scene frame missing', ({ video }) => { video.frameScene.splice(3, 1); }],
    ['scene layer deliberately skipped', ({ video }) => { video.frameScene = []; video.sceneSkipReason = 'SHOUHENG_SCENE=0'; }],
    ['one frame OCR failed', ({ video }) => { video.frames[2].failed = 'OCR fixture failure'; video.framesRead = 5; video.framesFailed = 1; }],
    ['ASR timed out', ({ video }) => { video.transcript = { ok: false, kind: 'timeout' }; }],
    ['independent model failed', ({ model }) => { model.ok = false; model.error = 'model fixture failure'; model.findings = []; }],
    ['independent model skipped', ({ model }) => { model.skipped = 'fixture no usable frames'; }],
    ['negative rule layer not_run', ({ chain }) => { chain.engine.evidence_meta.trace.negative_rules = { not_run: 'coverage fixture unavailable' }; }],
    ['negative rule trace absent', ({ chain }) => { delete chain.engine.evidence_meta.trace.negative_rules; }],
    ['negative rule frames belong to another video', ({ chain }) => { chain.engine.evidence_meta.trace.negative_rules.frame_scans[0].video = 2; }],
    ['negative rule frame count matches but timestamp is wrong', ({ chain }) => { chain.engine.evidence_meta.trace.negative_rules.frame_scans[0].t_s = 0.9; }],
    ['negative rule frame consumer reported errors', ({ chain }) => { chain.engine.evidence_meta.trace.negative_rules.frame_scene_errors = ['fixture consumer error']; }],
    ['video skill declared without observed tool result', ({ chain }) => { delete chain.engine.evidence_meta.video_skill_gate; }],
    ['video skill tool result failed', ({ chain }) => {
      chain.engine.evidence_meta.video_skill_gate.ok = false;
      chain.engine.evidence_meta.video_skill_gate.load.verdict = 'error_unknown';
    }],
    ['video skill load still pending despite ok flag', ({ chain }) => { chain.engine.evidence_meta.video_skill_gate.load.verdict = 'pending'; }],
    ['video skill not loaded', ({ chain }) => { chain.engine.evidence_meta.decision_owner.loaded_skills = []; }],
    ['L6 layer did not pass', ({ chain }) => { chain.engine.evidence_meta.layer_preflight.details.L6 = { pass: false, exit: 2, red: 1 }; }],
    ['video skill 4B section omitted', ({ chain }) => { chain.answer = chain.answer.split('\n').filter((line) => !line.startsWith('4B')).join('\n'); }],
  ]) {
    const sample = await run({ issueCount: 3, mutate, chainReport: staleReportUrl });
    await test(`${name}: completion refusal precedes any report publication`, () => {
      assert.equal(sample.writes.reports.length, 0, 'incomplete video escaped to report publisher');
    });
    await test(`${name}: final row says NEEDS_INPUT and clears confidence/link`, () => {
      assert.equal(sample.row.conclusion, 'NEEDS_INPUT');
      assert.equal(sample.row.confidence, 0);
      assert.equal(sample.row.reportUrl, null);
      assert.equal(sample.row.clearReportUrl, true);
    });
    await test(`${name}: no three-state verdict or provisional report survives final card`, () => {
      assert.equal(sample.result.verdict53, null);
      assert.equal(sample.result.reviewDirectReply, null);
      assert.ok(sample.result.forcedReply, 'incomplete review needs an explicit explanation');
      assert.doesNotMatch(sample.cardText, /【(?:审查结论[：:])?(?:PASS(?:\+SUGGEST)?|REVIEW|BLOCK)】/);
      assert.ok(!sample.cardText.includes(staleReportUrl));
      assert.doesNotMatch(sample.row.summary, /【(?:审查结论[：:])?(?:PASS(?:\+SUGGEST)?|REVIEW|BLOCK)】/);
    });
  }
  for (const [name, mutate] of [
    ['silent video without audio track', ({ video }) => { video.meta.has_audio = false; video.transcript = { ok: false, kind: 'no_audio_track' }; }],
    ['audio successfully checked without speech', ({ video }) => { video.transcript = { ok: false, kind: 'no_speech', on_device: true }; }],
  ]) {
    await test(`${name}: legitimate absence is not a failed review`, async () => {
      const sample = await run({ issueCount: 3, mutate });
      assert.equal(sample.row.conclusion, 'REVIEW');
      assert.equal(sample.result.verdict53?.state, 'REVIEW');
      assert.equal(sample.writes.reports.length, 1);
    });
  }
  await test('real 28.9s incident: all six time-stamped visual summaries survive final card without truncation', async () => {
    const sample = await run({ issueCount: 1, mutate: ({ video, chain }) => {
      video.meta.duration_s = 28.9;
      video.scenePlan = incidentFrameReadings.map((frame) => frame.t_s);
      video.frames = incidentFrameReadings.map((frame) => ({ t_s: frame.t_s, text: 'Product' }));
      // The archive has display summaries, not raw model JSON. Reconstruct field
      // containers while preserving every recorded field value verbatim.
      video.frameScene = incidentFrameReadings.map(({ t_s, fields }) => ({ t_s, ok: true, scene: {
        setting: fields['场景'], people: [{ doing: fields['人物'] }],
        products: fields['物品'] ? [{ what: fields['物品'] }] : [],
        visible_marks: [fields['可见标识']], text_script: fields['文字'],
        risk_cues: [fields['画面线索']], clean_text: [], unclear: [],
      } }));
      chain.engine.evidence_meta.trace.negative_rules = negativeTrace(video);
    } });
    assert.equal(sample.row.issueCount, 1);
    assert.equal(sample.writes.reports.length, 0);
    assert.equal(sample.card.mode, 'card');
    for (const { t_s, fields } of incidentFrameReadings) {
      assert.ok(sample.cardText.includes(`[${t_s.toFixed(1)}s]`), `missing incident time ${t_s}`);
      for (const value of Object.values(fields)) {
        assert.ok(sample.cardText.includes(value), `truncated incident field at ${t_s}s: ${value}`);
      }
    }
  });
  await test('exception inside completion validation cannot revive the provisional chain PASS', async () => {
    const sample = await run({ issueCount: 3, chainReport: staleReportUrl,
      afterChain: ({ video }) => Object.defineProperty(video.frameScene[0], 'scene', {
        get() { throw new Error('fixture completion reading failure'); },
      }),
    });
    assert.equal(sample.writes.reports.length, 0);
    assert.equal(sample.row.conclusion, 'NEEDS_INPUT');
    assert.equal(sample.row.confidence, 0);
    assert.equal(sample.row.reportUrl, null);
    assert.equal(sample.result.verdict53, null);
    assert.equal(sample.result.reviewDirectReply, null);
  });
  await test('exception rendering accepted visual data cannot silently discard model findings and revive chain PASS', async () => {
    const sample = await run({ issueCount: 3, chainReport: staleReportUrl,
      afterChain: ({ video }) => { video.frameScene[0].scene.people = {}; },
    });
    assert.equal(sample.writes.reports.length, 0);
    assert.equal(sample.row.conclusion, 'NEEDS_INPUT');
    assert.equal(sample.row.confidence, 0);
    assert.equal(sample.row.reportUrl, null);
    assert.equal(sample.result.verdict53, null);
    assert.equal(sample.result.reviewDirectReply, null);
  });
  await test('handleMessage preserves visual evidence in meta.verdict53 through final card rendering', async () => {
    const sample = await run({ viaHandle: true });
    assert.equal(sample.result.meta?.verdict53?.state, 'REVIEW');
    assert.equal(sample.row.issueCount, 1);
    assertFramesVisible(sample.cardText);
  });
  await test('handleMessage cannot resurrect chain PASS after negative-rule refusal', async () => {
    const sample = await run({ viaHandle: true, issueCount: 3, chainReport: staleReportUrl,
      mutate: ({ chain }) => { chain.engine.evidence_meta.trace.negative_rules = { not_run: 'fixture skipped layer' }; },
    });
    assert.equal(sample.writes.reports.length, 0);
    assert.equal(sample.row.conclusion, 'NEEDS_INPUT');
    assert.equal(sample.result.meta?.verdict53, null);
    assert.equal(sample.result.meta?.reportLink ?? null, null);
    assert.doesNotMatch(sample.cardText, /【(?:审查结论[：:])?(?:PASS(?:\+SUGGEST)?|REVIEW|BLOCK)】/);
    assert.ok(!sample.cardText.includes(staleReportUrl));
  });
  for (const matched_patterns of ['Infinity', 1]) {
    await test(`unsubstantiated P0 marker ${matched_patterns} cannot produce a direct video BLOCK`, async () => {
      const sample = await run({ issueCount: 3, mutate: ({ video, chain }) => {
        video.frameScene.pop();
        chain.answer = '【审查结论：BLOCK】';
        chain.review.state = 'BLOCK';
        chain.engine.decision.decision = 'BLOCK';
        chain.p0_fastpath = { mode: 'p0_fastpath', matched_patterns, rule_codes: ['V02'] };
      } });
      assert.equal(sample.result.p0DirectReply, null);
      assert.equal(sample.result.verdict53, null);
      assert.equal(sample.row.conclusion, 'NEEDS_INPUT');
      assert.equal(sample.writes.reports.length, 0);
    });
  }
  await test('all video regression cases stay offline', () => assert.equal(networkAttempts, 0));
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
console.log(`video_completion_publish: ${cases.length - failed}/${cases.length}, real network attempts=${networkAttempts}`);
if (failed) process.exitCode = 1;

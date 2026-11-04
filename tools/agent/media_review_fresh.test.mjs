#!/usr/bin/env node
/** Each new image/video submission must use its own model and skill results. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { reviewFixtureClaims } from './__fixtures__/image-claim-review.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-media-fresh-'));
const originalRead = fs.readFileSync;
const originalFetch = globalThis.fetch;
const originalConnect = net.Socket.prototype.connect;
const originalEnv = { ...process.env };
Object.assign(process.env, {
  SHOUHENG_STATE_DIR: tmp, SHOUHENG_KB_ROOT: path.join(tmp, 'absent-kb'),
  SHOUHENG_LLM_API_KEY: 'fixture-only', SHOUHENG_LLM_BASE_URL: 'http://127.0.0.1:9',
  SHOUHENG_VISION_BASE_URL: 'http://127.0.0.1:9', SHOUHENG_VISION_API_KEY: 'fixture-only',
  SHOUHENG_IMAGE_MODEL_SIDE_MODEL: 'fixture-vision', SHOUHENG_REVIEW_TABLE: 'off',
  SHOUHENG_MEDIA_LINK: 'off', SHOUHENG_MERGED_RECORD: 'off', SH_FORCE_REPORT: '0',
  KB_CONF_LEDGER: path.join(tmp, 'confidence.ndjson'),
});
fs.readFileSync = (file, ...args) => {
  const p = String(file);
  if (p.endsWith('/.dsh/credentials/shouheng-lark.json')) {
    return JSON.stringify({ app_id: 'cli_fresh_test', app_secret: 'fixture-only' });
  }
  if (p.endsWith('/.config/opencode/opencode.json')) return '{}';
  if (p.endsWith('/.dsh/.credentials.yaml')) throw new Error('No real credentials in this test');
  return originalRead.call(fs, file, ...args);
};
let networkAttempts = 0;
net.Socket.prototype.connect = function () {
  networkAttempts++;
  throw new Error('No real network in this test');
};
const cache = path.join(tmp, 'image-review-results.json');
const source = path.join(tmp, 'source.png');
fs.copyFileSync(new URL('./__fixtures__/ocr-sample.png', import.meta.url), source);
const cases = [];
const test = async (name, fn) => {
  try { await fn(); cases.push({ name, ok: true }); }
  catch (error) { cases.push({ name, ok: false, detail: error.message }); }
};

try {
  const { runSubmissionGate } = await import('./agent.mjs');
  const { withAgentTurnContext } = await import('./tools.mjs');
  const { SYSTEM } = await import('./model_side.mjs');
  const stages = [
    '审核对象与范围：本次原图全图。',
    '视觉分析与 OCR：画面只有产品，OCR品牌标识可读，没有人物和使用场景。',
    '主张拆分与核查清单：C1：图中品牌标识与产品外观，无产品性能宣称。',
    '4A 规则符合性：知识库未命中当前素材问题，规则覆盖不足已记录。',
    '4B 事实准确性核查：',
    '| 主张 | 核查结论 | 依据及边界 | 来源 | 来源原文 |',
    '|---|---|---|---|---|',
    '| C1：品牌标识与产品外观 | 画面可确认 | 依据图中标识和设备轮廓，仅确认可见内容，不推断产品性能 | — | — |',
    '图文一致性：图中文字与产品外观对应，没有相互矛盾的信息。',
    '视觉核对：婴幼儿姿势=无；婴儿睡眠位置=无；产品状态=无；场景关系=无；隐私=无',
  ];
  let modelCalls = 0;
  let chainCalls = 0;
  let modelFails = false;
  const sentImages = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), 'http://127.0.0.1:9/chat/completions');
    const body = JSON.parse(options.body);
    const images = body.messages.flatMap((m) => Array.isArray(m.content) ? m.content : [])
      .filter((part) => part.type === 'image_url');
    sentImages.push(images.length);
    const call = ++modelCalls;
    // Yield so overlapping submissions exercise the old in-flight reuse path.
    await new Promise((resolve) => setImmediate(resolve));
    const content = modelFails ? '本次模型未完成审查' : JSON.stringify([{
      category: '产品描述', location: '图 1 第 2 处', severity: 'REVIEW',
      description: `本次模型发现${call}`, reason: `本次模型读数${call}`,
      suggestion: '核对画面标注', evidence_basis: 'image_observation',
      visual_anchor: '图 1：可见产品标注',
    }]);
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop',
      message: { role: 'assistant', content } }] }), { status: 200 });
  };

  const reset = () => {
    fs.rmSync(cache, { force: true });
    modelCalls = 0; chainCalls = 0; modelFails = false; sentImages.length = 0;
  };
  const send = (type, id, { noSkill = false } = {}) => withAgentTurnContext(async () => {
    const isImage = type === 'image';
    const inbound = isImage
      ? { text: '审核', imageCount: 1, videoCount: 0, images: [{ index: 1,
          msgId: id, imageKey: 'identical-image', text: 'Product', wlText: 'Product',
          scene: { ok: true, scene: { setting: '影棚', people: [], products: [],
            visible_marks: [], clean_text: ['Product'], risk_cues: [] } } }] }
      : { text: '审核', imageCount: 0, videoCount: 1, videos: [{ index: 1,
          msgId: id, fileKey: 'identical-video', bytes: 1234, fileName: 'same.mp4',
          meta: { duration_s: 12, has_audio: true }, ocrText: 'Product',
          frames: [{ t_s: 1, text: 'Product' }], framesRead: 1, framesFailed: 0,
          scenePlan: [1], frameScene: [{ t_s: 1, ok: true,
            scene: { setting: '影棚', people: [], products: [], visible_marks: [],
              clean_text: ['Product'], risk_cues: [] } }],
          transcript: { ok: true, text: 'Product' }, modelFramePaths: [source] }] };
    return runSubmissionGate({
      inbound, question: '审核', userText: '审核', notify: async () => {},
      imageClaimRunner: reviewFixtureClaims,
      chainRunner: async (input) => {
        const n = ++chainCalls;
        assert.equal(input.contentType, type);
        if (isImage) assert.equal(input.imagePaths.length, 1);
        return {
          answer: [...stages, '【审查结论：REVIEW】需要核对。',
            ...(noSkill ? [] : ['## 八、分级结论', '**问题清单**',
              `1. 本次专项发现${n}｜${isImage ? '图 1 第 1 处' : '视频 00:01'}｜改：核对本次材料`]),
          ].join('\n'),
          review: { state: 'REVIEW', issue_count: 0 },
          engine: isImage
            ? { state: 'REVIEW', image_skill_gate: { ok: true, load: { verdict: 'loaded' } } }
            : { decision: { decision: 'REVIEW' }, evidence_meta: {
                trace: { negative_rules: { executed: true, rules_scanned: 1, hits: [],
                  frames_scanned: 1, frame_scene_errors: [],
                  frame_scans: [{ video: 1, t_s: 1, scene: inbound.videos[0].frameScene[0].scene,
                    rules_scanned: 1, visual_rules_scanned: 0, coverage: 'no_visual_rule_cues', hits: [] }],
                  visual_rules_scanned: 0, visual_coverage_gap: true } },
                video_skill_gate: { ok: true, expected: '视频安全审查', owner: '视频安全审查',
                  evidence_kind: 'session_tool_result', checks: [],
                  load: { skill: '视频安全审查', session: `/fixture/${id}.json`, verdict: 'loaded', reason: '',
                    calls: [{ callId: `skill-${id}`, seq: 1, verdict: 'loaded', excerpt: '视频安全审查' }] } },
                layer_preflight: { ok: true, mode: 'enforced', red_total: 0,
                  details: Object.fromEntries(['L4', 'L5', 'L6', 'L7']
                    .map(layer => [layer, { pass: true, exit: 0, red: 0 }])) },
                decision_owner: { skill: '视频安全审查', mode: 'declared', loaded_skills: ['视频安全审查'] },
              } },
        };
      },
      // Keep the real reviewModelSide / llm.ask path: only the HTTP boundary is stubbed.
      publishRunner: async () => ({ ok: true, action: 'skipped', detail: 'offline' }),
      mergedReportRunner: async () => ({ ok: true, url: '', detail: 'offline' }),
      adviceRunner: async () => ({ ok: true, ms: 1, advice: {} }),
      mediaLinksRunner: async () => [],
      fetchImageForLink: async (_id, _key, { dir }) => {
        const dest = path.join(dir, 'original.png');
        fs.copyFileSync(source, dest);
        return { path: dest };
      },
    });
  });

  for (const type of ['image', 'video']) {
    await test(`${type}: repeated sends run the chain and model again`, async () => {
      reset();
      const a = await send(type, 'om_first');
      const b = await send(type, 'om_second');
      assert.equal(chainCalls, 2, 'each send must run its own knowledge chain');
      assert.equal(modelCalls, 2, 'second send must request a fresh model inference');
      assert.deepEqual(sentImages, [1, 1], 'each model request must receive the source image/frame');
      assert.ok(a.reviewDirectReply?.includes('本次模型读数1'), 'first result must contain its own model finding');
      assert.ok(b.reviewDirectReply?.includes('本次模型读数2'), 'second result must contain the new model finding');
      if (type === 'image') {
        assert.ok(b.reviewDirectReply.includes('本次专项发现2'));
        assert.ok(!b.reviewDirectReply.includes('本次专项发现1'));
      }
      assert.equal(fs.existsSync(cache), false, 'must not persist inference results for reuse');
    });
    await test(`${type}: concurrent identical sends have separate inference requests`, async () => {
      reset();
      const results = await Promise.all([send(type, 'om_a'), send(type, 'om_b')]);
      assert.equal(chainCalls, 2);
      assert.equal(modelCalls, 2, 'in-flight inference must not be shared across sends');
      assert.equal(new Set(results.map((r) => r.reviewDirectReply?.match(/本次模型读数\d+/)?.[0])).size, 2);
      assert.deepEqual(sentImages, [1, 1]);
      assert.equal(fs.existsSync(cache), false);
    });
  }

  await test('old image/video model and skill caches are ignored and left untouched', async () => {
    reset();
    const hash = (value) => createHash('sha256').update(value).digest('hex');
    // Fixture for the removed v2 on-disk format, including an empty fresh skill result.
    const legacyKey = (images, model, contract) => hash(JSON.stringify({
      version: 'image-review-findings-v2', images, model, contract: hash(contract), contentType: 'image',
    }));
    const imageDigests = [hash(fs.readFileSync(source))];
    const model = 'http://127.0.0.1:9:fixture-vision';
    const entries = {
      [legacyKey(imageDigests, model, `${SYSTEM}\nimage-safety-full-review-v2`)]: { ok: true, findings: [], dropped: [] },
      [legacyKey([`text:${hash('1234:12.000:Product')}`], model, `${SYSTEM}\nvideo-safety-full-review-v3`)]: { ok: true, findings: [], dropped: [] },
      [`skill:${legacyKey(imageDigests, 'skill-findings', 'skill-findings-v1')}`]: {
        findings: [{ category: '合规', location: '图 1 第 1 处', severity: 'REVIEW',
          description: '旧专项缓存', reason: '旧专项缓存' }], note: '旧专项缓存',
      },
    };
    const before = JSON.stringify({ schema: 'image-review-findings-v2', entries });
    fs.writeFileSync(cache, before);
    const image = await send('image', 'om_old_image', { noSkill: true });
    const video = await send('video', 'om_old_video', { noSkill: true });
    assert.equal(modelCalls, 2, 'old cache must not suppress either inference');
    for (const result of [image, video]) {
      assert.ok(!result.chainBlock.includes('旧专项缓存'), 'old skill findings leaked into this send');
      assert.equal(result.dual.total, 1, 'an empty fresh skill result must not revive cached findings');
    }
    assert.equal(fs.readFileSync(cache, 'utf8'), before, 'legacy file must not be read or rewritten');
  });

  await test('a new model failure is visible instead of returning previous success', async () => {
    reset();
    await send('image', 'om_success');
    modelFails = true;
    const result = await send('image', 'om_failure');
    assert.equal(modelCalls, 2);
    assert.equal(result.dual.ok, false);
    assert.equal(result.verdict53, null, 'failed new image review must withhold the verdict');
    assert.ok(!result.chainBlock.includes('本次模型读数1'));
  });
  assert.equal(networkAttempts, 0);
} finally {
  fs.readFileSync = originalRead;
  globalThis.fetch = originalFetch;
  net.Socket.prototype.connect = originalConnect;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  fs.rmSync(tmp, { recursive: true, force: true });
}
for (const result of cases) console.log(`${result.ok ? '✅' : '❌'} ${result.name}${result.detail ? `: ${result.detail}` : ''}`);
const failed = cases.filter((r) => !r.ok).length;
console.log(`media_review_fresh: ${cases.length - failed}/${cases.length}, real network attempts=${networkAttempts}`);
if (failed) process.exitCode = 1;

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildImageClaimEvidence } from './image_claim_review.mjs';
let viewApi;
try { viewApi = await import('./image_claim_view.mjs'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
const requireApi = () => assert.equal(typeof viewApi?.encodeImageClaimView, 'function');
const dir = new URL('../../PMO/守衡-图片来源逐项核查与交付统一修复-20261103/', import.meta.url);
const actual = () => {
  const request = JSON.parse(fs.readFileSync(new URL('live1401-semantic-2026-11-03T06_23_40_743Z/1.request.json', dir), 'utf8'));
  return JSON.parse(request.messages.find(message => message.role === 'user').content);
};
const keys = ['schema', 'reportText', 'originalRecords', 'records', 'sleepObligations', 'sources', 'claims', 'evidenceHash'];
const payload = evidence => Object.fromEntries(keys.map(key => [key, evidence[key]]));

test('真实394子句请求无损压缩，全部原文/场景/来源/声明/hash逐字段重构', () => {
  requireApi(); const before = actual(); const view = viewApi.encodeImageClaimView(before);
  const after = viewApi.decodeImageClaimView(view);
  assert.deepEqual(payload(after), payload(before));
  assert.equal(after.records.length, 394); assert.equal(view.clauses.length, 394);
  assert.ok(Buffer.byteLength(JSON.stringify(view)) < Buffer.byteLength(JSON.stringify(before)) * 0.5);
  assert.deepEqual(after.coverageManifest.recordIds, before.records.map(record => record.id));
  assert.deepEqual(after.coverageManifest.clauses, before.records.map(record => [record.ordinal, record.id]));
  assert.deepEqual(viewApi.encodeImageClaimView(after), view);
});
test('场景睡眠义务、原文空白、Unicode与空素材记录都逐字往返', () => {
  requireApi(); const before = actual();
  const input = { reportText: before.reportText, sources: before.sources,
    scenes: [{ people: [{ kind: '婴儿', doing: '侧卧睡眠😀', sleep_scene: true, sleep_posture: '侧卧' }],
      extra: { untouched: ['字段，不能丢', null, false, 3] } }],
    materialTexts: [{ origin: 'image_ocr', status: 'empty', text: '' },
      { origin: 'visual_text', status: 'ok', text: '  原字😀，\n\t下一行；  ' }] };
  const built = buildImageClaimEvidence(input); assert.equal(built.ok, true, built.reason);
  const decoded = viewApi.decodeImageClaimView(viewApi.encodeImageClaimView(built));
  assert.deepEqual(payload(decoded), payload(built));
  assert.ok(decoded.sleepObligations.length); assert.equal(decoded.reportText, input.reportText);
});
for (const [name, mutate] of [
  ['原子句文字', v => { v.clauses[0][3] += '新增'; }],
  ['子句序号', v => { v.clauses[0][0] = 2; }],
  ['父记录索引', v => { v.clauses[0][1] = 9999; }],
  ['子句offset', v => { v.clauses[0][2] = 1; }],
  ['父元数据', v => { v.parents[0].line += 1; }],
  ['全文空白', v => { v.reportGaps[0] += ' '; }],
  ['来源正文', v => { v.sources[0].content += ' tampered'; }],
  ['声明原文', v => { v.claims[0].text += ' tampered'; }],
  ['C绑定', v => { v.claims[0].recordOrdinals = []; }],
  ['coverage清单', v => { v.coverageManifest.recordCount--; }],
  ['删子句', v => { v.clauses.pop(); }],
  ['额外wire字段', v => { v.extra = true; }],
]) test(`${name}篡改必须拒绝，不能默认成功`, () => {
  requireApi(); const view = viewApi.encodeImageClaimView(actual()); mutate(view);
  assert.throws(() => viewApi.decodeImageClaimView(view));
});
test('发送前encode自己验证原全证据hash，陈旧hash或不完整父记录不得发模型', () => {
  requireApi(); const before = actual(); before.originalRecords[0].text += '修改';
  assert.throws(() => viewApi.encodeImageClaimView(before));
});

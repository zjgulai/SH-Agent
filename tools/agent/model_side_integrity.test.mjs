import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFindings, reviewModelSide } from './model_side.mjs';
import { mergeFindings, mergedState } from './dual_track.mjs';
import { buildMergedRecord } from './merged_record.mjs';

const VALID = Object.freeze({ location: '图 1 第 1 处', category: '消费者安全',
  description: '婴儿口鼻被软枕遮挡', reason: '婴儿口鼻被软枕遮挡', suggestion: '移开软枕',
  evidence_basis: 'image_observation', visual_anchor: '图 1 床面枕头遮挡婴儿口鼻' });
const LONG = { ...VALID, reason: '婴儿口鼻被遮挡。'.repeat(15) };
const KB = { state: 'REVIEW', issueCount: 0, coverageGap: true, hasSidecar: true, refused: false };
const stateOf = (p) => mergedState({ kbCovered: false, kb: KB,
  merged: mergeFindings([], p.findings).items, modelFailed: p.ok === false });
const parse = (rows) => parseFindings(JSON.stringify(rows), { allowVisualNoBasis: true });
async function run(outputs, readings = '【图 1 画面】婴儿躺在软枕旁') {
  let calls = 0;
  const value = await reviewModelSide({ readings, imagePaths: ['/tmp/model-integrity-fixture.webp'],
    requiredImageCount: 1, ask: async () => {
      const out = outputs[calls++];
      if (out instanceof Error) throw out;
      assert.notEqual(out, undefined, '不得增加模型调用次数');
      return typeof out === 'string' ? out : JSON.stringify(out);
    } });
  return { value, calls };
}

test('合法空清单仍 PASS，合法视觉发现仍 REVIEW', () => {
  assert.equal(stateOf(parse([])), 'PASS');
  assert.equal(stateOf(parse([VALID])), 'REVIEW');
});

test('完整顶层数组及单个JSON围栏合法，错误对象和前后冲突说明不得截取内部空数组', () => {
  for (const raw of ['[]', '  []\n', '```json\n[]\n```', '```\n[]\n```']) {
    assert.equal(parseFindings(raw).ok, true, raw);
  }
  for (const raw of [
    '{"status":"failed","error":"原图无法读取","findings":[]}',
    '原图无法读取，暂时无法审查。[]',
    '[]\n以上只是占位，审核尚未完成。',
    '```json\n[]\n```\n无法读取原图',
    '```json\n[]\n```\n```json\n[]\n```',
  ]) {
    const p = parseFindings(raw);
    assert.equal(p.ok, false, raw);
    assert.notEqual(stateOf(p), 'PASS', raw);
  }
});

for (const [name, item] of [
  ['非对象', null], ['未知类目', { ...VALID, category: '婴儿安全' }],
  ['空理由', { ...VALID, reason: '' }], ['理由错误类型', { ...VALID, reason: {} }],
]) test(`${name}不能作为完整的零发现放行`, () => {
  const p = parse([item]);
  assert.equal(p.ok, false);
  assert.notEqual(stateOf(p), 'PASS');
  assert.equal(p.parse_audit.structural_errors.length, 1);
});

test('部分结构错误保留有效发现，但整份结果不能声称完成', () => {
  const p = parse([VALID, { ...VALID, category: '未知类目' }]);
  assert.equal(p.ok, false);
  assert.equal(p.findings.length, 1);
  assert.equal(p.parse_audit.input_count, 2);
  assert.equal(p.parse_audit.parsed_count, 1);
});

test('正确排除截图署名水印允许零发现，并区别于结构错误', () => {
  const p = parse([{ ...VALID, reason: '截图层水印Owner 5615 ROOT' }]);
  assert.equal(p.ok, true);
  assert.equal(stateOf(p), 'PASS');
  assert.equal(p.parse_audit.structural_errors.length, 0);
  assert.equal(p.parse_audit.exclusions.length, 1);
  assert.equal(p.parse_audit.exclusions[0].rule, 'screenshot_watermark');
});

for (const [name, replacement] of [
  ['删除全部发现', []],
  ['追加发现', [VALID, { ...VALID, location: '图 1 第 2 处' }]],
  ['改位置', [{ ...VALID, location: '图 2 第 1 处' }]],
  ['改未超限描述', [{ ...VALID, description: '没有风险' }]],
  ['改视觉锚点', [{ ...VALID, visual_anchor: '其他画面' }]],
  ['新增未知字段', [{ ...VALID, another: 'changed' }]],
  ['把超限原因清空', [{ ...VALID, reason: '' }]],
  ['重写后仍超限', [LONG]],
]) test(`字数重写${name}必须保留首版`, async () => {
  const { value: p, calls } = await run([[LONG], replacement]);
  assert.equal(calls, 2);
  assert.equal(p.ok, true);
  assert.equal(p.findings.length, 1);
  assert.equal(p.findings[0].reason, LONG.reason);
  assert.equal(stateOf(p), 'REVIEW');
  assert.equal(p.raw, JSON.stringify([LONG]));
  assert.equal(p.audit.selected_attempt, 1);
  assert.equal(p.audit.rewrite.accepted, false);
  assert.ok(p.audit.rewrite.reason);
  assert.equal(p.audit.attempts[1].raw, JSON.stringify(replacement));
});

test('字数重写只改指定超限格时采用第二版，完整记录两次尝试', async () => {
  const { value: p } = await run([[LONG], [VALID]]);
  assert.equal(p.findings[0].reason, VALID.reason);
  assert.equal(p.audit.selected_attempt, 2);
  assert.equal(p.audit.rewrite.accepted, true);
  assert.equal(p.audit.attempts.length, 2);
  assert.equal(p.audit.attempts[0].raw, JSON.stringify([LONG]));
  assert.equal(p.audit.attempts[1].raw, JSON.stringify([VALID]));
});

test('字数重写不得通过原因文字改变派生nature，把强制问题降为建议', async () => {
  const first = { ...LONG, nature: '强制', severity: 'REVIEW' };
  const second = { ...first, reason: '不影响发布，属于建议优化' };
  const { value: p } = await run([[first], [second]]);
  assert.equal(p.audit.rewrite.accepted, false);
  assert.equal(p.findings[0].nature, 'mandatory');
  assert.equal(p.findings[0].reason, first.reason);
  assert.match(p.audit.rewrite.reason, /nature/);
});

test('重写调用异常保留已完成首版及失败尝试', async () => {
  const { value: p } = await run([[LONG], new Error('fixture transport failure')]);
  assert.equal(p.ok, true);
  assert.equal(p.findings[0].reason, LONG.reason);
  assert.equal(p.audit.selected_attempt, 1);
  assert.match(p.audit.attempts[1].error, /fixture transport failure/);
});

test('首次调用传输失败保留未收到输出的形状，不伪装成空正文解析错误', async () => {
  const { value: p, calls } = await run([new Error('fixture transport failure')]);
  assert.equal(p.ok, false);
  assert.equal(calls, 1);
  assert.equal(p.raw, undefined);
  assert.equal(p.audit.attempts[0].raw, null);
  assert.match(p.audit.attempts[0].error, /fixture transport failure/);
});

test('多条发现重写不能交换顺序或修改另一条未超限原因', async () => {
  const second = { ...VALID, location: '图 1 第 2 处', reason: '另一处软垫紧贴口鼻' };
  for (const output of [[second, VALID], [VALID, { ...second, reason: '正常使用' }]]) {
    const { value: p } = await run([[LONG, second], output]);
    assert.equal(p.findings.length, 2);
    assert.equal(p.findings[0].reason, LONG.reason);
    assert.equal(p.findings[1].reason, second.reason);
    assert.equal(p.audit.rewrite.accepted, false);
  }
});

test('建议超限重写只允许改 suggestion，且第二轮收到首版原始数组', async () => {
  const original = { ...VALID, suggestion: '移开床面遮挡口鼻的枕头'.repeat(12) };
  let calls = 0;
  const p = await reviewModelSide({ readings: '素材', imagePaths: ['/tmp/fixture.webp'],
    ask: async (prompt) => {
      calls++;
      if (calls === 1) return JSON.stringify([original]);
      assert.ok(prompt.includes(JSON.stringify([original])));
      return JSON.stringify([VALID]);
    } });
  assert.equal(p.findings[0].suggestion, VALID.suggestion);
  assert.equal(p.audit.rewrite.accepted, true);
});

test('语法修复保留坏输出和成功输出；不会把首次坏输出记成空数组', async () => {
  const { value: p } = await run(['[{broken}]', []]);
  assert.equal(p.ok, true);
  assert.equal(stateOf(p), 'PASS');
  assert.equal(p.audit.attempts[0].raw, '[{broken}]');
  assert.equal(p.audit.attempts[0].ok, false);
  assert.equal(p.audit.attempts[0].parse.input_count, null);
  assert.equal(p.audit.attempts[1].parse.input_count, 0);
});

test('后置OCR规则排除也留下原始数量、规则与原因', async () => {
  const item = { ...VALID, reason: '标题大小写错误', description: '大小写混用' };
  const { value: p } = await run([[item]]);
  assert.equal(p.ok, true);
  assert.equal(stateOf(p), 'PASS');
  assert.equal(p.audit.attempts[0].parse.input_count, 1);
  assert.equal(p.audit.attempts[0].parse.parsed_count, 1);
  assert.equal(p.audit.attempts[0].parse.retained_count, 0);
  assert.equal(p.audit.attempts[0].parse.exclusions[0].rule, 'ocr_casing_noise');
});

test('合并记录序列化后保留模型原始结果、排除与重写选择，不携带输入图片', async () => {
  const { value: model } = await run([[LONG], []]);
  const rec = JSON.parse(JSON.stringify(buildMergedRecord({ model, state: 'REVIEW' })));
  assert.equal(rec.model.raw, JSON.stringify([LONG]));
  assert.equal(rec.model.audit.selected_attempt, 1);
  assert.equal(rec.model.audit.attempts[1].raw, '[]');
  assert.equal(rec.model.audit.rewrite.accepted, false);
  assert.equal(rec.model.audit.attempts[0].parse.input_count, 1);
  assert.ok(!JSON.stringify(rec.model).includes('/tmp/model-integrity-fixture.webp'));
});

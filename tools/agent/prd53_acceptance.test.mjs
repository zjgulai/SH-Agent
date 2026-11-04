#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeFindings, renderMerged, mergedState } from './dual_track.mjs';
import { renderMergedReportMd } from './merged_report.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(here, 'prd53_acceptance.fixtures.json'), 'utf8'));
const finding = (index, category, state = 'REVIEW') => ({
  location: `图 1 第 ${index} 处`, category, severity: state, source: 'kb',
  reason: `固定验收原因 ${index}`, excerpt: `固定命中片段 ${index}`,
  basisLine: `《内容治理规则库》第 W-1.${index} 条｜原始出处：[点开核对](https://example.invalid/source/${index})`,
  kb: { article_no: `W-1.${index}`, entry_url: `https://example.invalid/source/${index}`,
    basisLine: `《内容治理规则库》第 W-1.${index} 条｜原始出处：[点开核对](https://example.invalid/source/${index})`,
    suggestionLine: `固定修改建议 ${index}` },
});

assert.equal(fixture.source, 'PRD/feishu/内容审查Agent-PRD-v1.0.md §5.3–5.4');
assert.deepEqual(fixture.state_contract, ['PASS', 'REVIEW', 'BLOCK']);
for (const item of fixture.cross_layer_evidence) {
  assert.ok(item.test_id && item.source, `追溯项缺少实际测试指针：${item.requirement}`);
  const evidenceSource = fs.readFileSync(path.resolve(here, '../..', item.source), 'utf8');
  for (const testId of item.test_id.split('/')) {
    assert.ok(evidenceSource.includes(testId), `测试指针失效：${item.source} 缺少 ${testId}`);
  }
}

// 三态收据：PASS 只有覆盖完整且双侧无问题时可达；REVIEW/BLOCK 由 finding 决定。
for (const sample of fixture.state_inputs) {
  const merged = Array.from({ length: sample.finding_count }, (_, i) => finding(i + 1,
    '合规与受监管宣称-医疗宣称', sample.state === 'BLOCK' ? 'BLOCK' : 'REVIEW'));
  const actual = mergedState({ kbCovered: sample.kb_covered, merged,
    kb: { hasSidecar: true, state: 'PASS', issueCount: 0 } });
  assert.equal(actual, sample.state, `${sample.id}: 三态回执`);
}
assert.notEqual(mergedState({ kbCovered: false, merged: [], kb: { hasSidecar: true, state: 'PASS', issueCount: 0 } }), 'PASS');

for (const sample of fixture.cases) {
  const inputs = Array.from({ length: sample.item_count }, (_, i) => finding(i + 1, `${sample.category}-医疗宣称`, sample.state === 'BLOCK' ? 'BLOCK' : 'REVIEW'));
  const merged = mergeFindings(inputs, []).items;
  assert.equal(merged.length, sample.item_count, `${sample.id}: 唯一问题计数`);
  const output = renderMerged(merged, { state: sample.state, reportUrlOverride: 'https://example.invalid/report/golden' });
  assert.ok(output, `${sample.id}: 必须生成 PRD §5.3 输出块`);
  assert.match(output.line, new RegExp(`审查结论：${sample.state}】共发现 ${sample.item_count} 处`));
  assert.equal((output.block.match(/^\d+\.【/gm) ?? []).length, sample.expected.numbered_items, `${sample.id}: 逐条/汇总形态`);
  assert.equal((output.block.match(/^· /gm) ?? []).length, sample.expected.summary_lines ?? 0, `${sample.id}: 汇总条数`);
  assert.equal(output.block.includes('https://example.invalid/report/golden'), sample.expected.report_link, `${sample.id}: 报告链接门槛`);
  assert.ok(output.block.includes(sample.expected.action), `${sample.id}: 动作回执`);
  if (sample.item_count < 3) {
    assert.ok(output.block.includes('https://example.invalid/source/1'), `${sample.id}: 卡面原文证据链接`);
  } else {
    const report = renderMergedReportMd({
      merged, total: merged.length, state: sample.state, line: output.line,
      question: '固定验收问题', material: { text: '固定图片送审素材' }, withAppendix: false,
    });
    assert.ok(report.includes('https://example.invalid/source/1'), `${sample.id}: 报告保留逐条原文证据链接`);
    assert.match(report, new RegExp(`共发现 ${sample.item_count} 处`));
  }
}

// 同图同位置重复 findings 合并为一条；不同面板位置保留为两条，避免跨面板误并。
const duplicate = finding(1, '合规与受监管宣称-医疗宣称');
assert.equal(mergeFindings([duplicate, { ...duplicate }], []).items.length, 1);
assert.equal(mergeFindings([duplicate, { ...finding(2, duplicate.category), location: '图 1 第 2 处' }], []).items.length, 2);

console.log(`PRD §5.3 固定验收夹具：${fixture.cases.length} 个输出样例 + ${fixture.state_inputs.length} 个三态输入 + 证据/唯一计数通过`);

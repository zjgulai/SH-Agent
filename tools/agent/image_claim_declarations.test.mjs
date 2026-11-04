import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

let api;
try { api = await import('./image_claim_declarations.mjs'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
const parse = body => { assert.equal(typeof api?.parseClaimDeclarations, 'function'); return api.parseClaimDeclarations(body); };
const fixture = name => fs.readFileSync(new URL(`../../PMO/守衡-图片来源逐项核查与交付统一修复-20261103/live1401-replay-20261103/${name}-report.md`, import.meta.url), 'utf8');
const body = text => text.split('## 三、主张拆分与核查清单')[1].split('## 四、4A 规则符合性')[0].trim();

test('真实首轮八条表声明，编号范围与正文引用不新增声明', () => {
  const result = parse(body(fixture('first')));
  assert.equal(result.ok, true, result.errors.join('；'));
  assert.deepEqual(result.ids, ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8']);
  assert.equal(result.entries.length, 8);
});
test('真实补交的4B映射列及41次引用仍只有八条声明，主张正文完全不变', () => {
  const first = parse(body(fixture('first'))); const after = parse(body(fixture('recovery')));
  assert.equal(after.ok, true, after.errors.join('；'));
  assert.deepEqual(after.entries.map(({ id, text }) => ({ id, text })), first.entries.map(({ id, text }) => ({ id, text })));
  assert.ok(after.entries[0].raw.includes('| C1 |'));
  assert.ok(after.entries[0].raw.endsWith('| C1 |'));
});
test('行首声明与多行正文保留原文、offset，正文再次提C不是新声明', () => {
  const text = '- **C1**：产品颜色为蓝色。\n  此处与 C2 一起核查。\n\n- C2：容量未知。';
  const result = parse(text);
  assert.equal(result.ok, true, result.errors.join('；')); assert.deepEqual(result.ids, ['C1', 'C2']);
  assert.match(result.entries[0].text, /此处与 C2/);
  for (const entry of result.entries) assert.equal(text.slice(entry.start, entry.end), entry.raw);
});
test('表里真正重复主键拒绝，即使内容完全相同', () => {
  const r = parse('| 编号 | 主张 |\n|---|---|\n| C1 | 蓝色产品 |\n| C1 | 蓝色产品 |');
  assert.equal(r.ok, false); assert.match(r.errors.join(' '), /C1.*重复|重复.*C1/);
});
for (const invalid of ['C6′', 'C1a']) {
  test(`${invalid}声明不得静默归一化`, () => {
    for (const value of [`${invalid}：原主张。`, `| 编号 | 主张 |\n|---|---|\n| ${invalid} | 原主张 |`]) {
      const r = parse(value); assert.equal(r.ok, false); assert.match(r.errors.join(' '), /非法/);
      assert.deepEqual(r.ids, []);
    }
  });
}
test('严格引用提取保留合法C引用，不将历史C6′/C1a绑定为当前C', () => {
  parse('C1：测试。');
  assert.deepEqual(api.extractClaimIds('C1、C6′、C1a；C2↔C2，见C3。'), ['C1', 'C2', 'C3']);
});
test('只有正文编号映射或范围不能冒充声明', () => {
  for (const value of ['（C1–C5、C7用于4A）', 'C1↔C1、C2↔C2。', '参见 C1、C2。']) {
    const r = parse(value); assert.equal(r.ok, false); assert.deepEqual(r.entries, []);
  }
});
test('表主张列自身带编号也可解析，普通来源列中的C仅为引用', () => {
  const r = parse('| 主张 | 来源 |\n|---|---|\n| C1：白色产品 | 见C2 |\n| C2：容量未知 | 画面 |');
  assert.equal(r.ok, true, r.errors.join(' ')); assert.equal(r.entries.length, 2);
  assert.equal(r.entries[0].text, '白色产品');
});

#!/usr/bin/env node
/** Link access requests must not become reviews; no config, credentials or network. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { linkAccessIntent } from './link_access.mjs';

// Execute the production pure gate without importing feishu/config's credentials
// and directory setup. handleMessage wiring is covered by the isolated workflow test.
const source = fs.readFileSync(new URL('./review_gate.mjs', import.meta.url), 'utf8');
const start = source.indexOf('export const MIN_REVIEW_CHARS');
const end = source.indexOf('/* ─────────────── 送进链里的东西');
assert.ok(start >= 0 && end > start, 'pure gate source boundary must exist');
const context = vm.createContext({ linkAccessIntent });
vm.runInContext(source.slice(start, end).replace(/^export /gm, '')
  + '\nglobalThis.gate = isSubmission;', context);
const gate = (input) => context.gate(input);

const LINK = 'https://momcozy-in.feishu.cn/wiki/FzAdwjTWdiUcEOkRI0gcjEeknJb?table=tblHY683L5qrXgHI&view=vewgbmVI9X';
const withUrl = (text) => `${LINK}\n${text}`;

test('the reported question and explicit access variants do not start a review', () => {
  for (const question of [
    '你可以读取这个文档吗？', '你能读取这个文档吗', '能读吗？',
    '你可以读取这个文档？', '可以访问这个链接?', '你为什么不读取这个文档？',
    '你可以读吗？', '有没有权限？',
    '@_user_1 你可以读取这个文档吗？', '守衡，这个链接能打开吗？',
    '能不能访问这个文档？', '你有权限读取这个文档吗？', '这篇文档有没有读取权限？',
    '这个链接可读吗？', '只读不用审核', '只读取，不要审查',
    '只确认能不能读取，不要启动审核', '先读取，不要审；稍后我再告诉你要不要审核',
    '你能读取这个审核记录表吗？', '你有读取飞书文档的权限，也可使用我的用户身份读取，不用下载，有权限不许说没权限',
  ]) {
    const result = gate({ text: withUrl(question) });
    assert.equal(result.yes, false, question);
    assert.equal(result.guard, 'link-access', question);
    assert.deepEqual([...result.links], [LINK]);
  }
  for (const text of [`审核记录表 ${LINK} 你可以读取这个文档吗？`, `[审核记录表](${LINK}) 能读取吗？`]) {
    assert.equal(gate({ text }).guard, 'link-access', text);
  }
});

test('a long explicit read-only request cannot fall back into automatic review', () => {
  const result = gate({ text: withUrl(`只读不用审核。${'这是这份文档的背景说明。'.repeat(9)}`) });
  assert.equal(result.yes, false);
  assert.equal(result.guard, 'link-access-clarify');
});

test('the pure classifier returns its documented contract and does not inspect absent links', () => {
  assert.equal(linkAccessIntent('你可以读取这个文档吗？').intent, null);
  for (const [text, intent] of [
    [withUrl('能读吗？'), 'read-access'],
    [withUrl('只读但帮我审一下'), 'clarify'],
    [withUrl('读到后帮我审核'), null],
    [LINK, null],
  ]) {
    const result = linkAccessIntent(text);
    assert.equal(result.intent, intent, text);
    assert.equal(typeof result.why, 'string');
    assert.ok(result.why.length > 0);
  }
});

test('bare links, the approved read-this default and affirmative review requests still review', () => {
  for (const question of [
    '', '你读一下', '看看这个', '请审核这个文档',
    '能读取吗？读到后帮我审核', '能读取吗？读到后审核',
    '你可以读取这个文档吗？可以的话帮我审一下',
    '你可以读取文档吗？顺便告诉我这个能不能发',
    '这份材料能读到吗？请判断有没有风险',
    '这条链接能读吗？如果可以读取，请将里面的广告内容按完整流程审核并给出结论',
    '能读取吗？再审一下这篇内容', '能读取吗？这篇内容是否合规',
    '能读取吗？这份材料有没有违规', '能读取吗？不要只读，帮我审核',
  ]) {
    const result = gate({ text: withUrl(question) });
    assert.equal(result.yes, true, question);
    assert.equal(result.kind, 'link', question);
  }
  const longMixed = gate({ text: withUrl('能读取吗？请审核一遍这个文档里的所有广告文案，重点看措辞是否合规并把每个问题列出来') });
  assert.equal(longMixed.yes, true, 'long affirmative review cannot be swallowed by the old meta-ask gate');
  assert.equal(longMixed.kind, 'text', 'long mixed request preserves the existing length-based material kind');
});

test('contradictory immediate review and read-only instructions require clarification', () => {
  for (const question of [
    '只读不用审核，但读完帮我审一下',
    '不要审核这个文档；现在请帮我审核这个文档',
    '只读不要审核但现在请帮我审核', '不需要审但马上审核',
  ]) {
    const result = gate({ text: withUrl(question) });
    assert.equal(result.yes, false, question);
    assert.equal(result.guard, 'link-access-clarify', question);
  }
});

test('mentions of a later review do not authorize a review now', () => {
  for (const question of [
    '先帮我确认能不能读取，稍后再审核',
    '只读这个文档，等我确认后再审核',
    '能读取吗？审核先不要做',
  ]) {
    const result = gate({ text: withUrl(question) });
    assert.equal(result.yes, false, question);
    assert.equal(result.guard, 'link-access', question);
  }
});

test('quoted material or separate copy cannot impersonate a read-only instruction', () => {
  for (const question of [
    '请审核这句文案：“你可以读取这个文档吗？”',
    '文案：“只读不用审核”。请判断能不能发。',
  ]) {
    const result = gate({ text: withUrl(question) });
    assert.equal(result.yes, true, question);
  }
  const result = gate({ text: withUrl('你可以读取这个文档吗？文案：“全球第一，保证治愈”。') });
  assert.equal(result.guard, 'link-access-clarify', 'a read question plus supplied material has conflicting scope');
  for (const question of [
    '你能读取这个文档吗？这是最好的产品，保证治疗乳腺炎',
    `这款吸奶器是全球第一，保证治疗乳腺炎。${'这是要发出的正文。'.repeat(8)}你可以读取这个文档吗？`,
  ]) {
    const result = gate({ text: withUrl(question) });
    assert.equal(result.yes, false, question);
    assert.equal(result.guard, 'link-access-clarify', 'access question plus independent material needs scope confirmation');
  }
});

test('images and videos keep their prior review priority over an access caption', () => {
  for (const counts of [{ imageCount: 1 }, { videoCount: 1 }]) {
    const result = gate({ text: withUrl('只读不用审核'), ...counts });
    assert.equal(result.yes, true);
    assert.equal(result.kind, 'media');
  }
});

test('without a URL the new access route does not apply', () => {
  assert.equal(gate({ text: '你可以读取这个文档吗？' }).guard, undefined);
  assert.equal(gate({ text: '请审核这句文案，全球第一' }).yes, true);
});

test('explicit no-read instructions skip reading, while review conflicts clarify', () => {
  for (const question of ['不要读取这个链接，也不要审核', '不需要读取也不要审查']) {
    const text = withUrl(question);
    assert.equal(linkAccessIntent(text).intent, 'skip', question);
    const result = gate({ text });
    assert.equal(result.yes, false, question);
    assert.equal(result.guard, 'link-access-skip', question);
  }
  assert.equal(gate({ text: withUrl('不要读取这个链接，但现在帮我审核') }).guard, 'link-access-clarify');
  assert.equal(gate({ text: withUrl('不要只读，帮我审核') }).yes, true);
  assert.equal(gate({ text: withUrl('不下载、只读取') }).guard, 'link-access');
  assert.equal(gate({ text: withUrl('你可以读取这个文档吗？文案：“不要读取这个链接”') }).guard,
    'link-access-clarify', 'quoted no-read text is material, not an instruction to skip');
});

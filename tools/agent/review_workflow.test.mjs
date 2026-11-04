#!/usr/bin/env node
/** Offline contract tests for Feishu Q&A and text/image/link review routing. */
import assert from 'node:assert/strict';
import {
  chainInput, findLinks, isSubmission, mechanismQuestion, prepareLinkReview,
  reviewWorkflowMechanismAnswer,
} from './review_gate.mjs';
import { runSubmissionGate } from './agent.mjs';
import { buildSystemPrompt } from './persona.mjs';

const cases = [];
const test = async (name, fn) => {
  await fn();
  cases.push(name);
  console.log(`  ✅ ${name}`);
};

await test('mechanism question with review vocabulary remains Q&A', () => {
  const text = '你的审核规则是怎么做的？';
  assert.equal(mechanismQuestion(text).ask, true);
  assert.equal(isSubmission({ text }).yes, false);
});

await test('three-modality mechanism Q&A answers from live workflow facts without starting review', () => {
  const q = '【审核联调·问答】请说明文字、图片、链接三类内容审核分别怎么进入审查流程？这只是流程问题，不是待审素材。';
  const answer = reviewWorkflowMechanismAnswer(q);
  assert.match(answer, /没有启动审核链/);
  assert.match(answer, /OCR 文字和画面读数/);
  assert.match(answer, /读取.*公网 HTTP\(S\).*页面/);
  assert.match(answer, /长文本里带 URL 仍按文本送审/);
  // ★ 2026-10-22：飞书链接与公网页面是两条路，流程说明必须**两条都写到**
  assert.match(answer, /飞书文档链接走飞书只读接口/);
  assert.match(answer, /附件（pptx \/ pdf \/ xlsx 等）按红线不下载/);
  assert.equal(reviewWorkflowMechanismAnswer('你的审核规则是怎么做的？'), null);
  assert.equal(reviewWorkflowMechanismAnswer('请审核这段广告文案：纯文字。'), null);
});

await test('mechanism Q&A gets current workflow facts that override stale chat history', () => {
  const prompt = buildSystemPrompt('', { workflowQuestion: true });
  assert.match(prompt, /当前内容审核流程事实（优先于历史对话）/);
  assert.match(prompt, /抓取可读正文后送入同一审核链/);
  assert.match(prompt, /明确更正旧说法/);
  assert.match(prompt, /飞书文档链接走飞书只读接口读正文/);
  assert.match(prompt, /按红线\*\*不下载\*\*/);
  assert.doesNotMatch(buildSystemPrompt(), /当前内容审核流程事实（优先于历史对话）/);
});

await test('explicit text review enters the text submission path', () => {
  const text = '请审核这段广告文案：吸奶器帮助妈妈轻松喂养宝宝。';
  const gate = isSubmission({ text });
  assert.equal(gate.yes, true);
  assert.equal(gate.kind, 'text');
});

await test('image-only message enters review even without a caption', () => {
  const gate = isSubmission({ text: '', imageCount: 1 });
  assert.equal(gate.yes, true);
  assert.equal(gate.kind, 'media');
});

await test('bare URL enters the link submission path', () => {
  const gate = isSubmission({ text: 'https://momcozy.com/products/example' });
  assert.equal(gate.yes, true);
  assert.equal(gate.kind, 'link');
  assert.deepEqual(gate.links, ['https://momcozy.com/products/example']);
});

await test('Chinese sentence punctuation is excluded from extracted URLs', () => {
  assert.deepEqual(findLinks('请审核这个页面：https://www.example.com/。'), ['https://www.example.com/']);
  assert.deepEqual(findLinks('看这里：https://example.com/page?x=1，之后再回复'), ['https://example.com/page?x=1']);
});

await test('link-only review reads page body into the chain input', async () => {
  const gate = isSubmission({ text: 'https://example.com/offer' });
  const prepared = await prepareLinkReview({ gate, input: { question: gate.links[0], text: gate.links[0] },
    reader: async (url) => ({ url, contentType: 'text/html', text: '页面产品功效声明' }) });
  assert.equal(prepared.forcedReply, null);
  assert.match(prepared.input.text, /页面产品功效声明/);
  assert.equal(prepared.pages.length, 1);
});

await test('unreadable link fails closed without review content', async () => {
  const gate = isSubmission({ text: 'https://example.com/offer' });
  let calls = 0;
  const prepared = await prepareLinkReview({ gate, input: { text: gate.links[0] },
    reader: async () => { calls++; throw new Error('HTTP 403'); } });
  assert.equal(calls, 1);
  assert.match(prepared.forcedReply, /未读取到的内容不会判为通过/);
  assert.doesNotMatch(prepared.input.text, /页面产品功效声明/);
});

await test('failed link read skips chain, model review, and publishing', async () => {
  const calls = { chain: 0, model: 0, publish: 0 };
  const result = await runSubmissionGate({
    inbound: { text: 'https://example.com/offer', images: [], videos: [] },
    question: 'https://example.com/offer',
    linkReader: async () => { throw new Error('HTTP 403'); },
    chainRunner: async () => { calls.chain++; return {}; },
    modelSideRunner: async () => { calls.model++; return { ok: true, findings: [] }; },
    publishRunner: async () => { calls.publish++; return { ok: true }; },
    notify: null,
  });
  assert.match(result.forcedReply, /未读取到的内容不会判为通过/);
  assert.equal(result.chainRan, false);
  assert.deepEqual(calls, { chain: 0, model: 0, publish: 0 });
});

await test('long text containing a URL remains text and preserves both inputs', () => {
  const body = `请审核这段广告正文：${'吸奶器帮助妈妈轻松喂养宝宝。'.repeat(4)}`;
  const url = 'https://momcozy.com/products/example';
  const text = `${body}\n来源：${url}`;
  const gate = isSubmission({ text });
  assert.equal(gate.yes, true);
  assert.equal(gate.kind, 'text');
  assert.deepEqual(gate.links, [url]);

  const input = chainInput({ question: text, inbound: { text } });
  assert.ok(input.text.includes(body), '正文被链接分支丢掉');
  assert.ok(input.text.includes(url), '正文里的 URL 没有随链输入保留');
  assert.equal(input.question, text);
});

await test('unreadable image state is preserved in chain input', () => {
  const input = chainInput({ question: '请审核这张图片', inbound: {
    text: '',
    images: [{ index: 1, failed: '读取图片失败：资源不可用' }],
  } });
  assert.match(input.text, /图片 1/);
  assert.match(input.text, /没读到/);
  assert.match(input.text, /资源不可用/);
  assert.deepEqual(input.media, []);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2026-10-22：**飞书链接**这条支路 —— 事故是「任何飞书链接都读不了，而原因写成 DNS」。
// 下面四项分别验：① 失败话术**原样透传**（不许在闸门里改成「请提供可公开访问的页面」）；
// ② 附件失败时链、模型侧、落表**全都不许发生**；③ 飞书文档读到了就真的进链输入；
// ④ 反向对照：分形态的话术必须**不同**（揉成一句就等于没说清原因）。
// ─────────────────────────────────────────────────────────────────────────────
await test('★ 飞书链接读不了时，闸门原样发 reader 给的话术（不许改写成「公网页面」）', async () => {
  const { FeishuLinkError, unreadableReply } = await import('./feishu_link.mjs');
  const gate = isSubmission({ text: 'https://momcozy-in.feishu.cn/file/IWbobAGHAoDcycxRFWNcBYd1nY6' });
  assert.equal(gate.kind, 'link');
  const reply = unreadableReply('file', '红人Brief.pptx', '附件按红线不取');
  const prepared = await prepareLinkReview({
    gate, input: { text: gate.links[0] },
    reader: async () => { throw new FeishuLinkError({ kind: 'file', title: '红人Brief.pptx', detail: '附件按红线不取', reply }); },
  });
  assert.equal(prepared.forcedReply, reply, '话术必须原样透传（改一个字都会把原因指偏）');
  assert.match(prepared.forcedReply, /按红线「飞书内容禁止下载」/);
  assert.match(prepared.forcedReply, /未读取到的内容不会判为通过/);
  assert.doesNotMatch(prepared.forcedReply, /可公开访问的页面/, '对一份 pptx 说「请提供可公开访问的页面」等于让人白折腾');
});

await test('★ 附件读不了 ⇒ 链 / 模型侧 / 落表全都不发生（fail-closed 行为级）', async () => {
  const calls = { chain: 0, model: 0, publish: 0 };
  const result = await runSubmissionGate({
    inbound: { text: 'https://momcozy-in.feishu.cn/file/IWbobAGHAoDcycxRFWNcBYd1nY6', images: [], videos: [] },
    question: 'https://momcozy-in.feishu.cn/file/IWbobAGHAoDcycxRFWNcBYd1nY6',
    linkReader: async () => {
      const e = new Error('附件按红线不取');
      e.shouhengReply = '这条链接是飞书云空间附件《x.pptx》，不是文档……未读取到的内容不会判为通过。';
      throw e;
    },
    chainRunner: async () => { calls.chain++; return {}; },
    modelSideRunner: async () => { calls.model++; return { ok: true, findings: [] }; },
    publishRunner: async () => { calls.publish++; return { ok: true }; },
    notify: null,
  });
  assert.match(result.forcedReply, /附件/);
  assert.equal(result.chainRan, false);
  assert.deepEqual(calls, { chain: 0, model: 0, publish: 0 });
});

await test('★ 飞书文档读到了 ⇒ 正文真的进链输入（能读的别读不了）', async () => {
  const gate = isSubmission({ text: 'https://momcozy-in.feishu.cn/docx/Ybg1dZtoaoG5GKxLfREcHAK2nfs' });
  const prepared = await prepareLinkReview({
    gate, input: { text: gate.links[0] },
    reader: async (url) => ({ url, contentType: 'feishu/docx', title: '红人 Brief', text: '飞书文档正文：这段是待审文案。' }),
  });
  assert.equal(prepared.forcedReply, null);
  assert.match(prepared.input.text, /飞书文档正文/);
  assert.equal(prepared.pages.length, 1);
});

await test('★ 反向对照：附件与「权限不足」的话术必须不同（不是一手「读不了」糊过去）', async () => {
  const { unreadableReply } = await import('./feishu_link.mjs');
  const byRedline = unreadableReply('file', 'x.pptx', '附件按红线不取');
  const byPermission = unreadableReply('docx', 'y', 'code=131006 permission denied');
  assert.notEqual(byRedline, byPermission);
  assert.match(byRedline, /红线/);
  assert.doesNotMatch(byRedline, /确认权限|131006/);
  assert.match(byPermission, /code=131006/);
  assert.doesNotMatch(byPermission, /飞书云空间附件/);
  // 两条都必须带 fail-closed 尾巴
  for (const r of [byRedline, byPermission]) assert.match(r, /未读取到的内容不会判为通过/);
});

console.log(`\n工作流契约：通过 ${cases.length} 项 / 失败 0 项`);

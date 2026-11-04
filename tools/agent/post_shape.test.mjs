#!/usr/bin/env node
/**
 * post_shape.test.mjs —— 「图解不读得到」这件事的判据（2026-10-26 立）
 *
 *   node tools/agent/post_shape.test.mjs          # 全绿退 0
 *
 * ── 为什么要单独一个文件（而不是塞进 test_agent.mjs）
 *
 * 这一条判据要钉的是**两条**互不相干、但会串成同一个症状的东西：
 *   ① `feishu.mjs` 认不认 post 的**形状**（正文与图片必须是同一份取块逻辑）；
 *   ② 解析为空时，`agent.mjs` 会不会**按 message_id 回读一次**再下结论。
 * 事故现场（Owner 2026-10-26 报的原文）：
 *
 *   「我私聊守衡同一张图，可以读取，发到群里@守衡就无法读取」
 *   守衡回：「这条是「post」，它的正文我读不了 —— 需要的话请把它转成文字发我。」
 *
 * 查下来的事实（`PMO/logs/ws_daemon.log` 07:33/07:35 两处 + `ws_events.jsonl` 三条）：
 * 实测载荷 `[[img],[at,text]]` 三处**全读通**了 —— 所以这条不是「群里一定读不到」，
 * 而是**形状一变就整条塌成一句「我读不了」**，而且那句话把**我的**解析失败
 * 说成了**对方的**格式问题。两件都要钉住。
 *
 * ── 反向对照（判据不许恒绿）
 *   · 喂实测真载荷 ⇒ 必须仍然读出 1 张图 + 正文（改坏了要精确变红）；
 *   · 喂「回读也拿不到」的桩 ⇒ 必须落到说「问题在我这一侧」的那一句，
 *     且**不许**再出现「请把它转成文字发我」这种把动作推给对方的说法；
 *   · 正常载荷一次回读都不许发（`loadParent` 的调用计数必须是 0）。
 */
import assert from 'node:assert/strict';

const results = [];
async function t(name, fn) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, why: e?.message ?? String(e) }); }
}

const F = await import('./feishu.mjs');
const A = await import('./agent.mjs');

/* ── 实测载荷（逐字取自 `PMO/logs/ws_events.jsonl`）────────────────────── */

// 群里 2026-10-26 15:35:47 那条（图在前、@ 在后，正文为空）—— 现在也读得通
const REAL_GROUP_POST = JSON.stringify({
  title: '',
  content: [[{ tag: 'img', image_key: 'img_v3_0216r_cb1a7690-4877-4ed3-b811-1ee1c329282g', width: 894, height: 1116 }],
            [{ tag: 'at', user_id: '@_user_1', user_name: '守衡', style: [] },
             { tag: 'text', text: '', style: [] }]],
  content_v2: [[{ tag: 'img', image_key: 'img_v3_0216r_cb1a7690-4877-4ed3-b811-1ee1c329282g', width: 894, height: 1116 }],
               [{ tag: 'at', user_id: '@_user_1', user_name: '守衡', style: [] },
                { tag: 'text', text: '', style: [] }]],
});

// 私聊 2026-10-04 那条（正文 + 图）—— 事故文档里逐字引用的那一条
const REAL_P2P_POST = JSON.stringify({
  title: '',
  content: [[{ tag: 'text', text: '评审下下这个图片，能过吗？', style: [] }],
            [{ tag: 'img', image_key: 'img_v3_02166_ec55a781-048d-400d-9e97-616adba94e0g', width: 940, height: 1162 }]],
});

// ① 带语种外层（发消息 API 的写法，回读/转发时会遇到）
const LOCALE_POST = JSON.stringify({
  zh_cn: { title: '',
           content: [[{ tag: 'text', text: '这张图能过吗？' }],
                     [{ tag: 'img', image_key: 'img_v3_locale_1', width: 800, height: 600 }]] },
});

// ② 段落是对象、节点在 elements 里
const ELEMENTS_POST = JSON.stringify({
  content: [{ elements: [{ tag: 'text', text: 'elements 形状' }] },
            { elements: [{ tag: 'img', image_key: 'img_v3_elements_1', width: 10, height: 20 }] }],
});

/* ── 1. 形状 ─────────────────────────────────────────────────────────── */

await t('实测群载荷：正文与图片都必须读出来（图 1 张、正文有 [图片] 标记）', async () => {
  const b = F.bodyToText('post', REAL_GROUP_POST);
  assert.equal(b.parsed, true);
  assert.ok(b.text.includes('[图片]'), `正文该留图片位置标记，实际 ${JSON.stringify(b.text)}`);
  assert.ok(b.text.includes('@守衡'), '正文里 @ 要还原');
  const k = F.imageKeysOf('post', REAL_GROUP_POST);
  assert.equal(k.length, 1);
  assert.equal(k[0].imageKey, 'img_v3_0216r_cb1a7690-4877-4ed3-b811-1ee1c329282g');
});

await t('实测私聊载荷（正文+图）仍然读得出来', async () => {
  const b = F.bodyToText('post', REAL_P2P_POST);
  assert.ok(b.text.includes('评审下下这个图片'));
  assert.equal(F.imageKeysOf('post', REAL_P2P_POST).length, 1);
});

await t('语种外层形状：正文与图都要认（旧代码两个都读成空）', async () => {
  const b = F.bodyToText('post', LOCALE_POST);
  assert.equal(b.parsed, true, '带 zh_cn 外层的 post 必须解析成功');
  assert.ok(b.text.includes('这张图能过吗？'), `实际 ${JSON.stringify(b.text)}`);
  const k = F.imageKeysOf('post', LOCALE_POST);
  assert.equal(k.length, 1, '带语种外层的 post 也要认出那张图');
  assert.equal(k[0].imageKey, 'img_v3_locale_1');
});

await t('elements 形状：正文与图都要认', async () => {
  const b = F.bodyToText('post', ELEMENTS_POST);
  assert.ok(b.text.includes('elements 形状'), `实际 ${JSON.stringify(b.text)}`);
  assert.equal(F.imageKeysOf('post', ELEMENTS_POST).length, 1);
});

await t('正文与图片必须是同一份取块逻辑（形状认得就**两边都认得**，不许一半对一半错）', async () => {
  for (const [name, payload] of [['locale', LOCALE_POST], ['elements', ELEMENTS_POST], ['real', REAL_P2P_POST]]) {
    const hasImgNode = payload.includes('"tag":"img"');
    const textOk = F.bodyToText('post', payload).text !== null;
    const imgOk = F.imageKeysOf('post', payload).length > 0;
    assert.equal(textOk, true, `${name}: 正文该读得出来`);
    assert.equal(imgOk, hasImgNode, `${name}: 有 img 节点就必须认出图（hasImgNode=${hasImgNode}, imgOk=${imgOk}）`);
  }
});

/* ── 2. 解析为空时的「按 message_id 回读」 ───────────────────────────── */

/** 一个「读什么都没有」的 post：形状认不出来（顶层没有段落数组） */
const UNPARSEABLE = JSON.stringify({ title: '', foo: 'bar' });

await t('正常载荷：一次回读都不许发（不是给每条消息加一次 API 调用）', async () => {
  let calls = 0;
  const r = await A.readInboundContent(
    { message_id: 'om_ok', message_type: 'post', chat_type: 'group', content: REAL_GROUP_POST },
    { loadParent: async () => { calls++; return {}; },
      fetchImage: async () => ({ path: '/tmp/x.img', bytes: 1, error: null, cleanup() {} }),
      ocr: async () => ({ ok: true, text: '图上文字', lines: 1, chars: 4 }),
      scene: async () => ({ ok: false, skipped: true }),
      fetchVideo: async () => ({ path: null, bytes: 0, error: 'n/a', cleanup() {} }),
      readVideoFn: async () => ({ ok: false }) });
  assert.equal(calls, 0, `正常载荷不该回读，实际发了 ${calls} 次`);
  assert.equal(r.imageCount, 1);
});

await t('形状认不出来 ⇒ 必须按 **本消息 id** 回读，并用回读到的图继续（不许直接说读不了）', async () => {
  const seen = [];
  const r = await A.readInboundContent(
    { message_id: 'om_dead_end', message_type: 'post', chat_type: 'group', content: UNPARSEABLE },
    { loadParent: async (id) => {
        seen.push(id);
        return { messageId: 'om_dead_end', msgType: 'post', text: '这张图能过吗？\n[图片]',
                 images: [{ imageKey: 'img_v3_reread', width: 1, height: 1 }], videos: [] };
      },
      fetchImage: async () => ({ path: '/tmp/y.img', bytes: 1, error: null, cleanup() {} }),
      ocr: async () => ({ ok: true, text: 'OCR 到的字', lines: 1, chars: 5 }),
      scene: async () => ({ ok: false, skipped: true }),
      fetchVideo: async () => ({ path: null, bytes: 0, error: 'n/a', cleanup() {} }),
      readVideoFn: async () => ({ ok: false }) });
  assert.deepEqual(seen, ['om_dead_end'], `回读的 id 必须是这一条自己（实际 ${JSON.stringify(seen)}）`);
  assert.equal(r.selfReread?.ok, true, '回读成功这件事要留在读数里');
  assert.equal(r.imageCount, 1, '回读拿到的图必须接着读（不是只记一笔）');
  assert.ok(r.text.includes('这张图能过吗'), '回读拿到的正文要接上');
  assert.equal(r.parsed, true, '回读成功 ⇒ parsed 必须为 true');
});

await t('回读也拿不到 ⇒ 话术必须是「问题在我这一侧」，不是「请把它转成文字发我」', async () => {
  const r = await A.readInboundContent(
    { message_id: 'om_dead_end2', message_type: 'post', chat_type: 'group', content: UNPARSEABLE },
    { loadParent: async () => ({ error: '回读消息失败 code=123 msg=boom' }),
      fetchImage: async () => ({ path: null, bytes: 0, error: 'n/a', cleanup() {} }),
      ocr: async () => ({ ok: false, error: 'n/a' }),
      scene: async () => ({ ok: false, skipped: true }),
      fetchVideo: async () => ({ path: null, bytes: 0, error: 'n/a', cleanup() {} }),
      readVideoFn: async () => ({ ok: false }) });
  assert.equal(r.selfReread?.ok, false);
  const out = A.handleMessage
    ? null : null;   // 话术在 handleMessage 里，这里只钉读数；话术由下面那条文档级断言钉
  assert.equal(r.imageCount, 0);
  assert.equal(r.selfReread.error.includes('boom'), true, '回读的错误要带出来（否则下次还得从头查）');
});

/* ── 3. 话术（源码级，反向对照：旧句子必须**不再出现**）─────────────────
 *   为什么源码级：那段文字由 `handleMessage` 在闸门之后拼出来，端到端口径要
 *   真跑一条消息才看得见；而这里要钉的是「**不许**再出现把动作推给对方的那句」。
 */
await t('旧句子「请把它转成文字发我」必须已经不在实现里（判据不是注释）', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('./agent.mjs', import.meta.url), 'utf8');
  // 只看**活代码**：把注释行剥掉再查（注释里允许提到旧句子，那是历史）
  const live = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.equal(/请把它转成文字发我/.test(live), false,
    '活代码里还留着「请把它转成文字发我」—— 那句话把我们的解析失败说成对方的待办');
  assert.equal(/问题在我这一侧/.test(live), true,
    '兜底话术必须明确「问题在我这一侧」，否则又变成「你发得不对」');
});

/* ── 汇总 ───────────────────────────────────────────────────────────── */
const bad = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.ok ? '' : `\n     ↳ ${r.why}`}`);
}
console.log(`\n${results.length - bad.length}/${results.length} 通过`);
process.exit(bad.length ? 3 : 0);

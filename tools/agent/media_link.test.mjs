#!/usr/bin/env node
/**
 * media_link.test.mjs —— **媒材链接**那一层的判据（2026-10-16）
 *
 *   node tools/agent/media_link.test.mjs
 *
 * ⚠️ **一个字节都不上传、一条真表都不碰**：全部走注入的 `exec` 桩。
 *   真上传那一条在真跑时才有（本文件只证**判据**）。
 *
 * ── 这个文件是为哪一次事故写的
 *
 *   Owner 2026-10-16：「送审问题 里面的图片和视频要优化成链接，点击就可以打开的，
 *   只留原文，不要写其他话」，并追问「现在只写 `[图片]` 也不知道是什么图片」。
 *   查真表（200 行）发现**比那句话更坏**：**54 行**的格子里躺着我们自己的内部指令
 *   （`【★ 这是送审素材…】`、`【对方这条消息里附了图…】` + OCR 全文）。
 *
 * ── 判据分五类（每条都写了「拆掉它会怎样」）
 *
 *   M1 收回原文：探针/读数块/占位符**一律不许进格子**；但**对方自己写的 `【` 不许被误删**
 *   M2 组装：有链接写链接；**没有链接绝不写死链接**（fail-closed）
 *   M3 上传三步：上传 → 设可见范围 → **回读确认**；任何一步没成 ⇒ `url` 为空
 *   M4 月文件夹：缓存命中不再建；重名复用（不许攒一堆同名夹子）
 *   M5 时区：跨月那一刻按**北京时间**算（用 UTC 会写错一个月）
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  stripInternal, questionForRow, mediaLabel, monthFolderName,
  ensureMonthFolder, uploadForLink, MEDIA_LINK, PROBE_MARKERS, collectMediaLinks, awaitLinks, preflight,
  magicExt, withMagicExt,
} from './media_link.mjs';

const results = [];
const check = (id, fn) => {
  try { fn(); results.push({ id, ok: true }); }
  catch (e) { results.push({ id, ok: false, detail: e.message }); }
};
const checkAsync = async (id, fn) => {
  try { await fn(); results.push({ id, ok: true }); }
  catch (e) { results.push({ id, ok: false, detail: e.message }); }
};

/* ── 真实样本（逐字取自结论表那 54 行里的两条）────────────────────────── */
const ROW_PROBE = '[图片]\n审核下这张图片\n\n'
  + '【对方这条消息里附了图，共 1 张。下面每一格是**本机 OCR 读出的图内文字**（逐字，'
  + '可能有识别错误；也可能读不全）。你就此能判断的只有「图上写了什么字」—— 画面本身'
  + '（构图、场景、人物、婴幼儿、产品怎么用、有没有换脸/合成痕迹）**不在这些字里，你看不到**。'
  + '所以：可以按图内文字做文案与宣称层面的判定，但凡涉及画面本身的结论，必须写明'
  + '「画面我看不到」这一条边界，并说明要看画面得由人来看。】\n'
  + '【图 1 内文字｜32 行】\nROO\nMOMCOZY\nBreastfeeding\n';
const ROW_PURE_PROBE = '【★ 这是送审素材：不管对方写没写「审一下」，都要走 kb_review_chain，'
  + '把上面这段读数当输入交进去 —— 只回一段「我读到了什么」不算回答。'
  + '连「这里没有可判内容」这种结论也必须由链给出，不由你替它下。】';

/* ── M1 收回原文 ─────────────────────────────────────────────────────── */
check('M1a ★ 真样本：探针 + OCR 全文 + [图片] 占位 ⇒ 只剩对方那句原话', () => {
  assert.strictEqual(stripInternal(ROW_PROBE), '审核下这张图片');
});
check('M1b 整格就是纯探针 ⇒ 空串（不是「（对方只发了素材…）」那种我们拟的话）', () => {
  assert.strictEqual(stripInternal(ROW_PURE_PROBE), '');
});
check('M1c [媒体]/[视频] 占位也去掉（不只 [图片]）', () => {
  assert.strictEqual(stripInternal('这个视频能过吗\n[视频]'), '这个视频能过吗');
  assert.strictEqual(stripInternal('看下\n[媒体]'), '看下');
});
check('M1d 我们拟的尾巴说明去掉', () => {
  assert.strictEqual(stripInternal('（对方只发了素材，没有写问题）'), '');
});
check('M1e ★ 反向对照：**对方自己写的 `【` 不许被误删**（宁可长，不可错删）', () => {
  const own = '【紧急】这条 listing 能不能发？';
  assert.strictEqual(stripInternal(own), own,
    '把「见到【就切」写进去就会删掉对方自己的话 —— 这条就是钉它的');
});
check('M1f 反向对照：枚举之外的头注也不许切', () => {
  const own = '【提醒】M6 吸奶器文案';
  assert.strictEqual(stripInternal(own), own);
});
check('M1g 探针块前面的空行不会留下空行堆', () => {
  assert.strictEqual(stripInternal('审一下\n\n\n' + ROW_PURE_PROBE), '审一下');
});

/* ── M2 组装 ─────────────────────────────────────────────────────────── */
check('M1h ★★ 真事故：`[图片](url)` 是**链接**，标签不许被吃掉（拆掉 `(?!\\()` ⇒ 变红）', () => {
  const src = '图注：Momcozy Detergent Tablets\n来源页（美国站）：https://momcozy.com/x\n'
    + '[图片](https://momcozy-in.feishu.cn/file/B8HnblYmUoG3FnxKmqGcoHNvnQh)';
  const out = stripInternal(src);
  assert.ok(out.includes('[图片](https://momcozy-in.feishu.cn/file/B8HnblYmUoG3FnxKmqGcoHNvnQh)'),
    `链接被吃成裸 URL 了（2026-10-16 真表上吃掉过 3 行）：${JSON.stringify(out)}`);
  assert.ok(!/^\(https?:/m.test(out), '不许留下「(url)」这种半截形状');
});
check('M1i ★ 真事故二：提交人自己写的「【视频封面图 …】」不许被当成我们的探针', () => {
  const src = '【视频封面图 —— 本次只审封面图与标题；视频本体（口播 / 字幕 / 画面）未审】\n'
    + 'Pumping on the Go? A Wearable Breast Pump Can Make It Easier\nhttps://www.youtube.com/watch?v=x\n'
    + '【视频 1：读到的字｜8 帧】\nPumping on the Go';
  const out = stripInternal(src);
  assert.ok(out.includes('【视频封面图'), `把提交人的头注当成探针切掉了：${JSON.stringify(out)}`);
  assert.ok(!out.includes('【视频 1：读到的字'), '我们的读数块仍要被切掉');
});
check('M1j 反向对照：孤立的 [图片] 占位**照旧要去掉**（不许因为 M1h 就整个不敢动）', () => {
  assert.strictEqual(stripInternal('[图片]审核下这张图'), '审核下这张图');
  assert.strictEqual(stripInternal('[图片]\n审核下这张图片\n\n' + ROW_PURE_PROBE), '审核下这张图片');
});
check('M2a 有链接 ⇒ 原话 + markdown 链接（这就是「点击就能打开」那一行）', () => {
  const q = questionForRow({
    userText: ROW_PROBE,
    media: [{ kind: 'image', ok: true, url: 'https://momcozy-in.feishu.cn/file/AAA' }],
  });
  assert.strictEqual(q, '审核下这张图片\n[图片](https://momcozy-in.feishu.cn/file/AAA)');
});
check('M2b ★ fail-closed：**没拿到 url 就不写链接**（也不编「图片」两个字占位）', () => {
  const q = questionForRow({
    userText: '审核下这张图片',
    media: [{ kind: 'image', ok: false, url: null, detail: '设可见范围失败' }],
  });
  assert.strictEqual(q, '审核下这张图片');
  assert.ok(!q.includes('http'), '点不开的链接比空格更坏');
});
check('M2c 对方一个字没写、只发了图 ⇒ 这一格就只有链接（「只留原文」的字面意思）', () => {
  const q = questionForRow({
    userText: ROW_PURE_PROBE,
    media: [{ kind: 'image', ok: true, url: 'https://x/file/B' }],
  });
  assert.strictEqual(q, '[图片](https://x/file/B)');
});
check('M2d 多张图 ⇒ 编号（不然「图片」两字分不出是哪张）', () => {
  const q = questionForRow({
    userText: '', media: [
      { kind: 'image', ok: true, url: 'https://x/file/1' },
      { kind: 'image', ok: true, url: 'https://x/file/2' },
    ],
  });
  assert.strictEqual(q, '[图片 1](https://x/file/1)\n[图片 2](https://x/file/2)');
});
check('M2e 视频有真文件名 ⇒ 用文件名当链接文字（直接回答「是什么视频」）', () => {
  const q = questionForRow({
    userText: '这个视频审核一下',
    media: [{ kind: 'video', ok: true, url: 'https://x/file/V', fileName: '知识库视频-WhatsApp-2026-10-06.mp4' }],
  });
  assert.strictEqual(q, '这个视频审核一下\n[知识库视频-WhatsApp-2026-10-06.mp4](https://x/file/V)');
});
check('M2f 没给 userText / media ⇒ 空串，不抛', () => {
  assert.strictEqual(questionForRow({}), '');
  assert.strictEqual(questionForRow(), '');
});
check('M2g mediaLabel：单张就叫「图片」，多张才编号', () => {
  assert.strictEqual(mediaLabel({ kind: 'image', index: 1, count: 1 }), '图片');
  assert.strictEqual(mediaLabel({ kind: 'image', index: 2, count: 3 }), '图片 2');
  assert.strictEqual(mediaLabel({ kind: 'video', index: 1, count: 1, fileName: 'a.mp4' }), 'a.mp4');
});

/* ── 桩：一条 lark-cli 命令路由器 ────────────────────────────────────── */
function makeStub({ patchThrows = false, readback = MEDIA_LINK.shareEntity, uploadUrl = 'https://momcozy-in.feishu.cn/file/T1', uploadToken = 'T1', listFiles = [] } = {}) {
  const calls = [];
  const exec = async (args) => {
    calls.push(args.join(' '));
    const has = (s) => args.includes(s);
    if (has('files') && has('list')) return { stdout: JSON.stringify({ ok: true, data: { files: listFiles } }) };
    if (has('+create-folder')) return { stdout: JSON.stringify({ ok: true, data: { folder_token: 'MF1', created: true } }) };
    if (has('+upload')) {
      if (!uploadUrl) return { stdout: JSON.stringify({ ok: true, data: { file_token: uploadToken } }) };
      return { stdout: JSON.stringify({ ok: true, data: { file_token: uploadToken, url: uploadUrl } }) };
    }
    if (has('patch')) {
      if (patchThrows) { const e = new Error('cli failed'); e.stderr = 'permission denied (99991672)'; throw e; }
      return { stdout: JSON.stringify({ ok: true, data: { permission_public: { link_share_entity: MEDIA_LINK.shareEntity } } }) };
    }
    if (has('+permission-get-setting')) {
      return { stdout: JSON.stringify({ ok: true, data: { permission_public: { link_share_entity: readback } } }) };
    }
    throw new Error(`桩没覆盖这条命令：${args.join(' ')}`);
  };
  return { exec, calls };
}

const tmpCache = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ml-')), 'cache.json');
const tmpFile = () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mlf-')), 'a.jpg');
  fs.writeFileSync(p, 'x');
  return p;
};

await checkAsync('M3a 三步全成 ⇒ ok + 可点 url', async () => {
  const { exec, calls } = makeStub();
  const r = await uploadForLink(tmpFile(), { name: 'a.jpg', ym: '2026-10', deps: { exec, cacheFile: tmpCache() } });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.url, 'https://momcozy-in.feishu.cn/file/T1');
  assert.ok(calls.some((c) => c.includes('permission.public patch')), '必须真去设可见范围');
  assert.ok(calls.some((c) => c.includes('+permission-get-setting')), '必须回读确认');
});
await checkAsync('M3b ★ 反向对照：**设可见范围失败 ⇒ 不返回 url**（拆掉这步就会发出点不开的链接）', async () => {
  const { exec } = makeStub({ patchThrows: true });
  const r = await uploadForLink(tmpFile(), { ym: '2026-10', deps: { exec, cacheFile: tmpCache() } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.url, null, '接口没成还把 url 交出去 = 往表里写死链');
  assert.match(r.detail, /设可见范围失败/);
});
await checkAsync('M3c ★★ 回读不是 tenant_readable ⇒ 一样算没成（「接口成功 ≠ 数据落下来」）', async () => {
  const { exec } = makeStub({ readback: 'closed' });
  const r = await uploadForLink(tmpFile(), { ym: '2026-10', deps: { exec, cacheFile: tmpCache() } });
  assert.strictEqual(r.ok, false, '回读是 closed 却当成功 = 这一格又变成点不开的链接');
  assert.strictEqual(r.url, null);
  assert.match(r.detail, /回读不是/);
});
await checkAsync('M3d 上传成功但没回 url ⇒ 也算没成', async () => {
  const { exec } = makeStub({ uploadUrl: '' });
  const r = await uploadForLink(tmpFile(), { ym: '2026-10', deps: { exec, cacheFile: tmpCache() } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.url, null);
});
await checkAsync('M3e 本地文件不存在 ⇒ 不抛、不传', async () => {
  const { exec } = makeStub();
  const r = await uploadForLink('/tmp/绝对不存在的文件-xyz', { deps: { exec, cacheFile: tmpCache() } });
  assert.strictEqual(r.ok, false);
  assert.match(r.detail, /本地文件不存在/);
});

/* ── M4 月文件夹 ─────────────────────────────────────────────────────── */
await checkAsync('M4a 首次 ⇒ 建一个月夹子，token 进缓存', async () => {
  const cacheFile = tmpCache();
  const { exec } = makeStub();
  const r = await ensureMonthFolder('2026-10', { deps: { exec, cacheFile } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.token, 'MF1');
  assert.strictEqual(JSON.parse(fs.readFileSync(cacheFile, 'utf8'))['2026-10'].token, 'MF1');
});
await checkAsync('M4b 缓存命中 ⇒ 一条命令都不发', async () => {
  const cacheFile = tmpCache();
  fs.writeFileSync(cacheFile, JSON.stringify({ '2026-10': { token: 'CACHED' } }));
  const { exec, calls } = makeStub();
  const r = await ensureMonthFolder('2026-10', { deps: { exec, cacheFile } });
  assert.strictEqual(r.token, 'CACHED');
  assert.strictEqual(calls.length, 0, '每次都建 = 攒一堆同名夹子');
});
await checkAsync('M4c 云盘里已经有同名夹子 ⇒ 复用，不再建', async () => {
  const { exec, calls } = makeStub({ listFiles: [{ name: '2026-10', type: 'folder', token: 'EXIST' }] });
  const r = await ensureMonthFolder('2026-10', { deps: { exec, cacheFile: tmpCache() } });
  assert.strictEqual(r.token, 'EXIST');
  assert.ok(!calls.some((c) => c.includes('+create-folder')), '同名夹子不该再建一个');
});

/* ── M5 时区 ─────────────────────────────────────────────────────────── */
check('M5a ★ 跨月那一刻按北京时间算（UTC 会写成上一个月）', () => {
  // 2026-10-31T17:00:00Z = 北京时间 2026-11-01 01:00
  assert.strictEqual(monthFolderName(Date.UTC(2026, 9, 31, 17, 0, 0)), '2026-11');
  assert.strictEqual(monthFolderName(Date.UTC(2026, 9, 31, 15, 59, 0)), '2026-10');
});

/* ── M6 收集（重新取字节 → 上传 → 删临时文件）──────────────────────────── */
await checkAsync('M6a 图片/视频各一件 ⇒ 两条链接；每条都带 kind', async () => {
  const cleaned = [];
  const deps = {
    fetchImage: async () => ({ path: tmpFile(), bytes: 3, cleanup: () => cleaned.push('img') }),
    fetchVideo: async () => ({ path: tmpFile(), bytes: 3, cleanup: () => cleaned.push('vid') }),
    upload: async () => ({ ok: true, url: 'https://x/file/Z' }),
  };
  const r = await collectMediaLinks({
    inbound: { images: [{ index: 1, msgId: 'om_1', imageKey: 'img_k' }],
               videos: [{ index: 1, msgId: 'om_1', fileKey: 'fil_k', fileName: 'a.mp4' }] },
    ...deps,
  });
  assert.strictEqual(r.length, 2, JSON.stringify(r));
  assert.deepStrictEqual(r.map((x) => x.kind), ['image', 'video']);
  assert.deepStrictEqual(cleaned.sort(), ['img', 'vid'], '字节用完必须删（红线）');
});
await checkAsync('M6b ★ 三种结局都要删临时文件（上传抛异常那条尤其容易漏）', async () => {
  const cleaned = [];
  const r = await collectMediaLinks({
    inbound: { images: [{ index: 1, msgId: 'om_1', imageKey: 'k' }] },
    fetchImage: async () => ({ path: tmpFile(), cleanup: () => cleaned.push('ok') }),
    upload: async () => { throw new Error('上传炸了'); },
  });
  assert.strictEqual(r[0].ok, false);
  assert.match(r[0].detail, /抛异常/);
  assert.deepStrictEqual(cleaned, ['ok'], '抛异常时没删 = 临时素材留在盘上');
});
await checkAsync('M6c 取字节失败 ⇒ 那一件没有链接，但**不抛**（其余照走）', async () => {
  const r = await collectMediaLinks({
    inbound: { images: [{ index: 1, msgId: 'om_1', imageKey: 'k' }, { index: 2, msgId: 'om_1', imageKey: 'k2' }] },
    fetchImage: async (_m, k) => (k === 'k' ? { error: 'message resource not found' } : { path: tmpFile(), cleanup: () => {} }),
    upload: async () => ({ ok: true, url: 'https://x/file/OK' }),
  });
  assert.strictEqual(r[0].ok, false);
  assert.match(r[0].detail, /取字节没成/);
  assert.strictEqual(r[1].ok, true, '一件坏了不该拖累另一件');
});
await checkAsync('M6d 读入阶段就失败的那件（failed）不许再去取一次', async () => {
  let called = 0;
  const r = await collectMediaLinks({
    inbound: { images: [{ index: 1, msgId: 'om_1', imageKey: 'k', failed: 'OCR 失败' }] },
    fetchImage: async () => { called++; return { path: tmpFile(), cleanup: () => {} }; },
    upload: async () => ({ ok: true, url: 'https://x/f' }),
  });
  assert.strictEqual(called, 0);
  assert.deepStrictEqual(r, []);
});
await checkAsync('M6e 没有媒材 ⇒ 空数组（不是 null，调用方不必再判一次）', async () => {
  assert.deepStrictEqual(await collectMediaLinks({ inbound: { images: [], videos: [] } }), []);
  assert.deepStrictEqual(await collectMediaLinks({}), []);
});

/* ── M7 有界等待 ─────────────────────────────────────────────────────── */
await checkAsync('M6f ★ 落表拉下（自证/干跑）⇒ 不上传，连字节都不去取', async () => {
  const prev = process.env.SHOUHENG_REVIEW_TABLE;
  process.env.SHOUHENG_REVIEW_TABLE = 'off';
  let fetched = 0; const lines = [];
  try {
    const r = await collectMediaLinks({
      inbound: { images: [{ index: 1, msgId: 'om_1', imageKey: 'k' }] },
      fetchImage: async () => { fetched++; return { path: tmpFile(), cleanup: () => {} }; },
      upload: async () => ({ ok: true, url: 'https://x/f' }),
      log: (s) => lines.push(s),
    });
    assert.deepStrictEqual(r, []);
    assert.strictEqual(fetched, 0, '表都没落，连字节都不该去取');
    assert.match(lines.join(''), /不上传/, '必须有读数，别让「没上传」看起来像「没有媒材」');
  } finally {
    if (prev === undefined) delete process.env.SHOUHENG_REVIEW_TABLE;
    else process.env.SHOUHENG_REVIEW_TABLE = prev;
  }
});
await checkAsync('M7a 正常快 ⇒ 拿到结果，不算超时', async () => {
  const r = await awaitLinks(Promise.resolve([{ ok: true, url: 'u' }]), { ms: 1000 });
  assert.strictEqual(r.timedOut, false);
  assert.strictEqual(r.media.length, 1);
});
await checkAsync('M7b ★ 上传卡住 ⇒ 到点就放行，按「没链接」落表并说清是未测', async () => {
  const lines = [];
  const r = await awaitLinks(new Promise(() => {}), { ms: 50, log: (s) => lines.push(s) });
  assert.strictEqual(r.timedOut, true);
  assert.deepStrictEqual(r.media, []);
  assert.match(lines.join(''), /未测/, '不许把「没等到」说成「没有媒材」');
});
await checkAsync('M7c 上传那一步抛了 ⇒ 一样放行、一样只留原文', async () => {
  const r = await awaitLinks(Promise.reject(new Error('boom')), { ms: 1000, log: () => {} });
  assert.deepStrictEqual(r.media, []);
  assert.match(r.error, /boom/);
});
await checkAsync('M7d 没起上传（无媒材）⇒ 立刻返回空，不空等', async () => {
  const t0 = Date.now();
  const r = await awaitLinks(null, { ms: 5000 });
  assert.strictEqual(r.timedOut, false);
  assert.ok(Date.now() - t0 < 200, '没起上传却等满超时 = 白等');
});

/* ── M8 启动自检（第一屏那条读数）────────────────────────────────────── */
await checkAsync('M8a 拉闸 ⇒ 报「未开」而不是「不可用」（两件事不许混）', async () => {
  const prev = process.env.SHOUHENG_MEDIA_LINK;
  process.env.SHOUHENG_MEDIA_LINK = 'off';
  try {
    const r = await preflight({ deps: { exec: async () => { throw new Error('不该发命令'); } } });
    assert.strictEqual(r.skipped, true);
    assert.match(r.detail, /拉闸/);
  } finally {
    if (prev === undefined) delete process.env.SHOUHENG_MEDIA_LINK;
    else process.env.SHOUHENG_MEDIA_LINK = prev;
  }
});
await checkAsync('M8b 真跑一次取月夹子 ⇒ ok（这才叫「能用」）', async () => {
  const { exec } = makeStub();
  const r = await preflight({ deps: { exec, cacheFile: tmpCache() } });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.match(r.detail, /云空间可达/);
});
await checkAsync('M8c 云空间取不到 ⇒ 报「不可用」并带原话（不静默）', async () => {
  const exec = async () => { const e = new Error('cli failed'); e.stderr = 'permission denied (99991672)'; throw e; };
  const r = await preflight({ deps: { exec, cacheFile: tmpCache() } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.skipped, false);
  assert.match(r.detail, /99991672/);
});

/* ── M6 扩展名：飞书靠**名字**决定能不能预览（2026-10-17 真事故）─────────
 *
 * Owner 原话：「图片 1：点开查看 —— **点击后无法查看**，修复下」。
 * 实测那条文件：`drive +download` 下回来是完好的 JPEG（魔数 ffd8ffe0 …JFIF，83 KB），
 * 但它在云空间里叫 `守衡送审素材-image-1`（**没有扩展名**）⇒ `drive +preview` 回
 * `1060006 file type does not support preview`；**只改名加 .jpg（token 不变）就通了**。
 * ⇒ 字节一直是好的，坏的是名字。
 */
const tmpMagic = (bytes) => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mlx-')), 'f.img');
  fs.writeFileSync(p, Buffer.from(bytes));
  return p;
};
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d];
const MP4 = [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32];

check('M6a 魔数认得出 jpg / png / mp4', () => {
  assert.strictEqual(magicExt(tmpMagic(JPEG)), '.jpg');
  assert.strictEqual(magicExt(tmpMagic(PNG)), '.png');
  assert.strictEqual(magicExt(tmpMagic(MP4)), '.mp4');
});
check('M6b ★ 认不出就**不加**（不编一个假扩展名）', () => {
  assert.strictEqual(magicExt(tmpMagic([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])), '');
  assert.strictEqual(withMagicExt('守衡送审素材-图片-1', tmpMagic([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])),
    '守衡送审素材-图片-1');
});
check('M6c 没扩展名 ⇒ 按魔数补；已有扩展名一字不动（反向对照）', () => {
  assert.strictEqual(withMagicExt('守衡送审素材-图片-1', tmpMagic(JPEG)), '守衡送审素材-图片-1.jpg');
  assert.strictEqual(withMagicExt('a.png', tmpMagic(JPEG)), 'a.png', '已有扩展名被改动了');
});

await checkAsync('M6d ★★ 真传到 CLI 的名字必须带扩展名（拆掉修法 = 又给一个点不开的链接）', async () => {
  const { exec, calls } = makeStub();
  const r = await uploadForLink(tmpMagic(JPEG), { name: '守衡送审素材-图片-1', ym: '2026-10',
    deps: { exec, cacheFile: tmpCache() } });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  const up = calls.find((c) => c.includes('+upload')) ?? '';
  assert.match(up, /--name 守衡送审素材-图片-1\.jpg/, `上传名没带扩展名（飞书画不出来）：${up}`);
});

/* ── 收口 ───────────────────────────────────────────────────────────── */
const bad = results.filter((r) => !r.ok);
for (const b of bad) console.log(`✗ ${b.id}：${b.detail}`);
console.log(`\nmedia_link：${results.length - bad.length}/${results.length} 通过`);
if (bad.length) process.exit(1);

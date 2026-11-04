import assert from 'node:assert/strict';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { MAX_BYTES, decodePageBody, extractReadableText, looksBinary, normalizePublicUrl, overCap, readPublicPage } from './link_reader.mjs';

assert.equal(normalizePublicUrl('https://example.com/path#section'), 'https://example.com/path');
for (const value of ['file:///etc/passwd', 'http://localhost/a', 'http://127.0.0.1/', 'http://[::1]/', 'https://user:user@example.com/']) {
  assert.throws(() => normalizePublicUrl(value));
}
assert.equal(extractReadableText('<title>Offer</title><script>secret()</script><p>Hello&nbsp;world</p>'), 'Offer Hello world');

let requested;
const page = await readPublicPage('https://example.com/product', {
  requestPage: async (url) => {
    requested = url;
    return { status: 200, contentType: 'text/html; charset=utf-8', body: '<title>Product</title><main><p>Public claim</p></main>' };
  },
  resolvePublic: async () => ['93.184.216.34'],
});
assert.match(page.text, /Public claim/);
assert.equal(requested, 'https://example.com/product');

await assert.rejects(() => readPublicPage('https://example.com/', {
  requestPage: async () => ({ status: 403, contentType: 'text/html', body: 'denied' }),
  resolvePublic: async () => ['93.184.216.34'],
}), /HTTP 403/);
await assert.rejects(() => readPublicPage('https://example.com/', {
  requestPage: async () => ({ status: 200, contentType: 'application/pdf', body: 'x' }),
  resolvePublic: async () => ['93.184.216.34'],
}), /不支持的内容类型/);
await assert.rejects(() => readPublicPage('https://example.com/', {
  requestPage: async () => ({ status: 302, location: 'http://127.0.0.1/', contentType: 'text/html', body: '' }),
  resolvePublic: async () => ['93.184.216.34'],
}), /公网地址/);
await assert.rejects(() => readPublicPage('https://example.com/', {
  requestPage: async () => { throw new Error('must not request'); },
  resolvePublic: async () => ['93.184.216.34', '10.0.0.7'],
}), /非公网/);
// ── 读取上限（2026-10-23：1 MB → 4 MB，Owner 裁定）────────────────────────────
// 用**实测的那个页大小**当样本：守衡测试表第 95 行的 YouTube 观看页 1 290 730 字节。
// 三条正例 + 一条**反向对照** —— 反向对照是这组断言的全部意义：
// 同一个字节数喂旧上限必须**被拦**，否则「上限改过了」这件事就没有失败信号。
assert.equal(MAX_BYTES, 4_000_000, '读取上限应当是 4 MB（1 MB → 4 MB 是 2026-10-23 的裁定）');
assert.equal(overCap(1_290_730), false, 'YouTube 观看页（1.29 MB）在新上限下必须放行');
assert.equal(overCap(1_290_730, 1_000_000), true, '反向对照：同一个页面在旧上限下必须被拦 —— 拦它的就是那个数字');
assert.equal(overCap(4_000_001), true, '超过新上限照样硬拒（fail-closed 一个字没松）');

// ── 压缩正文解压（2026-10-23 第 55 行的真故障）────────────────────────────────
// 病灶复现：Amazon 对匿名 UA 回 gzip，而旧代码把字节 `toString('utf8')` 当正文
// ⇒ 30 000 字噪声 + 136 个 `\u0000` ⇒ 下游 `execFile` 报「args[3] 有零字节」，
// 读起来像「库忙/闸门红」。下面第 1 条钉「解压真的做了」，第 2 条是**反向对照**：
// 同一个 gzip 字节、故意不告诉它编码 ⇒ 必须被判成二进制 —— 证明挡住噪声的是**解压**，不是别的。
const HTML = '<title>Offer</title><p>6% more milk output</p>';
assert.equal(decodePageBody(gzipSync(Buffer.from(HTML)), 'gzip').text, HTML, 'gzip 正文必须被解压回原文');
assert.equal(decodePageBody(brotliCompressSync(Buffer.from(HTML)), 'br').text, HTML, 'br 正文必须被解压回原文');
assert.equal(decodePageBody(Buffer.from(HTML), 'identity').text, HTML, 'identity/未压缩照旧直读');
assert.equal(decodePageBody(Buffer.from(HTML), '').text, HTML, '没有 content-encoding 头时照旧直读');
assert.equal(decodePageBody(Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00]), 'gzip').ok, false, '坏 gzip 不许抛异常，只许 ok:false');
assert.equal(decodePageBody(Buffer.from('x'), 'zstd').ok, false, '不认识的压缩方式必须拒读（不当正文用）');
assert.equal(looksBinary(gzipSync(Buffer.from(HTML)).toString('utf8')), true,
  '反向对照：不解压时同一份字节日志必须被判成二进制（136 个零字节那条的样本形状）');
assert.equal(looksBinary(HTML), false, '正常 HTML 不许被判成二进制（否则闸门会误伤）');
assert.equal(looksBinary('婴幼儿睡眠安全，美国市场文案'), false, '正常中文不许被判成二进制');

// 端到端：服务器不理会 identity、硬回 gzip ⇒ 读取器仍要给出干净正文（这条就是当天那一单）
const gz = await readPublicPage('https://example.com/dp/B0FHQJWPTN', {
  requestPage: async () => ({
    status: 200, contentType: 'text/html; charset=utf-8', contentEncoding: 'gzip',
    raw: gzipSync(Buffer.from(HTML)), body: gzipSync(Buffer.from(HTML)).toString('utf8'),
  }),
  resolvePublic: async () => ['93.184.216.34'],
});
assert.match(gz.text, /6% more milk output/, '服务器无视 identity 硬回 gzip 时，正文必须是解压后的真文本');
assert.equal(looksBinary(gz.text), false, '端到端读出来的正文不许含零字节');

// 端到端反向对照：说 identity、其实给的是 gzip 字节（编码头撒谎）⇒ 必须**拒读**而不是把噪声喂下去
await assert.rejects(() => readPublicPage('https://example.com/', {
  requestPage: async () => ({
    status: 200, contentType: 'text/html', contentEncoding: 'identity',
    raw: gzipSync(Buffer.from(HTML)), body: gzipSync(Buffer.from(HTML)).toString('utf8'),
  }),
  resolvePublic: async () => ['93.184.216.34'],
}), /不是可读文本/, '编码头撒谎时必须拒读（宁可这一单没有正文，也不许喂噪声）');

console.log('link_reader：通过 24 项 / 失败 0 项');

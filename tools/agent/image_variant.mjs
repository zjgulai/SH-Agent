/**
 * 素材图：**取最大可用变体**再送去读（Owner 2026-10-16：「按照你的推荐先做 a」）。
 *
 * ── 为什么要它（一手实测，2026-10-16）──────────────────────────────────────────
 *   第 33 行（`MC-US-YT-iV9POYKPrxs`）的素材格子里存的是 YouTube 的
 *   **`hqdefault.jpg`（480×360）**，本机 OCR 对它的读数是**乱码**：
 *
 *     csoarch Actons utaMot / lie ceardi / uE：&awormof.2      ← 46 字，每行置信度 0.3（引擎下限）
 *
 *   而同一支视频换 `maxresdefault.jpg`（1280×720），同一支 OCR：
 *
 *     Kellie Cerardi / Research Astronaut & Mom of 2 / Kellie Gerardi   ← 75 字，可读
 *
 *   后果不是"少读了几个字"：模型侧只看**文字层**，文字层是乱码 ⇒ 它回 `[]` ⇒
 *   那一行从 REVIEW 变成 PASS（2026-10-16 重跑就是这么翻的）。
 *   ⚠️ 而**同一批 20 行里，另外 10 行存的就是 `maxresdefault`** —— 同一个采集口径下
 *   两种写法并存，读出来的东西当然不一样（这是"同一个东西两个产者"的老毛病）。
 *
 *   十条低清行逐一实测（`hq` → `maxres`）：
 *     · iV9POYKPrxs ：乱码 →「Kellie Gerardi / Research Astronaut & Mom of 2」
 *     · WtaXoG864X0 ：`hngarotnnraonbin`（16 字）→「has a rechargeable battery so I can …」（59 字）
 *     · BztEL4E411I ：57 字 → **221 字**（多出手机界面读数 `9:41 / Baby's Health / Heart Dynamics 42`）
 *     · 9-vZmvgIrRA ：「Baoy Bottle Washer」→「Baby Bottle Washer」，`max_c` 0.5→1
 *     · 其余 6 条：字数或最高置信度至少一项变好；`iAVRpPXgAeU` 一条无变化
 *
 * ── 三条纪律（少一条都会把事办坏）────────────────────────────────────────────
 *   ① **fail-open 到原图**：探测超时 / 404 / DNS 失败 ⇒ **一律用原 URL**。
 *      取图失败等于整条图审掉（比看一张糊图坏得多）—— 这里宁可退回旧行为。
 *   ② **不改素材记录**：`采集数据` / 素材表**一个字都不动**（源只读）；升级只发生在
 *      **读的时候**，并把"用了哪个变体"如实返回、由调用方打进日志。
 *   ③ **不多探**：不是 YouTube 缩略图、或本来就是高清变体 ⇒ **一个请求都不发**。
 *
 * 用法：
 *   node tools/agent/image_variant.mjs --selftest     # 反向对照（注入 fetch，不碰网络）
 */
import { setTimeout as sleep } from 'node:timers/promises';

/** 由差到好 —— 按**从好到差**试。源 URL 永远排最后（它就是兜底）。 */
export const YT_VARIANTS = Object.freeze(['maxresdefault', 'sddefault', 'hqdefault', 'mqdefault']);
/** 已经够清楚的变体：命中就**不探**（少一次网络往返）。 */
export const YT_GOOD_ENOUGH = Object.freeze(['maxresdefault', 'sddefault']);

/**
 * 认 YouTube 缩略图 URL ⇒ `{id, variant, host}`；不是就 `null`。
 * 只认这两种域名与 `/vi/<id>/<variant>.jpg` 这个路径形状 —— 别的站点一律不碰
 * （"顺手把别人的图也改一改"正是本库栽过的那类越界）。
 */
export function ytThumbOf(url) {
  const s = String(url ?? '').trim();
  const m = /^https?:\/\/(i\.ytimg\.com|img\.youtube\.com)\/vi\/([\w-]{6,})\/(\w+)\.(jpe?g|webp)(\?.*)?$/i.exec(s);
  if (!m) return null;
  return { host: m[1].toLowerCase(), id: m[2], variant: m[3].toLowerCase() };
}

/** 按"从好到差"给出候选取值（**含原 URL 兜底**，顺序即优先级）。 */
export function candidatesFor(url) {
  const t = ytThumbOf(url);
  if (!t) return [url];
  const out = [];
  for (const v of YT_VARIANTS) {
    if (v === t.variant) continue;
    out.push(`https://${t.host}/vi/${t.id}/${v}.jpg`);
  }
  out.push(url);
  return out;
}

/** 探一次：200 且 Content-Length 不为 0（拿不到长度就不据此否掉，只看状态码）。 */
async function probe(u, { fetchImpl, timeoutMs }) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetchImpl(u, { method: 'HEAD', signal: ac.signal,
                                   headers: { 'user-agent': 'Mozilla/5.0' } });
    const len = Number(r.headers?.get?.('content-length') ?? NaN);
    const ok = r.ok && !(Number.isFinite(len) && len === 0);
    return { url: u, ok, status: r.status, bytes: Number.isFinite(len) ? len : null };
  } catch (e) {
    return { url: u, ok: false, status: null, error: String(e?.name === 'AbortError' ? '超时' : (e?.message ?? e)).slice(0, 80) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 取最大可用变体。
 * @returns {{url:string, upgraded:boolean, from:string, to:string, tried:Array, note:string}}
 */
export async function bestImageVariant(url, { fetchImpl = fetch, timeoutMs = 4000, log = null } = {}) {
  const orig = String(url ?? '').trim();
  const t = ytThumbOf(orig);
  if (!t) {
    return { url: orig, upgraded: false, from: null, to: null, tried: [],
             note: '不是 YouTube 缩略图 ⇒ 原样使用（不探）' };
  }
  if (YT_GOOD_ENOUGH.includes(t.variant)) {
    return { url: orig, upgraded: false, from: t.variant, to: t.variant, tried: [],
             note: `本来就是高清变体（${t.variant}）⇒ 不探` };
  }
  const tried = [];
  for (const c of candidatesFor(orig)) {
    if (c === orig) break;                      // 原 URL 是兜底，不做成败判定
    const p = await probe(c, { fetchImpl, timeoutMs });
    tried.push({ url: c.replace(/^https?:\/\/[^/]+/, ''), ok: p.ok, status: p.status, bytes: p.bytes, error: p.error });
    if (p.ok) {
      const note = `${t.variant}(${t.host}) ⇒ **升级到 ${c.split('/').pop()}**`
        + `（${p.bytes ?? '?'} 字节）—— 低清缩略图的 OCR 是乱码，高清才读得出图上文字`;
      if (typeof log === 'function') log(`🖼 素材图升级：${note}`);
      return { url: c, upgraded: true, from: t.variant, to: c.split('/').pop(), tried, note };
    }
  }
  const note = `${t.variant} ⇒ 高清变体都取不到（试了 ${tried.length} 个）⇒ **用原图，不拦不丢**`;
  if (typeof log === 'function') log(`🖼 素材图升级：${note}`);
  return { url: orig, upgraded: false, from: t.variant, to: t.variant, tried, note };
}

/* ═══════════════════════════ 自证 ═══════════════════════════ */
export async function selftest() {
  let pass = 0; const bad = [];
  const ok = (n) => { pass++; console.log(`  ✅ ${n}`); };
  const no = (n, why) => { console.log(`  ❌ ${n} —— ${why}`); bad.push(n); };
  const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want)
    ? ok(n) : no(n, `期望 ${JSON.stringify(want)}，实得 ${JSON.stringify(got)}`));

  const HQ = 'https://i.ytimg.com/vi/iV9POYKPrxs/hqdefault.jpg';
  /** 桩：只认列在 `alive` 里的 URL，并且**记下探过哪些**。 */
  const mkFetch = (alive, { throwOn = [] } = {}) => {
    const seen = [];
    const f = async (u) => {
      seen.push(u);
      if (throwOn.includes(u)) throw new Error('fetch failed');
      const a = alive.includes(u);
      return { ok: a, status: a ? 200 : 404, headers: { get: () => (a ? '123456' : '0') } };
    };
    f.seen = seen;
    return f;
  };

  // ① 高清在 ⇒ 升级（这是本模块存在的理由）
  {
    const f = mkFetch(['https://i.ytimg.com/vi/iV9POYKPrxs/maxresdefault.jpg']);
    const r = await bestImageVariant(HQ, { fetchImpl: f });
    eq('① hq 有 maxres ⇒ 升级到 maxresdefault', [r.url.endsWith('/maxresdefault.jpg'), r.upgraded], [true, true]);
    eq('① 只探了 maxres 一个（不许把候选全探一遍）', f.seen.length, 1);
  }
  // ② maxres 没有、sd 有 ⇒ 退一档到 sd
  {
    const f = mkFetch(['https://i.ytimg.com/vi/iV9POYKPrxs/sddefault.jpg']);
    const r = await bestImageVariant(HQ, { fetchImpl: f });
    eq('② maxres 404 ⇒ 退到 sddefault', [r.url.endsWith('/sddefault.jpg'), r.upgraded], [true, true]);
  }
  // ③ 高清都没有 ⇒ **原图**（fail-open：宁可看糊图，不许把图丢掉）
  {
    const f = mkFetch([]);
    const r = await bestImageVariant(HQ, { fetchImpl: f });
    eq('③ 高清变体都取不到 ⇒ 用原 URL', [r.url, r.upgraded], [HQ, false]);
  }
  // ④ 探测抛异常（DNS/超时）⇒ 原图，且不许把异常抛出去
  {
    const f = mkFetch([], { throwOn: ['https://i.ytimg.com/vi/iV9POYKPrxs/maxresdefault.jpg'] });
    const r = await bestImageVariant(HQ, { fetchImpl: f });
    eq('④ 探测抛异常 ⇒ 原 URL（fail-open）', [r.url, r.upgraded], [HQ, false]);
  }
  // ⑤ 不是 YouTube 缩略图 ⇒ **一个请求都不发**（不许顺手改别人的图）
  {
    const f = mkFetch([]);
    const r = await bestImageVariant('https://m.media-amazon.com/images/I/61C+3L40vOL._AC_SL1280_.jpg',
                                     { fetchImpl: f });
    eq('⑤ 非 YouTube ⇒ 原样 + 不探', [r.url, f.seen.length], ['https://m.media-amazon.com/images/I/61C+3L40vOL._AC_SL1280_.jpg', 0]);
  }
  // ⑥ 本来就是高清 ⇒ 不探（省一次往返）
  {
    const f = mkFetch([]);
    const r = await bestImageVariant('https://i.ytimg.com/vi/x/maxresdefault.jpg', { fetchImpl: f });
    eq('⑥ 已是 maxres ⇒ 原样 + 不探', [r.upgraded, f.seen.length], [false, 0]);
  }
  // ⑦ 认域名形状：`img.youtube.com` 也认；`evil-ytimg.com` **不认**（防"看着像就改"）
  {
    eq('⑦ img.youtube.com 认', !!ytThumbOf('https://img.youtube.com/vi/abc123/hqdefault.jpg'), true);
    eq('⑦ evil-ytimg.com 不认', ytThumbOf('https://evil-ytimg.com/vi/abc123/hqdefault.jpg'), null);
    eq('⑦ 路径不合法（非 /vi/）不认', ytThumbOf('https://i.ytimg.com/vi_webp/abc123/hqdefault.jpg'), null);
  }

  console.log(`selftest ${bad.length === 0 ? '全绿' : bad.length + ' 项红'}（${pass} 项）`);
  return bad.length === 0 ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--selftest')) {
    const rc = await selftest();
    await sleep(0);
    process.exit(rc);
  }
  console.log('用法：node tools/agent/image_variant.mjs --selftest');
}

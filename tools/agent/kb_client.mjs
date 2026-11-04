/**
 * kb_client.mjs —— 守衡读「内容治理知识库（本机工作台的 kb-serve）」
 *
 * ── 它连的是什么
 *
 * ★ 2026-10-05 更正：本文件原写「**另一台机器**的 DSH 内容治理知识库」「走 ngrok」，**与现状不符**。
 *   实测：守衡在**本机**（launchd `com.shouheng.lark` / `node ws_daemon.mjs`），
 *   凭据 `~/.dsh/credentials/shouheng-kb.json` 的 base_url = `http://127.0.0.1:4401`（回环），
 *   那正是**本机** DSH Desktop 托管的 `kb-serve`（`/health` 自报 `db=…/工作台/var/workbench.db`）。
 *   运行中的守衡进程**没有**设 `SHOUHENG_KB_BASE_URL` ⇒ 走的确实是回环地址。
 *   它对外提供的是**宿主知识库的派生视图**（子库：`3_措辞表达库` 509 条、`1_外部标准库` 375 条…），
 *   不是权威库本身。下文凡「另一台机器 / ngrok 隧道」的措辞，请一律按**本机服务**理解。
 *
 * 本机服务开了一个只读 OpenAPI（kb:search），范围=全部子库。
 * **两个业务端点 + 一个免费探活端点**（实测：/docs、/chunks、/version、/openapi.json 全 404；
 * /openapi/v1/health 也是 404 —— 但**根路径 `GET /health` 是 200、免鉴权、不消耗配额**，
 * 探活必须用它，不要拿一次检索去试）：
 *
 *   ⓪ GET {base}/health                    ← 免鉴权、0 配额、约 0.2 秒。返回 {ok,service,db}
 *   ① GET {base}/openapi/v1/kb
 *        鉴权：**必须** Authorization: Bearer。放 ?key= 会 401。
 *        返回：{ contractVersion, collections:[{id,name,description,docCount,createdAt}] }
 *
 *   ② GET {base}/openapi/v1/kb/{子库id}/retrieve?key=<k>&q=<词>&topK=<n>
 *        鉴权：?key= 或 Bearer 都行。
 *        返回：{ contractVersion, requestId, collection, hits:[…], hitCount,
 *                totalCandidates, latencyMs, scoreKind, confidence, fallback }
 *
 * ── 三条实测出来的硬事实（不看代码看不出来，踩过才知道）
 *
 * 【事实 1 · 配额 60/分钟、1000/天，没有配额查询端点】
 *   429 返回 { error:{code:'RATE_LIMITED'}, retryAfterSeconds, scope }。
 *   1000/天 这个数决定了「每次裁决都现查」在物理上做不到 ——
 *   一段 500 字中文按 n-gram 拆词去问就是上千次调用。所以本模块**自带闸门**：
 *   请求前先过限速与日配额，宁可少查，不要把配额烧穿。
 *
 * 【事实 2 · 相关性排序的开关是**查询词长度**，不是语言】（原先记成「中文没有排序」——错的）
 *   索引是 FTS5 的 `trigram` 分词器，它要求**查询词至少 3 个字符**：
 *     q=吸奶器（中文 3 字）→ scoreKind:'bm25'        score 是真实 BM25（4.5853, 4.5791…）
 *     q=pain （英文 4 字） → scoreKind:'bm25'        score 是真实 BM25（8.1548, 8.1323…）
 *     q=无痛 （中文 2 字） → scoreKind:'positional'  fallback:'like'，score 是**词频**
 *     q=no   （英文 2 字） → scoreKind:'positional'  ← **英文短词同样回退**
 *   所以实操规则只有一条：**查询词一律写 ≥3 个字**（写「无痛分娩」而不是「无痛」）。
 *   回退到 positional 时排序并未失效（词频 → 标题命中 → 片段更短 → chunkId），
 *   但**它不是 BM25 相关度**，而且两种 scoreKind 的 score 不可比大小。
 *   本模块不隐瞒这件事：返回值带 `order_is_meaningful` / `ranking_caveat` / `query_hint`，
 *   调用方（模型）必须看见它。判据宁可保守：**只有 bm25 才算顺序可信，未知一律算不可信。**
 *
 * 【事实 3 · 文档被切成多个分片，且没有取全文的端点】
 *   一个文档可能占多个 chunk（实测某个文档独占 top-10 里的 5 个）。
 *   可执行正则在**部分**分片里（H09 的分片有 5 行正则，H07 的头部片只有 664 字、正文在别处）。
 *   没有 /docs 端点 → 拿不到「某个文档的全部分片」。所以本模块返回的 always 是**分片**，
 *   不是完整规则，`hits[].docId` 才是文档的身份。
 *
 * ── 凭据
 *
 * 与 shouheng-lark.json 同一约定，落在 ~/.dsh/credentials/shouheng-kb.json（0600）。
 * 该目录已被 tools.mjs 的 secretPathHit 列为禁入 —— **守衡读不到自己的凭据**，
 * 只有本模块在进程启动时装载一次。任何日志、任何返回值都不含明文 key。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// ★ 用 stateDir() 而不是 STATE_DIR 常量：前者是**调用时**解析的，
//   后者在 import 期就定死了。config.mjs 那段注释警告的正是这个陷阱 ——
//   「一旦别的模块先加载了本文件，后面再改环境变量就不会有任何效果，而这种失效是静默的」。
//   对守护进程没差别（env 在启动前就设好），但对测试有决定性差别：
//   常量版会让「配额账本到底落在哪个目录」变成一条**测不了的**约束。
import { stateDir, ensureDir } from './config.mjs';

/**
 * 凭据文件路径。允许用 SHOUHENG_KB_CRED_PATH 覆盖 —— 这不是给生产用的开关，
 * 是为了让 kb_client.test.mjs 能**在不碰真凭据的前提下**证「凭据缺失/不完整时
 * 说的是人话、且不吐明文」。跟 stateDir() 用 SHOUHENG_STATE_DIR 是同一个理由：
 * 一条测不了的错误路径，等于没有这条路径。
 */
const CRED_PATH = process.env.SHOUHENG_KB_CRED_PATH
  ? path.resolve(process.env.SHOUHENG_KB_CRED_PATH)
  : path.join(os.homedir(), '.dsh', 'credentials', 'shouheng-kb.json');

/** topK 实测上限：50。60 会返回 TOPK_TOO_LARGE。 */
export const TOPK_MAX = 50;
export const TOPK_DEFAULT = 10;

/* ─────────────── 回给模型的**上下文预算**（2026-09-30 加） ───────────────
 *
 * ★ 为什么这两个数必须存在，而不是让调用方自己看着办。
 *
 * 真实事故（2026-09-30 19:11，本群）：她问「用知识库查一下『吸奶器』相关的措辞要求」。
 * 模型调了两次本模块（topK=50 + topK=20），命中的**正文一个字都没剪**就进了上下文 ——
 * 41,262 + 19,087 = **60,349 字**原始 JSON。下一轮模型把 8000 token 输出预算
 * 全部烧在思维链上（`reasoning 8000 tok｜正文 0 字｜finish_reason=length`），
 * 群里收到的是一条**只有截断说明的消息**。
 *
 * 所以上限落在**本模块**，不落在调用方的自觉上：`topK` 是「问服务端要几条」，
 * 这两个是新加的「**回给模型几条、每条多长**」。两者分开，是因为
 * 「候选有多少」与「我这次看得见多少」是两件事，混成一个数就再也说不清
 * 「只有 10 条规则」和「我只看了 10 条」的区别。
 *
 * ⚠️ 裁剪**必须可见**：`hits_returned` / `hits_dropped` / `text_clipped` 三个读数
 *   与一句 `clip_note` 一起返回，调用方（模型）必须看见它 ——
 *   §2.4.1：「只回了 10 条」不许被读成「一共只有 10 条」。
 */
export const HITS_RETURN_MAX = 10;      // 一次最多回几条分片（topK 仍可要到 50）
export const HIT_TEXT_MAX = 1200;       // 每条分片正文最多多少字（实测一条规则 ≈100 字）

/** 三个子库的 id（URL 编码后才是合法的路径段） */
export const COLLECTIONS = {
  standard: '1_外部标准库',
  samples: '2_内部正负样本库',
  wording: '3_措辞表达库',
};

/* ────────────────────────── 凭据装载 ────────────────────────── */

let _cred = null;
let _credSource = null;

/**
 * 装载凭据。环境变量优先，其次是凭据文件。
 *
 * 与 config.mjs 的 readDshCredential 不同，这里**不**在 import 期就抛 ——
 * 「另一台机器没接上」不该让守衡整个起不来。装载失败时把原因记在
 * credError 里，真正的调用点会把它转成一句人话。
 */
export function loadCred() {
  if (_cred) return _cred;

  const envBase = process.env.SHOUHENG_KB_BASE_URL;
  const envKey = process.env.SHOUHENG_KB_API_KEY;
  if (envBase && envKey) {
    _cred = { baseUrl: envBase.replace(/\/+$/, ''), apiKey: envKey };
    _credSource = 'env';
    return _cred;
  }

  let txt;
  try {
    txt = fs.readFileSync(CRED_PATH, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new Error(
        `未找到知识库凭据（${CRED_PATH}）。` +
        `把本机工作台 kb-serve 的 Base URL（默认 http://127.0.0.1:4401）与 API Key 写进这个文件，` +
        `或设环境变量 SHOUHENG_KB_BASE_URL / SHOUHENG_KB_API_KEY。`,
      );
    }
    // 权限错误/路径是目录等异常必须冒出来，不能伪装成「没配」
    throw new Error(`读取知识库凭据失败（${CRED_PATH}）：${e.code ?? e.message}`);
  }

  let j;
  try { j = JSON.parse(txt); }
  catch (e) { throw new Error(`知识库凭据不是合法 JSON（${CRED_PATH}）：${e.message}`); }

  if (!j.base_url || !j.api_key) {
    throw new Error(`知识库凭据不完整：需要 base_url 与 api_key（${CRED_PATH}）`);
  }
  _cred = { baseUrl: String(j.base_url).replace(/\/+$/, ''), apiKey: String(j.api_key) };
  _credSource = 'file';
  return _cred;
}

/** 安全摘要：任何日志都可放心调用，不含 key 明文 */
export function describeKb() {
  try {
    const c = loadCred();
    return {
      baseUrl: c.baseUrl,
      keyLen: c.apiKey.length,
      keyTail: c.apiKey.slice(-6),   // 够用来核对是哪一把，不足以复原
      source: _credSource,
    };
  } catch (e) {
    return { error: e.message };
  }
}

/* ────────────────────────── 配额 ────────────────────────── */

/**
 * 配额**只信服务端回报**，客户端不自己数。
 *
 * ── 为什么本地数数是错的（2026-09-28 实测）──────────────────────────────
 * 第一版在本地记了个日计数器，报出来 used=41；同一天服务端回报的
 * `quota.usedPerDay` 是 292。差了 7 倍。原因不是算错，是**口径不同**：
 * 客户端只看得见守衡自己发出去的请求，服务端数的是**所有调用方**
 * （检索响应里 callerKind='external_api' 就是这件事的自白）。
 * 拿本地数当余额用，会在还剩 700 次时就以为用光了，也会在真用光时以为还剩。
 * 所以：**不自己数。**
 *
 * ── 真值从哪来 ────────────────────────────────────────────────────────
 * 检索响应里带 `quota` 对象，实测长这样：
 *   { "limitPerMinute": 60, "limitPerDay": 1000, "usedPerMinute": 0, "usedPerDay": 292 }
 * ★ 只有 retrieve 带它 —— GET /openapi/v1/kb（列子库）**不带** quota。
 *   所以「列一次子库」不会刷新余额。这是这套接口的既有事实，不是 bug，
 *   调用方不许把「刚列过库」当成「余额刚更新过」。
 *
 * ── 存下来的东西怎么定性 ──────────────────────────────────────────────
 * 落盘（PMO/shouheng-state/kb_quota.json）是为了扛守护进程重启，存的是
 * **服务端最近一次回报的快照**，不是本地账本。它只做两件事：
 *   ① 保守闸门 —— 回报说已满就早退，省一次注定 429 的往返；
 *   ② 让「余额」这个说法有真值可引用，而不是编一个。
 * 真正的限流由服务端 429 + retryAfterSeconds 兜底。
 * ★ 任何对外引用这个数的地方，都必须把 asOf / ageMs 一起说出来 ——
 *   它是「上次回报时」的真值，不是此刻真值。
 */
/** 配额快照路径。惰性解析，理由见上面 import 处那段注释。 */
export function quotaPath() { return path.join(stateDir(), 'kb_quota.json'); }

/**
 * 客户端最小间隔。**与配额计数无关**，纯粹是别把 60/分钟打得太贴边。
 * 这不是「数配额」，是「排队」——服务端不会因为你排队慢而记错账。
 */
const MIN_GAP_MS = 1050;
const MINUTE_WINDOW = 57;

let _lastCallAt = 0;
let _minuteStamps = [];

/** 服务端最近一次回报的快照。null = 本次进程还没收到过任何 quota 字段。 */
let _lastServerQuota = null;

function readQuotaCache() {
  if (_lastServerQuota) return _lastServerQuota;
  try {
    const j = JSON.parse(fs.readFileSync(quotaPath(), 'utf8'));
    // 只认得出自服务端的快照。旧版本的本地账本 {date, used} 没有 usedPerDay，
    // 落到这里会被判为「不认识」→ 当作「还不知道」。这是**故意**的：
    // 宁可说不知道，也不要拿旧口径的数当真值继续用。
    if (j && j.source === 'server' && typeof j.usedPerDay === 'number') {
      _lastServerQuota = j;
      return j;
    }
  } catch { /* 没存过 / 坏掉 → 当作「还不知道」 */ }
  return null;
}

function writeQuotaCache(q) {
  try {
    ensureDir(stateDir());
    fs.writeFileSync(quotaPath(), JSON.stringify(q, null, 2), 'utf8');
  } catch (e) {
    // 快照写不下去不该让查询失败，但必须留痕 —— 否则下次重启后
    // 「余额」会退化成「不知道」，而没人知道为什么。
    console.warn(`[kb] 配额快照写入失败（${quotaPath()}）：${e.code ?? e.message}`);
  }
}

/**
 * 把响应里的 `quota` 原样吸收进来。**没有 quota 字段就什么都不做**——
 * 不是清零、不是加一、不是保持原样再猜。返回吸收到的快照，没吸收到返回 null。
 */
export function absorbQuota(body) {
  const q = body?.quota;
  if (!q || typeof q !== 'object' || typeof q.usedPerDay !== 'number') return null;
  const rec = {
    source: 'server',
    asOf: Date.now(),
    limitPerMinute: q.limitPerMinute ?? null,
    limitPerDay: q.limitPerDay ?? null,
    usedPerMinute: q.usedPerMinute ?? null,
    usedPerDay: q.usedPerDay,
    // 哪个 requestId 带回来的 —— 对端台账可回查，这一条让余额可被审计
    via_request: body?.requestId ?? null,
  };
  _lastServerQuota = rec;
  writeQuotaCache(rec);
  return rec;
}

/**
 * 当前配额状态。**字段名直接照抄服务端**（usedPerDay / usedPerMinute），
 * 不再提供 `used` 这种含糊别名 —— 别名正是上次把 41 报成余额的入口。
 * 没收到过服务端回报时，如实返回 source='none' 与全 null，**不编数、也不当 0**。
 */
export function quotaState() {
  const q = readQuotaCache();
  if (!q) {
    return {
      source: 'none',
      asOf: null,
      ageMs: null,
      limitPerMinute: null,
      limitPerDay: null,
      usedPerMinute: null,
      usedPerDay: null,
      remaining: null,
      note: '本次还没收到过服务端的 quota 回报（只有**检索**响应带 quota，列子库不带）。'
          + '余额**未知** —— 不许说成 0，也不许说成「充足」。做一次 kb_search 就能拿到真值。',
    };
  }
  const ageMs = Date.now() - q.asOf;
  return {
    source: 'server',
    asOf: new Date(q.asOf).toISOString(),
    ageMs,
    limitPerMinute: q.limitPerMinute,
    limitPerDay: q.limitPerDay,
    usedPerMinute: q.usedPerMinute,
    usedPerDay: q.usedPerDay,
    remaining: q.limitPerDay == null ? null : Math.max(0, q.limitPerDay - q.usedPerDay),
    via_request: q.via_request ?? null,
    note: '这是**服务端上一次回报**的真值（asOf 见上），不是此刻真值：'
        + '别的调用方在这之后仍会消耗。转述余额时必须连 asOf 一起说。',
  };
}

/** 等一下再发。返回实际等待的毫秒数。 */
async function throttle() {
  const now = Date.now();
  // ① 最小间隔
  let wait = Math.max(0, _lastCallAt + MIN_GAP_MS - now);
  // ② ★ 服务端回报说这一分钟已经打满 → 等这个分钟窗过去。
  //    这是唯一一个**基于真值**的等待：本地 _minuteStamps 只数得见自己，
  //    而 60/分钟 是全调用方共享的。快照超过 1 分钟就过期，不能再用它等。
  const q = readQuotaCache();
  if (q && q.limitPerMinute != null && q.usedPerMinute != null
      && q.usedPerMinute >= q.limitPerMinute && now - q.asOf < 60_000) {
    wait = Math.max(wait, 60_000 - (now - q.asOf) + 100);
  }
  // ③ 本地节奏兜底（不是配额，是别把窗口打得太贴边）
  const win = _minuteStamps.filter((t) => now - t < 60_000);
  if (win.length >= MINUTE_WINDOW) wait = Math.max(wait, 60_000 - (now - win[0]) + 50);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));

  const t = Date.now();
  _minuteStamps = _minuteStamps.filter((x) => t - x < 60_000);
  _minuteStamps.push(t);
  _lastCallAt = t;
}

/**
 * 还能不能再花 n 次。判据是**服务端最近一次回报**。
 * 余额未知时返回 true —— 让服务端 429 去兜底，不假装自己知道。
 */
export function canSpend(n = 1) {
  const q = readQuotaCache();
  if (!q || q.limitPerDay == null) return true;
  return q.usedPerDay + n <= q.limitPerDay;
}

/* ────────────────────────── 底层请求 ────────────────────────── */

/** 把服务端的错误码转成一句能直接照做的话 */
function explain(code, message, extra = {}) {
  switch (code) {
    case 'UNAUTHORIZED':
      return '鉴权失败（401）。核对 ~/.dsh/credentials/shouheng-kb.json 里的 api_key。'
           + '注意：① GET /openapi/v1/kb 只认 Authorization 头，放 ?key= 必然 401。';
    case 'RATE_LIMITED':
      return `超出服务端配额（60/分钟、1000/天），需等 ${extra.retryAfterSeconds ?? '?'} 秒。`
           + '本次是「没查成」，**不是「没有命中」**——不要拿它下否定结论。';
    case 'TOPK_TOO_LARGE':
      return `topK 超过上限（实测最大 ${TOPK_MAX}）。`;
    case 'KB_NOT_FOUND':
      return `没有这个子库。可用：${Object.values(COLLECTIONS).join(' / ')}`;
    case 'BAD_REQUEST':
      return `请求不合法：${message ?? ''}（q 必填）`;
    default:
      return `${code ?? '未知错误'}：${message ?? ''}`;
  }
}

/**
 * 发一次请求。带超时、429 重试、日配额闸门。
 * 绝不把 key 拼进任何抛出的错误信息里。
 */
async function request(url, { auth, timeoutMs = 20_000, retries = 3 } = {}) {
  const cred = loadCred();
  // 闸门读的是「服务端上次回报」。它可能已经过时（别的调用方还在消耗），
  // 所以它只用来早退，不用来放行 —— 放行一律交给服务端。
  const q = readQuotaCache();
  if (q && q.limitPerDay != null && q.usedPerDay >= q.limitPerDay) {
    throw Object.assign(new Error(
      `知识库日配额已满（服务端回报 ${q.usedPerDay}/${q.limitPerDay}，`
      + `回报时刻 ${new Date(q.asOf).toISOString()}）。` +
      `这是**服务端记账**，不是客户端数出来的 —— 客户端看不见别的调用方，余额只能信它。` +
      `本次是「没查成」，**不是「没有命中」**。等日界重置，或先降低查询密度。`,
    ), { code: 'QUOTA_EXHAUSTED' });
  }

  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    await throttle();
    let res;
    try {
      res = await fetch(url, {
        headers: auth === 'bearer' ? { Authorization: `Bearer ${cred.apiKey}` } : {},
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      // 网络层失败（隧道断了 / DNS / 超时）—— 这是「未测」，不是「没有」
      lastErr = Object.assign(new Error(
        `连不上知识库（${e.name === 'TimeoutError' ? '超时' : e.message}）。` +
        `本机 kb-serve（${baseUrl}）没起来、端口被占、或本机代理拦截都会这样。本次结论是「未测」。`,
      ), { code: 'NETWORK' });
      if (attempt < retries) { await new Promise((r) => setTimeout(r, 800 * (attempt + 1))); continue; }
      throw lastErr;
    }

    const txt = await res.text();

    let body = null;
    try { body = JSON.parse(txt); } catch { /* 非 JSON（ngrok 页面等） */ }

    // ★ 配额真值就在响应里 —— 读到就吸收。这里**不**自增任何计数器：
    //   自增是本地口径，服务端数的是全调用方，两者不是一回事（见本文件配额段注释）。
    //   失败响应若也带 quota 同样吸收（429 时它尤其有用）。
    absorbQuota(body);

    if (res.ok) return body ?? { _raw: txt.slice(0, 500) };

    const code = body?.error?.code ?? `HTTP_${res.status}`;
    const msg = body?.error?.message ?? (txt || '').slice(0, 200);

    if (res.status === 429) {
      const wait = Number(body?.retryAfterSeconds ?? 2);
      lastErr = Object.assign(new Error(explain(code, msg, body)), { code: 'RATE_LIMITED' });
      if (attempt < retries) { await new Promise((r) => setTimeout(r, (wait + 0.3) * 1000)); continue; }
      throw lastErr;
    }
    throw Object.assign(new Error(explain(code, msg, body)), { code, httpStatus: res.status });
  }
  throw lastErr;
}

/* ────────────────────────── 公开接口 ────────────────────────── */

/**
 * ① 列可访问子库。
 *
 * ★ 版本判据是每个子库的 `contentHash`（对端 2026-09-28 确认）。
 *   它是**内容指纹**：内容真变了才变；重新同步一遍而内容没变则**不变**。
 *   这正是判「库有没有更新」需要的东西，而且 1 次调用就拿到。
 *
 * ⚠️ `createdAt` **不是**「最后变更时刻」——它是子库第一次被镜像进来的时刻，
 *   此后**永不改变**。拿它当版本信号会得出一个恒为「没更新」的结论。
 *   实测（同一批响应）：
 *     3_措辞表达库   createdAt=1790146856318 → 2026-09-23 15:00:56
 *     1_外部标准库   createdAt=1790580427056 → 2026-09-28 15:27:07
 *     2_内部正负样本库 createdAt=1790580427056 → 2026-09-28 15:27:07（与上一个毫秒级相同）
 *   后两者相同、且**在此之后的多次同步都没让它动过** —— 这正是「首次镜像时刻」的特征。
 *   所以它只回答「这个子库什么时候建进来的」，不回答「内容变没变」。
 */
export async function listCollections() {
  const { baseUrl } = loadCred();
  const d = await request(`${baseUrl}/openapi/v1/kb`, { auth: 'bearer' });
  const cols = Array.isArray(d?.collections) ? d.collections : [];
  return {
    contractVersion: d?.contractVersion ?? null,
    collections: cols.map((c) => ({
      id: c.id, name: c.name, description: c.description,
      docCount: c.docCount,
      /** ★ 版本判据：内容变才变，重同步但内容没变则不变 */
      contentHash: c.contentHash ?? null,
      /** 首次镜像时刻。**不随内容变更而变**，别拿它判断更新。 */
      createdAt: c.createdAt,
      createdAt_iso: c.createdAt ? new Date(c.createdAt).toISOString() : null,
    })),
  };
}

/**
 * 版本指纹。纯函数，**离线可证** —— 抽出来就是为了让「createdAt 不许进指纹」
 * 这条能被一条断言钉死，而不是靠读代码时的自觉。
 *
 * 构成 = 每个子库的 (docCount, contentHash)。
 * ★ **刻意不含 createdAt**：它是首次镜像时刻、永不变。放进去有两个坏处：
 *   ① 稀释信号 —— 真正的变化源只有 contentHash，多一个恒定项没有信息量；
 *   ② 更糟的是**误导** —— 让人以为「指纹没变」这个结论也覆盖了内容维度。
 * contentHash 缺失时记 'NO_HASH'：这时指纹实际只看 docCount，
 * 调用方（versionSnapshot）必须把这件事说出去。
 */
export function versionFingerprint(collections) {
  return (Array.isArray(collections) ? collections : [])
    .map((c) => `${c.id}:${c.docCount}:${c.contentHash ?? 'NO_HASH'}`)
    .sort().join('|');
}

/**
 * 版本快照：把三个子库的 (docCount, contentHash) 压成一行指纹。
 * 用途是**变更探测** —— 存下上一次的指纹，下次比对即可，
 * 不必落盘规则内容也能知道「库动没动」。1 次调用。
 */
export async function versionSnapshot() {
  const { collections, contractVersion } = await listCollections();
  const missingHash = collections.filter((c) => !c.contentHash).map((c) => c.id);
  const fp = versionFingerprint(collections);
  return {
    contractVersion,
    collections,
    fingerprint: fp,
    /** 非空 = 对端这次没给 contentHash，此时指纹退回只看 docCount（要说出去） */
    contentHashMissing: missingHash,
    takenAt: new Date().toISOString(),
    note: '版本判据是 contentHash：**内容真变了它才变，重新同步一遍而内容没变则不变**。'
        + '指纹没变 → 可以据此说「库没更新」。'
        + (missingHash.length
            ? `⚠️ 但这次有子库没返回 contentHash（${missingHash.join(' / ')}），`
              + '它们的指纹只含 docCount —— 改内容不加条数的那种更新看不出来，不许说成「没更新」。'
            : '')
        + ' createdAt 是**首次镜像时刻、此后永不改变**，不是最后变更时刻，'
        + '不能用它判「库有没有更新」。',
  };
}

/** 进程内去重：同一次裁决里重复问同一个词没有意义，但**不跨次缓存**（库在更新）。 */
const _memo = new Map();

/**
 * ★ 本模块最要紧的一条判据，抽成纯函数是为了**能被离线证伪**。
 *
 * 实测：q=吸奶器（3 字）→ scoreKind='bm25'；q=无痛（2 字）→ scoreKind='positional'。
 * **分叉轴是查询词长度（trigram 分词器要求 ≥3 字符），不是语言** ——
 * 英文的 q=no 同样回退，中文的 q=吸奶器 照样拿到真 BM25。
 * 只有 bm25 的 score 才是相关性评分；positional 的 score 是词频（两个 scoreKind 不可比）。
 * 所以这个判据宁可保守：**凡是没被明确认成 bm25 的，一律当成「顺序不可信」。**
 * 默认安全的那一侧必须是「不可信」，不能是「可信」—— 将来服务端换引擎也不会误判。
 */
export function orderIsMeaningful(scoreKind) {
  return scoreKind === 'bm25';
}

/** scoreKind → score 字段的含义。纯函数，离线可证。 */
export function scoreMeaning(scoreKind) {
  return orderIsMeaningful(scoreKind)
    ? 'bm25 相关性分，越大越相关'
    : '词频（该查询串在本片段出现的次数），**不是相关性分**，且与 bm25 分不可比';
}

/** scoreKind → 给调用方（模型）看的一句话提示。纯函数，离线可证。 */
export function rankingCaveat(scoreKind) {
  return orderIsMeaningful(scoreKind)
    ? '本次为 bm25 排序，score 是真实相关性评分，顺序可用来挑最相关的几条。'
    : `本次 scoreKind=${scoreKind ?? '未知'}（查询词不足 3 个字符，trigram 分词器回退到 like）：`
      + 'score 是**词频**不是 BM25 相关度，两种 scoreKind 的 score 不可比大小。'
      + '顺序在本次响应内仍按「词频 → 标题命中 → 片段更短」排列，但**不能当相关性用**；'
      + '要判定必须把命中分片全部取回本地比对。改用 ≥3 个字的查询词可拿到 bm25。';
}

/**
 * 查询词长度检查（trigram 分词器要求 ≥3 字符）。
 * 返回 null = 够长；否则返回一句给模型看的改写建议。
 * 按**码点**计数，所以「无痛」=2、「吸奶器」=3，中英文同一把尺子。
 */
export function queryLengthHint(query) {
  const q = String(query ?? '').trim();
  const n = [...q].length;
  if (n >= 3) return null;
  return `查询词「${q}」只有 ${n} 个字符，不足 3 个 —— 索引是 trigram 分词器，`
       + '本次会回退成词频序（scoreKind=positional），拿不到 BM25 相关性排序。'
       + '建议改写成 ≥3 个字的更具体表达再查一次（例：「无痛」→「无痛分娩」）。';
}

/**
 * ② 检索一个子库。
 *
 * @param {string} collection  子库 id（1_外部标准库 / 2_内部正负样本库 / 3_措辞表达库）
 * @param {string} query       查询词
 * @param {object} [opts]
 * @param {number} [opts.topK] 返回分片数，1..50，默认 10
 * @param {boolean}[opts.memo] 是否用进程内去重（默认 true）
 * @param {number} [opts.maxHits]    **回给模型**最多几条（默认 10，上限 TOPK_MAX）。
 *                                   与 topK 分开：topK 是问服务端要几条，maxHits 是塞进上下文几条。
 * @param {number} [opts.maxHitChars] 每条分片正文最多多少字（默认 1200，0 = 不剪）
 * @returns {Promise<object>}  归一化后的结果，**带排序可信度提示与裁剪说明**
 */
export async function retrieve(collection, query, opts = {}) {
  const q = String(query ?? '').trim();
  if (!q) throw Object.assign(new Error('query 不能为空'), { code: 'BAD_REQUEST' });

  const topK = Math.min(TOPK_MAX, Math.max(1, Number(opts.topK ?? TOPK_DEFAULT) || TOPK_DEFAULT));
  // ★ maxHits 只许**收**不许放：写成「调用方给多少就是多少」等于没有上限。
  const maxHits = Math.min(topK, Math.max(1, Number(opts.maxHits ?? HITS_RETURN_MAX) || HITS_RETURN_MAX));
  const maxHitChars = opts.maxHitChars === 0 ? 0
    : Math.max(200, Number(opts.maxHitChars ?? HIT_TEXT_MAX) || HIT_TEXT_MAX);
  const memo = opts.memo !== false;
  // ★ memo 的键必须含裁剪参数：不含的话，先来一次「剪短版」会命中后到的那次「完整版」请求，
  //   而返回的是剪过的 —— 缓存串味，且**没有任何东西会红**。
  const memoKey = `${collection}\u0000${q}\u0000${topK}\u0000${maxHits}\u0000${maxHitChars}`;
  if (memo && _memo.has(memoKey)) return { ..._memo.get(memoKey), from_memo: true };

  const { baseUrl, apiKey } = loadCred();
  const url = `${baseUrl}/openapi/v1/kb/${encodeURIComponent(collection)}/retrieve`
            + `?key=${encodeURIComponent(apiKey)}&q=${encodeURIComponent(q)}&topK=${topK}`;
  const d = await request(url, { auth: 'none' });

  const hits = Array.isArray(d?.hits) ? d.hits : [];
  const scoreKind = d?.scoreKind ?? null;

  // ★ 上下文预算：**先剪条数，再剪正文**。两个数都要报出去（见文件上方那两个常量）。
  const kept = hits.slice(0, maxHits);
  let textClipped = 0;
  const bounded = kept.map((h) => {
    const raw = String(h.text ?? '');
    if (!maxHitChars || raw.length <= maxHitChars) return { ...h, text: raw };
    textClipped += 1;
    return { ...h, text: raw.slice(0, maxHitChars)
      + `\n…〔本条分片原长 ${raw.length} 字，已按 ${maxHitChars} 字上限剪短〕` };
  });
  const hitsDropped = hits.length - kept.length;

  // ★ 排序可信度：这是本模块最要紧的一句提示。
  //   查询词不足 3 个字符时服务端回退成词频序；把它当相关性用会直接判错。
  const orderIsOk = orderIsMeaningful(scoreKind);
  const qHint = queryLengthHint(q);

  const out = {
    ok: true,
    collection: d?.collection?.id ?? collection,
    query: q,
    topK,
    contractVersion: d?.contractVersion ?? null,
    requestId: d?.requestId ?? null,

    hitCount: d?.hitCount ?? hits.length,
    totalCandidates: d?.totalCandidates ?? null,
    latencyMs: d?.latencyMs ?? null,

    // ★ 上下文预算的三个读数（2026-09-30 加）。**与 hitCount 分开**：
    //   hitCount = 服务端说命中几条；hits_returned = 这次真的回给你几条。
    //   两者不等时，下面的 clip_note 会明说 —— 不许把前者当成后者。
    hits_returned: bounded.length,
    hits_dropped: hitsDropped,
    text_clipped: textClipped,
    clip: { max_hits: maxHits, max_hit_chars: maxHitChars },
    clip_note: (hitsDropped || textClipped)
      ? `⚠️ 为控制上下文，这次**只回给你 ${bounded.length}/${hits.length} 条分片**`
        + (textClipped ? `，其中 ${textClipped} 条的正文被剪短到 ${maxHitChars} 字` : '')
        + (hitsDropped ? `，另外 ${hitsDropped} 条**这次没回**` : '')
        + '。**这不等于「库里只有这些」** —— 要更多就换更具体的查询词（或分几次问），'
        + '不要据此说「只有 N 条」。'
      : null,

    // 排序可信度 —— 必须原样透传给调用方
    scoreKind,
    confidence: d?.confidence ?? null,
    fallback: d?.fallback ?? null,
    order_is_meaningful: orderIsOk,
    ranking_caveat: rankingCaveat(scoreKind),
    // 查询词 <3 个字时的改写建议（null = 够长）。给模型看的，别丢。
    query_hint: qHint,

    // ★ 配额真值 —— 直接来自本次响应（request() 已 absorbQuota）。
    //   放在检索结果里，是为了让「还剩多少」有真值可引用，
    //   而不是让谁去数本地发了几次。
    quota: quotaState(),

    // 分片提示 + 去重后的文档数
    // ★ 2026-09-30：这两个读数改成**按「这次真的回给你的那几条」**算 ——
    //   原先按服务端全量算，于是剪掉 34 条之后它还写着「44 个分片来自 22 个文档」，
    //   而模型手里只有 10 条。**读数必须描述它实际拿到的东西**，否则又是一次假精度。
    //   服务端那一侧的同一读数另存一格，两者不同时由 clip_note 明说。
    uniqueDocCount: new Set(bounded.map((h) => h.docId)).size,
    uniqueDocCountInServerHits: new Set(hits.map((h) => h.docId)).size,
    chunk_note: `返回的是**分片**(chunk)不是完整规则：这次回给你 ${bounded.length} 个分片来自 `
              + `${new Set(bounded.map((h) => h.docId)).size} 个文档`
              + (hitsDropped || textClipped
                  ? `（服务端命中 ${hits.length} 个分片、${new Set(hits.map((h) => h.docId)).size} 个文档，`
                    + '差额是上面那句 clip_note 说的事）'
                  : '')
              + '。同一文档可能占多个分片；没有取全文的端点，所以「某文档的全部分片」拿不到。',

    truncated: d?.totalCandidates != null && d.totalCandidates > hits.length,
    truncation_note: (d?.totalCandidates != null && d.totalCandidates > hits.length)
      ? `候选 ${d.totalCandidates} 个分片，只取回 ${hits.length} 个（topK 上限 ${TOPK_MAX}，且**没有翻页参数**：`
        + 'offset/page 实测被静默忽略）。多出来的部分**这次拿不到**。'
      : null,

    hits: bounded.map((h) => ({
      docId: h.docId,
      docTitle: h.docTitle,
      chunkId: h.chunkId,
      text: h.text,
      // score 的含义随 scoreKind 变，两个都留着，别让人误会
      score: h.score,
      scoreNorm: h.scoreNorm,
      rank: h.rank,
      coverage: h.coverage,
      score_meaning: scoreMeaning(scoreKind),
    })),
  };

  if (memo) _memo.set(memoKey, out);
  return out;
}

/** 清掉进程内去重（批量裁决开始时可调，保证跨批不串味） */
export function clearMemo() { _memo.clear(); }

/**
 * ⓪ 探活：`GET {base}/health` —— **免鉴权、不消耗配额**、约 0.2 秒。
 *
 * 为什么不走 request()：request() 每次都会给本地日账本 +1，而这一条服务端根本不记账。
 * 把免费探活记成消耗，会让闸门比真实配额早用尽 —— 那是**自己把自己卡死**。
 * 所以这里直接 fetch，不碰配额。
 *
 * 它能回答的问题很具体：「隧道通不通、服务端活着没有」。
 * 它**不能**回答「key 还有效吗」—— 那要用 listCollections()（Bearer，计 1 次配额）。
 */
export async function ping() {
  const { baseUrl } = loadCred();
  const t0 = Date.now();
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(8000) });
    const txt = await res.text();
    let body = null;
    try { body = JSON.parse(txt); } catch { /* ngrok 拦截页等 */ }
    return {
      ok: res.ok && body?.ok === true,
      httpStatus: res.status,
      service: body?.service ?? null,
      elapsedMs: Date.now() - t0,
      quotaCost: 0,
      note: res.ok ? '隧道通、服务端活着、不消耗配额' : `探活返回 HTTP ${res.status}（可能是 ngrok 隧道过期页）`,
    };
  } catch (e) {
    return {
      ok: false,
      httpStatus: null,
      elapsedMs: Date.now() - t0,
      quotaCost: 0,
      note: `连不上 ${baseUrl}/health（${e.name === 'TimeoutError' ? '超时' : e.message}）。`
          + '本机 kb-serve 没起来、端口被占、或本机代理拦截都会这样。这是「没查成」，不是「库里没有」。',
    };
  }
}

/**
 * 连通性自检。给「守衡到底接上没有」一个能一键回答的东西。
 * ⓪ 免费探活（0 配额）→ ① 列子库（1 次）→ ② 检索（1 次）。共消耗 2 次配额。
 */
export async function healthCheck() {
  const t0 = Date.now();
  const out = { ok: false, steps: [] };
  try {
    const p = await ping();
    out.steps.push({ step: '⓪ 探活 GET /health（免鉴权·0 配额）', ok: p.ok, note: p.note });
    if (!p.ok) throw Object.assign(new Error(p.note), { code: 'NETWORK' });
    const cols = await listCollections();
    out.steps.push({ step: '① 列子库（Bearer）', ok: true, collections: cols.collections.length, contractVersion: cols.contractVersion });
    const target = cols.collections.find((c) => c.id === COLLECTIONS.wording) ?? cols.collections[0];
    if (!target) throw new Error('服务端没有返回任何子库');
    const r = await retrieve(target.id, 'pain', { topK: 3 });
    out.steps.push({ step: `② 检索 ${target.id}`, ok: true, hitCount: r.hitCount, scoreKind: r.scoreKind });
    out.ok = true;
    out.baseUrl = loadCred().baseUrl;
    out.elapsedMs = Date.now() - t0;
    out.quota = quotaState();
    return out;
  } catch (e) {
    out.steps.push({ step: '失败', ok: false, error: e.message, code: e.code ?? null });
    out.quota = quotaState();
    return out;
  }
}

/* ────────────────────────── CLI ────────────────────────── */

const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));

if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  const J = (o) => console.log(JSON.stringify(o, null, 2));
  try {
    if (cmd === 'cred')        { J(describeKb()); }
    else if (cmd === 'quota')  { J(quotaState()); }
    else if (cmd === 'ping')   { const r = await ping(); J(r); process.exit(r.ok ? 0 : 1); }
    else if (cmd === 'health') { const r = await healthCheck(); J(r); process.exit(r.ok ? 0 : 1); }
    else if (cmd === 'list')   { J(await listCollections()); }
    else if (cmd === 'version'){ J(await versionSnapshot()); }
    else if (cmd === 'q' || cmd === 'query') {
      const [query, collection = COLLECTIONS.wording, topK = '10'] = rest;
      if (!query) throw new Error('用法：node tools/agent/kb_client.mjs q "<查询词>" [子库id] [topK]');
      const r = await retrieve(collection, query, { topK: Number(topK) });
      console.log(`# ${r.collection} ← q="${r.query}"  hitCount=${r.hitCount} cand=${r.totalCandidates} `
                + `scoreKind=${r.scoreKind} 排序可信=${r.order_is_meaningful} 唯一文档=${r.uniqueDocCount}`);
      console.log(`# ${r.ranking_caveat}`);
      if (r.query_hint) console.log(`# ⚠ ${r.query_hint}`);
      for (const h of r.hits) {
        console.log(`\n--- chunk=${h.chunkId} doc=${h.docId} score=${h.score} (${h.score_meaning})`);
        console.log(`    ${String(h.docTitle).slice(0, 90)}`);
        console.log(String(h.text).split('\n').slice(0, 6).map((l) => `    ${l}`).join('\n'));
      }
    }
    else {
      console.log(`守衡知识库客户端

  node tools/agent/kb_client.mjs cred      凭据摘要（不含明文 key）
  node tools/agent/kb_client.mjs quota     今日配额余额
  node tools/agent/kb_client.mjs ping      探活（免鉴权·**0 配额**·约 0.2 秒）★排障先跑这个
  node tools/agent/kb_client.mjs health    完整自检（探活 + 列子库 + 检索，共 2 次配额）
  node tools/agent/kb_client.mjs list      列可访问子库（1 次配额，含版本信号）
  node tools/agent/kb_client.mjs version   版本指纹（变更探测用）
  node tools/agent/kb_client.mjs q "<词>" [子库id] [topK]   检索（**查询词请写 ≥3 个字**）`);
    }
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
}

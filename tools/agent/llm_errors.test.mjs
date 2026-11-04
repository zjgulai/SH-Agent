#!/usr/bin/env node
/**
 * llm_errors.test.mjs —— 「断在哪一层」的判据（Q1-1a/1b 的自证）
 *
 * ── 它守的是哪一件事
 *
 * 2026-09-22 15:29 断网那次，守衡在群里说的是「失败原因：网络错误: fetch failed」——
 * 那是 Node `fetch()` 的**最外层**一句话。DNS 挂了、出口拒了、TLS 过期、undici 超时，
 * 四种情况共用这一句。事后想再查也查不回来（cause 当时没存）。
 *
 * 判据的形状：层名必须**可被机器断言**，所以它排在串的最前面，
 * 而且 `chain[0]` 恒是断掉的那一层（链按由深到浅排）。
 *
 * ── 用法
 *
 *   node tools/agent/llm_errors.test.mjs                 # L1–L5（离线；只用本机回环，不花 token）
 *   node tools/agent/llm_errors.test.mjs --controls      # 反向对照：喂坏样本，判据**必须红**
 *   node tools/agent/llm_errors.test.mjs --probe-badhost # 现场探针：打一个不存在的域名
 *
 * ⚠️ 三种模式都**只写临时文件**：`SHOUHENG_LLM_FAILURES` 在文件最上面就被指到临时目录
 *    （§2.4.4：跑一次自证改掉真数据，是这套东西踩过的坑）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';

/* ── 在最前面把落点改到临时目录：真 `llm_failures.jsonl` 一个字节都不许动 ── */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'llm_errors_'));
process.env.SHOUHENG_LLM_FAILURES = path.join(TMP, 'llm_failures.jsonl');
const FAILURES = process.env.SHOUHENG_LLM_FAILURES;

const llm = await import('./llm.mjs');
const { config } = await import('./config.mjs');

const results = [];
const T = (id, ok, detail) => results.push({ id, ok, detail });

/* ─────────────────────── 判据（正反两面都用同一份） ─────────────────────── */

/** L1：`cause` 链走到最深 —— 跳数必须真的保住（只读一层就会红）。 */
export function judgeL1(desc, expectHops) {
  const n = desc?.chain?.length ?? 0;
  return { ok: n >= expectHops, why: `链深 ${n}，期望 ≥ ${expectHops}` };
}

/** L2：层名映射 —— 结论与 `chain[0].layer` 必须**同时**对，且都在封闭集合里。 */
export function judgeL2(desc, expectLayer) {
  const c0 = desc?.chain?.[0] ?? {};
  const inSet = llm.LAYERS.includes(desc?.layer) && llm.LAYERS.includes(c0.layer);
  const ok = desc?.layer === expectLayer && c0.layer === expectLayer && inSet;
  return { ok, why: `顶层 layer=${desc?.layer}，chain[0].layer=${c0.layer}，期望 ${expectLayer}（都在册=${inSet}）` };
}

/** L3：**每一次**尝试的错都留着，不只最后一次。 */
export function judgeL3(attempts, expectN) {
  const n = Array.isArray(attempts) ? attempts.length : 0;
  const every = Array.isArray(attempts) && attempts.every((a, i) => a.n === i + 1);
  return { ok: n === expectN && every, why: `attempts=${n}（顺序连续=${every}），期望 ${expectN}` };
}

/** L4：**成功路径不许产出 error/chain/attempts** —— 闭嘴也是一种断言。 */
export function judgeL4(res) {
  const extra = ['error', 'chain', 'attempts', 'layer', 'retryable'].filter((k) => res?.[k] !== undefined);
  return { ok: res?.ok === true && extra.length === 0, why: `ok=${res?.ok}，多出来的字段=${extra.join(',') || '无'}` };
}

/** L5：真实事件回归 —— 15:32 那次那一句的形状，能不能答出来。 */
export function judgeL5(desc) {
  const s = String(desc?.summary ?? '');
  const hits = ['ENOTFOUND', 'getaddrinfo', 'api.deepseek.com'].filter((x) => s.includes(x));
  return { ok: hits.length === 3, why: `摘要里命中 ${hits.join('/') || '无'}：${s}` };
}

/** L8：`DOMException` 的数字码必须归一名 —— 群里不许再出现「超时/20」。 */
export function judgeL8(desc) {
  const c0 = desc?.chain?.[0] ?? {};
  const s = String(desc?.summary ?? '');
  const ok = desc?.layer === '超时' && c0.code === 'ABORT_ERR' && c0.layer === '超时'
          && s.includes('ABORT_ERR') && !s.includes('/20');
  return { ok, why: `layer=${desc?.layer} code=${c0.code} chain0.layer=${c0.layer}｜${s}` };
}

/**
 * L9：**超时只许试 2 次**（不是 4 次），且失败原因要写明「是我方看门狗掐的」。
 * 为什么是 2：一次超时＝一整份回答从头重算（本机实测满预算 155.9 s）；四连超时＝683 s 白等。
 */
export function judgeL9(attempts, errorText) {
  const n = Array.isArray(attempts) ? attempts.length : 0;
  const s = String(errorText ?? '');
  return { ok: n === 2 && s.includes('看门狗'), why: `attempts=${n}（期望 2），error=${s.slice(0, 90)}` };
}

/** L9b：反向对照 —— 同一份判据喂「四次」**必须红**（证明它不是恒真的）。 */
export function judgeL9Four(attempts, errorText) {
  return judgeL9([...attempts, { n: attempts.length + 1 }], errorText);
}

/** L11：`timeoutMs` 与 `maxTokens` 必须成对（120 s 配 12000 就是「给预算又不准花完」）。 */
export function judgeL11(cfg) {
  const t = Number(cfg?.timeoutMs ?? 0);
  const m = Number(cfg?.maxTokens ?? 0);
  const need = Math.max(120_000, m * 20);        // ≈50 tok/s 地板 + 30 s 余量（见 config.mjs）
  return { ok: t >= need, why: `timeoutMs=${t}ms，maxTokens=${m} ⇒ 至少 ${need}ms` };
}

/* ─────────────────────── 样本 ─────────────────────── */

function mkDeep(host = 'api.deepseek.com') {
  const inner = Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), {
    code: 'ENOTFOUND', errno: -3008, syscall: 'getaddrinfo', hostname: host,
  });
  const mid = Object.assign(new Error('connect failed'), { code: 'UND_ERR_CONNECT_TIMEOUT' });
  mid.cause = inner;
  // 三段链：最外层的 fetch failed / 中间层 / 真正的 DNS 那一跳
  return new TypeError('fetch failed', { cause: mid });
}

function mkAggregate() {
  const errors = [
    Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED', address: '127.0.0.1', port: 1 }),
    Object.assign(new Error('connect ECONNREFUSED ::1:1'), { code: 'ECONNREFUSED', address: '::1', port: 1 }),
  ];
  const agg = new AggregateError(errors, 'all attempts failed');
  return new TypeError('fetch failed', { cause: agg });
}

function mkCycle() {
  const a = new Error('a'); const b = new Error('b');
  a.cause = b; b.cause = a;                 // 自引用：没有环检测这里就是死循环
  return a;
}

/* ─────────────────────── 回环假服务器（不花 token） ─────────────────────── */

async function withServer(handler, fn) {
  const srv = http.createServer(handler);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const old = config.llm.baseUrl;
  config.llm.baseUrl = `http://127.0.0.1:${port}`;
  try { return await fn(port); }
  finally {
    config.llm.baseUrl = old;
    // 「永不回话」的服务器（L9 用）在客户端 abort 后要有人收尾，否则 close 会一直等
    srv.closeAllConnections?.();
    await new Promise((r) => srv.close(r));
  }
}

const okBody = JSON.stringify({ choices: [{ message: { role: 'assistant', content: '好' }, finish_reason: 'stop' }],
                                 usage: { prompt_tokens: 3, completion_tokens: 1 } });

/* ─────────────────────── 模式：--probe-badhost ─────────────────────── */

if (process.argv.includes('--probe-badhost')) {
  const old = config.llm.baseUrl;
  config.llm.baseUrl = 'https://no-such-host-dsh-probe.invalid';
  const r = await llm.chat([{ role: 'user', content: 'ping' }], { maxTokens: 8 });
  config.llm.baseUrl = old;
  const last = fs.readFileSync(FAILURES, 'utf8').trim().split('\n').pop();
  const rec = JSON.parse(last);
  const c0 = rec.chain?.[0] ?? {};
  console.log(JSON.stringify({ ok: r.ok, layer: r.layer, chain0: c0, n_attempts: r.attempts?.length,
                               retryable: r.retryable, error: r.error }, null, 2));
  const pass = r.ok === false && r.layer === 'DNS' && c0.layer === 'DNS' && c0.code === 'ENOTFOUND'
            && r.retryable === true;
  console.log(pass ? '✅ 现场探针：失败**真的**落了一行，且层名 = DNS/ENOTFOUND（0 token）'
                   : '❌ 现场探针：层名不是 DNS/ENOTFOUND，或没落盘');
  process.exit(pass ? 0 : 1);
}

/* ─────────────────────── 模式：--controls ─────────────────────── */

if (process.argv.includes('--controls')) {
  const good = llm.describeError(mkDeep());
  const bad1 = { layer: good.layer, chain: good.chain.slice(0, 1) };
  const bad2 = { layer: 'DNS', chain: [{ ...good.chain[0], layer: '未知' }] };
  const cases = [
    ['C1 只读一层 cause → L1 必须红', judgeL1(bad1, 3).ok === false, JSON.stringify(judgeL1(bad1, 3))],
    ['C1b 同一份判据喂**好**样本时必须绿（否则它是恒红的）', judgeL1(good, 3).ok === true, JSON.stringify(judgeL1(good, 3))],
    ['C2 层名映射把 ENOTFOUND 记成「未知」→ L2 必须红', judgeL2(bad2, 'DNS').ok === false, JSON.stringify(judgeL2(bad2, 'DNS'))],
    ['C2b 好样本 L2 必须绿', judgeL2(good, 'DNS').ok === true, JSON.stringify(judgeL2(good, 'DNS'))],
    ['C3 attempts 只留最后一次 → L3 必须红', judgeL3([{ n: 4 }], 4).ok === false, JSON.stringify(judgeL3([{ n: 4 }], 4))],
    ['C3b 四次尝试都在 → L3 必须绿', judgeL3([1, 2, 3, 4].map((n) => ({ n })), 4).ok === true, ''],
    ['C4 成功体里带了 error/chain → L4 必须红', judgeL4({ ok: true, error: 'x', chain: [] }).ok === false, ''],
    ['C4b 干净的成功体 → L4 必须绿', judgeL4({ ok: true, message: {} }).ok === true, ''],
    ['C5 环检测：自引用的 cause 不许把判据打死', (() => {
        const d = llm.describeError(mkCycle());
        return d.chain.length > 0 && d.chain.length <= 6;
      })(), ''],
    // ★ 2026-10-26 加的这三条：把「超时/20」与「超时试 4 次」两个缺陷各造一遍，判据必须精确变红
    ['C6 数字码不归一（`code:20`）→ L8 必须红',
      judgeL8({ layer: '超时', summary: '超时/20 · 1 跳 :: This operation was aborted',
                chain: [{ code: 20, layer: '超时' }] }).ok === false,
      JSON.stringify(judgeL8({ layer: '超时', summary: '超时/20 · 1 跳', chain: [{ code: 20 }] }))],
    ['C6b 归一之后（ABORT_ERR）→ L8 必须绿',
      judgeL8({ layer: '超时', summary: '超时/ABORT_ERR · 1 跳 :: This operation was aborted',
                chain: [{ code: 'ABORT_ERR', layer: '超时' }] }).ok === true, ''],
    ['C7 超时试 4 次 → L9 必须红（旧行为必须被这把尺子挡住）',
      judgeL9Four([{ n: 1 }, { n: 2 }, { n: 3 }], '超时 层失败（我方 300 秒看门狗掐断）').ok === false, ''],
    ['C7b 超时试 2 次 + 写明看门狗 → L9 必须绿',
      judgeL9([{ n: 1 }, { n: 2 }], '超时 层失败（我方 300 秒看门狗掐断）：超时/ABORT_ERR').ok === true, ''],
    ['C8 maxTokens=12000 配 timeoutMs=120000 → L11 必须红（事故当天的原值）',
      judgeL11({ timeoutMs: 120_000, maxTokens: 12_000 }).ok === false,
      JSON.stringify(judgeL11({ timeoutMs: 120_000, maxTokens: 12_000 }))],
    ['C8b maxTokens=12000 配 timeoutMs=270000 → L11 必须绿',
      judgeL11({ timeoutMs: 270_000, maxTokens: 12_000 }).ok === true, ''],
  ];
  let nf = 0;
  for (const [name, ok, detail] of cases) {
    if (!ok) nf++;
    console.log(`  ${ok ? '✅' : '❌'} ${name}${ok ? '' : `  ← ${detail}`}`);
  }
  console.log(`\n${nf ? '❌' : '✅'} 反向对照 ${cases.length - nf}/${cases.length} 项通过`);
  process.exit(nf ? 1 : 0);
}

/* ─────────────────────── 默认：L1–L5 ─────────────────────── */

console.log('L1–L5：失败描述（离线；只用本机回环）\n');

// L1 真实事件回归：15:32 那次那一句的形状
const deep = llm.describeError(mkDeep());
T('L1 链走到最深（三跳都留着）', judgeL1(deep, 3).ok, judgeL1(deep, 3).why);
T('L5 真实事件回归：摘要里答得出 ENOTFOUND / getaddrinfo / 主机名', judgeL5(deep).ok, judgeL5(deep).why);
T('L2 层名 = DNS，且 chain[0].layer 同值', judgeL2(deep, 'DNS').ok, judgeL2(deep, 'DNS').why);
T('L2b 双栈 AggregateError.errors 也要展开（ECONNREFUSED → TCP）',
  judgeL2(llm.describeError(mkAggregate()), 'TCP').ok,
  judgeL2(llm.describeError(mkAggregate()), 'TCP').why);
T('L2c 自引用的 cause 不许死循环（环检测）',
  (() => { const d = llm.describeError(mkCycle()); return d.chain.length > 0 && d.chain.length <= 6; })(),
  'chain 长度 ≤ 6');

// 层名映射（每一条都要有对象，且不认识的不许硬凑）
const MAP = [['ENOTFOUND', 'DNS'], ['EAI_AGAIN', 'DNS'], ['ECONNREFUSED', 'TCP'], ['ECONNRESET', 'TCP'],
             ['CERT_HAS_EXPIRED', 'TLS'], ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'TLS'],
             ['UND_ERR_CONNECT_TIMEOUT', '超时'], ['UND_ERR_HEADERS_TIMEOUT', '超时']];
const mapBad = MAP.filter(([c, l]) => llm.layerOfCode(c) !== l);
T('L2d 层名映射表逐条对得上', mapBad.length === 0, JSON.stringify(mapBad));
T('L2e 不认识的 code 回 null（不许硬凑成某一层）', llm.layerOfCode('WHO_KNOWS') === null, 'null');

// L4 + HTTP 层：本机回环，成功与 401
async function httpCases() {
  const ok = await withServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(okBody);
  }, () => llm.chat([{ role: 'user', content: 'ping' }], { maxTokens: 8 }));
  T('L4 成功路径不产出 error/chain/attempts', judgeL4(ok).ok, judgeL4(ok).why);
  T('L4b 成功路径照常回正文', ok.message?.content === '好', JSON.stringify(ok.message));

  const n0 = fs.existsSync(FAILURES) ? fs.readFileSync(FAILURES, 'utf8').trim().split('\n').filter(Boolean).length : 0;
  T('L4c 成功**不落**失败记录（llm_failures.jsonl 没有新增）',
    n0 === 0, `此刻失败记录 ${n0} 行`);

  const r401 = await withServer((req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'invalid_api_key', message: 'Authentication Fails' } }));
  }, () => llm.chat([{ role: 'user', content: 'ping' }], { maxTokens: 8 }));
  T('L2f HTTP 401 → layer=HTTP 且 chain[0].layer=HTTP', judgeL2(r401, 'HTTP').ok, judgeL2(r401, 'HTTP').why);
  T('L6 HTTP 401 **不可重试**（补发 5 次也是白试 → 不入队）', r401.retryable === false, `retryable=${r401.retryable}`);
  T('L3b 不可重试的失败只尝试 1 次', judgeL3(r401.attempts, 1).ok, judgeL3(r401.attempts, 1).why);

  const t0 = Date.now();
  const r500 = await withServer((req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'server_error', message: 'boom' } }));
  }, () => llm.chat([{ role: 'user', content: 'ping' }], { maxTokens: 8 }));
  T('L3 重试耗尽：四次尝试的错**都留着**（原先只剩最后一次）',
    judgeL3(r500.attempts, 4).ok, `${judgeL3(r500.attempts, 4).why}（耗时 ${Date.now() - t0}ms）`);
  T('L6b HTTP 5xx **可重试**（网络恢复后值得补）', r500.retryable === true, `retryable=${r500.retryable}`);
  T('L2g HTTP 5xx 的层名也是 HTTP', judgeL2(r500, 'HTTP').ok, judgeL2(r500, 'HTTP').why);
}

await httpCases();

// 落盘：失败**恰好一行**，且那一行的 chain[0].layer 在册（计划 §1.3 的那条探针）
const lines = fs.readFileSync(FAILURES, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const badLayer = lines.filter((r) => !llm.LAYERS.includes(r.chain?.[0]?.layer));
T('L7 失败落盘：每次失败**恰好一行**（401 一行 + 500 一行 = 2）', lines.length === 2, `实测 ${lines.length} 行`);
T('L7b 每行都有 chain[0].layer，且都在封闭集合里', badLayer.length === 0,
  badLayer.length ? JSON.stringify(badLayer[0]) : '全在册');
T('L7c 行里带 attempts / model / key_fp，且**不含密钥原文**',
  lines.every((r) => Array.isArray(r.attempts) && r.model && /^[0-9a-f]{8}$/.test(r.key_fp ?? ''))
  && !JSON.stringify(lines).includes(config.llm.apiKey ?? '\u0000'),
  'key_fp 只有 8 位指纹');

/* ─────────── 2026-10-26 加：超时这一类的三处判据（L8 / L9 / L11） ───────────
 *
 * 事故：群里问「你好」，683 秒后回「我这边调用模型失败了 … 超时/20 · 1 跳」。
 * 三个缺陷各对应一条：
 *   L8 —— 数字码 `20` 原样进了失败原因（人读不懂、也不在 code 封闭集合里）；
 *   L9 —— 超时重试 4 次，每次都是一整份回答从头重算（683 s 全部白等）；
 *   L11 —— `timeoutMs`（写死 120 s）与 `maxTokens`（12000，实测需 155.9 s）从来没人一起算过。
 *
 * 全部离线：L9 打的是本机一个**永不回话**的 http 服务器（1.1 s 收工），不花 token。
 */

// L8：数字码归一名
const abortDom = Object.assign(new Error('This operation was aborted'), { name: 'AbortError', code: 20 });
const dAbort = llm.describeError(abortDom);
T('L8 `AbortError` 的数字码 20 → `ABORT_ERR`，层名仍是超时（群里不许再出现「超时/20」）',
  judgeL8(dAbort).ok, judgeL8(dAbort).why);
T('L8b 映射表两边都认（`layerOfCode("ABORT_ERR")` 与数字码归一后同值）',
  llm.layerOfCode('ABORT_ERR') === '超时' && llm.layerOfCode('TIMEOUT_ERR') === '超时',
  `ABORT_ERR=${llm.layerOfCode('ABORT_ERR')}｜TIMEOUT_ERR=${llm.layerOfCode('TIMEOUT_ERR')}`);

// L9：超时只试 2 次，且失败原因写明「我方看门狗掐断」
const hangSrv = await withServer(() => { /* 永不回话：客户端只能被自己的看门狗掐死 */ },
  () => llm.chat([{ role: 'user', content: 'ping' }], { maxTokens: 8, timeoutMs: 120 }));
T('L9 我方看门狗超时 ⇒ 只试 2 次（不是 4 次），且原因写明看门狗',
  judgeL9(hangSrv.attempts, hangSrv.error).ok,
  `${judgeL9(hangSrv.attempts, hangSrv.error).why}｜layer=${hangSrv.layer}`);
T('L9c 失败体照旧可重试（超时是「过一会儿也许就通」的那一类 ⇒ 补发队列该收）',
  hangSrv.retryable === true, `retryable=${hangSrv.retryable}`);
T('L9d 超时那一行也落了盘，且 attempts 只有 2 条（4 条即旧行为）',
  (() => {
    const last = JSON.parse(fs.readFileSync(FAILURES, 'utf8').trim().split('\n').pop());
    return last.n_attempts === 2 && last.layer === '超时' && last.attempts.every((a) => a.watchdog_ms === 120);
  })(), 'n_attempts 必须是 2、watchdog_ms 必须是 120');

// L11：超时与预算成对
T('L11 `timeoutMs` 必须够满预算花完（120 s 配 12000 tok 就是结构性必超时）',
  judgeL11(config.llm).ok, judgeL11(config.llm).why);
const banner = (await import('./config.mjs')).describeConfig();
T('L11b 启动横幅里两者并排可见（只有 maxTokens 没有 timeout ⇒ 没人算得出这条矛盾）',
  typeof banner.maxTokens === 'number' && typeof banner.llmTimeoutMs === 'string'
  && banner.llmTimeoutMs.includes(String(config.llm.timeoutMs)),
  `banner.maxTokens=${banner.maxTokens}｜banner.llmTimeoutMs=${banner.llmTimeoutMs}`);


// 单次语义复核不能在返回失败后遗留内部重试；三种失败均须遵守调用方上限。
for (const [name, handler, options] of [
  ['HTTP 500', (_req, res) => { res.writeHead(500); res.end('{"error":"fixture"}'); }, {}],
  ['transport', (req) => { req.socket.destroy(); }, {}],
  ['timeout', () => {}, { timeoutMs: 60 }],
]) {
  let requests = 0;
  const result = await withServer((req, res) => { requests++; handler(req, res); },
    () => llm.chat([{ role: 'user', content: 'single attempt' }], { maxTokens: 8, maxAttempts: 1, ...options }));
  T(`L12 maxAttempts=1：${name}只能发出一次请求`,
    result.ok === false && requests === 1 && result.attempts?.length === 1,
    `requests=${requests} attempts=${result.attempts?.length}`);
}

// 调用方只能收紧已有重试上限，不得扩大。
let cappedRequests = 0;
const capped = await withServer((_req, res) => {
  cappedRequests++;
  // 第五次若真的发出就回成功，避免反向对照以指数退避跑满 99 次。
  res.writeHead(cappedRequests <= 4 ? 500 : 200, { 'Content-Type': 'application/json' });
  res.end(cappedRequests <= 4 ? '{"error":"fixture"}' : okBody);
}, () => llm.chat([{ role: 'user', content: 'bounded retries' }], { maxTokens: 8, maxAttempts: 99 }));
T('L12b maxAttempts只能减少尝试次数，99不得突破既有4次上限',
  capped.ok === false && cappedRequests === 4 && capped.attempts?.length === 4,
  `requests=${cappedRequests} ok=${capped.ok}`);

// 显式路由的失败留痕必须指向实际端点/密钥指纹，不能记成默认聊天端点。
const routeKey = 'fixture-route-key-only';
await withServer((_req, res) => { res.writeHead(401); res.end('{"error":"fixture auth"}'); }, async (port) => {
  const actualBase = `http://127.0.0.1:${port}`;
  config.llm.baseUrl = 'http://127.0.0.1:1/default-not-used';
  await llm.chat([{ role: 'user', content: 'route diagnostic' }],
    { baseUrl: actualBase, apiKey: routeKey, maxTokens: 8, maxAttempts: 1 });
  const last = JSON.parse(fs.readFileSync(FAILURES, 'utf8').trim().split('\n').pop());
  T('L13 显式路由失败记录使用实际端点及调用密钥指纹',
    last.base_url === actualBase && last.key_fp === createHash('sha256').update(routeKey).digest('hex').slice(0, 8),
    '路由诊断错指默认配置');
});

// 判据自己不许撒谎：上面的每一项都真的跑过
const nFail = results.filter((r) => !r.ok).length;
for (const r of results) console.log(`  ${r.ok ? '✅' : '❌'} ${r.id}${r.ok ? '' : `  ← ${r.detail}`}`);
console.log(`\n${nFail ? '❌' : '✅'} llm_errors ${results.length - nFail}/${results.length} 项通过`
            + `（临时目录 ${path.basename(TMP)}；真 llm_failures.jsonl 未被触碰）`);
process.exit(nFail ? 1 : 0);

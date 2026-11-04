#!/usr/bin/env node
/**
 * kb_client.test.mjs —— 知识库接入的四条约束，各自的**执行点**在哪一行
 *
 * ── 为什么要有它（`AGENTS.md` §2.4：写进文档的约束必须指得出哪一行在拦它）
 *
 * 接入一个**外部**只读接口，最危险的不是连不上，是**把「没查成」讲成「没命中」**。
 * 守衡一旦把一次 429/断网说成「知识库里没有这条」，那就是一次假阴性合规结论 ——
 * 比不答更糟。所以下面每一条断言，验的都是「失败时说的是不是人话」。
 *
 * ── 它验五类，缺一类这条接入就还是半条
 *
 *   A. **凭据**：能装、不吐明文、缺了/坏了要说得出补救办法。
 *   B. **排序判据**（纯函数）：查询词 <3 字时顺序不可信 —— 而**默认安全侧必须是「不可信」**。
 *   C. **输入合法性**：空 query / 空格 query 必须当场拒，不发请求。
 *   D. **配额**：余额的**唯一来源**是服务端响应里的 `quota` 字段
 *      （usedPerDay / usedPerMinute）。2026-09-28 实测：本地数出 used=41，
 *      服务端真值 292 —— 差 7 倍，因为客户端只看得见自己，服务端数的是**所有调用方**。
 *      所以这一段钉的是「不许自己数」：旧格式本地账本要被当作不认识，
 *      余额未知时要说「未知」而不是 0，快照要跨进程活着。
 *   E. **工具契约**：凭据不可用时 `kb_search` 必须返回 `is_untested:true`，
 *      而不是一个空的 hits 数组 —— 后者会被读成「查过了，没有」。
 *   G. **版本判据**：`contentHash` 才是「库有没有更新」的信号
 *      （内容变才变、重同步但内容没变则不变）；`createdAt` 是**首次镜像时刻、
 *      永不改变**，不许进指纹。
 *
 * ── 全程离线、不联网、不碰真凭据
 *
 * 用一个 base_url 指向 `http://127.0.0.1:9`（必然连不上）的**假凭据**，
 * 以及一个临时 STATE_DIR。真凭据文件、真配额账本、真知识库**一次都没被碰过**。
 *
 * 用法：node tools/agent/kb_client.test.mjs
 * 退出码：0 全过 ｜ 1 有红
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/* ── 先建一个全隔离的环境，再 import 任何东西 ───────────────────────────
   config.mjs 的 STATE_DIR 是在 import 期算出来的，所以环境变量必须在 import 之前设好。
   （这正是 config.mjs 里那段注释说的「写成 import 时常量，后面再改就没效果」。）      */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'kb_test_'));
const FAKE_CRED = path.join(SANDBOX, 'fake-kb.json');
fs.writeFileSync(FAKE_CRED, JSON.stringify({
  base_url: 'http://127.0.0.1:9',        // 必然连不上，任何真网络调用都会当场失败
  api_key: 'wbk_TESTONLY_0000000000000000000000000000000000',
}), 'utf8');

process.env.SHOUHENG_STATE_DIR = path.join(SANDBOX, 'state');
process.env.SHOUHENG_KB_CRED_PATH = FAKE_CRED;

const kb = await import('./kb_client.mjs');
const { executeTool, toolNames } = await import('./tools.mjs');
const { secretPathHit } = await import('./tools.mjs');

const res = [];
const T = (name, ok, detail) => res.push({ name, ok, detail: detail ?? '' });

/* ── A 凭据 ────────────────────────────────────────────────────────── */

const d = kb.describeKb();
T('A1 假凭据能装载（base_url 生效）', d.baseUrl === 'http://127.0.0.1:9', JSON.stringify(d));
T('A2 describeKb 不含 key 明文', !JSON.stringify(d).includes('wbk_TESTONLY'), JSON.stringify(d));
T('A3 describeKb 只露尾部 6 位（够核对、不够复原）',
  typeof d.keyTail === 'string' && d.keyTail.length === 6, String(d.keyTail));

// A4 路径不存在 → 说的是人话，且指出两条补救途径
{
  const saved = process.env.SHOUHENG_KB_CRED_PATH;
  process.env.SHOUHENG_KB_CRED_PATH = path.join(SANDBOX, 'nope.json');
  const m = await import(`./kb_client.mjs?missing=${Date.now()}`);
  let msg = '';
  try { m.loadCred(); } catch (e) { msg = e.message; }
  T('A4 凭据文件不存在 → 报错点名路径 + 给出两条补救途径',
    msg.includes('nope.json') && msg.includes('SHOUHENG_KB_BASE_URL'), msg.slice(0, 160));
  process.env.SHOUHENG_KB_CRED_PATH = saved;
}

// A5 字段不全 → 点名缺什么
{
  const bad = path.join(SANDBOX, 'partial.json');
  fs.writeFileSync(bad, JSON.stringify({ base_url: 'http://127.0.0.1:9' }), 'utf8');
  const saved = process.env.SHOUHENG_KB_CRED_PATH;
  process.env.SHOUHENG_KB_CRED_PATH = bad;
  const m = await import(`./kb_client.mjs?partial=${Date.now()}`);
  let msg = '';
  try { m.loadCred(); } catch (e) { msg = e.message; }
  T('A5 凭据字段不全 → 点名缺 base_url / api_key',
    msg.includes('base_url') && msg.includes('api_key'), msg.slice(0, 160));
  process.env.SHOUHENG_KB_CRED_PATH = saved;
}

// A6 不是合法 JSON → 说得出是格式问题，而不是伪装成「没配」
{
  const bad = path.join(SANDBOX, 'notjson.json');
  fs.writeFileSync(bad, '{ this is not json', 'utf8');
  const saved = process.env.SHOUHENG_KB_CRED_PATH;
  process.env.SHOUHENG_KB_CRED_PATH = bad;
  const m = await import(`./kb_client.mjs?notjson=${Date.now()}`);
  let msg = '';
  try { m.loadCred(); } catch (e) { msg = e.message; }
  T('A6 凭据不是合法 JSON → 报「不是合法 JSON」（不伪装成「没配」）',
    msg.includes('不是合法 JSON'), msg.slice(0, 160));
  process.env.SHOUHENG_KB_CRED_PATH = saved;
}

/* ── B 排序判据：默认安全侧必须是「不可信」 ───────────────────────────── */

T('B1 scoreKind=bm25 → 顺序可信（查询词 ≥3 字走这条，实测 score 是真的 BM25）',
  kb.orderIsMeaningful('bm25') === true, '');
T('B2 scoreKind=positional → 顺序**不可信**（查询词 <3 字走 like 回退，score 是词频）',
  kb.orderIsMeaningful('positional') === false, '');
T('B3 ★ null → 不可信（拿不到 scoreKind 时必须保守）',
  kb.orderIsMeaningful(null) === false, '');
T('B4 ★ undefined → 不可信', kb.orderIsMeaningful(undefined) === false, '');
T('B5 ★ 大小写变体 "BM25" → 不可信（判据不做善意容错：认错一个字就是错判一批）',
  kb.orderIsMeaningful('BM25') === false, '');
T('B6 ★ 没见过的引擎 "cosine" → 不可信（未来服务端换实现，默认掉进安全侧）',
  kb.orderIsMeaningful('cosine') === false, '');

/* ── B7–B12 分叉轴是「查询词长度」不是语言（2026-09-28 服务端口径纠正后补） ──
   实测：q=吸奶器(3字)→bm25；q=pain(4)→bm25；q=无痛(2)→positional；q=no(2)→positional。
   旧版注释写成「中文没有排序」，会让人把 3 字中文的 bm25 结果也当不可信 —— 那是错的。 */

T('B7 ★ 中文 3 字查询的提示里不再出现「中文」这个错因（分叉轴是长度）',
  !kb.rankingCaveat('bm25').includes('中文'), kb.rankingCaveat('bm25'));
T('B8 bm25 的提示明确说「顺序可用」',
  kb.rankingCaveat('bm25').includes('顺序可用来挑最相关的几条'), '');
T('B9 ★ positional 的提示说清了「3 个字符」这个真因，并给出改写建议',
  kb.rankingCaveat('positional').includes('不足 3 个字符')
  && kb.rankingCaveat('positional').includes('≥3 个字'), '');
T('B10 positional 的 score 含义是「词频」而不是「序号」',
  kb.scoreMeaning('positional').includes('词频') && !kb.scoreMeaning('positional').includes('序号'),
  kb.scoreMeaning('positional'));
T('B11 ★ 查询词长度按码点算：「无痛」=2 给提示、「吸奶器」=3 不给、英文 "no"=2 也给',
  kb.queryLengthHint('无痛') !== null
  && kb.queryLengthHint('吸奶器') === null
  && kb.queryLengthHint('pain') === null
  && kb.queryLengthHint('no') !== null, '');
T('B12 长度提示里带上了原查询词与建议（模型看完知道该怎么改）',
  kb.queryLengthHint('无痛').includes('无痛分娩'), kb.queryLengthHint('无痛').slice(0, 80));

/* ── B13–B15 免费探活不许记账（本地闸门不能比真配额早用尽） ──────────────
   服务端的 GET /health 免鉴权、不消耗配额；但客户端每个 request() 都会给日账本 +1。
   若探活也走 request()，就等于**自己把自己的 1000/天 吃掉一部分**。
   这里用假凭据（base_url=127.0.0.1:9，必然连不上）证：探活失败得干净、且不写账本。  */

{
  const before = kb.quotaState().used;
  const p = await kb.ping();
  const after = kb.quotaState().used;
  T('B13 ★ ping 连不上时 ok=false 且 quotaCost=0（探活不该动配额）',
    p.ok === false && p.quotaCost === 0, JSON.stringify(p).slice(0, 170));
  T('B14 ★ ping 失败不写本地账本（否则 1000/天 会被免费探活吃掉）',
    before === after, `账本 used: ${before} → ${after}`);
  const h = await kb.healthCheck();
  T('B15 ★ healthCheck 第 0 步是免费探活（不是拿一次检索去试）',
    String(h.steps?.[0]?.step ?? '').includes('探活'), JSON.stringify(h.steps?.[0] ?? null).slice(0, 120));
}

/* ── C 输入校验（不联网就能证） ───────────────────────────────────────── */

{
  let code = '';
  try { await kb.retrieve('3_措辞表达库', ''); } catch (e) { code = e.code; }
  T('C1 空 query → BAD_REQUEST（在发请求之前就拦掉）', code === 'BAD_REQUEST', code);
}
{
  let code = '';
  try { await kb.retrieve('3_措辞表达库', '   '); } catch (e) { code = e.code; }
  T('C2 纯空格 query → BAD_REQUEST', code === 'BAD_REQUEST', code);
}

/* ── D 配额：只信服务端回报，不自己数 ─────────────────────────────────────
   这一段的形状由 2026-09-28 的实测决定：客户端本地数出 used=41，
   服务端同日回报 quota.usedPerDay=292。差 7 倍的原因不是算错，是**口径不同** ——
   客户端只看得见守衡自己发的请求，服务端数的是**所有调用方**。
   所以下面每一条都在钉同一件事：余额的来源只能是响应里的 quota 字段。      */

// D1 全新环境：还没收到过任何服务端回报 → 余额「未知」，而不是 0
{
  const s = kb.quotaState();
  T('D1 ★ 未收到服务端回报时 source=none 且 usedPerDay=null（未知 ≠ 0）',
    s.source === 'none' && s.usedPerDay === null && s.remaining === null,
    JSON.stringify(s));
  T('D2 ★ quotaState 不再提供 `used` 别名（别名正是把 41 当余额的入口）',
    !('used' in s), Object.keys(s).join(','));
}

// D3 断言的是**路径这条约束**，不是「文件此刻存在」——
//    第一版写成 existsSync 是错的：那一刻还没花过配额，账本本来就不该存在，
//    断言它的存在等于把「还没写过」误判成「路径没跟着走」。
T('D3 ★ 配额快照路径落在 SHOUHENG_STATE_DIR 下（惰性解析，不是 import 期定死）',
  kb.quotaPath() === path.join(process.env.SHOUHENG_STATE_DIR, 'kb_quota.json'),
  kb.quotaPath());

// D4 ★★ 旧格式的本地账本**不许**被当成真值 —— 这是本次修正的核心断言
{
  const p = path.join(process.env.SHOUHENG_STATE_DIR, 'kb_quota.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ date: '2026-09-28', used: 41 }), 'utf8');
  const fresh = await import(`./kb_client.mjs?legacy=${Date.now()}`);
  const s = fresh.quotaState();
  T('D4 ★★ 旧格式本地账本 {date,used:41} 被当作「不认识」→ source=none（不再拿本地数当真值）',
    s.source === 'none' && s.usedPerDay === null, JSON.stringify(s));
}

// D5 ★★ 吸收服务端回报：字段名直接照抄服务端，余额按 limitPerDay - usedPerDay 算
{
  const rec = kb.absorbQuota({
    requestId: 'req-D5',
    quota: { limitPerMinute: 60, limitPerDay: 1000, usedPerMinute: 0, usedPerDay: 292 },
  });
  const s = kb.quotaState();
  T('D5 ★★ absorbQuota 吸收响应里的 quota（usedPerDay=292，不是本地数的 41）',
    s.source === 'server' && s.usedPerDay === 292 && s.limitPerDay === 1000,
    JSON.stringify(s));
  T('D6 ★ remaining = limitPerDay - usedPerDay（708），且带上 asOf 供审计',
    s.remaining === 708 && typeof s.asOf === 'string' && s.via_request === 'req-D5',
    JSON.stringify(s));
  T('D7 ★ usedPerMinute 原样透传（本地数不出全调用方的分钟用量）',
    s.usedPerMinute === 0 && s.limitPerMinute === 60, JSON.stringify(s));
  T('D8 absorbQuota 对没有 quota 字段的响应**什么都不做**（不清零、不猜）',
    rec !== null && kb.absorbQuota({ hits: [] }) === null
      && kb.quotaState().usedPerDay === 292, JSON.stringify(kb.quotaState()));
}

// D9 ★ 跨进程：守衡是被 launchd 拉起的守护进程，会重启 ——
//    重启后不许「忘记」余额，所以快照必须落盘、且新进程读得到。
{
  const p = path.join(process.env.SHOUHENG_STATE_DIR, 'kb_quota.json');
  const out = execFileSync(process.execPath, [
    path.join(HERE, 'kb_client.mjs'), 'quota',
  ], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' });
  const j = JSON.parse(out);
  T('D9 ★★ 跨进程可见：另一个 node 进程读到服务端快照 usedPerDay=292',
    j.usedPerDay === 292 && j.source === 'server', out.trim().slice(0, 160));
  T('D10 快照文件里存的是服务端口径（有 source/usedPerDay，没有 used）',
    (() => {
      const onDisk = JSON.parse(fs.readFileSync(p, 'utf8'));
      return onDisk.source === 'server' && onDisk.usedPerDay === 292 && !('used' in onDisk);
    })(), fs.readFileSync(p, 'utf8').slice(0, 160));
}

// D11 服务端回报「已满」→ canSpend=false
{
  kb.absorbQuota({ requestId: 'req-D11',
    quota: { limitPerMinute: 60, limitPerDay: 1000, usedPerMinute: 3, usedPerDay: 1000 } });
  T('D11 服务端回报 usedPerDay=1000 → canSpend(1) 为 false',
    kb.canSpend(1) === false, JSON.stringify(kb.quotaState()));
}

// D12 ★ 已满时 retrieve 抛 QUOTA_EXHAUSTED，且**不发网络请求**
//     （base_url 是连不上的假地址：如果它真去连了，抛出的会是 NETWORK 而不是
//      QUOTA_EXHAUSTED —— 这一条能区分「闸门拦住了」和「它压根没拦，只是网断了」）
{
  let code = '';
  try { await kb.retrieve('3_措辞表达库', 'pain'); } catch (e) { code = e.code; }
  T('D12 ★ 配额已满 → QUOTA_EXHAUSTED（不是 NETWORK：证明它发请求前就拦住了）',
    code === 'QUOTA_EXHAUSTED', code);
}

/* ── G 版本判据：contentHash，不是 createdAt ──────────────────────────────
   2026-09-28 对端确认：createdAt 是**子库第一次被镜像进来**的时刻，
   此后**永不改变**；判「库有没有更新」要用它旁边的 contentHash ——
   内容真变了才变，重新同步一遍而内容没变则不变。                          */

{
  const base = [{ id: 'A', docCount: 509, contentHash: 'h1', createdAt: 111 }];
  const sameHash = [{ id: 'A', docCount: 509, contentHash: 'h1', createdAt: 999 }];
  const newHash = [{ id: 'A', docCount: 509, contentHash: 'h2', createdAt: 111 }];
  const moreDocs = [{ id: 'A', docCount: 510, contentHash: 'h2', createdAt: 111 }];

  T('G1 ★ contentHash 变了 → 指纹变（库真更新了）',
    kb.versionFingerprint(base) !== kb.versionFingerprint(newHash),
    kb.versionFingerprint(newHash));
  T('G2 ★★ createdAt 变了但 contentHash 没变 → 指纹**不变**' +
    '（重同步但内容没变；这也证明 createdAt 没被写进指纹）',
    kb.versionFingerprint(base) === kb.versionFingerprint(sameHash),
    kb.versionFingerprint(sameHash));
  T('G3 docCount 变了 → 指纹也变（条数增减是另一种更新）',
    kb.versionFingerprint(base) !== kb.versionFingerprint(moreDocs),
    kb.versionFingerprint(moreDocs));
  T('G4 对端没给 contentHash → 记 NO_HASH（退回只看 docCount，必须说出来）',
    kb.versionFingerprint([{ id: 'A', docCount: 1 }]).includes('NO_HASH'),
    kb.versionFingerprint([{ id: 'A', docCount: 1 }]));
  T('G5 指纹与子库顺序无关（排序后拼接）',
    kb.versionFingerprint([{ id: 'B', docCount: 1, contentHash: 'x' },
                           { id: 'A', docCount: 2, contentHash: 'y' }])
    === kb.versionFingerprint([{ id: 'A', docCount: 2, contentHash: 'y' },
                               { id: 'B', docCount: 1, contentHash: 'x' }]), '');
}

/* ── E 工具契约：未查成 ≠ 没命中 ─────────────────────────────────────── */

const names = toolNames();
T('E1 kb_search 已注册', names.some((n) => n.startsWith('kb_search(')), names.filter((n) => n.startsWith('kb_')).join(' '));
T('E2 kb_status 已注册', names.some((n) => n.startsWith('kb_status(')), '');
T('E3 ★ 两个新工具都是 scope=read（只发外部只读 GET，不写业务数据）',
  names.includes('kb_search(read)') && names.includes('kb_status(read)'), '');

// E4 ★★ 本文件最要紧的一条：配额用尽时，kb_search 必须说「我没查成」
{
  const r = await executeTool('kb_search', { query: '无痛' });
  T('E4 ★★ 配额用尽时 kb_search 返回 is_untested=true（而不是空 hits）',
    r.ok === true && r.result?.is_untested === true, JSON.stringify(r).slice(0, 200));
  T('E5 ★★ 并且**不含**任何 hits 字段 —— 空数组会被读成「查过了，没有」',
    r.result?.hits === undefined, JSON.stringify(r.result).slice(0, 160));
  T('E6 话术里明确写了「不是没命中」',
    /不是「没有命中」/.test(String(r.result?.note ?? '')), String(r.result?.note ?? '').slice(0, 120));
}

// E7 配额用尽时 kb_status 仍要说得清「是配额问题，不是配置问题」
{
  const r = await executeTool('kb_status', {});
  T('E7 kb_status 报 connected=false 且带上原因',
    r.ok === true && r.result?.connected === false && typeof r.result?.error === 'string',
    JSON.stringify(r.result).slice(0, 180));
}

/* ── F 安全：新凭据文件必须落在既有闸门之内 ─────────────────────────── */

T('F1 ★ 新凭据 shouheng-kb.json 被既有 secretPathHit 拦住（守衡读不到自己的凭据）',
  secretPathHit(path.join(os.homedir(), '.dsh', 'credentials', 'shouheng-kb.json')) !== null, '');
T('F2 ★ 反向对照：仓内普通文件**不**被拦（否则这道闸门把日常读能力一起关了）',
  secretPathHit('tools/agent/kb_client.mjs') === null, '');

/* ── 出口 ───────────────────────────────────────────────────────────── */
const nFail = res.filter((x) => !x.ok).length;
for (const x of res) console.log(`  ${x.ok ? '✅' : '❌'} ${x.name}${x.ok || !x.detail ? '' : `  ← ${x.detail}`}`);
console.log(`\n${nFail ? '❌' : '✅'} kb_client 自证 ${res.length - nFail}/${res.length} 项通过`);
console.log(`   （全程离线；假凭据 base_url=http://127.0.0.1:9，临时目录 ${SANDBOX}）`);
console.log('   （真凭据、真配额账本、真知识库**一次都没被碰过**）');
try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
process.exit(nFail ? 1 : 0);

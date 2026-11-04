/**
 * ext_basis.mjs —— 给**模型侧**条目挂一条**可核的依据链接**。
 *
 * ── 病（Owner 2026-10-13 原话）────────────────────────────────────────────
 *   「模型侧输出的问题，需要带上依据。写**无库内依据**，那就放模型侧能查到的依据链接」
 *   现状：模型侧条目只印一句「无库内依据」（`dual_track.renderMergedItem`）——
 *   给了结论、没给任何**可核**的东西，读的人只能选择信或不信。
 *
 * ── 三条纪律（每一条都对应这仓里已经付过代价的裁定）──────────────────────
 *   ① **模型不许写 URL。** 幻觉链接比空格更坏（P0 报告那条原话：「一个点不开的链接
 *      比空格更坏」）—— 所以模型这一侧只**从已登记来源里挑 id**，链接由代码挂。
 *   ② 来源表 = `research/kb/外部标准库-v1.json` 的 `sources`（17 个来源、62 条条款），
 *      它每天被 `tools/verify_external.py` 复核（引文逐字对得上才算数）。
 *   ③ 挑不出 / 挑了个不在表里的 id ⇒ **如实说没有**，不许凑一个「最像的」。
 *      这一条的执行点是 `basisText()` 的 `cited`：只有真解析出来源才给链接。
 *
 * 自证：`node tools/agent/ext_basis.mjs --selftest`（判据 + 反向对照，离线）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT } from './config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const EXT_JSON = path.join(path.dirname(HERE), '..', 'research/kb/外部标准库-v1.json');

let _cache = null;
function load() {
  if (_cache) return _cache;
  const d = JSON.parse(fs.readFileSync(EXT_JSON, 'utf8'));
  _cache = { sources: d.sources ?? [], entries: d.entries ?? [] };
  return _cache;
}

/** 给提示词用的**闭集**：模型只能从这 17 个里挑（id + 机构 + 文档名，**不给 URL**）。 */
export function sourceChoices() {
  return load().sources.map((s) => ({ id: s.id, org: s.机构, doc: s.文档, url: s.url,
                                      jurisdiction: s.辖区 ?? null, tier: s.辖区层级 ?? null }));
}

/**
 * ★★ 2026-10-16（Owner 追问「**目前模型侧是按照下面的美国区来跑的吗？**」）——
 * **递到模型面前的菜单只列美国来源**。
 *
 * 病灶：登记表 17 条里有 **2 条是英国的**（`S15` MHRA、`S16` ASA/CAP），而模型侧提示词
 * 第 7 条（2026-10-14 加）明写「**不得援引非美国市场的合规要求**……英国 MHRA / ASA-CAP
 * **都不是本项目的判据**」——**规矩与菜单打架**：规矩说不许引，菜单却把这两个 id 递到它面前。
 * 实测当时**还没被引用过**（写回台账里 `"S15"/"S16"` **0 次**、报告/表里 `MHRA`/`CAP Code`
 * **0 命中**）⇒ 是**隐患**、不是已发生的错；但「还没出事」不是不修的理由，菜单就是它能挑的东西。
 *
 * 判据落在**数据**上，不在代码里写死 id 名单：`外部标准库-v1.json` 的 `sources[].辖区`
 * （2026-10-16 逐条标注：`US` × **15** ＝ 联邦监管 4 ＋ 平台政策 11；`UK` × 2）。
 * 以后新增来源**必须带辖区** —— 缺字段的会被自证逮住（见 `selftest` 的「缺辖区」那条）。
 */
export function usSourceChoicesOf(sources) {
  return (sources ?? []).filter((s) => (s.辖区 ?? s.jurisdiction) === 'US')
                        .map((s) => ({ id: s.id, org: s.机构, doc: s.文档, url: s.url,
                                       jurisdiction: 'US', tier: s.辖区层级 ?? null }));
}

/** 被挡在菜单外的（非美国）——**不是不存在，是不进提示词**；自证与日志要看得见。 */
export function nonUsSourceChoicesOf(sources) {
  return (sources ?? []).filter((s) => (s.辖区 ?? s.jurisdiction) !== 'US')
                        .map((s) => ({ id: s.id, org: s.机构, doc: s.文档,
                                       jurisdiction: s.辖区 ?? s.jurisdiction ?? null }));
}

/** 模型侧提示词里那一节「能引什么」——**只列美国来源**，与 `sourceChoices()` 同源、不手抄。 */
export function sourceMenuLines() {
  return usSourceChoicesOf(load().sources).map((s) => `   ${s.id} = ${s.org}《${s.doc}》`);
}

/** 自证 / 日志用：这一轮**被排除**在菜单外的来源（非美国）。 */
export function nonUsSourceChoices() {
  return nonUsSourceChoicesOf(load().sources);
}

const isId = (v) => /^S\d{1,2}$/.test(String(v ?? '').trim());
const byId = (id) => load().sources.find((s) => s.id === String(id).trim()) ?? null;

/** 把 id 收敛成**表里真有的**那个 id；不在表里的（含模型手写的 URL、乱写）一律 null。 */
export function resolveSourceId(v) {
  return isId(v) && byId(v) ? String(v).trim() : null;
}

/* ── 在某个来源内部挑一条**最相关的条款位置**（挑不出就只给来源级引用）──────────
 * 判据故意保守：只在**词面**能对上时才算（ASCII 词 ≥3 字母 / 中文 2-gram 重叠 ≥2），
 * 对不上就退回来源级 —— 宁可只给到「哪份文档」，也不给一个**指错条**的链接。 */
function tokens(s) {
  const t = new Set();
  for (const w of String(s ?? '').toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? []) t.add(w);
  const zh = String(s ?? '').replace(/[^\u4e00-\u9fff]/g, '');
  for (let i = 0; i + 2 <= zh.length; i++) t.add(zh.slice(i, i + 2));
  return t;
}

export function pickWhere(sourceId, hint) {
  const sid = resolveSourceId(sourceId);
  if (!sid || !hint) return null;
  const h = tokens(hint);
  let best = null;
  for (const e of load().entries) {
    if (e.source_id !== sid) continue;
    const et = tokens(`${e.摘要 ?? ''} ${e.条款位置 ?? ''} ${(e.适用品线 ?? []).join(' ')}`);
    let n = 0;
    for (const x of h) if (et.has(x)) n++;
    // ★ 阈值取 3（不是 2）：实测 n≥2 时给 S11 挑到过一条**不相关**的条款位置
    //   （「风险分级监管」那段）—— 指错条比只说「哪份文档」更坏。
    if (n >= 3 && (!best || n > best.n)) best = { n, where: e.条款位置 ?? '', clause: e.clause_no ?? '' };
  }
  return best;
}

/**
 * 渲染那一行「依据」。
 *
 * @param {{source?:string, reason?:string, excerpt?:string, category?:string}} f 模型侧条目
 * @returns {{cited:boolean, line:string, url:string|null, id:string|null}}
 */
/* ── URL 核验（2026-10-13，Owner：「模型当然有权限写 url」）────────────────────
 * 允许模型自己给 URL；代码只负责**把核没核过标出来**，不替它挡掉。
 * 三态，措辞必须让人读得懂（FTC 就是活例子：今天实测 `ftc.gov` 对本机 **403** ——
 * 那不能标成「无效」，它是站点拒绝自动抓取）。
 */
const _probeCache = new Map();
export const PROBE_TIMEOUT_MS = 4000;

export async function probeUrl(url, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const u = String(url ?? '').trim();
  if (!/^https?:\/\//i.test(u)) return { state: 'bad', why: '不是一个 http(s) 链接' };
  if (_probeCache.has(u)) return _probeCache.get(u);
  const out = await (async () => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      // 先 HEAD（省流量），有些站不认 HEAD 再用 GET 兜一次
      let r = await fetch(u, { method: 'HEAD', redirect: 'follow', signal: ctl.signal,
                               headers: { 'user-agent': 'Mozilla/5.0 (compatible; ShouhengLinkCheck/1.0)' } });
      if (!r.ok && (r.status === 405 || r.status === 501 || r.status === 403)) {
        r = await fetch(u, { method: 'GET', redirect: 'follow', signal: ctl.signal,
                             headers: { 'user-agent': 'Mozilla/5.0 (compatible; ShouhengLinkCheck/1.0)' } });
      }
      return r.ok ? { state: 'ok', http: r.status }
        : { state: r.status === 403 || r.status === 401 ? 'refused' : 'http', http: r.status };
    } catch (e) {
      return { state: 'unreachable', why: e?.name === 'AbortError' ? '超时' : (e?.message ?? String(e)) };
    } finally { clearTimeout(t); }
  })();
  _probeCache.set(u, out);
  return out;
}

/** 核验三态 → 一句人话（**不许**把「取不到」说成「无效」）。 */
export function probeLabel(pr) {
  if (!pr) return '⚠️ 未核';
  if (pr.state === 'ok') return `✅ 已核（HTTP ${pr.http}）`;
  if (pr.state === 'refused') return `⚠️ 本机取不到（HTTP ${pr.http} —— 站点拒绝自动抓取，不等于链接无效）`;
  if (pr.state === 'http') return `⚠️ 本机取到 HTTP ${pr.http}（可能已失效或需登录）`;
  if (pr.state === 'bad') return '⚠️ 不是有效链接';
  return `⚠️ 未核（${pr.why ?? '取不到'}）`;
}

/**
 * 渲染那一行「依据」。
 *
 * 来源优先级：**已登记的闭集 id** ＞ 模型自己给的 `source_url` ＞ 都没有（如实说没有）。
 * 前者每天被 `verify_external.py` 复核（引文逐字对得上），可核性最高；后者照实展示 +
 * 标出核验状态 —— 因为 Owner 说得很对：模型侧的依据本来就在库外。
 *
 * @param {{source?:string, source_url?:string, source_name?:string, reason?:string,
 *          excerpt?:string, category?:string, probe?:object}} f
 */
export function basisText(f = {}) {
  return basisTextOf(load().sources, f);
}

/* ── ★★ 2026-10-16（Owner 选定「解析也只认美国来源」）────────────────────────
 * 上面那条 `sourceMenuLines()` 只把**美国**来源递到模型面前；而**解析**这一步原先
 * 仍认登记表里任何 id —— 实测 `basisText({source:'S15'})` **照样把 MHRA 的英国链接挂上去**
 * 并标成「登记来源」。菜单挡住、解析没挡，等于只关了半扇门：模型猜中（或哪天菜单又被改宽）
 * 就有一条域外依据进了对外报告，而**没有任何断言盖住它** ——
 * 自证那时只覆盖了无效 id（`S99` / 小写 / 空 / null / 注入串）。
 *
 * ⇒ 口径：**能递到它面前的**与**能被挂上报告的**必须是同一个集合（都按 `辖区 === 'US'`）。
 *   非美国 id 与未知 id **同样是 fail-closed**（不给链接）。
 *   ★ 但两支**不许混成一支**：未知 id 是「没给来源」；非美国 id 是「给了、按美国口径不作数」——
 *     后者要**照实写出来**并**落台账**（`PMO/logs/nonus-cite.ndjson`，可数）。
 *     丢弃不留痕＝静默消失，那正是本项目反复吃过的形状。
 *   ★ 抽成纯函数并**显式接收 sources**：否则「挡住它的到底是不是辖区」这条反向对照
 *     只能靠读源码去证 —— 而 §2.4 已经点名「名字出现过 ≠ 拦得住」。
 */
export function basisTextOf(sources, f = {}) {
  const hint = `${f.reason ?? ''} ${f.excerpt ?? ''} ${f.category ?? ''}`;
  const id = resolveSourceId(f.source);
  if (id) {
    const s = (sources ?? []).find((x) => x.id === id) ?? null;
    const jur = s?.辖区 ?? s?.jurisdiction ?? null;
    if (!s || jur !== 'US') {
      noteNonUsCite({ id, jurisdiction: jur, org: s?.机构 ?? null, doc: s?.文档 ?? null,
                      where: f.where ?? f.location ?? null });
      console.warn(`[ext_basis] ⚠️ 挡下一条非美国来源的引用：${id}（辖区=${jur ?? '未标'}）`
        + ' ⇒ 不给链接、按「无库内依据」写；已落台账 ' + nonUsCiteLogPath());
      return {
        cited: false, kind: 'non-us', id, jurisdiction: jur, url: null, probe: null,
        line: `**无库内依据** —— 本条点了 \`${id}\`（${s?.机构 ?? '未登记机构'}`
            + `${s?.文档 ? `《${s.文档}》` : ''}），辖区是 **${jur ?? '未标'}**；`
            + '本项目只审美国市场（美国联邦 ＋ 美国平台政策），域外依据不作判据，故不给链接'
            + '（独立语义复核给出的判断，需人工复核）',
      };
    }
    const w = pickWhere(id, hint);
    const where = w?.where ? ` · ${w.where}` : '';
    return { cited: true, kind: 'registry', id, jurisdiction: jur, url: s.url, probe: null,
             // 渲染层自己印 `**依据**：` —— 这一行**不带前缀**（否则印两遍，实测过）
             line: `${s.机构}《${s.文档}》${where} → ${s.url}（登记来源 · 每日复核）` };
  }
  const u = String(f.source_url ?? '').trim();
  if (/^https?:\/\//i.test(u)) {
    const name = String(f.source_name ?? '').trim();
    return { cited: true, kind: 'model-url', id: null, url: u, probe: f.probe ?? null,
             line: `${name ? `${name} → ` : ''}${u}　${probeLabel(f.probe ?? f.url_probe)}` };
  }
  return {
    cited: false, kind: 'none', id: null, url: null, probe: null,
    // ⚠️ 措辞红线（Owner 2026-10-13）：**卡面不许出现「模型侧」「知识库侧」**。
    // ★★ 2026-10-19（Owner：「回复中去掉这句『无库内依据 —— 知识库条款没覆盖…』，
    //   **没有「依据」如何判断的问题呢？**」）——
    //   原来那句是**自我否定**：一边判它是问题，一边说「没有依据」。
    //   现在只留一句**说清性质**的短话：这不是条款判的，是复核判的。
    //   ⚠️ 这一格**不能整格删掉**：PRD §5.3.3 要求每条都要有「依据」这一格；
    //      而本库有条硬纪律 —— **判断不等于证据**，读者有权知道这一条回不了源。
    line: '独立语义复核（**非条款依据**，需人工核对）',
  };
}

/** 被辖区挡下的引用**落台账**（路径可用环境变量指走 —— 自证不许写真台账，§2.4.4）。 */
export function nonUsCiteLogPath() {
  return process.env.SHOUHENG_NONUS_CITE_LOG
    || path.join(REPO_ROOT, 'PMO', 'logs', 'nonus-cite.ndjson');
}

export function noteNonUsCite(detail = {}) {
  try {
    const f = nonUsCiteLogPath();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, JSON.stringify({ at: new Date().toISOString(), ...detail }) + '\n', 'utf8');
    return true;
  } catch (e) {
    // 台账写不进去**不许**把引用放行（fail-closed 的方向不能反），只报一句
    console.warn(`[ext_basis] ⚠️ 非美国来源台账写不进去（${e?.code ?? e?.message}）—— 引用仍按拒挂处理`);
    return false;
  }
}

/** 数台账行数。**读不到说 0**；**读抛了返回 null（未测）**，不许当成 0。 */
export function nonUsCiteCount() {
  try {
    const f = nonUsCiteLogPath();
    if (!fs.existsSync(f)) return 0;
    return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).length;
  } catch { return null; }
}

/* ══════════════════════════ 自证（判据 + 反向对照）══════════════════════════ */
function selftest() {
  let pass = 0; let fail = 0;
  const T = (name, ok, detail = '') => { if (ok) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name}  ${detail}`); } };

  const ch = sourceChoices();
  T('来源闭集读得到 17 个', ch.length === 17, `实际 ${ch.length}`);
  T('闭集里每条都带真 URL', ch.every((s) => /^https?:\/\//.test(s.url)));
  // ★★ 2026-10-16 改：菜单**只列美国来源**（原来断言"菜单 = 闭集"，那正是病灶：
  //    闭集里 2 条英国来源被原样递到模型面前，而提示词第 7 条明写不许引）
  const us = usSourceChoicesOf(ch);
  const nonUs = nonUsSourceChoicesOf(ch);
  T('菜单只列美国来源 ⇒ 15 条', us.length === 15, `实际 ${us.length}`);
  T('非美国来源被挡在菜单外 ⇒ S15/S16 两条',
    nonUs.length === 2 && nonUs.map((s) => s.id).sort().join(',') === 'S15,S16',
    `实际 ${nonUs.map((s) => `${s.id}(${s.jurisdiction})`).join(',')}`);
  T('提示词菜单与「美国子集」同源（不手抄）',
    sourceMenuLines().length === us.length && sourceMenuLines()[0].includes(us[0].id));
  T('★ 菜单里**不出现**非美国来源的 id',
    nonUs.every((s) => !sourceMenuLines().join('\n').includes(s.id)));
  T('每条来源都标了辖区（缺字段 ⇒ 会在菜单里静默消失）',
    ch.every((s) => s.jurisdiction === 'US' || s.jurisdiction === 'UK'),
    `缺辖区：${ch.filter((s) => !s.jurisdiction).map((s) => s.id).join(',') || '无'}`);
  // ★ 反向对照：把一条英国来源的辖区改成 US ⇒ 它**必须**进菜单；
  //   改回 UK ⇒ 必须出去。少了这一条，「菜单里没有 S15」可能只是"它压根没被读进来"。
  const fake = ch.map((s) => (s.id === 'S15' ? { ...s, jurisdiction: 'US' } : s));
  T('★ 反向对照：S15 辖区改 US ⇒ 进菜单（证明挡住它的是辖区，不是别的）',
    usSourceChoicesOf(fake).some((s) => s.id === 'S15'));
  T('★ 反向对照：仍是 UK ⇒ 不进菜单',
    !usSourceChoicesOf(ch).some((s) => s.id === 'S15'));

  // ★★ 2026-10-16（Owner 选定「解析也只认美国来源」）：**菜单挡住了，解析也必须挡** ——
  //    病灶是「菜单只列美国、而挂链接那一步仍认登记表里任何 id」，实测 S15 会被挂上英国链接。
  //    判据必须**行为级**（真调一次）+ **反向对照**（证明挡住它的是辖区），
  //    且**不许写真台账**（§2.4.4：跑一次自证改掉它要保护的东西，比没有自证更糟）。
  const ledProbe = path.join('/tmp', `nonus-cite-selftest-${process.pid}.ndjson`);
  const oldLedEnv = process.env.SHOUHENG_NONUS_CITE_LOG;
  process.env.SHOUHENG_NONUS_CITE_LOG = ledProbe;
  try { fs.rmSync(ledProbe, { force: true }); } catch { /* 本来就没有 */ }
  const led0 = nonUsCiteCount();
  const g15 = basisText({ source: 'S15', reason: '英国 CAP 口径', category: '合规' });
  T('非美国 id（S15 = 英国 MHRA）⇒ **不给链接**',
    g15.cited === false && g15.url === null, JSON.stringify(g15).slice(0, 160));
  T('★ 且**不是**与「未知 id」同一支（`kind=non-us`，两支要能分辨）',
    g15.kind === 'non-us', `kind=${g15.kind}`);
  T('★ 报告里要**照实写出来**（点了哪个 id、辖区是什么），不许静默消失',
    /S15/.test(g15.line) && /UK/.test(g15.line) && /不作判据/.test(g15.line), g15.line);
  const g16 = basisText({ source: 'S16', category: '合规' });
  T('非美国 id（S16 = 英国 ASA/CAP）同样不给链接', g16.cited === false && g16.kind === 'non-us');
  T('★ 留痕：这两次被拒的引用进了台账（可数，+2）',
    nonUsCiteCount() === (led0 ?? 0) + 2, `before=${led0} after=${nonUsCiteCount()}`);
  // 反向对照①：把 S15 的辖区改成 US ⇒ **必须**又挂得上链接（证明挡住它的是辖区，不是别的）
  const rawUs = load().sources.map((s) => (s.id === 'S15' ? { ...s, 辖区: 'US' } : s));
  const g15us = basisTextOf(rawUs, { source: 'S15', category: '合规' });
  T('★ 反向对照①：S15 辖区改 US ⇒ 又挂得上链接（挡住它的是辖区）',
    g15us.cited === true && /gov\.uk/.test(g15us.url ?? ''), JSON.stringify(g15us).slice(0, 160));
  // 反向对照②：未知 id 走的仍是原来那一支（没被新分支吃掉），且**不落**台账
  const g99 = basisText({ source: 'S99' });
  T('★ 反向对照②：未知 id（S99）仍走「无库内依据」那一支，且不落台账',
    g99.cited === false && g99.kind === 'none' && nonUsCiteCount() === (led0 ?? 0) + 2,
    `kind=${g99.kind} count=${nonUsCiteCount()}`);
  if (oldLedEnv === undefined) delete process.env.SHOUHENG_NONUS_CITE_LOG;
  else process.env.SHOUHENG_NONUS_CITE_LOG = oldLedEnv;
  try { fs.rmSync(ledProbe, { force: true }); } catch { /* 收尾失败不影响断言 */ }

  // ① 正例：模型挑了一个真 id ⇒ 给登记链接
  const a = basisText({ source: 'S11', reason: 'FDA 批准表述', category: '合规' });
  T('挑中 S11 ⇒ 给链接且指向 fda.gov', a.cited && /fda\.gov/.test(a.url), JSON.stringify(a));
  T('渲染行里同时给机构与文档名', /FDA/.test(a.line) && /FDA Approved/.test(a.line), a.line);
  T('★ 这一行**不带**「依据：」前缀（渲染层会印，重复就是印两遍）', !/依据/.test(a.line), a.line);

  // ② ★★ 模型**自己写 URL** 这条路（Owner 2026-10-13：「模型当然有权限写 url」）——
  //    必须**原样展示**，并带上核验状态；不许因为"可能编"就把它丢掉。
  const m = basisText({ source_url: 'https://advertising.amazon.com/help/G6UU66YLSCUYDULQ',
                        source_name: 'Amazon Ads · Claims and substantiation',
                        probe: { state: 'ok', http: 200 } });
  T('★ 模型自写 URL ⇒ 必须展示（不许丢）', m.cited && m.kind === 'model-url' && /advertising\.amazon\.com/.test(m.line));
  T('★ 且必须带核验状态（已核）', /✅ 已核（HTTP 200）/.test(m.line), m.line);
  // ②b 反向对照：**取不到**不许说成「无效」——FTC 今天实测 403，那是站点拒绝自动抓取
  const r403 = basisText({ source_url: 'https://www.ftc.gov/business-guidance/resources/x',
                           probe: { state: 'refused', http: 403 } });
  T('★ 反向对照：403 ⇒ 说「本机取不到」且**明写不等于无效**',
     /本机取不到/.test(r403.line) && /不等于链接无效/.test(r403.line), r403.line);
  const rto = basisText({ source_url: 'https://example.invalid/x', probe: { state: 'unreachable', why: '超时' } });
  T('★ 反向对照：超时 ⇒ 说「未核」，不许说「无效」', /未核（超时）/.test(rto.line), rto.line);
  // ③ 反向对照：不在表里的 id、空值 ⇒ 不许给登记链接（但 source_url 那条路仍可走）
  for (const bad of ['S99', 's11', '', null, undefined, 'S1; rm -rf']) {
    const r = basisText({ source: bad, reason: 'x' });
    T(`★ 反向对照：source=${JSON.stringify(bad)} ⇒ 不给登记链接`, r.cited === false && r.url === null, JSON.stringify(r));
  }
  // ③b 优先级：闭集 id 与自写 URL 同时给 ⇒ 取**可核性最高**的那个（登记来源）
  const both = basisText({ source: 'S14', source_url: 'https://example.com/x', reason: 'competent and reliable scientific evidence' });
  T('★ 两者都给 ⇒ 优先登记来源（可核性更高）', both.kind === 'registry' && /ftc\.gov/.test(both.url), JSON.stringify(both).slice(0, 160));
  // ④ 挑条款位置：词面对得上才给，对不上只给到来源级
  const w1 = pickWhere('S14', 'competent and reliable scientific evidence 需要专家客观实施');
  T('S14 + 该来源的原话 ⇒ 挑得出条款位置', !!w1 && /科学证据|substantiation|evidence/i.test(w1.where ?? ''), JSON.stringify(w1));
  const w2 = pickWhere('S14', '这个素材的字体太小了看不清');
  T('★ 反向对照：词面对不上 ⇒ 不给条款位置（不指错条）', w2 === null, JSON.stringify(w2));

  console.log(`\n${fail ? '❌' : '✅'} ext_basis 自证 ${pass}/${pass + fail} 项通过`);
  return fail ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--selftest')) process.exit(selftest());
  console.log(JSON.stringify(sourceChoices().map((s) => `${s.id} ${s.org}《${s.doc}》`), null, 1));
}

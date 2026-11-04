/**
 * external_watch.mjs —— 外部标准库（62 条引文）的**触发者**（Q4-4d，2026-09-22）
 *
 * ── 它补的是哪一件事
 *
 * `verify_external.py` 能回答「那 62 条引文在上游还逐字对得上吗」，而且它已经有
 * 归档（不覆盖旧物证）、清单（`_runs.jsonl`）和漂移段（与上一轮比，哪几个来源变了）。
 * 缺的从来不是判据，是**谁在跑**：在此之前只有人手动跑。
 *
 * 这正是 `AGENTS.md` §2.4.2 那个病 —— **一句写下来的承诺没有执行点**。
 * PRD 那篇改了会有人知道（`prd_baseline.mjs` 挂在 daemon 上），
 * 而 FDA / Amazon / Meta 的政策页改了，**我们不会知道** ——
 * 这 62 条引文是要给法务当依据用的。
 *
 * ── 三条纪律（照抄 `prd_baseline.mjs`，因为它为同一件事付过学费）
 *
 * 1. **不阻塞回话**：调用点全是 `void`，出错只记日志，绝不影响正常回答；
 * 2. **未测不得沉默，且未测的文案里不许出现「没问题」**（§2.4.2 第 2 条）；
 * 3. **状态文件必须独立**（`external-watch.json`）—— §2.4.3 那个坑：
 *    两个检查共写一份状态文件时，后写的会把先写的那份快照**整段抹掉**。
 *    本项目为此丢过一次数据（`p_saidDueKey` 被抹 → 同一条提醒反复重发）。
 *
 * ⚠️ 它**会动盘**（§2.4.4：每条自证命令都要能回答「跑完盘上变了什么」）：
 *    真抓 17 个来源 → 写 `research/kb/_evidence/外部标准库/S*.txt`（内容变了先归档改名）
 *    + append 一行 `_runs.jsonl`。所以它有一条 3 小时冷却，重启风暴不会变成抓取风暴。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, stateDir, ensureDir } from './config.mjs';
import { bjDate, stripNegated } from './prd_baseline.mjs';

/** 两次真抓之间的最短间隔。重启不重抓：「刚核过」不是「该再核一次」的理由。 */
export const COOLDOWN_MS = 3 * 60 * 60 * 1000;

/** 状态文件的键**恰好**在这张表里（照抄 `prd_baseline.mjs` 的 `KEEP_*` 纪律：残留由构造不可能）。 */
const KEEP = ['lastState', 'lastRunAt', 'lastDay', 'lastCode', 'lastHash', 'saidDriftKey', 'saidUntestedDay',
              // ★ 2026-09-22 加，与 `prd_baseline.mjs` 的同一个洞：**跳过要留痕**。
              //   这一份的冷却更长（3 小时），所以「重启落在冷却里 → 这次不查了」的窗口
              //   比基线那份更宽：**最长 3 小时**才轮到下一次真实触发（下一次换日或新消息）。
              //   记录第一次跳过的时刻，`recheckDue()` 拿它当唯一依据。
              'staleSince'];
const pick = (prev, keys) =>
  Object.fromEntries(keys.filter((k) => prev?.[k] !== undefined).map((k) => [k, prev[k]]));

/**
 * 「这次读数被跳过了，什么时候补回来」—— 与 `prd_baseline.mjs` 的 `recheckDue()` **同一条判据**。
 *
 * 为什么不抽成公共函数：两份状态的键名不同、冷却不同、`enter()` 不同；
 * 抽出去只会造出一个「两处都要改」的第三处。**共享的是判据的形状，不是代码** ——
 * 形状由这一份和那一份各自的 `--selftest` 各自断言（各有一条正、一条反）。
 *
 * @param {object} prev 状态文件
 * @param {number} t    当前时刻（注入用 —— 3 小时不必真等）
 * @returns {string|null} null = 不必补；字符串 = 理由
 */
export function recheckDue(prev, t = Date.now()) {
  if (!prev?.staleSince) return null;                       // 没跳过 → 不补（否则变成 3 小时轮询）
  const last = prev.lastRunAt ? Date.parse(prev.lastRunAt) : 0;
  if (COOLDOWN_MS - (t - last) > 0) return null;             // 冷却未过 → 补了也会被再跳过
  return `上次读数停在 ${prev.lastRunAt}，自 ${prev.staleSince} 起被跳过、冷却已过`;
}

export const STATE_FILE = () => path.join(stateDir(), 'external-watch.json');

export function loadState(file = STATE_FILE()) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}
export function saveState(s, file = STATE_FILE()) {
  ensureDir(stateDir());
  try { fs.writeFileSync(file, JSON.stringify(s, null, 2)); }
  catch { /* 状态写不进去不该让守衡崩 —— 顶多下次多说一句 */ }
}

/**
 * 跑一次 `verify_external.py --manifest-only`。**只读它的那一行 JSON** ——
 * 把结论行当文本去正则捞，正是「读错字段却安静产出假数据」的形状（§2.4.1）。
 *
 * @returns {Promise<{code:number, manifest:object|null, note:string, out:string}>}
 */
export function runChecker({ timeoutMs = 300_000, python = 'python3' } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '', done = false;
    const child = spawn(python, ['tools/verify_external.py', '--manifest-only'],
                        { cwd: REPO_ROOT, env: process.env });
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill('SIGKILL'); } catch {}
      // 超时是**未测**，不是失败也不是通过 —— 退 2 与另外两个都不同码。
      resolve({ code: 2, manifest: null, note: `跑了 ${timeoutMs / 1000} 秒没结束（已杀）`, out });
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => {
      if (done) return;
      done = true; clearTimeout(timer);
      resolve({ code: 2, manifest: null, note: `起不了子进程：${e.code ?? e.message}`, out });
    });
    child.on('close', (rc) => {
      if (done) return;
      done = true; clearTimeout(timer);
      let manifest = null;
      for (const line of out.split('\n')) {
        const s = line.trim();
        if (!s.startsWith('{')) continue;
        try { manifest = JSON.parse(s); } catch { /* 不是那一行 */ }
      }
      if (!manifest) {
        resolve({ code: 2, manifest: null,
                  note: `读不到清单 JSON（退出码 ${rc}${err ? `；stderr: ${err.trim().slice(0, 200)}` : ''}）`,
                  out });
        return;
      }
      resolve({ code: rc, manifest, note: '', out });
    });
  });
}

/** 这一轮所有来源哈希的指纹 —— 「上游整体长什么样」的一个可比较读数。 */
export function hashOf(manifest) {
  // ★ 用**归一化指纹**（`drift`），不是原文 sha256：构建号/缓存标记每轮都变，
  //   拿原文哈希当「这一轮长什么样」，指纹就每轮都换一个 —— 漂移指纹形同虚设。
  //   `drift` 缺失（老清单）时回落到 sha256，并因此**必然**报一次漂移：宁可说，不可沉默。
  const s = Object.entries(manifest?.sources ?? {})
    .map(([k, v]) => `${k}:${v.drift ?? v.sha256}`).sort().join('|');
  return s ? require$hash(s) : null;
}
/** 小工具：不引 crypto 也能有个稳定短指纹（这里只需要可比，不需要抗碰撞）。 */
function require$hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
}

/**
 * 状态迁移：**纯函数** —— 喂合成样本就能断言「该说时说、该闭嘴时闭嘴」。
 *
 * @param {object} prev  上一次的记录
 * @param {object} now   { code, manifest, note, day }
 * @returns {{state:object, say:string|null, why:string, verdict:string}}
 */
export function enter(prev, now) {
  // 只认 0/1/2；别的（被杀 137、崩了、-1…）一律折成 **2 = 未测**。
  // 「我没测成」与「我测了是绿的」必须长得不一样（§2.4.2 第 2 条）。
  const code = [0, 1, 2].includes(now.code) ? now.code : 2;
  const day = now.day;
  const man = now.manifest ?? {};
  const changed = Array.isArray(man.changed) ? man.changed : [];
  const miss = Array.isArray(man.miss) ? man.miss : [];
  const unver = Array.isArray(man.unverifiable) ? man.unverifiable : [];
  const nLive = Number(man.n_live ?? 0);
  const total = Number(man?.entries?.total ?? 0);
  const hit = Number(man?.entries?.hit ?? 0);

  const st = { ...pick(prev, KEEP), lastRunAt: new Date().toISOString(), lastDay: day,
               lastCode: code, rawCode: now.code, lastHash: hashOf(man),
               // ★ 真跑过一次就清掉「已过期」标记。必须写在展开**之后** ——
               //   写在前面会被 `pick(prev, KEEP)` 带回来的旧值盖掉，清不掉。
               staleSince: null };

  // ── 未测：读不到清单、跑不完、或**今天一个来源都没真抓**（`--offline` 那条路的形状）
  if (code === 2 || nLive === 0) {
    const why = now.note || `今日真抓 0 个来源（清单里去重后 n_live=${nLive}）`;
    if (prev.saidUntestedDay === day) {
      return { state: { ...st, lastState: 'untested' }, say: null, why: '今天的「未测」已经说过一次', verdict: 'untested' };
    }
    return {
      state: { ...st, lastState: 'untested', saidUntestedDay: day },
      verdict: 'untested',
      why: '今天是未测（不是通过）',
      say: [
        '⚠️ **外部标准库今天没核成** —— 这 62 条引文对上游的核对，今天这一轮**未测**。',
        `· 原因：${why}`,
        '· 这不是「没问题」，是「没测到」：它们仍然停在上一轮核过的那一版。',
      ].join('\n'),
    };
  }

  // ── 红：引文在上游对不上 / 只差排版形态 / 空位形态不齐
  //
  //   ★★ 2026-10-13 修**一处 fail-open**（就在这条路上，实测踩到）：
  //     原条件 `code === 1 || miss.length` 有两种坏法，方向相反：
  //       · `miss` 空而红在 `punct` / `ws`（转写杂质）⇒ 文案印成「有 **0** 条引文对不上」，
  //         真正红在哪一条一个字都没说（当天实测：`miss=0`、检查器退 1）；
  //       · 若顺手把条件收窄成 `miss.length`，那两种红会**一路掉进最后的绿分支**
  //         （`全绿且无来源变动（该闭嘴）`）⇒ **有红报绿**，比上一坏法严重得多。
  //     现在：三种红各自进这一支、各自被说出来；末尾另加一道兜底 ——
  //     「退 1 却四类全空」不许当绿。**判据只认清单里的字段，不猜。**
  const nPunct = Number(man?.entries?.punct ?? 0);
  const nWs = Number(man?.entries?.ws ?? 0);
  if (miss.length || nPunct || nWs) {
    const key = `red:${miss.map((m) => m.id).sort().join(',')}|punct:${nPunct}|ws:${nWs}`;
    if (prev.saidDriftKey === key) {
      return { state: { ...st, lastState: 'red', saidDriftKey: key }, say: null,
               why: '同一批失配条目已经说过', verdict: 'red' };
    }
    const lines = [];
    if (miss.length) {
      lines.push(`⚠️ **外部标准库有 ${miss.length} 条引文在上游对不上了**`);
      lines.push(...miss.slice(0, 6).map((m) => `· ${m.id}（${m.source_id}）`));
      if (miss.length > 6) lines.push(`· 还有 ${miss.length - 6} 条，明细在我这边的日志里`);
      lines.push('· 两种可能：上游改了这几句，或者我们当初抄错了。**先别拿这几条当依据**，我去核。');
    } else {
      // 失配 0，但形态层有红 —— 不许说成「都对上了」（§2.4.2）
      lines.push('⚠️ **外部标准库这一轮没全过**：失配 0 条，红在**形态层**（见下）—— 那不是「都对上了」。');
    }
    if (nPunct || nWs) {
      lines.push(`· 另有 ${nPunct} 条只差**排版形态**（弯/直引号）、${nWs} 条**空位形态不齐**`
                 + '（多了原文没有的空格）—— 属转录杂质，应改我们的写法。');
    }
    if (unver.length) {
      // ★ 与 `verify_shouheng_ops` 的 H7 同一条纪律：**有红时也要把未测说出来**，
      //   否则只看这一条的人会以为其余都验过了。
      lines.push(`· 另有 ${unver.length} 条**不可复核**（今日无匿名取法拿到正文），只对仓内留档件核过，按 L2 算。`);
    }
    return {
      state: { ...st, lastState: 'red', saidDriftKey: key },
      verdict: 'red',
      why: miss.length ? '有引文在上游对不上' : '形态层有红（转录杂质，应改）',
      say: lines.join('\n'),
    };
  }

  // ── 漂移但引文仍成立：上游改了别处
  if (changed.length) {
    const key = `drift:${changed.join(',')}:${st.lastHash}`;
    if (prev.saidDriftKey === key) {
      return { state: { ...st, lastState: 'ok', saidDriftKey: key }, say: null,
               why: '同一个漂移指纹已经说过', verdict: 'drift' };
    }
    const lines = changed.slice(0, 6).map((s) => `· ${s}（${man.sources?.[s]?.entries ?? '?'} 条引文依赖它）`);
    return {
      state: { ...st, lastState: 'ok', saidDriftKey: key },
      verdict: 'drift',
      why: '上游页面变了，但引文仍逐字命中',
      say: [
        `📌 外部标准库有 ${changed.length} 个来源的页面**内容变了**（上游改了别处，不是我们引的那几句）`,
        ...lines,
        `${hit}/${total} 条引文仍逐字命中。旧版快照我没删，已改名留档；以后引用这几页按新版看。`,
      ].join('\n'),
    };
  }

  // ── 恢复：上一次是红的/未测，这次干净了
  if (['red', 'untested'].includes(prev.lastState) && code === 0) {
    return {
      state: { ...st, lastState: 'ok', saidDriftKey: prev.saidDriftKey },
      verdict: 'ok',
      why: '上一次是红的/未测，这次干净了（要报一次，否则没人知道恢复了）',
      // ★ 2026-10-13：`hit` 里可能含**已裁决的空位差**（`entries.declared_ws`）——
      //   那种条目逐字内容无差异，但**只出现在派生证据件上的空格**是有的。
      //   一句「逐字命中」会把这层差别吞掉 ⇒ 这里必须说出来（清单里有这个字段，
      //   见 `verify_external.py` 的 `declared_ws_diffs`）。
      say: `✅ 外部标准库的核对恢复了：${hit}/${total} 条引文在上游逐字命中，没有来源变动。`
           + (Number(man?.entries?.declared_ws ?? 0)
              ? `\n· 其中 ${Number(man.entries.declared_ws)} 条带**已裁决**的空位差`
                + '（只出现在派生证据件上的空格，逐字内容无差异）。'
              : ''),
    };
  }

  if (unver.length) {
    // 有来源取不到快照 → 那些条目的结论只到 L2（对仓内钉住件）。**不许并进「都在上游验过」。**
    const key = `unver:${unver.map((u) => u.source_id).sort().join(',')}:${day}`;
    if (prev.saidDriftKey === key) {
      return { state: { ...st, lastState: 'ok', saidDriftKey: key }, say: null,
               why: '同一批不可复核的来源今天已经说过', verdict: 'partial' };
    }
    const sids = [...new Set(unver.map((u) => u.source_id))];
    return {
      state: { ...st, lastState: 'ok', saidDriftKey: key },
      verdict: 'partial',
      why: '有来源今日无匿名取法，那几条只对仓内钉住件核过',
      say: [
        `· 外部标准库今日核对：${hit}/${total} 条命中；其中 ${sids.join('、')} 的 ${unver.length} 条`
        + '**只对仓内留档件核过，没在上游核**（本机无匿名取法）。',
        '· 这几条的结论按 L2 算，别当成「在上游验过了」。',
      ].join('\n'),
    };
  }

  // ★ 兜底（2026-10-13）：检查器**退 1**，而上面四类可归类的红都不是它
  //   ⇒ 这是「检查器与告警器口径不一致」的形状，**不许报绿**。
  //   宁可说一句「我认不出红在哪一类」，也不能让一个退 1 的检查器在群里静默。
  if (code === 1) {
    const key = `red-unclassified:${st.lastHash}`;
    if (prev.saidDriftKey === key) {
      return { state: { ...st, lastState: 'red', saidDriftKey: key }, say: null,
               why: '同一条未归类的红已经说过', verdict: 'red' };
    }
    return {
      state: { ...st, lastState: 'red', saidDriftKey: key },
      verdict: 'red',
      why: '检查器退 1，但清单里四类红全空',
      say: '⚠️ **外部标准库这一轮退 1，而我认不出红在哪一类**'
           + '（失配 / 排版形态 / 空位形态 / 不可复核 全是 0）\n'
           + '· 这是**检查器与告警器口径不一致**的形状 —— 别当成通过；明细看那一轮 `verify_external.py` 的输出。',
    };
  }

  return { state: { ...st, lastState: 'ok' }, say: null, why: '全绿且无来源变动（该闭嘴）', verdict: 'ok' };
}

/* ─────────────────────────── 编排 ─────────────────────────── */

let inFlight = null;

/** 单飞：上一次还在跑时，第二次直接跳过（一个状态文件同时只能有一个写者）。 */
export async function checkExternal(opts = {}) {
  if (inFlight) return { skipped: '上一次外部标准库检查还在跑' };
  inFlight = runCheckExternal(opts);
  try { return await inFlight; } finally { inFlight = null; }
}

export async function runCheckExternal({ reason = 'daily', force = false, day = bjDate(),
                                         run = runChecker, dryRun = false, stateFile = null } = {}) {
  const file = stateFile ?? STATE_FILE();
  const prev = loadState(file);
  const last = prev.lastRunAt ? Date.parse(prev.lastRunAt) : 0;
  if (!force && Date.now() - last < COOLDOWN_MS) {
    /**
     * ★ **跳过要留痕**（2026-09-22 加，与 `prd_baseline.mjs` 同一条，见 `PMO/守衡-误答登记-20260922.md` §十三）。
     *
     * 这一份的窗口比基线那份更宽：冷却 3 小时，所以「重启撞上冷却」= **3 小时内不会再看一眼**，
     * 而这份守的是**要给法务当依据的 62 条引文**。原先这一支只有一个 `return`。
     *
     * 只记**第一次**跳过的时刻（重复跳过不刷新），并保持其余键原样 ——
     * 尤其 `lastHash` / `lastState`：**跳过不许擦掉读数**，只许标注它开始过期的时间。
     */
    const staleSince = prev.staleSince ?? new Date().toISOString();
    if (!dryRun && staleSince !== prev.staleSince) {
      saveState({ ...pick(prev, KEEP), staleSince }, file);
    }
    return {
      skipped: `冷却中（上次 ${prev.lastRunAt}，不足 ${COOLDOWN_MS / 3600000} 小时）`,
      staleSince,
    };
  }
  const r = await run({});
  const { state, say, why, verdict } = enter(prev, { code: r.code, manifest: r.manifest,
                                                     note: r.note, day });
  // ★ `dryRun` 时**一个字节都不许落盘**（§2.4.4 那次实测：跑一次自证把告警静音了半小时）。
  //   `--selftest` 的用例全部走这条路，判据在下面的 `--selftest` 里。
  if (!dryRun) saveState(state, file);
  return { code: r.code, verdict, say, why, reason, manifest: r.manifest, note: r.note,
           ...(dryRun ? { dryRun: '注入/自证 —— 未落状态' } : {}) };
}

/* ─────────────────────────── 自证（反向对照） ─────────────────────────── */

/**
 * `node tools/agent/external_watch.mjs --selftest` —— **纯函数 + 落盘纪律**，不联网、不发群。
 *
 * 每一条都必须能红：一个恒说（刷屏）或恒不说（等于没有）的告警器都没用，两边都要证。
 */
export async function selftest() {
  const res = [];
  const T = (name, ok, detail) => res.push({ name, ok, detail });
  const mk = (o) => ({ sources: {}, entries: { total: 62, hit: 62 }, n_live: 17, changed: [], miss: [], unverifiable: [], ...o });
  const day = '2026-09-22';

  // 1. 全绿 → 闭嘴
  let r = enter({}, { code: 0, manifest: mk({}), day });
  T('全绿无漂移 → 不说话', r.say === null && r.verdict === 'ok', `say=${r.say}`);

  // 2. 上游改了 → 必须说
  r = enter({}, { code: 0, manifest: mk({ changed: ['S4'], sources: { S4: { entries: 3, sha256: 'a' } } }), day });
  T('有来源变动 → 必须说', !!r.say && r.verdict === 'drift', `verdict=${r.verdict}`);
  const driftKey = r.state.saidDriftKey;

  // 3. 同一个漂移指纹 → 闭嘴（不许每天喊同一条）
  r = enter({ ...r.state }, { code: 0, manifest: mk({ changed: ['S4'], sources: { S4: { entries: 3, sha256: 'a' } } }), day });
  T('同一漂移指纹 → 闭嘴', r.say === null, `say=${r.say}`);
  T('漂移指纹确实变了才再说', driftKey !== null && driftKey !== undefined, `key=${driftKey}`);

  // 4. 引文失配 → 必须说，且文案指向「先别当依据」
  r = enter({}, { code: 1, manifest: mk({ miss: [{ id: 'EXT-007', source_id: 'S4' }] }), day });
  T('引文失配 → 必须说', !!r.say && r.verdict === 'red' && r.say.includes('EXT-007'), `verdict=${r.verdict}`);

  // 4b. ★ 退 1 但 `miss` 为空、红在形态层（2026-10-13 加）
  //     实测形状：当天 `失配 0 / 不可复核 4`，检查器退 1，而旧文案印的是
  //     「有 **0** 条引文在上游对不上了」—— 真正红在哪一条一个字没说。
  r = enter({}, { code: 1, manifest: mk({ entries: { total: 62, hit: 61, punct: 1, ws: 2 } }), day });
  T('★ 红在形态层（miss 空）→ 必须说出来，且不许印「0 条对不上」',
    !!r.say && r.verdict === 'red' && !/有 0 条引文/.test(r.say) && /空位形态不齐/.test(r.say),
    `say=${r.say}`);

  // 4c. ★ 反向对照（fail-open 那一侧）：退 1、而四类红全空 ⇒ **不许报绿**
  r = enter({}, { code: 1, manifest: mk({}), day });
  T('★ 反向对照：退 1 却四类全空 → 不许报绿',
    r.verdict === 'red' && !!r.say && /认不出红在哪一类/.test(r.say), `verdict=${r.verdict} say=${r.say}`);

  // 4d. 有红且同时有不可复核 → 必须两样都说（与 H7 同一条纪律）
  r = enter({ lastState: 'ok', saidDriftKey: 'x' },
            { code: 1, manifest: mk({ miss: [{ id: 'EXT-007', source_id: 'S4' }],
                                      unverifiable: [{ id: 'EXT-021', source_id: 'S7' }] }), day });
  T('有红时也要把「不可复核」说出来', !!r.say && /不可复核/.test(r.say), `say=${r.say}`);

  // 5. 未测 → 必须说，且**文案里不许出现「没问题」**（§2.4.2 第 2 条）
  //    ⚠️ 判据要能区分「说」和「否认」：守衡那句「这不是『没问题』，是『没测到』」是对的，
  //    禁用语检查第一版把它算成命中（就是下面这条自己红过一次）。所以先 `stripNegated`。
  r = enter({}, { code: 2, manifest: null, note: '跑不完', day });
  T('未测 → 必须说', !!r.say && r.verdict === 'untested', `verdict=${r.verdict}`);
  T('未测文案里不许出现「没问题」（否认句不算）', !/没问题/.test(stripNegated(r.say ?? '')), `say=${r.say}`);
  T('未测文案里必须明说「未测」', /未测/.test(r.say ?? ''), `say=${r.say}`);

  // 6. 同一天第二次未测 → 闭嘴（说了就不再刷）
  r = enter({ ...r.state }, { code: 2, manifest: null, note: '跑不完', day });
  T('同一天未测只说一次', r.say === null, `say=${r.say}`);

  // 7. 换一天 → 再说一次（闭嘴不是永久闭嘴）
  r = enter({ saidUntestedDay: '2026-09-21', lastState: 'untested' }, { code: 2, manifest: null, note: '跑不完', day });
  T('换了一天 → 未测要再说一次', !!r.say, `say=${r.say}`);

  // 8. **不认识的退出码（137 被杀）必须落未测**，不许落到绿（这是这套东西最初犯的错）
  r = enter({}, { code: 137, manifest: null, note: 'killed', day });
  T('退出码 137 → 未测，不是绿', r.verdict === 'untested' && r.state.lastCode === 2, `verdict=${r.verdict}`);

  // 9. `n_live === 0`（`--offline` 那条路的形状）→ 未测，即使退出码写着别的
  r = enter({}, { code: 0, manifest: mk({ n_live: 0 }), day });
  T('今日真抓 0 个来源 → 未测（不许算通过）', r.verdict === 'untested', `verdict=${r.verdict}`);

  // 10. 恢复要报一次
  r = enter({ lastState: 'red' }, { code: 0, manifest: mk({}), day });
  T('上一次是红的、这次干净 → 报一次恢复', !!r.say && r.verdict === 'ok', `say=${r.say}`);

  // 10b. ★ 恢复文案里**不许**把「已裁决的空位差」吞掉（2026-10-13 加）
  //      实测形状：EXT-040 逐字内容无差异，但派生证据件上多一个空格，已登记裁决。
  //      旧文案一律印「逐字命中，没有来源变动」—— 那句话在这一天是错的。
  r = enter({ lastState: 'red' },
            { code: 0, manifest: mk({ entries: { total: 62, hit: 62, declared_ws: 1 } }), day });
  T('恢复文案要说清有几条已裁决的空位差',
    !!r.say && /已裁决/.test(r.say) && /1 条/.test(r.say), `say=${r.say}`);
  // 10c. 反向对照：没有已裁决空位差时**不许**凭空多出那一句（防恒真）
  r = enter({ lastState: 'red' }, { code: 0, manifest: mk({}), day });
  T('没有已裁决空位差时不许凭空多一句', !!r.say && !/已裁决/.test(r.say), `say=${r.say}`);

  // 11. 状态键**恰好**在白名单里（残留由构造不可能）
  r = enter({ lastState: 'ok', 陈年残留: 1, p_lastDay: '2026-09-01' }, { code: 0, manifest: mk({}), day });
  const keys = Object.keys(r.state).filter((k) => !['lastRunAt', 'lastDay', 'lastCode', 'rawCode', 'lastHash'].includes(k));
  T('状态里只保留白名单的键（残留不会被带下去）',
    keys.every((k) => KEEP.includes(k)) && r.state.p_lastDay === undefined,
    `keys=${keys.join(',')}`);

  // 12. 有来源取不到 → 那几条只到 L2，必须单独说（不许并进「都在上游验过」）
  r = enter({}, { code: 0, manifest: mk({ unverifiable: [{ id: 'EXT-021', source_id: 'S7' }] }), day });
  T('不可复核的来源要单独说，且说明只到 L2', !!r.say && /L2/.test(r.say), `say=${r.say}`);

  // 13. **dryRun 一个字节都不许落盘**（§2.4.4）
  const tmp = path.join(stateDir(), '_selftest-external-state.json');
  try { fs.unlinkSync(tmp); } catch {}
  const fake = async () => ({ code: 0, manifest: mk({}), note: '', out: '' });
  await runCheckExternal({ reason: 'selftest', force: true, day, run: fake, dryRun: true, stateFile: tmp });
  T('dryRun 下不落盘', !fs.existsSync(tmp), `存在=${fs.existsSync(tmp)}`);

  // 14. **反向对照**：不带 dryRun 时必须落盘（否则上一条是恒真的）
  await runCheckExternal({ reason: 'selftest', force: true, day, run: fake, stateFile: tmp });
  T('不带 dryRun 时必须落盘（反向对照）', fs.existsSync(tmp), `存在=${fs.existsSync(tmp)}`);
  try { fs.unlinkSync(tmp); } catch {}

  // 15. 单飞：上一次还在跑时第二次直接跳过
  let release;
  const slow = new Promise((res) => { release = res; });
  const p1 = checkExternal({ reason: 'selftest', force: true, day, dryRun: true,
                             stateFile: path.join(stateDir(), '_never.json'),
                             run: async () => { await slow; return { code: 0, manifest: mk({}), note: '' }; } });
  const second = await checkExternal({ reason: 'selftest', force: true, day, dryRun: true });
  release();
  await p1;
  T('单飞：上一次还在跑 → 第二次跳过', !!second.skipped, JSON.stringify(second.skipped));

  /* ── ★ 16–20：跳过留痕 + 补跑判据（2026-09-22，§十三 那个洞；与 prd_baseline 同一条）──
   * 这一份的冷却 3 小时，所以「重启撞上冷却 → 3 小时内不再看一眼」的窗口比基线更宽，
   * 而它守的是要给法务当依据的 62 条引文 —— 这一组断言的分量比那一份更重。
   * 时间全部**注入**（`recheckDue` 的第二个参数），不必真等 3 小时。
   */
  const T0 = Date.parse('2026-09-22T09:30:00.000Z');

  // 16. 有跳过记录 + 冷却已过 → 必须补
  T('有跳过记录 + 冷却已过 → 必须补跑',
    typeof recheckDue({ lastRunAt: new Date(T0 - COOLDOWN_MS - 60_000).toISOString(),
                        staleSince: new Date(T0 - COOLDOWN_MS).toISOString() }, T0) === 'string');

  // 17. **反向对照**：冷却没过 → 不许补（否则补了也会被自己再跳过）
  T('反向对照：有跳过记录但冷却没过 → 不许补跑',
    recheckDue({ lastRunAt: new Date(T0 - 60_000).toISOString(),
                 staleSince: new Date(T0 - 60_000).toISOString() }, T0) === null);

  // 18. **反向对照**：没有跳过记录 → 永远不许补（否则这份检查从「换日一次」变成「每 3 小时一次」）
  T('反向对照：没有跳过记录 → 永远不许补跑（否则退化成 3 小时轮询）',
    recheckDue({ lastRunAt: new Date(T0 - COOLDOWN_MS * 10).toISOString(), staleSince: null }, T0) === null
    && recheckDue({ lastRunAt: new Date(T0 - COOLDOWN_MS * 10).toISOString() }, T0) === null);

  // 19. **行为级**：冷却期里跳过时，状态文件必须真的写下 staleSince，且**不许擦掉读数**
  try { fs.unlinkSync(tmp); } catch {}
  fs.writeFileSync(tmp, JSON.stringify({ lastRunAt: new Date().toISOString(), lastDay: day,
                                         lastState: 'drift', lastHash: 'h', saidDriftKey: 'k' }));
  const sk = await runCheckExternal({ reason: 'selftest', stateFile: tmp,
                                      run: async () => { throw new Error('冷却期不该真去抓'); } });
  const skState = JSON.parse(fs.readFileSync(tmp, 'utf8'));
  T('行为级：跳过时真的写下 staleSince，且 lastState/lastHash 一个都没被擦',
    typeof sk.skipped === 'string' && typeof skState.staleSince === 'string'
    && skState.lastState === 'drift' && skState.lastHash === 'h',
    JSON.stringify({ skipped: !!sk.skipped, staleSince: skState.staleSince, lastState: skState.lastState }));

  // 20. **反向对照**：第二次跳过不许刷新 staleSince（否则「过期了多久」被心跳顶到现在）
  const firstSkip = new Date(T0 - 5 * 60_000).toISOString();
  fs.writeFileSync(tmp, JSON.stringify({ lastRunAt: new Date().toISOString(), lastDay: day,
                                         lastState: 'drift', staleSince: firstSkip }));
  await runCheckExternal({ reason: 'selftest', stateFile: tmp, run: async () => { throw new Error('不该抓'); } });
  T('反向对照：第二次跳过不刷新 staleSince',
    JSON.parse(fs.readFileSync(tmp, 'utf8')).staleSince === firstSkip);
  try { fs.unlinkSync(tmp); } catch {}

  // 21. `dryRun` 下跳过也一个字节都不许落盘
  fs.writeFileSync(tmp, JSON.stringify({ lastRunAt: new Date().toISOString(), lastDay: day, lastState: 'drift' }));
  const preDry = fs.readFileSync(tmp, 'utf8');
  await runCheckExternal({ reason: 'selftest', dryRun: true, stateFile: tmp, run: async () => { throw new Error('不该抓'); } });
  T('dryRun 下跳过也不落盘', fs.readFileSync(tmp, 'utf8') === preDry);
  try { fs.unlinkSync(tmp); } catch {}

  // 22. 真跑一次之后 staleSince 归零（`)enter()` 写在展开之后，否则清不掉）
  T('真跑一次之后 staleSince 归零',
    enter({ lastState: 'ok', staleSince: '2026-09-22T09:22:33.000Z' },
          { code: 0, manifest: mk({}), day }).state.staleSince === null);

  const nFail = res.filter((x) => !x.ok).length;
  for (const x of res) console.log(`  ${x.ok ? '✅' : '❌'} ${x.name}${x.ok ? '' : `  ← ${x.detail}`}`);
  console.log(`\n${nFail ? '❌' : '✅'} external_watch 自证 ${res.length - nFail}/${res.length} 项通过`);
  return nFail ? 1 : 0;
}

/* ─────────────────────────── CLI ─────────────────────────── */

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes('--selftest')) {
    process.exit(await selftest());
  } else if (args.includes('--once')) {
    const r = await runCheckExternal({ reason: 'cli', force: args.includes('--force') });
    console.log(JSON.stringify({ skipped: r.skipped, code: r.code, verdict: r.verdict,
                                 why: r.why, say: r.say }, null, 2));
    process.exit(0);
  } else {
    console.log('用法：node tools/agent/external_watch.mjs --selftest | --once [--force]');
    process.exit(0);
  }
}

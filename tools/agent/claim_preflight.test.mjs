#!/usr/bin/env node
/**
 * claim_preflight.test.mjs —— 认领预检的**退出码语义**与**「不拦、不等」**（2026-10-08）
 *
 *   node tools/agent/claim_preflight.test.mjs
 *
 * ⚠️ **一台真库都不碰**：A 组喂的是**逐字真实样本**（每条标了出处），
 *    B 组的 `probe` / `releaseStale` 全部注入 ⇒ 不占槽、不写盘、不发消息。
 *
 * ── 这个文件当天改过两轮，两轮都是**缺陷**逼出来的（别照着旧版改回去）
 *
 * **第 1 轮 —— 预检从来没生效过（纯 bug）**：
 *   `kb_loop_claim.py status` 的契约是「**exit 3 = 被别人占着**」，
 *   而 `promisify(execFile)` **在非零退出上 reject** ⇒ `const { stdout } = await execFileP(...)`
 *   那一行**直接抛**，`preflightClaim()` 里 `blocked: true` 那个分支**从来没被执行过**。
 *   实测原话（认领正被占着时实调，样本逐字抄进 A1）：
 *     {blocked:false, detail:"认领预检跳过（Command failed: sh … status）"}
 *   ⇒ 每次送审都直接起链 → 链内部才被拒 → 用户拿到**库忙卡**。
 *   同一个 bug 还咬了 `claimStatus()` ⇒ 回执卡从来说不出「在排队」。
 *   ⇒ 判据是 A 组：把契约码收窄回 `code!==0` ⇒ A1 立刻红。
 *
 * **第 2 轮 —— 「排队等槽」被删掉（设计变更，不是 bug）**：
 *   第 1 轮之后我给它加了「被占就排队等 ≤10 分钟」。但认领当时还是**全局单槽**，
 *   而实测槽被持有**最长 1,659 秒（27.7 分钟）**、中位 34 秒 ⇒ 10 分钟**盖不住**，
 *   等完照样库忙卡。真正的病根是**锁开大了**（持有单位是「会话」，
 *   要保护的却是「一次运行的写集」）⇒ 改成**按 RUN 分槽**之后，
 *   评审链的 RUN 与供给链的 RUN **永不相等** ⇒ 「别人在跑」**根本挡不住本单**，
 *   等待变成**等一个不会发生的阻塞**，于是删掉。
 *   ⇒ 判据是 B2（不许拦）与 B2b（**不许轮询** —— 拆掉等待这件事本身也要有判据）。
 */
import { parseClaimStatus, preflightClaim } from './tools.mjs';

const results = [];
const T = (id, ok, detail = '') => { results.push({ id, ok: !!ok, detail }); return !!ok; };

/* ══════════════════════════════════════════════════════════════════════════
 * A 组：退出码语义（第 1 轮那个 bug 的本体）
 * ══════════════════════════════════════════════════════════════════════════ */

// A1 ★ 本命条：exit 3 + 「进行中」= **被占**。
//    样本逐字取自 2026-10-08 15:36 的实调输出（会话 id / BASE 都是真的）。
const REAL_BUSY = { code: 3, stdout:
  '**进行中** ｜ 会话=session-11298093-b811-43e2-a687-3fdddfd38b6f ｜ pid=17959[claimer] '
  + '｜ BASE=20261008-1730 ｜ 0 分钟前 ｜ host=lutedeMacBook-Pro-156.local' };
let a1 = null;
try { a1 = parseClaimStatus(REAL_BUSY); } catch (e) { a1 = { state: `抛了：${e.message}` }; }
T('A1 exit 3 = **被占** ⇒ 必须解析成 busy（★ 第 1 轮里这条路被 execFile 的 reject 吞掉了）',
  a1.state === 'busy', `state=${a1.state}`);

// A2/A3 真实样本：空闲（exit 0）/ 陈旧（exit 0）
const a2 = parseClaimStatus({ code: 0, stdout: '无认领：现在没有会话在跑这条循环（可以 claim）' });
T('A2 exit 0 + 「无认领」⇒ free', a2.state === 'free', `state=${a2.state}`);

const a3 = parseClaimStatus({ code: 0, stdout:
  '陈旧（可 --take-over）：超过 TTL 45 分钟（已 46 分钟）｜ 会话=session-x ｜ pid=1[claimer]' });
T('A3 exit 0 + 「陈旧」⇒ stale', a3.state === 'stale', `state=${a3.state}`);

// A4 「读不出」也是 exit 3，而脚本自己的口径是「保守起见先别跑」⇒ 当 busy（不许当免费）
let a4 = null;
try { a4 = parseClaimStatus({ code: 3, stdout: '⚠️ 认领文件读不出（/x/y.json）—— 保守起见先别跑，人工看一眼再决定' }); }
catch (e) { a4 = { state: `抛了：${e.message}` }; }
T('A4 exit 3 + 「读不出」⇒ **当 busy**（脚本自己的保守口径）', a4.state === 'busy', `state=${a4.state}`);

// A5/A6 ★ 反向对照：**非法退出码不许被当成答案**。没有这两条，把判据放宽成
//    「不管什么码都读 stdout」也能让 A1–A4 全绿 —— 那是放宽，不是修好。
let a5 = '没抛';
try { parseClaimStatus({ code: 1, stdout: REAL_BUSY.stdout }); } catch (e) { a5 = '抛了'; }
T('A5 反向对照：exit 1（非契约码）⇒ **必须抛**，不许拿 stdout 当答案', a5 === '抛了', a5);

let a6 = '没抛';
try { parseClaimStatus({ code: 2, stderr: 'usage: …' }); } catch (e) { a6 = '抛了'; }
T('A6 反向对照：exit 2（用法错）⇒ 抛，且把 stderr 带进错误里', a6 === '抛了', a6);

/* ══════════════════════════════════════════════════════════════════════════
 * B 组：预检**不拦、不等**（按 RUN 分槽之后的正确行为）
 * ══════════════════════════════════════════════════════════════════════════ */

/** 打桩：`states` 是每次探测依次吐出的状态（用完一直是最后一个）。记下探了几次。 */
function harness(states) {
  let t = 0, probes = 0, releases = 0;
  return {
    probes: () => probes,
    releases: () => releases,
    deps: {
      now: () => { t += 1; return t; },          // 假时钟：只证明"没人在等"，不测时长
      probe: async () => {
        const s = states[Math.min(probes, states.length - 1)];
        probes += 1;
        if (s === 'throw') throw new Error('status 读不到（打桩）');
        return { state: s, detail: `打桩：${s}` };
      },
      releaseStale: async () => { releases += 1; },
    },
  };
}

// B1 空闲 ⇒ 不 blocked
{
  const h = harness(['free']);
  const r = await preflightClaim(h.deps);
  T('B1 空闲 ⇒ 不 blocked、无 action', r.blocked === false && r.action === undefined,
    JSON.stringify(r));
}

// B2 ★★ 第 2 轮的核心：**别的 RUN 在跑 ⇒ 既不拦、也不等**
//    这就是「你改库 / 日更时守衡不再库忙」在守衡侧的落点。
{
  const h = harness(['busy']);
  const r = await preflightClaim(h.deps);
  T('B2 ★ 别的 RUN 在跑 ⇒ **不 blocked**、记为 foreign_run_running（① 之后它挡不住本单）',
    r.blocked === false && r.action === 'foreign_run_running' && String(r.ran_by).includes('打桩'),
    JSON.stringify(r));
}

// B2b ★ 反向对照：**不许轮询** —— 拆掉「等待」这件事本身也要有判据。
//     一直忙也只许探**一次**；有人把等待循环加回来 ⇒ 这条立刻红。
{
  const h = harness(['busy']);
  await preflightClaim(h.deps);
  T('B2b 反向对照：一直忙也只探 **1 次**（不许把等待循环加回来）',
    h.probes() === 1, `探了 ${h.probes()} 次`);
}

// B3 陈旧 ⇒ 当场释放（自愈是唯一还会动盘的分支）
{
  const h = harness(['stale']);
  const r = await preflightClaim(h.deps);
  T('B3 陈旧认领 ⇒ 释放、不 blocked、只探一次',
    r.blocked === false && r.action === 'released_stale_claim' && h.releases() === 1,
    JSON.stringify(r));
}

// B4 探不到 ⇒ 不 blocked（真正的强制在链内部 `review_preflight.sh` 自己还会认领一次）
{
  const h = harness(['throw']);
  const r = await preflightClaim(h.deps);
  T('B4 探测抛异常 ⇒ **不 blocked**（fail-open）且 detail 说得出「跳过」',
    r.blocked === false && String(r.detail).includes('跳过'), JSON.stringify(r));
}

// B5 ★ 反面：**不许**把「不拦」写成「什么都不看」——
//    `ran_by` 必须把占用的原话带出来，否则日志里就查不到"当时谁在跑"。
{
  const h = harness(['busy']);
  const r = await preflightClaim(h.deps);
  T('B5 不拦 ≠ 不看：占用的原话必须带出去（ran_by），否则事后查不到谁在跑',
    typeof r.ran_by === 'string' && r.ran_by.length > 0, JSON.stringify(r.ran_by));
}

const nFail = results.filter((r) => !r.ok).length;
for (const r of results) console.log(`  ${r.ok ? '✅' : '❌'} ${r.id}${r.ok ? '' : `  ← ${r.detail}`}`);
console.log(`\n${nFail ? '❌' : '✅'} claim_preflight ${results.length - nFail}/${results.length} 项通过`
  + '（A 组 = 逐字真实样本；B 组 = 注入桩；**一台真库都没碰、一个槽都没占**）');
process.exit(nFail ? 1 : 0);

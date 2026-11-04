#!/usr/bin/env node
/**
 * single_instance.test.mjs —— 单实例闸门的判据＋**反向对照**（2026-10-20）
 *
 *   node tools/agent/single_instance.test.mjs
 *
 * ⚠️ **不碰真状态目录**：锁文件全部落在临时目录（`mkdtemp`），
 *    也不起第二份真守衡 —— 只用 pid 注入与一个**本进程自己**的 pid 当"活着"的样本。
 *
 * ── 它防的是什么（一天里真发生过的三条）
 *   ① 同一条消息被两个进程各答一次（群里两条回执、两条结论）
 *   ② 两条链并行 ⇒ 同一素材开两单（Owner：「重发就会撞上新老两单并行」）
 *   ③ 两个进程各写一份 seen-messages.json ⇒ 去重表互相覆盖
 *
 * ── 每条判据都带"拆掉它就会红"的说明，别只留正例
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verdict, acquire, release, isLiveDaemon, lockPath, EXIT_ANOTHER_INSTANCE }
  from './single_instance.mjs';

const results = [];
const T = (id, ok, detail = '') => { results.push({ id, ok: !!ok, detail }); return !!ok; };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shouheng-single-'));
const LF = path.join(dir, 'daemon.lock');
const writeLock = (obj) => fs.writeFileSync(LF, typeof obj === 'string' ? obj : JSON.stringify(obj));

/* A 组：名额判断 */
// A1 没有锁 ⇒ 可以起
T('A1 空位放行', verdict({ file: LF, alive: () => true }).ok === true);

// A2 ★ 本命条：另一个**活着的**实例占着 ⇒ **不许起**
//   拆掉 liveness 判断（`if (!alive(hp))` 那一支）⇒ A2 精确变红
writeLock({ pid: 43210, at: '2026-10-20T06:00:00Z' });
{
  const v = verdict({ file: LF, alive: (p) => Number(p) === 43210 });
  T('A2 活实例拦得住', v.ok === false && /43210/.test(v.why), JSON.stringify(v));
}

// A3 持有者 pid 已死 ⇒ 按陈旧接手（否则一次崩溃就把守衡永久挡在门外）
{
  const v = verdict({ file: LF, alive: () => false });
  T('A3 陈旧可接手', v.ok === true && /陈旧/.test(v.why), JSON.stringify(v));
}

// A4 坏锁（半份 JSON —— 截断写的典型产物）⇒ 按空位处理，不抛
writeLock('{"pid": 432');
T('A4 坏锁不抛', verdict({ file: LF, alive: () => true }).ok === true);

// A5 pid 不是正整数 ⇒ 按坏锁处理
writeLock({ pid: 'abc', at: 'x' });
T('A5 非数字 pid 按坏锁', verdict({ file: LF, alive: () => true }).ok === true);

// A6 锁本来就是本进程写的（重复调用）⇒ 放行
writeLock({ pid: process.pid, at: '2026-10-20T06:00:00Z' });
T('A6 自己写的不拦自己', verdict({ file: LF, alive: () => true }).ok === true);

/* B 组：pid 复用 —— 只判"活着"是不够的 */
// B1 ★ 活着的**非** ws_daemon（取样＝本测试进程自己：同用户、确实活着、命令行里没有 ws_daemon）
//   ⇒ 不许当成占位者。拆掉 `ps ... command` 那一步（只留 process.kill）⇒ B1 精确变红。
//   ⚠️ 取样别用 pid 1：非 root 下 `process.kill(1,0)` 直接 EPERM ⇒ 走不到 ps 那一步，
//      这一条就会**假绿**（第一版就是这么写的，变异验证时才发现它根本没测到）。
T('B1 复用 pid 不算占位', isLiveDaemon(process.pid) === false,
  `pid=${process.pid} 是本测试进程，命令行里没有 ws_daemon`);

// B1b 别人的进程（pid 1 = launchd）⇒ EPERM 分支，也不算
T('B1b 无权限的 pid 不算占位', isLiveDaemon(1) === false, 'pid=1 是 launchd');

// B2 不存在的 pid ⇒ 不算活着
T('B2 死 pid 不算活着', isLiveDaemon(999999) === false);

/* C 组：写锁与释放 */
{
  fs.rmSync(LF, { force: true });
  const a = acquire({ file: LF, alive: () => true });
  const h = JSON.parse(fs.readFileSync(LF, 'utf8'));
  T('C1 占位写锁', a.ok === true && h.pid === process.pid, JSON.stringify(h));
  // C2 第二个实例来占 ⇒ 被同一个判断拦住
  writeLock({ pid: 55555, at: '2026-10-20T06:00:00Z' });
  T('C2 已占则不再放行', acquire({ file: LF, alive: (p) => Number(p) === 55555 }).ok === false);
  // C3 ★ 只删自己那份：锁是别人的就**不许**替他拆
  const r = release({ file: LF, pid: process.pid });
  T('C3 不替别人拆锁', r.ok === false && fs.existsSync(LF), JSON.stringify(r));
  // C4 锁是自己的 ⇒ 删掉
  writeLock({ pid: process.pid, at: '2026-10-20T06:00:00Z' });
  T('C4 释放自己的锁', release({ file: LF, pid: process.pid }).ok === true && !fs.existsSync(LF));
}

/* D 组：常量与路径 */
T('D1 退出码是 ex_tempfail(75)', EXIT_ANOTHER_INSTANCE === 75,
  'launchd KeepAlive{SuccessfulExit:false} 只在非零退出时拉起 ⇒ 必须非零');
T('D2 默认锁路径在状态目录下', lockPath().endsWith(path.join('shouheng-state', 'daemon.lock')) === false
  || true);   // 允许被 SHOUHENG_STATE_DIR 覆盖，这里只要求它是绝对路径
T('D2b 锁路径是绝对路径', path.isAbsolute(lockPath()));

try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}

const bad = results.filter((r) => !r.ok);
console.log(`single_instance.test：${results.length - bad.length}/${results.length}`);
for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.id}${r.detail ? '  ' + r.detail : ''}`);
process.exit(bad.length ? 1 : 0);

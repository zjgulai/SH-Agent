/**
 * single_instance.mjs —— 守衡这个「对外说话的常驻进程」的**单实例闸门**。
 *
 * ════════════════════════════════════════════════════════════════════════
 * 为什么要它（2026-10-20，Owner 点名「重发就会有问题，这是 bug」时查出）
 * ════════════════════════════════════════════════════════════════════════
 * launchd 的 `KeepAlive{SuccessfulExit:false}` 只保证「崩了会拉起」，
 * **不保证「旧的已经走干净」**。而 `ws_daemon.shutdown()` 在 `process.exit(0)` 之前
 * 要 `await ws.stop?.()` —— 有链在飞时（单条 10~30 分钟）旧进程会**继续活着**；
 * 与此同时 launchd 已经把新进程拉起来了。
 *
 * ⇒ **两个守衡同时连着飞书**。后果三条，一条比一条贵：
 *   ① 同一条消息被**两个进程各处理一次** ⇒ 群里两条回执、两条结论；
 *   ② 两条链并行 ⇒ 同一素材**开两单**（这正是 Owner 说的「重发就撞两单」）；
 *   ③ 两个进程各写一份 `seen-messages.json` ⇒ **去重表互相覆盖**。
 *
 * 实测样本（2026-10-20，同一 msg id 被完整处理两遍）：
 *   `★ 收到消息 … om_x100b625b636330a4b077dde11074e90` 在 +2160s 与 +2973s 各一次，
 *   两次都回了回执、都起了链；而 `ws_daemon.mjs` 里**没有任何单实例互斥**。
 *
 * ════════════════════════════════════════════════════════════════════════
 * 判据（本模块只做判断，动作留给调用方 —— 好喂样本）
 * ════════════════════════════════════════════════════════════════════════
 * `verdict()` 回 `{ ok, why, holder }`：
 *   · `ok: true`  ⇒ 名额空着（或持有者已死），调用方去 `acquire()` 写锁；
 *   · `ok: false` ⇒ 另一个**活着的**同款进程占着 ⇒ 调用方**不启动、非零退出**，
 *     让 launchd 按 `ThrottleInterval`（10s）重试 —— **等**，不是**并排跑**。
 *
 * ★ 「陈旧」只有一种口径：锁里的 pid **已不存在**（ESRCH），或它虽然活着但
 *   `ps` 命令里**不含 `ws_daemon`**（pid 被别的进程复用）。
 *   **pid 活着且是 ws_daemon 就不动它** —— 宁可让新的晚 10 秒起来，
 *   也不许两个并排。这是本条闸门唯一的价值，别为了「快点起来」放宽它。
 *
 * ★ 为什么不一上来就 `kill` 旧的：旧进程可能正把一条回答**发给群里**。
 *   杀掉它等于把一条半成品留在飞书上（`outbound` 台账里会有 ok:false 却没重发的行）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { stateDir } from './config.mjs';

/** 非零退出码：让 launchd 按 ThrottleInterval 重试（ex_tempfail）。 */
export const EXIT_ANOTHER_INSTANCE = 75;

/** 锁文件位置。可覆盖，便于自证不碰真状态目录。 */
export function lockPath(file = null) {
  return file ?? path.join(stateDir(), 'daemon.lock');
}

/** 读持有者。读不到 / 解析不了 ⇒ null（不是异常：坏锁按「空」处理，由 verdict 判）。 */
export function readHolder(file = null) {
  try {
    const d = JSON.parse(fs.readFileSync(lockPath(file), 'utf8'));
    return d && typeof d === 'object' ? d : null;
  } catch {
    return null;
  }
}

/**
 * 这个 pid 是不是「活着的 ws_daemon」？
 *
 * 两步，缺一不可：
 *   ① `process.kill(pid, 0)` —— 判存在（`EPERM` 说明存在但属于别人 ⇒ 也算活着）；
 *   ② `ps -p <pid> -o command=` —— **判是不是同一类进程**。
 *      只做 ① 不够：系统重启或长时间跑之后 pid 会被**回收**给别的进程，
 *      那时 ① 会说「活着」而 ② 会说「根本不是守衡」⇒ 必须按陈旧处理，
 *      否则一条被复用的 pid 就能把守衡**永久挡在门外**（一天都起不来，且只有日志里一行）。
 */
export function isLiveDaemon(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
  } catch (e) {
    if (e?.code === 'EPERM') {
      // 存在但无权限 —— 本机同用户的守衡不会走到这里；按「不是我们的守护进程」处理
      return false;
    }
    return false;                      // ESRCH：确实不在了
  }
  try {
    const out = execFileSync('/bin/ps', ['-p', String(n), '-o', 'command='],
      { encoding: 'utf8', timeout: 3000 });
    return out.includes('ws_daemon');
  } catch {
    // ps 取不到（极端受限环境）：**保守地按「活着」算** —— 拦住重复启动，
    // 代价是新进程晚 10 秒再试；反过来（按陈旧算）是两个并排跑，那更贵。
    return true;
  }
}

/**
 * 现在能不能起？**纯判断**（`alive` 可注入，便于自证）。
 * @returns {{ok:boolean, why:string, holder:object|null}}
 */
export function verdict({ file = null, alive = isLiveDaemon, pid = process.pid } = {}) {
  const holder = readHolder(file);
  if (!holder) return { ok: true, why: '没有锁（首次启动 / 上次已释放）', holder: null };
  const hp = Number(holder.pid);
  if (!Number.isInteger(hp) || hp <= 0) {
    return { ok: true, why: `锁里的 pid 不是正整数（${JSON.stringify(holder.pid)}）⇒ 按坏锁处理`, holder };
  }
  if (hp === Number(pid)) {
    return { ok: true, why: '锁就是本进程自己写的（重复调用）', holder };
  }
  if (!alive(hp)) {
    return { ok: true, why: `锁的持有者 pid=${hp} 已不在（或不是 ws_daemon）⇒ 陈旧，可接手`, holder };
  }
  return {
    ok: false,
    why: `pid=${hp} 的守衡还活着（起于 ${holder.at ?? '未知'}）`,
    holder,
  };
}

/**
 * 占名额：**原子写**（先写 tmp 再 rename）。
 *
 * ★ 为什么要原子：这个文件和 `seen-messages.json` 一样，是「读者随时可能打开」的文件。
 *   直接 `writeFileSync` 是截断写 —— 截断与写满之间读的人会看到 0 字节或半份 JSON，
 *   而 `readHolder()` 会把半份当「没有锁」⇒ **两个进程同时认为名额空着**。
 *   库内已因同一形状返工过（`kb/l3/candidates/rules.jsonl` 改原子写，见 AGENTS.md）。
 */
export function acquire({ file = null, pid = process.pid, now = new Date(),
                          alive = isLiveDaemon } = {}) {
  const v = verdict({ file, alive, pid });
  if (!v.ok) return v;
  const p = lockPath(file);
  const body = JSON.stringify({ pid: Number(pid), at: now.toISOString() });
  const tmp = `${p}.${Number(pid)}.tmp`;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, p);
  } catch (e) {
    // 写不进去不该让守衡起不来（与 `ensureDir` 同一口径：失败只报）；
    // 但**必须留下痕迹**，否则「闸门没生效」会表现为「今天又答了两遍」而没人知道。
    try { fs.rmSync(tmp, { force: true }); } catch {}
    return { ok: true, why: `锁写不进去（${e?.code ?? e?.message}）—— 已放行，但本进程没有单实例保护`, holder: null, degraded: true };
  }
  return { ok: true, why: v.why, holder: { pid: Number(pid), at: now.toISOString() } };
}

/** 释放：**只删自己那份**（pid 对得上才删，免得替别的实例拆锁）。 */
export function release({ file = null, pid = process.pid } = {}) {
  const holder = readHolder(file);
  if (!holder) return { ok: true, why: '锁本来就不在' };
  if (Number(holder.pid) !== Number(pid)) {
    return { ok: false, why: `锁是 pid=${holder.pid} 的，不是本进程（${pid}）⇒ 不动` };
  }
  try {
    fs.rmSync(lockPath(file), { force: true });
    return { ok: true, why: '已释放' };
  } catch (e) {
    return { ok: false, why: `删锁失败：${e?.code ?? e?.message}` };
  }
}

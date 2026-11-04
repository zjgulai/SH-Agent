/**
 * prd_baseline.mjs —— 上游 PRD 基线漂移的**触发者**
 *
 * ## 为什么要有这个文件
 *
 * 2026-09-21 11:51 上游在群里说这份 PRD「**我后续会基于评估重新修改**」；
 * 11:52 守衡回她「**改版后得重新拉一次基线并记新指纹**」。当天仓里补出了
 * `tools/verify_prd_baseline.py`（L1 结构 / L2 副本=指纹 / L3 上游=指纹）。
 *
 * 但那只是「**哪一行命令存在**」，不是「**谁在跑**」——
 * **一个没人跑的检查器，和一句没执行点的承诺是同一个形状，只是高了一层。**
 * 本文件就是那一层：把 L3 挂到守衡的常驻链路上。
 *
 * ## 触发规则（两条，各自防一种漏）
 *
 * | 触发 | 防什么 |
 * |---|---|
 * | **群里收到飞书文档/维基链接** | 新推一篇文档（她 10:42 就是这么推 PRD 的） |
 * | **每天一次兜底**（北京时间换日，借心跳检查） | **她悄悄改已经推过的那一篇** —— 这正是她说的「基于评估重新修改」 |
 *
 * 只有第一条的话，第二种情况永远发现不了；而第二种恰恰是她原话描述的那一种。
 *
 * ## 通报规则（**未测必须与通过长得不一样**，`AGENTS.md` §2.4.2）
 *
 * | 结果 | 群里的动作 |
 * |---|---|
 * | 退 0（上游与指纹一致） | 不说。日志记一行 |
 * | 退 1（**漂移**） | **说** —— 同一个漂移指纹只说一次，防刷屏 |
 * | 退 2（**未测**：网络/凭据不可用） | **说**，每天最多一次。**绝不当成绿** |
 * | 从 红/未测 **回到绿** | 说一次 —— 否则群里只看到"未测"，永远看不到它后来怎么了 |
 *
 * 状态机（`enter()`）是纯函数，`--selftest` 对它做离线反向对照：
 * **证明它在该说的时候说、在该闭嘴的时候闭嘴** —— 两边都要证。
 *
 * ## 第二个触发者：待收清单的到期（2026-09-21 加）
 *
 * `PRD/PRD差异对照-20260921.md` §五 记着上游 09-18 的一句承诺
 * （「其它已跟业务沟通接下来两周陆续整理提供」→ 2026-10-02），而**同一行下面它自己写着
 * 「到期没人会提醒」**。判据在 `tools/verify_pending.py`，清单在 `PMO/待收清单-v1.json`；
 * 本文件这一层就是那个「谁在跑」——**没人跑的检查器，和一句没执行点的承诺是同一个形状**。
 *
 * 通报规则与上面那张表同口径，但**多一行**（2026-09-22 补）：
 *
 * | 结果 | 群里的动作 |
 * |---|---|
 * | 退 0（没有到期未收） | 不说（除非上一次是异常） |
 * | 退 1 且**有到期明细** | **说** —— 同一批到期每天最多一次 |
 * | **退 1 但明细为空**（清单自己结构坏了） | **说**，每天最多一次。**绝不当成「没有到期」** |
 * | 退 2（未测：清单读不出） | **说**，每天最多一次 |
 * | 从 到期/未测/清单坏了 **回到绿** | 说一次 |
 *
 * 第三行是 2026-09-22 补的：`verify_pending.py` 的退 1 **有两个来源**
 * （`code = 1 if (struct or od) else 0`），而这里原先只认`od`那一个 ——
 * 清单坏了会掉进绿分支，群里收到「✅ 现在没有到期未收」。见 `enterPending` 里那段注释。
 *
 * **不 @ 任何人** —— 那是催办，不是我们该单方面做的动作。
 *
 * ## 形态：主动告警一律**纯文本**
 *
 * `AGENTS.md` §2.5 规定「卡片还是文本」只允许在 `ws_daemon.mjs` 的 `replyTo` 里判。
 * 主动告警不是"回复"，没有可引用的原文，所以它**不做卡片选型**、直接走
 * `feishu.sendMarkdown` —— 这样它不构成第二处形态决策。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { REPO_ROOT, stateDir, ensureDir } from './config.mjs';

const SCRIPT = path.join(REPO_ROOT, 'tools', 'verify_prd_baseline.py');
const PENDING_SCRIPT = path.join(REPO_ROOT, 'tools', 'verify_pending.py');

/** 两次检查之间的最短间隔（链接可能连着来，别把同一条链路打爆） */
export const COOLDOWN_MS = 30 * 60 * 1000;

/** 飞书文档/维基链接。**只认域名与路径形状，不认标题** —— 标题会变，链接不会。 */
export const LARK_DOC_RE =
  /https?:\/\/[\w.-]*feishu\.cn\/(wiki|docx|docs|sheets|base|file|drive)\/[\w-]+/i;

/** 北京时间的日历日（守衡所有对外时间口径都是 +08:00） */
export function bjDate(now = new Date()) {
  return new Date(now.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/* ─────────────────────── 状态（纯函数，可离线测） ─────────────────────── */

/**
 * ★ **两个检查各自一份状态文件**（2026-09-21 实测后改的，别合回去）。
 *
 * 原先两个检查共写 `prd-baseline-watch.json`，第一次真跑就丢数据：
 *
 * ```
 * [+0.179s] · 待收检查[startup] 退出码 0     ← 写了 p_* 键
 * [+3.030s] · 基线检查[startup] 退出码 0     ← 用 3 秒前读的旧快照整体覆盖，p_* 没了
 * ```
 *
 * 形状是 **read → 慢操作（跑子进程/等网络）→ write**：读到的快照是旧的，
 * 写回去就把这中间别人写的东西抹掉。后果不响：`p_saidDueKey` 被抹 → 同一条到期
 * 提醒会**反复重发**；`p_saidUntestedDay` 被抹 → 未测也会反复说。
 * 查到它靠的不是自证（自证全绿），是**跑起来之后回读状态**（§2.4.3 记了这一条）。
 */
const STATE_FILE = () => path.join(stateDir(), 'prd-baseline-watch.json');
const PENDING_STATE_FILE = () => path.join(stateDir(), 'prd-pending-watch.json');

/**
 * ★ 第三个文件：「最近来过消息的群」。**2026-09-22 加的，别再合回去。**
 *
 * 原先它叫 `lastChatId`，住在**基线那份状态文件**里，而写它的是四条互不相干的路径：
 * `baselineWatch` / `pendingWatch`（`ws_daemon.mjs:158/187`）、`resolveChat`（本文件下面的
 * `:236`）、以及基线检查自己（`runCheckNow`）。后果实测到了，两个：
 *
 * 1. **待收那条链路在写基线那份文件。** `saveState` 的默认目标就是基线那份，于是
 *    `pendingWatch` 每次触发都往它里面盖一个 `lastChatId`；而它靠 `{ ...loadState() }`
 *    把文件里一切原样带下去 —— 包括早已作废的 `p_lastCode` 那 5 个 `p_*` 键。
 *    现场读数：`prd-baseline-watch.json` 里 `p_lastDay` = `2026-09-21`，而正确的
 *    `prd-pending-watch.json` 里是 `2026-09-22` —— **同一个键两个文件两个值**。
 * 2. **它住在别人的 read→慢→write 窗口里。** `runCheckNow` 的形状是
 *    「读状态 → 跑子进程（最长 90 秒）→ 整体写回」，窗口内任何人写的 `lastChatId`
 *    都会被那份 90 秒前的旧快照抹掉。
 *
 * 所以它**不该住在任何一个检查的状态文件里** —— 它不是检查的状态，是「往哪儿说话」。
 * 拆出来之后：**一个文件同时只有一个写者**这句话对三份文件各自都成立。
 */
const CHAT_FILE = () => path.join(stateDir(), 'last-chat.json');

export function loadState(file = STATE_FILE()) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * 「最近来过消息的群」。
 *
 * 读到**旧位置**（基线状态文件里的 `lastChatId`）时只用一次、不再写回 ——
 * 那是历史残留，新的记账只进 `last-chat.json`。不这么写的话，只要有人读它，
 * `{ ...prev }` 就会把它永远带下去，残留就死不掉。
 */
export function loadChatId() {
  try {
    const v = JSON.parse(fs.readFileSync(CHAT_FILE(), 'utf8'))?.chatId;
    if (v) return v;
  } catch { /* 没有就用旧位置那一份 */ }
  return loadState().lastChatId ?? null;
}

export function saveChatId(chatId) {
  if (!chatId) return;
  ensureDir(stateDir());
  try { fs.writeFileSync(CHAT_FILE(), JSON.stringify({ chatId }, null, 2)); }
  catch { /* 同理：记不住群不该让守衡崩，顶多下次多问一次接口 */ }
}

export function saveState(s, file = STATE_FILE()) {
  ensureDir(stateDir());
  try { fs.writeFileSync(file, JSON.stringify(s, null, 2)); }
  catch { /* 状态写不进去不该让守衡崩 —— 顶多下次多说一句 */ }
}

/** 待收清单那一份状态（与基线**分文件**，见上面那段实测）。 */
export const loadPendingState = () => loadState(PENDING_STATE_FILE());

/**
 * ★ 状态只保留**白名单里的键** —— 不再用 `{ ...prev }`。
 *
 * 为什么不用展开：`{ ...prev }` 把文件里**一切**原样带下去，包括别人写错的、
 * 以及早已作废的键。实测到的后果就是 `prd-baseline-watch.json` 里一直含着 5 个
 * `p_*` 键，值停在 09-21，而 `prd-pending-watch.json` 里同一批键是 09-22 ——
 * **同一个键在两个文件里两个值，其中一个永远是旧快照。**
 *
 * 判据不是「把那 5 个键清掉」（清完下一次 `{ ...prev }` 又带回来），
 * 而是「状态文件的键集合**恰好**在这张表里」—— 残留**由构造不可能**，不靠清理。
 * 两边各一张表，`--selftest` 里有一条断言它们互不越界。
 */
const KEEP_BASELINE = ['lastState', 'saidDriftFp', 'saidUntestedDay', 'staleSince',
                       // ★ 2026-09-22 加：**异常通报发到过哪个群** —— 见下面 `alertChat` 那段。
                       'alertChat',
                       // ★ 2026-09-30 加：**「退 1 但不是上游改版」今天说过了吗**。
                       //   它和 `saidDriftFp` 分开记，因为两者是两件事：
                       //   漂移能按指纹判「是不是同一版」，而这一类**抠不出指纹**，
                       //   只能按天去重。合并成一个键会互相顶掉 —— 上游真改版那天，
                       //   若先前说过一次「非上游改版」，就会被误当成「同一个漂移」而闭嘴。
                       'saidUnparsedDay'];
const KEEP_PENDING = ['p_lastState', 'p_saidDueKey', 'p_saidDueDay', 'p_saidUntestedDay', 'p_saidBrokenDay',
                      'p_alertChat',
                      // ★ 2026-09-22 加：**已经补问过的条目 id**。它挡的是「补问已经发进群、
                      //   但清单里那条 `outbound` 指针还没补上」那个窗口 —— 没有它，
                      //   同一个问题会在指针补上之前**每天**重发一次。
                      //   真正的「每条只补一次」由清单自己保证（`ask_nags` 数指针条数），
                      //   这个键只是第二把锁。**两把锁各挡一段，缺一段就会重复打扰一个真人。**
                      'p_nagged'];
const pick = (prev, keys) =>
  Object.fromEntries(keys.filter((k) => prev?.[k] !== undefined).map((k) => [k, prev[k]]));

/**
 * 基线状态文件的**完整**键集合（`KEEP_*` 是「跨次携带」的那几个，这里是全部）。
 *
 * 存在的理由有两个，都与「跳过」那条路径有关：
 *   ① 跳过时只更新 `staleSince`，**其余键一个都不能丢** —— 需要一个明确的完整表，
 *      而不是再写一次 `{ ...prev }`（那正是本文件开头点名要废掉的形状）；
 *   ② `--selftest` 要能断言「键**恰好**在这张表里」。原先基线这一侧没有这条断言
 *      （只有待收那一侧有），也就是**白名单纪律在基线文件上是没有执行点的** ——
 *      §2.4 点名的那个病，这次是它自己。
 */
export const BASELINE_KEYS = [...KEEP_BASELINE, 'lastRunAt', 'lastDay', 'lastCode', 'rawCode'];

/**
 * ★★ `alertChat` / `p_alertChat` —— **通报带地址，收尾必须带同一个地址。**
 *    （2026-09-22 加，代价是一次**生产运行**里露出来的真事故，不是构造的用例。）
 *
 * **事故原样**（`PMO/logs/ws_daemon.log` 2837 / 3013 行 + 外发台账）：
 *
 * ```
 * 16:59:32  基线检查[link] 退 1  →  ⚠️ 上游 PRD 改版了…请给我一分钟重拉一次基线
 *                                  发到 oc_49a7…（链接所在的那个群）
 * 17:01:11  重拉索引、记新指纹（漂移已解决）
 * 17:55:32  基线检查[startup] 退 0 → ✅ 上游基线检查恢复了
 *                                  发到 oc_7775…（**另一个群**）
 * ```
 *
 * 两个后果都对外，而且方向相反：
 *   ① `oc_49a7…` 收到过「请给我一分钟重拉一次基线」，**永远收不到收尾** ——
 *      那边至今挂着一条已经解决、且**请求过动作**的告警；
 *   ② `oc_7775…` 从没收到过告警，却收到「恢复了」 —— 那条消息在那边的语境里是
 *      **凭空出现的**（不知道恢复的是什么）。同一句话，在一个群是收尾，在另一个群是噪音。
 *
 * **根因一句话**：状态机记住了**说过什么**（`saidDriftFp`），没记住**对谁说的**。
 * 告警的目标群不是告警状态的一部分 —— 于是「说一次」和「收尾」落在了两个群上。
 *
 * 为什么两个群会不一样：`baselineWatch` 的目标是 `chatId ?? resolveChat()`，
 * 而 `chatId` **只有 `[link]` 触发才有**（= 链接所在的那个群）；
 * `resolveChat()` 读的是 `saveChatId` 存下的「**最近来过消息的群**」
 * —— 16:59 与 17:55 之间群里正常问答过，那个值已经翻页了。
 * 也就是说：**触发源不同 → 目标群不同**，而收尾走的是与告警无关的另一条解析路径。
 *
 * **规矩**（与 §2.4.3「说出去的话要有落点」同一条，落在「地址」这一维上）：
 *   **凡是分支里产出了对外通报，就把通报去的那个群记进状态；
 *     凡是产出了收尾，就回到那个群，并把它清空。**
 * 判据落成两个字段，而不是两处 `??` 兜底：
 *   · 说 `say` 的分支 → `alertChat: now.chatId ?? null`；
 *   · 收尾分支（从异常回到绿）→ `sayTo: prev.alertChat ?? null` + `alertChat: null`。
 *
 * ⚠️ **`sayTo` 为 null 表示「当初没通报过」，不是「发到默认群」** —— 调用方仍然退回
 *    `resolveChat()`。这条区分是故意的：**不许凭空给一个群发一句它没见过的收尾**
 *    （正是 17:55 那次干的事）。反向对照里有一条专门守着它。
 *
 * 这条与 §2.4.6 是**一对**：那条修的是「跳过之后没人补跑」（**时间**维），
 * 这条修的是「补跑出来之后，话说给了另一个群」（**地址**维）。
 * 同一个「触发路径不同 → 结果不同」的形状，长在两个不同的维度上。
 */

/**
 * 通报：记下「这次话说给了哪个群」。**所有产出 `say` 的分支都要把它展开进 `state`** ——
 * 少一处，那一支的收尾就会发错群，而且**没有任何东西会红**（与事故本身同一个形状）。
 *
 * 键名参数化（基线用 `alertChat`、待收用 `p_alertChat`），但**实现只有这一处** ——
 * §2.5：两处各写一遍同一个判断，就是「内核按 A 想、发送层按 B 发」那个病的温床。
 */
const saidTo = (now, key = 'alertChat') => ({ [key]: now.chatId ?? null });

/** 收尾的目标群：**当初通报去的那个**；从没通报过就是 null（不许凭空指一个群）。 */
const closeTo = (prev, key = 'alertChat') => prev?.[key] ?? null;

/**
 * ★ **这条告警到底发到哪个群** —— 三个来源的优先级，只在这里判一次。
 *
 * 为什么单独拆出来：这条优先级原先**只活在 `ws_daemon.mjs` 的一行表达式里**
 * （`chatId ?? await resolveChat()`），所以状态机那一侧 75 条断言全绿，
 * 也照样能把收尾发到另一个群 —— 事故就发生在这一跳上。
 * 拆成纯函数之后，「`sayTo` 优先于触发群」这件事才有了一条**能红的判据**
 * （§2.4：写进文档的每条规矩，都要指得出是哪一行在拦它）。
 *
 * `null` 的语义是**「没有依据」**，不是「发到默认群」—— 三个都是 null 时返回 null，
 * 由调用方决定「只进日志」（那句日志是「有话要说但没群可发」，退 2 不许沉默）。
 *
 * ⚠️ 第一版我把这条写成了「`sayTo` 必须在 `ws_daemon` 里被用到」的**源码文本断言** ——
 *    那是 §2.4 点名的假执行点（`MAX_SECTIONS` 那个病：名字出现过 ≠ 拦得住）。
 *    能红的判据必须**调用它**，所以它在这儿，不在扫描器里。
 */
export function pickAlertTarget({ sayTo = null, triggerChat = null, fallback = null } = {}) {
  return sayTo ?? triggerChat ?? fallback ?? null;
}

/**
 * ★ `recheckDue()` —— 「这次读数被跳过了，什么时候把它补回来」。
 *
 * ── 为什么需要它（2026-09-22 实测，`PMO/守衡-误答登记-20260922.md` §十三）
 *
 * `runCheckNow` 在冷却期内的行为是 `return { skipped }`，调用方 `log` 完就 `return`。
 * **冷却是「跳过」，不是「重排」** —— 没有任何一行在冷却过期后把那次检查补回来。
 * 于是实测出来的时间线是：
 *
 * ```
 * 16:59:32  基线检查跑了 → 退 1，发现上游改版，群里已告警
 * 17:17:10  重启 → 启动即核被冷却跳过（18 分钟 < 30）
 * 17:22:33  又重启 → 同样被跳过（23 分钟 < 30）
 * 17:29:32  冷却**到期** —— 而这一时刻**没有任何一行代码在看它**
 * 次日 00:00   换日兜底才会跑
 * ```
 *
 * 两个后果，第二个更坏：
 *   ① 漂移的发现窗口被一次重启撑到约 **24 小时**；
 *   ② 这期间状态文件一直写着 `lastState: "drift"`，**而基线其实早已重记、全绿** ——
 *      它停在 `drift` 不是因为它还是 drift，**是没有东西去更新它**。
 *
 * ── 判据（三条，每条都对应一条自证）
 *
 * 补跑的**唯一**依据是「这个进程里确实跳过了一次，而冷却现在允许了」：
 *
 *   · `staleSince` 为空 → **不补**。否则这就退化成「每 30 分钟轮询一次」——
 *     那是把一个发现窗口问题换成一个抓取风暴问题，且与本检查的设计意图相反
 *     （它只在 启动 / 收到链接 / 换日 三处触发）；
 *   · 冷却未过 → **不补**（补了也会被自己再跳过，白跑）；
 *   · 两者都满足 → **补**，补完 `enter()` 会把 `staleSince` 清空。
 *
 * ★ 它是**纯函数**：`t` 可注入，所以「冷却前 / 冷却后」两侧都能在自证里造出来，
 *   而不必等 30 分钟。判据在 `prd_baseline.mjs`（这一层），
 *   **谁在跑它在 `ws_daemon.mjs` 的心跳里** —— `AGENTS.md` §2.4.2 那两层，缺一层都不算兑现。
 *
 * @param {object} prev 状态文件
 * @param {number} t    当前时刻（注入用）
 * @returns {string|null} null = 不必补跑；字符串 = 补跑的理由（进日志）
 */
export function recheckDue(prev, t = Date.now()) {
  if (!prev?.staleSince) return null;                       // 没跳过 → 不补（否则成了轮询）
  const last = prev.lastRunAt ? Date.parse(prev.lastRunAt) : 0;
  const left = COOLDOWN_MS - (t - last);
  if (left > 0) return null;                                // 冷却未过 → 补了也是白跑
  return `上次读数停在 ${prev.lastRunAt}，自 ${prev.staleSince} 起被跳过、冷却已过`;
}

/**
 * 状态迁移：给定「上次说过什么」和「这次读到什么」，返回「该不该说、说什么」。
 *
 * ★ 这是纯函数，且 `--selftest` 对它做正反两面的对照 ——
 *   一个恒说（刷屏）或恒不说（等于没有）的告警器都没用，两边都要证。
 *
 * @param {object} prev  上一次的记录（loadState 的形状）
 * @param {object} now   { code, drifted:[{file, old, now}], untested:[file], day }
 * @returns {{state:object, say:string|null, why:string}}
 */
export function enter(prev, now) {
  // ★ 只认 0/1/2。别的（被杀 137、崩了、-1…）一律折成 **2 = 未测** ——
  //   「我没测成」和「我测了是绿的」必须长得不一样（§2.4.2 第 2 条）。
  //   第一版没有这一行，137 会一路落到末尾的绿分支 —— 那正是这个检查器要防的病。
  const code = [0, 1, 2].includes(now.code) ? now.code : 2;
  const day = now.day;
  const st = {
    ...pick(prev, KEEP_BASELINE),
    lastRunAt: new Date().toISOString(), lastDay: day, lastCode: code, rawCode: now.code,
    // ★ **真的跑过一次，就把「这份读数已经过期」的标记清掉**（2026-09-22 加）。
    //   必须写在展开**之后** —— 展开会把 `prev.staleSince` 带进来，写在前面等于没清。
    //   清不掉的话 `recheckDue()` 会永远为真，心跳就会变成每拍补跑一次。
    staleSince: null,
  };

  if (code === 1 && now.drifted.length) {
    // 同一个漂移指纹只说一次；指纹变了（又改了一版）就再说。
    const fp = now.drifted.map((d) => `${d.file}:${d.now}`).sort().join('|');
    if (prev.saidDriftFp === fp) {
      return { state: { ...st, lastState: 'drift' }, say: null, why: '同一个漂移指纹已经说过' };
    }
    const lines = now.drifted.map((d) =>
      `· **${d.file}**\n  旧指纹 \`${String(d.old).slice(0, 16)}…\` → 新指纹 \`${String(d.now).slice(0, 16)}…\``
      // ★ 上游什么时候改的 —— 「现在拉还是等它改完」唯一的依据（2026-10-12 加）。
      + (d.at ? `\n  ${d.at}` : ''));
    return {
      state: { ...st, lastState: 'drift', saidDriftFp: fp, ...saidTo(now) },
      why: '上游改版了（这是本检查存在的理由）',
      say: [
        `⚠️ **上游 PRD 改版了** —— 我手上那份基线已经过期。`,
        ...lines,
        `我读到的还是旧版，**而且不会自己察觉**。请给我一分钟重拉一次基线并记新指纹；`,
        `在那之前，凡是引用这份 PRD 的判断都按旧版算。`,
      ].join('\n'),
    };
  }

  /**
   * ★★ 退 1，但**不是**上游改版（2026-09-30 加）。
   *
   * 判据：`code === 1` 且**抠不出任何上游指纹变化**。这时红来自检查器内部
   * （实测那一次全部来自 R 段「章节引用登记」），**没有任何证据**说上游 PRD 变了。
   *
   * 为什么要说：退 1 就是退了 1，沉默等于把异常咽下去 —— 沿用原作者那条
   *   「宁可说，不可沉默」。
   * 为什么必须换个说法：把「引用登记不一致」说成「上游 PRD 改版了」，会让人去
   *   重拉一份**根本没变**的基线，并据此把引用按旧版算 —— 白做工，还误导。
   *   **一个会说错病的告警，比没有告警更快被无视**（`AGENTS.md` §2.1）。
   *
   * 与 `drift` 分开记状态（`lastState: 'unparsed'`），是为了让收尾那句也说得准：
   *   这一支从头到尾没说过「上游改版」，就不能用「上游基线检查恢复了」来收尾
   *   —— 那等于回头把那句没说过的话补上。
   */
  if (code === 1) {
    if (prev.saidUnparsedDay === day) {
      return { state: { ...st, lastState: 'unparsed' }, say: null,
               why: '今天的「退 1 但不是上游改版」已经说过一次' };
    }
    return {
      state: { ...st, lastState: 'unparsed', saidUnparsedDay: day, ...saidTo(now) },
      // ★ `why` 进 daemon 日志（「基线检查[daily] 退出码 1 —— <why>」）。
      //   把**红的编号与条数**带上，日志本身就说得清，不必再去翻明细文件。
      why: '退 1，但输出里没有任何上游指纹变化 —— 不是上游改版；红在 '
         + ((now.failures ?? []).map((f) => `${f.id}×${f.count}`).join('/') || '（没抠出编号）'),
      say: [
        '⚠️ **基线检查退 1，但这一轮不是「上游 PRD 改版」** —— 输出里没有任何上游指纹变化。',
        failuresLine(now.failures),
        `所以：**不用**重拉基线，**也不用**把引用按旧版算。${detailFileLine(now.detailFile)}`,
      ].join('\n'),
    };
  }

  if (code === 2) {
    if (prev.saidUntestedDay === day) {
      return { state: { ...st, lastState: 'untested' }, say: null, why: '今天的「未测」已经说过一次' };
    }
    return {
      state: { ...st, lastState: 'untested', saidUntestedDay: day, ...saidTo(now) },
      why: '没测成 —— 报「未测」，不报「没问题」',
      say: [
        `⚠️ **上游基线检查这次没跑成**（拿不到正文或凭据）。`,
        `这不是「没问题」，是**「这次没测」** —— 我此刻无法判断手上那份 PRD 是不是最新版。`,
        `下次触发时会重试。${(now.untested ?? []).length ? `未测：${now.untested.join('、')}` : ''}`,
      ].join('\n'),
    };
  }

  // 退 0：只在上一次是红/未测时说一句"恢复了"，否则闭嘴。
  // ★ `unparsed` 也算「红过」（2026-09-30 加）—— 群里看到过异常，得看到它结束。
  if (prev.lastState === 'drift' || prev.lastState === 'untested' || prev.lastState === 'unparsed') {
    // ★ 但收尾的话要**按当初说过的那句**配（2026-09-30）：`unparsed` 那一支
    //   从头到尾没说过「上游改版」，用「上游基线检查恢复了…与指纹一致」收尾，
    //   等于**回头把那句没说过的话补上** —— 群里会以为上游真改过一版。
    const wasUnparsed = prev.lastState === 'unparsed';
    return {
      state: { ...st, lastState: 'ok', saidDriftFp: null, saidUnparsedDay: null, alertChat: null },
      // ★ **收尾回到当初通报去的那个群**（`alertChat`）—— 不是 `resolveChat()`。
      //   null = 当初没通报过，调用方仍退回默认群；那时说「恢复」本来就是错的，
      //   所以这一支也**不会**被走到（`lastState` 不是红/未测）。
      sayTo: closeTo(prev),
      why: '从红/未测恢复 —— 群里之前看到过异常，得看到它结束',
      say: wasUnparsed
        ? '✅ 基线检查回到退 0：这一轮的输出与登记表一致。'
        : `✅ 上游基线检查恢复了：手上那份 PRD 与指纹一致。`,
    };
  }
  return { state: { ...st, lastState: 'ok', saidDriftFp: null, alertChat: null }, say: null, why: '一直是绿的，不刷屏' };
}

/* ─────────────────────── 执行 ─────────────────────── */

/** 跑一次 verify_prd_baseline.py，把退出码与关键行解析出来。**超时也算未测（退 2）。** */
export function runChecker({ timeoutMs = 90_000, offline = false } = {}) {
  return new Promise((resolve) => {
    const args = [SCRIPT, ...(offline ? ['--offline'] : [])];
    let out = '';
    let done = false;
    const child = spawn('python3', args, { cwd: REPO_ROOT });
    const finish = (code, note) => {
      if (done) return;
      done = true;
      resolve({ code, out, note });
    };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} finish(2, '超时 —— 按未测处理'); }, timeoutMs);
    child.stdout.on('data', (b) => { out += b.toString(); });
    child.stderr.on('data', (b) => { out += b.toString(); });
    child.on('error', (e) => { clearTimeout(timer); finish(2, `起不来：${e.message}`); });
    child.on('close', (code) => { clearTimeout(timer); finish(code === null ? 2 : code); });
  });
}

/** 从输出里抠出「哪份文件、旧指纹、新指纹」。抠不到不算漂移 —— 退 1 但没指纹时走兜底文案。 */
export function parseDrift(out) {
  const drifted = [];
  /**
   * ★ `at`（上游最后改动时刻）是**可选**捕获（2026-10-12 加）。
   *
   * 出生理由：告警原先只说「请给我一分钟重拉一次基线」——**没说上游什么时候改的**。
   * 而读者唯一要判断的就是「现在就拉，还是等它改完」：实测那次为了答这个问题，
   * 得去翻 daemon 日志时间线（17:43:37 还绿、17:45:08 已变）**再加上**手工调一次
   * metas 接口，才拼出那个 90 秒的窗口。检查器现在把这条读数印在 `现场指纹` 下一行。
   *
   * ⚠️ **可选**是必须的：老版本检查器的输出没有这一行，而 `parseDrift` 不能因此
   *    把整条漂移丢掉 —— 那会让「上游改版」这条告警直接消失（比少一个字段严重得多）。
   */
  const re = /★★ 上游改版了：(.+)\n\s*索引指纹 ([0-9a-f]{64})\n\s*现场指纹 ([0-9a-f]{64})(?:\n\s*(上游最后改动 .+))?/g;
  let m;
  while ((m = re.exec(out)) !== null) {
    drifted.push({ file: m[1].trim(), old: m[2], now: m[3], at: m[4] ? m[4].trim() : null });
  }
  return drifted;
}

export function parseUntested(out) {
  const m = /⚠️\s+L3 未测：(.+?) ——/.exec(out);
  return m ? m[1].split(/,\s*/).map((s) => s.trim()).filter(Boolean) : [];
}

/**
 * ★★ 从检查器输出里读出**真正红的是哪几条**（2026-10-12 加）。
 *
 * 出生理由：`enter()` 那一支的文案原先写死着
 * 「红来自检查器内部（**多半是**「章节引用登记」那一段）」——
 * 那是一句**把一次历史观测当成事实**的话（代码注释里自己写着「实测那一次全部来自 R 段」）。
 * 红在别处时（比如 L1 结构），它会**信心十足地指错方向**，
 * 而读者没有任何办法从告警正文里看出那句话是猜的 —— 只能去翻日志，
 * 而那份日志里**从来没有过**这份明细（见 `DETAIL_FILE` 的注释）。两个错叠在一起。
 *
 * 现在改成读：真红的条目**就在 `out` 里**（每行一条 `❌ [段] 编号 标签 · 子号 · 文件 §x.y：原因`），
 * 没有任何理由去猜。`R_OUT`（自证里那份）与真实输出两种形状都吃。
 *
 * ⚠️ **摘要行不算**：`❌ 80 项中 53 项失败` 里 `80` 是纯数字，
 * 而本判据要求编号以**字母开头**（`H3`/`L1`/`R2`/`G4`…）—— 所以它自然落选。
 * 这一条是**反向对照**（喂只带摘要行的输出必须解析出 0 条），不是备注。
 */
export function parseFailures(out) {
  const byId = new Map();
  const re = /^[ \t]*❌[ \t]*(?:\[([^\]]+)\][ \t]*)?([A-Z]{1,3}\d{1,3})\b[ \t]*(.*)$/gm;
  let m;
  while ((m = re.exec(String(out ?? ''))) !== null) {
    const id = m[2];
    // ★ 标签到「子号」为止。真实输出用**两个以上空格**做列分隔
    //   （`名字   R2 · 文件 §x.y`），而 `R_OUT` 那份抄下来的是 `名字 · R2 · …` ——
    //   两种都得切。只按 `·` 切会把 `R2` 混进标签（实测抓到过，见自证里那条回归断言）。
    const label = String(m[3] ?? '').split(/\s{2,}|·/)[0].trim();
    const fm = /·[ \t]*([^\s·]+\.[A-Za-z0-9]+)[ \t]*§/.exec(m[0]);
    const e = byId.get(id) ?? { id, section: m[1] ?? null, label: '', count: 0, files: [] };
    e.count += 1;
    if (!e.label && label) e.label = label;
    if (fm && e.files.length < 3 && !e.files.includes(fm[1])) e.files.push(fm[1]);
    byId.set(id, e);
  }
  return [...byId.values()].sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
}

/**
 * 全量清单落在哪 —— **跟着这一次运行的 `stateFile` 走**，不是永远落在真状态目录。
 * 它必须与告警正文里印出来的那个路径是**同一个来源**，否则「见 XX」又会变成一句
 * 指不出对象的话（这一处就是为修那句而加的）。
 *
 * ★ 第一版写死 `stateDir()`，被**实测**抓出来了，抓到的方式值得记：
 *   跑完自证之后，真状态目录下多了一个 311 字节的文件，头行写着 `触发 daily · 退出码 0`
 *   —— 正是自证里那条「不带 `dryRun` 时必须落盘」的注入样本：它用 `stateFile`
 *   把**状态**指到临时文件，而我的明细**没跟着走**。
 *   也就是说：**§2.4.4 那个病，长在了记录这个病的那个文件自己身上。**
 *
 * ★ 判据是「自证用 `stateFile` 隔离自己」这条**既有**约定 —— 明细是这次运行的产物，
 *   落点必须与状态文件同源；否则以后每加一个副产品，都要再补一次隔离。
 */
const DETAIL_NAME = 'prd-baseline-last-check.txt';
const detailFileOf = (stateFile) => path.join(path.dirname(stateFile), DETAIL_NAME);
/** 印给人看的路径：在库内就印相对路径，库外才印绝对路径（别印一个点不开的绝对路径）。 */
function detailFileLabel(f) {
  return f.startsWith(REPO_ROOT + path.sep) ? path.relative(REPO_ROOT, f) : f;
}

/**
 * 「红的是哪几条」写成一句**可核对**的话。
 *
 * ★ 读得出就**点名**（编号 + 标签 + 条数 + 两个文件名当抓手）；读不出就**明说读不出**。
 *   **两种情况下都不许再写「多半是…」** —— 那正是这一支被修掉的东西：
 *   一句把历史观测当事实的猜测，在红落到别处时会自信地指错方向（§2.4.1「这句话比我的输入大吗」）。
 */
export function failuresLine(failures) {
  const list = Array.isArray(failures) ? failures : [];
  if (!list.length) {
    return '红的是检查器内部的断言，但这份输出里**没抠出是哪几条**（输出形状可能变了）'
         + '—— 那本身就是要查的事，先看下面的全量清单。';
  }
  const parts = list.map((f) => `**${f.id}「${f.label}」× ${f.count} 项**`).join('、');
  const ex = list[0]?.files?.length ? `（例：${list[0].files.join('、')}）` : '';
  return `红的是 ${parts}${ex}；上游文档这一轮**没有证据说它变了**。`;
}

/** 「全量清单在哪」写成一句**指向真实存在的东西**的话；没落盘就直说没有，不许印一个空路径。 */
export function detailFileLine(detailFile) {
  return detailFile
    ? `全量清单（每一条都带文件名与章节号）：\`${detailFile}\`。`
    : '全量清单这次**没落盘**（`--check` 是纯查看，不写任何东西）—— '
      + '要看明细就跑 `python3 tools/verify_prd_baseline.py`。';
}

/**
 * 去掉**否定域**：`这不是「没问题」，是「这次没测」` 里的「没问题」不算违规。
 *
 * ★ 为什么需要它：本项目的 `verify_engine_contract.py` **V25b** 踩过一模一样的坑 ——
 *   禁用语检查把否定句也算成命中。本文件离线自测第 6 条就是这么误报的。
 *   **一个会误报的检查器比没有检查器更糟**，所以判据要能区分「说」和「否认」。
 */
export function stripNegated(s) {
  // ★ 2026-09-30 把 `不用|不需要|无需|不必|无须` 并进来。
  //
  //   起因是「退 1 但不是上游改版」那句文案：它**劝阻**别人重拉基线
  //   （「所以：**不用**重拉基线，**也不用**把引用按旧版算」），而判据
  //   「不许叫人去重拉基线」是**裸词表**，把劝阻也算了进去 —— 误报。
  //
  //   与 V25b 是**同一个病**：判据分不清「说」和「否认」。一个会误报的检查器
  //   比没有检查器更糟（本文件前面写过两遍），所以这里不加特例放宽某一条断言，
  //   而是把「否定域」这个概念本身扩全 —— 劝阻也是一种否定。
  //
  //   ⚠️ 别把它扩成「只要出现这些词就整句不算」：剥掉的是**词后那一小段**，
  //   同一句里另一处裸的 `请重拉基线` 仍然会被留下并被判据抓到。
  //   正反面都在 `--selftest` 里（「不用重拉」必须剥掉 / 裸的「请重拉」必须留下）。
  const NEG = '(不是|不算|并非|而非|不用|不需要|无需|不必|无须)';
  return String(s ?? '')
    .replace(new RegExp(`${NEG}\\s*[「『"'][^」』"']*[」』"']`, 'g'), '')
    .replace(new RegExp(`${NEG}[^\\n，。；]{0,12}`, 'g'), '');
}

/**
 * 告警发到哪个群：优先用状态里记的（最近来过消息的群），否则问一次接口。
 *
 * ★ `feishu` 用**动态 import**：静态 import 会在加载时就构造 Lark Client（要凭据），
 *   那会让 `--selftest` 变成一个需要联网/凭据的东西 —— 而它必须是随时可跑的。
 */
export async function resolveChat() {
  const known = loadChatId();
  if (known) return known;
  try {
    const feishu = await import('./feishu.mjs');
    const r = await feishu.client.im.chat.list({ params: { page_size: 20 } });
    const items = r?.data?.items ?? [];
    const g = items.find((c) => c.chat_mode === 'group') ?? items[0];
    /**
     * ★ **猜出来的群不落盘。**（2026-09-22 加）
     *
     * 这里挑的是「接口返回的第一个群」—— 它通常就是最近活跃的那个，但**那是接口的排序**，
     * 不是我们的依据；而我们没有查过「这个群是不是我们该说话的地方」。
     * 原先这里会 `saveChatId(...)` 把它**持久化**：一次猜测从此变成事实，
     * 之后每次告警都往那儿发，而没有任何东西会质疑它。
     *
     * 不落盘之后的行为：每次没有已知群时才问一次接口，而调用方那条
     * 「…已发到 <目标>」的日志**每次都打**，所以目标是猜的这件事在日志里看得见。
     * 真正的「最近来过消息的群」由 `ws_daemon.onMessage` 每条消息调 `saveChatId` 记下
     * —— 那才是这句语义的字面意思，且自维护。
     */
    if (g?.chat_id) return g.chat_id;
  } catch { /* 取不到就让调用方走"只进日志"那条路 */ }
  return null;
}

/**
 * 触发一次检查（含冷却与去重），必要时返回要发的话。
 *
 * @param {object} o
 * @param {'link'|'daily'} o.reason
 * @param {boolean} o.force 跳过冷却（`--selftest` 与手动用）
 * @param {string}  o.day   注入用（默认现算）
 */
/**
 * ★ **单飞（single-flight）**：同一时刻只允许一次检查在跑。
 *
 * 为什么必须有：检查体是 **read 状态 → 跑子进程/等网络（最长 90 秒）→ write 状态**。
 * 两个触发同时来（比如启动即核 + 群里刚推了链接，或心跳兜底撞上手动 `--check`），
 * 后写的那个用的是**更旧的快照**，会把先写的抹掉 —— 表现就是同一条告警反复重发。
 * 与「两个检查各用一份状态文件」是同一件事的两半：**一个文件同时只能有一个写者。**
 */
let baselineInFlight = null;
let pendingInFlight = null;

export async function checkNow(opts = {}) {
  if (baselineInFlight) return { skipped: '上一次基线检查还在跑' };
  baselineInFlight = runCheckNow(opts);
  try { return await baselineInFlight; } finally { baselineInFlight = null; }
}

async function runCheckNow({ reason = 'daily', force = false, day = bjDate(), run = runChecker,
                            dryRun = false, stateFile = null, chatId = null } = {}) {
  // ★ `stateFile` 可注入：存在的理由是**自证** —— `--selftest` 要能证明
  //   「`dryRun` 下真的一个字节都没落盘」，而这句话只有在能指定文件时才证得了。
  //   默认仍是那份真状态文件，生产路径不受影响。
  const file = stateFile ?? STATE_FILE();
  const prev = loadState(file);
  const last = prev.lastRunAt ? Date.parse(prev.lastRunAt) : 0;
  if (!force && Date.now() - last < COOLDOWN_MS) {
    /**
     * ★ **跳过要留痕**（2026-09-22 加，`PMO/守衡-误答登记-20260922.md` §十三）。
     *
     * 原先这一支只有 `return` —— 于是「这次没查」在盘上**一个字都没有**，
     * 而状态文件里的 `lastState` 继续以「最新读数」的身份示人。
     * 实测后果：一次落在冷却窗口里的重启，让 `lastState: "drift"` 在基线早已转绿之后
     * **又挂了 6.5 小时**，而任何读这个文件的人都会得到「它还是漂移的」这个错误结论。
     *
     * 现在记两件事，缺一件都不算修好：
     *   ① `staleSince` —— **第一次**跳过发生的时刻（重复跳过不刷新它，
     *      否则「过期了多久」会被自己的心跳一直顶到现在，读数又变成假的）；
     *   ② 它同时是 `recheckDue()` 的**唯一**依据 —— 判据（B）与触发（A）共用一处，
     *      `AGENTS.md` §2.5「同一个形状只能有一处实现」。
     *
     * ⚠️ `dryRun` 下**一个字节都不许落盘**（§2.4.4）—— 这条路径同样是自证会走到的。
     */
    const staleSince = prev.staleSince ?? new Date().toISOString();
    if (!dryRun && staleSince !== prev.staleSince) {
      saveState({ ...pick(prev, BASELINE_KEYS), staleSince }, file);
    }
    return {
      skipped: `冷却中（上次 ${prev.lastRunAt}，不足 ${COOLDOWN_MS / 60000} 分钟）`,
      staleSince,
    };
  }

  const { code, out, note } = await run({});
  /**
   * ★ **把完整输出落盘**（2026-10-12 加）：告警正文里那句「全量清单见 …」就是这么来的。
   *
   * 出生理由：那句原先写的是「具体是哪一项红，见 `PMO/logs`」—— 而**明细从来不在那儿**。
   * `runChecker` 收着 `out`，`parseDrift` 只从里面抠了指纹，**其余全部丢掉**，
   * 一个字节都没写盘。实测 `PMO/logs/` 下 grep `H3 每处引用` **命中 0 次**
   * （唯一那处命中是告警正文自己）。也就是说：**那句指路把人指去一个没有这份读数的地方**，
   * 读者照做只会空手而归（2026-10-12 就是照做之后回来问的）。
   * 与 `AGENTS.md` §2.4.3「说出去的话比依据大」是同一个病。
   *
   * 两条纪律：
   *   ① **每次都写**（含退 0）。只写红的会让这份文件在转绿之后继续以「最新读数」的身份
   *      示人 —— 而它已经过期了（§2.4.6 那个「停在 drift 不是因为它还是 drift」的坑）。
   *      写在开头的 `退出码` 一行就是给读者判新旧用的。
   *   ② `dryRun` 下**一个字节都不许落盘** —— `--check` 那条命令的卖点就是「纯查看、不改任何东西」，
   *      而它走的正是 `runChecker`（§2.4.4：跑一次查看不改掉将来要发生的事）。
   */
  // ★ 明细跟着**这次运行的状态文件**走（`stateFile` 是自证唯一的隔离手段，明细必须同源）。
  const detailFile = detailFileOf(file);
  if (!dryRun) {
    try {
      ensureDir(path.dirname(detailFile));
      fs.writeFileSync(detailFile,
        `# PRD 基线检查 —— 最近一次运行的完整输出\n`
        + `# 生成于 ${new Date().toISOString()} · 触发 ${reason} · 退出码 ${code}\n`
        + `# 这份文件是给告警正文里那句「全量清单」指路用的 —— 由 prd_baseline.mjs 写，别手改。\n`
        + `# 复现同一条读数：python3 tools/verify_prd_baseline.py\n`
        + `${String(out ?? '').replace(/\s*$/, '')}\n`);
    } catch { /* 落盘失败不该让检查本身失败 —— 正文里会明说「未落盘」 */ }
  }
  const now = {
    code,
    day,
    // ★ `chatId` ＝ **这次通报会发到哪个群**（调用方在跑之前就定下来，见 `baselineWatch`）。
    //   它是 `alertChat` 的来源，也是「收尾必须回到同一个群」的唯一依据。
    chatId,
    drifted: code === 1 ? parseDrift(out) : [],
    untested: code === 2 ? parseUntested(out) : [],
    // ★ 退 1 时**真红的是哪几条**（读出来的，不是猜的）。退 2（未测）没有「红条目」可言。
    failures: code === 1 ? parseFailures(out) : [],
    // ★ 正文里印的路径与写盘用的是**同一个来源**，否则又变成一句指不出对象的话。
    detailFile: !dryRun && fs.existsSync(detailFile) ? detailFileLabel(detailFile) : null,
  };
  // ★ 原先这里**伪造**一条 drifted：`（输出里没抠到具体文件，见 PMO/logs）`，
  //   本意是让下游「宁可说，不可沉默」。**本意没错，错在伪造。**（2026-09-30 删）
  //
  //   后果实测（2026-09-30 19:32）：那一轮的退 1 **全部来自 R 段（章节引用登记）**，
  //   L1/L2/L3 三层全绿 —— 上游那份 PRD 一个字都没改。可伪造出的那条会一路流进
  //   `enter()` 的「⚠️ 上游 PRD 改版了」那一支，等于对群里说了一句**假话**，
  //   还叫人「给我一分钟重拉一次基线」：白做工，而且会让人据此把引用按旧版算。
  //   附带：`saidDriftFp` 被写成 `（…）:` 这种值，本身就在骗下一个读状态文件的人。
  //
  //   现在**不伪造**：`drifted` 留空，由 `enter()` 里 `code === 1 && !drifted.length`
  //   那一支说一句说得准的话（照旧说，只是不冒充上游改版）。这一处是**唯一**的生产者，
  //   别处不许再往 `drifted` 里塞占位符。
  const { state, say, why, sayTo } = enter(prev, now);
  /**
   * ★ `dryRun` 时必须**一个字节都不落盘**。（2026-09-22 加的，代价是一次实测）
   *
   * 原先这里无条件 `saveState(state)`，而 `--selftest` 的两个用例
   * （「单飞」「两把锁互相独立」）走的正是这条 `checkNow({ force: true, run: 假的 })`。
   * 于是**跑一次自证就改了真状态**，实测读数：
   *
   * ```
   * before.lastRunAt = 2026-09-22T06:12:23.208Z   ← 真的那次检查
   * after .lastRunAt = 2026-09-22T06:12:57.104Z   ← 自证写的
   * after .lastState = ok                          ← 原来是 drift 也会被抹成 ok
   * ```
   *
   * 两个后果都对外：
   * ① `lastRunAt` 被顶到现在 → **30 分钟冷却被一次自证用掉**，这半小时里真出现漂移
   *    会被 `skipped` 掉，群里什么都不会收到；
   * ② `lastState` 被抹成 `ok` → 「上一次是红的/未测」这条记忆没了，
   *    真恢复时那句「✅ 已恢复」也不会发。
   *
   * 而 `AGENTS.md` §2.1 的表里**正把 `--selftest` 列为应该常跑的自证命令** ——
   * 也就是：照着文档做，就会把告警静音半小时。
   * 判据（§2.4）：写进文档的每条命令，都要能指出它会不会改状态；指不出来就别写。
   */
  if (!dryRun) saveState(state, file);
  return { code, note, say, why, sayTo: sayTo ?? null, reason, out, ...(dryRun ? { dryRun: '注入/自证 —— 未落状态' } : {}) };
}

/* ─────────────────── 待收清单：到期提醒（`PMO/待收清单-v1.json`） ─────────────────── */

/**
 * 跑一次 `verify_pending.py --json`。**输出不是合法 JSON ⇒ 未测（退 2）** ——
 * 「我读不出来」和「没有到期」必须长得不一样（`AGENTS.md` §2.4.2 第 2 条）。
 */
export function runPendingChecker({ timeoutMs = 30_000, today = null } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    // `today` 只是把「今天」注入给 python，**不参与要不要发的决定** ——
    // 它让「到期那天群里会收到什么」现在就能看一遍（同 restart_shouheng.sh 的 --since）。
    const args = [PENDING_SCRIPT, '--json', ...(today ? [`--today=${today}`] : [])];
    const child = spawn('python3', args, { cwd: REPO_ROOT });
    const finish = (code, note, data) => {
      if (done) return;
      done = true;
      resolve({ code, note, data, out });
    };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} finish(2, '超时 —— 按未测处理', null); }, timeoutMs);
    child.stdout.on('data', (b) => { out += b.toString(); });
    child.stderr.on('data', (b) => { out += b.toString(); });
    child.on('error', (e) => { clearTimeout(timer); finish(2, `起不来：${e.message}`, null); });
    child.on('close', (code) => {
      clearTimeout(timer);
      let data = null;
      try { data = JSON.parse(out.trim().split('\n').filter(Boolean).pop()); } catch { /* 下面按未测处理 */ }
      const raw = code === null ? 2 : code;
      const c = [0, 1, 2].includes(raw) && data ? raw : 2;
      finish(c, data ? '' : '输出不是合法 JSON —— 按未测处理', data);
    });
  });
}

/**
 * 待收清单的通报状态机（纯函数，`--selftest` 对它做正反两面）。
 *
 * ★ 为什么「同一批到期**每天**最多说一次」而不是「只说一次」：
 *   只说一次 = 说过之后就永久沉默，而那件事还悬着 —— 等于没有告警器。
 *   每天一次与上面「未测每天一次」同口径，也是本项目已有的尺度。
 *
 * @param {object} prev  loadState() 的形状（本节的键统一用 `p_` 前缀，不碰基线那套）
 * @param {object} now   { code, day, overdue:[{id,事项,到期日,过期天数,原话,到期日来源}] }
 */
export function enterPending(prev, now) {
  const code = [0, 1, 2].includes(now.code) ? now.code : 2;   // 137 被杀等一律折成未测
  const day = now.day;
  const struct = now.structErrors ?? [];
  const st = { ...pick(prev, KEEP_PENDING), p_lastRunAt: new Date().toISOString(), p_lastDay: day, p_lastCode: code, p_rawCode: now.code };

  /* ── ★ F 段：问出去两个工作日了还没回 → 补问一次（2026-09-22 加） ────────────
   *
   * 为什么单独一支、而且**不挂在 `code` 上**：`verify_pending.py` 的 F 段刻意不折进退出码
   * —— 「问了还没回」既不是「清单坏了」（1）也不是「没读成」（2）。把它塞进任何一支，
   * 那一支的话术就会去冒充它（§2.4.3：说出去的话比依据大）。
   *
   * ★ **每条只补一次**，而且是**结构上**只补一次：判据是清单里那条 `outbound` 指针
   *   **恰好一条**（见 `ask_nags` 的 ②）。补问发出去、指针补进清单之后，这条就再也不进表。
   *   状态里的 `p_nagged` 只挡「已经发进群、指针还没补上」那个窗口。
   *   **两把锁各挡一段 —— 缺一把，同一个问题就会每天重发一次，而对方是个真人。**
   *
   * 一条已知的取舍：补问和「到期提醒」撞在同一天时，只有补问这一条会发出去，
   * 到期那批会顺延到下一次检查（并在这里报个数，不至于被吞掉）。
   * 两边都是每天最多说一次，所以顺延的代价是一天，不是丢失。
   */
  const nag = now.nag ?? [];
  if (nag.length) {
    const seen = new Set(prev.p_nagged ?? []);
    const fresh = nag.filter((n) => n?.id && !seen.has(n.id));
    if (!fresh.length) {
      return { state: { ...st, p_lastState: 'nag' }, say: null, why: '这几条都已经补问过了' };
    }
    return {
      state: { ...st, p_lastState: 'nag', p_nagged: [...seen, ...fresh.map((n) => n.id)], ...saidTo(now, 'p_alertChat') },
      why: `${fresh.length} 件问出去两个工作日了还没回`,
      say: [
        `⏳ **有 ${fresh.length} 件先前问过、还没收到答复的，我补问一次** —— 各只补这一次，之后不再提。`,
        ...fresh.slice(0, 5).map((n) => [
          `· **${n.事项}** —— ${n.问于} 问的，已过 ${n.工作日} 个工作日`,
          // 去掉 markdown 记号：quote 是**逐字**存的，带 `**` 原样发出去会缺配对
          n.问题 ? `  我问的是：「${String(n.问题).replace(/[*`]/g, '')}」` : null,
        ].filter(Boolean).join('\n')),
        fresh.length > 5 ? `· …另有 ${fresh.length - 5} 条，见 \`python3 tools/verify_pending.py\`` : null,
        (now.overdue ?? []).length
          ? `⚠️ 同时还有 ${now.overdue.length} 件到期未收 —— 下一次待收检查会单独提。` : null,
        `**不用现在回。** 你要是有别的优先级，直接说一句，我把这条关掉。`,
      ].filter(Boolean).join('\n'),
    };
  }

  if (code === 1 && (now.overdue ?? []).length) {
    const key = now.overdue.map((o) => `${o.id}@${o.到期日}`).sort().join('|');
    if (prev.p_saidDueKey === key && prev.p_saidDueDay === day) {
      return { state: { ...st, p_lastState: 'due' }, say: null, why: '同一批到期今天已经说过一次' };
    }
    const lines = now.overdue.map((o) => {
      const over = o.过期天数 === 0 ? '今天到期' : `已过 ${o.过期天数} 天`;
      const why = o.到期日来源 === '我方推算'
        ? `（这个日子是我方按原话推出来的，**不是对方给的日期** —— 所以是问一句，不是催办）` : '';
      return [
        `· **${o.事项}** —— 到期 ${o.到期日}（${over}）`,
        o.原话 ? `  原话：「${o.原话}」` : null,
        why ? `  ${why}` : null,
      ].filter(Boolean).join('\n');
    });
    return {
      state: { ...st, p_lastState: 'due', p_saidDueKey: key, p_saidDueDay: day, ...saidTo(now, 'p_alertChat') },
      why: `待收清单有 ${now.overdue.length} 件到期未收`,
      say: [
        `⏳ **上游有承诺到期了，还没收到**（${now.overdue.length} 件）`,
        ...lines,
        // 同时坏了的时候也要说 —— 不然「到期那批」看着完整，其实清单可能还漏了别的条目
        struct.length ? `⚠️ 另外，这份清单本身还有 ${struct.length} 处结构错误（下面那条到期明细未必是全的）。` : null,
        `清单在 \`PMO/待收清单-v1.json\`；收到之后把那条改成 done 并记完成依据，我就不会再提。`,
      ].filter(Boolean).join('\n'),
    };
  }

  /**
   * ★ **退 1 但明细为空 = 清单自己坏了，不是「没有到期」。**（2026-09-22 修）
   *
   * `tools/verify_pending.py` 的 `judge()` 里是 `code = 1 if (struct or od) else 0` ——
   * （原先这里写的是行号 `:275`。2026-09-22 同一个文件加了 D/E 两段判据、插进一百多行，
   *   那个行号当场指到了别处。§2.2 第 1 条：**指不准就别写数字**，改成函数名。）
   * **退 1 有两个来源**，到期明细（`od`）只是其中一个。另一个是结构错误
   * （id 重复 / 缺原话 / 指针指不到上游原话…）。
   *
   * 修之前这里**没有这一支**，于是「清单坏了」一路落到末尾的绿分支：状态记 `ok`、
   * 不发言；如果上一次是 `due`/`untested`，群里还会收到一句
   * **「✅ 待收清单：现在没有到期未收。」** —— 那是一句对外假话。
   *
   * 为什么基线那条链路没这个问题：`runCheckNow` 早就有兜底
   * （`code === 1 && !now.drifted.length` 时造一条占位漂移，「宁可说，不可沉默」）。
   * 待收这条**不对称地少了一半** —— 同一个病在同一份文件里活了两个版本。
   */
  if (code === 1) {
    if (prev.p_saidBrokenDay === day) {
      return { state: { ...st, p_lastState: 'broken' }, say: null, why: '今天的「清单坏了」已经说过一次' };
    }
    return {
      state: { ...st, p_lastState: 'broken', p_saidBrokenDay: day, ...saidTo(now, 'p_alertChat') },
      why: `退 1 但到期明细为空 —— 清单结构有 ${struct.length} 处错误`,
      say: [
        `⏳ **待收清单这次读出来是坏的** —— 退 1，但**一条到期明细都没给出**。`,
        ...struct.slice(0, 5).map((s) => `· ${s}`),
        struct.length > 5 ? `· …另有 ${struct.length - 5} 处，见 \`python3 tools/verify_pending.py\`` : null,
        `这不是「没有到期未收」，是**「这份清单现在不可信」** —— 它可能漏掉了已经到期的条目。`,
        `清单在 \`PMO/待收清单-v1.json\`；修好之后我会再核一次。`,
      ].filter(Boolean).join('\n'),
    };
  }

  if (code === 2) {
    if (prev.p_saidUntestedDay === day) {
      return { state: { ...st, p_lastState: 'untested' }, say: null, why: '今天的「未测」已经说过一次' };
    }
    return {
      state: { ...st, p_lastState: 'untested', p_saidUntestedDay: day, ...saidTo(now, 'p_alertChat') },
      why: '没读成 —— 报「未测」，不报「没有待收」',
      say: [
        `⚠️ **待收清单这次没读成**${now.reason ? `（${now.reason}）` : ''}。`,
        `这不是「没有到期未收」，是**「这次没测」** —— 我此刻不知道有没有承诺已经到期。`,
        `下次触发时会重试。`,
      ].join('\n'),
    };
  }

  // 退 0：到这里**才**能说这句「没有到期未收」——
  // 上面两支（到期 / 清单坏了 / 未测）都到不了这里，所以这句话不会被拿去冒充别的结论。
  if (prev.p_lastState === 'due' || prev.p_lastState === 'untested' || prev.p_lastState === 'broken') {
    return {
      // ★ 两个去重键都要清：`p_saidDueKey` 清了，`p_saidBrokenDay` 也必须清 ——
      //   否则「坏了 → 修好 → 当天又坏了」会因为是同一天而被吞掉，
      //   而这次坏是**修好之后新发生的**，不是「今天已经说过的那一次」。
      state: { ...st, p_lastState: 'ok', p_saidDueKey: null, p_saidBrokenDay: null, p_alertChat: null },
      // ★ 收尾回到当初通报去的那个群（同基线上方那段）—— 2026-10-02 那条到期提醒就是这个形状，
      //   而它的收尾如果发到另一个群，那边的人会看到一句「现在没有到期未收」而不知道在说什么。
      sayTo: closeTo(prev, 'p_alertChat'),
      why: '从到期/未测/清单坏了 恢复 —— 群里之前看到过异常，得看到它结束',
      say: `✅ 待收清单：现在没有到期未收。`,
    };
  }
  return { state: { ...st, p_lastState: 'ok', p_alertChat: null }, say: null, why: '没有到期未收，不刷屏' };
}

/** 触发一次待收检查（含换日去重）。与 `checkNow` 同一条单飞纪律，理由见那里。 */
export async function checkPending(opts = {}) {
  if (pendingInFlight) return { skipped: '上一次待收检查还在跑' };
  pendingInFlight = runCheckPending(opts);
  try { return await pendingInFlight; } finally { pendingInFlight = null; }
}

async function runCheckPending({ reason = 'daily', force = false, day = null, today = null, run = runPendingChecker,
                                chatId = null, dryRun = false, stateFile = null } = {}) {
  // ★ `stateFile` 可注入：存在的理由与 `runCheckNow` 里那条**完全一样** —— 自证要能证明
  //   「`dryRun` 下真的一字节都没落盘」，而这句话只有在能指定文件时才证得了。
  //   默认仍是那份真状态文件，生产路径不受影响。
  const file = stateFile ?? PENDING_STATE_FILE();
  const prev = loadState(file);
  const D = day ?? today ?? bjDate();
  if (!force && prev.p_lastDay === D) {
    return { skipped: `今天（${D}）已经跑过` };
  }
  const { code, note, data } = await run({ today });
  const now = {
    code,
    day: D,
    // ★ 同 `runCheckNow`：这次通报会发到哪个群（`p_alertChat` 的来源）。
    chatId,
    overdue: data?.overdue ?? [],
    // ★ 结构错误要一起带下去：`verify_pending.py` 的退 1 **有两个来源**（`struct or od`），
    //   只带 `overdue` 的话，「清单坏了但一条到期都没有」在状态机眼里和「没有问题」一样。
    structErrors: data?.struct_errors ?? [],
    // ★ F 段（2026-09-22 加）：`verify_pending.py` 算好的「问出去两个工作日了还没回」那批。
    //   它**不在退出码里**（那是刻意的，见 verify_pending.py 的 F 段注释）：读不出清单时
    //   `data` 是 null → 这里是空数组 → 落到下面 code===2 那一支说「没读成」。
    //   **没测到不许被说成「没有要补问的」。**
    nag: data?.nag ?? [],
    reason: data?.reason ?? note ?? '',
  };
  const { state, say, why, sayTo } = enterPending(prev, now);
  // ★ `today` 被注入时**不落状态** —— 那是一次「看一遍」，不是一次真跑。
  //   落了会很阴：state 里记下「10-03 已经说过」之后，**真正的 10-03 到了反而会闭嘴**，
  //   而群里什么都没收到。一次查看不该改掉将来要发生的事。
  //
  // ★ 2026-09-23（Q40 = 选项 A）补上**同形的另一半**：裸 `--pending`（不带 `--today=`）
  //   此前**照样落盘**。而 CLI 走的是 `force: true` —— 于是在终端里看一眼就把当天的
  //   额度用掉了：`enterPending` 写下 `p_saidDueKey`，daemon 的 `pendingWatch` 再问就是
  //   「今天已经说过」→ `say: null` → **那条到期提醒永远到不了群里**，而机器侧全绿
  //   （状态文件里那个键与「真的说过了」长得一模一样）。修法与 `--check` 完全同形。
  //
  //   ★ 代价**已逐条核过**（账本里 A 的 impact 点名要先确认这一件）：
  //     换日兜底读的是 `p_lastDay`（`ws_daemon.mjs` 心跳里那行），而 daemon 调
  //     `checkPending` **不带 `force`** → 一天最多一次。CLI 不再写 `p_lastDay`，
  //     只会让「`p_lastDay !== 今天`」**更容易**成立 —— 也就是 daemon 会补跑并发出去，
  //     方向正是我们要的；**也不会变成轮询**，因为 daemon 那一支每次真跑都会落 `p_lastDay`。
  if (dryRun || today) {
    return { code, note, say, why, sayTo: sayTo ?? null, reason, overdue: now.overdue,
             dryRun: today
               ? `注入日 ${today} —— 未落状态`
               : 'CLI 看一眼 —— 未落状态（否则会吞掉当天的到期提醒）' };
  }
  saveState(state, file);
  return { code, note, say, why, sayTo: sayTo ?? null, reason, overdue: now.overdue };
}

/* ─────────────────────── 反向对照（离线，不动盘不联网） ─────────────────────── */

/**
 * 证明这套告警**两边都对**：该说的时候说，该闭嘴的时候闭嘴。
 * 只证一边的都是坏检查器 —— 恒说的刷屏，恒不说的等于没有。
 */
export async function selftest() {
  /**
   * ★★ **自证一开始就把状态目录指到临时目录**（2026-10-12 加）。
   *
   * 原先只有**逐个调用点**去隔离（`dryRun` 或 `stateFile`），于是一旦有人加一条
   * 新的副产品落盘，隔离就漏一个 —— 实测就漏过：明细文件写死 `stateDir()`，
   * 跑一次自证就在真状态目录下留下一个 311 字节的文件（§2.4.4 那个病）。
   * 而且那 8 处注入点本来就一直往真目录里写 `_selftest-tmp-state.json`。
   *
   * 改成**一条不变量**：自证期间 `stateDir()` **不是**真的那个。
   * 这样**以后任何**新增的落盘都自动隔离，不必每加一个就补一次
   * （`AGENTS.md` §2.5：同一个形状只能有一处实现）。
   * 下面还有一条断言专门验这件事，免得这句话本身没人执行。
   */
  const realStateDir = path.join(REPO_ROOT, 'PMO', 'shouheng-state');
  const tmpStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-selftest-state-'));
  const prevStateDirEnv = process.env.SHOUHENG_STATE_DIR;
  process.env.SHOUHENG_STATE_DIR = tmpStateDir;
  try {
    return await selftestBody(realStateDir);
  } finally {
    if (prevStateDirEnv === undefined) delete process.env.SHOUHENG_STATE_DIR;
    else process.env.SHOUHENG_STATE_DIR = prevStateDirEnv;
    try { fs.rmSync(tmpStateDir, { recursive: true, force: true }); } catch { /* 清不掉就算了 */ }
  }
}

async function selftestBody(realStateDir) {
  const D = '2026-09-21';
  /** 注入用的「现在」。`recheckDue()` 是纯函数且 `t` 可注入 —— 所以「冷却前/后」两侧都造得出来，不必真等 30 分钟。 */
  const T0 = Date.parse('2026-09-22T09:30:00.000Z');
  const drift = (fp) => ({ code: 1, day: D, untested: [], drifted: [{ file: 'A.md', old: 'a'.repeat(64), now: fp }] });
  /**
   * ★★ 2026-09-30 事故那份**真实的**输出形状（逐字抄自 `PMO/logs`）：
   *   退 1 **全部来自 R 段**，L1/L2/L3 三层全绿 —— 上游那份 PRD 一个字都没改。
   *   用它做**行为级**输入，才能盯住 `checkNow` 里那条伪造路径；
   *   光测纯函数 `enter()` 是盯不住的（反向对照实测：把伪造放回去，纯函数那些用例照样全绿）。
   */
  const R_OUT = '❌ [R] H3 每处引用都指到 v1.2 里那一节的名字 · R2 · PMO/x.json §11.2：'
              + '仓库里有这处引用，登记表里没有（新引用要登记）\n\n退出码 1\n';
  /**
   * ★★ **当前真机输出那种形状**（2026-10-12 逐字抄自 `python3 tools/verify_prd_baseline.py`）。
   *
   * 与上面 `R_OUT` **不是同一个形状**，而且这个差别是要命的：
   *   `R_OUT`      ：`名字 · R2 · 文件 §…`      ← 分隔符是 `·`
   *   `R_OUT_REAL` ：`名字   R2 · 文件 §…`      ← 分隔符是**两个以上空格**，`R2` 在 `·` 之前
   *
   * 为什么必须两份都要：第一版判据只按 `·` 切标签，而 `R_OUT` 恰好用 `·` 分列 ——
   * 于是「按 `·` 切」和「按空格切」在它上面**看不出区别**，那条断言看着在测这件事、
   * 实际喂的输入**区分不出来**。变异实测：把切法改回 `split('·')`，整套 **0 项红**。
   * 这正是本项目记过的那个坑（fixture 同时含两种特征 → 删掉规则仍然绿）。
   * 下面另有一条断言专门盯着「这两份 fixture 不许退化成同一个形状」。
   */
  const R_OUT_REAL = '  ❌ [R] H3 每处引用都指到 v1.2 里那一节的名字   R2 · AGENTS.md §5.1：'
                   + '仓库里有这处引用，登记表里没有（新引用要登记 —— 登记时填的那一栏就是'
                   + '「指到 v1.2 里那一节的名字」）\n❌ 80 项中 1 项失败\n';
  /** 待收清单的假样本：n 件到期未收（用的是 P-03 的真实字段形状） */
  const pdue = (n) => ({
    code: 1, day: D,
    overdue: Array.from({ length: n }, (_, i) => ({
      id: `P-0${i + 1}`, 事项: '其余品线的规则库（吸奶器之外）', 到期日: '2026-10-02',
      过期天数: 0, 原话: '其它已跟业务沟通接下来两周陆续整理提供', 到期日来源: '我方推算',
    })),
  });
  const dueKey = (n) => Array.from({ length: n }, (_, i) => `P-0${i + 1}@2026-10-02`).sort().join('|');
  /** F 段的假样本：n 件「问出去两个工作日了还没回」。
   *  字段形状照抄 `tools/verify_pending.py` 的 `ask_nags()` —— **两处形状必须一致**，
   *  这里抄错一个键名，测出来的就是另一个东西而它照样全绿。 */
  const pnag = (n) => ({
    code: 0, day: D, overdue: [], structErrors: [],
    nag: Array.from({ length: n }, (_, i) => ({
      id: `P-0${i + 1}`, 事项: '法务侧「谁来确认 62 条外部标准、大概多久」这个口径',
      问于: '2026-09-17', 工作日: 2,
      问题: '顺带把 15:42 问的那句定掉：**确认人是谁、大概多久**。',
    })),
  });
  const cases = [
    ['绿 → 绿：不许刷屏', () => enter({ lastState: 'ok' }, { code: 0, day: D, drifted: [], untested: [] }).say === null],
    ['第一次漂移 → **必须说**', () => typeof enter({ lastState: 'ok' }, drift('b'.repeat(64))).say === 'string'],
    ['同一个漂移再说一次 → 闭嘴（防刷屏）',
      () => enter({ lastState: 'drift', saidDriftFp: `A.md:${'b'.repeat(64)}` }, drift('b'.repeat(64))).say === null],
    ['漂移指纹变了一个字符 → **必须再说**（又改了一版）',
      () => typeof enter({ lastState: 'drift', saidDriftFp: `A.md:${'b'.repeat(64)}` }, drift('c'.repeat(64))).say === 'string'],
    ['未测 → **必须说**，且文案里要出现「没测」/「未测」',
      () => { const r = enter({ lastState: 'ok' }, { code: 2, day: D, drifted: [], untested: ['A.md'] });
              return typeof r.say === 'string' && /没测|未测/.test(r.say); }],
    ['★ 未测**不许**被说成「没问题」/「正常」（否定域不算，同 V25b）',
      () => { const r = enter({ lastState: 'ok' }, { code: 2, day: D, drifted: [], untested: ['A.md'] });
              return !/没问题|一切正常|正常/.test(stripNegated(r.say)); }],
    ['反向对照：换成一句真的「一切正常」→ 上面那条判据必须红（否则它恒真）',
      () => /没问题|一切正常|正常/.test(stripNegated('检查完成：上游一切正常，没问题'))],
    ['★ 反向对照：`不用重拉基线` 是**劝阻**、必须被剥掉；而同一句里裸的 `请重拉基线` **必须留下**',
      () => stripNegated('不用重拉基线').includes('重拉') === false
            && stripNegated('不用管这个，请重拉基线').includes('重拉') === true],
    ['★ 反向对照：`不需要`/`无需`/`不必` 同样算否定域（上面那条不是只对 `不用` 成立）',
      () => ['不需要重拉', '无需重拉', '不必重拉'].every((t) => !stripNegated(t).includes('重拉'))],
    ['反向对照：`这不是「没问题」` 必须被剥掉；而裸的 `没问题` 必须留下',
      () => stripNegated('这不是「没问题」') === '' || !/没问题/.test(stripNegated('这不是「没问题」'))
            ? /没问题/.test(stripNegated('上游没问题')) : false],
    ['同一天第二次未测 → 闭嘴（每天最多一次）',
      () => enter({ lastState: 'untested', saidUntestedDay: D }, { code: 2, day: D, drifted: [], untested: [] }).say === null],
    ['第二天仍未测 → **再说**（昨天的通报不算今天的）',
      () => typeof enter({ lastState: 'untested', saidUntestedDay: '2026-09-20' },
                         { code: 2, day: D, drifted: [], untested: [] }).say === 'string'],
    ['从漂移回到绿 → **必须说**（群里看到过异常，得看到它结束）',
      () => typeof enter({ lastState: 'drift' }, { code: 0, day: D, drifted: [], untested: [] }).say === 'string'],
    ['从未测回到绿 → **必须说**', () => typeof enter({ lastState: 'untested' }, { code: 0, day: D, drifted: [], untested: [] }).say === 'string'],

    /* ── ★★ 退 1 ≠ 上游改版（2026-09-30；事故：把「引用登记不一致」说成「上游 PRD 改版了」）──
     *
     * 事故原样（`PMO/logs/ws_outbound.jsonl` 2026-09-30 19:32）：
     *
     * ```
     * ⚠️ 上游 PRD 改版了 —— 我手上那份基线已经过期。
     * · （输出里没抠到具体文件，见 PMO/logs）  旧指纹 `` → 新指纹 ``
     * 请给我一分钟重拉一次基线并记新指纹；在那之前，凡是引用这份 PRD 的判断都按旧版算。
     * ```
     *
     * 而同一轮实跑：**L1 11 ✅ / L2 6 ✅ / L3 7 ✅** —— 三层全绿，退 1 全部来自 R 段。
     * 根因是 `checkNow` 里**伪造**了一条 drifted 占位符（见那里的注释），
     * 于是「抠不出指纹」被冒充成了「上游改版」。
     *
     * 这一组是**一对正反面**，缺任一边都测不出病：
     *   · 退 1 且抠得出指纹 → 必须说，**且必须真的说成「上游改版」**
     *     （原有那条只管「说了」，没管「说成什么」—— 只说一句「退 1 了」也照样绿）；
     *   · 退 1 且抠不出指纹 → 照旧**必须说**（宁可说，不可沉默），
     *     但**不许**说成「上游改版」，也不许叫人去重拉基线。
     */
    ['★ 退 1 且抠得出指纹 → 文案必须**真的指向上游改版**（原有那条只管「说了」）',
      () => /上游[^\n]{0,8}改版了/.test(stripNegated(enter({ lastState: 'ok' }, drift('b'.repeat(64))).say))],
    ['★★ 退 1 但抠不出指纹 → **必须说**（宁可说，不可沉默 —— 沿用原作者那条）',
      () => { const r = enter({ lastState: 'ok' }, { code: 1, day: D, drifted: [], untested: [] });
              return typeof r.say === 'string' && r.say.length > 30; }],
    ['★★ 而且**不许**把它说成「上游 PRD 改版了」（本次事故的直接判据）',
      () => { const r = enter({ lastState: 'ok' }, { code: 1, day: D, drifted: [], untested: [] });
              return !/上游[^\n]{0,8}改版了/.test(stripNegated(r.say)); }],
    ['★ 反向对照：上面那条判据**不是恒真** —— 喂真·上游改版必须命中',
      () => /上游[^\n]{0,8}改版了/.test(stripNegated(enter({ lastState: 'ok' }, drift('b'.repeat(64))).say))],
    ['★ 而且不许叫人去重拉基线 / 按旧版算（上游没变，那是白做工且误导）',
      () => { const r = enter({ lastState: 'ok' }, { code: 1, day: D, drifted: [], untested: [] });
              return !/重拉|请给我一分钟|按旧版算/.test(stripNegated(r.say)); }],
    ['★ 状态必须落进 `unparsed`，**不许**落进 `drift`（否则收尾那句会回头补上「上游恢复了」）',
      () => enter({ lastState: 'ok' }, { code: 1, day: D, drifted: [], untested: [] }).state.lastState === 'unparsed'],
    ['反向对照：真的上游改版仍必须落进 `drift`（上面那条不是恒真）',
      () => enter({ lastState: 'ok' }, drift('b'.repeat(64))).state.lastState === 'drift'],
    ['退 1 但抠不出指纹：同一天第二次 → 闭嘴',
      () => enter({ lastState: 'unparsed', saidUnparsedDay: D },
                  { code: 1, day: D, drifted: [], untested: [] }).say === null],
    ['退 1 但抠不出指纹：第二天 → **再说**（昨天的通报不算今天的）',
      () => typeof enter({ lastState: 'unparsed', saidUnparsedDay: '2026-09-20' },
                         { code: 1, day: D, drifted: [], untested: [] }).say === 'string'],
    ['★ 两类去重**互不顶掉**：今天说过「非上游改版」，也不能让真·上游改版闭嘴',
      () => typeof enter({ lastState: 'unparsed', saidUnparsedDay: D }, drift('b'.repeat(64))).say === 'string'],
    ['★ 从「退 1 非上游改版」回到退 0 → 必须说，**且不许**补一句「上游基线检查恢复了」',
      () => { const back = enter({ lastState: 'unparsed', alertChat: 'oc_A' },
                                 { code: 0, day: D, drifted: [], untested: [], chatId: null });
              return typeof back.say === 'string' && !/上游基线检查恢复了/.test(back.say); }],
    ['★ 退 1 非上游改版也带地址（通报带地址、收尾回同一个群，与另两支同规矩）',
      () => { const r = enter({ lastState: 'ok' }, { code: 1, day: D, drifted: [], untested: [], chatId: 'oc_C' });
              return r.say !== null && r.state.alertChat === 'oc_C'; }],
    ['★★ 喂**本次事故那份真实的 R 段输出** → `parseDrift()` 必须抠不出任何指纹',
      () => parseDrift(R_OUT).length === 0],
    ['★ `saidUnparsedDay` 必须在状态白名单里 —— 不在的话下一次读状态就被 `pick` 丢掉，「非上游改版」会每天重发',
      () => BASELINE_KEYS.includes('saidUnparsedDay')
            && 'saidUnparsedDay' in enter({ lastState: 'ok' }, { code: 1, day: D, drifted: [], untested: [] }).state],

    /* ── ★★ 「红的是哪几条」必须**读出来**，不许猜（2026-10-12 加） ──
     *   修的是这样一句话：「红来自检查器内部（**多半是**「章节引用登记」那一段）」——
     *   一次历史观测被写成了事实。红落到别处时它会自信地指错方向，而读者看不出那是猜的。
     *   ★ 核心那条是**反向对照**（喂「红在别处」必须说那一条）：只断言「说得出 H3」
     *   的话，把那句猜测原样放回去也照样全绿 —— 因为事故现场恰好就是 H3。
     */
    ['★★ 不变量：自证期间 `SHOUHENG_STATE_DIR` 必须指着临时目录 —— `stateDir()` **不是**真的那个',
      () => stateDir() !== realStateDir && stateDir().startsWith(os.tmpdir())],
    ['★ 反向对照：真的那个状态目录必须**就是** `PMO/shouheng-state`（上面那条不是恒真 —— 它得有个可比的对象）',
      () => realStateDir === path.join(REPO_ROOT, 'PMO', 'shouheng-state')
            && !realStateDir.startsWith(os.tmpdir())],
    ['★★ 判据级：真实形状的输出 → `parseFailures()` 必须点名 H3，且标签**不许**把子号 `R2` 混进来',
      () => { const f = parseFailures(R_OUT);
              return f.length === 1 && f[0].id === 'H3' && f[0].count >= 1
                  && f[0].label.includes('每处引用') && !/\bR2\b/.test(f[0].label)
                  && f[0].files.includes('PMO/x.json'); }],
    ['★★★ 判据级（**真机那种分列格式**，与上面那份**不同形状**）→ 标签必须**恰好**是那个名字，`R2` 一个字符都不许混进来',
      () => { const f = parseFailures(R_OUT_REAL);
              return f.length === 1 && f[0].id === 'H3'
                  && f[0].label === '每处引用都指到 v1.2 里那一节的名字'
                  && !/\bR2\b/.test(f[0].label) && f[0].files.includes('AGENTS.md'); }],
    ['★ 上面两份 fixture **必须是不同形状**（一个 `名字 · R2`、一个 `名字   R2`）—— 否则那条断言会退化成恒真',
      () => R_OUT.includes('名字 · R2') && R_OUT_REAL.includes('名字   R2')],
    ['★ 真实形状里**摘要行不许被当成红条目**（`❌ 80 项中 1 项失败` 与那条 H3 同处一份输出）',
      () => parseFailures(R_OUT_REAL).length === 1],
    ['★ 反向对照：只带摘要行 `❌ 80 项中 53 项失败` → 必须 0 条（证明上面那条不是恒真 —— 摘要行不是红条目）',
      () => parseFailures('❌ 80 项中 53 项失败\n').length === 0],
    ['★★ 反向对照（本次修复的核心）：喂**红在别处**的输出 → 文案必须说那一条，**不许**再提「章节引用登记」',
      () => { const s = failuresLine(parseFailures('  ❌ [L1] L1 结构   L1a · 索引缺 docs：x\n'));
              return s.includes('L1') && !s.includes('H3') && !s.includes('章节引用登记'); }],
    ['★ 一条都读不出时**必须明说读不出**，不许补一句猜测（原先那句「多半是…」就是替它猜的）',
      () => { const s = failuresLine([]); return s.includes('没抠出') && !s.includes('多半是'); }],
    ['★ 未落盘时**不许**印出任何明细路径（一个点不开的路径比不印更糟）',
      () => !/\.txt|shouheng-state/.test(detailFileLine(null))],
    ['★ 反向对照：真落了盘时**必须**把路径印出来（上面那条不是恒真）',
      () => detailFileLine('PMO/shouheng-state/prd-baseline-last-check.txt')
              .includes('prd-baseline-last-check.txt')],
    ['★★ 行为级：退 1 真跑一次 → **必须**把完整明细落盘，且正文里印的路径与落盘的是同一个',
      async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-detail-'));
        const old = process.env.SHOUHENG_STATE_DIR;
        process.env.SHOUHENG_STATE_DIR = dir;   // ★ `stateDir()` 是惰性的，改了立刻生效
        try {
          const r = await checkNow({ force: true, stateFile: path.join(dir, 's.json'),
                                     run: async () => ({ code: 1, note: '', out: R_OUT }) });
          const f = path.join(dir, 'prd-baseline-last-check.txt');
          if (!fs.existsSync(f)) return false;
          const body = fs.readFileSync(f, 'utf8');
          return body.includes('H3 每处引用') && body.includes('退出码 1')
              && typeof r.say === 'string'
              && r.say.includes('prd-baseline-last-check.txt') && r.say.includes('H3');
        } finally {
          if (old === undefined) delete process.env.SHOUHENG_STATE_DIR;
          else process.env.SHOUHENG_STATE_DIR = old;
          try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清不掉就算了 */ }
        }
      }],
    ['★★★ 判据级：明细必须落在**这次运行的 `stateFile` 旁边** —— 两个目录**故意不同**才区分得出来',
      async () => {
        /**
         * ★ 为什么非要两个不同目录：上面那条「必须落盘」的用例里
         *   `SHOUHENG_STATE_DIR` 与 `stateFile` 指的是**同一个目录**，
         *   于是「跟着 `stateFile` 走」与「写死 `stateDir()`」**看不出任何区别**。
         *   变异实测：把实现改回写死 `stateDir()`，上面那条**照样全绿**。
         *   这正是本项目反复记的那个坑（输入区分不出来 → 断言看着在测、实际没测）。
         */
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-detail-'));
        const other = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-detail-'));
        const old = process.env.SHOUHENG_STATE_DIR;
        process.env.SHOUHENG_STATE_DIR = other;       // ★ `stateDir()` 指这里
        try {
          if (dir === other) return false;            // 前提本身不许塌
          await checkNow({ force: true, stateFile: path.join(dir, 's.json'),
                           run: async () => ({ code: 1, note: '', out: R_OUT }) });
          return fs.existsSync(path.join(dir, 'prd-baseline-last-check.txt'))     // 跟着 stateFile ✓
              && !fs.existsSync(path.join(other, 'prd-baseline-last-check.txt')); // 没落到 stateDir ✗
        } finally {
          if (old === undefined) delete process.env.SHOUHENG_STATE_DIR;
          else process.env.SHOUHENG_STATE_DIR = old;
          for (const d of [dir, other]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 清不掉就算了 */ } }
        }
      }],
    ['★ 行为级反向对照：`dryRun` 下**一个字节都不许落盘**（否则跑一次 `--check` 就改了盘，`--check` 的卖点是纯查看）',
      async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-detail-'));
        const old = process.env.SHOUHENG_STATE_DIR;
        process.env.SHOUHENG_STATE_DIR = dir;
        try {
          await checkNow({ force: true, dryRun: true, stateFile: path.join(dir, 's.json'),
                           run: async () => ({ code: 1, note: '', out: R_OUT }) });
          return !fs.existsSync(path.join(dir, 'prd-baseline-last-check.txt'));
        } finally {
          if (old === undefined) delete process.env.SHOUHENG_STATE_DIR;
          else process.env.SHOUHENG_STATE_DIR = old;
          try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清不掉就算了 */ }
        }
      }],
    ['★★ 行为级：`dryRun` 下正文**不许**印出一个并不存在的路径（说了有却打不开，比不说更糟）',
      async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-detail-'));
        const old = process.env.SHOUHENG_STATE_DIR;
        process.env.SHOUHENG_STATE_DIR = dir;
        try {
          const r = await checkNow({ force: true, dryRun: true, stateFile: path.join(dir, 's.json'),
                                     run: async () => ({ code: 1, note: '', out: R_OUT }) });
          return typeof r.say === 'string' && !r.say.includes('prd-baseline-last-check.txt');
        } finally {
          if (old === undefined) delete process.env.SHOUHENG_STATE_DIR;
          else process.env.SHOUHENG_STATE_DIR = old;
          try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清不掉就算了 */ }
        }
      }],
    ['★★★ 行为级（本次修复的核心）：喂**红在别处**的输出去真跑一次 → 正文必须报那一条，**不许**报「章节引用登记」',
      async () => {
        /**
         * ★ 为什么上面那条纯函数级的不够：事故现场**恰好就是 H3**。
         *   把原先那句「多半是「章节引用登记」那一段」原样放回去，
         *   纯函数那组、以及那条喂 `R_OUT` 的行为级断言**统统照样全绿** ——
         *   因为它们的输入正好就是那次事故的形状（`AGENTS.md` §2.4：
         *   只测纯函数 = 只测了「拿到正确输入时说得对不对」）。
         *   只有把**红在别处**的输入真的喂进 `checkNow`，才验得了「它是读出来的，不是猜的」。
         */
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-detail-'));
        const old = process.env.SHOUHENG_STATE_DIR;
        process.env.SHOUHENG_STATE_DIR = dir;
        try {
          const r = await checkNow({ force: true, dryRun: true, stateFile: path.join(dir, 's.json'),
            run: async () => ({ code: 1, note: '',
              out: '  ❌ [L1] L1 结构   L1a · 索引缺 docs：x\n❌ 80 项中 1 项失败\n' }) });
          return typeof r.say === 'string' && r.say.includes('L1')
              && !r.say.includes('H3') && !r.say.includes('章节引用登记');
        } finally {
          if (old === undefined) delete process.env.SHOUHENG_STATE_DIR;
          else process.env.SHOUHENG_STATE_DIR = old;
          try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清不掉就算了 */ }
        }
      }],

    /* ── ★★ 上面那些测的是纯函数 `enter()`。**必须再有一条行为级**： ──
     *   反向对照实测：把 `checkNow` 里那段伪造 drifted 原样放回去，
     *   纯函数那一组**照样全绿** —— 因为伪造发生在 `checkNow` 的**上游**，
     *   喂进 `enter()` 的已经不是 `drifted: []` 了。
     *   只测纯函数 = 只测了「拿到正确输入时说得对不对」，
     *   而本次事故的病是「**喂进去的输入被伪造过**」。（`AGENTS.md` §2.4：函数写对了，
     *   但没人断言它被接上 / 没人断言喂进去的是什么。）
     */
    ['★★ 行为级：喂事故那份真实输出（退 1、无上游指纹）→ `say` **不许**出现「上游改版」、也不许叫人重拉基线',
      async () => {
        const f = path.join(stateDir(), '_selftest-tmp-state.json');
        try {
          fs.writeFileSync(f, JSON.stringify({ lastRunAt: '2020-01-01T00:00:00.000Z',
                                               lastDay: '2020-01-01', lastState: 'ok' }));
          const r = await checkNow({ force: true, dryRun: true, stateFile: f,
                                     run: async () => ({ code: 1, note: '', out: R_OUT }) });
          return typeof r.say === 'string'
              && !/上游[^\n]{0,8}改版了/.test(stripNegated(r.say))
              && !/重拉|请给我一分钟|按旧版算/.test(stripNegated(r.say));
        } finally { try { fs.unlinkSync(f); } catch { /* 已经没了就算了 */ } }
      }],
    ['★ 行为级反向对照：同样的注入方式喂**真的上游漂移输出** → 必须说「上游改版了」（上面那条不是恒真）',
      async () => {
        const f = path.join(stateDir(), '_selftest-tmp-state.json');
        try {
          fs.writeFileSync(f, JSON.stringify({ lastRunAt: '2020-01-01T00:00:00.000Z',
                                               lastDay: '2020-01-01', lastState: 'ok' }));
          const out = '★★ 上游改版了：PRD/feishu/x.md\n   索引指纹 ' + '1'.repeat(64)
                    + '\n   现场指纹 ' + '2'.repeat(64) + '\n';
          const r = await checkNow({ force: true, dryRun: true, stateFile: f,
                                     run: async () => ({ code: 1, note: '', out }) });
          return /上游[^\n]{0,8}改版了/.test(stripNegated(r.say));
        } finally { try { fs.unlinkSync(f); } catch { /* 已经没了就算了 */ } }
      }],

    /* ── ★★ 上游「什么时候改的」必须进告警（2026-10-12 加）──────────────
     *   出生理由：告警只说「请给我一分钟重拉一次基线」，没说上游什么时候改的 ——
     *   而「现在就拉、还是等它改完」正是读者唯一要判断的事。实测那天为答这个问题，
     *   得翻 daemon 日志时间线 + 手工调一次 metas 接口，才拼出那个 90 秒窗口。
     *   检查器现在把 `上游最后改动 …（N 分钟前）` 印在 `现场指纹` 的下一行。
     */
    ['★★ 判据级：带「上游最后改动」行的输出 → `parseDrift()` 必须把它抠出来',
      () => { const o = '★★ 上游改版了：A.md\n   索引指纹 ' + '1'.repeat(64) + '\n   现场指纹 '
                     + '2'.repeat(64) + '\n   上游最后改动 2026-10-12 17:44:01（北京时间，3 分钟前）\n';
              const d = parseDrift(o);
              return d.length === 1 && typeof d[0].at === 'string'
                  && d[0].at.includes('2026-10-12 17:44:01') && d[0].file === 'A.md'; }],
    ['★★ 反向对照：**不带**那一行的（老版本检查器的输出）→ 漂移**仍必须被解析出来**，只是 `at` 为 null',
      () => { const o = '★★ 上游改版了：A.md\n   索引指纹 ' + '1'.repeat(64)
                     + '\n   现场指纹 ' + '2'.repeat(64) + '\n';
              const d = parseDrift(o);
              return d.length === 1 && d[0].at === null; }],
    ['★★ 行为级：喂带时刻的漂移输出 → 告警正文里必须**看得见那个时刻**',
      async () => {
        const f = path.join(stateDir(), '_selftest-tmp-state.json');
        try {
          fs.writeFileSync(f, JSON.stringify({ lastRunAt: '2020-01-01T00:00:00.000Z',
                                               lastDay: '2020-01-01', lastState: 'ok' }));
          const out = '★★ 上游改版了：PRD/feishu/x.md\n   索引指纹 ' + '1'.repeat(64)
                    + '\n   现场指纹 ' + '2'.repeat(64)
                    + '\n   上游最后改动 2026-10-12 17:44:01（北京时间，3 分钟前）\n';
          const r = await checkNow({ force: true, dryRun: true, stateFile: f,
                                     run: async () => ({ code: 1, note: '', out }) });
          return typeof r.say === 'string' && /上游[^\n]{0,8}改版了/.test(stripNegated(r.say))
              && r.say.includes('2026-10-12 17:44:01');
        } finally { try { fs.unlinkSync(f); } catch { /* 已经没了就算了 */ } }
      }],

    /* ── ★★ 通报带地址，收尾必须带同一个地址（2026-09-22；事故见上面 `alertChat` 那段）────
     *
     * 这四条是**一对正反面 × 两个维度**，与前面「跳过/补跑」那组同一写法：
     *   · 通报时不许不记地址（否则收尾无处可回 —— 就是本次事故）；
     *   · 从没通报过时不许凭空指一个群（否则再造一次「往没收到过告警的群发收尾」）；
     *   · 重复触发（闭嘴那支）不许把已记的地址抹掉；
     *   · 收尾之后必须清空（否则下一次恢复又发回一个早已无关的群）。
     */
    ['★★ 漂移通报在 A 群 → 恢复通知的 `sayTo` **必须还是 A 群**（本次事故的直接判据）',
      () => { const A = 'oc_TEST_GROUP';
              const d = enter({ lastState: 'ok' }, { ...drift('e'.repeat(64)), chatId: A });
              if (d.state.alertChat !== A) return false;                       // 通报必须记下地址
              const back = enter(d.state, { code: 0, day: D, drifted: [], untested: [], chatId: null });
              return back.say !== null && back.sayTo === A; }],                 // 收尾必须回到 A
    ['★ 反向对照：从没通报过（没有 `alertChat`）→ 收尾的 `sayTo` 必须是 null，**不许凭空指一个群**',
      // 这一条正是 17:55 那次干的事：`oc_7775…` 从没收到过告警，却收到一句「✅ 恢复了」。
      // `sayTo === null` 让调用方退回 `resolveChat()`；而 `lastState` 不是红/未测时
      // 这一支根本不会被走到 —— 两道门都不许把它放过去。
      () => { const back = enter({ lastState: 'drift' }, { code: 0, day: D, drifted: [], untested: [], chatId: 'oc_x' });
              return back.sayTo === null; }],
    ['★ 反向对照：同一个漂移指纹再说一次（闭嘴那支）→ **不许把已记的地址抹掉**',
      // 真实形状：18:23 与 18:24 那两次 link 触发都落在冷却里，复跑一次就会走这一支。
      // 抹掉它，收尾就又没了地址 —— 与本次事故同一个后果，只是换了条路径进来。
      () => { const A = 'oc_A', fp = 'f'.repeat(64);
              const first = enter({ lastState: 'ok' }, { ...drift(fp), chatId: A });
              const again = enter(first.state, { ...drift(fp), chatId: 'oc_别的群' });
              return again.say === null && again.state.alertChat === A; }],
    ['★ 收尾之后 `alertChat` 必须清空（否则下一次恢复又发回一个早已无关的群）',
      () => { const back = enter({ lastState: 'drift', alertChat: 'oc_A' },
                                 { code: 0, day: D, drifted: [], untested: [], chatId: null });
              return back.state.alertChat === null; }],
    ['★ 未测通报也带地址（与漂移同一条规矩，少一处就等于那一支的收尾丢了地址）',
      () => { const r = enter({ lastState: 'ok' }, { code: 2, day: D, drifted: [], untested: ['A.md'], chatId: 'oc_B' });
              return r.say !== null && r.state.alertChat === 'oc_B'; }],
    ['★ 待收：同一个形状 —— 到期提醒在 B 群 → 收尾的 `sayTo` 必须是 B 群',
      () => { const B = 'oc_TEST_GROUP';
              const due = enterPending({ p_lastState: 'ok' }, { ...pdue(1), chatId: B });
              if (due.state.p_alertChat !== B) return false;
              const back = enterPending(due.state, { code: 0, day: D, overdue: [], chatId: null });
              return back.say !== null && back.sayTo === B; }],
    ['★ 待收反向对照：从没通报过 → 收尾的 `sayTo` 必须是 null（上面那条不是恒真）',
      () => enterPending({ p_lastState: 'due' }, { code: 0, day: D, overdue: [], chatId: 'oc_x' }).sayTo === null],

    /* ── ★ 地址优先级（`pickAlertTarget`）：事故就发生在这一跳上，而它原先没有判据 ── */
    ['★★ 收尾地址**优先于**触发群与默认群（`sayTo` 是谁就用谁 —— 本次事故那一跳）',
      () => pickAlertTarget({ sayTo: 'oc_A', triggerChat: 'oc_别的群', fallback: 'oc_默认群' }) === 'oc_A'],
    ['没有收尾地址时，退回**触发群**（`[link]` 那次告警就该发在链接所在的群）',
      () => pickAlertTarget({ sayTo: null, triggerChat: 'oc_链接那个群', fallback: 'oc_默认群' }) === 'oc_链接那个群'],
    ['★ 反向对照：三个都没有 → 必须是 null（**不许**悄悄挑一个群 —— 那正是「往没收到过告警的群发收尾」）',
      () => pickAlertTarget({}) === null && pickAlertTarget({ sayTo: null, triggerChat: null, fallback: null }) === null],
    ['漂移也算一种「说过」：进入 drift 后 lastState 必须是 drift',
      () => enter({}, drift('d'.repeat(64))).state.lastState === 'drift'],
    ['★ 不认识的退出码（137 被杀）→ 必须落进 untested，**不许当绿**',
      () => enter({ lastState: 'ok' }, { code: 137, day: D, drifted: [], untested: [] }).state.lastState === 'untested'],
    ['反向对照：未测状态下退出码 0 必须回 ok（上面那条不是恒真）',
      () => enter({ lastState: 'untested' }, { code: 0, day: D, drifted: [], untested: [] }).state.lastState === 'ok'],
    ['链接识别：认 wiki/docx/base/sheets，不认普通网页',
      () => LARK_DOC_RE.test('见 https://momcozy-in.feishu.cn/wiki/NB55wAq8liEOdKkquL2cgtPEnmg')
            && LARK_DOC_RE.test('https://x.feishu.cn/base/HPiqbafDTaJV0vsCqD0c3m0UnAe?from=auth_notice')
            && !LARK_DOC_RE.test('https://example.com/wiki/abc')],
    ['从输出里抠漂移指纹（喂本次真实的输出形状）',
      () => { const o = '★★ 上游改版了：A.md\n   索引指纹 ' + '1'.repeat(64) + '\n   现场指纹 ' + '2'.repeat(64) + '\n';
              const d = parseDrift(o); return d.length === 1 && d[0].file === 'A.md' && d[0].now === '2'.repeat(64); }],
    ['抠不到指纹时 parseDrift 回空数组（**不许**凭空造一个）', () => parseDrift('随便一段话').length === 0],

    /* ── 待收清单的到期提醒（enterPending）── */
    ['待收：无到期 → 不许刷屏', () => enterPending({ p_lastState: 'ok' }, { code: 0, day: D, overdue: [] }).say === null],
    ['待收：第一次到期 → **必须说**', () => typeof enterPending({ p_lastState: 'ok' }, pdue(1)).say === 'string'],
    ['待收：同一天同一批再说一次 → 闭嘴（防刷屏）',
      () => enterPending({ p_lastState: 'due', p_saidDueKey: dueKey(1), p_saidDueDay: D }, pdue(1)).say === null],
    ['待收：第二天仍未收到 → **必须再说**（昨天说过不算今天）',
      () => typeof enterPending({ p_lastState: 'due', p_saidDueKey: dueKey(1), p_saidDueDay: '2026-09-20' }, pdue(1)).say === 'string'],
    ['待收：到期集合变了（多了一件）→ **必须再说**',
      () => typeof enterPending({ p_lastState: 'due', p_saidDueKey: dueKey(1), p_saidDueDay: D }, pdue(2)).say === 'string'],
    ['★ 待收：到期文案里不许出现「没问题/正常」（否定域不算，同 V25b）',
      () => !/没问题|一切正常|正常/.test(stripNegated(enterPending({}, pdue(1)).say))],
    ['★ 待收：文案必须带原话 + 说明那个日子是我方推算的 —— 否则读者会以为日期是对方给的',
      () => { const s = enterPending({}, pdue(1)).say;
              return s.includes('其它已跟业务沟通') && s.includes('不是对方给的日期'); }],
    ['待收：未测 → **必须说**，且文案里要出现「没测/未测」',
      () => { const r = enterPending({ p_lastState: 'ok' }, { code: 2, day: D, overdue: [], reason: '清单读不出' });
              return typeof r.say === 'string' && /没测|未测/.test(r.say); }],
    ['★ 待收：未测**不许**被说成「没有到期未收」',
      () => !/没有到期未收/.test(stripNegated(enterPending({}, { code: 2, day: D, overdue: [], reason: 'x' }).say))],
    ['反向对照：一句真的「没有到期未收」→ 上面那条判据必须能抓到（否则它恒真）',
      () => /没有到期未收/.test(stripNegated('待收清单：现在没有到期未收。'))],
    ['待收：同一天第二次未测 → 闭嘴（每天最多一次）',
      () => enterPending({ p_lastState: 'untested', p_saidUntestedDay: D }, { code: 2, day: D, overdue: [] }).say === null],
    ['待收：从到期回到 0 → **必须说**（群里看到过异常，得看到它结束）',
      () => typeof enterPending({ p_lastState: 'due' }, { code: 0, day: D, overdue: [] }).say === 'string'],
    ['待收：不认识的退出码（137 被杀）→ 必须落进 untested，**不许当绿**',
      () => enterPending({ p_lastState: 'ok' }, { code: 137, day: D, overdue: [] }).state.p_lastState === 'untested'],
    ['待收：反向对照 —— 未测状态下退出码 0 必须回 ok（上面那条不是恒真）',
      () => enterPending({ p_lastState: 'untested' }, { code: 0, day: D, overdue: [] }).state.p_lastState === 'ok'],
    /* ── ★ 状态键白名单：两边的键不许互相串（2026-09-22；原先这条断言把病当成了正确）── */
    ['★ 待收状态**不许**带上基线那套键',
      // 这条**原来是反的**：它断言 `s.lastState === 'ok' && s.saidDriftFp === 'x'`，
      // 也就是「待收的状态里应当保留基线那两个键」。那是 `{ ...prev }` 的产物，
      // 而正是这个展开让基线文件里那 5 个 `p_*` 键活了两个版本。
      // 断言把污染写成了期望 —— 它是绿的，病就在它下面。
      () => { const s = enterPending({ lastState: 'ok', saidDriftFp: 'x' }, pdue(1)).state;
              return s.lastState === undefined && s.saidDriftFp === undefined && s.p_lastState === 'due'; }],
    ['★ 基线状态**不许**带 `p_*` 与 `lastChatId`（现场：基线文件里 `p_lastDay` 停在 09-21，待收那份是 09-22）',
      () => { const s = enter({ lastState: 'ok', p_lastDay: '2026-09-21', lastChatId: 'oc_x', saidDriftFp: null },
                              { code: 0, day: D, drifted: [], untested: [] }).state;
              return !Object.keys(s).some((k) => k.startsWith('p_') || k === 'lastChatId'); }],
    ['反向对照：喂一批白名单外的键 → 一个都不许留下（上面两条不是恒真）',
      () => { const s = enterPending({ p_lastState: 'ok', 陈年残留: 1, lastCode: 7 }, { code: 0, day: D, overdue: [] }).state;
              return !('陈年残留' in s) && !('lastCode' in s) && s.p_lastState === 'ok'; }],

    /* ── ★ 跳过留痕 + 补跑判据（2026-09-22；§十三 那 6.5 小时的直接修法）────────
     *
     * 这四条是**一对正反面 × 两个维度**，缺任何一条都会有一个方向是恒真的：
     *   · 该补跑时必须补（否则洞还在）；
     *   · 不该补跑时必须闭嘴（否则退化成每 30 分钟轮询一次，那是另一个 bug）。
     */
    ['★ 基线状态**恰好**只有 `BASELINE_KEYS` 里的键（原先基线这侧没有这条断言）',
      // ⚠️ 判据是**包含于**（`⊆`），不是相等 —— 第一版我写的是相等，当场红了：
      //    `saidDriftFp` 在「从没漂移过」时**本来就不该在**（`pick` 只带 prev 里有的键），
      //    要求它出现等于要求状态文件凭空多一个空值。**这是我把不变式写强了，不是代码错了。**
      //    真正要守的是**上界**：不许出现表外的键（那才是 `{ ...prev }` 留下的残留）。
      //    下界只对每次都会写的四个键成立。
      () => { const s = enter({ lastState: 'ok', 陈年残留: 1, p_lastDay: '2026-09-21' },
                              { code: 0, day: D, drifted: [], untested: [] }).state;
              return Object.keys(s).every((k) => BASELINE_KEYS.includes(k))
                  && ['lastState', 'lastRunAt', 'lastDay', 'lastCode', 'staleSince'].every((k) => k in s); }],

    ['★ 有跳过记录 + 冷却已过 → **必须补跑**',
      () => typeof recheckDue({ lastRunAt: new Date(T0 - COOLDOWN_MS - 60_000).toISOString(),
                                staleSince: new Date(T0 - COOLDOWN_MS).toISOString() }, T0) === 'string'],

    ['反向对照：有跳过记录但**冷却没过** → 不许补跑（上面那条不是恒真）',
      () => recheckDue({ lastRunAt: new Date(T0 - 60_000).toISOString(),
                         staleSince: new Date(T0 - 60_000).toISOString() }, T0) === null],

    ['★ 反向对照：**没有**跳过记录 → 永远不许补跑（否则心跳变成 30 分钟轮询一次）',
      // 这一条是 A 方案最容易做错的方向：把「冷却过期」当成触发条件，
      // 于是这份检查从「三处触发」悄悄变成「每天 48 次」——
      // 发现窗口的问题解决了，换来一个抓取风暴，而没人会看出来。
      () => recheckDue({ lastRunAt: new Date(T0 - COOLDOWN_MS * 10).toISOString(), staleSince: null }, T0) === null
         && recheckDue({ lastRunAt: new Date(T0 - COOLDOWN_MS * 10).toISOString() }, T0) === null],

    ['★ 真跑一次之后 `staleSince` 必须被清掉（`enter()` 写在展开之后）',
      () => enter({ lastState: 'ok', staleSince: '2026-09-22T09:22:33.000Z' },
                  { code: 0, day: D, drifted: [], untested: [] }).state.staleSince === null],

    /* ── ★ 退 1 但明细为空 = 清单坏了（2026-09-22 修；此前它会掉进绿分支）── */
    ['★ 待收：退 1 但**明细为空**（清单自己结构坏了）→ 必须说，不许沉默',
      () => { const r = enterPending({ p_lastState: 'ok' }, { code: 1, day: D, overdue: [], structErrors: ['id 重复：P-03'] });
              return typeof r.say === 'string' && r.state.p_lastState === 'broken'; }],
    ['★ 待收：清单坏了**不许**说成「没有到期未收」（修之前群里收到的就是这句）',
      // 两个形状都要挡住：
      //   ① `p_lastState: 'ok'` 时修前是**沉默**（`say === null`，stripNegated 之后是空串，
      //      光看「不许出现那句话」会**误判成通过** —— 沉默也是一种撒谎）；
      //   ② `p_lastState: 'due'` 时修前会真的发出「✅ 待收清单：现在没有到期未收。」
      () => { const broken = (prev) => enterPending(prev, { code: 1, day: D, overdue: [], structErrors: ['x'] });
              const a = broken({ p_lastState: 'ok' }), b = broken({ p_lastState: 'due' });
              return typeof a.say === 'string'
                  && !/没有到期未收/.test(stripNegated(a.say))
                  && !/没有到期未收/.test(stripNegated(b.say)); }],
    ['待收：清单坏了要把结构错误打出来（否则读者不知道该修什么）',
      () => /id 重复：P-03/.test(enterPending({}, { code: 1, day: D, overdue: [], structErrors: ['id 重复：P-03'] }).say)],
    ['待收：同一天第二次「清单坏了」→ 闭嘴；第二天仍坏 → **再说**',
      () => enterPending({ p_lastState: 'broken', p_saidBrokenDay: D }, { code: 1, day: D, overdue: [], structErrors: ['x'] }).say === null
         && typeof enterPending({ p_lastState: 'broken', p_saidBrokenDay: '2026-09-20' },
                                { code: 1, day: D, overdue: [], structErrors: ['x'] }).say === 'string'],
    ['待收：从「清单坏了」回到绿 → **必须说**（群里看到过异常，得看到它结束）',
      () => { const r = enterPending({ p_lastState: 'broken' }, { code: 0, day: D, overdue: [] });
              return typeof r.say === 'string' && /没有到期未收/.test(r.say); }],
    ['反向对照：退 1 **有**明细时仍走「到期」那条，别被 broken 分支抢走',
      () => enterPending({ p_lastState: 'ok' }, pdue(1)).state.p_lastState === 'due'],
    ['反向对照：绿（退 0）时**不许**误报「清单坏了」',
      () => enterPending({ p_lastState: 'ok' }, { code: 0, day: D, overdue: [] }).state.p_lastState === 'ok'],
    ['反向对照：从 broken 恢复之后，去重键要清掉（否则「坏了→修好→当天又坏」会被吞掉）',
      () => !enterPending({ p_lastState: 'broken', p_saidBrokenDay: '2026-09-20' }, { code: 0, day: D, overdue: [] })
              .state.p_saidBrokenDay],
    ['待收：过期天数要出现在文案里（「今天到期」/「已过 N 天」）',
      () => { const r = enterPending({}, { code: 1, day: D, overdue: [{ ...pdue(1).overdue[0], 过期天数: 3 }] });
              return /已过 3 天/.test(r.say); }],

    /* ── ★ F 段：问出去两个工作日了还没回 → 补问一次（2026-09-22 加）───────────
     *
     * 「每条只补一次」有**两把锁**，各守一段，所以两边都要有正反两面：
     *   · 清单侧（`outbound` 指针恰好一条 —— 补过之后指针变两条，就再也不进表）
     *     由 `tools/verify_pending.py --controls` 的 F 段守；
     *   · 状态侧（`p_nagged` —— 挡「已经发进群、指针还没补上」那个窗口）由这七条守。
     *   缺任何一把，同一个问题就会每天重发一次，而对面是个真人。
     */
    ['★ 补问：第一次读到 → **必须说**', () => typeof enterPending({ p_lastState: 'ok' }, pnag(1)).say === 'string'],
    ['★ 补问：同一条**已经补过**（`p_nagged` 里有它）→ 闭嘴',
      () => enterPending({ p_lastState: 'nag', p_nagged: ['P-01'] }, pnag(1)).say === null],
    ['★ 补问：一条补过、一条没补过 → **只说没补过那条**，且两条都记进 `p_nagged`',
      () => { const r = enterPending({ p_lastState: 'nag', p_nagged: ['P-01'] }, pnag(2));
              return typeof r.say === 'string' && !/P-01/.test(r.say)
                  && JSON.stringify([...r.state.p_nagged].sort()) === '["P-01","P-02"]'; }],
    ['★ 补问反向对照：**没有要补的**（`nag` 为空）→ 不许说（上面第一条不是恒说）',
      () => enterPending({ p_lastState: 'ok' }, { code: 0, day: D, overdue: [], nag: [] }).say === null],
    ['★ 补问：文案里不许出现**没配对的 markdown 记号** —— `quote` 是逐字存的，'
      + '带 `**` 原样发出去会缺一半（而这句话是对外发的）',
      () => !/「[^」]*\*\*/.test(enterPending({}, pnag(1)).say)],
    ['★ 补问：未测（清单读不出 → `nag` 为空）时**不许**被说成「没有要补问的」',
      () => { const r = enterPending({ p_lastState: 'ok' }, { code: 2, day: D, overdue: [], reason: '清单读不出' });
              return /没读成/.test(r.say) && !/没有要补问|一切正常/.test(stripNegated(r.say)); }],
    ['★ 补问：和「到期未收」撞车时，补问发出去、**到期那批要报个数不许被吞掉**',
      () => { const r = enterPending({}, { code: 1, day: D, overdue: pdue(2).overdue, nag: pnag(1).nag });
              return typeof r.say === 'string' && /还有 2 件到期未收/.test(r.say); }],
    ['★ 补问：`p_nagged` 必须在状态白名单里 —— 不在的话下一次读状态就被 `pick` 丢掉，补问会重复',
      () => 'p_nagged' in enterPending({ p_nagged: ['P-01'] }, pnag(0)).state],

    /* ── ★ 单飞：两个检查不许同时写状态（2026-09-21 真跑时丢过一次数据）── */
    ['★ 单飞：上一次还在跑时，第二次必须立刻跳过（否则后写的旧快照会抹掉先写的）',
      async () => {
        let release; const gate = new Promise((r) => { release = r; });
        const slow = async () => { await gate; return { code: 0, note: '', data: { overdue: [] } }; };
        const first = checkPending({ force: true, today: '2026-10-03', run: slow });
        const second = await checkPending({ force: true, today: '2026-10-03', run: slow });
        release(); await first;
        return typeof second.skipped === 'string';
      }],
    ['反向对照：第一次跑完之后再调 → **不许** skip（上面那条不是恒真）',
      async () => {
        const r = await checkPending({ force: true, today: '2026-10-03',
                                        run: async () => ({ code: 0, note: '', data: { overdue: [] } }) });
        return !r.skipped && r.code === 0;
      }],
    ['★ 单飞：基线那条同样成立（两条链路各有一把锁）',
      async () => {
        let release; const gate = new Promise((r) => { release = r; });
        const slow = async () => { await gate; return { code: 0, out: '', note: '' }; };
        const first = checkNow({ force: true, dryRun: true, run: slow });
        const second = await checkNow({ force: true, dryRun: true, run: slow });
        release(); await first;
        return typeof second.skipped === 'string';
      }],
    ['★ 两把锁**互相独立**：待收在跑，不许挡住基线（否则一个卡住会拖停另一个）',
      async () => {
        let release; const gate = new Promise((r) => { release = r; });
        const slowP = async () => { await gate; return { code: 0, note: '', data: { overdue: [] } }; };
        const p = checkPending({ force: true, today: '2026-10-03', run: slowP });
        const b = await checkNow({ force: true, dryRun: true, run: async () => ({ code: 0, out: '', note: '' }) });
        release(); await p;
        return b === undefined || typeof b.skipped !== 'string' || !/待收/.test(b.skipped);
      }],

    /* ── ★ 自证不许改真状态（2026-09-22 实测：跑一次 --selftest 就把 30 分钟冷却用掉了）── */
    ['★ `dryRun` 下 checkNow 一个字节都不许落盘（否则跑一次自证 = 告警静音 30 分钟 + 擦掉「上次是红的」）',
      async () => {
        const f = path.join(stateDir(), '_selftest-tmp-state.json');
        try {
          fs.writeFileSync(f, JSON.stringify({ lastRunAt: '2020-01-01T00:00:00.000Z', lastDay: '2020-01-01',
                                               lastState: 'drift', saidDriftFp: 'x' }));
          const before = fs.readFileSync(f, 'utf8');
          const r = await checkNow({ force: true, dryRun: true, stateFile: f,
                                     run: async () => ({ code: 0, out: '', note: '' }) });
          return fs.readFileSync(f, 'utf8') === before && r.dryRun !== undefined;
        } finally { try { fs.unlinkSync(f); } catch { /* 已经没了就算了 */ } }
      }],
    ['反向对照：**不带** `dryRun` 时必须落盘，且真的把状态改掉（上面那条不是恒真）',
      async () => {
        const f = path.join(stateDir(), '_selftest-tmp-state.json');
        try {
          fs.writeFileSync(f, JSON.stringify({ lastRunAt: '2020-01-01T00:00:00.000Z', lastDay: '2020-01-01',
                                               lastState: 'drift', saidDriftFp: 'x' }));
          const before = fs.readFileSync(f, 'utf8');
          await checkNow({ force: true, stateFile: f, run: async () => ({ code: 0, out: '', note: '' }) });
          const after = fs.readFileSync(f, 'utf8');
          return after !== before && JSON.parse(after).lastState === 'ok';
        } finally { try { fs.unlinkSync(f); } catch { /* 已经没了就算了 */ } }
      }],
    /* ── ★ 跳过那条路径的**行为级**断言（2026-09-22）────────────────────────
     * 上面那四条 `recheckDue` 是**纯函数**断言 —— 它们全绿，只证明「判据写对了」，
     * 不证明「跳过时真的落了 `staleSince`」。§2.4.2 那两层的老问题：
     * 判据存在 ≠ 有人执行。所以这里必须**真调一次 `checkNow`**，再回读文件。
     */
    ['★ 行为级：冷却期里跳过时，状态文件必须**真的写下** `staleSince`',
      async () => {
        const f = path.join(stateDir(), '_selftest-tmp-state.json');
        try {
          // `lastRunAt` 就设在「刚刚」→ 必然落进冷却，走 skipped 那一支
          fs.writeFileSync(f, JSON.stringify({ lastRunAt: new Date().toISOString(), lastDay: D,
                                               lastState: 'drift', saidDriftFp: 'x', lastCode: 1, rawCode: 1 }));
          const r = await checkNow({ stateFile: f, run: async () => { throw new Error('冷却期不该真的去跑检查'); } });
          const s = JSON.parse(fs.readFileSync(f, 'utf8'));
          return typeof r.skipped === 'string'
              && typeof s.staleSince === 'string' && !Number.isNaN(Date.parse(s.staleSince))
              && s.lastState === 'drift';        // ← 读数本身**不许被跳过擦掉**
        } finally { try { fs.unlinkSync(f); } catch { /* 已经没了就算了 */ } }
      }],
    ['★ 行为级反向对照：第二次跳过**不许刷新** `staleSince`（否则「过期了多久」会被心跳顶到现在）',
      async () => {
        const f = path.join(stateDir(), '_selftest-tmp-state.json');
        try {
          const first = new Date(Date.now() - 5 * 60_000).toISOString();
          fs.writeFileSync(f, JSON.stringify({ lastRunAt: new Date().toISOString(), lastDay: D,
                                               lastState: 'drift', staleSince: first }));
          await checkNow({ stateFile: f, run: async () => { throw new Error('不该跑'); } });
          return JSON.parse(fs.readFileSync(f, 'utf8')).staleSince === first;
        } finally { try { fs.unlinkSync(f); } catch { /* 已经没了就算了 */ } }
      }],
    ['★ 行为级：`dryRun` 下跳过也**一个字节都不许落盘**（与上面那条成对）',
      async () => {
        const f = path.join(stateDir(), '_selftest-tmp-state.json');
        try {
          fs.writeFileSync(f, JSON.stringify({ lastRunAt: new Date().toISOString(), lastDay: D, lastState: 'drift' }));
          const before = fs.readFileSync(f, 'utf8');
          await checkNow({ dryRun: true, stateFile: f, run: async () => { throw new Error('不该跑'); } });
          return fs.readFileSync(f, 'utf8') === before;
        } finally { try { fs.unlinkSync(f); } catch { /* 已经没了就算了 */ } }
      }],
    ['★ 行为级：补跑之后 `staleSince` 归零 —— 判据（B）与触发（A）在**同一次真实调用**里接上',
      async () => {
        const f = path.join(stateDir(), '_selftest-tmp-state.json');
        try {
          fs.writeFileSync(f, JSON.stringify({ lastRunAt: new Date(Date.now() - COOLDOWN_MS - 60_000).toISOString(),
                                               lastDay: D, lastState: 'drift', staleSince: '2026-09-22T09:22:33.000Z' }));
          const due = recheckDue(JSON.parse(fs.readFileSync(f, 'utf8')));
          await checkNow({ stateFile: f, run: async () => ({ code: 0, out: '', note: '' }) });
          const s = JSON.parse(fs.readFileSync(f, 'utf8'));
          return typeof due === 'string' && s.staleSince === null && s.lastState === 'ok';
        } finally { try { fs.unlinkSync(f); } catch { /* 已经没了就算了 */ } }
      }],

    ['★ 自证里的每一个 `checkNow` 都不许落到**真状态文件**上（`dryRun` 或 `stateFile` 二选一）',
      /**
       * 这条断言**写了三版，前两版都是错的**，两版错在同一个病上：**判据比它声称的弱。**
       *
       * 第一版比的是两个「文本出现过」的计数。实测：把某一处 `dryRun: true` 删掉，
       * **它照样全绿** —— 因为那个字面量在这段源码里到处都是（连判据自己的正则里都有一次）。
       * 一个「名字出现过」的判据，在有注释、有台账、有自指正则的地方**恒真**。
       *
       * 第二版要求**每一个**调用点都带 `dryRun: true` —— 而下面那条反向对照
       * （「不带 dryRun 时必须落盘」）本来就是故意不带的，于是真身直接变红。
       * **一个会误报的检查器比没有检查器更糟**（§2.1.1），它会让人开始不看报告。
       *
       * 第三版（现在这版）**在自己身上又撞了一次**：它把每个调用点的实参文本切出来判，
       * 而这段解释文字里就写着这个函数的调用形状（`checkNow` 后跟一对花括号），
       * 被自己的扫描器当成一个不合规的调用点 → 真身又红了。
       * 修法是给扫描器**统一**一条读法：**注释不算代码**（与 `verify_shouheng_ops.py`
       * 的 C5、`verify_cards.mjs` 的 J1a 同一条规矩），而不是把注释改写得更绕。
       *
       * 判据本身：每个真实调用点要么 `dryRun: true`、要么 `stateFile:` 指向注入的文件 ——
       * **没有第三条路能落到真文件上**。这是「到达」而不是「出现过」。
       * 截断（实参里嵌了 `}`）只会更严，不会更松。
       * 反向保证：`calls.length >= 2` —— 改名之后它会因为「一次都没匹配到」而红。
       *   ★ 2026-10-12 这条**真的响了一次**：把断言列表搬进 `selftestBody()`（为了给自证
       *   加一条状态目录不变量）之后，`selftest.toString()` 里一个调用点都没有了
       *   → `calls.length >= 2` 不成立 → 两条红。**它抓的是「扫描范围没跟上改名」**，
       *   所以修法是把范围扩到两个函数，而不是放宽判据。
       */
      () => {
        const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
        const src = strip(selftest.toString()) + '\n' + strip(selftestBody.toString());
        const calls = [...src.matchAll(/checkNow\(\{([^}]*)\}/g)].map((m) => m[1]);
        const dry = (a) => /dryRun:\s*true/.test(a);
        const inj = (a) => /stateFile:/.test(a);
        return calls.length >= 2
            && calls.every((a) => dry(a) || inj(a))
            && calls.some(dry) && calls.some(inj);
      }],

    /* ── ★ `--check` 不许静音告警（2026-09-23 加，代价是一次真事故） ──────────────
     *
     * 上面那条只扫 `selftest.toString()` —— 也就是它**只守得住自证自己**。
     * 而本轮踩到的那条路径根本不在自证里：它是 **CLI**。
     * 这正是 §2.4 点名的病：**在执行点的断言里活了下来** ——
     * 判据覆盖不到的那一跳，就是事故所在的那一跳。
     *
     * 所以这一对**不比对文本，真起一次子进程**：
     *   ① 行为级：`--check --offline` 指着注入的状态目录跑完，那个文件必须**一个字节都没变**；
     *   ② 反向对照：同一份状态文件，走一次**不带 `dryRun`** 的 `checkNow`，它**必须变**。
     *      没有 ②，① 会因为「反正这个文件从来没人写」而恒真 —— 一个恒真的检查器比没有更糟。
     *
     * 为什么用真子进程而不是直接调 `checkNow`：**要证的是「CLI 那一支」**。
     * 直接调函数只能证明「函数在 dryRun 下不落盘」，而那件事上面已经证过了；
     * 这里要证的是「CLI 传了 dryRun」。断言的靶子是那一行代码，不是那个函数。
     * 子进程的 `SHOUHENG_STATE_DIR` 指向临时目录 —— **自证绝不碰真的状态文件**（§2.4.4）。
     */
    ['★ 行为级：CLI 的 `--check` 一个字节都不许落盘（它只回答「红不红」，不说话）',
     async () => {
       const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prdcheck-'));
       try {
         const file = path.join(dir, 'prd-baseline-watch.json');
         const seeded = JSON.stringify({ lastState: 'drift', saidDriftFp: 'A.md:' + 'b'.repeat(64),
                                         lastRunAt: '2026-09-23T10:05:46.001Z', lastDay: '2026-09-23',
                                         lastCode: 1, rawCode: 1 }, null, 2);
         fs.writeFileSync(file, seeded);
         const code = await new Promise((resolve) => {
           const child = spawn(process.execPath, [process.argv[1], '--check', '--offline'],
                               { cwd: REPO_ROOT, env: { ...process.env, SHOUHENG_STATE_DIR: dir } });
           child.on('error', () => resolve(null));
           child.on('close', (c) => resolve(c));
         });
         // 粗判：跑起来就算过了这一关（`--offline` 应退 2 = 未测）。不判具体码，
         // 否则这条会随 `verify_prd_baseline.py` 的退出码语义漂移 —— 它验的不是那个。
         return code !== null && fs.readFileSync(file, 'utf8') === seeded;
       } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
     }],

    ['反向对照：**不带** `dryRun` 时必须落盘（证明上面那个「没变」不是恒真）',
     async () => {
       const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prdcheck-'));
       try {
         const file = path.join(dir, 'prd-baseline-watch.json');
         const seeded = JSON.stringify({ lastState: 'ok', saidDriftFp: null }, null, 2);
         fs.writeFileSync(file, seeded);
         await checkNow({ force: true, stateFile: file, run: async () => ({ code: 0, out: '', note: '' }) });
         return fs.readFileSync(file, 'utf8') !== seeded;
       } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
     }],

    /* ── ★ Q40：裸 `--pending` 也必须 `dryRun`（2026-09-23 加）────────────────────
     *
     * 与上面 `--check` 那一对**完全同形**，因为它们是同一个病的两半：上一轮只修了
     * `--check`，这一族于是看起来已经收口了 —— 而漏掉的那一半同样只在**文档**里出现
     * （`--pending` 被写进「复现与自证」的常规命令），不在自证脚本里。
     *
     * 后果比 `--check` 那条更具体、也更有日期：`--pending` 写下的 `p_saidDueKey` 等键
     * 恰好是 daemon 判「今天已经说过一次」的依据，所以 **2026-10-02 那天谁在终端里跑一次
     * `--pending`，那天的到期提醒就永远不会到群里**，而状态里多出的那个键与「真的说过了」
     * 长得一模一样 —— 没有任何东西会红。
     *
     * 这一对同样**不比对文本、真起一次子进程**：
     *   ① 行为级：`--pending` 指着注入的状态目录跑完，那个文件必须**一个字节都没变**；
     *   ② 反向对照：同一份状态文件，走一次**不带 `dryRun`**（也不注入 `today`）的
     *      `checkPending`，它**必须变** —— 否则 ① 会因为「这个文件从来没人写」而恒真。
     *      ★ 反向对照显式传 `stateFile:`：**自证绝不碰真状态**（§2.4.4）。
     */
    ['★ 行为级：CLI 的 `--pending` 一个字节都不许落盘（看一眼不该吞掉当天的到期提醒）',
     async () => {
       const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prdpending-'));
       try {
         const file = path.join(dir, 'prd-pending-watch.json');
         const seeded = JSON.stringify({ p_lastDay: '2026-09-20', p_lastState: 'ok',
                                         p_saidDueKey: null,
                                         p_lastRunAt: '2026-09-20T10:00:00.000Z' }, null, 2);
         fs.writeFileSync(file, seeded);
         const code = await new Promise((resolve) => {
           const child = spawn(process.execPath, [process.argv[1], '--pending'],
                               { cwd: REPO_ROOT, env: { ...process.env, SHOUHENG_STATE_DIR: dir } });
           child.on('error', () => resolve(null));
           child.on('close', (c) => resolve(c));
         });
         return code !== null && fs.readFileSync(file, 'utf8') === seeded;
       } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清不掉就算了 */ } }
     }],

    ['反向对照：**不带** `dryRun` 的待收检查必须落盘，且真的把状态改掉（上面那条不是恒真）',
     async () => {
       const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prdpending-')), 'p.json');
       try {
         const seeded = JSON.stringify({ p_lastDay: '2026-09-20', p_lastState: 'ok' }, null, 2);
         fs.writeFileSync(f, seeded);
         await checkPending({ force: true, day: D, stateFile: f,
                              run: async () => ({ code: 0, note: '', data: {} }) });
         return fs.readFileSync(f, 'utf8') !== seeded;
       } finally { try { fs.unlinkSync(f); } catch { /* 已经没了就算了 */ } }
     }],

    ['★ 自证里的每一个 `checkPending` 也不许落到**真状态文件**上'
     + '（`dryRun` / `today:` 注入 / `stateFile` 三选一 —— 后两个本身就意味着不落盘）',
     /**
      * 与上面那条 `checkNow` 版同一条读法：**注释不算代码**、判「到达」不判「出现过」。
      * 为什么允许 `today:`：注入日那一支在实现里**就是**不落盘（09-22 定下的），
      * 所以它和 `dryRun` 是同一件事的两种写法，不是逃生门。
      * 反向保证：`calls.length >= 1` —— 改名之后它会因为「一次都没匹配到」而红。
      */
     () => {
       const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
       // ★ 与上面那条 `checkNow` 版**同一天响过**（断言列表搬进 `selftestBody()`），
       //   同样把扫描范围扩到两个函数 —— 它抓的正是「扫描范围没跟上改名」。
       const src = strip(selftest.toString()) + '\n' + strip(selftestBody.toString());
       const calls = [...src.matchAll(/checkPending\(\{([^}]*)\}/g)].map((m) => m[1]);
       const ok = (a) => /dryRun:\s*true/.test(a) || /stateFile:/.test(a) || /today:/.test(a);
       return calls.length >= 1 && calls.every(ok);
     }],
  ];

  let bad = 0;
  console.log('='.repeat(72));
  console.log('prd_baseline 触发器 · 反向对照（离线；不动盘、不联网、不发消息）');
  console.log('='.repeat(72));
  for (const [i, [name, fn]] of cases.entries()) {
    let ok = false, err = '';
    // `await`：用例可以是同步的，也可以是异步的（并发那两条）——两者都收
    try { ok = Boolean(await fn()); } catch (e) { err = `（抛异常 ${e.message}）`; }
    if (!ok) bad++;
    console.log(`  ${ok ? '✅' : '❌'} [${String(i + 1).padStart(2)}/${cases.length}] ${name}${err}`);
  }
  console.log('-'.repeat(72));
  if (bad) { console.log(`❌ ${cases.length} 项中 ${bad} 项失败 —— 告警器有问题，别信它会响`); return 1; }
  console.log(`✅ ${cases.length} 项全过（含「该闭嘴时闭嘴」与「该说时必说」两侧）`);
  return 0;
}

/* ─────────────────────── CLI ─────────────────────── */

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--selftest')) process.exit(await selftest());
  if (process.argv.includes('--check')) {
    /**
     * ★ **`--check` 必须 `dryRun`（2026-09-23 加）。这是本文件第三条「跑一次就静音告警」的路径。**
     *
     * 前两条都修过了：`--selftest`（§2.4.4，代价是一次实测）、以及 `checkNow` 内部那两处
     * 自证调用点。这一条当时**漏了**，而且漏得最隐蔽 —— 它不在自证脚本里，它**在文档里**：
     * `PMO/守衡-知识库构建完整方案-20260922.md` §八 把
     * `node tools/agent/prd_baseline.mjs --check` 列进了「复现与自证」的常规命令。
     *
     * 实测（2026-09-23 18:05:46，本轮踩的）：上游当天 14:16:42 改了 PRD → 按文档跑 `--check`
     * → 它不带 `dryRun`，于是 `enter()` 算出的那句话被 `saveState` **记成「已说过」**
     * （`saidDriftFp` = 新指纹），而 CLI 只 `console.log`，**一个字都没发出去**。
     * 而 daemon 的发送条件是 `if (!r.say) return` —— 下次它自己跑到同一漂移时，
     * `enter()` 回「同一个漂移指纹已经说过」，`say` 是 null，于是**永久沉默**。
     *
     * 两个对外后果方向相反、同时发生：
     *   ① 群里**永远收不到**那条告警；
     *   ② 状态里 `lastState` 停在 `drift`，等基线复绿后 daemon 会走「从红/未测恢复」那一支，
     *      发一句「✅ 上游基线检查恢复了」—— **一个从没收到过告警的群，凭空收到收尾**。
     *      这正是 §2.4.7 在 09-22 刚修过的形状（通报带地址、收尾不带地址）从另一条路回来：
     *      CLI 不传 `chatId`，`alertChat` 记成 null，收尾只能退回 `resolveChat()` 去猜一个群。
     *
     * **为什么 `dryRun` 就是对的修法**：检查的职责是回答「现在红不红」；
     * 「要不要说、说给谁」是 daemon 的职责（§2.5：同一个形状只能有一处实现）。
     * 手动看一眼就把告警额度用掉，等于**「看见的」改掉了「将来要发生的」**。
     *
     * 判据与反向对照见 `--selftest` 里那一对：行为级那条会真起一次子进程、指着注入的
     * 状态目录，证明这个文件**一个字节都没动**；反向对照证明那个检测器不是恒真。
     */
    const r = await checkNow({ reason: 'manual', force: true, dryRun: true,
                               run: (o) => runChecker({ ...o, offline: process.argv.includes('--offline') }) });
    console.log(JSON.stringify({ code: r.code, note: r.note, why: r.why, say: r.say, skipped: r.skipped,
                                 dryRun: r.dryRun }, null, 2));
    process.exit(r.code ?? 0);
  }
  if (process.argv.includes('--pending')) {
    /**
     * ★ **`--pending` 也必须 `dryRun`（2026-09-23 加，Q40 = 选项 A）。**
     *
     * 它与上面 `--check` 那一条是**同一个病的另一半**，而且同样隐蔽：漏掉它的那次
     * 只修了 `--check`，于是这一族看起来已经收口了。实测差别只有一个字：
     * `runCheckPending` 原先只在**注入了 `--today=`** 时不落盘（那是 09-22 为「提前看一眼」
     * 加的），**不带 `--today=` 的裸 `--pending` 照样写状态**。
     *
     * 而它写下的正是 `p_saidDueKey` / `p_saidBrokenDay` / `p_saidUntestedDay` 那几个键，
     * daemon 的 `pendingWatch` 又正是用它们判「今天已经说过一次」→ `say: null` → **不发**。
     * 也就是说：**10-02 那天谁在终端里跑一次 `--pending`，那天的到期提醒就永远不会到群里**，
     * 而没有任何东西会红 —— 状态里只多一个键，读起来完全像「今天已经说过了」。
     *
     * 为什么 `dryRun` 就是对的修法：与 `--check` 同一条（§2.5）—— 检查的职责是回答
     * 「有没有到期的」；「要不要说、说给谁」是 daemon 的职责。手动看一眼不该把当天的
     * 额度用掉：**「看见的」不许改掉「将来要发生的」。**
     *
     * 判据与反向对照见 `--selftest` 里那一对（行为级起真子进程 + 反向对照）。
     */
    const t = process.argv.find((a) => a.startsWith('--today='))?.slice(8) ?? null;
    const r = await checkPending({ reason: 'manual', force: true, today: t, dryRun: true });
    console.log(JSON.stringify({ code: r.code, why: r.why, say: r.say, skipped: r.skipped,
                                 dryRun: r.dryRun, overdue: r.overdue ?? [] }, null, 2));
    process.exit(r.code ?? 0);
  }
  if (process.argv.includes('--state')) { console.log(JSON.stringify(loadState(), null, 2)); process.exit(0); }
  console.log('用法：node tools/agent/prd_baseline.mjs --selftest | --check [--offline] | --pending [--today=YYYY-MM-DD] | --state');
  process.exit(0);
}

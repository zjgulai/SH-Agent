/**
 * review_publish.mjs —— **每一次评审都必须落表**（Owner 2026-10-05 定的硬规矩）
 *
 * ── 为什么要有它（两句话）
 *
 * 那天的真实情况：送了四条素材，链跑完了 3.5~17.9 分钟，**表里一行都没有**。
 * 原因有两层，第二层才是要命的：
 *   ① 链自己的发布条件是「有**三态结论**才发」——`publish.reason = no_conclusion`
 *      就把拒答（`NEEDS_INPUT`）整单跳过了；
 *   ② 于是「评审跑过、但结论是拒答」这件事在**盘上没有任何痕迹** ——
 *      人要问「这单审没审」只能去翻 KB 目录。
 *
 * Owner 的原话是「**每一个评审任务都必须落表**」。所以这条保证放在**我们这一侧**：
 * 链愿意自己发就发（那更好，字段更全）；链没发，**这里补上**。
 * 判据是「表里到底有没有这一行」，不是「链说它发了」。
 *
 * ── 幂等靠什么：内容 ID 的算法是**算出来的**，不是猜的
 *
 * 链给素材算的是 `content_id = "AUTO-" + sha256(送审文本去掉尾部空白).slice(0,12)`
 * —— 这条规则**逐字复算过**：拿 `_rt-img-20261005/rt-img-02-text.txt`（196 字节）
 * 去掉尾部换行后算 sha256，前 12 位正好是 `48cac901ac43`，与报告里的
 * `AUTO-48cac901ac43` 一致。
 * 所以这里能算出**同一个 ID**：先按它查表 —— 有就补空字段（不覆盖人填的），没有才新建。
 * **不做这一步就会出现「同一个内容两行」**，而重复行比缺行更难发现。
 *
 * ── 不覆盖什么（与 `lark_write.mjs` 的删除纪律同一条精神）
 *
 * `人工复核人` / `复核结论` / `sign-off 人` / `审核人` / `发布时间` 是**人的格子**：
 * 补写只补**空着的、且由机器产出的**那些字段，人填过的一律不动。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRecords, updateRecords, listRecords, flat } from './lark_write.mjs';
import { plainify } from './plain.mjs';
import { execImageProcess } from './image_process.mjs';
import { remainingReviewTimeout, reviewDeadlineAt, reviewDeadlineExpired, sleepWithinReviewDeadline } from './review_deadline.mjs';

const execFileP = promisify(execFile);
function deadlineRun(injected) {
  return (bin, args, options) => {
    const run = injected ?? (reviewDeadlineAt() === null ? execFileP : execImageProcess);
    return run(bin, args, { ...options, timeout: remainingReviewTimeout(options?.timeout) });
  };
}

/**
 * 报告云文档的**可见范围**（Owner 2026-10-16 指令，逐字）：
 *   「所有上审查报告，有飞书云文档阅读权限的，都必须可以打开，**权限跟随飞书云文档**」
 * ⇒ `tenant_readable` ＝「组织内获得链接的人可阅读」（**不是**公网公开：`anyone_*` 没用）。
 *
 * 为什么必须在这里做（2026-10-16 实测）：报告文档原先**建完不碰权限** ⇒
 * `link_share_entity = closed`（**全量 76/76 份都是 closed**）⇒ 协作者只有「Owner ＋ 守衡 app」
 * ⇒ **业务侧同事点开必然 Access Denied**（Owner 当天报的第 16 行就是这个）。
 * 而**媒材**那条路早就有同款步骤（`tools/agent/media_link.mjs`：patch → **回读确认**），报告这条路一直漏着。
 *
 * ★ 纪律（照抄 media_link 那条）：**接口成功 ≠ 数据落下来** —— patch 之后**必须回读确认**；
 *   回读不是目标值 ⇒ 当失败，**链接不写进表**（宁可空着，也不给一个点不开的链接）。
 */
export const REPORT_SHARE_ENTITY = 'tenant_readable';

/** 权限两步里有界重试的等待（毫秒；`0` 给自证用）。 */
function _permSleep(ms) {
  return sleepWithinReviewDeadline(ms).catch(error => {
    if (error?.code !== 'REVIEW_DEADLINE_EXCEEDED') throw error;
  });
}

/**
 * 这一步的错误**值不值得补一次**？
 *
 * 与 `_transientFailureOf`（建文档那一步）**分开写**，因为判据不同：
 *   · 设置权限那一步的 `99991672 / permission denied / 131006` 是**资源或 scope 没开** ——
 *     补一百次也一样，必须让人去加协作者/补 scope（「有权限就不许说没权限」的反面：
 *     没权限也别浪费三轮去证明它）；
 *   · 空输出 / 超时 / 被杀 / 网络类 ⇒ 偶发，值得补。
 */
function _permTransientOf(e, errText) {
  if (reviewDeadlineExpired() || e?.code === 'REVIEW_DEADLINE_EXCEEDED') return false;
  if (e?.killed || e?.signal) return true;
  const t = String(errText ?? '').trim();
  if (!t) return true;
  if (/"type"\s*:\s*"validation"/.test(t)) return false;
  if (/99991672|permission denied|Access denied|Forbidden|131006|not\s*found/i.test(t)) return false;
  return /ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|timed out|rate.?limit|429|50[023]/i.test(t);
}

/**
 * 把一份云文档设成「组织内可阅读」并**回读确认**。
 *
 * @param {string} docId docx token（`docs +create` 回的 `document_id`）
 * @param {{run?:Function, timeoutMs?:number, attempts?:number}} [opts] `run` 可注入 —— 自证时不碰真库
 * @returns {Promise<{ok:boolean, kind:string, detail:string, got?:string}>}
 *
 * ── ★★ 2026-10-20 改（Owner：「报告模版又乱了，怎么一会一个样子，到底是谁在改模版？」）
 *
 * 真单查出来的病灶**不在模版**：18:59 那一单 `docs +create` **成功**
 * （云文档 `I3NHdhLmKoGffrx8QOLcpMkSnsh` 已建、正文齐全），失败的是**回读权限**这一步 ——
 * 报错全文只有 `Command failed: … drive +permission-get-setting`（stderr 空、无 killed/signal）。
 * 而当时这一步**只试一次、失败即判「没建成」** ⇒ 调用方弃用自己那份、回落成库侧那份
 * （`kb/l7/review-engine/core/feishu_publish.py` 的**另一套版式**：问题分类汇总/完整清单）
 * ⇒ 人点开看到的报告「一会儿一个样」。
 * 复核（同一条命令重跑那支文档）：**回读成功、`link_share_entity = tenant_readable`** ——
 * 权限其实早就设上了，坏的只是那一次**读**。
 *
 * ⇒ 三件事：① 设权限与回读**各有界重试**（默认 3 轮，`SHOUHENG_PERM_ATTEMPTS` 可调）；
 *   ② 失败**分成三类**，别再糊成一句「没建成」：
 *      · `unverified` —— patch 回执成功、**只是回读验不成** ⇒ 交给调用方**照用自己那份**
 *        （权限未核验要如实标，见 `publishReportDocOnce`）；
 *      · `mismatch` —— 回读**读得出来、就是不达标**（如 `closed`）⇒ 验得清，链接不给；
 *      · `patch_failed` —— 连设置都没成 ⇒ 链接不给；
 *   ③ `unverified` 只可能在 **patch 回执成功之后**出现 —— 它不是「猜权限设上了」。
 */
export async function ensureTenantReadable(docId, opts = {}) {
  const id = String(docId ?? '').trim();
  if (!id) return { ok: false, kind: 'no_id', detail: '没给 document_id，无法设权限' };
  const run = deadlineRun(opts.run);
  const timeout = opts.timeoutMs ?? P0_DOC.timeoutMs;
  const base = ['--profile', P0_DOC.profile];
  const attempts = Math.max(1, Math.floor(Number(
    opts.attempts ?? process.env.SHOUHENG_PERM_ATTEMPTS ?? 3) || 3));
  const backoff = Math.max(0, Math.floor(Number(process.env.SHOUHENG_PERM_BACKOFF_MS ?? 300) || 0));
  let got = '';
  let readUnknown = '';
  let rounds = 0;
  for (let n = 1; n <= attempts; n += 1) {
    rounds = n;
    // ① 设权限（幂等；每轮都重设一次 —— 回读失败最常见的成因就是"设了但没落地"）
    try {
      await run(P0_DOC.bin, [...base, 'drive', 'permission.public', 'patch', '--token', id, '--type', 'docx',
        '--data', JSON.stringify({ link_share_entity: REPORT_SHARE_ENTITY }),
        '--as', 'bot', '--yes'], { timeout, maxBuffer: 4 << 20 });
    } catch (e) {
      // ⚠️ 「有没有吐字」只看 **stderr/stdout** —— node 的 `Command failed: <cmd>` **恒非空**。
      //   拿 `e.message` 判「有输出」会把偶发失败误判成确定性、**一次都不补**
      //   （2026-10-19 在 `_transientFailureOf` 上踩过一次；2026-10-20 我在这一支上又踩了一次，
      //     G1/G1b 当场变红才抓到）。
      const rawErr = String(e?.stderr ?? '').trim() || String(e?.stdout ?? '').trim();
      const shown = rawErr || String(e?.message ?? e);
      if (!_permTransientOf(e, rawErr) || n === attempts) {
        return { ok: false, kind: 'patch_failed', got,
                 attempts: n, detail: `设可见范围失败：${shown.slice(0, 200)}` };
      }
      if (backoff) await _permSleep(backoff * n);
      continue;
    }
    // ② 回读确认（「接口成功 ≠ 数据落下来」）
    try {
      const { stdout } = await run(P0_DOC.bin, [...base, 'drive', '+permission-get-setting',
        '--token', id, '--type', 'docx', '--as', 'bot'], { timeout, maxBuffer: 4 << 20 });
      got = '';
      try { got = String(JSON.parse(String(stdout))?.data?.permission_public?.link_share_entity ?? ''); } catch { got = ''; }
      if (got === REPORT_SHARE_ENTITY) {
        return { ok: true, got, kind: 'ok', attempts: n,
                 detail: `可见范围 = ${got}` + (n === 1 ? '' : `（补第 ${n} 轮才读到）`) };
      }
      readUnknown = got ? '' : '回读没读出可见范围（stdout 里没有 link_share_entity）';
    } catch (e) {
      const rawErr = String(e?.stderr ?? '').trim() || String(e?.stdout ?? '').trim();
      const shown = rawErr || String(e?.message ?? e);
      readUnknown = `回读权限失败：${shown.slice(0, 200)}`;   // ← 给人看的用全文
      // 确定性回读错（scope 没开之类）⇒ 补也一样，直接收尾成"验不成"。
      // ⚠️ 判重试喂的是 **rawErr**（"有没有吐字"），不是 `shown` —— 理由同上一条 catch。
      if (!_permTransientOf(e, rawErr)) break;
    }
    if (backoff && n < attempts) await _permSleep(backoff * n);
  }
  // 走到这里 = patch 回执都成功过，问题只在「验」
  if (got && got !== REPORT_SHARE_ENTITY) {
    return { ok: false, kind: 'mismatch', got, attempts: rounds,
             detail: `回读不是 ${REPORT_SHARE_ENTITY}（读到 ${got}）⇒ 链接不写进表` };
  }
  return { ok: false, kind: 'unverified', got, attempts: rounds, transient: true,
           detail: `权限**已设置但回读未验成**（${readUnknown || '未知原因'}）⇒ 不能断言"点得开"` };
}

/**
 * **P0 报告投递**（2026-10-06 加）。
 *
 * ── 为什么要有它
 *
 * Owner 2026-10-06 定的口径（三句话，逐条对应一个实现决定）：
 *   ① 「**P0 问题可先在飞书侧响应**」 —— 回执卡在 `runSubmissionGate` 里**先发**
 *      （`notify(ackMessage(...))`），P0 判定在它之后，所以这一步**不在任何响应预算里**；
 *   ② 「**写入云文档报告的时间不统计在 ≤1 秒内**」 —— PRD §12 的「P0 层响应 ≤1s」
 *      量的是 **P0 判定**（`p0_fastpath.py` 的 `elapsed_ms`，实测 9.8 ms），
 *      而「报告生成 ≤30s」是**另一条**指标。⇒ 这里超时按 **30 s** 设，超了就照实说没生成。
 *   ③ 「**补充报告**」 —— 报告不是"以后再说"：这一步**必须**跑，
 *      跑成了就把链接填进回执、填进表行的 `报告链接`；跑不成要**看得见**（返回 detail），
 *      **不许**静默留空、更不许编一个链接。
 *
 * ── 为什么走 `lark-cli` 而不是 Node SDK
 *
 * 与库内发布件 `kb/l7/review-engine/core/feishu_publish.py` **同一条命令、同一个身份**
 * （`--profile dsh-kb --as bot`）：那条路已经把「从第 1 行写、不传 --title（标题就是正文首行 H1）、
 * 用 markdown 导入而不是 append」这些坑趟平了。这里**不复刻它的判据**，只复用它踩平的路。
 * 自己拿 SDK 拼 docx block 会把「markdown → 块」那套转换再写一遍，必错。
 */
export const P0_DOC = Object.freeze({
  profile: process.env.SHOUHENG_LARK_PROFILE ?? 'dsh-kb',
  bin: process.env.SHOUHENG_LARK_CLI ?? path.join(os.homedir(), '.dsh', 'bin', 'lark-cli'),
  timeoutMs: Number(process.env.SHOUHENG_P0_DOC_TIMEOUT_MS ?? 30000),
});

/**
 * 把一份**本地报告 .md** 投成飞书云文档，返回它的 url。
 *
 * ★ **失败不抛、不阻断结论** —— 报告没生成，P0 的 BLOCK 照样成立（那是两件事）。
 *   所以返回 `{ok, url, detail}`：调用方必须**照 detail 说**，不许把 `url=""` 说成"已出报告"。
 *
 * ★★ `cwd: path.dirname(f)` 不是随手写的（2026-10-06 实测踩过，值得记下来）：
 *   `lark-cli` 的 `@file` **拒绝工作目录之外的文件**。实测四种组合：
 *     · 库内路径 ＋ cwd=库根        → ✅ ；· 库内路径 ＋ cwd=报告所在目录 → ✅
 *     · 库内路径 ＋ cwd=tools/agent → ❌ `--content: invalid file path`
 *     · 库内路径 ＋ cwd=/tmp        → ❌ 同一句错
 *     · /tmp 里的文件 ＋ 任意 cwd   → ✅ （`/tmp` 是它额外放行的）
 *   本函数第一版没设 `cwd`，于是**不管报告写得多好，云文档一律建不出来** ——
 *   而它当时的表现只是「报告：未生成」，看起来像权限问题。
 *   把 cwd 设成**报告自己所在的目录**就有了不依赖任何外部约定的保证：文件必在其 cwd 之下。
 */
export async function publishReportDoc(mdPath, opts = {}) {
  const f = String(mdPath ?? '').trim();
  if (!f) return { ok: false, url: null, detail: '没给报告文件路径' };
  if (!fs.existsSync(f)) return { ok: false, url: null, detail: `报告文件不存在：${f}` };
  // ★★ 2026-10-19（Owner 当场报「输出的报告模版怎么改了」）—— **一次偶发把模版换掉了**：
  //   17:23 那一单，合并报告（原模版）投递**偶发失败**（CLI 非零退出、两路都没吐字，
  //   详见 `_transientFailureOf`），于是卡上的链接**回落成库侧 P0 那份**（另一套模版、只装
  //   库侧 1 条，卡上说 6 条）⇒ 人点开看到的报告跟十分钟前那份**长得不一样**。
  //   病灶不是模版被改，是**偶发失败没有被补一次**。
  //   ⇒ 偶发失败补一次（默认 2 次＝原始那次 ＋ 补一次；`SHOUHENG_P0_DOC_ATTEMPTS` 可调）。
  //   ⚠️ 确定性失败（校验不过、路径读不到、`invalid <img>` 那类）**不重试** ——
  //      重试只会把「报告 ≤30s」这条指标拖成两倍，还照样失败。
  //   ⚠️ 残留（已知、照实说）：**超时**这一类分不清「服务端没建」与「建了但回执丢了」，
  //      补的那一次可能多出一份**孤儿云文档**。取舍：多一份没人链接的文档，
  //      好过卡上挂一份**另一个模版**的报告（2026-10-19 那次就是后者）。
  const attempts = Math.max(1, Math.floor(Number(process.env.SHOUHENG_P0_DOC_ATTEMPTS ?? 2) || 2));
  let last = null;
  for (let n = 1; n <= attempts; n += 1) {
    last = await publishReportDocOnce(f, opts);
    if (last.ok) {
      return (n === 1
        ? last
        : { ok: true, url: last.url,
            detail: `${last.detail}｜补第 ${n} 次才成（前 ${n - 1} 次是偶发失败）` });
    }
    if (!last.transient || n === attempts || reviewDeadlineExpired()) break;
    await _permSleep(1200 * n);
  }
  // 对外形状不变（`ok / url / detail` 三件）—— 调用方（卡片、日志、Z34b 判据）都不认识 `transient`
  return { ok: false, url: null, detail: last?.detail ?? '（没跑）' };
}

/**
 * 这一次失败是**偶发**（值得补一次）还是**确定性**（补也没用）？
 *
 * 判据来自 2026-10-19 那次实测：`promisify(execFile)` 的异常里
 *   · 超时/被信号杀 ⇒ `e.killed === true` / `e.signal` 有值，而 `stderr` 可能是**空的**；
 *     （同一天那条报错全文就是 `Command failed: <命令>`，**一个字原因都没有** ——
 *      不是 CLI 没报，是它根本没走到报错那一步）
 *   · CLI 自己的校验错 ⇒ **stderr 里有 JSON**（实测：`--content` 读不到文件时
 *     错误对象打的是 stderr，`type: validation`）⇒ 这一类**重试必然同样失败**。
 */
function _transientFailureOf(e, errText) {
  if (reviewDeadlineExpired() || e?.code === 'REVIEW_DEADLINE_EXCEEDED') return false;
  if (e?.killed || e?.signal) return true;
  const t = String(errText ?? '').trim();
  if (!t) return true;                                   // 两路都没吐字 ⇒ 说不清，按偶发处理
  if (/"type"\s*:\s*"validation"/.test(t)) return false;  // CLI 判参数/内容不合法 ⇒ 确定性
  return /ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|timed out|rate.?limit|429/i.test(t);
}

/** 单次投递（`publishReportDoc` 的第 n 次；**不重试、不吞错**）。 */
async function publishReportDocOnce(f, opts = {}) {
  // `opts.run` 可注入 —— 自证时不碰真库（与 `ensureTenantReadable` 同一个口子）。
  const run = deadlineRun(opts.run);
  try {
    const { stdout } = await run(P0_DOC.bin, [
      '--profile', P0_DOC.profile, 'docs', '+create',
      '--content', `@${f}`, '--doc-format', 'markdown', '--as', 'bot',
    ], { timeout: P0_DOC.timeoutMs, maxBuffer: 8 << 20, cwd: path.dirname(f) });
    let j = null;
    try { j = JSON.parse(String(stdout)); } catch { /* 下面按 raw 报 */ }
    const url = j?.data?.document?.url ?? '';
    if (!url) {
      return { ok: false, url: null,
        detail: `lark-cli 回了但没给 url：${String(stdout).slice(0, 200)}` };
    }
    // ★★ 2026-10-16（Owner：「所有上审查报告…权限跟随飞书云文档」）：
    //   建完**立刻**把可见范围设成「组织内可阅读」并**回读确认**。
    // ★★ 2026-10-20 收窄（Owner：「必须按照我要求的报告模版输出」）：
    //   原话是「回读不过 ⇒ 一律不给 url」。但在 18:59 那一单里，**回读失败 ≠ 权限没设上**
    //   （事后重跑同一条命令读到的就是 `tenant_readable`）—— 而"不给 url"的后果是
    //   调用方回落成库侧那份，**报告换了模版**。⇒ 只有「看得见的坏」才不给链接：
    //     · `mismatch`（读得出、就是不达标）/ `patch_failed`（没设成）⇒ 不给（点不开的链接比空格更坏）；
    //     · `unverified`（patch 回执成功、只是没验成）⇒ 给，但**必须标注"权限未核验"**。
    const docId = j?.data?.document?.document_id ?? '';
    const perm = await ensureTenantReadable(docId, { run });
    if (!perm.ok) {
      // ★★ 2026-10-20（真单 18:59）：`unverified` 若照旧 `url:null`，调用方会回落成库侧那份
      //   （`kb/l7/review-engine/core/feishu_publish.py` 的「问题分类汇总/完整清单」版式）
      //   ⇒ 人点开看到的报告"一会儿一个样"。形状优先：交回自己这份，并把"未核验"写在明面上。
      //   ⚠️ 只放行 `unverified` —— 那一种**已经 patch 成功过**，不是"猜权限设上了"。
      if (perm.kind === 'unverified') {
        console.log(`[review_publish] ⚠️ 报告云文档 ${docId || '?'} ⇒ 链接照用（保住报告模版）`
          + `｜${perm.detail}`);
        return { ok: true, url, share: 'unverified',
                 detail: `云文档已建（${docId || '?'}）｜**权限未核验**：${perm.detail}` };
      }
      return { ok: false, url: null,
        detail: `云文档已建但**权限没设成组织内可阅读** ⇒ 链接不写进表：${perm.detail}` };
    }
    return { ok: true, url, detail: `云文档已建（${docId || '?'}）｜${perm.detail}` };
  } catch (e) {
    // ★ 把 CLI 的原话带出来 —— 库规「有权限不许说没权限」的反面同样成立：
    //   报错要能区分「没建权限」与「命令写错」，糊成一句「失败了」等于把排查成本转给人。
    // ★★ 2026-10-19：`stderr` 空的时候要把 **stdout** 与**被杀/超时**也带出来 ——
    //   17:23 那条报错全文只有 `Command failed: <命令>`，事后没人能判断是超时还是 CLI 崩了。
    // ⚠️ 「有没有吐字」看的是 **stderr/stdout**，不是 `e.message` —— node 的
    //   `Command failed: <cmd>` 那句**恒非空**，拿它判「有输出」的话，
    //   2026-10-19 那种「两路全空」的偶发失败会被误判成确定性失败、**一次都不补**（实测踩到）。
    const rawErr = String(e?.stderr ?? '').trim() || String(e?.stdout ?? '').trim();
    const shown = rawErr || String(e?.message ?? e);
    const why = (e?.killed || e?.signal)
      ? `[超时/被杀 timeout=${P0_DOC.timeoutMs}ms signal=${e?.signal ?? '?'}] `
      : '';
    return { ok: false, url: null, transient: _transientFailureOf(e, rawErr),
             detail: `建云文档失败：${why}${String(shown).slice(0, 300)}` };
  }
}

/** 默认测试表；无会话来源的批处理保持原落点。 */
export const REVIEW_TABLE = Object.freeze({
  appToken: 'RY2UbCRjXaeeWwscUPScVN5AnQc',
  table: 'tblCXPQVzfFWWCon',
});

export const PRODUCTION_REVIEW_TABLE = Object.freeze({
  ...REVIEW_TABLE, table: 'tblv2Y5NxxtDj4Pl',
});

// 2026-11-04 Owner 指定；群名与表名已通过飞书元数据核对。
// 用本条事件的稳定 ID 路由，不用群名、产品线或跨会话共享的 runtimeContext。
const PRODUCTION_CHAT = 'oc_LEGACY_GROUP';
const TEST_CHAT = 'oc_TEST_GROUP';
const OWNER_CHAT = 'oc_TEST_P2P';
const OWNER_OPEN_ID = 'ou_TEST_USER';

/**
 * 落表要写哪张表。
 *
 * ★ 2026-10-05 现场踩到的坑，必须记下来（§2.4.4 那个形状的又一例）：
 *   **跑一次自证，往 Owner 的真实飞书表里写了两行。**
 *   `runSubmissionGate` 里那段「保证落表」对**测试桩**也照跑不误 ——
 *   于是单测里 `chainRunner` 返回一句假的 `结论：REVIEW`，就真的在群里那张表上建了一行；
 *   紧接着下一条反向对照（链没跑成）又把那一行的 `状态` 改成「待审」。
 *   自证不但没验出问题，**自己成了问题的来源**。
 *   修法两条，缺一条都不算修好：
 *     ① 落表这一步**可注入**（`publishRunner`，与 `chainRunner` 同一套写法）；
 *     ② 这里留一个**关掉它的闸门**（`SHOUHENG_REVIEW_TABLE=off`），自证默认拉闸 ——
 *        这样即使将来谁漏传了桩，也写不进真表。
 */
export function reviewTable(ctx = {}) {
  const raw = String(process.env.SHOUHENG_REVIEW_TABLE ?? '').trim();
  if (/^(off|none|0)$/i.test(raw)) return null;         // ← 拉闸
  // 测试群是群聊中的唯一例外；其余群（含以后新建的群）默认生产，无需逐群登记。
  // 群聊规则先于 Owner 身份，避免 Owner 在群里提问被当作私聊测试。
  if (ctx.chatId === TEST_CHAT) return REVIEW_TABLE;
  if (ctx.chatType === 'group' || ctx.chatId === PRODUCTION_CHAT) return PRODUCTION_REVIEW_TABLE;
  if (ctx.chatType === 'p2p'
      && (ctx.chatId === OWNER_CHAT || ctx.senderOpenId === OWNER_OPEN_ID)) return REVIEW_TABLE;
  if (!raw) return REVIEW_TABLE;
  const [appToken, table] = raw.split('/');
  if (!appToken || !table) return REVIEW_TABLE;
  return { appToken, table };
}

/** 机器可以填的字段；其余（人的格子）一律不碰。 */
export const MACHINE_FIELDS = Object.freeze([
  '内容 ID', '送审问题', '内容类型', '渠道', '产品线', '送审版本',
  'Agent 结论', '置信度', '问题数量', '问题分类汇总', '报告链接', '状态',
]);

/**
 * **结论派生列 —— 允许改写**（2026-10-08，Owner 同意「推荐 B」）。
 *
 * 这几个字段是**本轮结论的函数**，必须跟着结论走；表里其余机器列仍「只补空」。
 *
 * ── 为什么非改不可（两条都是实测，不是推论）
 *   ① **多轮送审时结论会变**：同一文案第三次送审 REVIEW → BLOCK（P0 快路对上）——
 *      「只补空」会让表**定格在第一轮**，卡里 BLOCK、表里还是 REVIEW。这正是 Owner
 *      最初报的那类「同一单两个结论」。
 *   ② **写错的机器列此后永远改不回来**（比①更坏）：实测素材 A 那行 `recvxlTh9b6HYq` ——
 *      `Agent 结论=REVIEW`（**引擎**建行时写的）＋ `问题分类汇总=「未能得出结论（NEEDS_INPUT）」`
 *      （**守衡**后来写的，当时那条判据过宽）⇒ 两格都已填 ⇒ **谁也改不动**，
 *      这一行自相矛盾且**无法自愈**（下一个判据修好了也追不回来）。
 *
 * ── 边界一个字没松
 *   · `HUMAN_FIELDS`（人工复核人／复核结论／sign-off 人／审核人／发布时间）**照旧一个字都不碰**，
 *     哪怕它空着也不替人下笔；
 *   · 其余机器列（内容 ID／内容类型／渠道／产品线／送审版本）照旧「**只补空**」——
 *     那条规则要防的是「模型先写进去的『未指定』把真值永久挡住」；
 *     ★ 2026-10-21 更正：这一段原先还列着 `报告链接`（「只该被第一次写进去」）——
 *       Owner 要求「重审重跑、不许复用上次结论」之后它**已挪进** `OVERWRITABLE_FIELDS`，
 *       理由见那里。
 *   · 值**没变就不写**（免得一次「什么都没变」被记成一次写入、把 `unchanged` 报成 `updated`）。
 */
export const CONCLUSION_DERIVED_FIELDS = Object.freeze([
  '状态', 'Agent 结论', '问题数量', '置信度', '问题分类汇总',
]);

/**
 * **可改写列的总集** ＝ 上面的结论派生列 ＋ `送审问题`（2026-10-16，Owner 裁定）。
 *
 * ── 为什么把 `送审问题` 从「只补空」挪进来
 *
 *   Owner 2026-10-16：「送审问题 里面的图片和视频要优化成链接，点击就可以打开的，
 *   **只留原文，不要写其他话**」，并选定「**直接覆盖送审问题，不要新建**」。
 *
 *   而这一格此前的形态是**写错了就再也改不回来**：实测结论表 200 行里 ——
 *   **54 行**的格子里躺着我们自己的内部指令（`【★ 这是送审素材…】`、`【对方这条消息里附了图…】`
 *   ＋ OCR 全文），**20 行**是 `[图片]` 占位。这些格子**都已经有值** ⇒
 *   「只补空」这条规则会让它们**永远保持脏**，后面判据修好了也追不回来
 *   （与 2026-10-08 那两格自相矛盾的行是**同一个形状**：错值一旦落格就钉死）。
 *
 * ── 边界一个字没松
 *
 *   · `HUMAN_FIELDS` 照旧一个字都不碰；
 *   · 其余的机器列（内容 ID／内容类型／渠道／产品线／送审版本）照旧「只补空」；
 *   · 值没变就不写。
 *
 * ── ★★ 2026-10-21 再把 `报告链接` 挪进来（Owner 逐字：「**我要的是重审重跑，不允许复用上次结论**」）
 *
 *   改之前它属「只补空」，理由是 2026-10-06 那次的「新报告成孤儿」
 *   （`previousReportLink` 那段头注逐字记着）。而配合 `tools.mjs` 的 P0 快路**复用旧报告、
 *   本次不建文档**，两处合起来的效果是：
 *
 *     同一张图**第二次**送审 ⇒ `Agent 结论` 按本单重判（REVIEW→BLOCK 之类），
 *     而「报告链接」这一格**仍指向第一次那份** ⇒ 人点开读到的**是上一次的结论与时间戳**。
 *
 *   这不再是「孤儿文档」问题，而是「表里那一格指向的不是本单」——
 *   与 `CONCLUSION_DERIVED_FIELDS` 那条理由①**同一个形状**（行内两套口径）。
 *   ⇒ 现在送审那条路**每次都出本单自己的报告**（`tools.mjs` 的 `p0ReportOutcome` 钉着），
 *     这一格就跟着本单走；旧的云文档仍在（只是没人再指向它），不丢。
 *
 *   ⚠️ 三条不许松：
 *     ① **本单没出成报告时默认不清空**（`rowFieldsOf` 没拿到链接就**不写这一格** ⇒ 旧链接留原处），
 *        那一眼由回执的 `report_detail` 说出来（「本单报告没出成，下面这个链接是上一次的」）；
 *        完整性闸拒收时可显式传 `clearReportUrl: true` 撤回旧链接，避免旧报告冒充本轮结论；
 *     ② 只读前置（`allowPublish=false`）那条路**不建文档**，写进来的仍是既有的那份；
 *     ③ `HUMAN_FIELDS` 照旧一个字都不碰。
 */
export const OVERWRITABLE_FIELDS = Object.freeze([
  ...CONCLUSION_DERIVED_FIELDS, '送审问题',
  // 报告链接：每次送审都出本单自己的报告 ⇒ 这一格必须跟着本单走（见上面那段）
  '报告链接',
]);

/** 把飞书那几种字段形状摊平成可比较的字符串（文本数组 / 数字 / 链接 / 选项）。 */
function plainOf(v) {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return v.map(plainOf).join('');
  if (typeof v === 'object') {
    if ('text' in v) return plainOf(v.text);
    if ('link' in v) return plainOf(v.link);
    if ('value' in v) return plainOf(v.value);
    if ('name' in v) return plainOf(v.name);
    return JSON.stringify(v);
  }
  return String(v);
}

/** 同值判定：`'3'` 与 `3`、`[{text:'REVIEW'}]` 与 `'REVIEW'` 都算同值。 */
export function sameValue(a, b) {
  const pa = plainOf(a).trim();
  const pb = plainOf(b).trim();
  if (pa === pb) return true;
  const na = Number(pa);
  const nb = Number(pb);
  return pa !== '' && pb !== '' && Number.isFinite(na) && Number.isFinite(nb) && na === nb;
}

/**
 * **置信度 / 问题数量：永不为空**（Owner 2026-10-06 明令「不允许为空」）。
 *
 * ── 为什么不能只是「拿不到就留空」
 * PRD §8.2 把这两个字段列为**必录**。而引擎在**拒答态**（`NEEDS_INPUT`）**就是不给** confidence
 * （`with_kb_evidence.py` 拒答分支写 `None`），`agent.mjs` 原先按「不许编数」留空 ⇒ 表里出现空列。
 * 这件事 2026-10-05 记过一次（契约里的 `known_leftovers`），2026-10-06 Owner 又现场指出
 * ——「**昨天修复过了，今天又复现了**」。
 * ★ **同一个形状出现两次 ⇒ 留空不是"诚实"，是把问题藏起来**：空格既说不出"引擎没给"，
 *   也说不出"我们没读到"，看表的人只能来问。
 *
 * ── 口径（写进代码，也**拼进汇总列** —— 看表的人不必来问）
 *   · P0 命中            → 问题数 = 引擎命中条数；置信度 = **1.0**（确定性命中，PRD §6.6 不分流）
 *   · 链给出三态值        → 用引擎值（实测 PASS 0.99 / REVIEW 0.78）
 *   · 引擎不给（拒答/未测）→ **0**：**0 = 「没有做出判定」，不是「零风险」**（汇总列写明）
 *   · 读数缺失（旁挂没读到）→ **0** ＋ 汇总列写明「读数缺失」
 *
 * ★ 这就是「不允许为空」的代价：**填了数就必须同时填口径**。
 *   只填一个 0 而不说它是什么意思，比空格更坏 —— 它看起来像一个结论。
 *
 * @param {object} res 链/快路的返回（`res.review` 是旁挂，`res.p0_fastpath` 是 P0 标记）
 * @param {string|null} conclusion 已判定的三态/拒答
 * @param {object|null} mergedConf **两侧合并后的置信度**（`dual_track.mergedConfidence()` 的产物，
 *   Owner 2026-10-15）。给了就用它（并把它那句 `basis` 一并写进口径说明）；没给 ⇒ 回落库侧那个数
 *   （旧口径，向后兼容：老调用点与老测试一行不用改）。
 * @returns {{issueCount:number, confidence:number, note:string}} `note` 为空 = 没做任何替换
 */

/**
 * ★★ 「这个数**没有标定**」的固定声明（Owner 2026-10-15 裁 ①：表里那个数照记，口径说明补一句）。
 *
 * 依据 = 双轨回归标定 A（`交付-置信度双轨回归标定-A-20261015.md`，带人工 expected 的 100 条）：
 *   · **两侧合并数**：三态准确率 0.64；`direct` 档 n=8 **全错**；**同序不成立（且反向）**；≥0.90 误放率 1.00。
 *   · **库侧单轨数**（同批对照）：0.61；同序也不成立；≥0.90 误放率 0.30。
 *   ⇒ 结论：**这个数不携带可用于分流的信息**，只准当标签 —— 写数的地方必须自己带上这句，
 *     否则读表的人会把它当成"机器很有把握"。
 *
 * ★ 为什么钉在**代码**里、而不是去表里手改一句：那张表是**机器逐行重写的**
 *   （`batch_review_runner.mjs` 把结论表的 `问题分类汇总` 整格抄进采集表，实测 2026-10-15 一小时重写 28 行）
 *   ⇒ 手改的标注会被下一次回填**抹掉**；写在产出它的地方，才是每行、每轮都自带。
 */
const CONF_UNCALIBRATED = '★ 本数**未标定**（2026-10-15 双轨回归标定：同序不成立、≥0.90 档 8/8 判错）'
  + '⇒ **不得用作分流依据**，只作标签留痕';

export function machineNumbers(res = {}, conclusion = null, mergedConf = null) {
  const rev = res?.review ?? null;
  const fin = (...vals) => vals.find((v) => Number.isFinite(v));
  const p0 = !!res?.p0_fastpath;
  const state = String(conclusion ?? '').toUpperCase();
  // ★ 三种"没数"要**分开说** —— 混成一句会让排查方向全错：
  //   · `missing`：机读旁挂**根本没读到**（文件缺失/不新鲜）⇒ 该去查旁挂，不是查引擎；
  //   · `refused`：引擎**明确不做判定**（拒答/未测）⇒ 库的覆盖不够，不是坏了；
  //   · 其余：引擎给了结论却没给这个量。
  const missing = !rev;
  // ★★ 2026-10-15 修（Owner 裁定「先修置信度那个 bug」）—— **「拒答」只认顶层 `state`**，
  //   与 `dual_track.mjs::kbSideOf` 那条 2026-10-07 已收紧的口径**对齐**（那边 `⑪c` 判据一直守着）。
  //
  //   病灶（拿今天真跑的 10 行核出来的，两行对得上）：`!!rev?.refusal` 把
  //   **「顶层 state=REVIEW ＋ 依据侧记了 refusal」**（库侧覆盖缺口 `coverage_not_covered` 的形状）
  //   也判成「引擎未做判定」⇒ `refusedExempt` 成立 ⇒ **把已经算好的两侧合并数丢掉、写 0**：
  //     · `MC-US-YT-RLF9-789hh8-WEN`：同一次运行打印 `置信度(两侧合并)=0.85 [confirm]（库侧 — / 模型侧 confirm）` ⇒ 表里 0
  //     · `MC-US-YT-_xyLF4_AgAw`   ：同一次运行打印 `置信度(两侧合并)=0.93 [direct]（库侧 — / 模型侧 direct）`   ⇒ 表里 0
  //   而**恰好**只有这两行是「库侧没给置信度」⇒ 库侧一给档位（另 8 行）写进去的就都是合并数。
  //   Owner 口径（原话）：「知识库侧、模型侧都会出置信度，最后汇总成一个置信度输出」
  //   ⇒ 一侧没给就用另一侧（`mergedConfidence()` 已经这么做），**不是**回头写 0。
  //
  //   `refusal` 降为**原因码**：仍如实写进口径说明（覆盖缺口是"该转人工看覆盖"，不是"没判定"）。
  const refused = state === 'NEEDS_INPUT';
  const refusalWhy = rev?.refusal
    ? String(typeof rev.refusal === 'string'
      ? rev.refusal
      : (rev.refusal.reason_code ?? rev.refusal.reason ?? rev.refusal.state ?? '有 refusal 记录'))
    : '';
  const notes = [];

  let issueCount = fin(rev?.issue_count, res?.issue_count);
  if (issueCount === undefined) {
    issueCount = 0;
    notes.push(p0 ? '问题数量按 **0** 记（P0 未给条数）'
                  : missing ? '问题数量按 **0** 记（**本单没读到引擎读数**）'
                            : '问题数量按 **0** 记（引擎未给出该读数）');
  }
  // ★★ 2026-10-15（Owner）：**两侧合并**的那个数优先（库侧与模型侧各出一个档位，取更保守一侧）。
  //   为什么能直接替：它是**同一次合并**的产物（与卡/报告里的结论同一个来源），因此表行那个数
  //   与它标注的结论**同源**——旧写法（只取库侧）会出现「结论是两侧合并的、置信度只反映库侧」。
  //   库侧那个数**没有被丢掉**：它作为 `kb_band` 留在 `mergedConf` 里，`basis` 会写明是哪一侧拉低的。
  //
  //   ★★ 但有两格**不许**被合并数覆盖（2026-10-15，拿 80 行真数据核出来的）：
  //     · **P0 命中**：PRD §6.6 逐字（**现行修订 rev 109**）「P0 层级规则**不适用置信度分流**，
  //       命中即 BLOCK，**置信度记为 1.0**」⇒ **1.0 是 PRD 明文，不是本库自创口径**。
  //       80 行里有 **12 行**是 P0；不守这一格 ⇒ 它们会被合并数**降成 0.93**
  //       = 把"确定性命中"改写成"还有不确定性"，直接违反 PRD 那一句。
  //       ★ 教训：先前引的是 **rev 36**（那一版只到「命中即 BLOCK。」，没有后三个字）
  //         ⇒ **引用 PRD 前先核 `revision_id`**（`docs +fetch` 可能给到旧修订）。
  //     · **拒答/未测**：`0` 在本库有专门语义 =「**没有做出判定**」（不是零风险）。
  //       80 行里有 **40 行**是 0；policy 也写着「拒答态不是判定结果，没有置信度可分流」
  //       ⇒ 拿模型侧的数去顶它，等于给一个**根本没有结论**的单子配一个"确定性"。
  const p0Exempt = p0;                       // PRD §6.6：P0 不适用分流
  const refusedExempt = refused || state === '拒答';
  // 引擎可以已给出 REVIEW/置信度，而完整性验收随后拒收；最终拒答不能再回退引擎数。
  // 原始引擎读数保留在 res 中，0 只描述本次未形成有效最终结论。P0 仍沿用既有豁免。
  if (refusedExempt && !p0Exempt) {
    notes.push('置信度按 **0** 记 —— **本次完整审核未形成有效结论，不是「零风险」**'
      + '；不采用库侧或两侧合并的置信度（拒答态没有可分流的结果）');
    return { issueCount, confidence: 0, note: notes.join('；') };
  }
  // ★★ F1 的另一半（2026-10-15）：**`Number(null) === 0`**。
  //   旧写法 `const mergedVal = Number(mergedConf?.value)` 在「**没有**合并数」（`value: null`
  //   —— 库侧没有读数时按 F1 就是这种形状）下得到 **0**，而 `Number.isFinite(0)` 为真
  //   ⇒ `useMerged = true` ⇒ 表里落一个 **0**，注记却写「档位 —」。**这正是本库栽过的那类陷阱**
  //   （`bandOf` 的注释里写着同一条），只是换了个变量名。
  //   现在：三态空值（null/undefined/''）**一律**当"没有这个数"，与 `bandOf` 同一口径。
  //   判据：自证 D6（`mergedConf.value = null` ⇒ 不许落 0 当成"确定性"）＋ D6b 反向对照。
  const mergedGiven = mergedConf !== null && mergedConf !== undefined
    && mergedConf.value !== null && mergedConf.value !== undefined && mergedConf.value !== ''
    && Number.isFinite(Number(mergedConf.value));
  const mergedVal = mergedGiven ? Number(mergedConf.value) : null;
  const useMerged = !p0Exempt && !refusedExempt && mergedGiven;
  let confidence = useMerged ? mergedVal : fin(rev?.confidence, res?.confidence);
  if (useMerged) {
    notes.push('置信度（两侧合并 · 档位 ' + (mergedConf.band ?? '—') + '）：' + String(mergedConf.basis ?? '')
      + '；' + CONF_UNCALIBRATED
      // ★ 2026-10-15：库侧记过 refusal、但顶层结论**不是**拒答 ⇒ 说明一句，免得读表的人
      //   以为这个数漏掉了覆盖缺口。（refusal 是原因码，不再等于"没判定"。）
      + (refusalWhy ? `（库侧记过 refusal=${refusalWhy}；顶层结论是 ${state} ⇒ **不算拒答**，合并数照用）` : ''));
  } else {
    if (mergedGiven && (p0Exempt || refusedExempt)) {
      notes.push(p0Exempt
        // ★★ 2026-10-16（Owner 逐字裁定）：「按照 prd：P0 层级规则不适用置信度分流，命中即 BLOCK，
        //   置信度记为 1.0。**模型侧应该也是 1，最终出 1**。」
        //   ⇒ 这一格的口径行必须把两件事都写出来：① 这句 PRD 原文；② **两侧同档**
        //     （模型侧读数照出、只是不参与取保守）—— 否则读表的人会以为"这个 1.0 是单侧的"。
        //     （合并层那边同步改了：`dual_track.mergedConfidence` 的 `p0` 档现在本身就出 1.0。）
        ? '置信度按 **1.0** 记（PRD §6.6：**P0 层级规则不适用置信度分流，命中即 BLOCK，置信度记为 1.0**）'
          + '｜**不合并模型侧的置信度**（确定性匹配 ⇒ 该档不受模型侧读数影响）'
        : '置信度按 **0** 记（**引擎未做判定**）⇒ 不采用两侧合并数（拒答态没有可分流的结果）');
    }
    if (confidence === undefined) {
      confidence = 0;
      notes.push(missing
        ? '置信度按 **0** 记 —— **本单没读到引擎读数（机读旁挂缺失/不新鲜）**；这个 0 **不是**置信度'
        : refused
          // ★ 这一句是关键：0 必须自带解释，否则会被读成「零风险」。
          ? '置信度按 **0** 记 —— **0 = 引擎未做判定（拒答/未测），不是「零风险」**'
          : '置信度按 **0** 记（引擎未给出该读数）');
    } else if (!p0Exempt && !refusedExempt) {
      // 库侧单轨：引擎给了数、但没有两侧合并数 ⇒ **同样未标定**，必须自带声明。
      //   不补这一句就会出现一个"裸数"（表里一个 0.95，谁也不知道它意味着什么）。
      notes.push('置信度（库侧单轨 · 引擎读数）：' + CONF_UNCALIBRATED);
    }
  }
  return { issueCount, confidence, note: notes.join('；') };
}

/** 人填的字段：补写时**绝不覆盖**（哪怕它现在是空的，也不替人下笔）。 */
export const HUMAN_FIELDS = Object.freeze([
  '人工复核人', '复核结论', 'sign-off 人', '审核人', '发布时间',
]);

/**
 * 送审文本 → 内容 ID。**与知识库那条链同一个算法**（实测复算过，见文件头）。
 * @param {string} materialText 送进链的素材文本（逐字）
 */
export function contentIdOf(materialText) {
  const t = String(materialText ?? '').replace(/\s+$/, '');
  if (!t) return null;
  return `AUTO-${crypto.createHash('sha256').update(t, 'utf8').digest('hex').slice(0, 12)}`;
}

/**
 * 人/内容方的**终态**：机器不许写、也不许改回来（PRD §8.2 三档里机器只拥有「待审」）。
 * 判别式只认这两档 —— `待审` 与空值照旧可写（第一次送审必须能落上）。
 */
export const HUMAN_TERMINAL_STATUS = Object.freeze(['已修改', '已发布']);

/**
 * 结论 → 表里的 `状态`。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 2026-10-15（Owner）：**这一格的形状原来是错的 —— 三态被写进了「状态」**
 * ══════════════════════════════════════════════════════════════════════════
 *   Owner 原话：「状态按照 prd：待审 / 已修改 / 已发布，**现在填的错的**」。
 *   PRD §8.2 逐字：「多维表字段：… Agent 结论、置信度、问题数量、问题分类汇总、报告链接 /
 *   人工复核人、复核结论、sign-off 人、发布时间 / **状态：待审 / 已修改 / 已发布**」
 *   ⇒ **三态（PASS/REVIEW/BLOCK）是 `Agent 结论` 的值域，不是这一格的**。
 *
 *   旧实现按结论返回三态（实测病灶：采集表 80/80 行、结论表 441/457 行被写成 BLOCK/REVIEW/PASS），
 *   后果是「机器判定」与「流程状态」被压进同一格 —— 读表的人分不清
 *   「这单判成 BLOCK」与「这单还没人处理」，`已修改／已发布` 两档也几乎从没被用过。
 *
 *   ⇒ 机器只拥有「待审」这一档：**送审进来、等人处理**。
 *     「已修改」（内容方改完重新提交，§8.1）与「已发布」是人做的事，
 *     机器既不写、也不把人的终态改回来（见 `HUMAN_TERMINAL_STATUS` 与 `ensureReviewRow` 的补丁闸）。
 *
 *   ⚠️ 形参 `conclusion` 保留**是有意的**：调用点一字未改（少传一个参数是散弹式改动），
 *      而且将来若 PRD 给「已修改」定下机器可判的触发条件，判据就长在这里。
 */
export function statusOf(conclusion) {
  // 唯一的机器档位：等人处理。三态照旧只进 `Agent 结论`（`rowFieldsOf` 里那一格没动）。
  return '待审';
}

/**
 * 从链的返回原文里抽 `Agent 结论`。**抽不到就回 null，不猜。**
 *
 * ★★ 2026-10-07 收紧（Owner 同意）—— 旧版是 `\b(PASS|REVIEW|BLOCK|NEEDS_INPUT)\b`，
 *   取**全文第一个**三态词。那是 fail-**open** 的：一句免责话就能把结论抠成 PASS。
 *   实测（三个反例，全部抠成 `PASS`）：
 *     · 「库侧未参与 ⇒ 本条**不得当 PASS 依据**。结论：REVIEW。」
 *     · 「本次没跑到引擎，所以**不能当 PASS**；请重试。」
 *     · 「链没跑成，结论未知（不是 PASS，也不是 REVIEW）。」
 *   素材 D（表行 `recvxlAvpEWMIX`）就是这么在**库侧零读数**的情况下落了 `Agent 结论=PASS`。
 *
 * ⇒ 现在**只认「像读数」的位置**：结论行（`【审查结论：X】` / `结论：X` / `判定：X`）、
 *   状态行（`state = X` / `状态：X`）、以及链原文里的 `引擎最终输出：X`。
 *   这些是**有格式契约**的地方（PRD §5.3 的结论行、引擎报告第一节的 `state = X`）。
 *   其他地方出现三态词**一律不认** —— 宁可不写这一格，也不许把"不能当 PASS"读成 PASS。
 *
 * ⚠️ 代价（已知并接受）：若某个回答用「最终结论为 REVIEW」这种**没有冒号**的写法，
 *   这一格就抽不出来了（回 null ⇒ 不写）。**这比抽错好**：空值人会补，错值人不会回头看。
 */
export function conclusionOf(answer) {
  const s = String(answer ?? '');
  // ★★ 2026-10-21（四态）：`Agent 结论` 这一格必须收得下第 2 态 `PASS+SUGGEST`
  //   （PRD §5.3.2 四态；旧字面 `SUGGEST` 一并收，归一到 `PASS+SUGGEST` —— 历史行还带着它）。
  //   ⚠️ `PASS\\+SUGGEST` 必须排在 `PASS` 前面，否则前缀匹配把它截成 PASS。
  const S = 'PASS\\+SUGGEST|PASS|REVIEW|BLOCK|NEEDS_INPUT|SUGGEST';
  // ★★ 2026-10-22（Paruu 真单）：**合并结论优先，且允许标签里带括号**。
  //   病灶：链写的是
  //     `**本 skill 分级结论（4A＋4B＋图文一致性合并，取更保守一侧）**：**REVIEW**`
  //   —— 括号把「结论」与「：」隔开，下面那条通用式要求「结论」**直接**跟冒号 ⇒ 返回 null
  //   ⇒ `Agent 结论` 不写 ⇒ 表行停在链写的 PASS（而卡片是 REVIEW）⇒ 同一单两个结论又出现。
  //   判据：① 先认「分级/合并/最终/综合 结论」（可带 `（…）`/`[…]` 说明，允许粗体）；
  //        ② 再回落原有的通用式（`【审查结论：X】` / `结论：X` / `状态：X` / `state=` …）。
  //   为什么合并结论优先：同一份回答里常有「4A 库侧 PASS」与「skill 合并 REVIEW」两行，
  //   表要记的是**后者**（人拿到的结论是后者）。
  const tail = '\\s*(?:（[^）]{0,80}）|\\[[^\\]]{0,80}\\])?\\s*\\**\\s*[：:]\\s*\\**\\s*`?\\s*(' + S + ')';
  // ★ 回滚开关：`SHOUHENG_CONCLUSION_MERGED=0` ⇒ 只走旧通用式（分级/合并结论不再优先）。
  //   ⚠️ 关了它就回到「括号夹在『结论』与『：』之间 ⇒ 返回 null」那个缺陷，仅用于应急回滚。
  const mergedOn = String(process.env.SHOUHENG_CONCLUSION_MERGED ?? '1').trim() !== '0';
  const merged = mergedOn
    ? s.match(new RegExp('(?:本\\s*skill\\s*)?(?:分级|合并|最终|综合)\\s*结论' + tail))
    : null;
  const m = merged || s.match(new RegExp(
    // ★ 2026-10-26：加上 PRD §5.3.4 的字面 `【REVIEW】…`（守衡现在写这个）；
    //   旧的 `【审查结论：X】` 仍然认（引擎答案、存量报告、历史表行都是它）。
    '(?:【(?:PASS\\+SUGGEST|PASS|REVIEW|BLOCK)】|【\\s*审查结论\\s*[：:]|审查结论\\s*[：:]|结论\\s*[：:]|判定\\s*[：:]'
    + '|状态\\s*[：:]|state\\s*=\\s*|引擎最终输出\\s*[：:])'
    + '\\s*\\**\\s*`?\\s*(' + S + ')'));
  if (!m) return null;
  // 旧字面归一：表里只留四态值（`PASS+SUGGEST`），不留一个与它同义的 `SUGGEST`。
  return m[1] === 'SUGGEST' ? 'PASS+SUGGEST' : m[1];
}

/** 把要写的字段拼成一行（只带**有值**的机器字段；空值不写，免得覆盖成空）。 */
export function rowFieldsOf({
  contentId, question, contentType, channel, productLine, version,
  conclusion, confidence, issueCount, summary, reportUrl, clearReportUrl = false,
} = {}) {
  // ★ 2026-10-14：**落库的正文格也要摘 markdown 符号**（Owner：「所有输出中不允许包含 `**` 星号」）。
  //   这张表就是「落库」本身，而它此前**照单全收**上游来的字符串：`问题分类汇总` 里那句
  //   `问题数量按 **0** 记` 是**我们自己的代码**拼的，`送审问题` 是模型/人给的原文 ——
  //   两条路都会把星号带进单元格，而这一格**不经过任何渲染**，星号就是字面字符。
  //   实测（2026-10-14，只读盘点）：表里 294 行中 **164 行**至少有一格带 `**`。
  //   实现只有一份：`agent/plain.mjs`（别在这里再写一遍）。
  //   ⚠️ 只摘**文本格**：数字、链接、选项、人员这些格一个都不动（它们没有 markdown 语义）。
  const f = {};
  const cell = (v) => plainify(String(v));
  if (contentId) f['内容 ID'] = contentId;
  if (question) f['送审问题'] = cell(question).slice(0, 2000);
  if (contentType) f['内容类型'] = cell(contentType).slice(0, 200);
  if (channel) f['渠道'] = cell(channel).slice(0, 200);
  // ★ 产品线（2026-10-06）：Owner 要求「从知识库命中产品线和渠道的都填写进去」。
  //   值由 `kb/l5/l0_facets.py` 出（**唯一取数点**）：**本素材自己的记录**（`品线`）优先，
  //   其次**素材原文**逐字命中受控词；命中的记录**若是规则样本则一律跳过**（不拿样本的投放属性充数）。
  //   取不到就是空 ⇒ 这里不写这一格（**不写「未指定」，也不从素材正文猜**）。
  if (productLine) f['产品线'] = cell(productLine).slice(0, 200);
  if (version) f['送审版本'] = cell(version).slice(0, 200);
  if (conclusion) f['Agent 结论'] = cell(conclusion).slice(0, 200);
  // ★ 这两个字段：调用方应已用 `machineNumbers()` 保证**永不为空**（Owner 2026-10-06 明令）。
  //   这里仍只认有限数 —— 传进来 null 就不写这一格，**不许在这里悄悄补 0**：
  //   「补 0 + 口径」是 `machineNumbers()` 的职责，两处都补会让一个 0 丢掉它的解释。
  if (Number.isFinite(confidence)) f['置信度'] = confidence;
  if (Number.isFinite(issueCount)) f['问题数量'] = issueCount;
  if (summary) f['问题分类汇总'] = cell(summary).slice(0, 20000);
  // 仅显式撤回才发 null；普通报告生成失败仍按原有语义省略此字段。
  if (clearReportUrl === true) f['报告链接'] = null;
  else if (reportUrl) f['报告链接'] = { link: String(reportUrl), text: '审查报告' };
  f['状态'] = statusOf(conclusion);
  return f;
}

/**
 * **保证这一单在表里有且只有一行。**
 *
 * @param {object} row 见 `rowFieldsOf`
 * @param {{ctx?:object, dryRun?:boolean}} [opt] `ctx` 会写进写入台账（谁改的）
 * @returns {Promise<{ok:boolean, action:'created'|'updated'|'unchanged'|'skipped',
 *                    record_id?:string, readback?:string, detail?:string}>}
 */
/**
 * 列出表里的行，**把形状读对**。
 *
 * ★ 2026-10-05 实测踩到的坑：`lark_write.listRecords()` 回的是 `{ ok, records: [...] }`，
 *   而我第一版读的是 `page.items` —— 于是**永远读到空数组**，
 *   后果是「链已经写过那一行」也看不见，**每一次都再建一行**（同一单两行）。
 *   它不报错、不抛异常，只是安静地写重。这类错正是 §2.4.1 点名的形状：
 *   接口读通了、`ok:true`，字段名读错 → 产出假数据，而假数据跟真数据长得一模一样。
 *   所以这里**两种键名都试**，都不对就明说「读不出形状」，**不许静默当空表**。
 */
async function readRows(T) {
  const page = await listRecords(T.appToken, T.table, { limit: 500 });
  if (!page?.ok) return { ok: false, detail: `列表读不到：${page?.msg ?? page?.error ?? '未知'}` };
  const rows = page.records ?? page.items;
  if (!Array.isArray(rows)) {
    return { ok: false, detail: `列表返回的形状不认：keys=${Object.keys(page ?? {}).join(',')}`
                              + ' —— 既没有 records 也没有 items' };
  }
  return { ok: true, rows };
}

/**
 * **占位符**：看起来"填了"，其实什么都没说。
 *
 * ★ 2026-10-06 实测踩到：表里那三行（09:48–09:52 那批）的 `产品线` / `渠道` 是 **`未指定`** ——
 *   不是 `rowFieldsOf` 写的（它取不到值就**不写这一格**），是**模型自己**按手册里的
 *   「缺省自动补 AUTO-…/未指定/未指定/v1.0」填进去的。
 *   而 upsert 的纪律是「**非空就不覆盖**」（那是为了不覆盖人填的）⇒
 *   **`未指定` 三个字把真值永久挡在门外**：库里明明有 `品线=吸奶器`，那一格却永远是"未指定"。
 *
 * ⇒ 判据：**占位符按"空"对待**，可以被真值替换。
 *   ⚠️ 只用于 `MACHINE_FIELDS`（机器产出的那些格）—— `HUMAN_FIELDS`（人填的）**一个都不动**，
 *     哪怕人填的就是「未指定」，那也是人的决定，不替他改。
 */
const PLACEHOLDERS = Object.freeze(new Set(['未指定', '无', '待定', '-', '—', 'N/A', 'n/a', 'null', 'None']));

/** 这一格**真的被填了**吗（占位符不算）。 */
function isFilled(v) {
  if (v === undefined || v === null || v === '') return false;
  return !PLACEHOLDERS.has(String(v).trim());
}

/**
 * **同一内容是不是已经有报告了** —— 有就返回那一份的链接，没有返回 null。
 *
 * ── 为什么需要它（2026-10-06 验证时发现，Owner 批准方案 (c)）
 *
 * 实测形状：同一份素材**复跑**时，`ensureReviewRow` 会按「内容 ID」找到**旧行**、
 * 只补空字段（其余原样保留），可是**云文档那一步已经先新建了一份新的** ⇒
 * 旧行的「报告链接」被「非空不覆盖」挡住，**新报告成了孤儿**（没人能点到的文档）。
 *
 * ── 三个候选方案与为什么选这个（Owner 选定 (c)）
 *   (a) 内容 ID 命中就当不命中 → 新建一行：**会产生重复行**，而重复行比缺行更难发现；
 *   (b) 「报告链接」随最新一次审查更新：行内会**自相矛盾**（汇总写旧审查、链接指新报告）；
 *   (c) **复用旧行已有的链接、不新建文档** ← 选它：既不产孤儿、也不产重复行，行与报告始终一致。
 *       内容 ID 是**送审文本的 sha256** ⇒ 同一 ID 就是**同一份素材**，报告逐字相同，复用语义正确。
 *
 * ── 代价（实测，不估）
 *   多一次查表：`listRecords` 读 15 行 = **1037 ms**。它发生在**回执卡之后**，
 *   不占 PRD §12 的任何一条预算（「P0 层响应 ≤1s」量的是判定，仍 ~12 ms）。
 */
export async function previousReportLink(contentId, { ctx = {} } = {}) {
  const cid = String(contentId ?? '').trim();
  if (!cid) return null;
  const T = reviewTable(ctx);
  if (!T) return null;
  const listed = await readRows(T);
  if (!listed.ok) return null;
  const row = listed.rows.find((it) => it?.fields?.['内容 ID'] === cid);
  const v = row?.fields?.['报告链接'];
  if (v === undefined || v === null || v === '') return null;
  // 形状实测两种：`{link,text:'审查报告'}` 与 `{link,text:<url>}` —— 统一从 link 取，
  // 取不到再退回 `flat()`，都取不到就当没有（**不许编**）。
  const url = (typeof v === 'object' && v && typeof v.link === 'string') ? v.link
            : String(flat(v) ?? '').match(/https?:\/\/\S+/)?.[0] ?? '';
  return /^https?:\/\//.test(url) ? url : null;
}

export async function ensureReviewRow(row, { ctx = { actor: 'shouheng/review-gate' }, dryRun = false,
                                           since = null, question = null,
                                           chainContentId = null } = {}) {
  const T = reviewTable(ctx);
  if (!T) {
    return { ok: false, action: 'skipped',
             detail: '落表被 SHOUHENG_REVIEW_TABLE=off 关掉了（自证专用闸门）—— 没写任何东西' };
  }
  const fields = rowFieldsOf(row);
  const id = fields['内容 ID'];

  // ① 先找「**这一轮刚出现的那一行**」——判据是时间窗，不是内容 ID。
  //
  //   ★ 为什么不能只靠内容 ID 去重：链给素材算的 `content_id` 是拿**它自己抽取的
  //     送审文本**算的（实测：`rt-img-02-text.txt` 196 字节 = 15 行 OCR，去掉尾部空白后
  //     sha256 前 12 位 = `48cac901ac43`），而**我们这边那份 `text` 带着我们加的标题行**
  //     （`【图片 1 的图内文字（本机 OCR）】`），两者**不是同一串字节**，算出来必然不同。
  //     拿两个不同的 ID 去「幂等」，结果是**同一个内容两行** —— 而重复行比缺行更难发现。
  //     所以判据放在**行为**上：链要是自己写了，那一行一定出现在它这次跑的这段时间窗里。
  //     时间窗优先、内容 ID 兜底，两个都不中才新建。
  //   ★ 2026-10-22：**第三把锁 = 链的 `content_id`**（`chainContentId`）——
  //     链与我们的内容 ID 算法不同（`AD-…` vs `AUTO-…`），问句也不同，前两把都可能不中；
  //     中不中就是「同一单两行、两个结论」。判据见下面 `chainCid` 那一段。
  let found = null;
  if (since) {
    try {
      const listed = await readRows(T);
      if (!listed.ok) return { ok: false, action: 'skipped', detail: listed.detail };
      const fresh = listed.rows.filter((it) => {
        const t = Number(it?.fields?.['写入时间'] ?? 0);
        return t && t >= Number(since) - 120_000;      // 2 分钟余量（表侧钟差/写入排队）
      });
      // 认哪一行：**先认问句**，认不出来地再退到「窗口里唯一那一行」。
      //   ⚠️ 两条都必须成立才敢认，否则宁可自己新建 —— 反向对照就是冲着这条来的：
      //   窗口里只有一行、但那一行是**别人的**（问句对不上）时，认了它 = 把别人的记录改掉。
      const mine = String(question ?? '').trim();
      const qOf = (it) => String(it?.fields?.['送审问题'] ?? '').trim();
      const sameQ = (a, b) => a && b && (a === b || a.includes(b) || b.includes(a));
      // ①b 链自己建的那一行：**按链的内容 ID 认**（2026-10-22 事故）。
      //   链发布用的是它自己算的 `content_id`（实测 `AD-20261022-021`），我们这边是
      //   `AUTO-<sha(送审文本)>`；问句也不同（链写的是它的审核任务）。
      //   ⇒ 问句认不出、内容 ID 兜底也认不出 ⇒ **同一张图两行、两个结论**
      //   （BM04/BM01 那一单：链行 `PASS` ／ 守衡行 `REVIEW`，同一张图两个结论对外）。
      //   机读旁挂里带着链的 `content_id`（`res.review.content_id`）—— 拿它当**第三把锁**。
      //   边界：只在**本次时间窗**里认，且必须**全等**（不猜、不模糊匹配）。
      const chainCid = String(chainContentId ?? '').trim();
      found = (mine ? fresh.find((it) => sameQ(qOf(it), mine)) : null)
           // 退路一：链那一行（内容 ID 全等）
           ?? (chainCid
                 ? fresh.find((it) => String(it?.fields?.['内容 ID'] ?? '').trim() === chainCid)
                 : null)
           // 退路二：窗口里**只有**一行，且它没写问句（链可能不写这一格）—— 那才认它
           ?? (fresh.length === 1 && !qOf(fresh[0]) ? fresh[0] : null);
    } catch (e) {
      return { ok: false, action: 'skipped', detail: `列表抛异常：${e?.message ?? e}` };
    }
  }
  // 时间窗没命中 → 再用内容 ID 找一遍（链跑得久、或它把行写在了窗口之前）
  if (!found && id) {
    try {
      const listed = await readRows(T);
      if (listed.ok) found = listed.rows.find((it) => it?.fields?.['内容 ID'] === id) ?? null;
    } catch { /* 上面那条已经报过错了，这里静默兜底 */ }
  }

  // ── ② 算 patch（**已有那一行** → 补空着的机器字段；**结论派生列允许改写**；人填过的一律不动）──
  //   ★ 2026-10-06 把这段**提到 dryRun 之前**：原来 dryRun 在算 patch 之前就 return 了，
  //     于是干跑**看不见它打算写什么** —— 那不叫干跑，那叫表个态。
  //     库规是「**干跑要能看见它要做什么**」：`--dry-run` 的意义就是让人在写之前核对。
  let patch = {};
  if (found) {
    const cur = found.fields ?? {};
    for (const k of MACHINE_FIELDS) {
      if (!(k in fields)) continue;
      // ★ `isFilled()` 而不是 `!== ''`：**占位符（未指定/无/待定…）按"空"算** ——
      //   否则模型先写进去的「未指定」会把真值永久挡住（实测：3 行卡在 `产品线=未指定`）。
      const has = isFilled(cur[k]);
      // ★ 2026-10-08（Owner 同意「推荐 B」）—— **结论派生列允许改写**，其余机器列仍只补空。
      //   `状态` 原先就在这里开过一次口子（「拒答 → 待审」必须能改过来），
      //   现在把同一理由**推广到另外四格**：多轮送审结论会变（REVIEW→BLOCK），
      //   而「只补空」会让表**定格在第一轮**、甚至把一次写错**永久钉死**（见 `CONCLUSION_DERIVED_FIELDS` 注释）。
      //   ★ 2026-10-16：判定集合从 `CONCLUSION_DERIVED_FIELDS` 换成 `OVERWRITABLE_FIELDS`
      //     （多一个 `送审问题`，理由见那个常量的注释：内部指令进了格、不覆盖就永远脏着）。
      if (has && !OVERWRITABLE_FIELDS.includes(k)) continue;
      // ══════════════════════════════════════════════════════════════════════════
      // ★★ 2026-10-15（Owner）：**`状态` 不许把人/内容方的终态改回「待审」** ────────────
      // ──────────────────────────────────────────────────────────────────────────
      //   PRD §8.2 逐字：「状态：**待审 / 已修改 / 已发布**」—— 三档里机器只拥有「待审」，
      //   另外两档是**人/内容方**的动作（§8.1：「支持内容方回复『已修改，重新提交』」）。
      //   此前 `状态` 属「总是可改写」⇒ 人把它设成「已修改／已发布」之后，**再送审一次就被改回**，
      //   等于机器悄悄撤销了人的动作。这条边界 2026-10-08 就记着「等 Owner 一句话」，现在有了。
      //   ⚠️ 只挡「人的终态」这一种：`待审` 与空值照旧可写（第一次送审必须能落上）。
      if (k === '状态' && has && HUMAN_TERMINAL_STATUS.includes(plainOf(cur[k]).trim())) continue;
      // 值没变就不写：免得把一次「什么都没变」记成一次写入（`unchanged` 被报成 `updated`）。
      if (has && sameValue(cur[k], fields[k])) continue;
      patch[k] = fields[k];
    }
  }

  if (dryRun) {
    return { ok: true, action: found ? (Object.keys(patch).length ? 'updated' : 'unchanged') : 'created',
             table_id: T.table,
             record_id: found?.record_id ?? null,
             patch,                       // ★ 干跑要能看见**它打算写什么**
             detail: `dry-run：${found
                       ? (Object.keys(patch).length
                           ? `会补这一行的 ${Object.keys(patch).length} 个空字段：${Object.keys(patch).join('、')}`
                           : '这一行的机器字段都填着了，不会写任何东西')
                       : '会新建一行'}`
                     + `${id ? `（内容 ID=${id}）` : '（算不出内容 ID，仍会新建）'}` };
  }

  if (found) {
    if (!Object.keys(patch).length) {
      return { ok: true, action: 'unchanged', table_id: T.table, record_id: found.record_id, detail: '该填的都填着了' };
    }
    const r = await updateRecords(ctx, T.appToken, T.table,
                                  [{ record_id: found.record_id, fields: patch }]);
    return { ok: !!r?.ok, action: 'updated', table_id: T.table, record_id: found.record_id,
             readback: r?.readback, detail: r?.readback_detail ?? r?.error ?? null };
  }

  // ③ 没有 → 新建。**这一条就是「每一个评审任务都必须落表」的兜底**。
  //   ★ 算不出内容 ID **也照样写**（只把那一格留空）：这条保证不能被「算 ID」绑架 ——
  //     拒答、超时、链没跑成，都还是要有一行留痕。
  const r = await createRecords(ctx, T.appToken, T.table, [fields]);
  return { ok: !!r?.ok, action: 'created', table_id: T.table, record_id: (r?.record_ids ?? [])[0] ?? null,
           readback: r?.readback, detail: r?.readback_detail ?? r?.error ?? null };
}

#!/usr/bin/env node
/**
 * re_review_reply.mjs —— **人工触发**的一次性重审：把某条历史消息按正常送审那条路重跑一遍，
 * 再把结论**引用原消息**发回去。
 *
 * ── 它为什么必须存在（2026-10-15 那次串单）
 *
 *   对接人 17:51 发图，守衡 17:56 回了一条 `REVIEW 1 处` —— 而那条 `逐字命中「ibclc」`
 *   是**同一分钟另一个并发单**（批跑在审一篇英文页面文案）的结论（旁挂被整份覆盖，
 *   三把锁全不成立却按时间口径照收）。修复之后，**已经发出去的那条错结论还在群里**，
 *   而她那张图**从没被真正审过**。
 *   ⇒ 需要一个能把这一单**重新审一遍**、并给出补正结论的入口。
 *
 * ── 为什么不能走「补发」那条路
 *
 *   `retry_queue` 的补发走 `handleMessage(event, { force: true })`，而 `force` 的语义是
 *   **「重放不重跑」**（`agent.mjs:723` 那句注释：链会真写飞书，重跑等于同一单写两遍）
 *   —— `runSubmissionGate` 见到 `force` 直接返回 `gate: null / chainRan: false`
 *   ⇒ 那条路**一次链都不会起**，拿不到库侧读数。重审要的正好相反：**必须真跑链**。
 *
 * ── 两条隔离，缺一条都跑不起来
 *
 *   ① `SHOUHENG_STATE_DIR` 指到临时区：`agent.mjs` 的去重表是**模块加载时**读的
 *      （`seen = loadSeen()`），而这条消息必然已在真去重表里 ⇒ 不隔离就只回
 *      `duplicate`、链一次都不起。（与 `batch_review_runner.mjs` 用独立会话键同一个理由：
 *      不让一次人工重跑污染日常会话的记忆与去重态。）
 *   ② `SHOUHENG_OUTBOUND_LEDGER` 指回**真台账**：这次发出去的话必须能在
 *      `PMO/logs/ws_outbound.jsonl` 里查到 —— 否则「我说过什么」在盘上又成了空白
 *      （§2.4.3 那条教训的形状：我方发出去的话永远不在入站日志里）。
 *
 * ── 形态与发送：一个字都不自己定
 *
 *   `toCardOrText`（`reply-cards/envelope.mjs`）成形 + `feishu.replyCard/markdown` 发送 +
 *   `outbound.recordSend` 留痕 —— 与 `ws_daemon.replyTo` **同一条形态链**（§2.5）。
 *   唯一差别：回执（`chain-ack`）默认**不发**（这条消息此前已经有过一条结论，
 *   再加一条「⏳ 处理中」只是噪声）；要发就显式加 `--ack`。
 *
 * ── 用法
 *
 *   node tools/re_review_reply.mjs --message-id om_xxx --dry-run   # 只跑到成形，不发
 *   node tools/re_review_reply.mjs --message-id om_xxx             # 真跑链并回复
 *   可选：--chat-id oc_xxx（不给就从事件里读）｜--ack（连回执一起发）
 *
 * 退出码：0 已跑完并已发出 ｜ 1 内核/发送失败 ｜ 2 用法错误或找不到那条事件。
 *
 * ⚠️ 它会**真起一条链**（分钟级）、**真写飞书**（云文档 + 评审表一行），
 *    并在群里**真发一条消息**。这不是干跑。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };
const MSG = val('--message-id', '');
const DRY = args.includes('--dry-run');
const ACK = args.includes('--ack');

if (!MSG) {
  console.error('用法: node tools/re_review_reply.mjs --message-id om_xxx [--chat-id oc_xxx] [--dry-run] [--ack]');
  process.exit(2);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);

// ── ★ 起链前的**预检**（2026-10-15 加：第一次真跑这个脚本就是这么翻的车）────────
//   第一次跑时，`dsh --profile headless` 在**启动那一刻**就死了 ——
//   `prepareProfile()` 要写 `~/.dsh/profiles/headless/cordis.yml`，而当时这一步
//   跑在一个**写不进那个目录**的环境里（EPERM）。链一层都没开始，内核照旧产出了一张
//   「我这侧出故障了」的卡，**还把它发进了群**，卡里带着一个它没核过的根因。
//   代价本来可以为零：**这个失败在起链前就能测出来**。
//   ⇒ 现在先探一下那个目录能不能写（探针文件当场删），写不了就**直接退**，
//     **一个字节都不发、不给内核任何side effect的机会**。
const PROFILE_DIR = path.join(os.homedir(), '.dsh', 'profiles', 'headless');
try {
  const probe = path.join(PROFILE_DIR, '.shouheng-write-probe');
  fs.writeFileSync(probe, 'probe');
  fs.unlinkSync(probe);
} catch (e) {
  console.error(`✗ 起链前的预检没过：写不进 ${PROFILE_DIR}（${e?.code ?? e?.message}）。`);
  console.error('  `dsh --profile headless` 会在启动阶段写这个目录，写不进去链就起不来 ——');
  console.error('  而链起不来时内核仍会产出一条「故障」回复（那条不该发出去）。');
  console.error('  ⇒ **本次什么都没做**：没有起链、没有落表、没有发消息。请在能写这个目录的环境里重跑。');
  process.exit(2);
}

// ── 隔离（必须在 import 之前：去重表在模块加载时读）─────────────────────────
const STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'shouheng-rereview-'));
process.env.SHOUHENG_STATE_DIR = STATE;
process.env.SHOUHENG_OUTBOUND_LEDGER = path.join(ROOT, 'PMO/logs/ws_outbound.jsonl');

const { handleMessage } = await import('./agent/agent.mjs');
const { toCardOrText } = await import('./reply-cards/envelope.mjs');
const feishu = await import('./agent/feishu.mjs');
const outbound = await import('./agent/outbound.mjs');

/** 从入站事件日志里找回那条消息 —— 同 id 可能有多条（服务端会重推），取**最后**一条。 */
function findEvent(messageId) {
  const p = path.join(ROOT, 'PMO/logs/ws_events.jsonl');
  let last = null;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (r?.data?.message?.message_id === messageId) last = r;
  }
  return last;
}

const row = findEvent(MSG);
if (!row) {
  console.error(`找不到那条入站事件：${MSG}（查的是 PMO/logs/ws_events.jsonl）`);
  process.exit(2);
}
const msg = row.data.message;
const chatId = val('--chat-id', msg.chat_id);
const chatType = msg.chat_type;

console.log(`▶ 重审 ${MSG}`);
console.log(`  会话=${chatId}（${chatType}）｜类型=${msg.message_type}｜原到站=${row.at}`);
console.log(`  状态目录=${STATE}（隔离：不污染真去重表与会话记忆）`);
console.log(`  台账=${process.env.SHOUHENG_OUTBOUND_LEDGER}`);
console.log('  ⚠️ 这一次会真起一条链（分钟级）、真写飞书，并在群里真发一条结论。');

const t0 = Date.now();
const result = await handleMessage(row.data, {
  // 回执默认不发（见文件头）；要发就走与 daemon 同一处：把卡片块交给成形层。
  notify: ACK
    ? async (text) => {
        const s = toCardOrText(text);
        const r = s.card ? await feishu.replyCard(MSG, s.card)
                         : await feishu.replyMarkdown(MSG, chatId, s.text);
        outbound.recordSend({ chatId, chatType, source: 'chain-ack', mode: r.mode ?? null,
          messageIds: r.messageIds ?? [], text: s.text, ok: r.ok, error: r.error ?? null, replyTo: MSG });
        return r;
      }
    : null,
});

console.log(`\n── 内核跑完（${Math.round((Date.now() - t0) / 1000)}s）`);
console.log(`  reason=${result.reason ?? result.meta?.reason ?? '（无）'}`);
console.log(`  闸门=${JSON.stringify(result.meta?.gate ?? null)}`);
console.log(`  链=${JSON.stringify(result.meta?.chain ?? null)}`);
console.log(`  报告=${result.meta?.reportLink ?? '（无）'}`);
console.log(`  落表=${JSON.stringify(result.meta?.publish ?? null)}`);

if (!result.reply) {
  console.error(`\n✗ 这一轮没有可回复的内容（reason=${result.reason}）—— 不发任何消息。`);
  process.exit(1);
}

// ── ★ 链没跑成 ⇒ **不发**（2026-10-15 实测加的一道闸）────────────────────────
//   第一次真跑这个脚本时，`dsh --profile headless` 因为**本机沙箱**（工作区之外
//   `~/.dsh/profiles/headless/cordis.yml` 写不进去，EPERM）而起不来，内核照旧产出了一张
//   「我这侧出故障了」的卡 —— 而那张卡里写着**它没核过的根因**（「让运维把该 profile
//   目录的写权限给到运行账号」）。群里因此多了一条既非结论、诊断又错的消息。
//   重审这一单的**唯一目的**是补上真结论；链没跑成时它没有结论可补，再发一张故障卡
//   只是噪声（而正常渠道里那张故障卡仍有它的位置 —— daemon 那条路照旧发，见 §2.4.2）。
//   要强行发就加 `--send-anystatus`。
const chainRan = result.meta?.chain?.ran === true;
if (!chainRan && !args.includes('--send-anystatus')) {
  console.error(`\n✗ 链没跑成（chain.ran=${result.meta?.chain?.ran ?? '（无）'}）—— **不发**：`
    + '重审要的是结论，链没跑成就没有结论可补正。');
  console.error(`  reason=${result.reason ?? '（无）'}｜链=${JSON.stringify(result.meta?.chain ?? null)}`);
  console.error('  （要强行走成形与发送，加 --send-anystatus）');
  process.exit(1);
}

const shaped = toCardOrText(result.reply, {
  verdict53: result.meta?.verdict53 ?? null,
  reportLink: result.meta?.reportLink ?? null,
});

console.log(`\n── 成形：${shaped.mode}${shaped.kind ? `（${shaped.kind}）` : ''}`);
for (const m of shaped.moved ?? []) console.log(`  ↪ ${m.field} → ${m.to}（${m.why}）`);
if (shaped.dropped) console.log(`  ⚠️ 卡片降级为文本：${shaped.reason}`);
console.log('---- 卡片正文 ----');
console.log(shaped.text);
console.log('------------------');

if (DRY) {
  console.log('\n（--dry-run：没有发送，也没有留痕）');
  process.exit(0);
}

// 发送：与 ws_daemon.replyTo 同一条路 —— 先试卡片（引用原消息），失败退同一条引用里的纯文本。
// ★ 不做「新发一条」的兜底：那正是 §2.5 禁止的形状（同一个回答在群里出现两次）。
let sent;
if (shaped.card) {
  const rc = await feishu.replyCard(MSG, shaped.card);
  if (rc.ok) sent = { ok: true, messageIds: [rc.messageId].filter(Boolean), mode: rc.mode };
  else {
    console.log(`  ⚠ 卡片 reply 失败（${rc.error}），退成同一条引用里的纯文本`);
    const rt = await feishu.replyMarkdown(MSG, chatId, shaped.text);
    sent = rt.ok ? { ...rt, mode: `card-failed→${rt.mode}`, error: rc.error } : rt;
  }
} else {
  const rt = await feishu.replyMarkdown(MSG, chatId, shaped.text);
  sent = rt;                         // ★ 只试一次：失败就如实报失败，**不许再发第二条**
}

const rec = outbound.recordSend({ chatId, chatType, source: 'reply', mode: sent.mode ?? null,
  messageIds: sent.messageIds ?? [], text: shaped.text, ok: sent.ok, error: sent.error ?? null, replyTo: MSG });

if (!sent.ok) {
  console.error(`\n✗ 发送失败：${sent.error}（这一单的结论没进群；台账记的是 ok=false）`);
  process.exit(1);
}
console.log(`\n✓ 已发送 ${(sent.messageIds ?? []).filter(Boolean).join(', ')}｜mode=${sent.mode}`);
console.log(rec.ok ? `  已留痕：${outbound.ledgerPath()}（source=reply，reply_to=${MSG}）`
                   : `  已留痕：⚠ 失败（${rec.error}）—— 这条消息在台账里查不到`);

#!/usr/bin/env node
/**
 * outbound_ledger.mjs —— 看/补「守衡说出去的话」那本台账（`PMO/logs/ws_outbound.jsonl`）
 *
 * 三件事，都是一次性人工触发：
 *
 * ```
 * node tools/outbound_ledger.mjs --tail 20                     # 看最近 20 条
 * node tools/outbound_ledger.mjs --backfill om_xxx [om_yyy …]  # 把修复之前发的补记进台账
 * node tools/outbound_ledger.mjs --check                       # 自检：台账读得出来吗、有几条
 * ```
 *
 * ── 为什么需要 `--backfill`
 *
 * 台账是 **2026-09-22 才有的**，而这次事故里最关键的那两句 ——
 * 14:37:55 我方问「117 条签核归谁」、15:03:11 那条更正 —— **都发生在这之前**。
 * 不补记的话，守衡的记忆里永远缺那一问，而它正是 14:39 误答的直接成因。
 *
 * 补记**只读飞书**（`GET /im/v1/messages/{id}`，`AGENTS.md` §2.6 允许读消息），
 * 拿回**原文与 `create_time`**，于是这两句的「发出时刻」从**我手抄的**变成**接口读的**。
 *
 * ⚠️ 两条纪律：
 *   ① **只补我方（`sender_type=app`）发的**。补一条别人的消息进「外发台账」，
 *      会让守衡把别人的话当成自己说过的 —— 那比漏补严重得多。
 *   ② **已经在会话记忆里的，仍要补进台账**（台账是「我们说过的全部」），
 *      但要**明说它不会改变记忆** —— 折进记忆那一步有逐字去重（`outbound.mjs`）。
 */
import * as feishu from './agent/feishu.mjs';
import * as outbound from './agent/outbound.mjs';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valueOf = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};

const ledger = outbound.ledgerPath();

if (has('--help') || has('-h') || argv.length === 0) {
  console.log(`用法：
  node tools/outbound_ledger.mjs --tail [N]              看最近 N 条（默认 20）
  node tools/outbound_ledger.mjs --backfill <id> [<id>…] 把修复之前发出的补记进台账（只补 app 发的）
  node tools/outbound_ledger.mjs --check                 自检读数
台账路径：${ledger}（可用 SHOUHENG_OUTBOUND_LEDGER 覆盖）`);
  process.exit(argv.length === 0 ? 2 : 0);
}

/* ─────────────────────────── --check ─────────────────────────── */
if (has('--check')) {
  const r = outbound.readEntries({});
  console.log(`台账：${ledger}`);
  console.log(`  存在        ${r.missing ? '❌ 还没有（一条都没发过，或从没跑过 recordSend）' : '✅'}`);
  console.log(`  可读条数    ${r.entries.length}`);
  console.log(`  读不出的行  ${r.badLines}${r.badLines ? '   ⚠ 有坏行 = 有消息查不到' : ''}`);
  console.log(`  只读了尾部  ${r.truncated ? '⚠ 是（更早的没看）' : '否'}`);
  if (r.error) console.log(`  读取失败    ❌ ${r.error}`);
  const bySource = {};
  for (const e of r.entries) bySource[e.source] = (bySource[e.source] ?? 0) + 1;
  for (const [k, v] of Object.entries(bySource).sort()) console.log(`    · ${k.padEnd(20)} ${v}`);
  const unknown = r.entries.filter((e) => String(e.source).startsWith('unknown:'));
  if (unknown.length) console.log(`  ⚠ 有 ${unknown.length} 条来源未登记（source=unknown:…）—— 有发送路径绕过了 SOURCES`);
  process.exit(r.error ? 2 : 0);
}

/* ─────────────────────────── --tail ─────────────────────────── */
if (has('--tail')) {
  const n = Number(valueOf('--tail')) || 20;
  const r = outbound.readEntries({});
  if (r.missing) {
    console.log(`台账还不存在：${ledger}`);
    console.log('（这不等于「我们没有发过话」—— 它只说明修复之后还没有人发过。见 --backfill）');
    process.exit(0);
  }
  const tail = r.entries.slice(-n);
  console.log(`台账 ${ledger}：共 ${r.entries.length} 条，读不出 ${r.badLines} 行，显示最后 ${tail.length} 条`);
  for (const e of tail) {
    const one = String(e.text ?? '').replace(/\s+/g, ' ').slice(0, 60);
    console.log(`  ${e.at}  ${String(e.source).padEnd(18)} ${String(e.chars).padStart(5)}字  ` +
                `${(e.message_ids ?? []).join('+') || '(无 id)'}  ${one}`);
  }
  process.exit(0);
}

/* ─────────────────────────── --backfill ─────────────────────────── */
const ids = argv.filter((a) => /^om_[A-Za-z0-9]+$/.test(a));
if (!ids.length) {
  console.error('没给要补记的 message_id（形如 om_xxx）。用 --help 看用法。');
  process.exit(2);
}

let written = 0, skipped = 0, failed = 0;
for (const mid of ids) {
  const m = await feishu.getMessage(mid);
  if (m?.error) { console.error(`❌ ${mid}：回读失败 —— ${m.error}`); failed++; continue; }
  if (m.senderType !== 'app') {
    console.error(`⛔ ${mid}：发送者是 ${m.senderType}（${m.from}），**不是我方发的** —— 不补进外发台账`);
    skipped++; continue;
  }
  if (!m.chatId) {
    console.error(`❌ ${mid}：回读没有带 chat_id —— 补进去也折不到任何会话，不补`);
    failed++; continue;
  }
  // ★ **解析不出来就不补**。第一版没有这一条，于是 post / interactive 类型的消息
  //   （`sendMarkdown` 发的、卡片回复 —— 也就是守衡自己发的绝大多数）
  //   会被写进一条**空正文**的台账记录，而空正文在折记忆时会被跳过：
  //   表现是「补记成功」和「什么都没补」长得一模一样（§2.4.1 第 1 行那个「0 张表」的形状）。
  if (!m.parsed || !String(m.text ?? '').trim()) {
    console.error(`❌ ${mid}：正文没解析出来（${m.parseNote ?? '解析结果为空'}）—— **不补**，`
                + `否则会写进一条空记录，看起来像补成功了`);
    failed++; continue;
  }
  const r = outbound.recordSend({
    chatId: m.chatId,
    messageIds: [mid],
    text: m.text,
    source: 'manual-backfill',
    at: m.createTime ? new Date(m.createTime).toISOString() : null,
    extra: {
      backfilled: true,
      backfilled_at: new Date().toISOString(),
      // 逐字来源写清楚：这是**从飞书回读的**，不是我手抄的
      read_back_from: `im/v1/messages/${mid}`,
      sender: m.from,
      sent_at_beijing: m.at,
      msg_type: m.msgType,
    },
  });
  if (!r.ok) { console.error(`❌ ${mid}：写台账失败 —— ${r.error}`); failed++; continue; }
  const one = m.text.replace(/\s+/g, ' ').slice(0, 50);
  console.log(`✅ 补记 ${mid}（${m.at} 北京｜${m.text.length} 字）→ chat ${m.chatId}`);
  console.log(`    ${one}`);
  written++;
}

console.log(`\n补记 ${written} 条 / 跳过 ${skipped} 条（不是我方发的）/ 失败 ${failed} 条`);
console.log('下一步：daemon 下次在这个群回话时会把它们折进会话记忆（代码已落盘，**重启后才生效**）。');
process.exit(failed ? 1 : 0);

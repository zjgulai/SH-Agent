#!/usr/bin/env node
/**
 * _dryrun_link.mjs —— 一次性干跑：把「别人发来一个飞书文档链接」这条消息喂给守衡的
 * **同一套大脑**（persona + tools + agent），看它到底怎么处理。用完即删。
 *
 * ## 为什么不直接往飞书里发一条
 *
 * 我（编码 agent）**没有「以周健的身份发消息」这条路**；而以应用身份发出去的消息
 * 不会变成 im.message.receive_v1 事件（应用收不到自己发的），所以「模拟一条用户消息」
 * 在飞书那一侧做不到。干跑走的是 `handleMessage` —— 与常驻进程**同一份代码**，
 * 而且它**只返回不发送**（发送在 ws_daemon 的 replyTo 里，见 AGENTS.md §2.5），
 * 所以这个脚本不会往任何群里发东西。
 *
 * ## 隔离（不做的就会污染真实状态）
 *
 *   1. sender open_id 用**假的** → 会话写到 sessions/dm_ou_dryrun….json，
 *      **不碰**周健那条真私聊的会话文件（那条里有守衡的全部对话记忆）；跑完删掉；
 *   2. 假的 message_id **会**被落盘到 seen-messages.json —— 我原先在这里写「不调
 *      flushSeen() 就不会落盘」，**那句话是错的**：`handleMessage` 自己在
 *      `agent.mjs:251` 调了 `flushSeen()`。所以由**本脚本**在最后把它删掉
 *      （见文件末尾的 `unsee()`）。写这条注释时我漏看了那一行，因为当时的 grep 被
 *      `head` 截断了 —— 「我采的那条通道里没有」不等于「没有」（AGENTS.md §2.4.1）。
 *
 * ## 这个干跑**测不到**什么（写出来，免得被当成全覆盖）
 *
 *   · 它不经过飞书长连接，所以「事件能不能收到」不在这里验（那是另一条链路）；
 *   · 发送者名字是假的 → 守衡会把他当未知名的人，回复里的称呼会不一样，
 *     但这不影响本次要看的那件事（它会不会先去找工作区里的副本）。
 *
 * **这个脚本保留下来**（不是一次性）：它验的是「改了 persona / tools 之后，
 * 守衡真收到一个飞书链接会怎么做」—— 这条只有真跑一次 LLM 才答得了。
 * 代价：**一次真实 LLM 调用**（实测约 50 秒），别在没必要时反复跑。
 */
import fs from 'node:fs';
import path from 'node:path';
import { handleMessage } from './agent/agent.mjs';
import { REPO_ROOT } from './agent/config.mjs';

const LINK = 'https://momcozy-in.feishu.cn/wiki/NB55wAq8liEOdKkquL2cgtPEnmg'
           + '?from=auth_notice&hash=e3dacd6f7d44293d66b7ab394eb053e0';
const CHAT_ID = 'oc_TEST_P2P';      // 真实私聊 id，只为让群信息类工具跑得起来
const FAKE_SENDER = 'ou_dryrun00000000000000000000000000';   // 假身份 → 会话文件隔离
const MSG_ID = `om_dryrun_link_${Date.now()}`;

const event = {
  message: {
    chat_id: CHAT_ID, chat_type: 'p2p',
    message_id: MSG_ID, message_type: 'text',
    content: JSON.stringify({ text: LINK }),
    create_time: String(Date.now()),
  },
  sender: { sender_id: { open_id: FAKE_SENDER }, sender_type: 'user' },
};

const t0 = Date.now();
// ★ 2026-10-05 加：**干跑不许起送审链**。
//   这个脚本的契约是「只返回不发送」，而送审闸门（`agent.mjs` 的 `runSubmissionGate`）
//   现在会**自动**把该送审的消息送进知识库那条链 —— 那条链会**真写飞书**、跑 6~30 分钟。
//   一条「干跑」把一次真实发布动作做出去了，是比结果错更坏的事。
//   所以这里显式把跑链那一步换成一个会说清楚话的桩：干跑看到的是「本该起链、干跑没起」。
const out = await handleMessage(event, {
  chainRunner: async () => ({ error: '干跑（_dryrun_link.mjs）：本该起链，但干跑不起 —— 干跑不许真写飞书' }),
});
const ms = Date.now() - t0;

console.log('═'.repeat(74));
console.log(`干跑结果 · 耗时 ${ms}ms · reason=${out.reason}`);
console.log('─'.repeat(74));
console.log(out.reply ?? '（没有回复）');
console.log('═'.repeat(74));

const key = `dm_${FAKE_SENDER}`;
const sf = path.join(REPO_ROOT, 'PMO', 'shouheng-state', 'sessions', `${key}.json`);
if (fs.existsSync(sf)) {
  const sess = JSON.parse(fs.readFileSync(sf, 'utf8'));
  const msgs = Array.isArray(sess) ? sess : (sess.messages ?? []);
  console.log('\n它调了哪些工具（按顺序）—— 这是判断它「有没有先去找副本」的直接证据：\n');
  for (const m of msgs) {
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) {
        console.log(`  → ${tc.function?.name}  ${String(tc.function?.arguments ?? '').slice(0, 200)}`);
      }
    }
    if (m.role === 'tool') {
      const s = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      console.log(`      ← ${s.slice(0, 240).replace(/\n/g, ' ⏎ ')}`);
    }
  }
  fs.unlinkSync(sf);
  console.log(`\n（干跑会话 ${key}.json 已删除；真私聊的会话文件没被碰过）`);
} else {
  console.log(`\n⚠ 没写出会话文件（${key}.json）—— 说明这条消息没走到推理那一步，本次等于未测。`);
}

/* 把假 message_id 从去重表里摘掉 —— handleMessage 会自己 flushSeen()（agent.mjs:251），
 * 所以它一定落了盘；不摘掉的话，这张表里会永久留一条从不存在的消息 id。 */
const seenFile = path.join(REPO_ROOT, 'PMO', 'shouheng-state', 'seen-messages.json');
try {
  const ids = JSON.parse(fs.readFileSync(seenFile, 'utf8'));
  const left = ids.filter((x) => x !== MSG_ID);
  if (left.length !== ids.length) {
    fs.writeFileSync(seenFile, JSON.stringify(left));
    console.log(`（去重表里的假 id 已摘掉：${ids.length} → ${left.length}）`);
  } else {
    console.log('（去重表里没有假 id —— 本次没落盘）');
  }
} catch (e) {
  console.log(`⚠ 摘除假 id 失败（${e?.message ?? e}）—— 请手工检查 ${seenFile}`);
}

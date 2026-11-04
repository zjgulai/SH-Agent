#!/usr/bin/env node
/**
 * _dryrun_capability.mjs —— 定向干跑：把**真单那条问题**喂给守衡的同一套大脑，
 * 再把它这一轮的回复过一遍**真信封**（`toCardOrText`）与**真建卡器**（`build`），
 * 检查卡面上有没有 `[object Object]`。
 *
 * ## 为什么这么写
 *
 *   `handleMessage` 的契约是「**只返回不发送**」—— 发送在 `ws_daemon` 的 `replyTo` 里。
 *   所以干跑拿到的只是模型的回复正文（含 `[[card:…]]` 块）。
 *   真正出问题的那一跳（信封 → 建卡 → 卡面）在 daemon 侧，因此这里**显式补上那一跳**：
 *   用同一个 `toCardOrText` + 同一个 `build` 把卡建出来，再逐字找 `[object Object]`。
 *   ⇒ 验的是「这条回复到了群里会长什么样」，而不是「模型写了什么」。
 *
 * ## 隔离（与 _dryrun_link.mjs 同款）
 *
 *   · 假 sender open_id ⇒ 会话写到 sessions/dm_ou_dryrun…json，跑完删掉；
 *   · 假 message_id ⇒ 会落盘到 seen-messages.json，跑完 unsee；
 *   · chainRunner 打桩 ⇒ **不起送审链**（干跑不许真写飞书）；
 *   · 全程不往任何群里发东西。
 *
 * 代价：**一次真实 LLM 调用**（实测几十秒）。用完即删。
 */
import fs from 'node:fs';
import path from 'node:path';
import { handleMessage } from './agent/agent.mjs';
import { toCardOrText } from './reply-cards/envelope.mjs';
import { build, renderText } from './reply-cards/index.mjs';
import { REPO_ROOT } from './agent/config.mjs';

const QUESTION = '你可以回答什么问题';
const CHAT_ID = 'oc_TEST_P2P';   // 真单那条私聊（只读群信息用）
const FAKE_SENDER = 'ou_dryrun00000000000000000000000000';
const MSG_ID = `om_dryrun_cap_${Date.now()}`;

const event = {
  message: {
    chat_id: CHAT_ID, chat_type: 'p2p',
    message_id: MSG_ID, message_type: 'text',
    content: JSON.stringify({ text: QUESTION }),
    create_time: String(Date.now()),
  },
  sender: { sender_id: { open_id: FAKE_SENDER }, sender_type: 'user' },
};

const t0 = Date.now();
const out = await handleMessage(event, {
  chainRunner: async () => ({ error: '干跑：本该起链，但干跑不起' }),
});
const ms = Date.now() - t0;

const reply = out.reply ?? '';
console.log('═'.repeat(74));
console.log(`干跑 · 耗时 ${ms}ms · reason=${out.reason}`);
console.log('─'.repeat(74));
console.log(reply.slice(0, 1200) || '（没有回复）');
console.log('═'.repeat(74));

// ── 过真信封 + 真建卡器（daemon 侧那一跳）──
const shaped = toCardOrText(reply);
console.log(`\n信封判定：kind=${shaped.kind ?? shaped.cardKind ?? '(无卡)'}`);
if (shaped.card) {
  const card = shaped.card;
  const text = renderText(card);
  const dumps = JSON.stringify(card) + '\n' + text;
  const n = (dumps.match(/\[object Object\]/g) || []).length;
  console.log(`卡面（降级纯文本视图）：\n${text.slice(0, 1000)}`);
  console.log(`\n★ [object Object] 出现次数 = ${n}`);
  console.log(n === 0 ? '✅ 卡面干净' : '❌ 仍然印出对象 —— 修复没生效');
} else {
  console.log('（这一轮它没选卡片，走了纯文本 —— 不影响判定，但这次没验到卡面）');
  console.log(`★ 纯文本里 [object Object] = ${(reply.match(/\[object Object\]/g) || []).length}`);
}

// ── 清场 ──
const sf = path.join(REPO_ROOT, 'PMO', 'shouheng-state', 'sessions', `dm_${FAKE_SENDER}.json`);
if (fs.existsSync(sf)) { fs.unlinkSync(sf); console.log(`\n（干跑会话已删：${path.basename(sf)}）`); }
const seenFile = path.join(REPO_ROOT, 'PMO', 'shouheng-state', 'seen-messages.json');
if (fs.existsSync(seenFile)) {
  try {
    const seen = JSON.parse(fs.readFileSync(seenFile, 'utf8'));
    const del = (o) => { if (Array.isArray(o)) return o.filter((x) => x !== MSG_ID);
      if (o && typeof o === 'object') { for (const k of Object.keys(o)) delete o[k][MSG_ID];
        for (const k of Object.keys(o)) if (!Object.keys(o[k] ?? {}).length) delete o[k]; return o; }
      return o; };
    fs.writeFileSync(seenFile, JSON.stringify(del(seen)));
    console.log('（假 message_id 已从 seen-messages 摘掉）');
  } catch { /* 摘不掉就算了，不吞掉主结论 */ }
}

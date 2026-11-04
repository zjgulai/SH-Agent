#!/usr/bin/env node
/**
 * send_once.mjs —— 以守衡的名义，往测试群手发一条纯文本。**人工触发**，不是常驻链路。
 *
 * ── 2026-09-22 改了什么，为什么要改
 *
 * 原先这个文件自己 `new Lark.Client(...)` + `client.im.message.create(...)`，
 * 然后 `console.log('已发送:', message_id)` —— **就这些**。它发出去的话
 * （T7① 那一问、15:03 那条更正）在盘上**没有任何痕迹**：时刻是我手抄的，
 * 那个 `message_id` 也没有任何检查器在读（`待收清单` 的 `kind:message` 查的是
 * **入站**事件日志，实测 0 命中）。
 *
 * 后果不是抽象的 —— 14:39 那次误答的直接成因之一，就是**她自己 14:37:55 问过什么
 * 在盘上无从判起**。所以现在这条命令做两件事，缺一件都不算修好：
 *
 *   ① **走 `agent/feishu.mjs`**（全仓唯一的发送物理层）—— 自己建客户端 = 自己一条通道，
 *      而「同一个形状有两个实现」正是 `AGENTS.md` §2.5 禁止的形状；
 *   ② **记台账**（`agent/outbound.mjs`，`source=manual`）—— daemon 下次回话前
 *      会把这条折进会话记忆，于是**守衡记得这句话是自己说的**。
 *
 * 用法：
 *   node tools/send_once.mjs "正文"                # 发到默认测试群
 *   SHOUHENG_CHAT_ID=oc_xxx node tools/send_once.mjs "正文"
 *
 * 退出码：0 已发且已留痕 ｜ 1 发送失败 ｜ 2 用法错误。
 * ⚠️ **留痕失败但发送成功时退 0，并在 stdout 上明写「已留痕: ⚠ 失败」** ——
 *    不静默、也不必重发（重发会在群里多出一条话）。
 */
import * as feishu from './agent/feishu.mjs';
import * as outbound from './agent/outbound.mjs';

const CHAT = process.env.SHOUHENG_CHAT_ID || 'oc_TEST_GROUP';
const text = process.argv.slice(2).join(' ');

if (!text.trim()) {
  console.error('用法: node tools/send_once.mjs "<正文>"');
  process.exit(2);
}

const r = await feishu.sendMarkdown(CHAT, text);
const rec = outbound.recordSend({
  chatId: CHAT,
  messageIds: r.messageIds ?? [],
  text,
  source: 'manual',
  mode: r.mode ?? null,
  ok: r.ok,
  error: r.error ?? null,
});

if (!r.ok) {
  console.error('发送失败:', r.error);
  process.exit(1);
}

console.log('已发送:', (r.messageIds ?? []).filter(Boolean).join(', '));
console.log(rec.ok ? `已留痕: ${outbound.ledgerPath()}（source=manual）`
                   : `已留痕: ⚠ 失败（${rec.error}）—— 这条消息在台账里查不到`);

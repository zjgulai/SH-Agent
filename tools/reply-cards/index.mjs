/**
 * index.mjs —— 卡片模版的公共出口 + 发送（带降级）
 *
 * 发送这件事只有一条硬规则：**卡片发不出去时不许不答。**
 * 降级链是 卡片 → 纯文本，且降级后要在正文末尾注明原因 ——
 * 对方看到格式变了，得知道是为什么，而不是以为守衡改风格了。
 */
import { client, sendMarkdown } from '../agent/feishu.mjs';
import {
  REGISTRY, BY_KIND, BUILDERS, BUILDER_SOURCE_NAME,
  build, validateCard, renderText, shapeOf, sampleCards, lintCopy,
  TONE, TEMPLATES, BACKGROUND_STYLES, band,
} from './registry.mjs';

export {
  build, validateCard, renderText, shapeOf, sampleCards, lintCopy,
  REGISTRY, BY_KIND, BUILDERS, BUILDER_SOURCE_NAME,
  // J9 段（配色不撞车 + 底色闭集）要拿它们喂样本，所以从这里转出去。
  TONE, TEMPLATES, BACKGROUND_STYLES, band,
};

/**
 * 发一张卡到会话。
 * @returns {Promise<{ok:boolean, mode:string, messageId?:string, error?:string, text:string}>}
 */
export async function sendCard(chatId, kind, data) {
  const card = build(kind, data);
  const text = renderText(card);
  try {
    const r = await client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(card) },
    });
    return { ok: true, mode: 'card', messageId: r?.data?.message_id ?? null, text };
  } catch (e) {
    const d = e?.response?.data;
    const why = d
      ? `卡片被拒 code=${d.code} ${String(d.msg ?? '').slice(0, 120)}`
      : `卡片发送异常 ${e?.message ?? e}`;
    // 降级：走 `feishu.sendMarkdown` —— 它自带 `chunkText`（`MAX_TEXT_LEN = 8000`）。
    //
    // ★ 2026-09-22 改。这里原先自己 `client.im.message.create` 发一条 **text**，
    //   于是**完全绕开切块**：同一段超长文本走 `replyMarkdown` 会被切块，
    //   走这条路会被服务端按单条超限拒掉 → `ok:false` → 上层再兜一次。
    //   「几个字算超长」这件事当时有三份答案（诊断 #14 · 债务【6-3】）。
    //   现在只有一份：切块口径在 `agent/feishu.mjs` 里，别处不许自己拼。
    const r2 = await sendMarkdown(chatId, renderText(card, why));
    if (r2.ok) return { ok: true, mode: 'text-fallback', messageId: r2.messageIds?.[0] ?? null, error: why, text };
    return { ok: false, mode: 'none', error: `${why} ／ 降级也失败：${r2.error ?? ''}`, text };
  }
}

/*
 * ★ 这里原先还有一个 `export async function replyCard(messageId, chatId, kind, data)`，
 *   失败时自己 `await sendCard(...)` **新发一条** —— 正是 `AGENTS.md` §2.5 第二条
 *   （「发送兜底只能有一处」）禁止的形状；而且它与 `agent/feishu.mjs` 的 `replyCard`
 *   **同名同形**，而 `verify_cards.mjs` 的 L2 段只扫后者，所以它从来没被扫到。
 *   后果不是「今天会重复投递」（零消费者），是**库里留着一份会重复投递的实现**，
 *   下一个人 import 它就会踩上 —— 一个潜伏的、且检查器结构性看不见的违规。
 *
 *   2026-09-22 删除。删之前先证明零消费者（§「先证明再删除」）：
 *     grep -rn "replyCard" tools/ --include=*.mjs
 *       → 除本文件自己的定义外，只有 `agent/feishu.mjs` 的同名实现（那是合规的那份）
 *         与 `ws_daemon.mjs:128` 对它的调用；`cli.mjs` 用的是 `sendCard`。
 *   而 L2b 段现在是**唯一性**断言：全仓导出 `replyCard` 的文件必须恰好一个，
 *   多一个、少一个都红 —— 所以它不会悄悄长回来。
 */

/** 供 agent 决策用的一行清单（塞进提示词） */
export function menuForPrompt() {
  return REGISTRY.map((r) => `- \`${r.kind}\`（${r.zh}）：${r.when.split('反例')[0].trim()}`).join('\n');
}

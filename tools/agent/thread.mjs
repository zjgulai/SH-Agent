/**
 * thread.mjs —— 「这条消息在回复哪一句」（纯函数：无网络、无凭据、无副作用）
 *
 * ── 为什么单独一个文件
 *
 * 这些判据必须能被**离线**反证。而 `agent.mjs` / `feishu.mjs` 一 import 就
 * `new Lark.Client(...)`（要读 `~/.dsh/credentials/shouheng-lark.json`）——
 * 判据长在它们里面，验证这件事就变成「先得有网络和凭据」。
 * 所以这里**没有任何 import**，只有函数；网络那一半在 `feishu.getMessage()`。
 * 断言在 `tools/verify_reply_context.py`。
 *
 * ── 它修的是哪一次事故（2026-09-22）
 *
 * 对接人 14:39:34 用**话题回复**答了守衡 14:37:55 那一问（正文「归我」），
 * 事件的 `parent_id` 与 `root_id` **都指着我方那条消息** ——
 * **飞书把线索完整送来了**，而 `ws_daemon.mjs` 的 `onMessage` 从不读这两个字段
 * （全 `tools/` 扫 `parent_id|root_id` 只命中 `kb_build.py` 的知识库父子记录）。
 *
 * 于是守衡看到一句悬空的「归我」，往上接到 **27 小时前**的话题上，
 * 在 14:39:51 答成了「那三条过期内容归你」并发了出去 —— **答非所问，且答得很确定**，
 * 还替业务方派了一个本不存在的活。15:03:11 已发出更正。
 *
 * 全过程、两条根因、只读探针与回读核对：`PMO/守衡-误答登记-20260922.md`。
 */

/** 去掉全部空白再比 —— 与 `verify_pending.py` 的 `_squash` 同一口径。 */
function squash(s) {
  return String(s ?? '').replace(/\s+/g, '');
}

/**
 * 这条消息在回复哪一条？回 `message_id`，或 `null`（表示「没有可引的上文」）。
 *
 * ★ 为什么优先 `parent_id` 而不是 `root_id`：
 *   飞书的话题回复里，`root_id` 是**整个话题的根**，`parent_id` 是**直接回复的那一条**。
 *   我们要的是「她这句话接的是哪一句」，也就是直接父级。
 *   ⚠️ 她在 14:39:34 那一条里两者**恰好同值**（话题只有两层），所以这次哪个都对 ——
 *   **别把这次的巧合当成两者等价**，`root_id` 只作退路。
 *
 * 回 `null` 的四种情形，每一种都必须与「有上文」长得不一样：
 *   ① 没有 `parent_id` / `root_id`（不是回复）
 *   ② 两者都是空串
 *   ③ 指向自己（`=== msg.message_id`）—— 不能自己引用自己，否则死循环
 *   ④ 不是非空字符串
 */
export function parentIdOf(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const self = msg.message_id;
  for (const cand of [msg.parent_id, msg.root_id]) {
    if (typeof cand !== 'string') continue;
    const id = cand.trim();
    if (!id) continue;
    if (self && id === self) continue;
    return id;
  }
  return null;
}

/**
 * 这一段正文**是不是已经在会话历史里**了？在 → 不必再引一次。
 *
 * ⚠️ **两个方向的代价不对称，判据必须往"宁可重复"那边倒**：
 *   · 假阴性（该跳过却引了）→ 模型多看一遍上文，冗余，无害
 *   · 假阳性（该引却跳过）  → **模型看不见自己在答哪一句 —— 就是本次事故本身**
 *   所以只在**对得上**时才回 true，对不上一律引。
 *
 * 匹配用**边界**而不是包含：群里的用户轮存成 `【名字】正文`，私聊存成 `正文`。
 * 用 `includes` 是错的 —— 父消息「归我」是很多长消息的子串，
 * 那会让「已经在了」这一半大面积误判。
 */
export function alreadyInHistory(messages, text, scan = 40) {
  const sq = squash(text);
  if (!sq) return true;                       // 没有正文 → 没什么可引的
  if (!Array.isArray(messages)) return false;
  return messages.slice(-scan).some((m) => {
    const c = squash(m?.content);
    if (!c) return false;
    if (m.role === 'user') return c === sq || c.endsWith('】' + sq);
    if (m.role === 'assistant') return c === sq || c.startsWith(sq);
    return false;                             // 工具结果不算「上文」，它不进模型的上文位
  });
}

/** 引用块的长度上限（字符）。超了就截断并**明说截断了** —— 不许假装这是全文。 */
export const QUOTE_MAX_CHARS = 1200;

/**
 * 拼「引用上文」块。回 `null` 表示没什么可引 —— 由调用方决定这时怎么办。
 *
 * 形状是刻意做重的：它要在一堆对话历史里**一眼看出这不是新的一轮对话，
 * 而是"对方正在回答的那一句"**。太像普通历史，模型就会当普通历史用。
 */
export function buildQuoteBlock({ from, text, at, maxChars = QUOTE_MAX_CHARS }) {
  const body = String(text ?? '');
  if (!body.trim()) return null;

  const cut = body.length > maxChars;
  const shown = cut ? body.slice(0, maxChars) : body;

  return [
    '〔引用上文〕发这条消息的人，是在回复下面这一条。',
    // ★ 这一句 2026-09-22 改过一次，别照旧读。原先写的是
    //   「它不在你的对话记忆里（**主动推送不经过回复循环**，见 …）」——
    //   那句在当天是对的，而当天晚些时候 `agent/outbound.mjs` 把主动推送**折进了会话记忆**
    //   （§5.4），于是「不在记忆里」的**原因**变了：现在走到这一行的，是
    //   「折过了/本来就不是我方发的/早于记忆窗口」这三种，而不是「推送不经过回复循环」。
    //   一句话里写着一个**已经不成立的机制**，比不写更坏 —— 下一个人会照着它去别处找原因。
    '它不在你的对话记忆里（可能是别人发的、早于记忆窗口，或不是我们这个会话里的），所以逐字放在这里：',
    `· 发信人：${from || '(未知)'}${at ? `｜${at}` : ''}`,
    '· 正文：',
    shown,
    ...(cut ? [`（原文共 ${body.length} 字，上面截到 ${maxChars} 字 —— 这是截断，不是全文。）`] : []),
    '〔引用上文结束〕',
  ].join('\n');
}

/** 只给测试与日志用：这一条事件能不能引上文、引哪一条。 */
export function describeThread(msg) {
  const id = parentIdOf(msg);
  return { hasParent: Boolean(id), parentId: id };
}

/**
 * ghost_guard.mjs —— 幽灵实例抢单巡检、旧版废话撤回与自动接管补审
 *
 * ── 为什么要有它（2026-10-27 01:19:41 真实生产事故）────────────────────────────
 *
 * Owner 在主群 `oc_TEST_GROUP` 发送图文 `@守衡 审核`
 * （`om_x100b62ccf41118a4df6eba728eee2ca`），1 秒后（01:19:42）群里立刻出现一条
 * 应用自身（`cli_aa2243de0438dcd7`）发出的旧版回复（`om_x100b62ccf42638a8de103bb1e3f9f87`）：
 *   `这条是「post」，它的正文我读不了 —— 需要的话请把它转成文字发我。`
 *
 * 物理证据链：
 *   1. 本机 `PMO/logs/ws_events.jsonl` 在 01:19:41 没有任何入站记录；
 *   2. 本机 `PMO/logs/feishu_sends.jsonl` 与 `ws_outbound.jsonl` 均无 `om_x100b62ccf42638a8de103bb1e3f9f87`；
 *   3. 飞书 WebSocket 机制在同一个 `app_id` 存在多个长连接客户端时，会将单条群事件
 *      随机分发给其中一个连接。远端残留的旧版幽灵实例抢走了该事件并秒回旧版拒读文案，
 *      而本机新版实例根本没收到该 WebSocket 推送。
 *
 * ── 本模块做的两件事（纯函数判据 + 执行器）────────────────────────────────────
 *
 *   ① **自动撤回幽灵废话**：识别本应用发出的旧版拒读话术
 *      （`它的正文我读不了 —— 需要的话请把它转成文字发我`）及旧版 5 分钟超时提示
 *      （`【⏳ 还在跑】这一单已经跑了 5 分钟，慢在知识库比对那一步`），调用
 *      `feishu.recallMessage(message_id)` 直接从群里撤回，消除用户侧干扰。
 *   ② **自动接管被抢走的 `@守衡` 消息**：识别最近窗口内群里 `@守衡` 的用户消息，
 *      若不在本机 `hasSeenMessage(message_id)` 中，将其转换为标准 `im.message.receive_v1`
 *      事件结构交由本机 `onMessage` 完整走完 84 秒多模态审查链路。
 */
import * as feishu from './feishu.mjs';
import { config } from './config.mjs';

/** 幽灵实例发出的旧版废话特征正则（仅匹配已被本仓彻底废弃的旧版文案） */
export const GHOST_REPLY_RE =
  /它的正文我读不了\s*——\s*需要的话请把它转成文字发我|【⏳\s*还在跑】这一单已经跑了\s*\d+\s*分钟，慢在知识库比对那一步/;

/** 只接管最近 10 分钟内的未处理 @守衡 消息，避免重启或历史回扫时拉起陈旧消息 */
export const GHOST_TAKEOVER_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * 判断一条飞书 `im.message.list` 返回的原始消息项是否是幽灵实例发出的旧版废话。
 *
 * @param {object} item 飞书消息项
 * @param {string} [appId] 当前应用 app_id
 * @returns {boolean}
 */
export function isGhostBotReplyItem(item, appId = config.lark.appId) {
  if (!item || item.deleted) return false;
  const isSelfApp = item.sender?.sender_type === 'app'
    && (!appId || !item.sender?.id || item.sender.id === appId);
  if (!isSelfApp) return false;
  const parsed = feishu.bodyToText(item.msg_type, item.body?.content ?? '{}');
  const text = parsed?.text ?? '';
  return GHOST_REPLY_RE.test(text);
}

/**
 * 判断一条飞书 `im.message.list` 返回的原始消息项是否「@ 了守衡」。
 *
 * @param {object} item 飞书消息项
 * @param {string} [botName] 机器人名称
 * @param {string} [appId] 当前应用 app_id
 * @returns {boolean}
 */
export function isItemMentioningBot(item, botName = feishu.BOT_NAME, appId = config.lark.appId) {
  if (!item || item.deleted) return false;
  if (item.sender?.sender_type !== 'user') return false;
  const mentions = Array.isArray(item.mentions) ? item.mentions : [];
  for (const m of mentions) {
    const idRaw = m?.id;
    const openId = typeof idRaw === 'object' && idRaw !== null ? (idRaw.open_id ?? '') : String(idRaw ?? '');
    if (m?.name === botName || (appId && openId === appId)) return true;
  }
  // 富文本 post 有时在 body.content 的 at 节点里写 user_name="守衡"
  const rawContent = String(item.body?.content ?? '');
  if (rawContent.includes(`"user_name":"${botName}"`)) return true;
  return false;
}

/**
 * 把 `im.message.list` 的单条消息项转换成 `im.message.receive_v1` 事件载荷，
 * 以便直接交给 `ws_daemon.mjs` 的 `onMessage(event)` 处理。
 *
 * @param {object} item 飞书 `im.message.list` 单条消息
 * @returns {object} 标准 `im.message.receive_v1` data 对象
 */
export function listItemToReceiveEvent(item) {
  const mentions = (Array.isArray(item?.mentions) ? item.mentions : []).map((m) => {
    const idVal = m?.id;
    const idObj = typeof idVal === 'object' && idVal !== null
      ? idVal
      : { open_id: String(idVal ?? '') };
    return {
      key: m?.key ?? '@_user_1',
      id: idObj,
      name: m?.name ?? feishu.BOT_NAME,
      tenant_key: m?.tenant_key ?? item?.sender?.tenant_key ?? '',
    };
  });

  const senderOpenId = item?.sender?.id ?? '';
  return {
    sender: {
      sender_id: { open_id: senderOpenId },
      sender_type: item?.sender?.sender_type ?? 'user',
      tenant_key: item?.sender?.tenant_key ?? '',
    },
    message: {
      message_id: item?.message_id ?? '',
      root_id: item?.root_id ?? undefined,
      parent_id: item?.parent_id ?? undefined,
      create_time: String(item?.create_time ?? Date.now()),
      update_time: String(item?.update_time ?? item?.create_time ?? Date.now()),
      chat_id: item?.chat_id ?? '',
      chat_type: item?.chat_type === 'p2p' ? 'p2p' : 'group',
      message_type: item?.msg_type ?? 'text',
      content: item?.body?.content ?? '{}',
      mentions,
    },
  };
}

/**
 * 纯函数：从群最近消息列表里规划需要「撤回的幽灵回复」和「接管补审的入站消息」。
 *
 * @param {Array<object>} items 按时间倒序或正序排列的飞书消息项
 * @param {object} opts
 * @param {(id:string)=>boolean} opts.hasSeen 本机是否已见过某条 message_id
 * @param {Set<string>} [opts.recalledIds] 本进程已撤回过的幽灵消息 id 集合
 * @param {number} [opts.nowMs] 当前毫秒时间戳
 * @param {number} [opts.maxAgeMs] 接管消息的最大年龄（毫秒）
 * @param {number} [opts.minAgeMs] 接管消息的最小年龄（毫秒，给正常 WS 推送留出到达窗口）
 * @returns {{toRecall: Array<object>, toTakeover: Array<object>}}
 */
export function planGhostActions(items = [], {
  hasSeen = () => false,
  recalledIds = new Set(),
  nowMs = Date.now(),
  maxAgeMs = GHOST_TAKEOVER_MAX_AGE_MS,
  minAgeMs = 2500,
} = {}) {
  const toRecall = [];
  const toTakeover = [];
  if (!Array.isArray(items)) return { toRecall, toTakeover };

  // 按时间正序处理，确保先发的消息先接管
  const sorted = [...items].sort((a, b) => Number(a?.create_time ?? 0) - Number(b?.create_time ?? 0));

  for (const it of sorted) {
    const mid = it?.message_id;
    if (!mid || it?.deleted) continue;

    if (isGhostBotReplyItem(it)) {
      if (!recalledIds.has(mid)) {
        toRecall.push(it);
      }
      continue;
    }

    if (isItemMentioningBot(it)) {
      if (hasSeen(mid)) continue;
      const createMs = Number(it.create_time ?? 0);
      if (!Number.isFinite(createMs) || createMs <= 0) continue;
      const ageMs = nowMs - createMs;
      // 刚发出不到 2.5s 的消息可能正在正常 WS 路上，先不抢；超过 10 分钟的陈旧历史也不翻旧账
      if (ageMs >= minAgeMs && ageMs <= maxAgeMs) {
        toTakeover.push(it);
      }
    }
  }

  return { toRecall, toTakeover };
}

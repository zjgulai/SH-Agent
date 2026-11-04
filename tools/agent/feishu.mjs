/**
 * feishu.mjs —— 飞书侧能力封装
 *
 * 两个关键转换在这里：
 *   1. mention 还原：飞书把 @ 渲染成 `@_user_N` 占位符，LLM 读到的是乱码。
 *      必须对照 message.mentions 还原成真名，否则守衡不知道谁在跟它说话。
 *   2. markdown → 飞书富文本(post)：LLM 天然输出 markdown，直接塞给飞书会显示成一堆星号。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Lark from '@larksuiteoapi/node-sdk';
import { config, LOG_DIR } from './config.mjs';
import { beijingString } from './timefmt.mjs';
import { plainifyForSend } from './plain.mjs';
import { deadlineHttpInstance } from './review_deadline.mjs';

export const client = new Lark.Client({
  appId: config.lark.appId,
  appSecret: config.lark.appSecret,
  httpInstance: deadlineHttpInstance(Lark.defaultHttpInstance),
  // ★ loggerLevel 显式降到 warn。
  // 默认是 info，SDK 会在构造时往 **stdout** 打一行 `[info]: [ 'client ready' ]`。
  // 后果不是刷屏，是**把 stdout 弄脏**：任何 `node xxx.mjs --json | 下一步` 的管道
  // 都会拿到一段不是 JSON 的开头。2026-09-18 实测：
  // `cli.mjs sample receipt --json | cli.mjs validate -` 因此报「不是合法 JSON」。
  // 守衡自己的日志走 ws_daemon 的 log()，不依赖 SDK 这一行。
  loggerLevel: Lark.LoggerLevel.warn,
});

/** 机器人显示名（名字匹配用）。集中定义，避免多处硬编码写成不一致的字面量 */
export const BOT_NAME = '守衡';

/* ══════════════════ 物理层留痕：这条消息**是谁发的** ══════════════════
 *
 * ── 为什么要有它（2026-10-26 一次真实排查卡在这里）────────────────────────
 *
 * Owner 报「同一张图私聊读得到、群里 @守衡 读不到」，而群里那条回复逐字是
 * 「这条是「post」，它的正文我读不了 —— 需要的话请把它转成文字发我。」
 *
 * 排查时能确证的事实只有一半：**守护进程没有发过那条** ——
 * 它每一次外发都记台账（`ws_daemon.replyTo()` 里唯一的出口），而那条消息
 * 在 `PMO/logs/ws_daemon.log` 与 `PMO/logs/ws_outbound.jsonl`（2126 条）里**一条都没有**。
 * 另一半（**那是谁发的**）当时**答不出来** —— 本机所有 DSH 会话、第二个 launchd 作业、
 * 第二个 ws_daemon 进程都排除了，然后就**没有下一处可查了**。
 *
 * ── 为什么不在 `outbound.mjs` 的台账里补这一跳 ────────────────────────────
 *
 * 那张台账的 `source` **不只是标签，它决定这句话折不折进守衡的会话记忆**
 * （`SOURCES` × `FOLDING`/`NON_FOLDING`）。台账的登记表里那几条 `records: None`
 * 的理由逐字写着这件事：探针卡 / 卡片 CLI / 自检样本发的是**样例**，
 * 进台账反而会污染守衡的记忆（它会以为自己对外说过那些话）。
 * 让「物理层」默认往台账里记，就会把这三类一起记进去 —— 那是把一个
 * **归因问题**修成了一个**记忆污染问题**。
 *
 * ⇒ 所以分成两份，各自只管一件事：
 *   · `PMO/logs/ws_outbound.jsonl`（`outbound.recordSend`）——**业务台账**：
 *     谁发的、算什么性质、折不折记忆。**一个字没动**；
 *   · `PMO/logs/feishu_sends.jsonl`（本函数）——**物理留痕**：
 *     每一条**真的打到飞书**的消息一行，带 `caller`（哪个文件哪一行调下来的）
 *     与 `pid`。**没有任何代码读它来做决策**，所以它不会变成第二份真相；
 *     它只回答一件事：**这条消息是哪个进程、哪一行代码发的**。
 *
 * ── 为什么挂在 client 上，而不是挂在四个发送函数上 ────────────────────────
 *
 * 因为发送出口不止 `feishu.mjs` 那四个。全仓**七个**文件自己拿 `client`
 * 直连 `im.message.create/reply`（探针卡 ×3、卡片 CLI、批跑器、ws_test…），
 * 而它们**全都** `import { client } from './agent/feishu.mjs'` —— 只有这一个 client。
 * 挂在函数上就漏掉一半出口，而漏掉的那一半正好是「没人登记的」那一半。
 */
export function tracePath() {
  return process.env.SHOUHENG_SEND_TRACE
    ? path.resolve(process.env.SHOUHENG_SEND_TRACE)
    : path.join(LOG_DIR, 'feishu_sends.jsonl');
}

/**
 * 从调用栈里认出**真正的调用方**（`文件:行`）。
 *
 * ⚠️ 必须**跳过本文件自己的帧**：`replyMarkdown` 内部会调 `sendMarkdown`（两者都在 feishu.mjs），
 *   不跳的话每一条都会归因到 `feishu.mjs:xxx` —— 那等于没归因（这次排查缺的正是这一格）。
 *   一路跳到本文件之外的第一帧，才是「谁发的」。
 */
export function callerOf(stack) {
  for (const line of String(stack ?? '').split('\n').slice(1)) {
    const m = line.match(/\(?([^()\s]+):(\d+):(\d+)\)?\s*$/);
    if (!m) continue;
    const file = m[1];
    if (file.endsWith('/agent/feishu.mjs') || file.includes('node:internal')) continue;
    return `${path.basename(file)}:${m[2]}`;
  }
  return '(未能定位调用方)';
}

/**
 * 给一个 client 的 `im.message.*` 打上留痕。**返回真的被打上的方法名数组** ——
 * 判据用它来核「接线真的发生了」，而不是只核源码里出现过这个名字（§2.4）。
 *
 * 契约（与 `recordSend` 同一条纪律）：**留痕写不进去也必须把消息发出去** ——
 * 所以全程 try/catch，绝不让它影响发送；发送本身抛错时**照旧抛出去**（只是多记一行 `ok:false`）。
 */
export function installSendTrace(target = client, { methods = ['create', 'reply', 'forward'] } = {}) {
  const installed = [];
  const holder = target?.im?.message;
  if (!holder) return installed;
  for (const name of methods) {
    const orig = holder[name];
    if (typeof orig !== 'function') continue;
    // 幂等：重复装一次就会**同一条消息记两行**（而两行看起来都像真的）。
    if (orig.__shouhengSendTrace) { installed.push(name); continue; }
    const wrapper = async (...args) => {
      const payload = args[0] ?? {};
      let res = null;
      let err = null;
      try {
        res = await orig.apply(holder, args);
        return res;
      } catch (e) {
        err = e;
        throw e;
      } finally {
        notePhysicalSend({ method: name, payload, res, err });
      }
    };
    // ★ 打标记：判据靠它核「现在挂在真 client 上的这个函数**就是**留痕层」
    //   （只核源码里出现过 `installSendTrace` 是不够的 —— 名字出现过 ≠ 它拦得住）。
    wrapper.__shouhengSendTrace = name;
    holder[name] = wrapper;
    installed.push(name);
  }
  return installed;
}

/** 一条**真的打到飞书**的消息 —— 追加一行。不抛。 */
function notePhysicalSend({ method, payload, res, err }) {
  try {
    const data = payload?.data ?? {};
    let head = null;
    try {
      const parsed = bodyToText(data.msg_type, data.content);
      head = parsed?.text ? String(parsed.text).replace(/\s+/g, ' ').slice(0, 120) : null;
    } catch { /* 正文读不出来不影响归因：caller + message_id 已经够定位 */ }
    const rec = {
      at: new Date().toISOString(),
      method,
      ok: !err,
      message_id: res?.data?.message_id ?? null,
      chat_id: data.receive_id ?? res?.data?.chat_id ?? null,
      reply_to: payload?.path?.message_id ?? null,
      msg_type: data.msg_type ?? null,
      chars: typeof data.content === 'string' ? data.content.length : null,
      text_head: head,
      pid: process.pid,
      // ★ 这一格就是这次事故缺的东西：「这条是谁发的」= 哪个文件哪一行。
      caller: callerOf(new Error().stack),
      error: err ? `code=${err?.response?.data?.code ?? '-'} msg=${err?.response?.data?.msg ?? err.message}` : null,
    };
    const f = tracePath();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, JSON.stringify(rec) + '\n');
  } catch { /* 见上面契约：留痕失败不许影响发送 */ }
}

/** 模块加载时就装好（真 client）—— `send_trace.test.mjs` 会核「真的装上了」。 */
export const SEND_TRACE_METHODS = installSendTrace();

/* ─────────────────────────── mention 还原 ─────────────────────────── */

/**
 * 把消息里的 `@_user_N` 占位符还原成真实姓名。
 * @param {string} text  原始文本，含占位符
 * @param {Array}  mentions  飞书 message.mentions 数组
 * @returns {{display:string, mentions:Array<{key:string,name:string,openId:string,isBot:boolean,tenantKey?:string}>}}
 */
export function resolveMentions(text, mentions = []) {
  const resolved = (mentions ?? []).map((m) => {
    // id 字段在飞书不同事件版本里有三种形态：字符串、{open_id}、{union_id}。
    // 只认 open_id 是不安全的 —— 拿不到时会静默变成空字符串，
    // 后面「按 open_id 找发送者姓名」就永远匹配不上，且不报错。
    const idRaw = m.id;
    const openId  = typeof idRaw === 'object' && idRaw !== null ? (idRaw.open_id ?? '') : (idRaw ?? '');
    const unionId = typeof idRaw === 'object' && idRaw !== null ? (idRaw.union_id ?? '') : '';
    const userId  = typeof idRaw === 'object' && idRaw !== null ? (idRaw.user_id ?? '') : '';
    return {
      key:    m.key ?? '',
      name:   m.name ?? '(未知)',
      openId, unionId, userId,
      // 三者都没有时留原始值，便于排查而不是丢信息
      rawId:  openId || unionId || userId || (typeof idRaw === 'string' ? idRaw : JSON.stringify(idRaw ?? null)),
      isBot:  openId === config.lark.appId || m.name === BOT_NAME,
      tenantKey: m.tenant_key,
    };
  });

  let display = text ?? '';
  for (const m of resolved) {
    if (!m.key) continue;
    // 占位符在文本里就是 @_user_1 这个字面量，全局替换成 @真名
    display = display.split(m.key).join(`@${m.name}`);
  }
  return { display, mentions: resolved };
}

/**
 * 这条消息是否 @ 了守衡？
 * 双判据：open_id 等于自己的 app_id（权威），或显示名等于机器人名。
 * 只用 open_id 会有风险 —— 某些事件形态下 open_id 拿不到；只用名字也有风险（重名）。
 */
export function isBotMentioned(resolvedMentions = []) {
  return resolvedMentions.some((m) => m.isBot);
}

/**
 * 去掉 @守衡 本身，留下真正的问题。
 * 群聊里用户习惯写「@守衡 帮我查下 X」，模型不需要看到那个 @守衡。
 */
export function stripBotMention(display, resolvedMentions = []) {
  let out = display;
  for (const m of resolvedMentions.filter((x) => x.isBot)) {
    out = out.split(`@${m.name}`).join('');
  }
  // 清掉多余的空白，但保留换行结构
  return out.split('\n').map((l) => l.replace(/[ \t]{2,}/g, ' ').trim()).join('\n').trim();
}

/* ───────────────────── markdown → 飞书富文本(post) ───────────────────── */

/**
 * 极简 markdown → 飞书 post 节点转换。
 * 支持：``` 代码块 ```、**粗体**、`行内代码`、普通段落。
 * 不做完整 markdown 解析 —— 只覆盖 LLM 实际会用的那几种，够用且不会有惊喜。
 */
function mdToPostNodes(markdown) {
  const lines = String(markdown ?? '').split('\n');
  const paragraphs = [];
  let codeBuf = null;   // 非 null 表示正在收集代码块

  const inlineToNodes = (s) => {
    const nodes = [];
    const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
    let last = 0, m;
    while ((m = re.exec(s)) !== null) {
      if (m.index > last) nodes.push({ tag: 'text', text: s.slice(last, m.index) });
      const tok = m[0];
      if (tok.startsWith('**')) nodes.push({ tag: 'text', text: tok.slice(2, -2), style: ['bold'] });
      else                      nodes.push({ tag: 'text', text: tok.slice(1, -1), style: ['code_inline'] });
      last = m.index + tok.length;
    }
    if (last < s.length) nodes.push({ tag: 'text', text: s.slice(last) });
    return nodes.length ? nodes : [{ tag: 'text', text: ' ' }];
  };

  for (const raw of lines) {
    const fence = raw.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      if (codeBuf === null) {
        codeBuf = { lang: fence[1] || 'text', lines: [] };       // 进入代码块
      } else {
        paragraphs.push([{ tag: 'code_block', language: codeBuf.lang, text: codeBuf.lines.join('\n') }]);
        codeBuf = null;                                          // 离开代码块
      }
      continue;
    }
    if (codeBuf !== null) { codeBuf.lines.push(raw); continue; }  // 代码块内的行原样收集
    paragraphs.push(inlineToNodes(raw));
  }
  if (codeBuf !== null) {  // 未闭合的代码块也要发出去，不能吞内容
    paragraphs.push([{ tag: 'code_block', language: codeBuf.lang || 'text', text: codeBuf.lines.join('\n') }]);
  }
  return paragraphs;
}

/** 测试出口：让 test_agent.mjs 能单独验证转换逻辑，不必真发消息 */
export const __test_mdToPostNodes = mdToPostNodes;
export const __test_chunkText = chunkText;

/* ─────────────────────────── 发送 ─────────────────────────── */

const MAX_TEXT_LEN = 8000;   // 飞书文本消息安全上限

/* ─────────────── 读回正文：post / interactive 也要读得出来 ─────────────── */

/**
 * ★ 2026-09-22 新增。**在它之前，守衡读自己的历史是瞎的。**
 *
 * 实测（当天 15:35 拿真实群历史跑了一遍 `listRecentMessages`）：
 *
 * ```
 * 2026-09-18 12:40:20 interactive 守衡(你自己)  （interactive 类型，正文为空 —— 我没法看到里面的内容。）
 * 2026-09-22 14:39:52 interactive 守衡(你自己)  （interactive 类型，正文为空 —— 我没法看到里面的内容。）
 * 2026-09-22 15:32:16 post        守衡(你自己)  （post 类型，正文为空 —— 我没法看到里面的内容。）
 * ```
 *
 * 而**内容就在 payload 里** —— 那条 post 的 `body.content` 逐字是
 * `{"title":"","content":[[{"tag":"text","text":"我这边调用模型失败了，没法回答这个问题。"}],…]}`。
 * 我们只是按 `JSON.parse(content).text` 去读了，而 post / interactive **没有 `text` 这个字段**。
 *
 * 这是 §2.4.1 的**第 4 行**（否定结论比输入大）：工具说的是「**我读不了**」，
 * 真相是「**我没去读对地方**」。后果与 14:39 那次误答同源 ——
 * `sendMarkdown` 发的都是 **post**、卡片回复都是 **interactive**，
 * 于是**守衡读群历史时看不见自己说过的绝大多数话**，只看得见 `send_once.mjs`
 * 手发的那几条 `text`。它问「我先前说过什么」时，答案是结构性地缺的。
 *
 * 判据在 `tools/verify_outbound.py` 的 **G 段**：拿这几条**真实 payload** 做回归。
 */

/**
 * post 的 content JSON → **段落数组**（`[[node,…],…]`）。读不出来回 `null`。
 *
 * ★★ 2026-10-26 加（一次真实的「私聊读得到、群里读不到」）：
 *   Owner 报「同一张图私聊能读、群里 @守衡 读不到」，现场那条回复逐字是
 *   「这条是「post」，它的正文我读不了 —— 需要的话请把它转成文字发我。」
 *
 *   查下来**解析器对实测载荷是对的**（群里 `[[img],[at,text]]` 那种形状 3 次全读通，
 *   见 `PMO/logs/ws_daemon.log` 07:33/07:35 与 `ws_events.jsonl`），
 *   但这条兜底话术本身有一个**结构性漏洞**：只要段落不是「数组套数组」，
 *   正文与图片会**同时**读成空，于是守衡对一条明明带图的消息说「正文我读不了」——
 *   也就是说 **它把自己的解析失败说成了对方的格式问题**（§2.4.1 那个病）。
 *
 *   飞书的 post 在**回读接口 / 不同客户端**上至少还有两种真实形状，原先都不认：
 *     ① 带语种外层：`{"zh_cn":{"title":"","content":[[…]]}}`（发消息 API 的写法，
 *        经 `im/v1/messages` 回读或转发时会出现）；
 *     ② 段落是对象：`{"content":[{"elements":[{…}]},…]}`。
 *   两种形状的共同点：**顶层的 `content` 不是段落数组** ⇒ 旧代码两边都读成空。
 *
 *   现在把「段落在哪」收成**一个函数**，正文（`postToPlain`）与图片（`imageKeysOf`）
 *   都从它取 —— 分成两份的下场是「正文读到了、图没读到」这种半对半错，
 *   而它看起来像一条正常的拒答。
 */
export function postBlocksOf(d) {
  if (!d || typeof d !== 'object') return null;
  const pick = (v) => (Array.isArray(v) ? v : null);
  // ① 实测主形状：顶层就是段落数组（`content` 与 `content_v2` 实测同值，取第一个可用的）
  let blocks = pick(d.content) ?? pick(d.content_v2);
  // ② 带语种外层：随便哪个 `xx_yy` 键下面挂着 `{title, content}`
  if (!blocks) {
    for (const [k, v] of Object.entries(d)) {
      if (!/^[a-z]{2}_[a-z]{2}$/i.test(k) || !v || typeof v !== 'object') continue;
      blocks = pick(v.content) ?? pick(v.content_v2);
      if (blocks) break;
    }
  }
  if (!blocks) return null;
  // ③ 段落是对象、节点在 `elements` 里 ⇒ 摊平成「数组套数组」（**只摊这一层**，不猜别的键）
  return blocks.map((p) => {
    if (Array.isArray(p)) return p;
    if (p && typeof p === 'object' && Array.isArray(p.elements)) return p.elements;
    return p;
  });
}

/** post（富文本）的 content JSON → 纯文本。读不出来回 `null`（**不是空串**）。 */
export function postToPlain(contentJson) {
  let d;
  try { d = JSON.parse(contentJson ?? '{}'); } catch { return null; }
  const blocks = postBlocksOf(d);
  if (!blocks) return null;
  const lines = [];
  for (const para of blocks) {
    if (!Array.isArray(para)) continue;
    lines.push(para.map((n) => {
      const tag = n?.tag;
      if (tag === 'a') {
        // A label is not the address. Keep both so a named document link can
        // reach the same readability/review routing as a pasted bare URL.
        const label = n.text ?? '';
        const href = n.href ?? '';
        // The next rich-text node need not start with a space. Delimit the URL
        // so adjacent Chinese text cannot become part of its path/query.
        return href ? `${label && label !== href ? `${label} ` : ''}${href} ` : label;
      }
      if (tag === 'at') return `@${n.user_name ?? n.user_id ?? ''}`;
      if (tag === 'img') return '[图片]';
      if (tag === 'media') return '[媒体]';
      return typeof n?.text === 'string' ? n.text : '';
    }).join(''));
  }
  return lines.join('\n');
}

/**
 * 卡片（interactive）的 JSON → 文字**重建**。回 `{title, lines, stub}`。
 *
 * ⚠️ **实测（2026-09-22，拿 14:39:52 那张真卡跑了一遍）**：`im/v1/messages` 对 interactive
 * 消息**不返回卡片正文**，只回一句占位：
 *
 * ```json
 * {"title":"已收到","elements":[[{"tag":"img",…},{"tag":"text","text":"请升级至最新版本客户端，以查看内容"}]]}
 * ```
 *
 * 所以「卡片读得回来」是**假的**。能读到的只有**标题**（上面这个是「已收到」）。
 * 这一条必须写进返回值，否则 `bodyToText` 会把那句占位文案当成卡片内容交出去 ——
 * 那比原先的「我看不到」更坏：**它看起来像内容**。
 */
function cardToPlain(contentJson) {
  let d;
  try { d = JSON.parse(contentJson ?? '{}'); } catch { return { title: null, lines: [], stub: false, bad: true }; }
  if (!d || typeof d !== 'object') return { title: null, lines: [], stub: false, bad: true };

  const lines = [];
  const seen = new Set();
  const walk = (node) => {
    if (node == null) return;
    if (Array.isArray(node)) { for (const x of node) walk(x); return; }
    if (typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'string' && (k === 'text' || k === 'content')) {
        if (v.trim() && !seen.has(v)) { seen.add(v); lines.push(v); }
        continue;
      }
      if (v && typeof v === 'object') walk(v);
    }
  };
  walk(d);

  const title = typeof d.title === 'string' ? d.title
              : (typeof d?.header?.title?.content === 'string' ? d.header.title.content : null);
  const stub = lines.some((s) => /请升级至最新版本客户端/.test(s));
  return { title, lines: lines.filter((s) => !/请升级至最新版本客户端/.test(s)), stub, bad: false };
}

/**
 * 把一条消息的 `body.content` 读成**人话**。两个读取入口（`getMessage` / `listRecentMessages`）
 * 都走这里 —— 两处各写一份解析，就是「同一个形状有两个实现」，
 * 而这两份一定会漂移（一份修了另一份没修，表现是「有时候读得到有时候读不到」）。
 *
 * @returns {{text:string|null, parsed:boolean, note?:string}}
 *   `text` 为 `null` 表示**没解析出内容**（`note` 说明是哪种没解析出来）——
 *   与「解析出来是空的」必须分得开（§2.4.1 第 1 行那个「0 张表」）。
 */
export function bodyToText(msgType, contentJson) {
  if (msgType === 'text') {
    let t = null;
    try { t = JSON.parse(contentJson ?? '{}').text ?? null; } catch { t = null; }
    if (typeof t === 'string') return { text: t, parsed: true };
    return { text: null, parsed: false, note: 'text 类型但解析不出 `.text` 字段' };
  }
  if (msgType === 'post') {
    const t = postToPlain(contentJson);
    if (t !== null) return { text: t, parsed: true };
    return { text: null, parsed: false, note: 'post 类型但 `content` / `content_v2` 都不是段落数组' };
  }
  if (msgType === 'interactive') {
    const c = cardToPlain(contentJson);
    const title = c.title ? `「${c.title}」` : '（连标题都没有）';
    if (c.bad) return { text: null, parsed: false, note: 'interactive 类型但卡片 JSON 解析失败' };
    if (c.stub) {
      // ★ 接口只回占位文案 —— 这是**通道的盲区**，不是「我懒得读」。
      //   照实说：读不到正文；能读到的只有标题。别把占位文案当内容交出去。
      return { text: null, parsed: false,
               note: `卡片正文这个接口不返回（只回一句「请升级至最新版本客户端」占位），`
                   + `能读到的只有标题${title}。卡片说了什么，只有发它的那一方（会话记忆 / 外发台账）知道` };
    }
    if (c.lines.length) {
      // ⚠️ 必须说清这是**重建**：卡片存的是结构，不是一段正文。
      //    把重建结果当成逐字原文去引用，就是另一种「比依据大」。
      return { text: `（卡片文字按结构还原，非逐字原文${c.title ? `；标题${title}` : ''}）\n${c.lines.join('\n')}`,
               parsed: true };
    }
    return { text: null, parsed: false, note: `interactive 类型但卡片 JSON 里没抽到文字（标题${title}）` };
  }
  return { text: null, parsed: false, note: `${msgType ?? '未知'} 类型没有正文读取通道` };
}

/* ─────────── 图片 / 视频：哪几个、字节怎么取（§2.6 窄豁免的**唯一**调用点） ─────────── */

/**
 * ★ 2026-10-05 开的一条**窄豁免**（`AGENTS.md` §2.6 第 1 条，Owner 现场确认选项 A）。
 *
 * 事实经过：10-05 06:37 Owner私聊发了一条**图文混排**的消息问「评审下下这个图片，能过吗？」。
 * 守衡 14ms 回了一句「这条是「post」，它的正文我读不了」——
 * 那句话对**正文**是错的（正文就在 payload 里，见 `postToPlain`），
 * 对**图片**则是照旧按红线不取。她要做的事（评审图片）因此没有一条走得通的路。
 *
 * 豁免的形状**故意只有一条**，写成代码就是这个调用点（`fetchMessageResource`）：
 *   · 只取**人当前发给守衡的这条消息**里的**图片**（`messageResource.get` + `type:'image'`）；
 *   · 取回来只写**系统临时目录**，交给 `vision.mjs` 做完 OCR 就地删除；
 *   · **不归档、不进知识库、不转发第三方**；群历史里的图、云文档、多维表格**一律照旧不取**。
 *
 * ★ 2026-10-05 晚些时候**加宽了一次，形状没变**（Owner 现场确认）：
 *   起因是委托方另外两条要求「发视频必须打通」—— 而视频的字节通道与图片是同一条，
 *   于是 `media` / `file` 里的**视频**被并进同一条豁免：同一个调用点、同样只写临时目录、
 *   同样用完即删；抽帧 OCR 与语音转写全在本机做完（见 `video.mjs`）。
 *   **没有松的**（一个字没动）：`file` 里的**非视频附件**（xlsx / pdf / docx…）、
 *   群历史里的一切、云文档、多维表格、Drive 的 `download` 与 `medias/` 两个端点。
 *   「是视频」这个判断在**取字节之前**就要做出来（看 `file_name` 后缀），
 *   不许「先取回来再看看是不是视频」—— 那等于把附件也拉进来了。
 *
 * 这条豁免有执行点，不是一句注释：
 *   · `tools/verify_feishu_index.py` 的 M6/M7/M10（全仓唯一调用点 + `type` 只许闭集里的值）
 *   · `tools/test_agent.mjs` 第 13 组（行为级：非视频附件一次都不许取）、
 *     第 16/17 组（视频那条：抽帧 + 转写 + 引用的那条 + 不许翻历史）
 */

/** `messageResource.get` 的 `type` **只许这两个值** —— 闭集写在这里，M7 断言的就是它。 */
export const RESOURCE_TYPES = Object.freeze(['image', 'file']);

/** 「这是个视频文件」的判据：**只看名字后缀**（取字节之前就要判出来，见上面的头注）。 */
const VIDEO_EXT = /\.(mp4|mov|m4v|avi|webm|mkv|3gp)$/i;

/** 这条消息里带了哪几张图。**只认 post 与 image 两种形态；附件一律回空数组。** */
export function imageKeysOf(msgType, contentJson) {
  let d = null;
  try { d = JSON.parse(contentJson ?? '{}'); } catch { return []; }
  if (!d || typeof d !== 'object') return [];

  if (msgType === 'image') {
    // 单图消息：`{"image_key":"img_v3_..."}`
    return d.image_key ? [{ imageKey: String(d.image_key), width: d.width ?? null, height: d.height ?? null }] : [];
  }
  if (msgType === 'post') {
    // ★ 2026-10-26：与 `postToPlain` **共用** `postBlocksOf` —— 两处各写一份的后果
    //   就是「正文读到了、图没读到」：守衡会说「你这条里没图」而图就在正文那句
    //   `[图片]` 标记的位置上（那条回复看起来完全像一个正常回答）。
    const blocks = postBlocksOf(d) ?? [];
    const out = [];
    for (const para of blocks) {
      if (!Array.isArray(para)) continue;
      for (const n of para) {
        if (n?.tag === 'img' && n.image_key) {
          out.push({ imageKey: String(n.image_key), width: n.width ?? null, height: n.height ?? null });
        }
      }
    }
    return out;
  }
  // file / media / audio / sticker / 其它：**零**。
  // 图这条支路只认 image 与 post；视频走 `videoKeysOf`，两条支路**不共用**返回值 ——
  // 混在一起的话，「这段字节是图还是视频」就没人说得清了。
  return [];
}

/**
 * 这条消息里带了哪几个**视频**。
 *
 * 判据（取字节**之前**就要定下来）：
 *   · `msg_type === 'media'` —— 飞书的视频消息，载荷本身就是视频；
 *   · `msg_type === 'file'` **且文件名后缀是视频** —— 实测委托方发的视频就是这一种
 *     （`file_v3_00166_…` + `momcozy-…-hero-1080p.mp4`，见 `PMO/logs/ws_events.jsonl` 10-05 09:22）。
 *     ⚠️ 加这个后缀判断是**必须的**：`file` 里同样会来 xlsx / pdf，那些**不在豁免里**。
 *   · 其余（`audio` / `sticker` / `post` 里的视频节点…）**一律回空数组**。
 */
export function videoKeysOf(msgType, contentJson) {
  let d = null;
  try { d = JSON.parse(contentJson ?? '{}'); } catch { return []; }
  if (!d || typeof d !== 'object') return [];

  const one = (fileKey, extra = {}) => (fileKey
    ? [{ fileKey: String(fileKey), fileName: extra.fileName ?? null,
         durationMs: extra.durationMs ?? null, coverKey: extra.coverKey ?? null }]
    : []);

  if (msgType === 'media') {
    return one(d.file_key, { fileName: d.file_name ?? null, durationMs: d.duration ?? null,
                             coverKey: d.image_key ?? null });
  }
  if (msgType === 'file') {
    const name = String(d.file_name ?? '');
    if (!VIDEO_EXT.test(name)) return [];   // ← 非视频附件在这里就被挡掉，且**一次网络都不发**
    return one(d.file_key, { fileName: name });
  }
  return [];
}

/**
 * 取一条消息里的**图片或视频**字节，写到系统临时目录，回路径与清理函数。
 *
 * ★ 这是全仓**唯一**一处从飞书取字节的调用点。要再加一处，先改 `AGENTS.md` §2.6 与 M 段断言。
 *
 * 契约（调用方必须照做）：
 *   · 拿到 `path` 就趁早用，用完**必须**调 `cleanup()`（`agent.mjs` 放在 `finally` 里）；
 *   · `error` 不为空时 `path` 一定是 `null` —— 「取不到」与「取到空的」不许混。
 */
async function fetchMessageResource(messageId, fileKey, { type, dir = null, ext = '.bin', tag = 'res' } = {}) {
  const nothing = () => { /* 没取到东西，没什么可清理 */ };
  if (!RESOURCE_TYPES.includes(type)) {
    // 闭集之外的类型一律不发请求 —— 这道判断本身就是豁免的边界。
    return { path: null, bytes: 0, error: `type=${type} 不在豁免闭集 ${RESOURCE_TYPES.join('/')} 里`, cleanup: nothing };
  }
  if (!messageId || !fileKey) {
    return { path: null, bytes: 0, error: `缺少 message_id 或 ${tag}_key`, cleanup: nothing };
  }
  // 现场建临时目录（优先用调用方给的，测试用）——**绝不写进仓库**：
  // 字节一旦落进 REPO_ROOT，就等于把它归档了，那已经越过这条豁免。
  let tmpDir = dir;
  let ownDir = false;
  try {
    if (!tmpDir) {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `shouheng-${tag}-`));
      ownDir = true;
    } else {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
  } catch (e) {
    return { path: null, bytes: 0, error: `临时目录建不出来：${e.message}`, cleanup: nothing };
  }
  // 文件名用 file_key 做个可读前缀（排查时能对上飞书那条消息），后面加随机数防撞。
  const safeKey = String(fileKey).replace(/[^\w.-]/g, '').slice(-40) || tag;
  const filePath = path.join(tmpDir, `${safeKey}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}${ext}`);
  const cleanup = () => {
    try { fs.rmSync(filePath, { force: true }); } catch { /* 删不掉不该影响这一次回话 */ }
    if (ownDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 同上 */ } }
  };

  try {
    const r = await client.im.messageResource.get({
      path: { message_id: messageId, file_key: fileKey },
      // ★ `type` 只能取闭集里的值。这一行是豁免的边界本身：
      //   别的值（例如 audio）就等于把别的附件也拉进来了，那不在 Owner 同意的那一条里。
      params: { type },
    });
    if (typeof r?.writeFile !== 'function') {
      return { path: null, bytes: 0, error: 'SDK 没回 writeFile（接口形状变了，没取到字节）', cleanup };
    }
      await r.writeFile(filePath);
    const bytes = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
    if (!bytes) return { path: null, bytes: 0, error: '取回来是 0 字节', cleanup };
    // ★ 2026-10-26：若扩展名是 `.img`，按文件头魔数改成真实的图片扩展名（`.jpg` / `.png` / `.webp` / `.gif`）。
    //   原因：DSH Headless 的 `read_image` 工具只认标准图片扩展名，`.img` 会直接报错，
    //   逼得链内子代理每次多跑 2~3 步 `file` + `cp xxx.img /tmp/view.jpg`（白耗 15~25 秒）。
    let finalPath = filePath;
    if (ext === '.img') {
      try {
        const fd = fs.openSync(filePath, 'r');
        const b = Buffer.alloc(12);
        fs.readSync(fd, b, 0, 12, 0);
        fs.closeSync(fd);
        let realExt = '';
        if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) realExt = '.jpg';
        else if (b[0] === 0x89 && b.slice(1, 4).toString('latin1') === 'PNG') realExt = '.png';
        else if (b.slice(0, 3).toString('latin1') === 'GIF') realExt = '.gif';
        else if (b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP') realExt = '.webp';
        if (realExt) {
          const renamed = filePath.slice(0, -ext.length) + realExt;
          fs.renameSync(filePath, renamed);
          finalPath = renamed;
        }
      } catch { /* 重命名失败保留原路径 */ }
    }
    const finalCleanup = () => {
      try { fs.rmSync(finalPath, { force: true }); } catch {}
      if (finalPath !== filePath) { try { fs.rmSync(filePath, { force: true }); } catch {} }
      if (ownDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} }
    };
    return { path: finalPath, bytes, error: null, cleanup: finalCleanup };
  } catch (e) {
    // 已知会走到这里的：应用缺 `im:resource` 权限、消息不在本应用可见范围、超 100MB。
    // 照实报，别把它说成「图上没有字」。
    cleanup();
    const code = e?.response?.data?.code;
    const msg = e?.response?.data?.msg ?? e.message;
    const what = type === 'image' ? '取图' : '取视频';
    return { path: null, bytes: 0, error: `${what}失败 code=${code ?? '(无)'} msg=${msg}`, cleanup: nothing };
  }
}

/** 取图片字节（`type:'image'`）。见上面那条窄豁免。 */
export function fetchMessageImage(messageId, imageKey, { dir = null } = {}) {
  return fetchMessageResource(messageId, imageKey, { type: 'image', dir, ext: '.img', tag: 'img' });
}

/**
 * 取视频字节（`type:'file'`）—— 与图片**同一条窄豁免**，同一次 Owner 确认（2026-10-05）。
 * ★ 只在 `videoKeysOf` 已经判定「这是个视频」之后才调它。
 */
export function fetchMessageVideo(messageId, fileKey, { dir = null, ext = '.mp4' } = {}) {
  return fetchMessageResource(messageId, fileKey, { type: 'file', dir, ext, tag: 'vid' });
}

/** 超长文本切块（优先在换行处切，避免把句子劈开） */
function chunkText(text, size = MAX_TEXT_LEN) {
  const out = [];
  let rest = String(text);
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size * 0.5) cut = size;      // 找不到合适换行就硬切
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * 发送 markdown 消息到指定会话。
 * 先尝试富文本（保留代码块与粗体），失败则退化为纯文本。
 * @returns {Promise<{ok:boolean, messageIds:string[], mode:string, error?:string}>}
 */
export async function sendMarkdown(chatId, markdown) {
  const chunks = chunkText(markdown);
  const messageIds = [];
  let mode = 'post';

  for (const chunk of chunks) {
    // 1) 尝试富文本
    try {
      const r = await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'post',
          content: JSON.stringify({ zh_cn: { title: '', content: mdToPostNodes(chunk) } }),
        },
      });
      messageIds.push(r?.data?.message_id);
      continue;
    } catch (e) {
      const code = e?.response?.data?.code;
      mode = 'text';
      // 富文本失败（常见：内容里有飞书不认的节点），落回纯文本。
      // ★ 2026-10-14：**落回纯文本时要把 markdown 符号摘掉** —— 见 `plain.mjs` 的头注：
      //   飞书 text 会把 `**` **原样显示**，于是这条兜底会把「一次发送失败」
      //   放大成「群里出现一堆星号」。摘符号放在这里，而不是让调用方各自记得摘。
      const { text: safe, before } = plainifyForSend(chunk, { where: `sendMarkdown 降级(${code})` });
      if (before > 0) console.log(`[plain] · 降级正文原带 ${before} 个星号`);
      try {
        const r2 = await client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: safe }) },
        });
        messageIds.push(r2?.data?.message_id);
      } catch (e2) {
        return { ok: false, messageIds, mode, error: `post code=${code} / text code=${e2?.response?.data?.code} msg=${e2?.response?.data?.msg ?? e2.message}` };
      }
    }
  }
  return { ok: true, messageIds, mode };
}

/**
 * 回复某条消息（形成引用关系，群里更清楚在答谁）。
 * 失败时自动退化为普通发送，保证「答不上」不会变成「不答」。
 *
 * ★★ 2026-10-14 重写（Owner 拿私聊截图来问的那一条）：
 *   **原先这条路把 markdown 原文塞进 `msg_type: 'text'`，一个字都不转**
 *   ⇒ `**能查的我查完再说**` 在私聊里就是一堆星号。
 *   而「回复」恰恰是最常走的一条（引用关系更清楚），于是**最常走的路最脏**。
 *
 * 现在两处都改：① 回复本体走 **富文本(post)**，与 `sendMarkdown` 同一个转换器
 *   （`mdToPostNodes`，**不是**新写一份 —— 那是本项目栽过的「两份实现各自漂移」）；
 *   ② 富文本这条路不通时，兜底文本**先摘符号**再发（`plainifyForSend`）。
 *   ⇒ 无论走哪条路，发出去的正文里都不会再有字面星号。
 */
export async function replyMarkdown(messageId, chatId, markdown) {
  const text = chunkText(markdown)[0];   // 回复只发首块，其余走 sendMarkdown 补发
  try {
    const r = await client.im.message.reply({
      path: { message_id: messageId },
      data: { msg_type: 'post', content: JSON.stringify({ zh_cn: { title: '', content: mdToPostNodes(text) } }) },
    });
    if (markdown.length > text.length) {
      const rest = await sendMarkdown(chatId, markdown.slice(text.length).replace(/^\n+/, ''));
      return { ok: true, messageIds: [r?.data?.message_id, ...rest.messageIds], mode: 'reply+send' };
    }
    return { ok: true, messageIds: [r?.data?.message_id], mode: 'reply' };
  } catch (e) {
    // 富文本回复失败（含「飞书不认 post 形态」这种）→ 纯文本回复，但**摘掉符号**。
    const code = e?.response?.data?.code;
    const { text: safe } = plainifyForSend(text, { where: `replyMarkdown 降级(post code=${code})` });
    try {
      const r2 = await client.im.message.reply({
        path: { message_id: messageId },
        data: { msg_type: 'text', content: JSON.stringify({ text: safe }) },
      });
      if (markdown.length > text.length) {
        const rest = await sendMarkdown(chatId, markdown.slice(text.length).replace(/^\n+/, ''));
        return { ok: true, messageIds: [r2?.data?.message_id, ...rest.messageIds], mode: 'reply-text+send' };
      }
      return { ok: true, messageIds: [r2?.data?.message_id], mode: 'reply-text',
               error: `post reply code=${code}` };
    } catch (e2) {
      const fallback = await sendMarkdown(chatId, markdown);
      return { ...fallback, mode: `reply-failed→${fallback.mode}`, error: `reply code=${e2?.response?.data?.code}` };
    }
  }
}

/**
 * 回复某条消息，内容是一张卡片（msg_type=interactive）。
 *
 * 为什么单独一个函数、不复用 replyCard（reply-cards/index.mjs 里那个）：
 * 那个版本失败时自己会去 sendCard 兜底，而 daemon 需要的是
 * 「reply 失败 → 由调用方决定退成什么」。两处兜底叠加的后果是
 * 同一个回答在群里出现两次。所以这一层**只做一次尝试**，失败如实返回。
 *
 * @returns {Promise<{ok:boolean, messageId?:string, mode:string, error?:string}>}
 */
export async function replyCard(messageId, card) {
  try {
    const r = await client.im.message.reply({
      path: { message_id: messageId },
      data: { msg_type: 'interactive', content: JSON.stringify(card) },
    });
    return { ok: true, messageId: r?.data?.message_id ?? null, mode: 'reply-card' };
  } catch (e) {
    const d = e?.response?.data;
    return { ok: false, mode: 'reply-card-failed',
             error: d ? `code=${d.code} ${String(d.msg ?? '').slice(0, 140)}` : String(e?.message ?? e) };
  }
}

/** 发一条「正在处理」提示，返回其 message_id 以便后续撤回或更新 */
export async function sendTyping(chatId, text = '（守衡正在处理…）') {
  try {
    // 同样摘符号：这条虽然默认文案干净，但**调用方可以传别的文案** ——
    // 出站纪律按**出口**守，不按「现在是干净的」守。
    const { text: safe } = plainifyForSend(text, { where: 'sendTyping' });
    const r = await client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: safe }) },
    });
    return r?.data?.message_id ?? null;
  } catch { return null; }
}

/** 撤回消息（用于清掉「正在处理」提示） */
export async function recallMessage(messageId) {
  if (!messageId) return false;
  try { await client.im.message.delete({ path: { message_id: messageId } }); return true; }
  catch { return false; }
}

/* ─────────────────────────── 读取 ─────────────────────────── */

/** 把群历史里的发送者 open_id 解析成姓名 */
function buildSenderMap(members) {
  const m = new Map();
  for (const u of members ?? []) {
    if (u?.openId && u?.name) m.set(u.openId, u.name);
  }
  return m;
}/**
 * 给一条群历史消息判定「谁发的」。
 *
 * 为什么必须有这个函数：群历史接口**是**返回 sender.id 的（群内发送者都有值，
 * 实测 5/5 条都有），但上层工具曾经把它丢掉、一律显示「用户」，
 * 于是守衡看到 7 条用户消息全是「用户」，据此**误判成「我不知道是谁发的」**。
 * 数据一直都在，是我们在中间丢的 —— 这类「不是能力不足、是自己扔了信息」的
 * 缺陷最难发现，因为守衡会给出一个听上去很合理的「我查不到」。
 *
 * 原则：宁可显示 open_id，也不显示「用户」这种无法区分人的占位符。
 */
export function resolveSender(msg, senderMap) {
  if (msg?.senderType === 'app') return { from: `${BOT_NAME}(你自己)`, senderOpenId: msg.senderId ?? null };
  if (msg?.senderType !== 'user') return { from: String(msg?.senderType ?? '未知'), senderOpenId: msg.senderId ?? null };

  const id = msg.senderId;
  if (!id) return { from: '用户(接口未返回发送者身份)', senderOpenId: null };

  const name = senderMap?.get(id);
  return name
    ? { from: name, senderOpenId: id }                        // 姓名是确定的，直接用
    : { from: `用户(${id})`, senderOpenId: id };              // 退而求其次：open_id 仍可用于比对
}

/** 拉取群最近消息，作为上下文补充 */
export async function listRecentMessages(chatId, pageSize = 20, memberMap = null) {
  try {
    const r = await client.im.message.list({
      params: { container_id_type: 'chat', container_id: chatId, sort_type: 'ByCreateTimeDesc', page_size: pageSize },
    });
    // 没传成员表就自己拉一份：消息列表能否辨认发送者，不该取决于调用方是否记得多传一个参数。
    // 注意 listMembers 返回的是**数组**；曾经这里写成 `?.members`，
    // 于是 map 永远为空、姓名永远解析不出来，而 `?? {}` / `?.` 让这件事完全没有声音。
    // 取错形状必须吵出来，不能静默降级 —— 那正是这个文件里反复出现的病根。
    let map = memberMap;
    if (!map) {
      const members = await listMembers(chatId);
      if (!Array.isArray(members)) {
        console.warn(`[feishu] listMembers 返回的不是数组（${typeof members}），本次无法解析发送者姓名`);
        map = new Map();
      } else {
        map = buildSenderMap(members);
      }
    }
    const items = r?.data?.items ?? [];
    const out = items.map((it) => {
      // ★ 2026-09-22：改走 `bodyToText`。原先这里只认 `JSON.parse(content).text`，
      //   而 **post（`sendMarkdown` 发的）与 interactive（卡片）没有 `text` 字段** ——
      //   于是守衡读群历史时，**自己发出去的话全部显示成「我没法看到里面的内容」**。
      //   实测那三行读数与根因写在 `bodyToText` 上面。
      const parsed = bodyToText(it.msg_type, it.body?.content);
      const raw = parsed.text ?? '';
      // 撤回的消息，飞书把正文换成一句英文占位符，原文在任何接口都取不回。
      // 必须把它和「正常但很短的消息」区分开：前者是**内容没了**，后者是**本来就这么短**。
      // 混在一起时，守衡会把「撤回」读成「有一条我看不懂的消息」，进而低估自己漏了多少东西。
      const recalled = /^This message was recalled$/i.test(raw.trim());
      // 附件里的 **file/media/audio** 不是「我看不到」—— 是**按规矩不取**：
      // 它们的字节只有下载这一条通道，而飞书内容禁止下载（AGENTS.md §2.6）。
      // 工具给的是事实，事实就该由工具说清，不让模型去猜自己为什么读不到。
      //
      // ★ 2026-10-05：**图片从这一类里分出来了**。人在**当前那条**消息里发的图，
      //   守衡会读图上的字（窄豁免，见 `fetchMessageImage` 的头注）；
      //   但**群历史里的图不读** —— 豁免只覆盖「人当前发的那一条」，
      //   否则就成了「顺着历史把群里的图全捞一遍」，那正是红线要防的事。
      //   这一格必须把这层差别写出来，否则守衡会把「历史图不读」说成「图片我不读」，
      //   于是她再发一次也没用（她上次听到的就是这类话）。
      // ★ 2026-10-05 同日补**视频**那一半：`media`（视频消息）与「名字是视频的 `file`」
      //   现在**也在窄豁免里** —— 但同图片一样，**只管人当前发的那一条**。
      //   历史里的视频照旧不取，这一格要把这层差别说出来，否则她会听到「视频我不读」。
      const ATTACHMENT_TYPES = new Set(['file', 'media', 'audio']);
      const VIDEO_EXT = /\.(mp4|mov|m4v|avi|webm|mkv|3gp)$/i;
      let contentObj = {};
      try { contentObj = JSON.parse(it.body?.content ?? '{}') ?? {}; } catch { contentObj = {}; }
      const isVideoish = it.msg_type === 'media'
        || (it.msg_type === 'file' && VIDEO_EXT.test(String(contentObj.file_name ?? '')));
      const text = recalled
        ? '（原文已在飞书端撤回，撤回后任何接口都不返回内容）'
        : (raw || (it.msg_type === 'image'
            ? '（这是图片消息。**历史里的图我不读** —— 我只看人当前发给我的那一条里的图。要看这张，请单独再发我一条。）'
            : (isVideoish
              ? '（这是视频。**历史里的视频我不读** —— 我只看人当前发给我的那一条（它引用的那一条也算）。要看这条，请单独再发我一条。）'
              : (ATTACHMENT_TYPES.has(it.msg_type)
                ? '（这是附件：飞书内容禁止下载，附件只有下载这一条通道，所以我不取它的内容。）'
              // ★ 这一句原先对 post / interactive 也这么说过（「正文为空 —— 我没法看到里面的内容」），
              //   而那是**假否定**：内容就在 payload 里，是我们没去读对地方。
              //   现在只有**真的没解析出来**才落到这里，并把「是哪种没解析出来」写出来 ——
              //   **「没解析出来」和「内容为空」是两件事**，读的人要能分开。
              : `（${it.msg_type ?? '未知'} 类型：我没能解析出正文 —— ${parsed.note ?? '未知原因'}）`))));
      const sender = {
        messageId: it.message_id,
        // 北京时间，不是 UTC。原来这里是 toISOString()，而 `now` 工具给的是北京时间，
        // 两个基准并存导致模型又减了 8 小时：真实 11:12 被说成 23:12。
        // 所有对外可见的时间都必须走 timefmt，保持单一基准。
        at: beijingString(Number(it.create_time)),
        senderType: it.sender?.sender_type,     // user | app
        senderId: it.sender?.id,
        msgType: it.msg_type,
        recalled,
        text,
      };
      return { ...sender, ...resolveSender(sender, map) };
    }).reverse();

    // 把「我看不到什么」做成显式字段，而不是让守衡自己意识到。
    // 真实事故（2026-09-16）：本群消息已顶到 50 条上限，守衡在表格里写「第 1 次」，
    // 同时补了一句「不一定是真正的第一次」—— 它意识到了，但这不该靠它自觉。
    // 窗口边界是事实，事实就该由工具给，不由模型推。
    out.window = {
      returned: out.length,
      pageSize,
      atLimit: out.length >= pageSize,
      oldestAt: out[0]?.at ?? null,
      note: out.length >= pageSize
        ? `只返回最近 ${out.length} 条（已顶到 ${pageSize} 条上限，且本工具不分页）：更早的消息我看不到，我也不会知道自己漏了。表里/结论里的「第一次」只能是「本窗口内的第一次」。`
        : `返回最近 ${out.length} 条（未顶到 ${pageSize} 条上限，这已是全部可见历史）。`,
    };
    return out;
  } catch (e) {
    return { error: `拉取消息失败 code=${e?.response?.data?.code} msg=${e?.response?.data?.msg ?? e.message}` };
  }
}

/**
 * 按 `message_id` 回读**单条**消息。回 `{ error }` 而**不抛** —— 与 `listRecentMessages` 同风格。
 *
 * ★ 存在的理由（2026-09-22）：她被 @ 时用**话题回复**答话，
 *   而 `im.message.receive_v1` 事件里 `parent_id` / `root_id` 指着我方那条消息。
 *   两个字段原先没人读 → 守衡看到一句悬空的回答，接到了别的话题上，误答并外发。
 *   判据（什么时候该读、读哪一条）在 `agent/thread.mjs`，**这里只管把那一读做出来**。
 *
 * ★ 实测（2026-09-22，只读探针，见 PMO/守衡-误答登记-20260922.md §3.2.1）：
 *   机器人**读得回自己发出去的消息** —— 包括 `tools/send_once.mjs` 发的主动推送
 *   （`om_x100b64166aff2ca8b487459d2f76acb` 实测读得到，`sender_type=app`）。
 *   所以「守衡看不见自己问过什么」这一半，靠这一次回读就能补上，
 *   **不需要动 import 图、不需要给 memory.append 加调用点**。
 *
 * @returns {Promise<{text:string, from:string, senderType:string, senderOpenId:string|null,
 *                    at:string|null, msgType:string, recalled:boolean, parentId:string|null,
 *                    rootId:string|null}|{error:string}>}
 */
export async function getMessage(messageId) {
  try {
    const r = await client.im.message.get({ path: { message_id: messageId } });
    const items = r?.data?.items ?? [];
    if (!items.length) {
      // ⚠️ `code=0` 但 items 为空 —— 必须与「读到了空消息」长得不一样（§2.4.1 第 1 行那个坑）。
      return { error: `消息 ${messageId} 回读成功但 items 为空（code=0）—— 这是「读不到」，不是「内容是空的」` };
    }
    const it = items[0];

    // ★ 2026-09-22：改走 `bodyToText`（与 `listRecentMessages` 同一份解析）。
    //   原先这里也只认 `.text` —— 后果具体到本轮：`outbound_ledger.mjs --backfill`
    //   会给一条 **post** 消息写进**空正文**的台账记录，而空正文在折记忆时会被跳过，
    //   于是「补记了」和「没补记」在表面上完全一样。补记的正是守衡自己发的话，
    //   而它自己发的**绝大多数是 post**（`sendMarkdown` 走富文本）。
    const parsed = bodyToText(it.msg_type, it.body?.content);
    const raw = parsed.text ?? '';

    // 撤回：飞书把正文换成一句英文占位符，原文任何接口都取不回。
    // 必须与「正常但很短的消息」分开 —— 前者是**内容没了**，后者是**本来就这么短**。
    const recalled = /^This message was recalled$/i.test(raw.trim());

    const senderType = it.sender?.sender_type;       // user | app
    const senderOpenId = senderType === 'user' ? (it.sender?.id ?? null) : null;

    // 发信人的显示名：机器人直接说「你自己」，用户才去查名。
    // 查不到就如实写 open_id，**不编一个称呼**（把 id 写出来至少能比对）。
    let from = senderType === 'app' ? `${BOT_NAME}(你自己)` : null;
    if (!from && senderOpenId) {
      const looked = await getUserName(senderOpenId, it.chat_id ?? null);
      from = looked?.name ?? `用户(${senderOpenId})`;
    }

    return {
      text: recalled ? '（原文已在飞书端撤回，撤回后任何接口都不返回内容）' : raw,
      from: from ?? String(senderType ?? '(未知发送者)'),
      senderType: senderType ?? null,
      senderOpenId,
      // ★ 2026-09-22 补：`chat_id` 原先没有带出去。补记外发（`tools/outbound_ledger.mjs
      //   --backfill`）要把一条历史消息写进台账，而台账是按 `chat_id` 折进会话记忆的 ——
      //   取不到它，「这条是发到哪个群的」就只能靠调用方猜，而猜错的表现是
      //   **折进了另一个群（或谁都折不进）**，两边都不报错。
      chatId: it.chat_id ?? null,
      at: it.create_time ? beijingString(Number(it.create_time)) : null,
      createTime: it.create_time ? Number(it.create_time) : null,
      msgType: it.msg_type ?? null,
      recalled,
      // ★ 解析出来了没有 —— 与 `text` 是空串分得开。调用方（补记台账）据此决定
      //   「这条读回来了」还是「这条我读不出来」，不许把后者当成前者。
      parsed: parsed.parsed,
      parseNote: parsed.note ?? null,
      // ★ 2026-10-05：把**原始 content** 与**这条消息里的图片 key** 一起带出去。
      //   理由：「引用一张图 / 回复一张图来问守衡」是最常见的发法之一，而那条被引用的
      //   消息必须能被读成「里面有没有图、图是哪几张」。原先这里只回**解析后的文本**，
      //   于是「引用一张图问一句」这条路在数据上就是断的 —— 看不到 `image_key`，
      //   只能回一句「你这条里没图」（而真相是「图在它引用的那一条里」）。
      rawContent: it.body?.content ?? null,
      images: imageKeysOf(it.msg_type, it.body?.content),
      // ★ 2026-10-05 同日加：视频走**同一条窄豁免**（`videoKeysOf`）。
      //   与 `images` 分开两个字段，是为了让「这条我拿到的是图还是视频」在数据上就分得开。
      videos: videoKeysOf(it.msg_type, it.body?.content),
      parentId: it.parent_id ?? null,
      rootId: it.root_id ?? null,
    };
  } catch (e) {
    // 已知会走到这里的一种情形：消息被删除 / 不在本应用可见范围。
    // 这不是「没有上文」，是「读不到上文」—— 调用方必须能分辨（见 thread.mjs 头注）。
    return { error: `回读消息失败 code=${e?.response?.data?.code} msg=${e?.response?.data?.msg ?? e.message}` };
  }
}

/** 群信息（名称等），用于让守衡知道自己在哪个群 */
export async function getChatInfo(chatId) {
  try {
    const r = await client.im.chat.get({ path: { chat_id: chatId } });
    return { name: r?.data?.name, description: r?.data?.description, memberCount: r?.data?.user_count };
  } catch (e) {
    return { error: `获取群信息失败 code=${e?.response?.data?.code} msg=${e?.response?.data?.msg ?? e.message}` };
  }
}

/** 群成员列表 */
export async function listMembers(chatId, pageSize = 50) {
  try {
    const r = await client.im.chatMembers.get({
      path: { chat_id: chatId },
      params: { member_id_type: 'open_id', page_size: pageSize },
    });
    return (r?.data?.items ?? []).map((m) => ({ name: m.name, openId: m.member_id }));
  } catch (e) {
    return { error: `获取群成员失败 code=${e?.response?.data?.code} msg=${e?.response?.data?.msg ?? e.message}` };
  }
}

/**
 * 用 open_id 查用户显示名。
 *
 * 两条路，按可靠性排序：
 *  1) 群成员列表（im:chat 权限）—— 本应用已有权限，且天然只返回「同群可见」的人
 *  2) 通讯录单查（contact 权限）—— 需要额外开通，未开通会返回 99991672
 *
 * 传了 chatId 就先走 1)；没传或查不到再退到 2)。
 * 两条都失败时返回 { name: null, source: 'none', reason } —— 把原因带出去，
 * 不再静默返回 null，否则上层无法区分「这个人不在可见范围」和「接口没权限」。
 */
const _memberNameCache = new Map(); // chatId -> Map<openId, name>

export async function getUserName(openId, chatId = null) {
  if (!openId) return { name: null, source: 'none', reason: '未提供 open_id' };

  // 路 1：群成员列表
  if (chatId) {
    try {
      let cached = _memberNameCache.get(chatId);
      if (!cached) {
        const members = await listMembers(chatId, 100);
        if (Array.isArray(members)) {
          cached = new Map(members.filter((m) => m.name && m.openId).map((m) => [m.openId, m.name]));
          _memberNameCache.set(chatId, cached);
        }
      }
      if (cached?.has(openId)) return { name: cached.get(openId), source: 'chat_member' };
    } catch { /* 落空，继续走通讯录 */ }
  }

  // 路 2：通讯录单查
  try {
    const r = await client.contact.user.get({ path: { user_id: openId }, params: { user_id_type: 'open_id' } });
    const name = r?.data?.user?.name ?? null;
    if (name) return { name, source: 'contact' };
    return { name: null, source: 'none', reason: '通讯录返回空' };
  } catch (e) {
    const code = e?.response?.data?.code;
    const reason = code === 99991672
      ? '缺少通讯录权限（需开通 contact:contact.base:readonly 等任一），且该人不在本群成员列表中'
      : `通讯录查询失败 code=${code} msg=${e?.response?.data?.msg ?? e.message}`;
    return { name: null, source: 'none', reason };
  }
}

/** 发一条带 @ 的文本消息：文本里写 <at user_id="ou_xxx"></at> 即可触发飞书 @ */
export async function sendTextWithMentions(chatId, text) {
  // ★ 2026-10-14：`msg_type: 'text'` 的出口**一律摘 markdown 符号**（见 `plain.mjs`）。
  //   这条与 `sendMarkdown` 的降级支是同一条纪律：飞书 text 不认 `**`，会把它们显示出来。
  const { text: safe } = plainifyForSend(text, { where: 'sendTextWithMentions' });
  return client.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: safe }) },
  });
}

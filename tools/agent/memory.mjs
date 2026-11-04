/**
 * memory.mjs —— 守衡的记忆层
 *
 * 记忆按「会话」隔离：每个群一个文件，每个人私聊一个文件。
 * 会话变长时，旧轮次交给 LLM 压成一段纪要，而不是硬截断 —— 硬截断会让守衡
 * 忘记「刚才答应过什么」，那比忘记闲聊内容严重得多。
 *
 * 文件格式（PMO/shouheng-state/sessions/<key>.json）：
 * {
 *   key, kind, title, createdAt, updatedAt, messageCount,
 *   summary: "旧轮次压缩纪要",
 *   messages: [ {role, content, at, name?}, ... ]   // 只存未压缩的近期轮次
 * }
 */
import fs from 'node:fs';
import path from 'node:path';
import { stateDir, ensureDir, config } from './config.mjs';

// 惰性求值：与 seenFile 同理，写死成 import 期常量后无法在测试里重定向，
// 且 import 期裸 mkdirSync 会在目录被同名文件占位时让整个进程起不来。
const sessDir = () => path.join(stateDir(), 'sessions');
ensureDir(sessDir());

/** 会话键：群聊 `chat_<id>`，私聊 `dm_<openId>` */
export function sessionKey({ chatId, chatType, senderOpenId }) {
  return chatType === 'p2p' ? `dm_${senderOpenId}` : `chat_${chatId}`;
}

const fileOf = (key) => path.join(sessDir(), `${key.replace(/[^\w.-]/g, '_')}.json`);

export function load(key) {
  const f = fileOf(key);
  if (!fs.existsSync(f)) {
    return { key, kind: key.startsWith('dm_') ? 'dm' : 'chat', title: null,
             createdAt: new Date().toISOString(), updatedAt: null, messageCount: 0,
             summary: '', messages: [] };
  }
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch (e) {                                      // 文件损坏不应让守衡整个挂掉
    const bak = `${f}.corrupt-${Date.now()}`;
    try { fs.renameSync(f, bak); } catch {}
    return { key, kind: 'chat', title: null, createdAt: new Date().toISOString(),
             updatedAt: null, messageCount: 0, summary: '', messages: [],
             recoveredFrom: path.basename(bak) };
  }
}

export function save(sess) {
  sess.updatedAt = new Date().toISOString();
  const f = fileOf(sess.key);
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(sess, null, 2));   // 先写临时文件再 rename，
  fs.renameSync(tmp, f);                                  // 避免进程被杀时留下半个文件
  return f;
}

/**
 * 追加一条消息。
 *
 * ★ **闸门设在这里，不在调用方**（§2.4：写进文档的约束必须指得出哪一行在拦它）。
 *   `isPersistable()` 不通过就**真的不落盘**，并返回 `{stored:false}` ——
 *   调用方若要记账，读返回值，别自己再判一次（两处判就会各自漂移）。
 *
 * @returns {{stored:boolean, why?:string}}
 */
export function append(sess, msg) {
  if (!isPersistable(msg)) {
    return { stored: false, why: '空 assistant 轮不许落盘（会 400，且会被当成「已经答过」）' };
  }
  sess.messages.push({ at: new Date().toISOString(), ...msg });
  sess.messageCount = (sess.messageCount ?? 0) + 1;
  return { stored: true };
}

/**
 * 这条 assistant 轮**能不能落进记忆**。
 *
 * ★ 2026-09-30 加，起因是一次真事故（本群 19:11 / 19:16 两条截断回复）：
 *   `agent.mjs` 在「模型烧光额度、正文 0 字」时把**空串**原样 append 进了会话记忆。
 *   下一轮 `toLlmMessages()` 又把这条空 assistant 发回给 API，而 DeepSeek 思考模式下
 *   **一条 content 为空、又不带 reasoning_content 的 assistant 消息会被 400 拒收**：
 *
 *       HTTP 400 code=invalid_request_error:
 *       The `reasoning_content` in the thinking mode must be passed back to the API.
 *
 *   （本机实测：`{role:'assistant', content:''}` 单发必 400，见 `test_agent.mjs` 第 11 组。）
 *   于是**一条空回复会让守衡接下来整整一轮彻底答不出来** —— `PMO/logs/llm_failures.jsonl`
 *   里那条 400 就是这么来的。而这一切的源头只是「把空串当成一条正常发言存了下来」。
 *
 * 判据是**结构**，不比对文案：
 *   · 有 `tool_calls` → 允许（工具调用轮本来就可能 content 为空，那是协议的一部分）；
 *   · `content` 非空    → 允许；
 *   · 其余（空串 / 纯空白 / null / undefined）→ **不许落盘**。
 *
 * 为什么不去「补一句占位文案」：那会伪造一条守衡从未说过的话，
 * 而且它仍会在历史里占一格、被模型当成自己真的答过。**没答过就不该留下痕迹。**
 */
export function isPersistable(msg) {
  if (!msg || msg.role !== 'assistant') return true;          // 只拦 assistant 轮
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) return true;
  return String(msg.content ?? '').trim().length > 0;
}

/** 记群/人的展示名，方便日志里看懂是谁 */
export function setTitle(sess, title) {
  if (title && sess.title !== title) sess.title = title;
}

/**
 * 这段历史里有几**轮**。
 *
 * ★ 为什么要单独一个函数（2026-10-08）：`agent.mjs` 的 `meta.turns` 原先是
 *   `turns: sess.messages.length` —— 那是**条数**。而 `ws_daemon.mjs` 把它印成
 *   「🗜 历史已压缩（保留 130 轮 + 纪要 5249 字）」，**真实含义是 130 条 ≈ 24 轮**。
 *   变量名（`turns`）、日志措辞（「轮」）、实际的值（条数）三者不一致 ——
 *   这正是 `AGENTS.md` §2.4.3 那个形状：**说出去的话比手上的依据大**。
 *
 * 口径与 `compact()` **同源**，不是另立一个：一轮 = 一条 `role === 'user'`。
 * 一条用户消息可能对应 `assistant(tool_calls)` + 若干 `tool` 结果（条数不定），
 * 所以**只能按 user 定位**，按条数算会把工具调用也算成轮。
 * 两处口径必须一起动 —— 分开写两遍就会各自漂移（§2.4.1 第 4 行的教训）。
 */
export function countTurns(sess) {
  const msgs = sess?.messages;
  if (!Array.isArray(msgs)) return 0;
  return msgs.filter((m) => m?.role === 'user').length;
}

/* ─────────────────────── 上下文压缩 ─────────────────────── */

/**
 * 把过长的历史压成纪要。调用方需传入一个 summarize(messages) -> string 函数
 * （通常绑定到 LLM），这样记忆层不直接依赖 LLM 模块，便于测试。
 *
 * 两个参数是**独立**的：
 *   keepTurns —— 保留最近几轮原文（保留量）
 *   triggerAt —— 超过多少条才启动压缩（触发线）
 * 之前我把触发线写死成 config.maxTurns，等于让「保留量」既当保留又当触发，
 * 调用方传 keepTurns 却不生效 —— 测试因此测不到真实行为。
 *
 * 关键约束：切点必须落在「一轮用户消息之前」，不能在 assistant(tool_calls) 与
 * 它对应的 tool 结果之间切开 —— OpenAI 兼容协议要求 tool_calls 后面必须紧跟
 * 同数量的 tool 消息，切开会让下一次请求直接被 API 拒绝（400）。
 *
 * 返回值：是否发生了压缩。
 */
export const MAX_KEEP_MESSAGES_MULTIPLIER = 4;

export async function compact(sess, summarize, keepTurns = config.llm.maxTurns, triggerAt = config.llm.maxTurns) {
  if (sess.messages.length <= triggerAt) return false;

  const n = sess.messages.length;
  const maxKeepMessages = Math.max(keepTurns * MAX_KEEP_MESSAGES_MULTIPLIER, triggerAt);
  // ★ 2026-10-26 修复「每轮必触发 LLM 压缩、且 1395 条消息永远删不掉」的算术死锁：
  //   1. 原先只比较 `sess.messages.length <= triggerAt(24)`，而 `keepTurns(24)` 轮包含
  //      `user + assistant` 至少 48 条（外加 `outbound.foldInto` 折进来的主动外发 assistant 轮，
  //      生产实测 24 轮 = 221 ~ 1419 条消息）⇒ 每进 1 轮，必调一次 LLM 压缩 1 条旧消息（白花 20~35s）！
  //   2. 当用户轮数 <= keepTurns 且总条数 <= maxKeepMessages 时，根本不需要压缩；
  //      只有当「用户轮数 > keepTurns + 2（留缓冲避免每轮触发）」或「总条数 > maxKeepMessages」时才压。
  const totalUsers = countTurns(sess);
  const usingDefaultTrigger = triggerAt === config.llm.maxTurns && keepTurns === config.llm.maxTurns;
  if (usingDefaultTrigger && totalUsers <= keepTurns + 2 && n <= maxKeepMessages) {
    return false;
  }

  // 从末尾往前数 keepTurns 个「用户消息」，同时限制保留的总消息数不超过 maxKeepMessages，
  // 切在安全边界（`role === 'user'`）之前。
  let seenUsers = 0;
  let cut = 0;
  for (let i = n - 1; i >= 0; i--) {
    if (sess.messages[i]?.role === 'user') {
      seenUsers++;
      if (seenUsers === keepTurns) { cut = i; break; }   // 切在第 keepTurns 个 user 之前
      // 若两个 user 之间夹了大量 foldInto 折进来的 assistant 消息（如 1000+ 条），
      // 在超出 maxKeepMessages 之前的最后一个 user 边界截断，防止 1400 条消息永远留在 keep 里。
      if (usingDefaultTrigger && (n - i) > maxKeepMessages && seenUsers >= 4) {
        break;
      }
      cut = i;
    }
  }

  // cut 为 0 有两种情况，都不能压缩：
  //   a) 整段里没有用户消息（找不到边界）
  //   b) 用户消息不足 keepTurns 轮
  // 强行压缩会破坏 tool_calls 配对，宁可长着也不要发坏请求。
  if (cut <= 0) return false;

  const old = sess.messages.slice(0, cut);
  const keep = sess.messages.slice(cut);
  if (old.length === 0) return false;

  let digest;
  try {
    digest = await summarize(old, sess.summary);
  } catch (e) {
    // 压缩失败不能丢消息 —— 只做安全截断，并留下痕迹
    digest = `${sess.summary}\n（提示：本段压缩失败 ${e.message}，以下为原始截断）\n` +
             old.map((m) => `${m.role}: ${String(m.content).slice(0, 200)}`).join('\n');
  }

  // ★ 最后一道闸（2026-09-22 加）：**纪要空 → 不压缩，消息一条都不删。**
  //
  //   这道闸是**独立**于 `summarize()` 的，故意的。「宁可长着，也不要丢」这条判据
  //   不该依赖上游某个函数守规矩 —— 上面那条 `cut <= 0` 的早退就是同一个理由
  //   （「强行压缩会破坏 tool_calls 配对，宁可长着也不要发坏请求」）。
  //
  //   真事故：`summarize()` 在推理预算被吃光时返回空串，这里当成纪要写下去，
  //   然后把整天旧对话删掉。三个会话的 `summary` 全是 0 长度，日志里印了 8 次
  //   「保留 N 轮 + 纪要」——**删了，且什么都没留下，而日志说留下了。**
  //   代价不是「这次没压缩」，是「守衡确信地不记得」：它下一轮看到的是断头的历史。
  //
  //   返回 false 的后果是这轮上下文偏长，下一轮还会再试（那次可能是好的 ——
  //   实测同一个输入连跑两次，一次 0 字一次 245 字）。
  if (!String(digest ?? '').trim()) {
    console.warn('[memory] ⚠️ 压缩放弃：纪要为空白 —— 旧对话**一条都没删**（宁可长着，也不要丢）');
    return false;
  }

  sess.summary = String(digest).trim();
  sess.messages = keep;
  return true;
}

/**
 * 构造发给 LLM 的 messages 数组。
 *
 * ★ 2026-09-30 加**回放前清洗**（`sanitizeForLlm`）。理由与 `isPersistable` 是同一件事，
 *   但**必须独立存在**：`append` 那道闸只拦「今后新写进来的」，
 *   拦不住**盘上已经躺着的**坏记录 —— 而事故当时那份会话记忆里就有两条空 assistant
 *   （`…692.json` 的第 26、43 条），它们会让守衡在**每一次**后续请求上 400，
 *   直到有人手动去改会话文件（谁也不会想到要改）。
 *
 *   两道闸的关系是「以后不再产生」+「已经产生的别再送出去」，缺一条都不算修好。
 */
export function toLlmMessages(sess, systemPrompt) {
  const out = [{ role: 'system', content: systemPrompt }];
  if (sess.summary) {
    out.push({
      role: 'system',
      content: `# 本会话早前内容的纪要（更早的对话已压缩，以下是可靠摘要）\n${sess.summary}`,
    });
  }
  for (const m of sess.messages) {
    if (m.role === 'user' || m.role === 'assistant' || m.role === 'tool' || m.role === 'system') {
      out.push({ role: m.role, content: m.content, ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
                 ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
                 // ★ 2026-09-30 加（P0）：带 `tools` 的请求**必须**回传 reasoning_content，
                 //   否则 API 直接 400（见 config.mjs 的 `reasoningPassback` 与
                 //   PMO/logs/llm_failures.jsonl 那条实测）。这里只做「有就带上」，
                 //   裁剪与开关都在 `agent.mjs` 的 `reasoningToPassBack()` 一处收口。
                 ...(m.reasoning_content ? { reasoning_content: m.reasoning_content } : {}) });
    }
  }
  return sanitizeForLlm(out);
}

/**
 * 回放前的清洗。**纯函数**，所以它能被单独喂样本证伪。
 *
 * 三条，每条对应一个**已经真实发生过**的 400：
 *   ① **空 assistant 轮**（无 tool_calls、content 空/空白）→ 丢掉。
 *      实测：`{role:'assistant',content:''}` 单发必 400
 *      `The reasoning_content in the thinking mode must be passed back to the API`。
 *   ② **配不上 tool_calls 的 tool 结果**（前面的 assistant 里没有这个 tool_call_id）→ 丢掉。
 *      实测报错：`An assistant message with 'tool_calls' must be followed by tool messages …`
 *      以及 `Messages with role 'tool' must be a response to a preceding message with 'tool_calls'`。
 *      ⚠️ 这一条**是防御性的**，不是「已发生」：当前写入路径不会产生孤儿 tool 结果
 *      （工具结果与被截断的收尾都 append 在同一轮里，逐条核过盘上的会话文件）。
 *      留着它，是因为**压缩切点**与将来新增的写入路径都可能把它造成事实。
 *   ③ 就地保序 —— 只删不排，不许因为清洗把 user / assistant 的顺序打乱。
 *
 * @param {Array} messages 已经拼好的 messages 数组
 * @returns {Array} 同一个顺序、去掉坏记录的数组
 */
export function sanitizeForLlm(messages) {
  const out = [];
  const liveCallIds = new Set();
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || typeof m !== 'object') continue;

    if (m.role === 'assistant') {
      const hasCalls = Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
      if (!hasCalls && String(m.content ?? '').trim().length === 0) continue;   // ①
      // 记下这一轮的 tool_call_id；上一轮的先作废（tool 结果只许跟**紧接**它的那个 assistant）
      liveCallIds.clear();
      if (hasCalls) for (const tc of m.tool_calls) if (tc?.id) liveCallIds.add(tc.id);
      out.push(m);
      continue;
    }

    if (m.role === 'tool') {
      const id = m.tool_call_id;
      if (!id || !liveCallIds.has(id)) continue;                                // ②（孤儿）
      liveCallIds.delete(id);       // 一个结果只配一次，重复的同样丢掉
      out.push(m);
      continue;
    }

    liveCallIds.clear();            // user / system 之后，之前那批 tool_calls 已经过期
    out.push(m);
  }
  return out;
}

/** 会话列表（给「/status」之类用途） */
export function listSessions() {
  return fs.readdirSync(sessDir()).filter((f) => f.endsWith('.json')).map((f) => {
    try { const s = JSON.parse(fs.readFileSync(path.join(sessDir(), f), 'utf8'));
          return { key: s.key, title: s.title, messages: s.messages?.length ?? 0,
                   total: s.messageCount ?? 0, updatedAt: s.updatedAt, hasSummary: !!s.summary }; }
    catch { return { key: f, error: 'unreadable' }; }
  });
}

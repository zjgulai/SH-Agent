/**
 * 截断守卫 —— 防止「半句话」被当成完整回答发出去。
 *
 * 为什么需要这个文件（真实事故，2026-09-16）：
 *   守衡发出的一条 779 字回复，结尾停在「这条也算那份记录里「未做」——
 *   句子没写完，但守护进程日志记的是「✓ 已发送」，没有任何报错。
 *   用户看到的就是一条断掉的回答，而他无从知道它是断的。
 *
 * 根因不是飞书（实测飞书 text 消息能收 8000 字），而是：
 *   DeepSeek 的 max_tokens 同时覆盖思维链和正文。配置成 1600 时，
 *   reasoning_tokens 可以把整个额度吃光，finish_reason='length'，
 *   正文被腰斩甚至为 0 字。而 agent.mjs 拿到了 finishReason 却从没检查。
 *
 * 设计原则：截断**必须可见**。宁可显式告诉用户「这条被截断了，我重发」，
 * 也不能把半句话伪装成完整回答 —— 后者会让人以为那就是全部内容。
 */

/** 认得出「句子已经说完」的结尾字符 */
const SENTENCE_END = /[。！？；：…」』】）)\]}"'`*|~～]/;

/** 结尾若是这些，句子显然没说完 */
const DANGLING_END = /[，、,;：（(\[【「『《“‘\-—]+$/;

/** 段落中续行（表格行、列表项）结尾没有标点时，不算悬空 */
const INCOMPLETE_LINE_END = /[，、,;：:（(\[【「『《“‘\-—]$/;

/** 结尾是拉丁字母/数字/URL 时无法判断，不报（宁漏勿误伤） */
const AMBIGUOUS_TAIL = /[A-Za-z0-9/.:_=%&#?+-]$/;

/** 最长保留多少字再截（一篇长回答的合理上限，避免刷屏） */
const DEFAULT_MAX_CHARS = 3000;

/**
 * 判断一次模型回复是否被截断 —— finish_reason 优先。
 *
 * @param {object} opts
 * @param {string} opts.finishReason  LLM 返回的 finish_reason
 * @param {string} opts.text          正文
 * @returns {{cut: boolean, reason: string|null}}
 */
export function detectTruncation({ finishReason, text } = {}) {
  const t = String(text ?? '').trim();

  // 1) finish_reason 是权威信号，优先于任何文本启发式
  if (finishReason === 'length') {
    return { cut: true, reason: 'finish_reason=length（额度耗尽）' };
  }
  if (finishReason === 'content_filter') {
    return { cut: true, reason: 'finish_reason=content_filter（被内容策略拦截）' };
  }
  if (finishReason && finishReason !== 'stop' && finishReason !== 'tool_calls') {
    return { cut: true, reason: `finish_reason=${finishReason}（非正常收尾）` };
  }

  // 2) 文本启发式：空回复本身就是一种失败
  if (!t) return { cut: true, reason: '正文为空' };

  // 3) 悬空标点（以逗号/顿号/左括号等收尾）
  if (DANGLING_END.test(t)) {
    return { cut: true, reason: '结尾是悬空标点，句子未完成' };
  }

  // 4) 结尾是「未闭合的中文句子」。
  //    聊天回答里，正文以中文汉字收尾、却没有句末标点，说明话没说完。
  //    真实事故的结尾是「…这条也算那份记录里「未做」—— 没有悬空标点，
  //    单靠标点规则抓不到，必须看「最后一个字是不是汉字且无终结符」。
  //    拉丁字母/数字/URL 结尾一律放过（那些本来就常不带中文标点）。
  if (!SENTENCE_END.test(t.slice(-1)) && !AMBIGUOUS_TAIL.test(t)) {
    const lines = t.split('\n').filter((l) => l.trim());
    const lastLine = (lines[lines.length - 1] ?? '').trim();
    const isTableLike = /^\|/.test(lastLine) || /^[-*+]\s/.test(lastLine) || /^\d+[.、)]\s/.test(lastLine);

    // 短回复（「好」「收到」）本来就不带句号，不能误报。
    // 阈值 12 字：实线上短答普遍在这个量级以下，而真正的腰斩远长于此。
    if (t.length >= 12 && !isTableLike && /[\u4e00-\u9fff]$/.test(lastLine) && !INCOMPLETE_LINE_END.test(lastLine)) {
      return { cut: true, reason: '结尾是未闭合的中文句子，缺句末标点' };
    }

    // 长文本完全没有句末标点 —— 整体被腰斩的特征
    if (t.length > 200 && !SENTENCE_END.test(t.slice(-8))) {
      return { cut: true, reason: '长回复结尾无句末标点' };
    }
  }

  return { cut: false, reason: null };
}

/**
 * 把被截断的文本修剪到最后一个完整句子，并附上明确的截断标记。
 *
 * @param {string} text
 * @param {object} opts
 * @param {number} [opts.maxChars]
 * @param {string} [opts.reason] 截断原因，写进提示里便于排查
 * @returns {string}
 */
export function annotateTruncation(text, { maxChars = DEFAULT_MAX_CHARS, reason = null } = {}) {
  let t = String(text ?? '').trim();

  // 超长先硬截，避免单条消息刷屏
  if (t.length > maxChars) {
    t = t.slice(0, maxChars);
  }

  // 回退到最后一个完整句子结尾，别把半句话留在那儿
  const lastEnd = Math.max(
    t.lastIndexOf('。'), t.lastIndexOf('！'), t.lastIndexOf('？'),
    t.lastIndexOf('\n'), t.lastIndexOf('；'),
  );
  if (lastEnd >= 0 && lastEnd < t.length - 1) {
    t = t.slice(0, lastEnd + 1).trimEnd();
  }

  const why = reason ? `（${reason}）` : '';
  return `${t}\n\n---\n⚠️ 这条回答被长度上限截断了${why}，上面是不完整的。你可以让我「接着说」，或者把问题拆小一点再问。`;
}

/**
 * 一句话摘要，给日志用。
 * @param {string} text
 */
export function tailOf(text, n = 40) {
  const t = String(text ?? '').trim();
  return t.length <= n ? t : `…${t.slice(-n)}`;
}

/* ─────────────── 工具返回体的预算闸门（2026-09-30 加） ───────────────
 *
 * ★ 为什么必须有这一块：一条工具返回体没有上限，就等于**上下文没有上限**。
 *
 * 真实事故（2026-09-30 19:11，本群）：
 *   她问「用知识库查一下『吸奶器』相关的措辞要求」。模型调了两次 `kb_search`
 *   （topK=50 + topK=20），工具忠实地把 44 条命中**连正文一起**倒进上下文 ——
 *   **41,262 + 19,087 = 60,349 字**原始 JSON。下一轮模型面对这 6 万字，
 *   把 8000 token 输出预算**全部烧在思维链上**（日志：`reasoning 8000 tok｜正文 0 字｜
 *   finish_reason=length`），正文一个字没轮上，群里收到的是一条**只有截断说明的消息**。
 *
 * 两次调用的用量说明问题不在「模型想太多」，而在**输入没做预算**：
 *   同一次重放，把命中压到「每条 ≤1200 字 × 10 条」是 16,308 字 → reasoning 677 tok、
 *   正文 1139 字、`finish=stop`（`PMO/` 里那份探针记录）。
 *
 * ⚠️ 裁剪**必须可见**：被剪掉的条数与每条的原长都要报出来，
 *   否则「只回 10 条」会被读成「一共只有 10 条」—— 那正是假否定。
 */

/** 单条工具返回体默认上限（字）。实测 6 万字是本病的直接成因，1.5 万以内安全。 */
export const TOOL_OUTPUT_MAX_CHARS = 15_000;

/**
 * 给工具返回体贴上「被剪过」的标记。**不静默**：超限时补 `_clipped` 说明。
 *
 * @param {*} value            工具返回的原始值（对象会被 JSON.stringify）
 * @param {object} [opts]
 * @param {number} [opts.maxChars]
 * @returns {string} 可以直接塞进 `role:'tool'` 的字符串
 */
export function clipToolOutput(value, { maxChars = TOOL_OUTPUT_MAX_CHARS } = {}) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const s = String(text ?? '');
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars)
    + `\n…〔本条工具返回体原长 ${s.length} 字，已按 ${maxChars} 字上限截断；`
    + `后面还有 ${s.length - maxChars} 字这次没进上下文。要完整内容请换更具体的查询词，`
    + `或改用能指定条数的参数。〕`;
}

/**
 * 把一大段工具返回体压成「还有哪些东西、多少量」的一行 —— 供**兜底合成**用。
 *
 * 兜底那一轮的目的不是让模型继续查，是让它在**不展开原始 JSON** 的前提下把答案写出来。
 * 所以这里刻意只留结构信息（条数 / 候选数 / 键名 / 文件名），不留正文。
 *
 * @param {string} content  工具返回体的原文
 */
export function collapseToolPayload(content) {
  const s = String(content ?? '');
  let j = null;
  try { j = JSON.parse(s); } catch { /* 非 JSON（纯文本工具输出）走下面的按行摘要 */ }

  if (j && typeof j === 'object') {
    const bits = [];
    if (j.collection) bits.push(`子库=${j.collection}`);
    if (j.hitCount != null) bits.push(`命中 ${j.hitCount} 条`);
    if (j.totalCandidates != null) bits.push(`候选 ${j.totalCandidates} 条`);
    if (j.uniqueDocCount != null) bits.push(`涉及 ${j.uniqueDocCount} 个文档`);
    if (Array.isArray(j.hits)) {
      const titles = [...new Set(j.hits.map((h) => h.docTitle).filter(Boolean))].slice(0, 8);
      if (titles.length) bits.push(`文档：${titles.join(' / ')}`);
    }
    if (j.count != null) bits.push(`共 ${j.count} 条`);
    if (Array.isArray(j.files)) bits.push(`文件：${j.files.slice(0, 6).join(' / ')}`);
    if (j.rel_path) bits.push(`文件 ${j.rel_path}`);
    if (j.command) bits.push(`命令 ${String(j.command).slice(0, 80)}`);
    if (j.status) bits.push(`状态 ${j.status}`);
    if (j.error) bits.push(`错误 ${String(j.error).slice(0, 120)}`);
    if (bits.length) return `〔已折叠〕${bits.join('；')}（正文 ${s.length} 字这次不展开）`;
  }

  const lines = s.split('\n').filter((l) => l.trim()).slice(0, 8).map((l) => l.trim().slice(0, 100));
  return `〔已折叠〕正文 ${s.length} 字，前几行：\n${lines.join('\n')}`;
}

/**
 * 兜底合成那一轮用的消息：**把工具返回体全部折叠掉**。
 *
 * 只在「模型已经烧光预算、一个字都没写」时用。它替掉的是
 * 「把半句话/空话发进群」，代价是这一轮的答案只能依据折叠后的结构信息 ——
 * 而那比一条**什么都没说的截断提示**有用得多。
 *
 * 判据是**结构**（role === 'tool'），不是比对某句文案。
 */
export function collapseToolMessages(messages) {
  return (messages ?? []).map((m) => {
    if (m?.role !== 'tool') return m;
    const collapsed = collapseToolPayload(m.content);
    // 保留 tool_call_id：协议要求每个 tool 结果都能对上前面的 tool_calls
    return { ...m, content: collapsed };
  });
}

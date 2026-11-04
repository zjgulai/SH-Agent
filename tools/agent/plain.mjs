/**
 * plain.mjs —— 「发出去的话里不许露出 markdown 符号」的唯一出处
 *
 * ── 起因（2026-10-14，Owner 拿着私聊截图来问）
 *
 * 他一眼看到的是这一句（守衡私聊回他，`PMO/logs/ws_outbound.jsonl` 05:04:32Z 那条）：
 *
 *     1. **能查的我查完再说** —— 表、工作区文件、知识库检索这些我有路；**查不到或者
 *     没跑成的，我会说「没查成」**，不会替它说成「没有」。
 *
 * 星号是**字面**显示出来的。而这不是模型写错，是**发送跳的缺陷**：
 *
 *   · `sendMarkdown()` 把 markdown 转成**飞书富文本(post)** 节点（`**粗体**` → bold 节点），
 *     所以那条路**没有星号**（实测载荷里 0 个 `*`）；
 *   · `replyMarkdown()` —— 也就是**「回复某条消息」这条路** —— 直接把原文塞进
 *     `msg_type: 'text'`，**一个字都不转** ⇒ 星号原样进群、进私聊。
 *   而私聊/群里最常走的就是 reply（引用关系更清楚），于是**最常走的那条路最脏**。
 *
 * 判据（本文件只做这一件事）：**`msg_type: 'text'` 与 post 的降级载荷里，不许有一个 `*`。**
 * 本文件的 `plainify()` 是这条判据的**唯一实现** —— 别在第二处再写一份
 * （`review_gate.mjs` 那种「两份实现各自漂移」的事故，本项目已经栽过一次）。
 *
 * ── 为什么删掉 5 个字符就够了，`**` 为什么不能只删一半
 *
 * `**粗体**` 删成 `粗体`（不是删掉整段，也不是留一半 `粗体**`）。
 * 三个星号残留的写法都会让人以为「内容本身带符号」：`粗体**`、`**粗体`、`*粗体*`。
 * 所以这里的替换是**成对**的：先吃 `**…**`，再吃落单的 `**`，最后才吃 `*…*`。
 *
 * ⚠️ **下划线不碰。** `_italic_` 与 `user_id`、`kb_review_chain` 长得一样，
 *    删下划线会把**标识符**改坏（那是**改内容**，比格式难看严重得多）。
 *    `**` 在中文正文里没有这种歧义 —— 这也是这条规矩能机械执行的前提。
 */

/** 必须删干净的符号：`**` 成对 → 落单 `**` → 成对 `*` → 行首 `#`。顺序即语义，别调。 */
export function plainify(text) {
  return String(text ?? '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')   // **粗体** → 粗体
    .replace(/\*\*/g, '')                  // 落单的（模型写歪了也要删干净）
    .replace(/\*([^*\n]+)\*/g, '$1')       // *斜体* → 斜体
    .replace(/\*/g, '')                    // 剩下的孤星号
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, ''); // 行首标题号（飞书 text 里也是字面符号）
}

/**
 * 这一条**还能不能带着 markdown 符号发出去**？（feishu 发送层的最后一问）
 *
 * 它故意写得比 `plainify` 严：**只认「一个 `*` 都没有」**。
 * 原因是上面那条替换链再全，也只是**我写的那几条正则**；而这里是黑体断言 ——
 * 如果哪天有人往 markdown 里塞了新写法（比如 `~~删除线~~`、`** 加粗**`），
 * 正则可能漏，但这条断言**不会漏掉「还有星号」这件事**。
 */
export function hasMdSymbols(text) {
  return /[*]/.test(String(text ?? ''));
}

/**
 * 出站前的**最后一道**：把 markdown 符号摘掉，并把「摘之前长什么样」报出来。
 *
 * 为什么要报读数而不是静默清理：静默清理会让「模型一直在写星号」这件事
 * **永远不可见** —— 而那是要治的因。日志里看得见次数，才谈得上治它。
 *
 * @param {string} text
 * @param {{where?:string}} [opt] 调用点名字（只进读数，不进正文）
 * @returns {{text:string, changed:boolean, before:number}}
 */
export function plainifyForSend(text, { where = '未命名调用点' } = {}) {
  const src = String(text ?? '');
  const out = plainify(src);
  const before = (src.match(/\*/g) ?? []).length;
  const changed = out !== src;
  if (changed && before > 0) {
    // 只在真摘了东西时打一行：正常回答（没有星号）不该刷日志。
    console.log(`[plain] · ${where}：摘掉 ${before} 个 markdown 星号（飞书 text/post 会把它显示成字面符号）`);
  }
  return { text: out, changed, before };
}

/* ═══════════ 卡片：把卡片对象里**会被渲染成字**的字符串全部摘一遍 ═══════════ */

/**
 * 卡片里**会被渲染成字**的字段（按 tag 分，闭集）。
 *
 * ★ 为什么要按 tag 点名，而不是「把所有字符串都摘一遍」：
 *   `code_block.text` **故意不在名单里** —— 代码块里可能有 `*`（比如 `**kwargs`、
 *   `select *`），那是**内容**不是标记，摘它就是改内容。
 *   （`*` 在 markdown 里是标记、在代码里是字符 —— 这一条区分就是白名单存在的理由。）
 */
const CARD_TEXT_KEYS = {
  markdown: ['content'],
  plain_text: ['content'],
  lark_md: ['content'],
  text: ['content'],
  button: ['text'],
  table: [],                       // 单元格在 `columns[].display_name` 与 `rows[][col]`，单独走
};

/**
 * 递归摘掉卡片对象里的 markdown 符号（返回**新对象**，不改调用方那份）。
 *
 * ★ 两处都要调它，缺一处就会出现「卡干净、降级文本还带星号」这种半修：
 *   · `cards.mjs` 的 `build()` —— 卡**本身**（发出去的 payload）；
 *   · `registry.mjs` 的 `elementToText()` —— 卡的**纯文本视图**（降级兜底 + 台账）。
 *   后者原先只对 `collapsible` 的标题用了 `stripMd`，**正文一个字都没摘** ——
 *   于是卡片降级时星号照样进群（那条路本来就只在出事时才走，最难被发现）。
 *
 * @param {any} card
 * @returns {any} 摘干净的一份副本
 */
export function plainifyCard(card) {
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    const out = {};
    // 表格先单独走一遍：单元格在 `columns[].display_name` 与 `rows[][列名]` 两处，
    // 不是 `content` 字段 —— 通用遍历看不见它们（实测：表格里的 `**` 会漏）。
    if (node.tag === 'table' && Array.isArray(node.columns) && Array.isArray(node.rows)) {
      out.columns = node.columns.map((c) => (typeof c.display_name === 'string'
        ? { ...c, display_name: plainify(c.display_name) } : c));
      out.rows = node.rows.map((r) => Object.fromEntries(Object.entries(r)
        .map(([k, v]) => [k, typeof v === 'string' ? plainify(v) : v])));
    }
    for (const [k, v] of Object.entries(node)) {
      if (out[k] !== undefined && (k === 'columns' || k === 'rows')) continue;   // 已处理
      if (typeof v === 'string') {
        const keys = CARD_TEXT_KEYS[node.tag];
        // 认得出的 tag 只摘指定字段；认不出的 tag 一律不碰（宁可漏，不许改内容）
        out[k] = (keys && keys.includes(k)) ? plainify(v) : v;
      } else if (typeof v === 'object' && v !== null) {
        out[k] = walk(v);
      } else {
        out[k] = v;
      }
    }
    return out;
  };
  return walk(card);
}

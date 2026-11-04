/**
 * cards.mjs —— 守衡的群回复卡片模版（10 类）
 *
 * ── 这个文件解决什么问题 ────────────────────────────────────────────────
 * 守衡在群里的回复，基线是 786 字（本项目实测中位数），形态是「markdown 标题 + 表格 +
 * 结尾三条边界声明」，全部走 msg_type=text 发出去 —— 飞书把它当纯文本渲染，
 * 竖线表格、`**粗体**`、`## 标题` 原样显示成符号。三个真实故障：
 *   1. 工具循环用尽时把内部记录原样发进群（连列 27 次工具名）——见 sessions 2026-09-17。
 *   2. 同一个问题的回答里，「边界声明」重复长成 5 条，占到全文三分之一。
 *   3. 表格在群里根本不是表格，是一堆 `|`。
 *
 * ── 设计立场 ───────────────────────────────────────────────────────────
 * **不靠模型自觉，靠模版逼。** 人格提示词里已经写了「结论先行」「不确定性显式」，
 * 但它每次都要重新解释一遍，于是变成了复读。模版的作用是把这些变成**槽位**：
 * 结论只有一个格（verdict）。`boundary` 那一格 **2026-10-13 起整个作废**（Owner：不要展示在卡片上）。
 *
 * ── 元素集从哪来 ───────────────────────────────────────────────────────
 * 不是从文档抄的，是 2026-09-18 往测试群真发 10 张探针卡测出来的
 * （读数：PMO/logs/card_probe.jsonl）。探针否掉了两个我们本来打算用的元素：
 *
 *   ❌ note   → 230099 "cards of schema V2 no longer support this capability"
 *   ❌ action → 同上（按钮不能再包一层 action）
 *
 * 这两个如果按文档印象直接写进模版，**整张卡会被服务端整体拒绝**——
 * 表现是守衡的回复凭空消失（不是降级，是丢）。所以下面 ALLOWED_TAGS 是一份
 * **实测白名单**，validateCard() 会拦住越界用法。
 */
import fs from 'node:fs';
import path from 'node:path';
// ★ 2026-10-14：摘 markdown 符号的实现**只有一份**，在 `agent/plain.mjs`。
//   这里 import 它，而不是在卡片侧再写一份 —— 两份实现必然漂移（本项目栽过）。
//   方向是 `reply-cards → agent`（`agent/plain.mjs` 不 import 卡片，无环）。
import { plainifyCard } from '../agent/plain.mjs';

/* ═══════════════════════════ 实测常量 ═══════════════════════════ */

/** header.template 实测可用的取值（探针 1/7 通过的是 turquoise，其余为 V2 常规取值） */
export const TEMPLATES = [
  'blue', 'wathet', 'turquoise', 'green', 'yellow', 'orange',
  'red', 'carmine', 'violet', 'purple', 'indigo', 'grey',
];

/** V2 支持的 tag —— 探针里成功发出去的那些 */
export const ALLOWED_TAGS = new Set([
  'markdown', 'plain_text', 'hr', 'table', 'column_set', 'column',
  'collapsible_panel', 'button', 'code_block', 'standard_icon',
]);

/** V2 **已移除**、写了就整卡被拒的 tag。单独列出来是为了给出可操作的报错。 */
export const REMOVED_IN_V2 = {
  note: 'V2 移除了 note。注脚改用 column_set（background_style: grey）或一行 markdown。',
  action: 'V2 移除了 action 容器。按钮直接裸放 elements 里（探针 10/10 通过）。',
  div: 'V2 移除了 div。正文内容用 markdown。',
  fields: 'V2 移除了 fields。字段排布用 column_set。',
  img: 'V2 移除了 img。图片改由 markdown 的 ![alt](url) 承载。',
  image: 'V2 移除了 image。同上。',
};

/**
 * 卡片头部配色 → 语义。颜色不是装饰，是「这条要不要停下看」的信号。
 *
 * ── 2026-10-06 重排（委托方两条要求：回执不要灰色、任何两类不许撞色）──────
 * 起因是回执卡（`receipt`）与能力边界卡（`capability-boundary`）**都是 grey** ——
 * 而回执是守衡发得最多的一张（「正在处理，请稍等」），于是最常看到的那张卡
 * 长得像一张存档卡。
 *
 * 要的是**淡暗粉**，参照 `https://momcozy.com/`。粉色不是猜的，是该站 CSS
 * 自定义属性里的实测值：`--brand-color: #9B626C`（灰调玫粉）。但飞书
 * `header.template` 的枚举里**没有粉色**（见 TEMPLATES），最接近的只有 `carmine`。
 *
 * `carmine` 原先是 `alert` 的，所以这次是**一次连锁重排**，不是改一个值：
 *
 *     receipt          grey    → carmine   （要粉色，占掉 carmine）
 *     alert            carmine → red       （让位；而且「我这侧坏了」本来就是错误色）
 *     correction       red     → orange    （让位；警告色）
 *     find-nothing     orange  → yellow    （让位；注意色）
 *
 * 后三行是**被传递性逼出来的**，不是顺手改的：`receipt` 拿走的那个值必须有出处，
 * 而每一站都不能停在一个已被占用的色上。重排后 **10 类 10 个互不相同的色**
 * （原来是 10 类 9 色，grey 撞了两次）—— 这条不变量由
 * `node tools/verify_cards.mjs` 的 **J9a** 守着，不是靠这份注释。
 */
export const TONE = {
  'query-answer': 'blue',        // 常规问答，可以略过
  'correction': 'orange',        // 我说错了，必须看
  'capability-boundary': 'grey', // 能力边界，存档性质
  'find-nothing': 'yellow',      // 没找到，需要你补信息
  'cannot-read': 'wathet',       // 输入我读不了
  'receipt': 'carmine',          // 只确认收到 —— 淡暗粉（momcozy 品牌色族）
  'turn-diff': 'violet',         // 同一问题的两次回答不一样
  'evidence': 'green',           // 证据陈列
  'alert': 'red',                // 我这侧坏了
  'decision': 'purple',          // 要你做决定
};

/**
 * 元素级 `background_style` 的**闭集白名单**。
 *
 * 为什么要有这一条：表头那 13 个枚举值里没有粉色，所以「淡暗粉」只能落在
 * **元素级底色**上（色阶后缀 `-50`…`-900` 与自定义 RGBA 只有元素级吃）。
 * 而 `background_style` 此前**从来没有被校验过** —— 写什么发什么，
 * 正是 AGENTS.md §2.4 说的「没有执行点的约束」。
 *
 * 诚实声明（2026-10-06 探针）：飞书对**未知取值是静默忽略**的 —— 表头上
 * `turquoise` / `pink` / `carmine-50` / `red-50` / `carmine-100` / `default`
 * 六个全部 `code=0` 发送成功（发完即撤），渲染成什么样接口不告诉你。
 * 所以这份白名单**不是**「服务端接受什么」，而是「我们验过人眼、准用哪些」：
 * 加一个值必须同时说得出它在哪个群里被人看过。
 */
export const BACKGROUND_STYLES = new Set([
  'grey',       // 注脚/字段排的既有底色（探针 8/10 通过）
  'carmine-50', // 回执卡的淡暗粉底 —— 与 TONE.receipt 同族
]);

/** 结论行的长度上限（字符）。超过说明结论没提炼出来，退化成正文了。 */
export const VERDICT_MAX = 60;
/** 单行边界声明的长度上限。超过说明又在写段落，不是在写边界。 */
/**
 * 卡片正文里允许出现的**顶层 markdown 块**数上限，防复读。
 *
 * 口径（2026-09-22 定，写在代码里而不是文档里）：
 *   「段落」只数 `body.elements` **顶层**的 `markdown` 块。
 *   `hr` 是分隔线、`collapsible_panel` 是收起区（本来就不占观感）、
 *   `column_set` / 字段排是字段表 —— 都不算段落。
 *
 * 值 = **实测上界**，不是拍出来的：11 张样例卡的顶层 markdown 块数最大是 4
 * （`correction` 与 `find-nothing` 各 4，其余 ≤3），所以取 4。
 * 原值 3 在三种口径下都拦不到东西（顶层块上界 4 / 承载正文块 6 / 全部 elements 7），
 * 而且**整个仓库没有一行代码拿它做比较** —— 正是 §2.4 点名的那个病。
 * 复现：`grep -rn MAX_SECTIONS tools/`，以及 `node tools/verify_cards.mjs` 的 J1。
 *
 * 执行点：`envelope.mjs` 的 `capSections()`，由 `toCardOrText()` 对建好的卡调用；
 * 超出的段落**搬进折叠区**，不丢字符（§2.4「搬是搬，砍是砍」）。
 */
export const MAX_SECTIONS = 4;

/* ═══════════════════════════ 子元素构造器 ═══════════════════════════ */

/** 纯文本节点（header / button 的 text 字段要这个形态，不是字符串） */
export const t = (content) => ({ tag: 'plain_text', content: String(content) });

/** 正文 markdown 块 */
export const md = (content) => ({ tag: 'markdown', content: String(content) });

export const hr = () => ({ tag: 'hr' });

/**
 * 原生表格（探针 3/7 通过）。
 * ★ 这是本次最大的收益：守衡 42% 的回复含数据表，以前只能当纯文本竖线发出去。
 * 注意 rows 的每一项是**对象**不是数组：{列名: 值}，列名须与 columns[].name 一致。
 */
export function table(columns, rows) {
  return {
    tag: 'table',
    columns: columns.map((c) => (typeof c === 'string'
      ? { name: c, display_name: c, data_type: 'text' }
      : { data_type: 'text', ...c })),
    rows: rows.map((r) => (Array.isArray(r)
      ? Object.fromEntries(columns.map((c, i) => [typeof c === 'string' ? c : c.name, r[i] ?? '']))
      : r)),
  };
}

/**
 * 分栏（探针 4/7 通过）。用于「能做 / 做不到」这类对照。
 * background_style: grey 是 note 被移除后的**替代注脚形态**（探针 8/10 通过）。
 */
export function columns(cols, opts = {}) {
  return {
    tag: 'column_set',
    flex_mode: opts.flexMode ?? 'none',
    ...(opts.backgroundStyle ? { background_style: opts.backgroundStyle } : {}),
    ...(opts.horizontalSpacing ? { horizontal_spacing: opts.horizontalSpacing } : {}),
    columns: cols.map((c) => ({
      tag: 'column',
      width: 'weighted',
      weight: c.weight ?? 1,
      elements: [md(c.content)],
    })),
  };
}

/**
 * 「字段对象」里哪个键算**标签**、哪个算**值** —— **唯一真源**。
 *
 * ★★ 2026-10-16（真单第 8/9 张 PASS 卡，Owner：「按照 prd 一句话结论，现在格式不对」）：
 *   登记表 `registry.mjs` 的样例写的是 `{label, value}`，
 *   而**模型实际 85/85 次全写 `{name, value}`**（批跑会话里全量数的，`label` 一次都没出现过）。
 *   而 `fieldRow` 原先只认 `f.label` ⇒ `s(undefined)` ⇒ 落 `（未填）`。
 *   ⚠️ 这与 FIX-022 是**同一个病**（那次 `flat1` 也是「模型用的键不是我以为的那一个」），
 *     区别只是它站在**第三个执行点**上（`flat1` → `carryCardText` → 这里）。
 *     ⇒ 治法不是再补一处 `??`，而是**把键表立成唯一真源**，两个函数都从这儿读。
 */
export const LABEL_KEYS = ['label', 'name', 'title', 'key'];
export const VALUE_KEYS = ['value', 'note', 'content', 'text'];

/**
 * 一个「字段」→ `{label, value}`（两样都是**已经文本化**的字符串）。
 *
 * `label` 认不出时返回**空串**（不是 `（未填）`）：一格没有名字**不等于缺字段**，
 * 它只是「这一格本来就只有一个值」。`（未填）` 那一档留给**值真的缺了**的场合。
 */
export function fieldPair(v) {
  if (v === null || v === undefined) return { label: '', value: '' };
  if (typeof v !== 'object' || Array.isArray(v)) return { label: '', value: flat1(v).trim() };
  const lk = LABEL_KEYS.find((k) => k in v && flat1(v[k]).trim());
  if (!lk) return { label: '', value: flat1(v).trim() };
  const rest = Object.entries(v).filter(([k]) => k !== lk);
  const other = VALUE_KEYS.map((k) => rest.find(([r]) => r === k)).find(Boolean) ?? rest[0];
  return { label: flat1(v[lk]).trim(), value: other ? flat1(other[1]).trim() : '' };
}

/** 一格字段排（用于边界声明：一行放 3–4 个短字段，而不是三句解释） */
export function fieldRow(fields, opts = {}) {
  // ★ 2026-10-14：`f.value` 直接插进模板字面量，模型给对象就又是 `[object Object]`
  //   （同一个病根，只是换了一张卡）。走 `s()` 收口。
  // ★★ 2026-10-16：**没有标签就不印标签格**。原先无论认不认得出标签都先印一行
  //   `s(f.label)` —— 认不出时那一行正是 `（未填）`，卡面于是变成「（未填）␤内容」交替
  //   （真单 4 张 PASS 卡，每张 3–4 组）。有标签、而**值缺了**时才落 `（未填）`。
  return columns(
    fields.map((f) => {
      const { label, value } = fieldPair(f);
      return { content: label ? `**${label}**\n${s(value)}` : s(value) };
    }),
    { backgroundStyle: 'grey', horizontalSpacing: '8px', ...opts },
  );
}

/**
 * 通栏色带 —— 把若干个元素放进一条**带底色**的整宽栏里。
 *
 * 与 `columns()` 的区别：`columns()` 是按格分栏（每格一段 markdown），
 * 这个是**一格通栏**、里面可以塞任意元素（markdown / 表格 / 字段排），
 * 用途是给整块正文一个底色。回执卡的淡暗粉底就是它。
 *
 * `style` 必须出自 `BACKGROUND_STYLES`（`validateCard` 会拦）。
 */
export function band(elements, style) {
  const els = (Array.isArray(elements) ? elements : [elements])
    .map((e) => (typeof e === 'string' ? md(e) : e));
  return {
    tag: 'column_set',
    flex_mode: 'none',
    ...(style ? { background_style: style } : {}),
    columns: [{ tag: 'column', width: 'weighted', weight: 1, elements: els }],
  };
}

/** 折叠面板（探针 5/7 通过）。长证据默认收起——这是「中位数 791 字」的直接解法。 */
export function collapsible(title, inner, expanded = false) {
  return {
    tag: 'collapsible_panel',
    expanded,
    header: {
      title: md(title),
      vertical_align: 'center',
      icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' },
      icon_position: 'right',
      icon_expanded_angle: -180,
    },
    elements: inner.map((e) => (typeof e === 'string' ? md(e) : e)),
  };
}

/**
 * 按钮（探针 10/10：裸放，不要 action 容器）。
 * ★ 诚实声明：**回执没接住**。ws_daemon 收到 card.action.trigger 只记日志，
 * 不做任何事。所以 value 里带上明确意图，等回调真的接通了再谈交互。
 */
export function button(label, value = {}, type = 'default') {
  return { tag: 'button', text: t(label), type, value };
}

/* ═══════════════════════════ 十类模版 ═══════════════════════════ */

/**
 * 每个构造器都是纯函数：吃一个 data 对象，吐一张卡。
 * 缺字段不抛异常——该出现的位置显示「（未填）」占位，让缺什么在群里看得见，
 * 而不是静默省略（静默省略正是那条「等于没答」的 434 字回复的成因）。
 */
const NA = '（未填）';

/**
 * 一个值 → 一行**人能读的文字**。`s()` 的底座，也是本项目**唯一**的文本化执行点。
 *
 * ★ 2026-10-14 加。起因是一张真发出去的卡（`ws_outbound.jsonl:721`，私聊
 *   「你可以回答什么问题」）：`capability-boundary` 的能做 7 条 / 受限 6 条 /
 *   做不到 6 条，**十九条全是 `[object Object]`**，整张卡等于没答。
 *
 *   根因不是模型写错，而是**渲染端对对象零防御**：旧代码是
 *   `` d.can.map((x) => `- ${x}`) `` —— 模板字面量对任何对象一律 `String(x)`，
 *   于是「模型把一条能力写成 `{能力, 边界}`」这种完全合理的输出，
 *   在卡上就变成十九个 `[object Object]`。同类隐患遍布所有 `s(d.xxx)` 调用点
 *   （`verdict` / `evidence` / `fields[].value` … 模型给对象就一样烂）。
 *
 *   口径（与 `envelope.carryCardText()` 同一套写法，改一处必须改两处）：
 *     · 对象 ⇒ `键：值`，多键用 `；` 连 —— **键名不丢**，因为模型用键名表达
 *       「能力 / 边界」这种区分，抹掉键名就等于替它做了取舍；
 *     · 数组 ⇒ 逐项摊平，嵌套项用换行（在正文格里换行是列点，不会跑版）；
 *     · 认得出 `{label, value}` / `{title, content}` 这两种既有约定就优先用，
 *       与 `carryCardText()` 对齐；认不出才按键值平铺 —— 不猜含义。
 *
 *   ★ 反例（**不许**出现的形状）：`String({})` = `[object Object]`。
 *     那是故障信号进群，比「（未填）」和格式难看都严重得多。
 *
 *   ⚠️ `flat1` 的契约是「**摊平**」，不是「决定空值怎么显示」：摊完是空就返回空串，
 *      由 `s()` 统一落 `（未填）` 占位。两件事分开，占位口径才只有一处。
 *      （写这组时真踩过一次：让 `flat1` 直接吐 `NA`，于是 `{能力:'', 边界:''}`
 *       摊成 `能力：（未填）；边界：（未填）` —— 一个空格子被印了两遍。）
 *
 *   ★★ 2026-10-15：**导出**。`envelope.mjs::carryCardText()` 现在 import 这一份。
 *      原先两处各写一份，靠一句注释「改一处必须改两处」守着 —— 当天就守输了：
 *        · 卡面那条路读 `v.value` ⇒ 九个 `（未填）`（真单 16:24，已修）；
 *        · 换卡搬迁那条路照旧读 `x.value` ⇒ 换壳之后印九个 `undefined`（**同一时刻仍在**）。
 *      同一份模型输出、同一个病，修了一处没修另一处，而 `verify_cards` **317 项全绿**
 *      —— 因为搬迁那条路一条判据都没喂过。
 *      ⇒ 现在只留这一份实现：改一处就是改全部，不再依赖谁记得住那句话。
 */
export const flat1 = (v) => {
  if (Array.isArray(v)) return v.map(flat1).filter(Boolean).join('\n');
  if (v && typeof v === 'object') {
    // 键值对：**空值整条丢掉**，不留「`能力：`」这种挂着键名、值没了的残句
    // （残留比缺失更难读：人以为有内容，其实冒号后面什么都没有）。
    const kv = (k, val) => {
      const t = flat1(val).trim();
      return t ? `${k}：${t}` : '';
    };
    // ★★ 2026-10-15 **修一行真 bug**（真单：私聊 16:24 那张「我能做什么」卡，三栏全是「（未填）」）：
    //   模型给的形状是 `{label, note}`（十九处都这样），而这里写的是 **`v.value`** ——
    //   于是 `note` 永远读不到、`label` 被当成**键名**拼进 `kv()` 的查找对象里
    //   ⇒ `kv('列目录 / 找文件', undefined)` ⇒ `flat1(undefined)=''` ⇒ 返回空串
    //   ⇒ `s()` 落 `（未填）`。**每一栏都变成「（未填）」，而卡本身不报错、不降级。**
    //   判据：`verify_cards` 的 J17a–f（2026-10-14 为 `[object Object]` 那次写的）
    //   只喂了 `{能力, 边界}` 与 `{label, value}` 两种形状，**没喂 `{label, note}`**
    //   —— 模型真正用的那一种恰好漏在外面。
    if ('title' in v && 'content' in v) return `【${flat1(v.title)}】${flat1(v.content)}`;
    // ★★ 2026-10-16：标签键**不再只认 `label`** —— 见 `LABEL_KEYS` 头注
    //   （模型给字段时 85/85 次写的是 `name`，`label` 一次都没出现过）。
    //   ⚠️ 这一条必须排在 `{title, content}` **之后**：`title` 也在 `LABEL_KEYS` 里，
    //     排前面会把 `【标题】正文` 那种格式吃掉、变成 `标题：正文`。
    const lk = LABEL_KEYS.find((k) => k in v && flat1(v[k]).trim());
    if (lk) {
      // 取值按**模型实际用的键**依次认：`note`（能力卡真单）→ `value`（登记表约定）→ 其余单键
      const rest = Object.entries(v).filter(([k]) => k !== lk);
      const other = VALUE_KEYS.map((k) => rest.find(([r]) => r === k)).find(Boolean) ?? rest[0];
      return other ? kv(flat1(v[lk]), other[1]) : flat1(v[lk]);
    }
    return Object.entries(v).map(([k, vv]) => kv(k, vv)).filter(Boolean).join('；');
  }
  return v === undefined || v === null ? '' : String(v);
};

const s = (v) => flat1(v).trim() || NA;

const card = (template, title, subtitle, elements) => ({
  schema: '2.0',
  config: { update_multi: true },
  header: { title: t(title), ...(subtitle ? { subtitle: t(subtitle) } : {}), template },
  body: { elements },
});

/** 01 问答 · 一问一答，结论在标题里 */
export function queryAnswer(d = {}) {
  const els = [md(s(d.verdict))];
  if (d.reasoning) els.push(md(s(d.reasoning)));
  if (d.fields?.length) els.push(fieldRow(d.fields));
  if (d.evidence?.length) els.push(collapsible(`证据 · ${d.evidence.length} 条`, [s(d.evidence.join('\n'))]));
  return card(TONE['query-answer'], s(d.title ?? d.verdict), d.subtitle, els);
}

/** 02 数据 · 行是记录，列是字段 */
export function dataTable(d = {}) {
  const els = [];
  if (d.verdict) els.push(md(s(d.verdict)));
  if (d.columns?.length && d.rows?.length) els.push(table(d.columns, d.rows));
  else els.push(md(`*（没有可列的行 —— 这次查询返回 0 条，不是我没画）*`));
  if (d.note) els.push(md(s(d.note)));
  if (d.fields?.length) els.push(fieldRow(d.fields));
  return card(TONE['query-answer'], s(d.title), d.subtitle, els);
}

/** 03 更正 · 我说错了，第一行就是错在哪 */
export function correction(d = {}) {
  const els = [md(`**错在哪**：${s(d.wrong)}`), md(`**正确的是**：${s(d.right)}`)];
  if (d.cause) els.push(md(`**为什么错**：${s(d.cause)}`));
  if (d.fields?.length) els.push(fieldRow(d.fields));
  return card(TONE['correction'], s(d.title ?? '我上一条说错了'), d.subtitle, els);
}

/** 04 能力边界 · 「你能做什么」的固定应答 */
export function capabilityBoundary(d = {}) {
  const els = [md(s(d.verdict ?? '按「能做 / 受限 / 做不到」三栏给，不解释原因。'))];
  const cols = [];
  // ★ 2026-10-14：这三行原先写的是 `` `- ${x}` `` —— 模板字面量对对象一律
  //   `String(x)` ⇒ 模型把一条能力写成 `{能力, 边界}` 时，卡上就是十九个
  //   `[object Object]`（真单见 `ws_outbound.jsonl:721`）。改走 `s()`，
  //   让它吃字符串吃对象都塌成一行人话。
  const list = (items) => items.map((x) => `- ${s(x)}`).join('\n');
  if (d.can?.length) cols.push({ content: `**能做**\n${list(d.can)}` });
  if (d.limited?.length) cols.push({ content: `**受限**\n${list(d.limited)}` });
  if (d.cannot?.length) cols.push({ content: `**做不到**\n${list(d.cannot)}` });
  if (cols.length) els.push(columns(cols));
  if (d.evidence) els.push(collapsible('依据', [s(d.evidence)]));
  return card(TONE['capability-boundary'], s(d.title ?? '我能做什么'), d.subtitle, els);
}

/** 05 没找到 · 「查不到」必须带上查了哪里，否则等于没说 */
export function findNothing(d = {}) {
  const els = [md(`**结论**：没找到。不是「可能没有」，是**在我查过的范围内一条都没有**。`)];
  if (d.paths?.length) {
    els.push(md(`**查过的地方**（${d.paths.length} 处）`));
    els.push(table(['位置', '怎么查的', '结果'], d.paths.map((p) => [p.where, p.how, p.result ?? '0 命中'])));
  }
  if (d.tried) els.push(collapsible('检索动作明细', [s(d.tried)]));
  if (d.nextStep) els.push(md(`**需要你补什么**：${s(d.nextStep)}`));
  return card(TONE['find-nothing'], s(d.title ?? '没找到'), d.subtitle, els);
}

/** 06 读不了 · 非文字输入、已撤回、窗口之外 */
export function cannotRead(d = {}) {
  const els = [md(s(d.verdict))];
  if (d.item) {
    els.push(table(['项', '值'], [
      ['类型', s(d.item.kind)],
      ['谁发的', s(d.item.from)],
      ['什么时候', s(d.item.at)],
      ['内容', d.item.content ?? '**取不到**'],
    ]));
  }
  if (d.why) els.push(md(`**为什么**：${s(d.why)}`));
  if (d.alternative) els.push(md(`**你可以**：${s(d.alternative)}`));
  return card(TONE['cannot-read'], s(d.title ?? '这条我读不了'), d.subtitle, els);
}

/**
 * 07 回执 · 只确认，不解释。越短越好
 *
 * ── 2026-10-06 上色（委托方指定）────────────────────────────────────────
 * 表头 `carmine`（见 `TONE`），正文那句话坐在一条 `carmine-50` 通栏色带上 ——
 * 也就是委托方在 6 张色卡里挑的 **D**（「carmine 表头 + carmine-50 淡粉色带」）。
 * 表头单独上色会显得只有顶部一条，正文再压一道底色才读得出「整卡是淡粉的」。
 *
 * 这是**唯一**一张自带底色的卡：`grey` 色带仍是注脚（`fieldRow`）的既有语义，
 * 两者不要混。字段排跟着走粉色，否则一条灰格子会压在粉底上。
 */
export function receipt(d = {}) {
  const els = [band([md(s(d.verdict ?? '收到了。'))], 'carmine-50')];
  if (d.fields?.length) els.push(fieldRow(d.fields, { backgroundStyle: 'carmine-50' }));
  if (d.note) els.push(md(s(d.note)));
  return card(TONE['receipt'], s(d.title ?? '已收到'), d.subtitle, els);
}

/** 08 对比 · 同一问题两次回答不一样时，把差异摆出来 */
export function turnDiff(d = {}) {
  const els = [md(`**差异**：${s(d.verdict)}`)];
  const rows = [];
  if (d.before !== undefined) rows.push(['上一次', s(d.before)]);
  if (d.after !== undefined) rows.push(['这一次', s(d.after)]);
  if (rows.length) els.push(table(['项', '值'], rows));
  if (d.cause) els.push(md(`**为什么变**：${s(d.cause)}`));
  if (d.fields?.length) els.push(fieldRow(d.fields));
  return card(TONE['turn-diff'], s(d.title ?? '跟上一次答得不一样'), d.subtitle, els);
}

/** 09 证据 · 结论很短，证据很长 —— 默认收起 */
export function evidence(d = {}) {
  const els = [];
  if (d.verdict) els.push(md(s(d.verdict)));
  // ★★ 2026-10-26（Owner 贴出 10-21 成品：「这是我想要的输出模版」）：
  //   **≥3 的汇总块不再进 `body`**，与 <3 一样走 `groups`，组标题就是「逐条问题」
  //   —— 模版第二行是它，Owner 的三段成品每段都有。
  //   （10-21 曾把这一支送进 `body`（`isSummaryOnlyBlock()`），理由是「中间不该有小标题」；
  //     10-26 按 Owner 贴的形状撤回那次。`body` 这个格本身保留 —— 模型自己写的正文仍用它。）
  //   `isSummaryOnlyBlock()` 仍导出，但现在**没有调用方拿它去分流**。
  const _body = s(d.body).replace(/[（(]\s*未填\s*[）)]/g, '').trim();
  if (_body) els.push(md(_body));
  // ★ 2026-10-15：**没有分组、也没有 `content` 时，不许造一个空组**。
  //   原先这里无条件造 `[{title:'证据', content: s(d.content)}]` —— `d.content` 缺省时
  //   `s()` 把它变成空串 ⇒ 多出一个**空折叠区**（标题「证据」、点开什么都没有）。
  //   实测来路：PASS（问题数 0）那类评审单**本来就没有逐条块**，
  //   旧判据又把它判成「不是评审单」，两条叠在一起正好走到这个分支。
  //   ★ 再补一刀：**占位符不算内容**。实测那条真单折出来的是「证据 →（未填）」——
  //     一个点开什么都没有的折叠区，读起来像「这里有东西但没写」，比不显示更糟。
  const _c = s(d.content).replace(/[（(]\s*未填\s*[）)]/g, '').trim();
  const groups = d.groups?.length ? d.groups
    : (_c ? [{ title: '证据', content: s(d.content) }] : []);
  for (const g of groups) {
    // ★ 2026-10-08：`count` 是**可选**字段 —— 有才拼，没有就只印标题。
    //   改前是 `${g.title} · ${g.count ?? ''}`.trim()，两个毛病（10/07–10/08 实发多张卡）：
    //     ① `count` 缺省时留下一个**悬空的分隔符** —— 群里出现过
    //        「原始回答（原「decision」卡，逐字搬） ·」；
    //     ② `count: 0` 那种占位印成「PRD §5.3 结论块 · 0」，而同一块正文写着
    //        「共发现 3 处必须修改」 ⇒ **标题说 0、正文说 3**，同一张卡自相矛盾。
    //   计数只在**有结构化的真值**时才给（宁可没有，也不印一个假的）。
    const hasCount = g.count !== undefined && g.count !== null && g.count !== '';
    els.push(collapsible(hasCount ? `${g.title} · ${g.count}` : String(g.title ?? ''),
                         [s(g.content)], g.expanded ?? false));
  }
  if (d.fields?.length) els.push(fieldRow(d.fields));
  return card(TONE['evidence'], s(d.title ?? '证据'), d.subtitle, els);
}

/** 10 告警 · 我这侧坏了。绝不允许把内部记录当内容发出去 */
export function alert(d = {}) {
  // what 给默认值，理由和 impact 一样：`envelope.mjs` 发现 what 里写了工具名时
  // 会把它整段搬进 internal（那正是我们要的），搬完 what 就空了。
  // 不给默认值的话，群里会出现一张「发生了什么：（未填）」的卡 ——
  // 把内部记录拦住，却把话说成半句，等于换了一种坏法。
  const els = [md(`**发生了什么**：${s(d.what ?? '刚才那条回复是故障输出，等于没答。')}`)];
  els.push(md(`**对你有什么影响**：${s(d.impact ?? '这次的问题没答上。')}`));
  if (d.internal) els.push(collapsible('内部详情（排查用）', [s(d.internal)]));
  if (d.fields?.length) els.push(fieldRow(d.fields));
  if (d.retry) els.push(md(`**你可以**：${s(d.retry)}`));
  return card(TONE['alert'], s(d.title ?? '我这侧出故障了'), d.subtitle, els);
}

/** 11 征询 · 要你做决定。一次只问一件（AGENTS.md 第一节就是这条） */
export function decision(d = {}) {
  const els = [md(`**要你定的事**：${s(d.ask)}`)];
  if (d.options?.length) {
    els.push(table(['选项', '代价 / 影响'], d.options.map((o) => [o.label, o.cost ?? '—'])));
  }
  if (d.recommend) els.push(md(`**我的建议**：${s(d.recommend)}`));
  if (d.fields?.length) els.push(fieldRow(d.fields));
  return card(TONE['decision'], s(d.title ?? '有一件事要你定'), d.subtitle, els);
}

/* ═══════════════════════════ 校验器 ═══════════════════════════ */

/**
 * 本地校验：飞书要发的卡片，先在这里过一遍。
 *
 * 为什么必须本地做：`cardkit.v1.card.create`（官方的卡片校验入口）被权限挡住 ——
 * 实测 code=99991672，缺 `cardkit:card:write` scope，而且它的权限检查在 schema
 * 校验**之前**，所以拿不到 schema 诊断（2026-09-18 实测三种卡片，一律同一个权限错）。
 * 在拿到那个 scope 之前，本地白名单是唯一能提前拦住「整卡被拒 = 回复丢失」的闸。
 *
 * @returns {{ok:boolean, errors:Array<{path:string,msg:string}>, warnings:Array}}
 */
export function validateCard(c) {
  const errors = [];
  const warnings = [];
  const E = (p, m) => errors.push({ path: p, msg: m });
  const W = (p, m) => warnings.push({ path: p, msg: m });

  if (!c || typeof c !== 'object') return { ok: false, errors: [{ path: '', msg: '不是对象' }], warnings };
  if (c.schema !== '2.0') E('schema', `必须是 '2.0'（现在是 ${JSON.stringify(c.schema)}）`);
  if (!c.config) W('config', '缺 config；建议 { update_multi: true } 以便后续原地更新');
  if (!c.header?.title?.content) E('header.title.content', '缺卡片标题');

  const tpl = c.header?.template;
  if (tpl !== undefined && !TEMPLATES.includes(tpl)) {
    E('header.template', `未知配色 ${JSON.stringify(tpl)}；实测可用：${TEMPLATES.join(', ')}`);
  }
  if (c.header?.title?.tag && c.header.title.tag !== 'plain_text') {
    // 实测：header.title 只吃 plain_text。用 markdown 会整卡被拒。
    E('header.title.tag', `header 的 title/subtitle 只接受 plain_text，收到 ${c.header.title.tag}`);
  }
  if (!Array.isArray(c.body?.elements)) {
    E('body.elements', '缺 body.elements（V2 的正文在 body 下，不是顶层 elements）');
    return { ok: errors.length === 0, errors, warnings };
  }

  const walk = (els, p) => {
    if (!Array.isArray(els)) { E(p, '应为数组'); return; }
    els.forEach((el, i) => {
      const q = `${p}[${i}]`;
      if (!el || typeof el !== 'object') { E(q, '不是对象'); return; }
      const tag = el.tag;
      if (!tag) { E(q, '缺 tag'); return; }
      if (REMOVED_IN_V2[tag]) { E(`${q}.tag`, `V2 已移除该元素：${REMOVED_IN_V2[tag]}`); return; }
      if (!ALLOWED_TAGS.has(tag)) { E(`${q}.tag`, `不在实测白名单里：${tag}。白名单：${[...ALLOWED_TAGS].join(', ')}`); return; }

      // 底色只许出自登记过的闭集。飞书对未知取值是**静默忽略**的
      // （实测：表头写 `pink` / `carmine-50` 也 code=0），所以错值不会报错、
      // 只会安静地变成另一个颜色 —— 唯一能拦住它的就是这里。
      if (el.background_style !== undefined && !BACKGROUND_STYLES.has(el.background_style)) {
        E(`${q}.background_style`,
          `未登记的底色 ${JSON.stringify(el.background_style)}；闭集：${[...BACKGROUND_STYLES].join(', ')}`
          + '（新增一个值，必须说得出它在哪个群里被人眼看过）');
      }

      if (tag === 'markdown' && typeof el.content !== 'string') E(`${q}.content`, 'markdown 的 content 必须是字符串');
      if (tag === 'collapsible_panel') {
        if (!el.header?.title?.content) E(`${q}.header.title`, '折叠面板缺标题');
        if (!Array.isArray(el.elements)) E(`${q}.elements`, '折叠面板缺 elements');
        else walk(el.elements, `${q}.elements`);
      }
      if (tag === 'column_set') {
        if (!Array.isArray(el.columns) || el.columns.length === 0) E(`${q}.columns`, 'column_set 缺 columns');
        else el.columns.forEach((col, j) => {
          if (col.tag !== 'column') E(`${q}.columns[${j}].tag`, `column_set 的下级必须是 column，收到 ${col.tag}`);
          if (!Array.isArray(col.elements)) E(`${q}.columns[${j}].elements`, 'column 缺 elements');
          else walk(col.elements, `${q}.columns[${j}].elements`);
        });
        if (el.columns?.length > 4) W(`${q}.columns`, `${el.columns.length} 栏，手机上会挤；建议 ≤3`);
      }
      if (tag === 'table') {
        if (!Array.isArray(el.columns) || !el.columns.length) E(`${q}.columns`, 'table 缺 columns');
        if (!Array.isArray(el.rows)) E(`${q}.rows`, 'table 的 rows 必须是数组');
        else {
          const names = new Set((el.columns ?? []).map((x) => x.name));
          el.rows.forEach((r, j) => {
            if (Array.isArray(r)) E(`${q}.rows[${j}]`, 'rows 的每一项必须是对象 {列名: 值}；传数组会被服务端拒绝');
            else for (const k of Object.keys(r)) if (!names.has(k)) E(`${q}.rows[${j}].${k}`, `列名 ${k} 不在 columns 里（${[...names].join('/')}）`);
          });
        }
        if (el.rows?.length > 30) W(`${q}.rows`, `${el.rows.length} 行，群消息里过长；建议拆卡或折叠`);
      }
      if (tag === 'button') {
        if (el.text?.tag !== 'plain_text') E(`${q}.text`, '按钮文字必须是 { tag: "plain_text", content }');
        // 探针 7/7 的实测：包一层 action 会被整卡拒绝，所以这里明确要求裸放
        W(`${q}`, '按钮回调在 ws_daemon 里只记日志、未接住（诚实声明，别让模版假装能交互）');
      }
    });
  };
  walk(c.body.elements, 'body.elements');
  return { ok: errors.length === 0, errors, warnings };
}

/**
 * 构建 + 摘符号 + 校验，一步到位。校验不过直接抛，别把坏卡发出去。
 *
 * ★ 2026-10-14（Owner）：「守衡的所有输出中不允许包含 `**` 星号」——
 *   卡片的正文也在这条之内。摘符号这一步放在**建完卡之后、校验之前**：
 *   · 建完之后 —— 模版自己写进去的 `**能查的我查完再说**` 这类也要摘（它不是模型写的，
 *     而 Owner 看到的那张回执卡上那句 `本次按**美国市场**口径审查` 正是**代码**写死的）；
 *   · 校验之前 —— 摘完的卡才是要发出去的那张，让 `validateCard` 校验它。
 *   实现只有一份：`agent/plain.mjs` 的 `plainifyCard()`（**别在这里再写一遍**）。
 */
export function build(kind, data) {
  const fn = BUILDERS[kind];
  if (!fn) throw new Error(`未知卡片类型：${kind}；可选：${Object.keys(BUILDERS).join(', ')}`);
  const c = plainifyCard(fn(data));
  const v = validateCard(c);
  if (!v.ok) {
    const msg = v.errors.map((e) => `  ${e.path}: ${e.msg}`).join('\n');
    throw new Error(`卡片 ${kind} 校验不过（共 ${v.errors.length} 处）：\n${msg}`);
  }
  return c;
}

/** 类型 → 构造器。键名同时是 CLI 的 --type 取值。 */
export const BUILDERS = {
  'query-answer': queryAnswer,
  'data-table': dataTable,
  'correction': correction,
  'capability-boundary': capabilityBoundary,
  'find-nothing': findNothing,
  'cannot-read': cannotRead,
  'receipt': receipt,
  'turn-diff': turnDiff,
  'evidence': evidence,
  'alert': alert,
  'decision': decision,
};

/** 构建器名 → 源文件里的函数名，verify_cards 用它核对登记表没写错 */
export const BUILDER_SOURCE_NAME = {
  'query-answer': 'queryAnswer',
  'data-table': 'dataTable',
  'correction': 'correction',
  'capability-boundary': 'capabilityBoundary',
  'find-nothing': 'findNothing',
  'cannot-read': 'cannotRead',
  'receipt': 'receipt',
  'turn-diff': 'turnDiff',
  'evidence': 'evidence',
  'alert': 'alert',
  'decision': 'decision',
};

export const __dirname = path.dirname(new URL(import.meta.url).pathname);
export const readSelf = () => fs.readFileSync(path.join(__dirname, 'cards.mjs'), 'utf8');

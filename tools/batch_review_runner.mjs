#!/usr/bin/env node
/**
 * batch_review_runner.mjs —— 本机批跑器：把一张表里的待审素材逐条走**守衡自己的**送审那条路，
 * 再用**守衡自己的身份**把结论发进指定会话（并把结论回填进表）。
 *
 * ── 为什么是这条路（2026-10-13，Owner 原话：「有权限不要说没权限」）────────────
 *
 *   守衡**自己有**发消息的权限（它一直在往那个私聊发主动提醒：`safeSend` → `feishu.sendMarkdown`，
 *   走的是它自己的 `client.im.message.create`），表读写你也给了。
 *   ⇒ 缺的从来不是权限，是**触发**。而触发可以由本机直接调它的内核产生：
 *
 *     `handleMessage()` → `runSubmissionGate()`
 *        （送审闸门 → 回执卡 → 链 → 模型侧 → 双轨合并 → §5.3 结论行）
 *     发那一步用它自己的 `client.im.message.create`（与 `reply-cards/index.mjs::sendCard` 同一条路）。
 *
 *   ⚠️ 先前我把它说成「要么你授权 `im:message`、要么你手动发」—— 那是**把路说窄了**：
 *      那条 `im:message` 只在「以**你的**身份发消息」时才需要，而这条路根本不用它。
 *
 * ── 三条边界（写清楚，别让下一个人以为它等同「你发一条消息」）──────────────────
 *
 *   ① 发出去的是**新消息**，不是「回复某一条」——本机跑没有可引用的真实 message id。
 *      形态（卡片 / §5.3 结论行进抬头 / 双轨计数）与正常回复**完全一致**，差别只在"挂在哪条下面"。
 *   ② 它用**独立会话键**跑模型（`chat_id = oc-batch-<tag>`），**不碰**你和守衡的那份私聊记忆 ——
 *      两个进程写同一个 session 文件会互相覆盖；顺带批跑也不会污染日常对话的上下文。
 *   ③ 它**不进守护进程**：批跑期间你照常和守衡聊天，两条路互不干扰。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────────
 *
 *   node tools/batch_review_runner.mjs --status              # 看进度
 *   node tools/batch_review_runner.mjs --limit 1 --dry-run   # 只打印要跑什么
 *   node tools/batch_review_runner.mjs --limit 1             # 真跑 1 条（证明路通）
 *   node tools/batch_review_runner.mjs --limit 5             # 试跑 5 条
 *   node tools/batch_review_runner.mjs --limit 0             # 全部（0 = 不限）
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { handleMessage } from './agent/agent.mjs';
import { bestImageVariant } from './agent/image_variant.mjs';
import * as videoMod from './agent/video.mjs';
import { client, sendMarkdown } from './agent/feishu.mjs';
import { toCardOrText } from './reply-cards/envelope.mjs';
import { recordSend } from './agent/outbound.mjs';
import * as lw from './agent/lark_write.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const LARK = path.posix.join(process.env.HOME ?? '', '.dsh/bin/lark-cli');
// ★ 2026-10-19：`let` —— `--state` 可把它指到本轮独立台账（不传则与改动前逐字相同）。
let STATE = path.join(ROOT, 'PMO/shouheng-state/batch-review.json');

// ── 默认值只写在这一个地方 ───────────────────────────────────────────────────
const BASE = 'RY2UbCRjXaeeWwscUPScVN5AnQc';        // 「内容治理问题描述」那个 Base
const TABLE = 'tblavfbMDMeRsulo';                  // 「内容治理数据采集」（80 行）
const CHAT = 'oc_TEST_P2P'; // 你和守衡的私聊
const SOURCE = 'batch-review';                      // 台账来源（已在 outbound.SOURCES 里登记）
const F = { id: '内容 ID', text: '采集数据', state: '状态', type: '内容类型' };
// 结论表的表名/字段与这张采集表**同名**（都照 PRD 那套）——回填就是按 `内容 ID` 把它们搬过来。
const RESULT_TABLE = 'tblCXPQVzfFWWCon';
const RESULT_FIELDS = ['Agent 结论', '状态', '问题数量', '置信度', '报告链接', '问题分类汇总'];
const NUM_FIELDS = new Set(['问题数量', '置信度']);
// ★★ 2026-10-15：**列被删了就跳过，并且要出声** ──────────────────────────────────
//   Owner 把采集表的「报告链接」列删了，而 `RESULT_FIELDS` 里还写着它 —— 写一个**不存在的字段名**
//   会让**整批 batchUpdate 被拒** ⇒ 结论/状态/数量/汇总**一个都落不下来**。
//   症状与「回填静默失败」长得一样，根因完全不同（那个是分页只读 200 行，这个是字段名不存在）。
//   判据用**读到的真字段清单**（`readRows()` 从采集表 meta 取），不硬编码列名。
let KNOWN_FIELDS = null;                  // 采集表真实字段清单（readRows() 填）
const SKIPPED_FIELDS = new Set();         // 因「表里没有这一列」被跳过的字段（写回结果里带出来）

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d;
};
const LIMIT = Number(val('--limit', '5'));
const DRY = has('--dry-run');
// ★★ 2026-10-19（Owner：「问题数量<3个的，也输出报告链接（**不要落库**，只限本次任务优化）」）：
//   `--report-only` = **只出报告、不落表、不发卡**：
//     · 不发消息（回执卡与结论卡都不发 —— 这一轮是补数据，不是跟人说话）；
//     · 不调 `writeBack()`（采集表一个字不写）；
//     · 配合环境变量 `SHOUHENG_REVIEW_TABLE=off` ⇒ 结论表也不写（那条闸在 `review_publish`）。
//   ⚠️ 它是**补数通道**，不是新的常规跑法：`--report-only` 缺省关，常规批跑行为一个字没变。
const REPORT_ONLY = has('--report-only');
// ★★ 2026-10-19（PRD 字数限制更新后重跑 80 条）：**链接写到指定那一列**，不覆盖历史列。
//   起因：采集表现在**同时有** `报告链接`（历史轮次）与 `10/19 报告链接`（本轮）两列，
//   而 `linkColumn()` 的默认判据取「叫 `报告链接` 的那一列」⇒ 重跑会把**上一轮的链接整列覆盖**。
//   ⇒ 加显式旗标；**不传就是原来的行为**（一个字节都不变），所以既有调用方不受影响。
const LINK_COL_ARG = String(val('--link-col', '') ?? '').trim();
// ★ 台账另存：本轮不改写 `batch-review.json`（那份是 10/13–10/16 的台账，
//   `采集-20261013/align_link_column_to_latest.py` 等脚本还在读它）。
const STATE_ARG = String(val('--state', '') ?? '').trim();
if (STATE_ARG) STATE = path.resolve(ROOT, STATE_ARG);

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { items: {} }; }
}
function saveState(st) {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  const tmp = `${STATE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(st, null, 2, ), 'utf8');   // 原子写：半份 JSON 等于进度全丢
  fs.renameSync(tmp, STATE);
}

/** 读一张表（**守衡自己的**应用身份：`--profile dsh-kb --as bot`）—— 不借任何新权限。 */
function readTable(table, { sortDesc = false } = {}) {
  // ★★ 2026-10-13 第五修（**这一条会让整批回填静默失效**）：
  //   结论表是**追加式**的（每次审查 `+record-create` 一～两行），跑到 20:06 已经是 **209 行**；
  //   而这里只读 `--page-size 200`（CLI 上限就是 200）⇒ `has_more=true`、**最新那几行不在这一页**。
  //   实测后果：`writeBack` 按 `publishedRowId` 在自己读到的 200 行里找不到刚写的那一行
  //   ⇒ 退到猜 ⇒ 报「结论表里这一单…都没有行」⇒ **采集表那一行没结果**。
  //   （那条读数长这样：`↳ 回填你的表：❌ 结论表里这一单（素材原文 ／ 自 … 起）都没有行 —— 不写`。）
  //   修法：**读结论表时按 `写入时间` 倒序** —— 我们要的那一行永远是**最新**的，倒序后必在第一页。
  //   边界：这只保证「最新 ≤200 行」内的行可见；更老的走 `--fill-all` 的文本口径。
  const args = ['--profile', 'dsh-kb', 'base', '+record-list',
    '--base-token', BASE, '--table-id', table, '--page-size', '200',
    '--as', 'bot', '--format', 'json'];
  if (sortDesc) args.push('--sort-json', '[{"field":"写入时间","desc":true}]');
  const out = execFileSync(LARK, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const d = JSON.parse(out);
  if (!d.ok) throw new Error(`读表失败：${JSON.stringify(d.error).slice(0, 300)}`);
  const dd = d.data, fields = dd.fields ?? [], ids = dd.record_id_list ?? [];
  const cell = (row, name) => {
    const i = fields.indexOf(name);
    if (i < 0) return '';
    const v = row[i];
    if (Array.isArray(v)) return v.map((x) => (x && typeof x === 'object' ? x.text ?? '' : String(x))).join('');
    return v == null ? '' : v;
  };
  return { fields, rows: (dd.data ?? []).map((row, n) => ({ record_id: ids[n] ?? null, row, cell: (name) => cell(row, name) })) };
}

/**
 * 采采表里那一列「报告链接」的**真实列名**（本表叫 `10/14重跑报告链接`）。
 *
 * ★ 2026-10-16：回填字段名是 `报告链接`，而列名带前缀 ⇒ 以前按名字对不上就整个跳过
 *   ⇒ **复跑新建的报告永远进不了那一列**（37 行「格内结论新一轮、点开是上一轮」）。
 *   这里只认「名字里含『报告链接』」的那一列；`KNOWN_FIELDS` 还没填时回 null（离线自证不拦）。
 */
function linkColumn() {
  if (!KNOWN_FIELDS) return null;
  // ★★ 2026-10-19：显式指定优先（`--link-col '10/19 报告链接'`）。
  //   为什么需要它：表里**同时存在** `报告链接`（历史轮次）与 `10/19 报告链接`（本轮）⇒
  //   默认判据「叫 `报告链接` 的那一列」会把上一轮那一列**整列覆盖**。
  //   指名的列**不存在就返回 null 并出声**（`SKIPPED_FIELDS`）—— 绝不退回去猜另一列。
  if (LINK_COL_ARG) {
    if (KNOWN_FIELDS.includes(LINK_COL_ARG)) return LINK_COL_ARG;
    SKIPPED_FIELDS.add(`链接列「${LINK_COL_ARG}」（表里没有这一列，本轮链接不写）`);
    return null;
  }
  return KNOWN_FIELDS.includes('报告链接')
    ? '报告链接'
    : (KNOWN_FIELDS.find((f) => /报告链接/.test(f)) ?? null);
}

/**
 * 采集表各字段的**数值类型**（`{字段名: type号}`）—— 唯一取法：**raw API**。
 *
 * ★★ 为什么不能按 `lark-cli base +field-list` 认（2026-10-19 实测，代价是整批回填被拒）：
 *   shortcut 把 **Url(15)** 与 **Text(1)** 都显示成字符串 `text`
 *   ⇒ 按它写「统一用对象式 `{link,text}`」在**文本**列上必炸：
 *   `1254060 TextFieldConvFail`，而且**整批 batchUpdate 被拒**
 *   （同一批里的 结论/状态/问题数量/置信度/汇总 **一个都没落下来**，看着像"回填静默失败"，
 *    根因完全不同）。实测那一次的日志逐字：
 *   `↳ 回填你的表：❌ TextFieldConvFail ｜ code=1254060`。
 *   raw API 才分得出：本表 `报告链接`=**15(Url)**、`10/19 报告链接`=**1(Text)**。
 */
let FIELD_TYPES = null;
function fieldTypes() {
  if (FIELD_TYPES) return FIELD_TYPES;
  const out = execFileSync(LARK, ['--profile', 'dsh-kb', 'api', 'GET',
    `/open-apis/bitable/v1/apps/${BASE}/tables/${TABLE}/fields`,
    '--params', '{"page_size":100}', '--as', 'bot', '--format', 'json'],
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const d = JSON.parse(out);
  if (d.ok === false) throw new Error(`读字段类型失败：${JSON.stringify(d.error).slice(0, 200)}`);
  const items = (d.data?.items ?? d.data?.data?.items ?? []);
  FIELD_TYPES = {};
  for (const f of items) FIELD_TYPES[f.field_name] = f.type;
  return FIELD_TYPES;
}

/**
 * 链接列该写**什么形状** —— 由 raw API 的 type 号决定，不靠名字猜。
 *   · type 15（超链接）⇒ **对象式** `{link, text}`（字符串会被拒 `1254068 URLFieldConvFail`）；
 *   · type 1（文本）  ⇒ **裸 URL 字符串**（对象式会被拒 `1254060 TextFieldConvFail`）。
 *     文本列里写 markdown `[x](y)` 会被当纯文本显示（黑字、点不开）⇒ **不许写 markdown**；
 *     裸 URL 由飞书客户端自行识别成可点链接。
 * 类型读不到 ⇒ **按对象式写**（与历史那一列一致），并把这件事记进"跳过"清单，**不静默**。
 */
function linkCell(url) {
  const col = linkColumn();
  let t = null;
  try { t = col ? fieldTypes()[col] ?? null : null; } catch { t = null; }
  if (t === 1) {
    SKIPPED_FIELDS.add(`链接列「${col}」是**文本**字段 ⇒ 写裸 URL（不是「内容审查报告」超链接样式）`);
    return String(url);
  }
  if (t == null) SKIPPED_FIELDS.add(`链接列「${col}」类型读不到 ⇒ 按超链接对象式写`);
  return { link: String(url), text: '内容审查报告' };
}

/** 把结论表里这一条的结果字段搬进采集表（**读回来再写**，不猜字段、不编值）。 */
async function writeBack(contentId, recordId, sinceMs, materialText = '', publishedRowId = null,
                         currentStatus = '', reportUrl = null, verdict = null,
                         { strict = false } = {}) {
  // ★ 认领方式**不是**按 `内容 ID`：链会给素材**自己编一个**（实测它是 `AD-20261013-001`，
  //   而不是采集表里的 `MC-AMZ-…`）—— 按内容 ID 找会一条都找不到（我第一版就是这么写的）。
  //   改成**按时间窗认领「这一轮刚出现的那一行」**：与 `review_publish.ensureReviewRow`
  //   自己的判据同源（它那句注释写着「判据是时间窗，不是内容 ID」）。
  const res = readTable(RESULT_TABLE, { sortDesc: true });
  // ★★ 认领顺序（2026-10-13 实测修）：**先按素材原文，再按时间窗**。
  //   为什么改：同一单在结论表里**可能有两行**（链侧 `feishu_publish` 自己也 upsert 一行，
  //   实测有的是空行 —— `问题数量=0`、`问题分类汇总` 空）。而时间窗取的是「窗口内最后一行」
  //   ⇒ 一旦链侧那行落在后面，回填就会把**空行**搬进采集表（实测第 2 条就是这么丢的依据块）。
  //   素材原文才是这一单真正的键（与 `--fill-all` 同一份判据，两处不许各写一套）。
  const norm = (t) => String(t ?? '').replace(/<br\s*\/?>/gi, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  // ★ 2026-10-13：**两个键**，不是一 个。
  //   图片行改走「真媒材」之后，链记的 `送审问题` 不再以图片 URL 开头，而是 post 正文
  //   （实测逐字：`[图片]图注：M5 Smart Wearable Breast Pump – …`）⇒ 只按 URL 前缀对，
  //   会命中**上一轮那条旧行**（真踩过：回填把上一轮的「2 处/212s」搬了回去，
  //   而新一轮其实是「6 处」，且依据里已经读到了**图上的奖项徽章**）。
  //   ⇒ 同时用「素材原文前缀」与「图注前缀」两个键，并**先按时间窗收口**。
  const stripTag = (t) => norm(clean(t)).replace(/^\[(图片|媒体|视频)\]/, '');
  const keys = (() => {
    const out = [norm(clean(materialText)).slice(0, 120)];
    if (imageUrlOf(clean(String(materialText ?? '')))) {
      // ★ 图注键**只取 40 字**：取 80 字时尾巴会落在「来源页 URL」那一段上，
      //   而结论表记的是**送审当时**那版（裸 URL / markdown 两种形态混着）⇒ 键在尾巴上分叉。
      //   40 字落在图注本身（`图注：M5 Smart Wearable Breast Pump – Upgraded`）里，稳。
      const cap = norm(clean(captionOf(String(materialText ?? '')))).slice(0, 40);
      if (cap.length >= 20) out.push(cap);
    }
    return [...new Set(out.filter(Boolean))];
  })();
  const inWindow = res.rows.filter((r) => {
    const t = Date.parse(String(r.cell('写入时间')));
    return Number.isFinite(t) && t >= sinceMs;
  });
  const byText = keys.length
    ? res.rows.filter((r) => { const q = stripTag(r.cell('送审问题'));
        return keys.some((k) => q.startsWith(k) || q.includes(k)); })
    : [];
  // 候选里挑**信息最全**的那一行（空行永远排在最后）
  const richest = (rows) => rows.slice().sort((a, b) => {
    const score = (r) => (String(r.cell('问题分类汇总') ?? '').length > 0 ? 2 : 0)
      + (Number(r.cell('问题数量') ?? 0) > 0 ? 1 : 0);
    return score(a) - score(b);
  }).pop();
  // ── 命中口径（2026-10-13 第二次修，两种错都踩过了，判据写成「两个坑一起躲」）──────
  //   坑① 只按「文本命中」：同一素材有**历史行**时认到旧行（实测：把上一轮的「2 处/212s」
  //        搬回采集表，而新一轮其实是「6 处」且读到了图上的奖项徽章）。
  //   坑② 只按「时间窗」：链侧 `feishu_publish` 自己 upsert 的那行**常常是空的**
  //        （`问题数量=0`、`问题分类汇总` 空），窗口内最后一行就是它 ⇒ 把空行搬回去
  //        （实测：把 `问题数量` 写成 0）。这条是原作者注释里就写过的坑。
  //   ⇒ 判据 = **文本命中 → 先滤掉空行 → 取最新**：
  //        · 空行 = 既没汇总、`问题数量` 又不 > 0 的行（链侧那行）；
  //        · 有内容的多行时取 `写入时间` 最新那行（本轮守衡自己落的那行）。
  const _score = (r) => (String(r.cell('问题分类汇总') ?? '').length > 0 ? 2 : 0)
    + (Number(r.cell('问题数量') ?? 0) > 0 ? 1 : 0);
  const _cands = byText.length ? byText : inWindow;
  const _rich = _cands.filter((r) => _score(r) > 0);
  const _pool = _rich.length ? _rich : _cands;
  const _guess = _pool.slice().sort((a, b) => (Date.parse(String(a.cell('写入时间'))) || 0)
    - (Date.parse(String(b.cell('写入时间'))) || 0)).pop();
  // ★★ 2026-10-13 第三修（**这一条才是根治**）：优先用**守衡自己报的那一行**
  //   —— `meta.publish.record_id`（内核里 `review_publish` 的返回，日志那行
  //   `🧭 落表：created｜reczz28MsKYevb19` 就是它）。
  //   为什么前面两次都在猜：媒体行**送进去的东西 ≠ 采集表里的素材原文** ——
  //     图片行发的是 `post`（链记的「送审问题」是**图注**）；
  //     视频行发的是 `media`（**根本没有正文**，链记的是一段生成出来的块头
  //     「【对方这条消息里附了视频，共 1 段。…】」）⇒ 文本键**结构上对不上**，
  //     时间窗又会捡到链侧那行空的。实测栽过两次（`问题数量` 先被写成 0、视频行被写成 PASS/0）。
  //   ⇒ 有 publishedRowId 就用它；没有（例如 `--backfill` 补历史）才退回猜。
  //   ★★ 2026-10-16（Owner：「3 只有你写，别人没写」＋ 80 行逐字段核对）：**常规批跑不再猜**。
  //     实测代价（拿 80 行逐字段核出来的）：猜错行 = 把**另一遍/上一轮**的字段搬进采集表 ——
  //     行22 搬回了上一轮的占位话术；行30/33/34/48/52 的数与**本轮报告**对不上
  //     （本轮报告 4/1/4/4/4，表里落的 3/2/3/2/3，而那与本单在结论表里的**另一遍**一致）。
  //     ⇒ `strict`（批跑路径）**只认本轮 `publishedRowId`**；认不到 ⇒ **不写**并**出声**。
  //       `--backfill` 那条历史补写的老路保留猜（它本来就没有本轮 id，写的是历史）。
  const strictHit = publishedRowId ? res.rows.find((r) => r.record_id === publishedRowId) : null;
  const hit = strictHit || (strict ? null : _guess);
  if (!hit) {
    return { ok: false, why: strict
      ? (publishedRowId
          ? `本轮结论表行 ${publishedRowId} 读不到（可能被清理）⇒ **不写**（不许猜另一行）`
          : '本单没拿到本轮结论表行 id（`publishedRowId` 为空）⇒ **不写**（不许猜另一行）')
      : `结论表里这一单（素材原文 ／ 自 ${new Date(sinceMs).toISOString()} 起）都没有行 —— 不写` };
  }
  const fields = dropHumanTerminalStatus(fieldsFrom(hit), currentStatus);
  // ── ★★ 2026-10-16：链接列**以本轮自己跑出来的那一份为准**（Owner 裁定「换成与格内同源的最新那份」）──
  //   为什么不能直接抄结论表那一格：`review_publish.ensureReviewRow` 对 `报告链接` 是
  //   「**只补空**」（那条规则防的是"新报告成孤儿"），于是**复跑新建的报告进不了结论表**，
  //   那一格永远是**上一轮**那一份 ⇒ 抄过来就是「格内结论新一轮、点开是上一轮」。
  //   本轮的报告 URL 就在手边（`out.meta.reportLink`），它才是与刚写进去的那几格同源的。
  //   · 有本轮报告 ⇒ 写本轮的；
  //   · **本轮没建报告（PASS：没有可并的条目）⇒ 把链接清掉** —— 与本表既有规则一致
  //     （「清空只走 PASS 那条规则」），否则会出现「格内 PASS/0、点开那份写着 4 处」。
  const LINK_COL = linkColumn();
  if (LINK_COL) {
    const u = String(reportUrl ?? '').trim();
    // ★★ 2026-10-16 修（Owner：「这一列有的黑字、有的蓝色可点」的**第二个**成因）——
    //   这里原先写的是 **markdown 字符串** `[内容审查报告](url)`。那一列是**超链接**字段：
    //     · 字段是「超链接」时，字符串会被拒（`1254068 URLFieldConvFail`）；
    //     · 字段被改成「文本」时，字符串能写进去，但飞书按**纯文本**渲染 ⇒ **黑字、点不开**
    //       —— 实测 2026-10-16 那 7 格就是这么来的（65 格历史数据是 URL 段，所以是蓝的）。
    //   ⇒ 统一写成**对象式** `{link, text}`（与那一列的历史形态、以及 `fieldsFrom()` 那条路一致）。
    // ★★ 2026-10-19 更正（本轮重跑实测，**上面那条只对「超链接」列成立**）：
    //   新列 `10/19 报告链接` 是**文本**字段（raw API `type=1`），写对象式 ⇒
    //   `1254060 TextFieldConvFail`，而且**整批 batchUpdate 被拒**（结论/状态/数量/汇总一个都没落）。
    //   根因：`lark-cli base +field-list` 把 Url(type 15) 与 Text(type 1) **都显示成 `text`**
    //   ⇒ 按 shortcut 的读法分不出这两种列。⇒ 形状改由 **raw API 的 type 号**决定（`linkCell`）。
    if (/^https?:\/\//.test(u)) fields[LINK_COL] = linkCell(u);
    else if (String(verdict ?? '').toUpperCase() === 'PASS') fields[LINK_COL] = '';
  }
  return writeFields(recordId, fields);
}

/**
 * PRD §8.2 的「状态：待审 / 已修改 / 已发布」里，**机器只拥有「待审」**；
 * 「已修改」「已发布」是人/内容方的动作 ⇒ 回填**不许**把它们改回「待审」。
 *
 * ★ 2026-10-15（Owner：「状态按照 prd…现在填的错的」）：这一格原先被写成三态
 *   （采集表 80/80 行、结论表 441/457 行），而回填器又把结论表那一格原样搬进采集表
 *   ⇒ 人的终态会被机器覆盖。判据与 `review_publish.HUMAN_TERMINAL_STATUS` **同一份口径**，
 *   这里只做「值是不是终态」这一件事，不另立标准。
 */
const HUMAN_TERMINAL_STATUS = ['已修改', '已发布'];
function dropHumanTerminalStatus(fields, currentStatus) {
  if (!('状态' in fields)) return fields;
  if (HUMAN_TERMINAL_STATUS.includes(String(currentStatus ?? '').trim())) {
    delete fields['状态'];
    SKIPPED_FIELDS.add('状态（人设终态，机器不许改回）');
    return fields;
  }
  // 机器档位照旧写：PRD 三档里机器只落「待审」（三态是 `Agent 结论` 的值域，不是这一格的）
  if (String(fields['状态'] ?? '').trim() !== '待审') {
    SKIPPED_FIELDS.add(`状态（源行给的是「${String(fields['状态']).slice(0, 12)}」，非 PRD 三档 ⇒ 不搬）`);
    delete fields['状态'];
  }
  return fields;
}

/** 从结论表的一行里取出要回填的那几格（**空的不写、URL 归一化**）—— 两处调用共用这一份判据。 */
function fieldsFrom(hit) {
  const fields = {};
  for (const name of RESULT_FIELDS) {
    // ★★ 2026-10-15：**表里没有这一列 ⇒ 跳过它，别让一个字段名把整批写毁掉** ──────────
    //   实测背景：Owner 删了采集表的「报告链接」列 ⇒ `RESULT_FIELDS` 里那一个名字成了非法字段名，
    //   batchUpdate 会整批被拒（与 200 行分页那个坑的症状一样、根因完全不同）。
    //   `KNOWN_FIELDS` 没填时（例如离线自证）**不拦**，行为与改动前逐字相同。
    if (KNOWN_FIELDS && !KNOWN_FIELDS.includes(name)) {
      // ★★ 2026-10-16：**"名字对不上"不等于"没有这一列"** —— 采集表那一列现在叫
      //   `10/14重跑报告链接`，而回填字段名是 `报告链接` ⇒ 上面那条跳过规则把它整个吞掉，
      //   于是**复跑新建的报告永远进不了那一列**。实测后果（Owner 2026-10-16 那句
      //   「飞书表格中的数据和报告都对齐」）：37 行「格内结论是新一轮的、
      //   链接点开却是上一轮那份」（例：第 17 行格内 1 处、点开那份写 4 处）。
      //   ⇒ 只对 `报告链接` 这一个字段兜底：找名字里含「报告链接」的那一列。
      //   ⚠️ 别的字段照旧「对不上就跳过」—— 乱猜列名比漏一列更坏。
      let target = name;
      if (name === '报告链接') {
        const alt = KNOWN_FIELDS.find((f) => /报告链接/.test(f));
        if (alt) target = alt;
      }
      if (!KNOWN_FIELDS.includes(target)) { SKIPPED_FIELDS.add(name); continue; }
      const v0 = hit.cell(name);
      if (v0 === '' || v0 == null) continue;
      // ★★ 2026-10-16 改（与 `writeBack` 那处同一条口径）：**写成对象式 `{link, text}`**。
      //   原先这里写的是 markdown 字符串，理由写的是「本表链接列实测是文本列」——
      //   那只是**当时**的形状（列被改成文本时，字符串才写得进去）。列恢复成**超链接**之后：
      //     · 字符串会被拒（`1254068 URLFieldConvFail`）；
      //     · 就算写进去了（文本列），飞书按**纯文本**渲染 ⇒ **黑字、点不开**（实测 7 格）。
      //   ⇒ 这一列唯一正确的形状是 `{link, text}`（历史那 65 格就是这个形状，所以是蓝的）。
      const mm = /\]\((https?:\/\/[^)]+)\)/.exec(String(v0)) || /(https?:\/\/\S+)/.exec(String(v0));
      fields[target] = { link: mm ? mm[1] : String(v0), text: '内容审查报告' };
      continue;
    }
    // ★★ 2026-10-19：**历史链接列一律不碰**。
    //   本轮用 `--link-col '10/19 报告链接'` 指定了日期列，旧的 `报告链接`(type 15) 要**原样保留**。
    //   不拦的话 `RESULT_FIELDS` 里的 `报告链接` 会把**结论表那一格的旧链接**搬下来：
    //   ① 语义错（本轮报告被旧链接顶替）；② 形状错（markdown 串塞进 URL 列 ⇒ `1254068` 整批被拒）。
    if (/报告链接/.test(name) && linkColumn() && name !== linkColumn()) {
      SKIPPED_FIELDS.add(`历史链接列「${name}」（本轮写「${linkColumn()}」⇒ 这一列不碰）`);
      continue;
    }
    const v = hit.cell(name);
    if (v === '' || v == null) continue;                       // 空的不写（不许把空值刷上去）
    let val = Array.isArray(v) && v.length === 1 && typeof v[0] === 'string' ? v[0]
            : (NUM_FIELDS.has(name) ? Number(v) : String(v));
    // ★ `报告链接` 那一列是 **URL 型字段**：塞 markdown 链接会 `1254068 URLFieldConvFail`
    //   ⇒ **整批 batchUpdate 被拒**（实测：六字段一起写时 ok=false 且 reason 为空，
    //   逐字段二分才看出是这一个字段）。判据里那一步「接口成功 ≠ 数据落下来」正是治它的。
    //
    // ★★ 2026-10-16 修（Owner 报「这一列有的黑字、有的蓝色可点」）——**判据写错了列名**：
    //   这里原先写的是 `name === '报告链接'`（写死），而这一列在表里叫
    //   **`10/14重跑报告链接`**（由上面的 `linkColumn()` 解析出来的）。两者不相等 ⇒
    //   **这个转换从来没执行过** ⇒ markdown 串被当**纯文本**写进去，飞书按文本渲染（黑字、点不开）。
    //   实测（当时 80 行）：**65 格**是历史遗留的 URL 段（蓝）＋ **7 格**是我最近几次复跑写进去的
    //   纯文本（黑）——正是 Owner 看到的那两种长相。
    //   ⇒ 判据改成**按解析出来的列名**判（`linkColumn()` 是这一列的唯一取法，别再写死第二个名字）。
    const linkCol = linkColumn();
    if (linkCol && name === linkCol) {
      const m = /\]\((https?:\/\/[^)]+)\)/.exec(String(val)) || /(https?:\/\/\S+)/.exec(String(val));
      // ★ 而且它要**对象式** `{link, text}` —— 裸字符串也是 `1254068 URLFieldConvFail`（实测三种形状：
      //   裸 URL ✗、带尾斜杠 ✗、`{link,text}` ✓）。这两层是同一个字段的两种坑，一起写在这儿。
      //   ⚠️ 文本统一成 `内容审查报告`（与历史那 65 格一致）—— 原先这里写的 `审查报告` 会让同一列两种文字。
      // ★★ 2026-10-19：上面那段只对**超链接(type 15)** 列成立；**文本(type 1)** 列写对象必炸
      //   `1254060 TextFieldConvFail`（整批被拒）。形状改由 raw API 的 type 号决定，见 `linkCell()`。
      val = linkCell(m ? m[1] : String(val));
    }
    fields[name] = val;
  }
  return fields;
}

/** 写回一行（带重试；**回读一致**才算成功）。 */
async function writeFields(recordId, fields) {
  // ★ 偶尔会返回一个**没有 code/msg/readback 的 ok:false**（实测两次，原因未定位；
  //   同一批字段单独写、隔一会儿再合并写都成功）。既然没定位到根因，就**不假装它不会发生**：
  //   重试一次 + 每次都要求**回读一致**才算成功 —— 这个判据本来就是 `lark_write` 自带的。
  let r = await lw.updateRecords({ senderName: '批跑器', chatId: CHAT }, BASE, TABLE,
                                 [{ record_id: recordId, fields }]);
  if (r?.ok !== true || r?.readback !== 'consistent') {
    const first = JSON.stringify({ ok: r?.ok, code: r?.code, msg: r?.msg, readback: r?.readback,
                                   detail: String(r?.readback_detail ?? '').slice(0, 120),
                                   keys: Object.keys(r ?? {}) });
    await new Promise((res) => setTimeout(res, 1500));
    r = await lw.updateRecords({ senderName: '批跑器', chatId: CHAT }, BASE, TABLE,
                               [{ record_id: recordId, fields }]);
    if (r?.ok !== true || r?.readback !== 'consistent') {
      r = { ...r, msg: `${r?.msg ?? ''} ｜ 第一次：${first}`.trim() };
    }
  }
  // ★ 「接口返回成功」不等于「数据落下来了」——`lark_write` 自带**回读**，这里必须把它带出来，
  //   否则回填会以「ok」的样子静默失败（今天实测过一次：报 ok、回读是空的）。
  return { ok: r?.ok === true && r?.readback === 'consistent',
           readback: r?.readback ?? '(未回读)',
           detail: [r?.msg, r?.code ? `code=${r.code}` : '', r?.readback_detail, r?.error,
                    // ★ 跳过的字段必须**看得见**（2026-10-15）：静默跳过 = 下一个人以为「该填的都填了」
                    SKIPPED_FIELDS.size ? `跳过（表里没有这列）：${[...SKIPPED_FIELDS].join('、')}` : '']
             .filter(Boolean).join(' ｜ ') || '(无错误信息)',
           fields };
}

function readRows() {
  const t = readTable(TABLE);
  const fields = t.fields;
  KNOWN_FIELDS = fields;            // ★ 2026-10-15：写回的目标就是这张表 ⇒ 用它自己的字段清单做闸
  if (!fields.includes(F.text)) throw new Error(`表里没有「${F.text}」这一列；实际：${fields.join('/')}`);
  return t.rows.map((r) => ({
    record_id: r.record_id, content_id: String(r.cell(F.id)),
    state: String(r.cell(F.state)), text: String(r.cell(F.text)),
    ctype: String(r.cell(F.type)),
  }));
}

/**
 * 发一条已经过信封层成形的消息 —— **与 `ws_daemon.replyTo` 同一条形态链**，
 * 只差"不挂在某条消息下面"（本机跑没有可引用的 message id）。
 */
async function sendShaped(raw, { verdict53 = null, reportLink = null, progress = null } = {}) {
  // ★ 2026-10-15：`machineAnswer: true` —— 本机跑批**没有真人对话**，喂进来的 `raw`
  //   是 `handleMessage` 的 `res.reply`，而那一轮里除了权威结论行，剩下的全是我们自己的读数
  //   （实测真单 `om_x100b62333eaaf0a8b050a29473b0030`：`链侧 PASS ｜ 0 处问题…`、
  //    `引擎结论（照抄 ③b 模板）…置信度 0.93`、`（未填）` 表格、`` `risk_items` 为空… ``）。
  //   公开群里的那张卡只该有结论行 + §5.3 逐条块。
  //   ⚠️ 只是一条**声明**，不是「一概丢原话」：信封层还要求「摘掉笔记后已无实质内容」才丢
  //     ⇒ 链跑挂时模型那段有内容的答复照旧上卡（判据见 `verify_cards.mjs` J13a3 / J13a3b）。
  const shaped = toCardOrText(String(raw ?? ''), { verdict53, reportLink, machineAnswer: true });
  let sent = null;
  if (shaped.card) {
    try {
      const r = await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: CHAT, msg_type: 'interactive', content: JSON.stringify(shaped.card) },
      });
      sent = { ok: true, mode: 'card', messageIds: [r?.data?.message_id].filter(Boolean) };
    } catch (e) {
      const why = e?.response?.data ? `卡片被拒 code=${e.response.data.code}` : `卡片异常 ${e?.message ?? e}`;
      console.log(`   ⚠ ${why} → 退纯文本`);
    }
  }
  if (!sent) {
    const r = await sendMarkdown(CHAT, shaped.text);
    sent = { ok: r.ok, mode: r.ok ? `text-fallback(${shaped.mode})` : 'none',
             messageIds: r.messageIds ?? [], error: r.error ?? null };
  }
  // 台账：一次外发一条（来源已在 SOURCES + FOLDING 里登记；A17 要求两集合恰好切分 SOURCES）
  recordSend({ chatId: CHAT, chatType: 'p2p', source: SOURCE, mode: sent.mode,
               messageIds: sent.messageIds, text: shaped.text, ok: sent.ok,
               error: sent.error ?? null, extra: progress ?? null });
  return sent;
}

/* ── 媒体按「真媒材」送进去（2026-10-13 加）─────────────────────────────────
 *
 * 病灶（实测，第 16 行 `MC-US-WEB-IMG-8673508131014`）：图片行的素材原文是
 *   「<图片URL>\n图注：…\n来源页：…」，闸门判 `link`（`review_gate.mjs:72` 只在
 *   `imageCount>0` 时判 media），而守衡**没有取网工具**（`run_readonly_command` 白名单无 curl）
 *   ⇒ 全链不 OCR、结论只引「图注」，**素材本体从头到尾没被读过**。
 *
 * 修法：走**守衡自己的读图那条路** —— 下载图 → 传成飞书图片资源 → 发一条**真图片消息**
 *   → 再把这个合成事件指到那条真消息的 `message_id` + `image_key`。
 *   于是 `readInboundContent` → `fetchMessageImage(message_id, image_key)` → `vision.ocrImage`
 *   整条跑起来（生产里用户发图走的就是这条）。
 *
 * ★ 为什么必须真的发一条消息：`fetchMessageImage` 打的是
 *   `/im/v1/messages/{message_id}/resources/{file_key}` —— **资源必须属于那条消息**，
 *   合成一个假 message_id 会 400（实测过：假 id + 真 key 取不到字节）。
 * ★ 图片行同时带图注：合成事件用 `post`（`img` 节点 + `text` 节点），
 *   与「用户发一张图配一句话」同形，图注那么judged，图上文字也那么 judged。
 */
const IMG_TMP = '/tmp/kb-batch-img';
const VID_TMP = '/tmp/kb-batch-vid';   // 预先下好的视频（yt-dlp，format 18 = 直出 mp4）

/** 把 markdown 链接 `[x](y)` 还原成 `y` —— 飞书把含 URL 的格子读回来是 markdown 形态，
 *  而采集件（`out/rows_us.json`）与结论表的「送审问题」都是**裸 URL**。
 *  ⇒ 两边先过这一道，**认领键**才谈得上可比（实测：不过这一道，80 字键在 URL 尾巴上分叉，
 *    认领整条落空、退到时间窗、捡到链侧**空行**，把 `问题数量` 写成 0）。 */
function clean(t) {
  return String(t ?? '').replace(/\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g, '$2');
}

/** 素材原文里第一条「看起来是图片」的 URL（图片行的第一行就是它）。 */
function imageUrlOf(text) {
  for (const line of String(text ?? '').split('\n')) {
    const s = line.trim();
    // ★ 2026-10-13 修：飞书把这几行的素材格子读回来是 **markdown 链接形态** `[url](url)`
    //   （实测 3 行；采集件 `out/rows_us.json` 里是**裸 URL** ⇒ 那是库侧渲染形态，不是原始素材）。
    //   老写法用贪婪 `\S+` ⇒ 抓到的是 `…jpg?v=N](https://…jpg?v=N)` **整段**：
    //   Shopify 会忽略那段 query 照样出图（**侥幸对了**，但字节能对上纯属运气），
    //   Amazon 那种无 query 的就会因为路径里多了 `](` 而 404 ⇒ 退回「只审图注」。
    const md = /\]\((https?:\/\/[^\s)]+)\)/.exec(s);
    const bare = /(https?:\/\/[^\s)\]\(]+)/.exec(s);
    const u = md ? md[1] : (bare ? bare[1] : null);
    if (u && /\.(jpe?g|png|webp|gif|bmp)(\?|$)/i.test(u)) return u;
  }
  return null;
}

/**
 * 素材图 URL → **最大可用变体**（Owner 2026-10-16：「按照你的推荐先做 a」）。
 *
 * 病灶（一手实测，见 `agent/image_variant.mjs` 头部）：同一批 20 行视频素材里，
 * **10 行存 `hqdefault`（480×360）、10 行存 `maxresdefault`（1280×720）** —— 前者 OCR 出来是乱码，
 * 模型侧只看文字层 ⇒ 它回 `[]` ⇒ 该行从 REVIEW 翻成 PASS（2026-10-16 重跑第 33 行就是这么翻的）。
 * 三条纪律：① 取不到高清就**用原图**（fail-open，绝不把图丢掉）；
 * ② **不动素材记录**（只读源、也不改自己的采集格）——升级只发生在读的时候；
 * ③ 不是 YouTube 缩略图 ⇒ 一个请求都不发（见 `bestImageVariant`）。
 * 用了哪个变体**打进日志**：看日志的人要能说出"这一轮读的是哪张图"。
 */
async function resolveMaterialImage(text) {
  const u = imageUrlOf(text);
  if (!u) return null;
  const best = await bestImageVariant(u, { log: (s) => console.log(`   ${s}`) });
  // 探过但没升级成功（高清都 404/超时）⇒ 也要看得见：不然"这一轮读的是糊图"就没人知道
  if (best.tried.length && !best.upgraded) console.log(`   🖼 素材图：${best.note}`);
  return best.url;
}

/** 非 URL 的那些行（图注 / 来源页说明）—— 作为这条图消息的正文。 */
function captionOf(text) {
  const out = [];
  for (const raw of String(text ?? '').split('\n')) {
    const l = raw.trim();
    if (!l) continue;
    // ★ 含**图 URL** 的行一律不算图注 —— 注意 markdown 形态那行是以 `[` 开头的，
    //   老写法只滤「以 http 开头」，会把它当图注留下来（实测：认领键因此整条对不上，
    //   回填退到时间窗，捡到链侧那行**空行**，把 `问题数量` 写成了 0）。
    if (imageUrlOf(l)) continue;
    out.push(l);
  }
  return out.join('\n');
}

/** 下载图 → 传成飞书**图片资源** → 返回 image_key（发图消息与「视频封面图」都用它）。 */
async function uploadImageFromUrl(url, cid) {
  fs.mkdirSync(IMG_TMP, { recursive: true });
  const dest = path.join(IMG_TMP, `${String(cid).replace(/[^\w.-]/g, '_')}${/\.png(\?|$)/i.test(url) ? '.png' : '.jpg'}`);
  const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' } });
  if (!r.ok) throw new Error(`下载图失败 HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 1024) throw new Error(`下载到的图太小（${buf.length} 字节）`);
  fs.writeFileSync(dest, buf);
  const out = execFileSync(LARK, ['--profile', 'dsh-kb', 'im', 'images', 'create', '--as', 'bot',
    '--data', '{"image_type":"message"}', '--file', dest, '--format', 'json'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const j = JSON.parse(out);
  if (!j.ok) throw new Error(`上传图片失败：${JSON.stringify(j.error).slice(0, 180)}`);
  return { imageKey: j.data.image_key, bytes: buf.length };
}

/** 视频行：把**真视频**发成一条 `media` 消息（封面图另传）。
 *  ★★ 必须**回读**这条消息、用它**自带**的 content —— 实测飞书发出去时会**换发一个 file_key**
 *     （传的时候是 `…b41efb47…`，消息里变成 `…ea998ff2…`）。
 *     拿上传时那个 key 去喂内核 ⇒ `/messages/{id}/resources/{key}` 返回
 *     `234003 File not in msg.` ⇒ 内核报「视频我没读成」。这一步不补，整条视频路就是假的。
 */
async function publishVideoMessage(videoPath, coverKey) {
  const out = execFileSync(LARK, ['--profile', 'dsh-kb', 'im', 'files', 'create', '--as', 'bot',
    '--data', JSON.stringify({ file_type: 'mp4', file_name: path.basename(videoPath) }),
    '--file', videoPath, '--format', 'json'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const j = JSON.parse(out);
  if (!j.ok) throw new Error(`上传视频失败：${JSON.stringify(j.error).slice(0, 180)}`);
  const sent = await client.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: { receive_id: CHAT, msg_type: 'media',
            content: JSON.stringify({ file_key: j.data.file_key, image_key: coverKey, duration: 0 }) },
  });
  const messageId = sent?.data?.message_id;
  if (!messageId) throw new Error('发视频消息没拿到 message_id');
  const got = await client.im.message.get({ path: { message_id: messageId } });
  const content = got?.data?.items?.[0]?.body?.content;
  if (!content) throw new Error('回读视频消息拿不到 content');
  return { messageId, content, uploadKey: j.data.file_key, realKey: (JSON.parse(content) || {}).file_key };
}

/** 下载图 → 传图片资源 → 发真图片消息。返回 {imageKey, messageId, bytes, caption}。 */
async function publishImageMessage(url, caption, cid) {
  fs.mkdirSync(IMG_TMP, { recursive: true });
  const dest = path.join(IMG_TMP, `${String(cid).replace(/[^\w.-]/g, '_')}${/\.png(\?|$)/i.test(url) ? '.png' : '.jpg'}`);
  const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' } });
  if (!r.ok) throw new Error(`下载图失败 HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 1024) throw new Error(`下载到的图太小（${buf.length} 字节）`);
  fs.writeFileSync(dest, buf);
  const out = execFileSync(LARK, ['--profile', 'dsh-kb', 'im', 'images', 'create', '--as', 'bot',
    '--data', '{"image_type":"message"}', '--file', dest, '--format', 'json'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const j = JSON.parse(out);
  if (!j.ok) throw new Error(`上传图片失败：${JSON.stringify(j.error).slice(0, 180)}`);
  const imageKey = j.data.image_key;
  const sent = await client.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: { receive_id: CHAT, msg_type: 'image', content: JSON.stringify({ image_key: imageKey }) },
  });
  const messageId = sent?.data?.message_id;
  if (!messageId) throw new Error('发图片消息没拿到 message_id');
  return { imageKey, messageId, bytes: buf.length, caption };
}

async function runOne(row, tag) {
  // ★ 独立会话键：不碰你和守衡那份私聊记忆（见文件头边界 ②）。
  const sessionKey = `oc-batch-${tag}`;
  // ── 图片行：把图按**真媒材**送进去（否则全链不 OCR，只审图注）──────────────
  const matText = clean(row.text);      // ★ 先算（下面 msgContent 就用它）
  let msgType = 'text';
  let msgContent = JSON.stringify({ text: matText });
  let msgId = `om_batch_${tag}_${row.content_id}`;
  // ★ 2026-10-13：**视频行也按真图片送** —— 送的是它的**封面图**。
  //   为什么：表里视频行的素材只有「标题 + YouTube 链接 + 缩略图链接 + 发布日」，
  //   **没有视频文件**（本机也没装 yt-dlp，实测 `which yt-dlp` 空）⇒ 走文本就只有标题可审。
  //   实测封面图信息量很足（`VwANGOaT4vs` 那张：momcozy 标识、「WEBINAR ｜ Aeroflow Breastpumps」
  //   联名、两位讲者的 IBCLC/RN 头衔、「Expert support」宣称）—— 那正是库内规则管的「背书与资质」。
  //   ★ 素材里**明写「视频本体未审」**，免得这条结果被读成「视频审过了」。
  const _ct = String(row.ctype ?? '');
  const _isVid = _ct.includes('视频');
  // ── 视频行：优先走**真视频**（预下在 /tmp/kb-batch-vid/<内容ID>.mp4）──────────
  const _vidPath = _isVid ? path.join(VID_TMP, `${row.content_id}.mp4`) : null;
  // ★ 2026-10-13：本机直读成功 ⇒ **不许**再走下面的封面图分支。
  //   实测踩到的自伤：直读把 `msgType` 置成 `'text'`，而下面封面图那一支的条件写的是
  //   `(_isVid && msgType === 'text')` ⇒ 它**正好被直读触发**，把刚拼好的正文
  //   **整个覆盖**成「封面图 + 图注」⇒ 这一单又变成了只审封面
  //   （日志会长成 `🎬 …本机直读` 紧跟着 `📥 读到｜图 1 张`，两条自相矛盾）。
  let usedLocalRead = false;
  if (_vidPath && fs.existsSync(_vidPath)) {
    try {
      const cover = await uploadImageFromUrl(imageUrlOf(matText), `${row.content_id}.cover`);
      const pv = await publishVideoMessage(_vidPath, cover.imageKey);
      msgId = pv.messageId; msgType = 'media'; msgContent = pv.content;
      console.log(`   🎬 视频已按真媒材送入（${(fs.statSync(_vidPath).size / 1048576).toFixed(1)} MB`
        + `｜封面 ${cover.bytes}B｜msg=${pv.messageId}`
        + (pv.uploadKey !== pv.realKey ? '｜file_key 已被飞书换发（已用回读的那个）' : '') + '）');
    } catch (e) {
      const _msg = String(e?.message ?? e);
      if (/exceed the max value|234006/.test(_msg)) {
        // ★ 2026-10-13 加：**超过飞书上传上限时，改本机直读**。
        //   实测：飞书 `im/v1/files` 有大小上限 —— `234006 The file size exceed the max value.`
        //   （这批里 27.6 MB 那条**过**、74 MB 那条 webinar **被拒**；飞书文档记的是 30 MB）。
        //   直读走的是**同一个** `video.mjs`（守衡自己的抽帧 OCR ＋ Apple Speech 转写），
        //   差别只在「少一次经飞书的搬运」——所以读数口径没变，**要说出来**：
        //   正文里明写「本机直读，未走飞书搬运 —— 该文件超过飞书上传上限」。
        try {
          const r = await videoMod.readVideo(_vidPath);
          const fr = (r.frames ?? []).filter((f) => f.text)
            .map((f) => `[${Math.round(f.t_s)}s] ${String(f.text).replace(/\n/g, ' / ')}`).join('\n');
          const tr = r.transcript?.ok ? r.transcript.text
                                     : `（没转写：${r.transcript?.kind ?? '未知'} —— ${r.transcript?.hint ?? ''}）`;
          msgType = 'text';
          msgContent = JSON.stringify({ text:
            `【视频本体 —— 本机直读（未走飞书搬运：该文件超过飞书上传上限）】\n`
            + `文件 ${(fs.statSync(_vidPath).size / 1048576).toFixed(1)} MB｜时长 ${r.meta?.duration_s ?? '?'} 秒`
            + `｜分辨率 ${r.meta?.w ?? '?'}×${r.meta?.h ?? '?'}｜抽帧 OCR ${r.framesRead ?? 0} 帧`
            + `｜音轨转写：${r.transcript?.ok ? '成' : '没跑成'}\n`
            + `帧上文字：\n${fr || '（没有帧读出文字）'}\n\n【转写正文】\n${tr}\n\n${captionOf(matText)}` });
          usedLocalRead = true;
          console.log(`   🎬 视频超过飞书上限（234006）⇒ **本机直读**（守衡同一个 video.mjs）`
            + `：${(fs.statSync(_vidPath).size / 1048576).toFixed(1)} MB｜帧 ${r.framesRead ?? 0}`
            + `｜转写 ${r.transcript?.ok ? '成' : '没跑成（' + (r.transcript?.kind ?? '') + '）'}`);
        } catch (e2) {
          console.log(`   ⚠ 本机直读也失败（${e2?.message ?? e2}）⇒ 退回封面图`);
        }
      } else {
        console.log(`   ⚠ 视频送不进去（${_msg}）⇒ 退回封面图`);
      }
    }
  }
  const imgUrl = (_ct.includes('图片') || (_isVid && msgType === 'text' && !usedLocalRead))
    ? await resolveMaterialImage(matText) : null;
  if (imgUrl) {
    try {
      const cap = _isVid
        ? `【视频封面图 —— 本次只审**封面图与标题**；视频本体（口播 / 字幕 / 画面）**未审】**\n${captionOf(matText)}`
        : captionOf(matText);
      const pub = await publishImageMessage(imgUrl, cap, row.content_id);
      msgId = pub.messageId;
      msgType = 'post';
      msgContent = JSON.stringify({ content: [[
        { tag: 'img', image_key: pub.imageKey },
        ...(pub.caption ? [{ tag: 'text', text: pub.caption }] : []),
      ]] });
      console.log(`   🖼  图已按真媒材送入（${pub.bytes} 字节｜image_key=${String(pub.imageKey).slice(0, 20)}…｜msg=${pub.messageId}）`);
    } catch (e) {
      console.log(`   ⚠ 图送不进去（${e?.message ?? e}）⇒ 退回按文本送（**只审图注**，结果要打折看）`);
    }
  }
  const ev = {
    message: {
      message_id: msgId, chat_id: sessionKey, chat_type: 'p2p',
      message_type: msgType, content: msgContent,
    },
    sender: { sender_id: { open_id: 'ou_batch_runner' }, sender_type: 'user' },
  };
  const res = await handleMessage(ev, {
    notify: async (text) => {
      if (REPORT_ONLY) return;                       // ★ 补数轮：回执卡不发
      await sendShaped(text, { progress: { row: row.content_id, kind: 'ack' } });
    },
    tIngress: Date.now(),
  });
  const meta = res?.meta ?? {};
  const sent = REPORT_ONLY
    ? { ok: true, mode: 'skipped(report-only)', messageIds: [] }
    : await sendShaped(res?.reply ?? '', {
    verdict53: meta.verdict53 ?? null, reportLink: meta.reportLink ?? null,
    progress: { row: row.content_id, kind: 'final' },
  });
  return { res, meta, sent, sessionKey };
}

async function main() {
  const rows = readRows();
  const st = loadState();
  // ══════════════════════════════════════════════════════════════════════════
  // ★★ 2026-10-15：**内容 ID 撞号 ⇒ 这几行本轮拒跑** ─────────────────────────────
  // ──────────────────────────────────────────────────────────────────────────
  //  实测事故（当天）：社媒文案我用了 `MC-US-YT-<videoId>`，与**视频行**重名 ⇒
  //   · 台账/状态是按 **内容 ID** 索引的 ⇒ 两行共用一条记录，`--only <id>` **两行都命中**；
  //   · 于是跑批器把**没打算动的视频行也跑了**，它们的结论/数量/链接被改写（6 行）。
  //  ⇒ 判据放在入口：**同一个 `内容 ID` 出现两次 ⇒ 这两行都不跑**，并出声。
  //     修法是改 ID（让它唯一），不是绕过去 —— 绕过去只会把污染留到下一次。
  const _idCount = new Map();
  for (const r of rows) _idCount.set(r.content_id, (_idCount.get(r.content_id) ?? 0) + 1);
  const dupIds = new Set([..._idCount.entries()].filter(([, n]) => n > 1).map(([k]) => k));
  if (dupIds.size) {
    console.log(`⛔ 表里有 ${dupIds.size} 个「内容 ID」撞号 —— **本轮拒跑这些行**（先让 ID 唯一再来）：`
      + [...dupIds].slice(0, 6).join('、') + (dupIds.size > 6 ? ' …' : ''));
  }

  if (has('--status')) {
    for (const r of rows) {
      const d = st.items[r.content_id] ?? {};
      console.log(`  ${r.content_id.padEnd(22)} ${r.state.padEnd(6)} ` +
        (d.answered_at ? `已答 ${d.secs}s ${d.state ?? ''}` : d.sent_at ? '已发待答' : '未跑'));
    }
    console.log(`共 ${rows.length} 行 ｜ 已跑 ${Object.keys(st.items).length}`);
    return 0;
  }

  // ── 整表回填：把**结论表里已经有的结论**按素材原文匹配回采集表 ─────────────────
  //   ★ 为什么需要它（Owner 2026-10-13：「只有 3 条数据，要回填结论」）：
  //     守衡在飞书侧被 @ 时，结论写进的是**结论表**（`tblCXPQVzfFWWCon`）；
  //     而采集表（80 行那张）只有本机批跑器在写 ⇒ **人 @ 出来的结论一直没回到这张表**。
  //   匹配键 = 素材原文：采集表的「采集数据」≈ 结论表的「送审问题」
  //     （后者是 `String(question).slice(0,2000)`，就是送审时那段原文）。
  //   取归一化后前 120 字比对；**匹配不上的如实列出来**，绝不按「最像的」硬填（填错比空着坏）。
  if (has('--fill-all')) {
    const res = readTable(RESULT_TABLE, { sortDesc: true });
    const norm = (t) => String(t ?? '').replace(/<br\s*\/?>/gi, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    let filled = 0; const nomatch = []; const noText = [];
    for (const r of rows) {
      const key = norm(r.text).slice(0, 120);
      if (!key) { noText.push(r.content_id); continue; }
      const hit = res.rows.filter((x) => norm(x.cell('送审问题')).startsWith(key)).pop();
      if (!hit) { nomatch.push(r.content_id); continue; }
      const wb = await writeFields(r.record_id, dropHumanTerminalStatus(fieldsFrom(hit), r.state));
      st.items[r.content_id] = { ...(st.items[r.content_id] ?? {}), record_id: r.record_id,
        filled_from: '结论表·按素材原文匹配',
        write_back: wb.ok ? 'ok' : `失败：${wb.why ?? wb.detail}`,
        write_back_readback: wb.readback ?? null, write_back_fields: wb.fields ?? null };
      saveState(st);
      if (wb.ok) filled++;
      console.log(`  ${wb.ok ? '✅' : '❌'} ${r.content_id} ｜ ${Object.keys(wb.fields ?? {}).join('/') || (wb.why ?? wb.detail)}`);
    }
    console.log(`\n整表回填：成功 ${filled} ｜ 结论表里还没有（未审） ${nomatch.length} ｜ 素材为空跳过 ${noText.length}`);
    if (nomatch.length) console.log('  尚未审过：' + nomatch.slice(0, 10).join('、') + (nomatch.length > 10 ? ` …共 ${nomatch.length} 条` : ''));
    return 0;
  }

  // ── 补回填：已经答过、但当时还没有回填那一步（或回填失败）的条目 ──────────────
  if (has('--backfill')) {
    const pending = rows.filter((r) => {
      const d = st.items[r.content_id] ?? {};
      return d.answered_at && d.write_back !== 'ok';
    });
    if (!pending.length) { console.log('没有要补回填的'); return 0; }
    for (const r of pending) {
      const d = st.items[r.content_id];
      // 时间窗起点 = 跑完时刻 − 这条耗时（`sent_at` 记的是**跑完**时刻）− 1 分钟宽限。
      //   ★ 第一版只按跑完时刻算，于是窗口**开晚了**：链在 06:29:48 就写好结论行了，
      //     而窗口从 06:30:02 起 ⇒ 明明有行却说「没有新行」。判据要盖住**整条**的运行区间。
      const since = Date.parse(d.ran_from ?? d.sent_at ?? '') - (d.ran_from ? 0 : (Number(d.secs ?? 0) * 1000)) - 60_000;
      const wb = await writeBack(r.content_id, r.record_id ?? d.record_id, Number.isFinite(since) ? since : 0, r.text);
      d.write_back = wb.ok ? 'ok' : `失败：${wb.why ?? wb.detail}`;
      d.write_back_readback = wb.readback ?? null;
      d.write_back_fields = wb.fields ?? null;
      console.log(`  ${r.content_id} → ${wb.ok ? '✅ ' + Object.keys(wb.fields ?? {}).join('/') : '❌ ' + (wb.why ?? wb.detail)}`);
      saveState(st);
    }
    return 0;
  }

  // `--only <内容ID>`：只跑指定的一行（可重复）—— 用来**精确验**某一行（例如视频行），
  // 不必把整表顺序打乱。（2026-10-13 加：视频行在表尾，验它要等 2 小时。）
  const ONLY = new Set(args.reduce((acc, a, i) => (a === '--only' && args[i + 1] ? acc.concat(args[i + 1]) : acc), []));
  const todo = rows.filter((r) => (r.text || '').trim() && !(st.items[r.content_id] ?? {}).answered_at
    && !dupIds.has(r.content_id)                       // ★ 撞号的行一律不跑（见 main 开头那段）
    && (!ONLY.size || ONLY.has(r.content_id)));
  const batch = LIMIT ? todo.slice(0, LIMIT) : todo;
  if (!batch.length) { console.log('没有要跑的（都跑过了？）'); return 0; }

  const tag = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  console.log(`本机批跑 ｜ 表 ${TABLE} ｜ 发往 ${CHAT} ｜ 身份 = 守衡自己 ｜ `
    + `${DRY ? '干跑' : '真跑'} ｜ 本轮 ${batch.length} 条（还有 ${todo.length - batch.length} 条没跑）`);

  const t0 = Date.now();
  for (const [i, row] of batch.entries()) {
    console.log(`\n[${i + 1}/${batch.length}] ${row.content_id} ｜ ${[...row.text].length} 字 ｜ 表内状态 ${row.state}`);
    if (DRY) { console.log(`   —— 将逐字送进内核（前 140 字）：${row.text.slice(0, 140).replace(/\n/g, ' ⏎ ')}`); continue; }

    const t = Date.now();
    let out;
    try {
      out = await runOne(row, tag);
    } catch (e) {
      console.log(`   ❌ 内核抛异常：${e?.message ?? e}`);
      st.items[row.content_id] = { record_id: row.record_id, error: String(e?.message ?? e).slice(0, 300), at: new Date().toISOString() };
      saveState(st);
      continue;
    }
    const secs = Number(((Date.now() - t) / 1000).toFixed(1));
    const state = out.meta?.verdict53?.state ?? null;
    console.log(`   ✅ ${secs}s ｜ 三态 ${state ?? '—'} ｜ 链 ${out.meta?.chain?.ran ? '跑成' : '未跑成'} `
      + `｜ 卡片 ${out.sent.mode} ｜ 问题数 ${out.meta?.dual?.total ?? '—'}`);
    console.log(`      回答头：${String(out.res?.reply ?? '').split('\n')[0].slice(0, 70)}`);
    st.items[row.content_id] = {
      record_id: row.record_id, ran_from: new Date(t).toISOString(),
      sent_at: new Date().toISOString(), answered_at: true,
      secs, state, report_url: out.meta?.reportLink ?? null,
      issue_total: out.meta?.dual?.total ?? null,
      reply_reason: out.res?.reason ?? null, mode: out.sent.mode,
      message_ids: out.sent.messageIds ?? [],
      reply_head: String(out.res?.reply ?? '').split('\n').slice(0, 3).join(' ⏎ ').slice(0, 300),
    };
    saveState(st);
    // ── 回填采集表：从结论表把这一条的结果搬过来（守衡的链刚刚自己写进去的那一行）
    // ★ 2026-10-19：`--report-only`（补数轮）**不落表** —— Owner 原话「不要落库」。
    const wb = REPORT_ONLY
      ? { ok: true, readback: '(skipped)', detail: 'report-only：不写表', fields: {}, why: null }
      : await writeBack(row.content_id, row.record_id, t, row.text,
                               out.meta?.chain?.publish?.record_id ?? null, row.state,
                               // ★ 2026-10-16：本轮的**报告 URL** 与三态一起传进去 ——
                               //   链接列要以本轮那份为准（PASS 本轮没报告 ⇒ 清掉），见 writeBack 里那段。
                               out.meta?.reportLink ?? null, state,
                               // ★ 2026-10-16：常规批跑**只认本轮那一行**（拿不到就不写、出声）——
                               //   猜行的代价见 writeBack 里那段（80 行逐字段核对抓出来的）。
                               { strict: true });
    st.items[row.content_id].write_back = wb.ok ? 'ok' : `失败：${wb.why ?? wb.detail}`;
    st.items[row.content_id].write_back_readback = wb.readback ?? null;
    st.items[row.content_id].write_back_fields = wb.fields ?? null;
    saveState(st);
    console.log(`   ↳ 回填你的表：${wb.ok ? '✅ ' + Object.keys(wb.fields ?? {}).join('/') : '❌ ' + (wb.why ?? wb.detail)}`);
  }

  const done = Object.values(st.items).filter((d) => d.answered_at);
  const ss = done.map((d) => d.secs).filter(Boolean).sort((a, b) => a - b);
  console.log(`\n本轮 ${((Date.now() - t0) / 1000).toFixed(1)}s ｜ 累计已答 ${done.length} 条`);
  if (ss.length) {
    const mid = ss[Math.floor(ss.length / 2)];
    console.log(`单条：最快 ${ss[0]}s ｜ 中位 ${mid}s ｜ 最慢 ${ss[ss.length - 1]}s `
      + `⇒ 跑满 ${rows.length} 条估 ≈ ${(mid * rows.length / 60).toFixed(0)} 分钟（按中位）`);
  }
  return 0;
}

main().then((c) => process.exit(c)).catch((e) => { console.error('批跑器异常：', e); process.exit(1); });

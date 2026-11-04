#!/usr/bin/env node
/**
 * clean_legacy_questions.mjs —— **一次性的历史清洗**：「送审问题」那一格里
 * 我们自己的内部指令与占位符，只留对方原文。
 *
 *   node tools/clean_legacy_questions.mjs              # 预演（默认，只读）
 *   node tools/clean_legacy_questions.mjs --apply      # 真写
 *   node tools/clean_legacy_questions.mjs --limit 20 --apply
 *
 * ── 为什么需要它（Owner 2026-10-16 的裁定「只清洗文本」）
 *
 *   修好**新单**之后，旧行不会自己变干净：实测结论表一页 200 行里 ——
 *   **54 行**的「送审问题」是我们自己的内部指令（`【★ 这是送审素材…】`、
 *   `【对方这条消息里附了图…】` ＋ OCR 全文），**20 行**是 `[图片]`/`[媒体]` 占位。
 *
 * ── 它**做不到**的那一半（必须说在前面）
 *
 *   旧行的**链接补不回来**：那些行里没存 `message_id`，而图中的字节只能凭
 *   「消息 id + image_key」去飞书取（`media_link.mjs` 头注实测过：没有消息链接这种能力）。
 *   ⇒ 本脚本**只清洗文本**，不假装能补链接。要链接就得重新送审一次。
 *
 * ── 边界
 *
 *   · **只碰 `送审问题` 这一格**；人填的列与其余机器列一个字不动；
 *   · 预演是默认值，且预演会打印**逐条 before → after**（人先看样例，再决定写不写）；
 *   · 用 `media_link.stripInternal` —— **同一个清洗函数**，不另写一份判据
 *     （两份实现必然分叉，那正是本仓反复栽过的形状）。
 */
import { config } from './agent/config.mjs';
import { listRecords, updateRecords } from './agent/lark_write.mjs';
import { reviewTable } from './agent/review_publish.mjs';
import { stripInternal } from './agent/media_link.mjs';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const LIMIT = (() => {
  const i = argv.indexOf('--limit');
  return i >= 0 ? Number(argv[i + 1]) || null : null;
})();

const T = reviewTable();
if (!T) {
  console.error('落表被拉下（SHOUHENG_REVIEW_TABLE=off）⇒ 没有可清洗的表。');
  process.exit(2);
}

console.log(`表：${T.appToken}/${T.table}｜模式：${APPLY ? '**真写**' : '预演（只读）'}`);

/** 分页读全量（一页 500，读到没有下一页为止）。 */
async function allRows() {
  const out = [];
  let pageToken = null;
  for (let i = 0; i < 40; i++) {
    const r = await listRecords(T.appToken, T.table, { limit: 500, pageToken });
    if (!r.ok) throw new Error(`读表失败：${r.detail ?? r.error ?? '未知'}`);
    out.push(...(r.records ?? []));
    pageToken = r.page_token ?? null;
    if (!pageToken || (r.records ?? []).length === 0) break;
  }
  return out;
}

const cellOf = (v) => (v == null ? '' : Array.isArray(v) ? v.map(cellOf).join('') : String(v?.text ?? v));

const rows = await allRows();
console.log(`读到 ${rows.length} 行`);

const hits = [];
for (const it of rows) {
  const cur = cellOf(it.fields?.['送审问题']);
  if (!cur) continue;
  const next = stripInternal(cur);
  if (next !== cur) hits.push({ record_id: it.record_id, cur, next, id: cellOf(it.fields?.['内容 ID']) });
}
const emptyAfter = hits.filter((h) => !h.next).length;
console.log(`需要清洗：**${hits.length}** 行（其中 ${emptyAfter} 行清洗后为空 —— 那些本来就是纯内部指令）`);
console.log(`保持不变：${rows.length - hits.length} 行\n`);

const show = LIMIT ? hits.slice(0, LIMIT) : hits.slice(0, 8);
for (const h of show) {
  console.log(`— ${h.id || h.record_id}`);
  console.log(`   旧：${JSON.stringify(h.cur.slice(0, 110))}${h.cur.length > 110 ? ' …' : ''}`);
  console.log(`   新：${JSON.stringify(h.next.slice(0, 110))}${h.next.length > 110 ? ' …' : ''}`);
}
if (!LIMIT && hits.length > show.length) console.log(`…（只印了前 ${show.length} 条，共 ${hits.length} 条）`);

if (!APPLY) {
  console.log('\n预演结束，**一个字都没写**。确认无误后加 --apply。');
  process.exit(0);
}

const todo = LIMIT ? hits.slice(0, LIMIT) : hits;
let done = 0;
for (let i = 0; i < todo.length; i += 100) {
  const chunk = todo.slice(i, i + 100);
  const r = await updateRecords(
    { actor: 'shouheng/clean-legacy-questions' }, T.appToken, T.table,
    chunk.map((h) => ({ record_id: h.record_id, fields: { 送审问题: h.next } })));
  if (!r.ok) {
    console.error(`✗ 第 ${i / 100 + 1} 批失败：${r.detail ?? r.error ?? '未知'}`);
    process.exit(1);
  }
  done += chunk.length;
  console.log(`  已写 ${done}/${todo.length}`);
}
console.log(`\n完成：清洗 ${done} 行（**旧行的链接补不回来** —— 那些行没存消息 id）。`);

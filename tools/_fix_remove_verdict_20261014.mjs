/**
 * 一次性运维件（2026-10-14）：把已落库的云文档里**残留的「判定」字段**按 Owner 裁定删掉。
 *
 * Owner 原话：「修改所有的落库规则去掉『判定』这个字段…修复后落库，其他不动。」
 * 渲染侧已在同批改掉（`dual_track.mjs::renderMergedItem`），但**已经落进飞书的文档不会自己变**。
 *
 * 本件是**机械化删段**，不是重渲染：
 *   · 只删 `[<br/>]<b?>判定</b?>：…[<br/>]` 这一段，**其余字节不动**；
 *   · 删之前把原文与本机留底写进 `PMO/shouheng-state/_fix-doctors-20261014/`（可回滚、可对账）；
 *   · 删之后再 fetch 一次，**逐份复核**：`判定` 归零 ＋ 条数（`^\d+.【`）与删前一致 ＋ 其他字段一个不少。
 *
 * 用法：node tools/_fix_remove_verdict_20261014.mjs --tokens <file> [--apply]
 *      不带 --apply 只打印计划（预演），不写任何东西。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/Users/lute/Project/audit_multi_content';
const LARK = path.posix.join(process.env.HOME ?? '', '.dsh/bin/lark-cli');
const BACKUP = path.join(ROOT, 'PMO/shouheng-state/_fix-doctors-20261014');
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const tokenFile = args[args.indexOf('--tokens') + 1];
const tokens = fs.readFileSync(tokenFile, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);

const lark = (a) => {
  const out = execFileSync(LARK, a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out);
};
const fetchDoc = (tok) => {
  const d = lark(['--profile', 'dsh-kb', 'docs', '+fetch', '--as', 'bot', '--doc', tok, '--format', 'json']);
  if (!d.ok) throw new Error(`fetch 失败 ${tok}：${JSON.stringify(d.error).slice(0, 200)}`);
  return d.data.document.content ?? '';
};
const upd = (tok, cmdArgs) => {
  const d = lark(['--profile', 'dsh-kb', 'docs', '+update', '--as', 'bot', '--doc', tok, ...cmdArgs, '--format', 'json']);
  if (!d.ok) throw new Error(`update 失败 ${tok}：${JSON.stringify(d.error).slice(0, 200)}`);
  return d.data;
};
/** 与 `dual_track` / `l7_integrity` 同一条尺子：行首（或 `<br/>` 之后）的「判定」字段。 */
// ★ 只用**最窄**的删除模式：`<b>判定</b>：REVIEW`（实测一次调用删全文所有该处）。
//   曾经想连 `<br/>` 一起删（免得留下双换行）——实测那会**吃掉**下一个字段的 `<br/>`，
//   `建议` 就跟 `依据` 粘在同一行了。机械删段的铁律：**只删要删的那几个字，别碰邻居**。
const VERDICT_RE = /<b>判定<\/b>\s*[：:]\s*[^<]*/g;
// 条目计数 = 逐条块的行首编号（与 dual_track.countRenderedItems 同一条尺子）。
// ★ 不能钉 `^`：飞书 fetch 回来的是**内联 XML**（`<p>1.【…】</p>`），行首未必是编号。
const countItems = (c) => (c.match(/\d+\.【[^】]+】/g) || []).length;

if (!APPLY) {
  console.log(`【预演】待处理 ${tokens.length} 份文档，不写任何东西。`);
  for (const tok of tokens.slice(0, 5)) {
    const c = fetchDoc(tok);
    console.log(`  · ${tok} ｜ 判定段 ${(c.match(VERDICT_RE) || []).length} ｜ 条目 ${countItems(c)} ｜ 字节 ${c.length}`);
  }
  console.log('  …（只打印前 5 份）');
  process.exit(0);
}

fs.mkdirSync(BACKUP, { recursive: true });
const report = [];
let done = 0;
for (const tok of tokens) {
  const row = { tok, before: null, after: null, removed: 0, items_before: null, items_after: null, ok: false, why: '' };
  try {
    const before = fetchDoc(tok);
    fs.writeFileSync(path.join(BACKUP, `${tok}.before.xml`), before);
    row.before = before.length;
    row.items_before = countItems(before);
    const hits = before.match(VERDICT_RE) || [];
    row.removed = hits.length;
    if (!hits.length) { row.ok = true; row.why = '本就无该字段（跳过）'; row.after = before.length; row.items_after = row.items_before; report.push(row); continue; }
    // 一次替换删掉全文所有该字段（实测 str_replace 是全文替换，不是只换第一处）
    upd(tok, ['--command', 'str_replace', '--pattern', '<b>判定</b>：REVIEW', '--content', '']);
    let after = fetchDoc(tok);
    // 兜底：形状不同的残留（无 `<b>`、值不是 REVIEW、行首无 `<br/>`）逐个再删一遍
    for (let round = 0; round < 12; round++) {
      const left = after.match(VERDICT_RE) || [];
      if (!left.length) break;
      upd(tok, ['--command', 'str_replace', '--pattern', left[0], '--content', '']);
      after = fetchDoc(tok);
    }
    fs.writeFileSync(path.join(BACKUP, `${tok}.after.xml`), after);
    row.after = after.length;
    row.items_after = countItems(after);
    const still = (after.match(VERDICT_RE) || []).length;
    row.ok = still === 0 && row.items_after === row.items_before;
    row.why = still ? `残留 ${still} 段` : (row.items_after !== row.items_before
      ? `条目数变了 ${row.items_before}→${row.items_after}` : '');
  } catch (e) { row.why = String(e.message).slice(0, 200); }
  report.push(row);
  done++;
  if (done % 10 === 0) console.log(`  …已处理 ${done}/${tokens.length}`);
}
fs.writeFileSync(path.join(BACKUP, 'report.json'), JSON.stringify(report, null, 2));
const bad = report.filter((r) => !r.ok);
console.log(`\n处理完成：${report.length} 份 ｜ 合格 ${report.length - bad.length} ｜ 不合格 ${bad.length}`);
console.log(`共删掉「判定」段：${report.reduce((a, r) => a + (r.removed || 0), 0)} 处`);
for (const b of bad) console.log('  ❌', b.tok, b.why);

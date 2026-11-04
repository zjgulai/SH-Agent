/**
 * p0_report.test.mjs —— 「**重审重跑、不复用上次结论**」在 P0 快路上的自证（离线，不碰飞书、不跑 python）
 *
 *   node tools/agent/p0_report.test.mjs
 *
 * ── 为什么要有它（Owner 2026-10-21 逐字）：「我要的是重审重跑，**不允许复用上次结论**」
 *
 *   改之前的形状：`prevReport ? 用旧的 : (allowPublish ? 建新的 : 留空)` ——
 *   **只要同一内容以前出过报告，这一单就永远不建新的**。于是同一张图第二次送审时，
 *   `Agent 结论` 按本单重判，而「报告链接」指**第一次**那份 ⇒ 人点开读到的是上一次的结论。
 *
 * ── 两份判据，各管一层（§2.4：判据没盖住的那一跳，就是事故所在的那一跳）
 *
 *   A 组：**判据**（`p0ReportOutcome`，纯函数）—— 五种输入各自该出什么，逐条断言；
 *   B 组：**接线**（真调 `p0HitPayload`，三个外部跳全打桩）—— 判据写对了不等于真被调用，
 *        所以专门断言「建文档这一步被调了几次」。这一组是旧代码必红的那些条。
 *   C 组：**反向对照**（喂已知坏样本 ⇒ 扫描器/断言必须红），以及「旧分支不许复活」。
 */
import fs from 'node:fs';

let nPass = 0; const fails = [];
const ta = async (name, fn) => {
  try { await fn(); nPass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fails.push(name); console.log(`  ❌ ${name}\n       ${e?.message ?? e}`); }
};
const t = (name, fn) => {
  try { fn(); nPass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fails.push(name); console.log(`  ❌ ${name}\n       ${e?.message ?? e}`); }
};
const eq = (a, b, m) => {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`${m ?? '不相等'}：期望 ${B}，实际 ${A}`);
};
const ok_ = (v, m) => { if (!v) throw new Error(m ?? '断言为假'); };

const { p0HitPayload, p0ReportOutcome } = await import('./tools.mjs');

const OLD = 'https://example.feishu.cn/docx/OLDPREV';       // 上一次那份报告
const NEW = 'https://example.feishu.cn/docx/NEWTHIS';       // 本单新建的那份

/* ═════════════ A 组：判据（纯函数，不碰任何外部东西） ═════════════ */
console.log('\n═══ A. 判据：这一格的链接该是哪一份 ═══');

t('A1 送审 + 本单出成了 ⇒ 用**本单**的（即使以前出过）', () => {
  const o = p0ReportOutcome({ allowPublish: true, hasReportPath: true,
                              prevReport: OLD, published: { ok: true, url: NEW, detail: '出好了' } });
  eq(o.url, NEW, '拿旧链接顶上 = 人点开看到上一次的结论');
  eq(o.mode, 'published');
});
t('A2 ★反向对照：旧行为（有旧的就不建/用旧的）在这一条上必然红', () => {
  const o = p0ReportOutcome({ allowPublish: true, hasReportPath: true,
                              prevReport: OLD, published: { ok: true, url: NEW, detail: '' } });
  ok_(o.url !== OLD, '仍是旧链接 —— 那就是改回旧行为了');
});
t('A3 本单没出成 + 有旧链接 ⇒ 回落，但 detail **必须写明不是本单的**', () => {
  const o = p0ReportOutcome({ allowPublish: true, hasReportPath: true,
                              prevReport: OLD, published: { ok: false, detail: '权限没设上' } });
  eq(o.url, OLD, '回落');
  ok_(/不是本单的/.test(o.detail), `detail 没说清是哪一份：${o.detail}`);
  ok_(/本单报告没出成/.test(o.detail), '得先说是「本单没出成」');
  ok_(/权限没设上/.test(o.detail), '原话要带出来（不许糊成一句「失败了」）');
  eq(o.mode, 'fallback');
});
t('A4 ★反向对照：detail 里出现「复用」字样 ⇒ 判红（旧措辞不许回来）', () => {
  const o = p0ReportOutcome({ allowPublish: true, hasReportPath: true,
                              prevReport: OLD, published: { ok: false, detail: 'x' } });
  ok_(!/复用/.test(o.detail), `detail 里还有「复用」：${o.detail}`);
});
t('A5 本单没出成 + 无旧链接 ⇒ **不编**链接', () => {
  const o = p0ReportOutcome({ allowPublish: true, hasReportPath: true,
                              prevReport: null, published: { ok: false, detail: '超时' } });
  eq(o.url, null, '一个点不开/不知道是哪次的链接比空格更坏');
  eq(o.mode, 'none');
});
t('A6 有旧链接、但本单压根没有 report_path ⇒ 也不许拿旧的顶上', () => {
  const o = p0ReportOutcome({ allowPublish: true, hasReportPath: false, prevReport: OLD });
  eq(o.url, null, '没出本单的报告就填旧链接 = 复用上次结论');
  eq(o.mode, 'no_path');
});
t('A7 只读前置 + 有旧链接 ⇒ 边界一字没动（不建文档，给既有的那份并说明）', () => {
  const o = p0ReportOutcome({ allowPublish: false, hasReportPath: true, prevReport: OLD });
  eq(o.url, OLD);
  eq(o.mode, 'readonly');
  ok_(/只读前置/.test(o.detail) && /不是/.test(o.detail), `detail 要说明来路：${o.detail}`);
});
t('A8 只读前置 + 无旧链接 ⇒ 空（不编）', () => {
  const o = p0ReportOutcome({ allowPublish: false, prevReport: null });
  eq(o.url, null);
  eq(o.mode, 'readonly');
});

/* ═════════════ B 组：接线（真调 p0HitPayload，三跳全打桩） ═════════════ */
console.log('\n═══ B. 接线：建文档这一步到底被调了几次 ═══');

const NOFILE = '/tmp/shouheng-p0-report-does-not-exist.md';   // 不存在 ⇒ 对齐核对不读盘

async function runPayload({ allowPublish, withPath = true, prev = null,
                            pub = { ok: true, url: NEW, detail: '出好了' } } = {}) {
  const calls = { publish: 0, prev: 0, fast: 0 };
  const p0 = {
    mode: 'fastpath', elapsed_ms: 12, matched_patterns: 1, issue_count: 1,
    findings: [{ rule_code: 'P0-X' }], rendered: '共发现 1 处\n',
    ...(withPath ? { report_path: NOFILE } : {}),
  };
  const r = await p0HitPayload({
    p0, text: 'm5pro是最好的吸奶器', allowPublish,
    p0ReportPath: withPath ? NOFILE : null,
    prevLinkOf: async () => { calls.prev += 1; return prev; },
    publishDoc: async () => { calls.publish += 1; return pub; },
    fastpath: async () => { calls.fast += 1; return { rendered: '共发现 1 处\n' }; },
  });
  return { r, calls };
}

await ta('B1 送审 + 以前出过报告 ⇒ 建文档**必须**被调 1 次（旧代码这里是 0）', async () => {
  const { r, calls } = await runPayload({ allowPublish: true, prev: OLD });
  eq(calls.publish, 1, '没建本单的报告 —— 又是「复用上一次」');
  eq(r.report, NEW, '表里的链接必须是本单那份');
});
await ta('B2 ★反向对照：只读前置 ⇒ 建文档一次都不许调（内核那条路以前也不建）', async () => {
  const { calls } = await runPayload({ allowPublish: false, prev: OLD });
  eq(calls.publish, 0, '只读前置建了文档 = 顺手改了别人的工作流');
});
await ta('B3 没有 report_path ⇒ 建文档一次都不许调', async () => {
  const { r, calls } = await runPayload({ allowPublish: true, withPath: false, prev: OLD });
  eq(calls.publish, 0);
  eq(r.report, '', '没有本单报告就留空，不许填旧的');
});
await ta('B4 拿到链接 ⇒ 回执**重渲染**一次（带上的必须是这份链接）', async () => {
  const { calls } = await runPayload({ allowPublish: true, prev: OLD });
  eq(calls.fast, 1, '重渲染这一步被弄丢了');
});
await ta('B5 没拿到链接 ⇒ 不重渲染（别拿空链接去重刷回执）', async () => {
  const { calls } = await runPayload({ allowPublish: true, withPath: false, prev: OLD });
  eq(calls.fast, 0);
});
await ta('B6 本单没出成 + 有旧链接 ⇒ 表里那格回落，但 report_detail 必须写明来路', async () => {
  const { r } = await runPayload({ allowPublish: true, prev: OLD,
                                   pub: { ok: false, detail: 'cloud doc 建失败' } });
  eq(r.report, OLD);
  ok_(/不是本单的/.test(r.report_detail), `detail 没写清：${r.report_detail}`);
});

/* ═════════════ C 组：反向对照（坏样本必须红） ═════════════ */
console.log('\n═══ C. 反向对照 ═══');

/** 旧分支的指纹串：它出现在生产代码里 = 「有旧的就不建新的」复活了。 */
const OLD_BRANCH_MARK = '♻️ 同一内容已有报告，复用不新建';
const hasOldBranch = (src) => String(src ?? '').includes(OLD_BRANCH_MARK);

t('C1 生产代码里**不许**再有旧分支的指纹串', () => {
  const src = fs.readFileSync(new URL('./tools.mjs', import.meta.url), 'utf8');
  ok_(!hasOldBranch(src), `旧分支复活了（${OLD_BRANCH_MARK}）—— 那就是又在复用上一次的报告`);
});
t('C2 ★反向对照：喂一段含该指纹串的坏样本 ⇒ 同一个扫描器必须红', () => {
  ok_(hasOldBranch(`if (prevReport) { console.log('${OLD_BRANCH_MARK}'); }`),
      '扫描器对坏样本不红 —— 那 C1 恒真，等于没有断言');
});

console.log(`\n═══ 合计：通过 ${nPass} / 失败 ${fails.length} ═══`);
if (fails.length) { console.log('失败明细：'); for (const f of fails) console.log('  ·', f); }
process.exit(fails.length ? 1 : 0);

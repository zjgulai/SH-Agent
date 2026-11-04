#!/usr/bin/env node
/**
 * merged_report.test.mjs —— **报告模版只有一份，而且必须是你点名的那一份**
 *
 *   node tools/agent/merged_report.test.mjs
 *
 * Owner 2026-10-20（逐字，两次）：
 *   「守衡输出的报告模版又乱了，怎么一会一个样子，**到底是谁在改模版？**」
 *   「**必须按照我要求的报告模版输出**」
 *
 * ── 黄金样张
 * 飞书云文档 `FzWyddOlkoy4kDxqu4NceiVMnjb`（守衡 **2026-10-20 17:12** 自己产出的那份）。
 * 骨架（本判据逐段核，顺序也算）：
 *
 *   # 内容审查报告
 *   【审查结论：REVIEW】共发现 3 处需人工确认。
 *   · X类问题：N 个
 *   一句话：……
 *   ## 审查对象
 *   ## **一、问题总览**        ｜ # ｜ 优先级 ｜ 所属类别 ｜ 位置 ｜ 命中描述 ｜ 承办 ｜
 *   ## **二、问题清单（P0 → P1 → P2 → P3）**   ｜ **F-01 ｜ 一级·二级 ｜ P1**
 *   ## **三、执行（按问题分派）**               （BLOCK ⇒ `三、执行（打回，修改后重新提交）`）
 *
 * ── 这份判据防的是什么（真事故，不是假想）
 * **同一个标题《内容审查报告》有两个产者**：
 *   · 守衡 `tools/agent/merged_report.mjs`   → 上面这个骨架（**Owner 要的那份**）；
 *   · 知识库 `kb/l7/review-engine/core/feishu_publish.py` → 「一、问题分类汇总」＋
 *     「二、完整清单」＋ L0 定位直链（**另一套版式**）。
 * 卡片上 `→ 完整清单：` 那个链接走 `reportUrlOverride || kb.reportUrl`（`dual_track.mjs:4183`）
 * ⇒ 守衡那份**一失败就换成库侧那份** ⇒ 同一个人两次点开看到的报告长得不一样
 * （2026-10-20 17:12 与 18:59 两单，相隔不到两小时，就是这一条）。
 *
 * 行为侧的修复在 `review_publish.mjs`（回读验不成不再换产者，判据 G1–G4）；
 * **这一份钉的是模版本身**：形状少一段、多一段、顺序乱了，都得红。
 *
 * ── 反向对照（证明判据不是恒真）
 *   R1 把**库侧那份的真实片段**喂给同一个检查器 ⇒ 必须判不合格；
 *   R2 把「二、问题清单」这一段从守衡报告里删掉 ⇒ 必须判缺段；
 *   R3 把「审查对象」与「三、执行」对调 ⇒ 顺序判据必须红。
 */
import { renderMergedReportMd, shouldPublishMergedReport } from './merged_report.mjs';

let pass = 0;
const bad = [];
const ok_ = (m) => { pass += 1; console.log(`  ✅ ${m}`); };
const no = (m, w) => { bad.push(`${m} —— ${w}`); console.log(`  ❌ ${m}\n       ${w}`); };

/* ── 夹具：与真单同形的三条（分类/位置都有）────────────────────────────── */
const F = (category, location) => ({
  location, category, severity: 'REVIEW', source: 'model',
  reason: '读者可能理解为本品牌背书', advice: '补上报告名与年份',
});
const ITEMS = [
  F('背书与披露透明', '图 1 文字区'),
  F('平台与渠道政策', '图 1 画面全幅'),
  F('未归类', '图 1 文字区中部'),
];

const render = (state = 'REVIEW') => renderMergedReportMd({
  merged: ITEMS,
  total: ITEMS.length,
  state,
  line: `【审查结论：${state}】共发现 ${ITEMS.length} 处需人工确认。`,
  question: '审一下这份送审素材能不能发',
  material: { text: '素材原文一句话' },
  withAppendix: false,
});

{
  // ★ 2026-10-22（Owner：「报告不展示 图片安全审查 skill 全流程结果」）：
  //   这一组从「必须进报告」翻成**「一个字都不许可进报告」**，并补反向对照 ——
  //   把一长串 skill 正文当成参数喂进去，报告里出现任何一个特征串都算红。
  const imageSkillReview = [
    '审核对象与范围：图片 1，检查产品宣称与婴儿睡眠安全。',
    '视觉分析与 OCR：图片含有 AAP Recommendation。',
    '主张拆分与核查清单：逐条核查来源署名与睡姿。',
    '4A 规则符合性：知识库命中历史参考条款。',
    '4B 事实准确性核查：AAP 指南要求婴儿仰卧睡眠。',
    '图文一致性：图片把同床与安全建议并列。',
    '视觉核对清单：婴儿睡眠位置有（侧卧）。',
  ].join('\n');
  const doc = renderMergedReportMd({
    merged: [F('产品安全与高危使用场景', '图片顶部，图 1 第 2 处')],
    total: 1, state: 'REVIEW', line: '【审查结论：REVIEW】共发现 1 处需人工确认。',
    material: { text: '图片素材' }, imageSkillReview, withAppendix: false,
  });
  const leaks = ['图片安全审查 skill 全流程结果', '4A 规则符合性', '4B 事实准确性核查',
    '视觉核对清单', '主张拆分与核查清单', '审核对象与范围']
    .filter((x) => doc.includes(x));
  if (!leaks.length) {
    ok_('T5 报告不再展示图片安全审查 skill 全流程结果（六个阶段特征串一个都没进）');
  } else no('T5 报告里出现了 skill 全流程正文', `命中：${leaks.join('、')}`);

  // T6/T7：图片审查不再是「无条件出报告」的理由 —— 门槛回到 PRD §5.3.4 的 ≥3。
  if (!shouldPublishMergedReport({ total: 1, itemCount: 1 })) {
    ok_('T6 <3 条不再因为「完整图片审查」强行出报告（补出的是只有一句结论的空文档）');
  } else no('T6 图片完整审查低于 3 条仍被强制出报告', 'skill 正文已撤，报告里没有能装的东西');
  if (shouldPublishMergedReport({ total: 3, itemCount: 3 })) {
    ok_('T7 ≥3 条照旧出报告（PRD §5.3.4 门槛没动）');
  } else no('T7 报告门槛被顺手改坏了', '≥3 条却不发报告');
  if (!shouldPublishMergedReport({ total: 0, itemCount: 0 })) {
    ok_('T8 0 条不出报告（不造点开没内容的链接）');
  } else no('T8 零问题仍出报告', '会造出只有一句结论的空文档');

  const cleanImage = renderMergedReportMd({
    merged: [], total: 0, state: 'PASS', line: '【审查结论：PASS】共发现 0 处问题。',
    imageSkillReview, material: { text: '图片素材' }, withAppendix: false,
  });
  if (!/图片安全审查 skill 全流程结果/.test(cleanImage) && !/4B 事实准确性核查/.test(cleanImage)) {
    ok_('T9 零问题图片报告同样不带 skill 全流程正文');
  } else no('T9 零问题图片报告漏了全流程正文没撤干净', cleanImage.slice(-500));
}

/* ── 模版契约：每段一个标签 + 一条正则 ───────────────────────────────────── */
const SECTIONS = (state) => ([
  ['① 标题 `# 内容审查报告`', /^# 内容审查报告$/m],
  ['② 结论行 `【审查结论：X】…`', /^【审查结论：(PASS\+SUGGEST|PASS|REVIEW|BLOCK)】/m],
  ['③ 分类汇总行 `· X类问题：N 个`', /^· .+类问题：\d+ 个$/m],
  ['④ `一句话：…`', /^一句话：/m],
  ['⑤ `## 审查对象`', /^## 审查对象$/m],
  ['⑥ `## **一、问题总览**`', /^## \*\*一、问题总览\*\*$/m],
  ['⑦ 总览表头（#/优先级/所属类别/位置/命中描述/承办）',
    /^\| # \| 优先级 \| 所属类别 \| 位置 \| 命中描述 \| 承办 \|$/m],
  ['⑧ `## **二、问题清单（P0 → P1 → P2 → P3）**`',
    /^## \*\*二、问题清单（P0 → P1 → P2 → P3）\*\*$/m],
  ['⑨ 条目首行 `**F-01 ｜ 一级·二级 ｜ Pn**`', /^\*\*F-\d{2} ｜ .+ ｜ P\d\*\*$/m],
  ['⑩ `## **三、执行（按问题分派）**`（REVIEW）', /^## \*\*三、执行（按问题分派）\*\*$/m],
]);

/** 库侧 `feishu_publish.py` 那套版式的标志串 —— **在你要的模版里一个都不许出现**。 */
const KB_ONLY = [
  ['库侧「问题分类汇总」', /问题分类汇总/],
  ['库侧「二、完整清单」', /^## 二、完整清单/m],
  ['库侧「用户原提问」', /用户原提问/],
];

/**
 * 检查器：返回 `{missing:[标签…], extra:[标签…], outOfOrder:[…]}`。
 * ⚠️ 检查器**必须能被坏样本判红**（见 R1–R3），否则它只是注释。
 */
function check(md, state = 'REVIEW') {
  const text = String(md ?? '');
  const missing = [];
  const pos = [];
  for (const [label, re] of SECTIONS(state)) {
    const m = text.match(re);
    if (!m) { missing.push(label); pos.push(-1); continue; }
    pos.push(typeof m.index === 'number' ? m.index : text.indexOf(m[0]));
  }
  const outOfOrder = [];
  for (let i = 1; i < pos.length; i += 1) {
    if (pos[i - 1] < 0 || pos[i] < 0) continue;
    if (pos[i] <= pos[i - 1]) outOfOrder.push(SECTIONS(state)[i][0]);
  }
  const extra = KB_ONLY.filter(([, re]) => re.test(text)).map(([label]) => label);
  return { missing, extra, outOfOrder };
}

/* ═════════════════════════ 1. 你要的那份模版 ═════════════════════════ */
console.log('\n═══ 1. 报告模版（黄金样张 = docx FzWyddOlkoy4kDxqu4NceiVMnjb）═══');

const T_REVIEW = render('REVIEW');
{
  const r = check(T_REVIEW, 'REVIEW');
  if (r.missing.length === 0) ok_('T1 十段骨架**全在**（标题 → 结论行 → 汇总行 → 一句话 → 审查对象 → 总览 → 表头 → 清单 → F 序号 → 执行）');
  else no('T1 十段骨架必须全在', `缺：${r.missing.join(' ／ ')}`);
  if (r.extra.length === 0) ok_('T2 守衡这份里**没有**库侧那套标志串（问题分类汇总／完整清单／用户原提问）');
  else no('T2 守衡这份里不许出现库侧那套', `出现了：${r.extra.join('、')}`);
  if (r.outOfOrder.length === 0) ok_('T3 十段**顺序**正确（审查对象 → 一 → 二 → 三，不许倒置）');
  else no('T3 十段顺序必须正确', `乱序：${r.outOfOrder.join('、')}`);
}

{
  const BLOCK = render('BLOCK');
  const has = /^## \*\*三、执行（打回，修改后重新提交）\*\*$/m.test(BLOCK);
  const tail = /请修改后重新提交。/.test(BLOCK);
  const noAt = !/建议转 @/.test(BLOCK);
  if (has && tail) ok_('T4 BLOCK 支：第三节换成「执行（打回，修改后重新提交）」＋ PRD 收尾句');
  else no('T4 BLOCK 支必须按 PRD 打回口径', `标题=${has} 收尾句=${tail}`);
  if (noAt) ok_('T4b BLOCK 支**不 @ 任何人**（PRD：命中 block 直接打回，不派单）');
  else no('T4b BLOCK 支不许 @ 人', '出现了「建议转 @…」');
}

/* ═════════════════════ 2. 反向对照（判据不许恒真）═════════════════════ */
console.log('\n═══ 2. 反向对照（喂坏样本，判据必须红）═══');

{ // R1：库侧那份真实片段（抄自真单 Cj2zdzbbmoNlSzxJ6ypcst3Vn2g 的实测正文）
  const KB_SAMPLE = [
    '# 内容审查报告 · rv-20261020-185944',
    '',
    '- 用户原提问：审一下这份送审素材能不能发',
    '- 结论：**REVIEW** ｜ 问题数量：**4**（库内依据）',
    '',
    '## 一、问题分类汇总',
    '',
    '| 分类 | 条数 |',
    '|---|---|',
    '| 负面样本-N-01 | 1 |',
    '',
    '## 二、完整清单（4 条）',
  ].join('\n');
  const r = check(KB_SAMPLE, 'REVIEW');
  if (r.missing.length >= 5 && r.extra.length >= 2) {
    ok_(`R1 库侧版式被判不合格（缺 ${r.missing.length} 段 · 撞库侧标志 ${r.extra.length} 个）—— 判据咬得住另一套模版`);
  } else {
    no('R1 库侧版式必须被判不合格', `只缺 ${r.missing.length} 段、只撞 ${r.extra.length} 个标志 ⇒ 判据太松`);
  }
}

{ // R2：删掉「二、问题清单」这一整段
  const broken = T_REVIEW.replace(/^## \*\*二、问题清单（P0 → P1 → P2 → P3）\*\*$/m, '## 二、被删掉了');
  const r = check(broken, 'REVIEW');
  const hit = r.missing.some((l) => /二、问题清单/.test(l));
  if (hit) ok_('R2 删掉「二、问题清单」⇒ 精确判缺段');
  else no('R2 删段必须判红', `缺段清单里没有它：${r.missing.join('／') || '(空)'}`);
}

{ // R3：把「审查对象」与「三、执行」对调
  const a = '## 审查对象';
  const b = '## **三、执行（按问题分派）**';
  const swapped = T_REVIEW.replace(a, '@@A@@').replace(b, a).replace('@@A@@', b);
  const r = check(swapped, 'REVIEW');
  if (r.outOfOrder.length > 0) ok_('R3 两节对调 ⇒ 顺序判据精确变红');
  else no('R3 顺序判据必须咬得住', '对调之后仍判全序正确');
}

/* ═════════════════════════════ 3. 收尾 ═════════════════════════════ */
console.log(`\n═══ 合计：通过 ${pass} / 失败 ${bad.length} ═══`);
if (bad.length) { console.log('失败明细：'); for (const b of bad) console.log('  ·', b); }
process.exit(bad.length ? 1 : 0);

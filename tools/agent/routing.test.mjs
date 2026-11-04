#!/usr/bin/env node
/**
 * routing.test.mjs —— 「**按问题方向转对应专业团队**」的判据（PRD §5.3.2 / §9）
 *
 * ## 为什么需要它
 *
 * Owner 2026-10-14 报：PRD §5.3.2 **两处**逐字写着
 *
 *     建议转 @法务 @医学顾问 复核。
 *
 * 而守衡发出去的是 `建议转 @内容治理负责人 复核。` —— 一个**硬编码常量**，
 * 收件人既不在 PRD 那四个专业团队里，也**不随问题方向变**。
 *
 * 这一套判据钉三件事：
 *   ① 收件人**按方向**从库里的 `routing-policy.json` 算（不是常量）；
 *   ② 那句 `建议转 … 复核。` 的**句式**保住（PRD §5.3 的收尾），且不出现「内容治理负责人」；
 *   ③ 读不到路由表 / 匹配不到方向 / 句柄没配 —— 三种「不知道」都**如实说**，不编。
 *
 * ## 反向对照（拆掉修复必须精确变红）
 *
 *   R1 把路由表喂成 `null` ⇒ 必须**落到 PRD 默认那一对**，而不是常量；
 *   R2 喂一条方向词命中不了的类别 ⇒ 必须走 fallback 并**标出未匹配条数**；
 *   R3 喂一条句柄已配的假句柄表 ⇒ 必须输出真 `@handle` 而不是「（未配置）」；
 *   R4 把 `reason` 塞满「医疗」而 `category` 是措辞 ⇒ 路由**不许**被 reason 带偏。
 *
 * 用法：`node tools/agent/routing.test.mjs`
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PRD_DEFAULT_OWNERS, loadRoutingPolicy, loadRoleHandles,
  reviewOwnersFor, renderReviewAction, directionOf,
  routingPolicyPath, approversPath,
} from './routing.mjs';

let pass = 0, fail = 0;
const bad = [];
const ok = (m) => { pass++; console.log(`  ✅ ${m}`); };
const no = (m, w) => { fail++; bad.push(`${m} —— ${w}`); console.log(`  ❌ ${m}\n       ${w}`); };
const eq = (m, got, want) => (JSON.stringify(got) === JSON.stringify(want)
  ? ok(m) : no(m, `得到 ${JSON.stringify(got)}，预期 ${JSON.stringify(want)}`));
const head = (t) => console.log(`\n${t}`);

const POLICY = loadRoutingPolicy();
const HANDLES = loadRoleHandles();
const F = (category, extra = {}) => ({ location: '全文', category, severity: 'REVIEW', ...extra });
const line = (items, policy = POLICY, handles = HANDLES) => {
  const r = reviewOwnersFor(items, policy);
  const meta = { unmatched: r.unmatched, total: items.length, fallback: policy?.fallback };
  return {
    ...r,
    // 卡面（紧凑）：不印「（未配置）」「（n/m 条未匹配方向）」—— PRD §17 的字数让位
    text: renderReviewAction(r.owners, handles, meta),
    // 报告那一支（compact:false）：两串读数照旧印，保证「没有丢」
    textVerbose: renderReviewAction(r.owners, handles, { ...meta, compact: false }),
  };
};

/* ─────────────── ① 路由表真的读到了（不是靠默认值蒙对） ─────────────── */
head('① 路由表 · 读到库里的真源，而不是靠默认值');
{
  if (!POLICY) no('①a 路由表读得到', `没读到：${routingPolicyPath()}`);
  else ok(`①a 路由表读得到（${POLICY.version}，${POLICY.rules.length} 条 rules）`);

  // ①b 路径是**探测**出来的，不是写死一个工作区绝对路径 —— 换布局不该断
  const p = routingPolicyPath();
  if (!fs.existsSync(p)) no('①b 路由表文件真存在', p);
  else ok(`①b 路由表文件真存在（${p.replace(os.homedir(), '~')}）`);

  if (!fs.existsSync(approversPath())) no('①c 句柄表文件存在', approversPath());
  else ok('①c 句柄表文件存在（与库侧 `_approvers` 同一份）');
}

/* ─────────────── ② 按方向转人：不同方向必须转不同人 ─────────────── */
head('② 方向 → 收件人 · 不同方向必须转不同的人（这就是 Owner 那条要求）');
{
  const med = line([F('合规-医疗宣称')]);
  const loc = line([F('本地化-计量单位')]);
  const end = line([F('背书与资质')]);
  const prod = line([F('产品-型号规格')]);

  // ②a 医疗方向 ⇒ 医学顾问 ＋ 法务（PRD §5.3.2 那一对）
  eq('②a 医疗方向 ⇒ 医学顾问 + 法务', med.owners.slice().sort(), ['医学顾问', '法务'].sort());
  // ②b 本地化方向 ⇒ 北美同事
  eq('②b 本地化方向 ⇒ 北美同事', loc.owners, ['北美同事']);
  // ②c 背书方向 ⇒ 法务 + 渠道负责人
  eq('②c 背书方向 ⇒ 法务 + 渠道负责人', end.owners, ['法务', '渠道负责人']);
  // ②d 产品方向 ⇒ 产品负责人 + 法务
  eq('②d 产品方向 ⇒ 产品负责人 + 法务', prod.owners, ['产品负责人', '法务']);

  // ②e ★ 这条才是 Owner 报的那个缺陷：**不同方向必须给出不同的行**
  if (med.text === loc.text) no('②e 不同方向不许得到同一行', `医疗与本地化都得到：${med.text}`);
  else ok('②e 不同方向得到不同的行（缺陷本身就是「恒为同一个人」）');
}

/* ─────────────── ③ 那句句式：保住 PRD §5.3 的收尾，去掉错收件人 ─────────────── */
head('③ 收尾句式 · 保 `建议转 … 复核。`，去 `内容治理负责人`');
{
  const t = line([F('合规-医疗宣称')]).text;
  // ③a 句式必须是 PRD §5.3.2 那个形状
  if (!/^建议转 @\S.* 复核。/.test(t)) no('③a 句式合 PRD §5.3.2', `实际：${t}`);
  else ok(`③a 句式合 PRD §5.3.2（建议转 @… 复核。）`);
  // ③b 那个错的收件人不许再出现
  if (/内容治理负责人/.test(t)) no('③b 不许再出现「内容治理负责人」', t);
  else ok('③b 不再出现「内容治理负责人」');
  // ③c 收件人必须是 PRD §9 那四个专业团队里的人
  const legal4 = ['法务', '医学顾问', '专家', '北美同事'];
  const got = line([F('合规-医疗宣称')]).owners;
  if (!got.every((o) => legal4.includes(o))) no('③c 收件人须出自 PRD §9 四团队', got.join('/'));
  else ok(`③c 收件人出自 PRD §9 四团队（${got.join(' / ')}）`);
}

/* ─────────────── ④ 三种「不知道」都不许编 ─────────────── */
head('④ 不知道就说不知道 · 三种情形都不许编一个收件人');
{
  // ④a 读不到路由表 ⇒ 回落 PRD 默认那一对（不编第三个）
  const fallback = line([F('合规-医疗宣称')], null);
  eq('④a 读不到路由表 ⇒ 回落 PRD 默认', fallback.owners, PRD_DEFAULT_OWNERS);
  eq('④a2 且标明来源是默认值', fallback.source, 'prd_default');

  // ④b 方向词一个都命中不了 ⇒ 走路由表自己声明的 `fallback_review_owners`，
  //     **次序照 PRD §9 的并列次序**（法务在前），不许被 Set 打乱
  const unknown = line([F('某个没登记过的方向')]);
  eq('④b 未命中方向 ⇒ 走路由表的 fallback（次序照 PRD）',
     unknown.owners, ['法务', '北美同事']);
  // ★★ 2026-10-19（Owner：REVIEW ≥3 整卡要 ≤100 字）：卡面**紧凑**（不印这一串），
  //   但它**没有丢** —— 报告那一支（`compact:false`）照印。⇒ 断言按介质分开。
  if (!/未匹配方向/.test(unknown.textVerbose)) no('④b2 未命中要出声（报告那一支）', unknown.textVerbose);
  else ok('④b2 报告里如实标出「未匹配方向」（不静默当成路由过了）');
  if (/未匹配方向/.test(unknown.text)) no('④b3 卡面必须紧凑（这串属分派质量读数）', unknown.text);
  else ok('④b3 卡面紧凑：不印「未匹配方向」');

  // ④c **部分**未命中也要出声 —— 否则整行看起来像全都路由过了
  const part = line([F('合规-医疗宣称'), F('某个没登记过的方向')]);
  if (!/1\/2 条未匹配方向/.test(part.textVerbose)) no('④c 部分未命中要给出比例（报告）', part.textVerbose);
  else ok('④c 报告里给出比例（1/2）');

  // ④d 句柄没配 ⇒ 「角色名（未配置）」，不写死一个人名
  if (!/（未配置）/.test(line([F('合规-医疗宣称')]).textVerbose)) {
    no('④d 句柄没配要在报告里说「未配置」', line([F('合规-医疗宣称')]).textVerbose);
  } else ok('④d 句柄没配 ⇒ 输出「角色名（未配置）」，不写死人名');

  // ④e 空清单 ⇒ 不抛、不编
  const empty = line([]);
  eq('④e 空清单不抛且不编收件人', empty.owners, []);

  // ④f ★ 空清单时**渲染出来也不许是空的收件人** —— 实测抓到的真缺陷：
  //     第一版输出 `建议转  复核。`（两个空格、没有宾语）。而库侧**覆盖缺口那一支
  //     恒为空清单**（`issue_count = 0`）⇒ 这条不是理论边界，是必然走到的一支。
  const emptyText = renderReviewAction([], HANDLES, { unmatched: 0, total: 0,
    fallback: POLICY?.fallback });
  if (/建议转\s{2,}复核/.test(emptyText)) no('④f 空清单不许渲染出空收件人', `实际：${emptyText}`);
  else ok(`④f 空清单渲染成有宾语的一句（${emptyText}）`);
}

/* ─────────────── ⑤ 方向只吃方向字段，不吃 reason ─────────────── */
head('⑤ 方向字段才是方向 · `reason` 里的词不许把路由带偏');
{
  // ⑤a `directionOf` 不含 reason
  const d = directionOf({ category: '措辞表达', reason: '不得宣称医疗功效' });
  if (/医疗/.test(d)) no('⑤a directionOf 不许吃 reason', d);
  else ok('⑤a directionOf 只取方向字段（不吃 reason）');

  // ⑤b ★ 反向对照：reason 里塞满「医疗 功效 睡眠」，路由仍须按 category 走
  const sneaky = line([F('本地化-计量单位', { reason: '医疗 功效 睡眠 认证 背书 达人 平台 文化' })]);
  eq('⑤b reason 里的方向词不许改变路由结果', sneaky.owners, ['北美同事']);
}

/* ─────────────── ⑥ 反向对照（拆掉修复必须精确变红） ─────────────── */
head('⑥ 反向对照 · 喂坏样本必须红');
{
  // ⑥a 喂一份**空 rules** 的假表 ⇒ 必须落到 fallback，且**不许**等于「按方向算出来的」
  const emptyPolicy = { version: 'test', roles: {}, rules: [], fallback: [] };
  const r = line([F('本地化-计量单位')], emptyPolicy);
  eq('⑥a 空 rules 的表 ⇒ 回落 PRD 默认（不再按方向）', r.owners, PRD_DEFAULT_OWNERS);
  if (r.owners.join() === '北美同事') no('⑥a2 空表不许还给出方向结果', '退化了却没红');
  else ok('⑥a2 空表下方向结果确实消失了（说明 ②b 真的在按表算）');

  // ⑥b 假句柄表 ⇒ 必须输出真 @handle（证明「（未配置）」不是恒定的）
  const fake = new Map([['法务', '成员B'], ['医学顾问', '某医学顾问']]);
  const withH = line([F('合规-医疗宣称')], POLICY, fake);
  if (!/@成员B/.test(withH.text)) no('⑥b 配了句柄就要输出真 @handle', withH.text);
  else ok(`⑥b 配了句柄 ⇒ 输出真 @handle（${withH.text}）`);
  if (/（未配置）/.test(withH.text)) no('⑥b2 配了句柄就不许再说未配置', withH.text);
  else ok('⑥b2 配了句柄就不再说「未配置」');

  // ⑥c 把旧常量当输入喂回来 ⇒ 必须能被认出「这是旧行为」（自证判据不是恒绿）
  const OLD = '建议转 @内容治理负责人 复核。';
  if (!/内容治理负责人/.test(OLD)) no('⑥c 旧常量样本本身要含那个词', OLD);
  else ok('⑥c 旧常量样本确实含「内容治理负责人」⇒ ③b 不是空断言');

  // ⑥d 所有方向都命中不了时，**不许**输出一个空的「建议转  复核。」
  const allUnknown = line([F('甲'), F('乙')]);
  if (/建议转\s+复核/.test(allUnknown.text)) no('⑥d 不许输出空收件人', allUnknown.text);
  else ok('⑥d 未命中时也不会输出空收件人（回落兜住）');
}

/* ─────────────── ⑦ 与 PRD §5.3 的格式契约不打架 ─────────────── */
head('⑦ 与 PRD §5.3 格式契约 · 动作行不进结论行，两者不打架');
{
  const { conforms } = await import('./prd53.mjs');
  const { conclusionLine } = await import('./prd53.mjs');
  const block = [
    '【审查结论：REVIEW】共发现 2 处需人工确认。',
    '',
    '1.【合规-医疗宣称】视频 00:12 字幕涉嫌医疗宣称。',
    '',
    line([F('合规-医疗宣称')]).text,
  ].join('\n');

  const cl = conclusionLine(block);
  if (!cl) no('⑦a 结论行仍取得到', '取不到');
  else if (!conforms(cl.line).ok) no('⑦a 结论行仍合 §5.3', conforms(cl.line).why);
  else ok('⑦a 结论行不受影响，仍合 §5.3（动作行不在结论行里）');

  // ⑦b 动作行自己不许被当成结论行
  const act = line([F('合规-医疗宣称')]).text;
  if (conclusionLine(act)) no('⑦b 动作行不许被认成结论行', act);
  else ok('⑦b 动作行不被认成结论行（口径没混）');
}

/* ─────────────── 汇总 ─────────────── */
console.log(`\n${'═'.repeat(64)}`);
console.log(`通过 ${pass} 项 · 不通过 ${fail} 项`);
if (fail) {
  console.log('\n不通过明细：');
  for (const b of bad) console.log(`  · ${b}`);
  console.log('\n❌ 路由还不合 PRD §5.3.2 / §9，别拿去发群。');
  process.exit(1);
}
console.log('✅ 收件人按问题方向算、句式合 PRD、三种「不知道」都如实说。');

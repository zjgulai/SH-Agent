#!/usr/bin/env node
/**
 * p0_short_reply.test.mjs —— P0 命中那一路的**短卡**要求（2026-10-12，Owner 同意）
 *
 *   node tools/agent/p0_short_reply.test.mjs
 *
 * ⚠️ **一台真库、一个真模型都不碰**：全部喂夹具，只验「这一单要不要附短卡要求」这一件事。
 *
 * ── 为什么要有这个文件
 *
 * 实测（守衡日志逐字）：一条 **P0 命中**的送审单，结果卡 **2903 字 / 54541 ms**，
 * 而它的判定**在 48 ms 就定了**（`🚦 P0 命中 ⇒ 直接 BLOCK，不起链：H05｜48.297 ms`）。
 * Owner 2026-10-12 把 PRD §12 的口径裁定为「**用户实际等多久**」，
 * 于是这一路的 54 秒就是**硬指标不达标**的直接来源（三档实测：文字中位 101 s）。
 *
 * ⇒ 改法只有一条路：**让这一路少写字**。但「少写字」最怕两件事，本文件的判据就是钉这两件：
 *   ① **串台** —— 短卡要求漏进评审链/拒答/普通对话 ⇒ 那些场合的正文被压瘪；
 *   ② **抽掉必须项** —— 把「结论行 / 命中模式与条款号 / 报告链接」一起省掉。
 *
 * ①的判据 = B 组（**反向对照**：非 P0 的四种夹具必须**一个字都不加**）；
 * ②的判据 = A2（三样必须项**逐个点名**在指令里，少一样就红）。
 * 变异测试（C 组）证明 B 组不是恒真：把条件放宽成「总是附」⇒ B 组精确变假。
 */
import { P0_SHORT_REPLY_INSTRUCTION, p0ShortReplyBlock } from './agent.mjs';

const res = [];
const ck = (n, c, ex = '') => res.push([n, !!c, ex]);

// ── A 组：P0 命中的真实形状（字段取自引擎真输出／守衡日志逐字）──────────────────
const p0Hit = {
  p0_fastpath: { elapsed_ms: 48.297, matched_patterns: 1, rule_codes: ['H05'],
                 article_no: 'W-1.33' },
  conclusion: 'BLOCK',
  report: 'https://momcozy-in.feishu.cn/docx/VkYYdJPs5ohoAux0YorcMeZIn1g',
};
ck('A1 P0 命中 ⇒ 附短卡要求', p0ShortReplyBlock(p0Hit) === P0_SHORT_REPLY_INSTRUCTION, '');
ck('A2 指令里**逐个点名**三样必须项（结论行 / 模式与条款号 / 报告链接）',
   ['结论行', '条款号', '报告链接'].every((k) => P0_SHORT_REPLY_INSTRUCTION.includes(k)),
   P0_SHORT_REPLY_INSTRUCTION.slice(0, 40));
ck('A3 指令带**篇幅上限**（否则「短卡」是一句空话）',
   /≤\s*\d+\s*字/.test(P0_SHORT_REPLY_INSTRUCTION), '');
ck('A4 指令说清「本条是确定性命中」（免得模型把它当推断再论证一遍）',
   P0_SHORT_REPLY_INSTRUCTION.includes('确定性命中'), '');

// ── B 组：反向对照 —— 非 P0 的四种形状**一律不附**（串台就是缺陷）──────────────
ck('B1 评审链（review 在场、没有 p0_fastpath）⇒ 不附',
   p0ShortReplyBlock({ review: { state: 'REVIEW', issue_count: 3 } }) === '', '');
ck('B2 拒答（refusal 在场）⇒ 不附',
   p0ShortReplyBlock({ review: { refusal: { reason_code: 'coverage_not_covered' } } }) === '', '');
ck('B3 普通对话 / 空 res ⇒ 不附', p0ShortReplyBlock({}) === '', '');
ck('B4 undefined / null ⇒ 不附（不许抛）',
   p0ShortReplyBlock(undefined) === '' && p0ShortReplyBlock(null) === '', '');
ck('B5 `p0_fastpath: null` ⇒ 不附（缺席 ≠ 命中）',
   p0ShortReplyBlock({ p0_fastpath: null }) === '', '');

// ── C 组：变异测试 —— 证明 B 组有牙（判据不是恒真）────────────────────────────
const mutatedAlways = () => P0_SHORT_REPLY_INSTRUCTION;   // 把条件放宽成「总是附」
ck('C1 变异：条件放宽成「总是附」⇒ B3 那类反例精确变假',
   mutatedAlways({}) !== p0ShortReplyBlock({}), '');
// 去掉必须项里的「报告链接」⇒ A2 必须精确变假
const gutted = P0_SHORT_REPLY_INSTRUCTION.replace('报告链接', '（略）');
ck('C2 变异：把「报告链接」从指令里抽掉 ⇒ A2 精确变假',
   !['结论行', '条款号', '报告链接'].every((k) => gutted.includes(k)), '');

let bad = 0;
console.log('p0_short_reply.test —— P0 命中那一路的短卡要求（Owner 2026-10-12）');
for (const [n, ok, ex] of res) {
  if (!ok) bad += 1;
  console.log(`  ${ok ? '✅' : '❌'} ${n}${ex ? `　｜ ${ex}` : ''}`);
}
console.log(`结果：${res.length - bad}/${res.length}${bad ? '  ← 有失败' : ''}`);
process.exit(bad ? 1 : 0);

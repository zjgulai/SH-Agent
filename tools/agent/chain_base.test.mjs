#!/usr/bin/env node
/**
 * chain_base.test.mjs —— `--base` 必须到秒（同群并行的前置，2026-10-22）
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这条判据守的是哪场事故（还没发生，但已经结构上注定会发生）
 * ══════════════════════════════════════════════════════════════════════════
 * `review_run.sh` 开跑第一步是
 *     rerun_ledger.py --check-base "$BASE" --text-sha8 "$TEXT_SHA8"
 * 它的判据是「**同一个 BASE 已经跑过 ⇒ 硬拒**」（退出码 2）。
 * 而 `BASE` 由守衡给的模板 `date +%Y%m%d-%H%M` 生成 —— **分钟级**。
 *
 * 于是「同一分钟起两条链」（同群并行的常态；跨群两人同时发也会）⇒ 两单 BASE 同名 ⇒
 * 后一单被判「同一个 RUN 跑第二遍」⇒ 退出码 **2**。而守衡侧
 * `RETRYABLE_REFUSALS` 只认 `claim_busy / layer_gate_red / layer_audit_red / preflight_aborted`
 * ⇒ **退出码 2 不进补发队列，那单直接失败**。
 *
 * 改法：模板与 `review_run.sh` 的 usage 都到秒（`%H%M%S`）。
 * 为什么这不算破坏口径：`$BASE` 是自由字符串（`review_preflight.sh` 只校验非空；
 * `rerun_ledger._norm()` 只 `strip()` 不截断），报告名**本来就是秒级**
 * （`kb/l7/reports/20261022-101313.review.md`）—— 让两套东西对齐而已。
 *
 * ★ 判据分四块，缺一块就等于没修：
 *   ① 模板**必须**是秒级；② 旧格式**出现即红**（防止哪天被改回去）；
 *   ③ `review_run.sh` 的 usage 与模板**同格式**（两处漂了 = 照抄手册就撞）；
 *   ④ `_norm` **真的不截断**（否则改了也白改 —— 这条最容易想当然）。
 *
 * 跑法：`node tools/agent/chain_base.test.mjs`
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { reviewCmdTemplate, chainInFlight, describeChainInFlight } from './tools.mjs';

let pass = 0;
let fail = 0;
let skip = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name}\n       ${e?.message ?? e}`); }
};

const KB = process.env.SHOUHENG_KB_ROOT
  || '/Users/lute/Documents/skill-test/执行skills/执行skills/skills-回归测试/知识库/内容治理';
const REVIEW_RUN = path.join(KB, 'kb/l8/review_run.sh');

/**
 * 旧格式检测器（判据本体；下面 1c 会喂它坏样本，证明它真会红）。
 * ★ 注意 `(?!%S)` 而不是 `(?!S)`：格式串是 `%Y%m%d-%H%M%S`，
 *   `%H%M` 后面紧跟着的是 **`%`** 而不是 `S` —— 写成 `(?!S)` 会把秒级也判红（假阳性）。
 *   （第一版就是这么写错的，1c 当场把它咬出来了。）
 */
const hasLegacyMinutes = (text) => /%H%M(?!%S)/.test(text);

console.log('═══ 1. 模板：必须给到秒 ═══');

await t('1a 守衡侧命令模板里是 `%H%M%S`（不是 `%H%M`）', () => {
  const tpl = reviewCmdTemplate('/tmp/S8-PROBE-MATERIAL.txt');
  assert.ok(tpl.includes('$(date +%Y%m%d-%H%M%S)'),
    '模板里 --base 不是秒级 —— 同一分钟起两单会撞同一个 BASE，后一单直接失败');
});

await t('1b 反向对照：模板里**不许**剩下分钟级（`%H%M` 后面不跟 S）', () => {
  const tpl = reviewCmdTemplate('/tmp/S8-PROBE-MATERIAL.txt');
  assert.ok(!hasLegacyMinutes(tpl), '模板里还留着分钟级 --base —— 那就是撞车的形状');
});

await t('1c 检测器本身会红：喂一段旧格式样本必须判红，新格式必须判绿', () => {
  assert.strictEqual(hasLegacyMinutes('--base "$(date +%Y%m%d-%H%M)"'), true,
    '检测器把旧格式判成绿的 ⇒ 它拦不住任何东西（§2.4：名字出现过 ≠ 它拦得住）');
  assert.strictEqual(hasLegacyMinutes('--base "$(date +%Y%m%d-%H%M%S)"'), false,
    '检测器把新格式判成红的 ⇒ 假阳性，判据会被绕过');
});

console.log('═══ 2. 两处不漂（模板 / 脚本 usage）═══');

await t('2a `review_run.sh` 的 usage 也是秒级，且与模板同格式', () => {
  if (!fs.existsSync(REVIEW_RUN)) {
    skip++;
    console.log('       ⚠ 未测：本机没有知识库仓 —— 这一项「没跑」，不是「过了」');
    return;
  }
  const s = fs.readFileSync(REVIEW_RUN, 'utf8');
  const m = s.match(/--base "\$\(date ([^)]+)\)"/);
  assert.ok(m, 'review_run.sh 的 usage 里找不到 `--base "$(date …)"` 示例');
  assert.ok(m[1].endsWith('%H%M%S'), `usage 里的日期格式是 \`${m[1]}\`，不是秒级`);
  assert.ok(!hasLegacyMinutes(s.slice(0, 4000)),
    'review_run.sh 的 usage 里还留着分钟级示例 —— 照抄手册就会撞 BASE');
});

console.log('═══ 3. `_norm` 真的不截断（改了才不算白改）═══');

await t('3a 秒级 BASE 不会被归一化回分钟级（同一素材、两个 BASE ⇒ same_base=false）', () => {
  const ledger = path.join(KB, 'kb/l8/rerun_ledger.py');
  if (!fs.existsSync(ledger)) {
    skip++;
    console.log('       ⚠ 未测：知识库仓不在 —— 这一项「没跑」，不是「过了」');
    return;
  }
  const py = [
    'import sys, json',
    `sys.path.insert(0, ${JSON.stringify(path.join(KB, 'kb/l8'))})`,
    'import rerun_ledger as R',
    // 台账里已经跑过「同一分钟」的 20261022-1146；现在用同素材的秒级 BASE 再跑
    'rows = [{"base": "20261022-1146", "text_sha8": "76a5b466", "state": "REVIEW",',
    '         "at": "2026-10-22T11:46:47"}]',
    'r = R.check_base(rows, "20261022-114647", "76a5b466")',
    'print(json.dumps(r))',
  ].join('\n');
  const out = execFileSync('/usr/bin/python3', ['-c', py], { encoding: 'utf8' });
  const r = JSON.parse(out.trim().split('\n').pop());
  assert.strictEqual(r.same_base, false,
    `同一素材的秒级 BASE 被判成「同一个 BASE 已跑过」⇒ 秒级根本没生效（_norm 在截断？）：${out.trim()}`);
  assert.strictEqual(r.rerun_seq, 2, `重跑序号不对（${r.rerun_seq}）—— 秒级 BASE 也该被认成「第 2 次跑」`);
});

await t('3b 反向对照：同一个 BASE 仍然必须被硬拒（这条保护一个字没松）', () => {
  const ledger = path.join(KB, 'kb/l8/rerun_ledger.py');
  if (!fs.existsSync(ledger)) { skip++; console.log('       ⚠ 未测：知识库仓不在'); return; }
  const py = [
    'import sys, json',
    `sys.path.insert(0, ${JSON.stringify(path.join(KB, 'kb/l8'))})`,
    'import rerun_ledger as R',
    'rows = [{"base": "20261022-114647", "text_sha8": "76a5b466", "state": "REVIEW",',
    '         "at": "2026-10-22T11:46:47"}]',
    'print(json.dumps(R.check_base(rows, "20261022-114647", "76a5b466")))',
  ].join('\n');
  const out = execFileSync('/usr/bin/python3', ['-c', py], { encoding: 'utf8' });
  const r = JSON.parse(out.trim().split('\n').pop());
  assert.strictEqual(r.same_base, true,
    '同一个 BASE 没被判成「已跑过」—— 那条防双计的保护被改坏了');
});

console.log('═══ 4. 并发读数：有计数、且计数与真实 spawn 同源 ═══');

await t('4a 纯函数：`describeChainInFlight(n)` 说人话', () => {
  assert.strictEqual(describeChainInFlight(1), '同时在跑 1 条链');
  assert.strictEqual(describeChainInFlight(2), '同时在跑 2 条链');
});

await t('4b 刚加载时计数是 0（没有链在跑）', () => {
  assert.strictEqual(chainInFlight(), 0, `初始计数是 ${chainInFlight()}，说明有地方漏减`);
});

await t('4c 接线：只有一个 spawn 点，且 ++/-- 与它同源、-- 在 finally 里', () => {
  const src = fs.readFileSync(new URL('./tools.mjs', import.meta.url), 'utf8');
  const spawnBody = src.match(/async function spawnChain\(task\) \{([\s\S]*?)\n\}/);
  assert.ok(spawnBody, '找不到 `spawnChain()` —— 那这条读数就是个摆设');
  const body = spawnBody[1];
  assert.ok(/_chainsInFlight\+\+/.test(body), '`spawnChain` 里没有 ++ ⇒ 计数永远 0');
  assert.ok(/finally\s*\{[\s\S]*?_chainsInFlight--/.test(body),
    '`_chainsInFlight--` 不在 finally 里 ⇒ 超时/异常路径会漏减，计数只涨不落');
  assert.ok(/execFileP\('node', \[DSH_BIN/.test(body), '`spawnChain` 里没有真正的 execFile ⇒ 计数与 spawn 不同源');
  // 反向对照：除了 spawnChain 之外，不许再有第二处直接起链（两处起链 = 计数必漏）
  const direct = (src.match(/execFileP\('node', \[DSH_BIN/g) || []).length;
  assert.strictEqual(direct, 1, `有 ${direct} 处直接 \`execFileP('node', [DSH_BIN…])\` —— 必须只有 spawnChain 一处`);
});

console.log(`\n═══ 合计：通过 ${pass} / 失败 ${fail}${skip ? ` / 未测 ${skip}` : ''} ═══`);
process.exit(fail ? 1 : 0);

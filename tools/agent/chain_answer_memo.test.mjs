/**
 * chain_answer_memo.test.mjs —— 「闸门没判送审、模型自己调了链」那一支，卡面还回得去评审单形状吗？
 *
 * ## 它防的是什么（Owner 2026-10-19：「**守衡输出的卡片内容怎么又改了？赶紧改回去**」）
 *
 * 真单 `om_x100b6269bad188e8cf248ad8931a610`（「喇叭罩贴合乳房后通过吸吮形成负压，
 * 乳头罩可替换为软边款。」**27 字**）：
 *
 *   ① 27 字 < `review_gate.MIN_REVIEW_CHARS`(30) 且不含送审词 ⇒ **送审闸门判「不是送审」**
 *      （那天日志里这条消息**没有**「🧭 送审闸门」那一行）⇒ `g.verdict53 = null`；
 *   ② 模型**自己**调了链（`🔧 工具: kb_review_chain(271405ms)`），链跑成了，
 *      回执里**逐字带着**合 §5.3 的 PASS 行；
 *   ③ 而内核兜底只把 **P0 快路那半份**喂给 `deriveVerdictLine`。这一单 `p0_fastpath` **0 命中**
 *      ⇒ `p0Payload = null` ⇒ 只剩 `replyText` ⇒ 结论行变成「模型有没有照抄」的函数
 *      ⇒ 模型写的是「…**0 处阻断**。可转 @sign-off 责任人（未配置）过门。」⇒ `conforms()` 不过
 *      ⇒ `verdict53Final = null` ⇒ 信封层 `reviewShape=false`
 *      ⇒ **模型那张 `query-answer` 卡原样发出**，后台词（`covered=true/covered_by=rule`、
 *      `扫 509 条规则`）随之上卡。
 *
 * ## 判据分三层（少一层都留得住漏洞）
 *
 *   ① 纯函数 `chainAnswerPayloadOf`：什么该装（跑成的、有答案的）、什么**不许**装（`{error}`、空答案）；
 *   ② **反向对照**：拿这一单**逐字**的两段文本 —— 只喂 `replyText` ⇒ `null`；再喂链的 `answer`
 *      ⇒ `from='chain'` 且 `conforms().ok === true`。这就是「改的是取数，不是措辞」；
 *   ③ **轮边界**：`beginChainAnswerTurn()` 之后必须读不到上一单的回执
 *      （串轮的方向不对称：漏跑只是慢，**串轮是答错**）。
 *
 * 跑法：`node agent/chain_answer_memo.test.mjs`（`node:test`，与 `merged_record.test.mjs` 同一种）
 */
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';

import {
  chainAnswerPayloadOf, chainAnswerRead, beginChainAnswerTurn,
  _resetChainAnswerMemoForTest, _armChainAnswerMemoForTest,
} from './tools.mjs';
import { deriveVerdictLine, conforms } from './prd53.mjs';

/** 模型那一轮的**首行**（逐字取自真单，含它自己写的「0 处阻断」—— 这就是不合 §5.3 的原因）。 */
const MODEL_REPLY_HEAD = '**结论：PASS —— 未发现已知底线风险，0 处阻断。可转 @sign-off 责任人（未配置）过门。**\n'
  + '另有 **2 条 P3 建议**（不阻断，随 PASS 流转）—— 这两条值得看，因为它给的是**术语口径**，不是措辞口味。\n';

/** `kb_review_chain` 那一单的回执正文（逐字），`摘要：` 后面那一行合 §5.3.1。 */
const CHAIN_ANSWER = '本次按美国市场口径审查（PRD 第一阶段范围）。\n\n'
  + '**状态：PASS ｜ 问题数：2 ｜ 置信度：0.93**\n'
  + '摘要：【审查结论：PASS】未发现已知底线风险，可转交 @sign-off 责任人（未配置） 进行 sign-off。\n';

test('① 纯函数：只装「跑成的 ＋ 有答案的」', () => {
  // 正常回执（本单形状：**没有** p0_fastpath 也要装 —— 这正是要修的那一格）
  const p = chainAnswerPayloadOf({ ok: true, answer: CHAIN_ANSWER });
  assert.ok(p, '链跑成且有 answer ⇒ 必须装（这一单 p0_fastpath 是 0 命中、压根没有这个键）');
  assert.strictEqual(p.answer, CHAIN_ANSWER);
  assert.strictEqual(p.p0Fastpath, null, '没有 p0_fastpath ⇒ 这一格是 null，不是整条丢掉');

  // 有 p0_fastpath ⇒ 一起带上（P0 单不许因为走了通用回执就丢读数）
  const p2 = chainAnswerPayloadOf({ ok: true, answer: 'x', p0_fastpath: { matched_patterns: 2 } });
  assert.deepStrictEqual(p2.p0Fastpath, { matched_patterns: 2 });

  // 反向对照：跑挂的 / 空答案 / 非对象 一律不许装（§2.4.2 未测不许与通过长得一样）
  assert.strictEqual(chainAnswerPayloadOf({ ok: false, answer: CHAIN_ANSWER }), null, 'ok=false 不许装');
  assert.strictEqual(chainAnswerPayloadOf({ error: 'boom', answer: 'x' }), null, '{error} 不许装');
  assert.strictEqual(chainAnswerPayloadOf({ ok: true, answer: '   ' }), null,
    '空答案不许装壳 —— 空壳会让下游把「没有读数」当成「有读数」');
  assert.strictEqual(chainAnswerPayloadOf(null), null);
  assert.strictEqual(chainAnswerPayloadOf('string'), null);
});

test('② 反向对照（真单逐字）：只喂模型回复 ⇒ null；再喂链的 answer ⇒ from=chain 且合 §5.3', () => {
  // 改前：只有 replyText + reviewedByTool（本单就是这样走丢的）
  assert.strictEqual(
    deriveVerdictLine({ replyText: MODEL_REPLY_HEAD, reviewedByTool: true }), null,
    '模型自己写的那句「0 处阻断」不合 §5.3.1 ⇒ 只靠它必须回 null（这一单的现场）');

  // 改后：把链回执一起喂进去
  const memo = chainAnswerPayloadOf({ ok: true, answer: CHAIN_ANSWER });
  const v = deriveVerdictLine({ replyText: MODEL_REPLY_HEAD, reviewedByTool: true,
                                answer: memo.answer, p0Fastpath: memo.p0Fastpath });
  assert.ok(v, '喂了链的 answer 就必须派生出结论行 —— 否则卡面又会退回 query-answer 形状');
  assert.strictEqual(v.state, 'PASS');
  assert.strictEqual(v.from, 'chain', `取数必须标成来自链，实际：${v.from}`);
  assert.strictEqual(v.line, '【审查结论：PASS】未发现已知底线风险，可转交 @sign-off 责任人（未配置） 进行 sign-off。');
  assert.strictEqual(conforms(v.line).ok, true, `结论行必须逐字合 §5.3.1，实际：${JSON.stringify(conforms(v.line))}`);
  assert.strictEqual(v.block, null, 'PASS 是「一句话结论」，没有逐条块（§5.3.1）—— 不许硬塞空块');
});

test('③ 轮边界：上一单的回执不许漏到下一轮', () => {
  _armChainAnswerMemoForTest({ answer: CHAIN_ANSWER, p0Fastpath: null });
  assert.ok(chainAnswerRead(), '装过之后要读得到');

  beginChainAnswerTurn();
  assert.strictEqual(chainAnswerRead(), null,
    '一轮的边界必须清零 —— 漏跑只是慢，串轮是拿上一单的结论答这一单（方向不对称）');

  _resetChainAnswerMemoForTest();
  assert.strictEqual(chainAnswerRead(), null);
});

test('④ 接线：工具回执要装、每轮要清、兜底那一支要真的把它喂给 deriveVerdictLine', () => {
  // 本仓的老病（§2.4.1）：「判据写对了」不等于「调用方接上了」——
  //   2026-10-12 就踩过一次（`J13a3d`：批跑器里那个参数被删掉，判据全绿）。
  //   这里钉三处**源码级接线**，任何一处被拆掉 ⇒ 精确变红。
  const src = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
    .split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');

  const tools = src('./tools.mjs');
  assert.ok(/const ca = chainAnswerPayloadOf\(result\);[\s\S]{0,120}chainAnswerMemo = \{[\s\S]{0,60}payload: ca/.
    test(tools),
  '`executeTool` 必须把跑成的链回执装进 `chainAnswerMemo` —— 不装的话这一格永远是 null');

  const agent = src('./agent.mjs');
  assert.ok(/beginChainAnswerTurn\(\)/.test(agent),
    '每轮边界必须 `beginChainAnswerTurn()` —— 不清的话上一单的结论会答这一单');
  assert.ok(/answer: chainAnswer\?\.answer \?\? ''/.test(agent),
    '兜底那一支必须把链的 `answer` 喂给 `deriveVerdictLine` —— 少了这一句，'
    + '「闸门没判送审、模型自己调链」的单子依旧只能靠模型抄结论行（本单就是这么丢的）');

  // 反向对照：把那一句挖掉，同一条正则**必须**判红（证明它是判据、不是恒真）
  const mutated = agent.replace(/answer: chainAnswer\?\.answer \?\? ''/, '');
  assert.strictEqual(/answer: chainAnswer\?\.answer \?\? ''/.test(mutated), false,
    '反向对照：删掉接线后正则必须不命中 —— 否则这条断言什么也没守');
});

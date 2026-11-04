/**
 * reasoning_passback.test.mjs —— 思考模式 `reasoning_content` 回传（P0，2026-09-30 加）
 *
 * 为什么单独一个文件，而不是塞进 `test_agent.mjs` 的第 13 组：
 *   本仓已有按模块分文件的惯例（`retry_queue.test.mjs` / `kb_client.test.mjs` /
 *   `lark_write.test.mjs` / `llm_errors.test.mjs` / `secret_path.test.mjs`）。
 *   这条约束**只涉及 memory 与 agent 两个模块之间的接线**，独立成文件后
 *   既能单独跑，也不会和别的组互相污染临时目录。
 *
 * ── 被证的是什么 ──
 * DeepSeek 思考模式的协议（https://api-docs.deepseek.com/guides/thinking_mode）：
 *   「对于携带 `tools` 参数的请求，`reasoning_content` **必须全量回传**给 API ——
 *     包括没有发生工具调用的轮次。若代码没有正确回传，API 会返回 400。」
 * 守衡每轮都带 `tools`，所以这是**硬性**要求，不是可选优化。
 *
 * 盘上的原始读数（本机实测，`PMO/logs/llm_failures.jsonl`，19:09:41）：
 *   HTTP 400 code=invalid_request_error
 *   The `reasoning_content` in the thinking mode must be passed back to the API.
 *
 * ⚠️ **诚实边界：这条 400 的近因不是「没回传思维链」。** 2026-09-30 19:31 的
 *   A/B 实测（真模型 + 真知识库，只切 `SHOUHENG_REASONING_PASSBACK`）显示
 *   **关掉开关同样不报 400，两边都正常答出 1100+ 字**。近因是那条
 *   `{role:'assistant', content:''}` 的空轮 —— 它由第 11 组（写入闸 + 回放闸）负责。
 *   所以本组证的是**协议合规**（照文档补齐一个必填字段），
 *   不是「修好了 400」。这两件事不要互相冒充。
 *
 * ── 与第 11 组的分工（两件事，不要互相冒充）──
 *   第 11 组管**写入侧**：空的 assistant 轮不许落进记忆。
 *   本组管**回放侧**：非空（尤其带 tool_calls）的 assistant 轮，
 *   它那一轮的思维链必须跟着一起发回去。
 *   只修写入侧不够 —— 历史里已经躺着的、以及每一轮正常的工具调用轮，
 *   都还要**回传**才不违反协议。
 */

import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

let pass = 0;
let fail = 0;
const ok = (n) => { pass++; console.log(`  ✅ ${n}`); };
const bad = (n, why) => { fail++; console.log(`  ❌ ${n}\n       ${why}`); };
const t = async (name, fn) => {
  try { await fn(); ok(name); } catch (e) { bad(name, e.message); }
};

console.log('\n═══ P0：思考模式 reasoning_content 必须回传（2026-09-30）═══');

const mem = await import('./memory.mjs');
const agent = await import('./agent.mjs');
const { config } = await import('./config.mjs');

// ─────────────────────────────────────────────────────────────────────────────
// 1) 接线断言 —— 必须在**真正被守衡使用的那条路**（`toLlmMessages`）出口上验。
//
//    这一条是照抄第 11 组那次教训写的：当时断言调的是纯函数 `sanitizeForLlm()`，
//    而守衡实际走 `toLlmMessages()` —— 把 `return sanitizeForLlm(out)` 改回
//    `return out`，纯函数那几条照样全绿，而每一轮请求都会带着坏记录去换一个 400。
//    **函数写对了，但没人断言它被接上。**（AGENTS.md §2.4）
// ─────────────────────────────────────────────────────────────────────────────
await t('toLlmMessages 出口必须带上 reasoning_content（接线，不是纯函数）', async () => {
  const sess = {
    key: 'k', summary: '', messageCount: 3,
    messages: [
      { at: 'a', role: 'user', content: '用知识库查一下「吸奶器」相关的措辞要求' },
      { at: 'b', role: 'assistant', content: '', reasoning_content: '先查措辞表达库，再看内部正负样本库。',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'kb_search', arguments: '{}' } }] },
      { at: 'c', role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' },
    ],
  };
  const out = mem.toLlmMessages(sess, 'S');
  const withCalls = out.find((m) => m.tool_calls?.length);
  assert.ok(withCalls, '带 tool_calls 的 assistant 轮应被保留');
  assert.strictEqual(withCalls.reasoning_content, '先查措辞表达库，再看内部正负样本库。',
    '那一轮的 reasoning_content 必须跟着发回去 —— 不回传就是 400');
});

await t('没有 reasoning_content 时**不许凭空造**这个字段', async () => {
  const sess = {
    key: 'k', summary: '', messageCount: 1,
    messages: [{ at: 'a', role: 'assistant', content: '结论：不能单独写「吸奶器」。' }],
  };
  const out = mem.toLlmMessages(sess, 'S');
  const a = out.find((m) => m.role === 'assistant');
  assert.strictEqual(a.reasoning_content, undefined,
    '上游没给就不要加 —— 凭空补一个空字段是伪造，也会让「有没有真回传」变得看不出来');
  assert.ok(!('reasoning_content' in a), '不许留下值为 undefined 的键');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2) 裁剪 —— 回传是有代价的：思维链会被拼进上下文，而本次事故的根因正是上下文被塞爆。
//    所以上限必须存在，且**截了要说**。
// ─────────────────────────────────────────────────────────────────────────────
await t('超限的思维链必须被裁到上限，并留下可核对的标记', async () => {
  const cap = config.llm.reasoningPassback.maxChars;
  const long = '推'.repeat(cap + 5000);
  const out = agent.reasoningToPassBack({ reasoning_content: long });

  assert.strictEqual(typeof out.reasoning_content, 'string', '应返回一个字符串');
  assert.ok(out.reasoning_content.length < long.length,
    `必须真的变短：原 ${long.length} 字，返回 ${out.reasoning_content.length} 字`);
  assert.ok(out.reasoning_content.length <= cap + 200,
    `裁剪后应贴近上限 ${cap}，实际 ${out.reasoning_content.length}`);
  assert.ok(/裁剪后回传/.test(out.reasoning_content),
    '裁了必须留痕（原长 + 上限）—— 静默截断会让事后没人能判断上下文里到底放了什么');
  assert.ok(out.reasoning_content.includes(String(long.length)),
    '标记里要写得出**原长**，否则无法复算');
});

await t('未超限的思维链必须**原样**返回，不许顺手改一个字', async () => {
  const s = '短的思维链：先看 W-2.8，再对照 H01。';
  const out = agent.reasoningToPassBack({ reasoning_content: s });
  assert.strictEqual(out.reasoning_content, s, '未超限就该逐字一致');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3) 反面与空值 —— 这一跳不许把「没有」变成「有」，也不许自己抛。
// ─────────────────────────────────────────────────────────────────────────────
await t('缺少 / 非字符串 / 空的 reasoning_content 一律返回空对象', async () => {
  for (const m of [undefined, null, {}, { reasoning_content: '' },
                   { reasoning_content: 123 }, { reasoning_content: null }]) {
    assert.deepStrictEqual(agent.reasoningToPassBack(m), {},
      `输入 ${JSON.stringify(m)} 应返回 {}（无字段可加），实际不是`);
  }
  assert.deepStrictEqual(agent.reasoningToPassBack(), {}, '不传参也必须安全返回 {}');
});

// ─────────────────────────────────────────────────────────────────────────────
// 4) 开关 —— `SHOUHENG_REASONING_PASSBACK=0` 必须真的关掉（用于 A/B 对照实测）。
//    必须在**子进程**里验：`config` 是 import 期求值的常量，
//    同一个进程里改 env 不会生效 —— 在进程内测会得到一个假的绿灯。
// ─────────────────────────────────────────────────────────────────────────────
await t('SHOUHENG_REASONING_PASSBACK=0 必须整块关掉（子进程验，真 env）', async () => {
  const probe = `
    const a = await import('./agent.mjs');
    const { config } = await import('./config.mjs');
    const r = a.reasoningToPassBack({ reasoning_content: '有内容' });
    console.log(JSON.stringify({ enabled: config.llm.reasoningPassback.enabled, keys: Object.keys(r) }));
  `;
  const run = (env) => JSON.parse(execFileSync(process.execPath,
    ['--input-type=module', '-e', probe],
    { cwd: HERE, env: { ...process.env, ...env }, encoding: 'utf8' }).trim().split('\n').pop());

  const on = run({ SHOUHENG_REASONING_PASSBACK: '1' });
  assert.strictEqual(on.enabled, true, '明确设 1 时必须是开');
  assert.deepStrictEqual(on.keys, ['reasoning_content'], '开着时必须带上字段');

  const off = run({ SHOUHENG_REASONING_PASSBACK: '0' });
  assert.strictEqual(off.enabled, false, '设 0 时必须是关');
  assert.deepStrictEqual(off.keys, [], '关掉时必须一个字段都不带');
});

await t('默认（不设 env）是**开**——协议要求，不该靠人去记着打开', async () => {
  const env = { ...process.env };
  delete env.SHOUHENG_REASONING_PASSBACK;
  const out = JSON.parse(execFileSync(process.execPath,
    ['--input-type=module', '-e',
      `const { config } = await import('./config.mjs'); console.log(JSON.stringify(config.llm.reasoningPassback));`],
    { cwd: HERE, env, encoding: 'utf8' }).trim().split('\n').pop());
  assert.strictEqual(out.enabled, true, '不设 env 时默认必须是开');
});

// ─────────────────────────────────────────────────────────────────────────────
// 5) 上限本身也要有下限约束 —— 防止有人把它配成 0 或负数，
//    那会让每一轮都回传一个空的 reasoning_content（比不回传更坏：违反协议还占位）。
// ─────────────────────────────────────────────────────────────────────────────
await t('maxChars 必须是一个正数上限', async () => {
  const c = config.llm.reasoningPassback.maxChars;
  assert.ok(Number.isFinite(c) && c > 0, `maxChars 应为正数，实际 ${c}`);
  assert.ok(c >= 1000, `maxChars=${c} 太小：一轮正常思维链会被裁得没有意义`);
});

console.log(`\n═══ 合计：通过 ${pass} / 失败 ${fail} ═══`);
process.exit(fail > 0 ? 1 : 0);

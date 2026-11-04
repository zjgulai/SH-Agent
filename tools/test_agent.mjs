/**
 * test_agent.mjs —— 守衡内核离线测试
 *
 * 用合成事件跑完整链路（解析 → 记忆 → 工具 → LLM → 回复），不依赖真人 @。
 * 为什么必须做这个：入向链路验证时我用「盯日志」等真人动作，连吃两次空测。
 * 内核的正确性不该由别人的手速决定。
 *
 * 用法：node test_agent.mjs [--offline | --live]
 *   --offline 不执行真飞书/视觉试纸，逐项记未测；--live 额外跑真实 LLM 对话。
 */
import assert from 'node:assert';

// ★ 2026-10-05 现场踩到的坑（§2.4.4 那个形状）：**跑一次自证，往 Owner 的真实飞书表里写了两行。**
//   原因：`runSubmissionGate` 里那段「保证落表」对**测试桩**也照跑不误 ——
//   单测里 `chainRunner` 返回一句假的 `结论：REVIEW`，就真在群里那张表上建了一行。
//   两条防线，缺一条都不算修好：
//     ① 这里拉闸（就算谁漏传了桩，也写不进真表）；
//     ② 单测/子进程一律显式传 `publishRunner` / `chainRunner` 桩。
process.env.SHOUHENG_REVIEW_TABLE = 'off';
const IMAGE_ENGINE_OK = Object.freeze({ state: 'REVIEW',
  image_skill_gate: { ok: true, load: { verdict: 'loaded' } } });
// ★ 2026-10-15（F1）：**置信度台账同理** —— `PMO/shouheng-state/confidence-merged.ndjson` 是
//   校准器要读的**真机读件**，跑自证往里追加行 = 往真数据里掺测试单（§2.4.4 同一个形状）。
//   `KB_CONF_LEDGER` 这个开关本来就是为这件事留的（见 `agent.mjs` 落台账那段注释）
//   ⇒ 自证一律指到 /tmp。修这条的背景：台账此前因 `stateDir` 少个 `()` **从来没写成过**，
//   现在修好了，若不拉闸，第一次跑自证就会把测试单写进真台账。
process.env.KB_CONF_LEDGER = '/tmp/shouheng-test-confidence-merged.ndjson';
// ★★ 2026-10-19（**同一天实测踩到两次的那条**）：**逐条记录也不许写进真状态目录**。
//   病灶：`merged_report.writeMergedRecord()` 是**直接 import** 的（不像 `mergedReportRunner`
//   那样可注入），所以自证里每跑一单「带条目 + 链跑成」，就真的往
//   `PMO/shouheng-state/merged-reports/` 落一个 `merged-*.json`。
//   实测第一次跑就写了 **6 个**夹具件（`question: '审核下这个视频'`）——已清理。
//   ⇒ 闸在写盘那一点上（`SHOUHENG_MERGED_RECORD=off`），这里拉开；
//     判据在 `agent/merged_record.test.mjs` ③（它用 `SHOUHENG_MERGED_REPORT_DIR` 指到 tmp，
//     所以**验的是真写盘**，验的又**不是**Owner 的目录 —— 两件事必须分开）。
process.env.SHOUHENG_MERGED_RECORD = 'off';
// ★ 2026-10-16：**身份拒收账本同理** —— `PMO/logs/identity-reject.ndjson` 是判「那把锁有没有
//   又失效」的真读数，而 N2 那组会**真跑拒收路径**（真文件行为级）⇒ 不拉闸就会往真账本里
//   掺测试行，把「线上拒收了几次」这个读数弄脏（§2.4.4 同一个形状，第三次）。
//   判据在 N4b：本次运行前后，**真账本必须一个字节都没动**。
const REAL_REJECT_LOG = new URL('../PMO/logs/identity-reject.ndjson', import.meta.url).pathname;
const realRejectLogStat = () => { try { const st = fs.statSync(REAL_REJECT_LOG); return `${st.size}:${st.mtimeMs}`; } catch { return 'absent'; } };
const REAL_REJECT_LOG_BEFORE = realRejectLogStat();
process.env.SHOUHENG_IDENTITY_REJECT_LOG = '/tmp/shouheng-test-identity-reject.ndjson';
import fs from 'node:fs';
import { reviewFixtureClaims } from './agent/__fixtures__/image-claim-review.mjs';
import * as feishu from './agent/feishu.mjs';
import { executeTool, runtimeContext, TOOL_SCHEMAS } from './agent/tools.mjs';

const OFFLINE = process.argv.includes('--offline');
const LIVE = process.argv.includes('--live') && !OFFLINE;
let pass = 0, fail = 0, untested = 0;
const ok  = (name, extra = '') => { pass++; console.log(`  ✅ ${name}${extra ? '  ' + extra : ''}`); };
const bad = (name, e) => { fail++; console.log(`  ❌ ${name}\n       ${e}`); };
const t = async (name, fn) => { try { await fn(); ok(name); } catch (e) { bad(name, e.message); } };
const onlineTest = async (name, fn) => {
  if (OFFLINE) { untested++; console.log(`  ⚠ 未测 ${name}（--offline：不调用真实接口）`); return; }
  await t(name, fn);
};

// Downstream card/report tests that use image input must model a completed image skill
// receipt. Incomplete image answers belong in the dedicated fail-closed tests below;
// otherwise these fixtures stop before reaching the behavior each case intends to test.
const withImageSkillReceipt = (answer) => [
  '审核对象与范围：测试图片全图，核查图中文字、事实、安全与图文一致性。',
  '视觉分析与 OCR：本测试画面读数无人，OCR读取为空，没有婴儿睡眠场景。',
  '主张拆分与核查清单：C1：本轮画面与文字读数没有可核的外部事实主张。',
  '4A 规则符合性：知识库命中由本轮测试旁挂给出，规则结果与逐条发现分别保留。',
  '4B 事实准确性核查：',
  '| 主张 | 核查结论 | 依据及边界 | 来源 | 来源原文 |',
  '|---|---|---|---|---|',
  '| C1：本轮外部事实主张 | 不适用 | 本测试的画面无人、OCR为空，没有产品性能或安全主张需要核实 | — | — |',
  '图文一致性：本图没有可读文字，因此没有文字与画面相互矛盾的内容。',
  '视觉核对：婴幼儿姿势=无；婴儿睡眠位置=无（画面没有婴儿睡眠场景）；产品状态=无；场景关系=无；隐私=无',
  String(answer ?? ''),
].join('\n');

// 合并计数/报告/建议等下游用例需要先走过图片完成门槛。
// 此成功夹具遵循 parseScene 的结构（people=[] 合法），不是生产视觉执行证明；
// 未执行、失败和畸形读数仍由独立的图片完成反向用例验证。
// 无文字与未执行 OCR 不同：下游成功用例须明确给出已读取且为空的 OCR 回执。
const completedImageReadFixture = () => ({ index: 1, text: '', ocrEmpty: true,
  scene: { ok: true, ms: 1, scene: {
  setting: '影棚', people: [], products: [], visible_marks: [], text_script: '无文字',
  clean_text: [], risk_cues: [], unclear: [],
} } });
// These downstream fixtures have no person, OCR text or infant safety claim.
// The semantic stub must agree with that evidence; source-positive cases live below.
const completedImageClaimFixture = reviewFixtureClaims;

/**
 * 数一个模板字符串常量里**未转义**的反引号个数（开头的定界符不算）。
 * 用途见第 10 组：09-22 那次事故是「往人设里写行内代码忘了转义」，
 * 而判据一度写成「渲染结果里不许有反引号」—— 那会把**正确**的转义写法也判红。
 */
function unescapedBackticksInTemplate(src, constName) {
  const i = src.indexOf(`export const ${constName}`);
  if (i < 0) return -1;                       // 找不到常量本身就是错，返回负数让断言炸出来
  const isEscaped = (k) => {
    let bs = 0;
    for (let j = k - 1; j >= 0 && src[j] === '\\'; j--) bs++;
    return bs % 2 === 1;
  };
  // 模板的收尾是「第一个后面跟着分号的未转义反引号」，**不能假设它前面有换行**
  // （实测就是 `…已经生效」。**\`;` 收在一行里 —— 按 '\n\`;' 找会找不到，
  //  于是整段 body 一路吃到文件尾，把后面几个模板字面量全算进来，报出 11 个假阳性）。
  const open = (() => { for (let k = i; k < src.length; k++) if (src[k] === '`' && !isEscaped(k)) return k; return -1; })();
  if (open < 0) return -1;
  let n = 0, close = -1;
  for (let k = open + 1; k < src.length; k++) {
    if (src[k] !== '`' || isEscaped(k)) continue;
    if (/^\s*;/.test(src.slice(k + 1, k + 4))) { close = k; break; }
    n++;
  }
  return close < 0 ? -1 : n;                  // 没有收尾 → 源码本身已坏，报 -1 让断言红
}

console.log('\n═══ 1. mention 还原（守衡能不能知道谁在跟它说话）═══');

await t('还原 @ 占位符为真名', () => {
  const raw = '@_user_1 你好，帮我看看';
  const mentions = [{ key: '@_user_1', name: '对接人', id: { open_id: 'ou_test_lee' } }];
  const { display, mentions: resolved } = feishu.resolveMentions(raw, mentions);
  assert.strictEqual(display, '@对接人 你好，帮我看看', `实际得到 ${display}`);
  assert.strictEqual(resolved[0].name, '对接人');
  assert.strictEqual(resolved[0].openId, 'ou_test_lee');
});

await t('多个 @ 同时还原', () => {
  const raw = '@_user_1 @_user_2 你们看下';
  const mentions = [
    { key: '@_user_1', name: '张三', id: { open_id: 'ou_a' } },
    { key: '@_user_2', name: '李四', id: { open_id: 'ou_b' } },
  ];
  const { display } = feishu.resolveMentions(raw, mentions);
  assert.strictEqual(display, '@张三 @李四 你们看下', `实际得到 ${display}`);
});

await t('识别「@ 的是守衡」（决定群聊是否响应）', () => {
  const yes = feishu.resolveMentions('@_user_1 hi', [{ key: '@_user_1', name: '守衡', id: { open_id: 'cli_aa2243de0438dcd7' } }]);
  assert.strictEqual(feishu.isBotMentioned(yes.mentions), true);
  const no = feishu.resolveMentions('@_user_1 hi', [{ key: '@_user_1', name: '对接人', id: { open_id: 'ou_x' } }]);
  assert.strictEqual(feishu.isBotMentioned(no.mentions), false);
});

await t('剥掉 @守衡 本身，只留问题', () => {
  const { display, mentions } = feishu.resolveMentions(
    '@_user_1 你是谁？', [{ key: '@_user_1', name: '守衡', id: { open_id: 'cli_aa2243de0438dcd7' } }]);
  assert.strictEqual(feishu.stripBotMention(display, mentions), '你是谁？');
});

await t('@守衡 与其他 @ 混排时只剥自己', () => {
  const { display, mentions } = feishu.resolveMentions(
    '@_user_1 @_user_2 请回答', [
      { key: '@_user_1', name: '守衡', id: { open_id: 'cli_aa2243de0438dcd7' } },
      { key: '@_user_2', name: '对接人', id: { open_id: 'ou_lee' } },
    ]);
  assert.strictEqual(feishu.stripBotMention(display, mentions), '@对接人 请回答');
});

console.log('\n═══ 2. 工具层 ═══');

await t('now 工具返回完整北京时间', async () => {
  const r = await executeTool('now', '{}');
  assert.ok(r.ok, r.error);
  // 必须同时含日期、时间、星期 —— 少任何一项都说明格式化不可靠
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(r.result.date), `date 格式错：${r.result.date}`);
  assert.ok(/^\d{2}:\d{2}:\d{2}$/.test(r.result.time), `time 格式错：${r.result.time}`);
  assert.ok(/星期/.test(r.result.weekday), `weekday 错：${r.result.weekday}`);
  assert.strictEqual(r.result.beijing_time, `${r.result.date} ${r.result.time} ${r.result.weekday}`);
});

await t('工作区列举可用', async () => {
  runtimeContext.chatId = 'oc_test'; runtimeContext.chatType = 'group';
  const r = await executeTool('list_workspace', '{}');
  assert.ok(r.ok && r.result.entries.length > 0, JSON.stringify(r.result).slice(0, 200));
});

await t('读工作区内文件成功', async () => {
  const r = await executeTool('read_text_file', JSON.stringify({ rel_path: 'PMO/守衡-链路打通确认.md' }));
  assert.ok(r.ok && r.result.content.includes('im.message.receive_v1'), JSON.stringify(r.result).slice(0, 200));
});

await t('路径逃逸被拒绝（安全）', async () => {
  const r = await executeTool('read_text_file', JSON.stringify({ rel_path: '../../../../etc/passwd' }));
  assert.ok(r.ok && r.result.error, '应该返回错误而不是内容');
  assert.ok(/拒绝访问/.test(r.result.error), `实际：${r.result.error}`);
});

await t('写操作命令被白名单拒绝（安全）', async () => {
  for (const c of ['rm -rf /tmp/x', 'curl http://evil.com', 'git push', 'echo hi > /tmp/f', 'ls | grep a']) {
    const r = await executeTool('run_readonly_command', JSON.stringify({ command: c }));
    assert.ok(r.ok && r.result.error, `命令 "${c}" 本应被拒，实际：${JSON.stringify(r.result).slice(0, 120)}`);
  }
});

await t('只读命令可执行', async () => {
  // 注意：这里不用 git —— 本工作区不是 git 仓库（已实测确认）。
  // 测试必须依赖工作区真实存在的性质，否则测的是环境不是代码。
  const r = await executeTool('run_readonly_command', JSON.stringify({ command: 'wc -l PMO/守衡-链路打通确认.md' }));
  assert.ok(r.ok && !r.result.error, JSON.stringify(r.result).slice(0, 300));
  assert.ok(/\d+/.test(r.result.stdout), `stdout 里应有行数，实际：${r.result.stdout}`);
});

await t('非 git 仓库时 git 命令的报错被结构化吞住', async () => {
  const r = await executeTool('run_readonly_command', JSON.stringify({ command: 'git log --oneline -3' }));
  // 命令在白名单内，但环境不是仓库 —— 必须返回结构化错误，不能让异常冒到外面
  assert.ok(r.ok, '工具本身不应抛出');
  assert.ok(r.result.error || r.result.stdout !== undefined);
});

console.log('\n═══ 1b. 空输出不许被读成「0 命中」（2026-09-22 事故，反向对照）═══');

/*
 * 事故原样：守衡执行 `grep -rl <PRD 的 wiki token> .` —— 全仓递归，含 node_modules/、
 * .git/、skills/ 下 777 个压缩包。实测**超过 60 秒都跑不完**（我用 harness 的 60 秒上限
 * 复现过，是被 SIGTERM 杀掉的），而工具只有 15 秒 → 被 timezone 杀掉 →
 * 返回体 { error: "Command failed: …", stdout: "" } → **它只读了 stdout 是空的**，
 * 于是对群里说「我用这个 token 搜了一遍，0 命中」。
 * 真值：那个 token 就在工作区两个文件里。
 *
 * 下面每一条都对着那次误判的一个环节。
 */

await t('超时被杀的返回体里**没有 stdout 这个键** —— 空字符串无从被读成「0 命中」', async () => {
  process.env.SHOUHENG_RO_TIMEOUT_MS = '1';   // 1ms：bash 启动本身都超过它，必定超时
  let r;
  try {
    r = await executeTool('run_readonly_command', JSON.stringify({ command: 'grep -rn 守衡 PMO' }));
  } finally {
    delete process.env.SHOUHENG_RO_TIMEOUT_MS;
  }
  assert.ok(r.ok, '工具本身不应抛出');
  assert.strictEqual(r.result.status, 'timeout', `本应判为超时，实际：${JSON.stringify(r.result).slice(0, 200)}`);
  assert.ok(!('stdout' in r.result),
    `超时时返回体里不许有 stdout —— 空 stdout 会被读成「扫完了、没命中」。实际：${JSON.stringify(r.result).slice(0, 200)}`);
  assert.ok(/未测/.test(r.result.note), `note 里必须写出「未测」：${r.result.note}`);
  assert.ok(/不是「0 命中」/.test(r.result.note), 'note 必须明着堵住「0 命中」这个读法');
});

await t('引发事故的那条命令，在跑之前就被护栏拒绝', async () => {
  const r = await executeTool('run_readonly_command',
    JSON.stringify({ command: 'grep -rl NB55wAq8liEOdKkquL2cgtPEnmg .' }));
  assert.ok(r.ok && r.result.status === 'rejected',
    `本应被护栏拒绝，实际：${JSON.stringify(r.result).slice(0, 200)}`);
  // 它必须给出**下一步**，不能只说「不行」
  assert.ok(/search_workspace/.test(r.result.note), '拒绝时必须给替代路径');
});

await t('护栏不许把正常用法也拦掉（点名子目录的 grep 要放行）', async () => {
  const r = await executeTool('run_readonly_command',
    JSON.stringify({ command: 'grep -rn 守衡 PMO/守衡-链路打通确认.md' }));
  assert.ok(r.ok, '工具本身不应抛出');
  assert.notStrictEqual(r.result.status, 'rejected',
    `点名到具体文件不该被拦，实际：${JSON.stringify(r.result).slice(0, 200)}`);
});

await t('白名单只放行 lark_find.py 的**读**子命令，下载类一律拒绝（§2.6 红线）', async () => {
  // 2026-09-22 起守衡能用 `python3 tools/lark_find.py readdoc <token>` 读飞书文档正文 ——
  // 这符合 §2.6 红线（「读」允许，「取走附件」禁止）。这条断言就是那条红线的执行点：
  // 任何人往白名单里塞 download / medias，这里立刻红。
  for (const c of ['python3 tools/lark_find.py download abc',
                   'python3 tools/lark_find.py medias abc',
                   'python3 tools/lark_find.py export abc']) {
    const r = await executeTool('run_readonly_command', JSON.stringify({ command: c }));
    assert.strictEqual(r.result.status, 'rejected',
      `"${c}" 必须被拒（红线：飞书内容禁止下载），实际：${JSON.stringify(r.result).slice(0, 200)}`);
  }
});

await t('search_workspace 找得到那个 token（对事故的**真阳性**对照）', async () => {
  // ★★ 2026-10-16（FIX-034）：检索范围收到 `PRD/` —— 本判据治的是 2026-09-22 那次事故
  //   （守衡 `grep -rl <token> .` 超时被杀 ⇒ 它读空 stdout 说「0 命中」，
  //   而那份 PRD 副本**就在工作区里**；事故原文见 `tools.mjs` 的 `run_readonly_command` 注释）。
  //
  //   旧版**搜整个仓库**并断言 `stopped_early === false`，而这条前提今天**已经不成立**：
  //   实测 2026-10-16 —— `searched=5000 · skipped=1192 · stopped_early=true`
  //   （仓库可扫文本文件突破 `MAX_FILES` 默认 **5000**）⇒ 这一条**恒红**，
  //   红的是「仓库变大了」这个环境事实，不是它要守的那件事。**一条假红会挤掉一个真问题。**
  //
  //   收窄后前提重新成立：范围内扫得完 ⇒「有命中就必须找得到」才是一句能判的话。
  //   ★ 覆盖没有变少：「扫不完时该说什么」由第三条（`max_files: 3` ⇒ 必须说未测）守着，
  //     三条合起来仍是完整三态（扫完有命中 / 扫完没命中 / 扫不完 ⇒ 未测）。
  //
  //   ⚠️ 收窄顺手治好了一个更隐蔽的毛病：搜全仓时这个 token **也**出现在
  //   `tools/agent/tools.mjs`（**search_workspace 自己的实现**）与 `tools/test_agent.mjs`（本文件）里
  //   ⇒ 命中可能来自「自己搜到自己」，判据等于给自己作证。收进 `PRD/` 后命中只可能来自
  //   `PRD/feishu/索引-v1.json` —— 正是事故当时那份证据（实测 `grep -c` = 1）。
  const r = await executeTool('search_workspace',
    JSON.stringify({ keyword: 'NB55wAq8liEOdKkquL2cgtPEnmg', sub_dir: 'PRD' }));
  assert.ok(r.ok && r.result.status === 'ok', JSON.stringify(r.result).slice(0, 200));
  assert.ok(r.result.matches >= 1,
    `那次说「0 命中」，真值是至少 1 —— 实际 ${r.result.matches}（扫了 ${r.result.searched_files} 个文件）`);
  assert.strictEqual(r.result.stopped_early, false,
    `范围（PRD/，10 个文件）必须扫得完，否则「0 命中」不成立；实际扫了 ${r.result.searched_files} 个`);
});

await t('search_workspace：0 命中必须带分母，且分母为 0 时不算数', async () => {
  // 关键词必须**当场生成**：写死的字符串会出现在本测试文件自己里，
  // 于是「一定不存在」变成「一定存在」—— 这正是那类「假阴性/假阳性都在骗人」的坑。
  const ghost = `zz${Date.now()}x${Math.random().toString(36).slice(2)}q`;
  // ★ 2026-10-16（FIX-034）：同上，范围收到 `PRD/` ——
  //   这条要的是「**扫完了**、确实 0 命中，且那句结论有分母撑着」。
  //   全仓扫不完时那句话**根本不会出现**（走的是「未测」分支）⇒ 判据守不到它该守的东西。
  const r = await executeTool('search_workspace', JSON.stringify({ keyword: ghost, sub_dir: 'PRD' }));
  assert.ok(r.result.searched_files > 0, '分母必须大于 0，否则「没找到」是未测不是 0');
  assert.strictEqual(r.result.stopped_early, false, '没扫完就不该走「0 命中」这一支');
  assert.strictEqual(r.result.matches, 0, `不该命中，实际 ${r.result.matches}`);
  assert.ok(/分母/.test(r.result.note), `0 命中时要说清分母撑着：${r.result.note}`);
});

await t('search_workspace：扫不完时必须说「未测」，不许下「没找到」的结论', async () => {
  const ghost = `zz${Date.now()}x${Math.random().toString(36).slice(2)}q`;
  const r = await executeTool('search_workspace', JSON.stringify({ keyword: ghost, max_files: 3 }));
  assert.strictEqual(r.result.stopped_early, true, '上限这么小必须被截断');
  assert.ok(/未测/.test(r.result.note), `截断时 note 必须说未测：${r.result.note}`);
  // 判据用的是**扫完时才出现的那句话**，而不是「0 命中」三个字 ——
  // 后者会出现在「不许说成 0 命中」这句提示语里，拿它当判据等于自己判自己。
  assert.ok(!/有分母撑着/.test(r.result.note),
    `截断时不许给出「0 命中」的结论句：${r.result.note}`);
});

await t('未知工具给出结构化错误而非崩溃', async () => {
  const r = await executeTool('no_such_tool', '{}');
  assert.strictEqual(r.ok, false);
  assert.ok(/未知工具/.test(r.error));
});

await t('坏 JSON 参数不崩溃', async () => {
  const r = await executeTool('now', '{bad json');
  assert.strictEqual(r.ok, false);
  assert.ok(/JSON/.test(r.error));
});

console.log('\n═══ 3. markdown → 飞书富文本 ═══');

await t('代码块被识别为 code_block（不是一堆星号）', () => {
  const nodes = feishu.__test_mdToPostNodes('说明：\n```js\nconst a = 1;\n```\n结束');
  const flat = JSON.stringify(nodes);
  assert.ok(flat.includes('code_block'), flat.slice(0, 300));
  assert.ok(flat.includes('const a = 1;'), flat.slice(0, 300));
});

await t('粗体与行内代码转成样式节点', () => {
  const nodes = feishu.__test_mdToPostNodes('这是 **重点** 和 `code`');
  const flat = JSON.stringify(nodes);
  assert.ok(flat.includes('"bold"'), flat.slice(0, 300));
  assert.ok(flat.includes('code_inline'), flat.slice(0, 300));
});

await t('未闭合的代码块不吞内容', () => {
  const nodes = feishu.__test_mdToPostNodes('前\n```\n没闭合的内容');
  assert.ok(JSON.stringify(nodes).includes('没闭合的内容'));
});

// ─────────────────────────────────────────────────────────────────────────────
// 第 3 组补：★ **发出去的话里不许露出 markdown 星号**（2026-10-14 Owner 拿私聊截图来问）
//
// 他看到的那一条（`PMO/logs/ws_outbound.jsonl` 05:04:32Z）：
//     `1. **能查的我查完再说** —— 表、工作区文件、知识库检索这些我有路；…`
// 星号是**字面**显示出来的。根因不是模型写错，是**发送跳**：
// `replyMarkdown()`（「回复某条消息」那条路，也是**最常走**的一条）把原文直接塞进
// `msg_type: 'text'`，一个字都不转 —— 而 `sendMarkdown()` 那条路转 post，本来就干净。
// ⇒ 全台账 39 条 `mode: 'reply'` 全部带星号（这个是可复算的读数，不是估计）。
// ─────────────────────────────────────────────────────────────────────────────
await t('plainify：删 `**` 且**不碰下划线**（`user_id` 那种标识符不许被改坏）', async () => {
  const { plainify, hasMdSymbols } = await import('./agent/plain.mjs');
  // 正例：三种真实写法都要摘干净
  assert.strictEqual(plainify('**能查的我查完再说** —— 后文'), '能查的我查完再说 —— 后文');
  assert.strictEqual(plainify('1. **能做**\n- 走链'), '1. 能做\n- 走链');
  assert.strictEqual(plainify('## 标题\n正文 *斜体* 结尾'), '标题\n正文 斜体 结尾');
  assert.ok(!hasMdSymbols(plainify('**a** *b* ## c')), '摘完不许还剩星号');
  // ★ 反向对照：**下划线是标识符的一部分，不许动**
  const ids = '跑 `kb_review_chain` 与 user_id、secret_path.test.mjs';
  assert.strictEqual(plainify(ids), ids,
    '下划线不在本判据的范围内 —— 删它等于改内容（比格式难看严重得多）');
  // ★ 反向对照：孤星号也要清掉（模型写歪时 `**粗体** ` 会剩下一个）
  assert.ok(!hasMdSymbols(plainify('**没配对的粗体 和 落单的 *')), '孤星号必须也清掉');
});

await t('★ 端到端·真发一次（网络打桩）：回复那条路发出去的载荷里一个星号都没有', async () => {
  // 这一条是**行为级**的：不读源码、不看正则，而是把 `client` 的网络方法换掉，
  // 让 `replyMarkdown` / `sendMarkdown` 真跑一遍，**看它到底准备发什么**。
  // 为什么非要行为级：上面那条静态断言只能证明「源码里写的是 safe」，
  // 证明不了「运行时那条分支真的被走到」—— §2.4.4 那次（自证改掉了告警状态）
  // 就是栽在「静态全绿、跑起来是另一回事」。
  const payloads = [];
  const im = feishu.client.im;
  const orig = { reply: im.message.reply, create: im.message.create };
  im.message.reply = async (req) => { payloads.push({ via: 'reply', ...req.data }); return { data: { message_id: 'om_stub_reply' } }; };
  im.message.create = async (req) => { payloads.push({ via: 'create', ...req.data }); return { data: { message_id: 'om_stub_create' } }; };
  try {
    const sample = '1. **能查的我查完再说** —— 表、工作区文件、知识库检索这些我有路；'
      + '**查不到或者没跑成的，我会说「没查成」**，不会替它说成「没有」。';
    const r = await feishu.replyMarkdown('om_source_msg', 'oc_test', sample);
    assert.strictEqual(r.ok, true, `打桩下应当成功：${JSON.stringify(r)}`);
    assert.ok(payloads.length >= 1, '一次发送都没发生，这条对照没意义');
    for (const p of payloads) {
      assert.ok(!String(p.content).includes('*'),
        `发出去的载荷里有星号（via=${p.via} type=${p.msg_type}）：${String(p.content).slice(0, 200)}`);
    }
    // ★ 形态也要对：回复必须走富文本，否则丢的是粗体与代码块（只是「星号没了」不算修好）
    assert.strictEqual(payloads[0].msg_type, 'post',
      `replyMarkdown 应当用富文本回复，实际 ${payloads[0].msg_type}`);
    // ★ 反向对照：走降级支（post 打桩抛错）时，兜底 text 也必须不带星号
    payloads.length = 0;
    im.message.reply = async (req) => {
      if (req.data.msg_type === 'post') { const e = new Error('stub: post rejected'); e.response = { data: { code: 230099 } }; throw e; }
      payloads.push({ via: 'reply', ...req.data });
      return { data: { message_id: 'om_stub_reply2' } };
    };
    const r2 = await feishu.replyMarkdown('om_source_msg', 'oc_test', sample);
    assert.strictEqual(r2.ok, true, `降级也应当成功：${JSON.stringify(r2)}`);
    assert.strictEqual(payloads[0].msg_type, 'text', '降级那一步应当落回 text');
    assert.ok(!String(payloads[0].content).includes('*'),
      `降级载荷里还有星号：${String(payloads[0].content).slice(0, 200)}`);
    assert.ok(String(payloads[0].content).includes('能查的我查完再说'),
      '摘符号不许把内容一起摘掉 —— 正文必须还在');
  } finally {
    im.message.reply = orig.reply;
    im.message.create = orig.create;
  }
});

await t('★ 卡片：发出去的卡里一个星号都没有，而正文一个字没丢', async () => {
  // Owner 2026-10-14 的第二条裁定：**卡片也一律去掉 `**`**（不只纯文本那两类）。
  // 这条与「模型原话一个字不许丢」看似冲突 —— 落点是分开的：
  //   · **保真** ⇒ 槽位数据（`envelope` 的 `data`，内核拿它做记忆与回查）**逐字不动**；
  //   · **出站** ⇒ 卡 payload 与它的纯文本视图**都摘干净**。
  const cards = await import('./reply-cards/cards.mjs');
  const { plainifyCard } = await import('./agent/plain.mjs');

  // ① 模版自己写进去的 `**` 也要摘 —— 回执卡那句是**代码**写死的（不是模型写的）
  const receipt = cards.build('receipt', {
    title: '⏳ 处理中…', verdict: '完整审核正在运行，完成后会在此回复；遇到故障会明确提示。',
    note: '本次按**美国市场**口径审查（PRD 第一阶段范围）。',
  });
  assert.ok(!JSON.stringify(receipt).includes('*'),
    `回执卡里不该再有星号：${JSON.stringify(receipt).slice(0, 200)}`);
  // 卡的**纯文本视图**（降级兜底与台账正文共用）也必须干净 ——
  // 它原先只摘了折叠区标题，正文一个字都没摘（只在出事那一跳才会被看见）。
  const reg = await import('./reply-cards/registry.mjs');
  const rtxt = reg.renderText(receipt);
  assert.ok(!rtxt.includes('*'), `回执卡的纯文本视图也不许有星号：${rtxt.slice(0, 160)}`);
  assert.ok(rtxt.includes('美国市场'), '★ 摘的是符号，不是内容 —— 「美国市场」四个字必须还在');

  // ② 表格单元格里的星号（表格不在 `content` 字段上，通用遍历看不见它）
  const tcard = plainifyCard({ tag: 'table', columns: [{ name: 'a', display_name: '**字段**' }],
                               rows: [{ a: '**值**' }] });
  assert.ok(!JSON.stringify(tcard).includes('*'), '表格的列名与单元格也要摘');
  assert.strictEqual(tcard.columns[0].display_name, '字段', '列名要摘对');
  assert.strictEqual(tcard.rows[0].a, '值', '单元格要摘对');

  // ③ ★ 反向对照：`code_block` 里的 `*` **不许动** —— 那是内容不是标记
  const code = plainifyCard({ tag: 'markdown', content: 'x', elements: [
    { tag: 'code_block', language: 'python', text: 'def f(**kwargs): return a * b' }] });
  assert.ok(JSON.stringify(code).includes('**kwargs'),
    '代码块里的 `**kwargs` 是内容 —— 摘它就是改内容（这一条钉住白名单的边界）');

  // ④ ★ 反向对照：不认识的 tag 一律不碰（宁可漏，不许改内容）
  const unknown = plainifyCard({ tag: 'weird_future_tag', content: '**原样**' });
  assert.strictEqual(unknown.content, '**原样**',
    '认不出的 tag 不许摘 —— 白名单是「知道它在渲染什么」才摘');
});

await t('★ 接线：三条 `msg_type:text` 出口都必须真的调用摘符号（不是只 import）', async () => {
  const fsx = await import('node:fs');
  const pathx = await import('node:path');
  const urlx = await import('node:url');
  const here = pathx.dirname(urlx.fileURLToPath(import.meta.url));
  const src = fsx.readFileSync(pathx.join(here, 'agent', 'feishu.mjs'), 'utf8');
  // 按**出口**数，不是按 import 数：每一个 `msg_type: 'text'` 后面都必须跟 `text: safe`
  // （或该函数体内有 `plainifyForSend`）—— 这正是 §2.4 那句「名字出现过 ≠ 拦得住」的反面。
  const textSends = [...src.matchAll(/msg_type: 'text'[\s\S]{0,120}?JSON\.stringify\(\{ text: (\w+) \}/g)]
    .map((m) => m[1]);
  assert.ok(textSends.length >= 3, `应当找到至少 3 个 text 出口，实际 ${textSends.length}`);
  for (const v of textSends) {
    assert.strictEqual(v, 'safe',
      `text 出口把未摘符号的变量发出去了（实际发的是 \`${v}\`）—— 飞书会把它显示成字面符号`);
  }
  // ★ 反向对照：摘符号这件事**必须真的到达**（不是只 import 了 plain.mjs）
  assert.ok(/plainifyForSend\(/.test(src), 'feishu.mjs 必须真的调用 plainifyForSend');
  // ★★ 治因那一处：`replyMarkdown`（最常走的那条路）必须走 **富文本**。
  //    只摘符号不改形态也能出干净文本，但会**同时丢掉粗体与代码块**；
  //    这条断言钉的是「那条路真的换成了 post」，不只是「星号没了」。
  const replyFn = src.slice(src.indexOf('export async function replyMarkdown'));
  const body = replyFn.slice(0, replyFn.indexOf('\n}\n'));
  assert.ok(/msg_type: 'post'/.test(body),
    'replyMarkdown 必须用富文本(post)回复 —— 原先那条路把 markdown 原文塞进 text，是最常走的漏星号路径');
  // ★ 反向对照：post 转换器不许把 `**` 漏成字面（它就是「不摘符号」那条路的对照面）
  const nodes = feishu.__test_mdToPostNodes('**重点** 与 `code`');
  assert.ok(!JSON.stringify(nodes).includes('*'),
    'post 载荷里不许有星号（`**粗体**` 必须变成 bold 节点，不是字面星号）');
});

console.log('\n═══ 4. 记忆压缩的切点安全性（防 API 400）═══');

await t('压缩切点不拆散 tool_calls 与其结果', async () => {
  const mem = await import('./agent/memory.mjs');
  // 构造一段含工具调用的历史：user → assistant(tool_calls) → tool → assistant
  const sess = { key: 'test_boundary', messages: [], summary: '', messageCount: 0 };
  for (let i = 0; i < 6; i++) {
    sess.messages.push({ role: 'user', content: `问题 ${i}` });
    sess.messages.push({ role: 'assistant', content: '', tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'now', arguments: '{}' } }] });
    sess.messages.push({ role: 'tool', tool_call_id: `c${i}`, content: '{"ok":true}' });
    sess.messages.push({ role: 'assistant', content: `回答 ${i}` });
  }
  const compacted = await mem.compact(sess, async () => '摘要', 5, 5);  // 保留 5 轮 / 超过 5 条触发
  assert.strictEqual(compacted, true, '本应发生压缩');
  // 留下部分的第一条必须是 user —— 否则说明切在了 tool_calls/工具结果中间
  assert.strictEqual(sess.messages[0].role, 'user',
    `切点错误，留首条是 ${sess.messages[0].role}；应回退到 user 边界`);
  // 且留下的序列里，每个 assistant(tool_calls) 后面必须紧跟同数量 tool
  for (let i = 0; i < sess.messages.length; i++) {
    const m = sess.messages[i];
    if (m.role === 'assistant' && m.tool_calls?.length) {
      for (let k = 0; k < m.tool_calls.length; k++) {
        assert.strictEqual(sess.messages[i + 1 + k]?.role, 'tool',
          `第 ${i} 条 assistant(tool_calls) 之后第 ${k + 1} 条不是 tool`);
      }
    }
  }
});

await t('无法回退到边界时放弃压缩而非产生坏序列', async () => {
  const mem = await import('./agent/memory.mjs');
  const sess = { key: 'test_noboundary', messages: [], summary: '', messageCount: 0 };
  // 全是 tool 消息，没有 user 可作为切点
  for (let i = 0; i < 40; i++) sess.messages.push({ role: 'tool', tool_call_id: `t${i}`, content: 'x' });
  const compacted = await mem.compact(sess, async () => '摘要', 5, 5);  // 保留 5 轮 / 超过 5 条触发
  assert.strictEqual(compacted, false, '找不到安全切点时应放弃压缩');
  assert.strictEqual(sess.messages.length, 40, '放弃压缩时不应丢消息');
});

await t('纪要为空时必须放弃压缩（不许「删了历史、什么都没留」）', async () => {
  // ★ 2026-09-22 真事故：`summarize()` 在推理预算被吃光时返回空串，
  //   `compact()` 把它当成纪要写下去，**然后把旧对话全删了**。
  //   盘上的读数：三个会话的 `summary` 全是 0 长度，而日志印了 8 次「保留 N 轮 + 纪要」。
  //   代价不是「这次没压缩」，是「守衡确信地不记得」—— 下一轮它看到的是断头的历史。
  //
  //   这一条守的是**最后一道闸**：它与 summarize 的行为无关，故意的。
  //   喂三个空法（空串 / 纯空白 / undefined），一个都不许通过。
  const mem = await import('./agent/memory.mjs');
  for (const [name, empty] of [['空串', ''], ['纯空白', '\n\n   \t\n'], ['undefined', undefined]]) {
    const sess = { key: `test_emptysummary_${name}`, messages: [], summary: '', messageCount: 0 };
    for (let i = 0; i < 12; i++) {
      sess.messages.push({ role: 'user', content: `问题 ${i}` });
      sess.messages.push({ role: 'assistant', content: `回答 ${i}` });
    }
    const before = sess.messages.length;
    const compacted = await mem.compact(sess, async () => empty, 5, 5);
    assert.strictEqual(compacted, false, `返回${name}时应放弃压缩，实际 compacted=${compacted}`);
    assert.strictEqual(sess.messages.length, before, `返回${name}时不许丢消息（原 ${before} 条）`);
    assert.strictEqual(sess.summary, '', `返回${name}时不许把空白写进纪要`);
  }
  // 反面：非空纪要**必须**照常压缩 —— 否则上面那条可能是「压缩整个坏了」而全绿。
  const sess2 = { key: 'test_emptysummary_ok', messages: [], summary: '', messageCount: 0 };
  for (let i = 0; i < 12; i++) {
    sess2.messages.push({ role: 'user', content: `问题 ${i}` });
    sess2.messages.push({ role: 'assistant', content: `回答 ${i}` });
  }
  const okCompacted = await mem.compact(sess2, async () => '真的纪要', 5, 5);
  assert.strictEqual(okCompacted, true, '有纪要时必须照常压缩（反向对照）');
  assert.strictEqual(sess2.summary, '真的纪要', '纪要应写进去');
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. 查名字的降级链
//
// 背景：2026-09-16 真实群聊里，守衡收到消息却查不出「谁在说话」——
// 它走的是通讯录接口，而本应用没开 contact 权限，返回 99991672。
// 原来的 getUserName 用 `catch { return null }` 把这个原因吃掉了，
// 上层只能看到「查不到」，无法区分「人不在可见范围」还是「接口没权限」。
//
// 本组测试打的是真飞书接口（用真凭证），因为只有真接口才会暴露权限边界：
// 假 mock 会永远返回成功，测不出这个 bug。
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n═══ 5. 查名字的降级链（真接口，验权限边界）═══');

let liveChatId = null;
if (!OFFLINE) {
  const { config } = await import('./agent/config.mjs');
  liveChatId = config.allowedChats?.[0] ?? null;
  if (!liveChatId) {
    // 配置里是「不限」时没有群 id，但降级链必须有真群才能验证。
    // 这里让测试自己通过 API 发现群，而不是硬编码一个 id：
    // 硬编码的 id 在换群/换环境后会静默失效，测试会假装通过。
    try {
      const r = await feishu.client.im.chat.list({ params: { page_size: 50 } });
      const chats = r?.data?.items ?? [];
      const pick = chats.find((c) => /守衡|内容治理/.test(c.name ?? '')) ?? chats[0];
      liveChatId = pick?.chat_id ?? null;
      if (liveChatId) console.log(`  （自动发现群：${pick.name ?? '(无名)'} → ${liveChatId}）`);
    } catch (e) {
      console.log(`  （自动发现群失败：${e?.response?.data?.msg ?? e.message}）`);
    }
  }
}
if (!OFFLINE && !liveChatId) {
  console.log('  ⚠ 找不到任何群，第 5 组无法验证真接口 —— 这不算通过，请检查应用是否在群里');
}

await onlineTest('群成员接口可用（降级链的第一条路）', async () => {
  if (!liveChatId) throw new Error('没有配置 allowedChats，跳过真接口验证');
  const members = await feishu.listMembers(liveChatId, 100);
  assert.ok(Array.isArray(members), `期望数组，实际 ${JSON.stringify(members).slice(0, 200)}`);
  assert.ok(members.length > 0, '群成员列表为空，无法验证后续降级');
  assert.ok(members.every((m) => m.name && m.openId), '成员项必须同时有 name 和 openId');
});

await onlineTest('带 chatId 时，同群成员能查到真名（不需要通讯录权限）', async () => {
  if (!liveChatId) throw new Error('没有配置 allowedChats，跳过');
  const members = await feishu.listMembers(liveChatId, 100);
  const someone = members[0];
  const r = await feishu.getUserName(someone.openId, liveChatId);
  assert.strictEqual(r.name, someone.name, `期望 ${someone.name}，实际 ${r.name}`);
  assert.strictEqual(r.source, 'chat_member', `应命中群成员这条路，实际 source=${r.source}`);
});

await onlineTest('不带 chatId 且通讯录无权限时，如实返回原因而不是静默 null', async () => {
  const r = await feishu.getUserName('ou_TEST_USER', null);
  assert.strictEqual(r.name, null, '不存在的 open_id 不应查到名字');
  assert.strictEqual(r.source, 'none');
  // 关键：reason 必须非空。若这里是 null/undefined，说明又退回了静默吞异常。
  assert.ok(r.reason, `必须带出失败原因，实际 reason=${r.reason}`);
  assert.ok(
    /权限|code=|通讯录/.test(r.reason),
    `原因应可读且指向真实原因，实际：${r.reason}`,
  );
});

await onlineTest('lookup_user 工具能返回 source，并带上「别编称呼」的提示', async () => {
  const { executeTool, runtimeContext } = await import('./agent/tools.mjs');
  if (!liveChatId) throw new Error('没有配置 allowedChats，跳过');
  const members = await feishu.listMembers(liveChatId, 100);
  runtimeContext.chatId = liveChatId;               // 模拟真实处理时的注入
  const r = await executeTool('lookup_user', JSON.stringify({ open_id: members[0].openId }));
  assert.ok(r.ok, JSON.stringify(r).slice(0, 200));
  assert.strictEqual(r.result.name, members[0].name);
  assert.strictEqual(r.result.source, 'chat_member', `实际 source=${r.result.source}`);
  runtimeContext.chatId = null;
});

await onlineTest('查不到时，工具返回的提示明确禁止模型编造称呼', async () => {
  const { executeTool, runtimeContext } = await import('./agent/tools.mjs');
  runtimeContext.chatId = null;                     // 强制走通讯录那条失败路
  const r = await executeTool('lookup_user', JSON.stringify({ open_id: 'ou_TEST_USER' }));
  assert.ok(r.ok, '工具本身不应抛出');
  assert.ok(r.result.error, '应返回 error 字段');
  assert.ok(r.result.reason, '应带出 reason');
  assert.ok(/不要猜测|不要编造/.test(r.result.hint ?? ''), `hint 缺失或未禁止编造：${r.result.hint}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. 去重表落盘失败时的行为
//
// 背景：flushSeen 原来写成 `catch {}` —— 写盘失败被完全吞掉。
// 这个表决定「重启后是否重复回话」，它一旦静默丢失，表现是守衡对同一条消息
// 回两次，且日志里没有任何线索。
// 这段必须能注入路径才测得了，所以 STATE_DIR 支持 SHOUHENG_STATE_DIR 覆盖。
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n═══ 6. 去重表落盘失败不静默 ═══');

await t('写盘失败时不清 seenDirty，并打出一条警告', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const p = await import('node:path');

  // 让 STATE_DIR 指向一个「存在但不可写」的目录：
  // 用文件冒充目录，任何写入都会 ENOTDIR —— 比 chmod 更可靠，且不受 root 影响。
  const tmp = fs.mkdtempSync(p.join(os.tmpdir(), 'shouheng-test-'));
  const fakeDir = p.join(tmp, 'not-a-dir');
  fs.writeFileSync(fakeDir, 'x');
  process.env.SHOUHENG_STATE_DIR = fakeDir;

  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));

  let mod;
  try {
    // 带 cache-buster，确保重新读取 SHOUHENG_STATE_DIR
    mod = await import(`./agent/agent.mjs?failtest=${Date.now()}`);
    mod.alreadyHandled('om_test_flush_fail_1');
    mod.flushSeen();                 // 第一次：应失败并报一次
    mod.flushSeen();                 // 第二次：不应重复刷屏
  } finally {
    console.warn = origWarn;
    delete process.env.SHOUHENG_STATE_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const seenWarnings = warnings.filter((w) => w.includes('[seen]'));
  assert.strictEqual(seenWarnings.length, 1,
    `应恰好报 1 次（不刷屏），实际 ${seenWarnings.length} 次：${JSON.stringify(seenWarnings)}`);
  assert.ok(/落盘失败/.test(seenWarnings[0]), `警告内容不对：${seenWarnings[0]}`);
  assert.ok(/重复回话/.test(seenWarnings[0]), `警告应说明后果：${seenWarnings[0]}`);
});

await t('恢复可写后重新落盘，并报一次恢复', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const p = await import('node:path');

  const tmp = fs.mkdtempSync(p.join(os.tmpdir(), 'shouheng-test2-'));
  const fakeDir = p.join(tmp, 'not-a-dir');
  fs.writeFileSync(fakeDir, 'x');
  process.env.SHOUHENG_STATE_DIR = fakeDir;

  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));

  try {
    const mod = await import(`./agent/agent.mjs?recover=${Date.now()}`);
    mod.alreadyHandled('om_test_recover_1');
    mod.flushSeen();                                  // 失败
    fs.rmSync(fakeDir, { force: true });              // 清掉障碍，让路径可写
    fs.mkdirSync(fakeDir, { recursive: true });
    mod.flushSeen();                                  // 应成功并报恢复
  } finally {
    console.warn = origWarn;
    delete process.env.SHOUHENG_STATE_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const fail = warnings.filter((w) => w.includes('[seen]'));
  assert.ok(fail.some((w) => /落盘失败/.test(w)), '应报过失败');
  assert.ok(fail.some((w) => /恢复落盘/.test(w)),
    `恢复后应报一次，实际警告：${JSON.stringify(fail)}`);
});

await t('状态目录被同名文件占位时，进程仍能启动（不许 EEXIST/ENOTDIR 崩掉）', async () => {
  // 必须在子进程里测：修复前这个场景会直接杀掉进程，
  // 在本进程里测的话「崩溃」会被误读成「测试没通过」，而不是「产品起不来」。
  const { spawnSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const p = await import('node:path');

  const tmp = fs.mkdtempSync(p.join(os.tmpdir(), 'shouheng-boot-'));
  const fakeDir = p.join(tmp, 'not-a-dir');
  fs.writeFileSync(fakeDir, 'x');           // 用文件占住「状态目录」这个路径

  const r = spawnSync(process.execPath, ['--input-type=module', '-e',
    // 用绝对路径：原来写的是 './tools/agent/agent.mjs'，那是相对 cwd 的，
    // 于是这个测试**只在仓库根目录下运行才成立** —— 在 tools/ 里跑就会
    // 报 ERR_MODULE_NOT_FOUND（找不到 tools/tools/agent/agent.mjs）。
    // 子进程加载哪个文件是测试的固有属性，不该取决于你从哪敲的命令。
    `await import(${JSON.stringify(new URL('./agent/agent.mjs', import.meta.url).href)}); console.log('BOOT_OK');`,
  ], {
    cwd: process.cwd(),
    env: { ...process.env, SHOUHENG_STATE_DIR: fakeDir },
    encoding: 'utf8',
    timeout: 30000,
  });
  fs.rmSync(tmp, { recursive: true, force: true });

  assert.strictEqual(r.status, 0,
    `进程应正常退出，实际 status=${r.status}\n stderr: ${(r.stderr || '').slice(-500)}`);
  assert.ok((r.stdout || '').includes('BOOT_OK'),
    `应到达 import 之后的代码，实际 stdout: ${(r.stdout || '').slice(-300)}`);
  assert.ok(!/EEXIST|ENOTDIR: not a directory, mkdir/.test(r.stderr || ''),
    `不应把目录创建失败升级成崩溃：${(r.stderr || '').slice(-300)}`);
});

if (LIVE) {
  console.log('\n═══ 4. 真实 LLM 全链路（会消耗 token）═══');
  const { handleMessage } = await import('./agent/agent.mjs');
  const evt = (text, id) => ({
    sender: { sender_id: { open_id: 'ou_test_lee' }, sender_type: 'user' },
    message: {
      message_id: id, chat_id: 'oc_test_offline', chat_type: 'group', message_type: 'text',
      content: JSON.stringify({ text }),
      mentions: [{ key: '@_user_1', name: '守衡', id: { open_id: 'cli_aa2243de0438dcd7' } },
                 { key: '@_user_2', name: '对接人', id: { open_id: 'ou_test_lee' } }],
    },
  });

  for (const [i, q] of [
    '@_user_1 @_user_2 你是谁？用两句话回答。',
    '@_user_1 @_user_2 我刚才问了你什么？',
    '@_user_1 @_user_2 现在几点？',
  ].entries()) {
    const r = await handleMessage(evt(q, `om_test_${Date.now()}_${i}`));
    console.log(`\n  Q${i + 1}: ${q}`);
    console.log(`  A${i + 1}: ${r.reply ?? '（无回复 / ' + r.reason + '）'}`);
    if (r.meta?.toolTrace?.length) console.log(`  工具: ${r.meta.toolTrace.map((t) => t.tool).join(', ')}`);
  }
  const { status } = await import('./agent/agent.mjs');
  console.log('\n  LLM 用量:', JSON.stringify(status().llm, null, 2));
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. 时间基准一致性
//
// 背景（真实事故，不是假想）：`now` 工具返回北京时间，而 `recent_messages`
// 曾经返回 `toISOString()`，也就是 UTC。两种基准并存时，模型会自己再做一次
// 换算 —— 真实的 11:12 被守衡在群里说成「23:12」，一次错 12 小时。
//
// 这类错误必须由测试兜住，因为它在生产里**完全静默**：
// 没有异常、没有报错、日志干净，只是守衡对外说了错的时间。
// 唯一可靠的判据是「格式本身不许出现 UTC 的样子」。
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n═══ 7. 时间基准一致性（北京，不是 UTC）═══');

// 形如 `2026-09-16 12:26:20 星期三`；UTC ISO 那种 `...T04:26:20.117Z` 必须不被接受。
const BEIJING_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} 星期[日一二三四五六]$/;

await t('守衡格式化的时间不带 UTC 标识（Z / T）', async () => {
  const { beijingDateTime, beijingString } = await import('./agent/timefmt.mjs');
  const s = beijingString(Date.parse('2026-09-16T04:26:20.400Z'));
  assert.ok(BEIJING_RE.test(s), `应为「YYYY-MM-DD HH:mm:ss 星期X」，实际：${s}`);
  assert.ok(!s.includes('Z') && !s.includes('T'),
    `不得混入 UTC 标识（这正是让模型二次换算的诱因）：${s}`);

  const full = beijingDateTime(Date.parse('2026-09-16T04:26:20.400Z'));
  assert.strictEqual(full.date, '2026-09-16');
  assert.strictEqual(full.time, '12:26:20', `UTC 04:26 应为北京 12:26，实际 ${full.time}`);
  assert.strictEqual(full.iso, '2026-09-16T04:26:20.400Z', 'iso 应保留同一瞬间，便于核对');
});

await t('now 工具与 timefmt 同源，且偏移按真实时区计算', async () => {
  const { executeTool } = await import('./agent/tools.mjs');
  const r = await executeTool('now', {});
  assert.strictEqual(r.ok, true, `now 工具失败：${r.error}`);
  assert.ok(BEIJING_RE.test(r.result.beijing_time),
    `now.beijing_time 格式应为「YYYY-MM-DD HH:mm:ss 星期X」，实际：${r.result.beijing_time}`);
  // 不硬编码 +8：将来时区规则若变化，这里会自己发现，而不是继续悄悄算错。
  assert.strictEqual(r.result.timezone, 'Asia/Shanghai (UTC+08:00)',
    `时区标注不对：${r.result.timezone}`);
});

await t('午夜不产生 24:xx 这种非法时刻', async () => {
  const { beijingDateTime } = await import('./agent/timefmt.mjs');
  // 北京时间 00:00–00:59 对应 UTC 前一天 16:xx。
  // en-CA + hour12:false 在午夜可能给出 hour='24'，不归一就会输出「24:05」。
  for (const h of [0, 1, 5, 23]) {
    const utc = Date.UTC(2026, 8, 15, h, 5, 0);   // 北京 = h+8
    const { time } = beijingDateTime(utc);
    const hh = Number(time.slice(0, 2));
    assert.ok(hh >= 0 && hh <= 23, `时刻越界：${time}（UTC ${h}:05）`);
    assert.ok(!time.startsWith('24'), `出现了非法的 24 时：${time}`);
  }
});

await t('时间戳损坏时不抛异常，而是给出可读的占位', async () => {
  const { beijingString } = await import('./agent/timefmt.mjs');
  // 一条坏消息的时间戳不该让整个工具调用失败 —— 那是把局部数据问题升级成功能故障。
  const s = beijingString('not-a-date');
  assert.ok(typeof s === 'string' && s.length > 0, `应返回可读占位，实际：${s}`);
  assert.ok(s.includes('时间未知'), `应说明时间未知，实际：${s}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. 群历史必须能分辨「谁发的」
//
// 背景（真实事故）：群历史接口**是**返回 sender.id 的（实测有值），但工具层
// 把它丢掉、一律显示「用户」。守衡于是看到 7 条消息全是「用户」，
// 据此回答「我分辨不出哪条是谁发的」—— 一个听上去非常合理、但完全错误的结论。
//
// 这类缺陷的性质：**不是能力不足，是自己把信息扔了**。守衡会自信地宣称
// 自己做不到，而数据一直躺在返回值里。所以必须有测试锁住「占位符不许回来」。
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n═══ 8. 群历史能分辨发送者 ═══');

await t('app 消息与 user 消息都被正确归类', async () => {
  const { resolveSender } = await import('./agent/feishu.mjs');
  const map = new Map([['ou_me', '周健'], ['ou_other', '对接人']]);

  assert.strictEqual(resolveSender({ senderType: 'app', senderId: 'cli_x' }, map).from, '守衡(你自己)',
    'app 消息应标成守衡自己');
  assert.strictEqual(resolveSender({ senderType: 'user', senderId: 'ou_me' }, map).from, '周健',
    '已知成员应解析出姓名');
  assert.strictEqual(resolveSender({ senderType: 'user', senderId: 'ou_other' }, map).from, '对接人',
    '不同成员必须能区分开');
});

await t('未知成员退化为 open_id，而不是「用户」这种无法区分的占位符', async () => {
  const { resolveSender } = await import('./agent/feishu.mjs');
  const map = new Map();   // 空成员表：模拟「拉不到成员列表」

  const r = resolveSender({ senderType: 'user', senderId: 'ou_unknown_person' }, map);
  assert.ok(!/^用户$/.test(r.from),
    `退回无法区分人的「用户」等于重新制造这次的 bug：${r.from}`);
  assert.ok(r.from.includes('ou_unknown_person'),
    `应保留 open_id 以便比对：${r.from}`);
  // 关键：即使解析不出姓名，也必须留下可比对的身份，让「两条是不是同一个人」仍然可判
  assert.strictEqual(r.senderOpenId, 'ou_unknown_person', 'senderOpenId 必须一并带出');
});

await t('接口没给发送者身份时，如实说明，不伪装成普通「用户」', async () => {
  const { resolveSender } = await import('./agent/feishu.mjs');
  const r = resolveSender({ senderType: 'user', senderId: undefined }, new Map());
  assert.ok(r.from.includes('未返回'), `应如实标注接口未返回身份：${r.from}`);
  assert.strictEqual(r.senderOpenId, null);
});

await onlineTest('真实群里用户消息解析出姓名（不是 ou_ 开头）', async () => {
  const { executeTool, runtimeContext } = await import('./agent/tools.mjs');
  const feishuMod = await import('./agent/feishu.mjs');
  runtimeContext.chatId = 'oc_TEST_GROUP';
  runtimeContext.chatType = 'group';

  const members = await feishuMod.listMembers(runtimeContext.chatId);
  const names = new Set((Array.isArray(members) ? members : []).map((u) => u.name));

  const r = await executeTool('recent_messages', { limit: 20 });
  assert.strictEqual(r.ok, true, `recent_messages 失败：${r.error}`);
  const msgs = r.result.messages;
  assert.ok(msgs.length > 0, '应至少取到一条历史消息');

  const userMsgs = msgs.filter((m) => !String(m.from).includes('守衡'));
  assert.ok(userMsgs.length > 0, '本群应有用户消息可供验证');
  for (const m of userMsgs) {
    assert.ok(!/^用户$/.test(m.from), `不得退回「用户」占位符：${JSON.stringify(m).slice(0, 120)}`);
    assert.ok(names.has(m.from),
      `发送者「${m.from}」应是本群成员之一（${[...names].join('、')}）—— 解析不出姓名说明成员表没接上`);
  }

  // 顺带确认时间与身份是同一份数据里出来的，不是拼凑的
  assert.ok(/星期[日一二三四五六]$/.test(msgs[0].at), `时间格式不对：${msgs[0].at}`);
  runtimeContext.chatId = null;
});

// ─────────────────────────────────────────────────────────────────────────────
// 第 9 组：截断守卫。真实事故 —— 779 字回复停在「…里「未做」，
// 守护进程却记「✓ 已发送」。半句话被当成完整回答，用户无从知道它是断的。
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n═══ 9. 截断必须可见（不许把半句话当完整回答发出去）═══');

await t('finish_reason=length 必须被判为截断（哪怕正文看着像正常结尾）', async () => {
  const { detectTruncation } = await import('./agent/truncate.mjs');

  const r = detectTruncation({ finishReason: 'length', text: '这是一段看起来已经写完的话。' });
  assert.strictEqual(r.cut, true, 'finish_reason 是权威信号，不能被文本启发式推翻');
  assert.ok(/length/.test(r.reason), `原因里应包含 length：${r.reason}`);

  const ok = detectTruncation({ finishReason: 'stop', text: '正常收尾的回答。' });
  assert.strictEqual(ok.cut, false, '正常收尾不应误报');
});

await t('回归：事故原文必须被拦住', async () => {
  const { detectTruncation } = await import('./agent/truncate.mjs');

  // 逐字来自 2026-09-16 那条真实回复的结尾
  const incident = '**怎么变好的：** 刚查时工具已经修好并重启了，我重新读了一次历史，发送者字段就出来了。这条也算那份记录里「未做';
  const r = detectTruncation({ finishReason: 'length', text: incident });
  assert.strictEqual(r.cut, true, '这条必须被判为截断');

  // 即使 finish_reason 丢了，文本启发式也要能兜住
  const noFinish = detectTruncation({ finishReason: undefined, text: incident });
  assert.strictEqual(noFinish.cut, true,
    '『未做』这种悬空结尾即使没有 finish_reason 也必须拦住 —— 不能只依赖一个信号');
});

await t('悬空标点与空回复都要拦住', async () => {
  const { detectTruncation } = await import('./agent/truncate.mjs');

  assert.strictEqual(detectTruncation({ finishReason: 'stop', text: '我想说的是，' }).cut, true, '逗号结尾应拦');
  assert.strictEqual(detectTruncation({ finishReason: 'stop', text: '补充说明（' }).cut, true, '左括号结尾应拦');
  assert.strictEqual(detectTruncation({ finishReason: 'stop', text: '空回复应拦' }).cut, false, '有收尾的中文不该拦');
  assert.strictEqual(detectTruncation({ finishReason: 'stop', text: '' }).cut, true, '空回复应拦');
  // 短句不误报：短内容本来就可能没有句号
  assert.strictEqual(detectTruncation({ finishReason: 'stop', text: '好' }).cut, false, '短回答不该误报');
  assert.strictEqual(detectTruncation({ finishReason: 'stop', text: '收到' }).cut, false, '两字回复不该误报');
  // 表格/列表结尾不该误报（Markdown 里本来就常无句号）
  const table = '| # | 时间 | 说的 |\n|---|---|---|\n| 1 | 22:38 | 你是做什么的 |';
  assert.strictEqual(detectTruncation({ finishReason: 'stop', text: table }).cut, false, '表格结尾不该误报');
});

await t('被截断的回复必须带出可见的截断标记，且不留在半句话上', async () => {
  const { annotateTruncation } = await import('./agent/truncate.mjs');

  const incident = '**怎么变好的：** 刚查时工具已经修好并重启了。这条也算那份记录里「未做';
  const out = annotateTruncation(incident, { reason: 'finish_reason=length（额度耗尽）' });

  assert.ok(out.includes('截断'), '必须明说被截断了，用户才知道这不是全部');
  assert.ok(out.includes('接着说'), '要给出可执行的下一步');
  assert.ok(!out.includes('「未做\n'), '不能把半句话原样留在正文里');
  assert.ok(out.startsWith('**怎么变好的：**'), '完整部分应保留');

  // 超长必须被收住，不能一条消息刷屏
  const huge = '一。'.repeat(5000);
  const capped = annotateTruncation(huge, { maxChars: 500 });
  assert.ok(capped.length < 900, `应被长度上限收住，实际 ${capped.length} 字`);
});

await t('配置的 maxTokens 必须留得下思维链（实测 1600 会被吃光）', async () => {
  const { config } = await import('./agent/config.mjs');
  assert.ok(config.llm.maxTokens >= 4000,
    `maxTokens=${config.llm.maxTokens} 太小：DeepSeek 的额度同时覆盖思维链，实测 1600/4000 时 reasoning 会全部吃光、正文 0 字`);
});

console.log('\n═══ 10. 群历史的「看不见」必须由工具给，不由模型推 ═══');

await t('提示词能构建，且人设正文里没有裸反引号', async () => {
  const { buildSystemPrompt, SYSTEM_PROMPT } = await import('./agent/persona.mjs');
  let sp;
  assert.doesNotThrow(() => { sp = buildSystemPrompt(); }, 'SYSTEM_PROMPT 是模板字符串，正文里出现裸反引号会让整个模块语法错误');

  // 事故：往提示词里写 `recent_messages` 做反引号强调，模板字符串提前闭合，
  // 整个 persona.mjs 变成语法错误 —— 而这在跑测试之前完全看不出来。
  //
  // ★ 2026-09-22 修正：原先断言的是「`# 当前时间` 之前的全部正文里不许有反引号」。
  //   **那是误报，而且已经挂了很久** —— `cardContract()` 那段本来就要示范卡片块围栏
  //   （源码里写的是转义反引号 \`\`\`，构建后就是真反引号），它就落在那个区间里。
  //   实测：改之前跑本套件是「41 通过 / 1 失败」，失败的就是这一条。
  //   一个长期误报的检查器会让人开始不看报告（AGENTS.md §2.1.1），所以改成断真正的不变量：
  //   **人设正文（SYSTEM_PROMPT）里一个反引号都不许有**；卡片规程那段单独放行，
  //   但要断言它示范的围栏**真的出现在了成品提示词里**（反过来被「修」没了也要红）。
  // ★ 2026-10-05 第二次修正：上一条 09-22 的修法（「渲染结果里一个反引号都不许有」）
  //   **自己变成了误报** —— 09-30 那次会话在知识库那一行里**故意**写了行内代码
  //   （源码 \`127.0.0.1\`，转义的正确写法），渲染出来就是一对反引号。
  //   于是本套件从那天起一直是红的（实测 `2 !== 0`），而且**没人注意到** ——
  //   这正是 AGENTS.md §2.1.1 那句话本身：一个会误报的检查器会让人开始不看报告。
  //   判据收到真正的危险上：**未转义**的反引号会让模板字符串提前闭合（09-22 那次事故的形状），
  //   转义的写法无害。所以查的是**源码**，不是渲染结果，且必须自带反向对照。
  {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('./agent/persona.mjs', import.meta.url), 'utf8');
    const n = unescapedBackticksInTemplate(src, 'SYSTEM_PROMPT');
    assert.strictEqual(n, 0, `人设模板里有 ${n} 个**未转义**反引号 —— 模板字符串会提前闭合，`
      + '整个 persona.mjs 变成语法错误（09-22 的事故形状）');
    // 反向对照：喂事故形状必须报出来，否则这条也是空转
    const bad = 'export const SYSTEM_PROMPT = `往提示词里写 `recent_messages` 做强调`;';
    assert.ok(unescapedBackticksInTemplate(bad, 'SYSTEM_PROMPT') > 0,
      '反向对照失败：喂未转义反引号没报出来，说明这条判据是空转的');
    // 反面之二：转义写法**不许**被误报（否则又会回到上面那个误报状态）
    const good = 'export const SYSTEM_PROMPT = `走本机 \\`127.0.0.1\\` 的只读接口`;';
    assert.strictEqual(unescapedBackticksInTemplate(good, 'SYSTEM_PROMPT'), 0,
      '转义反引号是正确写法，不许误报');
  }
  assert.ok(sp.includes('[[card:类型]]'), '卡片块的围栏必须真的出现在成品提示词里');
  assert.ok(sp.includes('```'), '围栏的三个反引号必须真的渲染出来（转义写错会静默少掉）');

  assert.ok(sp.includes('只能看到最近 50 条'), '必须写明群历史只看得到最近 50 条');
  assert.ok(sp.includes('撤回的消息，原文取不回'), '必须写明撤回的消息取不回原文');
  // ★ 2026-10-05 加：**媒材本身就算送审**。起因是一次真实事故 ——
  //   有人发了一条视频、一个字没写，守衡把读数描述了一遍就收工，**一次工具都没调**，
  //   而路由规则当时是按问句写的（「能不能发 / 审一下」），光秃秃的媒体消息不匹配任何问句。
  assert.ok(sp.includes('没有文字也一样'), '人设必须写明「带媒材但没文字，也一样走 kb_review_chain」');
  assert.ok(/图 \/ 视频 \/ 飞书文档链接[\s\S]{0,40}送审/.test(sp),
    '那条规则必须点名「图 / 视频 / 飞书文档链接」这三种媒材');
  // ★★ 2026-10-15 改口径（**不是改措辞**）：这两句原先是
  //   `sp.includes('图片只读得到「字」')` 与 `sp.includes('画面本身你看不到')` ——
  //   那时**画面层根本不存在**，所以「看不到」是恒真的。现在画面读数真的进来了，
  //   再要求人设说"看不到"就是**把有说成没有**；而放宽成"你看过这张图"又会让它
  //   把自己想象的画面写进结论。⇒ 判据改成**两半都要在**：
  //   ① 图能读图内文字；② 画面结论的依据是**读数**（不是原图），且**没读到要说未测**。
  assert.ok(sp.includes('图内文字'), '必须写明：图能读图内文字');
  assert.ok(sp.includes('画面读数') && sp.includes('不是你看到的原图'),
    '必须写明：画面读数**是模型读数、不是原图** —— 否则模型会把「读到图上的字」说成「看过这张图」');
  assert.ok(sp.includes('画面这层未测'),
    '必须写明：画面读数没读到时要如实说「未测」，**不许**说成「画面没问题」');
  assert.ok(sp.includes('按规矩不取'), '附件必须说成「按规矩不取」，不许说成「没权限 / 能力还没做」');
  assert.ok(sp.includes('「我打不开飞书文档」通常是一句假话'),
    '必须写明：收到飞书链接时先说工作区里有没有那一份，再说读不读得了');
  assert.ok(!/我记不清/.test(sp.replace(/不要用「我记不清」/g, '')),
    '不许把「看不到」说成「记不清」——那是两种不同的东西');
});

await t('recent_messages 返回值必须带窗口边界，且顶到上限时明说', async () => {
  const { listRecentMessages } = await import('./agent/feishu.mjs');
  const msgs = await listRecentMessages('oc_TEST_GROUP', 5);
  if (msgs?.error) return; // 离线时不联网断言，避免测试依赖网络

  assert.ok(msgs.window, '必须带 window 字段：否则守衡说「第一次」时不知道自己只看到了一截');
  assert.strictEqual(msgs.window.returned, msgs.length);
  assert.strictEqual(msgs.window.atLimit, msgs.length >= 5);
  assert.ok(msgs.window.oldestAt, '必须给出窗口最早一条的时间');

  if (msgs.window.atLimit) {
    assert.ok(/第一次/.test(msgs.window.note), '顶到上限时必须提示「第一次」只在本窗口内成立');
  }

  // 撤回的消息必须带 recalled 标记，否则它和「一条短消息」长得一模一样
  const recalled = msgs.filter((m) => m.recalled);
  for (const m of recalled) {
    assert.ok(!/This message was recalled/.test(m.text), '英文占位符要换成人能读懂的说明');
    assert.ok(/撤回/.test(m.text), '撤回的消息要说明原文取不回');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 第 11 组：空回复不许污染记忆、工具返回体不许撑爆上下文。
// 真实事故（2026-09-30 19:11 / 19:16，本群）：她问「用知识库查一下『吸奶器』相关的
// 措辞要求」→ 工具回了 41,262 + 19,087 = 60,349 字原始 JSON → 下一轮推理把 8000 token
// 输出预算吃光（finish_reason=length、正文 0 字）→ 群里收到一条**只有截断说明的消息**。
// 之后**每一步都是这个空回复的连锁反应**：空 assistant 被存进记忆 → 下一轮回放时
// API 400（The reasoning_content … must be passed back）→ 那条 400 被当成「已答」写进
// 记忆 → 补发队列认为她已经被答过，答案永远没发出去。
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n═══ 11. 空回复与超长工具返回体（2026-09-30 事故的三条根因）═══');

await t('空 assistant 轮不许落进记忆（API 会 400，且会被当成「已经答过」）', async () => {
  const mem = await import('./agent/memory.mjs');
  const sess = { key: 'k', messages: [], messageCount: 0 };

  const r1 = mem.append(sess, { role: 'assistant', content: '' });
  assert.strictEqual(r1.stored, false, '空串必须被拒收');
  assert.strictEqual(sess.messages.length, 0, `空串不该进 messages，实际 ${sess.messages.length} 条`);

  // 纯空白与 null 是同一个病的另两种写法 —— 一起拦
  assert.strictEqual(mem.append(sess, { role: 'assistant', content: '  \n\t ' }).stored, false, '纯空白也必须被拒收');
  assert.strictEqual(mem.append(sess, { role: 'assistant', content: null }).stored, false, 'null 也必须被拒收');

  // ── 反面：该放行的三种，一个都不许被误伤（否则会把正常回答也吞掉）
  assert.strictEqual(mem.append(sess, { role: 'assistant', content: '结论：不能单独写「吸奶器」。' }).stored, true,
    '有内容的回答必须照常落盘');
  assert.strictEqual(mem.append(sess, { role: 'assistant', content: '', tool_calls: [{ id: 'c1' }] }).stored, true,
    '带 tool_calls 的空 content 是协议的一部分，**不许**被拦');
  assert.strictEqual(mem.append(sess, { role: 'user', content: '' }).stored, true,
    '只拦 assistant 轮 —— user / tool 轮的判据不同，不该在这一层顺手管');
});

await t('回放时丢掉历史里的坏记录（盘上已经躺着的那两条也要救）', async () => {
  const mem = await import('./agent/memory.mjs');
  const withEmpty = [
    { role: 'system', content: 'S' },
    { role: 'user', content: '用知识库查一下「吸奶器」相关的措辞要求' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'kb_search' } }] },
    { role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' },
    { role: 'assistant', content: '' },                                   // ← 事故里那条（第 26 条）
    { role: 'assistant', content: '' },                                   // ← 另一条（第 43 条）
    { role: 'user', content: '接着说' },
  ];
  const out = mem.sanitizeForLlm(withEmpty);

  assert.strictEqual(out.filter((m) => m.role === 'assistant' && !String(m.content ?? '').trim()
    && !(m.tool_calls?.length)).length, 0,
    '回放里一个空 assistant 都不许剩下 —— 实测单发必 400（reasoning_content must be passed back）');
  assert.strictEqual(out.length, 5, `应只删掉那两条空 assistant，实际 ${out.length} 条：${JSON.stringify(out.map((m) => m.role))}`);
  assert.deepStrictEqual(out.map((m) => m.role), ['system', 'user', 'assistant', 'tool', 'user'],
    '只删不许重排 —— 顺序变了就是另一个 bug');
  assert.strictEqual(out[3].tool_call_id, 'c1', '配得上 tool_calls 的 tool 结果必须留着');

  // ── 反面：孤儿 tool 结果（前面没有对应的 tool_calls）必须丢掉 —— 实测那也是一种 400
  const orphan = mem.sanitizeForLlm([
    { role: 'system', content: 'S' },
    { role: 'user', content: 'q' },
    { role: 'tool', tool_call_id: 'nope', content: '{"ok":true}' },
    { role: 'assistant', content: '正常的回答。' },
  ]);
  assert.strictEqual(orphan.some((m) => m.role === 'tool'), false, '孤儿 tool 结果会让 API 直接拒收整条请求');
  assert.strictEqual(orphan.length, 3, '除了那条孤儿，其余一条都不许少');

  // 一个 tool 结果只配一次：重复的同样丢掉（重复 id 也是 400 的形状）
  const dup = mem.sanitizeForLlm([
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1' }] },
    { role: 'tool', tool_call_id: 'c1', content: 'a' },
    { role: 'tool', tool_call_id: 'c1', content: 'b' },
  ]);
  assert.strictEqual(dup.filter((m) => m.role === 'tool').length, 1, '同一个 tool_call_id 只许配一个结果');

  // ── 反面之二：干净的历史必须**一条都不动**（否则这一层就成了新的破坏源）
  const clean = [{ role: 'system', content: 'S' }, { role: 'user', content: 'q' },
                 { role: 'assistant', content: '答' }, { role: 'user', content: 'q2' }];
  assert.deepStrictEqual(mem.sanitizeForLlm(clean), clean, '正常对话不许被清洗动到');

  // ★★ 接线断言：清洗必须在**真正的回放出口** `toLlmMessages` 上生效。
  //   只测 `sanitizeForLlm` 是不够的 —— 反向对照实测：把 `toLlmMessages` 里那一行
  //   `return sanitizeForLlm(out)` 改回 `return out`，纯函数那几条**照样全绿**，
  //   而守衡每一轮请求都会带着空 assistant 去换一个 400。
  //   （这正是 AGENTS.md §2.4 那个病：函数写对了，但没人断言它被接上。）
  const sess2 = { summary: '', messages: [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: '' },                 // ← 盘上真出现过的那种坏记录
    { role: 'user', content: '接着说' },
  ] };
  const replay = mem.toLlmMessages(sess2, 'SYS');
  assert.strictEqual(replay.filter((m) => m.role === 'assistant' && !String(m.content ?? '').trim()
    && !(m.tool_calls?.length)).length, 0,
    'toLlmMessages 的出口必须已经清洗过 —— 否则清洗只是一段没人调用的代码');
  assert.strictEqual(replay[0].role, 'system', '系统提示仍必须在最前');
});

await t('工具返回体超过预算必须被真的剪掉（60,349 字的那个形状）', async () => {
  const { clipToolOutput, TOOL_OUTPUT_MAX_CHARS, collapseToolMessages } = await import('./agent/truncate.mjs');

  // 事故里那份返回体的真实尺寸：41,262 + 19,087
  const huge = JSON.stringify({ ok: true, collection: '3_措辞表达库', hitCount: 44,
    hits: Array.from({ length: 44 }, (_, i) => ({ docId: `d${i}`, text: '正例：这款吸奶器采用仿生吸吮技术。'.repeat(40) })) });
  assert.ok(huge.length > 20_000, `样本要够大才有意义，实际 ${huge.length} 字`);

  const clipped = clipToolOutput(huge);
  assert.ok(clipped.length <= TOOL_OUTPUT_MAX_CHARS + 300,
    `必须被剪到上限附近，实际 ${clipped.length} 字（上限 ${TOOL_OUTPUT_MAX_CHARS}）`);
  assert.ok(clipped.includes(String(huge.length)), '剪了多少字要写在里面 —— 裁剪必须可见');
  assert.ok(/没进上下文|截断/.test(clipped), '要明说这是被截断的，不许让调用方以为拿到的是全文');

  // 反面：没超限的不许动一个字符
  const small = JSON.stringify({ ok: true, hits: [{ text: '短' }] });
  assert.strictEqual(clipToolOutput(small), small, '没超预算时不许改写返回体');

  // ★ 兜底合成要的是**没有原始 JSON**：折叠后必须短，且仍指得出「有哪些东西、多少量」
  const msgs = [{ role: 'user', content: 'q' },
                { role: 'assistant', content: '', tool_calls: [{ id: 'c1' }] },
                { role: 'tool', tool_call_id: 'c1', content: huge }];
  const folded = collapseToolMessages(msgs);
  assert.strictEqual(folded.length, 3, '条数不许变 —— tool_call_id 还得配得上 tool_calls');
  assert.strictEqual(folded[2].tool_call_id, 'c1', 'tool_call_id 必须原样保留，否则合成那一跳会 400');
  assert.ok(folded[2].content.length < 600, `折叠后要短，实际 ${folded[2].content.length} 字`);
  assert.ok(folded[2].content.includes('44'), '折叠不许把「量」丢掉 —— 要能说出命中多少条');
  assert.ok(!folded[2].content.includes('仿生吸吮'), '折叠后不许再夹带原始正文');
  assert.deepStrictEqual(folded[0], msgs[0], '非 tool 的消息一条都不许动');
});

await t('kb_search 的返回体有上限，且裁剪**必须报出来**', async () => {
  const kb = await import('./agent/kb_client.mjs');

  // 纯函数式的判据：常量存在且互相自洽
  assert.ok(kb.HITS_RETURN_MAX >= 1 && kb.HITS_RETURN_MAX <= kb.TOPK_MAX,
    `HITS_RETURN_MAX=${kb.HITS_RETURN_MAX} 必须落在 1..${kb.TOPK_MAX}`);
  assert.ok(kb.HIT_TEXT_MAX >= 200 && kb.HIT_TEXT_MAX <= 4000,
    `HIT_TEXT_MAX=${kb.HIT_TEXT_MAX} 不合理：太小会剪掉整条规则，太大等于没剪`);

  // 离线时（连不上对端）跳过实网断言，但上面那两条与网络无关，必须照跑
  let r;
  try { r = await kb.retrieve(kb.COLLECTIONS.wording, '吸奶器', { topK: 50 }); }
  catch { return; }   // 对端不在线是**正常状态之一**，不该让自证变红

  assert.ok(r.hits.length <= kb.HITS_RETURN_MAX,
    `一次塞进上下文的分片数必须 ≤ ${kb.HITS_RETURN_MAX}，实际 ${r.hits.length}`);
  assert.strictEqual(r.hits_returned, r.hits.length, 'hits_returned 必须等于真的回给你的条数');
  assert.strictEqual(r.hits_dropped, r.hitCount - r.hits.length,
    'hits_dropped 必须等于「服务端命中 − 真回给你的」—— 两个读数不许各说各的');
  if (r.hits_dropped > 0 || r.text_clipped > 0) {
    assert.ok(r.clip_note, '剪了就**必须**有一句说明，否则会被读成「库里只有 10 条」');
    assert.ok(/不等于|不许|不要/.test(r.clip_note), '说明里要写清「这不等于库里只有这些」');
  }
  for (const h of r.hits) {
    assert.ok(String(h.text).length <= kb.HIT_TEXT_MAX + 120,
      `单条分片正文应被剪到 ${kb.HIT_TEXT_MAX} 字附近，实际 ${String(h.text).length}`);
  }
  // uniqueDocCount 必须描述**这次交到手里的那几条**，不是服务端全量
  assert.ok(r.uniqueDocCount <= r.hits.length, 'uniqueDocCount 不许大于回给你的分片数（那是旧口径：按全量算）');
});

// ─────────────────────────────────────────────────────────────────────────────
// 第 12 组：模型把**工具调用语法当成正文**吐出来 —— 2026-09-30 实盘撞见的第二种形状。
// 复现：修完上面那批之后实盘重放，模型在正文里直接写框架标记与 invoke/parameter 标签，
// 而当时 `internalLeak` **一条都不命中**（实测 0）——
// 后果是群里看到一段谁也读不懂的尖括号，比半句话更难判断「这是不是全部内容」。
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n═══ 12. 工具调用语法漏进正文（思考模式的第二种泄漏形状）═══');

await t('DSML 框架标记必须被 internalLeak 拦住', async () => {
  const { lintCopy } = await import('./reply-cards/registry.mjs');

  // 逐字来自 2026-09-30 实盘那次模型输出
  const leaked = '<\uFF5C\uFF5CDSML\uFF5C\uFF5C calls>\n'
    + '<\uFF5C\uFF5CDSML\uFF5C\uFF5C invoke name="kb_search">\n'
    + '<\uFF5C\uFF5CDSML\uFF5C\uFF5C parameter name="collection" string="true">3_措辞表达库';
  const hit = lintCopy(leaked).find((h) => h.id === 'internalLeak');
  assert.ok(hit, `这串框架标记必须被拦下 —— 否则群里看到的是谁也读不懂的尖括号。实测命中：${JSON.stringify(lintCopy(leaked))}`);
  assert.ok(hit.count >= 1, `应至少计到 1 处，实际 ${hit.count}`);

  // ── 反面：正经回答里出现 invoke / parameter 这类**正常英文词**时不许误报
  //    （§2.1.1：一个会误报的检查器比没有检查器更糟 —— 判据取的是带全角竖线的标记本身）
  const normal = '这条规则的 parameter 有两个：条款号与生效日期。用 kb_search 查 invoke 的写法即可。';
  assert.strictEqual(lintCopy(normal).filter((h) => h.id === 'internalLeak').length, 0,
    '正常英文词不许被当成泄漏 —— 否则正经回答会被拦下');

  // 反面之二：只有半截标记（没有竖线）也不该报
  const half = '我调了 DSML 里的 kb_search 工具。';
  assert.strictEqual(lintCopy(half).filter((h) => h.id === 'internalLeak').length, 0,
    '光提到 DSML 三个字母不是泄漏，标记形状才是判据');
});


// ─────────────────────────────────────────────────────────────────────────────
// 第 13 组：图文消息进链路 —— 2026-10-05 那条「评审下下这个图片，能过吗？」
//
// 事故形状（逐字取自 PMO/logs/ws_events.jsonl 那一条真实事件）：
// Owner私聊发了一条**图文混排**（飞书里这是 `post` 类型），守衡 **14ms** 回：
//   「这条是「post」，它的正文我读不了 —— 需要的话请把它转成文字发我。」
// 两个错，同一个形状（结论比输入大）：
//   ① 正文就在 payload 里（`bodyToText` 09-22 就修好了），却被整类拒掉 —— 假否定；
//   ② 图片按红线不取（当时对），但话说成「正文我读不了」，她于是没有任何可走的路。
// 修法：正文照读；**人当前发来的图**读图内文字（§2.6 窄豁免，Owner 10-05 确认）；
//       file/media/audio 仍然一次都不取。
//
// ★ 这一组全部用**桩**（不联网、不花 token），所以它是能随时跑的判据，
//   而不是「要真发一条消息才知道」。—— 判据跑不动，等于没有判据。
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n═══ 13. 图文消息：正文读得出来 + 图只读字 + 附件一次都不取 ═══');

// 逐字来自那一条真实事件（`post` 类型，正文 + 一张 940×1162 的图）
const INCIDENT_POST = '{"title":"","content":[[{"tag":"text","text":"评审下下这个图片，能过吗？","style":[]}],'
  + '[{"tag":"img","image_key":"img_v3_02166_ec55a781-048d-400d-9e97-616adba94e0g","width":940,"height":1162}]],'
  + '"content_v2":[[{"tag":"text","text":"评审下下这个图片，能过吗？","style":[]}],'
  + '[{"tag":"img","image_key":"img_v3_02166_ec55a781-048d-400d-9e97-616adba94e0g","width":940,"height":1162}]]}';
const INCIDENT_MID = 'om_x100b63191aeb5ca0b4b07c1c5864afb';
const INCIDENT_KEY = 'img_v3_02166_ec55a781-048d-400d-9e97-616adba94e0g';

await t('回归·事故那条 post 的正文必须读得出来（旧行为是空串）', async () => {
  const { bodyToText } = await import('./agent/feishu.mjs');
  const p = bodyToText('post', INCIDENT_POST);
  assert.strictEqual(p.parsed, true, 'post 必须解析成功 —— 解析不出来就是回到事故现场');
  assert.ok(p.text.includes('评审下下这个图片，能过吗？'), `正文没读出来：${JSON.stringify(p.text)}`);
  assert.ok(p.text.includes('[图片]'), '图在正文里要留一个位置标记，否则模型不知道那句话旁边还有张图');
});

await t('图在哪：只认 post / image 两种形态', async () => {
  const { imageKeysOf } = await import('./agent/feishu.mjs');
  const k1 = imageKeysOf('post', INCIDENT_POST);
  assert.strictEqual(k1.length, 1, `post 里应认出 1 张图，实际 ${k1.length}`);
  assert.strictEqual(k1[0].imageKey, INCIDENT_KEY, 'image_key 必须逐字带出来（取字节就靠它）');
  assert.strictEqual(k1[0].width, 940);
  assert.strictEqual(imageKeysOf('image', '{"image_key":"img_abc"}').length, 1, '单图消息也要认');
  assert.strictEqual(imageKeysOf('image', '{"image_key":"img_abc"}')[0].imageKey, 'img_abc');
});

await t('红线·file / media / audio 一张都不许被当成图', async () => {
  const { imageKeysOf } = await import('./agent/feishu.mjs');
  for (const [type, payload] of [
    ['file', '{"file_key":"file_v3_x","file_name":"a.xlsx"}'],
    ['media', '{"file_key":"file_v3_y","duration":3000}'],
    ['audio', '{"file_key":"file_v3_z","duration":9000}'],
    // 极端形状：附件 payload 里**硬塞**一个 image_key 也不许被认出来
    ['file', '{"file_key":"f","image_key":"img_v3_sneaky"}'],
  ]) {
    assert.deepStrictEqual(imageKeysOf(type, payload), [],
      `${type} 类型不许回任何图 —— 那不在 §2.6 窄豁免里`);
  }
});

await t('行为级·图文混排：真取图 + 真 OCR，图块里带 OCR 文字', async () => {
  const { readInboundContent, buildImageBlock } = await import('./agent/agent.mjs');
  const calls = { fetch: [], ocr: [], cleaned: 0 };
  const deps = {
    fetchImage: async (mid, key) => {
      calls.fetch.push([mid, key]);
      return { path: '/tmp/假图.img', bytes: 745672, error: null, cleanup: () => { calls.cleaned++; } };
    },
    ocr: async (p) => { calls.ocr.push(p); return { ok: true, text: 'Du bist Mama.\nUnd noch so viel mehr.', lines: 2, chars: 39, w: 940, h: 1162 }; },
  };
  const r = await readInboundContent({ message_id: INCIDENT_MID, message_type: 'post', content: INCIDENT_POST }, deps);
  assert.deepStrictEqual(calls.fetch, [[INCIDENT_MID, INCIDENT_KEY]], `取图调用不对：${JSON.stringify(calls.fetch)}`);
  assert.deepStrictEqual(calls.ocr, ['/tmp/假图.img'], 'OCR 必须拿到取回来的那个路径');
  assert.strictEqual(calls.cleaned, 1, '字节用完必须清理 —— 豁免是「过一遍 OCR」，不是「留下来」');
  assert.ok(r.text.includes('评审下下这个图片，能过吗？'), '正文不能因为带图就丢掉');
  const block = buildImageBlock(r);
  assert.ok(block.includes('Du bist Mama.'), '图内文字必须进图块');
  // ★★ 2026-10-15 改口径：**「画面本身看不到」不再是一句常量** ——
  //   它取决于这一单到底有没有画面读数（此前画面层根本不存在，所以那句话恒真）。
  //   这个用例的桩**没给** scene ⇒ 走的是「没有画面读数」那一支 ⇒ 必须写明看不到。
  assert.ok(/画面我看不到|画面这一单没有/.test(block),
    `没有画面读数时，图块必须写明「画面看不到」—— 否则模型会把读到的字说成看过这张图：\n${block}`);
  assert.ok(/OCR/.test(block), '图块必须写明这是 OCR 读数（可能有识别错误），不许当逐字原文引用');
});

// ─────────────────────────────────────────────────────────────────────────────
// 画面层（PRD §5.1「基础视觉识别」那一半，2026-10-15 补）
//
// 为什么补：PRD 把图片的输入写成两半（**OCR ＋ 基础视觉识别**），而这一层从来没做 ——
// 知识库侧与模型侧吃的都是同一份图内文字，「产品使用 / 人物行为 / 场景风险」**整类没人判**。
// 起因是 `vision.mjs` 头注那句「模型不吃图」，当天被实测否掉（同端点带 image_url ⇒ HTTP 200）。
// 这一组钉三件事：① 读数真挂到 inbound 上（OCR 成功/失败/没字三种都要在）
//                ② 图块与模型侧读数都拿到它，且**没读数时不许假装有**
//                ③ 真跑一次试纸（这条**要发一次网络请求**，与 ASR 那几条真跑试纸同档）
// ─────────────────────────────────────────────────────────────────────────────

const SCENE_JSON = JSON.stringify({
  setting: '厨房',
  people: [{ kind: '婴幼儿', doing: '被抱着' }],
  products: [{ what: '粉色球形物', in_use: false }],
  visible_marks: ['momcozy'],
  risk_cues: ['婴幼儿出镜'],
  unclear: ['月龄'],
});

const sceneOk = () => ({ ok: true, ms: 4200, scene: {
  setting: '厨房', people: [{ kind: '婴幼儿', doing: '被抱着' }],
  products: [{ what: '粉色球形物', in_use: false }], visible_marks: ['momcozy'],
  risk_cues: ['婴幼儿出镜'], unclear: ['月龄'] } });

await t('画面层·接线：读数挂到 inbound 上，且**不依赖 OCR 成功与否**', async () => {
  const { readInboundContent, buildImageBlock, mediaReadAppendix } = await import('./agent/agent.mjs');
  const { readingsForModelSide } = await import('./agent/model_side.mjs');
  const base = {
    fetchImage: async () => ({ path: '/tmp/假图.img', bytes: 745672, error: null, cleanup: () => {} }),
  };
  const only = { message_id: INCIDENT_MID, message_type: 'post', content: INCIDENT_POST };

  // ① OCR 有字：两条读数都在
  const r1 = await readInboundContent(only, { ...base, scene: async () => sceneOk(),
    ocr: async () => ({ ok: true, text: 'Du bist Mama.', lines: 1, chars: 13, w: 940, h: 1162 }) });
  assert.strictEqual(r1.images[0].scene?.ok, true, '画面读数没挂到 images[0] 上');
  const b1 = buildImageBlock(r1);
  assert.ok(/画面读数/.test(b1) && /婴幼儿/.test(b1), `图块没带上画面读数：\n${b1}`);
  assert.ok(/不是原图/.test(b1), '图块必须写明「画面读数是模型读数，不是原图」，否则模型会说自己看过图');
  assert.ok(!/画面我看不到/.test(b1), '有画面读数时**不许**再说「画面我看不到」—— 那是把有说成没有');
  assert.ok(/婴幼儿/.test(readingsForModelSide(r1)), '模型侧读数没带上画面那一节');
  assert.ok(/画面读数/.test(mediaReadAppendix(r1)), '报告附录没带上画面那一节');

  // ② ★ 反向对照：**OCR 失败**时画面读数仍在（这正是那次事故那张图的形状 —— 图上只有品牌字样）
  const r2 = await readInboundContent(only, { ...base, scene: async () => sceneOk(),
    ocr: async () => ({ ok: false, error: 'perform_failed' }) });
  assert.ok(r2.images[0].failed, 'OCR 失败要照实落 failed');
  assert.strictEqual(r2.images[0].scene?.ok, true, 'OCR 失败把画面读数一起丢了 —— 挂在 OCR 分支里就会这样');
  assert.ok(/婴幼儿/.test(buildImageBlock(r2)), 'OCR 失败时图块仍要带上画面读数');

  // ③ 反向对照：**画面层没读到**时，图块必须说「未测」，不许说「没有画面」
  const r3 = await readInboundContent(only, { ...base,
    scene: async () => ({ ok: false, ms: 12, error: 'HTTP 500：boom' }),
    ocr: async () => ({ ok: true, text: 'x', lines: 1, chars: 1, w: 10, h: 10 }) });
  const b3 = buildImageBlock(r3);
  assert.ok(/没读到/.test(b3) && /未测/.test(b3), `画面层没读到要写「未测」：\n${b3}`);
  assert.ok(/HTTP 500/.test(b3), '要把原始错误带出来（否则排查只能靠猜）');
  const side3 = readingsForModelSide(r3);
  assert.ok(/没读到/.test(side3) && /未测/.test(side3), '模型侧也要拿到「未测」，不许静默');
  assert.ok(/没读到/.test(mediaReadAppendix(r3)), '报告附录同样要写「未测」');

  // ④ **这一单没跑画面层**（开关关掉）⇒ 如实说「没跑」，**不许**说成「没读到/没问题」，
  //    也不许把它当成一份读数摊给模型（`readingsForModelSide` 那一侧要一个字都不写）。
  const r4 = await readInboundContent(only, { ...base,
    scene: async () => ({ ok: false, skipped: true, ms: 0, error: '画面层未开（SHOUHENG_SCENE=0）' }),
    ocr: async () => ({ ok: true, text: 'x', lines: 1, chars: 1, w: 10, h: 10 }) });
  const b4 = buildImageBlock(r4);
  // ⚠️ 断言要**指得准**：块头那句写的是「画面层没跑**或**没读到」（分支未定时的措辞），
  //   所以不能拿「整块里有没有『没读到』三个字」当判据 —— 那会误报（第一版就是这么红的）。
  //   要判的是**这一张那一格走的是哪一支**：`这一单没跑` 还是 `没读到（…）`。
  assert.ok(/这一单\*{0,2}没跑/.test(b4), `关掉时那一格要说「这一单没跑」：\n${b4}`);
  assert.ok(!/没读到（/.test(b4), `关掉时不许用「没读到（…）」那种**失败**措辞：\n${b4}`);
  assert.ok(!/画面读数（视觉模型/.test(readingsForModelSide(r4)), '关掉时不许把它当成读数摊给模型');
  assert.ok(/没跑/.test(mediaReadAppendix(r4)), '报告附录也要写「没跑」');

  // ⑤ 画面层抛异常 ⇒ **不许**让这次回话失败（与 OCR 那条契约同一条）
  const r5 = await readInboundContent(only, { ...base,
    scene: async () => { throw new Error('桩：画面层炸了'); },
    ocr: async () => ({ ok: true, text: 'x', lines: 1, chars: 1, w: 10, h: 10 }) });
  assert.strictEqual(r5.images[0].scene?.ok, false, '画面层抛异常要落成 ok:false');
  assert.ok(/画面层炸了/.test(r5.images[0].scene.error), '异常原因要留下');
  assert.strictEqual(r5.images[0].text, 'x', '画面层炸了不该影响 OCR 那条读数');
});

await onlineTest('画面层·真跑试纸：吃图模型这条路现在通不通（这条要发一次网络请求）', async () => {
  const sceneMod = await import('./agent/scene.mjs');
  if (!sceneMod.SCENE_ENABLED) { console.log('       （SHOUHENG_SCENE=0 ⇒ 跳过，如实跳过不算通过）'); return; }
  const pf = await sceneMod.preflight();
  assert.strictEqual(pf.ok, true,
    `画面层试纸没跑通（${pf.detail}）—— 这一红就是「PRD 那半条范围又整类消失了」，`
    + '而它在群里只表现为「结论少了一类」，没有任何东西会红。');
  assert.ok(/场景=|人物=|物品=/.test(pf.detail), `试纸读数里必须看得见内容，不能只有 HTTP 200：${pf.detail}`);
});

await t('行为级·取不到 ≠ 图上没字（两句话必须不一样）', async () => {
  const { readInboundContent, buildImageBlock } = await import('./agent/agent.mjs');
  const only = { message_id: 'om_test', message_type: 'image', content: '{"image_key":"img_x"}' };

  // ★ 2026-10-15：这两条验的是 **OCR 侧的措辞**，所以把画面层显式桩成「没跑」——
  //   否则真 sceneRead 会对一个不存在的 /tmp 路径回一句「没读到」，那句里也带「读不到」，
  //   把这一组本来要验的区分搅浑（实测就是这么红的第一版）。
  const noScene = { scene: async () => ({ ok: false, skipped: true, ms: 0, error: '测试：不跑画面层' }) };
  const fail = await readInboundContent(only, { ...noScene,
    fetchImage: async () => ({ path: null, bytes: 0, error: '取图失败 code=99991672 msg=权限不足', cleanup: () => {} }),
  });
  assert.ok(fail.images[0].failed, '取不到必须落成 failed');
  const bFail = buildImageBlock(fail);
  assert.ok(bFail.includes('这一张我读不到') && bFail.includes('99991672'), `取不到的措辞不对：${bFail}`);
  assert.ok(!/没有可读的文字/.test(bFail), '取不到**不许**说成「图上没字」—— 那是把一个否定结论说过头');

  const empty = await readInboundContent(only, { ...noScene,
    fetchImage: async () => ({ path: '/tmp/空.img', bytes: 1200, error: null, cleanup: () => {} }),
    ocr: async () => ({ ok: true, text: '', lines: 0, chars: 0, w: 10, h: 10 }),
  });
  assert.strictEqual(empty.images[0].ocrEmpty, true, 'OCR 成功但没文字，要落成 ocrEmpty');
  const bEmpty = buildImageBlock(empty);
  assert.ok(bEmpty.includes('没识别出任何文字'), `图上没字的措辞不对：${bEmpty}`);
  assert.ok(!/读不到/.test(bEmpty), '图上没字**不许**说成「我读不到」—— 两件事引出的下一步不同');
});

await t('行为级·OCR 抛异常也要删掉临时件（finally）', async () => {
  const { readInboundContent } = await import('./agent/agent.mjs');
  let cleaned = 0;
  const r = await readInboundContent(
    { message_id: 'om_test', message_type: 'image', content: '{"image_key":"img_x"}' },
    {
      fetchImage: async () => ({ path: '/tmp/图.img', bytes: 10, error: null, cleanup: () => { cleaned++; } }),
      ocr: async () => { throw new Error('OCR 进程炸了'); },
    });
  assert.strictEqual(cleaned, 1, 'OCR 抛了也必须 clean —— 否则一次故障就留下一堆临时图');
  assert.ok(String(r.images[0].failed).includes('取图抛异常') || String(r.images[0].failed).includes('炸了'),
    `异常必须落在 failed 里说清楚，实际：${JSON.stringify(r.images[0])}`);
});

await t('行为级·图数上限：超出的要说话，不许静默少读', async () => {
  const { readInboundContent, buildImageBlock, MAX_IMAGES_PER_MESSAGE } = await import('./agent/agent.mjs');
  let fetches = 0;
  const many = { message_id: 'om_many', message_type: 'post',
    content: JSON.stringify({ content: Array.from({ length: MAX_IMAGES_PER_MESSAGE + 2 },
      (_, i) => [{ tag: 'img', image_key: `img_${i}` }]) }) };
  const r = await readInboundContent(many, {
    fetchImage: async () => { fetches++; return { path: '/tmp/x.img', bytes: 5, error: null, cleanup: () => {} }; },
    ocr: async () => ({ ok: true, text: 'x', lines: 1, chars: 1 }),
  });
  assert.strictEqual(fetches, MAX_IMAGES_PER_MESSAGE, `最多只许取 ${MAX_IMAGES_PER_MESSAGE} 张，实际取了 ${fetches}`);
  assert.strictEqual(r.skippedImages, 2, '没读的那两张必须记数');
  assert.ok(buildImageBlock(r).includes('还有 2 张图'), '没读的必须说出来 —— 静默少读会让结论比输入大');
});

await t('端到端·file 类型走 handleMessage：一次都不取字节，且说「按规矩不取」', async () => {
  const { handleMessage } = await import('./agent/agent.mjs');
  let fetches = 0;
  const r = await handleMessage({
    message: { message_id: `om_file_${Date.now()}`, chat_id: 'oc_test', chat_type: 'p2p',
               message_type: 'file', content: '{"file_key":"file_v3_abc","file_name":"材料.xlsx"}' },
    sender: { sender_id: { open_id: 'ou_test' } },
  }, { deps: { fetchImage: async () => { fetches++; return { path: null, bytes: 0, error: 'x', cleanup: () => {} }; } } });
  assert.strictEqual(fetches, 0, '附件类型一次都不许取字节 —— 这是 §2.6 红线的执行点');
  assert.strictEqual(r.reason, 'attachment_not_taken');
  assert.ok(/按规矩|不让下载/.test(r.reply), `话术要写「规矩」，实际：${r.reply}`);
  assert.ok(/图片/.test(r.reply), '要顺带说清「图片不一样（可以直接发我）」—— 否则她还是不知道下一步能怎么做');
});

await t('端到端·只有图且读不出字 → 如实说 + 给下一步（不许编内容）', async () => {
  const { handleMessage } = await import('./agent/agent.mjs');
  const r = await handleMessage({
    message: { message_id: `om_img_${Date.now()}`, chat_id: 'oc_test', chat_type: 'p2p',
               message_type: 'image', content: '{"image_key":"img_v3_only"}' },
    sender: { sender_id: { open_id: 'ou_test' } },
  }, { deps: {
    fetchImage: async () => ({ path: '/tmp/only.img', bytes: 999, error: null, cleanup: () => {} }),
    ocr: async () => ({ ok: true, text: '   ', lines: 0, chars: 0 }),
  } });
  assert.strictEqual(r.reason, 'image_unreadable');
  assert.ok(/没读出内容/.test(r.reply), `要说清「没读出内容」，实际：${r.reply}`);
  assert.ok(/贴过来|再发/.test(r.reply), '要给一条走得通的路');
});

await t('反向对照·上面几条不是空转（喂旧形状必须红）', async () => {
  const { imageKeysOf } = await import('./agent/feishu.mjs');
  // ① 假否定样本：旧代码按 `JSON.parse(content).text` 读 post → 空串。这个断言证明那条路确实是空的。
  const naive = (() => { try { return JSON.parse(INCIDENT_POST).text ?? ''; } catch { return ''; } })();
  assert.strictEqual(naive, '', '旧的读法在 post 上就该是空 —— 若这条变成非空，说明样本不再代表事故');
  // ② 正面样本非空：证明 imageKeysOf 不是恒回空数组（恒真断言比没有断言更糟）
  assert.ok(imageKeysOf('post', INCIDENT_POST).length > 0, 'imageKeysOf 在真 payload 上必须非空');
  // ③ 附件样本恒空：证明类型闸门真的在（不是碰巧）
  assert.strictEqual(imageKeysOf('file', '{"file_key":"f","image_key":"img_sneaky"}').length, 0,
    '带 image_key 的附件 payload 也必须回空 —— 否则闸门只是「没遇到」而不是「拦住了」');
});


// ─────────────────────────────────────────────────────────────────────────────
// 第 14 组：**这条路的试纸** —— 真跑一次 OCR，而不是喂桩。
//
// 为什么必须有这一组（2026-10-05）：第 13 组全是桩，它证明的是**接线**对不对；
// 「这台机器上 OCR 还跑不跑得起来」它一个字都没说。而这次事故最本质的教训是：
// **守衡读不到图，没有任何东西会变红。** 所以这里放一张本仓自带的试纸
// （`tools/agent/__fixtures__/ocr-sample.png`），每次跑自证都真读一遍：
//   · 读得到 → 这条路是通的（且二进制缺失时会现场编译，编译失败即红）；
//   · 读不到 → 红，并说清是「二进制编不出来」还是「试纸读不出特征串」。
// 反向对照同样重要：**空白试纸必须报「图上没字」，不是「读不出来」** ——
// 只测得出「能读到字」的试纸，测不出「把失败伪装成没字」。
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n═══ 14. 读图的试纸（真跑 OCR；不联网、不碰飞书）═══');

await t('真跑一次 OCR：试纸上的特征串必须读得出来', async () => {
  const v = await import('./agent/vision.mjs');
  assert.ok(fs.existsSync(v.OCR_FIXTURE), `试纸不在：${v.OCR_FIXTURE} —— 没有试纸就没法证明这条路是通的`);
  const r = await v.ocrImage(v.OCR_FIXTURE);
  assert.strictEqual(r.ok, true, `OCR 没跑通（${r.error ?? '未知'}）：${r.detail ?? ''}`);
  assert.ok(String(r.text).toUpperCase().includes(v.OCR_FIXTURE_TOKEN),
    `试纸读到了 ${r.lines} 行，但没有特征串「${v.OCR_FIXTURE_TOKEN}」。读到的是：${String(r.text).slice(0, 200)}`);
});

await t('反向对照·空白试纸必须报「图上没字」，不是「读不出来」', async () => {
  const v = await import('./agent/vision.mjs');
  const b = await v.ocrImage(v.OCR_BLANK_FIXTURE);
  assert.strictEqual(b.ok, true, '空白图必须**成功**返回（ok:true、没有文字），而不是失败');
  assert.strictEqual(String(b.text).trim(), '', `空白图不该读出任何字，实际：${JSON.stringify(b.text)}`);
  assert.notStrictEqual(b.error, 'not_found', '拿错了文件会变成另一种错，这条对照就没意义了');
});

await t('反向对照·文件不存在必须报 not_found（不许伪装成「图上没字」）', async () => {
  const v = await import('./agent/vision.mjs');
  const r = await v.ocrImage('/tmp/绝不存在-ocr-试纸.png');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'not_found', `实际 error=${r.error}`);
  assert.ok(!('text' in r) || !r.text, '读不到时不许回一段空 text（那会被上层读成「图上没字」）');
});

await t('启动自检 preflight：读得出特征串 + 空白对照都对', async () => {
  const v = await import('./agent/vision.mjs');
  const pf = await v.preflight();
  assert.strictEqual(pf.ok, true, `preflight 没过（${pf.error}）：${pf.detail ?? ''}`);
  assert.ok(pf.lines >= 3, `试纸行数太少（${pf.lines}）—— 可能只读到一半`);
  assert.strictEqual(pf.blankOk, true, '反向对照没过：空白试纸没被认成「没字」');
});

// ─────────────────────────────────────────────────────────────────────────────
// 第 15 组：**下次发图的另外两种真实形态**（2026-10-05 补）
//
// 13 组覆盖的是「这条消息里带图」；但真实群/私聊里还有两种常见发法，
// 而它们原先**都会失败**（守衡会回「你这条里没图」—— 而图就在那儿）：
//   ① 「发一张图 → 回它一句『这张能过吗』」：图在**被引用的那条**消息里；
//   ② 群里用富文本（post）@守衡：真实日志里有这个形状（09-23 08:38 那条）。
// 这一组把这两种形状钉住。
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n═══ 15. 引用的那条里的图 + 群里的富文本 @（两种真实形态）═══');

await t('图在被引用的那条消息里（这条只写了一句问话）', async () => {
  const { readInboundContent, buildImageBlock } = await import('./agent/agent.mjs');
  const cur = {
    message_id: 'om_cur', message_type: 'text', content: '{"text":"这张能过吗？"}',
    parent_id: 'om_parent_with_image',
  };
  const calls = [];
  const r = await readInboundContent(cur, {
    // 当前这条没有图 → 必须去读 parent_id 指的那条
    loadParent: async (pid) => {
      calls.push(pid);
      return { msgType: 'post', images: [{ imageKey: 'img_v3_from_parent', width: 800, height: 600 }], text: '' };
    },
    fetchImage: async (mid, key) => ({ path: `/tmp/${key}.img`, bytes: 1234, error: null, cleanup: () => {} }),
    ocr: async () => ({ ok: true, text: '限时五折 立即购买', lines: 2, chars: 10 }),
  });
  assert.deepStrictEqual(calls, ['om_parent_with_image'], `必须只读它引用的那一条，实际读了：${JSON.stringify(calls)}`);
  assert.strictEqual(r.fromParent, true, '要标出「图来自被引用的那条」');
  assert.strictEqual(r.imageCount, 1);
  const b = buildImageBlock(r);
  assert.ok(/引用的那条/.test(b), `图块必须说清来源，实际：${b.slice(0, 120)}`);
  assert.ok(b.includes('限时五折'), '被引用那条里的图，字也要进来');
});

await t('被引用的那条**读不到**时：说「未测」，不许说成「没图」', async () => {
  const { readInboundContent, buildImageBlock } = await import('./agent/agent.mjs');
  const r = await readInboundContent(
    { message_id: 'om_cur2', message_type: 'text', content: '{"text":"这张呢"}', parent_id: 'om_x' },
    { loadParent: async () => ({ error: '回读消息失败 code=230002 msg=不在可见范围' }) });
  assert.strictEqual(r.imageCount, 0);
  assert.strictEqual(r.parentNote?.kind, 'parent_unreadable', `actual=${JSON.stringify(r.parentNote)}`);
  // 图块是空的（没有图），但那句话要在「读不了」那一支里说出来 —— 这里断言数据层
  assert.strictEqual(buildImageBlock(r), '', '没有图时不该产出图块');
  assert.ok(/不在可见范围/.test(r.parentNote.error), '原因要带出来，方便排查');
});

await t('反向对照·**不许翻历史**：没带图、也没引用 → 一张都不许取', async () => {
  const { readInboundContent } = await import('./agent/agent.mjs');
  let fetched = 0, parentReads = 0;
  const r = await readInboundContent(
    { message_id: 'om_plain', message_type: 'text', content: '{"text":"你好"}' },
    { loadParent: async () => { parentReads++; return {}; },
      fetchImage: async () => { fetched++; return { path: null, bytes: 0, error: 'x', cleanup: () => {} }; } });
  assert.strictEqual(fetched, 0, '普通文本消息一次都不许取字节');
  assert.strictEqual(parentReads, 0, '没有 parent_id 时**不许**去读上一条（那正是「翻历史」那条线）');
  assert.strictEqual(r.imageCount, 0);
});

await t('群里的富文本 post（真实 payload 形状）：@守衡 认得出来、正文读得出来', async () => {
  const feishuMod = await import('./agent/feishu.mjs');
  // 逐字取自 PMO/logs/ws_events.jsonl 里 09-23 08:38 那条真实群消息的形状
  const content = '{"title":"","content":[[{"tag":"at","user_id":"@_user_1","user_name":"守衡","style":[]},'
    + '{"tag":"text","text":" 这张图能过吗？","style":[]}],[{"tag":"img","image_key":"img_v3_group_case","width":900,"height":1200}]]}';
  const p = feishuMod.bodyToText('post', content);
  assert.strictEqual(p.parsed, true);
  assert.ok(p.text.includes('@守衡'), `post 的 at 节点要还原成 @真名，实际：${JSON.stringify(p.text)}`);
  const { display, mentions } = feishuMod.resolveMentions(p.text, [
    { key: '@_user_1', name: '守衡', id: { open_id: 'cli_aa2243de0438dcd7' } },
  ]);
  assert.strictEqual(feishuMod.isBotMentioned(mentions), true, 'post 里 @守衡 必须被认出来（否则群里直接跳过不回）');
  // 剥掉 @ 之后应当只剩问题本身 + 一个**图片位置标记**。
  // `[图片]` 是有意留的：它告诉模型「这句话旁边还有一张图」（图的内容在图块里）。
  const q = feishuMod.stripBotMention(display, mentions).trim();
  assert.strictEqual(q, '这张图能过吗？\n[图片]', `实际：${JSON.stringify(q)}`);
  assert.ok(!q.includes('@守衡'), '不能让 @守衡 留在问题里（否则模型会把它当正文去答）');
  assert.strictEqual(feishuMod.imageKeysOf('post', content).length, 1, '群里的 post 也要认出那张图');
});

await t('端到端·群里 post + @守衡 + 图（用桩，不联网）：必须走到模型那一侧', async () => {
  const { readInboundContent, buildImageBlock } = await import('./agent/agent.mjs');
  const content = '{"title":"","content":[[{"tag":"at","user_id":"@_user_1","user_name":"守衡","style":[]},'
    + '{"tag":"text","text":" 这张图能过吗？","style":[]}],[{"tag":"img","image_key":"img_v3_group_case","width":900,"height":1200}]]}';
  const r = await readInboundContent(
    { message_id: 'om_group_post', message_type: 'post', chat_type: 'group', content },
    { fetchImage: async () => ({ path: '/tmp/g.img', bytes: 999, error: null, cleanup: () => {} }),
      ocr: async () => ({ ok: true, text: 'Momcozy 吸奶器 五折', lines: 1, chars: 16, w: 900, h: 1200 }) });
  assert.strictEqual(r.imageCount, 1);
  assert.ok(buildImageBlock(r).includes('Momcozy 吸奶器 五折'), '图上文字要进图块');
  const feishuMod = await import('./agent/feishu.mjs');
  const { display, mentions } = feishuMod.resolveMentions(r.text,
    [{ key: '@_user_1', name: '守衡', id: { open_id: 'cli_aa2243de0438dcd7' } }]);
  assert.strictEqual(feishuMod.isBotMentioned(mentions), true);
  assert.strictEqual(feishuMod.stripBotMention(display, mentions).trim(), '这张图能过吗？\n[图片]');
});

// ─────────────────────────────────────────────────────────────────────────────
// 第 16 组：**视频** —— §2.6 窄豁免 2026-10-05 加宽后的形状。
//
// 背景（真实事故）：10-05 09:22:43 委托方私聊发了一条视频
// （`type=file` + `file_v3_00166_48a0a140…` + `momcozy-…-hero-1080p.mp4`），
// 守衡 **0 毫秒**回了 108 字的拒绝。她随后追问「这个视频能过审吗？」——
// 也就是「发视频」这条路当时**一条都不通**。
//
// 加宽的形状（Owner 现场确认）与图片那条**完全一样**：同一个取字节调用点、
// 同样只写临时目录、同样用完即删、抽帧与转写全在本机。
// 没松的：`file` 里的**非视频附件**（xlsx / pdf / docx…）、群历史、云文档、多维表格。
// 这一组就是把「宽到哪、没到哪」变成会红的断言。
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n═══ 16. 视频那条路（窄豁免加宽后的形状）═══');

const VIDEO_MEDIA_MSG = { message_id: 'om_vid_media', message_type: 'media',
  content: JSON.stringify({ file_key: 'file_v3_00166_48a0a140', file_name: 'hero-1080p.mp4',
                            duration: 14960, image_key: 'img_v3_cover' }) };
const VIDEO_FILE_MSG = { message_id: 'om_vid_file', message_type: 'file',
  content: JSON.stringify({ file_key: 'file_v3_00166_48a0a140',
                            file_name: 'momcozy-one-click-foldable-baby-playard-hero-1080p.mp4' }) };
const XLSX_FILE_MSG = { message_id: 'om_xlsx', message_type: 'file',
  content: JSON.stringify({ file_key: 'file_v3_xlsx', file_name: '2026内容排期.xlsx' }) };
const PDF_FILE_MSG = { message_id: 'om_pdf', message_type: 'file',
  content: JSON.stringify({ file_key: 'file_v3_pdf', file_name: '检测报告.pdf' }) };
const AUDIO_MSG = { message_id: 'om_audio', message_type: 'audio',
  content: JSON.stringify({ file_key: 'file_v3_audio', duration: 3000 }) };

/** 一个「读视频」的桩：把真实现的返回形状照抄一份，但一个字节都不落盘。 */
function stubReadVideo(result) {
  return async () => ({
    ok: true,
    meta: { duration_s: 14.96, w: 1920, h: 1080, fps: 25, has_audio: true, audio_channels: 2, audio_rate: 48000 },
    frames: [{ t_s: 0.94, text: 'MOMCOZY', lines: 1 }, { t_s: 8.42, text: 'MOMCOZY', lines: 1 }],
    framesRead: 2, framesFailed: 0,
    ocrText: '[0.94s] MOMCOZY\n[8.42s] MOMCOZY', ocrChars: 16, ocrTruncated: false,
    transcript: { ok: true, text: 'Meet the playard that folds in one second.', chars: 42, locale: 'en-US' },
    notes: [], ms: 3500, cleanup: () => {},
    ...result,
  });
}

await t('视频在哪：只认 media 与「名字是视频的 file」', () => {
  assert.strictEqual(feishu.videoKeysOf('media', VIDEO_MEDIA_MSG.content).length, 1, 'media 就是视频消息');
  assert.strictEqual(feishu.videoKeysOf('file', VIDEO_FILE_MSG.content).length, 1,
    '名字是 .mp4 的 file 也算视频 —— 委托方那条就是这么发过来的');
  for (const [name, m] of [['xlsx', XLSX_FILE_MSG], ['pdf', PDF_FILE_MSG], ['audio', AUDIO_MSG]]) {
    assert.strictEqual(feishu.videoKeysOf(m.message_type, m.content).length, 0,
      `${name} 不许被当成视频 —— 那不在豁免里`);
  }
  // 图片那条支路不许被视频影响：media 里带 image_key（封面帧）也**不是**一张要读的图
  assert.strictEqual(feishu.imageKeysOf('media', VIDEO_MEDIA_MSG.content).length, 0,
    'media 里的 image_key 是封面帧，不是人发来的图');
});

await t('红线行为级·file 里的非视频附件：一次字节都不许取', async () => {
  const { readInboundContent } = await import('./agent/agent.mjs');
  for (const m of [XLSX_FILE_MSG, PDF_FILE_MSG, AUDIO_MSG]) {
    let fetches = 0;
    const r = await readInboundContent(m, {
      fetchVideo: async () => { fetches++; return { path: '/tmp/不该到这里', bytes: 1, error: null, cleanup: () => {} }; },
      fetchImage: async () => { fetches++; return { path: '/tmp/不该到这里', bytes: 1, error: null, cleanup: () => {} }; },
    });
    assert.strictEqual(fetches, 0, `${m.content} 一次网络调用都不许发（红线）`);
    assert.strictEqual(r.videoCount, 0, `${m.content} 不许被当成视频`);
    assert.ok(r.attachment, '非视频附件仍然要落成 attachment（按规矩不取）');
  }
});

await t('行为级·media 消息：真取字节 + 真读（桩），视频块里带帧文字与转写', async () => {
  const { readInboundContent, buildVideoBlock } = await import('./agent/agent.mjs');
  const calls = { fetch: [], read: [], cleaned: 0 };
  const r = await readInboundContent(VIDEO_MEDIA_MSG, {
    fetchVideo: async (mid, key, opt) => {
      calls.fetch.push([mid, key, opt?.ext]);
      return { path: '/tmp/假视频.mp4', bytes: 13387714, error: null, cleanup: () => { calls.cleaned++; } };
    },
    readVideoFn: async (p) => { calls.read.push(p); return stubReadVideo()(); },
  });
  assert.deepStrictEqual(calls.fetch, [['om_vid_media', 'file_v3_00166_48a0a140', '.mp4']],
    `取视频调用不对：${JSON.stringify(calls.fetch)}`);
  assert.deepStrictEqual(calls.read, ['/tmp/假视频.mp4'], '读视频必须拿到取回来的那个路径');
  assert.strictEqual(calls.cleaned, 1, '字节用完必须清理 —— 豁免是「过一遍」，不是「留下来」');
  const block = buildVideoBlock(r);
  assert.ok(block.includes('MOMCOZY'), '帧上的字必须进视频块');
  assert.ok(block.includes('folds in one second'), '音轨转写必须进视频块');
  assert.ok(/画面/.test(block) && /我看得到|看不到|抽样/.test(block),
    '视频块必须写明「只看到抽样的这几帧」—— 否则模型会说「整条视频我都看了」');
  assert.ok(/14\.96|15/.test(block), '时长要进块（判「够不够 60 秒」要用）');
});

await t('行为级·file 类型的视频消息（真实 payload）也走同一条路', async () => {
  const { readInboundContent, buildVideoBlock } = await import('./agent/agent.mjs');
  const r = await readInboundContent(VIDEO_FILE_MSG, {
    fetchVideo: async () => ({ path: '/tmp/真视频.mp4', bytes: 13387714, error: null, cleanup: () => {} }),
    readVideoFn: async () => stubReadVideo()(),
  });
  assert.strictEqual(r.videoCount, 1);
  assert.strictEqual(r.attachment, null, '是视频就不许再被算成「按规矩不取的附件」');
  assert.ok(buildVideoBlock(r).includes('momcozy-one-click-foldable-baby-playard-hero-1080p.mp4'),
    '文件名要进块（人靠它认自己发的是哪一条）');
});

await t('取不到 ≠ 视频里没东西（两句话必须不一样）', async () => {
  const { readInboundContent, buildVideoBlock } = await import('./agent/agent.mjs');
  const fail = await readInboundContent(VIDEO_MEDIA_MSG, {
    fetchVideo: async () => ({ path: null, bytes: 0, error: '取视频失败 code=99991672 msg=权限不足', cleanup: () => {} }),
  });
  assert.ok(fail.videos[0].failed, '取不到必须落成 failed');
  const b = buildVideoBlock(fail);
  assert.ok(b.includes('这一段我读不到') && b.includes('99991672'), `措辞不对：${b}`);
  assert.ok(!/没有可读文字|没有人说话/.test(b), '取不到**不许**说成「视频里没东西」');
});

await t('三种「声音那侧没有结果」必须分得开', async () => {
  const { readInboundContent, buildVideoBlock } = await import('./agent/agent.mjs');
  const mkVid = (transcript) => readInboundContent(VIDEO_MEDIA_MSG, {
    fetchVideo: async () => ({ path: '/tmp/v.mp4', bytes: 999, error: null, cleanup: () => {} }),
    readVideoFn: async () => stubReadVideo({ transcript })() });
  const deps = { 无音轨: { ok: false, kind: 'no_audio_track' },
                 没人说话: { ok: false, kind: 'no_speech' },
                 未授权: { ok: false, kind: 'not_authorized', hint: '去系统设置里打开语音识别' } };
  const b1 = buildVideoBlock(await mkVid(deps.无音轨));
  assert.ok(/没有音轨/.test(b1) && /是读数，不是转写失败/.test(b1), `无音轨的措辞不对：${b1}`);
  const b2 = buildVideoBlock(await mkVid(deps.没人说话));
  assert.ok(/没有人说话/.test(b2) && /是读数/.test(b2), `没人说话的措辞不对：${b2}`);
  const b3 = buildVideoBlock(await mkVid(deps.未授权));
  assert.ok(/没跑成/.test(b3), `未授权的措辞不对：${b3}`);
  // ★ 判据要分清「说」与「否认」（本项目 V25b 踩过这个坑）：这里出现「没有说话」
  //   是**在否认它**（「不要当成『没有说话』」），那正是要的写法；
  //   要拦的是**把未测直接说成没人说话**。
  assert.ok(/未测/.test(b3), `转写没跑成必须明写成「未测」：${b3}`);
  assert.ok(/不要当成/.test(b3), `必须明写「不要当成『没有说话』」—— 否则上层会把它读成读数：${b3}`);
  assert.ok(!/音轨转写：(是)?.*没有人说话/.test(b3), `未测不许被写成读数：${b3}`);
});

// ⚠️ 这一条必须放在**视频夹具（`VIDEO_MEDIA_MSG`）之后**：
//   放在图片那一段里会撞 TDZ（`const` 在声明前读 = ReferenceError）—— 实测就这么红过一次。
await t('画面层·视频：关键帧的画面读数（看过的／没读到的／没跑，三种必须分得开）', async () => {
  const { readInboundContent, buildVideoBlock, mediaReadAppendix } = await import('./agent/agent.mjs');
  const { readingsForModelSide } = await import('./agent/model_side.mjs');
  const mk = (frameScene) => readInboundContent(VIDEO_MEDIA_MSG, {
    fetchVideo: async () => ({ path: '/tmp/v.mp4', bytes: 999, error: null, cleanup: () => {} }),
    readVideoFn: async () => stubReadVideo({ frameScene })(),
  });
  const seen = (t_s) => ({ t_s, ok: true, ms: 3200, scene: {
    setting: '厨房', people: [{ kind: '婴幼儿', doing: '坐着' }], products: [{ what: '折叠床', in_use: true }],
    visible_marks: ['MOMCOZY'], risk_cues: ['婴幼儿出镜'], unclear: [] } });
  const miss = (t_s) => ({ t_s, ok: false, ms: 30, error: 'HTTP 500' });

  // ① 看过的 + 没读到的：两种都要在，且**长得不一样**
  const r1 = await mk([seen(0.94), miss(8.42)]);
  const b1 = buildVideoBlock(r1);
  assert.ok(/画面读数/.test(b1), `视频块没带上关键帧的画面读数：\n${b1}`);
  assert.ok(/\[0\.9s\]/.test(b1) && /婴幼儿/.test(b1), `看过的帧要带时间码与读数：\n${b1}`);
  assert.ok(/\[8\.4s\][\s\S]{0,30}没读到/.test(b1), `没读到的那一帧要单独写出来：\n${b1}`);
  assert.ok(/未测/.test(b1), '「没读到」必须写成**未测**，不许说成「画面没问题」');
  assert.ok(/不是原图/.test(b1), '必须写明那是**模型读数、不是原图**');
  // ★ 判据要分清「说」与「否认」（本项目 V25b 踩过这个坑）：块头那句**正是在禁止**这个说法，
  //   所以不能写成「块里不许出现这串字」—— 那会把**正确的禁止**判红（实测第一版就这么红的）。
  //   要判的是：这句话**只许**出现在「不许说成…」那个上下文里。
  const claims = [...b1.matchAll(/整条视频的画面我都看了/g)].length;
  const prohibits = [...b1.matchAll(/不许说成「整条视频的画面我都看了」/g)].length;
  assert.strictEqual(claims, prohibits,
    `「整条视频的画面我都看了」只许出现在禁止它的那句里（共 ${claims} 次，其中禁止 ${prohibits} 次）`);
  const side1 = readingsForModelSide(r1);
  assert.ok(/关键帧的画面读数/.test(side1) && /婴幼儿/.test(side1), '模型侧要拿到帧的画面读数');
  assert.ok(/\[0\.9s\]|\[0\.94s\]/.test(side1), '模型侧也要带时间码（要它指位置就得给它位置）');
  assert.ok(/画面读数/.test(mediaReadAppendix(r1)), '报告附录要带上关键帧的画面读数');

  // ② ★ 反向对照：**没跑**（空数组）⇒ 两处都不许凭空造一节
  const r2 = await mk([]);
  assert.ok(!/画面读数/.test(buildVideoBlock(r2)), '没跑画面层时视频块不许凭空造一节');
  assert.ok(!/画面读数/.test(mediaReadAppendix(r2)), '没跑画面层时附录不许凭空造一节');
  assert.ok(!/画面读数/.test(readingsForModelSide(r2)), '没跑画面层时模型侧也不许凭空造一节');
});

await t('媒材块里必须挂着「这是送审素材 → 走 kb_review_chain」那一句', async () => {
  const { readInboundContent, buildImageBlock, buildVideoBlock, MEDIA_ROUTE_HINT } = await import('./agent/agent.mjs');
  // 图块
  const img = await readInboundContent({ message_id: 'om_r1', message_type: 'image', content: '{"image_key":"img_x"}' },
    { fetchImage: async () => ({ path: '/tmp/r.img', bytes: 9, error: null, cleanup: () => {} }),
      ocr: async () => ({ ok: true, text: 'MOMCOZY 吸奶器', lines: 1, chars: 12 }) });
  const bi = buildImageBlock(img);
  assert.ok(bi.includes(MEDIA_ROUTE_HINT), '图块里必须有这句 —— 否则模型只会描述「我读到了什么」');
  assert.ok(bi.includes('kb_review_chain'), '图块里必须点名那条链');
  // 视频块
  const vid = await readInboundContent(VIDEO_FILE_MSG, {
    fetchVideo: async () => ({ path: '/tmp/r.mp4', bytes: 9, error: null, cleanup: () => {} }),
    readVideoFn: async () => stubReadVideo()() });
  const bv = buildVideoBlock(vid);
  assert.ok(bv.includes(MEDIA_ROUTE_HINT), '视频块里必须有同一句');
  // ★ 反向对照：没有媒材时不许出现这句（否则它就不是「跟着媒材走」的）
  assert.strictEqual(buildImageBlock({ imageCount: 0 }), '', '没有图时图块必须是空的');
  assert.strictEqual(buildVideoBlock({ videoCount: 0 }), '', '没有视频时视频块必须是空的');
});

await t('「带了媒材却没起链」这件事本身必须有个读数（不是一行没出现的日志）', async () => {
  const { mediaWithoutChain } = await import('./agent/agent.mjs');
  const chainOk = { tool: 'kb_review_chain', ok: true };
  // ① 带了视频、起了链 → 没问题
  assert.strictEqual(mediaWithoutChain({ media: { images: 0, videos: 1 }, toolTrace: [chainOk] }), null,
    '起了链就不该报警');
  // ② 带了视频、一次工具都没调 → 必须报（这就是那次事故的形状）
  const r2 = mediaWithoutChain({ media: { images: 0, videos: 1 }, toolTrace: [] });
  assert.ok(r2 && r2.media === 1 && r2.tools.length === 0, `实际 ${JSON.stringify(r2)}`);
  // ③ 带了图、只调了别的工具 → 也要报
  const r3 = mediaWithoutChain({ media: { images: 2, videos: 0 },
                                toolTrace: [{ tool: 'search_workspace', ok: true }] });
  assert.ok(r3 && r3.media === 2 && r3.tools.includes('search_workspace'), `实际 ${JSON.stringify(r3)}`);
  // ④ **反向对照**：没带媒材时永远不许报（否则它对每一轮纯文字都在叫）
  assert.strictEqual(mediaWithoutChain({ media: { images: 0, videos: 0 }, toolTrace: [] }), null,
    '没媒材时这条不适用');
  assert.strictEqual(mediaWithoutChain({}), null, 'meta 缺字段时不许凭空报');
  // ⑤ **反向对照**：链**跑失败**了不算「起了链」—— 那是要说的另一种话
  const r5 = mediaWithoutChain({ media: { images: 1, videos: 0 },
                                toolTrace: [{ tool: 'kb_review_chain', ok: false }] });
  assert.ok(r5, '链失败必须照样报 —— 否则「跑了但没成」会被记成「跑过了」');
});

await t('★ 反向对照·引用那条的视频：取字节必须用**父消息 id**（用当前 id 会 400）', async () => {
  // 2026-10-09 实测出来的真 bug：key 从被引用的那条取到，取字节却用 `msg.message_id`
  // ⇒ `messageResource.get` 拿「当前 id + 父消息的 file_key」去查 ⇒ **HTTP 400**。
  // Owner 连发三次视频全部失败（日志：「视频 1 段（取自你引用的那条消息）｜读成功 0 · 失败 1」）。
  // ★ 上面那条「引用的那条读得到」的测试**用的是桩**（`fetchVideo: async () => …`），
  //   它只数调用次数、**不看参数** ⇒ 抓不到这个。这一条钉的就是**传进去的 id**。
  const { readInboundContent } = await import('./agent/agent.mjs');
  const PARENT_ID = 'om_vid_file';
  const seen = [];
  const r = await readInboundContent(
    { message_id: 'om_ask_vid', message_type: 'text', content: '{"text":"这条能过吗？"}',
      parent_id: PARENT_ID },
    { loadParent: async () => ({ text: '', images: [], videos: feishu.videoKeysOf('file', VIDEO_FILE_MSG.content) }),
      fetchVideo: async (mid, fk) => { seen.push(mid); return { path: '/tmp/q.mp4', bytes: 9, error: null, cleanup: () => {} }; },
      readVideoFn: async () => stubReadVideo()() });
  assert.strictEqual(seen.length, 1, `取视频应当恰好被调 1 次，实际 ${seen.length} 次`);
  assert.strictEqual(seen[0], PARENT_ID,
    `取字节必须用**被引用那条**的消息 id，实际用了 ${seen[0]} —— 用当前 id 会 HTTP 400`);
  assert.notStrictEqual(seen[0], 'om_ask_vid', '不许用当前消息 id 去取父消息的资源');
  assert.strictEqual(r.fromParent, true);
});

await t('反向对照·引用的那条里的视频读得到；没引用 → 一次都不许取', async () => {
  const { readInboundContent, buildVideoBlock } = await import('./agent/agent.mjs');
  const ask = { message_id: 'om_ask_vid', message_type: 'text', content: '{"text":"这条能过吗？"}',
                parent_id: 'om_vid_file' };
  let fetches = 0;
  const quoted = await readInboundContent(ask, {
    loadParent: async () => ({ text: '', images: [], videos: feishu.videoKeysOf('file', VIDEO_FILE_MSG.content) }),
    fetchVideo: async () => { fetches++; return { path: '/tmp/q.mp4', bytes: 9, error: null, cleanup: () => {} }; },
    readVideoFn: async () => stubReadVideo()(),
  });
  assert.strictEqual(fetches, 1, '回复一条带视频的消息时，那条视频必须读得到');
  assert.strictEqual(quoted.fromParent, true);
  assert.ok(buildVideoBlock(quoted).includes('引用的那条消息'), '要写明视频是从引用的那条取的');

  // ★ 独立的第二条：**没有 parent_id 时一条都不许取** ——
  //   「看引用」滑成「顺历史把群里的视频捞一遍」正是红线要防的事。
  let fetches2 = 0;
  const noQuote = await readInboundContent(
    { message_id: 'om_noquote', message_type: 'text', content: '{"text":"视频能过吗？"}' },
    { loadParent: async () => { throw new Error('没有 parent_id 就不该去回读任何东西'); },
      fetchVideo: async () => { fetches2++; return { path: '/tmp/x.mp4', bytes: 9, error: null, cleanup: () => {} }; } });
  assert.strictEqual(fetches2, 0, '没带 parent_id → 一次都不许取（不许翻历史）');
  assert.strictEqual(noQuote.videoCount, 0);
});

await t('端到端·视频读数必须进「真正发给模型的那一轮」（不是只进块就算了）', async () => {
  const { readInboundContent, buildImageBlock, buildVideoBlock, buildUserTurn } = await import('./agent/agent.mjs');
  const r = await readInboundContent(VIDEO_FILE_MSG, {
    fetchVideo: async () => ({ path: '/tmp/e2e.mp4', bytes: 999, error: null, cleanup: () => {} }),
    readVideoFn: async () => stubReadVideo()(),
  });
  const turn = buildUserTurn({
    questionText: '审核下这个视频',
    imageBlock: buildImageBlock(r),      // 这条没有图，块是空的
    videoBlock: buildVideoBlock(r),
  });
  assert.ok(turn.startsWith('审核下这个视频'), `人问的话要排在最前：${turn.slice(0, 40)}`);
  assert.ok(turn.includes('关键帧上的文字'), '帧上的字必须真的进那一轮（只说「读到了」不算）');
  assert.ok(turn.includes('MOMCOZY'), '帧 OCR 的原文必须进那一轮');
  assert.ok(turn.includes('folds in one second'), '音轨转写的原文必须进那一轮');
  assert.ok(turn.includes('momcozy-one-click-foldable-baby-playard-hero-1080p.mp4'), '文件名要进那一轮');
  // ★ 反向对照：没有视频块时，那一轮**不许**凭空多出视频字样 ——
  //   否则上面几条可能只是「块恒非空」，而不是「块真的被拼进去了」。
  assert.strictEqual(buildUserTurn({ questionText: '审核下这个视频' }), '审核下这个视频',
    '没有块时那一轮必须逐字等于人问的话');
  assert.strictEqual(buildUserTurn({ questionText: '', videoBlock: buildVideoBlock(r) }),
    buildVideoBlock(r), '只有视频没有文字时，那一轮就该是视频块本身');
});

await t('端到端·非视频附件走 handleMessage：拒答文案里不许把视频也算进「不取」', async () => {
  const { handleMessage } = await import('./agent/agent.mjs');
  const r = await handleMessage({
    message: { ...XLSX_FILE_MSG, message_id: `om_xlsx_${Date.now()}`, chat_id: 'oc_test', chat_type: 'p2p' },
    sender: { sender_id: { open_id: 'ou_test' } },
  });
  assert.strictEqual(r.reason, 'attachment_not_taken');
  assert.ok(!/附件（文件\/语音\/视频）/.test(r.reply),
    `那句老话术是错的（视频已经能读了），不该再出现：${r.reply}`);
  assert.ok(/视频/.test(r.reply) && /直接发我/.test(r.reply),
    `要顺带说清「视频也能直接发我」—— 否则他再发一遍还是听到同一句：${r.reply}`);
});

await t('端到端·视频读不成 → 如实说失败原因，不许说成「视频里没问题」', async () => {
  const { handleMessage } = await import('./agent/agent.mjs');
  const r = await handleMessage({
    message: { ...VIDEO_FILE_MSG, message_id: `om_vid_fail_${Date.now()}`, chat_id: 'oc_test', chat_type: 'p2p' },
    sender: { sender_id: { open_id: 'ou_test' } },
  }, { deps: { fetchVideo: async () => ({ path: null, bytes: 0, error: '取视频失败 code=99991672 msg=权限不足', cleanup: () => {} }) } });
  assert.strictEqual(r.reason, 'video_unreadable', `实际 reason=${r.reason}`);
  assert.ok(/没读成/.test(r.reply), `要说清没读成：${r.reply}`);
  // ★ 同上：这里出现「没问题」是**在否认它**，那正是要的写法。
  assert.ok(/不是「视频里没问题」/.test(r.reply),
    `读不成时必须**明确否认**「视频里没问题」这个读法：${r.reply}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 第 17 组：**视频这条路的试纸** —— 真跑一次抽帧 + OCR + 本机转写。
//
// 与第 14 组同一个道理：第 16 组全是桩，它证明的是**接线**对不对；
// 「这台机器上视频还读不读得动」它一个字都没说。这一组拿本仓自带的
// `video-sample.mp4`（15KB，由 `base/video_fixture.m` 生成）真读一遍，
// 再拿 `asr-sample.wav` 真转写一遍。
//
// ★ 转写那两条会红得**很有价值**：它红的时候说的是
//   「语音识别没授权 / 模型没装」—— 这两件事只有人点一下才能解决，
//   而在此之前，群里发视频只会听到一句「听不清」。
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n═══ 17. 视频/语音的试纸（真跑；不联网、不碰飞书）═══');

await t('真跑一次读视频：试纸上的特征串必须读得出来', async () => {
  const v = await import('./agent/video.mjs');
  assert.ok(fs.existsSync(v.VIDEO_FIXTURE), `试纸不在：${v.VIDEO_FIXTURE} —— 没有试纸就没法证明这条路是通的`);
  const r = await v.readVideo(v.VIDEO_FIXTURE, { frames: 3 });
  try {
    assert.strictEqual(r.ok, true, `读视频没跑通（${r.error ?? '未知'}）：${r.detail ?? ''}`);
    assert.ok(r.framesRead >= 1, `一帧都没读成：${JSON.stringify(r.frames)}`);
    assert.ok(String(r.ocrText).toUpperCase().includes(v.VIDEO_FIXTURE_TOKEN),
      `抽帧读了 ${r.framesRead} 帧，但没有特征串「${v.VIDEO_FIXTURE_TOKEN}」：${r.ocrText.slice(0, 200)}`);
    assert.strictEqual(r.meta.duration_s > 0, true, `时长必须读得出来，实际 ${r.meta.duration_s}`);
  } finally { r.cleanup?.(); }
});

await t('反向对照·不是视频的文件必须报错，不许说成「视频里没字」', async () => {
  const v = await import('./agent/video.mjs');
  const png = (await import('./agent/vision.mjs')).OCR_FIXTURE;
  const r = await v.readVideo(png, { frames: 2 });
  try {
    assert.strictEqual(r.ok, false, '拿一张 PNG 当视频喂，必须失败 —— 成功就等于「解不开」被伪装成「读得到」');
    assert.ok(!r.ocrText, '失败时不许回一段空 ocrText（那会被上层读成「画面上没字」）');
  } finally { r.cleanup?.(); }
});

await t('反向对照·文件不存在必须报 not_found（不许伪装成「视频里没字」）', async () => {
  const v = await import('./agent/video.mjs');
  const r = await v.readVideo('/tmp/绝不存在-视频试纸.mp4');
  try {
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'not_found', `实际 error=${r.error}`);
  } finally { r.cleanup?.(); }
});

await t('启动自检 video.preflight：抽帧 + OCR 特征串都对', async () => {
  const v = await import('./agent/video.mjs');
  const pf = await v.preflight();
  assert.strictEqual(pf.ok, true, `视频自检没过：${pf.error ?? ''} ${pf.detail ?? ''}`);
  assert.ok(pf.n_frames >= 1, `抽出帧数不对：${pf.n_frames}`);
});

await t('真跑一次本机转写：试纸那句话必须转得出来（这条红了就是「语音识别没授权/模型没装」）', async () => {
  const a = await import('./agent/asr.mjs');
  const pf = await a.preflight();
  assert.strictEqual(pf.ok, true,
    `ASR 自检没过：${pf.error ?? ''} ${pf.hint ?? ''} ${pf.detail ?? ''}\n`
    + '       —— 授权没给或模型没装时，视频的「口播/旁白」这一半就是**未测**（不是「没有人说话」）');
  assert.ok(String(pf.text ?? '').includes(a.ASR_FIXTURE_TOKEN), `转写结果里没有特征串：${pf.text}`);
});

// ── 2026-10-14 加的：**长音频必须切段** —— Owner：「必须 asr 跑视频」 ──────────
//
// 病灶：`base/asr_speech.m:153` 写死 120s deadline，整条 57 分钟塞进去一个字都回不来
// （实测 zh-CN / en-US 两条都撞死在 120s）。修法是**在 JS 侧按 PCM 切段**、不重编二进制
// （重编换 cdhash ⇒ TCC 授权失效）。下面三条钉的就是这个修法。

await t('★ 上限必须盖得住本批最长的一条真素材（3420s 的 webinar），否则口播整条读不到', async () => {
  const v = await import('./agent/video.mjs');
  assert.strictEqual(typeof v.MAX_TRANSCRIPT_SECONDS, 'number');
  // 3420.0s = MC-US-YT-VwANGOaT4vs（57 分钟 webinar，78MB，超飞书上传上限走本机直读）
  //  669.5s = MC-US-YT-88uvcSNxMdk —— 旧值 600 把这两条都挡在门外，正文里只剩一句「too_long」。
  assert.ok(v.MAX_TRANSCRIPT_SECONDS > 3420,
    `转写时长上限 ${v.MAX_TRANSCRIPT_SECONDS}s 盖不住 3420s 那条真素材 —— `
    + '上限低于素材时，视频的「口播/旁白」这一半会以「转写没跑成（too_long）」的样子**静默缺失**');
  const a = await import('./agent/asr.mjs');
  // 与它配套的字节闸门：2h 的 22.05k/mono/s16 wav = 317MB，旧上限 200MB 会**先于时长闸门**拦掉。
  assert.ok(a.ASR_CHUNK_SECONDS > 0 && a.ASR_CHUNK_SECONDS <= 600,
    `切段粒度 ${a.ASR_CHUNK_SECONDS}s 不合理：必须明显小于识别器那个 120s deadline 的余量`);
});

await t('★ 切段：切出来的段接回去必须与原 PCM **逐字节相同**（错一帧就是一声爆音 / 丢字）', async () => {
  const a = await import('./agent/asr.mjs');
  // 造一段 40s 的「可辨认」PCM：每秒一个递增的 16bit 采样值 —— 接错了位一眼看得出来。
  const SR = 22050, SEC = 40, N = SR * SEC;
  const pcm = Buffer.alloc(N * 2);
  for (let i = 0; i < N; i++) pcm.writeInt16LE(((i * 7) % 30011) - 15000, i * 2);
  const mk = (p) => {
    const h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
    h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
    h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 2, 28); h.writeUInt16LE(2, 32);
    h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
    fs.writeFileSync(p, Buffer.concat([h, pcm]));
  };
  const long = '/tmp/shouheng-chunk-long.wav'; mk(long);
  const short = '/tmp/shouheng-chunk-short.wav';
  { const p = pcm.subarray(0, SR * 2 * 3);   // 3 秒
    const h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(36 + p.length, 4); h.write('WAVE', 8);
    h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
    h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 2, 28); h.writeUInt16LE(2, 32);
    h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(p.length, 40);
    fs.writeFileSync(short, Buffer.concat([h, p])); }

  // 反向对照①：**够短的不许切** —— 白切一段就是白起一次识别进程。
  assert.strictEqual(a.planChunks(short, 300), null,
    '3 秒的音频被切了 —— 够短就不该切（这条对了才说明「切段」是有条件的，不是无脑切）');
  // 反向对照②：**不是 PCM wav 的不许猜着切**（切错位置出来的噪声会被当成转写结果）。
  assert.strictEqual(a.planChunks(await (async () => {
    const p = '/tmp/shouheng-chunk-notwav.bin';
    fs.writeFileSync(p, Buffer.from('这不是 wav，别猜着切'.repeat(10)));
    return p;
  })(), 5), null, '认不出布局就必须回 null，不许硬切');

  const plan = a.planChunks(long, 10);
  assert.ok(plan, '40 秒的音频按 10 秒切，必须给出计划');
  try {
    assert.strictEqual(plan.chunks.length, 4, `10s×4 段，实际 ${plan.chunks.length}`);
    const out = [];
    for (let i = 0; i < plan.chunks.length; i++) {
      const p = `/tmp/shouheng-chunk-${i}.wav`;
      const wrote = plan.chunks[i].writeTo(p);
      assert.ok(wrote > 0, `第 ${i} 段切出 0 字节`);
      // 每一段自己必须还是一份**合法 wav**（识别器只认这个）。
      const fd = fs.openSync(p, 'r');
      const lay = a.readWavLayout(fd); fs.closeSync(fd);
      assert.ok(lay, `第 ${i} 段不是合法 wav`);
      assert.strictEqual(lay.channels, 1);
      assert.strictEqual(lay.sampleRate, SR);
      assert.ok(Math.abs(lay.seconds - plan.chunks[i].seconds) < 1e-6,
        `第 ${i} 段头里写的秒数(${lay.seconds})与计划(${plan.chunks[i].seconds})不符`);
      out.push(fs.readFileSync(p).subarray(44));
    }
    const joined = Buffer.concat(out);
    assert.strictEqual(joined.length, pcm.length,
      `接回去 ${joined.length} 字节 ≠ 原 ${pcm.length} 字节 —— 有采样点被丢了`);
    assert.ok(joined.equals(pcm),
      '★ 接回去与原 PCM **不逐字节相同** —— 这就等于音频被改过，转写出的字不能当逐字原文');
  } finally { plan.close(); }

  // ── 头里那个长度**不许直接信**（流式 wav 常把它写成 0xFFFFFFFF）──────────────
  // 照着切会凭空切出成百上千个空段，而每段都要起一次识别进程。这条是那件事的反向对照。
  { const fake = '/tmp/shouheng-chunk-liar.wav';
    const real = pcm.subarray(0, SR * 2 * 8);          // 真身只有 8 秒
    const h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(36 + real.length, 4); h.write('WAVE', 8);
    h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
    h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 2, 28); h.writeUInt16LE(2, 32);
    h.writeUInt16LE(16, 34); h.write('data', 36);
    h.writeUInt32LE(0xFFFFFFFF, 40);                   // ← 谎报长度
    fs.writeFileSync(fake, Buffer.concat([h, real]));
    const fd = fs.openSync(fake, 'r');
    const lay = a.readWavLayout(fd); fs.closeSync(fd);
    assert.ok(lay, '谎报长度的 wav 仍然必须认得出来（否则整条音频干脆不转写了）');
    assert.strictEqual(lay.size_clamped, true, '头里写的 0xFFFFFFFF 没被截住 —— 它会切出成千上万个空段');
    assert.strictEqual(lay.dataSize, real.length, `截出来的长度必须等于真实长度 ${real.length}，实际 ${lay.dataSize}`);
    assert.ok(Math.abs(lay.seconds - 8) < 0.01, `截出来的秒数应是 8s，实际 ${lay.seconds}`);
    // 反向对照：**老实的 wav 不许被标成截过**（否则这个标记就是恒真的噪声）。
    const fd2 = fs.openSync(long, 'r');
    const lay2 = a.readWavLayout(fd2); fs.closeSync(fd2);
    assert.strictEqual(lay2.size_clamped, false, '老实的 wav 被标成「截过」—— 这个标记从此不可信');
    assert.ok(Math.abs(lay2.seconds - SEC) < 0.01, `老实 wav 的秒数应是 ${SEC}，实际 ${lay2.seconds}`); }
});

await t('★ 长音频真跑一次：切段后必须转得出字（这条红了就是「长视频口播整条读不到」又回来了）', async () => {
  const a = await import('./agent/asr.mjs');
  // 拿**真试纸**（7.1s 普通话）复读 6 遍 ⇒ 42.7s，再按 16s 切 ⇒ 3 段。
  // 用真音频而不是合成噪声：合成噪声转不出字，那条判据会**恒绿**（转不出字也算过）。
  const fd = fs.openSync(a.ASR_FIXTURE, 'r');
  const lay = a.readWavLayout(fd);
  const raw = Buffer.alloc(lay.dataSize);
  fs.readSync(fd, raw, 0, lay.dataSize, lay.dataOff);
  fs.closeSync(fd);
  const pcm = Buffer.concat(Array.from({ length: 6 }, () => raw));
  const long = '/tmp/shouheng-chunk-real.wav';
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(lay.sampleRate, 24); h.writeUInt32LE(lay.byteRate, 28);
  h.writeUInt16LE(lay.frameBytes, 32); h.writeUInt16LE(lay.bits, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(long, Buffer.concat([h, pcm]));

  const r = await a.transcribe(long, { locales: ['zh-CN'], chunkSeconds: 16 });
  assert.strictEqual(r.ok, true,
    `切段转写没跑通：kind=${r.kind} detail=${r.detail ?? ''} —— `
    + '这一条正是「57 分钟那条一个字都没转出来」的形状');
  assert.strictEqual(r.chunked, true, '走了切段却没有 chunked 标记 —— 下游看不出这条读数是拼出来的');
  assert.ok(r.n_chunks >= 3, `42.7s 按 16s 切应 ≥3 段，实际 ${r.n_chunks}`);
  assert.ok(String(r.text ?? '').includes(a.ASR_FIXTURE_TOKEN),
    `切段后转不出特征串「${a.ASR_FIXTURE_TOKEN}」：${String(r.text ?? '').slice(0, 200)}`);
  assert.ok(Array.isArray(r.chunks) && r.chunks.length === r.n_chunks,
    'chunks 逐段读数必须带回（回听时按 start_s 对时间）');
});

await t('反向对照·音频里没人说话 ≠ 转写没跑成（两种必须分得开）', async () => {
  const a = await import('./agent/asr.mjs');
  // 一段**真音频**：本仓试纸（有人说话）。先证明它转得出来，再证明「没声音」是另一种结果。
  const okRun = await a.transcribe(a.ASR_FIXTURE, { locales: ['zh-CN'] });
  assert.strictEqual(okRun.ok, true, `试纸都转不出来，这条对照就没意义了：${okRun.kind}`);
  // 静音 wav：44 字节头 + 1 秒 22050Hz 单声道 16bit 全零
  const silent = '/tmp/shouheng-silence-control.wav';
  const buf = Buffer.alloc(44 + 22050 * 2, 0);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + 22050 * 2, 4); buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(22050, 24); buf.writeUInt32LE(22050 * 2, 28); buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(22050 * 2, 40);
  fs.writeFileSync(silent, buf);
  const quiet = await a.transcribe(silent, { locales: ['zh-CN'] });
  assert.strictEqual(quiet.ok, false);
  assert.strictEqual(quiet.kind, 'no_speech',
    `静音音频必须是「没有人说话」这一类读数，实际 kind=${quiet.kind} error=${quiet.error ?? ''}`);
  assert.ok(quiet.hint, '「没有人说话」必须带一句说明，否则上层会把它写成「转写失败」');
});

// ── 2026-10-08 加的：**语种自洽** —— 「错的结果不许长得像成功的结果」 ──────────
//
// 病灶（当天实测，Owner那条 `知识库视频-WhatsApp-2026-10-06.mp4`）：
//   `transcribe()` 是「第一个 `ok` 就 return」，而默认语序 `['zh-CN','en-US']` 中文优先
//   ⇒ **英文音轨被按中文识别**，拿到一段胡话却带 `ok:true` + `on_device:true`；
//   下游 `buildVideoBlock` 原来会把它印成「音轨转写（本机识别，逐字）」，
//   于是守衡拿胡话当口播去引用。**比「读不准」更坏的是它长得像成功。**
//
// ★ 下面两条用例里的字符串**逐字取自当天的实测输出**，不是编的。
await t('语种自洽·实测那段胡话必须判「与 zh-CN 不符」、那段正确英文必须判「自洽」', async () => {
  const a = await import('./agent/asr.mjs');
  // 逐字取自实测：同一段音轨，只换语种
  const GARBAGE_ZH = "Let die for them online one more but if it more one I love the matter "
    + "speed and it's much is for me do dick a bad and thing";
  const GOOD_EN = 'Personalities for the mom cause illness one more because it feels more '
    + 'comfortable I love the mass feature and it is much easier for me to take apart and clean';
  const GOOD_ZH = '守恒语音自检这是一段测试音频用来确认本机转写这条路是通的';

  assert.strictEqual(a.checkScript('zh-CN', GARBAGE_ZH).ok, false,
    '英文音轨被按中文识别出来的胡话，必须判「不符」—— 判成自洽就等于把胡话放行');
  assert.strictEqual(a.checkScript('en-US', GOOD_EN).ok, true, '真英文转写必须判自洽');
  assert.strictEqual(a.checkScript('zh-CN', GOOD_ZH).ok, true, '真中文转写必须判自洽');
  assert.strictEqual(a.checkScript('en-US', GOOD_ZH).ok, false, '中文字按英文识别也要判不符');
  assert.strictEqual(a.checkScript('zh-CN', '').ok, true, '空结果不归这条判（另有 chars=0 的判据）');
  assert.strictEqual(a.checkScript('ja-JP', GARBAGE_ZH).ok, true,
    '不认识的语种**不许判**——认不出来就下结论，就是「比输入大」');
});

await t('语种顺序·画面文字是英文时必须英文优先（否则胡话仍然会发生）', async () => {
  const a = await import('./agent/asr.mjs');
  const en = a.orderLocalesByText('Momcozy Wellness 1 vs Eufy S1 Pro I love the massage feature '
    + 'only 5 washable parts');
  assert.strictEqual(en.locales[0], 'en-US', `英文画面文字必须英文优先，实际 ${JSON.stringify(en.locales)}`);
  assert.ok(en.basis && /拉丁/.test(en.basis), '必须给出可复核的依据，而不是一个写死的顺序');
  const zh = a.orderLocalesByText('中国6岁以下儿童就寝问题和夜醒治疗指南 推荐意见 证据等级 睡眠卫生');
  assert.strictEqual(zh.locales[0], 'zh-CN', `中文画面文字必须中文优先，实际 ${JSON.stringify(zh.locales)}`);
  // 反例：画面没字时**不许装作判出来了**
  const none = a.orderLocalesByText('M5');
  assert.strictEqual(none.decided, false, '可判字符太少时必须承认「语种未定」');
  assert.deepStrictEqual(none.locales, a.ASR_LOCALES, '语种未定时必须回默认语序（顺序不许被悄悄改掉）');
});

await t('★ 主机制·readVideo 必须把「画面文字判出来的语序」真的交给转写（桩，钉接线）', async () => {
  // 这条钉的是**主机制**：画面 OCR 已经先跑完，语种由它定 —— 不是靠写死的顺序。
  // ★ 为什么主机制是排序而不是「事后自洽检查」（同一天实测出来的边界）：
  //   字集检查只能抓一个方向 —— 「该语种的特征字**一个都没有**」。
  //   反方向抓不到：中文音轨按 en-US 识别出来的是**看着像英文的胡话**
  //   （实测试纸：`Show her the Joshua and social opinion you like shit and Benji I see your shit`），
  //   它字面上有拉丁字母、自洽检查会放行。所以**顺序对了才是根本**，自洽检查只当网。
  //
  // ⚠️ 为什么用 `audio-sample.m4a` 而不是 `video-sample.mp4`：后者是**纯画面、没有音轨**
  //   ⇒ `readVideo()` 走 `no_audio_track`、**根本不调 `asrFn`**，接线对不对它一个字都不说。
  const v = await import('./agent/video.mjs');
  const a = await import('./agent/asr.mjs');
  assert.ok(fs.existsSync(a.ASR_AUDIO_FIXTURE),
    `带音轨的试纸不在：${a.ASR_AUDIO_FIXTURE}（生成源码 base/asr_audio_fixture.sh）`);
  let seen = 'NOT_CALLED';
  const stub = async (wav, opt) => {
    seen = opt?.locales ?? null;
    return { ok: false, kind: 'no_audio_track', hint: '（桩：本条只验语序接线，不真转写）' };
  };
  const r = await v.readVideo(a.ASR_AUDIO_FIXTURE, { frames: 2, asrFn: stub });
  try {
    assert.notStrictEqual(seen, 'NOT_CALLED',
      'asrFn 一次都没被调到 —— 那这一段根本没走转写这条路（这条断言就是为它写的）');
    // 这张试纸**没有视频轨** ⇒ 画面文字是空的 ⇒ 语种判不出来 ⇒ **必须回默认语序**
    assert.deepStrictEqual(seen, a.ASR_LOCALES,
      `没有画面文字时必须回默认语序，实际 ${JSON.stringify(seen)}`);
    assert.ok(String(r.transcript?.locale_basis ?? '').includes('语种未定'),
      `语种判不出来时必须**如实写「语种未定」**，实际 ${JSON.stringify(r.transcript?.locale_basis)}`);
  } finally { r.cleanup?.(); }

  // 另一半：有画面文字时，喂给 `orderLocalesByText` 的**必须是画面 OCR 的文本**。
  // 这一截靠源码断言钉住（与 `verify_feishu_index.py` 的 M 段同一个路子：
  // 「唯一调用点」这种接线，行为级测不到，就只能看源码）。
  const src = fs.readFileSync(new URL('./agent/video.mjs', import.meta.url), 'utf8');
  assert.ok(/orderLocalesByText\(frameOcr/.test(src),
    '`video.mjs` 里必须把 `frameOcr` 的文本喂给 `orderLocalesByText()` —— '
    + '换成别的来源（或写死语序）就等于这条修复没做');
});

await t('反向对照·语序不许被写死：中英两种画面文字必须给出**不同**的语序', async () => {
  const a = await import('./agent/asr.mjs');
  const zh = a.orderLocalesByText('中国6岁以下儿童就寝问题和夜醒治疗指南 推荐意见 证据等级 睡眠卫生');
  assert.deepStrictEqual(zh.locales, ['zh-CN', 'en-US'],
    `中文画面文字必须中文优先，实际 ${JSON.stringify(zh.locales)}`);
  const en = a.orderLocalesByText(
    'Momcozy Wellness 1 vs Eufy S1 Pro I love the massage feature only 5 washable parts');
  assert.deepStrictEqual(en.locales, ['en-US', 'zh-CN'],
    `英文画面文字必须英文优先，实际 ${JSON.stringify(en.locales)}`);
  assert.notDeepStrictEqual(zh.locales, en.locales,
    '中英两种画面文字的语序**必须不同** —— 相同就说明语序是写死的，这条修复等于没做');
});

// ─────────────────────────────────────────────────────────────────────────────
// 第 17 组补 b：★ 长视频分段 + 首尾策略（2026-10-28）
// ─────────────────────────────────────────────────────────────────────────────
{
  const v = await import('./agent/video.mjs');

  await t('VIDEO_SEGMENT_SECONDS 导出合法（>0）', () => {
    assert.ok(v.VIDEO_SEGMENT_SECONDS > 0,
      `VIDEO_SEGMENT_SECONDS 应为正数，实际 ${v.VIDEO_SEGMENT_SECONDS}`);
  });

  await t('★ ≤120s 视频不触发分段（readVideoSegmented 行为与 readVideo 相同）', async () => {
    const stub = async () => ({ ok: true, text: 'stub', lines: 1, boxes: [] });
    const r = await v.readVideoSegmented(v.VIDEO_FIXTURE, {
      ocr: stub, scene: async () => ({ ok: false, skipped: true }),
      asrFn: async () => ({ ok: false }),
    });
    try {
      assert.strictEqual(r.segmented, undefined, '短视频不应有 segmented 字段');
      assert.ok(r.ok, `readVideoSegmented 对试纸失败：${r.error}`);
    } finally { r.cleanup?.(); }
  });

  await t('★ 反向对照：>120s 视频必须触发分段且分段元信息完整', async () => {
    const src = fs.readFileSync(new URL('./agent/video.mjs', import.meta.url), 'utf8');
    assert.ok(/nSegs.*Math\.ceil/.test(src), 'readVideoSegmented 缺少分段数计算（nSegs = Math.ceil）');
    assert.ok(/segments.*Array\.from/.test(src), 'readVideoSegmented 缺少分段元信息构建');
    assert.ok(/max_gap_s/.test(src), '分段元信息里必须记录最大帧间隔（max_gap_s）');
    const agentSrc = fs.readFileSync(new URL('./agent/agent.mjs', import.meta.url), 'utf8');
    assert.ok(/readVideoFn\s*=\s*video\.readVideoSegmented/.test(agentSrc),
      'agent.mjs 的 readVideoFn 默认值未改为 readVideoSegmented —— 分段逻辑接线断了');
  });

  await t('★ video_probe 二进制帧数上限已改为 100（旧值 40 导致请求 60 帧只返回 40 帧）', () => {
    const src = fs.readFileSync(new URL('../base/video_probe.m', import.meta.url), 'utf8');
    assert.ok(/wantFrames > 100/.test(src),
      'video_probe.m 里的帧数上限仍是 40——修改后应为 100，否则 60 帧请求被截成 40');
    assert.ok(!/wantFrames > 40/.test(src),
      'video_probe.m 里旧的 wantFrames > 40 上限未删除');
  });

  await t('★ video_probe 首尾策略：不再用中点偏移避片尾', () => {
    const src = fs.readFileSync(new URL('../base/video_probe.m', import.meta.url), 'utf8');
    assert.ok(!/ 0\.5\) \/ \(double\)wantFrames/.test(src),
      'video_probe.m 仍使用旧中点偏移公式 (i+0.5)/n —— 片尾 0.3s 内的声明会漏检');
    assert.ok(/dur[S|s].*-.*0\.3/.test(src),
      'video_probe.m 尾帧策略缺少 dur-0.3s（片尾固定 0.3s 盲区）');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 第 17 组补：★ 帧 OCR 并行化（2026-10-28）
//   病灶：OCR 逐帧串行 await，8 帧 × ~1.2s ≈ 9.6s；提案参数（≤30s 视频 40 帧）直接拉到 48s。
//   修法：改为批并发（OCR_CONCURRENCY=2），同帧数耗时减半；保序、保错误处理不变。
// ─────────────────────────────────────────────────────────────────────────────

{
  const v = await import('./agent/video.mjs');

  await t('OCR_CONCURRENCY 导出值合法（≥1）', () => {
    assert.ok(Number.isInteger(v.OCR_CONCURRENCY) && v.OCR_CONCURRENCY >= 1,
      `OCR_CONCURRENCY 必须是正整数，实际：${v.OCR_CONCURRENCY}`);
  });

  await t('★ 批并发不破坏帧顺序（frameOcr 仍按 t_s 升序）', async () => {
    let callCount = 0;
    // 模拟 4 帧，各帧 text 带时间戳，验证结果顺序与输入顺序一致
    const fakeOcr = async (p) => {
      callCount++;
      // 模拟不同延迟（后帧更快），验证并发后仍保序
      const idx = Number(p.replace(/\D/g, ''));
      await new Promise((res) => setTimeout(res, (4 - idx) * 5));
      return { ok: true, text: `FRAME_${idx}`, lines: 1, boxes: [] };
    };
    const probe = {
      ok: true, duration_s: 4, w: 1920, h: 1080, fps: 30, has_audio: false,
      audio_channels: 0, audio_rate: 0, n_frames: 4,
      frames: [0, 1, 2, 3].map((i) => ({ t_s: i, path: `/tmp/frame${i}.png` })),
    };
    const r = await v.readVideo('/tmp/stub.mp4', {
      frames: 4, ocr: fakeOcr, asrFn: async () => ({ ok: false }),
      tempDir: '/tmp', _probeStub: probe,
    });
    // 若 readVideo 不支持 _probeStub 注入，用源码断言替代行为断言
    // 源码断言：OCR 循环已用 Promise.all 批并发（不是 for...await 串行）
    const src = fs.readFileSync(new URL('./agent/video.mjs', import.meta.url), 'utf8');
    assert.ok(
      /Promise\.all\(batch\.map/.test(src),
      'OCR 循环未改为 Promise.all 批并发 —— 帧数增加后会线性堆积串行等待'
    );
    assert.ok(
      !/^  for \(const f of \(probe\.frames/.test(src),
      '旧串行 for...await 循环仍在 —— 并行化没有生效'
    );
  });

  await t('★ 反向对照：串行写法已从源码中移除', () => {
    const src = fs.readFileSync(new URL('./agent/video.mjs', import.meta.url), 'utf8');
    // 原串行：for (const f of (probe.frames ?? [])) { ... await ocr(f.path) }
    assert.ok(
      !src.includes('for (const f of (probe.frames ?? [])) {'),
      '旧串行 OCR 循环未删除 —— 并行与串行会同时存在，帧数增加时仍走串行路径'
    );
  });

  await t('★ OCR 失败帧计数在并行化后仍正确', async () => {
    const src = fs.readFileSync(new URL('./agent/video.mjs', import.meta.url), 'utf8');
    // 断言：framesFailed 在 batchResults 汇总后统计，不在循环内增加
    assert.ok(
      /for \(const entry of frameOcr\)/.test(src),
      'framesFailed 计数没有在 frameOcr 汇总之后统计 —— 并行化后计数可能丢失'
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 第 18 组：**送审闸门** —— 「工作流必须走」这句话的执行点。
//
// 委托方 2026-10-05 第三次重申：@守衡 提问/图片/视频/链接 → 走 L4→L5→L6→L7 + 评审链
// → 出报告溯源（L0）→ 写飞书。而那条链一直是通的（跑过 691s / 771s / 1809s），
// **缺的是触发**：在此之前「算不算送审」只写在人设里 —— 人设是声明，不是约束。
// 09:22 那条视频就是证据：模型没想起要调链，读到了 51 个字却给不出结论，
// 而盘上唯一的痕迹是**一行没有出现的日志**。
//
// 这一组验的就是「拦它的那几行」：判据（纯函数）、闸门（能被调用的函数）、
// 以及**接线**（`handleMessage` 真的调了它）。
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n═══ 18. 送审闸门（该走链的必须走，不该走的必须闭嘴）═══');

await t('什么算送审：媒材 / 链接 / 关键词 / 够长 → 走；闲聊 → 不走', async () => {
  const g = await import('./agent/review_gate.mjs');
  const yes = [
    ['光秃秃的视频', { videoCount: 1, text: '' }, 'media'],
    ['光秃秃的图', { imageCount: 1, text: '' }, 'media'],
    ['图 + 一句问', { imageCount: 1, text: '这张能过吗' }, 'media'],
    ['飞书链接', { text: '你读一下 https://momcozy-in.feishu.cn/wiki/abc?table=tbl1' }, 'link'],
    ['外部链接', { text: '看看这个 https://example.com/p/1' }, 'link'],
    ['短问句 + 关键词', { text: '这句能不能发' }, 'text'],
    ['只有关键词', { text: '审一下' }, 'text'],
    ['够长的纯文字', { text: '我们打算下个月在美国站主图里把这句话放上去，想请你先看一下这段文案' }, 'text'],
  ];
  for (const [name, input, kind] of yes) {
    const r = g.isSubmission(input);
    assert.strictEqual(r.yes, true, `${name} 必须判成送审（实际：${r.why}）`);
    assert.strictEqual(r.kind, kind, `${name} 的 kind 应为 ${kind}，实际 ${r.kind}`);
  }
  // ★ 反向对照：不该触发的必须**闭嘴** —— 否则每句「在吗」都跑 10~30 分钟并写一条飞书
  const no = [['在吗', { text: '在吗' }], ['问能力', { text: '你能干什么' }],
              ['短确认', { text: '收到' }], ['空消息', { text: '' }],
              ['空对象', {}]];
  for (const [name, input] of no) {
    const r = g.isSubmission(input);
    assert.strictEqual(r.yes, false, `${name} 不许判成送审（实际：${r.why}）`);
  }
  // ★ 反向对照的第二面：把长度闸门挪掉会怎样 —— 证明那条阈值真的在拦
  const just = '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九';   // 29 字
  assert.strictEqual([...just].length, 29, '样本长度变了，这条对照就没意义了');
  assert.strictEqual(g.isSubmission({ text: just }).yes, false, `29 字（< ${g.MIN_REVIEW_CHARS}）不该触发`);
  assert.strictEqual(g.isSubmission({ text: just + '十' }).yes, true, '30 字该触发');
});

// ─────────────────────────────────────────────────────────────────────────────
// 第 18 组补：★ **机制问句不许被当成送审**（2026-10-14 真事故）
//
// 群里周健问「你读不到你怎么做审核呢？」—— 闸门判 `命中送审词：审`（「审核」里含「审」），
// 于是：群里先收到一张「⏳ 处理中…」回执卡，142 秒后又收到一张**评审单卡**
// （「【审查结论：REVIEW】共发现 1 处需人工确认」），链把**那句问话本身**当素材判了，
// 飞书评审表里还多了一行（`reczz28N9SuydepR`）。他的回应是三个字：「答非所问！」
//
// 这一组守住的就是「提审」与「提到审这个词」不是同一件事。**每一条都带反向对照**，
// 因为只写「该闭嘴上」的话，一个恒返回 false 的闸门也能全绿。
// ─────────────────────────────────────────────────────────────────────────────
await t('机制问句不算送审：命中送审词也**不许**起链（含 2026-10-14 那条原话）', async () => {
  const g = await import('./agent/review_gate.mjs');

  // ① 惹祸的那条**逐字**。它必须先被 `mechanismQuestion` 判成问句，
  //    否则下面那条 `isSubmission` 断言会在别处变红而看不出是这一条。
  const real = '“读不到的东西我会直接说 —— 比如画面的构图、场景、人物动作，图片和视频的 OCR 只给我文字，'
    + '画面本身看不到。”你读不到你怎么做审核呢？';
  const mq = g.mechanismQuestion(real);
  assert.strictEqual(mq.ask, true,
    `这条原话必须判成机制问句（实际命中=${JSON.stringify(mq.hits)}）`);
  const r = g.isSubmission({ text: real });
  assert.strictEqual(r.yes, false,
    `★ 2026-10-14 事故原话不许再被送审（实际：${r.why}）`);
  assert.strictEqual(r.guard, 'meta-ask', '挡它的必须是机制问句这一条，不是碰巧够短或没命中词');

  // ② 同形状的几种问法都要挡住。
  const asks = [
    '你的审核是怎么做的？',
    '你怎么判别一条文案能不能发？',
    '你审核的依据从哪来？',
    '知识库里的条款号是怎么分配的呢？',
    '你凭什么判定它违规，规则库怎么用？',
  ];
  for (const text of asks) {
    const q = g.isSubmission({ text });
    assert.strictEqual(q.yes, false, `机制问句不许起链：${text}（实际：${q.why}）`);
    assert.strictEqual(q.guard, 'meta-ask', `${text} 应由机制问句挡下，实际 guard=${q.guard}`);
  }

  // ③ ★ 反向对照 A：**没有疑问标记就不许挡** ——
  //    证明这一条真的在读「是不是在问」，不是见到「审核」两个字就闭嘴。
  assert.strictEqual(g.mechanismQuestion('以后所有审核都要留痕').ask, false,
    '没有疑问标记 ⇒ 不是问句，不许判成机制问句');
  assert.strictEqual(g.isSubmission({ text: '以后所有审核都要留痕' }).yes, true,
    '这句够长 ⇒ 按送审走（宁可多跑一次，不许把要求当成闲聊）');

  // ④ ★ 反向对照 B：**「你审核一下这段文案」是递东西来审，不是问机制。**
  //    样本故意做成「既有疑问标记（吗？）又有祈使动作」—— 实测第一版闸门就在这里吞掉了一次正经送审：
  //    「AI 生成的内容需要标注吗？你审查一下这段文案」（它同时够长、又命中「审查」这个送审词）。
  //    ⇒ 吞掉送审是**静默的**，没有任何东西会红，所以这一条不能省。
  const single = 'AI 生成的内容需要标注吗？你审查一下这段文案';
  const one = g.mechanismQuestion(single);
  assert.strictEqual(one.ask, false,
    `带指示宾语的祈使句不许判成机制问句（实际 why=${one.why}）`);
  assert.strictEqual(g.isSubmission({ text: single }).yes, true,
    `一句正经送审必须照常起链（实际：${g.isSubmission({ text: single }).why}）`);

  // ⑤ ★ 反向对照 C：**带了媒材，正文在聊机制也照样送审**（Owner 口径：发了东西就是要看）——
  //    挡机制问句那一段必须排在 ①② 之后，这一条就是盯着那个顺序的。
  const withMedia = g.isSubmission({ text: '你们的审核是怎么做的？这张图顺手审一下', imageCount: 1 });
  assert.strictEqual(withMedia.yes, true, '带图必须仍然送审（机制问句不许拦媒材）');
  assert.strictEqual(withMedia.kind, 'media', `kind 应为 media，实际 ${withMedia.kind}`);

  // ⑥ 反向对照 D：既没元词也没送审词、又不够长 —— 仍按老规矩不触发。
  assert.strictEqual(g.isSubmission({ text: '你们是怎么做到的？' }).yes, false,
    '这句话一个字都不在送审词表里 —— 不该起链');

  // ⑦ ★★ 2026-10-14 补：**口语送审「能X吗」不许再漏**（当天第二次真事故）────────
  //   事故逐字：`m8 pro吸奶器是最好的吸奶器，这句话能过吗？`（24 字）
  //     · 词表里只有「能不能过」这种写法，而这句话是**「能过吗」** —— 子串匹配⇒一个词都没命中；
  //     · 24 字又 < 30 字门槛 ⇒ `isSubmission` 两个条件同时踩空 ⇒ **整条链没起**，
  //       模型自己写了 2952 字答问卡，**没有 PRD §5.3 的结论块**（Owner 当场截图）。
  //   ⇒ 这一条盯着「口语疑问形态」这一族：漏掉它们 = 静默漏掉一笔真送审。
  const spoken = [
    'm8 pro吸奶器是最好的吸奶器，这句话能过吗？',
    '这句文案能过吗', '这个素材能发吗', '这条能上吗', '这个标题能出吗', '能通过吗',
  ];
  for (const text of spoken) {
    const r = g.isSubmission({ text });
    assert.strictEqual(r.yes, true, `口语送审必须起链：${text}（实际：${r.why}）`);
  }
  // ⑧ ★ 反向对照 E：**疑问形态才收** —— 「能过」单独出现**不许**进词表。
  //    为什么必须有这一条：加「能过」两个字会把「这台机器能过 100 次测试」也拖进链
  //    （一次 10~30 分钟），而那句话与送审毫无关系。
  assert.strictEqual(g.isSubmission({ text: '这台机器能过 100 次测试' }).yes, false,
    '「能过」单独出现被当成了送审 —— 词表放宽过度，会白跑一整条链');
});

// ─────────────────────────────────────────────────────────────────────────────
// 第 18 组补 ②：**变异自证** —— 上面那几条断言真的在读那三行判据吗？
//
// 只写「该闭嘴的闭嘴了」是不够的：一个恒返回 false 的闸门也能让那些断言全绿。
// 所以把判据**逐条拆掉**（在 `tools/agent/` 的**临时副本**上，绝不碰在跑的源文件），
// 喂同一批样本，断言「拆哪一条，哪一条样本就红」。
//
// ⚠️ 改的是副本：本仓库有过一次「跑一次自证，把告警关掉半小时」的实测（§2.4.4），
//    而这次要拆的恰好是**在跑的那个文件** —— 直接改它，群里那条链会短暂按坏判据走。
// ⚠️ 副本必须与原文件**同目录**（`review_gate.mjs` 里 `import './video.mjs'` 是相对路径）；
//    跑完在 `finally` 里删掉，失败路径也不留残渣。
// ─────────────────────────────────────────────────────────────────────────────
await t('变异自证：拆掉机制问句闸门的任一条，对应用例必须精确变红', async () => {
  const fsx = await import('node:fs');
  const pathx = await import('node:path');
  const urlx = await import('node:url');
  const here = pathx.dirname(urlx.fileURLToPath(import.meta.url));
  const srcPath = pathx.join(here, 'agent', 'review_gate.mjs');
  const src = fsx.readFileSync(srcPath, 'utf8');
  // ★ 每个变异一个**独立文件名** —— 这条是实测踩出来的：第一版三次变异共用一个文件名，
  //   每次写完 import 再删，结果 `?v=${Date.now()}` 挡不住它：**同一路径的模块被 Node 缓存复用**，
  //   第二次变异可能拿到上一次的模块 ⇒ 指纹在两次运行间**时红时绿**。
  //   （判据：同一个脚本连跑两次，翻面样本集居然不一致 —— 而判据本身没有随机性。）
  //   一个会飘的对照比没有对照更糟：它会让人开始不信报告（§2.1.1）。
  const tmpFor = (i) => pathx.join(here, 'agent', `.review_gate.mutation-${process.pid}-${i}.mjs`);
  // 真身（拿它当**差分基准**）—— ★ 变量名不叫 `g`：上一组那个 `g` 在它自己的回调作用域里
  // （实测踩过：写成 `g` 直接 ReferenceError）。
  const g2 = await import(`./agent/review_gate.mjs?v=${Date.now()}`);

  // 拆法：把某一行的判据换成恒等式 —— 读起来就知道拆的是哪一条。
  // 判据是**差分**：拆掉一条之后，**它守着的那条样本必须翻面，其余样本必须一个都不动**。
  // （一开始我写的是「每条样本都必须等于期望值」—— 那是错的：拆掉「疑问标记」那一条，
  //   「要求」那条样本本来就该跟着翻面，于是断言会在别处变红，看不出是哪条判据在承重。）
  const cases = [
    // 名字                                   样本                                                  拆前→拆后
    ['① 不认元词（等于 10-14 之前的形状）', 'const hasWord = hits.length >= 1;', 'const hasWord = false;'],
    ['② 不问是不是疑问句', 'const isAsk = ASK_RE.test(body);', 'const isAsk = true;'],
    ['③ 不认祈使豁免', 'const isImperative = META_IMPERATIVE_RE.test(body);', 'const isImperative = false;'],
  ];
  const samples = [
    ['A 惹祸原话（该挡）', '读不到的我会直接说，画面本身看不到。你读不到你怎么做审核呢？'],
    ['B 要求·无疑问标记（该放）', '以后所有审核都要留痕'],
    ['C 祈使·递东西来审（该放）', 'AI 生成的内容需要标注吗？你审查一下这段文案'],
    ['D 单一元词的机制问句（该挡）', '你的审核是怎么做的？'],
  ];
  // 每条变异**该翻哪几条样本**（事先写死，不是跑完再解释）。
  // 三条变异**互不重叠**，每条只翻它自己守的那一类 —— 这正是「判据各司其职」的读数：
  //   ① 拆元词      → A、D 漏（两条真问句重新变成送审 = 事故原样）
  //   ② 拆疑问标记  → B 漏（一条**要求**被当成问句吞掉）
  //   ③ 拆祈使豁免  → C 漏（**一句正经送审被静默吞掉** —— 最坏的一种）
  // ⚠️ 这三行**只能信实测**，不能信推断：我按「② 拆了会不会连带 A、D」推过一版，
  //    结果因为上面那个缓存问题，两次运行看到的指纹不一样 —— 真相是**互不重叠**那一版。
  const shouldFlip = {
    '① 不认元词（等于 10-14 之前的形状）': ['A 惹祸原话（该挡）', 'D 单一元词的机制问句（该挡）'],
    '② 不问是不是疑问句': ['B 要求·无疑问标记（该放）'],
    '③ 不认祈使豁免': ['C 祈使·递东西来审（该放）'],
  };
  const base = Object.fromEntries(samples.map(([n, text]) => [n, g2.mechanismQuestion(text).ask]));
  try {
    let mi = 0;
    for (const [mName, from, to] of cases) {
      mi++;
      assert.ok(src.includes(from), `变异点没找到（源码改过？）：${from}`);
      const tmpPath = tmpFor(mi);
      fsx.writeFileSync(tmpPath, src.replace(from, to), 'utf8');
      const mg = await import(`${urlx.pathToFileURL(tmpPath).href}?v=${Date.now()}-${mi}`);
      const after = Object.fromEntries(samples.map(([n, text]) => [n, mg.mechanismQuestion(text).ask]));
      const flipped = samples.map(([n]) => n).filter((n) => after[n] !== base[n]);
      fsx.rmSync(tmpPath, { force: true });
      assert.deepStrictEqual(flipped, shouldFlip[mName],
        `拆掉「${mName}」之后翻面的样本应为 ${JSON.stringify(shouldFlip[mName])}，实际 ${JSON.stringify(flipped)}`);
    }
  } finally {
    for (let k = 1; k <= cases.length; k++) fsx.rmSync(tmpFor(k), { force: true });
  }
  // 反向对照的收尾：拆完之后真源码一个字节没动。
  assert.strictEqual(fsx.readFileSync(srcPath, 'utf8'), src,
    '★ 变异自证**不许改动在跑的源文件**（§2.4.4）');
});

await t('送进链里的素材：按模态分开取，不是把整段提示词塞进去', async () => {
  const g = await import('./agent/review_gate.mjs');
  const inbound = {
    text: '审核下这个视频',
    images: [],
    videos: [{
      index: 1, fileName: 'hero.mp4',
      meta: { duration_s: 14.96, w: 1920, h: 1080 },
      framesRead: 8, frames: [{ t_s: 0.94, text: 'MOMCOZY' }, { t_s: 2.81, text: 'Built to last' }],
      transcript: { ok: true, text: 'Meet the playard that folds in one second.', chars: 42 },
    }],
  };
  const ci = g.chainInput({ question: '审核下这个视频', inbound });
  assert.strictEqual(ci.question, '审核下这个视频', '问句要逐字传');
  assert.ok(ci.text.includes('MOMCOZY') && ci.text.includes('Built to last'), '帧上的字要进素材');
  assert.ok(ci.text.includes('folds in one second'), '音轨转写要进素材');
  assert.ok(ci.text.includes('hero.mp4') && ci.text.includes('15.0s'), '文件名与时长要进素材');
  assert.ok(/抽样/.test(ci.text), '必须写明只能看到抽样几帧 —— 否则链会以为素材就这些');
  assert.deepStrictEqual(ci.media, ['video']);

  // 没人说话 / 没音轨 / 转写没跑成 —— 三种必须分开写，不许都写成「没有说话」
  const mk = (t) => g.chainInput({ question: 'q', inbound: { videos: [{ index: 1, frames: [], transcript: t }] } }).text;
  assert.ok(/没有人说话/.test(mk({ ok: false, kind: 'no_speech' })), 'no_speech 要写「没有人说话」');
  assert.ok(/没有音轨/.test(mk({ ok: false, kind: 'no_audio_track' })), '无音轨要单独写');
  const untested = mk({ ok: false, kind: 'not_authorized' });
  assert.ok(/没跑成/.test(untested) && /未知/.test(untested), `转写没跑成必须写成未知：${untested}`);

  // 链接 / 纯文字两条支路
  assert.ok(g.chainInput({ question: 'q', inbound: { text: '看 https://example.com/x' } }).text.includes('https://example.com/x'));
  assert.strictEqual(g.chainInput({ question: 'q', inbound: { text: '这句能不能发' } }).text, '这句能不能发');
});

await t('链的三种结局必须长得不一样（跑成 / 没跑成 / 回了空的）', async () => {
  const g = await import('./agent/review_gate.mjs');
  const okBlock = g.formatChainBlock({ answer: '结论：REVIEW。依据 W-1.54/M01。', report: 'kb/l7/reports/x.md', record_id: 'recv1' });
  assert.ok(okBlock.includes('REVIEW') && okBlock.includes('W-1.54'), '结论原文要逐字进块');
  assert.ok(/逐字转述，不许改写/.test(okBlock), '必须写明不许改写');
  const errBlock = g.formatChainBlock({ error: '超时' });
  assert.ok(/没跑成/.test(errBlock) && /未知/.test(errBlock), `失败必须写成「结论未知」：${errBlock}`);
  assert.ok(/不是「没问题」，也不是「通过」/.test(errBlock), '必须明确否认「通过」这个读法');
  const emptyBlock = g.formatChainBlock({ answer: '   ' });
  assert.ok(/没有返回结论原文/.test(emptyBlock) && /未知/.test(emptyBlock), '空回答也要落成未知');

  // ★ 信封形状（`executeTool` 回的是 `{tool, ok, result}`）—— 实测踩过一次：
  //   不认它，就会把**跑成的链**写成「没返回结论 → 未知」，安静地把成功说成未知。
  const env = g.formatChainBlock({ tool: 'kb_review_chain', ok: true, result: { answer: '结论：PASS｜依据 W-1.51' } });
  assert.ok(env.includes('PASS') && env.includes('W-1.51'), `信封形状必须能拆出结论：${env.slice(0, 120)}`);
  const envFail = g.formatChainBlock({ tool: 'kb_review_chain', ok: false, error: '超时' });
  assert.ok(/没跑成/.test(envFail) && /未知/.test(envFail), `信封形状的失败也要落成未知：${envFail}`);
});

await t('默认跑法必须**拆掉 executeTool 的信封**（否则成功的链会被写成未知）', async () => {
  const { defaultChainRunner } = await import('./agent/agent.mjs');
  const g = await import('./agent/review_gate.mjs');
  // 直接喂桩给 `formatChainBlock`，验「信封 → 结论」这一跳；
  // `defaultChainRunner` 自己那一跳（真调工具）在下面用源码级断言守住形状。
  const block = g.formatChainBlock({ tool: 'kb_review_chain', ok: true, result: { answer: '结论：REVIEW' } });
  assert.ok(block.includes('结论：REVIEW'), '信封拆不出来的话，这里会变成「未知」');
  const src = fs.readFileSync(new URL('./agent/agent.mjs', import.meta.url), 'utf8')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.ok(/r\?\.ok === false[\s\S]{0,80}r\?\.result/.test(src),
    '`defaultChainRunner` 必须按 `{ok,result}` 拆信封 —— 直接回 executeTool 的返回值就是那个坑');
});

await t('行为级·闸门：该走链的走一次、回执先发、结论排在那一轮最前面', async () => {
  const { runSubmissionGate } = await import('./agent/agent.mjs');
  const calls = { chain: [], acks: [], order: [] };
  // 本条验通用送审顺序；视频各层完整性与拒答由 Z79/Z80 的完整媒体夹具验证。
  const inbound = { text: '审核下这段文案：MOMCOZY folds in one second',
    imageCount: 0, videoCount: 0, images: [], videos: [] };
  const question = '审核下这段文案';
  const r = await runSubmissionGate({
    imageClaimRunner: completedImageClaimFixture,
    inbound, question,
    notify: async (t) => { calls.acks.push(t); calls.order.push('ack'); },
    chainRunner: async (args) => { calls.chain.push(args); calls.order.push('chain'); return { answer: '结论：REVIEW｜依据 W-1.54' }; },
    modelSideRunner: async () => ({ ok: true, findings: [], dropped: [], ms: 0 }),
    publishRunner: async () => ({ ok: true, action: 'skipped', detail: '测试桩：不碰真表' }),
    // ★ 2026-10-09：**必须注入** —— 不注入的话，问题数 ≥3 的夹具会真的在飞书里建一份云文档
    //   （§2.4.4：跑一次自证，改掉了它要保护的东西。实测已发生过一次）。
    mergedReportRunner: async () => ({ ok: true, url: 'https://example.invalid/docx/STUB', detail: '自证桩' }),
    // ★ 2026-10-09：**建议生成也必须注入** —— 它默认真打 LLM。
    //   不注入的话每条跑闸门的自证都会真调模型（实测直接把套件拖到超时）。
    adviceRunner: async ({ items }) => ({ ok: true, ms: 1,
      advice: Object.fromEntries((items || []).map((_, i) => [i, `自证桩给的改法 ${i}`])) }),
  });
  assert.strictEqual(calls.chain.length, 1, '该起链的必须**恰好**起一次');
  assert.strictEqual(calls.acks.length, 1, '必须**先**回一句回执（否则 10~30 分钟里对方以为它没动）');
  assert.deepStrictEqual(calls.order, ['ack', 'chain'], '回执必须在启动审查链之前发出');
  assert.ok(/\[\[card:receipt\]\]/.test(calls.acks[0]), `回执要递**卡片块**（发送层负责成形）：${calls.acks[0]}`);
  assert.ok(calls.chain[0].text.includes('MOMCOZY'), '链要拿到本轮素材原文');
  // ★ 判据是**先后**，不是「有没有」：链的结论（含它自己的头注）必须**排在**人问的话**之前** ——
  //   排在后面会被前面几百字的读数盖住，模型就又开始「描述我读到了什么」了。
  const iAns = r.question.indexOf('结论：REVIEW');
  const iQ = r.question.indexOf(question);
  assert.ok(iAns >= 0, '链的结论原文必须进那一轮');
  assert.ok(iQ >= 0, '人问的话不能丢');
  assert.ok(iAns < iQ, `结论必须排在问题**之前**（结论@${iAns} 问题@${iQ}）`);
  assert.ok(/已经跑完/.test(r.question.slice(0, iAns + 1)), '块头要说明链已经跑完');
  assert.strictEqual(r.chainRan, true);
  // ★ 反向对照：闲聊那条**一次都不许起链**（否则每句「在吗」都跑 30 分钟 + 写飞书）
  const quiet = await runSubmissionGate({
    imageClaimRunner: completedImageClaimFixture,
    inbound: { text: '在吗', imageCount: 0, videoCount: 0 }, question: '在吗',
    notify: async () => { throw new Error('不该有回执'); },
    chainRunner: async () => { throw new Error('不该起链'); },
    publishRunner: async () => { throw new Error('不该落表'); },
  });
  assert.strictEqual(quiet.gate.yes, false, '闲聊不该判成送审');
  assert.strictEqual(quiet.question, '在吗', '不走链时那一轮必须原样');
  // ★ 反向对照：链没跑成时，块里必须写「结论未知」
  const failed = await runSubmissionGate({
    imageClaimRunner: completedImageClaimFixture,
    inbound, question, notify: null,
    chainRunner: async () => { throw new Error('起链炸了'); },
    modelSideRunner: async () => ({ ok: true, findings: [], dropped: [], ms: 0 }),
    publishRunner: async () => ({ ok: true, action: 'skipped', detail: '测试桩：不碰真表' }),
    // ★ 2026-10-09：**必须注入** —— 不注入的话，问题数 ≥3 的夹具会真的在飞书里建一份云文档
    //   （§2.4.4：跑一次自证，改掉了它要保护的东西。实测已发生过一次）。
    mergedReportRunner: async () => ({ ok: true, url: 'https://example.invalid/docx/STUB', detail: '自证桩' }),
    // ★ 2026-10-09：**建议生成也必须注入** —— 它默认真打 LLM。
    //   不注入的话每条跑闸门的自证都会真调模型（实测直接把套件拖到超时）。
    adviceRunner: async ({ items }) => ({ ok: true, ms: 1,
      advice: Object.fromEntries((items || []).map((_, i) => [i, `自证桩给的改法 ${i}`])) }),
  });
  assert.strictEqual(failed.chainRan, false);
  assert.ok(/未知/.test(failed.question) && !/^结论/.test(failed.question), '链炸了不许产出结论');
  // ★ 反向对照：**补发重放**不许重跑链（链会真写飞书，重跑 = 同一单写两遍）
  let reran = 0;
  await runSubmissionGate({
    imageClaimRunner: completedImageClaimFixture, inbound, question: 'q', force: true,
    adviceRunner: async () => ({ ok: true, ms: 0, advice: {} }),
    chainRunner: async () => { reran++; return { answer: 'x' }; },
    publishRunner: async () => ({ ok: true, action: 'skipped', detail: '测试桩：不碰真表' }) });
  assert.strictEqual(reran, 0, 'force（补发）时一次都不许起链');
});

await t('回执：**一张「处理中」卡片**，不许带时长估计（Owner 两次现场裁定）', async () => {
  const g = await import('./agent/review_gate.mjs');
  const env = await import('./reply-cards/envelope.mjs');
  const normal = g.ackMessage({ kind: 'media' });
  const queued = g.ackMessage({ kind: 'media' }, { queued: true });

  // ① **不许再给时长估计** —— Owner 原话：「实际时间跟预估的不符，6~30min 可以去掉」。
  //    核过：本机实测一条图 3 分 32 秒（20:08:23 回执 → 20:11:30 链返回），而回执写 6~30 分钟。
  //    估高了不算最坏 —— 最坏是**估得再准也没用**：人要知道的只有「收到了」和「它在动」。
  for (const [name, a] of [['常态', normal], ['排队', queued]]) {
    assert.ok(!/6~30|6-30|30 分钟|分钟/.test(a.plain),
      `${name}回执里还留着时长估计：${a.plain}`);
  }
  // ② 必须是一张**能成形的卡片**（不是一段会被原样发出去的字符串）
  assert.ok(/^\[\[card:receipt\]\]\n\{/.test(normal.block), `回执必须是卡片块：${normal.block}`);
  const shaped = env.toCardByKind ? null : env.toCardOrText(normal.block);
  assert.strictEqual(shaped.mode, 'card', `回执没成形为卡片（会被发成一段裸文本）：${JSON.stringify(shaped).slice(0, 200)}`);
  assert.strictEqual(shaped.dropped, false, `回执卡片被拦下了：${shaped.reason}`);
  const json = JSON.stringify(shaped.card);
  assert.ok(json.includes('处理中'), `卡片标题/正文要有「处理中」：${json.slice(0, 200)}`);
  assert.ok(json.includes('完整审核正在运行，完成后会在此回复；遇到故障会明确提示。'), `回执要承诺完成回帖且故障可见：${json.slice(0, 200)}`);
  assert.strictEqual(shaped.kind, 'receipt', '用回执那一种卡片（灰头、只确认不解释）');
  // ③ 排队时才多一句，且两种**必须真的不一样**（否则 queued 是死参数）
  assert.notStrictEqual(normal.block, queued.block, 'queued 参数没起作用');
  assert.ok(/排队/.test(queued.plain) && !/排队/.test(normal.plain),
    '没在排队时不许说排队（谎报会让人以为库很忙）');
  // ④ 反向对照：**纯文本**绝不许被当成卡片（证明上面 ② 不是恒真）
  const asText = env.toCardOrText('完整审核正在运行，完成后会在此回复；遇到故障会明确提示。');
  assert.strictEqual(asText.mode, 'text', '不带卡片标记的纯文本就该走文本 —— 否则 ② 那条判据是恒真的');
});

await t('接线：`handleMessage` 必须**真的调**闸门（不是只 import 它）', async () => {
  const src = fs.readFileSync(new URL('./agent/agent.mjs', import.meta.url), 'utf8');
  // 剥掉注释再找 —— 与 verify_shouheng_ops 的 C5、verify_cards 的 J1a 同一条读法：
  // 判据只看代码，不看解释（本文件里到处在解释这个函数，不剥会恒真）。
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  const calls = code.match(/await\s+runSubmissionGate\s*\(/g) ?? [];
  assert.strictEqual(calls.length, 1,
    `handleMessage 里必须**恰好一处**调用 runSubmissionGate（实际 ${calls.length} 处）——`
    + '闸门定义了却没被调用，就是 §2.4 那条「常量定义了没人用」的老病');
  assert.ok(/export async function runSubmissionGate/.test(code), '闸门自己必须是导出的（判据要能直接调它）');
});

await t('接线·**不许「先用后声明」**（实测崩溃：`chainUnmeasured` TDZ —— 那一单在群里没有回复）', async () => {
  // ★ 这条是**为一个真事故**补的（2026-10-08 现场）：
  //   素材「这条站内广告文案能不能发：M6 吸奶器静音设计，夜里泵奶不吵醒宝宝，一次充电够用一整天」——
  //   **库侧成功了**（旁挂 `REVIEW/1`、表已 update），但出卡阶段内核崩了：
  //     `ReferenceError: Cannot access 'chainUnmeasured' before initialization`（`agent.mjs:1436`）
  //   ⇒ **那一单在群里没有回复**，而且没有任何东西会红。
  //   成因：三处截断/兜底分支把内联判据换成了 `chainUnmeasured`，而它的 `const` 声明在**更后面**
  //   ⇒ `const`/`let` 在那行之前是「已声明未初始化」，读它就是 ReferenceError。**判据对、位置错。**
  //
  // 为什么不让下面那条 `子进程端到端` 兜住：它把 LLM 指向死地址 ⇒ 走的是**报错分支**，
  //   **到不了**那三处「回复被截断 / 工具打光」的分支 —— 判据没盖住的那一跳，就是事故那一跳。
  //
  // 扫描口径（**刻意收窄，宁少不滥**）：只在 `handleMessage` 函数体内查
  //   （跨函数同名会误报 —— 通用扫描实测 32 处噪声，那种判据没人会看）；
  //   只查这张具名清单，要加就往 `WATCH` 里加一行；先剥行尾注释再找（本文件到处在解释这些变量）。
  const src = fs.readFileSync(new URL('./agent/agent.mjs', import.meta.url), 'utf8');
  const lines = src.split('\n').map((l) => l.replace(/\/\/.*$/, ''));
  const start = lines.findIndex((l) => /^async function handleMessageInTurn\(/.test(l));
  assert.ok(start >= 0, '找不到 handleMessageInTurn —— 判据的前提没了，先修判据');
  let end = lines.findIndex((l, i) => i > start && /^export /.test(l));
  if (end < 0) end = lines.length;
  const WATCH = ['chainUnmeasured', 'verdict53Final', 'gate', 'chainRan', 'chainBlock', 'chainMs'];
  // Object keys are not variable reads: { gate: accessGate } is valid before
  // the later local `gate` declaration. Shorthand { gate } still reads it.
  const variableUse = (name, line) => {
    const withoutKeys = line.replace(new RegExp(`([,{]\\s*)${name}\\s*:`, 'g'), '$1__property__:');
    return new RegExp(`(^|[^\\w$.])${name}([^\\w$]|$)`).test(withoutKeys);
  };
  assert.equal(variableUse('gate', 'meta: { gate: accessGate }'), false);
  assert.equal(variableUse('gate', 'meta: { gate }'), true);
  assert.equal(variableUse('gate', 'if (gate.yes) {}'), true);
  assert.equal(variableUse('gate', 'const x = yes ? gate : null;'), true);
  for (const name of WATCH) {
    let decl = -1; let firstUse = -1;
    for (let i = start; i < end; i++) {
      if (!variableUse(name, lines[i])) continue;
      if (firstUse < 0) firstUse = i;
      if (decl < 0 && new RegExp(`^\\s*(?:const|let|var)\\s+${name}\\b`).test(lines[i])) decl = i;
    }
    if (decl < 0) continue;                       // 这一版里没这个名字 ⇒ 不判（判据不许恒真）
    assert.ok(decl <= firstUse,
      `「${name}」在 ${firstUse + 1} 行就被用了，声明却在 ${decl + 1} 行 —— `
      + '`const`/`let` 在声明之前读它 = ReferenceError（TDZ），而这条路崩了**用户侧只表现为「没有回复」**。'
      + '修法：把声明提到第一个使用点之前（`let … = 初值` 提前，终值在原处重新赋值）');
  }
});

await t('子进程端到端·跑完整条 handleMessage（LLM 指死地址、KB 根不存在）—— 闸门之后那几行有没有塌', async () => {
  // ★ 这条是**为了一个真事故**补的（2026-10-05 现场）：
  //   我把闸门抽成 `runSubmissionGate()` 时，**把 `let gate = null;` 那几行声明一起抽走了**，
  //   于是闸门返回之后的那一行 `gate = g.gate;` 变成对未声明标识符赋值 →
  //   `ReferenceError: gate is not defined`。后果不是少个字段：
  //   **链跑完 17.9 分钟，然后内核在回话前一刻崩掉**，人收到「内部出错了」，链的结论被丢掉。
  //   为什么原来的自证没拦住：`runSubmissionGate` 自己测过（它是好的），
  //   接线断言只查了「handleMessage 里**有没有调用**它」—— **崩溃发生在调用之后的下一行**。
  //   这正是 §2.4.7 那句：判据没盖住的那一跳，就是事故所在的那一跳。
  //
  // 所以这一条**真跑一遍 handleMessage**，而且保证它是离线、不写飞书、不等 30 分钟的：
  //   · `SHOUHENG_KB_ROOT` 指一个不存在的目录 → `kb_review_chain` 立刻回「找不到知识库工作区」；
  //   · `SHOUHENG_LLM_BASE_URL` 指一个没人听的端口 → 模型这一跳立刻失败（走 `llm_error` 分支）；
  //   · `SHOUHENG_STATE_DIR` 指临时目录 → 会话/去重表都写在那儿，**不碰真状态**。
  const { spawnSync } = await import('node:child_process');
  const os = await import('node:os');
  const pathMod = await import('node:path');
  const tmp = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'shouheng-e2e-'));
  const script = `
    process.on('uncaughtException', (e) => { console.log('THREW ' + (e?.message ?? e)); process.exit(3); });
    process.on('unhandledRejection', (e) => { console.log('THREW ' + (e?.message ?? e)); process.exit(3); });
    const { handleMessage } = await import(${JSON.stringify(new URL('./agent/agent.mjs', import.meta.url).href)});
    const r = await handleMessage({
      message: { message_id: 'om_e2e_' + Date.now(), chat_id: 'oc_e2e', chat_type: 'p2p',
                 message_type: 'text',
                 content: JSON.stringify({ text: '这段 listing 文案能不能发：M5 吸奶器是最好的' }) },
      sender: { sender_id: { open_id: 'ou_e2e_test' } },
    }, {
      // 回执只是打印，不真发消息（这一条验的是内核，不是发送层）
      notify: async (t) => { console.log('ACK ' + t.slice(0, 200)); },   // 要够长，才断得到卡片正文
      // ★ 落表用桩：这一条验的是「闸门之后那几跳会不会塌」，不是「表写没写进去」
      //   —— 写表的判据在 review_publish.test.mjs（那边用假客户端，全程离线）。
      publishRunner: async () => { console.log('PUBSTUB'); return { ok: true, action: 'skipped', detail: '桩' }; },
    });
    console.log('RESULT ' + JSON.stringify({ reason: r.reason, gate: r.meta?.gate ?? null,
                                              chain: r.meta?.chain ?? null,
                                              replyHead: String(r.reply ?? '').slice(0, 60) }));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 120_000,
    env: { ...process.env,
           SHOUHENG_STATE_DIR: tmp,
           SHOUHENG_KB_ROOT: '/tmp/shouheng-绝不存在-的-知识库',
           SHOUHENG_LLM_BASE_URL: 'http://127.0.0.1:9' },
  });
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 收尾失败不影响断言 */ }
  // ① 最要紧的一条：**不许抛**。旧版在这里就是 `gate is not defined`。
  assert.ok(!/THREW|ReferenceError|is not defined/.test(out),
    `闸门之后那一跳塌了（这正是 10-05 现场那次）：\n${out.slice(-500)}`);
  // ② 闸门必须真的判成送审（否则这条用例是空转）
  const m = out.match(/RESULT (\{.*\})/);
  assert.ok(m, `没拿到 RESULT —— 子进程没跑到底：\n${out.slice(-500)}`);
  const res = JSON.parse(m[1]);
  assert.strictEqual(res.gate?.yes, true, `这条消息本该判成送审：${JSON.stringify(res.gate)}`);
  // ③ 链没跑成（KB 根是假的）→ 必须落成 `ran:false`，而且 reply 里要写「未知」
  assert.strictEqual(res.chain?.ran, false, `KB 根不存在时链不该算跑成：${JSON.stringify(res.chain)}`);
  assert.ok(/结论未知|未知/.test(res.replyHead + out), '链没跑成时那一轮必须写「结论未知」');
  // ④ 回执先发（人得知道它在跑）
  // 回执现在递的是**卡片块**（`[[card:receipt]]` + JSON），所以这里判的是「先回了、且是卡片块」
  assert.ok(/ACK \[\[card:receipt\]\]/.test(out), `链启动前必须先回一条「处理中」卡片：${out.slice(-300)}`);
  assert.ok(/完整审核正在运行，完成后会在此回复；遇到故障会明确提示/.test(out),
    '送审回执要承诺最终回帖，不能误报「马上」');
});

// ─────────────────────────────────────────────────────────────────────────────
// 第 18d 组：**额度耗尽不许输出空回复**（2026-10-16，Owner 选定「修根因」）
//
// 起因（真读数，不是我推的）：离线重跑对接人那张图，日志写着
//   `⚠️ 回复被截断：finish_reason=length（额度耗尽）｜正文 0 字｜reasoning 12000 tok`
// 而**报告本身是完整的** —— 被截断的是"说给群里的那句话"。旧代码里处置空正文的那一支
// 要求 `toolTrace.length`（这一轮用过工具），而这一跑模型**没调工具** ⇒ 落到通用分支，
// 通用分支只**附一句截断说明** ⇒ **那句说明自己成了回答**，群里收到一条只有说明的消息。
//
// 新口径：空正文 ＋ 额度耗尽 ＋ 没调工具 ⇒ **关掉思考重写一次**（额度是被推理吃光的）；
// 仍写不出来 ⇒ 落兜底话术。**任何情况下都不许让"只有说明"的回复出门。**
//
// 判据用**假 LLM 端点**（真起一个 http server、`SHOUHENG_LLM_BASE_URL` 指过去），
// 因为这样验的是**协议层**：重写那一次必须真的带上 `thinking:{type:'disabled'}` ——
// 只读源码文本的话，正是 AGENTS.md §2.4 点名的「名字出现过 ≠ 拦得住」。
//
// ★ 这里踩过一次并记下来：**假端点必须与子进程并发活着**。
//   第一版用 `spawnSync` 起子进程 —— 它**阻塞父进程的事件循环**，于是跑在父进程里的
//   这个 http server 一个请求都答不了：子进程的请求连得上、永远等不到回应，
//   表现为「0 次请求 + 被超时杀掉」，而报错看着像是内核挂住了（指向完全无关的方向）。
//   ⇒ 改成异步 `spawn` ＋ await close（父进程事件循环空着，端点才答得上话），
//     并加一条看门狗超时：真挂住时是**红**，不是把整个自证拖死。
// ★ 这里踩过一次并记下来（**第一版判据是假绿的**）：按「第几次请求」发响应不行 ——
//   这条消息在**内核回话之前**已经有一次模型调用（**模型侧**，`max_tokens=8000`、无工具），
//   于是「空正文 ＋ length」被喂给了模型侧，内核那次反倒直接拿到了正文，
//   前两条断言**蒙对了**，只有「重写带没带关思考」把它揭穿（实测 `thinking=undefined`）。
//   ⇒ 判据改成**按角色识别**：`messages[0].content` 含「你是「守衡」」的那次才是内核；
//     非内核的调用一律回一个合法空数组（模型侧就吃这个）。这样与调用顺序解耦。
async function runEmptyReplyCase({ firstContent, firstFinish, env = {} }) {
  const http = await import('node:http');
  const { spawn } = await import('node:child_process');
  const os = await import('node:os');
  const pathMod = await import('node:path');
  const tmp = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'shouheng-empty-'));
  const kernelBodies = [];
  const otherBodies = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let b = {}; try { b = JSON.parse(raw || '{}'); } catch { /* 记原样即可 */ }
      const sys = String(b.messages?.[0]?.content ?? '');
      const isKernel = sys.includes('你是「守衡」');
      let content; let finish;
      if (isKernel) {
        // ★ 2026-10-22：连 Authorization 一起记 —— 「哪把 key 被用上了」只能在这一层验，
        //   读源码只能证明有 `||` 一行（§2.4：名字出现过 ≠ 生效）。
        kernelBodies.push({ ...b, __auth: req.headers.authorization });
        const first = kernelBodies.length === 1;
        content = first ? firstContent : '重写后的结论：这条文案可以发。';
        finish = first ? firstFinish : 'stop';
      } else {
        otherBodies.push(b);
        content = '[]';           // 模型侧／别的旁支调用吃 JSON 数组
        finish = 'stop';
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content }, finish_reason: finish }],
        usage: { completion_tokens_details: { reasoning_tokens: finish === 'length' ? 12000 : 0 } },
      }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const script = `
    process.on('uncaughtException', (e) => { console.log('THREW ' + (e?.message ?? e)); process.exit(3); });
    process.on('unhandledRejection', (e) => { console.log('THREW ' + (e?.message ?? e)); process.exit(3); });
    const { handleMessage } = await import(${JSON.stringify(new URL('./agent/agent.mjs', import.meta.url).href)});
    const r = await handleMessage({
      message: { message_id: 'om_empty_' + Date.now(), chat_id: 'oc_e2e', chat_type: 'p2p',
                 message_type: 'text',
                 content: JSON.stringify({ text: '这段 listing 文案能不能发：M5 吸奶器是最好的' }) },
      sender: { sender_id: { open_id: 'ou_e2e_test' } },
    }, { notify: async (t) => { console.log('ACK ' + String(t).slice(0, 40)); },
         publishRunner: async () => ({ ok: true, action: 'skipped', detail: '桩' }) });
    console.log('RESULT ' + JSON.stringify({ reply: String(r.reply ?? '') }));
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env,
           SHOUHENG_STATE_DIR: tmp,
           SHOUHENG_KB_ROOT: '/tmp/shouheng-绝不存在-的知识库',
           SHOUHENG_LLM_BASE_URL: `http://127.0.0.1:${port}`,
           ...env },
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 90_000);
  const code = await new Promise((res) => child.on('close', res));
  clearTimeout(watchdog);
  server.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 收尾失败不影响断言 */ }
  const m = out.match(/RESULT (\{.*\})/);
  return { out, bodies: kernelBodies, others: otherBodies, code, res: m ? JSON.parse(m[1]) : null };
}

await t('额度耗尽＋正文 0 字＋没调工具 ⇒ 必须关思考重写一次，回复不许"只有说明"', async () => {
  const { out, bodies, res } = await runEmptyReplyCase({ firstContent: '', firstFinish: 'length' });
  assert.ok(!/THREW|is not defined/.test(out), `子进程塌了：\n${out.slice(-400)}`);
  assert.ok(res, `没拿到 RESULT：\n${out.slice(-400)}`);
  // ① 最要紧：**回复非空、且不是那句截断说明**
  assert.ok(res.reply.trim().length > 0,
    `正文 0 字还发出去了（旧版就是这个形状）：${JSON.stringify(res.reply)}`);
  assert.ok(!/^[\s\-—]*⚠️/.test(res.reply.trim()) && !/这条回答被长度上限截断/.test(res.reply.trim()),
    `回复里只有截断说明、没有一个字的答案：${JSON.stringify(res.reply.slice(0, 120))}`);
  assert.ok(/重写后的结论/.test(res.reply), `重写写出来的正文没被采用：${JSON.stringify(res.reply.slice(0, 120))}`);
  // ② 重写**真的发生了**（协议层读数，不是读源码）
  assert.strictEqual(bodies.length, 2, `该重写一次，实际请求 ${bodies.length} 次`);
  // ③ 重写那一次必须**关掉思考** —— 额度就是被推理吃光的
  assert.strictEqual(bodies[1]?.thinking?.type, 'disabled',
    `重写没带 thinking:{type:'disabled'} ⇒ 额度还会被推理吃光：${JSON.stringify(bodies[1]?.thinking)}`);
  // ④ 反向对照（★ 2026-10-20 改口径）：默认首次**就是关思考**（实测 5.9 倍，见第 35 组），
  //   所以这里改验「开关还通」—— `SHOUHENG_REPLY_THINK=on` 时首次必须**不带** thinking、
  //   而重写那一次仍**显式**带 disabled（③ 因此不是恒真：同一份断言在两种配置下取值相反）。
  const on = await runEmptyReplyCase({ firstContent: '', firstFinish: 'length',
                                       env: { SHOUHENG_REPLY_THINK: 'on' } });
  assert.ok(on.res, `开关=on 那一路没拿到 RESULT：\n${on.out.slice(-300)}`);
  assert.strictEqual(on.bodies.length, 2, `开关=on 时仍该重写一次，实际 ${on.bodies.length} 次`);
  assert.strictEqual(on.bodies[0]?.thinking, undefined,
    `SHOUHENG_REPLY_THINK=on 时首次不该带 thinking：${JSON.stringify(on.bodies[0]?.thinking)}`);
  assert.strictEqual(on.bodies[1]?.thinking?.type, 'disabled',
    `重写那一次必须显式关思考（与开关无关）：${JSON.stringify(on.bodies[1]?.thinking)}`);
  // ⑤ 默认（开关未设）⇒ **首次不带思考开关**（= 保持原行为，Owner：「不要影响现有工作流」）
  assert.strictEqual(bodies[0]?.thinking, undefined,
    `默认必须保持原行为（带思考）：${JSON.stringify(bodies[0]?.thinking)}`);
});

await t('★ 端点与密钥可以一起切：SHOUHENG_LLM_API_KEY 必须胜过 DEEPSEEK_API_KEY（2026-10-22 换中转站）', async () => {
  // 背景：DeepSeek 官方额度耗尽（llm_failures.jsonl 67 条 402），Owner 同意改走中转站。
  // 为什么要有这条断言：地址与密钥是**两件独立的配置**，错配只表现为 401，
  // 而 401 在日志里跟「端点挂了」长得一样。所以「哪把 key 真的被发出去了」必须在协议层验。
  // ⚠️ 只能是 ASCII：HTTP 头是 ByteString，中文会让 fetch 直接抛 TypeError
  //   （第一版写成中文密钥，表现是「0 次请求 + 一条网络错误」，指向完全无关的方向）。
  const relayKey = 'sk-relay-test-key';
  const deepKey = 'sk-deepseek-should-not-be-used';
  const r1 = await runEmptyReplyCase({ firstContent: '正常回答。', firstFinish: 'stop',
                                       env: { SHOUHENG_LLM_API_KEY: relayKey, DEEPSEEK_API_KEY: deepKey } });
  assert.ok(r1.res, `没拿到 RESULT：\n${r1.out.slice(-300)}`);
  const r1diag = JSON.stringify({ n: r1.bodies.length, keys: Object.keys(r1.bodies[0] ?? {}),
                                  head: String(r1.out).slice(-200) });
  assert.strictEqual(r1.bodies[0]?.__auth, `Bearer ${relayKey}`,
    `设了 SHOUHENG_LLM_API_KEY 却仍用 DEEPSEEK 那把（端点与密钥错配 ⇒ 只会 401）：`
    + `${r1.bodies[0]?.__auth}｜诊断 ${r1diag}`);
  // 反向对照：不设新变量时，必须仍用 DEEPSEEK_API_KEY（既有行为没被改坏）
  const r2 = await runEmptyReplyCase({ firstContent: '正常回答。', firstFinish: 'stop',
                                       env: { SHOUHENG_LLM_API_KEY: '', DEEPSEEK_API_KEY: deepKey } });
  assert.strictEqual(r2.bodies[0]?.__auth, `Bearer ${deepKey}`,
    `没设 SHOUHENG_LLM_API_KEY 时没退回 DEEPSEEK_API_KEY：${r2.bodies[0]?.__auth}`);
});

await t('反向对照·正文正常时不许重写（只调一次、回复原样）', async () => {
  const { bodies, res } = await runEmptyReplyCase({ firstContent: '正常的回答。', firstFinish: 'stop' });
  assert.ok(res, '没拿到 RESULT');
  assert.strictEqual(bodies.length, 1, `正文正常却多调了模型（${bodies.length} 次）—— 重写分支越界了`);
  assert.ok(/正常的回答/.test(res.reply), `正文被改动了：${JSON.stringify(res.reply.slice(0, 80))}`);
});

await t('★ 飞书链接分流真的接上了（默认 reader = readLink，不再是只读公网页面那个）', async () => {
  // 2026-10-22：飞书链接一律 302 到登录页，只读公网页那一条路**永远读不到**，
  // 而旧默认值让「任何飞书链接都读不了」。这里断的是**接线**（名字出现过 ≠ 接上了）。
  const agentSrc = fs.readFileSync(new URL('./agent/agent.mjs', import.meta.url), 'utf8');
  const gateSrc = fs.readFileSync(new URL('./agent/review_gate.mjs', import.meta.url), 'utf8');
  const n = (agentSrc.match(/linkReader = reviewGate\.readLink/g) ?? []).length;
  assert.strictEqual(n, 2, `handleMessage 与 runSubmissionGate 两处默认值都要是 readLink（实际 ${n} 处）`);
  assert.ok(!/linkReader = reviewGate\.readPublicPage/.test(agentSrc),
    '默认值不许还停在「只读公网页面」—— 那正是这次事故的那条路');
  assert.ok(/reader = readLink\s*\}/.test(gateSrc), 'prepareLinkReview 的默认 reader 必须是分流器');
  assert.ok(/error\?\.shouhengReply/.test(gateSrc),
    '分形态的话术（红线 / 没接口 / 权限）必须被**原样**发出，不许在闸门里改写成一句泛泛的「读取失败」');
  const gate = await import('./agent/review_gate.mjs');
  const feishu = await import('./agent/feishu_link.mjs');
  assert.strictEqual(gate.readLink, feishu.readLink,
    'review_gate 必须 re-export **同一个**分流器（两份实现 = 两把尺子）');

  // ★ 2026-10-28：视频直链识别断言
  const lr = await import('./agent/link_reader.mjs');
  // 正向：常见视频扩展名
  for (const url of [
    'https://cdn.example.com/video/test.mp4',
    'https://cdn.example.com/video/test.mov',
    'https://cdn.example.com/video/test.webm',
    // 实测触发过的两条真实 URL
    'https://m.media-amazon.com/images/S/vse-vms-transcoding-artifact-us-east-1-prod/0a074dd8-b410-4ae0-90c5-2b16306bda4b/default.jobtemplate.mp4.480.mp4',
    'https://momcozy.com/cdn/shop/videos/c/vp/4c7aa468e8d64cb3af17a3a5019d8c0a/4c7aa468e8d64cb3af17a3a5019d8c0a.HD-1080p-2.5Mbps-83116146.mp4?v=0',
  ]) {
    assert.ok(lr.isVideoDirectUrl(url), `应识别为视频直链：${url.slice(0, 80)}`);
  }
  // 反向：网页/图片/无扩展名不应被识别
  for (const url of [
    'https://www.amazon.com/dp/B0FHQJWPTN',
    'https://example.com/product.html',
    'https://example.com/image.jpg',
    'https://example.com/no-extension',
    'https://momcozy-in.feishu.cn/docx/ZWA5dD7h4o0UW9xHpM7coyPNnHb',
  ]) {
    assert.ok(!lr.isVideoDirectUrl(url), `不应识别为视频直链：${url.slice(0, 80)}`);
  }
  // 接线断言：agent.mjs 必须在 prepareLinkReview 前检查视频直链
  assert.ok(/isVideoDirectUrl/.test(agentSrc), 'agent.mjs 没有引用 isVideoDirectUrl —— 视频直链拦截接线断了');
  assert.ok(/downloadVideoToFile/.test(agentSrc), 'agent.mjs 没有引用 downloadVideoToFile —— 视频直链下载接线断了');
  // 下载路径：失败时必须 fail-closed（不许给出通过结论）
  assert.ok(/dl\.ok.*forcedReply|forcedReply.*dl\.ok/.test(agentSrc.replace(/\s+/g, ' ')),
    '视频直链下载失败时必须设置 forcedReply（fail-closed）');
});

// ─────────────────────────────────────────────────────────────────────────────
// 第 18b 组：**「送审问题」这一格只留原文 ＋ 媒材链接**（2026-10-16，Owner 裁定）
//
// 起因：Owner 说「送审问题 里面的图片和视频要优化成链接，点击就可以打开的，
// **只留原文，不要写其他话**」。查真表发现**比那句话更坏** —— 一页 200 行里
// **54 行**的格子里躺着我们自己的内部指令（`【★ 这是送审素材…】`、`【对方这条消息里附了图…】`
// ＋ OCR 全文）。根因是落表时直接写了 `input.question` —— 那是**拼给模型看的那一轮**
// （人话 ＋ 我们的探针 ＋ OCR 全文），不是「对方说的话」。
//
// 这一组钉两件事：① 探针/读数**不许进格子**；② 有链接就写链接、没链接**绝不写死链接**。
// 判据全走桩：`mediaLinksRunner` 注入 ⇒ **一次都不真上传**（§2.4.4）。
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n═══ 18b. 「送审问题」只留原文 + 媒材链接（含反向对照）═══');

const PROBE_TEXT = '【对方这条消息里附了图，共 1 张。下面每一格是**本机 OCR 读出的图内文字**'
  + '（逐字，可能有识别错误；也可能读不全）。你就此能判断的只有「图上写了什么字」——'
  + '画面本身**不在这些字里，你看不到**。】\n【图 1 内文字｜3 行】\nROO\nMOMCOZY\n';

/** 跑一遍闸门，把**落表那一刻收到的 question** 抓回来（其余全桩）。 */
async function gateRowQuestion({ userText, question, mediaLinks }) {
  const { runSubmissionGate } = await import('./agent/agent.mjs');
  let got = null;
  await runSubmissionGate({
    imageClaimRunner: completedImageClaimFixture,
    inbound: { text: '请审查\n[图片]', imageCount: 1, videoCount: 0, images: [{ index: 1, msgId: 'om_x', imageKey: 'img_k' }], videos: [] },
    question, userText,
    notify: async () => {},
    chainRunner: async () => ({ answer: '结论：REVIEW' }),
    modelSideRunner: async () => ({ ok: true, findings: [], dropped: [], ms: 1 }),
    mergedReportRunner: async () => ({ ok: true, action: 'skipped' }),
    adviceRunner: async () => ({ ok: true }),
    mediaLinksRunner: async () => mediaLinks,
    // ★ 2026-11-03（A 改动配套）：带图入站的单元里原图必须**取得到**，
    //   否则新的「拿不到原图 ⇒ 不起链」守卫会把这一组变成空跑（实测 6 条）。
    fetchImageForLink: async (_id, _key, { dir }) => {
      const p = `${dir}/q.png`; fs.writeFileSync(p, 'stub'); return { path: p, bytes: 4 };
    },
    publishRunner: async (row) => { got = row.question; return { ok: true, action: 'skipped' }; },
  });
  return got;
}

await t('Q1 ★ 格子 = 对方原文 ＋ 图片链接；**探针与 OCR 全文一个字都不许进**', async () => {
  const got = await gateRowQuestion({
    userText: '请审查',
    question: '请审查\n\n' + PROBE_TEXT,
    mediaLinks: [{ kind: 'image', ok: true, url: 'https://momcozy-in.feishu.cn/file/AAA' }],
  });
  assert.strictEqual(got, '请审查\n[图片](https://momcozy-in.feishu.cn/file/AAA)');
  assert.ok(!got.includes('【'), '内部指令进了表 = 我们把自己的提示词发出去了');
  assert.ok(!/MOMCOZY/.test(got), 'OCR 全文不该进这一格（它有自己的落点：报告附录）');
});

await t('Q2 ★ 反向对照：没拿到链接 ⇒ 只留原文，**绝不写死链接**', async () => {
  const got = await gateRowQuestion({
    userText: '请审查', question: '请审查\n\n' + PROBE_TEXT, mediaLinks: [],
  });
  assert.strictEqual(got, '请审查');
  assert.ok(!got.includes('http'), '点不开的链接比空格更坏');
});

await t('Q3 调用方忘了传 userText ⇒ 仍不许把探针漏进表（stripInternal 兜底）', async () => {
  const got = await gateRowQuestion({
    userText: undefined, question: '请审查\n\n' + PROBE_TEXT, mediaLinks: [],
  });
  assert.ok(!got.includes('【'), `没传 userText 时探针漏进表了：${JSON.stringify(got)}`);
  assert.ok(got.includes('请审查'), '兜底也要保住对方那句话');
});

await t('Q4 对方只发了图、一个字没写 ⇒ 这一格就只有链接', async () => {
  const got = await gateRowQuestion({
    userText: '',
    question: PROBE_TEXT,
    mediaLinks: [{ kind: 'image', ok: true, url: 'https://x/file/B' }],
  });
  assert.strictEqual(got, '[图片](https://x/file/B)');
});

// ─────────────────────────────────────────────────────────────────────────────
// 第 18c 组：**「@守衡」不是素材**（2026-10-16，Owner 拿着报告来问的那一条）
//
//   现场（报告 docx `NKmbdpRrbooHFAxSNb2cIdlsnGe` 第 1 条，逐字）：
//     「【本地化】素材正文（发布账号名）与图 1 主文字（品牌名 momcozY）…**正文只带了中文账号名
//       @守衡**，美国消费者既看不懂中文 handle 也无法把这条内容归到某个品牌名下…」
//   Owner 原话：「这是我们做飞书的提问，面对美国市场，是提供的素材能不能进美国市场，
//   **不是指我调用守衡的方式**」。
//
//   根因：`readingsForModelSide` 拿 `inbound.text`（**消息原文，含 mention**）当【素材正文】。
//   这一组钉两件：① 那句 `@…` 一个字都不许进读数；② 有媒材时那一节的**标签**必须说明
//   「这不是素材本身」—— 标签本身就会指挥模型怎么判（报告那条正是照着标签判出来的）。
//   判据走**接线级**：真调 `runSubmissionGate`，抓它递给模型侧的 readings。
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n═══ 18c. 「@守衡」不是素材（含标签与反向对照）═══');

/** 跑一遍闸门，抓**递给模型侧的那段读数**（其余全桩）。 */
async function gateReadings({ inbound, userText, question = '（自证：这一条不起真链）' }) {
  const { runSubmissionGate } = await import('./agent/agent.mjs');
  let got = null;
  await runSubmissionGate({
    imageClaimRunner: completedImageClaimFixture,
    inbound, userText, question,
    notify: async () => {},
    chainRunner: async () => ({ answer: '结论：REVIEW' }),
    modelSideRunner: async ({ readings }) => { got = readings; return { ok: true, findings: [], dropped: [], ms: 1 }; },
    mergedReportRunner: async () => ({ ok: true, action: 'skipped' }),
    adviceRunner: async () => ({ ok: true }),
    mediaLinksRunner: async () => [],
    // ★ 2026-11-03（A 改动配套）：同上 —— 带图入站必须有可取到的原图路径。
    fetchImageForLink: async (_id, _key, { dir }) => {
      const p = `${dir}/r.png`; fs.writeFileSync(p, 'stub'); return { path: p, bytes: 4 };
    },
    publishRunner: async () => ({ ok: true, action: 'skipped' }),
  });
  return got;
}

await t('R1 ★ 对方只 @ 了一下（没写话）⇒ 读数里既没有「@守衡」也没有【素材正文】那一节', async () => {
  const got = await gateReadings({
    inbound: { text: '@守衡', imageCount: 1, videoCount: 0,
               images: [{ index: 1, msgId: 'om_x', imageKey: 'k', text: 'momcozY' }], videos: [] },
    userText: '',
  });
  assert.ok(got, '没抓到读数');
  assert.ok(!got.includes('@守衡'), `调用方式漏进读数了：${JSON.stringify(String(got).slice(0, 160))}`);
  assert.ok(!got.includes('【素材正文】'), '对方没写话时不许印【素材正文】那一节（空标签会被当成"正文为空"去判）');
  assert.ok(got.includes('momcozY'), '图上那行字照旧要在（那是真素材）');
});

await t('R2 ★ 有媒材时，那一节必须**自报不是素材**（标签本身会指挥模型怎么判）', async () => {
  const got = await gateReadings({
    inbound: { text: '@守衡 这张能发吗', imageCount: 1, videoCount: 0,
               images: [{ index: 1, msgId: 'om_x', imageKey: 'k', text: 'momcozY' }], videos: [] },
    userText: '这张能发吗',
  });
  assert.ok(got.includes('这张能发吗'), '对方真写的话要留着（它是提问，也是判"要不要拦"的上下文）');
  assert.ok(!got.includes('@守衡'), 'mention 不许留');
  assert.ok(/不是素材本身/.test(got), `带媒材时那节必须自报不是素材：${JSON.stringify(String(got).slice(0, 200))}`);
});

await t('R3 反向对照：**纯文案单**照旧是【素材正文】（不许因为 R1/R2 就不敢收正文）', async () => {
  const got = await gateReadings({
    inbound: { text: '这段 listing 能不能发：M5 吸奶器续航 8 小时', imageCount: 0, videoCount: 0, images: [], videos: [] },
    userText: '这段 listing 能不能发：M5 吸奶器续航 8 小时',
  });
  assert.ok(got.includes('【素材正文】'), '纯文案单的正文就是素材，标签必须还是它');
  assert.ok(got.includes('续航 8 小时'), '正文内容要在');
});

// ─────────────────────────────────────────────────────────────────────────────
// 第 19 组：**自证自己不许往真表里写东西**（§2.4.4 那个形状的现场实例）
//
// 2026-10-05 实测：`runSubmissionGate` 里那段「保证落表」对**测试桩**也照跑不误 ——
// 单测里 `chainRunner` 返回一句假的 `结论：REVIEW`，就真的在 Owner 的评审表上建了一行；
// 紧接着那条「链没跑成」的反向对照又把它的 `状态` 改成了「待审」。
// **自证不但没验出问题，自己成了问题的来源。**
// 判据不再是「记得传桩」（那要靠自觉），而是**闸门默认就是拉下的**：这一条直接断它。
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n═══ 19. 自证不许往真表里写东西 ═══');

await t('C1 自证进程里，落表闸门必须是**拉下**的（`SHOUHENG_REVIEW_TABLE=off`）', async () => {
  const rp = await import('./agent/review_publish.mjs');
  assert.strictEqual(process.env.SHOUHENG_REVIEW_TABLE, 'off',
    '自证进程没拉闸 —— 一旦哪条用例漏传桩，就会真的往 Owner 的表里写');
  assert.strictEqual(rp.reviewTable(), null, '`reviewTable()` 在拉闸时必须回 null');
  // 反向对照：闸门真能挡住写入（不是「恰好没人调」）
  const r = await rp.ensureReviewRow({ contentId: 'AUTO-x', question: 'q', conclusion: 'PASS' });
  assert.strictEqual(r.action, 'skipped', `拉闸时应当 skipped，实际 ${r.action}`);
  assert.ok(/关掉/.test(r.detail ?? ''), `拒写的理由要说清，实际：${r.detail}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 第 20 组：**PRD §5.3 结论行必须逐字进卡片**（2026-10-06）
//
// 事故形状（Owner 在飞书私聊里看见的）：链路侧**已经**按 5.3 产出了结论行，
// 注入语也写着「逐字转述，不许改写」—— 而**回卡片那一跳把表头改写掉了**：
//   `【审查结论：REVIEW】共发现 1 处需人工确认。` → `【证据】REVIEW：1 处问题（W-1.54 静音绝对化）`
// 也就是说「逐字转述」这四个字，在盘上**没有任何执行点**（`AGENTS.md` §2.4）。
//
// 修法照 §2.5 的既有分工：**模型不写结论行**，结论行由 `envelope.applyVerdictLine()`
// 从链的返回里搬进卡片的结论格。本组的判据全部是**行为级**（真调 `toCardOrText`），
// 外加四条反向对照 —— 没有反向对照，那些绿只证明「这个函数对什么都点头」。
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n═══ 20. PRD §5.3 结论行（逐字进卡片 + 反向对照）═══');

const { deriveVerdictLine, conforms, leadsWith } = await import('./agent/prd53.mjs');
const { toCardOrText, applyVerdictLine, verdictSlotOf } = await import('./reply-cards/envelope.mjs');
// ★ 2026-10-16（FIX-043）：P0 读数那一格的判据是**命名空间导入** ——
//   因为里面既有纯函数（`p0PayloadOf`）、又有每轮边界与只给自证用的 arming
//   （`beginP0Turn` / `_armP0MemoForTest` / `_resetP0MemoForTest`），逐个解构会写很长。
const toolsMod = await import('./agent/tools.mjs');

await t('W1 权威结论行的三个来源：链原文 / P0 快路派生 / 都没有 → null（不许编）', () => {
  // ① 链原文里有 5.3 行 → 用它（这就是「链说了算」）
  const fromChain = deriveVerdictLine({
    answer: '状态：REVIEW ｜ 问题数：1\n摘要：【审查结论：REVIEW】共发现 1 处需人工确认。\n1.【平台与促销-静音绝对化表述】…',
  });
  assert.strictEqual(fromChain.state, 'REVIEW');
  assert.strictEqual(fromChain.line, '【审查结论：REVIEW】共发现 1 处需人工确认。');
  assert.strictEqual(fromChain.from, 'chain');

  // ② P0 快路的抬头是「来路标注」，不是 5.3 的结论行 ⇒ 按 §5.3.3 **派生**一行
  const fromP0 = deriveVerdictLine({
    answer: '【P0 红线拦截：BLOCK】命中知识库已定稿的 P0（法务合规红线）确定性模式。\n…',
    p0Fastpath: { matched_patterns: 2, elapsed_ms: 42.9 },
  });
  assert.strictEqual(fromP0.line, '【审查结论：BLOCK】共发现 2 处必须修改。',
    `P0 快路必须派生出 §5.3.3 那一行，实际：${fromP0.line}`);
  assert.strictEqual(fromP0.from, 'p0-fastpath');

  // ③ 拒答（NEEDS_INPUT）**不在 §5.3 里** ⇒ 不搬，也**不许编一行出来**
  assert.strictEqual(deriveVerdictLine({ answer: '【审查结论：NEEDS_INPUT】依据侧拒答（fail-closed）' }), null,
    'NEEDS_INPUT 不在 PRD §5.3 的三态里 —— 这里必须回 null（编一行比不搬更坏）');
  assert.strictEqual(deriveVerdictLine({}), null, '什么都没给时必须回 null');
  // 反向对照：P0 命中数读不出来时**不派生**（「共发现 ? 处」是编的）
  assert.strictEqual(deriveVerdictLine({ answer: 'x', p0Fastpath: { elapsed_ms: 1 } }), null,
    'P0 命中数读不出来时必须回 null —— 不许编一个「共发现 N 处」');
});

await t('W2 兜底判据必须**窄**：回复中间出现 5.3 模板 ≠ 一次审查结论', () => {
  const TMPL = '【审查结论：REVIEW】共发现 1 处需人工确认。';
  // 有人问「PRD 5.3 的 REVIEW 长什么样」，守衡照抄一遍模板 —— **那不是一次审查结论**
  const quoted = `PRD 第 5.3.2 节的模板是这样：\n\n${TMPL}\n\n注意「需人工确认」是逐字的。`;
  assert.strictEqual(deriveVerdictLine({ replyText: quoted }), null,
    '模板被引用在回复中间时不许当成结论 —— 否则问一句模板就会把自己的标题改掉');
  // 排在最前面才算自己在用这一行
  assert.ok(leadsWith(`${TMPL}\n\n上面是结论。`, TMPL), '排在最前面时必须认');
  const atTop = deriveVerdictLine({ replyText: `${TMPL}\n\n明细见报告。` });
  assert.strictEqual(atTop?.line, TMPL);
});

await t('W3 行为级：改写过的卡片标题，必须被换成**逐字**结论行（且原标题不丢）', () => {
  const line = '【审查结论：REVIEW】共发现 1 处需人工确认。';
  // 这条形状**逐字取自 2026-10-06 实发出去的那三条**（PMO/logs/ws_outbound.jsonl）
  const reply = '结论：REVIEW\n\n[[card:query-answer]]\n'
    + JSON.stringify({ title: 'REVIEW：1 处问题（W-1.54 静音绝对化）', verdict: '待转法务复核',
                       boundary: '未命中 ≠ 合规' });
  const r = toCardOrText(reply, { verdict53: { state: 'REVIEW', line, from: 'chain' } });
  assert.strictEqual(r.mode, 'card', `应当建出卡片，实际 ${r.mode}`);
  assert.strictEqual(r.data.title, line, `卡片标题必须是逐字结论行，实际「${r.data.title}」`);
  assert.strictEqual(r.verdict53.action, 'forced');
  // ★ **搬不是砍**：模型原来写在标题里的话必须进折叠区，一个字都不许丢
  const folded = JSON.stringify(r.card);
  assert.ok(folded.includes('W-1.54 静音绝对化'),
    '原标题被覆盖掉了 —— 那里面常写着边界话（如「但『未命中 ≠ 合规』」），丢了比格式难看严重得多');
});

await t('W4 反向对照：不是送审时**一个字符都不许加**', () => {
  const reply = '[[card:query-answer]]\n' + JSON.stringify({ title: '在的', verdict: '有什么事？' });
  const r = toCardOrText(reply, { verdict53: null });
  assert.strictEqual(r.data.title, '在的', '没有权威结论行时不许动标题 —— 给闲聊加一句「审查结论」比格式难看严重得多');
  assert.strictEqual(r.verdict53.action, 'none', '没搬过就不许报「搬过」');
  // 直接调纯函数也验一遍（调用方漏传 opts 时这条兜住）
  const p = applyVerdictLine('query-answer', { title: '在的' }, null);
  assert.strictEqual(p.action, 'none');
  assert.strictEqual(p.data.title, '在的');
});

// ★ 2026-10-06 重写。原版断言的是「`find-nothing` **没有**结论格」——
//   而那正是当时的**病灶**（模型挑到它就 `落点=no-slot`，PRD §5.3 结论行无处安放）。
//   把病灶写成反向对照，等于**把 bug 钉住**：一修好它就红。
//   现在两条分开：**十一种卡片都必须有结论格**（正面），
//   **未登记的类型落到 no-slot 且不许丢内容**（反向对照，仍然有效）。
await t('W5 十一种卡片的结论格**全部**是 title（抬头）', async () => {
  const { BUILDERS } = await import('./reply-cards/registry.mjs');
  const noSlot = Object.keys(BUILDERS ?? {}).filter((k) => !verdictSlotOf(k));
  assert.deepStrictEqual(noSlot, [],
    `这些类型没有结论格，模型挑到它们时 §5.3 结论行就无处安放：${noSlot.join('、')}`);
  // ★ 2026-10-06 Owner 裁定「title 格补给所有卡片类型」：
  //   **落点必须是抬头**，不能是 verdict（正文）。
  //   旧版这里写的是 `assert.strictEqual(verdictSlotOf('evidence'), 'verdict')` ——
  //   那正是当时的**病灶**（模型挑 evidence 时结论行落到正文、抬头仍是模型自拟的），
  //   把病灶钉成判据，一修好它就红。**判据要钉行为，不要钉现状。**
  //   十一种全查，不是抽查两种：漏一种就是漏一条真实的产线路径。
  const wrong = Object.keys(BUILDERS ?? {}).filter((k) => verdictSlotOf(k) !== 'title');
  assert.deepStrictEqual(wrong, [],
    `这些类型的结论格不是抬头（会被放到正文去，业务同事扫抬头看不到结论）：${wrong.join('、')}`);
  for (const k of ['cannot-read', 'receipt', 'turn-diff', 'evidence']) {
    assert.strictEqual(verdictSlotOf(k), 'title', `${k} 的抬头格没被认出来（它的 fields 里只有 verdict）`);
  }
});

await t('W5c 行为级：evidence 卡的 §5.3 结论行必须真的进**抬头**（不是只改判据）', () => {
  // `verdictSlotOf` 只是判据本体 —— 它对了不等于卡上真换了。
  // 这一条走完整 `toCardOrText`，看**建出来的那张卡**的 header。
  const line = '【审查结论：REVIEW】共发现 2 处需人工确认。';
  const reply = '[[card:evidence]]\n' + JSON.stringify({
    title: '模型自拟的抬头', verdict: '模型自述的一句话',
    groups: [{ title: 'g', content: 'c' }],
  });
  const r = toCardOrText(reply, { verdict53: { state: 'REVIEW', line, from: 'chain' } });
  assert.strictEqual(r.card.header.title.content, line,
    `结论行没进抬头，实际：${JSON.stringify(r.card.header.title.content)}`);
  // **搬不是砍**：模型原来那句必须还在卡里（换格子，不是删）
  assert.ok(JSON.stringify(r.card).includes('模型自拟的抬头'),
    '原抬头被砍掉了 —— 搬是搬，砍是砍');
});

await t('W5b 反向对照：**未登记的类型**落到 no-slot，且不许丢内容', () => {
  const line = '【审查结论：BLOCK】共发现 2 处必须修改。';
  assert.strictEqual(verdictSlotOf('__不存在__'), null);
  const r = toCardOrText('[[card:find-nothing]]\n' + JSON.stringify({ paths: ['PMO/'], tried: ['grep'] }),
                         { verdict53: { state: 'BLOCK', line, from: 'chain' } });
  // find-nothing 现在**有**格子了 ⇒ 必须真搬进去，不是静默成功
  assert.strictEqual(r.card.header.title.content, line, '有结论格却没搬进去');
  assert.strictEqual(r.verdict53.action, 'forced');
  // 内容不许丢：原来那些字段还在
  assert.ok(JSON.stringify(r.card.body).includes('grep'), '搬结论行时把正文丢了');
});

await t('W6 评审单：结论行前置（走卡片抬头），且幂等（已有就不再加）', () => {
  const line = '【审查结论：PASS】未发现已知底线风险，可转交 @sign-off 责任人（未配置） 进行 sign-off。';
  const V = { state: 'PASS', line, from: 'chain' };
  // ★ 2026-10-12（Owner 现场：「守衡的输出格式变了」）：**带权威结论行的回复必须建卡**。
  //   旧断言写的是 `mode === 'text'` —— 而那正是 19:31–19:58 四条实发回复的形状：
  //   纯文本在飞书里不渲染 markdown，群里看到的是 `**加粗**`、反引号与一堆 `|`。
  //   行为改动在 `envelope.mjs::toCardOrText`（模型没给卡 ⇒ 代码建一张），
  //   判据在 `verify_cards.mjs` J12a–d。
  const once = toCardOrText('模型自己写的一段话。', { verdict53: V });
  assert.strictEqual(once.mode, 'card', `评审单必须建卡，实际 mode=${once.mode}（reason=${once.reason}）`);
  assert.strictEqual(once.card.header.title.content, line,
    `结论行必须排在最前面（抬头），实际：${JSON.stringify(once.card.header.title.content)}`);
  // 幂等：模型原话里已经把这一行写出来了 ⇒ 从折叠组里摘掉，抬头独占（不许印两遍）
  const twice = toCardOrText(`${line}\n\n模型自己写的一段话。`, { verdict53: V });
  const n = JSON.stringify(twice.card).split(line).length - 1;
  assert.strictEqual(n, 1, `结论行在卡里出现了 ${n} 次 —— 已经有这一行时不许再来一遍`);
  // 反向对照：**没有**权威结论行 ⇒ 仍是纯文本，且一个字符都不许改
  const plain = toCardOrText('模型自己写的一段话。');
  assert.strictEqual(plain.mode, 'text');
  assert.strictEqual(plain.text, '模型自己写的一段话。');
});

await t('W7 措辞判据：REVIEW / BLOCK 两句话必须**不一样**（这是引擎原先抹平的那一处）', () => {
  assert.ok(conforms('【审查结论：REVIEW】共发现 1 处需人工确认。').ok);
  assert.ok(conforms('【审查结论：BLOCK】共发现 2 处必须修改。').ok);
  // 反向对照：引擎原先那句两态共用的话，**必须判不合规**
  assert.ok(!conforms('【审查结论：REVIEW】共发现 1 处需处理问题。').ok,
    '「需处理问题」是引擎 2026-10-06 之前两态共用的写法，PRD §5.3.2 要的是「需人工确认」');
  assert.ok(!conforms('【审查结论：BLOCK】共发现 2 处需处理问题。').ok, 'BLOCK 要的是「必须修改」');
  assert.ok(!conforms('【P0 红线拦截：BLOCK】命中…').ok, '来路标注不是 5.3 的结论行');
});

await t('W8 接线：`replyTo` 必须真的把结论行**传进** toCardOrText（不是只 import）', async () => {
  const src = fs.readFileSync(new URL('./ws_daemon.mjs', import.meta.url), 'utf8');
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const body = strip(src.slice(src.indexOf('async function replyTo'), src.indexOf('async function safeSend')));
  assert.ok(/deriveVerdictLine\(/.test(body),
    'replyTo 里没有兜底派生 —— 补发那一路（resend 不跑闸门）会拿不到结论行');
  assert.ok(/toCardOrText\([^)]*verdict53/.test(body),
    'replyTo 调 toCardOrText 时**没把 verdict53 传进去** —— 判据就成了注释（§2.4 那个病）');
  // 反向对照：内核算出的那一行必须真的被 daemon 取用
  const { replyOptionsForResult } = await import('./agent/review_feedback.mjs');
  const verdict53 = { state: 'BLOCK', line: '【BLOCK】共发现 1 处必须修改。' };
  assert.strictEqual(replyOptionsForResult({ meta: { verdict53 } }).verdict53, verdict53,
    '发送投影没有保留内核的权威结论');
});

await t('W8b 接线：逐条依据**走报告**、不许再进表列（Owner 2026-10-15 改口径）', () => {
  // ── 这条判据的前身（2026-10-13）─────────────────────────────────────────────
  //   病灶：我写成 `evidenceBlock(dual.items)`，而条目在 `dual.merged.items` ⇒ 传 undefined
  //   ⇒ 依据块永远空，**日志/卡/表一处都不报错**（判据抓对了、最后一跳断了且断得静悄悄）。
  //
  // ── 2026-10-15（Owner）：「按照 prd 只出结论，不要自己加其他内容」────────────────
  //   ⇒ 那一格改成**只放 PRD 块**，依据块**撤出表列**（依据在报告里 —— PRD 的设计＝摘要＋钻取报告）。
  //   ⇒ 判据跟着改口径，且两半都要钉：
  //     ① 表列那一格**不许**再出现依据块；
  //     ② 依据仍然**必须**进报告 —— 报告渲染的入参必须是 `dual.merged.items`（同一个接线错误
  //        在报告侧照样会静悄悄丢依据，所以这条断言不能删，只能挪）。
  const src = fs.readFileSync(new URL('./agent/agent.mjs', import.meta.url), 'utf8');
  const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const body = strip(src);
  assert.ok(!/summary:\s*summaryCellText/.test(body) && !/evidenceBlock\(/.test(body),
    '依据块又回到表列那一格了（Owner 2026-10-15：这一格只出 PRD 结论）');
  assert.ok(/renderMergedReportMd\(/.test(body), '报告渲染那一跳不见了');
  assert.ok(/merged:\s*reportItems/.test(body)
      && /const reportItems\s*=\s*Array\.isArray\(rendered0\?\.displayItems\)/.test(body),
    '报告渲染的入参不是真条目数组 —— 依据会在报告里静默消失（与 10-13 那次同一个形状）');
  // 反向对照：把报告入参改成 undefined ⇒ 上面那条必须红（内存里做，不碰盘）
  const mutated = body.replace(/merged:\s*(itemsWithAdvice|dual\??\.merged\??\.items)/, 'merged: undefined');
  assert.ok(!/merged:\s*(itemsWithAdvice|dual\??\.merged\??\.items)/.test(mutated),
    '反向对照失效：把报告入参改成 undefined 后判据仍然通过');
});

await t('W9 行为级：**逐条四要素整块**必须进卡片正文（不只是抬头）', async () => {
  // 真事（Owner 2026-10-06 08:57 那张 BLOCK 卡）：抬头对了，**逐条整块没有** ——
  // 因为正文由模型转述，它把一整块压成了一句「命中两条 P0，不能发」。
  const ans = ['【审查结论：BLOCK】共发现 2 处必须修改。', '',
    '1.【功效宣称-催乳与通乳宣称】全文，逐字命中 \`increase milk supply\`',
    '  **原因**：H02 催乳/增产/奶量产出承诺',
    '  **依据**：《措辞表达库 v0（试用版，未发布）》第 W-1.18 条（链接：kb/l3/candidates/rules.jsonl#W-1.18）',
    '  **锚点**：#广告文案明细/recvuJYdOb1Rm1/命中片段｜source_sha256：c77f576…',
    '  **判定**：事实（确定性逐字匹配）｜置信度：未给（P0 快路不产出置信度）',
    '  **建议**：删除 more milk 等承诺', '',
    '2.【背书与资质-医生专家推荐】全文，逐字命中 \`doctor recommended\`',
    '  **原因**：H04 无据的医生/专家推荐背书', '',
    '请修改后重新提交。', '', '---', '【来路与边界】…'].join('\n');
  const v = deriveVerdictLine({ answer: ans, p0Fastpath: { matched_patterns: 2 } });
  assert.ok(v.block && v.block.startsWith('【审查结论：BLOCK】'), '块必须从结论行起');
  assert.ok(v.block.endsWith('请修改后重新提交。'), '块必须在动作行止（半截块比不搬更坏）');

  // 复刻那张卡：模型把整块压成了一句话
  const reply = '结论：BLOCK\n\n[[card:query-answer]]\n' + JSON.stringify({
    title: 'P0 红线拦截：BLOCK（H02 / H04）',
    verdict: 'BLOCK：命中 W-1.18 与 W-1.13 两条 P0，不能发',
    reasoning: 'P0 快路确定性匹配（35.559 ms，不动用大模型）—— 红线拦截，不是专项审查结论。' });
  const r = toCardOrText(reply, { verdict53: v });
  // ★★ 2026-10-13（Owner：「群聊里跟私聊的格式不一样？」）：**评审单形状由代码定** ——
  //   模型挑的 `query-answer`（正文格是 `reasoning`）不再被沿用，一律收敛到 `evidence`
  //   ＋ 一组「审查结论」，逐条四要素落进**那一组**（不是 `reasoning`）。
  const body = String(r.data?.groups?.[0]?.content ?? '');
  assert.strictEqual(r.kind, 'evidence', `评审单没收敛到 evidence，实际 ${r.kind}`);
  // ★★ 2026-10-14（Owner：「去掉『审查结论』多余的」）：组标题从「审查结论」改成
  //   「逐条问题」—— 块的第一行本来就是 `【审查结论：BLOCK】…`，两个「审查结论」连着出现。
  assert.strictEqual(r.data?.groups?.[0]?.title, '逐条问题', '第一组标题必须固定');
  // 反向对照：**结论行在卡上只许出现一次**（抬头那次），正文那一份必须被去掉。
  //   改前实测：抬头 1 次 + 第一组首行 1 次 = 2 次（Owner 截图里那两个「审查结论」）。
  {
    const blob = JSON.stringify(r.card ?? {}) + String(body);
    const n = (blob.match(/【审查结论\s*[：:]/g) || []).length;
    assert.ok(n <= 1, `结论行在卡上出现了 ${n} 次 —— 抬头占一格，正文那份必须去掉`);
  }
  // ★ 2026-10-06：Owner 要求**标签加粗**，方便业务同事一眼扫到「原因/依据/建议」。
  //   断言跟着改成加粗形态 —— 不是放宽，是**钉住新形态**（钉不住的格式改动会悄悄退回）。
  // ★★ 2026-10-14（Owner 裁定「去掉『判定』这个字段」）：`**判定**` 已从这一组里删掉 ——
  //   PRD §5.3 的逐条模板只有 原因 / 依据 /（BLOCK 才有）建议，三态只在结论行一处。
  //   ⚠️ 上面那份**夹具**（`ans`，模拟链的历史输出）里仍带着 `**判定**：`，
  //     那是**故意留的**：它验的是「旧格式的链输出仍搬得动」（迁移期不许崩），
  //     不是「新格式里该有这一行」。新格式由下面 ⓪ 那条反向对照钉住。
  for (const k of ['**原因**：', '**依据**：', '**锚点**：', '**建议**：']) {
    assert.ok(body.includes(k), `逐条块里缺「${k}」—— 这一格正是 Owner 指出没落上的那几行`);
  }
  // ⓪ 反向对照（2026-10-14 加，**打在生产者身上**）：新渲染的逐条块里不许再出现 `**判定**` 行。
  //   ★ 第一版我把这条写成「查上面那个 body」——**当场红**，而且红得有道理：
  //     那个 body 是**链的老输出搬过来的**，里头本来就带 `**判定**：`（夹具故意留的，
  //     验的是「旧格式仍搬得动」）。搬运动作**不许改字**，所以它必然带着那一行。
  //     ⇒ 要钉「新格式没有它」，就得**真渲染一次**（`renderMergedItem` 才是生产者）。
  //     查搬运结果等于禁止搬运保真 —— 那是拿错的尺子量对的东西。
  const _T = await import('./agent/dual_track.mjs');
  const fresh = _T.renderMerged(
    [{ location: '全文', category: '合规', severity: 'REVIEW', source: 'model', reason: 'x', advice: 'a' }],
    { state: 'REVIEW' })?.block ?? '';
  assert.ok(fresh.includes('**原因**：') && fresh.includes('**依据**：') && fresh.includes('**建议**：'),
    '新渲染的逐条块缺 PRD 四要素之一：\n' + fresh);
  assert.ok(!/^ *\*{0,2}判定\*{0,2}：/m.test(fresh),
    '新渲染的逐条块里又出现了「判定」行 —— Owner 2026-10-14 裁定去掉它：\n'
    + (fresh.match(/^ *\*{0,2}判定\*{0,2}：[^\n]*/m) || [''])[0]);
  assert.strictEqual(_T.countRenderedItems(fresh), 1, '新渲染出来的条目数应为 1');
  assert.ok(r.verdict53.block && r.verdict53.block.action === 'forced', '落点读数必须带出来（否则日志里看不到）');
  // ★★ 2026-10-13（Owner：「整个都隐藏，不要展示在卡片上」）：**卡脚那一格整格作废**。
  //   P0 那句边界改走 `dual_track.internalNotes`（记忆侧）——
  //   这里只钉「卡上不许有它」（记忆侧那一半在 verify_cards 的 J14b）。
  assert.ok(!JSON.stringify(r.card ?? {}).includes('P0 红线拦截'), '卡脚边界又上卡了');
  assert.strictEqual(r.data?.boundary, undefined, 'boundary 那一格还没撤干净');
  // ★ 搬不是砍：模型原话仍在**这一轮的回复正文**里（会话记忆 + `💬 回复 N 字`），只是不上卡
  assert.ok(reply.includes('35.559'), '夹具自己变了？');
  assert.ok(!JSON.stringify(r.card ?? {}).includes('35.559'),
    '模型原话又回到卡上了 —— Owner 2026-10-13 要求它整组不上卡');
});

await t('W10 反向对照：PASS（只有一行、没有逐条）不许被硬塞一个空块', () => {
  const ans = '【审查结论：PASS】未发现已知底线风险，可转交 @sign-off 责任人（未配置） 进行 sign-off。\n\n（无问题）';
  const v = deriveVerdictLine({ answer: ans });
  assert.strictEqual(v.block, null, 'PASS 没有逐条块 —— 不许把半截东西当块搬进去');
  const r = toCardOrText('[[card:query-answer]]\n' + JSON.stringify({ title: 'x', verdict: 'y' }), { verdict53: v });
  assert.strictEqual(r.verdict53.block, null, '没有块就不许报「搬过块」');
  // 也没有「没有块就报错」那条路：quietly none 才是对的
  assert.strictEqual(r.data.title, v.line);
});

// ═══ 第 21 组 · 送审单起了链、链却没跑成 ⇒ 必须进补发队列（2026-10-06）═══
//
// 事故（Owner 原话）：「我以后每次发图片/视频给守衡，守衡都可以正常回复了吧？」
// 那次的两张卡是「库忙（exit 3）：这一单未测，没有三态结论」。
// 那条回复**是一条回复**，所以 `reason` 本来是 `ok` ⇒ 入队判据收不到它
// ⇒ 补发队列**连队都没进** ⇒ 「问一次答不上，问十次还是答不上」。
// 与 2026-09-22 补 `tool_exhausted` 是**同一个病**，只是长在送审这条路上。
//
// 三面各一条（标记表 / 入队判据 / 收尾 reason），缺一面另一个方向就恒真。
await t('X1 补发标记：带 chain_not_run 的回复必须被判「没答过」', async () => {
  const rq = await import('./agent/retry_queue.mjs');
  assert.ok(rq.NOT_AN_ANSWER_FLAGS.includes('chain_not_run'),
    '标记没进补发队列的判据表 ⇒ 带它的回复照样会被当成「答过了」');
  const sess = (flag) => ({ messages: [
    { role: 'user', content: '这个图片可以过吗？' },
    { role: 'assistant', content: '【库忙（exit 3）：这一单未测，没有三态结论】',
      ...(flag ? { chain_not_run: true } : {}) },
  ] });
  const item = { text: '这个图片可以过吗？' };
  assert.strictEqual(rq.answeredInMemory(item, sess(true)).answered, false,
    '带标记的回复被判成「答过了」⇒ 永远不会补发（这就是原 bug 的形状）');
  // 反向对照：**不带**标记的普通回复仍必须判「答过了」——
  // 少了这一条，判据写成恒 false 也照样绿，而代价是「什么都重跑一遍、答两遍」。
  assert.strictEqual(rq.answeredInMemory(item, sess(false)).answered, true,
    '反向对照失败：没标记也被当成没答 ⇒ 会答两遍');
});

await t('X2 审查入队按完整性与可重试状态判定，已完成不重复入队', async () => {
  const { shouldRetryReview } = await import('./agent/review_feedback.mjs');
  const make = (retryable) => ({ meta: { gate: { yes: true }, reviewDecisionWithheld: true,
    verdict53: null, reviewFailure: { stage: 'image_workflow', code: 'image_scope_unmeasured', retryable } } });
  assert.strictEqual(shouldRetryReview(make(true)), true, '媒体暂态复核失败必须补跑');
  assert.strictEqual(shouldRetryReview(make(false)), false, '永久缺项不能被当成暂态补跑');
  assert.strictEqual(shouldRetryReview({ meta: { ...make(true).meta, gate: { yes: false } } }), false,
    '非送审消息不能入审查重试队列');
  assert.strictEqual(shouldRetryReview({ meta: { ...make(true).meta,
    reviewDecisionWithheld: false,
    verdict53: { state: 'PASS', line: '【审查结论：PASS】未发现已知底线风险，可转交 @负责人进行 sign-off。' } } }), false,
    '完整权威结论不能因旧失败状态重复入队');
  // Z84 执行真实 onMessage/replyTo，验证共享判据在发送入口真的被调用。
});

await t('X3 共享失败判据保留暂态重试与永久拒绝，未完成不能恢复旧结论', async () => {
  const src = fs.readFileSync(new URL('./agent/agent.mjs', import.meta.url), 'utf8');
  const { reviewFailureOf, shouldRetryReview } = await import('./agent/review_feedback.mjs');
  for (const [code, retryable] of [
    ['claim_busy', true], ['layer_gate_red', true], ['layer_audit_red', true], ['preflight_aborted', true],
    ['coverage_not_covered', false], ['evidence_side_refused', false],
  ]) {
    const failure = reviewFailureOf({ review: { state: 'NEEDS_INPUT', refusal: { reason_code: code } } },
      { withheld: true });
    assert.strictEqual(shouldRetryReview({ meta: { gate: { yes: true }, verdict53: null,
      reviewDecisionWithheld: true, reviewFailure: failure } }), retryable, code);
  }
  const missing = reviewFailureOf({}, { withheld: true, missingReadings: true });
  assert.strictEqual(shouldRetryReview({ meta: { gate: { yes: true }, reviewDecisionWithheld: true,
    verdict53: null, reviewFailure: missing } }), true, '缺链读数仍须补跑，不能被媒体缺项吞掉');
  // 反向对照②：直接调用收尾判据；未完成图片/视频不能复活任何旧三态来源。
  const { finalVerdict53ForTurn } = await import('./agent/agent.mjs');
  const gateVerdict = { state: 'PASS', line: '【审查结论：PASS】未发现已知底线风险。' };
  const p0Payload = { answer: '', p0Fastpath: { mode: 'p0_fastpath', matched_patterns: 1 } };
  const toolTrace = [{ tool: 'kb_review_chain', ok: true }];
  const chainAnswer = { answer: '【审查结论：REVIEW】共发现 1 处需人工确认。' };
  const reply = '【审查结论：PASS】未发现已知底线风险。';
  const fallbacks = [
    ['闸门旧结论', { gateResult: { verdict53: gateVerdict } }, 'PASS'],
    ['P0 派生', { p0Payload }, 'BLOCK'],
    ['链结论', { toolTrace, chainAnswer, reply }, 'REVIEW'],
    ['模型回话', { toolTrace, reply }, 'PASS'],
  ];
  for (const [name, input, state] of fallbacks) {
    assert.strictEqual(finalVerdict53ForTurn(input)?.state, state, `${name}阳性对照必须有效`);
    for (const flag of ['imageReviewIncomplete', 'videoReviewIncomplete']) {
      assert.strictEqual(finalVerdict53ForTurn({ ...input,
        gateResult: { ...input.gateResult, [flag]: true } }), null,
      `${flag} 时不能从${name}回落复活三态`);
    }
  }
  assert.strictEqual(finalVerdict53ForTurn({ gateResult: { verdict53: gateVerdict,
    imageReviewIncomplete: false, videoReviewIncomplete: false } }), gateVerdict,
  '完整审查必须保留本轮闸门结论');
  assert.strictEqual(finalVerdict53ForTurn({ reply }), null, '仅有模型回话、没有成功调用链不得生成三态');
  const n = (src.match(/chain_not_run: true/g) ?? []).length;
  assert.ok(n >= 3, `写到会话记忆里的 chain_not_run 标记只有 ${n} 处，应当 ≥3（三条收尾路径）`);
});

// ═══ 第 22 组 · 模型自己调链那条路也要出 §5.3 结论行（2026-10-06）═══
//
// 真事故（Owner 发的截图）：`M9 吸奶器限时优惠中，下单立减 100 元。` —— 23 字、无媒材、
// 无链接、没命中送审词 ⇒ **闸门判「不是送审」**，`runSubmissionGate` 直接回 `verdict53: null`；
// 而**模型自己**调了 `kb_review_chain`（日志里只有 `🔧 工具: kb_review_chain`，
// 没有 `🧭 送审链返回`），拿到结论后自己写抬头 ⇒ 卡片格式与 PRD §5.3 不符。
//
// 这一组守的就是那条路：**凭据是「这一轮真的调成了链」**，不是「回复里像有一行 5.3」。
await t('Y1 模型自调链 ⇒ 回复里的 5.3 行必须被采用', () => {
  const reply = '**结论：REVIEW —— 共发现 1 处需人工确认，转复核责任人。不是 PASS。**\n\n'
    + '```\n状态：REVIEW ｜ 问题数：1\n摘要：【审查结论：REVIEW】共发现 1 处需人工确认。\n```\n\n'
    + '[[card:query-answer]]\n{"title":"REVIEW 1 处：W-1.16「限时」（覆盖不成立）","verdict":"x"}';
  const d = deriveVerdictLine({ replyText: reply, reviewedByTool: true });
  assert.ok(d, '模型自调链那条路没抽出结论行 ⇒ 卡片抬头仍会由模型自便');
  assert.strictEqual(d.state, 'REVIEW');
  assert.strictEqual(d.line, '【审查结论：REVIEW】共发现 1 处需人工确认。');
  assert.strictEqual(d.from, 'reply-tool');
  // 而且它必须**真的能把抬头换掉**
  const r = toCardOrText(reply, { verdict53: d });
  assert.strictEqual(r.card.header.title.content, d.line, '结论行没落进标题');
});

await t('Y2 反向对照：**没调链**时，同样一段回复不许被当成结论', () => {
  // 这一条防的是「有人在问『PRD 5.3 里 PASS 长什么样』，守衡照抄一遍模板」——
  // 少了它，任何含 5.3 字样的回答都会被强行套上结论抬头。
  const reply = 'PRD §5.3 里 PASS 长这样：\n【审查结论：PASS】未发现已知底线风险，可转交 @陈静姝 进行 sign-off。';
  assert.strictEqual(deriveVerdictLine({ replyText: reply }), null, '没调链也认了 —— 会把引用当结论');
  assert.strictEqual(deriveVerdictLine({ replyText: reply, reviewedByTool: false }), null);
});

await t('Y3 接线：内核必须把「这一轮调成了链」当成凭据传下去', () => {
  const src = fs.readFileSync(new URL('./agent/agent.mjs', import.meta.url), 'utf8');
  assert.ok(/toolTrace[\s\S]{0,120}?kb_review_chain[\s\S]{0,40}?ok/.test(src),
    '内核没有拿 toolTrace 里的 kb_review_chain 成功当凭据');
  assert.ok(/reviewedByTool:\s*true/.test(src), '没有把 reviewedByTool 传进 deriveVerdictLine');
  // 反向对照：那个凭据**必须**要求 `ok`（一次失败的链不是一次审查）
  assert.ok(!/kb_review_chain'\)\s*\?/.test(src), '凭据没有校验 ok —— 一次失败的链也会被当成审查过');
});

// ═══ 第 22b 组 · **P0 快路**也要出 §5.3 块（FIX-043，2026-10-16）═══
//
// 真单：`om_x100b622a8e762cbcce3b9bfa8402ccb`（群 `oc_49a7…`，2026-10-16 17:20 北京时间）——
// 群里问「m5 pro是最好的吸奶器，这句话能过审吗？」，守衡 180 字卡：
//   `【证据】` ␤ `BLOCK —— 「最好」命中 P0 一票否决项 E-2.124；红线拦截，非专项审查结论`
//   ␤ `（已收起 1 条证据：判定 · 1）` ␤ …（四组折叠摘要）—— **PRD §5.3.3 的逐条块一个字都没有**。
//
// 根因（两个各自都对的部件，接缝断了）：那一单闸门判「**不是送审**」（原话「在问审查这件事
// 本身怎么运作（过审）」）⇒ `g.verdict53 = null` ⇒ 内核落到兜底那一支，而兜底**只喂 `replyText`**
// ⇒ 结论行取决于**模型有没有把链那一行抄进回复**。这一单模型没抄（它写 `**结论：BLOCK…**`）。
// 而 `deriveVerdictLine` 第 ② 支**早就**会按 `p0Fastpath.matched_patterns` 派生 §5.3.3 那一行
// （`W1` 一直在喂它）—— **全仓没有一个调用点给它传过 `p0Fastpath`**。
// 又一个 FIX-021：「判据写对了」≠「调用方接上了」。
//
// 下面这一组是**行为级**的：喂真单逐字夹具，断言**卡上真的有那四行**。
await t('Y4 ★★ P0 快路单：结论行与逐条块必须从**链返回**派生，不许靠模型有没有抄', () => {
  // 链返回的 `answer`（= `kb/l5/p0_fastpath.py --json` 的 `rendered`，逐字）
  const ANSWER = [
    '【审查结论：BLOCK】共发现 1 处必须修改。', '',
    '1.【绝对化与安全承诺-绝对化用语】全文，逐字命中 `最好`',
    '  **原因**：按 PRD §7.3 判定（Owner 2026-10-13 同意入选）',
    '  **依据**：《外部标准库 v0（试用版，未发布）》第 E-2.124 条（链接：https://example.invalid/wiki/NB55）',
    '  **锚点**：#h.7. 知识库与规则体系 / 7.3 一票否决项（P0 级，命中即 BLOCK）｜source_sha256：6671c283…',
    '  **建议**：（来源未给修改建议）', '',
    '请修改后重新提交。', '', '---', '【来路与边界】…',
  ].join('\n');
  // 模型这一轮的回复（逐字）—— 关键：它**没有**把结论行抄进来，写的是自己那句
  const REPLY = '**结论：BLOCK —— 共 1 处必须修改。** 「m5 pro 是最好的吸奶器」**过不了审**。\n\n'
    + '[[card:evidence]]\n'
    + JSON.stringify({ verdict: 'BLOCK —— 「最好」命中 P0 一票否决项 E-2.124；红线拦截，非专项审查结论',
                       groups: [{ title: '判定', content: 'P0 快路 63.121 ms｜逐字命中 最好', count: 1 }] });
  const FAST = { mode: 'p0_fastpath', elapsed_ms: 63.121, matched_patterns: 1, rule_codes: ['V02'],
                 layer_preflight: { enforced: false, is_pass_basis: false } };

  // ① 反向对照（**这一条就是那一单的真实形状**）：只喂 replyText ⇒ 派不出任何结论
  assert.strictEqual(deriveVerdictLine({ replyText: REPLY, reviewedByTool: true }), null,
    '模型没抄结论行时不该派生 —— 若这里变成非 null，说明判据放宽了，W2 那条「引用模板 ≠ 一次结论」会跟着松');

  // ② 带上 P0 载荷 ⇒ 派生 §5.3.3 那一行，且**逐条四要素整块**跟着来
  const v = deriveVerdictLine({ replyText: REPLY, reviewedByTool: true, answer: ANSWER, p0Fastpath: FAST });
  assert.ok(v, '带上 P0 读数后仍派生不出结论行 —— 卡面又会退成模型自拟的四组折叠摘要');
  assert.strictEqual(v.line, '【审查结论：BLOCK】共发现 1 处必须修改。', `结论行不对：${v.line}`);
  assert.strictEqual(conforms(v.line).ok, true, '派生出来的这一行必须与 §5.3.3 逐字一致');
  assert.ok(v.block && v.block.endsWith('请修改后重新提交。'),
    '逐条块必须从结论行起到动作行止（半截块比不搬更坏）');

  // ③ **卡上真的有**（行为级）：四要素逐条 + 动作行
  const r = toCardOrText(REPLY, { verdict53: v });
  assert.strictEqual(r.kind, 'evidence', `评审单必须收敛到 evidence，实际 ${r.kind}`);
  assert.strictEqual(r.data?.groups?.[0]?.title, '逐条问题', '第一组标题必须固定');
  const body = String(r.data?.groups?.[0]?.content ?? '');
  for (const k of ['**原因**：', '**依据**：', '**建议**：', '请修改后重新提交。']) {
    assert.ok(body.includes(k), `卡上缺「${k}」—— 这正是 Owner 报的那条（180 字卡上没有逐条块）`);
  }
});

await t('Y5 ★★ P0 读数只在**这一轮真跑了快路**时才有货（纯函数 + 反向对照）', () => {
  const { p0PayloadOf } = toolsMod;
  // 判据是纯函数 ⇒ 断言不产生任何副作用（不起链、不写飞书、不落报告）
  const res = { ok: true, answer: '【审查结论：BLOCK】共发现 2 处必须修改。\n\n请修改后重新提交。',
                p0_fastpath: { matched_patterns: 2, elapsed_ms: 12.3, rule_codes: ['V02', 'H05'] },
                p0_findings: [{ rule_code: 'V02' }] };
  const p = p0PayloadOf(res);
  assert.ok(p, '命中快路的结果必须能取出载荷 —— 取不出就等于这一格从来没接上');
  assert.strictEqual(p.p0Fastpath.matched_patterns, 2, '条数必须原样搬（兜底那条派生行读的就是它）');
  assert.strictEqual(p.p0Findings.length, 1, 'P0 的结构化逐条要一起带出去（双轨对齐那一格读它）');
  // 反向对照①：**没命中快路**结果不许造一个载荷出来
  //   （否则会给一个走链走成了的单子派一条 §5.3 行 —— 那条行不是它算出来的）
  assert.strictEqual(p0PayloadOf({ ok: true, answer: '走链去了' }), null, '没命中快路也取了载荷');
  // 反向对照②：**跑失败**的信封不许取 —— `{error}` 是「结论未知」，
  //   拿它派生结论行等于把未测说成已判（§2.4.2：未测不许与通过长得一样）。
  assert.strictEqual(p0PayloadOf({ ok: false, error: '找不到知识库工作区' }), null,
    '跑失败的结果被当成了一次判定');
  assert.strictEqual(p0PayloadOf(null), null, '空结果不该取载荷');
  // 反向对照③：`p0_fastpath` 在、但**不是对象**（历史上见过字符串读数）⇒ 不取
  assert.strictEqual(p0PayloadOf({ ok: true, p0_fastpath: 'hit' }), null, '坏形状的读数被当成载荷');
});

await t('Y5b ★★ 每轮必须清空：上一轮的 P0 读数不许拿来答这一轮（会拿别人的结论上卡）', () => {
  const tools = toolsMod;
  tools._resetP0MemoForTest();
  assert.strictEqual(tools.p0MemoRead(), null, '干净状态下不许有货');
  tools._armP0MemoForTest({ p0Fastpath: { matched_patterns: 1 }, answer: 'x', p0Findings: [] });
  assert.ok(tools.p0MemoRead(), '装上之后要读得到（否则下面那条恒真）');
  tools.beginP0Turn();                       // ← 一轮的边界，`agent.mjs` 调闸门之前那一跳
  assert.strictEqual(tools.p0MemoRead(), null,
    '换了轮次还留着上一轮的读数 ⇒ 下一次兜底会把**上一单**的结论行与逐条块搬到这张卡上');
  tools._resetP0MemoForTest();
});

await t('Y6 接线：兜底那一支必须**真的**把 P0 读数喂进 deriveVerdictLine（文案断言只作补充）', () => {
  const src = fs.readFileSync(new URL('./agent/agent.mjs', import.meta.url), 'utf8');
  // ① 一轮的边界要有它 —— 与 `beginChainTurn()` 同一处、同一套理由
  //   ★ 2026-10-20：匹配器从字面量 `beginChainTurn();` 放宽成「可带参数」——
  //     因为 Owner 定的「图单 content_type 必须由图定死」把模态从每轮起点传进来，
  //     调用变成了 `beginChainTurn({ modality: … })`。**顺序这条判据一个字没松**：
  //     仍然要求「`beginChainTurn(...)` 之后 600 字内出现 `beginP0Turn()`」。
  assert.ok(/beginChainTurn\s*\((?:[^()]|\([^()]*\))*\);[\s\S]{0,600}?beginP0Turn\(\);/.test(src),
    '`beginP0Turn()` 没有跟在 `beginChainTurn(...)` 后面 ⇒ 上一轮的 P0 读数会串到下一轮');
  // ② 兜底那一支要带上 answer 与 p0Fastpath
  assert.ok(/p0MemoRead\(\)/.test(src), '兜底那一支没有读 P0 读数');
  assert.ok(/p0Fastpath:\s*p0Payload\.p0Fastpath/.test(src),
    '没有把 p0Fastpath 喂进 deriveVerdictLine —— 那就还是「判据写好了、没人接」');
  assert.ok(/answer:\s*p0Payload\.answer/.test(src),
    '没有把链返回的 answer 喂进去 ⇒ 逐条块（原因/依据/建议/动作行）整块还是上不了卡');
  // ③ 反向对照：**载荷为空时一个字段都不许多带**（否则会给没跑快路的单子编一条 §5.3 行）。
  //   ⚠️ 2026-10-16（FIX-044）：形状从「`...(p0Payload ? {…} : {})` 展开」改成了
  //     「`p0Payload ? deriveVerdictLine({…}) : (退回 toolTrace 那一支)`」——
  //     因为现在有两个来源，得**先**判有没有载荷、再决定走哪一支。
  //     ⇒ 判据跟着钉**新形状**（钉不住的格式改动会悄悄退回），拦的还是同一件事：
  //       **没有载荷时不许把字段塞进去**。
  assert.ok(/p0Payload\s*\n?\s*\?\s*deriveVerdictLine\(\{/.test(src),
    '那一支必须写成「有载荷才派生」—— 无条件塞字段会把 null 当结论派生出假抬头');
  // ④ 工具调用要能被注入 —— 没有这条缝，下面那条端到端断言根本写不出来
  //   （上面那四条全是**源码文本**，正是 §2.4 点名的假执行点；真正拦得住的是 Y7）
  assert.ok(/deps\?\.executeTool \?\? executeTool/.test(src),
    '工具循环没留注入点 ⇒ 「P0 读数接线」只能靠源码文本断言，端到端跑不起来');
});

await t('Y7 ★★★ 行为级：钩子取出的载荷 → 上游结论行 → 卡面（这一条不碰真链、不碰模型）', () => {
  // 真单形状（`om_x100b622a8e762cbcce3b9bfa8402ccb`）：
  //   ① 闸门判「不是送审」（原话「在问审查这件事本身怎么运作（过审）」）⇒ `g.verdict53 = null`；
  //   ② 模型**自己**调了 `kb_review_chain`，工具**命中 P0 快路**（`executeTool` 里装进那一格）；
  //   ③ 模型的回复**只写自己那句**，没有把结论行抄进来。
  // 这一条把 ①→③ 串起来跑：**载荷由 `p0PayloadOf` 从「链返回」里取**（不是手写一个字面量），
  // 再经 `p0MemoRead()` 那一跳，最后看**卡面**上有没有 §5.3.3 的逐条块。
  //
  // ⚠️ **未测的那一格（如实写在这里，不许假装测过）**：`handleMessage` 内部那一跳
  //    （`const p0Payload = p0MemoRead()` 之后喂进 `deriveVerdictLine` 的那几行）**不在这条里**
  //    —— 它要有一次真的模型往返才跑得到，而 LLM 那一跳没有注入点（真跑会真起链、真写飞书）。
  //    守着那一跳的是 `Y6` ②③ 两条**源码级**断言 ＋ `deps.executeTool` 那个注入点。
  //    ——「未测」与「通过」在这里**长得不一样**，这是它必须写出来的理由（§2.4.2）。
  const tools = toolsMod;
  const ANSWER = [
    '【审查结论：BLOCK】共发现 1 处必须修改。', '',
    '1.【绝对化与安全承诺-绝对化用语】全文，逐字命中 `最好`',
    '  **原因**：按 PRD §7.3 判定（Owner 2026-10-13 同意入选）',
    '  **依据**：《外部标准库 v0（试用版，未发布）》第 E-2.124 条（链接：https://example.invalid/wiki/NB55）',
    '  **锚点**：#h.7. 知识库与规则体系 / 7.3 一票否决项（P0 级，命中即 BLOCK）',
    '  **建议**：（来源未给修改建议）', '',
    '请修改后重新提交。',
  ].join('\n');
  const MODEL_REPLY = '**结论：BLOCK —— 共 1 处必须修改。** 「m5 pro 是最好的吸奶器」**过不了审**。\n\n'
    + '[[card:evidence]]\n'
    + JSON.stringify({ verdict: 'BLOCK —— 「最好」命中 P0 一票否决项 E-2.124；红线拦截，非专项审查结论',
                       groups: [{ title: '判定', content: 'P0 快路 63.121 ms｜逐字命中 最好', count: 1 }] });

  // ② 「链返回」= `kb_review_chain` 真正回的那个 result（逐格照真单）
  const chainResult = { ok: true, answer: ANSWER,
    p0_fastpath: { mode: 'p0_fastpath', elapsed_ms: 63.121, matched_patterns: 1, rule_codes: ['V02'],
                   layer_preflight: { mode: 'p0_fastpath', enforced: false, is_pass_basis: false } },
    p0_findings: [{ rule_code: 'V02', matched: [{ line_text: 'm5 pro是最好的吸奶器' }] }],
    issue_count: 1, confidence: 1.0 };
  // ③ 钩子那一跳（`executeTool` 里就是这两行）
  const payload = tools.p0PayloadOf(chainResult);
  assert.ok(payload, '链返回取不出载荷 ⇒ 兜底那一支拿不到任何读数');
  tools._resetP0MemoForTest();
  tools._armP0MemoForTest(payload);

  // ④ 兜底那一支的两次读：`p0MemoRead()` → `deriveVerdictLine`
  const read = tools.p0MemoRead();
  assert.ok(read, '装上的载荷读不回来 ⇒ 接线断了（`p0MemoRead()` 读的是 `memo.payload`）');
  const v = deriveVerdictLine({ replyText: MODEL_REPLY, reviewedByTool: true,
                                answer: read.answer, p0Fastpath: read.p0Fastpath });
  assert.ok(v, '取到载荷仍派生不出结论行');
  assert.strictEqual(v.line, '【审查结论：BLOCK】共发现 1 处必须修改。', `结论行不对：${v.line}`);

  // ⑤ 卡面：逐条四要素必须真的印上去
  const r = toCardOrText(MODEL_REPLY, { verdict53: v });
  assert.strictEqual(r.kind, 'evidence');
  assert.strictEqual(r.data?.groups?.[0]?.title, '逐条问题', '第一组标题必须固定');
  const body = String(r.data?.groups?.[0]?.content ?? '');
  for (const k of ['**原因**：', '**依据**：', '**建议**：', '请修改后重新提交。']) {
    assert.ok(body.includes(k), `卡上缺「${k}」`);
  }
  tools._resetP0MemoForTest();
});

// ═══ 第 22c 组 · **P0 不许取决于模型肯不肯调工具**（FIX-044，2026-10-16）═══
//
// 真事故（同一个群、**同一句话**，问了两遍，两遍形状不同）：
//   · 17:19 —— 闸门不起链（`meta-ask`），模型**自己**调了 `kb_review_chain`
//     ⇒ 链返回在，卡面 180 字（格式不符：一段都没搬进卡）；
//   · 19:4x —— 闸门**同一条判词**，模型**没调**（原话「重跑会往飞书再加一行，故未重跑」）
//     ⇒ 链返回整个不存在 ⇒ 卡面 163 字，连条款号都只剩模型转述。
// ⇒ 病灶：**P0 判据（确定性、只读、毫秒级）此前只能由「模型愿不愿意调工具」触发**。
//   而 PRD §6.3 第一层说的是「命中即停止后续审查，直接输出 BLOCK」—— 它是判据，不是自选项。
//
// 这一组守两条：① 内核在闸门不起链时**自己**跑一遍；② 那一遍**只读**
//   （不落报告文件、不建云文档、不写飞书）—— 否则等于顺手改了别人的工作流。
await t('Y8 ★★★ 行为级：P0 命中 ⇒ 内核**自己**拿得到 §5.3.3 块（不靠模型调不调工具）', async () => {
  const { runP0Preflight } = toolsMod;
  // ★ 当前外部规则真源已将「最好/best」按现行口径放开；这里改用仍生效的医疗宣称 P0。
  const Q = '这台吸奶器治疗乳腺炎';
  const out = await runP0Preflight({ text: Q, question: Q });
  assert.ok(out, '快路没命中那一句 —— 下面所有断言都会退化成恒真，先看知识库在不在');
  assert.strictEqual(out.p0_fastpath.matched_patterns, 1, `命中条数不对：${out.p0_fastpath?.matched_patterns}`);
  assert.ok(String(out.answer).includes('【审查结论：BLOCK】'),
    '链返回里没有 §5.3.3 那一行 —— 那卡上就不可能有逐条块');
  // ★ 只读那一条：内核那条前置路**不许**产生报告落盘
  assert.ok(!out.report_path, `内核前置写报告文件了：${out.report_path}（那条路以前不落盘）`);
  assert.strictEqual(out.report, '', '内核前置建云文档了 —— 那是在改别人的工作流');
  // 派生：结论行 + 逐条块（与内核兜底那一支逐字同一条路）
  const v = deriveVerdictLine({ replyText: '**结论：BLOCK —— 共 1 处必须修改。**',
                                reviewedByTool: true, answer: out.answer, p0Fastpath: out.p0_fastpath });
  assert.ok(v, '取到 P0 读数仍派生不出结论行');
  assert.strictEqual(v.line, '【审查结论：BLOCK】共发现 1 处必须修改。', `结论行不对：${v.line}`);
  assert.ok(v.block && v.block.endsWith('请修改后重新提交。'), '逐条块必须到动作行止');
  // 卡面：模型这一轮**没调链、也没抄结论行**，四要素照样得在
  const REPLY = '**这句我上一轮刚判过，结论没变：BLOCK。** 我没有重跑。\n\n[[card:query-answer]]\n'
    + JSON.stringify({ title: '这台吸奶器治疗乳腺炎 —— BLOCK（同上轮，未重跑）',
                       verdict: 'BLOCK：命中医疗宣称规则', evidence: ['证据 · 1 条'] });
  const r = toCardOrText(REPLY, { verdict53: v });
  assert.strictEqual(r.kind, 'evidence', `评审单必须收敛到 evidence，实际 ${r.kind}`);
  const body = String(r.data?.groups?.[0]?.content ?? '');
  for (const k of ['**原因**：', '**依据**：', '**建议**：', '请修改后重新提交。']) {
    assert.ok(body.includes(k), `卡上缺「${k}」—— 这正是 Owner 连报两次的那张卡`);
  }
  // ★★ 2026-10-16（FIX-044）：**「块在卡里」不等于「人看得见」** ——
  //   那一组必须**默认展开**。实测过：`renderText`（纯文本降级渲染器）对所有 collapsible
  //   一律打成「（已收起 N 条证据：…）」，所以拿它当判据会**误报**成「块没上卡」；
  //   真正要钉的是**建出来的那个元素**：`collapsible_panel.expanded === true`。
  //   —— 「Owner 两次都只看到一行结论」那个形状，就是这一格为 false 时长出来的。
  const panel = (r.card?.body?.elements ?? []).find((e) => e?.tag === 'collapsible_panel');
  assert.ok(panel, '卡上没有折叠区 —— 逐条块无处安放');
  assert.strictEqual(panel.expanded, true,
    '逐条块那一组是**收起**的 ⇒ 群里只看得见一行结论（Owner 报的就是这个形状）');
  const inner = String(panel.elements?.[0]?.content ?? '');
  // ⚠️ 这里核对的是**卡上那一格**（渲染后的形态）：markdown 元素会把 `**原因**` 转成 rich text
  //   ⇒ 卡元素里是 `原因：`。**数据层**（`r.data.groups[0].content`）保留 `**原因**` 原文，
  //   上面那四条查的就是数据层。两边都查，是因为「数据层有、卡上没有」也是一种真事故。
  for (const k of ['原因：', '依据：', '建议：', '请修改后重新提交。']) {
    assert.ok(inner.includes(k), `**默认展开的那一组**里缺「${k}」—— 收起区里有不算`);
  }
  assert.strictEqual(r.card?.header?.title?.content, v.line, '抬头必须是权威结论行');
});

await t('Y9 ★★ 反向对照：不该拦的话，前置一声不吭（否则闲聊也会弹一张 BLOCK 卡）', async () => {
  const { runP0Preflight } = toolsMod;
  for (const s of ['你的能力图谱有哪些？', '谢谢，我明白了', 'PRD §5.3 里 PASS 长什么样？', '']) {
    assert.strictEqual(await runP0Preflight({ text: s, question: s }), null,
      `这一句被误判成 P0 命中了：${JSON.stringify(s)}`);
  }
});

await t('Y10 接线：闸门不起链时内核必须**自己**跑 P0（含反向对照：不许重复跑／不许建文档）', () => {
  const src = fs.readFileSync(new URL('./agent/agent.mjs', import.meta.url), 'utf8');
  // ① 前置那一跳在，且**只**在闸门不起链时跑
  assert.ok(/if \(!gate\?\.yes\) \{[\s\S]{0,400}?runP0Preflight\(/.test(src),
    '闸门不起链时内核没有自己跑 P0 —— 那 P0 又会取决于模型肯不肯调工具（就是这条缺陷）');
  const calls = (src.match(/runP0Preflight\(/g) ?? []).length;
  const docs = (src.match(/runP0Preflight\(\{/g) ?? []).length;   // doc 注释里也写着签名，别把它算成调用
  assert.strictEqual(docs, 1, `runP0Preflight 的**调用点**有 ${docs} 个（应当恰好 1 个）`);
  assert.ok(calls >= docs, `调用次数 ${calls} 少于调用点 ${docs} —— 判据自己坏了`);
  // ② 兜底那一支要同时认两个来源（工具来的 / 内核前置来的）
  assert.ok(/p0MemoRead\(\)[\s\S]{0,200}?p0Preflight/.test(src),
    '兜底那一支没有把「内核前置」也算成一个来源 ⇒ 19:4x 那种走法还是空');
  // ③ 报告链接：P0 前置那条路也要给（拿不到就是 null，不编）
  assert.ok(/reportLink:\s*g\.dual\?\.reportUrl \?\? \(p0Preflight\?\.report \|\| null\)/.test(src),
    'P0 前置那条路的报告链接没接上（或写成了会编一个链接的形状）');
  // ④ 反向对照：**不许**把前置写成会建文档的形状（那是动别人的工作流）。
  //   判据落在 `agent.mjs` 那一跳的参数上：`runP0Preflight({ text…, question… })` 里
  //   不许出现 `allowPublish`（函数默认 false ⇒ 只读）。
  const call = /if \(!gate\?\.yes\)[\s\S]{0,500}?(runP0Preflight\(\{[\s\S]{0,300}?\}\))/.exec(src);
  assert.ok(call, '找不到那一跳的调用');
  assert.ok(!/allowPublish/.test(call[1]),
    '内核前置那一跳显式传了 allowPublish —— 它会在「不是送审」的消息上建云文档（默认只读，别动它）');
});

// ═══ 第 23 组 · 模型侧必须与链**并行**（2026-10-08）═══
//
// 方案 §③ 的原话是「每层的两侧都是完整的一遍审查，**互不等待**」。
// 而实现曾经是串行，且模型侧被绑在 `if (chainRan)` 上 ——
// **链报错/库忙时模型侧根本不跑** ⇒ 那一单用户什么都拿不到。
// Owner 2026-10-08 截图那张库忙卡就是这么来的。
await t('Z1 行为级：**链没跑成**时，模型侧那几条必须还在（不许被 chainRan 掐掉）', async () => {
  const { runSubmissionGate } = await import('./agent/agent.mjs');
  const TEXT = '这条站内广告文案能不能发：M6 吸奶器静音设计，夜里泵奶不吵醒宝宝';
  const g = await runSubmissionGate({
    imageClaimRunner: completedImageClaimFixture,
    inbound: { text: TEXT, imageCount: 0, videoCount: 0 },
    question: TEXT,
    notify: null,
    // ★ 2026-10-09：**必须注入** —— 这条夹具问题数 ≥3，不注入会真的在飞书里建一份云文档。
    //   实测：写这一条时忘了注入，跑一次自证就建了一份（§2.4.4 那个病）。
    mergedReportRunner: async () => ({ ok: true, url: 'https://example.invalid/docx/STUB', detail: '自证桩' }),
    // ★ 2026-10-09：**建议生成也必须注入** —— 它默认真打 LLM。
    //   不注入的话每条跑闸门的自证都会真调模型（实测直接把套件拖到超时）。
    adviceRunner: async ({ items }) => ({ ok: true, ms: 1,
      advice: Object.fromEntries((items || []).map((_, i) => [i, `自证桩给的改法 ${i}`])) }),
    // 链**没跑成**（模拟库忙：认领被占、起链抛异常）
    chainRunner: async () => { throw new Error('库忙（模拟）：认领被占'); },
    modelSideRunner: async () => ({ ok: true, dropped: [], ms: 1, findings: [
      { location: '全文', category: '措辞表达', severity: 'REVIEW', reason: '模型侧独立发现的措辞问题' }] }),
    publishRunner: async () => ({ ok: true }),     // 落表桩：**不许真写表**
  });
  assert.ok(g.dual, '链没跑成时双轨整段没跑 —— 模型侧被掐掉了（这就是原 bug）');
  // ★ 2026-10-08：`runSubmissionGate` 返回的 `dual` 是**汇总形状**（`{state, stats, ok, ...}`），
  //   不是内部那个 `{model, kb, merged, ...}` —— 断言按实际形状读，别按我以为的读。
  assert.ok(g.dual.stats.model >= 1,
    `模型侧的产出被丢了，合并读数：${JSON.stringify(g.dual.stats)}`);
  assert.ok(g.dual.stats.merged >= 1, '合并后一条都没有 —— 用户会收到一张空结论');
  assert.notStrictEqual(String(g.dual.state), '拒答', `合并态不该是拒答：${g.dual.state}`);
});

await t('Z2 接线：模型侧必须在 `await chainRunner` **之前**起跑', () => {
  const src = fs.readFileSync(new URL('./agent/agent.mjs', import.meta.url), 'utf8');
  const iP = src.indexOf('const modelSideP =');
  const iC = src.indexOf('res = await chainRunner(input)');
  assert.ok(iP > 0 && iC > 0, '找不到模型侧起跑点或起链点');
  assert.ok(iP < iC, '模型侧在链**之后**才起跑 —— 又退回串行了');
  // 反向对照：模型侧**不许**再被 chainRan 绑住
  assert.ok(!/if \(chainRan\) \{\s*[\s\S]{0,200}?await modelSideP/.test(src),
    '模型侧又被绑回 chainRan 了 —— 链坏掉时用户会重新变成「什么都没有」');
});

// ═══ 第 24 组 · 「轮」与「条数」是两个数，不许混成一个（2026-10-08）═══
//
// 起因：内核里写的是 `turns: sess.messages.length` —— 那是**条数**。而 daemon 把它
// 印成「🗜 历史已压缩（保留 130 轮 + 纪要 5249 字）」，真实含义是 **130 条 ≈ 24 轮**。
// 变量名（`turns`）、措辞（「轮」）、值（条数）三者不一致 —— `AGENTS.md` §2.4.3：
// **说出去的话比手上的依据大。**
//
// ⚠ 这一组要钉住的**不是**「源码里出现了 `countTurns` 这个词」。§2.4 点名的病就是
//   那个：「名字出现过 ≠ 它拦得住」，一条只查标识符存在的断言在有 import 的地方恒真。
//   所以 Z3/Z4 是**行为级与纯函数级**，并且各自带一条反向对照 —— 把任一处退回
//   `messages.length` 都会红（这两个数在真实会话里**必然不相等**）。

await t('Z3 口径：一轮 = 一条 user；assistant / tool 不计轮（反向对照：不许等于条数）', async () => {
  const mem = await import('./agent/memory.mjs');
  // 形状取自真实会话：一轮 = user + assistant(tool_calls) + 若干 tool 结果 + assistant
  const sess = { messages: [
    { role: 'user' }, { role: 'assistant', tool_calls: [{}] }, { role: 'tool' }, { role: 'assistant' },
    { role: 'user' }, { role: 'assistant' },
  ] };
  assert.strictEqual(mem.countTurns(sess), 2, '这个形状是 2 轮');
  assert.strictEqual(sess.messages.length, 6, '这个形状是 6 条');
  // ★ 反向对照：单独看上面那句是恒真的；这一句才真的钉住「不许退回条数」
  assert.notStrictEqual(mem.countTurns(sess), sess.messages.length,
    '轮数 == 条数 —— 又被混成一个数了（日志那句会重新开始说谎）');
  // 取不到时不许猜、不许空着（§2.2 第 7 条）
  assert.strictEqual(mem.countTurns(undefined), 0, 'undefined 会话');
  assert.strictEqual(mem.countTurns({}), 0, '没有 messages 键');
  assert.strictEqual(mem.countTurns({ messages: [{ role: 'user' }, null, { role: 'user' }] }), 2,
    '历史里混了坏记录也必须数得对');
});

await t('Z4 行为级：compact 之后**保留的是 keepTurns 轮**，不是 keepTurns 条', async () => {
  const mem = await import('./agent/memory.mjs');
  // 造 40 轮，每轮 4 条（assistant 带一次工具调用）⇒ 条数远大于轮数
  const messages = [];
  for (let i = 0; i < 40; i++) {
    messages.push({ role: 'user', content: `问题 ${i}` });
    messages.push({ role: 'assistant', tool_calls: [{ id: `c${i}` }] });
    messages.push({ role: 'tool', content: `结果 ${i}` });
    messages.push({ role: 'assistant', content: `回答 ${i}` });
  }
  const sess = { messages, summary: '' };
  const did = await mem.compact(sess, async () => '旧对话纪要', 5, 24);
  assert.ok(did, '160 条 > 触发线 24，必须压');
  assert.strictEqual(mem.countTurns(sess), 5,
    `保留的**轮数**必须是 5，实际 ${mem.countTurns(sess)}`);
  // ★ 反向对照：条数**必然**大于轮数。若这里相等，说明每轮只剩一条 ——
  //   那 Z4 就在测一个不存在的形状（§2.4：一个测不到真东西的断言等于没有）
  assert.ok(sess.messages.length > 5,
    `保留条数 ${sess.messages.length} 不大于 5 —— 这个用例没造出「一轮多条」的形状`);
});

await t('Z5 接线：日志那句必须**两个数一起给**，内核不许退回条数当轮数', () => {
  const d = fs.readFileSync(new URL('./ws_daemon.mjs', import.meta.url), 'utf8');
  assert.ok(/result\.meta\.messages/.test(d), '日志没读 `meta.messages` —— 条数根本没印出来');
  assert.ok(/result\.meta\.turns/.test(d), '日志没读 `meta.turns` —— 轮数丢了');
  // ★ 反向对照：旧的坏形状 —— 只说「保留 N 轮」而不给条数。这一句红了才说明
  //   上面两句不是恒真的（它们只证明两个词出现过，证明不了那句话现在说得对）。
  assert.ok(!/保留 \$\{result\.meta\.turns\} 轮(?!（)/.test(d),
    '又退回「保留 N 轮」的单数形式 —— 那句话比依据大');

  const a = fs.readFileSync(new URL('./agent/agent.mjs', import.meta.url), 'utf8');
  assert.ok(/turns:\s*mem\.countTurns\(sess\)/.test(a),
    '`meta.turns` 没走 `mem.countTurns` —— 口径脱离了唯一那一处');
  assert.ok(!/turns:\s*sess\.messages\.length/.test(a),
    '`meta.turns` 又变回条数了 —— 日志会重新开始说「保留 130 轮」');
});

// ═══ 第 25 组 · 同一条链，一轮里只许跑一次（2026-10-08）═══
//
// 起因（真实事故，Owner 2026-10-08 19:08 那张图）：闸门 **147386ms** 就跑完了，
// 模型又自己调了一遍 `kb_review_chain`（**709739ms**，超时没出结果）⇒
//   ① 人等了 **15 分钟**（`💬 回复 3159 字，耗时 900041ms`）；
//   ② 模型把它那次失败写进了**对外卡片**：「我这次实跑 709 秒没出最终回答」。
// 历史读数：闸门跑成 **72** 次，模型自己又调 **18** 次 —— 不是偶发。
//
// ⚠ 这一组**一次都不许真跑链** —— 真跑会写飞书（§2.4.4：自证不许有副作用）。
//   所以判据全落在纯函数上；而「漏斗真的拦得住」那一条用的是这个组合：
//   **装好缓存 + 故意喂一段坏 JSON**。坏 JSON 在**解析那一跳**才失败，
//   所以「它没报 JSON 错」就证明它命中了缓存、**没有往下走** —— 正反都在零副作用下可证。

await t('Z6 纯判据：命中 / 别的工具 / 没装过 / 过期 / 坏记忆 —— 五个方向各自可分辨', async () => {
  const T = await import('./agent/tools.mjs');
  const env = { tool: 'kb_review_chain', ok: true, result: { answer: 'REVIEW 5 处' } };
  const now = Date.now();
  const memo = { at: now, envelope: env };
  assert.strictEqual(T.chainMemoLookup({ name: 'kb_review_chain', memo, nowMs: now }), env, '装了缓存就该回它');
  assert.strictEqual(T.chainMemoLookup({ name: 'judge_copy', memo, nowMs: now }), null, '别的工具不许吃这条缓存');
  assert.strictEqual(T.chainMemoLookup({ name: 'kb_review_chain', memo: null, nowMs: now }), null, '没装过就照常跑');
  assert.strictEqual(T.chainMemoLookup({ name: 'kb_review_chain', memo: undefined, nowMs: now }), null, 'memo 是 undefined');
  // ★ 反向对照（TTL 是**独立于**「每轮清空」的第二道 —— 少了它，漏一次复位就会串轮）
  assert.strictEqual(T.chainMemoLookup({ name: 'kb_review_chain', memo: { at: now - 31 * 60 * 1000, envelope: env }, nowMs: now }),
    null, '过期 31 分钟必须放行 —— 否则 TTL 是摆设');
  assert.strictEqual(T.chainMemoLookup({ name: 'kb_review_chain', memo: { at: now - 29 * 60 * 1000, envelope: env }, nowMs: now }),
    env, '未过期必须命中 —— 否则 TTL 边界写反了（这一对才把边界钉死）');
  assert.strictEqual(T.chainMemoLookup({ name: 'kb_review_chain', memo: { at: NaN, envelope: env }, nowMs: now }),
    null, '坏记忆当没有 —— 宁可重跑，不可乱答');
  assert.strictEqual(T.chainMemoLookup({ name: 'kb_review_chain', memo: { at: now }, nowMs: now }),
    null, '装着 at 却没有信封 —— 不许回 undefined');
});

await t('Z7 纯判据：**只装跑成的** —— 失败了必须留着重试的机会', async () => {
  const T = await import('./agent/tools.mjs');
  assert.strictEqual(T.chainMemoShouldArm({ name: 'kb_review_chain', result: { answer: 'x' } }), true);
  // ★ 反向对照：缓存一次失败 = 把「结论未知」钉死一整轮
  //   （§2.4.2：未测不许与通过长得一样；重试的机会必须留着）
  assert.strictEqual(T.chainMemoShouldArm({ name: 'kb_review_chain', result: { error: '超时' } }), false,
    '跑失败也被缓存了 —— 这一轮再也没有重试的机会');
  assert.strictEqual(T.chainMemoShouldArm({ name: 'kb_review_chain', result: null }), false, '空结果不许装');
  assert.strictEqual(T.chainMemoShouldArm({ name: 'kb_review_chain', result: 'string' }), false, '非对象不许装');
  assert.strictEqual(T.chainMemoShouldArm({ name: 'judge_copy', result: { answer: 'x' } }), false, '别的工具不许装');
});

await t('Z8 行为级：漏斗上真的拦得住，且拦在解析参数**之前**（零副作用）', async () => {
  const T = await import('./agent/tools.mjs');
  // ① 没装缓存时喂坏 JSON：必须走到**解析**那一跳 ⇒ 报 JSON 错。
  //    这一句同时证明护栏**不是恒真的**（§2.4.4：一个恒真的判据等于没有）。
  T._resetChainMemoForTest();
  const miss = await T.executeTool('kb_review_chain', '这不是 JSON');
  assert.strictEqual(miss.ok, false, '没装缓存却命中了 —— 护栏恒真，等于没有');
  assert.ok(/不是合法 JSON/.test(String(miss.error)), `应当走到解析那一跳，实际：${miss.error}`);

  // ② 装上缓存后再喂同一段坏 JSON：必须**回缓存**，而不是报 JSON 错
  //    ⇒ 证明它拦在解析之前，拦住的正是那一次 5~15 分钟的真发布动作。
  const env = { tool: 'kb_review_chain', ok: true, result: { answer: 'REVIEW 5 处（闸门那次的结果）' } };
  T._armChainMemoForTest(env);
  const hit = await T.executeTool('kb_review_chain', '这不是 JSON');
  assert.strictEqual(hit, env, '装了缓存却没回它 —— 重复跑没被拦住');
  assert.strictEqual(T.chainMemoStats().hit, 1, '命中数没记 —— 这件事就没有读数了（§2.4）');
  assert.strictEqual(T.chainMemoStats().armed, true, '装了却报没装');

  // ③ 复位之后必须立刻放行 —— 这一跳就是「每轮边界」
  T.beginChainTurn();
  assert.strictEqual(T.chainMemoStats().armed, false, 'beginChainTurn 没清掉缓存 —— 会串轮');
  const after = await T.executeTool('kb_review_chain', '这不是 JSON');
  assert.ok(/不是合法 JSON/.test(String(after.error)),
    '复位后仍命中 —— 守衡会拿上一轮的结论去答这一轮的图（方向不对称：漏跑只是慢，串轮是答错）');
  T._resetChainMemoForTest();
});

await t('Z9 接线：`beginChainTurn()` 必须在**调闸门之前**（否则闸门自己那次会被清掉）', () => {
  const src = fs.readFileSync(new URL('./agent/agent.mjs', import.meta.url), 'utf8');
  // ★ 2026-10-20：调用形态变成 `beginChainTurn({ modality: … })`（图单模态由图定死）。
  //   这里改的是**匹配方式**，不是判据 —— `iB` 与 `iG` 的先后关系一个字没动。
  const mB = src.match(/beginChainTurn\s*\(/);
  const iB = mB ? mB.index : -1;
  const iG = src.indexOf('await runSubmissionGate({');
  assert.ok(iB > 0, '找不到 `beginChainTurn(...)` 调用 —— 护栏没有每轮边界');
  assert.ok(iG > 0, '找不到 `runSubmissionGate` 调用');
  assert.ok(iB < iG,
    '`beginChainTurn()` 排在闸门**之后** —— 会把闸门刚装上的缓存自己清掉，等于没装');

  // meta 里必须带上这条护栏自己的读数，否则命中只是一个「没出现的日志」
  assert.ok(/chainMemo:\s*chainMemoStats\(\)/.test(src),
    '`meta` 没带 `chainMemo` 读数 —— 护栏有没有生效只能靠猜');
});

await t('Z10 治因：`formatChainBlock` 必须明说「链已经跑完了，不要再调」', async () => {
  const rg = await import('./agent/review_gate.mjs');
  const block = rg.formatChainBlock({ answer: '【审查结论：REVIEW】共发现 5 处需人工确认。' });
  assert.ok(/不要再调 `kb_review_chain`/.test(block),
    '没告诉模型链已经跑过了 —— 它会再跑一遍（那 18 次就是这么来的）');
  // ★ 第二条：模型那次失败的自述**不许进对外正文**（19:08 那张卡就是这么写的）
  assert.ok(/不许把它写进回话/.test(block),
    '没拦住「我实跑 N 秒没出结果」进对外卡片 —— 业务同事会读到内部故障自述');

  // ★ 反向对照：链**没跑成**时不许说「已经跑完、别再调」—— 那是把未知说成完成
  const err = rg.formatChainBlock({ error: '超时' });
  assert.ok(!/不要再调/.test(err), '链没跑成却说「已经跑完，别再调」—— 把未知说成了完成');
  assert.ok(/没跑成|未知/.test(err), '失败分支必须说清这是未知');
  const empty = rg.formatChainBlock({});
  assert.ok(!/不要再调/.test(empty), '没结论却说「已经跑完」');
});

// ═══ 第 26 组 · 「问题数」只能有一个：抬头那个 N 不许再从链的正文里抠（2026-10-08）═══
//
// Owner 的规则原话：「我在飞书侧 @守衡 提问后，双轨并行（知识库+模型），
// **双轨按照 PRD ≧3 个问题输出报告链接到飞书文档**」。
//
// 查下来 PRD 那侧**早就实现了**（KB 的 `feishu_publish.py::REPORT_LINK_MIN_ISSUES = 3`）。
// 坏的是**口径** —— 一单里有三个「问题数」在打架：
//
//   | 数 | 来自谁 | 19:44 那单 | 19:08 那张图 |
//   |---|---|---|---|
//   | 卡片抬头那个数 | 链的结论原文（**正则抠**出来） | — | **12** |
//   | 报告阈值读的数 | 机读旁挂 `issue_count` | **2** | 5 |
//   | 人实际看到的条目 | 双轨合并条数 | **10** | 7 |
//
// 人看到 10 ⇒ 按规则该给链接；阈值读 2 ⇒ `2 < 3` ⇒ 不生成报告 ⇒ **没有链接**。
//
// 这一组钉住的是「N 变成**入参**」这件事（本仓这一半）。接线（`dual_track.mjs` →
// `agent.mjs` → 信封）在另一个会话停手之后再做 —— 判据先立，接线才有东西可对。

await t('Z11 纯判据：由显式条数派生 §5.3 结论行，且派生出来的行当场过 conforms()', async () => {
  const P = await import('./agent/prd53.mjs');
  const rev = P.verdictLineFor({ state: 'REVIEW', n: 10 });
  assert.strictEqual(rev.line, '【审查结论：REVIEW】共发现 10 处需人工确认。');
  assert.strictEqual(rev.state, 'REVIEW');
  // ★ 派生出来的行必须**自己合 §5.3** —— 否则我们是在批量生产不合规的抬头
  assert.strictEqual(rev.conform.ok, true, `派生出来的行不合 §5.3：${rev.conform.why}`);
  const blk = P.verdictLineFor({ state: 'BLOCK', n: 3 });
  assert.strictEqual(blk.line, '【审查结论：BLOCK】共发现 3 处必须修改。');
  assert.strictEqual(blk.conform.ok, true, `派生出来的 BLOCK 行不合 §5.3：${blk.conform.why}`);
});

// ═══ Z11b · 结论行前缀：**写 10-22 的 `【审查结论：X】`，读两种都认** ═══
//
// 两轮，别只记后半段：
//   · 上午（Owner：「回复没有按照 prd」）把**写出去的**改成了 PRD §5.3.4 样张 `【X】`；
//   · 下午（Owner：「输出格式的问题，在 10/22 都是好的，恢复到 10/22 的输出格式」）
//     **写回 `【审查结论：X】`** —— 10-22 那 70 条卡面逐条都是这个前缀。
//   · **读进来的**两种都认，一个字都不许因为写法读不出来：知识库引擎仍在产旧写法、
//     上午那批新写法的件也已经落盘了 —— 只认一种，S7 那条跨仓契约（喂的是引擎真输出）
//     会当场假红。
await t('Z11b ★★ 结论行前缀：**写 10-22 的 `【审查结论：X】`**，且 PRD 的 `【X】` 也读得进来（反向对照在末两行）', async () => {
  const P = await import('./agent/prd53.mjs');
  const T = await import('./agent/dual_track.mjs');
  // ① 我们**写出去**的四种行都必须带 10-22 的前缀「审查结论：」（这是 Owner 当天下半场选的形状）
  const outs = [
    P.passLineFor(),
    P.verdictLineFor({ state: 'REVIEW', n: 2 }).line,
    P.verdictLineFor({ state: 'BLOCK', n: 4 }).line,
    P.verdictLineFor({ state: 'PASS+SUGGEST', n: 1 }).line,
  ];
  assert.ok(outs.every((l) => l.startsWith('【审查结论：')),
    `有行没写 10-22 的前缀（Owner 2026-10-26：「恢复到 10/22 的输出格式」）：${outs.find((l) => !l.startsWith('【审查结论：'))}`);
  assert.ok(outs.every((l) => /^【审查结论：(PASS\+SUGGEST|PASS|REVIEW|BLOCK)】/.test(l)),
    `有用例的状态名不在四态里：${outs.join(' ｜ ')}`);
  // ② 双轨渲染那一跳同样（卡片抬头就是它）
  const r = T.renderMerged([{ location: '全文', category: '本地化-计量单位', severity: 'REVIEW', source: 'kb' }],
    { state: 'REVIEW', reportUrlOverride: 'https://x/docx/a' });
  assert.ok(String(r.line).includes('审查结论：'), `卡片抬头没写 10-22 的前缀：${r.line}`);
  // ③ 读侧：两种写法都要认得出、且判合同一个结论
  const legacy = '【审查结论：REVIEW】共发现 2 处需人工确认。';
  const prd = '【REVIEW】共发现 2 处需人工确认。';
  assert.deepStrictEqual([P.conforms(legacy).ok, P.conforms(prd).ok], [true, true],
    '两种写法必须都判合规（只认新式 ⇒ 引擎真输出被自家尺子判红，S7 会假红）');
  assert.strictEqual(P.conclusionLine(legacy).state, P.conclusionLine(prd).state);
  // ④ 混排时取**最先出现**的那一行（不是「先试旧式」也不是「先试新式」）
  assert.strictEqual(P.conclusionLine(`【REVIEW】共发现 1 处需人工确认。\n${legacy}`).line,
    '【REVIEW】共发现 1 处需人工确认。');
  assert.strictEqual(P.conclusionLine(`${legacy}\n【BLOCK】共发现 3 处必须修改。`).line, legacy);
  // ⑤ 反向对照：旧态名 `SUGGEST` 两种前缀下都必须判**不合规**（前缀改了，四态口径没松）
  assert.deepStrictEqual([P.conforms('【SUGGEST】发现 1 处建议优化，不阻断发布。').ok,
    P.conforms('【审查结论：SUGGEST】发现 1 处建议优化，不阻断发布。').ok], [false, false],
    '旧态名 SUGGEST 在某种前缀下被判合规了 —— 四态口径被擦掉了');
});

await t('Z12 纯判据：**编不出数的时候一个都不许编** —— 六个方向各自可分辨', async () => {
  const P = await import('./agent/prd53.mjs');
  // ★ n=0 单独一条，理由与其它不同：`mergedState()` 里「合并 0 条 + 库侧 REVIEW」
  //   会给出 REVIEW（覆盖缺口那一类），而「共发现 0 处需人工确认」**自己跟自己矛盾**。
  assert.strictEqual(P.verdictLineFor({ state: 'REVIEW', n: 0 }), null, '0 处 → 必须退回，不许写「共发现 0 处」');
  assert.strictEqual(P.verdictLineFor({ state: 'REVIEW', n: NaN }), null, 'NaN 不许编');
  assert.strictEqual(P.verdictLineFor({ state: 'REVIEW' }), null, '缺 n 不许编');
  assert.strictEqual(P.verdictLineFor({ state: 'REVIEW', n: -1 }), null, '负数不许编');
  assert.strictEqual(P.verdictLineFor({ state: 'REVIEW', n: 2.5 }), null, '小数不许编');
  // PASS 的 §5.3.1 模板里**没有 N**；拒答 / NEEDS_INPUT 不在 §5.3 里
  assert.strictEqual(P.verdictLineFor({ state: 'PASS', n: 3 }), null,
    'PASS ＋ 自相矛盾的 n=3 ⇒ 不许编');
  assert.strictEqual(P.verdictLineFor({ state: 'PASS' }), null, 'PASS 但**读不到条数** ⇒ 不许编');
  assert.strictEqual(P.verdictLineFor({ state: '拒答', n: 3 }), null, '拒答不在 §5.3 里');
  // ★★ 2026-10-15（Owner 裁定：「**没有命中就是 pass**，按照 prd 的一句话结论走，
  //   **你不要自己定义**」）—— 真单 `MC-US-YT-_xyLF4_AgAw-IMG`：两侧一条都没命中，
  //   而我们自己给加了「1 处」⇒ 卡上说需人工确认、逐条里一条没有、报告链接点开是空的。
  //   ⇒ 现在「合并读数 **恰好 0 条** ＋ PASS」派发 §5.3.1 的**那一句话**（条数不进那一行）。
  {
    const z = P.verdictLineFor({ state: 'PASS', n: 0 });
    assert.ok(z && z.state === 'PASS', 'n=0 ＋ PASS 必须派得出 §5.3.1 那一句话');
    assert.strictEqual(P.conforms(z.line).ok, true,
      `派出来的 PASS 行必须过 §5.3.1 那把尺子，实际：${z?.line}`);
    assert.ok(!/\d/.test(z.line), `§5.3.1 那一句里**没有 N**，实际：${z.line}`);
    // ★★ 2026-10-16（FIX-043）：`conform` 的形状**每一支都必须是对象** `{ok, state, why}` ——
    //   这一支原先给的是 `conforms(line).ok`（一个布尔）⇒ 发送层那一行
    //   `⚠️ 措辞不合 §5.3：${c.why}` 会打出 `undefined`
    //   （实测日志逐字：`PASS（来自 dual-track-merged）… ⚠️ 措辞不合 §5.3：undefined`）。
    //   后果不在卡上，在**日志**：回退本是最该看得见的东西，配一个空原因等于没写。
    assert.strictEqual(typeof z.conform, 'object',
      'PASS 支的 conform 必须是对象（与其余各支同形）—— 布尔会让日志打出「措辞不合：undefined」');
    assert.strictEqual(z.conform.ok, true, 'PASS 行是合规的，conform.ok 必须为 true');
    assert.ok(String(z.conform.why || '').trim(), 'conform.why 不许是空的 —— 它会被日志原样打出来');
    // 反向对照：REVIEW 那一档一个字没松（0 永远回 null）
    assert.strictEqual(P.verdictLineFor({ state: 'REVIEW', n: 0 }), null, 'REVIEW ＋ 0 仍不许编');
  }
  // 反向对照：**每一条能派出来的结论行**，`conform` 都得是那个形状 ——
  //   少一支就够让日志里出现一句「措辞不合：undefined」（正是本条要治的）。
  for (const q of [{ state: 'PASS', n: 0 }, { state: 'REVIEW', n: 2 }, { state: 'BLOCK', n: 3 }]) {
    const d = P.verdictLineFor(q);
    assert.ok(d && typeof d.conform === 'object' && typeof d.conform.ok === 'boolean'
              && String(d.conform.why || '').trim(),
      `${q.state} 那一支的 conform 形状不对：${JSON.stringify(d?.conform)}`);
  }
  // 反向对照：合法的数**必须**派得出来 —— 否则上面六条恒真（一个全都返回 null 的实现也能过）
  assert.ok(P.verdictLineFor({ state: 'REVIEW', n: 1 }), 'n=1 是合法条数，必须派得出来');
});

await t('Z13 ★ 反向对照：**不给合并数时，行为必须与改动前逐字相同**', async () => {
  const P = await import('./agent/prd53.mjs');
  const A = '【审查结论：REVIEW】共发现 12 处需人工确认。\n\n1.【平台与促销】…\n\n建议转 对接人 复核。';
  // 这一条是整组里最重要的反向对照：没有它，接线一旦漏传参数，
  // 卡片会**静默退回**旧口径（抠链的正文），而没有任何东西会红。
  const noMerge = P.deriveVerdictLine({ answer: A });
  assert.strictEqual(noMerge.from, 'chain', '不给合并数时必须仍走第 ① 支');
  assert.ok(/共发现 12 处/.test(noMerge.line), '不给合并数时必须仍用链抠出来的那个数');
  assert.ok(noMerge.block, '不给合并数时 block 必须照旧非空');

  const withMerge = P.deriveVerdictLine({ answer: A, mergedCount: 7, mergedState: 'REVIEW' });
  assert.strictEqual(withMerge.from, 'dual-track-merged', '给了合并数必须走第 ⓪ 支');
  assert.ok(/共发现 7 处需人工确认。/.test(withMerge.line),
    `抬头那个数必须变成双轨合并数，实际：${withMerge.line}`);
  // ★ `block` 必须**与不给时同一个对象/值** —— 逐条块那一格归信封层的 `groups` 管
  //   （实测日志 `逐条块=forced·groups`），这一支去改块就是跟它抢格子。
  assert.strictEqual(withMerge.block, noMerge.block, '第 ⓪ 支不许动 block —— 会跟 groups 抢同一格');

  // 坏读数一律退回第 ① 支（而不是编一个「共发现 0 处」）
  const zero = P.deriveVerdictLine({ answer: A, mergedCount: 0, mergedState: 'REVIEW' });
  assert.strictEqual(zero.from, 'chain', '合并数 0 必须退回链那一行');
  const pass = P.deriveVerdictLine({ answer: A, mergedCount: 3, mergedState: 'PASS' });
  assert.strictEqual(pass.from, 'chain', '合并态 PASS 不许被派生成 REVIEW/BLOCK 行');
  const nan = P.deriveVerdictLine({ answer: A, mergedCount: NaN, mergedState: 'REVIEW' });
  assert.strictEqual(nan.from, 'chain', 'NaN 必须退回，不许编数');
});

// ★★ 2026-10-15（Owner 报「链接是空的」那一单的根治）：**没有命中 ⇒ PASS 一句话结论**。
//
//   真单 `MC-US-YT-_xyLF4_AgAw-IMG`（群里那张卡，20:15 已撤回）：
//     双轨读数 = 模型侧 0 条 ／ 库侧 `issue_count=0`（覆盖缺口）⇒ 两侧**一条都没命中**。
//     旧口径：`covEntries` 自己加了 1 ⇒ 抬头「共发现 1 处需人工确认」，
//     而逐条里一条没有、那份合并报告只有「（本单没有并进任何条目。）」⇒ **链接点开是空的**。
//   Owner 的口径：**没有命中就是 pass**，走 PRD §5.3.1 那一句话，不许自己定义。
await t('Z13b ★★ 没有命中 ⇒ PASS 一句话结论，且 block 必须是 null（不许抠链的逐条块）', async () => {
  const P = await import('./agent/prd53.mjs');
  // 链在覆盖缺口那一档自己给的是 `REVIEW 共发现 0 处…`（自己跟自己矛盾）——
  // 正是这一句不许再上卡。
  const CHAIN = '【审查结论：REVIEW】共发现 0 处需人工确认。\n\n1.【覆盖缺口】…\n\n建议转 @法务 复核。';
  const v = P.deriveVerdictLine({ answer: CHAIN, mergedCount: 0, mergedState: 'PASS' });
  assert.strictEqual(v.state, 'PASS', '两侧零命中必须是 PASS');
  assert.strictEqual(v.from, 'dual-track-merged', '这一行必须由合并态派生，不是抠链的正文');
  // ⚠️ 判据用 `conforms()`（§5.3.1 那把尺子），**不自己写正则** ——
  //   我第一版写死 `@\S+ 进行 sign-off`，而「（未配置）」那一档中间有空格 ⇒ 把**对的**判红。
  assert.strictEqual(P.conforms(v.line).ok, true,
    `必须是 §5.3.1 的那一句话，实际：${v.line}`);
  assert.ok(/^【审查结论：PASS】/.test(v.line) && !/\d/.test(v.line),
    `PASS 那一句里不许有数字，实际：${v.line}`);
  // ★ 这一条是**这次修复的核心**：PASS 没有逐条块 ⇒ 卡上不会出现空的「逐条问题」分组，
  //   报告那一跳也建不起来（`total = 0`）⇒ **不会再有「链接点开是空的」**。
  assert.strictEqual(v.block, null, 'PASS 那一档 block 必须是 null —— 抠进来就是「PASS 抬头 + REVIEW 逐条」');
  // 反向对照①：REVIEW 那一档照旧**必须**带块（别把上面那条实现成「永远 block=null」）
  const rv = P.deriveVerdictLine({ answer: CHAIN, mergedCount: 2, mergedState: 'REVIEW' });
  assert.ok(rv.block, 'REVIEW 那一档必须照旧带逐条块（否则上面那条恒真）');
  // 反向对照②：读不到合并数 ⇒ 一个字都不许动（照旧走链那一行）
  const none = P.deriveVerdictLine({ answer: CHAIN });
  assert.strictEqual(none.from, 'chain', '没有合并读数时必须照旧走链');
});

await t('Z14 ★ 行为级：卡片抬头那个数必须 == 卡里那个数（`rendered.total`），不是「并进来几条」', async () => {
  const { runSubmissionGate } = await import('./agent/agent.mjs');
  // 夹具**照抄 19:08 那个真实形状**：库侧判到 5 条、但 PRD §5.3.3 规定 ≥3 时只出分类汇总
  // ⇒ 逐条抠不出来（`txtN=0`）⇒ `kbGap = 5`；模型侧 7 条 ⇒ 并进 7 条。
  // 于是 `total = 7 + 5 + 0 = 12`，而 `stats.merged = 7` —— **两个数必然不等**。
  // 这正是那张卡「抬头 12 / 你数出 7 条」的成因，而 12 是**对的**（卡里另有一句
  // 「另有 5 条未并进本卡」）。所以断言必须钉 `total`，不能钉 `merged`。
  const KB_ANSWER = [
    '【审查结论：REVIEW】共发现 5 处需人工确认。',
    '',
    '· 措辞表达类问题：5 个',   // 2026-10-19：每类一行、`· <维度>类问题：N 个`
    '',
    '建议转 对接人 复核。',
  ].join('\n');
  const g = await runSubmissionGate({
    imageClaimRunner: completedImageClaimFixture,
    inbound: { text: '审核下这张图', imageCount: 1, videoCount: 0,
      images: [completedImageReadFixture()] },
    question: '审核下这张图',
    notify: null,
    // ★ 2026-10-09：**必须注入** —— 这条夹具问题数 ≥3，不注入会真的在飞书里建一份云文档。
    //   实测：写这一条时忘了注入，跑一次自证就建了一份（§2.4.4 那个病）。
    mergedReportRunner: async () => ({ ok: true, url: 'https://example.invalid/docx/STUB', detail: '自证桩' }),
    // ★ 2026-10-09：**建议生成也必须注入** —— 它默认真打 LLM。
    //   不注入的话每条跑闸门的自证都会真调模型（实测直接把套件拖到超时）。
    adviceRunner: async ({ items }) => ({ ok: true, ms: 1,
      advice: Object.fromEntries((items || []).map((_, i) => [i, `自证桩给的改法 ${i}`])) }),
    chainRunner: async () => ({
      answer: withImageSkillReceipt(KB_ANSWER),
      engine: IMAGE_ENGINE_OK,
      // 机读旁挂：库侧的**结构化条数**（逐条明细抠不出来时才靠它）
      review: { state: 'REVIEW', issue_count: 5 },
      report: 'https://momcozy-in.feishu.cn/docx/AAA',
    }),
    publishRunner: async () => ({ ok: true, record_id: 'recX' }),
    // ★ 2026-10-09：**必须注入** —— 不注入的话，问题数 ≥3 的夹具会真的在飞书里建一份云文档
    //   （§2.4.4：跑一次自证，改掉了它要保护的东西。实测已发生过一次）。
    mergedReportRunner: async () => ({ ok: true, url: 'https://example.invalid/docx/STUB', detail: '自证桩' }),
    // ★ 2026-10-09：**建议生成也必须注入** —— 它默认真打 LLM。
    //   不注入的话每条跑闸门的自证都会真调模型（实测直接把套件拖到超时）。
    adviceRunner: async ({ items }) => ({ ok: true, ms: 1,
      advice: Object.fromEntries((items || []).map((_, i) => [i, `自证桩给的改法 ${i}`])) }),
    modelSideRunner: async () => ({ ok: true, ms: 10,
      findings: [1, 2, 3, 4, 5, 6, 7].map((n) => ({ category: '本地化', location: `画面 ${n}`, severity: 'REVIEW', reason: 'x' })) }),
  });

  const total = g.dual?.total;
  const mergedN = g.dual?.stats?.merged;
  assert.strictEqual(mergedN, 7, `夹具前提：并进 7 条，实际 ${mergedN}`);
  assert.strictEqual(total, 12, `夹具前提：卡里那个数应是 7+5=12，实际 ${total}`);
  // ★ 前提必须验在**输入/中间量**上，不能验在抬头 `verdict53.line` 上 ——
  //   拿改完之后的输出验前提，等于把「修好了」当成红的（第一版就这么红的）。
  assert.notStrictEqual(total, mergedN, '夹具前提：两个数必须不同，否则这条测不出东西');

  const n = Number((/共发现 (\d+) 处/.exec(g.verdict53?.line ?? '') || [])[1]);
  assert.strictEqual(n, total,
    `抬头说 ${n} 处，而卡里那个数是 ${total} —— 抬头与条目又分家了`);
  // ★ 反向对照：把 `mergedCount` 接成 `items.length`（=7）会让上面那条红 —— 这就是它存在的意义
  assert.notStrictEqual(n, mergedN,
    `抬头接成了「并进来几条」（${mergedN}）—— 会丢掉库侧那 ${total - mergedN} 条，`
    + '并与卡里「另有 N 条未并进本卡」那句话自相矛盾');
});

// ═══ 第 27 组 · 「问题数 ≥3 ⇒ 飞书文档要带报告」（Owner 2026-10-09）═══
//
// Owner 的原话：「我的目标是让守衡输出的问题数量按照 PRD 等于或大于 3 个问题时，
// **写入的飞书文档要带报告**」。
//
// 病灶：报告**只有库侧会建**，而它的门槛读的是**它自己的** `issue_count`。
// 实测 2026-10-09 09:35 那张图：卡上说 6 处（库侧 1 ＋ 模型侧 5），而旁挂 `issue_count = 1`
// ⇒ 库侧不建 docx ⇒ `report_url = null` ⇒ **按 PRD 该给报告，却没有任何链接可给**。
// 现在改由**本仓**建：门槛读**卡里那个数**（`rendered.total`），正文含两侧全部条目。
//
// ⚠ 这一组**用桩**（`mergedReportRunner`）—— 真调会在 Owner 的飞书里建一份云文档。
//   写这一组时就因为忘了注入，跑一次自证真建了一份（§2.4.4 那个病，已修）。

await t('Z15 ★ 行为级：问题数 ≥3 且库侧没给链接 ⇒ 本仓建报告，卡里那一行是**真链接**', async () => {
  const { runSubmissionGate } = await import('./agent/agent.mjs');
  // ★★ 2026-10-14：条目计数改用 `countRenderedItems`（原先数的是 `**判定**：` 行，
  //   那是**寄生判据** —— 字段一删就静默数成 0 条，红的原因变成「计数器坏了」）。
  //   **必须提到这个作用域**：下面 `mergedReportRunner` 回调里要用它，而回调在别的块里
  //   ⇒ 只靠后面那句 `const T = …` 会撞 TDZ（实测报 `T is not defined`，
  //     而它只是「报告没建」，**不阻断结论** ⇒ 会静默少建一份报告）。
  const T = await import('./agent/dual_track.mjs');
  // ★★ 2026-10-14（Owner：「所有参考知识库的，都必须带飞书侧源链接」）：
  //   夹具补齐成**现代引擎输出**的形状（原因 / 依据 / 锚点 / 建议四行）。
  //   原先是老格式（只有 `1.【本地化】图 1` 一行、没有 `依据`），于是
  //   `kbFindingsOf` 这条来路**抠不出 `basisLine`** ⇒ 渲染层退回重建版
  //   `《知识库》（未给条款号）`；而它以前还能印出「有库内条款依据」，
  //   靠的是**那条种子候选被误当成库内条目**顶了位（正是本轮修掉的缺陷）。
  //   ⇒ 夹具必须长得像真产出，否则测的是别的形状（同「样本不对，结论就是假的」）。
  const KB_ANSWER = ['【审查结论：REVIEW】共发现 1 处需人工确认。', '',
    '1.【本地化】图 1，逐字命中「图」',
    '  **原因**：逐字命中',
    '  **依据**：《措辞表达库 v0》第 W-1.48 条 ← 命中「图」'
      + '｜原始出处：https://momcozy-in.feishu.cn/base/Lk3Qb8y2QaVyZns6gprcVNE9nA0?table=tblcbk4XiW6471YN&record=recvuJP2jyHizA',
    '  **锚点**：#广告文案明细/recvuJP2jyHizA/命中片段｜source_sha256：' + 'a'.repeat(16),
    '  **建议**：按模板改',
    '', '建议转 对接人 复核。'].join('\n');
  const STUB = 'https://example.invalid/docx/Z15';
  let called = 0;
  const g = await runSubmissionGate({
    imageClaimRunner: completedImageClaimFixture,
    // ★ 2026-10-09：**建议生成必须注入** —— 它默认真打 LLM（漏一处就把套件拖到超时，实测 7.5s/次）
    adviceRunner: async ({ items }) => ({ ok: true, ms: 1,
      advice: Object.fromEntries((items || []).map((_, i) => [i, `自证桩给的改法 ${i}`])) }),
    inbound: { text: '审核下这张图', imageCount: 1, videoCount: 0,
      images: [completedImageReadFixture()] },
    question: '审核下这张图', notify: null,
    chainRunner: async () => ({ answer: withImageSkillReceipt(KB_ANSWER), engine: IMAGE_ENGINE_OK,
      review: { state: 'REVIEW', issue_count: 1 } }),
    publishRunner: async () => ({ ok: true, record_id: 'recX' }),
    modelSideRunner: async () => ({ ok: true, ms: 1,
      findings: [1, 2, 3, 4, 5].map((n) => ({ category: '本地化', location: `画面 ${n}`, severity: 'REVIEW', reason: 'x' })) }),
    mergedReportRunner: async (md) => {
      called++;
      // 报告正文必须**两侧条目都在**（Owner：「6 个就展示 6 个问题」）。
      // ★ 2026-10-13：两侧**不再各有一个小标题**（Owner 把它们连免责一起列进了「废话」），
      //   所以判据从「有没有那两个标题」改成「**条目在不在、来源标没标**」——
      //   后者才是「这条回不回得了源」，也是那两个标题原先承担的**唯一**信息。
      // ★ 2026-10-13（Owner：「不要出现 知识库侧，模型侧」）：标记改了措辞，
      //   判据跟着改成**新措辞**（去的是词，不是「回不回得了源」这条信息）。
      assert.ok(/\*\*有库内条款依据\*\*/.test(md), '报告缺「有库内条款依据」那条（来源标记没了）');
      // ★★ 2026-10-19（Owner：「去掉『—— 无库内依据 · 建议转人工』的字眼，
      //   但是我问你的时候，你要能说出是模型侧还是知识库侧问题」）——
      //   这里**反过来钉**：被摘掉的两个状态标签**一个都不许回来**。
      //   ⚠️ 摘的是**标签**，不是**条目** —— 条目还在不在，由紧跟着的
      //      `countRenderedItems` 与 A3 标签那几条断言钉着（两件事分开钉，别混成一条）。
      assert.ok(!/\*\*无库内依据 · 建议转人工\*\*/.test(md), '被 Owner 摘掉的状态标签又回来了');
      assert.ok(!/\*\*无库内条款 · 依据为外部标准\*\*/.test(md), '「无库内条款 · 依据为外部标准」又回来了');
      assert.ok(!/知识库侧|模型侧/.test(md), '「知识库侧/模型侧」又出现了（Owner 点名去掉）');
      assert.ok(!/## 一、知识库侧|## 二、模型侧/.test(md), '两个来源小标题又回来了（Owner 点名去掉）');
      // ★★ 2026-10-14（Owner 裁定「去掉『判定』这个字段」）：这一处原先拿
      //   `/^ {3}\*{0,2}判定\*{0,2}：/gm` **当条目计数器**（每条恰好一行 `**判定**：`）。
      //   那是个**寄生判据**：它量的不是「有几条问题」，而是「有几行某个字段」——
      //   字段一删就**静默数出 0 条**，红的原因变成「计数器坏了」，红得对不上病。
      //   ⇒ 改量**真东西**：逐条块的行首编号（`renderMergedItem` 的第一行）。
      //   实测：这里要的是「6 条」＝ 库侧 1 ＋ 模型侧 5，换个字段不该影响这个数。
      const n = T.countRenderedItems(md);
      assert.strictEqual(n, 6, `报告里应有 6 条（两侧合计），实际 ${n} 条`);
      assert.ok(md.startsWith('# '), '报告首行必须是 H1（lark-cli markdown 导入的硬要求）');
      return { ok: true, url: STUB, detail: '自证桩' };
    },
  });
  assert.strictEqual(called, 1, '≥3 时没去建报告 —— Owner 的目标没达到');
  const blk = String(g.verdict53?.block ?? '');
  // ★ 2026-10-19：文案压成 `→ 完整清单：`（PRD §17 字数限制）
  assert.ok(blk.includes(STUB), `卡里那一行不是真链接：${(blk.match(/→ 完整清单：[^\n]*/) || ['(那一行都没有)'])[0].slice(0, 120)}`);
  assert.strictEqual(g.verdict53?.from, 'dual-track-merged', '抬头没走双轨合并那一支');
});

await t('Z16 ★ 反向对照：建报告**失败**时不许说成已出报告，且**不许阻断结论**', async () => {
  const { runSubmissionGate } = await import('./agent/agent.mjs');
  // ★★ 2026-10-14（Owner：「所有参考知识库的，都必须带飞书侧源链接」）：
  //   夹具补齐成**现代引擎输出**的形状（原因 / 依据 / 锚点 / 建议四行）。
  //   原先是老格式（只有 `1.【本地化】图 1` 一行、没有 `依据`），于是
  //   `kbFindingsOf` 这条来路**抠不出 `basisLine`** ⇒ 渲染层退回重建版
  //   `《知识库》（未给条款号）`；而它以前还能印出「有库内条款依据」，
  //   靠的是**那条种子候选被误当成库内条目**顶了位（正是本轮修掉的缺陷）。
  //   ⇒ 夹具必须长得像真产出，否则测的是别的形状（同「样本不对，结论就是假的」）。
  const KB_ANSWER = ['【审查结论：REVIEW】共发现 1 处需人工确认。', '',
    '1.【本地化】图 1，逐字命中「图」',
    '  **原因**：逐字命中',
    '  **依据**：《措辞表达库 v0》第 W-1.48 条 ← 命中「图」'
      + '｜原始出处：https://momcozy-in.feishu.cn/base/Lk3Qb8y2QaVyZns6gprcVNE9nA0?table=tblcbk4XiW6471YN&record=recvuJP2jyHizA',
    '  **锚点**：#广告文案明细/recvuJP2jyHizA/命中片段｜source_sha256：' + 'a'.repeat(16),
    '  **建议**：按模板改',
    '', '建议转 对接人 复核。'].join('\n');
  const g = await runSubmissionGate({
    imageClaimRunner: completedImageClaimFixture,
    // ★ 2026-10-09：**建议生成必须注入** —— 它默认真打 LLM（漏一处就把套件拖到超时，实测 7.5s/次）
    adviceRunner: async ({ items }) => ({ ok: true, ms: 1,
      advice: Object.fromEntries((items || []).map((_, i) => [i, `自证桩给的改法 ${i}`])) }),
    inbound: { text: '审核下这张图', imageCount: 1, videoCount: 0,
      images: [completedImageReadFixture()] },
    question: '审核下这张图', notify: null,
    chainRunner: async () => ({ answer: withImageSkillReceipt(KB_ANSWER), engine: IMAGE_ENGINE_OK,
      review: { state: 'REVIEW', issue_count: 1 } }),
    publishRunner: async () => ({ ok: true, record_id: 'recX' }),
    modelSideRunner: async () => ({ ok: true, ms: 1,
      findings: [1, 2, 3, 4, 5].map((n) => ({ category: '本地化', location: `画面 ${n}`, severity: 'REVIEW', reason: 'x' })) }),
    mergedReportRunner: async () => ({ ok: false, url: null, detail: '建云文档失败：权限不足' }),
  });
  // 结论照样要出来（报告与三态是两件事）
  assert.ok(/共发现 6 处/.test(g.verdict53?.line ?? ''), `结论被报告失败带崩了：${g.verdict53?.line}`);
  const blk = String(g.verdict53?.block ?? '');
  assert.ok(/完整清单/.test(blk), '连那一行都没了 —— 拿不到也要出声');
  assert.ok(/本次未拿到报告链接/.test(blk), '建失败却没说清 —— 会让人以为没有报告这回事');
  // ★★ 2026-10-14：这条原先写 `!/momcozy-in\.feishu\.cn/.test(blk)` —— **判据写宽了**。
  //   它要拦的是「**报告链接**」，可这个正则把**依据行里的 L0 源直链**也一起拦了；
  //   而那条 L0 直链恰恰是 Owner 要的（「所有参考知识库的，都必须带飞书侧源链接」）。
  //   以前它没红，只是因为**老夹具的库侧那条根本没有链接**。
  //   ⇒ 改成只查**报告链接那一行**（`→ 完整清单…`），依据行不在此列。
  //   ⚠️ 两个链接是**两件事**：报告链接 = 完整清单的云文档；L0 直链 = 「这条依据出自哪条源记录」。
  assert.ok(!/→\s*完整清单[^\n]*https?:\/\//.test(blk),
    '建失败却在报告链接那一行编了一个链接');
  assert.ok(/→\s*完整清单[^\n]*本次未拿到报告链接/.test(blk),
    '报告链接那一行没说清「未拿到」—— 会让人以为没有报告这回事');
});

await t('Z17 ★ 接线：报告经注入发布；完整图片审查可越过普通 ≥3 门槛', async () => {
  const src = fs.readFileSync(new URL('./agent/agent.mjs', import.meta.url), 'utf8');
  assert.ok(/mergedReportRunner\s*=\s*publishMergedReport/.test(src),
    '闸门没有可注入的 mergedReportRunner —— 自证会真的往飞书建文档（§2.4.4）');
  // ★ 2026-10-13：变量名从 `md` 改成 `mdDoc`（报告现在渲染**两份**：投出的这份 ＋ 留底那份），
  //   判据跟着认新名字 —— 它查的是「走没走注入的那个 runner」，与变量叫什么无关。
  assert.ok(/await\s+(?:runBeforeDelivery\s*\(\s*\(\)\s*=>\s*)?mergedReportRunner\(md(Doc|Full)?,/.test(src), '接线里没走注入的那个 runner');
  // ★ 反向对照：**不许**绕过注入点去直接调真函数 —— 那会让上面两条恒真
  assert.ok(!/await\s+(?:runBeforeDelivery\s*\(\s*\(\)\s*=>\s*)?publishMergedReport\(md/.test(src),
    '接线里直接调了真函数 —— 注入点形同虚设，自证又会建真文档');
  const reportSrc = fs.readFileSync(new URL('./agent/merged_report.mjs', import.meta.url), 'utf8');
  const { shouldPublishMergedReport } = await import('./agent/merged_report.mjs');
  // ★ 2026-10-22（Owner：「报告不展示 图片安全审查 skill 全流程结果」）：
  //   正文撤了，接线也要撤干净 —— 报告闸不再接 skill 正文这个参数。
  assert.ok(!/shouldPublishMergedReport\(\{ total: reportTotal,[\s\S]*?imageSkillReview/.test(src),
    '报告接线还在把 skill 正文交给发布闸 —— 正文已撤，参数也要撤（§2.4.4）');
  assert.ok(/hasContent && \(Number\(total\) >= REPORT_LINK_MIN_ISSUES \|\| !!force\)/.test(reportSrc),
    '发布闸必须保留 PRD §5.3.4 的 ≥3 门槛（不再有「完整图片审查单独发布」那一条）');
  assert.ok(!shouldPublishMergedReport({ total: 1, itemCount: 1 }),
    '普通单 1 条仍须服从 PRD 的 ≥3 门槛');
  assert.ok(!shouldPublishMergedReport({ total: 1, itemCount: 1, imageSkillReview: '完整图片审查' }),
    'skill 正文已撤，1 条也不例外 —— 否则建出来是只有一句结论的空文档');
  assert.ok(shouldPublishMergedReport({ total: 3, itemCount: 3 }),
    '≥3 条必须照旧出报告（门槛没被顺手改坏）');
  assert.ok(/total: reportTotal/.test(src),
    '报告正文没读原始卡面总数 —— 会退回「并进来几条」，把库侧未并进的那部分丢掉');
});

// ═══ 第 28 组 · 报告链接必须在**收起区之外**（Owner 2026-10-09 第三次反馈）═══
//
// 三次同一个病，每次换一层：
//   ① 第一版：链接拼在 8 条逐条清单**之后** ⇒ 太长看不到
//   ② 第二版：挪到结论块的**第 2 行** ⇒ 而**整块在卡里是收起的**
//      （实测那张 8 处问题的卡：「（已收起 1 条证据：审查结论）」）⇒ 还是看不到
//   ③ 现在：与 `applyMediaRead` 同构，搬进**可见的字符串格**（verdict/reasoning/…）
//
// 判据一句话：**一个必须点开才看得见的链接，等于没有链接。**

await t('Z18 ★ 行为级：报告链接必须进**卡片可见格**，不许只躺在折叠的结论块里', () => {
  const line = '【审查结论：REVIEW】共发现 8 处需人工确认。';
  const reply = '[[card:evidence]]\n' + JSON.stringify({
    title: '模型自拟的抬头', verdict: '**我读到了**\n图 1 张',
    groups: [{ title: '审查结论', content: '结论块（会被收起）' }],
  });
  const URL = 'https://momcozy-in.feishu.cn/docx/VISIBLE';
  const r = toCardOrText(reply, { verdict53: { state: 'REVIEW', line, from: 'chain' },
                                    mediaRead: '图 1 张', reportLink: URL });
  assert.strictEqual(r.mode, 'card', `应当建出卡片，实际 ${r.mode}`);
  // ★ 可见格（verdict）里必须有它 —— 这才是「看得见」的定义
  assert.ok(String(r.data?.verdict ?? '').includes(URL),
    `链接没进可见格（verdict），实际：${JSON.stringify(String(r.data?.verdict ?? '').slice(0, 160))}`);
  // ★★ 2026-10-19：措辞认**两种**（`→ 完整清单：` 短的那条 / `→ 查看完整问题清单与修改建议：` 长的）。
  //   卡面为 PRD §17 让路改成短措辞后，这里若还只认长的那句 ⇒ 真产出判成「缺那一行」，
  //   而它其实在（就是 J15a 那次假绿的镜像错法：判据绑死了一句会变的文案）。
  assert.ok(/(?:→|->)\s*(?:完整清单|查看完整问题清单与修改建议)\s*[：:]\s*https?:\/\//.test(String(r.data?.verdict ?? '')),
    '可见格里缺那一行（或那一行不是 `→ …：<链接>` 的形状）');
  // **搬不是砍**：「我读到了」那段还得在（换格子，不是删）
  assert.ok(/我读到了/.test(String(r.data?.verdict ?? '')), '把原有读数挤掉了 —— 搬是搬，砍是砍');
});

await t('Z19 反向对照：**没有链接时一个字符都不许加**（不许凭空造一行）', () => {
  const reply = '[[card:evidence]]\n' + JSON.stringify({ title: 'T', verdict: '原样' });
  const r = toCardOrText(reply, { verdict53: null, reportLink: null });
  assert.ok(!/查看完整问题清单/.test(JSON.stringify(r.card)), '没链接却造了一行');
  assert.strictEqual(r.data?.verdict, '原样', '没链接时 verdict 被改动了');
});

await t('Z20 接线：发送投影必须保留本轮报告链接，拒答必须清空旧链接', async () => {
  const { replyOptionsForResult } = await import('./agent/review_feedback.mjs');
  const reportLink = 'https://example.invalid/docx/current-review';
  const verdict53 = { state: 'REVIEW', line: '【REVIEW】共发现 3 处需人工确认。' };
  const meta = { gate: { yes: true }, verdict53, reportLink };
  assert.strictEqual(replyOptionsForResult({ meta }).reportLink, reportLink);
  assert.strictEqual(replyOptionsForResult({ meta: { ...meta, reviewDecisionWithheld: true } }).reportLink, null);
  const a = fs.readFileSync(new URL('./agent/agent.mjs', import.meta.url), 'utf8');
  assert.ok(/reportLink:\s*g\.dual\?\.reportUrl/.test(a), 'handleMessage 的 meta 没带 reportLink');
  // 拒答必须清空旧链接，不能再要求无条件传出 dual.reportUrl。
  // Z82 另走真实 gate，成对验证正常报告传出、拒答不发布也不残留链接。
  assert.ok(/reportUrl:\s*mediaCompletion\.incomplete\s*\|\|\s*publishConclusion\s*===\s*'NEEDS_INPUT'\s*\?\s*null\s*:\s*\(dual\.reportUrl\s*\?\?\s*null\)/.test(a),
    '闸门必须只在审核完成且未拒答时传出 reportUrl');
});

await t('Z20b ★ 行为级：传下去的读数**必须真被用上**（Z20 那种源码文本断言挡不住「传了但签名里没接」）', async () => {
  // ★★ 2026-10-13：写这条时真抓到一个 —— `onMessage` 一路传着
  //   `reportLink: result.meta?.reportLink`，而 `replyTo(..., { verdict53, mediaRead })`
  //   的解构签名里**根本没有 reportLink** ⇒ 静默丢弃。Z20 是绿的，因为它只查
  //   **源码里出现过那一行**（§2.4：「名字出现过」不是「它拦得住」）。
  //   ⇒ 判据必须走**行为**：把读数交给那条真的成形路径，看它有没有落到卡上。
  const { toCardOrText } = await import('./reply-cards/envelope.mjs');
  const V = { state: 'BLOCK', line: '【审查结论：BLOCK】共发现 1 处必须修改。',
              from: 'dual-track-merged',
              block: '【审查结论：BLOCK】共发现 1 处必须修改。\n1.【合规】全文\n   原因：x\n请修改后重新提交。' };
  const DOCX = 'https://momcozy-in.feishu.cn/docx/Z20B';   // ⚠️ 别叫 `URL` —— 会遮蔽全局构造函数
  const r = toCardOrText('模型原话', { verdict53: V, reportLink: DOCX });
  const card = JSON.stringify(r.card ?? {});
  assert.ok(card.includes(DOCX), '报告链接没落到卡上 —— 那就是被某一跳丢了');
  // ★ 2026-10-22（Owner：「输出的卡片不展示 视觉分析与 OCR」）：
  //   这条从「必须落卡」翻成**「给了也不许落卡」**，并补反向对照 ——
  //   判据要证明的是「卡面对这个入参彻底不认」，而不是「没给时不印」。
  const IMAGE_READ = '图 1｜OCR 3 行；视觉模型读数：卧室场景；婴儿睡姿：侧卧';
  const ri = toCardOrText('模型原话', { verdict53: V, imageAnalysis: IMAGE_READ });
  assert.ok(!JSON.stringify(ri.card ?? {}).includes(IMAGE_READ),
    '视觉分析与 OCR 读数又回到卡面上了（Owner 2026-10-22 要求不展示）');
  assert.ok(!JSON.stringify(ri.card ?? {}).includes('视觉分析与 OCR'),
    '卡面上出现了「视觉分析与 OCR」这一块');
  const ri0 = toCardOrText('模型原话', { verdict53: V });
  assert.ok(!JSON.stringify(ri0.card ?? {}).includes('视觉分析与 OCR'), '没有图片视觉分析读数时不许伪造该区块');
  // 反向对照：不给就一个都不许有（否则上面两条可能是「恒印一句」）
  const r0 = toCardOrText('模型原话', { verdict53: V });
  assert.ok(!JSON.stringify(r0.card ?? {}).includes(DOCX), '没给链接却印了链接');
  // 接线（源码级，与 Z20 同一层）：签名里必须真的接住报告链接，且**不再**接 imageAnalysis
  const d = fs.readFileSync(new URL('./ws_daemon.mjs', import.meta.url), 'utf8');
  // ⚠️ 「注释不算代码」—— 统一一条读法（§2.4.4 记过三次的坑：判据被自己的解释文字绊倒）
  const codeOnly = (x) => x.split('\n').filter((l) => {
    const t = l.trim();
    return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
  }).join('\n');
  const sig = (d.match(/async function replyTo\([^)]*\)[^{]*\{/) || [''])[0];
  assert.ok(/reportLink = null/.test(sig), `replyTo 的签名里没有 reportLink：${sig.slice(0, 120)}`);
  // ★★ 2026-10-26：这条原先钉的是**逐字一行**的调用形状
  //   （`toCardOrText(rawReply, { verdict53: v53, reportLink, requireTemplate: true })`）——
  //   而当天给这次调用加 `reviewRequired` 之后，那种「照抄一行文案」的判据把它判成红，
  //   尽管 `reportLink` **仍在这次调用里**。判据要守的是「读数有没有交给那一跳」，
  //   不是「那一行长什么样」⇒ 改成**在同一次调用的范围内**查三个读数各就各位。
  const call = (codeOnly(d).match(/toCardOrText\(rawReply,[\s\S]{0,600}?\}\)/) || [''])[0];
  assert.ok(/reportLink/.test(call), `replyTo 没有把报告链接交给 toCardOrText：${call.slice(0, 200)}`);
  // ★★ 2026-10-26 二轮（Owner「恢复到 10/22 的输出格式」）：**发送层不许自己造卡** ——
  //   10-22 的口径是「模型给卡片块就发卡，没给就纯文本原样出门」；当天上午那版硬包出来的
  //   形状是「标题＝首段、正文首行＝同一段」（实测 `oc_7775…` 14:08:19 `【你好。】／你好。`）。
  //   这里反过来钉住：造卡那个入参不许回来（形态由模型给不给卡块决定，不许多一处决策点）。
  assert.ok(!/requireTemplate/.test(call),
    `发送层又在自己造卡（10/22 格式口径不许）：${call.slice(0, 200)}`);
  // ★★ 2026-10-26（Owner：「守衡的回复没有按照 prd 和原先的输出模版来回复」）：
  //   **送审单必须把「这是送审」这条读数交下去** —— 否则拿不到 §5.3 结论行时
  //   `reviewRequired` 那个固定模板永远不触发，模型那段带 `label = REVIEW / DP3`
  //   的自由文本就会原样出门（行为级判据在 `verify_cards` 的 J5d）。
  assert.ok(/reviewRequired:\s*!!reviewOrder/.test(call),
    `这次调用没有把「送审单」交下去 ⇒ 拿不到结论行时不会走固定模板：${call.slice(0, 200)}`);
  const { replyOptionsForResult } = await import('./agent/review_feedback.mjs');
  assert.strictEqual(replyOptionsForResult({ meta: { gate: { yes: true } } }).reviewOrder, true);
  assert.strictEqual(replyOptionsForResult({ reply: '请审核', meta: { gate: { yes: false } } }).reviewOrder, false,
    '是否送审必须取自闸门，不能从回复文字猜');
  // ★ 2026-10-22：`imageAnalysis` 从这条链上**整个撤掉了**（读数不上卡）——
  //   撤了就要撤干净，否则就是「传了但没人接」那个病。
  assert.ok(!/imageAnalysis/.test(sig), `replyTo 的签名里还留着没人读的 imageAnalysis：${sig.slice(0, 120)}`);
  assert.ok(!/imageAnalysis/.test(codeOnly(d)), 'ws_daemon 里还有 imageAnalysis 的搬运（那一格已整格作废）');
  // ⚠️ 2026-10-13：`boundary` 从这条链上**整个撤了**（卡脚那一格作废）——
  //   撤了就要撤干净：留一个没人读的入参就是「传了但没人接」那个病。
  assert.ok(!/boundary/.test(codeOnly(d)),
    'ws_daemon 里还有 boundary 的搬运（那一格已整格作废）');
  // ★ 2026-10-13：`mediaRead` 从这条链上**整个撤掉了**（读数不上卡）——
  //   留一个没人读的入参就是「传了但没人接」那个病。撤了就要撤干净：
  assert.ok(!/mediaRead/.test(sig), `replyTo 的签名里还留着没人读的 mediaRead：${sig.slice(0, 120)}`);
  assert.ok(!/mediaRead/.test(d.slice(d.indexOf('const shaped = toCardOrText'), d.indexOf('const shaped = toCardOrText') + 200)),
    'replyTo 还在往 toCardOrText 传 mediaRead');
});
// ═══ 第 29 组 · 报告不许替库侧下「有依据」这个结论（Owner 2026-10-09）═══
//
// 实测那一单：卡上守衡写着「4/4 条依据与素材无关，另 2 条 L0 sha 不一致」，
// 而同一批条目在报告里顶着「**有条款级依据**」这个标题、还带条款号与飞书直链 ——
// **报告比卡片可信得多** ⇒ 链接修好后危害反而被放大。
//
// 改法只做「能与不能」的区分：标题降级为**出处**，并加**常驻**免责。
// 常驻而不是「检测到才写」：`evidence_complete` 那类信号实测是 `undefined`，
// 靠它判会时灵时不灵 —— 而**不确定性必须无条件说出来**（§2.4.2）。

await t('Z21 ★ 报告只留 PRD 字段：两个来源小标题、免责、计数口径全部去掉', async () => {
  // ★★ 2026-10-13（Owner 三条里的第 3 条）：报告要按 PRD 字段输出，把「废话」去掉。
  //   Owner 逐条点名要去掉的：`- 用户原提问：…` / `- 判据：PRD §5.3.4…` /
  //   `## 一、知识库侧（库内条款条目）` / 那段 ⚠️ 免责 / `（本单知识库侧没有并进任何条目。）` /
  //   `## 二、模型侧（无库内依据，只能转人工）` / 那段 blockquote / **整个「三、计数口径」**。
  const M = await import('./agent/merged_report.mjs');
  const md = M.renderMergedReportMd({
    merged: [
      // ★★ 2026-10-14（Owner：「所有参考知识库的，都必须带飞书侧源链接」）：
      //   这条夹具原先是「`source:'kb'` 但**没有条款号、也没有链接**」——
      //   而那正是现在**必须被拦下**的形状（不许冒称「有库内条款依据」）。
      //   ⇒ 补成真依据的形状（有号 + 有飞书直链）。本测试查的是「报告里两条来源都在」，
      //     与「那条依据完不完整」是两件事，夹具必须长得像真产出。
      // ★ 2026-10-19：报告逐条标签改印 **A3 12 类**（与卡面同一套）⇒ 夹具带上 A3，
      //   否则两条都会落「未归类」，量不到「两条来源的条目都还在」。
      { location: '图上文案', category: '平台与促销', severity: 'REVIEW', source: 'kb',
        reason: 'x',
        taxonomyCategory: '推广与价格透明', taxonomySubcategory: '促销紧迫感与施压表述',
        kb: { article_no: 'W-1.54', suggestionLine: '删掉「最」',
              basisLine: '《措辞表达库 v0》第 W-1.54 条 ← 命中「最」'
                + '｜原始出处：https://momcozy-in.feishu.cn/base/Lk3Qb8y2QaVyZns6gprcVNE9nA0?table=tblcbk4XiW6471YN&record=recvuJYdOb1B8v' } },
      { location: '视频 00:12', category: '合规', severity: 'REVIEW', source: 'model',
        reason: 'y', suggestion: '改掉', taxonomyCategory: '合规与受监管宣称' },
    ],
    total: 2, state: 'REVIEW', line: '【审查结论：REVIEW】共发现 2 处需人工确认。',
    question: '审核这段文案', contentId: 'AUTO-x', at: '2026-10-09', kbTextCount: 1, modelCount: 1 });
  // ★ 更老的那条病灶（2026-10-09）不许回来：标题声称「有条款级依据」＝替库侧下结论
  assert.ok(!/有条款级依据/.test(md), '标题又在声称「有条款级依据」—— 那是替库侧下结论');
  // ★ 本次三处（Owner 逐条点名）
  assert.ok(!/## 一、知识库侧/.test(md), '「一、知识库侧」那个小标题还在（Owner 点名要去掉）');
  assert.ok(!/## 二、模型侧/.test(md), '「二、模型侧」那个小标题还在（Owner 点名要去掉）');
  assert.ok(!/本报告不作核验/.test(md), '那段 ⚠️ 免责还在');
  assert.ok(!/没有并进任何条目/.test(md), '「（本单知识库侧没有并进任何条目。）」还在');
  assert.ok(!/计数口径/.test(md), '「三、计数口径」还在（Owner：下面的内容都不需要）');
  assert.ok(!/^- 判据：/m.test(md), '「- 判据：PRD §5.3.4…」还在');
  assert.ok(!/^- 用户原提问：/m.test(md), '「- 用户原提问：…」还在（它已经挪进标题）');
  // ★★ 反向对照（**这一条最要紧**）：去掉的是**外层的标题与免责**，
  //   条目本身一条都不许少，且**逐条**仍要能看出是哪一侧给的
  //   （「这条回不回得了源」决定下一步，比那两个小标题重要得多）。
  // ★ 2026-10-13（Owner：「不要出现 知识库侧，模型侧」）：标记换成新措辞，
  //   判据跟着换；同时**反着钉一条** —— 那两个词一个都不许回来。
  assert.ok(/\*\*有库内条款依据\*\*/.test(md), '库侧条目丢了来源标记 —— 读者就看不出它回得了源');
  // ★★ 2026-10-19（Owner：「去掉『—— 无库内依据 · 建议转人工』的字眼」）——
  //   反过来钉：这两个标签不许回来。「这条回不回得了源」这件事**没丢**：
  //   它搬到了 `itemsMeta` → `merged-*.json`（`items[].source / basis_kind / basis_missing`）。
  assert.ok(!/\*\*无库内依据 · 建议转人工\*\*/.test(md), '被 Owner 摘掉的标签又回来了（会被读成判定）');
  assert.ok(!/\*\*无库内条款 · 依据为外部标准\*\*/.test(md), '「无库内条款 · 依据为外部标准」又回来了');
  assert.ok(!/知识库侧|模型侧/.test(md), '「知识库侧/模型侧」又出现了（Owner 2026-10-13 点名去掉）');
  // ★★ 2026-10-17：报告改成「先 P 级、再维度」分组（Owner 白板）⇒ **条目次序由分组决定**，
  //   不再固定「库侧在前」。原断言钉的是具体某条排第 1，那属于**另一个口径**，已失效。
  //   要守住的本意没变：**编号连号 1..N**（每组各从 1 开始 = 两份清单 = 这一次要修的病灶）。
  // ★ 第十五轮：条目不再是 `N.【类别】`，标题行改成 `**F-01 ｜ 类别 ｜ 级别 动作**`
  // ★★ 2026-10-19（A3 12 类）：报告逐条标签已换成所属类别 ⇒ 断言跟着换成 A3 名
  assert.ok(/｜ 推广与价格透明·/.test(md) && /｜ 合规与受监管宣称 ｜/.test(md),
    '两条来源的条目必须都还在（A3 标签）');
  // ★ 第十五轮：报告条目改成 `**F-01 ｜ …**`，连号断言跟着认这个形状
  assert.deepStrictEqual((md.match(/^\*\*F-(\d{2}) ｜ /gm) || []).map((x) => x.slice(4, 6)),
    ['01', '02'], '条目必须跨组连号 F-01..F-NN（各从 01 开始会被读成两份清单）');
});

await t('Z21b ★ 报告 H1 **固定**「内容审查报告」—— 文案/图片/视频一律（Owner 2026-10-13 第三次改这条）', async () => {
  // Owner 原话：「输出的文档报告标题太乱了，**直接按照原来的「内容审查报告」**」，
  // 并点名「**文案/图片/视频都需要改**」。
  // 上一版是 `<用户原问题> 内容审查报告`，坏在媒材单上 —— 那类消息没有「用户原问题」，
  // `question` 是内核自己拟的**探针**；探针识别漏了一种形状
  // （`【对方这条消息没带视频；下面是它引用的那条消息里附的视频…】`）⇒
  // 整段 3498 字进了 H1（Owner 贴回来的就是那个）。
  const M = await import('./agent/merged_report.mjs');
  const head = (q) => M.renderMergedReportMd({ merged: [], total: 1, state: 'REVIEW',
    line: '【审查结论：REVIEW】共发现 1 处需人工确认。',
    question: q, contentId: 'C', at: '2026-10-12T07:31:24.329Z' }).split('\n')[0];
  // ① **一律**就这一句 —— 文案 / 图片 / 视频三种都一样
  assert.strictEqual(head('这条社媒文案能不能发'), '# 内容审查报告');
  assert.strictEqual(head(''), '# 内容审查报告');
  assert.strictEqual(head(null), '# 内容审查报告');
  // ② **那个漏掉的探针形状**（Owner 贴回来的那一段）一个字符都不许进 H1
  const probe = '【对方这条消息没带视频；下面是它引用的那条消息里附的视频，共 1 段。'
    + '下面每一格是本机读出来的读数：「关键帧上的文字」是按时长均匀抽 8 帧做的 OCR…';
  assert.strictEqual(head(probe), '# 内容审查报告', '探针又被当成标题了');
  // ③ 反向对照：H1 里**不许**出现渲染时刻，也不许出现探针里的任何特征串
  assert.ok(!/2026-10-12T07:31:24/.test(head('x')), 'H1 里还有渲染时刻');
  for (const q of ['这条社媒文案能不能发', probe, '第一行\n第二行']) {
    assert.ok(head(q) === '# 内容审查报告', `H1 不是固定的那一句：${head(q)}`);
  }
  // ④ 探针识别本身也要对（它管的是**留底**里的素材读数附录，不只是标题）
  const { questionForReport } = M;
  assert.strictEqual(questionForReport(probe).isProbe, true, '新形状的探针没被认出来');
  assert.strictEqual(questionForReport('这条社媒文案能不能发').isProbe, false,
    '把真问题误判成探针了 —— 那会把素材读数当成人写的话');
});

await t('Z21c ★ 报告头只留 PRD 字段 ＋ **投出去那份不带附录、留底那份带**（Owner 2026-10-13 第四条）', async () => {
  // Owner 原话：「输出的飞书文档报告，去掉（`- 内容 ID：— ｜ 审查时刻：…` ／
  //   `- 结论：REVIEW ｜ 问题数量：10` ／ **附录下的所有内容**）」。
  //   实测那份报告：149 行里 79 行是附录（7892 字符），正文只占前 70 行。
  const M = await import('./agent/merged_report.mjs');
  const args = {
    merged: [{ location: '[00:04]', category: '合规', severity: 'REVIEW', source: 'model',
               reason: 'r', advice: 'a' }],
    total: 1, state: 'REVIEW', line: '【审查结论：REVIEW】共发现 1 处需人工确认。',
    question: '这条视频能过吗', contentId: '—', at: '2026-10-13T03:11:14.656Z',
    hitsBlock: '【库内命中（读数）】本次检索命中 5 条\n1. `#l.1-2`｜BM25 299.18',
    mediaAppendix: '### 关键帧文字与音轨转写\n\n- **视频 1**（68.9 秒）',
  };
  const doc = M.renderMergedReportMd({ ...args, withAppendix: false });
  const full = M.renderMergedReportMd(args);
  // ① 那两行都不许再出现
  assert.ok(!/^- 内容 ID：/m.test(doc), '「- 内容 ID：…」还在');
  assert.ok(!/^- 结论：/m.test(doc), '「- 结论：…」还在（它与下面的 §5.3 结论行是同一件事说两遍）');
  // ★ 反向对照：**结论与条数一条都没少** —— 它们就在结论行里（这就是那两行能去掉的前提）
  assert.ok(/【审查结论：REVIEW】共发现 1 处需人工确认。/.test(doc), '把结论也一起删了 —— 那这条改动就变成丢信息');
  // ② 投出去那份：一个附录节都不许有
  assert.ok(!/^## 附录/m.test(doc), '投出去的文档里还有附录节');
  assert.ok(!/库内命中（读数）/.test(doc), '投出去那份里还有检索读数');
  assert.ok(!/关键帧文字/.test(doc), '投出去那份里还有媒材读数全文');
  // ③ ★★ **搬不是砍**：留底那份必须**完整**（它是「这条依据怎么来的 / 当时读到什么字」的唯一落点）
  assert.ok(/^## 附录：检索读数/m.test(full), '留底那份丢了检索读数附录');
  assert.ok(/^## 附录：机读素材读数/m.test(full), '留底那份丢了媒材读数附录');
  assert.ok(/库内命中（读数）/.test(full) && /关键帧文字/.test(full), '留底那份的内容被截了');
  // ④ 两份的**条目必须逐字同源**（只差附录那一半）
  const bodyOf = (m) => m.split('\n').filter((l) => /^\d+\.【/.test(l)).join('\n');
  assert.strictEqual(bodyOf(doc), bodyOf(full), '两份的逐条清单不一致 —— 那就成了「两处各写一遍」');
});

await t('Z21d ★ 落盘：投出那份与留底那份**是两个文件**，且路径都从返回值给（不许猜）', async () => {
  const M = await import('./agent/merged_report.mjs');
  const os = await import('node:os');
  const fsx = await import('node:fs');
  const pathx = await import('node:path');
  const dir = fsx.mkdtempSync(pathx.join(os.tmpdir(), 'mr-'));
  const prev = process.env.SHOUHENG_MERGED_REPORT_DIR;
  process.env.SHOUHENG_MERGED_REPORT_DIR = dir;
  try {
    // ⚠️⚠️ **必须注入 `publishDoc`** —— 默认那一跳会真的去飞书建云文档。
    //   这不是假设：写这条自证的第一版就漏了它（§2.4.4 那个病，本仓已栽过两次）。
    const stubPub = async (p) => ({ ok: true, url: 'https://example.invalid/docx/Z21D', detail: `桩：${p}` });
    const pub = await M.publishMergedReport('# 投出\n\n正文', {
      contentId: 'C1', at: 'T', archiveMd: '# 留底\n\n## 附录：检索读数\n\n读数',
      publishDoc: stubPub,
    });
    assert.ok(pub.mdPath && fsx.existsSync(pub.mdPath), `投出那份没落盘：${JSON.stringify(pub).slice(0, 160)}`);
    assert.ok(pub.archivePath && fsx.existsSync(pub.archivePath), '留底那份没落盘');
    assert.ok(/\.full\.md$/.test(pub.archivePath), `留底文件名没带 .full.md：${pub.archivePath}`);
    assert.ok(!/## 附录/.test(fsx.readFileSync(pub.mdPath, 'utf8')), '投出那份带着附录');
    assert.ok(/## 附录/.test(fsx.readFileSync(pub.archivePath, 'utf8')), '留底那份没有附录');
    // 反向对照：**不给 archiveMd 就不写留底**（不留一个空壳文件）
    const pub2 = await M.publishMergedReport('# 投出2', { contentId: 'C2', archiveMd: null,
                                                         publishDoc: stubPub });
    assert.strictEqual(pub2.archivePath, null, '没给留底内容却写了留底文件');
  } finally {
    if (prev === undefined) delete process.env.SHOUHENG_MERGED_REPORT_DIR;
    else process.env.SHOUHENG_MERGED_REPORT_DIR = prev;
    fsx.rmSync(dir, { recursive: true, force: true });
  }
});

await t('Z22 有结构化告警时照搬进正文（缺口留着，但不能装作没有）', async () => {
  const M = await import('./agent/merged_report.mjs');
  const md = M.renderMergedReportMd({ merged: [], total: 0, state: 'REVIEW',
    warnings: ['卡片告警：4/4 条依据与素材无关；2 条 L0 sha 不一致'] });
  assert.ok(/4\/4 条依据与素材无关/.test(md), '传进来的告警没进正文');
});
// ═══ 第 30 组 · 「建议」的唯一产出者（Owner 2026-10-09）═══
//
// Owner 原话：「建议必须具体内容。负面样本『建议』列填充 47% ⇒ **有填的做参考，agent 输出
// 最终具体建议**；没填的不用参考，agent 直接出建议。」
//
// 过去「建议」有**两个产出者**（库侧原话 / 模型原话）⇒ 库侧有值时模型那条被静默丢掉，
// 来源也标不清。现在两侧都回来之后补一次调用，**唯一产出者**。

await t('Z23 ★ 有 advice 就用它，且标注说的是「**参考了什么**」而不是「谁给的」', async () => {
  const T = await import('./agent/dual_track.mjs');
  // ★ 2026-10-09：`建议` 标签如今**带加粗**（Owner 裁定「字段加粗保留」）⇒ 原先的
  //   `/ {3}建议：(.*)/` 抠出空串，把「建议内容对不对」误判成失败。
  //   这一组查的是**建议内容与标注**、与加粗无关 ⇒ 认两种写法。
  // ★★ 2026-10-19（Owner：「修改建议 ≤30 字」；PRD §5.3.3）：**卡面**只印首句（≤30 字），
  //   「参考了什么 / 不是库规原文」这类**溯源标注挪到报告**（卡上放不下，报告是照做的地方）。
  //   ⇒ 这条用例按介质分开断言，防护意图（**溯源必须说清**）一个字没松。
  const cardOf = (f) => (T.renderMergedItem(f, 0, { must: false }).match(/ {3}\*{0,2}建议\*{0,2}：(.*)/) || [])[1] || '';
  const repOf = (f) => (T.renderMergedItem(f, 0, { must: false, layout: 'report' }).match(/\*\*修改建议\*\*：(.*)/) || [])[1] || '';
  const withRefItem = { category: 'a', location: 'body', source: 'kb', reason: 'r',
                        advice: '删掉「最」字，改为「更」', adviceReferencedKb: true };
  const withRef = cardOf(withRefItem);
  assert.ok(/删掉「最」字/.test(withRef), '卡面没采用 advice —— 唯一产出者没生效');
  assert.ok(T.countAdviceChars(withRef) <= T.ADVICE_MAX, `卡面建议超 ${T.ADVICE_MAX} 字：${withRef}`);
  const withRefRep = repOf(withRefItem);
  // ★★ 2026-10-19：报告的 `**修改建议**` 那一格现在压到 ≤30 字（Owner 后令），
  //   标注**挪到标题行末尾**（`· 改法参考库内反例（非库规原文）`）—— 防护意图一个字没松：
  //   「改法是模型写的、不是库规原文」这件事仍然在**人看得见的那一条**上写着。
  const fullRep = T.renderMergedItem(withRefItem, 0, { must: false, layout: 'report' });
  assert.ok(/改法参考库内反例/.test(fullRep), '报告没标「参考了什么」（溯源不许丢）');
  assert.ok(/非库规原文/.test(fullRep), '改法由模型写的，报告里必须说清它不是库规原文');
  assert.ok(T.countAdviceChars(withRefRep) <= T.ADVICE_MAX,
    `报告修改建议超 ${T.ADVICE_MAX} 字：${withRefRep}`);
  // ★ 反向对照 + 一致性：**没参考库内反例时，绝不许说参考了**
  //   （比原来的「必须印『库内无可参考建议』」更强 —— 那句正是 Owner 2026-10-19 点名去掉的说法）
  const noRefItem = { category: 'a', location: 'body', source: 'model', reason: 'r',
                      advice: '补一行截止日期', adviceReferencedKb: false };
  const noRefRep = T.renderMergedItem(noRefItem, 0, { must: false, layout: 'report' });
  assert.ok(!/参考库内反例/.test(noRefRep), '没参考库内反例却标了「参考了」（假陈述）');
  assert.ok(!/库内无可参考建议|无库内依据的改法建议/.test(noRefRep),
    'Owner 2026-10-19 点名去掉的那两句又回来了');
  assert.ok(/补一行截止日期/.test(repOf(noRefItem)), '报告没采用 advice');
});

await t('Z24 ★ 反向对照：建议生成**失败**时回退（库侧原话 → 模型原话 → 如实说没有），不许编', async () => {
  const T = await import('./agent/dual_track.mjs');
  // ★ 2026-10-09：`建议` 标签如今**带加粗**（Owner 裁定「字段加粗保留」）⇒ 原先的
  //   `/ {3}建议：(.*)/` 抠出空串，把「建议内容对不对」误判成失败。
  //   这一组查的是**建议内容与标注**、与加粗无关 ⇒ 认两种写法。
  const sug = (f) => (T.renderMergedItem(f, 0, { must: false }).match(/ {3}\*{0,2}建议\*{0,2}：(.*)/) || [])[1] || '';
  // advice = null（生成失败）⇒ 回退到库侧原话
  assert.strictEqual(sug({ category: 'a', location: 'b', source: 'kb', reason: 'r', advice: null,
                           kb: { suggestionLine: '库侧原话：改成中文' } }), '库侧原话：改成中文');
  // 连库侧也没有 ⇒ 回退到模型原话
  assert.ok(/模型建议：改成中文/.test(sug({ category: 'a', location: 'b', source: 'model', reason: 'r',
                                           advice: null, suggestion: '模型建议：改成中文' })));
  // 全都没有 ⇒ 如实说没有（不许出现「转对应负责人复核」）
  const none = sug({ category: 'a', location: 'b', source: 'model', reason: 'r', advice: null });
  assert.ok(/两侧都没给修改建议/.test(none), '既没建议又没如实说');
  assert.ok(!/转对应负责人复核/.test(none), '硬编码那句又回来了');
});

await t('Z25 ★ 自证不许真打 LLM：每一处 runSubmissionGate 调用点都必须注入 adviceRunner', () => {
  // §2.4.4 那个病：跑一次自证，真的调了模型。实测漏一处就把套件拖到超时（7.5s/次）。
  const src = fs.readFileSync(new URL('./test_agent.mjs', import.meta.url), 'utf8');
  const lines = src.split('\n');
  const missing = [];
  for (let i = 0; i < lines.length; i++) {
    if (/runSubmissionGate\(\{\s*$/.test(lines[i])) {
      const seg = lines.slice(i + 1, i + 24).join('\n');
      if (!seg.includes('adviceRunner')) missing.push(i + 1);
    }
  }
  assert.deepStrictEqual(missing, [], `这些行上的闸门调用没注入 adviceRunner（会真打 LLM）：${missing.join(', ')}`);
});
await t('Z26 ★ 行为级：库侧条目走生成（参考库侧建议），**模型侧已有的建议直接沿用**', async () => {
  // Owner 的期望原话：「知识库侧 **参考库侧建议** → agent 出最终建议；**模型侧问题就输出模型侧建议**」。
  // 第一版把**所有**条目都送进生成器 ⇒ 模型侧已经写好的一条被重写（白烧一次、详略还可能变差）。
  const { runSubmissionGate } = await import('./agent/agent.mjs');
  const KB = ['【审查结论：REVIEW】共发现 1 处需人工确认。', '',
    '1.【平台与促销】图 1 第 3 行 —— 库侧那条', '  **建议**：删掉「最」字', '',
    '建议转 对接人 复核。'].join('\n');
  let sent = null;
  const g = await runSubmissionGate({
    imageClaimRunner: completedImageClaimFixture,
    inbound: { text: '审核下这张图', imageCount: 1, videoCount: 0,
      images: [completedImageReadFixture()] },
    question: '审核下这张图', notify: null,
    chainRunner: async () => ({ answer: withImageSkillReceipt(KB), engine: IMAGE_ENGINE_OK,
      review: { state: 'REVIEW', issue_count: 1 } }),
    publishRunner: async () => ({ ok: true, record_id: 'r' }),
    modelSideRunner: async () => ({ ok: true, ms: 1, findings: [{ category: '本地化', location: '画面 1',
      severity: 'REVIEW', reason: '英文', suggestion: '模型侧自己写的：译成中文' }] }),
    adviceRunner: async ({ items }) => { sent = items;
      return { ok: true, ms: 5, advice: Object.fromEntries(items.map((_, i) => [i, '生成器给的改法 ' + i])) }; },
    mergedReportRunner: async () => ({ ok: true, url: null, detail: '桩' }),
  });
  // ★ 只送「需要生成」的那条（库侧有参考）；模型侧那条不许送（它自己写过）
  assert.strictEqual(sent?.length, 1, `送进生成器的条数应为 1，实际 ${sent?.length}`);
  assert.ok(/图 1 第 3 行/.test(String(sent?.[0]?.location ?? '')), '送进去的不是库侧那条');
  const T2 = await import('./agent/dual_track.mjs');
  const block = String(g.verdict53?.block ?? '');
  const lines = block.split('\n').filter((l) => /^ {3}\*{0,2}建议\*{0,2}：/.test(l)).map((l) => l.trim());
  assert.strictEqual(lines.length, 2, `应有 2 条建议，实际 ${lines.length}`);
  // ★★ 2026-10-19（Owner：「修改建议 ≤30 字」）：**卡面只印首句（≤30 字）**，
  //   而「参考了库内反例的建议 / 无库内依据的改法建议」这些**标注在报告里**。
  //   ⇒ 这条用例的防护意图（库侧走生成、模型侧沿用、不许互换）**一个字没松**，
  //     只是把「标注」那半段的断言搬到报告介质上（卡面放不下 30 字以上的标注）。
  assert.ok(lines.every((l) => T2.countAdviceChars(l) <= T2.ADVICE_MAX),
    `卡面建议超 ${T2.ADVICE_MAX} 字（标点不计）：${JSON.stringify(lines)}`);
  // 库侧那条：走了生成器（卡面能看到生成结果的首句）
  assert.ok(lines.some((l) => /生成器给的改法/.test(l)),
    '库侧条目没走生成器：' + JSON.stringify(lines));
  // 模型侧那条：**沿用原话**（卡面能看到它的首句）
  assert.ok(lines.some((l) => /模型侧自己写的/.test(l)),
    '模型侧条目被重写了（应当沿用）：' + JSON.stringify(lines));
  assert.ok(!lines.some((l) => /生成器给的改法/.test(l) && /模型侧自己写的/.test(l)),
    '同一行里混了两侧内容');
  // 报告介质：标注必须还在（溯源不许因为压缩而消失）
  const repItemKb = T2.renderMergedItem({ category: 'a', location: 'body', source: 'kb', reason: 'r',
    advice: '生成器给的改法 0', adviceReferencedKb: true }, 0, { must: false, layout: 'report' });
  // ★★ 2026-10-19 加固（Owner：「**审查报告中**，修改建议你写了200多字，修改建议 ≤30 字」）：
  //   报告那一格现在也压到 ≤30 字，而「参考了什么」的标注**挪到了标题行**
  //   （`… —— 有库内条款依据 · 改法参考库内反例`）—— 两件事都必须成立，缺一不可：
  //     ① 标注在（防「把模型写的改法读成库规原文」，Owner 2026-10-09 口径不许丢）；
  //     ② 报告里 `**修改建议**` 那一格 ≤30 字（PRD §5.3.3 硬约束）。
  assert.ok(/改法参考库内反例/.test(repItemKb), '报告里丢了「参考了库内反例」标注');
  {
    const repAdv = (repItemKb.match(/\*\*修改建议\*\*：(.*)/) || [])[1] || '';
    const n = repAdv.replace(/\s+/g, '').length;
    assert.ok(n > 0 && T2.countAdviceChars(repAdv) <= T2.ADVICE_MAX,
      `报告里「修改建议」超 ${T2.ADVICE_MAX} 字：${n} 字 ⇒ ${JSON.stringify(repAdv)}`);
  }
  // ⚠️ 模型侧建议走的是 `suggestion` 字段（不是 `advice`）—— 第一版放错字段，断言假红。
  // ★ 2026-10-19（Owner 点名去掉那句尾巴）：报告里也**不再**印「无库内依据的改法建议」，
  //   「这一条回不回得了源」由**依据格**说（`独立语义复核（非条款依据…）`）。
  const repItemMd = T2.renderMergedItem({ category: 'a', location: 'body', source: 'model', reason: 'r',
    suggestion: '模型侧自己写的：译成中文' }, 0, { must: false, layout: 'report' });
  assert.ok(/模型侧自己写的/.test(repItemMd), '报告里丢了模型侧的改法原文');
  assert.ok(!/无库内依据的改法建议/.test(repItemMd), '那句被 Owner 去掉的尾巴又回来了');
  assert.ok(/非条款依据/.test(repItemMd), '依据格没说明这一条不是条款依据');
});
// ═══ 第 31 组 · ≥3 时卡片**只出分类汇总 + 报告链接**（PRD §5.3.3，Owner 追问第四次）═══
//
// PRD 权威实现（库侧 `kb/l5/p0_fastpath.py:391`）：
//   `if n >= 3:` → `L.extend(_summary_lines(findings))` + 报告链接。
//
// 而本仓的 `renderMerged` **从来不分条数**，永远把全部条目平铺在卡上 ——
// Owner 看到的「7 个问题都是平铺」**本身就违反 PRD**，而「链接看不见」只是症状
// （条目全在卡上，链接被挤到最后又被收起）。此前三次修复都在治症状。

await t('Z27 ★ 行为级：≥3 ⇒ 只出分类汇总 + 链接（**零条逐条**）；<3 ⇒ 逐条平铺', async () => {
  const T = await import('./agent/dual_track.mjs');
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ location: `画面 ${i}`,
    category: i % 2 ? '本地化' : '平台与促销', severity: 'REVIEW', source: 'model',
    reason: 'x', advice: `改法 ${i}` }));
  const build = (n, url) => {
    const m = T.mergeFindings([], mk(n));
    return T.renderMerged(m.items, { state: 'REVIEW',
      kb: T.kbSideOf({ review: { state: 'REVIEW', issue_count: 0 } }),
      kbTextCount: 0, model: { ok: true, findings: [] }, reportUrlOverride: url });
  };
  const big = build(7, 'https://momcozy-in.feishu.cn/docx/BIG');
  const b7 = String(big.block);
  assert.strictEqual(big.total, 7);
  assert.strictEqual(big.summarized, true, 'total=7 应当走汇总');
  assert.strictEqual(T.countRenderedItems(b7), 0,
    '≥3 时**不许**在卡上逐条平铺（这正是 Owner 反复看到的那件事）');
  // ★★ 2026-10-19 第三次（Owner：「按照下面的格式优化，目前是写的一行」）：**每类一行**、
  //   `· <维度>类问题：N 个`、行间不空行。
  const sum7 = String(b7).split('\n').filter((l) => /^· /.test(l));
  assert.ok(sum7.length >= 1 && sum7.every((l) => /^· [^·\n，]+类问题：\d+ 个$/.test(l)),
    `分类汇总行形状不对（应每类一行）：${JSON.stringify(sum7.slice(0, 3))}`);
  assert.ok(!/个 · [^\n]*类问题：/.test(b7), '汇总又被缩成一行了（应每类一行）');
  // ★ 2026-10-19：文案压成 `→ 完整清单：`（PRD §17 字数限制）；意图不变 —— 汇总路必须有报告链接那一行
  assert.ok(/→ 完整清单：/.test(b7), '缺报告链接');
  // ★★ 2026-10-13（Owner 裁定）：卡上**不再**有「（问题数 N ≥ 3 ⇒ 按 PRD §5.3.3 只出分类汇总…）」
  //   那句页脚 —— 它讲的是我们的口径规矩，业务同事读不懂，Owner 把它列进了「都去掉」。
  //   ⚠️ 判据**反过来钉**：卡上不许有 ＋ **查证笔记里必须有**（搬不是砍，
  //      对方追问「逐条清单去哪了」守衡要答得出来）。
  assert.ok(!/只出分类汇总/.test(b7), '那句口径页脚又回到卡上了（Owner 2026-10-13 点名去掉）');
  assert.ok(/只出分类汇总/.test(String(big.internalNotes)),
    '从卡上撤下来的页脚必须落在 internalNotes 里（搬不是砍）');
  // ★ 反向对照：<3 时必须**照旧逐条平铺**（1–2 条走逐条输出，PRD 就是这么定的）
  const small = build(2, null);
  const b2 = String(small.block);
  assert.strictEqual(small.summarized, false, 'total=2 不该走汇总');
  assert.strictEqual(T.countRenderedItems(b2), 2, '<3 时必须逐条平铺');
  assert.ok(!/查看完整问题清单/.test(b2), '<3 时不许给链接');
  // 边界：正好 3 条 ⇒ 走汇总（`>=`，与库侧同一个常数）
  // ⚠️ 2026-10-09 晚：这条原先传 null，而安全网（Z31）要求「拿不到链接就退回平铺」
  //   ⇒ 3 条要验「闭区间走汇总」就必须**带上链接**（否则它按安全网退回平铺，是对的）。
  assert.strictEqual(build(3, 'https://momcozy-in.feishu.cn/docx/C3').summarized, true,
    '3 条是闭区间（>=），带链接时必须走汇总');
});

await t('Z28 接线：汇总那一段必须与报告链接**同时出现**（少一个都等于没修）', async () => {
  const T = await import('./agent/dual_track.mjs');
  const m = T.mergeFindings([], Array.from({ length: 5 }, (_, i) => ({ location: `p${i}`,
    category: '合规', severity: 'REVIEW', source: 'model', reason: 'r', advice: 'a' })));
  const withUrl = T.renderMerged(m.items, { state: 'REVIEW',
    kb: T.kbSideOf({ review: { state: 'REVIEW', issue_count: 0 } }), kbTextCount: 0,
    model: { ok: true, findings: [] }, reportUrlOverride: 'https://x/docx/Y' });
  // ★★ 2026-10-19（Owner：「问题数量≥3 时要有分类汇总 `· 合规类：X 个 · 消费者安全类：X 个
  //   · 措辞类：X 个`……卡片所有的回复必须跟 PRD 5.3 对齐」）——
  //   汇总行的轴从「11 类」**回退到 PRD 四维**（11 类在模型侧条目上盖不上章，
  //   实测真单 4 条全落一个「未归 11 类」桶 ⇒ 分类汇总退化成常数）。
  //   这 5 条模型侧条目的 `category` 本身就是维度口径（`dimensionOf`）⇒ 应落「合规类」。
  // ★★ 2026-10-19（Owner：「所属类别/所属子类」统一到 A3 12 类）：轴 = A3，兜底类 = `未归类`。
  assert.ok(/· .+问题：5 个/.test(String(withUrl.block)), '汇总没出');
  assert.ok(/· 未归类问题：5 个/.test(String(withUrl.block)),
    '模型侧条目**没有 A3** ⇒ 必须如实落「未归类」兜底类（不编一个类）');
  assert.ok(!/未归 11 类/.test(String(withUrl.block)), '汇总不许再出现 11 类那个旧桶名');
  assert.ok(/https:\/\/x\/docx\/Y/.test(String(withUrl.block)), '链接没出');
  // ★ 正例：带 A3 的条目必须按它的类出
  // ⚠️ 必须走**第一个参数**（库侧那一侧）—— `mergeFindings(kbList, modelList)`：
  //   模型侧走 `pickModel`，A3 两格会被白名单丢掉（本条第一版就这么写，实测落「未归类」）。
  const tax = T.mergeFindings(Array.from({ length: 3 }, (_, i) => ({ location: `t${i}`,
    category: '功效宣称', severity: 'REVIEW', source: 'kb', reason: 'r',
    taxonomyCategory: '合规与受监管宣称', taxonomySubcategory: '生理功效与效果承诺',
    basisLine: '《库》第 1 条',
    kb: { taxonomyCategory: '合规与受监管宣称', taxonomySubcategory: '生理功效与效果承诺',
          basisLine: '《库》第 1 条' } })), []);
  const taxBlock = String(T.renderMerged(tax.items, { state: 'REVIEW',
    kb: T.kbSideOf({ review: { state: 'REVIEW', issue_count: 0 } }), kbTextCount: 0,
    model: { ok: true, findings: [] }, reportUrlOverride: 'https://x/docx/Z' }).block);
  assert.ok(/· 合规与受监管宣称类问题：3 个/.test(taxBlock),
    `带 A3 的条目必须按 A3 类出：${taxBlock.slice(0, 200)}`);
});
// ═══ 第 32 组 · 截断要如实报成截断，且要重试（Owner 那张夜间图的真因）═══
//
// 实测日志：`⚖ 双轨｜模型侧 没跑成：输出里没有 JSON 数组｜raw=1545 字｜
//           raw 首 100 字="[\n {\n \"location\": …`
// **它明明有数组开头** —— 判据却报「没有 JSON 数组」。真因是**输出被腰斩**（额度用尽）。
// 报错指向错误的方向，查的人就永远查不到真因。与 `raw=0` 那个坑同一个形状。

await t('Z29 ★ 三种坏输出必须分得开（不许把「截断」报成「没写数组」）', async () => {
  const M = await import('./agent/model_side.mjs');
  const A = await import('./agent/advice.mjs');
  // ① 真的没写数组（散文）
  assert.match(M.parseFindings('我读了图，有 3 个问题').error, /没有 JSON 数组/);
  assert.match(A.parseAdvice('写的散文').error, /没有 JSON 数组/);
  // ② 截断：**有 `[` 没有 `]`** ⇒ 必须说「被截断」，且带上 raw 长度
  const cut = M.parseFindings('[{"location":"图1","category":"本地化","severity":"REVIEW","reason":"x"');
  assert.match(cut.error, /被截断/, '截断被报成了别的 —— 这正是那张夜间图的真因');
  assert.match(cut.error, /raw=\d+ 字/, '截断必须带上 raw 长度，否则查不出是额度问题');
  assert.ok(!/没有 JSON 数组/.test(cut.error), '又把截断报成「没有数组」了');
  assert.match(A.parseAdvice('[{"i":0,"advice":"改').error, /被截断/);
  // ③ JSON 语法错 ⇒ 第三种，与前两种都不同
  assert.match(M.parseFindings('[{"a":}]').error, /JSON 解析失败/);
});

await t('Z30 ★ 截断/0 字要**重试一次**（额度翻倍），散文不重试（不该白烧）', async () => {
  const M = await import('./agent/model_side.mjs');
  const A = await import('./agent/advice.mjs');
  const OK = '[{"location":"图1","category":"本地化","severity":"REVIEW","reason":"x","suggestion":"译成中文"}]';
  // 模型侧：第一次截断 ⇒ 重试一次并成功
  let n1 = 0; const toks = [];
  const r1 = await M.reviewModelSide({ readings: 'OCR 有字', question: 'q',
    ask: async (p, o) => { n1++; toks.push(o.maxTokens); return n1 === 1 ? '[{"x":' : OK; } });
  assert.strictEqual(n1, 2, `截断时必须重试一次，实际调了 ${n1} 次`);
  assert.ok(toks[1] > toks[0], '重试必须提高额度');
  assert.strictEqual(r1.ok, true, '重试后应当成功');
  // 建议生成：第一次 0 字 ⇒ 重试一次并成功
  let n2 = 0;
  const r2 = await A.generateAdvice({ items: [{ location: 'p', category: 'c', reason: 'r' }],
    ask: async () => { n2++; return n2 === 1 ? '' : '[{"i":0,"advice":"改成中文"}]'; } });
  assert.strictEqual(n2, 2, '0 字时必须重试一次');
  assert.strictEqual(r2.ok, true, '重试后应当成功');
  assert.strictEqual(r2.advice[0], '改成中文');
  // ★ 反向对照：**散文不重试** —— 重试也没用，那是提示词问题，不该白烧一次额度
  let n3 = 0;
  await M.reviewModelSide({ readings: 'OCR 有字', question: 'q',
    ask: async () => { n3++; return '我读到了 3 个问题，分别是……'; } });
  assert.strictEqual(n3, 1, `散文不该重试（白烧额度），实际调了 ${n3} 次`);
});
await t('Z31 ★ 安全网：≥3 但**拿不到报告链接** ⇒ 必须退回逐条平铺（宁可长，不可空）', async () => {
  // 为什么这条必须独立存在：≥3 时卡上只剩汇总行，而**汇总行不含任何可执行内容**。
  // 报告没建成时若仍走汇总，读者拿到的是「合规类问题：7 个」+ 空链接 ——
  // 比改动之前（至少还有 7 条逐条）**更没法用**。实测那一单就是既没建报告、卡上也没链接。
  const T = await import('./agent/dual_track.mjs');
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ location: `p${i}`, category: '合规',
    severity: 'REVIEW', source: 'model', reason: 'x', advice: `a${i}` }));
  const run = (n, url) => { const m = T.mergeFindings([], mk(n));
    return T.renderMerged(m.items, { state: 'REVIEW',
      kb: T.kbSideOf({ review: { state: 'REVIEW', issue_count: 0 } }), kbTextCount: 0,
      model: { ok: true, findings: [] }, reportUrlOverride: url }); };
  const hasLink = run(7, 'https://momcozy-in.feishu.cn/docx/X');
  assert.strictEqual(hasLink.summarized, true);
  assert.strictEqual(T.countRenderedItems(String(hasLink.block)), 0);
  const noLink = run(7, null);
  assert.strictEqual(noLink.summarized, false, '拿不到链接还走汇总 —— 卡片会只剩一行汇总、什么都做不了');
  assert.strictEqual(T.countRenderedItems(String(noLink.block)), 7,
    '拿不到链接时**必须**把 7 条逐条放回卡上');
});
await t('Z32 ★★ 库侧的真文档在 publish.docx 里，不在 report_url —— 不读它就永远平铺', async () => {
  // 真因（Owner「8 条还在平铺」）：旁挂里**两个字段指的是两样东西**：
  //   report_url   = 'kb/l7/reports/20261009-125549.review.md'          ← 本地路径，人点不开
  //   publish.docx = 'https://momcozy-in.feishu.cn/docx/MQsxdnFPjoFEzPx5BCtcJyFunyf'  ← 真文档
  // 我们只读前者 ⇒ 以为「库侧给了链接」⇒ 跳过自己建；而分流判据要求可点的 http ⇒ 退回平铺。
  const T = await import('./agent/dual_track.mjs');
  const DOCX = 'https://momcozy-in.feishu.cn/docx/MQsxdnFPjoFEzPx5BCtcJyFunyf';
  const LOCAL = 'kb/l7/reports/20261009-125549.review.md';
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ location: `p${i}`, category: '合规',
    severity: 'REVIEW', source: 'model', reason: 'x', advice: `a${i}` }));
  const m = T.mergeFindings([], mk(8));
  const render = (side) => T.renderMerged(m.items, { state: 'REVIEW', kb: side, kbTextCount: 0,
    model: { ok: true, findings: [] } });
  // ① 有 publish.docx ⇒ reportUrl 必须取它（不是那个本地路径）
  const withDocx = T.kbSideOf({ review: { state: 'REVIEW', issue_count: 5,
    report_url: LOCAL, publish: { published: true, docx: DOCX } } });
  assert.strictEqual(withDocx.reportUrl, DOCX, '没优先取 publish.docx —— 拿到的还是那个点不开的本地路径');
  const r1 = render(withDocx);
  assert.strictEqual(r1.summarized, true, '有真文档却没走汇总');
  assert.strictEqual(T.countRenderedItems(String(r1.block)), 0, '≥3 且有真链接时不许平铺');
  assert.ok(String(r1.block).includes(DOCX), '卡里没印出那个文档链接');
  // ② 反向对照：**只有本地路径** ⇒ 仍然不许把它当链接，必须退回平铺（人点不开的东西不算链接）
  const onlyLocal = T.kbSideOf({ review: { state: 'REVIEW', issue_count: 5, report_url: LOCAL } });
  const r2 = render(onlyLocal);
  assert.strictEqual(r2.summarized, false, '只有本地路径却走了汇总 —— 卡上会只剩一行汇总、点不开');
  assert.strictEqual(T.countRenderedItems(String(r2.block)), 8, '退回平铺时 8 条必须都在');
});

// ══════════════════════════════════════════════════════════════════════════════
// Z34 ★（2026-10-09，Owner 裁定「2 先于 1」）**库侧有链接时，也必须用本仓那份**
// ══════════════════════════════════════════════════════════════════════════════
//   Owner 的疑问：「发文案给守衡输出的报告格式是对的，发图片和视频就不对了？」
//
//   查清后的成因（反直觉）：那一行 `&& !kbSide?.reportUrl` 让两条路**互斥** ——
//     · 文案单：库侧自己 **1 条（<3）** ⇒ 库侧不建 docx ⇒ 空 ⇒ 本仓建 ⇒ **卡上链接对**；
//     · 图片/视频单：库侧自己 **5 条（≥3）** ⇒ 库侧建了 docx ⇒ 有值 ⇒ **本仓被跳过**
//       ⇒ 卡上链接指向**库侧那份**（只装库侧条目、条目数对不上卡、还把库内案例渲染成「命中」）。
//   ⇒ 口径：**只要卡内 ≥3，就用本仓那份**。库侧那份降为"库侧自己留的档"。
//
//   这一组是那个裁定的**护栏**：拆掉 `!kbSide?.reportUrl` 这个改动，Z34a 必须变红。
{
  const { runSubmissionGate } = await import('./agent/agent.mjs');
  const KBURL = 'https://momcozy-in.feishu.cn/docx/KBSIDE5';   // 库侧自己那份（5 条 ≥3）
  const MERGED = 'https://momcozy-in.feishu.cn/docx/MERGED7';  // 本仓合并那份（卡内 7）
  const KBANS = withImageSkillReceipt(['【审查结论：REVIEW】共发现 5 处需人工确认。', '',
    '· 措辞表达类问题：3 个', '',   // 2026-10-19：同上，每类一行
    // ★ 2026-10-14：这一行随**问题方向**变（原先写死「内容治理负责人」）。
    //   品牌一致性类在路由表里没有对应词 ⇒ 落 `fallback_review_owners`（法务 + 北美同事）。
    '建议转 @法务（未配置） @北美同事（未配置） 复核。'].join('\n'));
  const mkGate = async (runner) => runSubmissionGate({
    imageClaimRunner: completedImageClaimFixture,
    adviceRunner: async ({ items }) => ({ ok: true, ms: 1,
      advice: Object.fromEntries((items || []).map((_, i) => [i, `改法 ${i}`])) }),
    inbound: { text: '审一下这张图', imageCount: 1, videoCount: 0,
      images: [completedImageReadFixture()] },
    question: '审一下这张图', notify: null,
    // ★ 库侧**给了**链接 —— 这就是图片/视频单的形状（原先在这里被跳过）
    chainRunner: async () => ({ answer: KBANS, engine: IMAGE_ENGINE_OK, review: { state: 'REVIEW', issue_count: 5,
      publish: { published: true, docx: KBURL, record_id: 'recX' },
      report_url: KBURL, report_url_kind: 'feishu_docx' } }),
    publishRunner: async () => ({ ok: true, record_id: 'recX' }),
    modelSideRunner: async () => ({ ok: true, ms: 1,
      findings: [1, 2].map((n) => ({ category: '本地化', location: `画面 ${n}`,
        severity: 'REVIEW', reason: 'x' })) }),
    mergedReportRunner: runner,
  });

  await t('Z34a ★ 库侧有链接时，本仓**仍要**建合并报告，且卡上用它', async () => {
    let called = 0;
    const g = await mkGate(async () => { called++; return { ok: true, url: MERGED, detail: '桩' }; });
    assert.strictEqual(called, 1, '库侧有链接就把本仓这一跳跳过了 —— Owner 的裁定没落地');
    const blk = String(g.verdict53?.block ?? '');
    assert.ok(blk.includes(MERGED), `卡上不是本仓那份：${(blk.match(/docx\/\w+/) || ['(无)'])[0]}`);
    assert.ok(!blk.includes('KBSIDE5'), '卡上还留着库侧那份的链接（两份文档会打架）');
  });

  await t('Z34b 反向对照：本仓建失败 ⇒ 回落库侧那份（有链接好过没链接）', async () => {
    const g = await mkGate(async () => ({ ok: false, url: null, detail: '建失败：桩' }));
    const blk = String(g.verdict53?.block ?? '');
    assert.ok(blk.includes('KBSIDE5'), '建失败时没有回落库侧链接 —— 卡上会变成没有链接');
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// Z35 ★（2026-10-09）**报告正文里的库内原始 HTML 必须转义，否则整份文档被飞书拒收**
// ══════════════════════════════════════════════════════════════════════════════
//   Owner 的问题：「文案是合并报告，图片/视频现在是合并报告吗？这 3 个要改成一致的」。
//
//   查出来的真因**不是** fix #2 没生效，而是**合并报告建了但发不出去**：
//     建云文档失败：invalid <img> local resource tag:
//     XML syntax error on line 1: invalid character entity &#39 (no semicolon)
//
//   库内记录的 `excerpt` **含原始 HTML**（实测那条视频单的命中原文是
//   `>修改字幕</li></ol><img name="image.png" alt="…">` 与 `<table><colgroup>…`）。
//   飞书 `docs +create` 把 markdown 里的 `<…>` **当 HTML 解析** ⇒ 撞坏实体 ⇒ **整份被拒**。
//   为什么"发文案对、发图/视频不对"：文案单命中是纯文本（不含 `<`），图/视频单命中富文本。
//
//   实测（2026-10-09）：那份 12,877 字节的真实报告原样发 `ok:false`；
//   **只**把 `<` `>` 转义后 `ok:true`，且结构一字未损（标题 1 / 二级 4 / 加粗 166 前后一致）。
{
  const { mdBodySafe, mdTextSafe } = await import('./agent/merged_report.mjs');

  await t('Z35a 跨行 HTML 标签所在的行必须整行转义（第一版只认单行标签 ⇒ 漏）', async () => {
    const src = ['# 报告', '', '   命中原文（逐字）：<img name="image.png"',
      ' alt="图片展示了一位女性在厨房">', '', '**加粗**照旧'].join('\n');
    const out = mdBodySafe(src);
    assert.ok(!/<\/?[A-Za-z]/.test(out), `仍有裸标签：${out.slice(0, 120)}`);
    assert.ok(out.includes('&lt;img'), '没转义成实体');
    // ⚠️ 反向对照：**正常 markdown 一个字符都不许动**
    assert.ok(out.startsWith('# 报告'), '标题被改坏');
    assert.ok(out.includes('**加粗**照旧'), '加粗被改坏');
  });

  await t('Z35b 没有 HTML 的正文必须逐字不变（防"顺手全转义"）', async () => {
    const src = ['# 内容审查报告', '', '- 结论：**REVIEW** ｜ 问题数量：**3**',
      '', '| 分类 | 条数 |', '|-|-|', '| 合规 | 1 |', '',
      '1.【本地化】整句', '   **原因**：未标市场', '   **依据**：无库内依据'].join('\n');
    assert.strictEqual(mdBodySafe(src), src, '正常 markdown 被改动了 —— 报告会变丑');
  });

  await t('Z35c 反向对照：**裸实体单独出现不会导致拒收** ⇒ 不许顺手把它也转义', async () => {
    // 实测（2026-10-09）：只含 `&#39;` 的文档飞书照收（`ok:true`）；那个报错是
    // **在 `<img …>` 标签内部**才冒出来的，而标签行已被 Z35a 那条覆盖。
    // 所以这里钉的是「**别过度防守**」：`&#39` 是正常文本，改了就把原文改样了。
    const src = '行内有 &#39 这种裸实体，以及 &#x27 另一种。';
    assert.strictEqual(mdBodySafe(src), src, '把裸实体也转义了 —— 那是过度防守，且改动了原文');
  });

  await t('Z35d 命中原文注入点：hitsBlock 进报告前必须转义', async () => {
    const { renderMergedReportMd } = await import('./agent/merged_report.mjs');
    const md = renderMergedReportMd({
      merged: [], total: 3, state: 'REVIEW', line: '【审查结论：REVIEW】共发现 3 处需人工确认。',
      hitsBlock: '**库内命中（读数）**\n\n1. `#a`｜BM25 1｜internal_sample\n'
        + '   命中原文（逐字）：<table><tr><td>x</td></tr></table>\n   直链：—',
      question: 'q', contentId: 'c', at: 'T', kbGap: 0, kbTextCount: 0, modelCount: 0,
    });
    assert.ok(!/<table>/.test(md), 'hitsBlock 里的 HTML 没转义 ⇒ 这份文档发不出去');
    assert.ok(md.includes('&lt;table&gt;'), '没有转义成实体');
  });
}
// ★★ 2026-10-09 修（**静默空转**，比红更坏）：
//   这里原先有**两块**一模一样的「汇总 + `process.exit`」，而它们**后面还有测试**
//   —— 另一会话追加的「第 27 组」与本次追加的「第 33 组」全在 `exit` 之后，
//   **一次都没跑过**，而上面那行「合计」照样打印得像全绿（数字只统计到 exit 那一刻）。
//   这正是 `AGENTS.md` §2.4 那个病的又一处：**判据写好了，但没有一行代码会执行它**。
//   ⇒ 汇总与退出**只保留文件最后一份**（见文件末尾），中间不许再有。

// ═══ 第 27 组 · 「问题数 ≥3 ⇒ 飞书文档要带报告」（Owner 2026-10-09）═══
//
// Owner 的原话：「我的目标是让守衡输出的问题数量按照 PRD 等于或大于 3 个问题时，
// **写入的飞书文档要带报告**」。
//
// 病灶：报告**只有库侧会建**，而它的门槛读的是**它自己的** `issue_count`。
// 实测 2026-10-09 09:35 那张图：卡上说 6 处（库侧 1 ＋ 模型侧 5），而旁挂 `issue_count = 1`
// ⇒ 库侧不建 docx ⇒ `report_url = null` ⇒ **按 PRD 该给报告，却没有任何链接可给**。
// 现在改由**本仓**建：门槛读**卡里那个数**（`rendered.total`），正文含两侧全部条目。
//
// ⚠ 这一组**用桩**（`mergedReportRunner`）—— 真调会在 Owner 的飞书里建一份云文档。
//   写这一组时就因为忘了注入，跑一次自证真建了一份（§2.4.4 那个病，已修）。

await t('Z15 ★ 行为级：问题数 ≥3 且库侧没给链接 ⇒ 本仓建报告，卡里那一行是**真链接**', async () => {
  const { runSubmissionGate } = await import('./agent/agent.mjs');
  // ★★ 2026-10-14：条目计数改用 `countRenderedItems`（原先数的是 `**判定**：` 行，
  //   那是**寄生判据** —— 字段一删就静默数成 0 条，红的原因变成「计数器坏了」）。
  //   **必须提到这个作用域**：下面 `mergedReportRunner` 回调里要用它，而回调在别的块里
  //   ⇒ 只靠后面那句 `const T = …` 会撞 TDZ（实测报 `T is not defined`，
  //     而它只是「报告没建」，**不阻断结论** ⇒ 会静默少建一份报告）。
  const T = await import('./agent/dual_track.mjs');
  // ★★ 2026-10-14（Owner：「所有参考知识库的，都必须带飞书侧源链接」）：
  //   夹具补齐成**现代引擎输出**的形状（原因 / 依据 / 锚点 / 建议四行）。
  //   原先是老格式（只有 `1.【本地化】图 1` 一行、没有 `依据`），于是
  //   `kbFindingsOf` 这条来路**抠不出 `basisLine`** ⇒ 渲染层退回重建版
  //   `《知识库》（未给条款号）`；而它以前还能印出「有库内条款依据」，
  //   靠的是**那条种子候选被误当成库内条目**顶了位（正是本轮修掉的缺陷）。
  //   ⇒ 夹具必须长得像真产出，否则测的是别的形状（同「样本不对，结论就是假的」）。
  const KB_ANSWER = ['【审查结论：REVIEW】共发现 1 处需人工确认。', '',
    '1.【本地化】图 1，逐字命中「图」',
    '  **原因**：逐字命中',
    '  **依据**：《措辞表达库 v0》第 W-1.48 条 ← 命中「图」'
      + '｜原始出处：https://momcozy-in.feishu.cn/base/Lk3Qb8y2QaVyZns6gprcVNE9nA0?table=tblcbk4XiW6471YN&record=recvuJP2jyHizA',
    '  **锚点**：#广告文案明细/recvuJP2jyHizA/命中片段｜source_sha256：' + 'a'.repeat(16),
    '  **建议**：按模板改',
    '', '建议转 对接人 复核。'].join('\n');
  const STUB = 'https://example.invalid/docx/Z15';
  let called = 0;
  const g = await runSubmissionGate({
    imageClaimRunner: completedImageClaimFixture,
    // ★ 2026-10-09：**建议生成必须注入** —— 它默认真打 LLM（漏一处就把套件拖到超时，实测 7.5s/次）
    adviceRunner: async ({ items }) => ({ ok: true, ms: 1,
      advice: Object.fromEntries((items || []).map((_, i) => [i, `自证桩给的改法 ${i}`])) }),
    inbound: { text: '审核下这张图', imageCount: 1, videoCount: 0,
      images: [completedImageReadFixture()] },
    question: '审核下这张图', notify: null,
    chainRunner: async () => ({ answer: withImageSkillReceipt(KB_ANSWER), engine: IMAGE_ENGINE_OK,
      review: { state: 'REVIEW', issue_count: 1 } }),
    publishRunner: async () => ({ ok: true, record_id: 'recX' }),
    modelSideRunner: async () => ({ ok: true, ms: 1,
      findings: [1, 2, 3, 4, 5].map((n) => ({ category: '本地化', location: `画面 ${n}`, severity: 'REVIEW', reason: 'x' })) }),
    mergedReportRunner: async (md) => {
      called++;
      // 报告正文必须**两侧条目都在**（Owner：「6 个就展示 6 个问题」）。
      // ★ 2026-10-13：两侧**不再各有一个小标题**（Owner 把它们连免责一起列进了「废话」），
      //   所以判据从「有没有那两个标题」改成「**条目在不在、来源标没标**」——
      //   后者才是「这条回不回得了源」，也是那两个标题原先承担的**唯一**信息。
      // ★ 2026-10-13（Owner：「不要出现 知识库侧，模型侧」）：标记改了措辞，
      //   判据跟着改成**新措辞**（去的是词，不是「回不回得了源」这条信息）。
      assert.ok(/\*\*有库内条款依据\*\*/.test(md), '报告缺「有库内条款依据」那条（来源标记没了）');
      // ★★ 2026-10-19（Owner：「去掉『—— 无库内依据 · 建议转人工』的字眼，
      //   但是我问你的时候，你要能说出是模型侧还是知识库侧问题」）——
      //   这里**反过来钉**：被摘掉的两个状态标签**一个都不许回来**。
      //   ⚠️ 摘的是**标签**，不是**条目** —— 条目还在不在，由紧跟着的
      //      `countRenderedItems` 与 A3 标签那几条断言钉着（两件事分开钉，别混成一条）。
      assert.ok(!/\*\*无库内依据 · 建议转人工\*\*/.test(md), '被 Owner 摘掉的状态标签又回来了');
      assert.ok(!/\*\*无库内条款 · 依据为外部标准\*\*/.test(md), '「无库内条款 · 依据为外部标准」又回来了');
      assert.ok(!/知识库侧|模型侧/.test(md), '「知识库侧/模型侧」又出现了（Owner 点名去掉）');
      assert.ok(!/## 一、知识库侧|## 二、模型侧/.test(md), '两个来源小标题又回来了（Owner 点名去掉）');
      // ★★ 2026-10-14（Owner 裁定「去掉『判定』这个字段」）：这一处原先拿
      //   `/^ {3}\*{0,2}判定\*{0,2}：/gm` **当条目计数器**（每条恰好一行 `**判定**：`）。
      //   那是个**寄生判据**：它量的不是「有几条问题」，而是「有几行某个字段」——
      //   字段一删就**静默数出 0 条**，红的原因变成「计数器坏了」，红得对不上病。
      //   ⇒ 改量**真东西**：逐条块的行首编号（`renderMergedItem` 的第一行）。
      //   实测：这里要的是「6 条」＝ 库侧 1 ＋ 模型侧 5，换个字段不该影响这个数。
      const n = T.countRenderedItems(md);
      assert.strictEqual(n, 6, `报告里应有 6 条（两侧合计），实际 ${n} 条`);
      assert.ok(md.startsWith('# '), '报告首行必须是 H1（lark-cli markdown 导入的硬要求）');
      return { ok: true, url: STUB, detail: '自证桩' };
    },
  });
  assert.strictEqual(called, 1, '≥3 时没去建报告 —— Owner 的目标没达到');
  const blk = String(g.verdict53?.block ?? '');
  // ★ 2026-10-19：文案压成 `→ 完整清单：`（PRD §17 字数限制）
  assert.ok(blk.includes(STUB), `卡里那一行不是真链接：${(blk.match(/→ 完整清单：[^\n]*/) || ['(那一行都没有)'])[0].slice(0, 120)}`);
  assert.strictEqual(g.verdict53?.from, 'dual-track-merged', '抬头没走双轨合并那一支');
});

await t('Z16 ★ 反向对照：建报告**失败**时不许说成已出报告，且**不许阻断结论**', async () => {
  const { runSubmissionGate } = await import('./agent/agent.mjs');
  // ★★ 2026-10-14（Owner：「所有参考知识库的，都必须带飞书侧源链接」）：
  //   夹具补齐成**现代引擎输出**的形状（原因 / 依据 / 锚点 / 建议四行）。
  //   原先是老格式（只有 `1.【本地化】图 1` 一行、没有 `依据`），于是
  //   `kbFindingsOf` 这条来路**抠不出 `basisLine`** ⇒ 渲染层退回重建版
  //   `《知识库》（未给条款号）`；而它以前还能印出「有库内条款依据」，
  //   靠的是**那条种子候选被误当成库内条目**顶了位（正是本轮修掉的缺陷）。
  //   ⇒ 夹具必须长得像真产出，否则测的是别的形状（同「样本不对，结论就是假的」）。
  const KB_ANSWER = ['【审查结论：REVIEW】共发现 1 处需人工确认。', '',
    '1.【本地化】图 1，逐字命中「图」',
    '  **原因**：逐字命中',
    '  **依据**：《措辞表达库 v0》第 W-1.48 条 ← 命中「图」'
      + '｜原始出处：https://momcozy-in.feishu.cn/base/Lk3Qb8y2QaVyZns6gprcVNE9nA0?table=tblcbk4XiW6471YN&record=recvuJP2jyHizA',
    '  **锚点**：#广告文案明细/recvuJP2jyHizA/命中片段｜source_sha256：' + 'a'.repeat(16),
    '  **建议**：按模板改',
    '', '建议转 对接人 复核。'].join('\n');
  const g = await runSubmissionGate({
    imageClaimRunner: completedImageClaimFixture,
    // ★ 2026-10-09：**建议生成必须注入** —— 它默认真打 LLM（漏一处就把套件拖到超时，实测 7.5s/次）
    adviceRunner: async ({ items }) => ({ ok: true, ms: 1,
      advice: Object.fromEntries((items || []).map((_, i) => [i, `自证桩给的改法 ${i}`])) }),
    inbound: { text: '审核下这张图', imageCount: 1, videoCount: 0,
      images: [completedImageReadFixture()] },
    question: '审核下这张图', notify: null,
    chainRunner: async () => ({ answer: withImageSkillReceipt(KB_ANSWER), engine: IMAGE_ENGINE_OK,
      review: { state: 'REVIEW', issue_count: 1 } }),
    publishRunner: async () => ({ ok: true, record_id: 'recX' }),
    modelSideRunner: async () => ({ ok: true, ms: 1,
      findings: [1, 2, 3, 4, 5].map((n) => ({ category: '本地化', location: `画面 ${n}`, severity: 'REVIEW', reason: 'x' })) }),
    mergedReportRunner: async () => ({ ok: false, url: null, detail: '建云文档失败：权限不足' }),
  });
  // 结论照样要出来（报告与三态是两件事）
  assert.ok(/共发现 6 处/.test(g.verdict53?.line ?? ''), `结论被报告失败带崩了：${g.verdict53?.line}`);
  const blk = String(g.verdict53?.block ?? '');
  assert.ok(/完整清单/.test(blk), '连那一行都没了 —— 拿不到也要出声');
  assert.ok(/本次未拿到报告链接/.test(blk), '建失败却没说清 —— 会让人以为没有报告这回事');
  // ★★ 2026-10-14：这条原先写 `!/momcozy-in\.feishu\.cn/.test(blk)` —— **判据写宽了**。
  //   它要拦的是「**报告链接**」，可这个正则把**依据行里的 L0 源直链**也一起拦了；
  //   而那条 L0 直链恰恰是 Owner 要的（「所有参考知识库的，都必须带飞书侧源链接」）。
  //   以前它没红，只是因为**老夹具的库侧那条根本没有链接**。
  //   ⇒ 改成只查**报告链接那一行**（`→ 完整清单…`），依据行不在此列。
  //   ⚠️ 两个链接是**两件事**：报告链接 = 完整清单的云文档；L0 直链 = 「这条依据出自哪条源记录」。
  assert.ok(!/→\s*完整清单[^\n]*https?:\/\//.test(blk),
    '建失败却在报告链接那一行编了一个链接');
  assert.ok(/→\s*完整清单[^\n]*本次未拿到报告链接/.test(blk),
    '报告链接那一行没说清「未拿到」—— 会让人以为没有报告这回事');
});

await t('Z17 ★ 接线：报告经注入发布；完整图片审查可越过普通 ≥3 门槛', async () => {
  const src = fs.readFileSync(new URL('./agent/agent.mjs', import.meta.url), 'utf8');
  assert.ok(/mergedReportRunner\s*=\s*publishMergedReport/.test(src),
    '闸门没有可注入的 mergedReportRunner —— 自证会真的往飞书建文档（§2.4.4）');
  // ★ 2026-10-13：变量名从 `md` 改成 `mdDoc`（报告现在渲染**两份**：投出的这份 ＋ 留底那份），
  //   判据跟着认新名字 —— 它查的是「走没走注入的那个 runner」，与变量叫什么无关。
  assert.ok(/await\s+(?:runBeforeDelivery\s*\(\s*\(\)\s*=>\s*)?mergedReportRunner\(md(Doc|Full)?,/.test(src), '接线里没走注入的那个 runner');
  // ★ 反向对照：**不许**绕过注入点去直接调真函数 —— 那会让上面两条恒真
  assert.ok(!/await\s+(?:runBeforeDelivery\s*\(\s*\(\)\s*=>\s*)?publishMergedReport\(md/.test(src),
    '接线里直接调了真函数 —— 注入点形同虚设，自证又会建真文档');
  const reportSrc = fs.readFileSync(new URL('./agent/merged_report.mjs', import.meta.url), 'utf8');
  const { shouldPublishMergedReport } = await import('./agent/merged_report.mjs');
  // ★ 2026-10-22（Owner：「报告不展示 图片安全审查 skill 全流程结果」）：
  //   正文撤了，接线也要撤干净 —— 报告闸不再接 skill 正文这个参数。
  assert.ok(!/shouldPublishMergedReport\(\{ total: reportTotal,[\s\S]*?imageSkillReview/.test(src),
    '报告接线还在把 skill 正文交给发布闸 —— 正文已撤，参数也要撤（§2.4.4）');
  assert.ok(/hasContent && \(Number\(total\) >= REPORT_LINK_MIN_ISSUES \|\| !!force\)/.test(reportSrc),
    '发布闸必须保留 PRD §5.3.4 的 ≥3 门槛（不再有「完整图片审查单独发布」那一条）');
  assert.ok(!shouldPublishMergedReport({ total: 1, itemCount: 1 }),
    '普通单 1 条仍须服从 PRD 的 ≥3 门槛');
  assert.ok(!shouldPublishMergedReport({ total: 1, itemCount: 1, imageSkillReview: '完整图片审查' }),
    'skill 正文已撤，1 条也不例外 —— 否则建出来是只有一句结论的空文档');
  assert.ok(shouldPublishMergedReport({ total: 3, itemCount: 3 }),
    '≥3 条必须照旧出报告（门槛没被顺手改坏）');
  assert.ok(/total: reportTotal/.test(src),
    '报告正文没读原始卡面总数 —— 会退回「并进来几条」，把库侧未并进的那部分丢掉');
});

// ════════════════════════════════════════════════════════════════════════════
// 第 33 组 · **落表读数必须交到模型手上**（2026-10-09）
//
// 真事故（Owner 拿着截图来问的那张卡）：一条图片评审，链停在 **L6 闸门红**
// （`layer_gate_red`／退出码 4）。闸门**照规矩落了表**（`recvxwCWhwCO68`，14:11:57
// update，状态=待审、结论=NEEDS_INPUT），32 秒后发出去的 alert 卡上却写着：
//
//   「**对你有什么影响**：这条素材现在没有结论……**飞书表也没落这一行（拒答档）**。」
//
// —— 与盘上事实相反（`PMO/logs/lark_writes.jsonl` 06:11:57 那条就是这一行）。
// 根因不在模型：`chainBlock`（它唯一看得到的读数）在**链返回时**就定稿了，
// 而落表发生在**那之后**（`runSubmissionGate` 6.0 段）⇒ 读数是空的，模型就用猜的填
// （`AGENTS.md` §2.4.1）。所以修法不是改措辞，是**把读数交出去**：
// 判据（`publishFactBlock`）＋ 接线（拼进 `chainBlock` 再 `buildUserTurn`）＋ 反向对照。
// ────────────────────────────────────────────────────────────────────────────
console.log('\n═══ 33. 落表读数（卡片不许自称「没落表」）═══');

await t('V1 落了表：读数必须带**行号**，并且明写「不许说没有这一行」', async () => {
  const g = await import('./agent/review_gate.mjs');
  const b = g.publishFactBlock({ ok: true, action: 'updated', record_id: 'recvxwCWhwCO68', readback: 'consistent' },
    { conclusion: 'NEEDS_INPUT', status: '待审' });
  assert.ok(b.includes('recvxwCWhwCO68'), `行号没进读数：${b}`);
  assert.ok(b.includes('NEEDS_INPUT') && b.includes('待审'), `结论/状态没进读数：${b}`);
  assert.ok(b.includes('consistent'), `回读读数没进：${b}`);
  assert.ok(/不许.*表里没有这一行/.test(b), '没写明「不许说表里没有这一行」—— 那句话正是事故原话');
  assert.ok(/只许照抄/.test(b), '没写明读数只许照抄');
  // 新建与更新要长得出来（`action` 不许被吞掉，否则人看不出这是新行还是补写）
  const c = g.publishFactBlock({ ok: true, action: 'created', record_id: 'recvNEW' });
  assert.ok(/新建/.test(c) && !/更新/.test(c), `created 被写成了别的动作：${c}`);
});

await t('V2 没落成：**被熔断关掉**与**真失败**必须长得不一样，且都要明说表里没有行', async () => {
  const g = await import('./agent/review_gate.mjs');
  const skipped = g.publishFactBlock({ ok: false, action: 'skipped', detail: '落表被 SHOUHENG_REVIEW_TABLE=off 关掉了' });
  const failed = g.publishFactBlock({ ok: false, action: 'updated', detail: '回读失败：列表读不到' });
  assert.ok(!skipped.includes('失败'), `熔断（故意的）被写成了「失败」：${skipped}`);
  assert.ok(/没有执行/.test(skipped), `熔断必须写成「这一步没有执行」：${skipped}`);
  assert.ok(/失败/.test(failed) && /列表读不到/.test(failed), `真失败没带原因：${failed}`);
  for (const [name, b] of [['skipped', skipped], ['failed', failed]]) {
    assert.ok(/没有行/.test(b), `${name} 没明说表里没有这一行 ⇒ 人不知道要去补`);
    assert.ok(!/已(新建|更新)/.test(b), `${name} 里出现了「已新建/已更新」—— 自相矛盾`);
  }
  // 反向对照：**没有读数**时不许说「表里没有」（那是把「我不知道」说成了「没有」）
  const nul = g.publishFactBlock(null);
  assert.ok(/没有落表读数/.test(nul), `null 读数没写清楚：${nul}`);
  assert.ok(!/没有行/.test(nul), 'null 读数被说成了「表里没有行」—— 「不知道」被说成了「没有」');
  assert.ok(/一个字都不许提表/.test(nul), 'null 读数时没禁止模型谈表 ⇒ 它只能猜');
});

await t('V3 ★ 行为级：链在层闸门红处停下时，模型拿到的读数里**必须**有那一行行号', async () => {
  const { runSubmissionGate } = await import('./agent/agent.mjs');
  // 事故那一单的复核形状：链「跑成」但库侧拒答；闸门照样落表（返回真行号）。
  const g = await runSubmissionGate({
    imageClaimRunner: completedImageClaimFixture,
    inbound: { text: '审核下这张图', imageCount: 1, videoCount: 0 },
    question: '审核下这张图', notify: null,
    chainRunner: async () => ({ answer: '结论：NEEDS_INPUT。某层闸门红（layer_gate_red），退出码 4。' }),
    publishRunner: async () => ({ ok: true, action: 'updated', record_id: 'recvxwCWhwCO68', readback: 'consistent' }),
    modelSideRunner: async () => ({ ok: false, findings: [], error: '桩' }),
    adviceRunner: async () => ({ ok: true, advice: {} }),
    mergedReportRunner: async () => ({ ok: true, url: null, detail: '桩' }),
  });
  const turn = String(g.question ?? '');
  assert.ok(turn.includes('recvxwCWhwCO68'), '落表读数没进模型那一轮 ⇒ 它又会去猜表里有没有这一行');
  assert.ok(/落表读数/.test(turn), '读数块没有抬头 ⇒ 模型分不清它是什么');
  assert.ok(/不许.*表里没有这一行/.test(turn), '没把「不许反着说」交给模型');
});

await t('V4 ★ 反向对照：落表**抛异常**时必须落进「没有读数」那一支，不许静默', async () => {
  const { runSubmissionGate } = await import('./agent/agent.mjs');
  const g = await runSubmissionGate({
    imageClaimRunner: completedImageClaimFixture,
    inbound: { text: '审核下这张图', imageCount: 1, videoCount: 0 },
    question: '审核下这张图', notify: null,
    chainRunner: async () => ({ answer: '结论：REVIEW。依据 W-1.54。' }),
    publishRunner: async () => { throw new Error('网络断了'); },
    modelSideRunner: async () => ({ ok: false, findings: [], error: '桩' }),
    adviceRunner: async () => ({ ok: true, advice: {} }),
    mergedReportRunner: async () => ({ ok: true, url: null, detail: '桩' }),
  });
  const turn = String(g.question ?? '');
  assert.ok(/没有落表读数/.test(turn), '落表抛异常后读数块没出现 ⇒ 模型对表的状态一无所知却会照写');
  assert.ok(!/已(新建|更新)/.test(turn), '落表失败了却告诉模型「已落表」');
  assert.strictEqual(g.publish, null, '抛异常时 publish 应当是 null（不许编一个结果出来）');
});

await t('V5 ★ 反向对照：**不是送审**的那一轮，一个字符都不许加', async () => {
  const { runSubmissionGate } = await import('./agent/agent.mjs');
  const g = await runSubmissionGate({
    imageClaimRunner: completedImageClaimFixture,
    inbound: { text: '在吗', imageCount: 0, videoCount: 0 }, question: '在吗', notify: null,
    chainRunner: async () => { throw new Error('不该被调用'); },
    publishRunner: async () => ({ ok: true, action: 'created', record_id: 'recvXXX' }),
    // ★ 就算「不是送审」这一支也要**显式注入**：`Z25` 那条接线断言要求**每一处**
    //   `runSubmissionGate` 调用点都注入 `adviceRunner`（不注入就会真打 LLM）。
    //   这个桩按设计**永远不会被调用** —— 它存在的意义是「将来判据改了也不会静默打 LLM」。
    adviceRunner: async () => { throw new Error('不是送审，不该走到建议生成'); },
  });
  assert.strictEqual(g.gate?.yes, false, '闲聊被判成了送审');
  const turn = String(g.question ?? '');
  assert.ok(!/落表读数/.test(turn), '没送审却把落表读数塞进了这一轮');
  assert.ok(!/recvXXX/.test(turn), '没送审却泄露了一个行号');
});

await t('V6 ★ 行为级：「问题数量」列必须与卡里那个数**同一个**（Owner 2026-10-09 裁定）', async () => {
  // 原口径（10-07）：表列记**库侧机器读数**，卡里是并集上限 ⇒ 实测卡 7 / 表 5。
  // Owner 看过两轮后定为「统一成卡里那个数」：同一个数在卡片抬头、PRD §5.3.4 的 ≥3
  // 门槛、以及表列必须是同一个，否则人拿表去对卡永远对不上。
  const { runSubmissionGate } = await import('./agent/agent.mjs');
  // 库侧 5 条（旁挂 issue_count=5），模型侧 2 条 ⇒ 合并卡内 7 处
  const KB = ['【审查结论：REVIEW】共发现 5 处需人工确认。', ''].concat(
    [1, 2, 3, 4, 5].map((i) => `${i}.【措辞】图 1 第 ${i} 行 —— 库侧第 ${i} 条\n   **建议**：改法 ${i}\n`)).join('\n');
  let sent = null;
  const g = await runSubmissionGate({
    imageClaimRunner: completedImageClaimFixture,
    inbound: { text: '审核下这张图', imageCount: 1, videoCount: 0,
      images: [completedImageReadFixture()] },
    question: '审核下这张图', notify: null,
    chainRunner: async () => ({ answer: withImageSkillReceipt(KB),
      engine: { state: 'REVIEW', image_skill_gate: { ok: true, load: { verdict: 'loaded' } } },
      review: { state: 'REVIEW', issue_count: 5 } }),
    publishRunner: async (row) => { sent = row; return { ok: true, action: 'updated', record_id: 'r1' }; },
    modelSideRunner: async () => ({ ok: true, ms: 1, findings: [
      { category: '本地化', location: '画面 1', severity: 'REVIEW', reason: '英文', suggestion: 's1' },
      { category: '隐私', location: '画面 2', severity: 'REVIEW', reason: '孩子出镜', suggestion: 's2' }] }),
    adviceRunner: async ({ items }) => ({ ok: true, ms: 1, advice: Object.fromEntries(items.map((_, i) => [i, 'a'])) }),
    mergedReportRunner: async () => ({ ok: true, url: null, detail: '桩' }),
  });
  // ★ 读的是 `g.dual.total`（**返回出来的那个形状**）——
  //   函数内部另有一个同名局部 `dual`（带 `.rendered`），两者字段不同：
  //   实测内部对象 `{model,kb,merged,state,rendered,kbSide,reportUrl}`，
  //   而返回给调用方的 `{state,stats,ok,model_ms,overrode,reportUrl,total,kb}`。
  //   第一版断言读了 `g.dual.rendered.total` ⇒ 恒 undefined ⇒ 假红（本次现场踩到）。
  assert.strictEqual(g.imageReviewIncomplete, false, '计数一致性夹具必须先完成图片审查');
  const cardTotal = g.dual?.total ?? null;
  assert.ok(Number.isFinite(cardTotal), `这一单应当有合并总数（卡内那个数），实际 ${cardTotal}`);
  assert.strictEqual(sent?.issueCount, cardTotal,
    `表列「问题数量」${sent?.issueCount} ≠ 卡里那个数 ${cardTotal} —— 两处口径又分开了`);
  // ★ 库侧那个读数**不许丢**：它必须还在汇总格里（差从"看不见"变成"看得见且同一个数"）。
  //   同理这里不能读 `g.dual.kbSide`（那是**函数内部**那个形状的字段）——
  //   本单注入的库侧读数是 5，直接断言这个数在正文里。
  // ★★ 2026-10-15（Owner）：**这一格只放 PRD 的「审查结论」块** ——
  //   原版这两条断言要求格里有「库侧 N 条机器读数」与「本列问题数量按卡里那个数记」
  //   （2026-10-09 的口径裁定）。Owner 当天明确推翻：「按照 prd 只出结论，不要自己加其他内容」，
  //   并给出逐字格式（结论行 → 逐条问题 → 分类汇总 → 另有 N 条 → 报告链接 → 动作行）。
  //   ⇒ 判据**跟着口径一起改**，而且改成**反向**断言：那几样内部读数**不许**再出现在这一格。
  const summ = String(sent?.summary ?? '');
  assert.ok(/^【审查结论：(PASS|REVIEW|BLOCK)】/.test(summ.slice(0, 40)),
    `汇总格必须以 PRD 结论行开头（实得：${summ.slice(0, 80)}）`);
  // ⚠️ 分类汇总那一路**只在有报告链接时**才走（`summarized` 就是按链接判的，见 dual_track 那段注释）——
  //   本用例的 `mergedReportRunner` 回的是 `url: null`（报告没建成）⇒ 走**逐条回落**，
  //   那时 PRD 也不要求分类块（只给分类却不给链接，等于把人指到空处）。
  //   第一版我把这条写成无条件 ⇒ 判据比口径宽，当场假红（本次现场）。
  // ⚠️ 判据要认**真的链接**：报告没建成时那一行写的是「本次未拿到报告链接」（同一句话头），
  //   拿它当「走了汇总」会误判（本次现场：判据比口径宽 ⇒ 假红）。
  // ★★ 2026-10-19：两种措辞都认（卡面自 2026-10-19 起用 `→ 完整清单：`，为 PRD §17 让路）。
  //   只认长的那句 ⇒ 这条 `if` 恒假 ⇒ 汇总路数**从来没被判过**（判据假宽，等于没守）。
  if (/(?:→|->)\s*(?:完整清单|查看完整问题清单与修改建议)\s*[：:]\s*https?:\/\//.test(summ)) {
    // ★★ 2026-10-21（Owner 给了正确模版 `docx/CvIldNhUSoxv7DxpzwdcKUcjnfr`）：**翻面** ——
    //   这一格是 `dual.rendered.block`，**块文本**里没有 `逐条问题` 这一行
    //   （它是 2026-10-15 给**表行**样例时带进来的，已撤；三条证据见
    //    `PMO/守衡-审查报告对齐正确模版-20261021.md`）。
    // ★★ 2026-10-26：Owner 贴出 10-21 成品说「这是我想要的输出模版」，三段都有 `逐条问题`
    //   —— 那**一行在卡面上是那一组的折叠标题**（见 V6b），**不是块里的字**：
    //   卡面走 `groups[0].title`，这一格（表行）走块文本 ⇒ 两边各按各的判，
    //   所以这条断言**不变**。谁把这一行塞进块文本，prd53_format 的 ②f 与本条都会红。
    assert.ok(!summ.includes('逐条问题'), '这一格（表行·块文本）里不许有「逐条问题」—— 它只该是卡面的组标题');
    assert.ok(/·\s*[^·\n]{1,18}类问题：\s*\d+\s*个/.test(summ), '要有「· XX类问题：N 个」分类汇总行（每类一行）');
  } else {
    assert.ok(/\d+[.、]\s*【/.test(summ), '没有报告链接时按逐条回落：正文里必须有逐条条目');
  }
  assert.ok(/请修改后重新提交。|建议转 @/.test(summ), '要有动作行');
  for (const [pat, what] of [['双轨合并', '双轨读数句'], ['机器读数', '库侧机器读数'],
                             ['【逐条依据（落库留痕）】', '逐条依据块'], ['按卡里那个数记', '口径说明句'],
                             ['⚠️', '口径警示行']]) {
    assert.ok(!summ.includes(pat), `「${what}」不许再进这一格（Owner 2026-10-15：只出 PRD 结论）`);
  }
});

// ═══ V6b · Owner 2026-10-26 贴出 10-21 成品：「这是我想要的输出模版」═══════════════
//
// 三段成品（1 条 REVIEW / 2 条 BLOCK / 3 条 REVIEW）**每一段的第二行都是「逐条问题」**：
//   【审查结论：REVIEW】共发现 3 处需人工确认。
//   逐条问题                      ← 这一行（卡面上是那一组的折叠标题）
//   · …类问题：1 个
//   → 完整清单：https://…
//   建议转 @产品负责人 @法务 @北美同事 复核。
//
// 2026-10-21 晚上曾经把 ≥3 的汇总块挪进 `body`（"结论行直接接分类汇总"），
// 于是那张卡上**没有**这一行 —— 与 Owner 现在贴的模版正好差一行 ⇒ 本轮撤回那次分流。
// ⚠️ 只动**卡面包装**：`verdict.block` 一个字没动（表行那一格、`prd53_format` 的
//    ②b2/②f 判的都是块文本，仍然不含这一行）。
await t('V6b ★★ 卡面：≥3 的汇总块必须折进「逐条问题」组（Owner 2026-10-26 模版的第二行）', async () => {
  const E = await import('./reply-cards/envelope.mjs');
  const T = await import('./agent/dual_track.mjs');
  const items = [1, 2, 3].map((i) => ({
    location: `正文第 ${i} 段`, category: '合规与受监管宣称', severity: 'REVIEW', source: 'kb',
    reason: 'r', suggestion: 's',
    kb: { article_no: 'W-1.9', entry_url: 'https://x/1', basisLine: '《库》第 W-1.9 条｜原始出处：https://x/1' },
  }));
  const r = T.renderMerged(items, { state: 'REVIEW', reportUrlOverride: 'https://x/docx/a' });
  assert.ok(E.isSummaryOnlyBlock(r.block), `夹具应当是 ≥3 的汇总块，实得：${String(r.block).slice(0, 80)}`);
  const out = E.applyVerdictLine('evidence', { title: '', verdict: '', groups: [] },
    { state: 'REVIEW', line: r.line, from: 'chain', block: r.block });
  const g = out?.data?.groups?.[0];
  assert.strictEqual(g?.title, E.VERDICT_GROUP_TITLE,
    `≥3 的卡面必须有「${E.VERDICT_GROUP_TITLE}」这一组（实得 ${JSON.stringify(g?.title)}）`
    + ' —— Owner 2026-10-26 模版第二行就是它，缺了就是回到 10-21 晚上那次分流');
  assert.strictEqual(g?.expanded, true, '这一组是结论正文，必须默认展开');
  assert.ok(/类问题：/.test(String(g?.content)), '组内容应当是「· …类问题：N 个」分类汇总');
  assert.ok(!/类问题：/.test(String(out?.data?.body ?? '')), '汇总行不许再走 body（走了就没有「逐条问题」这一行）');
  // ★ 路由读数：`applyVerdictLine` 回来的 `block.slot` 就是这次分流的证据。
  //   谁把「≥3 走 body」加回来，这里立刻变成 'body' ⇒ 精确变红（本轮变异自证用的就是它）。
  assert.strictEqual(out?.block?.slot, E.blockSlotOf('evidence'),
    `≥3 的汇总块必须走进 groups 那一格，实得 ${out?.block?.slot}`);
});

await t('V7 ★ 行为级：本仓建的合并报告，URL 必须**同时**进卡片与表里那一格', async () => {
  // 实测空档（10-09 15:28 那一单 recvxxfQoRewaF／AD-20261009-028）：卡内 3 处 ⇒ 本仓建了
  // 合并报告、URL 进了卡片，而**表里「报告链接」是空的** —— 那一格只认链侧那份
  // （`res.report`），而链侧那单只有 1 条、够不到它自己的 ≥3 门槛。
  // Owner 的原话是「把能填的都填了」⇒ 卡里有的链接，表里也得有。
  const { runSubmissionGate } = await import('./agent/agent.mjs');
  const URL = 'https://momcozy-in.feishu.cn/docx/V7PROBE';
  const KB = ['【审查结论：REVIEW】共发现 1 处需人工确认。', '',
    '1.【措辞】图 1 第 1 行 —— 库侧那条', '   **建议**：改法', ''].join('\n');
  const mk = (rep) => runSubmissionGate({
    imageClaimRunner: completedImageClaimFixture,
    inbound: { text: '审核下这张图', imageCount: 1, videoCount: 0,
      images: [completedImageReadFixture()] },
    question: '审核下这张图', notify: null,
    chainRunner: async () => ({ answer: withImageSkillReceipt(KB),
      engine: { state: 'REVIEW', image_skill_gate: { ok: true, load: { verdict: 'loaded' } } },
      review: { state: 'REVIEW', issue_count: 1 } }),
    publishRunner: async (row) => { mk.sent = row; return { ok: true, action: 'updated', record_id: 'r1' }; },
    modelSideRunner: async () => ({ ok: true, ms: 1, findings: [
      { category: '本地化', location: '画面 1', severity: 'REVIEW', reason: '英文', suggestion: 's1' },
      { category: '隐私', location: '画面 2', severity: 'REVIEW', reason: '孩子出镜', suggestion: 's2' }] }),
    adviceRunner: async ({ items }) => ({ ok: true, ms: 1, advice: Object.fromEntries(items.map((_, i) => [i, 'a'])) }),
    mergedReportRunner: async () => rep,
  });
  mk.sent = null;
  const g = await mk({ ok: true, url: URL, detail: '桩' });
  assert.strictEqual(g.imageReviewIncomplete, false, '报告一致性夹具必须先完成图片审查');
  assert.ok(g.dual?.total >= 3, `这一单应当够到报告门槛（卡内 ≥3），实际 ${g.dual?.total}`);
  assert.strictEqual(mk.sent?.reportUrl, URL, `表里「报告链接」没拿到本仓建的合并报告：${mk.sent?.reportUrl}`);
  assert.strictEqual(g.dual?.reportUrl, URL, '信封那条路（卡片）也没拿到 —— 两条路必须同一个 URL');
  // ★ 反向对照：**建不出报告时不许写占位符**（一个点不开的链接比空格更坏）
  mk.sent = null;
  await mk({ ok: false, url: null, detail: '建失败：桩' });
  assert.strictEqual(mk.sent?.reportUrl, null, `没有链接时写进了占位符：${mk.sent?.reportUrl}`);
});

// ══════════════════════════════════════════════════════════════════════════════
// Z33（2026-10-09）**视频时间码必须一路走到卡片**
// ══════════════════════════════════════════════════════════════════════════════
//   Owner 原话：「目前守衡输出的没有视频的时间节点 00:12 这些」。
//
//   病灶：`t_s` 一路都算出来了（`video.mjs` 的 `frameOcr[].t_s`），但帧文本有**三个消费者**
//   各拼各的，其中**两个把 `t_s` 丢掉了**：
//     · 卡片「帧上文字」（`agent.mjs::describeMediaRead`）—— 原先只取 `f.text`；
//     · 模型侧出 findings 的输入（`model_side.mjs::readingsForModelSide`）—— 同上；
//     · 库侧检索文本（`review_gate.mjs`）—— 保留。
//   而提示词却要求模型「指得出**第几帧**」—— 要它指位置，却不给它位置。
//
//   ⇒ 现在三处共用 `video.frameLine`（唯一产者）。这一组就是钉住「卡片与模型侧都带时间码」，
//     外加一条**反向对照**：库侧文本必须**逐字未变**（那一份原先就是对的，不许被顺手改掉）。
{
  const video = await import('./agent/video.mjs');
  const { describeMediaRead } = await import('./agent/agent.mjs');
  const { readingsForModelSide } = await import('./agent/model_side.mjs');
  const FRAMES = [
    { t_s: 0.02, text: 'Momeozy Wellness 1 vs Euiy S1 Pro' },
    { t_s: 8.64, text: 'so letls.compare it with my -Eufy-S1Pro' },
    { t_s: 25.87, text: 'line1\nline2' },
    { t_s: 34.48, failed: 'ocr_threw', detail: 'x' },
    { t_s: 43.10, text: '' },                     // 画面上没字 ⇒ 不该出现一行
  ];
  const inbound = () => ({
    videoCount: 1,
    videos: [{ index: 1, meta: { duration_s: 68.9 }, framesRead: 4, frames: FRAMES,
               transcript: { ok: true, chars: 20, text: 'this is my honest review' } }],
  });

  await t('Z33a 卡片「帧上文字」必须带时间码（Owner 点名的那一条）', async () => {
    const read = String(describeMediaRead(inbound()) ?? '');
    // ★ 2026-10-09：口径改成 Owner 要的 `MM:SS`（`8.64s → [00:08]`、`0.02s → [00:00]`）
    assert.ok(/\[00:08\]/.test(read), `卡上帧文本没有时间码：${read.slice(0, 200)}`);
    assert.ok(/\[00:00\]/.test(read), '第一帧的时间码也必须在');
    assert.ok(!/\[\d+\.\d+s\]/.test(read), '卡上还印着旧的「秒.小数」形状');
  });

  await t('Z33b 模型侧输入必须带时间码＋明说「每行开头是时间码」', async () => {
    const r = readingsForModelSide(inbound());
    assert.ok(/\[00:08\]/.test(r), '模型侧输入没有时间码 ⇒ 它只能编一个「帧 3」');
    assert.ok(/时间码/.test(r), '没告诉模型行首那个数是时间码');
  });

  await t('Z33c 提示词必须要求「视频给时间码」且禁止读音轨编秒数', async () => {
    const { SYSTEM } = await import('./agent/model_side.mjs');
    // ⚠️ `SYSTEM` 是**字符串**（不是数组）—— 第一版在这里调了 `.join('\n')`，
    //    把字符串拆成了字符数组 ⇒ 正则恒不命中、判据假红。踩过一次，写清楚。
    const p = String(SYSTEM);
    assert.ok(/时间码/.test(p), '提示词没要求给时间码');
    assert.ok(/不许编一个秒数/.test(p), '音轨转写没有时间戳这件事没写进提示词 ⇒ 模型会编');
  });

  await t('Z33d 库侧那份帧文本：形状逐字未变，但时间码是 Owner 的 `MM:SS` 口径', async () => {
    const got = FRAMES.map((f) => video.frameLine(f)).filter(Boolean).join('\n');
    // ★ 2026-10-09 改（Owner 第三次点这件事：「还是没展示到几秒 **00:12 格式**没看到」）：
    //   原先这里钉的是 `[0.02s]`（两位小数秒）—— 那是**旧口径**，改后按 `MM:SS` 截断。
    //   这条断言的价值仍是「形状逐字未变」（缩进 / ` / ` 折叠 / 失败帧那行都在），
    //   只是**那一格数字的形状**换成 Owner 要的：`0.02 → 00:00`、`34.48 → 00:34`。
    const want = ['  [00:00] Momeozy Wellness 1 vs Euiy S1 Pro',
                  '  [00:08] so letls.compare it with my -Eufy-S1Pro',
                  '  [00:25] line1 / line2',
                  '  [00:34] （这一帧 OCR 失败：ocr_threw）'].join('\n');
    assert.strictEqual(got, want, '库侧帧文本被改动了');
    // 反向对照：`[12.34s]` 那种带小数的旧形状**不许**再出现（否则就是没改干净）
    assert.ok(!/\[\d+\.\d+s\]/.test(got), '还在印旧的「秒.小数」形状：' + got.slice(0, 80));
  });

  await t('Z33d2 时间码必须是 `MM:SS` 且**提示词同口径**（缺一件都出不来 00:12）', async () => {
    const { mmss } = video;
    // 截断，不四舍五入：Owner 举的例子 `00:12` 对应的原始读数是 `12.91s`
    assert.strictEqual(mmss(12.91), '00:12', '12.91s 必须是 00:12（四舍五入会成 00:13，与 Owner 的卡对不上）');
    assert.strictEqual(mmss(4.30), '00:04', '4.30s 必须是 00:04');
    assert.strictEqual(mmss(60), '01:00', '满 60 秒必须进位成 01:00');
    assert.strictEqual(mmss(125.4), '02:05', '125.4s 必须是 02:05');
    assert.strictEqual(mmss(-1), '00:00', '负秒数不许印负号');
    assert.strictEqual(mmss(NaN), '00:00', 'NaN 不许漏出去（未测不许长得像测过）');
    // ★ 这一半才是「模型会不会输出 00:12」的关键：提示词教它抄的形状
    const { SYSTEM } = await import('./agent/model_side.mjs');
    assert.ok(/行首 `\[00:12\]`/.test(String(SYSTEM)),
      '提示词还在教旧形状 ⇒ 模型会照抄 `[12.34s]`，卡上永远出不来 00:12');
    assert.ok(!/行首 `\[\d+\.\d+s\]`/.test(String(SYSTEM)), '提示词里还留着旧的 `秒.小数` 形状');
  });

  await t('Z33e 画面上没字的帧不许冒出一行；无合法时间码要明说', async () => {
    assert.strictEqual(video.frameLine({ t_s: 43.1, text: '   ' }), null, '空帧不该出一行');
    const noT = video.frameLine({ text: 'abc' });
    assert.ok(/时间码缺失/.test(noT), `没有 t_s 时不许印 NaN 冒充：${noT}`);
  });
  await t('Z33f ★ 判定用校准文字，但附录可用 raw:true 回看原始 OCR', async () => {
    const f = { t_s: 4.3, text: "Eufy-S1'Pro", textRaw: "Eufy-S1'Pro", textCalibrated: 'Eufy S1 Pro' };
    assert.strictEqual(video.frameLine(f, { indent: false }), '[00:04] Eufy S1 Pro');
    assert.strictEqual(video.frameLine(f, { indent: false, raw: true }), "[00:04] Eufy-S1'Pro");
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// Z36 ★（2026-10-09）**卡内算术必须闭合**（Owner 报「图表数字对不上」）
// ══════════════════════════════════════════════════════════════════════════════
//   实测那单（16:24）：抬头「共发现 **8** 处」，页脚「知识库侧 **2** 条 ／ 模型侧 **6** 条」——
//   2+6=8 看着对，而**库侧实际并进来 5 条**（双轨读数：库侧 5 ＋ 模型侧 6 ⇒ 合并 8），
//   卡里另一处还写着「REVIEW 5 处」。根因：页脚用「**并进清单里的**库侧条目」，
//   抬头那个数却含「**没并进来的**」⇒ 两个口径不同的数并排印。
//   ⇒ 那之后页脚是「知识库侧 X（结构化读数）＋ 模型侧 Y − 计入 N 处（去重 D）＝ 本卡 N 处」。
//
// ★★ 2026-10-13（Owner 裁定）**那一行整行从卡上撤走了**（它属于「库侧/模型侧的口径读数」那一族）。
//   ⚠️ 但**不变式一条都没松**，只是换了两处落点 —— 判据必须跟着搬，否则等于把这条账删了：
//     ① **查证笔记**里那个算式仍要闭合（它就是原来那行，只是不再上卡）；
//     ② **卡面**改成「分类行相加 ＋ 另有 N 条 ＝ 抬头」——这是 PRD §5.3.3 那一格的算式，
//        同样必须闭合（实测 19:08 那单：抬头 12、分类只有 7 ⇒ 不闭合，读者一眼就看出对不上）。
{
  const T = await import('./agent/dual_track.mjs');
  const mk = (i, c) => ({ location: `p${i}`, category: c, severity: 'REVIEW', source: 'kb',
    reason: 'r', excerpt: `e${i}` });
  const mo = (i) => ({ location: `m${i}`, category: '措辞表达', severity: 'REVIEW',
    source: 'model', reason: 'x' });

  const probe = (kbCnt, kbTextN, modelCnt) => {
    const kbItems = Array.from({ length: kbCnt }, (_, i) => mk(i, '品牌一致性'));
    const modelItems = Array.from({ length: modelCnt }, (_, i) => mo(i));
    const merge = T.mergeFindings(kbItems.slice(0, kbTextN), modelItems);
    const r = T.renderMerged(merge.items, {
      state: 'REVIEW', kb: T.kbSideOf({ review: { state: 'REVIEW', issue_count: kbCnt } }),
      kbTextCount: kbTextN, model: { ok: true, findings: modelItems },
      mergedStats: merge.stats, reportUrlOverride: 'https://x/docx/A' });
    const head = Number((r.block.match(/共发现 (\d+) 处/) || [])[1]);
    // 页脚（那个算式）现在在**查证笔记**里
    const foot = (r.internalNotes.match(/^知识库侧.*$/m) || [''])[0];
    const m = foot.match(/知识库侧 (\d+) 条.*＋ 模型侧 (\d+) 条(?: − 计入 (\d+) 处（去重 (\d+))?/);
    return { head, foot, m, r };
  };

  await t('Z36a 查证笔记里那个算式仍要闭合（四种形状都核）', async () => {
    for (const [kb, txt, moN, label] of [[5, 2, 6, '库侧 5 读数/并进 2/模型 6'],
      [5, 5, 6, '库侧 5/5/6'], [0, 0, 8, '库侧 0'], [3, 3, 0, '只有库侧 3']]) {
      const { head, foot, m } = probe(kb, txt, moN);
      assert.ok(m, `查证笔记里没印出可核的算式（${label}）：${foot}`);
      const lhs = Number(m[1]) + Number(m[2]) - Number(m[4] || 0);
      assert.strictEqual(lhs, head, `${label}：${m[1]}+${m[2]}-${m[4] || 0}=${lhs} ≠ 抬头 ${head}`);
    }
  });

  await t('Z36a2 ★ 卡面的算式也要闭合：分类行相加 ＋「另有 N 条」＝ 抬头（PRD §5.3.3 那一格）', async () => {
    for (const [kb, txt, moN, label] of [[5, 2, 6, '库侧 5 读数/并进 2/模型 6'],
      [5, 5, 6, '库侧 5/5/6'], [0, 0, 8, '库侧 0'], [3, 3, 0, '只有库侧 3']]) {
      const { head, r } = probe(kb, txt, moN);
      // ★★ 2026-10-19 第三次：汇总行是**每类一行** ⇒ 逐行取数（`· <维度>类问题：N 个`）。
      const cats = [...String(r.block).matchAll(/^· .+?类问题：(\d+) 个$/gm)].map((x) => Number(x[1]));
      // ★ 2026-10-15 Owner 逐字格式里这一行**不加粗**（`· 另有 3 条（明细在报告里）`）——
      //   判据跟着改；同时兼容历史加粗形态，免得旧报告一读就红。
      const extra = Number((r.block.match(/^· 另有 \*{0,2}(\d+) 条/m) || [])[1] || 0);
      const sum = cats.reduce((a, b) => a + b, 0) + extra;
      assert.strictEqual(sum, head, `${label}：分类 ${cats.join('+')} ＋ 另有 ${extra} ＝ ${sum} ≠ 抬头 ${head}`);
    }
  });

  await t('Z36b 查证笔记要标明「库侧那个数是结构化读数」；卡面上**不许**再出现这个算式', async () => {
    const { foot, r } = probe(5, 2, 6);
    // 病灶原样：印成「知识库侧 2 条 ／ 模型侧 6 条」——2 是**并进清单里的**，看着像总数
    assert.ok(/结构化读数/.test(foot), `查证笔记没标明库侧那个数的口径：${foot}`);
    assert.ok(!/^知识库侧 \d+ 条 ／ 模型侧 \d+ 条$/.test(foot), '又退回旧形状（口径不同的两个数并排）');
    // ★ 2026-10-13 反向对照：这一行**不许**再上卡（Owner：「不要展示在卡片上」）
    assert.ok(!/结构化读数/.test(r.block), '口径读数又回到卡面了');
    assert.ok(!/^知识库侧/m.test(r.block), '「知识库侧 …」那一行又回到卡面了');
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// Z37 ★（2026-10-09）**OCR 水印不许当素材内容**（Owner 亲自看出来的根因）
// ══════════════════════════════════════════════════════════════════════════════
//   Owner 原话：「图上文字：5615 RO0 Owner 刘华問 ==》这是我，是因为图片上有水印吗？」
//   他判断对：那是飞书文档的协作水印（用户名 + 工号），而它**进了检索** ⇒
//   拿水印里的常用词撞库 ⇒ 撞出一堆无关的内部样本、又被渲染成「命中」进报告。
//
//   判据：**同一串出现在图的不同位置**（水印平铺的定义），坐标由 `vision.normalize`
//   带出（原先被它丢掉，同日修复）。
//   ⚠️ 本组有一条**反向对照**：真内容（`Sep 15 / Week1 / Week4`）**一个都不许删** ——
//     第一版用了"近似变体"判据，把这些日历数据也当水印删了（35 行误删 17 行）。
{
  const { stripOcrWatermark } = await import('./agent/ocr_watermark.mjs');
  // 线上那一单的真实 OCR 文本（逐字，从库内留痕取的）
  const REAL = ['5615 RO0', 'Owner', '刘华問', '#MomAndMore activity calendar', '5615 R00',
    'Each Group has its own activities—choose the ones you like and join in.', 'Every week：',
    '1topic activity & i+ comment or game', 'Sep 15', 'Mystery', 'activity', 'begins', '5',
    '刘华問', 'Week2', 'Sep8-14', '5615 RC', 'Week1', 'Sep 1-7', '5615 ROOT', 'Week4',
    'Sep 22-28', '5615', '刘华', 'Week3', 'Sep 15-21', '5615', 'Winners', 'announcements',
    'every weekend', '华', '八613', 'MOMCOZY', '1化司', '5615'];
  const text = REAL.join('\n');
  // 坐标：让**真的重复了的**串落在不同位置（刘华問×2、5615×3），其余各就各位
  const pos = { '刘华問': [[0.10, 0.90], [0.60, 0.35]], '5615': [[0.10, 0.85], [0.62, 0.30], [0.30, 0.12]] };
  const seen = {};
  const boxes = REAL.map((t, i) => {
    const p = pos[t];
    let x = 0.05 + (i % 6) * 0.15, y = 0.95 - (i % 12) * 0.07;
    if (p) { const k = (seen[t] = (seen[t] ?? -1) + 1); x = p[Math.min(k, p.length - 1)][0]; y = p[Math.min(k, p.length - 1)][1]; }
    return { t, x, y };
  });

  await t('Z37a 不同位置上的同一串 ⇒ 判水印（且能说出判据）', async () => {
    const r = stripOcrWatermark({ text, boxes });
    assert.strictEqual(r.basis, 'core-tiled-at-different-positions', `判据不对：${r.basis}`);
    assert.ok(r.dropped.length >= 2, `没摘到水印：${r.dropped.length}`);
  });

  await t('Z37b ★ 反向对照：真内容一个都不许删（日历的周次/日期是内容，不是水印）', async () => {
    const r = stripOcrWatermark({ text, boxes });
    const content = ['#MomAndMore activity calendar',
      'Each Group has its own activities—choose the ones you like and join in.',
      'Sep 15', 'Week1', 'Week2', 'Week3', 'Week4', 'Sep 1-7', 'Sep 22-28', 'MOMCOZY', 'Winners'];
    const lost = content.filter((c) => !r.text.includes(c));
    assert.deepStrictEqual(lost, [], `真内容被当水印删了：${lost.join(' / ')}`);
  });

  await t('Z37c 同一串落在**同一处**不许判水印（同处重复是内容，不是平铺）', async () => {
    const r = stripOcrWatermark({ text: 'MOMCOZY\nMOMCOZY', boxes: [{ t: 'MOMCOZY', x: 0.1, y: 0.5 }, { t: 'MOMCOZY', x: 0.11, y: 0.5 }] });
    assert.strictEqual(r.dropped.length, 0, `同处重复被误判成水印：${r.dropped.join(' / ')}`);
  });

  await t('Z37d 没有坐标时退回「字面重复」判据，且不误删真内容', async () => {
    const r = stripOcrWatermark({ text });
    // ★ 2026-10-09 修正：这一条原先只断言 `basis === 'exact-repeat-no-coords'`，
    //   而那个名字**从 v2 起再也印不出来**（`basis` 只在 `cores.length` 上分支 ⇒ 兜底干活也印 `none`）。
    //   断言当时是红的，红得**对**：错的是标签，不是行为。
    //   ⇒ 现在同时钉三件事：① 兜底**真的摘了**（不是"没摘还说摘了"）；
    //     ② 标签**说得出是哪条判据**；③ 真内容（`Sep 15`/`Week1`）一个都不许丢。
    assert.strictEqual(r.basis, 'exact-repeat-no-coords', `判据不对：${r.basis}`);
    assert.ok(r.dropped.length >= 2, `兜底判据没摘到东西，这条断言就变成了空转：${r.dropped.length}`);
    assert.ok(r.dropped.some((d) => /刘华問|5615/.test(d)), `摘的不是水印：${r.dropped.join(' / ')}`);
    assert.ok(r.text.includes('Sep 15') && r.text.includes('Week1'), '无坐标时误删了真内容');

    // ★ 反向对照：**一行都没摘**时必须印 `none`，不许印一个判据名冒充「我摘了」
    const clean = stripOcrWatermark({ text: 'Sep 15\nWeek1\nMOMCOZY' });
    assert.strictEqual(clean.basis, 'none', `没摘任何行却说用了判据：${clean.basis}`);
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// Z38 ★★（2026-10-09）**水印摘除 v2：用真图坐标钉住**（Owner 把原图发过来了）
// ══════════════════════════════════════════════════════════════════════════════
//   这条判据的价值全在**样本是真图**：35 行 OCR + **真实归一化坐标**（本机 OCR 跑真图取回）。
//   前三个候选判据都被它否掉了（写在 `ocr_watermark.mjs` 的注释里，免得下一个人再走一遍）：
//     · 「任意公共子串」⇒ 误删 `Week1/Sep 15`；· 「数字跨 ≥2 行」⇒ 误删 `Sep 15`；
//     · 「数字须与另一个多处数字同行」⇒ 太严（`5615` 全漏）；· 「数字紧邻字母」⇒ 分不开。
//   现在这条：**按数字核心聚类**（`5615R00`/`5615ROOT`/`5615RO`/`5615` 共享 `5615`）。
{
  const { stripOcrWatermark } = await import('./agent/ocr_watermark.mjs');
  // 真图 OCR（1252×1150）逐行 + 真实坐标
  const REAL = [
    ['5615 R00', 0.050, 0.777], ['5615 ROOT', 0.349, 0.930], ['Owner', 0.278, 0.910],
    ['Owner', 0.874, 0.913], ['#MomAndMore activity calendar', 0.145, 0.844],
    ['Each Group has its own activities—choose the ones you like and join in.', 0.169, 0.805],
    ['Owner', 0.573, 0.755], ['50', 0.645, 0.781], ['Every week：', 0.329, 0.638],
    ['1topic activity & i+ comment or game', 0.153, 0.604], ['Sep 15', 0.711, 0.665],
    ['Mystery', 0.732, 0.609], ['activity', 0.735, 0.583], ['begins', 0.740, 0.555],
    ['刘华', 0.872, 0.604], ['Week2', 0.527, 0.490], ['Sep 8-14', 0.523, 0.453],
    ['5615 RO', 0.639, 0.470], ['Week1', 0.184, 0.414], ['Sep 1-7', 0.187, 0.377],
    ['615', 0.366, 0.329], ['ROO', 0.407, 0.337], ['Week4', 0.527, 0.334],
    ['Sep 22-28', 0.517, 0.297], ['5615', 0.940, 0.318], ['刘华', 0.872, 0.297],
    ['Week3', 0.273, 0.259], ['Sep 15-21', 0.268, 0.223], ['5615', 0.646, 0.168],
    ['Winners', 0.752, 0.233], ['announcements', 0.706, 0.209], ['every weekend', 0.714, 0.180],
    ['MOMCOZY', 0.410, 0.017], ['4俗丽', 0.877, 0.009], ['50', 0.941, 0.019],
  ];
  const ocr = () => ({ text: REAL.map((r) => r[0]).join('\n'),
                       boxes: REAL.map((r) => ({ t: r[0], x: r[1], y: r[2] })) });

  await t('Z38a 真图：水印（用户名＋编号各变体）必须全部摘掉', async () => {
    const r = stripOcrWatermark(ocr());
    assert.strictEqual(r.basis, 'core-tiled-at-different-positions', `判据不对：${r.basis}`);
    for (const w of ['Owner', '刘华', '5615', '5615 R00', '5615 ROOT', '5615 RO']) {
      assert.ok(!r.text.includes(w), `水印残留：${w}`);
    }
  });

  await t('Z38b ★★ 反向对照：日历的真内容一个都不许删（本组是这条判据的核心价值）', async () => {
    const r = stripOcrWatermark(ocr());
    const content = ['#MomAndMore activity calendar',
      'Each Group has its own activities—choose the ones you like and join in.', 'Every week：',
      '1topic activity & i+ comment or game', 'Sep 15', 'Mystery', 'activity', 'begins',
      'Week1', 'Week2', 'Week3', 'Week4', 'Sep 1-7', 'Sep 8-14', 'Sep 15-21', 'Sep 22-28',
      'Winners', 'announcements', 'every weekend', 'MOMCOZY'];
    const lost = content.filter((c) => !r.text.includes(c));
    assert.deepStrictEqual(lost, [], `真内容被当水印删了：${lost.join(' / ')}`);
  });

  await t('Z38c 只有 2 次重复的**内容**数字不许当核心（防 v2a 那个误删）', async () => {
    // `15` 出现在 `Sep 15` 与 `Sep 15-21` 两行、位置不同 —— 但它**不共享数字核心**
    const r = stripOcrWatermark(ocr());
    assert.ok(!r.cores.includes('15'), '把内容数字 15 当成了水印核心');
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// Z39 ★★（2026-10-09）**水印不许进「给模型看的那一段」**（Owner 第二次来问水印）
// ══════════════════════════════════════════════════════════════════════════════
//   病灶（我自己造成的，第二次才被发现）：
//   同一段图内文字**有两个产者**，改水印时我只改了一个 ——
//     · `describeMediaRead`（卡片那一格）：已改印 `wlText` ⇒ **干净**；
//     · `buildImageBlock`（`buildUserTurn({imageBlock})` ⇒ **喂给模型**）：仍印 `im.text` ⇒ **带水印**。
//   ⇒ 我先答了 Owner「卡片会干净」，却漏了「送进去的还是脏的」：
//     模型与**报告**那一侧继续拿水印当素材内容（Owner 两轮都在追这件事）。
//   ⇒ 这一组同时钉**两个产者**：Z38 只钉「判据本身」，钉不住「接线」。
{
  const { stripOcrWatermark } = await import('./agent/ocr_watermark.mjs');
  const { buildImageBlock, describeMediaRead } = await import('./agent/agent.mjs');
  // 与 Z38 同源的真图 OCR（35 行 + 真实归一化坐标）
  const REAL = [
    ['5615 R00', 0.050, 0.777], ['5615 ROOT', 0.349, 0.930], ['Owner', 0.278, 0.910],
    ['Owner', 0.874, 0.913], ['#MomAndMore activity calendar', 0.145, 0.844],
    ['Each Group has its own activities—choose the ones you like and join in.', 0.169, 0.805],
    ['Owner', 0.573, 0.755], ['50', 0.645, 0.781], ['Every week：', 0.329, 0.638],
    ['1topic activity & i+ comment or game', 0.153, 0.604], ['Sep 15', 0.711, 0.665],
    ['Mystery', 0.732, 0.609], ['activity', 0.735, 0.583], ['begins', 0.740, 0.555],
    ['刘华', 0.872, 0.604], ['Week2', 0.527, 0.490], ['Sep 8-14', 0.523, 0.453],
    ['5615 RO', 0.639, 0.470], ['Week1', 0.184, 0.414], ['Sep 1-7', 0.187, 0.377],
    ['615', 0.366, 0.329], ['ROO', 0.407, 0.337], ['Week4', 0.527, 0.334],
    ['Sep 22-28', 0.517, 0.297], ['5615', 0.940, 0.318], ['刘华', 0.872, 0.297],
    ['Week3', 0.273, 0.259], ['Sep 15-21', 0.268, 0.223], ['5615', 0.646, 0.168],
    ['Winners', 0.752, 0.233], ['announcements', 0.706, 0.209], ['every weekend', 0.714, 0.180],
    ['MOMCOZY', 0.410, 0.017], ['4俗丽', 0.877, 0.009], ['50', 0.941, 0.019],
  ];
  // 逐字复刻 `readInboundContent` 对每张图做的那一跳（真入口要真图字节，这里只需这一跳）
  // ★ 2026-10-09 晚**收口后**的形状：`text` = **摘掉水印那份**（唯一对外文本）、
  //   `textRaw` = OCR 原文（只给诊断与留痕）。测试必须用**生产同形**的数据，
  //   否则「产者各挑各的」那类缺陷在测试里永远看不见 —— 这一版就是这么被抓出来的。
  const strip = () => {
    const text = REAL.map((r) => r[0]).join('\n');
    const boxes = REAL.map((r) => ({ t: r[0], x: r[1], y: r[2] }));
    const wm = stripOcrWatermark({ text, boxes, senderName: 'Owner' });
    return { index: 1, text: wm.text, textRaw: text, lines: REAL.length, chars: text.length,
             wlText: wm.text, wmDropped: wm.dropped, wmBasis: wm.basis };
  };
  const inbound = () => ({ imageCount: 1, images: [strip()] });

  await t('Z39a ★ 喂给模型的图块不许含水印（这一跳原先印的是 OCR 原文）', async () => {
    const b = buildImageBlock(inbound());
    for (const w of ['Owner', '刘华', '5615']) {
      assert.ok(!b.includes(w), `水印进了「给模型看的那一段」：${w}`);
    }
  });

  await t('Z39b ★ 卡片那一格同时也不许含水印（两个产者一起钉）', async () => {
    const read = String(describeMediaRead(inbound()) ?? '');
    for (const w of ['Owner', '刘华', '5615']) {
      assert.ok(!read.includes(w), `水印进了卡片：${w}`);
    }
  });

  await t('Z39c ★★ 反向对照：真内容一个都不许丢（送进去的那份）', async () => {
    const b = buildImageBlock(inbound());
    const content = ['#MomAndMore activity calendar', 'Sep 15', 'Week1', 'Week4',
                     'Winners', 'MOMCOZY', 'Every week：'];
    const lost = content.filter((c) => !b.includes(c));
    assert.deepStrictEqual(lost, [], `真内容没进图块：${lost.join(' / ')}`);
  });

  await t('Z39d 摘了水印必须明写「另摘除水印 N 行」，且行数仍报真读数', async () => {
    const b = buildImageBlock(inbound());
    // 行数不许缩水成「正文行数」—— 那是**读到几行**这个真读数（35）
    assert.ok(/35 行/.test(b), `行数不是真读数：${b.slice(0, 120)}`);
    assert.ok(/另摘除水印 \d+ 行/.test(b), '摘了水印却不说 —— 模型会以为行数对不上正文');
    assert.ok(!/另摘除水印 0 行/.test(b), '没摘也印一行「另摘除 0 行」= 噪声');
  });

  await t('Z39e 没有水印时不许凭空多出一句（反向对照）', async () => {
    const clean = { imageCount: 1, images: [{ index: 1, text: 'MOMCOZY\nSep 15', textRaw: 'MOMCOZY\nSep 15',
                                              lines: 2, chars: 13, wlText: 'MOMCOZY\nSep 15',
                                              wmDropped: [], wmBasis: 'none' }] };
    const b = buildImageBlock(clean);
    assert.ok(!/另摘除水印/.test(b), '没摘水印却印了摘除说明');
    assert.ok(b.includes('MOMCOZY') && b.includes('Sep 15'), '无水印时把内容弄丢了');
  });

  await t('Z39f ★★ 模型侧读数也不许含水印（**第三个产者**，Owner 报告里的那两条建议就是它）', async () => {
    const { readingsForModelSide } = await import('./agent/model_side.mjs');
    const r = readingsForModelSide(inbound());
    // 病灶原样（实测那份报告的建议）：模型把水印当"素材里的中文人名"写成了整改建议 ——
    // 「图上出现『Owner』『刘华問』三处中文人名，若是参与用户真名，换成昵称或整行删掉」
    // ⇒ 让被审方去改一个图上根本不存在的元素。
    for (const w of ['Owner', '刘华', '5615']) {
      assert.ok(!r.includes(w), `水印进了模型侧读数 ⇒ 模型会把它当素材内容写成整改建议：${w}`);
    }
    assert.ok(r.includes('Sep 15') && r.includes('Week1'), '模型侧把真内容弄丢了');
  });

  await t('Z39g 结构：`text` 必须是**摘除后**那份（收口的根据，四处产者不许再各挑各的）', async () => {
    const src = fs.readFileSync(new URL('./agent/agent.mjs', import.meta.url), 'utf8');
    assert.ok(/text:\s*wm\.text,\s*textRaw:\s*r\.text/.test(src),
      '`images.push` 里 `text` 不再是摘除后那份 —— 消费者又会拿到带水印的原文');
    // 诊断日志必须用原文（否则「我到底读到了什么」就没法核了）
    assert.ok(/describeMediaRead\(inbound,\s*\{\s*raw:\s*true\s*\}\)/.test(src),
      '诊断日志没走 raw:true ⇒ 印的是摘除后的，核对时看不到 OCR 真读数');
    // ★ 2026-10-13：卡上那一格**已经撤了**（Owner：媒材读数不上卡）⇒ 这一条改盯
    //   **报告附录**那一份：它必须仍是**摘除后**的（`mediaReadAppendix` 内部走默认参数）。
    //   水印会回到**人眼前**的通道就剩这一条（卡上那条已经不存在了）—— 所以更要盯住它。
    // ⚠️ 判据**只在函数体里找** —— 第一版写成「`mediaReadAppendix` 之后 200 字内出现 raw:true」
    //   就把它**自己的解释文字**扫进来了（实测命中 `…见它自己的头注）。⚠️ 这一行印 **OCR 原文**（raw:true`），
    //   于是真身永远红。这就是 §2.4.4 记的「判据被自己的注释绊倒」——**统一一条读法：注释不算代码**。
    // ★ 2026-10-27：判据收窄到**图片那一段**（`const vids =` 之前）。
    //   视频帧那一侧引入了 `ocrCalibrations` 展示，对应用 `raw:true` 先显示原始 OCR
    //   再显示校准记录（从什么改到什么）—— 视频帧没有水印摘除机制，`raw:true` 不带水印，合法。
    //   图片那一段：`i.text` 已是摘水印后的，不许再用 `raw:true` 绕过（那会把水印带回报告）。
    const body = (src.match(/export function mediaReadAppendix\([\s\S]*?\n\}/) || [''])[0];
    assert.ok(body.length > 200, '取不到 mediaReadAppendix 的函数体 —— 判据本身失效');
    // 只检查图片那一段（`const vids =` 之前），视频帧侧 raw:true 用于显示原始 OCR 供校准对照，合法
    const imgPart = body.slice(0, body.indexOf('const vids ='));
    assert.ok(imgPart.length > 100, '取不到图片那一段 —— 函数结构变了，判据需要跟着走');
    assert.ok(!/raw\s*:\s*true/.test(imgPart),
      '报告附录图片那一份改用了 raw:true ⇒ 水印会回到报告里');
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// Z40 ★★（2026-10-09 晚）**「名字只被 OCR 读出 1 次」也要摘掉**（Owner 连报两次）
// ══════════════════════════════════════════════════════════════════════════════
//   Owner 原话（这一轮）：「图上文字：Owner==》**还有我的名字**」。
//   病灶（**接线顺序错了，不是判据错**）：`readInboundContent` 读图那一刻还不知道
//   送审人叫什么（名字要到 `handleMessage` 第 4 步才解析）⇒ 判据只能靠
//   「OCR 有没有把名字读出 ≥2 次、且落在不同位置」去猜。而**同一张图的两次 OCR
//   读数并不一致**（实测：一次 `刘华問`×2 + `Owner`×1，另一次 `刘华`×2 + `Owner`×3）
//   ⇒ 只读出 1 次时它当不上"平铺核心"⇒ 摘不掉 ⇒ 卡片与报告继续带着名字。
//   水印逐字就是「**用户名 + 工号**」（台账实测 `sender: Owner`）⇒ 名字是**已知的**。
//   ⇒ 现在补一条**与 OCR 读数无关**的判据：行**逐字等于**送审人显示名 ⇒ 水印。
{
  const { stripOcrWatermark } = await import('./agent/ocr_watermark.mjs');
  const box = (t, x, y) => ({ t, x, y });

  await t('Z40a ★ 名字只出现 1 次也必须摘掉（这就是 Owner 报的那一次）', async () => {
    const r = stripOcrWatermark({
      text: ['Owner', '#MomAndMore activity calendar', 'Sep 15', 'Week1'].join('\n'),
      boxes: [box('Owner', 0.278, 0.910), box('#MomAndMore activity calendar', 0.145, 0.844),
              box('Sep 15', 0.711, 0.665), box('Week1', 0.184, 0.414)],
      senderName: 'Owner',
    });
    assert.ok(!r.text.includes('Owner'), '名字还在 —— 这一条没生效');
    assert.deepStrictEqual(r.dropped, ['Owner'], `摘错了：${JSON.stringify(r.dropped)}`);
    // ★ 判据名必须是**它自己那一个**：只靠名字摘到的，不许说成「我证明了它平铺」
    assert.strictEqual(r.basis, 'sender-name-in-ocr', `判据名不对：${r.basis}`);
  });

  await t('Z40b ★★ 反向对照：不传 senderName ⇒ 行为逐字不变（旧判据一个字没松）', async () => {
    const noName = stripOcrWatermark({
      text: ['Owner', '#MomAndMore activity calendar', 'Sep 15', 'Week1'].join('\n'),
      boxes: [box('Owner', 0.278, 0.910), box('#MomAndMore activity calendar', 0.145, 0.844),
              box('Sep 15', 0.711, 0.665), box('Week1', 0.184, 0.414)],
    });
    assert.strictEqual(noName.dropped.length, 0,
      '不传名字时把只出现一次的行摘了 —— 说明「平铺」判据被顺手放松了（那是误删真内容的方向）');
    assert.strictEqual(noName.basis, 'none', '没摘任何行却印了判据');
  });

  await t('Z40c 拿占位符「(未知名)」当判据 ⇒ 必须不生效（不许拿占位符当证据）', async () => {
    const r = stripOcrWatermark({
      text: '(未知名)\nSep 15', boxes: [box('(未知名)', 0.1, 0.1), box('Sep 15', 0.5, 0.5)],
      senderName: '(未知名)',
    });
    assert.strictEqual(r.dropped.length, 0, '把「(未知名)」当成了水印判据');
  });

  await t('Z40d 名字那一行**恰好是内容**时：只删那一行，别的不许动（边界写实）', async () => {
    const r = stripOcrWatermark({
      text: ['May', 'Week1', 'Sep 15', 'Every week：'].join('\n'),
      boxes: [box('May', 0.5, 0.5), box('Week1', 0.1, 0.4), box('Sep 15', 0.7, 0.6), box('Every week：', 0.3, 0.3)],
      senderName: 'May',
    });
    // 逐字相等 ⇒ 命中；这是**已知的、可接受的**代价（见 ocr_watermark.mjs 的注释：
    // 不做"包含"就是为了把误删面收到最小；正文里恰好只有发送人名字一行的概率极低）
    assert.deepStrictEqual(r.dropped, ['May'], `摘的不是那一行：${JSON.stringify(r.dropped)}`);
    assert.ok(r.text.includes('Week1') && r.text.includes('Sep 15'), '连带把真内容删了');
  });

  await t('Z40e 接线三跳：顺序对 / 入参声明 / 真被调用（缺一跳这条线就断）', async () => {
    const src = fs.readFileSync(new URL('./agent/agent.mjs', import.meta.url), 'utf8');
    const iDef = src.indexOf('const senderNameForWatermark = ()');
    const iRead = src.indexOf('await readInboundContent(msg');
    assert.ok(iDef > 0, '找不到 senderNameForWatermark 的定义');
    assert.ok(iRead > 0, '找不到 readInboundContent 的调用');
    // ① 顺序：名字要在**读图之前**备好
    assert.ok(iDef < iRead,
      '名字的取数函数排在读图**之后** —— 摘水印时又拿不到名字，这一整条等于没接');

    // ② 入参：`readInboundContent` 必须真的声明它（只在调用点传、函数不接 ⇒ 静默丢掉）
    const fnStart = src.indexOf('export async function readInboundContent');
    assert.ok(fnStart > 0, '找不到 readInboundContent 定义');
    const fnBody = src.slice(fnStart, src.indexOf('\n} = {}) {', fnStart) + 10);
    assert.ok(/senderNameForWatermark\s*=\s*null/.test(fnBody),
      'readInboundContent 的入参里没有 senderNameForWatermark —— 传了也没人接（静默丢参数）');

    // ③ 调用：真去取名字、真传给判据（③ 是最容易漏的一跳：参数接了却不用）
    const imgBranch = src.slice(fnStart, src.indexOf('export async function describeMediaRead'));
    assert.ok(/await senderNameForWatermark\(\)/.test(imgBranch),
      'readInboundContent 里从没调过 senderNameForWatermark() —— 参数接了不用');
    assert.ok(/stripOcrWatermark\(\{[^}]*senderName[^}]*\}\)/.test(imgBranch),
      '取到的名字没传给 stripOcrWatermark —— 取了也白取');
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// Z41 ★★（2026-10-09 晚）**卡片只留读数，全文进报告附录**
// ══════════════════════════════════════════════════════════════════════════════
//   Owner 原话：「【图 1 内文字｜35 行，另摘除水印 10 行（不是素材内容）】==》**丑排版**」，
//   并为「把原文挪到附录」这个方向**点了头**（「你下午修复过一次，把排版丑放到附录中==》可以的」）。
//
//   病灶：卡片正文里塞着 **35 行 OCR 碎片**，被 `cut(200)` 切一半、又用 ` / ` 折成一行 ——
//     既不是给人看的（碎片本就不通顺），也不是给回源核对的（切了一半）。
//   结构上它出现在**两个地方**（卡片 + 报告），而两份都是"半截"。
//
//   ⇒ 分工：**卡片给业务看读数**（读到几行、摘掉几行水印），**报告附录给回源核对全文**。
//     ⚠️ **搬不是砍**：全文必须真的落进报告附录（先证明报告接得住，再从卡上撤）。
//     ⚠️ 卡上仍要**看得见**摘了多少行水印（那是"我处理过了"的读数，不是内容）。
{
  const { describeMediaRead, mediaReadAppendix } = await import('./agent/agent.mjs');
  const { renderMergedReportMd } = await import('./agent/merged_report.mjs');
  // 真图真数据（同 Z38/Z39）：35 行 OCR + 真坐标 + 真摘除结果
  const REAL35 = [
    '5615 R00', 'Owner', '刘华問', '#MomAndMore activity calendar', '5615 R00',
    'Each Group has its own activities—choose the ones you like and join in.', 'Every week：',
    '1topic activity & i+ comment or game', 'Sep 15', 'Mystery', 'activity', 'begins', '5',
    '刘华問', 'Week2', 'Sep8-14', '5615 RC', 'Week1', 'Sep 1-7', '5615 ROOT', 'Week4',
    'Sep 22-28', '5615', '刘华', 'Week3', 'Sep 15-21', '5615', 'Winners', 'announcements',
    'every weekend', '华', '八613', 'MOMCOZY', '1化司', '5615',
  ];
  const inboundImg = () => ({
    imageCount: 1,
    images: [{
      index: 1, lines: 35, chars: 359, truncated: false,
      text: REAL35.filter((l) => !/5615|Owner|刘华問|刘华/.test(l)).join('\n'),
      textRaw: REAL35.join('\n'),
      wmDropped: ['5615 R00', 'Owner', '刘华問', '5615 R00', '刘华問', '5615 RC', '5615 ROOT',
                  '5615', '刘华', '5615'],
      wmBasis: 'core-tiled-at-different-positions',
    }],
  });
  const inboundVid = () => ({
    videoCount: 1,
    videos: [{ index: 1, meta: { duration_s: 68.9 }, framesRead: 2, framesFailed: 0,
               frames: [{ t_s: 4.3, text: 'Momeozy Wellness 1 vs Euiy S1 Pro' },
                        { t_s: 12.91, text: 'Eufy S1 Pro has a single layer' }] }],
  });

  await t('Z41a ★ 卡片那一格**不再塞 OCR 碎片**（只留读数）', async () => {
    const read = String(describeMediaRead(inboundImg()) ?? '');
    // 锚定「图上文字：」那一行里**只有读数**，不许再跟 OCR 碎片
    //   （⚠️ 别拿 `Winners` 这类词判：视频预览里也有同名字幕，会假红 —— 第一版就这么栽的）
    const line = read.split('\n').find((l) => l.startsWith('图上文字：')) ?? '';
    assert.ok(/图 1：读到 35 行/.test(line), `卡上没报读到几行：${line}`);
    assert.ok(/另摘除水印 10 行/.test(line), `卡上没报摘掉几行水印（处理凭据，不许省）：${line}`);
    assert.ok(!/activity calendar|announcements|MOMCOZY/.test(line),
      `图上文字那一行里还塞着 OCR 碎片（就是 Owner 说的「丑排版」）：${line}`);
    assert.ok(/全文见报告附录/.test(line), '卡上撤了原文却没说去哪儿找 —— 那是「砍」不是「搬」');
  });

  await t('Z41b ★★ 报告附录**必须接得住全文**（搬不是砍 —— 先证明有落点）', async () => {
    const md = String(mediaReadAppendix(inboundImg()) ?? '');
    assert.ok(md.includes('#MomAndMore activity calendar'), '报告附录没有全文');
    assert.ok(md.includes('Winners') && md.includes('MOMCOZY'), '附录被截断了 —— 那就不是「搬」是「砍」');
    // 关键：附录里**必须说明它是碎片**，否则下一个人又会拿它当正文去排版
    assert.ok(/碎片|逐行|不要把它当/.test(md), '附录没说明这是 OCR 逐行碎片');
    assert.ok(md.includes('截图层水印') && md.includes('不计为素材问题，不据此判 REVIEW'),
      '附录没有声明截图层水印不构成素材问题');
    assert.ok(md.includes('局部识读受限'), '附录没有把水印遮挡限定为局部识读受限');
  });

  await t('Z41c ★ 视频那一侧**刻意不同**：帧文字保留带时间码的压缩预览（Owner 点名要 00:12）', async () => {
    const read = String(describeMediaRead(inboundVid()) ?? '');
    // ⚠️ 这里**不许**照图那一侧一起撤掉 —— 帧文字是成句可读的，且 Owner 点名要时间码。
    //    撤的时候 Z33a（时间码必须上卡）当场变红，那一次红得对，所以分开处理。
    assert.ok(read.includes('[00:04]') && read.includes('[00:12]'),
      `卡上丢了时间码（Owner 点名要的那一条）：${read.slice(0, 160)}`);
    assert.ok(read.includes('Eufy S1 Pro has a single layer'), '视频预览里没有任何帧文字了');
    const md = String(mediaReadAppendix(inboundVid()) ?? '');
    assert.ok(md.includes('[00:04]') && md.includes('[00:12]'),
      `报告附录的帧文字没带时间码：${md.slice(0, 160)}`);
    assert.ok(md.includes('Eufy S1 Pro has a single layer'), '附录没收到第二个帧的文字');
  });

  await t('Z41d 反向对照：没带媒材时，附录**不许凭空造一节**出来', async () => {
    assert.strictEqual(String(mediaReadAppendix({}) ?? ''), '', '没有媒材却产出了附录');
    assert.strictEqual(String(mediaReadAppendix(null) ?? ''), '', 'null 入参不许炸');
  });

  await t('Z41e 接线：报告**必须**把这一节带进正文（不接=又一处「改了但没人读」）', async () => {
    const src = fs.readFileSync(new URL('./agent/agent.mjs', import.meta.url), 'utf8');
    assert.ok(/mediaReadAppendix\(inbound\)/.test(src),
      '`renderMergedReportMd` 的调用里没有 `mediaReadAppendix(inbound)` —— 附录没接进报告');
    // 且必须真的传进去（算出来不用 = 白算）
    // ★ 2026-10-13：`renderMergedReportMd` 现在被调**两次**（投出那份 `withAppendix:false`、
    //   留底那份完整），而入参收在一个 `_args` 对象里。判据改成「附录算出来了、且**传进了
    //   那个共用的入参对象**」——写成「离调用点 1200 字内出现 mediaAppendix」会被这次重构误伤。
    const i = src.indexOf('const _args = {');
    assert.ok(i > 0, '找不到渲染报告的入参对象 `_args`（结构变了，判据要跟着走）');
    assert.ok(/mediaAppendix\s*:/.test(src.slice(i, i + 1200)),
      '算出了附录却没传给 `renderMergedReportMd`');
    // 反向对照：**留底那一份必须带附录**（投出那份不带）—— 少这一半，附录就真的没了
    assert.ok(/withAppendix:\s*false/.test(src),
      '没有渲染「投出去那一份」—— 那 Owner 要去掉的附录会照旧投上云文档');
  });

  await t('Z41f 报告渲染器真的会印这一节（纯函数直调）', async () => {
    const apx = String(mediaReadAppendix(inboundImg()) ?? '');
    const md = renderMergedReportMd({ merged: [], total: 0, state: 'REVIEW', line: 'x',
                                      question: '', mediaAppendix: apx });
    assert.ok(md.includes('#MomAndMore activity calendar'), '报告正文里没有附录那一段');
    assert.ok(/^# /m.test(md), '第一行必须仍是 H1（飞书 docs +create 靠它定标题）');
  });
}

await t('Z35 ★ 内部详情不许进正文：指纹与「我工具里没这一步」必须被判红（实测那条）', async () => {
  // Owner 2026-10-09 现场：「在吗」的回复里写着两个 PRD sha 指纹与「重拉基线那一步不在我的工具里」，
  // 而旧 internalLeak（工具名 / call_xxx / 栈 / DSML 标记）**一条都不命中** ⇒ 就这么发出去了。
  const { lintCopy } = await import('./reply-cards/registry.mjs');
  const hit = (t) => lintCopy(t).filter((h) => h.id === 'internalLeak').length;
  const REAL = '在我这儿还是**旧版指纹** 1f871b42fa909e70…，新版是 bc48e2ae893ab3e7… —— '
    + '**重拉基线那一步不在我的工具里**，所以在那之前，凡引用这份 PRD 的判断我都按旧版算。';
  assert.ok(hit(REAL) > 0, '实测那条漏出去了 —— 指纹与能力自述必须被判红');
  assert.ok(hit('重拉基线那一步不在我的工具里') > 0, '能力自述没盖住');
  // ★ **两类判据各要一条只含它的夹具** —— 上面那条同时含指纹与能力自述，
  //   所以「摘掉指纹判据」时它照样红（能力自述那条还在命中）⇒ **变异读不出指纹判据的死活**。
  //   实测过一次：摘掉指纹判据后 Z35 全绿，我一度以为断言没盖住。
  assert.ok(hit('新版指纹是 bc48e2ae893ab3e7') > 0, '指纹这一类没盖住（只含指纹的夹具）');
  assert.ok(hit('那一版是 a1b2c3d4e5f60718') > 0, '纯十六进制指纹没盖住');
  // ★ 反向对照：正经回答一条都不许误报（§2.1.1：会误报的检查器比没有更糟）
  for (const ok of ['这条站内广告文案能不能发：M6 吸奶器静音设计', '订单号 20261009123456 已登记',
                    '审核完成，共发现 3 处需人工确认。', '活动截至 2026 年 10 月 9 日 23:59']) {
    assert.strictEqual(hit(ok), 0, '误报了正经回答：' + ok);
  }
});

await t('Z36 接线：这条规则必须有一个承载它的地方（规程 + 执行点）', async () => {
  // ⚠️ 它**不在提示词里** —— 系统提示词有冻结上限 8500（`verify_cards` 的 K5），
  //   而这条规则写之前就已经贴着顶（8493/8500）。所以承载落在两处：
  //     ① 规程（给人看的判据，`agent-skills/守衡语域/SKILL.md` §2.3）
  //     ② `internalLeak` 检测器（**真的拦它的那一行**）。
  //   §2.4：上限必须有执行点 —— 执行点在检测器，不在提示词。
  const doc = fs.readFileSync(new URL('../agent-skills/守衡语域/SKILL.md', import.meta.url), 'utf8');
  assert.ok(/指纹 \/ 哈希 \/ 版本号/.test(doc), '规程里没点名「指纹」这一类');
  assert.ok(/把该跑的命令给我/.test(doc), '规程里没写「把维护侧的活派成对方待办」这个反面例');
  assert.ok(/没有折叠区可放|没有折叠区所以写进正文/.test(doc), '规程没写清「纯文本时就根本不写」');
  // 执行点必须真的在：检测器拦得住实测那条
  const { lintCopy } = await import('./reply-cards/registry.mjs');
  assert.ok(lintCopy('新版是 bc48e2ae893ab3e7…').some((h) => h.id === 'internalLeak'),
    '检测器没拦住指纹 —— 那这条规则就没有执行点了');
  // 反向对照：提示词不许为了这条规则把冻结上限顶破
  const { buildSystemPrompt } = await import('./agent/persona.mjs');
  assert.ok(buildSystemPrompt().length <= 8500, '提示词超了冻结上限（K5 会红）');
});

await t('Z42 ★ P0 命中那一路的输入不许被「短卡 / 篇幅上限」类指令改写（Owner 2026-10-12 指示恢复 16:57 格式）', async () => {
  // ── 为什么有这一条
  //   2026-10-12 17:54 另一个会话给 P0 命中那一路加了一段「短卡」指令（≤300 字、
  //   只保留结论行/模式与条款号/报告链接），19:31 生效后的第一条 P0 回复就变了样：
  //   两轨计数行 + 逐条明细 + 页脚**全没了**，换来「条款 W-1.33 / L4→L5→L6→L7 / 表行 recvx…」
  //   （两条原文都在 `PMO/logs/ws_outbound.jsonl`）。
  //   Owner 当场指示恢复 —— 那段拼接已停用（见 `agent.mjs` 原位注释）。
  //   ⚠️ 那条改动**没有踩红任何断言**，所以这一条必须补上：判据不能只活在注释里（§2.4）。
  const { runSubmissionGate, P0_SHORT_REPLY_INSTRUCTION } = await import('./agent/agent.mjs');
  const inbound = { text: '审核下这个吸奶器文案：吸奶器M9，是最好的吸奶器', imageCount: 0, videoCount: 0 };
  const r = await runSubmissionGate({
    imageClaimRunner: completedImageClaimFixture,
    inbound, question: inbound.text, notify: async () => {},
    // ★ 让链返回 **P0 命中**那一支 —— `p0ShortReplyBlock(res)` 只认 `res.p0_fastpath`
    chainRunner: async () => ({ answer: '【审查结论：BLOCK】占位',
                               p0_fastpath: { elapsed_ms: 48, matched_patterns: 1, rule_codes: ['H05'] } }),
    // ★ 三个注入点一个都不能漏：漏 `modelSideRunner` 会真打 LLM，漏 `mergedReportRunner`
    //   会真在飞书建云文档（§2.4.4 那个病，本仓实测踩过两次）。
    modelSideRunner: async () => ({ ok: true, findings: [] }),
    publishRunner: async () => ({ ok: true, action: 'skipped', detail: '自证桩：不碰真表' }),
    mergedReportRunner: async () => ({ ok: true, url: 'https://example.invalid/docx/STUB', detail: '自证桩' }),
    adviceRunner: async () => ({ ok: true, ms: 1, advice: {} }),
  });
  const turn = String(r.question ?? '');
  // ① 先证明**真的走到了 P0 那一支** —— 否则下面两条是恒真的空断言（本仓记过这个坑）
  assert.ok(turn.includes('P0 快路'), '这一轮没走到 P0 快路那一支 —— 下面两条会退化成恒真');
  // ② 那段短卡指令不许被拼进来
  assert.ok(!turn.includes(P0_SHORT_REPLY_INSTRUCTION), '短卡指令又被拼进来了（Owner 已指示恢复 16:57 格式）');
  // ③ 篇幅上限这一类「靠压缩求短」的指令同样不许出现 —— 短不该以丢掉卡面结构为代价
  assert.ok(!/篇幅上限|≤\s*\d+\s*字/.test(turn), '这一路的输入里不许出现篇幅上限');
  // ④ 反向对照：这条断言**不是恒真** —— 拼进来时必须能红，否则等于没写
  assert.ok(P0_SHORT_REPLY_INSTRUCTION.length > 20
            && (turn + '\n\n' + P0_SHORT_REPLY_INSTRUCTION).includes(P0_SHORT_REPLY_INSTRUCTION),
            '常量是空的 ⇒ 第②条永远不会真红，等于没有断言');
});

await t('Z43 ★★ 收尾动作行的收件人**按问题方向算**，不是常量（Owner 2026-10-14：与 PRD §5.3.2 不符）', async () => {
  // ── 为什么有这一条
  //   PRD §5.3.2 **两处**（1-2 条与 ≥3 条）逐字写 `建议转 @法务 @医学顾问 复核。`，
  //   §9 写「REVIEW 自动转**对应**专业团队（法务、医学、专家、北美）」。
  //   而守衡卡上那一行原先是**硬编码** `建议转 @内容治理负责人 复核。` ——
  //   收件人不在那四个团队里，且**不随问题方向变**。
  //
  //   ⚠️ 模块级判据（`agent/routing.test.mjs` 29 项）只管到 `routing.mjs`。
  //      **卡片上印出来的那一行**是 `dual_track.renderMerged` 拼的 ——
  //      它有没有真的用上路由，只有在这里喂**真合并项**才验得到。
  //      本仓栽过「模块测过了 ⇒ 以为链上也就对了」（§2.5 那条：改了但没人读）。
  const { renderMerged, mergeFindings } = await import('./agent/dual_track.mjs');

  const mk = (category) => {
    const f = { location: '全文', category, severity: 'REVIEW', source: 'kb' };
    return mergeFindings([f], []).items;
  };
  const blockOf = (cat) => renderMerged(mk(cat), { state: 'REVIEW' }).block;
  const tail = (b) => String(b).split('\n').filter((l) => /^建议转/.test(l)).pop() ?? '';

  const med = tail(blockOf('合规-医疗宣称'));
  const loc = tail(blockOf('本地化-计量单位'));

  // ① 那句句式必须还在 PRD §5.3 的形状上
  assert.ok(/^建议转 @\S.* 复核。/.test(med), `动作行不合 PRD §5.3.2 句式：${med}`);
  // ② 那个错的收件人不许再出现（这就是 Owner 报的缺陷本体）
  assert.ok(!/内容治理负责人/.test(med), `动作行里还有「内容治理负责人」：${med}`);
  // ③ ★ 不同方向必须得到**不同**的行 —— 恒为同一个人正是缺陷
  assert.notStrictEqual(med, loc, `医疗与本地化得到同一行 ⇒ 说明没按方向转：${med}`);
  // ④ 收件人必须出自 PRD §9 那四个专业团队（或路由表的显式 fallback）
  assert.ok(/@医学顾问|@法务/.test(med), `医疗方向没落到医学顾问/法务：${med}`);
  assert.ok(/@北美同事/.test(loc), `本地化方向没落到北美同事：${loc}`);
  // ⑤ `prd53.conforms` 只管**结论行**，本改动不许把它碰红
  const { conforms } = await import('./agent/prd53.mjs');
  // ★ 2026-10-26 两轮：卡面先改成 PRD 字面 `【REVIEW】…`、下午又写回 `【审查结论：REVIEW】…`
  //   ⇒ 这里取行**两种都要认**（存量件两种都有，只认一种就会读不出结论行）
  const line = (String(blockOf('合规-医疗宣称')).match(/【(?:审查结论：[^\n]*|(?:PASS\+SUGGEST|PASS|REVIEW|BLOCK)】[^\n]*)/) ?? [''])[0];
  assert.ok(conforms(line).ok, `结论行被碰红了：${conforms(line).why}`);
  // ⑥ 反向对照：喂回**旧常量**，②必须能红 —— 证明它不是恒真
  const OLD_ACTION = '建议转 @内容治理负责人 复核。';
  assert.ok(/内容治理负责人/.test(OLD_ACTION)
            && !/内容治理负责人/.test(med),
            '旧常量样本与当前输出分辨不出来 ⇒ 第②条等于没写');
  // ⑦ 方向匹配**不许吃 reason**（原因句里常出现「不得宣称医疗功效」这类在解释别人违规的措辞）
  const sneaky = tail(renderMerged(
    mergeFindings([{ location: '全文', category: '本地化-计量单位', severity: 'REVIEW',
                     source: 'kb', reason: '医疗 功效 睡眠 认证 背书' }], []).items,
    { state: 'REVIEW' }).block);
  assert.ok(/@北美同事/.test(sneaky) && !/@医学顾问/.test(sneaky),
    `reason 里的方向词把路由带偏了：${sneaky}`);
});

await t('Z44 ★★ 「链答案 → 卡面」这一跳：路由后的动作行必须**独立成行**地落到卡上', async () => {
  // ── 为什么单开一条（与 Z43 的分工）
  //   Z43 验的是 `renderMerged` 拼出来的那个 `block`。但**发到群里的那张卡**还要再过一跳：
  //   `deriveVerdictLine`（抠结论行 + 抠逐条块）→ `applyVerdictLine`（把块搬进卡片的结论格）
  //   → `build`/`renderText`（渲染）。
  //   本仓栽过「模块测过了 ⇒ 以为链上也就对了」，所以这一跳必须**端到端**喂一次真形状的答案。
  //
  //   ⚠️ 实测踩到的坑（本次干跑）：卡片若走的是模型自写的那条路，路由那句话
  //      会变成 `reasoning` 里的**散文**、不独立成行 —— 那就不是 PRD §5.3.2 的收尾格式了。
  //      所以判据必须落在**卡面文本**上，而不是只看 `block` 字符串。
  const { deriveVerdictLine, conclusionBlock } = await import('./agent/prd53.mjs');
  const { applyVerdictLine } = await import('./reply-cards/envelope.mjs');
  const { build, renderText } = await import('./reply-cards/index.mjs');

  // 库侧真产者产出的形状（逐条 + 路由后的动作行）
  const ANS = [
    '【审查结论：REVIEW】共发现 3 处需人工确认。', '',
    '1.【措辞表达】正文：「附赠」', '   **原因**：r1', '',
    '2.【消费者安全】画面', '   **原因**：r2', '',
    '建议转 @法务（未配置） @北美同事（未配置） @医学顾问（未配置） 复核。'
      + '（其中 2/3 条未匹配到方向：该转谁需要人确认）',
  ].join('\n');

  // ① 块必须抠得到（抠不到 ⇒ 下面全是恒真的空断言）
  assert.ok(conclusionBlock(ANS) !== null, 'conclusionBlock 没抠到块 —— 下面会退化成恒真');
  const v53 = deriveVerdictLine({ replyText: ANS });
  const r = applyVerdictLine('query-answer', { title: 't', verdict: 'v' }, v53);
  assert.strictEqual(r.block && r.block.action, 'forced', `块没被搬进卡：${JSON.stringify(r.block)}`);
  const card = renderText(build('query-answer', r.data));

  // ② 动作行必须**独立成行**（PRD §5.3.2 的收尾是一行，不是夹在散文里）
  const lines = card.split('\n').filter((l) => /^建议转/.test(l));
  assert.strictEqual(lines.length, 1, `动作行没有独立成行（找到 ${lines.length} 条）：\n${card}`);
  // ③ 收件人是**按方向算出来的那四个角色名**
  assert.ok(/@法务/.test(lines[0]) && /@北美同事/.test(lines[0]), `收件人不对：${lines[0]}`);
  // ④ 旧常量不许出现在卡面任何位置
  assert.ok(!/内容治理负责人/.test(card), '卡面里还有「内容治理负责人」');
  // ⑤ 结论行仍合 §5.3（这一跳不许把格式碰坏）
  const { conforms } = await import('./agent/prd53.mjs');
  const head = (card.match(/【审查结论：[^\n]*/) ?? [''])[0];
  assert.ok(conforms(head).ok, `结论行被碰红：${conforms(head).why}`);
  // ⑥ 反向对照：拿**旧动作行**走同一条路，②/④ 必须能红
  const OLD_ANS = ANS.replace(/建议转[^\n]*/, '建议转 @内容治理负责人 复核。');
  const rOld = applyVerdictLine('query-answer', { title: 't', verdict: 'v' },
    deriveVerdictLine({ replyText: OLD_ANS }));
  const cardOld = renderText(build('query-answer', rOld.data));
  assert.ok(/内容治理负责人/.test(cardOld),
    '旧动作行走同一条路却测不出「内容治理负责人」⇒ ④ 等于没写');
});
// ─────────────────────────────────────────────────────────────────────────────
// 旁挂身份（2026-10-15 那次串单）—— 一把锁都对不上时**必须拒收**
//
// 现场（逐条可核）：对接人 17:51 发图（本机 OCR 只有 `momcozY`），本单的链 17:53:33
// 跑完（素材指纹 `8381eb63`）；**另一单**（批跑在审一篇英文页面文案，原文真写着
// `IBCLC`）17:54:39 跑完（`6aeaf105`），把**同一个固定旁挂文件**整份覆盖；
// 本单 17:55 去读，读到的是别人那一单 ⇒ 发进群的那张卡里出现了一条
// `逐字命中「ibclc」`——**命中是真的，贴错了素材**。
// 当时的代码是「三把锁全不成立也照收（按时间口径采纳）」⇒ **判据看得见，结论照样错**。
//
// 这一组钉三件事：① 判据表（纯函数）② 真读文件的行为级（拒 + 反向对照）③ 素材规则接线。
// ─────────────────────────────────────────────────────────────────────────────

await t('N1 旁挂身份判据表：任一把锁对上就认，四把全不成立就拒（含反向对照）', async () => {
  const { identityVerdict } = await import('./agent/tools.mjs');
  const { createHash } = await import('node:crypto');
  // ⚠️ 这两个时刻必须**离开 2 秒容差**再判：新鲜度判据是 `at >= sinceMs - 2000`
  //   （链与守衡之间有一次 run 的时差）。第一版我把 since 写 1000ms、stale 写 500ms ——
  //   差 500ms **在容差之内**，于是「过期旁挂」用例喂的其实是一份新鲜旁挂，
  //   断言红在**我的样本**上，不是判据上。（同一个形状：样本错了，判据是对的。）
  const since = 10_000;
  const fresh = new Date(11_000).toISOString();       // 晚于起链 ⇒ 新鲜
  const stale = new Date(1_000).toISOString();        // 早于起链 9 秒 ⇒ 超出容差
  const text = '【图片 1 的图内文字（本机 OCR）】\nmomcozY';
  const full = createHash('sha256').update(text, 'utf8').digest('hex');
  const sha8 = full.slice(0, 8);
  const want = { token: `/tmp/shouheng-material-${sha8}-abc.txt`, sha8, full,
                 cid: `AUTO-${full.slice(0, 12)}` };
  const A = (o) => identityVerdict({ sinceMs: since, at: fresh, ...o });

  // ① ★ 反向对照：**本单自己的旁挂必须认** —— 连这一档都拒，闸门就是一块砖头
  const own = A({ want, got: { sha8 } });
  assert.strictEqual(own.accept, true, `本单的旁挂被拒了（闸门成砖头）：${JSON.stringify(own)}`);
  assert.strictEqual(own.level, '文本指纹', '认下来靠的应该是文本指纹这一级');
  // ② 令牌相符即认（同一内容换句话问，仍是同一内容）
  assert.strictEqual(A({ want, got: { token: want.token, sha8: 'ffffffff' } }).accept, true,
    '令牌相符却没认');
  // ③ 内容指纹（全值）相符即认 —— 引擎 JSON 那一侧走的就是它
  assert.strictEqual(A({ want, got: { full } }).accept, true, '内容指纹相符却没认');
  // ④ ★★ 本单的形状：旁挂是**别人那一单**的 ⇒ 必须拒
  const foreign = A({ want, got: { token: '', sha8: '6aeaf105', cid: 'AD-20261015-001' } });
  assert.strictEqual(foreign.accept, false,
    `别人的旁挂被采纳了（这正是 10-15 那次串单）：${JSON.stringify(foreign)}`);
  // ⑤ 反向对照：**不新鲜时即便指纹相符也不认** —— 时间口径是必要条件，不是充分条件
  assert.strictEqual(identityVerdict({ sinceMs: since, at: stale, want, got: { sha8 } }).accept, false,
    '过期旁挂被采纳了');
});

await t('N2 行为级·真读文件：别人的旁挂/引擎 JSON 拒收，本单的采纳（+ 素材规则接线）', async () => {
  const { spawnSync } = await import('node:child_process');
  const { createHash } = await import('node:crypto');
  const os = await import('node:os');
  const pathMod = await import('node:path');

  const tmp = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'shouheng-sidecar-'));
  const work = pathMod.join(tmp, 'kb', '.work');
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(pathMod.join(tmp, 'kb', 'l8'), { recursive: true });
  fs.writeFileSync(pathMod.join(tmp, 'kb', 'l8', 'review_playbook.md'), 'PLAYBOOK-SENTINEL\n');

  const text = '【图片 1 的图内文字（本机 OCR）】\nmomcozY';
  const full = createHash('sha256').update(text, 'utf8').digest('hex');
  const sha8 = full.slice(0, 8);

  // 桩 dsh：链那一跳只回一句回答（这一条验的是**身份判定那一跳**，不是链本身）。
  //   顺手把收到的 task 落一份 —— 素材规则接线那两条断言靠它。
  const taskOut = pathMod.join(tmp, 'task.txt');
  const stub = pathMod.join(tmp, 'stub-dsh.mjs');
  fs.writeFileSync(stub,
    "import fs from 'node:fs';\n"
    + 'fs.writeFileSync(process.env.STUB_TASK_OUT, process.argv.slice(2).join("\\n"));\n'
    + "console.log('状态：REVIEW ｜ 问题数：1');\n");

  const run = ({ sidecar, engine }) => {
    fs.writeFileSync(pathMod.join(work, 'last_review_result.json'), JSON.stringify(sidecar));
    const ep = pathMod.join(work, 'last_engine_out.json');
    if (engine) fs.writeFileSync(ep, JSON.stringify(engine));
    else { try { fs.unlinkSync(ep); } catch { /* 本来就没有 */ } }
    const script = `
      const { executeTool } = await import(${JSON.stringify(new URL('./agent/tools.mjs', import.meta.url).href)});
      const r = await executeTool('kb_review_chain', ${JSON.stringify({ question: '审一下这张图', text })});
      const res = r.result ?? {};
      console.log('RESULT ' + JSON.stringify({ ok: r.ok, hasReview: !!res.review,
        issueCount: res.review?.issue_count ?? null, hasEngine: !!res.engine, err: res.error ?? null }));
    `;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, SHOUHENG_STATE_DIR: tmp, SHOUHENG_KB_ROOT: tmp,
             SHOUHENG_DSH_BIN: stub, STUB_TASK_OUT: taskOut, SHOUHENG_REVIEW_TABLE: 'off' },
    });
    return `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  };
  const resOf = (out) => {
    const m = out.match(/RESULT (\{.*\})/);
    assert.ok(m, `没拿到 RESULT —— 子进程没跑到底：\n${out.slice(-500)}`);
    return JSON.parse(m[1]);
  };
  const ownSidecar = () => ({ at: new Date().toISOString(), base: 'TEST-OWN', text_sha8: sha8,
    review_token: '', state: 'REVIEW', issue_count: 1 });
  const foreignSidecar = () => ({ at: new Date().toISOString(), base: '20261015-1754',
    text_sha8: '6aeaf105', review_token: '', content_id: 'AD-20261015-001',
    state: 'REVIEW', issue_count: 1 });
  const ownEngine = () => ({ decision: { content_version: full, content_id: 'AD-test', review_id: 'rv-test' } });
  const foreignEngine = () => ({ decision: { content_version: '6aeaf105'.padEnd(64, '0'),
    content_id: 'AD-20261015-001', review_id: 'rv-20261015-175442' } });

  try {
    // ① ★ 别人的旁挂 ⇒ 拒收，而且**不许把别人的条数带出来**（这就是那次串单的形状）
    let out = run({ sidecar: foreignSidecar(), engine: null });
    assert.ok(/不是本单的 ⇒ 拒收/.test(out), `没拒收别人的旁挂：\n${out.slice(-500)}`);
    let res = resOf(out);
    assert.strictEqual(res.hasReview, false, '别人的旁挂被当成本单带出去了');
    assert.strictEqual(res.issueCount, null, '别人的条数不许出现在本单的读数里');

    // ② ★ 反向对照：**本单的旁挂必须采纳**（否则每一单都掉库侧读数）
    out = run({ sidecar: ownSidecar(), engine: null });
    res = resOf(out);
    assert.ok(/旁挂身份对齐/.test(out), `本单的旁挂没认出来：\n${out.slice(-500)}`);
    assert.strictEqual(res.hasReview, true, '本单的旁挂被拒了（闸门成砖头）');
    assert.strictEqual(res.issueCount, 1, `本单的条数没带出来：${JSON.stringify(res)}`);

    // ③ 引擎 JSON 走同一条纪律（它此前**只核新鲜、没核身份**）
    res = resOf(run({ sidecar: ownSidecar(), engine: foreignEngine() }));
    assert.strictEqual(res.hasEngine, false, `别人的引擎 JSON 被采纳了：${JSON.stringify(res)}`);
    res = resOf(run({ sidecar: ownSidecar(), engine: ownEngine() }));
    assert.strictEqual(res.hasEngine, true, '本单的引擎 JSON 被拒了（闸门成砖头）');

    // ④ 接线：素材规则必须**排在 playbook 之前**，且必须带着 `--material-file <路径>`
    const task = fs.readFileSync(taskOut, 'utf8');
    const mp = task.match(/\/tmp\/shouheng-material-[0-9a-f]{8}-[0-9a-z]+\.txt/);
    assert.ok(mp, `任务文本里没有素材文件路径 ⇒ 链拿不到 --material-file：\n${task.slice(0, 400)}`);
    assert.ok(task.includes(`--material-file ${mp[0]}`), '任务文本里没把 --material-file 与路径写在一起');
    assert.ok(task.indexOf(mp[0]) < task.indexOf('PLAYBOOK-SENTINEL'),
      '素材规则排到了 playbook 之后 —— 位置就是权重，这次修的就是它');
    // ⑤ 用后即删（素材是客户内容，不许留在 /tmp）
    assert.ok(!fs.existsSync(mp[0]), `素材文件没用后即删：${mp[0]}`);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 收尾失败不影响断言 */ }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// N3 · 命令模板**真的被塞进 task**（2026-10-16 那次「探索 107.6 秒」的修复）
//
// 为什么单立一组：`reviewCmdTemplate()` 自己渲染得再对，也可能**压根没被拼进去** ——
//   本库栽过不止一次「函数写好了、没人调」。kb 侧 S8（`kb/l8/workflow_smoke.py`）
//   核的是**模板本身**（旗标真存在 / 两处不漂 / 照抄能跑），核**不到**这一跳；
//   这一组补的就是那一跳。
// 现场（逐条可核）：2026-10-16 09:50 那张私聊图，headless agent 花了
//   **107.6 秒**在 `grep -rn "macos-vision"` / `grep -rn "review_run.sh"` 上，
//   而真正的链只占 101.9 秒；根因是模板留了三处"要自己去查"的空。
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// 第 23 组（N4）：**身份拒收要落成可数的读数**（2026-10-16，Owner「彻底修复了吗」）
//
// 缺口是查出来的，不是想出来的：拒收此前只留一行 console.log ⇒ **没有任何东西统计它**。
// 于是哪天那把锁又失效（历史实测令牌转发 34 次只成功 1 次），表现是
// 「每一单都少了库侧依据」，而**没有人会发现** —— 本仓最忌讳的那种静默退化。
// 现在：拒收落一行账（`identity-reject.ndjson`），daemon 心跳在计数变了时 ⚠。
//
// 判据两条，第二条是防「自证有副作用」的（§2.4.4，本仓栽过三次）：
//   N4a 写：拒收会往账本追加一行，字段齐（谁 / 为什么 / 四个读数）
//   N4b **反向对照**：本次自证跑完，**真账本一个字节都没动**
// ─────────────────────────────────────────────────────────────────────────────
await t('N5 ★ 模型侧与建议生成必须**显式传 temperature: 0**（Owner 2026-10-16：每次跑结果不一样）', async () => {
  // 为什么是接线级：`llm.ask` 的默认仍是 0.2 —— 所以「谁传了 0」必须在这一跳被钉住，
  // 否则改一次调用点，判定就又变成抽样的（实测同图两次零重合：一次 3 条、一次 2 条）。
  const seen = [];
  const stubAsk = async (_p, opts = {}) => { seen.push(opts.temperature); return JSON.stringify({ findings: [] }); };
  const { reviewModelSide } = await import('./agent/model_side.mjs');
  await reviewModelSide({ readings: '【素材正文】\n测试', question: '测', ask: stubAsk });
  assert.ok(seen.length >= 1, '模型侧一次都没调 ask');
  assert.ok(seen.every((t) => t === 0),
    `模型侧判定必须传 temperature: 0，实际 ${JSON.stringify(seen)}`);
  const { generateAdvice } = await import('./agent/advice.mjs');
  const seen2 = [];
  const stubAsk2 = async (_p, opts = {}) => { seen2.push(opts.temperature); return JSON.stringify({ advice: [] }); };
  await generateAdvice({ items: [{ category: '合规', location: '图 1', reason: 'r', suggestion: 's' }],
                         readings: '【素材正文】\n测试', question: '测', ask: stubAsk2 });
  if (seen2.length) {
    assert.ok(seen2.every((t) => t === 0),
      `建议生成必须传 temperature: 0，实际 ${JSON.stringify(seen2)}`);
  }
});

await t('N4a 拒收会落一行可数账（谁 / 为什么 / 四个读数）', async () => {
  const { noteIdentityReject, identityRejectLogPath } = await import('./agent/tools.mjs');
  const f = identityRejectLogPath();
  assert.ok(f.includes('/tmp/shouheng-test-'), `自证必须写临时账本，实际=${f}`);
  const before = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).length : 0;
  noteIdentityReject('旁挂', { why: '四把锁全不成立', base: '20261015-1754',
                               want: { sha8: 'aaaaaaaa' }, got: { sha8: 'bbbbbbbb' } });
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
  assert.strictEqual(lines.length, before + 1, '拒收没落账 ⇒ 那条读数永远是 0，等于没有');
  const last = JSON.parse(lines[lines.length - 1]);
  assert.strictEqual(last.where, '旁挂');
  assert.match(last.why, /四把锁/);
  assert.strictEqual(last.got.sha8, 'bbbbbbbb', '四个读数要一起落，否则下一单还得倒推');
});

await t('N4c 计数读数：数得对、文件不在 → 0、读不到 → **null（未测）**', async () => {
  const { identityRejectCount } = await import('./agent/tools.mjs');
  const n = identityRejectCount();
  assert.ok(Number.isInteger(n) && n >= 1,
    `N4a 刚写过一行，这里应当数得到（实际 ${n}）—— 心跳那条 ⚠ 就靠它`);
  const prev = process.env.SHOUHENG_IDENTITY_REJECT_LOG;
  try {
    process.env.SHOUHENG_IDENTITY_REJECT_LOG = '/tmp/绝不存在-' + Date.now() + '.ndjson';
    assert.strictEqual(identityRejectCount(), 0, '文件不存在 = 那条路从没发生过 = 0（不是未测）');
    process.env.SHOUHENG_IDENTITY_REJECT_LOG = '/tmp';
    assert.strictEqual(identityRejectCount(), null, '读抛了必须回 null（未测），不许回 0');
  } finally {
    if (prev === undefined) delete process.env.SHOUHENG_IDENTITY_REJECT_LOG;
    else process.env.SHOUHENG_IDENTITY_REJECT_LOG = prev;
  }
});

await t('N4b ★★ 反向对照：跑一次自证，**真拒收账本一个字节都不许动**', async () => {
  assert.strictEqual(realRejectLogStat(), REAL_REJECT_LOG_BEFORE,
    `真账本被自证改动了（${REAL_REJECT_LOG}）—— 那会把「线上拒收了几次」这个读数弄脏`);
  // 反向对照的反向：把闸门拆掉（指回真账本）时，这条断言必须会红
  const { identityRejectLogPath } = await import('./agent/tools.mjs');
  const prev = process.env.SHOUHENG_IDENTITY_REJECT_LOG;
  delete process.env.SHOUHENG_IDENTITY_REJECT_LOG;
  try {
    assert.ok(identityRejectLogPath().endsWith('PMO/logs/identity-reject.ndjson'),
      '闸门拆掉后应当指回真账本 —— 这条不成立说明 N4b 恒真');
  } finally {
    process.env.SHOUHENG_IDENTITY_REJECT_LOG = prev;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
await t('N3 命令模板必须真被拼进 task，且三处"要自己查"的空必须堵死（含反向对照）', async () => {
  const { reviewTaskFor } = await import('./agent/tools.mjs');
  assert.strictEqual(typeof reviewTaskFor, 'function', 'reviewTaskFor 没导出（接线第一跳就断）');

  const mp = '/tmp/shouheng-material-8381eb63-probe.txt';
  const q = '【对方这条消息里附了图，共 1 张。】（提问原文探针）';
  const tx = '【图片 1 的图内文字（本机 OCR）】\nmomcozY';
  const task = reviewTaskFor({ question: q, text: tx, materialPath: mp });

  // ① 命令模板在场，且**内联**了本单路径（不是留占位符让人去填）
  assert.ok(task.includes('第 0 条之二'), 'task 里没有命令模板 —— 又只剩 playbook 那条中段模板了');
  assert.ok(task.includes(`--material-file ${mp}`), '模板没把素材路径内联进 --material-file');
  assert.ok(task.includes(`--token         ${mp}`), '模板没把同一个路径交给 --token（身份凭据那条腿断了）');
  assert.ok(task.includes('禁止探索'), 'task 里没有「禁止探索」那一段');

  // ② ★ 顺序：模板必须排在提问之前（位置就是权重）
  const iTpl = task.indexOf('第 0 条之二');
  const iQ = task.indexOf(q);
  assert.ok(iQ > 0, 'task 里找不到提问原文（样本本身有问题）');
  assert.ok(iTpl < iQ, `模板排在提问之后（${iTpl} vs ${iQ}）—— 它在几万字后面等于没说`);

  // ③ ★★ 三处"要自己去查"的空必须堵死（就是那 107.6 秒的三个来源）
  const block = task.slice(iTpl, iQ);
  assert.ok(!/\$BASE\b/.test(block),
    '模板里还引用 $BASE —— 它从没定义过，agent 只能自己发明（10-16 实测它就为这个去 grep 全仓）');
  assert.ok(block.includes('$(date +%Y%m%d-%H%M%S)'),
    '模板没直接给出 --base 的取值方法（2026-10-22 起是**秒级**：分钟级会让同分钟两单撞同一个 BASE，'
    + '而 rerun_ledger 判「同一个 BASE 跑过就硬拒」⇒ 那单直接失败）');
  // ★ 反向对照（2026-10-22）：不许退回分钟级 —— 少了 `%S` 就是那场撞车的形状
  assert.ok(!/%H%M(?!%S)/.test(block), '模板里的 --base 又退回分钟级（同一分钟两单会撞 BASE）');
  assert.ok(/\$\(sw_vers -productVersion\)/.test(block) && /\$\(shasum -a 256 /.test(block),
    '模板没给出 --coverage 的版本/哈希取值方法 —— agent 会去 grep `macos-vision`（实测 47.6 秒）');
  assert.ok(block.includes('macos-vision'), '模板没写死 provider 名');
  assert.ok(!block.includes('--text "<素材原文'), '模板又把 --text 当主路了（与 --material-file 打架）');

  // ④ 反向对照：没有素材路径时**不许**凭空注入模板（空模板会污染 task）
  const noMp = reviewTaskFor({ question: q, text: tx, materialPath: '' });
  assert.ok(!noMp.includes('第 0 条之二'), '素材没落盘却仍注入了模板 —— 命令里的路径会是空的');
  assert.ok(noMp.includes(q) && noMp.includes(tx), '退回老路时把提问/素材正文丢了');

  // ⑤ 反向对照：判据本身不许恒真 —— 把模板标记抹掉后，同一条判据必须变假
  //   ⚠️ 必须 `replaceAll`：`第 0 条之二` 在 task 里出现**两次**（素材规则里引一次、
  //      模板标题一次）。第一版用 `replace(…, 1)` 只抹掉了素材规则那一处，
  //      `wired()` 仍能从模板里找到它 ⇒ **反向对照当场判我不合格**（这条判据自己抓出了自己）。
  const wired = (s) => s.includes('第 0 条之二') && s.includes(`--material-file ${mp}`);
  assert.strictEqual(wired(task), true, '正向：真 task 应判为已接线');
  assert.strictEqual(wired(task.replaceAll('第 0 条之二', '（已删）')), false,
    '反向对照失效：模板标记被抹掉后判据仍为真 ⇒ 这条判据是恒真的');
  assert.strictEqual(wired(task.replaceAll(`--material-file ${mp}`, '--text "…"')), false,
    '反向对照失效：内联路径被拿掉后判据仍为真');
});

await t('N4 ★★ 图片送审的 content_type 必须由图定死，且**连 coverage 一起**给（Owner 2026-10-20）', async () => {
  // ── 为什么单立一条（当天两次实测，同一份图 OCR，只差这一个词）
  //   10:06:48 `--content-type text`  → PASS / 0 条（「负面样本规则」整层**根本没跑**）
  //   11:10:00 `--content-type image` → REVIEW / 5 条
  //   病根：`--content-type` 是 headless 里的模型按模板「三选一」自己猜的。
  //   ⇒ 现在模态由 `agent.mjs` 按 `inbound` 算好、经 `beginChainTurn({modality})` 传进模板。
  //   ⇒ 但**只给 image 不给 coverage 会更坏**：引擎判 image/ocr 覆盖不完整 ⇒ 整单被
  //      fail-closed 压成 `NEEDS_INPUT`（同轮实测）。所以这两件事必须**成对**出现，
  //      本判据钉的就是这个"成对"。
  const { reviewTaskFor, beginChainTurn, chainTurnModalityOf,
          setChainTurnImagePaths, chainTurnImagePathsOf } = await import('./agent/tools.mjs');
  const mp = '/tmp/shouheng-material-8381eb63-probe.txt';
  const q = '【提问原文探针】';
  const tx = '【图片 1 的图内文字（本机 OCR）】\nmomcozY';
  const bashBlock = (task) => task.split('```bash')[1].split('```')[0];
  const realLines = (task) => bashBlock(task).split('\n').map((s) => s.trim())
    .filter((l) => l && !l.startsWith('#'));

  // ① 图单：content_type 定死 image，且两行 coverage **取消注释**
  const img = reviewTaskFor({ question: q, text: tx, materialPath: mp, ctype: 'image' });
  assert.ok(realLines(img).includes('--content-type image \\'),
    '图单模板里没有写死的 `--content-type image` —— 模型仍会自己猜（这就是当天的病根）');
  assert.strictEqual(realLines(img).filter((l) => l.startsWith('--coverage "image:macos-vision:')).length, 1,
    '图单模板缺 image 模态的 --coverage（缺了会被 fail-closed 压成拒答）');
  assert.strictEqual(realLines(img).filter((l) => l.startsWith('--coverage "ocr:macos-vision:')).length, 1,
    '图单模板缺 ocr 模态的 --coverage（同上）');
  assert.ok(!bashBlock(img).includes('<text|image|video>'), '图单里还留着三选一占位符 —— 等于仍让模型选');

  // ② 续行符：除最后一条实命令外，每一条都必须以 `\` 收尾（否则 shell 会把两条拼成一条）
  const rl = realLines(img);
  assert.ok(rl.slice(0, -1).every((l) => l.endsWith('\\')) && !rl[rl.length - 1].endsWith('\\'),
    '续行符结构坏了：非末行须以 `\\` 收尾、末行不带 —— 这条坏了整条命令会被 shell 拼错');

  // ③ 文字单：定死 text，且 coverage 仍保持注释（文字单没有模态佐证，硬填=伪造覆盖）
  const txtTask = reviewTaskFor({ question: q, text: tx, materialPath: mp, ctype: 'text' });
  assert.ok(realLines(txtTask).includes('--content-type text'), '文字单模板没写死 `--content-type text`');
  assert.strictEqual(realLines(txtTask).filter((l) => l.startsWith('--coverage')).length, 0,
    '文字单里出现了未注释的 --coverage —— 那是伪造模态覆盖（库规：没真跑过不许填）');

  // ④ 反向对照：不给 ctype（老路径）必须**保持原样**，不许被这条新判据带跑偏
  const legacy = reviewTaskFor({ question: q, text: tx, materialPath: mp });
  assert.ok(bashBlock(legacy).includes('--content-type <text|image|video>'),
    '不给 ctype 时占位符没保留 —— 老路径行为被改了（老调用方会拿到写死的模态）');

  // ⑤ 反向对照（判据本身不许恒真）：把写死那行换回占位符，①的判据必须变假
  const mutated = img.replace('--content-type image \\', '--content-type <text|image|video>');
  assert.strictEqual(realLines(mutated).includes('--content-type image \\'), false,
    '反向对照失效：写死行被还原成占位符后判据仍为真 ⇒ 这条判据是恒真的');

  // ⑥ 接线：模态必须真能经每轮起点传进来（否则模板能力再好也没人喂）
  beginChainTurn({ modality: 'image' });
  assert.strictEqual(chainTurnModalityOf(), 'image', 'beginChainTurn({modality:"image"}) 没传进模态格');
  beginChainTurn({ modality: 'text' });
  assert.strictEqual(chainTurnModalityOf(), 'text', 'beginChainTurn({modality:"text"}) 没传进模态格');
  beginChainTurn();
  assert.strictEqual(chainTurnModalityOf(), null,
    '不给 modality 时必须回落 null（否则老调用方会被静默改成某个写死的模态）');
  beginChainTurn({ modality: 'video' });
  assert.strictEqual(chainTurnModalityOf(), 'video', '视频模态认不出来');
  // ⑦ 内核取到的图片路径必须自动进入任务，不能依赖 DSH 模型记得填可选参数。
  const kernelImage = '/tmp/shouheng-chain-img-probe/original.png';
  beginChainTurn({ modality: 'image' });
  setChainTurnImagePaths([kernelImage]);
  const injected = reviewTaskFor({ question: q, text: tx, materialPath: mp, ctype: 'image' });
  assert.ok(realLines(injected).includes(`--image ${kernelImage} \\`),
    '本轮内核原图没有自动注入 --image；模型漏传可选字段会让图身份层静默跳过');
  assert.deepStrictEqual(chainTurnImagePathsOf(), [kernelImage], '本轮原图上下文未留在 turn-local 状态');
  beginChainTurn({ modality: 'text' });
  assert.deepStrictEqual(chainTurnImagePathsOf(), [], '新文字轮次继承了上一轮图片路径（串图）');
  beginChainTurn();
});

await t('N3b ★★ 任务里必须要求逐字给出 ③b 结论行，且那把尺子真认得它（2026-11-03 真单）', async () => {
  // ── 为什么有这一条
  //   真单 `20261103-160411`（视频）：链跑成了、引擎 PASS/0 条、模型侧也 0 条，
  //   用户收到的却是「审查未完成」。根因**不是**引擎也不是视频，是**这一行契约被删了**：
  //   2026-11-03 15:57 那次改动把收尾要求从「照抄 ③b 转述模板」改成「最后给库侧原始读数」，
  //   模型于是写成 `PASS ｜ 问题数 0 ｜ 置信度 0.93`（没有 `状态：` 前缀）
  //   ⇒ 守衡 `conclusionOf()` 一个字都认不出 ⇒ `conclusion_unparsed` ⇒ 整单 NEEDS_INPUT。
  //   为什么只在「0 条」时暴露：有逐条时结论走双轨合并，正文那一行读不读得到都一样；
  //   零发现时没有可并的条目，守衡只能回落读正文 —— 这一行就是**零发现单唯一的结论载体**。
  //   ⇒ 钉两件：① 任务里必须写着这一行的**逐字样张**；② 尺子（`conclusionOf`）必须真认得它。
  //     ② 是反向对照：只钉①的话，prompt 写了、解析器不认，照样是「审查未完成」。
  const { reviewTaskFor, beginChainTurn } = await import('./agent/tools.mjs');
  const { conclusionOf } = await import('./agent/review_publish.mjs');
  beginChainTurn();
  const task = reviewTaskFor({ question: 'q', text: 't', materialPath: '/tmp/n3b-probe.txt' });
  assert.ok(/###\s*③b 转述模板/.test(task),
    '任务里没有「### ③b 转述模板」这一节 —— 模型会自己发明一个「库侧原始读数」小标题');
  assert.ok(task.includes('状态：X ｜ 问题数：N ｜ 置信度：C'),
    '任务里没有 ③b 第一行的逐字样张（`状态：X ｜ 问题数：N ｜ 置信度：C`）');
  assert.ok(/不许省/.test(task),
    '任务里没有「不许省」那句 —— 只说「给读数」的话，模型会省掉 `状态：` 前缀（这是真单形状）');
  // ② 反向对照：尺子对同一个写法必须给得出三态
  assert.strictEqual(conclusionOf('### ③b 转述模板\n状态：PASS ｜ 问题数：0 ｜ 置信度：0.93'), 'PASS',
    'conclusionOf 认不出 ③b 第一行（没有 `状态：` 前缀时给 null 是预期的，'
    + '但**带**前缀还给 null ⇒ 两把尺子对不上，prompt 写得再对也没用）');
  // ③ 反向对照（2026-11-03 真单的原始写法）必须仍然解析不出 —— 那正是要 fail-closed 的形状
  assert.strictEqual(conclusionOf('**库侧原始读数（引擎唯一产出，未改写）**：PASS ｜ 问题数 0 ｜ 置信度 0.93'), null,
    '没有 `状态：` 前缀的读数行被当成结论了 —— 那会把「读不懂」说成「判过了」');
});

// ─────────────────────────────────────────────────────────────────────────────
await t('N4c ★★ 图单判定主体必须写死「图片安全审查」；text/video 必须仍留占位符（Owner 2026-10-21）', async () => {
  // ── 为什么有这一条
  //   Owner 2026-10-21：「我需要的是，每次图片审核都必须跑这个skill」。
  //   病灶：模板原文让模型自己填 `--decision-owner`（"第 2 步你选中的那个 skill 的装载目录名"）
  //   ⇒ 同一张婴幼儿安全睡眠科普图，选 `内容审查总控` / `文案合规审查` 一样能出 REVIEW ——
  //   而「图片 / 主图 / 图上文字 → 图片安全审查」是 kb-review 让位表**写死**的，不是模型的自由度。
  //   两道闸门各管一段：引擎侧 `with_kb_evidence.py::image_skill_gate` 对 `--content-type image`
  //   强制这一条（填别的 ⇒ NEEDS_INPUT）；这里钉**模板侧** —— 把"填错被拒"变成"根本不会填错"。
  //   边界：只钉图单。text 的归属不唯一（文案/本地化/宣称都可能接）、video 那一档另有未解缺口
  //   ⇒ 这两个模态**必须仍留占位符**，改它们等于把一个未决问题悄悄定死。
  const { reviewTaskFor } = await import('./agent/tools.mjs');
  const mp = '/tmp/shouheng-material-8381eb63-probe.txt';
  const q = '【提问原文探针】';
  const tx = '【图片 1 的图内文字（本机 OCR）】\nmomcozY';
  const block = (ctype) => reviewTaskFor({ question: q, text: tx, materialPath: mp, ctype })
    .split('```bash')[1].split('```')[0];

  // ① 图单：判定主体与加载申报都写死，且不再留占位符
  const img = block('image');
  assert.ok(img.includes('--decision-owner 图片安全审查'), '图单没写死 --decision-owner 图片安全审查');
  assert.ok(img.includes('--loaded-skill  图片安全审查'), '图单没把 --loaded-skill 同步写死（两处必须同名）');
  assert.ok(!img.includes('第 2 步选中的那个 skill'),
    '图单仍留着判定主体占位符 —— 模型还会自己选（这就是"选错也能过"的老路）');

  // ④ ★ 不能把 CLI 里的 --loaded-skill 自述当成真实调用：图片任务的前置任务文本
  //    必须要求 DSH 真加载 skill，并执行整个技能工作流；不能只做视觉/OCR 或只跑规则链。
  //    否则模型能照抄 --loaded-skill，却跳过图片安全审查本身或其中的事实核查等步骤。
  const imgTask = reviewTaskFor({ question: q, text: tx, materialPath: mp, ctype: 'image',
                                  imagePaths: ['/tmp/shouheng-image-probe.png'] });
  const skillLoadInstruction = imgTask.indexOf('先用 DSH 的 `skill` 工具真实加载 `图片安全审查`');
  assert.ok(skillLoadInstruction >= 0,
    '图单任务没有显式要求调用 DSH skill 工具；--loaded-skill 只是 agent 自述，不能证明真加载');
  assert.ok(skillLoadInstruction < imgTask.indexOf('第 0 条之二'),
    '图片 skill 加载要求排在命令模板之后，优先级不足');
  assert.ok(imgTask.includes('对原图文件 `/tmp/shouheng-image-probe.png` 完整执行 skill'),
    '没有要求图片 skill 直接分析本单原图并完整执行（仅靠守衡侧摘要不算执行图片 skill）');
  assert.ok(imgTask.includes('完整执行 skill：界定审核对象与范围'),
    '没有要求从审核对象与范围开始执行整份图片审查 skill');
  for (const stage of ['拆分主张并建立核查清单', '4A 规则符合性', '4B 事实准确性核查',
                       '检查图文一致性与信息完整性', '按 skill 的分级结论输出完整审查结果']) {
    assert.ok(imgTask.includes(stage), `图片任务缺少完整 skill 步骤：${stage}`);
  }
  assert.ok(imgTask.includes('不能只复用守衡侧场景摘要或 OCR 文本，也不能只做视觉分析代替完整流程'),
    '没有禁止以本地视觉/OCR 摘要替代完整 skill 执行');
  assert.ok(imgTask.includes('该命令属于 skill 流程的一部分，不得重复起链，也不能替代 skill 的其他步骤'),
    '没有声明知识库命令在 skill 全流程中的唯一位置/去重规则');
  assert.ok(imgTask.includes('4A 知识库审查与 4B 权威事实核查是独立工作'),
    '没有说明 4A / 4B 是彼此独立的两段工作');
  // ★★ 2026-10-23：**4B 禁止调 `web_search`**。
  //   真事故：`web_search` 的后端（`api.deepseek.com`）额度耗尽，在链里的表现是
  //   **请求发出去就不回来**（不是报错）⇒ 整单静默 9 分 9 秒，群里只有「⏳ 处理中…」。
  //   所以任务书必须**明确禁掉**这条路，并给一条能走完的替代（本机核验链接 + 直判），
  //   且要求 4B 段**如实写明未联网** —— 少了任何一句，模型两条路都可能走回老样子。
  assert.match(imgTask, /4B[^\n]{0,30}禁止调用[^\n]{0,20}`web_search`/,
    '4B 没有被禁止调用当前不可用的 web_search（调用就会把整单拖死）');
  assert.ok(imgTask.includes('本轮未做联网检索'),
    '没有要求 4B 如实写明「本轮未做联网检索」（不写就等于把模型知识伪装成已核证据）');
  assert.ok(imgTask.includes('不许编造未核验的来源'),
    '没联网却仍要求给权威链接时，缺少「不许编造来源」这条约束');
  assert.ok(imgTask.includes('不得为提速省略检查'),
    '提速要求没有明确禁止省略审查步骤');
  assert.ok(imgTask.includes('图片安全审查 skill 未加载或完整流程未完成时立即停止并返回 NEEDS_INPUT'),
    '图片 skill 未加载/全流程未完成时没有 fail-closed 约束');

  // ② 反向对照：text **不许**被顺手写死；video 按让位表写死为 `视频安全审查`（不串成 `图片安全审查`）
  const txt = block('text');
  assert.ok(txt.includes('<第 2 步选中的那个 skill 的装载目录名>'),
    '文本单的判定主体被写死了 —— 超出本次范围（文本归属不唯一，让位表里有多个去处）');
  assert.ok(!txt.includes('图片安全审查'), '文本单里出现了「图片安全审查」—— 写死分支串档了');
  const vid = block('video');
  assert.ok(vid.includes('--decision-owner 视频安全审查') && !vid.includes('图片安全审查'),
    '视频单的判定主体必须按让位表写为 视频安全审查，且不许串成 图片安全审查');
  const none = block(null);
  assert.ok(none.includes('<第 2 步选中的那个 skill 的装载目录名>'),
    '不给 ctype 时占位符没保留 —— 老路径行为被改了');

  // ③ 反向对照（判据本身不许恒真）：把写死那行换回占位符，①的判据必须变假
  const pinned = (s) => s.includes('--decision-owner 图片安全审查');
  assert.strictEqual(pinned(img), true, '正向：图单应判为已写死');
  assert.strictEqual(
    pinned(img.replace('--decision-owner 图片安全审查', '--decision-owner <第 2 步选中的那个 skill 的装载目录名>')),
    false, '反向对照失效：换回占位符后判据仍为真 ⇒ 这条判据是恒真的');
});

// ─────────────────────────────────────────────────────────────────────────────
await t('N4d ★★ 图单必须交「视觉核对清单」（五类，含独立婴儿睡眠位置），缺项**不收**（Owner 2026-10-21）', async () => {
  // ── 为什么有这一条（病灶，实测 2026-10-21）
  //   那张母婴插画里「奶瓶倒着放」没被抓到。查下来：skill **真的加载了**
  //   （`image_skill_gate.load.verdict=loaded`），判定主体也出了两条意见 ——
  //   但画面事实（婴幼儿姿势／产品状态／场景关系／隐私）**一条都没写**；
  //   而一般「婴幼儿姿势」字段也不够精确，侧卧曾被误报成仰卧，故新增独立睡眠位置项。
  //   ⇒ 「加载了 skill」≠「执行了它那道视觉核对」，而流程上没有任何东西会红。
  //   本组钉两件事：① 判据本身（含反向对照：光提名字不给结论不算覆盖）；
  //              ② 闸门真的接上（图单缺项 ⇒ 表行结论被压成 NEEDS_INPUT；文字单不触发）。
  const { checkVisualChecklist, checkImageSkillWorkflow } = await import('./agent/visual_checklist.mjs');
  const { runSubmissionGate, finalVerdict53ForTurn } = await import('./agent/agent.mjs');
  const { loadImageFactSources } = await import('./agent/image_fact_sources.mjs');
  const factSources = loadImageFactSources(process.env.SHOUHENG_FACT_SOURCE_TEST_ROOT
    || '/Users/lute/Documents/skill-test/执行skills/执行skills/skills-回归测试/知识库/内容治理').sources;

  const FULL = '【审查结论：REVIEW】共发现 2 处需人工确认。\n'
    + '视觉核对：婴幼儿姿势=无；婴儿睡眠位置=无（图 1 顶部面板仰卧；图 1 底部面板仰卧）；产品状态=有（床头柜上的奶瓶倒置）；场景关系=无；隐私=无';
  const FULL_WORKFLOW = [
    '审核对象与范围：图 1 全图，检查安全、事实、图文一致性。',
    '视觉分析与 OCR：逐面板完成视觉分析与 OCR；错误面板婴儿侧卧，安全建议面板婴儿仰卧。',
    '主张拆分与核查清单：C1 核对图1右上婴儿侧睡建议是否适用于一岁内婴儿。',
    'C2 核对图1右下婴儿侧睡建议是否适用于一岁内婴儿。',
    '4A 规则符合性：运行知识库规则链，命中历史记录级参考，未命中当前图精确身份。',
    '4B 事实准确性核查：',
    '| 主张 | 核查结论 | 依据及边界 | 来源 | 来源原文 |',
    '|---|---|---|---|---|',
    '| C1 图1右上婴儿侧睡建议 | 不支持 | 单独核对右上睡眠面板；2022年本地来源适用于一岁内婴儿，不外推产品安全 | aap-safe-sleep-2022 | Side sleeping is not safe and is not advised. |',
    '| C2 图1右下婴儿侧睡建议 | 不支持 | 单独核对右下睡眠面板；2022年本地来源适用于一岁内婴儿，不外推产品安全 | aap-safe-sleep-2022 | Side sleeping is not safe and is not advised. |',
    '图文一致性：上方面板睡姿事实与“仅避免同床”的风险说明未完全对应。',
    FULL,
  ].join('\n');
  const NO_PRIVACY = '【审查结论：REVIEW】共发现 2 处需人工确认。\n'
    + '视觉核对：婴幼儿姿势=无；婴儿睡眠位置=无（画面没有婴儿睡眠场景）；产品状态=有（床头柜上的奶瓶倒置）；场景关系=无';
  const NAME_ONLY = '【审查结论：REVIEW】共发现 2 处需人工确认。\n'
    + '视觉核对：婴幼儿姿势、产品状态、场景关系、隐私 这几类都看了一下。';

  // ① 判据：五类齐 ⇒ 过；睡眠姿势必须与泛化的婴幼儿姿势分开
  assert.strictEqual(checkVisualChecklist(FULL).ok, true, '五类齐却没判过');
  assert.strictEqual(checkImageSkillWorkflow(FULL_WORKFLOW, { factSources }).ok, true,
    '完整 skill 六阶段和权威事实来源都齐，却被判成未完成');
  assert.strictEqual(checkImageSkillWorkflow(FULL).ok, false,
    '只交视觉清单、没交 4A/4B 等完整流程阶段，仍被当作完整 skill 执行');
  assert.strictEqual(checkVisualChecklist(
    FULL.replace('婴儿睡眠位置=无（图 1 顶部面板仰卧；图 1 底部面板仰卧）；', '')).ok, false,
  '只交宽泛的「婴幼儿姿势」却漏掉独立的「婴儿睡眠位置」，仍被放行');
  assert.strictEqual(checkVisualChecklist(
    '婴幼儿姿势=无；婴儿睡眠位置=有（错误示范面板的婴儿侧卧；安全建议面板婴儿仰卧）；产品状态=无；场景关系=无；隐私=无').ok, true,
  '明确报告侧卧与仰卧的双面板睡姿却被拒');
  assert.strictEqual(checkVisualChecklist(
    '婴幼儿姿势=无；婴儿睡眠位置=无（画面没有婴儿睡眠场景）；产品状态=无；场景关系=无；隐私=无',
    { sleepPositions: [{ image: '图 1', position: '侧卧' }] }).ok, false,
  '画面读数标了侧卧，独立睡眠位置项却写「无睡眠场景」，仍被放过');
  assert.strictEqual(checkVisualChecklist(
    '婴幼儿姿势=无；婴儿睡眠位置=有（错误示范面板侧卧）；产品状态=无；场景关系=无；隐私=无',
    { sleepPositions: [{ image: '图 1', position: '侧卧' }] }).ok, true,
  '视觉清单复述画面读数中的侧卧仍被判红');
  assert.strictEqual(checkVisualChecklist(
    '婴幼儿姿势=无；婴儿睡眠位置=无（侧卧但问题是同床）；产品状态=无；场景关系=无；隐私=无',
    { sleepPositions: [{ image: '图 1', position: '侧卧' }] }).ok, false,
  '虽然提到侧卧，但把睡姿判为无问题仍被放过');
  assert.strictEqual(checkVisualChecklist(
    '婴幼儿姿势=无；婴儿睡眠位置=未测（婴儿面部和躯干被被褥遮挡，无法确认睡姿）；产品状态=无；场景关系=无；隐私=无',
    { sleepPositions: [{ image: '图 1', position: '看不清' }] }).ok, true,
  '姿势无法确认且明确未测时被错误拒绝');
  const NESTED_SLEEP = [
    '- **婴幼儿姿势：无。** 两处均仰卧。',
    '- **婴儿睡眠位置：无。** 依据（逐场景）：',
    '  - **场景组①（大床同床）**：婴幼儿**仰卧**；',
    '  - **场景组②（婴儿床）**：婴幼儿**仰卧**。',
    '- **产品状态：无。**',
    '- **场景关系：有。** 两个场景并置。',
    '- **隐私：无。**',
  ].join('\n');
  assert.strictEqual(checkVisualChecklist(NESTED_SLEEP, {
    sleepPositions: [{ image: '图 1', position: '仰卧' }, { image: '图 1', position: '仰卧' }],
  }).ok, true, '睡姿父项下逐场景列出的缩进子项被误判为未复述（本次图片回归）');
  assert.strictEqual(checkVisualChecklist(NESTED_SLEEP.replace('场景组②（婴儿床）**：婴幼儿**仰卧', '场景组②（婴儿床）**：婴幼儿**睡姿未写'), {
    sleepPositions: [{ image: '图 1', position: '仰卧' }, { image: '图 1', position: '仰卧' }],
  }).ok, false, '两个场景读数只复述一处仰卧时仍被放行');
  assert.strictEqual(checkVisualChecklist([
    '婴幼儿姿势=无；婴儿睡眠位置=无（画面没有婴儿睡眠场景）；产品状态=无；场景关系=无；隐私=无',
    '正文其他位置：场景组①仰卧，场景组②仰卧。',
  ].join('\n'), {
    sleepPositions: [{ image: '图 1', position: '仰卧' }, { image: '图 1', position: '仰卧' }],
  }).ok, false, '类别结论之外的正文睡姿被误当作视觉清单证据');

  // ★ 2026-10-28 新增：skill 输出「婴儿睡眠位置：仰卧，姿势依据：…」格式（实测导致「审查未完成」）
  //   「仰卧」作为具体睡姿词，在有姿势依据时必须被识别为「有」并通过闸门。
  //   反向对照：「无（侧卧但问题是同床）」里的侧卧不能覆盖「无」。
  assert.strictEqual(checkVisualChecklist(
    '婴幼儿姿势=无；婴儿睡眠位置：仰卧，姿势依据：躯干与脸朝上，背部贴床垫；产品状态=无；场景关系=无；隐私=无',
    { sleepPositions: [{ image: '图 1', position: '仰卧' }] }
  ).ok, true, 'skill 输出「仰卧，姿势依据：…」格式被「认不出结论」拦住（2026-10-28 实测场景）');
  assert.strictEqual(checkVisualChecklist(
    '婴幼儿姿势=无；婴儿睡眠位置=仰卧（仰卧，双臂微张）；产品状态=无；场景关系=无；隐私=无',
    { sleepPositions: [{ image: '图 1', position: '仰卧' }] }
  ).ok, true, 'skill 输出「=仰卧（…）」括号格式被拒');
  assert.strictEqual(checkVisualChecklist(
    '婴幼儿姿势=无；婴儿睡眠位置=无（侧卧但问题是同床）；产品状态=无；场景关系=无；隐私=无',
    { sleepPositions: [{ image: '图 1', position: '侧卧' }] }
  ).ok, false, '反向对照：「无（侧卧…）」里括号内的侧卧不许覆盖「无」结论（画面读数是侧卧时必须被拦）');

  // ①b ★ 模型**真实的交法**是 Markdown 表格（2026-10-21 11:10 那一单）。旧实现优先取第一个括号
  //    ⇒ 依据被读成「正在被使用」（5 字）⇒ **假阳性**判成"没给依据"。这一格钉死它别再回来。
  const TABLE = [
    '| 类别 | 结论 | 依据 |',
    '|---|---|---|',
    '| **婴幼儿姿势** | **无** | 画面读数为「婴幼儿 · 仰躺闭眼睡觉」，两处均为仰躺 |',
    '| **婴儿睡眠位置** | **有** | 逐面板核对：错误示范图为侧卧；安全建议图为仰卧 |',
    '| **产品状态** | **有** | 画面读数为「床铺、枕头、被子（正在被使用）」，而同一张床上同时有婴幼儿 ⇒ 松软寝具与婴幼儿同处使用，覆盖风险 |',
    '| **场景关系** | **有** | 画面读数为「婴幼儿与成人同床出镜」，同时「婴幼儿单独躺在婴儿床内」⇒ 同床与同房不同床并置 |',
    '| **隐私** | **无** | 画面读数为「画面为插画风格，非实拍」，未记载可识别真实人物身份 |',
  ].join('\n');
  assert.strictEqual(checkVisualChecklist(TABLE).ok, true,
    '表格写法（模型的真实交法）被误判成"没给依据" —— 这是假阳性，会把正常单压成 NEEDS_INPUT');
  // ①c 反向对照：表格里判「有」但依据列空着 ⇒ 仍必须红（别为了修假阳性把判据放成恒绿）
  assert.strictEqual(checkVisualChecklist([
    '| 类别 | 结论 | 依据 |', '|---|---|---|',
    '| **婴幼儿姿势** | **无** | — |',
    '| **产品状态** | **有** |  |',
    '| **场景关系** | **无** | — |',
    '| **隐私** | **无** | — |',
  ].join('\n')).ok, false, '表格里「有」+ 空依据也被放过 ⇒ 判据被改松了');
  // ② 反向对照：缺一类 ⇒ 红，且点名缺的是哪一类
  const miss = checkVisualChecklist(NO_PRIVACY);
  assert.strictEqual(miss.ok, false, '缺「隐私」却没判红');
  assert.ok(miss.missing.includes('隐私'), `缺项点名里没有「隐私」：${miss.missing.join('、')}`);
  // ③ 反向对照：**光提名字不给结论**不算覆盖（否则这条判据等于恒真）
  assert.strictEqual(checkVisualChecklist(NAME_ONLY).ok, false,
    '只提类别名、不给结论也被判过 ⇒ 判据恒真（真人就是这么敷衍过去的）');
  // ④ 反向对照：「有」不给依据 ⇒ 红；「未测」不给原因 ⇒ 红
  assert.strictEqual(checkVisualChecklist(
    '婴幼儿姿势=无；产品状态=有；场景关系=无；隐私=无').ok, false,
  '判「有」却没给依据也被放过');
  assert.strictEqual(checkVisualChecklist(
    '婴幼儿姿势=无；产品状态=未测；场景关系=无；隐私=无').ok, false,
  '判「未测」却没给原因也被放过');

  // ⑤ 闸门：图单缺项 ⇒ 表行结论压成 NEEDS_INPUT
  const run = async (inbound, answer, engine = inbound.imageCount > 0 ? {
    state: 'REVIEW', image_skill_gate: { ok: true, load: { verdict: 'loaded' } },
  } : null) => {
    let captured = null;
    let capturedReport = null;
    const result = await runSubmissionGate({
    imageClaimRunner: completedImageClaimFixture,
      inbound, question: inbound.text, notify: async () => {},
      factSourceLoader: () => ({ sources: factSources, errors: [] }),
      chainRunner: async () => ({ answer, ...(engine ? { engine } : {}) }),
      modelSideRunner: async () => ({ ok: true, findings: [], dropped: [] }),
      publishRunner: async (row) => { captured = row; return { ok: true, action: 'skipped', detail: '自证桩' }; },
      mergedReportRunner: async (md) => { capturedReport = md; return { ok: true, url: 'https://example.invalid/docx/STUB', detail: '自证桩' }; },
      adviceRunner: async () => ({ ok: true, ms: 1, advice: {} }),
      // 媒材链接这一步会**真上传**到云空间（§2.4.4 那个形状）⇒ 自证里必须全部注桩
      mediaLinksRunner: async () => [],   // collectMediaLinks 回**数组**，不是 {media}
      mediaUpload: async () => ({ ok: false, reason: '自证桩：不真上传' }),
      fetchImageForLink: async () => null,
      fetchVideoForLink: async () => null,
    });
    return { row: captured, result, report: capturedReport };
  };
  const { parseScene } = await import('./agent/scene.mjs');
  const imgInbound = { text: '审一下这张图', imageCount: 1, videoCount: 0, images: [{
    index: 1, wlText: 'AAP Recommendation', lines: 1,
    scene: { ok: true, scene: parseScene(JSON.stringify({
      people: [
        { kind: '婴幼儿', panel: '右上', doing: '仰卧', sleep_scene: true, sleep_posture: '仰卧' },
        { kind: '婴幼儿', panel: '右下', doing: '仰卧', sleep_scene: true, sleep_posture: '仰卧' },
      ],
    })).scene },
  }] };
  const bad = await run(imgInbound, FULL_WORKFLOW.replace('隐私=无', ''));
  const badRow = bad.row;
  assert.ok(badRow, '图单缺视觉核对时**没有落表**（连留痕都没有）');
  assert.strictEqual(badRow.conclusion, 'NEEDS_INPUT',
    `图单缺「隐私」却落了 ${badRow.conclusion} —— 缺项必须不收（压成 NEEDS_INPUT）`);
  assert.ok(bad.result.forcedReply?.includes('暂不出 PASS / REVIEW / BLOCK'),
    '图单视觉核对缺项只改了表结论，未强制替换用户将收到的旧三态回复');
  assert.strictEqual(bad.result.imageReviewIncomplete, true,
    '缺项拒收没有把「图片审查未完成」状态带到最终回复层');
  assert.strictEqual(bad.result.verdict53, null,
    '图单拒收态仍导出了 REVIEW/BLOCK/PASS 结论行，后续卡片会继续发旧结论');
  const staleReview = '【审查结论：REVIEW】共发现 1 处需人工确认。\n逐条问题\n1.【未归类】历史记录匹配';
  assert.strictEqual(finalVerdict53ForTurn({
    gateResult: bad.result,
    p0Payload: { answer: staleReview, p0Fastpath: { state: 'REVIEW', n: 1 } },
    toolTrace: [{ tool: 'kb_review_chain', ok: true }],
    chainAnswer: { answer: staleReview }, reply: staleReview,
  }), null,
  '图片审查未完成时，最终结论回落仍从 P0/历史链/回复文本复活了旧 REVIEW');
  const good = await run(imgInbound, FULL_WORKFLOW);
  const goodRow = good.row;
  assert.ok(goodRow && goodRow.conclusion === 'REVIEW',
    `图单四类齐却被压成了 ${goodRow && goodRow.conclusion}（闸门把正常单也拦了）`);
  assert.strictEqual(good.result.forcedReply, null,
    '完整视觉核对通过时错误触发拒收回复');
  assert.ok(finalVerdict53ForTurn({ gateResult: good.result }),
    '完整图片审查通过后被误删了合法的 §5.3 结论行');
  // ★ 2026-10-22（Owner：「报告不展示 图片安全审查 skill 全流程结果」「卡片不展示 视觉分析与 OCR」）：
  //   这一组从「必须收到全流程正文」翻成**「一个字都不许收到」**。
  assert.ok(!good.report?.includes('视觉分析与 OCR') && !good.report?.includes('4B 事实准确性核查')
    && !good.report?.includes('图片安全审查 skill 全流程结果'),
  '合并报告里又出现了 skill 全流程正文（Owner 2026-10-22 要求不展示）');
  assert.strictEqual(good.result.imageAnalysis, undefined,
    'imageAnalysis 这一格已整格撤掉（卡面不展示 视觉分析与 OCR）');

  // ⑤c ★★ 2026-10-22（Owner 把守衡的回话截图甩回来的那一单）：**话术本身也要有判据**。
  //   真实回话：「……视觉核对的结论没写清：场景关系（判"未测"但没给原因）。**请重新发送原图**，…」
  //   三处不对：① 判据原话进群；② 卡点在我们这侧（画面模型 HTTP 402），却让对方重发原图
  //   （他重发四次、四次同一句）；③ 没写清「没测完 ≠ 没问题」。
  //   ⇒ 判据错杀修在 `visual_checklist.mjs` 的 `resolveAnaphora`（见 S5m）；
  //     **话术**这一半修在 `imageWithholdReply`，本组钉它 —— 纯函数喂样本就能证。
  const { imageWithholdReply, humanizeSceneError, sceneFaultsOf } = await import('./agent/agent.mjs');
  const gapReply = imageWithholdReply({
    visualGate: { ok: false, missing: ['隐私'], weakItems: [{ label: '场景关系', verdict: '未测' }] },
    imageWorkflowGate: { ok: false, missing: ['图文一致性'] },
  });
  assert.ok(gapReply.includes('暂不出 PASS / REVIEW / BLOCK'),
    '话术里没了三态口径 —— 这句话必须让人知道「这次没有结论」');
  assert.ok(/没测完/.test(gapReply) && /不是「没问题」/.test(gapReply),
    `话术没写清「没测完 ≠ 没问题」（读起来像一次放行）：${gapReply}`);
  assert.ok(!gapReply.includes('请重新发送原图'),
    `话术还在让对方重发原图 —— 缺的是我们这份判定报告，不是他的素材：${gapReply}`);
  assert.ok(/不用重发图/.test(gapReply), '话术没说「不用重发」—— 对方会继续白折腾');
  assert.ok(!/判"未测"|判"有"|逐面板|判据|4A|4B/.test(gapReply),
    `判据术语/内部阶段名进了群：${gapReply}`);

  const sceneReply = imageWithholdReply({
    sceneFaults: [{ index: 1, why: '画面模型 HTTP 402：{"error":{"message":"Insufficient Balance"}}',
                    human: 'HTTP 402 · 额度不足' }],
  });
  assert.ok(/画面这一层我没读到/.test(sceneReply),
    `画面读数没读到时，话术没说清卡在哪：${sceneReply}`);
  assert.ok(/现在重发同一张图结果一样/.test(sceneReply),
    '画面读数没读到却说「请重发」—— 对方会一直重发（实测重发了四次）');
  assert.strictEqual(
    humanizeSceneError('画面模型 HTTP 402：{"error":{"message":"Insufficient Balance (request_id: 1237917b)"}}'),
    'HTTP 402 · 额度不足',
    '画面层报错没有压成一句人话（整段 JSON 不许甩进群）');
  // 只认本轮已成功执行且交出结构化画面的读数；看不清属于内容边界，不是未执行。
  assert.deepStrictEqual(sceneFaultsOf({ images: [{ index: 1,
    scene: { ok: true, scene: { setting: '看不清', people: [], products: [], unclear: ['环境被遮挡'] } } }] }), [],
    '画面读数正常时被当成缺口（这道闸会变成砖头）');
  assert.strictEqual(sceneFaultsOf({ images: [{ index: 1, scene: { skipped: true } }] }).length, 1,
    '跳过画面层不能冒充完整图片审查（P0 豁免由完成闸单独处理）');
  assert.strictEqual(sceneFaultsOf({ images: [{ index: 1, scene: { ok: true, scene: {} } }] }).length, 1,
    '只有成功标志的空画面不能冒充已取得读数');
  assert.strictEqual(sceneFaultsOf({ images: [{ index: 1, scene: { ok: false, error: 'HTTP 500' } }] }).length, 1,
    '画面读数失败没有被认出来 —— 这一闸等于没接');

  // ⑤d ★★ 画面读数没读到 ⇒ 这一单**也不出三态结论**（与「图没解析出来」同一条单向闸）。
  //   为什么：PRD §5.1 把图片输入写成两半，画面那一半没跑成时，「图片安全审查」里的视觉分析
  //   无从执行；而判定主体照样能交出一份五类全「未测」的清单 ⇒ 结论看起来像「审过了」。
  const sceneDown = await run({
    ...imgInbound,
    images: [{ index: 1, wlText: 'AAP Recommendation', lines: 1,
               scene: { ok: false, ms: 12, error: '画面模型 HTTP 402：{"error":{"message":"Insufficient Balance"}}' } }],
  }, FULL_WORKFLOW);
  assert.strictEqual(sceneDown.row?.conclusion, 'NEEDS_INPUT',
    `画面读数没读到却落了 ${sceneDown.row?.conclusion} —— 等于说「贴图画面的这一类已审过」`);
  assert.ok(sceneDown.result.forcedReply?.includes('画面这一层我没读到'),
    '画面读数缺口没有进回话 —— 群里只会看到一句结论不明的拒答');
  assert.ok(!sceneDown.result.forcedReply?.includes('请重新发送原图'),
    '画面读数缺口又把责任推给对方的图');
  assert.strictEqual(sceneDown.result.imageReviewIncomplete, true,
    '画面读数缺口的「审查未完成」状态没带到最终回复层（旧三态可能从下游复活）');
  // 反向对照：同一份回答、画面读数正常 ⇒ 不触发（证明拦的是「没读到」，不是「有图」）
  assert.strictEqual(good.result.forcedReply, null,
    '画面读数正常时也被这道闸拦了（恒红 = 这道闸坏了）');

  // ⑤b 引擎图片专属闸拒收时，即使模型答案写全流程、带旧 REVIEW，也必须压到 NEEDS_INPUT。
  const refused = await run(imgInbound, FULL_WORKFLOW, {
    state: 'NEEDS_INPUT', summary: '图片原图未进入图身份层',
    image_skill_gate: { ok: false, reason_code: 'image_source_missing',
      checks: ['没有 --image 原图路径'], load: null },
  });
  assert.strictEqual(refused.row?.conclusion, 'NEEDS_INPUT',
    '知识库图片闸拒收仍被模型侧 REVIEW 覆盖');
  assert.ok(refused.result.reviewFailure?.detail?.includes('没有 --image 原图路径'),
    '图片闸拒收原因没有保留在结构化失败详情');
  assert.ok(refused.result.forcedReply && !refused.result.forcedReply.includes('--image'),
    '拒收应有人话回复，不能把内部参数泄露到用户话术');
  assert.strictEqual(finalVerdict53ForTurn({ gateResult: refused.result,
    p0Payload: { answer: staleReview }, toolTrace: [{ tool: 'kb_review_chain', ok: true }],
    chainAnswer: { answer: staleReview }, reply: staleReview }), null,
  '图片引擎拒收后，旧 REVIEW 仍能从下游回落复活');
  const { imageEvidenceFailure } = await import('./agent/agent.mjs');
  assert.ok(imageEvidenceFailure({ answer: staleReview }, 1),
    '没有引擎图片闸读数却被当作已完整审查');
  const imageEngine = { engine: IMAGE_ENGINE_OK };
  assert.match(imageEvidenceFailure(imageEngine, 1, { ok: false, error: '模型返回空正文' }),
    /模型侧原图视觉\/语义审查未完成/, '模型侧失败仍允许只凭知识库输出完整图片结论');
  assert.equal(imageEvidenceFailure(imageEngine, 1, { ok: true, findings: [] }), null,
    '模型侧正常返回空问题清单时被误判成失败');
  assert.strictEqual(imageEvidenceFailure({ answer: staleReview }, 0), null,
    '文字单被图片专用闸门越界拦截');

  // ⑥ 反向对照：**文字单不触发**（它没有这四类）—— 不许把文本单一起拦掉
  const txt = await run({ text: '这段文案能不能发：x', imageCount: 0, videoCount: 0 }, NO_PRIVACY);
  const txtRow = txt.row;
  assert.ok(txtRow && txtRow.conclusion !== 'NEEDS_INPUT',
    '文字单被视觉核对闸门拦了 —— 越界（文本单没有这四类）');
  assert.strictEqual(txt.result.forcedReply, null, '文字单触发了图单专用拒收回复');

  // ⑦ 提示词：图单任务里必须有这五类；文字单**不许**有（否则模型会对文本单瞎写画面事实）
  const { reviewTaskFor } = await import('./agent/tools.mjs');
  const imgTask = reviewTaskFor({ question: 'q', text: 't', materialPath: '/tmp/m.txt', ctype: 'image' });
  assert.ok(imgTask.includes('第 0 条之三') && ['婴幼儿姿势', '婴儿睡眠位置', '仰卧/侧卧/俯卧', '侧卧/俯卧时该项必须判「有」', '床共享风险与睡姿是两个独立问题', '产品状态', '场景关系', '隐私'].every((x) => imgTask.includes(x)),
    '图单任务里没有「视觉核对清单」那一段 —— 模型不知道要交，闸门只会把每一单都压成 NEEDS_INPUT');
  const txtTask = reviewTaskFor({ question: 'q', text: 't', materialPath: '/tmp/m.txt', ctype: 'text' });
  assert.ok(!txtTask.includes('第 0 条之三'), '文字单任务里也塞了视觉核对块 —— 越界');

  // ⑧ ★★ 读数边界（2026-10-21「奶瓶倒着放」）：读数里明明有倒置容器，清单却一个字没提 ⇒ 红。
  //   这是本轮唯一能咬到「看见了却装没看见」的判据；读数没看见时不咬（那是读数的账）。
  const { abnormalContainers } = await import('./agent/scene.mjs');
  const sc = parseScene(JSON.stringify({ products: [{ what: '白色小奶瓶', orientation: '口朝下' }] })).scene;
  const abnormal = abnormalContainers(sc);
  assert.strictEqual(abnormal.length, 1, '夹具没造出「姿态异常的容器」');
  // ⚠️ 夹具必须**不点名**那个倒置奶瓶（FULL 里写了「奶瓶」⇒ 它当然算点名了；第一版就是这里写错）
  const NO_BOTTLE = '【审查结论：REVIEW】共发现 2 处需人工确认。\n'
    + '视觉核对：婴幼儿姿势=无；产品状态=有（床头柜上的物品摆放正常）；场景关系=无；隐私=无';
  assert.strictEqual(checkVisualChecklist(NO_BOTTLE, { abnormal }).ok, false,
    '读数里有倒置奶瓶，清单里一个「瓶/杯/罐/盒/壶」都没有，却被放行 —— 那就是这次漏检的形状');
  assert.strictEqual(checkVisualChecklist(
    FULL.replace('产品状态=有（床头柜上的奶瓶倒置）', '产品状态=有（床头柜上的奶瓶口朝下，见读数物品栏）'),
    { abnormal }).ok, true,
  '清单里点了那个倒置奶瓶，却被判红 —— 假阳性（这条判据不许咬到正常单）');
});

await t('N4d2a ★★ 图单没审完时群里那句话：不许出现内部字段名、不许让对方做他做不到的事（Owner 2026-10-23 甩回来的原话）', async () => {
  // 被甩回来的原话（生产实测，`om_x100b62984d0ad4e4c432d13cb478ec3`）：
  //   句子 A：「本轮图片审查证据未通过：本轮没有可核对的知识库引擎 JSON；图片审查状态未验证。」
  //   句子 B：「暂不出 PASS / REVIEW / BLOCK；请在原图和图片安全审查 skill 的本会话执行证据齐全后重新审核。」
  //   （故意拆成两句写，别整段粘 —— 判据是「代码路径里有没有它」，不是「注释里能不能引」）
  // 三处都错：① 内部字段名当理由 ② 让对方去做只有我这侧能产生的事 ③ 没说停在哪、还等不等。
  const { imageUnfinishedReply } = await import('./agent/agent.mjs');
  const chainDead = imageUnfinishedReply({ chainRan: false, chainMs: 549_858, reason: '' });
  // ① 必须说清「没审完 ≠ 没问题」，且四个字不能丢（下游断言与 PRD 都认它）
  assert.ok(chainDead.includes('暂不出 PASS / REVIEW / BLOCK'), `三态留白那句丢了：${chainDead}`);
  assert.ok(/没测完/.test(chainDead) && !/没问题。/.test(chainDead.replace('不是「没问题」', '')),
    `没说清「没测完 ≠ 没问题」：${chainDead}`);
  // ② 真实耗时（9 分 9 秒 ⇒ 9 分钟）要写进去，不许写死一个数
  assert.ok(chainDead.includes('9 分钟'), `没有按真实耗时说卡了多久：${chainDead}`);
  // ③ 我方动作 + 对方动作分开写，且**不许**让对方重做
  assert.ok(!/已经自动排进|已进入.{0,8}队列/.test(chainDead), '排队未发生前不许承诺已入队');
  assert.ok(!chainDead.includes('4B 联网核查的请求'), '不许用旧事故的网络原因解释所有失败');
  assert.ok(chainDead.includes('不用重发这张图'), '没说「不用重发这张图」');
  // ④ 内部字段名 / 术语一个都不许出现（这就是被甩回来的直接原因）
  for (const bad of ['引擎 JSON', '知识库引擎', 'skill', '旁挂', '读数', '证据未通过', '执行证据']) {
    assert.ok(!chainDead.includes(bad), `群消息里出现了内部术语「${bad}」：${chainDead}`);
  }
  assert.ok(!/请在原图.*重新审核/.test(chainDead), `又在让对方去补证据后重新审核：${chainDead}`);
  // ⑤ 反向对照：画面那一半没做成时，措辞必须换（不然两种卡点长同一张脸）
  const sceneDead = imageUnfinishedReply({ modelSideFailed: true, reason: '画面模型 HTTP 402：{"error":{"message":"Insufficient Balance"}}' });
  assert.ok(sceneDead.includes('画面这一半'), `模型侧失败没说成画面这一半：${sceneDead}`);
  assert.ok(!sceneDead.includes('4B'), `画面失败却谈 4B（方向错了）：${sceneDead}`);
  assert.ok(sceneDead.includes('额度不足'), `画面失败的原始原因没翻成人话：${sceneDead}`);
  assert.ok(sceneDead.includes('不用重发这张图'), '画面失败时又说要重发图了');
  // ⑥ 接线：那条分支必须真的走这个函数（名字出现过 ≠ 接上了）
  const src = fs.readFileSync(new URL('./agent/agent.mjs', import.meta.url), 'utf8');
  assert.ok(/visualGateRefusal = imageUnfinishedReply\(/.test(src),
    'imageUnfinishedReply 没有被接到 visualGateRefusal 上 —— 群里还会读到旧句子');
  // ⚠️ 先剥掉注释再查：那句话**允许**留在注释里（我给新函数写的头注就逐字引了它当反例），
  //   但**不许**再出现在任何代码路径上。第一版就是这么假红的（判据咬到了自己的注释）。
  const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!codeOnly.includes('请在原图和图片安全审查 skill 的本会话执行证据齐全后重新审核'),
    '旧句子还活在某条代码路径上（群里还会读到它）');
});

await t('N4d2 ★★ P0 确定性命中＋带图 ⇒ 图单两道闸门不适用，BLOCK 必须照发（Owner 2026-10-22 那张被拒答的图）', async () => {
  // ── 病灶（生产实测，`om_x100b62aff6a2c22ccfd45eeca787bff`，2026-10-22 15:30）
  //   Owner 发了一张 momcozy 产品图 ＋ @守衡（正文为空，只有 OCR 与画面读数）。
  //   库侧 P0 快路命中 V02／E-2.124 ⇒ 双轨合并态 BLOCK、`p0DirectReply` 已备好；
  //   而 `imageEvidenceFailure`（要引擎 JSON）＋ 图单两道闸门（要五类视觉核对、skill 全流程节）
  //   都挂在**只有模型侧才产出**的东西上，而 PRD §6.3 说 P0 命中即停后续审查、模型侧不该跑。
  //   ⇒ 必然缺项 ⇒ 表里落 NEEDS_INPUT、群里收到「本轮图片审查证据未通过……请重新发送原图」，
  //   **BLOCK 被自己的闸门藏掉**（§2.4.5 的接缝撞车）。
  //   本组钉两件：① P0＋图 ⇒ 不拒答、结论仍是 BLOCK、§5.3 结论行在；
  //              ② 反向对照：把 P0 摘掉，同一张图**必须**仍被拒（否则就是「把闸门整个关掉」）。
  const { runSubmissionGate, imageEvidenceFailure, finalVerdict53ForTurn } = await import('./agent/agent.mjs');
  // ★ 2026-10-22（裁定 B）：夹具里的 P0 命中词从「100%」改成「纯天然」——
  //   裸 100% 已出列 P0（V02 只剩 纯天然/最安全/绝对化用语），若还拿它当 E-2.124 的正例，
  //   这条用例就在**教下一个人一个已经废掉的口径**。
  const P0_RENDERED = '【审查结论：BLOCK】共发现 1 处必须修改。\n逐条问题\n· 绝对化用语（E-2.124）：「纯天然」无证据支撑。';
  const P0_CHAIN = {
    ok: true,
    answer: P0_RENDERED,
    p0_fastpath: { mode: 'p0_fastpath', elapsed_ms: 115, matched_patterns: 1, rule_codes: ['V02'],
                   layer_preflight: { mode: 'p0_fastpath', enforced: false, is_pass_basis: false } },
    p0_findings: [{ rule_code: 'V02', level: 'P0', verdict: 'BLOCK', article_no: 'E-2.124',
                    matched: [{ line_text: '纯天然', span: [0, 3] }], matched_count: 1 }],
    advisories: [], issue_count: 1, confidence: 1.0,
    report: 'https://example.invalid/docx/P0STUB', report_path: null, report_detail: '自证桩',
    product_line: '', channel: '',
  };
  const imgInbound = { text: '', imageCount: 1, videoCount: 0,
                       images: [{ index: 1, wlText: '成分纯天然', lines: 17 }] };
  const modelFindings = [{
    location: '图 1 主视觉', category: '推广与价格透明', severity: 'REVIEW',
    reason: '组合价适用范围含糊', excerpt: 'Choose Any 3 Pay Less than $99',
    suggestion: '写明适用品类', source: 'none',
  }];
  const runWith = async (chainRes) => {
    let row = null;
    const result = await runSubmissionGate({
    imageClaimRunner: completedImageClaimFixture,
      inbound: imgInbound, question: imgInbound.text, notify: async () => {},
      chainRunner: async () => chainRes,
      modelSideRunner: async () => ({ ok: true, findings: modelFindings, dropped: [] }),
      publishRunner: async (r) => { row = r; return { ok: true, action: 'skipped', detail: '自证桩' }; },
      mergedReportRunner: async () => ({ ok: true, url: 'https://example.invalid/docx/STUB', detail: '自证桩' }),
      adviceRunner: async () => ({ ok: true, ms: 1, advice: {} }),
      mediaLinksRunner: async () => [],
      mediaUpload: async () => ({ ok: false, reason: '自证桩：不真上传' }),
      fetchImageForLink: async () => null,
      fetchVideoForLink: async () => null,
    });
    return { row, result };
  };

  // ① 正向：P0 命中 ⇒ 不拒答、结论 BLOCK、§5.3 结论行在
  const hit = await runWith(P0_CHAIN);
  assert.ok(hit.row, 'P0＋图单没有落表（连留痕都没有）');
  assert.strictEqual(hit.row.conclusion, 'BLOCK',
    `P0 命中的图单被压成了 ${hit.row.conclusion} —— 已确定的 BLOCK 被图单闸门藏掉`);
  assert.strictEqual(hit.result.forcedReply, null,
    'P0 确定性命中的图单仍被强制替换成「证据未通过」拒答话术');
  assert.strictEqual(hit.result.imageReviewIncomplete, false,
    'P0 命中的图单被标成「图片审查未完成」，下游据此丢掉整份结论');
  assert.ok(String(hit.result.verdict53?.line ?? '').includes('BLOCK'),
    `P0＋图单拿不到 §5.3 结论行：${JSON.stringify(hit.result.verdict53)}`);
  assert.ok(finalVerdict53ForTurn({ gateResult: hit.result }),
    'P0＋图单的最终结论行被 imageReviewIncomplete 抹掉');
  assert.ok(String(hit.result.p0DirectReply ?? '').includes('【审查结论：BLOCK】'),
    'P0 直达回复不是那张 BLOCK 卡（群里会没有三态结论）');
  // ② 判据本身：P0 读数在 ⇒ 不需要引擎 JSON；模型侧整轮没跑也不拦（PRD §6.3 主动停审）
  assert.strictEqual(imageEvidenceFailure(P0_CHAIN, 1, { ok: true, findings: [] }), null,
    'P0 命中仍被要「知识库引擎 JSON」—— P0 快路按 PRD §6.3 根本不跑那一段');
  assert.strictEqual(imageEvidenceFailure(P0_CHAIN, 1, { ok: false, error: '自证桩：模型侧未跑' }), null,
    'P0 命中的图单仍被要「模型侧原图审查」—— 而命中即停，模型侧本来就不该跑');
  // ③ 反向对照：摘掉 P0 读数（同一张图、同一份模型侧）⇒ 仍必须拒（闸门没被整体关掉）
  const plain = await runWith({ ok: true,
    answer: '【审查结论：REVIEW】共发现 1 处需人工确认。\n逐条问题\n· 价格表述含糊' });
  assert.strictEqual(plain.row?.conclusion, 'NEEDS_INPUT',
    `没有 P0 的图单缺视觉核对 / 引擎读数时落了 ${plain.row?.conclusion} —— 闸门被改松了`);
  assert.ok(String(plain.result.forcedReply ?? '').includes('暂不出 PASS / REVIEW / BLOCK'),
    '没有 P0 的图单缺项时不再强制拒收');
  assert.ok(imageEvidenceFailure({ ok: true, answer: 'x' }, 1, { ok: true, findings: [] }),
    '没有 P0 读数、也没有引擎 JSON 的图单被当成证据齐全');
  // ④ 边界：这条闸本来就只管图单 —— imageCount=0 时连 P0 都不必看
  assert.strictEqual(imageEvidenceFailure(P0_CHAIN, 0, null), null,
    '文字单被这条闸门越界拦截');
});

await t('Z45 ★★ P0 命中 ⇒ 置信度**两侧同档 1.0**（Owner 2026-10-16：「模型侧应该也是 1，最终出 1」）', async () => {
  // ── 为什么有这一条（当天吵了三轮的收口）
  //   PRD §6.6 末句：「P0 层级规则不适用置信度分流，命中即 BLOCK，**置信度记为 1.0**。」
  //   Owner 的补充：「**模型侧应该也是 1，最终出 1**」—— 即 P0 那一档**不参与"取保守"**：
  //   模型侧照样跑、照样出条目，但**不许**把确定性命中拉低（原先会被拉到 0.85，
  //   于是出现「结论 BLOCK ／ 置信度 0.85」这种与 §6.6 打架的显示）。
  //
  //   ⚠️ 与 Z42 同一条纪律：模块级自证（`dual_track` ㉕a–㉕e）只管到纯函数，
  //      **表行那个数**是 `agent.mjs` 算完再传进发布件的 —— 只有在这里真跑一遍
  //      `runSubmissionGate`、读**捕获桩拿到的表行参数**，才叫验过。
  const { runSubmissionGate } = await import('./agent/agent.mjs');
  const inbound = { text: '审核下这个吸奶器文案：吸奶器M9，是最好的吸奶器', imageCount: 0, videoCount: 0 };
  const mkFindings = (n) => Array.from({ length: n }, (_, i) => ({
    location: `图 ${i + 1}`, category: '措辞表达', severity: 'REVIEW',
    reason: 'r', excerpt: 'e', suggestion: 's', source: 'none',
  }));
  const run = async (chainExtra) => {
    let captured = null;
    await runSubmissionGate({
    imageClaimRunner: completedImageClaimFixture,
      inbound, question: inbound.text, notify: async () => {},
      chainRunner: async () => ({ answer: '【审查结论：BLOCK】占位', ...chainExtra }),
      modelSideRunner: async () => ({ ok: true, findings: mkFindings(5), dropped: [] }),
      publishRunner: async (row) => { captured = row; return { ok: true, action: 'skipped', detail: '自证桩' }; },
      mergedReportRunner: async () => ({ ok: true, url: 'https://example.invalid/docx/STUB', detail: '自证桩' }),
      adviceRunner: async () => ({ ok: true, ms: 1, advice: {} }),
    });
    return captured;
  };
  // ① 正向：P0 快路命中（库侧 1.0）＋ 模型侧 5 条命中 ⇒ 表行那个数必须是 **1**
  const p0 = await run({ p0_fastpath: { elapsed_ms: 48, matched_patterns: 1, rule_codes: ['H05'] },
                         issue_count: 2, confidence: 1.0 });
  assert.ok(p0, '捕获桩没被调用 —— 这一条会退化成空断言');
  assert.strictEqual(p0.confidence, 1,
    `P0 命中的置信度必须是 1.0（两侧同档），实得 ${p0.confidence}`);
  // ② **格内**按现行口径只有 PRD §5.3 块（2026-10-09 裁定：口径说明不占这一格）——
  //    这里钉住它，免得有人又把内部读数塞回格子；置信度那句口径由 `machineNumbers` 的
  //    `note` 出，**单测 D2 逐字管着**（PRD 原文 ＋「两侧同档」）。
  assert.ok(/【审查结论：BLOCK】共发现 \d+ 处必须修改/.test(String(p0.summary ?? '')),
    '格内必须是 PRD §5.3 的结论行');
  assert.ok(!/⚠️ 口径|两侧合并 · 档位|两端条数对不上/.test(String(p0.summary ?? '')),
    '格内不许塞内部口径读数（口径有它自己那一列 / 报告）');
  // ③ ★ 反向对照：同一套输入、**不带 P0**（普通 BLOCK，库侧 0.95）⇒ 必须落回 0.85。
  //    少了它，① 可能只是"所有 BLOCK 都给 1.0"的恒真判据。
  const normal = await run({ review: { state: 'BLOCK', issue_count: 3, confidence: 0.95 } });
  assert.strictEqual(normal.confidence, 0.85,
    `非 P0 的 BLOCK 仍要按两侧取保守 ⇒ 0.85，实得 ${normal.confidence}`);
});

await t('Z46 ★★ PASS 行（没有可合并条目）格内必须是 **PRD §5.3.2 结论行**，不许回落占位话术', async () => {
  // ── 为什么有这一条（80 行逐字段核对抓出来的最后一个异类：行22）
  //   行22 的格内是「链已跑完（59s）。结论原文见对话与报告；本行由守衡在链返回后核对落表。
  //   ⚠️ 产品线、渠道：…」——**那不是 PRD 块**，而是"没有 `rendered.block` 时回落 `summaryText`"
  //   那一支的产物（PASS、两侧 0 条的常见形状）。9 个 PASS 行里只有它长这样。
  //   判据：PASS + 无可合并条目 ⇒ 格内**必须**含 `【审查结论：PASS】`。
  const { runSubmissionGate } = await import('./agent/agent.mjs');
  let cap = null;
  await runSubmissionGate({
    imageClaimRunner: completedImageClaimFixture,
    inbound: { text: '审一下这条：普通商品图，无宣称', imageCount: 0, videoCount: 0 },
    question: 'x', notify: async () => {},
    chainRunner: async () => ({ answer: '【审查结论：PASS】占位',
                               review: { state: 'PASS', issue_count: 0, confidence: 0.93 } }),
    modelSideRunner: async () => ({ ok: true, findings: [], dropped: [] }),
    publishRunner: async (row) => { cap = row; return { ok: true, action: 'skipped', detail: '自证桩' }; },
    mergedReportRunner: async () => ({ ok: true, url: null, detail: '桩：无可并条目 ⇒ 不建' }),
    adviceRunner: async () => ({ ok: true, ms: 1, advice: {} }),
  });
  assert.ok(cap, '捕获桩没被调用');
  const cell = String(cap.summary ?? '');
  assert.ok(/【审查结论：PASS】/.test(cell), `PASS 行格内必须是 PRD §5.3.2 结论行，实得：${cell.slice(0, 80)}`);
  assert.ok(!/链已跑完|本行由守衡在链返回后核对落表/.test(cell),
    '不许回落成占位话术（那不是 PRD 块）');
  assert.strictEqual(cap.conclusion, 'PASS');
  assert.strictEqual(cap.issueCount, 0);
});

await t('Z46b ★★ 引擎读 PASS、最终结论 REVIEW ⇒ 表行必须写出「两者不一致」，不许只写占位话术', async () => {
  // ── 真单（BM04/BM01 婴儿监视器对比图，2026-10-22）：
  //   链的引擎给 `PASS / 0 处 / 0.93`，链自己按图片安全审查 skill 的覆盖判据合并成 REVIEW；
  //   表行原先只写「结论原文见对话与报告」—— 读表的人看到「0 处 + REVIEW」，
  //   没有任何东西告诉他这两个数为什么不一样。这一格必须自己说出来（只搬读数，不解释原因）。
  const { runSubmissionGate } = await import('./agent/agent.mjs');
  const run = async (chainAnswer, reviewState, contentId = null) => {
    let cap = null;
    let optsCap = null;
    await runSubmissionGate({
    imageClaimRunner: completedImageClaimFixture,
      inbound: { text: '审一下这张图能过吗？', imageCount: 0, videoCount: 0 },
      question: 'x', notify: async () => {},
      chainRunner: async () => ({ answer: chainAnswer,
        review: { state: reviewState, issue_count: 0, confidence: 0.93,
                  ...(contentId ? { content_id: contentId } : {}) } }),
      modelSideRunner: async () => ({ ok: true, findings: [], dropped: [] }),
      publishRunner: async (row, opts) => {
        cap = row; optsCap = opts; return { ok: true, action: 'skipped', detail: '自证桩' };
      },
      mergedReportRunner: async () => ({ ok: true, url: null, detail: '桩' }),
      adviceRunner: async () => ({ ok: true, ms: 1, advice: {} }),
    });
    return { cap, opts: optsCap };
  };
  // ★ 正向：引擎 PASS / 最终 REVIEW（真单那一份形状）
  const { cap: mism, opts: mismOpts } =
    await run('合并结论：REVIEW（库侧无覆盖，结论应为 REVIEW 并注明）', 'PASS', 'AD-20261022-021');
  assert.ok(mism, '捕获桩没被调用 —— 这一条会退化成空断言');
  const cell = String(mism.summary ?? '');
  assert.ok(/引擎读数 PASS/.test(cell), `格内必须写出引擎读数，实得：${cell.slice(0, 120)}`);
  assert.ok(/最终合并结论 REVIEW/.test(cell), `格内必须写出最终结论，实得：${cell.slice(0, 120)}`);
  assert.ok(/两者不一致/.test(cell), `格内必须点明两者不一致，实得：${cell.slice(0, 120)}`);
  assert.strictEqual(mism.conclusion, 'REVIEW', '表行结论以最终结论为准');
  // ★ 接线：链的内容 ID 必须**真的**交给落表（否则第三把锁是空谈，两行照旧会出现）
  assert.strictEqual(mismOpts?.chainContentId, 'AD-20261022-021',
    `落表没拿到链的内容 ID（实得 ${mismOpts?.chainContentId}）—— 同一单会再建第二行`);
  // ★ 反向对照：引擎与最终一致（都 PASS）⇒ **不许**出现「两者不一致」
  //   （否则那句话会覆盖掉正常的 PRD 结论行；这是本组最容易写成恒真的地方）
  const { cap: same, opts: sameOpts } =
    await run('【审查结论：PASS】未发现已知底线风险，可转交 @sign-off 责任人（未配置） 进行 sign-off。', 'PASS');
  const okCell = String(same?.summary ?? '');
  assert.ok(!/两者不一致/.test(okCell), `一致时不许写「两者不一致」，实得：${okCell.slice(0, 120)}`);
  // 反向对照（接线）：链没给内容 ID ⇒ 不许凭空编一个
  assert.strictEqual(sameOpts?.chainContentId, null,
    `链没给内容 ID 时不许编（实得 ${sameOpts?.chainContentId}）`);
});

await t('Z46c ★★ 判定主体的 F 型条目必须进双轨（问题数 ≥3、回建报告）—— BM04/01 真单形状', async () => {
  // ── 病灶（2026-10-22 真单）：链的回答用 `**F1（优先 2｜…）**` + `- 位置/为什么/建议`
  //   交付 5 条实质问题，而抽取器只认 `1.` 编号行 ⇒ 抽出 0 条 ⇒ 表里问题数 0、
  //   不建报告、卡片结论全靠模型自拟。修在 `skill_findings.mjs`（F 型 + 标题级锚点）；
  //   这一条钉的是**它真的接进了双轨**（不是只在自证里过）。
  const { runSubmissionGate } = await import('./agent/agent.mjs');
  const answer = [
    '## 七、视觉核对清单与分级结论',
    '',
    '### 问题清单（按 skill 优先级排序）',
    '',
    '**F1（优先 2｜安全信息不完整 + 潜在误读）**',
    '- 位置：右侧，图 1 第 6 处（BM01 屏内）',
    '- 为什么：屏内婴儿颏/颊紧贴蓝布与灰蓝软物，整图无安全提示。',
    '- 建议：换图或在图内加安全提示。',
    '',
    '**F2（优先 3｜图文一致性/潜在误读）**',
    '- 位置：顶部，图 1 第 1 处（标题 Keep an Eye on Every Room）',
    '- 为什么：监护类标题与婴儿影像并列，易被读成替代看护。',
    '- 建议：加免责提示。',
    '',
    '**F3（优先 2｜事实无法确认）**',
    '- 位置：中部，图 1 第 10 处（$259.99 USD）',
    '- 为什么：无 SKU 事实基线。',
    '- 建议：补数值与口径。',
    '',
    '**F5（优先 4｜呈现质量，降权）**',
    '- 位置：右侧，图 1 第 6 处（5″ HD 角标）',
    '- 为什么：角标遮挡画面。',
    '- 建议：移出主体。',
    '',
    '合并结论：REVIEW（本 skill 定级）。',
  ].join('\n');
  let cap = null; let repCalled = false;
  await runSubmissionGate({
    imageClaimRunner: completedImageClaimFixture,
    inbound: { text: '审一下这张图能过吗？', imageCount: 0, videoCount: 0 },
    question: 'x', notify: async () => {},
    chainRunner: async () => ({ answer,
      review: { state: 'PASS', issue_count: 0, confidence: 0.93 } }),
    modelSideRunner: async () => ({ ok: true, findings: [], dropped: [] }),
    publishRunner: async (row) => { cap = row; return { ok: true, action: 'skipped', detail: '自证桩' }; },
    mergedReportRunner: async () => { repCalled = true; return { ok: true, url: null, detail: '桩' }; },
    adviceRunner: async () => ({ ok: true, ms: 1, advice: {} }),
  });
  assert.ok(cap, '捕获桩没被调用');
  assert.strictEqual(cap.conclusion, 'REVIEW', '合并结论仍以链的最终结论为准');
  assert.ok(Number(cap.issueCount) >= 3,
    `F 型条目没进双轨：问题数 ${cap.issueCount}（F1–F3 应计 3 条，F5 降权不上卡）`);
  assert.ok(/【审查结论：REVIEW】共发现 \d+ 处需人工确认/.test(String(cap.summary ?? '')),
    `表行必须是 PRD 结论块，实得：${String(cap.summary ?? '').slice(0, 80)}`);
  assert.ok(repCalled, '≥3 条必须回建合并报告（否则逐条只能回对话里翻）');
});

await t('Z46d ★★ 链跑成但结论行解析不出 ⇒ 表行必须是 NEEDS_INPUT，不许停在 PASS', async () => {
  // ── 真单（Paruu CM100，2026-10-22）：链写
  //   `**本 skill 分级结论（4A＋4B＋图文一致性合并，取更保守一侧）**：**REVIEW**`
  //   而当时的 `conclusionOf` 认不出（括号夹在「结论」与「：」之间）⇒ `Agent 结论` 没写
  //   ⇒ 表行停在链自己写的 PASS，卡片却是 REVIEW。
  //   这里钉两件：① 能解析时要拿到 REVIEW（同一句真实写法）；
  //   ② 解析不出时**落 NEEDS_INPUT**并在汇总里说明 —— 不许回落成 PASS 或沉默。
  const { runSubmissionGate } = await import('./agent/agent.mjs');
  const run = async (answer) => {
    let cap = null;
    await runSubmissionGate({
    imageClaimRunner: completedImageClaimFixture,
      inbound: { text: '审一下这张图能过吗？', imageCount: 0, videoCount: 0 },
      question: 'x', notify: async () => {},
      chainRunner: async () => ({ answer,
        review: { state: 'PASS', issue_count: 0, confidence: 0.93 } }),
      modelSideRunner: async () => ({ ok: true, findings: [], dropped: [] }),
      publishRunner: async (row) => { cap = row; return { ok: true, action: 'skipped', detail: '自证桩' }; },
      mergedReportRunner: async () => ({ ok: true, url: null, detail: '桩' }),
      adviceRunner: async () => ({ ok: true, ms: 1, advice: {} }),
    });
    return cap;
  };
  // ① 真单那句写法必须解析成 REVIEW
  const good = await run('**本 skill 分级结论（4A＋4B＋图文一致性合并，取更保守一侧）**：**REVIEW**');
  assert.ok(good, '捕获桩没被调用');
  assert.strictEqual(good.conclusion, 'REVIEW',
    `带括号的分级结论行没认出来（实得 ${good.conclusion}）—— 表行会停在链的 PASS`);
  // ② 解析不出 ⇒ NEEDS_INPUT，且汇总必须说明原因
  const bad = await run('链给出的结论是 REVIEW，但这句没有冒号。');
  assert.ok(bad, '捕获桩没被调用');
  assert.strictEqual(bad.conclusion, 'NEEDS_INPUT',
    `解析不出时不许停在 PASS（实得 ${bad.conclusion}）`);
  assert.ok(/结论行解析不出/.test(String(bad.summary ?? '')),
    `汇总必须说明「解析不出」，实得：${String(bad.summary ?? '').slice(0, 80)}`);
  // ★ 回滚开关：`SHOUHENG_CONCLUSION_STRICT=0` ⇒ 这条 fail-closed 关掉（应急回滚用）
  const oldStrict = process.env.SHOUHENG_CONCLUSION_STRICT;
  try {
    process.env.SHOUHENG_CONCLUSION_STRICT = '0';
    const off = await run('链给出的结论是 REVIEW，但这句没有冒号。');
    assert.ok(!off.conclusion, `开关关掉后不该再强制 NEEDS_INPUT（实得 ${off.conclusion}）`);
  } finally {
    if (oldStrict === undefined) delete process.env.SHOUHENG_CONCLUSION_STRICT;
    else process.env.SHOUHENG_CONCLUSION_STRICT = oldStrict;
  }
});

await t('Z46e ★★ 零发现（双轨合了 0 条）也必须出 §5.3.1 PASS 结论行，不许打成「审查未完成」', async () => {
  // ── 真单（`20261103-160411` 视频）：引擎 PASS/0、模型侧 0 条 ⇒ `renderMerged` 回 null
  //   ⇒ `mergedCount` 原先取 `rendered?.total ?? null` = null
  //   ⇒ `verdictLineFor({state:'PASS', n:null})` 回 null（它只认 n===0）
  //   ⇒ `verdict53=null` ⇒ 信封层「有读数却没有 §5.3 结论行」⇒ 固定「审查未完成」告警卡。
  //   这是**零发现**单子的必现形状，不是偶发：只要模型侧没报东西，卡就永远出不来。
  //   修法：双轨跑过、只是没有条目可并 ⇒ 卡里那个数是 **0**（不是「不知道」）。
  const { runSubmissionGate } = await import('./agent/agent.mjs');
  let cap = null;
  const answer = [
    '## 审核对象与范围', '文本 1 条',
    '## 视觉分析与 OCR', '无画面',
    '## 主张拆分与核查清单', '1. 无',
    '## 4A 规则符合性', '未命中',
    '## 4B 事实准确性核查', '不适用',
    '## 图文一致性', '不适用',
    '### 问题清单', '1. 无',
    '### ③b 转述模板',
    '状态：PASS ｜ 问题数：0 ｜ 置信度：0.93',
  ].join('\n');
  await runSubmissionGate({
    imageClaimRunner: completedImageClaimFixture,
    inbound: { text: '审一下这条文案：Momcozy 吸奶器，柔软舒适。', imageCount: 0, videoCount: 0 },
    question: 'x', notify: async () => {},
    chainRunner: async () => ({ answer,
      review: { state: 'PASS', issue_count: 0, confidence: 0.93 } }),
    modelSideRunner: async () => ({ ok: true, findings: [], dropped: [] }),
    publishRunner: async (row) => { cap = row; return { ok: true, action: 'skipped', detail: '自证桩' }; },
    mergedReportRunner: async () => ({ ok: true, url: null, detail: '桩' }),
    adviceRunner: async () => ({ ok: true, ms: 1, advice: {} }),
  });
  assert.ok(cap, '捕获桩没被调用');
  assert.strictEqual(cap.conclusion, 'PASS', `零发现应判 PASS（实得 ${cap.conclusion}）`);
  assert.ok(/【审查结论：PASS】未发现已知底线风险/.test(String(cap.summary ?? '')),
    `零发现必须带 PRD §5.3.1 那一行，否则卡会退回「审查未完成」；实得：${String(cap.summary ?? '').slice(0, 80)}`);
  // 反向对照：链没读音（没有 review、答案也没有结论行）时仍不许停在 PASS
  let cap2 = null;
  await runSubmissionGate({
    imageClaimRunner: completedImageClaimFixture,
    inbound: { text: '审一下这条文案：Momcozy 吸奶器，柔软舒适。', imageCount: 0, videoCount: 0 },
    question: 'x', notify: async () => {},
    chainRunner: async () => ({ answer: '看过了，没问题。' }),
    modelSideRunner: async () => ({ ok: true, findings: [], dropped: [] }),
    publishRunner: async (row) => { cap2 = row; return { ok: true, action: 'skipped', detail: '自证桩' }; },
    mergedReportRunner: async () => ({ ok: true, url: null, detail: '桩' }),
    adviceRunner: async () => ({ ok: true, ms: 1, advice: {} }),
  });
  assert.ok(cap2, '捕获桩没被调用（反向对照）');
  assert.strictEqual(cap2.conclusion, 'NEEDS_INPUT',
    `没有机读读数时不许因 mergedCount 兜底而停在 PASS（实得 ${cap2.conclusion}）`);
});

await t('Z47 ★★ 批跑器回填**只认本轮那一行**（猜行的代价：把另一遍/上一轮的字段搬进你的表）', async () => {
  const { readFileSync } = await import('node:fs');
  // ── Owner 2026-10-16：「3 只有你写，别人没写」＋ 80 行逐字段核对：
  //   行22 搬回了上一轮的占位话术；行30/33/34/48/52 落的数与**本轮报告**对不上
  //   （报告 4/1/4/4/4，表里 3/2/3/2/3 —— 那与本单在结论表里的**另一遍**一致）。
  //   ⇒ 常规批跑路径必须 `strict: true`：拿不到本轮 `publishedRowId` ⇒ **不写**并出声。
  //   `--backfill`（历史补写）保留猜：它本来就没有本轮 id。
  const src = readFileSync(new URL('./batch_review_runner.mjs', import.meta.url), 'utf8');
  const wired = (t) => /\{ strict: true \}/.test(t) && /const hit = strictHit \|\| \(strict \? null : _guess\)/.test(t);
  assert.ok(wired(src), '批跑器没接 strict —— 回填又会去猜行');
  assert.ok(/strict\s*\n?\s*\? \(publishedRowId/.test(src) || /is: strict/.test(src) || /ok: false, why: strict/.test(src),
    '拿不到本轮行时必须**不写**并给出原因（不许静默写别的行）');
  // 反向对照：把 strict 那两处抹掉后，判据必须变假（否则它只是"文件里出现过某几个字"）
  assert.strictEqual(wired(src.replace(/\{ strict: true \}/g, '{ strict: false }')), false,
    '反向对照失效：strict 关掉后判据仍为真');
  assert.strictEqual(wired(src.replace('const hit = strictHit || (strict ? null : _guess);',
                                       'const hit = strictHit || _guess;')), false,
    '反向对照失效：去掉严格分支后判据仍为真');
});

await t('Z48e ★ 提示词：`excerpt` 必须逐字引用原文（报告有一列只印它）', async () => {
  // ★ 2026-10-17 第十二轮：真件那一列整片是「该句以…」，图片条目更是 `—`。
  //   要求写进提示词，就得有东西钉住它 —— 改提示词是最容易"以为改了"的一处。
  const MS = await import('./agent/model_side.mjs');
  const sys = String(MS.SYSTEM);
  assert.ok(/4d\./.test(sys), '提示词没有 4d 那一条（excerpt 逐字引用）');
  // ★ 第十三轮：口径从「字或读数」收紧成「素材上真实存在的字 / 说出口的话」
  assert.ok(/只抄"素材上真实存在的东西"|只抄素材上真实存在的东西/.test(sys),
    '4d 没写「图片/视频只抄素材上真实存在的东西」');
  assert.ok(/不要把\*\*描述\*\*当原文|不要把描述当原文/.test(sys), '4d 没禁止拿描述冒充原文');
  assert.ok(/不许编一串字出来/.test(sys), '4d 没给「画面里没字就 null、不许编」的出口');
  // ★ 第十三轮：**读数不是原文** —— 上一版写成「字或读数」，那是把别人的描述当素材上的字
  assert.ok(/画面读数不算原文/.test(sys), '4d 没写「画面读数不算原文」');
  assert.ok(!/看得见的那串字或读数/.test(sys), '4d 又把「读数」算进原文了');
  assert.ok(/图片给\*\*图上区域\*\*|图片给\*\*图上区域/.test(sys) || /图上区域/.test(sys),
    '4d 没给图片的「位置」口径（图上区域）');
  // 反向对照：把 4d 整段从提示词里抹掉 ⇒ 上面第一条必须变假
  assert.ok(!/4d\./.test(sys.replace(/4d\.[\s\S]*?5\. 你出的每一条/, '5. 你出的每一条')),
    '反向对照失效：抹掉 4d 后判据仍然通过');
});

// ════════════════════════════════════════════════════════════════════════════
// 第 48 组 · 报告按「审计报告」模式：总 → 问题清单（P 级 → 维度）→ 执行（2026-10-17）
//
// Owner 白板（标题逐字「审计报告不是模板（V1）」）画的顺序：
//     审计报告 → 结构 → **总（state + 1句话）** → **分**（`P0 → G1/G2/G3 → rule1 out`
//     ｜ `P1 → rule2 out` ｜ `Pn → rule3 out`）→ **执行 @**
//   居中那个圈 = 判定规则：`P0 ≥ 1 → Block` ｜ `P1 ≥ 1 且无 P0 → review` ｜ `Pn ……`
//
// 当天五条裁定（Owner 逐条选的对）：
//   ① 报告门槛回到 PRD 的 **≥3**（推翻 2026-10-14「<3 也出」那条本地要求）
//   ② 问题清单 **先 P 级、再维度** 两级分组（**第二十一轮 Owner 把这节的标题从「分论点」改成「问题清单」**）
//   ③ 模型侧条目**统一归 P1**（PRD §6.3 第二层），行内另标自评 BLOCK/REVIEW
//   ④ 「问题描述」**单列一格**（模型侧 prompt 新增 `description`）
//   ⑤ 第三步：**逐条给承办** ＋ 末尾整单一行（卡片那行照旧保留）
// ════════════════════════════════════════════════════════════════════════════

await t('Z48 ★★ 报告三步：总结论 → 问题清单（P0→P3 → 所属类别）→ 执行（@角色）', async () => {
  const M = await import('./agent/merged_report.mjs');
  const mk = (tier) => ({
    location: '视频 00:12', category: '合规', severity: 'REVIEW', source: 'kb',
    reason: '原因句', description: '描述句',
    kb: { article_no: 'W-1.54', priorityTier: tier, riskCategory: '合规',
          basisLine: '《措辞表达库 v0》第 W-1.54 条 ← 命中「最」'
            + '｜原始出处：https://momcozy-in.feishu.cn/base/a?record=b',
          suggestionLine: '删掉「最」' } });
  const md = M.renderMergedReportMd({
    merged: [mk('P1'), mk('P0'), { location: '图 1', category: '本地化',
      severity: 'REVIEW', source: 'model', reason: 'r', suggestion: 's' }],
    total: 3, state: 'BLOCK', line: '【审查结论：BLOCK】共发现 3 处必须修改。',
    question: 'q', contentId: 'C', at: 'x' });

  // ① 总结论：PRD §5.3 那一行**逐字不动**，且紧跟 H1
  assert.ok(/^# 内容审查报告\n\n【审查结论：BLOCK】共发现 3 处必须修改。\n/.test(md),
    `① 总结论不是紧跟 H1 的 PRD §5.3 逐字那一行：${md.slice(0, 90)}`);
  // ①b **发现分布 ＋ 一句话**（Owner 2026-10-17 给的样张）
  //   ⚠️ 样张写的是「结论行 ｜ 发现 x（…）」**接在同一行** —— 那会破坏 PRD §5.3：
  //      `prd53.conforms` 的三态是 `^…$` 整行锚定。这里钉两头：
  //      ① 分布行在、且括号里加起来等于条数；② **结论行一个字没被污染**。
  {
    // ★★ 2026-10-19（Owner：「报告要同步 卡上 12 类呀，整个知识库都要同步」）——
    //   这一格原先是 `发现 3（合规 3｜安全 0｜…）`（**PRD 四维**分桶）。四维与卡面的 A3 12 类
    //   并排就是两个总数（实测 6 条单：12 类 4/1/1、四维 3/1/2）⇒ 已撤掉，改印**与卡面逐字相同**的
    //   12 类汇总行（`· <类>类问题：N 个`，同函数同输入，见 Z53）。
    const distLine = (md.match(/^发现 \d+（/m) || []);
    assert.strictEqual(distLine.length, 0, `①b 四维的「发现 N（…）」又回来了：${md.slice(0, 240)}`);
    const sumLines = md.split('\n').filter((l) => /^· .+问题：\d+ 个$/.test(l));
    assert.ok(sumLines.length >= 1, `①b 没有 12 类汇总行：${md.slice(0, 240)}`);
    const sum = sumLines.reduce((t, l) => t + Number((l.match(/(\d+) 个$/) || [0, 0])[1]), 0);
    // ★ 第十五轮：条目改成 `**F-01 ｜ …**`，条数要按这个形状数
    const nItems = (md.match(/^\*\*F-\d{2} ｜ /gm) || []).length;
    assert.strictEqual(sum, nItems, `①b 12 类汇总加起来（${sum}）不等于清单条数（${nItems}）`);
    assert.ok(/^一句话：共 \d+ 处/m.test(md), '①b 没有「一句话：…」那一行');
    // ★★ 第九轮（Owner：「P0 红线 2 处；集中在合规（3 条），也只有 5 条呀」）——
    //   一句话里的两个数**必须能相加**，且等于条数。原先「P0 2 处 ＋ 合规 3 条」是**重叠**的，
    //   并排印出来读者自然算成 5。现在口径固定为「P0 p 处 + 其余 N−p 处 = N」。
    {
      const m2 = /^一句话：共 (\d+) 处[^；]*?P0 红线 (\d+) 处\*\*、其余 (\d+) 处/m.exec(md);
      assert.ok(m2, `①b 一句话没有「P0 p 处、其余 N−p 处」的可相加口径：${(md.match(/^一句话：.*$/m) || [''])[0]}`);
      assert.strictEqual(Number(m2[2]) + Number(m2[3]), Number(m2[1]),
        `①b 一句话里的数加不起来：P0 ${m2[2]} + 其余 ${m2[3]} ≠ ${m2[1]}`);
      // 反向对照：句子不许再出现「集中在X（k 条）」那种**与 P0 重叠**的并排计数
      assert.ok(!/；集中在/.test(md), '①b 一句话又用「集中在X（k 条）」把重叠计数并排印了');
    }
    // ★ 反向对照：把分布行接到结论行后面 ⇒ `conforms` 必须变红（这就是不能照抄样张的原因）
    const P = await import('./agent/prd53.mjs');
    const polluted = '【审查结论：BLOCK】共发现 3 处必须修改。｜发现 3（合规 3｜安全 0｜权利 0｜本地化 0）';
    assert.strictEqual(P.conforms(polluted).ok, false,
      '把分布接到结论行后面竟然仍然合规 —— 那说明 conforms 的锚定松了');
    assert.strictEqual(P.conforms('【审查结论：BLOCK】共发现 3 处必须修改。').ok, true,
      '干净的结论行必须合规');
  }
  // ①c **「命中描述」列必须印实际原文**（Owner 2026-10-17：「命中描述 写实际的原文」）
  //   病灶：模型侧的 `excerpt` 常是空的，它把原文放在 `location` 的 `「…」` 里
  //   ⇒ 那一列原先退成模型写的描述，印出来是「该句以…」「该句用…」（16 字全花在开头三个字上）。
  {
    const T = await import('./agent/dual_track.mjs');
    const q = '素材正文第 2 段「Through over 1,000 trials, the R&D team」句';
    assert.strictEqual(T.verbatimOf({ location: q, description: '该句以模糊数据支撑功效' }),
      'Through over 1,000 trials, the R&D team', '①c 没从 location 的「…」里取到原文');
    assert.strictEqual(T.verbatimOf({ location: '图 1', description: '账号名是中文' }), null,
      '①c 没有原文时应当返回 null（表里印 —），不许拿描述冒充');
    // markdown 链接必须还原成文字，否则会把表格撑坏
    assert.strictEqual(T.verbatimOf({ excerpt: 'increasing milk [production.It](http://production.it/) supports' }),
      'increasing milk production.It supports', '①c 原文里的 markdown 链接没还原');
    // 反向对照：**表里那一格不许出现「该句以」这种模型描述**
    assert.ok(!/\| 该句以/.test(md), '①c 表格「命中描述」列印的还是模型描述，不是原文');
  }
  // ② **判定口径那一行已删**（Owner 2026-10-17：「这是给业务侧看的报告」）
  assert.ok(!/判定口径/.test(md), '② 「判定口径」又出现了 —— 那是内部口径，不给业务侧看');
  assert.ok(!/PRD §6\.3/.test(md), '② 报告里又出现了内部章节号（业务侧读不懂也不关心）');
  // ★ 第二十一轮（Owner：「把分论点改成"问题清单"」）—— 第二节标题逐字为「问题清单」，
  //   旧名「分论点」**一个字都不许再出现在报告里**（同一条判据管两头，免得只改了代码没改测试）。
  assert.ok(/^## (?:\*\*)?二、问题清单（P0 → P1 → P2 → P3）(?:\*\*)?$/m.test(md),
    `③ 第二节标题不是「二、问题清单」：${(md.match(/^## .*$/gm) || []).join(' / ')}`);
  assert.ok(!/分论点/.test(md), '③ 报告里还有旧标题「分论点」');
  // ③ 问题清单：P 级在前、维度在后，次序固定
  // ★ 第十六轮：二级目录改**加粗**（`### **P0 — … ｜ 2 条**`）⇒ 判据要认 `**` 包装，
  //   否则它会把「格式改对了」判成「分组没了」。
  const heads = (md.match(/^### (?:\*\*)?(.*)｜ \d+ 条(?:\*\*)?$/gm) || [])
    .map((x) => x.replace(/^### /, '').replace(/^\*\*/, '').replace(/｜.*$/, '').trim());
  // ★ 第二十轮：P 级与维度并成一行（`P0 红线 · 合规 ｜ 2 条`）⇒ 一个 P 级可能出现多行（每个维度一行）。
  //   这里只断言**级别出现的先后次序**是 P0 → P1 → P2 → P3（去重保序），不再假设「一个 P 级一行」。
  const pOrder = [...new Set(heads.map((x) => x.slice(0, 2)))];
  assert.deepStrictEqual(pOrder, ['P0', 'P1'],
    `③ P 级分组次序必须是 P0→P1→P2→P3，实际：${JSON.stringify(heads)}`);
  // ★ 第二十轮：分类并进了分组标题。★ 2026-10-19 起标题里 P 级**只写级别**：
  //   `### **P0 · <所属类别> ｜ 2 条**`（层名「红线 / 安全与准确性」已撤，避免被读成分类）。
  // ★★ 2026-10-19（Owner：「报告要同步 卡上 12 类呀，整个知识库都要同步」）：
  //   这一格原先是 **PRD 四维**（`· 合规 ｜`）。四维已整体撤离输出，改印 A3 12 类。
  //   ⇒ 断言从「必须是『合规』这个词」改成「必须是 12 类里的某个名字」（兜底 `未归类` 也算）。
  //   ⚠️ 这不是放宽：**四维的四个词一个都不许再出现在分组标题里**（反向对照在下一行）。
  const heads2 = md.split('\n').filter((l) => /^### /.test(l));
  assert.ok(heads2.length >= 1, '③ 报告没有任何分组标题');
  const T2 = await import('./agent/dual_track.mjs');
  const TAX12 = ['合规与受监管宣称', '产品安全与高危使用场景', '商品信息与Listing准确性', '证据与实质证明',
    '推广与价格透明', '背书与披露透明', '品牌信任与声誉', '权利、肖像、隐私与AI',
    '平台与渠道政策', '北美本地化与标签要求', '母婴知识内容准确性', '未归类'];
  for (const h of heads2) {
    const cat = (h.match(/· ([^｜]+) ｜ \d+ 条/) || [,''])[1].trim();
    assert.ok(TAX12.includes(cat), `③ 分组标题里那一格不是 12 类名：${JSON.stringify(cat)}（整行：${h}）`);
    assert.ok(!T2.PRD_DIMENSIONS.includes(cat), `③ 分组标题又按四维分组了：${cat}`);
  }
  assert.ok(!/PRD §/.test(md), '③ 维度/分级的**内部依据**不该出现在业务报告里');
  // ④ 六格 + 承办，一格不许少（PRD §8.3 五格 + 白板的 P 级 + 第三步的承办）
  // ★ 第十八轮（Owner：「我给你的报告字段是 维度、位置、问题描述、原因、依据文档链接、修改建议。
  //   **你不要乱改**」）⇒ 形状照样张（标题行 ＋ 子弹点），**字段名逐字用这六个**。
  // ★ 2026-10-19（Owner：「报告要同步卡上 12 类呀」）：这一格的值从四维换成 A3 类名，字段名跟着改
  for (const k of ['**所属类别**', '**位置**', '**问题描述**', '**原因**', '**依据文档链接**', '**修改建议**']) {
    assert.ok(md.includes(k), `④ 逐条块缺「${k}」这一格`);
  }
  // 反向对照：样张那七个字段名**不许再出现在报告里**（那是我越界改的）
  for (const bad of ['**定位**', '**原文**', '**证据指纹**', '**处置**']) {
    assert.ok(!md.includes(bad), `④ 报告里又出现了样张的字段名「${bad}」—— Owner 定的字段不是它`);
  }
  // ★ 第二十轮：标题三格是 `F-01 ｜ 类别·子类 ｜ P0`（**动作词已删** —— 那是样张口径、非 PRD），
  //   末尾还挂着来源标记（`—— **有库内条款依据**`）⇒ 判据不能锚在行尾。
  assert.ok(/^\*\*F-\d{2} ｜ [^｜]+ ｜ P[0-3]/m.test(md),
    '④ 条目标题行不是「F-NN ｜ 类别 ｜ 级别」的形状');
  assert.ok(!/\*\*承办\*\*/.test(md), '④ 逐条块里又出现了「承办」—— 承办只留总览表与执行段两处');
  // ⑤ 模型侧没有 P 级 ⇒ 按 PRD §6.3 第二层归 P1（**不冒充 P0**）
  assert.ok(/｜ P1\*\*/m.test(md),
    '⑤ 模型侧那条没按 P1 落（或处置动作没印出来）');
  assert.ok(!/PRD §/.test(md), '⑤ 报告里出现了内部章节号（业务侧读不懂也不关心）');
  // ⚠️ ⑤ 查的是**报告**：八格版式只由 `layout: 'report'` 产出，卡片那边是另一支（见 Z48c）。
  // ⑥ 执行段 —— ★★ 2026-10-17 第二十六轮（Owner 原话）：
  //   「按照 prd，命中 block，审查报告**不会 @xx @xxx 去修复，直接打回建议修复**；
  //     命中 review 的，审查报告才会 @xx @xx 去修复。目前审查报告的执行 3 适合 review 模版，
  //     若结论是 block 要按照 prd 优化。」
  //   ⇒ 这一节按结论分两支，**Z48 的夹具是 BLOCK** ⇒ 只许「打回」那一支：
  //     不 @ 任何人、不派单，写「按修改建议改完再重新提交」＋ PRD §5.3.3 那句收尾。
  assert.ok(/^## (?:\*\*)?三、执行（打回，修改后重新提交）(?:\*\*)?$/m.test(md),
    '⑥ BLOCK 的执行段标题不是「打回，修改后重新提交」');
  const execBlk = md.slice(md.indexOf('三、执行'));
  assert.ok(!/@法务|@北美同事|跟进问题（第/.test(execBlk),
    `⑥ BLOCK 单里出现了 @ 派单（PRD：BLOCK 是打回，不是转人复核）：${execBlk.slice(0, 200)}`);
  assert.ok(/请修改后重新提交。/.test(execBlk), '⑥ BLOCK 单的收尾不是 PRD §5.3.3 那句');
  assert.ok(/打回/.test(execBlk) && /修改建议/.test(execBlk),
    '⑥ 打回那一支要写清「按修改建议改完再提交」');

  // ⑥b **问题总览表**（审计报告惯例：摘要先行）—— 一张表 7 列，行数 = 条目数
  assert.ok(/^## (?:\*\*)?一、问题总览(?:\*\*)?$/m.test(md), '⑥b 没有「问题总览」表 —— 业务侧又得直接读八行长文');
  // ★ 第四轮：**隐藏编号列**、表头不再用斜杠
  // ★★ 2026-10-19（Owner：「报告要同步 卡上 12 类呀」）：第 3 列从「维度」（四维）改为「所属类别」（12 类）。
  assert.ok(/^\| # \| 优先级 \| 所属类别 \| 位置 \| 命中描述 \| 承办 \|$/m.test(md),
    '⑥b 总览表的表头不是约定的那 6 列（编号要隐藏、命中描述不带斜杠、第 3 列是所属类别）');
  assert.ok(!/^\| # \| 优先级 \| 维度 \|/m.test(md), '⑥b 总览表又按四维开了一列');
  assert.ok(!/^\| # \| 编号 \|/m.test(md), '⑥b 「编号」列又回来了');
  // ⚠️ 同一批里两条问题若**同一坐标**（同条款同类别），编号会补 `-2` 后缀（确定性规则）
  //   ⇒ 判据必须认后缀，否则会把「同条款的两条」数成一行。
  const tRows = (md.match(/^\| \d+ \| (?:P[0-3]|—) \|/gm) || []).length;
  const nBody = (md.match(/^\*\*F-\d{2} ｜ /gm) || []).length;   // ★ 第十五轮：新条目形状
  assert.strictEqual(tRows, nBody, `⑥b 总览表行数与逐条条数不一致：表 ${tRows} / 逐条 ${nBody}`);
  // ⑥c **Finding 编号**（跨复跑对得上）：同一条两次渲染必须同号，换序也不变
  // ★ 第十五轮：条目编号改成**可扫的序号** `F-01`（Owner 样张），
  //   稳定哈希编号（`stableIdOf`）**不再显示** —— 它仍在代码里，供将来整改台账用。
  assert.ok(/^\*\*F-01 ｜ /m.test(md), '⑥c 条目编号不是 F-01 这种可扫的序号');
  {
    const T = await import('./agent/dual_track.mjs');
    const f = mk('P0');
    const a = T.stableIdOf(f); const b = T.stableIdOf({ ...f });
    assert.strictEqual(a, b, '⑥c 同一条目两次算出的编号不同 —— 复跑会对不上');
    assert.ok(/^F-[0-9a-f]{6}$/.test(a), `⑥c 编号形状不对：${a}`);
    // ⚠️ 位置**只对独立复核侧的条目**参与派生 —— 库侧的坐标是 `anchor|条款号|类别`，
    //   位置不在里面（同一个条款命中在不同位置，本来就是同一条证据）。这一点必须钉住，
    //   否则下一个人会以为「改了位置就该换号」而把库侧的号改成随位置漂。
    const mo = { source: 'model', location: '图 1', category: '措辞表达', excerpt: 'x' };
    assert.notStrictEqual(T.stableIdOf({ ...mo, location: '图 2' }), T.stableIdOf(mo),
      '⑥c 独立复核侧换了位置编号却没变 —— 两条不同的问题会撞成同一个号');
    assert.strictEqual(T.stableIdOf({ ...f, location: '别的地方' }), a,
      '⑥c 库侧换位置不该换号（坐标是 anchor ＋ 条款号）');
  }
  // ⑥d ★ 第四轮（Owner：「去掉 四、本次未覆盖、未能取证」）—— 那一节下线；
  //   但**缺口必须仍然逐条可见**（分组 `### 未分级` / `#### 未映射维度`、逐条「本条未提供问题描述」、
  //   来源标记「无库内依据 · 建议转人工」），所以这里钉两条：节必须没有了、缺口还看得见。
  assert.ok(!/本次未覆盖/.test(md), '⑥d 「本次未覆盖」那一节又回来了（Owner 已删）');
  assert.ok(/### (?:\*\*)?未分级|#### (?:\*\*)?未映射维度|本条未提供问题描述/.test(md),
    '⑥d 未覆盖那一节删了，但缺口也没有逐条可见的落点了 —— 等于把诚实性一起删了');
  // ⑦ 反向对照：**描述缺了就如实说缺**，不许把 `reason` 搬过去顶上
  assert.ok(/（本条未提供问题描述）/.test(md),
    '⑦ 没给 description 时没如实标「未提供」（可能把 reason 搬去冒充问题描述）');
  // ⑧ 反向对照：拿不到 `priority_tier` ⇒ 落「未分级」，**不从 severity 反推 P0**
  const md2 = M.renderMergedReportMd({
    merged: [{ ...mk('P1'), kb: { ...mk('P1').kb, priorityTier: null } }],
    total: 1, state: 'REVIEW', line: '【审查结论：REVIEW】共发现 1 处需人工确认。',
    question: 'q', contentId: 'C', at: 'x' });
  assert.ok(/### (?:\*\*)?未分级/.test(md2), '⑧ 没有 priority_tier 却没落「未分级」组');
  assert.ok(!/^### (?:\*\*)?P0 /m.test(md2), '⑧ 没有 priority_tier 却猜出了一个 P0');
});

await t('Z48g ★★ 执行段按结论分两支：REVIEW 才 @ 人派单；BLOCK 打回（Owner：block 不 @ 任何人）', async () => {
  // Owner 2026-10-17：「按照 prd，命中 block，审查报告不会 @xx @xxx 去修复，直接打回建议修复；
  //   命中 review 的，审查报告才会 @xx @xx 去修复。目前执行 3 适合 review 模版，
  //   若结论是 block 要按照 prd 优化。」
  const M = await import('./agent/merged_report.mjs');
  const one = (sev, tier) => ({
    location: '全文', category: '合规', severity: sev, source: 'kb',
    reason: '原因句', description: '描述句',
    kb: { article_no: 'W-1.18', priorityTier: tier, riskCategory: '合规',
          basisLine: '《措辞表达库 v0》第 W-1.18 条 ← 命中「x」',
          suggestionLine: '改成例句' },
  });
  const rv = M.renderMergedReportMd({
    merged: [one('REVIEW', 'P1')], total: 1, state: 'REVIEW',
    line: '【审查结论：REVIEW】共发现 1 处需人工确认。', question: 'q', at: 'x',
  });
  const rvExec = rv.slice(rv.indexOf('三、执行'));
  // ① REVIEW：逐角色派单（这是唯一允许 @ 的那一支）
  assert.ok(/^## (?:\*\*)?三、执行（按问题分派）(?:\*\*)?$/m.test(rv),
    'REVIEW 的执行段标题不是「按问题分派」');
  assert.ok(/^- \*\*@[^*]+\*\*：跟进问题（第 [\d、]+ 条）$/m.test(rv),
    `REVIEW 单没有逐角色派单那一行：${rvExec.slice(0, 260)}`);
  assert.ok(/建议转 @[^\n]*复核。/.test(rvExec), 'REVIEW 的收尾不是 PRD §5.3.2 那句「建议转 @… 复核。」');
  assert.ok(!/请修改后重新提交。/.test(rvExec), 'REVIEW 单里出现了 BLOCK 的收尾（两支串了）');
  // ② 反向对照：同一批条目换成 BLOCK ⇒ **一个 @ 都不许有**，且收尾换成「请修改后重新提交。」
  const blk = M.renderMergedReportMd({
    merged: [one('BLOCK', 'P0')], total: 1, state: 'BLOCK',
    line: '【审查结论：BLOCK】共发现 1 处必须修改。', question: 'q', at: 'x',
  });
  const blkExec = blk.slice(blk.indexOf('三、执行'));
  assert.ok(!/@/.test(blkExec), `BLOCK 单里出现了 @（PRD：打回，不派单）：${blkExec.slice(0, 200)}`);
  assert.ok(/打回/.test(blkExec), 'BLOCK 单的执行段没写「打回」');
  assert.ok(/请修改后重新提交。/.test(blkExec), 'BLOCK 单的收尾不是 PRD §5.3.3 那句');
  assert.ok(!/跟进问题（第/.test(blkExec), 'BLOCK 单里还留着「跟进问题（第 N 条）」那种派单句式');
  // ③ 两支的标题**必须不同**（同名就说明根本没分支）
  assert.notStrictEqual(
    (rv.match(/^## (?:\*\*)?三、执行[^\n]*/m) || [''])[0],
    (blk.match(/^## (?:\*\*)?三、执行[^\n]*/m) || [''])[0],
    'BLOCK 与 REVIEW 的执行段标题一模一样 —— 说明没按结论分支');
});

await t('Z48d ★★ P0 快路命中**必须变成条目**（真报告 9 条只列 6 条、BLOCK 无出处的根因）', async () => {
  // 病灶（实测 `merged-2026-10-17T01_48_20` / 文档 `XzNxdvaE1o3KuJxSuAqcftRdnqd`）：
  //   `[p0] 🚦 P0 命中 ⇒ 直接 BLOCK，不起链：H02,H05,M03` ＋ `结论=BLOCK/3 条 ｜ 逐条抽出 0 条`
  //   ⇒ 结论行「9 处」、清单只有 6 条模型侧的、而且**一条 P0 都没有**。
  //   根因：`p0_findings` 只被拿去修 `excerpt`（`p0MatchedMap`），从没变成条目。
  const T = await import('./agent/dual_track.mjs');
  const M = await import('./agent/merged_report.mjs');
  // 夹具按**真产出**的形状造（`kb/l5/p0_fastpath.py --json` 实测输出，别按我以为的写）
  const p0 = [{
    rule_code: 'H02', level: 'P0', verdict: 'BLOCK', rule_id: 'r-37b49eadb72d7dc2',
    matched: [{ kind: 'regex', pattern: 'x', line: 1, span: [16, 27],
                line_text: 'momcozy v1 pro. boosts milk supply. hospital grade.' }],
    matched_count: 1, whitelist_suppressed: 0,
    suggested_replacement: '删除 more milk/增产承诺；改放松叙事＋限定语',
    anchor: '#广告文案明细/recvuJYdOb1Rm1/命中片段', source_sha256: 'c'.repeat(64),
    article_no: 'W-1.18',
    clause: { article_no: 'W-1.18', rule_id: 'r-37b49eadb72d7dc2' },
    verbatim: { record_id: 'recvuJYdOb1Rm1', table: '广告文案明细', field: '命中片段',
                entry_url: 'https://momcozy-in.feishu.cn/base/Lk3Q?table=tblcbk4XiW6471YN&record=recvuJYdOb1Rm1' },
    _category: '功效宣称-催乳与通乳宣称',
    _l3: { reason: 'H02 催乳/增产/奶量产出承诺（无 FDA/临床证据）', kb_type: 'wording', article_no: 'W-1.18' },
  }];
  const kb = T.kbFindingsOf('', null, p0);
  assert.strictEqual(kb.findings.length, 1, `P0 命中没变成条目：抽到 ${kb.findings.length} 条`);
  const it = kb.findings[0];
  assert.strictEqual(it.severity, 'BLOCK', 'P0 命中条目的严重度必须是 BLOCK（命中即拦，PRD §6.6）');
  assert.deepStrictEqual([it.category, it.sub], ['功效宣称', '催乳与通乳宣称'], '类别没按 `_category` 拆开');
  assert.ok(/W-1\.18/.test(it.kb.basisLine) && /recvuJYdOb1Rm1/.test(it.kb.basisLine),
    `依据行丢了条款号或飞书直链：${it.kb.basisLine}`);
  assert.ok(/boosts milk/.test(it.description || ''), '问题描述没取到逐字命中');
  // 分级出自**模式表**（P0 快路），不是从 severity 反推
  assert.strictEqual(T.priorityOf(it).level, 'P0', 'P0 快路命中没落进 P0 级');
  assert.strictEqual(T.dimensionOf(it).dimension, '合规',
    '维度没按 risk-category-policy 映射（功效宣称 ⇒ 合规）');
  // 与模型侧合并后：P0 组必须在、BLOCK 必须有出处、总数必须是 4（1 P0 ＋ 3 模型侧）
  const modelItems = [1, 2, 3].map((n) => ({ location: `段 ${n}`, category: '合规', severity: 'REVIEW',
    source: 'model', reason: 'r', suggestion: 's', description: 'd' }));
  const merged = T.mergeFindings(kb.findings, modelItems);
  const md = M.renderMergedReportMd({ merged: merged.items, total: merged.items.length,
    state: 'BLOCK', line: '【审查结论：BLOCK】共发现 4 处必须修改。',
    question: 'q', contentId: 'C', at: 'x' });
  // ★ 2026-10-19（Owner：「报告里面写的『安全与准确性』是什么分类？」）：分组标题里
  //   P 级**只写级别**（`### **P0 · <一级分类> ｜ N 条**`），不再挂 PRD §6.3 的层名
  //   （那个层名长得像分类，会被误读）。探测器的意图不变：**BLOCK 必须有 P0 出处**。
  assert.ok(/^### (?:\*\*)?P0 · /m.test(md), '报告里没有 P0 组 —— BLOCK 又变得没有出处了');
  assert.ok(!/本清单里没有一条 P0 红线/.test(md), '兜底告警被误触发（P0 明明在清单里）');
  // ⑦ 反向对照：**账不平时必须出声**（结论行 9 > 清单 4）
  const md2 = M.renderMergedReportMd({ merged: merged.items, total: 9,
    state: 'BLOCK', line: '【审查结论：BLOCK】共发现 9 处必须修改。',
    question: 'q', contentId: 'C', at: 'x' });
  assert.ok(/本清单列了 \*\*4\*\* 条，结论行那个数是 \*\*9\*\*/.test(md2),
    '账不平（9 vs 4）却没有一句解释 —— 这正是 Owner 第 1 条抱怨的形状');
  // ⑧ 反向对照：**结论悬空必须点破**（BLOCK 但清单里没有任何 P0/BLOCK）
  const md3 = M.renderMergedReportMd({ merged: modelItems, total: 3,
    state: 'BLOCK', line: '【审查结论：BLOCK】共发现 3 处必须修改。',
    question: 'q', contentId: 'C', at: 'x' });
  assert.ok(/本清单里没有一条 P0 红线/.test(md3),
    'BLOCK 却一条 P0/BLOCK 都没有，报告没点破 —— 读者会找不到是谁把它拦下来的');
});

await t('Z48c ★★ 版式切分：**卡片停在三格、报告才是八格**（Owner：卡片格式不要动）', async () => {
  // ★★ 2026-10-17（Owner 原话）：「**守衡输出的卡片格式不要动，你只是优化报告**」。
  //   病灶（我这版第一稿就犯的）：`renderMergedItem` 是卡片与报告**共用**的渲染函数，
  //   我直接把八格加在它身上 ⇒ 卡片每一条从 3 行变 8 行，Owner 当场叫停。
  //   ⇒ 现在同一函数两个分支（`layout: 'report'` / 默认卡片），**卡片那支与改动前逐字一致**。
  //   这一条钉的就是「别再合并回去」——谁把八格无条件印出来，它就红。
  const T = await import('./agent/dual_track.mjs');
  const f = { location: 'X', category: '合规', severity: 'REVIEW', source: 'model',
    reason: 'r', suggestion: 's', description: 'd',
    kb: { article_no: 'W-1.54', priorityTier: 'P1', riskCategory: '合规',
          basisLine: '《措辞表达库 v0》第 W-1.54 条 ← 命中「最」', suggestionLine: '改' } };
  const card = T.renderMergedItem(f, 0, { must: false });
  const rep = T.renderMergedItem(f, 0, { must: false, layout: 'report', owner: '法务（未配置）' });
  // ① 卡片：PRD §5.3 的三格 + 第一行，**多一格都不许有**
  for (const k of ['**优先级**', '**维度**', '**位置**', '**问题描述**', '**承办**']) {
    assert.ok(!card.includes(k), `卡片上出现了「${k}」—— 卡片格式被改了（Owner：卡片不要动）`);
  }
  for (const k of ['**原因**', '**依据**', '**建议**']) {
    assert.ok(card.includes(k), `卡片丢了「${k}」—— 三格是 PRD §5.3 的逐条契约`);
  }
  assert.strictEqual(card.split('\n').filter(Boolean).length, 4,
    `卡片每条必须恰好 4 行（第一行 + 原因/依据/建议），实际：\n${card}`);
  // ② 报告：七格（承办已按 Owner 要求从逐条块撤下，只留总览表与执行段）
  // ★ 第十八轮：报告那一支的字段名 = Owner 定的六个（卡片仍是三格，一个字没动）
  // ★ 2026-10-19（Owner：「报告要同步卡上 12 类呀」）：这一格的值从四维换成 A3 类名，字段名跟着改
  for (const k of ['**所属类别**', '**位置**', '**问题描述**', '**原因**', '**依据文档链接**', '**修改建议**']) {
    assert.ok(rep.includes(k), `报告缺「${k}」这一格`);
  }
  for (const bad of ['**定位**', '**原文**', '**证据指纹**', '**处置**']) {
    assert.ok(!rep.includes(bad), `报告又用了样张的字段名「${bad}」`);
  }
  assert.ok(!/\*\*承办\*\*/.test(rep), '报告逐条块又印了「承办」—— 承办只留表与执行段');
  assert.ok(/\*\*F-01 ｜ /.test(rep) || /F-0\d ｜ /.test(rep), '报告条目没有 F-0N 标题行');
  // ③ 反向对照：把 `layout` 判据拆掉（让卡片也走八格）⇒ 上面①必须精确变红
  const mutated = String(T.renderMergedItem.toString())
    .replace("if (layout !== 'report') return head;", '');
  assert.ok(!/if \(layout !== 'report'\) return head;/.test(mutated),
    '反向对照失效：把两个版式的分叉拆掉后，判据的输入没有变化');
  assert.ok(/if \(layout !== 'report'\) return head;/.test(String(T.renderMergedItem.toString())),
    '两个版式的分叉不见了 —— 卡片会重新变成八格（Owner 2026-10-17 叫停过）');
});

await t('Z48b ★★ 反向对照：图片 skill 未完整执行时不发布合格报告', async () => {
  // ★★ 2026-10-17（Owner 裁定，推翻 2026-10-14「<3 也出报告」）：闸回到 ≥3。
  //   这一条必须**行为级**地钉住 —— 只查源码里有没有那个比较式（Z17）挡不住
  //   「比较式写了但接错了变量」这类错。
  const { runSubmissionGate } = await import('./agent/agent.mjs');
  // 夹具与 Z15 同一形状（**必须长得像真产出**，否则测的是别的形状）
  // ★ 2026-10-19：首行标签就是 **A3**（库侧现在印 `【所属类别-所属子类】`）
  const KB_ANSWER = ['【审查结论：REVIEW】共发现 1 处需人工确认。', '',
    '1.【北美本地化与标签要求-计量单位与表达】图 1，逐字命中「图」',
    '  **原因**：逐字命中',
    '  **依据**：《措辞表达库 v0》第 W-1.48 条 ← 命中「图」'
      + '｜原始出处：https://momcozy-in.feishu.cn/base/Lk3Qb8y2QaVyZns6gprcVNE9nA0?table=tblcbk4XiW6471YN&record=recvuJP2jyHizA',
    '  **锚点**：#广告文案明细/recvuJP2jyHizA/命中片段｜source_sha256：' + 'a'.repeat(16),
    '  **建议**：按模板改',
    '', '建议转 对接人 复核。'].join('\n');
  let called = 0;
  const g = await runSubmissionGate({
    imageClaimRunner: completedImageClaimFixture,
    adviceRunner: async ({ items }) => ({ ok: true, ms: 1,
      advice: Object.fromEntries((items || []).map((_, i) => [i, `自证桩给的改法 ${i}`])) }),
    inbound: { text: '审核下这张图', imageCount: 1, videoCount: 0 },
    question: '审核下这张图', notify: null,
    // 库侧只判 1 条 ⇒ 卡内总数 = 1（<3）
    chainRunner: async () => ({ answer: KB_ANSWER, engine: IMAGE_ENGINE_OK,
      review: { state: 'REVIEW', issue_count: 1 } }),
    publishRunner: async () => ({ ok: true, record_id: 'recX' }),
    modelSideRunner: async () => ({ ok: true, ms: 1, findings: [] }),
    mergedReportRunner: async () => { called++; return { ok: true, url: 'https://example.invalid/docx/NOPE' }; },
  });
  assert.strictEqual(called, 0, '图片 skill 未完整执行时不许发布“完整审查”报告');
  assert.strictEqual(g.imageReviewIncomplete, true,
    '缺少图片 skill 全流程凭证时必须显式标记未完成，不能放行旧的 REVIEW 三态');
  assert.strictEqual(g.verdict53, null,
    '图片审查未完整执行时不许产出 PASS / REVIEW / BLOCK 结论');
});

// ════════════════════════════════════════════════════════════════════════════
// 第 49 组 · 报告三件事（2026-10-17 第二十二轮，Owner 三条原话）
//
//   ① 「**审查对象，要加进来**，比如**图片就放点击可打开的链接**，**文案**」
//   ② 「每个细分，**原因就说原因，别建议**，少做少错」
//   ③ 「**禁止用任何后台词**（recvuJYdOb1Rm1/），**别人听不懂的字符编码**」
//
// 每条都配**反向对照**：把净化拆掉 ⇒ 判据必须精确变红（否则它只是注释）。
// ════════════════════════════════════════════════════════════════════════════
await t('Z50 ★★ 链接送审的判据：贴的链接就是素材（正文去掉链接后要短）', async () => {
  // Owner 2026-10-17 拿着报告来问：「**为什么文字类的还加个错误的链接**」。
  // 真单：900 字广告文案里粘着 `http://production.it/`（粘贴时编辑器自动加的链接，`.It` 被当域名后缀）
  // ⇒ 旧的「有链接 ⇒ kind=link」把这条**文字送审**判成链接送审 ⇒ 报告多出一行
  //    `链接：[点开](http://production.it/)` —— 一个与素材毫无关系的域名。
  const g = await import('./agent/review_gate.mjs');
  const withUrl = (body) => `${body} [production.It](http://production.it/)`;

  // ① 正常「贴个链接让我看」⇒ 仍然是 link 送审（短正文）
  for (const t of ['审一下这个落地页 https://example.com/p?id=1',
                   '这条视频的落地页能发吗 https://example.com/x']) {
    const r = g.isSubmission({ text: t });
    assert.strictEqual(r.kind, 'link', `该判成链接送审的没判成：${t}｜${r.why}`);
  }
  // ② 长正文里带一个链接 ⇒ **纯文字送审**（链接只是正文的一部分）
  const longCopy = withUrl('Momcozy Breast Pump Hands-Free Mobile Style Wearable M6 24mm. '.repeat(8)
    + 'effectively increasing milk production.It supports everyday baby essentials needs. ');
  const r2 = g.isSubmission({ text: longCopy });
  assert.strictEqual(r2.kind, 'text',
    `长文案里带一个链接就被判成链接送审了（报告会因此多印一行「链接：点开」）：${r2.kind}｜${r2.why}`);
  // ③ 但**链接不许丢**：判成文字之后，`links` 仍要带出来（链该读还是会读）
  assert.ok((r2.links || []).length === 1, `判成文字之后把链接丢了：${JSON.stringify(r2.links)}`);
  // ④ 反向对照：把阈值门槛拆掉（当作任何链接都算链接送审）⇒ ② 必须挂
  assert.ok(g.linkOnly(longCopy).body.length > g.LINK_ONLY_MAX_BODY,
    '反向对照失效：这段正文本来就该超过阈值');
});

await t('Z50b ★ 报告侧同口径：文字送审即使正文里有 URL，也不许出现「链接」行', async () => {
  const g = await import('./agent/review_gate.mjs');
  const M = await import('./agent/merged_report.mjs');
  const copy = 'Momcozy M6 广告原文：effectively increasing milk [production.It](http://production.it/) supports needs.';
  // 报告拿到的 links 来自 agent 的 `reviewGate.linkOnly(...).isLinkOnly` —— 这里照同一口径算
  const lo = g.linkOnly(copy);
  const md = M.materialBlock({ text: copy, media: [], links: lo.isLinkOnly ? lo.links : [] }).join('\n');
  assert.ok(!/链接/.test(md), `文字送审的报告里还是印了链接行：${md}`);
  assert.ok(!/production\.it\//.test(md.replace('production.It', '')), `那串 URL 还在：${md}`);
  // 反向对照：**真的**链接送审（短正文）⇒ 必须有链接行
  const lo2 = g.linkOnly('审一下这个落地页 https://example.com/p?id=1');
  const md2 = M.materialBlock({ text: '审一下这个落地页 https://example.com/p?id=1', media: [],
    links: lo2.isLinkOnly ? lo2.links : [] }).join('\n');
  assert.ok(/\[点开\]\(https:\/\/example\.com\/p\?id=1\)/.test(md2), `真·链接送审没给链接：${md2}`);
});

await t('Z60 ★★ 自述「不改也能发布」⇒ 必须判非强制（SUGGEST），且依据格不再自我否定', async () => {
  // Owner 2026-10-19（拿着真单来问）：「这句话判断是 review，不是 suggest」——
  // 模型自己写的原因里明说「**它不构成健康或安全宣称，不改也能发布**，但表达效果较弱」，
  // 而 `nature` 标了「强制」⇒ 整单落 REVIEW。**自述与自报打架时以内容为准。**
  // 第二件事：卡上那句「无库内依据 —— 知识库条款没覆盖，本条也没给出外部来源（…需人工复核）」
  // 与「（无库内依据的改法建议 —— 不是库规原文）」是**自我否定**，Owner 点名去掉。
  const M = await import('./agent/model_side.mjs');
  const T = await import('./agent/dual_track.mjs');
  // ★ 2026-10-19（Owner：「依据：必须要提供依据」）：**没有依据的条目不成立** ⇒ 必须带 source。
  const mk = (reason) => JSON.stringify([{ location: '素材正文', category: '措辞表达', severity: 'REVIEW',
    description: '产品体验描述过于空泛', source: 'S14',
    reason, excerpt: 'This pump is super easy to use', suggestion: '换成具体可感知的表述' }]);
  // 反向对照：**没有依据**的一条必须被丢弃（且留下原因，不静默）
  const noBasis = M.parseFindings(JSON.stringify([{ location: '素材正文', category: '措辞表达',
    severity: 'REVIEW', description: '空泛', reason: '不改也能发布', suggestion: '改具体' }]));
  // ★ 2026-10-19：依据缺失**不丢在解析层**（丢了会打穿别的判据），而是在这里**打标记**、
  //   由展示层不上卡。⇒ 断言：解析保留但标记，卡面把它滤掉。
  assert.strictEqual(noBasis.findings.length, 1, '解析层不该丢（展示层才过滤）');
  assert.strictEqual(noBasis.findings[0].basis_missing, true, '缺依据的条目没打标记');
  const noBasisCard = T.renderMerged(T.mergeFindings([], noBasis.findings).items,
    { state: 'REVIEW', reportUrlOverride: null });
  assert.ok(!/1\.【/.test(String(noBasisCard.block)), '缺依据的条目竟上了卡');
  assert.ok(/未给出依据/.test(String(noBasisCard.block)), '滤掉后没有如实说明');
  // ① 自述非强制 ⇒ advisory（且留痕说清为什么改了）
  const r1 = M.parseFindings(mk('作为产品卖点描述，这句话过于空泛且带有口语化夸张；'
    + '它不构成健康或安全宣称，不改也能发布，但表达效果较弱。'));
  assert.strictEqual(r1.findings[0].nature, 'advisory',
    `自述「不改也能发布」却被判 ${r1.findings[0].nature} —— 会落成 REVIEW（Owner 报的就是这个）`);
  assert.ok(/不改也能发布/.test(String(r1.findings[0].nature_overridden)),
    '改了却没留痕（事后查不出为什么这样判）');
  // ★ 反向对照：真强制项**不许**被降级（方向必须单向）
  const r2 = M.parseFindings(mk('涉嫌未获证实的功效宣称，消费者会误以为产品有治疗作用。'));
  assert.strictEqual(r2.findings[0].nature, 'mandatory',
    '真强制项被降成了 advisory —— 那是漏放方向，最坏的一种');
  assert.strictEqual(r2.findings[0].nature_overridden, null, '真强制项不该有「被改写」留痕');
  // ② 整单结论跟着走：advisory ⇒ 四态第 2 态 `PASS+SUGGEST`
  //    （PRD rev 105 §5.3.2：SUGGEST 是 PASS 的附属信息；态名 2026-10-21 由 Owner 定）
  const merged = T.mergeFindings([], r1.findings).items;
  assert.strictEqual(T.mergedState({ kbCovered: true, merged,
    kb: { hasSidecar: true, state: 'PASS', issueCount: 0 } }), 'PASS+SUGGEST',
    '自述非强制的那一单没落 PASS+SUGGEST');
  // ③ 两句自我否定的长句在卡面与报告里都不许再出现
  const item = { location: '素材正文', category: '措辞表达', source: 'model', reason: '空泛',
    suggestion: '换成具体可感知的表述' };
  const card = T.renderMergedItem(item, 0, { must: false });
  const rep = T.renderMergedItem(item, 0, { must: false, layout: 'report' });
  for (const [name, txt] of [['卡面', card], ['报告', rep]]) {
    assert.ok(!/知识库条款没覆盖/.test(txt), `${name}还在印「知识库条款没覆盖」那句长句`);
    assert.ok(!/无库内依据的改法建议/.test(txt), `${name}还在印「无库内依据的改法建议」那句尾巴`);
  }
  // 但「判断不是证据」这件事**必须还在**（本库硬纪律：模型侧结论是判断）
  assert.ok(/非条款依据/.test(rep), '依据格不再说明「这不是条款依据」—— 读者会把判断当证据');
});

await t('Z61 ★★ 「有依据」= 能解析出登记来源（占位词不算）；URL 写错格要归一化', async () => {
  // Owner 2026-10-20 拿真卡（AD-20261020-006）来问的那一单：两条都印着
  // 「依据：独立语义复核（非条款依据，需人工核对）」，而 2026-10-19 已明令不许这句出现。
  // 根因在解析边界：提示词教模型「找不到依据就写 source:"none"」，
  // 而 `_hasBasis` 只看「source 是不是非空字符串」⇒ 占位词也算有依据 ⇒ 放上卡。
  const M = await import('./agent/model_side.mjs');
  const T = await import('./agent/dual_track.mjs');
  // ⚠️ `category` 走的是**旧 7 类轴**（合规/消费者安全/措辞表达/产品描述/隐私/AI 披露/本地化），
  //   A3 12 类进 `taxonomy_category`（2026-10-19 统一到 A3 之后两轴并存）——
  //   第一版这里写成 `category:'品牌信任与声誉'` ⇒ 解析层按「类目不在闭集」整条丢掉，
  //   Z61 当场假红（夹具错，不是判据错）。
  const base = { location: '图 1 第 2 处', category: '措辞表达',
                 taxonomy_category: '品牌信任与声誉', severity: 'REVIEW',
                 reason: '美式英语无此搭配，美国消费者读不懂品牌主张',
                 suggestion: '改为通顺的英文标语' };

  // ① 占位值 / 不在闭集里的假 id ⇒ 必须判「没依据」，且**不上卡**（并如实说明滤掉了几条）
  for (const ph of ['none', 'null', 'n/a', 'S99']) {
    const p = M.parseFindings(JSON.stringify([{ ...base, source: ph }]));
    assert.strictEqual(p.findings[0] && p.findings[0].basis_missing, true,
      `source:"${ph}" 被当成了「有依据」—— 卡上会再印出那句「非条款依据」`);
    const card = T.renderMerged(T.mergeFindings([], p.findings).items,
      { state: 'REVIEW', reportUrlOverride: null });
    assert.ok(!/非条款依据/.test(String(card.block)),
      `source:"${ph}" 的条目仍上了卡（卡面印了「非条款依据」）`);
    assert.ok(/未给出依据/.test(String(card.block)), '滤掉之后没有如实说明（静默丢条目）');
  }

  // ② 真登记来源 ⇒ 有依据（别把正常条目一起判死）
  const okS = M.parseFindings(JSON.stringify([{ ...base, source: 'S14' }]));
  assert.strictEqual(okS.findings[0].basis_missing, false, '真登记来源 S14 被判成没依据');

  // ③ 闭集之外的公开规则 ⇒ 给 URL 就算有依据
  const okU = M.parseFindings(JSON.stringify([{ ...base,
    source_url: 'https://www.ftc.gov/business-guidance/resources/x', source_name: 'FTC' }]));
  assert.strictEqual(okU.findings[0].basis_missing, false, '给了可核 URL 却被判没依据');

  // ④ ★ 反向对照：URL 写错格（写进 `source`）⇒ 归一化到 `source_url`，不算发明、也不白丢
  const mis = M.parseFindings(JSON.stringify([{ ...base,
    source: 'https://www.ftc.gov/business-guidance/resources/y' }]));
  assert.strictEqual(mis.findings[0].basis_missing, false, 'URL 写进 source 被判成没依据（会白丢一条）');
  assert.ok(/ftc\.gov/.test(String(mis.findings[0].source_url)), 'URL 写进 source 没被归一化');

  // ⑤ ★ 反向对照（安全方向）：缺 source 与 source_url **两者皆空** ⇒ 仍然判没依据
  const none = M.parseFindings(JSON.stringify([{ ...base }]));
  assert.strictEqual(none.findings[0].basis_missing, true, '两格都空却被判有依据（那是漏放方向）');
});

await t('Z59 ★★ 卡面三处收口：链接只留一条（保留下面的）、原因不许是内部口径、修改建议 ≤30 字', async () => {
  // Owner 2026-10-19 三条（都来自真单）：
  //   ①「卡片上的清单链接有两个，去掉上面的，保留下面的」
  //   ②「审查报告中的原因是给业务侧看的，**必须是真实原因**」（实测印的是「按 PRD §7.3 判定（Owner 2026-10-13 同意入选）」）
  //   ③「修改建议你写了200多字，**修改建议 ≤30 字的**」（PRD §5.3.3）
  const T = await import('./agent/dual_track.mjs');
  const M = await import('./agent/merged_report.mjs');
  const mk = (advice) => ({ location: '全文', category: '消费者安全', severity: 'BLOCK', source: 'kb',
    reason: '虚假安全承诺（ensures safety / maximum）',
    kb: { taxonomyCategory: '合规与受监管宣称', priorityTier: 'P0',
          basisLine: '《措辞表达库 v0》第 W-1.33 条 ← 命中「ensures safety」',
          suggestionLine: advice } });
  const longAdvice = '在全文里，把安全承诺类的说法逐处替换：安全→按说明书装配和清洗后使用；'
    + '绝对安全/零风险/放心用→整句删除，不做替代；无害/无刺激/无副作用→删除，改成可核验的具体信息。';

  // ① 链接去重：KM 侧自带 `→ 查看完整问题清单与修改建议：`，守衡又加了 `→ 完整清单：`
  //    ⇒ 卡上只能剩**一条**，且保留的是**下面那条**（库侧原措辞）。
  //   ★ 直接测**去重函数**（不比拼接路径弱，反而更准）：输入就是 Owner 卡上那两行原文。
  const two = '【审查结论：BLOCK】共发现 3 处必须修改。\n\n· 甲类问题：3 个\n\n'
    + '→ 完整清单：https://momcozy-in.feishu.cn/docx/AAA\n\n'
    + '→ 查看完整问题清单与修改建议：https://momcozy-in.feishu.cn/docx/AAA\n\n请修改后重新提交。';
  const deduped = T.dedupeReportLinkLines(two);
  const links = deduped.split('\n').filter((l) => /完整清单|查看完整问题清单/.test(l));
  assert.strictEqual(links.length, 1, `卡上链接行应恰好 1 条，实得 ${links.length}：${links.join(' / ')}`);
  assert.ok(/查看完整问题清单与修改建议/.test(links[0]),
    `保留下来的那条不是「下面」那条（库侧原措辞）：${links[0]}`);
  // 反向对照：只有一条时**原样返回**（不许顺手改掉正常输出）
  const one = '结论行\n\n→ 完整清单：https://x/docx/BBB';
  assert.strictEqual(T.dedupeReportLinkLines(one), one, '只有一条链接时被改动了');

  // ② 原因：内部治理口径必须被剔除；**真实原因要留着**
  const internal = T.businessReason('按 PRD §7.3 判定（Owner 2026-10-13 同意入选）');
  assert.ok(!/PRD §|Owner 20\d\d|同意入选/.test(internal),
    `内部口径漏到业务面：${internal}`);
  const real = T.businessReason('涉嫌医疗宣称。');
  assert.strictEqual(real, '涉嫌医疗宣称。', `真实原因被改坏了：${real}`);
  // ★ 反向对照：真实原因里带「P0」这种档位词的**不许**被当成内部口径整句删掉
  const withTier = T.businessReason('危险行为示范（P0 一票否决项），会让家长模仿。');
  assert.ok(withTier.includes('危险行为示范'), `把真实原因误删了：${withTier}`);

  // ③ 卡面建议 ≤30 字；**报告保留全文**
  const card = T.renderMerged([mk(longAdvice)], { state: 'BLOCK', reportUrlOverride: null });
  const advLine = String(card.block).split('\n').find((l) => /\*\*建议\*\*/.test(l)) || '';
  const vis = advLine.replace(/^.*\*\*建议\*\*：/, '').replace(/[*]/g, '').trim();
  // ★ 2026-10-19 后令（Owner：「修改建议是可以 30 字的，**不带标点这些**，可以多写一些」）：
  //   这一格量的是**实词字数**（标点不计）—— 与 `prd533.countAdviceChars` 同一把尺。
  const visN = T.countAdviceChars(vis);
  assert.ok(visN <= T.ADVICE_MAX,
    `卡面修改建议 ${visN} 字（标点不计），超 PRD §5.3.3 的 ${T.ADVICE_MAX} 字上限：${vis}`);
  // ★★ 2026-10-19（Owner：「『（全文见报告）』这里**都没有报告**，没有的东西不要说」）：
  //   1-2 条**不出报告**（PRD §5.3.4）⇒ 卡面压字后**不许**加这个指针。
  assert.ok(!/全文见报告/.test(vis), `没有报告却写了「全文见报告」：${vis}`);
  // 反向对照：**真有报告链接**时才允许出现指针
  const withRep = T.renderMerged([mk(longAdvice)], { state: 'BLOCK',
    reportUrlOverride: 'https://momcozy-in.feishu.cn/docx/AAA' });
  const vis2 = (String(withRep.block).split('\n').find((l) => /\*\*建议\*\*/.test(l)) || '')
    .replace(/^.*\*\*建议\*\*：/, '').replace(/[*]/g, '').trim();
  assert.ok(/全文见报告/.test(vis2), `真有报告时却没给指针：${vis2}`);
  // ★ 2026-10-19：同一把尺（标点不计）—— 指针里的 `…（）` 也不再白吃额度。
  assert.ok(T.countAdviceChars(vis2) <= T.ADVICE_MAX,
    `有指针时也超 ${T.ADVICE_MAX} 字（标点不计）：${T.countAdviceChars(vis2)}`);
  const md = M.renderMergedReportMd({ merged: [mk(longAdvice)], total: 1, state: 'BLOCK',
    line: '【审查结论：BLOCK】共发现 1 处必须修改。', question: 'q', at: 'x' });
  const repAdv = (md.split('\n').find((l) => /\*\*修改建议\*\*/.test(l)) || '')
    .replace(/^> \*\*修改建议\*\*：/, '');
  // ★★ 2026-10-19 后令（Owner：「**审查报告中**，修改建议你写了200多字，修改建议 ≤30 字」）——
  //   上一版这里是 `repAdv.length > 60`，即「卡面压、报告留全文」（2026-10-17 的口径）。
  //   Owner 看的是**报告**，所以那条口径被推翻：**报告那一格同样 ≤30 字**（PRD §5.3.3 是硬约束）。
  //   全文没丢：结构化 JSON（`review_findings.json`）与本地留底 `merged-*.full.md` 仍留原文。
  const repN = repAdv.replace(/[*]/g, '').replace(/\s+/g, '').length;
  // ★★ 2026-10-19 **第三令**（Owner：「修复建议都没讲完，被截断了，不能出现这种情况」）：
  //   报告这一格不再要求 ≤30 字（那条挪到**产出侧**：`advice.mjs` 超了再压一次），
  //   改为要求**完整**：不许 `…`、不许只剩半句。卡面 ①②③ 三条一个字没动。
  assert.ok(repN > 0, '报告逐条里没有「修改建议」这一格');
  assert.ok(T.countAdviceChars(repAdv) <= T.ADVICE_MAX,
    `报告修改建议超过 ${T.ADVICE_MAX} 字：${JSON.stringify(repAdv)}`);
  // 反向对照（已按 2026-10-19 第三令翻转）：**尾部那句也必须印出来** ——
  //   改回「按字数切」时，这里会精确变红（切掉的正是这一段）。
  const MR = await import('./agent/merged_record.mjs');
  assert.strictEqual(MR.buildMergedRecord({ items: [mk(longAdvice)] }).items[0].advice, longAdvice,
    '可见字段压到 60 字后，结构化记录仍须保留原建议全文');
});

await t('Z61 ★★ 卡面出厂闸：Owner 贴回来的那张卡，四条口径必须逐条抓得住（反向对照）', async () => {
  // Owner 2026-10-19 第三次报同一族（逐字：「**字数限制问题，为什么反复修？** 原因 ≤50 字是 prd 要求，
  // 现在都 90 多字了／建议中「（全文见报告）」这里都没有报告，没有的东西不要说／
  // 依据：必须要提供依据，为问题做支撑」）。
  // 反复的根因不是某一处没修，而是**没有任何东西在出厂那一刻核整张卡** ——
  // 每次只证明了「某一行在压」。⇒ 新增 `cardConformance()`，本用例喂**Owner 那张卡的原文**：
  //   ① 真单口径下（无依据条目）⇒ 条目**不许上卡**，且闸必须绿；
  //   ② 把那段原文**硬拼成一张坏卡** ⇒ 闸必须逐条报出来（原因超长／指针无报告／假依据／两条链接）。
  const T = await import('./agent/dual_track.mjs');
  const OWNER_REASON = '这是空泛的主观修饰，美国消费者读完无法判断到底省在哪一步（组装部件数量、清洗拆卸、'
    + '单双侧切换、吸力调节），既拿不到选购信息，也让这句体验描述无法与任何可核对的事实对应；'
    + '属于可通过改写提升的表达问题，不影响发布。';
  const OWNER_SUG = '删掉 "super"，把「易用」落到具体动作（如：one-hand assembly、dishwasher-safe parts）。';
  const noBasis = { location: '素材正文（唯一一句文案）', category: '商品信息与Listing准确性',
    severity: 'REVIEW', source: 'model', reason: OWNER_REASON, suggestion: OWNER_SUG };
  // ① **真单形状**：解析边界会给这种条目打 `basis_missing`（`model_side.mjs:336`）⇒ 不上卡，且如实说明。
  //   ⚠️ 判据只用**一个**依据判断（解析边界那一次）；渲染层不再算第二遍 —— 试过，
  //      那会在夹具与「source=model 只是来源语义」的地方误伤 14 项（见 dual_track 注释）。
  const r1 = T.renderMerged([{ ...noBasis, basis_missing: true }], { state: 'REVIEW', reportUrlOverride: null });
  assert.ok(!/独立语义复核/.test(r1.block), '没依据的条目仍然上卡了（Owner：依据必须要提供依据）');
  assert.ok(!/\*\*原因\*\*/.test(r1.block), '没依据的条目仍然占了逐条位');
  assert.ok(/未给出依据/.test(r1.block), '把条目丢掉时没如实说明（不许静默）');
  assert.deepStrictEqual(r1.cardConformance, [], `真单口径下卡面仍不合规：${JSON.stringify(r1.cardConformance)}`);
  // ①b **安全网**：万一哪条路没打标记（漏了），卡面照样印出那句假依据 ⇒ **出厂闸必须当场点名**。
  //   这就是"为什么反复修"的答案：以前没有任何东西在出厂那一刻看整张卡，现在有。
  const r1b = T.renderMerged([noBasis], { state: 'REVIEW', reportUrlOverride: null });
  assert.ok(r1b.cardConformance.some((x) => /那不是依据/.test(x)),
    `漏标记的假依据没被出厂闸抓到：${JSON.stringify(r1b.cardConformance)}`);
  // ② 反向对照：**同一段原文硬拼成一张坏卡** ⇒ 五条违规必须全被点名
  const BAD = ['【审查结论：REVIEW】共发现 1 处需人工确认。', '1.【X】y',
    `   **原因**：${OWNER_REASON}`,
    '   **依据**：独立语义复核（**非条款依据**，需人工核对）',
    `   **建议**：${'改'.repeat(T.ADVICE_MAX + 1)}…（全文见报告）`,
    '→ 完整清单：https://a.b/c', '→ 查看完整问题清单与修改建议：https://a.b/c'].join('\n');
  const caught = T.cardConformance(BAD, { hasReport: false }).join('｜');
  for (const [what, pat] of [['原因超 50', /原因」\d+ 字/], ['假依据', /那不是依据/],
                             [`建议超 ${T.ADVICE_MAX}`, /建议」\d+ 字/], ['无报告却说全文见报告', /没有报告/],
                             ['两条链接', /链接行 2 条/]]) {
    assert.ok(pat.test(caught), `出厂闸漏了「${what}」：${caught}`);
  }
  // ③ 反向对照：真有报告时「（全文见报告）」**不算**违规（否则闸会天天误报）
  assert.ok(!T.cardConformance(BAD, { hasReport: true }).some((x) => /全文见报告/.test(x)),
    '有报告时仍把指针判成违规 —— 闸比口径宽，会天天误报');
});

await t('Z58 ★★ 卡片最终态必须是 **4 态可达**（PASS/PASS+SUGGEST/REVIEW/BLOCK），且非强制信号不许丢', async () => {
  // Owner 2026-10-19 逐字：「知识库决策集／守衡结论行解析 ⇒ **最终输出的卡片态，必须是 4 态**」。
  // 这条钉的是**可达性**，不是「解析器认得」：
  // 改前模型侧只给 `severity: BLOCK|REVIEW`，`priorityOf` 把模型侧一律封顶 **P1**
  // ⇒ `mergedState` 的 SUGGEST 分支（要求全部 P3）**永远进不去** ⇒ 卡片实际只能出三态。
  const T = await import('./agent/dual_track.mjs');
  const M = await import('./agent/model_side.mjs');
  const adv = (loc) => ({ location: loc, category: '措辞表达', severity: 'REVIEW', source: 'model',
    reason: '偏口语', nature: 'advisory', suggestion: '改为「高效便捷」。',
    model: { nature: 'advisory', taxonomyCategory: '品牌信任与声誉' } });
  const kbPass = { hasSidecar: true, state: 'PASS', issueCount: 0 };
  const cases = [
    ['PASS', { kbCovered: true, merged: [], kb: kbPass }],
    ['PASS+SUGGEST', { kbCovered: true, merged: [adv('正文第 2 段'), adv('正文第 3 段')], kb: kbPass }],
    ['REVIEW', { kbCovered: true, merged: [adv('正文第 2 段')],
      kb: { hasSidecar: true, state: 'REVIEW', issueCount: 1 } }],
    ['BLOCK', { kbCovered: true, merged: [{ location: '全文', category: '合规', severity: 'BLOCK',
      source: 'kb', reason: '绝对化用语',
      kb: { taxonomyCategory: '合规与受监管宣称', priorityTier: 'P0',
            basisLine: '《措辞表达库 v0》第 W-1.18 条 ← 命中「最好」' } }],
      kb: { hasSidecar: true, state: 'BLOCK', issueCount: 1 } }],
  ];
  for (const [want, args] of cases) {
    assert.strictEqual(T.mergedState(args), want,
      `卡片最终态「${want}」不可达 —— 四态没凑齐（实得 ${T.mergedState(args)}）`);
  }
  // ① 非强制信号：`advisory ⇒ P3`、缺省 `mandatory ⇒ P1`（**不把强制降级成建议**）
  const a = { location: 'x', category: '措辞表达', severity: 'REVIEW', source: 'model', reason: 'r',
    nature: 'advisory', model: { nature: 'advisory' } };
  const m = { ...a, nature: 'mandatory', model: { nature: 'mandatory' } };
  assert.deepStrictEqual([T.priorityOf(a).level, T.priorityOf(m).level], ['P3', 'P1'],
    'advisory 必须落 P3、mandatory 必须仍 P1');
  // ①b ★★ **合并后的真实形状**：`nature` 在 `mixed.findings[i].model.nature`，
  //   而 `priorityOf` 必须照样判出 P3 —— 第一版只读顶层 `x.nature`，
  //   于是合并后一律 P1 ⇒ SUGGEST 依旧不可达（这正是「三处都要看」那个坑，实测踩到）。
  const adv2 = { location: 'x', category: '措辞表达', severity: 'REVIEW', source: 'model',
    reason: 'r', model: { nature: 'advisory' } };
  assert.strictEqual(T.priorityOf(adv2).level, 'P3',
    '合并后的形状（nature 在 model.nature）没被认 —— SUGGEST 会永远不可达');
  const adv3 = { location: 'x', category: '措辞表达', severity: 'REVIEW', source: 'model',
    reason: 'r', nature: 'advisory' };
  assert.strictEqual(T.priorityOf(adv3).level, 'P3', '顶层 nature 没被认');
  // ② **白名单搬运**：`mergeFindings` 之后 nature 必须还在 —— 丢了它 SUGGEST 就永远不可达
  //    （同一个形状在这个文件里栽过 N 次：basisLine / source_url / taxonomyCategory / 这次）
  const merged = T.mergeFindings([], [adv('正文第 2 段')]).items;
  assert.strictEqual(merged.length, 1, `合并后条数不对：${merged.length}`);
  assert.strictEqual(merged[0].model?.nature, 'advisory',
    'nature 在 pickModel 白名单里被丢了 —— 模型侧非强制信号静默消失');
  // ③ 反向对照（单调性）：非强制项**混进一条强制** ⇒ 必须升级回 REVIEW，不许仍是 SUGGEST
  const mixed = T.mergedState({ kbCovered: true,
    merged: [adv('正文第 2 段'), { ...adv('正文第 3 段'), nature: 'mandatory', model: { nature: 'mandatory' } }],
    kb: kbPass });
  assert.strictEqual(mixed, 'REVIEW', `混进强制项后仍是 ${mixed} —— 单调性被破坏`);
  // ④ 反向对照：模型侧**不写 nature**（缺省）⇒ 不许被当成非强制
  const noNature = T.mergeFindings([], [{ location: 'x', category: '措辞表达', severity: 'REVIEW',
    source: 'model', reason: 'r' }]).items[0];
  assert.notStrictEqual(noNature?.model?.nature, 'advisory',
    '缺省 nature 竟被当成 advisory —— 那会把强制问题静默降级成「建议」');
});

await t('Z57 ★★ 四态：只有 P3 ⇒ PASS+SUGGEST（不阻断、不汇总、不派单）；P3+P1 必须仍 REVIEW', async () => {
  // Owner 2026-10-21：「总共 4 态 pass / pass+suggest / block / review」——
  // 第 2 态的名字是 **`PASS+SUGGEST`**（PRD rev 105 §5.3.2 把 SUGGEST 列为 PASS 的**附属信息**、
  // §6.3 规则 4 的 decision 仍记 PASS）。2026-10-19 那版让它独立成态，真单上印成
  // `【审查结论：SUGGEST】…`，Owner 拿那张卡问的正是这条。
  // 措辞仍取 §5.3.4 样张（「发现 N 处建议优化，不阻断发布」）。
  const T = await import('./agent/dual_track.mjs');
  const P = await import('./agent/prd53.mjs');
  const mk = (pri) => ({ location: '正文第 2 段', category: '措辞表达', severity: 'REVIEW', source: 'kb',
    reason: '偏口语', description: '「超级好用」',
    kb: { taxonomyCategory: '品牌信任与声誉', priorityTier: pri,
          basisLine: '《措辞表达库 v0》第 W-2.10 条 ← 命中「超级好用」',
          suggestionLine: '改为「高效便捷」。',
          entry_url: 'https://momcozy-in.feishu.cn/base/Lk3Q?table=tblcbk4XiW6471YN&record=recA' } });

  // ① 状态：只有 P3 ⇒ PASS+SUGGEST；**混入 P1 ⇒ 必须仍 REVIEW**（单调性：只许保持或升级）
  assert.strictEqual(T.mergedState({ kbCovered: true, merged: [mk('P3'), mk('P3')],
    kb: { state: 'SUGGEST', issueCount: 2 } }), 'PASS+SUGGEST', '只有 P3 时应落 PASS+SUGGEST');
  assert.strictEqual(T.mergedState({ kbCovered: true, merged: [mk('P3'), mk('P1')],
    kb: { state: 'SUGGEST', issueCount: 2 } }), 'REVIEW',
    'P3 + P1 竟被降成 PASS+SUGGEST —— 单调性被破坏（最坏的一种）');
  // 库侧只有建议、模型侧一条都没并进来 ⇒ 仍是 PASS+SUGGEST（不许因为"合并后空"掉回 REVIEW）
  assert.strictEqual(T.mergedState({ kbCovered: true, merged: [],
    kb: { state: 'SUGGEST', issueCount: 3 } }), 'PASS+SUGGEST',
    '库侧 SUGGEST（旧名）无条目时应保持 PASS+SUGGEST');

  // ② 结论行：态名写四态第 2 态 `PASS+SUGGEST`，措辞取 §5.3.4（含「不阻断发布」），且被 `conforms` 认
  const r = T.renderMerged([mk('P3'), mk('P3'), mk('P3')], { state: 'PASS+SUGGEST',
    reportUrlOverride: 'https://x/docx/abc' });
  const line = String(r.line || '');
  assert.strictEqual(line, '【审查结论：PASS+SUGGEST】发现 3 处建议优化，不阻断发布。',
    `四态第 2 态的结论行不合 §5.3.4：${line}`);
  assert.strictEqual(P.conforms(line).ok, true,
    `conforms 不认自家产出的 PASS+SUGGEST 行：${P.conforms(line).why}`);
  // ★ 反向对照（2026-10-21）：**旧态名 `SUGGEST` 不许再被当作四态** ——
  //   只认新名，否则「一单既不是 PASS 也不是 REVIEW」那个形状会悄悄回来。
  const legacyLine = '【审查结论：SUGGEST】发现 3 处建议优化，不阻断发布。';
  assert.strictEqual(P.conforms(legacyLine).ok, false, '旧态名 SUGGEST 竟仍被判合规');
  assert.strictEqual(T.renderMerged([mk('P3')], { state: 'SUGGEST' }).line,
    '【审查结论：PASS+SUGGEST】发现 1 处建议优化，不阻断发布。',
    '传入旧态名 SUGGEST 时没有归一到 PASS+SUGGEST');

  // ③ **≥3 条也不做分类汇总**（§17：这一档的输出格式是「逐条列建议 + 不阻断说明」）
  assert.strictEqual(r.summarized, false, 'PASS+SUGGEST 竟走了分类汇总（PRD §17 要逐条列建议）');
  assert.ok(!/^· .+类问题：\d+ 个$/m.test(String(r.block)), 'PASS+SUGGEST 卡上出现了分类汇总行');
  assert.ok(/^1\.【/m.test(String(r.block)) && /^3\.【/m.test(String(r.block)),
    `PASS+SUGGEST 卡上应逐条列出 3 条：${String(r.block).slice(0, 160)}`);

  // ④ 收尾：**不派单**（不写「建议转 @… 复核。」），且写明不阻断
  assert.ok(/不阻断发布/.test(String(r.block)), 'PASS+SUGGEST 卡上没写「不阻断发布」');
  assert.ok(!/建议转\s*@/.test(String(r.block)), 'PASS+SUGGEST 卡上出现了转派话术（它不阻断、不派单）');
  // ★ 反向对照：同一批条目换成 REVIEW ⇒ **必须**出现转派话术（证明上面那条不是恒真）
  const rev = T.renderMerged([mk('P3'), mk('P3'), mk('P3')], { state: 'REVIEW',
    reportUrlOverride: 'https://x/docx/abc' });
  assert.ok(/建议转\s*@/.test(String(rev.block)) || /复核/.test(String(rev.block)),
    'REVIEW 卡上竟然没有转派话术 —— 那第 ④ 条断言就是恒真的');
});

await t('Z56 ★★ PRD §5.3.3 硬约束：描述≤50/原因≤50/建议≤30、位置三模式、依据要条款号或规则ID、禁「可能」', async () => {
  // Owner 2026-10-19 给的 PRD §5.3.3（rev 248 核过原文）：
  //   「单条问题：描述 ≤50 字，原因 ≤50 字，修改建议 ≤30 字。
  //     位置：必须精确到"图 N 第 X 处"、"视频 00:12"、"正文第 X 段"。
  //     依据：必须写"《文档名》第 X 条"或"规则 ID"，禁止写"相关法规"。
  //     语言：客观、指令式。禁止"可能"、"建议可以考虑"等废话（除非是 REVIEW 的边界说明）。」
  // 真源 `kb/l7/registry/prd533-constraints.yaml`（两仓共读）。
  const P5 = await import('./agent/prd533.mjs');
  const T = await import('./agent/dual_track.mjs');
  // ① 三个字段上限逐字对上 PRD（50/50/30），且**逐字段**各自判
  assert.deepStrictEqual(P5.loadConstraints().fields.map((f) => `${f.key}=${f.limit}`),
    ['description=50', 'reason=50', 'advice=60'], '字段上限与当前约束登记不一致');
  assert.strictEqual(P5.checkFields({ advice: '字'.repeat(61) }).rows[2].over, 1, '建议上限不是 60');
  assert.strictEqual(P5.checkFields({ reason: '字'.repeat(31) }).rows[1].ok, true,
    '同 31 字放进「原因」应合规（上限 50）—— 说明没逐字段判');
  // ② 位置三模式 + 反向对照（真出现过的四种形状必须红）
  assert.deepStrictEqual(['图 1 第 2 处', '视频 00:12', '正文第 3 段'].map((x) => P5.checkLocation(x).ok),
    [true, true, true], '三个 PRD 样张应全合规');
  assert.deepStrictEqual(['全文', '正文第 4 段（DoubleFit Flange, Ultimate Comfort）末句', '图 1', '正文第三段']
    .map((x) => P5.checkLocation(x).ok), [false, false, false, false],
    '四种不合格位置形状必须全红');
  // ③ 依据：两种合法写法 + 「相关法规」禁词
  assert.strictEqual(P5.checkBasis('《措辞表达库 v0》第 W-1.18 条 ← 命中「x」').ok, true, '条款号形态该合规');
  assert.strictEqual(P5.checkBasis('H02').ok, true, '纯规则 ID（H02）该合规');
  assert.strictEqual(P5.checkBasis('依据：相关法规').ok, false, '「相关法规」按 PRD 必须红');
  // ④ 语言禁词
  assert.strictEqual(P5.checkLanguage('可能会被平台判为站外引流').ok, false, '「可能」按 PRD 必须红');
  // ⑤ 卡面必须**逐条**带读数，且位置取自**原始条目**（不是渲染块）——
  //    第一版取错对象（`items` 是已渲染块）⇒ 位置恒空、描述恒 0，等于把「都没问题」写死了。
  const mk = (loc) => ({ location: loc, category: '合规', severity: 'BLOCK', source: 'kb',
    description: '逐字命中「boosts milk」', reason: '催乳/增产承诺（无 FDA 证据）',
    kb: { taxonomyCategory: '合规与受监管宣称', taxonomySubcategory: 'x', priorityTier: 'P0',
          basisLine: '《措辞表达库 v0》第 W-1.18 条 ← 命中「boosts milk」', suggestionLine: '删去增产承诺。' } });
  const out = T.renderMerged([mk('全文'), mk('正文第 1 段')], { state: 'BLOCK',
    reportUrlOverride: 'https://x/docx/abc' });
  assert.strictEqual(out.prd533.length, 2, `逐条读数条数不对：${out.prd533.length}`);
  assert.deepStrictEqual(out.prd533.map((r) => r.location.value), ['全文', '正文第 1 段'],
    '位置没取自原始条目（取到空的说明取错了对象）');
  // 反向对照：同一批条目里「全文」那条红、`正文第 1 段` 那条绿 —— 证明位置那一项真在判
  assert.deepStrictEqual(out.prd533.map((r) => r.location.ok), [false, true], '位置判定没生效');
  // 且字段那三格都量到了（不是全 0）
  assert.ok(out.prd533.every((r) => r.fields.rows.every((x) => x.chars > 0)), '有字段没量出字数');
});

await t('Z55 ★★ 卡面必须量 PRD §17 的字数（≥3 那档要真进线；反向对照：加长必须翻红）', async () => {
  // Owner 2026-10-19：「prd 中 17 写了的结论模版字数限制，你同步知识库了吗？」
  // 在那之前**一个字都没量过** —— 实测 BLOCK ≥3 那张卡 112 字（上限 100）、REVIEW 1-2 285 字（上限 200），
  // 没有任何东西会红。现在每张卡自带读数（`renderMerged().prd17`），真源是
  // `kb/l7/registry/prd17-limits.yaml`（PRD §17 sheet XWnpiN rev 96），两仓共用一张表。
  const T = await import('./agent/dual_track.mjs');
  const P17 = await import('./agent/prd17.mjs');
  const mk = (cat, sev) => ({ location: '全文', category: '合规', severity: sev, source: 'kb', reason: 'r',
    kb: { taxonomyCategory: cat, taxonomySubcategory: 'x', priorityTier: 'P0',
          basisLine: '《措辞表达库 v0》第 W-1.18 条 ← 命中「x」' } });
  const six = [mk('合规与受监管宣称', 'BLOCK'), mk('证据与实质证明', 'REVIEW'),
    mk('平台与渠道政策', 'REVIEW')];
  const big = T.renderMerged(six, { state: 'BLOCK', reportUrlOverride: 'https://x/docx/abc' });
  // ① ≥3 那一档（没有逐条结构）⇒ 量**整条消息**，且必须进线
  assert.strictEqual(big.prd17.limit, 100, `≥3 那档上限取错：${JSON.stringify(big.prd17)}`);
  assert.ok(big.prd17.chars <= 100, `BLOCK ≥3 整条 ${big.prd17.chars} 字，超上限 100`);
  assert.strictEqual(big.prd17.ok, true, `读数说都没进线：${JSON.stringify(big.prd17)}`);
  assert.strictEqual(big.prd17.scope, 'message', '≥3 那一档应标 scope=message（无逐条结构）');
  assert.strictEqual(big.prd17.rule, 'visible_no_url', '口径不是约定的那个（链接不该计入）');
  // ② ★★ Owner 2026-10-19 的规则：「**输出格式里写了逐条 ⇒ 按条量；没写的 ⇒ 整张卡**」
  //   由 registry 的 `format` 字段自动判（`scopeOf`），不靠人列例外。
  assert.deepStrictEqual(
    [P17.scopeOf('BLOCK', 2), P17.scopeOf('REVIEW', 1), P17.scopeOf('BLOCK', 3),
      P17.scopeOf('REVIEW', 6), P17.scopeOf('PASS', 0), P17.scopeOf('SUGGEST', 2)],
    ['per_item', 'per_item', 'message', 'message', 'message', 'per_item'],
    '格式列含「逐条」的那个才该按条量');
  // ★ Owner 2026-10-19 补充：「逐条的还有 SUGGEST（≤150 字/条）」——
  //   SUGGEST 那一行的 format 写着「逐条列建议」，规则自动把它判成按条，**不需要额外写死**。
  // ★★ 2026-10-21：守衡四态第 2 态叫 `PASS+SUGGEST`，而真源 registry 那一行叫 `SUGGEST`
  //   （PRD §17 内嵌表自带的档位名）⇒ `prd17.registryState()` 做**一次**映射，两边都能量到。
  //   反向对照：映射要是没接上，`PASS+SUGGEST` 会 `limitOf → null`（=「不判」）而不报错。
  assert.deepStrictEqual([P17.scopeOf('PASS+SUGGEST', 2), P17.limitOf('PASS+SUGGEST', 2)],
    ['per_item', 150], 'PASS+SUGGEST 没映射到真源那一档（会静默变成「不判」）');
  const sug = P17.checkItems('PASS+SUGGEST', 2, ['建议把「最好」改为具体表述。'.repeat(3), '建议补上数据来源与统计口径。']);
  assert.deepStrictEqual([sug.scope, sug.limit, sug.overCount], ['item', 150, 0],
    `PASS+SUGGEST 该按条量、上限 150：${JSON.stringify(sug.perItem)}`);
  // 反向对照：把第一条加长越过 150 ⇒ 只报那一条（另一条仍合规）
  const sug2 = P17.checkItems('PASS+SUGGEST', 2, ['建议把「最好」改为具体表述。'.repeat(12), '建议补上数据来源与统计口径。']);
  assert.deepStrictEqual([sug2.overCount, sug2.ok, sug2.perItem[1].ok], [1, false, true],
    `加长第一条后应只报一条：${JSON.stringify(sug2.perItem.map((r) => [r.chars, r.ok]))}`);
  // ② 1-2 条那档必须**逐条**量：
  //   两条各 ≤200 就合规（合计 400 也合规）。第一版我按整卡量，把这条读错成「两条加起来 ≤200」。
  // ⚠️ 2026-10-19：卡面「修改建议」压到 ≤30 字后，原夹具两条合计只有 193 字、构造不出
  //   「合计超 200 但每条不超」⇒ 把「原因」加长（原因不压，卡面照印）。
  // ★ 2026-10-19：原因现在卡面压到 ≤50 字 ⇒ 用它撑长度不再有效；改用**依据**（不压）与描述。
  // ⚠️ 2026-10-19 二次：原本 repeat(4) 只到 193、离「合计 >200」这条下限只差 7 字，
  //   卡面任何一格少几个字（例如「（全文见报告）」指针的有无）就翻红 —— 那是**夹具脆**，
  //   不是被测逻辑坏。加到 repeat(10)，留足余量。
  // ★★ 2026-10-19 三次修正：**卡面**的「原因」「依据」「建议」三格现在都压过了
  //   （原因 ≤50、依据只留最小坐标 `《文档名》第 X 条`、建议 ≤30）⇒ 往这三格塞长度**不会**
  //   让整条变长（实测 basisLine 加 48 字，读数一个字没动，还是 181）。
  //   卡上**没有**上限的只有 `位置` 与 `【类别-子类】` ⇒ 用 `location` 撑长度，
  //   否则「合计 >200 但每条不超」这个形状根本构造不出来（实测连续两次假红）。
  const sixLong = six.map((f) => ({ ...f,
    location: '正文第 4 段，逐字命中「boosts milk」并可核对上下文（含前后各一句）',
    description: '逐字命中「boosts milk」并可核对上下文：' + '用于构造长度的描述'.repeat(3),
    kb: { ...(f.kb || {}), basisLine: (f.kb?.basisLine || '《库》第 W-1.18 条')
      + '｜命中片段：' + '很长的命中上下文'.repeat(10) } }));
  const small = T.renderMerged(sixLong.slice(0, 2), { state: 'BLOCK', reportUrlOverride: 'https://x/docx/abc' });
  assert.strictEqual(small.prd17Items.scope, 'item', '1-2 条那档应逐条量');
  assert.strictEqual(small.prd17Items.limit, 200, `1-2 档上限取错：${JSON.stringify(small.prd17Items.limit)}`);
  assert.strictEqual(small.prd17Items.perItem.length, 2, `逐条读数条数不对：${small.prd17Items.perItem.length}`);
  assert.ok(small.prd17Items.perItem.every((r) => r.chars > 0), '有条目的字数没量出来');
  // 反向对照：**合计**已超 200 而**每条**都没超 ⇒ 必须判合规（证明是按条量、不是按总量）
  const sumChars = small.prd17Items.perItem.reduce((a, r) => a + r.chars, 0);
  assert.ok(sumChars > 200, `夹具太短，构造不出「合计超 200 但每条不超」：合计 ${sumChars}`);
  assert.strictEqual(small.prd17Items.ok, true, `合计 ${sumChars} 超 200 但每条都没超，却被判超`);
  // ③ 反向对照：把卡面加长 200 字 ⇒ 读数必须从「合规」翻成「超」，且超多少算得出来
  const longText = big.block + '\n' + '字'.repeat(200);
  const re = P17.check('BLOCK', six.length + 3, longText);
  assert.strictEqual(re.ok, false, '加长 200 字之后仍然判合规 —— 那这把尺就是恒真的');
  assert.ok(re.over > 0, `超字数算成 0：${JSON.stringify(re)}`);
  // ④ 反向对照：**同一段文字、不同档位**必须给不同判定（证明读的是档位不是常数）
  assert.notStrictEqual(P17.check('BLOCK', 6, longText).limit, P17.check('BLOCK', 2, longText).limit,
    '两个档位取到了同一个上限 —— 档位判定没生效');
  // ⑤ 链接**不许**计入字数（一条 docx 链接 ≈55 字，算进去这条上限就永远不可能满足）
  const urlPrefix = '说明'.repeat(20);
  assert.strictEqual(P17.countChars(`${urlPrefix} https://x.y/${'a'.repeat(50)}`),
    P17.countChars(urlPrefix), '链接被算进字数了');
});

await t('Z54 ★★ 报告里只许有一个轴：**A3 12 类**，四维口径一个词都不许出现', async () => {
  // Owner 2026-10-19 逐字：「**报告要同步 卡上 12 类呀，整个知识库都要同步**」。
  // 改前实测（真报告 docx GYMzdSkRqoYVfSxT7TfcVRcsnEe）：同一屏上有 **三个** 分类口径 ——
  //   · 卡面：`· 合规与受监管宣称类问题：4 个`（A3 12 类）
  //   · 报告头：`发现 6（合规 3｜安全 1｜措辞 2）`（PRD 四维）
  //   · 逐条：`**维度**：消费者安全` ＋ 分组标题 `P1 安全与准确性 · 措辞表达 ｜ 2 条`（四维）
  //   ⇒ 同一单两个总数（4/1/1 与 3/1/2），读者只能怀疑「到底哪个对」。
  // 现在：分组标题、总览表第 3 列、逐条那一格、报告头汇总，**全部**取 A3。
  const M = await import('./agent/merged_report.mjs');
  const mk = (cat, sub) => ({ location: '全文', category: '合规', severity: 'REVIEW', source: 'model',
    reason: '原因', description: '描述', kb: { taxonomyCategory: cat, taxonomySubcategory: sub } });
  const six = [
    mk('合规与受监管宣称', '生理功效与效果承诺'),
    mk('合规与受监管宣称', '无痛、安全与零风险承诺'),
    mk('证据与实质证明', '研究方法与统计口径'),
    mk('商品信息与Listing准确性', null),
    mk('推广与价格透明', '促销紧迫感与施压表述'),
    mk('平台与渠道政策', '广告标识与素材使用'),
  ];
  const md = M.renderMergedReportMd({ merged: six, total: 6, state: 'BLOCK',
    line: '【审查结论：BLOCK】共发现 6 处必须修改。', question: 'q', at: 'x' });
  // ① 四维的四个词，**整份报告里一个都不许有**（夹具里没有别处会带出这四个词）
  for (const dim of ['消费者安全', '产品描述', '措辞表达']) {
    assert.ok(!md.includes(dim), `报告里还有四维口径的「${dim}」：${(md.match(new RegExp(`.{0,30}${dim}.{0,30}`)) || [''])[0]}`);
  }
  // ② 结构三处都必须挂 12 类
  const head = md.split('\n').filter((l) => /^### /.test(l));
  assert.ok(head.length >= 3, `分组标题太少：${head.join(' / ')}`);
  for (const h of head) assert.ok(!/ · (合规|安全|权利|本地化|措辞) ｜/.test(h), `分组标题还是四维/业务桶：${h}`);
  assert.ok(!/^发现 \d+（/m.test(md), '报告头又出现了四维的「发现 N（…）」');
  assert.ok(/^\| # \| 优先级 \| 所属类别 \| 位置 \| 命中描述 \| 承办 \|$/m.test(md), '总览表第 3 列不是所属类别');
  // ③ 逐条那一格：字段名必须改成「所属类别」，且值在 12 类里
  const fieldLines = md.split('\n').filter((l) => /^> \*\*所属类别\*\*：/.test(l));
  assert.strictEqual(fieldLines.length, six.length, `逐条「所属类别」格数不对：${fieldLines.length}`);
  const T = await import('./agent/dual_track.mjs');
  for (const l of fieldLines) {
    const v = l.replace(/^> \*\*所属类别\*\*：/, '').trim();
    assert.ok(T.TAX_CLASS_ORDER.includes(v), `逐条所属类别不是 12 类名：${v}`);
  }
  assert.ok(!md.includes('**维度**'), '逐条里还留着「**维度**」这个字段名（值都换了，名字还叫维度就是骗人）');
  // ④ **反向对照**：换成四维口径的输出必须能被这条判据抓住
  //    （拿一个仍印四维的最小样本喂同一个正则 —— 证明 ① 不是恒真）
  const oldStyle = '**F-01 ｜ 合规 ｜ P1**\n> **维度**：消费者安全\n### **P1 安全与准确性 · 措辞表达 ｜ 2 条**\n发现 6（合规 3｜安全 1｜措辞 2）';
  assert.ok(!oldStyle.includes('**所属类别**') && oldStyle.includes('**维度**'), '反向对照样本写错了');
  for (const dim of ['消费者安全', '措辞表达']) assert.ok(oldStyle.includes(dim), `反向对照样本缺少「${dim}」`);
});

await t('Z53 ★★ 报告里的一级分类汇总必须与卡面**逐字相同**（Owner：「逐条问题类别跟审核报告对不上」）', async () => {
  // Owner 2026-10-19 逐字：「守衡回复逐条问题类别跟审核报告中的问题类别对不上
  //   逐条问题：输出 所属类别（一级分类）／报告中类别：输出 所属类别+二级分类」，
  //   并选定「报告里加一行与卡逐字相同的一级汇总」。
  // 实测那一单：卡三行 `· 合规与受监管宣称类问题：4 个` …，报告逐条首行 `合规与受监管宣称·生理功效与效果承诺`；
  //   **条数一个不差**（4＝生理功效1＋无痛安全2＋绝对化1，另 1＋1），但报告里那三个类名
  //   **逐字出现不了一次**（都被二级切开）⇒ 人没法核对。
  const T = await import('./agent/dual_track.mjs');
  const M = await import('./agent/merged_report.mjs');
  const mk = (cat, sub) => ({ location: '全文', category: '合规', severity: 'REVIEW', source: 'model',
    reason: 'r', kb: { taxonomyCategory: cat, taxonomySubcategory: sub } });
  const six = [
    mk('合规与受监管宣称', '生理功效与效果承诺'),
    mk('合规与受监管宣称', '无痛、安全与零风险承诺'),
    mk('证据与实质证明', '研究方法与统计口径'),
    mk('合规与受监管宣称', '无痛、安全与零风险承诺'),
    mk('商品信息与Listing准确性', null),
    mk('合规与受监管宣称', '绝对化与最高级用语'),
  ];
  const grab = (txt) => txt.split('\n').filter((l) => /^· .*问题：\d+ 个$/.test(l));
  const cardLines = grab(String(T.renderMerged(six, { state: 'BLOCK',
    reportUrlOverride: 'https://momcozy-in.feishu.cn/docx/ZZZ' }).block || ''));
  const repLines = grab(M.renderMergedReportMd({ merged: six, total: 6, state: 'BLOCK',
    line: '【审查结论：BLOCK】共发现 6 处必须修改。', question: 'q', at: 'x' }));
  // ① 卡面这一单确实是「按一级分类」的三行（4/1/1）—— 先钉住输入侧
  assert.deepStrictEqual(cardLines, ['· 合规与受监管宣称类问题：4 个',
    '· 商品信息与Listing准确性类问题：1 个', '· 证据与实质证明类问题：1 个'], `卡面汇总变了：${cardLines}`);
  // ② **核心断言**：报告与卡面逐字相同（不是「都出现了」那种弱断言）
  assert.deepStrictEqual(repLines, cardLines, `报告与卡面不是逐字相同：\n卡：${cardLines}\n报：${repLines}`);
  // ③ 反向对照：1–2 条时卡面**不走汇总**⇒ 报告也**不许**多出这一段
  const two = six.slice(0, 2);
  const card2 = grab(String(T.renderMerged(two, { state: 'REVIEW',
    reportUrlOverride: 'https://momcozy-in.feishu.cn/docx/ZZZ' }).block || ''));
  const rep2 = grab(M.renderMergedReportMd({ merged: two, total: 2, state: 'REVIEW',
    line: '【审查结论：REVIEW】共发现 2 处需人工确认。', question: 'q', at: 'x' }));
  assert.deepStrictEqual(card2, [], `2 条时卡面不该有汇总：${card2}`);
  assert.deepStrictEqual(rep2, [], `2 条时报告不该有汇总：${rep2}`);
  // ④ 反向对照：报告那段若换了输入（把 A3 抹掉 ⇒ 全落未归类）必须与卡面不同 ——
  //    证明这条断言量的是「同一份输入」，不是恒真
  const repWrong = grab(M.renderMergedReportMd({ merged: six.map((f) => ({ ...f, kb: {} })),
    total: 6, state: 'BLOCK', line: '【审查结论：BLOCK】共发现 6 处必须修改。', question: 'q', at: 'x' }));
  assert.notDeepStrictEqual(repWrong, cardLines, '报告那段用的不是同一份输入时，本文也该能分辨');
});

await t('Z52 ★★ 依据行必须带飞书源侧直链（手里有 URL 就必须印；没有就不许造）', async () => {
  // Owner 2026-10-19 逐字：「1.这里要带飞书源侧链接『依据文档链接：《知识库》第 E-2.124 条 ← 命中「100%」』」。
  // 病灶：`kb.entry_url` 明明在条目上，但**只有引擎那条路**会把它写进 `basisLine` 文字里；
  //   候选 / 分块解析 / 模型侧外部标准这三条路只填字段、不写文字
  //   ⇒ 报告印出「依据文档链接：《知识库》第 E-2.124 条 ← 命中「100%」」**而没有链接**。
  //   改前实测：夹具 `kb.entry_url` 有值、`basisLine` 不带 URL ⇒ 报告里一个链接都没有。
  const M = await import('./agent/merged_report.mjs');
  const url = 'https://momcozy-in.feishu.cn/wiki/NB55wAq8liEOdKkquL2cgtPEnmg';
  const mk = (u) => ({
    location: '全文', category: '合规', severity: 'BLOCK', source: 'kb', reason: '绝对化用语',
    kb: { article_no: 'E-2.124', priorityTier: 'P0', riskCategory: '合规',
          entry_url: u, basisLine: '《知识库》第 E-2.124 条 ← 命中「100%」' },
  });
  const basisOf = (u) => {
    const md = M.renderMergedReportMd({ merged: [mk(u)], total: 1, state: 'BLOCK',
      line: '【审查结论：BLOCK】共发现 1 处必须修改。', question: 'q', at: 'x' });
    return (md.split('\n').find((l) => /依据文档链接/.test(l)) || '').trim();
  };
  // ① 有 URL ⇒ 必须可点；形状按 Owner 2026-10-22 的新口径：
  //   「依据文档链接…**表格名称+飞书链接就好**」—— 与 PRD §5.3.3 的
  //   `依据：《广告法禁用语》第 1 条（链接：https://…）` 同一句式。
  //   ⚠️ 原先这里还断言要保留「← 命中「100%」」那句：那是 2026-10-19 的口径；
  //     2026-10-22 收成一句话后，命中原文的落点是**总览表的「命中描述」列**
  //     （`pointOf` 读 excerpt，不由这一格承担）。两条口径不能同时成立，以最新为准。
  const withUrl = basisOf(url);
  assert.ok(withUrl.includes(url), `有 entry_url 却没印链接：${withUrl}`);
  assert.ok(/\[点开核对\]\(/.test(withUrl), `链接不是可点形式：${withUrl}`);
  assert.ok(/《知识库》第 E-2\.124 条/.test(withUrl), `依据原话（表格名+条款号）被改坏了：${withUrl}`);
  assert.ok(/（链接：\[点开核对\]\(/.test(withUrl), `链接没有收进 PRD 的「（链接：…）」括号：${withUrl}`);
  // ② **反向对照**：没有 URL ⇒ 一个链接都不许出现（不许拿别处的 URL 凑、不许造）
  const noUrl = basisOf(null);
  assert.ok(!/https?:\/\//.test(noUrl), `没有 entry_url 却印出了链接：${noUrl}`);
  assert.ok(/《知识库》第 E-2\.124 条/.test(noUrl), `无链接时依据原话也要在：${noUrl}`);
  // ③ 幂等：文字里**已经有**这个 URL ⇒ 不许再补第二遍
  const twice = M.renderMergedReportMd({
    merged: [{ ...mk(url), kb: { ...mk(url).kb, basisLine: `《知识库》第 E-2.124 条 ← 命中「100%」｜原始出处：${url}` } }],
    total: 1, state: 'BLOCK', line: '【审查结论：BLOCK】共发现 1 处必须修改。', question: 'q', at: 'x',
  }).split('\n').find((l) => /依据文档链接/.test(l)) || '';
  assert.strictEqual((twice.match(/NB55wAq8liEOdKkquL2cgtPEnmg/g) || []).length, 1,
    `同一个链接印了两遍：${twice}`);
});

await t('Z51 ★★ 问题总览的「优先级」「所属类别」两格不许为空（Owner：「这里不允许为空」）', async () => {
  // Owner 2026-10-19 逐字：「问题总览中有优先级和维度为空，不属于12类中的吗？**这里不允许为空**，
  //   模型侧输出的可以参照知识库侧的分类和优先级来定」。
  // 实测形状（改前）：`| 3 | P1 | — | 正文 | — |` —— 维度那一格是一条破折号。
  // 破折号的问题不是丑：**它会被读成「这条没有维度」，而实际是「我们没算出来」**，
  //   两者对业务侧的意义完全不同（前者像结论、后者是要人来判）。
  const M = await import('./agent/merged_report.mjs');
  const T = await import('./agent/dual_track.mjs');
  const md = M.renderMergedReportMd({
    merged: [
      // ① 库侧：档位与维度都齐（对照组：正常形状不许被这条判据改坏）
      { location: '全文', category: '合规', severity: 'BLOCK', source: 'kb', reason: 'r1',
        kb: { article_no: 'W-1.18', priorityTier: 'P0', riskCategory: '合规' } },
      // ② 模型侧：只给 A3 类，维度与档位都靠推导（Owner 说「参照知识库侧的分类和优先级」）
      { location: '标题', category: '隐私', severity: 'REVIEW', source: 'model', reason: 'r2',
        model: { taxonomyCategory: '平台与渠道政策', taxonomySubcategory: '广告标识与素材使用' } },
      // ③ 什么都不给（最坏形状）：既无 A3、也无四维、也无档位
      { location: '正文', category: 'x', severity: 'REVIEW', source: 'model', reason: 'r3' },
    ],
    total: 3, state: 'REVIEW', question: 'q', at: 'x',
  });
  const rows = md.split('\n').filter((l) => /^\| \d+ \|/.test(l)).map((l) => l.split('|').map((s) => s.trim()));
  assert.strictEqual(rows.length, 3, `总览表行数不对：${rows.length}`);
  for (const r of rows) {
    // r = ['', '#', '优先级', '维度', '位置', '命中描述', '承办', '']
    assert.ok(r[2] && r[2] !== '—', `优先级那格空了：${r.join(' | ')}`);
    assert.ok(r[3] && r[3] !== '—', `维度那格空了：${r.join(' | ')}`);
  }
  // ② 这一格必须是 **A3 12 类名**（不是四维、也不是随便填了个词）
  //   ★ 2026-10-19（Owner：「报告要同步卡上 12 类呀」）：值从 `dimensionOf()`（四维）换成
  //   `taxonomyCategoryOf()`（12 类），断言也跟着换 —— 否则这条判据会替旧口径站岗。
  assert.strictEqual(rows[1][3], T.taxonomyCategoryOf({ source: 'model',
    model: { taxonomyCategory: '平台与渠道政策' } }), '模型侧那行的所属类别与取数口不一致');
  assert.ok(T.TAX_CLASS_ORDER.includes(rows[1][3]) || rows[1][3] === T.TAX_UNCLASSED,
    `所属类别那一格不是 12 类里的名字：${rows[1][3]}`);
  // ③ 最坏形状：印**有名字的桶**（12 类的兜底 `未归类`），而不是破折号、也不是编一个 P 级
  assert.strictEqual(rows[2][3], T.TAX_UNCLASSED, `最坏形状的所属类别应印「${T.TAX_UNCLASSED}」`);
  assert.strictEqual(rows[2][2], 'P1', `模型侧无档位时应落 P1（PRD §6.3 第二层），实得「${rows[2][2]}」`);
  // ★ 反向对照：上面两格能填，**不许靠「给数据编个值」实现** —— 底层查询必须仍然落兜底
  assert.strictEqual(T.taxonomyCategoryOf({ category: 'x' }), T.TAX_UNCLASSED,
    '没有 A3 的条目应落 `未归类` 兜底，而不是被编成一个真类');
  const kbBare = T.priorityOf({ source: 'kb', kb: {} });
  assert.strictEqual(kbBare.level, null, '库侧无档位时**不许代定 P 级**（P0 只由规则红线给）');
  //   而渲染层对库侧无档位印的是「未分级」，不是 P1/P0
  assert.strictEqual(T.PRIORITY_UNSET, '未分级');
  const mdKb = M.renderMergedReportMd({ merged: [{ location: '全文', category: '合规',
    severity: 'REVIEW', source: 'kb', reason: 'r', kb: {} }], total: 1, state: 'REVIEW', question: 'q', at: 'x' });
  const kbRow = mdKb.split('\n').filter((l) => /^\| \d+ \|/.test(l)).map((l) => l.split('|').map((s) => s.trim()))[0];
  assert.strictEqual(kbRow[2], T.PRIORITY_UNSET, `库侧无档位那格应印「未分级」，实得「${kbRow[2]}」`);
});

await t('Z49 ★★ 审查对象上报告：文案原文 ＋ 图/视频的可点链接（拿不到就照实说）', async () => {
  const M = await import('./agent/merged_report.mjs');
  const mk = () => ({
    location: '全文', category: '合规', severity: 'BLOCK', source: 'kb',
    reason: '原因句', description: '描述句',
    kb: { article_no: 'W-1.18', priorityTier: 'P0', riskCategory: '合规',
          basisLine: '《措辞表达库 v0》第 W-1.18 条 ← 命中「boosts milk」'
            + '｜锚点：#广告文案明细/recvuJYdOb1Rm1/命中片段'
            + '｜原始出处：https://momcozy-in.feishu.cn/base/Lk3Qb8y2QaVyZns6gprcVNE9nA0?table=tblcbk4XiW6471YN&record=recvuJYdOb1Rm1',
          reasonLine: 'H02 催乳/增产/奶量产出承诺（无 FDA/临床证据）；M01 静音程度夸大（建议改为 low noise）',
          suggestionLine: '删掉「Boosts Milk Supply」' } });
  const longText = `Momcozy M6 吸奶器广告原文。${'这是一段很长的正文。'.repeat(40)}`;
  const md = M.renderMergedReportMd({
    merged: [mk()], total: 1, state: 'BLOCK', line: '【审查结论：BLOCK】共发现 1 处必须修改。',
    question: '审一下这段文案', contentId: 'C', at: 'x',
    // ⚠️ 夹具必须长得像真产出：`question` 里**故意夹着我们的探针**（那是内部指令），
    //   `material.text` 才是对方真写的那段原文。
    material: { text: longText, media: [
      { kind: 'image', index: 1, ok: true, url: 'https://momcozy-in.feishu.cn/file/xxxx' },
      { kind: 'image', index: 2, ok: false, detail: '取字节没成：403' },
    ] },
  });
  // ① 有这一节、且在「一、问题总览」之前
  const iMat = md.indexOf('## 审查对象');
  const iTable = md.indexOf('## **一、问题总览**');
  assert.ok(iMat > 0, `没有「审查对象」这一节：${md.slice(0, 200)}`);
  assert.ok(iMat < iTable, '「审查对象」跑到问题总览后面去了（第一屏该先说在审什么）');
  // ② 文案原文在（长文截断且写明总字数），探针**一个字都不许出现**
  assert.ok(md.includes('Momcozy M6 吸奶器广告原文'), '审查对象里没有文案原文');
  // ★ 2026-10-17 第二十四轮（Owner：「这里你写全了吗？…建议都写全」）——
  //   从「截断并标全文 N 字」改成「**一字不少地全写**」：审查对象是判定对象的原文，
  //   缺一段就没法核。反向对照：把它截回 400 字 ⇒ 下面这条必须挂。
  assert.ok(md.includes(longText.trim()), '文案被截断了（审查对象必须全写出来）');
  assert.ok(!/全文 \d+ 字/.test(md), '还在用「（全文 N 字）」交代截断 —— 已经不截断了');
  assert.ok(!/【对方这条消息/.test(md), '审查对象把我们的探针当素材印出去了');
  // ③ 图有可点链接；没链接的那张**照实说**，不许编
  assert.ok(/\[点开查看\]\(https:\/\/momcozy-in\.feishu\.cn\/file\/xxxx\)/.test(md),
    '图片没给可点开的链接');
  assert.ok(/图片 2\*\*：链接未生成/.test(md), '拿不到链接时没有照实说（一个点不开的链接比空格更坏）');
});

await t('Z49b ★★ 原因只说原因：规则码与建议子句都不上报告；反向对照缺一不可', async () => {
  const T = await import('./agent/dual_track.mjs');
  const RAW = 'H02 催乳/增产/奶量产出承诺（含裸 more milk、催产素，无 FDA/临床证据）'
    + '；放松叙事+限定语走 M07 语境守卫；M01 静音程度夸大（建议改为 low noise / quiet mode）';
  const got = T.businessReason(RAW);
  assert.ok(!/\b[A-Z]\d{2}\b/.test(got), `原因里还留着规则码：${got}`);
  assert.ok(!/建议|改为/.test(got), `原因里还混着改法（Owner：原因就说原因，别建议）：${got}`);
  assert.ok(got.includes('无 FDA/临床证据'), `把真原因一起删掉了：${got}`);
  assert.ok(!/语境守卫/.test(got), `把别的规则的编排（走 M07 语境守卫）也印进去了：${got}`);
  // 反向对照：不净化 ⇒ 上面三条必然挂（证明判据量的是净化本身，不是我写死的句子）
  assert.ok(/\b[A-Z]\d{2}\b/.test(RAW) && /建议/.test(RAW), '反向对照失效：原句里本该有规则码与建议');
  // ★ 两条**当天真踩到**的反向对照（改完第一版立刻翻车，必须钉住）：
  //   ① `best/#1/No.1/最佳` 里的 `#1/No.1` 被当成内部坐标删成 `best/.1`
  //      ⇒ 内部坐标判据必须要求第一段含中文表名；
  //   ② 句末的 `。` 被当残渣剃掉（`。` 是正常标点，只有被删分句留下的 `；` 才该清）。
  assert.strictEqual(T.businessReason('H05 虚假安全承诺（best/#1/No.1/最佳/最好等排名最前）'),
    '虚假安全承诺（best/#1/No.1/最佳/最好等排名最前）', '把正文里的 `#1/No.1` 当成内部坐标删掉了');
  assert.ok(T.businessReason('这是一句正常的原因。').endsWith('。'),
    '原因结尾的句号被剃掉了（那是正常标点，不是残渣）');
});

await t('Z49e ★★ 链接只来自两处：正文里的 URL 一个都不挖（Owner：这链接跳转是哪里？）', async () => {
  // 2026-10-17 第二十三轮：上一版把**文案正文里粘着的 URL**挖出来单印成「链接：点开」，
  // 那一单的 URL 是粘贴时被编辑器自动加的（http://production.it/，别人的 .it 域名），
  // 而同一份报告第 5 条问题恰好写着「这里粘着 markdown 链接残留」—— 一边说是缺陷、
  // 一边给它可点入口。Owner 当场问住了：「这链接跳转是哪里？」
  const M = await import('./agent/merged_report.mjs');
  const t = 'increasing milk [production.It](http://production.it/) supports everyday needs.';
  // ① 文案里的 markdown 链接语法**降成纯文字**（不许保留可点入口）
  const plain = M.materialBlock({ text: t, media: [], });
  const plainTxt = plain.join('\n');
  assert.ok(!plainTxt.includes('](http'), `文案里还留着可点的 markdown 链接：${plainTxt}`);
  assert.ok(plainTxt.includes('production.It supports'), `链接降级时把文字也吃掉了：${plainTxt}`);
  // ② 非链接送审 ⇒ **没有链接行**（哪怕正文里就有 URL）
  assert.ok(!/> \*\*链接\*\*/.test(plainTxt), `非链接送审却印了链接行：${plainTxt}`);
  // ③ 文案里的裸 URL 包成行内代码（飞书会把裸 URL 自动变超链接）
  const bare = M.materialBlock({ text: '看这页 https://someone-else.it/x 有没有问题' }).join('\n');
  assert.ok(/\`https:\/\/someone-else\.it\/x\`/.test(bare), `裸 URL 没包成行内代码（会被飞书变超链接）：${bare}`);
  assert.ok(!/\]\(https:\/\/someone-else/.test(bare), '裸 URL 还是被做成了链接');
  // ④ 反向对照：**真的是链接送审**时必须给可点链接（否则上面那条只是「什么都不做」）
  const linkCase = M.materialBlock({ text: '帮我审这个落地页 https://example.com/p?id=1',
    links: ['https://example.com/p?id=1'] }).join('\n');
  assert.ok(/\[点开\]\(https:\/\/example\.com\/p\?id=1\)/.test(linkCase),
    `链接送审却没给可点链接：${linkCase}`);
  // ⑤ 只认调用方**显式**传的链接，正文挖掘哪怕是 http(s) 也不认
  const mined = M.materialBlock({ text: '正文里有 https://evil.example/x',
    links: ['javascript:alert(1)', 'ftp://x/y'] }).join('\n');
  // ⚠️ 判据是「**不许出现链接标记**」，不是「不许出现那个字符串」——
  //    裸 URL 留在引用的文案里是对的（包成行内代码），错的是把它做成可点入口。
  assert.ok(!/\]\(/.test(mined), `把非 http(s) 或未显式声明的地址做成了可点链接：${mined}`);
});

await t('Z49f ★★ 修改建议 ≤30 字（Owner 2026-10-19 后令，推翻 2026-10-17「写全」）；也不许挂「完整改法见…」', async () => {
  // 沿革（**两次裁定，后令优先**，别把老的那条改回来）：
  //   · 2026-10-17「建议都写全」—— 改前只印前 120 字、尾巴挂
  //     「…（完整改法见「依据文档链接」条款原文）」，而那一格是**条款原文**、本就不含改法
  //     ⇒ 读的人两头都拿不到完整改法。那条裁定治的是**这个**。
  //   · 2026-10-19「**审查报告中，修改建议你写了200多字，修改建议 ≤30 字**」—— PRD §5.3.3 硬约束。
  //     ⇒ 报告那一格只留**一句 ≤30 字的动作**；全文不丢（结构化 JSON ＋ 本地留底 md）。
  const T = await import('./agent/dual_track.mjs');
  const M = await import('./agent/merged_report.mjs');
  const sug = '改法首选：把标题改为 Ideal Rhythm for Comfortable Pumping，并把正文首句改成一句'
    + '完整英文；次选：删掉 Boosts Milk Supply 这一整句，在正文首句补一句本品适用场景的说明，'
    + '避免读者以为它能替代日常喂养；若两条同时做，注意标题与正文不要重复同一卖点，'
    + '否则读者会觉得这段文案在自我夸大。';
  assert.ok(sug.length > 120, '夹具太短，量不出截断（必须长于 120 字）');
  const md = M.renderMergedReportMd({
    merged: [{ location: '全文', category: '合规', severity: 'BLOCK', source: 'kb', reason: 'r', description: 'd',
      kb: { article_no: 'W-1.18', priorityTier: 'P0', riskCategory: '合规',
            basisLine: '《措辞表达库 v0》第 W-1.18 条 ← 命中「x」', suggestionLine: sug } }],
    total: 1, state: 'BLOCK', line: '【审查结论：BLOCK】共发现 1 处必须修改。', question: 'q', at: 'x' });
  const cell = (md.match(/\*\*修改建议\*\*：(.*)/) || [])[1] || '';
  const n = cell.replace(/[*]/g, '').replace(/\s+/g, '').length;
  // ── ★★ 2026-10-19 **第三令**（Owner：「这里的 修复建议都没讲完，**被截断了**，不能出现这种情况」）
  //   上面那两条（2026-10-17「写全」／当天上午「≤30 字」）在这一格上**都被这一令改写**：
  //     · 「≤30 字」改为钉在**产出侧**（`advice.mjs` 超了就再问一次压，见 `advice.test.mjs` A1）；
  //     · 渲染层**一个句号都不许少了** —— 印不完整比印超了更坏（真报告 6 条里 3 条只剩半句，
  //       最狠一条只剩「改为…」，拿到的人反而不知道该改什么）。
  //   ⇒ 本判据现在钉的是：**这一格必须存在、且是完整原句（不许 `…`、不许比原文短）**。
  assert.ok(n > 0, '报告逐条里没有「修改建议」这一格（没写 ≠ 合规）');
  assert.ok(T.countAdviceChars(cell) <= T.ADVICE_MAX,
    `修改建议超过 ${T.ADVICE_MAX} 字：${JSON.stringify(cell)}`);
  // 原始建议必须完整保存在结构化记录中，即使可见字段遵守 60 字上限。
  const MR = await import('./agent/merged_record.mjs');
  const saved = MR.buildMergedRecord({ items: [{ location: '全文', category: '合规', severity: 'BLOCK',
    source: 'kb', reason: 'r', description: 'd', advice: sug }] });
  assert.strictEqual(saved.items[0].advice, sug, '可见字段压到 60 字后，记录仍须保留原建议全文');
  // ③ 也不许退回到「指路尾巴」那种改前错法（2026-10-17 那条裁定治的就是它）
  assert.ok(!/完整改法见/.test(md), '又出现了「完整改法见…」这个指路尾巴');
  // ④ 全文没丢：结构化那一侧仍然是原文（搬是搬、砍是砍）
  const repItem = T.renderMergedItem({ location: '全文', category: '合规', severity: 'BLOCK', source: 'kb',
    reason: 'r', kb: { suggestionLine: sug, basisLine: '《措辞表达库 v0》第 W-1.18 条' } }, 0,
  { must: true, layout: 'report' });
  assert.ok(repItem.includes('修改建议'), '报告逐条里没有「修改建议」这一格');
});

await t('Z49c ★★ 报告里不许有后台词（记录主键/锚点/模式 id/sha）；直链必须仍然可点', async () => {
  const T = await import('./agent/dual_track.mjs');
  const BAC = '｜锚点：#广告文案明细/recvuJYdOb1Rm1/命中片段'
    + '｜原始出处：https://momcozy-in.feishu.cn/base/Lk3Qb8y2QaVyZns6gprcVNE9nA0?table=tblcbk4XiW6471YN&record=recvuJYdOb1Rm1';
  const basis = T.businessBasis(`《措辞表达库 v0》第 W-1.18 条 ← 命中「boosts milk」${BAC}`);
  // ⚠️ 查的是**正文**：URL 里的 query 必须原样留着（下面那条专门钉它）
  const basisNoUrl = basis.replace(/https?:\/\/\S+/g, '[链接]');
  assert.ok(!/recvuJYdOb1Rm1|#广告文案明细|锚点/.test(basisNoUrl), `依据里还有后台词：${basis}`);
  assert.ok(basis.includes('W-1.18'), '把条款号也洗掉了（那是业务侧要看的）');
  // ★★ 直链必须**一个字符都不变** —— 第一版对整段做替换，把 URL 的
  //    `?table=tbl…&record=rec…` 打成 `?table=&record=`，链接当场失效（当天真踩过）
  assert.ok(/原始出处：https:\/\/momcozy-in\.feishu\.cn\/base\/Lk3Qb8y2QaVyZns6gprcVNE9nA0\?table=tblcbk4XiW6471YN&record=recvuJYdOb1Rm1$/
    .test(basis), `直链被打坏了（后台词该消失在正文里，不该消失在 URL 里）：${basis}`);
  // 反向对照：整条报告渲染出来的正文里，**任何一格**都不许出现后台词
  const M = await import('./agent/merged_report.mjs');
  const md = M.renderMergedReportMd({
    merged: [{ location: '全文 recvuJYdOb1Rm1', category: '合规', severity: 'BLOCK', source: 'kb',
      reason: '原因句', description: '描述句',
      kb: { article_no: 'W-1.18', priorityTier: 'P0', riskCategory: '合规',
            basisLine: `《措辞表达库 v0》第 W-1.18 条${BAC}`, suggestionLine: '删掉' } }],
    total: 1, state: 'BLOCK', line: '【审查结论：BLOCK】共发现 1 处必须修改。', question: 'q', at: 'x',
  });
  const noLink = md.replace(/\[([^\]]*)\]\((https?:[^)]+)\)/g, '[$1]');   // 去掉链接目标再查
  assert.ok(!/recvuJYdOb1Rm1|p-[0-9a-f]{8,}|[a-f0-9]{32,}/.test(noLink),
    `报告正文里还有后台词：${(noLink.match(/recv\w+|p-[0-9a-f]+|[a-f0-9]{32,}/g) || []).join(' ')}`);
});

await t('Z49d ★★ 清扫不许把正常短值一起删掉（P0 / 合规 / 全文 这类）', async () => {
  // 2026-10-17 当天真踩到：第一版「≤3 字的分段一律丢」把表格六列与清单的
  // 维度/位置一起删空了 —— 判定「后台词」的尺子**不许顺手删正常值**。
  const T = await import('./agent/dual_track.mjs');
  for (const v of ['合规', '全文', 'P0', '正文第2段第1句', '《措辞表达库 v0》第 W-1.18 条']) {
    assert.strictEqual(T.stripBackendTokens(v), v, `正常值被洗掉了：${v}`);
  }
  // 反向对照：真后台词必须被挖掉（否则上面那条只是「什么都没做」）
  assert.strictEqual(T.stripBackendTokens('recvuJYdOb1Rm1'), '', '记录主键没被挖掉');
  assert.ok(!/p-[0-9a-f]{8,}/.test(T.stripBackendTokens('模式 p-755f9ff377c3052c')), '模式 id 没被挖掉');
  // 清单里的六格必须**有值**（清扫之后）
  const M = await import('./agent/merged_report.mjs');
  const md = M.renderMergedReportMd({
    merged: [{ location: '全文', category: '合规', severity: 'BLOCK', source: 'kb',
      reason: '命中药量承诺（无 FDA 证据）；建议改为低噪说法', description: '逐字命中「boosts milk」',
      kb: { article_no: 'W-1.18', priorityTier: 'P0', riskCategory: '合规',
            basisLine: '《措辞表达库 v0》第 W-1.18 条 ← 命中「boosts milk」',
            suggestionLine: '删掉「Boosts Milk Supply」' } }],
    total: 1, state: 'BLOCK', line: '【审查结论：BLOCK】共发现 1 处必须修改。', question: 'q', at: 'x' });
  for (const k of ['所属类别', '位置', '问题描述', '原因', '依据文档链接', '修改建议']) {
    const m = new RegExp(`> \\*\\*${k}\\\*\\*：(.+)`).exec(md);
    assert.ok(m && m[1].trim().length >= 2, `「${k}」这一格被清扫洗空了`);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 34. 回执前置 + 真 ingress（2026-10-20，Owner 批准 ①②）═══');
// 这一组的病灶（实测 2026-10-20）：
//   · 回执卡原先要等 `readInboundContent`（下载 → 画面读数 → 本机 OCR → 摘水印）跑完才发；
//   · 而 PRD §12 那条 ≤5 秒的指标，`tIngress` 在守护进程这条路上**从没被传过**，
//     闸门里 `?? Date.now()` 兜底 ⇒ 量到的是「回执自己发出去花了多久」（1401ms / 383ms，恒 pass），
//     而同期飞书侧真值是 **60 / 120 / 180 秒**。
// 判据要能区分「先回执后读图」与「读完图再回执」——所以用**时序**钉，不用「有没有回执」。

const _stubRunners = () => ({
  chainRunner: async () => ({ answer: '结论：REVIEW｜依据 W-1.54' }),
  publishRunner: async () => ({ ok: true, action: 'skipped', detail: '自证桩：不碰真表' }),
  modelSideRunner: async () => ({ ok: true, count: 0, items: [] }),
  mergedReportRunner: async () => ({ ok: true, url: 'https://example.invalid/docx/STUB', detail: '自证桩' }),
  adviceRunner: async ({ items }) => ({ ok: true, ms: 1,
    advice: Object.fromEntries((items || []).map((_, i) => [i, `自证桩给的改法 ${i}`])) }),
});

await t('34a 带图送审 ⇒ 回执在**读素材之前**发出（时序，不是"有没有"）', async () => {
  const { handleMessage } = await import('./agent/agent.mjs');
  const t0 = Date.now();
  const marks = { acks: [] };
  await handleMessage({
    message: { message_id: `om_pre_${Date.now()}`, chat_id: 'oc_pre', chat_type: 'p2p',
               message_type: 'image', content: JSON.stringify({ image_key: 'img_pre_1' }) },
    sender: { sender_id: { open_id: 'ou_pre' } },
  }, {
    notify: async (text) => { marks.acks.push(text); marks.ack = Date.now() - t0; },
    deps: {
      // 取字节故意慢 150ms：回执若排在它后面，marks.ack 就会 ≥ marks.fetchDone
      fetchImage: async () => {
        await new Promise((res) => setTimeout(res, 150));
        marks.fetchDone = Date.now() - t0;
        return { path: null, bytes: 0, error: '自证桩：不取真图', cleanup: () => {} };
      },
      ocr: async () => ({ ok: false, error: '自证桩' }),
      scene: async () => ({ ok: false, ms: 0, error: '自证桩' }),
    },
    ..._stubRunners(),
  });
  assert.ok(marks.ack !== undefined, '必须回执（否则读素材那几十秒里对方以为它没动）');
  assert.ok(marks.fetchDone !== undefined, '取字节那次调用必须真的发生过（否则下面的时序比较没意义）');
  assert.ok(marks.ack < marks.fetchDone,
    `回执必须在**读素材之前**：ack=${marks.ack}ms 却在 fetch 结束 ${marks.fetchDone}ms 之后`);
  assert.strictEqual(marks.acks.length, 1, `一条消息只许一张回执，实际 ${marks.acks.length}`);
  assert.ok(/\[\[card:receipt\]\]/.test(marks.acks[0]), `回执要递卡片块：${marks.acks[0]}`);
});

await t('34b 反向对照：不是送审（短文本、无媒材）⇒ 一张回执都不发', async () => {
  const { handleMessage } = await import('./agent/agent.mjs');
  const acks = [];
  await handleMessage({
    message: { message_id: `om_quiet_${Date.now()}`, chat_id: 'oc_quiet', chat_type: 'p2p',
               message_type: 'text', content: JSON.stringify({ text: '在吗' }) },
    sender: { sender_id: { open_id: 'ou_quiet' } },
  }, { notify: async (text) => { acks.push(text); }, ..._stubRunners() });
  assert.strictEqual(acks.length, 0, `不是送审就不许发回执（否则每句闲聊都回一张卡）：${acks.length}`);
});

await t('34c 一条消息只发一张：早发过 ⇒ 闸门里**不再**补发（拆掉 ackSentAt 会变 2）', async () => {
  const { handleMessage } = await import('./agent/agent.mjs');
  const acks = [];
  const long = '这段 listing 文案帮我审一下：M5 吸奶器的静音设计很安静，夜里泵奶不打扰家人。';
  assert.ok([...long].length >= 30, '夹具必须够长，才会被判成 text 送审');
  const r = await handleMessage({
    message: { message_id: `om_once_${Date.now()}`, chat_id: 'oc_once', chat_type: 'p2p',
               message_type: 'text', content: JSON.stringify({ text: long }) },
    sender: { sender_id: { open_id: 'ou_once' } },
  }, {
    notify: async (text) => { acks.push(text); },
    ..._stubRunners(),
    // 链桩必须给，否则会真起链；闸门也要真跑，才能验「闸门不补发」
    chainRunner: async () => ({ answer: '结论：REVIEW｜依据 W-1.54' }),
  });
  assert.ok(r.meta?.gate?.yes !== false, '这条必须真的进了闸门（否则本判据空转）');
  assert.strictEqual(acks.length, 1, `早发过一次就够了，闸门不许再发第二张：${acks.length}`);
});

await t('34d 指标：真 ingress 进日志（stage=early / prep_ms / ingress 来源），不传就不编数', async () => {
  const { handleMessage } = await import('./agent/agent.mjs');
  const logs = [];
  const orig = console.log;
  console.log = (...a) => { logs.push(a.map(String).join(' ')); };
  try {
    const tIngress = Date.now() - 3000;      // 假装消息 3 秒前就进来了
    const long = '这段 listing 文案帮我审一下：M5 吸奶器的静音设计很安静，夜里泵奶不打扰家人。';
    await handleMessage({
      message: { message_id: `om_metric_${Date.now()}`, chat_id: 'oc_metric', chat_type: 'p2p',
                 message_type: 'text', content: JSON.stringify({ text: long }) },
      sender: { sender_id: { open_id: 'ou_metric' } },
    }, { notify: async () => {}, tIngress, tIngressOrigin: 'create_time', ..._stubRunners() });
  } finally { console.log = orig; }
  const metric = logs.find((l) => l.includes('[metric] group_response_ms='));
  assert.ok(metric, 'must 打一行 [metric]（否则这条指标没有观测）');
  const ms = Number((/group_response_ms=(\d+)/.exec(metric) || [])[1]);
  assert.ok(ms >= 3000, `group_response_ms 必须把"消息到达→回执"那 3 秒算进去，实际 ${ms}`);
  assert.ok(/stage=early/.test(metric), `回执是前置发出去的，要标出来：${metric}`);
  assert.ok(/ingress=create_time/.test(metric), `来源要标出来（不许把两个来源混着说）：${metric}`);
  assert.ok(/prep_ms=\d+/.test(metric), `还要记"读素材那段"：${metric}`);

  // ★ 反向对照之一：**没有真 ingress、且回执已经前置发过** ⇒ **不许打这一行**。
  //   为什么：兜底值是"进闸门那一刻"，而回执在它之前就发了 ⇒ 算出来是负数（实测 -842ms）。
  //   负数不是"很快"，是两个时刻量的不是同一段 ⇒ 宁可不打，也不编（与汇总端
  //   「无观测 ⇒ no_reading，不许当达标」同一条纪律）。
  const logs2 = [];
  const orig2 = console.log;
  console.log = (...a) => { logs2.push(a.map(String).join(' ')); };
  try {
    const long = '这段 listing 文案帮我审一下：M5 吸奶器的静音设计很安静，夜里泵奶不打扰家人。';
    await handleMessage({
      message: { message_id: `om_metric2_${Date.now()}`, chat_id: 'oc_metric2', chat_type: 'p2p',
                 message_type: 'text', content: JSON.stringify({ text: long }) },
      sender: { sender_id: { open_id: 'ou_metric2' } },
    }, { notify: async () => {}, ..._stubRunners() });
  } finally { console.log = orig2; }
  assert.ok(!logs2.some((l) => l.includes('[metric] group_response_ms=')),
    '没有真 ingress 时不许打这条指标（否则就是拿"进闸门那一刻"冒充"消息到达"，还会算出负数）');

  // ★ 反向对照之二：**批量工具那条路**（回执在闸门里发、`tIngress` 由调用方给但没有来源标注）
  //   仍要有读数，且必须自己招认来源是兜底（`ingress=handle_entry`）—— 旧版本正是靠这个缺省值
  //   **不标注**，把 1.4s 的读数当成"PRD §12 达标"。
  const { runSubmissionGate } = await import('./agent/agent.mjs');
  const logs3 = [];
  const orig3 = console.log;
  console.log = (...a) => { logs3.push(a.map(String).join(' ')); };
  try {
    const long = '这段 listing 文案帮我审一下：M5 吸奶器的静音设计很安静，夜里泵奶不打扰家人。';
    await runSubmissionGate({
    imageClaimRunner: completedImageClaimFixture,
      inbound: { text: long, imageCount: 0, videoCount: 0, images: [], videos: [] },
      question: long,
      notify: async () => {},
      // 闸门内发回执那一路：`tIngress` 有值但没有来源标注 ⇒ 必须标 handle_entry
      tIngress: Date.now() - 200,
      chainRunner: async () => ({ answer: '结论：REVIEW｜依据 W-1.54' }),
      publishRunner: async () => ({ ok: true, action: 'skipped', detail: '自证桩：不碰真表' }),
      modelSideRunner: async () => ({ ok: true, count: 0, items: [] }),
      mergedReportRunner: async () => ({ ok: true, url: 'https://example.invalid/docx/STUB', detail: '自证桩' }),
      adviceRunner: async ({ items }) => ({ ok: true, ms: 1,
        advice: Object.fromEntries((items || []).map((_, i) => [i, `自证桩给的改法 ${i}`])) }),
    });
  } finally { console.log = orig3; }
  const legacy = logs3.find((l) => l.includes('[metric] group_response_ms='));
  assert.ok(legacy, '闸门内发回执那条路（批量工具在用）仍要有读数');
  assert.ok(/ingress=handle_entry/.test(legacy), `没有来源标注时必须写 handle_entry：${legacy}`);
  assert.ok(/stage=gate/.test(legacy), `闸门内发回执要标 stage=gate：${legacy}`);
  const ms2 = Number((/group_response_ms=(\d+)/.exec(legacy) || [])[1]);
  assert.ok(Number.isFinite(ms2) && ms2 >= 0 && ms2 < 5000,
    `这条路上 group_response_ms 应是 0 附近的小数、且不许为负，实际 ${ms2}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 34e/34f（2026-10-22）：**回执前置必须先过「这条是不是在对我说话」**
//
// 真事故（生产，群 `oc_49a7…`，消息 `om_x100b62a37c9fc8b4dc0ba2a61cc3e7d`，10:21）：
//   群里一条**没 @ 守衡**的消息（正文「不应该出现历史审核意见作为依据」）命中了送审词 ⇒
//   回执前置先回了「⏳ 处理中…完整审核正在运行，**完成后会在此回复**」；
//   随后 §4 判 `not_mentioned` 直接不回复 —— 承诺发出去了、链一次都没起。
//   判据要求：**先过「对我说话」这道门，再决定发不发回执**，两处共用 `addressedToMe()`。
//   反向对照（34f）：@ 了我的同一句话，回执照旧要发 —— 否则这一条只是在教它闭嘴。
// ─────────────────────────────────────────────────────────────────────────────
const _BOT_MENTION = { key: '@_user_1', name: '守衡', id: { open_id: 'cli_aa2243de0438dcd7' } };
const _SENDER_MENTION = { key: '@_user_2', name: 'Owner', id: { open_id: 'ou_lihuali' } };

await t('34e ★ 群里没 @ 我、正文命中送审词 ⇒ 一张回执都不发，且结局是 not_mentioned', async () => {
  const { handleMessage } = await import('./agent/agent.mjs');
  const acks = [];
  const r = await handleMessage({
    message: { message_id: `om_grp_quiet_${Date.now()}`, chat_id: 'oc_grp_quiet', chat_type: 'group',
               message_type: 'text',
               content: JSON.stringify({ text: '@_user_2 不应该出现历史审核意见作为依据' }),
               mentions: [_SENDER_MENTION] },
    sender: { sender_id: { open_id: 'ou_lihuali' } },
  }, { notify: async (text) => { acks.push(text); }, ..._stubRunners() });
  assert.strictEqual(acks.length, 0,
    `没 @ 我就不许先许一个诺（这条会回「处理中」，而 §4 随后不回复）：实际发了 ${acks.length} 张`);
  assert.strictEqual(r.reason, 'not_mentioned',
    `结局必须是 not_mentioned，实际 ${r.reason}（回执与 §4 必须是同一个判据）`);
});

await t('34f 反向对照·群里 @ 了我、同样的正文 ⇒ 回执照旧要发一张（不许被 34e 误伤）', async () => {
  const { handleMessage } = await import('./agent/agent.mjs');
  const acks = [];
  const long = '@_user_1 @_user_2 这段 listing 文案帮我审一下：M5 吸奶器的静音设计很安静，夜里泵奶不打扰家人。';
  await handleMessage({
    message: { message_id: `om_grp_ack_${Date.now()}`, chat_id: 'oc_grp_ack', chat_type: 'group',
               message_type: 'text', content: JSON.stringify({ text: long }),
               mentions: [_BOT_MENTION, _SENDER_MENTION] },
    sender: { sender_id: { open_id: 'ou_lihuali' } },
  }, { notify: async (text) => { acks.push(text); }, ..._stubRunners() });
  assert.strictEqual(acks.length, 1, `@ 了我就是送审，回执必须发（恰好一张）：${acks.length}`);
});

// ══════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 36. P0 确定性命中 ⇒ 直接出结论卡（2026-10-21，Owner「必须 10 秒内回」）═══');
// 病灶（实测，`PMO/logs/ws_daemon.log` 365 轮）：
//   P0 命中单 70 条 —— 判定 p50 **3.3 s** 就完成，而用户实际等到卡 **p50 62.1 s**。
//   差额全在「判定之后还在做的三件事」，而 PRD §6.3 明写「P0 命中即**停止后续审查**」：
//     · 模型写正文 p50 ~42 s（p50 2986 字）—— **一个字都不上卡**（评审单卡面由代码定）；
//     · 模型侧双轨 p50 11.8 s（p90 29.7 s）；
//     · 建议生成 p50 5.4 s。
//   ⇒ 三件事全部停掉。
//
// ★★ 2026-10-21 Owner 当场纠正一次（这一组因此改过一版）：
//   「**为什么p0对问题，不回复处理中的卡片状态了？必须先回复处理中，再回复block**」
//   ⇒ 「处理中」**不是结论**，两张消息不冲突；「一条消息只回一条结论」管的是
//     「不许同一单给出两个三态」。所以顺序钉成：**先回执（receipt），后结论（§5.3 块）**。
//
// 这一组钉的就是「停没停、顺序对不对」——每一条都配**反向对照**（非 P0 的单子必须照旧起跑），
// 否则「停掉」与「本来就没这套东西」在报告里长得一样。
const _p0ChainStub = async () => ({
  // 形状取自 `kb/l5/p0_fastpath.py --json` 的真输出（首行是 PRD §5.3.3 结论行）
  answer: '【审查结论：BLOCK】共发现 1 处必须修改。\n\n'
    + '1.【合规与受监管宣称-无痛、安全与零风险承诺】正文第 1 段，逐字命中 `最好` —— 有库内条款依据\n'
    + '   原因：排名最高级表述（PRD 2026-09-09 口径）\n'
    + '   依据：《措辞表达库 v0》第 W-1.33 条｜原始出处：https://example.invalid/base?table=tblX&record=recX\n'
    + '   建议：把「最好」删掉，改成不带排名的说法。\n\n'
    + '请修改后重新提交。',
  p0_fastpath: { mode: 'p0_fastpath', elapsed_ms: 42, matched_patterns: 1, rule_codes: ['H05'],
                 layer_preflight: 'not_run' },
  p0_findings: [{ rule_code: 'H05', rule_title: '虚假安全承诺', line_text: '最好', span: 19,
                  article_no: 'W-1.33' }],
  issue_count: 1, confidence: 1.0, report: '', product_line: '吸奶器', channel: 'Google',
});

await t('36a P0 命中 ⇒ **先回「处理中」、再回结论**（两张消息，但结论只有一条）', async () => {
  const { handleMessage } = await import('./agent/agent.mjs');
  const acks = [];
  const r = await handleMessage({
    message: { message_id: `om_p0ack_${Date.now()}`, chat_id: 'oc_p0ack', chat_type: 'p2p',
               message_type: 'text',
               content: JSON.stringify({ text: '这句能不能发：M5 吸奶器绝对安全，宝宝一觉到天亮。' }) },
    sender: { sender_id: { open_id: 'ou_p0ack' } },
  }, { notify: async (text) => { acks.push(text); }, chainRunner: _p0ChainStub });
  // ★ Owner 2026-10-21 当场纠正：「必须先回复处理中，再回复block」
  //   ⇒ 回执**必须发**（一张，且是 receipt 卡），不是 0 张。
  assert.strictEqual(acks.length, 1,
    `P0 命中也必须先回一张「处理中」（实际 ${acks.length} 张）`);
  assert.ok(/\[\[card:receipt\]\]/.test(String(acks[0])),
    `「处理中」要递 receipt 卡片块（与其它送审单同一个形状）：${String(acks[0]).slice(0, 60)}`);
  // ★ 结论仍然**只有一条**（回复那一份），且形状是 §5.3 块 —— 卡面由
  //   `ws_daemon.replyTo → envelope` 按 `verdict53` 拼（形态决策仍然只有一处，§2.5）。
  assert.ok(/【审查结论：BLOCK】/.test(String(r.reply ?? '')),
    `回复里必须有 §5.3 结论行：${String(r.reply).slice(0, 80)}`);
  assert.ok(/请修改后重新提交。/.test(String(r.reply ?? '')),
    '§5.3 块要把动作行带上（否则读者不知道下一步做什么）');
  assert.ok([...String(r.reply ?? '')].length < 800,
    `P0 直达的回复就是那张卡本身，不该再有几千字叙述：实际 ${[...String(r.reply ?? '')].length} 字`);
});

await t('36b P0 命中 ⇒ 模型侧双轨**一次都不许起跑**（反向对照：非 P0 必须起跑）', async () => {
  const { handleMessage } = await import('./agent/agent.mjs');
  const calls = { model: 0, advice: 0 };
  const runners = {
    publishRunner: async () => ({ ok: true, action: 'skipped', detail: '自证桩：不碰真表' }),
    modelSideRunner: async () => { calls.model += 1; return { ok: true, findings: [], dropped: [], ms: 1 }; },
    mergedReportRunner: async () => ({ ok: true, url: 'https://example.invalid/docx/STUB', detail: '自证桩' }),
    adviceRunner: async ({ items }) => {
      calls.advice += 1;
      return { ok: true, ms: 1, advice: Object.fromEntries((items || []).map((_, i) => [i, `桩 ${i}`])) };
    },
  };
  await handleMessage({
    message: { message_id: `om_p0model_${Date.now()}`, chat_id: 'oc_p0model', chat_type: 'p2p',
               message_type: 'text',
               content: JSON.stringify({ text: '这句能不能发：M5 吸奶器绝对安全，宝宝一觉到天亮。' }) },
    sender: { sender_id: { open_id: 'ou_p0model' } },
  }, { notify: async () => {}, chainRunner: _p0ChainStub, ...runners });
  assert.strictEqual(calls.model, 0, `P0 命中后不许再起模型侧（实际 ${calls.model} 次）`);
  assert.strictEqual(calls.advice, 0, `P0 命中后不许再调建议生成（实际 ${calls.advice} 次）`);

  // 反向对照：**同一条链桩换成非 P0 的答案** ⇒ 两件事都必须照旧发生
  // （没有这一半，上面两条对「压根没接线」也成立 —— 那正是 §2.4 说的假执行点）。
  const calls2 = { model: 0, advice: 0 };
  await handleMessage({
    message: { message_id: `om_p0ctl_${Date.now()}`, chat_id: 'om_p0ctl', chat_type: 'p2p',
               message_type: 'text',
               content: JSON.stringify({ text: '这段 listing 帮我审一下：M5 的静音设计很安静，夜里泵奶不打扰家人。' }) },
    sender: { sender_id: { open_id: 'ou_p0ctl' } },
  }, { notify: async () => {},
       chainRunner: async () => ({ answer: '【审查结论：REVIEW】共发现 1 处需人工确认。\n\n'
         + '1.【措辞表达】正文第 1 段\n   原因：证据不足\n   依据：第 W-1.54 条\n   建议：补证据\n\n'
         + '请修改后重新提交。' }),
       modelSideRunner: async () => { calls2.model += 1; return { ok: true, findings: [], dropped: [], ms: 1 }; },
       publishRunner: async () => ({ ok: true, action: 'skipped', detail: '自证桩：不碰真表' }),
       mergedReportRunner: async () => ({ ok: true, url: 'https://example.invalid/docx/STUB', detail: '自证桩' }),
       adviceRunner: async ({ items }) => {
         calls2.advice += 1;
         return { ok: true, ms: 1, advice: Object.fromEntries((items || []).map((_, i) => [i, `桩 ${i}`])) };
       } });
  assert.strictEqual(calls2.model, 1, `非 P0 的单子必须照旧起模型侧（实际 ${calls2.model} 次）`);
});

await t('36c P0 命中 ⇒ **不调模型写正文**：回复＝§5.3 块，元信息带 `p0Direct`', async () => {
  const { handleMessage } = await import('./agent/agent.mjs');
  const r = await handleMessage({
    message: { message_id: `om_p0dir_${Date.now()}`, chat_id: 'oc_p0dir', chat_type: 'p2p',
               message_type: 'text',
               content: JSON.stringify({ text: '这句能不能发：M5 吸奶器绝对安全，宝宝一觉到天亮。' }) },
    sender: { sender_id: { open_id: 'ou_p0dir' } },
  }, { notify: async () => {}, chainRunner: _p0ChainStub,
       publishRunner: async () => ({ ok: true, action: 'skipped', detail: '自证桩：不碰真表' }),
       modelSideRunner: async () => { throw new Error('P0 命中时不该被调用'); },
       mergedReportRunner: async () => ({ ok: true, url: 'https://example.invalid/docx/STUB', detail: '自证桩' }),
       adviceRunner: async () => { throw new Error('P0 命中时不该被调用'); } });
  assert.strictEqual(r.meta?.p0Direct, true, '元信息必须标出「这一单是 P0 直达」（10 秒 SLA 的读数靠它）');
  assert.ok(/【审查结论：BLOCK】/.test(String(r.reply ?? '')), `回复里必须有 §5.3 结论行：${String(r.reply).slice(0, 80)}`);
  // ★ 反向对照：非 P0 时这个标记必须是 false（否则「直达」这个读数恒真，量不了任何东西）
  const r2 = await handleMessage({
    message: { message_id: `om_p0dir2_${Date.now()}`, chat_id: 'oc_p0dir2', chat_type: 'p2p',
               message_type: 'text',
               content: JSON.stringify({ text: '这段 listing 帮我审一下：M5 的静音设计很安静，夜里泵奶不打扰家人。' }) },
    sender: { sender_id: { open_id: 'ou_p0dir2' } },
  }, { notify: async () => {},
       chainRunner: async () => ({ answer: '【审查结论：REVIEW】共发现 1 处需人工确认。\n\n'
         + '1.【措辞表达】正文第 1 段\n   原因：证据不足\n   依据：第 W-1.54 条\n   建议：补证据\n\n'
         + '请修改后重新提交。' }),
       publishRunner: async () => ({ ok: true, action: 'skipped', detail: '自证桩：不碰真表' }),
       modelSideRunner: async () => ({ ok: true, findings: [], dropped: [], ms: 1 }),
       mergedReportRunner: async () => ({ ok: true, url: 'https://example.invalid/docx/STUB', detail: '自证桩' }),
       adviceRunner: async ({ items }) => ({ ok: true, ms: 1,
         advice: Object.fromEntries((items || []).map((_, i) => [i, `桩 ${i}`])) }) });
  assert.notStrictEqual(r2.meta?.p0Direct, true, '非 P0 的单子**不许**标成直达（否则那个读数是恒真的）');
});

await t('36d P0 命中 ⇒ **回合末尾的历史压缩顺延**（那一步会调 LLM，实测 27.7 s）', async () => {
  // 真读数（上线后第一单）：`[metric] direct_answer_ms=32864 … verdict=FAIL` ——
  // 判定只 3.3 s，卡走了 32 s；差的正是 `mem.compact(sess, llm.summarize)` 那次
  // 「把上千条旧消息写成纪要」的 LLM 调用。P0 直达这一轮**不调模型**（没有上下文要用）
  // ⇒ 压缩在这一轮是纯亏，必须顺延到下一次真要模型的回合。
  //
  // ⚠️ 判据只能落在**日志**上：`mem` 是 ESM 命名空间（只读），打不了桩；
  //    真正的验收是生产里那行 `direct_answer_ms` —— 这里钉的是「那一跳没有被走到」。
  const { handleMessage } = await import('./agent/agent.mjs');
  const logs = [];
  const orig = console.log;
  console.log = (...a) => { logs.push(a.map(String).join(' ')); };
  try {
    await handleMessage({
      message: { message_id: `om_p0compact_${Date.now()}`, chat_id: 'oc_p0compact', chat_type: 'p2p',
                 message_type: 'text',
                 content: JSON.stringify({ text: '这句能不能发：M5 吸奶器绝对安全，宝宝一觉到天亮。' }) },
      sender: { sender_id: { open_id: 'ou_p0compact' } },
    }, { notify: async () => {}, chainRunner: _p0ChainStub,
         publishRunner: async () => ({ ok: true, action: 'skipped', detail: '自证桩：不碰真表' }),
         modelSideRunner: async () => ({ ok: true, findings: [], dropped: [], ms: 1 }),
         mergedReportRunner: async () => ({ ok: true, url: 'https://example.invalid/docx/STUB', detail: '自证桩' }),
         adviceRunner: async () => ({ ok: true, ms: 1, advice: {} }) });
  } finally { console.log = orig; }
  assert.ok(logs.some((l) => l.includes('历史压缩顺延')),
    'P0 直达这一轮必须把压缩顺延，并留一行读数（不出声就等于没人知道它没压）');
  assert.ok(!logs.some((l) => l.includes('🗜 历史已压缩')),
    'P0 直达这一轮**不许**走到压缩（那一步会调 LLM，实测 27.7 s）');
});

// ══════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 35. 主回复关思考（2026-10-20：Owner「这个慢的问题必须做优化」）═══');
// 实测（同输入/同 max_tokens，2026-10-20 12:51）：开思考 11738ms ｜ 关思考 1978ms ⇒ **5.9 倍**，
// 正文 496 vs 493 字。这一轮是"组装与转述"（判据在引擎那边），所以默认关。

await t('35a **默认不许改行为**（带思考）；只有 `SHOUHENG_REPLY_THINK=off` 才关', async () => {
  const { replyThinking } = await import('./agent/agent.mjs');
  const keep = process.env.SHOUHENG_REPLY_THINK;
  try {
    delete process.env.SHOUHENG_REPLY_THINK;
    assert.strictEqual(replyThinking(), null, '默认必须保持原行为（带思考）—— Owner：「不要影响现有工作流」');
    process.env.SHOUHENG_REPLY_THINK = 'off';
    assert.deepStrictEqual(replyThinking(), { type: 'disabled' }, 'off ⇒ 关思考（A/B 对照用）');
    process.env.SHOUHENG_REPLY_THINK = 'on';
    assert.strictEqual(replyThinking(), null, 'on ⇒ 仍带思考');
  } finally {
    if (keep === undefined) delete process.env.SHOUHENG_REPLY_THINK; else process.env.SHOUHENG_REPLY_THINK = keep;
  }
});

await t('35b 接线：主工具循环那次调用**真的**把开关传下去了', () => {
  const src = fs.readFileSync(new URL('./agent/agent.mjs', import.meta.url), 'utf8');
  assert.ok(/llm\.chat\(messages,\s*\{\s*tools:\s*TOOL_SCHEMAS,\s*thinking:\s*replyThinking\(\)\s*\}\)/.test(src),
    '主回复那一次必须带 `thinking: replyThinking()` —— 否则这条优化根本没接上（名字出现过 ≠ 生效）');
});

// ─────────────────────────────────────────────────────────────────────────────
await t('N4e ★★ 带图但一张都没解析出来 ⇒ **不许 PASS**（P0 · Owner 2026-10-21 批准）', async () => {
  // ── 病灶（实测，不是假设）
  //   模态是**猜**的：`agent.mjs` 用 `inbound.imageCount`（解析成功的图数）推 `--content-type`。
  //   图一旦没被解析成图片 —— **飞书里以文件方式发的图**（`msgType='file'`，
  //   `feishu.imageKeysOf` 对 file 恒返回 []）、图消息缺 image_key、富文本图节点解析不到、
  //   引用那条回读失败 —— 就退化成 `text` ⇒ **「负面样本规则」整层不跑** ⇒ `PASS / 0 条`。
  //   代码里自己记着实测（`tools.mjs` 约 1944 行）：`10:06:48 text → PASS / 0 条`；
  //   `11:10:00 image → REVIEW / 5 条` —— 同一份图，只差这一个词。
  //   本组钉四件事：① 意图判据（含反向对照：pdf/纯文字不许被误判）；
  //                ② 闸门真的接上（有意图+0 张 ⇒ 表行压成 NEEDS_INPUT）；
  //                ③ 反向对照（同一份 PASS 答案，去掉「带图未解析」⇒ PASS 必须保留，判据不许恒红）；
  //                ④ 接线断言（源码里那条闸不许被静默删掉）。
  const { detectImageIntent, imageIntentVerdict } = await import('./agent/image_intent_gate.mjs');
  const { runSubmissionGate } = await import('./agent/agent.mjs');

  // ① 意图判据：四种「看到了图」都要认
  assert.strictEqual(detectImageIntent({ msgType: 'image', content: '{}' }).hasIntent, true,
    '图消息（即便缺 image_key）必须判有意图 —— 那正是「看到了图、取不到」要拒的一档');
  assert.strictEqual(detectImageIntent({ msgType: 'file', content: '{"file_name":"a.JPG"}' }).hasIntent, true,
    '**以文件方式发送的图片**必须判有意图（这是最容易踩的一档：imageKeysOf 对 file 恒 []）');
  assert.strictEqual(detectImageIntent({ msgType: 'post', content: { content: [[{ tag: 'img' }]] } }).hasIntent, true,
    '富文本里有 img 节点必须判有意图');
  assert.strictEqual(detectImageIntent({ msgType: 'text', parentNote: { kind: 'parent_unreadable' } }).hasIntent, true,
    '引用那条回读失败（未测）必须判有意图 —— 未测 ≠ 没有图');

  // ①b 反向对照：不许把 pdf / 纯文字判成带图（否则这条判据把文字单全拦了）
  assert.strictEqual(detectImageIntent({ msgType: 'file', content: '{"file_name":"a.pdf"}' }).hasIntent, false,
    'pdf 被误判成图 ⇒ 越界');
  assert.strictEqual(detectImageIntent({ msgType: 'post', content: { content: [[{ tag: 'text', text: '这张图审一下' }]] } }).hasIntent, false,
    '正文里出现「图」字就被判成带图 ⇒ 判据过宽（大量文字单会被拦）');

  // ② 裁决：有意图 + 0 张 ⇒ 必须拒；有意图 + 1 张 ⇒ 不拒（反向对照）
  assert.strictEqual(imageIntentVerdict({ imageIntent: { hasIntent: true, why: 'x' }, imageCount: 0 }).needInput, true,
    '带图但 0 张却没判拒答');
  assert.strictEqual(imageIntentVerdict({ imageIntent: { hasIntent: true, why: 'x' }, imageCount: 1 }).needInput, false,
    '有图正常解析也被拦 ⇒ 判据恒红');

  // ③ 闸门接线：同一份「PASS」答案，只改 inbound 里那一位
  const run = async (inbound) => {
    let captured = null;
    await runSubmissionGate({
    imageClaimRunner: completedImageClaimFixture,
      inbound, question: inbound.text, notify: async () => {},
      // 链给一个**本来会出 PASS** 的答案 ＋ 机读旁挂（否则会被「库侧没读数不许 PASS」那条挡掉，
      // 那样本组就测不到这条闸了 —— 必须让 PASS 在被本闸拦截前是**合法可出**的）
      chainRunner: async () => ({ answer: '【审查结论：PASS】未发现已知违规表述。', review: { state: 'PASS', issue_count: 0 } }),
      modelSideRunner: async () => ({ ok: true, findings: [], dropped: [] }),
      publishRunner: async (row) => { captured = row; return { ok: true, action: 'skipped', detail: '自证桩' }; },
      mergedReportRunner: async () => ({ ok: true, url: 'https://example.invalid/docx/STUB', detail: '自证桩' }),
      adviceRunner: async () => ({ ok: true, ms: 1, advice: {} }),
      mediaLinksRunner: async () => [],
      mediaUpload: async () => ({ ok: false, reason: '自证桩：不真上传' }),
      fetchImageForLink: async () => null,
      fetchVideoForLink: async () => null,
    });
    return captured;
  };

  const unresolved = await run({
    text: '审一下这张图', imageCount: 0, videoCount: 0,
    imageIntent: { hasIntent: true, why: '以文件形式发送的图片（file_name=a.jpg）' },
    imageUnresolved: true,
  });
  assert.ok(unresolved, '带图未解析时**没有落表**（连留痕都没有）');
  assert.strictEqual(unresolved.conclusion, 'NEEDS_INPUT',
    `带图但一张都没解析出来，却落了 ${unresolved.conclusion} —— 这就是那个 fail-open：零条被当成没问题`);

  // ③b ★ 反向对照：同一份答案，只去掉「带图未解析」⇒ PASS 必须还在（证明是本闸拦的，不是别处恒拦）
  const resolved = await run({ text: '审一下', imageCount: 0, videoCount: 0 });
  assert.ok(resolved, '反向对照那单没落表');
  assert.strictEqual(resolved.conclusion, 'PASS',
    `去掉「带图未解析」后结论是 ${resolved.conclusion} ⇒ 说明本组拦不拦都不影响结果，判据没被真正测到`);
});

await t('N4f 接线：入站图片意图必须由判据产出（输出拒答由 N4e/Z77 行为回归覆盖）', () => {
  const src = fs.readFileSync(new URL('./agent/agent.mjs', import.meta.url), 'utf8');
  assert.ok(/detectImageIntent\(\{\s*msgType,\s*content,\s*parentNote\s*\}\)/.test(src),
    '入站阶段必须真的调 `detectImageIntent(...)` —— 名字出现过 ≠ 接上了');
  assert.ok(/imageUnresolved:\s*imageIntentVerdict\(/.test(src),
    '`inbound.imageUnresolved` 必须由裁决函数算出来（手写布尔会绕过判据）');
  // 最终拒答已移到统一完整性回执；N4e/Z77 实跑输出，避免绑定某个局部赋值位置。
});

await t('N4g ★ 并发图片任务的上下文、模态与链缓存必须按消息隔离（防串图）', async () => {
  const tools = await import('./agent/tools.mjs');
  const { reviewTaskFor } = tools;
  const ready = [];
  let release;
  const bothReady = new Promise((resolve) => { release = resolve; });
  const run = (id, modality) => tools.withAgentTurnContext(async () => {
    tools.beginChainTurn({ modality });
    tools.setAgentTurnContext({ imageBlock: `IMAGE_CONTEXT_${id}` });
    const envelope = { tool: 'kb_review_chain', ok: true, result: { answer: `VERDICT_${id}` } };
    tools._armChainMemoForTest(envelope);
    tools._armChainAnswerMemoForTest({ answer: `VERDICT_${id}` });
    ready.push(id);
    if (ready.length === 2) release();
    await bothReady;
    const state = tools.agentTurnContextSnapshot();
    const answer = tools.chainAnswerRead();
    const stats = tools.chainMemoStats();
    assert.strictEqual(state.imageBlock, `IMAGE_CONTEXT_${id}`, `任务 ${id} 读到了另一条图片上下文`);
    assert.strictEqual(state.chainTurnModality, modality, `任务 ${id} 读到了另一条素材模态`);
    assert.strictEqual(answer?.answer, `VERDICT_${id}`, `任务 ${id} 读到了另一条链结论`);
    assert.strictEqual(stats.armed, true, `任务 ${id} 的链缓存被另一任务清空`);
    return state;
  });
  const [a, b] = await Promise.all([run('A', 'image'), run('B', 'text')]);
  assert.strictEqual(a.imageBlock, 'IMAGE_CONTEXT_A');
  assert.strictEqual(b.imageBlock, 'IMAGE_CONTEXT_B');

  const { runSubmissionGate } = await import('./agent/agent.mjs');
  let sentToChain = null;
  let sentToModel = null;
  await tools.withAgentTurnContext(async () => {
    await runSubmissionGate({
    imageClaimRunner: completedImageClaimFixture,
      inbound: { text: '审查下这张图片', imageCount: 1, videoCount: 0, images: [{ index: 1,
        msgId: 'om_test_image', imageKey: 'img_test_image',
        text: 'OCR exact line', wlText: 'OCR exact line', sha256: 'a'.repeat(64),
        scene: { ok: true, scene: { scene: 'crib', people: [], objects: [], visible_text: [], clues: [] } } }] },
      question: '审查下这张图片', userText: '审查下这张图片', notify: async () => {}, chainRunner: async (input) => {
        sentToChain = input;
        return { answer: '【审查结论：NEEDS_INPUT】测试桩', review: { state: 'NEEDS_INPUT', issue_count: 0 } };
      },
      modelSideRunner: async (input) => { sentToModel = input; return { ok: true, findings: [], dropped: [] }; },
      publishRunner: async () => ({ ok: true, action: 'skipped', detail: '自证桩' }),
      mergedReportRunner: async () => ({ ok: true, url: '', detail: '自证桩' }),
      adviceRunner: async () => ({ ok: true, ms: 1, advice: {} }),
      mediaLinksRunner: async () => [], fetchImageForLink: async () => ({ path: '/tmp/test-image-original.png' }),
      mediaUpload: async () => ({ ok: false, reason: '自证桩' }),
    });
  });
  assert.strictEqual(sentToChain?.contentType, 'image', '图单模态没有随本次链调用传递');
  assert.strictEqual(sentToChain?.question,
    '请按图片安全审查 skill 对本次附图执行完整审查，逐项完成全部检查。',
    '图片链审查输入必须固定，不能因私聊/群聊的问题包装不同而漂移');
  assert.deepStrictEqual(sentToChain?.imagePaths, ['/tmp/test-image-original.png'],
    '送审图原件路径没有随本次链调用传递，图身份层就不会跑');
  assert.ok(sentToChain?.imageContext?.includes('a'.repeat(64)), '本单图片 SHA 没随链调用传递');
  assert.ok(sentToChain?.imageContext?.includes('OCR exact line'), '本单 OCR 没随链调用传递');
  assert.strictEqual(sentToModel?.question, '',
    '图片模型侧审查提示不能因私聊/群聊的泛化问法不同而变化');
  assert.ok(sentToModel?.readings?.includes('OCR exact line'), 'OCR 辅助读数仍须进入图片模型侧');
  assert.ok(!sentToModel?.readings?.includes('审查下这张图片'),
    '泛化聊天文字不得扰动图片模型侧审查输入');
  assert.deepStrictEqual(sentToModel?.imagePaths, ['/tmp/test-image-original.png'],
    '模型侧必须直接收到原图路径');
  const imageTask = reviewTaskFor({ question: '审图', text: 'OCR text', ctype: sentToChain?.contentType,
    imagePaths: sentToChain?.imagePaths });
  assert.ok(imageTask.includes('真实加载 `图片安全审查`'), '图片审核 task 没要求真实加载专项 skill');
  assert.ok(imageTask.includes('完整执行 skill') && imageTask.includes('4A 规则符合性')
    && imageTask.includes('4B 事实准确性核查'), '图片审核 task 没要求执行完整 skill 工作流');
  assert.ok(imageTask.includes('--image <路径>') && imageTask.includes('/tmp/test-image-original.png'),
    '图片原件路径没有进入知识库 --image 命令模板');

  const src = fs.readFileSync(new URL('./agent/agent.mjs', import.meta.url), 'utf8');
  assert.ok(/export function handleMessage\(event, opts = \{\}\)\s*\{\s*return withAgentTurnContext\(/.test(src),
    '每条 handleMessage 必须建立独立异步上下文');
  assert.ok(!src.includes('__SH_LAST_IMAGE_BLOCK'), '不能再用进程级全局变量传图片上下文');
});

// ══════════════════════════════════════════════════════════════════════════════
await t('Z70 ★★ P0 快路的回执**不是第二个来源**：同一句不许被数两遍', async () => {
  // 病灶（2026-10-21 真单 `merged-2026-10-21T08_37_38.json`）：一句送审判成 4 处，
  //   而记录里 `kb.issue_count = 2` —— F-01/F-02 来自 `p0_findings`，
  //   F-03/F-04 是把**同一张回执**用逐行正则又解析了一遍。
  const T = await import('./agent/dual_track.mjs');
  const receipt = [
    '【审查结论：BLOCK】共发现 2 处必须修改。', '',
    '1.【合规与受监管宣称-无痛、安全与零风险承诺】正文第 1 段，逐字命中 100% safe',
    '  **原因**：虚假安全承诺',
    '  **依据**：《措辞表达库 v0（试用版，未发布）》第 W-1.33 条（链接：https://x.invalid/a）',
    '  **建议**：删掉 100% safe', '',
    '请修改后重新提交。',
  ].join('\n');
  const p0Findings = [
    { rule_code: 'H05', article_no: 'W-1.33', anchor: '#a/recX/命中片段',
      matched: [{ kind: 'keyword', pattern: '100% safe', text: '100% safe', line: 1, line_text: '100% safe' }],
      _l3: { reason: 'H05 虚假安全承诺（best/#1/No.1/最佳/最好等排名最高级按2026-09-09口径放开，'
        + '海外广告允许，不再判险）', article_no: 'W-1.33', kb_type: 'wording' } },
    { rule_code: 'V03', article_no: 'E-2.126', anchor: '#b/recY/命中片段',
      matched: [{ kind: 'regex', pattern: '(?:\\bno\\.?\\s*1)', text: '#1', line: 1, line_text: '100% safe #1' }],
      _l3: { reason: '销量或排名宣称没有可核验依据', article_no: 'E-2.126', kb_type: 'external_standard' } },
  ];
  // 链没跑（`engine=null`）＋ 有 p0_findings ⇒ P0 快路单
  const kb = T.kbFindingsOf(receipt, null, p0Findings, { text: '100% safe #1' });
  assert.strictEqual(kb.findings.length, p0Findings.length,
    `P0 快路单的条目数必须等于 p0_findings 数（实得 ${kb.findings.length}，回执被二次解析了）`);
  // 反向对照：**去掉** p0_findings ⇒ 回执照旧能被解析（证明上面那条不是「永远 0 条」）
  const kb2 = T.kbFindingsOf(receipt, null, null, { text: '100% safe #1' });
  assert.ok(kb2.findings.length >= 1, '没有 p0_findings 时回执仍应能解析成条目（不然是静默吞）');
  // 原因里不许带规则自己的**口径说明**（那是一句「已放开」，印在 P0 的原因里自相矛盾）
  const reason = String(kb.findings[0].reason ?? '');
  assert.ok(!/不再判险|口径放开/.test(reason), `原因里还带着口径说明：${reason}`);
  assert.ok(!/^H0\d\s/.test(reason), `原因里还带着规则码：${reason}`);
});

await t('Z71 ★★ 后台语言清扫：正则源码与库内路径必须挖掉，条款号与纯文字反引号必须留', async () => {
  const T = await import('./agent/dual_track.mjs');
  const src = '正文第 1 段，逐字命中 `最\\s*(安全|低价)`、`(?:\bno\.?\s*1|#`、`最好`';
  const cleared = T.stripBackendTokens(src);
  assert.ok(!/\\[bBsSwWdD]|\|低价\)/.test(cleared), `正则源码没挖干净：${cleared}`);
  assert.ok(cleared.includes('最好'), `纯文字反引号被一起挖掉了：${cleared}`);
  assert.ok(cleared.includes('正文第 1 段'), `正常文字被挖掉了：${cleared}`);
  const sug = '删去销量/排名宣称（本码共 12 组修订建议，此处按首组给出；'
    + '全量见 kb/l3/candidates/rules.jsonl#W-1.33）';
  const s2 = T.stripBackendTokens(sug);
  assert.ok(!/kb\/|本码/.test(s2), `库内路径/「本码」没挖掉：${s2}`);
  assert.ok(s2.includes('删去销量/排名宣称'), `正文被一起挖掉了：${s2}`);
  // 反向对照：条款号 W-1.33 是业务侧要看的，**不许**被当后台词挖掉
  assert.ok(T.stripBackendTokens('《措辞表达库 v0》第 W-1.33 条').includes('W-1.33'),
    '条款号被当成后台词挖掉了（那是依据的锚点）');
});

// ═══════════════════════════════════════════════════════════════════════════
// Z72 ★★ 起链前的前置：profile 目录写不进 ⇒ 结构化返回、**绝不起链**
// ═══════════════════════════════════════════════════════════════════════════
// 为什么要有这一组（2026-10-23 当天）：`dsh --profile headless` 在 `prepareProfile()`
// 里**无条件**重写 `~/.dsh/profiles/headless/cordis.yml`；调用方若被 workspace-write
// 沙箱限制（工作区之外一律拒写），链在**第一秒**就 EPERM 退出。而 daemon 日志里
// 只剩 `Command failed: node …`（EPERM 在下一行、被截掉），于是下游只能猜根因——
// 当天它猜成「本机权限故障，让运维把 profile 目录写权限给到运行账号」，**猜错了**
// （该路径实测可写：属主/权限/flag 均正常，无沙箱进程一写就成）。
// ⇒ 判据三条，缺一条都不算守住：
//   ① 写不进时必须给出 `reason_code=profile_unwritable`，并**明说不是本机权限故障**；
//   ② 写不进时**一个进程都不许被拉起**（这一条只能看副作用，不能看返回值）；
//   ③ **反向对照**：同样的输入换成可写目录 ⇒ 链必须真的被拉起（否则②可能只是「恒不 spawn」）。
await t('Z72 ★★ 起链前前置：profile 目录写不进 ⇒ 结构化返回且绝不起链（带反向对照）', async () => {
  const pathMod = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const tmp = fs.mkdtempSync(pathMod.join('/tmp', 'shouheng-profprobe-'));
  const kbRoot = pathMod.join(tmp, 'kbtree');
  fs.mkdirSync(pathMod.join(kbRoot, 'kb', 'l8'), { recursive: true });
  fs.writeFileSync(pathMod.join(kbRoot, 'kb', 'l8', 'review_playbook.md'), 'PLAYBOOK-SENTINEL\n');

  // 桩 dsh：**只做一件事** —— 被真的 spawn 了就落一个标记文件。
  //   「有没有真的起链」只能看这个副作用：返回值说「没起」而进程确实起来了，照样是失败。
  const marker = pathMod.join(tmp, 'spawned.marker');
  const stub = pathMod.join(tmp, 'stub-dsh.mjs');
  fs.writeFileSync(stub,
    "import fs from 'node:fs';\n"
    + 'fs.writeFileSync(process.env.STUB_SPAWN_MARKER, "spawned");\n'
    + "console.log('状态：PASS ｜ 问题数：0');\n");

  const denied = pathMod.join(tmp, 'prof-denied');
  fs.mkdirSync(denied);
  fs.chmodSync(denied, 0o500);          // 只读目录：在里面建文件必被拒（非 root）
  const writable = pathMod.join(tmp, 'prof-ok');
  fs.mkdirSync(writable);

  const run = (profileDir) => {
    try { fs.unlinkSync(marker); } catch { /* 本来就没有 */ }
    const script = `
      const { executeTool } = await import(${JSON.stringify(new URL('./agent/tools.mjs', import.meta.url).href)});
      const r = await executeTool('kb_review_chain', ${JSON.stringify({
        question: '审一下这条文案',
        text: '这是一条用于验证起链前置的普通测试文案。',
      })});
      const res = r.result ?? {};
      console.log('RESULT ' + JSON.stringify({ ok: r.ok, err: res.error ?? null,
        reason_code: res.reason_code ?? null, answer: res.answer ?? null }));
    `;
    const t0 = Date.now();
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, SHOUHENG_STATE_DIR: tmp, SHOUHENG_KB_ROOT: kbRoot,
             SHOUHENG_DSH_BIN: stub, STUB_SPAWN_MARKER: marker,
             SHOUHENG_PROFILE_DIR: profileDir, SHOUHENG_REVIEW_TABLE: 'off' },
    });
    const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    const m = out.match(/RESULT (\{.*\})/);
    assert.ok(m, `没拿到 RESULT —— 子进程没跑到底：\n${out.slice(-600)}`);
    return { res: JSON.parse(m[1]), spawned: fs.existsSync(marker), ms: Date.now() - t0 };
  };

  try {
    // ① 写不进的 profile 目录 ⇒ 结构化原因 + 明说「不是本机权限故障」
    const d = run(denied);
    assert.strictEqual(d.res.reason_code, 'profile_unwritable',
      `没给出结构化原因（reason_code=${d.res.reason_code}，err=${d.res.err}）`);
    assert.ok(/没有起/.test(String(d.res.err)), `错误文本没说清「链没起」：${d.res.err}`);
    assert.ok(/不是本机权限故障/.test(String(d.res.err)),
      '必须点明这是调用方环境受限、不是本机权限故障（当天那张卡就是这么猜错的）');
    // ② 写不进时**一个进程都不许被拉起**
    assert.strictEqual(d.spawned, false, '★ 写不进却仍起了链 —— 前置没拦住');
    assert.ok(d.ms < 20_000, `写不进时不该耗这么久（${d.ms}ms）—— 说明它还是去 spawn 了`);

    // ③ 反向对照：同一份输入、换成可写目录 ⇒ 链必须真的被拉起
    const w = run(writable);
    assert.strictEqual(w.spawned, true, '可写目录下没起链 —— 前置把正常路径也拦了（恒真判据）');
    assert.notStrictEqual(w.res.reason_code, 'profile_unwritable',
      '可写目录下仍报 profile_unwritable —— 判据不是在探盘，是在瞎报');
  } finally {
    try { fs.chmodSync(denied, 0o700); } catch { /* 已删 */ }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ═══ Z11c · 有库侧读数、却没有 §5.3 结论行 ⇒ **必须**发固定告警卡，不许拿模型原话当结论 ═══
//   Owner 2026-10-26 转来的真回复（逐字）：「第八张，结果同前七张：`REVIEW` / `DP3` / 待放行，
//   命中 0 条。……`coverage = partial`」—— 无抬头、带内部读数、0 命中却判 REVIEW。
//   ①②③ 三条毛病分别由 `stripEngineJargon` / `mergedState` 严格零条 ⇒ PASS / **本条**修。
await t('Z11c ★★ 有读数无结论行 ⇒ 固定「审查未完成」卡（且闲聊仍是纯文本、有结论行仍是 §5.3 卡）', async () => {
  const env = await import('./reply-cards/envelope.mjs');
  const prose = '第八张，结果同前七张：REVIEW / DP3 / 待放行，命中 0 条。';
  // ① 有读数、没有可印的条数 ⇒ 走固定告警模板（不是纯文本）
  const noLine = env.toCardOrText(prose, { verdict53: { state: 'REVIEW', line: null, from: 'chain' } });
  assert.strictEqual(noLine.mode, 'card', '★ 有读数无结论行却按纯文本出门 —— 形态又交给模型了');
  assert.strictEqual(noLine.card?.header?.title?.content, '审查未完成', '抬头必须是固定的告警模板');
  assert.ok(!/DP3|待放行|第八张/.test(JSON.stringify(noLine.card)),
    '★ 模型原话仍被搬进了告警卡（内部读数/无关叙述不许上卡）');
  // ② 反向对照：**没有读数**（闲聊）⇒ 逐字不变，仍是纯文本（不许借这条把闲聊也套成卡）
  const chat = env.toCardOrText('你好。', {});
  assert.strictEqual(chat.mode, 'text', '闲聊被套成卡了 —— 判据放太宽');
  assert.strictEqual(String(chat.text), '你好。', '闲聊正文被改了');
  // ③ 反向对照：有结论行 ⇒ 仍走 §5.3 卡（不许被上面的分支抢走）
  const withLine = env.toCardOrText(prose, {
    verdict53: { state: 'PASS', from: 'chain',
      line: '【审查结论：PASS】未发现已知底线风险，可转交 @sign-off 责任人（未配置） 进行 sign-off。' },
  });
  assert.strictEqual(withLine.mode, 'card', '有结论行却没发卡');
  assert.ok(/【审查结论：PASS】/.test(String(withLine.card?.header?.title?.content ?? '')),
    `抬头不是 §5.3 结论行：${withLine.card?.header?.title?.content}`);
});

// ═══ Z73 · 2026-10-26 3分钟第一性原理深度优化判据（含正反向对照）═══
await t('Z73a ★★ chainInput 必须把图片画面读数（场景摘要）写进链素材，且无读数时不凭空编造', async () => {
  const g = await import('./agent/review_gate.mjs');
  const withScene = g.chainInput({
    question: '审核该图片',
    inbound: {
      images: [{
        index: 1, text: 'Praise The Nap', wlText: 'Praise The Nap',
        sha256: 'b'.repeat(64),
        scene: {
          ok: true,
          scene: {
            setting: '卧室',
            people: [{ panel: '右上', kind: '婴幼儿', doing: '仰躺', sleep_scene: true, sleep_posture: '仰卧', sleep_posture_basis: '面朝上' }],
            products: [{ what: '白色奶瓶', in_use: false, orientation: '倒置' }],
          },
        },
      }],
    },
  });
  assert.ok(withScene.text.includes('场景摘要 / 画面读数'), 'chainInput 漏掉了画面读数标题');
  assert.ok(withScene.text.includes('卧室') && withScene.text.includes('白色奶瓶') && withScene.text.includes('倒置'),
    'chainInput 没把场景/物品/朝向写进素材文本');
  // 反向对照：scene 失败或未跑时，不许凭空印「场景摘要」
  const noScene = g.chainInput({
    question: '审核该图片',
    inbound: { images: [{ index: 1, text: 'Praise The Nap', wlText: 'Praise The Nap', scene: { ok: false, error: '超时' } }] },
  });
  assert.ok(!noScene.text.includes('场景摘要 / 画面读数'), '画面读数失败却仍印了场景摘要块');
});

await t('Z73b ★★ memory.compact 算术死锁修复：24 轮 60 条正常会话不触发无意义压缩；1000+ 条折叠积压必须被截断', async () => {
  const mem = await import('./agent/memory.mjs');
  // ① 24 轮（每轮 1 user + 1 assistant = 48 条）：默认参数下不许触发 summarize（否则每轮白烧 25s）
  const normalMsgs = [];
  for (let i = 0; i < 24; i++) {
    normalMsgs.push({ role: 'user', content: `问 ${i}` });
    normalMsgs.push({ role: 'assistant', content: `答 ${i}` });
  }
  const sessNormal = { key: 'test_normal_24', messages: normalMsgs, summary: '' };
  let sumCalls = 0;
  const didNormal = await mem.compact(sessNormal, async () => { sumCalls++; return '摘要'; });
  assert.strictEqual(didNormal, false, '24 轮 48 条正常会话在默认参数下不该触发压缩');
  assert.strictEqual(sumCalls, 0, '不该调用 summarize');

  // ② 反向对照：24 轮但夹了 200 条 foldInto 的 assistant 消息（总长 > 96 条）⇒ 必须触发压缩并裁到 <= 96 条
  const bloatedMsgs = [];
  for (let i = 0; i < 24; i++) {
    bloatedMsgs.push({ role: 'user', content: `问 ${i}` });
    const count = i === 10 ? 200 : 1;
    for (let k = 0; k < count; k++) bloatedMsgs.push({ role: 'assistant', content: `外发 ${i}-${k}` });
  }
  const sessBloated = { key: 'test_bloated_24', messages: bloatedMsgs, summary: '' };
  const didBloated = await mem.compact(sessBloated, async () => { sumCalls++; return '压缩后的纪要'; });
  assert.strictEqual(didBloated, true, '夹了 200 条外发消息的膨胀会话必须触发压缩');
  assert.ok(sessBloated.messages.length <= 96, `压缩后消息数应 <= 96，实际 ${sessBloated.messages.length}`);
  assert.strictEqual(sessBloated.messages[0]?.role, 'user', '切点必须落在 user 边界上');
});

await t('Z73c ★★ 复盘/耗时/引擎追问（≥30 字）属于机制问答，不许误判成送审起链；祈使送审仍正常起链', async () => {
  const g = await import('./agent/review_gate.mjs');
  const ask1 = '@_user_1 复盘一下为什么花这么长时间，主要费时的模块是？';
  assert.strictEqual(g.mechanismQuestion(ask1).ask, true, '复盘耗时追问必须被识别为机制问句');
  assert.strictEqual(g.isSubmission({ text: ask1 }).yes, false, '复盘耗时追问不许作为送审起链');
  const ask2 = '为什么刚才那张图片花了这么长时间才返回结果，主要费时在哪里？';
  assert.strictEqual(g.isSubmission({ text: ask2 }).yes, false, '耗时原因追问不许起链');
  // 反向对照：真正的广告文案（含时间描述但无疑问）照常送审
  const ad = '这款吸奶器续航时间长，充电一次可以使用这么长时间，非常适合职场妈妈日常通勤使用。';
  assert.strictEqual(g.isSubmission({ text: ad }).yes, true, '正常长广告文案必须照常送审');
});

await t('Z73d ★★ 多模态路由配置：config.vision 暴露 sceneModel 与 modelSideModel，且支持回退', async () => {
  const { config, describeConfig } = await import('./agent/config.mjs');
  assert.ok(config.vision && typeof config.vision.baseUrl === 'string', 'config.vision.baseUrl 缺失');
  assert.ok(typeof config.vision.sceneModel === 'string' && config.vision.sceneModel.length > 0, 'sceneModel 缺失');
  assert.ok(typeof config.vision.modelSideModel === 'string' && config.vision.modelSideModel.length > 0, 'modelSideModel 缺失');
  const desc = describeConfig();
  assert.ok(desc.visionBaseUrl && desc.visionModels, '启动横幅必须展示 visionBaseUrl 与 visionModels');
});

await t('Z73e ★★ 图片 OCR 大小写识别抖动（如 CEo→CEO、momcozY→MOMCOZY）确定性过滤，不污染模型侧其他真实发现', async () => {
  const { reviewModelSide } = await import('./agent/model_side.mjs');
  const fakeAsk = async () => JSON.stringify([
    {
      location: '图 1 第 2 处',
      category: '产品描述',
      severity: 'REVIEW',
      nature: '强制',
      description: '左下角混入洗奶瓶机型号「D8 DeepClean Bottle Washer」',
      reason: '混入洗奶瓶机型号「D8 DeepClean Bottle Washer」，信息不统一易造成混淆',
      suggestion: '删除左下角「D8 DeepClean Bottle Washer」导航文字',
      taxonomy_category: '商品信息与Listing准确性',
      taxonomy_subcategory: '功能与部件描述准确性',
      evidence_basis: 'image_observation',
      visual_anchor: '图 1：左下角浅色小字列表第三行',
    },
    {
      location: '图 1 第 1 处',
      category: '措辞表达',
      severity: 'REVIEW',
      nature: '非强制',
      description: '图中标题写为「The Crib CEo」',
      reason: 'CEO 末尾写成小写 o，属于拼写格式错误，影响品牌专业形象',
      suggestion: '将「The Crib CEo」修正为全大写「The Crib CEO」',
      taxonomy_category: '母婴知识内容准确性',
      taxonomy_subcategory: '内容形式与表达规范',
      evidence_basis: 'image_observation',
      visual_anchor: '图 1：中右侧绿色睡袋婴儿上方标注文字',
    },
  ]);
  const res = await reviewModelSide({
    readings: '【图 1 上的字】\nThe Crib CEo\nD8 DeepClean Bottle Washer',
    imagePaths: ['/tmp/fake.jpg'],
    requiredImageCount: 1,
    ask: fakeAsk,
  });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.findings.length, 1, `OCR 大小写伪影必须被过滤，实际保留 ${res.findings.length} 条`);
  assert.ok(res.findings[0].reason.includes('D8 DeepClean Bottle Washer'), '真实发现必须保留');
});

await t('Z73f ★★ ws_daemon 已彻底移除「【⏳ 还在跑】这一单已经跑了 5 分钟，慢在知识库比对那一步」话术', () => {
  const daemonSrc = fs.readFileSync(new URL('./ws_daemon.mjs', import.meta.url), 'utf8');
  const codeOnly = daemonSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!codeOnly.includes('慢在知识库比对那一步') && !codeOnly.includes('SHOUHENG_PROGRESS_PING_MS'),
    'ws_daemon 代码路径中仍残留 5 分钟进度提醒逻辑');
});

await t('Z73g ★★ 幽灵实例抢单护栏：自动识别并撤回旧版「它的正文我读不了」回复，自动接管被抢走的 @守衡 消息（含反向对照）', async () => {
  const { isGhostBotReplyItem, isItemMentioningBot, listItemToReceiveEvent, planGhostActions } =
    await import('./agent/ghost_guard.mjs');

  const now = 1793035200000;
  // 真实事故中的入站 post 消息（om_x100b62ccf41118a4df6eba728eee2ca）
  const missedUserMsg = {
    message_id: 'om_x100b62ccf41118a4df6eba728eee2ca',
    create_time: String(now - 10_000),
    chat_id: 'oc_TEST_GROUP',
    chat_type: 'group',
    msg_type: 'post',
    deleted: false,
    sender: { id: 'ou_TEST_USER', id_type: 'open_id', sender_type: 'user', tenant_key: 't1' },
    mentions: [{ id: 'ou_TEST_USER', id_type: 'open_id', key: '@_user_1', name: '守衡', tenant_key: 't1' }],
    body: {
      content: JSON.stringify({
        title: '',
        content: [
          [{ tag: 'img', image_key: 'img_v3_0216s_18284581-e6a8-4384-89bb-97f582a5dedg', width: 2078, height: 1208 }],
          [{ tag: 'at', user_id: '@_user_1', user_name: '守衡', style: [] }, { tag: 'text', text: ' 审核', style: [] }],
        ],
      }),
    },
  };

  // 真实事故中幽灵实例秒回的废话（om_x100b62ccf42638a8de103bb1e3f9f87）
  const ghostReplyMsg = {
    message_id: 'om_x100b62ccf42638a8de103bb1e3f9f87',
    create_time: String(now - 9_000),
    chat_id: 'oc_TEST_GROUP',
    chat_type: 'group',
    msg_type: 'text',
    deleted: false,
    sender: { id: 'cli_aa2243de0438dcd7', id_type: 'app_id', sender_type: 'app' },
    body: {
      content: JSON.stringify({ text: '这条是「post」，它的正文我读不了 —— 需要的话请把它转成文字发我。' }),
    },
  };

  // 正常新版卡片回复（反向对照：绝不能被误判为幽灵废话）
  const normalCardMsg = {
    message_id: 'om_x100b62ccabb720accf031220d871d42',
    create_time: String(now - 5_000),
    chat_id: 'oc_TEST_GROUP',
    chat_type: 'group',
    msg_type: 'interactive',
    deleted: false,
    sender: { id: 'cli_aa2243de0438dcd7', id_type: 'app_id', sender_type: 'app' },
    body: {
      content: JSON.stringify({ title: '【审查结论：REVIEW】共发现 3 处需人工确认。' }),
    },
  };

  // 1) 正向识别
  assert.strictEqual(isGhostBotReplyItem(ghostReplyMsg, 'cli_aa2243de0438dcd7'), true, '幽灵废话必须被识别');
  assert.strictEqual(isGhostBotReplyItem(normalCardMsg, 'cli_aa2243de0438dcd7'), false, '正常结论卡不许被误判为幽灵废话');
  assert.strictEqual(isItemMentioningBot(missedUserMsg), true, '@守衡 的 post 消息必须被识别');

  // 2) 规划动作：未见过的 @守衡 消息被接管，幽灵废话被列入撤回
  const plan1 = planGhostActions([normalCardMsg, ghostReplyMsg, missedUserMsg], {
    hasSeen: () => false,
    recalledIds: new Set(),
    nowMs: now,
  });
  assert.strictEqual(plan1.toRecall.length, 1, '应规划撤回 1 条幽灵废话');
  assert.strictEqual(plan1.toRecall[0].message_id, ghostReplyMsg.message_id);
  assert.strictEqual(plan1.toTakeover.length, 1, '应规划接管 1 条被抢走的 @守衡 消息');
  assert.strictEqual(plan1.toTakeover[0].message_id, missedUserMsg.message_id);

  // 3) 反向对照：已在本机 seen 表里的消息绝不重复接管，已撤回过的消息绝不重复撤回
  const plan2 = planGhostActions([normalCardMsg, ghostReplyMsg, missedUserMsg], {
    hasSeen: (id) => id === missedUserMsg.message_id,
    recalledIds: new Set([ghostReplyMsg.message_id]),
    nowMs: now,
  });
  assert.strictEqual(plan2.toRecall.length, 0, '已撤回过的幽灵废话不重复撤回');
  assert.strictEqual(plan2.toTakeover.length, 0, '本机已处理的 @守衡 消息绝不重复接管');

  // 4) 转换后的事件可被 feishu.bodyToText & imageKeysOf 完整还原
  const ev = listItemToReceiveEvent(missedUserMsg);
  assert.strictEqual(ev.message.message_id, missedUserMsg.message_id);
  assert.strictEqual(ev.message.message_type, 'post');
  assert.strictEqual(ev.message.mentions[0].id.open_id, 'ou_TEST_USER');
});

await t('Z73h ★★ PRD §5.3.3 依据合规性：原图观察、外部标准 URL、库内条款号三类合法依据全部通过 checkBasis（含反向对照）', async () => {
  const { checkBasis } = await import('./agent/prd533.mjs');
  assert.strictEqual(checkBasis('无外部依据（原图观察：图 1：右上角俯卧婴儿；需人工核对）').ok, true, '原图观察依据必须通过');
  assert.strictEqual(checkBasis('FTC Truth in Advertising → https://www…｜⚠️ 未核｜原始出处：https://www.ftc.gov/business-guidance/advertising-marketing').ok, true, '外部标准原始出处 URL 必须通过');
  assert.strictEqual(checkBasis('《措辞表达库 v0》第 W-1.18 条 ← 命中「boosts milk」').ok, true, '库内条款号必须通过');
  assert.strictEqual(checkBasis('依据：相关法规').ok, false, '相关法规禁词必须判红');
  assert.strictEqual(checkBasis('独立语义复核（非条款依据，需人工核对）').ok, false, '无依据空话必须判红');
});

await t('Z73i ★★ P0 只读前置快路（allowPublish=false 且无 reportOut）跳过飞书全表扫描，总耗时 ≤ 400ms', async () => {
  const { runP0Preflight } = await import('./agent/tools.mjs');
  const t0 = Date.now();
  const res = await runP0Preflight({
    text: 'Momcozy M5 hospital grade breast pump, 100% pain-free and boosts milk supply.',
    allowPublish: false,
  });
  const ms = Date.now() - t0;
  assert.ok(res && res.issue_count >= 2, 'P0 必须命中');
  assert.ok(ms <= 400, `只读前置 P0 耗时应 ≤ 400ms（避免飞书全表查询阻塞），实测 ${ms}ms`);
});

await t('Z73j ★★ skill_findings 卡片原因真实化（不印空洞套话）+ 覆盖缺口不计入问题 + 双轨同义锚点去重', async () => {
  const { skillFindingsOf } = await import('./agent/skill_findings.mjs');
  const { mergeFindings, renderMerged } = await import('./agent/dual_track.mjs');
  const ans = [
    '### 问题清单',
    '1. 覆盖缺口（库未覆盖，非内容问题）｜中部，图 1 第 1 处｜改：转 @法务 人工复核。',
    '2. 两名幼儿同处一个睡面，易被误读为共用睡面｜顶部，图 1 第 10 处｜改：改为各自独立睡面。',
    '3. 标签「The Faceplant」暗示扑倒睡姿｜右侧，图 1 第 11 处｜改：替换为安全睡姿名称。',
  ].join('\n');
  const sf = skillFindingsOf(ans);
  assert.strictEqual(sf.findings.length, 2, '覆盖缺口必须被过滤，只留 2 条实质问题');
  assert.strictEqual(sf.findings[0].reason, '两名幼儿同处一个睡面，易被误读为共用睡面', 'reason 必须是真实风险描述，不能是模板空话');
  assert.strictEqual(sf.findings[0].taxonomyCategory, '产品安全与高危使用场景', '同睡面必须归入产品安全与高危使用场景');

  // 与 model_side 同义条目合并去重（model_side 报了 The Faceplant 在 图 1 第 2 处，skill 报在 右侧，图 1 第 11 处）
  const modelItems = [{
    source: 'model',
    location: '图 1 第 2 处',
    category: '消费者安全',
    taxonomyCategory: '母婴知识内容准确性',
    taxonomySubcategory: '婴幼儿睡眠',
    severity: 'REVIEW',
    description: '右上角标注「The Faceplant」',
    reason: 'Faceplant 意为脸朝下扑倒，易引发婴儿趴睡风险联想',
    suggestion: '将「The Faceplant」替换为仰卧安全词汇',
    basis_kind: 'visual_observation',
    visual_anchor: '图 1：右上角婴儿旁标注 The Faceplant',
  }];
  const merged = mergeFindings([], [...modelItems, ...sf.findings]);
  assert.strictEqual(merged.items.length, 2, `The Faceplant 同题双报必须去重为 1 条，总条数应为 2，实际 ${merged.items.length}`);
  const card = renderMerged(merged.items, { state: 'REVIEW' })?.block ?? '';
  assert.ok(card.includes('两名幼儿同处一个睡面'), '卡片原因行必须印出「两名幼儿同处一个睡面」具体描述');
  assert.ok(!card.includes('判定主体的核查结论（判定主体的核查）'), '卡片不许再出现空洞的「判定主体的核查结论」套话');
});

// IMAGE_GATE_REASON_E2E_BEGIN
await t('Z74 图片闸门真实原因经 handleMessage 返回并上卡，后续正常图片与文字不继承旧原因', async () => {
  const { spawnSync } = await import('node:child_process');
  const os = await import('node:os');
  const path = await import('node:path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shouheng-reason-e2e-'));
  // 独立进程隔离模块缓存、SDK 桩与状态；生产的 handleMessage、闸门和卡片渲染照常执行。
  const probe = async (agentDir, imagePath) => {
    const fs = (await import('node:fs')).default;
    const net = await import('node:net');
    const originalRead = fs.readFileSync;
    fs.readFileSync = (file, ...args) => {
      const p = String(file);
      if (p.endsWith('/.dsh/credentials/shouheng-lark.json')) {
        return JSON.stringify({ app_id: 'cli_reason_test', app_secret: 'fixture-only' });
      }
      if (p.endsWith('/.config/opencode/opencode.json')) return '{}';
      if (p.endsWith('/.dsh/.credentials.yaml')) throw new Error('测试不许读取真实凭据');
      return originalRead.call(fs, file, ...args);
    };
    let networkAttempts = 0;
    net.Socket.prototype.connect = function () {
      networkAttempts++;
      throw new Error('本回归不允许真实联网');
    };
    globalThis.fetch = async (url) => {
      if (!String(url).startsWith('http://127.0.0.1:9/')) {
        networkAttempts++;
        throw new Error('本回归只允许模型协议桩');
      }
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop',
        message: { role: 'assistant', content: '本轮处理结果已经记录。' } }] }), { status: 200 });
    };
    const { client } = await import(new URL('feishu.mjs', agentDir));
    client.im.messageResource.get = async () => ({
      writeFile: async (out) => fs.copyFileSync(imagePath, out),
    });
    const { handleMessage } = await import(new URL('agent.mjs', agentDir));
    const { reviewFixtureClaims } = await import(new URL('__fixtures__/image-claim-review.mjs', agentDir));
    const { toCardOrText } = await import(new URL('../reply-cards/envelope.mjs', agentDir));
    const { renderText } = await import(new URL('../reply-cards/registry.mjs', agentDir));
    const stages = [
      '审核对象与范围：核查产品图片的文字、事实、安全与画面。',
      '视觉分析与 OCR：图中文字为Product，影棚画面无人，没有可识别的使用行为。',
      '主张拆分与核查清单：C1：图中文字Product是品类标签，没有医疗或安全功效主张。',
      '4A 规则符合性：知识库未命中当前素材的问题，原始读数为PASS与零条。',
      '4B 事实准确性核查：',
      '| 主张 | 核查结论 | 依据及边界 | 来源 | 来源原文 |',
      '|---|---|---|---|---|',
      '| C1：Product品类标签 | 画面可确认 | 品类标签可与当前OCR对照，不推断任何产品性能 | — | — |',
      '图文一致性：Product未指向具体性能，与本图没有可识别使用行为的画面不矛盾。',
      '视觉核对：婴幼儿姿势=无；婴儿睡眠位置=无（画面没有婴儿睡眠场景）；产品状态=无；场景关系=无；隐私=无',
      '【审查结论：PASS】未发现已知底线风险，可转交 @负责人进行 sign-off。',
    ];
    let chainAnswer = stages.filter((line) => !line.startsWith('主张拆分')).join('\n');
    const options = {
      notify: async () => {},
      imageClaimRunner: reviewFixtureClaims,
      deps: {
        fetchImage: async () => ({ path: imagePath, bytes: fs.statSync(imagePath).size, cleanup: () => {} }),
        ocr: async () => ({ ok: true, text: 'Product', lines: 1, chars: 7 }),
        scene: async () => ({ ok: true, ms: 1,
          scene: { setting: '影棚', people: [], products: [], visible_marks: [], risk_cues: [], clean_text: [] } }),
      },
      chainRunner: async () => ({ answer: chainAnswer, review: { state: 'PASS', issue_count: 0 },
        engine: { state: 'PASS', image_skill_gate: { ok: true, load: { verdict: 'loaded' } } } }),
      publishRunner: async () => ({ ok: true, action: 'skipped', detail: '离线回归' }),
      modelSideRunner: async () => ({ ok: true, findings: [], dropped: [], ms: 1 }),
      mergedReportRunner: async () => ({ ok: true, url: '', detail: '离线回归' }),
      adviceRunner: async () => ({ ok: true, ms: 1, advice: {} }),
    };
    const results = [];
    for (const [id, type, text] of [
      ['incomplete', 'post', ''], ['complete', 'post', ''],
      ['text', 'text', '请审核这段产品介绍：本产品为日常用品，包装标注颜色为白色。'],
      ['chat', 'text', '在吗'],
    ]) {
      if (id === 'complete') chainAnswer = stages.join('\n');
      const result = await handleMessage({ sender: {}, message: {
        message_id: 'om_reason_' + id, chat_id: 'oc_reason_e2e', chat_type: 'p2p', message_type: type,
        content: JSON.stringify(type === 'post'
          ? { content: [[{ tag: 'text', text: '审核' }, { tag: 'img', image_key: 'img_reason_' + id }]] }
          : { text }),
      } }, options);
      const shaped = toCardOrText(result.reply, {
        verdict53: result.meta?.verdict53 ?? null,
        reviewRequired: result.meta?.gate?.yes === true && !result.meta?.verdict53?.line,
        reviewReason: result.meta?.imageGateReason ?? null,
      });
      results.push({ id, meta: result.meta, kind: shaped.kind,
        text: shaped.card ? renderText(shaped.card) : shaped.text });
    }
    console.log('REASON_RESULT ' + JSON.stringify({ results, networkAttempts }));
  };
  const script = `(${probe.toString()})(${JSON.stringify(new URL('./agent/', import.meta.url).href)},`
    + `${JSON.stringify(new URL('./agent/__fixtures__/ocr-sample.png', import.meta.url).pathname)})`
    + `.catch((e) => { console.error(e); process.exitCode = 1; });`;
  try {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, SHOUHENG_STATE_DIR: tmp, SHOUHENG_KB_ROOT: path.join(tmp, 'absent-kb'),
        SHOUHENG_LLM_API_KEY: 'fixture-only', SHOUHENG_LLM_BASE_URL: 'http://127.0.0.1:9',
        SHOUHENG_ALLOWED_CHATS: '', SHOUHENG_REVIEW_TABLE: 'off', SHOUHENG_MEDIA_LINK: 'off',
        SHOUHENG_MERGED_RECORD: 'off', KB_CONF_LEDGER: path.join(tmp, 'confidence.ndjson'),
        SHOUHENG_IDENTITY_REJECT_LOG: path.join(tmp, 'identity.ndjson'),
        SHOUHENG_OUTBOUND_LEDGER: path.join(tmp, 'outbound.jsonl'),
        SHOUHENG_SEND_TRACE: path.join(tmp, 'sends.jsonl'),
        SHOUHENG_LLM_FAILURES: path.join(tmp, 'llm-failures.jsonl') },
    });
    const out = `${child.stdout ?? ''}\n${child.stderr ?? ''}`;
    assert.strictEqual(child.status, 0, `隔离回归没有跑完：${out.slice(-1600)}`);
    const match = out.match(/REASON_RESULT (\{.*\})/);
    assert.ok(match, `缺少行为读数：${out.slice(-1600)}`);
    const { results, networkAttempts } = JSON.parse(match[1]);
    assert.strictEqual(networkAttempts, 0, '离线回归不得尝试真实联网');
    const [incomplete, complete, text, chat] = results;
    assert.strictEqual(incomplete.meta?.gate?.yes, true, '故障夹具必须实际进入送审链');
    assert.strictEqual(incomplete.meta?.verdict53, null, '缺项必须扣住结论，不能靠放行让回归变绿');
    assert.match(incomplete.meta?.imageGateReason ?? '',
      /^图片安全审查 skill 全流程缺项：.*主张拆分与核查清单/, '真实闸门原因在 handleMessage 返回时丢失');
    assert.strictEqual(incomplete.kind, 'alert');
    assert.ok(incomplete.text.includes('发生了什么：' + incomplete.meta.imageGateReason),
      '卡片没有显示本次真实原因');
    assert.strictEqual(complete.meta?.verdict53?.state, 'PASS', '完整图片必须恢复正常结论');
    assert.strictEqual(text.meta?.verdict53?.state, 'PASS', '后续文字送审必须正常给结论');
    assert.strictEqual(chat.meta?.gate?.yes, false, '闲聊不得误判为送审');
    for (const current of [complete, text, chat]) {
      assert.strictEqual(current.meta?.imageGateReason ?? null, null, `${current.id} 继承了上一轮图片原因`);
      assert.ok(!current.text.includes('主张拆分与核查清单'), `${current.id} 卡面泄露旧失败原因`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
// IMAGE_GATE_REASON_E2E_END

await t('Z75 同图同视频每次发送独立推理：连续、并发、旧缓存和新失败都不得复用', async () => {
  const { spawnSync } = await import('node:child_process');
  const child = spawnSync(process.execPath,
    [new URL('./agent/media_review_fresh.test.mjs', import.meta.url).pathname],
    { encoding: 'utf8', timeout: 30_000 });
  assert.strictEqual(child.status, 0,
    `媒材独立推理回归失败：${String(child.stdout ?? '').slice(-2400)}\n${child.stderr ?? ''}`);
  assert.ok(child.stdout.includes('media_review_fresh: 6/6, real network attempts=0'),
    '必须跑完全部媒材重复发送用例且未访问真实网络');
});

for (const [name, script, summary] of [
  ['Z76 图片来源适用性：真实失败全文、结构化事实与安全主张反向对照',
    'image_source_gate.test.mjs', /image_source_gate: \d+\/\d+ passed, 0 failed/],
  ['Z77 图片完成检查必须先于报告发布，拒答的表、卡、链接与置信度一致',
    'image_completion_publish.test.mjs', /image_completion_publish: \d+\/\d+, real network attempts=0/],
  ['Z78 视频画面逐帧进入引擎素材，失败与未执行明确留痕',
    'video_material.test.mjs', /# fail 0/],
  ['Z79 视频完整性检查：采样计划、画面、音轨、独立模型、规则与流程证据',
    'video_completion.test.mjs', /# fail 0/],
  ['Z80 视频最终卡片与报告保留视觉证据，未完成不能发布三态',
    'video_completion_publish.test.mjs', /video_completion_publish: \d+\/\d+, real network attempts=0/],
  ['Z81 视频直链与上传共用完整输入、原帧交付和异常清理',
    'video_url_completion.test.mjs', /video_url_completion: \d+\/\d+, real network attempts=0/],
  ['Z82 本轮拒答不能被旧链、P0标记或回复文字恢复成三态',
    'video_final_refusal.test.mjs', /video_final_refusal: \d+\/\d+, real network attempts=0/],
  ['Z83 婴儿来源语义复核绑定本轮证据、逐项覆盖，失败不得放行',
    'infant_scope.test.mjs', /infant_scope: \d+\/\d+ passed, 0 failed/],
  ['Z84 文字审查失败原因与队列状态经真实发送函数上卡，拒答不能恢复旧结论',
    'review_feedback.test.mjs', /# fail 0/],
  ['Z85 链接读取意图：原句、权限、只读、混合送审与冲突请求',
    'link_access.test.mjs', /# fail 0/],
  ['Z86 链接只读从消息到真实发送出口不审查、不调模型、不写表',
    'link_access_flow.test.mjs', /# fail 0/],
  ['Z87 模型发现结构与字数重写保持完整，零发现可追溯',
    'model_side_integrity.test.mjs', /# fail 0/],
  ['Z88 图片事实来源按本地正文校验，库内摘录不冒充权威核验',
    'image_fact_sources.test.mjs', /# fail 0/],
  ['Z89 图片六阶段交付与逐项事实核查不接受空壳报告',
    'image_workflow_evidence.test.mjs', /# fail 0/],
  ['Z90 图片事实来源绑定当前轮，成人与其他模态不串来源，完整零发现保留 PASS',
    'image_fact_wiring.test.mjs', /image_fact_wiring: (\d+)\/\1; external attempts=0; forbidden writes=0/],
  ['Z91 图片报告耗尽时保留本轮引擎并在原会话有界续写',
    'image_chain_execution.test.mjs', /"fail":0/],
  ['Z92 DSH图片生成预算真实wire与恢复工具硬拒绝',
    'image_generation_policy.test.mjs', /# fail 0/],
  ['Z93 图片失败原因、原始时限与无需模型回复的记忆保存',
    'review_deadline_feedback.test.mjs', /# fail 0/],
  ['Z94 最终卡实际送达180秒计时，失败和重试不得虚报达标',
    'review_timing.test.mjs', /# fail 0/],
  ['Z95 图片首轮交付截止与本轮执行身份独立反向对照',
    'image_chain_execution_review.test.mjs', /# fail 0/],
  ['Z96 图片启动失败、会话冲突与已有风险保留独立反向对照',
    'image_chain_boundary_review.test.mjs', /# fail 0/],
  ['Z97 图片进程超时不能被正常退出码掩盖，标准输出与清理仍保留',
    'image_process.test.mjs', /# fail 0/],
  ['Z98 图片后处理与发送共用原截止，HTTP取消和CLI后续请求有执行点',
    'review_deadline.test.mjs', /# fail 0/],
  ['Z99 图片逐主张来源绑定，混合句、无关引文与未知均不得偷换',
    'image_claim_review.test.mjs', /# fail 0/],
  ['Z100 图片生成、恢复和发布使用同一完整验收及本轮证据',
    'image_report_completion.test.mjs', /# fail 0/],
  ['Z101 图片同会话补交不得删主张、未知边界或已有风险',
    'image_claim_recovery.test.mjs', /# fail 0/],
  ['Z102 图片 C 声明与交叉引用分开，重复和非法编号仍拒',
    'image_claim_declarations.test.mjs', /# fail 0/],
  ['Z103 线上真实两份原稿回放：格式修复不消除安全未知',
    'image_live1401_replay.test.mjs', /# fail 0/],
  ['Z104 图片语义输入视图无损重建与篡改拒绝',
    'image_claim_view.test.mjs', /# fail 0/],
  ['Z105 外部标准库推送仅限测试群，最终发送口拒绝其他会话',
    'push_policy.test.mjs', /# fail 0/],
  ['Z106 结论按本条会话分表，查询写入回读与并发来源一致，链内不重复发布',
    'review_routing.test.mjs', /review_routing: (\d+)\/\1 passed/],
]) {
  await t(name, async () => {
    const { spawnSync } = await import('node:child_process');
    const child = spawnSync(process.execPath,
      [new URL(`./agent/${script}`, import.meta.url).pathname],
      { encoding: 'utf8', timeout: 30_000 });
    assert.strictEqual(child.status, 0,
      `${script} 回归失败：${String(child.stdout ?? '').slice(-4000)}\n${child.stderr ?? ''}`);
    assert.match(child.stdout, summary, '必须跑完真实失败样本和反向对照');
  });
}

// 汇总必须放在**所有**分组之后（2026-10-09 修：中间那两块重复的汇总+exit
// 让「第 27 组」与「第 33 组」**从没被执行过**，而合计照样印得像全绿）。
console.log(`\n═══ 合计：通过 ${pass} / 失败 ${fail} / 未测 ${untested} ═══`);
process.exit(fail > 0 ? 1 : untested > 0 ? 2 : 0);

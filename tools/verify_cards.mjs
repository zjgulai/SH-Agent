#!/usr/bin/env node
/**
 * verify_cards.mjs —— 卡片模版与语域规程的自证器
 *
 * ## 为什么需要它
 *
 * 本项目已经在「文档里的数字复现不出来」上吃过一次亏（ADR-0013 §15.3），
 * 而卡片模版比数字更容易腐烂：写卡片的人改一个 tag、加一个字段，
 * `contract.md` 和 `SKILL.md` 照旧读起来完全正常，**直到某天守衡的回复在群里凭空消失**
 * ——因为 schema V2 里一个不认的 tag 会让整张卡被服务端整体拒绝，不是降级，是丢。
 *
 * 所以本脚本做的是把「模版」「登记表」「文档」三者的**一致性**变成可执行断言：
 *
 *   A 构建   十一个构造器都能建出卡，且都过本地校验
 *   B 登记   REGISTRY 里每个字段真的被构造器读过（写进文档却没人用的字段 = 假槽位）
 *   C 白名单  cards.mjs 的 ALLOWED_TAGS 与探针读数一致；被 V2 移除的 tag 能被拦下
 *   D 降级   每张卡都能降级成纯文本，且降级文本里不出现 JSON、不出现内部记录
 *   E 文档   contract.md / SKILL.md 里出现的每一个 kind 都在登记表里，反之亦然
 *   F 语域   去 AI 味的机械规则本身有效（正例命中、反例不误报）
 *
 * 用法：
 *   node tools/verify_cards.mjs            # 全套
 *   node tools/verify_cards.mjs --verbose
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const CARDS_DIR = path.join(HERE, 'reply-cards');
const PROBE = path.join(ROOT, 'PMO', 'logs', 'card_probe.jsonl');

const VERBOSE = process.argv.includes('--verbose');

const {
  REGISTRY, BY_KIND, BUILDERS, BUILDER_SOURCE_NAME,
  build, validateCard, renderText, shapeOf, sampleCards, lintCopy,
  TONE, TEMPLATES, BACKGROUND_STYLES,
} = await import(path.join(CARDS_DIR, 'index.mjs'));
const { applyVerdictLine } = await import(path.join(CARDS_DIR, 'envelope.mjs'));
const cardsSrc = fs.readFileSync(path.join(CARDS_DIR, 'cards.mjs'), 'utf8');
const cardsMod = await import(path.join(CARDS_DIR, 'cards.mjs'));

let pass = 0, fail = 0;
const bad = [];
const ok = (label) => { pass++; if (VERBOSE) console.log(`  ✅ ${label}`); };
const no = (label, why) => { fail++; bad.push(`${label} —— ${why}`); console.log(`  ❌ ${label}\n       ${why}`); };
const head = (t) => console.log(`\n${t}`);

/* ─────────────── A 构建 ─────────────── */
head('A 构建 · 每个类型都能建卡并过本地校验');
const samples = sampleCards();
for (const r of REGISTRY) {
  try {
    const c = samples[r.kind];
    const v = validateCard(c);
    if (!v.ok) no(`A ${r.kind}`, `样例卡校验不过：${v.errors.map((e) => `${e.path}:${e.msg}`).join('; ')}`);
    else ok(`A ${r.kind} → ${shapeOf(c)}`);
  } catch (e) {
    no(`A ${r.kind}`, `构建抛异常：${e.message}`);
  }
}
// 构造器数 = 登记数，不能有孤儿
for (const k of Object.keys(BUILDERS)) {
  if (!BY_KIND.has(k)) no(`A 孤儿构造器 ${k}`, 'BUILDERS 里有，REGISTRY 里没有 —— 没人知道什么时候该用它');
  else ok(`A 构造器 ${k} 已登记`);
}
for (const r of REGISTRY) {
  if (!BUILDERS[r.kind]) no(`A 缺构造器 ${r.kind}`, 'REGISTRY 里有，BUILDERS 里没有');
  // 源文件里函数名要对得上（防止有人改了函数名忘记改登记）
  const src = BUILDER_SOURCE_NAME[r.kind];
  if (!src || !new RegExp(`export function ${src}\\s*\\(`).test(cardsSrc)) {
    no(`A ${r.kind} 函数名`, `BUILDER_SOURCE_NAME 写的 ${src} 在 cards.mjs 里找不到 export function`);
  } else ok(`A ${r.kind} 函数名 ${src} 对得上`);
}

/* ─────────────── B 字段 ─────────────── */
head('B 登记 · 每个登记字段都真的被构造器读过');
for (const r of REGISTRY) {
  const fn = BUILDER_SOURCE_NAME[r.kind];
  const m = cardsSrc.match(new RegExp(`export function ${fn}\\s*\\(d = \\{\\}\\)[\\s\\S]*?\\n\\}`));
  if (!m) { no(`B ${r.kind}`, `找不到函数体 ${fn}`); continue; }
  const body = m[0];
  for (const f of Object.keys(r.fields)) {
    // 出现形式：d.<field>（含 d.fields、d.can、d.columns…）
    if (!new RegExp(`d\\.${f}\\b`).test(body)) {
      no(`B ${r.kind}.${f}`, '登记表里有这个字段，构造器从不读它 —— 假槽位，写进文档只会误导');
    } else ok(`B ${r.kind}.${f} 被读到`);
  }
}

/* ─────────────── C 白名单与探针一致 ─────────────── */
head('C 白名单 · 与探针读数一致，且能拦下 V2 已移除的 tag');
{
  const probeRows = fs.existsSync(PROBE)
    ? fs.readFileSync(PROBE, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  if (!probeRows.length) no('C 探针读数', `${PROBE} 不存在或为空 —— 白名单失去了实测依据`);
  else {
    const byProbe = Object.fromEntries(probeRows.map((r) => [r.id, r]));
    const mustPass = ['header_theme', 'markdown_element', 'table_element', 'column_set', 'collapsible', 'v2_fields_columnset', 'v2_button_bare'];
    const mustFail = ['note_fields', 'button_callback'];
    for (const id of mustPass) {
      if (!byProbe[id]) no(`C 探针 ${id}`, '读数缺失：不能声称这个元素可用');
      else if (!byProbe[id].ok) no(`C 探针 ${id}`, `读数是被拒，但白名单当它可用 —— 模版会用上它然后整卡被拒`);
      else ok(`C 探针 ${id} 通过，已在白名单`);
    }
    for (const id of mustFail) {
      if (!byProbe[id]) no(`C 探针 ${id}`, '读数缺失');
      else if (byProbe[id].ok) no(`C 探针 ${id}`, '读数是通过，但代码当它被移除 —— 拒绝的理由已经不成立，该更新');
      else ok(`C 探针 ${id} 被拒（${byProbe[id].error?.error?.ErrCode ?? byProbe[id].error?.code}），已在移除表`);
    }
    // 白名单里不该出现被拒的 tag 名
    for (const tag of Object.keys(cardsMod.REMOVED_IN_V2)) {
      if (cardsMod.ALLOWED_TAGS.has(tag)) no(`C 白名单含 ${tag}`, '同时出现在 ALLOWED_TAGS 与 REMOVED_IN_V2');
      else ok(`C ${tag} 不在白名单，会被拦`);
    }
  }
}
{
  // 校验器真的能拦：造三张坏卡
  const base = samples['query-answer'];
  const clone = () => JSON.parse(JSON.stringify(base));
  const cases = [
    ['note 元素', (c) => c.body.elements.push({ tag: 'note', elements: [] })],
    ['action 容器', (c) => c.body.elements.push({ tag: 'action', actions: [] })],
    ['未知配色', (c) => { c.header.template = 'chartreuse'; }],
    ['表格 rows 写成数组', (c) => c.body.elements.push({ tag: 'table', columns: [{ name: 'a' }], rows: [['x']] })],
    ['表格列名不匹配', (c) => c.body.elements.push({ tag: 'table', columns: [{ name: 'a' }], rows: [{ b: 'x' }] })],
    ['正文放在顶层', (c) => { c.elements = c.body.elements; delete c.body; }],
    ['header.title 用 markdown', (c) => { c.header.title = { tag: 'markdown', content: 'x' }; }],
  ];
  for (const [label, mutate] of cases) {
    const c = clone(); mutate(c);
    const v = validateCard(c);
    if (v.ok) no(`C 拦截「${label}」`, '校验器放过了它 —— 这张卡会被飞书整体拒绝');
    else ok(`C 拦住「${label}」：${v.errors[0].msg.slice(0, 46)}`);
  }
  // 好卡必须过
  if (!validateCard(clone()).ok) no('C 好卡误报', '干净卡被判不合格，校验器过严');
  else ok('C 干净样例卡不被误报');
}

/* ─────────────── D 降级 ─────────────── */
head('D 降级 · 卡片发不出去时，纯文本仍然可读');
for (const r of REGISTRY) {
  const c = samples[r.kind];
  const txt = renderText(c, '卡片被拒 code=230099');
  const problems = [];
  if (txt.includes('{"schema"') || txt.includes('"tag"')) problems.push('降级文本里出现了原始 JSON');
  if (!txt.startsWith('【')) problems.push('降级文本没有以标题开头');
  if (!txt.includes('卡片被拒')) problems.push('降级文本没注明降级原因 —— 对方不知道格式为什么变了');
  if (/toolTrace|tool_calls|call_\d|run_readonly_command\(/.test(txt)) problems.push('降级文本里出现了内部调用记录');
  if (txt.length < 8) problems.push('降级文本几乎为空');
  if (problems.length) no(`D ${r.kind}`, problems.join('；'));
  else ok(`D ${r.kind} 降级 ${txt.length} 字：${txt.split('\n')[0]}`);
  // 形状摘要必须非空（空摘要说明卡里没放任何可见元素）
  if (!shapeOf(c)) no(`D ${r.kind} 形状`, '卡片里没有任何可见元素');
}

/* ─────────────── E 文档一致性 ─────────────── */
head('E 文档 · kind 在登记表、contract.md、SKILL.md 三处一致');
{
  const docFiles = [
    path.join(CARDS_DIR, 'contract.md'),
    path.join(ROOT, 'agent-skills', '守衡语域', 'SKILL.md'),
  ];
  for (const f of docFiles) {
    const rel = path.relative(ROOT, f);
    if (!fs.existsSync(f)) { no(`E ${rel}`, '文件不存在'); continue; }
    const md = fs.readFileSync(f, 'utf8');
    for (const r of REGISTRY) {
      if (!md.includes(`\`${r.kind}\``)) no(`E ${rel} 缺 ${r.kind}`, '登记表里有这个类型，文档里没写 —— 用的人不会知道它存在');
      else ok(`E ${rel} 含 ${r.kind}`);
    }
    // 反向：文档里提到的所有 kind 都要在登记表里
    for (const m of md.matchAll(/`([a-z]+(?:-[a-z]+)+)`/g)) {
      const k = m[1];
      const looksLikeKind = /^(query|data|correction|capability|find|cannot|receipt|turn|evidence|alert|decision)-/.test(k);
      if (looksLikeKind && !BY_KIND.has(k)) no(`E ${rel} 提到未知类型 ${k}`, '文档里写了，代码里没有');
    }
  }
  // 白名单数字一致：contract.md 里声称的可用 tag 应与 ALLOWED_TAGS 相同
  const contract = fs.readFileSync(path.join(CARDS_DIR, 'contract.md'), 'utf8');
  const claimed = (contract.match(/`(markdown|plain_text|hr|table|column_set|column|collapsible_panel|button|code_block|standard_icon)`/g) ?? [])
    .map((x) => x.replace(/`/g, ''));
  const missing = [...cardsMod.ALLOWED_TAGS].filter((t) => !claimed.includes(t));
  if (missing.length) no('E contract.md 白名单不全', `缺：${missing.join(', ')}`);
  else ok(`E contract.md 列出了全部 ${cardsMod.ALLOWED_TAGS.size} 个可用 tag`);
}

/* ─────────────── F 语域规则本身有效 ─────────────── */
head('F 语域 · 去 AI 味的机械规则：正例命中、反例不误报');
{
  const { COPY_RULES } = await import(path.join(CARDS_DIR, 'registry.mjs'));
  const positives = [
    ['chatbotResidue', '好问题！让我来看看这个文件。'],
    ['chatbotResidue', '希望这对你有帮助。'],
    ['conclusionTail', '综上所述，这个方案是可行的。'],
    ['padding', '我们需要先对这个目录进行分析，然后予以处理。'],
    ['hedgeStack', '这个可能是编码问题，或许也许是压缩存储，大概如此。'],
    ['padding', '对这条需求做出决定之前，需要对它进行确认。'],
    // 结构级：那条 434 字故障输出的真实形态
    ['internalLeak', '我查了几轮还是没能得出可靠结论，先把已知的告诉你：我试过 list_files、list_files、list_files，但信息不足。'],
    ['internalLeak', 'trace: run_readonly_command(53ms) → run_readonly_command(1194ms)'],
    ['internalLeak', '"role": "tool", "tool_call_id": "call_00_xT8wRM60iidlhia0CyIw4532"'],
  ];
  for (const [id, text] of positives) {
    const hits = lintCopy(text);
    if (!hits.some((h) => h.id === id)) no(`F 正例 ${id}`, `「${text}」没命中 ${id}`);
    else ok(`F 正例 ${id} 命中`);
  }
  // 短语表里**每一条**都要真的能被自己命中 —— 防止写进去一条永远匹配不到的短语
  for (const r of COPY_RULES) {
    if (!r.phrases) continue;
    const dead = r.phrases.filter((p) => !lintCopy(`前一句。${p}。后一句。`).some((h) => h.id === r.id));
    if (dead.length) no(`F ${r.id} 死短语`, `这些短语永远匹配不到自己：${dead.join(' / ')}`);
    else ok(`F ${r.id} 的 ${r.phrases.length} 条短语全部可命中`);
  }
  const negatives = [
    ['单个连词是正常的', '此外，还有一个文件没读。'],
    ['正式语域不是 AI 味', '依据 `PMO/守衡-架构说明.md` 第四节第 4 条，九个工具全只读。'],
    ['单个限定词是正常的', '这个可能是编码问题。'],
    ['三顿号并列是正常的', '顶层是 ADR、PMO、PRD、base 四个目录。'],
    ['表格不算排比', '| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n| 5 | 6 |'],
    // 正常回复会提到工具名，这**不是**泄漏；泄漏是「连续同名」或「栈帧/内部字段名」
    ['正常回复里出现一次工具名', '我用 `list_files` 找了一遍，没找到。'],
    ['正常回复里出现两次不同工具名', '先 `list_files` 找，再 `read_text_file` 读，都没有。'],
    ['正常回复里说「我试过 grep 和 wc」', '我在工作区里试过 grep 和 wc，零命中。'],
  ];
  for (const [label, text] of negatives) {
    const hits = lintCopy(text).filter((h) => h.level === 'error');
    if (hits.length) no(`F 反例「${label}」`, `被误报为 error：${hits.map((h) => h.id).join(',')} —— 过度纠正本身是另一种指纹`);
    else ok(`F 反例「${label}」不误报`);
  }
}

/* ─────────────── G stdout 干净（管道能用） ─────────────── */
head('G stdout · CLI 的 JSON 输出不被日志污染');
{
  // 这条不是洁癖：`sample --json | validate -` 是这个模版对外的主要用法，
  // 而飞书 SDK 默认往 stdout 打一行 `[info]: client ready`，
  // 会让整条管道拿到一段不是 JSON 的开头。2026-09-18 实测踩到过。
  const { execFileSync } = await import('node:child_process');
  const cli = path.join(CARDS_DIR, 'cli.mjs');
  let out = '';
  try {
    out = execFileSync(process.execPath, [cli, 'sample', 'receipt', '--json'], { encoding: 'utf8' });
  } catch (e) { no('G sample --json', `执行失败：${e.message}`); }
  if (out) {
    try { JSON.parse(out); ok('G sample --json 的 stdout 是纯 JSON（无日志前缀）'); }
    catch (e) { no('G sample --json', `stdout 不是纯 JSON：${e.message}；开头是「${out.slice(0, 60)}」`); }
  }
  // 校验器的退出码要能当闸用
  const { spawnSync } = await import('node:child_process');
  const r1 = spawnSync(process.execPath, [cli, 'validate', '-'],
    { input: JSON.stringify(samples.receipt), encoding: 'utf8' });
  if (r1.status !== 0) no('G validate 好卡退出码', `应为 0，实际 ${r1.status}`);
  else ok('G validate 好卡退出码 0');
  const r2 = spawnSync(process.execPath, [cli, 'validate', '-'],
    { input: '{"schema":"1.0"}', encoding: 'utf8' });
  if (r2.status === 0) no('G validate 坏卡退出码', '坏卡也返回 0 —— 这个校验器没法当闸用');
  else ok('G validate 坏卡退出码非 0');
}

/* ─────────────── H 规程文件真的会入库 ─────────────── */
head('H 入库 · 规程文件不在 .gitignore 里');
{
  // 这条是被真实踩到后才加的：本项目 .gitignore 第 39 行是 `skills/`，
  // 注释写明「第三方技能库与克隆」。项目**自有**的规程放进 skills/ 不会入库，
  // 写完之后 `git status` 一片干净，看起来像什么都没发生。
  // 所以自证要能把「写了但没入库」变成红的。
  const { spawnSync } = await import('node:child_process');
  const skill = path.join(ROOT, 'agent-skills', '守衡语域', 'SKILL.md');
  if (!fs.existsSync(skill)) no('H 规程文件存在', `${path.relative(ROOT, skill)} 不存在`);
  else {
    const r = spawnSync('git', ['check-ignore', '-q', skill], { cwd: ROOT });
    if (r.status === 0) no('H 规程可入库', `${path.relative(ROOT, skill)} 被 .gitignore 忽略 —— 它不会进版本库`);
    else ok('H 规程文件可入库（未被 .gitignore 忽略）');
  }
  for (const f of ['tools/reply-cards/contract.md', 'tools/reply-cards/cards.mjs', 'tools/verify_cards.mjs']) {
    const r = spawnSync('git', ['check-ignore', '-q', path.join(ROOT, f)], { cwd: ROOT });
    if (r.status === 0) no(`H ${f} 可入库`, '被 .gitignore 忽略');
    else ok(`H ${f} 可入库`);
  }
}

/* ─────────────── J 信封 · 模型输出 → 卡片，且内部标记永不出现在群里 ─────────────── */
head('J 信封 · 解析、上限执行、以及「标记不许漏进群」');
{
  const { toCardOrText, extractCardBlock, enforceLimits, leaksInternalMark, publicTextOf, stripInternalNotes, CARD_MARK,
          blockRows, VERDICT_GROUP_TITLE } =
    await import(path.join(CARDS_DIR, 'envelope.mjs'));

  // J1 三个上限：**不查名字，查它真的会拦。**
  //
  // 旧版这里是 `new RegExp('\\b'+k+'\\b').test(envSrc)` —— 一个**源码文本存在性测试**：
  // 只要常量名在 envelope.mjs 里出现过（哪怕只出现在 import 行或 ENFORCED 字面量里）
  // 就算过。实测它当时正在它本该抓的缺陷上变绿：`MAX_SECTIONS = 3` 全仓
  // 没有任何一行拿它做比较，J1 却是 ✅ —— AGENTS.md §2.4 点名的那个病，
  // 在它自己的执行点断言里活了下来。
  //
  // 现在分三层，缺一层都不算：
  //   J1a 源码级 —— 常量必须出现在一个**能改变行为的表达式**里（排除注释/import/export）
  //   J1b 行为级 —— 喂一个超限样本，必须真的被拦下，且**内容一个字符不丢**
  //   J1c 相容级 —— 现有 11 张样例卡都不许超限（否则是「上限与模版不相容」，病因同 MAX_SECTIONS=3）
  const envSrc = fs.readFileSync(path.join(CARDS_DIR, 'envelope.mjs'), 'utf8');
  const envLines = envSrc.split('\n');
  const isComment = (l) => {
    const t = l.trim();
    return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*');
  };
  const { capSections } = await import(path.join(CARDS_DIR, 'envelope.mjs'));
  const cardsMod2 = await import(path.join(CARDS_DIR, 'cards.mjs'));
  const { md, MAX_SECTIONS: MS } = cardsMod2;
  const cp = (x) => [...String(x)].length;

  // J1a 的判据：常量必须**真的到达一个比较**，而不是只被转口。
  //   排除的正是 MAX_SECTIONS=3 当时的形状 —— 只在 import 行与 ENFORCED 字面量里出现。
  //   允许**一层默认值绑定**：`capSections(card, max = MAX_SECTIONS)` 里 `max` 被比较，
  //   常量确实决定了行为，算数。这不是为了迁就写法 —— 是为了不逼着代码
  //   为了过检查而写成更差的样子（教考试）。
  const reachesComparison = (k) => {
    const code = envLines.filter((l) => !isComment(l));
    const cmp = (l) => /[<>]=?|Math\.(min|max)/.test(l);
    if (code.some((l) => new RegExp(`\\b${k}\\b`).test(l) && cmp(l))) return '直接比较';
    const binders = [];
    for (const l of code) {
      const m = l.match(new RegExp(`([A-Za-z_$][\\w$]*)\\s*=\\s*${k}\\b`));
      if (m) binders.push(m[1]);
    }
    for (const b of binders) {
      if (code.some((l) => new RegExp(`\\b${b}\\b`).test(l) && cmp(l))) return `经绑定 ${b}`;
    }
    return null;
  };

  // ⚠️ 2026-10-13：`BOUNDARY_MAX` 已随 `boundary` 那一格**整格作废**（不再上卡 ⇒ 没有可拦的东西），
  //   所以它不在这张表里了 —— 这一行本身就是那条作废的执行点。
  for (const k of ['VERDICT_MAX', 'MAX_SECTIONS']) {
    const how = reachesComparison(k);
    if (!how) {
      const seen = envLines.filter((l) => !isComment(l) && new RegExp(`\\b${k}\\b`).test(l));
      no(`J1a ${k} 有执行点`,
        `${k} 在 envelope.mjs 里没有任何一条非注释语句拿它做比较 —— ` +
        `只出现在 ${seen.length} 行里（${seen.map((l) => l.trim().slice(0, 40)).join(' | ') || '一行都没有'}），` +
        `上限又变回注释了`);
    } else {
      ok(`J1a ${k} 到达了比较（${how}）`);
    }
  }

  // J1b：行为级 —— 每个上限都要有一个「喂超限样本 → 真被拦下」的实证
  {
    // ① 结论超长
    const vLong = '结'.repeat(300);
    const r1 = enforceLimits('query-answer', { title: 't', verdict: vLong }, []);
    const vAfter = r1.data.verdict ?? '';
    if (cp(vAfter) > 60) no('J1b VERDICT_MAX 真的拦', `喂 300 字结论，出来还是 ${cp(vAfter)} 字`);
    else ok(`J1b VERDICT_MAX 真的拦：300 → ${cp(vAfter)} 字`);

    // ③ 段落超限 —— 造一张比 MAX_SECTIONS 多两段的卡
    const n = MS + 2;
    const over = {
      schema: '2.0', config: { update_multi: true },
      header: { title: { tag: 'plain_text', content: 'T' }, template: 'orange' },
      body: { elements: Array.from({ length: n }, (_, i) => md(`第${i + 1}段`)) },
    };
    const beforeTxt = JSON.stringify(over.body.elements);
    const capped = capSections(over);
    const afterMd = capped.card.body.elements.filter((e) => e.tag === 'markdown').length;
    const folded = capped.card.body.elements.find((e) => e.tag === 'collapsible_panel');
    if (afterMd > MS) {
      no('J1b MAX_SECTIONS 真的拦', `喂 ${n} 段，顶层还剩 ${afterMd} 段（上限 ${MS}）`);
    } else if (!folded || folded.elements.length !== n - MS) {
      no('J1b MAX_SECTIONS 真的拦', `${n} 段里只折叠了 ${folded ? folded.elements.length : 0} 段，其余不知去向`);
    } else {
      // 搬是搬，砍是砍：每一段的原文都必须还在
      const afterTxt = JSON.stringify(capped.card.body.elements);
      const lost = Array.from({ length: n }, (_, i) => `第${i + 1}段`).filter((t) => !afterTxt.includes(t));
      if (lost.length) no('J1b MAX_SECTIONS 不丢内容', `搬走后找不到：${lost.join('、')}`);
      else ok(`J1b MAX_SECTIONS 真的拦：${n} 段 → 顶层 ${afterMd} 段 + 折叠 ${folded.elements.length} 段，内容一个没丢`);
    }

    // J1c：现有模版必须都不超限 —— 否则是上限与模版不相容（MAX_SECTIONS=3 就是这么废的）
    let worst = 0, worstKind = '';
    for (const r of REGISTRY) {
      const c = samples[r.kind];
      if (!c) continue;
      const m = (c.body?.elements ?? []).filter((e) => e.tag === 'markdown').length;
      if (m > worst) { worst = m; worstKind = r.kind; }
    }
    if (worst > MS) {
      no('J1c 上限与模版相容',
        `「${worstKind}」顶层有 ${worst} 段，超过 MAX_SECTIONS=${MS} —— ` +
        `上限比模版还小，等于每次都要搬，和当初 MAX_SECTIONS=3 是同一个病`);
    } else {
      ok(`J1c 上限与模版相容：11 张样例卡最紧的一张是「${worstKind}」${worst} 段 ≤ ${MS}`);
    }
  }

  // J2 ★ 最要紧的一条：要发出去的**文本**里，任何输入都不许留下 [[card: 或内部记录。
  // 第一版这里漏了 ——「坏 JSON」那条会把 [[card:receipt]] 和半截 JSON 原样发进群。
  const leakCases = [
    ['纯文本', '就是一句话，没有卡片。'],
    ['正常卡', `${CARD_MARK}query-answer]]\n{"title":"11 条","verdict":"**11 条**。"}`],
    ['带 json 围栏', `${CARD_MARK}receipt]]\n\`\`\`json\n{"title":"已收到","verdict":"收到。"}\n\`\`\``],
    ['块前后有正文', `先说明一下。\n\n${CARD_MARK}receipt]]\n{"title":"已收到","verdict":"收到。"}\n\n补充一句。`],
    ['未知类型', `${CARD_MARK}nope]]\n{"title":"T"}`],
    ['JSON 截断', `${CARD_MARK}receipt]]\n{"title":`],
    ['JSON 截断且后面有正文', `${CARD_MARK}receipt]]\n{"title":\n\n顺便说一句，日志我看过了。`],
    ['只有标记', `${CARD_MARK}receipt]]`],
    ['标记后没有对象', `${CARD_MARK}receipt]] 然后呢`],
    ['括号不配平', `${CARD_MARK}query-answer]]\n{"title":"T","verdict":"V","evidence":["a"`],
    ['字段名全错', `${CARD_MARK}receipt]]\n{"标题":"乱写","结论":"乱写"}`],
    ['嵌套花括号', `${CARD_MARK}decision]]\n{"title":"定一下","ask":"选哪个？","options":[{"label":"A","cost":"x"}]}`],
    // ★ 下面三条是本轮补的。原表 13 条里**没有一条是「含内部标记的纯文本」**，
    //   而 2026-09-17 那条真事故（连列 19 次 list_files 的 434 字故障输出）
    //   **正是纯文本** —— 断言没喂到那个形状，纯文本路径就一直没有执行点。
    ['★ 纯文本 + tool_calls', '查完了。tool_calls=[] finishReason=stop'],
    ['★ 纯文本 + 连列同名工具（2026-09-17 那条的形状）',
     '我查了几轮还是没能得出可靠结论。我试过 list_files、list_files、list_files、list_files，call_abc1234567890'],
    ['★ 纯文本 + 栈帧', '出错了。\n at handler (/Users/x/a.mjs:12:34)'],
  ];
  for (const [name, txt] of leakCases) {
    let r;
    try { r = toCardOrText(txt); }
    catch (e) { no(`J2 ${name}`, `toCardOrText 抛异常：${e.message}`); continue; }
    if (typeof r.text !== 'string' || !r.text.length) { no(`J2 ${name}`, '产出的文本是空的 —— 降级不许变成不答'); continue; }
    if (leaksInternalMark(r.text)) no(`J2 ${name}`, `要发出去的文本里还留着内部标记：${JSON.stringify(r.text.slice(0, 120))}`);
    else ok(`J2 ${name} → ${r.mode}，文本无标记残留`);
  }

  // J2b 公开格（对方一眼能看到的格子）里不许有内部标识 —— 折叠区里允许，
  // 那正是 alert 这个类型存在的理由。
  {
    const r = toCardOrText(`${CARD_MARK}alert]]\n{"title":"坏了","what":"tool_calls 有 27 次","impact":"没答上"}`);
    if (r.mode !== 'card') no('J2b 内部记录被搬进折叠区', `没有建出卡：${r.reason}`);
    else {
      const pub = publicTextOf(r.card);
      const folded = JSON.stringify(r.card).includes('tool_calls');
      if (leaksInternalMark(pub)) no('J2b 公开格干净', `公开格里有内部标识：${JSON.stringify(pub.slice(0, 120))}`);
      else if (!folded) no('J2b 内部记录没有被丢弃', '搬走之后内部详情整个不见了 —— 拦住和丢掉是两回事');
      else ok('J2b 内部记录被搬进折叠区，公开格干净');
    }
  }

  // J3 结论超长必须**搬走**而不是**砍掉**：一个字符都不许丢。
  {
    const long = '这是一句很长的结论。'.repeat(12);
    const { data, moved } = enforceLimits('query-answer', { verdict: long });
    const rejoined = [...data.verdict, ...(data.evidence ?? []).join('')].join('');
    const lost = [...long].filter((ch) => !rejoined.includes(ch)).length;
    if (moved.length === 0) no('J3 超长结论被搬迁', '超过 60 字却没有产生任何搬迁记录');
    else if (lost) no('J3 超长结论零丢失', `搬迁后丢了 ${lost} 个字符 —— 搬是搬，砍是砍，不能混`);
    else ok(`J3 超长结论搬迁且零丢失（${moved.length} 条搬迁记录）`);
  }

  // J4 块之外还有正文时，正文要进折叠区，不能凭空消失
  {
    const r = toCardOrText(`前面这句要说。\n\n${CARD_MARK}receipt]]\n{"title":"已收到","verdict":"收到。"}`);
    const inCard = JSON.stringify(r.card ?? {});
    if (!inCard.includes('前面这句要说')) no('J4 块外正文并入折叠区', '块外的话被丢掉了');
    else ok('J4 块外正文并入折叠区');
  }

  // J5 没有块时必须是原样透传 —— 信封不许改写正常回答
  {
    const plain = '这是一条普通回复，带 `代码` 和 **粗体**。\n\n| a | b |\n|---|---|\n| 1 | 2 |';
    const r = toCardOrText(plain);
    if (r.mode !== 'text' || r.text !== plain) no('J5 无块时原样透传', `mode=${r.mode}，文本被改动了`);
    else ok('J5 无块时原样透传');
  }

  // J5b ★★ 2026-10-26 二轮（Owner「恢复到 10/22 的输出格式」）：
  //   漏写开标记、只留下闭合标记时，10-22 的口径是**纯文本原样出门（不造卡）**；
  //   而孤立的信封标记必须清掉 —— 两件事一起钉，缺一条就是「格式又漂了」或「标记漏到群里」。
  {
    const raw = '差异：本次工具状态变化。\n\n| 项 | 值 |\n| --- | --- |\n| 上一次 | kb_status 可调用 |\n| 这一次 | kb_status 不可调用 |\n[[/card]]';
    const r = toCardOrText(raw);
    const txt = String(r.text ?? '');
    if (r.mode !== 'text' || r.card) {
      no('J5b 漏标记时按 10/22 口径走纯文本（不造卡）', `mode=${r.mode}｜kind=${r.kind}`);
    } else if (txt.includes('[[/card]]') || !txt.includes('kb_status 可调用') || !txt.includes('kb_status 不可调用')) {
      no('J5b 纯文本出门时孤立标记清掉、变化前后保留', txt.slice(0, 160));
    } else ok('J5b 漏标记不造卡：纯文本原样出门，孤立 [[/card]] 已清掉、前后值都在');
  }

  // 图片审查模型可能漏出卡片信封。★★ 2026-10-26 二轮（Owner「恢复到 10/22 的输出格式」）：
  //   10-22 的口径是**纯文本原样出门**，发送层不许拿模型自由文本拼卡 ——
  //   当天上午那一版拼出来的形状是「标题＝首段、正文首行＝同一段」，实测 `oc_7775…` 14:08:19。
  //   这一条同时钉住两件事：**不造卡**、**内容一字不丢**（丢了话比格式难看更严重）。
  {
    const raw = '图片审查结论：未判。\n\n画面观察\n人物抱着婴儿，背景有床。\n\n'
      + '| 项目 | 读数 |\n| --- | --- |\n| 图上文字 | 未能辨认 |\n\n下一步：请补充原始文案。';
    const r = toCardOrText(raw);
    const txt = String(r.text ?? '');
    if (r.mode !== 'text' || r.card) {
      no('J5c 图片自由格式答复按 10/22 口径走纯文本（不造卡）',
         `mode=${r.mode}｜kind=${r.kind}｜${txt.slice(0, 180)}`);
    } else if (!txt.includes('图片审查结论：未判。') || !txt.includes('未能辨认')
               || !txt.includes('请补充原始文案')) {
      no('J5c 纯文本出门时正文一字不许丢', txt.slice(0, 180));
    } else ok('J5c 图片自由格式答复原样走纯文本：不造卡、正文一字不丢');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // J5d–J5f ★★ 2026-10-26（Owner 当场贴出三条真回复）：
  //   「守衡的回复没有按照 prd 和原先的输出模版来回复，定位马上修复」
  // ══════════════════════════════════════════════════════════════════════════
  //   真回复（私聊 `oc_TEST_P2P`，11:39 / 11:51 / 12:08）逐字长这样：
  //     `- label = REVIEW / layer = DP3 / release_status = 待放行 / parse_status = ok`
  //     `coverage = partial；空命中或证据不足时，只能判定为 REVIEW`
  //   两件事同时坏了，两条都得钉：
  //     ① 送审单**没有 PRD §5.3 结论行**时，模型那段自由文本被原样当成答复发出去
  //        （`reviewRequired` 那个模板**写好了却没有任何调用方** —— §2.4 的「传了但没人接」）；
  //     ② 引擎内部字段名（`label` / `layer` / `DP3` / `parse_status` / `coverage`…）
  //        进了用户可见正文（判据与清理在 `reply-cards/jargon.mjs`）。

  // J5d 送审单 + 拿不到结论行 ⇒ 固定「审查未完成」模板，且黑话一行都不上卡。
  {
    const raw = '第二张图的判定结果和第一张完全一样，我看不出它们是不是同一张：因为我读不了图片内容。\n\n'
      + '- `label = REVIEW` / `layer = DP3` / `release_status = 待放行` / `parse_status = ok`\n'
      + '- 命中 **0 条**';
    // ★ 报告链接一起喂：**换了模板不许把链接丢掉**（Owner 2026-10-09 定的口径，
    //   `test_agent` Z18 钉着）。实测过：`alert` 那一档原先**一个能放链接的格都没有**
    //   ⇒ 走固定模板时链接被 `no-slot` 静默丢掉，而走 `query-answer` 时是在的。
    const DOCX = 'https://momcozy-in.feishu.cn/docx/J5DALERT';
    const r = toCardOrText(raw, { reviewRequired: true, reportLink: DOCX });
    const json = JSON.stringify(r.card ?? {});
    if (r.mode !== 'card' || r.kind !== 'alert'
        || json.includes('DP3') || json.includes('release_status') || json.includes('parse_status')
        || json.includes('label = ')) {
      no('J5d 送审单无结论行 ⇒ 固定「审查未完成」模板',
         `mode=${r.mode}｜kind=${r.kind}｜${json.slice(0, 180)}`);
    } else if (!json.includes(DOCX)) {
      no('J5d 换模板不许丢报告链接', `链接没上卡：${json.slice(0, 180)}`);
    } else ok('J5d 送审单无 §5.3 结论行走固定模板，引擎黑话一行都没上卡、报告链接仍在卡上');
  }

  // J5e 卡片字段里的黑话也要摘（按**数据**摘，不能按行摘 —— 按行会把 JSON 摘坏）。
  {
    const raw = '[[card:query-answer]]\n' + JSON.stringify({
      title: '图的判定', verdict: '照它转述。',
      evidence: ['判定结果：label = REVIEW / layer = DP3 / release_status = 待放行 / parse_status = ok',
                 '命中 0 条'],
    });
    const r = toCardOrText(raw);
    const json = JSON.stringify(r.card ?? {});
    if (r.mode !== 'card') no('J5e 卡片字段里的引擎黑话被摘掉', `没有建出卡：${r.reason}`);
    else if (json.includes('DP3') || json.includes('parse_status') || json.includes('release_status')) {
      no('J5e 卡片字段里的引擎黑话被摘掉', `卡面仍带黑话：${json.slice(0, 180)}`);
    } else if (!json.includes('命中')) {
      no('J5e 摘的是那一行、不是整段', `同一条里另一行也被摘掉了：${json.slice(0, 180)}`);
    } else ok('J5e 卡片字段里的引擎黑话被逐行摘掉，同组其余内容一字未动');
  }

  // J5f 反向对照（两条）：**不许**把「像内部读数的正常句子」一起吃掉。
  //   少了这一条，「不许出现黑话」会悄悄滑成「出现 coverage / DP 这类词就不发」。
  {
    const keep = '这段 coverage 说明讲的是覆盖率口径，跟 DP 无关。';
    const r = toCardOrText(keep);
    if (!String(r.text ?? '').includes('coverage 说明')) {
      no('J5f 反向对照：不带赋值的正常句子不许被摘', `被吃掉了：${String(r.text).slice(0, 160)}`);
    } else ok('J5f 反向对照：不带赋值的正常句子原样保留');

    // 反向对照 ②：**非送审单**不受「审查未完成」模板影响（按 10/22 口径是纯文本，不是卡）。
    const r2 = toCardOrText('今天的日更跑完了，没问题。');
    if (r2.mode !== 'text' || r2.kind === 'alert') {
      no('J5f 反向对照：非送审单不许套审查未完成模板', `mode=${r2.mode}｜kind=${r2.kind}`);
    } else ok('J5f 反向对照：非送审单仍是纯文本（送审判据没有外溢）');
  }

  // J8 ★ PRD §5.3 结论行进标题时，纯文本渲染**不许叠方括号**（2026-10-06 实发事故）
  //
  //   真事：08:25 那条 PASS 回复，卡片表头是对的（`header.title` 是 raw plain_text），
  //   但台账与**降级文本**里成了 `【【审查结论：PASS】…进行 sign-off。】` ——
  //   因为 `renderText` 本来会给标题套一层 `【…】` 当标题样式。
  //   降级文本是「卡片发不出去时原样进群」的那条兜底，所以这处偏差**只在出事那一跳才看得见**。
  {
    const LINE = '【审查结论：PASS】未发现已知底线风险，可转交 @sign-off 责任人（未配置） 进行 sign-off。';
    const r = toCardOrText('[[card:query-answer]]\n' + JSON.stringify({ title: '旧标题', verdict: 'x' }),
                           { verdict53: { state: 'PASS', line: LINE, from: 'chain' } });
    const first = r.text.split('\n')[0];
    if (first !== LINE) no('J8 §5.3 结论行进纯文本时逐字且不叠括号', `实际第一行：${JSON.stringify(first.slice(0, 70))}`);
    else ok('J8 §5.3 结论行进纯文本时逐字且不叠括号');

    // 反向对照：**普通**标题仍必须被套一层。
    // 少了这一条，「不许叠括号」会悄悄滑成「所有标题都不加括号」—— 那会把标题样式整个取消。
    const first2 = toCardOrText('[[card:receipt]]\n' + JSON.stringify({ verdict: '收到。' })).text.split('\n')[0];
    if (first2 !== '【已收到】') no('J8 反向对照：普通标题仍套一层', `实际：${JSON.stringify(first2)}`);
    else ok('J8 反向对照：普通标题仍套一层');
  }

  // ═══════════ J9 ★ 配色：两类不许撞色 + 底色闭集（2026-10-06 加）═══════════
  //
  //   起因是委托方看截图提的两条：「回执卡不要灰色」+「不要跟其他卡片颜色冲突」。
  //   当时 `receipt` 与 `capability-boundary` **都是 grey** —— 而回执是发得最多的一张。
  //
  //   这一段的立场：**颜色是语义，不是装饰**，所以「撞色」是一条可判定的断言，
  //   而不是审美意见。J9a 是它的执行点；没有 J9a，下一个人把两个类型改成同色
  //   不会有任何东西变红（§2.4：写进文档的约束必须指得出哪一行在拦它）。
  {
    // J9a 十类的配色**两两不同**。判据写成纯函数，好让反向对照直接喂坏样本。
    const dupColors = (tone) => {
      const by = new Map();
      for (const [kind, c] of Object.entries(tone)) {
        if (!by.has(c)) by.set(c, []);
        by.get(c).push(kind);
      }
      return [...by.entries()].filter(([, ks]) => ks.length > 1);
    };
    const dups = dupColors(TONE);
    if (dups.length) {
      no('J9a 十类配色两两不同', dups.map(([c, ks]) => `${c} 被 ${ks.join('/')} 共用`).join('；'));
    } else {
      ok(`J9a 十类配色两两不同（${Object.keys(TONE).length} 类 / ${new Set(Object.values(TONE)).size} 色）`);
    }

    // J9a-反向对照：喂一份**故意撞色**的 TONE，判据必须红。
    // 少了这一条，`dupColors` 写成恒返回 [] 也照样绿 —— 那正是 §2.4 点名的假执行点。
    const badTone = { ...TONE, 'capability-boundary': TONE.receipt };
    if (dupColors(badTone).length !== 1) no('J9a 反向对照：故意撞色必须被抓', '喂了同色的两份，判据没红');
    else ok('J9a 反向对照：故意撞色必须被抓');

    // J9b 每个配色都必须出自 `TEMPLATES` 闭集 —— 枚举外的值服务端会静默忽略。
    {
      const outside = Object.entries(TONE).filter(([, c]) => !TEMPLATES.includes(c));
      if (outside.length) no('J9b 配色都在 TEMPLATES 闭集里', outside.map(([k, c]) => `${k}=${c}`).join('；'));
      else ok('J9b 配色都在 TEMPLATES 闭集里');
    }

    // J9c 回执卡：表头必须是淡暗粉那一档，且正文必须真的坐上同族色带。
    //
    //   为什么两条都要：只查表头的话，把色带悄悄删掉照样绿 ——
    //   而委托方挑的是 **D**（表头 + 正文色带），少一半就不是他看中的那张。
    {
      const c = build('receipt', { verdict: '收到了，正在处理。' });
      if (c.header.template !== 'carmine') {
        no('J9c 回执表头 = carmine', `实际 ${JSON.stringify(c.header.template)}`);
      } else ok('J9c 回执表头 = carmine（淡暗粉，momcozy 品牌色族）');

      const bandEl = c.body.elements.find((e) => e.tag === 'column_set');
      if (bandEl?.background_style !== 'carmine-50') {
        no('J9c 回执正文带 carmine-50 色带', `实际 ${JSON.stringify(bandEl?.background_style)}`);
      } else ok('J9c 回执正文带 carmine-50 色带');
    }

    // J9d 底色闭集**真的会拦**。
    //
    //   ★ 这条比 J9b 重要：飞书对未知底色是**静默忽略**的（表头写 `pink` 也 code=0，
    //     2026-10-06 实测六个未知取值全部发送成功）。也就是说写错颜色的表现
    //     **不是报错，是安静地变成另一个颜色** —— 唯一能拦它的就是本地校验。
    {
      const base = build('receipt', { verdict: 'x' });
      const withStyle = (v) => {
        const c = JSON.parse(JSON.stringify(base));
        c.body.elements[0].background_style = v;
        return validateCard(c);
      };
      if (withStyle('chartreuse-50').ok) no('J9d 未登记底色必须被拦', 'chartreuse-50 竟然过了');
      else ok('J9d 未登记底色必须被拦（chartreuse-50）');

      // 反向对照：闭集里那两个必须照常通过，否则这条闸门会变成砖头。
      const allowed = [...BACKGROUND_STYLES].filter((v) => !withStyle(v).ok);
      if (allowed.length) no('J9d 反向对照：登记过的底色必须放行', `${allowed.join('/')} 被误拦`);
      else ok(`J9d 反向对照：登记过的底色放行（${[...BACKGROUND_STYLES].join('/')}）`);
    }

    // J9e 十类的配色必须与 `contract.md` 那张表逐格一致。
    //
    //   文档说 `alert` 是 carmine、代码却发 red —— 这种漂移不会红任何东西，
    //   而它正是「文档里的读数是过期的」这个老病（§2.4.1 第 5 行）。
    {
      const md = fs.readFileSync(path.join(CARDS_DIR, 'contract.md'), 'utf8');
      const drift = [];
      for (const [kind, color] of Object.entries(TONE)) {
        // 表行形如：| `alert` | **red** | 我这侧坏了 |
        const re = new RegExp(`\\|\\s*\`${kind.replace(/[-]/g, '\\-')}\`\\s*\\|\\s*\\*{0,2}${color}\\*{0,2}\\s*\\|`);
        if (!re.test(md)) drift.push(`${kind} 应为 ${color}`);
      }
      if (drift.length) no('J9e contract.md 配色表与 TONE 一致', `对不上：${drift.join('；')}`);
      else ok('J9e contract.md 配色表与 TONE 一致（逐格）');
    }
  }

  // ═══════ J10 ★ 媒材读数必须进卡片正文（2026-10-06 加）═══════
  //
  //   事故（Owner 原话「视频还是无法读取」）：他发的 15 秒视频**内核读成功了** ——
  //   8 帧全抽出来、OCR 成功、音轨确认没人说话 —— 而那三个读数**只进了日志**。
  //   卡片正文通篇在讲知识库自己的事（「覆盖判据不成立」「缺的是库覆盖，补素材无用」），
  //   一句没讲他视频里有什么 ⇒ 结论读起来就是「它没看我的视频」。
  //
  //   判据分三面：搬得进去 / 位置对 / 没有读数时不许凭空造。
  {
    const READ = '视频 1 段｜读成功 1 · 失败 0\n视频 1：15.0 秒｜抽帧 OCR 8/8 帧（共 51 字）｜音轨里没人说话';
    const mk = (opts) => toCardOrText(
      '[[card:query-answer]]\n' + JSON.stringify({ title: 'x', verdict: 'REVIEW：覆盖判据不成立。' }), opts);

    // ★★ 2026-10-13（Owner 反转了这一条）：**媒材读数不再上卡**。
    //   他 2026-10-06 说「视频还是无法读取」，那时把读数搬上了卡；
    //   2026-10-13 他把那一整段贴回来说「这里多余的回复也去掉」。
    //   ⇒ 判据**反过来钉**：卡上不许有它，但读数**一条都没丢**（日志 / 记忆 / 报告附录三处）。
    const r = mk({ verdict53: { state: 'REVIEW', line: '【审查结论：REVIEW】共发现 1 处需人工确认。', from: 'chain' },
                   mediaRead: READ });
    const whole = JSON.stringify(r.card ?? {});
    if (whole.includes('我读到了') || whole.includes('15.0 秒')) {
      no('J10a 媒材读数**不许**上卡（Owner 2026-10-13）', whole.slice(0, 140));
    } else ok('J10a 媒材读数不上卡（Owner 2026-10-13 反转了 10-06 那条要求）');
    // 结论行仍必须占标题（撤读数与结论行的位置无关）
    if (r.card?.header?.title?.content !== '【审查结论：REVIEW】共发现 1 处需人工确认。') {
      no('J10a2 结论行仍在标题里', `实际：${JSON.stringify(r.card?.header?.title?.content)}`);
    } else ok('J10a2 结论行仍在标题里');

    // J10b **反向对照（搬不是砍）**：读数不上卡 ≠ 读数没了 ——
    //   生产它的那一处必须还在，而且三处落点各自都要有接线（少一处就是静默丢）。
    const AG = fs.readFileSync(path.join(HERE, 'agent', 'agent.mjs'), 'utf8');
    const WD = fs.readFileSync(path.join(HERE, 'ws_daemon.mjs'), 'utf8');
    if (!/export function describeMediaRead/.test(AG)) {
      no('J10b 读数的产者必须还在（撤的只是上卡那一跳）', 'describeMediaRead 没了');
    } else if (!/📥 读到/.test(WD) && !/mediaReadAppendix/.test(AG) && !/describeMediaRead\(inbound\)/.test(WD)) {
      no('J10b 读数的三处落点至少要各有一处接线', '日志 / 报告附录 / 记忆 都找不到');
    } else ok('J10b 读数仍由 describeMediaRead 产出，且日志与报告附录的接线都还在');
    // J10c 反向对照：**没有**读数时当然也不许冒出「我读到了」
    const r2 = mk({ verdict53: null });
    if (JSON.stringify(r2.card?.body ?? {}).includes('我读到了')) {
      no('J10c 反向对照：无媒材时不许凭空造读数', '没有读数却出现了「我读到了」');
    } else ok('J10c 反向对照：无媒材时不许凭空造读数');
  }

  /* ── J11 评审单的 PRD §5.3 逐条块**必须落得下**（2026-10-07 实发缺口）─────────────
   *  病灶：卡片类型由模型挑，而 11 种里**只有 `query-answer`（reasoning）与 `evidence`（groups）**
   *        装得下逐条块；挑到 `turn-diff` 等类型 ⇒ `applyVerdictLine` 返回 `no-slot`
   *        ⇒ **块被静默丢掉、卡片照发** ⇒ Owner 当场报「你改了后就不按 PRD 格式输出了」。
   *  判据三层（缺一层都不算）：能不能换 · 换了块在不在 · 原内容丢没丢。＋两条反向对照。
   */
  {
    // 已经有结论块的卡也必须展开正文组。此前 early-return 保留了模型默认的
    // expanded:false，最终消息只有「共发现 N 处」，问题和建议藏在折叠区。
    const block = '【审查结论：REVIEW】共发现 1 处需人工确认。\n1.【产品安全】顶部，图 1 第 2 处\n建议：同房不同床，宝宝睡独立婴儿床';
    const present = { title: '【审查结论：REVIEW】共发现 1 处需人工确认。',
      groups: [{ title: '逐条问题', content: block, expanded: false }] };
    const applied = applyVerdictLine('evidence', present, {
      state: 'REVIEW', line: '【审查结论：REVIEW】共发现 1 处需人工确认。', from: 'chain', block,
    });
    if (applied.action !== 'already' || applied.data.groups?.[0]?.expanded !== true
        || !applied.data.groups[0].content.includes('同房不同床')) {
      no('J11b4 已存在的逐条块必须展开并保留知识库建议', JSON.stringify(applied));
    } else ok('J11b4 已存在的逐条块默认展开，具体问题与建议可见');

    const V53 = { state: 'BLOCK', line: '【审查结论：BLOCK】共发现 6 处必须修改。', from: 'chain',
      block: '【审查结论：BLOCK】共发现 6 处必须修改。\n知识库侧 3 条 ／ 模型侧 3 条\n\n'
           + '1.【合规】素材正文  —— **模型侧**（无库内依据）\n   原因：FDA 批准表述\n'
           // ★★ 2026-10-14（Owner 裁定「去掉『判定』这个字段」）：夹具里的 `判定：REVIEW` 去掉 ——
           //   逐条块不再有这一行（三态只在结论行一处）。四条逐条要素照旧：原因/依据/建议。
           + '   依据：无库内依据\n   建议：转对应负责人复核。\n\n请修改后重新提交。' };
    const RAW_DIFF = '[[card:turn-diff]]\n' + JSON.stringify({
      verdict: '库侧 0 条→3 条，结论 BLOCK 未变', before: '上一次：REVIEW，报「知识库侧 0 条」',
      after: '这一次：BLOCK，报「知识库侧 3 条」', cause: '上游口径修正',
      fields: [{ label: '耗时', value: '110.809 ms → 45.564 ms' }] }) + '\n[[/card]]';

    const r = toCardOrText(RAW_DIFF, { verdict53: V53 });
    const groups = r.data?.groups ?? [];
    if (r.mode !== 'card' || r.kind !== 'evidence') {
      no('J11a 评审单遇装不下的类型 ⇒ 换 evidence', `mode=${r.mode} kind=${r.kind}`);
    } else ok('J11a 评审单遇装不下的类型 ⇒ 换 evidence');
    const g0 = String(groups[0]?.content ?? '');
    // ★★ 2026-10-14（Owner：「去掉『审查结论』多余的」）：组标题改「逐条问题」，
    //   且块首那行结论行**已不在卡内版里**（抬头独占）⇒ 断言跟着改成查「条数行」。
    if (groups[0]?.title !== '逐条问题' || !g0.includes('1.【合规】') || /【审查结论\s*[：:]/.test(g0)) {
      no('J11b 换卡后逐条块必须在第一组（含结论行与逐条四要素）', JSON.stringify(groups[0]?.title));
    } else ok('J11b 换卡后逐条块必须在第一组（含结论行与逐条四要素）');
    // ★ J11b2（2026-10-08，Owner：「… · 0 是什么意思？」）：
    //   第一组**不许带 `count`** —— 实测发出去过「PRD §5.3 结论块 · 0」，
    //   而同一块正文写着「共发现 3 处必须修改」⇒ 标题说 0、正文说 3，同一张卡自相矛盾。
    //   条数只在**有结构化真值**时才给，这里拿不到 ⇒ 就是不给（不是给个 0 占位）。
    //   ⚠️ 这条断言盯的是**数据**（`groups[0].count`），不是渲染出来的字符串 ——
    //      字符串层面 `cards.mjs` 已改成"有才拼"，在这里再查一遍是查不出占位的。
    if (groups[0]?.count !== undefined) {
      no('J11b2 第一组不许带计数占位（发过「· 0」）', JSON.stringify(groups[0]?.count));
    } else ok('J11b2 第一组不许带计数占位（发过「· 0」）');
    // ══════════════════════════════════════════════════════════════════════════
    // ★★ J11b3（2026-10-16 FIX-033 起；2026-10-21 **翻面**；2026-10-26 **翻回来**）
    //    **≥3 汇总块必须折进「逐条问题」这一组** —— Owner 贴的成品第二行就是它。
    // ══════════════════════════════════════════════════════════════════════════
    //   这条路翻过两次，两次都对着同一份模版（`docx/CvIldNhUSoxv7DxpzwdcKUcjnfr`），
    //   结论相反 —— 记全，免得第三次又从中间开始：
    //     · 2026-10-16：钉「组标题与组内容首行不许逐字相同」（治卡上连着两个「逐条问题」）；
    //     · 2026-10-21 晚：判定「模版结论行直接接 `· …类问题：N 个`，中间没有小标题」，
    //       于是 ≥3 改走 `body` 正文格、卡面不再出现「逐条问题」；
    //     · 2026-10-26：Owner 贴出三段成品（1 条 / 2 条 / 3 条）逐字说「这是我想要的输出模版」，
    //       **三段第二行都是「逐条问题」** ⇒ 撤回 10-21 那次分流，两条支都折成这一组。
    //   ⚠️ 两次说法都对得上各自的证据：10-21 台账里 ≥3 那两条（10:34:36 / 10:51:28）确实没有
    //     这一行，而 Owner 手上的成品有 —— 说明「10-21 的输出」不止一个版本。
    //     判据**按用户最后给的形状**钉，并在注释里留下这条分歧，别当它没发生过。
    //   ⚠️ 这一行**只进组标题**；块文本（表行那一格、`prd53_format` ②b2/②f）里仍然没有它。
    {
      // 夹具用**存量形状**（块里还带着那一行）—— 线上飞出过的就是它。
      const SUM_BLOCK = '【审查结论：REVIEW】共发现 5 处需人工确认。\n\n'
        + '逐条问题\n· 合规类问题：3 个\n· 措辞表达类问题：2 个\n\n'
        + '→ 查看完整问题清单与修改建议：https://feishu.cn/review/x\n\n'
        + '建议转 @法务（未配置） 复核。';
      const V53_SUM = { state: 'REVIEW', line: '【审查结论：REVIEW】共发现 5 处需人工确认。',
                        from: 'chain', block: SUM_BLOCK };
      const rSum = toCardOrText('模型这一轮没给卡片块，只写了些话。', { verdict53: V53_SUM,
        imageAnalysis: '图 1｜OCR 20 行；视觉模型读数：卧室，婴幼儿与成人同床，婴儿睡姿仰卧。' });
      const panels = (rSum.card?.body?.elements ?? []).filter((e) => e?.tag === 'collapsible_panel');
      const cardText = JSON.stringify(rSum.card ?? {});
      if (panels.length !== 1 || panels[0].header?.title?.content !== VERDICT_GROUP_TITLE) {
        no(`J11b3 ≥3 汇总块必须折进「${VERDICT_GROUP_TITLE}」一组（Owner 2026-10-26 模版第二行）`,
           `折叠组 ${panels.length} 个：${panels.map((p) => p.header?.title?.content).join(' / ')}`);
      } else if (panels[0].expanded !== true) {
        no('J11b3 ≥3 那一组必须默认展开（它是结论正文，不是附录）', JSON.stringify(panels[0].expanded));
      } else ok(`J11b3 ≥3 汇总块折进「${VERDICT_GROUP_TITLE}」一组且默认展开`);
      // 只剥那一行、别剥多了：**组内**必须有汇总行与链接行（剥多了就是把内容删了）
      const groupSum = String(panels[0]?.elements?.[0]?.content ?? '');
      const bodySum = String(rSum.data?.body ?? '');
      if (!/· .*类问题：\d+ 个/.test(groupSum) || !/→ 查看完整问题清单与修改建议/.test(groupSum)) {
        no('J11b3b 组内只剩汇总行与链接行、并一个字都没少', groupSum.slice(0, 160));
      } else ok('J11b3b 组内汇总行与链接行都在，且组里不再重复印「逐条问题」标题');
      // ★ 反向对照（真判据）：**把汇总块放回 body** ⇒ 上面那条必须变红。
      //   这一段直接构造「10-21 晚那次分流」的结果，断言判据咬得住它。
      {
        const routed = { groups: [], body: SUM_BLOCK };
        const wouldPass = (Array.isArray(routed.groups) ? routed.groups : []).length === 1;
        if (wouldPass) {
          no('J11b3c 反向对照：把汇总块放回 body 必须被判红', '构造出来的反例居然通过了');
        } else ok('J11b3c 反向对照：把汇总块放回 body 的写法，本判据咬得住（groups 为空 ⇒ 判红）');
      }
      // ★ 2026-10-22（Owner：「输出的卡片不展示 视觉分析与 OCR」）：
      //   夹具**照样塞** imageAnalysis —— 判据要证明的是「卡面对这个入参彻底不认」，
      //   而不是「没给时不印」（后者是恒真的）。
      if (/视觉分析与 OCR/.test(cardText) || /视觉模型读数/.test(cardText)) {
        no('J11b3d 卡面不许再展示「视觉分析与 OCR」（Owner 2026-10-22）', cardText.slice(-240));
      } else ok('J11b3d 卡面不再展示视觉分析与 OCR（给了入参也不印）');
      // ★ 反向对照（本仓纪律）：**<3 的逐条块必须照旧折起来** ——
      //   若这条不成立，说明是「一刀切把折叠去掉了」，而不是「按形状分流」。
      const SMALL_BLOCK = '【审查结论：REVIEW】共发现 1 处需人工确认。\n\n'
        + '1.【合规-医疗宣称】正文第 1 段\n   原因：未证实\n   建议：删掉';
      const rSmall = toCardOrText('模型这一轮没给卡片块，只写了些话。',
        { verdict53: { state: 'REVIEW', line: SMALL_BLOCK.split('\n')[0], from: 'chain', block: SMALL_BLOCK } });
      const pSmall = (rSmall.card?.body?.elements ?? []).filter((e) => e?.tag === 'collapsible_panel');
      if (pSmall.length !== 1 || pSmall[0].header?.title?.content !== VERDICT_GROUP_TITLE) {
        no('J11b3c 反向对照：<3 的逐条块必须照旧折成一组（证明是分流、不是一刀切）',
           `折叠组 ${pSmall.length} 个：${pSmall.map((p) => p.header?.title?.content).join(' / ')}`);
      } else ok('J11b3c 反向对照：<3 的逐条块照旧折成「逐条问题」一组');
    }
    // ★★ 2026-10-13（Owner：「群聊里跟私聊的格式不一样？」）：**评审单的形状由代码定** ——
    //   模型自拟的分组/结论格/块外正文**都不上卡**（它们仍是这一轮的回复正文，
    //   会话记忆与 `💬 回复 N 字` 日志里都在）。所以 J11c 从「原卡内容必须逐字搬过去」
    //   改成反过来钉：**它不许上卡**，且**给不给卡，卡面必须逐字一样**。
    const carried = groups.map((g) => String(g?.content ?? '')).join('\n');
    if (carried.includes('上游口径修正')) {
      no('J11c 模型自拟的分组不许上卡（Owner 2026-10-13）', carried.slice(0, 120));
    } else ok('J11c 模型自拟的分组不上卡');

    // J11c2 ★★ **这就是 Owner 报的那件事**：同一个 §5.3 块，
    //   「模型给了卡」与「模型没给卡」两条路必须产出**同一张卡**。
    //   少了这一条，两边各自看着都对，而群里/私聊的格式照样不一样。
    {
      const shapeOf = (r) => JSON.stringify({
        kind: r.kind,
        title: r.card?.header?.title?.content,
        tags: (r.card?.body?.elements ?? []).map((e) => e.tag),
        titles: (r.card?.body?.elements ?? []).filter((e) => e.tag === 'collapsible_panel')
          .map((e) => e.header?.title?.content),
      });
      const withCard = toCardOrText(RAW_DIFF, { verdict53: V53 });
      const noCard = toCardOrText('模型这一轮没给卡片块，只写了些话。', { verdict53: V53 });
      if (shapeOf(withCard) !== shapeOf(noCard)) {
        no('J11c2 评审单：模型给不给卡，卡面形状必须**逐字一样**',
           `给卡=${shapeOf(withCard)} ／ 不给卡=${shapeOf(noCard)}`);
      } else ok('J11c2 评审单：模型给不给卡，卡面形状逐字一样（Owner 报的那件事已收口）');
      // 反向对照：**非评审单**（没有 §5.3 块）时，模型给的卡照用 —— 不许一刀切
      const plainWithCard = toCardOrText(RAW_DIFF, { verdict53: { state: 'BLOCK', line: V53.line, from: 'chain' } });
      if (plainWithCard.kind !== 'turn-diff') {
        no('J11c3 反向对照：没有 §5.3 块时，模型给的卡照用', `kind=${plainWithCard.kind}`);
      } else ok('J11c3 反向对照：没有 §5.3 块时模型给的卡照用（没被一刀切）');
    }

    // J11d 反向对照：**非评审单**不许换卡（否则等于借着 PRD 的名义改模型的形态选择）
    const rn = toCardOrText(RAW_DIFF, { verdict53: null });
    if (rn.kind !== 'turn-diff') no('J11d 反向对照：非评审单不许换卡', `kind=${rn.kind}`);
    else ok('J11d 反向对照：非评审单不许换卡');
    // J11e 反向对照：本来就装得下的类型（evidence）不许被动过
    const re = toCardOrText('[[card:evidence]]\n' + JSON.stringify({ verdict: 'x', groups: [] }) + '\n[[/card]]',
                            { verdict53: V53 });
    if (re.kind !== 'evidence') no('J11e 反向对照：装得下的类型不许换', `kind=${re.kind}`);
    else ok('J11e 反向对照：装得下的类型不许换');
  }

  /* ── J12 评审单**不许以纯文本出门**（2026-10-12 Owner：「守衡的输出格式变了」）────────
   *  实测（`PMO/logs/ws_outbound.jsonl` ＋ 会话原文 ＋ `ws_daemon.log` 三方对齐）：
   *    16:58 那条 1336 字 = `mode=reply-card`（卡，渲染正常）；
   *    19:31/19:53/19:55/19:58 四条 = `mode=reply`（**纯文本**），
   *    而模型原文里**没有 `[[card:` 块**，日志那行是 `落点=n/a·-｜逐条块=无`。
   *  ⇒ 飞书纯文本**不渲染 markdown**：群里看到的是 `**加粗**`、反引号与一堆 `|`。
   *
   *  判据四层（缺一层都不算）：建得出来 · 抬头是结论行 · 原话一字不丢且在折叠区 · 反向对照。
   *  ★ 为什么必须**直接调真生产者**：这一条盯的是「模型不给卡时信封层怎么兜」，
   *    夹具可以写得再对，兜底跳不过去的话群里照样是纯文本 —— 与 L 段同一条理由。
   */
  {
    const V53T = { state: 'BLOCK', line: '【审查结论：BLOCK】共发现 1 处必须修改。', from: 'dual-track-merged' };
    // 夹具**逐字取自 2026-10-12 那条被降级的真回复**（含 sha 形状的内部标识，
    // 它当时正是把纯文本这一路打成「正文含内部标识 ⇒ 整条拦下」的那一根刺）。
    const PROSE = '**结论：BLOCK —— 1 处必须修改（合并口径 2 处）。请修改后重新提交。**\n'
                + 'P0 快路（131.204 ms，命中 1 条模式 **H05**）—— 红线拦截，**未跑** L4→L5→L6→L7。\n\n'
                + '**命中**：模式 `p-08487282e2d400fe`｜**条款 W-1.33**｜判定 **事实（确定性逐字匹配）**。';

    const r = toCardOrText(PROSE, { verdict53: V53T });
    if (r.mode !== 'card') no('J12a 有结论行而模型没给卡 ⇒ 代码建卡', `mode=${r.mode} reason=${r.reason}`);
    else ok(`J12a 有结论行而模型没给卡 ⇒ 代码建卡（${r.kind}）`);

    const headTitle = r.card?.header?.title?.content ?? '';
    if (headTitle !== V53T.line) {
      no('J12b 代码建的卡：抬头必须是权威结论行', JSON.stringify(String(headTitle).slice(0, 60)));
    } else ok('J12b 代码建的卡：抬头是权威结论行（PRD §5.3「结论放最前面」）');

    // ★ 2026-10-14 改（Owner：出站一律不许有 `**`）——
    //   原先这一条查的是**卡里**能不能找到模型原话逐字。而在「出站摘符号」这条规矩生效后，
    //   卡里的 `**` 已经按规矩被摘掉了 ⇒ 逐字匹配必然失败。
    //   两件事各有落点，一条都不许丢：
    //     · **保真**（模型原话一个字不许丢）⇒ 查 `r.data`（槽位里的原文，摘符号**不改它**）；
    //     · **出站**（不许有星号）⇒ 查 `r.card`（要发出去的那一份）。
    //   把这两条并成一条会得到一个**二者只能取一**的假冲突 —— 而真正的约束是「都要」。
    const whole = JSON.stringify(r.card ?? {});
    const raw = JSON.stringify(r.data ?? {});
    if (!raw.includes('判定 **事实（确定性逐字匹配）**')) {
      // 原文在 data 里都找不到 ⇒ 真丢了（摘符号只该动卡，不该动数据）
      no('J12c 模型原话一个字不许丢', raw.slice(0, 120));
    } else if (whole.includes('*')) {
      // ★ 反向对照：卡里还留着星号 ⇒ 摘符号那一步没接上（Owner 2026-10-14 明确要的那条）
      no('J12c 出站卡里不许留 markdown 星号', whole.slice(0, 120));
    } else if (publicTextOf(r.card).includes('p-08487282e2d400fe')) {
      no('J12c 模型原话必须进折叠组', '内部标识留在公开格里 —— 折叠区才是它的位置');
    } else ok('J12c 模型原话逐字留在 data 里 · 卡里已摘符号 · 公开格干净');

    // J12d 反向对照：**没有**结论行 ⇒ 仍是纯文本（不许借着 PRD 的名义把闲聊全套成卡）
    const rn = toCardOrText('在。要审什么直接发素材就行。');
    if (rn.mode !== 'text' || rn.kind) no('J12d 反向对照：没有结论行的闲聊仍是纯文本', `mode=${rn.mode} kind=${rn.kind}`);
    else ok('J12d 反向对照：没有结论行的闲聊仍是纯文本');
  }
}

/* ─────── J13 守衡的**查证笔记**不许进群，而「我问的时候你要能回答」要有落点 ───────
 *  Owner 2026-10-13 原话（三条里的第 1、2 条）：
 *    「输出到飞书群包含知识库侧+模型侧的文字，**不要展示在卡片上**，**我问的时候，你要能回答**」
 *    「类似以下的文案都去掉：知识库侧 未报内容问题…／ℹ️ 知识库侧给了 覆盖缺口…／
 *      （问题数 8 ≥ 3 ⇒ 按 PRD §5.3.3 只出分类汇总…）／模型原话（原文照留）」
 *
 *  分工（与结论行、逐条块同一条：**模型不写、代码搬**）：
 *    · 那几行由 `dual_track.renderMerged` **从 `block` 里摘掉**，改走 `internalNotes`
 *      → `agent.mjs` 的 `chainBlock`（= 模型上下文 ＋ **会话记忆**）⇒ 追问答得出来；
 *    · 但「模型从不照抄 chainBlock 里别的东西」是**概率** ⇒ 信封层 `stripInternalNotes`
 *      是**执行点**：逐行认我们**自己产出的那几种固定形状**，命中即摘并留痕。
 *
 *  判据四层（缺一层都不算）：卡上不许有 · 留痕 · 普通句子不许误伤 · 接线真的接上。
 */
head('J13 查证笔记 · 不上卡、但要答得出来（Owner 2026-10-13 三条里的第 1、2 条）');
{
  // ★ 本段在 J 段那个 `{ }` **之外**（J12 之后），所以自己取一次 —— 不去依赖外面的作用域。
  const { toCardOrText, stripInternalNotes, publicTextOf } = await import(path.join(CARDS_DIR, 'envelope.mjs'));
  const NOTES = [
    '知识库侧 **未报内容问题**；另有 **1 条覆盖缺口**（库对该题材没有可依据的条款） ／ 模型侧 7 条（其中 7 条**无库内依据**，只能转人工）',
    'ℹ️ 知识库侧给了 **覆盖缺口**（`coverage_not_covered`）：检索有命中，但「既被规则引用、又达门限」的单元 0 条。',
    '（问题数 **8 ≥ 3** ⇒ 按 PRD §5.3.3 只出分类汇总，逐条清单与修改建议在报告里；1–2 条时才在卡上逐条平铺。）',
  ].join('\n');
  const V53 = { state: 'REVIEW', line: '【审查结论：REVIEW】共发现 8 处需人工确认。',
                from: 'dual-track-merged', block: '【审查结论：REVIEW】共发现 8 处需人工确认。' };
  const PROSE = `【审查结论：REVIEW】共发现 8 处需人工确认。\n${NOTES}\n\n1.【合规】全文\n   **原因**：x`;

  // J13a **卡上不许有**（模型把它抄进回复的那种形状）
  {
    const r = toCardOrText(PROSE, { verdict53: V53 });
    const whole = JSON.stringify(r.card ?? r.text ?? '');
    const leaked = ['未报内容问题', 'coverage_not_covered', '只出分类汇总'].filter((k) => whole.includes(k));
    if (leaked.length) no('J13a 查证笔记不许进卡（含折叠区）', `漏了：${leaked.join(' / ')}`);
    else ok('J13a 查证笔记不进卡（含折叠区）');
  }

  // J13a2 **模型原话整组也不上卡**（Owner 2026-10-13：他展开的那一组就是它）
  //   引的原文里全是内部读数：`P0 快路（258.167 ms…）`、`未跑 L4→L5→L6→L7`、
  //   `★ 表行（照抄）…行号 recvx…｜回读 consistent`、`观察：M8 这句跑第 3 次…`。
  {
    const r = toCardOrText(PROSE, { verdict53: V53 });
    const whole = JSON.stringify(r.card ?? '');
    const titles = (r.data?.groups ?? []).map((g) => String(g?.title ?? ''));
    if (titles.includes('详细说明')) {
      no('J13a2 模型原话整组不许上卡', `那一组还在：${JSON.stringify(titles)}`);
    } else if (whole.includes('1.【合规】全文')) {
      no('J13a2 模型原话整组不许上卡', '原话还在卡里（换了个组名也一样）');
    } else ok('J13a2 模型原话整组不上卡');

    // ★ **反向对照（安全网）**：`verdict53.block` 为空 ⇒ §5.3 块搬不进来
    //   ⇒ 那时**必须**照旧建那一组，否则卡上只剩一个抬头（比改动前更没法用）。
    //   ⚠️ 2026-10-15 我先在这里改错过一次（把这条期望翻过来、一刀砍掉那一组）——
    //     它连着**回复那条路**一起伤。真正的区别在**调用方**：见 J13a3b。
    const rNoBlock = toCardOrText(PROSE, { verdict53: { state: 'REVIEW', line: V53.line, from: 'x' } });
    if (!JSON.stringify(rNoBlock.card ?? '').includes('1.【合规】全文')) {
      no('J13a3 反向对照：§5.3 块搬不进来时必须退回原话组', '内容被丢光了');
    } else ok('J13a3 反向对照：§5.3 块搬不进来 ⇒ 照旧建原话组（安全网）');

    // ── J13a3b ★ 2026-10-15（真单 `om_x100b62333eaaf0a8b050a29473b0030`，Owner 当场指出「格式不符」）
    //
    //   那一单是 **PASS、问题数 0** ⇒ 链**本来就没有逐条块** ⇒ 走的是上面那张安全网 ——
    //   于是模型这一轮的回复正文（`链侧 PASS ｜ 0 处问题…`、`引擎结论（照抄 ③b 模板）…置信度 0.93`、
    //   `（未填）` 表格、`` `risk_items` 为空… ``）被当成**卡片正文**发进了群。
    //   批跑那条路没有真人对话，那一整段都是**我们自己的读数** ⇒ 调用方声明 `machineAnswer: true`。
    //
    //   判据分两半，**缺一半都不算**（不然「一律丢掉原话」也能过）：
    //     ① `machineAnswer` + 正文全是读数 ⇒ 卡上只剩权威结论行（本段）；
    //     ② `machineAnswer` 但正文有真内容 ⇒ 照旧保留（J13a3c 反向对照）。
    {
      const line53 = '【审查结论：PASS】未发现已知底线风险，可转交 @sign-off 责任人（未配置） 进行 sign-off。';
      const V53P = { state: 'PASS', line: line53, from: 'chain', block: null };
      const REAL = [line53,
        '链侧 PASS ｜ 0 处问题（只对 9 行 OCR 文字）；画面看不到、未审',
        '引擎结论（照抄 ③b 模板）：状态 PASS ｜ 问题数 0 ｜ 置信度 0.93；判定主体「图片安全审查」mode=declared。',
        '（未填）',
        '行 reczz28NamxLZylu｜结论=PASS｜状态=PASS｜回读=consistent',
        '（未填）',
        '`risk_items` 为空（问题数 0）⇒ 没有可给的条款号，「0 条问题就是 0 条依据，不编」',
        '（已收起 1 条证据：证据 · 4 条）',
      ].join('\n');
      const r = toCardOrText(REAL, { verdict53: V53P, machineAnswer: true });
      const whole = JSON.stringify(r.card ?? r.text ?? '');
      const leaks = ['引擎结论', '回读=', '（未填）', 'risk_items', '详细说明'].filter((k) => whole.includes(k));
      if (r.mode !== 'card' || r.kind !== 'evidence') {
        no('J13a3b 机器答案也要收成评审卡', `mode=${r.mode} kind=${r.kind}`);
      } else if (leaks.length) {
        no('J13a3b 机器答案的读数不许上卡', `漏了：${leaks.join(' / ')}`);
      } else if (whole.includes(line53) === false) {
        no('J13a3b 权威结论行必须在卡上', whole.slice(0, 160));
      } else ok('J13a3b 机器答案：卡上只有权威结论行，内部读数一行都不上卡');

      // J13a3b2 ★ 2026-10-15 真单（`om_x100b62372ba...` 那类：**混排**）——
      //   实测 10-14 那两张 PASS 卡**不是纯噪声**：开头一句「差异：…」、结尾一句
      //   「为什么变：不确定…」都是**模型按口径写的边界声明**，该留；中间夹的是读数，该摘。
      //   所以这一条同时断两个方向：**读数一行不许留 · 有用的句子一句不许丢**。
      {
        const line53 = '【审查结论：PASS】未发现已知底线风险，可转交 @sign-off 责任人（未配置） 进行 sign-off。';
        const MIXED = [line53,
          '差异：同一张图：上次 REVIEW 1 处，本次链侧 PASS/0；本次没给合并块',
          '| 项 | 值 |', '| --- | --- |',
          '| 这一次 | 本次：链侧 PASS ｜ 问题数 0 ｜ 置信度 0.93；判定主体「图片安全审查」mode=declared',
          '为什么变：不确定 —— 两次是两条独立的链运行；我不替它解释，也不拿新结论去覆盖旧记录',
          '（未填）',
          '本单 issue_count=0、risk_items=[] ⇒ 引擎没有产出任何条款号可引（不是不给）',
          '未命中 ≠ 合规；四层审计红 0',
          '判定输入只有本机 OCR 读出的那几行字 —— 构图、场景都不在这些字里；要看画面得由人来看',
        ].join('\n');
        const r = toCardOrText(MIXED, { verdict53: { state: 'PASS', line: line53, from: 'chain', block: null },
                                        machineAnswer: true });
        const whole = JSON.stringify(r.card ?? r.text ?? '');
        //   ⚠️⚠️ 2026-10-16（Owner：「PASS 单只留一句话结论」）—— **卡面**现在只有那一行，
        //     所以「有用的句子还在不在」**不能再拿卡面问**：卡面按定义是空的。
        //     要问的是 **卡面 ＋ 数据** 的并集。
        //     这一条真正守的是「**清洗没把模型的话吞掉**」，不是「它必须印在卡上」——
        //     印不印由 §5.3.1 与 Owner 那条裁定管，**丢没丢由这一条管**。
        //     （两者分开之后，这条判据才既没被削弱、也没跟新口径打架。）
        const keptBlob = whole + JSON.stringify(r.data ?? '');
        const leaked = ['链侧 PASS ｜', '| 项 | 值 |', '| --- |', '（未填）', '问题数 0 ｜ 置信度'].filter((k) => whole.includes(k));
        const kept = ['差异：同一张图', '为什么变：不确定', '未命中 ≠ 合规', '判定输入只有本机 OCR'].filter((k) => keptBlob.includes(k));
        if (leaked.length) {
          no('J13a3b2 混排：读数一行都不许留', `漏了：${leaked.join(' / ')}`);
        } else if (kept.length !== 4) {
          no('J13a3b2 混排：有用的句子一句都不许丢（卡面或数据里必须还在）',
             `丢了：${['差异：同一张图', '为什么变：不确定', '未命中 ≠ 合规', '判定输入只有本机 OCR'].filter((k) => !keptBlob.includes(k)).join(' / ')}`);
        } else ok('J13a3b2 混排：读数摘干净 · 模型按口径写的边界声明一句没丢（卡面已按 §5.3.1 收成一行）');
      }

      // J13a3c ★ 反向对照：**链跑挂时模型那段是真答复** —— 不许被这条判据一起吞掉
      //   ⚠️ 2026-10-16：断言同样从「卡面」改成「**卡面 ＋ 数据**」——
      //     PASS 单的卡面按 Owner 那条裁定已经是空的，再拿卡面问就测不到「吞没吞」了。
      const realAnswer = `${line53}\n\n这条链这次没跑成，我按能读到的部分给你三条建议，第一条是……`;
      const r2 = toCardOrText(realAnswer, { verdict53: V53P, machineAnswer: true });
      if (!(JSON.stringify(r2.card ?? '') + JSON.stringify(r2.data ?? '')).includes('三条建议')) {
        no('J13a3c 反向对照：机器答案里有真答复时不许丢', '答复被吞了（卡面与数据里都没有）');
      } else ok('J13a3c 反向对照：机器答案里**有真内容**时不被吞（判据不是「一律丢」）');

      // ══════════════════════════════════════════════════════════════════════
      // J13a3e ★★ 2026-10-15（**第 7 张 PASS 卡**，Owner 再次报「格式不符」）
      // ══════════════════════════════════════════════════════════════════════
      //   真单：行 `MC-US-AMZ-B0G647K9TN`，台账 `ws_outbound.jsonl` 第 1073 行，
      //   message `om_x100b623de32b9c84cebb3cd965d312f`（17:20 私聊）。
      //
      //   它与 J13a3b 那条**同根、但站在另一条分支上**：
      //     · J13a3b 修的是「**模型没给卡** ⇒ 代码建卡」（`machineAnswer` 生效）；
      //     · 这一单**模型给了卡**（`query-answer`，3 格）⇒ 走「模型的卡照用」那一支
      //       ⇒ `machineAnswer` **根本没被执行** ⇒ 模型把 `res.reply` 里的读数
      //         转述进卡面（`引擎结论` / `状态 PASS ｜ 问题数 0 ｜ 置信度 0.93` /
      //         `（未填）` / `--content-type text` / `四道审计红 0` / `source_sha256` /
      //         `record_id` / `回写=consistent` 共 10 类），结论行还印了两遍。
      //
      //   夹具逐字取自那张真单的卡面（`reasoning` 就是台账正文），**一字未改**。
      //   判据四条，缺一条都不算：
      //     ① 读数一类都不许留（含**段落中间**的、和 `；` 切出来的短残句）；
      //     ② 结论行只能出现**一次**（抬头），正文不许再印一遍；
      //     ③ 模型写的话与模型给的抬头**一句都不许丢**（搬进正文 / 折叠区）；
      //     ④ 结论格不许留「（未填）」—— 权威结论行已在抬头，那一格该装模型那句原话。
      {
        const line53p = '【审查结论：PASS】未发现已知底线风险，可转交 @sign-off 责任人（未配置） 进行 sign-off。';
        const V53P2 = { state: 'PASS', line: line53p, from: 'chain', block: null };
        const CARD_TITLE = 'M5 Smart（Quill Gray）listing：链侧 PASS/0 —— 但本单没收到合并稿';
        const CARD_BODY = [
          '链侧 PASS/0（未发现已知底线风险）；本单未收到双轨合并块',
          `${line53p}状态 PASS ｜ 问题数 0 ｜ 置信度 0.93（\`heuristic_not_calibrated\`，≥0.90 走 PRD §6.6 直出档）。`
            + '`findings=0` ⇒ 没有条款号 / anchor / `source_sha256` / L0 直链可给；P0/P1/P2/P3 计数全 0。'
            + '★ 要紧的一点：这一单我收到的只有链侧那一段，没有「双轨合并后的结论」那一块。',
          '（未填）',
          '审的是落盘的 833 字节素材文本（sha256 `2e4e7a24…`，与旁挂同源），`--content-type text` '
            + '⇒ 文本模态恒记 `complete`，引擎不核「链接抓到没有」 —— 本次审的是随单粘贴的 listing 正文。',
          '（未填）',
          '未命中 ≠ 合规（是「未发现已知底线风险」，不是「已证明合规」）；② 自命中检查真跑过、'
            + '结果为「未命中」（归一化 638 字、扫过 209 条、阈值 ratio≥0.9 且 run≥80）——不是 `status=error`；'
            + '层前置 L4/L5/L6 各 1 项黄＝预演落章（E5）＝机制证据、不等于真落盘（四道审计红 0、'
            + '那行 `ok=None` 是取值空档，JSON 实为 `ok=true / mode=enforced / red_total=0`）；本单不涉 `NEEDS_INPUT`',
          '（未填）',
          '链侧：发布件 `feishu_publish.py --apply` 退出码 1、`published=false`、无云文档、无 `record_id`，'
            + '报错同样是 `code 800030005 / not_found`。守衡侧（落表读数）：行号 reczz28NdOnB5bBO｜'
            + '结论=PASS｜状态=待审｜回读=consistent',
          '（未填）',
          '本单没有合并块，所以我不能替它下「最终结论」。对照：同一段 listing 正文的另一 SKU'
            + '（M5 Smart 2-Pack Cozy Red）本会话跑过两次，两次都是「链侧 PASS/0 ＋ 模型侧若干处 ⇒ 合并稿 REVIEW」',
          '（已收起 1 条证据：证据 · 1 条）',
        ].join('\n');
        const raw7 = '[[card:query-answer]]\n'
          + JSON.stringify({ title: CARD_TITLE, verdict: '链侧 PASS/0（未发现已知底线风险）；本单未收到双轨合并块',
                             reasoning: CARD_BODY }) + '\n[[/card]]';
        const r7 = toCardOrText(raw7, { verdict53: V53P2, machineAnswer: true });
        const whole7 = JSON.stringify(r7.card ?? r7.text ?? '');
        //   ⚠️ 2026-10-16（Owner：「PASS 单只留一句话结论」）：这一单是 **PASS**，
        //     卡面按新裁定只留一行 ⇒「模型写的话还在不在」要问 **卡面 ＋ 数据** 的并集。
        //     这条判据守的是「**清洗没吞掉模型的话**」；印不印在卡上由 §5.3.1 与 Owner 那条裁定管。
        const keptBlob7 = whole7 + JSON.stringify(r7.data ?? '');
        const leaks7 = ['引擎结论', '回读=consistent', '（未填）', 'heuristic_not_calibrated', '问题数 0 ｜',
                        '--content-type', 'source_sha256', 'record_id', '四道审计', '预演落章',
                        'feishu_publish', '发布件'].filter((k) => whole7.includes(k));
        // ② 结论行只能出现一次：`publicTextOf` 是**公开格**（非折叠区）的文本 ——
        //    抬头 + 正文；折叠区里的原文照留不算「卡面又印了一遍」。
        const face7 = publicTextOf(r7.card ?? {});
        const dup7 = (face7.match(/【审查结论：PASS】/g) ?? []).length;
        const kept7 = [CARD_TITLE, '未命中 ≠ 合规', '本单没有合并块'].filter((k) => keptBlob7.includes(k));
        const lost7 = [CARD_TITLE, '未命中 ≠ 合规', '本单没有合并块'].filter((k) => !keptBlob7.includes(k));
        if (r7.mode !== 'card') {
          no('J13a3e 模型给了卡的机器答案也必须收成卡', `mode=${r7.mode}`);
        } else if (leaks7.length) {
          no('J13a3e 模型给的卡里那 10 类读数一行都不许上卡', `漏了：${leaks7.join(' / ')}`);
        } else if (dup7 !== 1) {
          no('J13a3e 结论行只许印一次（真单印了两遍）', `公开格出现 ${dup7} 次`);
        } else if (lost7.length) {
          no('J13a3e 模型写的话与它给的抬头一句都不许丢', `丢了：${lost7.join(' / ')}`);
        } else if (String(r7.data?.verdict ?? '').includes('未填')) {
          no('J13a3e 结论格不许留「（未填）」', JSON.stringify(r7.data?.verdict));
        } else ok('J13a3e 模型给卡的机器答案：读数摘净 · 结论行只一次 · 模型原话一句没丢');

        // J13a3e2 ★ 反向对照：**同一个夹具、不声明机器答案** ⇒ 一个字都不许动。
        //   这一条钉的是「不许把这条判据扩到回复那条路」（Owner 给人写的卡照旧原样发）。
        {
          const r8 = toCardOrText(raw7, { verdict53: V53P2 });
          const whole8 = JSON.stringify(r8.card ?? r8.text ?? '');
          //   ⚠️ 2026-10-16：这一条守的是「**清洗没被扩到回复那条路**」——
          //     而 PASS 单的卡面现在被 Owner 那条裁定收成一行，**卡面问不出来了**
          //     ⇒ 改成问 **卡面 ＋ 数据**：读数仍在（没被 `machineAnswerFold` 摘走）就算过。
          //     ⚠️ 不许把这条改成「什么都不查」：它是 J13a3d2 那条接线的反向对照。
          const whole8All = whole8 + JSON.stringify(r8.data ?? '');
          const stray = ['四道审计', 'feishu_publish', '--content-type', '问题数 0 ｜']
            .filter((k) => !whole8All.includes(k));
          // 回复那条路：① 读数**一行都不许摘**（安全网，Owner 2026-10-13 定的）；
          //   ② 抬头仍是**权威结论行**（`applyVerdictLine` 的既定口径，FIX-010；
          //      「模型自己那句抬头当标题」从来不是口径 —— 这条我第一版写错过一次）；
          //   ③ 但模型给的抬头**一个字都不许丢**（它落进折叠区「原文照留」）。
          const folded8 = whole8All;
          if (stray.length) {
            no('J13a3e2 反向对照：没声明机器答案时读数一行都不许摘', `被摘了：${stray.join(' / ')}`);
          } else if (String(r8.card?.header?.title?.content ?? '') !== line53p) {
            no('J13a3e2 反向对照：回复那条路的抬头仍是权威结论行（FIX-010）',
               JSON.stringify(r8.card?.header?.title?.content));
          } else if (!folded8.includes(CARD_TITLE)) {
            no('J13a3e2 反向对照：模型给的抬头一个字都不许丢', '原抬头不见了');
          } else ok('J13a3e2 反向对照：回复那条路读数一行不摘、抬头仍走权威结论行、原话进折叠区');
        }
      }
    }

    // J13a3d **接线**：批跑器**真的**传了那个声明吗？
  //   ★ 这一条是变异逼出来的：上面 J13a3b 直接调 `toCardOrText(..., machineAnswer:true)` ——
  //     我把批跑器里那个参数删掉重跑，**判据全绿**（它压根没读调用点）。
  //     「判据写对了」不等于「调用方接上了」—— §2.4.1 那个病，长在这里。
  //     判据与 `verify_outbound.py` 的 B 段同形：**必须到达那个参数**，不是「出现过函数名」。
  {
    const BR = fs.readFileSync(path.join(HERE, 'batch_review_runner.mjs'), 'utf8');
    // ⚠️ 正则**不**去匹配整个调用（第一个 `)` 会停在 `String(raw ?? '')` 那一层，
    //    实测就是这么误报的 —— 会停下来的正则等于没判）。判据落在**实参区**：
    //    从 `toCardOrText(` 往后取 200 字，看里面有没有那个具名参数。
    const calls = [...BR.matchAll(/toCardOrText\(/g)].map((m) => BR.slice(m.index, m.index + 200));
    if (!calls.length) {
      no('J13a3d 批跑器必须调 toCardOrText', '一次都没调？');
    } else if (!calls.some((c) => /machineAnswer:\s*true/.test(c))) {
      no('J13a3d 批跑器必须传 machineAnswer: true', `实参区里没有它：${calls[0].slice(0, 120)}`);
    } else ok('J13a3d 批跑器真的传了 machineAnswer: true（不是只写在注释里）');

    // J13a3d2 ★★ 2026-10-15（**变异逼出来的**）：**凡是带了 `verdict53` 的调用点，
    //   必须同时带上 `machineAnswer: true`**。
    //   为什么单列一条：J13a3e 那组判据喂的是**已清洗后的卡**，而清洗要不要发生
    //   取决于调用点有没有声明 —— 我把批跑器里那个参数删掉重跑，**J13a3e 照样全绿**
    //   （它压根不读调用点；判据写了、没量到声明，这才是「恒真的判据」）。
    //   ⚠️ 只认**带 verdict53 的调用**：`ws_daemon.replyTo` 那条路不带它（没有结论行），
    //     把它一起要求上就成了「拦得比该拦的多」。
    const badCall = calls.find((c) => /verdict53\s*[:,]/.test(c) && !/machineAnswer:\s*true/.test(c));
    if (badCall) {
      no('J13a3d2 带 verdict53 的 toCardOrText 调用必须同时声明 machineAnswer: true',
         `这一个没声明：${badCall.slice(0, 140)}`);
    } else ok('J13a3d2 带 verdict53 的调用点都声明了 machineAnswer: true（声明真的到了那一跳）');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // J13a3f ★★ 2026-10-16（**第 8 / 9 张 PASS 卡**，Owner：「按照 prd 一句话结论，现在格式不对」）
  // ══════════════════════════════════════════════════════════════════════════
  //   真单：`PMO/logs/ws_outbound.jsonl` 第 1266 行（`…wellness-1-…`，10:50:06）
  //         与第 1270 行（`…cleaning-and-on-the-go-bundle…`，10:54:45）。
  //
  //   ── 为什么上面那组 J13a3e **改前改后都绿**，而线上照样漏
  //     J13a3e 的夹具是 `{title, verdict, reasoning}` **三格**，而且它把 `（未填）`
  //     **当成模型正文里的一行**写死在 `reasoning` 字符串里。真单不是这样：
  //       · 真卡是 `query-answer` ＋ **`fields[{name, value}]`**（真单 4 格）；
  //       · `（未填）` **不是模型写的** —— 它是 `cards.mjs::fieldRow()` **渲染**出来的：
  //         那一行读 `f.label`，而模型 **85/85 次全给 `f.name`**（批跑会话全量数的）
  //         ⇒ `s(undefined)` ⇒ `NA = （未填）`；
  //       · 读数**全在 `fields[].value` 里**（`链的口径：…` / `链侧三态 = …` /
  //         `未命中 ≠ 合规：…` / `链侧：「飞书那一步：没有做」…`），而
  //         `machineAnswerFold` 的清洗清单只有五个**字符串格** ⇒ 一次都没跑到它。
  //     ⇒ 判据喂的是**写判据的人以为的形状**，事故正好落在它没喂的那一类上（FIX-023）。
  //   ★ 本组夹具**逐字取自那两张真单的模型原卡**（`PMO/shouheng-state/sessions/
  //     dm_ou_batch_runner.json` 里模型那一轮的 `[[card:query-answer]]`）——
  //     `fields` 的**键名（`name`）与内容一字未改**：这个形状就是本次事故的全部。
  {
    //   ⚠️ 这里的 `verdict53` 用 **REVIEW**（不是那张真单的 PASS）—— **有意的**：
    //     2026-10-16 Owner 裁定「PASS 单只留一句话结论」之后，PASS 卡的卡面正文会被
    //     `passOnlyLine()` 整块收掉，那会把本组几条断言（字段名认得出、读数摘净、
    //     模型原话还在）**全部变成空转**（卡面本来就空，怎么都绿）。
    //     ⇒ 本组测的是「**清洗**」，就该让卡面活着；PASS 收口另立 **J13a3g** 那一组。
    const line53q = '【审查结论：REVIEW】共发现 0 处需人工确认。';
    const V53Q = { state: 'REVIEW', line: line53q, from: 'chain', block: null };
    //   ★ 夹具**逐字取自真单**（`PMO/shouheng-state/sessions/dm_ou_batch_runner.json` 里模型
    //     那一轮的 `[[card:query-answer]]`；行 `MC-US-WEB-IMG-cleaning-and-on-the-go-bundle-…`）——
    //     `fields` 的**键名（`name`）与四格内容一字未改**：这个形状就是本次事故的全部。
    const rawQ = '[[card:query-answer]]\n' + JSON.stringify({
      title: 'Cleaning & On-the-Go Bundle 图：REVIEW 2 处；库侧读数两说',
      verdict: 'REVIEW：2 处（DeepClean 命名 · 37° 无单位）；库侧跑没跑成两说',
      reasoning: '【审查结论：REVIEW】共发现 2 处需人工确认（模型侧 2 条）—— 1.【产品描述】素材正文第 1 句（图注）「**DeepClean Baby Bottle Washer(D8)**」—— **无库内条款 · 依据为外部标准**：「DeepClean」出现在商品名/图注首位，美国消费者通常会把这类命名理解成**功效暗示**（深层消毒、除菌、比普通清洗更彻底），而**本素材可见范围内没有任何检测数据、适用场景或「仅清洗、非消毒」的限定说明**，属**需要举证支撑的暗示性宣称**（本条只针对该命名与图注，**未覆盖页面正文（未读数）**）。依据：Amazon Ads《Claims and substantiation》· Prohibited content（全渠道禁止清单）→ https://advertising.amazon.com/help/G6UU66YLSCUYDULQ。建议：把 DeepClean 明确限定为**型号而非功效**（如「DeepClean (Model D8) Baby Bottle Washer — **cleaning only, not a sterilizer/sanitizer**」，或改中性名「Baby Bottle Washer D8」）；若确要表达除菌/消毒效果，需附**可核查的第三方测试结论**（机构、标准、菌种、去除率）后再写。2.【本地化】图 1 画面 · 可见标识「**37°**」（画面读数记录在**带数字显示的浅绿色保温杯/机身显示位**）—— **无库内依据 · 建议转人工**：画面里的温度读数「37°」**没有标单位**，美国站消费者日常以**华氏度**读温度，仅看「37」**既可能是 37°C（体温级）、也可能被读成 37°F**，**无法判断这是加热目标温度还是降温目标温度**；画面结论**依据的是本单视觉模型读数**（它同时自报机器内部结构、按键面板文字、产品是否实际使用看不清），故**只针对「37°」这一可见读数成立**。建议：补单位与含义（如「**37°C (98.6°F)**」）并在图注/产品图加一行说明「Display shows target warming temperature 37°C / 98.6°F」；若该读数属 Bottle Cooler（降温），则改为「4°C (39°F)」等并标注单位。建议转 @产品负责人（未配置） @法务（未配置） @北美同事（未配置） 复核。（两条均为**无库内依据的改法建议**，不是库规原文）',
      boundary: '库侧跑没跑成，本单给了两份互不相容的读数（见字段）',
      fields: [
        { name: '★★ 一处互相打架的读数（我摆出来、不替你选）',
          value: '本单材料对「**知识库侧这次跑没跑成**」给了**两种互不相容的说法**：\n**A**：链侧给了**完整的引擎读数** —— 状态 `REVIEW ｜ 0 ｜ 置信度 None`、**覆盖缺口**（`coverage_not_covered`、`fails_closed`）、L4–L7 各一 RUN（`20261016-1053-L4/-L5/-L6/-L7`）、四道审计红 0、发布失败 `log_id 20261016105340DC75F8F6E998372E0AD5`。\n**B**：另一处读数称 **本次知识库侧没有拿到引擎读数**（没跑到引擎 / 机读旁挂没落）。\n★ **两者不能同时成立** —— 我按 **A（链侧原文）**转述结论，但**这一处请你核**。★ **若 B 成立**，则「覆盖缺口」那段**不成立**，本单**只剩模型侧 2 条、无库内依据**，**应记为「未测」，而不是「REVIEW（覆盖缺口）」** —— 那它就不能当结论用，也不得据此当通过依据' },
        { name: '链侧（A）读数要点',
          value: '最高 BM25 **14.4819**（**素材自己的单元**、自己匹配自己），门限 16.0、合格单元 **0 条** ⇒ **不放行（不产出 PASS）**；**条款号 `?`**；② 自命中检查＝「**未命中**」（归一化 **40** 字、扫过 209 条）—— **不是 `status=error`**；本单唯一带指纹的读数：anchor `#素材/recvw2vgYX65Xf/图片素材/#img.3`、`source_sha256=333b23b370d54e9c…f489579a`；层前置 `ok=true / mode=enforced / red_total=0`（**L4/L5/L6 各 yellow=1 = 预演落章 E5、机制证据、不等于真落盘**；模板那行 `ok=None` 以 `evidence_meta.layer_preflight` 为准）；模态佐证是**申报档**（`image`+`ocr`、`macos-vision`、`declared_by=caller`）；链的推荐：**不补素材、直接把覆盖缺口转给法务/医学顾问定性**' },
        { name: '★ 画面这一层（依据是视觉模型读数，不是原图）',
          value: '**画面结论只能依据那份读数**：场景 = **影棚**；**人物：（读数里没有）**；物品 = 白色方形机器（**正面透明门**、左侧黑色竖排按键面板）、浅绿色渐变保温杯（带盖、**杯身有数字显示**）、绿色圆柱形水杯（带提环）；可见标识 = **`momcozy`；`37°`；`88:88`**；线索 = （读数里没有）。★ **读数自报看不清的**：机器内部结构、按键面板具体文字、**产品是否实际使用**；★ 链的口径：**我只拿到图内 OCR 与视觉模型读数，未做逐区域判定**；**凡读数没覆盖的（月龄、声音、图外情节）均未推断**' },
        { name: '飞书两格（照抄，别混）',
          value: '**链侧**：**删除** —— 原文是「**飞书那一步没有做**」：`published=false`（模板写「原因 未说明」）；同一处另给：`feishu_publish.py --apply` 退出码 1、错误码 `800030005 not_found`（**`log_id 20261016105340DC75F8F6E998372E0AD5`**）⇒ **结论有效，但没发出去**；链**没有**自行补写（避免重复行/越权写飞书）。**守衡侧**（落表读数）：**已新建这一单在表里的那一行**｜行号 reczz28NvMIHzpr5｜结论=REVIEW｜状态=待审｜回读=consistent' },
      ],
      evidence: ['★ 判定对象：[图片] 图注 `Cleaning and On-the-Go Bundle: DeepClean Baby Bottle Washer(D8)`'],
    }) + '\n[[/card]]';
    const rq = toCardOrText(rawQ, { verdict53: V53Q, machineAnswer: true });
    //   ⚠️ 判据落在**公开卡面**（`publicTextOf`：抬头 ＋ 可见格），**不是整张卡** ——
    //     摘下来的原文按纪律进**折叠区**（「搬是搬，砍是砍」），拿整张卡去比，
    //     会把「原文照留」也一起判成漏。
    const faceq = publicTextOf(rq.card ?? {});
    const nafq = (faceq.match(/（未填）/g) ?? []).length;
    const leaksq = ['链的口径', '链侧三态', '未命中 ≠ 合规', '飞书那一步', '回读=consistent',
                    '四道审计', 'not_found', 'source_sha256'].filter((k) => faceq.includes(k));
    if (rq.mode !== 'card') {
      //   ⚠️ 降级时把**卡面文本**一起打出来：`mode=text` 有三个完全不同的成因
      //     （块抽不出 / 校验不过 / 被上游判成纯文本），只报 `mode` 会让人再查一遍。
      no('J13a3f 带 fields 的机器答案卡也要收成卡',
         `mode=${rq.mode}；text=${JSON.stringify(String(rq.text ?? '').slice(0, 220))}`);
    } else if (nafq) {
      no('J13a3f 卡面不许出现「（未填）」（真单 4 处；它由 fieldRow 渲染，不是模型写的）',
         `出现 ${nafq} 次；公开卡面=${JSON.stringify(faceq.slice(0, 200))}`);
    } else if (leaksq.length) {
      no('J13a3f fields[].value 里的内部读数一行都不许上卡面', `漏了：${leaksq.join(' / ')}`);
    } else if (!faceq.includes('Cleaning & On-the-Go')) {
      no('J13a3f 模型写的抬头一个字都不许丢', '抬头不见了');
    } else ok('J13a3f 真单形状（query-answer ＋ fields[{name,value}]）：卡面无「（未填）」· 读数摘净 · 模型原话没丢');

    // ── J13a3f2 ★ 反向对照：**不许「一律丢字段」**，也**不许只认一种键**
    //   两个反面同时钉住：① 为了摘读数把整组 `fields` 砍掉（与 J13a3c 同一条纪律）；
    //   ② 认名收口时把登记表那一种写法（`{label, value}`）弄丢。
    {
      const rawN = '[[card:query-answer]]\n' + JSON.stringify({
        title: '换奶嘴周期', verdict: '建议 2–3 个月换一次',
        fields: [
          { label: '置信度', value: '查到' },
          { name: '窗口', value: '最近 50 条' },
          { name: '建议', value: '先把 DeepClean 限定为型号，再谈功效' },
        ],
      }) + '\n[[/card]]';
      const rn = toCardOrText(rawN, { verdict53: null, machineAnswer: true });
      const facen = publicTextOf(rn.card ?? {});
      const lostN = ['置信度', '查到', '窗口', '最近 50 条', 'DeepClean'].filter((k) => !facen.includes(k));
      const nafn = (facen.match(/（未填）/g) ?? []).length;
      if (nafn) no('J13a3f2 反向对照：有标签的字段不许印「（未填）」', `出现 ${nafn} 次`);
      else if (lostN.length) no('J13a3f2 反向对照：正常字段（两种写法）不许被丢', `丢了：${lostN.join(' / ')}`);
      else ok('J13a3f2 反向对照：`{label,value}` 与模型真用的 `{name,value}` 都认 · 正常字段照旧上卡 · 都不印「（未填）」');
    }

    // ── J13a3f3 ★★ **源码级接线**：`fieldRow` 不许再自己认键
    //   为什么单列一条：上面那两条是**行为级**的，谁把 `fieldRow` 改回 `s(f.label)`
    //   它们照样能过（只要模型改用 `label`）—— 而模型**不会**改（85/85）。
    //   这一条读**函数体本身**：认名必须走 `fieldPair`（唯一真源）。
    {
      const src = fs.readFileSync(path.join(CARDS_DIR, 'cards.mjs'), 'utf8');
      const i = src.indexOf('export function fieldRow');
      const j = src.indexOf('\nexport ', i + 10);
      const fn = i < 0 ? '' : src.slice(i, j > i ? j : i + 1400);
      //   ⚠️ 源码级判据的头号假阳性：**判据打到自己写的注释**。
      //     实测（这一条第一次跑就中了）：`fieldRow` 上方那段病历注释里**逐字写着**
      //     旧写法 `s(f.label)` —— 正则一头撞上去 ⇒ 在完全正确的代码上判红。
      //     ⇒ 先把注释剥掉，只判**活代码**（`check_source_readonly.py` 的既有纪律同源）。
      const code = fn.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '');
      if (!fn) {
        no('J13a3f3 fieldRow 必须还在（判据自己别空过）', '找不到 `export function fieldRow`');
      } else if (/s\(\s*f\.label\s*\)/.test(code)) {
        no('J13a3f3 fieldRow 不许直接读 f.label', '认名必须走 fieldPair —— 模型 85/85 给的是 name');
      } else if (!/fieldPair\(/.test(code)) {
        no('J13a3f3 fieldRow 必须用 fieldPair 认名', '没接上唯一真源（键表在 cards.mjs 的 LABEL_KEYS）');
      } else ok('J13a3f3 fieldRow 走 fieldPair 认名（不再自己读 f.label）');
    }

    // ── J13a3f4 ★★ **源码级接线**：`machineAnswerFold` 必须覆盖 `fields[]`
    //   同理：行为级那两条只在夹具那条路上有效，这一条钉「清洗清单里有没有 fields」。
    {
      const src = fs.readFileSync(path.join(CARDS_DIR, 'envelope.mjs'), 'utf8');
      const i = src.indexOf('function machineAnswerFold(');
      const j = src.indexOf('\nfunction ', i + 10);
      const fn = i < 0 ? '' : src.slice(i, j > i ? j : i + 4000);
      const code = fn.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '');   // 同 J13a3f3：只判活代码
      if (!fn) {
        no('J13a3f4 machineAnswerFold 必须还在（判据自己别空过）', '找不到 `function machineAnswerFold(`');
      } else if (!/d\.fields/.test(code)) {
        no('J13a3f4 machineAnswerFold 必须把 fields[] 也洗一遍',
           '清洗清单只有字符串格 —— 真单的读数全在 fields[].value 里');
      } else ok('J13a3f4 machineAnswerFold 覆盖了 fields[]（不只是那五个字符串格）');
    }

    // ── J13a3f5 ★ 反向对照：**链跑挂时模型写的真答复**放进 `fields[].value` ⇒ 一个字都不许摘
    //   （与 J13a3c 同源：判据不是「fields 一律丢」，也不是「凡反引号就摘光」）
    {
      const rawA = '[[card:query-answer]]\n' + JSON.stringify({
        title: '这条链这次没跑成', verdict: '链挂了，我按能读到的部分给你三条建议',
        fields: [{ name: '我的建议', value: '先把 DeepClean 限定为型号再谈功效；温度那格补上单位；两条都建议转法务复核。' }],
      }) + '\n[[/card]]';
      const ra = toCardOrText(rawA, { verdict53: null, machineAnswer: true });
      const facea = publicTextOf(ra.card ?? {});
      const lostA = ['先把 DeepClean 限定为型号', '补上单位', '转法务复核'].filter((k) => !facea.includes(k));
      if (lostA.length) no('J13a3f5 反向对照：fields 里的真答复不许被吞', `丢了：${lostA.join(' / ')}`);
      else ok('J13a3f5 反向对照：fields 里有真内容时照旧上卡（判据不是「fields 一律丢」）');
    }

    // ── J13a3f6 ★★ 2026-10-16（写上面那条夹具时**撞出来的**）
    //   病灶：`toCardOrText` 里 `stripInternalNotes(reply, {machine})` 跑在
    //   `extractCardBlock` **之前**（那是有意的，见它上方注释），而
    //   `machineReadingSentences` 的护栏一只认「**本行**以 `[[card:` 开头」——
    //   块标记与 JSON **不在同一行**（`[[card:kind]]\n{…}` 是标准形状）
    //   ⇒ JSON 那一行没有任何护栏，只剩「段长 > 800 就不动」那条**侥幸**挡着。
    //   实测：一份 **769 字**的卡 JSON 被 `split('；')` 摘掉「读数句」⇒ JSON 当场破掉
    //   ⇒ `extractCardBlock` 报「对象括号没配平」⇒ **整张卡降级成纯文本**发出去。
    //   ⚠️ 线上至今 **0 次**（`ws_outbound.jsonl` 里「没能把回答组织成卡片」= 0）——
    //     真卡的 JSON 都超过 800 字、被那条侥幸挡住了。**这是潜伏缺陷，不是已发事故。**
    //   修法＝护栏三：**整段是合法 JSON 对象就不许改写**（散文不可能同时又解析成 JSON）。
    {
      const rawS = '[[card:query-answer]]\n' + JSON.stringify({
        title: '这条很短', verdict: '短卡也是卡',
        fields: [{ name: '窗口', value: '最近 50 条' }],
        evidence: ['状态 PASS ｜ 问题数 0 ｜ 置信度 0.93；回读=consistent；四道审计红 0'],
      }) + '\n[[/card]]';
      const rs = toCardOrText(rawS, { machineAnswer: true });
      if (rs.mode !== 'card') {
        no('J13a3f6 短卡（JSON < 800 字）不许降级成纯文本',
           `mode=${rs.mode}；text=${JSON.stringify(String(rs.text ?? '').slice(0, 160))}`);
      } else ok('J13a3f6 短卡（JSON < 800 字）照旧建得出卡 —— 护栏三：整段是合法 JSON 就不许改写');
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // J13a3g ★★ 2026-10-16（Owner 裁定）：**「PASS 单只需要一句话结论」**
  // ══════════════════════════════════════════════════════════════════════════
  //   Owner 原话（看到修好的那张 PASS 卡之后）：
  //     「**只需要一句话结论，去掉『DeepClean Lite 教程』和证据**」。
  //   真单：`PMO/logs/ws_outbound.jsonl` **04:03:20**（行 `MC-US-YT-v_WYO8laaPI-IMG`；
  //   模型那一轮的卡在 `PMO/shouheng-state/sessions/dm_ou_batch_runner.json`，`fields` **3 格**）。
  //   同一张卡实测对照：修复前 **1175 字 /（未填）×3 / 漏读数 5 类** ⇒ 收口后 **56 字**。
  //   ⚠️ 本组**不能**并进 J13a3f：那一组的卡面会被这里收空 ⇒ 它的断言全部空转
  //     （所以那一组的 `verdict53` 已改回 REVIEW，见它上方那段说明）。
  {
    const lineP = '【审查结论：PASS】未发现已知底线风险，可转交 @sign-off 责任人（未配置） 进行 sign-off。';
    //   夹具照真单那个形状搭：`query-answer` ＋ `fields[{name,value}]` ＋ `evidence[]`，
    //   且**故意**让正文里有读数（否则「收口」与「清洗」两件事分不开）。
    const rawP = '[[card:query-answer]]\n' + JSON.stringify({
      title: '「DeepClean Lite 教程」视频封面：链侧 PASS/0；本轮无合并稿',
      verdict: 'PASS：链侧 0 处内容问题；本轮无合并稿',
      reasoning: '链侧摘要原文：「未发现已知底线风险，可转交 @sign-off 责任人（未配置）进行 sign-off」。',
      fields: [{ name: '链侧读数（照抄要点）',
                 value: '自命中检查＝未命中（归一化 68 字符、扫过 181 条）；四道审计红 0；'
                      + '`layer_preflight` 实为 `ok=true / mode=enforced / red_total=0`' }],
      evidence: ['★ 判定对象：[视频] 「DeepClean Lite 教程」封面', '★ 本单链已跑完'],
    }) + '\n[[/card]]';
    const rp = toCardOrText(rawP, { verdict53: { state: 'PASS', line: lineP, from: 'chain', block: null }, machineAnswer: true });
    const faceP = publicTextOf(rp.card ?? {});
    const movedP = (rp.moved ?? []).filter((m) => m.field === 'cardBody');
    if (rp.mode !== 'card') {
      no('J13a3g PASS 单也要建得出卡', `mode=${rp.mode}`);
    } else if (faceP.trim() !== lineP) {
      no('J13a3g PASS 卡面**只许那一行**（Owner 2026-10-16）', JSON.stringify(faceP));
    } else if (!movedP.length) {
      no('J13a3g 收掉正文这一跳必须留痕', '`moved` 里没有 `cardBody` 记录 —— 「砍了什么」在日志里看不见');
    } else if (String(rp.card?.body?.elements?.length) !== '0') {
      no('J13a3g PASS 卡的 body 必须是空数组', JSON.stringify(rp.card?.body));
    } else ok(`J13a3g PASS 单卡面只有那一行（收掉 ${movedP[0].chars} 字，留痕到「${movedP[0].to}」）`);

    // ── J13a3g2 ★ 反向对照：**REVIEW 一个字不许少**（逐条块是 PRD §5.3.2+ 的格式件）
    //   少了这一半，「只留一句话」就可能被写成「凡评审单一律收空」——
    //   那会把 REVIEW 的逐条块一起吞掉，是比格式难看严重得多的事。
    {
      const rv = toCardOrText(rawP, { verdict53: { state: 'REVIEW', line: '【审查结论：REVIEW】共发现 2 处需人工确认。', from: 'chain', block: null }, machineAnswer: true });
      const faceV = publicTextOf(rv.card ?? {});
      if (faceV.trim() === '【审查结论：REVIEW】共发现 2 处需人工确认。') {
        no('J13a3g2 反向对照：REVIEW 卡不许被一起收空', '正文整块没了');
      } else if (!faceV.includes('DeepClean Lite')) {
        no('J13a3g2 反向对照：REVIEW 卡的模型原话不许丢', JSON.stringify(faceV.slice(0, 140)));
      } else ok('J13a3g2 反向对照：REVIEW 卡照旧有正文（收口只对 PASS 生效）');
    }

    // ── J13a3g3 ★ 反向对照：**没有权威结论行**（闲聊 ／ 链没跑成）⇒ 一个字不动
    //   这一条守的是「回复那条路」：模型给人写的卡不该被这条收口碰到。
    {
      const rn2 = toCardOrText(rawP, { verdict53: null, machineAnswer: true });
      const faceN = publicTextOf(rn2.card ?? {});
      if (!faceN.includes('DeepClean Lite')) {
        no('J13a3g3 反向对照：没有结论行时不许收正文（那是模型给人写的卡）',
           JSON.stringify(faceN.slice(0, 140)));
      } else ok('J13a3g3 反向对照：没有权威结论行 ⇒ 正文照旧（收口只认 `verdict53.state`）');
    }

    // ── J13a3g4 ★ 纯函数四态：`passOnlyLine()` 的边界各喂一次
    //   ⚠️ 第 ④ 态是「**本来就没有正文 ⇒ 不许记一笔**」：少了它，日志会把
    //     「什么都没砍」说成「砍了 N 块」（本项目「读数不许虚报」那条）。
    {
      const { passOnlyLine } = await import(path.join(CARDS_DIR, 'envelope.mjs'));
      const c = { header: { title: { tag: 'plain_text', content: lineP } },
                  body: { elements: [{ tag: 'markdown', content: '正文' }] } };
      const a1 = passOnlyLine(c, { state: 'PASS', line: lineP });
      const a2 = passOnlyLine(c, { state: 'REVIEW', line: '【审查结论：REVIEW】共发现 1 处需人工确认。' });
      const a3 = passOnlyLine(c, null);
      const a4 = passOnlyLine({ body: { elements: [] } }, { state: 'PASS', line: lineP });
      const bad = [];
      if (a1.stripped !== 1 || a1.card.body.elements.length !== 0) bad.push('① PASS 且有正文 ⇒ 必须收空');
      if (a2.stripped !== 0 || a2.card.body.elements.length !== 1) bad.push('② 非 PASS ⇒ 一个字不动');
      if (a3.stripped !== 0) bad.push('③ 没有结论行 ⇒ 不动');
      if (a4.stripped !== 0) bad.push('④ 本来就没有正文 ⇒ 不许记「砍了 N 块」');
      if (bad.length) no('J13a3g4 passOnlyLine 四态', bad.join('；'));
      else ok('J13a3g4 passOnlyLine 四态：PASS 且有条目 ⇒ 收；非 PASS ／ 无结论行 ／ 本来空 ⇒ 不动、不记账');
    }
  }

  // J13a4 **接线**：原文没有丢 —— 它是这一轮的回复正文（`ws_daemon` 记字数、memory 存这一轮）
    const W = fs.readFileSync(path.join(HERE, 'ws_daemon.mjs'), 'utf8');
    if (!/💬 回复 \$\{result\.reply\.length\} 字/.test(W)) {
      no('J13a4 模型原文必须仍以「这一轮的回复」被记下来', '找不到那一行字数日志');
    } else ok('J13a4 模型原文仍以「这一轮的回复」被记下来（不是静默丢掉）');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // J14 **卡脚那条边界整个不上卡**（2026-10-13，Owner：「整个都隐藏，不要展示在卡片上」）
  // ══════════════════════════════════════════════════════════════════════════
  //   历史：这一格来回改过三次 ——
  //     ① 模型写在卡脚（平铺）→ Owner 问「可以隐藏吗」；
  //     ② 我把它收进折叠面板「边界与口径」→ Owner：「**整个都隐藏，不要展示在卡片上**」；
  //     ③ 现在：**整格作废**（不再是任何卡片的字段，`BOUNDARY_MAX` 一并作废）。
  //   ⚠️ 它**不是被删掉**：P0 快路那句边界改走 `dual_track.internalNotes`
  //      （→ `chainBlock` → **会话记忆**）⇒ 守衡答得出来，只是不上卡。
  //      「未跑专项审查 / 仍需转对应专项复核」必须还在 —— 少一句，
  //      读卡的人会把一次**确定性匹配**当成「整条链审过了」。
  {
    const V53B = { state: 'BLOCK', line: '【审查结论：BLOCK】共发现 2 处必须修改。',
                   from: 'dual-track-merged',
                   block: '【审查结论：BLOCK】共发现 2 处必须修改。\n1.【合规】全文\n   原因：x\n请修改后重新提交。' };
    const BND = '本结论为 **P0 红线拦截**（确定性匹配，**未跑**专项审查、层前置与评审链），'
              + '**不是 PASS 依据**；若素材属图片 / 视频 / 产品宣称等模态，**仍需转对应专项复核**。';
    // J14a 模型自拟的卡里写了 boundary ⇒ 也不许上卡
    {
      const raw = '[[card:evidence]]\n' + JSON.stringify({
        verdict: 'v', groups: [{ title: '审查结论', content: 'x' }], boundary: BND }) + '\n[[/card]]';
      const r = toCardOrText(raw, { verdict53: V53B });
      const whole = JSON.stringify(r.card ?? {});
      if (/P0 红线拦截/.test(whole) || /仍需转对应专项复核/.test(whole)) {
        no('J14a 模型写的 boundary 也不许上卡', whole.slice(0, 160));
      } else ok('J14a 模型写的 boundary 不上卡（Owner：整个都隐藏）');
    }
    // J14b ★★ **搬不是砍**：P0 那句边界必须仍在**记忆侧**
    {
      const T = await import(path.join(HERE, 'agent', 'dual_track.mjs'));
      const kb = T.kbSideOf({ p0_fastpath: { rule_codes: ['H05'], elapsed_ms: 258, matched_patterns: 1 }, issue_count: 1 });
      const mo = { ok: true, findings: [{ location: 'x', category: '合规', severity: 'BLOCK', source: 'model', reason: 'r' }] };
      const r0 = T.renderMerged(T.mergeFindings([], mo.findings).items,
        { state: 'BLOCK', kb, kbTextCount: 1, model: mo });
      if (/P0 红线拦截/.test(String(r0.block))) no('J14b 卡面 block 里不许再有它', String(r0.block).slice(0, 100));
      else if (!/P0 红线拦截/.test(String(r0.internalNotes))) {
        no('J14b P0 边界必须搬进 internalNotes（搬不是砍）', JSON.stringify(String(r0.internalNotes).slice(0, 120)));
      } else ok('J14b P0 边界从卡面搬进了查证笔记（记忆侧留得住）');
      // 反向对照：**不是 P0 快路**的单子，笔记里不许凭空多出这句
      const kbR = T.kbSideOf({ review: { state: 'REVIEW', issue_count: 1 } });
      const r1 = T.renderMerged(T.mergeFindings([], mo.findings).items,
        { state: 'REVIEW', kb: kbR, kbTextCount: 1, model: mo });
      if (/P0 红线拦截/.test(String(r1.internalNotes))) {
        no('J14b2 反向对照：非 P0 单不许凭空多出 P0 边界', '冒出来了');
      } else ok('J14b2 反向对照：非 P0 单没有这句（不编）');
    }
    // J14c **接线**：整条链上不该再有 `boundary` 这一格的搬运
    {
      const E = fs.readFileSync(path.join(CARDS_DIR, 'envelope.mjs'), 'utf8');
      const Wd = fs.readFileSync(path.join(HERE, 'ws_daemon.mjs'), 'utf8');
      const A = fs.readFileSync(path.join(HERE, 'agent', 'agent.mjs'), 'utf8');
      const Rg = fs.readFileSync(path.join(CARDS_DIR, 'registry.mjs'), 'utf8');
      const bad = [];
      // ⚠️ 扫描**排除注释行** —— 第一版就被自己的解释文字绊倒（`// 见 applyBoundary 的口径`）。
      //    这是 §2.4.4 记过的坑：**统一一条读法，注释不算代码**。
      const code = (x) => x.split('\n').filter((l) => {
        const t = l.trim();
        return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
      }).join('\n');
      if (/applyBoundary/.test(code(E))) bad.push('envelope 还有 applyBoundary');
      if (/boundary:\s*result\.meta/.test(Wd) || /boundary = null/.test(Wd)) bad.push('daemon 还在传 boundary');
      if (/meta\.boundary|p0Boundary:/.test(A)) bad.push('agent 还把 boundary 交出去');
      if (/boundary:/.test(Rg)) bad.push('登记表里还有 boundary 字段（提示词会继续问它）');
      if (bad.length) no('J14c 接线：整条链上不该再有 boundary', bad.join(' · '));
      else ok('J14c 接线：envelope / daemon / agent / 登记表 四处都不再有 boundary');
    }
  }

/* ── J16 `boundary` 那一格**整格作废**（2026-10-13，Owner：「整个都隐藏，不要展示在卡片上」）──
 *  这一组是 J14 的**另一半**：J14 管「P0 那句边界必须还有落点（记忆侧）」，
 *  J16 管「卡面上一个渲染点都不许留」。
 *
 *  ⚠️ 写这组时才知道的事：**这件事原先没有任何东西在看着** ——
 *    把渲染从 `hr + markdown` 改成 `collapsible` 时，311 项判据**一条都没红**。
 *    所以这几条是**新长出来的眼睛**。
 */
head('J16 boundary 整格作废 · 卡面上一个渲染点都不许留');
{
  const cards = await import(path.join(CARDS_DIR, 'cards.mjs'));
  const BND = '未命中≠合规；顶层 state=REVIEW，依据侧 refusal=NEEDS_INPUT/coverage_not_covered。';
  // J16a 五种卡片的构建器**都不许**把 boundary 渲染出来
  {
    const kinds = ['query-answer', 'correction', 'capability-boundary', 'find-nothing', 'evidence'];
    const leaked = [];
    for (const k of kinds) {
      const built = cards.build(k, { verdict: 'v', title: 't', wrong: 'w', right: 'r',
        content: 'c', groups: [{ title: 'g', content: 'x' }], boundary: BND });
      if (JSON.stringify(built).includes('coverage_not_covered')) leaked.push(k);
    }
    if (leaked.length) no('J16a 五种卡片都不许把 boundary 渲染上卡', `漏了：${leaked.join(' / ')}`);
    else ok('J16a 五种卡片都不许把 boundary 渲染上卡（整格作废）');
  }
  // J16b 源码级：cards.mjs 里不许再出现渲染 boundary 的那一行（否则下一个人加回来没人拦）
  {
    const src = fs.readFileSync(path.join(CARDS_DIR, 'cards.mjs'), 'utf8');
    if (/d\.boundary|boundaryEl/.test(src)) {
      no('J16b cards.mjs 里不许再出现渲染 boundary 的代码', '还有残留');
    } else ok('J16b cards.mjs 里没有渲染 boundary 的代码（也没有 boundaryEl）');
  }
  // J16c 反向对照：**没有** boundary 的单子当然也不许凭空冒出面板
  {
    const built = cards.build('evidence', { verdict: 'v', groups: [{ title: 'g', content: 'x' }] });
    if (/边界/.test(JSON.stringify(built))) no('J16c 反向对照：没有边界不许凭空造一格', '冒出来了');
    else ok('J16c 反向对照：没有边界就不印（不造空壳）');
  }
}


/* ─────── J17 ★★ 卡面**永不许出现 `[object Object]`**（2026-10-14）───────
 *  真单（不是构造出来的）：私聊「你可以回答什么问题」⇄ 守衡回了一张
 *  `capability-boundary`，**能做 7 条 / 受限 6 条 / 做不到 6 条，十九条全是
 *  `[object Object]`** —— 整张卡等于没答。原文逐字留在
 *  `PMO/logs/ws_outbound.jsonl:721`，本条判据的第一组数据就是照那条复原的。
 *
 *  病根不在模型：**渲染端对对象零防御**。旧写法 `` `- ${x}` `` 对任何对象一律
 *  `String(x)`，于是「一条能力写成 `{能力, 边界}`」这种完全合理的输出就烂在卡上。
 *  同一个病根还长在 `s(d.verdict)` / `s(d.evidence)` / `fieldRow` 的 `f.value` 上。
 *
 *  ★ 为什么值得单开一组：一条回复里出现 `[object Object]`，读的人**当场就知道
 *    这东西不能信**（比写错一句话严重）。而在此之前，**没有任何东西在看着它** ——
 *    修复前 304 项判据一条都不红，因为旧判据只喂**字符串**样例。
 *    「我只喂过合法的形状」不等于「它只收合法的形状」。
 *
 *  ★ 口径（两处，改一处必须改两处）：`cards.mjs::flat1()` 与
 *    `envelope.mjs::carryCardText()` —— 键名不许丢（键名是模型在表达区分），
 *    认不出形状才按键值平铺，**不猜含义**。
 */
head('J17 卡面永不许出现 [object Object]（对象值必须塌成人话）');
{
  // 第一组数据 = 那条真单的形状：每条「能力」是一个对象，键名表达「能力 / 边界」
  const OBJ_CAN = [
    { 能力: '读当前群历史', 边界: '最近 50 条，不分页' },
    { 能力: '看群成员列表', 边界: '只有显示名与 open_id' },
    { label: '读工作区文本文件', value: '只读，不写' },
    { title: '执行只读命令', content: '白名单内' },
  ];

  // J17a 十九个 `[object Object]` 那条真单：三栏都是对象时，卡上一个都不许剩
  {
    const built = build('capability-boundary', {
      title: '我能做什么', verdict: '按三栏给',
      can: OBJ_CAN, limited: OBJ_CAN, cannot: OBJ_CAN,
    });
    const dump = JSON.stringify(built) + renderText(built);
    if (dump.includes('[object Object]')) no('J17a 能力卡三栏给对象不许印 [object Object]', '真单那个形状又出现了');
    else ok('J17a 能力卡三栏给对象 ⇒ 塌成人话（十九条全中那个形状）');
  }
  // J17a2 **键名与值都要在** —— 只把值抠出来、丢掉键名，等于替模型抹掉了「能力/边界」的区分
  {
    const built = build('capability-boundary', { title: 't', can: OBJ_CAN });
    const txt = renderText(built);
    const lost = ['读当前群历史', '最近 50 条，不分页', '能力', '边界'].filter((w) => !txt.includes(w));
    if (lost.length) no('J17a2 对象摊平后键名与值都不许丢', `丢了：${lost.join(' / ')}`);
    else ok('J17a2 对象摊平后键名与值都在（键名是模型在表达区分，不许替它取舍）');
  }
  // J17a3 ★★ 2026-10-15 **真单漏在外面的一种形状：`{label, note}`**
  //   起因：私聊那张「我能做什么」卡三栏全是「（未填）」（`ws_outbound.jsonl` 16:24:36），
  //   而模型给的十九处全是 `{label, note}` —— `flat1` 的 label 分支当时读的是 **`v.value`**，
  //   于是 `note` 读不到、`label` 被当键名拼进查找对象 ⇒ 每条都摊成空串 ⇒ `s()` 落 `（未填）`。
  //   ★ 判据为什么没抓住它：J17a/J17a2 只喂了 `{能力, 边界}` 与 `{label, value}` 两种形状，
  //     **模型真正用的那一种恰好没喂**（§2.4.1：判据没盖住的那一类，就是事故所在的那一类）。
  {
    const LABEL_NOTE = [
      { label: '列目录 / 找文件', note: 'list_workspace、list_files' },
      { label: '读文件内容', note: 'read_text_file，单次有字节上限' },
    ];
    const built = build('capability-boundary', { title: '我能做什么', can: LABEL_NOTE, cannot: [LABEL_NOTE[0]] });
    const txt = renderText(built) + JSON.stringify(built);
    if (txt.includes('（未填）')) {
      no('J17a3 `{label, note}` 不许印成（未填）', '真单那个形状又出现了');
    } else if (!txt.includes('列目录 / 找文件') || !txt.includes('list_workspace')) {
      no('J17a3 `{label, note}` 的 label 与 note 都要在', '有一个丢了');
    } else ok('J17a3 `{label, note}`（模型真用的那种形状）⇒ label 与 note 都印出来');
    // ★ 反向对照：`{label, value}` 那种既有约定**照旧**要认（不许为了修这一种弄坏另一种）
    const lv = build('capability-boundary', { title: 't', can: [{ label: '能做A', value: '值A' }] });
    const lvtxt = renderText(lv);
    if (!lvtxt.includes('能做A') || !lvtxt.includes('值A')) no('J17a3 反向对照：{label,value} 照旧认', lvtxt.slice(0, 120));
    else ok('J17a3 反向对照：`{label, value}` 那种既有约定照旧认');
  }

  // J17b 同一个病根换张卡：`fields[].value` 给对象照样烂 ⇒ 一起收口
  {
    const built = build('query-answer', {
      title: 't', verdict: 'v', fields: [{ label: '窗口', value: { 起: '09-01', 止: '09-30' } }],
    });
    const dump = JSON.stringify(built) + renderText(built);
    if (dump.includes('[object Object]')) no('J17b fields[].value 给对象不许印 [object Object]', '漏了');
    else ok('J17b fields[].value 给对象 ⇒ 也塌成人话（同一病根的第二张卡）');
  }
  // J17c 源码级接线：`String()` 台面上不许再有裸插对象的位置
  //    （不是全文禁 `${x}` —— `cards.mjs` 的 `${q}[${i}]` 是**路径字符串**，合法）
  //    ⚠️ 必须先**剥掉注释**再扫：本组的修复说明里逐字引用了旧写法
  //    `` `- ${x}` ``，不剥就会红在**文档**上（第一版就是这么红的，红得没道理）。
  {
    const raw = fs.readFileSync(path.join(CARDS_DIR, 'cards.mjs'), 'utf8');
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')      // 块注释
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // 行注释（避开 `https://`）
    const bad = [...code.matchAll(/\$\{\s*(?:d\.\w+|x|f\.(?:label|value)|v)\s*\}/g)].map((m) => m[0]);
    if (bad.length) no('J17c 源码里不许再有裸插对象的模板位', `还有 ${bad.length} 处：${bad.join(' · ')}`);
    else ok('J17c 源码里没有裸插对象的模板位（对象一律过 s()）');
  }
  // J17d 反向对照：**拆掉修复必须精确变红**。
  //   喂的是 `s()` 的**旧实现**（`String(v)`），卡上必须重新长出 `[object Object]`。
  //   红不了 ⇒ 说明 J17a 是恒绿的，等于没守。
  {
    const OLD = (v) => String(v);
    const lines = OBJ_CAN.map((x) => `- ${OLD(x)}`).join('\n');
    if (!lines.includes('[object Object]')) no('J17d 反向对照：旧实现必须被抓', '喂了 String(v) 却没长出 [object Object]');
    else ok('J17d 反向对照：旧实现重新长出 [object Object]（J17a 不是恒绿）');
  }
  // J17e 不回归：**纯字符串**那条路一个字都不许变
  {
    const str = ['A：一条', 'B：两条'];
    const built = build('capability-boundary', { title: 't', can: str, cannot: ['联网'] });
    const txt = renderText(built);
    if (!txt.includes('- A：一条\n- B：两条') || !txt.includes('- 联网')) {
      no('J17e 字符串路径不许被这次修复改坏', txt.slice(0, 200));
    } else ok('J17e 字符串路径照旧（修复只加防御，不改合法输入）');
  }
  // J17f 边界：空值仍走「（未填）」占位 —— 塌平之后是空的，也要看得见缺什么
  {
    const built = build('capability-boundary', { title: 't', can: [{ 能力: '', 边界: '' }] });
    const txt = renderText(built);
    if (txt.includes('[object Object]')) no('J17f 空值对象不许印 [object Object]', '漏了');
    else if (!txt.includes('（未填）')) no('J17f 摊平后为空要走（未填）占位', txt.slice(0, 200));
    else ok('J17f 摊平后为空 ⇒ 仍是（未填）占位（看得见缺什么）');
  }
}

/* ─────── J18 换卡搬迁（`carryCardText`）· 逐字搬家不许丢字、不许印 `undefined`（2026-10-15）───
 *  真单：私聊 16:24 那张「我能做什么」卡三栏全是「（未填）」，**同一份模型输出**
 *  在换卡搬迁那条路上是九个 `undefined` —— `carryCardText` 自带的那份 label 分支
 *  读的是 `x.value`，而模型给的是 `{label, note}`。
 *
 *  ★ 为什么单开一组：`verify_cards` 里此前 **`carryCardText` 只出现在注释里**
 *    （被上一段说明点名，却没有任何一条判据调用过它）——
 *    于是同一个病在卡面修好之后，这条路上一个字没动，而 **317 项全绿**。
 *    「判据没盖住的那一类，就是事故所在的那一类」。
 *
 *  ★ 治法不是「记得也改一份」：两处实现合一（`cards.mjs::flat1` 导出给这边用），
 *    再加一条**源码级接线**判据（J18e）—— 谁再把一份本地 label 分支写回来，当场红。
 *    （行为判据守不住这件事：本地写回一份照样能让 J18a 绿，而「改一处必须改两处」
 *      这个病就回来了。）
 */
head('J18 换卡搬迁 · 逐字搬家不许丢字、不许印 undefined');
const { carryCardText } = await import(path.join(CARDS_DIR, 'envelope.mjs'));
{
  const LABEL_NOTE = [
    { label: '列目录 / 找文件', note: 'list_workspace、list_files' },
    { label: '读文件内容', note: 'read_text_file，单次有字节上限' },
  ];
  // J18a 真单形状：`label` 与 `note` 都要搬过去，一个都不许丢
  {
    const t = carryCardText({ title: '我能做什么', can: LABEL_NOTE });
    const lost = ['列目录 / 找文件', 'list_workspace、list_files'].filter((w) => !t.includes(w));
    if (t.includes('undefined')) no('J18a 搬迁不许印 undefined', t.slice(0, 200));
    else if (lost.length) no('J18a 搬迁后 label 与 note 都要在', `丢了：${lost.join(' / ')}`);
    else ok('J18a `{label, note}` 搬过去 label 与 note 都在（真单那个形状）');
  }
  // J18b 反向对照：`{label, value}` 那种既有约定**照旧**要认
  {
    const t = carryCardText({ can: [{ label: '能做A', value: '值A' }] });
    if (!t.includes('能做A') || !t.includes('值A')) no('J18b 反向对照：{label,value} 照旧认', t.slice(0, 160));
    else ok('J18b 反向对照：`{label, value}` 照旧认');
  }
  // J18c 更早的那种形状（`[object Object]` 那次真单）：键名与值都要在
  {
    const t = carryCardText({ can: [{ 能力: '读当前群历史', 边界: '最近 50 条，不分页' }] });
    const lost = ['读当前群历史', '最近 50 条，不分页', '能力', '边界'].filter((w) => !t.includes(w));
    if (t.includes('[object Object]')) no('J18c 搬迁不许印 [object Object]', t.slice(0, 200));
    else if (lost.length) no('J18c 搬迁后键名与值都不许丢', `丢了：${lost.join(' / ')}`);
    else ok('J18c `{能力, 边界}` 搬过去键名与值都在');
  }
  // J18d 边界：整栏都摊不出内容 ⇒ 不留「能做到：」这种挂着标题、底下一片空
  {
    const t = carryCardText({ title: 't', can: [{ 能力: '', 边界: '' }] });
    if (/能做到：/.test(t)) no('J18d 摊平后为空不许留空标题', t.slice(0, 160));
    else ok('J18d 摊平后为空 ⇒ 整条不留残句（与 kv() 同口径）');
  }
  // J18e 源码级接线：搬迁这条路**不许再自带一份**对象摊平实现 —— 两处实现正是这次的病根，
  //    而它的症状（`undefined`）只在换卡时才出现；行为判据守不住「谁又把本地分支写回来了」。
  //    ⚠️ 与 J17c 同规矩：**先剥注释再扫**，否则会红在本段自己的说明文字上。
  {
    const raw = fs.readFileSync(path.join(CARDS_DIR, 'envelope.mjs'), 'utf8');
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    const body = code.match(/export function carryCardText[\s\S]*?\n\}/);
    if (!body) no('J18e 找得到 carryCardText 函数体', '正则没匹配上 —— 判据要跟着改，别让它恒绿');
    else if (/'label' in x/.test(body[0])) {
      no('J18e 搬迁不许自带 label 分支', '本地又写了一份 ⇒「改一处必须改两处」这个病回来了');
    } else if (!/\bflat1\b/.test(body[0])) {
      no('J18e 搬迁必须用共享的 flat1', '函数体里没有 flat1 —— 口径又分叉了');
    } else ok('J18e 搬迁用的是 `cards.mjs::flat1`（全仓只有一份实现）');
  }
  // J18f 反向对照：把旧写法拼回来必须**精确变红**（红不了 ⇒ J18a 是恒绿的，等于没守）
  {
    const OLD = (x) => (x && typeof x === 'object' && 'label' in x ? `${x.label}：${x.value}` : String(x));
    const bad = LABEL_NOTE.map(OLD).join('\n');
    if (!bad.includes('undefined')) no('J18f 反向对照：旧写法必须被抓', '喂了旧实现却没长出 undefined');
    else ok('J18f 反向对照：旧写法重新长出 `undefined`（J18a 不是恒绿）');
  }
}

/* ─────── J15 报告链接**不许在一张卡上出现两次**（2026-10-13，Owner 那张视频卡）───────
 *  实测那张卡（真实结构复原）：可见格是「我读到了 ＋ → 查看完整问题清单与修改建议：…」，
 *  而下面「审查结论」那一组（**默认展开**）里，链接又是结论行下面第二行 ——
 *  **同一个链接印两遍**，Owner 把这一整段贴回来说「这里多余的回复也去掉」。
 *
 *  口径：**块里已有就不再补**；块里没有（非评审单 / 块没搬进来）才补进可见格。
 *  ⚠️ 这与「为什么当初要有 applyReportLink」不冲突 —— 那一条治的是
 *     「链接落在**块的最末尾**、被 8 条逐条顶到看不见的地方」，本条治的是**重复**。
 */
head('J15 报告链接 · 一张卡上只许出现一次，且位置在「动作行」之上');
{
  const { toCardOrText: T } = await import(path.join(CARDS_DIR, 'envelope.mjs'));
  const URL = 'https://momcozy-in.feishu.cn/docx/J15';
  // ★★ 2026-10-19：**两种措辞**都要有夹具（这就是本轮那个真缺陷的形状）——
  //   卡面自 2026-10-19 起为 PRD §17 字数改用短措辞 `→ 完整清单：`，而信封层的
  //   去重判断当时只认长的那句 ⇒ 块里已有的短措辞认不出 ⇒ 又补一条长的 ⇒ **一张卡两条链接**
  //   （Owner：「卡片上的清单链接有两个，去掉上面的，保留下面的」）。
  //   ⚠️ 判据必须**同时**认两种：长的是库侧（`p0_fastpath.py` / `feishu_publish.py`）仍在用的，
  //     短的是我们自己卡面的 —— 只认一种，另一种就变成「看不见的重复」。
  const LINE_LONG = `→ 查看完整问题清单与修改建议：${URL}`;   // 库侧措辞（历史，仍在用）
  const LINE_SHORT = `→ 完整清单：${URL}`;                     // 卡面措辞（2026-10-19 起）
  const LINE = LINE_LONG;                                      // 下面 J15e/f/g 的既有夹具沿用它
  /** 数「链接行」出现几次 —— **按形状数**，不绑某一句话（措辞再改也不会失效）。 */
  const linksIn = (o) => (JSON.stringify(o ?? {})
    .match(/(?:→|->)\s*(?:完整清单|查看完整问题清单与修改建议)\s*[：:]/g) || []).length;
  const WITH_LINK = { state: 'REVIEW', line: '【审查结论：REVIEW】共发现 3 处需人工确认。',
                      from: 'dual-track-merged',
                      block: `【审查结论：REVIEW】共发现 3 处需人工确认。\n${LINE_LONG}\n1.【合规】x\n请修改后重新提交。` };
  const WITH_LINK_SHORT = { ...WITH_LINK,
    block: `【审查结论：REVIEW】共发现 3 处需人工确认。\n${LINE_SHORT}\n1.【合规】x\n请修改后重新提交。` };
  const NO_LINK = { state: 'REVIEW', line: '【审查结论：REVIEW】共发现 3 处需人工确认。',
                    from: 'dual-track-merged',
                    block: '【审查结论：REVIEW】共发现 3 处需人工确认。\n1.【合规】x\n请修改后重新提交。' };

  // J15a 块里已经有（**短措辞，今天的真形状**）⇒ 全卡只许出现一次
  {
    const r = T('模型原话', { verdict53: WITH_LINK_SHORT, reportLink: URL });
    const n = linksIn(r.card);
    if (n !== 1) no('J15a 块里已有短措辞链接（→ 完整清单：）⇒ 全卡只许出现一次', `实际出现 ${n} 次`);
    else ok('J15a 块里已有「→ 完整清单：」⇒ 全卡只出现一次（不重复）');
  }
  // J15a2 同一把尺喂**长措辞**（库侧那条）—— 两种都要绿，缺一种就是假绿
  {
    const r = T('模型原话', { verdict53: WITH_LINK, reportLink: URL });
    const n = linksIn(r.card);
    if (n !== 1) no('J15a2 块里已有长措辞链接 ⇒ 全卡只许出现一次', `实际出现 ${n} 次`);
    else ok('J15a2 块里已有「→ 查看完整问题清单与修改建议：」⇒ 只出现一次（不重复）');
  }
  // J15b 反向对照：块里**没有**链接 ⇒ 必须补进来，一个都不许丢。
  //   ★ 2026-10-15：落点从「可见格」改成「块内、动作行之上」（见 J15d）。
  //     这条判据**只数出现次数**，不绑落点 —— 绑了就与 J15d 抢同一格。
  {
    const r = T('模型原话', { verdict53: NO_LINK, reportLink: URL });
    const n = linksIn(r.card);
    if (n !== 1) no('J15b 反向对照：块里没有 ⇒ 必须补进来（链接不许丢）', `实际出现 ${n} 次`);
    else ok('J15b 反向对照：块里没有 ⇒ 补进来（链接不会丢）');
  }
  // J15c 反向对照：**没给链接**时一个字符都不许加
  {
    const r = T('模型原话', { verdict53: NO_LINK });
    if (linksIn(r.card) !== 0) {
      no('J15c 反向对照：没给链接不许凭空造一行', '冒出了链接行');
    } else ok('J15c 反向对照：没给链接就不印（不编）');
  }

  /* ★★ J15d–J15g（2026-10-15，Owner 第 4 次同一个反馈 —— 这次是**位置**）────────────
   *
   *   Owner 原话：「守衡中飞书群发放的卡片 review 1-2 个问题的内容：
   *     `→ 查看完整问题清单与修改建议：<docx>` —— **要放在「建议转xxx」上面，
   *     不要放在审查结论下面**」。
   *
   *   病灶（离线复原真单 `om_x100b623f78cedcb0cfc77dcec593725`，与台账 121 字逐字一致）：
   *   1–2 条那一支的 §5.3 块**本来就不含链接行**（链接行按 PRD §5.3.4 的问题数门槛
   *   只在 ≥3 那一支由 `dual_track.renderMerged` 拼进块里）⇒ `applyReportLink` 走
   *   「补进可见格」那一跳 ⇒ 链接落在**抬头正下方**，而动作行在下面那一组的最末尾。
   *   **≥3 的单子位置本来是对的**（链接在块里、动作行之上）—— 两条路要一个形状。
   *
   *   判据是**同一把尺子喂两个输入**：修好的卡要绿，把旧行为**真造一遍**的卡必须红
   *   —— 只断言「绿」等于没守（写法与 `J18f` 同源）。
   */
  // 同一把尺子：把卡摊成行，量「最后一条问题 < 链接 < 动作行」
  const placeOf = (card) => {
    const lines = [];
    const walk = (els) => {
      for (const e of els ?? []) {
        if (e?.tag === 'markdown') lines.push(e.content ?? '');
        else if (e?.tag === 'collapsible_panel') {
          lines.push(e.header?.title?.content ?? '');
          walk(e.elements);
        } else if (e?.tag === 'column_set') {
          for (const c of e.columns ?? []) walk(c.elements);
        }
      }
    };
    walk(card?.body?.elements);
    const L = lines.join('\n').split('\n');
    // ★★ 2026-10-19：**两种措辞都认**（`→ 完整清单：` 短 / `→ 查看完整问题清单与修改建议：` 长）
    const iLink = L.findIndex((l) => /(?:完整清单|查看完整问题清单与修改建议)\s*[：:]/i.test(l));
    const iAct = L.findIndex((l) => /^(建议转|请修改后重新提交)/.test(l));
    const iItem = L.map((l, i) => (/^\s*\d+\.【/.test(l) ? i : -1)).filter((i) => i >= 0).pop() ?? -1;
    return { iItem, iLink, iAct, ok: iLink > iItem && iAct > iLink };
  };
  // 与真单同形：2 条问题 + `建议转 … 复核。` 的动作行（块里**没有**链接 ⇒ 走这一跳）
  const TWO_ITEMS = {
    state: 'REVIEW', line: '【审查结论：REVIEW】共发现 2 处需人工确认。', from: 'dual-track-merged',
    block: '【审查结论：REVIEW】共发现 2 处需人工确认。\n\n1.【产品描述】4-in-1 是笼统宣称\n'
         + '\n2.【消费者安全】TEMP-SENSING 无宾语\n\n建议转 @法务 @医学顾问 复核。',
  };
  const r2 = T('模型原话', { verdict53: TWO_ITEMS, reportLink: URL });
  const p2 = placeOf(r2.card ?? {});
  // J15d ★ 本次诉求：链接必须落在**最后一条问题之后、动作行之上**
  if (!p2.ok) {
    no('J15d 链接必须落在动作行之上（1–2 条那一支）',
       `最后一条=${p2.iItem} 链接=${p2.iLink} 动作行=${p2.iAct}（要求 问题<链接<动作）`);
  } else ok('J15d 链接落在动作行之上（PRD §5.3 次序：正文 → 链接 → 动作行）');
  // J15d2 ★★ 反向对照①：**不许**再落在「审查结论下面」——
  //   公开格（折叠面板之外）里不许有链接行；旧行为下它正是卡里第一个 markdown 段。
  {
    const { publicTextOf: pub } = await import(path.join(CARDS_DIR, 'envelope.mjs'));
    const pubText = pub(r2.card ?? {});
    if (/(?:完整清单|查看完整问题清单与修改建议)\s*[：:]/.test(pubText)) {
      no('J15d2 反向对照：链接不许落在公开格（＝抬头正下方）',
         `公开格 = ${JSON.stringify(pubText.slice(0, 80))}`);
    } else ok('J15d2 反向对照：链接不在公开格（不落在审查结论下面）');
  }
  // J15d3 ★★ 反向对照②：**把旧行为真造一遍**（链接补进 `verdict` 可见格）⇒ 同一把尺子必须红。
  //   少了这一条，「链接在块里」就退化成「反正它在卡里某一处」，位置等于没守。
  {
    const old = build('evidence', { ...(r2.data ?? {}), verdict: LINE });
    const po = placeOf(old);
    if (po.ok) no('J15d3 变异反向对照：旧行为必须被抓', '链接回到可见格，位置尺子却还是绿的 ⇒ 恒绿');
    else ok(`J15d3 变异反向对照：旧行为被抓（链接=${po.iLink} 早于动作行=${po.iAct}，仍在问题上文）`);
  }
  // J15e 分段：正文 ␤ 链接 ␤ 动作行（恰好一个空行，且全篇不出现连续两个空行）
  {
    const L = JSON.stringify(r2.data?.groups ?? '').split('\\n');
    const iLink = L.findIndex((l) => /(?:完整清单|查看完整问题清单与修改建议)\s*[：:]/.test(l));
    const one = iLink > 0 && L[iLink - 1] === '' && L[iLink + 1] === '' && L[iLink + 2] !== '';
    if (!one) no('J15e 链接的上下各恰好一个空行', JSON.stringify(L.slice(Math.max(0, iLink - 1), iLink + 2)));
    else ok('J15e 链接上下各恰好一个空行（正文 ␤ 链接 ␤ 动作行）');
    if (JSON.stringify(r2.card ?? {}).includes('\\n\\n\\n')) no('J15e2 不许出现连续两个空行', '出现了');
    else ok('J15e2 卡里没有连续两个空行');
  }
  // J15f 反向对照③：块里**认不出动作行** ⇒ 退回可见格（链接一个都不许丢，也不许瞎插）
  {
    const NO_ACTION = { ...TWO_ITEMS,
      block: '【审查结论：REVIEW】共发现 2 处需人工确认。\n\n1.【产品描述】x\n\n2.【消费者安全】y' };
    const r = T('模型原话', { verdict53: NO_ACTION, reportLink: URL });
    const n = linksIn(r.card);
    const { publicTextOf: pub } = await import(path.join(CARDS_DIR, 'envelope.mjs'));
    if (n !== 1 || !/(?:完整清单|查看完整问题清单与修改建议)\s*[：:]/.test(pub(r.card ?? {}))) {
      no('J15f 反向对照：认不出动作行 ⇒ 退回可见格（链接不许丢）',
         `出现 ${n} 次；公开格里有=${/(?:完整清单|查看完整问题清单与修改建议)\s*[：:]/.test(pub(r.card ?? {}))}`);
    } else ok('J15f 反向对照：认不出动作行时退回可见格（链接不丢、不瞎插）');
  }
  // J15g 纯函数层：认不出动作行 ⇒ `null`（**不猜位置**）；块里已有 ⇒ 原样返回
  {
    const { insertLinkAboveAction: ins } = await import(path.join(CARDS_DIR, 'envelope.mjs'));
    const a = ins('1.【合规】x\n2.【安全】y', URL);
    const b = ins(`1.【合规】x\n${LINE}\n建议转 @法务 复核。`, URL);
    const want = `1.【合规】x\n${LINE}\n建议转 @法务 复核。`;
    if (a !== null) no('J15g 认不出动作行 ⇒ 回 null', JSON.stringify(a).slice(0, 80));
    else if (b?.action !== 'already' || b.text !== want) {
      no('J15g2 块里已有链接 ⇒ 原样返回', JSON.stringify(b).slice(0, 80));
    } else ok('J15g 认不出动作行回 null · 已有链接原样返回（不重复、不猜）');
  }
  // J15h **留痕**：链接落在哪必须看得见 —— 否则「插对了没有」只能靠人在群里看出来。
  //   实测这一跳此前**只接线、不记账**（`rl` 的返回值没人读）⇒ 账上只有「有链接 / 没链接」，
  //   而 Owner 报的是**落点**。
  {
    const hit = (r2.moved ?? []).find((m) => m.field === 'reportLink');
    if (!hit) no('J15h 链接的落点必须留痕', `搬迁记录：${JSON.stringify((r2.moved ?? []).map((m) => m.field))}`);
    else if (!/块内/.test(String(hit.why))) no('J15h2 留痕必须写明落在块内', JSON.stringify(hit));
    else ok(`J15h 链接落点留痕（→ ${hit.to}：${String(hit.why).slice(0, 34)}…）`);
  }
}

  // J13b **留痕**：摘了必须看得见（否则「本来就没写」与「写了被我摘了」长得一样）
  {
    const r = toCardOrText(PROSE, { verdict53: V53 });
    const hit = (r.moved ?? []).find((m) => /查证笔记/.test(String(m.why ?? '')));
    if (!hit) no('J13b 摘掉笔记必须留痕', JSON.stringify((r.moved ?? []).map((m) => m.why)));
    else ok(`J13b 摘掉笔记有留痕（${hit.chars} 字）`);
  }

  // J13c 反向对照：**普通句子一个字符都不许动**（会误报的检查器比没有更糟，§2.1.1）
  {
    const okLine = '知识库侧 3 条与素材相关，可以采信；这一条我核过了。';
    const r = stripInternalNotes(okLine);
    if (r.text !== okLine || r.removed.length) {
      no('J13c 反向对照：普通句子不许被摘', JSON.stringify(r));
    } else ok('J13c 反向对照：普通句子一个字符都不许动');
    const plain = '好的，这条我看了，没问题。\n\n要不要我把它发出去？';
    if (stripInternalNotes(plain).text !== plain) no('J13c2 无笔记的回复必须逐字不变', '被改动了');
    else ok('J13c2 无笔记的回复逐字不变');
  }

  // J13d 整段抄下来的那种形状（chainBlock 的首尾标记）也要兜得住
  {
    const r = stripInternalNotes('【★ 我的查证笔记 —— 只用来回答对方的追问。】\n知识库侧 1 条\n【★ 查证笔记结束】\n\n好的。');
    if (/查证笔记/.test(r.text) || r.removed.length !== 2) {
      no('J13d 整段抄下来时首尾标记都要摘掉', JSON.stringify(r));
    } else ok('J13d 整段抄下来时首尾标记都摘掉');
  }

  // J13e **接线**：`agent.mjs` 必须真的把 `internalNotes` 接进 chainBlock。
  //   少了这一条会出现「产出者对了、消费者没接」—— 而表现是**群里答不出追问**，
  //   卡片一切正常，没有任何东西会红（§2.4.1 那个形状）。
  {
    const src = fs.readFileSync(path.join(HERE, 'agent', 'agent.mjs'), 'utf8');
    if (!/rendered\.internalNotes/.test(src)) {
      no('J13e agent.mjs 必须把 rendered.internalNotes 接进 chainBlock',
         '不接 ⇒ 群里问「知识库侧几条」答不出来（卡片上又看不到）');
    } else ok('J13e agent.mjs 把 internalNotes 接进了 chainBlock（记忆里留得住）');
    const dual = fs.readFileSync(path.join(HERE, 'agent', 'dual_track.mjs'), 'utf8');
    if (!/internalNotes,/.test(dual)) no('J13f renderMerged 必须交出 internalNotes', '没这个出口');
    else ok('J13f renderMerged 交出了 internalNotes');
  }

  // J13g **代码建卡那一组的标题**：Owner 点名把「模型原话（原文照留）」去掉。
  //   为什么不是简单删掉标题：`cards.mjs` 的 `collapsible(g.title)` 会渲染出一个**空标题**的
  //   折叠面板 —— 那不是「去掉废话」，是换了一种坏法。所以是**改名**，而改名必须可断言：
  //   ① 卡面上不再出现「模型原话」这个内部说法；② 那一组仍在（模型原文一个字没丢）。
  {
    const r = toCardOrText('**结论：BLOCK** —— 1 处必须修改。', {
      verdict53: { state: 'BLOCK', line: '【审查结论：BLOCK】共发现 1 处必须修改。', from: 'dual-track-merged' } });
    const groups = r.data?.groups ?? [];
    const titles = groups.map((g) => String(g?.title ?? ''));
    if (titles.some((t) => /模型原话|原文照留/.test(t))) {
      no('J13g 代码建卡的组标题不许再写「模型原话（原文照留）」', JSON.stringify(titles));
    } else if (!groups.length) {
      no('J13g 代码建卡的组标题不许再写「模型原话（原文照留）」', '那一组整个没了 —— 模型原文会丢');
    } else ok(`J13g 代码建卡的组标题已改名（${titles.join(' / ')}），原文仍在组里`);
    if (!JSON.stringify(groups).includes('1 处必须修改')) {
      no('J13g2 改名不许把那一组的内容弄丢', JSON.stringify(groups).slice(0, 120));
    } else ok('J13g2 改名后那一组的内容一个字没丢');
  }
}

/* ─────────────── L 卡片正文的**分行**不许粘连（2026-10-09 实发缺口）───────────────
 *  病灶（实测三单，图片/视频/文案全中）：`dual_track.renderMerged` 当年的拼接是
 *    `${line}${reportNote}\n${tally}${covNote}${bodyText}`
 *  而 `tally` 与 `covNote` **都没有结尾换行** ⇒ 群里印出来是
 *    `…只能转人工）1.【合规-医疗宣称】视频 00:12 字幕`
 *  —— 编号 1 与「知识库侧 N 条 ／ 模型侧 M 条」**粘在同一行**，读者拿到的是一个坏掉的块。
 *  ⚠️ 2026-10-13 之后 `tally`/`covNote` **已不在这一行里**（它们改走 `internalNotes`），
 *     但这一段判据**不能删** —— 它守的是「卡面第一行与编号之间必须有换行」这条形状，
 *     而那个形状随时会以别的字段回来（`reportNote` 就是接在 `line` 后面的下一个）。
 *
 *  为什么判据必须直接调真生产者（而不是只靠夹具）：下面 J11 的夹具里**本来就写着**
 *  `'知识库侧 3 条 ／ 模型侧 3 条\n\n1.【合规】'` —— **夹具是对的、代码是错的**，
 *  两者不一致而没有任何东西发现（AGENTS.md §2.4 那个形状）。所以这里调 `renderMerged()`。
 */
head('L 卡片正文分行 · 汇总行与编号不许粘在一行');
{
  const { renderMerged } = await import(path.join(HERE, 'agent', 'dual_track.mjs'));
  const F = (l, c, s, e = {}) => ({ location: l, category: c, severity: s, source: 'model', ...e });
  const kb0 = { source: 'chain', hasSidecar: true, state: 'REVIEW', issueCount: 0,
                reportUrl: null, reportUrlKind: null, coverageGap: false, refused: false };
  const two = [F('视频 00:12 字幕', '合规-医疗宣称', 'REVIEW', { reason: 'r', suggestion: 's' }),
               F('图片 1', '消费者安全-使用姿势', 'REVIEW', { reason: 'r', suggestion: 's' })];
  const r = renderMerged(two, { state: 'REVIEW', kb: kb0, kbTextCount: 0, model: { ok: true, findings: two } });
  const block = r?.block ?? '';

  // L1 汇总行与第一个编号之间必须有换行（≤2 条走逐条平铺那一支）
  if (/只能转人工）1\.【/.test(block) || /条）1\.【/.test(block)) {
    no('L1 汇总行与「1.」之间必须有换行', '粘连 ⇒ 卡片正文是一个坏掉的块');
  } else if (!/\n1\.【/.test(block)) {
    no('L1 汇总行与「1.」之间必须有换行', '没找到编号行，判据本身失效');
  } else ok('L1 汇总行与「1.」之间必须有换行');

  // L2/L3 覆盖缺口那一支：卡面干净、笔记留全，且笔记里的话不许是假的
  //
  // ★★ 2026-10-13（Owner 裁定）：覆盖缺口那一段**不再上卡** —— 它属于
  //   「库侧/模型侧的口径读数与解释」那一族，Owner 逐字把它列进了「都去掉」。
  //   它改走 `internalNotes`（模型上下文 + 会话记忆）。
  //   ⇒ 判据从「卡上怎么写」改成两面：**卡上不许有** ＋ **笔记里仍不许说假话**。
  {
    const cov = { ...kb0, coverageGap: true };
    const rc = renderMerged(two, { state: 'REVIEW', kb: cov, kbTextCount: 0,
                                   model: { ok: true, findings: two } });
    const b = rc?.block ?? '';
    const notes = rc?.internalNotes ?? '';
    if (!/\n1\.【/.test(b)) {
      no('L2 卡面第一行与「1.」之间必须有换行', '粘连或找不到编号行');
    } else ok('L2 卡面第一行与「1.」之间必须有换行');
    if (/coverage_not_covered/.test(b) || /知识库侧/.test(b)) {
      no('L2b 覆盖缺口说明**不许**上卡（Owner：这一族文案都去掉）', b.slice(0, 120));
    } else if (!/coverage_not_covered/.test(notes)) {
      no('L2b 覆盖缺口说明**必须**留在查证笔记里（搬不是砍）',
         `笔记里没有：${JSON.stringify(notes.slice(0, 120))}`);
    } else ok('L2b 覆盖缺口说明：卡上无、笔记里有（搬不是砍）');

    // ★ 这句话**不许说假话**：列表里有别的条目时，覆盖缺口并不渲染进清单
    //   （实测视频单：卡说「上面那 1 条就是它」，而上面那条其实是模型侧的对比风险）
    //   ★★ 2026-10-15（Owner：「没有命中就是 pass，你不要自己定义」）：**缺口不再计数**
    //     ⇒ 笔记里那句「上面那 1 条…就是它」整句作废（卡上已经没有那个数了）。
    //     判据的**本意不变**（笔记里的话不许与清单对不上），只换成新口径的措辞。
    if (/上面那 1 条「需人工确认」就是它/.test(notes)) {
      no('L3 列表非空时不许说「上面那 1 条就是它」', '读者会照着这句话认错条目');
    } else if (!/不是发现了内容问题/.test(notes)) {
      no('L3 列表非空时不许说「上面那 1 条就是它」', '既没改口也没找到新措辞');
    } else ok('L3 列表非空时不许说「上面那 1 条就是它」（改成了「不是发现了内容问题」）');

    // L4 ★★ 2026-10-15（新口径）：列表**为空**那一支整个换了形状 ——
    //   缺口不再计数 ⇒ 这一支**不产块、`total = 0`**（⇒ 不建报告、卡上不给链接，
    //   真单那张「链接点开是空的」就是这么来的）；但**查证笔记必须留住**，
    //   而且要带上「未命中 ≠ 合规」那条边界（它是唯一拦住「把没查到念成没问题」的话）。
    const r0 = renderMerged([], { state: 'REVIEW', kb: cov, kbTextCount: 0,
                                  model: { ok: true, findings: [] } });
    const n0 = r0?.internalNotes ?? '';
    if (r0 && (r0.block !== null || r0.total !== 0)) {
      no('L4 缺口单**不产块、不计数**（⇒ 不建报告、不给链接）',
         `block=${JSON.stringify(String(r0.block).slice(0, 60))} total=${r0.total}`);
    } else if (!/不是发现了内容问题/.test(n0) || !/未命中 ≠ 合规/.test(n0)) {
      no('L4 缺口单**不产块、不计数**（⇒ 不建报告、不给链接）',
         `笔记丢了边界：${JSON.stringify(n0.slice(0, 120))}`);
    } else ok('L4 缺口单不产块/不计数（不建报告、不给链接），笔记留住「未命中 ≠ 合规」');
  }

  // ── L5/L6 **内部标记不许漏进卡片正文**（2026-10-09 实测缺陷，线上发过 6 张）──────
  //   病灶：`[[card:receipt]]\n{…}\n[[/card]]` 解析出的 `after` 是 **`[[/card]]`** ——
  //   它被当成「块外正文」交给 `enforceLimits` 的 `extra`，那个循环会把它**折进折叠组**
  //   ⇒ 群里出现一个内容写着 `[[/card]]` 的组。
  //   上线证据：`PMO/logs/ws_outbound.jsonl` 里 6 张（最近 2026-10-07 08:21）。
  {
    const { extractCardBlock } = await import(path.join(CARDS_DIR, 'envelope.mjs'));
    const KINDS_L = ['query-answer', 'evidence', 'receipt', 'data-table', 'turn-diff',
                     'correction', 'alert', 'decision', 'find-nothing'];
    const leaks = [];
    for (const k of KINDS_L) {
      const raw = `[[card:${k}]]\n{"verdict":"v"}\n[[/card]]`;
      const b = extractCardBlock(raw);
      if (!b) { leaks.push(`${k}:解析不出`); continue; }
      if (b.after.includes('[[/card]]') || b.after.includes('[[card:')) leaks.push(`${k}:after`);
      if (raw.slice(b.blockEnd).includes('[[/card]]')) leaks.push(`${k}:blockEnd`);
    }
    if (leaks.length) no('L5 九种类型的闭合标记都不许残留在 after/blockEnd', leaks.join(' · '));
    else ok('L5 九种类型的闭合标记都不许残留在 after/blockEnd');

    // L6 闭合标记**恒为 `[[/card]]`**，与 kind 无关 —— 第一版就把它写成了 `[[/${kind}]]`
    //    ⇒ 找 `[[/receipt]]` 永远找不到 ⇒ 修了等于没修。这条就是钉住那个错法。
    const bR = extractCardBlock('[[card:receipt]]\n{"verdict":"v"}\n[[/card]]');
    if (bR.blockEnd !== '[[card:receipt]]\n{"verdict":"v"}\n[[/card]]'.length) {
      no('L6 blockEnd 必须落在闭合标记之后', `实得 ${bR.blockEnd}`);
    } else ok('L6 blockEnd 必须落在闭合标记之后');
  }
}

/* ─────────────── K 提示词 · registry 与 persona 不许漂移 ─────────────── */
head('K 提示词 · 模型看到的类型清单必须与登记表一致');
{
  const { buildSystemPrompt, cardContract } = await import(path.join(HERE, 'agent', 'persona.mjs'));
  const prompt = buildSystemPrompt();

  // K1 十一个 kind 逐个出现在提示词里。少一个，模型就永远用不了它；
  // 多一个不存在的，模型调用它 → 整卡被拒 → 回复消失。
  for (const r of REGISTRY) {
    if (!prompt.includes(`\`${r.kind}\``)) no(`K1 ${r.kind} 出现在提示词里`, '模型不知道有这个类型');
    else ok(`K1 ${r.kind} 在提示词里`);
  }

  // K2 反向：提示词里的每个 kind 都必须是真的 —— 从卡片块形态里抠出来逐个核
  {
    const mentioned = new Set([...prompt.matchAll(/`([a-z][a-z-]+)`/g)].map((m) => m[1]));
    const looksLikeKind = [...mentioned].filter((k) => k.includes('-') || BY_KIND.has(k));
    const ghosts = looksLikeKind.filter((k) => !BY_KIND.has(k) && !['card-failed', 'reply-card', 'text-fallback', 'json', 'zhe'].includes(k));
    // 只对「形态像 kind 且出现在类型清单那一节」的做断言，避免误伤普通词
    const section = prompt.slice(prompt.indexOf('## 十一个类型'), prompt.indexOf('## 各类型的字段'));
    const ghostsInList = ghosts.filter((k) => section.includes(`\`${k}\``));
    if (ghostsInList.length) no('K2 清单里没有不存在的类型', `提示词里的类型清单含未知 kind：${ghostsInList.join(', ')}`);
    else ok('K2 清单里没有不存在的类型');
  }

  // K3 格式约束必须在提示词里逐字出现。
  //
  // ★★ 2026-10-26 二轮（Owner：「输出格式的问题，在 10/22 都是好的，恢复到 10/22 的输出格式」）：
  //   当天上午这三条钉的是「**每条回复都必须套卡**」那一版口径，它连带的产物是
  //   `【你好。】／你好。`、整段抬头重复 ＋ 余文进折叠区（实测 `oc_7775…` 14:08 / 12:21）。
  //   10-22 的口径是**两形态**，这三条跟着翻过来钉 —— 判据的强度没动，钉的内容换成
  //   10-22 那三条原文（缺任一条，模型就会滑回「每句话套卡」或「块外重复写正文」）。
  const musts = [
    ['结论 ≤60 字', /不超过 60 个字符/],
    ['边界 ≤90 字', /不超过 90 个字符/],
    ['内部记录只进折叠区', /只能进折叠区/],
    ['两形态：纯文本或卡片', /可以有两种形态/],
    ['一句话能答完就一句话答完', /一句话能答完的，就一句话答完/],
    ['块外不要重复写正文', /块之外不要重复写正文/],
    ['结论要写事实不写排版', /结论是你查到的事实，不是你打算怎么排版/],
  ];
  for (const [name, re] of musts) {
    if (!re.test(prompt)) no(`K3 ${name}`, '提示词里找不到这条硬约束');
    else ok(`K3 ${name} 已写进提示词`);
  }

  // K4 字段名清单要与登记表一致（模型才知道该填什么）
  for (const r of REGISTRY) {
    const line = prompt.split('\n').find((l) => l.startsWith(`- \`${r.kind}\`：`));
    if (!line) { no(`K4 ${r.kind} 字段行`, '提示词里没有这个类型字段行'); continue; }
    const missing = Object.keys(r.fields).filter((f) => !line.includes(f));
    if (missing.length) no(`K4 ${r.kind} 字段齐全`, `提示词漏了字段：${missing.join(', ')}`);
    else ok(`K4 ${r.kind} 字段齐全（${Object.keys(r.fields).length} 个）`);
  }

  // K5 提示词长度要有个上限意识：它进的是每一次调用的前缀。
  //
  // ★ 2026-10-05：上限 8000 → **8500，并冻结**（Owner 现场确认，选项 A）。
  //
  //   为什么调：8000 是 2026-09-21 定的「上限意识」，不是外部约束。此后
  //   09-28 / 10-04 两次会话各往人设里加了正文（判定依据分层、送审走哪条路），
  //   实测 8329 —— **K5 从那天起一直红着**，而没人注意到；连带的后果是
  //   I 段算出的期望项数少 1，于是三份文档里的「253 项全过」被报成不一致
  //   （那三条是下游，不是独立问题）。
  //   两条路摆过一次：删正文回 8000，或把上限调到实测值。**选了后者** ——
  //   要删的每一句都是 09-28 / 10-04 两次真实事故换来的措辞，而 8000 本身没有外部依据。
  //   （顺带：这次也把与 `kb_review_chain` tool description **逐条重复**的三段
  //   从人设里删掉了 —— 模型两处都读得到，重复是纯开销。）
  //
  //   为什么是**冻结**而不是「改成 8500 就算完」：只把数字改大，下一个人还会再改大一次。
  //   所以下面另有一条**逐字相等**的断言 —— 动这个数（往任何一个方向）都会红，
  //   逼着改它的人先说明理由。要放宽，先改
  //   `PMO/守衡-图片读取修复记录-20261005.md` 里记的那条，再改这里。
  const PROMPT_MAX_CHARS = 8500;
  {
    const n = [...prompt].length;
    const margin = PROMPT_MAX_CHARS - n;
    if (n > PROMPT_MAX_CHARS) {
      no('K5 提示词长度', `${n} 字符 > 上限 ${PROMPT_MAX_CHARS}（余量 ${margin}）；`
        + '要加正文就得先删等量的 —— 这个上限 2026-10-05 冻结，理由见本段注释');
    } else {
      ok(`K5 提示词 ${n}/${PROMPT_MAX_CHARS} 字符（余量 ${margin}；卡片段 ${[...cardContract()].length}）`);
    }
    // 冻结断言：这个数字本身不许被悄悄改动（往上改 = 松判据；往下改 = 也该说一声）
    if (PROMPT_MAX_CHARS !== 8500) {
      no('K5b 上限已冻结', `PROMPT_MAX_CHARS = ${PROMPT_MAX_CHARS} ≠ 8500 —— `
        + '这个数 2026-10-05 冻结（当时实测 8493）。要改先改 PMO 记录并在这里写明为什么');
    } else {
      ok('K5b 上限仍是冻结值 8500（改它必须带理由）');
    }
  }
}

/* ─────────────── L 发送链 · daemon 只有一个格式决策点 ─────────────── */
head('L 发送链 · 降级链完整且不重复投递');
{
  const daemon = fs.readFileSync(path.join(HERE, 'ws_daemon.mjs'), 'utf8');

  // ★★ 2026-10-26 二轮（Owner「恢复到 10/22 的输出格式」）：发送层**不许自己造卡**。
  //   10-22 的口径是「模型给卡片块就发卡，没给就纯文本」；当天上午那版硬包会产出
  //   `【你好。】／你好。` 这种「标题＝正文首行」的重复卡（实测 `oc_7775…` 14:08:19）。
  //   所以这里反过来钉：造卡那个入参不许回来；同时送审单的读数必须照旧交下去。
  if (/requireTemplate/.test(daemon)) {
    no('L0 发送层不许自己造卡',
       'ws_daemon 里还有 requireTemplate 的痕迹（10/22 口径：模型给卡块才发卡）');
  } else if (!/toCardOrText\(rawReply,\s*\{[^}]*reviewRequired:/s.test(daemon)) {
    no('L0 replyTo 送审单读数照旧交下去', '正常发送接线没有传 reviewRequired');
  } else ok('L0 replyTo 不造卡、送审单读数照旧交下去（10/22 格式口径）');

  // 内核异常也属于对用户的回复，必须走同一模板闸门并引用原消息。
  if (!/catch \(e\) \{\s*(?:clearTimeout\(progressTimer\);\s*)?[\s\S]{0,700}await replyTo\(chatId, msg\.message_id/.test(daemon)) {
    no('L0b 异常回复也走登记模板', 'handleMessage 异常出口绕过 replyTo 模板闸门');
  } else ok('L0b handleMessage 异常回复经 replyTo 套模板并引用原消息');

  // L1 卡片降级的目标必须是**同一条引用**里的纯文本，不是新发一条。
  // 新发一条会断开引用，而且和 replyMarkdown 自己的补发叠加 → 群里出现两份回答。
  if (!/replyCard\(messageId, card\)/.test(daemon)) no('L1 卡片走 reply', 'daemon 里没有 replyCard 调用');
  else ok('L1 卡片走 reply');

  if (!/card-failed→/.test(daemon)) no('L1 卡片失败降级到 reply 纯文本', '找不到 card-failed 降级分支');
  else ok('L1 卡片失败降级到同一条引用里的纯文本');

  // L2 feishu.replyCard 只尝试一次、不自己兜底 —— 兜底只能有一处，
  // 两处叠加的表现是同一个回答在群里出现两次。
  const feishuSrc = fs.readFileSync(path.join(HERE, 'agent', 'feishu.mjs'), 'utf8');
  const replyCardBody = feishuSrc.slice(feishuSrc.indexOf('export async function replyCard'), feishuSrc.indexOf('export async function sendTyping'));
  if (/sendMarkdown|sendCard|message\.create/.test(replyCardBody)) {
    no('L2 replyCard 只尝试一次', 'replyCard 自己做了兜底发送，与调用方的兜底叠加会重复投递');
  } else ok('L2 feishu.replyCard 只尝试一次，兜底只有 daemon 一处');

  // L2b 「兜底只能有一处」的另一半：`replyCard` 全仓只许有**一个实现**。
  // ★ 为什么需要它（2026-09-22 诊断 #14）：L2 只扫 `agent/feishu.mjs` **一个文件**，
  //   而 `tools/reply-cards/index.mjs` 同名同形地导出了**第二个** `replyCard`，
  //   它失败时自己会去 `sendCard` **新发一条** —— 正是 L2 要拦的形状，
  //   却因为「它在另一个文件里」而从来没被扫到。两份同名实现，一份合规一份不合规。
  //   判据是**唯一性**，不是「名字出现过」：`length !== 1` 同时挡住「多了一个」和
  //   「一个都没有」（后者是改名/搬走之后判据恒绿的形状 —— §2.4 那个病）。
  const exporterFiles = [];
  for (const dir of ['.', 'agent', 'reply-cards']) {
    let names = [];
    try { names = fs.readdirSync(path.join(HERE, dir)); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.mjs')) continue;
      const src = fs.readFileSync(path.join(HERE, dir, n), 'utf8');
      // ★ 必须**行首锚定**（`^\s*export`，m 标志），不能只查子串。
      //   第一版写的是 `/export async function replyCard\b/`，于是这条判据**自己**
      //   把三个文件报了出来：`verify_cards.mjs`（判据自己那行正则字面量）、
      //   `reply-cards/index.mjs`（我刚写的解释它为什么被删的注释）、
      //   以及真正的实现。**「名字出现过」在这里第三次骗人** ——
      //   前两次是 J1（常量名出现在 import 里）和 §2.4.4 的 `dryRun: true` 计数。
      //   行首锚定要求的是**一条真的导出语句**，注释与正则字面量都到不了行首。
      if (/^\s*export\s+async\s+function\s+replyCard\b/m.test(src)) {
        exporterFiles.push(dir === '.' ? n : `${dir}/${n}`);
      }
    }
  }
  if (exporterFiles.length !== 1 || exporterFiles[0] !== 'agent/feishu.mjs') {
    no('L2b replyCard 全仓只有一个实现',
       `导出 replyCard 的文件有 ${exporterFiles.length} 个：${exporterFiles.join('、') || '（一个都没有）'} —— 兜底只能有一处`);
  } else ok('L2b replyCard 全仓只有一个实现（agent/feishu.mjs）');

  // L3 形态决策**只能在一处**：`replyTo` 里过信封，`onMessage` 里不许碰。
  // ★ 2026-09-22 改。原先这里断言的是 `toCardOrText(result.reply)` 出现在 daemon 里、
  //   外加 `shaped.card ?? null` —— 那是在**描述当时的实现**（`onMessage` 过信封、
  //   `replyTo` 只收 `card`），而 `AGENTS.md` §2.5 写的是「只允许在 `replyTo` 里做」。
  //   **断言与规范指的是两个地方，而断言是绿的。**
  //   现在两条一起断言：**该在的地方必须在，不该在的地方必须不在** —— 这才叫「只允许一处」。
  // ★ 扫之前先剥注释：`onMessage` 里那段解释「原先 `toCardOrText` 在这里调」的注释，
  //   第一版把这条判据**自己**绊红了（注释里写着函数名）。同 J1a / C5：
  //   **注释不算代码**。剥注释这个动作本身也可能误伤（字符串里的 `//`），
  //   已知盲区明着留着 —— 这里两个函数体里没有那种字符串。
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const rtBody = stripComments(daemon.slice(daemon.indexOf('async function replyTo'), daemon.indexOf('async function safeSend')));
  const omBody = stripComments(daemon.slice(daemon.indexOf('async function onMessage'), daemon.indexOf('async function replyTo')));
  if (!/toCardOrText\(/.test(rtBody)) no('L3 形态决策在 replyTo 里', 'replyTo 没有过信封 —— §2.5 说这个判断只允许在那里做');
  else ok('L3 形态决策在 replyTo 一处过信封');
  if (!/if \(card\)/.test(rtBody)) no('L3 卡片真的传给了发送', 'replyTo 里没有「有卡走卡」的分支');
  else ok('L3 卡片真的传给了发送');
  if (/toCardOrText|shaped\./.test(omBody)) {
    no('L3 onMessage 不碰形态', 'onMessage 里也在碰形态（toCardOrText / shaped.*）—— 两处定形态，群里格式会随机');
  } else ok('L3 onMessage 只记日志，不碰形态');

  // L4 形态与搬迁必须落到日志里 —— 否则调模版只能靠重跑猜
  for (const [name, re] of [['卡片形态', /🃏 卡片/], ['搬迁记录', /↪ /], ['语域命中', /语域 /], ['降级原因', /卡片降级为文本/]]) {
    if (!re.test(daemon)) no(`L4 ${name} 记进日志`, '日志里看不到这一项，出问题无法归因');
    else ok(`L4 ${name} 记进日志`);
  }

  // L5 内核不许自己拼卡片 —— 形态决策只能在发送层一处。
  // 两处都能定形态，就会出现「内核按 A 想、发送层按 B 发」的错位。
  //
  // ★ 2026-10-06：**扫之前先剥注释**，与上面 L3 用同一条读法（`stripComments`）。
  //   同一个坑这是第二次：09-22 那次是 `onMessage` 里解释「原先 toCardOrText 在这儿调」的注释
  //   把 L3 自己绊红；今天往 `agent.mjs` 里加了一句解释「结论行怎么交到信封层」的注释，
  //   里面写着 `toCardOrText`，于是**内核一行卡片逻辑都没有，L5 却红了**。
  //   `AGENTS.md` §2.4.4 已经把修法写死了：**不是把注释改得更绕，是给扫描器统一一条读法** ——
  //   「注释不算代码」。已知盲区（字符串里的 `//`，例如 URL）明着留着，同 L3 那段注释。
  const agentSrc = stripComments(fs.readFileSync(path.join(HERE, 'agent', 'agent.mjs'), 'utf8'));
  const CARD_IN_KERNEL = /reply-cards|toCardOrText|\[\[card:/;
  if (CARD_IN_KERNEL.test(agentSrc)) {
    no('L5 内核不碰卡片', 'agent.mjs 里出现了卡片逻辑；形态决策必须只在 ws_daemon 一处');
  } else ok('L5 形态决策只在发送层一处');

  // ★ 反向对照（§2.4.1：**没红过的断言不算验证过它**）。
  //   上面那条现在是绿的，而「绿」也可能只是因为扫描器对什么都闭嘴了。
  //   两个样本必须给出**相反**的结果 —— 缺任何一个，另一个就是恒真的：
  //     · 喂一行真代码 → 必须命中（证明它真的会红）
  //     · 喂一行注释   → 必须不命中（证明「剥注释」这一步真的在起作用，不是把该红的也放过了）
  const BAD_CODE = 'const shaped = toCardOrText(reply);';
  const BAD_COMMENT = '// 这一段曾经在 agent.mjs 里调 toCardOrText —— 注释不算代码';
  if (!CARD_IN_KERNEL.test(stripComments(BAD_CODE))) {
    no('L5 反向对照：真代码必须命中', '喂一行调用 toCardOrText 的代码没被扫出来 —— 上面那条是空转的');
  } else ok('L5 反向对照：喂真代码会红');
  if (CARD_IN_KERNEL.test(stripComments(BAD_COMMENT))) {
    no('L5 反向对照：注释不许命中', '注释里提到函数名也算成了违规 —— 会误报的检查器比没有更糟');
  } else ok('L5 反向对照：注释不算代码');
}

/* ─────────────── L6/L7 内核自己的文案也要过同一把尺 ─────────────── */
head('L6/L7 内核文案 · 兜底话术不许被自己的检测器拦下 + 拒答的留证承诺要有执行点');
{
  // ★ 这两条守的是 2026-09-22 那次**真实事故**（上游在私聊里连问两次都没得到回答）。
  //
  //   链条：模型跑满 6 轮工具 → `agent.mjs` 的兜底话术把 `toolTrace` 里**所有**工具名
  //   拼进正文（`run_readonly_command、run_readonly_command、…` ×19）
  //   → `internalLeak` 判「连续三次同名工具」为故障 → `envelope.mjs` 降级成拒答
  //   → 她收到「我这次没能把回答组织好」，问第二次，一模一样。
  //
  //   两处各自都是对的：话术想说「我查过但没查到」，检测器想拦「内部记录漏进正文」。
  //   **合起来 100% 撞车** —— 这正是 §2.5「同一件事只能有一处判据」的反面：
  //   内核产出文案、信封判定文案，两边各自为政，谁都不知道对方的约束。
  //
  //   所以这条断言的形状是：**把内核的产出真的喂给信封的那把尺**。
  //   不是「源码里出现过 lintCopy」（那是 §2.4 里那个恒真的名字测试），
  //   而是**真的调用一次**。
  let fallbackReply = null;
  try {
    ({ fallbackReply } = await import(path.join(HERE, 'agent', 'agent.mjs')));
  } catch (e) {
    no('L6 能加载内核的兜底话术', `import agent/agent.mjs 失败：${e.message}`);
  }

  if (fallbackReply) {
    // 真实形状：一次工具循环里同名工具会连出十几次（实测 19 次 run_readonly_command）。
    const trace = [
      ...Array.from({ length: 19 }, () => ({ tool: 'run_readonly_command', ok: true, ms: 40 })),
      { tool: 'read_text_file', ok: true, ms: 1 },
      { tool: 'run_readonly_command', ok: false, ms: 12 },
    ];
    const t = String(fallbackReply(trace) ?? '');

    if (!t.trim()) no('L6 兜底话术非空', '拿到了空串 —— 对方会收到一条空回复');
    else ok('L6 兜底话术非空');

    const hits = lintCopy(t).filter((h) => h.level === 'error');
    if (hits.length) {
      no('L6 兜底话术过得了他自己的检测器',
         `喂 20 次真实形状的工具调用后，被拦下：${hits.map((h) => `${h.id}×${h.count}`).join('、')}`
         + `\n       —— 这句话术会被信封降级成拒答，对方等于没收到回答。原文：${JSON.stringify(t.slice(0, 120))}`);
    } else ok('L6 兜底话术过得了他自己的检测器（喂 20 次真实形状的工具调用）');

    // 三种形状都要过：一次没调、全成功、全失败。
    for (const [name, sample] of [
      ['空 trace（一次都没调）', []],
      ['全成功', [{ tool: 'run_readonly_command', ok: true }, { tool: 'grep_workspace', ok: true }]],
      ['全失败', [{ tool: 'run_readonly_command', ok: false }, { tool: 'run_readonly_command', ok: false }]],
    ]) {
      const s = String(fallbackReply(sample) ?? '');
      const h = lintCopy(s).filter((x) => x.level === 'error');
      if (!s.trim()) no(`L6 ${name} 非空`, '空串');
      else if (h.length) no(`L6 ${name} 不被拦`, `命中 ${h.map((x) => x.id).join('、')}`);
      else ok(`L6 ${name} 不被拦`);
    }

    // 反向对照：**旧话术必须被判红**。
    // 没有这一条，上面那些绿都证明不了什么 —— 万一 lintCopy 今天对什么都闭嘴，
    // 它们照样全绿（§2.4.1：一个从没红过的断言不算验证过它）。
    const OLD = '我查了几轮还是没能得出可靠结论，先把已知的告诉你：'
              + `我试过 ${trace.map((x) => x.tool).join('、')}，但信息不足。你能否补充一下具体要查什么？`;
    const oldHits = lintCopy(OLD).filter((h) => h.id === 'internalLeak');
    if (!oldHits.length) {
      no('L6 反向对照：旧话术必须被拦',
         '旧版那句（把工具名拼进正文）**没有**被 internalLeak 判红 —— '
         + '那么这条断言证明不了它修的是真问题，检测器可能已经失效');
    } else ok(`L6 反向对照成立：旧话术被 internalLeak 判红（×${oldHits[0].count}）`);
  }

  // L7 拒答话术说「原文留在 PMO/logs/dropped/」—— 那一行得真的存在。
  // 2026-09-22 之前它是**假的**：话说出去了，盘上什么都没有。
  //
  // ★ 这一条的**第一版是错的，而且错成本节要防的那个形状**：它用
  //   `envSrc.match(/PMO\/logs\/[\w\/.-]*/)` 从**源码文本**里抓路径 ——
  //   抓到的是注释里那半句（`PMO/logs`），而且 daemon 那边匹配到了**第一条**
  //   `path.join(LOG_DIR, …)`（那是早就存在的 `EVENT_DUMP`）。两侧都比错了地方，
  //   而比较还因为「解析出来是空串」被静默跳过 → **印出一个绿**。
  //   一个证明不了任何东西的绿，比红更糟（§2.4.1）。
  //
  //   现在两边都改成**能指出对象的读数**：
  //     说的 —— 真的调一次 `toCardOrText()`，从**产出的话术**里取路径；
  //     写的 —— 从 `dumpDropped` 的**函数体**里取，不看文件里别处。
  const { toCardOrText } = await import(path.join(CARDS_DIR, 'envelope.mjs'));
  const daemonSrc = fs.readFileSync(path.join(HERE, 'ws_daemon.mjs'), 'utf8');

  // 造一段**一定会被判 internalLeak** 的纯文本，逼出那条拒答话术。
  const LEAKY = '我试过 run_readonly_command、run_readonly_command、run_readonly_command，但信息不足。';
  const refusal = toCardOrText(LEAKY);
  if (!refusal.dropped || refusal.mode !== 'text') {
    no('L7 能逼出拒答话术', `喂一段必被拦的文本，拿到的是 mode=${refusal.mode} dropped=${refusal.dropped} —— 后面的断言都无从谈起`);
  } else ok('L7 能逼出拒答话术（喂 run_readonly_command ×3）');

  const claimed = (refusal.text.match(/PMO\/logs\/[\w.-]+(?:\/[\w.-]+)*\/?/) ?? [])[0] ?? null;
  if (!claimed) {
    no('L7 拒答话术说得出留证位置',
       `话术里没有落点路径，那「原文我留在…」就是一句没法核对的话。实际话术：${JSON.stringify(refusal.text)}`);
  } else ok(`L7 拒答话术承诺的落点：${claimed}`);

  // ① 执行点必须**接在 dropped 分支上**（不是别处随便调一次）
  if (!/if \(shaped\.dropped\)\s*dumpDropped\(/.test(daemonSrc)) {
    no('L7 留证有执行点', 'daemon 里没有 `if (shaped.dropped) dumpDropped(...)` —— '
       + '那句「原文留在 PMO/logs」就是一句没有执行点的承诺（§2.4.2）');
  } else ok('L7 留证接在 dropped 分支上');

  // ② 从 `dumpDropped` **函数体**里取落点，不看文件里别处
  const fnStart = daemonSrc.indexOf('function dumpDropped(');
  if (fnStart < 0) no('L7 落盘函数存在', '找不到 dumpDropped');
  else {
    // 函数体到下一个顶层 `function`/`async function` 之前
    const rest = daemonSrc.slice(fnStart);
    const nextTop = rest.slice(1).search(/\n(?:async )?function\s/);
    const body = nextTop > 0 ? rest.slice(0, nextTop + 1) : rest;

    if (!/writeFileSync/.test(body)) no('L7 落盘函数真的写盘', 'dumpDropped 里没有 writeFileSync');
    else ok('L7 dumpDropped 真的写盘');

    const wroteDir = (body.match(/path\.join\(LOG_DIR,\s*'([\w.-]+)'\)/) ?? [])[1] ?? null;
    if (!wroteDir) {
      no('L7 取得到落盘目录', 'dumpDropped 函数体里找不到 `path.join(LOG_DIR, …)` —— 取不到就说不了「说的与写的同一处」');
    } else {
      const claimedDir = (claimed ?? '').replace(/^PMO\/logs\/?/, '').replace(/\/$/, '');
      if (claimed && claimedDir !== wroteDir) {
        no('L7 说的与写的同一处',
           `话术说 PMO/logs/${claimedDir}，daemon 的 dumpDropped 写在 PMO/logs/${wroteDir} —— 两处会各自漂移`);
      } else if (!claimed) {
        no('L7 说的与写的同一处', '话术里没写落点，无从核对');
      } else ok(`L7 说的与写的同一处（PMO/logs/${wroteDir}/）`);
    }

    // ③ 落盘目录必须真的能被日志引用出来 —— 对方按话术去找，找得到才算数
    if (!/PMO\/logs\/dropped\//.test(body)) {
      no('L7 日志里印出的是同一个落点', 'dumpDropped 打的日志行里没有 `PMO/logs/dropped/`，'
         + '排查的人会去错的地方找');
    } else ok('L7 日志里印出的是同一个落点');
  }
}

/* ─────────────── N 附件 · 「按规矩不取」不许被说成「我读不到」 ─────────────── */
head('N 附件 · 策略边界不许被说成能力边界');
{
  // 依据 AGENTS.md §2.6 红线：飞书上的内容禁止下载。
  // 附件（file/image/media/audio）只有下载这一条通道，所以对它们是**不取**，不是**读不到**。
  // 为什么值得专门守：两种说法在对方那里引出的动作**完全相反** ——
  //   「读不到 / 没权限」→ 去申请权限、去找文件主人（全是白跑）
  //   「按规矩不取」→ 把文字贴过来，或者存成飞书云文档发我
  // 这条规矩横跨三个文件（内核直答 / 群历史占位 / 卡片模版），所以三处一起断言。
  const BANNED = [
    [/看到里面的内容/, '把「不取」说成「看不到」'],
    [/只能读文本消息/, '把规矩说成能力不足'],
    [/没有下载.{0,8}能力|能力还没做|工具集里没有/, '把规矩说成「能力还没做」'],
    [/没权限|权限不足/, '把规矩说成权限问题'],
  ];
  const hitsOf = (t) => BANNED.filter(([re]) => re.test(t)).map(([, why]) => why);

  // N1/N2 内核直答（agent.mjs）—— 群里第一眼看到的就是它
  const agent = fs.readFileSync(path.join(HERE, 'agent', 'agent.mjs'), 'utf8');
  const a0 = agent.indexOf('ATTACHMENT_TYPES.has');
  const a1 = agent.indexOf("reason: 'unsupported_type'");
  const branch = a0 >= 0 && a1 > a0 ? agent.slice(a0, a1) : '';
  if (!branch) no('N1 找到附件分支', 'agent.mjs 里找不到附件分支 —— 断言落空比断言失败更危险');
  else {
    const h = hitsOf(branch);
    if (h.length) no('N1 内核直答', `附件分支里还留着「${h.join('、')}」`);
    else ok('N1 内核直答说的是「不取」，不是「读不到」');
    if (!/贴过来|云文档/.test(branch)) no('N2 内核直答给替代路径', '说了不取，却没告诉对方下一步能怎么做');
    else ok('N2 内核直答给了走得通的替代路径');
  }

  // N3 卡片模版 cannot-read 的**示例**——
  //   只查 sample，不查 when/fields：那两处是给模型的**告诫**，
  //   它们必须能说出「别写成没权限 / 能力还没做」，把告诫本身判成违规就成了自伤。
  const cr = BY_KIND.get('cannot-read');
  const hc = cr ? hitsOf(JSON.stringify(cr.sample)) : ['找不到 cannot-read'];
  if (hc.length) no('N3 cannot-read 模版示例', `示例里还有「${hc.join('、')}」`);
  else ok('N3 cannot-read 模版示例说的是「不取」');

  // N4 群历史占位（feishu.mjs）—— 「我看不到什么」由工具给，不该让模型猜。
  //   只查**附件那一句**：非附件类型说「我没法看到里面的内容」是对的，不该被误伤。
  const fe = fs.readFileSync(path.join(HERE, 'agent', 'feishu.mjs'), 'utf8');
  const f0 = fe.indexOf('const ATTACHMENT_TYPES = new Set');
  const fSlice = f0 >= 0 ? fe.slice(f0, f0 + 900) : '';
  const fm = fSlice.match(/这是附件：[^']*/);
  if (!fm) no('N4 找到附件占位', 'feishu.mjs 里找不到附件那一句占位文案');
  else {
    const hf = hitsOf(fm[0]);
    if (hf.length) no('N4 群历史占位', `附件占位里还有「${hf.join('、')}」`);
    else if (!/不取/.test(fm[0])) no('N4 附件占位要写明「不取」', '占位文案没把「不取」说出来，模型只能自己猜');
    else ok('N4 群历史占位说的是「不取」');
  }

  // N5 检测器自证：喂**改动前**的旧文案必须报红，否则上面几条都是空转
  const OLD = '（file 类型，正文为空 —— 我没法看到里面的内容）';
  if (!hitsOf(OLD).length) no('N5 检测器自证', '喂 2026-09-18 之前的旧文案没报红 —— 这几条正则是空转的');
  else ok('N5 检测器自证：喂旧文案会红');
}

/* ─────────────── I 文档里的自证数不能是写死的 ─────────────── */
head('I 数字 · 文档里写的自证项数必须等于实际项数');
{
  // 本项目第一号坑就是「文档里的数字复现不出来」（ADR-0013 §15.3）。
  // 所以文档里凡出现「N 项全过」，那 N 必须是**当前**的实测值。
  // 这一轮已经踩过一次：加了 G/H 两段之后文档里还写着 158。
  // 与其每次记得改，不如让它红。
  const docs = [
    'tools/reply-cards/README.md',
    'tools/reply-cards/contract.md',
    'PMO/守衡-回复卡片模版与语域规程.md',
  ];

  // ★ 期望值是**在本段开头一次性算出来的常量**，不是循环里边跑边读的 `pass`。
  //
  //   旧版写的是 `Math.abs(n - pass) > 12`（±12 容差），有两个毛病：
  //   ① `pass` 每轮 ok() 都在涨，于是三份文档被拿去比的是**三个不同的基准**
  //      （实测 229 / 230 / 231）—— 同一条断言自己跟自己不一致；
  //   ② 容差 ±12 让「必须等于」变成「差一个数量级也行」，而段标题与
  //      `contract.md:293` 的说明都写着「必须等于实际项数」。**断言比它声称的弱。**
  //
  //   现在：`docs.length` 是常量（每份文档无论走 ok 还是 no 都恰好贡献 1 条断言），
  //   所以 `passBeforeI + docs.length` 是确定的终值 —— 与本段自己的判定无关，不自指。
  const passBeforeI = pass;
  const expected = passBeforeI + docs.length;

  for (const rel of docs) {
    const f = path.join(ROOT, rel);
    if (!fs.existsSync(f)) { no(`I ${rel}`, '文件不存在'); continue; }
    const md = fs.readFileSync(f, 'utf8');
    const claims = [...md.matchAll(/(\d+)\s*项(?:全过|通过)/g)].map((m) => Number(m[1]));
    if (!claims.length) { ok(`I ${rel} 未写死项数`); continue; }
    const wrong = claims.filter((n) => n !== expected);
    if (wrong.length) {
      no(`I ${rel}`, `写着 ${wrong.join('/')} 项，本脚本实际是 ${expected} 项`);
    } else {
      ok(`I ${rel} 的 ${claims.join('/')} == 实测 ${expected}`);
    }
  }
}

/* ─────────────── 汇总 ─────────────── */
console.log(`\n${'═'.repeat(64)}`);
console.log(`通过 ${pass} 项 · 不通过 ${fail} 项`);
if (fail) {
  console.log('\n不通过明细：');
  for (const b of bad) console.log(`  · ${b}`);
  console.log('\n❌ 卡片模版与文档还不一致，别拿去发群。');
  process.exit(1);
}
console.log('✅ 十一个类型建得出、字段都真的被用、白名单与探针一致、降级可读、文档同步、语域规则正反都对');

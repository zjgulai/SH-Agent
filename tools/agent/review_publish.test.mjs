/**
 * review_publish.test.mjs —— 「**每一个评审任务都必须落表**」这条硬规矩的自证（离线，不碰真飞书）
 *
 *   node tools/agent/review_publish.test.mjs
 *
 * ★ 为什么要有它（Owner 2026-10-05 现场定的两条里的一条）：
 *   那天送了四条素材，链跑完 3.5~17.9 分钟，**表里一行都没有** —— 因为链自己的发布条件是
 *   「有**三态结论**才发」，拒答（`NEEDS_INPUT`）整单被跳过。于是「审过了、结论是拒答」
 *   在盘上零痕迹。规矩改成「每一个评审任务都必须落表」，而**规矩要有执行点**
 *   （`AGENTS.md` §2.4）—— 执行点就是 `review_publish.mjs`，判据就是这一份。
 *
 * ★ 判据的形状（照 `lark_write.test.mjs` 那套）：
 *   每条都用**假客户端真调一次**来证，断的是「哪个接口被调了几次、写进去的是什么」，
 *   不是「源码里有没有那行 if」。每条「不该发生」都配一条**正向对照**。
 *
 * ★ 自证自身不许有副作用（§2.4.4）：留痕被 `SHOUHENG_LARK_WRITES` 指到临时文件，
 *   最后由 C1 断言**真留痕文件在这次运行前后没被动过**。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const TMP = path.join(os.tmpdir(), `rp-test-${process.pid}-${Date.now()}.jsonl`);
process.env.SHOUHENG_LARK_WRITES = TMP;          // ★ 必须在 import 之前指走

const REAL_LEDGER = path.join(
  path.dirname(new URL(import.meta.url).pathname), '..', '..', 'PMO', 'logs', 'lark_writes.jsonl');
const realStat = () => { try { const s = fs.statSync(REAL_LEDGER); return `${s.size}:${s.mtimeMs}`; } catch { return 'absent'; } };
const REAL_BEFORE = realStat();

const lw = await import('./lark_write.mjs');
const rp = await import('./review_publish.mjs');

/** 4b 用的「两侧合并置信度」样本（形状 = `dual_track.mergedConfidence()` 的产物）。 */
const MERGED_CONF = Object.freeze({
  value: 0.85, band: 'confirm', kb_band: 'direct', model_band: 'confirm',
  basis: '两侧按 PRD §6.6 三档取更保守一侧：模型侧拉低（库侧 direct ／ 模型侧 confirm）',
});

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

/* ─────────────────────────── 假飞书客户端 ─────────────────────────── */
const API_OK = (data) => () => ({ code: 0, msg: 'ok', data });

function mkClient(handlers = {}) {
  const calls = [];
  const mk = (key) => async (args) => {
    calls.push({ key, args });
    const h = handlers[key];
    if (typeof h === 'function') return h(args);
    if (h === undefined) throw new Error(`未打桩的调用：${key}`);
    return h;
  };
  const cl = {
    bitable: {
      appTable: { list: mk('appTable.list') },
      appTableField: { list: mk('appTableField.list') },
      appTableRecord: {
        list: mk('appTableRecord.list'),
        batchCreate: mk('appTableRecord.batchCreate'),
        batchGet: mk('appTableRecord.batchGet'),
        batchUpdate: mk('appTableRecord.batchUpdate'),
      },
    },
  };
  return { cl, calls, hit: (k) => calls.filter((c) => c.key === k).length };
}

/** 一次写入的完整桩：list 回给定行，create/update/get 回一个「照抄写入」的成功响应。 */
function install({ rows = [] } = {}) {
  const sent = { created: null, updated: null };
  const c = mkClient({
    'appTable.list': API_OK({ items: [{ table_id: 'tblTEST', name: '评审结论' }] }),
    'appTableRecord.list': API_OK({ items: rows, total: rows.length, has_more: false }),
    'appTableRecord.batchCreate': (args) => {
      sent.created = args?.data?.records?.map((r) => r.fields) ?? null;
      return { code: 0, msg: 'ok', data: { records: [{ record_id: 'recNEW', fields: sent.created?.[0] ?? {} }] } };
    },
    'appTableRecord.batchGet': (args) => {
      const ids = args?.data?.record_ids ?? [];
      const found = rows.filter((r) => ids.includes(r.record_id));
      return { code: 0, msg: 'ok', data: { records: found.length ? found : [{ record_id: ids[0], fields: sent.created?.[0] ?? {} }] } };
    },
    'appTableRecord.batchUpdate': (args) => {
      sent.updated = args?.data?.records ?? null;
      const ids = (args?.data?.records ?? []).map((r) => r.record_id);
      const found = rows.filter((r) => ids.includes(r.record_id));
      // 回读要「改完之后的样子」：拿旧行叠上本次提交的字段
      const merged = (found.length ? found : [{ record_id: ids[0], fields: {} }]).map((r) => {
        const patch = (args?.data?.records ?? []).find((x) => x.record_id === r.record_id)?.fields ?? {};
        return { record_id: r.record_id, fields: { ...r.fields, ...patch } };
      });
      return { code: 0, msg: 'ok', data: { records: merged } };
    },
  });
  lw.__injectClient(c.cl);
  return { c, sent };
}

/* ─────────────────────────── 1. 纯函数 ─────────────────────────── */
console.log('\n═══ 1. 内容 ID / 状态 / 结论抽取（纯函数）═══');

const IMG_TEXT = ['5', 'MOMCOZY', 'Bereit Fur Die Nacht，', 'Supermama？', 'Manche Superkrafte',
  'Passen Auf Den', 'Nachttisch', '5615', 'RC', '刘华的', 'ROOT', 'Owner', '5615 ROOT',
  '"Was Sind Deine Mama-Hacks Fuir Ruhigere Nachte？"', '5615 ROC'].join('\n');

t('结论表按本条会话分流，生产群中的 Owner 仍写生产表；关闭闸门始终优先', () => {
  const saved = process.env.SHOUHENG_REVIEW_TABLE;
  const prod = { chatId: 'oc_LEGACY_GROUP', chatType: 'group',
    senderOpenId: 'ou_TEST_USER' };
  const test = { chatId: 'oc_TEST_GROUP', chatType: 'group' };
  const owner = { chatId: 'oc_TEST_P2P', chatType: 'p2p',
    senderOpenId: prod.senderOpenId };
  try {
    delete process.env.SHOUHENG_REVIEW_TABLE;
    eq(rp.reviewTable(prod).table, 'tblv2Y5NxxtDj4Pl');
    eq(rp.reviewTable(test).table, 'tblCXPQVzfFWWCon');
    eq(rp.reviewTable(owner).table, 'tblCXPQVzfFWWCon');
    process.env.SHOUHENG_REVIEW_TABLE = 'appFixture/tblFixture';
    eq(rp.reviewTable(prod).table, 'tblv2Y5NxxtDj4Pl', '全局覆盖不能把已映射生产群送去别表');
    eq(rp.reviewTable(test).table, 'tblCXPQVzfFWWCon');
    eq(rp.reviewTable(owner).table, 'tblCXPQVzfFWWCon');
    eq(rp.reviewTable({ chatId: 'oc-batch-fixture' }).table, 'tblFixture', '未映射批处理入口仍兼容显式配置');
    process.env.SHOUHENG_REVIEW_TABLE = 'off';
    eq(rp.reviewTable(prod), null);
    eq(rp.reviewTable(test), null);
  } finally {
    if (saved === undefined) delete process.env.SHOUHENG_REVIEW_TABLE;
    else process.env.SHOUHENG_REVIEW_TABLE = saved;
  }
});

t('内容 ID = AUTO-<sha256(送审文本去尾空白) 前 12 位>，与链算的**同一个**', () => {
  const id = rp.contentIdOf(IMG_TEXT);
  eq(id, 'AUTO-48cac901ac43',
    '与 10-05 那份报告里的 content_id 对不上 —— 对不上就会写出**重复行**');
  // 反向对照：末尾多一个换行**不许**改变 ID（链算的时候用的是去尾空白的那一份）
  eq(rp.contentIdOf(IMG_TEXT + '\n'), id, '尾部空白不该改变内容 ID');
  // 反向对照：内容真变了，ID 必须变
  ok_(rp.contentIdOf(IMG_TEXT + 'x') !== id, '内容变了 ID 却没变 —— 那这个 ID 就不是内容指纹');
  eq(rp.contentIdOf(''), null, '空文本没有内容 ID');
});

/* ★★ 2026-10-22（Paruu 真单）：结论行有两种写法，判据必须都认 —— 而且**合并结论优先**。
 *   病灶：链写的是 `**本 skill 分级结论（4A＋4B＋图文一致性合并，取更保守一侧）**：**REVIEW**`，
 *   括号把「结论」与「：」隔开 ⇒ 旧正则返回 null ⇒ 表行不写 `Agent 结论` ⇒ 停在链写的 PASS
 *   （而卡片是 REVIEW）—— 同一单两个结论又出现。
 *   变异自证：把 `merged` 那一段删掉 ⇒ 第一条与第二条精确变红。 */
t('★ 结论行：`分级/合并结论（…）：X` 要认，且优先于 `【审查结论：PASS】`', () => {
  eq(rp.conclusionOf('**本 skill 分级结论（4A＋4B＋图文一致性合并，取更保守一侧）**：**REVIEW**'),
     'REVIEW', '带括号的分级结论行没认出来 —— 表行会停在链的 PASS');
  eq(rp.conclusionOf('【审查结论：PASS】\n\n**合并结论：REVIEW**（本 skill 定级）'),
     'REVIEW', '同时出现引擎行与合并行时必须取合并结论');
  // 反向对照：没有可识别形状的句子 ⇒ null（不许猜成 PASS/REVIEW）
  eq(rp.conclusionOf('链给出的结论是 REVIEW，但这句没有冒号'), null, '没有契约形状的句子不许认');
});

t('回滚开关：`SHOUHENG_CONCLUSION_MERGED=0` ⇒ 回到旧式（分级结论不再优先）', () => {
  const old = process.env.SHOUHENG_CONCLUSION_MERGED;
  try {
    process.env.SHOUHENG_CONCLUSION_MERGED = '0';
    eq(rp.conclusionOf('**本 skill 分级结论（4A＋4B）**：**REVIEW**'), null,
       '开关关掉后仍优先了分级结论');
  } finally {
    if (old === undefined) delete process.env.SHOUHENG_CONCLUSION_MERGED;
    else process.env.SHOUHENG_CONCLUSION_MERGED = old;
  }
});

t('结论 → 状态：**三态不许进这一格**，机器只落「待审」（PRD §8.2 逐字）', () => {
  // ★★ 2026-10-15（Owner）：「状态按照 prd：待审 / 已修改 / 已发布，现在填的错的」。
  //   PRD §8.2 逐字：「… Agent 结论、置信度、问题数量、问题分类汇总、报告链接 /
  //   人工复核人、复核结论、sign-off 人、发布时间 / **状态：待审 / 已修改 / 已发布**」
  //   ⇒ 三态是 `Agent 结论` 的值域。旧断言把错的行为钉住了（`statusOf('BLOCK')==='BLOCK'`），
  //     所以这条**必须与实现一起改** —— 否则判据本身在保护缺陷。
  eq(rp.statusOf('BLOCK'), '待审', '三态不许进「状态」——它是 `Agent 结论` 的值域');
  eq(rp.statusOf('REVIEW'), '待审'); eq(rp.statusOf('PASS'), '待审');
  eq(rp.statusOf('NEEDS_INPUT'), '待审', '拒答/未测/空同样落「待审」—— 它们都还没有定论，等人');
  eq(rp.statusOf(null), '待审'); eq(rp.statusOf('未测'), '待审');
  // **反向对照**：把结论原样返回（旧实现）⇒ 上面第一条必须不成立。没有它，
  //   这条判据可能只是「所有输入都给待审」的恒真式，看不出实现是否又改回三态。
  const asOld = (c) => (String(c ?? '').toUpperCase().includes('BLOCK') ? 'BLOCK' : '待审');
  ok_(asOld('BLOCK') !== rp.statusOf('BLOCK'), '旧实现（三态照搬）必须与现实现给出不同的值');
});

t('「状态」的人设终态受保护：已修改 / 已发布 不许被机器改回「待审」', () => {
  eq(rp.HUMAN_TERMINAL_STATUS, ['已修改', '已发布'], '终态清单就是 PRD 三档里机器不拥有的那两档');
  ok_(rp.HUMAN_TERMINAL_STATUS.includes('已发布') && !rp.HUMAN_TERMINAL_STATUS.includes('待审'),
      '「待审」是机器的档位，不能被当成终态挡住（第一次送审必须能落上）');
});

t('从链的回答里抽结论：抽不到就回 null，**不猜**', () => {
  eq(rp.conclusionOf('**引擎最终输出：`BLOCK`** ｜ review_id = rv-x'), 'BLOCK');
  eq(rp.conclusionOf('state = NEEDS_INPUT ｜ fails_closed = true'), 'NEEDS_INPUT');
  eq(rp.conclusionOf('这条我没读到，稍后再试'), null, '抽不到就该是 null —— 猜一个等于编结论');
});

// ★★ 2026-10-07（Owner 同意）—— **免责句里出现 PASS ≠ 结论是 PASS**。
//   旧判据取全文**第一个**三态词 ⇒ 下面前三条全部抠成 `PASS`（fail-open：把"不能放行"读成放行）。
//   素材 D（表行 `recvxlAvpEWMIX`）就是这么在库侧零读数的情况下落了 `Agent 结论=PASS`。
//   变异自证：把 `conclusionOf` 改回 `/\b(PASS|REVIEW|BLOCK|NEEDS_INPUT)\b/` ⇒ 前三条**精确变红**。
t('★ 免责句/否定句里的三态词**不许**被当成结论（fail-open 防线）', () => {
  eq(rp.conclusionOf('库侧未参与 ⇒ 本条**不得当 PASS 依据**。结论：REVIEW。'), 'REVIEW',
     '有结论行 ⇒ 认结论行那个，不认前面那句免责话');
  eq(rp.conclusionOf('本次没跑到引擎，所以**不能当 PASS**；请重试。'), null,
     '没有结论行 ⇒ 回 null（宁空不猜），**不许**抠成 PASS');
  eq(rp.conclusionOf('链没跑成，结论未知（不是 PASS，也不是 REVIEW）。'), null,
     '「结论未知」不是结论行 ⇒ null');
  eq(rp.conclusionOf('本单不得据此当 PASS。'), null, '免责句单独出现 ⇒ null');
  // 正例：三种**有格式契约**的读数位置仍然要认（判据没被收窄到认不出来）
  eq(rp.conclusionOf('【审查结论：REVIEW】共发现 2 处需人工确认。'), 'REVIEW', 'PRD §5.3 结论行');
  eq(rp.conclusionOf('**结论：BLOCK**（红线命中）'), 'BLOCK', '`结论：` 行');
  eq(rp.conclusionOf('状态：NEEDS_INPUT'), 'NEEDS_INPUT', '`状态：` 行');
});

// ★★ 2026-10-21（四态）：`Agent 结论` 这一格必须收得下四态第 2 态 `PASS+SUGGEST`。
//   改之前它**抽不出来**（`S` 里没有这一态）⇒ 这一格回 null、不写 —— 一单「有建议、无强制问题」
//   在表里就成了空白，卡片与表行对不上（与 2026-10-07 那次「表里 NEEDS_INPUT ↔ 卡 REVIEW」同一个病）。
//   反向对照两条：旧字面 `SUGGEST` **必须归一到** `PASS+SUGGEST`（不许原样进表、也不许当抽不到）；
//   而 `PASS+SUGGEST` 不许被截成 `PASS`（前缀匹配顺序）。
t('★ 四态：`PASS+SUGGEST` 抽得出来、旧字面归一、且不被截成 PASS', () => {
  eq(rp.conclusionOf('【审查结论：PASS+SUGGEST】发现 1 处建议优化，不阻断发布。'), 'PASS+SUGGEST',
     '四态第 2 态没抽出来 —— 表里会留一格空白');
  eq(rp.conclusionOf('状态：PASS+SUGGEST'), 'PASS+SUGGEST',
     'PASS+SUGGEST 被前缀截成了 PASS（`PASS\\+SUGGEST` 必须排在 `PASS` 前面）');
  eq(rp.conclusionOf('【审查结论：SUGGEST】发现 1 处建议优化，不阻断发布。'), 'PASS+SUGGEST',
     '旧字面没归一（表里就会出现 `SUGGEST` 这个不在四态里的值）');
  eq(rp.conclusionOf('【审查结论：PASS】未发现已知底线风险，可转交 @陈静姝 进行 sign-off。'), 'PASS',
     '反向对照：真 PASS 不许被误读成 PASS+SUGGEST');
});

t('要写的字段只含**机器那一侧**；人填的格子一个都不进去', () => {
  const f = rp.rowFieldsOf({ contentId: 'AUTO-1', question: '审一下', contentType: '社媒图片',
                             conclusion: 'NEEDS_INPUT', issueCount: 5, summary: 'x' });
  eq(f['状态'], '待审');
  eq(f['问题数量'], 5);
  for (const k of rp.HUMAN_FIELDS) ok_(!(k in f), `人填的字段「${k}」不许出现在要写的字段里`);
  // 空值不写：免得把已有的值覆盖成空
  const g = rp.rowFieldsOf({ contentId: 'AUTO-1' });
  ok_(!('置信度' in g) && !('报告链接' in g), '没有值就不该出现在提交里');
});

t('显式撤回本轮报告 ⇒ 提交 null；普通空链接仍不清空旧值', () => {
  const cleared = rp.rowFieldsOf({ conclusion: 'NEEDS_INPUT', clearReportUrl: true,
    reportUrl: 'https://old.example/doc' });
  eq(cleared['报告链接'], null, '明确撤回必须优先于旧链接回落，真实写入 null');
  for (const clearReportUrl of [undefined, false, 'true']) {
    const untouched = rp.rowFieldsOf({ conclusion: 'NEEDS_INPUT', reportUrl: null, clearReportUrl });
    ok_(!('报告链接' in untouched), '只有布尔 true 才允许清空链接');
  }
  const normal = rp.rowFieldsOf({ reportUrl: 'https://new.example/doc' });
  eq(normal['报告链接'], { link: 'https://new.example/doc', text: '审查报告' },
    '正常报告仍提交原来的结构化链接');
});

/* ─────────────────────────── 2. 落表行为 ─────────────────────────── */
console.log('\n═══ 2. 落表：链没发就我们发、链发了就补空字段、人填的不许动 ═══');

await ta('拒答重用旧行 ⇒ 清除旧报告并回读一致，人填字段与已发布状态保留', async () => {
  let stored = { record_id: 'recWITHHELD', fields: {
    '内容 ID': 'AUTO-withheld', '送审问题': '审核', 'Agent 结论': 'REVIEW',
    '报告链接': { link: 'https://old.example/doc', text: '审查报告' },
    '置信度': 0.86, '问题数量': 3, '状态': '已发布',
    '人工复核人': '人工原值', '复核结论': '人工确认',
  } };
  const c = mkClient({
    'appTable.list': API_OK({ items: [{ table_id: 'tblTEST', name: '评审结论' }] }),
    'appTableRecord.list': () => ({ code: 0, data: { items: [stored], has_more: false } }),
    'appTableRecord.batchGet': () => ({ code: 0, data: { records: [stored] } }),
    'appTableRecord.batchUpdate': (args) => {
      const patch = args.data.records[0];
      stored = { record_id: patch.record_id, fields: { ...stored.fields, ...patch.fields } };
      return { code: 0, data: { records: [stored] } };
    },
  });
  lw.__injectClient(c.cl);
  const result = await rp.ensureReviewRow({ contentId: 'AUTO-withheld', question: '审核',
    conclusion: 'NEEDS_INPUT', confidence: 0, issueCount: 0, summary: '本次完整审核未形成有效结论',
    clearReportUrl: true, reportUrl: null,
    '人工复核人': '不应写入', '复核结论': '不应写入',
  });
  eq(result.action, 'updated');
  eq(result.record_id, 'recWITHHELD', '必须更新同一行，不得另建');
  eq(result.readback, 'consistent', '清空必须能通过真实写通道的回读判据');
  eq(stored.fields['报告链接'], null, '旧 REVIEW 报告不能继续挂在拒答行上');
  eq(stored.fields['Agent 结论'], 'NEEDS_INPUT');
  eq(stored.fields['置信度'], 0);
  eq(stored.fields['状态'], '已发布', '不得改写人的终态');
  eq(stored.fields['人工复核人'], '人工原值');
  eq(stored.fields['复核结论'], '人工确认');
  const patch = c.calls.find((x) => x.key === 'appTableRecord.batchUpdate').args.data.records[0].fields;
  for (const key of rp.HUMAN_FIELDS) ok_(!(key in patch), `不得提交人填字段：${key}`);
});

await ta('表里这一轮**一行都没有** → 必须新建一行（这就是那条硬规矩的兜底）', async () => {
  const { c, sent } = install({ rows: [] });
  const r = await rp.ensureReviewRow({
    contentId: rp.contentIdOf(IMG_TEXT), question: '审一下这张图能过吗？', contentType: '社媒图片',
    conclusion: 'NEEDS_INPUT', issueCount: 5, summary: '拒答（fail-closed）',
  }, { since: Date.now() - 60_000, question: '审一下这张图能过吗？' });
  eq(r.action, 'created', `该新建，实际 ${r.action}：${r.detail}`);
  eq(r.ok, true);
  eq(c.hit('appTableRecord.batchCreate'), 1, 'batchCreate 必须被调**恰好一次**');
  eq(sent.created[0]['内容 ID'], rp.contentIdOf(IMG_TEXT));
  eq(sent.created[0]['状态'], '待审');
  eq(sent.created[0]['问题数量'], 5);
  for (const k of rp.HUMAN_FIELDS) ok_(!(k in sent.created[0]), `新建时不许写人填的「${k}」`);
  eq(r.readback, 'consistent', `回读必须一致，实际 ${r.readback}：${r.detail}`);
});

await ta('链自己写了那一行 → **补空字段**，不许再建一行', async () => {
  const rows = [{ record_id: 'recCHAIN', fields: {
    '内容 ID': rp.contentIdOf(IMG_TEXT), '写⼊时间': Date.now(), '写入时间': Date.now(),
    '送审问题': '审一下这张图能过吗？', '内容 ID2': undefined,
    'Agent 结论': 'BLOCK', '问题数量': null, '状态': 'BLOCK' } }];
  const { c, sent } = install({ rows });
  const r = await rp.ensureReviewRow({
    contentId: rp.contentIdOf(IMG_TEXT), question: '审一下这张图能过吗？', contentType: '社媒图片',
    conclusion: 'BLOCK', issueCount: 3, summary: '命中 S-1.2',
  }, { since: Date.now() - 60_000, question: '审一下这张图能过吗？' });
  eq(r.action, 'updated', `该补字段，实际 ${r.action}：${r.detail}`);
  eq(c.hit('appTableRecord.batchCreate'), 0, '**一行都不许新建**（否则同一单两行）');
  const patch = sent.updated[0].fields;
  eq(patch['问题数量'], 3, '空着的机器字段要补上');
  eq(patch['问题分类汇总'], '命中 S-1.2');
  ok_(!('Agent 结论' in patch), '**值没变就不写**（本轮 BLOCK＝已有 BLOCK ⇒ 不该产生写入）');
  for (const k of rp.HUMAN_FIELDS) ok_(!(k in patch), `人填的「${k}」不许进补写`);
});

// ★★ 2026-10-08（Owner 同意「推荐 B」）—— **结论派生列允许改写**。
//   病灶（实测，不是推论）：素材 A 那行 `recvxlTh9b6HYq` 上，
//   `Agent 结论=REVIEW`（引擎建行时写的）＋ `问题分类汇总=「未能得出结论（NEEDS_INPUT）」`
//   （守衡后来写的、当时判据过宽）—— 两格都已填 ⇒ 「只补空」让它们**谁也改不动**，
//   这一行自相矛盾且**无法自愈**；多轮送审结论变化（REVIEW→BLOCK）同样落不了地。
//   变异自证：把 `CONCLUSION_DERIVED_FIELDS` 改成 `['状态']`（回到改动前）⇒ 本组**精确变红**。
await ta('★ 结论派生列：**值变了就要改写**（不许定格在第一轮）', async () => {
  const rows = [{ record_id: 'recDERIV', fields: {
    '写入时间': Date.now(), '送审问题': '审一下这张图能过吗？',
    '内容 ID': rp.contentIdOf(IMG_TEXT),
    'Agent 结论': [{ text: 'REVIEW', type: 'text' }],   // 真实形状：文本字段是数组
    '问题数量': 1, '置信度': 0, '状态': 'REVIEW',
    '问题分类汇总': '链已跑完（145s）。**未能得出结论**（NEEDS_INPUT）｜原因码 `coverage_not_covered`',
    '报告链接': { link: 'https://old.example/doc', text: '审查报告' },
  } }];
  const { sent } = install({ rows });
  // ★ 2026-10-16：这一轮喂进去的「送审问题」**与格子里那份不同** ——
  //   要验的正是「旧格里的脏内容能不能被覆盖」（同值的情况在下面那条反向对照里）。
  const NEW_Q = '这一轮的原文（修掉旧格里的内部指令）';
  const r = await rp.ensureReviewRow({
    contentId: rp.contentIdOf(IMG_TEXT), question: NEW_Q, contentType: '社媒图片',
    conclusion: 'BLOCK', issueCount: 3, confidence: 1, summary: '命中 S-1.2 / S-2.1',
    reportUrl: 'https://new.example/doc',
  }, { since: Date.now() - 60_000, question: NEW_Q });
  eq(r.action, 'updated');
  const patch = sent.updated[0].fields;
  eq(patch['Agent 结论'], 'BLOCK', '结论变了 ⇒ 必须改写（不许定格 REVIEW）');
  eq(patch['问题数量'], 3, '问题数量跟着本轮结论走');
  eq(patch['置信度'], 1, '置信度跟着本轮结论走');
  eq(patch['问题分类汇总'], '命中 S-1.2 / S-2.1', '汇总列必须换成本轮那份');
  eq(patch['状态'], '待审',
     '**状态不跟结论走**：PRD §8.2 的三档里机器只拥有「待审」；三态只进 `Agent 结论`');
  // 反向对照：**非**派生列照旧只补空 —— 报告链接只该被写一次（复跑不许把旧链接改掉）
  ok_(!('报告链接' in patch), '报告链接不是派生列：已有值 ⇒ 不许改写（否则复跑会把旧链接换掉）');
  ok_(!('内容 ID' in patch), '内容 ID 照旧只补空');
  // ★★ 2026-10-16（Owner 裁定）这条断言**改了** —— 旧话是「送审问题照旧只补空」。
  //   改的理由（实测）：那一格一旦落脏就**永远改不回来** —— 结论表 200 行里 54 行是
  //   我们自己的内部指令、20 行是 `[图片]` 占位，全都「已有值」⇒ 只补空 = 永远脏着。
  //   Owner 原话：「只留原文，不要写其他话」＋「**直接覆盖送审问题，不要新建**」。
  //   反向对照在下面那一条（**同值不写**：值没变仍不许写）。
  eq(patch['送审问题'], NEW_Q,
     '送审问题已进可改写列：旧格里的脏内容必须能被覆盖（否则这一行无法自愈）');
  for (const k of rp.HUMAN_FIELDS) ok_(!(k in patch), `人填的「${k}」照旧一个字都不许动`);
});

await ta('反向对照·结论派生列**同值不写**：一次「什么都没变」不许记成一次写入', async () => {
  const rows = [{ record_id: 'recSAME', fields: {
    '写入时间': Date.now(), '送审问题': '审一下这张图能过吗？',
    '内容 ID': rp.contentIdOf(IMG_TEXT),
    'Agent 结论': 'REVIEW', '问题数量': 2, '状态': '待审',   // 机器档位；库里已是本轮该写的值
  } }];
  const { sent } = install({ rows });
  const r = await rp.ensureReviewRow({
    contentId: rp.contentIdOf(IMG_TEXT), question: '审一下这张图能过吗？',
    conclusion: 'REVIEW', issueCount: '2', summary: null,   // 注意：条数给字符串 '2'
  }, { since: Date.now() - 60_000, question: '审一下这张图能过吗？' });
  eq(r.action, 'unchanged', `同值（'2' 与 2 也算同值）不许产生写入，实际 ${r.action}`);
  ok_(!sent.updated, '一次 API 都不该发');
});

await ta('★ 「状态」的人设终态受保护：已修改 / 已发布 不许被机器改回「待审」', async () => {
  const rows = [{ record_id: 'recHUMAN', fields: {
    '写入时间': Date.now(), '送审问题': '审一下这张图能过吗？',
    '内容 ID': rp.contentIdOf(IMG_TEXT),
    'Agent 结论': 'REVIEW', '问题数量': 2, '状态': '已发布',   // ← 人已经处理完了
  } }];
  const { sent } = install({ rows });
  const r = await rp.ensureReviewRow({
    contentId: rp.contentIdOf(IMG_TEXT), question: '审一下这张图能过吗？',
    conclusion: 'REVIEW', issueCount: 2,
  }, { since: Date.now() - 60_000, question: '审一下这张图能过吗？' });
  const patch = (sent.updated ?? [])[0]?.fields ?? {};
  ok_(!('状态' in patch), '「已发布」是人的终态 ⇒ 机器再送审一次也不许把它改回「待审」');
  eq(r.action, 'unchanged', '除了状态没别的可写 ⇒ 这一轮不该产生写入');

  // **反向对照**：把库里换成「待审」（机器的档位）⇒ 同一套输入**必须**照旧能写
  //   （否则「保护终态」会顺手把「第一次送审落状态」也挡掉）。
  const rows2 = [{ record_id: 'recWAIT', fields: { ...rows[0].fields, '状态': '待审', '问题数量': 1 } }];
  const inst2 = install({ rows: rows2 });
  const r2 = await rp.ensureReviewRow({
    contentId: rp.contentIdOf(IMG_TEXT), question: '审一下这张图能过吗？',
    conclusion: 'REVIEW', issueCount: 2,
  }, { since: Date.now() - 60_000, question: '审一下这张图能过吗？' });
  eq(r2.action, 'updated', '库里是「待审」时，本轮该写的东西照旧要写');
  ok_(inst2.sent.updated?.length === 1, '反向对照必须真的发生过一次写入');
});

await ta('结论派生列的名单本身受判据守着（漏一个就是一类卡住的行）', () => {
  eq(rp.CONCLUSION_DERIVED_FIELDS.slice().sort(),
     ['Agent 结论', '问题分类汇总', '置信度', '状态', '问题数量'].sort(),
     '这五格必须齐 —— 少一格，那一格就会「写错之后永远改不回来」');
  for (const k of rp.CONCLUSION_DERIVED_FIELDS) {
    ok_(rp.MACHINE_FIELDS.includes(k), `「${k}」必须仍在机器字段里（否则永远补不上）`);
    ok_(!rp.HUMAN_FIELDS.includes(k), `「${k}」不许混进人的格子`);
  }
  for (const k of rp.HUMAN_FIELDS) ok_(!rp.CONCLUSION_DERIVED_FIELDS.includes(k),
    `人的格子「${k}」不许被列进可改写名单`);
});

await ta('链那一行**人填过**的格子：一个字节都不许动', async () => {
  const rows = [{ record_id: 'recHUMAN', fields: {
    '写入时间': Date.now(), '送审问题': '审一下这张图能过吗？',
    '人工复核人': [{ id: 'ou_whoever', name: 'Owner' }], '复核结论': '看过了，不能发',
    'Agent 结论': 'BLOCK' } }];
  const { sent } = install({ rows });
  const r = await rp.ensureReviewRow({
    contentId: rp.contentIdOf(IMG_TEXT), question: '审一下这张图能过吗？',
    conclusion: 'BLOCK', issueCount: 1, summary: 's',
  }, { since: Date.now() - 60_000, question: '审一下这张图能过吗？' });
  eq(r.action, 'updated');
  const patch = sent.updated[0].fields;
  ok_(!('人工复核人' in patch) && !('复核结论' in patch),
    '人填过的格子被写进去了 —— 补写只许补机器那一侧的空格');
});

await ta('反向对照·同一窗口里是**别人的**那一行 → 不许去补它，要自己新建', async () => {
  const rows = [{ record_id: 'recOTHER', fields: {
    '写入时间': Date.now(), '送审问题': '这段 listing 文案能不能发？', 'Agent 结论': 'REVIEW' } }];
  const { c } = install({ rows });
  const r = await rp.ensureReviewRow({
    contentId: 'AUTO-nomatch', question: '审一下这张图能过吗？',
    conclusion: 'NEEDS_INPUT', issueCount: 0, summary: 's',
  }, { since: Date.now() - 60_000, question: '审一下这张图能过吗？' });
  eq(r.action, 'created', `窗口里那一行不是这一单的，必须自己新建（实际 ${r.action}）`);
  eq(c.hit('appTableRecord.batchUpdate'), 0, '不许改别人的行');
});

/* ★★ 2026-10-22 真单（BM04/BM01 婴儿监视器对比图）：**同一张图两行、两个结论**。
 *   链发布时用它自己算的内容 ID（实测 `AD-20261022-021`），我们这边算的是
 *   `AUTO-<sha(送审文本)>`；送审问题也不同（链写的是它的审核任务，我们写的是原文＋媒材链接）
 *   ⇒ 前两把锁都不中 ⇒ 守衡**新建了第二行**。
 *   后果不是多一行，是**表里同一张图同时挂着 PASS 与 REVIEW**（链行 PASS ／ 守衡行 REVIEW）。
 *   修法：把机读旁挂里的 `content_id` 当**第三把锁**（本次时间窗内、全等）。
 *   变异自证：去掉 `chainCid` 那一段 ⇒ 本组精确变红（会 `created`）。 */
await ta('★ 链自己建过这一行（内容 ID 与我们不同）⇒ 必须补它，不许再建第二行', async () => {
  const rows = [{ record_id: 'recCHAIN', fields: {
    '写入时间': Date.now(),
    '送审问题': '请按图片安全审查 skill 对本次附图执行完整审查。',
    '内容 ID': 'AD-20261022-021',          // ← 链的内容 ID（不是我们的 AUTO-…）
    'Agent 结论': 'PASS', '问题数量': 0, '置信度': 0.93,
    '问题分类汇总': '【审查结论：PASS】未发现已知底线风险…',
  } }];
  const { sent, c } = install({ rows });
  const r = await rp.ensureReviewRow({
    contentId: rp.contentIdOf(IMG_TEXT), question: '[图片](https://example/file/x)',
    contentType: '图片/视频', conclusion: 'REVIEW', issueCount: 0, confidence: 0.93,
    summary: '引擎 PASS 与最终结论 REVIEW 不一致',
  }, { since: Date.now() - 60_000, question: '[图片](https://example/file/x)',
       chainContentId: 'AD-20261022-021' });
  eq(r.action, 'updated', `必须认链那一行（实际 ${r.action}）：${r.detail}`);
  eq(c.hit('appTableRecord.batchCreate'), 0, '**一行都不许新建**（两行 = 两个结论）');
  const patch = sent.updated[0].fields;
  eq(patch['Agent 结论'], 'REVIEW', '结论跟着本轮合并结论走（链行原来记的是引擎 PASS）');
  eq(patch['问题分类汇总'], '引擎 PASS 与最终结论 REVIEW 不一致');
  ok_(!('内容 ID' in patch), '内容 ID 是链算的，不许被我们的 AUTO- 覆盖');

  // 反向对照：不传 chainContentId 时**照旧不认**（防止第三把锁变成「窗口里谁都能认」）
  const rows2 = [{ record_id: 'recCHAIN2', fields: {
    '写入时间': Date.now(), '送审问题': '请按图片安全审查 skill 对本次附图执行完整审查。',
    '内容 ID': 'AD-20261022-099', 'Agent 结论': 'PASS' } }];
  const inst2 = install({ rows: rows2 });
  const r2 = await rp.ensureReviewRow({
    contentId: 'AUTO-nomatch', question: '[图片](https://example/file/y)',
    conclusion: 'REVIEW', issueCount: 0, summary: 's',
  }, { since: Date.now() - 60_000, question: '[图片](https://example/file/y)' });
  eq(r2.action, 'created', '没给链的内容 ID ⇒ 不许去动窗口里那一行');
  eq(inst2.c.hit('appTableRecord.batchUpdate'), 0, '反向对照必须真的没有发生改写');
});

await ta('反向对照·算不出内容 ID 时**照样要写**（这条保证不能被算 ID 绑架）', async () => {
  const { c, sent } = install({ rows: [] });
  const r = await rp.ensureReviewRow({
    contentId: null, question: '（只有问句，素材算不出 ID）', conclusion: 'NEEDS_INPUT',
    summary: '链没跑成 —— 留痕用',
  }, { since: Date.now() - 60_000, question: '（只有问句，素材算不出 ID）' });
  eq(r.action, 'created', '算不出 ID 也必须落表');
  eq(c.hit('appTableRecord.batchCreate'), 1);
  ok_(!('内容 ID' in sent.created[0]), '算不出就不写那一格，不许编一个');
});

await ta('dry-run：一个字节都不许落盘', async () => {
  const { c } = install({ rows: [] });
  const r = await rp.ensureReviewRow({ contentId: 'AUTO-x', question: 'q', conclusion: 'PASS' },
                                     { dryRun: true, since: Date.now() - 1000, question: 'q' });
  eq(r.action, 'created');
  eq(c.hit('appTableRecord.batchCreate'), 0, 'dry-run 不许真建行');
  eq(c.hit('appTableRecord.batchUpdate'), 0, 'dry-run 不许真改行');
});

/* ─────────────────────────── 3. 接线 ─────────────────────────── */
console.log('\n═══ 3. 接线：闸门返回之后**必须**真的去落表 ═══');

t('`agent.mjs` 的闸门里必须**恰好一处**落表调用，且它是**可注入**的', () => {
  const src = fs.readFileSync(new URL('./agent.mjs', import.meta.url), 'utf8')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  const calls = src.match(/await\s+(?:runBeforeDelivery\s*\(\s*\(\)\s*=>\s*)?publishRunner\s*\(/g) ?? [];
  eq(calls.length, 1, `实际 ${calls.length} 处 —— 定义了不调用，就是 §2.4 那条「常量定义了没人用」的老病`);
  eq((src.match(/\bpublishRunner\s*\(/g) ?? []).length, 1, '时限包装不得引入第二次落表调用');
  // ★ 「可注入」本身也是判据：写死成 `reviewPublish.ensureReviewRow(...)` 的话，
  //   单测里一个假结论就会**真的**往 Owner 的表里写一行（2026-10-05 实测发生过）。
  const inj = src.match(/publishRunner\s*=\s*reviewPublish\.ensureReviewRow/g) ?? [];
  ok_(inj.length >= 2, '`publishRunner` 的默认值要在 handleMessage 与 runSubmissionGate 两处都留着（实际 ' + inj.length + ' 处）');
});

// ★ 2026-10-19：这条原来是 `t(...)` **接一个 async 函数** —— 同步harness 立刻记 ✅，
//   而真正的断言在微任务里 reject ⇒ **假绿**（进程赶在 unhandled rejection 被报出来之前
//   `process.exit` 了，所以一直是 ✅）。加一条 `setTimeout` 之后它才浮出来。
//   ⇒ harness 换成 `await ta(...)`；同时把「被拼进任务」的判据改成认**数组字面量**
//   （现形是 `[..., REVIEW_HARD_RULES, REVIEW_PLAYBOOK]`，旧正则只认 `REVIEW_HARD_RULES]`）。
await ta('送审任务里必须带那两条硬规矩（自命中=反面依据 / 必须落表）', async () => {
  const tools = await import('./tools.mjs');
  const r = tools.REVIEW_HARD_RULES;
  ok_(/自命中/.test(r) && /反面依据/.test(r), '缺「自命中是反面依据」那一条');
  ok_(/不许/.test(r) && /拒答/.test(r), '必须明写「不许以自循论证为由拒答」');
  ok_(/每一个评审任务都必须落表/.test(r), '缺「必须落表」那一条');
  ok_(/守衡宿主/.test(r) && /本条消息来源/.test(r) && /评审链不得自行写/.test(r),
    '链只提供审查结果，按来源落表由宿主统一完成');
  // 反向对照：这段文本必须真的被拼进任务里（否则它只是仓库里的一段死字符串）
  const src = fs.readFileSync(new URL('./tools.mjs', import.meta.url), 'utf8');
  const hits = (src.match(/\bREVIEW_HARD_RULES\b/g) ?? []).length;
  ok_(hits >= 2,
    `REVIEW_HARD_RULES 只出现 ${hits} 次（定义处 1 次）⇒ 没有出现在任何拼接里 —— 那就等于没写`);
});

/* ─────────── 3.5 落库正文不许带 markdown 星号（Owner 2026-10-14） ───────────
 * 起因：Owner「所有输出中不允许包含 `**` 星号」—— 而**这张表就是「落库」本身**。
 * 实测（只读盘点真表）：294 行里 **164 行**至少有一格带 `**`：
 *   · `问题分类汇总` —— 那句 `问题数量按 **0** 记` 是**我们自己的代码**拼的（`machineNumbers`）；
 *   · `送审问题` —— 模型/人给的原文。
 * 判据是**行为级**的：真调 `rowFieldsOf()`（它是唯一的拼行函数），看拼出来的字段里有没有星号。
 * 反向对照两条：**不该摘的格不许动**（数字/链接），**不该丢的字一个都不许丢**。
 */
console.log('\n═══ 3.5 落库正文不许带 markdown 星号 ═══');

t('落库字段：文本格摘掉 `**`，数字与链接格一个都不动', () => {
  const f = rp.rowFieldsOf({
    contentId: 'AUTO-test',
    question: '这句 **能不能发** ？',
    contentType: 'text',
    channel: '未指定',
    productLine: '吸奶器',
    version: 'v1',
    conclusion: 'REVIEW',
    confidence: 0,
    issueCount: 1,
    summary: '链已跑完（141s）。\n\n**逐条依据**：问题数量按 **0** 记（引擎未给出该读数）',
    reportUrl: 'https://example.feishu.cn/docx/abc',
  });
  const txt = ['送审问题', '内容类型', '渠道', '产品线', '送审版本', 'Agent 结论', '问题分类汇总']
    .map((k) => f[k]).filter((v) => v !== undefined);
  for (const v of txt) eq(String(v).includes('*'), false, `文本格里还有星号：${String(v).slice(0, 120)}`);
  // ★ 反向对照 A：数字格与链接格不许被「顺手统一」
  eq(f['置信度'], 0, '数字格必须原样是 0');
  eq(f['问题数量'], 1, '数字格必须原样是 1');
  eq(typeof f['报告链接'], 'object', '链接格必须是结构化对象，不是字符串');
  eq(String(f['报告链接'].link).includes('*'), false, '链接里本来就没有星号');
  // ★ 反向对照 B：摘的是符号，不是内容
  eq(String(f['送审问题']), '这句 能不能发 ？', '摘符号不许改别的字');
  ok_(String(f['问题分类汇总']).includes('问题数量按 0 记'), '正文一个都不能丢');
  ok_(String(f['问题分类汇总']).includes('逐条依据'), '`**逐条依据**` 要变成 `逐条依据`，不是被删掉');
});

/* ───────────────── 4b. 两侧合并置信度的**两格豁免**（Owner 2026-10-15）─────────────────
 *
 * 为什么非钉不可：这两格是拿 **80 行真数据**核出来的 ——
 *   · **12 行是 P0 命中**：PRD §6.6 逐字「P0 层级规则**不适用置信度分流**，命中即 BLOCK」
 *     ⇒ 本库口径是 **1.0**。不守这一格 ⇒ 它们会被合并数降成 0.93（"确定性命中"被写成"还有不确定"）。
 *   · **40 行是 `0`**（引擎未做判定）：`0` 在本库有专门语义 =「**没有做出判定**」，不是零风险。
 *     拿模型侧的数去顶它 = 给一个**根本没有结论**的单子配一个"确定性"。
 * ★ 反向对照也在下面：普通单不给合并数时，**不许**变成 0.85（否则这条判据可能只是"所有输入都改"）。
 */
console.log('\n═══ 4b. 两侧合并置信度：P0 与拒答两格豁免 ═══');
t('D1 普通评审单（非 P0、非拒答）⇒ 用两侧合并数', () => {
  const r = rp.machineNumbers({ review: { issue_count: 3, confidence: 0.95 } }, 'REVIEW', MERGED_CONF);
  eq(r.confidence, 0.85, '普通单必须采用两侧合并数');
  ok_(/两侧合并/.test(r.note), '填了合并数就必须同时填口径说明');
});
t('D2 ★ P0 命中 ⇒ **不许**被合并数覆盖（PRD §6.6 不适用分流；Owner 2026-10-16：「模型侧也是 1，最终出 1」）', () => {
  const r = rp.machineNumbers({ p0_fastpath: true, confidence: 1.0 }, 'BLOCK', MERGED_CONF);
  eq(r.confidence, 1, 'P0 命中的置信度是确定性命中（本库口径 1.0），不许降成 0.93/0.85');
  ok_(/不适用置信度分流，命中即 BLOCK，置信度记为 1\.0/.test(r.note),
    '豁免必须**逐字**写明 PRD 那句理由，否则读表的人以为算错了');
  ok_(/不合并模型侧的置信度/.test(r.note),
    '还要写明「不合并模型侧」——Owner 2026-10-16 原话：「置信度就是 1。这时候**不用合并模型侧的置信度**」');
});
t('D3 ★ 拒答/未判 ⇒ **不许**被合并数覆盖（0 = 没有做出判定）', () => {
  const r = rp.machineNumbers({ review: { issue_count: 0, confidence: null } }, 'NEEDS_INPUT', MERGED_CONF);
  eq(r.confidence, 0, '拒答态没有可分流的结果，不许拿模型侧的数去顶');
  ok_(/本次完整审核未形成有效结论/.test(r.note), '0 的含义必须自带解释（不能读成"零风险"）');
});
for (const [label, merged] of [['有合并读数', MERGED_CONF], ['无合并读数', null]]) {
  t(`D3b ${label}：引擎 REVIEW/0.86 被最终闸拒收 ⇒ 最终置信度归 0`, () => {
    // 2026-10-30 真单：引擎确实完成判定，失败的是其后的完整性验收。
    const res = { review: { state: 'REVIEW', issue_count: 1, confidence: 0.86 }, confidence: 0.86 };
    const result = rp.machineNumbers(res, 'NEEDS_INPUT', merged);
    eq(result.confidence, 0, '不能拒答后又回退到库侧的 0.86');
    ok_(/本次完整审核未形成有效结论/.test(result.note), '口径必须解释最终审核未完成');
    ok_(!/引擎未做判定/.test(result.note), '引擎已经 REVIEW，不能把拒答原因说成引擎未判');
    eq(res.review.confidence, 0.86, '原始引擎证据必须保留');
    eq(rp.machineNumbers(res, 'REVIEW', merged).confidence, merged ? 0.85 : 0.86,
      '正常 REVIEW 仍按原有合并/单轨口径输出');
  });
}
t('D4 ★★ 反向对照：普通单**不给**合并数时不许变成 0.85（否则 D1 只是"所有输入都改"）', () => {
  const r = rp.machineNumbers({ review: { issue_count: 3, confidence: 0.95 } }, 'REVIEW');
  eq(r.confidence, 0.95, '不给合并数 ⇒ 必须逐字回落旧口径（向后兼容，老调用点一行不改）');
});
/* ── 4b2. **覆盖缺口不是拒答**（2026-10-15 修；两行真数据逼出来的）────────────────────────
 * 形状：顶层 `state = REVIEW` ＋ **依据侧**记了 `refusal`（`coverage_not_covered`）。
 *   库侧**没给** confidence（拒答分支写 None），模型侧给了 ⇒ `mergedConfidence()` 已经按
 *   「一侧没给就用另一侧」算出合并数。旧判据 `!!rev?.refusal` 把它当"没判定" ⇒ **丢掉合并数写 0**。
 * 实测两行（同一批 10 行）：
 *   · `MC-US-YT-RLF9-789hh8-WEN`：打印 置信度(两侧合并)=0.85 [confirm]（库侧 — / 模型侧 confirm）⇒ 表里 0
 *   · `MC-US-YT-_xyLF4_AgAw`   ：打印 置信度(两侧合并)=0.93 [direct]（库侧 — / 模型侧 direct）   ⇒ 表里 0
 * 与 `dual_track.mjs::kbSideOf` 的 2026-10-07 口径一致：**判拒答只认顶层 `state`**。
 * ★ 变异自证：把 `review_publish.mjs` 的 `refused` 改回 `state === 'NEEDS_INPUT' || !!rev?.refusal`
 *   ⇒ **D7 精确变红**（合并数被丢掉、写成 0）；D7b 守着另一头（真拒答不许被顶掉）。 */
t('D7 ★ 覆盖缺口（顶层 REVIEW ＋ refusal 有值）⇒ 必须用两侧合并数，不是 0', () => {
  const res = { review: { issue_count: 6, confidence: null,
    refusal: { state: 'NEEDS_INPUT', reason_code: 'coverage_not_covered' } } };
  const r = rp.machineNumbers(res, 'REVIEW', { ...MERGED_CONF, kb_band: null, value: 0.85 });
  eq(r.confidence, 0.85, '库侧没给置信度、模型侧给了 ⇒ 用合并数（Owner：两侧汇总成一个输出）');
  ok_(/coverage_not_covered/.test(r.note), '覆盖缺口是**原因码**，要如实写进口径说明');
  ok_(/不算拒答/.test(r.note), '必须写明「顶层不是拒答 ⇒ 合并数照用」，否则读表的人以为漏了覆盖缺口');
});
t('D7b ★★ 反向对照：**真拒答**（顶层 NEEDS_INPUT）＋ refusal ⇒ 仍然不许被合并数顶掉', () => {
  const res = { review: { issue_count: 0, confidence: null,
    refusal: { state: 'NEEDS_INPUT', reason_code: 'claim_busy' } } };
  const r = rp.machineNumbers(res, 'NEEDS_INPUT', MERGED_CONF);
  eq(r.confidence, 0, '顶层就是拒答 ⇒ 0（没有可分流的结果），不许拿模型侧的数去顶');
});

/* ── 4c. 「这个数未标定」必须**写在产出它的地方**（Owner 2026-10-15 裁 ①）───────────────
 * 为什么非钉不可：那张表是**机器逐行重写**的（批跑器把结论表的汇总整格抄进采集表，
 *   实测 2026-10-15 一小时重写 28 行）⇒ 表里手改一句标注会被下一次回填**抹掉**。
 *   写在代码里，才每行、每轮都自带。
 * 变异自证：把 `CONF_UNCALIBRATED` 从两处注记里删掉 ⇒ **D1b / D5 精确变红**。
 */
console.log('\n═══ 4c. 置信度「未标定」声明（不得用作分流依据）═══');
t('D1b 用了两侧合并数 ⇒ 注记必须带「未标定 / 不得用作分流依据」', () => {
  const r = rp.machineNumbers({ review: { issue_count: 3, confidence: 0.95 } }, 'REVIEW', MERGED_CONF);
  ok_(/未标定/.test(r.note), '标定结论必须跟着数走，否则读表的人以为这个数很硬');
  ok_(/不得用作分流依据/.test(r.note), '★ 这句是 Owner 裁定的口径，不许省');
});
t('D5 库侧单轨（无合并数、引擎给了数）⇒ **也要**带这句，不许出现"裸数"', () => {
  const r = rp.machineNumbers({ review: { issue_count: 3, confidence: 0.95 } }, 'REVIEW');
  eq(r.confidence, 0.95, '值照旧回落（与 D4 同一条）');
  ok_(/未标定/.test(r.note) && /不得用作分流依据/.test(r.note), '库侧单轨那个数同样没标定 ⇒ 必须自带声明');
});
t('D5b 反向对照：P0 / 拒答两格**不许**被套上这句（它们不是两侧合并数，另有 PRD 口径）', () => {
  const p0 = rp.machineNumbers({ p0_fastpath: true, confidence: 1.0 }, 'BLOCK', MERGED_CONF);
  ok_(!/未标定/.test(p0.note), 'P0 的 1.0 是 PRD §6.6 明文口径，不是"未标定的合并数"');
  const rf = rp.machineNumbers({ review: { issue_count: 0, confidence: null } }, 'NEEDS_INPUT', MERGED_CONF);
  ok_(!/未标定/.test(rf.note), '拒答的 0 有专门语义（没有做出判定），别混进这句');
});

/* ── 4d. F1：`Number(null) === 0` —— 「**没有**合并数」不许被当成「置信度 0」（2026-10-15）─────
 * 来由：F1 让 `mergedConfidence` 在**库侧没有读数**时返回 `value: null`（不出这个数）。
 *   而旧写法 `Number(mergedConf?.value)` 把 null 变成 **0**、`Number.isFinite(0)` 为真
 *   ⇒ 表里落一个 0、注记却写「档位 —」。这是本库栽过的同一类陷阱（见 `bandOf` 的注释），
 *   换了个变量名又长了一次。
 * 变异自证：把守卫退回 `Number(mergedConf?.value)` ⇒ D6 **精确变红**（落 0 且带"两侧合并"注记）。
 */
console.log('\n═══ 4d. F1：没有合并数 ≠ 置信度 0 ═══');
const NO_READING = Object.freeze({ value: null, band: null, kb_band: null, model_band: 'direct',
  basis: '库侧没有置信度读数（拒答/覆盖缺口/未测）⇒ 不出这个数；模型侧单轨不构成置信度' });
t('D6 ★ 合并数是 null（库侧没读数）⇒ 不许落 0＋「两侧合并」注记，必须走"没有读数"那条', () => {
  const r = rp.machineNumbers({ review: { issue_count: 0, confidence: null } }, 'REVIEW', NO_READING);
  eq(r.confidence, 0, '没有可用的数 ⇒ 按本库口径记 0（0 = 没有做出判定）');
  ok_(!/两侧合并 · 档位/.test(r.note), '★ 没有数就不许出现"档位 —"那种自相矛盾的注记');
  ok_(/置信度按 \*\*0\*\* 记/.test(r.note), '0 必须自带解释，否则会被读成"零风险"');
});
t('D6b 反向对照：合并数缺失、但**引擎给了数** ⇒ 照旧用引擎那个数（守卫不许一刀切）', () => {
  const r = rp.machineNumbers({ review: { issue_count: 3, confidence: 0.95 } }, 'REVIEW', NO_READING);
  eq(r.confidence, 0.95, '引擎有读数时照旧回落，不许因为合并数缺失就把 0.95 抹成 0');
  ok_(!/两侧合并 · 档位/.test(r.note), '没用合并数就不许写"两侧合并"');
  ok_(/不得用作分流依据/.test(r.note), '回落出来的数同样未标定 ⇒ 仍要自带声明');
});

/* ── 4e. 报告云文档「可见范围跟随飞书云文档」（Owner 2026-10-16）─────────────────
 * Owner 原话：「所有上审查报告，有飞书云文档阅读权限的，都必须可以打开，**权限跟随飞书云文档**」。
 * 病灶（实测）：报告建完不碰权限 ⇒ 76/76 份 `link_share_entity=closed` ⇒ 业务侧点开必 Access Denied。
 * ★ 变异自证：把 `ensureTenantReadable` 里的回读确认删掉（或把目标值改回 closed）⇒ **E1b/E1c 精确变红**。 */
console.log('\n═══ 4e. 报告云文档设为「组织内可阅读」（含回读确认）═══');
const _fakeRun = (patchThrows, readback) => async (_bin, args) => {
  if (args.includes('permission.public')) {
    if (patchThrows) throw Object.assign(new Error('cli failed'), { stderr: 'permission denied (99991672)' });
    return { stdout: '{"ok":true}' };
  }
  if (args.includes('+permission-get-setting')) {
    return { stdout: JSON.stringify({ ok: true, data: { permission_public: { link_share_entity: readback } } }) };
  }
  return { stdout: '{}' };
};
await ta('E1 正常路径：patch 成功且回读 = tenant_readable ⇒ ok', async () => {
  const r = await rp.ensureTenantReadable('DoccTokenX', { run: _fakeRun(false, 'tenant_readable') });
  eq(r.ok, true, '两者的组合必须判成立');
  ok_(/tenant_readable/.test(r.detail), 'detail 要写清可见范围');
});
await ta('E1b ★ 回读不是 tenant_readable（接口成功≠数据落下来）⇒ 必须判失败', async () => {
  const r = await rp.ensureTenantReadable('DoccTokenX', { run: _fakeRun(false, 'closed') });
  eq(r.ok, false, '回读还是 closed ⇒ 不许当成功');
  ok_(/链接不写进表/.test(r.detail), '要给"链接不写进表"的结论');
});
await ta('E1c ★ patch 抛错 ⇒ 必须判失败并把 CLI 原话带出来', async () => {
  const r = await rp.ensureTenantReadable('DoccTokenX', { run: _fakeRun(true, 'tenant_readable') });
  eq(r.ok, false, 'patch 失败不许当成功');
  ok_(/permission denied|99991672/.test(r.detail), '要把 CLI 的原话带出来（排查成本不许转给人）');
});
await ta('E1d 没给 document_id ⇒ 失败（不许静默跳过权限）', async () => {
  const r = await rp.ensureTenantReadable('', { run: _fakeRun(false, 'tenant_readable') });
  eq(r.ok, false, '没 token 就没法设权限 ⇒ 必须失败');
});

/* ── 4f. 投递**偶发失败要补一次**（Owner 2026-10-19：「输出的报告模版怎么改了？」）────
 * 病灶（真单，17:22 那一单）：合并报告（**原模版**）投递偶发失败 —— 报错全文只有
 *   `Command failed: <命令>`（`stderr` 空、也没带 killed/signal）⇒ 卡上链接**回落成库侧
 *   P0 那份**（另一套模版、只装 1 条，卡上说 6 条）⇒ 人点开发现「报告模版变了」。
 *   ⇒ 偶发（超时/被杀/两路都没吐字/网络类）**补一次**；确定性（CLI 判校验不过）**不许**补。
 * ★ 变异自证：把 `_transientFailureOf` 改成恒 `false`（永不重试）⇒ **F1/F1c 精确变红**；
 *   改成恒 `true`（连确定性错也重试）⇒ **F1b 精确变红**；把次数写死 1 ⇒ **F1 精确变红**。 */
console.log('\n═══ 4f. 投递偶发失败要补一次（不许把模版换掉）═══');

const MD_TMP = path.join(os.tmpdir(), `rp-pub-${process.pid}.md`);
fs.writeFileSync(MD_TMP, '# 内容审查报告\n\n【审查结论：BLOCK】\n', 'utf8');

/** 桩：`docs +create` 按剧本回放；权限两步永远成功（被测的不是它）。 */
const stubCreate = (script) => {
  const calls = { create: 0 };
  const run = async (_bin, args) => {
    if (args.includes('+create')) {
      const step = script[calls.create] ?? { ok: true };
      calls.create += 1;
      if (step.throws) {
        throw Object.assign(new Error('Command failed: lark-cli docs +create'),
          { stderr: step.stderr, stdout: step.stdout, killed: !!step.killed, signal: step.signal });
      }
      return { stdout: JSON.stringify({ ok: true, data: { document: {
        document_id: `DocRetry${calls.create}`,
        url: `https://example.invalid/docx/DocRetry${calls.create}` } } }) };
    }
    if (args.includes('+permission-get-setting')) {
      return { stdout: JSON.stringify({ data: { permission_public: { link_share_entity: 'tenant_readable' } } }) };
    }
    return { stdout: '{"ok":true}' };
  };
  return { run, calls };
};

await ta('F1 ★ 第 1 次偶发失败（stderr 空）⇒ 补第 2 次成 ⇒ 拿到**原模版**那份的链接', async () => {
  const { run, calls } = stubCreate([{ throws: true, stderr: '' }, { ok: true }]);
  const r = await rp.publishReportDoc(MD_TMP, { run });
  eq(r.ok, true, '补一次就该成');
  eq(calls.create, 2, '必须真的补了第 2 次');
  ok_(/DocRetry2/.test(r.url), '链接要是**第 2 次**建出来的那份');
  ok_(/补第 2 次才成/.test(r.detail), 'detail 要写清「这次是补出来的」，不许假装一次就成');
});
await ta('F1b ★ 反向对照：确定性失败（CLI 判校验不过）⇒ **不许**补第二次', async () => {
  const { run, calls } = stubCreate([
    { throws: true, stderr: '{"ok":false,"error":{"type":"validation","message":"invalid <img>"}}' },
  ]);
  const r = await rp.publishReportDoc(MD_TMP, { run });
  eq(r.ok, false, '确定性错不许当成功');
  eq(calls.create, 1, '重试对确定性错没有意义 ⇒ 只许调 1 次（否则把「报告 ≤30s」拖成两倍）');
  ok_(/invalid <img>/.test(r.detail), '要把 CLI 的原话带出来');
});
await ta('F1c 两次都偶发失败 ⇒ 判失败，且把**超时/被杀**写进 detail', async () => {
  const { run, calls } = stubCreate([
    { throws: true, stderr: '', killed: true, signal: 'SIGTERM' },
    { throws: true, stderr: '', killed: true, signal: 'SIGTERM' },
  ]);
  const r = await rp.publishReportDoc(MD_TMP, { run });
  eq(r.ok, false, '两次都失败 ⇒ 判失败（回落谁由调用方决定）');
  eq(calls.create, 2, '默认补一次 ⇒ 共 2 次');
  ok_(/超时\/被杀/.test(r.detail) && /signal=SIGTERM/.test(r.detail),
    'detail 必须能区分「超时/被杀」与「命令写错」—— 17:23 那条就是**什么都没写**才查不出来');
});
await ta('F1d `SHOUHENG_P0_DOC_ATTEMPTS=1` ⇒ 不补（紧急回滚口子）', async () => {
  const old = process.env.SHOUHENG_P0_DOC_ATTEMPTS;
  process.env.SHOUHENG_P0_DOC_ATTEMPTS = '1';
  try {
    const { run, calls } = stubCreate([{ throws: true, stderr: '' }, { ok: true }]);
    const r = await rp.publishReportDoc(MD_TMP, { run });
    eq(r.ok, false, '只准一次 ⇒ 这次失败就是失败');
    eq(calls.create, 1, '不许偷偷补');
  } finally {
    if (old === undefined) delete process.env.SHOUHENG_P0_DOC_ATTEMPTS;
    else process.env.SHOUHENG_P0_DOC_ATTEMPTS = old;
  }
});

/* ── 4g. 「回读验不成」≠「没建成」：不许因此换掉报告模版（Owner 2026-10-20）────
 * Owner 原话：「守衡输出的报告模版又乱了，怎么一会一个样子，到底是谁在改模版？」
 *   「**必须按照我要求的报告模版输出**」。
 *
 * 真单（18:59，4 条 REVIEW）：`docs +create` **成功**（云文档 `I3NHdh…` 已建、正文齐全），
 *   失败的是**回读权限**这一步 —— 报错全文只有 `Command failed: … drive +permission-get-setting`
 *   （stderr 空、无 killed/signal）。旧版把这类当"确定性失败"⇒ **一次都不补** ⇒ `url:null`
 *   ⇒ 调用方回落成库侧那份（`feishu_publish.py` 的「问题分类汇总/完整清单」版式）
 *   ⇒ 人点开看到的报告**换了模版**。
 *   复核：事后重跑同一条命令读到的就是 `tenant_readable` —— 权限早设上了，坏的只是那次**读**。
 *
 * ★ 变异自证（这条判据必须咬得住）：
 *   · 把 `publishReportDocOnce` 里 `unverified` 那一支删掉（回到 `ok:false`）⇒ **G1 精确变红**；
 *   · 把 `mismatch` 也放行成 `ok:true` ⇒ **G2 精确变红**（读得出来就是不达标，给链接＝给一个点不开的）；
 *   · 把 `ensureTenantReadable` 的轮数写死 1 ⇒ **G1 的红读次数断言变红**。
 */
console.log('\n═══ 4g. 回读验不成 ≠ 没建成（不许换报告模版）═══');
process.env.SHOUHENG_PERM_BACKOFF_MS = '0';        // 自证不睡觉

/** 桩：`docs +create` 永远成；patch 可设成败；回读按剧本回放（默认每轮都抛）。 */
const stubPerm = ({ readback = [], patchThrows = null } = {}) => {
  const calls = { create: 0, patch: 0, read: 0 };
  const run = async (_bin, args) => {
    if (args.includes('+create')) {
      calls.create += 1;
      return { stdout: JSON.stringify({ ok: true, data: { document: {
        document_id: `DocPerm${calls.create}`,
        url: `https://example.invalid/docx/DocPerm${calls.create}` } } }) };
    }
    if (args.includes('permission.public')) {
      calls.patch += 1;
      if (patchThrows) {
        throw Object.assign(new Error('Command failed: lark-cli drive permission.public patch'),
          { stderr: patchThrows });
      }
      return { stdout: '{"ok":true}' };
    }
    if (args.includes('+permission-get-setting')) {
      const step = readback[Math.min(calls.read, Math.max(0, readback.length - 1))] ?? { throws: true, stderr: '' };
      calls.read += 1;
      if (step.throws) {
        throw Object.assign(new Error('Command failed: lark-cli drive +permission-get-setting'),
          { stderr: step.stderr ?? '' });
      }
      return { stdout: JSON.stringify({ data: { permission_public: { link_share_entity: step.value ?? '' } } }) };
    }
    return { stdout: '{}' };
  };
  return { run, calls };
};

await ta('G1 ★ 回读每轮都抛（stderr 空）⇒ 仍用**自己那份**、且如实标「权限未核验」', async () => {
  const { run, calls } = stubPerm({ readback: [{ throws: true, stderr: '' }] });
  const r = await rp.publishReportDoc(MD_TMP, { run });
  eq(r.ok, true, '「验不成」不等于「没建成」—— 判失败就会把模版换成库侧那套（18:59 那一单）');
  ok_(/DocPerm1/.test(r.url), '要交回**自己这份**文档的链接，不许换产者');
  eq(r.share, 'unverified', '必须如实标「权限未核验」，不许假装已核验');
  ok_(/权限未核验/.test(r.detail), 'detail 要写清未核验，人看日志别被糊过去');
  eq(calls.read, 3, '回读必须先补到 3 轮才收尾（默认次数；写死 1 ⇒ 这条精确变红）');
  eq(calls.create, 1, '不许为了绕过回读失败去**再建一份**（那会多出孤儿文档）');
});
await ta('G1b 回读第 1 次抛、第 2 次成 ⇒ 正常成立，且 detail 写明是补出来的', async () => {
  const { run, calls } = stubPerm({ readback: [{ throws: true, stderr: '' }, { value: 'tenant_readable' }] });
  const r = await rp.publishReportDoc(MD_TMP, { run });
  eq(r.ok, true, '补一次就该成');
  eq(r.share, undefined, '补成了就不该再带「未核验」');
  eq(calls.read, 2, '补一次就读到了 ⇒ 收手');
  ok_(/补第 2 轮才读到/.test(r.detail), 'detail 要说清这次是补出来的');
});
await ta('G2 ★ 反向对照：回读**读得出来就是不达标**（closed）⇒ 必须判失败、不给链接', async () => {
  const { run, calls } = stubPerm({ readback: [{ value: 'closed' }] });
  const r = await rp.publishReportDoc(MD_TMP, { run });
  eq(r.ok, false, '读得出来就是不达标 ⇒ 给链接等于给一个点不开的东西');
  eq(r.url, null, '不许编链接');
  ok_(/链接不写进表/.test(r.detail), '要给出「链接不写进表」的结论');
  eq(calls.read, 3, '这种也补满 3 轮（权限设置可能只是没落地）');
});
await ta('G3 ★ 反向对照：patch 确定性失败（99991672）⇒ 判失败，且**不重试**', async () => {
  const { run, calls } = stubPerm({ readback: [{ value: 'tenant_readable' }], patchThrows: 'permission denied (99991672)' });
  const r = await rp.publishReportDoc(MD_TMP, { run });
  eq(r.ok, false, '设置都没成 ⇒ 不许当成功（更不许拿"验不成"那一支放行）');
  eq(calls.patch, 1, '99991672 = 资源/scope 没开，补一百次也一样 ⇒ 只许试 1 次');
  ok_(/99991672|permission denied/.test(r.detail), '把 CLI 原话带出来（区分缺资源权限 / 缺 scope）');
});
await ta('G4 `SHOUHENG_PERM_ATTEMPTS=1` ⇒ 不补（紧急回滚口子），但**仍不换模版**', async () => {
  const old = process.env.SHOUHENG_PERM_ATTEMPTS;
  process.env.SHOUHENG_PERM_ATTEMPTS = '1';
  try {
    const { run, calls } = stubPerm({ readback: [{ throws: true, stderr: '' }] });
    const r = await rp.publishReportDoc(MD_TMP, { run });
    eq(calls.read, 1, '回滚口子生效 ⇒ 只回读 1 次');
    eq(r.ok, true, '但「不补」不等于「换模版」—— 照旧交回自己那份');
    eq(r.share, 'unverified', '照旧标未核验');
  } finally {
    if (old === undefined) delete process.env.SHOUHENG_PERM_ATTEMPTS;
    else process.env.SHOUHENG_PERM_ATTEMPTS = old;
  }
});

/* ─────────────────────────── 5. 自证自身无副作用 ─────────────────────────── */
console.log('\n═══ 5. 自证自身不许有副作用 ═══');
t('C1 真留痕文件在这次运行前后**没被动过**', () => {
  eq(realStat(), REAL_BEFORE, '自证写了真台账 —— 那等于跑一次自证就改掉了它要保护的东西（§2.4.4）');
});

try { fs.rmSync(TMP, { force: true }); } catch { /* 收尾失败不影响结论 */ }

console.log(`\n═══ 合计：通过 ${nPass} / 失败 ${fails.length} ═══`);
if (fails.length) { console.log('失败明细：'); for (const f of fails) console.log('  ·', f); }
process.exit(fails.length ? 1 : 0);

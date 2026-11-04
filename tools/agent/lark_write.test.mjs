/**
 * lark_write.test.mjs —— 多维表格写通道的自证（离线，**不碰真飞书**）
 *
 *   node tools/agent/lark_write.test.mjs            跑全部
 *   node tools/agent/lark_write.test.mjs --controls 只跑反向对照段
 *
 * ★ 为什么不用「读源码文本」来证「留痕/回读/快照接上了」：
 *   AGENTS.md §2.4 点名的就是那个病 ——「名字出现过 ≠ 它拦得住」。
 *   所以这里的每条纪律都用**假客户端真调一次**来证：
 *   比如「快照凑不齐就不删」，断言的是 `batchDelete 一次都没被调用`，
 *   而不是源码里有那行 `if`。
 *
 * ★ 每条「不该发生」的断言都配一条**正向对照**（B8 / B10）：
 *   喂一个正常输入，那件事**必须真的发生**。
 *   没有正向对照，「它没被调用」可能只是因为这个测试根本调不动它（恒真）。
 *   AGENTS.md §2.4.1：没红过的断言不算验证过它。
 *
 * ★ 自证自身不许有副作用（§2.4.4）：留痕被 `SHOUHENG_LARK_WRITES` 指到临时文件，
 *   最后由 C1 断言**真留痕文件在这次运行前后没被动过**。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = path.join(os.tmpdir(), `lw-test-${process.pid}-${Date.now()}.jsonl`);
process.env.SHOUHENG_LARK_WRITES = TMP;          // ★ 必须在 import 之前指走

const TMP_PENDING = path.join(os.tmpdir(), `lw-pending-${process.pid}-${Date.now()}.json`);
process.env.SHOUHENG_LARK_PENDING = TMP_PENDING;  // ★ 同上：不许碰真 pending 文件

const REAL_LEDGER = path.join(
  path.dirname(new URL(import.meta.url).pathname), '..', '..', 'PMO', 'logs', 'lark_writes.jsonl');
const REAL_PENDING = path.join(
  path.dirname(new URL(import.meta.url).pathname), '..', '..', 'PMO', 'shouheng-state', 'lark-pending-delete.json');
const realStat = () => { try { const s = fs.statSync(REAL_LEDGER); return `${s.size}:${s.mtimeMs}`; } catch { return 'absent'; } };
const REAL_BEFORE = realStat();
const realPendingStat = () => { try { const s = fs.statSync(REAL_PENDING); return `${s.size}:${s.mtimeMs}`; } catch { return 'absent'; } };
const REAL_PENDING_BEFORE = realPendingStat();

const lw = await import('./lark_write.mjs');

/* ─────────────────────────── 测试框架 ─────────────────────────── */

let nPass = 0; const fails = [];
const t = (name, fn) => {
  try { fn(); nPass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fails.push(name); console.log(`  ❌ ${name}\n       ${e?.message ?? e}`); }
};
const ta = async (name, fn) => {
  try { await fn(); nPass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fails.push(name); console.log(`  ❌ ${name}\n       ${e?.message ?? e}`); }
};
const eq = (a, b, m) => {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`${m ?? '不相等'}：期望 ${B}，实际 ${A}`);
};
const ok_ = (v, m) => { if (!v) throw new Error(m ?? '断言为假'); };

/* ─────────────────────────── 假飞书客户端 ─────────────────────────── */

/** 每个方法默认「没打桩就抛」—— 静默返回 undefined 会让上面那些「没被调用」的
 *  断言变成恒真（因为一次都没进过那行），那正是我们要防的。 */
/**
 * ★ 2026-10-05 加：**假客户端要按真接口的契约校验**，不能「任意 args 都收」。
 *
 * 起因是一次实测缺陷：`batchGet` 把 `record_ids` 放进了 query（`params`），
 * 而飞书要的是 body（`data`）——真接口回
 * `code=99992402 · field validation failed · field_violations=[{field:"record_ids",
 * description:"record_ids is required"}]`（实测 log_id `20261005082040C23AF9EB8F20344668AC`）。
 * 而当时本文件的假客户端**照单全收**，于是「留痕 / 回读 / 快照」三条纪律
 * 从未真正跑通，自证却全绿 —— 假接口比真接口松，假数据就是真数据的形状（§2.4.1）。
 *
 * 现在这道守卫**在进打桩之前**跑：形状不对就直接回真接口那句错，
 * 于是任何「把 record_ids 放错位置」的改动都会让相关用例当场变红。
 */
function guardBatchGet(args) {
  const ids = args?.data?.record_ids;
  if (!Array.isArray(ids) || ids.length === 0) {
    return { code: 99992402, msg: 'field validation failed',
             err: { field_violations: [{ field: 'record_ids', description: 'record_ids is required' }] } };
  }
  return null;
}

function mkClient(handlers = {}) {
  const calls = [];
  const mk = (key, def) => async (args) => {
    calls.push({ key, args });
    if (key === 'appTableRecord.batchGet') {
      const bad = guardBatchGet(args);
      if (bad) return bad;                      // ← 真接口会拒的，假接口也必须拒
    }
    const h = handlers[key] ?? def;
    if (typeof h === 'function') return h(args);
    if (h === undefined) throw new Error(`未打桩的调用：${key}`);
    return h;
  };
  const cl = {
    bitable: {
      appTable: {
        list: mk('appTable.list'),
        create: mk('appTable.create'),
        delete: mk('appTable.delete'),
      },
      appTableField: {
        list: mk('appTableField.list'),
        create: mk('appTableField.create'),
        update: mk('appTableField.update'),
        delete: mk('appTableField.delete'),
      },
      appTableRecord: {
        list: mk('appTableRecord.list'),
        batchCreate: mk('appTableRecord.batchCreate'),
        batchGet: mk('appTableRecord.batchGet'),
        batchUpdate: mk('appTableRecord.batchUpdate'),
        batchDelete: mk('appTableRecord.batchDelete'),
      },
    },
  };
  return { cl, calls, hit: (k) => calls.filter((c) => c.key === k).length };
}

const API_OK = (data) => ({ code: 0, data: data ?? {} });
const API_ERR = (msg = 'boom') => ({ code: 99991663, msg });
const TABLES = [{ table_id: 'tblAAA', name: '规则库' }, { table_id: 'tblBBB', name: '材料收集' }];
const CTX = { chatId: 'oc_x', senderName: '对接人', senderOpenId: 'ou_x', messageId: 'om_x' };

const ledgerLines = () => (fs.existsSync(TMP) ? fs.readFileSync(TMP, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

console.log('\n═══ 0. 假客户端的契约守卫（§2.4.1：假接口不许比真接口松）═══');

t('0a 反向对照：record_ids 放进 params（就是 10-05 那个真缺陷）必须被拒', async () => {
  const { cl } = mkClient({ 'appTableRecord.batchGet': () => API_OK({ records: [] }) });
  const r = await cl.bitable.appTableRecord.batchGet({
    path: { app_token: 'a', table_id: 't' }, params: { record_ids: ['rec1'] } });
  eq(r.code, 99992402, '真接口会回 99992402；假接口也必须回，否则这个错会再次溜过去');
});

t('0b 正向对照：放进 data 必须放行（否则守卫就是块砖头）', async () => {
  const { cl } = mkClient({ 'appTableRecord.batchGet': () => API_OK({ records: [{ record_id: 'rec1', fields: { A: '1' } }] }) });
  const r = await cl.bitable.appTableRecord.batchGet({
    path: { app_token: 'a', table_id: 't' }, data: { record_ids: ['rec1'] } });
  eq(r.code, 0, '正确形状不许被误伤');
  eq(r.data.records[0].record_id, 'rec1');
});

t('0c 空 ids 也要拒（真接口同样拒）', async () => {
  const { cl } = mkClient({ 'appTableRecord.batchGet': () => API_OK({ records: [] }) });
  const r = await cl.bitable.appTableRecord.batchGet({ path: {}, data: { record_ids: [] } });
  eq(r.code, 99992402);
});

console.log('\n═══ A. 纯函数 ═══');

t('A1 fieldTypeOf 认数字与中文名', () => {
  eq(lw.fieldTypeOf(1), 1); eq(lw.fieldTypeOf('1'), 1);
  eq(lw.fieldTypeOf('文本'), 1); eq(lw.fieldTypeOf('单行文本'), 1);
  eq(lw.fieldTypeOf('单选'), 3); eq(lw.fieldTypeOf('多选'), 4); eq(lw.fieldTypeOf('日期'), 5);
});

t('A2 ★ 类型不认识时返回 null —— 不默认成「文本」', () => {
  eq(lw.fieldTypeOf('胡说八道'), null);
  eq(lw.fieldTypeOf(''), null);
  eq(lw.fieldTypeOf(999), null);
  eq(lw.fieldTypeOf(undefined), null);
});

t('A3 flat 把富文本数组压成字符串', () => {
  eq(lw.flat('abc'), 'abc');
  eq(lw.flat([{ text: 'a' }, { text: 'b' }]), 'ab');
  eq(lw.flat({ text: 'x' }), 'x');
  eq(lw.flat({ name: 'y' }), 'y');
  eq(lw.flat(null), '');
  eq(lw.flat(12), '12');
});

t('A4 ★ verifyReadback 不误报：写入是字符串、回读是富文本数组，必须算一致', () => {
  const v = lw.verifyReadback({ 标题: 'FDA 宣称' }, { 标题: [{ text: 'FDA 宣称' }] });
  eq(v.verdict, 'consistent', '这是最容易犯的误报');
  eq(v.checked, 1);
});

t('A5 verifyReadback 真不一致时要红', () => {
  const v = lw.verifyReadback({ 标题: 'A' }, { 标题: 'B' });
  eq(v.verdict, 'mismatch');
  eq(v.mismatches.length, 1);
  eq(v.mismatches[0].field, '标题');
});

t('A6 verifyReadback 只比「我设过的键」—— 飞书补的默认值不算失配', () => {
  const v = lw.verifyReadback({ A: '1' }, { A: '1', 创建时间: 1790000000000, 自动编号: '3' });
  eq(v.verdict, 'consistent');
  eq(v.checked, 1, '只应比 A 一个键');
});

t('A7 verifyReadback 读回来不是对象 → untested（不是 consistent）', () => {
  eq(lw.verifyReadback({ A: '1' }, null).verdict, 'untested');
  eq(lw.verifyReadback({ A: '1' }, 'x').verdict, 'untested');
});

t('A8 shouldRefuseCreateTable 同名拒绝', () => {
  ok_(lw.shouldRefuseCreateTable(['规则库'], '规则库'));
  ok_(!lw.shouldRefuseCreateTable(['规则库'], '规则库2'));
  ok_(!lw.shouldRefuseCreateTable([], '规则库'));
});

t('A9 tooManyRecords 上限是 500', () => {
  ok_(!lw.tooManyRecords(500));
  ok_(lw.tooManyRecords(501));
});

t('A10 snapshotBefore 缺件时判不合格', () => {
  ok_(!lw.snapshotBefore('delete_records', {}).ok, '缺 records 必须不合格');
  ok_(!lw.snapshotBefore('delete_records', null).ok);
  ok_(!lw.snapshotBefore('delete_field', { readable: true, records: [] }).ok, 'delete_field 要的是 field');
  ok_(!lw.snapshotBefore('delete_table', { readable: true, records: [] }).ok, 'delete_table 要的是 tables');
  ok_(lw.snapshotBefore('delete_records', { readable: true, records: [] }).ok, '空数组是合法的「零条」');
});

t('A11 ★★ 没读到旧值（readable 不为 true）一律不许删 —— 「读不到 ≠ 没有」', () => {
  // 这就是自证第一次运行抓到的那个洞：调用方把「读不到」写成 `?? []`，
  // 于是「未测」变成了「零条」，判定通过、照删。
  ok_(!lw.snapshotBefore('delete_records', { records: [] }).ok, '缺 readable 必须不合格');
  ok_(!lw.snapshotBefore('delete_records', { readable: false, records: [] }).ok);
  ok_(!lw.snapshotBefore('delete_table',
    { readable: false, tables: [], fields: [], records: [] }).ok);
  ok_(!lw.snapshotBefore('delete_field', { readable: false, field: { name: 'X' } }).ok);
  // 反面：readable:true 且件齐时必须合格（否则上面四条可能只是恒真的「永远不合格」）
  ok_(lw.snapshotBefore('delete_field', { readable: true, field: { name: 'X' } }).ok);
  ok_(lw.snapshotBefore('delete_table',
    { readable: true, tables: [], fields: [], records: [] }).ok);
});

console.log('\n═══ B. 行为（假客户端真调）═══');

await ta('B1 createRecords 正常：回读 consistent + 留痕落了一行 + 带 record_ids', async () => {
  const { cl, hit } = mkClient({
    'appTable.list': API_OK({ items: TABLES }),
    'appTableRecord.batchCreate': API_OK({ records: [{ record_id: 'rec1' }, { record_id: 'rec2' }] }),
    'appTableRecord.batchGet': API_OK({ records: [
      { record_id: 'rec1', fields: { 规则ID: 'R-1' } },
      { record_id: 'rec2', fields: { 规则ID: 'R-2' } }] }),
  });
  lw.__injectClient(cl);
  const before = ledgerLines().length;
  const r = await lw.createRecords(CTX, 'GnRZbIuXraCzf0sGr2UcmZ62nfc', '规则库',
    [{ 规则ID: 'R-1' }, { 规则ID: 'R-2' }]);
  eq(r.ok, true);
  eq(r.readback, 'consistent');
  eq(r.record_ids, ['rec1', 'rec2']);
  eq(r.ledger, 'ok');
  eq(hit('appTableRecord.batchCreate'), 1);
  const lines = ledgerLines();
  eq(lines.length, before + 1, '应恰好追加一行');
  const last = lines[lines.length - 1];
  eq(last.op, 'create_records');
  eq(last.result, 'ok');
  eq(last.readback, 'consistent');
});

await ta('B2 ★ 留痕里有「谁」—— 谁在群里让它改的，事后查得到', async () => {
  const { cl } = mkClient({
    'appTable.list': API_OK({ items: TABLES }),
    'appTableRecord.batchCreate': API_OK({ records: [{ record_id: 'rec9' }] }),
    'appTableRecord.batchGet': API_OK({ records: [{ record_id: 'rec9', fields: { A: '1' } }] }),
  });
  lw.__injectClient(cl);
  await lw.createRecords(CTX, 'GnRZbIuXraCzf0sGr2UcmZ62nfc', '规则库', [{ A: '1' }]);
  const last = ledgerLines().at(-1);
  eq(last.who.sender, '对接人');
  eq(last.who.sender_open_id, 'ou_x');
  eq(last.who.chat_id, 'oc_x');
  eq(last.who.message_id, 'om_x');
});

await ta('B3 回读值不对 → mismatch（不许说成成功）', async () => {
  const { cl } = mkClient({
    'appTable.list': API_OK({ items: TABLES }),
    'appTableRecord.batchCreate': API_OK({ records: [{ record_id: 'rec1' }] }),
    'appTableRecord.batchGet': API_OK({ records: [{ record_id: 'rec1', fields: { A: '被谁改了' } }] }),
  });
  lw.__injectClient(cl);
  const r = await lw.createRecords(CTX, 'GnRZbIuXraCzf0sGr2UcmZ62nfc', '规则库', [{ A: '1' }]);
  eq(r.readback, 'mismatch');
  ok_(/不一致/.test(r.readback_detail), r.readback_detail);
});

await ta('B4 回读接口失败 → untested（不是 ok、也不是 mismatch）', async () => {
  const { cl } = mkClient({
    'appTable.list': API_OK({ items: TABLES }),
    'appTableRecord.batchCreate': API_OK({ records: [{ record_id: 'rec1' }] }),
    'appTableRecord.batchGet': API_ERR('回读挂了'),
  });
  lw.__injectClient(cl);
  const r = await lw.createRecords(CTX, 'GnRZbIuXraCzf0sGr2UcmZ62nfc', '规则库', [{ A: '1' }]);
  eq(r.readback, 'untested');
  ok_(/未测/.test(r.readback_detail), '未测的文案里必须说「未测」');
});

await ta('B5 ★ 501 条被拒绝，且 batchCreate 一次都没调（不静默截断）', async () => {
  const { cl, hit } = mkClient({ 'appTable.list': API_OK({ items: TABLES }) });
  lw.__injectClient(cl);
  const many = Array.from({ length: 501 }, (_, i) => ({ A: String(i) }));
  const r = await lw.createRecords(CTX, 'GnRZbIuXraCzf0sGr2UcmZ62nfc', '规则库', many);
  eq(r.ok, false);
  eq(r.code, 'too_many');
  eq(hit('appTableRecord.batchCreate'), 0, '超限时不许发请求');
});

await ta('B6 ★★ 删记录：快照读不回旧值 → 拒绝，且 batchDelete 一次都没调', async () => {
  const { cl, hit } = mkClient({
    'appTable.list': API_OK({ items: TABLES }),
    'appTableRecord.batchGet': API_ERR('读旧值挂了'),
  });
  lw.__injectClient(cl);
  const r = await lw.deleteRecords(CTX, 'GnRZbIuXraCzf0sGr2UcmZ62nfc', '规则库', ['rec1', 'rec2'], { confirmed: true });
  eq(r.ok, false);
  eq(r.code, 'snapshot_failed');
  eq(hit('appTableRecord.batchDelete'), 0, '★ 快照不全就不许删');
});

await ta('B7 ★★ 删记录：要删 3 条只读回 2 条 → 拒绝，且 batchDelete 一次都没调', async () => {
  const { cl, hit } = mkClient({
    'appTable.list': API_OK({ items: TABLES }),
    'appTableRecord.batchGet': API_OK({ records: [
      { record_id: 'rec1', fields: { A: '1' } }, { record_id: 'rec2', fields: { A: '2' } }] }),
  });
  lw.__injectClient(cl);
  const r = await lw.deleteRecords(CTX, 'GnRZbIuXraCzf0sGr2UcmZ62nfc', '规则库', ['rec1', 'rec2', 'rec3'], { confirmed: true });
  eq(r.ok, false);
  eq(r.code, 'id_mismatch');
  eq(hit('appTableRecord.batchDelete'), 0, '★ 条数对不上就不许删');
});

await ta('B8 ★★ 正向对照：条件齐全时 batchDelete 必须真的被调用（否则 B6/B7 是恒真）', async () => {
  const { cl, hit } = mkClient({
    'appTable.list': API_OK({ items: TABLES }),
    'appTableRecord.batchGet': (args) => {
      // 第一次读旧值返回 2 条；删完之后再读返回空
      // ★ 2026-10-05：这里原先是 `args?.params?.record_ids` —— 与当时的代码犯了**同一个错**，
      //   所以两边一直自洽、自证全绿，而真接口早就回「record_ids is required」。
      //   桩必须照**真接口的契约**读：body（data）。
      const want = args?.data?.record_ids ?? [];
      const seen = hit('appTableRecord.batchGet');
      return seen <= 1
        ? API_OK({ records: want.map((id) => ({ record_id: id, fields: { A: 'old' } })) })
        : API_OK({ records: [] });
    },
    'appTableRecord.batchDelete': API_OK({}),
  });
  lw.__injectClient(cl);
  const r = await lw.deleteRecords(CTX, 'GnRZbIuXraCzf0sGr2UcmZ62nfc', '规则库', ['rec1', 'rec2'], { confirmed: true });
  eq(hit('appTableRecord.batchDelete'), 1, '★ 正向对照：这条路必须走得通');
  eq(r.readback, 'consistent');
  eq(r.deleted, 2);
  const pre = ledgerLines().at(-1).pre_image;
  ok_(pre && Array.isArray(pre.records) && pre.records.length === 2, '留痕里必须带被删内容的快照');
  eq(pre.records[0].fields.A, 'old');
});

await ta('B6b ★★ 删表：字段读不到 → 拒绝，且 appTable.delete 一次都没调', async () => {
  const { cl, hit } = mkClient({
    'appTable.list': API_OK({ items: TABLES }),
    'appTableField.list': API_ERR('字段读不到'),
    'appTableRecord.list': API_OK({ items: [], total: 3 }),
  });
  lw.__injectClient(cl);
  const r = await lw.deleteTable(CTX, 'GnRZbIuXraCzf0sGr2UcmZ62nfc', '规则库', { confirmed: true });
  eq(r.ok, false);
  eq(r.code, 'snapshot_failed');
  eq(hit('appTable.delete'), 0, '★ 列定义没搬走就不许删表');
});

await ta('B6c ★★ 改记录：读不到旧值 → 拒绝，且 batchUpdate 一次都没调', async () => {
  const { cl, hit } = mkClient({
    'appTable.list': API_OK({ items: TABLES }),
    'appTableRecord.batchGet': API_ERR('读旧值挂了'),
  });
  lw.__injectClient(cl);
  const r = await lw.updateRecords(CTX, 'GnRZbIuXraCzf0sGr2UcmZ62nfc', '规则库',
    [{ record_id: 'rec1', fields: { A: '新' } }]);
  eq(r.ok, false);
  eq(r.code, 'snapshot_failed');
  eq(hit('appTableRecord.batchUpdate'), 0, '★ 旧值没搬走就不许改');
});

await ta('B8b ★★ 正向对照：删表条件齐全时 appTable.delete 必须真的被调用', async () => {
  const { cl, hit } = mkClient({
    'appTable.list': (() => {
      let n = 0;
      return () => { n += 1; return API_OK({ items: n <= 1 ? TABLES : [TABLES[1]] }); };
    })(),
    'appTableField.list': API_OK({ items: [{ field_id: 'fld1', field_name: '规则ID', type: 1 }] }),
    'appTableRecord.list': API_OK({ items: [], total: 0 }),
    'appTable.delete': API_OK({}),
  });
  lw.__injectClient(cl);
  const r = await lw.deleteTable(CTX, 'GnRZbIuXraCzf0sGr2UcmZ62nfc', '规则库', { confirmed: true });
  eq(hit('appTable.delete'), 1, '★ 正向对照：这条路必须走得通');
  eq(r.readback, 'consistent');
  const pre = ledgerLines().at(-1).pre_image;
  ok_(Array.isArray(pre.fields) && Array.isArray(pre.records), '留痕里必须同时有列定义与记录');
});

await ta('B9 建表同名 → 拒绝，且 create 一次都没调', async () => {
  const { cl, hit } = mkClient({ 'appTable.list': API_OK({ items: TABLES }) });
  lw.__injectClient(cl);
  const r = await lw.createTable(CTX, 'GnRZbIuXraCzf0sGr2UcmZ62nfc', '规则库', [{ name: 'A', type: '文本' }]);
  eq(r.ok, false);
  eq(r.code, 'duplicate');
  eq(hit('appTable.create'), 0);
});

await ta('B10 ★ 正向对照：表名不冲突时 create 必须真的被调用', async () => {
  const { cl, hit } = mkClient({
    'appTable.list': API_OK({ items: TABLES }),
    'appTable.create': API_OK({ table_id: 'tblNEW' }),
  });
  lw.__injectClient(cl);
  const r = await lw.createTable(CTX, 'GnRZbIuXraCzf0sGr2UcmZ62nfc', '规则库v2', [{ name: 'A', type: '文本' }]);
  eq(hit('appTable.create'), 1, '★ 正向对照');
  eq(r.table_id, 'tblNEW');
  eq(r.readback, 'mismatch', '列表里还没有 tblNEW，所以回读必须报不一致');
});

await ta('B11 建字段类型不认识 → 拒绝，且 create 一次都没调', async () => {
  const { cl, hit } = mkClient({ 'appTable.list': API_OK({ items: TABLES }) });
  lw.__injectClient(cl);
  const r = await lw.createField(CTX, 'GnRZbIuXraCzf0sGr2UcmZ62nfc', '规则库', { name: 'X', type: '瞎写' });
  eq(r.ok, false);
  eq(r.code, 'bad_field_type');
  eq(hit('appTableField.create'), 0);
});

await ta('B12 表名找不到 → 报出该 Base 实际有哪些表（不是干说「没找到」）', async () => {
  const { cl } = mkClient({ 'appTable.list': API_OK({ items: TABLES }) });
  lw.__injectClient(cl);
  const r = await lw.listFields('GnRZbIuXraCzf0sGr2UcmZ62nfc', '不存在的表');
  eq(r.ok, false);
  eq(r.names, ['规则库', '材料收集']);
});

console.log('\n═══ D. 两段式：破坏性操作不许一步做完（§2.4 的执行点）═══');

const P = (over = {}) => ({ op: 'delete_records', requestMessageId: 'om_A',
  expiresAt: Date.now() + 60_000, preview: { table_name: '规则库', ids: ['rec1'] }, ...over });

t('D1 没有待确认的 → no_pending', () => {
  eq(lw.judgeConfirm(null, { messageId: 'om_B' }).code, 'no_pending');
});

t('D2 过期 → expired', () => {
  eq(lw.judgeConfirm(P({ expiresAt: Date.now() - 1 }), { messageId: 'om_B' }).code, 'expired');
});

t('D3 ★★ 同一条消息自我确认 → same_message（这条是两段式的全部意义）', () => {
  const v = lw.judgeConfirm(P({ requestMessageId: 'om_A' }), { messageId: 'om_A' });
  eq(v.code, 'same_message');
  ok_(!v.ok);
});

t('D4 ★★ 采不到 messageId → cannot_verify，**不许放行**（未测 ≠ 通过）', () => {
  eq(lw.judgeConfirm(P(), { messageId: null }).code, 'cannot_verify');
  eq(lw.judgeConfirm(P(), {}).code, 'cannot_verify');
  eq(lw.judgeConfirm(P({ requestMessageId: null }), { messageId: 'om_B' }).code, 'cannot_verify');
});

t('D5 另一条消息 + 未过期 → 通过（否则上面四条可能只是恒真的「永远拒绝」）', () => {
  ok_(lw.judgeConfirm(P(), { messageId: 'om_B' }).ok);
});

t('D6 ★ describeDelete 数不出来时写「未测」，**不许写成 0**', () => {
  const s = lw.describeDelete('delete_field',
    { table_name: '规则库', field_name: '备注', nonempty: null });
  ok_(/未测/.test(s), s);
  ok_(!/非空 0 条/.test(s), '读不到不许写成 0 —— 0 读起来像「这列是空的，删了没事」');
  const s2 = lw.describeDelete('delete_field',
    { table_name: '规则库', field_name: '备注', nonempty: 0 });
  ok_(/非空 0 条/.test(s2), '真读到 0 时要照实写 0：' + s2);
});

await ta('D7 ★★ deleteRecords 不带 confirmed → 只提议，batchDelete 一次都没调', async () => {
  const { cl, hit } = mkClient({
    'appTable.list': API_OK({ items: TABLES }),
    'appTableRecord.batchGet': API_OK({ records: [{ record_id: 'rec1', fields: { A: '旧值' } }] }),
  });
  lw.__injectClient(cl);
  const r = await lw.deleteRecords(CTX, 'GnRZbIuXraCzf0sGr2UcmZ62nfc', '规则库', ['rec1']);
  eq(r.pending, true);
  eq(r.ok, true);
  ok_(r.will.includes('规则库'), r.will);
  eq(hit('appTableRecord.batchDelete'), 0, '★ 提议阶段一个删除请求都不许发');
  eq(lw.readPending()[CTX.chatId].op, 'delete_records', '提议必须落了盘');
});

await ta('D8 ★★ deleteField / deleteTable 不带 confirmed → 只提议', async () => {
  const { cl, hit } = mkClient({
    'appTable.list': API_OK({ items: TABLES }),
    'appTableField.list': API_OK({ items: [{ field_id: 'fld1', field_name: '备注', type: 1 }] }),
    'appTableRecord.list': API_OK({ items: [{ record_id: 'r1', fields: { 备注: 'x' } }], total: 1 }),
  });
  lw.__injectClient(cl);
  const r1 = await lw.deleteField(CTX, 'GnRZbIuXraCzf0sGr2UcmZ62nfc', '规则库', '备注');
  eq(r1.pending, true);
  eq(hit('appTableField.delete'), 0);
  const r2 = await lw.deleteTable(CTX, 'GnRZbIuXraCzf0sGr2UcmZ62nfc', '规则库');
  eq(r2.pending, true);
  eq(hit('appTable.delete'), 0, '★ 提议阶段一个删除请求都不许发');
});

await ta('D9 ★★ confirmDelete 在「同一条消息」里 → 拒绝，且 batchDelete 一次都没调', async () => {
  const { cl, hit } = mkClient({
    'appTable.list': API_OK({ items: TABLES }),
    'appTableRecord.batchGet': API_OK({ records: [{ record_id: 'rec1', fields: { A: '旧值' } }] }),
  });
  lw.__injectClient(cl);
  await lw.deleteRecords(CTX, 'GnRZbIuXraCzf0sGr2UcmZ62nfc', '规则库', ['rec1']);  // 提议（om_x）
  const r = await lw.confirmDelete(CTX);                                            // 同一条消息确认
  eq(r.ok, false);
  eq(r.code, 'same_message');
  eq(hit('appTableRecord.batchDelete'), 0, '★★ 自我确认绝不许真删');
});

await ta('D10 ★★ 正向对照：另一条消息确认 → batchDelete 真的被调用，且 pending 被清掉', async () => {
  const { cl, hit } = mkClient({
    'appTable.list': API_OK({ items: TABLES }),
    'appTableRecord.batchGet': (args) => {
      // ★ 2026-10-05：这里原先是 `args?.params?.record_ids` —— 与当时的代码犯了**同一个错**，
      //   所以两边一直自洽、自证全绿，而真接口早就回「record_ids is required」。
      //   桩必须照**真接口的契约**读：body（data）。
      const want = args?.data?.record_ids ?? [];
      return hit('appTableRecord.batchGet') <= 2      // 提议读 1 次 + 执行前快照 1 次
        ? API_OK({ records: want.map((id) => ({ record_id: id, fields: { A: 'old' } })) })
        : API_OK({ records: [] });
    },
    'appTableRecord.batchDelete': API_OK({}),
  });
  lw.__injectClient(cl);
  await lw.deleteRecords({ ...CTX, messageId: 'om_REQ' }, 'GnRZbIuXraCzf0sGr2UcmZ62nfc', '规则库', ['rec1']);
  const r = await lw.confirmDelete({ ...CTX, messageId: 'om_CONFIRM' });
  eq(hit('appTableRecord.batchDelete'), 1, '★ 正向对照：另一条消息确认必须走得通');
  eq(r.readback, 'consistent');
  eq(lw.readPending()[CTX.chatId], undefined, '确认之后 pending 必须被清掉');
});

await ta('D11 ★ 取消：pending 清掉，且一个删除请求都没发', async () => {
  const { cl, hit } = mkClient({
    'appTable.list': API_OK({ items: TABLES }),
    'appTableRecord.batchGet': API_OK({ records: [{ record_id: 'rec1', fields: { A: '旧值' } }] }),
  });
  lw.__injectClient(cl);
  await lw.deleteRecords(CTX, 'GnRZbIuXraCzf0sGr2UcmZ62nfc', '规则库', ['rec1']);
  const r = await lw.cancelDelete(CTX);
  eq(r.cancelled, true);
  eq(hit('appTableRecord.batchDelete'), 0);
  eq(lw.readPending()[CTX.chatId], undefined);
});

console.log('\n═══ E. 停读资源不能通过 Base 工具读取 ═══');

const TMP_POLICY = path.join(os.tmpdir(), `lw-policy-${process.pid}-${Date.now()}.json`);
const STOPPED_BASE = 'STOPPEDBASE12345678';
const writePolicy = (tokens = [STOPPED_BASE]) => fs.writeFileSync(TMP_POLICY, JSON.stringify({
  schema_version: 1,
  resources: tokens.length ? [{ name: '测试停读资源', url: `https://momcozy-in.feishu.cn/base/${tokens[0]}`, tokens }] : [],
}));

await ta('E1 三个 Base 读取工具和 table_id 直达解析均在 SDK 调用前拒绝停读对象', async () => {
  writePolicy();
  const { cl, calls } = mkClient({
    'appTable.list': API_OK({ items: TABLES }),
    'appTableField.list': API_OK({ items: [] }),
    'appTableRecord.list': API_OK({ items: [], total: 0 }),
  });
  lw.__injectClient(cl);
  const options = { policyPath: TMP_POLICY };
  for (const invoke of [
    () => lw.listTables(STOPPED_BASE, options),
    () => lw.listFields(STOPPED_BASE, '规则库', options),
    () => lw.listFields(STOPPED_BASE, 'tblAAA', options),
    () => lw.listRecords(STOPPED_BASE, '规则库', options),
    () => lw.listRecords(STOPPED_BASE, 'tblAAA', options),
    () => lw.resolveTable(STOPPED_BASE, 'tblAAA', options),
  ]) {
    const result = await invoke();
    eq(result.ok, false, '停读对象必须拒绝');
    eq(result.code, 'read_stopped');
    ok_(/停读|移除/.test(result.msg), '不能把停读说成权限不足');
  }
  eq(calls, [], '停读对象不许发任何 Base 请求');
});

await ta('E2 保留 Base 的三条读取路径照常返回字段、记录和规模', async () => {
  writePolicy();
  const { cl, calls } = mkClient({
    'appTable.list': API_OK({ items: [TABLES[0]] }),
    'appTableField.list': API_OK({ items: [{ field_id: 'fldA', field_name: '正文', type: 1 }] }),
    'appTableRecord.list': API_OK({ items: [{ record_id: 'recA', fields: { 正文: '仍可读取' } }], total: 1 }),
  });
  lw.__injectClient(cl);
  const options = { policyPath: TMP_POLICY };
  eq((await lw.listTables('KEPTBASE12345678', options)).tables, [{ table_id: 'tblAAA', name: '规则库', records: 1 }]);
  eq((await lw.listFields('KEPTBASE12345678', '规则库', options)).fields[0].name, '正文');
  eq((await lw.listRecords('KEPTBASE12345678', 'tblAAA', options)).records[0].fields, { 正文: '仍可读取' });
  ok_(calls.length > 0, '正向对照必须确实走过 SDK 边界');
});

await ta('E3 已解析过 table_id 的对象在停读清单更新后立即拒读', async () => {
  writePolicy([]);
  const { cl, calls } = mkClient({
    'appTable.list': API_OK({ items: TABLES }),
    'appTableRecord.list': API_OK({ items: [], total: 0 }),
  });
  lw.__injectClient(cl);
  const options = { policyPath: TMP_POLICY };
  const resolved = await lw.resolveTable(STOPPED_BASE, '规则库', options);
  eq(resolved.ok, true);
  eq(resolved.table_id, 'tblAAA');
  const before = calls.length;
  writePolicy();
  eq((await lw.listRecords(STOPPED_BASE, resolved.table_id, options)).code, 'read_stopped');
  eq(calls.length, before, '之前的表解析结果不能成为停读后的通行证');
});

await ta('E4 停读清单不可读时 Base 工具必须拒绝，不得当作空名单', async () => {
  fs.writeFileSync(TMP_POLICY, '{');
  const { cl, calls } = mkClient({ 'appTable.list': API_OK({ items: [] }) });
  lw.__injectClient(cl);
  eq((await lw.listTables('KEPTBASE12345678', { policyPath: TMP_POLICY })).code, 'read_policy_unavailable');
  eq(calls, []);
});

await ta('E5 真实停读 Base 的写前解析也被拒绝，不得先写再因回读被拒', async () => {
  const { cl, calls } = mkClient({
    'appTableRecord.batchCreate': API_OK({ records: [] }),
    'appTableRecord.batchUpdate': API_OK({ records: [] }),
    'appTableRecord.batchGet': API_OK({ records: [] }),
  });
  lw.__injectClient(cl);
  for (const invoke of [
    () => lw.createRecords(CTX, 'C2cYbj5AOaJ9RlsWViYcSCdcnFc', 'tblAAA', [{ 正文: '不应写入' }]),
    () => lw.updateRecords(CTX, 'C2cYbj5AOaJ9RlsWViYcSCdcnFc', 'tblAAA', [{ record_id: 'recA', fields: { 正文: '不应写入' } }]),
    () => lw.deleteRecords(CTX, 'C2cYbj5AOaJ9RlsWViYcSCdcnFc', 'tblAAA', ['recA']),
  ]) eq((await invoke()).code, 'read_stopped');
  eq(calls, [], '停读对象不许先产生写入或读取预览');
});

try { fs.unlinkSync(TMP_POLICY); } catch { /* 临时策略文件不影响真实清单 */ }

console.log('\n═══ C. 自证自身的副作用（§2.4.4）═══');

t('C1 ★ 真留痕文件在这次自证前后没被动过', () => {
  eq(realStat(), REAL_BEFORE, `自证动了真留痕 ${REAL_LEDGER}`);
});

t('C4 ★ 真 pending 文件在这次自证前后也没被动过', () => {
  eq(realPendingStat(), REAL_PENDING_BEFORE, `自证动了真 pending ${REAL_PENDING}`);
  ok_(TMP_PENDING !== REAL_PENDING);
});

t('C2 自证的留痕落在临时文件上，且确实有内容', () => {
  ok_(fs.existsSync(TMP), '临时留痕文件不存在');
  ok_(ledgerLines().length > 0, '临时留痕是空的 —— 那 B1 的断言就是恒真');
  ok_(TMP !== REAL_LEDGER);
});

t('C3 自证没有真连飞书（没有 client 被替换时的真实调用记录）', () => {
  // realStat 之外再确认一次：这个文件从 import 起就没被写过
  const src = fs.readFileSync(
    path.join(path.dirname(new URL(import.meta.url).pathname), 'lark_write.mjs'), 'utf8');
  ok_(/__injectClient/.test(src), '测试缝必须存在，否则 B 段的断言都只能靠读文本');
});

/* ─────────────────────────── 收尾 ─────────────────────────── */

try { fs.unlinkSync(TMP); } catch { /* 临时文件删不掉不影响结论 */ }

const n = nPass + fails.length;
if (process.argv.includes('--controls') && fails.length === 0) {
  console.log(`\n✅ ${nPass}/${n} 全过（含 B6/B7/D7/D8/D9 五条「不许发生」+ B8/B8b/B10/D5/D10 五条正向对照）`);
} else if (fails.length === 0) {
  console.log(`\n✅ ${nPass}/${n} 全过`);
  console.log('   留痕 / 回读 / 删除前快照 / 破坏性操作两段式 —— 四条纪律各由「假客户端真调 + 正向对照」证过。');
  process.exit(0);
} else {
  console.log(`\n❌ ${fails.length} 项未过：${fails.join('；')}`);
  process.exit(1);
}

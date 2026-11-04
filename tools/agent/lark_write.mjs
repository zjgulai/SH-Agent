/**
 * lark_write.mjs —— 守衡的飞书写通道（多维表格 Base）
 *
 * ★ 它为什么存在：2026-09-22 16:04 与 16:06，守衡在群里两次说「我做不到」。
 *   那不是飞书没给权限 —— 是**我们自己的工具层没有写工具**（tools.mjs 文件头
 *   原先写着「写类工具（发消息、改文档）等业务场景明确后再放开」）。
 *   业务场景在 16:02 明确了：她给落点、给口径，16:06 开了编辑权限并说「请写入」。
 *   委托方 2026-09-22 决定放开（选项：整表写 = 建表 / 改字段 / 删记录）。
 *
 * 三条随身纪律。每一条在 lark_write.test.mjs 里都有一条**能红的**断言，
 * 并各有一个反向对照 —— 按 AGENTS.md §2.4：「写进文档的每一个上限，
 * 必须能指出是哪一行代码在拦它」。
 *
 *   ① 留痕（logWrite）：每次真写 append 一行 PMO/logs/lark_writes.jsonl，
 *      含 谁（runtimeContext）/ 目标 / 入参 / 结果 / 回读结论。
 *      理由与 ws_outbound.jsonl 相同：**没留痕的写入，事后没人能复核** ——
 *      而这个仓库今天刚吃过一次「说了做了、物证只有自己那张嘴」的亏。
 *
 *   ② 回读（readback*）：写完必须读回来比对。读不回来 → `readback:'untested'`，
 *      **不许说「建好了」**（AGENTS.md §2.4.2：未测 ≠ 通过 ≠ 红）。
 *      「接口返回 code=0」只证明请求发出去了，不证明数据落下来了。
 *
 *   ③ 删除前快照（snapshotBefore）：删记录 / 删字段 / 删表之前，
 *      先把**将被删掉的完整内容**写进留痕文件。
 *      AGENTS.md §2.4 的配套是「搬是搬，砍是砍」；这里是**砍之前先搬一份**。
 *      多花几 KB，换的是「删错了能重建」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { client } from './feishu.mjs';
import { REPO_ROOT } from './config.mjs';
import { stoppedFeishuResource } from './feishu_read_policy.mjs';

/**
 * ★ 测试缝①：留痕文件路径可被环境变量指走。
 *   照 `SHOUHENG_LLM_FAILURES` 那个先例（AGENTS.md §2.1 表里 llm_errors.test.mjs 那一行）。
 *   没有这条缝，自证就只能去写**真留痕**—— 那正是 §2.4.4 的病：
 *   「跑一次自证，改掉了它要保护的东西」。
 */
export const LEDGER = process.env.SHOUHENG_LARK_WRITES
  || path.join(REPO_ROOT, 'PMO', 'logs', 'lark_writes.jsonl');

/**
 * ★ 测试缝②：飞书客户端可被替换。
 *   没有它，「删除前快照凑不齐就不删」这条断言只能靠**读源码文本**来证
 *   （而 AGENTS.md §2.4 已经点名：「名字出现过」不是「它拦得住」）。
 *   有了它，自证能真的调一次 deleteRecords、然后用假客户端断言 batchDelete
 *   **一次都没被调用** —— 那才是能红的断言。
 *   生产不设它，就是真客户端。
 */
let _clientOverride = null;
export function __injectClient(c) { _clientOverride = c; }
const C = () => _clientOverride ?? client;

/**
 * 已知的业务 Base。**是数据，不是散文** —— 模型没有「列出我能访问的所有 Base」
 * 这种接口（飞书没有那个 API），所以「把 XX 加到规则库」这种不带链接的说法，
 * 必须有地方查得到 token，否则模型只能反问或者编一个。
 *
 * 加新 Base 的条件：真实存在，且应用**确实**是它的协作者（不是「应该能访问」）。
 * `verify` 那一列写的是「凭什么说它能写」，改了要连自证一起改。
 */
export const KNOWN_BASES = [
  { token: 'GnRZbIuXraCzf0sGr2UcmZ62nfc', name: '内容治理-知识库',
    use: '业务侧长期资产（规则库、材料收集、正负样本）',
    verify: '2026-09-22 16:11 应用在此建表并写入 50 条（migrate_rules_to_lark.py --apply）' },
  { token: 'A437bIdQfax7dbsyrAncPpbNnjh', name: '需求知识库',
    use: '应用自建；放给法务逐条确认的全量 62 条',
    verify: '2026-09-22 应用在此建「外部标准库（待法务确认）」并写入 62 条' },
];


/** 单次调用最多动多少条记录。接口上限是 500，这里取同一个数并**显式拒绝超限的**，
 *  而不是静默截断 —— 静默截断会让人以为全写进去了（§2.4：上限要有执行点）。 */
export const MAX_RECORDS_PER_CALL = 500;

/* ─────────────────────────── 字段类型 ─────────────────────────── */

/** 飞书多维表格字段类型号。允许用数字，也允许用中文名 —— 模型写错数字是常事。 */
export const FIELD_TYPES = {
  1: '文本', 2: '数字', 3: '单选', 4: '多选', 5: '日期', 7: '复选框',
  11: '人员', 13: '电话', 15: 'URL', 17: '附件', 18: '单向关联',
  20: '公式', 21: '双向关联', 22: '地理位置', 23: '群组',
  1001: '创建时间', 1002: '最后更新时间', 1003: '创建人', 1004: '修改人', 1005: '自动编号',
};

const NAME_TO_TYPE = Object.fromEntries(
  Object.entries(FIELD_TYPES).map(([n, name]) => [name, Number(n)]));

/**
 * 把「1」/「1」/「文本」/「单行文本」都解成类型号。
 * 解不出返回 null —— **调用方必须把 null 当拒绝，不是当默认**。
 * （默认成「文本」是这里最容易犯的错：一个类型写错的字段建出来能用，
 *   但存进去的东西全变成字符串，且没有任何东西会红。）
 */
export function fieldTypeOf(v) {
  if (typeof v === 'number' && FIELD_TYPES[v]) return v;
  const s = String(v ?? '').trim();
  if (/^\d+$/.test(s) && FIELD_TYPES[Number(s)]) return Number(s);
  if (NAME_TO_TYPE[s]) return NAME_TO_TYPE[s];
  // 常见别名：飞书后台叫法与人叫法不一致
  const alias = { 单行文本: 1, 多行文本: 1, 长文本: 1, 文本: 1, 选项: 3, 单选标签: 3, 多选标签: 4 };
  return alias[s] ?? null;
}

/* ─────────────────────────── ① 留痕 ─────────────────────────── */

/**
 * append 一行到留痕文件。**绝不抛异常**：留痕失败不该让业务写入回滚，
 * 但它必须让返回值里出现 `ledger:'failed'`，由调用方照实说出来。
 */
export function logWrite(entry) {
  const row = { at: new Date().toISOString(), ...entry };
  try {
    fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
    fs.appendFileSync(LEDGER, JSON.stringify(row) + '\n', 'utf8');
    return { ledger: 'ok', ledger_path: LEDGER };
  } catch (e) {
    return { ledger: 'failed', ledger_error: String(e?.message ?? e) };
  }
}

/** 读留痕（给自证与「上一次谁改的」用）。坏行跳过、不抛。 */
export function readLedger(file = LEDGER) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return { _bad: true, raw: l.slice(0, 200) }; }
  });
}

/* ─────────────────────────── ③ 删除前快照 ─────────────────────────── */

/**
 * 「将被删掉的东西」序列化。这个函数是纯的 —— 它只负责把 pre-image 凑齐，
 * 由调用方在**发出删除请求之前**交给 logWrite。
 *
 * 判据（也是自证里断言的那条）：**删除动作必须带着非空 pre-image**。
 * 一个不带 pre-image 的删除，等于把「删错了能不能恢复」交给飞书回收站 ——
 * 而回收站我们没验过，所以不许当依据。
 *
 * ★ 2026-09-22 首次自证就挖出这里有个洞，记下来因为它值得单独记：
 *   原来 `delete_records` 只要求 `Array.isArray(pre.records)`。于是调用方
 *   `{ records: found ?? [] }` 在**读不到旧值**时会传一个**空数组** —— 而空数组
 *   是合法的「零条」，判定通过、照删。**「读不到」被 `?? []` 变成了「没有」。**
 *   这正是 AGENTS.md §2.4.1 那句话（未测 ≠ 没有），只不过它长在防误删的护栏里。
 *   修法：destructive op 必须显式声明 `readable: true`，并逐个列出「这一刀要搬走
 *   哪些东西」；少搬一样就不许删。
 */
export function snapshotBefore(op, pre) {
  const missing = [];
  if (!pre || typeof pre !== 'object') missing.push('pre 不是对象');
  else if (pre.readable !== true) {
    // 只有「我确实读到了」才允许往下走。
    missing.push('readable 不是 true —— 旧值没读到，就不许删（读不到 ≠ 没有）');
  } else {
    if (op === 'delete_table') {
      if (!Array.isArray(pre.tables)) missing.push('delete_table 缺 tables');
      if (!Array.isArray(pre.fields)) missing.push('delete_table 缺 fields（删表要把列定义一起搬走）');
      if (!Array.isArray(pre.records)) missing.push('delete_table 缺 records（删表要把记录一起搬走）');
    }
    if (op === 'delete_field' && !pre.field) missing.push('delete_field 缺 field');
    if (op === 'delete_records' && !Array.isArray(pre.records)) missing.push('delete_records 缺 records');
  }
  if (missing.length) return { ok: false, reason: missing.join('；') };
  return { ok: true, snapshot: { op, captured_at: new Date().toISOString(), ...pre } };
}

/* ─────────────────────────── ② 回读 ─────────────────────────── */

/**
 * 把回读到的字段值压成可比较的标量。
 * 飞书的文本/多选会回成**数组**（富文本分段），直接跟写入时的字符串比会「永不相等」——
 * 那种比较器会恒假，比没有还坏（AGENTS.md §2.1.1：会误报的检查器比没有更糟）。
 */
export function flat(v) {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map(flat).join('');
  if (typeof v === 'object') {
    if (typeof v.text === 'string') return v.text;
    if (typeof v.name === 'string') return v.name;
    if (typeof v.value === 'string') return v.value;
    return JSON.stringify(v);
  }
  return String(v);
}

/**
 * 逐字段比对「我写进去的」与「读回来的」。
 * 只比**我设过的那些键** —— 飞书会给没设的字段填默认值（创建时间/自动编号），
 * 把那些也算进失配，会让这个判断天天误报。
 *
 * 返回 { checked, mismatches[], verdict }
 *   verdict: 'consistent' | 'mismatch' | 'untested'（读回来的不是数组/空）
 */
export function verifyReadback(sentFields, gotFields) {
  if (!gotFields || typeof gotFields !== 'object') {
    return { checked: 0, mismatches: [], verdict: 'untested' };
  }
  const mismatches = [];
  let checked = 0;
  for (const [k, want] of Object.entries(sentFields || {})) {
    // 写入时允许写成 {text:[...]} 之类的富文本形状；取写者真正想表达的字符串
    const wantS = flat(Array.isArray(want) || (want && typeof want === 'object' && want.text)
      ? (want.text ?? want) : want);
    const gotS = flat(gotFields[k]);
    checked += 1;
    if (wantS !== gotS) mismatches.push({ field: k, sent: wantS.slice(0, 120), got: gotS.slice(0, 120) });
  }
  return { checked, mismatches, verdict: mismatches.length ? 'mismatch' : 'consistent' };
}

/** 建表前判重。纯函数，自证直接喂样本。 */
export function shouldRefuseCreateTable(existingNames, wanted) {
  return (existingNames || []).includes(String(wanted ?? '').trim());
}

/** 条数上限判据。纯函数。 */
export function tooManyRecords(n, cap = MAX_RECORDS_PER_CALL) {
  return Number(n) > cap;
}

/* ─────────────── 两段式：破坏性操作先说出来、等对方确认 ─────────────── */

/**
 * 2026-09-22 委托方定：删表 / 删列 / 删记录**不许一步做完** ——
 * 先把「要删什么」说出来，等对方下一条消息确认，才动手。
 *
 * ★ 为什么这不是「在提示词里加一句话」：
 *   persona.mjs 里本来就写着「删除类操作动手前先把要删什么说出来」，
 *   而全仓**没有任何一行代码在拦它** —— 按 AGENTS.md §2.4，那是一句注释，不是约束。
 *   这里的执行点是 **`judgeConfirm()`**，它有一条硬判据：
 *   **确认必须来自另一条消息**（`messageId` 不同且两者都非空）。
 *   没有这一条，模型可以在同一次推理里先「提议」再「确认」，两段式就白做了，
 *   而**外面看起来完全一样**。
 *
 * ★ 另一条同样重要的判据：`messageId` 采不到时**一律拒绝**，不是放行。
 *   「没法确认这是不是另一条消息」≠「这是另一条消息」（§2.4.1 第 4 行）。
 */
export const PENDING_FILE = process.env.SHOUHENG_LARK_PENDING
  || path.join(REPO_ROOT, 'PMO', 'shouheng-state', 'lark-pending-delete.json');

/** 提议多久失效。过期要重新提 —— 十五分钟前说「删掉」，十五分钟后一句「好」不该生效。 */
export const PENDING_TTL_MS = 15 * 60 * 1000;

export function readPending(file = PENDING_FILE) {
  try {
    if (!fs.existsSync(file)) return {};
    const o = JSON.parse(fs.readFileSync(file, 'utf8'));
    return o && typeof o === 'object' ? o : {};
  } catch { return {}; }
}

function writePending(all, file = PENDING_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(all, null, 2), 'utf8');
}

const short = (v, n = 40) => {
  const s = flat(v).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
};

/**
 * 把「我要删什么」说成人话。**人靠这句话决定要不要点头**，所以它必须具体到
 * 能让对方认出东西 —— 「3 条记录」不够，「R-17、R-18、R-19 这三条」才够。
 */
export function describeDelete(op, p) {
  // ⚠️ 数不出来时写「未测」，**不许写成 0** —— 0 读起来像「这列是空的，删了没事」（§2.4.1）
  const n = (v, unit) => (v === null || v === undefined ? `**${unit}未测**` : `${v} ${unit}`);
  if (op === 'delete_table') {
    return `删掉整张表「${p.table_name}」（${n(p.field_count, '列')}、${n(p.record_count, '条记录')}）`;
  }
  if (op === 'delete_field') {
    return `删掉「${p.table_name}」里的列「${p.field_name}」`
      + `（该列非空 ${n(p.nonempty, '条')}，删列会连这些数据一起没）`;
  }
  if (op === 'delete_records') {
    const ids = p.ids ?? [];
    const sample = (p.sample ?? []).map((x) => `「${short(x, 30)}」`).join('、');
    return `删掉「${p.table_name}」里的 ${ids.length} 条记录`
      + (sample ? `：${sample}${ids.length > (p.sample?.length ?? 0) ? ' …' : ''}` : '');
  }
  return `未知的删除动作：${op}`;
}

/**
 * 这次「确认」算不算数。纯函数，自证直接喂样本（不碰盘、不碰飞书）。
 *
 * 四种拒绝，一种通过：
 *   · 没有待确认的        → no_pending
 *   · 过期了              → expired
 *   · 同一条消息自己确认   → same_message      ★ 这条是两段式的全部意义
 *   · messageId 采不到     → cannot_verify      ★ 未测不许当成通过
 */
export function judgeConfirm(pending, ctx, now = Date.now()) {
  if (!pending) return { ok: false, code: 'no_pending', msg: '当前没有待确认的删除动作' };
  if (now > (pending.expiresAt ?? 0)) {
    return { ok: false, code: 'expired',
      msg: `那条提议已经过了 ${Math.round(PENDING_TTL_MS / 60000)} 分钟，失效了 —— 要删请重新说一次` };
  }
  const req = pending.requestMessageId ?? null;
  const cur = ctx?.messageId ?? null;
  if (!req || !cur) {
    return { ok: false, code: 'cannot_verify',
      msg: '我没法确认这条是「另一条消息」—— 采不到消息 id。**没测到不等于通过**，所以不执行。' };
  }
  if (req === cur) {
    return { ok: false, code: 'same_message',
      msg: '这是发起删除的那一条消息本身 —— 确认必须来自**另一条**消息，请让对方回一句' };
  }
  return { ok: true };
}

/* ─────────────────────────── 真实调用 ─────────────────────────── */

const ok = (o) => ({ ok: true, ...o });
const bad = (code, msg, extra = {}) => ({ ok: false, code, msg, ...extra });

function readingRefusal(appToken, policyPath) {
  try {
    const resource = stoppedFeishuResource(appToken, policyPath);
    return resource ? bad('read_stopped', `《${resource.name}》已从守衡读取范围中移除，不再读取。`) : null;
  } catch (error) {
    return bad('read_policy_unavailable', '停读清单暂时无法读取，本次未访问飞书资源。');
  }
}

async function call(fn, args, { policyPath } = {}) {
  // 所有 SDK 请求在这里收口，包含写前快照与写后回读，避免停读对象先写后拒读。
  const refused = readingRefusal(args?.path?.app_token, policyPath);
  if (refused) return refused;
  try {
    const r = await fn(args);
    const code = r?.code ?? 0;
    if (code !== 0) return bad(code, r?.msg ?? '接口返回非 0', { raw: r });
    return ok({ data: r?.data ?? {} });
  } catch (e) {
    // SDK 在非 0 时抛；错误体里带 code/msg，尽量取出来 —— 只报「失败了」是答不了的
    const resp = e?.response?.data ?? e?.data;
    return bad(resp?.code ?? e?.code ?? 'unknown',
      resp?.msg ?? String(e?.message ?? e).slice(0, 300),
      { raw: resp ?? undefined });
  }
}

async function listTablesRaw(appToken, options = {}) {
  const r = await call(C().bitable.appTable.list.bind(C().bitable.appTable),
    { path: { app_token: appToken }, params: { page_size: 100 } }, options);
  if (!r.ok) return r;
  return ok({ items: r.data.items ?? [] });
}

/** 表名 → table_id。接受 table_id 本身（以 tbl 开头）或表名。 */
export async function resolveTable(appToken, table, options = {}) {
  const refused = readingRefusal(appToken, options.policyPath);
  if (refused) return refused;
  const s = String(table ?? '').trim();
  if (/^tbl/.test(s)) return ok({ table_id: s, name: null });
  const r = await listTablesRaw(appToken, options);
  if (!r.ok) return r;
  const hit = r.items.find((t) => t.name === s);
  if (!hit) return bad('not_found', `该 Base 里没有名为「${s}」的表`, { names: r.items.map((t) => t.name) });
  return ok({ table_id: hit.table_id, name: hit.name });
}

/* ── 读 ── */

export async function listTables(appToken, options = {}) {
  const r = await listTablesRaw(appToken, options);
  if (!r.ok) return r;
  const out = [];
  for (const t of r.items) {
    const c = await call(C().bitable.appTableRecord.list.bind(C().bitable.appTableRecord),
      { path: { app_token: appToken, table_id: t.table_id }, params: { page_size: 1 } }, options);
    if (!c.ok && ['read_stopped', 'read_policy_unavailable'].includes(c.code)) return c;
    out.push({ table_id: t.table_id, name: t.name, records: c.ok ? (c.data.total ?? null) : null });
  }
  return ok({ tables: out });
}

export async function listFields(appToken, table, options = {}) {
  const t = await resolveTable(appToken, table, options);
  if (!t.ok) return t;
  const r = await call(C().bitable.appTableField.list.bind(C().bitable.appTableField),
    { path: { app_token: appToken, table_id: t.table_id }, params: { page_size: 200 } }, options);
  if (!r.ok) return r;
  return ok({
    table_id: t.table_id,
    fields: (r.data.items ?? []).map((f) => ({ field_id: f.field_id, name: f.field_name, type: f.type,
      type_name: FIELD_TYPES[f.type] ?? `未知(${f.type})`,
      options: (f.property?.options ?? []).map((o) => o.name) })),
  });
}

export async function listRecords(appToken, table, { limit = 20, pageToken = null, policyPath } = {}) {
  const t = await resolveTable(appToken, table, { policyPath });
  if (!t.ok) return t;
  const r = await call(C().bitable.appTableRecord.list.bind(C().bitable.appTableRecord),
    { path: { app_token: appToken, table_id: t.table_id },
      params: { page_size: Math.min(Number(limit) || 20, 500), ...(pageToken ? { page_token: pageToken } : {}) } }, { policyPath });
  if (!r.ok) return r;
  return ok({ table_id: t.table_id, total: r.data.total ?? null,
    records: (r.data.items ?? []).map((x) => ({ record_id: x.record_id, fields: x.fields })) });
}

/* ── 写 ── */

/**
 * ★ 2026-10-05 实测修的一处**静默缺陷**：`appTableRecord.batchGet` 的 `record_ids`
 *   必须放在 **body**（`data`）里，放到 query（`params`）里飞书会回
 *   `code=99992402 · field validation failed · field_violations=[{field:"record_ids",
 *   description:"record_ids is required"}]`（实测 log_id
 *   `20261005082040C23AF9EB8F20344668AC`）。
 *
 *   为什么它能藏这么久：这些调用点全是**留痕 / 回读 / 删除前快照** —— 三条纪律都 fail-closed，
 *   读不到旧值就中止，所以**没有破坏过任何数据**，只是「改记录」这条路一直走不通，
 *   而自证里的假客户端**不校验调用形状**（任意 args 都收），于是全绿。
 *   这正是 §2.4.1 那个病换了个地方长出来：**fake 的契约比真接口松，假数据就是真数据的形状。**
 *   判据已补在 `lark_write.test.mjs`：假客户端按**真接口的契约**校验 batchGet（见 guardBatchGet）。
 */

/**
 * 所有写操作共用的外壳：留痕 → 执行 → 回读 → 再留痕一次（带回读结论）。
 * ★ 自证里有一条 AST/源码级断言：**每个导出的写函数都必须经过这里**。
 *   这是 §2.4 那条规矩的落地 —— 「留痕」不能只是一句注释。
 */
async function withWrite({ op, appToken, tableId = null, args, ctx = {}, step }) {
  const who = { sender: ctx.senderName ?? null, sender_open_id: ctx.senderOpenId ?? null,
    chat_id: ctx.chatId ?? null, message_id: ctx.messageId ?? null };
  const base = { op, app_token: appToken, table_id: tableId, who, args };

  const pre = await step();          // step 自己负责在删除前调 snapshotBefore 并把它放进 ledger_extra
  // ★ 成功与否只判一次，留痕与返回值**共用同一个布尔**。
  //   自证第一次跑抓到两处：① 返回值里没有 `ok`（undefined，调用方分不清成功与拼错）；
  //   ② 更坏 —— 留痕用的是 `pre.ok`，而 step 成功时从没设过它，
  //   于是**每一次成功的写入在台账里都记成 `result:'failed'`**。
  //   一份会骗人的台账比没有台账更坏：它会让人不再去看它。
  const okFlag = pre.ok !== false;
  const led = logWrite({ ...base, ...(pre.ledger_extra ?? {}), result: okFlag ? 'ok' : 'failed',
    code: okFlag ? 0 : pre.code, msg: okFlag ? null : pre.msg, readback: pre.readback ?? null,
    readback_detail: pre.readback_detail ?? null });
  return { ...pre, ok: okFlag, ...led };
}

export async function createTable(ctx, appToken, name, fields) {
  const tName = String(name ?? '').trim();
  if (!tName) return bad('bad_args', '表名不能为空');

  const parsed = [];
  for (const f of fields ?? []) {
    const ty = fieldTypeOf(f?.type);
    if (ty === null) return bad('bad_field_type', `字段「${f?.name}」的类型「${f?.type}」不认识`,
      { known: Object.values(FIELD_TYPES) });
    const def = { field_name: String(f.name).trim(), type: ty };
    if (f.options) def.property = { options: f.options.map((o) => ({ name: String(o) })) };
    parsed.push(def);
  }

  const existing = await listTablesRaw(appToken);
  if (!existing.ok) return existing;
  if (shouldRefuseCreateTable(existing.items.map((t) => t.name), tName)) {
    return bad('duplicate', `该 Base 里已有名为「${tName}」的表 —— 中止，避免建出第二张同义表`,
      { names: existing.items.map((t) => t.name) });
  }

  return withWrite({ op: 'create_table', appToken, args: { name: tName, fields: parsed }, ctx,
    step: async () => {
      const r = await call(C().bitable.appTable.create.bind(C().bitable.appTable),
        { path: { app_token: appToken },
          data: { table: { name: tName, default_view_name: '全部', fields: parsed } } });
      if (!r.ok) return r;
      const tid = r.data.table_id;
      // ② 回读：表真的在了吗
      const back = await listTablesRaw(appToken);
      const found = back.ok && back.items.some((t) => t.table_id === tid);
      return { table_id: tid, readback: found ? 'consistent' : 'mismatch',
        readback_detail: found ? '表已存在于列表' : '建表返回了 id，但回读列表里没有它',
        ...(found ? {} : { ok: false, code: 'readback', msg: '回读不到刚建的表' }) };
    } });
}

export async function createField(ctx, appToken, table, field) {
  const ty = fieldTypeOf(field?.type);
  if (ty === null) return bad('bad_field_type', `类型「${field?.type}」不认识`, { known: Object.values(FIELD_TYPES) });
  const t = await resolveTable(appToken, table);
  if (!t.ok) return t;
  const def = { field_name: String(field.name).trim(), type: ty };
  if (field.options) def.property = { options: field.options.map((o) => ({ name: String(o) })) };

  return withWrite({ op: 'create_field', appToken, tableId: t.table_id, args: def, ctx,
    step: async () => {
      const r = await call(C().bitable.appTableField.create.bind(C().bitable.appTableField),
        { path: { app_token: appToken, table_id: t.table_id }, data: def });
      if (!r.ok) return r;
      const back = await listFields(appToken, t.table_id);
      const found = back.ok && back.fields.some((f) => f.name === def.field_name);
      return { field_id: r.data.field?.field_id ?? null,
        readback: found ? 'consistent' : 'mismatch',
        readback_detail: found ? '字段已在列表里' : '建字段返回 ok，但回读列表里没有它' };
    } });
}

export async function updateField(ctx, appToken, table, fieldName, patch) {
  const t = await resolveTable(appToken, table);
  if (!t.ok) return t;
  const cur = await listFields(appToken, t.table_id);
  if (!cur.ok) return cur;
  const target = cur.fields.find((f) => f.name === String(fieldName).trim());
  if (!target) return bad('not_found', `表里没有字段「${fieldName}」`, { fields: cur.fields.map((f) => f.name) });

  const data = {};
  if (patch?.name) data.field_name = String(patch.name).trim();
  if (patch?.type !== undefined) {
    const ty = fieldTypeOf(patch.type);
    if (ty === null) return bad('bad_field_type', `类型「${patch.type}」不认识`);
    data.type = ty;
  }
  if (Object.keys(data).length === 0) return bad('bad_args', '没有要改的东西（name / type 至少要给一个）');

  return withWrite({ op: 'update_field', appToken, tableId: t.table_id,
    args: { field_id: target.field_id, from: target.name, patch: data }, ctx,
    // ③ 改字段前留旧定义 —— 改字段也可能「改错回不去」，与删除同一类风险
    step: async () => {
      const snap = snapshotBefore('delete_field', { readable: true, field: { ...target } });
      const r = await call(C().bitable.appTableField.update.bind(C().bitable.appTableField),
        { path: { app_token: appToken, table_id: t.table_id, field_id: target.field_id }, data });
      if (!r.ok) return r;
      const back = await listFields(appToken, t.table_id);
      const after = back.ok ? back.fields.find((f) => f.field_id === target.field_id) : null;
      const want = data.field_name ?? target.name;
      const good = !!after && after.name === want;
      return { ledger_extra: snap.ok ? { pre_image: snap.snapshot } : { pre_image_error: snap.reason },
        readback: good ? 'consistent' : 'mismatch',
        readback_detail: good ? `字段现为「${after.name}」` : '回读与预期不一致' };
    } });
}

/** 两段式第一步：把「要删什么」定下来、存起来，**一个删除请求都不发**。 */
function proposeDelete(ctx, op, appToken, tableId, preview, args) {
  const now = Date.now();
  const key = ctx?.chatId ?? '_';
  const all = readPending();
  const prev = all[key] ?? null;
  all[key] = { op, app_token: appToken, table_id: tableId, preview, args,
    requestMessageId: ctx?.messageId ?? null, requestedBy: ctx?.senderName ?? null,
    chatId: key, createdAt: now, expiresAt: now + PENDING_TTL_MS };
  let saved = true; let err = null;
  try { writePending(all); } catch (e) { saved = false; err = String(e?.message ?? e); }

  const will = describeDelete(op, preview);
  logWrite({ op: `propose_${op}`, app_token: appToken, table_id: tableId, args,
    who: { sender: ctx?.senderName ?? null, sender_open_id: ctx?.senderOpenId ?? null,
           chat_id: ctx?.chatId ?? null, message_id: ctx?.messageId ?? null },
    result: saved ? 'ok' : 'failed', readback: null, readback_detail: null,
    note: '两段式第一步：只提议，未执行' });

  return { ok: true, pending: true, op, will,
    replaced_previous: prev ? describeDelete(prev.op, prev.preview) : null,
    expires_in_min: Math.round(PENDING_TTL_MS / 60000),
    ...(saved ? {} : { pending_saved: false, pending_error: err }),
    readback: 'untested',
    readback_detail: '**还没有删** —— 这一步只提议。要把这句话原样说给对方，'
      + '等对方在**另一条消息**里确认之后，才调 lark_base_confirm_delete。' };
}

export async function deleteField(ctx, appToken, table, fieldName, { confirmed = false } = {}) {
  const t = await resolveTable(appToken, table);
  if (!t.ok) return t;
  const cur = await listFields(appToken, t.table_id);
  if (!cur.ok) return cur;
  const target = cur.fields.find((f) => f.name === String(fieldName).trim());
  if (!target) return bad('not_found', `表里没有字段「${fieldName}」`, { fields: cur.fields.map((f) => f.name) });

  // ★ 两段式的第一段：没带 confirmed 就只提议，绝不执行
  if (!confirmed) {
    const recs = await listRecords(appToken, t.table_id, { limit: 500 });
    const nonempty = recs.ok
      ? (recs.records ?? []).filter((r) => flat(r.fields?.[target.name]).trim() !== '').length
      : null;   // 读不到就是**未测**，不许写成 0（§2.4.1）
    return proposeDelete(ctx, 'delete_field', appToken, t.table_id,
      { table_id: t.table_id, table_name: t.name ?? t.table_id, field_id: target.field_id,
        field_name: target.name, nonempty, records_readable: recs.ok },
      { field_name: target.name });
  }

  return withWrite({ op: 'delete_field', appToken, tableId: t.table_id,
    args: { field_id: target.field_id, name: target.name }, ctx,
    step: async () => {
      const snap = snapshotBefore('delete_field', { readable: true, field: target });
      // ★ 执行点：快照没凑齐就**不删**。删字段不可逆（连带那一列的数据）
      if (!snap.ok) return bad('snapshot_failed', `删除前快照凑不齐，已中止：${snap.reason}`);
      const r = await call(C().bitable.appTableField.delete.bind(C().bitable.appTableField),
        { path: { app_token: appToken, table_id: t.table_id, field_id: target.field_id } });
      if (!r.ok) return { ...r, ledger_extra: { pre_image: snap.snapshot } };
      const back = await listFields(appToken, t.table_id);
      const gone = back.ok && !back.fields.some((f) => f.field_id === target.field_id);
      return { ledger_extra: { pre_image: snap.snapshot },
        readback: gone ? 'consistent' : 'mismatch',
        readback_detail: gone ? '字段已不在列表里' : '接口返回 ok，但回读列表里还有它' };
    } });
}

export async function deleteTable(ctx, appToken, table, { confirmed = false } = {}) {
  const t = await resolveTable(appToken, table);
  if (!t.ok) return t;

  // ★ 两段式的第一段
  if (!confirmed) {
    const flds = await listFields(appToken, t.table_id);
    const recs = await listRecords(appToken, t.table_id, { limit: 500 });
    return proposeDelete(ctx, 'delete_table', appToken, t.table_id,
      { table_id: t.table_id, table_name: t.name ?? t.table_id,
        field_count: flds.ok ? flds.fields.length : null,
        record_count: recs.ok ? (recs.total ?? (recs.records ?? []).length) : null,
        readable: flds.ok && recs.ok },
      { name: t.name });
  }

  return withWrite({ op: 'delete_table', appToken, tableId: t.table_id, args: { name: t.name }, ctx,
    step: async () => {
      // ③ 删表是最大的一刀：先把「整张表 + 全部字段 + 全部记录」搬进留痕再动手。
      //    三样缺任何一样都不许删 —— 特别是**读不到**的时候：那时搬不走的东西
      //    就永远搬不走了（`readable` 那道门就是拦这个，见 snapshotBefore 的注释）。
      const tabs = await listTablesRaw(appToken);
      const flds = await listFields(appToken, t.table_id);
      const recs = await listRecords(appToken, t.table_id, { limit: 500 });
      const snap = snapshotBefore('delete_table', {
        readable: tabs.ok && flds.ok && recs.ok,
        readable_detail: [tabs.ok ? null : `表列表读不到(${tabs.msg})`,
                          flds.ok ? null : `字段读不到(${flds.msg})`,
                          recs.ok ? null : `记录读不到(${recs.msg})`].filter(Boolean).join('；') || null,
        tables: tabs.ok ? tabs.items : null, table_id: t.table_id, table_name: t.name,
        fields: flds.ok ? flds.fields : null, records: recs.ok ? recs.records : null,
        records_total: recs.ok ? recs.total : null,
      });
      if (!snap.ok) return bad('snapshot_failed', `删除前快照凑不齐，已中止：${snap.reason}`);
      const r = await call(C().bitable.appTable.delete.bind(C().bitable.appTable),
        { path: { app_token: appToken, table_id: t.table_id } });
      if (!r.ok) return { ...r, ledger_extra: { pre_image: snap.snapshot } };
      const back = await listTablesRaw(appToken);
      const gone = back.ok && !back.items.some((x) => x.table_id === t.table_id);
      return { ledger_extra: { pre_image: snap.snapshot },
        readback: gone ? 'consistent' : 'mismatch',
        readback_detail: gone ? '表已不在列表里' : '接口返回 ok，但回读列表里还有它' };
    } });
}

export async function createRecords(ctx, appToken, table, records) {
  const t = await resolveTable(appToken, table);
  if (!t.ok) return t;
  if (!Array.isArray(records) || records.length === 0) return bad('bad_args', 'records 不能为空');
  if (tooManyRecords(records.length)) {
    return bad('too_many', `一次最多写 ${MAX_RECORDS_PER_CALL} 条，你给了 ${records.length} 条 —— 请分批，` +
      `不要让我悄悄截断（截断会让人以为全写进去了）`);
  }
  const payload = records.map((f) => ({ fields: f }));

  return withWrite({ op: 'create_records', appToken, tableId: t.table_id,
    args: { count: records.length, sent: records }, ctx,
    step: async () => {
      const r = await call(C().bitable.appTableRecord.batchCreate.bind(C().bitable.appTableRecord),
        { path: { app_token: appToken, table_id: t.table_id }, data: { records: payload } });
      if (!r.ok) return r;
      const ids = (r.data.records ?? []).map((x) => x.record_id);
      // ② 回读：按返回的 id 取回来，逐字段比
      const back = await call(C().bitable.appTableRecord.batchGet.bind(C().bitable.appTableRecord),
        { path: { app_token: appToken, table_id: t.table_id }, data: { record_ids: ids } });
      if (!back.ok) {
        return { record_ids: ids, readback: 'untested',
          readback_detail: `写入返回 ${ids.length} 个 id，但回读失败（${back.msg}）—— `
            + `所以「写进去了没有」我答不了，这是**未测**，不是成功` };
      }
      const got = back.data.records ?? [];
      if (got.length !== records.length) {
        return { record_ids: ids, readback: 'mismatch',
          readback_detail: `写入 ${records.length} 条，回读到 ${got.length} 条` };
      }
      const bads = [];
      got.forEach((g, i) => {
        const v = verifyReadback(records[i], g.fields);
        if (v.mismatches.length) bads.push({ index: i, ...v.mismatches[0] });
      });
      return { record_ids: ids,
        readback: bads.length ? 'mismatch' : 'consistent',
        readback_detail: bads.length ? `${bads.length} 条字段与写入不一致` : `${got.length} 条逐字段一致`,
        ...(bads.length ? { readback_mismatches: bads.slice(0, 5) } : {}) };
    } });
}

export async function updateRecords(ctx, appToken, table, records) {
  const t = await resolveTable(appToken, table);
  if (!t.ok) return t;
  if (!Array.isArray(records) || records.length === 0) return bad('bad_args', 'records 不能为空');
  if (tooManyRecords(records.length)) {
    return bad('too_many', `一次最多改 ${MAX_RECORDS_PER_CALL} 条，你给了 ${records.length} 条 —— 请分批`);
  }
  const payload = records.map((r) => ({ record_id: r.record_id, fields: r.fields }));
  if (payload.some((p) => !p.record_id)) return bad('bad_args', '每条都要带 record_id');

  return withWrite({ op: 'update_records', appToken, tableId: t.table_id,
    args: { count: records.length, ids: payload.map((p) => p.record_id), sent: records }, ctx,
    step: async () => {
      // ③ 改记录前留旧值（改错回不去，与删除同一类）。
      //    ★ 读不到旧值就**不改**：盖掉的那个值如果没搬走，就永远搬不走了。
      const before = await call(C().bitable.appTableRecord.batchGet.bind(C().bitable.appTableRecord),
        { path: { app_token: appToken, table_id: t.table_id },
          data: { record_ids: payload.map((p) => p.record_id) } });
      if (!before.ok) {
        return bad('snapshot_failed',
          `改之前读不到这些记录的旧值（${before.msg}）—— 没搬走旧值就不改，已中止`);
      }
      const old = before.data.records ?? [];
      const pre = snapshotBefore('delete_records',
        { readable: true, records: old, requested: payload.map((p) => p.record_id) });
      if (!pre.ok) return bad('snapshot_failed', `改前快照凑不齐，已中止：${pre.reason}`);

      const r = await call(C().bitable.appTableRecord.batchUpdate.bind(C().bitable.appTableRecord),
        { path: { app_token: appToken, table_id: t.table_id }, data: { records: payload } });
      if (!r.ok) return { ...r, ledger_extra: { pre_image: pre.snapshot } };

      const back = await call(C().bitable.appTableRecord.batchGet.bind(C().bitable.appTableRecord),
        { path: { app_token: appToken, table_id: t.table_id },
          data: { record_ids: payload.map((p) => p.record_id) } });
      if (!back.ok) {
        return { ledger_extra: { pre_image: pre.snapshot }, readback: 'untested',
          readback_detail: '改完回读失败 —— 「改成了没有」我答不了，这是未测' };
      }
      const got = Object.fromEntries((back.data.records ?? []).map((x) => [x.record_id, x.fields]));
      const bads = [];
      for (const p of payload) {
        const v = verifyReadback(p.fields, got[p.record_id]);
        if (v.mismatches.length) bads.push({ record_id: p.record_id, ...v.mismatches[0] });
      }
      return { ledger_extra: { pre_image: pre.snapshot },
        readback: bads.length ? 'mismatch' : 'consistent',
        readback_detail: bads.length ? `${bads.length} 条回读与写入不一致` : `${payload.length} 条逐字段一致`,
        ...(bads.length ? { readback_mismatches: bads.slice(0, 5) } : {}) };
    } });
}

export async function deleteRecords(ctx, appToken, table, recordIds, { confirmed = false } = {}) {
  const t = await resolveTable(appToken, table);
  if (!t.ok) return t;
  const ids = (recordIds ?? []).map((x) => String(x).trim()).filter(Boolean);
  if (!ids.length) return bad('bad_args', 'record_ids 不能为空');
  if (tooManyRecords(ids.length)) {
    return bad('too_many', `一次最多删 ${MAX_RECORDS_PER_CALL} 条，你给了 ${ids.length} 条 —— 请分批`);
  }

  // ★ 两段式的第一段：把「要删哪几条、那几条长什么样」摆出来给人看
  if (!confirmed) {
    const peek = await call(C().bitable.appTableRecord.batchGet.bind(C().bitable.appTableRecord),
      { path: { app_token: appToken, table_id: t.table_id }, data: { record_ids: ids } });
    const sample = peek.ok
      ? (peek.data.records ?? []).slice(0, 3).map((r) => {
        const f = r.fields ?? {};
        const k = Object.keys(f)[0];
        return k ? `${k}=${flat(f[k])}` : r.record_id;
      })
      : null;   // 读不到 → 未测，见 describeDelete 的调用方
    return proposeDelete(ctx, 'delete_records', appToken, t.table_id,
      { table_id: t.table_id, table_name: t.name ?? t.table_id, ids, sample,
        sample_readable: peek.ok, found: peek.ok ? (peek.data.records ?? []).length : null },
      { ids });
  }

  return withWrite({ op: 'delete_records', appToken, tableId: t.table_id,
    args: { count: ids.length, ids }, ctx,
    step: async () => {
      // ③ 把要被删掉的**完整内容**搬进留痕，再删。
      //    ★ 这里是本文件最要紧的一道门，也是自证第一次运行就抓到洞的地方：
      //      原写法 `{ records: found ?? [] }` 在**读不到**时传了空数组，
      //      而空数组 = 合法的「零条」→ 判定通过 → 照删。
      //      **「读不到」被 `?? []` 变成了「没有」。** 现在读不到就直接中止。
      const before = await call(C().bitable.appTableRecord.batchGet.bind(C().bitable.appTableRecord),
        { path: { app_token: appToken, table_id: t.table_id }, data: { record_ids: ids } });
      if (!before.ok) {
        return bad('snapshot_failed',
          `删之前读不到这些记录的旧值（${before.msg}）—— 搬不走就不删，已中止`);
      }
      const found = before.data.records ?? [];
      const snap = snapshotBefore('delete_records', { readable: true, records: found, requested: ids });
      if (!snap.ok) return bad('snapshot_failed', `删除前快照凑不齐，已中止：${snap.reason}`);
      if (found.length !== ids.length) {
        return { ok: false, code: 'id_mismatch',
          msg: `你要删 ${ids.length} 条，但只读回 ${found.length} 条 —— 中止，避免误删`,
          ledger_extra: { pre_image: snap.snapshot } };
      }
      const r = await call(C().bitable.appTableRecord.batchDelete.bind(C().bitable.appTableRecord),
        { path: { app_token: appToken, table_id: t.table_id }, data: { records: ids } });
      if (!r.ok) return { ...r, ledger_extra: { pre_image: snap.snapshot } };
      const back = await call(C().bitable.appTableRecord.batchGet.bind(C().bitable.appTableRecord),
        { path: { app_token: appToken, table_id: t.table_id }, data: { record_ids: ids } });
      // 回读失败 → 未测；回读成功且一条都不剩 → consistent
      if (!back.ok) {
        return { ledger_extra: { pre_image: snap.snapshot }, readback: 'untested',
          readback_detail: '删完回读失败 —— 「删掉了没有」我答不了，这是未测' };
      }
      const left = (back.data.records ?? []).length;
      return { ledger_extra: { pre_image: snap.snapshot },
        readback: left === 0 ? 'consistent' : 'mismatch',
        readback_detail: left === 0 ? `${ids.length} 条都已不在` : `还剩 ${left} 条没删掉`,
        deleted: ids.length - left };
    } });
}

/* ─────────────── 两段式第二步：拿待确认的那一条去执行 ─────────────── */

/**
 * 对方在**另一条消息**里确认之后，才走这里。
 *
 * ★ 它自己不做任何判断 —— 判断全在 `judgeConfirm()`（纯函数，自证直接喂样本）。
 *   它只负责：读 pending → 判 → 放行就调真删除 → 无论成败都清掉 pending。
 *
 * ★ 「无论成败都清掉」是有意的：一次失败的删除如果留着 pending，
 *   下一次任何人说一句「确认」都会重放它 —— 那是把一次误触变成一条常设指令。
 *   要重试就重新提一次，走完整的两段式。
 */
export async function confirmDelete(ctx) {
  const key = ctx?.chatId ?? '_';
  const all = readPending();
  const entry = all[key] ?? null;
  const v = judgeConfirm(entry, ctx);
  const who = { sender: ctx?.senderName ?? null, sender_open_id: ctx?.senderOpenId ?? null,
    chat_id: ctx?.chatId ?? null, message_id: ctx?.messageId ?? null };

  if (!v.ok) {
    logWrite({ op: 'confirm_delete', who, result: 'failed', code: v.code, msg: v.msg,
      readback: null, readback_detail: null, note: '两段式第二步被拒，未执行任何删除' });
    return bad(v.code, v.msg, {
      pending: entry ? describeDelete(entry.op, entry.preview) : null,
    });
  }

  const { op, app_token: at, preview, args } = entry;
  let r;
  if (op === 'delete_records') r = await deleteRecords(ctx, at, preview.table_id, args.ids, { confirmed: true });
  else if (op === 'delete_field') r = await deleteField(ctx, at, preview.table_id, args.field_name, { confirmed: true });
  else if (op === 'delete_table') r = await deleteTable(ctx, at, preview.table_id, { confirmed: true });
  else r = bad('unknown_pending', `待确认的动作不认识：${op}`);

  let cleared = true;
  try {
    const after = readPending();
    delete after[key];
    writePending(after);
  } catch (e) { cleared = false; }

  return { ...r, confirmed_by_message: ctx?.messageId ?? null, what: describeDelete(op, preview),
    ...(cleared ? {} : { pending_cleared: false,
      pending_error: '清 pending 失败 —— 请再说一次「取消」，否则下一条「确认」可能重放它' }) };
}

/** 对方说「算了」。同一条消息里取消也行（取消是收窄，不需要两段式）。 */
export async function cancelDelete(ctx) {
  const key = ctx?.chatId ?? '_';
  const all = readPending();
  const entry = all[key] ?? null;
  if (!entry) return { ok: true, cancelled: false, note: '当前没有待确认的删除' };
  const what = describeDelete(entry.op, entry.preview);
  delete all[key];
  try { writePending(all); } catch (e) {
    return bad('write_failed', `取消失败（${String(e?.message ?? e)}）—— 那条提议还在，请重试`);
  }
  logWrite({ op: 'cancel_delete', who: { sender: ctx?.senderName ?? null, chat_id: key,
    message_id: ctx?.messageId ?? null }, result: 'ok', readback: null,
    readback_detail: null, note: `已取消：${what}` });
  return { ok: true, cancelled: true, what, readback: 'consistent', readback_detail: '已取消，一个删除请求都没发' };
}

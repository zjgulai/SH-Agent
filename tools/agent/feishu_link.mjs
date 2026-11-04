/**
 * feishu_link.mjs —— 飞书链接怎么读：**读正文，不下载**
 *
 * ── 为什么要有这个文件（2026-10-22 真事故，Owner 转发守衡的回复）
 *
 * 有人发给守衡一条飞书云空间链接（`/file/...`，一份 pptx brief），守衡回：
 * 「链接内容未能读取（**域名解析到非公网地址**，已阻止读取）」。
 *
 * 盘上的真因不是那条链接，而是**飞书链接根本没走飞书的读法**：
 *   · `link_reader.mjs` 只读**匿名公网页面**；
 *   · 飞书网页一律 302 到 `accounts.feishu.cn`（登录页），而本机 DNS 把这个域名解析到
 *     私网地址（实测 `10.0.0.100`）⇒ 被 SSRF 守卫拦下；
 *   · 实测 `/docx/`、`/base/`、`/file/` 三种飞书链接**全部**报同一句 —— 也就是说
 *     **任何飞书链接都读不了**，而那句话把原因指向「DNS」，指偏了。
 *
 * 飞书文档本来就有**只读正文**的通道（`docx/v1/.../raw_content`、`sheets`、`bitable`、
 * `wiki/v2/spaces/get_node`），这条通道在 `tools/feishu_index.py` 里用了很久，
 * 只是从来没接进「链接送审」这条路。本文件就是那一接。
 *
 * ── 边界（AGENTS.md §2.6 红线，一个字没松）
 *
 *   · 只调**只读内容接口**。云空间附件（`/file/` 的 pptx / pdf / xlsx …）在飞书 OpenAPI 里
 *     **没有**原文读取接口，`download` 是唯一内容通道 ⇒ **不下载、不探测**，
 *     直接回「按红线不取」并给出替代路径（贴正文 / 转成飞书文档）。
 *   · 本文件**没有**任何 `download` / `medias` 调用。守住它的不是这段注释，是
 *     `verify_feishu_index.py` 的 M 段（全仓唯一取字节点）—— 注释不会让谁变红。
 *   · 失败一律 fail-closed：抛出 `FeishuLinkError`，带一句给用户看的话（`shouhengReply`），
 *     由 `review_gate.prepareLinkReview` 原样发出；**绝不**在没读到正文时给审核结论。
 *
 * ── 与公开网页那条路的关系
 *
 * `readLink()` 是**唯一的分流点**：飞书域名 → 本文件；其余 → `link_reader.readPublicPage`。
 * 分流判据是**纯函数**（`classifyFeishuLink`），所以能离线反向对照：
 * 喂 `feishu.cn.evil.com` / `notfeishu.cn` 必须**不**被当成飞书链接（见自证）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readPublicPage } from './link_reader.mjs';
import { stoppedFeishuResource } from './feishu_read_policy.mjs';

const KB_ROOT = process.env.SHOUHENG_KB_ROOT
  || path.join(os.homedir(), 'Documents/skill-test/执行skills/执行skills/skills-回归测试/知识库/内容治理');

/**
 * ★★ 2026-10-27（Owner 实测 `https://momcozy-in.feishu.cn/wiki/WUSSwrUlQiKOEskAtsKcM6l6n5b`）：
 *   飞书 `file` / `wiki-file` 节点本身按红线 §2.6 不通过飞书 API 下载，但如果该 token
 *   已经作为知识库 L1 解析文本存在于本地（`kb/l1/{1_外部标准库,2_内部正负样本库,3_措辞表达库}/*<token>*.json`），
 *   直接只读复用本地 L1 已提取的正文（零网络下载、零越权），让已入库 PDF/附件链接能正常完成审查！
 */
function readLocalKbParsedText(token, objToken = null) {
  const toks = [token, objToken].map((x) => String(x ?? '').trim()).filter((x) => x.length >= 8);
  if (!toks.length) return null;
  const subdirs = ['1_外部标准库', '2_内部正负样本库', '3_措辞表达库'];
  let bestText = '';
  let bestTitle = null;
  for (const sub of subdirs) {
    const dir = path.join(KB_ROOT, 'kb', 'l1', sub);
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      if (!toks.some((t) => name.includes(t))) continue;
      try {
        const d = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        const segs = Array.isArray(d?.segments) ? d.segments : [];
        const txt = segs
          .map((s) => String(s?.text ?? '').trim())
          .filter((s) => s && !s.startsWith('{\n  "ok": true'))
          .join('\n\n');
        if (txt.length > bestText.length) {
          bestText = txt;
          bestTitle = d?.title || (d?.pdf_local_path ? path.basename(d.pdf_local_path) : null);
        }
      } catch { /* ignore bad json */ }
    }
  }
  return bestText.length >= 50 ? { text: bestText, title: bestTitle } : null;
}

/** 飞书租户域名。子域也算（`momcozy-in.feishu.cn` 这类）。 */
const FEISHU_HOST_RE = /(^|\.)(feishu\.cn|larksuite\.com|larkoffice\.com)$/i;

/** 路径第一段 → 文档形态。认不出来就是 `unknown`（照样说清楚，不许猜内容）。 */
const PATH_KINDS = Object.freeze({
  docx: 'docx',
  doc: 'doc',
  docs: 'doc',
  wiki: 'wiki',
  sheets: 'sheet',
  base: 'bitable',
  file: 'file',
  slides: 'slides',
  mindnote: 'mindnote',
});

/** 形态 → 给人看的名字。**只用来组织句子**，不许拿它冒充「读到了」。 */
export const KIND_LABEL = Object.freeze({
  docx: '飞书文档',
  doc: '旧版飞书文档',
  sheet: '飞书表格',
  bitable: '飞书多维表格',
  wiki: '飞书知识库节点',
  file: '飞书云空间附件',
  'wiki-file': '飞书知识库里的附件',
  slides: '飞书幻灯片',
  mindnote: '飞书思维笔记',
  unknown: '飞书链接',
});

/**
 * ★ 上限写成常量而不是散在调用点：超限要**搬**不要**砍**（AGENTS.md §2.4）——
 *   这里换成「读到一个够用的量就停」，而「没读的部分」必须在正文里说清楚（见 note）。
 */
const MAX_CHARS = 30_000;
const MAX_SHEETS = 3;
const MAX_ROWS = 100;
const MAX_COLS = 12;
const MAX_TABLES = 3;
const MAX_RECORDS = 100;

/** 失败尾巴：与公开网页那条路**同一句**，fail-closed 的话术只允许有一个版本。 */
const FAIL_TAIL = '未读取到的内容不会判为通过。';

export function isFeishuHost(hostname) {
  return FEISHU_HOST_RE.test(String(hostname ?? '').toLowerCase());
}

/**
 * 判一条链接是不是飞书、是哪一种飞书文档。**纯函数、不联网**。
 *
 * @returns {{isFeishu:boolean, invalid:boolean, kind:string|null, token:string|null,
 *            url:string|null, segment:string|null}}
 *   · `invalid` = 根本不是 http(s) URL（交给下游报「链接格式无效」）；
 *   · `isFeishu:false, invalid:false` = 普通公网链接（走 `readPublicPage`）；
 *   · `kind:'unknown'` = 是飞书域名，但路径认不出来 —— **不猜**，照实说读不了。
 */
export function classifyFeishuLink(value) {
  let url = null;
  try { url = new URL(String(value)); } catch { /* 不是 URL，下面统一处理 */ }
  if (!url || !['http:', 'https:'].includes(url.protocol)) {
    return { isFeishu: false, invalid: true, kind: null, token: null, url: null, segment: null };
  }
  if (!isFeishuHost(url.hostname)) {
    return { isFeishu: false, invalid: false, kind: null, token: null, url: url.toString(), segment: null };
  }
  const segs = url.pathname.split('/').filter(Boolean);
  const segment = String(segs[0] ?? '').toLowerCase();
  const kind = Object.prototype.hasOwnProperty.call(PATH_KINDS, segment) ? PATH_KINDS[segment] : 'unknown';
  const raw = segs[1] ?? '';
  // token 是**不透明串**：只做形状检查（够长、只含字母数字），不去猜它到底是什么。
  const token = /^[A-Za-z0-9]{8,}$/.test(raw) ? raw : null;
  return { isFeishu: true, invalid: false, kind, token, url: url.toString(), segment };
}

/** 读飞书链接失败时抛这个 —— `shouhengReply` 就是要发给用户的那句话。 */
export class FeishuLinkError extends Error {
  constructor({ kind, title = null, detail = '', reply }) {
    super(detail || reply);
    this.name = 'FeishuLinkError';
    this.linkKind = kind;
    this.linkTitle = title;
    this.shouhengReply = reply;
  }
}

function titled(title) {
  return title ? `《${title}》` : '';
}

/**
 * 读不了时**该说的那句话**。按形态分开写，因为「为什么读不了」根本不是同一个原因：
 * 附件是**红线**（策略，永远读不了）；幻灯片/思维笔记是**飞书没接口**；
 * 接口报错是**权限或不存在**（可修）。把三种揉成一句，人就会去申请一个不需要的权限。
 */
export function unreadableReply(kind, title = null, detail = '') {
  const label = KIND_LABEL[kind] ?? KIND_LABEL.unknown;
  const head = `这条链接是${label}${titled(title)}`;

  if (kind === 'file' || kind === 'wiki-file') {
    return `${head}，不是文档。飞书对附件没有原文读取接口，按红线「飞书内容禁止下载」我也不取附件，`
      + '所以这次读不到正文。可以改走：① 把正文（或关键段落）直接贴给我；'
      + '② 复制到一篇飞书文档里，再把文档链接发我；③ 把要点用文字发我，我按文字流程审。'
      + FAIL_TAIL;
  }
  if (kind === 'slides') {
    return `${head}。飞书没有幻灯片正文的只读接口（只剩导出/下载，按红线不取），所以这次读不到页面内容。`
      + '可以改走：① 把每页文字贴给我；② 另存或复制成一篇飞书文档，再把文档链接发我。'
      + FAIL_TAIL;
  }
  if (kind === 'mindnote') {
    return `${head}。飞书没有思维笔记正文的只读接口，这次读不到内容。`
      + '可以把要点贴成文字，或转成飞书文档再把链接发我。'
      + FAIL_TAIL;
  }
  if (kind === 'doc') {
    return `${head}。飞书只给新版文档（/docx/）提供正文读取接口，旧版 /docs/ 读不到。`
      + '可以在飞书里把它转成新版文档后重发链接，或直接把正文贴给我。'
      + FAIL_TAIL;
  }
  if (kind === 'unknown') {
    return `${head}，但我认不出这是哪一种飞书文档（不是 /docx/、/sheets/、/base/、/wiki/、/file/ 这几种）。`
      + '飞书网页要登录态，按网页抓是读不到正文的。请直接发正文，或发飞书文档链接（/docx/...）。'
      + FAIL_TAIL;
  }
  // 其余（docx / sheet / bitable / wiki 这几条**本可以读**的）：接口没读成，多半是权限或文档不存在。
  const why = String(detail ?? '').trim() || '接口没返回正文';
  return `${head}读不出来（${why}）。飞书这条通道要求应用对这篇文档可见；`
    + '确认权限（或确认文档还在）之后重发链接，或直接把正文贴给我。' + FAIL_TAIL;
}

export function emptyReply(kind, title = null) {
  const label = KIND_LABEL[kind] ?? KIND_LABEL.unknown;
  return `这篇${label}${titled(title)}读到了，但正文是空的 —— 没有可审的内容。`
    + '请确认链接有没有发错，或直接把正文贴给我。空内容不判为通过。';
}

function unreadable(kind, title, detail) {
  return new FeishuLinkError({ kind, title, detail, reply: unreadableReply(kind, title, detail) });
}

function assertReadingAllowed(token, kind, policyPath) {
  let resource;
  try {
    resource = stoppedFeishuResource(token, policyPath);
  } catch (error) {
    throw new FeishuLinkError({
      kind, detail: `停读清单读取失败：${error.message}`,
      reply: `停读清单暂时无法读取，本次未读取这条飞书资源。${FAIL_TAIL}`,
    });
  }
  if (resource) throw new FeishuLinkError({
    kind, title: resource.name, detail: `资源已停读：${token}`,
    reply: `《${resource.name}》已从守衡读取范围中移除，不再读取。${FAIL_TAIL}`,
  });
}

/* ─────────────────────────── 真正的读取 ─────────────────────────── */

/** 生产实现：走 SDK 的通用 `request`（`url` 以 `/open-apis/` 开头即可）。 */
async function defaultRequest(path, { method = 'GET', data } = {}) {
  // 惰性 import：单测注入 `request` 时**不碰凭据、不发网络**。
  const { client } = await import('./feishu.mjs');
  try {
    const r = await client.request({ method, url: path, data });
    return { code: r?.code ?? 0, msg: r?.msg ?? '', data: r?.data ?? {} };
  } catch (e) {
    // SDK 在非 0 时抛：错误体在 response.data 里，尽量取出来 —— 只报「失败了」是答不了的
    const body = e?.response?.data ?? e?.data ?? null;
    return {
      code: body?.code ?? 'unknown',
      msg: body?.msg ?? String(e?.message ?? e).slice(0, 300),
      data: {},
    };
  }
}

function errText(r) {
  const code = r?.code ?? 'unknown';
  const msg = String(r?.msg ?? '').trim();
  return `code=${code}${msg ? ` ${msg}` : ''}`;
}

async function readDocx(request, token) {
  const r = await request(`/open-apis/docx/v1/documents/${token}/raw_content`);
  if (r?.code !== 0) return { ok: false, detail: errText(r) };
  return { ok: true, text: String(r?.data?.content ?? '') };
}

async function readOldDoc(request, token) {
  const r = await request(`/open-apis/doc/v2/${token}/content`);
  if (r?.code !== 0) return { ok: false, detail: errText(r) };
  const body = r?.data?.content ?? r?.data?.body ?? '';
  return { ok: true, text: String(body ?? '') };
}

function colLetter(n) {
  let s = '';
  let x = Math.max(1, Number(n) || 1);
  while (x > 0) {
    const m = (x - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

function cellText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(cellText).filter(Boolean).join(' / ');
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.name === 'string') return value.name;
    if (typeof value.link === 'string') return value.link;
    if (typeof value.file_token === 'string') return value.name ? String(value.name) : '（附件）';
    try { return JSON.stringify(value).slice(0, 120); } catch { return ''; }
  }
  return '';
}

async function readSheet(request, token) {
  const q = await request(`/open-apis/sheets/v3/spreadsheets/${token}/sheets/query`);
  if (q?.code !== 0) return { ok: false, detail: errText(q) };
  const sheets = (q?.data?.sheets ?? []).slice(0, MAX_SHEETS);
  if (!sheets.length) return { ok: false, detail: '这个表格里没有可读的工作表' };
  const blocks = [];
  let skippedSheets = Math.max(0, (q?.data?.sheets ?? []).length - MAX_SHEETS);
  for (const s of sheets) {
    const sheetId = s?.sheet_id;
    if (!sheetId) continue;
    const rows = Math.max(1, Math.min(Number(s?.grid_properties?.row_count) || 50, MAX_ROWS));
    const cols = Math.max(1, Math.min(Number(s?.grid_properties?.column_count) || 10, MAX_COLS));
    if (Number(s?.grid_properties?.row_count) > MAX_ROWS) skippedSheets += 1;
    const range = `${sheetId}!A1:${colLetter(cols)}${rows}`;
    const v = await request(
      // range 只含 token/表 id/列字母/数字与 `!`、`:` —— 原样放进 path（编码反而会让服务端认不出区间）
      `/open-apis/sheets/v2/spreadsheets/${token}/values/${range}?valueRenderOption=ToString`);
    if (v?.code !== 0) return { ok: false, detail: errText(v) };
    const values = v?.data?.valueRange?.values ?? v?.data?.values ?? [];
    const body = values
      .map((row) => (Array.isArray(row) ? row : []).map(cellText).join(' | '))
      .filter((line) => line.replace(/[|\s]/g, ''))
      .join('\n');
    blocks.push(`【工作表：${s?.title ?? sheetId}】\n${body || '（这张表是空的）'}`);
  }
  if (!blocks.length) return { ok: false, detail: '表格的工作表都读不出内容' };
  // ★ 说明放在**最前面**：正文最后会被 `MAX_CHARS` 截断，放尾部等于「没读全」这句话被截掉 ——
  //   那正是 §2.4.1 说的形状（未测被静默成完整）。
  const note = skippedSheets
    ? `（这张表太大：只读了前 ${MAX_SHEETS} 个工作表、每个前 ${MAX_ROWS} 行；没读的部分不在下面。）\n`
    : '';
  return { ok: true, text: note + blocks.join('\n\n') };
}

async function readBitable(request, token) {
  const t = await request(`/open-apis/bitable/v1/apps/${token}/tables?page_size=100`);
  if (t?.code !== 0) return { ok: false, detail: errText(t) };
  const all = t?.data?.items ?? [];
  const tables = all.slice(0, MAX_TABLES);
  if (!tables.length) return { ok: false, detail: '这个多维表格里没有数据表' };
  const blocks = [];
  let moreRecords = 0;
  for (const table of tables) {
    const r = await request(
      `/open-apis/bitable/v1/apps/${token}/tables/${table.table_id}/records?page_size=${MAX_RECORDS}`);
    if (r?.code !== 0) return { ok: false, detail: errText(r) };
    const items = r?.data?.items ?? [];
    if (r?.data?.has_more) moreRecords += 1;
    const lines = items.map((rec, i) => {
      const fields = rec?.fields ?? {};
      const kv = Object.entries(fields)
        .map(([k, v]) => `${k}：${cellText(v)}`)
        .filter((s) => !s.endsWith('：'));
      return `${i + 1}. ${kv.join('；') || '（这条记录没填内容）'}`;
    });
    blocks.push(`【数据表：${table?.name ?? table.table_id}｜本页 ${items.length} 条】`
      + `\n${lines.join('\n') || '（这张表没有记录）'}`);
  }
  const limits = [];
  if (all.length > MAX_TABLES) limits.push(`共 ${all.length} 张表，只读了前 ${MAX_TABLES} 张`);
  if (moreRecords) limits.push(`有 ${moreRecords} 张表超过 ${MAX_RECORDS} 条，只读了前 ${MAX_RECORDS} 条`);
  const note = limits.length ? `（这个多维表格没读全：${limits.join('；')}；没读的部分不在下面。）\n` : '';
  return { ok: true, text: note + blocks.join('\n\n') };
}

async function readWiki(request, token, policyPath) {
  const n = await request(`/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(token)}`);
  if (n?.code !== 0) return { ok: false, detail: errText(n) };
  const node = n?.data?.node ?? {};
  const objType = String(node?.obj_type ?? '');
  const objToken = node?.obj_token ?? null;
  const title = node?.title ?? null;
  if (!objToken) return { ok: false, detail: '知识库节点里没有指向正文的 obj_token' };
  // 新的 Wiki 别名也不能绕过已停读的正文对象；同样拦住本地 L1 正文复用。
  assertReadingAllowed(objToken, objType, policyPath);
  const withMeta = (fn) => fn(request, objToken).then((r) => ({
    ...r, title, kind: objType === 'bitable' ? 'bitable' : (objType === 'sheet' ? 'sheet' : 'docx'),
  }));
  if (objType === 'docx') return withMeta(readDocx);
  if (objType === 'sheet') return withMeta(readSheet);
  if (objType === 'bitable') return withMeta(readBitable);
  // 知识库节点挂着附件 / 幻灯片 / 思维笔记：先查本机知识库 L1 是否已有该节点的已提取文本（零网络下载）。
  if (['file', 'slides', 'mindnote'].includes(objType)) {
    const localHit = readLocalKbParsedText(token, objToken);
    if (localHit) {
      return { ok: true, kind: 'wiki', title: title ?? localHit.title, text: localHit.text };
    }
    return {
      ok: false, kind: objType === 'file' ? 'wiki-file' : objType,
      detail: `知识库节点是 ${objType} 形态`, title,
    };
  }
  return { ok: false, detail: `知识库节点是 ${objType || '未知'} 形态，没有正文读取接口`, title };
}

async function readByKind(request, link, policyPath) {
  assertReadingAllowed(link.token, link.kind, policyPath);
  switch (link.kind) {
    case 'docx': return { ...(await readDocx(request, link.token)), kind: 'docx' };
    case 'doc': return { ...(await readOldDoc(request, link.token)), kind: 'doc' };
    case 'sheet': return { ...(await readSheet(request, link.token)), kind: 'sheet' };
    case 'bitable': return { ...(await readBitable(request, link.token)), kind: 'bitable' };
    case 'wiki': return await readWiki(request, link.token, policyPath);
    case 'file': return { ok: false, kind: 'file', detail: '附件按红线不取' };
    case 'slides': return { ok: false, kind: 'slides', detail: '飞书没有幻灯片正文的只读接口' };
    case 'mindnote': return { ok: false, kind: 'mindnote', detail: '飞书没有思维笔记正文的只读接口' };
    default: return { ok: false, kind: 'unknown', detail: `认不出 ${link.segment ?? '这个路径'} 是哪一种飞书文档` };
  }
}

const METAS_DOC_TYPE = Object.freeze({
  docx: 'docx', doc: 'doc', sheet: 'sheet', bitable: 'bitable',
  wiki: 'wiki', file: 'file', slides: 'slides', mindnote: 'mindnote',
});

/** 标题只为**把话说清楚**（「云空间附件《…pptx》」比「一条链接」有用得多）；取不到就 null，不抛。 */
async function fetchTitle(request, link) {
  const docType = METAS_DOC_TYPE[link.kind];
  if (!docType) return null;
  try {
    const r = await request('/open-apis/drive/v1/metas/batch_query', {
      method: 'POST',
      data: { request_docs: [{ doc_token: link.token, doc_type: docType }], with_url: true },
    });
    const meta = (r?.data?.metas ?? [])[0];
    return meta?.title ? String(meta.title) : null;
  } catch {
    return null;
  }
}

/**
 * 读一条飞书链接，返回 `{url, contentType, title, text}`（与 `readPublicPage` 同形，
 * 所以 `prepareLinkReview` 不用知道有两条路）。读不了就抛 `FeishuLinkError`。
 */
export async function readFeishuLink(value, deps = {}) {
  const link = value && typeof value === 'object' && value.isFeishu ? value : classifyFeishuLink(value);
  if (!link?.isFeishu) throw new Error(`readFeishuLink 只处理飞书链接：${String(value)}`);
  const request = deps.request ?? defaultRequest;
  if (!link.token) throw unreadable(link.kind, null, '链接里没有可用的文档 token');
  assertReadingAllowed(link.token, link.kind, deps.policyPath);

  const title = await fetchTitle(request, link);
  const r = await readByKind(request, link, deps.policyPath);
  if (!r?.ok) throw unreadable(r?.kind ?? link.kind, r?.title ?? title, r?.detail);

  const text = String(r.text ?? '').trim();
  if (!text) throw new FeishuLinkError({
    kind: r.kind ?? link.kind, title: r.title ?? title, detail: '正文为空',
    reply: emptyReply(r.kind ?? link.kind, r.title ?? title),
  });
  return {
    url: link.url,
    contentType: `feishu/${r.kind ?? link.kind}`,
    title: r.title ?? title,
    text: text.slice(0, MAX_CHARS),
  };
}

/**
 * **唯一的分流点**：飞书域名走飞书只读接口，其余走公开网页读取器。
 * `prepareLinkReview` 的默认 reader 就是它 —— 调用方不需要知道有两条路。
 */
export async function readLink(value, deps = {}) {
  const link = classifyFeishuLink(value);
  if (link.isFeishu) return readFeishuLink(link, deps);
  const page = deps.readPublicPage ?? readPublicPage;
  return page(value);
}

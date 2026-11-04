/**
 * media_link.mjs —— **把送审的图/视频变成「点一下就开」的链接**，并顺手把
 * 「送审问题」这一格收回成**只写对方原话**。
 *
 * ── 它治的是什么（2026-10-16，Owner 当场提的两件事）
 *
 *   Owner 原话：「守衡侧输出的结论写入飞书文档，送审问题 里面的图片和视频要优化成**链接**，
 *   **点击就可以打开的**，**只留原文，不要写其他话**」，并追问
 *   「现在只写 `[图片]` 也不知道是什么图片，你的建议呢？」
 *
 *   拉真实数据（结论表 200 行）之后，病灶比那句话更大：
 *     · **54 行**的「送审问题」里躺着**我们自己的内部指令** ——
 *       逐字如 `【★ 这是送审素材：不管对方写没写「审一下」，都要走 kb_review_chain…】`、
 *       `【对方这条消息里附了图，共 1 张。…**不在这些字里，你看不到**…】`，后面还接着 OCR 全文；
 *     · **20 行**是 `[图片]` / `[媒体]` 占位（`feishu.mjs:postToPlain` 把富文本里的 `<img>` 标签
 *       换成了这个字面量）；媒材行里 **64 行**连报告链接都没有。
 *   ⇒ 「只留原文」不是格式偏好，是**内部提示词被当成内容发出去了**。
 *
 * ── 为什么必须上传（而不是给「原消息链接」）
 *
 *   实测（2026-10-16）：飞书**没有**「取某条消息链接」的公开能力 ——
 *   `lark-cli im` 的全部子命令里只有 `chats link`（**群**分享链接），没有 message link；
 *   消息里的媒材只能靠 `message_id + file_key` 走**鉴权 API** 取字节。
 *   ⇒ 要让人点得开，只能**把字节落到飞书自己的一个位置**，再把那个位置的 URL 写进格子。
 *
 * ── 三条裁定（Owner 2026-10-16，逐条对应一个实现决定）
 *
 *   ① 「**直接覆盖送审问题，不要新建**」 ⇒ 不新增列；链接就写在这一格里
 *      （配合 `review_publish` 把这一格从「只补空」改成**允许改写**，否则旧内容永远盖不掉）；
 *   ② 「**组织内获得链接的人可阅读**」 ⇒ `link_share_entity = tenant_readable`。
 *      ⚠️ 这一步是 `permission.public patch` —— **高危写**，Owner 明确授权后才可带 `--yes`；
 *      授权记录：2026-10-16 本会话，Owner 三选一选了 A。**换策略要先改这里与 §2.6。**
 *   ③ 「**固定文件夹 + 按月分子夹**」 ⇒ 落 `守衡送审素材/<YYYY-MM>/`。
 *
 * ── 实测到的两个硬约束（都不是推测）
 *
 *   · **上传后默认点不开**：`link_share_entity` 实测是 `"closed"`；
 *   · **子文件不继承文件夹的设置**：往文件夹里再传一件，读回来仍是 `closed`
 *     ⇒ **每个文件都要单独设一次**（这条决定了下面的三步走，而不是"设一次文件夹就完了"）。
 *
 * ── fail-closed（本仓既定原则：宁可空着也不编）
 *
 *   「设权限」这一步**必须回读确认**（`+permission-get-setting` 读到 `tenant_readable`）才算数 ——
 *   接口回 `ok:true` 不等于数据落下来了。三步里任何一步没成 ⇒ 返回的 `url` 为**空**，
 *   调用方据此**不写链接**（一个点不开的链接比空格更坏）。
 *
 * ── 红线（`AGENTS.md` §2.6）：这是新增的一处「字节在飞书留持久副本」
 *
 *   在此之前，素材字节的去向只有两处：本机 OCR（不出机器）与画面层（出机器、不归档）。
 *   本模块**不把字节送出这台机器的既有边界之外**（素材本来就存在飞书消息里），
 *   但它**新造了一份持久副本**：消息可以撤回、可以过期，云空间里这份不会跟着消失。
 *   ⇒ 形状必须钉死：**只上传人当前发给守衡的那一条里的媒材**、只落到那一个文件夹、
 *     只设「组织内可阅读」、不做转发不做归档以外的复制；要改形状先改 §2.6 与本文件的常量。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
// ★ 用**落表闸门**当上传的前置：表拉下 ⇒ 这一单**根本不会写行** ⇒ 上传就没有任何消费者，
//   只会白造一份持久副本（那是红线那一段里最不该发生的事）。
//   ⚠️ 与 `review_publish.reviewTable()` **同一把尺子**，不另抄一份 env 解析 ——
//   它同时也是自证的兜底：将来谁漏传了 `mediaLinksRunner` 桩，也上传不出去
//   （与那里「即使谁漏传了桩，也写不进真表」是同一条纪律）。
import { reviewTable } from './review_publish.mjs';
// ★ 状态放哪的**唯一真源**（带 env 覆盖语义）—— 缓存路径必须走它，不许用 cwd（见 cacheFile 注释）
import { stateDir } from './config.mjs';
import { execImageProcess } from './image_process.mjs';
import { remainingReviewTimeout, reviewDeadlineAt } from './review_deadline.mjs';

const execFileP = promisify(execFile);
function deadlineRun(injected) {
  return (args, options) => {
    const run = injected ?? ((a, o) => (reviewDeadlineAt() === null ? execFileP : execImageProcess)(MEDIA_LINK.bin, a, o));
    return run(args, { ...options, timeout: remainingReviewTimeout(options?.timeout) });
  };
}

/**
 * 总开关（拉闸用：`SHOUHENG_MEDIA_LINK=off` ⇒ 不上传、不写链接，其余一切照旧）。
 *
 * ⚠️ **每次调用现读 env**，不冻成模块加载时的常量 —— 冻成常量时，自证里改了 env
 * 也不生效（`M8a` 第一版就是这么红的），而本仓 `reviewTable()` 也是每调用现读。
 * 两处口径不一样，迟早有人踩。
 */
export function mediaLinkEnabled() {
  return !/^(off|none|0)$/i.test(String(process.env.SHOUHENG_MEDIA_LINK ?? '').trim());
}

export const MEDIA_LINK = Object.freeze({
  bin: process.env.SHOUHENG_LARK_CLI ?? path.join(os.homedir(), '.dsh', 'bin', 'lark-cli'),
  profile: process.env.SHOUHENG_LARK_PROFILE ?? 'dsh-kb',
  /** 落点：`守衡送审素材`（Owner 2026-10-16 建的固定文件夹）。 */
  folderRoot: process.env.SHOUHENG_MEDIA_FOLDER ?? 'O2CjfQQtFlUbngdG4GbcY3xXnWc',
  /** 组织内获得链接的人可阅读 —— Owner 2026-10-16 裁定 ②。 */
  shareEntity: 'tenant_readable',
  timeoutMs: Number(process.env.SHOUHENG_MEDIA_TIMEOUT_MS ?? 60000),
  /**
   * 月文件夹 token 的缓存（免得每单都先查一次）。
   *
   * ⚠️ **必须走 `stateDir()`，不许用 `process.cwd()`** —— 2026-10-16 实测踩到：
   * 守护进程的工作目录是 `tools/`（见 AGENTS.md 守衡那一节），于是缓存被写进
   * `tools/PMO/shouheng-state/`（**源码树里凭空多出一个目录**），
   * 而 CLI 那条路（cwd=仓库根）写的是另一份 ⇒ 两份缓存互不相认，每次都要重新查一遍。
   * `stateDir()` 是这一个仓库里「状态放哪」的**唯一真源**（还带 env 覆盖语义）。
   */
  cacheFile: process.env.SHOUHENG_MEDIA_FOLDER_CACHE
    ?? path.join(stateDir(), 'media-folders.json'),
  /**
   * 落表前**最多等多久**拿到链接。
   *
   * 上传是在回执卡之后起、与链并行的（链实测 100 秒上下，5 次 CLI 调用约 7~10 秒，
   * 正常情况下早就好了）—— 但 **P0 快路**那一单几毫秒就走到落表，
   * 而**上传卡住时绝不许把落表拖死**：等过这个上限就按「没链接」落表（那一格只留原文），
   * 并打一行日志说明是**未测**而不是「没有媒材」。
   */
  waitMs: Number(process.env.SHOUHENG_MEDIA_WAIT_MS ?? 20000),
});

/**
 * 我们自己的**探针/读数块**的头注。
 *
 * ⚠️ **与 `merged_report.mjs::questionForReport` 的探针正则**同一套词面，只多一个
 * `★ 这是送审素材`（那是 `MEDIA_ROUTE_HINT`，报告那侧的正则其实没盖住它）。
 *   · `图片\s*\d` / `图\s*\d` / `视频\s*\d` 里的**数字不能省** ——
 *     第一版我写成字面量 `【视频 `，于是它匹配了**提交人自己写的**
 *     `【视频封面图 —— 本次只审封面图与标题…】`（真表里 `AUTO-e0ba2a737c19` 就是那样一行）
 *     ⇒ **把人的话当成我们的探针**。这是 2026-10-16 当场实测到的过宽。
 */
export const PROBE_RE = /【(?:对方这条消息|图片\s*\d|图\s*\d|视频\s*\d|待读的链接|★\s*这是送审素材)/;

/** 兼容旧名（`PROBE_MARKERS` 曾是字面量数组）。 */
export const PROBE_MARKERS = Object.freeze([PROBE_RE.source]);

/** 「对方只发了素材」那句**我们自己拟的**说明 —— 它不是对方的话，不许进格子。 */
const PROBE_TAIL_NOTES = Object.freeze([
  '（对方只发了素材，没有写问题）',
  '（对方**只发了素材**，没有写问题）',
  '（对方只发了素材…）',
]);

/**
 * 把「送审问题」收回成**对方真写过的话**（纯函数，可离线断言）。
 *
 * 三步，顺序不能换：
 *   ① 去掉**孤立的** `[图片]` / `[媒体]` / `[视频]` 占位 —— 它们是**载体**的替身，不是原文；
 *   ② 从**第一个探针头注**处整段截断 —— 我们拼块时总是把探针**接在对方的话后面**
 *      （`buildUserTurn`：`questionText` 在前、`imageBlock`/`videoBlock` 在后），
 *      所以「第一个探针之前」就是对方说的全部；
 *   ③ 去掉我们自己拟的尾巴说明。
 *
 * ⚠️ **① 必须带 `(?!\()`** —— 这一条是**真事故**换来的（2026-10-16 当场）：
 *   第一版写成 `/\[(图片|媒体|视频)\]/g`，它会匹配 **markdown 链接的标签** ——
 *   于是 `[图片](https://momcozy-in.feishu.cn/file/X)` 被吃成 `(https://…/file/X)`，
 *   而当时的清洗正作用在**真表**上：**3 行的链接标签被吃掉**（已逐行修回）。
 *   判据：`media_link.test.mjs` 的 M1h（拆掉 `(?!\()` ⇒ 精确变红）。
 *
 * ⚠️ **只认枚举出来的头注**，不写成「见到 `【` 就切」：真有人写了一整段带 `【` 的话，
 *   「宁可长，不可错删」（与 `questionForReport` 那条注释同一条纪律）。
 */
export function stripInternal(text) {
  let s = String(text ?? '');
  s = s.replace(/\[(图片|媒体|视频)\](?!\()/g, '');   // ⚠️ `(?!\()` 见上面那条事故
  const m = PROBE_RE.exec(s);
  if (m) s = s.slice(0, m.index);
  for (const n of PROBE_TAIL_NOTES) s = s.split(n).join('');
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 链接的显示文字：图片没有文件名，视频常常有（`知识库视频-WhatsApp-2026-10-06.mp4`）。 */
export function mediaLabel({ kind, index = 1, count = 1, fileName = null } = {}) {
  const base = kind === 'video' ? '视频' : '图片';
  const fn = String(fileName ?? '').trim();
  if (kind === 'video' && fn) return fn;
  return count > 1 ? `${base} ${index}` : base;
}

/**
 * 落表那一格的**唯一组装点**：`对方原话` ＋ 每个媒材一行链接。
 *
 * · 没有 url 的媒材**不写链接**（fail-closed）—— 但**也不编**「图片」两个字占位：
 *   那一格空着，比一个点不开的链接诚实。
 * · 对方一个字没写、只发了图 ⇒ 这一格就只有链接（这才是「只留原文」的字面意思）。
 */
export function questionForRow({ userText = '', media = [] } = {}) {
  const head = stripInternal(userText);
  const lines = [];
  const withUrl = (media ?? []).filter((m) => m && m.ok && m.url);
  withUrl.forEach((m, i) => {
    const label = mediaLabel({ kind: m.kind, index: i + 1, count: withUrl.length, fileName: m.fileName });
    lines.push(`[${label}](${m.url})`);
  });
  return [head, ...lines].filter(Boolean).join('\n');
}

/** `YYYY-MM`（**北京时间**：跨月那一刻人在东八区，用 UTC 会写错一个月）。 */
export function monthFolderName(at = Date.now()) {
  const d = new Date(at + 8 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function readCache(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) ?? {}; } catch { return {}; }
}
function writeCache(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  } catch { /* 缓存写不进去不影响正确性（下一次再建一次会拿到同一个文件夹名，见下） */ }
}

/** 从 `lark-cli` 的 stdout 里取 JSON（它有时在 JSON 前后带别的行）。 */
function jsonOf(stdout) {
  const s = String(stdout ?? '');
  const i = s.indexOf('{');
  if (i < 0) return null;
  try { return JSON.parse(s.slice(i)); } catch { return null; }
}

/**
 * 取（或建）当月子夹。**先查缓存，再查云盘，最后才建** ——
 * 重复建同名文件夹在飞书里是允许的，所以"每次都建"会攒出一堆同名夹子。
 */
export async function ensureMonthFolder(ym, { deps = {} } = {}) {
  const run = deadlineRun(deps.exec);
  const cacheFile = deps.cacheFile ?? MEDIA_LINK.cacheFile;
  const cache = readCache(cacheFile);
  if (cache[ym]?.token) return { ok: true, token: cache[ym].token, detail: '缓存命中' };
  const base = ['--profile', MEDIA_LINK.profile];
  const opts = { timeout: MEDIA_LINK.timeoutMs, maxBuffer: 4 << 20 };
  try {
    // 先在根夹里找一个同名的：找到就复用（避免同名夹子堆积）。
    const { stdout: lsOut } = await run([...base, 'drive', 'files', 'list',
      '--folder-token', MEDIA_LINK.folderRoot, '--as', 'bot'], opts);
    const j = jsonOf(lsOut);
    const hit = (j?.data?.files ?? j?.data?.items ?? []).find((f) => f?.name === ym && f?.type === 'folder');
    if (hit?.token) {
      cache[ym] = { token: hit.token, at: new Date().toISOString() };
      writeCache(cacheFile, cache);
      return { ok: true, token: hit.token, detail: '已存在，复用' };
    }
  } catch { /* 列不出来就直接建（下面那一步会给出真错误） */ }
  try {
    const { stdout } = await run([...base, 'drive', '+create-folder', '--name', ym,
      '--folder-token', MEDIA_LINK.folderRoot, '--as', 'bot'], opts);
    const j = jsonOf(stdout);
    const token = j?.data?.folder_token ?? '';
    if (!token) return { ok: false, token: null, detail: `建月文件夹回了但没有 token：${String(stdout).slice(0, 200)}` };
    cache[ym] = { token, at: new Date().toISOString() };
    writeCache(cacheFile, cache);
    return { ok: true, token, detail: '新建' };
  } catch (e) {
    return { ok: false, token: null,
             detail: `建月文件夹失败：${(String(e?.stderr ?? '').trim() || String(e?.message ?? e)).slice(0, 300)}` };
  }
}

/**
 * 上传一个本地文件 → 设成组织内可阅读 → **回读确认** → 返回可点的 URL。
 *
 * 三步缺一不可，任何一步没成 ⇒ `{ok:false, url:null}`（**不返回半成品 URL**）。
 * ⚠️ `cwd` 设成文件所在目录：`lark-cli` 的路径解析有"只认 cwd 之下或 /tmp"的既有坑
 *   （见 `review_publish.mjs::publishReportDoc` 的实测记录）。
 */
/**
 * 从**字节**认文件类型（只认前 16 字节的魔数）。
 *
 * ★★ 2026-10-17 第二十五轮（Owner：「图片 1：点开查看 —— **点击后无法查看**，修复下」）——
 *   真因：上传到云空间的文件**没有扩展名**（`守衡送审素材-image-1`），飞书把它当未知二进制，
 *   `drive +preview` 直接回 `1060006 file type does not support preview` ⇒ 点开就是个死页。
 *   实测同一条文件**只改名加 `.jpg`**（token 不变）之后预览立刻通过 —— 字节一直是好的，
 *   坏的是**名字**。而取图那一跳故意存成 `.img`（不让字节在临时目录里伪装成图片），
 *   所以扩展名只能从**魔数**认，不能从路径猜。
 *   认不出就**不加**（宁可让维护者看到「没扩展名」，也不编一个假的）。
 */
export function magicExt(filePath) {
  let b = null;
  try {
    const fd = fs.openSync(filePath, 'r');
    b = Buffer.alloc(16);
    fs.readSync(fd, b, 0, 16, 0);
    fs.closeSync(fd);
  } catch { return ''; }
  if (!b || b.length < 12) return '';
  const ascii = (a, z) => b.slice(a, z).toString('latin1');
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return '.jpg';
  if (b[0] === 0x89 && ascii(1, 4) === 'PNG') return '.png';
  if (ascii(0, 3) === 'GIF') return '.gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return '.webp';
  if (ascii(0, 2) === 'BM') return '.bmp';
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    if (/^(heic|heix|hevc|mif1|msf1)$/.test(brand)) return '.heic';
    return '.mp4';                      // isom / mp42 / avc1 / qt…
  }
  return '';
}

/** 名字没有扩展名时，用魔数补上；**已经有扩展名的一个字不动**。 */
export function withMagicExt(name, filePath) {
  const n = String(name ?? '').trim();
  if (!n) return n;
  if (/\.[A-Za-z0-9]{2,5}$/.test(n)) return n;
  const ext = magicExt(filePath);
  return ext ? n + ext : n;
}

export async function uploadForLink(localPath, { name = null, ym = null, deps = {} } = {}) {
  if (!mediaLinkEnabled()) return { ok: false, url: null, token: null, detail: '媒材链接被拉闸（SHOUHENG_MEDIA_LINK=off）' };
  const f = String(localPath ?? '').trim();
  if (!f || !fs.existsSync(f)) return { ok: false, url: null, token: null, detail: `本地文件不存在：${f}` };
  const run = deadlineRun(deps.exec);
  const base = ['--profile', MEDIA_LINK.profile];
  const opts = { timeout: MEDIA_LINK.timeoutMs, maxBuffer: 8 << 20, cwd: path.dirname(f) };
  const t0 = Date.now();

  const mf = await ensureMonthFolder(ym ?? monthFolderName(), { deps });
  if (!mf.ok) return { ok: false, url: null, token: null, detail: mf.detail };

  // ① 上传
  let token = ''; let url = '';
  try {
    const { stdout } = await run([...base, 'drive', '+upload', '--file', f,
      // ★ 第二十五轮：名字没有扩展名 ⇒ 用**魔数**补一个（飞书靠扩展名决定能不能预览）
      ...(name ? ['--name', withMagicExt(name, f)] : []),
      '--folder-token', mf.token, '--as', 'bot'], opts);
    const j = jsonOf(stdout);
    token = j?.data?.file_token ?? '';
    url = j?.data?.url ?? '';
    if (!token || !url) {
      return { ok: false, url: null, token: null, ms: Date.now() - t0,
               detail: `上传回了但没有 token/url：${String(stdout).slice(0, 200)}` };
    }
  } catch (e) {
    return { ok: false, url: null, token: null, ms: Date.now() - t0,
             detail: `上传失败：${(String(e?.stderr ?? '').trim() || String(e?.message ?? e)).slice(0, 300)}` };
  }

  // ② 设成「组织内获得链接的人可阅读」（高危写 —— Owner 2026-10-16 授权，见文件头 ②）
  try {
    await run([...base, 'drive', 'permission.public', 'patch', '--token', token, '--type', 'file',
      '--data', JSON.stringify({ link_share_entity: MEDIA_LINK.shareEntity }),
      '--as', 'bot', '--yes'], { timeout: MEDIA_LINK.timeoutMs, maxBuffer: 4 << 20 });
  } catch (e) {
    return { ok: false, url: null, token, ms: Date.now() - t0,
             detail: `设可见范围失败（链接不写进表）：${(String(e?.stderr ?? '').trim() || String(e?.message ?? e)).slice(0, 300)}` };
  }

  // ③ **回读确认** —— 「接口成功 ≠ 数据落下来」是本仓既有判据
  try {
    const { stdout } = await run([...base, 'drive', '+permission-get-setting',
      '--token', token, '--type', 'file', '--as', 'bot'], { timeout: MEDIA_LINK.timeoutMs, maxBuffer: 4 << 20 });
    const got = jsonOf(stdout)?.data?.permission_public?.link_share_entity ?? '';
    if (got !== MEDIA_LINK.shareEntity) {
      return { ok: false, url: null, token, ms: Date.now() - t0,
               detail: `回读不是 ${MEDIA_LINK.shareEntity}（读到 ${got || '空'}）⇒ 不写链接` };
    }
  } catch (e) {
    return { ok: false, url: null, token, ms: Date.now() - t0,
             detail: `回读权限失败（链接不写进表）：${(String(e?.stderr ?? '').trim() || String(e?.message ?? e)).slice(0, 200)}` };
  }

  return { ok: true, url, token, ms: Date.now() - t0, detail: `已上传并设为组织内可阅读（${mf.detail}）` };
}

/**
 * 把这一单的媒材逐个落成链接。
 *
 * ⚠️ **为什么这里要重新取一次字节**：读入阶段那份字节在 `finally` 里**用完即删**
 *   （§2.6 那条窄豁免的形状是「过一遍 OCR/画面」，**不是「留下来」**），
 *   落表发生在链跑完之后（分钟级），那时本地早就没文件了。
 *   重新取一次的代价是**一次下载**，换来的是：不改读入那条已经被 230 条判据钉住的清理语义。
 *   ⇒ 每次取到的临时文件**在 `finally` 里删**（成功、失败、抛异常三种结局都删）。
 *
 * 不抛：任何一件媒材没落成，只是**那一件没有链接**（`ok:false`），
 * 这一单照落表 —— 丢一个链接是缺陷，丢整条结论是更大的缺陷。
 */
export async function collectMediaLinks({
  inbound, fetchImage, fetchVideo, upload = uploadForLink, log = () => {}, ym = null,
} = {}) {
  // ★ 表拉下（`SHOUHENG_REVIEW_TABLE=off`，自证与干跑默认如此）⇒ **不上传**：
  //   这一单不会写行，链接没有消费者，上传只会白留一份素材副本。
  if (!reviewTable()) {
    log('媒材链接：落表已拉下 ⇒ 不上传（没有消费者，不白造持久副本）');
    return [];
  }
  const items = [];
  for (const im of inbound?.images ?? []) {
    if (im?.failed || !im?.msgId || !im?.imageKey) continue;
    items.push({ kind: 'image', msgId: im.msgId, key: im.imageKey, fileName: null, index: im.index ?? items.length + 1 });
  }
  for (const v of inbound?.videos ?? []) {
    if (v?.failed || !v?.msgId || !v?.fileKey) continue;
    items.push({ kind: 'video', msgId: v.msgId, key: v.fileKey, fileName: v.fileName ?? null, index: v.index ?? items.length + 1 });
  }
  const out = [];
  for (const it of items) {
    let got = null;
    try {
      got = it.kind === 'image'
        ? await fetchImage(it.msgId, it.key)
        : await fetchVideo(it.msgId, it.key, { ext: (String(it.fileName ?? '').match(/\.[A-Za-z0-9]{2,5}$/) ?? ['.mp4'])[0].toLowerCase() });
      if (got?.error || !got?.path) {
        out.push({ kind: it.kind, fileName: it.fileName, ok: false, url: null,
                   detail: `取字节没成：${got?.error ?? '没有回路径'}` });
        continue;
      }
      // ★ 第二十五轮：中文标签（这一串是**用户在云空间里看到的文件名**）+ 扩展名由 `uploadForLink` 按魔数补
      const name = it.fileName || `守衡送审素材-${it.kind === 'video' ? '视频' : '图片'}-${it.index}`;
      const up = await upload(got.path, { name, ym: ym ?? monthFolderName() });
      out.push({ kind: it.kind, fileName: it.fileName, ...up });
      log(`🖼 ${it.kind === 'video' ? '视频' : '图片'} ${it.index} 链接：${up.ok ? up.url : `未成 —— ${up.detail}`}`);
    } catch (e) {
      out.push({ kind: it.kind, fileName: it.fileName, ok: false, url: null,
                 detail: `取字节/上传抛异常：${e?.message ?? e}` });
    } finally {
      // 字节用完就删 —— 与读入阶段同一条纪律；**三种结局都要删**。
      try { got?.cleanup?.(); } catch { /* 删不掉不该让这一单失败 */ }
    }
  }
  return out;
}

/** 落表前**有界**等待链接结果：超时按「没链接」处理，并说清是**未测**。 */
export async function awaitLinks(promise, { ms = MEDIA_LINK.waitMs, log = () => {} } = {}) {
  if (!promise) return { media: [], timedOut: false };
  let timer = null;
  try {
    ms = remainingReviewTimeout(ms);
    const media = await Promise.race([
      promise,
      new Promise((resolve) => { timer = setTimeout(() => resolve(SENTINEL_TIMEOUT), ms); }),
    ]);
    if (media === SENTINEL_TIMEOUT) {
      log(`⚠️ 媒材链接没在 ${ms}ms 内拿到 ⇒ 这一格只留原文（**未测**，不是「没有媒材」）`);
      return { media: [], timedOut: true };
    }
    return { media: media ?? [], timedOut: false };
  } catch (e) {
    log(`⚠️ 媒材链接那一步抛了：${e?.message ?? e} ⇒ 这一格只留原文`);
    return { media: [], timedOut: false, error: String(e?.message ?? e) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
const SENTINEL_TIMEOUT = Symbol('media-link-timeout');

/**
 * 启动自检：**这条路现在真的能用吗**（daemon 启动横幅那一条读数）。
 *
 * ── 为什么必须有它（而不是「配置写着开着」就算）
 *
 *   它断掉的表现是「那一格只有原文、没有链接」—— **看起来和「这一单没有媒材」一模一样**，
 *   没有任何东西会红。而它依赖两样本机之外的东西：`lark-cli` 在不在、云空间的
 *   上传/权限 scope 还有没有效。所以探法跟读图/画面层/读视频同一条：
 *   **真跑一次**（建/取当月的月夹子 —— 一次 CLI 调用，本来每单也都要做）。
 *   `switch 是声明，条数是证据`（§2.4.1 第 3 条）。
 */
export async function preflight({ deps = {} } = {}) {
  if (!mediaLinkEnabled()) {
    return { ok: false, skipped: true, detail: 'SHOUHENG_MEDIA_LINK 拉闸 ⇒ 不上传、那一格只留原文' };
  }
  if (!fs.existsSync(MEDIA_LINK.bin)) {
    return { ok: false, skipped: false, detail: `找不到 lark-cli：${MEDIA_LINK.bin}` };
  }
  const ym = monthFolderName();
  const r = await ensureMonthFolder(ym, { deps });
  return r.ok
    ? { ok: true, skipped: false, detail: `云空间可达（月夹子 ${ym}：${r.detail}）` }
    : { ok: false, skipped: false, detail: r.detail };
}

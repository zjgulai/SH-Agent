/**
 * vision.mjs —— 本机图像文字识别（macOS Vision），**零第三方依赖**
 *
 * ── 它是什么
 *
 * 调本仓自己的 OCR CLI：源码 `base/ocr_vision.m`，编译脚本 `base/build_ocr.sh`，
 * 二进制落 `.tools/bin/ocr`。用具名理由：**不引任何 pip/npm 包**，不连任何云服务 ——
 * 图片字节不出这台机器。这也正是它能被放进 §2.6 那条窄豁免里的原因（见下）。
 *
 * ── 为什么是它，不是「让模型看图」
 *
 * 守衡的模型是 `deepseek-flash`，**不吃图**（`llm.mjs` 永远是纯文本 content）。
 * 所以「读图」在本项目里的准确含义是：**OCR 出图内文字**，把文字喂给模型与判定引擎。
 * 「画面本身」（构图、场景、人物在做什么、婴幼儿姿势、产品用法）**不在读数里** ——
 * 这一条必须往上传（`agent.mjs` 的图块头注 + `persona.mjs` 的能力边界），
 * 不许让模型把「我看到了图上的字」说成「我看过这张图」。
 *
 * ── 边界（每一个都在下面有执行点）
 *
 *   · 只认**本机文件**；本模块不下载、不联网（取字节那一步在 `feishu.mjs`，
 *     且是全仓唯一的调用点）。
 *   · 二进制不存在 → 现场编译一次（`base/build_ocr.sh`），失败就如实报 `ocr_unavailable`，
 *     **不静默降级成「图上没字」**（把取不到说成没有，是 §2.4.1 那个病）。
 *   · OCR 认不出来（`ok:false`）与 OCR 认出来是空的（`ok:true, n:0`）**必须分得开** ——
 *     前者是「这一张我读不到」，后者是「这张图里没有可读的文字」。
 *     实测两者都真实存在：`perform_failed` 里有一类是 1×1 像素的懒加载占位图
 *     （`base/media.py` 记的 2/120），那不是「读不出来」，是「本来就没有东西可读」。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { REPO_ROOT, AGENT_DIR } from './config.mjs';

const execFileP = promisify(execFile);

const OCR_BIN_DIR = path.join(REPO_ROOT, '.tools', 'bin');
const OCR_BIN     = path.join(OCR_BIN_DIR, 'ocr');
const OCR_BUILD   = path.join(REPO_ROOT, 'base', 'build_ocr.sh');

/* ─────────────── 试纸（fixture）：让「这条路还通不通」有一个能重复的读数 ───────────────
 *
 * ★ 2026-10-05 加。起因是这次事故的形状：**守衡读不到图，而没有任何东西会变红** ——
 *   图片这条路原先既没有试纸、也没有启动自检，坏了只能等人在群里发现。
 *   两张图都是本仓资产（各 26KB / 1.7KB，不是从飞书取来的）：
 *     · `ocr-sample.png` —— 图上有 7 行已知文字（中英混排），**必须读得出来**；
 *     · `ocr-blank.png`  —— 200×200 全白，**必须报「图上没字」而不是「读不出来」**。
 *   后者是反向对照：只测得出「能读到字」的试纸，测不出「把失败伪装成没字」。
 */
const FIXTURE_DIR = path.join(AGENT_DIR, '__fixtures__');
export const OCR_FIXTURE = path.join(FIXTURE_DIR, 'ocr-sample.png');
export const OCR_BLANK_FIXTURE = path.join(FIXTURE_DIR, 'ocr-blank.png');
/** 试纸里必须被读到的那串特征（挑一个 OCR 稳定认得出的） */
export const OCR_FIXTURE_TOKEN = 'SHOUHENG OCR FIXTURE';

/**
 * 要认的语种。**多语种是必须的，不是锦上添花**：本项目的素材是跨境电商内容，
 * 实测那批落地页里图内文字大量是 es/de/fr，只给 zh/en 会得到一段「读不出东西」的
 * OCR 结果，而它看起来跟「图上真没字」一模一样（`base/media.py` 的 B1 结论）。
 * Vision 支持这几种；真遇到不支持的语言，本模块会退回 zh/en 再来一次。
 */
export const OCR_LANGS = ['zh-Hans', 'en-US', 'de-DE', 'fr-FR', 'es-ES'];
const FALLBACK_LANGS = ['zh-Hans', 'en-US'];

/** 单张图的 OCR 文字上限（字）。超了截断并明写 —— 不许静默截。 */
export const OCR_MAX_CHARS = 4000;
const OCR_TIMEOUT_MS = 60_000;
/** 单张图的字节上限。飞书侧本身上限 100MB，这里再收一道，防一次 OCR 把内存打满。 */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

let _buildAttempted = false;

/** 二进制在不在。测试与自证要用，所以导出。 */
export function ocrBinPath() { return OCR_BIN; }
export function ocrBinAvailable() { return fs.existsSync(OCR_BIN); }

/**
 * 确保 OCR 二进制存在；不在就编译一次。
 * @returns {Promise<{ok:boolean, path?:string, error?:string, detail?:string}>}
 */
export async function ensureOcr() {
  if (fs.existsSync(OCR_BIN)) return { ok: true, path: OCR_BIN };
  if (!fs.existsSync(OCR_BUILD)) {
    return { ok: false, error: 'ocr_build_script_missing', detail: `找不到 ${OCR_BUILD}` };
  }
  if (_buildAttempted) {
    // 同一次进程里只试一次：编译失败是环境问题，每张图重试一遍只会拖长回复时间。
    return { ok: false, error: 'ocr_unavailable', detail: '本次进程里编译已失败过一次，不再重试' };
  }
  _buildAttempted = true;
  try {
    fs.mkdirSync(OCR_BIN_DIR, { recursive: true });
    const r = await execFileP('bash', [OCR_BUILD], { cwd: REPO_ROOT, timeout: 180_000 });
    if (!fs.existsSync(OCR_BIN)) {
      return { ok: false, error: 'ocr_unavailable',
               detail: `编译脚本退出 ${r.code ?? 0} 但二进制没出现：${String(r.stdout ?? '').slice(-300)}` };
    }
    console.warn(`[vision] · OCR 二进制不在，现场编译成功：${String(r.stdout ?? '').trim().split('\n').pop()}`);
    return { ok: true, path: OCR_BIN, built: true };
  } catch (e) {
    return { ok: false, error: 'ocr_unavailable',
             detail: `${e.message}｜${String(e.stdout ?? '').slice(-300)}${String(e.stderr ?? '').slice(-300)}` };
  }
}

/**
 * ★★ 2026-10-27（Owner 批准 OCR 识别错误四步根治）：
 *   对低分辨率/粗描边字幕常见的确定性形近粘连（如 `Momcozy→Momeozy`、`Eufy→Euiy`、
 *   `flange→ilange`、`so I have→sol have`、`during each→during cach`、`let's compare→letls.compare`）
 *   做精准词形还原，避免把 OCR 引擎的形近伪影当成素材拼写错误送入下游。
 */
export function cleanOcrLine(line) {
  let s = String(line ?? '');
  if (!s) return s;
  s = s
    .replace(/\bMomeozy\b/gi, 'Momcozy')
    .replace(/\bEuiy\b/g, 'Eufy')
    .replace(/\bilange\b/gi, 'flange')
    .replace(/\bso\s+letls[.\s]+compare\b/gi, "so let's compare")
    .replace(/\bsol\s+have\s+a\s+little\b/gi, 'so I have a little')
    .replace(/\bduring\s+cach\s+session\b/gi, 'during each session')
    .replace(/\bwearab\s+Le\b/gi, 'wearable');
  return s;
}

const calibrationKey = (value) => String(value ?? '')
  .normalize('NFD').replace(/\p{M}+/gu, '').replace(/ß/gi, 'ss')
  .toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

function editDistance(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = prev[0]; prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return prev[b.length];
}

/**
 * ADR-0015：视觉文字只校准本机 OCR 已存在且高相似的行；不新增行、不覆盖原始证据。
 */
export function calibrateOcrText(ocrText, visualText = []) {
  const source = String(ocrText ?? '');
  const candidates = (Array.isArray(visualText) ? visualText : [visualText])
    .flatMap((x) => String(x ?? '').split(/\r?\n/)).map((x) => x.trim()).filter(Boolean);
  if (!source.trim() || !candidates.length) return { text: source, replacements: [] };
  const replacements = [];
  const lines = source.split('\n').map((line, lineIndex) => {
    const key = calibrationKey(line);
    if (key.length < 4) return line;
    let best = null;
    for (const visual of candidates) {
      const vKey = calibrationKey(visual);
      if (vKey.length < 4) continue;
      const ratio = Math.min(key.length, vKey.length) / Math.max(key.length, vKey.length);
      if (ratio < 0.7) continue;
      const similarity = 1 - editDistance(key, vKey) / Math.max(key.length, vKey.length);
      if ((key === vKey || similarity >= 0.84) && (!best || similarity > best.similarity)) {
        best = { visual, similarity };
      }
    }
    if (!best || line.trim() === best.visual) return line;
    replacements.push({ line: lineIndex + 1, from: line, to: best.visual,
      basis: best.similarity === 1 ? '忽略空格/标点/大小写后相同' : `字符相似度 ${best.similarity.toFixed(3)}` });
    return best.visual;
  });
  return { text: lines.join('\n'), replacements };
}

/** 把 CLI 的一行 JSON 归一成调用方契约（**解析失败不抛**，回 ok:false + 成因）。 */
function normalize(raw, { langs, wallMs }) {
  let d;
  try { d = JSON.parse(String(raw ?? '').trim()); }
  catch { return { ok: false, error: 'bad_output', detail: String(raw ?? '').slice(0, 200), langs, wallMs }; }

  if (!d?.ok) {
    return {
      ok: false,
      error: d?.error ?? 'unknown',
      w: d?.w ?? null, h: d?.h ?? null,
      // ★ 1×1（或几像素）在实测里是**占位图**，不是「识别失败」。
      //   带上这个标记，调用方才能分开说，而不是笼统写「OCR 失败」。
      placeholder: Number.isFinite(d?.w) && Number.isFinite(d?.h) && d.w <= 2 && d.h <= 2,
      ms: d?.ms ?? null, langs, wallMs,
    };
  }

  const lines = (d.lines ?? []).map((l) => cleanOcrLine(l?.t ?? '')).filter((s) => s.trim() !== '');
  // ★★ 2026-10-09（Owner 亲自看出「图上文字里的『Owner』是水印」）：
  //   **行坐标必须带出去** —— 二进制本来就在输出 `{t,c,x,y,w,h}`（归一化坐标），
  //   而这里原先只取 `t`、把坐标丢了 ⇒ 下游**做不了水印判据**
  //   （水印最可靠的特征就是「同一串出现在图的不同位置」，那需要坐标）。
  //   ⇒ 一并带出 `boxes`；**`lines` 的语义不变**（它仍是「识别出多少行」那个数，
  //     另有调用方在用，见 `agent.mjs` 的「｜N 行】」）。
  //   ★★ 2026-10-16（Owner：「第 17 行报告里「嫩圈o」「白」，图片中有吗？你验证下」）：
  //   **置信度 `c` 也得带出去** —— 二进制一直在输出它（`{t,c,x,y,w,h}`），这里原先丢掉。
  //   实测那把噪声的形状：第 17 行那张**通篇英文**的商品图上，Vision 在
  //   「黑色控制面板的 Cleaning 图标」与「纸盒上印的 30」两处读出了汉字
  //   （`白` / `嫩圈o`），**两处置信度都是 0.3 = 该引擎的下限**；整图放大 2× 再读，
  //   汉字归零（同一处读成「小图」「～～」）⇒ 那不是字形，是噪声。
  //   没有 `c` 这个数，下游**分不开**「读到了」与「猜的」——
  //   于是模型侧把噪声当「图上出现了中文」，一路出成 REVIEW 与改图建议。
  //   ⇒ 逐行带 `c`（读不到就是 null，**不许拿 0 冒充**）；`lines` / `text` 语义一个字不变。
  const boxes = (d.lines ?? [])
    .map((l) => ({ t: cleanOcrLine(l?.t ?? ''), x: l?.x ?? null, y: l?.y ?? null,
                   w: Number.isFinite(l?.w) ? l.w : null,
                   h: Number.isFinite(l?.h) ? l.h : null,
                   c: Number.isFinite(l?.c) ? l.c : null }))
    .filter((b) => b.t.trim() !== '');
  let text = lines.join('\n');
  const trunc = text.length > OCR_MAX_CHARS;
  if (trunc) text = `${text.slice(0, OCR_MAX_CHARS)}\n…〔本张图 OCR 文字原长 ${text.length} 字，按 ${OCR_MAX_CHARS} 字上限截断〕`;

  return {
    ok: true,
    text,
    lines: lines.length,          // 识别出多少行（**语义不变**，另有调用方在用）
    boxes,                        // ★ 2026-10-09：逐行 `{t,x,y,c}` —— 水印判据与「汉字声称闸」都要用
    chars: text.length,
    w: d.w ?? null, h: d.h ?? null,
    ms: d.ms ?? null,
    langs,
    wallMs,
    truncated: trunc,
  };
}

/**
 * 识别一张**本机图片文件**。
 *
 * @param {string} filePath 图片路径（本机，任意常见格式 —— Vision 按内容认格式）
 * @param {{langs?:string[], timeoutMs?:number}} [opt]
 * @returns {Promise<{ok:boolean, text?:string, lines?:number, chars?:number, w?:number, h?:number,
 *                    ms?:number, langs?:string[], truncated?:boolean,
 *                    error?:string, detail?:string, placeholder?:boolean}>}
 */
export async function ocrImage(filePath, { langs = OCR_LANGS, timeoutMs = OCR_TIMEOUT_MS } = {}) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { ok: false, error: 'not_found', detail: `图片文件不存在：${filePath ?? '(空路径)'}` };
  }
  let size = 0;
  try { size = fs.statSync(filePath).size; } catch { /* 下面按 0 处理 */ }
  if (!size) return { ok: false, error: 'empty_file', detail: '图片字节是 0 —— 取回来的就是个空文件' };
  if (size > MAX_IMAGE_BYTES) {
    return { ok: false, error: 'too_large', detail: `${size} 字节 > 上限 ${MAX_IMAGE_BYTES}` };
  }

  const bin = await ensureOcr();
  if (!bin.ok) return { ok: false, error: bin.error, detail: bin.detail };

  const attempt = async (useLangs, target = filePath) => {
    const t0 = Date.now();
    try {
      const r = await execFileP(bin.path, [target, ...useLangs], { timeout: timeoutMs, maxBuffer: 1 << 24 });
      return normalize(r.stdout, { langs: useLangs, wallMs: Date.now() - t0 });
    } catch (e) {
      if (e.killed || e.signal) return { ok: false, error: 'timeout', detail: `超过 ${timeoutMs}ms`, langs: useLangs };
      return { ok: false, error: 'spawn_failed', detail: String(e.message ?? e), langs: useLangs };
    }
  };

  const first = await attempt(langs);
  let result = first;
  // 失败且用的不是兜底语言表 → 用最保守的 zh/en 再来一次。
  // 依据：`recognitionLanguages` 里出现运行时不支持的语种时整次请求会失败，
  // 而那时**整张图一个字都读不到**，看起来跟「图上没字」一样（这是个会骗人的静默降级）。
  if (!first.ok && first.error !== 'not_found' && first.error !== 'too_large'
      && langs.join(',') !== FALLBACK_LANGS.join(',')) {
    const second = await attempt(FALLBACK_LANGS);
    if (second.ok) return { ...second, note: `多语种那次失败（${first.error}），已按 ${FALLBACK_LANGS.join('+')} 重试成功` };
    result = second;
  }
  // ★★ 2026-11-03：**格式兜底** —— Vision 解不了的文件（实测：部分 progressive JPEG
  //   `file` 判 data、`sips` 也解不开，但 PIL 能正常解码）。
  //   只用本机 Python + Pillow 转码到临时 PNG 再读一次，不联网、字节不出机器；
  //   Pillow 缺失 / 转码失败 ⇒ 原样返回第一次的失败，**不把「没读成」说成「图上没字」**。
  if (!result.ok && !['not_found', 'too_large', 'empty_file', 'timeout'].includes(result.error)) {
    const recovered = await recoverWithPillow(filePath);
    if (recovered) {
      try {
        const retried = await attempt(langs, recovered);
        if (retried.ok) {
          return { ...retried, recovered: true,
                   note: `原图 Vision 读不了（${result.error}），已用本机 PIL 转码后重试成功` };
        }
        return retried;
      } finally {
        try { fs.rmSync(recovered, { force: true }); } catch { /* 临时件删不掉不影响结果 */ }
      }
    }
  }
  return result;
}

/** 本机格式兜底：用 Pillow 把 Vision 读不了的图转成 PNG（临时文件，调用方负责删）。 */
async function recoverWithPillow(filePath) {
  const out = path.join(os.tmpdir(), `ocr-recover-${process.pid}-${Date.now()}.png`);
  try {
    await execFileP('python3', ['-c',
      'import sys\nfrom PIL import Image\nim = Image.open(sys.argv[1]); im.load(); im.convert("RGB").save(sys.argv[2])',
      filePath, out], { timeout: OCR_TIMEOUT_MS, maxBuffer: 1 << 20 });
    return (fs.existsSync(out) && fs.statSync(out).size > 0) ? out : null;
  } catch {
    return null;
  }
}

/* ─────────────────── 自检 / 预热（启动时跑一次） ─────────────────── */

/**
 * OCR 这条路的**自检**：二进制在不在（不在就编）→ 拿试纸真跑一次 → 读出特征串才算通。
 *
 * ★ 为什么要它（而不是等第一张图来了再说）：
 *   · **慢**：二进制不在时现场编译要几十秒，而这个时间会花在**某个人正在等的那条回复**上；
 *   · **静默**：编译失败（SDK 变了、CLT 升级）只会让**那一张图**报「读不到」，
 *     而没有任何东西会红 —— 与 10-05 这次事故是同一个形状，只是低了一层。
 *
 * 返回的读数会被 `ws_daemon.mjs` 打进启动横幅，所以「守衡现在读不读得了图」
 * 在日志第一屏就能看见，不用等有人发图。
 *
 * @returns {Promise<{ok:boolean, bin:boolean, built?:boolean, lines?:number, ms?:number,
 *                    blankOk?:boolean, error?:string, detail?:string}>}
 *   `blankOk` 是**反向对照**：空白试纸必须报「没字」（`ok:true, n:0`），
 *   而不是报失败 —— 否则「读不出来的」会被伪装成「图上没字」。
 */
export async function preflight() {
  const bin = await ensureOcr();
  if (!bin.ok) return { ok: false, bin: false, error: bin.error, detail: bin.detail };

  if (!fs.existsSync(OCR_FIXTURE)) {
    return { ok: false, bin: true, built: !!bin.built, error: 'fixture_missing',
             detail: `试纸不在：${OCR_FIXTURE} —— 没有试纸就无法证明这条路是通的` };
  }

  const r = await ocrImage(OCR_FIXTURE);
  if (!r.ok) {
    return { ok: false, bin: true, built: !!bin.built, error: r.error, detail: r.detail,
             note: '二进制在，但试纸读不出来 —— 图这条路现在是断的' };
  }
  const hit = String(r.text ?? '').toUpperCase().includes(OCR_FIXTURE_TOKEN);
  if (!hit) {
    return { ok: false, bin: true, built: !!bin.built, lines: r.lines, ms: r.ms,
             error: 'fixture_token_missing',
             detail: `试纸读了 ${r.lines} 行，但没读到特征串「${OCR_FIXTURE_TOKEN}」—— `
                   + '多半是语言包/识别档位变了，别当成「通了」',
             text: String(r.text ?? '').slice(0, 200) };
  }

  // 反向对照：空白图必须落进「没字」，不是「失败」
  let blankOk = false;
  let blankNote = null;
  if (fs.existsSync(OCR_BLANK_FIXTURE)) {
    const b = await ocrImage(OCR_BLANK_FIXTURE);
    blankOk = b.ok === true && !String(b.text ?? '').trim();
    if (!blankOk) blankNote = `空白试纸回了 ok=${b.ok} error=${b.error ?? '-'} —— 空白图必须报「没字」`;
  }

  return { ok: true, bin: true, built: !!bin.built, lines: r.lines, ms: r.ms,
           blankOk, ...(blankNote ? { blankNote } : {}) };
}

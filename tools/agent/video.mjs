/**
 * video.mjs —— 本机读视频：**元数据 + 关键帧 OCR + 口播转写**（零第三方依赖）
 *
 * ── 它是什么
 *
 * 调本仓自己的视频探针：源码 `base/video_probe.m`，编译脚本 `base/build_video.sh`，
 * 二进制 `.tools/bin/video_probe`。画面用 AVFoundation 抽帧、交给 `vision.mjs`（Vision OCR）
 * 读**画面上的字**；声音用 `afconvert`（系统自带）抽成 wav、交给 `asr.mjs`（Speech）转写。
 * 这正是 PRD §5.2 对视频的要求：**字幕/旁白 + 关键帧 + OCR**。
 *
 * ── 为什么是「本机三条路拼起来」而不是一个云端接口
 *
 * PRD §12 写着「素材不对外泄露」，所以画面与声音都不能出这台机器：
 * 抽帧是本机、OCR 是本机、转写是本机（`requiresOnDeviceRecognition = YES`）。
 * 代价是没有第三方 ASR 的识别率，收益是这条链路**没有任何一个字节出网**。
 *
 * ── 边界（每一条都在这里或调用方有落点）
 *
 *   · 只认**本机文件**；取字节那一步在 `feishu.mjs`，且是全仓唯一的调用点（§2.6）。
 *   · 抽出来的帧与音频**只落临时目录、用完即删**（`cleanup()`）—— 与图片那条一致。
 *   · **「没有音轨」与「转写失败」必须分得开**：前者是读数（`has_audio=false`），
 *     后者是没读到。同理「没有人说话」（`kind:'no_speech'`）也是读数，不是失败。
 *   · 抽帧按**时长均匀取样**，所以「画面上的字」是抽样看到的，不是逐帧看全的 ——
 *     这个上限要往上传（`agent.mjs` 的视频块头注），不许让模型说成「整条片子我都看了」。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { REPO_ROOT, AGENT_DIR } from './config.mjs';
import * as vision from './vision.mjs';
import * as asr from './asr.mjs';
import * as sceneMod from './scene.mjs';

const execFileP = promisify(execFile);

const BIN_DIR     = path.join(REPO_ROOT, '.tools', 'bin');
const VIDEO_BIN   = path.join(BIN_DIR, 'video_probe');
const VIDEO_BUILD = path.join(REPO_ROOT, 'base', 'build_video.sh');

/* ─────────────── 试纸：让「视频这条路还通不通」有一个能重复的读数 ───────────────
 *
 * `video-sample.mp4` 是**本仓资产**（15KB，2 秒 / 640×360 / 10fps），由
 * `base/video_fixture.m` 生成，每帧画着同一行大字。生成它的配方与用它做断言的是同一份资产，
 * 所以「试纸坏了」与「这条路坏了」分得开。
 */
export const VIDEO_FIXTURE = path.join(AGENT_DIR, '__fixtures__', 'video-sample.mp4');
export const VIDEO_FIXTURE_TOKEN = 'SHOUHENG VIDEO FIXTURE';

/**
 * 一次最多抽几帧（硬上限，所有时长统一）。
 * ★ 2026-10-29（Owner 确认方案 A）：60 → 30，与 ≤30s 视频「1帧/秒」口径一致。
 *   各时长帧间隔：≤30s=1s, 60s=2s, 120s=4s。
 *   耗时恒定：并发2下 30帧=18s OCR，3分钟目标裕量保持。
 *   环境变量 `SHOUHENG_VIDEO_FRAMES` 可覆盖（0 = 用默认值）。
 */
export const VIDEO_MAX_FRAMES = Math.max(1, Number(process.env.SHOUHENG_VIDEO_FRAMES || 0) || 30);

/**
 * 帧 OCR 并发数（默认 2）。
 * 30帧并发2 = ceil(30/2) × 1.2s ≈ 18s。
 * 环境变量 `SHOUHENG_OCR_CONCURRENCY` 可覆盖（不超过 CPU 核心数为宜）。
 */
export const OCR_CONCURRENCY = Math.max(1, Number(process.env.SHOUHENG_OCR_CONCURRENCY ?? 2));

/**
 * 画面层**看几帧**（默认 6，`SHOUHENG_SCENE_FRAMES=0` 可整块关掉）。
 * ★ 2026-10-29（Owner 确认方案 A）：12 → 6（与 OCR 30帧保持 20% 比例）。
 *   6帧并发3 = 2批 × 4.5s ≈ 9s，在 3 分钟目标裕量内。
 *   没覆盖的帧是**真未测**，读数里不许把它糊过去。
 */
export const SCENE_FRAMES_MAX = Number(process.env.SHOUHENG_SCENE_FRAMES ?? 6);
/** 帧 OCR 文字总量上限（字）。超了截断并明写 —— 不许静默截。 */
export const VIDEO_MAX_OCR_CHARS = 8000;
/** 单条视频的字节上限。飞书侧本身上限 100MB，这里再收一道。 */
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
/**
 * 单条视频的时长上限（秒）。超了只报读数、不做转写。
 *
 * ★★ 2026-10-14：600 → 7200（Owner：「必须 asr 跑视频」）。**旧值把真素材挡在门外了。**
 *
 *   实测（10/14 那批 88 条里的两条真视频，不是造出来的样本）：
 *     · `MC-US-YT-88uvcSNxMdk` **669.5s** ⇒ 669.5 > 600 ⇒ 只回了一句「转写没跑成（too_long）」，
 *       整条口播**一个字都没读**；补测这条路本身是通的（en-US、20.3s、109 字）；
 *     · `MC-US-YT-VwANGOaT4vs` **3420.0s**（57 分钟 webinar，78MB 超飞书上传上限、走本机直读）
 *       ⇒ 同样被这个上限拦掉，送进模型的正文只剩 211 字（帧上只认出 4 个 `MOMCOZY`）。
 *
 *   旧口径的理由是「转写成本随时长线性涨」——实测**这条已经不成立**：
 *   `asr.mjs` 现在按 PCM 切段（`ASR_CHUNK_SECONDS`），整条音频被拆成若干 ≤300s 的片段逐段转，
 *   每段的墙钟由**片长**决定、与整条多长无关；57 分钟 ≈ 12 段 × 约 9s。
 *   ⇒ 这个上限不再是「成本闸门」，只该挡住**明显不是本批素材**的东西，所以抬到 2h。
 *
 *   ⚠️ 与它配套的两条（只改一条会自相矛盾，见 `asr.mjs` 的 `MAX_AUDIO_BYTES` 头注）：
 *      `MAX_VIDEO_BYTES` = 200MB（飞书侧 100MB，这里再收一道）／2h 的 22.05k/mono/s16 wav = 317MB。
 */
const MAX_TRANSCRIPT_SECONDS = 7200;
/** ↑ 导出是**给判据用的**（`tools/test_agent.mjs` 第 17 节）：
 *  「这个上限必须盖得住本批最长的一条真素材（3420s）」只有在这儿量得到。 */
export { MAX_TRANSCRIPT_SECONDS };
const PROBE_TIMEOUT_MS = 120_000;

/* ─────────────── 帧 → 一行带时间码的文本（**唯一产者**）───────────────
 *
 * ★★ 2026-10-09（Owner：「目前守衡输出的没有视频的时间节点 00:12 这些」）──────
 *
 *   病灶：`t_s` 一路都算出来了（`readVideo` 的 `frameOcr[].t_s`，来自本机探针），
 *   但**帧文本有三个消费者，各拼各的，其中两个把 `t_s` 丢掉了**：
 *     · 卡片「帧上文字」（`agent.mjs::describeMediaRead` 的 `frameText`）—— 丢掉；
 *     · 模型侧出 findings 的输入（`model_side.mjs::readingsForModelSide`）—— 丢掉；
 *     · 库侧检索文本（`review_gate.mjs`）—— 保留。
 *   于是同一份读数在卡上「没有时间点」、在库里「有」——
 *   而 `agent.mjs:1238` 自己写着「同一份读数两处共用……两处各拼一遍迟早会不一致」。
 *   这一条正是它警告的那个形状，只是当时漏了时间码这一格。
 *
 *   还有一个自相矛盾：提示词教模型「涉及画面本身的结论必须写明**哪一帧**」，
 *   而出 findings 的那份输入里**恰恰没有帧号** —— 要它指位置，却不给它位置。
 *
 *   ⇒ 现在把「帧 → 一行带时间码的文本」收成**这一个函数**，三处共用。
 *     PRD §5.3.2 的模板就是 `视频 00:12 字幕…`，时间码是**证据的一部分**，不是装饰。
 *
 * ★★ 2026-10-09（Owner 第三次点这件事）：「我验证的视频，还是没展示到几秒 **00:12 格式**没看到」。
 *   查下来**两件事都不对**，缺一件都出不来 `00:12`：
 *     ① 这一格原先印 `[12.91s]` —— 秒数带两位小数，不是 Owner 要的 `MM:SS`；
 *     ② **提示词第 4 条教的还是「行首 `[12.34s]`，直接抄那个数」** ⇒ 就算这里改对了，
 *        模型也会照着提示词把 `[12.34s]` 抄回去（`model_side.mjs` 已同步改）。
 *   ⇒ 口径统一成 `[MM:SS]`，**按整秒截断**（`12.91 → 00:12`，与 Owner 举的例子逐字一致，
 *     不四舍五入成 `00:13`）。⚠️ 8 帧是**均匀抽样** ⇒ 这个时间码的含义是「这一秒附近」，
 *     不是精确到帧 —— 这一条由卡片头注与提示词各自说明，别在这里假装精确。
 *
 * ⚠️ 帧**没有文字**时返回 `null`（不是空串）—— 空串会被 `filter(Boolean)` 之外的
 *    调用方当成一帧有内容，这与「这一帧画面上没字」是两件事。
 * ⚠️ 帧 **OCR 失败**时返回「这一帧 OCR 失败」那一行，**不许**与「没字」混成一句
 *    （库规：未测 ≠ 没有）。
 *
 * @param {{t_s?:number, text?:string, failed?:string}|string} f 一帧（或裸文本）
 * @param {{indent?:boolean, oneLine?:boolean}} [opt]
 *        `indent` 前缀两个空格（库侧/卡片一直是这个形状，保持逐字兼容）；
 *        `oneLine` 把帧内换行折成 ` / `（同上）。
 * @returns {string|null}
 */
export function mmss(sec) {
  const s = Math.floor(Number(sec));
  if (!Number.isFinite(s) || s < 0) return '00:00';
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function frameLine(f, { indent = true, oneLine = true, raw = false } = {}) {
  if (typeof f === 'string') return f.trim() ? `${indent ? '  ' : ''}${f.trim()}` : null;
  if (!f || typeof f !== 'object') return null;
  const t = Number(f.t_s);
  // 没有合法时间码 ⇒ **明说没时间码**，不许印一个 `[NaNs]` 冒充
  // ★ 2026-10-09：`[12.91s]` ⇒ `[00:12]`（Owner 的口径；按整秒**截断**，不四舍五入）
  const stamp = Number.isFinite(t) ? `[${mmss(t)}] ` : '[时间码缺失] ';
  const pad = indent ? '  ' : '';
  if (f.failed) {
    const why = typeof f.failed === 'string' ? f.failed : (f.detail ?? '未给原因');
    return `${pad}${stamp}（这一帧 OCR 失败：${why}）`;
  }
  const txt = String(raw ? (f.textRaw ?? f.text ?? '') : (f.textCalibrated ?? f.text ?? ''));
  if (!txt.trim()) return null;                       // 画面上没字 ≠ 有内容
  return `${pad}${stamp}${oneLine ? txt.replace(/\n/g, ' / ') : txt}`;
}

const AUDIO_EXTRACT_TIMEOUT_MS = 120_000;

let _buildAttempted = false;

export function videoBinPath() { return VIDEO_BIN; }
export function videoBinAvailable() { return fs.existsSync(VIDEO_BIN); }

/** 确保探针存在；不在就编译一次。 */
export async function ensureVideoProbe() {
  if (fs.existsSync(VIDEO_BIN)) return { ok: true, path: VIDEO_BIN };
  if (!fs.existsSync(VIDEO_BUILD)) {
    return { ok: false, error: 'video_build_script_missing', detail: `找不到 ${VIDEO_BUILD}` };
  }
  if (_buildAttempted) {
    return { ok: false, error: 'video_probe_unavailable', detail: '本次进程里编译已失败过一次，不再重试' };
  }
  _buildAttempted = true;
  try {
    fs.mkdirSync(BIN_DIR, { recursive: true });
    const r = await execFileP('bash', [VIDEO_BUILD], { cwd: REPO_ROOT, timeout: 180_000 });
    if (!fs.existsSync(VIDEO_BIN)) {
      return { ok: false, error: 'video_probe_unavailable',
               detail: `编译脚本退出 ${r.code ?? 0} 但二进制没出现：${String(r.stdout ?? '').slice(-300)}` };
    }
    console.warn('[video] · 视频探针不在，现场编译成功');
    return { ok: true, path: VIDEO_BIN, built: true };
  } catch (e) {
    return { ok: false, error: 'video_probe_unavailable',
             detail: `${e.message}｜${String(e.stdout ?? '').slice(-300)}${String(e.stderr ?? '').slice(-300)}` };
  }
}

/** 建一个「这次读视频」专用的临时目录。**用完必须删**（`cleanup`）。 */
export function makeTempDir(tag = 'shouheng-video') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${tag}-`));
}

/** 删掉临时目录；删不掉也不抛（不能因为收尾失败让整条回话失败）。 */
export function cleanup(dir) {
  try { if (dir) fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 收尾失败不致命 */ }
}

/**
 * 抽元数据与关键帧。
 * @returns {Promise<object>} 探针的读数（`ok:false` 时带 `error`）
 */
export async function probeVideo(filePath, { frames = VIDEO_MAX_FRAMES, outDir, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { ok: false, error: 'not_found', detail: `视频文件不存在：${filePath ?? '(空路径)'}` };
  }
  let size = 0;
  try { size = fs.statSync(filePath).size; } catch { /* 按 0 处理 */ }
  if (!size) return { ok: false, error: 'empty_file', detail: '视频字节是 0 —— 取回来的就是个空文件' };
  if (size > MAX_VIDEO_BYTES) {
    return { ok: false, error: 'too_large', detail: `${size} 字节 > 上限 ${MAX_VIDEO_BYTES}` };
  }

  const bin = await ensureVideoProbe();
  if (!bin.ok) return { ok: false, error: bin.error, detail: bin.detail };

  const dir = outDir ?? makeTempDir();
  const n = Math.max(1, Math.min(VIDEO_MAX_FRAMES * 5, Number(frames) || VIDEO_MAX_FRAMES));
  try {
    const r = await execFileP(bin.path, [filePath, dir, String(n)], { timeout: timeoutMs, maxBuffer: 1 << 24 });
    let d;
    try { d = JSON.parse(String(r.stdout ?? '').trim()); }
    catch { return { ok: false, error: 'bad_output', detail: String(r.stdout ?? '').slice(0, 200), outDir: dir }; }
    return { ...d, outDir: dir };
  } catch (e) {
    if (e.killed || e.signal) return { ok: false, error: 'timeout', detail: `超过 ${timeoutMs}ms`, outDir: dir };
    // 探针对「解不开的容器」是**退出码非 0 + 一行 JSON**，所以这里要把 stdout 捞出来解析，
    // 不能一律报 spawn_failed —— 「这个文件不是视频」与「探针起不来」是两件事。
    const out = String(e.stdout ?? '').trim();
    if (out) {
      try { return { ...JSON.parse(out), outDir: dir }; } catch { /* 落到下面 */ }
    }
    return { ok: false, error: 'probe_failed', detail: `${e.message}｜${String(e.stderr ?? '').slice(-200)}`, outDir: dir };
  }
}

/**
 * 把视频的音轨抽成 22.05kHz 单声道 wav（`afconvert` 是系统自带的，不是第三方）。
 * @returns {Promise<{ok:boolean, path?:string, error?:string, detail?:string}>}
 */
export async function extractAudio(filePath, outWav, { timeoutMs = AUDIO_EXTRACT_TIMEOUT_MS } = {}) {
  try {
    await execFileP('afconvert', ['-f', 'WAVE', '-d', 'LEI16@22050', '-c', '1', filePath, outWav],
                    { timeout: timeoutMs, maxBuffer: 1 << 22 });
  } catch (e) {
    return { ok: false, error: 'audio_extract_failed', detail: `${e.message}｜${String(e.stderr ?? '').slice(-200)}` };
  }
  let size = 0;
  try { size = fs.statSync(outWav).size; } catch { /* 按 0 处理 */ }
  if (!size) return { ok: false, error: 'audio_extract_empty', detail: 'afconvert 退 0，但抽出来的 wav 是 0 字节' };
  return { ok: true, path: outWav, bytes: size };
}

/**
 * 读一条视频：元数据 + 关键帧 OCR + 口播转写。
 *
 * @param {string} filePath 本机视频文件
 * @param {{locale?:string, frames?:number, ocr?:Function, asrFn?:Function, tempDir?:string}} [opt]
 *        `ocr` / `asrFn` 是测试注入点（与 `readInboundContent` 同一套写法）。
 * @returns {Promise<object>} 见下面 return 处的字段注释
 */
export async function readVideo(filePath, {
  locale = null,
  frames = VIDEO_MAX_FRAMES,
  ocr = vision.ocrImage,
  // ★ 2026-10-16：**画面层**（PRD §5.1 对视频写的「画面关键帧」）。
  //   与 `ocr` 同级注入：测试要能打桩，否则这条路只能联网+花 token 才测得动。
  scene = sceneMod.sceneRead,
  asrFn = asr.transcribe,
  tempDir = null,
} = {}) {
  const t0 = Date.now();
  const ownDir = tempDir ?? makeTempDir();
  const cleanupFn = () => cleanup(ownDir);
  const notes = [];
  // ★ 2026-10-28：分段耗时，速度侧可观测
  const perf = {};

  const probe = await probeVideo(filePath, { frames, outDir: ownDir });
  perf.probe_ms = Date.now() - t0;
  if (!probe.ok) {
    return {
      ok: false, error: probe.error, detail: probe.detail ?? null,
      outDir: ownDir, cleanup: cleanupFn, ms: Date.now() - t0,
    };
  }

  const meta = {
    duration_s: probe.duration_s ?? null,
    w: probe.w ?? null, h: probe.h ?? null, fps: probe.fps ?? null,
    has_audio: probe.has_audio === true,
    audio_channels: probe.audio_channels ?? 0,
    audio_rate: probe.audio_rate ?? 0,
  };

  // ── 关键帧 → OCR（画面上的字：硬字幕、贴片文案、品牌 logo、包装声明）──
  // ★ 2026-10-28：改为并发 OCR_CONCURRENCY（默认 2）。
  //   原先 for...await 串行：8 帧 × ~1.2s = ~9.6s；并发 2 降到 ~4.8s。
  //   frameOcr 保序（Promise.all 按下标 resolve）；framesFailed / ocrChars 在所有帧完成后汇总。
  const frameOcr = [];
  let ocrChars = 0;
  let framesFailed = 0;
  {
    const allFrames = probe.frames ?? [];
    // 按 OCR_CONCURRENCY 分批，每批内并发，批间串行（防止 OCR 进程被同时拉起太多）
    for (let i = 0; i < allFrames.length; i += OCR_CONCURRENCY) {
      const batch = allFrames.slice(i, i + OCR_CONCURRENCY);
      const batchResults = await Promise.all(batch.map(async (f) => {
        let r;
        try { r = await ocr(f.path); }
        catch (e) { r = { ok: false, error: 'ocr_threw', detail: String(e?.message ?? e) }; }
        if (!r?.ok) {
          return { t_s: f.t_s, failed: r?.error ?? 'unknown', detail: r?.detail ?? null };
        }
        const rawText = String(r.text ?? '');
        // ★★ 2026-10-27（Owner 四步根治第 3 步）：当单帧识别行数 ≥ 10 行（典型：视频里一闪而过手机 App Store/设置界面）
        //   且带 `boxes[].h`（归一化框高）时，过滤字高 `h < 0.014` 或置信度 `c < 0.45` 的极小背景 UI 噪点行，
        //   避免把手机屏幕背景里的 App 更新日志碎片（如 `BM08 monitors / WN02 Baby Sound / robuidste`）混入主字幕流。
        let text = rawText;
        if (Array.isArray(r.boxes) && r.boxes.length >= 10 && r.boxes.some((b) => Number.isFinite(b?.h))) {
          const mainLines = r.boxes
            .filter((b) => (b?.h == null || b.h >= 0.014) && (b?.c == null || b.c >= 0.45))
            .map((b) => String(b?.t ?? '').trim())
            .filter(Boolean);
          if (mainLines.length > 0) text = mainLines.join('\n');
        }
        // ★★ 2026-10-16：**逐行置信度一起带出去**（`boxes` 里带 `c`，见 `vision.mjs` 那一段）。
        //   为什么视频这一路也要：模型侧对视频同样会写「画面 / 字幕上是中文」这类条目，
        //   而「汉字声称闸」（`ocr_claim_gate.mjs`）判的就是「这条声称有没有读数撑得住」——
        //   帧上的字若没有 `c`，闸门只能一律降级 ⇒ 真中文字幕会被误杀。
        //   ⚠️ 帧上文字仍以 `text` 为唯一对外文本；`boxes` 只作证据，**不进卡片**。
        return { t_s: f.t_s, text, textRaw: rawText, lines: r.lines ?? null, boxes: r.boxes ?? null };
      }));
      frameOcr.push(...batchResults);
    }
    // 汇总统计（保序后一次 pass）
    for (const entry of frameOcr) {
      if (entry.failed != null) { framesFailed++; }
      else { ocrChars += String(entry.text ?? '').length; }
    }
  }
  if (probe.n_frames === 0) {
    // 「抽不出帧」有三种成因（没有视频轨 / 解不开 / 时长读成 0），探针的读数分不开，
    // 所以这里如实说「这一段没抽到帧」，而不是说「画面没问题」。
    notes.push('这一段没抽出任何帧 —— 画面上的字这一路是空的（可能是纯音频、也可能解不开视频轨）');
  }
  if (framesFailed > 0) notes.push(`${framesFailed} 帧抽出来了但 OCR 读失败（不是「画面上没字」）`);
  perf.ocr_ms = Date.now() - t0 - perf.probe_ms;

  // ── 音轨 → 转写（口播/旁白）──
  let transcript = null;
  if (!meta.has_audio) {
    // ★ 读数，不是失败：静音视频 / 纯画面视频是合法素材。
    transcript = { ok: false, kind: 'no_audio_track', hint: '这条视频没有音轨 —— 是读数，不是转写失败。' };
  } else if (Number.isFinite(meta.duration_s) && meta.duration_s > MAX_TRANSCRIPT_SECONDS) {
    transcript = { ok: false, kind: 'too_long',
                   hint: `时长 ${Math.round(meta.duration_s)}s 超过转写上限 ${MAX_TRANSCRIPT_SECONDS}s —— 本次没转写。` };
  } else {
    const wav = path.join(ownDir, 'audio.wav');
    const ex = await extractAudio(filePath, wav);
    // ★ 2026-10-08：**用画面文字先定语种**，再决定转写试哪个语种、什么顺序。
    //   病灶：原来固定传 `{}` ⇒ 走 `ASR_LOCALES = ['zh-CN','en-US']`（中文优先），
    //   而 `transcribe()` 是「第一个 ok 就 return」⇒ **英文视频被按中文识别成胡话**，
    //   还带 `ok:true` 回来（实测见 `asr.mjs::checkScript()` 头注）。
    //   这里用 `frameOcr`（上面刚跑完的关键帧 OCR）当样本：**零额外成本**，
    //   而且把「猜语种」变成一条可复核的读数（`locale_basis` 会带到群里那张卡上）。
    const hint = locale ? { locales: [locale], basis: `调用方显式指定语种 ${locale}` }
                        : asr.orderLocalesByText(frameOcr.map((f) => f.text ?? '').join('\n'));
     transcript = ex.ok
       ? { ...(await asrFn(wav, { locales: hint.locales })), locale_basis: hint.basis }
       : { ok: false, kind: ex.error, detail: ex.detail };
  }
  perf.asr_ms = Date.now() - t0 - perf.probe_ms - perf.ocr_ms;

  // ④ 用**同一个** `frameLine`（见其头注）—— 这一格是给库侧的检索文本，原先自己拼过一份。
  //    与改动前**逐字等价**：`indent:false`（不缩进）+ `oneLine:false`（保留原始换行）。
  let ocrText = frameOcr.filter((f) => f.text)
    .map((f) => frameLine(f, { indent: false, oneLine: false })).filter(Boolean).join('\n');
  let ocrTruncated = false;
  if (ocrText.length > VIDEO_MAX_OCR_CHARS) {
    ocrTruncated = true;
    ocrText = `${ocrText.slice(0, VIDEO_MAX_OCR_CHARS)}\n…〔关键帧 OCR 文字原长 ${ocrText.length} 字，按 ${VIDEO_MAX_OCR_CHARS} 字上限截断〕`;
  }

  // ── ★★ 2026-10-16：**关键帧的画面层**（PRD §5.1 对视频写的是「画面关键帧」）──────
  //   与图片那条同形状、同纪律（见 `scene.mjs` 头注）：只读临时目录里的帧、
  //   只陈述看得见的、读不到要说「未测」而不是「没问题」。
  //   ⚠️ **不是每帧都看**：`SCENE_FRAMES_MAX`（默认 3，可环境变量覆盖）——
  //      8 帧各一次调用，成本与延迟按帧数线性涨；画面层的价值在「有没有这回事」，
  //      不在逐帧穷举。**覆盖了哪几帧必须写进读数**（没覆盖的帧是真·未测）。
  const frameScene = [];
  const sampleFramePaths = [];
  const scenePlan = [];
  // ★ 「这一单没跑」**不许由消费方猜**（空数组可能是「开关关着」「没抽到帧」「老数据没这个字段」）——
  //   由产者在这里写成一句 `sceneSkipReason`。猜出来的那句话，正是 §2.4.1 那个病。
  let sceneSkipReason = null;
  {
    const all = probe.frames ?? [];
    const k = Math.max(0, Math.min(Number(SCENE_FRAMES_MAX) || 0, all.length));
    if (!sceneMod.SCENE_ENABLED || (Number(SCENE_FRAMES_MAX) || 0) <= 0) {
      sceneSkipReason = '画面层未开（SHOUHENG_SCENE=0 或 SHOUHENG_SCENE_FRAMES=0）';
    } else if (!all.length) {
      sceneSkipReason = '这一段没抽出帧，画面层无从读起';
    }
    const picks = [];
    for (let j = 0; j < k; j++) {
      // 均匀取 k 帧（含首尾）：开头/中间/结尾各看一眼，比连看三帧有用
      picks.push(k === 1 ? 0 : Math.round((j * (all.length - 1)) / (k - 1)));
    }
    // ★★ 2026-10-16 实测：**串行跑这 3 帧要 41 秒**（各 16.1 / 21.1 / 3.7 s）——
    //   它们之间**没有任何依赖**（同一段视频的三帧，各自独立一次读数）
    //   ⇒ 并行发出去，总时长 ≈ 最慢的那一帧，不是三者之和。
    //   ⚠️ `Promise.all` 保序（与 `picks` 一一对应），所以「哪一帧是哪一帧」不会错位。
    const uniq = [...new Set(picks)].map((i) => all[i]).filter((f) => f?.path);
    scenePlan.push(...uniq.map(f => f.t_s));
    for (const f of uniq) {
      if (f?.path && fs.existsSync(f.path)) sampleFramePaths.push(f.path);
    }
    const settled = await Promise.all(uniq.map(async (f) => {
      try { return { t_s: f.t_s ?? null, ...(await scene(f.path)) }; }
      catch (e) { return { t_s: f.t_s ?? null, ok: false, ms: 0, error: `画面读数抛异常：${e?.message ?? e}` }; }
    }));
    frameScene.push(...settled);
    // ADR-0015：只校准视觉模型实际看过的代表帧；本机 OCR 原文保留在 `textRaw`。
    for (const sc of settled) {
      if (!sc?.ok || !(sc.scene?.clean_text ?? []).length) continue;
      const frame = frameOcr.find((f) => Number.isFinite(Number(f?.t_s))
        && Math.abs(Number(f.t_s) - Number(sc.t_s)) < 0.05);
      if (!frame?.text) continue;
      const calibrated = vision.calibrateOcrText(frame.text, sc.scene.clean_text);
      frame.textRaw = frame.textRaw ?? frame.text;
      frame.textCalibrated = calibrated.text;
      frame.ocrCalibrations = calibrated.replacements;
    }
    // 库侧检索文本必须在视觉校准之后生成；未看过的帧仍用本机 OCR。
    ocrText = frameOcr.filter((f) => f.textCalibrated ?? f.text)
      .map((f) => frameLine(f, { indent: false, oneLine: false })).filter(Boolean).join('\n');
    ocrChars = frameOcr.reduce((n, f) => n + String(f.textCalibrated ?? f.text ?? '').length, 0);
    ocrTruncated = false;
    if (ocrText.length > VIDEO_MAX_OCR_CHARS) {
      ocrTruncated = true;
      ocrText = `${ocrText.slice(0, VIDEO_MAX_OCR_CHARS)}\n…〔关键帧 OCR 文字原长 ${ocrText.length} 字，按 ${VIDEO_MAX_OCR_CHARS} 字上限截断〕`;
    }
    if (frameScene.length) {
      const got = frameScene.filter((s) => s.ok).length;
      notes.push(`画面读数覆盖 ${frameScene.map((s) => `${Number(s.t_s ?? 0).toFixed(1)}s`).join(' / ')}`
        + `（共 ${all.length} 帧，成功 ${got}/${frameScene.length}）`
        + `—— **没覆盖的那几帧画面是真未测**，不许说成「整条视频的画面都看过了」`);
    }
     if (frameScene.some((s) => !s.ok && s.error)) {
       notes.push(`${frameScene.filter((s) => !s.ok && s.error).length} 帧画面**没读到**`
         + '（「没读到」不是「画面没问题」）');
     }
  }
  perf.scene_ms = Date.now() - t0 - perf.probe_ms - perf.ocr_ms - perf.asr_ms;
  perf.total_ms = Date.now() - t0;

  return {
    ok: true,
    meta,
    frames: frameOcr,
    framesRead: frameOcr.length - framesFailed,
    framesFailed,
    frameScene,
    scenePlan,
    sampleFramePaths,
    sceneSkipReason,
    ocrText,
    ocrChars,
    ocrTruncated,
    transcript,
    notes,
    perf,
    outDir: ownDir,
    cleanup: cleanupFn,
    ms: Date.now() - t0,
  };
}

/* ─────────────────── 长视频分段抽样（>120s）──────────────────────── */

/**
 * 超过多少秒时启用分段抽样（默认 120s）。
 * 环境变量 `SHOUHENG_VIDEO_SEGMENT_S` 可覆盖（0 = 禁用分段，全程单次抽样）。
 */
export const VIDEO_SEGMENT_SECONDS = Math.max(0,
  Number(process.env.SHOUHENG_VIDEO_SEGMENT_S ?? 120));

/**
 * 每段抽多少帧 OCR（默认 = VIDEO_MAX_FRAMES，与短视频一致）。
 * 短尾段（时长 < 完整段一半）按比例缩减，避免重复采样。
 */
export const VIDEO_FRAMES_PER_SEGMENT = VIDEO_MAX_FRAMES;

/**
 * 长视频分段读取：每 `VIDEO_SEGMENT_SECONDS` 秒为一段，各段独立抽样，
 * 结果合并时保留**全局时间码**（frames[].t_s 是全局秒数，不是段内秒数）。
 *
 * ★ 实现原理（ponytail 最小改动）：
 *   不改 probeVideo 接口，而是一次请求总帧数 = 段数 × 每段帧数，
 *   然后在 JS 层把帧按时间窗口分组。全局时间码由 probeVideo 的新首尾策略自然保留。
 *   分段信息附在返回值的 `segments[]` 字段里，调用方可据此向用户说明哪些段已覆盖。
 *
 * @returns {Promise<object>} 与 `readVideo` 相同的字段集合，额外附 `segments`
 */
export async function readVideoSegmented(filePath, opts = {}) {
  const segLen = VIDEO_SEGMENT_SECONDS;
  // 先用 1 帧 probe 获取时长，再决定是否分段
  const metaProbe = await probeVideo(filePath, { frames: 1 });
  if (!metaProbe.ok) {
    // 探针失败时退回普通 readVideo（不影响可用性）
    return readVideo(filePath, opts);
  }
  const dur = metaProbe.duration_s ?? 0;
  cleanup(metaProbe.outDir);

  // ≤120s 或分段禁用：直接走单次抽样
  if (!segLen || dur <= segLen) return readVideo(filePath, opts);

  // 分段：计算段数和总帧数
  const nSegs = Math.ceil(dur / segLen);
  const totalFrames = Math.min(
    nSegs * VIDEO_FRAMES_PER_SEGMENT,
    100,           // video_probe 二进制上限 100
  );
  const actualFramesPerSeg = Math.floor(totalFrames / nSegs);

  // 一次 probeVideo 请求 totalFrames 帧（首尾策略自动分布全局时间）
  const r = await readVideo(filePath, { ...opts, frames: totalFrames });
  if (!r.ok) return r;

  // 构建分段元信息
  const frames = r.frames ?? [];
  const segments = Array.from({ length: nSegs }, (_, i) => {
    const segStart = i * segLen;
    const segEnd = Math.min((i + 1) * segLen, dur);
    const segFrames = frames.filter(f => {
      const t = Number(f.t_s ?? 0);
      return t >= segStart && t < segEnd;
    });
    const missing = segFrames.length === 0;
    return {
      index: i + 1,
      start_s: Math.round(segStart),
      end_s: Math.round(segEnd),
      duration_s: Math.round(segEnd - segStart),
      frames_covered: segFrames.length,
      max_gap_s: segFrames.length > 1
        ? Math.max(...segFrames.slice(1).map((f, j) => Number(f.t_s) - Number(segFrames[j].t_s))).toFixed(1)
        : (segFrames.length === 1 ? (segEnd - segStart).toFixed(1) : null),
      missing,
    };
  });

  const missingSeg = segments.filter(s => s.missing);
  if (missingSeg.length) {
    r.notes = [...(r.notes ?? []),
      `⚠️ 分段覆盖缺口：${missingSeg.map(s => `第${s.index}段(${s.start_s}s-${s.end_s}s)`).join('、')} 没有抽到帧`
      + '——未覆盖的时间段是**真未测**，不许当成「没问题」'];
  }

  return { ...r, segments, segmented: true, nSegs, framesPerSeg: actualFramesPerSeg };
}

/* ─────────────────── 自检 / 预热（启动时跑一次） ─────────────────── */

/**
 * 视频这条路的自检：探针在不在（不在就编）→ 拿试纸抽帧 → 拿 OCR 读那行大字。
 *
 * 与 `vision.preflight()` / `asr.preflight()` 同一个理由：**坏了要能自己说出来**。
 * 返回的读数进 `ws_daemon.mjs` 的启动横幅。
 *
 * ★ 它**不**检查语音那一半 —— 那一半归 `asr.preflight()`，两件事分开报：
 *   「画面读得了、声音读不了」和「两样都不行」引出的下一步完全不同。
 */
export async function preflight() {
  const bin = await ensureVideoProbe();
  if (!bin.ok) return { ok: false, bin: false, error: bin.error, detail: bin.detail };
  if (!fs.existsSync(VIDEO_FIXTURE)) {
    return { ok: false, bin: true, error: 'fixture_missing',
             detail: `试纸不在：${VIDEO_FIXTURE} —— 没有试纸就无法证明这条路是通的` };
  }
  const dir = makeTempDir('shouheng-video-preflight');
  try {
    const probe = await probeVideo(VIDEO_FIXTURE, { frames: 3, outDir: dir });
    if (!probe.ok) {
      return { ok: false, bin: true, built: !!bin.built, error: probe.error, detail: probe.detail ?? null };
    }
    if (!probe.frames?.length) {
      return { ok: false, bin: true, built: !!bin.built, error: 'no_frames',
               detail: '试纸一段帧都没抽出来 —— 抽帧这条路是断的' };
    }
    let lastErr = null;
    for (const f of probe.frames) {
      const r = await vision.ocrImage(f.path);
      if (!r.ok) { lastErr = r; continue; }
      const hit = String(r.text ?? '').toUpperCase().includes(VIDEO_FIXTURE_TOKEN);
      if (hit) {
        return { ok: true, bin: true, built: !!bin.built, duration_s: probe.duration_s,
                 n_frames: probe.n_frames, ocrMs: r.ms, probeMs: probe.ms };
      }
      lastErr = { error: 'fixture_token_missing', detail: `读出 ${r.lines} 行但没有「${VIDEO_FIXTURE_TOKEN}」` };
    }
    return { ok: false, bin: true, built: !!bin.built, error: lastErr?.error ?? 'ocr_failed',
             detail: lastErr?.detail ?? '试纸的帧 OCR 全失败' };
  } finally {
    cleanup(dir);
  }
}

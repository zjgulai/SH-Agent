/**
 * agent.mjs —— 守衡的推理内核（消息进来 → 想 → 用工具 → 出话）
 *
 * 处理一条消息的完整链路：
 *   去重 → 解析 mention → 装上下文 → 载记忆 → 工具循环 → 存记忆（必要时压缩）→ 返回回复
 *
 * 三个容易被忽略但必须做对的地方：
 *   1. 同一会话串行：群里两条消息几乎同时到达时，并发写同一个记忆文件会互相覆盖。
 *   2. 已处理消息去重：长连接重连后服务端可能重推，不做去重会重复回话。
 *   3. 工具循环有上限：模型可能反复调同一个工具，必须有硬闸。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { config, stateDir } from './config.mjs';
import { buildSystemPrompt } from './persona.mjs';
import * as llm from './llm.mjs';
import * as mem from './memory.mjs';
import * as feishu from './feishu.mjs';
import * as vision from './vision.mjs';
import * as sceneMod from './scene.mjs';
import { SCENE_MAX_EDGE } from './scene.mjs';
// ★ 2026-10-16（Owner）：「送审问题」里的图/视频要变成**点一下就开**的链接，
//   且那一格**只留原文**（起因是实测发现 54 行里躺着我们自己的内部指令）。
//   详见 `media_link.mjs` 头注（三条裁定、fail-closed、红线）。
import * as mediaLink from './media_link.mjs';
// ★ 2026-10-09：OCR 水印摘除（Owner 看出图内文字里的用户名是水印）——见该模块头注
import { stripOcrWatermark } from './ocr_watermark.mjs';
// ★ 2026-10-21（Owner）：图单的视觉核对清单 —— 「加载了 skill」不等于「执行了它那道视觉核对」
import { checkImageReport } from './image_report_completion.mjs';
import { loadImageFactSources, kbFactSources } from './image_fact_sources.mjs';
import { adjudicateImageClaims } from './image_claim_review.mjs';
// ★★ 2026-10-21（Owner 批准 P0）：**看到图、但一张都没解析出来 ⇒ 不许出 PASS**。
//   病灶（实测）：模态是用「解析出的图数」**猜**的 —— 图一旦没被解析成图片
//   （飞书里**以文件方式发的图** `msgType='file'`、图消息缺 image_key、富文本图节点解析不到、
//    引用那条回读失败），`--content-type` 就退化成 `text` ⇒ **「负面样本规则」整层不跑**
//   ⇒ 出 `PASS / 0 条`。同一份图，只差这一个词（`tools.mjs` 约 1944 行记着实测）。
//   判据在 `image_intent_gate.mjs`（纯函数，12 条自证）；本文件只负责**接线与拒答**。
import { detectImageIntent, imageIntentVerdict } from './image_intent_gate.mjs';
// ★★ 2026-10-22：判定主体（图片安全审查 skill）判在**散文**里的问题，抽成结构化条目 ——
//   否则它们一条都上不了卡（实测那张 11478 字的回答，5 条实质问题全被卡丢掉）。
import { skillFindingsOf } from './skill_findings.mjs';
import * as video from './video.mjs';
import { KB_ROOT, TOOL_SCHEMAS, executeTool, runtimeContext, toolNames, claimStatus, facetsFromMaterial,
         beginChainTurn, setChainTurnImagePaths, chainMemoStats, beginP0Turn, p0MemoRead,
         beginChainAnswerTurn, chainAnswerRead,
         runP0Preflight, p0Precheck, withAgentTurnContext, setAgentTurnContext } from './tools.mjs';
import { detectTruncation, annotateTruncation, tailOf, collapseToolMessages, clipToolOutput,
         TOOL_OUTPUT_MAX_CHARS } from './truncate.mjs';
import { parentIdOf, alreadyInHistory, buildQuoteBlock } from './thread.mjs';
import * as reviewGate from './review_gate.mjs';
import { readLinkAccess } from './link_access_read.mjs';
import { isVideoDirectUrl, downloadVideoToFile } from './link_reader.mjs';
import { mergeFindings, mergedState, kbFindingsOf, kbCoveredOf, renderMerged, mergeSummary, kbSideOf,
         mergedConfidence, kbNoReadingOf, REPORT_LINK_MIN_ISSUES, evidenceBlock,
         p0HitOf } from './dual_track.mjs';
import { renderMergedReportMd, publishMergedReport, writeMergedRecord,
         shouldPublishMergedReport } from './merged_report.mjs';
// ★ 2026-10-19（Owner 裁定「1→2→3 全做」的第 1 步）：逐条结构化记录的**唯一生产者**。
//   它把「这一条是模型侧还是库侧 / 回不回得了源 / 哪一格被截了几字」落盘 ——
//   卡面随后就能把那句「无库内依据 · 建议转人工」摘掉，而**问的时候仍然答得出来**。
import { buildMergedRecord } from './merged_record.mjs';
import { reviewModelSide, readingsForModelSide, canonicalImageAuditRequest } from './model_side.mjs';
import * as ocrGate from './ocr_claim_gate.mjs';
import { generateAdvice } from './advice.mjs';
import * as reviewPublish from './review_publish.mjs';
import { deriveVerdictLine } from './prd53.mjs';
import { reviewFailureOf, reviewFailureText, shouldRetryReview } from './review_feedback.mjs';
import { REVIEW_LIMIT_MS } from './review_timing.mjs';
import { withReviewDeadline, REVIEW_SEND_RESERVE_MS } from './review_deadline.mjs';
import { checkVideoCompletion, isConfirmedP0Block } from './video_completion.mjs';
import { videoAnalysisOf, withVideoAnalysis } from './video_evidence.mjs';
import { foldInto } from './outbound.mjs';

/* ─────────────────── 去重：见过的事件不再处理 ─────────────────── */
// 惰性求值：测试需要把状态目录指到不可写路径来验证失败分支，
// 写成模块常量就再也改不动了（且失效是静默的）。
const seenFile = () => path.join(stateDir(), 'seen-messages.json');
const SEEN_MAX = 500;

function loadSeen() {
  try { return new Set(JSON.parse(fs.readFileSync(seenFile(), 'utf8'))); } catch { return new Set(); }
}
let seen = loadSeen();
let seenDirty = false;
let seenFlushFailed = 0;   // 连续落盘失败次数，用于「只报第一次、恢复时报一次」

export function hasSeenMessage(messageId) {
  if (!messageId) return false;
  return seen.has(messageId);
}

export function alreadyHandled(messageId) {
  if (!messageId) return false;
  if (seen.has(messageId)) return true;
  seen.add(messageId);
  seenDirty = true;
  if (seen.size > SEEN_MAX) {                       // 只保留最近的，避免文件无限增长
    const arr = [...seen].slice(-SEEN_MAX);
    seen = new Set(arr);
  }
  return false;
}
/** 把一条消息从「已处理」里撤掉（异常出口用）。
 *  ★ 2026-10-26 实测事故：16:13 那次内核异常发生在**去重已登记之后** ⇒ 用户那条群 @
 *  被记成「已处理」，飞书重推也一律 `duplicate` ⇒ **群里永远不回**，而且日志只说"不回复（duplicate）"。
 *  ⇒ 出异常就等于没答，必须把登记撤掉，让重推/重发还能被答。
 */
export function forgetHandled(messageId) {
  if (!messageId) return false;
  if (!seen.has(messageId)) return false;
  seen.delete(messageId);
  seenDirty = true;
  return true;
}

/** 本轮**正在处理**的消息（重启/异常时要把它们从「已处理」里撤掉）。
 *  ⚠️ 2026-11-03 实测：16:34 那条图收到回执后 2 秒进程被 SIGTERM（重启）掐断，
 *  它的 message_id 已经写进去重表 ⇒ 重启后飞书重推一律 `duplicate` ⇒ **那条永远没有答案**，
 *  日志里只有一句「不回复（duplicate）」。⇒ 收尾时必须把**在飞的那几条**撤掉。 */
const inFlight = new Set();
export function markInFlight(messageId) { if (messageId) inFlight.add(String(messageId)); }
export function clearInFlight(messageId) { if (messageId) inFlight.delete(String(messageId)); }
export function releaseInFlight() {
  const ids = [...inFlight];
  inFlight.clear();
  let released = 0;
  for (const id of ids) if (forgetHandled(id)) released += 1;
  return { released, ids };
}
export function inFlightIds() { return [...inFlight]; }

export function flushSeen() {
  if (!seenDirty) return;
  try {
    // 写入点自己保证父目录存在：配置加载时的那次 mkdir 是「尽力而为」，
    // 目录若在运行中被删掉，这里补建，而不是让每次落盘都失败。
    fs.mkdirSync(path.dirname(seenFile()), { recursive: true });
    fs.writeFileSync(seenFile(), JSON.stringify([...seen]));
    seenDirty = false;
    if (seenFlushFailed) {            // 恢复后报一次，避免故障期间刷屏
      console.warn(`[seen] 去重表恢复落盘（曾在 ${seenFlushFailed} 次写入失败后成功）`);
      seenFlushFailed = 0;
    }
  } catch (e) {
    // 重要：失败时不能清 seenDirty。
    // 清了就再也不会重写，而这个表决定「重启后是否重复回话」——
    // 它一旦静默丢失，表现是守衡对着同一条消息回两次，且没有任何线索。
    seenFlushFailed++;
    if (seenFlushFailed === 1) {
      console.warn(`[seen] 去重表落盘失败（第 1 次）：${e.code ?? e.message} —— 本次运行仍按内存去重，但重启后可能重复回话`);
    }
  }
}

/**
 * Pick the §5.3 verdict for the final reply. An incomplete media workflow is a
 * hard stop: never recover an older verdict from P0, the review chain, or the
 * model reply after the submission gate has deliberately withheld its verdict.
 */
export function finalVerdict53ForTurn({ gateResult = null, p0Payload = null,
                                        toolTrace = [], chainAnswer = null,
                                        reply = '' } = {}) {
  if (gateResult?.reviewDecisionWithheld || gateResult?.imageReviewIncomplete || gateResult?.videoReviewIncomplete) return null;
  return gateResult?.verdict53
    ?? (p0Payload
      ? deriveVerdictLine({ replyText: reply, reviewedByTool: true,
                            answer: p0Payload.answer, p0Fastpath: p0Payload.p0Fastpath })
      : (toolTrace.some((x) => x.tool === 'kb_review_chain' && x.ok)
        ? deriveVerdictLine({ replyText: reply, reviewedByTool: true,
                              answer: chainAnswer?.answer ?? '',
                              p0Fastpath: chainAnswer?.p0Fastpath ?? null })
        : null));
}

/* ─────────── 图单：画面这一半到底读没读到 + 拿不到结论时对**人**怎么说 ───────────
 *
 * ── 为什么必须有这两件（2026-10-22 19:36 生产实测，Owner 当场把回复截图甩回来）
 *   那一单的真实回话是：
 *     「这张图片的完整审查流程没有完成，暂不出 PASS / REVIEW / BLOCK 结论。
 *      视觉核对的结论没写清：场景关系（判"未测"但没给原因）。**请重新发送原图**，…」
 *   三处都不对：
 *     ① 判据错杀（真因）—— 报告第七节写的是表格 `| 场景关系 | 未测 | 同上 |`，
 *        「同上」指的是上一行那句理由。判据把它当「没给原因」⇒ 整份合格报告被判成没跑完。
 *        （判据侧已改，见 `visual_checklist.mjs` 的 `resolveAnaphora`）
 *     ② **卡点在我这一侧**：同一单的画面读数是「没读到（画面模型 HTTP 402 Insufficient Balance）」，
 *        跟对方发的那张图一点关系都没有 —— 而回复让人**重发原图**。他重发了四次，四次同一句。
 *     ③ 把判据的原话（「判"未测"但没给原因」「逐面板视觉核对」）直接甩进了群里。
 *   ⇒ 判据错杀修在判据里；**话术**修在这里：说清"没测完 ≠ 没问题"、卡在哪、以及
 *     **现在重发没用**。这两件都必须是可被单测直接调用的纯函数 ——
 *     一版只活在 `runSubmissionGate` 里的话术，判据够不着（§2.4.7 那条教训）。
 */

/**
 * 这一单的**画面读数**怎么了。三态要分得开（读数里没写 ≠ 没看）：
 *   · 读到了            ⇒ 不进结果
 *   · 读了没读到/报错   ⇒ `{index, why, human}`
 *   · 这一单没跑画面层  ⇒ `{index, why:'画面层没有跑', human:'画面层这一单没跑'}`
 * 图单的 `skipped`、缺少成功标志或结构化读数都算缺口；P0 早停豁免由完成闸单独处理。
 */
export function sceneFaultsOf(inbound) {
  const out = [];
  const images = Array.isArray(inbound?.images) ? inbound.images : [];
  const expected = Number(inbound?.imageCount) || 0;
  if (expected > images.length) {
    out.push({ index: null, why: `${expected - images.length} 张图片没有画面读数记录`,
      human: '本轮有图片没有交出画面读数' });
  }
  for (const [i, im] of images.entries()) {
    const sc = im?.scene;
    const index = Number.isFinite(im?.index) ? im.index : i + 1;
    let why = '';
    if (!sc) why = '画面层没有跑';
    else if (sc.skipped) why = String(sc.error || '画面层被跳过，本轮没有执行视觉读取');
    else if (sc.ok !== true) why = String(sc.error || '画面读数没有本轮成功执行标志');
    // parseScene always returns an object with people[]. An empty array or an
    // unknown setting is valid; an absent/malformed payload is not execution evidence.
    else if (!sc.scene || typeof sc.scene !== 'object' || Array.isArray(sc.scene)
      || !Array.isArray(sc.scene.people)) why = '画面层没有交出完整的结构化读数';
    if (why) out.push({ index, why, human: humanizeSceneError(why) });
  }
  return out;
}

/** 把画面层的报错压成一句人话 —— 整段 JSON 不许甩进群里（群友读不懂，也没必要读）。 */
export function humanizeSceneError(err) {
  const s = String(err ?? '').trim();
  if (!s) return '原因未给';
  const bits = [];
  const code = s.match(/HTTP\s*(\d{3})/)?.[1];
  if (code) bits.push(`HTTP ${code}`);
  // ★ 2026-10-22 换端点时实测的两种错误体（都是「谁的问题」不同、处置也不同）：
  //   · 401 `{"error":"Invalid API key"}` —— 密钥不对：改 key，不是等额度；
  //   · 403 `{"error":{"code":"model_not_allowed"}}` —— 这把 key 不许用这个模型名：改模型名。
  //   与「额度不足」混在一起说，会让人去充值一个根本不缺钱的账户（或反过来）。
  if (/invalid api key|unauthorized|authentication/i.test(s)) bits.push('密钥无效');
  else if (/model_not_allowed|not allowed for this api key/i.test(s)) bits.push('这个模型名不被允许');
  else if (/insufficient[_\s]?balance|insufficient_quota|余额不足|额度不足/i.test(s)) bits.push('额度不足');
  else {
    const msg = s.match(/"message"\s*:\s*"([^"]{1,60})"/)?.[1];
    if (msg) bits.push(msg);
  }
  if (bits.length) return bits.join(' · ');
  return s.replace(/\s+/g, ' ').slice(0, 60);
}

/**
 * 图单拿不到三态结论时，**群里那句人话**。
 *
 * 四条硬约束（每一条都对着一次真事故）：
 *   ① 先说清「**没测完 ≠ 没问题**」—— 否则这句话读起来像一次放行；
 *   ② **不许把卡点说成对方的素材**：画面读数没读到是我这一侧的端点，重发同一张图不会有不同结果；
 *   ③ 不带判据术语（「判"未测"但没给原因」「逐面板」这类是**内部**说法，进日志与留底件，
 *      不进群 —— 与「库内命中（读数）不进卡」同一条）；
 *   ④ 不承诺自动化（没有重跑队列就是没有）—— 只说**人**能怎么办。
 *
 * @param {{visualGate?:object, imageWorkflowGate?:object, sceneFaults?:Array}} o
 */
export function imageWithholdReply({ visualGate = null, imageWorkflowGate = null, sceneFaults = [] } = {}) {
  const faults = (Array.isArray(sceneFaults) ? sceneFaults : []).filter(Boolean);
  const why = [];
  if (faults.length) {
    const detail = faults
      .map((f) => `${f.index ? `图 ${f.index} ` : ''}${f.human || f.why || '原因未给'}`)
      .join('；');
    why.push(`**画面这一层我没读到**（${detail}）⇒ 姿势、产品状态、场景关系、隐私这些画面事实只能记「未测」`);
  }
  const missing = Array.isArray(visualGate?.missing) ? visualGate.missing : [];
  if (missing.length) why.push(`五类画面事实里还有 ${missing.length} 类没写：${missing.join('、')}`);
  const weak = Array.isArray(visualGate?.weakItems) ? visualGate.weakItems : [];
  if (weak.length) why.push(`这几项只给了结论、没写依据或原因：${weak.map((x) => x && x.label).filter(Boolean).join('、')}`);
  if (imageWorkflowGate && imageWorkflowGate.ok === false) {
    const n = Array.isArray(imageWorkflowGate.missing) ? imageWorkflowGate.missing.length : 0;
    why.push(`图片安全审查的流程没走完${n ? `（缺 ${n} 个环节）` : ''}`);
  }
  const sceneBlocked = faults.length > 0;
  return [
    '这张图的审查这一轮**没有做完**，所以**暂不出 PASS / REVIEW / BLOCK** —— 不是「没问题」，是**没测完**。',
    `卡在哪：${why.join('；') || '判定报告没有交齐'}`,
    sceneBlocked
      ? '怎么办：**现在重发同一张图结果一样** —— 卡点是我这一侧的画面读数，不是你的图。等端点恢复你再发一次，我把画面这一半补上再给结论。'
      : '怎么办：**不用重发图** —— 缺的是我这份判定报告本身，不是你的素材。要我按同一张图重跑，你说一声。',
  ].join('\n');
}

/**
 * 图单**根本没跑完**（链没跑成 / 超时 / 画面那一半没做成）时，群里那句人话。
 *
 * ★★ 2026-10-23 实测（Owner 当场把这句话甩回来）：
 *   ```
 *   本轮图片审查证据未通过：本轮没有可核对的知识库引擎 JSON；图片审查状态未验证。
 *   暂不出 PASS / REVIEW / BLOCK；请在原图和图片安全审查 skill 的本会话执行证据齐全后重新审核。
 *   ```
 *   三处都错：
 *     ① **把内部读数当理由**：「知识库引擎 JSON」「skill 的本会话执行证据」是**我们的**字段名，
 *        对方读完不知道自己该做什么 —— 与「库内命中（读数）不进卡」同一条纪律；
 *     ② **把要求甩给对方**：「请在…证据齐全后重新审核」＝ 让对方去做一件**他做不到**的事
 *        （那些字段只有我这一侧能产生）；
 *     ③ **没说清"停在哪、还等不等"** —— 那一单在链上静默了 9 分 9 秒（4B 联网核查挂死），
 *        而这句话读起来像"这一单审完了、没过"。
 *
 *   原因读结构化失败，不能把某一次事故的「4B 联网挂死」套到所有失败。
 *   是否已排队由发送层收到队列写入结果后补充；本函数尚无该结果，不能预先承诺。
 *
 * @param {{chainRan?:boolean, chainMs?:number, reason?:string, modelSideFailed?:boolean, failure?:object}} o
 */
export function imageUnfinishedReply({ chainRan = true, chainMs = 0, reason = '', modelSideFailed = false, failure = null } = {}) {
  const elapsed = Number(chainMs);
  const duration = Number.isFinite(elapsed) && elapsed > 0
    ? (elapsed >= 60000 ? `约 ${Math.round(elapsed / 60000)} 分钟` : `${Math.round(elapsed / 1000)} 秒`) : null;
  const head = '这张图**没审完**，所以**暂不出 PASS / REVIEW / BLOCK** —— 不是「没问题」，是**没测完**。';
  const where = failure?.code ? reviewFailureText(failure)
    : modelSideFailed ? `画面这一半没做成（${humanizeSceneError(reason)}）。`
      : !chainRan ? '审查服务本次调用失败，未能完成检查。'
        : '本轮没有取得完整的审查结果。';
  return [
    head,
    `卡在哪：${where}`,
    ...(duration ? [`本轮已用 ${duration}。`] : []),
    '要你做的：**不用重发这张图**。',
  ].join('\n');
}

/** Require positive, current KB evidence before any image review state can be published. */
export function imageEvidenceFailure(result, imageCount = 0, modelSide = null) {
  if (!(Number(imageCount) > 0)) return null;
  // ★★ 2026-10-22（Owner 现场那一单：图 + @守衡）—— **P0 确定性命中时这道闸不适用。**
  //
  //   病灶（生产实测，`om_x100b62aff6a2c22ccfd45eeca787bff`）：Owner 发了一张 momcozy 产品图
  //   ＋ @守衡（正文为空）。库侧 P0 快路命中 V02／E-2.124，`dual.rendered` 里 BLOCK 已经备好，
  //   而本函数却判「本轮没有可核对的知识库引擎 JSON」⇒ 强制 NEEDS_INPUT ⇒ 群里只收到
  //   一句「本轮图片审查证据未通过……请重新发送原图」。**一个已确定的 BLOCK 被自己的闸门藏掉。**
  //   为什么是判据本身错、而不是读数缺：
  //     ① 这一路**按设计就不会有**引擎 JSON —— PRD §6.3「P0 命中即停止后续审查」，
  //        L4→L7 与评审链根本没跑；拿一份「按 PRD 不该存在」的产物当缺证据，
  //        等于让每张命中 P0 的图单都必然拒答（§2.4.5 那种「两个各自都对的部件撞车」）。
  //     ② P0 的读数**自带**条款号 / 锚点 / source_sha256 / 报告链接，且只出 BLOCK ——
  //        这道闸防的是「没读过库就说合规（PASS）」，P0 只可能更保守，不存在那个风险。
  if (result?.p0_fastpath && typeof result.p0_fastpath === 'object') return null;
  if (!modelSide || modelSide.ok !== true || modelSide.skipped) {
    return `模型侧原图视觉/语义审查未完成${modelSide?.error ? `：${modelSide.error}` : ''}`;
  }
  const engine = result?.engine;
  if (!engine || typeof engine !== 'object') {
    return '本轮没有可核对的知识库引擎 JSON；图片审查状态未验证';
  }
  const gate = engine.image_skill_gate ?? engine.evidence_meta?.image_skill_gate
    ?? engine.review?.image_skill_gate;
  if (!gate || typeof gate !== 'object') {
    return '本轮引擎结果没有图片 skill 闸门读数；不能确认原图与完整 skill 已执行';
  }
  if (gate.ok !== true) {
    const checks = Array.isArray(gate.checks) ? gate.checks.filter(Boolean).join('；') : '';
    return checks || `图片 skill 闸门未通过（${gate.reason_code ?? '原因未提供'}）`;
  }
  const loaded = gate.load?.verdict === 'loaded' || gate.load?.verdict === 'success';
  if (!loaded) return '图片安全审查 skill 的本会话真实加载读数缺失或未通过';
  const state = String(engine.state ?? engine.decision?.state ?? engine.decision?.verdict ?? '').toUpperCase();
  if (state === 'NEEDS_INPUT') {
    return String(engine.summary ?? engine.decision?.summary ?? '知识库引擎拒绝给出本轮图片结论');
  }
  return null;
}

/** Preserve the same calibrated current-image text for source scope and completion. */
export function imageMaterialTextsOf(inbound) {
  return (inbound?.images ?? []).flatMap((im, index) => {
    const text = im.textCalibrated ?? im.wlText ?? im.text;
    const common = { image: im.index ?? index + 1, sha256: im.sha256 };
    const texts = [{ ...common, origin: 'image_ocr',
      status: im.failed ? 'failed' : im.truncated ? 'truncated' : im.ocrEmpty ? 'empty'
        : typeof text === 'string' ? (text.trim() ? 'ok' : 'empty') : 'unavailable',
      text: typeof text === 'string' ? text : '' }];
    if (Array.isArray(im.scene?.scene?.clean_text)) {
      const visualText = im.scene.scene.clean_text.join('\n');
      texts.push({ ...common, origin: 'visual_text',
        status: im.scene.scene.clean_text_truncated ? 'truncated' : visualText.trim() ? 'ok' : 'empty',
        text: visualText });
    }
    return texts;
  });
}

/** Complete image checks before any final report or status is published. */
async function checkImageCompletion({ inbound, res, model, chainRan, chainMs, checkReport }) {
  let incomplete = false;
  let visualGate = null;
  let imageWorkflowGate = null;
  let visualGateRefusal = null;
  const imageEvidenceReason = imageEvidenceFailure(res, inbound?.imageCount ?? 0, model);
  const executionFailure = reviewFailureOf(res, { withheld: true });
  const reportFailure = Number(inbound?.imageCount ?? 0) > 0 && executionFailure?.stage === 'report_generation'
    ? executionFailure : null;
  // Recovering the current engine JSON proves the engine ran. It does not prove
  // the final image skill report was completed after its generation failed.
  if (imageEvidenceReason || reportFailure) {
    incomplete = true;
    // ★ 2026-10-23：**群里那句话**换成纯函数生成（原因只进日志/落表，不进群）。
    //   旧句子把 `imageEvidenceReason` 原样拼进群消息，于是群里读到的是
    //   「没有可核对的知识库引擎 JSON …… skill 的本会话执行证据」——内部字段名 + 让对方做他做不到的事。
    visualGateRefusal = imageUnfinishedReply({
      chainRan,
      chainMs,
      reason: imageEvidenceReason,
      failure: res?.error || reportFailure ? executionFailure : null,
      // 模型侧没跑成是**另一类**卡点（画面这一半），措辞要分开
      modelSideFailed: !(model && model.ok === true && !model.skipped),
    });
    inbound.imageGateReason = reportFailure?.detail || imageEvidenceReason;
    console.log('[agent] 🖼 图片审查证据或报告未完成 ⇒ 强制 NEEDS_INPUT：' + inbound.imageGateReason);
  }
  // ── ★★ 图单：**视觉核对清单缺项 ⇒ 不收**（Owner 2026-10-21）────────────────
  //   病灶（实测）：那张母婴插画里「奶瓶倒着放」，而 skill 虽已加载、判定主体的回复里
  //   四类画面事实（婴幼儿姿势／产品状态／场景关系／隐私）**一条都没写** ⇒ 漏检且无人发现。
  //   判据在 visual_checklist.mjs（纯函数，四类缺一类不收；"有"必须带依据、"未测"必须带原因）。
  //   只对**带图**的单子生效；文字单、视频单**不碰**（它们另有各自的专项口径）。
  // ── ★★ P0（2026-10-21 Owner 批准）：**看到了图、一张都没解析出来 ⇒ 本单不收** ─────────
  //   为什么要它（病灶，实测）：图没被解析成图片时 `imageCount=0` ⇒ 模态被判成 `text`
  //   ⇒ `--content-type text` ⇒ **「负面样本规则」整层不跑** ⇒ 出 `PASS / 0 条`。
  //   这是 fail-open 的正面：**零条不是没问题**。宁可当场回一句「图我没取到、请重发」，
  //   也不许拿一个「没问题」把不该放的物料放出去 —— 放出去的收不回来（与库侧
  //   「没读数不许 PASS」同一条单向闸，判据各自独立：那条管「库没读到」，这条管「图没进来」）。
  let imageUnresolvedGate = false;
  if (inbound?.imageUnresolved) {
    console.log('[agent] 🖼 带图但一张都没解析出来 ⇒ 本单不许出三态结论：'
      + String(inbound?.imageIntent?.why ?? '原因未知'));
    incomplete = true;
    imageUnresolvedGate = true;
    visualGateRefusal = '这条消息里的图片未能读取，本次审查未完成，请重新发送原图。';
    inbound.imageGateReason = '图片未能读取';
  }

  // ★★ 2026-10-22（Owner 现场那一单：图 + @守衡）—— **P0 确定性命中 ⇒ 图单两道闸门不适用。**
  //   同一单实测（`om_x100b62aff6a2c22ccfd45eeca787bff`）：库侧 P0 快路 BLOCK（V02／E-2.124）
  //   与模型侧 2 条合并成 BLOCK、`p0DirectReply` 已备好；而这两道闸门去 P0 的 `answer` 里找
  //   五类视觉核对与 skill 全流程节 —— 按 PRD §6.3「命中即停止后续审查」，判定主体根本没被调，
  //   那些节**按设计就不会有** ⇒ 必然缺项 ⇒ 强制 NEEDS_INPUT + 回「证据未通过」拒答：
  //   **一个已确定的 BLOCK 被自己的闸门藏掉，群里什么三态结论都没有**（§2.4.5 接缝撞车）。
  //   边界（一个字不松）：只对 `p0_fastpath` 命中生效；P0 只出 BLOCK，
  //   不存在它把「视觉没核对」的地方放行出去的可能。
  const p0GateExempt = res?.p0_fastpath && typeof res.p0_fastpath === 'object';
  // ★★ 2026-10-22（同一形状的第四次）：**画面读数没读到 ⇒ 这一单也不出三态结论。**
  //   为什么（与 2026-10-21 那条「图没解析出来 ⇒ 不收」同一条单向闸）：
  //     ① PRD §5.1 把图片的输入写成两半（OCR ＋ 基础视觉）；画面那一半没跑成，
  //        「图片安全审查」里的**视觉分析**这一步就无从执行 —— 而它照样能写出一份
  //        格式齐全的清单（07 那单就是：五类全是「未测」）⇒ 结论看起来像"审过了"。
  //     ② 实测那一单：画面模型端点 **HTTP 402 余额不足**，我们**一眼都没看到图**，
  //        而链给了 REVIEW（依据是 OCR 文字）。**没看过画面就给画面类结论**，读起来一样。
  //   边界一个字不松：只挡图单、只挡「画面这一半没读数」；P0 命中照旧豁免
  //   （PRD §6.3 命中即停止后续审查，那张图本来就不该被看）。
  const sceneFaults = sceneFaultsOf(inbound);
  if ((inbound?.imageCount ?? 0) > 0 && chainRan && !p0GateExempt) {
    // The executor, its one report-only repair and publication call this exact
    // turn-bound checker with the same current-image evidence and source bytes.
    const checked = await checkReport(String(res?.answer ?? ''), {
      sources: [...(inbound.imageFactSources ?? []), ...kbFactSources(res?.engine, res?.review)],
    });
    res.answer = checked.answer;
    visualGate = checked.visual;
    imageWorkflowGate = checked.workflow;
    console.log('[agent] 🖼 图片逐项来源复核：' + (checked.ok ? '完成' : '未完成')
      + `｜证据指纹=${checked.workflow.semanticReview?.evidenceHash ?? '未测'}`
      + `｜补写清单=${checked.restated.checklist.length}｜补写面板=${checked.restated.panels.length}`);
    const imageGateFailures = [visualGate, imageWorkflowGate].filter((g) => g && !g.ok);
    if (imageGateFailures.length || sceneFaults.length) {
      const reason = imageGateFailures.map((g) => g.reason).filter(Boolean).join('；');
      // ★ 2026-10-26：**挂在 `inbound` 上**（不是本函数局部变量）—— 卡面是在
      //   `handleMessageInTurn`（另一个函数）里拼的，局部变量到不了那儿（实测 ReferenceError）。
      inbound.imageGateReason = [imageEvidenceReason, reason, sceneFaults.length ? `画面读数没读到：${sceneFaults.map((f) => f.why).join('；')}` : ''].filter(Boolean).join('；');
      if (imageGateFailures.length) console.log('[agent] 🖼 图片安全审查全流程未完成 ⇒ 本单不收三态结论：' + reason);
      if (sceneFaults.length) {
        console.log('[agent] 🖼 画面读数没读到 ⇒ 本单不收三态结论（画面这一半没跑成，不许给画面类结论）：'
          + sceneFaults.map((f) => `${f.index ? `图 ${f.index} ` : ''}${f.why}`).join('；'));
      }
      incomplete = true;
      // ★ 2026-10-22：**群里那句话**由纯函数生成（说清没测完≠没问题、卡点在谁身上、
      //   现在重发有没有用）。判据原话只进日志与落表，不进群。
      visualGateRefusal = [visualGateRefusal,
        imageWithholdReply({ visualGate, imageWorkflowGate, sceneFaults })]
        .filter(Boolean).join('\n');
    }
  } else if ((inbound?.imageCount ?? 0) > 0 && chainRan && p0GateExempt) {
    // ★ 跳过必须留痕：否则「P0 豁免生效了」与「这两道闸门坏了」在日志里长得一模一样。
    console.log('[agent] 🖼 P0 确定性命中 ⇒ 视觉核对 / skill 全流程 / 画面读数闸门**不适用**'
      + '（PRD §6.3 命中即停止后续审查；本单结论由 P0 给，不向被停掉的那一段要清单）');
  }

  if (incomplete && reportFailure) {
    visualGateRefusal = imageUnfinishedReply({ chainRan, chainMs, failure: reportFailure });
  }

  return { incomplete, visualGate, imageWorkflowGate, visualGateRefusal,
    imageEvidenceReason, imageUnresolvedGate, sceneFaults,
    reason: inbound?.imageGateReason ?? '' };
}

/* ─────────────────── 串行化：每个会话一把锁 ─────────────────── */
const locks = new Map();
/** 同一 sessionKey 上排队执行，保证记忆文件不会被并发覆盖 */
function withLock(key, fn) {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);                   // 前一个失败也要继续排队
  locks.set(key, next.catch(() => {}));
  return next;
}

/* ─────────────────── 兜底话术：工具循环用尽时说什么 ─────────────────── */

/**
 * 工具循环用尽、模型始终没给出最终答复时，替它说一句实话。
 *
 * ★ 硬约束：**正文里不许出现工具名**（2026-09-22 实测事故，见下）。
 *   这条约束由 `tools/verify_cards.mjs` 的 **L6** 守着 —— 它把本函数喂给
 *   `lintCopy()`，并要求**不说话术本身被自己的检测器拦下**。
 *
 * ── 为什么单独拆成函数
 *
 * 原先这句话术是**内联**在工具循环后面的一行字符串拼接，它长这样：
 *
 * ```js
 * '我查了几轮还是没能得出可靠结论，先把已知的告诉你：'
 *   + `我试过 ${toolTrace.map((t) => t.tool).join('、')}，` + '但信息不足。…'
 * ```
 *
 * 一次工具循环里 `run_readonly_command` 会连出十几次，于是正文变成
 * 「我试过 run_readonly_command、run_readonly_command、…（19 次）」——
 * 而 `internalLeak` 规则判「**连续三次同名工具**」为故障，
 * 它在 `verify_cards.mjs` F 段的**正样本正是这句话的形状**。
 *
 * 也就是说：**这句话术 100% 会被自己的检测器拦下**，`envelope.mjs` 把它降级成
 * 「我这次没能把回答组织好」的拒答。2026-09-22 16:34 实测：上游在私聊里问
 * 「你如何读取我 DSH 上的知识库」，两次都跑满 6 轮工具、两次都撞上这一条，
 * **她问了两次、被拒答两次，而盘上没有任何东西记得她欠一条回答。**
 *
 * 根因不是检测器太严（它抓得对），也不是话术不该说「我查不到」——
 * 是**内部详情被写进了正文**。工具名属于排查材料：它已经在 `toolTrace`
 * （进 `meta`、进日志）里，正文只该说人话。
 *
 * @param {Array<{tool:string, ok:boolean}>} toolTrace 本轮实际调过的工具
 * @returns {string} 面向用户的一段话，**不含任何工具名/函数名/轮次上限**
 */
export function fallbackReply(toolTrace = []) {
  const n = toolTrace.length;
  const nFail = toolTrace.filter((t) => !t.ok).length;
  return '这个问题我没答上来 —— 查了几轮，还是没能得出可靠结论。'
    + (n
        ? `\n\n（我这边翻了 ${n} 处${nFail ? `，其中 ${nFail} 处没读通` : '，都能读到，但没拼出答案'}。`
          + '明细留在我这侧，就不往这里贴了。）'
        : '\n\n（我这轮连一次有效检索都没走完。）')
    + '\n\n你把要查的范围再说细一点，我重新来。';
}

/**
 * 「已经取到东西、但一个字都没写出来」时的最后一条路。
 *
 * ★ 2026-09-30 加，起因是一次真事故（本群 19:11 / 19:16）：
 *   她问「用知识库查一下『吸奶器』相关的措辞要求」。模型调了两次 `kb_search`，
 *   工具把 60,349 字原始 JSON 倒进上下文；下一轮**推理把 8000 token 输出预算吃光**
 *   （`finish_reason=length`、正文 0 字），群里收到的是一条**只有截断说明的消息**。
 *   同一形状在 19:05 也发生过一次：工具循环跑满 → 兜底话术「这个问题我没答上来」，
 *   **而盘上答案就在手边**（工具明明都读通了）。
 *
 * 两种「烧光」都不该以「什么都没说」收场，因为**答案的材料已经取回来了**。
 * 这一跳做的事只有一件：把工具返回体折叠成结构摘要，然后**关掉工具**再问一次，
 * 要求它用手上的东西写答案。
 *
 * 为什么关掉工具：再给它工具，它会把同一批查询再跑一遍，然后**再一次**把预算烧光
 * —— 那是同一个坑的第二次。
 *
 * @param {object} opts
 * @param {string} opts.systemPrompt
 * @param {Array}  opts.messages      当轮的完整 messages（含工具结果）
 * @param {string} opts.why           'tool-iters'（循环跑满） | 'empty-length'（烧光没写出字）
 * @returns {Promise<{text:string, usage?:object, finishReason?:string, ok:boolean, error?:string}>}
 */
async function synthesizeFromTools({ systemPrompt, messages, why }) {
  const collapsed = collapseToolMessages(messages);
  const nudge = why === 'empty-length'
    ? '你上一轮的思考把额度用光了，**正文一个字都没写出来**。'
    : `你已经不能再调工具了（本轮工具调用已到上限）。`
    ;
  const finalMessages = [
    ...collapsed,
    { role: 'system', content:
        `${nudge}现在**只许写答案**：直接用上面的材料回话，不要再调任何工具，`
        + '不要再复述原始返回体。\n'
        + '五条要求：\n'
        + '1. 先给结论（一到三句），再给依据；依据要带得出处（条款号 / 文档名 / 规则码）。\n'
        + '2. 材料里没有的**不要补**；确实没查到就直说「这次没查到」，并说清查了什么。\n'
        + '3. 剪过条数或字数时（材料里有 `clip_note` / `〔已折叠〕`）要照实说明'
        + '「我只看了 N 条」，**不许**说成「库里一共只有这些」。\n'
        + '4. 中文，短句，不要复述 JSON，不要贴工具名。\n'
        + '5. 长度控制在 800 字以内。' },
  ];
  try {
    const r = await llm.chat(finalMessages, { tools: [] });
    if (!r.ok) return { ok: false, error: r.error, layer: r.layer };
    return { ok: true, text: String(r.message?.content ?? '').trim(),
             message: r.message,                       // ★ 供 P0 取 reasoning_content
             finishReason: r.finishReason, usage: r.usage };
  } catch (e) {
    return { ok: false, error: `${e?.name ?? 'Error'}: ${e?.message ?? e}` };
  }
}

/**
 * 把一条 assistant 轮写进记忆。**空的那条不许落盘**（2026-09-30 加）。
 *
 * 为什么单独包一层：`mem.append` 那道闸会静默拒收，而「静默」在这里恰好是错的 ——
 * 被拒的那一条是「模型一个字都没写出来」，这件事必须留痕，否则事后只看会话文件
 * 会以为**这一轮压根没发生过**。所以我们自己判一次、自己说一句，再交下去。
 *
 * 判据与 `memory.mjs` 的 `isPersistable` 同源（那边是执行点，这里是留痕点）。
 */
function appendAssistant(sess, msg) {
  const r = mem.append(sess, msg);
  if (!r.stored) {
    console.warn(`[agent] ⚠️ 空 assistant 轮**未写入记忆**：${r.why}`
      + `｜正文 ${String(msg?.content ?? '').length} 字｜tool_calls ${msg?.tool_calls?.length ?? 0}`);
  }
  return r;
}

/**
 * 取出这一轮该**回传**的 `reasoning_content`（2026-09-30 加，P0）。
 *
 * 为什么必须有这一跳：DeepSeek 思考模式下，**带 `tools` 的请求**要求把历史里
 * 每一轮的思维链原样回传，不回传就 400。守衡每轮都带 `tools`，所以这不是可选项。
 * 实测读数在 `PMO/logs/llm_failures.jsonl`：
 *
 *     HTTP 400 code=invalid_request_error
 *     The `reasoning_content` in the thinking mode must be passed back to the API.
 *
 * 唯一一处收口（裁剪也好、开关也好，都只在这里），所以：
 *   · 关掉 → 返回 `{}`，调用点的写法一个字都不用改；
 *   · 超限 → 裁到 `maxChars` 并在**正文之外**留一句可核对的标记，
 *     不静默截断（截了不说 = 事后没人能判断上下文里到底放了什么）。
 *
 * ⚠️ 上限不是洁癖：单轮思维链实测可达 8000 token（≈3 万字）。
 *   无界回传会把「上下文被塞爆 → 推理烧光预算」那个病再造一遍。
 *
 * @param {object} message LLM 返回的 `choices[0].message`（或我们记下的等价物）
 * @returns {{reasoning_content?: string}} 可直接展开进 assistant 轮的对象
 */
export function reasoningToPassBack(message) {
  if (!config.llm.reasoningPassback.enabled) return {};
  const r = message?.reasoning_content;
  if (typeof r !== 'string' || r.length === 0) return {};

  const cap = config.llm.reasoningPassback.maxChars;
  if (r.length <= cap) return { reasoning_content: r };

  console.warn(`[agent] · 思维链超回传预算：${r.length} 字 → 裁到 ${cap} 字`
    + `（只为控制上下文；已发出的正文不受影响）`);
  return {
    reasoning_content: r.slice(0, cap)
      + `\n…〔本轮思维链原长 ${r.length} 字，按 ${cap} 字上限裁剪后回传〕`,
  };
}

/* ─────────────────── 入向内容：文字 + 图内文字 + 视频 ─────────────────── */

/** 一次最多读几张图。是**上限**，不是「读到几张算几张」—— 超出的部分要说话。 */
export const MAX_IMAGES_PER_MESSAGE = 4;

/**
 * 一次最多读几条视频。**故意是 1**（2026-10-05 定的），理由不是省事：
 *   · PRD §12 给视频的响应预算是 **≤60s**，而一条 15 秒的视频实测要 3.5 秒
 *     （抽帧 0.2s + 8 帧 OCR 3.0s + 转写 0.8s）—— 成本随时长与条数线性涨；
 *   · 人一次发两条视频要同时审，是罕见用法；真遇到，多出来的那一条**明说没读**，
 *     让人分开再发（比默默读一半强）。
 */
export const MAX_VIDEOS_PER_MESSAGE = 1;

/** 这几类附件**不在** §2.6 那条窄豁免里 —— 但 «里面的视频» 从 2026-10-05 起在（见下）。 */
const ATTACHMENT_TYPES = new Set(['file', 'media', 'audio']);

/** Preserve only this video's sampled frames until the independent model finishes. */
function retainVideoModelFrames(result, index) {
  const retained = { modelFramePaths: [], modelFrameDir: null, modelFrameCopyError: null };
  if (!result?.ok) return retained;
  try {
    const sources = Array.isArray(result.sampleFramePaths) ? result.sampleFramePaths : [];
    if (sources.length) {
      retained.modelFrameDir = fs.mkdtempSync('/tmp/shouheng-vid-frames-');
      sources.forEach((source, frame) => {
        const dest = path.join(retained.modelFrameDir, `vid_${index}_frame_${frame + 1}.png`);
        fs.copyFileSync(source, dest);
        retained.modelFramePaths.push(dest);
      });
    }
    if (Array.isArray(result.scenePlan) && retained.modelFramePaths.length !== result.scenePlan.length) {
      throw new Error(`计划 ${result.scenePlan.length} 帧，实际交给独立模型 ${retained.modelFramePaths.length} 帧`);
    }
  } catch (error) {
    retained.modelFrameCopyError = String(error?.message ?? error);
    if (retained.modelFrameDir) {
      try { fs.rmSync(retained.modelFrameDir, { recursive: true, force: true }); } catch {}
    }
    retained.modelFramePaths = [];
    retained.modelFrameDir = null;
  }
  return retained;
}

/**
 * 把一条消息读成「文字部分 + 图内文字」。**纯读**：不发消息、不碰记忆、不调模型 ——
 * 所以它能被单测直接喂桩（`tools/test_agent.mjs` 第 13 组就是这么跑的）。
 *
 * ★ 为什么要有这个函数（而不是散在 handleMessage 里）：
 *   2026-10-05 那条「评审下下这个图片，能过吗？」被整类拒掉 —— 连**正文**都没读。
 *   根因是 `handleMessage` 里 `if (msg.message_type !== 'text') return 拒答` 这一道
 *   把所有非文本类型一刀切了，而**图文混排恰恰是 post 类型**：
 *   人最常见的发法（写一句话 + 配一张图）正好落在刀口上。
 *
 * ★ 三种「读不到」在这里必须长得不一样（§2.4.1「否定结论不许比输入大」）：
 *   · `attachment` —— 按规矩不取（file/media/audio）；
 *   · `images[i].failed` —— 这一张**取不到**（给原因）；
 *   · `images[i].ocrEmpty` —— 取到了、也跑了 OCR，但**图上没读出文字**。
 *   把后两者说成同一件事，是「把取不到说成没有」。
 *
 * @param {object} msg  im.message.receive_v1 的 `message`
 * @param {{fetchImage?:Function, ocr?:Function}} [deps] 测试注入用；生产走真实现
 */
export async function readInboundContent(msg, {
  fetchImage = feishu.fetchMessageImage,
  fetchVideo = feishu.fetchMessageVideo,
  ocr = vision.ocrImage,
  // ★★ 2026-10-15：**画面层**（PRD §5.1 的「基础视觉识别」那一半）。
  //   此前两侧吃的都是同一份 OCR 文字 ⇒ 画面没人看（详见 `scene.mjs` 头注：
  //   「模型不吃图」那句话当天被实测否掉了 —— 同一个端点 HTTP 200）。
  //   注入点在这里，与 `ocr` 同级：测试要能打桩，否则这条路只能在联网+花 token 下才测得动。
  scene = sceneMod.sceneRead,
  // ★ 2026-10-28：默认改为 readVideoSegmented（>120s 自动分段，≤120s 行为与 readVideo 完全一致）
  readVideoFn = video.readVideoSegmented,
  loadParent = feishu.getMessage,
  // ★★ 2026-10-09（Owner：「图上文字：Owner==》**还有我的名字**」）：
  //   一个**异步取数函数** `() => Promise<string|null>`，回**送审人显示名** ——
  //   水印里那个名字的确定性来源（水印逐字就是「用户名 + 工号」）。
  //   只在**真读到图、真要去水印**那一刻调一次（惰性：没带图的对话不付这次查询）。
  //   取不到（没 open_id / 查不到）⇒ 回 null ⇒ 那一条判据不生效，**不抛**。
  senderNameForWatermark = null,
} = {}) {
  const msgType = msg?.message_type ?? 'unknown';
  const content = msg?.content ?? '{}';

  // 正文走 `bodyToText`（post 的富文本 → 纯文本这条路 2026-09-22 就修好了，
  // 只是**从来没有机会被执行** —— 非 text 类型在上一步就被拒了）。
  const parsed = feishu.bodyToText(msgType, content);
  let text = parsed.text ?? '';
  // ★★ 2026-10-26（Owner：「同一张图私聊能读、群里 @守衡 读不到」）——
  //   **「解析不出内容」不等于「对方发的东西没有内容」。**
  //   事件载荷的形状比文档宽（`feishu.mjs::postBlocksOf` 头注列了三种），
  //   解析不出来的那一支原先直接回「这条是「post」，它的正文我读不了」：
  //   对一条**明明带着图**的消息说这句话，就是把自己的解析失败说成对方的格式问题，
  //   而且那句「请把它转成文字发我」让人以为缺个开关 —— §2.4.1 那个病。
  //
  //   补的这一跳：**拿同一个 message_id 再读一遍**（`getMessage`，与 parent 回读
  //   是同一条通道、同一个窄豁免：只读**人当前发给守衡的这一条**）。
  //   形状与 parent 回读**完全一样**，不开新的取字节入口、不翻群历史。
  //   ⚠️ 只在「什么都没解析出来」时跑：正常载荷**一次网络都不发**（不是给每条消息加一次调用）。
  let selfReread = null;
  // 回读拿到的媒材（空数组 = 没有/没回读）—— 由下面的 `keys`/`vidKeys` 接手
  let rereadImages = [];
  let rereadVideos = [];
  if (!text && msg?.message_id) {
    let self = null;
    try { self = await loadParent(msg.message_id); }
    catch (e) { self = { error: `回读抛异常：${e?.message ?? e}` }; }
    if (self?.error) {
      selfReread = { ok: false, error: self.error };
      console.log(`[agent] ⚠️ 本消息解析为空 ⇒ 按 message_id 回读失败：${self.error}`);
    } else {
      const selfText = self?.recalled ? '' : (self?.text ?? '');
      const selfImages = self?.images ?? [];
      const selfVideos = self?.videos ?? [];
      const ok = !!(selfText || selfImages.length || selfVideos.length);
      selfReread = { ok, msgType: self?.msgType ?? null, parseNote: self?.parseNote ?? null,
                     images: selfImages.length, videos: selfVideos.length };
      if (ok) {
        text = selfText;
        // 回读拿到的图/视频，**就在这里定型**（下面的 parent 分支因此不再触发：
        // 这一条自己有媒材，按「先看这一条、再看它引用的那一条」的既有次序）
        rereadImages = selfImages;
        rereadVideos = selfVideos;
        console.log(`[agent] ↻ 本消息解析为空 ⇒ 按 message_id 回读成功｜type=${self?.msgType ?? '?'}`
          + `｜图 ${selfImages.length} 张｜视频 ${selfVideos.length} 段｜正文 ${selfText.length} 字`);
      } else {
        console.log(`[agent] ⚠️ 本消息解析为空、按 message_id 回读也没得到内容`
          + `（type=${self?.msgType ?? '?'}｜${self?.parseNote ?? '无解析提示'}）`);
      }
    }
  }

  // ── 图 / 视频从哪来：先看这一条，再看**它引用的那一条** ──
  //
  // ★ 为什么必须有第二处（2026-10-05 补）：「发一张图 → 回它一句『这张能过吗』」
  //   和「@守衡 回复某条带图的消息」都是真实用法（实测群历史里 post+parent_id 就有）。
  //   只看当前消息的后果是：守衡回一句「你这条里没图」—— 而图就在它引用的那一条里。
  //   仍然只覆盖**被明确指到的那一条**（`parent_id`），**不翻历史**：
  //   「顺着历史把群里的图/视频捞一遍」不在豁免里，那条线没动。
  //
  // ★ 2026-10-05 同日：视频并进同一条豁免（Owner 现场确认），取法完全一样 ——
  //   所以这两路**共用同一个 parent 回读**，而不是各写一遍（各写一遍就会出现
  //   「回复一条带视频的消息，守衡说没视频」这种一半对一半错的状态）。
  let keys = feishu.imageKeysOf(msgType, content);
  let vidKeys = feishu.videoKeysOf(msgType, content);
  // ★ 2026-10-26：本消息解析为空时回读到的媒材优先（它们是**这一条**自带的）
  if (!keys.length && rereadImages.length) keys = rereadImages;
  if (!vidKeys.length && rereadVideos.length) vidKeys = rereadVideos;
  let fromParent = false;
  // ★★ 2026-10-09：**取字节要用「这串 key 属于哪条消息」的 id**。
  //   病灶（实测，Owner 连发三次视频全部失败）：图/视频的 key 从**被引用的那条**取到
  //   （`fromParent=true`），取字节却用 `msg.message_id`（**当前这条**）⇒
  //   `messageResource.get` 拿「当前 id + 父消息的 file_key」去查 ⇒ **HTTP 400**。
  //   实测日志：「视频 1 段（取自你引用的那条消息）｜读成功 0 · 失败 1｜取视频失败 …
  //   status code 400」。⇒ **「群里引用一条视频再 @守衡」这条路被这个 bug 堵死**；
  //   能读通的是**私聊直接发**（key 与 id 同源，不走 fromParent）。
  let srcMsgId = msg?.message_id ?? null;
  let parentNote = null;          // 非 null = 「那条我读不到/没图没视频」这件事本身要说出
  if (!keys.length && !vidKeys.length) {
    const pid = parentIdOf(msg);
    if (pid) {
      let parent = null;
      try { parent = await loadParent(pid); }
      catch (e) { parent = { error: `回读抛异常：${e?.message ?? e}` }; }
      if (parent?.images?.length || parent?.videos?.length) {
        keys = parent.images ?? [];
        vidKeys = parent.videos ?? [];
        fromParent = true;
        // key 来自父消息 ⇒ 取字节必须用**父消息 id**，否则 400
        srcMsgId = parent.messageId || parent.message_id || pid;
        // 被引用那条的**正文**也带上（她可能是「引用一段图文」再问的）。
        if (parent.text && !text) parentNote = { kind: 'parent_text', text: parent.text };
      } else if (parent?.error) {
        // ⚠️ 这是**未测**，不是「引用的那条里没有图」—— 两句话引出的下一步不同
        parentNote = { kind: 'parent_unreadable', error: parent.error, parentId: pid };
      } else {
        parentNote = { kind: 'parent_no_image', parentId: pid };
      }
    }
  }

  // ── ★★ P0（2026-10-21 Owner 批准）：这条消息**意图上**带没带图 ──────────────
  //   「意图带图」与「解析出几张」是**两件事**：后者为 0 而前者为真，就是下面那个 fail-open。
  //   这里只做判定，**不碰取图**（取图那一段一个字没改）。
  const imageIntent = detectImageIntent({ msgType, content, parentNote });

  const images = [];
  const todo = keys.slice(0, MAX_IMAGES_PER_MESSAGE);

  // ── ★★ 2026-10-27：多图并发读取 ────────────────────────────────────────────────
  //   原先：for 循环逐张 await，M 张图 = M × max(scene_i, ocr_i) 串行累加
  //   现在：Promise.all 所有图同时起跑，总耗时 = max over i(max(scene_i, ocr_i))
  //   调整点：
  //   · senderNameForWatermark() 提前解析一次（原先在循环体内首次命中时才调，
  //     并发后多张图可能同时调，加 lazy guard 避免重复请求）
  //   · cleanup() 每张各自放在自己的 finally 里，保证取图抛异常也能清理
  //   · images 保持原始顺序（Promise.all 按下标顺序 resolve）
  let _resolvedSenderName = undefined;  // undefined = 尚未解析；null = 解析过但取不到
  const getSenderName = async () => {
    if (_resolvedSenderName === undefined) {
      _resolvedSenderName = senderNameForWatermark ? await senderNameForWatermark() : null;
    }
    return _resolvedSenderName;
  };

  const imageResults = await Promise.all(todo.map(async (k, i) => {
    let got = null;
    try {
      got = await fetchImage(srcMsgId, k.imageKey);
    } catch (e) {
      got = { path: null, bytes: 0, error: `取图抛异常：${e?.message ?? e}`, cleanup: () => {} };
    }
    try {
      if (got?.error || !got?.path) {
        return { index: i + 1, imageKey: k.imageKey, fromParent, failed: got?.error ?? '取图没有回路径' };
      }
      // ── 画面层 + 本机 OCR + 送审人姓名（2026-10-27 改为**三路并发**）─────────────────
      //   为什么并发：
      //     · PRD §5.1 把图片的输入写成两半（OCR ＋ 基础视觉）⇒ 两条读数各自独立，互不依赖；
      //     · 原先先 `await scene(got.path)`（3.3s）再 `await ocr(got.path)`（1.2s），白等 1.2s；
      //     · 三路 `Promise.all` 让入站读图耗时等于 `max(scene, ocr)`，错误分支与原来逐字一致。
      let sceneRes = null;
      let r = null;
      let ocrThrown = null;
      const [sceneOut, ocrOut] = await Promise.all([
        Promise.resolve().then(() => scene(got.path)).catch((e) => ({
          ok: false, ms: 0, error: `画面读数抛异常：${e?.message ?? e}`,
        })),
        Promise.resolve().then(() => ocr(got.path)).then(
          (res) => ({ ok: true, res }),
          (err) => ({ ok: false, err }),
        ),
      ]);
      sceneRes = sceneOut;
      if (ocrOut.ok) r = ocrOut.res;
      else ocrThrown = ocrOut.err;

      if (sceneRes && !sceneRes.ok && !sceneRes.skipped) {
        console.log(`[agent] 🖼 画面读数**没读到**（不是「没有画面」）：图 ${i + 1}｜${sceneRes.error}`);
      } else if (sceneRes?.ok) {
        console.log(`[agent] 🖼 画面读数｜图 ${i + 1}｜${sceneMod.sceneLine(sceneRes)} · ${sceneRes.ms}ms`);
      }
      // ★ 2026-10-20（知识库侧要求）：把**图片字节的 sha256** 一并带出去。
      //   为什么：两套 OCR 引擎（守衡 base/ocr_vision vs 知识库 ocr.jxa.js）对同一张图
      //   给出的文字**不完全相同** ⇒ 逐字比对会失配。而图片字节的 sha 是同一把尺子：
      //   知识库的媒体单元里存了每张图的 sha256，两边一比就能确认「就是这张图」。
      let imgSha = null;
      try { imgSha = createHash('sha256').update(fs.readFileSync(got.path)).digest('hex'); }
      catch (e) { console.log(`[agent] ⚠️ 图 ${i + 1} 算 sha256 失败：${e?.message ?? e}`); }
      const mkImg = (extra) => ({
        index: i + 1, imageKey: k.imageKey, fromParent, bytes: got.bytes, sha256: imgSha,
        // ★ 2026-10-16：**把来源消息 id 带出去** —— 落表时要把这张图上传成链接，
        //   而那时读入阶段的临时字节早就删了（用完即删那条纪律），只能凭
        //   「消息 id + image_key」再取一次。这就是那两个键在 `inbound` 里的落点。
        msgId: srcMsgId,
        ...(sceneRes ? { scene: sceneRes } : {}), ...extra,
      });
      // OCR 自己抛也要接住：本模块的契约是「**任何一张图读不到都不该让整条回话失败**」，
      // 而这一条是写测试时才发现的 —— 第一版的 throw 会穿过 finally 冒到 handleMessage 外面，
      // 后果是对方发图那一条消息**连正文都收不到回答**（正好复现我们要修的那个病）。
      if (ocrThrown) {
        return mkImg({ failed: `OCR 抛异常：${ocrThrown?.message ?? ocrThrown}` });
      }
      if (!r?.ok) {
        // 「这一张我读不到」—— 与下面的「图上没字」分开记。
        return mkImg({ failed: `OCR 失败（${r?.error ?? '未知'}）${r?.detail ? '：' + r.detail : ''}`,
                       placeholder: !!r?.placeholder });
      } else if (!r.text || !r.text.trim()) {
        return mkImg({ ocrEmpty: true, w: r.w ?? null, h: r.h ?? null });
      } else {
        // ★★ 2026-10-09（Owner 亲自看出「图上文字里的『Owner』是水印」）──────────────
        //   图内 OCR 里混着**文档水印**（用户名 + 工号，实测 `5615 RO0 / Owner / 刘华問`），
        //   它被当成素材内容进了检索 —— 该摘。
        //   ⚠️ **但事后实测证明：它不是那批假命中的根**（我一开始这么写过，已更正）——
        //      那 5 条无关记录与素材**只共用了 `in / or / 5 / 15` 与品牌名 `momcozy`**，
        //      水印 token（`Owner` 等）在那 5 条里**一次都没出现**。真因是**门限口径**：
        //      `l6/retriever.py::search_lang` 逐词累加分数、**不按查询长度归一**，
        //      而门限是固定数 ⇒ 长素材下「同长度纯噪声」（实测 49.17）都能过 16.0。
        //      详见 2026-10-09 的实测记录；**改门限是另一件事，未做**。
        //   ⇒ 这里做一次**水印摘除**，且**两份都留着**：
        //     · `text`    = **摘掉水印后** —— 这是**唯一的对外文本**（卡片 / 送进模型 /
        //                   模型侧读数 / 库侧检索 / 落表 / 报告附录 六处都取它）。
        //       ★★ 2026-10-09 晚**收口**（理由见下）：原先 `text` 是原文、另设一个 `wlText`，
        //          三处产者各挑各的 ⇒ 一天之内**连栽两次**：
        //            ① 卡片印原文 ⇒ Owner 看到自己的名字；
        //            ② 模型侧读数（`model_side.mjs`）印原文 ⇒ 模型把水印当"素材里的中文人名"
        //               写进整改建议，等于让被审方去改一个根本不存在的元素。
        //          存两份、让每个读者自己挑 ⇒ 迟早再漏一处。现在**默认就是干净的那份**，
        //          要原文的（只有诊断与留痕）必须**显式**去取 `textRaw`。
        //     · `textRaw` = **OCR 原文**（留痕；核对"OCR 到底读到了什么"用它，一个字不改）；
        //     · `wm*`     = 留痕（摘了哪些行、靠哪条判据）—— 缺了它，摘除就是不可核的。
        const senderName = await getSenderName();
        const wm = stripOcrWatermark({ text: r.text, boxes: r.boxes, senderName });
        const calibrated = vision.calibrateOcrText(wm.text, sceneRes?.scene?.clean_text ?? []);
        // ★★ 2026-10-16：**逐行读数（含置信度）一起带出去** —— 汉字声称闸（`ocr_claim_gate.mjs`）
        //   判的就是「这条声称有没有读数撑得住」。摘掉的水印行**不进证据**
        //   （水印是文档产生的，不是素材上的字；拿它去"确认"等于用噪声证噪声）。
        const keptBoxes = Array.isArray(r.boxes)
          ? r.boxes.filter((b) => !(wm.dropped ?? []).includes(String(b?.t ?? '')))
          : null;
        const img = mkImg({ text: wm.text, textRaw: r.text, textCalibrated: calibrated.text,
                      ocrCalibrations: calibrated.replacements,
                      lines: r.lines ?? null, chars: r.chars ?? null,
                      boxes: keptBoxes,
                      w: r.w ?? null, h: r.h ?? null, truncated: !!r.truncated,
                      // `wlText` 保留为**同一份**（老读者还有人在用；值恒等，不再各挑各的）
                      wlText: wm.text, wmDropped: wm.dropped, wmBasis: wm.basis });
        if (wm.dropped.length) {
          console.log(`[agent] 🚫 图 ${i + 1} 摘除水印 ${wm.dropped.length} 行`
            + `（判据=${wm.basis}）：${wm.dropped.slice(0, 8).join(' / ')}`
            + `${wm.dropped.length > 8 ? ' …' : ''}`);
        }
        return img;
      }
    } finally {
      // 字节用完就删 —— 豁免的形状是「过一遍 OCR」，**不是「留下来」**。
      // 放在 finally 里：OCR 抛了也要删（否则一次故障就留下一堆临时图）。
      try { got?.cleanup?.(); } catch { /* 删不掉不该让这次回话失败 */ }
    }
  }));
  images.push(...imageResults);

  const skipped = keys.length - todo.length;

  // ── 视频：取字节 → 抽帧 OCR + 本机转写（同一条窄豁免，同一个 parent 回读）──
  const videos = [];
  const vTodo = vidKeys.slice(0, MAX_VIDEOS_PER_MESSAGE);
  for (let i = 0; i < vTodo.length; i++) {
    const v = vTodo[i];
    let got = null;
    // 后缀用**原名里的后缀**（只留字母数字），好让临时文件一眼看得出是什么；
    // 解不开的容器由 `readVideo` 如实报，不靠后缀判断。
    const ext = (String(v.fileName ?? '').match(/\.[A-Za-z0-9]{2,5}$/) ?? ['.mp4'])[0].toLowerCase();
    try {
      got = await fetchVideo(srcMsgId, v.fileKey, { ext });
    } catch (e) {
      got = { path: null, bytes: 0, error: `取视频抛异常：${e?.message ?? e}`, cleanup: () => {} };
    }
    try {
      if (got?.error || !got?.path) {
        videos.push({ index: i + 1, fileKey: v.fileKey, fileName: v.fileName, fromParent,
                      bytes: got?.bytes ?? 0, failed: got?.error ?? '取视频没有回路径' });
        continue;
      }
      let r;
      try {
        // ★ 2026-10-16：把本函数注入的 `scene` **一路传下去** —— 视频的「关键帧画面读数」
        //   与图片的走**同一个**注入点（测试只要换一个桩，两条路一起被控住）。
        r = await readVideoFn(got.path, { scene });   // ← 抽帧 + OCR + 转写 + 画面层，全在这一个调用里
      } catch (e) {
        videos.push({ index: i + 1, fileKey: v.fileKey, fileName: v.fileName, fromParent,
                      bytes: got.bytes, failed: `读视频抛异常：${e?.message ?? e}` });
        continue;
      }
      // 将本轮视觉采样计划的原帧复制到独立临时目录供模型直接看图，再清理抽帧目录。
      const retainedFrames = retainVideoModelFrames(r, i + 1);
      try { r?.cleanup?.(); } catch { /* 删不掉不该让这次回话失败 */ }
      if (!r?.ok) {
        videos.push({ index: i + 1, fileKey: v.fileKey, fileName: v.fileName, fromParent,
                      bytes: got.bytes,
                      failed: `读视频失败（${r?.error ?? '未知'}）${r?.detail ? '：' + r.detail : ''}` });
        continue;
      }
      videos.push({
        index: i + 1, fileKey: v.fileKey, fileName: v.fileName, fromParent, bytes: got.bytes,
        // ★ 2026-10-16：与图片同一个理由（落表时凭「消息 id + file_key」再取一次来做成链接）
        msgId: srcMsgId,
        meta: r.meta, frames: r.frames, framesRead: r.framesRead, framesFailed: r.framesFailed,
        ocrText: r.ocrText, ocrChars: r.ocrChars, ocrTruncated: r.ocrTruncated,
        // ★ 2026-10-16：关键帧的画面读数 —— **必须原样带出去**（这一行漏了，
        //   画面层就只在 `readVideo` 里跑一趟、结果谁也用不上：§2.4 那句
        //   「算出来了但没人读」的形状。执行点：test_agent 的「画面层·视频」一组。）
        frameScene: r.frameScene ?? [], sceneSkipReason: r.sceneSkipReason ?? null,
        scenePlan: r.scenePlan ?? null, ...retainedFrames,
        transcript: r.transcript, notes: r.notes ?? [], ms: r.ms,
        // ★ 2026-10-28：分段信息（>120s 视频才有；调用方可据此告知未覆盖时间段）
        ...(r.segmented ? { segments: r.segments, nSegs: r.nSegs, segmented: true } : {}),
      });
    } finally {
      // 视频字节本身也删（与图片那条同一个 finally 形状）。
      try { got?.cleanup?.(); } catch { /* 同上 */ }
    }
  }
  const skippedVideos = vidKeys.length - vTodo.length;

  return {
    msgType,
    /** ★ 2026-10-21（P0）：这条消息**意图上**带没带图（`{hasIntent, why}`）—— 与「解析出几张」分开 */
    imageIntent,
    /** ★ 2026-10-21（P0）：有图意图 + 解析出 0 张 ⇒ true（出结论时必须压成 NEEDS_INPUT） */
    imageUnresolved: imageIntentVerdict({
      imageIntent, imageCount: keys.length, videoCount: vidKeys.length,
    }).needInput,
    text,
    // ★ 2026-10-26：回读成功时「解析出来了」这件事要如实记成 true ——
    //   否则上层仍把它当「读不出来」，回读就白做了。
    parsed: parsed.parsed || !!(selfReread?.ok),
    parseNote: parsed.note ?? null,
    /** 本消息解析为空时那次「按 message_id 回读」的读数（null = 没触发） */
    selfReread,
    /** 消息里一共有几张图（含没读的）—— 含「从被引用那条消息里取的」 */
    imageCount: keys.length,
    /** 图/视频是从**被引用的那条消息**里取的吗（当前这条两样都没有） */
    fromParent,
    /** 被引用那条的读数：「没有 / 没正文 / 读不到（未测）」三者必须分得开 */
    parentNote,
    images,
    skippedImages: skipped > 0 ? skipped : 0,
    /** 消息里一共有几段视频（含没读的） */
    videoCount: vidKeys.length,
    videos,
    skippedVideos: skippedVideos > 0 ? skippedVideos : 0,
    // ★ 附件类型（不在豁免里）；不是附件则 null。
    //   `file` / `media` **只在它们不是视频时**才算「附件」——
    //   「名字是视频的 file」从 2026-10-05 起在豁免里，把它算成附件会让人听到
    //   「视频我不取」，而那条路已经通了（这正是这次要修的那句话）。
    attachment: (ATTACHMENT_TYPES.has(msgType) && !vidKeys.length) ? msgType : null,
  };
}

/**
 * ★ 「带了媒材就要起链」这条规矩的**唯一出处**（2026-10-05 加，Owner 现场确认）。
 *
 * 起因是一次真实事故：有人私聊发了一条视频、**一个字都没写**，守衡把读数描述了一遍就收工了 ——
 * `PMO/logs/ws_daemon.log:2498` 那一轮**一次工具都没调**（回复行前面没有 `🔧 工具:` 那一行），
 * 她要的结论一个字没有。诊断出来是两个缺口叠在一起：
 *   ① 人设那条路由规则是按**问句**写的（「能不能发 / 审一下」），一条光秃秃的媒体消息不匹配；
 *   ② 图块/视频块的头注全在讲「你能判什么、不能判什么」，**一个字没提该走哪条路**。
 *
 * 所以这句话同时挂在图块、视频块，以及人设的「走哪条路」那一节 —— 三处同一句话，
 * 判据在 `tools/test_agent.mjs` 第 16 组（两个块里必须都有它）与第 10 组（人设里必须有它）。
 */
export const MEDIA_ROUTE_HINT =
  '【★ 这是**送审素材**：不管对方写没写「审一下」，都要走 kb_review_chain，'
  + '把上面这段读数当输入交进去 —— 只回一段「我读到了什么」不算回答。'
  + '连「这里没有可判内容」这种结论也必须由链给出，不由你替它下。】';

/**
 * 把入向内容拼成**给模型看的那一段**。
 *
 * ★ 图块的头注不是客套话，它承担三件事，缺一件都会让模型说出比依据大的话：
 *   1. 说清这是 **OCR 读数**，可能有识别错误（不许当成逐字原文去引用）；
 *   2. 说清**画面本身看不见** —— 构图、场景、人物、婴幼儿在做什么、产品怎么用的，
 *      都不在这段文字里。模型必须把这条边界转述出去，否则「这个图能过吗」
 *      会被答成一个它其实没看过画面的结论；
 *   3. 说清图的**来源**（就是对方这条消息里附的），避免和图上印着的文字混淆。
 */
export function buildImageBlock(inbound) {
  if (!inbound?.imageCount) return '';
  // 来源必须说准：是她**这条**带的图，还是她**引用的那条**里的图 ——
  // 说错了，模型会把「她引用的那条里的字」当成「她这条里写的字」去答。
  const src = inbound.fromParent
    ? '对方**这条消息没带图**；下面是**它引用的那条消息**里附的图'
    : '对方这条消息里附了图';
  const quoted = inbound.fromParent && inbound.parentNote?.kind === 'parent_text' && inbound.parentNote.text
    ? `\n（她引用的那条消息，正文逐字是：${String(inbound.parentNote.text).slice(0, 500)}）`
    : '';
  const imageRows = Array.isArray(inbound.images) ? inbound.images : [];
  const hasScene = imageRows.some((i) => i?.scene?.ok);
  const parts = [
    `【${src}，共 ${inbound.imageCount} 张。下面每一格是**两条读数**：`
    + `① **本机 OCR 读出的图内文字**（逐字，可能有识别错误；也可能读不全）；`
    + `② **画面读数**（一个吃图的视觉模型看那张图写下的、只陈述看得见的：`
    + `场景 / 人物（含是否婴幼儿）/ 物品是否在用 / 可见商标 / 画面线索）。`
    + (hasScene
      // ★★ 2026-10-15：这一条是**改口径**，不是改措辞 —— 此前写的是「画面本身你看不到」，
      //   因为那时**画面层根本不存在**。现在读数在手，再说"看不到"就是**把有说成没有**；
      //   但也不能放开成"你看过这张图"（那是模型读数，不是原图）。
      ? `②是**模型给的读数，不是原图**：涉及画面的结论**只能依据它**，`
        + `并写明「画面结论依据的是这份读数」；**读数里没写的（月龄、声音、这张图之外的情节）不许推断**；`
        + `②**没读到**时如实说「画面这一层未测」，**不许**说成「画面没问题」。`
      : `②**这一单没有**（画面层没跑或没读到）：涉及画面的结论**不许推断**，`
        + `必须写明「画面我看不到、要看画面得由人来看」。`)
    + `所以：可以按这两条读数做文案、宣称、产品使用、人物行为与场景层面的判定，`
    + `但凡读数没覆盖的部分，都要把边界写出来。${quoted}】`,
  ];
  for (const im of imageRows) {
    // ★ 2026-10-20：**图片指纹行**（放在最前）。知识库侧用它确认「就是这张图」——
    //   OCR 两套引擎文字会不同，sha 不会。
    if (im.sha256) parts.push(`【图 ${im.index} 指纹 sha256=${im.sha256}】`);
    if (im.failed) {
      parts.push(`【图 ${im.index}】**这一张我读不到**：${im.failed}`
        + (im.placeholder ? '（OCR 自己报的尺寸是 1×1 像素级 —— 这类多是占位图/懒加载图，不是「读不出来」）' : '')
        + ` —— 不要猜它的内容。`);
    } else if (im.ocrEmpty) {
      parts.push(`【图 ${im.index}】这一张取到了（${im.bytes} 字节，${im.w ?? '?'}×${im.h ?? '?'} 像素），`
        + `但**没识别出任何文字** —— 这是「图上没有可读的文字」，不是「读不出来」。`);
    } else {
      // ★★ 2026-10-09（Owner 第二次来问「我重测了，水印还在」）：
      //   这一格原先印 `im.text`（**OCR 原文、含水印**）。而同一件事的另一个产者
      //   `describeMediaRead`（卡片那一格）已改印 `wlText` ⇒ **同一段文字两个口径**：
      //   卡片干净、**喂给模型的这段还带着水印** ⇒ 模型与报告那一侧继续拿水印当素材。
      //   ⇒ 现在**统一**：送进模型的也是摘掉水印那份（`wlText`），与喂给链的检索文本同源。
      //   原文一个字没丢（仍在 `im.text`），核对时看日志的摘除明细那一行。
      //   ⚠️ 行数仍报**读到几行**（`im.lines`，是真读数）；另摘几行**明写**，
      //     否则模型会怀疑"显示的行数对不上正文"，或反过来把摘掉的当成没读到。
      const body = String(im.wlText ?? im.text);
      const dropped = im.wmDropped?.length ?? 0;
      parts.push(`【图 ${im.index} 内文字${im.truncated ? '（已截断）' : ''}｜${im.lines ?? '?'} 行`
        + `${dropped ? `，另摘除水印 ${dropped} 行（不是素材内容）` : ''}】\n`
        + `${body}\n【/图 ${im.index}】`);
    }
    // ── ★★ 2026-10-15：**画面读数**（PRD §5.1「基础视觉识别」那一半）───────────
    //   为什么单独一格、且**不放进上面那个 if/else**：两条读数**各自独立** ——
    //   OCR 失败或"图上没字"的图，画面读数照样可能读到东西。
    //   实测那次（2026-10-15 对接人那张图）正是这种：OCR 只有品牌字样 `momcozY`，
    //   而画面读数给出了「婴幼儿出镜 / 产品正在被冲洗 / 疑似合成痕迹」——
    //   把它挂在 OCR 的分支里，就会在**最需要它的那一类图上**正好丢掉。
    if (im.scene?.ok) {
      parts.push(`【图 ${im.index} 画面读数（视觉模型的读数，**不是原图**；涉及画面的结论只能依据这一格）】\n`
        + `${sceneMod.sceneBlock(im.scene.scene)}\n【/图 ${im.index} 画面读数】`);
    } else if (im.scene?.skipped) {
      // 「这一单没跑」——**不是**失败、也不是「没有画面」：如实说没跑，别让它看起来像读过
      parts.push(`【图 ${im.index} 画面读数：这一单**没跑**（${im.scene.error ?? '未开'}）】`);
    } else if (im.scene && im.scene.error) {
      parts.push(`【图 ${im.index} 画面读数：**没读到**（${im.scene.error}）—— `
        + `画面这一层是**未测**，不是「没有画面」，也不许据此推断画面】`);
    }
  }
  if (inbound.skippedImages) {
    parts.push(`【还有 ${inbound.skippedImages} 张图**没有读**：一次最多读 ${MAX_IMAGES_PER_MESSAGE} 张。`
      + `需要的话让对方把剩下的单独再发一次。】`);
  }
  parts.push(MEDIA_ROUTE_HINT);
  return parts.join('\n');
}

/**
 * 把入向内容里的**视频**拼成给模型看的那一段。
 *
 * ★ 视频块的头注比图片块更要紧，因为「看视频」这句话最容易说大：
 *   本模块能做到的是 —— **按时长均匀抽 N 帧**（默认 8 帧）→ 读这 N 帧画面上的字；
 *   **把整条音轨**做本机转写（口播/旁白）。做不到的是 —— 逐帧看完整条片子、
 *   看构图/动作/婴幼儿姿势、听语气、看剪辑节奏。
 *   所以「我看了这条视频」是**假话**，必须让模型说的是「我读到了这 8 帧上的字 + 整条音轨的转写」。
 *   这一条是 PRD §11 那条「PASS 误放率」的地基：把抽样说成全量，误放就从这里开始。
 *
 * ★ 三种「声音那侧没有结果」也在这里分开说，不许糊成一句「听不清」：
 *   · 没有音轨 —— 读数（静音片子是合法素材）；
 *   · 有音轨但没人说话 —— 读数（实测产品 hero 片就是这样）；
 *   · 转写没跑成（未授权 / 超时 / 模型没装）—— **未测**，要人看一眼。
 */
export function buildVideoBlock(inbound) {
  if (!inbound?.videoCount) return '';
  const src = inbound.fromParent
    ? '对方**这条消息没带视频**；下面是**它引用的那条消息**里附的视频'
    : '对方这条消息里附了视频';
  const quoted = inbound.fromParent && inbound.parentNote?.kind === 'parent_text' && inbound.parentNote.text
    ? `\n（她引用的那条消息，正文逐字是：${String(inbound.parentNote.text).slice(0, 500)}）`
    : '';
  const parts = [
    `【${src}，共 ${inbound.videoCount} 段。下面每一格是**读数**：`
    + `「关键帧上的文字」是按时长**均匀抽 ${video.VIDEO_MAX_FRAMES} 帧**做的 OCR；`
    + `「音轨转写」是**整条音轨**在本机做的语音识别（requiresOnDeviceRecognition，音频不出机器）`
    // ★ 2026-10-16：**没有画面读数时不许介绍它** —— 块头把一种"读数种类"写出来，
    //   读的人（模型）就会以为这一格该有它。这是同一件事的第二个产者：
    //   实测自证里红过一次（「没跑时不许凭空造一节」那条判据抓到的正是这一行）。
    + ((inbound.videos ?? []).some((v) => (v.frameScene ?? []).some((s) => s?.ok))
      ? `；「关键帧的画面读数」是一个吃图的视觉模型看**其中几帧**写下的（只陈述看得见的）。`
        + `你能据此判断的是：**画面上出现过的字**、**整条音轨里说过的话**、`
        + `以及**被看过的那几帧的画面**（场景 / 人物含是否婴幼儿 / 物品是否在用 / 画面线索）。`
      : `。你能据此判断的是：**画面上出现过的字**与**整条音轨里说过的话**。`)
    + ((inbound.videos ?? []).some((v) => (v.frameScene ?? []).some((s) => s?.ok))
      ? `画面结论**只能依据那几帧的画面读数**，并写明它覆盖了哪些时间码；`
        + `**没覆盖的帧、没抽到的帧、更细的构图**仍然是看不到的 —— 不许推断，`
        + `也不许说成「整条视频的画面我都看了」。`
      : `你**看不到**的是：没抽到的那几帧、构图、场景、人物在做什么、婴幼儿的姿势、`
        + `产品怎么用的、有没有换脸/合成痕迹。所以涉及**画面本身**的结论必须写明`
        + `「画面我只看得到抽样的这几帧」，不许说成「整条视频我都看了」。`)
    + `${quoted}】`,
  ];
  for (const v of inbound.videos) {
    if (v.failed) {
      parts.push(`【视频 ${v.index}】**这一段我读不到**：${v.failed} —— 不要猜它的内容。`
        + `（对方发的是「${v.fileName ?? '未给文件名'}」）`);
      continue;
    }
    const m = v.meta ?? {};
    const head = `【视频 ${v.index}｜${v.fileName ?? '未给文件名'}｜`
      + `${m.duration_s != null ? Number(m.duration_s).toFixed(1) + 's' : '时长未知'}`
      + `${m.w && m.h ? `｜${m.w}×${m.h}` : ''}`
      + `${m.fps ? `｜${Number(m.fps).toFixed(0)}fps` : ''}`
      + `｜关键帧 ${v.framesRead}/${v.frames?.length ?? 0} 帧读成功】`;

    // ── 画面上的字 ──
    // ④ 与卡片/库侧**共用同一个 `frameLine`**（原先这里自己拼过一份，与 video.mjs 那份是
    //    两份实现 —— 改一处忘一处就会漂移，这正是本轮栽的形状）。输出**逐字不变**。
    const frameLines = (v.frames ?? []).map((f) => video.frameLine(f)).filter(Boolean);
    const ocrPart = frameLines.length
      ? `关键帧上的文字（按时间码${v.ocrTruncated ? '，已截断' : ''}）：\n${frameLines.join('\n')}`
      : `关键帧上的文字：**这 ${v.frames?.length ?? 0} 帧里没读出一个字**`
        + `（这是「画面上没有可读文字」，不是「读不出来」—— 除非上面写了某帧 OCR 失败）`;

    // ── 声音 ──
    const t = v.transcript ?? {};
    let audioPart;
    if (t.ok && t.suspect) {
      // ★ 2026-10-08 新增的一格：**结果回来了，但字与被试的语种都不符**。
      //   病灶：英文音轨被按 zh-CN 识别（默认语序中文优先 + 第一个 ok 就 return），
      //   拿到一段胡话却带 `ok:true` ⇒ 原来这里会把它印成「逐字转写」，
      //   于是守衡拿胡话当口播去引用。实测对照见 `asr.mjs::checkScript()` 头注。
      //   ⇒ 这里必须说得比「可能有错」重：它不是「识别不准」，是「这段字大概不是她说的话」。
      audioPart = `音轨转写：**这一格不可信** —— ${t.hint ?? '转写文本与被试语种不符'}\n`
        + `  试过的语种：${(t.tried ?? []).join(' → ')}｜采用的文本（语种标记 ${t.locale}，`
        + `${t.chars} 字）：\n「${t.text}」\n`
        + `  ⇒ 不得把上面这段当逐字口播引用；要谈口播，只能说「这一格**没测准**」，`
        + `并请对方把音轨里的原话贴过来。`;
    } else if (t.ok) {
      // ★ 2026-10-14：长视频的转写是**分段**做的（`asr.mjs` 的 `ASR_CHUNK_SECONDS`——
      //   识别器一次只肯啃 ~2 分钟，整条 57 分钟塞进去一个字都回不来）。
      //   段内逐字、段间按时间顺序相接 ⇒ 「逐字」这个说法仍然成立，
      //   但**必须说出来**：人要知道这行字是 12 段拼的，才好在回听时按 `chunks[].start_s` 对时间。
      audioPart = t.chars
        ? `音轨转写（本机识别，逐字，可能有错；语种 ${t.locale}`
          + `${t.locale_basis ? `，选它的依据：${t.locale_basis}` : ''}`
          + `${t.chunked ? `；**分 ${t.n_chunks} 段转写**，每段 ≤${t.chunk_seconds}s、段间按时间顺序相接`
              + `${t.chunk_fails ? `，其中 ${t.chunk_fails} 段没转成` : ''}` : ''}）：\n「${t.text}」`
        : `音轨转写：识别器回了一个**空结果**（chars=0）—— 这是「整条音轨里没识别出话」，`
          + `不是「转写没跑成」。`;
    } else if (t.kind === 'no_audio_track') {
      audioPart = '音轨：**这条视频没有音轨**（静音片子）—— 是读数，不是转写失败。';
    } else if (t.kind === 'no_speech') {
      audioPart = '音轨转写：**这段音频里没有人说话**（识别器的原话是 No speech detected）——'
        + ' 是读数，不是读不到。多半是纯音乐/音效片。';
    } else {
      audioPart = `音轨转写：**没跑成**（${t.kind ?? '未知'}）`
        + `${t.hint ? ` —— ${t.hint}` : ''}`
        + `。这一格是**未测**：声音里说了什么**我不知道**，不要当成「没有说话」。`;
    }

    // ── ★★ 2026-10-16：**关键帧的画面读数**（PRD §5.1 对视频写的「画面关键帧」）──
    //   三种结局必须长得不一样：**看过的**（带时间码）／**没读到的**（未测）／**这一单没跑**
    //   （`SHOUHENG_SCENE_FRAMES=0` 或没抽到帧）。压成一句「画面我看不到」会把前两种抹平。
    const fs2 = v.frameScene ?? [];
    // 三种结局各由**产者**报出来：看过的（读数字段）／没跑（`sceneSkipReason`）／
    // 没读到的（每个元素自己的 `error`）。**没有那两种标记时一个字都不印** ——
    // 老数据/未知形状不许被猜成「没跑」，也不许被猜成「没读到」。
    const scenePart = fs2.length
      ? `关键帧的画面读数（视觉模型的读数，**不是原图**；只覆盖下面列出的时间码）：\n`
        + fs2.map((s) => (s.ok
          ? `- [${Number(s.t_s ?? 0).toFixed(1)}s] ${sceneMod.sceneLine(s)}`
          : `- [${Number(s.t_s ?? 0).toFixed(1)}s] **没读到**（${s.error ?? '未知'}）—— 这一帧画面是**未测**`))
          .join('\n')
      : (v.sceneSkipReason ? `关键帧的画面读数：这一单**没跑**（${v.sceneSkipReason}）` : '');

    parts.push([head, ocrPart, scenePart, audioPart].filter(Boolean).join('\n')
      + (v.notes?.length ? `\n附注：${v.notes.join('；')}` : '')
      + `\n【/视频 ${v.index}】`);
  }
  if (inbound.skippedVideos) {
    parts.push(`【还有 ${inbound.skippedVideos} 段视频**没有读**：一次最多读 ${MAX_VIDEOS_PER_MESSAGE} 段`
      + `（视频要抽帧 + 整条转写，成本随时长涨）。需要的话让对方把剩下的单独再发一次。】`);
  }
  parts.push(MEDIA_ROUTE_HINT);
  return parts.join('\n');
}

/**
 * 默认的跑链方式：把 `kb_review_chain` 跑一次，并**拆掉 `executeTool` 的那层信封**。
 *
 * ★ 为什么单独写一个具名函数（而不是内联一行）：这一层**信封**是实测踩出来的坑 ——
 *   `executeTool()` 回的是 `{tool, ok, result}`，**不是**链自己的返回。
 *   第一版写的是 `(args) => executeTool('kb_review_chain', args)`，于是闸门拿到的是那个信封：
 *   `res.error` 是 undefined、`res.answer` 也是 undefined，
 *   结果**每一次送审都会被写成「链跑完了但没返回结论 —— 结论未知」** ——
 *   链明明跑成了、飞书也写了，而回给群里的是「未知」。一个安静地把成功说成未知的形状。
 *   所以这里拆信封，并且 `review_gate.formatChainBlock()` **两种形状都认**
 *   （判据在 `tools/test_agent.mjs` 第 18 组，两种形状各喂一次）。
 */
export async function defaultChainRunner(args) {
  const r = await executeTool('kb_review_chain', args);
  if (r?.ok === false) return { error: r.error ?? '工具调用失败（没给出原因）' };
  return r?.result ?? { error: '工具回了空结果' };
}

/**
 * **送审闸门**：内核自己判「这条是不是送审」，是就**自己把链跑完**，再把结论交回给模型。
 *
 * ── 为什么要由内核做，而不是写进人设
 *
 * 委托方 2026-10-05 第三次重申「工作流必须走：@守衡 提问/图片/视频/链接 → L4→L5→L6→L7 +
 * 评审链 → 出报告溯源（L0）→ 写飞书」。而那条链本身一直是通的（实测跑过 691s / 771s / 1809s）。
 * 缺的从来不是能力，是**触发**：在此之前「算不算送审」只写在人设里，而**人设是声明，不是约束** ——
 * 09:22 那条视频，模型没想起来要调链，读到了 51 个字却给不出结论，
 * 而盘上**唯一的痕迹是一行没有出现的日志**（`PMO/logs/ws_daemon.log:2498`）。
 * `AGENTS.md` §2.4：指不出哪一行在拦它，就等于没拦。**拦它的就是这一个函数。**
 *
 * ── 三条边界（每条都有代价）
 *
 *   ① **判据是纯函数**（`review_gate.isSubmission`），离线可反向对照：
 *      喂「在吗」不许触发、喂一条光秃秃的媒材必须触发。
 *   ② **补发重放不重跑**（`force`）：链会真写飞书，重跑等于同一单写两遍。
 *   ③ **结论排在那一轮的最前面**（`buildUserTurn` 的 `chainBlock`）：排在读数后面会被盖住，
 *      模型就又开始「描述我读到了什么」了 —— 那正是这次要修的病。
 *
 * @returns {Promise<{question:string, gate:object|null, chainBlock:string,
 *                    chainRan:boolean, chainMs:number}>}
 */
export async function runSubmissionGate({
  inbound, question = '', notify = null,
  publicationContext = {},
  // ★★ 2026-10-16（Owner 裁定）：「**送审问题**」这一格**只留对方原文** ＋ 媒材链接。
  //
  //   为什么非要单独传一个 `userText`：`question` 是**拼给模型看的那一轮** ——
  //   `buildUserTurn` 把对方的话、我们的探针（`【对方这条消息里附了图…】`）、OCR 全文
  //   拼成了一个字符串。落表时直接写 `question` ⇒ **我们自己的内部指令进了表**
  //   （实测 200 行里 54 行如此，见 `media_link.mjs` 头注）。
  //   `userText` 是**剥掉 mention 之后、加任何块之前**的那句话，两件事本来就分得开。
  //   ⚠️ 不传（`undefined`）时退回 `question` —— 而 `stripInternal` 仍会把探针块切掉，
  //     所以「调用方忘了传」不会立刻把指令漏进表（只是少了对方原话的精确切分）。
  userText = undefined,
  // ★ 媒材链接这一步**必须可注入**：它默认会真往云空间上传（§2.4.4 那个形状 ——
  //   自证有副作用）。不注入的话，任何一条「带媒材 + 链跑成」的自证用例都会
  //   真上传一个文件到 Owner 的云空间里，而且会真的发出一个组织内可读的链接。
  mediaLinksRunner = mediaLink.collectMediaLinks,
  mediaUpload = mediaLink.uploadForLink,
  fetchImageForLink = feishu.fetchMessageImage,
  fetchVideoForLink = feishu.fetchMessageVideo,
  // ★ 目标 19（2026-10-10）：消息到达时刻（ms epoch）。PRD §12「飞书群 @Agent 响应时间 ≤5 秒」
  //   量的就是 **tIngress → 回执卡发送完成** 这一段。null ⇒ 不打这条指标（不编数）。
  //   ★★ 2026-10-20（Owner 批准 ②）：**这个值必须来自"消息到达"**，不许再缺省成
  //   「进闸门那一刻」—— 后者已经在读图之后，会把这条指标量成恒过（实测 1.4s/0.383s，
  //   而同期飞书侧真值是 60/120/180 秒）。由 `ws_daemon.onMessage` 的 `ingressMsOf()` 打。
  tIngress = null,
  // 这个时刻是**谁给的**：`create_time`（飞书服务端）｜`local`（本机此刻）｜空（缺省兜底）。
  // 写进指标行，避免把两个来源的数混着说。
  tIngressOrigin = null,
  // ★★ 2026-10-20（Owner 批准 ①）：回执**已经发过**的时刻（ms）。非空 ⇒ 这里不再发第二张。
  // 见下面回执块的头注。
  ackSentAt = null,
  // ★★ 2026-10-21（Owner）：「P0 红线问题必须 10 秒内回」「一条消息只回一条结论」。
  //   `true` = 内核在**发回执之前**已经做过一次只读 P0 预判且**命中**（见 `p0Precheck`）⇒
  //     ① 这里**不发**「⏳ 处理中」回执（结论几秒后自己会到，一张卡就够）；
  //     ② 模型侧双轨**不起跑**（PRD §6.3「命中即停止后续审查」，实测省 p50 11.8 s）；
  //     ③ 建议生成那一次 LLM **不跑**（实测省 p50 5.4 s，建议回落库侧原文）。
  //   ⚠️ 它只影响这三件**副作用与耗时**，不影响任何判定：结论仍由链（`kb_review_chain`）跑，
  //     实判以 `res.p0_fastpath` 为准；两者不一致时日志会照实说（口径不一致必须看得见）。
  p0PreHit = false,
  chainRunner = defaultChainRunner,
  // ★ 模型侧那一遍**必须可注入**（2026-10-06）：它默认会真调 LLM。
  //   不注入的话，将来任何一条「带媒材 + 链跑成」的自证用例都会**真打网络** ——
  //   而 §2.4.4 记的正是这个形状（自证有副作用）。与 chainRunner / publishRunner 同一种做法。
  modelSideRunner = reviewModelSide,
  imageClaimRunner = adjudicateImageClaims,
  factSourceLoader = loadImageFactSources,
  // ★ 落表这一步**必须可注入** —— 否则单测里一个假结论就会真的往 Owner 的表里写一行
  //   （2026-10-05 实测发生过：自证往真表写了两行，还改了一行的状态）。
  publishRunner = reviewPublish.ensureReviewRow,
  // ★ 2026-10-09：「≥3 时建合并报告」这一步**必须可注入** —— 它默认会**真的在你飞书里建一份云文档**。
  //   不注入的话，任何一条「带媒材 + 链跑成 + 问题数 ≥3」的自证用例都会留下一份真文档
  //   （`Z1`/`Z14` 正是这个形状）—— 与上面 `modelSideRunner`/`publishRunner` 是**同一个形状**
  //   （§2.4.4：跑一次自证，改掉了它要保护的东西）。实测已经发生过一次：写这一条时的探针
  //   真的建了一份文档 `SVqgdEM9KoS5LMxcavmc9QvLntf`。
  mergedReportRunner = publishMergedReport,
  // ★ 2026-10-09：「建议」那一次调用**必须可注入** —— 它默认真打 LLM；
  //   不注入的话每条含条目的自证都会真调模型（与 modelSideRunner 同一个理由）。
  adviceRunner = generateAdvice,
  // ★ 2026-10-22：默认改成**分流器**（飞书链接走飞书只读接口，其余走公开网页读数器）。
  //   事故见 `feishu_link.mjs` 文件头；`readPublicPage` 仍是它内部的一条分支，没有丢。
  linkReader = reviewGate.readLink,
  // 视频直链的下载与读取同样须可注入，离线自证不访问网络或真实素材。
  downloadVideoFn = downloadVideoToFile,
  readVideoFn = video.readVideoSegmented,
  force = false,
} = {}) {
  // 在任何 await 前固定本条来源；不同会话可并发，不能在落表时读共享上下文。
  const publishContext = Object.freeze({ ...publicationContext, actor: 'shouheng/review-gate' });
  if (force) return { question, gate: null, chainBlock: '', chainRan: false, chainMs: 0, verdict53: null };

  let gate = reviewGate.isSubmission({
    text: inbound?.text ?? '',
    imageCount: inbound?.imageCount ?? 0,
    videoCount: Math.max(Number(inbound?.videoCount) || 0,
      Array.isArray(inbound?.videos) ? inbound.videos.length : 0),
  });
  if (!gate.yes) {
    // ★ 2026-10-14：闸门**判「不是送审」时也要留一行读数** —— 因为一次事故正是
    //   「它判成了送审」。原先这里什么都不打，于是「闸门有没有把这条挡下来」
    //   在盘上是一行不存在的日志（§2.4.1：判据没盖住的那一跳，就是事故所在的那一跳）。
    if (gate.guard) console.log(`[agent] 🧭 送审闸门：不起链 —— ${gate.why}`);
    return { question, gate, chainBlock: '', chainRan: false, chainMs: 0, verdict53: null };
  }

  const hasImageForAudit = Number(inbound?.imageCount ?? 0) > 0
    || (Array.isArray(inbound?.images) && inbound.images.length > 0);
  const reviewStartedAt = Number.isFinite(tIngress) && tIngress > 0 ? tIngress : Date.now();
  // All image post-processing shares the original clock. Child transports
  // cancel their real work; expiry must not leave a detached publishing task.
  const runBeforeDelivery = (task) => hasImageForAudit
    ? withReviewDeadline(reviewStartedAt + REVIEW_LIMIT_MS - REVIEW_SEND_RESERVE_MS, task)
    : task();
  const imageAuditRequest = hasImageForAudit
    ? canonicalImageAuditRequest(userText === undefined ? inbound?.text : userText)
    : '';
  // 图片送审的范围由图片审查 skill 固定为完整审查。群聊 @、私聊提问措辞只留在报告，
  // 不进入知识库链的判定提示，避免同一张图因会话包装不同而得到不同 KB 结果。
  const chainQuestion = hasImageForAudit
    ? '请按图片安全审查 skill 对本次附图执行完整审查，逐项完成全部检查。'
      + (imageAuditRequest ? `\n对方的具体关注点：${imageAuditRequest}` : '')
    : question;
  let input = reviewGate.chainInput({ question: chainQuestion, inbound });
  if (hasImageForAudit) input.deadlineAt = reviewStartedAt + REVIEW_LIMIT_MS;
  // ★★ 2026-10-20：**素材模态**（位置那一格要按模态断言；见 `renderMerged` 的 `modality`）。
  //   口径：有视频 ⇒ video；否则有图 ⇒ image；否则 text（与 PRD §5.3.3 的三种位置形态一一对应）。
  let _modality = (Array.isArray(inbound?.videos) && inbound.videos.length) ? 'video'
    : ((Array.isArray(inbound?.images) && inbound.images.length) ? 'image' : 'text');
  // Carry modality and the full kernel-produced image context with this chain call.
  // Do not recover either value from process-global state: another Feishu event may
  // enter while this review is awaiting the DSH tool call.
  input.contentType = _modality;
  input.imageContext = buildImageBlock(inbound);
  // Keep approved source bytes bound to this turn. A source being available never makes it applicable.
  inbound.imageFactSources = [];
  input.imageFactSources = [];
  if (_modality === 'image') {
    let sources;
    try { sources = factSourceLoader(KB_ROOT); }
    catch { sources = { sources: [], errors: [{ code: 'source_unavailable' }] }; }
    inbound.imageFactSources = Array.isArray(sources?.sources) ? sources.sources : [];
    // Availability is not applicability. Report repair may identify a claim
    // omitted by an initial scope heuristic, so supply the approved bytes now.
    input.imageFactSources = inbound.imageFactSources;
  }
  const imageClaimCache = new Map();
  const checkReport = (answer, { sources = inbound.imageFactSources ?? [], deadlineAt } = {}) => {
    const scenes = (inbound.images ?? []).map(im => im?.scene?.scene).filter(Boolean);
    return runBeforeDelivery(() => checkImageReport(answer, {
      scenes, materialTexts: imageMaterialTextsOf(inbound),
      sceneFaults: sceneFaultsOf(inbound),
      sleepPositions: sceneMod.infantSleepReadings(scenes),
      abnormal: scenes.flatMap(scene => sceneMod.abnormalContainers(scene)),
      sources, claimRunner: imageClaimRunner, cache: imageClaimCache,
      deadlineAt: Math.min(deadlineAt ?? Infinity, input.deadlineAt ?? Infinity),
    }));
  };
  setAgentTurnContext({ imageBlock: input.imageContext || '', chainTurnModality: _modality,
    imageFactSources: input.imageFactSources, imageReportChecker: _modality === 'image' ? checkReport : null });
  // ★ 2026-10-12（Owner）：「这一步要 6~30 分钟」**是优化前的旧估计，删掉**。
  //   库里早有同一条裁定（`agent/review_gate.mjs:308`：「去掉时长估计」，
  //   依据是实测一条图 3 分 32 秒、而回执写 6~30 分钟）—— 回执卡那侧已改，
  //   但**这行 console 日志漏改**，于是它还在日志里以「守衡自己提示」的样子出现。
  //   判据：`tools/test_agent.mjs` 的「不许再给时长估计」一条（卡片正文口径）。
  const _tGate = Date.now();     // 闸门入口（量「闸门内置办回执」与「读素材那一段」两个读数）
  console.log(`[agent] 🧭 送审闸门：${gate.kind} —— ${gate.why}｜起链`);
  // ★★ 2026-10-20（Owner 批准 ①+②）：「回执前置」＋「指标换成真 ingress」。
  //
  //   ① 一条消息**只许有一张回执**。调用方（`handleMessage`）若已在**读素材之前**发过，
  //      `ackSentAt` 非空 ⇒ 这里**一个字都不发**，只把那一张的时刻交给指标。
  //      为什么不由闸门自己判断「发没发过」：按 `inbound` 有没有读数去猜，会在**读图失败**时
  //      再补发一张，用户就收到两个「处理中」。
  //      ⚠️ 闸门这条路**故意保留**：引用某条带图的消息时，正文/张数要到读入阶段才知道，
  //      前置那一支判不出来 —— 那时仍由这里发（早发一次、晚发一次，二选一，不会都发）。
  //
  //   ② 指标口径同步改了（这才是「3 分钟没人报」的根治）：
  //      旧版 `tIngress` 在守护进程这条路上**从没被传过**，缺省成「进闸门那一刻」——
  //      那已经在读图之后 ⇒ PRD §12 的 ≤5 秒**结构上不可能变红**。实测：日志读数
  //      1401ms / 383ms，而同一时刻飞书侧真值是 60 / 120 / 180 秒。
  //      现在 `ws_daemon.onMessage` 用**消息 `create_time`** 打 tIngress（`ingressMsOf`），
  //      `group_response_ms` 第一次量到「用户等的那一段」，并另记 `prep_ms`（读素材那段）。
  //    ⚠️ 计时器**不参与任何判定**（与 `review.py` 的 `trace.perf` 同一种做法）。
  let ackAt = ackSentAt ?? null;
  let queued = false;
  // ★★ 2026-10-21（Owner 当场纠正：「必须先回复处理中，再回复block」）——
  //   **P0 命中也要先发这张回执**：「处理中」不是结论，两件事不冲突；
  //   「一条只回一条结论」管的是**不许同一单给出两个三态**。
  //   （判据仍是 `ackSentAt`：内核那侧已经前置发过 ⇒ 这里不补第二张。）
  if (!ackAt && typeof notify === 'function') {
    // ★ 回执要**分开说**「常态 5 分钟」与「在排队」—— 用一个悲观的大区间把两件事糊在一起，
    //   人会以为每条都要半小时（Owner 2026-10-05 当场就是这么读的：「太长了，不正常」）。
    //   排不排队是**读得出来的**：知识库那条循环的认领（`kb_loop_claim`）现在有没有人在持。
    try {
      const cs = await claimStatus();
      queued = !!cs && cs.free === false && cs.stale === false && cs.unknown !== true;
    } catch { /* 取不到就不说排队（不谎报） */ }
    // ★ 递过去的是**卡片块**（发送层负责成形）—— 见 `review_gate.ackMessage` 的两条现场裁定。
    //
    // ★★ 目标 19（2026-10-10）：**PRD §12「飞书群 @Agent 响应时间 ≤5 秒」的唯一观测点就在这里。**
    //    为什么是这里：按已定口径（`review_publish.mjs:47`）「P0 问题可先在飞书侧响应」——
    //    回执卡**在跑链之前**发，它就是用户感知到的"响应"；P0 判定在其之后（实测 9.8~27 ms），
    //    不计入这条预算。所以量 `tIngress → 回执卡发送完成` 才是这条指标，不是量整链。
    try { await notify(reviewGate.ackMessage(gate, { queued }).block); ackAt = Date.now(); }
    catch (e) { console.log(`[agent] · 送审回执没发出去（不影响链）：${e?.message ?? e}`); }
  }
  // ★★ 2026-10-20：`ackAt >= tIngress` 这个括号是**判据的一部分**，不是防御性代码。
  //   没有真 ingress 时（批量工具 / 自证），tIngress 被兜底成「进闸门那一刻」；
  //   而回执已经**在读素材之前**发过了 ⇒ ackAt < tIngress，算出来是**负数**（实测 -842ms）。
  //   负数不是"很快"，是「这两个时刻量的不是同一段」⇒ **宁可不打这一行，也不编一个数**
  //   （与 `measure_group_response.py` 的「无观测 ⇒ no_reading，不许当达标」同一条纪律）。
  if (tIngress && ackAt && ackAt >= tIngress) {
    const groupResponseMs = ackAt - tIngress;
    const ackDecisionMs = Math.max(0, ackAt - _tGate);
    const prepMs = Math.max(0, _tGate - tIngress);
    // 结构化一行，供 `kb/l8/measure_group_response.py` 汇总（**别改字段名**，汇总端按它解析）。
    console.log(`[metric] group_response_ms=${groupResponseMs} ack_decision_ms=${ackDecisionMs}`
                + ` prep_ms=${prepMs} prd_limit_ms=5000`
                + ` verdict=${groupResponseMs <= 5000 ? 'pass' : 'FAIL'}`
                + ` stage=${ackSentAt ? 'early' : 'gate'}`
                + ` ingress=${tIngressOrigin ?? 'handle_entry'}`
                + ` chat=${gate?.chatId ?? inbound?.chatId ?? '-'}`);
  }

  // ── ★ 2026-10-28：视频直链拦截 ─────────────────────────────────────────────
  //   场景：用户发 Amazon / Shopify CDN 的 .mp4 直链，守衡把它当网页链接读取，
  //   因 Content-Type: video/mp4 或超 4MB 被拒，回「审查未完成」。
  //   修法：识别视频直链 → 流式下载 → 走正常视频审查路径（gate.kind 改成 'media'）。
  if (gate.kind === 'link') {
    const videoLinks = (gate.links ?? []).filter(isVideoDirectUrl);
    if (videoLinks.length > 0) {
      const videoUrl = videoLinks[0];  // 一次只处理第一条（与 MAX_VIDEOS_PER_MESSAGE=1 一致）
      console.log(`[agent] 🎬 视频直链拦截：${videoUrl}`);
      const dl = await downloadVideoFn(videoUrl).catch((e) => ({ ok: false, error: e?.message ?? String(e) }));
      if (!dl.ok) {
        try { dl.cleanup?.(); } catch { /* failed downloads may still own temporary bytes */ }
        const reply = `视频链接下载失败（${dl.error}）；请直接上传视频文件，未下载成功的内容不会判为通过。`;
        console.log(`[agent] ⚠️ 视频直链下载失败：${dl.error}`);
        return { question: buildUserTurn({ questionText: question }), gate, chainBlock: '',
          chainRan: false, chainMs: 0, verdict53: null, reviewDecisionWithheld: true, forcedReply: reply,
          linkRead: { ok: false, pagesRead: 0 } };
      }
      // 下载成功 → 走 readVideo，注入进 inbound，切换 gate.kind 为 'media'
      let vidResult;
      let retainedFrames;
      try {
        vidResult = await readVideoFn(dl.path, { scene: sceneMod.sceneRead });
        if (!vidResult?.ok) {
          const reply = `视频链接内容读取失败（${vidResult?.error ?? '未知'}）；请直接上传视频文件。`;
          return { question: buildUserTurn({ questionText: question }), gate, chainBlock: '',
            chainRan: false, chainMs: 0, verdict53: null, reviewDecisionWithheld: true, forcedReply: reply,
            linkRead: { ok: false, pagesRead: 0 } };
        }
        retainedFrames = retainVideoModelFrames(vidResult, 1);
        // 打印与上传视频相同的读数格式
        const audioLine = vidResult.transcript?.ok && vidResult.transcript.text?.trim()
          ? `音轨转写 ${String(vidResult.transcript.text).trim().length} 字`
          : (vidResult.transcript?.kind === 'no_audio_track' ? '**没有音轨**' : '音轨转写没跑成');
        console.log(`[agent] 📥 视频直链读到｜`
          + `${Number(vidResult.meta?.duration_s ?? 0).toFixed(1)} 秒`
          + `｜抽帧 OCR ${vidResult.framesRead ?? 0}/${vidResult.frames?.length ?? 0} 帧`
          + `（共 ${vidResult.ocrChars ?? 0} 字）｜${audioLine}`
          + (vidResult.perf ? ` ⏱probe:${vidResult.perf.probe_ms}ms ocr:${vidResult.perf.ocr_ms}ms asr:${vidResult.perf.asr_ms}ms` : ''));
        // 下载后的读数与上传视频共用原帧保留、审查、清理路径。
        inbound = { ...inbound, videoCount: 1,
          videos: [{ index: 1, ...vidResult, ...retainedFrames,
            fileName: videoUrl.split('/').pop().split('?')[0], bytes: dl.bytes }],
          skippedVideos: 0 };
        gate = { ...gate, kind: 'media', why: `视频直链（已下载：${videoUrl.split('/').pop().split('?')[0]}）` };
        input = reviewGate.chainInput({ question: chainQuestion, inbound });
        _modality = 'video';
        input.contentType = _modality;
        input.imageContext = buildImageBlock(inbound);
        setAgentTurnContext({ imageBlock: input.imageContext || '', chainTurnModality: _modality, imageFactSources: [] });
        retainedFrames = null; // 所有权交给 inbound；双轨完成或异常时由 _imgCleanup 清理。
      } catch (e) {
        if (retainedFrames?.modelFrameDir) {
          try { fs.rmSync(retainedFrames.modelFrameDir, { recursive: true, force: true }); } catch {}
        }
        const reply = `视频链接读取失败（${e?.message ?? e}）；请直接上传视频文件。`;
        return { question: buildUserTurn({ questionText: question }), gate, chainBlock: '',
          chainRan: false, chainMs: 0, verdict53: null, reviewDecisionWithheld: true, forcedReply: reply,
          linkRead: { ok: false, pagesRead: 0 } };
      } finally {
        try { vidResult?.cleanup?.(); } catch { /* 本轮抽帧读数与保留帧已独立于源目录 */ }
        try { dl.cleanup?.(); } catch { /* 下载字节用完即删 */ }
      }
    }
  }

  // Link-only submissions must contribute fetched page text to the same review chain.
  // A read failure returns a deterministic non-PASS response and skips all review writers.
  const linkReview = await reviewGate.prepareLinkReview({ gate, input, reader: linkReader });
  input = linkReview.input;
  if (linkReview.forcedReply) {
    console.log(`[agent] ⚠️ 链接正文未读取，拦截审核结论：${linkReview.forcedReply}`);
    return { question: buildUserTurn({ questionText: question }), gate, chainBlock: '',
      chainRan: false, chainMs: 0, verdict53: null, forcedReply: linkReview.forcedReply,
      linkRead: { ok: false, pagesRead: linkReview.pages.length } };
  }
  if (linkReview.pages.length) console.log(`[agent] 🔗 链接正文已读取：${linkReview.pages.length} 页，进入审核链`);
  // ── ★★ 2026-10-16：媒材链接 —— **回执之后才起，且不 await** ────────────────────
  //
  //   为什么必须在这里起（三个约束一起决定的，改哪一条都会坏）：
  //     · **不许在回执之前**：上传要 5 次 CLI 调用（实测 9.6 s 首次 / 之后约 7 s），
  //       摆在回执前就是往 PRD §12 那条「@ → 回执 ≤5 秒」上直接加时间；
  //     · **不许在落表时才起**：链要跑 100 秒上下，那时再上传等于白等 7 秒；
  //     · **不能等到那时才去取字节**：读入阶段的临时文件按红线**用完即删**，
  //       所以这里起的是「**重新取一次字节 → 上传 → 删临时文件**」（见 `collectMediaLinks`）。
  //   ⇒ 与链**并行**跑；落表那一刻用 `awaitLinks` **有界等待**（P0 快路几毫秒就到落表，
  //     等不到就按「没链接」落，那一格只留原文 —— 绝不写一个点不开的链接）。
  const linksP = (inbound?.imageCount || inbound?.videoCount)
    ? runBeforeDelivery(() => mediaLinksRunner({
        inbound, fetchImage: fetchImageForLink, fetchVideo: fetchVideoForLink, upload: mediaUpload,
        log: (s) => console.log(`[agent] ${s}`),
      })).catch((e) => { console.log(`[agent] ⚠️ 媒材链接这一步抛了：${e?.message ?? e}`); return []; })
    : null;
  // ── ★ 2026-10-08：**模型侧与链同时起跑**（方案 §③ 的原话是「互不等待」）──────────
  //
  //   改前是**串行**：`if (chainRan) { await modelSideRunner(...) }` ——
  //   链先跑完（实测 127 / 145 / 417 秒）模型侧才开始，而且**链报错时模型侧根本不跑**
  //   （`if (chainRan)` 把它一起掐掉）⇒ 链库忙/超时的那一单，用户**什么都拿不到**。
  //   实测证据（Owner 2026-10-08 截图那张库忙卡）：链卡在认领上、模型侧本该独立出结论，
  //   却因为绑在 `chainRan` 上而一起没了。
  //
  //   现在：**两路同时起，谁先完谁先等**。链侧慢或坏，模型侧那几条照样进结论
  //   —— 这正是方案说的「没有主判与辅助之分」。
  //   `.catch` 兜在起跑处：模型侧抛异常**不算这一轮失败**，它只是没有产出（边界①）。
  // ★ 2026-10-16：把**对方原话（剥掉 @ 之后）**一并传进去 —— 不许再把
  //   `inbound.text`（含 `@守衡` 这个 mention）当成【素材正文】喂给模型侧。
  //   现场见报告第 1 条：「正文只带了中文账号名 @守衡…建议换成品牌官方英文 handle」。
  const readings = readingsForModelSide(inbound, { userText });
  // ★★ 2026-10-21（Owner：「P0 红线问题必须 10 秒内回」）——**P0 预判命中 ⇒ 不起模型侧**。
  //
  //   为什么敢停：PRD §6.3 第一层写的是「P0 命中即**停止后续审查**，直接输出 BLOCK，
  //   确保法务红线零延迟拦截」；§6.2 P0 行更写明「**无需大模型推理**，正则/关键词命中即输出」。
  //   实测（365 轮日志）：这一路 55 单里模型侧 **p50 11.8 s / p90 29.7 s / 最大 52.4 s**，
  //   而它在这一路上的命中数实测为 0（结论由确定性匹配定，模型侧只可能补条目）。
  //   ⇒ 停它不是"省事"，是把它从**判定路径**上摘掉；不命中 P0 的单子照旧两轨齐跑。
  //
  //   ⚠️ 用 `p0PreHit` 而不是链返回的 `res.p0_fastpath`：模型侧必须与链**同时起跑**（上面那段），
  //     而链的结论要几十毫秒~几十秒后才回来 —— 那时再决定已经晚了。
  //     预判与实判用的是**同一份正文 + 同一份模式表**（`p0Precheck` → `p0_fastpath.py`），
  //     实判仍以链为准：`res.p0_fastpath` 为空而预判命中时，下面会照实记一行（口径不一致要看得见）。
  // ── ★ 2026-10-21：送审图**落盘后交给链**（图身份层用；不是 OCR 文本）──────────────
  //   病根：`--image` 此前只被用来申报 coverage（算 sha），**图从未进过评审**
  //   ⇒ 小语种图（OCR 丢变音符号 / 夹水印行）在负面样本层 0 命中 ⇒ 结论 PASS。
  //   这里**重新取一次字节**（读入阶段那份临时文件按纪律已删），落到 /tmp 下的本单目录，
  //   把路径交给 `kb_review_chain`；链跑完（成 / 败 / 超时）一律删。
  //   边界：取不到就**不带图**，链的其余行为与改动前逐字一致（不阻断送审）。
  let _imgDir = null;
  const _imgPaths = [];
  // ★★ 2026-11-03（Owner 批准 A）：取图失败**不许静默**。
  //   病根：原先 `.catch(() => {})` 把失败吞掉 ⇒ 链拿到空 `--image` ⇒
  //   review_run.sh 的图身份层 fail-closed（`image_source_missing`）⇒
  //   用户看到的是「审查未完成」，而真实原因只是「原图没到手」。
  const _imgFetchErrors = [];
  let _imgFetchTried = 0;
  try {
    const imgs = Array.isArray(inbound?.images) ? inbound.images : [];
    const todo = imgs.filter((im) => im && !im.failed && im.msgId && im.imageKey);
    const noIdentity = imgs.filter((im) => im && !im.failed && (!im.msgId || !im.imageKey)).length
      + Math.max(0, Number(inbound?.imageCount ?? 0) - imgs.length);
    // 「没有可回取标识」只留痕、**不拦**：那是夹具/上游形状问题，链侧的失败会自己出声。
    if (noIdentity > 0) console.log(`[agent] ⚠️ ${noIdentity} 张图没有可回取的标识（msgId/imageKey）—— 链将拿不到 --image`);
    _imgFetchTried = todo.length;
    if (todo.length) {
      _imgDir = fs.mkdtempSync('/tmp/shouheng-chain-img-');
      await Promise.all(todo.map((im) => runBeforeDelivery(() => fetchImageForLink(im.msgId, im.imageKey, { dir: _imgDir }))
        .then((r) => {
          if (r?.path) _imgPaths.push(r.path);
          else _imgFetchErrors.push(`图 ${im.index ?? '?'}：${r?.error ?? '取图没有回路径'}`);
        })
        .catch((e) => { _imgFetchErrors.push(`图 ${im.index ?? '?'}：${e?.message ?? e}`); })));
    }
  } catch (e) {
    console.log(`[agent] ⚠️ 送审图落盘失败（不影响送审）：${e?.message ?? e}`);
    _imgFetchErrors.push(String(e?.message ?? e));
  }
  input.imagePaths = _imgPaths;
  setChainTurnImagePaths(_imgPaths);
  // ★★ 2026-11-03（Owner 批准 A）：**去取了原图、一张都没到手 ⇒ 不起链**，当场说清原因。
  //   为什么不起链：链要的是本机原图文件（图身份 / 4A 规则符合性都靠它）；
  //   带着空 `--image` 起链只会 fail-closed 成 `image_source_missing`，
  //   然后被兜成「审查未完成」—— 那句话会让对方以为「我审了但没审完」，
  //   而事实是「我连图都没拿到，重发一次就能解决」。
  //   边界：只拦「**真的去取了**却一张没到手」；夹具里没有 msgId/imageKey（根本没去取）
  //   保持原行为，由链侧自己出声 —— 否则判据会顺手把正常夹具单一起拦掉（实测 19 条）。
  if (_imgFetchTried > 0 && _imgPaths.length === 0) {
    const why = _imgFetchErrors.length ? _imgFetchErrors.slice(0, 2).join('；') : '取回的原图是 0 张';
    console.log(`[agent] ⛔ 拿不到原图 ⇒ 不起链（不判「审查未完成」）：${why}`);
    return { question: buildUserTurn({ questionText: question }), gate, chainBlock: '',
      chainRan: false, chainMs: 0, verdict53: null, reviewDecisionWithheld: true,
      forcedReply: `这单我**没拿到原图**（${why}）。不是我审完没结论 —— 是链要的本机原图文件没到手。`
        + `请**单独重发一次这张图**，我拿到字节立刻重审。`,
      linkRead: { ok: false, pagesRead: 0 } };
  }
  // 图片必须由模型侧直接看到原图。P0 的快速停止只适用于纯文本；图片仍需完成独立视觉/语义复核。
  const imageModelRequired = Number(inbound?.imageCount ?? 0) > 0;
  // 图片审查固定走完整审查口径，不让群名、@方式或一句泛化提问改变图片发现。
  // 原始图片是判定对象；OCR/视觉读数作为辅助；聊天文字保留在用户回复和报告里，
  // 但不让泛化聊天措辞改变完整图片审查的范围。
  const modelReadings = imageModelRequired
    ? readingsForModelSide(inbound, { userText: imageAuditRequest }) : readings;
  const modelQuestion = imageModelRequired ? imageAuditRequest : question;
  const runModelSide = () => modelSideRunner({ readings: modelReadings, question: modelQuestion,
    imagePaths: [..._imgPaths, ..._videoFramePaths],
    requiredImageCount: (imageModelRequired ? Number(inbound.imageCount) : 0) + _videoFramesRequired,
    ask: llm.ask });
  // 每次发送都独立推理，包括同时送来的相同素材；不读写历史结果，也不共享在途请求。
  const _videoFramePaths = (inbound?.videos ?? [])
    .flatMap((v) => Array.isArray(v?.modelFramePaths) ? v.modelFramePaths : [])
    .filter((p) => p && fs.existsSync(p));
  const _videoFramesRequired = (inbound?.videos ?? [])
    .reduce((count, v) => count + Math.max(1, v.scenePlan?.length ?? 0), 0);
  const runVideoModelSide = () => modelSideRunner({
    readings: readingsForModelSide(inbound, { userText: canonicalImageAuditRequest(userText) }),
    question: canonicalImageAuditRequest(userText),
    imagePaths: _videoFramePaths,
    requiredImageCount: _videoFramesRequired,
    ask: llm.ask,
  });
  const runCurrentModelSide = () => (!imageModelRequired
    && (Number(inbound?.videoCount ?? 0) > 0 || (inbound?.videos ?? []).length > 0))
    ? runVideoModelSide() : runModelSide();
  const modelSideP = p0PreHit && !imageModelRequired
    ? Promise.resolve({ ok: true, findings: [], dropped: [], ms: 0, skipped: 'p0',
                        raw: '（P0 确定性命中 ⇒ 按 PRD §6.3 未起模型侧）' })
    : runBeforeDelivery(runCurrentModelSide)
      .catch((e) => ({ ok: false, findings: [], dropped: [], ms: 0, error: `${e?.message ?? e}` }));
  const _imgCleanup = () => {
    if (_imgDir) {
      try { fs.rmSync(_imgDir, { recursive: true, force: true }); } catch { /* 删不掉不影响结论 */ }
    }
    _imgDir = null;
    for (const v of (inbound?.videos ?? [])) {
      if (v?.modelFrameDir) {
        try { fs.rmSync(v.modelFrameDir, { recursive: true, force: true }); } catch { /* ignore */ }
        v.modelFrameDir = null;
      }
    }
  };

  const t0 = Date.now();
  let res;
  try { res = await chainRunner(input); }
  catch (e) { res = { error: `起链抛异常：${e?.message ?? e}` }; }
  const chainMs = Date.now() - t0;
  const chainRan = !res?.error;
  let chainBlock = reviewGate.formatChainBlock(res);

  // ── ★ 双轨：**模型侧独立一遍** + 并集合并（2026-10-06）────────────────────
  //
  //   依据：上游技术方案《内容治理技术方案》§③「知识库 ＋ 大模型 双校验」/§④「结果合并输出」——
  //         「模型侧：语义核查与边界判断 → 命中带 位置与理由（**无库内依据**）」
  //         「同一个问题 → 取交集 ／ 不同的问题 → 走并集」
  //   合并判据全在 dual_track.mjs（六行矩阵逐字实现 + 自证 16/7 条）。
  //
  //   ★ 三条边界，一条都不许松：
  //     ① 文本模型侧失败可回落单轨；图片/视频必须通过各自完整性检查才可出结论；
  //     ② **模型侧没报东西就不改结论** —— renderMerged 返回 null，仍用链给的那份；
  //     ③ **PASS 门限一个字不改** —— mergedState 要求 kbCovered === true，
  //        而 kbCoveredOf 认不出来时判「没覆盖」（保守一侧）。
  let dual = null;
  const imagePending = Number(inbound?.imageCount ?? 0) > 0 || !!inbound?.imageUnresolved;
  let imageCompletion = { incomplete: imagePending, visualGate: null, imageWorkflowGate: null,
    imageEvidenceReason: null, imageUnresolvedGate: !!inbound?.imageUnresolved,
    sceneFaults: [], reason: imagePending ? '图片完整性检查未完成' : '',
    visualGateRefusal: imagePending ? '本轮图片审查未完成，暂时不能据此放行。' : null };
  const videoPending = Number(inbound?.videoCount ?? 0) > 0 || (inbound?.videos ?? []).length > 0;
  const p0IsConfirmed = videoPending ? isConfirmedP0Block(res) : !!res?.p0_fastpath;
  const mediaKind = imagePending && videoPending ? '图片和视频' : videoPending ? '视频' : '图片';
  let videoCompletion = { incomplete: videoPending, reason: videoPending ? '视频完整性检查未完成' : '',
    refusal: videoPending ? '本轮视频审查未完成，暂时不能据此放行。' : null };
  let mediaCompletion = { incomplete: imagePending || videoPending,
    reason: `${mediaKind}完整性检查未完成`,
    refusal: imageCompletion.visualGateRefusal || videoCompletion.refusal };
  const refreshMediaCompletion = () => {
    mediaCompletion = { incomplete: imageCompletion.incomplete || videoCompletion.incomplete,
      reason: [imageCompletion.incomplete && imageCompletion.reason,
        videoCompletion.incomplete && videoCompletion.reason].filter(Boolean).join('；'),
      refusal: [imageCompletion.visualGateRefusal, videoCompletion.refusal].filter(Boolean).join('\n') || null };
  };

  // ★★ 2026-10-21：**这一单是不是 P0 确定性命中而停掉了后续审查**（要活到 `try` 之外 ——
  //   调用方（`handleMessage`）据此**不再调模型写正文**，读的就是它）。
  //   实判来自链：`res.p0_fastpath` 非空 ⇔ `p0_fastpath.py` 确定性命中（永远只出 BLOCK）。
  let p0Stopped = false;
  {
    try {
      // ★ 与链**并行**起跑的那一路（见上面）：`await` 在这里通常已经完成了。
      //   它**不再**以 `chainRan` 为条件 —— 链没跑成时，模型侧那几条就是这一单的全部产出，
      //   掐掉它等于把「有话说」变成「没话说」。
      // ★★ 2026-10-21（补一个自己刚挖的坑）：**预判说命中、链却报没命中**时怎么办？
      //
      //   上面那行是按 `p0PreHit` 决定「起不起模型侧」的（模型侧必须与链同时起跑，那时
      //   链还没回来）。所以预判一旦是假阳性，这一单就会**既没回执、也没模型侧** ——
      //   比改动之前更差，而且用户还要等一条几分钟的链。
      //   ⇒ 这里补一刀：链**没**报 P0 命中、而模型侧是被预判砍掉的 ⇒ **现在补跑**。
      //     慢一点，但回到改动前的质量（宁慢勿错：模型侧那几条是这一单的产出一半）。
      const model = (p0PreHit && !p0IsConfirmed && !imageModelRequired)
        ? await runCurrentModelSide()
            .catch((e) => ({ ok: false, findings: [], dropped: [], ms: 0, error: `${e?.message ?? e}` }))
        : await modelSideP;
      imageCompletion = await checkImageCompletion({ inbound, res, model, chainRan, chainMs,
        checkReport });
      videoCompletion = checkVideoCompletion({ inbound, res, model, chainRan, chainMs });
      refreshMediaCompletion();
      if (videoCompletion.incomplete) inbound.videoGateReason = videoCompletion.reason;
      if (videoPending) {
        console.log(`[agent] 🎬 视频完整性：${videoCompletion.completed ? '通过' : '未完成'}`
          + `｜原帧交付 ${_videoFramePaths.length}/${_videoFramesRequired}`
          + `｜视觉规则覆盖=${JSON.stringify(videoCompletion.coverage ?? null)}`
          + (videoCompletion.reason ? `｜${videoCompletion.reason}` : ''));
      }
      // Validate and render observed video data before any report can be published.
      const currentVideoAnalysis = !mediaCompletion.incomplete ? videoAnalysisOf(inbound) : '';

      // Completion is now decided before extraction, rendering or publishing.
      // The source image must remain on disk until the independent model-side request has consumed it.
      // 图片和视频都只抽取本轮专项审查发现；本轮为空时也不能拿上次的发现补齐。
      const skill = skillFindingsOf(res?.answer);
      _imgCleanup();
      // ★ 抽不到也必须出声（「空」与「没抽」要长得不一样）——
      //   判据在 `skill_findings.mjs` 的自证里（7 项，含两条反向对照）。
      if (skill.findings.length) {
        console.log(`[agent] 🧩 判定主体核查：${skill.note}`
          + `｜${skill.findings.map((f) => String(f.location ?? '')).slice(0, 5).join(' / ')}`);
      } else if (chainRan) {
        console.log(`[agent] 🧩 判定主体核查：**一条都没上卡** —— ${skill.note}`);
      }
      const kb = kbFindingsOf(res?.answer, res?.engine, res?.p0_findings, { text: input?.text ?? '' });
      // ★ 库侧的**结构化读数**（2026-10-07）：结论与条数从这里取 —— 不再只靠正则抠中文答案。
      //   病灶（当天实测，已复现）：PRD §5.3.3 规定问题数 ≥3 时库侧只出分类汇总 ⇒
      //   逐条正则抠不到 ⇒ 库侧被读成「0 条」⇒ 合并把**库侧的 BLOCK 降级成 REVIEW**。
      const kbSide = kbSideOf(res);
      const merged = mergeFindings(kb.findings, [...model.findings, ...skill.findings]);
      // ── ★★ 2026-10-16：**汉字声称闸**（Owner 当场问的那一行；详见 `ocr_claim_gate.mjs`）──
      //   病灶（第 17 行，实测）：那张**通篇英文**的商品图，本机 OCR 在「控制面板 Cleaning
      //   图标处」「纸盒上印的 30 那一带」读出汉字（置信度 0.3 = 引擎下限；整图 2× 再读汉字归零），
      //   模型侧看不到原图、只吃这段 OCR ⇒ 写成「图上有中文」，出了 REVIEW ＋ 改图建议。
      //   80 行里同类 4 条，**真阳性 0**。
      //   闸门口径：声称「画面/图上有非英文文字」的条目，必须过（a）画面读数确认 或
      //   （b）OCR 逐字命中且置信度 ≥ 0.5；都不过 ⇒ **降级**：**不进 `merged.items`**
      //   ⇒ 既不计入问题数、也不影响三态与报告链接（与「不是发现的问题不许当发现」同一条纪律）。
      //   ⚠️ 降级**不是删除**：每一条都在日志里逐条留痕（引了什么字、置信度多少、画面层说了什么），
      //      闸门自己抛异常时**原样放行**并出声（减噪工具不许把整单结论带下水）。
      let gateRes = { kept: merged.items, downgraded: [], applied: false, note: '（没跑）' };
      try {
        gateRes = ocrGate.gateFindings(merged.items, ocrGate.evidenceOf(inbound));
        if (gateRes.downgraded.length) {
          merged.items = gateRes.kept;
          // 计数口径跟着走：按 `source` 重算（与 `mergeFindings` 的统计同口径）。
          const st = { both: 0, conflict: 0, kb_only: 0, model_only: 0 };
          for (const f of merged.items) {
            if (f.source === 'both') st.both += 1;
            else if (f.source === 'both-conflict') st.conflict += 1;
            else if (f.source === 'kb') st.kb_only += 1;
            else st.model_only += 1;
          }
          merged.stats = { ...merged.stats, ...st, merged: merged.items.length,
                           gate_downgraded: gateRes.downgraded.length };
        }
        if (gateRes.downgraded.length) {
          for (const d of gateRes.downgraded) {
            console.log(`[agent] 🚦 汉字声称闸：降级 1 条（**不计入问题数**）`
              + `｜${String(d.item?.location ?? '').slice(0, 60)}｜${d.why}`);
          }
          console.log(`[agent] 🚦 汉字声称闸：本单降级 ${gateRes.downgraded.length} 条，`
            + `并入条目 ${merged.items.length} 条（原 ${merged.items.length + gateRes.downgraded.length} 条）`);
        } else if (gateRes.applied) {
          console.log(`[agent] 🚦 汉字声称闸：过（${gateRes.note}）`);
        }
      } catch (e) {
        console.log(`[agent] 🚦 汉字声称闸异常（**原样放行**，不影响本单）：${e?.message ?? e}`);
      }
      // ★★ 2026-10-14：**模型侧没跑成也要传进合并态**（与 `renderMerged` 里那个同名判据**一处口径**：
      //   `model.ok === false`）。原先只传给卡片文案，**没传进 `mergedState`** ⇒
      //   模型侧解析失败被当成「模型侧 0 条」⇒ 库侧安全词覆盖就能落 **PASS**
      //   （实测 `MC-US-AMZ-B0CWLHKQNT`：模型侧 JSON 解析失败 ⇒ merged=[] ⇒ PASS）。
      const modelFailed = !!(model && model.ok === false);
      const state = mediaCompletion.incomplete ? 'NEEDS_INPUT' : mergedState({ kbCovered: kbCoveredOf(res?.answer), merged: merged.items,
                                  kb: kbSide, modelFailed });
      // ── ★★ 2026-10-15（Owner）：置信度 = **两侧各出一个档位 ⇒ 对外只出一个数** ──────────
      //   为什么在这里算：两侧**并行起跑**（见上），只有**合并这一刻**两侧的东西才同时在手
      //   （`kbCovered` / `merged.items` / `model.findings` / `modelFailed`）。
      //   库侧：沿用旁挂里**引擎已算好**的那个数（本处不重算，只分档）；
      //   模型侧：由它自己**已经输出**的命中结构派生（不新增 LLM 字段）；
      //   合并：按 PRD §6.6 三档**取更保守一侧** —— 零自由权重。
      //   模型侧未参与 ⇒ 不产出合并数，退回库侧读数并在 basis 写明（单轨语义不许漂）。
      //   ★★ 2026-10-15（F1 收尾）：**入参这里不许提前 `Number()`** ——
      //   `Number(null) === 0`、`Number('') === 0` ⇒「库侧没有读数」会在进 `mergedConfidence`
      //   之前就被改写成"置信度 0"，然后落进 `focus` 档（0.65）。
      //   `bandOf`/`mergedConfidence` 内部**本来**就按 null 处理（它们的注释就写着这个坑），
      //   是这里多此一举的转换把它毁掉了。⇒ 空值原样透传，交给它们判。
      const kbConfRaw = res?.review?.confidence ?? res?.confidence;
      const kbConfidence = (kbConfRaw === null || kbConfRaw === undefined || kbConfRaw === '')
        ? null
        : (Number.isFinite(Number(kbConfRaw)) ? Number(kbConfRaw) : null);
      // ── ★★ 2026-10-16（Owner）：「P0 命中 ⇒ 置信度记 1.0，**模型侧应该也是 1，最终出 1**」──
      //   判据取自引擎读数（快路标记 / `tier_trace.P0` / 库侧那个 1.0），见 `p0HitOf` 头注。
      //   P0 命中时合并数走 `p0` 档 ⇒ 恒 1.0（模型侧的命中不许把它拉低）。
      const p0Hit = p0HitOf({ res, kb: kbSide });
      const mergedConf = mergedConfidence({
        kbConfidence,
        kbCovered: kbCoveredOf(res?.answer),
        model, modelFailed,
        p0Hit,
        // ★ `both` = 双轨确认条数（§④「同一个问题取交集」那一格）。
        //   没有它，v1 会把「库侧 PASS/0 条 ＋ 模型侧 2 条」这种**分歧**算成 direct ——
        //   端到端实测（RC-78ce50b3732c）当场抓到这个不自洽，见 dual_track.mjs 里那段注释。
        bothCount: merged.stats?.both ?? 0,
      });
      // ── ★★ 2026-10-15：合并置信度**落一行机读台账** ─────────────────────────────
      //   为什么非落不可：这个数只活在"合并那一刻"的内存里 —— 事后既无法从表行反推
      //   （表行只有结果），也无法从报告反推（报告是散文）。而 Owner 要"两侧统一出一个数"
      //   就必然要**核对历史每一行**，库侧的标定器也**只能读机读件**（不读散文）。
      //   ⇒ 追加式 NDJSON，一行一单；写失败**绝不影响回复**（try/catch，只打日志）。
      //   `KB_CONF_LEDGER` 只给自证/离线验证用（把路径指到临时目录，§2.4.4：自证不许改真数据）。
      try {
        //   ★★ 2026-10-15 实测修：这里原来写的是 `path.join(stateDir, ...)` —— 而
        //   `stateDir` 是从 `config.mjs` 进来的**函数**（`stateDir()`），不是字符串 ⇒
        //   `path.join` 抛 "Received function stateDir" ⇒ **每一单都写不进去**，
        //   而 try/catch 把它降级成一行日志 ⇒ 「台账」这件事**从来没成立过**
        //   （实测：`PMO/shouheng-state/confidence-merged.ndjson` 至今不存在）。
        //   修法 = 调它：`stateDir()`。判据：自证里这条 warn 必须消失，且真跑一单后台账文件出现。
        const lp = process.env.KB_CONF_LEDGER
          || path.join(stateDir(), 'confidence-merged.ndjson');
        // ★ `material_sha8`：按**素材本身**的键。为什么不能用 content_id 当键 ——
        //   实测（2026-10-15）：链"回缓存"时**旁挂不更新** ⇒ `res.review.content_id` 是
        //   **上一单**那个号（四条不同素材落出同一个 `AD-20261015-001`）⇒ 台账按它对齐会串行。
        //   素材哈希永远可得，且与"这一单是哪条素材"一一对应。
        // ★★ 2026-10-16 修（与报告第 1 条同一个根因）：**键要按素材，不能按消息原文**。
        //   原先取 `inbound.text` —— 而**纯图单的 `inbound.text` 就是 `@守衡` 这一句**
        //   （对方只 @ 了一下 + 一张图）⇒ **所有纯图单会撞成同一个键**，
        //   而这一格的全部意义就是「与"这一单是哪条素材"一一对应」（见下面那段的理由）。
        //   ⇒ 改成 `input.text`（链那一侧的素材文本：图上是 OCR、视频是读数、纯文案才是原文）。
        //   ⚠️ 它**只**影响台账这把键 —— 行上的 `内容 ID` 是另一处独立计算（`contentIdOf`），
        //      不在这一改动的范围内（那会动到行去重语义，要单独定）。
        const materialSha8 = createHash('sha256')
          .update(String(input?.text ?? inbound?.text ?? ''), 'utf8').digest('hex').slice(0, 8);
        fs.appendFileSync(lp, JSON.stringify({
          at: new Date().toISOString(),
          material_sha8: materialSha8,
          content_id: res?.review?.content_id ?? res?.content_id ?? null,
          state,
          kb_value: kbConfidence,
          kb_band: mergedConf.kb_band, model_band: mergedConf.model_band,
          merged_value: mergedConf.value, band: mergedConf.band,
          model_ok: !!(model && model.ok !== false),
          model_findings: model?.findings?.length ?? null,
          both: merged.stats?.both ?? null, kb_only: merged.stats?.kb_only ?? null,
          model_only: merged.stats?.model_only ?? null,
          // ★ 2026-10-16：汉字声称闸降了几条 —— 落一行机读台账。
          //   为什么非落不可：降级的条目**不上卡、不进格**（PRD §5.3 的格式要求），
          //   若这里也不记，「闸门扣了一条」就只剩一行日志 —— 事后没人能按素材对齐复核
          //   （与 `confidence-merged.ndjson` 当初那条理由逐字相同：只活在内存里的读数 = 没有读数）。
          gate_downgraded: merged.stats?.gate_downgraded ?? 0,
          basis: mergedConf.basis,
        }) + '\n', 'utf8');
      } catch (e) {
        console.log('[agent] ⚠ 置信度台账没写成（**不影响本单回复**）：' + (e?.message ?? e));
      }
      // ── ★★ 2026-10-09：「建议」的唯一产出者（Owner 的规则）────────────────────
      //   「有填的做参考，agent 输出最终具体建议；没填的 agent 直接出建议」
      //   为什么必须在这里（两侧都回来之后）：模型侧与链**并行**跑，模型侧产出它的发现时
      //   库侧的建议还没到 ⇒「有填的做参考」只能**此刻**做。代价是多一次 LLM 调用。
      //   失败不编：`adviceRunner` 失败就回退到 `renderMergedItem` 里那两套旧逻辑。
      // ★★ 2026-10-09（Owner 追问后的更正）：**只对「需要生成」的条目跑**。
      //   Owner 的期望：「知识库侧 **参考库侧建议** → agent 出最终建议；**模型侧问题就输出模型侧建议**」。
      //   第一版把**所有**条目都送进去了 ⇒ 模型侧本来已经写好的一条建议被**重写**，
      //   既白烧一次生成，两次生成的详略也可能差很多。
      //   判据：有库侧参考 ⇒ 要跑（那就是「参考库侧建议」那条规则）；
      //        没库侧参考但模型侧自己写了 ⇒ **沿用**（`renderMergedItem` 的回退链会印它并标来源）；
      //        都没有 ⇒ 要跑（否则只剩「两侧都没给」）。
      const needsAdvice = (f) => !!((f.kb?.suggestionLine || f.kbAdvice) || !(f.suggestion || f.model?.suggestion));
      const needIdx = merged.items.map((f, i) => (needsAdvice(f) ? i : -1)).filter((i) => i >= 0);
      const needItems = needIdx.map((i) => merged.items[i]);
      let adviceMap = {};
      let adviceNote = null;
      // ★★ 2026-10-21（Owner：「P0 红线问题必须 10 秒内回」）—— **P0 确定性命中 ⇒ 不调这次 LLM**。
      //
      //   实测（365 轮日志）：这一路 49 次建议生成 **p50 5.4 s / p90 8.6 s / 最大 11.7 s** ——
      //   单独就顶掉 10 秒预算的一半以上。而 PRD §6.3 说 P0 命中「**停止后续审查**，直接输出 BLOCK」，
      //   建议生成正是后续审查的一环。
      //   ⇒ 停掉之后，条目里的「建议」不是空：`renderMergedItem` 的回退链会**原样印库侧建议**
      //     （P0 的 `p0_findings` 自带库内建议原文，实测卡上是「删除正文中命中的『最安全』或『#1』等词…」
      //      这种可直接执行的句子），并且**不新增任何措辞**（本处一个字都不编）。
      //   ⚠️ 只对 P0 命中的单子生效；未命中 P0 的单子照旧「参考库侧建议 → agent 出最终建议」。
      const p0StoppedLocal = p0IsConfirmed;
      p0Stopped = p0StoppedLocal;
      // ★ 口径不一致**必须出声**：预判命中而实判没命中（或反之），说明两次输入/判据不同源 ——
      //   那种情况下这一单可能"没有回执、也没跑模型侧"，事后必须查得到为什么。
      if (p0PreHit !== p0StoppedLocal) {
        console.log(`[agent] ⚠️ P0 预判与实判不一致：预判=${p0PreHit ? '命中' : '未命中'}`
          + '｜实判=' + (p0StoppedLocal ? '命中' : '未命中')
          + '｜素材指纹=' + String(res?.p0_fastpath?.mode ?? '—')
          + ' ⇒ 按**实判**走（预判只影响回执与模型侧是否起跑）');
      }
      if (p0Stopped) {
        adviceNote = '跳过（P0 确定性命中：PRD §6.3「命中即停止后续审查」⇒ 不调模型，'
          + '建议原样用库侧）';
      } else {
        try {
          const ar = await runBeforeDelivery(() => adviceRunner({ items: needItems,
            readings: imageModelRequired ? modelReadings : readings,
            question: imageModelRequired ? '' : question,
            ask: llm.ask }));
          if (ar && ar.ok) {
            needIdx.forEach((origI, k) => { if (ar.advice && ar.advice[k]) adviceMap[origI] = ar.advice[k]; });
            adviceNote = `ok/${ar.ms}ms`
              + (Array.isArray(ar.rejected_unsupported) && ar.rejected_unsupported.length
                ? `（拒绝 ${ar.rejected_unsupported.length} 条把「记录未给建议」推成禁止/打回的改法）`
                : '')
              + (Array.isArray(ar.rejected_ocr_noise) && ar.rejected_ocr_noise.length
                ? `（拒绝 ${ar.rejected_ocr_noise.length} 条未经原图确认的 OCR 拼写/标点改法）`
                : '');
          } else adviceNote = `失败（回退，不编）：${ar?.error ?? '未知'}`;
        } catch (e) { adviceNote = `异常（回退，不编）：${e?.message ?? e}`; }
      }
      console.log(`[agent] 💡 建议生成：${adviceNote}｜送进去 ${p0Stopped ? 0 : needItems.length} 条（沿用模型侧初稿 ${merged.items.length - needItems.length} 条）｜覆盖 ${Object.keys(adviceMap).length} 条`);
      const itemsWithAdvice = merged.items.map((f, i) => ({
        ...f,
        advice: adviceMap[i] ?? null,
        // 标注说「参考了什么」：库侧那格有值才算参考过（改法始终是模型写的）
        adviceReferencedKb: !!(f.kb?.suggestionLine || f.kbAdvice),
      }));
      const rendered0 = mediaCompletion.incomplete ? null : renderMerged(itemsWithAdvice, { state, kb: kbSide, kbTextCount: kb.findings.length, model,
                                                     kbHitsBlock: kb.kbHitsBlock ?? null,
                                                     mergedStats: merged.stats,
                                                     modality: _modality });

      // ── ★ 2026-10-09：**问题数 ≥3 ⇒ 飞书文档要带报告**（Owner 的原话）──────────
      //
      //   病灶：报告只有库侧会建，而它的门槛读的是**它自己的** `issue_count`
      //   （`feishu_publish.py::REPORT_LINK_MIN_ISSUES`）。实测 2026-10-09 09:35 那张图：
      //   卡上说「共发现 **6** 处」（库侧 1 ＋ 模型侧 5）⇒ 按 PRD 该给报告，
      //   而旁挂 `issue_count = 1` ⇒ 库侧不建 docx ⇒ `report_url = null` ⇒ **没有链接可给**。
      //
      //   所以报告改由**本仓**建：门槛读**卡里那个数**（`rendered0.total`），
      //   正文含**两侧全部条目**（Owner：「6 个就展示 6 个问题」）。
      //   走 `review_publish.publishReportDoc()` —— 与库侧同命令同身份，**只建文档不写业务表**
      //   （不去调 `feishu_publish.py`：它 `:495` 的 `rid = None` 让 `:555` 成为死代码 ⇒
      //    每调一次必然在业务表里多一行）。
      //
      //   ★★ 2026-10-09（Owner 裁定「2 先于 1」）：**去掉 `!kbSide?.reportUrl` 这个挡条** ──
      //
      //   Owner 的疑问：「发文案给守衡输出的报告格式是对的，发图片和视频就不对了？」
      //   查清了，成因反直觉 —— 那一行 `!kbSide?.reportUrl` 让两条路**互斥**：
      //     · 文案单：库侧自己 **1 条（<3）** ⇒ 库侧不建 docx ⇒ `kbSide.reportUrl` 空
      //       ⇒ 本仓建了合并报告 ⇒ **卡上链接正确**；
      //     · 图片/视频单：库侧自己 **5 条（≥3）** ⇒ 库侧建了 docx ⇒ `kbSide.reportUrl` 有值
      //       ⇒ **本仓被跳过** ⇒ 卡上链接指向**库侧那份**。
      //   而库侧那份有两个硬伤（我逐字对比过两份文档）：
      //     ① 它**只装库侧条目**，条目数天然对不上卡里那个数（库侧 5 vs 卡内 7）；
      //     ② 它把**库内案例**渲染成「命中」，而守衡那份自带免责
      //        （「库内条目只说明出处，不说明与本次素材相关；相关性以卡片告警为准」）
      //        —— 免责说明正是挡住那个坑的东西。
      //   ⇒ 口径定死：**只要卡内 ≥3，就用本仓那份**。库侧那份降为"库侧自己留的档"，
      //     **不再自动当作卡上的链接**（`reportUrlOverride` 优先于 `kbSide.reportUrl`，
      //     这条在 `renderMerged` 里本来就是这么写的）。
      //
      //   ★ 三条边界（第一条改了，后两条不变）：**卡内 ≥3 一律本仓建**（不再看库侧有没有）；
      //     **失败不阻断结论**（报告与三态是两件事）；**失败必须照 detail 说**
      //     （把 `url=''` 说成「已出报告」是比不建更坏的一面）。
      let reportUrlOverride = null;
      // ★★ 2026-10-14（Owner 本地要求）：「问题数少于 3 个的，也输出审查报告，
      //   格式跟大于 3 个问题数量的审查报告一致」。
      //   ⇒ 去掉「卡内条数 ≥ `REPORT_LINK_MIN_ISSUES` 才建」这道闸：**只要有可并的条目就建**。
      //      （判据 Z17 有一条**反向断言**：源码里不许再出现那个比较式 —— 所以这里也不写它。）
      //   ⚠️ 这是**本地（这批跑/这张表）的要求**，不是 PRD 口径 ——
      //      PRD §5.3.4 / §8.3 与库侧 `feishu_publish.py::REPORT_LINK_MIN_ISSUES = 3` **一个字没动**。
      //      「格式一致」天然成立：报告正文由 `merged_report.mjs` 渲染，它**不按条数分支**
      //      （该件头部明写「不再 import REPORT_LINK_MIN_ISSUES」），<3 与 ≥3 是同一套版式。
      // ★★ 2026-10-15（Owner 报「**链接是空的**」，真单 `MC-US-YT-_xyLF4_AgAw-IMG`）：
      //   **一条条目都没有 ⇒ 不建报告**。
      //   病灶：那一单两侧都没命中（模型侧 0 条 ／ 库侧 `issue_count=0`），
      //   而报告这一跳只看 `rendered0` 真不真 ⇒ 照样建了一份 docx，
      //   里面只有标题 + 结论行 + 「（本单没有并进任何条目。）」⇒ **人点开是空的**，
      //   而卡上还挂着那个链接（「一个点不开的链接比空格更坏」，何况是一个点开没内容的）。
      //   ⇒ 闸改成「**有可并的条目**（`total > 0`）才建」。
      //   ⚠️ Owner 2026-10-14 的本地要求「**<3 也出报告**」**一个字没动**：
      //     只要**有**条目（1 条、2 条都算）就建，格式与 ≥3 完全一致（见下面 Z17 那两条判据）。
      //   ★★ 2026-10-16（Owner 追问「重新发图还会出空链接吗」时当场核出来的**第二种形状**）：
      //     **闸必须挂在「条目」上，不是挂在那个计数上**。
      //     病灶（离线复现，`/tmp/shprobe2/p5.mjs` 的 B 例）：库侧报 `issue_count=3`、
      //     明细抠不出来（`kbGap=3`）、模型侧 0 条 ⇒ `total=3 > 0` 照样建报告，
      //     而 `itemsWithAdvice` 是**空的** ⇒ docx 里只有结论行 ＋「（本单没有并进任何条目。）」
      //     ⇒ **链接还是空的**。更要命的是它还会**顶掉库侧自己的报告链接**
      //     （`reportUrlOverride` 优先于 `kbSide.reportUrl`）—— 库侧那份是**有明细**的，
      //     等于拿一个空文档换掉了一份有内容的。
      //     ⇒ 改成「**有真条目才建**」：没有条目 ⇒ `reportUrlOverride` 保持 null ⇒
      //       链接回落库侧那份（有明细），卡上照旧「另有 N 条未并进本卡：明细在报告里」。
      // ★★ 2026-10-17（Owner 裁定，**推翻 2026-10-14 那条本地要求**）：
      //   「逻辑不变，按照 PRD 问题数量 ≥3 个时才输出审查报告」。
      //   两道条件**同时**要满足，缺一条都会造出坏链接：
      //     · `itemsWithAdvice.length > 0` —— 没有真条目 ⇒ 报告里只有结论行
      //       （「一个点开没内容的链接比空格更坏」，2026-10-15/16 两次定过）；
      //     · `rendered0.total >= REPORT_LINK_MIN_ISSUES` —— 回到 PRD §5.3.4 的门槛。
      //       <3 时**卡片本来就逐条平铺**（`renderMerged` 的 `summarized` 分支），
      //       明细一个字都不在报告里丢 —— 这也是 <3 不需要报告的**理由**，不是妥协。
      //   ⚠️ 与库侧 `feishu_publish.py::REPORT_LINK_MIN_ISSUES`、`dual_track` 的同名常数
      //      **同一个数、同一个口径**（PRD §5.3.4 / §8.3 / §17 三处一致）。
      //   ⚠️ 2026-10-14 的「<3 也出」当时是**为那批 80 行落表**要的；那一批已经跑完，
      //      如将来再需要，走 `--force-report` 之类的显式开关，**不许把门槛再改回去**。
      // ★★ 2026-10-19（Owner：「问题数量<3个的，也输出报告链接（不要落库，只限本次任务优化）」）：
      //   ⇒ 就照上一行说的那件事办：加一个**显式开关** `SH_FORCE_REPORT=1`，**默认关**。
      //   · 门槛那两行**一个字没动** —— 不传开关时行为与改动前逐字相同；
      //   · 传了也只放开「条数」这一道，`itemsWithAdvice.length > 0` **照旧要满足**
      //     （没有真条目 ⇒ 建出来是空文档，2026-10-15/16 两次定过"点开没内容的链接比空格更坏"）；
      //   · PRD §5.3.4 / §8.3 与库侧 `REPORT_LINK_MIN_ISSUES = 3` **不因这个开关而改**：
      //     它是**这一次任务**的出数开关，不是新口径。
      // ★★ 2026-10-22（Owner：「报告不展示 图片安全审查 skill 全流程结果」）：
      //   报告不再装 skill 的六段交付正文 ⇒ 原先为「把全流程正文放进报告」而算的
      //   `reportVisualGate` / `reportWorkflowGate` / `reportImageEvidenceFailure` /
      //   `imageSkillReview` 四个读数**一并撤掉**（没有消费者了）。
      //   ⚠️ 图片审查的**完整性闸门一个字没动**：它在两侧返回后、任何报告发布前由
      //     `visual_checklist.mjs` 的两道判据把守（缺项 ⇒ NEEDS_INPUT）。
      //     「报告展不展示 skill 正文」与「skill 有没有真的走完」是两件事。
      let videoReportPublished = false;
      const forceByEnv = /^(1|true|yes|on)$/i.test(String(process.env.SH_FORCE_REPORT ?? '').trim());
      const reportTotal = Number.isFinite(rendered0?.total) ? rendered0.total : 0;
      const reportLine = String(rendered0?.line ?? '')
        || deriveVerdictLine({ mergedState: state, mergedCount: reportTotal })?.line || '';
      const buildReport = !!rendered0 && !['NEEDS_INPUT', '拒答'].includes(String(state).toUpperCase());
      const reportItems = Array.isArray(rendered0?.displayItems)
        ? rendered0.displayItems : itemsWithAdvice;
      if (buildReport && shouldPublishMergedReport({ total: reportTotal,
        itemCount: reportItems.length, force: forceByEnv })) {
        if (forceByEnv && reportTotal < REPORT_LINK_MIN_ISSUES) {
          console.log(`[agent] 📄 SH_FORCE_REPORT=1 ⇒ 本条只有 ${reportTotal} 条也建报告`
            + '（一次性开关，PRD §5.3.4 的 ≥3 门槛没改）');
        }
        try {
          const at = new Date().toISOString();
          // ★★ 2026-10-13（Owner 第四条）：**渲染两份** ——
          //   投出去的（`mdDoc`）只含 PRD 字段；留底的（`mdFull`）附录照旧完整。
          //   两份的**条目逐字同源**（同一次 `renderMergedReportMd`，只差 `withAppendix`）。
          // ★★ 2026-10-17 第二十二轮（Owner）：「**审查对象，要加进来**，比如图片就放
          //   点击可打开的链接，文案」。
          //   · 文案 = **对方真写的那句话 / 那段广告原文**（`userText`）；
          //     不传时退回 `question`，但**必须过 `stripInternal`** —— 那是拼给模型看的一轮，
          //     里面夹着我们的探针与 OCR 全文（`media_link.mjs` 头注那次事故）。
          //   · 图/视频 = `media_link` 上传后拿到的**组织内可阅读**链接。
          //     这里**有界等待**（上传在回执之后就起了，等到报告这一跳大概率已经好了）：
          //     等不到就照实说「链接未生成」，**绝不编一个点不开的链接**。
          const { media: materialMedia } = await runBeforeDelivery(() => mediaLink.awaitLinks(linksP, {
            ms: 8000, log: (s) => console.log(`[agent] ${s}`) }));
          const materialText = String(userText ?? mediaLink.stripInternal(question) ?? '').trim();
          // ★★ 2026-10-17 第二十三轮（Owner：「你送的文案，为什么给『链接：点开』？这链接跳转是哪里？」）
          //   **只有这一单本身就是「链接送审」时**，URL 才算送审对象、才列成可点链接。
          //   普通文案里粘着的 URL 一个都不挖 —— 那一单的 `production.It` 就是粘贴时被编辑器
          //   自动加的链接（域名是别人的 .it），把它印成「链接：点开」等于给陌生域名发通行证。
          // ⚠️ 2026-10-17 第二十七轮：判据从「闸门说这是链接送审」改成
          //   **「贴的链接就是素材」**（正文去掉链接后很短，见 `reviewGate.linkOnly`）——
          //   闸门把一条 900 字广告文案里粘贴残留的 URL 判成了链接送审，报告于是多印了一行
          //   「链接：[点开](http://production.it/)」。现在文字送审里带的 URL **一个都不列**。
          const submitLinks = reviewGate.linkOnly(materialText).isLinkOnly
            ? reviewGate.findLinks(materialText)
            : [];
          const _args = {
            // ★ 同一批条目 —— 报告与卡片必须逐字同源（今天已因「两处各写一遍」栽过两次）
            merged: reportItems, total: reportTotal, state, line: reportLine,
            // ★ 卡上撤下来的检索读数 → 报告附录（搬不是砍）
            hitsBlock: rendered0?.hitsBlock ?? null,
            // ★★ 2026-10-09 晚：卡上撤下来的**媒材读数全文**（Owner 点头「放到附录」）
            mediaAppendix: mediaReadAppendix(inbound),
            videoAnalysis: currentVideoAnalysis,
            question, contentId: kbSide?.contentId ?? '', at,
            // ★ 2026-10-17 第二十二轮：审查对象（文案原文 ＋ 图/视频的可点链接）
            material: { text: materialText, media: materialMedia, links: submitLinks },
            // ★★ 2026-10-21（Owner 裁定 A）：**非阻断提示**（排名/销量宣称需补可核验依据）。
            //   来路只有一处：`p0_fastpath` 的 `advisories`（它自己也不进 findings、不改三态）。
            //   ⚠️ 不在这里另算一遍 —— 两份口径各扫一遍，迟早一个说有一个说没有。
            //   ★★ 2026-10-22（Owner 裁定 B）：**裸「100%」**同样是非阻断提示，但**措辞分开写** ——
            //     「排名/销量宣称」与「百分号后面没有限定词」是两件事，混成一句话报告会说错话
            //     （实测那张图：管身小字只有一个「100%」，后面那行更小的英文 OCR 没读出来）。
            notes: [
              ...(Array.isArray(res?.advisories) ? res.advisories : []).map(
                (x) => `素材里出现「${x}」这类排名/销量宣称，美国平台会要求可核验的依据，发布前补一句来源与口径`),
              ...(Array.isArray(res?.percent_notes) ? res.percent_notes : []).map(
                (x) => `素材里出现「${x}」，但它后面没有可判的限定词（成分／安全／疗效）—— `
                       + '本机读数判不了它是什么；请按原图或文案确认，并准备可核验的依据。'
                       + '**这条不算问题、也不影响结论**'),
            ],
            kbGap: rendered0?.kbGap ?? 0, kbTextCount: kb.findings.length,
            modelCount: model?.findings?.length ?? 0,
          };
          const mdFull = renderMergedReportMd(_args);
          const mdDoc = renderMergedReportMd({ ..._args, withAppendix: false });
          const pub = await runBeforeDelivery(() => mergedReportRunner(mdDoc, {
            contentId: kbSide?.contentId ?? '', at, archiveMd: mdFull }));
          if (pub.ok) {
            reportUrlOverride = pub.url;
            videoReportPublished = !!pub.url && !!_args.videoAnalysis;
            console.log(`[agent] 📄 合并报告已建（问题数 ${reportTotal}）：${pub.url}`
              + `｜留底（含附录）：${pub.archivePath ?? '(未留)'}`);
          } else {
            console.log(`[agent] ⚠️ 合并报告**没建成**（照实说，不编链接）：${pub.detail}`);
          }
        } catch (e) {
          console.log(`[agent] ⚠️ 合并报告异常（**不阻断结论**）：${e?.message ?? e}`);
        }
      } else {
        // ★★ 2026-10-09：**「跳过了」必须出声**（Owner 问「为什么发图片/视频报告就不对，
        //    发文案就对」——而这一跳当时**一条日志都没有**，只能靠倒推）。
        //   ⚠️ 去掉 `!kbSide?.reportUrl` 挡条之后，走到这里**只剩两种正当原因**
        //      （「库侧已经给了链接」那一种已从结构上消失）：
        //        · `renderMerged` 返回 null（没有可并的条目）；
        //        · ~~卡内总数 < 3（PRD §5.3.4 本就不该给报告）~~
        //          ★ 2026-10-14：**这一种已消失** —— 本地要求改成「<3 也出报告」，
        //            闸只剩「有没有可并的条目」。留此行是为了让下一个人知道它**曾经**是原因。
        const _ru = kbSide?.reportUrl ?? null;
        const _why = mediaCompletion.incomplete ? `${mediaKind}完整性检查未通过：${mediaCompletion.reason}`
          : ['NEEDS_INPUT', '拒答'].includes(String(state).toUpperCase()) ? '本轮审查拒答，未形成可发布结论'
          : !rendered0 ? 'renderMerged 返回 null（没有可并的条目）'
          : (itemsWithAdvice.length === 0
            ? '没有真条目可并（库侧报了几条但明细抠不出来）⇒ 建出来会是空文档'
            : `卡内总数 ${reportTotal} < ${REPORT_LINK_MIN_ISSUES} ⇒ 按 PRD §5.3.4 本就不出报告`
              + '（卡片已逐条平铺，明细不缺）');
        console.log(`[agent] 📄 合并报告：**未建**（${_why}）`
          + `｜卡内总数=${rendered0?.total ?? '—'}｜库侧链接=${_ru ?? '(无)'}`
          + `（kind=${kbSide?.reportUrlKind ?? '—'}）`);
      }
      // ★ 建失败时**仍要看得见**：这一单会回落成「卡上链接指向库侧那份」——
      //   那是**次优**（库侧只装库侧条目），但**有链接好过没链接**。
      //   所以不算失败，只把"回落到了谁"记出来。
      if (!mediaCompletion.incomplete && !reportUrlOverride && kbSide?.reportUrl) {
        console.log(`[agent] 📄 合并报告没建成 ⇒ **回落库侧那份**（${kbSide.reportUrl}）`
          + '—— 注意：库侧那份只装库侧条目，条目数可能与卡里那个数不一致。');
      }
      const rendered = reportUrlOverride
        // ★ 必须用 itemsWithAdvice —— 有报告链接时走的是这一支，用 merged.items 会把建议丢掉
        ? renderMerged(itemsWithAdvice, { state, kb: kbSide, kbTextCount: kb.findings.length, model,
                                       reportUrlOverride, kbHitsBlock: kb.kbHitsBlock ?? null,
                                       mergedStats: merged.stats, modality: _modality })
        : rendered0;
      dual = { model, kb, merged, state, rendered, kbSide, mergedConf, reportUrl: reportUrlOverride };
      // Only a successfully published report containing this turn's visual analysis
      // can replace the card appendix. Risk cues never increase the finding count.
      dual.videoAnalysis = !mediaCompletion.incomplete && !videoReportPublished
        ? currentVideoAnalysis : '';
      // ★★ 2026-10-19（Owner 裁定「1→2→3 全做」的第 1 步）——
      //   **逐条结构化记录**：不管这一单出不出报告，都要落盘。
      //   放在这里（`reportUrlOverride` 已定、`rendered` 已定）是为了让记录里的
      //   `has_report` 与「卡上到底有没有那个链接」说的是同一件事。
      //   ⚠️ 用 `rendered.itemsMeta`（最终那张卡的那一趟），不是 `rendered0` ——
      //     `rendered0` 是在知道报告链接**之前**渲的，用它会把「被截断」记成另一个版本。
      //   ⚠️ 失败不许带崩结论：留痕是**记录**，不是判定。
      try {
        const recAt = new Date().toISOString();
        const record = buildMergedRecord({
          items: itemsWithAdvice,
          itemsMeta: rendered?.itemsMeta ?? rendered0?.itemsMeta ?? [],
          state,
          line: mediaCompletion.incomplete ? `本轮${mediaKind}审查未完成，以下为尚未验收的发现` : (rendered?.line ?? rendered0?.line ?? null),
          total: rendered?.total ?? rendered0?.total ?? itemsWithAdvice.length,
          kb: kbSide, model, question, contentId: kbSide?.contentId ?? '', at: recAt,
          // 出厂闸读数（空 = 四条口径全合规）—— 卡上要不要出声由 `dual_track` 管，
          // 这里只把它**原样存下来**，事后查得到「那一单当时判过什么」。
          cardConformance: rendered?.cardConformance ?? [],
          hasReport: /^https?:\/\//i.test(String(reportUrlOverride ?? '')),
        });
        if (imagePending) {
          record.image_completion = { ok: !imageCompletion.incomplete,
            reason: imageCompletion.reason, workflow: imageCompletion.imageWorkflowGate,
            visual: imageCompletion.visualGate, scene_faults: imageCompletion.sceneFaults };
          record.chain_answer = String(res?.answer ?? '');
        }
        if (videoPending) {
          record.video_completion = { ...videoCompletion,
            model_frames: { required: _videoFramesRequired, provided: _videoFramePaths.length } };
          record.chain_answer = String(res?.answer ?? '');
        }
        const recPath = writeMergedRecord(record, { contentId: kbSide?.contentId ?? '', at: recAt });
        console.log(recPath
          ? `[agent] 🗂 逐条记录已落盘：${recPath}（${record.items.length} 条｜`
            + `分侧=${JSON.stringify(record.sides)}）`
          : '[agent] ⚠️ 逐条记录**没落成**（目录不可写？）—— 卡面来源标记即将可摘，这条要有');
      } catch (e) {
        console.log(`[agent] ⚠️ 逐条记录生成异常（**不阻断结论**）：${e?.message ?? e}`);
      }
      // ★ 2026-10-08：**模型侧没跑成时要把 raw 打出来**。
      //   原先只打 `model.error`，而「没跑成」的两种成因——「额度被 reasoning 烧光 ⇒ 正文 0 字」
      //   与「写了散文没写 JSON」——**报的是同一句话**（`输出里没有 JSON 数组`）。
      //   `model_side.mjs:115` 的注释早写着要报 raw 长度，但那一行从来没接上；
      //   实测（Owner 2026-10-08 那张图，日志 `模型侧 没跑成：输出里没有 JSON 数组`）
      //   就是查不下去：不知道是空正文还是散文，也就定不了是加额度还是加解析。
      const modelNote = model.ok
        ? (model.skipped
            // ★★ 2026-10-21：两种「跳过」原因不同，**不许合并成一句话**
            //   （`skipped='p0'` 是 PRD §6.3 的主动停审；`文字层为空` 是素材侧没字可读）。
            //   读错原因的后果：事后有人看到「跳过（文字层为空）」会去查 OCR，而真因在判定层。
            ? (model.skipped === 'p0'
                ? '**未跑**（P0 确定性命中 ⇒ PRD §6.3「命中即停止后续审查」，不起模型侧）'
                : `跳过（${model.skipped === true ? '文字层为空' : model.skipped}）`)
            : model.findings.length + ' 条 / ' + model.ms + 'ms')
        : ('没跑成：' + model.error
           + (model.raw === undefined
             // 连返回都没拿到（调用抛异常 / 传输失败）—— 与「拿到了但没 JSON」不是一回事
             ? '｜**没有拿到模型返回**（抛异常或传输失败），不是解析问题'
             : `｜raw=${String(model.raw).length} 字`
               + '（0 字 = 额度被 reasoning 烧光；非空 = 写了散文没写 JSON）'
               + `｜raw 首 100 字=${JSON.stringify(String(model.raw).slice(0, 100))}`));
      // ★ 结构化读数与文本抽取**并排打出来** —— 两者不一致时必须看得见（2026-10-07）。
      const kbNote = kbSide.hasSidecar || kbSide.source === 'p0_fastpath'
        ? `${kbSide.source === 'p0_fastpath' ? 'P0 快路' : '机读旁挂'} 结论=${kbSide.state || '—'}`
          + `/${kbSide.issueCount ?? '—'} 条 ｜ 逐条抽出 ${kb.findings.length} 条`
          + (kbSide.refused ? ` ｜ ⛔ **库侧拒答**（${kbSide.reason || '未给原因'}）` : '')
          + (Number.isFinite(kbSide.issueCount) && kbSide.issueCount > kb.findings.length
              ? ' ｜ ⚠️ 明细未抠全（≥3 时库侧按 PRD 只出汇总）' : '')
        : '**读不到机读旁挂**（缺证据要看得见）';
      console.log('[agent] ⚖ 双轨（与链**并行**起跑）｜模型侧 ' + modelNote
        + '｜知识库侧 ' + kbNote
        + ' ⇒ ' + mergeSummary(merged.stats)
        + '｜合并态=' + state
        + '｜改写结论=' + (rendered ? '是' : '否（模型侧没报东西，仍用链给的那份）')
        //   ★ 2026-10-15（F1）：`value` 可能是 `null`（库侧没读数 ⇒ 不出这个数）；
        //     `Number.isFinite(Number(null))` 为真 ⇒ 会打成 `0`（又一次 `null`→`0`）。
        //     没有数就打 `—`，并在后面那格说明档位也是 `—`。
        + '｜置信度(两侧合并)=' + ((mergedConf?.value === null || mergedConf?.value === undefined
            || mergedConf?.value === '' || !Number.isFinite(Number(mergedConf.value))) ? '—' : mergedConf.value)
        + ' [' + (mergedConf?.band ?? '—') + ']'
        + '（库侧 ' + (mergedConf?.kb_band ?? '—') + ' / 模型侧 ' + (mergedConf?.model_band ?? '未参与') + '）'
        + (model.dropped?.length ? '｜⚠ 解析丢掉 ' + model.dropped.length + ' 条：' + model.dropped.map((d) => d.why).join('；') : ''));
      if (rendered) {
        chainBlock = chainBlock
          + '\n\n【★ 双轨合并后的结论（**这一份才是最终的**，代码产出，逐字转述）】：\n'
          + rendered.block;
        // ══════════════════════════════════════════════════════════════════════
        // ★★ 2026-10-13（Owner 裁定）：**查证笔记只进这里 —— 既不上卡，也不进报告正文**
        // ══════════════════════════════════════════════════════════════════════
        //
        //   Owner 原话：「输出到飞书群包含知识库侧+模型侧的文字，**不要展示在卡片上**，
        //   **我问的时候，你要能回答**」，并把那一族口径读数（`知识库侧 … ／ 模型侧 …`、
        //   `ℹ️ 知识库侧给了 覆盖缺口…`、`（问题数 8 ≥ 3 ⇒ 按 PRD §5.3.3 …）`）
        //   逐条列进了「类似以下的文案都去掉」。
        //
        //   位置就是这一处，理由是判据级的：`chainBlock` 是**这一轮**发给模型的正文，
        //   而它同时被 `mem.append` 写进**会话记忆** —— 于是：
        //     · 这一轮：模型看得到 ⇒ 对方问「知识库侧报了几条」它当场答得出来；
        //     · 以后每一轮：记忆里还在 ⇒ 隔一轮再问也答得出来。
        //   而卡片与报告都是从 `rendered.block` 渲染的，**不经过这一段**。
        //
        //   ⚠️ 「不许写进回答」不能只是一句声明（AGENTS.md §2.4）——
        //     执行点有两处：`dual_track` 已经把这几行**从 `block` 里摘掉**
        //     （模型没有可逐字转述的源），信封层还有一道 `stripInternalNotes` 兜底
        //     （模型若照抄，那几行在**进群之前**被拦下并留痕）。
        if (String(rendered.internalNotes ?? '').trim()) {
          chainBlock = chainBlock
            + '\n\n【★ 我的查证笔记 —— **只用来回答对方的追问**。'
            + '它**不上卡、不进报告**：这一轮的回复里**一个字都不许出现**'
            + '（要转述的只有上面那一块）。】\n'
            + String(rendered.internalNotes).trim()
            + '\n【★ 查证笔记结束】';
        }
      }
    } catch (e) {
      dual = null;
      if (videoPending) {
        const reason = `视频审查结果处理失败：${String(e?.message ?? e)}`;
        videoCompletion = { ...videoCompletion, incomplete: true, completed: false,
          reason, refusal: `本轮视频审查未完成：${reason}。暂时不能据此放行。` };
        refreshMediaCompletion();
        inbound.videoGateReason = reason;
      }
      if (mediaCompletion.incomplete) {
        console.log(`[agent] ⚠️ ${mediaKind}审查未完成，保留拒答：` + (e?.message ?? e));
      } else {
        console.log('[agent] ⚠️ 双轨没跑成，回落单轨（结论仍由链给）：' + (e?.message ?? e));
      }
    } finally {
      // 完整性检查或合并抛异常时也必须删除本轮临时原图、视频帧。
      _imgCleanup();
    }
  }
  console.log(`[agent] 🧭 送审链返回：${chainRan ? '跑成' : '没跑成'}｜${chainMs}ms`
    + `${chainRan ? '' : `｜${String(res?.error).slice(0, 120)}`}`);

  // ── 6.0 **每一个评审任务都必须落表**（Owner 2026-10-05 定的硬规矩）
  //
  // ★ 这一条**不能只写在提示词里**：那天送了四条，链跑完 3.5~17.9 分钟，
  //   表里一行都没有 —— 因为链自己的发布条件是「有**三态结论**才发」，
  //   拒答（NEEDS_INPUT）整单被跳过。于是「审过了、结论是拒答」在盘上零痕迹。
  //   现在这段代码是那条规矩的执行点：**链发了就用它那一行（补空字段），没发就我们建一行**。
  //   判据是「表里到底有没有这一行」，不是「链说它发了」。
  let publish = null;
  // ★ 2026-10-09：结论与它对应的表内状态要**活到 `try` 之外** ——
  //   落表读数（下面 `reviewGate.publishFactBlock`）要把它们一起交给模型。
  //   原先 `conclusion` 声明在 `try` 里，出了这个块就取不到（TDZ/作用域），
  //   于是「表里那一行是什么结论」只有表知道，**回话的那一侧看不到** ——
  //   而看不到就会猜（那一张卡就是这么来的）。
  let publishConclusion = null;
  let publishStatus = null;
  let reviewFailure = null;
  const { visualGate, imageWorkflowGate, imageEvidenceReason,
    imageUnresolvedGate, sceneFaults } = imageCompletion;
  const visualGateRefusal = mediaCompletion.refusal;
  if (mediaCompletion.incomplete) {
    chainBlock = `【本轮${mediaKind}审查未完成】${mediaCompletion.reason}。
${visualGateRefusal}`;
    if (imagePending) inbound.imageGateReason ||= mediaCompletion.reason;
    if (videoPending) inbound.videoGateReason ||= mediaCompletion.reason;
  }
  try {
    // ★ 结论与两个必录读数**先算好**（`machineNumbers` 需要结论才知道该用哪条口径说明）。
    const chainConclusion = reviewPublish.conclusionOf(res?.answer) ?? (chainRan ? null : 'NEEDS_INPUT');
    // ★★ 表行的结论**必须与用户看到的卡同源**（2026-10-07 实测缺陷）：
    //   卡里写的是**双轨合并后的结论**（`dual.rendered`），而表里原先写的是**链的结论**
    //   （`conclusionOf(res.answer)`）—— 两条来源不同 ⇒ 当天五条**五条都对不上**：
    //     A 表 NEEDS_INPUT ↔ 卡 REVIEW；C 表 BLOCK/3 ↔ 卡 REVIEW/2（**红线在表里是 BLOCK、
    //     在人手里是 REVIEW**）；D 表 PASS ↔ 卡 REVIEW；E 表 NEEDS_INPUT ↔ 卡 REVIEW。
    //   ⇒ 卡里出的是合并结论时，表行就跟它走（`拒答` 落表写作 `NEEDS_INPUT`）；
    //     卡里没出合并结论（模型侧没报东西、回落链条那一段）就仍用链的结论 —— 两者恒一致。
    const mergedConclusion = dual?.rendered || (dual?.kbSide?.coverageGap && dual?.merged?.items?.length === 0)
      ? (dual.state === '拒答' ? 'NEEDS_INPUT' : dual.state)
      : null;
    let conclusion = mediaCompletion.incomplete ? 'NEEDS_INPUT' : (mergedConclusion ?? chainConclusion);
    // Owner-confirmed policy: coverage_not_covered records the KB gap, while a
    // completed image review with no substantive findings retains merged PASS.
    // Actual execution/parse failures remain blocked by the completion gates.
    // ★★ 2026-10-22（Paruu 真单）：**链跑成了、但结论行解析不出 ⇒ 绝不留在 PASS**。
    //   病灶：链写的是 `**本 skill 分级结论（4A＋4B＋…）**：**REVIEW**`，而 `conclusionOf`
    //   那时只认「结论」后**直接**跟冒号 ⇒ 返回 null ⇒ 这一格不写 ⇒ 表行停在**链自己写的
    //   PASS**，而卡片是 REVIEW（同一单两个结论，且错的那一侧是放行态）。
    //   现在解析器已加「分级/合并结论」优先；这一条是**兜底**：
    //   解析不出就按 NEEDS_INPUT 记（与「库侧没读数不许 PASS」同一条单向闸 ——
    //   PASS 是唯一不可挽回的错，读不懂结论时更不许放行）。
    let conclusionUnparsed = false;
    // ★ 回滚开关：`SHOUHENG_CONCLUSION_STRICT=0` ⇒ 关掉这条 fail-closed（应急回滚用）。
    //   ⚠️ 关了它就回到「解析不出 ⇒ 不写结论 ⇒ 行停在链的 PASS」那个放行缺口，**不建议**。
    const conclusionStrict = String(process.env.SHOUHENG_CONCLUSION_STRICT ?? '1').trim() !== '0';
    if (conclusionStrict && chainRan && !conclusion) {
      conclusion = 'NEEDS_INPUT';
      conclusionUnparsed = true;
      console.log('[agent] 🚫 链跑成了，但结论行解析不出（没有可识别的「分级/合并结论：X」'
        + '或「【审查结论：X】」）⇒ 本单按 NEEDS_INPUT 记，不许停在 PASS');
    }
    // ★★ 2026-10-07 加（Owner 同意）—— **库侧没有读数 ⇒ 不许落 PASS**。
    //   为什么（实测，不是假设）：素材「这条社媒文案能不能发：这批婴幼儿用品的文案里写了医用级」
    //     （表行 `recvxlAvpEWMIX`）旁挂没读到 ⇒ 库侧**一个读数都没有**，
    //     而这一行落的是 `Agent 结论=PASS` / `状态=PASS` / `问题数量 0` / `置信度 0`。
    //     同一批另一条（旁挂读到了、`state=NEEDS_INPUT`）落的是 NEEDS_INPUT/待审 ——
    //     差别不在素材，在**有没有读数**。
    //   ⇒ 这条闸是**单向**的（只挡 PASS，不动 BLOCK/REVIEW/NEEDS_INPUT）：
    //     PASS 是唯一的「放行」态，也是唯一不可挽回的错（放出去的物料收不回来）。
    //     而且它**不新造判据**：库侧没读数时，链的结论本来就是 agent 自己写的话，
    //     而「未命中 ≠ 合规」是库的硬口径 —— 没读过库，凭什么说合规。
    const kbReadings = kbSideOf(res);
    const kbNoReading = chainRan && kbNoReadingOf(kbReadings);
    let passBlockedByNoReading = false;
    if (kbNoReading && String(conclusion ?? '').toUpperCase() === 'PASS') {
      conclusion = 'NEEDS_INPUT';
      passBlockedByNoReading = true;
    }
    reviewFailure = reviewFailureOf(res, {
      withheld: conclusion === 'NEEDS_INPUT', unparsed: conclusionUnparsed,
      missingReadings: kbNoReading, imageCompletion, videoCompletion,
    });
    const nums = reviewPublish.machineNumbers(res, conclusion, dual?.mergedConf);

    // ── 产品线 / 渠道：**先 KB 命中记录，再素材原文兜底**（Owner 2026-10-06）─────────
    //   · 第一优先：命中记录里的 `品线`/`平台`/`渠道/市场`
    //     （P0 快路 ⇒ `res.product_line`；评审链 ⇒ 机读旁挂的 `facets`）
    //   · 兜底：**素材原文**里逐字命中库内受控词 —— 图片/视频那类没有规则命中时，
    //     这是唯一诚实的来源（词表与判据全在库内 `kb/l5/l0_facets.py`，这里只转发）
    //   · 都取不到 ⇒ **空**（不写「未指定」充数，也不让模型猜：
    //     表里那格曾被写进整段视频读数）
    let productLine = String(res?.product_line || res?.review?.facets?.product_line || '').trim();
    let channel = String(res?.channel || res?.review?.facets?.channel || '').trim();
    if ((!productLine || !channel) && input.text) {
      const fb = await facetsFromMaterial(input.text);
      if (!productLine && fb.product_line) productLine = fb.product_line;
      if (!channel && fb.channel) channel = fb.channel;
    }

    // ── 汇总列（顺序语句，不再用三元套三元）──────────────────────────────────────
    //   ★「不许自相矛盾」的老账都在这儿：P0 命中**不许**写「链已跑完」（它根本没跑链）；
    //     拒答**必须**写原因码（否则看表的人不知道是库的缺口还是调用方的缺口）。
    let summaryText;
    if (imageUnresolvedGate) {
      // ★ 2026-10-21（Owner 批准 P0）：**图没进来就不出结论** —— 卡上要写清楚为什么，
      //   否则人会把它读成「这次没问题」。同时点名该怎么办（重发图）。
      summaryText = `这条消息**带了图，但一张都没解析出来**（${String(inbound?.imageIntent?.why ?? '原因未知')}）`
        + '⇒ 本单**不收结论**：图没进来时 `--content-type` 会退化成 `text`，'
        + '而那样「负面样本规则」那一层**整层不跑** —— **零条不是没问题**。'
        + '请把图**重发一次**（图片消息，不要用文件方式发），本单随即重跑。';
    } else if ((visualGate && !visualGate.ok) || (imageWorkflowGate && !imageWorkflowGate.ok) || sceneFaults.length) {
      // ★ 图片 skill 任一环节未交付：「缺项不收」且直接替换最终回话，不允许旧三态从 chainBlock 漏出。
      const imageGateReason = [visualGate, imageWorkflowGate].filter((g) => g && !g.ok)
        .map((g) => g.reason).filter(Boolean).join('；');
      // ★ 2026-10-22：**画面读数没读到**是另一条缺口 —— 它不在视觉清单里（清单可以是全「未测」），
      //   所以必须单独写进这一格，否则表里只写「视觉核对没交全」，读的人会以为是对方报告的问题。
      const sceneReason = sceneFaults.length
        ? `画面读数没读到（${sceneFaults.map((f) => `${f.index ? `图 ${f.index} ` : ''}${f.why}`).join('；')}）`
        : '';
      summaryText = `链已跑完（${Math.round(chainMs / 1000)}s），但图片完整性检查未通过 ⇒ 本单不收结论：`
        + `${[imageGateReason, sceneReason].filter(Boolean).join('；')}。`
        + '（判据：完整执行图片安全审查的审核范围、视觉与 OCR、主张拆分、4A 规则符合性、4B 事实准确性、图文一致性，以及五类视觉事实；'
        + '「有」要带依据、「未测」要带原因；画面读数没读到 ⇒ 画面事实只能是未测，不许拿 OCR 文字冒充。'
        + '加载了 skill ≠ 完成了全流程。）';
    } else if (!chainRan) {
      summaryText = `链**没跑成**（${String(res?.error ?? '未知原因').slice(0, 300)}）—— 本行是为了留痕：`
        + '这一单**没有结论**，不是「没问题」。';
    } else if (res?.p0_fastpath) {
      // ★ P0 命中时**不许**再写「链已跑完」—— 它根本没跑链。这是行内自相矛盾的来源之一。
      summaryText = `**P0 快路**（确定性匹配，${res.p0_fastpath.elapsed_ms} ms ｜ 命中 `
        + `${res.p0_fastpath.matched_patterns} 条 P0 模式`
        + `${res.p0_fastpath.rule_codes?.length ? `：${res.p0_fastpath.rule_codes.join('、')}` : ''}）。`
        + '**未跑** L4→L5→L6→L7 层前置与评审链；置信度按 **1.0** 记'
        + '（= 确定性命中，PRD §6.6：P0 不适用置信度分流）。'
        // ★ 报告成没成，这一格里要看得见（Owner 2026-10-06「补充报告」）。
        //   没成时**写明原因**，不写「待生成」那种含糊话 —— 那句话读起来像"马上就有"。
        + (res?.report
            ? ` 报告：${res.report}`
            : ` 报告：**未生成**（${String(res?.report_detail ?? '未给原因').slice(0, 200)}）`);
    } else if (res?.review?.refusal) {
      // ★ 2026-10-05（Owner 裁定「建议1」）：**拒答必须在表里说明为什么**。
      //   原因码与读数都是**引擎自己算的**（`with_kb_evidence.py` 拒答分支），这里只搬不算。
      // ★ 2026-10-07 修：原先条件写的是 `refusal.reason_code` —— 而**供给链超期那类拒答的
      //   `refusal` 里没有 `reason_code`，只有中文 `reason`**（实测 E 单）。于是这类拒答
      //   掉进下面那条「链已跑完…结论原文见对话与报告」的兜底话术里 —— **一句听起来像
      //   正常结论的话**。现在只要求 `refusal` 存在，原因码与原因哪个有写哪个。
      const rf = res.review.refusal;
      summaryText = `链已跑完（${Math.round(chainMs / 1000)}s）。**未能得出结论**（${conclusion ?? 'NEEDS_INPUT'}）`
        + (rf.reason_code ? `｜原因码 \`${rf.reason_code}\`` : `｜原因 \`${String(rf.reason ?? '未给').slice(0, 60)}\``)
        + (rf.human ? `：${rf.human}` : '')
        + (rf.coverage?.top_hit_anchor
            ? `｜Top 命中 ${rf.coverage.top_hit_anchor}` : '');
    } else if (kbNoReading) {
      // ★ 2026-10-07（Owner 同意）：**库侧没读数**这一格必须自己说清楚 ——
      //   原先它会掉进下面那条「链已跑完…结论原文见对话与报告」的兜底话术，
      //   **那句话读起来像一次正常结论**（实测素材 D 就是这么落表的）。
      summaryText = `链已跑完（${Math.round(chainMs / 1000)}s）。**本单知识库侧没有读数**`
        + '（没跑到引擎 ／ 机读旁挂没落 —— 库忙、层闸门红、或没走 `review_run.sh`）⇒ '
        + '**本次没有知识库三态结论**：本行只作留痕，**不得当通过依据**。'
        + (passBlockedByNoReading
            ? ' ⚠️ 链原文里出现 PASS，**已按闸门改记「未判」** —— 没读过库就不许放行（库口径：未命中 ≠ 合规）。'
            : '');
    } else if (conclusionUnparsed) {
      // ★★ 2026-10-22（Paruu 真单）：链的回答里结论写法不在解析范围内 ⇒ 这一格必须说明，
      //   并且**不能**回落成「结论原文见对话与报告」—— 那句话读起来像一次正常结论，
      //   而实际是「读不懂结论」，比没写更危险。
      summaryText = `链已跑完（${Math.round(chainMs / 1000)}s）。**链的结论行解析不出**`
        + '（回答里没有可识别的「分级/合并结论：X」或「【审查结论：X】」写法）'
        + ' ⇒ 本单按 **NEEDS_INPUT** 记，**不得当通过**；结论原文见对话与报告。';
    } else if (conclusion && res?.review?.state
               && String(res.review.state).toUpperCase() !== String(conclusion).toUpperCase()) {
      // ★★ 2026-10-22（BM04/BM01 真单）：**引擎读数与最终结论不一致时，这一格必须说出来**。
      //   病灶：链的引擎给 PASS（0 条 / 0.93），链自己的 skill 合并却判 REVIEW（库侧无覆盖），
      //   而这一格原先只写「结论原文见对话与报告」—— 读表的人看到「0 处 + REVIEW」，
      //   没有任何东西告诉他这两个数为什么不一样（实测那一行就是这么落表、也是这么被误读的）。
      //   ⚠️ 不在这里解释原因：覆盖判据是链判的，我们只搬读数（**只搬不算**），
      //     只写「有差」与「以谁为准」；原因在对话与报告里。
      summaryText = `链已跑完（${Math.round(chainMs / 1000)}s）。**引擎读数 ${String(res.review.state).toUpperCase()}**`
        + `（问题 ${res.review.issue_count ?? '—'} 处 ／ 置信度 ${res.review.confidence ?? '—'}），`
        + `**最终合并结论 ${conclusion}** —— 两者不一致，**以最终结论为准**；`
        + '差异原因与逐条见对话与报告。';
    } else {
      summaryText = `链已跑完（${Math.round(chainMs / 1000)}s）。结论原文见对话与报告；`
        + '本行由守衡在链返回后核对落表。';
    }
    // ★★ 2026-10-09 **口径统一（Owner 裁定）**：表里「问题数量」改成**卡里那个合并总数**。
    //
    //   原口径（2026-10-07 起）：表里记**库侧机器读数**，卡里是并集上限 ⇒ 两者恒不同，
    //   差额写在这一格里。Owner 看过两轮（卡 7 处 / 表 5）后定为「统一成卡里那个数」：
    //   同一个数在三个地方（卡片抬头、报告门槛 PRD §5.3.4 的 ≥3、表列）必须是**同一个**，
    //   否则人拿着表去对卡永远对不上。
    //   ★ 库侧那个读数**不丢**：它原样留在下面这一格里（「库侧 N 条（机器读数）」），
    //     差从"看不见"变成"看得见且同一个数"。
    //   取值来源仍是 `dual.rendered.total`（PRD §5.3.4 报告门槛读的也是它）——
    //     拿不到合并数（没跑双轨 / 模型侧没报东西）时**回落**库侧读数，行为与改动前逐字相同。
    if (dual?.rendered) {
      const cardTotal = dual.rendered.total ?? null;
      if (Number.isFinite(cardTotal)) {
        summaryText += `｜双轨合并：卡内总数 **${cardTotal} 处**（库侧 ${dual.kbSide?.issueCount ?? '—'} 条机器读数`
          + ` ＋ 模型侧 ${dual.model?.findings?.length ?? 0} 条，重叠未判）；`
          + `**本列「问题数量」按卡里那个数记**（Owner 2026-10-09 定）——`
          + `与库侧机器读数不同时，差在模型侧那几条「无库内依据」的条目上。`;
      }
    }
    // ★★ 2026-10-16（Owner 亲口：「**把多余口径删除**」）——**口径不再进这一格**。
    // ──────────────────────────────────────────────────────────────────────────
    //   这一格只放 PRD §5.3 的「审查结论」块（Owner 2026-10-15 的裁定，判据 `test_agent` V6
    //   早就断言了「`⚠️` 不许进这一格」）—— 而**代码里还留着两条会写它的路**，
    //   于是判据与行为分家：V6 走的是有合并块那条路（不经过这里）⇒ 一直是绿的。
    //   存量代价实测（Owner 2026-10-16 看到的那 12 格）：我 10-15 亲手挂上去的
    //   「⚠️ 口径：本格 0 ＝ 没有可用的置信度…」**留在了格子里**（10-09 那句
    //   「口径必须跟数一起进表」已被 10-15 的裁定取代，存量没清）。
    //   ⇒ 现在两条都撤：① 置信度口径（`nums.note`）；② 产品线/渠道为空的原因说明。
    //     **信息不丢**：改走**运行日志**（下面那行 `📌 口径`），要查的人查得到，
    //     读表的人不会再在一格里读到两套东西。台账侧另有 `confidence-merged.ndjson`。
    if (nums.note || !productLine || !channel) {
      const miss = [!productLine && '产品线', !channel && '渠道'].filter(Boolean).join('、');
      console.log('[agent] 📌 口径（**不上表**：这一格只放 PRD §5.3 块）：'
        + [nums.note, miss ? `${miss}：库内命中记录与素材原文都没有 ⇒ 留空，需人工补` : null]
            .filter(Boolean).join(' ｜ '));
    }

    // ★ 2026-10-09：**在落表之前**把「这一行会写什么结论/状态」记下来 ——
    //   落表读数（下面那段）要连着结论与状态一起交给模型，缺了哪一个都会让它去猜。
    publishConclusion = conclusion;
    publishStatus = reviewPublish.statusOf(conclusion);

    // ★★ 2026-10-16（Owner）：**「送审问题」这一格只写对方原话 ＋ 媒材链接**。
    //   `input.question` 是拼给模型看的那一轮（含我们的探针与 OCR 全文）——
    //   写进表就是**内部指令外发**（实测 200 行里 54 行如此）。
    //   `awaitLinks` 有界等待：上传没在时限内成 ⇒ 这一格只留原文（**未测**，不是「没有媒材」）。
    const { media: mediaLinks } =
      await runBeforeDelivery(() => mediaLink.awaitLinks(linksP, { log: (s) => console.log(`[agent] ${s}`) }));
    const rowQuestion = mediaLink.questionForRow({
      // `input.question` is the normalized image-review task sent to the chain;
      // keep the original user turn for the rare caller that omitted userText.
      userText: userText === undefined ? question : userText,
      media: mediaLinks,
    });

    publish = await runBeforeDelivery(() => publishRunner({
      contentId: reviewPublish.contentIdOf(input.text),
      question: rowQuestion,
      contentType: gate.kind === 'media' ? '图片/视频' : (gate.kind === 'link' ? '链接' : '文字'),
      conclusion,
      // ★ 2026-10-06 **重定口径**（Owner 现场：「置信度**和问题数量不允许为空**」；
      //   并指出「这些问题昨天修复过了，今天又复现了」——昨天那次（10-05）修的是
      //   「引擎给了值却没传出来」，**没修「引擎不给值时留空」**，于是今天原样复现）。
      //   ⇒ 现在走 `reviewPublish.machineNumbers()`：**永不为空**，且填了数就**同时填口径**
      //     （口径拼进下面的 `summary`，看表的人不必来问）。详见那个函数的注释。
      //   取值来源仍是**只搬不算**：P0 ⇒ 快路带出；链 ⇒ 机读旁挂（原样搬自引擎 JSON）。
      //
      // ★★ 2026-10-09 口径统一（Owner 裁定）：**卡里那个合并总数优先**。
      //   理由与写法见上面 `summaryText` 那段注释：同一个数在卡片抬头、PRD §5.3.4 的
      //   ≥3 门槛、以及这一列必须是同一个。拿不到合并数时回落 `nums.issueCount`
      //   （= 改动前的行为，逐字未变）。
      issueCount: mediaCompletion.incomplete ? 0 : (Number.isFinite(dual?.rendered?.total) ? dual.rendered.total : nums.issueCount),
      confidence: nums.confidence,
      // ★ 产品线 / 渠道（2026-10-06）：Owner 要求「从知识库命中产品线和渠道的都填写进去」。
      //   · P0 快路 ⇒ `res.product_line` / `res.channel`（`kb/l5/p0_fastpath.py` 从命中记录取）
      //   · 评审链   ⇒ `res.review.facets`（机读旁挂里由 `kb/l5/l0_facets.py` 取，同一个取数点）
      //   **取不到就是空 ⇒ 不写这一格**：不写「未指定」充数，也不从素材正文猜
      //   （表里已经出现过一次脏数据：产品线那一格被写进整段视频读数）。
      productLine: productLine || null,
      channel: channel || null,
      // ★ 报告链接（2026-10-06，Owner「补充报告」）——
      //   PRD §8.2 把「报告链接」列为字段、§8.3 要求问题数 ≥3 时填。
      //   此前**这一格从没被传过**（`rowFieldsOf` 早就支持 `reportUrl`），于是 4 行全空 ——
      //   包括那条 REVIEW/3：报告条件明明满足，链接却没人送过来。
      //   取值：P0 快路 ⇒ `res.report`（`tools.mjs` 建完云文档带出）；
      //         评审链   ⇒ 发布件自己写（它 upsert 同一行，不走这里）。
      //   **空就是空**：没建成不许写占位符 —— 一个点不开的链接比空格更坏。
      //
      // ★★ 2026-10-09 补第三处来源（实测空档）：**本仓建的「双轨合并报告」**。
      //   10-09 15:28 那一单（`recvxxfQoRewaF`／AD-20261009-028）实测：卡内 3 处 ⇒
      //   本仓建了合并报告、URL 也进了卡片（`dual.reportUrl` → 信封的 `reportLink`），
      //   而**表里「报告链接」是空的** —— 因为这一格只认 `res.report`（链侧那份），
      //   而链侧那单只有 1 条、达不到它自己的 ≥3 门槛。
      //   ⇒ Owner 的原话是「把能填的都填了」（2026-10-05），卡里有的链接表里也得有。
      //   ★★ 2026-10-09（Owner：「这 3 个要改成一致的」）**顺序反转** ────────────────
      //   病灶（实测 2026-10-09 16:24 那单，逐字可核）：
      //     卡上链接 = `docx/M7DbdQUvbopAkmxGdsRccGstnTg`（**本仓合并报告**）
      //     表里链接 = `docx/Y2Gxd8BAbonVKrxgPWQcKkwRneb`（**库侧那份**）
      //     ⇒ **同一单两份文档、两个链接**。成因有两层：
      //       ① 这一行的回落顺序把**链侧那份**排在前面，而链侧 `with_kb_evidence`
      //          只在**它自己** ≥3 时建文档（本单库侧正好 5 条 ⇒ 建了）；
      //       ② 链侧建完是把 URL **直接 upsert 进这一行**的，而它跑在守衡落表**之后**
      //          ⇒ 本仓写进去的合并链接被它**覆盖**。
      //     ⇒ 两层一起修：这里**合并报告优先**；`kb_review_chain` 另有一处配套
      //       （`SHOUHENG_OWN_REPORT`：本仓会建报告时，**不让链侧再建它自己那份**）。
      //       「一单一个数、一个链接」——库侧那份只装库侧条目，不是卡上那一份。
      reportUrl: mediaCompletion.incomplete || conclusion === 'NEEDS_INPUT'
        ? null : (dual?.reportUrl || String(res?.report ?? '').trim() || null),
      clearReportUrl: mediaCompletion.incomplete || conclusion === 'NEEDS_INPUT',
      // ★ 汇总改成**顺序语句**（2026-10-06）—— 原来是「三元套三元再拼字符串」，
      //   往里加一句口径就写出语法错（实测：`node --check` 报 `Unexpected token ')'`，
      //   而我把 `node --check … | head` 的退出码当成了通过：**管道会吞掉退出码**）。
      //   同一段文字要能被下一个人读懂并安全地改，就别用括号杂技。
      // ★ 2026-10-13（Owner）：「模型侧输出问题必须带依据的 url，**这个要落库**」——
      //   卡上会滚走、报告要另点一次，而**表是这一单最长寿的那份记录**。
      //   依据不进表，等于它没被留住。逐条一行、只列**有依据**的条目（见 `evidenceBlock`）。
      //   ⚠️ 条目在 **`dual.merged.items`**（不是 `dual.items`）—— 我第一版写的就是 `dual.items`，
      //     传进去一个 `undefined`，于是依据块**永远是空**，而日志、卡片、表行都不会报错。
      //     接线判据见 `test_agent.mjs` 的「逐条依据必须接在**真的条目数组**上」。
      //
      // ══════════════════════════════════════════════════════════════════════════
      // ★★ 2026-10-15（Owner 裁定）：**这一格改成 PRD §5.3 的摘要块** ────────────────
      // ══════════════════════════════════════════════════════════════════════════
      //   Owner 原话（两条）：
      //     ① 「80 条的分类问题汇总，直接按照 prd 的要求出问题分类汇总，**覆盖**飞书文档中旧汇总，
      //         不用新建字段」（要的是 PRD §5.3.2/§5.3.3 那三样：结论行 · 分类汇总 · 报告链接）
      //     ② 「模型侧输出问题必须带依据的 url，这个必须要有，**命中知识库侧的也是要带依据的 url**」
      //   ⇒ 一格装两样，顺序即优先级：**PRD 块在上**（人先看到摘要），依据块在下（可回源），
      //     口径说明（⚠️ 那两句）压尾。
      //   ★ 复用**卡片那一份** `dual.rendered.block` —— 它与群里的卡**逐字同源**，
      //     所以 PRD 要的四样（结论行／分类汇总／报告链接／动作行）一个字都不用在这儿重写，
      //     也就不会有第二份口径（本库因为「同一个东西两个产出者」栽过多次）。
      //   ⚠️ 已知缺口（照实写着，别以为已经覆盖）：**模型侧没报东西**时 `rendered` 为 null
      //     （`renderMerged` 那一支要求「有可并的条目」），这一支仍走老写法 `summaryText`。
      //     要把它也 PRD 化，得把 `verdict53`（PRD 结论行）的取值点提到这之前 —— 见
      //     `PMO/` 的待办记录，不在本次改动里硬凑。
      //     原先这里内联一份，卡片那边另一份，正是这一格「同一单两个长相」的来源（FIX-018）。
      // ══════════════════════════════════════════════════════════════════════════
      // ★★ 2026-10-15（Owner）：「**这一格只放 PRD 的『审查结论』块，不要自己加其他内容**」──
      // ──────────────────────────────────────────────────────────────────────────
      //   格式（Owner 给的逐字样例）：
      //     【审查结论：BLOCK】共发现 9 处必须修改。
      //     逐条问题
      //     · 合规类问题：2 个 …
      //     · 另有 3 条（明细在报告里）
      //     → 查看完整问题清单与修改建议：<报告链接>
      //     请修改后重新提交。
      //   ⇒ 直接给**卡片那一份** `dual.rendered.block`（逐字同源 ⇒ 同一单不会有第二种长相）。
      //   此前挂在这一格里的三样**全部撤掉**（它们不是 PRD 要的内容）：
      //     · 【逐条依据（落库留痕）】（带 url）—— 依据在报告里（PRD 的设计＝摘要 ＋ 钻取报告）；
      //     · 「双轨合并：卡内总数…」读数句 —— Owner 2026-10-13 已定这类口径读数不上卡，
      //       同一条理由对表也成立（表与卡是同一条结论的两个落点）；
      //     · ⚠️ 置信度 / 产品线·渠道的口径说明 —— 置信度有它自己那一列。
      //   ⚠️ 与旧裁定（2026-10-09「口径必须跟数一起进表」）冲突 ⇒ **以本条为准**；
      //      行为判据 `test_agent.mjs` 的 V6 已随之改写（原版要求格里有「库侧 N 条机器读数」）。
      summary: (() => {
        if (mediaCompletion.incomplete) return `本轮${mediaKind}审查未完成：${mediaCompletion.reason}。未形成可发布结论；问题数量与置信度的 0 表示未定，不代表零风险。`;
        const block = String(dual?.rendered?.block ?? '').trim();
        if (block) return block;
        // 模型侧没报东西 ⇒ 没有 `rendered.block`，但这一格仍要是 PRD 形状：
        //   结论行取「合并态派生」或「链自己的答案」；两处都没有（拒答/未判）才回落旧写法。
        const count = Number.isFinite(dual?.rendered?.total) ? dual.rendered.total : nums.issueCount;
        const line = deriveVerdictLine({ mergedState: conclusion, mergedCount: count })?.line
          || deriveVerdictLine({ answer: String(res?.answer ?? '') })?.line || '';
        return line || summaryText;
      })(),
    }, { since: t0 - 1000,
         // ★★ 2026-10-16：认旧行用的问句**必须与写进去的那一份同形** ——
         //   `ensureReviewRow` 是拿它和表里那格的「送审问题」做包含比较来认行的
         //   （见那里的 `sameQ`）。以前写的就是 `input.question`（含探针与 OCR 全文）；
         //   现在格子里写的是 `rowQuestion`（原文＋链接）⇒ 这里若还传 `input.question`，
         //   多轮送审时会**认不出上一轮自己写的那一行**，退到内容 ID 兜底、
         //   兜不住就新建一行（同一单两行，正是那一类最难查的脏数据）。
         question: rowQuestion,
         // ★★ 2026-10-22（BM04/BM01 真单）：**把链的内容 ID 也交给落表** ——
         //   链与我们的内容 ID 算法不同（链 `AD-20261022-021` / 我们 `AUTO-<sha>`），
         //   问句也不同；只按这两样认，链自己建的那一行**认不出来** ⇒ 新建第二行
         //   ⇒ 同一张图两行、两个结论（链行 PASS ／ 守衡行 REVIEW）。
         //   值取自机读旁挂 `res.review.content_id`（只搬，不猜）。
         chainContentId: String(res?.review?.content_id ?? '').trim() || null,
         ctx: publishContext }));
    console.log(`[agent] 🧭 落表：${publish?.ok ? publish.action : '失败'}`
      + `｜table=${publish?.table_id ?? '（未选择）'}`
      + `${publish?.record_id ? `｜${publish.record_id}` : ''}`
      + `｜回读=${publish?.readback ?? '（未回读）'}`
      + `${publish?.ok ? '' : `｜${String(publish?.detail).slice(0, 140)}`}`);
  } catch (e) {
    console.log(`[agent] ⚠️ 落表抛异常（不影响回话）：${e?.message ?? e}`);
  }

  // ── 6.1 **把落表读数交给模型**（2026-10-09）
  //
  // ★ 病灶（Owner 拿着截图来问的那张 alert 卡）：那一单链停在 L6 闸门红，
  //   **表其实落了行**（`recvxwCWhwCO68`／状态=待审），而卡片上写着
  //   「飞书表也没落这一行（拒答档）」—— **与盘上事实相反**。
  //   根因不在模型：`chainBlock`（它唯一看得到的读数）在链返回时就定稿了，
  //   而落表**发生在那之后**，读数从没进过它的上下文 ⇒ §2.4.1
  //   「读数是空的，模型就用猜的填」。修法与 §2.4.4/§2.4.5 同一条：
  //   **把判据放到接线里** —— 读数由代码产出、随 `chainBlock` 一起交出去，
  //   模型只剩「照抄」这一条路可走。
  // ★ 位置必须在 `buildUserTurn` **之前**：那个调用在下面 `return` 里，
  //   而 `chainBlock` 是它唯一的输入来源。
  chainBlock = chainBlock
    ? `${chainBlock}\n\n${reviewGate.publishFactBlock(publish, { conclusion: publishConclusion, status: publishStatus })}`
    : reviewGate.publishFactBlock(publish, { conclusion: publishConclusion, status: publishStatus });

  // ★★ 2026-10-12 19:40（**Owner 现场指示：马上恢复**）——
  //   `p0ShortReplyBlock(res)` 的拼接**已停用**，这一路回到 17:54 之前的行为。
  //
  //   证据（两条都是 `PMO/logs/ws_outbound.jsonl` 的原文，同一条送审单、同一路 P0 命中）：
  //     · 16:58（停用前的样子，1336 字）：两轨计数行「知识库侧 1 条 ＋ 模型侧 1 条 ＝ 本卡 2 处」
  //       ＋ 逐条明细（原因/依据/建议/判定）＋ 页脚「本结论为 P0 红线拦截…」—— 三样都在。
  //     · 19:31（拼接生效后的第一条，309 字）：上面三样**全没了**，取而代之的是
  //       「命中：P0 模式 H05｜条款 **W-1.33**｜逐字命中…」「边界：P0 快路，**未跑** L4→L5→L6→L7…」
  //       「表行：`recvxBEbetGBmm`」—— 条款号、流水线层名、飞书行号都是**内部标识**。
  //   19:31 那张卡与指令**逐条对得上**（保留结论行/模式与条款号/报告链接、不展开明细、309 ≤ 300 字）
  //   ⇒ 这**不是代码写错了，那就是这条指令要的产物**；Owner 不要这个产物。
  //
  //   ⚠️ 常量与纯函数 `p0ShortReplyBlock` **保留**（`tools/agent/p0_short_reply.test.mjs` 在测它们），
  //      但**接线没了 ⇒ 这个功能当前不生效**。要重启这条线，先解决两件事：
  //        ① 「短」不该以丢掉卡面结构为代价（两轨计数行是 Owner 反复要求过的那个数）；
  //        ② 条款号 / 层名 / 飞书行号**不进群**（与「库内命中（读数）」同一个病）。
  //   {
  //     const shortBlock = p0ShortReplyBlock(res);
  //     if (shortBlock) chainBlock = chainBlock ? `${chainBlock}\n\n${shortBlock}` : shortBlock;
  //   }

  return {
    question: buildUserTurn({ questionText: question, chainBlock }),
    gate, chainBlock, chainRan, chainMs, publish,
    // 结论闸门必须支配最终回话，不能只改落表值。否则 dual.rendered / chainBlock
    // 仍可能把旧 REVIEW 摘要交给回复模型（真实事故：表=NEEDS_INPUT，飞书却发 REVIEW）。
    forcedReply: visualGateRefusal,
    // ★★ 2026-10-21（Owner：「P0 命中就直接先返回结论」「一条只回一条」）——
    //   **P0 确定性命中 ⇒ 这一轮不调模型**，回复正文＝这张卡自己的 §5.3 块。
    //
    //   依据（实测 70 单 P0 命中）：判定 p50 3.3 s 就完成，之后模型还要写 p50 2986 字 /
    //   p50 ~42 s —— 而那些字**一个字都不上卡**（`envelope.mjs`：评审单的卡面由代码定，
    //   模型自拟的分组/结论/正文一律不搬）。也就是说这 42 秒对人**没有任何增量**，
    //   PRD §6.3 那句「命中即停止后续审查」本来就不该让它跑。
    //
    //   取值就是卡上要印的那块（`dual.rendered.block`，逐字同源）；拿不到（双轨那一跳异常）
    //   就退回链自己的 §5.3 回执（`res.answer`，与 `p0_fastpath.py --json` 的 `rendered` 同源）。
    //   两处都没有才回 `null` ⇒ 那一轮仍会调模型（宁慢勿空）。
    p0DirectReply: p0Stopped
      ? (String(dual?.rendered?.block ?? '').trim() || String(res?.answer ?? '').trim() || null)
      : null,
    // ★★ 2026-10-26（Owner 第一性原理：「在飞书群 @ 守衡 能够在 3 分钟内返回审核内容」）：
    //   当送审链跑成（`chainRan`）且已产出完整的 PRD §5.3 结论行与结论块时，
    //   卡片 100% 由代码从 `verdict53` / `dual.rendered.block` 渲染，主模型在 Step 6 花 50~90 秒
    //   写的 3000~8000 字散文在 `envelope.mjs` 里会被全部丢弃（`dropProse = true`）。
    //   ⇒ 直接把合成好的 §5.3 结论块作为本轮回复并写入会话记忆（查证笔记已在 `turnContent` 落盘，
    //     后续追问照旧可答），立省 50~90 秒无意义空转！
    //   ⚠️ 仅当 `verdict53?.line` 且（`dual.rendered.block` 或 `verdict53.block`）齐全时启用；
    //      若链跑败、拒答或缺少结论块，仍保持 `null`，交由主模型在 Step 6 组织说明。
    reviewDirectReply: (!p0Stopped && !visualGateRefusal && chainRan && publishConclusion !== 'NEEDS_INPUT')
      ? (() => {
          const blk = String(dual?.rendered?.block ?? '').trim();
          if (blk && /【审查结论[：:]/.test(blk)) return blk;
          const v = deriveVerdictLine({
            answer: dual?.rendered?.block ?? res?.answer,
            p0Fastpath: res?.p0_fastpath ?? null,
            mergedCount: dual?.rendered?.total ?? null,
            mergedState: dual?.state ?? null,
          });
          if (v?.line && v?.block) return `${v.line}\n\n${v.block}`;
          if (v?.line && v?.state === 'PASS') return v.line;
          return null;
        })()
      : null,
    // 与链路暂时失败不同：完整图片审查本身未完成时，禁止后续回落复活旧三态。
    imageReviewIncomplete: imageCompletion.incomplete,
    videoReviewIncomplete: videoCompletion.incomplete,
    reviewDecisionWithheld: mediaCompletion.incomplete || publishConclusion === 'NEEDS_INPUT',
    reviewFailure: reviewFailure ?? reviewFailureOf(res, {
      withheld: mediaCompletion.incomplete || !chainRan, imageCompletion, videoCompletion }),
    videoCompletion,
    // ★ 2026-10-08：`dual` 必须**从这里出去** —— 它是「这一单双轨到底做了什么」的唯一读数，
    //   调用方（`handleMessage` 的 meta）与判据都要用。此前它只活在本函数的局部作用域里，
    //   外面拿不到 —— 于是 `Z1` 那条行为级断言连被测对象都取不到。
    dual,
    // ★ PRD §5.3 结论行的**权威出处**（2026-10-06 加）。
    //   为什么在这里算而不在发送层猜：这一层是**唯一**同时拿得到链原文与 P0 快路读数的地方，
    //   而结论行只许由链（或 P0 派生的那一行）说了算 —— 模型的措辞不参与这一格。
    //   拿不到就回 null（**不编**）：不是送审、链没给三态、拒答（5.3 不管这一态）都会回 null。
    // ★ 双轨合并**改写结论原文**时以它为准（dual.rendered 只在模型侧真报了东西时才非 null）
    //   —— 结论行与逐条块仍由这同一个 deriveVerdictLine 产出，分工没变：模型不写、代码搬。
    //
    // ★★ 2026-10-08/09：**抬头那个 N 改用双轨合并条数**（Owner 的规则：「双轨按照 PRD
    //   ≧3 个问题输出报告链接到飞书文档」）。
    //
    //   病灶（今天才定位到精确那一行）：`dual.rendered.block` 里的 §5.3 结论行是
    //   `renderMerged()` **照搬链的原文**，而合并条数只出现在条目列表里 ——
    //   **抬头与条目从来就没有共用过一个数**。实测三处打架（19:08 那张图：
    //   抬头 12 ／ 阈值读的旁挂 5 ／ 你实际看到 7 条）。
    //   而报告链接的门槛（PRD §5.3.4「问题数量 ≥3」）挂在这三个中的任何一个上，
    //   卡片与规则都会继续各说各的。
    //
    //   现在：抬头、逐条块、以及后面的报告阈值**读同一个变量** = 双轨合并条数。
    //   `deriveVerdictLine` 的第 ⓪ 支（`prd53.mjs`）在拿到合法条数时以它为准；
    //   拿不到（没跑双轨 / 合并 0 条 / 坏读数）就**退回抠链的正文**，行为与改动前逐字相同。
    verdict53: mediaCompletion.incomplete || publishConclusion === 'NEEDS_INPUT' ? null : withVideoAnalysis(deriveVerdictLine({
      answer: dual?.rendered?.block ?? res?.answer,
      p0Fastpath: res?.p0_fastpath ?? null,
      // ★★ 更正（2026-10-09）：**这里必须用 `rendered.total`，不是 `merged.items.length`。**
      //   两者的口径不同，而 `total` 才是卡里那个数：
      //     `total = 能并的条目 + kbGap（库侧有、但明细没并进来的） + covEntries（覆盖缺口那 1 条）`
      //   （`dual_track.mjs:1140`）。实测 19:08 那单：合并 7 ＋ 库侧未并进 5 = **12** ——
      //   那个 12 **不是**从链的正文里抠的，是 `total` 的正确读数，卡里另有一句
      //   「另有 5 条未并进本卡」。我第一版接成 `items.length`（=7）会**把「+5」丢掉**，
      //   并与卡里那句话自相矛盾 —— 那是个真回归，已改回。
      // ★★ 2026-11-03（真单 `20261103-160411` / `20261103-162321` 零发现那一档）——
      //   `renderMerged` 在「0 条且无覆盖缺口」时回 `null`，于是 `rendered?.total` 是 `undefined`，
      //   而 `verdictLineFor({state:'PASS', n:null})` **只认 n===0**（§5.3.1 那行本来就没有 N，
      //   0 是它的前提）⇒ 派生不出结论行 ⇒ `verdict53=null` ⇒ 信封层 `hasReadingNoLine`
      //   又把整单打成「审查未完成」告警卡。
      //   实测（真答案，不是夹具）：视频零发现那单 `conclusionOf` 已经能读出 `PASS`，
      //   但 `deriveVerdictLine(mergedCount=null)` 回 `null`、`mergedCount=0` 才回
      //   `【审查结论：PASS】未发现已知底线风险，可转交 … 进行 sign-off。`
      //   ⇒ 双轨**跑过**、只是没有条目可并时，卡里那个数就是 **0**（没有可并条目 ＋ 没有缺口），
      //     不是「不知道」。`dual` 整个没跑（没读数）时仍回 `null` —— 那才是「不知道」。
      mergedCount: dual ? (dual.rendered?.total ?? 0) : null,
      mergedState: dual?.state ?? null,
    }), dual?.videoAnalysis),
    // ★★ 2026-10-08 —— 这两行是**台账**（给日志与补发判据看），**不许把一条正常回复搞崩**。
    //   实测两个崩点（都在同一天的并行双轨改动里进来）：
    //     ① `dual: g?.dual ? …` —— `g` 在这个作用域里**不存在** ⇒ **每次闸门返回**都
    //        `ReferenceError: g is not defined`（`行为级·闸门`＋`子进程端到端`两条判据当场变红，
    //        而线上表现是「每条送审都没有回复」）。已改回 `dual`。
    //     ② `dual.merged.stats` 无保护 —— 链没跑成时 `dual` 在、`merged` 不在 ⇒
    //        `Cannot read properties of undefined (reading 'stats')`（`Z1` 变红）。
    //   ⇒ 台账字段一律**取值容错**：取不到就 `null`，宁可少一个读数，也不许抛。
    // ★★ 2026-10-08（第二轮）：**把库侧拒答的「原因码」带出去**。
    //   为什么非要它：下面 `chainUnmeasured` 要判「值不值得补发」，
    //   而「库忙（认领被占）」与「库里确实没有可依据的条款」在旧判据里**长得一模一样**
    //   （都是「没拿到三态结论」）⇒ 后者被反复补发：同一条最多重跑 5 次链、群里多 5 条回复，
    //   而**重跑一百次还是同一个答案**（它不是瞬态的）。判据要靠这个码，不能靠猜。
    dual: dual ? { state: mediaCompletion.incomplete ? 'NEEDS_INPUT' : dual.state, stats: dual.merged?.stats ?? null,
                   ok: dual.model?.ok ?? false,
                   model_ms: dual.model?.ms ?? null, overrode: !!dual.rendered,
                   // ★ 2026-10-15：**两侧合并后的置信度**必须从这里出去 ——
                   //   它是表行那一格的值来源（`machineNumbers(res, conclusion, dual.mergedConf)`），
                   //   不投影出去的话，daemon 的 meta/留痕读不到"这一单最后算出来是几"，
                   //   正是本仓治过的「改了但没人读」。库侧与模型侧两个档位**一并带出**，
                   //   好让事后能回答"这个数是被哪一侧拉低的"。
                   mergedConf: !mediaCompletion.incomplete && dual.mergedConf
                     ? { value: dual.mergedConf.value ?? null,
                         band: dual.mergedConf.band ?? null,
                         kb_band: dual.mergedConf.kb_band ?? null,
                         model_band: dual.mergedConf.model_band ?? null,
                         basis: dual.mergedConf.basis ?? null }
                     : null,
                   // 2026-10-09: 本仓建的那份合并报告的 URL —— daemon 拿它搬进卡片可见格
                   reportUrl: mediaCompletion.incomplete || publishConclusion === 'NEEDS_INPUT'
                     ? null : (dual.reportUrl ?? null),
                   // ⚠️ 2026-10-13：`p0Boundary` 那一格撤了 —— 卡脚边界整个不上卡
                   //   （Owner：「整个都隐藏，不要展示在卡片上」）。
                   //   它现在走 `renderMerged` 的 `internalNotes`（记忆侧），答得出来、不上卡。
                   // ★ 2026-10-09：**卡里那个「问题数」**（`rendered.total`）必须从这里出去 ——
                   //   它是 PRD §5.3.4 报告链接门槛（≥3）该读的那个数。
                   //   口径 = 能并的条目 ＋ 库侧未并进的（`kbGap`）＋ 覆盖缺口那 1 条，
                   //   **不等于** `stats.merged`（那个只是「并进来几条」，实测 19:08 是 7，而卡里是 12）。
                   total: mediaCompletion.incomplete ? null : (dual.rendered?.total ?? null),
                   // 库侧读数的**身份与原因**（取不到就 null，不许编）
                   kb: dual.kbSide ? { has_sidecar: dual.kbSide.hasSidecar === true,
                                       state: dual.kbSide.state || null,
                                       reason: dual.kbSide.reason || null,
                                       refused: dual.kbSide.refused === true,
                                       coverage_gap: dual.kbSide.coverageGap === true } : null,
                 } : null,
  };
}

/* ─────────────────── 主处理函数 ─────────────────── */

/**
 * 把「人问的话 + 图块 + 视频块」拼成**真正发给模型的那一轮**。
 *
 * ★ 为什么把它拆成一个**能被调用**的纯函数（2026-10-05 晚）：
 *   现场那次验收里，视频读到了（8/8 帧、51 字、音轨无人说话），
 *   但**回复是用另一条消息的那一轮生成的** —— 两条消息（先发视频、再单独发一句
 *   「审核下这个视频」）本来就是**两轮**，而「单独发一句」那一条没有 `parent_id`，
 *   按 §2.6 就不该去捞那条视频。人看到的却是「我拿不到那 51 个字」，很像接线断了。
 *   当时没有任何断言看得住这一跳 —— 第 15 组那条「必须走到模型那一侧」其实只走到
 *   `readInboundContent`，**名字比它验的事大**（§2.4.1）。
 *   现在这一跳有了名字、有了调用点，判据能真的走进去（第 16 组那条端到端）。
 */
/**
 * 这一轮**带了媒材、却没起链**吗？（纯函数，可被单测直接调用）
 *
 * ★ 为什么要有它（2026-10-05）：那次事故的表现就是「视频读到了、结论一个字没有」，
 *   而在盘上，这个形状**只是一行没有出现的日志** —— 没有任何东西会红。
 *   判据不能只写在人设里（那是**声明**）：这里把它变成一个**能被调用**的读数，
 *   由 daemon 在每一轮回复之后问一次，答「是」就打一行 `⚠`。
 *
 * @param {{media?:{images?:number,videos?:number}, toolTrace?:Array<{tool:string,ok:boolean}>}} meta
 * @returns {null|{media:number, tools:string[]}} 没起链时回读数，起了链（或本来就没媒材）回 null
 */
export function mediaWithoutChain(meta) {
  const m = meta?.media ?? {};
  const n = (m.images ?? 0) + (m.videos ?? 0);
  // ★ 2026-10-05 改：判据从「带了媒材」升级为「**闸门判成送审**」。
  //   闸门（内核自己跑的）会把该起链的那些先跑掉，所以这个函数现在的职责是**兜底**：
  //   闸门判成送审、却既没跑成链、模型自己也没补上 —— 那就是真的漏了，必须喊出来。
  const gateYes = meta?.gate?.yes === true;
  if (!n && !gateYes) return null;          // 既没媒材、闸门也没判送审 → 这条不适用
  const chain = meta?.chain ?? null;
  if (chain?.ran) return null;              // 闸门跑成了
  const trace = meta?.toolTrace ?? [];
  // 只认**成功**的那一次：`ok:false` 的链等于没跑成，那正是要说的另一种话。
  if (trace.some((t) => t.tool === 'kb_review_chain' && t.ok)) return null;
  return { media: n, gate: meta?.gate ?? null,
           chainTried: !!chain, chainOk: chain?.ran === true,
           tools: trace.map((t) => t.tool) };
}

/**
 * 「这一轮到底读到了什么」——**纯函数**，给一句人话读数（没有媒材时返回 null）。
 *
 * ★ 为什么把它抽出来（2026-10-06，Owner 原话：「视频还是无法读取」）：
 *   这条读数原先**只进日志**。于是卡片正文通篇在讲知识库自己的事
 *   （「覆盖判据不成立」「缺的是库覆盖，补素材无用」），**一句没讲他视频里有什么** ——
 *   委托方读到的就是「它没看我的视频」，而日志里明明写着
 *   「15.0s｜帧 OCR 8/8（51 字）｜音轨里没人说话」。
 *
 *   现在同一份读数**两处共用**：日志一行、卡片正文一块（`meta.mediaRead` → 信封）。
 *   两处各拼一遍迟早会不一致，所以只留这一个产者 —— 与 §2.5「形态决策只能有一处」
 *   同一条道理：同一件事有两个产者，错位只是时间问题。
 *
 * @param {object|null} inbound `readInboundContent()` 的产物
 * @param {{raw?:boolean}} [opt] `raw:true` ⇒ 用 **OCR 原文**（`textRaw`）而不是摘除后的文本。
 *        ★ 2026-10-09 晚加：这一格原先**同时**供卡片与诊断日志用，而两者要的不是一回事 ——
 *          卡片要**干净**（水印对读者没有信息量），日志要**原文**（"我到底读到了什么"是排查的锚点，
 *          摘除后印出来，核对时就看不到 OCR 真读成什么样了；当天我就因此差点把
 *          「生产摘 9 行、我这台摘 10 行」的差异读错）。
 *        ⚠️ 默认 `false` = 摘除后那份 ⇒ **卡片（唯一的生产调用）行为一个字不变**。
 * @returns {string|null}
 */
export function describeMediaRead(inbound, { raw = false } = {}) {
  if (!inbound) return null;
  const cut = (s, n = 200) => {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n)}…` : t;
  };
  // ★★ 2026-10-09（Owner：「目前守衡输出的没有视频的时间节点 00:12 这些」）——
  //   这一行原先**只取 `f.text`、丢掉 `t_s`** ⇒ 卡上「帧上文字」没有时间码，
  //   而同一份读数交给库侧那份是带时间码的 ⇒ 委托方拿着卡**无法去片子里定位**。
  //   现在改走 `video.frameLine`（**唯一产者**，见其头注），帧号/时间码与库里那份同源。
  const frameText = (f) => cut(video.frameLine(f, { indent: false }) ?? '');
  const out = [];

  const imgs = inbound.images ?? [];
  if (inbound.imageCount) {
    // ⚠️ 判据用 `textRaw`（**OCR 真读到了什么**）：OCR 读到、但全被判为水印时，
    //    `text` 会是空的 —— 那是「读到了、但都不算素材内容」，**不是「图上没字」**。
    const got = imgs.filter((i) => i.textRaw ?? i.text);
    const failed = imgs.filter((i) => i.failed);
    const empty = imgs.filter((i) => i.ocrEmpty);
    const chars = imgs.reduce((a, i) => a + (i.chars ?? 0), 0);
    out.push(`图 ${inbound.imageCount} 张${inbound.fromParent ? '（取自你引用的那条消息）' : ''}`
      + `｜读出文字 ${got.length} 张（共 ${chars} 字）`
      + (empty.length ? `｜图上没字 ${empty.length} 张` : '')
      + (failed.length ? `｜**读失败 ${failed.length} 张**` : '')
      + (inbound.skippedImages ? `｜超上限未读 ${inbound.skippedImages} 张` : ''));
    // ★★ 2026-10-09（Owner 两次重测都问这件事）**卡上也不再显示水印** ──────────────
    //   上一版这里印的是 `i.text`（OCR 原文、含水印），理由是"让人看到我读到了什么"。
    //   按 Owner 反馈定：**水印对读者没有信息量**。
    //   ⇒ 改印 `wlText`（摘掉水印那份）——**与喂给链的检索文本同源**（同一个字段，
    //     不再两处各拼一遍）；原文一个字没丢（仍在 `i.text`），核对时看日志的摘除明细。
    //   ⚠️ 摘掉的行**只报条数、不列内容** —— 列出来等于把水印又放回卡上（第一版就是这样，等于没摘）。
    if (got.length) {
      // ★★ 2026-10-09 晚（Owner：「【图 1 内文字｜35 行，另摘除水印 10 行】==》丑排版」）：
      //   卡上从前把 35 行碎片折成一行、切到 200 字。**两头不讨好**：
      //   业务读不懂（碎片本就不通顺），回源也核不了（切了一半）。
      //   ⇒ 卡上**只留读数**（读到几行、摘掉几行水印），**全文进报告附录**
      //     （`mediaReadAppendix`，唯一落点，一个字不丢；Owner 已点头这个方向）。
      //   ⚠️ 摘掉水印的行**只报条数、不列内容** —— 列出来等于把水印又搬回卡上。
      //   ⚠️ 原文**没有删**：`i.text` 仍在 `inbound` 里，报告附录印的就是它。
      const parts = got.map((i) => {
        const n = i.wmDropped?.length ?? 0;
        return `图 ${i.index}：读到 ${i.lines ?? '?'} 行${n ? `，另摘除水印 ${n} 行` : ''}`;
      });
      out.push(`图上文字：${parts.join(' ／ ')}（**全文见报告附录**「机读素材读数」）`);
    }
    for (const f of failed) out.push(`图 ${f.index} 读失败：${f.failed}`);
  }

  const vids = inbound.videos ?? [];
  if (inbound.videoCount) {
    const failed = vids.filter((v) => v.failed);
    out.push(`视频 ${inbound.videoCount} 段${inbound.fromParent ? '（取自你引用的那条消息）' : ''}`
      + `｜读成功 ${vids.length - failed.length} · 失败 ${failed.length}`
      + (inbound.skippedVideos ? `｜超上限未读 ${inbound.skippedVideos} 段` : ''));
    for (const v of vids) {
      if (v.failed) { out.push(`视频 ${v.index} 读失败：${v.failed}`); continue; }
      const t = v.transcript ?? {};
      const audio = t.ok ? `音轨转写 ${t.chars ?? 0} 字`
        : (t.kind === 'no_audio_track' ? '**没有音轨**'
          : (t.kind === 'no_speech' ? '音轨里没人说话' : `音轨转写没跑成（${t.kind ?? '?'}）`));
      out.push(`视频 ${v.index}：${Number(v.meta?.duration_s ?? 0).toFixed(1)} 秒`
        + `｜抽帧 OCR ${v.framesRead ?? 0}/${v.frames?.length ?? 0} 帧（共 ${v.ocrChars ?? 0} 字）｜${audio}`
        + (v.segmented ? `｜分段 ${v.nSegs} 段` : '')
        + (v.perf ? ` ⏱probe:${v.perf.probe_ms}ms ocr:${v.perf.ocr_ms}ms asr:${v.perf.asr_ms}ms scene:${v.perf.scene_ms}ms` : ''));
      // ★★ 2026-10-09 晚（Owner：「【图 1 内文字｜35 行，另摘除水印 10 行】==》**丑排版**」）：
      //   卡上**不再平铺图内文字全文** —— 那 35 行 OCR 碎片被 `cut(200)` 切一半、
      //   又用 ` / ` 折成一行：既不是给人看的（碎片本就不通顺），也不是给回源核对的（切了一半）。
      //   ⇒ **图**：卡片只留读数（读到几行、摘掉几行水印），全文进报告附录（`mediaReadAppendix`）。
      //   ⚠️ **视频不一样，这是刻意的，别顺手统一**：帧文字是**成句的一句话**
      //     （`Eufy S1 Pro has a single layer`，可读），而且 Owner **点名要卡上看得见时间码**
      //     （`[00:12]`）—— 把整块撤掉会连那个一起弄没（Z33a 就是这条，撤的时候当场变红）。
      //     ⇒ 视频保留**带时间码的压缩预览**（前几帧），全文仍进附录。
      const per = (v.frames ?? []).map(frameText).filter(Boolean);
      const preview = per.slice(0, 3);
      out.push(preview.length
        ? `帧上文字：${cut(preview.join(' ／ '), 150)}`
          + (per.length > preview.length
            ? `…（共 ${per.length} 帧有字，**全文见报告附录**「机读素材读数」）` : '')
        : '帧上文字：**一帧都没读到字**（这不等于「画面没问题」）');
    }
  }
  return out.length ? out.join('\n') : null;
}

/**
 * 报告附录：**媒材读数的全文**（图内文字 + 关键帧文字/转写）—— 与卡片那格**分工**。
 *
 * ★★ 2026-10-09 晚加（Owner 点头：「把排版丑放到附录中==》可以的」）：
 *   卡片上原先把 35 行 OCR 碎片折成一行、切到 200 字 —— **两头不讨好**：
 *   业务读不懂（碎片本就不通顺），回源也核不了（切了一半）。
 *   ⇒ 全文搬到**报告附录**（唯一落点），卡片只留读数。**搬不是砍**：
 *     · 图：`text`（摘除水印后那份，与卡/模型/链同源）+ 另摘了几行（只报条数，不列内容）；
 *     · 视频：`frameLine()` 逐帧（**带时间码**，`[00:12]` 口径）+ 音轨转写；
 *     · 读不到/没字的**如实写**（未测 ≠ 没有）。
 *   ⚠️ 没有媒材 ⇒ 回**空串**（不许凭空造一节 —— 报告里多一节空壳也是噪声）。
 *   ⚠️ 这里印的是**机读碎片**，必须自带说明：否则下一个人又会拿它当"素材的排版"去读。
 *
 * @param {object|null} inbound `readInboundContent()` 的产物
 * @returns {string} markdown 片段（空串 = 这一节不印）
 */
export function mediaReadAppendix(inbound) {
  if (!inbound || (!inbound.imageCount && !inbound.videoCount)) return '';
  const L = [];
  const imgs = inbound.images ?? [];
  if (inbound.imageCount && imgs.length) {
    L.push('### 图内文字（本机 OCR 逐行碎片）');
    L.push('');
    L.push('> ⚠️ 这是**逐行碎片** —— 版面的列关系在 OCR 那一步就丢了，**读起来不通顺是正常的**。');
    L.push('> 用途只有一个：核对「当时到底读到了什么字」。**不要把它当素材的排版或正文。**');
    L.push('> OCR 判为重复/覆盖式截图层水印的文字已摘除：**不计为素材问题，不据此判 REVIEW**；若水印遮住文字，只说明局部识读受限。');
    L.push('> 只有原图能确认水印属于最终交付创意内容时，才按成品审查；不能确认时不推断消费者会误认。');
    L.push('');
    for (const i of imgs) {
      if (i.failed) { L.push(`- **图 ${i.index}**：读失败（${i.failed}）`); continue; }
      const n = i.wmDropped?.length ?? 0;
      L.push(`- **图 ${i.index}**（读到 ${i.lines ?? '?'} 行${i.truncated ? ' · 已按字数上限截断' : ''}`
        + `${n ? ` · 另摘除水印 ${n} 行` : ''}${i.wmBasis && i.wmBasis !== 'none' ? ` · 判据 \`${i.wmBasis}\`` : ''}）：`);
      L.push('');
      L.push('```');
      L.push(String(i.text ?? '').trim() || '（这一张没读出文字）');
      L.push('```');
      if ((i.ocrCalibrations ?? []).length) {
        L.push('');
        L.push('视觉校准记录（**不覆盖上面的本机 OCR 原始读数**）：');
        for (const c of i.ocrCalibrations) {
          L.push(`- 第 ${c.line} 行：\`${String(c.from).replace(/`/g, '\\`')}\` → \`${String(c.to).replace(/`/g, '\\`')}\`（${c.basis}）`);
        }
      }
      L.push('');
    }
  }
  const vids = inbound.videos ?? [];
  // ── ★★ 2026-10-15：**画面读数**（PRD §5.1「基础视觉识别」那一半）──────────────
  //   为什么单开一节而不是并进「图内文字」：两者是**两种读数**，
  //   一个是**原图里真有的字节**（OCR 逐行碎片），一个是**模型看图的描述**。
  //   混在一节里，读报告的人会分不清「这句话是图上印的」还是「模型说的」——
  //   而这条区分恰恰是这份报告能不能被复核的前提（§2.4.1：读数是谁的）。
  if (inbound.imageCount && imgs.some((i) => i?.scene)) {
    L.push('### 画面读数（视觉模型看图的描述 —— **不是原图，也不是图上印的字**）');
    L.push('');
    L.push('> ⚠️ 这一节由**吃图的模型**看一眼那张图写出，只陈述看得见的（场景/人物/物品/可见标识/画面线索）。');
    L.push('> 它是**读数**：可以据此判「产品使用 / 人物行为 / 场景风险」，但**读数里没写的不要推断**。');
    L.push('> 三种结局分得开：**有读数** ／ **读了没读到**（未测）／ **这一单没跑画面层**。');
    L.push('');
    for (const i of imgs) {
      const sc = i?.scene;
      if (!sc) { L.push(`- **图 ${i.index}**：这一单没跑画面层`); continue; }
      if (sc.skipped) { L.push(`- **图 ${i.index}**：这一单**没跑**画面层（${sc.error ?? '未开'}）`); continue; }
      if (!sc.ok) { L.push(`- **图 ${i.index}**：**没读到**（${sc.error}）—— 画面层是**未测**，不是「没有画面」`); continue; }
      // 「送模型的是什么」如实写出来（缩过图/多少字节）—— 别让人以为它看的是原分辨率
      const sent = sc.sent ? `，送模型前${sc.sent.shrunk ? `缩到 ${SCENE_MAX_EDGE}px` : '未缩'}`
        + `（${Math.round((sc.sent.bytes ?? 0) / 1024)}KB${sc.sent.origBytes ? ` ← 原 ${Math.round(sc.sent.origBytes / 1024)}KB` : ''}）` : '';
      L.push(`- **图 ${i.index}**（${sc.ms}ms${sent}）：`);
      L.push('');
      L.push('```');
      L.push(sceneMod.sceneBlock(sc.scene));
      L.push('```');
      L.push('');
    }
  }
  // ── ★★ 2026-10-16：**关键帧的画面读数**（PRD §5.1 对视频写的「画面关键帧」）──────
  //   与图片那一节同一条纪律：**读数是谁的、覆盖了哪几帧**，都写在明处。
  if (inbound.videoCount && vids.some((v) => (v.frameScene ?? []).length)) {
    L.push('### 关键帧的画面读数（视觉模型看图的描述 —— **不是原图，也不是帧上的字**）');
    L.push('');
    L.push('> ⚠️ **只覆盖下面列出的时间码**：抽帧本来就是均匀抽样，画面层又只看了其中几帧 ——');
    L.push('> **没列出的帧，画面这一层是「未测」**，不是「没问题」。');
    L.push('');
    for (const v of vids) {
      const fs2 = v.frameScene ?? [];
      if (!fs2.length) continue;
      L.push(`- **视频 ${v.index}**：`);
      L.push('');
      L.push('```');
      L.push(fs2.map((s) => (s.ok
        ? `[${Number(s.t_s ?? 0).toFixed(1)}s] ${sceneMod.sceneBlock(s.scene)}`
        : `[${Number(s.t_s ?? 0).toFixed(1)}s] 没读到（${s.error ?? '未知'}）—— 未测`)).join('\n'));
      L.push('```');
      L.push('');
    }
  }
  if (inbound.videoCount && vids.length) {
    L.push('### 关键帧文字与音轨转写');
    L.push('');
    for (const v of vids) {
      if (v.failed) { L.push(`- **视频 ${v.index}**：读失败（${v.failed}）`); continue; }
      L.push(`- **视频 ${v.index}**（${Number(v.meta?.duration_s ?? 0).toFixed(1)} 秒 · `
        + `抽帧 OCR ${v.framesRead ?? 0}/${v.frames?.length ?? 0} 帧）：`);
      L.push('');
      const per = (v.frames ?? []).map((f) => video.frameLine(f, { indent: false, raw: true })).filter(Boolean);
      L.push('```');
      L.push(per.length ? per.join('\n') : '（一帧都没读到字）');
      L.push('```');
      L.push('');
      const calibrated = (v.frames ?? []).flatMap((f) => (f.ocrCalibrations ?? []).map((c) => ({ t: f.t_s, ...c })));
      if (calibrated.length) {
        L.push('视觉校准记录（**判定消费校准副本，上面仍为本机 OCR 原始读数**）：');
        for (const c of calibrated) {
          L.push(`- [${video.mmss(c.t)}] \`${String(c.from).replace(/`/g, '\\`')}\` → \`${String(c.to).replace(/`/g, '\\`')}\`（${c.basis}）`);
        }
        L.push('');
      }
      const t = v.transcript ?? {};
      if (t.ok && String(t.text ?? '').trim()) {
        L.push('音轨转写：');
        L.push('');
        L.push('```');
        L.push(String(t.text).trim());
        L.push('```');
        L.push('');
      } else {
        L.push(`音轨：${t.kind === 'no_audio_track' ? '**没有音轨**'
          : (t.kind === 'no_speech' ? '音轨里没人说话' : `转写没跑成（${t.kind ?? '未测'}）`)}`);
        L.push('');
      }
    }
  }
  return L.join('\n').trim();
}

/**
 * ★ 2026-10-12（Owner 同意「先只动 P0 命中那一路」）：P0 确定性命中时的**短卡**要求。
 *
 * 依据（实测，不是感觉）：同一条真实送审单的结果卡是 **2903 字 / 54541 ms**
 * （守衡日志逐字 `💬 回复 2903 字，耗时 54541ms`），而这一路的判定**早在 48 ms 就定了**
 * （`🚦 P0 命中 ⇒ 直接 BLOCK，不起链：H05｜48.297 ms`）——
 * 逐条明细与修改建议都在**报告**里，群里再展开一遍没有增量，
 * 却把 PRD §12「单条文字 ≤ 10 s」拖到 50 s 以上（Owner 2026-10-12 裁定的口径 = 用户等多久）。
 *
 * ★ 为什么**不会**弄丢 PRD §5.3 合规块：结论块由**代码强制**落进卡
 *   （`applyVerdictLine` ＋ `blockSlotOf` 的类型回退），**不依赖模型的措辞** ——
 *   短答只压缩「叙述」，不压缩「结论行 / 命中模式与条款号 / 报告链接」这三样必须项。
 */
export const P0_SHORT_REPLY_INSTRUCTION = [
  '【本条是 P0 红线**确定性命中**（关键词/正则匹配，不是模型推断）—— 请按**短卡**作答】',
  '必须保留：① 三态结论行；② 命中的 P0 模式与条款号；③ 报告链接（有就写，没有就说明原因）。',
  '不要展开：逐条明细、修改建议全文、读数复述 —— 那些都在上面那份报告里，群里重复一遍没有增量。',
  '篇幅上限：正文 ≤ 300 字（不含结论行与链接）。',
].join('\n');

/**
 * 判定「这一单要不要附短卡要求」。**纯函数** ⇒ `p0_short_reply.test.mjs` 直接喂夹具验它。
 * 只认 `p0_fastpath`（= 链**没跑**、判定是确定性的）；
 * **评审链 / 拒答 / 普通对话一律不附** —— 那些场合的正文是要给人看的实质内容。
 */
export function p0ShortReplyBlock(res) {
  return res && res.p0_fastpath ? P0_SHORT_REPLY_INSTRUCTION : '';
}

/**
 * 主回复那一轮要不要带思考 —— **默认不带**（2026-10-20，Owner：「这个慢的问题必须做优化」）。
 *
 * 实测（同输入、同 `max_tokens`，2026-10-20 12:51）：开思考 **11738ms** / 正文 496 字
 * （reasoning 2123 tok）；关思考 **1978ms** / 正文 493 字 ⇒ **5.9 倍**，产出几乎一致。
 *
 * 为什么敢关：这一轮做的是**组装与转述**（素材读数、链的三态结论、逐条建议都已就位），
 * 判据不在模型这边 —— P0/条款号由引擎给，模型只负责把已有内容说成人话。
 * 思考主要烧在"怎么措辞"上，对结论没有增益。
 *
 * ⚠️ **每次现读 env**，不冻成模块常量：冻了之后自证里改 env 不生效（与 `mediaLinkEnabled`
 * 同一刻度）。回退：`SHOUHENG_REPLY_THINK=on` ⇒ 恢复带思考（A/B 对照用，不必改代码）。
 *
 * @returns {null|{type:'disabled'}} 传给 `llm.chat(..., { thinking })`
 */
export function replyThinking() {
  // ★★ 2026-10-20 **默认保持原状（带思考）** —— Owner：「改东西不要影响现有的工作流」。
  //   基准确实测到关思考 5.9 倍（11738ms → 1978ms，正文长度几乎一致），但**卡片/报告的
  //   位置写法要过 `prd533` 与卡面闸门**（"图 1 第 3 处"那种三模式），而思考关掉之后
  //   模型更容易写自由格式（当天 S10 已经红过一次，虽然那一单是带思考跑的、不能归因）。
  //   ⇒ 先不上，把开关留成**可 A/B**：`SHOUHENG_REPLY_THINK=off` 才关。
  //   要正式启用，先跑一单对照（同一素材两次、比卡面 prd533 与 S10），再改默认。
  const off = /^(off|0|false|no)$/i.test(String(process.env.SHOUHENG_REPLY_THINK ?? '').trim());
  return off ? { type: 'disabled' } : null;
}

export function buildUserTurn({ questionText = '', imageBlock = '', videoBlock = '', chainBlock = '' } = {}) {
  // 图块拼在问题**后面**：模型先读人问的话，再读图上的字，顺序与人发消息的顺序一致。
  // 视频块排在最后（它最长），顺序是「她问的话 → 图上的字 → 视频读数」。
  let q = questionText ?? '';
  if (imageBlock) q = q ? `${q}\n\n${imageBlock}` : imageBlock;
  if (videoBlock) q = q ? `${q}\n\n${videoBlock}` : videoBlock;
  // ★ 链的结论排在**最前**（它在问题之前）：它是这一轮的**结论**，不是补充材料 ——
  //   排在后面会被前面几百字的读数盖住，模型就又开始「描述我读到了什么」了。
  if (chainBlock) q = q ? `${chainBlock}\n\n${q}` : chainBlock;
  return q;
}
/**
 * 处理一条飞书消息，返回要发出的回复文本（不负责发送）。
 * @param {object} event  im.message.receive_v1 的 data
 * @param {object} [opts]
 * @param {{fetchImage?:Function, ocr?:Function, executeTool?:Function}} [opts.deps]
 *   测试注入用；生产走真实现。★ `executeTool`（2026-10-16 加，FIX-043）**只有一个默认值**：
 *   工具循环里那一行 `deps?.executeTool ?? executeTool` —— 加它是为了让「P0 读数接线」
 *   能端到端跑一遍，而不是只剩源码文本断言（§2.4：名字出现过 ≠ 它拦得住）。
 * @returns {Promise<{reply:string|null, reason?:string, sessionKey?:string, meta?:object}>}
 */
export function handleMessage(event, opts = {}) {
  return withAgentTurnContext(() => handleMessageInTurn(event, opts));
}

async function handleMessageInTurn(event, {
  force = false,
  deps = undefined,
  // ★ 目标 19（2026-10-10）：**消息到达时刻**（ms epoch）。由 `ws_daemon.onMessage` 在收到
  //   事件那一刻打；不给就退回"进 handleMessage 的这一刻"（会少算排队/调度那几毫秒，
  //   ⇒ **报告里必须写明取的是哪一个**，不许把两个数混着说）。
  //   ★★ 2026-10-20（Owner 批准 ②）：守护进程这条路上**现在真的传了**（`ingressMsOf`），
  //   来源写进 `tIngressOrigin` 并带进指标行 —— 不许再靠缺省值把这条指标量成恒过。
  tIngress = null,
  tIngressOrigin = null,
  // ★ 链要跑 10~30 分钟：一开始就回一句，否则对方以为它没动（09:22 那次就是这样）。
  notify = null,
  // 跑链那一步的注入点（测试必须注入桩 —— 不注入就会真起一条 30 分钟的链并写飞书）。
  //
  // ★ 2026-10-05 现场踩到的第二个坑：这里原先内联写着 `(args) => executeTool(...)` ——
  //   而 `executeTool` 回的是**信封** `{tool, ok, result}`，不是链的返回。
  //   于是同一个「怎么跑链」有了**两个默认值**，而 `handleMessage` 显式把这个传下去，
  //   **盖住了 `runSubmissionGate` 里那个正确拆信封的默认值**。
  //   表现：链明明没跑成（KB 根不存在），日志和 `meta.chain.ran` 却写「**跑成**」——
  //   而 `mediaWithoutChain()` 那条兜底棘轮看的正是 `chain.ran`，
  //   于是「该送审却没起链」这个警报**在链没跑成的时候反而闭嘴**。
  //   修法：默认值只留一个（下面那个具名函数），这里只做转发。
  chainRunner = defaultChainRunner,
  publishRunner = reviewPublish.ensureReviewRow,
  // ★ 2026-10-06：`handleMessage` **转发**它，所以自己也必须声明它。
  //   不声明就转发 = 未声明标识符 = **直接抛 ReferenceError**，
  //   而它抛在闸门之后那一跳上 —— 现场表现是「链跑完了却没有回话」。
  //   实测就是这么红的：`THREW modelSideRunner is not defined`。
  modelSideRunner = reviewModelSide,
  imageClaimRunner = adjudicateImageClaims,
  // ★ 2026-10-09：转发给闸门（见那里的注释）—— 不声明就转发 = ReferenceError
  mergedReportRunner = publishMergedReport,
  adviceRunner = generateAdvice,
  // ★ 2026-10-22：默认改成**分流器**（飞书链接走飞书只读接口，其余走公开网页读数器）。
  //   事故见 `feishu_link.mjs` 文件头；`readPublicPage` 仍是它内部的一条分支，没有丢。
  linkReader = reviewGate.readLink,
} = {}) {
  // 每条消息先清空上一次的图读数（否则纯文字消息会继承上一条的图）
  setAgentTurnContext({ imageBlock: '' });

  const msg     = event?.message ?? {};
  const sender  = event?.sender ?? {};
  const chatId  = msg.chat_id;
  const chatType = msg.chat_type;                    // 'group' | 'p2p'
  const senderOpenId = sender?.sender_id?.open_id ?? sender?.sender_id?.user_id ?? '';
  const publicationContext = Object.freeze({ chatId, chatType, senderOpenId, messageId: msg.message_id });
  setAgentTurnContext({ publicationContext });

  // ── 1. 去重必须**最先**做。
  // 放在类型判断之后是错的：非文本消息（图片/文件）会绕过去重，
  // 服务端重推同一条时会重复回话，用户看到守衡对同一张图说两遍「我读不了」。
  //
  // ★ `force`（2026-09-22 加，Q1-1d）：**补发**要重放同一条消息，而它必然已在去重表里。
  //   所以补发那一路显式绕过去重 —— 但它绕过的**只有这一道**，幂等的另外两道
  //   （台账已答 / 记忆已答）由 `retry_queue.mjs` 自己判，那两道才是防「答两遍」的。
  if (!force && alreadyHandled(msg.message_id)) {
    return { reply: null, reason: 'duplicate', meta: { message_id: msg.message_id } };
  }

  // ── 2. 把这一条读成「文字 + 图内文字」。
  //
  // ★ 2026-10-05 改：原先这一步是 `if (msg.message_type !== 'text') return 拒答`。
  //   那次事故（06:37 私聊「评审下下这个图片，能过吗？」+ 配图）暴露了两个错，
  //   而且是**同一个形状**——「结论比输入大」：
  //     · 图文混排在飞书里是 **post** 类型 → 连**正文**都被扔掉，
  //       而 `bodyToText`（09-22 就修好了）本来读得出来；
  //     · 图片按红线不取 —— 这一半**当时是对的**，但话说错了：
  //       「它的正文我读不了」让人以为缺个开关，于是她没有任何可走的路。
  //   现在：正文照读；**人当前发来的图**读图内文字（§2.6 窄豁免，Owner 10-05 确认）；
  //   file/media/audio 仍然不取，而且明确说「按规矩不取」。
  //  `deps` 只是给测试注入桩用的（生产调用点一个字都不用改）——
  //  没有它，「取图 + OCR」这条路只能在联网 + 花 token 的情况下才测得动，
  //  而那等于没有可跑的判据（AGENTS.md §2.4：指不出哪一行在拦它，就等于没拦）。
  //
  // ── 2.5 送审人显示名：**必须在读图之前**备好（2026-10-09 晚，Owner：「还有我的名字」）──
  //
  // ★ 病灶（**接线顺序错了**，不是判据错）：`readInboundContent` 就是下一行（读图 + 摘水印），
  //   而名字原先要到第 4 步（`not_mentioned` 判断之后，约 1550 行）才解析出来 ——
  //   ⇒ **摘水印的时候还不知道送审人叫什么**，判据只能靠「OCR 有没有把名字读出 2 次」去猜。
  //   而同一张图两次 OCR 的读数**并不一致**（实测：一次 `刘华問`×2+`Owner`×1，
  //   另一次 `刘华`×2+`Owner`×3）⇒ 名字只被读出 1 次时就当不上"平铺核心"、摘不掉，
  //   于是卡片与报告继续带着它（Owner 连报两次）。
  //   水印逐字就是「**用户名 + 工号**」（台账实测 `sender: Owner`）⇒ 名字是**已知的**，不该猜。
  //
  // ★ 为什么是**惰性取数**而不是在这里 await：没带图的普通对话不该多付一次名字查询。
  //   传下去的是个**取数函数**，`readInboundContent` 只在真读到图、真要去水印那一刻调它；
  //   底层 `feishu.getUserName` 自带群成员缓存 ⇒ 第 4 步再调一次是缓存命中、不重复花钱。
  let _senderNameForWm;
  const senderNameForWatermark = () => {
    if (_senderNameForWm === undefined) {
      _senderNameForWm = senderOpenId
        ? feishu.getUserName(senderOpenId, chatId).then((x) => x?.name ?? null).catch(() => null)
        : Promise.resolve(null);
    }
    return _senderNameForWm;
  };
  // ── 「这条是不是在对我说话」—— **唯一判据**，回执前置与 §4 共用这一份 ────────────
  //
  // ★ 病灶（2026-10-22 实测，群 `oc_49a7…`、消息 `om_x100b62a37c9fc8b4dc0ba2a61cc3e7d`）：
  //   群里一条**没 @ 守衡**的消息（正文「不应该出现历史审核意见作为依据」）命中送审词
  //   ⇒ 回执前置先回了「⏳ 处理中…完整审核正在运行，**完成后会在此回复**」；
  //   随后 §4 判 `not_mentioned` 直接不回复 ⇒ **承诺发出去了、链一次都没起**，
  //   群里挂着一条「处理中」，而没有任何东西在跑。
  //   这不是措辞问题，是**回执前置没有过「对我说话」这道门**（AGENTS.md §2.4.2：
  //   一句对外说过的话，必须指得出哪一行在执行它 —— 那天指不出来）。
  //
  // ★ 为什么在这里算：§3 的 mention 还原要等 `readInboundContent`（读图 + OCR + 画面读数，
  //   实测 5.8 s、抖动到 27.8 s）之后才有，而回执前置的全部意义就是赶在那之前。
  //   所以先用**只凭消息本身**的一条同名解析取一次读数；拿到正文后（§3）用权威读数覆盖。
  //   ⚠️ 两处**不许各写一套判据**：`addressedToMe()` 是唯一入口。
  let _botMentionedProbe;        // undefined = 还没算；true/false = 赶在正文之前的早判
  let _botMentionedFromInbound;  // §3 拿到正文后的权威读数
  const addressedToMe = () => {
    if (chatType !== 'group' || !config.requireMentionInGroup) return true;   // 私聊一律响应
    if (_botMentionedFromInbound !== undefined) return _botMentionedFromInbound;
    if (_botMentionedProbe === undefined) {
      let t = '';
      try { t = feishu.bodyToText(msg.message_type, msg.content ?? '{}').text ?? ''; } catch { t = ''; }
      _botMentionedProbe = feishu.isBotMentioned(feishu.resolveMentions(t, msg.mentions ?? []).mentions);
    }
    return _botMentionedProbe;
  };

  // ── ★★ 2026-10-20（Owner 批准 ①）：「**回执前置**」──────────────────────────────
  //   病灶（实测 2026-10-20）：回执卡原先要等下面那句 `readInboundContent` 跑完才发 ——
  //   它里面**串着**「下载图 → 画面读数（模型）→ 本机 OCR → 摘水印」，同一步骤本机实测 5.8 s，
  //   线上抖动到 **27.8 s**（`scene` 那条读数）；再叠上「上一轮没跑完、这一轮只能等」，
  //   飞书侧真值是 **60 / 120 / 180 秒**（当天三单，服务端时间戳）。
  //   ⇒ 只要**光看消息**就能判这是送审，就先回一句「处理中」，再去读素材。
  //
  //   三条边界（每条都能核）：
  //     · **同一把尺子**：这里与闸门里调的是同一个 `reviewGate.isSubmission`，输入也同一份
  //       （正文 `bodyToText`、张数 `imageKeysOf/videoKeysOf`）—— 不许在这里另写一套判据；
  //     · **只发一次**：发过的时刻交给闸门（`ackSentAt`），闸门据此不再发第二张；
  //       闸门那条路**故意保留**（引用的那条带图时，张数要到读入阶段才知道）；
  //     · **不许为了排队提示把回执拖慢**：`claimStatus()` 是外部子进程，这里给 700 ms 封顶，
  //       取不到就按「不排队」说（与闸门里那条 catch 同口径：不谎报）。
  let earlyAckAt = null;
  // ★★ 2026-10-21（Owner：「P0 红线问题必须 10 秒内回」「一条消息只回一条结论，不能发两条」）
  //   —— **P0 预判**：命中就**不发**「⏳ 处理中」回执，直接等着出那张结论卡。
  //
  //   实测为什么非这样不可（`PMO/logs/ws_daemon.log`，365 轮）：
  //     · P0 命中单：判定 p50 **3.3 s** 就有结论了，而用户实际等到卡 p50 **62.1 s**；
  //       差额＝模型写 3000 字正文（p50 ~42 s，**不上卡**）＋ 模型侧双轨（p50 11.8 s）
  //       ＋ 建议生成（p50 5.4 s）。这三步在 PRD §6.3 里都属「命中后应停止的后续审查」。
  //     · 停掉之后剩下的只有「判定 → 建报告 → 落表 → 发卡」，4~6 s ⇒ 一张卡就够，
  //       再先发一张「处理中」等于让人先读一句废话、再读答案（两条消息只对一条结论）。
  //
  //   ⚠️ 预判**只决定「发不发回执」**，不决定任何判定：
  //     判据仍在链里跑（同一份模式表、同一个 CLI）；预判坏了/超时 ⇒ 按未命中算 ⇒ 行为与改动前一致。
  //   ⚠️ 方向是安全的：预判用的是**与闸门同一份正文**（`bodyToText` ⇒ `chainInput.text`），
  //     文字单逐字相同，媒材单是它的子集 ⇒ **假命中不可能**（真命中也只影响回执那一条）。
  let p0PreHit = false;
  if (!force && typeof notify === 'function') {
    let gateEarly = null;
    let earlyText = '';
    try {
      const parsedEarly = feishu.bodyToText(msg.message_type, msg.content ?? '{}');
      earlyText = parsedEarly.text ?? '';
      gateEarly = reviewGate.isSubmission({
        text: earlyText,
        imageCount: feishu.imageKeysOf(msg.message_type, msg.content ?? '{}').length,
        videoCount: feishu.videoKeysOf(msg.message_type, msg.content ?? '{}').length,
      });
    } catch { gateEarly = null; }
    if (gateEarly?.yes) {
      try { p0PreHit = await p0Precheck(earlyText); } catch { p0PreHit = false; }
      if (p0PreHit) {
        // ★★ 2026-10-21（Owner 当场纠正）：「**为什么p0对问题，不回复处理中的卡片状态了？
        //   必须先回复处理中，再回复block**」——
        //   「处理中」不是结论，所以它**不违反**「一条消息只回一条结论、不发两条回复」；
        //   那条口径管的是**结论**（不许同一单给出两个三态）。⇒ 回执照旧**先发**，
        //   结论卡随后到（P0 命中不调模型，所以两张之间只隔几秒）。
        //   ⚠️ 这一行只是读数：它记的是「这一单会少做哪三件事」，不是「不发回执」。
        console.log('[agent] ⚡ P0 预判命中 ⇒ 后续**不调模型**（不起模型侧 / 不生成建议 / 不等正文，'
          + 'PRD §6.3 命中即停止后续审查）；回执照旧先发'
          + `（${gateEarly.kind}｜${gateEarly.why}）`);
      }
    }
    // ★ 2026-10-22：**先过「这条是不是在对我说话」这道门**，再决定发不发「处理中」。
    //   群里没 @ 我的消息，§4 随后会 `not_mentioned` 直接不回复 —— 那就不许先许一个诺。
    if (gateEarly?.yes && addressedToMe()) {
      let queued = false;
      try {
        const cs = await Promise.race([
          claimStatus(),
          new Promise((r) => setTimeout(() => r(null), 700)),
        ]);
        queued = !!cs && cs.free === false && cs.stale === false && cs.unknown !== true;
      } catch { /* 取不到就不说排队（不谎报） */ }
      try {
        await notify(reviewGate.ackMessage({ ...gateEarly, chatId }, { queued }).block);
        earlyAckAt = Date.now();
        console.log(`[agent] 🧭 回执前置：${gateEarly.kind} —— ${gateEarly.why}｜先回一句，再读素材`
          + (p0PreHit ? '（P0 命中也照发：处理中不是结论，结论卡随后到）' : ''));
      } catch (e) {
        console.log(`[agent] · 回执前置没发出去（不影响后续）：${e?.message ?? e}`);
      }
    }
  }
  const inbound = await readInboundContent(msg,
    // ★ 2026-10-30：scene 必须显式传，否则 deps=undefined 时 readVideo 收到 scene=undefined
    //   → scene(path) 抛 TypeError → 视频语义分析静默失败（frameScene 全空）。
    deps ? { ...deps, senderNameForWatermark } : { senderNameForWatermark, scene: sceneMod.sceneRead });
  // 日志留一行读数：**「守衡有没有真的读到图」不该只能靠群里看回复来判断**。
  // 这一行也是排查的锚点（图几张、OCR 多少字、哪几张失败、是不是从引用的那条取的）。
  if (inbound.parentNote?.kind === 'parent_unreadable') {
    console.log(`[agent] ⚠️ 图未测：这条没带图，它引用的 ${inbound.parentNote.parentId} 读不到（${inbound.parentNote.error}）`);
  }
  // ★ 2026-10-06：原先图、视频各拼一段日志，而**同一份读数不进卡片**。见 `describeMediaRead`。
  // ⚠️ 2026-10-13：原先这里还算一份**摘除后**的读数给卡片用（`describeMediaRead(inbound)`）；
  //   读数不上卡之后那一份**没有消费者了** ⇒ 拿掉，免得留下一个算了没人读的变量
  //   （「算了没人读」与「传了没人接」是同一个病）。要用的是下面 `raw:true` 这一份日志，
  //   以及 `mediaReadAppendix(inbound)`（报告附录那份是**摘除后**的，见它自己的头注）。
  // ⚠️ 这一行印 **OCR 原文**（`raw:true`）：它是"我到底读到了什么"的排查锚点，
  //   摘除后印出来就看不到 OCR 真读成什么样了（水印摘了哪些行另有「🚫 摘除水印」那一行）。
  const mediaReadRaw = describeMediaRead(inbound, { raw: true });
  if (mediaReadRaw) console.log(`[agent] 📥 读到｜${mediaReadRaw.replace(/\n/g, ' ⏎ ')}`);
  const imageBlock = buildImageBlock(inbound);
  // ★ 2026-10-20：把**本条的图内文字 + 画面读数**挂到全局，给 `kb_review_chain` 用。
  //   病灶（Owner 实测）：headless 里的模型调送审工具时，`text` 是它**自己转述**的素材
  //   （实测归一化 533 字，而图内文字有 1300+ 字）⇒ 知识库侧的"同图指纹"对不上、
  //   画面线索也进不去 ⇒ 负面样本规则 0 命中。读数不能靠模型转述，必须由内核直接递。
  setAgentTurnContext({ imageBlock: imageBlock || '' });
  const videoBlock = buildVideoBlock(inbound);
  // ★ 判据是「**读成功过**」，不是「读出了内容」：一条视频抽帧成功、音轨里没人说话，
  //   那也是一个**要如实回答的读数**（「画面上这 8 帧没有可读文字、音轨里没人说话」），
  //   而不是走「我读不了」那条拒答 —— 后者会让人以为缺个开关，再去发一遍还是同一句。
  const videoRead = inbound.videos.some((v) => !v.failed);
  const hasAnything = !!inbound.text || inbound.images.some((i) => i.text) || videoRead;

  if (!hasAnything) {
    const meta = { message_type: msg.message_type, image_count: inbound.imageCount,
                   video_count: inbound.videoCount };
    // ⓐ 附件（file / media / audio 里的**非视频**）：**按规矩不取**，并给一条走得通的路。
    //   ★ 这段文案 2026-10-05 改过一次，因为**它当时是错的**：
    //     原文写着「附件（文件/语音/**视频**）我不取」—— 而视频那条路当天已经通了。
    //     照那句说，对方会把视频再发一遍，还是听到同样一句话（与 06:37 那次同一个形状：
    //     **话说得比能做的窄，于是人以为缺个开关**）。
    if (inbound.attachment) {
      return { reply: '附件（表格/文档/语音这类）我不取 —— 飞书上的内容公司不让下载，它们只有下载这一条通道。\n'
                    + '要审的话，把里面的文字贴过来；或者存成飞书云文档发我，云文档我能直接读。\n'
                    + '**图片和视频不一样**：图你直接发我，我读图上的字；'
                    + '视频你也直接发我，我抽关键帧读画面上的字、再在**本机**把口播转成文字。',
               reason: 'attachment_not_taken', meta };
    }
    // ⓑ 视频一段都没读成 → 如实说失败原因（**不许**编内容，也不许说成「视频里没东西」）。
    if (inbound.videoCount) {
      const why = inbound.videos.map((v) => `视频 ${v.index}：${v.failed ?? '未读'}`).join('；');
      return { reply: `你发的那段视频我**没读成**（${why}）。\n`
                    + '这不是「视频里没问题」—— 是我这一段没读到。'
                    + '可以再发一次；如果是格式比较偏（比如非常规编码），转成 mp4 再发我一次。',
               reason: 'video_unreadable', meta };
    }
    // ⓒ 有图但一张都没读出来 → 如实说，并给出下一步（**不许**编内容）。
    if (inbound.imageCount) {
      const why = inbound.images.map((i) => `图 ${i.index}：${i.failed ?? (i.ocrEmpty ? '图上没识别出文字' : '未读')}`).join('；');
      return { reply: `你这条里的图我**没读出内容**（${why}）。\n`
                    + '如果是图上文字太小或图形化排版，可以把文字贴过来；'
                    + '也可以换一张更清晰的截图再发我一次。',
               reason: 'image_unreadable', meta };
    }
    // ⓓ 其余非文本类型（卡片 / 表情 / 位置…）：照实说没解析出来 + 是哪种没解析出来。
    //   ★ 若这条是在**回复**另一条、而那条我读不到 —— 必须说「未测」，不许说成「没有图」。
    //
    // ★★ 2026-10-26 改口径（一次真实的「私聊读得到、群里读不到」）：
    //   这一支原先一律说「它的正文我读不了 —— 请把它转成文字发我」。
    //   两句都是**把自己的解析失败说成对方的格式问题**：
    //     · 「正文我读不了」暗示这条没有正文，而实测载荷里经常有（只是形状没认出来）；
    //     · 「请转成文字」把一个**我这侧的**缺陷变成了对方的动作。
    //   ⇒ 现在先做了一次**按 message_id 的回读**（见上面 `selfReread`），
    //     回读也不行才说读不出来，并且**说出回读实际看到了什么**（类型 / 解析提示），
    //     让下一次排查不用再从零猜。仍给替代路径，但不再说成「你需要做点什么」。
    const quoteNote = inbound.parentNote?.kind === 'parent_unreadable'
      ? `\n另外：你这条是在回复某一条，而**那条我读不到**（${inbound.parentNote.error}）——`
        + '所以那里面有没有图或视频，我不知道，也不会去猜。'
      : '';
    const rereadNote = inbound.selfReread
      ? (inbound.selfReread.ok
        ? ''
        : `\n（我按消息 id 回读了一次，同样没拿到内容：类型=${inbound.selfReread.msgType ?? '未知'}`
          + `${inbound.selfReread.parseNote ? `，解析提示=${inbound.selfReread.parseNote}` : ''}`
          + `${inbound.selfReread.error ? `，错误=${inbound.selfReread.error}` : ''}）`)
      : '';
    return { reply: `这条我解析不出内容（消息类型「${msg.message_type}」）——`
                  + `**问题在我这一侧的解析**，不是你发的东西没有内容。`
                  + `${inbound.parseNote ? `（${inbound.parseNote}）` : ''}`
                  + rereadNote
                  + '\n图文混排、单独发图、发视频我平时都读得到（这条是没读出来）；'
                  + '要现在就走，把要审的文字贴给我，或者把这条再发一次。'
                  + quoteNote,
             reason: 'unsupported_type',
             meta: { ...meta, parseNote: inbound.parseNote, selfReread: inbound.selfReread ?? null } };
  }

  // ── 3. 解析正文与 mention
  //    `inbound.text` 已经是可读正文（post 也在内）；mention 还原仍然照旧。
  const rawText = inbound.text;
  const { display, mentions } = feishu.resolveMentions(rawText, msg.mentions);
  const botMentioned = feishu.isBotMentioned(mentions);
  // ★ 2026-10-16：**对方真写过的那句话**，与 `question` 分开留着 ——
  //   落表用的「送审问题」只许写它（＋媒材链接），见 `runSubmissionGate` 的 `userText`。
  const userText = botMentioned ? feishu.stripBotMention(display, mentions) : display.trim();
  let question = buildUserTurn({
    questionText: userText,
    imageBlock, videoBlock,
  });

  // 名字的解析与「惰性取数函数」都在上游第 2.5 步（读图之前）—— 这里不再重复一份。

  // ── 4. 群聊里「不 @ 不理」，避免刷屏；私聊一律响应
  //    ★ 2026-10-22：判据收成 `addressedToMe()`（与回执前置同一份）——
  //    拿到正文后的 `botMentioned` 是**权威读数**，先交给它覆盖早判，
  //    免得「回执按早判发了、这里按权威读数不回」，同一个形状再犯一次。
  _botMentionedFromInbound = botMentioned;
  if (_botMentionedProbe === true && !botMentioned) {
    //   这一行是读数，不是兜底：两处用的是同一份正文与同一个 `isBotMentioned`，
    //   真出现分歧就说明「早判的正文」与「readInboundContent 读出的正文」不是同一份 ——
    //   那时回执已经发出去了，至少要让这件事在日志里看得见（别又一次「承诺发了、链没起」）。
    console.log('[agent] ⚠️ 早判说「在对我说话」、权威读数说没有 —— 回执已发出，本单按权威读数不回话');
  }
  if (!addressedToMe()) {
    return { reply: null, reason: 'not_mentioned' };
  }  if (config.allowedChats.length && !config.allowedChats.includes(chatId)) {
    return { reply: null, reason: 'chat_not_allowed', meta: { chatId } };
  }

  // 已知名字的三条来源，按可信度与代价排序：
  //   1) 消息 mentions 里带的名字（零成本，但只覆盖「被 @ 的人」）
  //   2) 群成员列表（已有权限，覆盖同群所有人）
  //   3) 通讯录单查（需额外权限，未开通则失败）
  let senderName = mentions.find((m) => m.openId === senderOpenId)?.name || null;
  let senderNameSource = senderName ? 'mention' : null;
  let senderNameReason = null;
  if (!senderName && senderOpenId) {
    const looked = await feishu.getUserName(senderOpenId, chatId);
    senderName = looked.name;
    senderNameSource = looked.source;
    if (!senderName) {
      // 查不到就如实告诉模型，别让它编一个称呼
      senderName = '(未知名)';
      senderNameSource = 'unresolved';
      senderNameReason = looked.reason;
    }
  }
  const senderNameKnown = senderNameSource !== 'unresolved';

  // ── 5. 会话与记忆
  const key = mem.sessionKey({ chatId, chatType, senderOpenId });
  return withLock(key, async () => {
    const sess = mem.load(key);
    if (!sess.title && chatType === 'group') {
      const info = await feishu.getChatInfo(chatId);
      mem.setTitle(sess, info?.name ?? null);
    } else if (!sess.title && chatType === 'p2p') {
      mem.setTitle(sess, `${senderName} 的私聊`);
    }

    // 注入运行期上下文，工具据此知道「现在在哪、跟谁说话」
    // senderNameKnown=false 时，senderName 是「(未知名)」占位符而非真名，
    // 一并告知模型，避免它把这个占位符当成真名去称呼对方。
    Object.assign(runtimeContext, {
      chatId, chatType, senderName, senderOpenId, messageId: msg.message_id,
      senderNameKnown,
      ...(senderNameKnown ? {} : { senderNameUnavailableReason: senderNameReason }),
    });

    // ── 5.4 把「我说过、但记忆里没有的」补进来（2026-09-22 加）
    //
    // ★ 为什么必须有这一步：`mem.append` 只在**回复循环**里调，而守衡**主动说出的话**
    //   （`send_once.mjs` 手发的、基线告警、待收提醒、崩溃自报）都不经过那里。
    //   后果在 09-22 14:39 变成了对外的：她 14:39:34 回「归我」，而守衡的上下文里
    //   **只有她那句话、没有自己 14:37:55 问过的那一句** —— 它看到的是一句悬空的回答，
    //   往上接到了 27 小时前的话题上，答成「那三条过期内容归你」并发了出去。
    //   台账（`outbound.mjs`）记着那条问话，这一步把它折回记忆。
    //
    // ★ 位置是**判据的一部分**，不能挪：
    //   · 必须在 §5.5 **之前** —— 折进来之后再问「上文在不在历史里」，那条问话就已经在了，
    //     同一个上文不会既进历史又进引用块（两遍就是噪音，还会让模型以为问了两遍）；
    //   · 必须在 `mem.append(sess, { role: 'user', ... })` **之前** —— 它问的话要在
    //     她的回答**上面**，否则模型读到的是「先答后问」。
    //
    // ⚠️ 三种情形在日志里长得不一样（**取不到 ≠ 没有要补的**）：
    //   · 补了 N 条 → 记一行，带上 message_id；
    //   · 没有要补的 → 记一行「无新增」（这是正常的，不是失败）；
    //   · **读数采不到**（台账读不出 / 有坏行 / 只读了尾部）→ 记 **未测**，不许当成「没有」。
    let outboundFold = { folded: 0, plan: { entries: [], untested: null } };
    try {
      outboundFold = foldInto(sess, chatId);
      const p = outboundFold.plan;
      if (outboundFold.folded) {
        const ids = p.entries.map((e) => (e.message_ids ?? []).join('+') || '(无 id)').join(', ');
        console.log(`[agent] ↩ 补记外发 ${outboundFold.folded} 条进会话记忆：${ids}`);
      } else if (p.untested) {
        console.log(`[agent] ⚠️ 补记外发未测：${p.untested}`);
      } else {
        console.log(`[agent] · 补记外发：无新增（台账里没有「我说过但记忆里没有」的话）`);
      }
    } catch (e) {
      // 补记失败不该让这次回话失败 —— 但那一定是**未测**，不能静默。
      console.log(`[agent] ⚠️ 补记外发未测：这一步抛了 ${e?.message ?? e}`);
      outboundFold = { folded: 0, plan: { entries: [], untested: `抛异常：${e?.message ?? e}` } };
    }

    // Explicit readability questions finish before P0, review and the general
    // model/tool loop. The early receipt uses this same submission classifier.
    // Keep the branch on forced replay too: retry must not change user intent.
    const accessGate = reviewGate.isSubmission({ text: inbound.text,
      imageCount: inbound.imageCount, videoCount: inbound.videoCount });
    if (['link-access', 'link-access-clarify', 'link-access-skip'].includes(accessGate.guard)) {
      const access = await readLinkAccess(accessGate, linkReader);
      const previousUser = [...sess.messages].reverse().find((m) => m.role === 'user');
      if (!force || previousUser?.content !== userText) {
        mem.append(sess, { role: 'user', content: userText, name: senderName, message_id: msg.message_id });
      }
      appendAssistant(sess, { role: 'assistant', content: access.reply, link_access: true });
      mem.save(sess);
      flushSeen();
      console.log(`[agent] 🔗 读取确认：${accessGate.guard}｜读到 ${access.results.filter((r) => r.ok).length}/${accessGate.links.length} 条`);
      return { reply: access.reply, reason: 'ok', sessionKey: key,
        meta: { gate: accessGate, linkAccess: { ok: access.ok, results: access.results },
          toolTrace: [], chain: { ran: false, ms: 0, publish: null },
          media: { images: inbound.imageCount, videos: inbound.videoCount },
          verdict53: null, reportLink: null, reviewFailure: null,
          turns: mem.countTurns(sess), messages: sess.messages.length } };
    }

    // ── 5.5 「这条消息在回复哪一句」—— 把上文摆到模型面前（2026-09-22 加）
    //
    // ★ 为什么必须有这一步（一次真实的外部误答，不是推演）：
    //   09-22 14:37:55 我方主动推送问了「117 条签核归谁」；她 14:39:34 用**话题回复**答「归我」。
    //   `im.message.receive_v1` 事件里 `parent_id` / `root_id` **都指着我方那条消息** ——
    //   飞书把线索完整送来了。而 `ws_daemon.mjs` 的 `onMessage` 从不读这两个字段，
    //   加上主动推送不进会话记忆（`memory.append` 只在回复循环里调），
    //   模型看到的是一句**悬空的「归我」**，往上接到 27 小时前的话题上，
    //   14:39:51 答成了「那三条过期内容归你」并**发了出去**。
    //
    //   两条根因里，这一条**不碰 import 图、不用改 memory.append** ——
    //   一次回读就能让守衡看见自己问过什么（实测机器人读得回自己发的消息，
    //   含 `send_once.mjs` 发的主动推送，见 PMO/守衡-误答登记-20260922.md §3.2.1）。
    //
    // ⚠️ 三种情形必须在**日志里长得不一样**（取不到 ≠ 没有上文）：
    //   · 不是回复        → 不引（正常）
    //   · 已在会话历史里  → 不引（避免同一个上文出现两遍）
    //   · **读不到**      → 说「未测」，不许当成「没有上文」
    let parentBlock = null;
    const parentId = parentIdOf(msg);
    if (parentId) {
      const parent = await feishu.getMessage(parentId);
      if (parent?.error) {
        // ⚠️ **不能静默降级。** 她很可能正是在答一句我们读不到的话；
        // 这时「装作没有上文」与「以为没有上文」都会重演 14:39 那次误答。
        // 也不能只说一句"读不到"就完 —— 得告诉模型**这时该怎么做**，
        // 否则它仍会自己找一句最近的话接上去（那正是上次发生的事）。
        console.log(`[agent] ⚠️ 引用上文未测：回读 ${parentId} 失败（${parent.error}）`);
        parentBlock = [
          '〔引用上文 · 未测〕对方这条消息是在回复某一条，但**我读不到那一条**。',
          `· 回读 ${parentId} 失败：${parent.error}`,
          '· 所以：**不要在看不见上文的情况下猜她在答什么**，也不要把最近说过的一句当成她答的那一句。',
          '  要接话就先说清"你回复的那条我读不到"，再问她是哪一件事。',
          '〔引用上文结束〕',
        ].join('\n');
      } else if (!alreadyInHistory(sess.messages, parent.text)) {
        parentBlock = buildQuoteBlock({
          from: parent.from,
          text: parent.text,
          at: parent.at,
        });
        console.log(`[agent] ↩ 引用上文 ${parentId}（${parent.from}｜${parent.text.length} 字）`);
      } else {
        console.log(`[agent] · 引用上文跳过：${parentId} 的内容已在会话历史里`);
      }
    }

    // ── 5.9 **送审闸门**：内核先跑链，再让模型说话（见 `runSubmissionGate` 的头注）
    //
    // ★ 2026-10-05 现场踩到的坑，逐字记下来：把闸门抽成函数时，**把 `let gate = null;`
    //   那四行声明一起抽走了**，于是这里变成对**未声明标识符**赋值 —— ESM 是严格模式，
    //   直接 `ReferenceError: gate is not defined`。后果不是「少一个字段」，是：
    //   **链跑完 17.9 分钟、然后内核在回话前一刻崩掉**，人收到的是
    //   「我处理这条消息时内部出错了…gate is not defined」，而链的结论被丢掉。
    //   为什么自证没拦住：`runSubmissionGate` 自己测过（它是好的），
    //   接线断言只查了「handleMessage 里有没有调用它」—— **而崩溃发生在调用之后那一行**。
    //   补的判据见 `tools/test_agent.mjs` 第 18 组那条 `子进程端到端`：
    //   它真跑一遍 handleMessage（LLM 指向死地址、KB 根指向不存在），
    //   所以「调用之后还有没有塌」从此有人看着。
    // ★ 2026-10-08：**这一轮的边界** —— 清掉上一轮「链已经跑过」的记忆。
    //
    //   必须在这里（**调闸门之前**），理由有两条，缺一条都会答错：
    //     ① 闸门自己就要跑链，跑完那一次会**装上**缓存 —— 清空得比它早。
    //     ② 一轮 = 一条入站消息 = 一次送审。上一轮的结论若漏到这一轮，
    //        守衡会拿**一张没审过的图**的结论去答话 —— 方向不对称：
    //        漏跑只是慢，串轮是答错。
    //   另一条绕过这里的路径由 `tools.mjs` 的 TTL 兜（两道独立护栏）。
    // ★★ 2026-10-20（Owner 逐字：「用户送审图片时，content_type 必须要标注下是图片」）：
    //   同一处把**本轮素材模态**交给链 —— 由 `inbound` 的**实际入站内容**算出，
    //   不再由 headless 里的模型按模板「三选一」自己猜。
    //   实测（同日、同一份图 OCR，只差这一个词）：text → PASS/0 条；image → REVIEW/5 条。
    //   ⚠️ 视频这一档**不传**（保持原样）：视频要 5 个模态的 provider 佐证，本单没有那些读数，
    //     硬填会让视频单被 fail-closed 压成拒答 —— 那是另一件事，不混进这一改。
    const _chainModality = (inbound?.videoCount ? null
      : (inbound?.imageCount ? 'image' : 'text'));
    const chainMemoPrevHits = beginChainTurn({ modality: _chainModality });
    if (chainMemoPrevHits > 0) {
      console.log(`[agent] · 上一轮链缓存命中 ${chainMemoPrevHits} 次（这一轮已复位）`);
    }
    // ★★ 2026-10-16（FIX-043）：**同一处、同一套理由** —— 本轮 P0 快路读数也要清零。
    //   不清的后果比链缓存那条更直接：上一轮命中的那份 PRD §5.3.3 块会被当成
    //   **这一轮**的结论上卡（`g.verdict53` 为空时兜底要读它）。
    beginP0Turn();
    // ★★ 2026-10-19：链回执**同一处清零**（同一条理由：上一轮的结论不许漏到这一轮）。
    //   不清的后果与时 P0 读数那条一模一样 —— 上一单的 `answer` 会被当成这一轮的结论行。
    beginChainAnswerTurn();
    const g = await runSubmissionGate({ inbound, question, userText, notify, chainRunner, publishRunner, modelSideRunner, imageClaimRunner,
                                    publicationContext,
                                    mergedReportRunner, adviceRunner, linkReader, force,
                                    // ★ 目标 19：把「消息到达时刻」带进闸门，好量「@ → 回执卡」那一段。
                                    //   没给就退回此刻（并会被标成 origin=handle_entry，不许当 ingress 报）。
                                    tIngress: tIngress ?? Date.now(),
                                    // ★★ 2026-10-20（Owner 批准 ①+②）：回执**已经**在读素材之前发过 ⇒
                                    //   闸门不许再发第二张；来源跟着传，指标行里能看出用的是哪个时刻。
                                    ackSentAt: earlyAckAt,
                                    // ★★ 2026-10-21（Owner）：P0 预判命中 ⇒ 闸门**不许**补发回执，
                                    //   也**不许**起模型侧双轨（PRD §6.3：命中即停止后续审查）。
                                    p0PreHit,
                                    tIngressOrigin });
    const gate = g.gate;
    const chainRan = g.chainRan;

    // ══════════════════════════════════════════════════════════════════════════
    // ★★ 2026-10-16（FIX-044）：闸门判「**不起链**」时，P0 由**内核自己**跑一遍。
    // ══════════════════════════════════════════════════════════════════════════
    // 真事故（同一个群、同一句话，问了两遍，**两遍都不一样**）：
    //   · 17:19 —— 闸门不起链（`meta-ask`），模型**自己**调了 `kb_review_chain`
    //     ⇒ 链返回里那份 §5.3.3 块在，卡面 180 字（格式不符：一段都没搬进卡）；
    //   · 19:4x —— 闸门**同一条**判词，模型**没调**（原话「重跑会往飞书再加一行，故未重跑」）
    //     ⇒ **链返回整个不存在** ⇒ 连条款号都只剩模型转述，卡面 163 字。
    // ⇒ 病灶不是"格式没对上"，是 **P0 判据此前只能由「模型愿不愿意调工具」触发**。
    //   模型这次的理由还很正当（不想重复写飞书行）—— 而 PRD §6.3 第一层说的恰恰是
    //   「**命中即停止后续审查，直接输出 BLOCK**」：它是**判据**，不是模型的自选项。
    //
    // 为什么只在 `!gate.yes` 时跑（两条路各自唯一的 P0 来源，不重复跑）：
    //   · `gate.yes === true` ⇒ 闸门自己会调 `kb_review_chain`，工具内**本来就在跑**
    //     同一条快路（`runP0Preflight`），跑完那份读数由 `p0Memo` 交上来；
    //   · `gate.yes === false` ⇒ 上面那件事**没有任何人做** ⇒ 这里补上。
    //   ⚠️ 快路**只读**（模式表 + L4 canonical + L0 记录），不抢库锁、不 spawn agent、
    //     不产生任何新行；命中同一份素材时报告**按内容 ID 复用**（`p0HitPayload` 那一跳），
    //     ⇒ 正好回答了模型那个顾虑：**同一句话再问一次不会多写一行**。
    //   ⚠️ 失败/超时**一律按未命中算**（回 `null`），一个字都不许因此拦住正常回话。
    let p0Preflight = null;
    if (!gate?.yes) {
      try {
        p0Preflight = await runP0Preflight({ text: userText ?? question ?? '', question });
      } catch (e) {
        console.log(`[agent] ⚠️ P0 前置没跑成（按未命中算，正常回话）：${e?.message ?? e}`);
        p0Preflight = null;
      }
    }

    // ⚠️ 2026-10-08：`chainUnmeasured` 由**另一个会话**在同一文件里声明（见下方 `let`）——
    //    两边同时改同一个文件撞过一次（重复声明 → SyntaxError）。这里不再重复声明。
    const chainMs = g.chainMs;
    question = g.question;

    // ★★ 2026-10-08 修（**实测崩溃，不是推演**）—— `chainUnmeasured` 的**提前声明**。
    //
    //   现场：素材「这条站内广告文案能不能发：M6 吸奶器静音设计，夜里泵奶不吵醒宝宝，
    //   一次充电够用一整天」（10:24 那一轮）——**库侧成功了**（旁挂 `REVIEW/1`、表已 update），
    //   但出卡阶段内核崩了：
    //     `✗ 内核异常: ReferenceError: Cannot access 'chainUnmeasured' before initialization`
    //     `at agent.mjs:1436:37`
    //   ⇒ **那一单在群里没有回复**（崩溃后日志再无输出），而且没有任何东西会红。
    //
    //   成因：同一天早些时候的改动把**三处截断/兜底分支**里的内联判据
    //   `gate?.yes && !chainRan` 统一换成了 `chainUnmeasured`（判据本身**是对的、更严格**：
    //   库忙时链是「跑成」返回的，`!chainRan` 会漏掉那一整类）——
    //   但那三处（`~:1425` / `~:1453` / `~:1510`）在函数体里**早于** `const chainUnmeasured`（`~:1578`）
    //   的执行位置 ⇒ **TDZ**：`const`/`let` 在那行之前处于「已声明未初始化」，读它就是 ReferenceError。
    //   **判据没错，位置错了。**
    //
    //   修法：把这个变量提前到**闸门刚回来**的地方声明（此刻 `g.verdict53` 已经定了），
    //   终值仍在原处**重新赋值**（那里额外能拿到 `verdict53Final` 的 `derive` 回落）。
    //   ⚠️ 为什么不干脆把整条 `const` 往上挪：`verdict53Final` 依赖 `reply`，而 `reply`
    //      要等这一轮跑完 —— 早于它的只有 `g?.verdict53` 这一半，够这三处用。
    /** 闸门判了送审、但（此刻还）没有三态结论 ⇒ 这一轮不是答案，补发队列应当重跑。 */
    let chainUnmeasured = !!(gate?.yes && !g?.verdict53);

    const userTurn = chatType === 'group' ? `【${senderName}】${question}` : question;
    const turnContent = parentBlock ? `${parentBlock}\n\n${userTurn}` : userTurn;
    // ★ `force`（补发）时**不重复 append 同一个用户轮**：上一轮失败前已经 append 过一次
    //   （失败发生在工具循环里，用户轮早在它之前就进内存了），再 append 一次会让守衡
    //   「记得她问了两遍」。判据是「最后一条 user 轮与本次逐字相同」，不是「force 就不 append」——
    //   万一上次是在 append 之前就崩了，这一轮必须把问题补进记忆，否则它就真丢了。
    const lastUser = [...(sess.messages ?? [])].reverse().find((m) => m?.role === 'user');
    if (force && lastUser && lastUser.content === turnContent) {
      console.log('[agent] ↩ 补发重放：用户轮已在记忆里，不重复 append');
    } else {
      mem.append(sess, { role: 'user', content: turnContent, name: senderName });
    }

    // ── 6. 工具循环
    const systemPrompt = buildSystemPrompt(
      chatType === 'group'
        ? `\n# 当前场景\n你在群聊「${sess.title ?? chatId}」里，正在回复 ${senderName}。群里其他人也会看到你的回答，所以不要输出私密信息，也不要假设只有一个人在听。`
        : `\n# 当前场景\n你在与 ${senderName} 私聊。`,
      { workflowQuestion: gate?.guard === 'meta-ask' }
    );

    const toolTrace = [];
    const workflowMechanismReply = reviewGate.reviewWorkflowMechanismAnswer(question, gate);
    if (workflowMechanismReply) console.log('[agent] 🧭 三类审核流程问答：按当前工作流代码直接答复（不起审核链）');
    const allowReviewDirect = String(process.env.SHOUHENG_REVIEW_DIRECT_REPLY ?? '1').trim() !== '0';
    const reviewDirect = allowReviewDirect ? (g.reviewDirectReply ?? null) : null;
    let reply = g.forcedReply ?? g.p0DirectReply ?? reviewDirect ?? workflowMechanismReply ?? null;
    // ★★ 2026-10-21（Owner：「P0 命中就直接先返回结论」「一条消息只回一条结论」）——
    //   走到这里 `reply` 已非空 ⇒ 下面那个工具循环（`for (…; reply === null; …)`）
    //   **一次都不会跑**：不调模型、不花那 p50 42 秒，卡面与结论一个字节都不变
    //   （卡面本来就由代码从 `verdict53` 拼，模型那 3000 字从不上卡）。
    if (g.forcedReply) appendAssistant(sess, { role: 'assistant', content: g.forcedReply, link_read_failed: true });
    else if (g.p0DirectReply) {
      // 记忆里也要有这一条：否则下一轮问「你刚才判了什么」，它只剩链块、没有自己说过的话。
      appendAssistant(sess, { role: 'assistant', content: g.p0DirectReply });
      console.log('[agent] ⚡ P0 确定性命中 ⇒ 本回合**不调模型**：回复＝§5.3 结论块原文（'
        + g.p0DirectReply.length + ' 字）｜卡面仍由代码按 §5.3 拼');
    } else if (reviewDirect) {
      appendAssistant(sess, { role: 'assistant', content: reviewDirect });
      console.log('[agent] ⚡ 送审单已有完整 §5.3 结论块 ⇒ 本回合**不调主模型重复写散文**（'
        + reviewDirect.length + ' 字，省 50~90s 空转）｜卡面由代码按 §5.3 拼');
    }
    let llmError = null;
    let llmFailure = null;             // ★ 整条失败体（layer/chain/attempts/retryable），不只那句 error
    let truncated = false;
    let toolExhausted = false;         // ★ 走没走兜底话术（决定 reason，`retry_queue` 靠它补发）
    // ★ 2026-10-08：**「链跑成」不等于「有结论」**。
    //   真事故（Owner 截图）：库忙（认领被占）时链**正常返回**（日志写 `🧭 送审链返回：跑成`），
    //   而旁挂是 `state=NEEDS_INPUT / reason_code=claim_busy` —— **一次三态都没有**。
    //   上一轮我把「没测」的判据写成 `!chainRan`，于是这一种**根本不触发**：
    //   卡片照发（「库忙未判」）、补发队列 0 条、**永远不补跑**。
    //   判据改成「**链没给出三态结论**」—— PASS/REVIEW/BLOCK 之外的一切都算没测，
    //   不管它是报错、拒答、库忙还是超时。
    let synthesized = null;            // ★ 走过「兜底合成」的话记下触发原因（tool-iters / empty-length）

    for (let iter = 0; reply === null && iter < config.llm.maxToolIters; iter++) {
      const messages = mem.toLlmMessages(sess, systemPrompt);
      // ★★ 2026-10-20（Owner：「这个慢的问题必须做优化」→ 随后「不要影响现有工作流」）：
      //   这条**先把开关留着、默认不改行为**（`SHOUHENG_REPLY_THINK=off` 才关思考）。
      //   实测（同输入、同 max_tokens，2026-10-20 12:51，`/tmp/bench_thinking.mjs`）：
      //     开思考 **11738ms** / 正文 496 字（reasoning 2123 tok）
      //     关思考 **1978ms** / 正文 493 字 —— **5.9 倍**，产出几乎一致。
      //   为什么敢关：这一轮是**组装与转述**（素材读数 + 链结论 + 逐条建议都已就位），
      //   判据不在模型这边（P0/条款号由引擎给）；思考主要烧在"怎么措辞"上。
      //   回退开关：`SHOUHENG_REPLY_THINK=on` 改回带思考（A/B 对照用，不必改代码）。
      const r = await llm.chat(messages, { tools: TOOL_SCHEMAS, thinking: replyThinking() });

      if (!r.ok) { llmError = r.error; llmFailure = r; break; }

      const m = r.message ?? {};
      const toolCalls = m.tool_calls ?? [];

      if (toolCalls.length === 0) {
        reply = (m.content ?? '').trim();

        // 截断检查：拿到 finishReason 却不用，半句话就会被当成完整回答发出去。
        // 真实事故：779 字回复停在「…里「未做」，日志却记「✓ 已发送」。
        const cut = detectTruncation({ finishReason: r.finishReason, text: reply });

        // ★ 2026-09-30 新增一支：**一个字都没写出来**（`finish_reason=length` + 正文 0 字）。
        //   它与「半句话被腰斩」是两种故障，处置也不同：
        //     · 腰斩 —— 写了一半，材料已经用上，交给 annotateTruncation 标出来即可；
        //     · 空 —— **什么都没说**，而材料在手边。此时该做的是**关掉工具再写一次**，
        //       不是把一句「被长度上限截断了」当成回答发进群（事故里就是这么发的，
        //       用户看到的是一条只有说明、没有内容的回复）。
        const empty = reply.length === 0;
        if (empty && cut.cut && toolTrace.length) {
          const s = await synthesizeFromTools({ systemPrompt, messages, why: 'empty-length' });
          synthesized = 'empty-length';
          const got = s.ok ? String(s.text ?? '').trim() : '';
          const rTok = s.usage?.completion_tokens_details?.reasoning_tokens ?? null;
          console.warn(
            `[agent] ⚠️ 模型烧光额度没写出正文（${cut.reason}）→ 已折叠工具返回体、关掉工具重写一次`
            + `｜工具结果 ${messages.filter((x) => x.role === 'tool').length} 份`
            + `｜重写后正文 ${got.length} 字｜reasoning ${rTok ?? '?'} tok`
            + (got ? '' : `｜**重写也没写出正文**${s.ok ? '' : `（失败：${s.error}）`}`)
          );
          if (got) {
            reply = got;
            // 重写这一跳自己也可能被截在半句上 —— 同一把尺子再量一次，不搞双重标准。
            const cut2 = detectTruncation({ finishReason: s.finishReason, text: reply });
            if (cut2.cut) { reply = annotateTruncation(reply, { reason: cut2.reason }); truncated = true; }
            // ★ 带上 `truncated` 这个**结构标记**（见 retry_queue.mjs 的 NOT_AN_ANSWER_FLAGS）：
            //   截断说明长得像一条回答，不带标记的话补发队列会以为她已经答过了。
            appendAssistant(sess, { role: 'assistant', content: reply,
                                    ...(truncated ? { truncated: true } : {}),
                                    ...(chainUnmeasured ? { chain_not_run: true } : {}),
                                    ...reasoningToPassBack(s.message) });
            break;
          }
          // 重写仍是空 → **这一轮真的没有答案**。落回兜底话术（它至少是一句人话），
          // 不是把一句「被截断了」当成回答 —— 事故里发进群的那条正是后者：
          // 通篇只有说明、没有一个字的答案，而她还以为那是全部内容。
          console.warn('[agent] ⚠️ 兜底合成也没写出正文 → 改用兜底话术（这一轮确实没答上来）');
          toolExhausted = true;
          reply = fallbackReply(toolTrace);
          appendAssistant(sess, { role: 'assistant', content: reply, tool_exhausted: true, truncated: true,
                                  ...reasoningToPassBack(m) });
          break;
        }

        // ★★ 2026-10-16：**这一轮没用过工具**（`toolTrace` 为空）时也要处置。
        //   上面那一支要求 `toolTrace.length`，于是「空正文 ＋ 额度耗尽 ＋ 没调工具」
        //   直接落到下面的通用分支 —— 而通用分支只会**附一句截断说明**，
        //   于是那句说明**自己成了回答**：正文 0 字，群里收到的是一条只有说明的消息。
        //   实测（离线重跑对接人那张图，2026-10-16 16:16，`finish_reason=length`、
        //   `reasoning 12000 tok`、正文 0 字，而报告本身是完整的）。
        //   处置与上面那支同理但手段不同：这一轮没有工具结果可折叠，
        //   额度是被**推理**吃光的 ⇒ **关掉思考再写一次**（`thinking` 透传见 `llm.mjs`）。
        if (empty && cut.cut && !toolTrace.length) {
          console.warn(`[agent] ⚠️ 模型烧光额度没写出正文（${cut.reason}）且这一轮没调工具`
            + ` → 关掉思考重写一次`);
          const again = await llm.chat(messages, { thinking: { type: 'disabled' } });
          const got = again.ok ? String(again.message?.content ?? '').trim() : '';
          const rTok2 = again.usage?.completion_tokens_details?.reasoning_tokens ?? null;
          console.warn(`[agent] · 关思考重写：ok=${again.ok}｜正文 ${got.length} 字`
            + `｜reasoning ${rTok2 ?? '?'} tok` + (again.ok ? '' : `｜失败：${again.error}`));
          if (got) {
            reply = got;
            const cut2 = detectTruncation({ finishReason: again.finishReason, text: reply });
            if (cut2.cut) { reply = annotateTruncation(reply, { reason: cut2.reason }); truncated = true; }
            appendAssistant(sess, { role: 'assistant', content: reply,
                                    ...(truncated ? { truncated: true } : {}),
                                    ...(chainUnmeasured ? { chain_not_run: true } : {}),
                                    ...reasoningToPassBack(again.message) });
            break;
          }
          // 重写仍是空 → 落兜底话术（至少是一句人话）。**不许把空正文配上说明发出去。**
          console.warn('[agent] ⚠️ 关思考重写也没写出正文 → 改用兜底话术（这一轮确实没答上来）');
          toolExhausted = true;
          truncated = true;
          reply = fallbackReply(toolTrace);
          appendAssistant(sess, { role: 'assistant', content: reply, tool_exhausted: true, truncated: true,
                                  ...reasoningToPassBack(m) });
          break;
        }

        if (cut.cut) {
          const reasoning = r.usage?.completion_tokens_details?.reasoning_tokens ?? null;
          console.warn(
            `[agent] ⚠️ 回复被截断：${cut.reason}` +
            `｜正文 ${reply.length} 字｜reasoning ${reasoning ?? '?'} tok` +
            `｜结尾「${tailOf(reply)}」`
          );
          // ★ 最后一道闸：**空正文永远不许只带一句说明出门**（上面的分支都 break 了，
          //   能走到这里的只剩「有正文被腰斩」；这一行是防以后有人改动上面那两支时的兜底）。
          if (!reply) {
            toolExhausted = true;
            reply = fallbackReply(toolTrace);
          } else {
            reply = annotateTruncation(reply, { reason: cut.reason });
          }
          truncated = true;
        }

        appendAssistant(sess, { role: 'assistant', content: reply,
                                ...(truncated ? { truncated: true } : {}),
                                ...(chainUnmeasured ? { chain_not_run: true } : {}),
                                ...reasoningToPassBack(m) });
        break;
      }

      // 有工具调用：把 assistant 的 tool_calls 存进历史，再逐个执行
      appendAssistant(sess, { role: 'assistant', content: m.content ?? '', tool_calls: toolCalls,
                              ...reasoningToPassBack(m) });

      for (const tc of toolCalls) {
        const name = tc.function?.name;
        const t0 = Date.now();
        // ★★ 2026-10-16（FIX-043）：**工具调用要能被注入**。
        //   为什么非加不可：这一条缺陷（P0 单上不了 §5.3 块）的判据**只在接线上**，
        //   而那一段在此前**没有任何缝**能喂桩 —— `executeTool` 是直接 import 的，
        //   `deps` 在别处注入得再多也到不了这里。于是"接线对了没有"只剩下**源码文本断言**，
        //   正是 §2.4 点名的假执行点（FIX-021 就是栽在这上面）。
        //   ★ 这**不是**把生产逻辑搬走：默认值就是原本那一行，生产调用点一个字不用改。
        //   ★ 只有**一处**：`deps.executeTool` 就是「怎么调工具」的唯一默认值
        //     （与 `chainRunner` 那条纪律同源 —— 两处默认值会各自漂移，见上面那段头注）。
        const out = await (deps?.executeTool ?? executeTool)(name, tc.function?.arguments);
        toolTrace.push({ tool: name, ok: out.ok, ms: Date.now() - t0,
                         args: String(tc.function?.arguments ?? '').slice(0, 300),
                         error: out.ok ? undefined : out.error });
        // ★ 工具返回体的**最后一道字数闸**就设在这里（§2.4：上限必须有执行点）。
        //   `executeTool` 收口处已经剪过（`boundToolResult`），这里是**独立**的一道 ——
        //   因为「工具自己守规矩」不该是这条不变量成立的前提：任何一条路径把
        //   大对象塞进 memory，都会在下一次请求里挤掉模型的正文额度。
        //   实测：60,349 字工具结果 → 模型 reasoning 8000 tok、正文 0 字。
        const raw = JSON.stringify(out.ok ? out.result : { error: out.error });
        const body = raw.length > TOOL_OUTPUT_MAX_CHARS
          ? clipToolOutput(raw)
          : raw.slice(0, 60_000);
        if (raw.length > TOOL_OUTPUT_MAX_CHARS) {
          console.warn(`[agent] ⚠️ 工具返回体超预算：${name} ${raw.length} 字 → 入库前截到 ${TOOL_OUTPUT_MAX_CHARS} 字`);
        }
        mem.append(sess, { role: 'tool', tool_call_id: tc.id, content: body });
      }
      // 循环继续：让模型看到工具结果后决定是继续查还是作答
    }

    if (reply === null && !llmError) {
      // ── 工具循环用尽。**先试「兜底合成」，再考虑兜底话术**（2026-09-30 加）
      //
      // 原先是直接跳到兜底话术：「这个问题我没答上来 —— 查了几轮，还是没能得出可靠结论」。
      // 而 19:05 那次实测里，**工具 12 次调用一次都没失败**（`其中失败 0 次`），
      // 材料全都读到手了 —— 说「没答上来」对她是误导，对我方是**白丢一次本来能答的机会**。
      // 现在先关掉工具让它用手上的材料写一遍；只有**它也写不出来**才说兜底话术。
      const messages = mem.toLlmMessages(sess, systemPrompt);
      const s = await synthesizeFromTools({ systemPrompt, messages, why: 'tool-iters' });
      const got = s.ok ? String(s.text ?? '').trim() : '';
      synthesized = 'tool-iters';
      console.warn(
        `[agent] ⚠️ 工具循环用尽：上限 ${config.llm.maxToolIters} 轮 / 实调 ${toolTrace.length} 次`
        + `｜工具 ${[...new Set(toolTrace.map((t) => t.tool))].join(',') || '（无）'}`
        + `｜其中失败 ${toolTrace.filter((t) => !t.ok).length} 次`
        + ` → 已折叠工具返回体、关掉工具让它用手上的材料写一次：正文 ${got.length} 字`
        + (got ? '' : `（也没写出来${s.ok ? '' : `：${s.error}`} → 落兜底话术）`)
      );
      if (got) {
        reply = got;
        const cut2 = detectTruncation({ finishReason: s.finishReason, text: reply });
        if (cut2.cut) { reply = annotateTruncation(reply, { reason: cut2.reason }); truncated = true; }
        appendAssistant(sess, { role: 'assistant', content: reply,
                                ...(truncated ? { truncated: true } : {}),
                                ...(chainUnmeasured ? { chain_not_run: true } : {}),
                                ...reasoningToPassBack(s.message) });
      } else {
        toolExhausted = true;
        // 工具循环用尽仍未给出最终答复。文案见 `fallbackReply()` —— 它有一条硬约束
        // （不许出现工具名），由 `verify_cards.mjs` 的 L6 断言。
        reply = fallbackReply(toolTrace);
        // 工具名只进日志：可排查，但**不进正文**（正文那份由上面那个函数产生）。
        // ★ `tool_exhausted` 是**结构标记**，与 `llm_error` 同一用途：告诉补发队列
        //   「这条 assistant 不是真回答」。没有它，`answeredInMemory()` 会把兜底话术
        //   当成真回答，于是「答不上」就真的变成「永远答不上」——
        //   2026-09-22 她连问两次都得到兜底话术，而队列一条都补不出去。
        appendAssistant(sess, { role: 'assistant', content: reply, tool_exhausted: true,
                                ...reasoningToPassBack(s.message) });
      }
    }

    // ── 7. 压缩与落盘
    //
    // ★★ 2026-10-21（Owner：「必须 10 秒内回」）——**P0 直达这一轮不压缩**。
    //
    //   病灶（上线后第一单的实测读数，`[metric] direct_answer_ms=32864 … verdict=FAIL`）：
    //   判定只花 3.3 s，而卡走了 **32 s**。差的不是判定，是这一行 ——
    //   `mem.compact(sess, llm.summarize)` 要**调模型**把上千条旧消息写成纪要
    //   （实测 27.7 s，`🗜 历史已压缩（保留 24 轮（1288 条）…）` 就紧挨在发卡之前）。
    //   而 P0 直达这一轮**压根不调模型**（没有上下文要用）⇒ 压缩在这一轮是**纯亏 28 秒**。
    //   ⇒ 顺延到下一次真要模型的回合（`compact()` 自带 `messages.length <= triggerAt` 的早退，
    //     「这一轮没压」不会丢任何东西 —— 它本来就只是"历史太长就摘要"的维护动作）。
    //   ⚠️ `mem.save(sess)` 照旧：这一轮的问答必须立刻落盘（不然下一轮它会不记得自己判过）。
    // 图片未完成的确定回复也不需要生成上下文。失败之后再压缩历史，
    // 会让用户额外等一次模型请求；原始问答仍在下面立即保存。
    const directReplyTurn = !!(g.forcedReply || g.p0DirectReply || reviewDirect);
    let compacted = false;
    if (directReplyTurn) {
      console.log('[agent] ⏭ 历史压缩顺延（本回合不调模型 ⇒ 没有上下文要用；'
        + '下一次需要模型的回合再压）｜当前 ' + (sess.messages?.length ?? 0) + ' 条');
    } else {
      try { compacted = await mem.compact(sess, llm.summarize); }
      catch (e) { console.error('[agent] 压缩异常', e?.message ?? e); }
    }
    mem.save(sess);
    // 去重表必须**立即**落盘：只在退出时写的话，进程被 kill -9 时这次消息不在表里，
    // launchd 拉起后服务端若重推同一条，守衡会重复回话。
    flushSeen();

    if (llmError) {
      const notice = `我这边调用模型失败了，没法回答这个问题。\n\n失败原因：${llmError}\n\n（这是我的问题，不是你的输入有问题。）`;
      // ★ 1c（2026-09-22 加）：**群里看得见的话，记忆里必须也有**。
      //   原先这个分支直接 return，`mem.append` 只在回复循环里调 —— 于是守衡事后想不起
      //   自己说过「答不了」：她 15:40 问「你刚才为什么说答不了」，它的会话里只有
      //   她 15:29 的问题和 15:42 的正常答复，中间那次失败**在它的记忆里不存在**。
      //   `llm_error: true` 是给补发队列看的**结构标记**（不是靠比对那句文案）：
      //   「这条 assistant 不是真回答」。`toLlmMessages` 只取 role/content，不会漏给模型。
      mem.append(sess, { role: 'assistant', content: notice, llm_error: true });
      mem.save(sess);
      return { reply: notice, reason: 'llm_error', sessionKey: key,
               // ★ 2026-10-05 补：这一条原先**不带** `gate` / `chain` / `media` ——
               //   于是「模型这一跳失败」的时候，`mediaWithoutChain()` 那条棘轮读不到闸门读数，
               //   只能闭嘴。而「链跑了、模型又失败」恰恰是最该被看见的一种：
               //   结论算出来了、却没送到人手上。读数缺一格，警报就少一处。
               meta: { toolTrace,
                       reviewFailure: g?.reviewFailure ?? { stage: 'reply_generation', code: 'reply_service_error',
                         retryable: llmFailure?.retryable === true, detail: null, related: [] },
                       reviewDecisionWithheld: g?.reviewDecisionWithheld === true,
                       verdict53: g?.verdict53 ?? null,
                       reportLink: g?.dual?.reportUrl ?? null,
                       imageGateReason: [inbound.imageGateReason, inbound.videoGateReason].filter(Boolean).join('；') || null,
                       media: { images: inbound.imageCount, videos: inbound.videoCount },
                       gate: gate ? { yes: gate.yes, kind: gate.kind, why: gate.why } : null,
                       chain: gate?.yes ? { ran: chainRan, ms: chainMs,
                                        publish: g.publish ? { ok: g.publish.ok,
                                                               action: g.publish.action,
                                                               record_id: g.publish.record_id ?? null } : null } : null,
                       llm: { layer: llmFailure?.layer ?? '未知',
                                        retryable: llmFailure?.retryable === true,
                                        attempts: llmFailure?.attempts?.length ?? 0,
                                        chain: llmFailure?.chain ?? [] } } };
    }

    // ── 「这一单**到底有没有三态结论**」——报错、拒答、库忙、超时都算「没有」 ──────────
    //
    // ★ 2026-10-08 修。上一轮我把判据写成 `!chainRan`（= 链报错），漏掉了一整类：
    //   **库忙（认领被占）时链是「跑成」返回的**（日志写 `🧭 送审链返回：跑成`），
    //   而旁挂是 `state=NEEDS_INPUT / reason_code=claim_busy` —— 一次三态都没有。
    //   后果（Owner 截图那一单）：卡片照发「库忙未判」、**补发队列 0 条、永远不补跑**。
    //   判据改成「链有没有给出 PASS/REVIEW/BLOCK」—— 比 `!chainRan` 严格得多，
    //   而且**不依赖任何字符串猜测**：`verdict53` 只可能由三态结论行（或 P0 派生）产生，
    //   `NEEDS_INPUT` 那一类根本没有 §5.3 行可抽（`LINE_RE` 只认三态）。
    // ★★ 2026-10-16（FIX-043）：兜底那一支**必须带上这一轮 P0 快路的读数**。
    //
    //   真单（`om_x100b622a8e762cbcce3b9bfa8402ccb`，群里「m5 pro是最好的吸奶器」）：
    //   闸门判「不是在送审、是在问审查怎么运作」⇒ `g.verdict53 = null` ⇒ 落到这一支，
    //   而这一支此前**只喂 `replyText`** ⇒ 结论行取决于**模型有没有把链那行抄进回复**。
    //   那一单模型没抄（它写 `**结论：BLOCK —— 共 1 处必须修改。**` 加自己的分组），
    //   于是 `verdict53Final = null` ⇒ 信封层 `reviewShape=false` ⇒ 卡上**一个字的
    //   PRD §5.3 逐条块都没有**，只剩模型自拟的四组折叠摘要。Owner 报的就是这条。
    //
    //   判据本来就写好了（`prd53.deriveVerdictLine` 第 ② 支专门派生 §5.3.3 那一行），
    //   `W1` 也一直在喂它 —— 缺的是**把它接上**（与 FIX-021 同一个形状）。
    //   `p0MemoRead()` 拿的是 `kb_review_chain` 真正返回的那份渲染好的块
    //   （`kb/l5/p0_fastpath.py --json` 的 `rendered`，走 `p0_findings` 同一趟），
    //   不是从中文里抠 —— 库里那条规矩：结论与条数只读结构化字段。
    //   ⚠️ `reviewedByTool` 仍然要着：它管的是「这一轮真的调成了链」，
    //     而 P0 读数只可能由**真的跑过那一次**产生（`executeTool` 里装的），两者同时成立。
    //
    // ★★★ 2026-10-16（FIX-044）：**两个来源各自唯一，缺一个就会出现「同一条缝第二次」**。
    //   上面那段（FIX-043）修的是「链跑了、但结论行寄在模型措辞上」；
    //   而 19:4x 那一单证明还有第二种走法：**链压根没跑**（模型不肯重跑），
    //   于是 `p0Payload` 是空的、`verdict53Final` 又是 null —— 同一张 163 字卡。
    //   ⇒ 现在 `!gate.yes` 时内核**自己**跑过一遍 `runP0Preflight()`（见上面那一跳），
    //     它回的那一份与工具返回体**同形**，所以这里读法完全一样。
    const p0Payload = p0MemoRead()
      ?? (p0Preflight
            ? { answer: p0Preflight.answer, p0Fastpath: p0Preflight.p0_fastpath }
            : null);
    // ★★ 2026-10-19（Owner：「守衡输出的卡片内容怎么又改了？赶紧改回去」）——
    //   兜底那一支**必须带上链自己的回执**，不能只带 P0 快路那半份。
    //   真单（`om_x100b6269bad188e8cf248ad8931a610`，27 字）：闸门没判送审、模型自己调了链、
    //   链回执里逐字带着合 §5.3 的 PASS 行；而 `p0_fastpath` 0 命中 ⇒ `p0Payload=null`
    //   ⇒ 这一支只拿得到 `replyText` ⇒ 结论行全看模型抄没抄 ⇒ `conforms()` 不过 ⇒ `null`
    //   ⇒ 卡面退回模型那张 `query-answer`（后台词一并上卡）。
    //   ⇒ 现在把 `chainAnswerRead()` 的 `answer` 一起喂进去（与 `p0Memo` 并存、不合并）。
    const chainAnswer = chainAnswerRead();
    const verdict53Final = finalVerdict53ForTurn({
      gateResult: g, p0Payload, toolTrace: toolTrace ?? [], chainAnswer, reply: reply ?? '',
    });
    if (!g?.verdict53 && verdict53Final) {
      // ★ 2026-10-19：这一行原来恒写「P0 快路命中了」—— 而上面新接的那一支根本没有 P0
      //   （0 命中也会走到这里）。**读数说假话比没有读数更坏**（§2.4.2），按真实来源分三档。
      const src = p0Payload
        ? (p0Preflight ? '内核前置' : '模型自调链·P0 快路')
        : (chainAnswer ? '模型自调链·链回执' : '模型自调链·仅回复文本');
      console.log(`[agent] 🧭 闸门没判送审，但拿到了权威结论行（来源=${src}）`
        + `，取数自 ${verdict53Final.from} —— 结论行与逐条块按 §5.3 派生`
        + `（**不靠模型有没有抄、也不靠模型肯不肯调**）：${verdict53Final.line}`
        + `｜逐条块=${verdict53Final.block ? '有' : '**没有**'}`);
    }
    // A withheld result carries one primary failure shared with the card. Media
    // applicability failures must not inherit retry policy from KB coverage.
    // Chain-level refusals keep their own retry policy when media steps never ran.
    const failure = g?.reviewFailure ?? null;
    chainUnmeasured = shouldRetryReview({ meta: {
      gate, verdict53: verdict53Final,
      reviewDecisionWithheld: g?.reviewDecisionWithheld === true,
      reviewFailure: failure,
    } });
    if (gate?.yes && !verdict53Final && !chainUnmeasured) {
      console.log('[agent] 🚫 本轮未完成且未安排自动重试'
        + `｜阶段=${failure?.stage ?? 'unknown'}｜原因码=${failure?.code ?? 'unknown'}`
        + '｜调度与失败卡使用同一结构化原因，需核查或补充依据后再审。');
    }

    return { reply: reply || null,
             // ★ 2026-10-06 加第三种 reason `chain_not_run`（Owner：「每次发图片/视频都必须
             //   能正常回复，不能拒答」）。形状与 09-22 那次的 `tool_exhausted` **一模一样**：
             //   送审单起了链、链却没跑成（库忙 exit 3 / 超时 / 层前置红 / 依据侧没给结论）时，
             //   守衡照样有一条回复（「这一单未测，没有三态结论」）⇒ `reason` 本来是 `ok`
             //   ⇒ `ws_daemon` 的入队判据不收它 ⇒ 补发队列**连队都没进**，
             //   于是「问一次答不上，问十次还是答不上」。
             //   判据与 `chain_not_run` 那个记忆标记**同源**（`gate?.yes && !chainRan`），
             //   两处必须一起动：入队靠 reason，防「答两遍」靠记忆标记。
             reason: reply
               ? (toolExhausted ? 'tool_exhausted'
                  : (chainUnmeasured ? 'chain_not_run' : 'ok'))
               : 'empty_reply',
             sessionKey: key,
             meta: { toolTrace, compacted, summary_chars: (sess.summary ?? '').length,
                     truncated, synthesized,
                     // ★ 2026-10-08：`turns` 原先 = `sess.messages.length` —— 那是**条数**。
                     //   而 `ws_daemon.mjs` 把它印成「保留 N 轮」，于是日志上写着
                     //   「🗜 历史已压缩（保留 130 轮 + 纪要 5249 字）」，真实含义是
                     //   **130 条 ≈ 24 轮**（`config.llm.maxTurns`）。变量名、措辞、
                     //   实际的值三者不一致 —— `AGENTS.md` §2.4.3：说出去的话比依据大。
                     //   现在两个数一起给，各自名副其实：
                     //     `turns`    —— 按 `mem.countTurns` 的口径（几条 `user`，与 `compact` 同源）
                     //     `messages` —— 条数（含 assistant / tool）
                     //   ⚠ 口径只许有一处：要改「轮」的定义就去改 `memory.mjs::countTurns`，
                     //     不要在这里另写一个 filter。
                     turns: mem.countTurns(sess), messages: sess.messages.length,
                     // ★ 这一轮带了几个媒材 —— daemon 拿它问 `mediaWithoutChain()`：
                     //   「读到了、却没起链」这个形状**必须有个读数**，否则它只是一行没出现的日志。
                     media: { images: inbound.imageCount, videos: inbound.videoCount },
                     // ★ 2026-10-05 加：送审闸门自己的读数 —— 判没判、判成什么、链跑成没有、花了多久。
                     //   没有这三个数，「闸门到底有没有生效」就只能靠猜（而猜错的方向是「以为它跑了」）。
                     gate: gate ? { yes: gate.yes, kind: gate.kind, why: gate.why } : null,
                     // ★ 2026-10-13 加：**这一单落到结论表的哪一行**。
                     //   为什么加：本机批跑器要把结论回填进采集表，而媒体行**没法按素材原文认领**
                     //   （图片行送的是 post、链记的「送审问题」是图注；视频行送的是 media、
                     //    链记的是一段生成的块头 ⇒ 文本键结构上对不上；退到时间窗又会捡到
                     //    链侧那行**空的**）。实测栽过两次：`问题数量` 先被写成 0，视频行被写成 PASS/0。
                     //   ⇒ 让内核把**它自己刚写的那一行**报出来，回填就不必猜。
                     //   形态与上面「模型跳失败」那条路**逐字同形**（那边本来就有 publish 这一格）。
                     chain: gate?.yes ? { ran: chainRan, ms: chainMs,
                       publish: g?.publish ? { ok: g.publish.ok, action: g.publish.action,
                                               record_id: g.publish.record_id ?? null } : null } : null,
                     // ★ 2026-10-08 加：「链只跑一次」那条护栏自己的读数。
                     //   没有它，命中只是一个**没出现的日志**（§2.4 那个病）——
                     //   而这件事的代价是十几分钟 + 一次重复写飞书，必须看得见。
                     chainMemo: chainMemoStats(),
                     // ★ 2026-10-09 加：**「问题数」这唯一的那个数**（Owner 的规则要的那一个）。
                     //   抬头（`verdict53.line`）、逐条块、以及 PRD §5.3.4 的
                     //   **报告链接门槛（≥3）** 必须读同一个变量。
                     //   口径 = `dual_track.mjs:1140` 的 `total`：
                     //     **能并的条目 ＋ 库侧有明细但没并进来的（kbGap）＋ 覆盖缺口那 1 条。**
                     //   ⚠ 它不是 `stats.merged`：实测 19:08 那单 `merged=7` 而 `total=12`
                     //     （另有 5 条库侧明细未并进卡里，卡里写了一句话说明）。
                     //   为 null = 这一轮没跑双轨 ⇒ 抬头退回抠块/链的正文，
                     //   行为与改动前逐字相同（反向对照见 `test_agent.mjs` 的 `Z13`）。
                     mergedCount: g.dual?.total ?? null,
                     mergedState: g.dual?.state ?? null,
                     // ★ 2026-10-06 加：PRD §5.3 的权威结论行 —— daemon 把它一路交到
                     //   `replyTo → toCardOrText`，由信封层**搬进卡片的结论格**。
                     //   没有它，「逐字转述、不许改写」就只是一句写在提示词里的声明，
                     //   而实测证明模型会改写（Owner 看见的那三条就是）。
                     // ★ 2026-10-06：闸门没判送审、**但模型自己调了 `kb_review_chain`** 的那条路 ——
                     //   原先这里只认 `g?.verdict53`，于是那条路上的卡片抬头由模型自便
                     //   （Owner 发的 `REVIEW 1 处：W-1.16「限时」（覆盖不成立）` 就是这么来的）。
                     //   凭据是**这一轮真的调成了链**（`toolTrace` 里有一次 `ok` 的
                     //   `kb_review_chain`），不是「回复里出现了一行像 5.3 的字」。
                     verdict53: verdict53Final,
                     reviewFailure: g?.reviewFailure ?? null,
                     reviewDecisionWithheld: g?.reviewDecisionWithheld === true,
                     // 图片闸门在送审后才给出原因，必须随实际回复返回，供告警卡展示。
                     imageGateReason: [inbound.imageGateReason, inbound.videoGateReason].filter(Boolean).join('；') || null,
                     // ★ 2026-10-22（Owner：「输出的卡片不展示 视觉分析与 OCR」）：
                     //   这一格**整格撤掉** —— 卡面不再带 OCR/画面读数（原先只有图片评审卡才有，
                     //   现在连那一块也不再传）。读数本身没丢：`📥 读到｜…` 日志、会话记忆、
                     //   报告附录三处都在；它只是不上卡。
                     // ⚠️ 2026-10-13：**`mediaRead` 这一格撤了** —— 媒材读数按 Owner 的要求不上卡
                     //   （他 2026-10-06 说「视频还是无法读取」，那时读数搬上了卡；
                     //    2026-10-13 他把那一整段贴回来说「这里多余的回复也去掉」。两条相反，以最新为准）。
                     //   读数仍有三处落点：`📥 读到｜…` 日志（`raw:true`）、会话记忆、报告附录。
                     // 2026-10-09: 报告链接走**可见格**（结论块会被收起，藏里面等于没有）
                     // ★ 2026-10-16（FIX-044）：P0 前置那条路也要给 —— 它是内核自己跑的
                     //   P0 报告链接（同一个字段、同一个口径：拿不到就是 null，**不编**）。
                     reportLink: g.dual?.reportUrl ?? (p0Preflight?.report || null),
                     // ★★ 2026-10-21（Owner：「P0 红线问题必须 10 秒内回」）——
                     //   `p0Direct` = 这一单**没调模型**、回复直接是 §5.3 结论块（P0 确定性命中）。
                     //   它给 `ws_daemon` 用两次：
                     //     ① 量**用户实际等多久**（`[metric] direct_answer_ms=…`，从消息 `create_time`
                     //        量到卡发出去为止 —— PRD §12 给单条文字的口径是 ≤10 s）；
                     //     ② 事后核「这条路有没有又悄悄开始调模型」（读数在就查得到）。
                     p0Direct: !!g.p0DirectReply,
                     outbound: { folded: outboundFold.folded, untested: outboundFold.plan.untested } } };
  });
}

/* ─────────────────── 供外部查询的运行时信息 ─────────────────── */

export function status() {
  return {
    model: config.llm.model,
    llm: llm.stats,
    tools: toolNames(),
    sessions: mem.listSessions(),
    maxTurns: config.llm.maxTurns,
    maxToolIters: config.llm.maxToolIters,
  };
}

/** 供 daemon 在启动时打印，确认工具与模型都装载成功 */
export function loadedTools() { return toolNames(); }

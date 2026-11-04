/**
 * selftest_modes.mjs —— 四种送审形态（文案 / 图片 / 视频 / 链接）走一遍**出卡链路**
 *
 * 它验的是**守衡这一侧的出卡链路**：入向读数 → 模型侧那一遍 → 与库侧合并 → §5.3 渲染 → 卡片。
 * ★ 它**不跑那条链**（一次 4~10 分钟、且会真写飞书表）——链的行为另有自证
 *   （`kb/l8` 的层前置、`with_kb_evidence` 的测试、`verify_shouheng_ops`）。
 *   这里刻意把「链给的结论原文」当**输入**喂进来，这样四态都能在几十秒内跑完。
 *
 * 用法：`node tools/selftest_modes.mjs`（会真调一次 LLM，用于图片与视频两态；文案与链接不调）
 */
import assert from 'node:assert';
import * as feishu from './agent/feishu.mjs';
import * as vision from './agent/vision.mjs';
import * as videoM from './agent/video.mjs';
import * as llm from './agent/llm.mjs';
import { describeMediaRead } from './agent/agent.mjs';
import { readingsForModelSide, reviewModelSide } from './agent/model_side.mjs';
import { mergeFindings, mergedState, kbFindingsOf, kbCoveredOf, renderMerged } from './agent/dual_track.mjs';
import { toCardOrText } from './reply-cards/envelope.mjs';
import { deriveVerdictLine } from './agent/prd53.mjs';
import { isSubmission } from './agent/review_gate.mjs';

let pass = 0; const bad = [];
const ok = (m) => { pass++; console.log(`  ✅ ${m}`); };
const no = (m, w) => { console.log(`  ❌ ${m} —— ${w}`); bad.push(m); };
const chk = (m, cond, w) => (cond ? ok(m) : no(m, w));

/** 图片/视频两条真实素材（Owner 2026-10-06 实际发过的那两条）。 */
const IMG = { msg: 'om_x100b6371012350acb2671c5f79a5639', key: 'img_v3_02167_270360f7-2def-44b1-9983-552ddeba6b5g' };
const VID = { msg: 'om_x100b63711fcd90a8b2719a97627a9b8', key: 'file_v3_00167_4f1fd0d3-99e5-4af5-9aa0-305b2e1d9efg' };

/** 库侧结论原文（照真实链的产出入形，逐字取自 2026-10-06 那两单）。 */
const KB_COVERAGE = '【审查结论：REVIEW】共发现 1 处需人工确认。\n\n'
  + '1.【覆盖-知识库覆盖缺口】本次素材的**文字层逐字命中 0 条**，但覆盖判据不成立'
  + '（没有「既被规则引用、又达门限」的单元）——**这不是素材有问题，是库对该题材没有可依据的条款**。\n\n'
  // ★ 2026-10-14：覆盖缺口这一支**没有方向**（findings 恒空）⇒ 落 fallback。
  + '建议转 @法务（未配置） @北美同事（未配置） 复核。';
const KB_HIT = '【审查结论：REVIEW】共发现 1 处需人工确认。\n\n'
  + '1.【措辞表达-静音绝对化表述】全文，静音程度夸大（建议改为 low noise / quiet mode）。\n'
  + '   原因：逐字命中「静音」\n   依据：《措辞表达库 v0》第 W-1.54 条\n\n建议转 @法务 复核。';

/** 一条真实素材的完整出卡（链结论当输入喂进来）。 */
async function runOne({ name, inbound, kbAnswer, question, ask }) {
  const readings = readingsForModelSide(inbound);
  const model = ask ? await reviewModelSide({ readings, question, ask }) : { ok: true, findings: [], dropped: [], ms: 0 };
  const kb = kbFindingsOf(kbAnswer);
  const merged = mergeFindings(kb.findings, model.findings);
  const state = mergedState({ kbCovered: kbCoveredOf(kbAnswer), merged: merged.items });
  const rendered = renderMerged(merged.items, { state });
  const v53 = deriveVerdictLine({ answer: rendered ? rendered.block : kbAnswer });
  const out = toCardOrText('[[card:query-answer]]\n' + JSON.stringify({ title: 'x', verdict: '（模型转述）' }),
    { verdict53: v53, mediaRead: describeMediaRead(inbound) });
  const body0 = String(out.card?.body?.elements?.[0]?.content ?? '');
  console.log(`\n── ${name}`);
  console.log(`   模型侧 ${model.ok ? model.findings.length + ' 条' : '没跑成'}｜${merged.stats.merged} 条合并｜态=${state}`);
  console.log(`   标题：${out.card?.header?.title?.content}`);
  console.log('   正文第一块：' + body0.split('\n').slice(0, 2).join(' ⏎ ').slice(0, 130));
  return { out, body0, state, merged, v53, rendered };
}

// ── ① 文案 ──────────────────────────────────────────────────────────────
{
  const r = await runOne({
    name: '① 文案（无媒材）',
    inbound: { imageCount: 0, videoCount: 0, images: [], videos: [], text: '这款吸奶器静音设计，让妈妈安静挤奶不打扰宝宝。' },
    kbAnswer: KB_HIT, question: '这段文案能不能发？', ask: llm.ask,
  });
  // ★ 第一版这里传的是 `ask: null` —— 于是**模型侧根本没跑**，而断言照样全绿。
  //   一个把被测对象关掉的测试，比没有测试更糟：它给的是「验过了」的错觉。
  chk('① 模型侧**真的跑了**（不是被跳过）', r.merged.stats.model > 0,
      `模型侧 ${r.merged.stats.model} 条 —— 0 条说明 readings 是空的、模型侧被跳过`);
  chk('① 卡片建出来了', r.out.mode === 'card', `mode=${r.out.mode}`);
  chk('① 标题是 §5.3 结论行', /^【审查结论：(PASS|REVIEW|BLOCK)】/.test(String(r.out.card.header.title.content)),
      String(r.out.card.header.title.content));
  chk('① 文案**不该**有「我读到了」那块', !r.body0.includes('我读到了'), '没有媒材却出现了媒材读数');
  chk('① 库侧条目带来源标记', r.rendered.block.includes('**知识库侧**'), r.rendered.block.slice(0, 120));
}

// ── ② 图片 ──────────────────────────────────────────────────────────────
{
  const got = await feishu.fetchMessageImage(IMG.msg, IMG.key);
  const ocr = got.path ? await vision.ocrImage(got.path) : { ok: false, text: '' };
  try { got.cleanup?.(); } catch {}
  chk('② 真取图 + 真 OCR', ocr.ok && (ocr.text || '').trim().length > 0, `ok=${ocr.ok}`);
  const inbound = { imageCount: 1, videoCount: 0, fromParent: false,
    images: [{ index: 1, imageKey: IMG.key, text: ocr.text, chars: (ocr.text || '').length }], videos: [] };
  const r = await runOne({ name: '② 图片', inbound, kbAnswer: KB_COVERAGE, question: '这个图片能过吗？', ask: llm.ask });
  chk('② 卡片正文带「我读到了」', r.body0.includes('**我读到了**'), r.body0.slice(0, 80));
  chk('② 读数里有图张数与 OCR 字数', /图 1 张/.test(r.body0) && /共 \d+ 字/.test(r.body0), r.body0.slice(0, 120));
  chk('② 模型侧真的有产出（真调 LLM）', r.merged.stats.model > 0, `模型侧 ${r.merged.stats.model} 条`);
  chk('② 模型侧条目标注「无库内依据」', /模型侧\*\*（无库内依据）|无库内依据/.test(r.rendered?.block ?? ''), '没有来源标注');
  chk('② 库侧没覆盖 ⇒ 结论**不是 PASS**', r.state !== 'PASS', `state=${r.state}`);
}

// ── ③ 视频 ──────────────────────────────────────────────────────────────
{
  const got = await feishu.fetchMessageVideo(VID.msg, VID.key, { ext: '.mp4' });
  const v = got.path ? await videoM.readVideo(got.path) : { ok: false };
  try { got.cleanup?.(); } catch {}
  chk('③ 真取视频 + 真读（抽帧/OCR/转写）', v.ok && v.framesRead > 0, `ok=${v.ok} frames=${v.framesRead}`);
  const inbound = { imageCount: 0, videoCount: 1, fromParent: false, images: [],
    videos: [{ index: 1, fileKey: VID.key, meta: v.meta, frames: v.frames, framesRead: v.framesRead,
               ocrChars: v.ocrChars, transcript: v.transcript, ms: v.ms }] };
  const r = await runOne({ name: '③ 视频', inbound, kbAnswer: KB_COVERAGE, question: '这个视频能过吗？', ask: llm.ask });
  chk('③ 卡片正文带「我读到了」', r.body0.includes('**我读到了**'), r.body0.slice(0, 80));
  chk('③ 读数里有帧数与音轨结论', /抽帧 OCR \d+\/\d+ 帧/.test(r.body0) && /音轨/.test(r.body0), r.body0.slice(0, 160));
  chk('③ 库侧没覆盖 ⇒ 结论**不是 PASS**', r.state !== 'PASS', `state=${r.state}`);
}

// ── ④ 链接 ──────────────────────────────────────────────────────────────
{
  // ★ `isSubmission` 吃的是**对象**不是字符串（第一版我传了裸串，于是它按「正文 0 字」判，
  //   两条断言直接红了 —— 测试自己调错接口，比判据写错更容易发生）。
  const g = isSubmission({ text: '帮我看下这个 https://momcozy-in.feishu.cn/wiki/NB55wAq8liEOdKkquL2cgtPEnmg 能不能发' });
  chk('④ 闸门认得出这是**链接**送审', g.yes === true && g.kind === 'link', JSON.stringify(g));
  chk('④ 闸门把链接抽出来了', (g.links ?? []).length === 1, JSON.stringify(g.links ?? []));
  // ★ 缺口如实断出来：入向读数里**没有 links**，所以链接单拿不到「我读到了」那一段。
  const inbound = { imageCount: 0, videoCount: 0, images: [], videos: [], text: '' };
  const r = await runOne({ name: '④ 链接（缺口如实标出）', inbound, kbAnswer: KB_COVERAGE, question: '这个链接能不能发？', ask: null });
  chk('④ 卡片建得出来', r.out.mode === 'card', `mode=${r.out.mode}`);
  chk('④ **已知缺口**：链接单没有「我读到了」那一段（读数里没有 links）',
      !r.body0.includes('我读到了'), '竟然有了？那这条缺口已经补上了，应当更新这一行');
  console.log('   ⚠ 链接这一态**还没打通**：闸门认它，但入向读数（readInboundContent）里没有 links，');
  console.log('     所以「我读了哪条链接、读到多少字」进不了卡片。这不是今天修的范围，如实标出。');
}

console.log(`\n═══ 四形态出卡自测：通过 ${pass} / 失败 ${bad.length} ═══`);
process.exit(bad.length ? 1 : 0);

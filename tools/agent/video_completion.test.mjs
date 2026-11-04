import test from 'node:test';
import assert from 'node:assert/strict';
import { checkVideoCompletion } from './video_completion.mjs';

// The 17:29 production response had all six workflow sections, six successful
// scenes, and a declared video owner, but negative_rules.not_run. Keep the
// production evidence shape; do not depend on mutable live .work files.
const answer = `### 审核对象与范围\n视频 1，28.9 秒，仅覆盖列出的关键帧。
### 视觉分析与 OCR\n画面与字幕已读取。
### 主张拆分与核查清单\n核对产品功能与背书。
### 4A 规则符合性\n规则层与负面样本层已核对。
### 4B 事实准确性核查\n核对产品事实。
### 图文一致性\n口播与画面一致。`;
const valid = () => ({
  inbound: { imageCount: 0, videoCount: 1, videos: [{ index: 1,
    meta: { duration_s: 28.9, has_audio: true },
    frames: [{ t_s: 0.5, text: '' }, { t_s: 28.6, text: 'product' }],
    framesRead: 2, framesFailed: 0, scenePlan: [0.5, 28.6],
    frameScene: [0.5, 28.6].map(t_s => ({ t_s, ok: true, scene: { setting: '居家', people: [] } })),
    transcript: { ok: true, text: 'product', chars: 7 },
  }] },
  res: { answer, engine: { decision: { decision: 'REVIEW' }, evidence_meta: {
    trace: { negative_rules: { rules_scanned: 12, hits: [],
      frames_scanned: 2, frame_scene_errors: [],
      frame_scans: [0.5, 28.6].map(t_s => ({ video: 1, t_s,
        scene: { setting: '居家', people: [] }, rules_scanned: 12,
        visual_rules_scanned: 0, coverage: 'no_visual_rule_cues', hits: [] })),
      visual_rules_scanned: 0, visual_coverage_gap: true } },
    video_skill_gate: { ok: true, expected: '视频安全审查', owner: '视频安全审查',
      evidence_kind: 'session_tool_result', checks: [],
      load: { skill: '视频安全审查', session: '/fixture/current-session.json',
        verdict: 'loaded', reason: '', calls: [{ callId: 'fixture-skill', seq: 1,
          verdict: 'loaded', excerpt: '视频安全审查' }] } },
    layer_preflight: { ok: true, mode: 'enforced', red_total: 0,
      details: Object.fromEntries(['L4','L5','L6','L7'].map(k => [k, { pass: true, exit: 0, red: 0 }])) },
    decision_owner: { skill: '视频安全审查', mode: 'declared', loaded_skills: ['视频安全审查'] },
  } } }, model: { ok: true, findings: [] }, chainRan: true, chainMs: 10,
});
const runBad = (mutate, reason) => {
  const input = valid(); mutate(input);
  const out = checkVideoCompletion(input);
  assert.equal(out.incomplete, true);
  assert.equal(out.completed, false);
  assert.match(out.reason, reason);
  assert.match(out.refusal, /未完成/);
};

test('complete planned sample succeeds without requiring 30 OCR or 6 visual frames', () => {
  const out = checkVideoCompletion(valid());
  assert.equal(out.incomplete, false); assert.equal(out.completed, true); assert.equal(out.refusal, null);
});
test('empty OCR is a successful observation, not an OCR failure', () => {
  const input = valid(); input.inbound.videos[0].frames.forEach(f => { f.text = ''; });
  assert.equal(checkVideoCompletion(input).incomplete, false);
});
test('video array activates the gate even if videoCount incorrectly says zero', () =>
  runBad(x => { x.inbound.videoCount = 0; x.inbound.videos[0].frameScene = []; }, /画面/));
test('declared video count without a readable video refuses', () => runBad(x => { x.inbound.videos=[]; }, /视频.*读/));
test('failed download cannot be accepted as an ordinary review', () => runBad(x => { x.inbound.videos[0].failed='资源不可用'; }, /资源不可用/));
test('zero extracted frames refuses', () => runBad(x => { x.inbound.videos[0].frames=[]; x.inbound.videos[0].framesRead=0; }, /抽帧/));
test('one OCR error refuses even if another frame has text', () => runBad(x => { x.inbound.videos[0].frames[0].failed='ocr_timeout'; }, /OCR.*ocr_timeout/));
test('OCR count discrepancy refuses', () => runBad(x => { x.inbound.videos[0].framesRead=1; }, /OCR/));
test('a planned visual frame omitted from results refuses', () => runBad(x => { x.inbound.videos[0].frameScene.pop(); }, /28\.6/));
test('wrong visual timestamp cannot satisfy the planned frame', () => runBad(x => { x.inbound.videos[0].frameScene[1].t_s=25; }, /28\.6/));
test('missing visual plan is not positive completeness evidence', () => runBad(x => { delete x.inbound.videos[0].scenePlan; }, /计划/));
test('failed visual frame remains incomplete with its actual cause', () => runBad(x => { x.inbound.videos[0].frameScene[1]={t_s:28.6,ok:false,error:'HTTP 402'}; }, /HTTP 402/));
test('ok flag without a scene object does not prove visual reading', () => runBad(x => { delete x.inbound.videos[0].frameScene[0].scene; }, /画面/));
test('video frame copy failure cannot quietly fall back to text review', () => runBad(x => { x.inbound.videos[0].modelFrameCopyError='ENOSPC'; }, /ENOSPC/));
test('ASR timeout is not silence', () => runBad(x => { x.inbound.videos[0].transcript={ok:false,kind:'timeout'}; }, /音轨.*timeout/));
test('partial audio transcription is not complete', () => runBad(x => { x.inbound.videos[0].transcript.chunk_fails=1; }, /音轨/));
test('suspect transcript is not accepted merely because ok=true', () => runBad(x => { x.inbound.videos[0].transcript.suspect=true; }, /音轨/));
test('true no-audio and observed no-speech have explicit successful controls', () => {
  const silent=valid(); silent.inbound.videos[0].meta.has_audio=false;
  silent.inbound.videos[0].transcript={ok:false,kind:'no_audio_track'};
  assert.equal(checkVideoCompletion(silent).incomplete,false);
  const noSpeech=valid(); noSpeech.inbound.videos[0].transcript={ok:false,kind:'no_speech'};
  assert.equal(checkVideoCompletion(noSpeech).incomplete,false);
});
test('claiming no audio while probe observed a track refuses', () => runBad(x => { x.inbound.videos[0].transcript={ok:false,kind:'no_audio_track'}; }, /音轨/));
for (const [name, failure] of [['partial', { chunk_fails: 1 }], ['error', { error: 'audio timeout' }], ['suspect', { suspect: true }]]) {
  test(`no-speech cannot conceal a ${name} transcription failure`, () => runBad(x => {
    x.inbound.videos[0].transcript = { ok: false, kind: 'no_speech', ...failure };
  }, /音轨/));
  test(`no-audio cannot conceal a ${name} contradictory read failure`, () => runBad(x => {
    x.inbound.videos[0].meta.has_audio = false;
    x.inbound.videos[0].transcript = { ok: false, kind: 'no_audio_track', ...failure };
  }, /音轨/));
}
test('independent model failure refuses', () => runBad(x => { x.model={ok:false,error:'model timeout'}; }, /模型.*timeout/));
test('skipped independent model refuses', () => runBad(x => { x.model.skipped='empty'; }, /模型/));
test('chain failure refuses', () => runBad(x => { x.chainRan=false; x.res.error='chain timeout'; }, /chain timeout/));
test('17:29 incident not_run trace refuses despite complete OCR and visual observations', () => runBad(x => {
  x.res.engine.evidence_meta.trace.negative_rules={hits:[],not_run:'本单不是图片/视频（或正文里没有画面读数/图内文字）⇒ 负面样本规则层没跑'};
}, /负面样本.*没跑/));
for (const [name, trace] of [['missing',{missing:true}],['error',{error:'read failed'}],['empty',{}],['zero',{rules_scanned:0}]]) {
  test(`negative rule ${name} cannot pass as an executed layer`, () => runBad(x => { x.res.engine.evidence_meta.trace.negative_rules=trace; }, /负面样本/));
}
test('explicit negative-rule execution is accepted, but never overrides not_run', () => {
  const input=valid();
  input.res.engine.evidence_meta.trace.negative_rules.executed=true;
  delete input.res.engine.evidence_meta.trace.negative_rules.rules_scanned;
  assert.equal(checkVideoCompletion(input).incomplete,false);
  runBad(x => { x.res.engine.evidence_meta.trace.negative_rules={executed:true,not_run:'skipped'}; }, /负面样本/);
});
test('missing engine identity or evidence refuses', () => runBad(x => { delete x.res.engine; }, /引擎/));
test('unknown engine state is not a completed verdict', () => runBad(x => { delete x.res.engine.decision.decision; }, /引擎/));
test('executed flag cannot turn an empty rule scan into coverage', () => runBad(x => { x.res.engine.evidence_meta.trace.negative_rules={executed:true,rules_scanned:0,hits:[]}; }, /负面样本/));
test('layer preflight audit failure refuses', () => runBad(x => { x.res.engine.evidence_meta.layer_preflight.details.L5.pass=false; }, /L5/));
test('dry-run product verdict is not confused with layer preflight audit success', () => {
  const input=valid(); input.res.engine.evidence_meta.layer_preflight.details.L4.product={verdict:'FAIL',applied:false};
  assert.equal(checkVideoCompletion(input).incomplete,false);
});
test('missing declared video skill refuses without pretending declaration is a load audit', () => runBad(x => { x.res.engine.evidence_meta.decision_owner.loaded_skills=[]; }, /视频安全审查/));
test('a declared video owner cannot replace the actual skill load audit', () =>
  runBad(x => { delete x.res.engine.evidence_meta.video_skill_gate; }, /视频安全审查.*加载/));
test('failed skill load audit refuses even with a loaded declaration', () =>
  runBad(x => { x.res.engine.evidence_meta.video_skill_gate={ok:false,reason_code:'load_probe_failed',load:{verdict:'failed'}}; }, /load_probe_failed/));
test('a positive skill gate without loaded evidence refuses', () =>
  runBad(x => { x.res.engine.evidence_meta.video_skill_gate.load.verdict='missing'; }, /视频安全审查.*加载/));
test('loaded evidence without a successful skill gate refuses', () =>
  runBad(x => { delete x.res.engine.evidence_meta.video_skill_gate.ok; }, /视频安全审查.*加载/));
test('negative rules must show that every planned scene was actually consumed', () =>
  runBad(x => { delete x.res.engine.evidence_meta.trace.negative_rules.frames_scanned; }, /引擎.*画面/));
test('engine frame parse errors refuse with the actual cause', () =>
  runBad(x => { x.res.engine.evidence_meta.trace.negative_rules.frame_scene_errors=[{video:1,reason:'invalid scene JSON'}]; }, /invalid scene JSON/));
test('engine frame count must match both its rows and the planned observations', () =>
  runBad(x => { x.res.engine.evidence_meta.trace.negative_rules.frames_scanned=1; }, /引擎.*画面/));
test('same-count evidence for another video cannot replace this video', () =>
  runBad(x => { x.res.engine.evidence_meta.trace.negative_rules.frame_scans[1].video=2; }, /视频 1.*28\.6/));
test('same-count evidence at another timestamp cannot replace a planned frame', () =>
  runBad(x => { x.res.engine.evidence_meta.trace.negative_rules.frame_scans[1].t_s=25; }, /视频 1.*28\.6/));
test('duplicate engine observations cannot stand in for a missing planned frame', () =>
  runBad(x => { x.res.engine.evidence_meta.trace.negative_rules.frame_scans[1].t_s=0.5; }, /视频 1/));
test('engine frame evidence must include the consumed scene object', () =>
  runBad(x => { delete x.res.engine.evidence_meta.trace.negative_rules.frame_scans[0].scene; }, /视频 1.*0\.5/));
test('matching video and time cannot conceal a scene from another submission', () =>
  runBad(x => { x.res.engine.evidence_meta.trace.negative_rules.frame_scans[0].scene.setting='上一单卧室'; }, /画面.*本轮.*不一致/));
test('scene identity does not depend on JSON object key order', () => {
  const input=valid();
  input.res.engine.evidence_meta.trace.negative_rules.frame_scans[0].scene={people:[],setting:'居家'};
  assert.equal(checkVideoCompletion(input).incomplete,false);
});
test('zero visual-rule coverage remains an explicit boundary rather than an execution failure', () => {
  const out=checkVideoCompletion(valid());
  assert.equal(out.incomplete,false);
  assert.deepEqual(out.coverage,{visualRulesScanned:0,visualCoverageGap:true,
    visualReviewSources:['video_skill','independent_model']});
});
test('missing workflow stage refuses', () => runBad(x => { x.res.answer=answer.replace('### 4B 事实准确性核查\n核对产品事实。',''); }, /4B/));
test('each video must complete its own plan', () => runBad(x => { const second=structuredClone(x.inbound.videos[0]); second.index=2; second.frameScene=[]; x.inbound.videos.push(second); x.inbound.videoCount=2; }, /视频 2/));
test('deterministic P0 BLOCK is stopped explicitly, never labelled a completed review', () => {
  const input=valid(); input.inbound.videos[0].frameScene=[];
  input.res={answer:'【审查结论：BLOCK】确定性 P0 命中',p0_fastpath:{mode:'p0_fastpath',matched_patterns:1,rule_codes:['V02']},
    p0_findings:[{rule_code:'V02',verdict:'BLOCK'}]};
  const out=checkVideoCompletion(input);
  assert.equal(out.incomplete,false); assert.equal(out.completed,false); assert.equal(out.exempt,'p0_block'); assert.match(out.reason,/未执行/);
});
test('non-finite/string P0 counts and missing findings cannot bypass video evidence', () => {
  for (const matched_patterns of ['Infinity', Infinity, 1.5, '1', 1]) {
    runBad(x => { x.res={answer:'【审查结论：BLOCK】',
      p0_fastpath:{mode:'p0_fastpath',matched_patterns,rule_codes:['V02']}}; }, /视频安全审查|负面样本/);
  }
});
test('P0 findings must match the claimed blocked rules', () => runBad(x => {
  x.res={answer:'【审查结论：BLOCK】',p0_fastpath:{mode:'p0_fastpath',matched_patterns:1,rule_codes:['V02']},
    p0_findings:[{rule_code:'OTHER',verdict:'BLOCK'}]};
}, /视频安全审查|负面样本/));
test('a fake P0 marker cannot exempt REVIEW', () => runBad(x => { x.res.p0_fastpath={mode:'p0_fastpath',matched_patterns:1}; x.inbound.videos[0].frameScene=[]; }, /画面/));
test('text or image-only turns remain outside the video gate', () => {
  const out=checkVideoCompletion({inbound:{imageCount:1,videos:[]}});
  assert.equal(out.incomplete,false); assert.equal(out.applicable,false);
});

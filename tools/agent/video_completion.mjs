/** Validate this turn's video evidence before publishing a completed verdict.
 * Pure: no network, credentials, files, or previous-turn state.
 */
import { isDeepStrictEqual } from 'node:util';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const time = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
export function isConfirmedP0Block(res = {}) {
  const p0 = res?.p0_fastpath;
  const state = String(res?.engine?.decision?.decision ?? res?.engine?.state ?? res?.review?.state
    ?? String(res?.answer ?? '').match(/【审查结论[：:]\s*(BLOCK|REVIEW|PASS)】/)?.[1] ?? '').toUpperCase();
  const findings = res?.p0_findings;
  return state === 'BLOCK' && p0?.mode === 'p0_fastpath'
    && Number.isInteger(p0.matched_patterns) && p0.matched_patterns > 0
    && Array.isArray(p0.rule_codes) && p0.rule_codes.length > 0
    && Array.isArray(findings) && findings.length > 0
    && findings.every(f => f?.rule_code && p0.rule_codes.includes(f.rule_code)
      && (f.verdict === 'BLOCK' || f.severity === 'BLOCK'));
}
const workflowStages = [
  ['审核对象与范围', /审核对象与范围|审核范围/],
  ['视觉分析与 OCR', /(?:视觉分析|画面分析)[\s\S]{0,240}OCR|OCR[\s\S]{0,240}(?:视觉分析|画面分析)/i],
  ['主张拆分与核查清单', /主张拆分|主张核查清单|核查清单/],
  ['4A 规则符合性', /4A[\s\S]{0,80}规则符合性|规则符合性[\s\S]{0,80}4A/i],
  ['4B 事实准确性核查', /4B[\s\S]{0,80}事实准确性|事实准确性[\s\S]{0,80}4B/i],
  ['音画／图文一致性', /音画一致性|图文一致性|画面.{0,8}口播.{0,8}一致性/],
];

export function checkVideoCompletion({ inbound = {}, res = {}, model = null, chainRan = false } = {}) {
  const videos = Array.isArray(inbound?.videos) ? inbound.videos : [];
  const applicable = Number(inbound?.videoCount ?? 0) > 0 || videos.length > 0;
  const empty = { applicable, incomplete: false, completed: false, reason: '', reasons: [], refusal: null, checks: {} };
  if (!applicable) return empty;

  const state = String(res?.engine?.decision?.decision ?? res?.engine?.state ?? res?.review?.state
    ?? String(res?.answer ?? '').match(/【审查结论[：:]\s*(BLOCK|REVIEW|PASS)】/)?.[1] ?? '').toUpperCase();
  if (chainRan && isConfirmedP0Block(res)) {
    return { ...empty, exempt: 'p0_block', reason: 'P0 确定性 BLOCK 已停止后续审查；视频完整审查的后续步骤未执行。',
      checks: { p0Block: true, laterStagesExecuted: false } };
  }

  const reasons = [];
  const checks = {};
  const need = (ok, key, reason) => {
    checks[key] = !!ok;
    if (!ok) reasons.push(reason);
  };
  need(videos.length > 0, 'videoRead', '视频读取没有返回本轮视频读数');
  need(!(Number(inbound?.skippedVideos ?? 0) > 0), 'allVideosRead', '本轮仍有视频未读取');
  need(!(Number(inbound?.videoCount ?? 0) > videos.length), 'videoCount', '本轮视频数量与读取结果不一致');
  videos.forEach((v, index) => {
    const label = `视频 ${v?.index ?? index + 1}`;
    const prefix = `video${index + 1}`;
    need(object(v) && !v.failed, `${prefix}.read`, `${label}读取失败：${v?.failed || '未返回视频读数'}`);
    const frames = Array.isArray(v?.frames) ? v.frames : [];
    need(frames.length > 0, `${prefix}.frames`, `${label}未取得可供 OCR 的抽帧`);
    const badOcr = frames.filter(f => !object(f) || f.failed != null || f.error || !time(f.t_s));
    need(!badOcr.length && Number.isInteger(v?.framesRead) && v.framesRead === frames.length
      && v?.framesFailed === 0, `${prefix}.ocr`, `${label} OCR 未完整执行：`
      + (badOcr.map(f => f?.failed || f?.error || '帧读数或时间码缺失').join('；') || '成功帧数与抽帧数量不一致'));

    const plan = Array.isArray(v?.scenePlan) ? v.scenePlan : [];
    const validPlan = plan.length > 0 && plan.every(time) && new Set(plan).size === plan.length;
    need(validPlan, `${prefix}.scenePlan`, `${label}缺少有效的本轮画面采样计划`);
    const scenes = Array.isArray(v?.frameScene) ? v.frameScene : [];
    need(scenes.length > 0 && !v?.sceneSkipReason, `${prefix}.scenes`, `${label}画面层未执行：${v?.sceneSkipReason || '无画面读数'}`);
    if (validPlan) {
      for (const planned of plan) {
        const matches = scenes.filter(s => time(s?.t_s) && Math.abs(s.t_s - planned) < 0.05);
        const read = matches[0];
        need(matches.length === 1 && read?.ok === true && !read.skipped && !read.error
          && object(read.scene) && Object.keys(read.scene).length > 0,
        `${prefix}.scene.${planned}`, `${label} ${planned.toFixed(1)}s 画面未完成：`
          + (read?.error || (matches.length !== 1 ? '计划帧缺失或重复' : '没有有效画面读数')));
      }
    }
    need(!v?.modelFrameCopyError, `${prefix}.modelFrames`, `${label}原帧未交给独立模型：${v?.modelFrameCopyError}`);

    const transcript = v?.transcript;
    const audioFailed = !!transcript?.error || !!transcript?.suspect
      || Number(transcript?.chunk_fails ?? 0) > 0;
    const noTrack = !audioFailed && v?.meta?.has_audio === false && transcript?.kind === 'no_audio_track';
    const noSpeech = !audioFailed && v?.meta?.has_audio === true && transcript?.kind === 'no_speech';
    const transcribed = transcript?.ok === true && typeof transcript.text === 'string'
      && transcript.text.trim().length > 0 && !transcript.suspect && !transcript.error
      && !(Number(transcript.chunk_fails ?? 0) > 0);
    need(noTrack || noSpeech || transcribed, `${prefix}.audio`, `${label}音轨未完整核对：`
      + (transcript?.error || transcript?.kind || (transcript?.suspect ? '转写读数不可信'
        : Number(transcript?.chunk_fails ?? 0) > 0 ? '部分音频分段转写失败' : '缺少成功转写或无音轨／无语音读数')));
  });

  need(chainRan && !res?.error, 'chain', `视频审查链未完成：${res?.error || '没有本轮成功回执'}`);
  need(model?.ok === true && !model.skipped && !model.error, 'model',
    `本轮独立视频模型审查未完成：${model?.error || model?.skipped || '缺少成功读数'}`);
  need(object(res?.engine), 'engine', '缺少本轮知识库引擎执行证据');
  const evidence = res?.engine?.evidence_meta;
  const negative = evidence?.trace?.negative_rules;
  const scanned = Number.isInteger(negative?.rules_scanned) && negative.rules_scanned > 0;
  const executed = scanned || (negative?.executed === true && negative?.rules_scanned == null);
  need(object(negative) && executed && !negative.not_run && !negative.missing && !negative.error
    && negative.executed !== false, 'negativeRules', '负面样本规则层未完整执行：'
      + (negative?.not_run || negative?.error || (negative?.missing ? '规则文件缺失' : '没有有效执行／扫描读数')));
  const plannedScenes = videos.flatMap((v, index) => (Array.isArray(v?.scenePlan) ? v.scenePlan : [])
    .filter(time).map(t_s => ({ video: v?.index ?? index + 1, t_s,
      scene: (Array.isArray(v?.frameScene) ? v.frameScene : [])
        .find(frame => time(frame?.t_s) && Math.abs(frame.t_s - t_s) < 0.05)?.scene })));
  const frameScans = Array.isArray(negative?.frame_scans) ? negative.frame_scans : [];
  const frameErrors = negative?.frame_scene_errors;
  need(Array.isArray(frameErrors) && frameErrors.length === 0, 'engineSceneErrors',
    '引擎画面解析未完成：' + (Array.isArray(frameErrors) && frameErrors.length
      ? frameErrors.map(e => e?.reason || String(e)).join('；') : '缺少本轮解析读数'));
  need(Number.isInteger(negative?.frames_scanned) && negative.frames_scanned === plannedScenes.length
    && frameScans.length === plannedScenes.length, 'engineSceneCount', '引擎实际核对的画面数量与本轮采样计划不一致');
  for (const planned of plannedScenes) {
    const matches = frameScans.filter(scan => scan?.video === planned.video
      && time(scan?.t_s) && Math.abs(scan.t_s - planned.t_s) < 0.05);
    const scan = matches[0];
    need(matches.length === 1 && object(scan.scene) && Object.keys(scan.scene).length > 0
      && !scan.error && !scan.not_run && !scan.missing,
    `engineScene.${planned.video}.${planned.t_s}`,
    `引擎未完整核对视频 ${planned.video} ${planned.t_s.toFixed(1)}s 画面：`
      + (scan?.error || '缺少对应视频序号、时间码或有效画面读数'));
    if (object(planned.scene) && object(scan?.scene)) {
      // The engine receives the JSON material produced by chainInput. Compare
      // that representation, independent of key order, with this turn's scene.
      need(isDeepStrictEqual(JSON.parse(JSON.stringify(planned.scene)), scan.scene),
        `engineSceneIdentity.${planned.video}.${planned.t_s}`,
        `引擎画面与本轮视频 ${planned.video} ${planned.t_s.toFixed(1)}s 读数不一致`);
    }
  }

  const preflight = evidence?.layer_preflight;
  need(preflight?.ok === true && preflight.mode === 'enforced' && preflight.red_total === 0,
    'layerPreflight', '视频审查 L4–L7 前置审计未通过或缺少执行证据');
  for (const layer of ['L4', 'L5', 'L6', 'L7']) {
    const detail = preflight?.details?.[layer];
    // These are invocation-audit results, not the product's dry-run verdict/applied flag.
    need(detail?.pass === true && detail.exit === 0 && detail.red === 0,
      `layer.${layer}`, `${layer} 前置调用审计未通过或缺少本轮读数`);
  }
  const owner = evidence?.decision_owner ?? res?.review?.decision_owner;
  need(owner?.skill === '视频安全审查' && Array.isArray(owner.loaded_skills)
    && owner.loaded_skills.includes('视频安全审查'), 'videoSkillDeclared', '本轮未登记已加载的视频安全审查 skill');
  const skillGate = evidence?.video_skill_gate;
  need(skillGate?.ok === true && skillGate?.load?.verdict === 'loaded', 'videoSkillLoaded',
    '视频安全审查实际加载审计未通过：'
      + (skillGate?.reason_code || skillGate?.load?.reason || skillGate?.load?.verdict || '缺少本轮会话工具返回证据'));
  checks.skillEvidenceKind = skillGate?.evidence_kind || 'missing';
  for (const [name, pattern] of workflowStages) {
    need(pattern.test(String(res?.answer ?? '')), `workflow.${name}`, `视频安全审查流程缺项：${name}`);
  }
  need(['PASS', 'REVIEW', 'BLOCK'].includes(state), 'engineAccepted',
    state === 'NEEDS_INPUT' ? '知识库引擎拒绝本轮视频审查结果' : '知识库引擎没有可确认的本轮结论');
  const unique = [...new Set(reasons)];
  const reason = unique.join('；');
  // Rule execution and visual-rule coverage are separate readings. A real scan
  // may have no visual cues; the current skill and model still review visuals.
  const coverage = {
    visualRulesScanned: Number.isInteger(negative?.visual_rules_scanned) ? negative.visual_rules_scanned : null,
    visualCoverageGap: negative?.visual_coverage_gap === true,
    visualReviewSources: [checks.videoSkillLoaded && 'video_skill', checks.model && 'independent_model'].filter(Boolean),
  };
  return { applicable: true, incomplete: unique.length > 0, completed: unique.length === 0,
    reason, reasons: unique, checks, coverage,
    refusal: unique.length ? `本轮视频审查未完成：${reason}。暂时不能据此放行。` : null };
}

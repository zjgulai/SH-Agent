#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { checkImageSkillWorkflow, needsInfantScopeReview, applyInfantScopeReview } from './visual_checklist.mjs';
import { loadImageFactSources } from './image_fact_sources.mjs';

// 2026-10-30 16:42 真单，仅保留本轮链的审查文字，不保存图片或后续对话包装。
const incident = fs.readFileSync(new URL('./__fixtures__/image-review-20261030.txt', import.meta.url), 'utf8');
// 18:54 摄像头真单，同样只取既有内部记录的 chain_answer，不保存原图。
const cameraIncident = fs.readFileSync(new URL('./__fixtures__/image-review-camera-20261030.txt', import.meta.url), 'utf8');
// 11-02 09:48 真单：只保存既有内部记录的 chain_answer，不保存图片。
const reportIncident = fs.readFileSync(new URL('./__fixtures__/image-review-20261102.txt', import.meta.url), 'utf8');
const compoundAbsenceIncident = fs.readFileSync(new URL('./__fixtures__/image-review-group-1641-20261102.txt', import.meta.url), 'utf8');
const sourceMissing = '婴儿安全事实的权威来源核查（AAP/HealthyChildren）';
const stages = '审核对象与范围\n视觉分析与 OCR\n主张拆分与核查清单\n4A 规则符合性\n4B 事实准确性核查\n图文一致性';
const adultScene = { setting: '其他', people: [{ kind: '成人', doing: '手持白色圆形设备' }],
  products: [{ what: '白色圆形设备', in_use: true }], risk_cues: ['成人手持产品贴近身体'], unclear: [] };
const productScene = { setting: '影棚', people: [], products: [{ what: '吸奶器', in_use: false }],
  risk_cues: [], unclear: [] };
const options = { scenes: [adultScene], sleepPositions: [] };
const results = [];
const check = (id, run) => {
  try { run(); results.push({ id, ok: true }); }
  catch (error) { results.push({ id, ok: false, detail: error.message }); }
};
const requiresSource = (text, opts = options) => checkImageSkillWorkflow(text, opts).missing.includes(sourceMissing);

check('A1 真实成人产品图全文：完成六环节，不要求无关的婴儿安全来源', () => {
  const result = checkImageSkillWorkflow(incident, options);
  assert.equal(result.ok, true, result.reason);
});

// 同一组结构化事实下，报告换标点、否定措辞、Markdown 形态不应改变核查适用性。
for (const text of [
  '逐面板（全图仅 1 个面板）：人数与身份＝1 名成人、无婴幼儿；睡眠场景＝否。',
  '人物：成人，无婴幼儿；睡眠场景：不存在。',
  '人物：成人, 无婴幼儿；睡眠场景=false。',
  '这里拍的是成年讲解者；没有小孩出现，也不存在让孩子睡觉的内容。',
  '- 婴幼儿姿势：无（仅 1 名成人）\n- 婴儿睡眠位置：无（画面没有婴儿睡眠场景）',
  '| 核查项目 | 结论 | 说明 |\n| 婴幼儿姿势 | 无 | 仅有成人 |\n| 婴儿睡眠位置 | 不适用 | 产品演示 |',
  '### 婴幼儿姿势\n无\n### 婴儿睡眠位置\n不涉及',
]) {
  check(`A2 结构化成人读数不随否定叙述变化：${text.split('\n')[0]}`, () => {
    assert.equal(requiresSource(stages + '\n' + text), false);
  });
}

check('A3 无人物的产品图同样不要求婴儿安全来源', () => {
  assert.equal(requiresSource(stages + '\n睡眠场景＝否；婴幼儿不在画面中。',
    { scenes: [productScene], sleepPositions: [] }), false);
});

// 结构化婴儿安全事实与未知读数须来源核查；单纯出镜且明确非睡眠不触发 AAP 来源门槛。
for (const person of [
  { kind: '婴幼儿', doing: '被抱着', sleep_scene: false },
  { kind: '婴幼儿', doing: '睡觉', sleep_scene: true, sleep_posture: '仰卧' },
  { kind: '婴幼儿', doing: '睡觉', sleep_scene: true, sleep_posture: '侧卧' },
  { kind: '婴儿', doing: '身体被遮挡', sleep_scene: null, sleep_posture: '看不清' },
  { kind: '分不清', doing: '面部被遮挡' },
]) {
  check(`B1 结构化人物来源适用性：${JSON.stringify(person)}`, () => {
    const want = person.sleep_scene === false ? false : true;
    assert.equal(requiresSource(stages + '\n画面无婴幼儿，睡眠场景＝否。',
      { scenes: [{ ...adultScene, people: [person] }], sleepPositions: [] }), want);
  });
}

check('B2 多图中任何一图有婴儿睡眠事实就要核来源', () => {
  assert.equal(requiresSource(stages, { scenes: [adultScene,
    { ...productScene, people: [{ kind: '婴幼儿', sleep_scene: true, sleep_posture: '仰卧' }] }],
  sleepPositions: [] }), true);
});

check('B3 原始睡姿读数优先：成人场景与睡姿冲突不能免查', () => {
  assert.equal(requiresSource(stages, { scenes: [adultScene],
    sleepPositions: [{ image: '图 1', panel: '右侧', position: '侧卧', sleep_scene: true }] }), true);
});

for (const scenes of [[], [{}], [{ people: null }], [{ people: [{ doing: '身体被遮挡' }] }]]) {
  check(`B4 结构化画面缺失或人物身份未测须保守：${JSON.stringify(scenes)}`, () => {
    assert.equal(requiresSource(stages, { scenes, sleepPositions: [] }), true);
  });
}

// 成人图可以配婴儿安全主张；只有画面无婴儿不能免掉文字中真正需要核验的事实。
for (const claim of [
  '婴儿应仰卧睡眠。',
  '画面无睡眠场景，但主张婴儿可以同床睡。',
  '字幕宣称：本品可预防婴儿窒息。',
  '该产品对新生儿安全。',
  'Babies can safely sleep on their side.',
  'This product is safe for infants.',
  '婴儿可在沙发上睡眠。',
  '婴幼儿姿势：无（坐姿自然，正在吃奶）',
  '婴儿睡眠位置：无（正在熟睡，呼吸正常）',
  '无法确认画面没有婴儿睡眠场景。',
  '婴儿睡眠位置：未测（画面遮挡，无法判断）。',
  '婴儿睡眠位置：无，未测：画面遮挡',
  '婴儿睡眠位置：\n未测（画面遮挡，无法判断）。',
]) {
  check(`C1 成人画面不能掩盖实际主张或未知事实：${claim}`, () => {
    assert.equal(requiresSource(stages + '\n' + claim), true);
  });
}

check('C1b 被成人抱着的事实不单独触发 AAP 来源核查', () => {
  assert.equal(requiresSource(stages + '\n图中有婴幼儿被成人抱在怀中，未涉及睡眠安全事实。'), false);
});

check('C1c 报告说明无婴儿睡眠场景且 AAP 不适用，不被误读为安全保证', () => {
  const report = stages + '\n本图没有婴儿睡眠场景，也不涉及 AAP 适用前提，故不引用 aap-safe-sleep-2022。';
  const result = checkImageSkillWorkflow(report, {
    scenes: [{ ...adultScene, people: [{ kind: '婴幼儿', doing: '被成人抱着', sleep_scene: false }] }],
    sleepPositions: [], materialTexts: [{ origin: 'image_ocr', image: 1, status: 'empty', text: '' }],
  });
  assert.equal(result.infantSource.required, false, JSON.stringify(result.infantSource));
  assert.equal(result.missing.includes(sourceMissing), false, result.reason);
});

check('C2 来源名称不足以核查；实际来源原文核对后保留通过路径', () => {
  const bare = checkImageSkillWorkflow(stages + '\n婴儿应仰卧睡眠；核查来源：AAP。', options);
  assert.equal(bare.hasAuthoritativeSource, false);
  assert.ok(bare.missing.includes(sourceMissing));
  const { sources } = loadImageFactSources(process.env.SHOUHENG_FACT_SOURCE_TEST_ROOT
    || '/Users/lute/Documents/skill-test/执行skills/执行skills/skills-回归测试/知识库/内容治理');
  const text = incident.replace(/### 主张拆分与核查清单[\s\S]*?(?=### 4A)/,
    '### 主张拆分与核查清单\nC1 婴儿侧睡建议。\n\n')
    .replace(/### 4B 事实准确性核查[\s\S]*?(?=### 图文一致性)/,
    '### 4B 事实准确性核查\n| 主张 | 核查结论 | 依据及边界 | 来源 | 来源原文 |\n'
    + '|---|---|---|---|---|\n| C1 婴儿侧睡建议 | 不支持 | 2022年本地来源讨论一岁以内婴儿，不证明任何产品安全 | aap-safe-sleep-2022 | Side sleeping is not safe and is not advised. |\n\n');
  const result = checkImageSkillWorkflow(text, { ...options, factSources: sources });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.hasAuthoritativeSource, true);
});

check('C3 成人读数中仍有婴儿相关未确认事实时，不能用空人物列表免查', () => {
  assert.equal(requiresSource(stages, { scenes: [{ ...productScene,
    unclear: ['边缘遮挡处是否有婴儿无法确认'] }], sleepPositions: [] }), true);
});

for (const cue of ['无婴幼儿', '画面无婴儿出镜', '婴儿产品展示', '新生儿用品包装展示']) {
  check(`C3a 画面线索中的否定或产品类别不是婴儿安全事实：${cue}`, () => {
    assert.equal(requiresSource(stages, { scenes: [{ ...adultScene, risk_cues: [cue] }], sleepPositions: [] }), false);
  });
}

for (const cue of ['婴儿侧卧', '字幕宣称产品可预防婴儿窒息']) {
  check(`C3b 肯定画面事实或真实安全主张不能被成人列表盖掉：${cue}`, () => {
    assert.equal(requiresSource(stages, { scenes: [{ ...adultScene, risk_cues: [cue] }], sleepPositions: [] }), true);
  });
}

check('C3b 明确婴儿出镜本身不等于婴儿安全主张', () => {
  assert.equal(requiresSource(stages, { scenes: [{ ...adultScene,
    risk_cues: ['画面中出现婴儿，被成人抱着'] }], sleepPositions: [] }), false);
});

check('C3b 明确婴儿出镜或被成人抱着本身不等于婴儿安全主张', () => {
  for (const cue of ['婴儿出镜', '画面中出现婴儿', '婴幼儿被成人抱在怀中']) {
    const person = { kind: '婴幼儿', doing: '被成人抱着', sleep_scene: false };
    assert.equal(requiresSource(stages, { scenes: [{ ...adultScene,
      people: [person], risk_cues: [cue] }], sleepPositions: [] }), false, cue);
  }
});

check('C4 与婴儿无关的产品未测不会被前一项婴儿栏目污染', () => {
  assert.equal(requiresSource(stages + '\n### 婴儿睡眠位置\n无\n产品状态：未测（设备表面看不清）'), false);
});

for (const claim of [
  '婴儿睡眠绝对安全。',
  '婴儿使用本产品没有任何风险。',
  '使用本品，宝宝没有风险。',
  '对新生儿零风险。',
  '给宝宝用，百分之百安全。',
  '婴儿使用本品安全。',
  '使用本品后，宝宝睡眠安全。',
  '婴儿使用本品非常安全。',
  'Infant sleep is completely safe.',
  'Sleep is safe for every newborn.',
  'This device is harmless to babies.',
  'There is no risk to infants when using this product.',
  'For babies, this product guarantees zero risk.',
]) {
  check(`C5 真实成人图后的安全或零风险承诺仍需来源：${claim}`, () => {
    assert.equal(requiresSource(incident + '\n' + claim,
      { scenes: [productScene], sleepPositions: [] }), true);
  });
}

for (const description of [
  '### 婴幼儿安全\n不涉及',
  '婴儿安全',
  '婴儿安全：不涉及（成人产品图）',
  'Infant safety: not applicable.',
  '展示婴儿安全座椅产品包装。',
]) {
  check(`C6 成人图中的安全栏目或产品类别不是安全承诺：${description.split('\n')[0]}`, () => {
    assert.equal(requiresSource(stages + '\n' + description), false);
  });
}

check('D1 旧调用方式兼容：明确无婴儿睡眠场景不要求来源', () => {
  assert.equal(requiresSource(stages + '\n画面没有婴儿睡眠场景', { sleepPositions: [] }), false);
});

check('D2 旧调用方式没有结构化画面时，对婴儿相关不确定描述保守', () => {
  assert.equal(requiresSource(stages + '\n婴儿睡眠位置：未测（画面遮挡）', { sleepPositions: [] }), true);
});

check('D3 真实全文的 4B 环节被删后仍拒绝，不因无婴儿而跳过全流程', () => {
  const missing4B = incident.replace(/### 4B 事实准确性核查[\s\S]*?(?=### 图文一致性)/, '');
  assert.notEqual(missing4B, incident);
  // 2026-11-03：缺项现在带原因（「章名：原因」），按前缀判
  assert.ok(checkImageSkillWorkflow(missing4B, options).missing.some((s) => s.startsWith('4B 事实准确性核查')));
});

// 18:54 事故：视觉模型将明确的无人事实放进 unclear，不能仅凭字段名和「婴幼儿」
// 关键词，把「没有婴幼儿」改判为「婴幼儿事实未确认」。旧实现会在这组测试变红。
check('E1 真实摄像头全文与原 unclear 读数：无人物事实不会要求婴儿来源', () => {
  const result = checkImageSkillWorkflow(cameraIncident, { sleepPositions: [], scenes: [{
    setting: '影棚', people: [],
    products: [{ what: '白色立式摄像头', orientation: '正放' }],
    risk_cues: [], unclear: ['图中没有人物、婴幼儿或使用场景', '无法判断设备是否通电工作'],
  }] });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.infantSource.required, false);
});

// 同一项事实放在正文、画面线索或未确认字段中，婴儿来源适用性不应改变。
// 每个 want 都来自句子的含义；不拿被测函数的另一次结果当作预期。
const factsByMeaning = [
  { label: '明确无人', text: '图中没有人物、婴幼儿或使用场景', want: false },
  { label: '明确无婴儿', text: '未见婴幼儿出镜', want: false },
  { label: '英文明确无 infant', text: 'No infant appears in the picture.', want: false },
  { label: '英文明确无 baby', text: 'No baby is present in the image.', want: false },
  { label: '英文无人不等于设备状态已知', text: 'No baby is present; device power status is unknown.', want: false },
  { label: '否定与设备未知各属其类', text: '图中没有人物、婴幼儿或使用场景；无法判断设备是否通电工作', want: false },
  { label: '婴儿栏目结束后设备未知不串类', text: '婴儿睡眠位置：无；产品是否通电未知', want: false },
  { label: '无冒号的新产品主语不串类', text: '婴幼儿姿势：无；产品通电状态未知', want: false },
  { label: '缺席字段后无其他问题不是婴儿未知', text: '婴幼儿姿势：无；未发现其他问题', want: false },
  { label: '婴幼儿安全栏明确不适用', text: '婴幼儿安全：不涉及', want: false },
  { label: '实际婴儿未知', text: '边缘遮挡处是否有婴儿无法确认', want: true },
  { label: '不能确认否定不等于否定', text: '无法确认画面没有婴儿睡眠场景', want: true },
  { label: '否定套否定不等于婴儿缺席', text: '并非没有婴幼儿', want: true },
  { label: '未能确定是否缺席仍是未知', text: '未能确定是否无婴幼儿', want: true },
  { label: '实际婴儿行为', text: '婴儿侧卧', want: true },
  { label: '单纯婴儿出镜', text: '图中出现婴儿，被成人抱着。', want: false },
  { label: '真实婴儿安全主张', text: '本品可预防婴儿窒息', want: true },
  { label: '否定出镜不免除同句安全主张', text: '无婴儿，但字幕称本品预防窒息', want: true },
  { label: '分号不切断婴儿安全主张', text: '婴儿专用；保证没有任何风险', want: true },
  { label: '省略主语的后续安全谓语仍指向婴儿', text: '给婴儿使用；绝对安全。', want: true },
  { label: '安全性字段承接婴儿适用对象', text: '适用对象：婴幼儿；安全性：绝对安全。', want: true },
  { label: '安全性字段的零风险承诺承接婴儿对象', text: '适用对象：婴幼儿；安全性：没有任何风险。', want: true },
  { label: '分号不免除后续字幕安全主张', text: '图中无婴儿；字幕称本品预防窒息。', want: true },
  { label: '字幕字段不免除婴儿安全主张', text: '图中无婴幼儿；字幕：本品预防窒息。', want: true },
  { label: '英文分号不免除后续字幕安全主张', text: 'No baby is visible; the captions say this product prevents suffocation.', want: true },
  { label: '否定风险仍是安全承诺', text: '婴儿使用本产品没有任何风险', want: true },
];
for (const fact of factsByMeaning) {
  for (const channel of ['body', 'risk_cues', 'unclear']) {
    check(`E2 ${fact.label}在 ${channel} 中适用性一致`, () => {
      const scene = { ...productScene, risk_cues: [], unclear: [] };
      let text = stages;
      if (channel === 'body') text += '\n' + fact.text;
      else scene[channel] = [fact.text];
      const result = checkImageSkillWorkflow(text, { scenes: [scene], sleepPositions: [] });
      assert.equal(result.infantSource.required, fact.want, JSON.stringify(result.infantSource));
      assert.equal(result.missing.includes(sourceMissing), fact.want);
    });
  }
}

// 分号/换行/表格单元格都可能分隔不同核查类别。产品的未知与安全结论不属于前项婴儿。
for (const text of [
  '婴幼儿姿势：无；产品状态：未测（设备背面看不清）',
  '婴幼儿姿势：无\n产品状态：未测（设备背面看不清）',
  '婴幼儿姿势：无；婴儿睡眠位置：无（画面没有婴儿睡眠场景）；产品状态：未测（设备背面看不清）',
  '人数与身份＝1 名成人、无婴幼儿；产品型号未知。',
  '人数与身份＝1 名成人、无婴幼儿。产品型号未知。',
  '无婴幼儿出镜；无法确认 IBCLC 资质。',
  '婴幼儿姿势：无；产品状态：无风险。',
  '| 婴幼儿姿势：无 | 产品状态：未测（设备背面看不清） |',
]) {
  check(`E3 不把其他类别的谓语配给婴儿栏目：${text.replaceAll('\n', ' / ')}`, () => {
    const result = checkImageSkillWorkflow(stages + '\n' + text, options);
    assert.equal(result.infantSource.required, false, JSON.stringify(result.infantSource));
  });
}

// 拆分以后不能把同一婴儿栏目中的真实未知/行为/主张丢掉。
for (const text of [
  '婴儿睡眠位置：\n未测（画面遮挡，无法判断）',
  '婴儿睡眠位置：无，未测：画面遮挡',
  '婴幼儿姿势：无；但图中有侧卧婴儿。',
  '图中没有婴幼儿；字幕宣称婴儿使用本品绝对安全。',
  '无婴儿，但字幕称本品预防窒息。',
  '婴幼儿安全：没有任何风险。',
  '图中没有人物；婴儿是否在遮挡区域无法确认。',
]) {
  check(`E4 类别隔离不会免查真正婴儿事实：${text.replaceAll('\n', ' / ')}`, () => {
    assert.equal(requiresSource(stages + '\n' + text), true);
  });
}

// unclear 原有的保守要求不能因命中否定子串而失效：否定套否定、缺少信息和缺少
// 身体部位都不是「婴儿缺席」。这些用例只断言 unclear，不扩张正文的原有口径。
for (const text of [
  'It is not true that no babies are present.',
  'It is not known whether no baby is present.',
  '未见婴幼儿正脸',
  '无婴儿月龄信息',
  '没有婴儿睡姿信息',
  'No baby age information is available.',
]) {
  check(`E5 未确认项不是完整直接缺席陈述时仍要求来源：${text}`, () => {
    const result = checkImageSkillWorkflow(stages, { sleepPositions: [],
      scenes: [{ ...productScene, unclear: [text] }] });
    assert.equal(result.infantSource.required, true, JSON.stringify(result.infantSource));
    assert.ok(result.missing.includes(sourceMissing));
  });
}

// 11-02 事故暴露的是来源契约：报告中的不适用解释不是素材的安全承诺。
// 固定本轮素材与画面，只变化报告说明；来源适用性必须保持不变。
const incidentImageSha = '9f5229442fcb1f91be9f6909e2e6cedc980d25a9b012297b224c0061fe52d648';
const incidentMaterialTexts = [{ origin: 'image_ocr', image: 1, sha256: incidentImageSha,
  status: 'ok', text: 'IBCLC + mom of\n4 explains\nMomcozy Air 1\nBreast Pump\n20 WOW' }];
const sourceOptions = { scenes: [adultScene], sleepPositions: [], materialTexts: incidentMaterialTexts };
const incidentRelation = '- 场景关系：无（室内讲解场景，产品贴近身体，没有婴幼儿或床铺风险场景）。';

check('F1 真实 09:48 成人图全文：审核者的不适用解释不触发 AAP 要求', () => {
  assert.ok(reportIncident.includes(incidentRelation));
  const result = checkImageSkillWorkflow(reportIncident, sourceOptions);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.infantSource.required, false);
});

for (const explanation of [
  '室内讲解场景，产品贴近身体，画面只有成人，也没有床铺场景',
  '室内讲解场景，未见婴幼儿或床铺风险场景',
  '室内讲解场景，不存在婴幼儿或床铺风险场景',
  '室内讲解场景，不涉及婴幼儿或床铺风险场景',
  '室内讲解场景，没有婴幼儿或床铺风险场景',
  '画面仅有成人，未见婴幼儿危险行为',
  '画面仅有成人，没有婴幼儿危险行为',
]) {
  check(`F2 素材与画面固定，只改不适用解释：${explanation}`, () => {
    const report = reportIncident.replace(incidentRelation, `- 场景关系：无（${explanation}）。`);
    assert.notEqual(report, reportIncident, '报告说明必须实际被替换');
    const result = checkImageSkillWorkflow(report, sourceOptions);
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.infantSource.required, false, JSON.stringify(result.infantSource));
  });
}

// 不适用栏目没有豁免权；报告自己作出的安全判断同样需要来源。
for (const assertion of [
  '本品对婴儿绝对安全',
  '婴儿使用本产品没有任何风险',
  '本品可预防婴儿窒息',
  '婴儿应仰卧睡眠',
]) {
  check(`F3 场景关系判无也不能藏掉审核者的安全判断：${assertion}`, () => {
    const report = reportIncident.replace(incidentRelation, `- 场景关系：无（${assertion}）。`);
    assert.notEqual(report, reportIncident);
    const result = checkImageSkillWorkflow(report, sourceOptions);
    assert.equal(result.infantSource.required, true);
    assert.equal(result.infantSource.origin, 'review_assertion');
    assert.ok(result.missing.includes(sourceMissing));
  });
}

// 同一份不含婴儿判断的报告，不能替代素材本身的核查；原图无婴儿也不免除图上宣称。
for (const origin of ['image_ocr', 'visual_text']) {
  for (const claim of ['本品可预防婴儿窒息', '婴儿使用本产品没有任何风险']) {
    check(`F4 ${origin} 的婴儿安全宣称未写进报告时仍要核来源：${claim}`, () => {
      const result = checkImageSkillWorkflow(stages + '\n成人展示产品，图文一致。', {
        ...sourceOptions,
        materialTexts: [{ origin, image: 1, sha256: incidentImageSha, status: 'ok', text: claim }],
      });
      assert.equal(result.infantSource.required, true, JSON.stringify(result.infantSource));
      assert.equal(result.infantSource.origin, origin);
      assert.ok(result.missing.includes(sourceMissing));
    });
  }
}

// 新的分来源调用不能削弱已有结构化画面和睡姿要求。
for (const scoped of [
  { name: '画面有婴儿但无睡眠/安全事实', scenes: [{ ...adultScene, people: [{ kind: '婴幼儿', sleep_scene: false }] }], sleepPositions: [], want: false },
  { name: '人物身份未知', scenes: [{ ...adultScene, people: [{ kind: '分不清' }] }], sleepPositions: [], want: true },
  { name: '真实睡姿读数', scenes: [adultScene], sleepPositions: [{ image: '图 1', panel: '右侧', position: '侧卧', sleep_scene: true }], want: true },
]) {
  check(`F5 分来源模式保留${scoped.name}的来源要求`, () => {
    const result = checkImageSkillWorkflow(stages + '\n画面没有婴儿睡眠场景。', {
      ...sourceOptions, scenes: scoped.scenes, sleepPositions: scoped.sleepPositions,
    });
    assert.equal(result.infantSource.required, scoped.want, JSON.stringify(result.infantSource));
    assert.equal(result.missing.includes(sourceMissing), scoped.want);
  });
}

// 直接缺席说明只能消除自己的存在性主张，不能凭空造出婴儿对象。
for (const report of [
  '没有床铺，无法确认设备是否通电',
  '没有人物，设备安全',
  '没有床铺。产品安全',
  '场景关系：无（画面没有床铺，设备是否通电未知）',
]) {
  check(`F6 成人报告的非婴儿对象不能被改写成婴儿事实：${report}`, () => {
    const result = checkImageSkillWorkflow(stages + '\n' + report, sourceOptions);
    // 本组只验适用性；只有空标题的报告不能冒充完整流程。
    assert.equal(result.missing.includes(sourceMissing), false, result.reason);
    assert.equal(result.infantSource.required, false, JSON.stringify(result.infantSource));
  });
}

// 同一句里的产品效果/保证谓语决定了后文是安全承诺，不能逐逗号剥除宾语。
for (const report of [
  '本品能够保证，不存在婴儿危险行为',
  '使用本品后，没有婴儿风险场景',
  '本品能确保（没有婴幼儿危险行为）',
]) {
  check(`F7 产品效果承诺不能被局部缺席短语遮蔽：${report}`, () => {
    const result = checkImageSkillWorkflow(stages + '\n' + report, sourceOptions);
    assert.equal(result.infantSource.required, true, JSON.stringify(result.infantSource));
    assert.equal(result.infantSource.origin, 'review_assertion');
    assert.ok(result.missing.includes(sourceMissing));
  });
}

check('F8 同一成人场景的「并未出现」仍是不适用说明', () => {
  const report = reportIncident.replace(incidentRelation,
    '- 场景关系：无（画面只有成人，并未出现婴幼儿风险场景）。');
  const result = checkImageSkillWorkflow(report, sourceOptions);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.infantSource.required, false, JSON.stringify(result.infantSource));
});

for (const report of [
  '场景关系：无（并非没有婴幼儿风险场景）',
  '场景关系：无（未能确定是否没有婴幼儿风险场景）',
  '场景关系：无（不能说不存在婴幼儿危险行为）',
]) {
  check(`F9 未知或双重否定不能成为缺席豁免：${report}`, () => {
    const result = checkImageSkillWorkflow(stages + '\n' + report, sourceOptions);
    assert.equal(result.infantSource.required, true, JSON.stringify(result.infantSource));
    assert.equal(result.infantSource.origin, 'review_assertion');
    assert.ok(result.missing.includes(sourceMissing));
  });
}

// 不可用的素材来源读数是读取缺项，不能静默通过，也不能假称出现了婴儿主张。
const validEmptyMaterial = { origin: 'image_ocr', image: 1, sha256: incidentImageSha, status: 'empty', text: '' };
for (const [name, materialTexts] of [
  ['null 集合', null],
  ['非数组集合', {}],
  ['空集合', []],
  ['null 条目', [null]],
  ['空条目', [{}]],
  ['读取失败', [{ ...validEmptyMaterial, status: 'failed' }]],
  ['读取截断', [{ ...validEmptyMaterial, status: 'truncated', text: '普通产品名称' }]],
  ['未知状态', [{ ...validEmptyMaterial, status: 'unavailable' }]],
  ['未知来源', [{ ...validEmptyMaterial, origin: 'wrapped_prompt' }]],
  ['ok 却无文字', [{ ...validEmptyMaterial, status: 'ok' }]],
  ['empty 却有文字', [{ ...validEmptyMaterial, text: '普通产品名称' }]],
  ['文字类型不符', [{ ...validEmptyMaterial, text: {} }]],
]) {
  check(`F10 素材证据${name}：未完整读取，不崩溃且不制造 AAP 缺项`, () => {
    const result = checkImageSkillWorkflow(stages + '\n成人展示产品。', { ...sourceOptions, materialTexts });
    assert.equal(result.ok, false);
    assert.ok(result.missing.some((missing) => /图中文字来源/.test(missing)), result.reason);
    assert.equal(result.infantSource.required, false, JSON.stringify(result.infantSource));
    assert.equal(result.missing.includes(sourceMissing), false, result.reason);
  });
}

check('F11 明确读取成功且确实没有文字，与读取失败保持区别', () => {
  const result = checkImageSkillWorkflow(stages + '\n成人展示产品。', {
    ...sourceOptions, materialTexts: [validEmptyMaterial],
  });
  assert.equal(result.missing.some(x => /图中文字来源/.test(x)), false, result.reason);
  assert.equal(result.infantSource.required, false);
});

// 保证/使用后的宾语和双重否定不随换行、括号改变；只检查格式边界，不枚举新同义词。
for (const report of [
  '本品能够保证\n不存在婴儿危险行为',
  '使用本品后\n没有婴儿风险场景',
  '场景关系：无（并非（没有婴幼儿风险场景））',
  '场景关系：无（不是（没有婴幼儿风险场景））',
]) {
  check(`F12 格式边界不能剥离安全承诺或双否定：${report.replaceAll('\n', ' / ')}`, () => {
    const result = checkImageSkillWorkflow(stages + '\n' + report, sourceOptions);
    assert.equal(result.infantSource.required, true, JSON.stringify(result.infantSource));
    assert.equal(result.infantSource.origin, 'review_assertion');
    assert.ok(result.missing.includes(sourceMissing));
  });
}

for (const report of [
  '场景关系：无（画面只有成人，没有婴幼儿风险场景）；产品状态：无（外壳有保护套）',
  '- **场景关系**：无（室内讲解场景，产品贴近身体，没有婴幼儿或床铺风险场景）。',
]) {
  check(`F13 观察字段的独立后项或加粗格式不改变来源要求：${report}`, () => {
    const result = checkImageSkillWorkflow(stages + '\n' + report, sourceOptions);
    assert.equal(result.missing.includes(sourceMissing), false, result.reason);
    assert.equal(result.infantSource.required, false, JSON.stringify(result.infantSource));
  });
}


// G1: structured observation fields must distinguish full absence from safety
// claims/unknown facts; actual infant evidence takes precedence over either field.
for (const field of ['risk_cues', 'unclear']) {
  for (const sample of [
    { label: '完整场景缺席', text: '画面没有婴幼儿或床铺风险场景', want: false },
    { label: '安全保证', text: '本品保证宝宝安全', want: true },
    { label: '事实未知', text: '无法确认画面是否有婴幼儿或床铺风险场景', want: true },
    { label: '婴儿出镜但明确非睡眠且无安全主张', text: '画面没有婴幼儿或床铺风险场景', want: false,
      people: [{ kind: '婴幼儿', doing: '被成人抱着', sleep_scene: false }] },
    { label: '无窒息风险不是缺席', text: '无婴幼儿窒息风险', want: true },
    { label: '缺席后仍有肯定主张', text: '画面没有婴幼儿或床铺风险场景；字幕宣称本品可预防婴儿窒息', want: true },
  ]) {
    check(`G1 ${field}：${sample.label}`, () => {
      const scene = { ...adultScene, risk_cues: [], unclear: [], [field]: [sample.text],
        people: sample.people ?? adultScene.people };
      const result = checkImageSkillWorkflow(stages, {
        scenes: [scene], sleepPositions: [], materialTexts: [validEmptyMaterial],
      });
      assert.equal(result.infantSource.required, sample.want, JSON.stringify(result.infantSource));
      assert.equal(result.missing.includes(sourceMissing), sample.want, result.reason);
    });
  }
}

// 16:41: missing parse is not a positive observation of unknown infant facts.
// The full semantic review decides these statements; no new absence whitelist.
for (const text of ['画面中无人物、无婴幼儿', '婴幼儿均未在本画面出现', '婴儿月龄']) {
  check(`H1 unclear 中尚未解析的语句进入语义复核：${text}`, () => {
    const opts = { scenes: [{ ...productScene, unclear: [text] }], sleepPositions: [],
      materialTexts: [{ ...validEmptyMaterial, status: 'ok', text: 'Breast pump control' }] };
    const result = checkImageSkillWorkflow(compoundAbsenceIncident, opts);
    assert.equal(result.ok, false, '未复核前仍不放行');
    assert.equal(result.infantSource.required, true);
    assert.equal(result.infantSource.trigger, text);
    assert.equal(result.infantSource.reason, 'infant_scope_unresolved');
    assert.deepEqual(result.infantUncertainties, [], '解析器未认出不能冒充事实未知');
    assert.equal(needsInfantScopeReview(result, opts), true);
    const untested = applyInfantScopeReview(result, { ok: false, required: null }, opts);
    assert.equal(untested.ok, false);
    assert.match(untested.reason, /适用性复核未完成/);
    const required = applyInfantScopeReview(result, { ok: true, required: true,
      reason: 'uncertain_infant_fact', origin: 'scene', trigger: text }, opts);
    assert.equal(required.ok, false, '语义确认未知仍要求权威来源');
    assert.ok(required.missing.includes(sourceMissing));
  });
}
for (const extra of ['无法确认婴儿是否与成人同床', '婴儿月龄未知']) {
  check(`H2 未解析缺席语句不能遮住另一条明确未知：${extra}`, () => {
    const opts = { scenes: [{ ...productScene, unclear: ['画面中无人物、无婴幼儿', extra] }],
      sleepPositions: [], materialTexts: [validEmptyMaterial] };
    const result = checkImageSkillWorkflow(compoundAbsenceIncident, opts);
    assert.equal(result.infantSource.reason, 'infant_scope_unresolved');
    assert.ok(result.infantUncertainties.some((item) => item.trigger === extra));
    assert.equal(needsInfantScopeReview(result, opts), false);
    assert.equal(applyInfantScopeReview(result, { ok: true, required: false }, opts).ok, false);
  });
}

for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.id}${result.ok ? '' : `\n  ${result.detail}`}`);
const failed = results.filter((result) => !result.ok).length;
console.log(`image_source_gate: ${results.length - failed}/${results.length} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;

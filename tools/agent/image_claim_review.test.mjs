import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeImageClaimView } from './image_claim_view.mjs';

// ★ 2026-11-03（Owner 批准 ②，恢复 10-27 验收口径）：validator 现在把缺项分成两桶 ——
//   `missing`（明确婴儿未知 / 引用不实 / 睡眠义务 / 结构非法）= 硬否决；
//   `softMissing`（报告自述句被误判成安全主张、原素材安全主张未进 C 清单）= 默认只留痕。
//   严格档由 IMAGE_CLAIM_ENFORCE=1 打开（image_completion_publish.test.mjs 钉的就是它）。
//   下面这些用例原本只断言「整单失败」，现在断言**缺项仍被点名**，不再绑死在哪一桶。
const recorded = result => [...result.missing, ...(result.softMissing ?? [])].join(' ');


let api;
try { api = await import('./image_claim_review.mjs'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
const requireApi = () => assert.equal(typeof api?.adjudicateImageClaims, 'function', '缺少逐主张来源复核模块');
const quote = 'Side sleeping is not safe and is not advised.';
const source = { id: 'approved-fixture', verified: true, kind: 'local_snapshot',
  content: quote, excerpt: quote, scope: 'Infant sleep position.', published: '2022',
  title: 'Fixture infant sleep evidence', source_sha256: 'fixture-content-sha' };
const report = (rows = [['C1', '被成人抱着', '画面可确认', '图1中央可见成人托抱婴儿，未观察到睡眠。', null, null]]) => `### 审核对象与范围
图1整图，检查当前画面及图中文字。
### 视觉分析与 OCR
图1中部成人托抱婴儿，背景有白色柜子。
### 主张拆分与核查清单
${rows.map(([id, claim]) => `${id}：${claim}。`).join('\n')}
### 4A 规则符合性
本轮未命中适用规则，不能据此确认素材合规。
### 4B 事实准确性核查
| 主张 | 核查结论 | 依据及边界 | 来源 | 来源原文 |
| --- | --- | --- | --- | --- |
${rows.map(([id, , conclusion, boundary, sourceId, text]) => `| ${id} | ${conclusion} | ${boundary} | ${sourceId ?? '—'} | ${text ?? '—'} |`).join('\n')}
### 图文一致性
画面显示抱婴，正文未把抱姿宣传为安全保证。
### 视觉核对
婴幼儿姿势：有（图1中央可见成人托抱婴儿）
婴儿睡眠位置：无
产品状态：无
场景关系：无
隐私：无`;
const input = (rows, extra = {}) => ({ reportText: report(rows),
  scenes: [{ people: [{ kind: '婴幼儿', doing: '被成人抱着', sleep_scene: false }], risk_cues: [], unclear: [] }],
  materialTexts: [{ origin: 'image_ocr', image: 1, sha256: 'a'.repeat(64), status: 'empty', text: '' }],
  sources: [], ...extra });
const answer = (evidence) => ({ evidenceHash: evidence.evidenceHash,
  decisions: evidence.records.map(record => ({ id: record.id, kind: 'observation',
    claimIds: evidence.claims.filter(claim => claim.recordIds.includes(record.id)).map(claim => claim.id) })),
  sleepReviews: (evidence.sleepObligations ?? []).map((obligation, index) => ({ id: obligation.id,
    claimId: evidence.claims[index % evidence.claims.length].id,
    sceneOrdinal: evidence.records.find(record => record.id === obligation.recordIds[0]).ordinal })),
  claims: evidence.claims.map(claim => ({ id: claim.id, rowHash: claim.rowHash, kind: 'observation',
    sourceAssessment: claim.row.source_id ? 'related_applicable' : 'no_source', reason: '仅确认当前可见画面，不给安全背书。' })) });
const codes = { observation: 'o', unrelated: 'x', nonapplicable: 'n', rule_compliance: 'r', other_fact: 'f', safety_claim: 's', infant_safety_unknown: 'u' };
const wireAnswer = (result, evidence) => ({ ...result, decisions: result.decisions.map(decision => [
  evidence.records.find(record => record.id === decision.id)?.ordinal ?? 0, codes[decision.kind] ?? 'invalid', decision.claimIds]) });
const reply = value => ({ ok: true, finishReason: 'stop', message: { content: JSON.stringify(value) } });
async function run(value = input(), mutate = () => {}, observe = () => {}) {
  requireApi();
  return api.adjudicateImageClaims(value, { chat: async (messages, options) => {
    const evidence = decodeImageClaimView(JSON.parse(messages[1].content)); observe(evidence, messages, options);
    const result = answer(evidence); mutate(result, evidence); return reply(wireAnswer(result, evidence));
  } });
}

test('纯抱婴观察无需AAP，完整本轮记录与每C逐一复核', async () => {
  const result = await run();
  assert.equal(result.ok, true, result.reason); assert.deepEqual(result.missing, []);
  assert.equal(result.claims.length, 1); assert.ok(result.decisions.length > 10);
});
test('非睡眠适用范围说明无需强制引用', async () => {
  const result = await run(input([['C1', '本图非睡眠场景', '不适用', '睡眠指南不用于评价本图抱姿。', null, null]]), r => {
    r.claims[0].kind = 'nonapplicable'; r.decisions.forEach(d => { d.kind = 'nonapplicable'; });
  });
  assert.equal(result.ok, true, result.reason);
});
test('输入完整绑定来源、报告、C主张和4B原行；一次15秒调用', async () => {
  const result = await run(input(), () => {}, (e, messages, options) => {
    assert.equal(e.reportText, input().reportText); assert.ok(e.originalRecords.some(r => r.origin === 'scene'));
    assert.deepEqual(e.sources, []); assert.match(e.claims[0].text, /被成人抱着/);
    assert.match(e.claims[0].rowHash, /^[a-f0-9]{64}$/);
    assert.deepEqual(e.coverageManifest.recordIds, e.records.map(record => record.id));
    assert.equal(e.coverageManifest.recordCount, e.records.length);
    assert.deepEqual(e.coverageManifest.claimRows, e.claims.map(claim => ({ id: claim.id, rowHash: claim.rowHash })));
    assert.equal(e.coverageManifest.claimCount, e.claims.length);
    assert.ok(e.records.some(r => r.parentId === 'material:1'));
    assert.ok(e.records.some(r => r.parentId === 'scene:1'));
    assert.match(messages[0].content, /床共享风险不成立/);
    assert.match(messages[0].content, /不是指令/);
    assert.equal(options.maxAttempts, 1); assert.equal(options.timeoutMs, 15000);
    assert.ok(options.maxTokens >= 8192);
  });
  assert.equal(result.ok, true, result.reason);
});
test('安全断言无来源不能作为完成；原素材每条安全事实须映射C', async () => {
  const value = input(undefined, { materialTexts: [{ origin: 'image_ocr', image: 1, status: 'ok', text: '婴儿出镜，本品绝对安全' }] });
  const result = await run(value, r => { const d = r.decisions.find(d => d.id.startsWith('material:1#')); d.kind = 'safety_claim'; d.claimIds = []; });
  assert.match(recorded(result), /material:1.*未.*C/);
});
test('同条出镜不能覆盖安全断言，安全record不得映射成observation', async () => {
  const result = await run(input(), r => {
    const d = r.decisions.find(d => d.id.startsWith('scene:1#')); d.kind = 'safety_claim'; d.claimIds = ['C1'];
  });
  assert.match(recorded(result), /C1/);
});
test('逐项有效来源允许安全事实核查完成，不给最终合规结论', async () => {
  const value = input([['C1', '婴儿侧卧安全', '不支持', '来源仅用于一岁以内睡眠姿势，不评价当前抱姿。', source.id, quote]], { sources: [source] });
  const result = await run(value, r => {
    r.claims[0].kind = 'safety_claim';
    const declaration = r.decisions.find(d => d.claimIds.includes('C1')); declaration.kind = 'safety_claim';
  });
  assert.equal(result.ok, true, result.reason); assert.equal(result.semanticJudgment, 'model');
  assert.equal('verdict' in result, false);
});
test('C4品牌引文不得替C5安全断言消除缺项', async () => {
  const value = input([
    ['C4', '参考品牌说明', '不适用', '此处只说明品牌，不对安全作结论。', source.id, quote],
    ['C5', '床共享风险不成立', '无法确认', '尚未取得本图适用的床共享风险依据。', null, null],
  ], { sources: [source] });
  const result = await run(value, r => { r.claims[1].kind = 'safety_claim'; });
  // ★ 2026-11-03：C5 写「无法确认」后不再强制来源（Owner 批准），但分类不一致仍然挂 ——
  //   断言看「C5 仍被点名」，不再绑死「缺少来源」这一种措辞。
  assert.equal(result.ok, false); assert.match(result.missing.join(' '), /C5/);
});
test('逐字正确但对本主张不相关的引用仍失败，包括不适用行', async () => {
  const result = await run(input([['C1', '抱姿', '不适用', '此条仅说明指南不覆盖抱姿，不给安全背书。', source.id, quote]], { sources: [source] }), r => {
    r.claims[0].kind = 'nonapplicable'; r.claims[0].sourceAssessment = 'unrelated_or_inapplicable';
  });
  assert.equal(result.ok, false); assert.match(result.missing.join(' '), /C1.*不相关|C1.*不适用/);
});
test('伪造引用在模型调用前拒绝，不能由模型自证为相关', async () => {
  requireApi(); let calls = 0;
  const result = await api.adjudicateImageClaims(input([['C1', '婴儿侧卧', '支持', '应由本轮来源核查。', source.id, 'This fabricated statement is not in the actual source.']], { sources: [source] }), { chat: async () => { calls++; throw Error('must not call'); } });
  assert.equal(result.ok, false); assert.equal(calls, 0); assert.match(result.missing.join(' '), /引用/);
});
test('明确婴儿未知保守失败，有引用也不能抵消；保留每条记录', async () => {
  const value = input([['C1', '婴儿月龄', '无法确认', '遮挡无法辨认月龄，来源无法确定本图人物年龄。', source.id, quote]], { sources: [source] });
  const result = await run(value, r => {
    r.claims[0].kind = 'infant_safety_unknown';
    for (const id of ['scene:1', 'material:1']) { const d = r.decisions.find(d => d.id.startsWith(id + '#')); d.kind = 'infant_safety_unknown'; d.claimIds = ['C1']; }
  });
  assert.equal(result.ok, false); assert.match(result.missing.join(' '), /未确认|未知/);
  assert.equal(result.decisions.filter(d => d.kind === 'infant_safety_unknown').length, 2);
});
test('来源复核不能声称安全主张已完成而全部原始记录却分类为观察', async () => {
  const result = await run(input([['C1', '婴儿侧卧安全', '不支持', '仅核睡姿，不为当前抱姿背书。', source.id, quote]], { sources: [source] }), r => {
    r.claims[0].kind = 'safety_claim';
  });
  assert.equal(result.ok, false); assert.match(result.missing.join(' '), /C1.*分类/);
});
test('普通产品容量未知有具体缺口仍允许交付，不改变双轨结论政策', async () => {
  const result = await run(input([['C1', '杯子容量350毫升', '无法确认', '缺少对应批次容量实测记录，外观不能判断容积。', null, null]]), r => {
    r.claims[0].kind = 'other_fact';
  });
  assert.equal(result.ok, true, result.reason);
});
test('规则符合性边界写入模型契约，完整规则引述仍保留为待核记录', async () => {
  const rule = 'N-02 规则原文：“奶瓶的卫生重要至极，不要倒着放。”本图瓶子侧放，与该规范不一致。';
  const value = input(undefined, { reportText: report().replace('本轮未命中适用规则，不能据此确认素材合规。', rule) });
  const result = await run(value, (response, evidence) => {
    const record = evidence.originalRecords.find(record => record.text === rule);
    assert.ok(record, '规则原文必须完整保留，不可因不属于4B就过滤输入');
    for (const decision of response.decisions.filter(decision => decision.id.startsWith(record.id + '#'))) {
      decision.kind = 'rule_compliance'; decision.claimIds = [];
    }
  }, (evidence, messages) => {
    assert.match(messages[0].content, /4A规则符合性/);
    assert.match(messages[0].content, /原素材或OCR中的营销引述/);
    assert.match(messages[0].content, /预防疾病/);
  });
  assert.equal(result.ok, true, result.reason);
});
for (const text of ['依据N-02规则，本品绝对安全', '符合N-02，所以没有任何风险',
  '根据规则，本品能够预防疾病', '引述广告：“本品对婴儿绝对安全”']) {
  test(`规则或引述名义不能消除原素材安全主张：${text}`, async () => {
    const value = input(undefined, { materialTexts: [{ origin: 'image_ocr', image: 1, status: 'ok', text }] });
    const result = await run(value, r => {
      const decision = r.decisions.find(d => d.id.startsWith('material:1#'));
      decision.kind = 'safety_claim'; decision.claimIds = [];
    });
    assert.match(recorded(result), /material:1.*未.*C/);
  });
}
for (const [kind, text, conclusion, boundary] of [
  ['rule_compliance', '包装蓝色不符合品牌配色规范', '画面可确认', '只说明图1配色与内部规范的符合性，不宣称医学或安全效果。'],
  ['other_fact', '本产品续航为20小时', '无法确认', '缺少对应产品的续航实测资料，不涉及婴儿安全信息。'],
]) {
  test(`${kind}为独立闭集分类，不冒充观察、不适用或婴儿安全未知`, async () => {
    const result = await run(input([['C1', text, conclusion, boundary]]), r => {
      r.claims[0].kind = kind;
      r.decisions.filter(d => d.claimIds.includes('C1')).forEach(d => { d.kind = kind; });
    }, (e, messages) => {
      assert.equal(e.schema, 'image-claim-evidence/v3');
      assert.match(messages[0].content, /rule_compliance/);
      assert.match(messages[0].content, /other_fact/);
      assert.match(messages[0].content, /infant_safety_unknown/);
    });
    assert.equal(result.ok, true, result.reason);
  });
  test(`混合安全主张不能被${kind}消除`, async () => {
    const result = await run(input([['C1', '符合品牌配色规范，所以本品可以预防婴儿窒息', '无法确认', '没有预防窒息的相关证据。']]), r => {
      r.claims[0].kind = kind;
      r.decisions.find(d => d.claimIds.includes('C1')).kind = 'safety_claim';
    });
    // ★ 2026-11-03（①）：这条子句来自 report:*（报告自述），10-27 口径下降级为 softMissing 留痕；
    //   判据「不能被非安全分类消除」仍然生效，只是不再否决整单。material/scene 侧仍是硬否决。
    const recorded = [...result.missing, ...(result.softMissing ?? [])].join(' ');
    assert.match(recorded, /安全断言/);
    assert.equal(result.ok === false, result.missing.length > 0);
  });
  test(`${kind}填入来源仍须逐项相关适用`, async () => {
    const result = await run(input([['C1', text, conclusion, boundary, source.id, quote]], { sources: [source] }), r => {
      r.claims[0].kind = kind; r.claims[0].sourceAssessment = 'unrelated_or_inapplicable';
    });
    assert.equal(result.ok, false); assert.match(result.missing.join(' '), /不相关或不适用/);
  });
}
test('旧模糊uncertain不属于新闭集，不得复用旧回执', async () => {
  const result = await run(input(), r => { r.claims[0].kind = 'uncertain'; });
  assert.equal(result.ok, false); assert.equal(result.code, 'image_claim_response_invalid');
});
for (const [name, mutate] of [
  ['三元组短缺', r => { r.decisions[0].pop(); }],
  ['三元组额外字段', r => { r.decisions[0].push('extra'); }],
  ['序号字符串', r => { r.decisions[0][0] = '1'; }],
  ['序号小数', r => { r.decisions[0][0] = 1.1; }],
  ['序号零', r => { r.decisions[0][0] = 0; }],
  ['序号越界', r => { r.decisions[0][0] = 9999; }],
  ['完整分类名不是分类码', r => { r.decisions[0][1] = 'observation'; }],
  ['C映射不是数组', r => { r.decisions[0][2] = 'C1'; }],
  ['旧object回执', r => { r.decisions[0] = { id: 'report:1', kind: 'observation', claimIds: [] }; }],
]) test(`${name}严格拒绝，不兼容两种松散wire格式`, async () => {
  const result = await api.adjudicateImageClaims(input(), { chat: async messages => {
    const evidence = decodeImageClaimView(JSON.parse(messages[1].content));
    const response = wireAnswer(answer(evidence), evidence); mutate(response); return reply(response);
  } });
  assert.equal(result.ok, false); assert.equal(result.code, 'image_claim_response_invalid');
});
test('wire三元组保留供cache严格复验，业务decisions归一化且不含伪造解释', async () => {
  const value = input(); const result = await run(value);
  const evidence = api.buildImageClaimEvidence(value);
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(Object.keys(result.decisions[0]).sort(), ['claimIds', 'id', 'kind']);
  assert.equal(result.wireDecisions[0].length, 3);
  assert.equal(api.validateImageClaimAssessment({ evidenceHash: result.evidenceHash,
    decisions: result.wireDecisions, claims: result.claims, sleepReviews: result.sleepReviews }, evidence).ok, true);
  assert.equal(api.validateImageClaimAssessment({ evidenceHash: result.evidenceHash,
    decisions: result.decisions, claims: result.claims, sleepReviews: result.sleepReviews }, evidence).ok, false);
});
const sleeping = { people: [{ kind: '婴儿', panel: '左侧', doing: '在婴儿床侧卧睡眠', sleep_scene: true, sleep_posture: '侧卧' }] };
const aapFixture = { ...source, id: 'aap-safe-sleep-2022', source_hash_verified: true,
  source_sha256: '9b8ee681ec6360e4c2f7356ac77a328c7635d012daa6d254016c263256dcd6bd' };
const sleepInput = (scenes = [sleeping], sources = [aapFixture]) => input([
  ['C1', '图1左侧婴儿侧卧睡眠建议的适用性', '不支持', '来源不建议一岁以内婴儿侧睡，本条核查图1左侧人物睡姿。', sources[0]?.id, sources[0] ? quote : null],
], { scenes, sources });
const markSleepSafety = (response, evidence) => {
  response.claims[0].kind = 'safety_claim';
  response.decisions.find(decision => evidence.claims[0].recordIds.includes(decision.id)).kind = 'safety_claim';
};
test('structured婴儿睡眠true不能靠全部observation取消来源义务', async () => {
  const result = await run(input(undefined, { scenes: [sleeping] }));
  assert.equal(result.ok, false); assert.match(result.missing.join(' '), /睡眠.*安全|AAP/);
});
test('每个婴儿睡眠义务绑定此scene安全C与真实AAP逐字来源', async () => {
  const result = await run(sleepInput(), markSleepSafety, evidence => {
    assert.equal(evidence.sleepObligations.length, 1);
    assert.equal(evidence.sleepObligations[0].parentId, 'scene:1');
    assert.equal(evidence.sleepObligations[0].person.sleep_scene, true);
  });
  assert.equal(result.ok, true, result.reason); assert.equal(result.sleepReviews.length, 1);
});
test('睡眠来源不能用普通已验证来源冒充AAP', async () => {
  const result = await run(sleepInput([sleeping], [source]), markSleepSafety);
  assert.equal(result.ok, false); assert.match(result.missing.join(' '), /AAP/);
});
test('睡眠回执不能遗漏义务或让两个婴儿共用一个C', async () => {
  const missing = await run(sleepInput(), (r, e) => { markSleepSafety(r, e); r.sleepReviews = []; });
  assert.equal(missing.ok, false); assert.equal(missing.code, 'image_claim_response_invalid');
  const duplicate = await run(sleepInput([sleeping, sleeping]), markSleepSafety);
  assert.equal(duplicate.ok, false); assert.equal(duplicate.code, 'image_claim_response_invalid');
});
test('sleepReview显式绑定本person观察，不强迫原始事实伪装安全断言', async () => {
  const result = await run(sleepInput(), markSleepSafety);
  assert.equal(result.ok, true, result.reason);
  assert.ok(result.decisions.filter(d => d.id.startsWith('scene:1#')).every(d => d.kind === 'observation'));
});
for (const [name, ordinal] of [['报告子句', (e) => e.records[0].ordinal],
  ['其他person', (e) => e.records.find(record => record.parentId === 'scene:1').ordinal],
  ['非整数', () => '1'], ['越界', () => 9999]]) {
  test(`sleepReview的${name}不能替本person绑定`, async () => {
    const value = sleepInput([{ people: [{ kind: '成人', doing: '坐着' }] }, sleeping]);
    const result = await run(value, (r, e) => { markSleepSafety(r, e); r.sleepReviews[0].sceneOrdinal = ordinal(e); });
    assert.equal(result.ok, false); assert.equal(result.code, 'image_claim_response_invalid');
  });
}
test('成人睡眠或非睡眠抱婴不制造婴儿睡眠来源义务', async () => {
  const result = await run(input(undefined, { scenes: [{ people: [{ kind: '成人', sleep_scene: true }] },
    { people: [{ kind: '婴儿', doing: '被成人抱着', sleep_scene: false }] }] }), () => {}, evidence => {
    assert.deepEqual(evidence.sleepObligations, []);
  });
  assert.equal(result.ok, true, result.reason);
});
test('明确8岁儿童午睡观察不强制套用婴儿AAP来源', async () => {
  const result = await run(input([['C1', '8岁儿童午睡', '画面可确认', '仅记录儿童午睡画面，不评价安全。']], {
    scenes: [{ people: [{ kind: '儿童', age: '8岁', doing: '午睡', sleep_scene: true }] }],
  }), () => {}, evidence => { assert.deepEqual(evidence.sleepObligations, []); });
  assert.equal(result.ok, true, result.reason);
});
for (const kind of ['婴幼儿', '婴儿', 'infant', 'baby']) test(`${kind}明确睡眠必须建立来源义务`, async () => {
  const result = await run(input(undefined, { scenes: [{ people: [{ kind, sleep_scene: true }] }] }));
  assert.equal(result.ok, false); assert.match(result.missing.join(' '), /AAP/);
});
test('标点子句按offset完整重组所有父记录，Unicode与完整scene对象不丢失', async () => {
  const value = input(undefined, { materialTexts: [{ origin: 'image_ocr', image: 1,
    status: 'ok', text: '，， 😀婴儿出镜，\n本品安全；作者说：“原文”？尾巴。' }] });
  const result = await run(value, () => {}, evidence => {
    assert.ok(evidence.records.length > evidence.originalRecords.length);
    for (const parent of evidence.originalRecords) {
      const children = evidence.records.filter(record => record.parentId === parent.id);
      assert.ok(children.length, parent.id);
      assert.equal(children.map(record => record.text).join(''), parent.text);
      assert.equal(children[0].start, 0);
      assert.equal(children.at(-1).end, parent.text.length);
      children.forEach((child, index) => {
        assert.equal(child.start, index ? children[index - 1].end : 0);
        assert.equal(child.text, parent.text.slice(child.start, child.end));
        assert.equal(child.id, `${parent.id}#${index + 1}`);
      });
    }
    assert.deepEqual(evidence.originalRecords.find(record => record.id === 'scene:1').scene, value.scenes[0]);
    assert.equal(evidence.originalRecords.find(record => record.id === 'material:1').text, value.materialTexts[0].text);
    const material = evidence.records.filter(record => record.parentId === 'material:1');
    assert.ok(material.every(record => !/^[，,；;。！？!?.\s]*$/u.test(record.text)), '纯标点附着相邻子句');
    assert.deepEqual(evidence.coverageManifest.clauses, evidence.records.map(record => [record.ordinal, record.id]));
  });
  assert.equal(result.ok, true, result.reason);
});
test('表格尾部空来源单元和闭合竖线附到实质子句，不单独要求模型分类', async () => {
  const result = await run(input(), () => {}, evidence => {
    for (const parent of evidence.originalRecords) {
      if (/^[\p{P}\p{S}\s]*$/u.test(parent.text)) continue;
      const children = evidence.records.filter(record => record.parentId === parent.id);
      assert.ok(children.every(record => !/^[\p{P}\p{S}\s]*$/u.test(record.text)), parent.text);
      assert.equal(children.map(record => record.text).join(''), parent.text);
    }
  });
  assert.equal(result.ok, true, result.reason);
});
test('同父记录后一子句安全判断不能被前句观察多数覆盖', async () => {
  const value = input(undefined, { materialTexts: [{ origin: 'image_ocr', image: 1,
    status: 'ok', text: '婴儿出镜，没有睡眠画面，床共享风险不成立。' }] });
  const result = await run(value, (response, evidence) => {
    const child = evidence.records.find(record => record.text === '床共享风险不成立。');
    assert.ok(child, '风险句必须是独立必答子句');
    response.decisions.find(decision => decision.id === child.id).kind = 'safety_claim';
  });
  assert.match(recorded(result), /婴儿安全事实仍未确认|安全主张|明确未知/);
  assert.equal(result.parentDecisions.find(decision => decision.id === 'material:1').kind, 'safety_claim');
});
test('C编号之后的子句仍强制绑定该C：模型漏抄由宿主补上（A 方案，不再否决整单）', async () => {
  let target = null;
  const result = await run(input(), (response, evidence) => {
    const claim = evidence.claims[0];
    target = evidence.records.find(record => claim.recordIds.includes(record.id)
      && !/C1/.test(record.text));
    assert.ok(target, '必须存在 C1 之后的绑定子句');
    response.decisions.find(decision => decision.id === target.id).claimIds = [];
  });
  // 宿主绑定是权威：模型漏抄不否决整单（2026-11-03 三单全死在这一条上）
  assert.equal(result.ok, true, result.reason);
  // 但绑定本身没有丢：那条子句被补上了 C1
  const decision = result.decisions.find(item => item.id === target.id);
  assert.ok(decision.claimIds.includes('C1'), '补绑后该子句必须关联 C1');
});
test('补绑必须留痕：点名第几句、补了哪个 C、模型原本标了什么', async () => {
  const result = await run(input(), (response, evidence) => {
    const claim = evidence.claims[0];
    const target = evidence.records.find(record => claim.recordIds.includes(record.id)
      && !/C1/.test(record.text));
    assert.ok(target, '必须存在 C1 之后的绑定子句');
    response.decisions.find(decision => decision.id === target.id).claimIds = [];
  });
  assert.equal(result.ok, true, result.reason);
  // 反向对照：静默补绑与「补了但说不出补在哪」都不许
  const fill = result.bindingFills.find(item => item.filledIds.includes('C1'));
  assert.ok(fill, '补绑必须留痕，不能静默');
  assert.ok(Number.isInteger(fill.ordinal), '留痕必须点名第几句');
  assert.ok(typeof fill.snippet === 'string' && fill.snippet.length > 0, '留痕必须带出那句原文');
  assert.deepEqual(fill.modelIds, [], '留痕必须记下模型原本标了什么');
  // 正例：一条都没漏的答卷不许出现补绑痕迹
  const clean = await run(input(), () => {});
  assert.equal(clean.ok, true, clean.reason);
  assert.deepEqual(clean.bindingFills, [], '没漏就不该补');
});
test('子句偏移篡改或父原文篡改使全输入hash失效', () => {
  requireApi();
  for (const mutate of [e => { e.records[0].start = 1; }, e => { e.originalRecords[0].text += '新字'; }]) {
    const evidence = api.buildImageClaimEvidence(input()); mutate(evidence);
    assert.equal(api.validateImageClaimAssessment(wireAnswer(answer(evidence), evidence), evidence).ok, false);
  }
});
test('超过子句上界明确失败而不截取记录、不调用模型', async () => {
  let calls = 0;
  const value = input(undefined, { materialTexts: [{ origin: 'image_ocr', image: 1,
    status: 'ok', text: '内容，'.repeat(401) }] });
  const result = await api.adjudicateImageClaims(value, { chat: async () => { calls++; return reply({}); } });
  assert.equal(result.ok, false); assert.equal(result.code, 'image_claim_input_invalid');
  assert.equal(calls, 0); assert.match(result.reason, /子句.*超限/);
});
test('两条婴儿未知分别保留，不能用一条不适用吞掉另一条', async () => {
  const value = input([
    ['C1', '婴儿月龄', '无法确认', '画面遮挡不能识别月龄。', null, null],
    ['C2', '是否与成人同床', '无法确认', '画面未覆盖完整床面，无法确认睡眠关系。', null, null],
  ]);
  const result = await run(value, r => {
    r.claims.forEach(c => { c.kind = 'infant_safety_unknown'; });
    r.decisions.filter(d => d.claimIds.length).forEach(d => { d.kind = 'infant_safety_unknown'; });
  });
  assert.equal(result.ok, false); assert.equal(result.claims.filter(c => c.kind === 'infant_safety_unknown').length, 2);
  assert.match(result.missing.join(' '), /C1/); assert.match(result.missing.join(' '), /C2/);
});

for (const [name, mutate] of [
  ['缺record', r => r.decisions.pop()], ['重复record', r => { r.decisions[1] = r.decisions[0]; }],
  ['未知record', r => { r.decisions[0].id = 'unknown:1'; }], ['未知分类', r => { r.decisions[0].kind = 'safe'; }],
  ['缺C', r => r.claims.pop()], ['重复C', r => r.claims.push(r.claims[0])],
  ['未知C', r => { r.claims[0].id = 'C99'; }], ['未知映射C', r => { r.decisions[0].claimIds = ['C99']; }],
  ['错误rowHash', r => { r.claims[0].rowHash = 'x'; }], ['旧evidenceHash', r => { r.evidenceHash = 'x'; }],
  ['未声明引用分类', r => { r.claims[0].sourceAssessment = 'maybe'; }],
  ['无来源却声称已核', r => { r.claims[0].sourceAssessment = 'related_applicable'; }],
  ['来源解释为空', r => { r.claims[0].reason = ''; }],
  // 「报告C行映射错位」原先靠「模型漏抄绑定 ⇒ 拒收」来判；A 方案（2026-11-03 Owner「按 A 做」）
  // 把漏抄改成宿主补绑，这一格不再属于「必须闭门」——改由上面两条「补绑必须留痕」正面守着。
]) test(`${name}闭门失败`, async () => {
  const result = await run(input(), mutate); assert.equal(result.ok, false); assert.match(result.code, /response_invalid/);
});
test('全输入hash随来源正文、范围、图中文字或报告变化，绑定对象不受外部修改', async () => {
  requireApi(); const a = api.buildImageClaimEvidence(input()); assert.equal(a.ok, true);
  for (const value of [input(undefined, { sources: [source] }), input(undefined, { reportText: report() + '\n补充说明。' }),
    input(undefined, { materialTexts: [{ origin: 'image_ocr', status: 'ok', text: '原图新字' }] })]) {
    const b = api.buildImageClaimEvidence(value); assert.equal(b.ok, true); assert.notEqual(a.evidenceHash, b.evidenceHash);
  }
  const b = api.buildImageClaimEvidence(input(undefined, { sources: [source] }));
  b.sources[0].scope = 'changed';
  assert.equal(api.validateImageClaimAssessment(wireAnswer(answer(b), b), b).ok, false);
});
for (const [name, value] of [['null', null], ['没有场景', input(undefined, { scenes: [] })],
  ['没有原图文字记录', input(undefined, { materialTexts: [] })], ['legacy缺逐项表', input(undefined, { reportText: '报告未完成' })],
  ['空主张编号', input(undefined, { reportText: report().replace('C1：被成人抱着。', 'C1：') })],
  ['来源编号重复', input(undefined, { sources: [source, source] })]]) test(`${name}不调模型`, async () => {
  requireApi(); let calls = 0;
  const result = await api.adjudicateImageClaims(value, { chat: async () => { calls++; return reply({}); } });
  assert.equal(result.ok, false); assert.equal(calls, 0); assert.ok(result.missing.length);
});
test('模型失败、截断和无效JSON不宣称完成，且每次仅调用一次', async () => {
  requireApi();
  for (const response of [{ ok: false, retryable: false }, { ...reply({}), finishReason: 'length' }, { ok: true, finishReason: 'stop', message: { content: 'not json' } }]) {
    let calls = 0; const result = await api.adjudicateImageClaims(input(), { chat: async () => { calls++; return response; } });
    assert.equal(result.ok, false); assert.equal(calls, 1); assert.ok(result.missing.length);
  }
});
test('第三节表声明允许映射列和正文交叉引用，不误报重复或切断主张', async () => {
  const declarations = '| 编号 | 主张 | 4B 行 |\n|---|---|---|\n| C1 | 被成人抱着 | C1 |\n\n（C1仅用于观察；对应C1行。）';
  const value = input(undefined, { reportText: report().replace('C1：被成人抱着。', declarations) });
  const result = await run(value, () => {}, evidence => {
    assert.equal(evidence.claims.length, 1); assert.equal(evidence.claims[0].text, '被成人抱着');
    assert.ok(evidence.reportText.includes('（C1仅用于观察；对应C1行。）'));
  });
  assert.equal(result.ok, true, result.reason);
});
test('历史非法编号原文完整保留，C6′不被宿主强制绑定当前C6', async () => {
  const value = input([['C6', '被成人抱着', '画面可确认', '图1仅观察抱婴，不评价安全。']], {
    reportText: report([['C6', '被成人抱着', '画面可确认', '图1仅观察抱婴，不评价安全。']]) + '\n> 历史待核原文：C6′ 适用范围另核。',
  });
  const result = await run(value, () => {}, evidence => {
    const history = evidence.originalRecords.find(record => record.text.includes('历史待核原文'));
    assert.ok(history);
    assert.ok(!evidence.claims[0].recordIds.some(id => evidence.records.find(r => r.id === id).parentId === history.id));
  });
  assert.equal(result.ok, true, result.reason);
});
test('4B非法编号拒收时指明原label，不能只给行数不符而遮住修复对象', async () => {
  const value = input(undefined, { reportText: report().replace('### 图文一致性',
    '| C1a 子主张 | 无法确认 | 没有当前证据。 | — | — |\n### 图文一致性') });
  const result = await run(value);
  assert.equal(result.ok, false); assert.match(result.reason, /非法.*C1a/);
});

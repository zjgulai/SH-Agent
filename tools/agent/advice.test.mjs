/**
 * advice.test.mjs —— 「修改建议：**写短，不切短**」的自证（离线，不调真模型）
 *
 *   node tools/agent/advice.test.mjs
 *
 * ★ 为什么要有它（Owner 2026-10-19 逐字）：
 *   「这里的 修复建议都没讲完，**被截断了**，不能出现这种情况」
 *   真报告里 6 条建议有 3 条被 `…` 切在半句上（最狠一条只剩「改为…」）。
 *   病灶在**产出侧**：提示词要 ≤60，模型不照做 ⇒ 渲染层就切 ⇒ 拿到的是半句。
 *   ⇒ 这里钉的是：**超了就再问一次让它自己压**；压不成 ⇒ **原样留着**（完整 > 半句）。
 *   渲染层不切那一半在 `dual_track --selftest` 的 ㉖（含反向对照 ㉖d）。
 */
import assert from 'node:assert/strict';
import { generateAdvice, adviceChars, ADVICE_MAX, rejectUnsupportedHistoricalDisposition,
  rejectUnverifiedOcrCorrection } from './advice.mjs';

let pass = 0; const bad = [];
const t = async (name, fn) => {
  try { await fn(); pass += 1; console.log(`  ✅ ${name}`); } catch (e) { bad.push(name); console.log(`  ❌ ${name}\n       ${e?.message ?? e}`); }
};

const LONG = '改法首选：把标题改为 Ideal Rhythm for Comfortable Pumping，并把正文首句改成一句完整英文'
  + '；次选：删掉 Boosts Milk Supply 这一整句，在正文首句补一句本品适用场景的说明。';
const SHORT = '删去 unique，改为描述双层密封结构';
const ITEM = { location: '全文', category: '合规与受监管宣称', sub: '绝对化用语', reason: '绝对化比较级' };

/** 桩：第一次回长句，第二次（压缩那一问）回短句。 */
const askScripted = (first, second) => {
  const calls = [];
  const ask = async (prompt, opts) => {
    calls.push({ prompt, system: opts?.system ?? '' });
    return calls.length === 1 ? first : second;
  };
  return { ask, calls };
};

await t(`A1 模型第一次写超了 ⇒ **再问一次压**，最终 ≤${ADVICE_MAX} 字且是完整句`, async () => {
  const { ask, calls } = askScripted(
    JSON.stringify([{ i: 0, advice: LONG }]),
    JSON.stringify([{ i: 0, advice: '标题改讲体温计套装，吸奶器排名句移出本页' }]));
  const r = await generateAdvice({ items: [ITEM], ask });
  assert.equal(r.ok, true, '整个调用应成功');
  assert.equal(calls.length, 2, `应当问两次（原写 + 压一次），实得 ${calls.length}`);
  assert.ok(adviceChars(r.advice[0]) <= ADVICE_MAX, `仍超 ${ADVICE_MAX} 字：${r.advice[0]}`);
  assert.ok(!/…|\.\.\./.test(r.advice[0]), `压出来的还是半句：${r.advice[0]}`);
  assert.equal(r.compressed, 1, '读数里要记「压过几条」');
  assert.deepEqual(r.over_length, [], '压成功后不该再有超长项');
});

await t(`A2 反向对照：本来就 ≤${ADVICE_MAX} 字 ⇒ **不许**再问第二次（别为了凑数多花一次调用）`, async () => {
  const { ask, calls } = askScripted(JSON.stringify([{ i: 0, advice: SHORT }]), '[]');
  const r = await generateAdvice({ items: [ITEM], ask });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1, '短句不该触发压缩');
  assert.equal(r.advice[0], SHORT, '短句必须逐字保留');
});

await t('A3 压缩也压不下来 ⇒ **留原句**（完整 > 半句），且读数如实标 over_length', async () => {
  const { ask } = askScripted(JSON.stringify([{ i: 0, advice: LONG }]), JSON.stringify([{ i: 0, advice: LONG }]));
  const r = await generateAdvice({ items: [ITEM], ask });
  assert.equal(r.ok, true);
  assert.equal(r.advice[0], LONG, '压不下来时**不许**用半句顶替，必须留完整原句');
  assert.ok(!/…$/.test(r.advice[0]), '不许自己补省略号');
  assert.deepEqual(r.over_length, ['0'], '超长项要能被下游看见（不静默）');
});

await t('A4 压缩调用抛错 ⇒ 照样留原句（建议不能因为压缩失败而消失）', async () => {
  let n = 0;
  const ask = async () => { n += 1; if (n === 1) return JSON.stringify([{ i: 0, advice: LONG }]); throw new Error('boom'); };
  const r = await generateAdvice({ items: [ITEM], ask });
  assert.equal(r.ok, true);
  assert.equal(r.advice[0], LONG);
});

await t(`A5 system 提示词里必须写着 ≤${ADVICE_MAX}（判据钉住"写短"这件事本身，不是钉渲染层）`, async () => {
  const { ask, calls } = askScripted(JSON.stringify([{ i: 0, advice: SHORT }]), '[]');
  await generateAdvice({ items: [ITEM], ask });
  assert.ok(new RegExp(`≤${ADVICE_MAX} 字`).test(calls[0].system), `给模型的 system 里没有 ≤${ADVICE_MAX} 字的要求`);
  // 反向对照：用户提示词里也得带上条目本体（证明它传的是这一条，不是空跑）
  assert.ok(/全文/.test(calls[0].prompt), '用户提示词里没有条目正文');
});

await t('A6 标点不计：字符数 >30、实词 ≤30 ⇒ **不该**触发压缩（Owner：不带标点，可以多写一些）', async () => {
  const PUNCT = '删「最」字，改为「更」；补一行日期，并在详情页写清适用月龄与固定方式';
  assert.ok(PUNCT.length > 30, '夹具太短，量不出"字符数超了"');
  assert.ok(adviceChars(PUNCT) <= ADVICE_MAX, `实词数应 ≤${ADVICE_MAX}：${adviceChars(PUNCT)}`);
  const { ask, calls } = askScripted(JSON.stringify([{ i: 0, advice: PUNCT }]), '[]');
  const r = await generateAdvice({ items: [ITEM], ask });
  assert.equal(calls.length, 1, '标点不计后没超 ⇒ 不许再问一次');
  assert.equal(r.advice[0], PUNCT, '原句必须逐字保留（该断句就断句）');
});

await t('A7 历史源记录没给改法时，禁止模型把缺失信息推成禁止/打回', async () => {
  const unsafe = '源记录未给改法 ⇒ 按禁止/打回处理';
  assert.equal(rejectUnsupportedHistoricalDisposition(unsafe), true,
    '这次真实回复的无依据升级形状没有被识别');
  assert.equal(rejectUnsupportedHistoricalDisposition('删去该机构署名'), false,
    '具体编辑建议不应被误拦');
  assert.equal(rejectUnsupportedHistoricalDisposition('将这条意见按禁止/打回处理', {
    source: 'kb', kb: { reasonLine: '相似历史审核意见（point·参考）', suggestionLine: null },
  }), true, '即使模型删掉「源记录没给建议」这半句，也不能对无建议历史意见作处置升级');
  const { ask, calls } = askScripted(JSON.stringify([{ i: 0, advice: unsafe }]), '[]');
  const r = await generateAdvice({ items: [{ ...ITEM, source: 'kb', kb: { reasonLine: '相似历史记录；源记录未给改法' } }], ask });
  assert.equal(r.ok, true);
  assert.deepEqual(r.advice, {}, '无依据的禁止/打回建议必须在生成后闸门中删除');
  assert.deepEqual(r.rejected_unsupported, [0], '被拦建议必须留可观察读数');
  assert.ok(/不能把「没有建议」推成「禁止、打回、拒绝发布」/.test(calls[0].system),
    '建议模型提示词没写禁止这一推断');
});

await t('A8 ★ 未经原图确认的 OCR 纯格式修正必须拒绝', async () => {
  const bad = "把00:04的「Eufy-S1'Pro」改成「Eufy S1 Pro」，全片统一品牌写法";
  assert.equal(rejectUnverifiedOcrCorrection(bad, {
    description: '横测视频需核对按摩功能对比、刻度线特写与品牌名',
    reason: '命中同款横测记录',
  }), true, '纯空格/连字符/撇号差异没有原图锚点，不许生成修改建议');
  assert.equal(rejectUnverifiedOcrCorrection(bad, {
    description: '关键帧原图可直接看到竞品名连字符与撇号有误',
    visual_anchor: "关键帧 00:04 原图可见 Eufy-S1'Pro",
  }), false, '有明确原图视觉锚点的真拼写问题不应误拦');
});

await t('A9 ★ 建议生成后闸门删除 OCR 噪声改法并留下读数', async () => {
  const advice = "把00:04的「Eufy-S1'Pro」改成「Eufy S1 Pro」";
  const { ask } = askScripted(JSON.stringify([{ i: 0, advice }]), '[]');
  const r = await generateAdvice({ items: [{ ...ITEM,
    description: '需核对按摩功能对比、刻度线特写与品牌名' }], ask });
  assert.deepEqual(r.advice, {});
  assert.deepEqual(r.rejected_ocr_noise, [0]);
});

console.log(`\n═══ 合计：通过 ${pass} / 失败 ${bad.length} ═══`);
if (bad.length) { console.log('失败明细：'); for (const b of bad) console.log('  ·', b); }
process.exit(bad.length ? 1 : 0);

#!/usr/bin/env node
/**
 * scene.test.mjs —— **画面层**的判据（2026-10-15）
 *
 *   node tools/agent/scene.test.mjs
 *
 * ⚠️ **一个字节都不发**：全部走注入的 `fetchImpl` 桩。真网络那一条在
 *    `tools/test_agent.mjs` 的「画面层」一组（真跑试纸），这里只证**判据**。
 *
 * ── 这个文件是为哪一次事故写的
 *
 *   2026-10-15：一张**只有品牌字样**的图被审出「逐字命中 ibclc」——
 *   那是另一个并发单的结论（旁挂串单，另案）。但顺着查下去发现**更缺的一块**：
 *   PRD §5.1 把图片的输入写成两半（**OCR ＋ 基础视觉识别**），而这一层**从来没做**,
 *   两侧吃的都是同一份图内文字 ⇒ PRD 要求的「产品使用 / 人物行为 / 场景风险」
 *   **整类没有东西在判**。起因是 `vision.mjs` 头注那句「模型不吃图」——
 *   当天实测否掉（同一个端点带 image_url ⇒ HTTP 200）。
 *
 * ── 判据分四类（每条都写了「拆掉它会怎样」）
 *
 *   S1 解析：**只认 JSON**（散文/空 ⇒ `ok:false`）——「读不到」与「没有画面」必须分得开
 *   S2 守卫：**只读临时目录里的图**（§2.6 那条加宽的边界就在这一个函数里）
 *   S3 截断：`finish_reason: 'length'` ⇒ **未测**（这是我当场踩的坑，见下）
 *   S4 失败面：HTTP 错 / 超时 / 空内容 ⇒ 一律 `ok:false`，且**永不抛**
 *   S5 反向对照：合法的读数**必须收下**（闸门不许成砖头）+ 摊开时空项要写明「读数里没有」
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseScene, sceneBlock, sceneLine, assertTempPath, sceneRead, shrinkForModel,
  SCENE_SYSTEM, SCENE_MAX_EDGE, SCENE_SHRINK_OVER_BYTES, abnormalContainers,
  infantSleepReadings, preflight } from './scene.mjs';
import { calibrateOcrText } from './vision.mjs';
import { restatePerPanelSleep, restateChecklistEvidence, checkVisualChecklist, checkImageSkillWorkflow } from './visual_checklist.mjs';

const results = [];
const check = (id, fn) => {
  try { fn(); results.push({ id, ok: true }); }
  catch (e) { results.push({ id, ok: false, detail: e.message }); }
};
const checkAsync = async (id, fn) => {
  try { await fn(); results.push({ id, ok: true }); }
  catch (e) { results.push({ id, ok: false, detail: e.message }); }
};

const GOOD = JSON.stringify({
  setting: '厨房',
  people: [{ kind: '婴幼儿', doing: '被抱着' }],
  products: [{ what: '粉色球形物', in_use: false }],
  visible_marks: ['momcozy'],
  clean_text: ['Momcozy Wellness 1', 'Eufy S1 Pro'],
  risk_cues: ['婴幼儿出镜'],
  unclear: ['月龄'],
});

/* ── S1 解析：只认 JSON ───────────────────────────────────────────────── */
check('S1a 标准 JSON ⇒ 收下，字段齐全', () => {
  const r = parseScene(GOOD);
  assert.strictEqual(r.ok, true, `没收下：${JSON.stringify(r)}`);
  assert.strictEqual(r.scene.setting, '厨房');
  assert.strictEqual(r.scene.people[0].kind, '婴幼儿');
  assert.deepStrictEqual(r.scene.visible_marks, ['momcozy']);
  assert.deepStrictEqual(r.scene.clean_text, ['Momcozy Wellness 1', 'Eufy S1 Pro']);
});
check('S1b 包在 ```json 围栏里 ⇒ 脱一层围栏收下（模型常见写法）', () => {
  assert.strictEqual(parseScene('```json\n' + GOOD + '\n```').ok, true);
});
check('S1c ★ 散文 ⇒ **拒**（`ok:false`）—— 把散文当读数就是 §2.4.1 那个病', () => {
  const r = parseScene('这张图看起来是一位妈妈在厨房，没有明显问题。');
  assert.strictEqual(r.ok, false, '散文被当成读数收下了');
  assert.ok(/不是 JSON/.test(r.error), `错误文案没说清是 JSON 的问题：${r.error}`);
});
check('S1d 空内容 ⇒ 拒，且与「没有画面」不是同一句话', () => {
  const r = parseScene('   ');
  assert.strictEqual(r.ok, false);
  assert.ok(/空内容/.test(r.error), r.error);
});
check('S1e 缺字段 ⇒ 收下但**如实留空**（不许拿「未给」冒充事实）', () => {
  const r = parseScene('{}');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.scene.setting, '未给');
  assert.deepStrictEqual(r.scene.risk_cues, []);
});
check('S1f 字符串写成数组的地方 ⇒ 归一，不炸', () => {
  const r = parseScene(JSON.stringify({ setting: '浴室', visible_marks: 'momcozy' }));
  assert.deepStrictEqual(r.scene.visible_marks, ['momcozy']);
});
check('S1g ★ 婴儿睡眠场景逐人结构化记录睡姿；缺字段不得默认仰卧', () => {
  const r = parseScene(JSON.stringify({ people: [
    { kind: '婴幼儿', panel: '左上', doing: '闭眼睡觉', sleep_scene: true, sleep_posture: '侧卧', sleep_posture_basis: '身体侧面贴床' },
    { kind: '婴幼儿', panel: '右下', doing: '躺在婴儿床', sleep_scene: true, sleep_posture: '仰卧', sleep_posture_basis: '背部贴床、面部朝上' },
  ] }));
  assert.strictEqual(r.scene.people[0].sleep_posture, '侧卧');
  assert.strictEqual(r.scene.people[0].panel, '左上');
  assert.strictEqual(r.scene.people[0].sleep_posture_basis, '身体侧面贴床');
  assert.strictEqual(r.scene.people[1].sleep_posture, '仰卧');
  assert.strictEqual(parseScene(JSON.stringify({ people: [{ kind: '婴幼儿', doing: '睡觉' }] }))
    .scene.people[0].sleep_posture, '未给', '缺少姿势字段时不许默认成仰卧');
  assert.strictEqual(parseScene(JSON.stringify({ people: [{ kind: '婴幼儿', doing: '被抱着', sleep_posture: '不适用' }] }))
    .scene.people[0].sleep_posture, '不适用');
});
check('S1g-2 ★ 睡眠面板逐个投闸；未知/缺读数不许当成没有睡眠风险', () => {
  const sc = parseScene(JSON.stringify({ people: [
    { kind: '婴幼儿', panel: '左侧', doing: '侧身睡觉', sleep_scene: true, sleep_posture: '侧卧', sleep_posture_basis: '身体侧面贴床' },
    { kind: '婴幼儿', panel: '右侧', doing: '躺着', sleep_scene: null, sleep_posture: '未给' },
    { kind: '婴幼儿', panel: '底部', doing: '被抱着', sleep_scene: false, sleep_posture: '不适用' },
  ] })).scene;
  const rows = infantSleepReadings([sc]);
  assert.strictEqual(rows.length, 2, '明确非睡眠的婴儿不进入睡姿闸；其余面板都必须核对');
  assert.deepStrictEqual(rows.map((x) => [x.panel, x.position]), [['左侧', '侧卧'], ['右侧', '看不清']]);
});
// ★★ 2026-10-16 加（汉字声称闸的确认依据）：`text_script` —— 只报"用的是什么文字"。
check('S1g ★ `text_script` 落在闭集里 ⇒ 收下（汉字声称闸唯一的一手视觉证据）', () => {
  for (const v of ['英文', '中文', '中英混排', '其他文字', '无文字', '无法辨认']) {
    assert.strictEqual(parseScene(JSON.stringify({ text_script: v })).scene.text_script, v, v);
  }
  assert.strictEqual(parseScene('{}').scene.text_script, '未给', '缺字段要如实留「未给」');
});
check('S1h ★ 反向对照：闭集外的自由发挥（「中文和英文混着」）⇒ 落「未给」，不许当证据', () => {
  assert.strictEqual(parseScene(JSON.stringify({ text_script: '中文和英文混着' })).scene.text_script, '未给');
  assert.strictEqual(parseScene(JSON.stringify({ text_script: 'Chinese' })).scene.text_script, '未给');
});
check('S1i ★ clean_text 只收字符串数组并限量；非法对象不得混进视觉校准证据', () => {
  const r = parseScene(JSON.stringify({ clean_text: ['Eufy S1 Pro', '', { text: '不要收我' }] }));
  assert.deepStrictEqual(r.scene.clean_text, ['Eufy S1 Pro'],
    'clean_text 非字符串对象不许被 String() 成伪证据');
});
check('S1j 超量视觉文字必须留下截断状态，不能把前 20 行冒充全文', () => {
  const ordinaryLines = Array.from({ length: 20 }, (_, i) => `普通产品文案 ${i + 1}`);
  const r = parseScene(JSON.stringify({ clean_text: [...ordinaryLines, '本品可预防婴儿窒息'] }));
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.scene.clean_text, ordinaryLines, '保留现有 20 行上限和原文顺序');
  assert.strictEqual(r.scene.clean_text_truncated, true, '丢掉的第 21 行不能被标记成已完整读取');
});
check('S1k 空文本和恰好 20 行都是完整读数，不得误报截断', () => {
  for (const lines of [[], Array.from({ length: 20 }, (_, i) => `文案 ${i + 1}`)]) {
    const r = parseScene(JSON.stringify({ clean_text: lines }));
    assert.deepStrictEqual(r.scene.clean_text, lines);
    assert.strictEqual(r.scene.clean_text_truncated, false, `完整的 ${lines.length} 行被误报截断`);
  }
});
check('S1l 视觉文字截断状态按有效文字计数，不把空白或非法对象算作被截文案', () => {
  const lines = Array.from({ length: 20 }, (_, i) => `文案 ${i + 1}`);
  const r = parseScene(JSON.stringify({ clean_text: ['', ' ', { text: '非法对象' }, ...lines] }));
  assert.deepStrictEqual(r.scene.clean_text, lines);
  assert.strictEqual(r.scene.clean_text_truncated, false);
});

/* ── S2 守卫：只读临时目录 ────────────────────────────────────────────── */
check('S2a 仓内路径 ⇒ **拒**（这是 §2.6 加宽那条边界唯一的执行点）', () => {
  assert.throws(() => assertTempPath('/Users/lute/project/audit_multi_content/PRD/x.png'),
    /只读临时目录/, '仓内图没被拒 —— 边界形同虚设');
});
check('S2b 反向对照：/tmp 下的图 ⇒ 放行（闸门不许成砖头）', () => {
  assert.ok(assertTempPath('/tmp/shouheng-img-abc.png').startsWith('/tmp/'));
});

/* ── S3 截断：真事故的判据 ─────────────────────────────────────────────── */
await checkAsync('S3 ★ `finish_reason=length` ⇒ **未测**，不许把半份 JSON 当读数', async () => {
  // 实测原话（2026-10-15，max_tokens=700 时）：`画面读数 JSON 解不出：Expected ',' or ']'
  // after array element in JSON at position 518` —— **报错指向"模型写坏了 JSON"，
  // 而真因是我给的额度不够**。判据必须比**内容的完整性**，不能比那句报错。
  const cut = GOOD.slice(0, 60);
  const r = await sceneRead('/tmp/x.png', {
    fetchImpl: async () => ({ ok: true, json: async () => ({
      choices: [{ finish_reason: 'length', message: { content: cut } }] }) }),
  });
  // ⚠️ 文件不存在 ⇒ 在此之前就会以「读不到那张临时图」失败；要证的是**截断那一支**，
  //    所以这里用 `fs` 真写一个临时文件（真实现读的是盘上那份字节）。
  const p = '/tmp/shouheng-scene-test-truncated.jpg';
  fs.writeFileSync(p, Buffer.from([0xff, 0xd8, 0xff, 0x00]));
  try {
    const r2 = await sceneRead(p, {
      fetchImpl: async () => ({ ok: true, json: async () => ({
        choices: [{ finish_reason: 'length', message: { content: cut } }] }) }),
    });
    assert.strictEqual(r2.ok, false, '截断的读数被收下了');
    assert.ok(/截断/.test(r2.error) && /未测/.test(r2.error),
      `截断的错误文案必须说清「截断 + 未测」：${r2.error}`);
  } finally { fs.unlinkSync(p); }
  assert.strictEqual(r.ok, false, '（文件不存在那一支也必须 ok:false）');
});
await checkAsync('S3b ★ 截断后只重试一次并翻倍预算，完整 JSON 才恢复读数', async () => {
  const p = '/tmp/shouheng-scene-test-retry.jpg';
  fs.writeFileSync(p, Buffer.from([0xff, 0xd8, 0xff, 0x00]));
  const budgets = [];
  try {
    const r = await sceneRead(p, { maxTokens: 1200, fetchImpl: async (_url, init) => {
      budgets.push(JSON.parse(init.body).max_tokens);
      return { ok: true, json: async () => ({ choices: [budgets.length === 1
        ? { finish_reason: 'length', message: { content: GOOD.slice(0, 60) } }
        : { finish_reason: 'stop', message: { content: GOOD } }] }) };
    } });
    assert.deepStrictEqual(budgets, [1200, 2400], '重试必须有界且把预算翻倍');
    assert.strictEqual(r.ok, true, `完整重试读数应通过：${JSON.stringify(r)}`);
  } finally { fs.unlinkSync(p); }
});

/* ── S4 失败面：一律 ok:false，永不抛 ─────────────────────────────────── */
await checkAsync('S4a HTTP 500 ⇒ ok:false 且带上状态码（不许静默当「没画面」）', async () => {
  const p = '/tmp/shouheng-scene-test-http.jpg';
  fs.writeFileSync(p, Buffer.from([0xff, 0xd8, 0xff, 0x00]));
  try {
    const r = await sceneRead(p, { fetchImpl: async () => ({ ok: false, status: 500,
      text: async () => 'boom' }) });
    assert.strictEqual(r.ok, false);
    assert.ok(/HTTP 500/.test(r.error), r.error);
  } finally { fs.unlinkSync(p); }
});
await checkAsync('S4b 网络抛错 / 超时 ⇒ ok:false 且**不抛**（画面层不许拖垮回话）', async () => {
  const p = '/tmp/shouheng-scene-test-net.jpg';
  fs.writeFileSync(p, Buffer.from([0xff, 0xd8, 0xff, 0x00]));
  try {
    const r = await sceneRead(p, { fetchImpl: async () => { const e = new Error('fetch failed');
      e.cause = { code: 'ENOTFOUND' }; throw e; } });
    assert.strictEqual(r.ok, false);
    assert.ok(/ENOTFOUND/.test(r.error), `错误里要看得见是哪一层断的：${r.error}`);
  } finally { fs.unlinkSync(p); }
});

/* ── S5 反向对照：合法的读数必须收下 ──────────────────────────────────── */
await checkAsync('S5a 桩返回合法 JSON ⇒ ok:true（不许因为上面那些闸门就把正常路堵死）', async () => {
  const p = '/tmp/shouheng-scene-test-good.jpg';
  fs.writeFileSync(p, Buffer.from([0xff, 0xd8, 0xff, 0x00]));
  try {
    const r = await sceneRead(p, { fetchImpl: async () => ({ ok: true, json: async () => ({
      choices: [{ finish_reason: 'stop', message: { content: GOOD } }] }) }) });
    assert.strictEqual(r.ok, true, `正常读数被拒了：${JSON.stringify(r)}`);
    assert.ok(sceneLine(r).includes('婴幼儿'), `一行读数没带上人物：${sceneLine(r)}`);
  } finally { fs.unlinkSync(p); }
});
check('S5b 摊给模型侧时，**空项要写明「读数里没有」**（否则模型会把"没提"当成"没有"）', () => {
  const b = sceneBlock(parseScene('{}').scene);
  assert.strictEqual((b.match(/（读数里没有）/g) ?? []).length, 8, `八项都要写：\n${b}`);
  const b2 = sceneBlock(parseScene(GOOD).scene);
  assert.ok(!/（读数里没有）/.test(b2.split('\n')[0]), '有内容的那一行不该写「读数里没有」');
});
check('S5d ★ 提示词里必须有 `text_script` 那一格与它的 4b 条（掉了 ⇒ 汉字声称闸永远拿不到确认）', () => {
  assert.ok(/"text_script"/.test(SCENE_SYSTEM), '字段表里没有 text_script');
  assert.ok(/只报用的是什么文字/.test(SCENE_SYSTEM), '4b 条（只报脚本、不报内容）掉了');
  assert.ok(/无法辨认/.test(SCENE_SYSTEM), '「看不清就写无法辨认」那条掉了 —— 会逼它猜');
});
check('S5e ★ 反向对照（跨模块）：画面层说「英文/无法辨认」⇒ **不许**被当成确认', () => {
  // 这一条钉的是下游：`ocr_claim_gate.sceneConfirms` 只认「中文 / 中英混排」，
  // 若有人把它放宽成「读数里出现任何文字相关词」，真单（画面说"认不清"）又会降不了级。
  const s1 = sceneBlock(parseScene(JSON.stringify({ text_script: '英文', visible_marks: ['有文字，认不清'] })).scene);
  const s2 = sceneBlock(parseScene(JSON.stringify({ text_script: '无法辨认' })).scene);
  assert.ok(/文字：英文/.test(s1) && /文字：无法辨认/.test(s2), `脚本要摊出来：\n${s1}\n${s2}`);
  assert.ok(!/中文|汉字/.test(s1) && !/中文|汉字/.test(s2), '英文/无法辨认不许被写成中文');
});
check('S5c 提示词里两条硬约束必须在（改提示词时不许悄悄掉）', () => {
  assert.ok(/不许判合规/.test(SCENE_SYSTEM), '「不许判合规」掉了 —— 读数会变成第二个判定者');
  assert.ok(/只写你在这张图里真看到的/.test(SCENE_SYSTEM), '「只写看得见的」掉了');
});
check('S5c-2 ★ clean_text 提示词必须明确逐字、排除水印/UI、不确定留空', () => {
  assert.match(SCENE_SYSTEM, /clean_text/);
  assert.match(SCENE_SYSTEM, /逐字保留大小写、空格、标点/);
  assert.match(SCENE_SYSTEM, /排除截图水印/);
  assert.match(SCENE_SYSTEM, /看不清就不要写/);
});

await checkAsync('S5c-3 ★ ADR-0015 原图直通：默认阈值内不缩；超长边才缩', async () => {
  assert.strictEqual(SCENE_MAX_EDGE, 2560);
  assert.strictEqual(SCENE_SHRINK_OVER_BYTES, 4 * 1024 * 1024);
  const fixture = fileURLToPath(new URL('./__fixtures__/ocr-sample.png', import.meta.url));
  const tmp = path.join(os.tmpdir(), `scene-original-${process.pid}.png`);
  fs.copyFileSync(fixture, tmp);
  try {
    const direct = await shrinkForModel(tmp);
    assert.strictEqual(direct.shrunk, false, '常规小图必须原字节直通');
    assert.strictEqual(direct.path, tmp, '原图直通不许换成有损 JPEG');
    assert.strictEqual(direct.policy, 'original-passthrough');
    const limited = await shrinkForModel(tmp, { maxEdge: 20, overBytes: Number.MAX_SAFE_INTEGER });
    assert.strictEqual(limited.shrunk, true, '超长边必须触发缩图');
    assert.strictEqual(limited.policy, 'dimension');
    limited.cleanup?.();
  } finally { fs.unlinkSync(tmp); }
});

check('S5c-4 ★ 视觉校准只替换高相似行，不新增、不改无关文字', () => {
  const src = "Eufy-S1'Pro\nMomcozy Wellness 1\nUnrelated body copy";
  const got = calibrateOcrText(src, ['Eufy S1 Pro', 'Momcozy Wellness 1', 'New hallucinated text']);
  assert.strictEqual(got.text, 'Eufy S1 Pro\nMomcozy Wellness 1\nUnrelated body copy');
  assert.strictEqual(got.replacements.length, 1);
  assert.strictEqual(got.replacements[0].from, "Eufy-S1'Pro");
  assert.strictEqual(got.replacements[0].to, 'Eufy S1 Pro');
  assert.ok(!got.text.includes('New hallucinated text'), '视觉模型不得给 OCR 凭空新增一行');
  assert.strictEqual(src, "Eufy-S1'Pro\nMomcozy Wellness 1\nUnrelated body copy", '原始 OCR 变量不得被覆盖');
});
check('S5f ★ 睡姿提示：每个婴儿独立判睡姿；看不清不得默认仰卧', () => {
  assert.ok(/逐个判睡姿/.test(SCENE_SYSTEM), '画面读数没有逐个要求睡姿');
  assert.ok(/侧卧/.test(SCENE_SYSTEM) && /俯卧/.test(SCENE_SYSTEM), '侧卧/俯卧不在提示词中');
  assert.ok(/绝不能默认仰卧/.test(SCENE_SYSTEM), '未读到睡姿仍可能被默认成仰卧');
  assert.ok(/"sleep_posture"/.test(SCENE_SYSTEM), '结构化 schema 没有 sleep_posture');
  const block = sceneBlock(parseScene(JSON.stringify({ people: [
    { kind: '婴幼儿', panel: '右下', doing: '闭眼睡觉', sleep_scene: true, sleep_posture: '侧卧', sleep_posture_basis: '身体侧面贴床' },
  ] })).scene);
  assert.ok(/右下 · 婴幼儿 · 闭眼睡觉 · 睡眠场景：是；睡姿：侧卧 · 姿势依据：身体侧面贴床/.test(block), `逐面板侧卧及依据未传到审核输入：\n${block}`);
});
check('S5g ★ 多面板睡姿必须在最终睡眠核对项逐面板复述；只写总体结论要挡住', () => {
  const rows = [
    { image: '图 1', panel: '左侧面板', position: '侧卧', sleep_scene: true },
    { image: '图 1', panel: '右侧面板', position: '仰卧', sleep_scene: true },
  ];
  const prefix = '婴幼儿姿势：无；产品状态：无；场景关系：无；隐私：无；';
  const omitted = checkVisualChecklist(prefix + '婴儿睡眠位置：有（图 1 有婴儿睡眠场景）。', { sleepPositions: rows });
  assert.strictEqual(omitted.ok, false, '只写总括结论不该通行');
  const complete = checkVisualChecklist(prefix + '婴儿睡眠位置：有（左侧面板婴儿侧卧；右侧面板婴儿仰卧）。', { sleepPositions: rows });
  assert.strictEqual(complete.ok, true, complete.reason);
});
// 2026-10-29 真单：吸奶器静物图按要求填写了否定项，却被当作婴儿睡眠审查。
const PRODUCT_WORKFLOW = [
  '审核对象与范围：吸奶器影棚主图。',
  '视觉分析与 OCR：左侧和右侧均为产品静物；两面板均无睡眠场景。',
  '主张拆分与核查清单：品牌与部件名，无医疗宣称。',
  '4A 规则符合性：已核对库内规则。',
  '4B 事实准确性核查：本图无医疗/安全宣称；本轮未做联网检索，未引外部来源。',
  '图文一致性：品牌与部件名和画面一致。',
  '视觉核对：婴幼儿姿势：无（画面无人物）｜婴儿睡眠位置：无（画面没有婴儿睡眠场景）｜产品状态：无｜场景关系：无｜隐私：无',
].join('\n');

check('S5o 产品静物图明确无婴儿睡眠场景，不要求无关的婴儿安全来源', () => {
  const result = checkImageSkillWorkflow(PRODUCT_WORKFLOW);
  assert.strictEqual(result.ok, true, result.reason);
  const table = PRODUCT_WORKFLOW.replace(/^视觉核对：.*$/m,
    '| 类别 | 结论 | 依据 |\n| 婴幼儿姿势 | 无 | 画面无人物 |\n'
    + '| 婴儿睡眠位置 | 无 | 画面没有婴儿睡眠场景 |');
  assert.strictEqual(checkImageSkillWorkflow(table).ok, true, '表格里的否定项也不应触发');
});

check('S5p 真实睡姿、婴儿安全主张、未测与含糊否定仍要求来源', () => {
  for (const claim of [
    '婴儿侧卧睡眠。',
    '婴儿应仰卧睡眠。',
    '婴儿睡眠位置：无（图 1 婴儿仰卧，无风险）。',
    '婴儿睡眠位置：未测（画面遮挡，无法判断）。',
    '无法确认画面没有婴儿睡眠场景。',
    '不能认定画面没有婴儿。',
    '图 1 没有婴儿睡眠场景；图 2 婴儿侧卧。',
    '画面无睡眠场景，但主张婴儿可以同床睡。',
    '婴幼儿姿势：无（坐姿自然，正在吃奶）',
    '婴儿睡眠位置：无（正在熟睡，呼吸正常）',
    '| 婴幼儿姿势 | 无 | 被成人抱在怀中 |',
    '婴儿睡眠位置：无（看不清，无法确认）',
    '| 婴儿睡眠位置 | 无 | 未测：画面遮挡 |',
    '无法确认（画面没有婴儿睡眠场景）',
    '婴儿睡眠位置：无，正在熟睡，呼吸正常',
    '婴儿睡眠位置：无，未测：画面遮挡',
    '无法确认，画面没有婴儿睡眠场景',
    '| 婴幼儿姿势，未测 | 无 | 画面无人物 |',
    '| 图 1 婴儿正在熟睡 | 婴儿睡眠位置 | 无 |',
  ]) {
    const result = checkImageSkillWorkflow(PRODUCT_WORKFLOW + '\n' + claim);
    assert.ok(result.missing.includes('婴儿安全事实的权威来源核查（AAP/HealthyChildren）'), claim);
  }
  assert.strictEqual(checkImageSkillWorkflow(PRODUCT_WORKFLOW + '\n婴儿侧卧；核查来源：AAP。').ok, true);
});

check('S5q 原始睡姿读数优先于报告里的否定，未知睡姿也不能免查', () => {
  const neutral = '审核对象与范围\n视觉分析与 OCR\n主张拆分与核查清单\n4A 规则符合性\n4B 事实准确性核查\n图文一致性';
  for (const position of ['侧卧', '仰卧', '未测']) {
    const options = {
      sleepPositions: [{ image: '图 1', panel: '右侧', position, sleep_scene: true }],
    };
    assert.strictEqual(checkImageSkillWorkflow(neutral, options).ok, false, `报告没提睡姿 ${position} 就免查`);
    assert.strictEqual(checkImageSkillWorkflow(PRODUCT_WORKFLOW, options).ok, false, `真实睡姿 ${position} 被报告的否定句盖掉`);
  }
  assert.strictEqual(checkImageSkillWorkflow(PRODUCT_WORKFLOW, { sleepPositions: [] }).ok, true);
});

check('S5r 不涉及婴儿的图片仍须完成六个审查阶段', () => {
  const result = checkImageSkillWorkflow(PRODUCT_WORKFLOW.replace(/^4B.*\n/m, ''));
  assert.strictEqual(result.ok, false);
  // 2026-11-03：缺项现在带原因（「章名：原因」），按前缀判
  assert.ok(result.missing.some((s) => s.startsWith('4B 事实准确性核查')), result.missing.join('；'));
});

check('S5m ★ 核对项缺依据/缺原因：代码搬读数（Owner：「审查未完成」不能接受的直接落点）', () => {
  const scenes = [{
    scene: '卧室',
    people: [{ panel: '右上', kind: '婴幼儿', doing: '睡觉', sleep_scene: true, sleep_posture: '仰卧' }],
    products: [{ what: '奶瓶', in_use: true, orientation: '倒置' }],
    visible_marks: ['有文字，认不清'], risk_cues: ['画面出现婴幼儿'],
  }];
  const bare = '婴幼儿姿势：无\n婴儿睡眠位置：无\n产品状态：有\n场景关系：未测\n隐私：有';
  // 反向对照（正）：先证明**不补就红**，否则「补完能过」可能是判据本来就绿
  assert.strictEqual(checkVisualChecklist(bare, {}).ok, false, '缺依据/缺原因的清单本来就该被挡住');
  const r = restateChecklistEvidence(bare, { scenes });
  assert.strictEqual(r.added.length, 3, `应当补 3 处，实际：${r.detail}`);
  assert.strictEqual(checkVisualChecklist(r.text, {}).ok, true, `补完仍红：\n${r.text}`);
  // 判决一个字不许动
  for (const v of ['产品状态：有', '场景关系：未测', '隐私：有']) {
    assert.ok(r.text.includes(v), `判决被改了（${v}）：\n${r.text}`);
  }
  // 依据必须是读数原文，不是模型/代码自造
  assert.ok(/奶瓶（正在被使用）（朝向：倒置）/.test(r.text), '补的依据不是读数原文');
  // 幂等
  assert.strictEqual(restateChecklistEvidence(r.text, { scenes }).added.length, 0, '第二遍又补了一次');
});

check('S5n ★ 补写的三条边界：没读数不补 / 没证据不许凑 / 不许谎称「读数里没有」', () => {
  const scenes = [{
    scene: '卧室', people: [{ panel: '右上', kind: '婴幼儿', doing: '睡觉' }],
    products: [], visible_marks: [], risk_cues: [],
  }];
  const bare = '婴幼儿姿势：无\n婴儿睡眠位置：无\n产品状态：有\n场景关系：未测\n隐私：有';
  // 边界①：没有读数 ⇒ 一个字都不补
  assert.strictEqual(restateChecklistEvidence(bare, { scenes: [] }).text, bare, '没有读数却补了');
  // 边界②：判「有」但读数里没有这一类的证据 ⇒ **不补**（不许凑一句依据）
  const r = restateChecklistEvidence(bare, { scenes });
  assert.ok(!/产品状态：有（依据/.test(r.text), '读数里没有产品证据却补了依据 —— 这是编');
  assert.ok(!/隐私：有（依据/.test(r.text), '读数里没有隐私证据却补了依据 —— 这是编');
  // 边界③：读数**有原料**时，不许谎称「读数里没有这一类」
  assert.ok(/场景关系：未测（原因：画面读数只给了/.test(r.text), '未测的原因没照实写');
  assert.ok(!/场景关系：未测（原因：画面读数里没有/.test(r.text),
    '读数里明明有人物，却说「读数里没有」—— 假话');
});

check('S5i ★ 逐面板睡姿：模型不写代码搬（且三条边界一条都不许松）', () => {
  const rows = [
    { image: '图 1', panel: '右上', position: '仰卧', sleep_scene: true },
    { image: '图 1', panel: '右下', position: '仰卧', sleep_scene: true },
  ];
  const prefix = '婴幼儿姿势：无；产品状态：无；场景关系：无；隐私：无；';
  const total = `${prefix}婴儿睡眠位置：有（图 1 有婴儿睡眠场景）。`;
  // 反向对照（正）：先证明**不补就红** —— 否则「补了能过」可能只是闸门本来就绿
  assert.strictEqual(checkVisualChecklist(total, { sleepPositions: rows }).ok, false,
    '只写总括的清单本来就该被挡住（这条不成立 ⇒ 本组自证是恒真）');
  const repaired = restatePerPanelSleep(total, rows);
  assert.strictEqual(repaired.added.length, 2, '两处逐面板姿势都没搬进来');
  assert.ok(/右上＝仰卧/.test(repaired.text) && /右下＝仰卧/.test(repaired.text),
    `补写没有逐面板落在同一行：\n${repaired.text}`);
  assert.strictEqual(checkVisualChecklist(repaired.text, { sleepPositions: rows }).ok, true,
    '补写后闸门仍红 ⇒ 搬的位置不对（必须在「婴儿睡眠位置」那一行内）');
  // 边界③幂等：再跑一遍一个字不加
  assert.strictEqual(restatePerPanelSleep(repaired.text, rows).added.length, 0, '第二遍又补了一次');
  // 边界①：读数没有面板 ⇒ 不补（不许凭总括姿势编出「右上/右下」）
  const noPanel = restatePerPanelSleep(total, [{ image: '图 1', panel: '', position: '仰卧' }]);
  assert.strictEqual(noPanel.text, total, '读数没有面板却补了逐面板 ⇒ 这是编');
  assert.strictEqual(checkVisualChecklist(noPanel.text,
    { sleepPositions: [{ image: '图 1', panel: '', position: '仰卧' }] }).ok, false,
    '没有面板读数时不该被补绿');
  // 边界②：核对项本身不存在 ⇒ 不补（不许替模型造出整项）
  const noItem = '婴幼儿姿势：无；产品状态：无；场景关系：无；隐私：无。';
  assert.strictEqual(restatePerPanelSleep(noItem, rows).text, noItem, '没有那一项却补了 ⇒ 这是造');
  // 边界④：模型自己写对了 ⇒ 不补（不许重复印一遍）
  const done = `${prefix}婴儿睡眠位置：有（右上仰卧；右下仰卧）。`;
  assert.strictEqual(restatePerPanelSleep(done, rows).added.length, 0, '模型已复述却被再补一遍');
});

check('S5h ★ 睡姿面板方位同义写法可核对，方位不唯一时仍拒绝猜配', () => {
  const prefix = '婴幼儿姿势：无；婴儿睡眠位置：有（逐面板核对姿势）；'
    + '产品状态：无；场景关系：无；隐私：无；';
  const rows = [
    { image: '图 1', panel: '右上', position: '仰卧', sleep_scene: true },
    { image: '图 1', panel: '右下', position: '仰卧', sleep_scene: true },
  ];
  const topBottom = prefix + '位置明细：面板 A（顶部，错误示范）＝仰卧；面板 B（底部，正确示范）＝仰卧。';
  const accepted = checkVisualChecklist(topBottom, { sleepPositions: rows });
  assert.strictEqual(accepted.ok, true, accepted.reason);

  const ambiguousRows = [
    { image: '图 1', panel: '左上', position: '仰卧', sleep_scene: true },
    { image: '图 1', panel: '右上', position: '仰卧', sleep_scene: true },
  ];
  const ambiguous = checkVisualChecklist(prefix + '位置明细：顶部面板为仰卧。', { sleepPositions: ambiguousRows });
  assert.strictEqual(ambiguous.ok, false, '两个上方面板不能被一个「顶部」短语同时匹配');
});

check('S5i ★ 仅接受报告内明确且唯一的「面板 A/B → 右上/右下」映射', () => {
  const rows = [
    { image: '图 1', panel: '右上', position: '仰卧', sleep_scene: true },
    { image: '图 1', panel: '右下', position: '仰卧', sleep_scene: true },
  ];
  const prelude = [
    '视觉核对：婴幼儿姿势=无；婴儿睡眠位置=无（面板 A＝仰卧；面板 B＝仰卧）；产品状态=无；场景关系=有（上下场景对照）；隐私=无',
    '| 面板 A（右上） | 婴幼儿仰卧 |',
    '| 面板 B（右下） | 婴幼儿仰卧 |',
  ].join('\n');
  const accepted = checkVisualChecklist(prelude, { sleepPositions: rows });
  assert.strictEqual(accepted.ok, true,
    `显式映射已唯一对应右上/右下面板，却没有识别 A/B 逐面板复述：${accepted.reason}`);

  const unmapped = checkVisualChecklist(
    '视觉核对：婴幼儿姿势=无；婴儿睡眠位置=无（面板 A＝仰卧；面板 B＝仰卧）；产品状态=无；场景关系=有；隐私=无',
    { sleepPositions: rows });
  assert.strictEqual(unmapped.ok, false, '没有建立 A/B 到画面方位的映射时不应猜配');

  const ambiguousRows = [
    { image: '图 1', panel: '左上', position: '仰卧', sleep_scene: true },
    { image: '图 1', panel: '右上', position: '仰卧', sleep_scene: true },
  ];
  const duplicateLabel = checkVisualChecklist(
    '视觉核对：婴幼儿姿势=无；婴儿睡眠位置=无（面板 A＝仰卧；面板 B＝仰卧）；产品状态=无；场景关系=有；隐私=无\n'
      + '| 面板 A（左上） | 婴幼儿仰卧 |\n| 面板 A（右上） | 婴幼儿仰卧 |',
    { sleepPositions: ambiguousRows });
  assert.strictEqual(duplicateLabel.ok, false, '一个面板标签映射到两个场景时必须拒绝');
});

check('S5j ★ 表格中睡姿结论行后的逐面板明细必须纳入同一核对项', () => {
  const rows = [
    { image: '图 1', panel: '右上', position: '仰卧', sleep_scene: true },
    { image: '图 1', panel: '右下', position: '仰卧', sleep_scene: true },
  ];
  const report = [
    '| 类别 | 结论 | 依据 |',
    '|---|---|---|',
    '| 婴幼儿姿势 | 无 | 两处均仰卧 |',
    '| 婴儿睡眠位置 | 无 | 本图睡姿符合仰卧要求 |',
    '| 面板 A（右上） | 仰卧 | 图 1 右上婴儿仰卧 |',
    '| 面板 B（右下） | 仰卧 | 图 1 右下婴儿仰卧 |',
    '| 产品状态 | 无 | 无异常 |',
    '| 场景关系 | 有 | 上下两处场景并置 |',
    '| 隐私 | 无 | 无可识别信息 |',
  ].join('\n');
  const accepted = checkVisualChecklist(report, { sleepPositions: rows });
  assert.strictEqual(accepted.ok, true,
    `视觉清单已用表格逐面板复述两处仰卧，仍被误拒：${accepted.reason}`);

  const omitted = report.replace('| 面板 B（右下） | 仰卧 | 图 1 右下婴儿仰卧 |\n', '');
  const rejected = checkVisualChecklist(omitted, { sleepPositions: rows });
  assert.strictEqual(rejected.ok, false, '缺右下面板时必须继续拒绝');
  assert.match(rejected.reason, /右下/);
});

check('S5k ★ 编号清单的后续依据行与「面板 A（上）/B（下）」必须被识别', () => {
  const rows = [
    { image: '图 1', panel: '右上', position: '仰卧', sleep_scene: true },
    { image: '图 1', panel: '右下', position: '仰卧', sleep_scene: true },
  ];
  const answer = [
    '**面板 A —— 错误示范（上，y≈ 90–440）**',
    '**面板 B —— AAP 建议示范（下，y≈ 560–1100）**',
    '## 七、视觉核对清单',
    '**1. 婴幼儿姿势：有**',
    '- 依据：面板 A 躯干蜷曲、面部呈侧向轮廓；面板 B 双臂上举、平躺（仰卧清晰）。',
    '**2. 婴儿睡眠位置：未测**',
    '- 面板 A：看不清。原因：面部呈侧向轮廓，无法判定仰卧/侧卧；画面读数记“仰卧”与实看不一致。',
    '- 面板 B：仰卧，脸与躯干正面朝上。',
    '**3. 产品状态：有**',
    '- 依据：面板 B 婴儿床结构完整、床垫平整、床内无松散物；面板 A 床面有软枕和被褥。',
    '**4. 场景关系：有**',
    '- 依据：面板 A 成人婴儿共床；面板 B 同房不同床。',
    '**5. 隐私：无**',
    '- 依据：画面为插画，无可识别真人信息。',
  ].join('\n');
  const accepted = checkVisualChecklist(answer, { sleepPositions: rows });
  assert.strictEqual(accepted.ok, true,
    `完整依据在类别后的独立条目中，且 A/B 映射明确，仍被误拒：${accepted.reason}`);

  const noBasis = answer.replace('- 依据：面板 B 婴儿床结构完整、床垫平整、床内无松散物；面板 A 床面有软枕和被褥。', '');
  const rejected = checkVisualChecklist(noBasis, { sleepPositions: rows });
  assert.strictEqual(rejected.ok, false, '移除「有」类依据后仍必须拒绝');
  assert.match(rejected.reason, /产品状态/);
});

check('S5l ★ 实际审核表用「上图/下图」逐面板写睡姿时必须通过，且结论只读本格首项', () => {
  const rows = [{ image: '图 1', panel: '右下', position: '仰卧', sleep_scene: true }];
  const answer = [
    '| 类别 | 结论 | 依据 |',
    '|---|---|---|',
    '| 婴幼儿姿势 | 无 | 上图：仰卧（脸朝上）；下图：仰卧（脸朝上） |',
    '| 婴儿睡眠位置 | 无（侧卧/俯卧） | 上图＝仰卧；下图＝仰卧。床共享风险另见“场景关系”＝有。上图婴儿在成人床仰卧；下图婴儿在独立婴儿床仰卧。 |',
    '| 产品状态 | 有 | 上图成人床有松散被褥；下图婴儿床内无松散物。 |',
    '| 场景关系 | 有 | 上图成人与婴儿同床；下图分床。 |',
    '| 隐私 | 无 | 插画中无可识别真人信息。 |',
  ].join('\n');
  const result = checkVisualChecklist(answer, { sleepPositions: rows });
  assert.strictEqual(result.ok, true,
    `上图/下图已逐面板复述右下仰卧，但仍被误拒：${result.reason}`);
  assert.strictEqual(result.found.infant_sleep_position.verdict, '无',
    '睡眠位置结论应取该格开头的「无」，不应被依据里的「场景关系＝有」覆盖');
});

check('S5m ★ 表格里写「同上」是指代上一行那句原因（2026-10-22 生产误拒），但跨结论/无前项仍拒绝', () => {
  // 病灶：真实链回答第七节写的是
  //   | 产品状态 | **未测** | 画面层未测；OCR 里无产品名/产品物件可推 |
  //   | 场景关系 | **未测** | 同上 |
  // 旧判据把「同上」当「只有 2 个字 ⇒ 没给原因」⇒ 整份合格报告被判成流程没完成，
  // 群里收到「请重新发送原图」，对方重发了四次。
  const ok = [
    '| 类别 | 结论 | 依据 |',
    '|---|---|---|',
    '| 婴幼儿姿势 | **未测** | 画面读数没跑到（画面模型 HTTP 402），本模型不接受图像输入 |',
    '| 婴儿睡眠位置 | **未测** | 同上。无法判定画面有无睡眠场景，故不写「无」 |',
    '| 产品状态 | **未测** | 画面层未测；OCR 里无产品名/产品物件可推 |',
    '| 场景关系 | **未测** | 同上 |',
    '| 隐私 | **未测** | 同上（OCR 中的人名字样只作线索，不能当画面隐私结论） |',
  ].join('\n');
  const passed = checkVisualChecklist(ok);
  assert.strictEqual(passed.ok, true, `「同上」指的是上一行那句原因，却被判成没给原因：${passed.reason}`);
  assert.strictEqual(passed.found.scene_relation.basis, '画面层未测；OCR 里无产品名/产品物件可推',
    '继承来的理由不对（不是紧挨着上一条那句）');

  // 反向对照一：上一行自己也把原因删掉 ⇒ 不许凭空造出理由，必须重新红
  const noReason = ok.replace('| 产品状态 | **未测** | 画面层未测；OCR 里无产品名/产品物件可推 |',
    '| 产品状态 | **未测** |  |');
  const red = checkVisualChecklist(noReason);
  assert.strictEqual(red.ok, false, '上一行没原因了，「同上」还被放过 ⇒ 判据被改松');
  assert.match(red.reason, /场景关系/);

  // 反向对照二：结论不同却写「同上」⇒ 含义不明，宁可判红也不猜
  const crossVerdict = ok.replace('| 产品状态 | **未测** | 画面层未测；OCR 里无产品名/产品物件可推 |',
    '| 产品状态 | **有** | 画面里床头柜上放着倒置的奶瓶 |');
  assert.strictEqual(checkVisualChecklist(crossVerdict).ok, false,
    '跨结论的「同上」被当成继承 ⇒ 判据太松');

  // 反向对照三：五类全写「未测」、一个原因都不给 ⇒ 仍必须红（这条是本组的地基）
  assert.strictEqual(checkVisualChecklist(
    '婴幼儿姿势=未测；婴儿睡眠位置=未测；产品状态=未测；场景关系=未测；隐私=未测').ok, false,
  '五类都只写「未测」不给原因也被放过');
});

check('S6a ★ 容器朝向：闭集收下、同义归一、闭集外**不猜**（2026-10-21「奶瓶倒着放」）', () => {

  const mk = (o) => parseScene(JSON.stringify({ products: [{ what: '白色小奶瓶', orientation: o }] })).scene.products[0].orientation;
  assert.strictEqual(mk('倒置'), '倒置', '闭集内的值必须收下');
  assert.strictEqual(mk('口朝下'), '倒置', '同义写法「口朝下」要归一到倒置（否则等于白读）');
  assert.strictEqual(mk('歪歪扭扭'), '未给', '闭集外的说法必须落未给 —— 猜出来的朝向比漏掉更坏');
  assert.strictEqual(mk(''), '未给', '没给朝向 ⇒ 未给（不许默认成正放）');
});
check('S6b ★ 渲染：物品行带「朝向：…」，未给的不印（不把没读到的东西印成事实）', () => {
  const s1 = sceneBlock(parseScene(JSON.stringify({ products: [{ what: '白色小奶瓶', orientation: '倒置' }] })).scene);
  const s2 = sceneBlock(parseScene(JSON.stringify({ products: [{ what: '婴儿床' }] })).scene);
  assert.ok(/白色小奶瓶（朝向：倒置）/.test(s1), '物品行没印朝向：' + s1);
  assert.ok(!/朝向/.test(s2), '未给的朝向被印出来了：' + s2);
});
check('S6c ★ abnormalContainers：只挑「容器 ＋ 姿态异常」，非容器/正放都不算', () => {
  const sc = parseScene(JSON.stringify({ products: [
    { what: '白色小奶瓶', orientation: '口朝下' },
    { what: '保温杯', orientation: '正放' },
    { what: '木制婴儿床', orientation: '侧放' },
  ] })).scene;
  const got = abnormalContainers(sc);
  assert.strictEqual(got.length, 1, '应只挑出奶瓶，实得 ' + JSON.stringify(got));
  assert.strictEqual(got[0].orientation, '倒置', '同义归一没生效');
});
check('S6e ★ nearby container is not mistaken for the anomalous bottle actually named in the checklist', () => {
  const abnormal = [{ what: '床头柜上绿色杯旁的白色小瓶/奶瓶', orientation: '侧放' }];
  const checklist = [
    '婴幼儿姿势：无', '婴儿睡眠位置：无',
    '产品状态：有（左侧，图 1 第 8 处，白色小瓶/奶瓶侧放）',
    '场景关系：无', '隐私：无',
  ].join('\n');
  assert.equal(checkVisualChecklist(checklist, { abnormal }).ok, true,
    'checklist already names the side-laid bottle but validator picked the nearby cup');
  const nearbyOnly = checklist.replace('白色小瓶/奶瓶侧放', '绿色杯正放');
  assert.equal(checkVisualChecklist(nearbyOnly, { abnormal }).ok, false,
    'mentioning only the nearby cup must not satisfy the bottle-specific check');
});
check('S6d ★ 提示词：容器必列 ＋ orientation 闭集必须在（改提示词不许悄悄掉）', () => {
  assert.ok(/容器类物件/.test(SCENE_SYSTEM), '「容器类物件必须逐个写进 products」那条掉了 —— 读数会继续时有时无');
  assert.ok(/orientation/.test(SCENE_SYSTEM), '字段表里没有 orientation');
  assert.ok(/看不清\"，不许猜|不许猜/.test(SCENE_SYSTEM), '「看不清就写看不清，不许猜」那条掉了');
});

// Use the default transport entry point: the former disk cache was enabled only
// when fetchImpl === globalThis.fetch. Passing a separate stub would miss it.
async function withFreshSceneFixture(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scene-fresh-review-'));
  const imagePath = path.join(dir, 'source.png');
  const state = path.join(dir, 'state');
  const cacheFile = path.join(state, 'scene-read-cache.json');
  const previousState = process.env.SHOUHENG_STATE_DIR;
  const previousFetch = globalThis.fetch;
  let requests = 0;
  fs.mkdirSync(state);
  fs.copyFileSync(fileURLToPath(new URL('./__fixtures__/ocr-sample.png', import.meta.url)), imagePath);
  process.env.SHOUHENG_STATE_DIR = state;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.ok(body.messages[1].content.some((part) => part.type === 'image_url'),
      '每次请求都必须带本次图片');
    const request = ++requests;
    await Promise.resolve();
    return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop',
      message: { content: JSON.stringify({ setting: `本轮读数 ${request}` }) } }] }) };
  };
  try {
    await run({ imagePath, state, cacheFile, requests: () => requests });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousState === undefined) delete process.env.SHOUHENG_STATE_DIR;
    else process.env.SHOUHENG_STATE_DIR = previousState;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

await checkAsync('S7a ★ 同图连续送审两次 ⇒ 两次模型请求，分别返回本轮读数', async () => {
  await withFreshSceneFixture(async ({ imagePath, requests }) => {
    const first = await sceneRead(imagePath);
    const second = await sceneRead(imagePath);
    assert.strictEqual(requests(), 2, '第二次送审复用了上次画面读数');
    assert.deepStrictEqual([first.scene?.setting, second.scene?.setting], ['本轮读数 1', '本轮读数 2']);
    assert.ok(!first.cached && !second.cached, '重新推理的读数不能标成缓存命中');
  });
});

await checkAsync('S7b ★ 同图并发送审两次 ⇒ 两次模型请求，不合并也不写缓存', async () => {
  await withFreshSceneFixture(async ({ imagePath, state, requests }) => {
    const readings = await Promise.all([sceneRead(imagePath), sceneRead(imagePath)]);
    assert.strictEqual(requests(), 2, '并发两单共用了同一次画面推理');
    assert.deepStrictEqual(readings.map((r) => r.scene?.setting).sort(), ['本轮读数 1', '本轮读数 2']);
    assert.deepStrictEqual(fs.readdirSync(state), [], '画面读数不应写入任何复用缓存');
  });
});

await checkAsync('S7c ★ 旧磁盘缓存已经存在 ⇒ 不读取、不覆写，仍调用模型', async () => {
  await withFreshSceneFixture(async ({ imagePath, cacheFile, requests }) => {
    // Historical on-disk format: seed a valid hit to prove it cannot satisfy this turn.
    const model = 'fixture-scene-model';
    const key = createHash('sha256').update(fs.readFileSync(imagePath))
      .update(`\nscene-read-v2\n${model}\n${SCENE_SYSTEM}`).digest('hex');
    const legacy = JSON.stringify({ schema: 'scene-read-v2', entries: {
      [key]: { ok: true, scene: { setting: '过期画面读数' }, sent: { shrunk: false } },
    } });
    fs.writeFileSync(cacheFile, legacy);
    const readFileSync = fs.readFileSync;
    let cacheReads = 0;
    fs.readFileSync = function (file, ...args) {
      if (String(file) === cacheFile) cacheReads++;
      return readFileSync.call(this, file, ...args);
    };
    let current;
    try { current = await sceneRead(imagePath, { model }); }
    finally { fs.readFileSync = readFileSync; }
    assert.strictEqual(cacheReads, 0, '本轮读取了已经弃用的画面缓存');
    assert.strictEqual(requests(), 1, '旧缓存替代了本轮模型请求');
    assert.strictEqual(current.scene?.setting, '本轮读数 1');
    assert.strictEqual(fs.readFileSync(cacheFile, 'utf8'), legacy, '旧缓存不应被本轮覆写');
  });
});

await checkAsync('S7d ★ 启动试纸每次重跑：上次成功不能掩盖本次模型失败', async () => {
  await withFreshSceneFixture(async () => {
    const first = await preflight();
    assert.strictEqual(first.ok, true);
    let failedRequests = 0;
    globalThis.fetch = async () => {
      failedRequests++;
      return { ok: false, status: 503, text: async () => 'fixture unavailable' };
    };
    const second = await preflight();
    assert.ok(failedRequests > 0, '启动试纸没有真正请求当前模型');
    assert.strictEqual(second.ok, false, '上次成功的缓存把本次模型故障报成通过');
    assert.match(second.detail, /503/);
  });
});
const nFail = results.filter((r) => !r.ok).length;
for (const r of results) console.log(`  ${r.ok ? '✅' : '❌'} ${r.id}${r.ok ? '' : `  ← ${r.detail}`}`);
console.log(`\n${nFail ? '❌' : '✅'} scene ${results.length - nFail}/${results.length} 项通过`
  + '（全部注入桩：**一个字节都没发出去**）');
process.exit(nFail ? 1 : 0);

/**
 * model_side_limit.test.mjs —— 「字数上限说在**源头**、超了会**重写一次**」的判据。
 *
 * ## 为什么这条必须有判据（Owner 2026-10-19：「原因是不是没讲完？」）
 *
 *   病灶链：提示词**只约束了建议 ≤30**，没约束描述/原因 ≤50
 *     ⇒ 模型写 65–80 字 ⇒ 渲染层按 50 硬切 ⇒ 卡上是「…而实际想表达的应是「只…」。
 *   **没有人报错**：截断是静默的（`clipToLimit` 只回一个字符串，调用点看不出截没截）。
 *
 *   修法有两半，缺一半都白做：
 *     ① 上限写进**提示词**（`SYSTEM` 的 4c2）—— 让它在源头就不超；
 *     ② 万一还超 ⇒ **重写一次**（带「第几条哪一格超了几字」的定向纠正）。
 *
 *   这一份判据盯的就是这两半：**没有它，两步都只是散文**。
 *
 * ## 四条边界（每条都有一个"变坏就会红"的反向对照）
 *
 *   ① 超限 ⇒ 恰好重试**一次**，且纠正里点得出是第几条、哪一格、超几字；
 *   ② 没超 ⇒ **一次都不多调**（不许为了保险每次都重写，那是拿延迟换安心）；
 *   ③ 重试的输出**坏掉**（坏 JSON / 被截断）⇒ **保留第一版**，不许越修越坏；
 *   ④ 重试**共用**同一次预算（截断重试过就不再为字数重试）—— 一单最多两次调用。
 *
 * 跑法：`node agent/model_side_limit.test.mjs`
 */
import test from 'node:test';
import { ADVICE_MAX } from './prd533.mjs';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { reviewModelSide, buildPrompt, overLimitOf, SYSTEM, parseFindings,
  routeCategoryFromTaxonomy, canonicalImageAuditRequest, readingsForModelSide } from './model_side.mjs';
import { mergeFindings, renderMergedItem } from './dual_track.mjs';
import { ask as llmAsk } from './llm.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 一条**合规**的 finding（描述 12 字 / 原因 10 字 / 建议 8 字）。 */
const OK_ITEM = {
  location: '正文第 1 段', category: '合规', severity: 'REVIEW', nature: '强制',
  description: '标题写了「100%」', reason: '绝对化用语无据支撑', excerpt: '100%',
  suggestion: '删去 100%', taxonomy_category: '合规与受监管宣称', taxonomy_subcategory: null,
  source: null, source_url: null, source_name: null,
};

/** 一条**原因超限**的 finding（80 字 > 50）。 */
const OVER_ITEM = { ...OK_ITEM, reason: '消费者可能误解为全部部件都不能水洗，影响对清洁方式和使用卫生的判断，而实际想表达的应是只有五个可拆部件需要洗。' };

const jsonOf = (arr) => JSON.stringify(arr);

test('① 超字数 ⇒ 重试一次，且纠正点得出「第几条 / 哪一格 / 超几字」', async () => {
  const calls = [];
  const ask = async (prompt) => {
    calls.push(prompt);
    return calls.length === 1 ? jsonOf([OVER_ITEM]) : jsonOf([OK_ITEM]);
  };
  const r = await reviewModelSide({ readings: '素材：Only the detachable parts are washable', ask });
  assert.equal(calls.length, 2, `应恰好调用两次，实际 ${calls.length}`);
  // 纠正必须**定向**：说得出第几条、哪一格 —— 泛泛一句「太长了」它不知道改哪
  assert.match(calls[1], /超字数/, '第二次调用没带字数纠正');
  assert.match(calls[1], /第 1 条/, '纠正里没点名是第几条');
  assert.match(calls[1], /原因/, '纠正里没点名是哪个字段');
  assert.match(calls[1], /50/, '纠正里没给上限数字');
  // 最终用的是**第二版**（合规那条）
  assert.equal(r.ok, true);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].reason, OK_ITEM.reason, '重试之后仍用第一版（等于白重试）');
});

test('② 反向对照：没超字数 ⇒ **一次都不多调**（不许拿延迟换安心）', async () => {
  const calls = [];
  const ask = async (prompt) => { calls.push(prompt); return jsonOf([OK_ITEM]); };
  const r = await reviewModelSide({ readings: '素材', ask });
  assert.equal(calls.length, 1, `合规的输入不该重试，实际调用 ${calls.length} 次`);
  assert.equal(r.ok, true);
  assert.equal(r.findings.length, 1);
});

test('③ 反向对照：重试输出坏掉 ⇒ **保留第一版**（不许越修越坏）', async () => {
  const calls = [];
  const ask = async (prompt) => {
    calls.push(prompt);
    // 第一版：超字数但**内容有效**；第二版：写坏了（不是 JSON）
    return calls.length === 1 ? jsonOf([OVER_ITEM]) : '这一版我写成散文了，没有数组。';
  };
  const r = await reviewModelSide({ readings: '素材', ask });
  assert.equal(calls.length, 2);
  assert.equal(r.ok, true, '重试写坏之后，第一版也被丢了');
  assert.equal(r.findings.length, 1, '第一版条目丢了 —— 那是「修字数把结果修没了」');
  assert.equal(r.findings[0].reason, OVER_ITEM.reason, '保留的不是第一版');
});

test('④ 反向对照：截断重试已经用掉预算 ⇒ 不再为字数重试（一单最多两次调用）', async () => {
  const calls = [];
  const ask = async (prompt) => {
    calls.push(prompt);
    // 第一次：被截断（有 `[` 无 `]`）⇒ 触发截断重试；第二次：合法但超字数
    return calls.length === 1 ? `[${JSON.stringify(OVER_ITEM)}` : jsonOf([OVER_ITEM]);
  };
  const r = await reviewModelSide({ readings: '素材', ask });
  assert.equal(calls.length, 2, `一单最多两次调用（截断一次 + 字数一次就超了），实际 ${calls.length}`);
  assert.equal(r.ok, true);
});

test('⑤ 上限确实写进了**系统提示词**（源头，不是只写在渲染层）', () => {
  const sys = Array.isArray(SYSTEM) ? SYSTEM.join('\n') : String(SYSTEM);
  assert.match(sys, /4c2/, '提示词里没有 4c2 那一条');
  assert.match(sys, /≤50 字/, '提示词没写描述/原因 ≤50 字 —— 那源头就还在写 80 字');
  assert.ok(new RegExp(`≤${ADVICE_MAX} 字`).test(sys),
    `建议 ≤${ADVICE_MAX} 字上限必须出现在系统提示词里`);
  // ⚠️ 反向对照：不许出现「写不下就用省略号」这种把截断合法化的说法
  assert.ok(!/写不下.{0,6}省略号/.test(sys), '提示词里出现了「写不下就用省略号」——那等于允许截断');
});

test('⑥ overLimitOf 认得出超限，且**不误伤**合规条目', () => {
  const rows = overLimitOf([OK_ITEM, OVER_ITEM]);
  assert.equal(rows.length, 1, `应只报第 2 条，实际 ${JSON.stringify(rows)}`);
  assert.equal(rows[0].index, 2);
  assert.ok(rows[0].bad.some((b) => /原因/.test(b.label)), '报的不是「原因」那一格');
  // 反向对照：全合规 ⇒ 0 条（否则每次都会重试）
  assert.equal(overLimitOf([OK_ITEM]).length, 0);
});

test('⑦ buildPrompt 把纠正**追加在输入末尾**（系统提示词保持稳定前缀）', () => {
  const a = buildPrompt({ readings: 'R', question: 'Q' });
  const b = buildPrompt({ readings: 'R', question: 'Q', fixNote: '【上一版超字数了】' });
  assert.ok(!a.includes('超字数'), '不带 fixNote 时不该出现纠正');
  assert.ok(b.includes('超字数'), 'fixNote 没进提示词');
  assert.ok(b.startsWith(a), '纠正不是追加在末尾（会破坏系统前缀的缓存友好性）');
});

test('⑦b 图片泛化提问跨私聊/群聊归一，具体关注点仍保留', () => {
  assert.equal(canonicalImageAuditRequest(''), '');
  assert.equal(canonicalImageAuditRequest('[图片]\n审查下这张图片'), '');
  assert.equal(canonicalImageAuditRequest('审查一下这张图'), '');
  assert.equal(canonicalImageAuditRequest('这张能发吗'), '这张能发吗');
  assert.equal(canonicalImageAuditRequest('这张图里的婴儿睡姿安全吗？'), '这张图里的婴儿睡姿安全吗？');
});

test('⑧ 这条判据自身不是恒真：把 overLimitOf 的字段映射改错就必须红', () => {
  // 用 **advice** 字段超限、description/reason 合规的条目：证明映射真的接了 suggestion
  const bad = { ...OK_ITEM, suggestion: '改'.repeat(ADVICE_MAX + 1) };
  const rows = overLimitOf([bad]);
  assert.equal(rows.length, 1, '建议超限没被认出来（字段映射漏了 suggestion）');
  assert.ok(rows[0].bad.some((b) => /修改建议/.test(b.label)), '报的不是「修改建议」那一格');
  // 源文件里这一跳必须真的读 `suggestion`（有人改成别的字段名 ⇒ 这里红）
  const src = fs.readFileSync(path.join(HERE, 'model_side.mjs'), 'utf8');
  assert.match(src, /advice:\s*f\?\.suggestion/, 'overLimitOf 不再把 suggestion 映射到「修改建议」');
});

test('⑨ 超时预算 ⇒ **一次都不多调**（Owner：修复不能影响工作流）', async () => {
  // ★ 2026-10-19（Owner 的硬约束：「你的所有修复，不能影响工作流」）——
  //   重试是**又一轮 7–10 s 的 LLM 调用**，而模型侧与送审链并行、它晚到就拖后落表与发卡。
  //   预算用尽（这里注入 -1，等价于「第一轮已经太久」）⇒ 宁可让卡面压一句，
  //   也不拿业务在等的时间去换文案完整度。
  const calls = [];
  const ask = async (prompt) => { calls.push(prompt); return jsonOf([OVER_ITEM]); };
  const r = await reviewModelSide({ readings: '素材', ask, retryBudgetMs: -1 });
  assert.equal(calls.length, 1, `超预算时不许重试，实际调用了 ${calls.length} 次`);
  assert.equal(r.ok, true, '跳过重试不许把结果弄丢');
  assert.equal(r.findings.length, 1);
  // 反向对照：同一份输入、预算充足 ⇒ 必须**会**重试（证明跳过是预算造成的，不是逻辑坏了）
  const calls2 = [];
  const ask2 = async (prompt) => {
    calls2.push(prompt);
    return calls2.length === 1 ? jsonOf([OVER_ITEM]) : jsonOf([OK_ITEM]);
  };
  await reviewModelSide({ readings: '素材', ask: ask2, retryBudgetMs: 60000 });
  assert.equal(calls2.length, 2, '预算充足时反而没重试 —— 判据被改坏了');
});

test('⑩ 图片模型侧收到原图输入；纯视觉语义条目可无外部依据，但必须有图像锚点', async () => {
  const seen = [];
  const item = { ...OK_ITEM, excerpt: null, description: '成人床与婴儿睡眠场景并列', source: null, source_url: null,
    evidence_basis: 'image_observation', visual_anchor: '图 1：画面把成人床与婴儿睡眠场景并列' };
  const r = await reviewModelSide({ readings: 'OCR: safe sleep', imagePaths: ['/tmp/original.jpg'],
    requiredImageCount: 1, ask: async (prompt, options) => {
      seen.push({ prompt, options }); return jsonOf([item]);
    } });
  assert.equal(r.ok, true);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].basis_missing, false);
  assert.equal(r.findings[0].basis_kind, 'visual_observation');
  const merged = mergeFindings([], r.findings).items[0];
  const card = renderMergedItem(merged, 0, { must: false });
  // ★ 2026-10-22（Owner：「依据文档链接…更像问题描述」）：没有外部标准时，依据格
  //   **如实说「无外部依据」**，并照样印出图像锚点（锚点是位置读数，不是法规）。
  //   三个方向一起钉：不隐藏锚点、不把锚点伪装成法规引用、不凭空冒链接。
  const basisLine = card.split('\n').find((l) => l.includes('依据')) ?? '';
  assert.match(basisLine, /无外部依据/, '没有外部标准时必须如实说「无外部依据」');
  assert.match(basisLine, /图 1：画面把成人床与婴儿睡眠场景并列/, '依据格要带上图像锚点（不许隐藏）');
  assert.doesNotMatch(basisLine, /https?:\/\//, '没有外部链接时不许凭空冒出一个链接');
  assert.deepEqual(seen[0].options.imagePaths, ['/tmp/original.jpg']);
  assert.deepEqual(seen[0].options.thinking, { type: 'disabled' });
  assert.match(seen[0].prompt, /原图已作为本次模型输入/);
  assert.equal(parseFindings(jsonOf([item])).findings[0].basis_missing, true,
    '非图片单不能用 image_observation 绕过外部依据要求');
  assert.equal(parseFindings(jsonOf([{ ...item, visual_anchor: '' }]),
    { allowVisualNoBasis: true }).findings[0].basis_missing, true,
    '缺少可定位的图像锚点时不能免依据');
});

test('⑪ 图片原图不齐时模型侧明确失败，不得把 OCR 代替原图', async () => {
  let called = false;
  const r = await reviewModelSide({ readings: 'OCR text', imagePaths: [], requiredImageCount: 1,
    ask: async () => { called = true; return '[]'; } });
  assert.equal(r.ok, false);
  assert.match(r.error, /原图未完整交给模型侧/);
  assert.equal(called, false);
});

test('⑪b 截图层水印不构成素材问题，不得单独触发 REVIEW', () => {
  assert.match(SYSTEM, /截图层水印不计为素材问题/);
  assert.match(SYSTEM, /不得单独据此判 REVIEW/);
  assert.match(SYSTEM, /局部识读受限/);
  assert.match(SYSTEM, /只有原图能确认水印属于最终交付创意内容时/);
  const readings = readingsForModelSide({ images: [{ index: 1, text: 'Headline',
    wmDropped: ['watermark'], wmBasis: 'core-tiled-at-different-positions' }] });
  assert.match(readings, /截图层水印判读/);
  assert.match(readings, /不作为素材问题/);
  assert.match(readings, /局部识读受限/);
});

test('⑪c 只在 OCR 已判定截图层时过滤水印发现，真实成品水印仍保留审查', async () => {
  const watermark = { ...OK_ITEM, category: '隐私', description: '重复水印暴露个人标识',
    reason: '半透明水印显示个人账号', excerpt: null, suggestion: '删除水印图层' };
  const other = { ...OK_ITEM, description: '标题中数字未说明单位', reason: '读者无法判断数量口径',
    suggestion: '补充单位' };
  const run = async (readings) => reviewModelSide({ readings, imagePaths: ['/tmp/original.jpg'],
    requiredImageCount: 1, ask: async () => jsonOf([watermark, other]) });
  const overlay = await run('【图 1 的截图层水印判读】OCR 判据识别到重复覆盖式水印');
  assert.deepEqual(overlay.findings.map((f) => f.description), [other.description],
    '截图层水印仍进入模型问题集，可能单独抬高 REVIEW');
  const deliverable = await run('【图 1 上的字】品牌标识与标题');
  assert.deepEqual(deliverable.findings.map((f) => f.description), [watermark.description, other.description],
    '没有截图层判据时不得把可能属于成品的水印静默过滤');
});

test('⑫ llm.ask 将临时原图作为 image_url 多模态内容送进 chat/completions', async () => {
  const imagePath = path.join(os.tmpdir(), `shouheng-model-side-${process.pid}.png`);
  const imageBytes = Buffer.from('original-image-bytes-for-wire-check');
  const originalFetch = globalThis.fetch;
  let payload;
  fs.writeFileSync(imagePath, imageBytes);
  globalThis.fetch = async (_url, init) => {
    payload = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: '[]' }, finish_reason: 'stop' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const out = await llmAsk('请看图', { imagePaths: [imagePath], thinking: { type: 'disabled' } });
    assert.equal(out, '[]');
    const userContent = payload.messages.find((m) => m.role === 'user').content;
    assert.equal(userContent[0].text, '请看图');
    assert.equal(userContent[1].type, 'image_url');
    assert.equal(userContent[1].image_url.url,
      `data:image/png;base64,${imageBytes.toString('base64')}`,
      '必须把原图字节放进多模态请求，不能只发 OCR/视觉描述');
    assert.deepEqual(payload.thinking, { type: 'disabled' });
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(imagePath, { force: true });
  }
});

test('⑬ A3 所属类别误落方向类目字段时保留整条，不丢知识库类发现', () => {
  const rows = [
    { ...OK_ITEM, category: '权利、肖像、隐私与AI', taxonomy_category: '权利、肖像、隐私与AI',
      taxonomy_subcategory: 'AI 生成内容标识', reason: '画面中的婴儿身份可能无法确认', suggestion: '补充授权与披露说明' },
    { ...OK_ITEM, category: '产品安全与高危使用场景', taxonomy_category: '产品安全与高危使用场景',
      taxonomy_subcategory: '危险行为示范与模仿风险', reason: '画面示范可能引发模仿', suggestion: '调整画面呈现' },
    { ...OK_ITEM, category: '母婴知识内容准确性', taxonomy_category: '母婴知识内容准确性',
      taxonomy_subcategory: '婴幼儿睡眠', reason: '画面传递的睡眠信息需要复核', suggestion: '补充准确说明' },
    { ...OK_ITEM, category: '凭空自造的类目', taxonomy_category: '未归类', reason: '不能推断方向' },
  ];
  const parsed = parseFindings(jsonOf(rows));
  assert.equal(parsed.findings.length, 3, '合法 A3 类目误填到方向格时应保留，不得整条丢弃');
  assert.equal(parsed.dropped.length, 1, '真正不在方向闭集且无 A3 兜底的自由类目仍须拒收');
  assert.deepEqual(parsed.findings.map((x) => x.category), ['AI 披露', '消费者安全', '合规']);
  assert.deepEqual(parsed.findings.map((x) => x.taxonomyCategory), [
    '权利、肖像、隐私与AI', '产品安全与高危使用场景', '母婴知识内容准确性',
  ]);
  assert.deepEqual(parsed.findings.map((x) => x.taxonomySubcategory), [
    'AI 生成内容标识', '危险行为示范与模仿风险', '婴幼儿睡眠',
  ]);
  assert.equal(parsed.findings[0].category_asked, '权利、肖像、隐私与AI');
  assert.equal(routeCategoryFromTaxonomy('权利、肖像、隐私与AI', '未成年人出镜与隐私保护'), '隐私');
  assert.equal(routeCategoryFromTaxonomy('不是已知类目'), null);
});

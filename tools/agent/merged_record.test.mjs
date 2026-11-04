/**
 * merged_record.test.mjs —— 「卡面摘掉状态标签之后，还答得出是哪一侧的问题吗？」的判据。
 *
 * ## 它防的是什么（Owner 2026-10-19 裁定「1→2→3 全做」的第 1 步）
 *
 * Owner 同时提了两个要求：
 *   ① 「去掉『—— 无库内依据 · 建议转人工』的字眼」；
 *   ② 「但是我问你的时候，**你要能说出是模型侧还是知识库侧问题**」。
 *
 *   这两条**只有在信息另存一份时才能同时成立**。而实测：`merged-reports/` 下 362 个
 *   文件全是 `.md`，`source` / `basis_missing` 这些字段**跑完就没了** ——
 *   那一刻「先摘标签」就是**用版式换掉了可回答性**。
 *
 * ## 所以判据分三层（少一层都留得住漏洞）
 *
 *   ① 记录**本身**对不对：分侧、回源能力、截断真相；
 *   ② 记录**真的落盘**吗：文件在、JSON 能解、字段还在（不是只构造了个对象）；
 *   ③ **反向对照**：渲染层不交 `itemsMeta` ⇒ 记录就丢掉来源侧线索；
 *      而卡面**确实**已经不印那句标签了 —— 两边一起看，才知道「摘的是版式、不是信息」。
 *
 * 跑法：`node agent/merged_record.test.mjs`（`node:test`，与 `model_side_taxonomy.test.mjs` 同一种）
 */
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildMergedRecord, RECORD_SCHEMA } from './merged_record.mjs';
import { writeMergedRecord } from './merged_report.mjs';
import { renderMerged, renderMergedItem, clipToLimit } from './dual_track.mjs';
import { countAdviceChars, ADVICE_MAX } from './prd533.mjs';

/** 一条模型侧条目（无外部标准 ⇒ `basis_kind: 'none'`，也**没有**条款号 ⇒ 回不了源）。 */
const MODEL_ITEM = Object.freeze({
  location: '[00:55] 关键帧字幕',
  category: '合规',
  taxonomyCategory: '商品信息与Listing准确性',
  taxonomySubcategory: '功能与部件描述准确性',
  severity: 'REVIEW',
  source: 'model',
  description: '字幕「Only the detachable parts are washable」表意含糊',
  reason: '消费者可能误解为全部部件都不能水洗，影响对清洁方式和使用卫生的判断。',
  advice: '改为「just 5 parts to wash」',
  excerpt: 'Only the detachable parts are washable',
  model: { source: null, source_url: null, basis_missing: false },
});

/** 一条库侧条目（**有**条款号 + 有直链 ⇒ 回得了源）。 */
const KB_ITEM = Object.freeze({
  location: '正文第 7 段',
  category: '合规',
  severity: 'BLOCK',
  source: 'kb',
  reason: '绝对化用语，无证据支撑。',
  advice: '删去「100%」',
  kb: { article_no: 'E-2.124', anchor: '#负面样本/rec1',
        entry_url: 'https://momcozy-in.feishu.cn/base/A?table=B&record=C',
        basisLine: '《知识库》第 E-2.124 条 ← 命中「100%」｜原始出处：https://momcozy-in.feishu.cn/base/A?table=B&record=C' },
});

test('① 记录按条目分侧：模型侧与库侧各自标出来（这就是「问我时答得出」的载荷）', () => {
  const rec = buildMergedRecord({
    items: [MODEL_ITEM, KB_ITEM],
    itemsMeta: [],
    state: 'REVIEW', line: '【审查结论：REVIEW】共发现 2 处需人工确认。', total: 2,
  });
  assert.equal(rec.schema, RECORD_SCHEMA);
  assert.equal(rec.items[0].source, 'model');
  assert.equal(rec.items[0].side, 'model');
  assert.equal(rec.items[1].source, 'kb');
  assert.equal(rec.items[1].side, 'knowledge-base');
  // 整单层面也给一份，方便一眼看出「这一单全是模型侧报的」
  assert.deepEqual(rec.sides, { model: 1, 'knowledge-base': 1 });
  // 回得了源 / 回不了源：库侧带坐标，模型侧没有
  assert.equal(rec.items[1].kb.article_no, 'E-2.124');
  assert.equal(rec.items[0].kb, null);
  assert.equal(rec.items[0].basis_kind, 'none');
});

test('② 截断真相来自渲染层（itemsMeta），记录层**不重算**', () => {
  const meta = [{ index: 0, source: 'model', origin: '', basis_kind: 'none',
                  reason_truncated: true, reason_full_chars: 88, reason_shown_chars: 48,
                  advice_truncated: false, advice_full_chars: 20, advice_shown_chars: 20 }];
  const rec = buildMergedRecord({
    items: [MODEL_ITEM], itemsMeta: meta, state: 'REVIEW', line: 'L', total: 1,
  });
  assert.equal(rec.items[0].truncated.reason, true);
  assert.equal(rec.items[0].truncated.reason_full_chars, 88);
  assert.equal(rec.items[0].truncated.advice, false);
  // ★ 记录里存的是**全文**（卡面压缩只影响版式）：reason 一个字都不许被压掉
  assert.match(rec.items[0].reason, /影响对清洁方式和使用卫生的判断/);
});

test('③ 记录**真的落盘**：文件在、JSON 能解、字段还在（不是只构造了个对象）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shrec-'));
  const prev = process.env.SHOUHENG_MERGED_REPORT_DIR;
  process.env.SHOUHENG_MERGED_REPORT_DIR = dir;
  try {
    const rec = buildMergedRecord({
      items: [MODEL_ITEM], itemsMeta: [], state: 'REVIEW',
      line: 'L', total: 1, contentId: 'C-1', at: '2026-10-19T08:36:06.301Z',
    });
    const p = writeMergedRecord(rec, { contentId: 'C-1', at: '2026-10-19T08:36:06.301Z' });
    assert.ok(p, '落盘返回了 null —— 那就是「没留痕」');
    assert.ok(/merged-.*\.json$/.test(p), `文件名不对：${p}`);
    const back = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(back.schema, RECORD_SCHEMA);
    assert.equal(back.items[0].source, 'model', '回读之后来源侧丢了 —— 落盘等于没落');
    assert.equal(back.items[0].side, 'model');
    assert.equal(back.content_id, 'C-1');
  } finally {
    if (prev === undefined) delete process.env.SHOUHENG_MERGED_REPORT_DIR;
    else process.env.SHOUHENG_MERGED_REPORT_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('④ 端到端：卡面**不印**状态标签，而记录里**有**来源侧（摘的是版式，不是信息）', () => {
  const rd = renderMerged([MODEL_ITEM], { state: 'REVIEW', kb: { state: 'REVIEW', issueCount: 0 },
                                          kbTextCount: 0 });
  assert.ok(rd && typeof rd.block === 'string');
  // 1) 卡面：被 Owner 摘掉的那句**不许再出现**
  assert.ok(!/无库内依据/.test(rd.block), '卡面还在印「无库内依据」');
  assert.ok(!/建议转人工/.test(rd.block), '卡面还在印「建议转人工」');
  // 2) 但渲染这一趟**交出了**逐条元数据（漏了它，下面第 3 步就无从谈起）
  assert.ok(Array.isArray(rd.itemsMeta), 'renderMerged 没交出 itemsMeta');
  assert.equal(rd.itemsMeta.length, 1, 'itemsMeta 条数与条目数不一致');
  assert.equal(rd.itemsMeta[0].source, 'model');
  // 3) 记录据此拿到了「这一条是模型侧报的」
  const rec = buildMergedRecord({ items: [MODEL_ITEM], itemsMeta: rd.itemsMeta,
                                  state: 'REVIEW', line: rd.line, total: rd.total });
  assert.equal(rec.items[0].source, 'model');
});

test('⑤ 反向对照：渲染层**不交** itemsMeta ⇒ 记录丢掉来源侧线索（证明④不是恒真）', () => {
  const rec = buildMergedRecord({
    items: [MODEL_ITEM], itemsMeta: [], state: 'REVIEW', line: 'L', total: 1,
  });
  // `source` 仍从条目本身来（它是条目的字段），但**渲染层算出来的那几样**没有了：
  assert.equal(rec.items[0].items_meta_present ?? rec.items[0].basis_card, null);
  // 截断真相**只能**来自 meta ⇒ 没有 meta 就只能是「不知道被截过」——
  //   这正是「必须先落盘再摘标签」的理由：不落盘时，这条信息无从判断，也就无从回答。
  assert.equal(rec.items[0].truncated.reason, false);
  assert.equal(rec.items[0].truncated.reason_full_chars, null);
});

test('⑥ 反向对照：卡面一旦把那句标签加回来，④ 必须红', () => {
  // 直接渲染一个**人为塞了标签**的条目（模拟有人改回去），确认判据咬得住
  const painted = renderMergedItem({ ...MODEL_ITEM, source: 'model' }, 0, { must: false });
  const forged = `${painted}   —— **无库内依据 · 建议转人工**\n`;
  assert.ok(/无库内依据/.test(forged), '构造失败：夹具里没有标签，这条反向对照就没意义');
  // ↑ 夹具造得对，说明④里那两条 `!/无库内依据/` 不是恒真断言
});

test('⑦ 字数压缩：超限才截，且**不留半截引号**（Owner 那句「应是「只…」的成因）', () => {
  const s = '表意含糊：消费者可能误解为部分部件不能水洗，影响对清洁方式和使用卫生的判断，'
    + '而实际想表达的应是「只有 5 个部件需要洗」';
  const r = clipToLimit(s, 50, { hasReport: false });
  assert.equal(r.truncated, true);
  assert.ok(!/「[^」]*…$/.test(r.text), `截在引号中间了：${r.text}`);
  // 未超限 ⇒ 一个字都不动（不许"为了好看"顺手压）
  const same = clipToLimit('很短的一句', 50, { hasReport: false });
  assert.equal(same.truncated, false);
  assert.equal(same.text, '很短的一句');
});

test('⑧ 过滤候选后按源下标关联元数据，知识库依据不会错挂到相邻问题', () => {
  const omitted = { ...MODEL_ITEM, description: '内容缺少可核锚点', excerpt: '', basis_missing: true,
    model: { ...MODEL_ITEM.model, basis_missing: true } };
  const rd = renderMerged([omitted, KB_ITEM], { state: 'REVIEW' });
  assert.equal(rd.itemsMeta.length, 1, '无依据模型项应过滤，库侧项应保留');
  assert.equal(rd.itemsMeta[0].source_index, 1, '保留项必须带原始来源下标');
  assert.equal(rd.itemsMeta[0].source, 'kb');
  const rec = buildMergedRecord({ items: [omitted, KB_ITEM], itemsMeta: rd.itemsMeta,
    state: 'REVIEW', line: rd.line, total: rd.total });
  assert.equal(rec.items[0].displayed, false);
  assert.equal(rec.items[1].displayed, true);
  assert.equal(rec.items[1].source, 'kb');
  assert.ok(rec.items[1].basis_card?.includes('momcozy-in.feishu.cn'), 'KB 的原始出处元数据必须仍挂在 KB 项');
  assert.notEqual(rec.items[0].basis_kind, 'registry', 'KB 依据元数据不能错挂到被过滤的模型项');
});

test('⑨ 素材原文**不再是**「依据」：没有外部标准时依据格写「无外部依据」，但真实问题不被滤掉', () => {
  // ★★ 2026-10-22（Owner：「依据文档链接，是需要提供证明这是个问题的外部链接…
  //   『送审素材原文：「Ask Midwife Vic」』更像是问题描述」）——
  //   素材原文印在「问题描述 / 命中描述」两处；依据格**只**放外部文档链接，
  //   没有就如实说没有（且条目**照旧保留**，不因为没链接就把真实问题滤掉）。
  const typo = { ...MODEL_ITEM, location: '图片顶部，图 1 第 2 处', basis_missing: true,
    description: '图内英文「thefirst 6months」缺少空格，影响阅读。',
    excerpt: 'thefirst 6months', model: { ...MODEL_ITEM.model, basis_missing: true } };
  const rd = renderMerged([typo], { state: 'REVIEW' });
  assert.equal(rd.total, 1, '真实问题不许被滤掉');
  assert.equal(rd.displayItems.length, 1);
  const basisLine = rd.block.split('\n').find((l) => l.includes('依据')) ?? '';
  assert.doesNotMatch(basisLine, /送审素材原文[：:]/, '依据格不许拿送审素材原文冒充依据');
  assert.match(basisLine, /无外部依据/, '没有外部文档时必须如实说「无外部依据」');
  assert.equal(rd.itemsMeta[0].basis_kind, 'material', '记录层仍要答得出「依据来自素材原文」');
  assert.equal(rd.itemsMeta[0].basis_missing, false);
});

test('⑩ KB 具体改法先去免责声明，再进入 60 字建议格与报告', () => {
  const advice = '源记录未提供具体修改建议；此条仅为相似历史参考；建议：删去第 8 处「AAP Recommendation」机构署名。';
  // ⚠️ 这一条测的是**库侧原文**那条路 —— 夹具里不能带 `advice`（本单生成的改法）：
  //   2026-10-22 定的是「`adv` 优先」，带了 `advice` 就走到另一支，
  //   而这一条红的原因（库侧免责声明没被去掉）根本没被测到。
  const kbItem = { ...KB_ITEM, advice: undefined, location: '图片中部，图 1 第 8 处',
    kb: { ...KB_ITEM.kb, suggestionLine: advice } };
  const card = renderMerged([kbItem], { state: 'REVIEW' });
  const cardLine = card.block.split('\n').find((line) => line.includes('**建议**')) ?? '';
  assert.match(cardLine, /删去第 8 处「AAP Recommendation」机构署名/);
  assert.doesNotMatch(cardLine, /源记录未提供|相似历史参考/);
  assert.ok(countAdviceChars(cardLine) <= ADVICE_MAX, `卡面建议超过 ${ADVICE_MAX} 字：${cardLine}`);
  const reportItem = renderMergedItem(kbItem, 0, { layout: 'report' });
  const reportLine = reportItem.split('\n').find((line) => line.includes('**修改建议**')) ?? '';
  assert.match(reportLine, /删去第 8 处「AAP Recommendation」机构署名/);
  assert.doesNotMatch(reportLine, /源记录未提供|相似历史参考/);
  assert.ok(countAdviceChars(reportLine) <= ADVICE_MAX, `报告建议超过 ${ADVICE_MAX} 字：${reportLine}`);
});

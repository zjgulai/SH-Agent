import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { checkImageWorkflowEvidence, imageWorkflowEvidenceInstructions } from './image_workflow_evidence.mjs';

const source = { id: 'aap-safe-sleep-2022', kind: 'local_snapshot', verified: true,
  authority: 'AAP', source_hash_verified: true,
  source_sha256: '9b8ee681ec6360e4c2f7356ac77a328c7635d012daa6d254016c263256dcd6bd', anchor: '#fixture',
  content: 'Infants should be placed for sleep in a supine position for every sleep by every caregiver until the child reaches 1 year of age.' };
const quote = source.content;
const table = (rows) => ['| 主张 | 核查结论 | 依据及边界 | 来源 | 来源原文 |',
  '| --- | --- | --- | --- | --- |', ...rows].join('\n');
const report = (facts, claims = 'C1：图中产品为白色摄像头。') => `### 审核对象与范围
图1整图，审核画面与图中文字，不涉及授权。
### 视觉分析与 OCR
白色摄像头正放；OCR为momcozy，画面无人。
### 主张拆分与核查清单
${claims}
### 4A 规则符合性
L4至L7已核，命中0条，库内覆盖不足。
### 4B 事实准确性核查
${facts}
### 图文一致性
图中文字momcozy与机身标识一致。
### 视觉核对
婴幼儿姿势：无
婴儿睡眠位置：无
产品状态：无
场景关系：无
隐私：无`;
const visualRow = '| C1：产品为白色摄像头 | 画面可确认 | 图1可见白色机身及镜头，性能不由外观推断 | — | — |';

test('六个空标题加视觉无列表不能冒充完整流程', () => {
  const text = '审核对象与范围\n视觉分析与 OCR\n主张拆分与核查清单\n4A 规则符合性\n4B 事实准确性核查\n图文一致性\n视觉核对\n婴幼儿姿势：无\n婴儿睡眠位置：无\n产品状态：无\n场景关系：无\n隐私：无';
  const r = checkImageWorkflowEvidence(text);
  assert.equal(r.ok, false);
  // 2026-11-03：缺项现在带原因（「章名：原因」），断言按前缀匹配
  assert.ok(r.missing.some((s) => s.startsWith('审核对象与范围')), r.missing.join('；'));
  assert.ok(r.missing.some((s) => s.startsWith('图文一致性')), r.missing.join('；'));
  // 且每条都必须可行动：只回一个章名 = 模型无从修（不许出现裸章节名）
  const bare = ['审核对象与范围', '视觉分析与 OCR', '主张拆分与核查清单', '4A 规则符合性', '4B 事实准确性核查', '图文一致性'];
  for (const item of r.missing) assert.ok(!bare.includes(item), `缺项只有章名、不可行动：${item}`);
});

test('六节有正文且4B画面可确认可完成，事实真假仍由模型判', () => {
  const r = checkImageWorkflowEvidence(report(table([visualRow])));
  assert.equal(r.ok, true, r.missing.join('；'));
  assert.equal(r.factReview.deliveryComplete, true);
  assert.equal(r.factReview.semanticJudgment, 'model');
  assert.equal(r.factReview.factTruthVerified, false);
  assert.equal(r.hasAuthoritativeSource, false);
});

for (const file of ['image-review-group-1641-20261102.txt', 'image-review-20261102.txt',
  'image-review-20261030.txt', 'image-review-camera-20261030.txt', 'image-review-p2p-1202-20261102.txt']) {
  test(`真实完整报告兼容：${file}`, () => {
    const text = fs.readFileSync(new URL(`./__fixtures__/${file}`, import.meta.url), 'utf8');
    const r = checkImageWorkflowEvidence(text);
    assert.equal(r.ok, true, r.missing.join('；'));
    assert.equal(r.factReview.format, 'legacy');
    assert.equal(r.factReview.verifiedCitationCount, 0);
    assert.equal(r.hasAuthoritativeSource, false);
  });
}

test('粗体同行标题及中文编号也按各节正文验收', () => {
  const text = report(table([visualRow])).replace(/### ([^\n]+)\n/g, '**$1**：');
  assert.equal(checkImageWorkflowEvidence(text).ok, true);
});

test('OCR已完成、裸主张编号及缺单元格不能冒充阶段正文', () => {
  const original = report(table([visualRow]));
  assert.equal(checkImageWorkflowEvidence(original.replace('白色摄像头正放；OCR为momcozy，画面无人。', 'OCR 已完成')).ok, false);
  assert.equal(checkImageWorkflowEvidence(report(table([visualRow]), 'C1：')).ok, false);
  assert.equal(checkImageWorkflowEvidence(report(table([visualRow.replace(' | — | — |', ' | — |')]))).ok, false);
});

test('六节只验非占位交付，不用业务关键词误拦合法措辞', () => {
  const text = report(table([visualRow]))
    .replace('图1整图，审核画面与图中文字，不涉及授权。', '本轮处理上方面板及其附注，权利归属另审。')
    .replace('白色摄像头正放；OCR为momcozy，画面无人。', '已完成视觉与OCR；镜头前只有成人。')
    .replace('L4至L7已核，命中0条，库内覆盖不足。', '执行库侧规则比对，返回零项，仍保留样本范围限制。')
    .replace('图中文字momcozy与机身标识一致。', '上方面板睡姿事实与“仅避免同床”的风险说明未完全对应。');
  const r = checkImageWorkflowEvidence(text);
  assert.equal(r.ok, true, r.missing.join('；'));
});

test('重复占位句仍不算正文，其他短而具体的正文不靠长度拦截', () => {
  const original = report(table([visualRow]));
  assert.equal(checkImageWorkflowEvidence(original.replace('白色摄像头正放；OCR为momcozy，画面无人。', '无\n无')).ok, false);
  assert.equal(checkImageWorkflowEvidence(original.replace('白色摄像头正放；OCR为momcozy，画面无人。', '红灯亮')).ok, true);
});

test('legacy核查结果不依赖预设品牌、专业词或产品词', () => {
  const facts = 'Ferro-7 的开口宽度与标尺相符；“可容纳四枚硬币”无法确认，因为现有样本只摆放了两枚。';
  const r = checkImageWorkflowEvidence(report(facts, '①开口宽度②容纳四枚硬币。'));
  assert.equal(r.ok, true, r.missing.join('；'));
  assert.equal(r.factReview.format, 'legacy');
  assert.equal(r.factReview.factTruthVerified, false);
  assert.equal(checkImageWorkflowEvidence(report('Ferro-7 已登记（本轮未联网）', '开口宽度。')).ok, false);
});

test('完整标题与陶瓷杯核查兼容，登记状态和检查通过不能冒充结果或边界', () => {
  const ceramic = report('C1：陶瓷杯容量为350毫升，无法确认，缺少该批次实测记录。', 'C1：陶瓷杯容量为350毫升。')
    .replace('### 图文一致性\n', '### 图文一致性与信息完整性\n');
  assert.equal(checkImageWorkflowEvidence(ceramic).ok, true);
  assert.equal(checkImageWorkflowEvidence(report('C1：品牌未登记。')).ok, false);
  const emptyBoundary = visualRow.replace('图1可见白色机身及镜头，性能不由外观推断', '检查通过');
  assert.equal(checkImageWorkflowEvidence(report(table([emptyBoundary]))).ok, false);
});

test('新表格必须与第三节明确C编号对账，无编号多主张不能只核一项', () => {
  const r = checkImageWorkflowEvidence(report(table([visualRow]), '产品颜色为白色；夜视距离为30米。'));
  assert.equal(r.ok, false);
  assert.ok(r.factReview.missing.some((s) => /编号/.test(s)));
});

test('提示明确引用须完整句并满足校验器的英文与中文界限', () => {
  const instructions = imageWorkflowEvidenceInstructions();
  assert.match(instructions, /完整句/);
  assert.match(instructions, /英文.{0,15}40/);
  assert.match(instructions, /中文.{0,15}12/);
  assert.match(instructions, /句末标点/);
});

test('首轮与续写共用精确来源格和无引用不得写支持的交付约束', () => {
  const instructions = imageWorkflowEvidenceInstructions();
  assert.match(instructions, /不能将无来源的画面读数写成.*支持/);
  assert.match(instructions, /来源格只能写.*恰好一个实际 source_id/);
  assert.match(instructions, /不能写编号范围、括注/);
  assert.match(instructions, /不能补写标点/);
  assert.match(instructions, /历史意见及库侧原始判定继续完整保留/);
});

test('真实首轮报告的来源格加注与不完整样本摘录仍被拒收', () => {
  const text = fs.readFileSync(new URL('./__fixtures__/image-review-incomplete-citation-20261102.txt', import.meta.url), 'utf8');
  const backgroundRows = checkImageWorkflowEvidence(text).factReview.rows.filter(row => row.source_id);
  assert.equal(backgroundRows.length, 2);
  const sources = backgroundRows.map((row, i) => ({ id: `kb:${i + 1}`, kind: 'kb_hit', kb_hit: true,
    excerpt_only: true, excerpt_verified: true, content: row.quote }));
  const annotated = checkImageWorkflowEvidence(text, { sources });
  assert.equal(annotated.ok, false);
  assert.equal(annotated.factReview.rows.filter(row => row.citation?.reason === 'source_not_verified').length, 2);
  const exactIds = text.replace(/kb:([12])（[^|]*）/g, 'kb:$1');
  const incompleteQuotes = checkImageWorkflowEvidence(exactIds, { sources });
  assert.equal(incompleteQuotes.ok, false, 'removing source annotations cannot make an incomplete quotation valid');
  assert.equal(incompleteQuotes.factReview.rows.filter(row => row.citation?.reason === 'quote_not_substantive').length, 2);
});

for (const facts of ['本轮未做联网检索。库内已登记。', '未登记（本轮未做联网检索）',
  'AAP https://publications.aap.org/pediatrics/']) {
  test(`裸占位4B不算交付：${facts}`, () => {
    const r = checkImageWorkflowEvidence(report(facts, '产品为摄像头。'));
    assert.equal(r.ok, false);
    assert.equal(r.hasAuthoritativeSource, false);
  });
}

test('无法确认且有具体证据缺口算完成，不替用户改成必须REVIEW', () => {
  const facts = table(['| C1：设备夜视距离为30米 | 无法确认 | 库内没有该型号的夜视测试记录，图中也没有距离参数 | — | — |']);
  const r = checkImageWorkflowEvidence(report(facts, 'C1：夜视距离30米。'));
  assert.equal(r.ok, true, r.missing.join('；'));
  assert.equal(r.factReview.verifiedCitationCount, 0);
});

test('不适用须有具体范围原因，未登记加未联网不够', () => {
  const good = '| C1：外部医学事实 | 不适用 | 仅展示白色机身外观，没有医疗、安全或性能宣称 | — | — |';
  assert.equal(checkImageWorkflowEvidence(report(table([good]))).ok, true);
  const bad = '| C1：设备夜视距离30米 | 无法确认 | 未登记（本轮未做联网检索） | — | — |';
  assert.equal(checkImageWorkflowEvidence(report(table([bad]))).ok, false);
});

test('第三节有C1/C2时4B漏C2或重复C1不得通过', () => {
  for (const rows of [[visualRow], [visualRow, visualRow]]) {
    const r = checkImageWorkflowEvidence(report(table(rows), 'C1：产品外观。\nC2：夜视30米。'));
    assert.equal(r.ok, false);
    assert.ok(r.factReview.missingClaimIds.includes('C2'));
  }
});

test('支持结论必须绑定已核来源和实际原文；AAP名字不作来源凭据', () => {
  const row = `| C1：婴儿仰卧睡眠建议 | 支持 | 来源讨论一岁以内婴儿，未用于证明产品可防窒息 | ${source.id} | ${quote} |`;
  const text = report(table([row]), 'C1：婴儿应仰卧睡眠。');
  const r = checkImageWorkflowEvidence(text, { sources: [source] });
  assert.equal(r.ok, true, r.missing.join('；'));
  assert.equal(r.hasAuthoritativeSource, true);
  assert.equal(r.factReview.verifiedCitationCount, 1);
  assert.equal(r.factReview.factTruthVerified, false);
  assert.equal(checkImageWorkflowEvidence(text, { sources: [] }).ok, false);
  const forged = text.replace(quote, 'This sentence never appears in the verified source document and is fabricated.');
  assert.equal(checkImageWorkflowEvidence(forged, { sources: [source] }).ok, false);
});

test('当单KB摘录可以核引用，但同名AAP的KB命中不能升级权威快照', () => {
  const q = '图中展示的是白色产品机身，不代表经过临床研究证明。';
  const kb = { id: 'kb:1', kind: 'kb_excerpt', verified: false, excerpt_verified: true,
    excerpt_only: true, read_only: true, kb_hit: true, content: q, excerpt: q, authority: 'AAP' };
  const row = `| C1：产品颜色 | 部分支持 | 摘录仅说明外观，不能证明功能 | kb:1 | ${q} |`;
  const r = checkImageWorkflowEvidence(report(table([row])), { sources: [kb] });
  assert.equal(r.ok, true, r.missing.join('；'));
  assert.equal(r.hasAuthoritativeSource, false);
  assert.equal(r.factReview.verifiedCitationCount, 1);
});

test('第三节表声明的映射列与普通编号引用不会新增主张', () => {
  const claims = '| 编号 | 主张 | 4B行 |\n|---|---|---|\n| C1 | 产品为白色摄像头 | C1 |\n\n（C1 对应4B的C1。）';
  const r = checkImageWorkflowEvidence(report(table([visualRow]), claims));
  assert.equal(r.ok, true, r.factReview.missing.join('；'));
  assert.deepEqual(r.factReview.expectedClaimIds, ['C1']);
  assert.equal(r.claimDeclarations.entries[0].text, '产品为白色摄像头');
});
test('4B非法C6′/C1a不截短为现存C，原行与列偏移完整返回', () => {
  for (const alias of ['C6′', 'C1a']) {
    const raw = `| ${alias} 旧主张 | 无法确认 | 缺少当前原始记录，不作安全结论。 | — | — |`;
    const r = checkImageWorkflowEvidence(report(table([visualRow, raw])));
    assert.equal(r.ok, false);
    const row = r.factReview.rows[1]; assert.equal(row.id, null);
    assert.match(row.missing.join(' '), /非法/); assert.equal(row.rawLine, raw);
    assert.equal(r.stages.facts.body.split('\n')[row.bodyLineIndex], raw);
    assert.equal(row.rawCells[row.columnIndices.boundary], ' 缺少当前原始记录，不作安全结论。 ');
    assert.deepEqual(row.columnIndices, { claim: 0, conclusion: 1, boundary: 2, source_id: 3, quote: 4 });
  }
});
test('第三节下级主张标题仍属于本节，同级下一节才结束', () => {
  const r = checkImageWorkflowEvidence(report(table([visualRow]), '#### C1：产品为白色摄像头。\n细节：图1可见白色机身。'));
  assert.equal(r.ok, true, r.factReview.missing.join(' '));
  assert.deepEqual(r.claimDeclarations.ids, ['C1']);
  assert.match(r.claimDeclarations.entries[0].text, /图1可见白色机身/);
});

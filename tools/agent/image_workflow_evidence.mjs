/** Report delivery and citation checks only. No I/O and no content verdict. */
import { verifyFactCitation } from './image_fact_sources.mjs';
import { parseClaimDeclarations, extractClaimIds, rawTableCells, readClaimIdentifier } from './image_claim_declarations.mjs';

const STAGES = [
  ['scope', '审核对象与范围', /^(审核对象与范围|审核范围)/],
  ['visual', '视觉分析与 OCR', /^(视觉分析\s*(?:与|和|及|[+＋])?\s*OCR|OCR\s*(?:与|和|及)\s*视觉分析|图像内容提取(?:\s*(?:与|和|及)\s*OCR)?)/i],
  ['claims', '主张拆分与核查清单', /^(主张拆分(?:与核查清单)?|主张核查清单|核查清单)/],
  // 2026-11-03：标题容错补「4A.」「4B.」（点号）—— 此前只认 、 : ，模型换一种编号写法就被判整章缺失
  ['rules', '4A 规则符合性', /^(4A\s*[：:、.．]?\s*规则符合性(?:核查)?|规则符合性\s*[（(]?4A[）)]?)/i],
  ['facts', '4B 事实准确性核查', /^(4B\s*[：:、.．]?\s*事实准确性(?:核查)?|事实准确性(?:核查)?\s*[（(]?4B[）)]?)/i],
  ['consistency', '图文一致性', /^(图文一致性(?:与信息完整性)?(?:核查)?)/],
];
const plain = (value) => String(value ?? '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  .replace(/[*_`]/g, '').trim();
const generic = (value) => {
  const clauses = plain(value).replace(/https?:\/\/\S+/g, '').split(/[\n；;。]/).filter((s) => s.trim());
  return !clauses.length || clauses.every((clause) => {
    const text = clause.replace(/\bC\d+\b/gi, '').trim();
    if (/^(?:OCR|视觉分析|画面读取|主张拆分|核查清单|规则核查|事实核查|图文一致性)?\s*(?:已完成|已核查|已检查|已对照|已登记|检查通过|核查通过|暂无|无)$/i.test(text)) return true;
    if (/^(?:已|已经)完成(?:视觉(?:分析)?(?:与|和|及)?OCR|OCR(?:与|和|及)?视觉(?:分析)?|主张拆分|规则核查|事实核查|图文一致性)$/i.test(text)) return true;
    const s = text.replace(/本轮|本次|仅做|库内对照|联网检索|联网|未登记|已登记|已完成|已核查|已检查|已对照|核查完成|已确认|未做|尚未|没有|无需/g, '')
      .replace(/[\s，,。；;：:（）()—\-！!？?]/g, '');
    return !s || /^(无|有|不适用|无法确认|见上|同上|待补|待核查|待确认|待补充|无异常|未发现问题|检查通过|核查通过|未覆盖|覆盖不足|无依据)$/.test(s);
  });
};

function splitStages(text) {
  const sections = Object.fromEntries(STAGES.map(([key]) => [key, { present: false, lines: [] }]));
  let current = null; let currentDepth = 0;
  for (const original of String(text ?? '').split(/\r?\n/)) {
    const line = plain(original).replace(/^#{1,6}\s*/, '')
      .replace(/^(?:[一二三四五六七八九十]+|\d+)[、.．]\s*/, '');
    let heading = null;
    for (const [key, , re] of STAGES) {
      const m = re.exec(line);
      if (!m) continue;
      const tail = line.slice(m[0].length).trim();
      // ★ 2026-11-03（线上实测）：标题常带括注 ——
      //   `## 四、4A 规则符合性（知识库链路）` 的 tail 是「（知识库链路）」，
      //   而这里此前只认「：」⇒ **整章被判缺失**（present=false）⇒
      //   一份 4A 写了 11 条逐主张判断、5 条规则读数的报告被判成
      //   「4A 规则符合性：本节未写具体内容」，整单压成「审查未完成」。
      //   括注是标题的一部分，不是正文：认它、但不把它当章节内容。
      if (tail && !/^[：:（(]/.test(tail)) continue;
      heading = { key, body: /^[：:]/.test(tail) ? tail.replace(/^[：:]\s*/, '') : '' }; break;
    }
    if (heading) {
      current = heading.key;
      currentDepth = original.match(/^\s*(#{1,6})\s/)?.[1].length ?? 0;
      sections[current].present = true;
      if (heading.body) sections[current].lines.push(heading.body);
    } else if (/^(视觉核对|问题清单|问题优先级|结论|③b|转述摘要|转述模板)(?:[：:\s]|$)/.test(line)) {
      current = null;
    } else if (/^\s*#{1,6}\s+/.test(original)) {
      const depth = original.match(/^\s*(#{1,6})\s/)?.[1].length ?? 0;
      if (current && currentDepth && depth > currentDepth) sections[current].lines.push(original);
      else current = null;
    } else if (current) sections[current].lines.push(original);
  }
  return sections;
}

const claimIdsOf = extractClaimIds;
const cellsOf = (line) => rawTableCells(line).map((s) => plain(s.replace(/\\\|/g, '|')));
const placeholder = (s) => !s || /^(?:—+|-+|无|无来源|不适用|N\/?A|none|null)$/i.test(s);
const stripQuote = (s) => plain(s).replace(/^[「『“"]([\s\S]*)[」』”"]$/, '$1').trim();

function factReview(body, declarations, sources) {
  const expected = declarations.ids;
  const review = { format: 'legacy', deliveryComplete: false, expectedClaimIds: expected,
    coveredClaimIds: [], missingClaimIds: [], rows: [], missing: [], verifiedCitationCount: 0,
    citationVerification: 'unverified', semanticJudgment: 'model', factTruthVerified: false };
  const lines = String(body).split(/\r?\n/).map((rawLine, bodyLineIndex) => ({ rawLine, bodyLineIndex }))
    .filter(({ rawLine }) => /^\s*\|/.test(rawLine));
  const tableLike = lines.some(({ rawLine }) => /主张|核查结论|\bC\d+\b/i.test(rawLine));
  if (tableLike) {
    review.format = 'table';
    if (!expected.length) review.missing.push('第三节缺少 C 主张编号，无法逐项核对核查表');
    review.missing.push(...declarations.errors);
    const headerAt = lines.findIndex(({ rawLine }) => cellsOf(rawLine).some((s) => s === '主张'));
    const header = headerAt < 0 ? [] : cellsOf(lines[headerAt].rawLine);
    const labels = ['主张', '核查结论', '依据及边界', '来源', '来源原文'];
    const indices = labels.map((label) => header.indexOf(label));
    const columnIndices = Object.fromEntries(['claim', 'conclusion', 'boundary', 'source_id', 'quote'].map((key, index) => [key, indices[index]]));
    if (indices.some((index) => index < 0)) review.missing.push('4B 核查表缺少主张、结论、边界或引用字段');
    else for (const { rawLine, bodyLineIndex } of lines.slice(headerAt + 1)) {
      const cells = cellsOf(rawLine);
      if (cells.every((s) => /^:?-+:?$/.test(s))) continue;
      const [claim = '', conclusion = '', boundary = '', sourceCell = '', rawQuote = ''] = indices.map((i) => cells[i]);
      const identifier = readClaimIdentifier(claim);
      const id = identifier.id;
      const source_id = sourceCell.replace(/^source_id\s*[=:：]\s*/i, '').trim();
      const quote = stripQuote(rawQuote);
      const row = { id, claim, conclusion, boundary, source_id: placeholder(source_id) ? null : source_id,
        quote: placeholder(quote) ? null : quote, rawLine, bodyLineIndex, columnIndices: { ...columnIndices },
        rawCells: rawTableCells(rawLine), deliveryComplete: true, citation: null, missing: [] };
      if (identifier.error) row.missing.push(identifier.error);
      if (cells.length !== header.length) row.missing.push('核查表单元格数量不完整');
      if (!claim || generic(claim.replace(/\bC\d+\b\s*[：:]?/gi, '')) && !expected.includes(id)) row.missing.push('缺少具体主张');
      if (!['支持', '部分支持', '不支持', '无法确认', '画面可确认', '不适用'].includes(conclusion)) row.missing.push('核查结论不在闭集');
      if (generic(boundary)) row.missing.push('缺少具体核查依据或无法确认/不适用的原因');
      if (['支持', '部分支持', '不支持'].includes(conclusion)) {
        row.citation = verifyFactCitation({ source_id: row.source_id, quote: row.quote }, sources);
        if (!row.citation.ok) row.missing.push(`来源引用未核实（${row.citation.reason}）`);
      } else if (row.source_id || row.quote) {
        row.citation = verifyFactCitation({ source_id: row.source_id, quote: row.quote }, sources);
        if (!row.citation.ok) row.missing.push(`所列来源引用未核实（${row.citation.reason}）`);
      }
      row.deliveryComplete = !row.missing.length;
      review.rows.push(row);
    }
    if (!review.rows.length) review.missing.push('4B 核查表没有主张核查行');
    const seen = new Set();
    for (const row of review.rows) {
      if (row.id && seen.has(row.id)) review.missing.push(`4B 主张 ${row.id} 重复`);
      if (row.id) seen.add(row.id);
      if (row.deliveryComplete && row.id) review.coveredClaimIds.push(row.id);
      review.missing.push(...row.missing.map((reason) => `${row.id ?? row.claim ?? '4B'}：${reason}`));
      if (row.citation?.ok) review.verifiedCitationCount++;
    }
  } else {
    // 兼容历史真实报告：只确认交付了具体主张的结果/边界，不宣称引用已验证。
    const result = /支持|无法确认|无法核验|无法验证|无法判断|不可核|可对照|一致|相符|吻合|不符|矛盾|不作结论|不适用|无事实载荷|读数不全|无法.{0,12}证实/g;
    const concrete = (s) => {
      const results = String(s).match(result);
      if (!results || generic(s)) return false;
      const context = String(s).replace(result, '')
        .replace(/\bC\d+\b|主张|核查结果|核查结论|事实核查|结果|结论/g, '');
      return !generic(context);
    };
    if (!concrete(body)) review.missing.push('4B 没有具体主张的核查结果或适用边界');
    if (expected.length) {
      for (const clause of String(body).split(/(?=\bC\d+\b)/i)) {
        const ids = claimIdsOf(clause);
        if (ids.length === 1 && concrete(clause)) review.coveredClaimIds.push(ids[0]);
      }
    }
  }
  review.coveredClaimIds = [...new Set(review.coveredClaimIds)];
  review.missingClaimIds = expected.filter((id) => !review.coveredClaimIds.includes(id));
  if (review.missingClaimIds.length) review.missing.push(`4B 未逐项覆盖 ${review.missingClaimIds.join('、')}`);
  review.deliveryComplete = !review.missing.length;
  if (review.verifiedCitationCount) review.citationVerification = review.rows.some((row) => row.citation && !row.citation.ok) ? 'partial' : 'verified';
  else if (review.format === 'table' && review.deliveryComplete) review.citationVerification = 'not_applicable';
  return review;
}

export function checkImageWorkflowEvidence(text, { sources = [] } = {}) {
  const sections = splitStages(text);
  const stages = Object.fromEntries(STAGES.map(([key, label]) => {
    const body = sections[key].lines.join('\n').trim();
    return [key, { label, present: sections[key].present, body,
      ok: sections[key].present && !generic(body) }];
  }));
  const declarations = parseClaimDeclarations(stages.claims.body);
  const facts = factReview(stages.facts.body, declarations, sources);
  if (declarations.errors.length) stages.claims.ok = false;
  stages.facts.ok = stages.facts.ok && facts.deliveryComplete;
  // ★ 2026-11-03：不合格章节**必须带原因**。此前只回章名（如「4B 事实准确性核查」），
  //   而这串字同时进日志、卡片与**补写提示**（image_chain_execution.mjs:342）——
  //   模型只知道「4B 不合格」、不知道错在哪一行，于是整表重写；重写又撞上逐字保留的闸，
  //   最终永远回到「审查未完成」（2026-11-03 实测 7 单同一形状）。
  //   facts 的真实原因本来就在 facts.missing 里，此前被丢弃，现在带出来；
  //   但**必须保留章名做前缀**（下游按章名定位是哪一节，裸原因会让"4B 被删"这条消失）。
  const missing = Object.entries(stages).filter(([, stage]) => !stage.ok).flatMap(([key, stage]) => {
    if (key === 'facts' && facts.missing.length) return [`${stage.label}：${facts.missing.join('；')}`];
    return [`${stage.label}：本节未写具体内容（只列标题或「已完成」之类）`];
  });
  return { ok: !missing.length, missing, stages, factReview: facts, claimDeclarations: declarations,
    hasAuthoritativeSource: facts.rows.some((row) => row.citation?.ok && row.citation.authority === 'AAP') };
}

export function imageWorkflowEvidenceInstructions() {
  return [
    '按六个独立章节交付：审核对象与范围、视觉分析与 OCR、主张拆分与核查清单、4A 规则符合性、4B 事实准确性核查、图文一致性。每节写本图的实际结果，不能只列标题或写“已完成”。',
    '第三节将每条主张标为 C1、C2…；4B 用下表逐一覆盖，不得跳过无法确认的主张：',
    '编号只用 C 加数字；C6′、C1a 不是合法编号。正文引用与4B映射列不会增设主张；新增主张须另写声明行并给独立4B行，不能用撇号或字母另起子编号。',
    '主张清单须同时覆盖原图文字、画面和报告自己新增的事实判断。纯粹描述抱婴、人物出镜，不强制引用婴儿睡眠指南；但安全保证、睡眠建议和风险成立/不成立的判断必须单独列为 C 主张，逐项核查。非睡眠场景只能说明睡眠指南不用于评价本图，不能据此推出抱姿安全或没有风险。',
    '4A 保留规则原文、历史意见和规范符合性判断，不能把规则引用本身当作新增医学事实；若借规则名额外作“绝对安全”“无风险”或健康功效保证，这些仍须列入 4B 核查。原图文字中的安全营销主张即使是引文，也不能借此免核。',
    '实际婴儿睡眠场景须逐个婴儿、逐个面板单列 C 核查睡姿与安全睡眠建议的关系，引用适用的本轮 AAP 原文；不能只交睡姿观察，也不能用另一面板或品牌介绍行的引文代替。非睡眠抱婴不新增此义务。',
    '| 主张 | 核查结论 | 依据及边界 | 来源 | 来源原文 |',
    '| --- | --- | --- | --- | --- |',
    '核查结论只用：支持、部分支持、不支持、无法确认、画面可确认、不适用。',
    '支持/部分支持/不支持须引用本轮提供的 source_id，并逐字摘录实际来源原文；机构名、链接或“已登记”不等于核实引用。',
    '库内来源编号 kb:N 对应 review_run 标准输出中“③引擎结论”JSON 的 evidence_meta.kb_hits 原始数组下标加 1；例如原数组第 1 项为 kb:1，保持原始顺序，不按筛选后的清单重新编号。',
    '来源原文须为完整句子，保留句末标点：英文至少 40 字符，中文至少 12 个汉字；不摘机构名、链接或不完整短语。',
    '无法确认要写具体证据缺口；画面可确认要写画面锚点；不适用要写本图为何没有相关外部事实。无来源的格子写“—”。库未覆盖或有具体原因的无法确认仍可交付完成，不自行增加问题或改变审查结论。',
    '引用选择必须与证据种类一致：不能将无来源的画面读数写成“支持/部分支持/不支持”。例如 OCR 可确认文字或语言词形，但不能证明目标受众；分别写“画面可确认”或“无法确认”并说明边界。支持类结论必须有本轮 source_id 和来源内逐字完整句，不能以缺引文的历史意见替代。',
    '4B 表**只放逐 C 的核查行**：每行第一格必须是合法 C 编号（C 加数字），一号一行，行数必须等于第三节声明的 C 数。任何"附加核查/补充说明/文字层核查"都不是主张，**不得写进 4B 表**，只能写在 4B 表之外（同一节正文里另起小节）；表里只要出现一行编号以外的行，整表会被判成「C 主张与 4B 行未一一对应」，本轮直接不合格。',
    '输出前逐行自检 4B：来源格只能写本轮恰好一个实际 source_id 或“—”，不能写编号范围、括注、解释或不存在的编号。任何结论只要填了来源，来源原文也必须是可核的逐字完整句；摘录没有句末标点时不能补写标点来冒充原文。若没有这样的原文，支持类结论必须如实写“无法确认”，在依据及边界保留具体风险与证据缺口，来源和来源原文写“—”；不能一边写支持一边说无来源。历史意见及库侧原始判定继续完整保留在 4A 和库侧读数中，不因事实引用缺口删除风险或改动引擎结论。',
    '来源原文匹配只验证引用确实存在；主张与来源的语义关系由审查模型判断，不得说成机器已经验证事实真实。',
    '宿主会按本轮全部图中文字、画面及报告逐项复核：引用必须与所在 C 主张相关且适用。品牌行的 AAP 引文不能替另一条安全主张作证；明确的婴儿安全未知必须保留，不能用别处“不适用”或来源名称消除。没有足够依据就如实保留缺口，不编造核查完成。',
  ].join('\n');
}

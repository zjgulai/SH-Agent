/** Lossless model-input transport. The host evidence schema/hash never changes. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const VIEW = 'image-claim-view/v1';
const EVIDENCE_KEYS = ['schema', 'reportText', 'originalRecords', 'records', 'sleepObligations', 'sources', 'claims'];
const VIEW_KEYS = ['viewSchema', 'evidenceSchema', 'evidenceHash', 'parents', 'clauses',
  'reportGaps', 'sources', 'claims', 'sleepObligations', 'coverageManifest'];
const fail = message => { throw new Error(`图片语义输入视图无效：${message}`); };
function canonical(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object' || seen.has(value)) return fail('非完整JSON数据');
  seen.add(value);
  let result;
  if (Array.isArray(value)) result = value.map(item => canonical(item, seen));
  else {
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail('非JSON对象');
    result = Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key], seen)]));
  }
  seen.delete(value); return result;
}
const payload = evidence => Object.fromEntries(EVIDENCE_KEYS.map(key => [key, evidence[key]]));
const hash = evidence => createHash('sha256').update(JSON.stringify(canonical(payload(evidence))), 'utf8').digest('hex');
const equal = (a, b, reason) => { if (!isDeepStrictEqual(a, b)) fail(reason); };
const compactManifest = evidence => ({ firstOrdinal: 1, lastOrdinal: evidence.records.length,
  recordCount: evidence.records.length, claimRows: evidence.claims.map(claim => [claim.id, claim.rowHash]) });
const expandedManifest = evidence => ({ recordCount: evidence.records.length,
  recordIds: evidence.records.map(record => record.id), clauses: evidence.records.map(record => [record.ordinal, record.id]),
  claimCount: evidence.claims.length, claimRows: evidence.claims.map(claim => ({ id: claim.id, rowHash: claim.rowHash })) });

export function decodeImageClaimView(input) {
  const view = canonical(input);
  if (Object.keys(view).length !== VIEW_KEYS.length || VIEW_KEYS.some(key => !Object.hasOwn(view, key))
    || view.viewSchema !== VIEW || view.evidenceSchema !== 'image-claim-evidence/v3') fail('协议字段或版本不符');
  if (!Array.isArray(view.parents) || !view.parents.length || view.parents.length > 200
    || !Array.isArray(view.clauses) || !view.clauses.length || view.clauses.length > 400
    || !Array.isArray(view.claims) || !Array.isArray(view.sleepObligations) || !Array.isArray(view.sources)) fail('完整记录缺失或超限');
  const seenParents = new Set();
  for (const parent of view.parents) {
    if (!parent || typeof parent.id !== 'string' || seenParents.has(parent.id)
      || Object.hasOwn(parent, 'text') || Object.hasOwn(parent, 'scene')) fail('父记录元信息无效');
    seenParents.add(parent.id);
  }
  const parts = view.parents.map(() => []); const records = []; let lastParent = 0;
  for (const [index, clause] of view.clauses.entries()) {
    if (!Array.isArray(clause) || clause.length !== 4) fail('子句不是固定四元组');
    const [ordinal, parentIndex, start, text] = clause;
    if (ordinal !== index + 1 || !Number.isInteger(parentIndex) || parentIndex < lastParent
      || parentIndex < 0 || parentIndex >= parts.length || !Number.isInteger(start) || start < 0 || typeof text !== 'string') fail('子句序号、父序或offset无效');
    const group = parts[parentIndex];
    if (start !== (group.at(-1)?.end ?? 0)) fail('子句没有完整连续覆盖父记录');
    const parentId = view.parents[parentIndex].id;
    const record = { id: `${parentId}#${group.length + 1}`, ordinal, parentId,
      start, end: start + text.length, text };
    records.push(record); group.push(record); lastParent = parentIndex;
  }
  if (parts.some(group => !group.length)) fail('父记录没有子句回执范围');
  const originalRecords = view.parents.map((parent, index) => {
    const text = parts[index].map(record => record.text).join('');
    return { ...parent, text, ...(parent.origin === 'scene' ? { scene: JSON.parse(text) } : {}) };
  });
  const reportParents = originalRecords.filter(parent => parent.origin === 'review_assertion');
  if (!Array.isArray(view.reportGaps) || view.reportGaps.length !== reportParents.length + 1
    || view.reportGaps.some(gap => typeof gap !== 'string')) fail('原报告间隔不完整');
  let reportText = '';
  for (const [index, parent] of reportParents.entries()) {
    reportText += view.reportGaps[index];
    if (parent.start !== reportText.length || parent.end !== parent.start + parent.text.length) fail('报告父记录offset不符');
    reportText += parent.text;
  }
  reportText += view.reportGaps.at(-1);
  const restoreRefs = item => {
    if (!item || Object.hasOwn(item, 'recordIds') || !Array.isArray(item.recordOrdinals)
      || new Set(item.recordOrdinals).size !== item.recordOrdinals.length
      || item.recordOrdinals.some(ordinal => !Number.isInteger(ordinal) || !records[ordinal - 1])) fail('声明/义务子句绑定无效');
    const { recordOrdinals, ...rest } = item;
    return { ...rest, recordIds: recordOrdinals.map(ordinal => records[ordinal - 1].id) };
  };
  const evidence = { schema: view.evidenceSchema, reportText, originalRecords, records,
    sources: view.sources, claims: view.claims.map(restoreRefs), sleepObligations: view.sleepObligations.map(restoreRefs),
    evidenceHash: view.evidenceHash };
  if (hash(evidence) !== evidence.evidenceHash) fail('完整原证据指纹不符');
  equal(view.coverageManifest, compactManifest(evidence), '覆盖清单不符');
  return { ...evidence, coverageManifest: expandedManifest(evidence) };
}

/** Also decode and compare every original field before any request is sent. */
export function encodeImageClaimView(input) {
  const evidence = canonical({ ...payload(input), evidenceHash: input.evidenceHash });
  if (hash(evidence) !== evidence.evidenceHash) fail('发送前原证据指纹不符');
  const parentIndex = new Map(evidence.originalRecords.map((parent, index) => [parent.id, index]));
  const ordinal = new Map(evidence.records.map(record => [record.id, record.ordinal]));
  const compressRefs = item => {
    const { recordIds, ...rest } = item;
    if (!Array.isArray(recordIds) || recordIds.some(id => !ordinal.has(id))) fail('原证据绑定缺失');
    return { ...rest, recordOrdinals: recordIds.map(id => ordinal.get(id)) };
  };
  const reportGaps = []; let cursor = 0;
  for (const parent of evidence.originalRecords.filter(record => record.origin === 'review_assertion')) {
    reportGaps.push(evidence.reportText.slice(cursor, parent.start)); cursor = parent.end;
  }
  reportGaps.push(evidence.reportText.slice(cursor));
  const view = { viewSchema: VIEW, evidenceSchema: evidence.schema, evidenceHash: evidence.evidenceHash,
    parents: evidence.originalRecords.map(parent => { const { text, scene, ...metadata } = parent; return metadata; }),
    clauses: evidence.records.map(record => [record.ordinal, parentIndex.get(record.parentId), record.start, record.text]),
    reportGaps, sources: evidence.sources, claims: evidence.claims.map(compressRefs),
    sleepObligations: evidence.sleepObligations.map(compressRefs), coverageManifest: compactManifest(evidence) };
  const restored = decodeImageClaimView(view);
  equal(payload(restored), payload(evidence), '发送视图不能逐字重构原证据');
  equal(restored.evidenceHash, evidence.evidenceHash, '发送视图指纹改变');
  return view;
}

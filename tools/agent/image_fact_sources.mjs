/** Approved local evidence only: no config import, network, writes or audit decision. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const SNAPSHOT = Object.freeze({
  id: 'aap-safe-sleep-2022',
  relative: 'kb/l1/1_外部标准库/url__https____hapa8fkuicz.feishu.cn_wiki_XVgVw8WZ3iZsTkkqEpwcbwjJnPh.json',
  // Approval pins the actual L1 text, not a filename or a self-declared digest.
  sha256: '9b8ee681ec6360e4c2f7356ac77a328c7635d012daa6d254016c263256dcd6bd',
  anchor: '#l.1-11',
});
const normalize = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const errorResult = (code, message) => ({ sources: [],
  errors: [{ source_id: SNAPSHOT.id, code, message }] });

/** kbRoot is the working root containing kb/, as used by the review chain. */
export function loadImageFactSources(kbRoot) {
  if (typeof kbRoot !== 'string' || !kbRoot.trim()) {
    return errorResult('source_unavailable', '未提供本地知识库工作根');
  }
  let doc;
  try { doc = JSON.parse(fs.readFileSync(path.join(kbRoot, SNAPSHOT.relative), 'utf8')); }
  catch (error) {
    return errorResult('source_unavailable', `AAP 本地快照未能读取（${error.code ?? 'invalid_json'}）`);
  }
  if (!Array.isArray(doc?.segments) || !doc.segments.length
    || doc.segments.some((segment) => typeof segment?.text !== 'string')) {
    return errorResult('source_invalid', '本地快照没有完整的 segments 文本');
  }
  // L1's source digest covers the original segments joined without separators.
  const contentHash = sha256(doc.segments.map((segment) => segment.text).join(''));
  if (contentHash !== doc.source_sha256) {
    return errorResult('source_hash_mismatch', 'AAP 本地正文与声明指纹不一致');
  }
  if (contentHash !== SNAPSHOT.sha256) {
    return errorResult('snapshot_not_approved', 'AAP 正文不是本适配器已批准的快照');
  }
  const first = normalize(doc.segments.find((segment) => segment.anchor === '#l.1-1')?.text);
  const matches = doc.segments.filter((segment) => segment.anchor === SNAPSHOT.anchor);
  const content = matches.length === 1 ? normalize(matches[0].text) : '';
  // All metadata and recommendations below are extracted from verified text.
  const title = first.match(/^TECHNICAL REPORT\s+(.+?)\s+Rachel Y\s*\./)?.[1];
  const url = first.match(/DOI:\s*(https:\/\/doi\.org\/[^\s]+)/)?.[1];
  const published = first.match(/PEDIATRICS Volume \d+, number \d+, ([A-Za-z]+ \d{4})/)?.[1];
  const scope = content.match(/The recommendations are based[\s\S]+?first year after birth\./)?.[0];
  const start = scope ? content.indexOf(scope) : -1;
  const end = content.indexOf('The prone position also increases');
  const excerpt = start >= 0 && end > start ? content.slice(start, end).trim() : '';
  if (!title || !url || !published || !scope || !excerpt) {
    return errorResult('source_invalid', '已验证正文中的标题、出版信息、适用范围或核查段落缺失');
  }
  return { sources: [{
    id: SNAPSHOT.id, url, title, published, scope, content, excerpt,
    source_sha256: contentHash, anchor: SNAPSHOT.anchor,
    kind: 'local_snapshot', authority: 'AAP', verified: true,
    source_hash_verified: true, network_checked: false,
    observed_at: doc.observed_at ?? null,
    // This is a stored document, not one of this review's retrieval hits.
    snapshot_path: SNAPSHOT.relative,
    source_url: doc.source?.entry_url ?? null,
  }], errors: [] };
}

/**
 * Only these two paths exist in current engine/review sidecars. A retrieval hit
 * proves that this excerpt was returned, not that we read or hashed its source.
 * IDs preserve stdout's hit order so the chain can cite kb:1 without inventing
 * a document identifier. Engine evidence takes precedence even when it is empty.
 */
export function kbFactSources(engine, review) {
  const hits = Array.isArray(engine?.evidence_meta?.kb_hits)
    ? engine.evidence_meta.kb_hits : Array.isArray(review?.kb_hits) ? review.kb_hits : [];
  return hits.flatMap((hit, index) => {
    if (typeof hit?.excerpt !== 'string' || !hit.excerpt.trim()
      || !(typeof hit.anchor === 'string' && hit.anchor.trim()
        || typeof hit.url === 'string' && hit.url.trim())) return [];
    return [{
      id: `kb:${index + 1}`, kind: 'kb_hit', kb_hit: true,
      anchor: hit.anchor ?? null, url: hit.url ?? null,
      title: hit.anchor || hit.url,
      excerpt: hit.excerpt, content: hit.excerpt,
      source_sha256: hit.source_sha256 ?? null,
      // This digest is supplied metadata; it was not verified against full text.
      source_hash_verified: false, verified: false, excerpt_verified: true,
      excerpt_only: true, read_only: true, network_checked: false,
    }];
  });
}

/** Prompt contains only the verified topic excerpt, never the full AAP report. */
export function formatImageFactSources(sources = []) {
  const available = Array.isArray(sources) ? sources.filter((source) => source?.verified === true
    && source.id && source.excerpt) : [];
  if (!available.length) return '';
  return [
    '【可用事实来源：本地快照，非本次联网，非本轮知识库检索命中】',
    '来源可用不代表本图适用，不因提供该来源而触发婴儿或 AAP 核查。',
    '仅在当前素材存在对应事实时使用；引用须给 source_id 和逐字 quote，不能只写机构名或链接。',
    'verified 仅表示本地正文与已批准指纹一致，不表示已联网确认最新版本或已核实本图主张。',
    ...available.flatMap((source, index) => [
      `${index + 1}. source_id=${source.id} | ${source.anchor}`,
      `标题：${source.title}`,
      `出版信息：${source.published} | ${source.url}`,
      `适用范围（原文）：${source.scope}`,
      `摘录（原文）：${source.excerpt}`,
    ]),
  ].join('\n');
}

/** Verify source identity and literal evidence, not the claim-to-source inference. */
export function verifyFactCitation(citation = {}, sources = []) {
  const source_id = citation?.source_id;
  const quote = citation?.quote;
  if (typeof source_id !== 'string' || !source_id.trim() || typeof quote !== 'string') {
    return { ok: false, reason: 'citation_invalid', source_id };
  }
  const found = Array.isArray(sources)
    ? sources.filter((source) => source?.id === source_id && (source?.verified === true
      || (source?.kb_hit === true && source?.excerpt_only === true && source?.excerpt_verified === true))) : [];
  if (found.length !== 1) return { ok: false, reason: 'source_not_verified', source_id };
  const text = normalize(quote);
  // English needs a substantive clause; Chinese conveys a complete assertion
  // in fewer characters. Both need sentence punctuation and an exact source.
  const hanCount = (text.match(/\p{Script=Han}/gu) ?? []).length;
  if ((hanCount >= 1 ? hanCount < 12 : text.length < 40)
    || !/[.!?。！？][”"']?$/.test(text) || /^https?:\/\//i.test(text)) {
    return { ok: false, reason: 'quote_not_substantive', source_id };
  }
  const source = found[0];
  if (!normalize(source.content ?? source.excerpt).includes(text)) {
    return { ok: false, reason: 'quote_not_in_source', source_id };
  }
  return { ok: true, source_id, anchor: source.anchor, source_sha256: source.source_sha256,
    kind: source.kind, verified: source.verified === true,
    // AAP privilege belongs to the approved local snapshot, never an AAP-named hit.
    authority: source.kind === 'local_snapshot' && source.id === SNAPSHOT.id
      && source.source_hash_verified === true && source.source_sha256 === SNAPSHOT.sha256
      ? 'AAP' : undefined };
}

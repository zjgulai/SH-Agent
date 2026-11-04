import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

let api;
try { api = await import('./image_fact_sources.mjs'); } catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
}
const root = process.env.SHOUHENG_FACT_SOURCE_TEST_ROOT
  || '/Users/lute/Documents/skill-test/执行skills/执行skills/skills-回归测试/知识库/内容治理';
const relative = 'kb/l1/1_外部标准库/url__https____hapa8fkuicz.feishu.cn_wiki_XVgVw8WZ3iZsTkkqEpwcbwjJnPh.json';
const original = JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
const requireApi = () => assert.equal(typeof api?.loadImageFactSources, 'function',
  '缺少可校验本地来源、不能只凭AAP名称的来源加载器');
const withSnapshot = (mutate, run) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'image-fact-source-'));
  try {
    const doc = structuredClone(original);
    mutate(doc);
    fs.mkdirSync(path.dirname(path.join(temp, relative)), { recursive: true });
    fs.writeFileSync(path.join(temp, relative), JSON.stringify(doc));
    run(temp);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
};

test('读取批准的真实快照，保留年龄范围和实际出版信息，不冒充联网或KB命中', () => {
  requireApi();
  const { sources, errors } = api.loadImageFactSources(root);
  assert.deepEqual(errors, []);
  assert.equal(sources.length, 1);
  const source = sources[0];
  assert.equal(source.id, 'aap-safe-sleep-2022');
  assert.equal(source.verified, true);
  assert.equal(source.authority, 'AAP');
  assert.equal(source.kind, 'local_snapshot');
  assert.equal(source.network_checked, false);
  assert.equal(source.anchor, '#l.1-11');
  assert.equal(source.published, 'July 2022');
  assert.equal(source.url, 'https://doi.org/10.1542/peds.2022-057991');
  assert.match(source.title, /^Evidence Base for 2022 Updated Recommendations/);
  assert.match(source.scope, /first year after birth/);
  assert.match(source.excerpt, /until the child reaches 1 year of age/);
  assert.match(source.content, /Side sleeping is not safe and is not advised\./);
});

test('已声明的hash不等于实际正文时不得给verified来源', () => {
  requireApi();
  withSnapshot((d) => { d.segments[10].text += ' changed'; }, (temp) => {
    const result = api.loadImageFactSources(temp);
    assert.equal(result.sources.length, 0);
    assert.equal(result.errors[0].code, 'source_hash_mismatch');
  });
});

test('改正文并同步改hash也不能冒充已批准的AAP快照', () => {
  requireApi();
  withSnapshot((d) => {
    d.segments[10].text += ' changed';
    d.source_sha256 = createHash('sha256').update(d.segments.map((s) => s.text).join('')).digest('hex');
  }, (temp) => {
    const result = api.loadImageFactSources(temp);
    assert.equal(result.sources.length, 0);
    assert.equal(result.errors[0].code, 'snapshot_not_approved');
  });
});

test('来源缺席返回明确错误，不能捏造AAP来源或抛垮上游', () => {
  requireApi();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'image-fact-absent-'));
  try {
    const result = api.loadImageFactSources(temp);
    assert.equal(result.sources.length, 0);
    assert.equal(result.errors[0].code, 'source_unavailable');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  assert.equal(api.loadImageFactSources('').sources.length, 0);
});

test('给模型的摘录足够核查睡姿与年龄边界，不搬整份文档或自动触发AAP', () => {
  requireApi();
  const prompt = api.formatImageFactSources(api.loadImageFactSources(root).sources);
  assert.match(prompt, /aap-safe-sleep-2022/);
  assert.match(prompt, /#l\.1-11/);
  assert.match(prompt, /first year after birth/);
  assert.match(prompt, /Side sleeping is not safe and is not advised\./);
  assert.match(prompt, /source_id/);
  assert.match(prompt, /本地快照/);
  assert.match(prompt, /不.*触发/);
  assert.ok(prompt.length < 4000);
  assert.equal(api.formatImageFactSources([]), '');
});

test('引用必须对应真实来源和足够长的原文，空白换行不导致误拒', () => {
  requireApi();
  const sources = api.loadImageFactSources(root).sources;
  const good = { source_id: 'aap-safe-sleep-2022', quote: 'Side sleeping is not safe and is not advised.' };
  assert.equal(api.verifyFactCitation(good, sources).ok, true);
  assert.equal(api.verifyFactCitation({ ...good, quote: 'Side sleeping is\nnot safe and is not advised.' }, sources).ok, true);
  for (const citation of [
    { ...good, source_id: 'other-source' },
    { ...good, quote: 'AAP' },
    { ...good, quote: 'https://doi.org/10.1542/peds.2022-057991' },
    { ...good, quote: 'Side sleeping is safe and is recommended for every infant.' },
    { ...good, quote: 'To reduce the risk of sleep-related death, it is recommended' },
  ]) assert.equal(api.verifyFactCitation(citation, sources).ok, false, JSON.stringify(citation));
  assert.equal(api.verifyFactCitation(good, [{ ...sources[0], verified: false }]).ok, false);
});

test('引用入参或来源重复时明确拒绝，不能抛异常或任意挑一条', () => {
  requireApi();
  const sources = api.loadImageFactSources(root).sources;
  for (const citation of [null, {}, { source_id: sources[0].id, quote: 123 }]) {
    assert.equal(api.verifyFactCitation(citation, sources).ok, false);
  }
  assert.equal(api.verifyFactCitation({ source_id: sources[0].id,
    quote: 'Side sleeping is not safe and is not advised.' }, [...sources, ...sources]).ok, false);
});

test('可信本单KB摘录的完整中文句子可核，机构名和编造内容仍拒绝', () => {
  requireApi();
  const sources = [{ id: 'kb:1', verified: true, anchor: '#fixture',
    excerpt: '请严格按照说明书要求清洁可拆卸部件。' }];
  assert.equal(api.verifyFactCitation({ source_id: 'kb:1',
    quote: '请严格按照说明书要求清洁可拆卸部件。' }, sources).ok, true);
  assert.equal(api.verifyFactCitation({ source_id: 'kb:1', quote: '医学协会。' }, sources).ok, false);
  assert.equal(api.verifyFactCitation({ source_id: 'kb:1',
    quote: '所有设备的电气部件都可以直接浸泡清洗。' }, sources).ok, false);
});

test('本单KB命中仅验证已返回摘录，不伪造全文hash校验或AAP权威身份', () => {
  requireApi();
  assert.equal(typeof api.kbFactSources, 'function');
  const hit = { anchor: '#l.1-2', bm25: 17.5466, kb_type: 'external_standard',
    source_sha256: 'a'.repeat(64),
    excerpt: 'Side sleeping is not safe and is not advised.',
    url: 'https://publications.aap.org/fixture' };
  const sources = api.kbFactSources({ evidence_meta: { kb_hits: [hit] } }, null);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].id, 'kb:1');
  assert.equal(sources[0].verified, false);
  assert.equal(sources[0].excerpt_verified, true);
  assert.equal(sources[0].excerpt_only, true);
  assert.equal(sources[0].read_only, true);
  assert.equal(sources[0].kb_hit, true);
  assert.equal(sources[0].source_hash_verified, false);
  assert.equal(sources[0].authority, undefined);
  const cited = api.verifyFactCitation({ source_id: 'kb:1', quote: hit.excerpt }, sources);
  assert.equal(cited.ok, true);
  assert.notEqual(cited.authority, 'AAP');
  assert.equal(api.kbFactSources(null, { kb_hits: [hit] })[0].excerpt, hit.excerpt);
  assert.deepEqual(api.kbFactSources({ evidence_meta: { kb_hits: [] } }, { kb_hits: [hit] }), []);
  assert.deepEqual(api.kbFactSources(null, { kb_hits: [{ anchor: '#empty', url: 'x' }] }), []);
});

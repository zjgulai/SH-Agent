/**
 * judge_evidence.mjs —— 把知识库**硬接**进 judge_copy 的证据链
 *
 * ── 为什么要有这个文件（不是「顺手加个功能」）────────────────────────────
 *
 * 2026-09-28 的实测结论：**只把 kb_search 挂成第 26 件工具，模型不会去用它。**
 * 守衡的路由不会主动选它 —— 判定的默认路径是 judge_copy，而 judge_copy 的
 * 输出里本来就没有「依据」这一栏，模型没有理由再去查一次。
 *
 * 所以依据不能靠模型自觉，必须**硬编码在判定工具内部**：
 *
 *   1. judge.py 判完之后，拿它自己标出来的表述去知识库检索（每个表述一次）
 *   2. 命中必须带 docId / docTitle / scoreKind / confidence / requestId
 *   3. 结论只允许引用第 2 步取回的内容
 *   4. 第 2 步没取到 → 明说「未取到依据」，不许拿常识补一个合规结论
 *
 * ── 查询词从哪来（这一条决定了整件事靠不靠得住）──────────────────────────
 *
 * 不用语言模型去「抽取关键词」—— 判定引擎**自己已经抽好了**：
 * `judge.py` 的 `hits[].matched[].matched_text` 就是它在这段文案里**实际命中**的
 * 逐字片段（实测：'cure' / 'cure mastitis' / 'pain relief' / 'Clinically proven'）。
 * 那是比任何启发式都准的「关键表述」，而且它天然带出处（哪条规则命中了它）。
 *
 * 抓不到引擎命中时（catch_all）才退回**试探词**。但试探词是从文案里猜的，
 * 所以「试探词查不到」**不能**说成「知识库里没有」—— 这两个结论在
 * `status` 上是分开的（`none` vs `probe_empty`），见下面 STATUS 表。
 *
 * ── 六种状态，每一句都对应一种**能说得出口**的话 ──────────────────────────
 *
 * | status        | 意思                             | 可以说「库里没有」吗 |
 * |---------------|----------------------------------|----------------------|
 * | found         | 至少一条命中                     | —— （有命中，不适用）|
 * | none          | 查询词全来自引擎且全部成功全 0   | ✅ 可以说           |
 * | probe_empty   | 试探词全部成功但全 0             | ❌ 只能说「没试到」  |
 * | partial       | 有的查成了、有的没查成           | ❌ 不许              |
 * | untested      | 一次都没查成（网络/配额/凭据）   | ❌ 不许              |
 * | disabled      | 开关关了（SHOUHENG_KB_ENABLED=0）| ❌ 不许              |
 *
 * 「没查成」被读成「库里没有」，会直接产出一个**假阴性的合规结论** ——
 * 这是这一整套设计要防的唯一一件事，所以状态必须分得开、且必须透传出去。
 */
import * as kb from './kb_client.mjs';

/** 每个表述取回几个分片。分片会重复占位，5 个够看清一条规则的正文。 */
export const EVIDENCE_TOPK = 5;
/**
 * 引擎标出的表述少于这个数，才拿试探词补齐。
 * 设成 3 是因为「3 个引擎表述已经足够锚住一段文案的判定面」，
 * 而每多补一个试探词都要花一次配额、并把 basis 降档（见下）。
 */
export const MIN_ENGINE_QUERIES = 3;
/** 一次判定最多查几个表述（配额 1000/天 + 客户端 1050ms 间隔，5 次约 4 秒） */
export const MAX_WORDING_QUERIES = 5;
/** 判定声称「需要证据」时，拿回执里引用的条款去对端库核几条（每条 1 次配额） */
export const MAX_STANDARD_QUERIES = 2;
/** 同一个 docId 最多放进上下文几个分片（实测 topK=5 可能全部来自同一个文档） */
export const MAX_CHUNKS_PER_DOC = 2;
/** 一次判定最多塞给模型几条证据（再多会挤掉判定本身） */
export const MAX_EVIDENCE_ITEMS = 10;
/** 单条证据正文截断长度。截断了必须说出来（见 text_truncated）。 */
export const EVIDENCE_TEXT_LIMIT = 400;

/** trigram 分词器要求：查询词 ≥3 个字符才有真 BM25 */
const MIN_QUERY_CHARS = 3;

/** 试探词里要跳掉的英文虚词（它们出现在几乎每条文案里，查了只会浪费配额） */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'your', 'you', 'our', 'are', 'was',
  'were', 'has', 'have', 'had', 'not', 'but', 'all', 'can', 'will', 'any', 'its', 'their',
  'them', 'they', 'when', 'what', 'which', 'who', 'how', 'why', 'out', 'use', 'using', 'used',
  'new', 'best', 'more', 'most', 'only', 'also', 'than', 'then', 'into', 'over', 'just',
  'get', 'got', 'here', 'there', 'been', 'being', 'does', 'did', 'about', 'after', 'before',
]);

const hasCJK = (s) => /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(s);

/** 归一化一个候选查询词：去掉首尾标点空白、压掉内部换行。空串返 null。 */
function normalizePhrase(s) {
  const t = String(s ?? '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, '')
    .trim();
  return t || null;
}

const charLen = (s) => [...String(s ?? '')].length;

/**
 * 从**引擎命中**里取查询词。这是首选来源：它们是引擎实际在这段文案里认出来的表述。
 * 返回 `[{phrase, source, rule_key}]`，按引擎给出的顺序，已去重。
 */
function phrasesFromEngine(judgeResult) {
  const out = [];
  const seen = new Set();
  for (const h of Array.isArray(judgeResult?.hits) ? judgeResult.hits : []) {
    for (const m of Array.isArray(h?.matched) ? h.matched : []) {
      for (const raw of [m?.matched_text, m?.matched_keyword]) {
        const p = normalizePhrase(raw);
        if (!p) continue;
        const k = p.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ phrase: p, source: 'engine_matched', rule_key: h?.rule_key ?? null });
      }
    }
  }
  return out;
}

/**
 * **试探词**：引擎一条都没命中时，从文案里猜几个查询词。
 *
 * ★ 它们的地位比引擎命中低一档，`status` 会据此区分（probe_empty ≠ none）。
 *
 * 切法：先按「非字母数字」切子句（标点、空格、换行都算边界），然后
 *   · 含中文的子句：整句（中文没有词边界，切碎了反而切错）—— 超过 12 个字才截断
 *   · 纯英文的子句：≥4 个字符、且不在虚词表里的单词
 * 全部查不到时不许断言「库里没有」，所以这里的取舍只影响召回率，不影响正确性。
 */
export function probePhrases(text, cap = MAX_WORDING_QUERIES) {
  const out = [];
  const seen = new Set();
  const push = (s) => {
    const p = normalizePhrase(s);
    if (!p) return;
    const k = p.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(p);
  };
  const clauses = String(text ?? '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  for (const c of clauses) {
    if (out.length >= cap) break;
    if (hasCJK(c)) {
      if (charLen(c) >= MIN_QUERY_CHARS) push([...c].slice(0, 12).join(''));
    } else if (c.length >= 4 && !STOPWORDS.has(c.toLowerCase())) {
      push(c);
    }
  }
  return out;
}

/**
 * 挑出这次判定要拿去检索的查询词。**纯函数，离线可证。**
 *
 * @returns {{queries:Array<{phrase:string,source:string,rule_key:string|null}>, dropped_short:string[], basis:string}}
 *   `basis` 是这次证据链的**可信档位**：
 *     · `engine_matched` —— 全部来自引擎命中（最高档）
 *     · `mixed`          —— 引擎的用完了、用试探词补齐
 *     · `probe`          —— 引擎一条没命中，全是试探词（最低档）
 */
export function pickKeyPhrases(text, judgeResult, { max = MAX_WORDING_QUERIES } = {}) {
  const engine = phrasesFromEngine(judgeResult);
  const dropped = [];
  const usable = [];
  for (const e of engine) {
    if (charLen(e.phrase) >= MIN_QUERY_CHARS) usable.push(e);
    else dropped.push(e.phrase);
  }

  let basis = usable.length ? 'engine_matched' : 'probe';
  const queries = usable.slice(0, max);

  // ★ 只在引擎给的表述**不够用**时才补试探词，不为了「凑满 5 个」而补。
  //   理由有两条，都跟钱和证据力有关：
  //     · 每补一个就多花一次配额（1000/天），而试探词的召回率本来就比引擎命中低；
  //     · 补了之后 `basis` 降成 mixed，`may_assert_kb_absence` 直接变 false ——
  //       为了多查两个没把握的词，把「可以说库里没有」这个能力换掉了，不划算。
  //   3 个引擎表述已经足够锚住一段文案的判定面。
  if (usable.length < MIN_ENGINE_QUERIES && queries.length < max) {
    // ★ 只在**缺量**时补试探词，且补进来的都标成 probe —— 不许拿试探词冒充引擎命中。
    const already = new Set(queries.map((q) => q.phrase.toLowerCase()));
    for (const p of probePhrases(text, max * 2)) {
      if (queries.length >= max) break;
      if (already.has(p.toLowerCase())) continue;
      if (charLen(p) < MIN_QUERY_CHARS) { dropped.push(p); continue; }
      already.add(p.toLowerCase());
      queries.push({ phrase: p, source: 'probe', rule_key: null });
    }
    if (queries.some((q) => q.source === 'probe') && usable.length) basis = 'mixed';
  }

  return { queries, dropped_short: dropped, basis };
}

/** judge.py 说「这条规则需要证据」时，命中的是哪种证据（不是 none 就算需要） */
function evidenceRequirements(judgeResult) {
  const reqs = new Set();
  for (const h of Array.isArray(judgeResult?.hits) ? judgeResult.hits : []) {
    const r = h?.evidence_required;
    if (r && r !== 'none') reqs.add(String(r));
  }
  return [...reqs];
}

/** 一条命中 → 证据条目。**docId / docTitle / scoreKind / confidence / requestId 一个都不能少**。 */
function toEvidenceItem(hit, resp, query) {
  const text = String(hit?.text ?? '');
  const clipped = charLen(text) > EVIDENCE_TEXT_LIMIT;
  return {
    docId: hit?.docId ?? null,
    docTitle: hit?.docTitle ?? null,
    chunkId: hit?.chunkId ?? null,
    text: clipped ? [...text].slice(0, EVIDENCE_TEXT_LIMIT).join('') : text,
    text_truncated: clipped,
    text_chars: charLen(text),
    score: hit?.score ?? null,
    scoreNorm: hit?.scoreNorm ?? null,
    // 响应级字段必须**逐条带上**：证据被单独引用时才解释得清「这次依据可不可信」
    scoreKind: resp?.scoreKind ?? null,
    confidence: resp?.confidence ?? null,
    requestId: resp?.requestId ?? null,
    collection: resp?.collection ?? null,
    found_by_query: query,
    order_is_meaningful: resp?.order_is_meaningful ?? null,
  };
}

/* ─────────────────────────── 状态 → 话术 ─────────────────────────── */

const STATUS_NOTE = {
  found: '取到了知识库依据。结论只允许引用下面 evidence 里的内容，'
       + '并且必须原样带上 docId / docTitle 与 requestId（requestId 是服务端每次现生成的审计凭据，'
       + '源数据里不存在，所以它能证明这次结论确实来自知识库）。',
  none: '查询词全部来自判定引擎实际命中的表述，且全部检索成功、全部零命中 —— '
      + '这可以说成「知识库里查不到这些表述对应的条目」。'
      + '但它**不等于这条文案合规**：它只说明规则库没有覆盖，照样必须转人工。',
  probe_empty: '⚠️ 这次零命中，但**查询词不全是引擎标出来的表述**（'
             + '引擎这次一条规则都没命中，或者它标出的表述不够用、我拿从文案里试出来的词补齐了），'
             + '而它们全部零命中。**这不能读成「知识库里没有」** —— 试探词没试到，只说明我没找到入口。'
             + '照实说「我没取到依据」，不要说「库里没有」。',
  partial: '⚠️ **部分查询没查成**（网络/配额/服务端错误）。没查成的那部分**不是「没有命中」**，'
         + '所以既不能说「库里没有」，也不能把成功的那些当成全部依据。必须把「有几条没查成」说出来。',
  untested: '⚠️ **一次都没查成** —— 这是「未测」，不是「未命中」，更不是「库里没有」。'
          + '**此时不得给出任何基于知识库的合规结论**，必须明说这次没取到依据，并给出失败原因。',
  disabled: '⚠️ 知识库接入已被开关关掉（SHOUHENG_KB_ENABLED=0）。本次没有任何知识库依据，'
          + '**不得**把本地目录副本或模型常识当作依据顶上，照实说明「本次未接知识库」。',
};

function buildGate(status, basis) {
  const evidenceUsable = status === 'found';
  return {
    evidence_usable: evidenceUsable,
    // 只有「引擎命中的表述 + 全部查成 + 全部为零」才敢说库里没有
    may_assert_kb_absence: status === 'none' && basis === 'engine_matched',
    must_disclose_failure: status === 'untested' || status === 'partial' || status === 'disabled',
    must_disclose_probe: basis === 'probe',
    allow: evidenceUsable
      ? '可以引用 evidence 里的 docId / docTitle / 正文片段，且必须带上该条的 requestId 与 scoreKind。'
      : '结论只能用判定引擎自己的输出（disposition / rules_hit / 命中的原文位置）；'
        + '凡是涉及「知识库怎么说」的话，一律只能照 status 的话术说。',
    forbid: [
      '不得把「没查成」说成「库里没有」（那会产出一个假阴性的合规结论）。',
      '不得用模型常识、飞书 Base（源数据层）、或工作区里的历史副本代替知识库依据。',
      '不得宣称某条判定「已通过」「合规」—— 判定只补证据，不替人过门。',
      ...(status === 'probe_empty' || (status === 'none' && basis !== 'engine_matched')
        ? ['试探词没命中，**不得**说成「知识库里没有这条规则」。'] : []),
    ],
  };
}

/* ─────────────────────────── 主流程 ─────────────────────────── */

/**
 * 按 `pickKeyPhrases` 选出的查询词，逐个去知识库取证据。
 *
 * @param {string} text         待判文案（逐字原文）
 * @param {object} judgeResult  judge.py 的判定结果
 * @param {object} [opts]
 * @param {boolean}[opts.enabled] 知识库开关（默认读 config.kb.enabled，由调用方传入）
 * @returns {Promise<object>} 证据链结果，直接塞进 judge_copy 的返回值
 */
export async function gatherEvidence(text, judgeResult, { enabled = true } = {}) {
  const picked = pickKeyPhrases(text, judgeResult, { max: MAX_WORDING_QUERIES });
  const reqs = evidenceRequirements(judgeResult);

  const base = {
    basis: picked.basis,
    query_basis_note: {
      engine_matched: '查询词全部来自判定引擎实际命中的表述。',
      mixed: '查询词里有一部分来自引擎命中，另一部分是从文案里试出来的。',
      probe: '判定引擎一条规则都没命中，查询词全部是从文案里试出来的。',
    }[picked.basis],
    queries: [],
    evidence: [],
    evidence_total: 0,
    evidence_capped: false,
    dropped_short_queries: picked.dropped_short,
    evidence_required_by_rules: reqs,
    // 进来时的**上次服务端回报**（可能很旧，看 asOf）。不是本地计数。
    quota_before: kb.quotaState(),
  };

  if (!enabled) {
    return {
      ...base,
      status: 'disabled',
      notice: STATUS_NOTE.disabled,
      conclusion_gate: buildGate('disabled', picked.basis),
    };
  }

  if (!picked.queries.length) {
    // 一个查询词都拼不出来（空文案 / 全是虚词）。这同样是「未取到依据」，不是「没有」。
    return {
      ...base,
      status: 'untested',
      notice: '没能从这段文案里拼出任何 ≥3 个字符的查询词（trigram 索引的硬要求），'
            + '所以本次**一次检索都没发出**。这是「未测」，不是「库里没有」。',
      conclusion_gate: buildGate('untested', picked.basis),
    };
  }

  // ── 第一轮：措辞表达库（判「能不能这么说」的主库）
  const failed = [];
  let okQueries = 0;
  for (const q of picked.queries) {
    try {
      // 同一进程内 retrieve 有 memo：重复表述不会再花一次配额
      //
      // ★ `maxHits` 显式传等于 `EVIDENCE_TOPK`（2026-09-30 加）。理由：
      //   `kb_client` 新加的「回给几条」上限默认 10，那个数是为**群聊上下文**定的；
      //   而这条路是**证据链**，它要的就是 `EVIDENCE_TOPK` 那么多条，一条都不该被剪 ——
      //   剪了不会报错，只会让证据链**静默变薄**（§2.4.1 那个形状）。
      //   显式写出来是让「把 EVIDENCE_TOPK 调大」的人**看得见**这层关系：
      //   不写的话，调到 20 也只拿到 10 条，而盘上没有任何东西会红。
      const r = await kb.retrieve(kb.COLLECTIONS.wording, q.phrase,
                                  { topK: EVIDENCE_TOPK, maxHits: EVIDENCE_TOPK });
      okQueries += 1;
      base.queries.push({
        query: q.phrase, source: q.source, rule_key: q.rule_key,
        collection: r.collection, ok: true,
        hitCount: r.hitCount, totalCandidates: r.totalCandidates,
        uniqueDocCount: r.uniqueDocCount,
        scoreKind: r.scoreKind, confidence: r.confidence, requestId: r.requestId,
        from_memo: !!r.from_memo,
        query_hint: r.query_hint,
        ranking_caveat: r.ranking_caveat,
      });
      for (const h of r.hits) base.evidence.push(toEvidenceItem(h, r, q.phrase));
    } catch (e) {
      failed.push({ query: q.phrase, error: e.message, code: e.code ?? null });
      base.queries.push({
        query: q.phrase, source: q.source, rule_key: q.rule_key,
        ok: false, error: e.message, code: e.code ?? null,
      });
    }
  }

  // ── 第二轮：核回执引用的条款还在不在对端库里（最多 2 次）
  //
  // ★ 这里**不用广告文案里的表述去查外部标准库**。实测过，那是错的：
  //   `q=cure` / `q=cure mastitis` 打 1_外部标准库 都是 0 命中 —— 因为那 375 条的正文是
  //   **资料登记元数据**（书名 / 飞书链接 / 法域），词表跟英文广告措辞没有交集。
  //   那样查出来的 0 命中**什么也证明不了**，却很容易被读成「外部标准里没有」。
  //
  //   正确的入口是回执自己带着的那一跳（T4：回执 → 条款 → 原文）：
  //   `receipt.evidence_ref[] = {库名, 条目ID, 条文号, 链接, 指纹, origin}`。
  //   用其中的 `条文号`（实测形如 `E-1.320`）去查，命中的就是那一条本身。
  //   于是我们做的是一件**有答案可对**的事：**回执引用的那条，对端库里在不在。**
  const externalRefs = Array.isArray(judgeResult?.receipt?.evidence_ref)
    ? judgeResult.receipt.evidence_ref : [];
  if (externalRefs.length) {
    base.external_refs = externalRefs;
    base.external_ref_check = [];
    for (const ref of externalRefs.slice(0, MAX_STANDARD_QUERIES)) {
      const clauseNo = normalizePhrase(ref?.条文号) ?? normalizePhrase(ref?.条目ID);
      if (!clauseNo || charLen(clauseNo) < MIN_QUERY_CHARS) {
        base.external_ref_check.push({
          clause_no: ref?.条文号 ?? null, entry_id: ref?.条目ID ?? null,
          ok: false, status: 'skipped', reason: '条文号不足 3 个字符，没法用 trigram 索引去核',
        });
        continue;
      }
      try {
        const r = await kb.retrieve(kb.COLLECTIONS.standard, clauseNo, { topK: 3 });
        okQueries += 1;
        base.queries.push({
          query: clauseNo, source: 'external_ref_check', rule_key: null,
          collection: r.collection, ok: true,
          hitCount: r.hitCount, totalCandidates: r.totalCandidates,
          scoreKind: r.scoreKind, confidence: r.confidence, requestId: r.requestId,
        });
        const hit = r.hits.find((h) => String(h?.text ?? '').includes(clauseNo)) ?? null;
        base.external_ref_check.push({
          clause_no: clauseNo,
          entry_id: ref?.条目ID ?? null,
          link: ref?.链接 ?? null,
          ok: !!hit,
          status: hit ? 'present' : (r.hitCount ? 'not_confirmed' : 'absent'),
          requestId: r.requestId,
          hitCount: r.hitCount,
        });
        if (hit) base.evidence.push(toEvidenceItem(hit, r, `外部标准 ${clauseNo}`));
      } catch (e) {
        failed.push({ query: clauseNo, error: e.message, code: e.code ?? null,
                      collection: kb.COLLECTIONS.standard });
        base.external_ref_check.push({
          clause_no: clauseNo, entry_id: ref?.条目ID ?? null,
          ok: false, status: 'untested', error: e.message, code: e.code ?? null,
        });
        base.queries.push({
          query: clauseNo, source: 'external_ref_check', rule_key: null,
          collection: kb.COLLECTIONS.standard, ok: false, error: e.message, code: e.code ?? null,
        });
      }
    }
    base.standard_note =
      '外部标准库的正文是**资料登记元数据**（书名 / 飞书链接 / 法域），**不是条款判定条件** —— '
      + '核对结果只能说明「回执引用的那一条在对端库里在不在」，不能用来当判定依据引用。'
      + '`status` 为 not_confirmed 时，是「检索命中了别的条目但没看到这一条」，也不是「不存在」。';
  } else if (reqs.length) {
    // 规则声称需要证据，但回执里没有 evidence_ref —— 这本身是要说出去的一件事。
    base.external_ref_check = null;
    base.standard_note =
      `命中的规则声明了需要外部证据（${reqs.join(' / ')}），但本次回执里没有 evidence_ref[]，`
      + '所以「依据《外部标准库》第几条」这一跳**这次核不了**。'
      + '照实说「没拿到可核的条款地址」，不要说成「没有依据」。';
  }

  // ── 去重 + 每文档限量 + 截断
  //
  // ★ 为什么要按 docId 限量：实测 `q=cure&topK=5` 的 5 个分片**全部来自同一个文档**
  //   （cg-r-b10ee2b8361c8a3d）。不限量的话，5 次查询取回的 23 个分片里
  //   会有一大半是同一两条规则的不同分片，模型很容易把它读成「命中了很多条规则」。
  //   这正是服务端 contract 里 `chunk_note` 要提醒的那件事，所以在客户端**硬做掉**。
  const seenChunk = new Set();
  const perDoc = new Map();
  const deduped = [];
  for (const e of base.evidence) {
    const k = e.chunkId ?? `${e.docId}#${e.text.slice(0, 40)}`;
    if (seenChunk.has(k)) continue;
    seenChunk.add(k);
    const n = perDoc.get(e.docId) ?? 0;
    if (n >= MAX_CHUNKS_PER_DOC) continue;
    perDoc.set(e.docId, n + 1);
    deduped.push(e);
  }
  base.evidence_total = deduped.length;
  base.unique_doc_count = perDoc.size;
  base.evidence = deduped.slice(0, MAX_EVIDENCE_ITEMS);
  base.evidence_capped = deduped.length > base.evidence.length;
  base.doc_id_note =
    `evidence 里的 ${base.evidence.length} 条来自 ${perDoc.size} 个不同文档（docId）。`
    + '同一个 docId 出现多次是**同一条规则的不同分片**，不是多条规则。';
  if (base.evidence_capped) {
    base.evidence_cap_note = `本次取回 ${deduped.length} 个不同分片，只放进上下文 ${base.evidence.length} 个。`
      + '没放进来的那些这次没看到 —— **不要**把它们当成「不存在」。';
  }
  base.failures = failed;
  // ★ 本次检索响应带回的服务端真值（request() 已 absorbQuota）。
  //   这才是「余额」，且**只有走到这一行**才有 —— 早退路径（disabled / untested）
  //   不会伪造一个 quota_after，只留 quota_before 说明「进来时是什么样」。
  base.quota_after = kb.quotaState();

  // ── 定状态
  //
  // ★ `none` 是**最窄**的那一档，故意收得很紧：只有「查询词全部来自引擎命中的表述」
  //   才允许说「知识库里查不到」。「引擎没命中、靠试探词去查」是另一档
  //   （probe_empty），因为它证明不了任何缺席 —— 试探词本来就可能试错。
  let status;
  if (base.evidence.length) status = 'found';
  else if (okQueries === 0) status = 'untested';
  else if (failed.length) status = 'partial';
  else status = picked.basis === 'engine_matched' ? 'none' : 'probe_empty';

  return {
    ...base,
    status,
    notice: STATUS_NOTE[status],
    conclusion_gate: buildGate(status, picked.basis),
  };
}

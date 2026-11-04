/**
 * merged_record.mjs —— 「这一单到底报了什么」的**逐条结构化记录**（唯一生产者）。
 *
 * ## 为什么必须有它（Owner 2026-10-19 裁定「1→2→3 全做」的第 1 步）
 *
 * Owner 的要求是两个动作**同时**成立：
 *   ① 卡上去掉「—— 无库内依据 · 建议转人工」这类字眼；
 *   ② 但他问的时候，「**是模型侧还是知识库侧的问题**」仍然要答得出来。
 *
 *   而实测（`PMO/shouheng-state/merged-reports/`）：那 362 个文件**全是 `.md`，一个 json 都没有**。
 *   `source` / `basis_missing` / `extB.kind` 这些字段**只活在内存里**，跑完就没了。
 *   日志里只剩一行**整单**汇总（`[agent] ⚖ 双轨… 仅模型侧 2 条`）——
 *   那是「这一单 2 条都来自模型侧」，**不是**「第 1 条来自哪一侧」。
 *
 *   ⇒ 先落盘（本模块），再摘字眼（`dual_track.renderMergedItem` 的 `origin`）。
 *     顺序反了就是**用改版式换掉了可回答性**。
 *
 * ## 三条硬口径
 *
 *   1. **不重算** —— 来源侧、回源能力、截断真相**全部来自 `renderMergedItem` 的 `onMeta`**。
 *      在这层再判一次「这条有没有依据」就是**第二个产者**（本仓已因「同一件事两个产者」返工过多次，
 *      最近一次是 `body.length` / `strip()` / `countChars` 三套数法）。
 *   2. **全文照收** —— `reason` / `advice` 收**未截断的全文**。卡面那 50/30 字是**版式**，
 *      不是内容；记录这一层要是也存截断版，那「全文在哪」就真的没有答案了。
 *   3. **null 就是 null** —— 取不到就写 `null`，不写 `''`、不写「未提供」。空串会被读成
 *      「查了，是空的」，而 `null` 才是「这一格本来就没有」。
 *
 * ## 与「不编」的关系
 *
 *   本记录**不产生任何新判断**，只搬已经算出来的读数。所以它不需要 URL、不联网、不读库，
 *   纯函数 —— 可以离线自证（`merged_record.test.mjs`）。
 */

export const RECORD_SCHEMA = 'shouheng-merged-record/1';

/** 把 `f.source` 翻成业务能读的那一侧（**只在记录里用**，卡面仍然不许出现这两个词）。 */
const SIDE_OF = Object.freeze({
  kb: 'knowledge-base',
  model: 'model',
  both: 'both',
  'both-conflict': 'both-conflict',
});

/**
 * 逐条记录。
 *
 * @param {object} a
 * @param {Array}  a.items        `mergeFindings()` 的产物（**与渲染同一批**，不是另一份）
 * @param {Array}  a.itemsMeta    `renderMerged()` 交回来的逐条元数据（来源侧/截断真相）
 * @param {string} a.state        合并态（四态：PASS/PASS+SUGGEST/REVIEW/BLOCK；另加拒答 NEEDS_INPUT）
 * @param {string} a.line         结论行（PRD §5.3 逐字）
 * @param {number} a.total        卡内条目数
 * @param {object} [a.kb]         库侧读数（state/issueCount/coverageGap…）
 * @param {object} [a.model]      模型侧读数
 * @param {string} [a.question]   送审原文
 * @param {string} [a.contentId]  内容 ID
 * @param {string} [a.at]         时刻（调用方给的，不在这里取系统时间）
 * @param {string[]} [a.cardConformance] 出厂闸的违规清单（空 = 合规）
 * @param {boolean} [a.hasReport] 这一单有没有报告（决定截断指针是否可信）
 * @returns {object} 可 `JSON.stringify` 的记录
 */
export function buildMergedRecord({
  items = [], itemsMeta = [], state = null, line = null, total = null,
  kb = null, model = null, question = '', contentId = '', at = '',
  cardConformance = [], hasReport = false,
} = {}) {
  const list = Array.isArray(items) ? items : [];
  const meta = Array.isArray(itemsMeta) ? itemsMeta : [];
  // 渲染会过滤候选条目；元数据里的 display index 因此不一定等于源条目序号。
  // 先按 source_index 对齐，兼容旧记录/测试夹具里的 index。
  const byIndex = new Map(meta.map((m) => [
    Number.isInteger(m.source_index) ? m.source_index : m.index, m,
  ]));

  const rows = list.map((f, i) => {
    const m = byIndex.get(i) ?? {};
    const src = f?.source ?? m.source ?? null;
    // ★★ 2026-10-22：**判定主体（图片安全审查 skill）判出的条目要能单独数出来。**
    //   它们按模型侧形状进合并（`source='model'`，合并语义不变），但**不是**
    //   `model_side.mjs` 那一遍的产物 —— 记录里混成一体，下一轮就答不出
    //   「这 5 条是模型侧写的，还是 skill 判的」。
    const isSkill = f?.origin_track === 'skill';
    // 依据「怎么来的」：登记的美国外部标准（registry）/ 模型自写可核 URL（model-url）/
    // 域外被挡下（non-us）/ 什么都没有（none）。`kind` 由 `ext_basis` 判，不在这层判。
    const kind = m.basis_kind
      ?? (isSkill ? 'skill_report'
        : (f?.model?.source || f?.model?.source_url ? 'cited' : (src === 'model' ? 'none' : null)));
    return {
      index: i + 1,
      id: `F-${String(i + 1).padStart(2, '0')}`,
      displayed: !!m.index || m.index === 0,
      omitted_reason: (m.index === 0 || m.index) ? null
        : ((f?.model?.basis_missing || f?.basis_missing)
          ? '缺少可核依据或素材原文锚点，未进入卡片/问题清单' : '渲染时未进入卡片/问题清单'),
      // ── 这一条**是谁报的**（摘掉卡面标记之后，答案就在这三行里）──────────────
      source: src,                     // kb | model | both | both-conflict
      side: isSkill ? 'skill' : (src ? (SIDE_OF[src] ?? src) : null),
      // ── 这一条**回不回得了源** ────────────────────────────────────────────
      basis_kind: kind,                // registry | model-url | non-us | none | cited | null
      basis_cited: m.basis_cited ?? null,
      basis_missing: m.basis_missing ?? null,
      basis_card: m.basis_card ?? null,  // 卡上印的那一格（最小坐标 + 链接）
      // ── 内容：**全文**（卡面 50/30 字的压缩只影响版式，不影响这里）────────────
      tax_label: m.tax_label ?? null,
      location: m.location ?? f?.location ?? null,
      description: f?.description ?? null,
      reason: f?.reason ?? m.reason_full ?? null,
      advice: (typeof f?.advice === 'string' && f.advice.trim())
        || f?.suggestion || f?.model?.suggestion || f?.kb?.suggestionLine || null,
      excerpt: f?.excerpt ?? null,
      severity: f?.severity ?? null,
      priority: f?.priority ?? f?.priority_tier ?? null,
      // ── 截断真相：卡上有没有被切、切到多少、原文多少 ──────────────────────
      truncated: {
        reason: m.reason_truncated === true,
        advice: m.advice_truncated === true,
        reason_full_chars: m.reason_full_chars ?? null,
        reason_shown_chars: m.reason_shown_chars ?? null,
        advice_full_chars: m.advice_full_chars ?? null,
        advice_shown_chars: m.advice_shown_chars ?? null,
      },
      // ── 库侧坐标（能回源的那几格；没有就 null）─────────────────────────────
      kb: (f?.kb && typeof f.kb === 'object') ? {
        article_no: f.kb.article_no ?? null,
        anchor: f.kb.anchor ?? null,
        entry_url: f.kb.entry_url ?? null,
        basis_line: f.kb.basisLine ?? f?.basisLine ?? null,
      } : null,
      // 摘掉卡面标记之前它在卡上印的是什么 —— **留痕**，免得以后没人知道当时为什么这么写
      card_origin_label: m.origin ?? null,
    };
  });

  const sides = rows.reduce((acc, r) => {
    const k = r.side ?? 'unknown';
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});

  return {
    schema: RECORD_SCHEMA,
    at: at || null,
    content_id: contentId || null,
    state,
    line,
    total: Number.isFinite(total) ? total : rows.length,
    // 「几处」的分侧口径 —— **整单层面**（日志里那行就靠它），逐条层面看 `items[].side`
    sides,
    has_report: hasReport === true,
    // 出厂闸读数：空数组 = 这张卡四条口径全合规
    card_conformance: Array.isArray(cardConformance) ? cardConformance : [],
    kb: kb ? {
      state: kb.state ?? null,
      issue_count: Number.isFinite(kb.issueCount) ? kb.issueCount : null,
      candidate_count: Number.isFinite(kb.candidateCount) ? kb.candidateCount : null,
      coverage_gap: !!kb.coverageGap,
    } : null,
    model: model ? {
      count: Array.isArray(model.findings) ? model.findings.length : null,
      ok: model.ok ?? null,
      error: model.error ?? null,
      // 保存的是模型输出与解析审计，不包含送审原图、请求参数或凭据。
      raw: typeof model.raw === 'string' ? model.raw : null,
      audit: model.audit ? structuredClone(model.audit) : null,
    } : null,
    // ⚠️ 送审原文可能很长（长文案整篇）—— 记录里**照样收**：
    //   它是「这一条是对着哪段字判的」的唯一锚点，砍了以后就回不了源。
    question: question || null,
    items: rows,
  };
}

export default { RECORD_SCHEMA, buildMergedRecord };

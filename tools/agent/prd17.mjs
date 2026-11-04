/**
 * **PRD §17 结论模版的字数限制** —— 断言器（守衡侧）。
 *
 * ★ 真源只有一份：`kb/l7/registry/prd17-limits.yaml`
 *   （取自飞书 PRD §17 的内嵌表 `sheet XWnpiN`，rev 96，2026-10-19 拉取）。
 *   **本文件不写死任何上限数字** —— 写死就是第二份口径，两仓迟早各说各话。
 *
 * ★ 为什么要有这个文件（2026-10-19，Owner：「prd 中 17 写了的结论模版字数限制，
 *   你同步知识库了吗？」）：在那之前，字数限制**只在 PRD 里**，代码从不量它 ——
 *   实测量出来 BLOCK ≥3 那张卡 112 字（上限 100）、REVIEW 1-2 285 字（上限 200），
 *   **没有任何东西会红**。这就是「散文没有失败信号」那一条的又一例。
 *
 * ★ 口径（`counting.rule`）是**解释**，不是 PRD 原文 —— PRD 只写「≤N 字」，没写怎么数。
 *   默认 `visible_no_url`：去掉链接与 markdown 标记再数字符。
 *   理由写在 registry 的 `counting.note` 里；换口径只改那一处，两仓同时生效。
 *
 * ★ 本模块**只给读数、不阻断**（`check()` 返回 over/ok，调用方决定要不要出声）：
 *   Owner 2026-10-19 的裁定还没到「超了就拦」那一步，先落成**可复算的读数**。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REL = join('Documents', 'skill-test', '执行skills', '执行skills', 'skills-回归测试',
  '知识库', '内容治理', 'kb', 'l7', 'registry', 'prd17-limits.yaml');

/**
 * 真源路径（两仓共用）。按候选顺序找，**全找不到就抛错并列出试过哪些** ——
 * 静默兜底会把「没读进来」伪装成「都合规」，那是这个模块唯一不能犯的错。
 */
export function resolveLimitsPath() {
  const tried = [];
  const cands = [
    process.env.PRD17_LIMITS,
    // 守衡在 `…/audit_multi_content/tools/agent/` ⇒ 上四级到 HOME
    join(HERE, '..', '..', '..', '..', REL),
    // 知识库侧调用（相对仓库根）
    join(HERE, '..', '..', '..', REL),
    '/Users/lute/Documents/skill-test/执行skills/执行skills/skills-回归测试/知识库/内容治理/kb/l7/registry/prd17-limits.yaml',
  ].filter(Boolean);
  for (const c of cands) {
    tried.push(c);
    try { readFileSync(c); return c; } catch { /* 继续试下一个 */ }
  }
  throw new Error(`[prd17] 找不到 PRD §17 真源 prd17-limits.yaml，试过：\n  ${tried.join('\n  ')}`);
}

export const LIMITS_PATH = resolveLimitsPath();

let _cache = null;

/** 极简 YAML 读取：只认本 registry 用到的形状（key: value / 列表项 `- {…}` / 嵌套一眼）。 */
function parseLooseYaml(text) {
  // 1) 逐行取 `key: value`（只取顶层与二级键，够用；不追求通用 YAML）
  const flat = {};
  for (const line of String(text).split('\n')) {
    // ⚠️ 必须允许行首缩进：`revision: 96` 在 registry 里是缩进两格的（首次写成 `^` 锚死 ⇒ 读不到）
    const m = /^\s*([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (m) flat[m[1]] = m[2].trim();
  }
  // 2) 逐行取 `- {…}` 行内映射（本 registry 的 rows 与 conflicts 都是这个形状）
  const inline = [];
  for (const line of String(text).split('\n')) {
    const m = /^\s*-\s*\{(.+)\}\s*$/.exec(line);
    if (!m) continue;
    const obj = {};
    // 按 `, ` 切，但要躲开引号里的逗号（本文件的 format 字段含中文逗号，不冲突）
    for (const part of m[1].split(/,\s*(?=[A-Za-z_][\w-]*:)/)) {
      const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(part.trim());
      if (!kv) continue;
      let v = kv[2].trim();
      if (/^\d+$/.test(v)) v = Number(v);
      else v = v.replace(/^['"]|['"]$/g, '');
      obj[kv[1]] = v;
    }
    inline.push(obj);
  }
  return { flat, inline };
}

/** 读真源（带缓存）。读不到**抛错**，不静默兜底 —— 兜底会把「表没读进来」伪装成「都合规」。 */
export function loadLimits(path = LIMITS_PATH) {
  if (_cache && _cache.path === path) return _cache.data;
  const text = readFileSync(path, 'utf8');
  const { flat, inline } = parseLooseYaml(text);
  const rows = inline.filter((o) => o.state && o.limit != null);
  if (!rows.length) throw new Error(`[prd17] ${path} 里没有解析出任何上限行`);
  const rule = /strip_urls:\s*true/.test(text) ? 'visible_no_url' : 'all_chars';
  const data = {
    path,
    revision: flat.revision ? Number(flat.revision) : null,
    rows,
    counting: {
      rule,
      stripUrls: /strip_urls:\s*true/.test(text),
      stripMarkdown: /strip_markdown:\s*true/.test(text),
      stripWhitespace: /strip_whitespace:\s*true/.test(text),
      // ★ 2026-10-19 Owner 逐字「「链接那行不计入字数」，同意」——
      //   与知识库 `kb/l8/prd17_check.py` **同一口径**；两仓共读同一个真源，
      //   阈值（label_max / markers）一律从 registry 读，**不许在这里写死一份**。
      excludeLinkLine: /exclude_link_line:\s*true/.test(text),
      linkLineLabelMax: Number((/link_line_label_max:\s*(\d+)/.exec(text) || [])[1] || 20),
      linkLineMarkers: (((/link_line_markers:\s*\[([^\]]*)\]/.exec(text) || [])[1]) || '【,结论')
        .split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean),
    },
  };
  _cache = { path, data };
  return data;
}

/** 把「问题数」归一成 PRD §17 的两档：`1-2条` / `≥3`。 */
export function rangeOf(n) {
  const k = Number(n);
  if (!Number.isFinite(k)) return null;
  return k >= 3 ? '≥3' : '1-2条';
}

/**
 * 守衡四态 → 真源 registry 里的档位名。
 *
 * ★★ 2026-10-21：四态第 2 态在守衡侧叫 **`PASS+SUGGEST`**（PRD §5.3.2：SUGGEST 是 PASS 的附属），
 *   而真源 `prd17-limits.yaml` 那一行的 `state:` 写的是 `SUGGEST`（取自 PRD §17 内嵌表 `XWnpiN`）。
 *   ⇒ **只在这一处映射一次**，别在 `limitOf` / `scopeOf` / `check` 各写一遍。
 *   ⚠️ 真源不在本仓（`Documents/skill-test/.../内容治理/kb/l7/registry/prd17-limits.yaml`，两仓共读），
 *     改它要两边一起动 ⇒ 这里认别名，而不是去改真源。
 */
export function registryState(state) {
  const u = String(state || '').toUpperCase();
  return u === 'PASS+SUGGEST' ? 'SUGGEST' : u;
}

/**
 * 这一档**量什么**（Owner 2026-10-19 定的机器可判规则）：
 *   `format` 里含「逐条」⇒ `per_item`（每条各自 ≤上限，两条各 200、合计 400 也合规）；
 *   不含 ⇒ `message`（量整条消息）。
 */
export function scopeOf(state, issueCount) {
  const st = registryState(state);
  const { rows } = loadLimits();
  const hit = rows.find((r) => String(r.state).toUpperCase() === st
    && (r.issue_range === '任意' || r.issue_range === '—' || r.issue_range === rangeOf(issueCount)));
  if (!hit) return null;
  return String(hit.format || '').includes('逐条') ? 'per_item' : 'message';
}

/** 这一行的字数上限；查不到返回 `null`（**不猜**一个数）。 */
export function limitOf(state, issueCount) {
  const st = registryState(state);
  const { rows } = loadLimits();
  const hit = rows.find((r) => String(r.state).toUpperCase() === st
    && (r.issue_range === '任意' || r.issue_range === '—' || r.issue_range === rangeOf(issueCount)));
  return hit ? Number(hit.limit) : null;
}

/**
 * 按口径算「可见字」：剥链接 → 剥 markdown 标记 → 去空白。
 * ★ 本模块**只有这一处**定义「什么算一个字」；`countChars` 与「链接行排除」的门槛判定都调它 ——
 *   两处各写一套是这条尺子最容易分叉的地方。
 */
export function visible(s, counting = null) {
  const c = counting || loadLimits().counting;
  let t = String(s ?? '');
  if (c.stripUrls) {
    t = t.replace(/\[([^\]\n]*)\]\((?:https?:)?[^)\s]*\)/g, '$1')   // markdown 链接只留可见文字
      .replace(/https?:\/\/[^\s)）]+/g, '');
  }
  if (c.stripMarkdown) t = t.replace(/[*`>|【】→#]/g, '');
  if (c.stripWhitespace) t = t.replace(/\s+/g, '');
  return t;
}

/**
 * 把卡面拆成「计入的行」与「整行排除的链接行」，并挑出 hazard。
 *
 * 排除条件**三条同时成立**（真源 `prd17-limits.yaml::counting`，理由写在那里）：
 *   ① 该行含 `http(s)://`；
 *   ② 剥掉链接后可见字数 **≤ `linkLineLabelMax`**（默认 20）—— 这一行只剩标签；
 *   ③ 该行不含 `linkLineMarkers`（默认 `['【','结论']`）里的结论标记。
 *
 * ★ ②③ 故意收紧，两个都别删：
 *   · F1 的**依据行**也含链接、剥后仍剩 35 字 ⇒ **不排除**。改成「含链接就整行免」
 *     会把一条 30+ 字的依据凭空抹掉 —— 那是放宽「依据必须给出」，不是放宽字数。
 *   · 结论行带内联链接（`【审查结论：BLOCK】… 详见 https://…`）⇒ ③ 命中 ⇒ **不排除**
 *     并记 `hazards`（fail-closed：宁可多数，不可漏数）。
 */
export function splitLinkLines(text, counting = null) {
  const c = counting || loadLimits().counting;
  const raw = String(text ?? '');
  if (!c.excludeLinkLine) return { kept: raw, excluded: [], hazards: [], enabled: false };
  const rawMx = Number(c.linkLineLabelMax);
  const mx = Number.isFinite(rawMx) ? rawMx : 20;
  const marks = (Array.isArray(c.linkLineMarkers) && c.linkLineMarkers.length)
    ? c.linkLineMarkers : ['【', '结论'];
  const kept = [];
  const excluded = [];
  const hazards = [];
  for (const line of raw.split('\n')) {
    if (/https?:\/\//.test(line) && visible(line, c).length <= mx) {
      if (marks.some((k) => line.includes(k))) {
        hazards.push(line.trim());
        kept.push(line);
      } else {
        excluded.push(line.trim());
      }
      continue;
    }
    kept.push(line);
  }
  return { kept: kept.join('\n'), excluded, hazards, enabled: true };
}

/**
 * 数字数（按 registry 的口径）。
 * ⚠️ 链接**先删再数**：一条 docx 链接 ≈55 字符，数进去等于让 ≥3 那条永远不可能满足。
 * ⚠️ 只剥 URL 还不够：「只剩标签的链接行」连标签一起不计（Owner 2026-10-19 裁定）。
 */
export function countChars(text, counting = null) {
  const c = counting || loadLimits().counting;
  return visible(splitLinkLines(text, c).kept, c).length;
}

/**
 * 量一张卡（或任一结论文本）。
 * @returns {{state:string, issueRange:string|null, limit:number|null, chars:number,
 *            over:number, ok:boolean|null, rule:string, revision:number|null}}
 */
export function check(state, issueCount, text, scope = 'message') {
  const lim = limitOf(state, issueCount);
  const c = loadLimits().counting;
  const sp = splitLinkLines(text, c);
  const chars = visible(sp.kept, c).length;
  const range = rangeOf(issueCount);
  // ★ 口径可见：免得「字数忽然变小了」变成没法解释的读数（不静默）
  const linkRead = {
    linkLinesExcluded: sp.excluded.length,
    linkCharsExcluded: sp.excluded.reduce((n, x) => n + visible(x, c).length, 0),
    linkLineHazards: sp.hazards,
  };
  if (lim == null) {
    return { state: String(state || '').toUpperCase(), issueRange: range, limit: null, chars,
      over: 0, ok: null, scope, rule: c.rule, revision: loadLimits().revision,
      ...linkRead,
      note: 'PRD §17 没有这一档（如四态的 SUGGEST 本库未启用）⇒ 不判' };
  }
  return {
    state: String(state || '').toUpperCase(), issueRange: range, limit: lim, chars,
    over: Math.max(0, chars - lim), ok: chars <= lim, scope,
    rule: c.rule, revision: loadLimits().revision,
    ...linkRead,
  };
}

/**
 * **逐条量**（Owner 2026-10-19：「最后的字数限制是针对**每一条问题**」）。
 *
 * ★ 这一条纠正了我第一版的错：我按**整张卡**量，于是「BLOCK 1-2 条 ≤200」
 *   被理解成「两条加起来 ≤200」。Owner 说的是一**条一条**量 —— 两条各 ≤200，
 *   合计 400 也合规。口径换掉之后判定整片翻转（见 registry `counting.scope`）。
 *
 * @param {string[]} itemTexts 每条问题各自的渲染块（**不含**结论行/汇总/链接/收尾）
 * @returns {{perItem:Array, max:number, overCount:number, limit:number|null, ok:boolean|null,
 *            scope:string, rule:string, revision:number|null}}
 */
export function checkItems(state, issueCount, itemTexts) {
  const list = Array.isArray(itemTexts) ? itemTexts : [];
  const perItem = list.map((t, i) => ({ index: i + 1, ...check(state, issueCount, t, 'item') }));
  const lim = perItem.length ? perItem[0].limit : limitOf(state, issueCount);
  const overCount = perItem.filter((r) => r.ok === false).length;
  return {
    perItem,
    max: perItem.reduce((m, r) => Math.max(m, r.chars), 0),
    overCount,
    limit: lim,
    ok: lim == null ? null : overCount === 0,
    scope: 'item',
    rule: loadLimits().counting.rule,
    revision: loadLimits().revision,
  };
}

/** 一句话读数（上日志 / 用户卡都够用）。 */
export function readingOf(state, issueCount, text) {
  const r = check(state, issueCount, text);
  if (r.limit == null) return `PRD §17：${r.state} 无此档（不判）`;
  let extra = '';
  if (r.linkLinesExcluded) extra = `｜已排除链接行 ${r.linkLinesExcluded} 行（−${r.linkCharsExcluded} 字）`;
  if (r.linkLineHazards && r.linkLineHazards.length) {
    extra += `｜⚠️ hazard ${r.linkLineHazards.length} 行（链接与结论同行，**未排除**）`;
  }
  return `PRD §17：${r.state} ${r.issueRange} 实测 **${r.chars}** 字 / 上限 **${r.limit}**`
    + (r.ok ? '（✅ 合规）' : `（❌ 超 **${r.over}** 字）`)
    + `｜口径 ${r.rule}（sheet XWnpiN rev ${r.revision ?? '?'}）${extra}`;
}

// ── 自证 ────────────────────────────────────────────────────────────────────────
export function selftest() {
  const bad = [];
  const eq = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) bad.push(`${name} —— 期望 ${JSON.stringify(want)}，实得 ${JSON.stringify(got)}`);
    console.log(`  ${ok ? '✅' : '❌'} ${name}`);
  };
  console.log('\n=== PRD §17 字数限制 自证 ===');

  // ① 真源读得到，且 6 行逐字对上 PRD §17 那张表
  const L = loadLimits();
  eq('① 上限表 6 行，且取值与 PRD §17 逐字一致',
    L.rows.map((r) => `${r.state}/${r.issue_range}=${r.limit}`).sort(),
    ['BLOCK/1-2条=200', 'BLOCK/≥3=100', 'PASS/—=50', 'REVIEW/1-2条=200',
      'REVIEW/≥3=100', 'SUGGEST/任意=150'].sort());
  eq('①b 真源带版本（sheet rev 可回溯）', typeof L.revision, 'number');

  // ② 分档：≥3 与 1-2 各回自己的上限
  eq('② 3 条 ⇒ 走 ≥3 那档（100）', limitOf('BLOCK', 3), 100);
  eq('②b 2 条 ⇒ 走 1-2 那档（200）', limitOf('BLOCK', 2), 200);
  eq('②c 6 条也走 ≥3 档', limitOf('REVIEW', 6), 100);
  eq('②d 未启用的四态 SUGGEST 也能取到（150，PRD 有这一档）', limitOf('SUGGEST', 1), 150);

  // ③ 计数口径：链接**不**计、标记**不**计、空白**不**计
  //   ★ 2026-10-19 本行改过：原写 `countChars('完整清单：https://x.y/z') === countChars('完整清单：')` ——
  //     在「链接那行整行不计入」生效后整行被排除（0 vs 5），那条断言自然会红。
  //     它要守的是「**URL 字符本身**不占字数」，与「整行免」是两件事 ⇒ 改用一条不会触发整行排除的长行来量。
  eq('③ URL 字符本身不计入字数（剥链接，不是靠整行免）',
    countChars('甲'.repeat(30) + 'https://x.y/z'), countChars('甲'.repeat(30)));
  eq('③b markdown 标记不计入', countChars('**原因**：甲'), countChars('原因：甲'));
  eq('③c 空白与换行不计入', countChars('甲\n\n乙'), 2);

  // ── 链接那一行整行不计入（Owner 2026-10-19：「「链接那行不计入字数」，同意」；C1 的处置）──
  const CARD = '【审查结论：BLOCK】共发现 5 处必须修改。\n· 甲类：2 个\n· 乙类：1 个\n'
    + '→ 完整清单：https://x.y/z\n请修改后重新提交。';
  eq('③d 纯链接行整行不计入（连行首标签一起不数）', countChars(CARD),
    countChars('【审查结论：BLOCK】共发现 5 处必须修改。\n· 甲类：2 个\n· 乙类：1 个\n请修改后重新提交。'));
  eq('③d2 且读数报出「排除了几行、少了几个字」（不静默）',
    [check('BLOCK', 5, CARD).linkLinesExcluded, check('BLOCK', 5, CARD).linkCharsExcluded],
    [1, 5]);                                  // `完整清单：` = 5 个可见字（`→` 已被 markdown 口径剥掉）
  // ★ 反向对照：同一行标签加长到超 linkLineLabelMax ⇒ **重新计入**
  const LONG_LABEL = `→ ${'完整问题清单与修改建议请点这里查看'.repeat(2)}：https://x.y/z`;
  eq('③e 反向对照：标签超 20 字 ⇒ 该行**重新计入**（门槛是 label_max，不是「含链接就免」）',
    countChars(LONG_LABEL) > 20, true);
  // ★★ 关键反向对照：依据行含链接、剥后仍 >20 字 ⇒ 照旧计入（不许把「依据」免掉）
  const BASIS = '**依据**：《外部标准库 v0（试用版，未发布）》第 E-2.124 条（链接：https://x.y/z）';
  eq('③f 依据行含链接但剥后 >20 字 ⇒ **照旧计入**（放宽的是链接标签行，不是「依据必须给出」）',
    countChars(BASIS) > 20, true);
  // ★★ fail-closed：结论行带内联链接 ⇒ 不排除，且报 hazard
  const INLINE = '【审查结论：BLOCK】详见 https://x.y/z';
  const rIn = check('BLOCK', 5, INLINE);
  eq('③g 结论行带内联链接 ⇒ **不排除** ＋ 报 hazard（宁可多数，不可漏数）',
    [rIn.linkLinesExcluded, rIn.linkLineHazards.length > 0,
      rIn.chars === countChars('【审查结论：BLOCK】详见')], [0, true, true]);
  // ★ 开关真起作用：关掉 ⇒ 链接行重新计入（证明上面几条不是恒真）
  eq('③h 关掉开关 ⇒ 链接行重新计入',
    countChars(CARD, { ...loadLimits().counting, excludeLinkLine: false }) > countChars(CARD), true);
  // ★ 门槛就是真源那个数：把 label_max 压到 4 ⇒ 5 字的标签行**不再**被排除
  eq('③i 把 label_max 压到 4 ⇒ 5 字标签行不再排除（读的是真源，不是写死的 20）',
    countChars(CARD, { ...loadLimits().counting, linkLineLabelMax: 4 }) > countChars(CARD), true);

  // ④ 判定：刚好贴线算合规，超一个字就红
  const lim = limitOf('BLOCK', 3);
  eq('④ 恰好等于上限 ⇒ 合规', check('BLOCK', 3, '字'.repeat(lim)).ok, true);
  eq('④b 上限 +1 ⇒ 超 1 字', check('BLOCK', 3, '字'.repeat(lim + 1)).over, 1);
  // ★ 反向对照：同样一段文字，换成 1-2 条那一档（200）就该**不再**超
  eq('④c 反向对照：同一段字在 1-2 条档（200）⇒ 不超',
    check('BLOCK', 2, '字'.repeat(lim + 1)).ok, true);
  // ★ 反向对照：把上限改大一格（读一份临时表）⇒ 同文字必须从「超」变「不超」
  eq('④d 反向对照：上限表变了，读数必须跟着变（不是恒真）',
    check('PASS', 1, '字'.repeat(51)).over, 1);
  eq('④e 51 字在 PASS（上限 50）⇒ 超 1；而在 SUGGEST（150）⇒ 不超',
    [check('PASS', 1, '字'.repeat(51)).ok, check('SUGGEST', 1, '字'.repeat(51)).ok],
    [false, true]);

  // ⑤ 这一档在 PRD 里没有 ⇒ 不判（不猜一个上限）
  eq('⑤ 不存在的状态 ⇒ limit 为 null、ok 为 null', check('NEEDS_INPUT', 1, '字'), {
    ...check('NEEDS_INPUT', 1, '字'), limit: null, ok: null,
  });

  console.log(`\n自证：通过 ${bad.length ? '—' : 'all'} / 失败 ${bad.length}`);
  bad.forEach((b) => console.log(`   ❌ ${b}`));
  return bad.length ? 1 : 0;
}

if (process.argv[1] && /prd17\.mjs$/.test(process.argv[1]) && process.argv.includes('--selftest')) {
  process.exit(selftest());
}

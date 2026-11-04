/**
 * dual_track.mjs —— 知识库侧 ＋ 模型侧 **双轨合并**（PRD 上游技术方案 §③④ 的落地）
 *
 * ── 这份东西从哪来 ─────────────────────────────────────────────────────
 * 方案原文（`两份内容治理技术方案-精读提炼.md` L164–211，逐字）：
 *
 *   ③知识库 ＋ 大模型 双校验 ── · 知识库规则作为上下文输入大模型，完成二次合规校验
 *   ④结果合并输出 ── · 全量输出知识库与大模型识别的所有问题，无遗漏覆盖全部风险
 *                     合并方式：**同一个问题 → 取交集 ／ 不同的问题 → 走并集**
 *
 *   对齐规则：**位置相同 ＋ 类目相同** → 视为「同一个问题」。
 *
 *   合并规则矩阵（六行，逐字照抄进下面 `mergeFindings` 的分支）：
 *     两轨都命中同一个问题，结论一致   → 取交集｜按该问题严重度计入 —— 双轨确认，置信最高
 *     两轨都命中同一个问题，结论不一致 → 交集冲突｜**降为 REVIEW**，不许任一侧单独定案
 *     只有知识库侧命中                 → 走并集｜按其严重度计入；带条款号／锚点／指纹，可回源
 *     只有模型侧命中                   → 走并集｜保留，标注**无库内依据**；倾向 REVIEW，
 *                                        **不由它单独定 BLOCK**
 *     两侧都没发现问题，且两侧都覆盖   → 取交集｜**PASS —— 这是 PASS 唯一的成立方式**
 *     任一侧没覆盖该主题（拒答）       → 交集不成立｜**拒答，不得输出 PASS**
 *
 * ── 为什么先做「合并」这一块 ─────────────────────────────────────────────
 * 它是这六条规则**唯一可离线断言**的部分：喂两张清单进去，出来的清单必须是确定的。
 * 模型侧那一遍要调 LLM（跑得慢、要花钱、结果不稳），但**合并判据不该因此变成不可测的** ——
 * 所以两侧的产出都只是数据，判定全在这个纯函数里。
 *
 * ── 边界（说清楚，别让它比输入大）────────────────────────────────────────
 * · 本模块**不判断一个 finding 是不是真的**，只做「对齐 / 去重 / 冲突裁决 / 计严重度」。
 * · 它**不产出 PASS**：`mergedState()` 里 PASS 的那一支要求 `kbCovered === true`，
 *   那是知识库侧给的读数，本模块既不猜也不放宽（方案 L209：任一侧没覆盖 → 拒答）。
 * · 「位置」是字符串。两边对同一处的写法不同（「00:12」vs「视频第 12 秒」）**对不上就是两处**——
 *   这是取舍，不是遗漏：宁可并集多留一条，也不许把两条不同的东西合成一条。
 */
import { readingOf as _prd17Reading, check as _prd17Check, scopeOf as _prd17ScopeOf,
  checkItems as _prd17Items } from './prd17.mjs';
// ★ PRD §5.3.3（逐条问题**每个字段**的字数与格式硬约束）：描述 ≤50 / 原因 ≤50 / 建议 ≤60、
//   位置必须落在三个模式内、依据必须《文档名》第 X 条或规则 ID、禁「可能」类废话。
import { readingOf as _prd533Reading, checkItem as _prd533CheckItem,
         countChars as _prd533CountChars, countAdviceChars } from './prd533.mjs';
// ★ 2026-10-19：`countAdviceChars` 由本模块**转出**（判据在 `test_agent` 里要同一把尺，
//   不许在测试里另抄一份计数规则）。
export { countAdviceChars };
import { createHash } from 'node:crypto';
import { basisText as extBasisText } from './ext_basis.mjs';
// ★ 2026-10-09：⑰j 要读 `agent.mjs` 的源文件核「接线那一行」—— 见那条判据的说明。
import { readFileSync } from 'node:fs';
// ★ 2026-10-12：判「PRD 那句有没有被粘上别的东西」用**守衡自己的**合规尺子，
//   不在本文件另抄一份正则（口径只有一处）。
import { conforms as prd53Conforms, normState as prd53StateOf, verdictLineFor } from './prd53.mjs';
import { ADVICE_MAX } from './prd533.mjs';
export { ADVICE_MAX };
import { cleanAdviceText } from './advice.mjs';
// ★ 2026-10-14（Owner：收尾动作行与 PRD §5.3.2 不符）：收件人**按问题方向算**，
//   不再是一个硬编码常量。路由真源在库里（`routing-policy.json`），本文件只读不抄。
import { loadRoutingPolicy, loadRoleHandles, reviewOwnersFor, renderReviewAction,
  dimensionForTaxonomy, priorityForTaxonomy, dimensionForModelCategory,
         loadRiskCategoryPolicy, dimensionForCategory }
  from './routing.mjs';

/**
 * 路由表与句柄表**读一次**（模块加载时），与库侧 `review_engine.py` 的 `_approvers()`
 * 同口径：**任何异常都当作没读到**，由调用方回落 —— 判据是「拿到的东西」，
 * 不是「文件在不在」。两个表都是 registry 级文件，不是逐单变化的数据；
 * 它们改了要重启守衡才生效（与改任何其它被 import 的模块一样）。
 */
const ROUTING_POLICY = loadRoutingPolicy();
// ★ 2026-10-17：维度政策件（`risk-category-policy.json`）—— 报告要按 PRD 四维度分组，
//   映射口径**只认库侧那一份**，不在守衡再抄一张表。
const RISK_CATEGORY_POLICY = loadRiskCategoryPolicy();
const ROLE_HANDLES = loadRoleHandles();

/** 严重度序（越大越重）。只认三态里的两个可裁剪值 + 空。 */
const SEV_ORDER = { BLOCK: 2, REVIEW: 1, '': 0 };

/**
 * **报告链接门槛** —— PRD §5.3.4 / §8.3 / §17 三处同口径：
 * 「问题数量 **≥3** 时才生成完整报告并返回链接」（1–2 条走逐条输出，不给链接）。
 *
 * ★ 与库侧**同名同口径**：`kb/l7/review-engine/core/feishu_publish.py::REPORT_LINK_MIN_ISSUES`。
 *   那一份还带着一次改判的留痕（2026-10-03 曾置 0，Owner 裁定「都按 PRD 来做」后**回退为 3**）。
 *   两处各写一遍就会各自漂移 —— 所以谁改都要同时改两边，并对住
 *   `dual_track.mjs --selftest` 里「≥3 才有这一行 / <3 必须没有」那一对断言。
 *
 * ★ 门槛挂的是**卡里那个数**（`renderMerged` 的 `total`），不是 `stats.merged`：
 *   实测一单里三个数各不相同（19:08 那张图：total 12 ／ 并进来 7 ／ 旁挂 5）。
 */
export const REPORT_LINK_MIN_ISSUES = 3;

/**
 * 方案 L211 的对齐键：**位置相同 ＋ 类目相同**。
 * ⚠️ **它只当 Map 的键用，谁也不许再把它拆回来**（见下面那段：拆回来丢过东西）。
 */
export const keyOf = (f) => JSON.stringify([String(f?.location ?? '').trim(),
                                            String(f?.category ?? '').trim()]);

const normSev = (s) => {
  const v = String(s ?? '').trim().toUpperCase();
  return v === 'BLOCK' ? 'BLOCK' : (v === 'REVIEW' ? 'REVIEW' : '');
};

/**
 * 两张问题清单 → 一张（方案的六行矩阵逐行实现）。
 *
 * @param {Array} kbFindings    知识库侧（每条至少 `{location, category, severity}`，
 *                              库侧还带 `article_no` / `anchor` / `source_sha256`）
 * @param {Array} modelFindings 模型侧（每条至少 `{location, category, severity, reason}`）
 * @returns {{items:Array, stats:object}}
 */
/* ═══════════ 同源判据（2026-10-08，Owner 裁定「两侧命中的逐字片段有重叠 ⇒ 算同一条」）═══ */

/**
 * 归一化 —— 与标定脚本 `kb/.work/calib_sameorigin.py` **同一口径**（NFKC + 小写 + 只留汉字/数字/字母）。
 * ★ 两处口径必须一致，否则标定出来的门限对不上线上判据。改一处就要改另一处。
 */
export const normText = (s) => String(s ?? '').normalize('NFKC').toLowerCase()
  .replace(/[^0-9a-z\u4e00-\u9fff]+/g, '');

/** 最长公共子串长度（滚动数组）。与标定同一实现。 */
export function lcsLen(a, b) {
  const A = String(a ?? ''), B = String(b ?? '');
  if (!A || !B) return 0;
  const [x, y] = A.length <= B.length ? [A, B] : [B, A];
  let prev = new Array(x.length + 1).fill(0); let best = 0;
  for (const ch of y) {
    const cur = new Array(x.length + 1).fill(0);
    for (let i = 1; i <= x.length; i += 1) {
      if (x[i - 1] === ch) { cur[i] = prev[i - 1] + 1; if (cur[i] > best) best = cur[i]; }
    }
    prev = cur;
  }
  return best;
}

/** 类目族 = 大类（`平台与促销-静音绝对化表述` ⇒ `平台与促销`）。标定里第 3 条约束用它。 */
export const catFamily = (c) => String(c ?? '').split(/[-－]/)[0].trim();

/** 两侧条目各自的「逐字命中片段」—— 同源判据比的就是它。 */
const excerptOf = (f) => normText(f?.excerpt ?? f?.matched_term ?? '');

/**
 * 两条命中的是不是**同一个问题**？—— 三条约束，缺一不可。
 *
 * ★ 判据只有「归一化后**完全相等**」，**不用 R 门限**（2026-10-08 标定后的决定）：
 *   标定（`kb/.work/calib_sameorigin.py`，阴性 n=20000 / 阳性 494 对）显示 R≥4 能收进
 *   99.6% 的阳性、阴性误并约 1% —— **但那个「阳性」样本是「库里同一表达写了多遍」，
 *   那是「库自身冗余」的代理，不是「两侧指同一处」的代理。代理弱，就不拿它当判据。**
 *   同时把 R 值**记进读数**，攒够真实双轨数据再决定要不要启用门限。
 *
 * ★ 一条结构性事实（不写下来下一个人会以为 R 覆盖了全部）：**2 字命中词**（「静音」「限时」）
 *   的 R 最大只能是 2 ⇒ 对它们 R 判据**结构上不可能成立**，只能靠相等。
 *   而实测的重复计数正是这个形状 —— 库侧与模型侧都指「静音」两个字。
 */
export function sameOrigin(a, b) {
  const ea = excerptOf(a); const eb = excerptOf(b);
  if (!ea || !eb) return { same: false, why: '一侧没有逐字命中片段（无从比）', r: 0, equal: false };
  const fa = catFamily(a?.category); const fb = catFamily(b?.category);
  const famOk = !fa || !fb || fa === fb;
  const equal = ea === eb;
  const r = lcsLen(ea, eb);
  // ══════════════════════════════════════════════════════════════════════════
  // ★★ 2026-10-14：**「有重叠」才是裁决，本函数原先只写了「完全相等」** ────────────
  // ══════════════════════════════════════════════════════════════════════════
  //   裁决原文（本文件题注，2026-10-08 Owner）：
  //     「两侧命中的**逐字片段有重叠** ⇒ 算同一条」。
  //   实现却只认 `ea === eb`，把裁决**收窄了一档**；而两侧片段的**长度天然不同**：
  //     · 库侧给的是**命中词/命中正则**（P0 快路实测：`最好`，或 `最\s*(好|佳|…)`）；
  //     · 模型侧给的是**逐字引用的原句**（实测：`m8 pro吸奶器是最好的吸奶器`）。
  //   ⇒ 两者永远不相等 ⇒ **交集在实跑里一次都没成立过**（实测：123 次双轨，
  //     `双轨确认` 与 `冲突降 REVIEW` **全为 0**，产出 100% 走并集）。
  //   ⇒ 现在按裁决的字面来：一方的片段**完整包含**另一方 ⇒ 有重叠。
  //   ⚠️ 下限 2 字：单字（「好」「大」）在中文长句里必然撞上，那不是重叠，是噪声。
  //   ⚠️ 类目族不同**不拦**（与 `equal` 同一口径）：两侧本就是两套词表，
  //      拦掉它等于把裁决重新废掉。差别由 `why` 如实说出来、并在卡上留注（`same_origin_note`）。
  const overlap = !equal && ea.length >= 2 && eb.length >= 2
    && (ea.includes(eb) || eb.includes(ea));
  // ── 精确相等 ⇒ **算同一条，且不看类目族** ─────────────────────────────────────
  //
  // ★ 这一条是**被测试逼出来的**（2026-10-08）。原设计把「类目族相同」放在前面当硬闸，
  //   而 `⑪` 那条用例用的是**真实事故的形状**：库侧大类「平台与促销」／模型侧「措辞表达」
  //   —— **两侧用的是两套不同的类目词表**（库按自己的表分组，模型按 PRD §5.3 的维度标注），
  //   于是那道闸**永远不成立** ⇒ Owner 那张卡的重复计数**根本修不了**。
  //
  //   所以：**精确相等自证同源**，不需要类目族背书。类目族只在**模糊匹配**（R 门限）时才有用
  //   —— 而模糊本次**没启用**，那道闸留在 `famOk` 里备将来。
  //   代价说清：同一个词可能被两侧当成**不同**问题（「静音」既可能是措辞绝对化、也可能是
  //   产品参数虚假）。那种情况现在会**并成一条**，靠结论里那句注（`same_origin_note`）
  //   让人看见两侧依据、自己判断 —— 而不是靠代码替人决定。
  if (equal || overlap) {
    return { same: true, r, equal, overlap,
             why: (equal
               ? `两侧逐字片段相同（「${String(a?.excerpt ?? a?.matched_term ?? '').trim()}」）`
               : `两侧逐字片段**有重叠**（库侧「${String(a?.excerpt ?? a?.matched_term ?? '').trim()}」`
                 + ` ／ 独立复核侧「${String(b?.excerpt ?? b?.matched_term ?? '').trim()}」）`)
                  + (famOk ? '' : `；类目族不同（${fa || '—'} ／ ${fb || '—'}）—— 两侧词表不同，**
以逐字片段为准**`) };
  }
  if (!famOk) {
    return { same: false, why: `类目族不同（${fa || '—'} ／ ${fb || '—'}）且逐字片段不相同`,
             r, equal };
  }
  return { same: false, why: '逐字片段不相同（门限判据本次**未启用**，见 sameOrigin 的注释）', r, equal };
}

/**
 * 同一份记录里的多条规则共用**同一个 URL** —— 依据行里只留**一条**「原始出处」。
 *
 * 病灶（Owner 2026-10-22，真单 `HD8Td5RjuouYIDxrZ2ocoshVn9Z`）：
 *   N-1.307 / N-1.312 / N-1.364 / N-1.365 四条规则都来自同一条历史记录
 *   `recvw7XIUgXEvk`，把它们逐条拼起来就是 **4 条一模一样的链接**；读者只会看见
 *   「同一份文档被列了 6 遍」。
 *   ⇒ 保留**第一条**的 `原始出处：<url>`（可点），后面的段只留「《库》第 X 条」。
 *   ⚠️ 只去**完全相同**的 URL；不同 URL 一个字都不动（它们是不同的回源入口）。
 */
export function collapseDuplicateBasisUrls(text) {
  const seen = new Set();
  return String(text ?? '').split('；').map((seg) => {
    const m = seg.match(/^(.*?)(｜原始出处[:：])(\S+)$/);
    if (!m) return seg;
    const url = m[3];
    if (seen.has(url)) return m[1].trim();
    seen.add(url);
    return seg;
  }).filter(Boolean).join('；');
}

/**
 * 「依据文档链接」收成 PRD §5.3.3 的一句话：**表格名称 + 条款号 + 一条链接**。
 *
 * 病灶（Owner 2026-10-22，真单 `merged-2026-10-22T02_49_11` 的 F-03）：
 *   同一份记录的四条规则被逐条拼开，读者看到的是一屏
 *   「《内部正负样本库…》第 N-1.307 条｜原始出处：点开核对；《内部正负样本库…》第 N-1.312 条；
 *    《内部正负样本库…》第 N-1.364 条；《内部正负样本库…》第 N-1.365 条」——
 *   表格名写了四遍、链接只有一条、条款号散在中间。
 *   ⇒ 按**表格名 + 记录链接**分组：同一份记录只出现一次表格名、条款号并成一串、
 *     链接收进 PRD 的 `（链接：…）` 括号里。
 *   ⚠️ **不同 URL 是不同回源入口**，绝不并进同一条链接下（那会把两份记录说成一份）；
 *     合并后的尾巴（`collapseDuplicateBasisUrls` 留下、后面不带链接的段）归到
 *     **同一表格名最近的那个组** —— 顺序就是它原本的顺序。
 *   ⚠️ 只认 `《库》第 X 条` 这一种形状；外部标准那条（`机构《文档》 → url`）原样放过 ——
 *     它不是条款，套进这个句式会变成一句假话。
 *   ⚠️ 条款**逐条保留**（去重、保序）：依据格要能说清「到底命中了哪几条」，
 *     这是压缩，不是删证据。
 */
export function compactBasisLine(text) {
  const s = String(text ?? '').trim();
  if (!s) return s;
  const groups = [];                       // [{ lib, url, arts: [] }] —— 保序
  const byKey = new Map();                 // `lib\u0000url` → group
  const lastByLib = new Map();             // lib → 最近一个组
  const passthrough = [];
  for (const seg of s.split('；').map((x) => x.trim()).filter(Boolean)) {
    const art = /《([^》]+)》\s*第\s*([A-Za-z0-9][A-Za-z0-9.\-]*)\s*条/.exec(seg);
    // URL 两种来路：`原始出处：https://…` 与 `[点开核对](https://…)`
    const link = /(https?:\/\/[^\s)）」』；;，。、\]]+)/.exec(seg)?.[1] ?? null;
    if (!art) { passthrough.push(seg); continue; }
    const lib = art[1];
    let g;
    if (link) {
      const key = `${lib}\u0000${link}`;
      g = byKey.get(key);
      if (!g) { g = { lib, url: link, arts: [] }; byKey.set(key, g); groups.push(g); }
    } else {
      // 不带链接的尾巴：归同一表格名**最近**那个组；没有组才新建一个无链接组
      g = lastByLib.get(lib)
        ?? (() => { const x = { lib, url: null, arts: [] }; groups.push(x); return x; })();
    }
    lastByLib.set(lib, g);
    if (!g.arts.includes(art[2])) g.arts.push(art[2]);
  }
  const compact = groups.map((g) => `《${g.lib}》第 ${g.arts.join('、')} 条`
    + (g.url ? `（链接：[点开核对](${g.url})）` : ''));
  return [...compact, ...passthrough].join('；');
}

export function mergeFindings(kbFindings = [], modelFindings = []) {
  const sides = new Map();          // key → { kb, model }
  const pushUnique = (map, f, key) => {
    const prev = map.get(key);
    // 同一侧出现两条同键的：合并展示字段并保留原始条目。
    // 真实事故：point 与 advice 分成 4 条同位置/类目记录，去重后留下 point
    //（没有建议），两条具体 KB 建议只躺在 raw 里，最终卡片因此丢了改法。
    if (prev) {
      const raw = [].concat(prev.raw ?? [prev], f);
      const parts = (x, field) => [x?.[field], x?.kb?.[field]]
        .map((s) => String(s ?? '').trim()).filter(Boolean);
      // ★★ 2026-10-22（Owner：「依据文档链接输出了 6 条一样的链接，预期是同样的问题输出一条」）：
      //   **累加器必须与展示字段分开**。旧实现把合并结果**回写**进
      //   `prev.basisLine` / `prev.kb.basisLine`，下一轮 `raw.flatMap` 又把
      //   「已经拼好的整串」当**一条输入**读回来 ⇒ 每合并一条就把前面的依据再复制一遍：
      //   4 条 findings → **7 段**（N-1.312 出现 3 次、N-1.364 出现 2 次）。
      //   `suggestionLine` 同一形状（≥3 条建议时）。
      //   ⇒ 原始串只进这 `_basisParts` / `_suggestionParts`，**永远不回读展示字段**。
      const basisParts = prev._basisParts
        ? [...prev._basisParts] : [...new Set(parts(prev, 'basisLine'))];
      const suggParts = prev._suggestionParts
        ? [...prev._suggestionParts] : [...new Set(parts(prev, 'suggestionLine'))];
      // 同一**条款号**只留第一条（同一条款从两条来路各来一次时，别印两遍）。
      // 键要带库名：两个库可以有同号的条款。
      const artKey = (s) => {
        const m = String(s).match(/《([^》]+)》\s*第\s*([A-Za-z0-9][A-Za-z0-9.\-]*)\s*条/);
        return m ? `${m[1]}|${m[2]}` : null;
      };
      for (const s of parts(f, 'basisLine')) {
        const k = artKey(s);
        if (basisParts.includes(s)) continue;
        if (k && basisParts.some((x) => artKey(x) === k)) continue;
        basisParts.push(s);
      }
      for (const s of parts(f, 'suggestionLine')) {
        if (!suggParts.includes(s)) suggParts.push(s);
      }
      prev._basisParts = basisParts;
      prev._suggestionParts = suggParts;
      prev.raw = raw;
      if (suggParts.length) {
        const mergedSuggestion = suggParts.join('；');
        prev.suggestionLine = mergedSuggestion;
        prev.kb = { ...(prev.kb ?? {}), suggestionLine: mergedSuggestion };
      }
      if (basisParts.length) {
        const mergedBasis = collapseDuplicateBasisUrls(basisParts.join('；'));
        prev.basisLine = mergedBasis;
        prev.kb = { ...(prev.kb ?? {}), basisLine: mergedBasis };
      }
      const ruleRefs = [...new Set(raw.map((x) => x?.kb?.article_no ?? x?.article_no)
        .map((x) => String(x ?? '').trim()).filter(Boolean))];
      if (ruleRefs.length) {
        prev.kb = { ...(prev.kb ?? {}), relatedArticleNos: ruleRefs };
      }
    }
    else map.set(key, f);
  };
  const kbBy = new Map(); const moBy = new Map();
  for (const f of kbFindings) pushUnique(kbBy, f, keyOf(f));

  // ── ★★ 2026-10-27：模型侧与判定主体（skill_findings）同义去重 ────────────────────
  //   病灶：图片单同时有 `model_side`（视觉模型 JSON）和 `skill_findings`（链内图片安全审查 skill）。
  //   两者常针对同一处风险写出不同位置号（如一边写 `图 1 第 2 处`，另一边写 `右侧，图 1 第 11 处`）
  //   但讲的都是同一个锚点词（如 `The Faceplant`、`D8 DeepClean Bottle Washer`）或同一个核心概念
  //   （如 `同睡面 / 共用睡面`）。优先保留带外部来源/原图观察锚点的 `model_side` 条目，避免同题双报。
  const dedupModelFindings = [];
  const anchorTokenOf = (x) => {
    const blob = `${x?.excerpt ?? ''} ${x?.description ?? ''} ${x?.reason ?? ''} ${x?.visual_anchor ?? ''}`;
    const q = [...blob.matchAll(/[「“"]([^」”"]{3,40})[」”"]/g)]
      .map((m) => normText(m[1]))
      .filter((s) => s.length >= 4 && !/^(the|and|for|momcozy)$/.test(s));
    if (/同睡面|共用睡面|同一.*睡面|共享睡面/.test(blob)) q.push('__shared_sleep_surface__');
    if (/faceplant/i.test(blob)) q.push('__faceplant__');
    if (/bottlewasher|d8deepclean/i.test(normText(blob))) q.push('__d8_bottle_washer__');
    return new Set(q);
  };
  for (const f of modelFindings) {
    const fTokens = anchorTokenOf(f);
    if (f?.origin_track === 'skill' && fTokens.size > 0) {
      const dup = dedupModelFindings.some((existing) => {
        const eTokens = anchorTokenOf(existing);
        for (const t of fTokens) if (eTokens.has(t)) return true;
        return false;
      });
      if (dup) continue;
    }
    dedupModelFindings.push(f);
  }
  for (const f of dedupModelFindings) pushUnique(moBy, f, keyOf(f));

  for (const [k, f] of kbBy) sides.set(k, { kb: f, model: null });

  // ── 先按键配对；**配不上的再走一趟同源判据**（2026-10-08）───────────────────
  //   真事故：库侧报「平台与促销-静音绝对化表述」、模型侧报「措辞表达」，
  //   位置与类目**两个都不同** ⇒ 按原规则是两条 ⇒ 问题数虚高（Owner 那张卡写 4 处、实际 3 处），
  //   而模型只能在正文里写一句「实际 3 处」来补 —— **那是模型在替代码打补丁**。
  const kbLeft = new Set(kbBy.keys());
  let nSameOrigin = 0; const rSeen = [];
  for (const [k, f] of moBy) {
    const cur = sides.get(k);
    if (cur) { cur.model = f; kbLeft.delete(k); continue; }
    // 键对不上 ⇒ 找一条**还没被配上**的库侧条目，试试同源
    let hit = null;
    for (const kk of kbLeft) {
      const so = sameOrigin(kbBy.get(kk), f);
      rSeen.push(so.r);
      if (so.same) { hit = kk; break; }
    }
    if (hit) {
      const kbItem = kbBy.get(hit);
      sides.set(k, { kb: kbItem, model: f, sameOrigin: true, sameOriginR: lcsLen(excerptOf(kbItem), excerptOf(f)) });
      // ★ 库侧那条**已经在 `sides` 里了**（上面先给每个 KB 键都建了位）——
      //   不删掉它，同源合并就会**多出一条重复**（实测：`same_origin=1` 但条目数是 2）。
      //   这是「合并之后忘了销账」，不是判据错。
      sides.delete(hit);
      kbLeft.delete(hit);
      nSameOrigin += 1;
    } else {
      sides.set(k, { kb: null, model: f });
    }
  }

  const items = [];
  let nBoth = 0; let nConflict = 0; let nKbOnly = 0; let nModelOnly = 0;

  for (const [key, { kb, model }] of sides) {
    // ══════════════════════════════════════════════════════════════════════════
    // ★★ 2026-10-13（修一个 **Owner 那张卡上就看得见的真 bug**）：
    //   **不再从 `key` 里 split 回来。**
    // ══════════════════════════════════════════════════════════════════════════
    //   病灶：`keyOf` 原先是 `` `${location}|${category}` ``，而这里写的是
    //     `const [location, category] = key.split('|')` —— **拼起来再拆回去**。
    //   只要 `location` 里本身带 `|`，这个来回就丢东西。实测那一条（P0 快路 H05）：
    //     location = `全文，逐字命中 \`最\s*(好|佳|优|强|安全|低价|便宜|有效|…)\``
    //     ⇒ 拆回来 location = `` 全文，逐字命中 `最\s*(好 ``（**命中正则被腰斩**）
    //        category = `佳`
    //     ⇒ 卡上印出 **`1.【佳】`** 与 **`· 佳类问题：1 个`**，而真维度是
    //        `绝对化与安全承诺-虚假安全承诺`。**读者拿到的是一条被改坏的数据。**
    //
    //   口径：两侧的 `location` / `category` **本来就在对象上** ——
    //     库侧在就用库侧的（与原先拆出来的那一支逐字一致），否则用独立复核那一侧的。
    //     `keyOf` 同时改成了 JSON（分隔符不可能出现在数据里，也不会两组拼成同一个键）。
    const src = kb ?? model;
    const location = String(src?.location ?? '').trim();
    const category = String(src?.category ?? '').trim();
    if (kb && model) {
      const a = normSev(kb.severity); const b = normSev(model.severity);
      if (a === b) {
        // ── 取交集：双轨确认，按该问题严重度计入 ──
        nBoth++;
        // ★ 同源配对（键对不上、靠逐字片段判成同一条）必须**把这个来路说出来** ——
        //   否则读者看到的是「双轨确认」，而实际上两侧的**类目族都不一样**，
        //   那种情况要人自己判断（见 `sameOrigin` 的取舍说明）。
        const _so = sides.get(key);
        const _fa = catFamily(kb?.category); const _fb = catFamily(model?.category);
        const soInfo = _so?.sameOrigin
          ? `；**同源判据**：位置/类目对不上，按两侧逐字片段相同判为同一条`
            + `（R=${_so.sameOriginR ?? 0}）`
            + (_fa && _fb && _fa !== _fb
                ? `；**类目族不同（${_fa} ／ ${_fb}）**—— 两侧用的是两套词表，请人工确认说的是不是同一处`
                : '')
          : '';
        items.push({
          location, category, severity: a, source: 'both', confirmed_by_both: true,
          same_origin: !!sides.get(key)?.sameOrigin,
          // ★ 顶层 reason 必须留一份：渲染（`renderMerged`）读的是它。
          reason: kb.reason ?? model.reason ?? null,
          kb: pickKb(kb), model: pickModel(model),
          note: '两轨都命中同一个问题，结论一致 —— 双轨确认（置信最高）' + soInfo,
        });
      } else {
        // ── 交集冲突 ──────────────────────────────────────────────────────────
        // ★★ 2026-10-17（Owner 第三次拿报告来问；这是「BLOCK 但分论点 REVIEW」的**残余那一半**）：
        //   原实现**无条件**降 REVIEW。可库侧的 BLOCK **只可能来自 P0 确定性命中**
        //   （关键词/正则，`[p0] 🚦 命中即 BLOCK`）—— 它不是"判断"，是**读数**。
        //   让一条模型侧的 REVIEW 把它降级，等于用一条意见推翻一个确定性命中：
        //     · 违反 PRD §6.6「P0 层级规则**不适用置信度分流**，命中即 BLOCK」；
        //     · 违反本文件题注的**单调性**「合并只许保持或升级，不许降级」；
        //     · 卡上还会印出「结论冲突 ⇒ 已降 REVIEW」，而报告抬头写着 BLOCK —— 自相矛盾。
        //   ⇒ 现在：**库侧 BLOCK ⇒ 保持 BLOCK**（不降级），并在注里说清谁说了什么。
        //     反向那条**一个字没松**：模型侧报 BLOCK、库侧只有 REVIEW ⇒ 仍然降 REVIEW
        //     （模型不许单独定 BLOCK）。
        nConflict++;
        const kbP0Held = a === 'BLOCK';
        items.push({
          location, category,
          severity: kbP0Held ? 'BLOCK' : 'REVIEW',
          // ⚠️ 不能挂 `both-conflict` —— 那个来源标记在渲染层写着「结论冲突 ⇒ 已降 REVIEW」，
          //    而这一支根本没有降级。挂 `both` 才是实话。
          source: kbP0Held ? 'both' : 'both-conflict',
          kb_p0_held: kbP0Held,
          reason: kb.reason ?? model.reason ?? null,
          kb: pickKb(kb), model: pickModel(model),
          note: kbP0Held
            ? `两轨都命中同一个问题；**库侧是 P0 红线**（确定性命中、命中即拦）／`
              + `独立复核给的是 ${b || '—'} ⇒ **不降级，仍按 BLOCK**`
              + '（PRD §6.6：P0 不适用分流；单调性：合并只许保持或升级）。'
              + '两侧依据都留在这里，供人复核。'
            : `两轨都命中同一个问题但结论不一致（库侧 ${a || '—'} ／ 模型侧 ${b || '—'}）`
              + ' ⇒ **降为 REVIEW**，连同两侧依据一起转人工；不许任一侧单独定案',
        });
      }
    } else if (kb) {
      // ── 走并集：只有库侧命中，按其严重度计入 ──
      nKbOnly++;
      items.push({
        location, category, severity: normSev(kb.severity), source: 'kb',
        reason: kb.reason ?? null, kb: pickKb(kb), model: null,
        note: '只有知识库侧命中 —— 带条款号／锚点／指纹，可回源',
      });
    } else {
      // ── 走并集：只有模型侧命中 ⇒ 留住，但**不由它单独定 BLOCK** ──
      nModelOnly++;
      const asked = normSev(model.severity);
      items.push({
        location, category, severity: 'REVIEW', source: 'model',
        reason: model.reason ?? null, kb: null, model: pickModel(model),
        // ★ 2026-10-22：**判定主体（图片安全审查 skill）判出的条目要能标出来路**。
        //   `source` 仍是 `'model'`（合并语义一个字不改），但落表要答得出
        //   「这几条是模型侧写的，还是判定主体判的」—— 见 `merged_record` 的 side。
        origin_track: model?.origin_track ?? null,
        asked_severity: asked || null,
        note: '只有模型侧命中 —— **无库内依据**；倾向 REVIEW，不由它单独定 BLOCK'
              + (asked === 'BLOCK' ? '（模型侧报的是 BLOCK，已按本规则降为 REVIEW）' : ''),
      });
    }
  }

  items.sort((x, y) => (SEV_ORDER[y.severity] - SEV_ORDER[x.severity])
    || String(x.category).localeCompare(String(y.category))
    || String(x.location).localeCompare(String(y.location)));

  return {
    items,
    stats: {
      kb: kbFindings.length, model: modelFindings.length, merged: items.length,
      both: nBoth, conflict: nConflict, kb_only: nKbOnly, model_only: nModelOnly,
      // ★ 同源配对（键对不上、但逐字片段相同）与它见到的 R 分布 ——
      //   R 的门限本次**未启用**，先把这个读数收起来，攒够真实数据再定（见 `sameOrigin`）。
      same_origin: nSameOrigin,
      same_origin_r: rSeen.length ? { n: rSeen.length, max: Math.max(...rSeen), min: Math.min(...rSeen) } : null,
      // ★ 合成前后的**恒等式**：合并只许去重、不许凭空多出或少掉。
      //   多出 = 我造了东西；少掉 = 我静默吞了东西。两者都要能被断言抓住。
      identity_ok: items.length === (nBoth + nConflict + nKbOnly + nModelOnly),
    },
  };
}

const pickKb = (f) => ({
  article_no: f?.article_no ?? null, anchor: f?.anchor ?? null,
  source_sha256: f?.source_sha256 ?? null, reason: f?.reason ?? null,
  excerpt: f?.excerpt ?? f?.matched_term ?? null,
  // ★ 2026-10-08：这两格**必须带过来** —— 漏掉它们，`renderMerged` 就永远拿不到库侧
  //   已经产好的「逐字命中文案 + 飞书源直链」，只能退回重建版
  //   （实测印出来是 `《知识库》（未给条款号）（锚点：—）` —— 点不开、也没说命中了什么）。
  //   这就是 bug 本体：判据抓对了、搬运却在这一行把字段丢了。
  basisLine: f?.basisLine ?? null,
  relatedArticleNos: f?.relatedArticleNos ?? f?.kb?.relatedArticleNos ?? [],
  reasonLine: f?.reasonLine ?? null,
  // ★ 2026-10-09：库侧已经产好的「建议」——不搬过来，渲染层只能印硬编码那句
  suggestionLine: f?.suggestionLine ?? null,
  // ★★ 2026-10-17：**优先级与维度**（报告要按 P 级分组、每条要标维度）。
  //   白名单式搬运的代价见 `pickModel` 那段注释：新字段不加进来就**静默消失**。
  priorityTier: f?.priorityTier ?? null,
  priorityTierBasis: f?.priorityTierBasis ?? null,
  riskCategory: f?.riskCategory ?? null,
  riskCategoryBasis: f?.riskCategoryBasis ?? null,
  // ★ 2026-10-17：11 类。**白名单式搬运，不加这一行它就静默消失**（第 N 次同一个形状）。
  taxonomyCategory: f?.taxonomyCategory ?? null,
  taxonomySubcategory: f?.taxonomySubcategory ?? null,
  // ★ 2026-10-17：库侧也能有「问题描述」（P0 快路那条来路给了逐字命中）
  description: f?.description ?? null,
});
const pickModel = (f) => ({
  reason: f?.reason ?? null, excerpt: f?.excerpt ?? null, severity: normSev(f?.severity) || null,
  // ★★ 2026-10-19（Owner：「最终输出的卡片态，必须是 4 态」）：
  //   `nature`（advisory=非强制／mandatory=强制）**必须搬** —— 不搬它，
  //   下面 `priorityOf` 就永远看不到「非强制」信号 ⇒ 模型侧条目一律 P1 ⇒ **卡片永远变不出 SUGGEST**。
  //   白名单式重建的代价与 `source_url` / `taxonomyCategory` 是同一条（都在这里栽过）。
  nature: f?.nature ?? null,
  nature_asked: f?.nature_asked ?? null,
  // ★ 2026-10-19：依据缺失标记必须搬（否则卡面过滤看不到它 —— 白名单的老坑）
  basis_missing: f?.basis_missing ?? null,
  basis_kind: f?.basis_kind ?? null,
  evidence_basis: f?.evidence_basis ?? null,
  visual_anchor: f?.visual_anchor ?? null,
  // ★★ 2026-10-17：**问题描述**（报告六格里的那一格，见 `model_side.mjs` 提示词 4c）
  description: f?.description ?? null,
  // ★ 2026-10-09：模型侧新增的「可执行改法」字段（见 model_side.mjs）
  suggestion: f?.suggestion ?? null,
  // ★ 2026-10-13：**依据来源 id**（闭集 id，不是 URL）—— 少了这一行，
  //   渲染层的 `extBasisText()` 永远拿到 `{}`，于是「有依据」那条路**一次都不会生效**
  //   （实测：加完提示词与渲染，印出来还是「没给出可核的外部来源」）。
  //   白名单式搬运的代价就是这个：**新字段不加进来就静默消失**。
  source: f?.source ?? null,
  // ★ 2026-10-13（Owner：「模型当然有权限写 url」）：模型自己给的 URL + 来源名 + 核验三态，
  //   三个一起搬 —— 少搬 `url_probe` 就会出现「标了链接却看不出核没核过」。
  source_url: f?.source_url ?? null,
  source_name: f?.source_name ?? null,
  url_probe: f?.url_probe ?? null,
  // ★★ 2026-10-19：模型侧也可以给 **A3 所属类别/所属子类**（受控枚举，见 `model_side.mjs` 提示词）。
  //   ⚠️ 白名单式重建：不搬这两格，模型侧分类**静默消失** ⇒ 卡上永远落「未归类」
  //   （这正是 Owner 看到的「5 个未归类、可报告里都归类了」的成因之一）。
  taxonomyCategory: f?.taxonomyCategory ?? null,
  taxonomySubcategory: f?.taxonomySubcategory ?? null,
});

/**
 * 合并后的三态。
 *
 * ★ PASS 那一行是**方案的字面规则**，不是我的取舍：
 *   `两侧都没发现问题，且两侧都覆盖到该主题 → PASS —— 这是 PASS 唯一的成立方式`
 *   `任一侧没覆盖该主题（拒答） → 交集不成立 → 拒答，不得输出 PASS`
 *
 *   所以 `kbCovered !== true` 时**永远到不了 PASS** —— 这正是「不许因为加了模型侧
 *   就把原来拒答的单子放行」的执行点。Owner 2026-10-06 的原话是「PASS 门限一个字不改」。
 *
 * @param {{kbCovered:boolean, merged:Array}} a
 * @returns {'PASS'|'REVIEW'|'BLOCK'|'拒答'}
 */
export function mergedState({ kbCovered = false, merged = [], kb = null, modelFailed = false } = {}) {
  // ★ 2026-10-07 加（Owner 同意，缺陷实测：**库侧零读数却落了 PASS**）——
  //   **「库侧没有读数」⇒ PASS 不可达。**
  //   实测：素材「这条社媒文案能不能发：这批婴幼儿用品的文案里写了医用级」
  //     （表行 `recvxlAvpEWMIX`）— 日志 `[review] ⚠️ 没读到机读旁挂` ⇒ 库侧一个读数都没有，
  //     而它落表的 `Agent 结论` / `状态` 是 **PASS**、`问题数量 0`、`置信度 0`。
  //     同一批的另一条（旁挂读到了、state=NEEDS_INPUT）落的是 `NEEDS_INPUT`/待审 —— 对比之下
  //     差别不在素材，在**有没有读数**。
  //   ⇒ PASS 是唯一的「放行」态、也是唯一不可挽回的错：**没读库就不许放行**。
  //     注意这不是新判据、也不放宽任何东西：`kbCovered` 本来就在「认不出来时判没覆盖」，
  //     这里只是把「**没有读数**」与「**读到了、说覆盖了**」分开 —— 后者才够格 PASS。
  const noReading = kbNoReadingOf(kb);
  // ★ 2026-10-07 改（实测缺陷：库侧红线被降级）—— 两条判据加在**最前面**：
  //   ① **库侧拒答 ⇒ 不许出三态结论**：库没判，就不能拿模型侧的意见冒充"双轨结论"。
  //      （原先拒答被当成「0 条」静默参与合并 ⇒ 用户看到一张 REVIEW 卡，
  //        而表里那行的结论是 NEEDS_INPUT —— 同一单两个结论。）
  //   ② **单调性：只许保持或升级，不许降级**：库侧 BLOCK 命中 ⇒ 合并后必须是 BLOCK。
  //      原先只认「合并条目里有没有 BLOCK」，而库侧的条目是**正则从中文答案里抠**的
  //      （`kbFindingsOf`），PRD §5.3.3 规定 **≥3 条时库侧只出汇总** ⇒ 抠不到 ⇒ 降级。
  if (kb && kb.refused === true) return 'NEEDS_INPUT';
  if (merged.some((f) => f.severity === 'BLOCK')) return 'BLOCK';
  if (kb && String(kb.state).toUpperCase() === 'BLOCK') return 'BLOCK';
  // ★★ 2026-10-21（Owner：4 态 = pass / pass+suggest / block / review；PRD rev 105）：**态名改成
  //   `PASS+SUGGEST`**。2026-10-19 那版让 `SUGGEST` 独立成态，与 PRD §5.3.2（SUGGEST 是 PASS 的
  //   附属信息）和 §6.3 规则 4（decision 仍记 PASS）都不一致 —— 卡面上就表现为「一单既不是 PASS
  //   也不是 REVIEW」，Owner 拿来问「跟 PRD 不符」的正是这一单。
  //   单调性不变：BLOCK ＞ REVIEW ＞ **PASS+SUGGEST** ＞ PASS —— 只许保持或升级。
  //   判定条件（两条同时成立才给 PASS+SUGGEST，比「非 BLOCK 就算」窄）：
  //     ① 合并后的每一条都是**非强制**级（`priorityOf().level === 'P3'`，即 §6.2 的 P3→SUGGEST）；
  //     ② 库侧结论不重于它（`SUGGEST`＝旧名 / `PASS+SUGGEST` / `PASS` / 无读数）。
  //   ⇒ 只要有一条是 P0/P1/P2，就仍然落到下面那条 `merged.length ⇒ REVIEW` 的分支。
  {
    const _allSuggest = merged.length > 0 && merged.every((f) => priorityOf(f).level === 'P3');
    const _kbState = prd53StateOf(kb?.state || '');
    const _kbNotHeavier = !kb || _kbState === 'PASS+SUGGEST' || _kbState === 'PASS';
    if (_allSuggest && _kbNotHeavier) return 'PASS+SUGGEST';
    // 库侧只有建议、模型侧没并进条目 ⇒ 仍是 PASS+SUGGEST（不许因为"合并后空"就掉回 REVIEW）
    if (_kbState === 'PASS+SUGGEST' && !merged.length) return 'PASS+SUGGEST';
  }
  if (merged.length) return 'REVIEW';
  // ★★ 2026-11-03（Owner：问题数只算素材风险）：库侧条目**全是同图历史参考**时，
  //   问题数虽然归 0，但「这张图归哪条记录」没确认 ⇒ 保持 REVIEW，不许因 0 条放行成 PASS。
  if (kb?.historyOnly === true && !merged.length) return 'REVIEW';
  if (kb && String(kb.state).toUpperCase() === 'REVIEW') {
    // ★★ 2026-10-15（Owner 裁定，原话：「**没有命中就是 pass**，按照 prd 的一句话结论走，
    //   你不要自己定义」）────────────────────────────────────────────────────────
    //
    //   病灶（真单，`MC-US-YT-_xyLF4_AgAw-IMG`，群里那张卡）：库侧报 `state=REVIEW` 而
    //   `issue_count=0`（覆盖缺口那一档：检索有命中，但「既被规则引用、又达门限」的单元 0 条）
    //   ⇒ 这一支原样跟着出 REVIEW，**再被 `covEntries` 加上 1** ⇒ 卡上印
    //   「共发现 **1** 处需人工确认」，而逐条里**一条都没有**、报告文档里也只有一句话。
    //   Owner 的座位上看就是「一个问题要输出问题到卡片」而卡上什么都没有。
    //
    //   口径（Owner 2026-10-15）：**一条内容问题都没命中 ⇒ PASS**（§5.3.1 的一句话结论）。
    //   ⚠️ 只放行**零条 ＋ 覆盖缺口**这一档，两条边界都收着：
    //     · `issue_count > 0` 的 REVIEW **一个字不动**（那是真报了几条、只是明细没并进来
    //       ⇒ 仍然要人去看，`kbGap` 那一套照旧）；
    //     · 读不到条数（`null`）也**不许**放行（读不到 ≠ 零条）。
    //   ⚠️ 两只形状都要认：**库侧有没有把这条缺口算进 `issue_count`，两个时代不一样** ——
    //      · 2026-10-08 那一版把它算进去 ⇒ 缺口单是 `issue_count=1`（本文件 ⑭ 组的夹具就是它）；
    //      · 2026-10-12 起 `issue_count` 只算库内依据 ⇒ 缺口单是 `issue_count=0`（今天真单）。
    //     两种形状都**没有内容问题** ⇒ 都走 PASS。`≥2` 才当「还有别的内容问题」⇒ 照旧 REVIEW。
    //     ⚠️ 读不到条数（`null`）**不许**放行（读不到 ≠ 零条）。
    const kbZeroCount = Number.isFinite(kb?.issueCount)
      && (kb.issueCount === 0 || kb.issueCount === 1);
    // ★ 2026-10-21：缺口单 + **模型侧没跑成** ⇒ 同样不许 PASS。
    //   病根（2026-10-21 10:07 真单）：库侧 REVIEW/0（覆盖缺口）+ 模型侧 raw=0（没跑成）
    //   ⇒ 本支抢在下面的 `if (modelFailed)` 之前返回 PASS ⇒ 一张「没审过」的单子被放行。
    // ★★ 2026-10-26（Owner：「命中 0 条」应当出【PASS】… 一句话，按 PRD 出 pass）——
    //   **严格 0 条就让 PASS，不再看 `coverageGap` 有没有被标出来。**
    //   病灶：A 机 14:5x 那条真回复是「命中 0 条」却给了 `REVIEW / 待放行 / coverage = partial`。
    //   而 `coverageGap` 这个标记是**我们自己的**旁挂字段，引擎换个版本不再写它时，
    //   这条判据就静默失效（`Number.isFinite(issueCount) && issueCount===0` 才是真凭据）。
    //   ⚠️ 三条边界仍然收着：① `issueCount` 读不到（null）**不放行**（读不到 ≠ 零条）；
    //     ② 模型侧没跑成（`modelFailed`）**不放行**；③ `issueCount === 1` 且非覆盖缺口
    //     ⇒ 那是真有 1 条问题，照旧 REVIEW（下面那一支）。
    const kbStrictZero = Number.isFinite(kb?.issueCount) && kb.issueCount === 0;
    if (kbStrictZero && !modelFailed) return 'PASS';
    if (kbZeroCount && kb?.coverageGap === true) {
      // 缺口 + 模型侧没跑成 ⇒ 没审过，拒答（2026-10-21 真单：这一支曾抢在 modelFailed 前放 PASS）
      if (modelFailed) return '拒答';
      return 'PASS';
    }
    return 'REVIEW';
  }
  if (noReading) return '拒答';          // 库侧没读数 ⇒ 不出 PASS（理由见上）
  // ★★ 2026-10-14（实测缺陷，Owner 报「报告链接点不开」那一轮顺带查出）——
  //   **对称的那一条：模型侧没跑成 ⇒ 同样不出 PASS。**
  //
  //   病灶（逐字可核，`MC-US-AMZ-B0CWLHKQNT`）：模型侧输出 **JSON 解析失败**
  //   （`raw` 里字符串内含未转义的双引号 ⇒ `Expected ',' or '}' …`），
  //   `modelFailed = true` 只写进了**查证笔记**，**没进合并态** ⇒
  //   模型侧按「0 条」参与合并 ⇒ 库侧安全词覆盖 → **落 PASS**。
  //   而 PASS 是唯一的「放行」态 —— 模型侧压根没判，却说「可以发」。
  //
  //   这不是新放宽也不是新收紧：库侧早就有同一条（`noReading` ⇒ 不出 PASS），
  //   本条只是把**同一个道理**补到另一侧。**只挡 PASS（单向）**：
  //   BLOCK/REVIEW/NEEDS_INPUT 一个字不动，也不放宽任何既有判据。
  if (modelFailed) return '拒答';
  return kbCovered === true ? 'PASS' : '拒答';
}

/**
 * **卡上只留一条报告链接**（Owner 2026-10-19：「卡片上的清单链接有两个，**去掉上面的，保留下面的**」）。
 *
 * 病灶：守衡自己加一行 `→ 完整清单：<url>`，而库侧结论块里**本来就带**
 *   `→ 查看完整问题清单与修改建议：<url>` ⇒ 同一份报告两张链接，上下各一条。
 * 口径：
 *   · **只留最后一条**（Owner 指定「保留下面的」，即库侧那条原措辞）；
 *   · 匹配**按行首的两种措辞**，不按某个固定字符串 —— 将来谁改措辞，去重仍然生效；
 *   · 只有一条时**原样返回**（不动任何东西）。
 */
/**
 * **卡面出厂闸** —— 对**最终那张卡的正文**逐条核 PRD §5.3.3 与 Owner 三条口径。
 *
 * ★ 为什么需要它（Owner 2026-10-19 第三次报同一族问题，原话：
 *   「**字数限制问题，为什么反复修？**」）：
 *   因为**每一次修复都只落在某一个渲染分支上**，而没有任何东西在**出厂那一刻**
 *   对整张卡核一遍。「原因压了」只证明 `reasonCard` 那行在压；「指针条件化」只证明
 *   那个 `if` 生效；而卡里还有别的路能印出同样的字（库侧的、并进来的、将来新加的）。
 *   这就是本库反复吃过的「散文没有失败信号」——只是这次长在卡面上。
 *   ⇒ 本函数**只看成品卡文本**，不看任何标记、不看哪个分支产出的。有任何一条不合规就返回它。
 *
 * 口径（与 `kb/l7/registry/prd533-constraints.yaml` 同源，改口径去改那份）：
 *   ① 每条「原因」≤50 字；② 每条「建议」≤`ADVICE_MAX` 字（读取登记表）；
 *   ③ 没有报告时**不许**出现「（全文见报告）」——没有的东西不要说；
 *   ④ 依据**不许**是「独立语义复核（非条款依据…）」那种自我否定（Owner：必须要提供依据）；
 *   ⑤ 一张卡上清单链接行**恰好 0 或 1 条**。
 *
 * @returns {string[]} 违规说明；空数组 = 合规
 */
export function cardConformance(block, { hasReport = false } = {}) {
  const t = String(block ?? '');
  const bad = [];
  const rows = t.split('\n');
  // ★★ 2026-10-19（Owner 裁定「1→2→3 全做」）：**数法只许有一把尺**。
  //   改前这里数的是「剥掉 `**` 与空白」—— 而压字那一段（`_clip`）数的是 `body.length`
  //   （含空格、含 `**`、含链接），PRD 真源 `prd533-constraints.yaml::counting` 又是第三套
  //   （`visible_no_url`）。三套数法 ⇒ **同一个句子里三个答案**：
  //   卡面可能在「按 PRD 明明合规」的时候被切，而闸门数的是切完的那一份（恒 ≤50）⇒ 永不报警。
  //   ⇒ 现在三处**全部**走 `prd533.countChars`（PRD 真源口径）。改口径就改那份 yaml，不在这里改。
  const count = (x) => _prd533CountChars(x);
  let reasonN = 0, sugN = 0;
  for (const r of rows) {
    const mR = /^\s*\*\*原因\*\*[：:](.*)$/.exec(r);
    if (mR) {
      reasonN += 1;
      const n = count(mR[1]);
      if (n > 50) bad.push(`第 ${reasonN} 条「原因」${n} 字，超 PRD §5.3.3 的 50 字`);
    }
    const mS = /^\s*\*\*建议\*\*[：:](.*)$/.exec(r);
    if (mS) {
      sugN += 1;
      const n = countAdviceChars(mS[1]);
      if (n > ADVICE_MAX) bad.push(`第 ${sugN} 条「建议」${n} 字，超建议上限 ${ADVICE_MAX} 字`);
      if (!hasReport && /全文见报告/.test(mS[1])) {
        bad.push(`第 ${sugN} 条「建议」写了「（全文见报告）」，但这一单**没有报告**（PRD §5.3.4 问题数 <3 不出报告）`);
      }
    }
    const mB = /^\s*\*\*依据\*\*[：:](.*)$/.exec(r);
    if (mB && /非条款依据/.test(mB[1])) {
      bad.push(`「依据」写的是「${count(mB[1]) > 24 ? `${mB[1].slice(0, 24)}…` : mB[1]}」—— 那不是依据（Owner：依据必须要提供依据，为问题做支撑）`);
    }
  }
  const links = rows.filter((x) => /^\s*(?:→|->)?\s*(?:完整清单|查看完整问题清单与修改建议)\s*[：:]/.test(x)).length;
  if (links > 1) bad.push(`卡上清单链接行 ${links} 条（应恰好 1 条）`);
  return bad;
}

/**
 * 把「字数上限」压在一句话上 —— **卡面/报告共用的唯一压字实现**。
 *
 * ★★ 2026-10-19（Owner 裁定「1→2→3 全做」；原话「原因是不是没讲完？按 prd 要求的字数限制
 *   梳理重点输出，不能出现截断的场景」）：
 *
 *   **为什么不是「不截断」，而是「不该需要截断」** —— 真实病灶不在这一段：
 *   模型侧压根没被告知「原因 ≤50 字」（提示词只写了登记表中的建议上限，见 `model_side.mjs` 的 4b），
 *   于是它写 80–200 字，渲染层负责硬切 ⇒ 读者看到「而实际想表达的应是「只…」——
 *   **切在引号中间，读起来像内容没写完**。
 *   ⇒ 现在：① 提示词在**源头**要求 ≤50/登记表建议上限；② 这一层只做兜底；
 *     ③ 兜底一旦发生，**必须留下 `truncated: true`**（卡上要出声、记录里要留痕），
 *        **不许静默变成「看起来写完了」**。
 *
 *   ★ 数法：`countChars`（PRD §5.3.3 真源口径 `visible_no_url`，见 `prd533-constraints.yaml`）。
 *     改前这里数 `body.length`（含空格/`**`/链接）⇒ 同一句在三个地方三个数，
 *     卡面会在「按 PRD 合规」时被切，而闸门数切完那份（恒 ≤50）⇒ **永不报警**。
 *
 *   ★ 切法：**先在分句边界回退**（，、：；空格），再退到硬切。
 *     硬切是最后手段 —— 「部分部件不能水洗…」比「应是「只…」」可读得多，
 *     但两者都算 `truncated`，不装成完整。
 *
 * @param {string} text 原文（可以带 `**`、链接、换行）
 * @param {number} max  PRD 上限（字）
 * @param {{hasReport?: boolean}} [opt] `hasReport` ⇒ 截断指针写「…（全文见报告）」；
 *        **没有报告时只写裸 `…`**（Owner 2026-10-19：没有的东西不要说）
 * @returns {{text: string, truncated: boolean, full: number, shown: number}}
 */
export function clipToLimit(text, max, { hasReport = false, count = _prd533CountChars } = {}) {
  const body = String(text ?? '').replace(/\s+/g, ' ').trim();
  const full = count(body);
  if (full <= max) return { text: body, truncated: false, full, shown: full };
  // ② 取**第一句**：丢掉后面的句子是「压」，不是「切」——没有半个字被腰斩
  const first = (body.match(/^[^；;。！？!?]+[；;。！？!?]?/) || [body])[0].trim();
  const ptr = hasReport ? '…（全文见报告）' : '…';
  const room = Math.max(1, max - count(ptr));
  const firstN = count(first);
  if (firstN <= room) {
    const shownText = `${first}${ptr}`;
    return { text: shownText, truncated: true, full, shown: count(shownText) };
  }
  // ③ 第一句本身就超 ⇒ 在**分句边界**回退（切在同一口气里），并给后续指针留位置
  const cut = cutAtBoundary(first, room);
  return { text: `${cut}${ptr}`, truncated: true, full, shown: count(cut) + count(ptr) };
}

/**
 * 把一句话压到 `n` 字以内，且**不许留下半截引号**。
 *
 * ★★ 2026-10-19（Owner 原话：「而实际想表达的应是「只…」」——他说对了，那个「只」就是半截引号）：
 *
 *   旧实现是 `first.slice(0, max - ptr.length)`，纯字位硬切。落在**引号中间**时，
 *   读起来像「内容没写完」，而不是「这里被压缩了」—— 同长度下这是最坏的一种断法。
 *
 *   两条改进（都只在兜底路径上生效；源头已让模型自己写 ≤50，正常走不到这里）：
 *     ① **优先在分句边界回退**（，、：；空格）—— 但只在「退得不多」时采用
 *        （保留 ≥85%），否则宁可硬切：为了一个逗号丢掉 1/4 的内容是另一种失真；
 *     ② **收尾时把没闭合的引号/括号整段去掉**：`…应是「只` ⇒ `…应是`。
 *        宁可少这 12 个字，也不给读者一个悬着的左引号。
 */
/**
 * **修改建议那一格：宁可超字数，也不许印半句**（Owner 2026-10-19 逐字：
 *   「这里的 修复建议都没讲完，被截断了，**不能出现这种情况**」）。
 *
 * ── 为什么会印出半句（真报告 `Gfuydnn9xoUcAwxnNACcCJcvnfc`，6 条里 3 条这样）
 *
 *   `clipToLimit` 的第 ③ 兜底：第一句超过建议上限时按字位切，尾巴挂 `…`。实测那三条是
 *     `删「Certified Comfort」，或补认证机构名称…`
 *     `保留「Global No.1」，下方加脚注标注排名依据与统…`
 *     `把「Signal Booster Set」改为具体部件名，…`
 *   第 ③ 条尤其坏：切点正好落在「，」之后 ⇒ 拿到的人**不知道该改成什么**。
 *   更极端的一次（2026-10-19 17:39 那单）整条只剩 **`改为…`** 三个字。
 *
 * ── 为什么不继续用「取第一句 / 分句回退」
 *
 *   那条路在**原因**格上成立（原因可以少说一句），在**建议**格上不成立：
 *   `删 X，或补 Y` 被压成 `删 X` ⇒ 把「二选一」改成了**唯一动作**，语义被改写。
 *   ⇒ 建议格只有两种合法结局：**完整印出**，或**源头写短**。这里是前者；
 *     后者由 `advice.mjs` 的登记表上限提示词负责（那是「写短」，不是「截断」）。
 *
 * ⚠️ 只有**报告**用这个函数；**卡面**仍走 `clipToLimit`（PRD §17 有整卡字数硬上限，
 *   卡是摘要、报告是全文 —— 两者尺度不同，见 `renderMergedItem` 里的两处注释）。
 *
 * @returns {{text:string, full:number, shown:number, over:boolean}}
 *   `over=true` ⇒ 超过登记表上限仍**完整**印出，调用方只记读数、不许改字。
 */
export function fitAdvice(text, max = ADVICE_MAX) {
  const body = String(text ?? '').replace(/\s+/g, ' ').trim();
  // ★ 按登记表口径按**不计标点**数；上限由 `ADVICE_MAX` 统一读取。
  //   与 `prd533.countAdviceChars` 同一把尺（唯一真源，不许在这儿另抄一份）。
  const full = countAdviceChars(body);
  if (full <= max) return { text: body, full, shown: full, over: false };
  const clipped = clipToLimit(body, max, { hasReport: false, count: countAdviceChars });
  return { text: clipped.text, full, shown: clipped.shown, over: true };
}

function cutAtBoundary(s, n) {
  const str = String(s ?? '');
  if (str.length <= n) return balanceQuotes(str);
  const head = str.slice(0, n);
  const m = head.match(/^[\s\S]*[，、：；,;:\s]/);
  const cut = (m && m[0].replace(/[，、：；,;:\s]$/u, '').trim().length >= Math.ceil(n * 0.85))
    ? m[0].replace(/[，、：；,;:\s]$/u, '').trim()
    : head.trim();
  const bal = balanceQuotes(cut);
  // ★★ 2026-10-19（真报告 `BjiBdJW2doq7xPxaUChcBemNnyc` 的 P3，Owner：「**修改建议：改为…** 后面没有了，
  //   **这是 bug**，修复」）——
  //   病灶：建议原文是 `改为「discreet enough to pump at work or on the go」`，
  //   兜底截断先切到 `改为「discreet enough to pump`，再被 `balanceQuotes` 从**没闭合的左引号**那一刀砍回
  //   ⇒ 整条只剩 **`改为`**（＋省略号）。**有动词、没有动作对象**，比"字少"坏得多。
  //   ⇒ 平衡可以少字，但不许把句子砍成光杆动词：砍掉超过一半 ⇒ 改用**去掉引号字符**的版本
  //     （既不悬着半个引号，也留得住「改成什么」）。
  // 阈值取「至少 8 字 **且** 不低于候选的 35%」：8 字是「动词 + 宾语」的下限，
  //   `删掉「最」字，改为「更」`（12 字）这类**正常压短**不许被误伤（Z23 钉着）。
  if (bal.length >= Math.max(8, Math.ceil(cut.length * 0.35))) return bal;
  return cut.replace(/[「『（【“\[]/g, '').replace(/[」』）】”\]]/g, '').trim();
}

/** 去掉结尾处**没闭合**的引号/括号：从左引号那一刀切掉，别让读者看见半个「。 */
function balanceQuotes(s) {
  let t = String(s ?? '');
  const pairs = [['「', '」'], ['『', '』'], ['（', '）'], ['【', '】'], ['“', '”'], ['(', ')'], ['[', ']']];
  for (const [open, close] of pairs) {
    const o = (t.match(new RegExp(open.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    const c = (t.match(new RegExp(close.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    if (o > c) {
      const at = t.lastIndexOf(open);
      if (at > 0) t = t.slice(0, at).trim();
    }
  }
  return t;
}

export function dedupeReportLinkLines(text) {
  const LINK_RE = /^\s*(?:→|->)?\s*(?:完整清单|查看完整问题清单与修改建议)\s*[：:]/;
  const rows = String(text ?? '').split('\n');
  const linkIdx = rows.map((r, i) => (LINK_RE.test(r) ? i : -1)).filter((i) => i >= 0);
  if (linkIdx.length <= 1) return String(text ?? '');
  const keep = linkIdx[linkIdx.length - 1];
  return rows.filter((_r, i) => !linkIdx.includes(i) || i === keep).join('\n');
}

/** 给报告/卡片用的一行读数（谁贡献了几条），便于人核对「并集到底并了什么」。 */
export function mergeSummary(stats = {}) {
  return `知识库侧 ${stats.kb ?? 0} 条 ／ 模型侧 ${stats.model ?? 0} 条`
    + ` ⇒ 合并 ${stats.merged ?? 0} 条`
    + `（双轨确认 ${stats.both ?? 0} · 冲突降 REVIEW ${stats.conflict ?? 0}`
    + ` · 仅库侧 ${stats.kb_only ?? 0} · 仅模型侧 ${stats.model_only ?? 0}）`;
}

/* ═══════════ 置信度：**两侧各出一个**，对外**只出一个数**（Owner 2026-10-15 定）═══════════
 *
 * 口径（★ PRD 只给语义、**不给算法** —— 这一条必须写在明处，免得后人以为有出处）：
 *   · PRD §6.6 定义的只有**三档语义**：≥0.90 直接出结论 ／ 0.70–0.89 出 REVIEW ＋「建议人工确认」
 *     ／ <0.70 出 REVIEW ＋「不确定，建议人工重点看」；P0 不适用分流。全篇**没有**置信度算法
 *     （§5.4 只有一个 `confidence` 字段；§11.3 五个指标里也没有它的口径）。
 *   · 两侧各按这三档出一个档位：
 *       库侧 —— 沿用引擎**已经算好**的派生量（`kb/l7/review-engine/core/review_engine.py::decide()`，
 *                随机读旁挂的 `confidence` 进来）；本文件**不重算它**，只分档。
 *       模型侧 —— **不新增 LLM 字段**，用它**已经输出**的东西派生：`model.ok` / `model.findings`
 *                 （条数、是否逐条给了位置与理由）/ `model.dropped` / `kbCovered`。
 *                 ★ 为什么不让模型自报：自报的数不可复算、不可标定，而且多半恒定在 0.9 上下；
 *                   派生值可复算、可回归。这一条是**刻意的设计选择**，不是省略。
 *   · 合并 = **取更保守的一侧**。与 `mergedState` 既有哲学**同一条**：`kbCovered` 认不出来判
 *     "没覆盖"、`modelFailed` 不得当"0 条"。★ **零自由权重** —— 没有可拍的参数（这是要点：
 *     两个未标定的数加权只会造出第二个"把猜测分类"的数）。
 *   · 对外**只有一个数**（档位代表值）＋ 一行 `basis`，写明是**哪一侧拉低的**。
 *   · 模型侧未参与 ⇒ **不产出合并数**，退回库侧读数并在 basis 里写明。否则同一个字段在
 *     单轨/双轨两种情形下**含义不同**（那正是本库最忌的形状）。
 *   · ★★ **库侧没有读数 ⇒ 同样不出这个数**（F1，2026-10-15，Owner 批「开始做」）——
 *     库侧拒答／覆盖缺口时 `kbConfidence = null`，旧版会退回**模型侧单轨**，而"模型侧 0 条"
 *     返回 direct ⇒【库侧没有判定 ＋ 模型侧没报】= **0.93「直接出结论」**。
 *     100 条真数据里 15 条是库侧无读数，8 条正因此落进 direct（expected 是「拒答」）。
 *     与 2026-10-07「库侧没有读数不许落 PASS」同一条纪律：**没有读数 ⇒ 不得产出"确定"**。
 *     ⚠️ 与上一条**方向相反、不可合并**：模型侧没参与时**库侧可以单独出数**（库侧有依据）；
 *        库侧没读数时**模型侧不能单独出数**（模型侧那一侧没有库内依据）。
 *
 * 反向对照：`--selftest` ㉔b（把"只有模型侧命中"当一致 ⇒ 必须红）
 *          ㉔d（把模型侧失败当"0 条" ⇒ 必须红）
 *          ㉔e2（库侧没读数时给出 direct ⇒ 必须红；且库侧有读数时仍须 direct，防恒真）。
 */
export const CONF_LINES = Object.freeze({ direct: 0.90, confirm: 0.70 });
/** 档位 → 对外那个**代表值**（唯一一张表；换它 = 改口径，不是调参）。 */
export const CONF_REPRESENTATIVE = Object.freeze({ p0: 1.0, direct: 0.93, confirm: 0.85, focus: 0.65 });
const CONF_ORDER = ['focus', 'confirm', 'direct'];      // 越靠前越保守（★ `p0` **不在这条链上**，见下）

/**
 * 这一单**是不是 P0 命中** —— 决定置信度走不走分流（PRD §6.6 末句）。
 *
 * ★★ 2026-10-16（Owner 逐字裁定）：
 *   「按照 prd：**P0 层级规则不适用置信度分流，命中即 BLOCK，置信度记为 1.0**。
 *     模型侧应该也是 **1**，最终出 **1**。」
 *
 *   为什么非要这个判据（当天吵了三轮，两个口径在 P0 行上顶着）：
 *     · 只按 PRD 字面 ⇒ 表里写 1.0，**但那个数只反映库侧**（模型侧的档位被豁免丢掉）；
 *     · 只按「两侧一起出」⇒ 表里写 0.85（模型侧把库侧的 1.0 拉低）⇒ 与 PRD 那句冲突。
 *     Owner 的裁法把两者都满足：**命中 P0 ⇒ 两侧一起记 1.0**（模型侧不再是 0.85），
 *     于是"两侧都出了"与"记为 1.0"同时成立。
 *
 *   判据来源（**引擎的读数，不是我猜的**）：
 *     · P0 快路：`res.p0_fastpath` / `kbSideOf().source === 'p0_fastpath'`；
 *     · 评审链：引擎 JSON 的 `tier_trace.P0`（`review_engine.py` 明写「数**命中的**，不是数拦住的」
 *       —— 连"P0 命中但证据不齐、结论走 REVIEW"那一单也记 P0>0）；
 *     · 兜底：库侧那个数本身就是 `1.0`（`bandOf(1) === 'p0'`，只有 P0 会写这个值）。
 */
export function p0HitOf({ res = null, kb = null } = {}) {
  if (kb && kb.source === 'p0_fastpath') return true;
  if (res && res.p0_fastpath) return true;
  const tt = res?.engine?.tier_trace;
  if (tt && Number(tt.P0) > 0) return true;
  const items = res?.engine?.risk_items ?? res?.engine?.items;
  if (Array.isArray(items)
      && items.some((i) => String(i?.priority_tier ?? '').toUpperCase() === 'P0')) return true;
  return bandOf(res?.review?.confidence ?? res?.confidence) === 'p0';
}

/** 一个数 → PRD §6.6 的档位（拿不到数就 `null`：**不猜档**）。 */
export function bandOf(confidence) {
  // ★ 不许用 `Number(x)` 一把梭：`Number(null) === 0` ⇒「没给数」会被当成「置信度 0」，
  //   于是一个"库侧没读数"的单子会被判进 `focus` 档、把合并数拖到 0.65。
  //   自证 ㉔e 就是照这个缺陷写的（第一版真栽在这上面）。
  if (confidence === null || confidence === undefined || confidence === '') return null;
  const c = Number(confidence);
  if (!Number.isFinite(c)) return null;
  // ★ 2026-10-16：`1.0` 是 **P0 的记法**（PRD §6.6「置信度记为 1.0」），单独一档 ——
  //   它与 `direct`（0.90–0.99 的代表值 0.93）语义不同：direct 是"够格直接出结论"，
  //   p0 是"确定性命中、不适用分流"。混成一档，下游就没法把 P0 行挑出来（豁免、口径说明都要它）。
  if (c >= 1) return 'p0';
  if (c >= CONF_LINES.direct) return 'direct';
  if (c >= CONF_LINES.confirm) return 'confirm';
  return 'focus';
}

/** 模型侧置信度（**派生**，不让模型自报）。`bothCount` = 双轨确认条数（§④「取交集」那一格）。 */
export function modelConfidenceOf({ model = null, kbCovered = false, bothCount = 0, p0Hit = false } = {}) {
  // ★★ 2026-10-16（Owner 逐字裁定，**以后一句为准**）：
  //   「命中知识库 P0 就是 block，**置信度就是 1**。这时候**不用合并模型侧的置信度**，
  //     这条修复后落库」
  //   ⇒ P0 命中这一档**根本不进入合并**：模型侧那一格记「未参与」（**不是**记 1.0）——
  //     记 1.0 会让台账看起来像"模型侧也算出了一个 1"，而事实是这一档不看它。
  //     （上一版我按「模型侧应该也是 1」记成两侧同档 1.0，口径以本条为准。）
  if (p0Hit) {
    return { band: null, value: null,
             why: '本单 P0 命中 ⇒ 按 PRD §6.6 不适用置信度分流，**模型侧不参与置信度合并**' };
  }
  if (!model || model.ok === false || model.skipped === true) {
    return { band: null, value: null, why: '模型侧未参与（没跑成或跳过）' };
  }
  const items = model.findings ?? [];
  if (items.length === 0) {
    // 与既有边界②一致（「模型侧没报东西就不改结论」）⇒ 它**不拉低**合并数。
    return { band: 'direct', value: CONF_REPRESENTATIVE.direct,
             why: '模型侧没报问题 ⇒ 不拉低（同「模型侧没报东西就不改结论」）' };
  }
  if ((model.dropped ?? []).length) {
    return { band: 'confirm', value: CONF_REPRESENTATIVE.confirm,
             why: `模型侧解析丢掉 ${model.dropped.length} 条 ⇒ 这一侧读数不完整` };
  }
  const missing = items.filter((f) => !String(f?.location ?? '').trim()
                                  || !String(f?.reason ?? '').trim());
  if (missing.length) {
    return { band: 'confirm', value: CONF_REPRESENTATIVE.confirm,
             why: `模型侧 ${missing.length} 条缺位置或缺理由` };
  }
  if (kbCovered !== true) {
    // ★ 这一格是 policy 实测里**真的出现过**的那一类：29 份合并报告里「只有模型侧命中」9 份
    //   （库侧对该题材没有可依据的条款）⇒ 它的命中**没有库内依据**，不该按"确定"计。
    return { band: 'confirm', value: CONF_REPRESENTATIVE.confirm,
             why: '只有模型侧命中（库侧未覆盖）⇒ 无库内依据' };
  }
  // ★★ 2026-10-15 **端到端实测抓到的形状**（真素材 RC-78ce50b3732c）：
  //   库侧 PASS / 0 条 ＋ 模型侧 2 条 ⇒ 合并态 REVIEW，而 v1 只看 `kbCovered`
  //   （它说的是"库里有该题材的条款"，**不是**"库侧命中了问题"）⇒ 给出 direct 0.93，
  //   与它旁边那个 REVIEW **不自洽** —— 正是 Owner 要消灭的那种"数与结论不同源"。
  //   按 §④ 的口径（同一个问题取交集）：**没有一条与库侧配上的命中是分歧，不是互证**。
  if (!(Number(bothCount) >= 1)) {
    return { band: 'confirm', value: CONF_REPRESENTATIVE.confirm,
             why: '模型侧命中了，但没有一条与库侧互证（分歧）⇒ 不按确定计' };
  }
  return { band: 'direct', value: CONF_REPRESENTATIVE.direct,
           why: '模型侧命中且逐条带位置与理由，且有库侧互证' };
}

/**
 * 两侧一起作为输入 ⇒ **一个**数（对外只看这一个）。
 * @returns {{value:number|null, band:string|null, kb_band:string|null,
 *            model_band:string|null, basis:string}}
 */
export function mergedConfidence({ kbConfidence = null, kbCovered = false,
                                   model = null, modelFailed = false, bothCount = 0,
                                   p0Hit = false } = {}) {
  const kbVal = (kbConfidence === null || kbConfidence === undefined || kbConfidence === '')
    ? null
    : (Number.isFinite(Number(kbConfidence)) ? Number(kbConfidence) : null);   // 同上：`null` 不是 0
  const kbBand = bandOf(kbVal);
  const mb = modelConfidenceOf({ model, kbCovered, bothCount, p0Hit });
  // ── ★★ 2026-10-16（Owner 逐字裁定，**以后一句为准**）**P0 那一档最先判、且不进合并** ──
  //   Owner 原话：「**命中知识库 P0 就是 block，置信度就是 1。这时候不用合并模型侧的置信度**，
  //     这条修复后落库」
  //   与 PRD §6.6 末句一致：「P0 层级规则**不适用置信度分流**，命中即 BLOCK，**置信度记为 1.0**。」
  //   ⇒ 命中 P0 ⇒ 置信度 = **1.0**（库侧那个数），**模型侧不参与**（`model_band: null`，
  //     basis 里如实写明）——**不许**被模型侧拉到 0.85（那正是「结论 BLOCK ／ 置信度 0.85」
  //     这种与 §6.6 打架的显示）。
  //   ⚠️ 这一支必须排在 modelFailed / F1 之前：P0 是**确定性匹配**（正则/关键词），
  //     不依赖模型侧跑没跑成，也不适用"库侧没读数就不出数"那条（那说的是**判定**缺失）。
  if (p0Hit || kbBand === 'p0' || mb.band === 'p0') {
    return {
      value: CONF_REPRESENTATIVE.p0, band: 'p0',
      kb_band: kbBand ?? 'p0', model_band: null,
      basis: 'PRD §6.6：**P0 层级规则不适用置信度分流，命中即 BLOCK，置信度记为 1.0** '
        + '⇒ 置信度 = 1.0；**不合并模型侧**（确定性匹配，不受模型侧读数影响）',
    };
  }
  if (mb.band === null || modelFailed) {
    return { value: kbVal, band: kbBand, kb_band: kbBand, model_band: null,
             basis: `本单模型侧未参与 ⇒ 用库侧读数（单轨）｜${mb.why}` };
  }
  if (kbBand === null) {
    // ★★ F1（2026-10-15，Owner 批「开始做」）：库侧**没有读数** ⇒ **不出这个数**。
    //
    //   病灶（拿 100 条真数据离线复算抓到的，不是推测）：库侧拒答／覆盖缺口时
    //   `kbConfidence = null`，而模型侧「0 条命中」返回 **direct** ⇒
    //   「**库侧没有判定 ＋ 模型侧没看出问题**」= **0.93「直接出结论」**。
    //   实测 100 条里 **15 条**是「库侧无读数」，其中 **8 条**正因此拿到 `direct`，
    //   而它们的 expected 是「拒答」（7 条覆盖缺口）⇒ 高置信档判错率 100%。
    //
    //   与 2026-10-07「**库侧没有读数不许落 PASS**」是**同一条纪律**，只是落在置信度这条通道上：
    //   **没有读数 ⇒ 不得产出"确定"**。
    //
    //   为什么不"降成 confirm 留着数"：库侧那条是**唯一有库内依据**的一侧；它没给数时，
    //   模型侧"没看出问题"**不构成置信度**（它恰恰是那个假高置信的来源）。留个 0.85 在那儿，
    //   等于把「库里没有这个题材」继续包装成「机器看过了、基本没问题」。
    //   ⇒ 返回 `value: null`：下游按"**没有做出判定**"处理（0 自带解释，不是零风险）。
    //
    //   反向对照（自证 ㉔e2）：库侧**有**读数时照旧 —— 库侧 0.93 ＋ 模型侧 0 条 ⇒ 仍是 direct 0.93。
    //   少了那条对照，本判据可能只是"所有输入都不给数"的恒真式。
    return { value: null, band: null, kb_band: null, model_band: mb.band,
             basis: `库侧没有置信度读数（拒答/覆盖缺口/未测）⇒ **不出这个数**；模型侧单轨不构成置信度｜${mb.why}` };
  }
  const iKb = CONF_ORDER.indexOf(kbBand); const iMo = CONF_ORDER.indexOf(mb.band);
  const picked = CONF_ORDER[Math.min(iKb, iMo)];
  const lowered = iMo < iKb ? '模型侧' : (iKb < iMo ? '库侧' : null);
  return {
    value: CONF_REPRESENTATIVE[picked], band: picked,
    kb_band: kbBand, model_band: mb.band,
    basis: lowered
      ? `两侧按 PRD §6.6 三档**取更保守一侧**：${lowered}拉低（库侧 ${kbBand} ／ 模型侧 ${mb.band}）｜${mb.why}`
      : `两侧同档（${kbBand}）｜${mb.why}`,
  };
}

/** 合并结果的指纹：同一对输入必须同输出（用来做「确定性」断言）。 */
export function fingerprint(merged) {
  return createHash('sha256')
    .update(JSON.stringify(merged.map((f) => [f.location, f.category, f.severity, f.source])))
    .digest('hex').slice(0, 16);
}

/* ═══════════════════════════ 自证 ═══════════════════════════ */
/**
 * 六条矩阵规则逐条断言 + 两条反向对照。
 *
 * 为什么每一条都要有：这六行是**方案里逐字写下的判定规则**，而它们全都长得像
 * 「合并两张表」这种一看就懂、写起来却很容易把某一支写反的东西。
 * ★ 尤其第 6 条（任一侧没覆盖 → 拒答）：它是**唯一挡住「加了模型侧就把原来拒答的
 *   单子放行」**的那一行。少了它，双轨改造会静默变成一次**安全放松**（§2.4.1）。
 */
export function selftest() {
  let pass = 0; const bad = [];
  const ok = (n) => { pass++; console.log(`  ✅ ${n}`); };
  const no = (n, why) => { console.log(`  ❌ ${n} —— ${why}`); bad.push(n); };
  const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want)
    ? ok(n) : no(n, `期望 ${JSON.stringify(want)}，实得 ${JSON.stringify(got)}`));

  const F = (location, category, severity, extra = {}) => ({ location, category, severity, ...extra });

  // ① 同题同论 → 取交集
  {
    const r = mergeFindings([F('00:12', '合规', 'BLOCK', { article_no: 'W-1.1' })],
                            [F('00:12', '合规', 'BLOCK')]);
    eq('① 同题同论 → 取交集，严重度按该问题计入', [r.items.length, r.items[0].severity, r.items[0].source],
       [1, 'BLOCK', 'both']);
    eq('① 库侧依据被带出来（条款号）', r.items[0].kb.article_no, 'W-1.1');
  }
  // ② 同题冲突 ────────────────────────────────────────────────────────────────
  // ★★ 2026-10-17（Owner 第三次拿报告来问「总结论是 block，但是分论点是 review」）：
  //   冲突**不再一律降 REVIEW** —— 库侧的 BLOCK 只可能来自 P0 确定性命中，
  //   让一条模型侧意见把它降级，等于用意见推翻读数（也违反 PRD §6.6 与单调性）。
  //   两条方向分别钉住：库侧 BLOCK 保住；模型侧 BLOCK 不许单独立案。
  {
    const r = mergeFindings([F('00:12', '合规', 'BLOCK')], [F('00:12', '合规', 'REVIEW')]);
    eq('② 冲突：**库侧 P0 ⇒ 保 BLOCK、不降级**', [r.items.length, r.items[0].severity, r.items[0].source],
       [1, 'BLOCK', 'both']);
    eq('② 保 BLOCK 时两侧依据都留着（供人复核）', [!!r.items[0].kb, !!r.items[0].model], [true, true]);
    eq('② 来源标记不能挂 both-conflict（那个标记在渲染层写着「已降 REVIEW」）',
       /已降 REVIEW/.test(String(r.items[0].note)), false);
    // 反向对照：模型侧报 BLOCK、库侧只有 REVIEW ⇒ **仍然降 REVIEW**（模型不许单独定案）
    const r2 = mergeFindings([F('00:12', '合规', 'REVIEW')], [F('00:12', '合规', 'BLOCK')]);
    eq('② 反向：模型侧 BLOCK ＋ 库侧 REVIEW ⇒ 仍降 REVIEW',
       [r2.items.length, r2.items[0].severity, r2.items[0].source], [1, 'REVIEW', 'both-conflict']);
  }
  // ③ 仅库侧 → 走并集，按其严重度计入
  {
    const r = mergeFindings([F('图 1', '消费者安全', 'BLOCK', { article_no: 'S-1.2' })], []);
    eq('③ 仅库侧 → 保留且按其严重度', [r.items.length, r.items[0].severity, r.items[0].source],
       [1, 'BLOCK', 'kb']);
  }
  // ④ 仅模型侧 → 保留，但**不由它单独定 BLOCK**
  {
    const r = mergeFindings([], [F('00:08', '消费者安全', 'BLOCK', { reason: '安全座椅' })]);
    eq('④ 仅模型侧报 BLOCK → 降为 REVIEW', [r.items[0].severity, r.items[0].source],
       ['REVIEW', 'model']);
    eq('④ 它原本要的严重度如实记着（不假装它没说过）', r.items[0].asked_severity, 'BLOCK');
    eq('④ 标注「无库内依据」', /无库内依据/.test(r.items[0].note), true);
  }
  // ④b ★ 模型侧**依据链接**（2026-10-13 Owner：「模型侧输出的问题需要带上依据」）
  //     判据三层：挑中来源 ⇒ 卡里带**真链接**；挑不出 ⇒ 明说没有；手写 URL ⇒ **必须被丢掉**。
  {
    const blkOf = (src) => renderMerged(
      mergeFindings([], [F('全文', '合规', 'REVIEW',
        { reason: 'FDA 批准表述', excerpt: 'FDA approved', suggestion: '删掉', source: src })]).items,
      { state: 'REVIEW', kb: kbSideOf({ review: { state: 'REVIEW', issue_count: 1 } }), kbTextCount: 0 }).block;
    const ok1 = blkOf('S11');
    eq('④b 挑中已登记来源 ⇒ 依据行带真链接（fda.gov）',
       [/fda\.gov/.test(ok1), /外部标准/.test(ok1)], [true, true]);
    const no1 = blkOf(null);
    // ★★ 2026-10-22（Owner：「依据文档链接，是需要提供证明这是个问题的外部链接…
    //   『送审素材原文：「Ask Midwife Vic」』更像是问题描述」）——
    //   这一格**不许**再拿素材原文冒充依据，而是如实说「无外部依据」。
    //   三面一起钉：① 不许凭空冒出链接；② 必须出现「无外部依据」；
    //   ③ **素材原文那几个字不许再出现在依据格里**（它已印在问题描述/命中描述）。
    const _basisLineOf = (md) => (md.split('\n').find((l) => l.includes('依据')) || '').trim();
    eq('④b2 ★ 无外部来源 ⇒ 依据格写「无外部依据」，**不再**拿素材原文冒充依据',
       [/https?:\/\//.test(_basisLineOf(no1)), /无外部依据/.test(_basisLineOf(no1)),
        /送审素材原文/.test(no1), /FDA approved/.test(_basisLineOf(no1))], [false, true, false, false]);
    // ④b4 ★ 模型**自写 URL** 这条路（Owner 亲口：「当然有权限写 url」）——
    //      必须印出来、且带核验状态；核验说「未核」时也必须照印（不许因为取不到就删掉）。
    const F2 = (extra) => ({ location: '全文', category: '合规', severity: 'REVIEW',
      reason: '平台举证要求', suggestion: '补', ...extra });
    const blkUrl = (probe) => renderMerged(
      mergeFindings([], [F2({ source_url: 'https://advertising.amazon.com/help/G6UU66YLSCUYDULQ',
        source_name: 'Amazon Ads · Claims and substantiation', url_probe: probe })]).items,
      { state: 'REVIEW', kb: kbSideOf({ review: { state: 'REVIEW', issue_count: 1 } }), kbTextCount: 0 }).block;
    const u1 = blkUrl({ state: 'ok', http: 200 });
    eq('④b4 ★ 模型自写 URL ⇒ 印出来且标「已核」',
       [/advertising\.amazon\.com/.test(u1), /✅ 已核（HTTP 200）/.test(u1)], [true, true]);
    const u2 = blkUrl({ state: 'unreachable', why: '超时' });
    eq('④b5 ★ 反向对照：取不到也**不许删链接**，只标「未核」',
       [/advertising\.amazon\.com/.test(u2), /未核/.test(u2)], [true, true]);

    const bad1 = blkOf('https://evil.example/fake');
    // ★ ④b3 **口径已变**（Owner 2026-10-13：「模型当然有权限写 url」）：原先断言
    //   「手写 URL 一律丢掉」—— 那是我定的、过头了的规矩。现在 URL 走 `source_url`
    //   这条正规路（照印 + 核验状态，见 ④b4/④b5）；而塞进**闭集 id 那一格**（`source`）
    //   的 URL 仍然不算数：那一格只认 S1…S17，链接一律由 `ext_basis` 按登记表挂。
    eq('④b3 ★ 口子分开：URL 塞进「来源 id」那一格 ⇒ 不算数；依据格如实说「无外部依据」',
       [/evil\.example/.test(bad1), /无外部依据/.test(_basisLineOf(bad1)),
        /送审素材原文/.test(bad1)], [false, true, false]);
  }
  // ④c ★ 逐条依据**落库**（Owner 2026-10-13：「这个要落库」）
  {
    const items = mergeFindings(
      // ⚠️ 夹具形状要照 `kbFindingsOf()` 的**产出**来：`basisLine` 在**条目顶层**
      //   （塞进 `kb:{}` 里会被 `pickKb` 白名单丢掉 —— 我第一版就是这么写的，实测那条没进块）
      [{ location: '全文', category: '措辞表达', severity: 'REVIEW',
         article_no: 'W-1.33', anchor: '#广告文案明细/recv/命中片段',
         basisLine: '依据：《措辞表达库 v0》第 W-1.33 条 ← 逐字命中「最好」｜原始出处：https://momcozy-in.feishu.cn/base/X?record=recv' }],
      //   ⚠️ 两条模型侧条目**类目必须不同**：同位置同类目会被合并成一条（合并规则第一条），
      //      那样就测不出「没有依据的那条不列」。
      [F('全文', '合规', 'REVIEW', { reason: 'FDA 批准表述', suggestion: '删', source: 'S11' }),
       F('第 2 段', '本地化', 'REVIEW', { reason: '没有依据的那条', suggestion: 'x' })]).items;
    const blk = evidenceBlock(items);
    eq('④c 落库块：库侧那条用**它自己的** basisLine（带飞书直链，原样搬）',
       [/逐字命中「最好」/.test(blk), /feishu\.cn\/base/.test(blk)], [true, true]);
    eq('④c2 ★ 模型侧那条把**依据 URL** 落进表里（fda.gov）',
       [/fda\.gov/.test(blk)], [true]);
    eq('④c3 ★ 反向对照：**没有依据的条目一条都不列**（凑数就是撒谎）',
       [/没有依据的那条/.test(blk)], [false]);
    eq('④c4 上限：超过 max 条时明确说「其余见报告」',
       evidenceBlock(items, { max: 1 }).includes('另有 1 条'), true);
    eq('④c5 有依据的条目**全部**列出（库侧 1 + 模型侧 1 = 2 条）',
       (evidenceBlock(items).match(/^\d+\.【/gm) || []).length, 2);
  }
  // ⑤ 两侧都没问题 + 两侧都覆盖 → PASS（方案说这是 PASS 唯一的成立方式）
  {
    const r = mergeFindings([], []);
    eq('⑤ 两侧都没问题且库侧覆盖 → PASS', mergedState({ kbCovered: true, merged: r.items }), 'PASS');
  }
  // ⑥ ★ 任一侧没覆盖 → 拒答，**不得输出 PASS**
  {
    const r = mergeFindings([], []);
    eq('⑥ 库侧没覆盖 → 拒答（不许 PASS）', mergedState({ kbCovered: false, merged: r.items }), '拒答');
    // 反向对照：**模型侧有命中**时，也绝不许因为「有内容可说了」就变成 PASS
    const r2 = mergeFindings([], [F('全片', '措辞表达', 'REVIEW')]);
    eq('⑥ 反向对照：模型侧只有命中、库侧没覆盖 → REVIEW（仍不是 PASS）',
       mergedState({ kbCovered: false, merged: r2.items }), 'REVIEW');
  }
  // ⑥b ★★ 2026-10-14：**模型侧没跑成 ⇒ 同样不许 PASS**（与库侧那条对称）
  //
  //   病灶逐字可核：`MC-US-AMZ-B0CWLHKQNT` —— 模型侧输出 JSON 解析失败
  //   （`raw` 里字符串内含未转义双引号），`modelFailed=true` 只写进查证笔记、
  //   **没进合并态** ⇒ 模型侧按「0 条」参与合并 ⇒ 库侧安全词覆盖 → **落 PASS**。
  //   PASS 是唯一的「放行」态：模型侧压根没判，却说「可以发」。
  {
    // 库侧确实覆盖了（安全词）—— 若只看库侧，这一单就是 PASS
    // ⚠️ `kb` 必须**像一份真读数**：`kbNoReadingOf` 要求 `hasSidecar===true` ＋ `state` 非空，
    //    否则会先被「库侧没读数」那条挡掉，本组就变成恒真（第一版就栽在这，反向对照全红）。
    const kbOk = { hasSidecar: true, state: 'PASS', reportUrl: 'https://x/docx/1' };
    eq('⑥b 前置：这份 kb 算「有读数」（否则本组恒真）',
       kbNoReadingOf(kbOk), false);
    eq('⑥b 模型侧没跑成 ⇒ 不出 PASS（库侧覆盖也不够）',
       mergedState({ kbCovered: true, merged: [], kb: kbOk, modelFailed: true }), '拒答');
    // ★ 反向对照：模型侧**跑成了、只是没报东西** ⇒ 仍必须能 PASS
    //   （否则就是把「模型没跑」与「模型跑了没发现」混成一件事 —— 那正是本条要修的病）
    eq('⑥b 反向对照：模型侧跑成了、没报东西 ⇒ 仍可 PASS（不许一刀切）',
       mergedState({ kbCovered: true, merged: [], kb: kbOk, modelFailed: false }), 'PASS');
    // ★ 反向对照 ②：默认值（老调用方不传）行为**一个字不变**
    eq('⑥b 反向对照：不传 modelFailed ⇒ 与改动前逐字相同（向后兼容）',
       mergedState({ kbCovered: true, merged: [], kb: kbOk }), 'PASS');
    // ★ 单向：模型侧没跑成**不许**把已有的命中降级（只挡 PASS）
    const rHit = mergeFindings([], [F('全文', '合规', 'REVIEW')]);
    eq('⑥b 单向：模型侧没跑成、但已有命中 ⇒ 仍是 REVIEW（只挡 PASS，不动别的）',
       mergedState({ kbCovered: true, merged: rHit.items, kb: kbOk, modelFailed: true }), 'REVIEW');
  }
  // ⑦ 恒等式：合并只许去重，不许凭空多出/静默吞掉
  {
    const r = mergeFindings([F('a', 'x', 'REVIEW'), F('a', 'x', 'REVIEW')],
                            [F('b', 'y', 'REVIEW'), F('a', 'x', 'REVIEW')]);
    eq('⑦ 合成前后条数守恒（同一侧同键合并成一条）',
       [r.stats.identity_ok, r.items.length, r.stats.kb, r.stats.model], [true, 2, 2, 2]);
  }
  // ⑦b 一条历史记录会拆成 point/advice 多条规则；按同位置/类目去重时，
  // 具体建议与条款号必须并入卡面字段，不能只留在不可见的 raw 数组里。
  {
    const kb = [
      F('图 1 第 8 处', '产品安全与高危使用场景', 'REVIEW', {
        article_no: 'N-1.307', basisLine: '《历史意见》第 N-1.307 条｜源记录 A',
        suggestionLine: null, kb: { article_no: 'N-1.307', basisLine: '《历史意见》第 N-1.307 条｜源记录 A' },
      }),
      F('图 1 第 8 处', '产品安全与高危使用场景', 'REVIEW', {
        article_no: 'N-1.364', basisLine: '《历史意见》第 N-1.364 条｜源记录 A',
        suggestionLine: '同房不同床，宝宝睡独立婴儿床',
        kb: { article_no: 'N-1.364', basisLine: '《历史意见》第 N-1.364 条｜源记录 A',
              suggestionLine: '同房不同床，宝宝睡独立婴儿床' },
      }),
      F('图 1 第 8 处', '产品安全与高危使用场景', 'REVIEW', {
        article_no: 'N-1.365', basisLine: '《历史意见》第 N-1.365 条｜源记录 A',
        suggestionLine: '使用硬质平整婴儿床，移除枕头和松散毯子',
        kb: { article_no: 'N-1.365', basisLine: '《历史意见》第 N-1.365 条｜源记录 A',
              suggestionLine: '使用硬质平整婴儿床，移除枕头和松散毯子' },
      }),
    ];
    const r = mergeFindings(kb, []);
    const item = r.items[0];
    const block = renderMerged(r.items, { state: 'REVIEW' }).block;
    eq('⑦b 同一问题的 KB 建议去重后仍完整进入结构化卡面字段',
       [r.items.length, item.kb.suggestionLine, item.kb.basisLine.includes('N-1.307'),
        item.kb.basisLine.includes('N-1.364'), item.kb.basisLine.includes('N-1.365')],
       [1, '同房不同床，宝宝睡独立婴儿床；使用硬质平整婴儿床，移除枕头和松散毯子', true, true, true]);
    eq(`⑦b 卡面在 ${ADVICE_MAX} 字约束内显示库内建议；完整清单须留在报告`,
       [block.includes('同房不同床，宝宝睡独立婴儿床'), /\*\*建议\*\*：[^\n]{0,60}/.test(block)], [true, true]);
    const withGenerated = { ...item, advice: '删去机构署名', adviceReferencedKb: false };
    const generatedCard = renderMergedItem(withGenerated, 0, { must: false, layout: 'card' });
    const generatedReport = renderMergedItem(withGenerated, 0, { must: false, layout: 'report' });
    // ★★ 2026-10-22 **当天改过口径，后令优先**（Owner：「卡上那份建议是历史原文，查」）：
    //   原断言（同日早些时候）钉的是「**聚合的库内建议优先**，生成的那份不上卡」。
    //   实测代价：`建议生成` 跑成功、日志写「覆盖 1 条」，而卡上印的仍是历史原文，
    //   且**表里存的是生成的那份** ⇒ 卡与表对不上。
    //   ⇒ 现在：**卡上给本单生成的改法**；库内完整清单留在**报告**（⑦b 已经钉着
    //     「完整清单须留在报告」，两条一起构成「卡短、报告全」）。
    //     ⚠️ 这不是放宽：报告侧一个字没动，仍逐条给库内建议。
    eq('⑦b2 卡上给本单生成的改法；库内聚合建议留在报告（卡短、报告全）',
       [generatedCard.includes('同房不同床，宝宝睡独立婴儿床'),
        generatedCard.includes('删去机构署名'),
        generatedReport.includes('同房不同床，宝宝睡独立婴儿床'),
        generatedReport.includes('移除枕头和松散毯子'),
        generatedReport.includes('删去机构署名')], [false, true, true, true, false]);
  }
  // ⑦c 2026-10-22（Owner：「依据文档链接输出了 6 条一样的链接，预期是同样的问题输出一条」）：
  //   同一份记录的多条规则共用**同一个 URL** —— 依据行必须每条条款一次、
  //   同一个 URL 只留一条「原始出处」，而且链接化时不许把后面的中文吞进 URL。
  {
    const mk = (n) => F('图 1 第 2 处', '产品安全与高危使用场景', 'REVIEW', {
      article_no: `N-1.${n}`,
      basisLine: `《内部正负样本库》第 N-1.${n} 条｜锚点：#负面样本/rec…｜原始出处：https://x.test/rec`,
      kb: { article_no: `N-1.${n}`, anchor: '#负面样本/rec…',
            basisLine: `《内部正负样本库》第 N-1.${n} 条｜锚点：#负面样本/rec…｜原始出处：https://x.test/rec` },
    });
    const item = mergeFindings([mk(307), mk(312), mk(364), mk(365)], []).items[0];
    const basis = String(item.kb.basisLine);
    const segs = basis.split('；');
    const arts = segs.map((s) => (s.match(/第 (N-1\.\d+) 条/) || [])[1]).filter(Boolean);
    const report = renderMergedItem(item, 0, { layout: 'report' });
    eq('⑦c 同键 4 条依据 ⇒ 4 段，每条条款只出现一次（不许复合重复）',
       [segs.length, new Set(arts).size, arts.length], [4, 4, 4]);
    eq('⑦c 同一个 URL 在依据行里只留一条「原始出处」',
       (basis.match(/https:\/\/x\.test\/rec/g) || []).length, 1);
    eq('⑦c 报告里的链接化不许把中文吞进 URL（`；` 必须在链接外）',
       /\[点开核对\]\([^)]*[；;]/.test(report), false);
    eq('⑦c 报告里可点的依据链接仍有且仅有一条',
       (report.match(/\[点开核对\]\(https:\/\/x\.test\/rec\)/g) || []).length, 1);
  }
  // ⑦d 2026-10-22（Owner：「依据文档链接里就一条链接怎么写这么多字？表格名称+飞书链接就好」）：
  //   依据格收成 PRD §5.3.3 的形状 —— 表格名一次、条款号一串、链接一条。
  {
    const raw = '《内部正负样本库》第 N-1.307 条｜锚点：#x｜原始出处：https://x.test/rec'
      + '；《内部正负样本库》第 N-1.312 条；《内部正负样本库》第 N-1.364 条';
    const out = compactBasisLine(raw);
    eq('⑦d 表格名只出现一次、条款号并成一串、链接只一条（PRD 句式）',
       [out, (out.match(/《内部正负样本库》/g) || []).length,
        (out.match(/https:\/\/x\.test\/rec/g) || []).length],
       ['《内部正负样本库》第 N-1.307、N-1.312、N-1.364 条（链接：[点开核对](https://x.test/rec)）', 1, 1]);
    // 反向对照：不同 URL 的两条条款**不许**被并到同一条链接下（那是把两个回源入口说成一个）
    const two = compactBasisLine('《库》第 A-1.1 条｜原始出处：https://x.test/a'
      + '；《库》第 A-1.2 条｜原始出处：https://x.test/b');
    eq('⑦d 反向对照：不同 URL 各留各的链接',
       (two.match(/https:\/\/x\.test\/[ab]/g) || []).length, 2);
    // 反向对照：外部标准没有「第 X 条」⇒ 原样放过，不许套进条款句式
    const ext = 'FTC《Guidance》 → https://www.ftc.gov/x';
    eq('⑦d 反向对照：外部标准那条原样返回（不套「第 版本 条」）', compactBasisLine(ext), ext);
  }
  // ⑦e 2026-10-22（Owner：「命中知识库规则的，只写问题描述，不写历史两个字，改说法」）：
  //   条款原文 → 中性事实；**不出现「爸爸/宝宝/主标题」这些别的素材的细节**。
  {
    const real = '主标题醒目柔和，画面是宝宝跟爸爸同床，并且睡在柔软的枕头上'
      + '（画面是新手爸爸带婴儿错误睡觉，呈现危险的错误场景）';
    eq('⑦e 条款原文压成中性事实（人称中性化、载体前缀去掉）',
       neutralHistoryFacts(real), '婴幼儿跟成人同床，并且睡在柔软的枕头上');
    eq('⑦e 反向对照：纯「建议」句抽不出事实 ⇒ 空串（由调用方如实写「条款所列情形」）',
       neutralHistoryFacts('建议：同房不同床，宝宝睡独立婴儿床'), '');
    // 接线级：N-0x 条目走引擎 JSON 这条来路时，问题描述与原因都不许再出现「历史/相似/匹配分」
    const eng = { decision: { state: 'REVIEW', issue_count: 1, risk_items: [{
      risk_type: '负面样本-N-02', location: '顶部，图 1 第 2 处', action: 'review',
      reason: '相似历史审核意见（point·参考）：匹配分 1.00（画面 1.00 / 文字 0.70）｜⚠️ 非本单素材逐字命中',
      history_rule_text: real, rule_code: 'N-02',
      suggestion: '同房不同床，宝宝睡独立婴儿床',
      evidence: { library: '内部正负样本库（负面样本规则·历史审核意见）',
                  article_no: 'N-1.307', anchor: '#负面样本/rec…', excerpt: '',
                  l0_entry_url: 'https://x.test/rec' },
    }] } };
    const f = kbFindingsOf('', eng).findings[0];
    eq('⑦e 接线：问题描述=中性事实，原因里不许有「历史/相似/匹配分」',
       [f.description, /历史|相似|匹配分/.test(String(f.reason))],
       ['婴幼儿跟成人同床，并且睡在柔软的枕头上', false]);
    const rep = renderMergedItem(mergeFindings([f], []).items[0], 0, { layout: 'report' });
    eq('⑦e 报告里那一格不许再出现「历史审核意见（point·参考）」「匹配分」',
       [/历史审核意见（point/.test(rep), /匹配分/.test(rep)], [false, false]);
  }
  // ⑧ 确定性：同一对输入必须同输出（合并里不许有随机/时间）
  {
    const kb = [F('00:12', '合规', 'BLOCK', { article_no: 'W-1.1' })];
    const mo = [F('00:12', '合规', 'BLOCK'), F('图 1', '隐私', 'REVIEW')];
    const a = fingerprint(mergeFindings(kb, mo).items);
    const b = fingerprint(mergeFindings(kb, mo).items);
    eq('⑧ 同输入同输出（指纹一致）', a === b, true);
    // 反向对照：**换一个字段**就必须换指纹，否则这条断言恒真、什么也没测
    // 反向对照：**换一个严重度**就必须换指纹 —— 否则这条断言对「指纹」恒真、什么也没测。
    const c = fingerprint(mergeFindings(kb, [F('图 1', '隐私', 'BLOCK')]).items);
    eq('⑧ 反向对照：严重度变了指纹必须变', c !== a, true);
  }
  // ⑨ 反向对照：**位置不同但类目相同 → 不许合并成一条**（对齐规则是两者都要）
  {
    const r = mergeFindings([F('00:12', '合规', 'BLOCK')], [F('00:08', '合规', 'BLOCK')]);
    eq('⑨ 反向对照：位置不同、类目相同 → 仍是两条（并集）', r.items.length, 2);
    const r2 = mergeFindings([F('00:12', '合规', 'BLOCK')], [F('00:12', '安全', 'BLOCK')]);
    eq('⑨ 反向对照：位置相同、类目不同 → 仍是两条（并集）', r2.items.length, 2);
  }

  // ⑩ ★★ **红线不许被降级**（2026-10-07 实测缺陷的回归判据，**必须能红**）─────────────
  //    病灶：库侧判到 **3 条 P0**（H06/H07/H09）时，PRD §5.3.3 要求只出分类汇总 ⇒
  //    逐条正则抠不到 ⇒ 库侧被读成「0 条」⇒ 合并把 BLOCK 改写成 REVIEW。
  //    实测那两条真素材：2 条 ⇒ 抽到 2 条（结论保住 BLOCK）；3 条 ⇒ 抽到 0 条（**降级**）。
  {
    const p0 = kbSideOf({ p0_fastpath: { rule_codes: ['H06', 'H07', 'H09'] }, issue_count: 3 });
    eq('⑩ P0 快路的结构化读数：结论 BLOCK ／ 条数 3',
       [p0.state, p0.issueCount, p0.refused], ['BLOCK', 3, false]);
    const modelTwo = [F('全文', '合规', 'REVIEW'), F('全文', '消费者安全', 'REVIEW')];
    const st = mergedState({ kbCovered: true, merged: modelTwo, kb: p0 });
    eq('⑩ ★ 库侧 3 条 BLOCK ＋ 文本抽出 0 条 ⇒ 合并态必须是 BLOCK（不许降级成 REVIEW）', st, 'BLOCK');
    // 反向对照（防「这条断言恒真」）：**库侧不是 BLOCK** 时，同一批模型侧条目只能到 REVIEW
    const p0r = kbSideOf({ review: { state: 'REVIEW', issue_count: 1 } });
    eq('⑩ 反向对照：库侧 REVIEW ＋ 同一批模型侧条目 ⇒ 合并态 REVIEW（不是 BLOCK）',
       mergedState({ kbCovered: true, merged: modelTwo, kb: p0r }), 'REVIEW');
    // 渲染：库侧条数**必须留着**，且明说明细未并进来、总数是上限。
    // ★★ 2026-10-13（Owner 裁定）：这一族读数**不上卡** —— 改走 `internalNotes`
    //   （模型上下文 + **会话记忆**），卡片与报告都不显示。
    //   判据因此分两面，缺一面都不算数：**笔记里必须有**（一个字没丢）
    //   ＋ **卡面上必须没有**（是搬，不是删）。
    const rd = renderMerged(modelTwo, { state: 'BLOCK', kb: p0, kbTextCount: 0 });
    eq('⑩ 库侧条数＋总数上限＋「明细未并进来」要留着（在查证笔记里）',
       [rd.total, /结构化读数 BLOCK\/3/.test(rd.internalNotes), /上限/.test(rd.internalNotes)],
       [5, true, true]);
    eq('⑩ 反向对照：同一段**不许**再出现在卡面（Owner 2026-10-13：不上卡）',
       [/结构化读数/.test(rd.block), /上限/.test(rd.block)], [false, false]);
  }

  // ⑪ ★★ **库侧拒答 ⇒ 不许出三态结论**（2026-10-07；同一天五条里两条栽在这上面）─────────
  //    病灶：拒答被折算成「0 条」⇒ 用户收到一张像双轨结论的 REVIEW 卡，而表里那行是 NEEDS_INPUT。
  {
    const refused = kbSideOf({ review: { state: 'NEEDS_INPUT', issue_count: 0,
      refusal: { state: 'NEEDS_INPUT', reason: '供给链不新鲜' } } });
    eq('⑪ 机读旁挂的拒答被认出来（**没有 reason_code 也要认**，实测超期拒答只有中文 reason）',
       [refused.refused, refused.reason], [true, '供给链不新鲜']);
    const st = mergedState({ kbCovered: true, merged: [F('全文', '合规', 'REVIEW')], kb: refused });
    eq('⑪ 库侧拒答 ⇒ 合并态 = NEEDS_INPUT（不是 REVIEW）', st, 'NEEDS_INPUT');
    const rd = renderMerged([F('全文', '合规', 'REVIEW')], { state: st, kb: refused, kbTextCount: 0 });
    eq('⑪ 卡里必须写明「不得当通过依据，也不得当拦截依据」',
       [/不得当通过依据/.test(rd.block), /NEEDS_INPUT/.test(rd.line)], [true, true]);
    // 反向对照：**没有 refusal** 的正常 REVIEW 单不许被判成拒答
    const notRefused = kbSideOf({ review: { state: 'REVIEW', issue_count: 1 } });
    eq('⑪ 反向对照：正常 REVIEW 单不许被判成拒答', notRefused.refused, false);
    // ★★ ⑪c **判据不许过宽**：覆盖缺口的形状是「顶层 REVIEW ＋ refusal.state=NEEDS_INPUT」
    //    （`with_kb_evidence.py` 注释原话：「这里如实写 REVIEW：下游读的是这个字段」）。
    //    第一版「有 refusal 就算拒答」把它也改判成 NEEDS_INPUT —— 当天实测逼出来的。
    const cov = kbSideOf({ review: { state: 'REVIEW', issue_count: 1,
      refusal: { state: 'NEEDS_INPUT', reason_code: 'coverage_not_covered',
                 coverage: { covered: false } } } });
    eq('⑪c 覆盖缺口：**不算拒答**（认顶层 state=REVIEW），但要标出 coverageGap',
       [cov.refused, cov.state, cov.coverageGap], [false, 'REVIEW', true]);
    const stCov = mergedState({ kbCovered: false,
      merged: [F('全文', '合规', 'REVIEW')], kb: cov });
    eq('⑪c2 覆盖缺口的合并态 = REVIEW（不是 NEEDS_INPUT）', stCov, 'REVIEW');
    const rdCov = renderMerged([F('全文', '合规', 'REVIEW')],
      { state: stCov, kb: cov, kbTextCount: 0 });
    eq('⑪c3 「库对该题材没有可依据的条款 / 不是发现了内容问题」要留着（在查证笔记里）',
       [/没有可依据的条款/.test(rdCov.internalNotes),
        /不是发现了内容问题/.test(rdCov.internalNotes)], [true, true]);
    eq('⑪c3b 反向对照：这段不许再上卡（Owner 把那句原话列进了「都去掉」）',
       [/coverage_not_covered/.test(rdCov.block), /没有可依据的条款/.test(rdCov.block)], [false, false]);
  }

  // ── ⑪z 「命中 0 条 ⇒ PRD §5.3.1 一句话 PASS」（Owner 2026-10-26）────────────
  //   病灶：A 机实发「命中 0 条」却给 `REVIEW / 待放行 / coverage = partial`。
  //   判据的三条边界各配一条反向对照 —— 只放行**严格 0 条并且两侧都真跑过**的那一档。
  {
    const kbRev = (n, extra = {}) => ({ state: 'REVIEW', issueCount: n, ...extra });
    eq('⑪z1 命中 0 条（库侧 REVIEW/0，连 coverageGap 都没标）⇒ PASS',
       mergedState({ kbCovered: true, merged: [], kb: kbRev(0) }), 'PASS');
    eq('⑪z2 命中 0 条 + 覆盖缺口标记 ⇒ 仍 PASS（两只时代形状一致）',
       mergedState({ kbCovered: true, merged: [], kb: kbRev(0, { coverageGap: true }) }), 'PASS');
    // 反向对照 ①②：不是 0 条 / 读不到条数 ⇒ 都不许放行（PASS 是唯一的放行态）
    eq('⑪z3 反向对照：真有 1 条问题（非缺口）⇒ 仍是 REVIEW，不许被 0 条那条放松',
       mergedState({ kbCovered: true, merged: [], kb: kbRev(1) }), 'REVIEW');
    eq('⑪z4 反向对照：读不到条数（null）⇒ 不许 PASS（读不到 ≠ 零条）',
       mergedState({ kbCovered: true, merged: [], kb: kbRev(null) }), 'REVIEW');
    // 反向对照 ③：模型侧没跑成 ⇒ 库里 0 条也不许放行（没审过的单不许说「可以发」）
    eq('⑪z5 反向对照：模型侧没跑成（modelFailed）⇒ 0 条也不放行',
       mergedState({ kbCovered: true, merged: [], kb: kbRev(0), modelFailed: true }) !== 'PASS', true);
    // 反向对照 ④：库侧拒答 ⇒ 拒答优先，别被 0 条那条抢走
    eq('⑪z6 反向对照：库侧拒答（refused）⇒ NEEDS_INPUT，0 条也不能翻成 PASS',
       mergedState({ kbCovered: true, merged: [], kb: { state: 'REVIEW', issueCount: 0, refused: true } }),
       'NEEDS_INPUT');
    // ★★ 2026-11-03（Owner：覆盖缺口可出 PASS + SUGGEST）：PASS 卡上要带业务建议，
    //   内部口径（coverage_not_covered）仍只进 internalNotes、不上卡。
    {
      const gapKb = kbRev(0, { coverageGap: true });
      const gapState = mergedState({ kbCovered: true, merged: [], kb: gapKb });
      const gapCard = renderMerged([], { state: gapState, kb: gapKb, kbTextCount: 0 });
      eq('⑪z7 覆盖缺口 PASS 卡上带「建议补充库覆盖」',
         [gapState, /建议：知识库对该题材暂无审查依据/.test(String(gapCard?.block))], ['PASS', true]);
      eq('⑪z7b 内部口径不上卡', /coverage_not_covered/.test(String(gapCard?.block)), false);
      const noGap = kbRev(0);
      const noGapState = mergedState({ kbCovered: true, merged: [], kb: noGap });
      eq('⑪z7c 反向对照：无覆盖缺口的 PASS 不出建议',
         renderMerged([], { state: noGapState, kb: noGap, kbTextCount: 0 }), null);
    }
  }

  // ⑫ 向后兼容：不给 `kb`（读不到旁挂）时，判据必须与改动前**逐字相同**
  {
    eq('⑫ 反向对照：不给 kb ⇒ PASS 门限与原来一致（覆盖成立才 PASS）',
       [mergedState({ kbCovered: true, merged: [] }), mergedState({ kbCovered: false, merged: [] })],
       ['PASS', '拒答']);
    eq('⑫ 反向对照：不给 kb ⇒ 有条目就是 REVIEW（同原来）',
       mergedState({ kbCovered: true, merged: [F('a', 'x', 'REVIEW')] }), 'REVIEW');
  }

  // ⑬ ★★ 2026-10-07（Owner 同意）—— **库侧没有读数 ⇒ PASS 不可达**。
  //   实测缺陷（不是假设）：素材「这条社媒文案能不能发：这批婴幼儿用品的文案里写了医用级」
  //   （表行 `recvxlAvpEWMIX`）—— 日志 `[review] ⚠️ 没读到机读旁挂` ⇒ 库侧**零读数**，
  //   而表里落的是 `Agent 结论=PASS` / `状态=PASS` / `问题数量 0` / `置信度 0`。
  //   同一批另一条（旁挂读到了、`state=NEEDS_INPUT`）落的是 NEEDS_INPUT/待审 ⇒
  //   差别不在素材，在**有没有读数**。
  {
    const noRead = kbSideOf({ answer: '（链的回答原文，但没有任何机读旁挂）' });
    eq('⑬a 无旁挂 ⇒ 认得出「库侧没有读数」',
       [noRead.hasSidecar, noRead.state, kbNoReadingOf(noRead)], [false, '', true]);
    eq('⑬b 库侧没读数 ⇒ 合并态**不许**是 PASS（就算覆盖信号说成立也不许）',
       mergedState({ kbCovered: true, merged: [], kb: noRead }), '拒答');
    eq('⑬c 库侧没读数、模型侧有意见 ⇒ REVIEW（要人看，但绝不是放行）',
       mergedState({ kbCovered: true, merged: [F('全文', '合规', 'REVIEW')], kb: noRead }), 'REVIEW');
    // 反向对照：**有读数**时 PASS 照旧可达 —— 这条闸只挡「没读数」，不是把 PASS 一刀切掉
    const withRead = kbSideOf({ review: { state: 'PASS', issue_count: 0 } });
    eq('⑬d 反向对照：旁挂在、且 state=PASS ⇒ PASS 照旧可达（没被一刀切）',
       mergedState({ kbCovered: true, merged: [], kb: withRead }), 'PASS');
    // 反向对照：P0 快路自带读数（它压根不起链），不许算成「库侧没读数」
    const p0s = kbSideOf({ p0_fastpath: { rule_codes: ['H06'] }, issue_count: 1 });
    eq('⑬e 反向对照：P0 快路有读数 ⇒ 不算「库侧没读数」', kbNoReadingOf(p0s), false);
    // 卡里必须**说明白**：不许与「库侧 0 条」长得一样
    const rdNo = renderMerged([F('全文', '合规', 'REVIEW')],
      { state: 'REVIEW', kb: noRead, kbTextCount: 0 });
    eq('⑬f 「知识库侧本次未参与」要留着（在查证笔记里），且**不许**出现「知识库侧 0 条」',
       [/本次未参与/.test(rdNo.internalNotes), /知识库侧 0 条/.test(rdNo.internalNotes),
        rdNo.kbNoReading], [true, false, true]);
    eq('⑬f2 反向对照：这句也不上卡了（它属于「库侧/模型侧的口径读数」那一族）',
       [/本次未参与/.test(rdNo.block), /本次知识库侧没有读数/.test(rdNo.block)], [false, false]);
    eq('⑬g 要说明：只来自模型侧、无库内依据、**不得据此当 PASS**（仍在查证笔记里）',
       [/不得当通过依据/.test(rdNo.internalNotes), /不得据此当 PASS/.test(rdNo.internalNotes)],
       [true, true]);
  }

  // ⑭ ★★ 2026-10-08（Owner 拿一张图逼出来的两处）────────────────────────────────
  //   病灶一：**覆盖缺口那 1 条**既被 `COVERAGE_CATEGORY` 踢出 findings，又被
  //     `kbGap = kbN − txtN` 从 `issueCount` 里放回来 ⇒ 卡片对一个 `issue_count=1`
  //     的单子说「另有 1 条未并进本卡：PRD §5.3.3 规定问题数 **≥3** 时库侧只出分类汇总」——
  //     解释与事实不符，排查会被带到错方向。
  //   病灶二：模型侧**没跑成**与「跑了没报东西」都写成「模型侧 0 条」。
  //
  //   ★★ 2026-10-15（Owner 第三次裁定，**明确推翻本组 ⑭a/⑭b 的旧口径**）──────────
  //     Owner 原话：「**没有命中就是 pass**，按照 prd 的一句话结论走，**你不要自己定义**」。
  //     起因是真单 `MC-US-YT-_xyLF4_AgAw-IMG`（群里那张卡）：两侧一条都没命中，
  //     而卡上印着「共发现 **1** 处需人工确认」、逐条里一条没有、链接点开是一份空报告。
  //     新口径三条（判据逐条钉在下面）：
  //       · 覆盖缺口**不算一条内容问题** ⇒ 缺口单的合并态是 **PASS**；
  //       · 结论行是 **§5.3.1 那一句话**，`block` 必须是 `null`（不许去抠链的逐条块）；
  //       · 这一路**不产块、`total = 0`** ⇒ 不建报告、卡上不给链接。
  {
    // —— 病灶一（新口径）——
    const covK = kbSideOf({ review: { state: 'REVIEW', issue_count: 1,
      refusal: { state: 'NEEDS_INPUT', reason_code: 'coverage_not_covered',
                 coverage: { covered: false, rule_cited_unit_hits: 0 } } } });
    eq('⑭a ★ 覆盖缺口**不算一条内容问题** ⇒ 合并态 = PASS（Owner 2026-10-15「没有命中就是 pass」）',
       mergedState({ kbCovered: false, merged: [], kb: covK }), 'PASS');
    // —— 反向对照（缺一条，上面那条就退化成「一刀切成 PASS」）——
    eq('⑭a2 反向对照①：库侧 REVIEW 且条数 ≥2 ⇒ **仍是 REVIEW**（库侧真报了内容问题）',
       mergedState({ kbCovered: true, merged: [],
                     kb: kbSideOf({ review: { state: 'REVIEW', issue_count: 2 } }) }), 'REVIEW');
    eq('⑭a3 反向对照②：缺口单但**模型侧真报了几条** ⇒ REVIEW（有东西要人看，不是 PASS）',
       mergedState({ kbCovered: false, merged: [F('全文', '合规', 'REVIEW')], kb: covK }), 'REVIEW');
    eq('⑭a4 反向对照③：库侧**读不到条数** ⇒ 不许放行（读不到 ≠ 零条）',
       mergedState({ kbCovered: true, merged: [],
                     kb: kbSideOf({ review: { state: 'REVIEW' } }) }), 'REVIEW');
    // ★ 2026-10-21（真单 10:07）：缺口单 + 模型侧没跑成 ⇒ 拒答（不是 PASS）。
    eq('⑭a5 缺口单但**模型侧没跑成** ⇒ 拒答（不许 PASS）',
       mergedState({ kbCovered: false, merged: [], kb: covK, modelFailed: true }), '拒答');
    const rdCov1 = renderMerged([], { state: 'REVIEW', kb: covK, kbTextCount: 0 });
    eq('⑭b ★ 缺口单**不许**再印「共发现 1 处」：这一路不产块、`total = 0`（⇒ 不建报告、不给链接）',
       [rdCov1.block, rdCov1.total], [null, 0]);
    eq('⑭d ★ 缺口单的**查证笔记**要留住 —— 对方追问「库里覆盖没覆盖／这算不算证明合规」答得出来',
       [/没有可依据的条款/.test(rdCov1.internalNotes),
        /未命中 ≠ 合规/.test(rdCov1.internalNotes)], [true, true]);
    eq('⑭d2 反向对照：这段**不上卡**（缺口单没有块 ⇒ 卡上只有 §5.3.1 那一句）',
       rdCov1.block, null);
    // 反向对照①：**非**覆盖缺口、kbN=3、明细抠 0 ⇒ §5.3.3 那句**必须**还在（没被一刀切掉）
    const rdBig = renderMerged([], { state: 'REVIEW',
      kb: kbSideOf({ review: { state: 'REVIEW', issue_count: 3 } }), kbTextCount: 0 });
    eq('⑭e 反向对照：kbN=3、明细抠不全 ⇒ §5.3.3 的解释照旧（没被「不上卡」一刀切掉）',
       [/≥3 时库侧只出分类汇总/.test(rdBig.internalNotes), rdBig.kbGap], [true, 3]);
    // 反向对照②：**非**覆盖缺口、kbN=1、明细抠 0 ⇒ 不许说 ≥3，要按真实条数说
    const rdSmall = renderMerged([], { state: 'REVIEW',
      kb: kbSideOf({ review: { state: 'REVIEW', issue_count: 1 } }), kbTextCount: 0 });
    eq('⑭f 反向对照：kbN=1、明细抠不全 ⇒ 说「未达 3 条」而不是「≥3 只出汇总」',
       [/≥3 时库侧只出分类汇总/.test(rdSmall.internalNotes),
        /未达 3 条，不适用 PRD §5\.3\.3/.test(rdSmall.internalNotes)], [false, true]);
    // ══════════════════════════════════════════════════════════════════════
    // ⑭g–⑭i（2026-10-08 第五批）：**报告链接要按来源分档，不许把本地路径当链接**
    // ══════════════════════════════════════════════════════════════════════
    //   病灶：`report_url` 有两种 —— 飞书云文档（人点得开）与本地 `.md`（**人点不开**）。
    //   不分档就会把一条本地路径当链接贴给读者 ⇒ 库规：「一个点不开的链接比空格更坏」。
    const rdLoc = renderMerged([], { state: 'REVIEW',
      kb: kbSideOf({ review: { state: 'REVIEW', issue_count: 3,
        report_url: 'kb/l7/reports/x.review.md', report_url_kind: 'local_path' } }),
      kbTextCount: 0 });
    eq('⑭g 本地路径的报告 ⇒ 必须明说「你点不开」（不许冒充链接）',
       [/你点不开/.test(rdLoc.block), /本地文件路径/.test(rdLoc.block)], [true, true]);
    //   反向对照：**飞书云文档**必须原样贴出来，**不许**也被贴上「你点不开」。
    const rdDoc = renderMerged([], { state: 'REVIEW',
      kb: kbSideOf({ review: { state: 'REVIEW', issue_count: 3,
        report_url: 'https://momcozy-in.feishu.cn/docx/AAAABBBB',
        report_url_kind: 'feishu_docx' } }),
      kbTextCount: 0 });
    eq('⑭h 反向对照：飞书云文档 ⇒ 原样给链接、**不许**说「你点不开」',
       [/https:\/\/momcozy-in\.feishu\.cn\/docx\/AAAABBBB/.test(rdDoc.block),
        /你点不开/.test(rdDoc.block)], [true, false]);
    //   兜底：**旧版旁挂没有 kind** ⇒ 按形态判（http 算链接、其余算本地路径）。
    //   少了这条，没带 kind 的存量读数会被一律当成链接贴出去。
    const rdNoKind = renderMerged([], { state: 'REVIEW',
      kb: kbSideOf({ review: { state: 'REVIEW', issue_count: 3,
        report_url: '/Users/lute/x.review.md' } }),
      kbTextCount: 0 });
    eq('⑭i 兜底：没有 report_url_kind 时按形态判（非 http ⇒ 本地路径）',
       [/你点不开/.test(rdNoKind.block)], [true]);
    // ══════════════════════════════════════════════════════════════════════
    // ⑰a–⑰e（2026-10-09）：**PRD §5.3.4 的报告链接门槛 —— 问题数 ≥3 才出那一行**
    // ══════════════════════════════════════════════════════════════════════
    //   规则是 Owner 2026-10-08 的原话：「双轨按照 PRD ≧3 个问题输出报告链接到飞书文档」。
    //   触发条件**必须**是卡里那个数（`total`）—— 不是「并进来几条」，也不是
    //   「库侧明细抠不出来」。实测一单里三个数各不相同（19:08：total 12 ／ 并进来 7 ／ 旁挂 5）。
    const DOCX = 'https://momcozy-in.feishu.cn/docx/AAAABBBB';
    const mkN = (n, kb) => renderMerged(
      Array.from({ length: n }, (_, i) => ({ location: `画面 ${i}`, category: '本地化',
        severity: 'REVIEW', source: 'model', reason: 'x' })),
      { state: 'REVIEW', kb, kbTextCount: 0 });
    const withDocx   = kbSideOf({ review: { state: 'REVIEW', issue_count: 0, report_url: DOCX, report_url_kind: 'feishu_docx' } });
    const withoutAny = kbSideOf({ review: { state: 'REVIEW', issue_count: 0 } });

    const r3 = mkN(3, withDocx);
    eq('⑰a 问题数 ≥3 且有飞书文档 ⇒ **必须**出报告链接那一行（2026-10-19 起文案为「→ 完整清单：」）',
       [/→ 完整清单：/.test(r3.block), r3.block.includes(DOCX)], [true, true]);
    // ★ 反向对照①：**<3 时不许出现**。PRD 说 1–2 条走逐条输出、不给链接 ——
    //   少了这一条，「≥3 才出」就退化成「一律都出」，门槛等于没有。
    const r2 = mkN(2, withDocx);
    eq('⑰b 反向对照：问题数 <3 ⇒ **一个链接行都不许有**（哪怕文档就在手边）',
       [/→ 完整清单：/.test(r2.block)], [false]);
    // ★ 反向对照②：≥3 但**拿不到**链接 ⇒ 不许编，也不许默默不给 —— 要说清是哪种拿不到。
    const r3n = mkN(3, withoutAny);
    eq('⑰c 反向对照：≥3 但没拿到链接 ⇒ 如实说「未拿到」并说清原因，不许编一个链接',
       [/→ 完整清单：|本次未拿到报告链接/.test(r3n.block), /本次未拿到报告链接/.test(r3n.block),
        /https?:\/\//.test(r3n.block)], [true, true, false]);
    // 门槛看的是 `total`，不是「并进来几条」：库侧另有 2 条没并进来 ⇒ total=3 ⇒ 必须出那一行
    const rGap = renderMerged(
      [{ location: '画面 0', category: '本地化', severity: 'REVIEW', source: 'model', reason: 'x' }],
      { state: 'REVIEW', kb: kbSideOf({ review: { state: 'REVIEW', issue_count: 2, report_url: DOCX, report_url_kind: 'feishu_docx' } }),
        kbTextCount: 0, model: { ok: true, findings: [] } });
    eq('⑰d 门槛看的是卡里那个数（total=1+2），不是「并进来几条」',
       [rGap.total, /→ 完整清单：/.test(rGap.block)], [3, true]);
    // 常数与库侧同名同口径 —— 钉住 3，改它必须同时改两边（库侧 `feishu_publish.py`）
    eq('⑰e 门槛常数与库侧同口径（PRD §5.3.4 / §8.3 / §17 三处都是 3）',
       [REPORT_LINK_MIN_ISSUES], [3]);
    // ★★ 2026-10-14（Owner：「修改建议的链接，预期放在『建议转』这行的上面，跟 PRD 对齐」）：
    //   **次序按 PRD 逐字核**（回源飞书 PRD wiki `NB55wAq8liEOdKkquL2cgtPEnmg` rev 36
    //   ＋ 本地 `kb/.work/prd.md`，两份一致）：
    //       结论行 → `· <大类>类问题：N 个` → `→ 查看完整问题清单…` → 动作行
    //   改前拼装写的是 `${line}${reportNote}\n${bodyText}` ⇒ **链接跑到汇总之前**，与 PRD 相反
    //   （Owner 截图当场指出：「跟 prd 对齐，你没改吗？」）。
    //   ⚠️ 2026-10-09 那条诉求**没有作废**：链接不许被埋在逐条之后（会落进可折叠区）。
    //      现在的次序里它紧跟汇总、仍在逐条**之上** ⇒ 两个诉求同时成立。
    //   ⚠️ 判据改钉**三件事的相对次序**，不再钉「在第几行」—— 后者绑死行号，
    //      任何一次次序/行数调整都会误红（而误红的判据比没有判据更坏）。
    eq('⑰f 次序照 PRD：汇总 在 链接 之前，链接 在 动作行 之前（且不埋在逐条之后）',
       [(() => {
         const ls = String(r3.block).split("\n").map((x) => x.trim());
         const iSum = ls.findIndex((l) => /^·/.test(l));
         const iLink = ls.findIndex((l) => /→ 完整清单：|查看完整问题清单/.test(l));
         const iAct = ls.findIndex((l) => /^(建议转|请修改后重新提交)/.test(l));
         return iSum >= 0 && iLink > iSum && iAct > iLink;
       })()], [true]);
    //   ⑰f 的反向对照**不是夹具而是变异**：把 reportNote 挪回逐条之后 ⇒ ⑰f 必红（已实测）。
    // ══════════════════════════════════════════════════════════════════════
    // ⑱a–⑱d（2026-10-09）：**逐条「建议」必须来自两侧的真话，不许甩给人**
    // ══════════════════════════════════════════════════════════════════════
    //   Owner 原话：「守衡输出的建议都是『转对应负责人复核』。我期望的是：
    //   **知识库侧和模型侧都输出具体的修改建议**，而不是甩给人。」
    //   病灶：那一行原先是**硬编码常量**（'转对应负责人复核。'），两侧说了什么都被它盖掉。
    // ★ 2026-10-19：加第二个参数 —— `'report'` 走报告的八格版（标注在报告里，卡面只印首句）
    const itemOf = (f, layout = undefined) => renderMergedItem(f, 0, layout ? { must: false, layout } : { must: false });
    // ★ 2026-10-09：`建议` 标签如今**带加粗**（Owner 裁定「字段加粗保留」）⇒ 原先的
    //   `/ {3}建议：(.*)/` 抠出空串，把这组「建议内容对不对」的自证**全部误判成失败**。
    //   这组查的是**建议内容与标注**、与加粗无关 ⇒ 认两种写法。
    const sugOf = (f) => (itemOf(f).match(/ {3}\*{0,2}建议\*{0,2}：(.*)/) || [])[1] || '';
    const kbSug = sugOf({ category: '平台与促销', location: '第 3 行', source: 'kb', reason: 'x',
                          kb: { suggestionLine: '删掉「限时」二字，改为「活动期间」' } });
    eq('⑱a 库侧给了建议 ⇒ **原话照搬**（那是库规给的改法，可回源）',
       [kbSug], ['删掉「限时」二字，改为「活动期间」']);
    const mdSug = sugOf({ category: '本地化', location: '第 4 行', source: 'model', reason: 'x',
                          suggestion: '把整段译成中文' });
    // ★ 2026-10-13（Owner：「不要出现 知识库侧，模型侧」）：措辞改了，**信息一条没少** ——
    //   仍要照搬那句改法，仍要标明「无库内依据」「不是库规原文」。
    // ★★ 2026-10-19（Owner：「修改建议 ≤30 字」）：**卡面**只印首句，「无库内依据 / 不是库规原文」
    //   这类**标注移到报告**（卡上放不下）。⇒ 这里按介质分开断言，防护意图不变：
    //   「照搬改法」看卡面首句，「标明来源」看报告全文。
    {
      const mdSugRep = (itemOf({ category: '本地化', location: '第 4 行', source: 'model', reason: 'x',
                                 suggestion: '把整段译成中文' }, 'report').match(/\*\*修改建议\*\*：(.*)/) || [])[1] || '';
      // ★★ 2026-10-19（Owner 点名去掉那两句）：卡面与报告都**不再**印「无库内依据的改法建议…」；
      //   「这一条回不回得了源」改由**依据那一格**说（`独立语义复核（非条款依据…）`）。
      //   ⇒ 这条用例的防护意图搬个位置：**依据格必须说清它不是条款依据**。
      const basisOf = (itemOf({ category: '本地化', location: '第 4 行', source: 'model', reason: 'x',
                                suggestion: '把整段译成中文' }, 'report').match(/\*\*依据文档链接\*\*：(.*)/) || [])[1] || '';
      eq('⑱b 只有独立复核给 ⇒ 改法照搬、依据格写明「非条款依据」（不再印自我否定的长句）',
         [/把整段译成中文/.test(mdSug), /非条款依据/.test(basisOf), !/无库内依据/.test(mdSug + basisOf)],
         [true, true, true]);
    }
    eq('⑱b2 反向对照：**那两个词**一个都不许再出现（卡面与报告共用这条渲染）',
       [/知识库侧/.test(mdSug + itemOf({ category: 'a', location: 'b', source: 'kb', reason: 'r' })),
        /模型侧/.test(mdSug + itemOf({ category: 'a', location: 'b', source: 'model', reason: 'r' }))],
       [false, false]);
    const noneSug = sugOf({ category: '本地化', location: '第 5 行', source: 'model', reason: 'x' });
    eq('⑱c ★ 两侧都没给 ⇒ **如实说没有**，不许用「转人复核」冒充一条建议',
       [/两侧都没给修改建议/.test(noneSug), /转对应负责人复核/.test(noneSug)], [true, false]);
    eq('⑱d ★ 反向对照：**任何一条**都不许再出现硬编码那句（它是这次要修的病灶）',
       [/转对应负责人复核/.test(itemOf({ category: 'a', location: 'b', source: 'model', reason: 'r', suggestion: 's' })),
        /转对应负责人复核/.test(itemOf({ category: 'a', location: 'b', source: 'kb', reason: 'r', kb: { suggestionLine: 's' } }))],
       [false, false]);
    // ★★ ⑱e：**库侧的建议有两条来路，缺一条就是半个修复。**
    //   正则抠逐条块（`kbFindingsOf` 下半段）与**结构化 `risk_items`**（这一段，⑯a 说它优先）。
    //   我第一版只补了正则那条 ⇒ 走引擎 JSON 时库侧的建议**照样被丢**，而 `r.suggestion`
    //   就在手边。这一条断言钉住第二条来路 ——「两个产出者只修了一个」是今天反复栽的形状。
    {
      const eng = { decision: { risk_items: [{
        risk_type: '平台与促销-绝对化', location: '正文第 3 行', reason: '用了最高级',
        suggestion: '删掉「最」字，改为「更」', action: 'review',
        evidence: { library: '措辞表达库 v0', article_no: 'W-1.16', excerpt: '静音', anchor: '#p3' } }] } };
      const kbE = kbFindingsOf('【审查结论：REVIEW】共发现 1 处需人工确认。', eng);
      eq('⑱e ★ 引擎 JSON 那条来路也必须带出库侧建议（只修正则那条 = 半个修复）',
         [kbE.findings[0]?.suggestionLine], ['删掉「最」字，改为「更」']);
    }
    // ══════════════════════════════════════════════════════════════════════
    // ⑮a–⑮c（2026-10-08 第六批）：**库侧条目要优先从引擎结构化 `risk_items` 取**
    // ══════════════════════════════════════════════════════════════════════
    //   病灶：纯逐行正则抠中文 ⇒ 引擎把逐条塞在 `summary` 一个字符串里时**一条都抠不到**
    //   ⇒ `basisLine=null` ⇒ 渲染层退回重建版「《知识库》（未给条款号）（锚点：—）」
    //   ⇒ 命中文字/条款号/锚点/**飞书直链**全丢（Owner 截图那条就是这么来的）。
    const chainshape = [
      '===== ③ 引擎结论 =====',
      JSON.stringify({ decision: { issue_count: 1, risk_items: [{
        risk_type: '原则性错误-禁区（库内反例条款）', location: '全文',
        reason: '库内反例条款 S-1.267（原则性错误）与本素材同源/同题材：…',
        action: 'review',
        evidence: { library: '内部正负样本库', article_no: 'S-1.267',
          anchor: '#负面样本/RECX/具体原因/分析', source_sha256: 'abc123',
          excerpt: '【原则性错误】视频 图 1 主标题醒目柔和…',
          l0_entry_url: 'https://momcozy-in.feishu.cn/base/APP?table=TBL&record=RECX' } }] } }, null, 1),
      '===== ③b 转述模板 =====',
      '1.【原则性错误-禁区（库内反例条款）】全文',
      '   依据：《内部正负样本库 v0》第 S-1.267 条（链接：kb/l3/…）',
    ].join('\n');
    const kf = kbFindingsOf(chainshape);
    eq('⑮a 链回答里带引擎 JSON ⇒ 必须走结构化（条款号＋锚点＋飞书直链都在）',
       [kf.findings.length,
        kf.findings[0]?.kb?.article_no,
        /feishu\.cn\/base/.test(String(kf.findings[0]?.kb?.entry_url ?? ''))],
       [1, 'S-1.267', true]);
    const blk15 = renderMerged(mergeFindings(kf.findings, []).items,
      { state: 'REVIEW', kb: kbSideOf({ review: { state: 'REVIEW', issue_count: 1 } }),
        kbTextCount: kf.findings.length }).block;
    eq('⑮b 端到端：卡里的「依据」行带飞书直链，且**不许**出现重建版的「（未给条款号）」',
       [/feishu\.cn\/base/.test(blk15), /（未给条款号）/.test(blk15)], [true, false]);
    // 反向对照：**没有** risk_items 的回答必须原样退回逐行正则（不许因为换了条路就少报）
    const noJson = '1.【措辞表达】全文\n   原因：命中「限时」\n   依据：《措辞表达库 v0》第 W-1.16 条';
    const kf2 = kbFindingsOf(noJson);
    eq('⑮c 反向对照：没有引擎 JSON ⇒ 退回逐行正则，照旧抽得到（不是静默空）',
       [kf2.findings.length, kf2.findings[0]?.category], [1, '措辞表达']);
    // ══════════════════════════════════════════════════════════════════════
    // ⑯a–⑯b（2026-10-08 第七批）：**链直接带回的引擎 JSON = 主路**
    // ══════════════════════════════════════════════════════════════════════
    //   为什么它是主路：`answer` 是 headless agent 自己组织的**散文**（措辞会被改写、
    //   ≥3 条时按 PRD §5.3.3 连逐条行都没有），而条款号/锚点/命中片段/飞书直链
    //   **只在那份 JSON 里**。实测教训：我曾拿「引擎原始 stdout」当样本验，全绿，
    //   而线上走的是 `answer` ⇒ 修复没生效（Owner 09:22 那张卡）。
    const engObj = { decision: { issue_count: 1, risk_items: [{
      risk_type: '品牌一致性-禁区（库内反例条款）', location: '全文',
      reason: '库内反例条款 S-1.259（品牌一致性）与本素材同源/同题材：…', action: 'review',
      evidence: { library: '内部正负样本库', article_no: 'S-1.259',
        anchor: '#正面和负面样本/REC1/原文反馈', source_sha256: 'deadbeef',
        excerpt: '【品牌一致性】文案 1.挂式衣架：磨砂亚克力材质,搭配透明防滑条。',
        l0_entry_url: 'https://momcozy-in.feishu.cn/base/APP?table=TBL&record=REC1' } }] } };
    // 关键：`answer` **故意不含 JSON**（模拟模型改写过措辞的真实情形）
    const kf3 = kbFindingsOf('（回答里没有 JSON —— 模型自己组织的散文）', engObj);
    eq('⑯a 链带回引擎 JSON ⇒ 即使回答里没有 JSON，也必须出条款号＋锚点＋飞书直链',
       [kf3.findings.length, kf3.findings[0]?.kb?.article_no,
        /feishu\.cn\/base/.test(String(kf3.findings[0]?.kb?.entry_url ?? ''))],
       [1, 'S-1.259', true]);
    const blk16 = renderMerged(mergeFindings(kf3.findings, []).items,
      { state: 'REVIEW', kb: kbSideOf({ review: { state: 'REVIEW', issue_count: 1 } }),
        kbTextCount: kf3.findings.length }).block;
    eq('⑯b 端到端：卡里依据行带飞书直链，且**不许**出现「（未给条款号）」',
       [/feishu\.cn\/base/.test(blk16), /（未给条款号）/.test(blk16)], [true, false]);
    // 反向对照：**engine 为 null** 时不许崩、也不许少报 —— 仍走回答里挖那条路
    eq('⑯c 反向对照：engine=null ⇒ 仍走原路（回答里挖），不崩、不空',
       [kbFindingsOf(noJson, null).findings.length], [1]);
    // —— 病灶二 ——
    const kbOne = kbSideOf({ review: { state: 'REVIEW', issue_count: 1 } });
    const item = [F('全文', '合规', 'REVIEW')];
    const rdFail = renderMerged(item, { state: 'REVIEW', kb: kbOne, kbTextCount: 1,
      model: { ok: false, findings: [], raw: '', ms: 900, error: '输出里没有 JSON 数组' } });
    eq('⑭g 模型侧没跑成 ⇒ 写「没跑成」，**不许**写「模型侧 0 条」（在查证笔记里）',
       [/模型侧 \*\*没跑成\*\*（输出里没有 JSON 数组）/.test(rdFail.internalNotes),
        /模型侧 0 条/.test(rdFail.internalNotes), rdFail.modelFailed], [true, false, true]);
    eq('⑭g2 且要写明「这不等于模型侧看过、没问题」',
       /这不等于「模型侧看过、没问题」/.test(rdFail.internalNotes), true);
    const rdOk = renderMerged(item, { state: 'REVIEW', kb: kbOne, kbTextCount: 1,
      model: { ok: true, findings: [], dropped: [], ms: 900 } });
    eq('⑭h 反向对照：模型侧**跑成且 0 条** ⇒ 照旧写「模型侧 0 条」（不许一刀切）',
       [/模型侧 0 条/.test(rdOk.internalNotes), /没跑成/.test(rdOk.internalNotes), rdOk.modelFailed],
       [true, false, false]);
    eq('⑭i 反向对照：模型侧挂了**不许**改结论行（结论仍由库侧定）',
       [rdFail.line, rdFail.total], [rdOk.line, rdOk.total]);
    // 不给 model（老调用方）时不许凭空说「没跑成」
    const rdNoModel = renderMerged(item, { state: 'REVIEW', kb: kbOne, kbTextCount: 1 });
    eq('⑭j 反向对照：不传 model ⇒ 不许凭空说「没跑成」（向后兼容）',
       rdNoModel.modelFailed, false);
  }

  // ⑮ ★★ 2026-10-08（Owner 同意 ②）：**「库忙」不许写成「没下文」** ──────────────────
  //   病灶：卡原先只写「本次没有知识库三态结论…下一步：先把库侧恢复（跑层/日更）再重审」——
  //   读者读到的是**死局 + 一份他做不了的作业**。而这一单其实**已经进了补发队列**。
  {
    const busy = kbSideOf({ review: { state: 'NEEDS_INPUT', issue_count: 0,
      refusal: { state: 'NEEDS_INPUT', reason_code: 'claim_busy' } } });
    eq('⑮a claim_busy 被认成「库忙」', [busy.refused, busy.reason], [true, 'claim_busy']);
    const rdBusy = renderMerged([], { state: 'NEEDS_INPUT', kb: busy, kbTextCount: 0 });
    eq('⑮b 库忙卡要说「会自己重跑」＋「1 小时内最多 5 次」',
       [/会自己重跑/.test(rdBusy.block), /1 小时内最多 5 次/.test(rdBusy.block), rdBusy.claimBusy],
       [true, true, true]);
    eq('⑮c 库忙卡**不许**把「跑层/日更」当送审人的作业',
       [/先把库侧恢复（跑层\/日更）再重审/.test(rdBusy.block),
        /你不需要做什么/.test(rdBusy.block)], [false, true]);
    eq('⑮d **不许**承诺「会另行告知」—— 实测 deadDrop 只落死信、不通知任何人',
       /另行告知|会通知你|会告知你/.test(rdBusy.block), false);
    // 反向对照：**别的**拒答（如供给链不新鲜）**不许**被说成「已排队、会自动补跑」
    const stale = kbSideOf({ review: { state: 'NEEDS_INPUT', issue_count: 0,
      refusal: { state: 'NEEDS_INPUT', reason: '供给链不新鲜' } } });
    const rdStale = renderMerged([], { state: 'NEEDS_INPUT', kb: stale, kbTextCount: 0 });
    eq('⑮e 反向对照：非库忙的拒答 ⇒ 仍写「跑层/日更」，且**不许**说「会自己重跑」',
       [/先把库侧恢复（跑层\/日更）再重审/.test(rdStale.block),
        /会自己重跑/.test(rdStale.block), rdStale.claimBusy], [true, false, false]);
  }

  // ★★ 2026-10-12（库侧 Owner 裁定 `issue_count` 只算库内依据）：
  //   数改小之后，候选线索必须在卡上有一句；没有候选时**一个字都不许加**（反向对照）。
  {
    const _side = (cn) => kbSideOf({ review: Object.assign(
      { state: 'REVIEW', issue_count: 2 },
      Number.isFinite(cn) ? { candidate_count: cn } : {}) });
    const _mk = (cn) => renderMerged(
      [{ location: '全文', category: '功效宣称', severity: 'REVIEW', source: 'model', reason: 'x' }],
      { state: 'REVIEW', kb: _side(cn), kbTextCount: 2, model: { ok: true, findings: [] } });
    const rCand = _mk(3);
    const rNone = _mk(0);
    eq('㉑a 库侧报了非权威候选 ⇒ 必须说出条数，且写明「不构成依据」（在查证笔记里）',
       [/另有 \*\*3 条非权威候选线索\*\*/.test(rCand.internalNotes),
        /不构成依据/.test(rCand.internalNotes)], [true, true]);
    eq('㉑a2 反向对照：候选提示也不上卡（同一族口径读数）', /非权威候选/.test(rCand.block), false);
    eq('㉑b 反向对照：没有候选（或旧旁挂没这个键）⇒ **一个字都不加**',
       [/非权威候选/.test(rNone.internalNotes), /非权威候选/.test(_mk(undefined).internalNotes)],
       [false, false]);
    eq('㉑c 候选条数**不许进算术**：抬头与 kbGap 与「有没有候选」无关',
       [rCand.total, rNone.total, rCand.kbGap, rNone.kbGap],
       [rNone.total, rNone.total, rNone.kbGap, rNone.kbGap]);
    // ★★ ㉑d/㉑e（2026-10-12，Owner「同意加」那行候选提示之后补的结构判据）：
    //   库侧上一批真踩过这个坑 —— 把候选说明接在 PRD 那句**同一行**上，
    //   而 `conforms()` 是 `$` 锚定、`LINE_RE` 取到行尾 ⇒ 判 false、卡面标题不再是 PRD 那句。
    //   ⇒ 那行候选提示**必须独立成行**。这里用**守衡自己的**尺子判，不另抄正则。
    const _vline = String(rCand.block).split('\n')
      .find((l) => l.includes('【审查结论：') || /^【(?:PASS\+SUGGEST|PASS|REVIEW|BLOCK)】/.test(l)) || '';
    eq('㉑d 候选提示必须**独立一行**：PRD 那句仍逐字合规、且那句里不许出现候选字样',
       [prd53Conforms(_vline).ok, /非权威候选/.test(_vline)], [true, false]);
    const _glued = '【审查结论：REVIEW】共发现 3 处需人工确认。（另有 3 条非权威候选线索，不构成依据）';
    eq('㉑e **反向对照**：把候选提示粘到结论行尾巴上 ⇒ 合规判据必须红（这正是库侧踩过的写法）',
       [prd53Conforms(_glued).ok, prd53Conforms(_vline).why === _glued], [false, false]);
  }

  // ══════════════════════════════════════════════════════════════════════
  // ㉓a–㉓d（2026-10-14）：**非权威候选不许冒称「有库内条款依据」**
  // ══════════════════════════════════════════════════════════════════════
  //   Owner 原话：「所有参考知识库的，都必须带飞书侧源链接，修复下并提交入库。」
  //   实测那张 hospital-grade 卡：种子规则候选（`authoritative: false`，库自己写着
  //   「这不是知识库的规则真源」）被贴成 `**有库内条款依据**` ＋ `《知识库》（未给条款号）`
  //   —— **既冒称依据，又给不出链接**。而 `authoritative` 这一格守衡侧此前**全文零命中**。
  {
    const seed = {
      risk_type: '绝对化与排名宣称', category: '绝对化', location: 'text characters 40-53',
      action: 'review', reason: '命中美国市场规则候选，需要结合上下文、证据和适用范围人工确认',
      original_text: 'hospital-grade',
      authoritative: false, authority: 'seed-rules(非规则真源)',
      superseded_by: 'kb/l3/candidates/rules.jsonl',
      evidence: { library: null, article_no: null, anchor: null, source_sha256: null, excerpt: null },
    };
    const real = {
      risk_type: '背书与资质-等级与资质背书', category: '背书与资质', location: '全文',
      action: 'review', reason: '逐字命中「hospital」',
      evidence: { library: '措辞表达库', article_no: 'W-1.35', anchor: '#广告文案明细/recvuJYdObBgjg/命中片段',
                  source_sha256: 'a'.repeat(64), excerpt: 'M05:hospital grade',
                  l0_entry_url: 'https://momcozy-in.feishu.cn/base/AAA?table=BBB&record=recvuJYdObBgjg' },
    };
    const parsed = kbFindingsOf('', { decision: { risk_items: [seed, real] } });
    eq('㉓a 非权威候选**不进 findings**（它是线索，不是「共发现 N 处」里的 N）',
       [parsed.findings.length, parsed.candidates.length], [1, 1]);
    eq('㉓b 真依据照旧在 findings 里，且带得上飞书直链',
       [parsed.findings[0]?.kb?.article_no, /^https:\/\//.test(String(parsed.findings[0]?.kb?.entry_url || ''))],
       ['W-1.35', true]);
    // ㉓c：候选**不许**被渲染成「有库内条款依据」（本条的失败信号就在这里）
    const seedItem = { location: seed.location, category: seed.category, severity: 'REVIEW',
                       source: 'kb', reason: seed.reason, basisLine: parsed.candidates[0]?.kb?.basisLine ?? null };
    const painted = renderMergedItem(seedItem, 0, { must: false });
    eq('㉓c 候选那条的卡面文字：不许出现「有库内条款依据」',
       [/有库内条款依据/.test(painted)], [false]);
    // ㉓d 反向对照：把 authoritative 拿掉（= 真依据的形状）⇒ 它必须**回到** findings。
    //   否则 ㉓a 可能只是「所有条目都被分流了」的恒真判据。
    const noFlag = kbFindingsOf('', { decision: { risk_items: [{ ...seed, authoritative: undefined }, real] } });
    eq('㉓d 反向对照：摘掉 authoritative（真依据的形状）⇒ 必须回到 findings',
       [noFlag.findings.length, noFlag.candidates.length], [2, 0]);
  }

  // ── ㉔ 置信度：两侧各出一个档位、对外**只出一个数**（Owner 2026-10-15）─────────────
  {
    const mkModel = (n, { dropped = 0, ok = true, missing = 0 } = {}) => ({
      ok,
      dropped: Array.from({ length: dropped }, () => ({ why: '理由为空' })),
      findings: Array.from({ length: n }, (_, i) => ({
        location: i < missing ? '' : `帧 ${i + 1}`, reason: '一句话说清问题',
        category: '合规', severity: 'REVIEW' })),
    });
    // ㉔a 两侧同档 ⇒ 取该档代表值，basis 说明「两侧同档」。
    //   ★ 必须给 `bothCount`（有库侧互证）—— 这正是 v2 加的那一格：没有互证就不算 direct。
    const a = mergedConfidence({ kbConfidence: 0.95, kbCovered: true, model: mkModel(2), bothCount: 2 });
    eq('㉔a 两侧都 direct（且有互证）⇒ 0.93，且 basis 写明「两侧同档」',
       [a.value, a.band, a.kb_band, a.model_band, /两侧同档/.test(a.basis)],
       [0.93, 'direct', 'direct', 'direct', true]);
    // ㉔b ★ 库侧高（PASS 档）＋ **只有模型侧命中**（库侧未覆盖）⇒ 必须降档并点名模型侧。
    //   这一格是 policy 实测里**真出现过**的那一类：29 份合并报告里「只有模型侧命中」9 份。
    const b = mergedConfidence({ kbConfidence: 0.95, kbCovered: false, model: mkModel(1) });
    eq('㉔b 库侧高置信 ＋ 只有模型侧命中（库未覆盖）⇒ 必须降到 0.85 并点名「模型侧拉低」',
       [b.value, b.band, b.model_band, /模型侧拉低/.test(b.basis)],
       [0.85, 'confirm', 'confirm', true]);
    // ㉔b2 **反向对照**：把「只有模型侧命中」当一致（不降档）⇒ 那个放宽版给的数必须与判据不同。
    //   少了这条，㉔b 可能只是「所有输入都给 0.85」的恒真判据。
    const bLoose = 0.93;                                    // 放宽版（不降档）会给的数
    eq('㉔b2 反向对照：放宽版给 0.93 ⇒ 与判据要求的 0.85 **必须不同**',
       bLoose !== b.value, true);
    // ㉔c 这一侧读数不完整 ⇒ confirm（丢条 / 缺位置）
    eq('㉔c 模型侧解析丢 1 条 ⇒ confirm',
       mergedConfidence({ kbConfidence: 0.95, kbCovered: true, model: mkModel(2, { dropped: 1 }) }).band,
       'confirm');
    eq('㉔c2 模型侧 1 条缺位置 ⇒ confirm',
       mergedConfidence({ kbConfidence: 0.95, kbCovered: true, model: mkModel(1, { missing: 1 }) }).band,
       'confirm');
    // ㉔d 模型侧**未参与** ⇒ 不产出合并数，退回库侧读数并写明单轨
    const d = mergedConfidence({ kbConfidence: 0.93, kbCovered: true,
                                 model: { ok: false, findings: [] }, modelFailed: true });
    eq('㉔d 模型侧没跑成 ⇒ 退回库侧 0.93、model_band 为 null、basis 写明「模型侧未参与」',
       [d.value, d.model_band, /模型侧未参与/.test(d.basis)], [0.93, null, true]);
    // ㉔d2 **反向对照**：把「模型侧失败」当「0 条」（= 不拉低且不标注）⇒ 两句话必须能分辨。
    const dLoose = mergedConfidence({ kbConfidence: 0.93, kbCovered: true,
                                      model: { ok: true, findings: [] } });
    eq('㉔d2 反向对照：当成「0 条」就没有「未参与」那句 ⇒ 判据必须能分辨这两种形状',
       [/模型侧未参与/.test(dLoose.basis), /没报问题/.test(dLoose.basis)], [false, true]);
    // ㉔e 库侧没给数（拒答/读数缺失）⇒ 用模型侧读数，**不许空**
    //   （此时必然没有库侧命中 ⇒ 无互证 ⇒ 落 confirm；不许因为"没数"就给它 direct）
    // ㉔e 库侧**没有读数** ⇒ **不出这个数**（F1，2026-10-15）
    //   旧版写的是「用模型侧读数（不空）」，正是那个假高置信的来源；已按真数据改成不出数。
    const e = mergedConfidence({ kbConfidence: null, kbCovered: true, model: mkModel(1) });
    eq('㉔e 库侧没给置信度 ⇒ **不出这个数**（value/band 都为 null），且 basis 写明理由',
       [e.value, e.band, /库侧没有置信度读数/.test(e.basis)], [null, null, true]);
    // ㉔e2 ★★ **反向对照**（两半都要，缺一条这条判据就是恒真式）：
    //   (a) 库侧没读数 ＋ 模型侧 **0 条** ⇒ **不许**给 direct —— 这正是「库侧拒答却拿到 0.93」
    //       那个形状（100 条真数据里 8 条，高置信档判错率 100%）；
    //   (b) 库侧**有**读数 ＋ 模型侧 0 条 ⇒ **照旧** direct 0.93（证判据不是"所有输入都不给数"）。
    const e2a = mergedConfidence({ kbConfidence: null, kbCovered: false,
                                   model: { ok: true, findings: [] } });
    const e2b = mergedConfidence({ kbConfidence: 0.93, kbCovered: true,
                                   model: { ok: true, findings: [] } });
    eq('㉔e2 反向对照：库侧没读数＋模型侧 0 条 ⇒ 不许 direct；库侧有读数时 ⇒ 仍 direct 0.93',
       [[e2a.value, e2a.band], [e2b.value, e2b.band]], [[null, null], [0.93, 'direct']]);
    // ㉔f ★★ **端到端实测抓到的形状**（真素材 RC-78ce50b3732c）：库侧 PASS/0 条 ＋ 模型侧 2 条
    //   ⇒ 合并态 REVIEW。v1 只看 `kbCovered`（"库里有该题材的条款"）⇒ 给了 direct 0.93，
    //   与它旁边那个 REVIEW **不自洽**。v2：没有一条与库侧互证 ⇒ 分歧 ⇒ confirm。
    const f = mergedConfidence({ kbConfidence: 0.95, kbCovered: true, model: mkModel(2), bothCount: 0 });
    eq('㉔f 模型侧命中了但没有一条与库侧互证（分歧）⇒ 必须 confirm，且 basis 点名「没有…互证」',
       [f.value, f.band, /没有一条与库侧互证/.test(f.basis)], [0.85, 'confirm', true]);
    // ㉔f2 **反向对照**：同样两条命中，只要有 1 条与库侧对上 ⇒ 必须回到 direct。
    //   少了它，㉔f 可能只是"所有带命中的输入都给 confirm"的恒真判据。
    const f2 = mergedConfidence({ kbConfidence: 0.95, kbCovered: true, model: mkModel(2), bothCount: 1 });
    eq('㉔f2 反向对照：有 1 条互证 ⇒ 必须回 direct（与 ㉔f 的档位必须不同）',
       [f2.band, f2.band !== f.band], ['direct', true]);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ㉕ P0：不适用分流 ⇒ **两侧同档 1.0，最终出 1**（Owner 2026-10-16 逐字裁定）
  //
  //   「按照 prd：P0 层级规则不适用置信度分流，命中即 BLOCK，置信度记为 1.0。
  //     **模型侧应该也是 1，最终出 1**。」
  //
  //   为什么单开一组：这一档**不参与"取保守"** —— 上面 ㉔ 那一整套（模型侧拉低、
  //   没有互证就落 confirm）在 P0 行上**一个都不适用**。少了这组，
  //   下次谁把 P0 并回普通链，就会出现「结论 BLOCK ／ 置信度 0.85」那种与 §6.6 打架的显示。
  {
    const mkModel = (n) => ({ ok: true, findings: Array.from({ length: n }, (_, i) => ({
      location: `图 ${i + 1}`, category: '措辞表达', severity: 'REVIEW',
      reason: 'r', excerpt: 'e', suggestion: 's' })), dropped: [] });

    // ㉕a P0 命中（快路）⇒ 两侧 1.0、合并 1.0；**模型侧有 3 条命中也不许拉低**
    const a = mergedConfidence({ kbConfidence: 1.0, kbCovered: true, model: mkModel(3),
                                 bothCount: 0, p0Hit: true });
    eq('㉕a P0 命中 ⇒ 置信度 = 1.0（档位 p0），**模型侧不参与合并**（Owner：不用合并模型侧的置信度）',
       [a.value, a.band, a.model_band, /不合并模型侧/.test(a.basis)], [1, 'p0', null, true]);
    eq('㉕a1b 模型侧那几条命中**不许**把确定性命中拉低（同一份输入、非 P0 ⇒ 0.85）',
       mergedConfidence({ kbConfidence: 0.95, kbCovered: true, model: mkModel(3) }).value, 0.85);
    eq('㉕a2 同一份输入、把库侧那个数换成**非 P0 的 0.95** ⇒ 必须回到 0.85'
       + '（证明这一档只在 P0 上生效，不是"所有单子都给 1.0"的恒真判据）',
       mergedConfidence({ kbConfidence: 0.95, kbCovered: true, model: mkModel(3) }).value, 0.85);
    eq('㉕a3 `1.0` 本身就是 P0 的记法 ⇒ **不显式声明 p0Hit 也认**（库侧那个 1.0 只可能来自 P0）',
       mergedConfidence({ kbConfidence: 1.0, kbCovered: true, model: mkModel(3) }).value, 1);
    eq('㉕a4 P0 那一档的模型侧读数记「未参与」——**不是**记 1.0（免得台账看起来像算过）',
       a.model_band, null);

    // ㉕b `bandOf(1.0)` 单独成档：`p0` ≠ `direct`（0.99 仍是 direct）
    eq('㉕b `bandOf(1) === "p0"`、`bandOf(0.99) === "direct"`（1.0 是 P0 的记法，不许与 direct 混）',
       [bandOf(1), bandOf(0.99), CONF_REPRESENTATIVE.p0], ['p0', 'direct', 1]);

    // ㉕c 判据来自**引擎读数**：`tier_trace.P0 > 0` / 快路标记 / 库侧那个 1.0
    eq('㉕c `p0HitOf`：快路 ⇒ true；`tier_trace.P0=1` ⇒ true；普通单 ⇒ false',
       [p0HitOf({ kb: { source: 'p0_fastpath' } }),
        p0HitOf({ res: { engine: { tier_trace: { P0: 1, P1: 2 } } } }),
        p0HitOf({ res: { engine: { tier_trace: { P0: 0 } } }, kb: { source: 'chain' } })],
       [true, true, false]);

    // ㉕d 模型侧没跑成也照样是 1.0（P0 是**确定性匹配**，与模型侧参不参与无关）
    const d = mergedConfidence({ kbConfidence: 1.0, kbCovered: true, model: null,
                                 modelFailed: true, p0Hit: true });
    eq('㉕d P0 命中 ＋ 模型侧没跑成 ⇒ 仍然 1.0（确定性匹配不依赖模型侧）',
       [d.value, d.band], [1, 'p0']);

    // ㉕e ★ 接线：`agent.mjs` 必须真的把 `p0Hit` 传进去（只写函数不接线 = 判据是注释）
    const src = readFileSync(new URL('./agent.mjs', import.meta.url), 'utf8');
    eq('㉕e 接线：`agent.mjs` 里 `p0HitOf(...)` 的结果必须传进 `mergedConfidence`',
       /const p0Hit = p0HitOf\(/.test(src) && /p0Hit,\s*\n?\s*\/\//.test(src), true);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ㉖ 修改建议：**宁可超字数，不许半句**（Owner 2026-10-19 逐字：
  //   「这里的 修复建议都没讲完，被截断了，不能出现这种情况」）
  //
  //   真报告 `Gfuydnn9xoUcAwxnNACcCJcvnfc` 里 6 条有 3 条是被 `…` 切在半句上的，
  //   另一次整条只剩「改为…」。缺的是**一条判据**：只要建议格敢印 `…` 就红。
  {
    const LONG = '删「Certified Comfort」，补上认证机构名称与依据标准；在详情页写清产品适用场景和使用限制；'
      + '移除无法证明的绝对化功效承诺。';
    const a = fitAdvice(LONG, ADVICE_MAX);
    eq(`㉖a 超过 ${ADVICE_MAX} 字的建议 ⇒ 卡面/报告压到上限且明确标记超限`,
       [a.over, a.shown <= ADVICE_MAX, a.text.length < LONG.length], [true, true, true]);
    eq('㉖a2 超限后的显示不超过上限且确实短于原文',
       [countAdviceChars(a.text) <= ADVICE_MAX, a.text.length < LONG.length], [true, true]);

    const SHORT = '删去 unique，改为描述双层密封结构';
    const b = fitAdvice(SHORT, ADVICE_MAX);
    eq(`㉖b 反向对照：≤${ADVICE_MAX} 字的建议原样印出且不标 over`,
       [b.text, b.over], [SHORT, false]);

    // ㉖c 端到端：真的渲染一条**报告**（不是只测工具函数）——
    //   这一条才是 Owner 看到的那个形状；少了它，改回 `_clipR` 也不会红。
    const item = { location: '主标题下方卖点行', category: '合规与受监管宣称',
                   sub: '法定认证与注册表述', severity: 'REVIEW', source: 'model',
                   reason: '不写明认证方，属无出处认证表述', excerpt: 'Certified Comfort',
                   advice: LONG, basisLine: null };
    const rep = renderMergedItem(item, 0, { layout: 'report' });
    const line = (rep.match(/\*\*修改建议\*\*：(.+)/) || [])[1] || '';
    eq(`㉖c 报告建议严格执行 ${ADVICE_MAX} 字上限`,
       [countAdviceChars(line.trim()) <= ADVICE_MAX, line.trim().length < LONG.length], [true, true]);

    // ㉖d 反向对照：**卡面**不许跟着放宽 —— PRD §17 有整卡字数硬上限，
    //   卡面上这条仍必须是压过的（且它必须比原句短）。放宽只发生在报告那一格。
    // ㉖f ★★ Owner 2026-10-19 后令：「**修改建议是可以 30 字的，不带标点这些，可以多写一些**」
    //   ⇒ 数的是**实词字数**（标点不计）。这条钉住两件事：`over` 按新口径算、且**不许因此放宽总量**。
    const PUNCT_HEAVY = '删「最」字，改为「更」；'.repeat(8);
    eq(`㉖f 标点不计：字符数 >${ADVICE_MAX} 但实词 ≤${ADVICE_MAX} ⇒ 不算超`,
       [_prd533CountChars(PUNCT_HEAVY) > ADVICE_MAX, countAdviceChars(PUNCT_HEAVY) <= ADVICE_MAX,
        fitAdvice(PUNCT_HEAVY, ADVICE_MAX).over], [true, true, false]);
    // 反向对照：把标点换成实词（同样的长度）⇒ 必须算超 —— 证明放宽的是标点，不是总量
    const NO_PUNCT = PUNCT_HEAVY.replace(/[，；。「」]/g, '呀');
    eq(`㉖f2 反向对照：同长度的实词句 ⇒ 必须超过 ${ADVICE_MAX}`,
       [countAdviceChars(NO_PUNCT) > ADVICE_MAX, fitAdvice(NO_PUNCT, ADVICE_MAX).over], [true, true]);

    // ㉖e ★★ Owner 2026-10-19 抓的真形状：`修改建议：改为…`（后面什么都没有）
    const deg = clipToLimit(('改为「discreet enough to pump at work or on the go」；').repeat(3), ADVICE_MAX);
    eq('㉖e 兜底压缩不超过上限，且不留下未闭合引号',
       [countAdviceChars(deg.text) <= ADVICE_MAX, /^改为…$/.test(deg.text), /「[^」]*$/.test(deg.text)],
       [true, false, false]);
    // ㉖e2 反向对照：正常长句照旧在分句边界压，**不许**因为上面那条就全改成"剃掉引号"
    const normal = clipToLimit(('删去 unique，改为描述双层密封结构并补一张结构示意图，详情页写清材质；').repeat(2), ADVICE_MAX);
    eq('㉖e2 反向对照：正常长句超限时缩短并在上限内',
       [normal.text.includes('删去 unique'), countAdviceChars(normal.text) <= ADVICE_MAX,
        normal.text.length < ('删去 unique，改为描述双层密封结构并补一张结构示意图，详情页写清材质；').repeat(2).length],
       [true, true, true]);

    const card = renderMergedItem(item, 0, { layout: 'card' });
    const cline = (card.match(/\*\*建议\*\*：(.+)/) || [])[1] || '';
    eq(`㉖d 卡面建议同样遵守 ${ADVICE_MAX} 字上限`,
       [countAdviceChars(cline.trim()) <= ADVICE_MAX, cline.includes(LONG)], [true, false]);
  }

  // ★★ 2026-10-20（Owner 选「先修位置再验证」）：**位置按素材块给三形态之一**（⑳）。
  //   改前 P0 条目的位置写死 `全文`（2026-10-17 的裁定）；工具侧现在按「命中行号 + 块头」读坐标。
  //   ⑳c 是反向对照：同一句素材**去掉块头**必须回落 `正文第 N 段`（证明是"读块"在起作用）。
  {
    const _img = '【图片 1 的图内文字（本机 OCR）】\n这款吸奶器 100% 值得买。';
    const _vid = '【视频 1｜a.mp4｜12.0s｜关键帧 1/1 帧读成功】\n画面上的字（按时间码）：\n[00:07] 这款吸奶器 100% 值得买。';
    const _mk = (text) => (p0FindingsToItems([{ rule_code: 'H05',
      matched: [{ line: String(text).split('\n').length, pattern: '100%', line_text: 'x' }] }], { text })[0] || {}).location;
    eq('⑳a 图片块里的命中 ⇒ 「图 1 第 X 处」', /^图 1 第 \d+ 处$/.test(String(_mk(_img))), true);
    eq('⑳b 视频块里带时间码的行 ⇒ 「视频 MM:SS」', _mk(_vid), '视频 00:07');
    eq('⑳c 反向对照：去掉块头 ⇒ 回落「正文第 N 段」', /^正文第 \d+ 段$/.test(String(_mk('这款吸奶器 100% 值得买。'))), true);
    eq('⑳d 没有行号 ⇒ 如实回落「全文」（不编坐标）', positionFromLines([], _img), '全文');
  }

  console.log(`\n自证：通过 ${pass} / 失败 ${bad.length}`);
  return bad.length ? 1 : 0;
}


/* ═══════════ 库侧：从链的结论原文里抽 findings 与覆盖信号 ═══════════ */

/**
 * 库里那条「覆盖缺口」不是**内容问题** —— 它是库在说「我管不到这个题材」。
 * 合并时要把它与真 findings 分开：混在一起会让「问题数量」虚高，
 * 而人看到的是一张写着「发现 1 处问题」却指不出内容问题的单子。
 */
export const COVERAGE_CATEGORY = '覆盖';

/**
 * 负面样本规则六个类码的中文名 —— **逐字取自知识库**（`kb/l3/registry/negative_rules.json`
 * 的 `rules_by_label`，每条规则的 `rule_code_label` 就是这几个字）。
 * ⚠️ 这里**不重做分类**，只是把引擎已经在用的类码翻成读者看得懂的一个词；
 *   改口径去改知识库，别在这里加第七个。
 */
const NEG_RULE_CLASS = {
  'N-00': '审核问题', 'N-01': '品牌一致性', 'N-02': '原则性错误',
  'N-03': '措辞表达', 'N-04': '文化禁忌', 'N-05': '合规红线',
};

/**
 * 把「负面样本规则」里那句原文压成**本单可用的中性问题描述**（Owner 2026-10-22）。
 *
 * Owner 原话：「命中知识库规则的，**只写问题描述，不写历史两个字**，改说法」。
 * 病在哪（真单 F-03）：那条的「原因」整格是「相似历史审核意见（point·参考）：
 * 匹配分 1.00…⚠️ 非本单素材逐字命中｜该历史意见未指定图号…」——
 * 读者要的是「画面哪里不对」，拿到的是一段匹配元数据；「问题描述」那一格还空着。
 *
 * 所以这里做两件事，**都不改事实**：
 *   ① 只取**风险事实**那半句（去掉载体/版面前缀、建议句、@提及、括注）；
 *   ② 人称中性化：`爸爸/妈妈/家长 → 成人`、`宝宝/孩子/娃 → 婴幼儿` ——
 *      只换称呼，不换动作与物品（「跟爸爸同床」不会变成「一个人睡」）。
 * ⚠️ 抽不出东西就**返回空串**，由调用方如实写「条款所列情形」——
 *   不拿原文硬凑一句描述（那才是把别人的素材当本单的描述）。
 */
export function neutralHistoryFacts(text) {
  let s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  s = s
    .replace(/【[^】]*】/g, '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/@[^\s，。；、]+/g, '')
    // 载体/版面前缀：那是**别的素材**的编排信息，不是问题本身
    .replace(/(?:^|[，,；;])\s*(?:视频|图片|图\s*\d+|Slide\s*\d*|配图|主标题|副标题|字幕|文案|海报)[^，,；;。]*/gi, '');
  // 纯「建议 / 推荐方案 / 改法」句不是问题描述 —— 它已经有「修改建议」那一格。
  if (/^(?:建议|推荐方案|改为|改成|应改|宜改|替换为|换成)/.test(s.trim())) return '';
  // 人称中性化（只换称呼）
  s = s
    .replace(/(?:新手)?(?:爸爸|妈妈|父亲|母亲|宝妈|家长|大人|父母)/g, '成人')
    .replace(/(?:小)?(?:宝宝|孩子|娃|婴儿|幼儿|新生儿)/g, '婴幼儿');
  const RISK = /(同床|共睡|睡|趴|侧卧|仰卧|俯卧|抱|搂|喂|高处|坠落|摔|水|电|绳|被|毯|枕|遮|盖|口鼻|裸|烟|酒|药|刀|尖|小零件|玩具|站立|坐在|放置|放入|接触|靠近|倒着放|倒放|奶瓶|卫生|消毒|杀菌|不符合用户习惯|没有Massage|无按摩功能|刻度线对比|品牌名)/i;
  const DROP = /(建议|推荐|改为|改成|应|必须|需|标注|添加|箭头|指引|终审|麻烦|看看|排版|字号|颜色|字体)/;
  const segs = s.split(/[，,；;。]/).map((x) => x.trim()).filter(Boolean)
    .filter((x) => !DROP.test(x) && RISK.test(x));
  const out = segs.join('，')
    .replace(/^(?:画面是|画面为|图中是|图里是)/, '')
    .replace(/[，,]\s*$/, '')
    .trim();
  return out.length >= 4 ? out : '';
}

/**
 * 同图历史参考 / 串图参考 —— **不是本单素材的问题**，不计入问题数与结论。
 *
 * 库侧给它带的是 `history_attribution`（中文口径，如「同图历史意见（本图是库内复用图，
 * 该图还出现在其它记录）」），`reason` 里还会写「非本单素材」。
 * 这些条目没有 `subject` 归属，按 `kb/l8/check_attribution_gate.py` 的口径不能当本单依据；
 * 但**仍要展示**（放进 candidates 当参考），只是不参与 `共发现 N 处`。
 *
 * @param {object} row `risk_items[]` 或正则路径构造的 item
 * @returns {boolean}
 */
function isHistoryReference(row) {
  const x = (row && typeof row === 'object') ? row : {};
  const blob = [x.history_attribution, x.reason, x.reasonLine, x.basisLine,
    x.description, x.history_scope, x.history_record_id].map((v) => String(v ?? '')).join(' ');
  // ⚠️ 只认「同图复用 / 记录级 / 共享引用」这三类；**不认**「非本单素材」这句 ——
  //   N-1.x 历史审核意见也常带这句话，但它是库内规则（可能适用本单），仍要进 findings。
  return /同图历史意见|复用图|record_level|shared_reference/.test(blob);
}

/**
 * 从链的结论原文里把**引擎 JSON** 挖出来，拿它的 `risk_items` 当库侧条目（结构化）。
 *
 * 返回 `null` = 「这条路没走通」⇒ 调用方原样退回逐行正则（**不许静默少报**）。
 *
 * 为什么值得单独一条路（2026-10-08 实测，见 `kbFindingsOf` 抬头）：
 *   `risk_items[].evidence` 同时带着 **条款号 / 锚点 / source_sha256 / 命中片段 /
 *   `l0_entry_url`（飞书源直链）** —— 这五样正是「依据」那一行要的东西，
 *   而**逐行正则只捞得到中文**，捞不到其中任何一项。
 */
function _kbFromEngineJson(answer, engine = null) {
  const s = String(answer ?? '');
  // ★★ 2026-10-08（第七批）：**优先用链直接带回来的那份引擎 JSON**（`engine` 参数）。
  //   为什么它是主路而不是备路：`answer` 是 **headless agent 自己组织的散文** ——
  //   措辞会被模型改写，≥3 条时按 PRD §5.3.3 还**没有逐条行**；而结构化字段
  //   （条款号 / 锚点 / `source_sha256` / 命中片段 / `l0_entry_url`）**只在这份 JSON 里**。
  //   ⇒ 链路已把它原样落成机读件（`kb/.work/last_engine_out.json`）。走它就不必猜措辞。
  //   从回答里挖那条**保留**（历史形状仍认、老旁挂仍能用）。
  let obj = (engine && typeof engine === 'object') ? engine : null;
  // ★ 用**花括号配对**提取，不用 `JSON.parse(s.slice(i))` ——
  //   链的回答是「模板行 + 引擎 JSON + 转述模板段」，**JSON 后面还有文本** ⇒
  //   直接 parse 到结尾会因为尾部文本失败，结果是**一条都解析不出来**（静默退回正则）。
  for (let i = obj ? -1 : s.indexOf('{'); i !== -1; i = s.indexOf('{', i + 1)) {
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let j = i; j < s.length; j += 1) {
      const c = s[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '{') depth += 1;
      else if (c === '}') { depth -= 1; if (depth === 0) { end = j; break; } }
    }
    if (end === -1) continue;
    try { obj = JSON.parse(s.slice(i, end + 1)); break; } catch { /* 这个 { 不是起点，继续 */ }
  }
  if (!obj || typeof obj !== 'object') return null;
  const dec = (obj.decision && typeof obj.decision === 'object') ? obj.decision : obj;
  const rows = Array.isArray(dec.risk_items) ? dec.risk_items : null;
  if (!rows || !rows.length) return null;
  const out = []; let coverage = null;
  const candidates = [];        // ★ 非权威候选线索（不进 findings，见下面那一段）
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const ev = (r.evidence && typeof r.evidence === 'object') ? r.evidence : {};
    const art = ev.article_no || null;
    const anc = ev.anchor || null;
    const exc = String(ev.excerpt || r.original_text || '').trim().slice(0, 120);
    // 直链：`l0_entry_url` 优先；否则 `evidence_url` 里**只认 http(s)**（本地路径不是链接）
    const link = String(ev.l0_entry_url || '').trim()
      || (/^https?:\/\//i.test(String(r.evidence_url || '')) ? String(r.evidence_url).trim() : '');
    // 依据行：结构化字段拼；**取不到的格子不编**（宁可少一项，不许造）
    const basisLine = `《${ev.library || '知识库'}》${art ? `第 ${art} 条` : '（未给条款号）'}`
      + (exc ? ` ← 命中「${exc}」` : '')
      + (anc ? `｜锚点：${anc}` : '')
      + (link ? `｜原始出处：${link}` : '');
    const rt = String(r.risk_type || '未分类');
    const dash = rt.indexOf('-');
    // ★★ 2026-10-09（② 自证阶段查出来的**真 bug**，不是新功能）：
    //   `category` **优先读引擎自己给的字段**，「按 `-` 拆 `risk_type`」只作回落。
    //   实测引擎的覆盖行是 `{risk_type:'覆盖缺口', category:'覆盖'}` —— `risk_type` 里**没有连字符**，
    //   于是拆出来的类目是 `覆盖缺口`，**不匹配 `COVERAGE_CATEGORY`（`'覆盖'`）**
    //   ⇒ 这一条被**误归进 `findings`**、`coverage` 恒为 `null`。
    //   代价不只是归类好不好看：`coverage.reasonLine` 是**唯一**渲染「库内命中（读数）」的位置
    //   ⇒ Owner 要的「命中原文 + 飞书链接」**永远不会出现**。
    //   ⚠️ 上一轮我拿**合成样本**"验过"这条路，样本里的 `category` 是我自己填的，
    //      **恰好绕开了这个 bug** ⇒ 那次"验证通过"是假的。教训：**样本不对，结论就是假的**；
    //      验一条来路必须喂**真实产出物**（`kb/.work/last_engine_out.json` / `/tmp/_ev*.out`）。
    //   ⇒ 口径：**引擎给了就照搬**，没给才按 `risk_type` 拆（老形状仍然认）。
    const catExplicit = String(r.category || '').trim();
    const category = catExplicit || (dash > 0 ? rt.slice(0, dash) : rt).trim();
    const sub = dash > 0 ? rt.slice(dash + 1).trim()
      : (catExplicit && rt.startsWith(catExplicit) ? rt.slice(catExplicit.length).trim() : '');
    // ★★ 2026-10-22（Owner：「命中知识库规则的，只写问题描述，不写历史两个字，改说法」）：
    //   负面样本规则（N-0x）那批条目，引擎给的 `reason` 是**匹配元数据**
    //   （相似历史审核意见／匹配分／记录级…），读者要的是「画面哪里不对」。
    //   ⇒ 问题描述取**风险事实**（`neutralHistoryFacts`），原因只留「条款判为哪一类 +
    //     需人工确认是否适用本单」；两个格子里**都不出现「历史」**。
    //   ⚠️ 只改**说法**，不改判定：条目照旧计入、条款号照旧可回源，
    //     也没有把「相似召回」说成「本单逐字命中」—— 最后那半句「需人工确认是否适用本单」
    //     就是留给这条误差的。
    const ruleCode = String(r.rule_code || '').trim();
    const histRule = /^N-0\d$/.test(ruleCode);
    const facts = histRule ? neutralHistoryFacts(r.history_rule_text) : '';
    const histReason = histRule
      ? [facts, NEG_RULE_CLASS[ruleCode] ? `条款判为${NEG_RULE_CLASS[ruleCode]}` : null,
        '需人工确认是否适用本单画面'].filter(Boolean).join('，')
      : '';
    const description = histRule
      ? (facts || `条款 ${art || '（未给条款号）'} 所列情形需人工确认是否适用本单画面`)
      // 其它层维持原样（`null` ⇒ 报告如实写「本条未提供问题描述」）——
      // 本轮只改 N-0x 这一族的说法，不顺手改别的层的展示（少做少错）。
      : null;
    const item = {
      location: String(r.location || '全文').slice(0, 120) || '（未给位置）',
      category,
      sub,
      severity: String(r.action || '').toLowerCase() === 'block' ? 'BLOCK' : 'REVIEW',
      // ★ 2026-10-17：库侧也能有「问题描述」（P0 快路那条来路给了逐字命中）；
      //   N-0x 这条来路由上面 `description` 给（中性事实），**不再空着**。
      description,
      reason: histRule ? histReason : String(r.reason || '').slice(0, 300),
      // ★ 2026-10-14：链这条来路**本来就把 `exc` 算出来了**（`ev.excerpt || original_text`），
      //   却只拼进 `basisLine` 的字符串里没挂在条目上 ⇒ `sameOrigin` 拿不到它。
      //   「判据抓对了、搬运却在这一行把字段丢了」—— 与 2026-10-08 `basisLine` 那次同一个形状。
      excerpt: exc || null,
      basis: 'kb', basisLine,
      reasonLine: histRule ? histReason : String(r.reason || '').slice(0, 300),
      // ★ 2026-10-09：**引擎 JSON 这条来路也要带 `suggestionLine`**。
      //   库侧条目有**两条来路**：正则抠逐条块（`kbFindingsOf` 下半段）与
      //   **结构化 `risk_items`**（这一段，⑯a 说它**优先**）。
      //   我只补了正则那条 ⇒ 走引擎 JSON 时库侧的建议**照样被丢**，
      //   而 `r.suggestion` 就在手边（`review_engine.py:321` 读的正是这个字段）。
      //   教训：补一条「搬运」时要把**这个字段的每一条来路**都数一遍 ——
      //   今天的病全是同一个形状（两个产出者，只修了一个）。
      suggestionLine: String(r.suggestion || '').trim() || null,
      // ★★ 2026-10-17（Owner：报告按「审计报告」模式重做）：**优先级与维度必须搬过来**。
      //   引擎 `risk_items` 里本来就有（`with_kb_evidence.py::_to_risk_item` 投影了
      //   `priority_tier` / `priority_tier_basis` / `risk_category` / `risk_category_basis`），
      //   而这一层**一格都没带** ⇒ 渲染层拿不到 P 级与维度，
      //   报告只能不分级、不分组（这一步做出来之前它连「先按 P 级」都不可能）。
      //   ⚠️ 这是第三次同一个形状（2026-10-08 `basisLine`、2026-10-09 `suggestionLine`、
      //      今天这两对）—— **搬运漏一格 = 报告少一格**。
      priorityTier: String(r.priority_tier || '').trim().toUpperCase() || null,
      priorityTierBasis: String(r.priority_tier_basis || '').trim() || null,
      riskCategory: String(r.risk_category || '').trim() || null,
      riskCategoryBasis: String(r.risk_category_basis || '').trim() || null,
      // ★★ 2026-10-17（Owner：「既然分了11类，就要按照11类的出结果」）：
      //   **11 类 / 58 子类**由引擎逐条盖在 finding 上（`review.py::stamp_taxonomy`），
      //   真源 `kb/l3/registry/rule-taxonomy.json`（**人工口径、Owner 采用，不是源表字段**）。
      //   ⚠️ 它与 `riskCategory`（PRD §5.3 四维）**是两件不同的东西**，互不顶替；
      //      这一格只用于「按 11 类」的附加汇总，不改 PRD 结论行与逐条格式。
      taxonomyCategory: String(r.taxonomy_category || '').trim() || null,
      taxonomySubcategory: String(r.taxonomy_subcategory || '').trim() || null,
      kb: { article_no: art, anchor: anc, entry_url: link || null,
            source_sha256: ev.source_sha256 || null, library: ev.library || null, basisLine,
            suggestionLine: String(r.suggestion || '').trim() || null,
            // ⚠️ 必须**同时**挂进 `kb` —— `mergeFindings` 是**白名单式重建**条目
            //   （`pickKb` / `pickModel`），顶层字段到不了渲染层，只有进 `kb` 才活得下来。
            priorityTier: String(r.priority_tier || '').trim().toUpperCase() || null,
            priorityTierBasis: String(r.priority_tier_basis || '').trim() || null,
            riskCategory: String(r.risk_category || '').trim() || null,
            riskCategoryBasis: String(r.risk_category_basis || '').trim() || null,
            taxonomyCategory: String(r.taxonomy_category || '').trim() || null,
            taxonomySubcategory: String(r.taxonomy_subcategory || '').trim() || null },
      // ★★ 2026-10-14（Owner：「所有参考知识库的，都必须带飞书侧源链接」）：
      //   **把库自己的「不权威」声明读出来**。`scan_text()` 产的非权威候选带着
      //   `authoritative: false`（种子规则自己写着「这不是知识库的规则真源」），
      //   而这一格此前**守衡侧全文零命中** ⇒ 候选与真依据长得一模一样：
      //   实测那张 hospital-grade 卡，候选那一条被贴成 `**有库内条款依据**`
      //   ＋ `《知识库》（未给条款号）` —— **既冒称依据，又给不出链接**。
      //   ⚠️ 判据是**显式 `false`**（与库侧 `review_engine.is_candidate()` 同口径）：
      //      真依据**根本没有这个键**，把「缺键」当候选会把全部库内依据打成候选。
      authoritative: (r.authoritative === false ? false : null),
    };
    if (item.category === COVERAGE_CATEGORY) { coverage ??= item; continue; }
    // ★★ 2026-11-03（Owner：问题数只算素材风险）：同图历史参考 / 串图参考
    //   不计入 findings —— 它证明的是「这张图在库里还挂在别的记录上」，
    //   不是「本单素材有问题」。保留成参考条目（candidates），仍可在报告里看见。
    if (isHistoryReference(r)) { candidates.push({ ...item, authoritative: false, reference: true }); continue; }
    // 候选**不进 findings** —— 它是排查线索，不是「共发现 N 处」里的 N
    // （库侧 `issue_count` 本来就不含候选，另走 `candidate_count`）。
    if (item.authoritative === false) { candidates.push(item); continue; }
    out.push(item);
  }
  return { findings: out, coverage, candidates };
}

/**
 * Owner 要的那一块：**命中原文 + 飞书链接**。
 *
 * ⚠️ 为什么单独一个函数、而不是塞进 `coverage.reasonLine`（**这是我今天栽的第二个坑**）：
 *   我第一版把它挂在 `coverage` 上，然后拿合成样本"验过" ⇒ 看着是对的。
 *   可 `agent.mjs:762-768` 里 **`kb.coverage` 压根没被用过** ——
 *   `mergeFindings(kb.findings, model.findings)` 只吃 `findings`，
 *   `renderMerged` 里那条 `covNote` 是**写死的一句话**，不是 `coverage.reasonLine`。
 *   ⇒ 我把字渲染进了**一个没人读的字段**：跑得通、断言绿、卡上一个字都没有。
 *   教训（第三次同一个形状）：**改产出者之前先读消费者**；「我这边验过」不等于「人看得见」。
 *   ⇒ 现在它是一等字段 `kbHitsBlock`，由 `renderMerged` 直接印进卡片正文。
 *
 * 定性（必须跟着一起印，不许省）：
 *   这是**读数**，不是判定依据 —— 命中大多是**别人的素材样本 / 外部材料**，
 *   不构成该素材的合规依据 ⇒ 标注里写死「不得据此当 PASS 依据」。
 *   **它不参与任何判定**（三态一个字不改）。
 *
 * @param {object|null} engine 引擎最终 JSON（`kb/.work/last_engine_out.json`）
 * @returns {string|null} 要印的 markdown 块；没有读数时返回 `null`（**不编**）
 */
export function kbHitsBlockOf(engine) {
  const hits = (engine && typeof engine === 'object')
    ? (((engine.evidence_meta || {}).kb_hits) || null) : null;
  if (!Array.isArray(hits) || !hits.length) return null;
  const rows = hits.slice(0, 8).map((h, i) => {
    const ex = String(h?.excerpt || '').trim();
    const url = String(h?.url || '').trim();
    const sha = String(h?.source_sha256 || '').trim();
    return `${i + 1}. \`${h?.anchor || '(无锚点)'}\`｜BM25 ${h?.bm25 ?? '?'}｜${h?.kb_type || '未标类型'}`
      + (h?.article_no ? `｜条款号 ${h.article_no}` : '')
      + `\n   命中原文（逐字）：${ex || '**该单元没给片段**'}`
      + `\n   飞书直链：${url || '**取不到直链**（该单元没有 L0 直链，别去找）'}`
      + (sha ? `\n   指纹 source_sha256：\`${sha.slice(0, 16)}…\`` : '');
  }).join('\n');
  const more = hits.length > 8 ? `\n（只列前 8 条，本次共 ${hits.length} 条）` : '';
  return `【库内命中（读数）】本次检索命中 ${hits.length} 条，逐条列出**原文与飞书直链**：\n`
    + `${rows}${more}\n`
    + '⚠️ 上面是**读数**：命中的大多是**别人的素材样本 / 外部材料，不是覆盖本素材的条款**，'
    + '**不得据此当 PASS 依据**，也不得当作「本素材已合规」的证明。';
}

/**
 * 从 PRD §5.3 的**逐条块**里抽库侧 findings。
 *
 * 口径：`^\d+.【类目-子类】位置…`（§5.3.2 / §5.3.3 的格式，由 `render_summary` 产出，
 * 并由 `tools/verify_cards.mjs` 的 W 段与 `l7_integrity.py` 钉住）。
 * **类目为「覆盖」的那条不算 finding**，单独返回在 `coverage` 里。
 *
 * @param {string} answer 链给的结论原文
 */
/**
 * ★★ 2026-10-14：**把「真实命中文字」接上来 —— 这正是「同问题取交集」缺的那一格**。
 *
 * 裁决（2026-10-08 Owner，见本文件题注）：「两侧命中的**逐字片段有重叠** ⇒ 算同一条」。
 * 而实跑里 `sameOrigin` 恒返回「一侧没有逐字命中片段（无从比）」——
 * **库侧条目两条来路都不带 `excerpt`/`matched_term`**，判据要的东西根本不在数据里。
 * ⇒ 交集在**实测 123 次双轨里一次都没成立过**（`双轨确认`＋`冲突降 REVIEW` 全为 0）。
 *
 * 这一格的来路是**搬**不是造：P0 快路 CLI 的 `findings[].matched[].{line_text, span}`
 * 就能切出**真实命中文字**。为什么不拿收据里印的「命中正则」（如 `最\s*(好|佳|…)`）当片段：
 * 正则永远不可能与模型侧引用的原句「重叠」，拿它去比等于没接。
 * 取不到 ⇒ **不挂**（不编一个空串去骗判据）。
 */
export function p0MatchedMap(p0Findings) {
  const byPattern = new Map();
  for (const f of (Array.isArray(p0Findings) ? p0Findings : [])) {
    for (const m of (f?.matched ?? [])) {
      const pat = String(m?.pattern ?? '');
      if (!pat || byPattern.has(pat)) continue;
      const lt = String(m?.line_text ?? '');
      const sp = Array.isArray(m?.span) ? m.span : null;
      if (!sp || sp.length !== 2 || !lt) continue;
      const txt = lt.slice(Number(sp[0]), Number(sp[1])).trim();
      if (txt) byPattern.set(pat, txt);
    }
  }
  return byPattern;
}

/** 从位置串里取回「命中片段」（P0 收据印成 `` `X` ``，多个用「、」连）⇒ 换成**真实命中文字**。 */
export function excerptFromLocation(location, byPattern) {
  if (!byPattern || !byPattern.size) return null;
  const hits = [...String(location ?? '').matchAll(/`([^`]+)`/g)]
    .map((x) => byPattern.get(x[1])).filter(Boolean);
  return hits.length ? [...new Set(hits)].join('、') : null;
}

// ── 位置：按**素材块**给 PRD §5.3.3 的三形态之一（2026-10-20）──────────────────
//
// ★ 改前：P0 条目的位置**写死 `全文`**（2026-10-17 的裁定是「P0 是全文匹配，不编段号」）。
//   2026-10-19 那张**图片单**证明这条裁定在图片/视频上不成立 —— 报告里「位置」那一列
//   对业务侧毫无指认作用（同一单里库侧条印 `正文第 7 段`，素材里根本没有正文）。
//   现在用**命中行号 + 链送进来的块头**读坐标，读不出才回落 `全文`：
//     · `【图片 N …】` 块 ⇒ `图 N 第 X 处`（X = 该条在这张图里的第几处命中）
//     · `【视频 N …】` 块 + 该行带时间码（`[12.3s]` / `[00:12]`）⇒ `视频 MM:SS`
//     · 其余 ⇒ `正文第 N 段`
//   ⚠️ 与库侧 `kb/l5/p0_fastpath.py::_position_of` **同一口径**：改一处必须改另一处。
const _IMG_HEAD = /^【\s*图(?:片)?\s*(\d+)[^】]*】/;
const _VID_HEAD = /^【\s*视频\s*(\d+)[^】]*】/;
const _FRAME_TC = /\[(\d+(?:\.\d+)?)\s*s?\]|\[(\d{1,2}):(\d{2})\]/;

/** 把素材原文按块头切段：`[{kind,index,start,end}]`（行号 1 起、闭区间）。 */
export function materialBlocks(text = '') {
  const lines = String(text ?? '').split('\n');
  const out = [];
  let cur = { kind: 'text', index: null, start: 1, end: 0 };
  for (let i = 1; i <= lines.length; i += 1) {
    const mi = _IMG_HEAD.exec(lines[i - 1]);
    const mv = _VID_HEAD.exec(lines[i - 1]);
    if (!mi && !mv) continue;
    cur.end = i - 1;
    if (cur.end >= cur.start) out.push(cur);
    cur = mi
      ? { kind: 'img', index: Number(mi[1]), start: i, end: 0 }
      : { kind: 'video', index: Number(mv[1]), start: i, end: 0 };
  }
  cur.end = lines.length;
  if (cur.end >= cur.start) out.push(cur);
  return out;
}

/** 一行里的帧时间码 ⇒ 秒（读不出返回 null）。 */
export function frameSecond(line = '') {
  const m = _FRAME_TC.exec(String(line ?? ''));
  if (!m) return null;
  if (m[1] !== undefined) return Math.trunc(Number(m[1]));
  return Number(m[2]) * 60 + Number(m[3]);
}

/** 命中行号 + 素材原文 ⇒ PRD 三形态之一（或 `全文`）。 */
export function positionFromLines(lines, text = '') {
  const uniq = [...new Set((Array.isArray(lines) ? lines : [])
    .map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0))].sort((a, b) => a - b);
  if (!uniq.length) return '全文';
  const blocks = text ? materialBlocks(text) : [];
  const src = String(text ?? '').split('\n');
  const byImg = new Map(); const vids = []; const txt = [];
  for (const ln of uniq) {
    const b = blocks.find((x) => x.start <= ln && ln <= x.end) || null;
    if (b && b.kind === 'img') {
      if (!byImg.has(b.index)) byImg.set(b.index, []);
      byImg.get(b.index).push(ln);
    } else if (b && b.kind === 'video') {
      const sec = (ln - 1 >= 0 && ln - 1 < src.length) ? frameSecond(src[ln - 1]) : null;
      if (sec === null) txt.push(ln);
      else vids.push(`视频 ${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`);
    } else txt.push(ln);
  }
  const out = [];
  for (const idx of [...byImg.keys()].sort((a, b) => a - b)) {
    const ks = byImg.get(idx).map((_, k) => k + 1);
    out.push(`图 ${idx} 第 ${ks.slice(0, 3).join('、')} 处${ks.length > 3 ? '等' : ''}`);
  }
  out.push(...vids);
  if (txt.length) {
    const shown = txt.slice(0, 3);
    out.push(`正文第 ${shown.join('、')} 段${txt.length > shown.length ? '等' : ''}`);
  }
  return out.length ? out.join('；') : '全文';
}


/**
 * **P0 快路的命中 ⇒ 一等条目**（2026-10-17，Owner 拿着报告来问的那两条）。
 *
 * ── 病灶（实测，`merged-2026-10-17T01_48_20` / 文档 `XzNxdvaE1o3KuJxSuAqcftRdnqd`）──
 *   那一单库侧走 **P0 快路**：`[p0] 🚦 P0 命中 ⇒ 直接 BLOCK，不起链：H02,H05,M03`，
 *   还**自己出过一份 3 条的 report**（`QthVdRYFVo9R9XxpDiSckCZKnfd`，两端对齐 3/3/3）。
 *   而双轨那份合并报告：`结论=BLOCK/3 条 ｜ 逐条抽出 0 条` ⇒
 *     · 结论行写「共发现 **9** 处」（= 模型侧 6 ＋ 库侧缺口 3），**清单只有 6 条**；
 *     · 总结论 BLOCK，**6 条全是 REVIEW** ⇒ 读者找不到是谁把它拦下来的。
 *   两个症状同一个病根：`p0_findings` 一直被当成「修 `excerpt` 的辅助数据」
 *   （`p0MatchedMap`），**从来没被变成条目**。
 *
 * ── 为什么能变成条目（字段都齐，不需要编）────────────────────────────────
 *   一条 P0 命中带：`_category`（= `类别-子类`，如「功效宣称-催乳与通乳宣称」）、
 *   `article_no`、`anchor`、`source_sha256`、`verbatim.entry_url`（**飞书源直链**）、
 *   `_l3.reason`、`suggested_replacement`、`matched[].span/line_text`（逐字命中）。
 *   ⇒ 维度由 `risk-category-policy.json` 映射（查不到就 `null`，**不猜**）。
 *
 * ── 三条边界 ──────────────────────────────────────────────────────────
 *   · **不新造判定**：`severity` 恒 `BLOCK`（P0 命中即拦，PRD §6.6），不是这里判的；
 *   · 取不到的格子**留空并如实说**（没有 `entry_url` 就不给链接，没有 reason 就说没有）；
 *   · 与结构化 `risk_items` 重叠时**按 `anchor|article_no` 去重**（不重复计数）。
 *
 * @param {Array|null} p0Findings `res.p0_findings`（`kb/l5/p0_fastpath.py` 的 `findings`）
 * @param {{text?: string}} [opts] `text` = 这一单的素材原文（链送进来的那份，带块头）。
 *   2026-10-20 加：位置那一格要按块给形态，就得看原文；不给 ⇒ 位置回落 `正文第 N 段`
 *   （与改前一致，老调用方/夹具行为不变）。
 * @returns {Array} 与 `kbFindingsOf` 产出的条目同形的条目
 */
export function p0FindingsToItems(p0Findings, { text = '' } = {}) {
  const list = Array.isArray(p0Findings) ? p0Findings : [];
  const out = [];
  for (const f of list) {
    if (!f || typeof f !== 'object') continue;
    const rc = String(f.rule_code || '').trim() || null;
    // 逐字命中：`matched[0]` 的 `span` 切 `line_text`
    const m = (Array.isArray(f.matched) ? f.matched : [])[0] || null;
    const lt = String(m?.line_text ?? '');
    const sp = Array.isArray(m?.span) ? m.span : null;
    const hit = (lt && sp && sp.length === 2) ? lt.slice(Number(sp[0]), Number(sp[1])).trim() : '';
    // 类别：`_category` 是 `类别-子类`，按**第一个** `-` 拆（子类里还可能带 `-`）
    const catRaw = String(f._category || '').trim();
    const dash = catRaw.indexOf('-');
    const category = (dash > 0 ? catRaw.slice(0, dash) : catRaw).trim() || '未分类';
    const sub = dash > 0 ? catRaw.slice(dash + 1).trim() : '';
    const l3 = (f._l3 && typeof f._l3 === 'object') ? f._l3 : {};
    const art = String(f.article_no || l3.article_no || '').trim() || null;
    const anc = String(f.anchor || '').trim() || null;
    const vb = (f.verbatim && typeof f.verbatim === 'object') ? f.verbatim : {};
    const url = String(vb.entry_url || '').trim() || null;
    const lib = String(l3.kb_type || '').trim() === 'wording' ? '措辞表达库 v0' : '知识库';
    // ⚠️ 库侧 `reason` 同样是**同族规则的拼接**（一条能到 200+ 字，里面还夹着相邻规则码），
    //   原样印出来业务侧抓不到重点 ⇒ 截断到第一句主要意思，并如实标注另有说明。
    const reasonRaw = String(l3.reason || '').trim();
    let reason = reasonRaw || `命中 P0 红线（模式表判 BLOCK${rc ? `，规则码 ${rc}` : ''}）`;
    if (reasonRaw.length > 180) {
      const seg = reasonRaw.slice(0, 180);
      const stop = Math.max(seg.lastIndexOf('；'), seg.lastIndexOf('。'));
      reason = `${(stop > 60 ? seg.slice(0, stop) : seg)}…（另有同族规则说明，见库内条款）`;
    }
    // ⚠️ 模式表的 `suggested_replacement` 是**整条变体清单的拼接**（实测 2000+ 字，
    //   同一条改法会被「」变体重复十几遍）—— 原样印进报告，业务侧根本读不下去。
    //   这里只取**第一组**（第一处「」之前的动作），并如实标注「完整改法见库内条款」。
    const sugRaw = String(f.suggested_replacement || '').trim();
    let sug = sugRaw || null;
    if (sugRaw) {
      const cut = sugRaw.search(/[；;]\s*「/);      // 第一个变体分隔处
      const first = (cut > 0 ? sugRaw.slice(0, cut) : sugRaw).trim();
      sug = first.length > 260 ? `${first.slice(0, 260)}…` : first;
      if (first.length < sugRaw.length) sug += '（完整改法见库内条款）';
    }
    // ★★ 2026-10-21（Owner：「审查报告中不能出现后台语言」＋「放开还写出来」）：
    //   `_l3.reason` 那一格逐字是 `H05 虚假安全承诺（…按 2026-09-09 口径放开…不再判险）`
    //   —— 带规则码、带口径说明。**过一遍 businessReason**（去规则码/去口径括号/去建议），
    //   判定理由本身一个字不改；清空了才退回原串（不许因为清洗把原因弄没）。
    reason = businessReason(reason) || reason;
    const basisLine = `《${lib}》${art ? `第 ${art} 条` : '（未给条款号）'}`
      + (hit ? ` ← 命中「${hit}」` : '')
      + (anc ? `｜锚点：${anc}` : '')
      + (url ? `｜原始出处：${url}` : '');
    out.push({
      // ★★ 2026-10-20（Owner 选「先修位置再验证」）：**按素材块给三形态之一**，不再写死 `全文`。
      //   2026-10-17 那句「P0 是全文匹配、不编段号」在**图片/视频单**上被 2026-10-19 的真单推翻：
      //   同一张报告里库侧条印 `正文第 7 段`、素材里根本没有正文 ⇒ 业务侧无法指认。
      //   坐标来源于**命中行号 + 链自己的块头**（`【图片 N …】`/`【视频 N …】`），读不出才回落 `全文`。
      location: positionFromLines((Array.isArray(f.matched) ? f.matched : []).map((x) => x?.line), text),
      category, sub,
      severity: 'BLOCK',                    // P0 命中即拦（PRD §6.6），不是这里判的
      source: 'kb',
      reason,
      // 问题描述只说**现象**；规则码属于「依据」那一格（业务侧不需要拿规则码当描述）
      description: hit ? `逐字命中「${hit}」` : null,
      excerpt: hit || null,
      suggestionLine: sug,
      // ★ 分级的**真出处**：P0 快路（模式表 `p_level=P0`）
      priorityTier: 'P0',
      priorityTierBasis: `P0 快路（模式表 p_level=P0${rc ? `，rule_code=${rc}` : ''}）`,
      riskCategory: dimensionForCategory(category, RISK_CATEGORY_POLICY),
      riskCategoryBasis: RISK_CATEGORY_POLICY
        ? 'risk-category-policy.json（库侧唯一口径；未映射则留空待裁）' : null,
      // ★★ 2026-10-19（Owner：「所属类别/所属子类」统一到 A3 12 类）：P0 条目也带上 A3，
      //   否则 P0 单的分类汇总只能落「未归类」。取值来自 `_l3.taxonomy_category`
      //   （库侧 `p0_fastpath._l3_rule` 已带这两格，真源 `rule-taxonomy.json`）。
      taxonomyCategory: String(l3.taxonomy_category || f.taxonomy_category || '').trim() || null,
      taxonomySubcategory: String(l3.taxonomy_subcategory || f.taxonomy_subcategory || '').trim() || null,
      // ⚠️ **顶层也要挂一份** —— `mergeFindings` 走 `pickKb()`，那是**白名单式重建**，
      //   读的是条目的**顶层** `basisLine`/`suggestionLine`/`excerpt`（不是 `kb.*`）。
      //   第一版只挂了 `kb` ⇒ 依据退化成「《知识库》（未给条款号）（锚点：—）」，
      //   来源标记还被判成「非权威候选线索 · 不构成证据」（实测当场就看到）。
      //   这是本文件第四次同一个形状（basisLine / suggestionLine / priorityTier / 这次）。
      basisLine, reasonLine: reason, suggestionLine: sug,
      // ⚠️ 顶层也要挂：`mergeFindings` 的 `pickKb` 读**顶层** `source_sha256`
      //   （第五次同一个形状 —— 只挂进 `kb` 的那一份会被静默丢掉）。
      source_sha256: String(f.source_sha256 || '').trim() || null,
      rule_code: rc,
      kb: { article_no: art, anchor: anc, entry_url: url,
            source_sha256: String(f.source_sha256 || '').trim() || null,
            library: lib, basisLine, suggestionLine: sug,
            description: hit ? `逐字命中「${hit}」` : null,
            priorityTier: 'P0',
            priorityTierBasis: `P0 快路（模式表 p_level=P0${rc ? `，rule_code=${rc}` : ''}）`,
            riskCategory: dimensionForCategory(category, RISK_CATEGORY_POLICY),
            riskCategoryBasis: 'risk-category-policy.json',
            taxonomyCategory: String(l3.taxonomy_category || f.taxonomy_category || '').trim() || null,
            taxonomySubcategory: String(l3.taxonomy_subcategory || f.taxonomy_subcategory || '').trim() || null },
    });
  }
  return out;
}

const _p0Key = (f) => `${String(f?.kb?.anchor ?? '')}|${String(f?.kb?.article_no ?? '')}`;

export function kbFindingsOf(answer, engine = null, p0Findings = null, { text = '' } = {}) {
  // ══════════════════════════════════════════════════════════════════════════
  // ★★ 2026-10-08（第六批）：**结构化优先 —— 先找引擎 JSON 的 `risk_items`**。
  // ══════════════════════════════════════════════════════════════════════════
  // 病灶（Owner 报「依据里没有飞书链接 / 有的条目印成《知识库》（未给条款号）（锚点：—）」）：
  //   本函数原先是**纯逐行正则**抠中文答案。而引擎的逐条明细有**两种落法**：
  //     · 链的模板段把它**展开成真行** ⇒ 正则抠得到；
  //     · 引擎 JSON 里它在 `summary` 的**一个字符串**里（换行是转义的 `\n`）⇒ **一行都抠不到**。
  //   抠不到 ⇒ `basisLine = null` ⇒ 渲染层退回重建版（`《知识库》（未给条款号）（锚点：—）`）
  //   ⇒ **命中文字、条款号、锚点、飞书直链全丢**。这解释了「私聊有、群里没有」的飘忽：
  //   它不是群聊坏了，是**这一条的明细有没有被展开成真行**碰运气。
  //   ★ 顺带修掉另一半：库侧判到 **≥3 条**时 PRD §5.3.3 只出分类汇总、**不出逐条**，
  //     正则永远抠不出 —— 而 `risk_items` 是**结构化且完整**的，与条数无关。
  // 口径（两条，缺一条都不算修好）：
  //   ① 只有**真的解析出 `risk_items` 且非空**才走这条路；解不出/为空 ⇒ 原样退回逐行正则
  //      （**不许**因为换了条路就少报东西）；
  //   ② `依据` 行由**结构化字段**拼：库名 + 条款号 + 命中片段 + 锚点 + **L0 飞书直链**
  //      （直链优先 `evidence.l0_entry_url`，其次 `evidence_url` 里像 http 的那个；
  //      两者都没有就**不编**，如实不带链接）。
  const structured = _kbFromEngineJson(answer, engine);
  // ★★ 2026-10-17：**P0 快路的命中要变成条目**（见 `p0FindingsToItems` 的病灶段）。
  //   两条来路（结构化 / 逐行正则）都要并，且**按 `anchor|article_no` 去重** ——
  //   P0 命中与 L3 命中可能指向同一条款，重复计数会被读成「多报了 N 处」。
  const p0Items = p0FindingsToItems(p0Findings, { text });
  // ★ 2026-10-09：命中读数**两条来路都要带**（结构化 / 逐行正则）——
  //   它与「明细从哪儿抠出来」无关：数据都在**同一份** `engine` 里。
  //   原先只挂在 `coverage` 上（且只在覆盖缺口时才挂）⇒ 常规单子一个字都没有。
  if (structured) {
    const seen = new Set(structured.findings.map(_p0Key));
    const extra = p0Items.filter((f) => !seen.has(_p0Key(f)));
    return { ...structured, findings: [...structured.findings, ...extra],
             kbHitsBlock: kbHitsBlockOf(engine) };
  }

  // ★★ 2026-10-14：P0 快路的**真实命中文字**映射（正则 ⇒ 命中文字）。
  //   没有它，「同问题取交集」判据恒「无从比」—— 见 `p0MatchedMap` 的说明。
  const byPattern = p0MatchedMap(p0Findings);
  const out = []; let coverage = null;
  const candidates = [];        // ★ 非权威候选线索（正则这条来路也要分流）
  const lines = String(answer ?? '').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const m = /^\s*\d+[.、]\s*【([^】]{1,40})】\s*(.*)$/.exec(line);
    if (!m) continue;
    // ★ 2026-10-08：把库侧那条**已经产好的 `依据` 行原样带下来**。
    //   为什么必须搬而不是重建：库侧 `_evidence_line` 现在会带
    //   **逐字命中文案 + 飞书源直链（L0 entry_url）**，而 JS 这一侧**没有** L0 定位能力
    //   （那是 Python 的 `feishu_publish.l0_locate`）。重建只能造出一个更差的版本
    //   （「《知识库》W-1.16（锚点：#…）」—— 点不开、也没说命中什么）。
    //   这就是 §2.4 的「搬是搬」：**能搬就别造**。
    // ★ 逐行抓库侧那两格（原因 / 依据）——**两格都要**：
    //   只抓依据的话，「原因」会退回成位置文字（实测卡片上印的就是
    //   「原因：全文，静音程度夸大…」——那是**位置**，不是原因）。
    let basisLine = null; let reasonLine = null; let suggestionLine = null;
    for (let j = i + 1; j < Math.min(i + 8, lines.length); j += 1) {
      if (/^\s*\d+[.、]\s*【/.test(lines[j])) break;   // 到下一条了就停，别串行
      const b = /^\s*\*{0,2}依据\*{0,2}：\s*(.+)$/.exec(lines[j]);
      if (b) { basisLine = b[1].trim(); continue; }
      const rr = /^\s*\*{0,2}原因\*{0,2}：\s*(.+)$/.exec(lines[j]);
      if (rr) { reasonLine = rr[1].trim(); continue; }
      // ★ 2026-10-09：**「建议」也要抠** —— 库侧 review_engine.py 本来就有 suggestion，
      //   而我们只抠了原因/依据两行，把它丢了 ⇒ 卡片上那一行只能印硬编码的「转对应负责人复核」。
      //   库侧对「没有建议」是诚实的（写「（来源未给修改建议）」）—— 照搬它，别替它编。
      const sg = /^\s*\*{0,2}建议\*{0,2}：\s*(.+)$/.exec(lines[j]);
      if (sg) suggestionLine = sg[1].trim();
    }
    const tag = m[1].trim();
    const dash = tag.indexOf('-');
    const category = (dash > 0 ? tag.slice(0, dash) : tag).trim();
    const sub = dash > 0 ? tag.slice(dash + 1).trim() : '';
    // ★★ 2026-10-19（Owner：「所属类别/所属子类」统一到 A3 12 类）：
    //   库侧卡面首行印的就是 **A3** `【所属类别-所属子类】` ⇒ 这里同时写进 `taxonomyCategory`
    //   两格（渲染层读它）；`category`/`sub` 照旧拆同一段（**别丢**：路由 `directionOf` 还要读）。
    // ⚠️ **必须核一遍**：这个 tag 在很多历史夹具/旧报告里是 **A1 8 类词表**（`【本地化】`），
    //   直接当成 A3 会把「本地化」写成所属类别 ⇒ 报告里凭空多出一条「有 11 类」。
    //   判据 = 注册表的 12 个类名（`TAX_CLASS_ORDER`）；不在里面 ⇒ 置空（渲染层落 `未归类`）。
    const _taxHead = (dash > 0 ? tag.slice(0, dash) : tag).trim();
    const _taxOk = TAX_CLASS_ORDER.includes(_taxHead);
    const item = { location: m[2].trim().slice(0, 120) || '（未给位置）', category, sub,
                   taxonomyCategory: _taxOk ? _taxHead : null,
                   taxonomySubcategory: (_taxOk && dash > 0) ? (tag.slice(dash + 1).trim() || null) : null,
                   severity: /必须修改/.test(String(answer)) ? 'BLOCK' : 'REVIEW',
                   reason: m[2].trim().slice(0, 300), basis: 'kb', suggestionLine,
                   // ★ 2026-10-14：**真实命中文字**（不是收据里印的那个正则）。
                   //   它就是 `sameOrigin` 要比的那一格；取不到时是 null，**不编**。
                   excerpt: excerptFromLocation(m[2].trim(), byPattern),
                   basisLine, reasonLine };
    if (category === COVERAGE_CATEGORY) { coverage ??= item; continue; }
    // ★★ 2026-11-03：正则这条来路也认「同图历史参考」—— 与结构化那条同口径，
    //   不计入问题数（无 engine 的回落路径同样适用）。
    if (isHistoryReference(item)) { candidates.push({ ...item, authoritative: false, reference: true }); continue; }
    // ★★ 2026-10-14：**正则这条来路也认「非权威候选」**（与结构化那条同口径）。
    //   判据用的是库侧 `candidate_item_note()` 那**一句逐字**——它是候选的唯一标记，
    //   而且**由库侧产出**（不是这边猜的）。认不出就照旧当依据（缺键 = 真依据，
    //   与 `is_candidate()` 的「判显式 False，不判缺键」同一条纪律）。
    if (/非权威候选/.test(String(reasonLine || '') + String(suggestionLine || '')
        + lines.slice(i, Math.min(i + 9, lines.length)).join(''))) {
      const candLine = String(basisLine || '');
      candidates.push({ ...item, authoritative: false, kb: { article_no: null, anchor: null,
        entry_url: null, source_sha256: null, library: null, basisLine: candLine } });
      continue;
    }
    out.push(item);
  }
  // ★★ 2026-10-21（Owner：「同一句为什么报成 4 处？」）：**P0 快路的回执不是第二个来源**。
  //   病灶（实测 2026-10-21 那份报告 `merged-2026-10-21T08_37_38.json`）：
  //     同一句送审被判成 4 处 —— F-01/F-02 来自 `p0_findings`，F-03/F-04 是**把同一张回执
  //     再解析一遍**得到的（两条都是 H05/W-1.33 与 V03/E-2.126 的重复）；
  //     而记录里 `kb.issue_count = 2`、报告写 `共 4 处` —— 恒等式当场不成立。
  //   判据：P0 命中即**停链**（PRD §6.3），这一单的 `answer` 就是由 `p0_findings` 渲染出的收据
  //     ⇒ 它**不是独立证据**，解析它等于把自己说过的话再数一遍。
  //   ⚠️ 只在 `!engine`（链没有产出结构化 JSON）且确有 p0 条目时才走这条：
  //     链跑成过的单子照旧并集，**不吞任何来路**。
  if (p0Items.length && !engine) {
    return { findings: p0Items, coverage, candidates,
             kbHitsBlock: kbHitsBlockOf(engine) };
  }
  // ★★ 2026-10-17：P0 命中**排在前面**（红线要先看见），再是正文抠出来的条目。
  return { findings: [...p0Items, ...out], coverage, candidates,
           kbHitsBlock: kbHitsBlockOf(engine) };
}

/**
 * 库侧的**覆盖信号** —— 从结论原文里认。
 *
 * ⚠️ 这是一个**口径偏弱**的判据，我把弱点写在明处：真正的读数在
 *    `kb/.work/last_review_result.json` 的 `refusal.reason_code` 里，
 *    而它**没有随链的返回传到内核这一层**。所以这里退而认我们自己代码产出的那句话。
 *    两个标记都出自 `with_kb_evidence.py`，改那边必须同时改这里 ——
 *    这条配对由 `--selftest` 的 ⑩ 守着（喂坏样本必须判成「没覆盖」）。
 *
 * ★ 它的方向是**保守**的：认不出来时判「没覆盖」⇒ 到不了 PASS。
 *   判错的代价是多一次人工确认，不是放行。
 */
export function kbCoveredOf(answer) {
  const s = String(answer ?? '');
  if (s.includes('coverage_not_covered') || s.includes('覆盖判据不成立')) return false;
  return true;
}

/**
 * 知识库侧的**结构化读数** —— 结论与条数一律从这里取，**不再靠正则抠中文答案**。
 *
 * 两个来源（按路径选，互斥）：
 *   · `res.p0_fastpath`  —— P0 快路：确定性匹配，命中即 BLOCK（PRD §6.6），条数 = `res.issue_count`
 *   · `res.review`       —— 评审链：机读旁挂 `kb/.work/last_review_result.json`
 *                           （`kb/l8/review_run.sh` 从引擎 JSON 原样落盘；本工具侧
 *                            `readReviewSidecar()` 带「必须晚于本次起链时刻」的新鲜度守卫）
 *
 * ★ 为什么必须新增（2026-10-07 实测缺陷，已复现）：
 *   库侧 findings 原先**只从答案文本里正则抠**（`kbFindingsOf`，只认 `1.【类别-子类】位置…`）。
 *   而 PRD §5.3.3 规定 **问题数 ≥3 时库侧只出分类汇总、不出逐条** ⇒
 *   **库侧只要判到 ≥3 条，就会被读成 0 条**。实测两条真素材：
 *     · 「…已获得 FDA 批准，适合所有胸型」→ 库侧 **2** 条 ⇒ 抽到 2 条 ✅（结论保住 BLOCK）
 *     · 「…已通过 FDA 批准，完全无痛，模拟婴儿吸吮」→ 库侧 **3 条 P0（H06/H07/H09，BLOCK）**
 *       ⇒ 抽到 **0 条** ⇒ 合并态被改写成 **REVIEW**（**红线被降级**）
 *   ⇒ 计数与结论**一律以结构化字段为准**；文本抽取只用来补「逐条明细」，缺了要**看得见**。
 *
 * @returns {{source:string, hasSidecar:boolean, state:string, issueCount:number|null,
 *            refused:boolean, reason:string, ruleCodes:Array<string>, reportUrl:string|null,
 *            historyOnly:boolean, historyReferences:number}}
 */
export function kbSideOf(res) {
  const r = (res && typeof res === 'object') ? res : null;

  // ── ① P0 快路：结论由模式表定（命中即 BLOCK），不适用置信度分流 ──
  if (r && r.p0_fastpath && typeof r.p0_fastpath === 'object') {
    const n = Number(r.issue_count);
    return {
      source: 'p0_fastpath', hasSidecar: true, state: 'BLOCK',
      issueCount: Number.isFinite(n) ? n : null,
      refused: false, reason: '',
      ruleCodes: Array.isArray(r.p0_fastpath.rule_codes) ? r.p0_fastpath.rule_codes : [],
      reportUrl: String(r.report ?? '').trim() || null,
      historyOnly: false, historyReferences: 0,
    };
  }

  // ── ② 评审链：机读旁挂 ──
  const rev = (r && r.review && typeof r.review === 'object') ? r.review : null;
  const raw = String(rev?.state ?? rev?.decision ?? '').trim().toUpperCase();
  const state = ['PASS', 'REVIEW', 'BLOCK', 'NEEDS_INPUT'].includes(raw) ? raw : '';
  const n = Number(rev?.issue_count);
  const ref = (rev?.refusal && typeof rev.refusal === 'object') ? rev.refusal : null;
  // ★★ 判「拒答」只认**顶层 `state`**，不认「有没有 `refusal` 字段」（2026-10-07 当天收紧）──
  //   为什么（当天实测把它逼出来了，素材「这条展会物料能不能发：M6 吸奶器附赠收纳袋…」）：
  //     引擎对**覆盖缺口**（`coverage_not_covered`）的形状是
  //       `state = REVIEW` ＋ `refusal.state = NEEDS_INPUT`（后者是**依据侧** review.py 的状态），
  //     而 `with_kb_evidence.py` 那句注释是明确的：
  //       「★ 这里如实写 REVIEW：**下游（飞书落表 / 守衡转述）读的是这个字段**。」
  //   ⇒ 顶层 `state` 才是引擎的**答案**；`refusal` 是**出处/原因**。
  //   第一版写成「有 refusal 就算拒答」（还带一条"只认 reason_code 会漏"的理由）——
  //   那条理由对**供给链超期**那类是成立的（它只有中文 reason），
  //   但它同时把**故意给 REVIEW** 的覆盖缺口也改判成 NEEDS_INPUT ⇒ **判据过宽**。
  //   收紧后：超期那类顶层 state 本来就是 `NEEDS_INPUT` ⇒ 该修的一件不少。
  const refused = state === 'NEEDS_INPUT';
  // ★★ 2026-11-03（Owner：问题数只算素材风险；覆盖缺口可出 PASS+SUGGEST）：
  //   引擎的 `issue_count` 把「同图历史参考 / 串图参考」也算成 N（实测 7.jpg：3 条
  //   全是 `N-00` + 「本图是库内复用图」，于是卡片写「问题数 3」而问题清单是「无」）。
  //   这里按结构化的 `risk_items` 把这部分**从计数里扣掉**；全扣完时记 `historyOnly`，
  //   由 `mergedState` 保持 REVIEW（归属未确认，不能因 0 条就放行成 PASS）。
  const engineRows = (() => {
    const eng = (r?.engine && typeof r.engine === 'object') ? r.engine : null;
    const dec = (eng?.decision && typeof eng.decision === 'object') ? eng.decision : eng;
    return Array.isArray(dec?.risk_items) ? dec.risk_items : [];
  })();
  const histRefs = engineRows.filter(isHistoryReference).length;
  const historyOnly = engineRows.length > 0 && histRefs === engineRows.length;
  return {
    source: 'chain', hasSidecar: !!rev, state,
    issueCount: Number.isFinite(n) ? Math.max(0, n - histRefs) : null,
    historyOnly, historyReferences: histRefs,
    refused,
    // 覆盖缺口**不是拒答**：结论仍是 REVIEW，但要单独说明它的含义
    // （「库对该题材没有可依据的条款」⇒ 转人工看覆盖，**不是**发现了内容问题）。
    coverageGap: String(ref?.reason_code ?? '') === 'coverage_not_covered'
      || (ref?.coverage || {}).covered === false || false,
    reason: String(ref?.reason_code ?? ref?.reason ?? '').slice(0, 80),
    ruleCodes: [],
    // ★★ 2026-10-09 晚（Owner「8 条还在平铺」的真因，三个 bug 叠在一起）：
    //
    //   库侧**其实建了真文档**，但它在 `publish.docx` 里，而我们只读 `report_url` ——
    //   而 `report_url` 指的是**本地 `.md` 路径**（人点不开）：
    //     `report_url    = "kb/l7/reports/20261009-125549.review.md"`
    //     `publish.docx  = "https://momcozy-in.feishu.cn/docx/MQsxdnFPjoFEzPx5BCtcJyFunyf"`  ← 真文档
    //   后果三连：① 我们以为「库侧给了链接」⇒ **跳过自己建报告**；
    //             ② 卡里那行印的是「本地文件路径，你点不开」；
    //             ③ 而分流判据要求**可点的 http 链接** ⇒ 判成没有链接 ⇒ **退回逐条平铺**。
    //
    //   修法：**优先取 `publish.docx`**（那才是人点得开的那个），`report_url` 只作兜底。
    //   `report_url_kind` 也据此如实标 —— 它是 `feishu_docx` 才允许被当成链接用。
    reportUrl: (String(rev?.publish?.docx ?? '').trim() || String(rev?.report_url ?? '').trim()) || null,
    // ★ 2026-10-08（第五批）：**「链接」其实有两种** —— 飞书云文档（人点得开）
    //   与本地 `.md` 路径（**人点不开**）。引擎那边如实标了 `report_url_kind`，
    //   这里必须把它带出去；否则卡片会把一条本地路径当链接贴给读者
    //   （库规原话：「一个点不开的链接比空格更坏」）。
    reportUrlKind: String(rev?.report_url_kind ?? '').trim() || null,
    // ★★ 2026-10-12（库侧 Owner 裁定：`issue_count` **只算库内依据**）：
    //   候选条数**单独带出来** —— 数改小之后，若不单独说，读者会以为「库里就报了这几条」，
    //   而实际上还有几条**线索**（源里自己写着"不权威/已被取代"）。
    //   ⚠️ 只读，不参与任何算术：卡上的 `total` 与 `kbGap` 一个字没动。
    candidateCount: Number.isFinite(Number(rev?.candidate_count)) ? Number(rev.candidate_count) : null,
  };
}

/**
 * 「库侧**没有读数**」—— 这一单**根本没拿到库侧结论**，与「库侧说没问题」是两件事。
 *
 * 判据只认结构，不去猜文字：
 *   · **P0 快路** ⇒ 有读数（模式表命中即 BLOCK，本身是库产物；它压根不起链）；
 *   · **评审链** ⇒ 必须**机读旁挂在手、且旁挂里有 `state`**。
 *
 * 旁挂为什么会缺（2026-10-07 实测）：`kb/l8/review_run.sh` 是旁挂的**唯一**写点，
 * 而 `exit 3`（库忙·认领被占）/ `exit 4`（某层闸门红）/ `exit 5`（某层审计红）
 * 都在写旁挂**之前**就退出了；headless agent 若绕过 `review_run.sh` 直接跑引擎，也不写。
 * ⇒ 这几种情况下守衡「读不到引擎读数」，而**表里那格照样可能落 PASS**（实测素材 D）。
 *
 * ★ `kb` 为 `null/undefined`（调用方压根没传库侧）时**不触发**本闸 ——
 *   那是「合并没启用」的回退口径（自证 ⑫ 反向对照守着），不许把它和新闸混在一起。
 */
export function kbNoReadingOf(kb) {
  if (!kb) return false;                                 // 没传库侧 ⇒ 回退口径，不判
  if (kb.source === 'p0_fastpath') return false;         // 快路自带读数
  return !(kb.hasSidecar === true && String(kb.state || '').trim());
}

/** 库侧抽取的自证（与六行矩阵分开，因为它们是**抽取**不是**裁决**）。 */
export function selftestExtract() {
  let pass = 0; const bad = [];
  const ok = (n) => { pass++; console.log(`  ✅ ${n}`); };
  const no = (n, w) => { console.log(`  ❌ ${n} —— ${w}`); bad.push(n); };
  const eq = (n, g, w) => (JSON.stringify(g) === JSON.stringify(w) ? ok(n) : no(n, `期望 ${JSON.stringify(w)}，实得 ${JSON.stringify(g)}`));

  const REAL = '【审查结论：REVIEW】共发现 2 处需人工确认。\n\n'
    + '1.【合规-医疗宣称】视频 00:12 字幕「治疗堵奶」涉嫌医疗宣称。\n   原因：母婴内容不得出现治疗表述。\n'
    + '2.【消费者安全-使用姿势】图片 1 中吸奶器使用姿势可能误导。\n   原因：可能误导消费者。\n\n'
    + '建议转 @法务 @医学顾问 复核。';
  const r = kbFindingsOf(REAL);
  eq('⑩ 逐条块里的两条被抽出来', [r.findings.length, r.findings[0].category, r.findings[0].sub],
     [2, '合规', '医疗宣称']);
  eq('⑩ 严重度按动作行判（「复核」⇒ REVIEW）', r.findings[0].severity, 'REVIEW');

  // ★ 覆盖缺口那条**不算内容问题**：混进来会让「问题数量」虚高
  // ★ 这段是**真实产出**的原文（with_kb_evidence.py 的 _item 模板），不是我编的短句 ——
  //   第一版我图省事用了省略号，于是「覆盖判据不成立」这几个字根本不在样本里，
  //   断言直接红了。**样本写短了会把判据验成另一件事**，所以按真话抄。
  const COV = '【审查结论：REVIEW】共发现 1 处需人工确认。\n\n'
    + '1.【覆盖-知识库覆盖缺口】本次素材的**文字层逐字命中 0 条**，但覆盖判据不成立'
    + '（没有「既被规则引用、又达门限」的单元）——**这不是素材有问题，是库对该题材没有可依据的条款**。\n'
    + '   建议：转人工复核后再定；补素材无用（缺的是库覆盖）。';
  const rc = kbFindingsOf(COV);
  eq('⑩ 覆盖缺口不计入 findings', [rc.findings.length, rc.coverage?.category], [0, '覆盖']);

  eq('⑩ 认得出「覆盖判据不成立」⇒ 没覆盖', kbCoveredOf(COV), false);
  eq('⑩ 认得出 reason_code', kbCoveredOf('…原因码 `coverage_not_covered`：…'), false);
  // 反向对照：正常的三态结论**不许**被判成没覆盖（否则永远到不了 PASS）
  eq('⑩ 反向对照：正常 REVIEW 结论 ⇒ 算覆盖到了', kbCoveredOf(REAL), true);
  eq('⑩ 反向对照：PASS 结论 ⇒ 算覆盖到了',
     kbCoveredOf('【审查结论：PASS】未发现已知底线风险。'), true);

  // ★★ 2026-11-03（Owner：问题数只算素材风险）：同图历史参考 / 复用图不计入问题数。
  //   样本按真引擎产出物的形状（`history_attribution` 是中文口径，`reason` 带「非本单素材」）。
  const HIST_ENGINE = { decision: { issue_count: 2, risk_items: [
    { rule_code: 'N-00', risk_type: '负面样本-N-00', action: 'review',
      history_attribution: '同图历史意见（本图是库内复用图，该图还出现在其它记录）',
      reason: '相似历史审核意见（point·参考）：匹配分 1.00｜⚠️ 非本单素材',
      location: '图片中部，图 1 第 1 处',
      evidence: { library: '负面样本', article_no: 'N-1.6', anchor: '#x' } },
    { rule_code: 'N-00', risk_type: '负面样本-N-00', action: 'review',
      history_attribution: '同图历史意见（本图是库内复用图，该图还出现在其它记录）',
      reason: '相似历史审核意见（point·参考）：匹配分 1.00｜⚠️ 非本单素材',
      location: '图片中部，图 1 第 1 处',
      evidence: { library: '负面样本', article_no: 'N-1.7', anchor: '#y' } },
  ] } };
  const histKb = kbFindingsOf('', HIST_ENGINE, null, {});
  eq('⑩ 同图历史参考不进 findings', histKb.findings.length, 0);
  eq('⑩ 同图历史参考保留为 candidates（仍可见）', histKb.candidates.length, 2);
  const histSide = kbSideOf({ review: { state: 'REVIEW', issue_count: 2 }, engine: HIST_ENGINE });
  eq('⑩ 历史参考从 issueCount 扣除', [histSide.issueCount, histSide.historyOnly], [0, true]);
  eq('⑩ 历史参考单不许 PASS（归属未确认）', mergedState({ kb: histSide, merged: [], modelFailed: false }), 'REVIEW');
  // 反向对照：真问题照旧进 findings、照旧计数
  const REAL_ENGINE = { decision: { issue_count: 1, risk_items: [
    { rule_code: 'W-1.18', risk_type: '合规-医疗宣称', action: 'review', reason: '逐字命中「治疗」',
      location: '全文', evidence: { library: '措辞表达库', article_no: 'W-1.18', anchor: '#z' } },
  ] } };
  eq('⑩ 反向：真问题仍进 findings', kbFindingsOf('', REAL_ENGINE, null, {}).findings.length, 1);
  eq('⑩ 反向：真问题不扣计数', kbSideOf({ review: { state: 'REVIEW', issue_count: 1 }, engine: REAL_ENGINE }).issueCount, 1);

  // ★★ 2026-10-14：**P0 的「真实命中文字」必须被挂上** —— 交集判据缺的就是这一格 ──────
  //   样本是**真实产出物的形状**（`kb/l5/p0_fastpath.py --json` 的 `findings[].matched[]`
  //   与 `_prd_block()` 印出来的那行逐字抄下来），不是我编的短句：
  //   收据里印的是**命中正则**（`最好` 这条恰好是字面量；H05 那条会是 `最\s*(好|佳|…)`），
  //   而判据要比的是**命中文字**。
  const P0 = [{ rule_code: 'V02', matched: [{ kind: 'regex', pattern: '最好', line: 1,
                 span: [10, 12], line_text: 'm8 pro吸奶器是最好的吸奶器，这句话能过吗？' }] }];
  const RCPT = '【审查结论：BLOCK】共发现 1 处必须修改。\n\n'
    + '1.【绝对化与安全承诺-绝对化用语】全文，逐字命中 `最好`\n'
    + '  **原因**：按 PRD §7.3 判定\n';
  eq('⑩ ★P0 的真实命中文字被挂成 excerpt（不是收据里那个正则）',
     kbFindingsOf(RCPT, null, P0).findings[0].excerpt, '最好');
  // 反向对照：不给 P0 结构化 ⇒ **不许编**（挂 null ⇒ 判据自己会说「无从比」，不会假装同源）
  eq('⑩ 反向对照：不给 p0_findings ⇒ excerpt 为 null（不编）',
     kbFindingsOf(RCPT, null, null).findings[0].excerpt, null);

  // ── 同源判据（2026-10-08）────────────────────────────────────────────
  //   真事故：库侧「平台与促销-静音绝对化表述」+ 模型侧「措辞表达」，位置与类目两个都不同
  //   ⇒ 按原规则算两条 ⇒ 问题数虚高（Owner 那张卡写 4 处、实际 3 处）。
  {
    const kb = [{ location: '全文', category: '平台与促销', sub: '静音绝对化表述',
                  severity: 'REVIEW', excerpt: '静音', reason: '逐字命中「静音」', article_no: 'W-1.54' }];
    const mo = [{ location: '整段文案', category: '措辞表达',
                  severity: 'REVIEW', excerpt: '静音', reason: '模型侧独立判定：静音是绝对化表述' }];
    const r = mergeFindings(kb, mo);
    eq('⑪ 同源判据：位置与类目都对不上，但逐字片段相同 ⇒ **合并成一条**', r.items.length, 1);
    eq('⑪ 合出来的那条是「两轨都命中」', r.items[0].source, 'both');
    eq('⑪ 同源配对被计数', r.stats.same_origin, 1);

    // ── 反向对照（2026-10-08 **重写**，因为它与被测设计互斥）────────────────────
    //
    //   旧版断言「命中同一串字但大类不同 ⇒ **不许合并**」，而新设计是「**精确相等就合并**」
    //   （理由见 `sameOrigin`：两侧用的是两套类目词表，那道闸永远不成立 ⇒ 重复计数修不了）。
    //   把旧断言留着，等于**用一个已被推翻的设计去判新设计**。
    //
    //   新设计真正该保证的不是「不合并」，而是「**合并了要让人看见**」——
    //   同一个词可能是两个问题（「静音」既可能是措辞绝对化、也可能是消费者安全），
    //   精确相等看不见语义差别 ⇒ 用**标注**兜，而不是用不合并兜。
    const mo2 = [{ location: '整段文案', category: '消费者安全',
                   severity: 'REVIEW', excerpt: '静音', reason: '说的是婴幼儿睡眠安全' }];
    const r2 = mergeFindings(kb, mo2);
    eq('⑪ 同字不同族 ⇒ 合并（精确相等为准）', r2.items.length, 1);
    eq('⑪ 但**必须标注**类目族不同，让人自己判断', /类目族不同/.test(JSON.stringify(r2.items)), true);
    // 反向对照②：**逐字片段不相同**时不许因为「位置/类目像」就并
    // ⚠️ 位置必须**与库侧不同**：写「全文」的话键就匹配上了（那是原本的规则、合并是对的），
    //    这条用例就**没隔离住要测的东西** —— 第一版我写错了，断言直接红。
    // ★★ 2026-10-14：**这一条反向对照的口径换了，不是它坏了** ──────────────────────
    //   它原先钉的是「片段**完全相等**才并」—— 那是实现的收窄，不是裁决。
    //   裁决（本文件题注）是「逐字片段**有重叠** ⇒ 同一条」，而「静音」⊂「完全静音」
    //   就是有重叠 ⇒ **应当并**。旧断言继续留着，等于拿被推翻的口径去判新口径。
    //   ⇒ 期望值由 2 改成 1；**真正的反向对照**换成下面「毫无重叠」那条。
    const mo3 = [{ location: '第 2 段', category: '平台与促销', severity: 'REVIEW',
                   excerpt: '完全静音', reason: 'x' }];
    eq('⑪ 有重叠（「静音」⊂「完全静音」）⇒ 合并成一条',
       mergeFindings(kb, mo3).items.length, 1);

    // 反向对照（新）：**毫无重叠**的两个片段 ⇒ 一个字都不许并（哪怕位置与类目都对得上）
    const mo3b = [{ location: '第 2 段', category: '平台与促销', severity: 'REVIEW',
                    excerpt: '包装破损', reason: 'x' }];
    eq('⑪ 反向对照：片段**毫无重叠** ⇒ 不许合并（哪怕位置与类目都对得上）',
       mergeFindings(kb, mo3b).items.length, 2);

    // 反向对照（新）：**单字**不构成重叠 —— 单字在中文长句里必然撞上，那是噪声不是同源
    // ⚠️ 两侧必须一个是单字、一个是长串（「静」⊂「完全静音」）：两侧都写「静」会落进
    //    `equal` 分支，**根本没测到下限**（第一版我就这么写错了，断言当场红）。
    eq('⑪ 反向对照：单字片段（「静」⊂「完全静音」）不构成重叠 ⇒ 不许合并',
       mergeFindings([{ ...kb[0], excerpt: '静' }],
                     [{ location: '第 2 段', category: '平台与促销', severity: 'REVIEW',
                        excerpt: '完全静音', reason: 'x' }]).items.length, 2);

    // ★★ 真实产出物（2026-10-14 实跑那一单：P0 快路 + 模型侧逐字原句）──────────────
    //   库侧片段 = **命中词**「最好」；模型侧片段 = **逐字引用的原句**。
    //   修前：两者不相等 ⇒ 判成「不同的问题」⇒ 走并集（实测 123 次双轨全如此，交集 0 次）。
    const rReal = mergeFindings(
      [{ location: '全文，逐字命中 `最好`', category: '绝对化与安全承诺',
         severity: 'BLOCK', excerpt: '最好' }],
      [{ location: '素材正文（第一句：m8 pro吸奶器是最好的吸奶器）', category: '合规',
         severity: 'REVIEW', excerpt: 'm8 pro吸奶器是最好的吸奶器' }]);
    eq('⑪ ★真实形状：库侧命中词「最好」／模型侧当句 ⇒ **同一条**（交集成立）',
       rReal.items.length, 1);
    eq('⑪ ★真实形状：两侧都命中 ⇒ 计入交集那一支（严重度不等 ⇒ 冲突降 REVIEW）',
       rReal.stats.both + rReal.stats.conflict, 1);

    // ★ 一条结构性事实，钉住它免得下一个人以为 R 门限覆盖了全部：
    //   2 字命中词的 R 最大只能是 2。
    eq('⑪ 2 字命中词的 R 上界 = 2（R≥4 那类门限对它**结构上不可能成立**）',
       lcsLen(normText('静音'), normText('静音')), 2);
    eq('⑪ 一侧没有命中片段 ⇒ 不同源（不许因为「都没给」就并）',
       sameOrigin({ category: '合规' }, { category: '合规' }).same, false);

    // ★ R 值必须被**记下来**（门限本次不启用，但要攒真实分布）
    const r3 = mergeFindings(kb, [{ location: '别处', category: '平台与促销',
                                    severity: 'REVIEW', excerpt: '限时', reason: 'x' }]);
    eq('⑪ 同源尝试的 R 分布被记进 stats（门限未启用，先攒数据）',
       typeof r3.stats.same_origin_r === 'object' && r3.stats.same_origin_r !== null, true);
  }

  // ── 库侧依据行必须**原样搬**（2026-10-08）───────────────────────────────
  //   卡片逐条块有**两个产者**：库侧 `_evidence_line`（带逐字命中文案 + 飞书源直链）
  //   与 JS 的 `renderMerged`。双轨**改写结论**时用的是后者 ——
  //   如果后者自己重建一句，就会把库侧已经产好的 L0 直链**丢掉**
  //   （第一版就是这样：印出「《知识库》W-1.16（锚点：#…）」，点不开）。
  {
    const KB_LINE = '依据：《措辞表达库 v0》第 W-1.16 条 ← 逐字命中「限时」'
      + '｜原始出处：https://momcozy-in.feishu.cn/base/XXX?table=YYY&record=recvuJP2jyeza5';
    const ans = `【审查结论：REVIEW】共发现 1 处需人工确认。\n\n`
      + `1.【平台与促销-静音绝对化表述】全文，（来源未给引文）\n`
      + `  **原因**：逐字命中「限时」\n  **${KB_LINE}**\n`;
    const q = kbFindingsOf(ans);
    eq('⑫ 库侧依据行被抓下来（逐字命中文案 + 飞书源直链）',
       /逐字命中「限时」/.test(q.findings[0]?.basisLine ?? '') && /https:\/\//.test(q.findings[0]?.basisLine ?? ''), true);
    // renderMerged 必须**原样**用它，不许重建
    const items = [{ location: '全文', category: '平台与促销', severity: 'REVIEW', source: 'kb',
                     reason: 'x', kb: { article_no: 'W-1.16', anchor: '#x/y/z', basisLine: q.findings[0].basisLine } }];
    const out = renderMerged(items, { state: 'REVIEW' });
    eq('⑫ renderMerged 原样搬库侧那句（不重建）', /原始出处：https:\/\//.test(out?.block ?? ''), true);
    // ★★ 2026-10-19：这条反向对照的**锚点换了，不变量没换**。
    //   原断言查的是 `锚点：` —— 那是**卡上曾经印内部坐标**时的可区分标记；
    //   而 Owner 2026-10-17 已经要求卡面不出现内部坐标（「禁止用任何后台词 …/，别人听不懂」），
    //   锚点从卡面撤掉之后，「点不开的重建版」与「原样搬来的权威版」靠**来源标记**区分：
    //     `非权威候选线索 · 不构成依据（无条款号，回不了源）` ＋ **没有任何链接**。
    //   ⇒ 不变量仍然是「两者必须能区分」（权威版有链接、重建版没有），只是换成现在真正承载它的那句话。
    //   ⚠️ 不许把它删掉 —— 删了就等于「重建版」可以冒充权威依据。
    {
      const rebuilt = renderMerged([{ location: '全文', category: '合规', severity: 'REVIEW',
                                      source: 'kb', reason: 'x', kb: { article_no: 'W-1', anchor: '#a/b/c' } }],
                                   { state: 'REVIEW' })?.block ?? '';
      // ★ 2026-10-26：卡面那句自造的「非权威候选线索」已按 Owner 要求摘掉（见 ㉒e3），
      //   但这条判据要证明的**不是那句话**，是「重建版与库侧原话可区分」 ——
      //   可区分点是**点不点得开**：重建版没有 http(s) 链接（`anchor` 不是链接），
      //   且它必须仍把「未给条款号」这个事实印出来（依据格不能空着糊过去）。
      eq('⑫ 反向对照：拿不到库侧依据行时才退回重建版（那版**点不开**，且必须自报「未给条款号」）',
         [/(?:未给条款号|《知识库》)/.test(rebuilt), /https?:\/\//.test(rebuilt)
            , /非权威候选线索/.test(rebuilt)], [true, false, false]);
    }
  }

  // ── ⑬ 走**完整链路**：kbFindingsOf → mergeFindings → renderMerged ──────────
  //   ★ 为什么必须补这一条：上面 ⑫ 我**手搓了一个带 basisLine 的条目**喂给 renderMerged，
  //     于是它绕过了 `mergeFindings` 里的 `pickKb()` —— 而 bug 恰恰在那里
  //     （`pickKb` 只挑 5 个字段，把 `basisLine` 丢了）。
  //     实测证据：Owner 看到的卡片印着 `《知识库》（未给条款号）（锚点：—）`，
  //     而 `⑫` 照样全绿。**夹具绕过被测环节 = 测了个寂寞。**
  {
    const KB_LINE = '依据：《措辞表达库 v0》第 W-1.54 条 ← 逐字命中「静音」'
      + '｜原始出处：https://momcozy-in.feishu.cn/base/AAA?table=BBB&record=recvuJP2jyeza5';
    const ans = '【审查结论：REVIEW】共发现 1 处需人工确认。\n\n'
      + '1.【平台与促销】全文，静音程度夸大\n'
      + '  **原因**：逐字命中「静音」，静音程度夸大\n'
      + `  **${KB_LINE}**\n`;
    const kb = kbFindingsOf(ans);
    const mo = [{ location: '整段', category: '措辞表达', severity: 'REVIEW',
                  excerpt: '别的词', reason: '模型侧另一条' }];   // 确保走 kb-only 那条支路
    const merged = mergeFindings(kb.findings, mo.findings ?? mo);
    const out = renderMerged(merged.items, { state: 'REVIEW' });
    const blk = out?.block ?? '';
    eq('⑬ 完整链路：依据行带**飞书源直链**（不许退回重建版）', /原始出处：https:\/\//.test(blk), true);
    eq('⑬ 完整链路：依据行带**逐字命中文案**', /逐字命中「静音」/.test(blk), true);
    eq('⑬ 完整链路：不许出现重建版的「（未给条款号）（锚点：」', /（未给条款号）/.test(blk), false);
    eq('⑬ 完整链路：**原因**用库侧那句，不是位置文字',
       // ★ 2026-10-09：标签带加粗了（Owner 裁定）⇒ 正则认两种写法，否则误红。
       /\*{0,2}原因\*{0,2}：逐字命中「静音」，静音程度夸大/.test(blk), true);
    // 反向对照：库侧**没有**依据行时，才允许退回重建版（且必须能区分出来）
    const ans2 = '【审查结论：REVIEW】共发现 1 处需人工确认。\n\n1.【合规】第 1 处\n  **原因**：x\n';
    const o2 = renderMerged(mergeFindings(kbFindingsOf(ans2).findings, []).items, { state: 'REVIEW' });
    eq('⑬ 反向对照：没有依据行时退回重建版（能区分）', /（未给条款号）/.test(o2?.block ?? ''), true);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ⑭ 2026-10-09：**「命中原文 + 飞书链接」必须真进卡片**（Owner 点名要的那一块）
  // ══════════════════════════════════════════════════════════════════════════
  // 今天连栽两次，两次的形状是同一个，所以判据也按那个形状写：
  //   ① 第一坑：`category` 只按 `risk_type` 拆（引擎的覆盖行**没有连字符**）
  //      ⇒ 覆盖行被误归进 findings、`coverage` 恒 null ⇒ 挂在 coverage 上的渲染**永不执行**。
  //   ② 第二坑（更贵）：修好①之后它"能跑了"，可我把它渲染进 `coverage.reasonLine` ——
  //      而 `agent.mjs` **压根不用 `kb.coverage`**（`mergeFindings` 只吃 findings；
  //      卡片里那句 covNote 是**写死的**）⇒ 渲染进了一个**没人读的字段**。
  //   两坑的共同点：**我验的是产出者，没验消费者**。
  //   ⇒ 判据必须**穿过消费者的边界**：从「引擎 JSON」一路断到 **`renderMerged` 的 `block`**
  //     （那才是守衡真发出去的那段字），而不是断在中间的某个字段上。
  {
    // ★ 样本用**引擎真实产出的形状**（`with_kb_evidence.py:606-608`）：
    //   `risk_type` 是 `覆盖缺口`（**无连字符**），`category` 单独给 `覆盖`。
    //   上一轮的 ⑩ 用的是**渲染后**的文本 `【覆盖-知识库覆盖缺口】`（**有连字符**）——
    //   于是它在"结构化那条来路坏着"的情况下照样绿。**样本形状不对，判据就是假的。**
    const realShape = {
      decision: { risk_items: [{ risk_type: '覆盖缺口', category: '覆盖', sub: '知识库覆盖缺口',
                                 location: '全文', reason: '覆盖判据不成立', action: '转人工' }] },
      evidence_meta: { kb_hits: [
        { anchor: '#l.1-2', bm25: 135.468, kb_type: 'internal_sample', excerpt: '逐字命中的那一段原文',
          url: 'https://momcozy-in.feishu.cn/wiki/TqJSduQE3oBM4uxtHhmcrVtGnPg', source_sha256: 'd3c8b460b9686447'.padEnd(64, 'a') },
      ] },
    };
    const rs = kbFindingsOf('', realShape);
    eq('Ka 引擎真实形状的覆盖行 ⇒ 归 coverage，**不占 findings**',
       [rs.findings.length, rs.coverage?.category], [0, '覆盖']);
    // ↑ 变异自证：把 `category` 改回「只按 risk_type 拆」⇒ 这里变成 [1, '覆盖缺口']，**精确变红**。

    const modelF = { ok: true, findings: [{ location: '00:12', category: '合规', severity: 'REVIEW',
                                            reason: '口播提到疗效', basis: 'model' }] };
    const mg = mergeFindings(rs.findings, modelF.findings);
    const blk = String(renderMerged(mg.items, { state: 'REVIEW', kbTextCount: rs.findings.length,
      model: modelF, kbHitsBlock: rs.kbHitsBlock })?.block ?? '');
    // ★★ 这一条是今天真正的教训：断的是**卡片正文**，不是 `rs.kbHitsBlock`。
    // ★★ 2026-10-09 晚重写（Owner：「业务同事都看不懂」）——**这六条原先钉住的正是要被撤掉的行为。**
    //   旧 Kb–Kg 断言「卡片正文里必须有【库内命中（读数）】…直链…在逐条之前」——
    //   而 Owner 的裁定是：**卡上只放能让人决定下一步的东西**，检索读数属于报告。
    //   断言把旧行为钉死 ⇒ 改对了反而全红（与早先 `W5` 钉住 `verdictSlotOf` 那个 bug 同一个病）。
    //   现在反过来钉：**卡上不许有它，但它必须一条不丢地出现在报告里。**
    eq('Kb 卡片正文里**不许**再出现【库内命中（读数）】（业务同事看不懂的东西不上卡）',
       blk.includes('库内命中（读数）'), false);
    eq('Kc+Kd+Ke+Kf 那些读数字段（命中原文/直链/sha/不得据此当 PASS）也都不上卡',
       [/命中原文（逐字）/, /飞书直链：https:\/\//, /不得据此当 PASS 依据/].some((re) => re.test(blk)), false);
    eq('Kg 读数块必须**原样交出去**（搬是搬、砍是砍 —— 报告要拿它进附录）',
       typeof rs.kbHitsBlock === 'string' && rs.kbHitsBlock.includes('库内命中（读数）'), true);

    // 反向对照：**没有读数就不许印**（不许编一段空壳，也不许印「0 条」冒充读过）
    const noHits = { decision: { risk_items: [{ risk_type: '合规', category: '合规', location: '全文',
                                                reason: 'x', action: 'review' }] }, evidence_meta: {} };
    const nh = kbFindingsOf('', noHits);
    eq('Kh 反向对照：引擎没给 kb_hits ⇒ 不印读数块', nh.kbHitsBlock, null);
    const blk2 = String(renderMerged(mergeFindings(nh.findings, modelF.findings).items,
      { state: 'REVIEW', model: modelF, kbHitsBlock: nh.kbHitsBlock })?.block ?? '');
    eq('Ki 反向对照：卡片正文里也不许冒出【库内命中】', blk2.includes('库内命中'), false);

    // ★★ Kj **接线判据**：`dual_track` 修好了，`agent.mjs` 不传进来照样白搭 ——
    //   今天的第二坑就是"产出者对了、消费者没接"。这条直接读源文件核那一行接线。
    //   为什么值得用源文件断言：这行没有别的运行时判据能覆盖到
    //   （`renderMerged` 收不到参数时**静默**不印，不会报错）。
    const src = readFileSync(new URL('./agent.mjs', import.meta.url), 'utf8');
    eq('Kj agent.mjs 确实把 kbHitsBlock 接进了 renderMerged',
       (src.match(/kbHitsBlock:\s*kb\.kbHitsBlock/g) || []).length >= 2, true);
    // ↑ 两处调用（rendered0 与 rendered）都要接；只接一处 ⇒ 走另一条分支的单子又没有读数。
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ㉒ 2026-10-13：**合并的键不许把内容拆坏**（Owner 那张 P0 卡上就看得见）
  // ══════════════════════════════════════════════════════════════════════════
  //   病灶：`keyOf` 是 `` `${location}|${category}` ``，而 `mergeFindings` 收尾
  //   把它 `key.split('|')` 拆回来。这一条的 `location` 里**本身全是 `|`**
  //   （命中正则 `最\s*(好|佳|优|强|安全|…)`）⇒ 拆回来 location 被腰斩成
  //   `` 全文，逐字命中 `最\s*(好 ``、category 变成 `佳`
  //   ⇒ 卡上印出 **`1.【佳】`** 与 **`· 佳类问题：1 个`**。真维度是 `绝对化与安全承诺-虚假安全承诺`。
  //
  //   判据三层（缺一层都不算）：腰斩的那一条逐字不变 · 反向对照普通条目照旧 · 键不再相撞。
  {
    const PIPE_LOC = '全文，逐字命中 `最\\s*(好|佳|优|强|安全|低价|便宜|有效|快|大|高|省|舒适)`';
    const kbPipe = [{ location: PIPE_LOC, category: '绝对化与安全承诺', sub: '虚假安全承诺',
                      severity: 'BLOCK', source: 'kb', reason: 'H05' }];
    const mPipe = mergeFindings(kbPipe, []);
    eq('㉒a ★ 命中正则里带 `|` 的条目 ⇒ 位置与维度**逐字不变**（旧写法会腰斩成「最\\s*(好」/「佳」）',
       [mPipe.items[0].location, mPipe.items[0].category], [PIPE_LOC, '绝对化与安全承诺']);
    // ↑ 变异自证：把 `const src = kb ?? model` 那两行换回 `key.split('|')` ⇒ 这里
    //   变成 ['全文，逐字命中 `最\\s*(好', '佳']，**精确变红**。
    eq('㉒a2 它照样认得出来是 BLOCK（腰斩会把维度判错，严重度那一格也不能跟着坏）',
       mPipe.items[0].severity, 'BLOCK');
    // 反向对照：**没有 `|` 的普通条目**照旧（不许为了修这一条把配对逻辑改坏）
    const plain = mergeFindings(
      [{ location: '第 3 行', category: '平台与促销', severity: 'REVIEW', source: 'kb', reason: 'x' }],
      [{ location: '第 3 行', category: '平台与促销', severity: 'REVIEW', source: 'model', reason: 'y' }]);
    eq('㉒b 反向对照：不带 `|` 的同位置同维度仍并成一条（双轨确认）',
       [plain.items.length, plain.items[0].source, plain.items[0].location], [1, 'both', '第 3 行']);
    // 键不再相撞：`a|b`+`c` 与 `a`+`b|c` 在旧写法下是**同一个键**（两条并成一条，静默少报）
    const collide = mergeFindings(
      [{ location: 'a|b', category: 'c', severity: 'REVIEW', source: 'kb', reason: '1' },
       { location: 'a', category: 'b|c', severity: 'REVIEW', source: 'kb', reason: '2' }], []);
    eq('㉒c 旧写法下会撞成一个键的两组 ⇒ 现在必须是**两条**（撞了就是静默少报）',
       collide.items.length, 2);
    // 来源标记的措辞：**那两个词一个都不许出现**，而「回不回得了源」这条信息必须还在
    // ★★ 2026-10-14（Owner：「所有参考知识库的，都必须带飞书侧源链接」）：
    //   样本改成**真依据的形状**（有条款号 + 有飞书直链）—— 原先那份是
    //   「`source:'kb'` 但没有号也没有链接」，而那正是**现在必须被拦下**的形状
    //   （实测那张 hospital-grade 卡就是这么印出「有库内条款依据 ＋（未给条款号）」的）。
    const kbLine = renderMergedItem({ location: 'x', category: '合规', source: 'kb',
                                      severity: 'REVIEW', reason: 'r',
                                      kb: { article_no: 'W-1.35',
                                            basisLine: '《措辞表达库 v0》第 W-1.35 条 ← 命中「hospital」'
                                              + '｜原始出处：https://momcozy-in.feishu.cn/base/A?table=B&record=C' } },
                                    0, { must: false });
    const moLine = renderMergedItem({ location: 'x', category: '合规', source: 'model',
                                      severity: 'REVIEW', reason: 'r' }, 0, { must: false });
    eq('㉒d 卡面/报告里不许出现「知识库侧」「模型侧」（Owner 2026-10-13）',
       [/知识库侧/.test(kbLine + moLine), /模型侧/.test(kbLine + moLine)], [false, false]);
    // ★★ 2026-10-19（Owner：「去掉『—— 无库内依据 · 建议转人工』的字眼，
    //   **但是我问你的时候，你要能说出是模型侧还是知识库侧问题**」）——
    //   ★ 这条判据**换了载体，不是换了要求**：
    //     · 卡面：两个状态标签**摘掉**（`无库内依据 · 建议转人工` / `无库内条款 · 依据为外部标准`）；
    //     · 「这条回不回得了源 / 是哪一侧报的」**必须还在** —— 搬进 `itemsMeta`
    //       （→ `merged_record` → 落盘 `merged-*.json`）。
    //   ⚠️ 为什么两面都要钉：摘标签最坏的做法是**连着信息一起摘掉** —— 卡面看起来一切正常，
    //     而 Owner 的第二个要求（问他时要答得出）已经落空。反向对照：**不停 onMeta**
    //     ⇒ ㉒e-2 立刻变红（拿到的是 [undefined, undefined]）。
    const moMeta = [];
    const moLine2 = renderMergedItem({ location: 'x', category: '合规', source: 'model',
                                       severity: 'REVIEW', reason: 'r' }, 0,
                                     { must: false, onMeta: (m) => moMeta.push(m) });
    eq('㉒e 卡面摘掉「无库内依据 · 建议转人工」／「无库内条款 · 依据为外部标准」（Owner 2026-10-19）',
       [/无库内依据/.test(moLine2), /无库内条款/.test(moLine2)], [false, false]);
    eq('㉒e-1 正向标记照旧：库侧**真有号有链接**时仍印「有库内条款依据」（一个字没动）',
       /有库内条款依据/.test(kbLine), true);
    eq('㉒e-2 「这条是哪一侧报的／回不回得了源」搬进 itemsMeta（可落盘、问得住）',
       [moMeta[0]?.source, moMeta[0]?.basis_kind], ['model', 'none']);
    // ★★ ㉒e2 反向对照（2026-10-14）：**「有库内条款依据」这句话本身要够条件才许说** ——
    //   没有条款号、或没有可点链接 ⇒ 这条回不了源 ⇒ 不许冒称依据。
    //   这条**不是放宽**：㉒e 那条真依据照旧印原话（两态并存才是对的口径）。
    const weakNoLink = renderMergedItem({ location: 'x', category: '合规', source: 'kb', severity: 'REVIEW',
                                          reason: 'r', kb: { article_no: 'W-1.35',
                                          basisLine: '《措辞表达库 v0》第 W-1.35 条 ← 命中「hospital」' } },
                                        0, { must: false });
    const weakNoArt = renderMergedItem({ location: 'x', category: '合规', source: 'kb', severity: 'REVIEW',
                                         reason: 'r', kb: { article_no: null,
                                         basisLine: '《知识库》（未给条款号） ← 命中「hospital-grade」' } },
                                       0, { must: false });
    eq('㉒e2 有号无链接 / 无号无链接 ⇒ 都不许印「有库内条款依据」',
       [/有库内条款依据/.test(weakNoLink), /有库内条款依据/.test(weakNoArt)], [false, false]);
    // ★★ 2026-10-26 翻面（Owner 贴出 10/21 样张并定性「这是我想要的模板」）：
    //   样张里那条外部标准（无条款号、无锚点）行尾是**空的** —— 而我们 10-13 加的
    //   「非权威候选线索 · 不构成依据（无条款号，回不了源）」是自造兜底措辞，比样张吵。
    //   ⇒ 卡面**不再印这句**；但「这条回不回得了源」必须仍然答得出来 ——
    //   证据在合并记录里（`source / basis_kind / basis_missing`，见 ㉒e4），
    //   而不是靠卡面上这句自我声明。
    eq('㉒e3 卡面**不再**印自造的「非权威候选线索」尾巴（Owner 2026-10-26 与 10/21 样张对齐）',
       [/非权威候选线索/.test(weakNoLink), /非权威候选线索/.test(weakNoArt)], [false, false]);
    // ★ 反向对照（同一条判据的另一半）：**有号＋有链接**的真依据照旧印正向标记 ——
    //   否则上一条可以被「什么尾巴都不印」这种一刀切弄绿。
    const strongItem = renderMergedItem({ location: 'x', category: '合规', source: 'kb', severity: 'REVIEW',
                                          reason: 'r', kb: { article_no: 'W-1.9',
                                          basisLine: '《措辞表达库 v0》第 W-1.9 条｜原始出处：https://momox.in/x' } },
                                        0, { must: false });
    eq('㉒e3b 反向对照：有号＋有链接的真依据**照旧**印「有库内条款依据」',
       [/有库内条款依据/.test(strongItem), /非权威候选线索/.test(strongItem)], [true, false]);
    // ★ 信息没有丢：依据那一格照旧把**库侧原话**印出来（`《知识库》（未给条款号）…`）——
    //   读者据此看得出「这条没有条款号、回不了源」，只是不再由我们在行首替他下判断。
    eq('㉒e4 摘掉的是那句自我声明，不是事实：依据格必须仍印库侧原话（含「未给条款号」）',
       [/未给条款号/.test(weakNoArt), /《知识库》/.test(weakNoArt)], [true, true]);

    // ── ㉔ 卡面分类汇总（**盯活代码**：`categorySummary()`）──────────────────────────
    //   ★★ 2026-10-19 收口：这一组原先六条**全在验 `taxonomySummaryLine()` / `taxonomyReportLines()`**
    //   —— 那两个函数自「附录按 Owner 要求撤掉、逐条首行改印 A3」之后**没有任何生产调用**，
    //   而卡面真正在跑的 `categorySummary()`（问题 ≥3 的每一张卡都走它）**一条判据都没有**。
    //   也就是：没人调的那个有 6 条判据（含 2 条反向对照），每张卡都走的那个 0 条。
    //   这正是本库栽过的那条——「判据恒绿、看着像守着、其实什么都没守」。现在改成盯活的那个。
    const taxA = [{ source: 'kb', taxonomyCategory: '合规与受监管宣称', taxonomySubcategory: '生理功效与效果承诺' },
                  { source: 'kb', taxonomyCategory: '合规与受监管宣称', taxonomySubcategory: '绝对化与最高级用语' },
                  { source: 'kb', taxonomyCategory: '证据与实质证明', taxonomySubcategory: '临床与科学证据要求' }];
    const sumA = categorySummary(taxA, 3);
    const sumLines = sumA.split('\n');
    // ㉔a 每类**一行**（Owner 2026-10-19：「按照下面的格式优化，**目前是写的一行**」）
    eq('㉔a 每类一行、写法 · <类>类问题：N 个',
       [sumLines.length, sumLines.every((s) => /^· .+类问题：\d+ 个$/.test(s)),
        sumLines.some((s) => s === '· 合规与受监管宣称类问题：2 个'),
        sumLines.some((s) => s === '· 证据与实质证明类问题：1 个')],
       [2, true, true, true]);
    // ㉔b **反向对照**：退回「一行装完（· A 2、B 1）」⇒ 这条必须红 —— 那一版已被 Owner 退回一次
    eq('㉔b 反向对照：一行装完（A 2、B 1）⇒ 本条要红', /^· [^、\n]+、[^、\n]+$/m.test(sumA), false);
    // ㉔c 顺序照 12 类**注册表次序**，不按条数降序、不按插入序（否则两次运行的顺序对不上）
    eq('㉔c 顺序 = 注册表次序（合规与受监管宣称 先于 母婴知识内容准确性，与插入序相反）',
       categorySummary([{ source: 'kb', taxonomyCategory: '母婴知识内容准确性' },
                        { source: 'kb', taxonomyCategory: '合规与受监管宣称' }], 2).split('\n')[0],
       '· 合规与受监管宣称类问题：1 个');
    // ㉔d 盖不到 A3 ⇒ 落兜底 `未归类`，**兜底压最后**，写法 `· 未归类问题：N 个`
    const sumD = categorySummary([{ source: 'model', category: '隐私' },
      { source: 'kb', taxonomyCategory: '证据与实质证明' }], 2).split('\n');
    eq('㉔d 无 A3 ⇒ · 未归类问题 且排在真类之后',
       [sumD.length, sumD[0], sumD[1]],
       [2, '· 证据与实质证明类问题：1 个', '· 未归类问题：1 个']);
    // ㉔f 模型侧写**自造/非 12 类**类名 ⇒ 落兜底（模型会编；照抄比留空更坏）
    eq('㉔f 模型侧非 12 类类名（如「消费者安全」是 A2 四维）⇒ 落 `未归类`',
       categorySummary([{ source: 'model', model: { taxonomyCategory: '消费者安全' } }], 1),
       '· 未归类问题：1 个');
    // ㉔f2 模型侧写**合法 A3 类名** ⇒ 当真类算（Owner 2026-10-19：「实际打开审查报告，里面都归类了」）
    eq('㉔f2 模型侧合法 A3 类名 ⇒ 当真类算',
       categorySummary([{ source: 'model', model: { taxonomyCategory: '平台与渠道政策' } }], 1),
       '· 平台与渠道政策类问题：1 个');
    // ㉔g 空清单：不许印空的分类表冒充结论
    eq('㉔g 没有条目 ⇒ 明写「本次没有并进任何逐条」',
       categorySummary([], 0), '·（本次没有并进任何逐条）');

    // ㉔e `pickKb` 白名单：不加这两格它们就静默消失（同一个形状栽过多次）
    const picked = pickKb({ taxonomyCategory: '合规与受监管宣称', taxonomySubcategory: '法定认证与注册表述' });
    eq('㉔e pickKb 必须搬运 A3 两格',
       [picked.taxonomyCategory, picked.taxonomySubcategory],
       ['合规与受监管宣称', '法定认证与注册表述']);
  }

  // ── ㉗ 规则码被摘掉之后，**不许留残句**（2026-10-26 实测真单）──────────────
  //   病灶：`原因` 原文「…属医疗功效声明，**H01** 严格限制红线（原文逐字命中）」，
  //   渲染后成了「…属医疗功效声明， 严格限制红线（…）」—— 逗号后挂一个空格。
  //   摘规则码是对的（Owner 2026-10-19：原因是给业务侧看的），摘完要**收标点**。
  {
    const withCode = renderMergedItem({ location: '正文第 1 段', category: '合规与受监管宣称',
      severity: 'BLOCK', source: 'kb',
      reason: '「治疗乳腺炎」属医疗功效声明，H01 严格限制红线（原文逐字命中）',
      advice: '删去治疗/治愈表述。',
      kb: { article_no: 'H01', basisLine: '《规则库》第 H01 条｜原始出处：https://x.invalid/1' } },
      0, { must: true });
    // ⚠️ 只看**原因那一行**：依据行里「《规则库》第 H01 条」是应当保留的（那是出处）。
    const reasonLine = (withCode.split('\n').find((x) => x.includes('**原因**')) ?? '');
    eq('㉗a 摘掉裸规则码后不许留「， 空格」残句（原因那一行）',
       [/[，,；;]\s/.test(reasonLine), /H01/.test(reasonLine),
        /医疗功效声明，严格限制红线/.test(reasonLine)],
       [false, false, true]);
    // 反向对照：本身不带规则码的原因必须**逐字不变**（判据不许顺手改正常文本）
    const clean = renderMergedItem({ location: 'x', category: '合规', severity: 'REVIEW', source: 'kb',
      reason: '宣称未证实，且缺少检测报告支撑', advice: 'y', kb: { article_no: 'W-1.9' } }, 0, { must: false });
    eq('㉗b 反向对照：不带规则码的原因逐字不变',
       clean.includes('宣称未证实，且缺少检测报告支撑'), true);
  }

  console.log(`\n抽取自证：通过 ${pass} / 失败 ${bad.length}`);
  return bad.length ? 1 : 0;
}

/**
 * 渲染**一条**合并条目（§5.3 的四要素：位置＋来源 / 原因 / 依据 / 判定 / 建议）。
 *
 * ★ 2026-10-09 抽出来。原先它是 `renderMerged` 里的一段**内联 `list.map`**，
 *   而「≥3 时另建一份合并报告」（`merged_report.mjs`）要逐条列**同一批**条目 ——
 *   两处各写一遍必然漂移（今天已经因为「同一个东西两个产出者」栽过三次）。
 *   所以**口径只有这一处**：卡片与报告都调它。§2.4 那句「搬是搬」。
 */
/**
 * **逐条依据**（落库用）——把每一条的「依据」压成一行，写进表里的「问题分类汇总」。
 *
 * ── 为什么要有它（Owner 2026-10-13）────────────────────────────────────────
 *   「你修改的模型侧输出问题必须带依据的 url，**这个要落库**」
 *   卡上有了、报告里有了，但**表里没有**：卡片会滚走、报告要另点一次，
 *   而表是这一单最长寿的那份记录。依据不进表，等于它没被留住。
 *
 * ── 三条判据（都在下面 `--selftest` 里对着喂）──────────────────────────────
 *   · 库侧条目用它**自己的** `basisLine`（带飞书直链，原样搬，不许重建）；
 *   · 模型侧条目用 `extBasisText()` 那一行（登记来源 ／ 自写 URL + 核验三态）；
 *   · **没有依据的条目一条都不列** —— 这一节的标题是「依据」，凑数就是撒谎。
 */
export function evidenceBlock(items, { max = 12 } = {}) {
  const lines = [];
  for (const f of items ?? []) {
    const hasKb = f.source === 'kb' || f.source === 'both' || f.source === 'both-conflict';
    const kbLine = hasKb ? (f.kb?.basisLine || f.basisLine || null) : null;
    const ext = f.source === 'model' ? extBasisText(f.model ?? {}) : null;
    const basis = kbLine || (ext?.cited ? ext.line : null);
    if (!basis) continue;                       // 没依据的不列（凑数就是撒谎）
    const what = String(f.reason ?? f.kb?.reasonLine ?? '').replace(/\s+/g, ' ').slice(0, 60);
    lines.push(`${lines.length + 1}.【${f.category ?? '—'}】${String(f.location ?? '').slice(0, 40)}`
      + `${what ? `｜${what}` : ''} → ${basis}`);
  }
  if (!lines.length) return '';
  const head = `\n\n【逐条依据（落库留痕）】`;
  const tail = lines.length > max
    ? `\n…另有 ${lines.length - max} 条，逐字依据见报告。`
    : '';
  // ★ 2026-10-14：编号条目之间也空开一行 —— 与 PRD §5.3 的分段口径同源
  //   （这处不是 PRD 那一块，是查证笔记；但同一张卡里两种编号列表的间距不该不一样）。
  return head + '\n' + lines.slice(0, max).join('\n\n') + tail;
}

/**
 * 数**渲染出来的条目**有几条（卡片正文 / 报告正文通用）。
 *
 * ★★ 2026-10-14（Owner 裁定「去掉『判定』这个字段」）—— **为什么必须新增它**：
 *   在此之前，多处判据（`test_agent.mjs` / `verify_cards.mjs`）拿
 *   `/^ *\*{0,2}判定\*{0,2}：/gm` **当条目计数器**用 —— 因为逐条块里
 *   `**判定**：` 恰好**每条一次**，数它就等于数条目。
 *   那是个**寄生判据**：它量的不是「有几条」，而是「有几行某个字段」。
 *   该字段一删，这些判据会**静默数出 0 条**（`0 === 0`、`0 === 8` 这类断言立刻变红，
 *   而红的原因是"计数器坏了"，不是"条目少了"）—— 红得对不上病。
 *   ⇒ 现在**量真东西**：逐条块的行首编号（`renderMergedItem` 的第一行就是它）。
 *   与排版无关（加不加粗、有没有补充行都不影响），字段增删也不再连带判据。
 *
 * @param {string} text 卡片正文 / 报告正文
 * @returns {number}
 */
export function countRenderedItems(text) {
  const t = String(text ?? '');
  const card = (t.match(/^ *\d+\.【[^】]+】/gm) || []).length;
  // ★ 2026-10-17 第十五轮：报告那一份的条目改成了 `**F-01 ｜ …**` 的形状
  //   （Owner 样张），不再以 `1.【…】` 开头 ⇒ 计数要同时认两种，否则
  //   「报告里应有 N 条」这条断言会**静默数出 0 条**（红得对不上病）。
  const report = (t.match(/^\*\*F-\d{2,} ｜ /gm) || []).length;
  return card + report;
}

// ══════════════════════════════════════════════════════════════════════════
// 分级（P0–P3）· 维度 · 承办 —— 报告「分论点」与「执行」两步的判据
// ══════════════════════════════════════════════════════════════════════════
//
// ★★ 2026-10-17（Owner 拿着白板来定格式）。白板画的是：
//
//      总（state + 1句话）  →  分：`P0 → G1/G2/G3 → rule 1 out` ｜ `P1 → rule 2 out`
//      →  执行 @角色
//      圈起来的判定规则：`P0 ≥ 1 → Block` ｜ `P1 ≥ 1 且无 P0 → review` ｜ `Pn ……`
//
// 那一圈**就是 PRD §6.3 的四层执行规则**，而 `P0…P3` 就是那四层：
//   P0 红线（关键词/正则，毫秒级）→ 命中即 BLOCK
//   P1 安全与准确性（**大模型语义理解**）→ 至少 REVIEW
//   P2 通识常识（大模型多模态）→ 同上
//   P3 措辞建议 → **不影响结论**
//
// ── 边界（写清楚，别让它比输入大）────────────────────────────────────────
//   · **库侧**的 P 级只认引擎给的 `priority_tier`（`core/tiering.py` 的单一口径）。
//     拿不到就如实说「未分级」，**不从 severity 反推一个**（BLOCK≠P0：模型侧也能报 BLOCK，
//     而它是 P1）。反推会把「登记过的分级」换成「猜的分级」，比空着更坏。
//   · **模型侧**统一归 P1 —— 这是 PRD §6.3 给「大模型语义层」定的位置，不是我们迁就数据。
//     它自己的 BLOCK/REVIEW 照旧印在 `**优先级**` 那一行里（轻重没丢，只是不冒充 P0）。
//   · **维度**只认 PRD §5.3 的四维度（合规 / 消费者安全 / 产品描述 / 措辞表达）。
//     映射表在 `kb/l7/registry/risk-category-policy.json`，**政策件自己写着
//     「不编，留空待裁」** ⇒ 这里对不上的就标「未映射」，**不硬塞进某一维**。
//     实测影响面：模型侧 7 个类目里「隐私 / AI 披露 / 本地化」三个**现在没有维度**。
//   · **承办**只搬 `routing.mjs` 的算出来的角色位；**句柄没配就写「（未配置）」**，
//     **不编人名**（`kb/l7/registry/l7.json` 的 `approvers.configured` 现在还是 false）。

/** PRD §6.3 的四层（**顺序有意义**：报告按这个次序分组）。 */
export const PRIORITY_LEVELS = Object.freeze(['P0', 'P1', 'P2', 'P3']);

/** 每一层是什么 —— 措辞取自 PRD §6.3 原文，**不是**我们自己起的名字。 */
export const PRIORITY_LABEL = Object.freeze({
  // ★ 2026-10-17 第二次（Owner：「这是给业务侧看的报告」）：**层名只用业务读得懂的那半**。
  //   原来的「（关键词/正则，毫秒级）」「（大模型语义理解层）」是实现细节，
  //   留在登记件与留底附录里，不进给业务看的那一份。
  P0: '红线（命中即拦）',
  P1: '安全与准确性',
  P2: '通识常识',
  P3: '措辞建议（不改结论）',
});

/** PRD §5.3 的四维度（`risk-category-policy.json` 的 `dimensions` 同一份）。 */
export const PRD_DIMENSIONS = Object.freeze(['合规', '消费者安全', '产品描述', '措辞表达']);

const _isKbSide = (f) => f?.source === 'kb' || f?.source === 'both' || f?.source === 'both-conflict';
const _kbOf = (f) => ((f && typeof f.kb === 'object' && f.kb) ? f.kb : {});

/**
 * 这一条的**优先级**。
 * @returns {{level:string|null, basis:string|null, text:string}}
 */
/**
 * 由 A3 子类取**默认优先级档位**（两侧共用；模型侧封顶 P1）。
 * @returns {{level:string}}|null
 */
function priorityOfTaxonomy(f, cap = 'P1') {
  const x = (f && typeof f === 'object') ? f : {};
  const kb = _kbOf(x);
  const cat = taxonomyCategoryOf(x);
  const sub = String(kb?.taxonomySubcategory || x.taxonomySubcategory
    || x.model?.taxonomySubcategory || '').trim();
  if (!cat || cat === TAX_UNCLASSED || !sub) return null;
  return priorityForTaxonomy(cat, sub, { cap });
}

export function priorityOf(f) {
  const x = (f && typeof f === 'object') ? f : {};
  const kb = _kbOf(x);
  if (_isKbSide(x)) {
    const raw = String(kb.priorityTier || x.priorityTier || '').trim().toUpperCase();
    if (PRIORITY_LEVELS.includes(raw)) {
      // 组标题里已经印过 `P1 — 安全与准确性`，条目行**只留级别** ——
      // 引擎口径（`p_level=P0` 之类）是实现细节，留在留底附录里，不给业务侧看。
      return { level: raw, basis: 'kb_tier', text: raw };
    }
    // ★★ 2026-10-19（Owner：优先级**不许为空**）：缺档时按 A3 子类取默认档（封顶 P1），
    //   仍取不到才如实说未分级 —— 与「编一个」是两件事。
    {
      const p = priorityOfTaxonomy(x, 'P1');
      if (p) return { level: p.level, basis: 'taxonomy_derive', text: p.level };
    }
    return { level: null, basis: null,
             text: '（**未分级** —— 库侧这一条来路没带 `priority_tier`，**不代定**）' };
  }
  // ★★ 2026-10-19（Owner：「最终输出的卡片态，必须是 4 态」；PRD §5.3.2/§6.2）——
  //   **模型侧自报「非强制」⇒ P3**（P3 → SUGGEST）。这是 SUGGEST 在生产的**唯一可达路径**：
  //   改前模型侧只给 severity（BLOCK/REVIEW），一律被下面的逻辑封顶 P1 ⇒ 整单永远 REVIEW。
  //   ⚠️ 优先级：**先判 nature，再走 A3 子类推导** —— 反过来会被「封顶 P1」吃掉（实测顺序敏感）。
  //   ⚠️ 只认 `advisory`（模型明确写「非强制」）；缺省一律 mandatory，**不把强制降级成建议**。
  // ⚠️ **三处都要看**（与 `taxonomyCategoryOf` 同一个坑，第 N 次）：
  //   原始模型产出在顶层 `x.nature`；`mergeFindings` 之后被 `pickModel` 搬进 **`x.model.nature`**
  //   ⇒ 只读顶层，判据就永远看不到「非强制」，SUGGEST 依旧不可达（实测 P 级仍是 P1）。
  const _nature = String(x.nature || x.model?.nature
    || (typeof _kbOf === 'function' ? (_kbOf(x)?.nature ?? '') : '') || '').trim();
  if (_nature === 'advisory') {
    return { level: 'P3', basis: 'model_side_advisory',
      text: 'P3（模型侧标为非强制：措辞优化/轻微常识瑕疵/非核心卖点）' };
  }
  // 模型侧：PRD §6.3 第二层就是「大模型语义理解」，它天然落 P1；
  // ★ 2026-10-19：若它带了 A3 子类，**参照库内该子类的档位**（封顶 P1）—— Owner 明确要求这样取。
  {
    const p = priorityOfTaxonomy(x, 'P1');
    if (p) return { level: p.level, basis: 'taxonomy_derive', text: p.level };
  }
  const sev = String(x.asked_severity || x.severity || 'REVIEW').toUpperCase();
  return { level: 'P1', basis: 'model_side_default',
           // ⚠️ 措辞里**不许出现「模型侧」/「知识库侧」**（Owner 2026-10-13 点名去掉）——
           //   ⑱b2 拿 `renderMergedItem` 的产出当反向对照，一撞就红。
           //   ★ 2026-10-17 第二次：**去掉「按 PRD §6.3 第二层归 P1」**这半句 ——
           //   业务侧不需要知道内部分层依据；留下「自评」是因为那是**这一条的读数**。
           text: `P1（自评 ${sev}）` };
}

/**
 * 这一条的**维度**（PRD §5.3 四维度之一）。
 * @returns {{dimension:string|null, text:string}}
 */
export function dimensionOf(f) {
  const x = (f && typeof f === 'object') ? f : {};
  const kb = _kbOf(x);
  // 库侧优先用引擎盖过章的 `risk_category`；模型侧类目本身就是维度口径（闭集 7 个）。
  const cand = String((_isKbSide(x) ? (kb.riskCategory || x.riskCategory || '') : '')
    || x.category || '').trim();
  if (PRD_DIMENSIONS.includes(cand)) return { dimension: cand, text: cand };
  // ★★ 2026-10-19（Owner：「问题总览里有优先级和维度为空……这里不允许为空，
  //   模型侧输出的可以参照知识库侧的分类和优先级来定」）：
  //   自带维度缺失时，**按 A3 所属类别取默认维度**（真源 `kb/l7/registry/taxonomy-derive.json`，
  //   12 类 → 四维）。取不到才如实留空 —— 不编。
  {
    const tax = taxonomyCategoryOf(x);
    if (tax && tax !== TAX_UNCLASSED) {
      const d = dimensionForTaxonomy(tax);
      if (d) return { dimension: d.dimension, basis: 'taxonomy_derive', text: d.dimension };
    }
    // A3 也拿不到（模型侧没给分类 / 反例案例层）⇒ 退到**模型侧类目 → 四维**的兜底映射。
    // Owner 2026-10-19：「问题总览中有优先级和维度为空……这里不允许为空」。
    const d2 = dimensionForModelCategory(cand);
    if (d2) return { dimension: d2.dimension, basis: 'category_derive', text: d2.dimension };
  }
  // ★ 2026-10-17 第二次：理由说成**业务读得懂**的一句（原来的「PRD §5.3 / 政策件留空待裁」
  //   是内部口径）。四个维度直接列出来，读者自己就能判断它为什么不在这四类里。
  return { dimension: null,
           text: `（未映射 —— 「${cand || '未给类别'}」不属于 合规 / 消费者安全 / 产品描述 / 措辞表达 这四类）` };
}

/**
 * 这一条的**问题描述**（PRD §8.3 六格里的那一格）。
 *
 * 三条口径：
 *   · 有 `description`（模型侧新字段 / 库侧将来也能给）⇒ 直接用它；
 *   · 没有但有逐字命中（`excerpt`）⇒ **如实写成「逐字命中「…」」并标明这是替代**，
 *     因为它确实是「哪里有问题」的原文，但它**不是**模型写的描述；
 *   · 都没有 ⇒ 如实说「未给」，**不把 `reason` 搬过来顶**（那等于两格又合成一格）。
 */
export function descriptionOf(f) {
  const x = (f && typeof f === 'object') ? f : {};
  const d = String(x.description || x.kb?.description || x.model?.description || '').trim();
  if (d) return { description: d, basis: 'given', text: d };
  const exc = String(x.excerpt || x.model?.excerpt || '').trim();
  if (exc) {
    return { description: exc, basis: 'excerpt',
             text: `逐字命中「${exc}」（**本条未单独给问题描述，此处取的是命中原文**）` };
  }
  // ★ 2026-10-29：skill 来源条目（basis_kind='skill_report'）用 reason 兜底。
  //   skill 输出的 reason 就是对业务风险的描述，语义上等价于 description；
  //   其他来源的 reason 是判据说明，不适合冒充 description，仍如实标「未提供」。
  const bk = String(x.basis_kind || x.model?.basis_kind || '').trim();
  if (bk === 'skill_report') {
    const reason = String(x.reason || x.model?.reason || '').trim();
    if (reason) return { description: reason, basis: 'reason', text: reason };
  }
  return { description: null, basis: null,
           text: '（本条未提供问题描述）' };
}

/**
 * `一句话：…` —— **只陈述事实与指针，不下判断**。
 *
 * ★ 2026-10-17（Owner 样张：「一句话：本版 listing 有三处功效/等级宣称需替换，**其余可发**」）：
 *   后半句是**判断**，代码编不出来。所以这一版是**自动小结**：
 *   只写「几处 / 其中红线几条 / 最该先看哪几条（什么类别）」，**不写「其余可发」**。
 *   要那种人话，得让模型写（像 `advice.mjs` 那样单独一次调用）—— 排在下一轮。
 *
 * @returns {string|null} 没有条目时返回 null（不编一句空话）
 */
export function autoSummaryLine(items, { state = '' } = {}) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return null;
  // ★★ 2026-10-17 第九轮（Owner：「一句话：共 7 处…P0 红线 2 处；集中在合规（3 条），也只有 5 条呀」）
  //   —— 病灶不是数错了，是**句子读起来该相加**：`P0 红线 2 处` 与 `合规 3 条` **本来就是重叠的**
  //   （合规 3 条里含 P0 那 2 条），并排放，读者自然算成 5。
  //   而且「集中在合规 3 条」与上面 `发现 7（合规 3｜…）` 说的是同一件事，重复了一遍。
  //   ⇒ 现在这句话只回答两件事：**优先级怎么分（能相加）**、**先看哪几条**：
  //        `共 7 处必须修改，其中 P0 红线 2 处、其余 5 处需人工确认；建议先看第 1、2 条（功效宣称 / 绝对化与安全承诺）。`
  //     数字口径：「P0 红线 p 处 ＋ 其余 N−p 处 ＝ N」，**恒等**，不会再被读成另一个数。
  const st = String(state).toUpperCase();
  const p0 = list.filter((f) => priorityOf(f).level === 'P0');
  const head = st === 'BLOCK'
    ? `共 ${list.length} 处必须修改`
    : `共 ${list.length} 处需人工确认`;
  // 口径：`P0 p 处 + 其余 N−p 处 = N`（**不重叠、可相加**）
  const p0Part = p0.length
    ? `，其中 **P0 红线 ${p0.length} 处**、其余 ${list.length - p0.length} 处需人工确认`
    : '，未见 P0 红线';
  // 指路：有 P0 就指 P0，否则指前两条；**用条号**（与总览表、分论点同一个号）
  const pick = (p0.length ? p0 : list).slice(0, 2);
  const idxs = pick.map((f) => list.indexOf(f) + 1);
  const nums = idxs.length ? `第 ${idxs.join('、')} 条` : '';
  // ★ 2026-10-19：指路括号里印 **A3 类名**（原先印 `f.category`＝A1/模型侧类目 ⇒ 又一套名字）
  const cats = [...new Set(pick.map((f) => taxonomyLabelOf(f).replace(/-/g, '·')).filter(Boolean))].join(' / ');
  const pickPart = nums ? `；建议先看${nums}${cats ? `（${cats}）` : ''}` : '';
  return `一句话：${head}${p0Part}${pickPart}。`;
}

/**
 * 级别 → **处置动作**（Owner 2026-10-17 样张里的映射：
 * `P0 = 立即停发 ｜ P1 = 24h 内改完再送 ｜ P2 = 本版内改 ｜ P3 = 记录`）。
 *
 * ⚠️ **这几个 SLA（24h／本版内改）是照抄样张的、还没经业务确认** ——
 *   写进报告就是对外承诺；口径定了只改这一张表。
 */
export const FAILURE_ACTION = Object.freeze({
  P0: '立即停发', P1: '24h 内改完再送', P2: '本版内改', P3: '记录',
});
// ⚠️ **当前不印进报告**（2026-10-17 第二十轮）：
//   这套映射来自 Owner 发来的一份**样张截图**，查过 `kb/l7`/`kb/l5` 全库（排除备份）
//   —— `立即停发 / 24h 内改完再送 / 本版内改 / 记录` **一条都没有**，**不是 PRD、也不是本库规矩**。
//   ⇒ 不再按条重复印「立即停发」「24h 内改完再送」；也不印那行「处置口径」。
//   PRD 规定的动作只有两句（已在 `orderActionLine()` 那一行）：
//     REVIEW ⇒ `建议转 @… 复核。`；BLOCK ⇒ `请修改后重新提交。`
//   这张表**留着**是备将来：若 Owner 正式确认处置口径，只需在**一处**重新引它，别再散到每条。


export function actionPolicyLine() {
  return '处置口径：**P0 立即停发** ｜ **P1 24h 内改完再送** ｜ **P2 本版内改** ｜ **P3 记录**。';
}

export function priorityHeading(level) {
  if (level === 'UNRANKED') return '未分级（本次没拿到分级读数）';
  return `${level} — ${PRIORITY_LABEL[level] ?? ''}`;
}

/**
 * 分组表头：**所属类别**（A3 12 类）。
 *
 * ★★ 2026-10-19（Owner：「报告要同步卡上 12 类呀，整个知识库都要同步」）：
 *   原先是「维度」（PRD 四维）。卡面早就是 12 类，报告却按四维分组 ⇒ 两套体系并排。
 *   ⇒ 现在报告分组与卡面同一套、同一份取数口（`taxonomyCategoryOf`）。
 *   `未归类` 是 12 类里的兜底类，**照印自己的名字**（不编一个类）。
 */
export function categoryHeading(cat) {
  return String(cat || '').trim() || TAX_UNCLASSED;
}
/** @deprecated 2026-10-19 起报告只按 12 类分组；保留别名只为不改动历史调用点。 */
export const dimensionHeading = categoryHeading;

/**
 * 把条目排成 **P 级 → 维度** 两级分组（报告的「分论点」就是按它印的）。
 *
 * ⚠️ 空等级**不出现**（没命中就别占一行标题）—— 但**分组内的次序是固定的**
 *    （P0→P1→P2→P3；维度按 PRD §5.3 的四维度次序，未映射排最后），
 *    所以同一批条目两次渲染必然同序。
 *
 * @param {Array} items
 * @returns {Array<{level:string, groups:Array<{dimension:string, items:Array}>, count:number}>}
 */
export function groupByPriorityAndCategory(items) {
  const list = Array.isArray(items) ? items : [];
  const byP = new Map();
  for (const f of list) {
    const p = priorityOf(f).level || 'UNRANKED';
    const d = taxonomyCategoryOf(f);          // ★ 12 类（盖不到 ⇒ `未归类`，不编）
    if (!byP.has(p)) byP.set(p, new Map());
    const m = byP.get(p);
    if (!m.has(d)) m.set(d, []);
    m.get(d).push(f);
  }
  const pOrder = [...PRIORITY_LEVELS, 'UNRANKED'];
  // 类别次序 = **12 类注册表次序**（不是四维次序、也不按条数降序）—— 与卡面汇总同一口径
  const dOrder = [...TAX_CLASS_ORDER];
  const out = [];
  for (const p of pOrder) {
    const m = byP.get(p);
    if (!m) continue;
    const groups = dOrder.filter((d) => m.has(d))
      .map((d) => ({ dimension: d, category: d, items: m.get(d) }));
    out.push({ level: p, groups, count: groups.reduce((s, g) => s + g.items.length, 0) });
  }
  return out;
}
/** @deprecated 2026-10-19 起按 12 类分组；保留别名只为不改动历史调用点。 */
export const groupByPriorityAndDimension = groupByPriorityAndCategory;

/**
 * 每条问题该转谁（**逐条**算，不是整单一次）。
 *
 * 与整单那一行的差异：整单是「把全部方向词并起来取并集」，逐条是「这一条自己的方向」。
 * 两种都要 —— 逐条回答「这一处找谁改」，整单回答「这一单转给谁复核」。
 * 方向词一个都没命中 ⇒ 落 `routing-policy.json` 的 `fallback`，并**如实标出来**
 * （「落默认」与「按方向命中」是两件事，读者有权知道）。
 */
/**
 * 角色 → 执行段那个 `@…`。**句柄没配就写「（未配置）」**，不编人名
 * （`kb/l7/registry/l7.json` 的 `approvers.configured` 现在是 false）。
 * ⚠️ **飞书云文档里的 @ 不产生通知** —— 报告里这一格是**给人看的分派**；
 *    真通知仍靠群卡片那一行（那里才是 IM 消息）。
 */
export function handlesConfigured() {
  return ROLE_HANDLES.size > 0;
}

/**
 * @param {string} role
 * @param {{ bare?: boolean }} [opt] `bare:true` ⇒ 只给 `@角色`（配置状态由**小节头一句**统一说，
 *   不再每个角色重复一遍「（未配置）」—— Owner 2026-10-17：「这里格式好丑」）
 */
export function roleTag(role, { bare = false } = {}) {
  const r = String(role ?? '').trim();
  if (!r) return '@（未指定）';
  const h = ROLE_HANDLES.get(r);
  if (h) return `@${h}`;
  return bare ? `@${r}` : `@${r}（未配置）`;
}

export function ownersByItem(items) {
  const list = Array.isArray(items) ? items : [];
  return list.map((f) => {
    const r = reviewOwnersFor([f], ROUTING_POLICY);
    const named = r.owners.map((o) => (ROLE_HANDLES.get(o)
      ? `@${ROLE_HANDLES.get(o)}` : `${o}（未配置）`));
    const text = named.length
      ? named.join('、') + (r.unmatched ? '（**方向未命中，按默认分派**）' : '')
      : '（**未给出承办** —— 没命中任何分派规则，转人工）';
    return { owners: r.owners, unmatched: r.unmatched, text };
  });
}

/**
 * 整单那一行收尾（PRD §5.3.2 / §5.3.3 的「建议转 @… 复核。」／「请修改后重新提交。」）。
 *
 * ★ 2026-10-17：从 `renderMerged` 里抽出来 —— 报告（`merged_report.mjs`）也要印同一行，
 *   两处各写一遍必然漂移（本文件已因「同一个东西两个产出者」栽过多次）。
 */
export function orderActionLine(items, { must = false, routing = null, state = null, compactForCard = true } = {}) {
  const list = Array.isArray(items) ? items : [];
  const r = routing || reviewOwnersFor(list, ROUTING_POLICY);
  if (must) return '请修改后重新提交。';
  // ★★ 2026-10-19（PRD §5.3.2 SUGGEST 动作）：「提示内容方，**不阻断流程**，随 PASS 一起进入下一步」
  //   ⇒ **不派单、不写「建议转 @… 复核。」**（那是 REVIEW 的收尾），只写一行为什么不阻断。
  //   2026-10-21：态名收成 `PASS+SUGGEST`（旧 `SUGGEST` 由 `normState()` 归一，见 `prd53.mjs`）。
  if (prd53StateOf(state) === 'PASS+SUGGEST') {
    return '以上为建议优化，**不阻断发布**，随 PASS 一起进入下一步。';
  }
  return renderReviewAction(r.owners, ROLE_HANDLES,
    { unmatched: r.unmatched, total: list.length, compact: compactForCard === false ? false : true,
      // ★ 没有任何条目可路由（空清单）时落这个 —— 与「读不到路由表」同一答案。
      //   库侧覆盖缺口那一支恒为空清单，靠的就是这条（`routing.py` 同口径）。
      fallback: ROUTING_POLICY?.fallback });
}

/**
 * **一句话要点**（执行段用）——`第 N 条（类别·命中「X」）` 里的那个括号。
 *
 * ★ 2026-10-17（Owner：「最后执行要用 @xxx 来查 xx 点」）：只有条号不够 ——
 *   业务同事拿到「第 1、2、3、5 条」还得翻回去对照。要点取**逐字命中**，
 *   没有命中就退到问题描述的前若干字，两者都没有就**只说类别**（不编一句）。
 */
/**
 * **问题编号**（`F-xxxxxx`）—— 跨复跑能对上的那个键。
 *
 * ★ 2026-10-17（审计报告惯例：Finding ID）。病灶：现在只有「第 3 条」这种**序号**，
 *   而序号**随分组次序漂**（多一条、少一条、优先级变了，全都要重排）⇒ 一封邮件里写的
 *   「第 3 条」过两天对不上同一条问题。业内的做法是给每条一个稳定 ID，整改台账挂在 ID 上。
 *
 * 派生规则（**确定性，不含时间**）：
 *   · 库侧：`anchor|article_no|类别`（这三个是库内坐标，素材不变就不变）；
 *   · 独立复核侧：`位置|类别|逐字命中`（没有逐字命中就退到位置|类别）。
 *
 * ⚠️ 边界说清楚：**这三样变了，ID 就会变** —— 它保证的是「同一条问题在复跑里对得上」，
 *   **不保证跨素材稳定**，也不承担「同一素材改了文案后仍是同一条」的语义等价。
 */
export function stableIdOf(f) {
  const x = (f && typeof f === 'object') ? f : {};
  const kb = _kbOf(x);
  const key = _isKbSide(x)
    ? ['kb', kb.anchor || '', kb.article_no || '', x.category || ''].join('|')
    : ['model', x.location || '', x.category || '',
       String(x.excerpt || '') || String(descriptionOf(x).description || '')].join('|');
  return `F-${createHash('sha256').update(key).digest('hex').slice(0, 6)}`;
}

/** 一批条目的编号表（同键合并撞号时按出现次序补 `-2/-3`，**确定性**）。 */
export function stableIdsOf(items) {
  const list = Array.isArray(items) ? items : [];
  const seen = new Map();
  const out = new Map();
  for (const f of list) {
    const base = stableIdOf(f);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    out.set(f, n === 1 ? base : `${base}-${n}`);
  }
  return out;
}

/**
 * 一条问题的**「查什么」**（表与执行段共用）。
 *
 * ⚠️ 2026-10-17 当天修的两个可读性坑（真渲染里当场看到）：
 *   ① **双层套娃** `命中「逐字命中「boosts milk」」` —— 因为合并后「逐字命中」只在
 *      `description` 里、`excerpt` 掉到了 `kb.excerpt`（`mergeFindings` 是白名单式重建，
 *      顶层没有 `excerpt`）⇒ 这里三格都找一遍，并且**把包装词剥掉**；
 *   ② `命中「「1,000 trials」无样本量」` —— 描述本身带中文引号，外面再包一层就读不成句。
 *      ⇒ 改成 `类别：内容` 的形状，不再自己加引号。
 */
/**
 * **实际原文**（总览表「命中描述」那一列就印它）。
 *
 * ★★ 2026-10-17 第十一轮（Owner：「命中描述 写实际的原文」）——
 *   病灶：那一列原先走 `pointOf()`，而它的取值顺序是
 *   `excerpt → 问题描述`。**模型侧的 `excerpt` 常是空的**，而它把原文放在
 *   `location` 的 `「…」` 里（实测真件第 3/5/7 条：`素材正文第 2 段「Through over 1,000 trials …」句`）
 *   ⇒ 表里退成了模型写的描述，印出来是「该句以…」「该句用…」——**16 字全花在「该句以」上，等于没有**。
 *
 * 取值顺序（三格，缺一不可）：
 *   ① `excerpt`（库侧 = 命中词/命中片段；模型侧 = 它引的原句）
 *   ② **`location` 里的 `「…」`**（模型侧实际把原文放这儿）
 *   ③ 都没有 ⇒ `null`（表里印 `—`，**不许拿描述冒充原文**）
 *
 * ⚠️ 会把 markdown 链接 `[文字](url)` 还原成 `文字` —— 那是排版不是原文，
 *   留在表格单元格里会把 Markdown 表格撑坏。
 */
export function verbatimOf(f) {
  const x = (f && typeof f === 'object') ? f : {};
  let t = String(x.excerpt || x.kb?.excerpt || x.model?.excerpt || '').trim();
  if (!t) {
    // `location` 里可能有多组「…」：取第一组（其余在分论点的「位置」里看得全）
    const m = /「([^」]{2,})」/.exec(String(x.location || ''));
    if (m) t = m[1].trim();
  }
  if (!t) return null;
  return t
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')   // markdown 链接 → 文字
    .replace(/\s+/g, ' ')
    .trim() || null;
}

/** 引用块里只放原文本身：剥掉「逐字命中」这层壳与两端的中文引号。 */
export function prettyQuote(t) {
  let x = String(t ?? '').trim();
  const m = /^逐字命中[「"]([^」"]+)[」"]$/.exec(x);
  if (m) x = m[1].trim();
  return x.replace(/^「(.+)」$/s, '$1').trim();
}

export function pointOf(f, max = 18) {
  const cat = String(f?.category || '').trim() || '—';
  const _exc = String(f?.excerpt || f?.kb?.excerpt || f?.model?.excerpt || '').trim();
  const _desc = String(descriptionOf(f).description || '').trim();
  // ⚠️ 逐字命中本身**可能被截断成半个引号**（`增产声称「Boosts Mi`）—— 那比少写几个字难读。
  //   判据只看引号配不配平：配不平就改用问题描述（描述是完整句子）。
  const _balanced = (_exc.match(/[「『]/g) || []).length === (_exc.match(/[」』]/g) || []).length;
  let raw = (_exc && _balanced ? _exc : (_desc || _exc));
  // 剥掉「逐字命中「X」」这层包装，只留 X
  const m = /^逐字命中[「"]([^」"]+)[」"]$/.exec(raw);
  if (m) raw = m[1].trim();
  // ⚠️ 只在**整条被引号包住**时才脱壳（`「X」` ⇒ `X`）。
  //   原来写的是 `replace(/^「|」$/g,'')` —— 句子里本来就有引号时（`增产声称「Boosts」`）
  //   会把收尾那个 `」` 单独剃掉，留下一个**没有闭合**的引号（实测就是这么印出来的）。
  const wrapped = /^「([^「」]*)」$/.exec(raw) || /^『([^『』]*)』$/.exec(raw);
  if (wrapped) raw = wrapped[1].trim();
  if (!raw) return cat;
  let q = raw;
  if (raw.length > max) {
    q = raw.slice(0, max);
    // ⚠️ 截断把中文引号劈成一半时（`增产声称「Boosts Mi`），退到那个「之前 ——
    //   半个引号比少几个字难读得多。
    const open = (q.match(/[「『]/g) || []).length;
    const close = (q.match(/[」』]/g) || []).length;
    if (open > close) {
      const k = Math.max(q.lastIndexOf('「'), q.lastIndexOf('『'));
      if (k > 0) q = q.slice(0, k);
    }
    q = `${q.replace(/[，、；：\s]+$/, '')}…`;
  }
  return `${cat}：${q}`;
}

/** 兼容旧名（外部与自证里还有调用点）。 */
export const shortPoint = pointOf;

// ════════════════════════════════════════════════════════════════════════════
// 「后台词」清扫 ＋ 原因去建议（2026-10-17 第二十二轮，Owner 两条原话）
//
//   ① 「**禁止用任何后台词（recvuJYdOb1Rm1/），别人听不懂的字符编码**」
//   ② 「每个细分，**原因就说原因，别建议，少做少错**」
//
// ── 为什么必须在这里做，而不是在数据源头做
//
//   `reasonLine` / `basisLine` 是**引擎与库侧产出的原样文本**（内部坐标、记录主键、
//   模式 id、sha 指纹都在里面），它们对**回源**有用、对**业务侧读报告**没用。
//   改数据源头会同时改掉卡片与台账（Owner 明令「卡片格式不要动」）；
//   所以在**报告那一支**做显示层清扫 —— 一个函数、一个入口。
//
// ── 判据要窄（宁可漏洗，不许把正文洗坏）
//
//   只认**有形状的内部标识**：内部坐标 `#表名/rec…/命中片段`、记录主键 `rec…`、
//   消息/会话/用户 id、表 id `tbl…`、应用 id、模式 id `p-…`、图片 key、
//   32 位以上十六进制（sha/md5）。**裸数字、条款号（W-1.18）、产品型号（M6/M8）
//   一律不动** —— 它们是给业务侧看的。
// ════════════════════════════════════════════════════════════════════════════
const BACKEND_TOKEN_RES = [
  // `#广告文案明细/rec…/命中片段` 这种内部坐标。
  // ⚠️ 判据必须要求**第一段含中文**（表名），否则会把正文里的 `best/#1/No.1/最佳`
  //    这种**列表写法**当成路径删掉（2026-10-17 当场踩到：`best/#1/No.1` → `best/.1`）。
  /#[A-Za-z0-9_]*[\u4e00-\u9fff][\u4e00-\u9fffA-Za-z0-9_]*(?:\/[A-Za-z0-9_]+){1,3}/g,
  /\brec[A-Za-z0-9]{8,}\b/g,                               // 表记录主键
  /\b(?:om|oc|ou|on)_[A-Za-z0-9_]{6,}\b/g,                 // 消息 / 会话 / 用户 id
  /\btbl[A-Za-z0-9]{6,}\b/g,                               // 表 id
  /\bbas[A-Za-z0-9]{6,}\b/g,                               // 多维表格 app id
  /\bcli_[a-z0-9]{8,}\b/g,                                 // 应用 id
  /\bp-[0-9a-f]{8,}\b/gi,                                  // 模式 id
  /\bimg(?:_v\d)?_[A-Za-z0-9_-]{6,}\b/g,                    // 图片 key
  /\b[a-f0-9]{32,}\b/gi,                                   // sha256 / md5
  // ★★ 2026-10-21（Owner：「审查报告中不能出现后台语言」）：
  //   ① **反引号里的正则源码**（`最\s*(安全|低价|…)`、`(?:\bno\.?\s*1|#`）——
  //      P0 收据的「逐字命中」那一格原先直接印的是 `matched[].pattern`，正则命中时那是**正则**。
  //      判据：反引号里出现转义或正则元字符 ⇒ 整段挖掉。**纯文字**反引号（`最好`）不动。
  //   ② **库内相对路径**（`kb/l3/candidates/rules.jsonl#W-1.33`）—— 业务侧点不开。
  /`(?=[^`]{0,200}(?:\\[bBsSwWdD]|[|(){}\[\]^$*+?.]))[^`]{0,400}`/g,
  /\bkb\/[A-Za-z0-9_.\/#-]{4,}/g,
];

/**
 * 把一段**给人看**的文字里的内部标识挖掉，并清掉挖空后留下的残渣。
 *
 * ★★ **链接里的一律不挖**（2026-10-17 当天就栽了一次）：第一版对整段文本做替换，
 *    于是 `…?table=tbl…&record=rec…` 被打成 `?table=&record=` ⇒ **直链当场失效**。
 *    内部标识该消失的是**正文里的字面量**，不是 URL 的 query。
 */
export function stripBackendTokens(text) {
  const s0 = String(text ?? '');
  // 先把 URL 挖出来存成占位符（`{@U0}` 不含任何会被下面规则命中的形状）
  const urls = [];
  const stash = (u) => {
    urls.push(u);
    return `{@U${urls.length - 1}}`;
  };
  // ★★ 2026-10-21：URL 到**中文分隔符**也要停。
  //   病灶（实测）：两条同位置依据用 `；` 拼成一行后，链接变成
  //   `[点开核对](…recvuJYdOb1B8v；《知识库》第) E-2.124 条…` —— URL 把后半句吞了，点开是错页。
  let s = s0.replace(/https?:\/\/[^\s)）」』；;，。、]+/g, stash);
  for (const re of BACKEND_TOKEN_RES) s = s.replace(re, '');
  s = s
    .replace(/[（(]\s*[，、；:：]?\s*[）)]/g, '')   // 挖空的括号
    // ★ 2026-10-21：挖掉正则/路径之后会留下连着的顿号与空括号，收一下
    .replace(/[，、；]{2,}/g, '、')
    .replace(/([，。；：\s])、/g, '$1')
    .replace(/^[\s，、；:：]+|[\s，、；:：]+$/g, '')
    // ★ 2026-10-21：老数据里的「（本码共 N 组修订建议…）」—— 「本码」是库内叫法
    .replace(/[（(]\s*本码[^）)]{0,120}[）)]/g, '')
    .replace(/[：:]\s*(?=[｜）)]|$)/g, '')        // 「锚点：」这种只剩标签的
    .replace(/[ \t]{2,}/g, ' ')
    // 掉光内容的分段（`｜指纹｜模式｜表`）整段删掉，别留一堆空标签。
    // ⚠️ 判据必须**窄**：只认那几个内部标签名 —— 第一版写成「≤3 字就丢」，
    //    于是 `P0`、`合规`、`全文` 这种**正常短值**被一起删掉（2026-10-17 当场踩到，
    //    表格六列只剩命中描述、问题清单的维度/位置全空）。短值不是噪声，标签才是。
    .split('｜').map((x) => x.trim())
    .filter((x) => x && !/^(?:指纹|锚点|模式|表|记录|坐标|主键|id|ID|sha)$/.test(x)).join('｜')
    .replace(/^[\s｜，、；]+|[\s｜，、；]+$/g, '')
    .trim();
  return s.replace(/\{@U(\d+)\}/g, (_m, i) => urls[Number(i)] ?? '');
}

/**
 * 「原因」这一格的**业务版**：只留**这一次命中**的理由 —— 去规则码、去别条规则的引用、去建议。
 *
 * Owner 2026-10-17：「原因就说原因，**别建议**，少做少错」——
 * 改法本来就有「修改建议」那一格；原因里再混一遍建议，读者会分不清
 * 「这是判定理由」还是「这是要我做的事」。
 * 另一半同样重要：引擎的 reason 常常把**几条规则怎么分工**也写进来
 * （`放松叙事…走 M07 语境守卫`）—— 那是内部编排，不是这条命中的理由。
 */
export function businessReason(text) {
  const raw = stripBackendTokens(String(text ?? '').replace(/\s+/g, ' '));
  // ① 按分句切（`；` `。` 末尾保留）
  // ★★ 2026-10-21（Owner：「既然放开了，为什么还写出来问题？」）：规则的 `reason` 里常带
  //   **口径说明**（`…排名最高级按 2026-09-09 口径放开，海外广告允许，不再判险`）。
  //   把它印成「原因」⇒ 一条 P0 的原因里说「不再判险」，读者只能读出矛盾。
  //   括号里的口径说明整段不进原因；**判定理由本身一个字不改**。
  const RELAX_NOTE_RE = /[（(][^）)]*(?:放开|不再判险|允许)[^）)]*[）)]/g;
  const segs = raw.replace(RELAX_NOTE_RE, '').split(/(?<=[；;。！？])/)
    .map((x) => x.trim()).filter(Boolean);
  // ② 丢掉三类句子：
  //    · 含「建议」语义的（原因格不承担改法）；
  //    · 讲**别的规则**怎么接的（`走 M07` / `按 H05` / `见 U01`）—— 那是内部编排；
  //    · 规则码露头、去掉之后只剩几个字的。
  const SUGGEST_RE = /建议|改为|改成|可改|应改|宜改|替换为|换成|rewrite|recommend/i;
  const CROSS_RULE_RE = /(?:走|按|见|依据|另按)\s*[A-Z]\d{2}/;
  // ★★ 2026-10-19（Owner：「审查报告中的原因是给业务侧看的，**必须是真实原因**」）——
  //   实测那单的原因印的是「**按 PRD §7.3 判定（Owner 2026-10-13 同意入选）**」：
  //   那是**我们内部的治理口径**（谁批的、按哪条 PRD 收进来的），业务侧读它是零信息量。
  //   数据侧已把这 6 条规则的 `reason` 换成真实原因（原口径挪进 `reason_note_internal`）；
  //   这里再加一道**渲染兜底**：将来若又有规则把内部口径写进 `reason`，卡上也不会露出来。
  const INTERNAL_RE = /PRD\s*§|Owner\s*20\d\d|同意入选|层级地板|口径[:：]|登记件|判据\s*[（(]|\bkb\/[a-z0-9]/i;

  // ⚠️ **先剔内部口径，且这一道不回退**：第一版把所有过滤合成一次、末尾写
  //   `kept.length ? kept : segs` ⇒ 整句都是内部口径时**又把原串吐回来**
  //   （实测「按 PRD §7.3 判定（Owner 2026-10-13 同意入选）」原样上卡，判据当场抓住）。
  //   内部口径剔干净就**返回空串**，由调用方如实说「本次没有可念的理由」——
  //   宁可说没有，也不把内部治理记录当业务原因。
  const noInternal = segs.filter((x) => !INTERNAL_RE.test(x));
  const kept = noInternal.filter((x) => !SUGGEST_RE.test(x) && !CROSS_RULE_RE.test(x));
  if (!noInternal.length) return '';
  return (kept.length ? kept : noInternal).join('')
    .replace(/\b[A-Z]\d{2}\b/g, '')             // 剩下的裸规则码
    // ★★ 2026-10-26（实测：真单 `H01` 那句被摘成残句）——
    //   输入：「「治疗乳腺炎」属医疗功效声明，**H01** 严格限制红线（原文逐字命中）」
    //   输出：「「治疗乳腺炎」属医疗功效声明， 严格限制红线（原文逐字命中）」← 逗号后挂了空格
    //   摘规则码是对的（Owner 2026-10-19：原因是给业务侧看的），但**摘完要收标点**，
    //   否则读者看到的是一个断句。这里只补标点，**一个字的内容都不新增**。
    .replace(/\s+([，。；：、）])/g, '$1')
    .replace(/([，。；：、（])\s+/g, '$1')
    .replace(/[；;]，/g, '；')
    .replace(/^[；;，、\s]+|[；;，、\s]+$/g, '')  // ⚠️  不在里面：句号是正常标点
    .replace(/[（(]\s*[）)]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * 「依据文档链接」这一格的**业务版**：去内部坐标（锚点那段），保留条款号与可点直链。
 *
 * 锚点 `#广告文案明细/rec…/命中片段` 是**回源用的坐标**，业务侧读不懂也不该读；
 * 它仍在**卡片与台账**里（一个字没动），只是不进这份报告。
 */
export function businessBasis(basis) {
  const s = String(basis ?? '');
  const segs = s.split('｜').map((x) => x.trim()).filter(Boolean)
    // 内部坐标整段不印 —— 但**只摘「锚点：」标签与坐标本身**，不许把同一段里
    // 后面的条款一起丢掉（2026-10-22：同一个 URL 收成一条之后，后面几条的锚点
    // 与下一条条款落在**同一个 `｜` 段**里；整段丢 ⇒ 依据只剩头两条）。
    .map((x) => x.replace(/^锚点[:：][^｜；]*/, '').replace(/^[；;]\s*/, '').trim())
    .filter(Boolean);
  return stripBackendTokens(segs.join('｜'));
}

/**
 * 把 markdown 链接语法降成**纯文字**（只留可见文字）。
 *
 * ★★ 2026-10-17 第二十三轮（Owner 追问「你送的文案，为什么给『链接：点开』？这链接跳转是哪里？」）
 *   那条 `http://production.it/` **不是我们加的**，是素材原文在粘贴时被编辑器自动加上的
 *   markdown 链接（正文原话是 `increasing milk production.It supports`），域名
 *   `production.it` 是别人的（.it ＝ 意大利），与我们、与这条素材都无关。
 *   而报告**引用了这段原文**（审查对象的文案，以及第 5 条问题描述里逐字引的那一句）⇒
 *   飞书会把 `[production.It](http://…)` 渲染成**可点链接** ⇒ 我们的对外文件里
 *   平白多出一个指向陌生域名的入口。
 *   ⇒ 规矩：**引用原文不等于替原文做入口**。除「依据文档链接」那一格（那是我们自己的
 *   飞书直链，必须可点）外，其余任何一格的 markdown 链接语法一律降成文字。
 */
export function demoteLinks(text) {
  return String(text ?? '')
    .replace(/\[([^\]\n]*)\]\((?:https?:)?[^)\s]*\)/g, '$1')
    .replace(/<(https?:[^>\s]+)>/g, '$1');
}

/**
 * 送审素材里那句**逐字原文**（`excerpt`，取不到时从问题描述里抠引号内的）。
 *
 * ⚠️ 它**只**用于「这条有没有可展示的素材锚点」这一道过滤器（`renderMerged` 的上卡判据），
 *   **不再进「依据文档链接」那一格**（2026-10-22 Owner 裁定，见 `noExternalBasisText`）。
 */
function materialExcerpt(f) {
  if (f?.source !== 'model') return '';
  const explicit = String(f?.excerpt ?? f?.model?.excerpt ?? '').trim();
  const description = String(f?.description ?? f?.model?.description ?? '').trim();
  const quoted = /[「“"]([^」”"]{2,120})[」”"]/.exec(description)?.[1]?.trim() ?? '';
  return explicit || quoted;
}

/**
 * 「依据文档链接」这一格在**手上没有外部文档**时印什么。
 *
 * ★★ 2026-10-22（Owner，逐字）：「**依据文档链接，是需要提供证明这是个问题的外部链接**，
 *   报告中提供的「送审素材原文：「Ask Midwife Vic」」**更像是问题描述**」。
 *
 *   病灶：模型侧条目只要带了 `excerpt`（素材原文），这一格就被填成
 *   `送审素材原文：「…」` —— 那不是**依据**，那是**问题描述**（它本来就印在
 *   「问题描述」与总览的「命中描述」两处）。读者拿这一格去点，点不开任何东西。
 *
 *   ⇒ 三条口径（缺一条都不算修好）：
 *     ① **手上有外部文档**（登记来源 / 可核 URL）⇒ 照旧印《文档》＋链接（那一支没动）；
 *     ② 手上**只有画面观察** ⇒ 如实写「无外部依据（原图观察：<锚点>；需人工核对）」——
 *        锚点是**位置读数**，不是法规；
 *     ③ **一个都没有** ⇒ 如实写「无外部依据（需人工核对）」。
 *   ⚠️ **不许凑一个「最像的」标准**把这一格填满（与 `ext_basis.mjs` 那条纪律同源）：
 *      张冠李戴的链接比空格更坏 —— 读者会照着一条不相干的条款去改素材。
 *   ⚠️ 条目**照旧保留**在清单里（Owner 2026-10-22 选的是「4 条都留」）：
 *      摘掉的是**冒充依据的素材原文**，不是问题本身。
 */
export function noExternalBasisText(f) {
  const anchor = String(f?.model?.visual_anchor ?? f?.visual_anchor ?? '').trim();
  if (anchor) return `无外部依据（原图观察：${anchor}；需人工核对）`;
  return '无外部依据（需人工核对）';
}

/** 这一条依据的来路（决定「依据文档链接」印链接还是印「无外部依据」）。 */
function visualObservationOf(f) {
  return f?.model?.basis_kind === 'visual_observation' || f?.basis_kind === 'visual_observation';
}

export function renderMergedItem(f, i, { must = false, layout = 'card', itemId = null,
                                     owner = null, hasReport = false, onMeta = null } = {}) {
  // 来源标记（Owner 2026-10-06：「备注下是规则库侧问题，还是模型侧问题」）
  // ★★ 2026-10-13（Owner：「不要出现 知识库侧，模型侧」）——
  //   **去的是那两个词，不是那条信息**。这个标记真正的用处是回答
  //   「**这一条回不回得了源**」（带条款号/锚点/指纹 ⇒ 可回源；不然只能转人工），
  //   而那是下一步动作的依据 ⇒ 换成不带内部说法的措辞，一个字的信息都没少。
  // ★ 2026-10-13（Owner）：「模型侧输出的问题，需要带上依据。写『无库内依据』，
  //   那就放模型侧能查到的依据链接」—— 所以这一格先算出**外部依据**，
  //   有依据就把标记改掉（标记的用处是回答「这条回不回得了源」：只说"无依据"会让人以为查都没法查）。
  const extB = f.source === 'model' ? extBasisText(f.model ?? {}) : null;
  const materialExcerptText = materialExcerpt(f);
  // ★★ 2026-10-22（Owner：「依据文档链接，是需要提供证明这是个问题的外部链接」）——
  //   素材原文**不再冒充依据**（它已印在「问题描述」与总览「命中描述」）。
  //   这一格只有两种写法：有外部文档 ⇒ 链接；没有 ⇒ 如实说「无外部依据」。
  const noExtBasis = (visualObservationOf(f) || materialExcerptText) ? noExternalBasisText(f) : '';
  // ★★ 2026-10-14（Owner：「所有参考知识库的，都必须带飞书侧源链接」）：
  //   **「有库内条款依据」这句话本身要满足条件才许说** —— 判据是结构，不是来源标记：
  //     ① 有一个**条款号**（`第 X 条`）；② 有一个**可点链接**（http(s)）。
  //   两条缺任一条 ⇒ 这条**回不了源** ⇒ 如实说「非权威候选线索 · 不构成依据」。
  //   为什么必须加这道：候选虽然在 `kbFindingsOf` 已分流，但**别处**（旧旁挂 / 正则来路 /
  //   将来新加的产者）仍可能把一条没有号也没有链接的条目塞成 `source:'kb'` ——
  //   实测那张 hospital-grade 卡就是这么印出 `**有库内条款依据** ＋ 《知识库》（未给条款号）` 的。
  //   ⚠️ 这条**不是放宽**：真依据（有号 + 有链接）照旧印「有库内条款依据」，一个字没变（㉓b 钉着）。
  const _kbLine = String(f.kb?.basisLine || f.basisLine || '');
  const _hasArticle = /第\s*\S+\s*条/.test(_kbLine);
  const _hasLink = /https?:\/\//.test(_kbLine) || /^https?:\/\//.test(String(f.kb?.entry_url || ''));
  const _kbWeak = (f.source === 'kb' || f.source === 'both' || f.source === 'both-conflict')
    && !(_hasArticle && _hasLink);
  // ★★ 2026-10-19（Owner：「去掉『—— 无库内依据 · 建议转人工』的字眼，
  //   但是我问你的时候，你要能说出是模型侧还是知识库侧问题」）——
  //   **摘掉的是两个状态标签，不是那条信息。**
  //   信息已经落到 `merged-*.json` 的 `items[].source / basis_kind / basis_missing`
  //   （2026-10-19 步骤 1，先落盘后才摘），逐条都答得出来。
  //   留在卡上的坏处是实在的：读者会把「无库内依据 · 建议转人工」读成**对内容的判定**，
  //   而它其实只是一句「这条不属于条款命中」—— 同一句话在两种语义之间漂。
  //
  //   ⚠️ **三样一个字都不许动**（都不是"状态标签"，各有各的用处）：
  //     · `非权威候选线索 · 不构成依据` —— **防误读**：删了，一条已被取代的候选
  //       会被读成规则真源（自证 ㉓c 钉着，那是安全方向）；
  //     · `两侧都命中 · 结论冲突 ⇒ 已降 REVIEW` —— **判定信息**（为什么降级），不是状态；
  //     · `有库内条款依据` —— 正向标记，读者据此判断「这条能回源」（㉒e2 的条件判据钉着）。
  //
  //   ★ 那「回不回得了源」还看得见吗？看得见 —— **就在下面『依据』那一格里**
  //     （模型侧无外部标准时印「独立语义复核（非条款依据，需人工核对）」）。
  //     首行那个标记是**第二遍**，不是为了信息，是为了醒目 —— 而 Owner 要的正是别再醒目。
  // ★★ 2026-10-26（Owner 贴出 10/21 样张并定性「这是我想要的模板」）：**无条款号的那条尾巴不印了**。
  //   样张里外部标准（FDA 那篇）没有「第 X 条」、也没有链接锚点，行尾是**空的**；
  //   而我们 10-13 给它补了一句「非权威候选线索 · 不构成依据（无条款号，回不了源）」——
  //   那是**我们自造的兜底措辞**，比样张吵，Owner 逐条对照后要求去掉。
  //   ⚠️ 去掉的只是**卡面这一句**：「这条回不回得了源」仍逐条落在 `merged-*.json`
  //     的 `items[].source / basis_kind / basis_missing`，以及报告正文里 —— 信息没丢，只是不上卡。
  //   ⚠️ 正向标记**一个字没动**：有条款号＋链接就照旧印「—— 有库内条款依据」（㉒e2 钉着）。
  const origin = _kbWeak ? ''
    : (f.source === 'kb' ? '**有库内条款依据**'
      : (f.source === 'model' ? ''
        : (f.source === 'both-conflict' ? '**两侧都命中 · 结论冲突 ⇒ 已降 REVIEW**'
          : '**两侧都命中（可回源）**')));
  // ⚠️ `origin` 可能为空串（模型侧那条）—— 空的时候**整段连「——」一起不印**，
  //   否则首行会挂一个悬空的破折号（`位置  —— `），比原来更难读。
  const originTail = origin ? `  —— ${origin}` : '';
  // ★ 库侧那条 `依据` 行**原样用**（它带逐字命中文案 + 飞书源直链）。
  //   为什么必须搬、不能重建：L0 定位（`feishu_publish.l0_locate`）是 **Python** 的能力，
  //   JS 这一侧没有 ⇒ 重建只能造出一个更差的版本（「《知识库》W-1.16（锚点：#…）」，
  //   点不开、也没说命中了什么）。§2.4 的「搬是搬」：能搬就别造。
  const hasKb = f.source === 'kb' || f.source === 'both' || f.source === 'both-conflict';
  const kbBasis = (hasKb && (f.kb?.basisLine || f.basisLine)) || null;
  const basis = kbBasis || (f.source === 'kb'
    ? `《知识库》${f.kb?.article_no ?? '（未给条款号）'}（锚点：${f.kb?.anchor ?? '—'}）`
    : (f.source === 'both'
      ? `两侧都命中（库内条款 ${f.kb?.article_no ?? '—'} ／ 独立复核也命中）`
    : ((f?.model?.basis_kind === 'skill_report'
        ? '**判定主体核查**（图片安全审查）—— 未落在库内条款上，需人工确认'
        : null)
      || (extB?.cited ? extB.line : null) || noExtBasis
      || (visualObservationOf(f) ? noExternalBasisText(f)
        : (extB?.line || '**无库内依据** —— 未落在知识库条款上（独立复核给出的判断）')))));
  // ★★ 2026-10-19（Owner：「1.这里要带飞书源侧链接『依据文档链接：《知识库》第 E-2.124 条
  //    ← 命中「100%」』」）—— **直链由渲染层兜底，不靠每个上游各自记得**。
  //
  //   实测病灶：`entry_url` 明明在条目上，但**只有引擎那条路**会把它写进 `basisLine` 文字里；
  //   另外三条路（候选 / 分块解析 / 模型侧外部标准）只填字段、不写文字 ⇒
  //   报告印出「依据文档链接：《知识库》第 E-2.124 条 ← 命中「100%」」**而没有链接**。
  //   实测夹具（`kb.entry_url` 有值、`basisLine` 不带）：改前印不出链接。
  //   ⇒ 规矩：**手里有 URL、文字里没有 ⇒ 补一段**；没有 URL ⇒ 一个字都不加（不造链接）。
  const _entryUrl = String(f.kb?.entry_url || f.entry_url || '').trim();
  const _basisWithLink = (/^https?:\/\//.test(_entryUrl) && !String(basis).includes(_entryUrl))
    ? `${basis}｜原始出处：[点开核对](${_entryUrl})`
    : basis;
  const verdict = f.source === 'both-conflict'
    ? '**两侧结论不一致 ⇒ 降为 REVIEW，转人工**（不许任一侧单独定案）'
    : (f.severity === 'BLOCK' ? 'BLOCK' : 'REVIEW');
  // ★ 来源标记放**条目第一行末尾**，不动 §5.3 的 `【维度-子类】` ——
  //   那个标签是 PRD 契约（`prd53.conforms` 与 `l7_integrity.py` 都在核它），
  //   往里面塞「模型侧」会把格式一致性判据打破。而来源必须**一眼扫得到**：
  //   库侧条目回得了源、模型侧条目没有依据 —— 这两样的下一步完全不同。
  // ── ★★ 2026-10-09：**「建议」必须来自两侧的真话**（Owner 当场提的）
  //
  //   Owner 原话：「守衡输出的建议都是『转对应负责人复核』。我期望的是：
  //   **知识库侧和模型侧都输出具体的修改建议**，而不是甩给人。」
  //
  //   病灶：这一行原先是**硬编码常量** ——
  //     `建议：${must ? '修改后重新提交。' : '转对应负责人复核。'}`
  //   无论两侧说了什么，它永远印这两个字符串之一。而两侧其实都有东西：
  //     · 库侧 `review_engine.py:321` **本来就有** `suggestion`
  //       （没有时它自己写「（来源未给修改建议）」—— 它对自己的沉默是诚实的）；
  //     · 模型侧由 `model_side.mjs` 的 `suggestion` 字段给（本轮新增，提示词一并改了）。
  //
  //   两侧都没给 ⇒ **如实说没有**，不许用「转人」冒充一条建议 ——
  //   那会让人以为「已经有人看过了」，而真相是**这一条只有现象、没有可执行的改法**。
  const sugKbRaw = (hasKb && (f.kb?.suggestionLine || null)) || null;
  const sugKb = sugKbRaw ? cleanAdviceText(sugKbRaw) : null;
  const sugModel = cleanAdviceText(f.suggestion || f.model?.suggestion || '');
  // ── ★★ 2026-10-09：**「建议」的唯一产出者是 `advice.mjs`**（Owner 定的规则）
  //
  //   Owner 原话：「建议必须具体内容。负面样本『建议』列填充 47% ⇒ **有填的做参考，
  //   agent 输出最终具体建议**；没填的不用参考，agent 直接出建议。」
  //
  //   所以优先级变了：**有 `f.advice` 就用它**（那是两侧都回来之后那次调用为这一条
  //   专门写的改法），下面两套「库侧优先 / 模型侧优先」**降级为回退** ——
  //   只在建议生成失败时兜（`advice.mjs` 失败不编）。
  //   为什么过去关于「建议」的毛病都出在这一格：**它曾经有两个产出者**
  //   （库侧原话 / 模型原话）⇒ 库侧有值时模型那条被静默丢掉、来源也标不清。
  const adv = cleanAdviceText(typeof f.advice === 'string' ? f.advice : '');
  // 改法**始终是模型写的** ⇒ 标注说「**参考了什么**」，不说「谁给的」：
  // 说成「库侧给的改法」是假陈述（句子是模型写的）。
  const advRef = f.adviceReferencedKb === true;
  // A concrete KB recommendation is already an authored rule output. If the
  // matcher merged several same-location KB rules, show that complete authored
  // list; otherwise let generated advice refine the KB reference and use the KB
  // text as fallback when generation produced nothing.
  const hasAggregatedKbAdvice = Array.isArray(f.kb?.relatedArticleNos)
    && f.kb.relatedArticleNos.length > 1 && !!sugKb;
  // ★★ 2026-10-22（Owner：「建议有两份，卡上传的那份是历史原文 —— 查」）：
  //   **`adv`（本单生成的改法）优先，库侧聚合原文降为参考。**
  //
  //   病灶（实测那一单）：两条负面样本 N-1.360 / N-1.132 位置相同被合并，
  //   `ruleRefs` 累积成 2 条 ⇒ `hasAggregatedKbAdvice` 为真 ⇒ 卡上**直接用库侧原文**，
  //   而 `建议生成` 刚跑完、日志写着 `ok/4139ms｜覆盖 1 条` 的那份**一个字都没印**。
  //   ⇒ 生成了、落盘了、没显示；而且**表里存的是生成的那份**，卡上印的是历史原文 ⇒
  //     卡与表对不上（反对的正是 Owner 2026-10-07 立的「卡与表同源」那条）。
  //
  //   为什么以 `adv` 为准：Owner 2026-10-09 原话「**有 `f.advice` 就用它** ——
  //   那是两侧都回来之后那次调用**为这一条专门写的**改法」。
  //   `hasAggregatedKbAdvice` 这一支是后来加的（想让多条同类条款的建议都露出来），
  //   它和那条口径冲突时，**以 Owner 的为准**；多出来的信息不丢，降为括号里的参考。
  //
  //   反向对照（`--selftest` ㉖a / ㉖b）：没有 `adv` 时**行为逐字不变**（仍印库侧原文）。
  //   ⚠️ 库侧原文**没有丢**：多条同类条款时它们本来就印在**「依据」**那一格
  //   （`basisLine` 由 `relatedArticleNos` 拼，N-1.360 ＋ N-1.132 逐条带锚点），
  //   不必在「建议」里再抄一遍 —— 而抄一遍会把「建议」撑过 `ADVICE_MAX`，
  //   被 `clipToLimit` 剪掉尾巴挂一个「…」（实测就这么丢的）。
  const sugLine = adv
    ? `${adv}（${advRef ? '**参考了库内反例的建议**' : '**库内无可参考建议**'}`
      + ' —— 改法是按素材给出的，**不是库规原文**）'
    : (sugKb
      ? sugKb
      : (sugModel
        // ★★ 2026-10-19（Owner 点名去掉这句尾巴）：改法就是改法，不必在卡上再声明一次出处
        //   （报告里仍写清「改法不是库规原文」，溯源不丢）。
        ? `${sugModel}`
        : '（**两侧都没给修改建议** —— 这一条只有现象，没有可执行的改法；'
          + '**不许把它读成「照此处理即可」**）'));
  // ══════════════════════════════════════════════════════════════════════════
  // ★★ 2026-10-09（Owner 裁定）：**PRD 四要素一行不少、顺序不动；多出来的作为补充行** ──
  //
  //   Owner 原话：「保留 7/8/9/10，但把它们**降格**到 PRD 四要素之后
  //   （PRD 四要素一行不少、顺序不动；多出来的作为补充行），**字段加粗保留**。」
  //
  //   PRD §5.3.2 / §5.3.3 的四要素 = 【维度-子类】位置 · 原因 · 依据 ·（BLOCK 才有）建议。
  //   改前，四要素之间**插着** `判定` 一行，且 `建议` 在 REVIEW 卡上也排在 `判定` **之前**
  //   ⇒ 顺序与 PRD 不一致。现在：
  //     前几行 = PRD 四要素，**顺序逐字照 PRD**（BLOCK：原因/依据/建议；REVIEW：原因/依据）
  //     之后   = 补充行（`判定`、REVIEW 的建议），**加粗保留**（Owner 明确要）
  //   ⚠️ 三个标签的加粗**不许撤** —— `l7_integrity.py:180`（`BLOCK 逐条四要素`）与
  //      `verify_cards.mjs` 的 J11 都钉着 `**原因**`/`**依据**`/`**建议**`。
  //   ⚠️ 「来源标记」（`—— **模型侧**（无库内依据）`）**留在第一行末尾**，理由不变：
  //      它决定这条的下一步（库侧回得了源、模型侧回不了），挪到补充区会让人读到第三行
  //      才知道「这条其实没有依据」。
  // ── ★ ★★ 2026-10-17（Owner 两次裁定，后令优先）───────────────────────────────
  //   第一次：「按『审计报告』模式重做」＝ PRD §8.3 的六格 ＋ P 级 ＋ 承办。
  //   第二次（同日，看到卡片变长后）：「**守衡输出的卡片格式不要动，你只是优化报告**」
  //   ⇒ 这里有**两个版式**，且**只有报告是新的**：
  //     · `layout === 'report'`（`merged_report.mjs` 唯一调用处）＝ 八格版；
  //     · 其余（卡片 `renderMerged`）＝ **与 2026-10-17 之前逐字一致**的三行版。
  //   ⚠️ 为什么仍放在**同一个函数**里而不是复制一份：两个函数就是两个产者，
  //      下一次改格式必然漂移（本文件已因「同一个东西两个产出者」栽过多次）。
  //      一个函数、两个分支 ⇒ 共享同一套 `origin` / `basis` / `sugLine` 计算，
  //      不一样的**只有版式**。
  //   ⚠️ 第一行两边都**一个字没动**：`N.【维度-子类】位置  —— 来源标记` 是 PRD §5.3 的
  //      逐条契约（`countRenderedItems`、`verify_cards` J11、`l7_integrity.py` 都在核它）。
  //   ⚠️ 加粗不许撤：`verify_cards` / selftest 多处钉着 `**原因**` `**依据**` `**建议**`。
  // ★★ 2026-10-19（Owner：「所属类别/所属子类」统一到 A3 12 类）：首行标签改用 **A3**
  //   （`taxonomyCategory` / `taxonomySubcategory`，真源 `kb/l3/registry/rule-taxonomy.json`）。
  //   改前印的是 **A1 8 类词表**（`f.category`/`f.sub`）。盖不到 ⇒ `未归类`（12 类的兜底类）。
  // ★★ 2026-10-19（Owner 调整建议上限；当前值见登记表 runtime_override）——
  //   卡面和报告共享 `ADVICE_MAX`，避免将历史 30 字写死在执行逻辑中。
  //   ⚠️ 第一版把截断写在报告用的 `sugShort` 上 ⇒ **截错了介质**（卡面照旧 112 字、报告反被压）；
  //      而且定义放在卡面 `head` 之后 ⇒ TDZ（`Cannot access 'sugCard' before initialization`）。两处都已正。
  //   卡片与报告用同一个登记表上限（`ADVICE_MAX`），提示词、压缩器与闸门也共用它。
  const CARD_REASON_MAX = 50; // PRD §5.3.3：原因 ≤50 字（本轮 Owner 只说建议，原因未动）
  // ★★ 2026-10-19（Owner：「建议中『（全文见报告）』这里**都没有报告**，没有的东西不要说」）——
  //   真单只有 1 处问题 ⇒ **不出报告**（PRD §5.3.4：≥3 才出报告）⇒ 那个指针指向空气。
  //   ⇒ 只有**手里真有报告链接**时才加指针；没有就**纯截断**，一个字不多说。
  //   是否有报告由调用方告知（`renderMerged` 知道 `reportUrlOverride`；报告渲染那一支本身就是报告）
  const _hasReport = hasReport === true || layout === 'report';
  // ★★ 2026-10-19（Owner 裁定「1→2→3 全做」）：压字**只走 `clipToLimit`**（唯一实现）。
  //   为什么保留 `_clip` 这个薄壳：下面几处调用点一行都不用改，改动面越小越不容易带坏别的东西。
  //   ⚠️ 但**「有没有被截」必须拿得到** —— 那就是 `_clipR`（返回 `{text, truncated, full, shown}`）：
  //      卡上要出声、落盘记录要留痕。旧实现只回一个字符串，截没截**从调用点看不出来**。
  const _clipR = (t, max, withPointer = _hasReport, count = _prd533CountChars) =>
    clipToLimit(t, max, { hasReport: withPointer === true, count });
  const _clip = (t, max, withPointer = _hasReport) => _clipR(t, max, withPointer).text;
  // ★ 2026-10-19：卡面建议同样按**不计标点**数（与报告、与 `advice.mjs` 同一把尺）
  const sugCardR = _clipR(sugLine, ADVICE_MAX, _hasReport, countAdviceChars);
  const sugCard = sugCardR.text;
  // ★★ 2026-10-19（真链路实测：REVIEW 2 条总长超 200/条）—— 依据那一格压掉**散文**：
  //   外部标准把小节名、英文定义、「（登记来源 · 每日复核）」全印上，一条就 100+ 字。
  //   卡面只留**可引的最小坐标**：`《文档名》第 X 条` 或 `机构《文档》（外部标准）`；
  //   散文全文留在报告 —— 溯源一个字没丢。
  //
  // ★★ 但**链接与核验状态一个字都不许砍**（压实测踩到的坑，5 条判据当场变红）：
  //   Owner 2026-10-14「所有参考知识库的，都必须带飞书侧源链接」；模型自写 URL 那条
  //   （2026-10-13「模型当然有权限写 url」）还要求把 `✅ 已核（HTTP 200）` / `⚠ 未核`
  //   原样印出来（`dual_track --selftest` 的 ④b / ④b4 / ④b5 / ⑮b / ⑯b 钉着）。
  //   ⇒ 压的是**散文**，不是**坐标**：`<最小坐标>｜<核验状态>｜原始出处：<url>`。
  //   ⚠️ 上一版只留了最小坐标、把 URL 与状态一起丢了 —— 那不是"压字"，是把溯源砍了。
  const basisCard = (() => {
    // ★ 2026-10-22（Owner：「依据文档链接…表格名称+飞书链接就好」）：卡面同样先压缩 ——
    //   同一份记录命中 4 条时，原来会把「《表格名》第 X 条｜原始出处：URL；《表格名…」整串
    //   印到卡上（实测被 URL 正则吞掉后半截，留下一个断掉的表格名）。
    //   压缩后卡面只留：`《表格名》第 N-1.307 等 4 条｜原始出处：<url>`。
    const t = String(_basisWithLink ?? '');
    const compact = compactBasisLine(t);
    // ⚠️ URL 的字符集要停在**中文标点**（`；` 不是空白）—— 否则会把下一条条款一起吞进链接。
    const link = (compact.match(/https?:\/\/[^\s)）」』；;，。、\]]+/) || [])[0]
      || (t.match(/https?:\/\/[^\s)）」』；;，。、\]]+/) || [])[0] || '';
    const status = (t.match(/[✅⚠]\ufe0f?\s*[^｜\n→]{0,18}/) || [])[0]?.trim() || '';
    // 先剥掉**内部坐标**、**压缩时留下的 `（链接：…）` 壳**与**登记口径尾巴**
    // （Owner 2026-10-17：卡面不许出现后台词），再挑最小坐标。
    // ⚠️ 只剥这两样 —— `（未给条款号）` 这种**如实说明**要留着，
    // 它是「重建版（点不开）」与「原样搬来的权威版」之间唯一还看得见的差别（⑬ 反向对照钉着）。
    const bare = compact
      .replace(/（链接：[^）]*）/g, '')
      .replace(/（锚点：[^）]*）/g, '').replace(/｜?\s*锚点[:：][^｜\n]*/g, '')
      .replace(/（登记来源\s*·\s*每日复核）/g, '')
      .replace(/[→—]+\s*$/g, '')
      .replace(/\s+/g, ' ').trim();
    let label;
    const art = /(《[^》]+》)\s*第\s*([A-Za-z0-9][A-Za-z0-9.\-]*)((?:\s*、\s*[A-Za-z0-9][A-Za-z0-9.\-]*)*)\s*条/.exec(bare);
    if (art) {
      const n = 1 + (art[3].match(/、/g) || []).length;
      label = `${art[1]}第 ${art[2]}${n > 1 ? ` 等 ${n} 条` : ' 条'}`;
    } else if (/^无外部依据/.test(bare)) {
      // ★ 2026-10-22：这一格是**如实说没有外部依据**，不是坐标 ⇒ 原样留着（别被下面的
      //   长句压缩砍成 `无外部依据（原图观察：图 1：右侧成人女性穿蓝色刷手服、颈挂听诊器…`）。
      //   ⚠️ 上限仍要有（卡面一格放得下）：锚点太长时**截锚点、留结论**。
      label = bare.length <= 80 ? bare : `${bare.slice(0, 78)}…`;
    } else if (bare.length <= 60) label = bare;          // 已经很短 ⇒ 原样
    else {
      const doc = /([^（）()]{0,24}《[^》]+》)/.exec(bare);
      // ⚠️ `（外部标准）` 只给**模型侧/外部**那条加 —— 库侧重建筑的 `《知识库》`
      //   加了这个后缀就是**假陈述**（它不是外部标准，而且回不了源）。
      label = doc ? `${doc[1]}${f.source === 'model' ? '（外部标准）' : ''}` : `${bare.slice(0, 38)}…`;
    }
    return [label, status, link && `原始出处：${link}`].filter(Boolean).join('｜');
  })();
  // ★★ 2026-10-19（Owner：「**原因 ≤50 字是 prd 要求**，现在都 90 多字了」）——
  //   上一轮我只「量」没「压」，这是**我漏的**：§5.3.3 对卡面是硬约束。
  //   卡面原因压到 ≤50 字（取第一句；报告里仍是全文，溯源不断）。
  const reasonFull = String(businessReason(f.kb?.reasonLine ?? f.reason ?? '（未给理由）') || '（本次没有可念的理由）');
  const reasonR = _clipR(reasonFull, CARD_REASON_MAX);
  const reasonCard = reasonR.text;

  const _taxLbl = taxonomyLabelOf(f);
  // ★★ 2026-10-19（步骤 1：**先落盘，再摘字眼**）——**渲染即产元数据**。
  //   病灶：`source`（这一条是模型侧还是库侧）、`basis_missing`（回不回得了源）、
  //   「哪一格被截了几字」这些判断**只在这个函数里算过一次**，而它们**从来没落过盘**
  //   （`merged-reports/` 362 个文件全是 `.md`）⇒ 于是谁都不敢把
  //   「无库内依据 · 建议转人工」从卡上摘掉：摘掉之后逐条层面就再也答不出来了。
  //   ⇒ 现在在**算完、渲染前**把同一份读数交出去（`onMeta`），由 `renderMerged` 收集、
  //     `merged_record.buildMergedRecord()` 落盘。**记录层不许重算**（重算就是第二个产者）。
  onMeta?.({
    index: i,
    origin,                                    // 一句话说清「回不回得了源」（卡上印不印另说）
    source: f.source ?? null,                  // kb | model | both | both-conflict
    basis_kind: extB?.cited ? (extB.kind ?? 'cited')
      // ★ 2026-10-22：**「依据是画面观察」与「依据是素材原文」分得开** ——
      //   记录层据此答得出「这条凭什么判的」，而读者看到的依据格两边都写「无外部依据」。
      : (visualObservationOf(f) ? 'visual_observation'
        : (materialExcerptText ? 'material' : (f?.model?.basis_kind ?? f?.basis_kind
          ?? (f?.source === 'model' ? 'none' : null)))),
    basis_cited: extB?.cited ? true : ((visualObservationOf(f) || materialExcerptText) ? false : null),
    basis_missing: !!(f?.model?.basis_missing || f?.basis_missing) && !materialExcerptText,
    basis_card: basisCard,
    reason_full: reasonFull,
    reason_card: reasonCard,
    reason_truncated: reasonR.truncated,
    reason_full_chars: reasonR.full,
    reason_shown_chars: reasonR.shown,
    advice_card: sugCard,
    advice_truncated: sugCardR.truncated,
    advice_full_chars: sugCardR.full,
    advice_shown_chars: sugCardR.shown,
    tax_label: _taxLbl,
    location: f.location ?? null,
  });
  const head = `${i + 1}.【${_taxLbl}】${f.location}${originTail}\n`
    + `   **原因**：${reasonCard}\n`
    + `   **依据**：${basisCard}\n`
    + `   **建议**：${sugCard}\n`;
  // ── 卡片：**就是上面三行**（2026-10-17 之前一直如此，一个字都没改）──
  if (layout !== 'report') return head;
  // ── ★ ★★ 2026-10-17 第十八轮（Owner：「我给你的报告字段是 **维度、位置、问题描述、原因、
  //      依据文档链接、修改建议**。你不要乱改，改回去」）────────────────────────────────
  //   我把样张的字段名（定位/原文/依据/证据指纹/事实/判断/处置）当成了可改项 —— 那是**越界**。
  //   ⇒ 现在：**形状**照样张（标题行 ＋ 子弹点），**字段名逐字用 Owner 定的那六个**。
  const pri = priorityOf(f);
  const desc = descriptionOf(f);   // ★ 2026-10-19：`dim` 已随四维一起撤掉（逐条改印 `所属类别`）
  // ★★ 2026-10-19（Owner：卡上说「未归类」，可报告里每条都有类 ⇒ 两处必须同一套）：
  //   报告逐条标签原来印的是 **A1 8 类词表 / 模型侧类目**（`功效宣称` / `合规` / `消费者安全`…），
  //   而卡面与附录印的是 **A3 12 类** —— 同一单两种名字，读的人当然会问「到底归没归」。
  //   现在报告逐条也印 A3：`<所属类别>·<所属子类>`（子类没有就只印类别；盖不到 ⇒ `未归类`）。
  const label = taxonomyLabelOf(f).replace(/-/g, '·');
  const fidTxt = itemId ? String(itemId) : `F-${String(i + 1).padStart(2, '0')}`;
  // 修改建议：**卡面与报告同一把尺**（2026-10-19 第二版，Owner 看的是**报告**）
  //   历史：2026-10-17 第二十四轮 Owner 说「建议都写全」，那时只留前 120 字、尾巴挂
  //   「（完整改法见「依据文档链接」条款原文）」—— 而被指到的那一格是**条款原文**，
  //   本来就不含改法，所以「写全」是对的。
  //   当前运行上限来自登记表 `runtime_override`；报告与卡面共用 `ADVICE_MAX`。
  //   ⚠️ 全文没丢：`advice` 原文仍在结构化 JSON（`review_findings.json`）与本地留底
  //     `merged-*.full.md` 里 —— 搬是搬、砍是砍，报告格子里不摊开，但一条没少留。
  //   ⚠️ 压法是**取第一句可执行动作**，不是硬截断：硬截会把「①…②…③…」截成半句；
  //     超过 `ADVICE_MAX` ⇒ 依据同一字符口径压缩，未超限则原样显示。
  //   ★★ 报告那一格量的是**改法本体**（`sugCore`），不是 `sugLine`（后者带着出处标注）。
  //     否则那半句「（库内无可参考建议 —— 改法是按素材给出的…）」会被截进 30 字里，
  //     **Owner 2026-10-19 点名去掉的两句又回到报告**（Z23 当场抓到）。出处改由标题行说。
  const sugCore = hasAggregatedKbAdvice
    ? sugKb
    : adv
    || sugKb
    || sugModel
    || '（两侧都没给修改建议 —— 这一条只有现象，没有可执行的改法）';
  const sugFull = String(sugCore || '').trim();
  // ★★ 2026-10-19（Owner：「修复建议都没讲完，被截断了，不能出现这种情况」）：
  //   报告这一格**改用 `fitAdvice`** —— 超过 `ADVICE_MAX` 才压缩。
  //   理由与「为什么不用取第一句」写在 `fitAdvice` 头注里（`删 X，或补 Y` 被压成 `删 X`
  //   是把二选一改成了唯一动作）。
  const sugShortR = fitAdvice(sugFull, ADVICE_MAX);
  const sugShort = sugShortR.text;
  // ★★ 2026-10-19：那条**出处标注**（「参考了库内反例的建议 —— 改法是按素材给出的，
  //   不是库规原文」）**不许挤占建议字数** —— 它防的是「把模型写的改法读成库规原文」
  //   （Owner 2026-10-09 定的口径），砍掉就是**用压缩换掉了防误导**。
  //   ⇒ 它挪到**标题行末尾**（元信息那一格），与来源标记并列：
  //     标注与动作分格显示；建议动作的运行上限统一由 `ADVICE_MAX` 执行。
  //   ⚠️ **只标「参考了」这一种**（`advRef === true`）；没参考时**一个字都不印** ——
  //     印「库内无可参考建议 / 无库内依据的改法建议」正是 Owner 2026-10-19 点名去掉的说法
  //     （「这一条回不回得了源」由**依据格**回答，不在建议格里重复）。
  //     判定：**标注必须与事实一致** —— 参考了才说参考了，没参考绝不许说参考了（Z23 钉着）。
  const adviceSrcTag = adv && advRef ? ' · 改法参考库内反例（非库规原文）' : '';
  // ⚠️ 来源标记（`**有库内条款依据**` / `**无库内依据 · 建议转人工**`）留在**标题行末尾** ——
  //   它是业务侧判断「这条能不能回源」的唯一信号（Owner 2026-10-14 的口径，Z21/Z48 都在核）。
  //   第六个字段里没有它，所以它只能挂在标题行上；也不许塞进六个字段里改名字。
  // ★★ 2026-10-17 第十九轮（Owner：「这堆字体要对齐，**字体小一些**」）──────────────
  //   飞书 docx 没有字号可设。**唯一能把字变小又保持左对齐的结构是引用块 `>`**
  //   （实测：多行 `>` 合成一个 `<blockquote>`，行内 `<br/>` 换行，字号小于正文、
  //    左边一条竖线、折行与文字左缘对齐）。`#####`/`######` 不行 —— 那是标题，反而更大。
  //   ⇒ 六个字段从**项目符号**改成**引用块**：整块变灰变小、六行左缘对齐，
  //     字段名仍加粗，扫读不受影响。
  //   另外「依据文档链接」里的长 URL 改成**文字链接**（实测那一段折行后把版面顶乱）：
  //     `原始出处：[点开核对](https://…)` —— 链接照样可点，行宽不再被 URL 撑爆。
  // ★★ 2026-10-17 第二十二轮（Owner 两条）：「**禁止用任何后台词**（recvuJYdOb1Rm1/），
  //   别人听不懂的字符编码」＋「**原因就说原因，别建议**，少做少错」。
  //   ⇒ 六格逐格过一遍：
  //     · 依据：先去**内部坐标**（`锚点：#表名/rec…/命中片段`），再把长 URL 收成文字链接；
  //     · 原因：去规则码、去建议子句（`businessReason`）；
  //     · 位置/问题描述/维度/建议：只挖内部标识（`stripBackendTokens`），语义一个字不改。
  //   ⚠️ **卡片那一支（上面那个 `head`）一个字符都没动** —— 清扫只发生在报告分支。
  // ★★ 2026-10-22（真单 `HD8Td5RjuouYIDxrZ2ocoshVn9Z`）：**URL 的字符集要停在中文标点**。
  //   旧实现用 `\S+`，而中文标点不是空白 ⇒ 链接会变成
  //   `[点开核对](…recvw7XIUgXEvk；《内部正负样本库…》第)` —— URL 把后半句吞了，点开是错页。
  //   与上面 `stripBackendTokens` 的 stash 正则同一条口径；并加 `/g`：
  //   依据行里剩下的 URL（不同记录）也照样可点，而不是只链化第一条。
  // ★ 2026-10-22（Owner：「依据文档链接里就一条链接怎么写这么多字？表格名称+飞书链接就好」）：
  //   **先** `compactBasisLine`（原始串里每条条款自成一段，按 `；` 切得开），**再**
  //   `businessBasis` 去锚点 —— 顺序反过来时，`businessBasis` 会把「锚点」与「下一条条款」
  //   用 `｜` 拼进同一段，压缩时只认到第一条，后面几条会被静默吃掉（实测）。
  //   剩下的裸 URL 才走下面那条链接化替换。
  const basisLinked = businessBasis(compactBasisLine(_basisWithLink)).replace(
    /(原始出处[:：])(https?:\/\/[^\s)）」』；;，。、]+)/g,
    (_m, p1, url) => `${p1}[点开核对](${url.replace(/）$/, '')})`,
  );
  const q = (t) => `> ${t}`;
  // 标题三格：`F-01 ｜ 类别·子类 ｜ 级别` —— **不带「立即停发」这类未经确认的处置词**
  // ★★ 2026-10-17 第二十三轮：除「依据文档链接」外，其余每一格的 markdown 链接语法
  //   一律降成纯文字（`demoteLinks`）—— 引用原文不等于替原文做可点入口。
  //   ⚠️ 依据那一格是**我们自己的飞书直链**，必须保持可点，**不降**。
  const text = (v) => demoteLinks(stripBackendTokens(v));
  // ★★ 2026-10-19（Owner：「**报告要同步 卡上 12 类呀，整个知识库都要同步**」）——
  //   这一格原先是 PRD 四维（合规/消费者安全/产品描述/措辞表达），与卡面的 A3 12 类**两套体系**：
  //   同一单里 F-04 维度=消费者安全、所属类别=合规与受监管宣称，一屏两个数，人当然算不平。
  //   ⇒ 现在整条链**只有一个轴**：A3 12 类。字段名也跟着改（值变了还叫「维度」就是骗人）。
  // ⚠️ 报告首行同理：`origin` 为空（模型侧那条）时**不印破折号**；
  //   但 `adviceSrcTag`（改法参考了库内反例）是**另一件事**，它照旧要印。
  return `**${fidTxt} ｜ ${label} ｜ ${pri.level || '未分级'}**${originTail}${adviceSrcTag}\n`
    + `${q(`**所属类别**：${text(taxonomyCategoryOf(f))}`)}\n`
    + `${q(`**位置**：${text(f.location)}`)}\n`
    + `${q(`**问题描述**：${text(desc.text)}`)}\n`
    + `${q(`**原因**：${demoteLinks(businessReason(f.kb?.reasonLine ?? f.reason ?? '（未给理由）'))
        || '（本次没有可念的理由，见「依据文档链接」条款原文）'}`)}\n`
    + `${q(`**依据文档链接**：${basisLinked}`)}\n`
    + `${q(`**修改建议**：${text(sugShort)}`)}\n`;
}

/**
 * 把合并结果渲染成 **PRD §5.3 的结论块**（结论行 + 逐条 + 动作行）。
 *
 * ★ 只在**模型侧真的报了东西**时才调用（见 `agent.mjs` 的 `shouldOverride`）：
 *   模型侧没报 ⇒ 返回 null ⇒ 结论原文**一个字不改**，仍用链给的那份。
 *   这条是「新增旁路不许改变原有行为」的执行点 —— 双轨改造最容易犯的错
 *   就是顺手把原来的单轨结论也改了一遍。
 *
 * ★ 更不许产出 PASS：`state` 由 `mergedState()` 给，而它要求 `kbCovered === true`。
 *
 * @returns {{line:string, block:string}|null}
 */
export function renderMerged(merged, { state, kb = null, kbTextCount = null, model = null,
                                     reportUrlOverride = null, kbHitsBlock = null,
                                     mergedStats = null, modality = null } = {}) {
  const list = Array.isArray(merged) ? merged : [];
  const n = list.length;
  const kbN = Number.isFinite(kb?.issueCount) ? kb.issueCount : null;
  const txtN = Number.isFinite(kbTextCount) ? kbTextCount : null;
  // ★★ 2026-10-08：**「覆盖缺口那条」与「明细抠不出来」是两件事，原先被混成一件** ──────
  //   病灶（实测，Owner 2026-10-08 拿一张图逼出来的）：
  //     引擎对覆盖缺口的形状是 `state=REVIEW` ＋ `refusal=coverage_not_covered`，
  //     且它把「覆盖-知识库覆盖缺口」当成**一条 finding** 计进 `issue_count`（实测 =1）。
  //     JS 侧早就知道那条不是内容问题（`COVERAGE_CATEGORY` 把它踢出 findings），
  //     **但没把它从 `issueCount` 里踢掉** ⇒ 它又从 `kbGap = kbN − txtN = 1 − 0 = 1` 溜回来，
  //     于是卡片上多出一句「另有 1 条未并进本卡：PRD §5.3.3 规定问题数 ≥3 时库侧只出分类汇总」
  //     —— 而这一单的 `issue_count` 是 **1**，压根不是 ≥3 ⇒ **解释与事实不符**。
  //   现在的口径（三条，缺一条都不算修好）：
  //     ① 覆盖缺口那 1 条**算「需人工确认」**（人确实要去看覆盖）⇒ 进 `total`；
  //     ② 但它**不算「明细抠不出来」** ⇒ 不进 `kbGap`，也不触发那句 ≥3 的解释；
  //     ③ 「抠不全」的解释**按真实原因分支**：≥3 才说 §5.3.3，<3 就如实说抠出几条。
  const covGap = !!kb?.coverageGap;
  // ★★ 2026-10-12：**非权威候选线索**要出声（库侧 `issue_count` 已改成只算库内依据）。
  //   为什么必须单独说：那个数改小之后，"库里报了几条"与"还剩几条线索要人扫一眼"是两件事，
  //   而候选在卡上原本**完全不可见**。措辞与库侧口径一致（见 `review_engine.candidate_note`）。
  const candN = Number.isFinite(kb?.candidateCount) ? kb.candidateCount : 0;
  const candNote = candN > 0
    ? `\n⚠️ 另有 **${candN} 条非权威候选线索**（源规则已声明不权威/已被取代，`
      + `**无库内条款号、不构成依据**）—— 见报告完整清单。`
    : '';
  // ★★ 2026-10-15（Owner 裁定：「**没有命中就是 pass**，按照 prd 的一句话结论走，
  //   **你不要自己定义**」）—— 这里原先写着 `const covEntries = covGap ? 1 : 0;`
  //   （注释还自述「那 1 条覆盖缺口：算「需人工确认」」）。
  //
  //   病灶（真单 `MC-US-YT-_xyLF4_AgAw-IMG`，群里那张卡）：两侧**一条都没命中**
  //   （模型侧 0 条 ／ 库侧 `issue_count=0`），却被这一行自己加了 1 ⇒ `total=1`
  //   ⇒ 抬头「共发现 **1** 处需人工确认」，而逐条里一条都没有、报告文档里只有一句话
  //   ⇒ Owner 看到的就是「一个问题要输出问题到卡片」而卡上什么都没有。
  //   **覆盖缺口不是一条内容问题**（库侧自己的条数就是 0）⇒ 从今往后它**不进 `total`**。
  //   它的说明（含「未命中 ≠ 合规」那条边界）照旧留在 `internalNotes` —— 守衡答得出来，
  //   但**不上卡、不进报告正文**（Owner 2026-10-13 的裁定没变）。
  const kbMissingDetail = !covGap && kbN != null && kbN > 0 && (txtN == null || kbN > txtN);
  const kbGap = kbMissingDetail ? Math.max(0, kbN - (txtN ?? 0)) : 0;

  // ── 拒答（库侧未判）：不发"结论"，只发「这次谁没判」（2026-10-07 加）──
  //   原先拒答被折算成「0 条」⇒ 用户收到一张形如双轨结论的 REVIEW 卡，
  //   而表里那行的结论是 NEEDS_INPUT —— 同一单两个结论。
  if (state === 'NEEDS_INPUT') {
    // ★ 2026-10-13：同上 —— 去词不去信息。「哪一侧没判」照样说得清（说「审查引擎未判」）。
    const line = `【审查结论：NEEDS_INPUT】**审查引擎未判**（拒答、fail-closed）`
      + (kb?.reason ? `：${kb.reason}` : '') + '。';
    const body = list.length
      ? list.map((f, i) => `${i + 1}.【${f.category}${f.sub ? '-' + f.sub : ''}】${f.location}`
          + `  —— **无库内依据 · 建议转人工**\n   原因：${f.reason ?? '（未给理由）'}\n`
          // ★★ 2026-10-14（Owner 裁定）：拒答卡上的 `判定：REVIEW` 一并删除 ——
          //   三态只出现在上面的结论行（本支路是 `【审查结论：NEEDS_INPUT】`）；
          //   逐条再挂一个「判定：REVIEW」会让同一张卡出现**两个互相打架的三态**。
          + `   建议：**先恢复库侧再定**（本条不能当通过或拦截依据）。`).join('\n\n')
      : '（模型侧本次没报东西。）';
    // ★ 2026-10-08（Owner 同意 ②）：**「库忙」要写成「已排队」，不能写成「没下文」。** ──────
    //   病灶：卡原先只写「本次没有知识库三态结论 … **下一步**：先把库侧恢复（跑层/日更）再重审」——
    //   读者读到的是**死局 + 一份他做不了的作业**（"跑层/日更" 是维护动作，不是送审人的活）。
    //   而实际上这一单**已经进了补发队列**，判据是硬接线：
    //     `agent.mjs` 的 `chainUnmeasured`（＝「链没给出三态结论」，`!= PASS/REVIEW/BLOCK` 全算）
    //     为真 ⇒ 一定 enqueue；重试窗口 **1 小时 / 最多 5 次**，而认领 TTL 是 **45 分钟**
    //     ⇒ **窗口盖得住**（实测日志：`↻ 送审单但链没跑成（库忙…），可重试=true → 已入补发队列`）。
    //   ★★ 但不写「会另行告知」—— 实测 `deadDrop` 只把条目落进死信文件、**不通知任何人**；
    //     写「耗尽会告诉你」就是撒谎。所以如实写「5 次都没跑成就不会再有下文」。
    const isBusy = String(kb?.reason ?? '') === 'claim_busy';
    const queueNote = isBusy
      ? '\n\nℹ️ **这一单会自己重跑**：`claim_busy` = **有别的会话正在跑这条循环**'
        + '（库内明文规矩：同一时间只准一个会话跑），**不是这一单有问题**。'
        + '槽一空出来会**自动补跑**（1 小时内最多 5 次）。'
        + '**若 5 次都没跑成，就不会再有下文** —— 那时请再 @ 我一次。'
        + '（等不及也可以先停掉那个占用会话，再送一次。）'
      : '';
    const nextStep = isBusy
      ? '**下一步**：**你不需要做什么** —— 等自动补跑；或先停掉占用会话再送一次。'
      : '**下一步**：先把库侧恢复（跑层/日更）再重审这一单。';
    return {
      line, total: list.length, kbGap: 0, refused: true, claimBusy: isBusy,
      block: `${line}\n**本次没有三态结论** —— 以下只是**独立复核**的初步观察，`
        + '**不得当通过依据，也不得当拦截依据**。\n\n' + body
        + queueNote
        + `\n\n${nextStep}`,
    };
  }

  // 没有条目、库侧也没缺明细 ⇒ **这一路不产块**（2026-10-15 起：覆盖缺口不再算一条问题）
  //   ★★ 2026-10-15（Owner：「没有命中就是 pass」）—— 这一路返回的东西有两件事要同时成立：
  //     ① **不产块** ⇒ 卡上不会出现空的「逐条问题」分组；
  //     ② **`total = 0`** ⇒ `agent.mjs` 那一跳（`rendered0.total > 0` 才建）**不建报告**
  //        ⇒ **「链接点开是空的」从结构上不可能再发生**；
  //     ③ ⚠️ 但**查证笔记必须留住** —— 对方问「库里到底覆盖没覆盖这个题材 /
  //        这个 PASS 算不算证明合规」，守衡要答得出来（Owner 2026-10-13：
  //        「输出到飞书群…不要展示在卡片上，**我问的时候，你要能回答**」）。
  //        ⇒ 覆盖缺口那一档返回一个**只有笔记、没有块**的对象（`block: null`）。
  if (!n && !kbMissingDetail) {
    const notes = covGap ? coverageGapNote(kbN) : '';
    // ★★ 2026-11-03（Owner：覆盖缺口可出 PASS + SUGGEST）：
    //   结论仍走 §5.3.1 一句话 PASS，但**卡上要带一条人能执行的建议**（补库覆盖）。
    //   内部口径（`coverage_not_covered` / BM25）仍只进 `internalNotes`，不上卡。
    if (notes && prd53StateOf(state) === 'PASS') {
      const pass = verdictLineFor({ state: 'PASS', n: 0 });
      const suggestion = 'ℹ️ 建议：知识库对该题材暂无审查依据，建议补充覆盖后再复核；'
        + '本次 PASS 仅表示未发现已知底线风险，不等于已证明该题材合规。';
      return {
        block: `${pass?.line ?? '【审查结论：PASS】未发现已知底线风险。'}\n\n${suggestion}`,
        line: pass?.line ?? null, total: 0, kbGap: 0, hitsBlock: null,
        internalNotes: notes, suggestion, coverageGap: true, refused: false, state,
      };
    }
    // ⚠️ 这里**只给消费方真读的那几个字段**（`agent.mjs` 读的是
    //   `rendered.block` / `.total` / `.internalNotes` / `.line` / `.kbGap` / `.hitsBlock`）——
    //   多塞字段就是「传了但没人接」那个病；而 `kbNoReading` / `modelFailed` 这些
    //   声明在下面 ⇒ 在这里引用会 **TDZ 报错**（本文件头部记着同一个坑）。
    return notes
      ? { block: null, line: null, total: 0, kbGap: 0, hitsBlock: null,
          internalNotes: notes, coverageGap: true, refused: false, state }
      : null;
  }
  const must = state === 'BLOCK';
  // ★★ 2026-10-19（Owner：「**依据：必须要提供依据，为问题做支撑**」）：
  //   依据缺失的条目**不上卡** —— 一条没有依据的"问题"，读者无从核对。
  //   ⚠️ 但**不静默**：被略掉的条数写进 `internalNotes`（守衡答追问时说得出来），
  //      而且它**照旧参与结论判定**（`mergedState` 用的是 `merged`，这里只影响卡面逐条）。
  //
  // ★★ 2026-10-19 第二次（Owner 拿真卡再问一遍：卡上仍印着
  //   `依据：独立语义复核（非条款依据，需人工核对）`）——记录一次**试过又撤回**的改法，免得下一个人再走一遍：
  //   我先在**渲染层**按「依据解析结果」重新判了一遍（`basis_missing` 标记之外的第二条路），
  //   结果 test_agent 当场 **14 项变红** —— 因为 `source:'model'` 在夹具里还承担
  //   「这一条是模型侧报的」这个**来源**语义，不等于「它必须自带外部依据」；
  //   而「有没有依据」这个判断**在解析边界上只该算一次**（`model_side.mjs:336`，
  //   `basis_missing` 就是那次判断的落盘），渲染层再算一遍就是**第二个口径**。
  //   ⇒ 保留单一判据（标记），**但把兜底放在出厂闸上**（`cardConformance()` 第 ④ 条）：
  //     真漏了会**出声**，而不是靠我每次记得在渲染层再拦一遍。
  const _cardEntries = list.map((f, sourceIndex) => ({ f, sourceIndex })).filter(({ f }) =>
    // ⚠️ 2026-10-22：这里的例外**不是**「素材原文可以当依据」，而是
    //   「这一条有可展示的素材锚点 ⇒ 别把真实问题滤掉」（Owner 同一天的另一条裁定：
    //   4 条都留）。依据格怎么印是 `noExternalBasisText` 的事，两件事分开。
    !(f?.model?.basis_missing || f?.basis_missing) || !!materialExcerpt(f));
  const _cardList = _cardEntries.map(({ f }) => f);
  const _noBasisN = list.length - _cardList.length;

  // ★ 2026-10-19：`total` 只算**上得了卡的**条目 —— 否则会出现「共发现 1 处」却一条明细都没有（账不平）。
  const _shownN = _cardList.length;
  const total = _shownN + kbGap;
  // 条数口径：能并的条目 ＋ **库侧结构性条数里没并进来的那部分**（重叠未判 ⇒ 这是上限，写明）
  //   ★★ 2026-10-15（Owner）：**覆盖缺口那 1 条已从算术里去掉** —— 「一处需人工确认」这个数
  //   只许由**真条目**（并进来的 ＋ 库侧未并进的）构成，不许自己定义。
  // ★★ 2026-10-21（Owner：4 态 = pass / pass+suggest / block / review）：**结论行写 `PASS+SUGGEST`**。
  //   措辞取自 PRD §5.3.4 那一档样张（`发现 N 处建议优化，不阻断发布`），态名按 §5.3.2 的四态写全
  //   （SUGGEST 是 PASS 的附属，不是独立态）。三条硬口径不变：
  //   ① 必须含「**不阻断发布**」（与 REVIEW 的分界）；② **不出现「需人工确认/必须修改」**；
  //   ③ 措辞判据在 `agent/prd53.mjs::conforms`（`prd53_format` ②g 系列盯着）。
  const suggest = prd53StateOf(state) === 'PASS+SUGGEST';
  // ★★ 2026-10-26 两轮：上午改写成 PRD §5.3.4 样张字面 `【X】`，下午 Owner
  //   （「输出格式的问题，在 10/22 都是好的，恢复到 10/22 的输出格式」）**写回 `【审查结论：X】`**
  //   —— 10-22 那 70 条卡面逐条都是这个前缀。读侧两种都认（`prd53.LINE_RE_PRD`），
  //   所以上午已落盘的新字面不会读不出来。
  const line = must
    ? `【审查结论：BLOCK】共发现 ${total} 处必须修改。`
    : (suggest
      ? `【审查结论：PASS+SUGGEST】发现 ${total} 处建议优化，不阻断发布。`
      : `【审查结论：REVIEW】共发现 ${total} 处需人工确认。`);
  // ★ 卡片这一支**只用三行版**（Owner 2026-10-17：「卡片格式不要动」）⇒
  //   不传 `layout`、也不算逐条承办 —— 逐条承办只在**报告**里出现。
  //   整单那一行 `建议转 @… 复核。` 本来就是卡片的（PRD §5.3.2 收尾），照旧在。
  const _hasReportForCard = /^https?:\/\//i.test(String(reportUrlOverride ?? ''));

  // ★★ 2026-10-19（步骤 1）：逐条元数据**收集在渲染这一趟里** —— 不另开一次遍历、不重算。
  //   它们随后进 `merged_record`（落盘 `.json`），也是「卡上摘掉来源标记」之后
  //   「你问我是哪一侧的问题」**唯一还答得出来的地方**（日志只有整单一行）。
  const itemsMeta = [];
  const items = _cardEntries.map(({ f, sourceIndex }, i) => renderMergedItem(f, i, {
    must, hasReport: _hasReportForCard,
    onMeta: (m) => itemsMeta.push({ ...m, source_index: sourceIndex }) }));
  // ★★ 2026-10-14（Owner 报：与 PRD 不符）—— 收尾动作行的**收件人按问题方向算**。
  //
  //   病灶：这一行原先是常量 `'建议转 @内容治理负责人 复核。'`。PRD §5.3.2 **两处**
  //   （1-2 条与 ≥3 条）逐字都写 `建议转 @法务 @医学顾问 复核。`，§9 写
  //   「REVIEW 自动转**对应**专业团队（法务、医学、专家、北美）」——
  //   而「内容治理负责人」不在那四个团队里，且**不随问题方向变**。
  //
  //   现在：方向词 → `routing-policy.json` 的 rules → owners（有序）→ 有句柄用句柄、
  //   没句柄写「角色名（未配置）」。读不到路由表就回落 PRD §5.3.2 那一对。
  //   ⚠️ 保住的：`建议转 … 复核。` 这个**句式**（PRD §5.3 的收尾），
  //      以及「一个方向都没命中时不许编一个收件人」。
  //   ⚠️ `applyVerdictLine` 只搬**结论行**（`【审查结论：…】`），不碰这一行 ⇒ 两处不打架。
  const routing = reviewOwnersFor(list, ROUTING_POLICY);
  // ★★ 2026-10-17：收尾那一行**收口到 `orderActionLine()`** —— 报告（`merged_report.mjs`）
  //   也要印同一行，两处各写一遍必然漂移（本文件已因「两个产者」栽过多次）。
  const action = orderActionLine(list, { must, routing, state });
  // ★ 块首汇总：**先让人看到「这次是谁在说话」**，而不是读完四条才自己拼出来。
  //   库侧 0 条而模型侧 5 条，与库侧 5 条，是两种完全不同的单子 —— 前者没有一条回得了源。
  const fromKb = list.filter((f) => f.source === 'kb' || f.source === 'both' || f.source === 'both-conflict').length;
  const fromModel = list.filter((f) => f.source === 'model' || f.source === 'both' || f.source === 'both-conflict').length;
  // ★ 库侧**没读数**时不许写「0 条」（2026-10-07，Owner 同意）——
  //   「库判过、没报东西」与「库这次没参与」长得一样，是**最容易被读错**的一处：
  //   实测素材 D 就是因为这一格含糊，加上表里落了 PASS，看起来像"库审过了、没问题"。
  const kbNoReading = kbNoReadingOf(kb);
  // ── 模型侧那一边的措辞（2026-10-08 加）────────────────────────────────────
  //   ★ 同一条纪律，模型侧原先**漏了这一半**：
  //     `renderMerged` 收不到 `model` ⇒「模型侧跑了、确实没报东西」与
  //     「模型侧**没跑成**（解析失败／异常／额度被 reasoning 烧光）」在卡上一模一样，
  //     都写成「模型侧 0 条」。实测（Owner 2026-10-08 那张图）：日志明写
  //     `模型侧 没跑成：输出里没有 JSON 数组`，卡片却写「模型侧 0 条」——
  //     人当场读成「没走模型侧」，排查方向整个错掉。
  const modelFailed = !!(model && model.ok === false);
  const modelErr = modelFailed ? String(model.error ?? '未给原因').slice(0, 120) : '';
  const modelTxt = modelFailed
    ? `模型侧 **没跑成**（${modelErr}）—— 本卡**没有**模型侧条目，`
      + '**这不等于「模型侧看过、没问题」**'
    : (model && model.ok === true && model.skipped
      ? '模型侧 0 条（文字层为空，本就未跑）'
      : `模型侧 ${fromModel} 条`
        + (list.some((f) => f.source === 'model')
          ? `（其中 ${list.filter((f) => f.source === 'model').length} 条**无库内依据**，只能转人工）` : ''));
  const kbContentN = fromKb + kbGap;              // 库侧的**内容问题**条数（不含覆盖缺口）
  // ★★ 2026-10-09：**这一行自己就是一个块，末尾必须有换行** ──────────────────
  //   病灶（实测）：`block` 的拼接是 `${line}${reportNote}\n${tally}${covNote}${bodyText}`，
  //   而 `tally` 与 `covNote` **都没有结尾换行** ⇒ 印出来是
  //     `…模型侧 2 条（其中 2 条**无库内依据**，只能转人工）1.【合规-医疗宣称】视频 00:12 字幕`
  //   —— 编号 1 与汇总行**粘在同一行**。`verify_cards.mjs:633` 的夹具里本来就有
  //   `'知识库侧 3 条 ／ 模型侧 3 条\n\n1.【合规】'`，**是代码与夹具不一致**，
  //   不是设计如此；夹具写得对，所以这条改动不会把判据打红。
  // ★★ 2026-10-09（Owner 报「图表数字对不上」）**页脚算术必须闭合** ──────────────
  //   病灶（实测本单，逐字）：抬头「共发现 **8** 处」，页脚「知识库侧 **2** 条 ／ 模型侧 **6** 条」——
  //   2+6=8 看着对，**而库侧实际并进来的是 5 条**（双轨读数：库侧 5 ＋ 模型侧 6 ⇒ 合并 8）。
  //   读者拿卡一算就不平：库侧 2 ＋ 模型侧 6 ＝ 8 ＝ 抬头，但卡里另一处又写着「REVIEW 5 处」。
  //   根因：页脚用的是「**并进清单里的**库侧条目」（`fromKb`），而抬头那个数是
  //   `n + kbGap + covEntries`（含**没并进来的**库侧条目）⇒ 两个口径不同的数并排印。
  //   ⇒ 改成三个**说得通**的数，且**加起来等于抬头**：
  //        知识库侧 X 条（结构化读数）＋ 模型侧 Y 条 − 两侧指向同一处的 Z 条 = 抬头
  //      （Z＝两轨确认 ＋ 冲突；`mergeFindings` 的 stats 里本来就有，不用另算）
  //   ⚠️ 不许再出现「页脚两个数加起来对不上抬头」的形状。
  const kbStructuralN = Number.isFinite(kbN) ? kbN : fromKb;
  // ★ 去重条数**用差额算**，不另取 stats：
  //   抬头 `total = n + kbGap + covEntries`（`n` = 并集去重后的条数），
  //   而左边两个数之和是 `kbStructuralN + fromModel` ⇒ 差额就是「并集之外多算的」，
  //   它**同时吸收两样东西**：两侧指向同一处的重复（stats.both/conflict）＋ 库侧未并进的 kbGap。
  //   ⇒ 这样「左式 − 差额 ＝ 抬头」**恒成立**，说明文字也不会与 `kbGap` 那段重复计数
  //     （第一版两种都写，印出来是「5+6=11」又「另有 3 条未并进」，自相矛盾）。
  const lhs = kbStructuralN + fromModel;
  const dedupN = Math.max(0, lhs - total);
  const tally = (kbNoReading
    ? `知识库侧 **本次未参与**（没拿到引擎读数） ／ ${modelTxt}`
      + `（**全部无库内依据**，只能转人工）`
    : (covGap && !kbContentN
      // ★ 2026-10-08：覆盖缺口那条**不是内容问题** —— 不许让它与「内容问题」共用同一个计数说法
      ? `知识库侧 **未报内容问题**；另有 **1 条覆盖缺口**（库对该题材没有可依据的条款） ／ ${modelTxt}`
      : `知识库侧 ${kbStructuralN} 条（**结构化读数 ${kb?.state ?? '—'}/${kbN}**）`
        + (modelFailed
          // ⚠️ **模型侧没跑成时，不许把它折进那个算术式** —— 折进去会印成
          //    「模型侧 0 条」或「模型侧 6 条」，而真相是**这一侧根本没跑**。
          //    （自证 ⑭g/⑭g2 钉着这一条：含糊它 = 让人以为"模型看过了、没问题"。）
          ? ` ／ ${modelTxt}`
          : ` ＋ 模型侧 ${fromModel} 条`
            + (dedupN ? ` − 计入 ${total} 处（去重 ${dedupN}：两侧指向同一处 ＋ 库侧未并入的）` : '')
            + ` ＝ 本卡 **${total} 处**（**上限**：两轨重叠未判）`))) + candNote + '\n';
  // ★ 库侧明细缺失是**必须出声**的（2026-10-07）：否则读者会以为库侧真没报东西。
  // ★★ 2026-10-08：**解释必须按真实原因分支**。
  //   原先不分情形一律写「PRD §5.3.3 规定问题数 ≥3 时库侧只出分类汇总」——
  //   而实测那张图的 `issue_count` 是 **1**，压根不是 ≥3 ⇒ 一个 1 条的单子被用 ≥3 的规矩解释，
  //   查的人会往「库侧做了汇总」那个方向找，永远找不到。
  // ★★ 2026-10-08（第五批）：**报告链接按来源分档措辞**。
  //   为什么：`report_url` 可能是**飞书云文档**（人点得开），也可能是**本地 `.md` 路径**
  //   （人**点不开**）—— 引擎用 `report_url_kind` 如实标了是哪一种（见 `kbSideOf`）。
  //   把本地路径当链接贴给读者，就是库规说的「一个点不开的链接比空格更坏」：
  //   读者以为点开就有明细，点了什么都没有，还不会回头怀疑那句话。
  //   拿不到 kind（旧版旁挂）时**按形态兜底判**：`http(s)://` 才算链接，其余按本地路径说。
  // ★ 2026-10-09：`reportUrlOverride` 是**本仓自己建的那份合并报告**的链接（`merged_report.mjs`）。
  //   为什么要有它：库侧只在**它自己的** `issue_count >= 3` 时建 docx，而卡里那个数是
  //   `total`（含模型侧与库侧未并进的）—— 实测 6 vs 1 ⇒ 库侧不给链接，而按 PRD 该给。
  //   传进来时它就是**权威**：本仓建成了就用它，没建成传 null（照实说没拿到）。
  const _ru = reportUrlOverride || kb?.reportUrl || null;
  // ★★ 2026-10-14：`reportNote` 的分段要用「这一单会不会走汇总」→ 而 `summarized`
  //   又要用 `reportNote` 抠出的链接判 ⇒ **循环依赖**。解法：在 `_ru` 刚拿到时
  //   先按**等价判据**（≥3 且 `_ru` 是 http(s)）算一个先行量给它用；
  //   `summarized` 仍在下面按它自己的判据算（两处等价，改判据时一起改）。
  //   实测两轮才走对：① 直接用 `summarized` ⇒ TDZ 报错；
  //   ② 在 `reportNote` 处用 `_ru` 判、但 `_ru` 声明在其后 ⇒ 恒 false（链接前少一个空行）。
  const _willSummarize = total >= REPORT_LINK_MIN_ISSUES && !!_ru && /^https?:\/\//i.test(_ru);
  const _ruKind = kb?.reportUrlKind
    || (_ru ? (/^https?:\/\//i.test(_ru) ? 'feishu_docx' : 'local_path') : null);
  const reportRef = !_ru
    ? '（本次库侧未回报告链接）'
    : (_ruKind === 'local_path'
      ? `：\`${_ru}\` —— **这是本地文件路径，你点不开**；`
        + '要拿到可点开的明细，请让维护侧把该报告发成飞书云文档（`--write-report` 且发布成功时会给 docx 链接）'
      : `：${_ru}`);
  const gapNote = kbMissingDetail
    ? (kbN >= 3
      ? `\n⚠️ 知识库侧另有 **${kbGap} 条**未并进本卡：PRD §5.3.3 规定问题数 ≥3 时库侧只出分类汇总`
        + `，逐条明细在库里${reportRef}`
        + '；**与模型侧的重叠未判 ⇒ 上面那个总数是上限**。'
      : `\n⚠️ 知识库侧的结构化读数是 **${kbN} 条**，本卡只并进 **${txtN ?? 0} 条** —— `
        + '**未达 3 条，不适用 PRD §5.3.3 的「只出分类汇总」**（别往那个方向查）。'
        + `逐条明细在库里${reportRef}`
        + '；**与模型侧的重叠未判 ⇒ 上面那个总数是上限**。')
    : '';
  // ★ 覆盖缺口要单独说清含义（2026-10-07 起；★ 2026-10-15 按 Owner 新口径**整段改写**）。
  //
  //   ★★ 2026-10-15（Owner：「**没有命中就是 pass**，按照 prd 的一句话结论走，
  //      你不要自己定义」）——
  //     · 这一档**卡上只出一句 PASS**（§5.3.1 的一句话结论），覆盖缺口的解释**不上卡**
  //       （Owner 2026-10-13 的裁定不变）；
  //     · 这一段因此**只走 `internalNotes`**（模型上下文 ＋ 会话记忆）——
  //       对方追问「库里到底覆盖没覆盖这个题材 / 这个 PASS 算不算证明合规」，守衡答得出来。
  //     ⚠️「未命中 ≠ 合规」这句边界**一个字都不许丢**：PASS 是「**未发现已知底线风险**」，
  //       不是「已证明合规」；这句是这一单里唯一拦住「把没查到念成没问题」的话。
  //     ⚠️ 原先这里还写着「**上面那 1 条「需人工确认」就是它**」—— 那句话随 `covEntries`
  //       一起作废（卡上已经没有那个数了），留着就是**说假话**（本文件的 ⑭d 那一组判据钉着）。
  //     ⚠️ 文字与「一条条目都没有」那条早退路**同一份**（`coverageGapNote()`）——
  //       抄成两份必然漂移。
  const covNote = kb?.coverageGap ? coverageGapNote(kbN) : '';
  // ★ 库侧没读数：**这一句是硬要求**（2026-10-07，Owner 同意）。
  //   没有它，读者会把"库没参与"读成"库说没问题"，而这两件事的下一步完全不同。
  const noReadNote = kbNoReading
    ? `\n⚠️ **本次知识库侧没有读数**（链没跑到引擎 / 机读旁挂没落 —— 库忙、层闸门红、或没走 `
      + '`review_run.sh`）⇒ 上面这些条目**只来自模型侧、无库内依据**，'
      + '**不得当通过依据**，也**不得据此当 PASS**（本单**不能算放行**）。'
      + '下一步：先确认库侧为什么没跑成，再重审这一单（**补素材无用**）。'
    : '';
  // ── ★ 2026-10-09：**PRD §5.3.4 的报告链接门槛（≥3）** ────────────────────────
  //
  //   规则是 Owner 2026-10-08 定的原话：「我在飞书侧 @守衡 提问后，双轨并行
  //   （知识库+模型），**双轨按照 PRD ≧3 个问题输出报告链接到飞书文档**」。
  //
  //   触发条件**必须**是卡里那个数（`total`）—— 不是 `stats.merged`（那只是「并进来几条」），
  //   也不是「库侧明细抠不出来」（`kbMissingDetail`，上面 `gapNote` 用的那个）。
  //   实测一单里有三个数：`total`=12（卡里写的）／`stats.merged`=7（并进来的）／
  //   旁挂 `issue_count`=5（库侧自己的）。**门槛只能挂在人看到的那个数上**。
  //
  //   门槛值与库侧**同名同口径**（`kb/l7/review-engine/core/feishu_publish.py`：
  //   `REPORT_LINK_MIN_ISSUES = 3`，PRD §5.3.4 / §8.3 / §17 三处一致）。
  //   两处各写一遍会各自漂移，所以这里写死并在断言里对住「≥3 才有这一行」。
  //
  //   ★ 拿不到链接时**如实说、并说清是哪一种拿不到** —— 不许编一个链接，也不许默默不给
  //     （库规：「一个点不开的链接比空格更坏」；而「没说为什么没有」比两者都坏）。
  // ★★ 2026-10-14（Owner 第二次裁定）：这个前导换行**按路径分**，两种形状不一样：
  //
  //   · **≥3 汇总**（`summarized`）：汇总行**紧接**结论行（只一个空行，来自拼装处），
  //     而汇总行与链接**之间**要有空行 ⇒ 这里给 `\n\n`。
  //   · **<3 逐条**：此时 `bodyText` 是逐条块（末尾已有换行）⇒ 这里只需 `\n`，
  //     给 `\n\n` 会让「最后一条 → 链接」多出一个空行。
  //
  //   ⚠️ 我上一轮把它一刀切成 `\n\n`，把两条路都写坏了：
  //     ≥3 那一侧汇总行被空开（Owner 当场指出的就是它）、
  //     <3 那一侧条目与链接之间多空一行。
  //   ⚠️ 它引用 `summarized`，而 `summarized` 要用 `reportNote` 抠出来的链接判 ⇒
  //     两者互相依赖。**声明次序必须是这样**（实测踩过两轮）：
  //       `_ru` → `reportNote` → `linkLine` → `hasReportLink` → `summarized` → 用 `summarized`。
  //     第一版把 `summarized` 放在 `reportNote` 后面 ⇒ `Cannot access 'summarized' before initialization`；
  //     第二版改成在 `reportNote` 处先按 `_ru` 算个等价量 ⇒ 又因 `_ru` 还没声明而恒为 false。
  //     ⇒ 唯一的正解是**把 `_ru` 那一段上移到 `reportNote` 之前**（已做）。
  const reportNote = total >= REPORT_LINK_MIN_ISSUES
    // ★★ 2026-10-19：`→ 查看完整问题清单与修改建议：`（16 字）压成 `→ 完整清单：`（7 字）——
    //   链接指向的就是完整清单，前半句是同一件事的复述；PRD §17 第 6/7 行只要求「报告链接」。
    ? `${_willSummarize ? '\n\n' : '\n'}→ 完整清单：`
      + (!_ru
        ? '**本次未拿到报告链接** —— 库侧这一单没生成完整报告（`issue_count < '
          + REPORT_LINK_MIN_ISSUES + '` 时它按 PRD 不生成；本卡的问题数 `total` 含**模型侧**'
          + '与**库侧未并进的**条目，两者口径不同）。上面逐条已是本卡能给的完整清单。'
        : (_ruKind === 'local_path'
          ? `\`${_ru}\` —— **这是本地文件路径，你点不开**；`
            + '要拿到可点开的明细，请让维护侧把该报告发成飞书云文档。'
          : _ru))
    : '';
  // ★★ 2026-10-09（第二次修）：**报告链接提到抬头下面**，不再放在 8 条逐条之后。
  //
  //   病灶（Owner 当场反馈「还是没修复」）：链接**确实进了卡**，但它在结论块的最末尾 ——
  //   而那一块在飞书里是**可收起**的，8 条清单一铺开，链接就落到折叠区底部。
  //   Owner 的座位上看就是「**没有报告链接**」。
  //   报告链接是**要人去点的动作**（与结论行同级），不是逐条清单的脚注。
  //   判据也简单：一个必须被点开才看得见的链接，等于没有链接。
  // ── ★★ 2026-10-09：**命中原文 + 飞书直链**放进卡片正文 ──────────────────────
  //   位置：**在逐条清单之前**（结论行与读数之后）。
  //   为什么不是放末尾：同一天已经栽过一次 —— 报告链接原先放末尾，而那一块在飞书里是
  //   **可收起**的，8 条清单铺开就把链接压进折叠区，Owner 的座位上看就是「没有链接」。
  //   ⇒ **一个必须点开才看得见的东西，等于没有**。命中原文与直链是 Owner 点名要的，
  //     必须落在会被看到的位置。
  // ★★ 2026-10-09 晚（Owner：「业务同事都看不懂」）：**这块从卡上撤下来，改放报告。**
  //
  //   原先它被直接印进卡片正文。实测业务同事看不到 —— 因为它的内容是
  //   `BM25 205.8807 ｜ 飞书直链：取不到直链 ｜ source_sha256 77ac3d5f…`：
  //   **那是检索过程的读数，不是「哪里有问题、怎么改」。**
  //   判据（与 §5.3 同一条）：**卡上只放「让人能决定下一步」的东西。**
  //
  //   「搬是搬，砍是砍」：这些读数**一条不丢** —— 由 `hitsBlock` 原样返回，
  //   由 `merged_report.renderMergedReportMd` 放进报告的「附录：检索读数」。
  const hitsNote = '';   // ← 卡上不再印（保留这个名字，免得到处改；真正的搬运在 hitsBlock）
  const hitsBlock = kbHitsBlock || null;
  // ══════════════════════════════════════════════════════════════════════════
  // ★★ 2026-10-09（Owner 第三次追问后的**根因修正**）：**≥3 时只出分类汇总 + 报告链接**
  // ══════════════════════════════════════════════════════════════════════════
  //
  //   PRD §5.3.3 的原文（库侧权威实现 `kb/l5/p0_fastpath.py:391`）：
  //     ```
  //     if n >= 3:
  //         # PRD §5.3.3「≥3 个时只输出分类汇总 + 报告链接」
  //         L.extend(_summary_lines(findings))
  //         L.append("→ 查看完整问题清单与修改建议：%s" % report_ref)
  //     ```
  //
  //   而这里**从来不分条数**，永远把全部条目平铺在卡上 ⇒
  //     · Owner 看到「7 个问题都是平铺」—— **那本身就违反 PRD**；
  //     · 「链接看不见」只是**症状**：条目全在卡上，链接被挤到最后、又被收起。
  //   我此前三次修复都在治症状（挪链接位置），**第一次就没读懂这一条**。这是根因。
  //
  //   现在与库侧**同一套判据、同一个常数**（`REPORT_LINK_MIN_ISSUES`）：
  //     ≥3 ⇒ 卡片只出「· <大类>类问题：N 个」＋ 报告链接；逐条清单进报告
  //     <3 ⇒ 逐条平铺（1–2 条走逐条输出，PRD 就是这么定的）
  // ★★ 2026-10-09 晚（安全网，必须与上面那条一起看）：
  //   **只有「报告链接真的拿得到」时，才允许把逐条清单收进报告。**
  //
  //   为什么必须：≥3 时卡上只剩汇总行 —— 而汇总行**不含任何可执行内容**。
  //   若报告没建成（实测那一单：日志里既没有 `📄 合并报告已建` 也没有 `⚠️ 没建成`，
  //   卡上也没看到链接那一行），读者拿到的就是**「平台与促销类问题：2 个」＋一个空的链接位**
  //   —— 比改动之前（至少还有 7 条逐条）**更没法用**。
  //   所以：**拿不到可点的链接 ⇒ 退回逐条平铺**（宁可长，不可空）。
  //   判据看的是 `reportNote` 里到底有没有一个可点的链接，**不是** total 够不够。
  // ★★ 2026-10-14：**去掉 `^` 锚定** —— 这是今天第四处「判据绑死了别处的形状」。
  //   病灶：这一行原来写 `^→ …`，而它抠的是**拼装之前**的 `reportNote` 字符串 ——
  //   那个字符串自己当然以 `→` 开头。可我一旦把拼装次序改回 PRD
  //   （`${line}\n${bodyText}${reportNote}`），这行代码读的还是 `reportNote` 本身、
  //   并没变，**但 ⑰f 与它的断言随之改动时极容易连带踩到**；且 `reportNote` 的首字符
  //   是 `\n`（它本来是拼在后面的），`^` 在多行模式下要求 `→` 顶格 —— 一旦拼装微调
  //   （加一个前置换行/空格），`^` 就抠不到 ⇒ `hasReportLink=false` ⇒ 判成「没拿到链接」
  //   ⇒ **报告不建、卡上写「本次未拿到报告链接」**（实测 Z15 就是这么变红的）。
  //   ⇒ 只认**行内那一句**，不管它在第几行、前面有没有东西。
  // ★★ 2026-10-19：文案压短成 `→ 完整清单：`，**这处回读正则必须一起改**
  //   （改了输出不改解析 ⇒ `hasReportLink` 恒 false ⇒ ≥3 的单子会退化成逐条平铺，
  //    实测一次性把 BLOCK ≥3 的卡从 100 字级撑到 700+ 字）。两种写法都认，兼容历史文本。
  const linkLine = (reportNote.match(/(?:→ 完整清单|→ 查看完整问题清单与修改建议)：(.*)$/m) || [])[1] || '';
  const hasReportLink = /^https?:\/\//.test(linkLine.trim());
  // ★ 权威定义：≥3 **且** reportNote 里抠出来的确实是 http(s) 链接。
  //   与上面 `_willSummarize`（按 `_ru` 直接判）**等价** —— 两处都在，是因为
  //   `reportNote` 的拼装要用到它、而它又要用 `reportNote` 抠出的链接；
  //   改判据时**两处一起改**（这是本文件里我为数不多允许「同一件事两处」的地方，
  //   代价写在这里，免得下一个人改一处就漂移）。
  // ★★ 2026-10-19（PRD §17 + §5.3.4）：**SUGGEST 不做分类汇总** —— 它的输出格式是
  //   「逐条列建议 + 不阻断说明」，档位是「任意」（不分 ≥3 与 1-2）。所以哪怕有 6 条建议，
  //   也**逐条列出来**（每条 ≤150 字，per-item，判据 `prd17.scopeOf('PASS+SUGGEST')` 已钉）。
  const summarized = total >= REPORT_LINK_MIN_ISSUES && hasReportLink
    && prd53StateOf(state) !== 'PASS+SUGGEST';
  // ★★ 2026-10-14（Owner：「审核结论中 1，2...每条之间需要空一行的 …… 都要跟 prd 对齐」）──
  //
  //   PRD §5.3.2 / §5.3.3 的逐字形状（回源飞书 PRD wiki rev 36 ＋ 本地 `kb/.work/prd.md`，
  //   两份一致；下面 `␤` 是空行）：
  //
  //       【审查结论：REVIEW】共发现 2 处需人工确认。
  //       ␤
  //       1.【合规-医疗宣称】……
  //         原因：……
  //         依据：……
  //       ␤
  //       2.【消费者安全-使用姿势】……
  //       ␤
  //       建议转 @法务 @医学顾问 复核。
  //
  //   ⇒ **结论行之后一个空行 · 每条之间一个空行 · 动作行之前一个空行**。
  //
  //   改前实测的坏形状（不是「一条空行都没有」这么简单，而是**空行数不对**）：
  //     · 2 条：结论行→第 1 条**没有**空行；第 2 条之后**三个**空行才到动作行；
  //     · ≥3 汇总：链接与动作行之间**两个**空行。
  //   根因是三个空行来源叠在一起（`renderMergedItem` 结尾自带的空行、`items.join('\n\n')`
  //   的分隔、拼装处的 `\n\n`）—— 各加一段就多一段。
  //
  //   ⇒ 口径：**条目在这里先收尾成一个整块**（去掉各自尾随的空行），
  //     块间与块后的空行由**拼装那一处**统一给。空行只有一个来源，就不会再叠。
  const itemBlocks = items.map((b) => String(b ?? '').replace(/\n+$/, ''));
  // ★★ 2026-10-19（PRD §5.3.3「单条问题：描述 ≤50 字，原因 ≤50 字，修改建议 ≤30 字」＋
  //   位置/依据/语言三条格式硬约束）：**逐条**量**卡面实际渲染出来的那一块**，
  //   不是量内部字段 —— 要量的是「读的人看到的那段字」。
  //   ⚠️ 只读数、不阻断：`修改建议 ≤30 字` 与 Owner 2026-10-17「建议都写全」直接冲突
  //      （真单建议实测 372 字），冲突登记在 `kb/l7/registry/prd533-constraints.yaml::conflicts`。
  //   ⚠️ `items` 是**已渲染的块**（上面 `items = list.map(renderMergedItem)`），
  //      取字段要用**原始条目** `list[i]` —— 第一版写成 `items.map((f) => f.location)`，
  //      结果位置恒空、描述恒 0（判据会把它当成「都合规」）。
  const _prd533 = list.map((f, i) => {
    const blk = itemBlocks[i] || '';
    const pick = (label) => {
      const m = new RegExp(`\\*\\*${label}\\*\\*：([^\\n]*)`).exec(blk);
      return m ? m[1] : '';
    };
    return {
      index: i + 1,
      ..._prd533CheckItem({
        description: String(f?.description || f?.kb?.description || descriptionOf(f).text || ''),
        reason: pick('原因'),
        // 卡面那一格叫「建议」；报告那一版叫「修改建议」——两种标签都认
        advice: pick('建议') || pick('修改建议'),
        // 卡面把位置印在首行（`1.【类-子类】位置 —— 来源`），没有 `**位置**：` 那一格 ⇒ 回落到字段
        location: pick('位置') || String(f?.location ?? ''),
        basis: pick('依据') || pick('依据文档链接'),
        // ★★ 2026-10-20：把**素材模态**交给断言 —— 位置要与模态对得上
        //   （图片单里印「正文第 N 段」是缺陷，不是"另一种写法"）。
        modality,
      }),
    };
  });
  for (const r of _prd533) {
    if (!r.ok) console.log(`[prd533] ⚠ 第 ${r.index} 条：${_prd533Reading({
      description: '', reason: '', advice: '', location: r.location.value, basis: '' }) ? '' : ''}`
      + `字段 ${r.fields.rows.filter((x) => !x.ok).map((x) => `${x.label} ${x.chars}/${x.limit}`).join('、') || '—'}`
      + `｜位置 ${r.location.ok ? 'OK' : `「${r.location.value}」不在三模式内`}`
      + `｜依据 ${r.basis.ok ? 'OK' : (r.basis.banned.length ? `禁词 ${r.basis.banned.join('/')}` : '非《文档名》第X条且非规则ID')}`
      + `｜语言 ${r.language.ok ? 'OK' : r.language.hits.join('/')}`
      + (r.locationModality && r.locationModality.skipped === false && !r.locationModality.ok
        ? `｜⚠️ 位置与模态不符（${r.locationModality.modality} 应写「${r.locationModality.expected}」）`
        : ''));
  }
  // ★★ 2026-10-15（Owner 那次给的**表行**逐字格式里带着「逐条问题」这一行）——
  //   **已在 2026-10-21 撤销**：Owner 拿正确模版（`docx/CvIldNhUSoxv7DxpzwdcKUcjnfr`）
  //   逐行对过之后，这一行在 PRD §5.3.2/§5.3.3、知识库引擎 `render_summary` 与那份模版
  //   里**都不存在**（详见证在哪、改动落在哪，见下面 `bodyText` 那一段的注释）。
  //   这里留一行字是为了「查得到它曾经存在过」，不是还留着那条口径。
  // ★★ 2026-10-19（Owner：「所属类别/所属子类」统一到 A3 12 类）：
  //   **逐条路（<3）不再追加「按 11 类」那一行** —— 逐条首行现在印的就是 A3
  //   （`【所属类别-所属子类】`），再补一行就是同一件事说两遍。
  //   汇总路（≥3）的分类行本身就是 A3，也不追加第二行。⇒ 这条附加行整体停用。
  //   ⇒ 那句附加汇总**已整体删掉**（连函数一起），不再有第二套计数口径；卡面汇总只由
  //     `categorySummary()` 产出，判据在 ㉔（盯的是这个活函数）。
  const taxLine = '';
  // ★ 2026-10-19：全部条目都因**缺依据**被略掉时，卡上不能只留一个空清单 ——
  //   如实说一句（不编依据、也不假装没问题）。
  const _allDropped = _shownN === 0 && _noBasisN > 0;
  const _droppedNote = _allDropped
    // ★★ 2026-10-20：**改掉一处误引** —— 原先写「按 PRD §5.3.3 不列明细」，
    //   而 §5.3.3 讲的是「问题数 ≥3 时只出分类汇总」，与「这条给不出依据」无关。
    //   引用错条款比不引用更坏：读者会去 §5.3.3 找一条不存在的规矩。
    //   真实口径是 Owner 2026-10-19 那句「依据须要能支撑问题」⇒ 没依据的条目不列。
    ? `（本次 ${_noBasisN} 条线索均**未给出依据**，按「每条要有依据」不列明细；是否需要处理请人工判断）`
    : '';
  const bodyText = summarized
    // ★★ 2026-10-21（Owner 给了**正确的模版** `docx/CvIldNhUSoxv7DxpzwdcKUcjnfr`，
    //   逐行比对我们那份输出：「【审查结论：REVIEW】…」下面**多了一行 `逐条问题`**）
    //   ⇒ **这一行删掉。** 它是 2026-10-15 Owner 给**表行样例**时带进来的，之后被当成了格式件。
    //
    //   三条独立证据都说它不在格式里（不是偏好，是回源）：
    //     ① PRD §5.3.2 / §5.3.3 的 ≥3 逐字形状：结论行 ␤ `· XX类问题：N 个` ␤ 链接 ␤ 动作行
    //        —— 结论行与汇总行之间**没有任何小标题**（本地 `PRD/feishu/内容审查Agent-PRD-v1.0.md` §5.3.2）；
    //     ② 知识库侧权威产者 `kb/l7/review-engine/core/review_engine.py::render_summary`
    //        的 ≥3 分支也**不印**它（2026-10-21 实跑，读数见 `PMO/守衡-审查报告对齐正确模版-20261021.md`）；
    //     ③ Owner 这次给的模版里同样没有（`内容审查报告` ␤ 结论行 ␤ `· …类问题：N 个`）。
    //   ⚠️ 上一版注释曾写「知识库侧也印它」—— **那是错的**（②），本条即按那条错判据的回滚。
    //   它原先还捎带说过「省 4 个字去别处省」：现在不是字数问题，是**模板对不上**。
    ? categorySummary(_cardList, total)
    : (itemBlocks.length ? itemBlocks.join('\n\n') : _droppedNote) + (taxLine ? '\n\n' + taxLine : '');
  // ══════════════════════════════════════════════════════════════════════════
  // ★★ 2026-10-13（Owner 裁定）：**库侧/模型侧的口径读数与解释不上卡，只留在守衡的记忆里**
  // ══════════════════════════════════════════════════════════════════════════
  //
  //   Owner 原话（三条里第 1、2 条）：
  //     「输出到飞书群包含知识库侧+模型侧的文字，**不要展示在卡片上**，我问的时候，你要能回答」
  //     「类似以下的文案都去掉：知识库侧 未报内容问题…／模型侧 7 条… ／ ℹ️ 知识库侧给了
  //       覆盖缺口（`coverage_not_covered`）… ／（问题数 8 ≥ 3 ⇒ 按 PRD §5.3.3 只出分类汇总…）」
  //
  //   为什么这一整族都搬走（`tally`/`gapNote`/`covNote`/`noReadNote`/`candNote`/汇总页脚）：
  //     它们是**我们自己核对用的口径读数** —— 讲的是「这一单里哪一侧说了话、有几条没并进来、
  //     与 PRD §5.3.3 是什么关系」。对群里的人，那是**零可执行信息**；
  //     而 PRD §5.3.3 给 ≥3 的单子规定的卡面只有四样：结论行 · 分类汇总 · 报告链接 · 动作行。
  //
  //   ★ 但**一个字都没丢**（搬是搬，砍是砍）—— 它们原样从 `internalNotes` 出去，
  //     由 `agent.mjs` 接进 `chainBlock`（= 模型的上下文 + **会话记忆**）：
  //     对方追问「知识库侧报了几条 / 为什么说是覆盖缺口」，守衡答得出来。
  //     ⚠️ 它们**不许**再回到 `block` —— 卡片与报告都是 `block` 渲染的。
  const summaryFootnote = summarized
    ? `（问题数 **${total} ≥ ${REPORT_LINK_MIN_ISSUES}** ⇒ 按 PRD §5.3.3 只出分类汇总，`
      + '逐条清单与修改建议在报告里；1–2 条时才在卡上逐条平铺。）'
    : '';
  // ══════════════════════════════════════════════════════════════════════════
  // ★★ 2026-10-13：**P0 快路那条边界改由代码给**（原先只有模型原话里那一份）
  // ══════════════════════════════════════════════════════════════════════════
  //   为什么必须补：Owner 同一天要求「模型原话那一组从卡上整组去掉」（见 `envelope.mjs`
  //   的 autoCard）。而这条边界**只出现在模型原话里** —— 原话一走，卡上就没有任何东西
  //   说得出「这是红线拦截、**没有跑过专项审查**」了。
  //   而这句话不能丢，它是 Owner 2026-10-12 要求恢复的三样之一
  //   （`agent.mjs` 原位注释记着：「逐条明细 ＋ 页脚『本结论为 P0 红线拦截…』—— 三样都在」）：
  //   少一句，读卡的人就会把一次**确定性匹配**当成「整条链审过了」。
  //   措辞与那一版同源（08:56 那张卡的卡脚），只把模态说全（图/视频/产品宣称），
  //   因为 P0 快路对三类素材走的是同一条路。
  const p0Boundary = kb?.source === 'p0_fastpath'
    ? '本结论为 **P0 红线拦截**（确定性匹配，**未跑**专项审查、层前置与评审链），'
      + '**不是 PASS 依据**；若素材属图片 / 视频 / 产品宣称等模态，**仍需转对应专项复核**。'
    : '';
  // ⚠️ `candNote` 已经拼在 `tally` 里面（见上面那一行 `+ candNote +`），别再列一次。
  // ★★ 2026-10-13（Owner：「整个都隐藏，不要展示在卡片上」）：**P0 快路那条边界也并进这里**。
  //   它原先是卡脚（`boundary` 格），而那一格现在整格作废 ⇒ 不挪过来就是**静默消失**
  //   （「未跑专项审查 / 仍需转对应专项复核」这句话必须还在，只是不上卡）。
  const internalNotes = [tally, gapNote, covNote, noReadNote, p0Boundary,
    summaryFootnote ? `\n${summaryFootnote}` : '']
    .map((x) => String(x ?? '').trim())
    .filter(Boolean).join('\n').trim();
  // ★★ 2026-10-19（Owner：「prd 中 17 写了的结论模版字数限制，你同步知识库了吗？」）：
  //   每张卡**自带一行 PRD §17 的读数**（实测字数 / 上限 / 是否超），真源
  //   `kb/l7/registry/prd17-limits.yaml`（sheet XWnpiN rev 96）。**只读数、不阻断**。
  //   ⚠️ `block` 原先**只在 return 里内联拼装** ⇒ 要量它就得先提出来（改这里，别再拼第二遍）
  // ── ★★ 2026-10-19（截断「出声」这件事**只能走日志与记录，不能上卡**）────────────
  //   我先按「上卡明示」写了一版（`⚠️ 本卡有 N 处文字按字数压缩…`），当天被两条既有判据
  //   当场打红，**说明是我错了，不是判据老了**：
  //     · `test_agent V6`：那一格里的 `⚠️` 是**禁词**（Owner 2026-10-15：
  //       「按照 prd 只出结论，不要自己加其他内容」；2026-10-16 还清过 12 格存量）；
  //     · `test_agent Z55`：BLOCK ≥3 整条 112 字 > PRD §17 上限 100 ——
  //       卡面**每多一行都要付字数预算**，而那一档本来就没余量。
  //   ⇒ 截断的「出声」改为三处，都不占卡面预算：
  //     ① 日志 `[agent] ✂ …`（**立刻**看得见，运维面）；
  //     ② 逐条记录 `truncated.*` ＋ `card_conformance`（落盘，**问的时候答得出**）；
  //     ③ 源头重试（`model_side.mjs` 超字数 ⇒ 让它自己重写一遍，尽量不让截断发生）。
  //   ⚠️ 若 Owner 要卡面上也看得见，那不是改这里 —— 得先改 2026-10-15 那条「只出 PRD 结论」，
  //      并给 BLOCK/REVIEW ≥3 那两档腾出字数预算。**这是他的口径，我不替他改。**
  const _truncN = (Array.isArray(itemsMeta) ? itemsMeta : [])
    .filter((m) => m.reason_truncated || m.advice_truncated).length;
  if (_truncN) {
    console.log(`[agent] ✂ 卡面有 ${_truncN} 处按字数压缩（原因 ≤50 字 / 建议 ≤${ADVICE_MAX} 字）`
      + '—— 已记进逐条记录；卡面不印（Owner 2026-10-15：那一格只放 PRD 结论）');
  }
  let blockText = `${line}\n\n${bodyText}${reportNote}${hitsNote}`
    + `${bodyText ? '\n\n' : '\n'}${action}`;
  // ★★ 2026-10-19（Owner：「卡片上的清单链接有两个，**去掉上面的，保留下面的**」）——
  //   实测两张链接同指一份报告：守衡自己那行（`→ 完整清单：…`）＋ 库侧结论块里自带的
  //   `→ 查看完整问题清单与修改建议：…`。Owner 要保留**下面那条**（库侧的原措辞）。
  //   ⇒ 逐行扫：**只留最后一条**链接行，前面的删掉。
  //   ⚠️ 不是"删某个固定字符串"——将来谁改了措辞，这条去重仍然生效。
  blockText = dedupeReportLinkLines(blockText);
  // ★★ 2026-10-19（Owner：「**字数限制问题，为什么反复修？**」）——**出厂前核一遍整张卡**。
  //   上面每一处修复都只保证「某一行在压」；能保证「这张卡整体合规」的只有这一道。
  const _cardConf = cardConformance(blockText, { hasReport: _hasReportForCard });
  if (_cardConf.length) {
    console.log(`[card-gate] ⚠ 卡面不合规 ${_cardConf.length} 处：${_cardConf.join('；')}`);
  }
  // ★★ 2026-10-19（Owner：「最后的字数限制是针对**每一条问题**」）——
  //   逐条那几档（<3 条）量的是**每一条自己的块**；≥3 那两档没有逐条结构，量**整条消息**。
  // ★★ 2026-10-19（Owner 定的规则）：「输出格式里写了**逐条**的 ⇒ 按条量；没写的 ⇒ 整张卡」。
  //   由 `prd17-limits.yaml` 的 `format` 字段自动判（`scopeOf`），**不再由 `summarized` 猜**。
  const _prd17ScopeNow = _prd17ScopeOf(state, n);
  const _prd17 = _prd17ScopeNow === 'message' ? _prd17Check(state, n, blockText, 'message') : null;
  const _prd17PerItem = _prd17ScopeNow === 'per_item' ? _prd17Items(state, n, itemBlocks) : null;
  if (_prd17 && _prd17.limit != null && !_prd17.ok) {
    console.log(`[prd17] ⚠ 整条超 PRD §17 字数：${_prd17Reading(state, n, blockText)}`);
  }
  if (_prd17PerItem && _prd17PerItem.ok === false) {
    const worst = _prd17PerItem.perItem.filter((r) => r.ok === false)
      .map((r) => `第 ${r.index} 条 ${r.chars} 字（超 ${r.over}）`).join('；');
    console.log(`[prd17] ⚠ 逐条超 PRD §17 字数（每条上限 ${_prd17PerItem.limit}）：${worst}`);
  }
  return {
           line, total, kbGap, refused: false, coverageGap: !!kb?.coverageGap,
           kbNoReading, kbContentN, modelFailed, reportNote, summarized,
           // ★ 2026-10-19（Owner：「字数限制问题，为什么反复修？」）：**出厂闸的读数**。
           //   空数组 = 这张卡四条口径全合规；非空 = 哪一条超了。渲染时就打日志（不静默）。
           cardConformance: _cardConf,
           // ★ 2026-10-19（步骤 1）：逐条元数据（来源侧/回源能力/截断真相）。
           //   `merged_record.buildMergedRecord()` 消费它落盘；**别处不要再算一遍**。
           itemsMeta,
           // 报告清单、问题数与卡面必须使用同一批可见条目。
           displayItems: _cardList,
           // ★ 2026-10-19：PRD §17 字数读数（`limit: null` = PRD 没这一档，不判）
           //   汇总路 ⇒ `prd17`（整条消息）；逐条路 ⇒ `prd17Items`（**每条各一个读数**）
           prd17: _prd17, prd17Items: _prd17PerItem,
           // ★ PRD §5.3.3：每条问题逐字段（描述/原因/建议）＋位置/依据/语言的读数
           prd533: _prd533,
           // ★ 2026-10-14：**这一单转给谁**（旧编号 PRD §5.4 的 JSON 规范里就有 `next_owners`）。
           //   与 `action` 同一份读数 —— 卡上印的是它渲染出来的句子，下游（表行 / 报告）
           //   拿到的是结构化的那几个角色位。留痕用，不是第二份口径。
           nextOwners: must ? [] : routing.owners,
           routingSource: routing.source,
           routingVersion: routing.version,
           routingUnmatched: routing.unmatched,
           // ★ 卡上不印了 ⇒ 由这里原样交出去，报告把它放进附录（搬不是砍）
           hitsBlock,
           // ★ 2026-10-13：库侧/模型侧的口径读数与解释 —— **只走这里**（模型上下文 + 记忆），
           //   既不进卡片也不进报告正文。空串 = 这一单没有这类读数。
           internalNotes,
           // ★★ 2026-10-14（Owner：「修改建议的链接，预期放在『建议转』这行的上面，跟 PRD 对齐」）：
           //   **次序修回 PRD §5.3.2 / §5.3.3 的逐字次序**。回源核过飞书 PRD 正文
           //   （wiki `NB55wAq8liEOdKkquL2cgtPEnmg`，rev 36）与本地 `kb/.work/prd.md`，两份一致：
           //       结论行 → `· <大类>类问题：N 个`（分类汇总）→ `→ 查看完整问题清单…` → 动作行
           //   而这里原先写的是 `${line}${reportNote}\n${bodyText}` —— **链接被拼在汇总之前**
           //   ⇒ 群里看到的就是「链接 → 汇总」，与 PRD 相反（Owner 截图当场指出）。
           //   ⚠️ 2026-10-09 那次「链接提到抬头下面」的诉求**没有被推翻**：它要防的是
           //      「链接被埋在 8 条逐条之后、落进可折叠区」—— 现在的次序里 link 仍紧跟在
           //      汇总（≥3 时汇总只有 1–4 行）之后、逐条**之上**，两个诉求同时满足。
           //   ⚠️ 与库侧 `review_engine.render_summary` 同一次序（那边本来就是
           //      `_summary_lines` 再 `→ 查看完整问题清单`），两处不许再各写一份。
           // ★★ 2026-10-14：**分段空行只从这一处给**（PRD §5.3.2 的逐字形状）——
           //   结论行 ␤ 正文（逐条之间已由上面 `bodyText` 的 `join('\n\n')` 空开）␤ 动作行。
           //   拼装点原先写的是 `${summarized ? '' : '\n'}\n\n` —— 逐条那一路因此多出一个空行、
           //   汇总那一路则把「链接→动作行」挤成零空行。现在统一：
           //   `bodyText` 有内容就给一个空行，没有就不留孤立的空行。
           block: blockText };
}

/**
 * **覆盖缺口那条查证笔记**（只进记忆：**不上卡、不进报告正文**）。
 *
 * ★★ 2026-10-15（Owner：「**没有命中就是 pass**，按照 prd 的一句话结论走，
 *   你不要自己定义」）—— 这一档卡上只出 §5.3.1 的**一句话结论**，覆盖缺口的解释
 *   **没有地方上卡**（Owner 2026-10-13 的裁定不变）⇒ 它只走 `internalNotes`
 *   （模型上下文 ＋ 会话记忆），对方追问时守衡答得出来。
 *
 * ⚠️ **两个调用点必须逐字同一份**：`renderMerged` 的主路（有别的条目时）
 *   与「一条条目都没有」那条早退路。抄成两份必然漂移 —— 所以抽在这里。
 * ⚠️「未命中 ≠ 合规」那句边界**一个字都不许丢**：PASS 是「**未发现已知底线风险**」，
 *   不是「已证明合规」；这句是这一档里唯一拦住「把没查到念成没问题」的话。
 *
 * @param {number|null} kbN 库侧自己报的条数（结构化读数）
 * @returns {string}
 */
function coverageGapNote(kbN) {
  return `\nℹ️ 知识库侧给了 **覆盖缺口**（\`coverage_not_covered\`）：检索有命中，`
    + '但「既被规则引用、又达门限」的单元 0 条 ⇒ **库对该题材没有可依据的条款**。'
    + `库侧自己报的条数是 **${kbN ?? 0} 条** ⇒ 按 Owner 2026-10-15 口径「没有命中就是 PASS」，`
    + '本单结论行走 §5.3.1 的**一句话结论**。'
    + '⚠️ 这一条**不是发现了内容问题**，也不是「明细抠不出来」——它讲的是**覆盖**；'
    + '⚠️ 但它也不是合规证明：`issue_count=0` 只表示「**未发现已知底线风险**」，'
    + '不等于「已证明这个题材合规」——**未命中 ≠ 合规**，不得据此当合规依据。\n';
}

/**
 * ≥3 时的**分类汇总**（PRD §5.3.3 要的那一格）：`· <大类>类问题：N 个`。
 *
 * ★ 与库侧 `_summary_lines` / `_category_counts` **同口径**：按**大类**（`catFamily`）合并，
 *   不按子类 —— 子类太细，汇总就没意义了。
 * ★ 为什么必须给总数：汇总行加起来可能小于 `total`（库侧有明细没并进来时），
 *   那时只说分类会让人以为「就这么多」⇒ 多出来的那部分要有一行交代。
 *
 * ★★ 2026-10-13（Owner 裁定）：**页脚那句「（问题数 N ≥ 3 ⇒ 按 PRD §5.3.3 只出分类汇总…）」
 *   从卡上撤掉了** —— 它讲的是我们自己的口径规矩，对群里的人是零可执行信息
 *   （Owner 原话把它列进了「类似以下的文案都去掉」那一串）。
 *   它**没有丢**：原样落在 `renderMerged` 的 `internalNotes` 里（守衡凭它答追问），
 *   所以这个函数现在**只产出 PRD §5.3.3 要的那几行**，一句解释都不带。
 */
/** **A3 的兜底类名**（12 类里的第 12 个；真源 `kb/l3/registry/rule-taxonomy.json`）。 */
export const TAX_UNCLASSED = '未归类';

/** A3 的 12 类**展示顺序**（与注册表 `classes` 一致；读不到就只保证「未归类压最后」）。 */
export const TAX_CLASS_ORDER = [
  '合规与受监管宣称', '产品安全与高危使用场景', '商品信息与Listing准确性', '证据与实质证明',
  '推广与价格透明', '背书与披露透明', '品牌信任与声誉', '权利、肖像、隐私与AI',
  '平台与渠道政策', '北美本地化与标签要求', '母婴知识内容准确性', '未归类',
];

/**
 * 这一条的**所属类别**（A3 12 类）；盖不到 ⇒ `未归类`（兜底类，**不编**）。
 *
 * ★★ 2026-10-19（Owner：「所属类别/所属子类」统一到 A3 12 类）：
 *   改前卡面首行印 **A1 8 类词表**、汇总印 **A1/11 类**；现在两处都取 A3。
 */
export function taxonomyCategoryOf(f) {
  const x = (f && typeof f === 'object') ? f : {};
  const kb = _kbOf(x);
  // ⚠️ 三处都要看：库侧在 `kb.*`、P0 条目在顶层、**模型侧在 `model.*`**（`mergeFindings` 把
  //   两侧各自塞进 `kb` / `model` 两个子对象）—— 只读前两处，模型侧的分类会静默消失，
  //   卡上就永远是「未归类」（Owner 2026-10-19 报的就是这个）。
  const cat = String(kb?.taxonomyCategory || x.taxonomyCategory
    || x.model?.taxonomyCategory || '').trim();
  // ★ 纵深防御：**不在 12 类里的一律当没给**（模型可能写自造类名；老夹具/旁挂也可能带 A1 名）。
  //   宽松地照抄会把「自造的类」印上卡（实测 `· 自造的类类问题：1 个`）——那比「未归类」更坏。
  return (cat && TAX_CLASS_ORDER.includes(cat)) ? cat : TAX_UNCLASSED;
}

/** `<所属类别>-<所属子类>`（卡面逐条首行）；子类没有就只印类别。 */
export function taxonomyLabelOf(f) {
  const x = (f && typeof f === 'object') ? f : {};
  const kb = _kbOf(x);
  const cat = taxonomyCategoryOf(x);
  const sub = String(kb?.taxonomySubcategory || x.taxonomySubcategory
    || x.model?.taxonomySubcategory || '').trim();
  return (sub && cat !== TAX_UNCLASSED) ? `${cat}-${sub}` : cat;
}

/** 分类汇总的「未映射维度」桶名 —— 与库侧 `risk_category.UNMAPPED_BUCKET` **同一个词**。 */
export const DIM_UNCLASSED = '未标注维度';

/**
 * 优先级取不到真值时的**桶名**（不是档位）。
 *
 * ★ 为什么不干脆给 P1：`P0 只由规则红线给`、P1 也有它的口径 —— **编一个档位**是冒充读数，
 *   而留 `—` 是让 Owner 读成「漏填」。⇒ 印一个**说得清楚自己是什么**的词：未分级。
 */
export const PRIORITY_UNSET = '未分级';

/** PRD §5.3 的四维**顺序**（并列时的次序；不是词表的第二份 —— 词表在 `risk-category-policy.json`）。 */
const DIM_ORDER = ['合规', '消费者安全', '产品描述', '措辞表达'];

export function categorySummary(list = [], total = null) {
  // ══════════════════════════════════════════════════════════════════════════
  // ★★ 2026-10-19（Owner 逐字：「问题数量大于或等于3个时，要有分类汇总
  //    『· 合规类：X 个 · 消费者安全类：X 个 · 措辞类：X 个』…… 查看卡片所有的回复
  //    必须跟 PRD 5.3 对齐」）—— **这一格从 11 类回退到 PRD 四维，形状也照 §5.3.4。**
  //
  //   为什么必须回退（两条都是实测，不是偏好）：
  //     ① **11 类在模型侧条目上根本盖不上章**（`stamp_taxonomy` 只认规则表里的 rule_id）。
  //        真单（报告 `D2yidl8QboNhqDxEfxwcpR6Dnfc`，4 条全是模型侧/外部标准）⇒
  //        卡上只剩 `· 未归 11 类问题：4 个` 一桶 ⇒ **分类汇总退化成常数**：
  //        读卡的人拿不到任何分布，比「分组不准」更坏。
  //     ② PRD §5.3.4 的 ≥3 样张逐字就是四维那一行（2026-10-19 对着 PRD 正文核过）。
  //
  //   ⚠️ 口径冲突已摆明：2026-10-17 Owner 曾签「把卡片的分类汇总行改成 11 类」
  //      （登记件 `fix_20261017_card_summary_11class`）——**本次以 PRD §5.3 为准**，那条登记已在
  //      `report-output-contract.yaml::fix_20261019_card_summary_back_to_dimension` 里标注回退。
  //      12 类**没有消失**：每一条的首行标签印的就是 A3（`<类>-<子类>`），报告也不再另起一段
  //      汇总（Owner 2026-10-19：「执行里面去掉附录，不要自己加东西」）。
  //
  //   形状（Owner 2026-10-19 第三次给的格式）：**每类一行**、`· <维度>类问题：N 个`；
  //   顺序：固定四维次序（合规 → 消费者安全 → 产品描述 → 措辞表达）→ 「未标注维度」桶**压最后**。
  // ★★ 2026-10-19（Owner：「所属类别/所属子类」统一到 A3 12 类）：
  //   汇总的轴从「A2 四维」换成 **A3**（`taxonomyCategory`）—— 与逐条首行、规则行、报告同一套；
  //   盖不到（模型侧条目、反例/案例层 sc-…、覆盖缺口）⇒ 落 **`未归类`**（12 类的兜底类）。
  const counts = new Map();
  for (const f of list) {
    const k = taxonomyCategoryOf(f);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const rank = (k) => {
    if (k === TAX_UNCLASSED) return 99;                 // 兜底压最后
    const i = TAX_CLASS_ORDER.indexOf(k);
    return i < 0 ? 50 : i;
  };
  // 顺序照 12 类注册表的固定次序（不按条数降序：那样两次运行的顺序会对不上）
  const entries = [...counts.entries()]
    .sort((a, b) => (rank(a[0]) - rank(b[0])) || String(a[0]).localeCompare(String(b[0])));
  const rows = [];
  if (!entries.length) {
    rows.push('·（本次没有并进任何逐条）');
  } else {
    // ★★ 2026-10-19 第三次（Owner 逐字：「按照下面的格式优化，**目前是写的一行**」）：
    //   **每类一行**、写法 `· <维度>类问题：N 个`（上一版那行「一行装完」作废）。
    //   行与行之间**不空行**（Owner 2026-10-14：「问题大于等于3个 …… 不空行的」）。
    //   顺序仍是固定四维次序（合规 → 消费者安全 → 产品描述 → 措辞表达 → 未标注维度）。
    // 兜底类写 `· 未归类问题：N 个`；真类写 `· <类名>类问题：N 个`（Owner 2026-10-19 的格式）
    for (const [k, n] of entries) rows.push(`· ${k === TAX_UNCLASSED ? k : k + '类'}问题：${n} 个`);
  }
  const n = total ?? list.length;
  if (n > list.length) {
    // ⚠️ 这一行**必须留**：没有它，读者把分类行加起来会小于抬头那个数
    //   （实测 19:08 那单：抬头 12、分类只有 7）—— 那是「卡内算术不闭合」，
    //   比多一句话坏得多。它只说「还有 N 条在哪」，不下口径解释。
    //   ⚠️ 它是**另一行**（不并进汇总行）：并进去会破坏 `· X类：N 个` 的可解析形状。
    rows.push(`· 另有 ${n - list.length} 条（明细在报告里）`);   // 2026-10-15 Owner 格式：不加粗
  }
  // 汇总行**紧挨着**输出（不空行）—— Owner 2026-10-14：「问题大于等于3个 …… 不空行的」
  return rows.map((r) => r.replace(/\n+$/, '')).join('\n');
}


/* ═══════════════════ 运行入口（必须在**文件末尾**）═══════════════════
 * ★ 2026-10-06 踩过：它原先夹在文件中间，而后加的 `COVERAGE_CATEGORY` 是 const ——
 *   运行块先执行 ⇒ **TDZ 报错**（Cannot access before initialization）。
 *   一个自证脚本自己崩掉、连断言都没跑到，比断言写错更糟。
 */
if (process.argv[1] && process.argv[1].endsWith('dual_track.mjs') && process.argv.includes('--selftest')) {
  process.exit(selftest() || selftestExtract());
}

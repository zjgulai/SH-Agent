/**
 * routing.mjs —— **按问题方向把 REVIEW 转给对应专业团队**（PRD §9 / §5.3.2）
 *
 * ── 这件事原先错在哪（Owner 2026-10-14 报）
 *
 *   PRD §5.3.2 逐字写着（两处，1-2 条与 ≥3 条各一次）：
 *
 *       建议转 @法务 @医学顾问 复核。
 *
 *   §9 也写「REVIEW 自动转**对应**专业团队（法务、医学、专家、北美）」，
 *   §15 验收项「REVIEW 可转对应法务/医学/专家/北美」。
 *
 *   而守衡发出去的是 `建议转 @内容治理负责人 复核。` —— 一个**硬编码常量**
 *   （`dual_track.mjs` 的 action 行），它有两个毛病：
 *     ① 收件人**不是** PRD 那四个团队里的任何一个；
 *     ② 它**不随问题方向变** —— 法务类、医学类、本地化类问题，转给同一个人。
 *
 *   `PMO/守衡-报告链接门槛-20261009.md` 曾写「块尾那行动作行**不动**」，理由是
 *   「那是 PRD §5.3 的收尾，改它会把格式契约打破」。**那半句判断是错的**：
 *   格式契约要保的是「## `建议转 … 复核。`」这个**句式**，而 PRD 那句里的收件人
 *   本来就该由问题方向决定。保住句式、修好收件人，两者不冲突
 *   （`prd53.mjs::conforms` 只核**结论行**「共发现 N 处…」，不核这一行）。
 *
 * ── 路由从哪来：库里的真源，不是本文件的常量
 *
 *   `kb/l7/review-engine/knowledge-base/routing-policy.json`
 *     `roles`    角色位收敛名（法务 / 医学顾问 / 专家 / 北美同事 / 产品负责人 / 渠道负责人 …）
 *     `rules`    按**问题方向词**匹配 ⇒ `owners`（有序，PRD §9 的并列次序）
 *     `fallback_review_owners`  一条都匹配不上时用谁
 *
 *   ★ 那个文件 `status: confirmed_by_user`（Owner 确认过），版本 `role-routing-2026-10-12`。
 *   ★ 它在库里躺了很久而**零读方** —— 本模块是它的第一个消费者。
 *     读它、不抄它：词表改了，路由跟着变，本文件一个字不用动。
 *
 * ── 边界（写清楚，别让它比输入大）
 *
 *   · 本模块**只按方向词匹配**，不判问题真假、不定三态 —— 那是 `mergeFindings` 的事。
 *   · 匹配**只吃 `category` / `risk_type` 这类方向字段**，**不吃 `reason`**：
 *     原因句里常出现「不得宣称**医疗**功效」这种**在解释别人的违规**的措辞，
 *     拿它当方向会把一条广告用语问题路由成医学问题。方向字段已经是提炼过的。
 *   · 拿不到路由表时**回落 PRD §5.3.2 那对**（法务 + 医学顾问），**不编别的**。
 *     为什么是这对：它是 PRD 示例里逐字给出的唯一一对，也是 `fallback_review_owners`
 *     在**本库规则**下的默认落点（两处指向同一答案）。
 *   · **不给句柄编人名**：句柄只能来自 `kb/l7/registry/l7.json` 的 `approvers`；
 *     没配就输出「角色名（未配置）」—— 组织一变动，写死的人名就变成假话。
 */

import { readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO_ROOT } from './config.mjs';

/** PRD §5.3.2 示例里逐字给出的那一对，作为**读不到路由表**时的落点。 */
export const PRD_DEFAULT_OWNERS = ['法务', '医学顾问'];

/**
 * 知识库根目录的**探测**（不硬编码一个绝对路径）。
 *
 * 为什么不像库侧 `review_engine.py` 那样直接写相对路径：它俩在**同一个仓**里
 * （`kb/l7/review-engine/core/*.py` → `parents[3]` 稳），而守衡在**另一个仓**，
 * 两个仓的相对位置是**工作区布局决定的** —— 写死就是「换台机器/换个工作区就断」。
 *
 * 次序（先到先用）：
 *   ① `SHOUHENG_KB_ROOT`（显式覆盖，判据与部署都用它）
 *   ② `~/.dsh/Momcozy知识库/kb` —— **文档化的稳定入口**（AGENTS.md 那张表里的「总库入口」）
 *   ③ 与守衡仓并排的几种常见布局（同工作区、上一级工作区）
 *
 * 探测用**目录存在**判，不用文件存在 —— 换个文件名不该把根目录探测搞断。
 */
function kbRoot() {
  const cands = [
    process.env.SHOUHENG_KB_ROOT,
    path.join(os.homedir(), '.dsh', 'Momcozy知识库', 'kb'),
    path.join(REPO_ROOT, '..', 'kb'),
    path.join(REPO_ROOT, '..', '..', 'kb'),
  ].filter(Boolean);
  for (const c of cands) {
    try { if (statSync(c).isDirectory()) return c; } catch { /* 下一个 */ }
  }
  return cands[1];   // 都探测不到就用文档化那个：让它**失败在明确的路径上**，而不是悄悄回落
}

/** 路由表位置。允许环境变量覆盖（离线判据要能喂坏样本，不想动真库文件）。 */
export function routingPolicyPath() {
  return process.env.SHOUHENG_ROUTING_POLICY
    || path.join(kbRoot(), 'l7', 'review-engine', 'knowledge-base', 'routing-policy.json');
}

/**
 * 维度政策件位置（`kb/l7/registry/risk-category-policy.json`）——
 * **库侧唯一真源**，本文件只读它，**不抄第二份映射**。
 */
export function riskCategoryPolicyPath() {
  return process.env.SHOUHENG_RISK_CATEGORY_POLICY
    || path.join(kbRoot(), 'l7', 'registry', 'risk-category-policy.json');
}

/**
 * 读维度政策件。读不到返回 `null`（调用方负责「不编维度」，**不在这里兜一个默认值**）。
 *
 * ★★ 2026-10-17：为什么要它 —— 报告要给**业务侧**看，每条问题的「维度」
 * 必须落在 PRD §5.3 的四维度（合规 / 消费者安全 / 产品描述 / 措辞表达）上。
 * 而这件事库侧已经定过口径（`risk-category-policy.json` 的 `map`），守衡只消费。
 * ⚠️ **政策件自己写着「不编，留空待裁」的类别，这里一律返回 `null`** ——
 * 实测影响面：模型侧 7 个类目里「隐私 / AI 披露 / 本地化」三个没有映射。
 */
export function loadRiskCategoryPolicy(p = riskCategoryPolicyPath()) {
  const raw = _readJson(p);
  if (!raw || typeof raw !== 'object') return null;
  return raw;
}

/**
 * 类别 → PRD 四维度。**查不到就是 `null`**（不猜、不塞进某一维）。
 * @param {string} category 类别（如「功效宣称」）
 * @param {object|null} policy `loadRiskCategoryPolicy()` 的返回值
 * @returns {string|null}
 */
export function dimensionForCategory(category, policy) {
  const cat = String(category ?? '').trim();
  if (!cat || !policy) return null;
  const hit = policy.map && Object.prototype.hasOwnProperty.call(policy.map, cat)
    ? policy.map[cat] : null;
  const dim = hit && typeof hit === 'object' ? String(hit.risk_category ?? '').trim() : '';
  const dims = Array.isArray(policy.dimensions) ? policy.dimensions : [];
  return dim && dims.includes(dim) ? dim : null;
}

/** 句柄表位置（与库侧 `review_engine.py::_approvers` **同一份**，不另造第二处）。 */
export function approversPath() {
  return process.env.SHOUHENG_APPROVERS
    || path.join(kbRoot(), 'l7', 'registry', 'l7.json');
}

const _readJson = (p) => {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
};

/**
 * 读路由表。读不到返回 `null`（调用方负责回落，**不在这里编一份**）。
 * @returns {{version:string|null, roles:object, rules:Array, fallback:Array}|null}
 */
export function loadRoutingPolicy(p = routingPolicyPath()) {
  const raw = _readJson(p);
  if (!raw || typeof raw !== 'object') return null;
  const rules = Array.isArray(raw.rules) ? raw.rules : [];
  const fallback = Array.isArray(raw.fallback_review_owners) ? raw.fallback_review_owners : [];
  return {
    version: typeof raw.routing_version === 'string' ? raw.routing_version : null,
    roles: (raw.roles && typeof raw.roles === 'object') ? raw.roles : {},
    rules: rules.filter((r) => r && Array.isArray(r.match) && Array.isArray(r.owners)),
    fallback: fallback.filter((x) => typeof x === 'string' && x.trim()),
  };
}

/** 一条 finding 的**方向字段**拼串（不含 `reason` —— 见文件头边界第 2 条）。 */
export function directionOf(finding) {
  const f = finding && typeof finding === 'object' ? finding : {};
  // ★ 2026-10-19（A3 12 类）：卡面首行改印 A3 后，**逐行解析那条来路的 `category` 就是 A3**
  //   ⇒ 方向词也要认 `taxonomy_category`（否则「背书与披露透明」「平台与渠道政策」这类
  //   本来命中的词会漏，路由静默落 fallback）。多认一格只会**增加**可命中的词，不改规则次序。
  return [f.category, f.risk_type, f.risk_category, f.dimension, f.taxonomy_category]
    .map((x) => (typeof x === 'string' ? x : ''))
    .filter(Boolean)
    .join(' ');
}

/**
 * 按问题方向算出该转谁。**纯函数**：不给路由表就回落 PRD 默认，绝不抛。
 *
 * 规则命中用 `String.includes`（与库侧 `review_engine.py` 的 `_owners_for` 同口径）：
 * 路由表里的词是「医疗 / 功效 / 睡眠」这类**中文词干**，不是正则。
 * 命中即取该条 `owners` 并**停止**（rules 有次序：医疗 → 产品 → 背书 → 本地）。
 *
 * @param {Array} findings 合并后的条目（每条至少 `category`）
 * @param {object|null} policy
 * @returns {{owners:string[], byRule:string[], unmatched:number, source:string, version:string|null}}
 *          `byRule` 命中的规则序号（-1 = 用 fallback）—— 留痕用，**不猜**。
 */
export function reviewOwnersFor(findings, policy) {
  const list = Array.isArray(findings) ? findings : [];
  const p = policy && typeof policy === 'object' ? policy : null;
  const fallback = (p?.fallback?.length ? p.fallback : PRD_DEFAULT_OWNERS);

  // 有序去重：PRD §9 的并列次序要保住（法务在医学前），不许被 Set 打乱
  const owners = [];
  const byRule = [];
  let unmatched = 0;
  for (const f of list) {
    const dir = directionOf(f);
    let hit = -1;
    if (p && dir) {
      for (let i = 0; i < p.rules.length; i++) {
        if (p.rules[i].match.some((w) => typeof w === 'string' && w && dir.includes(w))) { hit = i; break; }
      }
    }
    byRule.push(hit);
    if (hit < 0) unmatched++;
    for (const o of (hit < 0 ? fallback : p.rules[hit].owners)) {
      if (typeof o === 'string' && o.trim() && !owners.includes(o)) owners.push(o);
    }
  }
  return {
    owners,
    byRule,
    unmatched,
    source: !list.length ? 'no_findings' : (p ? 'routing_policy' : 'prd_default'),
    version: p?.version ?? null,
  };
}

/**
 * 角色名 → 配置好的 @ 句柄（**只从 `l7.json` 的 `approvers` 取**，取不到就是没配）。
 *
 * `l7.json` 的 `approvers` 目前只有三个**通用桶**（`pass_signoff` / `review_reviewers` /
 * `block_owner`）且 `handle` 全为 `null`。本模块按**角色位 key** 找
 * （`legal` / `medical` / `expert` / `north_america` / `product` / `channel` …，
 * key 名与 `routing-policy.json` 的 `roles` 各键一致）。
 *
 * @returns {Map<string,string>} 角色名 → handle（没配的角色不在表里）
 */
export function loadRoleHandles(p = approversPath()) {
  const raw = _readJson(p);
  const ap = raw && typeof raw === 'object' ? raw.approvers : null;
  const out = new Map();
  if (!ap || typeof ap !== 'object') return out;
  for (const [key, node] of Object.entries(ap)) {
    if (!node || typeof node !== 'object') continue;
    const h = typeof node.handle === 'string' ? node.handle.trim() : '';
    const r = typeof node.role === 'string' ? node.role.trim() : '';
    if (h && r) out.set(r, h);
  }
  return out;
}

/**
 * 渲染 PRD §5.3 那句收尾动作行。
 *
 * 口径（三条，缺一条就是编）：
 *   ① 收件人 = `owners`（按方向算出来的），**次序照 PRD**；
 *   ② 有配句柄就 `@handle`，没配就 `@角色名（未配置）` —— 与库侧
 *      `review_engine.py::_at()` **逐字同口径**，不在这里另定一套；
 *   ③ **只要有一条**没匹配到方向 ⇒ 末尾如实标出来，让「为什么转了这几位」看得见，
 *      也让人能回头补路由词。（原先是「全部都没匹配才标」—— 那会让**部分**没匹配
 *      的单子看起来像全都路由过了，恰好是最容易读错的一种。）
 *
 *   ★ 没有任何条目可路由（空清单）⇒ 落 `fallback`，**绝不输出空的收件人**：
 *     `建议转  复核。` 是一句没有宾语的话，比转错人更没用。
 *     （与库侧 `routing.py::review_action_line` 同一口径 —— 两边必须一致。）
 *
 * @param {string[]} owners
 * @param {Map<string,string>} handles
 * @param {{unmatched?:number, total?:number, fallback?:string[]}} [meta]
 * @returns {string}
 */
export function renderReviewAction(owners, handles = new Map(), meta = {}) {
  const compact = meta.compact !== false;   // 卡面默认紧凑；报告传 compact:false
  // ★★ 2026-10-19（Owner：REVIEW ≥3 整卡要 ≤100 字，实测 117）——
  //   卡上这一行压掉两处**内部读数**：`（未配置）` 与 `（n/m 条未匹配方向）`。
  //   它们不是给业务侧的行动信息：前者是**我们的句柄配置状态**，后者是**分派质量读数**；
  //   两者都**没有丢** —— 报告与查证笔记里照旧印（`verbose=true` 时也在卡上印）。
  const pad = (v) => (compact ? '' : '（未配置）');
  const at = (role) => {
    const h = handles instanceof Map ? handles.get(role) : (handles?.[role] ?? null);
    return h ? `@${h}` : `@${role}${pad()}`;
  };
  let who = (Array.isArray(owners) ? owners : []).filter((x) => typeof x === 'string' && x.trim());
  if (!who.length) who = (Array.isArray(meta.fallback) && meta.fallback.length
    ? meta.fallback : PRD_DEFAULT_OWNERS);
  const { unmatched = 0, total = 0 } = meta;
  // ★★ 2026-10-19（PRD §17 字数限制）：这一串原为
  //   `（其中 3/6 条未匹配到方向：该转谁需要人确认）`（26 字），占的是**卡上限额区**。
  //   事实（有几条没匹配到方向）留着，解释性从句去掉 ⇒ `（3/6 条未匹配方向）`（12 字）。
  //   ⚠️ 不是删信息：比例还在，只是不再解释一遍「该转谁需要人确认」（那半句是结论本身）。
  const gap = (total > 0 && unmatched > 0 && !compact)
    ? `（${unmatched}/${total} 条未匹配方向）`
    : '';
  return `建议转 ${who.map(at).join(' ')} 复核。${gap}`;
}


/**
 * **A3 派生表位置与加载器**（`kb/l7/registry/taxonomy-derive.json`）。
 *
 * ★★ 2026-10-19（Owner：「问题总览里有优先级和维度为空……这里不允许为空，模型侧输出的
 *   可以参照知识库侧的分类和优先级来定」）：
 *   - `class_to_dimension`：A3 12 类 → PRD 四维（报告「维度」那一格的默认值）；
 *   - `subclass_priority`：A3 子类 → p_level 众数（报告「优先级」那一格的默认值）。
 *   **只有一份真源**（kb 注册表里），本模块只读不抄 —— 两边各写一份必然漂移。
 */
export function taxonomyDerivePath() {
  return process.env.SHOUHENG_TAXONOMY_DERIVE
    || path.join(kbRoot(), 'l7', 'registry', 'taxonomy-derive.json');
}

export function loadTaxonomyDerive(p = taxonomyDerivePath()) {
  try {
    const raw = readFileSync(p, 'utf8');
    const d = JSON.parse(raw);
    if (!d || typeof d !== 'object') throw new Error('不是对象');
    return { ...d, from_file: p };
  } catch (e) {
    // 读不到就 `null` —— 调用方据此**不代定**（并留 basis 说明），绝不编一份映射出来
    return null;
  }
}

/**
 * 按 A3 类别取**默认维度**（PRD 四维）；取不到返回 `null`（调用方留空并说明）。
 * @param {string} taxCategory `taxonomyCategory`（12 类之一）
 */
export function dimensionForTaxonomy(taxCategory, derive = null) {
  const d = derive || loadTaxonomyDerive();
  const k = String(taxCategory || '').trim();
  if (!d || !k) return null;
  const v = (d.class_to_dimension || {})[k];
  return v && v.dimension ? { dimension: v.dimension, basis: v.basis, source: d.from_file } : null;
}

/**
 * 按 A3 子类取**默认优先级**（p_level 众数）；模型侧**封顶 P1**（P0 只由规则红线给）。
 *
 * @param {string} taxCategory
 * @param {string} taxSubcategory
 * @param {{cap?:string}} [opt] `cap` 默认 `'P1'`
 * @returns {{level:string, basis:string, derived_from:string}|null}
 */
export function priorityForTaxonomy(taxCategory, taxSubcategory, { cap = 'P1' } = {}) {
  const d = loadTaxonomyDerive();
  const key = `${String(taxCategory || '').trim()} / ${String(taxSubcategory || '').trim()}`;
  if (!d || !taxSubcategory) return null;
  const v = (d.subclass_priority || {})[key];
  if (!v || !v.p_level) return null;
  const order = ['P0', 'P1', 'P2', 'P3'];
  let lvl = String(v.p_level).toUpperCase();
  let capped = false;
  if (cap && order.indexOf(lvl) < order.indexOf(cap)) { lvl = cap; capped = true; }
  return { level: lvl,
           basis: `${v.basis}${capped ? `；模型侧**不判 P0**（P0 只由规则红线给）⇒ 按 ${cap} 用` : ''}`,
           derived_from: d.from_file };
}


/**
 * 按**模型侧类目**（7 个闭集：合规/消费者安全/措辞表达/产品描述/隐私/AI 披露/本地化）
 * 取 PRD 四维的兜底映射。
 *
 * ★★ 2026-10-19（Owner：「这里不允许为空」）：只在该条既无 `risk_category`、
 *   也拿不到可用 A3 类别时才用（真源 `kb/l7/registry/taxonomy-derive.json::category_to_dimension`）。
 */
export function dimensionForModelCategory(category, derive = null) {
  const d = derive || loadTaxonomyDerive();
  const k = String(category || '').trim();
  if (!d || !k) return null;
  const v = (d.category_to_dimension || {})[k];
  return v && v.dimension ? { dimension: v.dimension, basis: v.basis } : null;
}

/**
 * advice.mjs —— **「建议」的唯一产出者**（Owner 2026-10-09 定的规则）
 *
 * ── Owner 的原话
 *
 * > 「现在是建议必须具体内容。负面样本『建议』列填充 47% ⇒ **有填的做参考，agent 输出最终具体建议**；
 * >   **没填的不用参考，不用管，agent 直接出建议**。」
 *
 * ── 为什么要有它：把「两个产出者」变成一个
 *
 *   在此之前 `建议` 有两个来源 —— 库侧原话（源表那 47%）与模型侧自己写的 —— 于是：
 *     · 库侧给了就印库侧的，模型那条被**静默丢掉**（它可能更贴素材）；
 *     · 来源标不清（「双轨确认」那条其实是库侧给的，却读起来像两侧合成）；
 *     · 库侧没填时，若模型也没给，就只剩一句「转对应负责人复核」。
 *   今天所有关于「建议」的毛病，根都是**两个产出者**。
 *   现在：**条目清单 + 库侧参考（可空） → 一次调用 → 每条一句改法**，唯一产出者。
 *
 * ── 时序：为什么必须等两侧都回来
 *
 *   模型侧与链**并行**跑（链 2~17 分钟，模型侧 ~14 秒）⇒ 模型侧产出它的发现时，
 *   库侧的建议**还没到**。所以「有填的做参考」只能**在两侧都回来之后**补这一次调用。
 *   代价是多一次 LLM 调用（约 5~15 秒），换来的是**不动那条判定链**。
 *
 * ── 三条纪律
 *
 *   ① **参考 ≠ 照抄**：提示词里明说库侧那格是参考，可以为空；最终句子由模型按素材写。
 *   ② **失败不编**：调用失败/解析失败 ⇒ 返回 `{}`，调用方**回退**到原有逻辑（库侧原话 →
 *      模型原话 → 如实说没有）。**绝不**在这里造一句顶上去。
 *   ③ **标注要说「参考了什么」，不是「谁给的」** —— 改法**始终是模型写的**，
 *      所以标成「库侧给的改法」会是假陈述（这也是安全阀，见 `renderMergedItem`）。
 */

/** 修改建议上限来自唯一 PRD registry；提示词、渲染与验收共用该值。 */
import { countAdviceChars, ADVICE_MAX } from './prd533.mjs';
export { ADVICE_MAX };

/**
 * 字数口径：**标点不计**，与 PRD registry 的规则一致。
 *
 * ★ 唯一真源在 `prd533.mjs::countAdviceChars`（渲染层、守衡侧判据、库侧 `prd533_check.py`
 *   都用同一套字符集）。这里不改写第二份 —— 抄一份出去，迟早三处各说各话。
 */
export function adviceChars(t) { return countAdviceChars(t); }

/**
 * 建议格只放动作句。把来源说明留在原因/依据格，不让它顶在动作前面吃掉展示额度。
 * 同位置合并的历史记录常把「源记录未填建议」和真正的建议串在一起；去掉重复说明、
 * 去重动作句后，业务侧能直接看到可执行修改。
 */
export function cleanAdviceText(text) {
  const boilerplate = /(?:源记录|历史记录|记录本身)[^。；;]{0,30}(?:未给|没给|没有|未提供|未填写|为空|无)(?:具体)?(?:改法|修改建议|建议)|此条仅为相似历史参考|不构成禁止或打回依据/;
  const clauses = String(text ?? '').replace(/\s+/g, ' ').trim()
    .split(/(?<=[；;。\n])|(?<=；)|(?<=;)/u)
    .map((part) => part.trim().replace(/^[；;。\s]+|[；;。\s]+$/g, ''))
    .filter((part) => part && !boilerplate.test(part))
    .map((part) => part.replace(/^(?:修改建议|建议|推荐方案|改法)[：:]\s*/u, '').trim())
    .filter(Boolean);
  return [...new Set(clauses)].join('；');
}

const SYSTEM = [
  '你在给一份已经判完的内容审查，**逐条写具体改法**。',
  '每条只写一件事：**怎么改**。改哪个词、换成什么、删哪句、补什么。',
  '',
  '硬约束：',
  // ★★ 当前建议上限通过登记表 `ADVICE_MAX` 管理，运行时覆盖高于上游历史值。
  //   病灶在**产出侧**，不只是显示侧：提示词只说「写具体改法」，模型就交来一段 372 字的
  //   情况说明（「这段素材里检索不到…需要给出原词才能写具体替换…」）——那不是改法。
  //   只在渲染层截断治不了它：截完剩的是半句诊断，还不是动作。
  //   ⇒ 源头按 `ADVICE_MAX` 写短，渲染层的 `_clip` 只当**硬兜底**。
  `0. **每条 ≤${ADVICE_MAX} 字（卡面与报告同一把尺）**：一句**可执行动作**，`,
  `   不解释、不复述原因、不列 ①②③。超过 ${ADVICE_MAX} 字的一律不合格 —— 收到的人只读这一句。`,
  `   ★ **标点不计入 ${ADVICE_MAX} 字**（「，」「。」「「」」这些不算）⇒ 该断句就断句，别为了省字数写成一句长坨。`,
  '1. **不许写没有动作的话** —— 「转对应负责人复核」「请人工确认」「建议修改」「需进一步核实」',
  '   这类一律不合格：收到它的人还是不知道该改什么。',
  '2. 若某条**确实写不出具体改法**，就写清**缺什么信息才能定**（例：「需要知道投放在哪个平台',
  `   才能定这句促销语合不合规」）—— 那也是可执行的下一步，**同样 ≤${ADVICE_MAX} 字**。`,
  '   若依据只是相似历史意见且该源记录没有填写建议，不能把「没有建议」推成「禁止、打回、拒绝发布」；',
  '   也不能冒充源记录原文。只有当前素材和明确规则独立支持具体修改时才写改法，否则 advice 留空。',
  '   ✗ 反例（真实 372 字那种，不合格）：「这段素材里检索不到…需要给出被判定为绝对化的那个原词，',
  '     以及它在第几段第几个字，才能写具体替换。在那之前可以先做一件能落地的……」',
  '3. `reference` 是**库里同类反例的建议原文**，**只是参考**：',
  '   · 有值 ⇒ 照素材改写它（不要原样抄，它讲的可能是别的事）；',
  '   · 空的 ⇒ 只能基于当前素材和明确依据独立写具体改法；若写不出就输出 advice 为空字符串。',
  '4. **不许**在改法里声称「库规要求」「条款规定」—— 你是给建议，不是引用规则。',
  '5. **不许从 OCR 节选重新发现拼写问题**：只有条目的 `confirmed_issue` 明确写了拼写/标点错误，',
  '   或 `visual_anchor` 明确说明原图可见错误时，才可建议修改大小写、空格、连字符、撇号或拼写。',
  '   如果两个写法去掉空格、标点与大小写后相同，默认是 OCR 格式噪声，不得建议修改。',
  '',
  '输出：**只输出一个 JSON 数组**，不要解释、不要 markdown 代码块。每项形如',
  '{"i":0,"advice":"具体怎么改"}',
  '`i` 是给你的条目的序号，必须原样回填。',
].join('\n');

/**
 * 压缩用 system：把**已经写长**的改法压到登记表的建议上限。
 *
 * ★★ 2026-10-19（Owner：「这里的 修复建议都没讲完，**被截断了**，不能出现这种情况」）
 *
 *   病根在**产出侧**：提示词约束建议上限，模型不照做时，渲染层用 `…` 把它切在半句上
 *   （真报告 6 条里 3 条是这样，最狠的一条只剩「改为…」）。切出来的不是"短改法"，
 *   是**没有动作的半句** —— 收到的人反而更不知道该改什么。
 *
 *   两条路只能选一条，而且必须在**同一侧**落：
 *     · 渲染层不切（`dual_track.fitAdvice`，已在报告那一格落地）；
 *     · 产出侧**写短**（就是这里：超了就再问一次，让它自己压）。
 *   只做前者 ⇒ 报告会超字数（Owner 上午刚定的 ≤30 就废了）；
 *   只做后者 ⇒ 模型不听话时又得靠切。
 *   ⇒ 两条都做，且**压缩失败时宁可印长的完整句，也不许切**。
 */
const SYSTEM_COMPRESS = [
  `你在把「修改建议」压到 ≤${ADVICE_MAX} 字。**只压不加**：不许新增观点、不许改主意。`,
  '硬约束：',
  `1. 每条 ≤${ADVICE_MAX} 字（**标点不计**），**一句完整的话**；`,
  '2. **不许**用省略号（`…` / `...`）收尾，**不许**留下半句 —— 读的人只有这一句；',
  '3. 保不住全部细节时，**保留最主要的那个动作**（改哪个词 / 换成什么 / 删哪句）；',
  '4. 只输出 JSON 数组：[{"i":0,"advice":"…"}]，不要解释。',
].join('\n');

/** 拼给模型的那一段（**纯函数** —— 喂样本就能断言，不必真调模型）。 */
export function buildAdvicePrompt(items = [], { readings = '', question = '' } = {}) {
  const rows = items.map((f, i) => {
    const ref = f.kbAdvice ?? f.kb?.suggestionLine ?? null;
    // 模型侧自己写过的初稿 —— 两轨都命中时，两条都给模型看（它比谁都清楚哪条更贴素材）
    const draft = f.suggestion ?? f.model?.suggestion ?? null;
    return [
      `i=${i}`,
      `位置：${f.location ?? '（未给）'}`,
      `类目：${f.category ?? '（未给）'}${f.sub ? '-' + f.sub : ''}`,
      `原因：${f.reason ?? f.kb?.reasonLine ?? '（未给）'}`,
      `confirmed_issue：${f.description ?? f.model?.description ?? f.kb?.description ?? '（未给）'}`,
      `visual_anchor：${f.visual_anchor ?? f.model?.visual_anchor ?? '（未给）'}`,
      `reference：${ref ? String(ref).replace(/\n/g, ' ') : '（空 —— 库里这条没填建议）'}`,
      draft ? `模型侧初稿：${String(draft).replace(/\n/g, ' ')}` : '',
    ].join('\n');
  });
  return [
    '【本单素材（节选）】',
    String(readings || '').slice(0, 2000),
    question ? `【送审时的问题】${question}` : '',
    '',
    `【要你写建议的条目】共 ${items.length} 条`,
    ...rows,
  ].filter(Boolean).join('\n');
}

/**
 * 解析模型侧的建议输出（**纯函数**，宽容取第一个 JSON 数组）。
 * @returns {{ok:boolean, advice:Object<number,string>, error?:string}}
 */
export function parseAdvice(text) {
  const s = String(text ?? '');
  const a = s.indexOf('[');
  const b = s.lastIndexOf(']');
  // ★★ 2026-10-09 实测：**截断必须如实报成截断**，不许报成「没写数组」——
  //   与 `model_side.mjs` 同一条判据：报错指向错误的方向，查的人就永远查不到真因。
  if (a < 0) return { ok: false, advice: {}, error: '输出里没有 JSON 数组' };
  if (b <= a) {
    return { ok: false, advice: {},
             error: `输出**被截断**（有数组开头、没有结尾）—— 多半是额度用尽被腰斩｜raw=${s.length} 字` };
  }

  let arr;
  try { arr = JSON.parse(s.slice(a, b + 1)); }
  catch (e) { return { ok: false, advice: {}, error: `JSON 解析失败：${e?.message ?? e}` }; }
  if (!Array.isArray(arr)) return { ok: false, advice: {}, error: '不是数组' };
  const advice = {};
  for (const raw of arr) {
    const i = Number(raw?.i);
    // Preserve the model's exact text until the safety gate runs below. Cleaning
    // first could erase a risky clause and make the rejection counter look green.
    const t = String(raw?.advice ?? '').trim();
    if (!Number.isInteger(i) || i < 0 || !t) continue;
    advice[i] = t;
  }
  return { ok: true, advice };
}

// A historical record with no advice cannot support an invented prohibition.
// Suppress this exact escalation shape so prompt drift cannot turn missing data
// into a REVIEW→BLOCK decision in the recommendation field.
export function rejectUnsupportedHistoricalDisposition(text, item = {}) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  const saysMissing = /(?:源记录|历史记录|记录本身)[^。；;]{0,24}(?:未给|没给|没有|未提供|未填写|为空|无)(?:具体)?(?:改法|建议)/.test(s);
  const escalates = /(?:禁止|打回|驳回|拒绝发布|不得发布|不予发布|不可发布|直接拒绝)/.test(s);
  const reason = String(item?.kb?.reasonLine ?? item?.reason ?? '');
  const recordLevel = /相似历史审核意见|相似历史记录|历史审核意见|point[·.]参考|record[_ -]?level/i.test(reason);
  const hasKbRecommendation = String(item?.kbAdvice ?? item?.kb?.suggestionLine ?? '').trim().length > 0;
  return escalates && (saysMissing || (recordLevel && !hasKbRecommendation));
}

const normalizedVisibleText = (value) => String(value ?? '').toLocaleLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, '');

/** OCR-only formatting fixes require an explicit confirmed spelling issue or original-image anchor. */
export function rejectUnverifiedOcrCorrection(text, item = {}) {
  const advice = String(text ?? '').trim();
  if (!advice) return false;
  const correctionSignal = /(?:改为|改成|统一为|修正|更正|替换为|去掉|删除)[^。；]{0,30}(?:拼写|大小写|空格|连字符|撇号|引号)/
    .test(advice)
    || /(?:拼写|大小写|空格|连字符|撇号|引号)[^。；]{0,20}(?:错误|有误|不一致|改|统一)/.test(advice);
  // 中文/弯引号内部允许英文撇号（`Eufy-S1'Pro`）；直引号单独解析，避免把词内撇号当闭引号。
  const quoted = [
    ...[...advice.matchAll(/[「『“]([^」』”]{2,80})[」』”]/g)].map((m) => m[1].trim()),
    ...[...advice.matchAll(/"([^"\n]{2,80})"/g)].map((m) => m[1].trim()),
  ];
  const formattingOnly = quoted.length >= 2
    && normalizedVisibleText(quoted[0]) === normalizedVisibleText(quoted[1]);
  if (!correctionSignal && !formattingOnly) return false;
  const confirmed = [item?.description, item?.model?.description, item?.kb?.description,
    item?.visual_anchor, item?.model?.visual_anchor]
    .filter(Boolean).join(' ');
  return !/(?:原图|关键帧|视觉锚点|可直接看到|拼写|大小写|空格|连字符|撇号|引号)[^。；]{0,30}(?:错误|有误|不一致|确认|可见)/.test(confirmed);
}

/**
 * 跑这一次调用。**失败回空对象，由调用方回退** —— 这里绝不编一句。
 * @returns {Promise<{ok:boolean, advice:Object, error?:string, ms:number, raw?:string}>}
 */
// ★ 2026-10-09：与模型侧同理 —— 截断就腰斩，所以额度从 2000 提到 4000。
export async function generateAdvice({ items = [], readings = '', question = '', ask, maxTokens = 4000 } = {}) {
  const t0 = Date.now();
  if (!items.length) return { ok: true, advice: {}, ms: 0 };
  if (typeof ask !== 'function') return { ok: false, advice: {}, ms: 0, error: '没给 ask（LLM 入口）' };
  const prompt = buildAdvicePrompt(items, { readings, question });
  let r;
  // ★ `ask` 的真实签名是 `ask(用户提示词, { system, maxTokens })` 且**返回字符串**
  //   —— 与 `model_side.mjs:132` 一致。第一版我猜成了 `ask({system,user})` 收 `{text}`，那是错的。
  try { r = await ask(prompt, { system: SYSTEM, maxTokens, temperature: 0 }); }  // ★ 2026-10-16 同上：建议也进报告，须确定
  catch (e) { return { ok: false, advice: {}, ms: Date.now() - t0, error: `${e?.name ?? 'Error'}: ${e?.message ?? e}` }; }
  // ★★ 2026-10-09：**截断或 0 字就重试一次**（额度翻倍）—— 与 `model_side.mjs` 同一条兜底。
  //   实测那一单的建议生成是 `raw=0 字`（**额度被 reasoning 烧光**，不是解析问题）⇒
  //   一次空转就把「具体建议」整条丢掉，卡片回退成库侧原话照搬。
  //   只对「截断」与「0 字」重试：真写了散文（非空且无 `[`）重试没用，那是提示词问题。
  //   （原先这里只有一行**注释**写着「截断就重试」而代码里没有 —— 注释不是约束，已补成真的。）
  let txt = String(r ?? '');
  let p = parseAdvice(txt);
  if (!p.ok && (/被截断/.test(String(p.error ?? '')) || txt.length === 0)) {
    console.log(`[agent] ↻ 建议生成输出${txt.length === 0 ? '为 0 字（额度被 reasoning 烧光）' : '被截断'}，`
      + `重试一次（额度 ${maxTokens} → ${maxTokens * 2}）`);
    try {
      r = await ask(prompt, { system: SYSTEM, maxTokens: maxTokens * 2, temperature: 0 });
      txt = String(r ?? '');
      p = parseAdvice(txt);
    } catch (e) { /* 重试也失败 ⇒ 走下面的回退，不编 */ }
  }
  if (!p.ok) {
    return { ok: false, advice: {}, ms: Date.now() - t0, raw: txt.length,
             error: `${p.error}｜raw=${txt.length} 字${txt.length ? '' : '（0 字 = 额度被 reasoning 烧光，不是解析问题）'}` };
  }
  const rejectedUnsupported = [];
  const rejectedOcrNoise = [];
  for (const [i, advice] of Object.entries(p.advice)) {
    if (!advice) continue;
    if (rejectUnsupportedHistoricalDisposition(advice, items[Number(i)])) {
      delete p.advice[i];
      rejectedUnsupported.push(Number(i));
      continue;
    }
    if (rejectUnverifiedOcrCorrection(advice, items[Number(i)])) {
      delete p.advice[i];
      rejectedOcrNoise.push(Number(i));
    }
  }
  // ── ★★ 2026-10-19（Owner：「被截断了，不能出现这种情况」）：**写短，不切短** ──────
  //   提示词已经写了登记表上限，模型不一定照做；此时**再问一次让它自己压**。
  //   压成了 ⇒ 用它；压不成（调用失败/还超）⇒ **原样留着**（渲染层会完整印出，绝不加 `…`）。
  const over = Object.entries(p.advice).filter(([, t]) => adviceChars(t) > ADVICE_MAX);
  let compressed = 0;
  if (over.length) {
    const board = over.map(([i, t]) => `i=${i}\n原句：${String(t).replace(/\n/g, ' ')}`).join('\n\n');
    try {
      const r2 = await ask(`下面每条「修改建议」都超过 ${ADVICE_MAX} 字，请各压成 ≤${ADVICE_MAX} 字的一句完整动作：\n\n${board}`,
        { system: SYSTEM_COMPRESS, maxTokens: 1500, temperature: 0 });
      const p2 = parseAdvice(String(r2 ?? ''));
      if (p2.ok) {
        for (const [i, t] of Object.entries(p2.advice)) {
          const v = String(t ?? '').trim();
          // 只收**更短且仍非空**的；比原文还长/为空 ⇒ 不采（防止压缩把话压没了）
          if (!v || adviceChars(v) > adviceChars(p.advice[i])) continue;
          if (p.advice[i] !== v) { p.advice[i] = v; compressed += 1; }
        }
      }
    } catch { /* 压缩失败 ⇒ 留原句（完整 > 半句） */ }
  }
  return { ok: true, advice: p.advice, ms: Date.now() - t0, raw: txt.length,
           compressed, rejected_unsupported: rejectedUnsupported,
           rejected_ocr_noise: rejectedOcrNoise,
           over_length: Object.keys(p.advice).filter((i) => adviceChars(p.advice[i]) > ADVICE_MAX) };
}

/**
 * model_side.mjs —— 双轨里的**模型侧那一遍**（PRD 上游技术方案 §③「知识库＋大模型 双校验」）
 *
 * ── 它是什么、不是什么 ─────────────────────────────────────────────────
 * 方案原文：
 *   `模型侧：语义核查与边界判断 → 命中带 位置与理由（无库内依据）`
 *   `**没有主判与辅助之分** —— 每层的两侧都是完整的一遍审查，各自出问题清单`
 *
 * 所以这一遍**不许看知识库**：不给它条款、不给它检索结果、也不给它链的结论。
 * 它只看**素材本身**（图上的字 / 关键帧上的字 / 音轨转写），凭语义与常识出清单。
 * 它出的每一条都**没有库内依据** —— 合并时按方案降为 REVIEW，不由它单独定 BLOCK。
 *
 * ── 为什么提示词里要写死那几条「不许」──────────────────────────────────
 * 这一遍唯一的失败模式是**编**：模型很容易为了「有产出」而把
 * 「我读不到画面」或「这段没字」写成一条问题。那种条目会直接抬高结论严重度，
 * 而它是**无中生有**。所以提示词里三处硬约束 + 解析侧一道闸（`parseFindings` 会丢掉
 * 类目不在闭集、或理由为空的条目，并把整份结果标为未完成；正确的水印排除另记）。
 *
 * ── 失败怎么办 ─────────────────────────────────────────────────────────
 * 模型侧跑不成返回 `{ok:false}`，不能把未完成当作「完成且零发现」。
 * 调用方保留已有风险发现，并按媒材完成门槛处理；结构错误与按规则排除分开留痕。
 */

// ★ 2026-10-09：帧文本走 `video.frameLine`（**唯一产者**）—— 原先这一处自己拼过一份，
//   且**丢掉了 `t_s`** ⇒ 模型出 findings 时看不到时间码，却被告知要「指得出第几帧」。
//   `video.mjs` 不引本模块，无循环依赖。
import * as video from './video.mjs';
import { isDeepStrictEqual } from 'node:util';
import { sceneBlock } from './scene.mjs';
import { sourceMenuLines, resolveSourceId, probeUrl, probeLabel } from './ext_basis.mjs';
// ★ 2026-10-19（Owner：「按 prd 要求的字数限制梳理重点输出，不能出现截断的场景」）：
//   字数判据**只有一个来源**（PRD 真源 `prd533-constraints.yaml`）—— 这里不自己写 50/30。
import { checkFields as prd533Fields, ADVICE_MAX } from './prd533.mjs';

/** 每次最多探几条依据链接（防 10 条 finding 拖出 10 次网络往返）。 */
export const MAX_PROBE = 3;

/** 类目闭集（与 PRD §5.3 的「维度标注」同一套词）。不在闭集里的一律丢掉。 */
export const CATEGORIES = Object.freeze([
  '合规', '消费者安全', '措辞表达', '产品描述', '隐私', 'AI 披露', '本地化',
]);

/**
 * **A3 所属类别（12 类）** —— 模型侧也要归类，否则卡上永远是「未归类」。
 *
 * ★★ 2026-10-19（Owner：「守衡回复未归类问题 5 个，为什么没有归类，实际打开审查报告，里面都归类了」）：
 *   病灶不是渲染，是**模型侧根本没有 A3 这一格**（12 类体系是规则层的分类；模型侧条目不是规则）。
 *   而 12 类的「含义」列本来就是给人读的 ⇒ 让模型**从这 12 个里选一个**，并**校验**（不在枚举里就置空，
 *   渲染层落 `未归类`）。子类**不逼模型猜**（58 个子类是规则侧的细分类，模型给不出来就留空）。
 *   真源：`kb/l3/registry/rule-taxonomy.json`（← 桌面 `规则清单-P0-P3-按等级-20261016.xlsx`）。
 */
/** 12 类 → 实有子类（58 个；`未归类` 无子类）。**只读真源，不改口径**。 */
export const TAXONOMY_SUBCLASSES = Object.freeze({
  "合规与受监管宣称": Object.freeze(["临床与科学背书宣称", "保险与报销资格宣称", "医疗与疾病功效宣称", "无痛、安全与零风险承诺", "智能与仿生宣称", "法定认证与注册表述", "生理功效与效果承诺", "等级与资质背书用语", "结构功能宣称与免责声明", "绝对化与最高级用语"]),
  "产品安全与高危使用场景": Object.freeze(["儿童乘车与居家防护", "危险行为示范与模仿风险"]),
  "商品信息与Listing准确性": Object.freeze(["产品体验与设计方向表述", "功能与部件描述准确性", "规格与参数表述", "适配与尺码宣称", "防漏与密封宣称"]),
  "证据与实质证明": Object.freeze(["临床与科学证据要求", "效果数据与销量排名宣称", "研究方法与统计口径", "证据不足与待验证宣称", "证据局限、限定语与整体印象"]),
  "推广与价格透明": Object.freeze(["促销紧迫感与压力话术", "折扣与会员活动表述"]),
  "背书与披露透明": Object.freeze(["专家与专业人士背书", "利益关系与资质披露", "安全信息与风险披露", "视听披露形式要求", "达人合作与付费推广披露", "限定信息与免责声明（清晰显著）"]),
  "品牌信任与声誉": Object.freeze(["品牌口号与价值主张", "竞品对比与贬低"]),
  "权利、肖像、隐私与AI": Object.freeze(["AI 生成内容标识", "未成年人出镜与隐私保护"]),
  "平台与渠道政策": Object.freeze(["分地区投放禁令", "平台政策总体合规", "平台标识与授权素材使用", "投放形式与版位限制", "禁止投放品类与场景", "素材提交与形式规范"]),
  "北美本地化与标签要求": Object.freeze(["标签与包装法定要求"]),
  "母婴知识内容准确性": Object.freeze(["产后恢复", "儿童安全与居家防护", "内容形式与表达规范", "分娩与待产", "吸奶器使用与母乳储存", "哺乳与泌乳", "喂养与辅食营养", "备孕与受孕", "妈妈心理与情绪", "婴幼儿睡眠", "孕期与产检", "新生儿护理与就医指征", "母乳喂养通用建议", "母乳成分与过敏", "生长发育与里程碑", "用药与成分安全", "离乳与夜奶"]),
  '未归类': Object.freeze([]),
});

export const TAXONOMY_CLASSES = Object.freeze([
  '合规与受监管宣称', '产品安全与高危使用场景', '商品信息与Listing准确性', '证据与实质证明',
  '推广与价格透明', '背书与披露透明', '品牌信任与声誉', '权利、肖像、隐私与AI',
  '平台与渠道政策', '北美本地化与标签要求', '母婴知识内容准确性', '未归类',
]);

/** A3 所属类别误填到方向类目格时的确定性兼容映射，避免整条审核发现被丢弃。 */
export function routeCategoryFromTaxonomy(taxonomyCategory, taxonomySubcategory = '') {
  const cat = String(taxonomyCategory ?? '').trim();
  const sub = String(taxonomySubcategory ?? '').trim();
  if (!TAXONOMY_CLASSES.includes(cat) || cat === '未归类') return null;
  if (cat === '产品安全与高危使用场景') return '消费者安全';
  if (cat === '商品信息与Listing准确性') return '产品描述';
  if (cat === '北美本地化与标签要求') return '本地化';
  if (cat === '权利、肖像、隐私与AI') return /AI|生成内容标识/i.test(sub) ? 'AI 披露' : '隐私';
  if (cat === '品牌信任与声誉') return '措辞表达';
  // 其余类目无法无损地推断到更窄的路由方向，保留为通用合规方向。
  return '合规';
}

/** 模型侧并行审查：接收 OCR/画面读数；图片单还直接接收原图。 */
export const SYSTEM = [
  '你是内容合规审查里的**模型侧**。它与知识库侧**并行、互不参照**：',
  '你看不到任何知识库条款、检索结果或他人的结论，也不许引用条款号。',
  '你只做一件事：审查素材本身（图片单要直接看原图，并结合 OCR/画面读数；视频看关键帧文字/音轨转写），',
  '凭视觉观察、语义理解、常识与美国平台惯例，列出**你发现的问题**。',
  '',
  '硬约束（违反的条目会被丢弃）：',
  '1. **没有发现就返回空数组 `[]`。** 不许为了「有产出」而编 —— 空的清单是有效结论。',
  // ★★ 2026-10-19（Owner：「最终输出的卡片态，必须是 4 态」；PRD §5.3.2 SUGGEST 定义）——
  //   病灶（实测）：给五段**只是措辞别扭、没有任何违规**的文案，模型侧**五次都回 `[]`** ——
  //   因为提示词只讲「列出你发现的问题」，没讲「**非强制项也要报**」。
  //   ⇒ SUGGEST（第四态）在生产里永远出不来，那条 PRD 状态等于死代码。
  //   现在明确：**强制项之外，非强制项也要报**，并标 `nature:"非强制"`。
  //   ⚠️ 「不编」这条一个字没松：**没有可提的点就仍然回 `[]`**；
  //      这里要的是「**有就报、别嫌小**」，不是「必须凑一条」。
  // ★★ 2026-10-19（Owner：「**依据：必须要提供依据，为问题做支撑**」）——
  //   病灶：实测卡上出现「依据：独立语义复核（非条款依据，需人工核对）」——
  //   一条**没有依据**的判定，读者凭什么信它？PRD §5.3.3 也写明依据必须可引。
  //   ⇒ 规则前置：**每条都必须给得出依据**（外部标准 id 或可核 URL）；给不出就**不要报这条**。
  // ★★ 2026-10-22（Owner：「**依据文档链接，是需要提供证明这是个问题的外部链接**，
  //   报告里的『送审素材原文：「Ask Midwife Vic」』更像是问题描述」）——
  //   **呈现口径变了，提示词必须跟着变**：那一格现在只有三种写法
  //     ① 登记来源《文档》（带链接）；② 模型自写可核 URL；③ 「无外部依据（原图观察：…；需人工核对）」。
  //   ⇒ 所以：**有可挂的外部文档就必须挂**；只有纯画面事实才可以只给 `visual_anchor`，
  //     那时报告会如实写「无外部依据」——**不许为了填满那一格去编一条法规或凑一个「最像的」来源**。
  '1c. **图片单允许基于原图直接观察与图文语义关系提出问题，不要求外部/库内条款**；',
  '   必须填写 `evidence_basis:"image_observation"` 与具体 `visual_anchor`（图号及可见事实/语义关系），',
  '   并把观察事实与判断分开写。纯观察/语义一致性可以无引用；声称违反法规、平台规则或专业安全标准时，',
  '   仍须给可核 `source`/`source_url`，否则不得作该规范性结论。',
  '   1c-2 ★ **能挂外部文档的，一律挂上**（那一格读者会点开核对）：',
  '     涉及「资质 / 执业身份」「从业年限与资历」「专家或机构背书」「功效与举证」',
  '     「价格·对比·排名」这几类，请从第 6 条的已登记来源里挑一个（挑不出再写 `source_url`）——',
  '     那一格要的是**能证明「这是个问题」的外部文档**，不是材料里那句原文本身。',
  '     只有**纯画面事实**（人物姿势、物件状态与摆放、排版与图标、水印位置）才允许只给 `visual_anchor`；',
  '     这种条目报告会如实写「无外部依据（原图观察：…）」，**不许**给它编一条法规。',
  '   **不许编造画面内容**：图片单必须能从原图确认 `visual_anchor`，读数与原图冲突时以原图为准。',
  '1b. **非强制项也要报**（这关系到最终结论能不能落 SUGGEST 这一态）：',
  '   除了「不改就不能发」的强制项，**如果这段文案存在下面三类之一，就必须报出来**并标 `nature:"非强制"`：',
  '     · **措辞优化**：表达啰嗦、堆砌形容词、口语/网红腔、句式重复、术语不统一；',
  '     · **轻微常识瑕疵**：常识上不准确或含糊，但不构成健康/安全宣称；',
  '     · **非核心卖点描述**：颜色、包装、手感、外观一类的描述含糊或不到位。',
  '   判定问题：**这条不改也能发** ⇒ 非强制（报出来，标 `非强制`）；**不改就不能发** ⇒ 强制（标 `强制`）。',
  '   ⚠️ 但**没有可提的点就仍然回 `[]`** —— 这条要求是「有就报、别嫌小」，不是「必须凑一条」。',
  // ★★ 2026-10-15：这一条改了 —— 原先写「不许把『我看不到画面』写成问题」，因为当时
  //   **画面层根本不在输入里**（两侧吃的都是同一份 OCR 文字）。现在 `【图 N 的画面读数】`
  //   真的进来了（PRD §5.1 的「基础视觉识别」那一半），于是边界从「不许评价画面」
  //   变成「**只许依据画面读数那一节评价画面**」。两种写法都不是风格问题：
  //   放开而不设边界 ⇒ 它会把自己"想象"的画面写进 findings（2026-10-09 实测过
  //   它拿水印编出「图上反复出现『5615 RO0』」那种条目，让被审方去改图上不存在的东西）。
  '2. 图片单直接检查本轮随请求提供的原图；`【图 N 的画面读数】` 与 OCR 是辅助读数，不替代原图。',
  '   · 那一节里**写了**的（场景、人物、物品、可见标识、画面线索）⇒ 可以据此判，位置写「画面」；',
  '   · 那一节里**没写**的（月龄、声音、这张图之外的情节、更细的构图）⇒ **不许推断**，也不许写成问题；',
  '   · 那一节**没有**（这一单没跑画面层或没读到）⇒ 画面层就此打住，**不许把「我看不到画面」写成问题**'
    + '（那是能力边界，不是内容风险）。',
  // ★ 2026-10-22（Owner：截图层水印不是素材问题）：重复/覆盖式审阅水印被 OCR 摘除后，
  //   模型仍会从原图看见它；必须避免把截图叠加层推断成成品隐私/背书风险。
  '2a. **截图层水印不计为素材问题**：若 OCR 读数注明已摘除重复/覆盖式水印，且原图显示它是半透明截图/审阅叠加层，',
  '   不得把它写成隐私泄露、广告主/背书误认或要求删除水印的发现；不得单独据此判 REVIEW。',
  '   水印若遮住文字，只说明受遮挡区域的局部识读受限，不将遮挡本身列为素材问题。',
  '   只有原图能确认水印属于最终交付创意内容时，才按成品审查；不能确认时不得推断消费者会误认。',
  // ★ 2026-10-26（Owner：「The Crib CEo 这个图片上明明是大写」）：
  //   本机 OCR（macOS Vision）对圆体/艺术字/全大写词的字高极易产生大小写误读（如 `CEO`→`CEo`、`MOMCOZY`→`momcozY`、`Sloth`→`sloth`）。
  '2b. **严禁把图片/视频抽帧 OCR 的字母大小写抖动或形近字误读（如 `CEO`→`CEo`、`MOMCOZY`→`momcozY`/`Momeozy`、`Eufy`→`Euiy`、`so I`→`sol`、`each`→`cach`、`flange`→`ilange`）当成素材拼写/语法错误**：',
  '   图片与视频抽帧 OCR 的单字符形近误差、残句截断（均匀抽 8 帧只截到半句字幕）以及视频中闪过的 App 商店/更新日志背景文字（如 `BM08`、`WN02`），都是识别或抽样伪影，**绝对不得**据此提出「拼写错误 / 语法不完整 / 缺主语 / 型号混杂 / 单帧字多」类发现。',
  '3. **不许把「这段没有可读文字」写成问题。** 同上。',
  // ★ 2026-10-09（Owner：「守衡输出的没有视频的时间节点」）：原先只写「第几帧」，
  //   而输入里**根本没有帧号** ⇒ 模型只能编一个「帧 3」，或干脆写「（未给位置）」。
  //   措辞里有两条边界，都是**能力边界**，不许让模型以为它能给更多：
  //     · 视频**只能给到帧的时间码**（8 帧是**均匀抽样**，不是逐帧 ⇒ 时间码是「这附近」）；
  //     · **音轨转写没有词级时间戳**（`asr.mjs` 只回整段文本）⇒ 口播类问题**给不出秒数**，
  //       要它如实说「转写第 N 段 / 原句」，**不许编一个时间**。
  '4. 每条必须指得出**位置**与**理由**。位置按素材类型给：'
    // ★ 2026-10-09（Owner 第三次点：「还是没展示到几秒 **00:12 格式**没看到」）：
    //   这一句原先教的是「行首 `[12.34s]`，直接抄那个数」—— 而 `video.frameLine` 现在
    //   印的是 `[00:12]`（`MM:SS`，按整秒截断）。**两边必须同口径**：
    //   提示词里留着旧形状，模型就会照着旧形状"抄"一个 `[12.34s]` 回去。
    // ★★ 2026-10-20（Owner 选「先修位置再验证」）：位置一律落 PRD §5.3.3 的**三形态之一**，
    //   写法**逐字照抄、不许加括号补充**（2026-10-20 实测出现过 `图 1 正文末段` 这种形状）。
    + '图片 ⇒ `图 N 第 X 处`（N=第几张图、X=该图上的第几处，从 1 数）；'
    + '视频 ⇒ `视频 MM:SS`（抄行首 `[00:12]` 那种时间码的 `分:秒`，**不要带方括号**）；'
    + '文字 ⇒ `正文第 X 段`；'
    + '音轨转写**没有**时间戳 ⇒ **不许编一个秒数**：那句话若也出现在带时间码的帧读数里就用那个时间码，'
    + '否则这一条的 `location` 写 `null`（报告会印 `—`，那是诚实的）；'
    // ★ 2026-10-16：新增的那一节（带媒材时它叫「对方这条消息里写的字」）也要能定位 ——
    //   而且**它本身不是素材**：只在"对方的话与素材冲突/说明改哪里"时才引它。
    + '「对方这条消息里写的字」⇒ 给所在句子（**那不是素材本身**，是对方的提问/说明，'
    + '不要把它当成待审内容去挑毛病）。',
  '4b. ★ **每条都要给 suggestion：具体怎么改** —— 改哪个词、换成什么、删哪一句、补什么。',
  // ★★ 2026-10-19（Owner：「**审查报告中**，修改建议你写了200多字，修改建议 ≤30 字」；
  //   PRD §5.3.3「单条问题：…修改建议 ≤30 字」）——
  //   这一格是**报告**「修改建议」的上游来源（`sugModel`），上限必须在源头说清：
  //   渲染层 `_clip` 只是硬兜底 —— 源头写成 300 字，截出来的是半句诊断，不是动作。
  `    **≤${ADVICE_MAX} 字**（卡面与报告同一把尺）：一句可执行动作，不解释、不列 ①②③。`,
  '    不许写「转对应负责人复核」「请人工确认」「建议修改」这类**没有动作**的话：',
  '    收到它的人还是不知道改什么。写不出具体改法时，就写清**缺什么信息才能定**（例如',
  `    「需要知道投放的是哪个平台才能定这句话合不合规」）—— 那也是可执行的下一步，同样 ≤${ADVICE_MAX} 字。`,
  // ★★ 2026-10-17（Owner 裁定：报告的「问题描述」与「原因」必须分两格）———————
  //   PRD §8.3 的完整清单每条要 `维度 / 位置 / **问题描述** / **原因** / 依据文档链接 / 修改建议`，
  //   而我们此前只出一格 `reason` —— 现象、判据、后果全挤在那一句里，
  //   报告只能拿同一句同时顶替两格（实测 `merged-2026-10-16T02_05_22` 三条全这样）。
  //   ⇒ 现在分开：`description` 说**是什么现象**，`reason` 说**为什么算问题**。
  //   ⚠️ 两格都必填 —— 空 `description` 会让报告那一格只能印「未给」，那不是要求。
  '4c. ★ **`description`（问题描述）与 `reason`（原因）必须分开写**：',
  '    · `description`：**哪里 + 什么现象** —— 让人一眼知道你说的是哪一处（**不写判据**）；',
  '    · `reason`：**为什么这是问题** —— 判据 / 危害 / 美国消费者会怎么误解；**不重复现象**。',
  '    ✗ 反例（两格写成一格）：reason 写「正文只有中文账号名、图上是 momcozY，两者对不上，',
  '      美国消费者读不懂也无法识别广告主」⇒ 现象与判据黏在一起，报告两格只能印同一句。',
  // ★★ 2026-10-19（Owner：「原因是不是没讲完？按 prd 要求的字数限制梳理重点输出，
  //   不能出现截断的场景」）——**这一格原先根本没写上限**。
  //   提示词只约束了「建议 ≤30」，于是模型写 65–80 字的原因，渲染层按 50 字硬切
  //   ⇒ Owner 在卡上看到「…而实际想表达的应是「只…」，读起来**像内容没写完**。
  //   源头写超，后面怎么切都是残句 —— 上限必须在**源头**说清，而不是靠渲染层补。
  //   ⚠️ 别写「写不下就用省略号」：那等于把截断合法化；写不下就**删枝节**。
  '4c2. ★ **`description` 与 `reason` 各自 ≤50 字**（PRD §5.3.3 硬约束，与建议 ≤30 同源）。',
  '    超了就会被按上限压，读者看到的是一个**被砍断的句子** ——「意思没讲完」比「少写一点」糟得多。',
  '    压法：一句只留**一层**意思（描述只说「在哪、什么现象」，原因只说「为什么算问题」），',
  '    不要把「现象＋判据＋后果」三层挤进一句。**不许用「…」自己截**，写不下就删枝节。',
  '    合格示例（描述 24 字 / 原因 27 字）：「功能标签「24H」未说明所指时长」／',
  '    「消费者会读成 24 小时持续灭菌，属无依据的功效承诺」。',
  // ★★ 2026-10-17 第十二轮（Owner 同意）：**`excerpt` 必须逐字引用原文**。
  //   病灶（真件 `merged-2026-10-17T03_47_40`）：报告总览表有一列「命中描述」专门印原文，
  //   而模型侧**整批都没给 `excerpt`**（把原文塞进了 `location` 的「…」里，或者干脆没写）
  //   ⇒ 那一列印出来是「该句以…」「该句用…」（模型写的**描述**），
  //   图片/视频条目更是整列 `—`（因为画面问题本来就没有"原文"这一格）。
  //   ⇒ 现在把这一格的要求写死，并**明确禁止拿描述冒充原文**。
  '4d. ★ **`excerpt` 这一格必须逐字引用原文** —— 报告里有一列只印它（读者拿它跟素材对照）。',
  '    · 文字 / 口播：抄**原句**，不要改写、不要加省略号、不要翻译、不要只写关键词。',
  // ★★ 2026-10-17 第十三轮（Owner：「报告里面有表格，若是图片和视频，位置和命中描述要怎么写？」）——
  //   上一版这里写的是「抄画面里看得见的那串**字或读数**」——**「读数」是错的**：
  //   读数（「画面里有婴幼儿出镜」「男性站在水槽边」）是**别人替你看图写的描述**，
  //   不是素材上真实存在的字。把它印进「命中描述」那一列，读者会以为素材里真那么写。
  '    · **图片 / 视频：只抄"素材上真实存在的东西"** ——',
  '      ① **图上印的字 / 帧上印的字**（OCR 读到的）：`37°`、`momcozY`、`hospital grade`、',
  '         `Only the detachable parts are washable`；',
  '      ② **口播说出口的原句**（转写原文）。',
  '    · ⚠️ **画面读数不算原文**：「有婴幼儿出镜」「男性在水槽边冲水」这类是**读数/描述**，',
  '      不是素材上的字 —— 它们应该写进 `description`（问题描述），**不许写进 `excerpt`**。',
  '      这类问题 `excerpt` 就写 `null`（报告那一格印 `—`，那是诚实的）。',
  '    · **位置**按模态给：图片给**图上区域**（`主视觉` / `右上角贴片` / `包装正面`）；',
  '      视频给**帧时间码**（`[00:12]`）或 `转写第 N 段`；文字给**所在句子**。',
  '    · ⚠️ 不要把**描述**当原文（「该句以模糊数据支撑功效」是描述，不是原文）；',
  '      也不要把 `location` 再抄一遍。',
  '    · ⚠️ 画面里**确实没有可引的文字**（纯动作 / 构图 / 摆放问题）⇒ 写 `null`，',
  '      **不许编一串字出来** —— 编出来的"原文"比空格更坏：读者会以为素材里真那么写。',
  '5. 你出的每一条都**没有库内依据** —— 所以它最高只能到 REVIEW，不要给 BLOCK。',
  '',
  // ★ 2026-10-13（Owner）：「模型侧输出的问题，需要带上依据。写『无库内依据』，
  //   那就放模型侧能查到的依据链接」—— 于是每条要多给一格 `source`：
  //   **只能从下面这 17 个已登记来源里挑一个 id**，链接由代码挂。
  //   ⚠️ **不许自己写 URL**：幻觉链接比空格更坏（写了也会被解析侧丢掉，见 `ext_basis.resolveSourceId`）。
  // ★★ 2026-10-13（Owner 亲口）：「模型侧的问题模型**当然有权限写 url**」——
  //   我先前那条「只许挑闭集 id、不许写 URL」是**我自己定的、而且过头了**：
  //   模型侧的依据本来就在库外（平台政策/监管指引），不许它给 URL 等于掐掉最有用的一条。
  //   现在两条路都开着，**核验由代码做**：登记来源每天被 verify_external 复核；
  //   自写 URL 由本机探一次，卡片上照实标「已核 / 本机取不到 / 未核」。
  '6. ★★ **每一条都必须交代依据**（Owner 2026-10-13：「必须带依据的 url」）。',
  '   实测过：写成「给不出就写 null」时，同一条素材有时给依据、有时全给 null ——',
  '   而**一条没有依据的问题，读的人除了信或不信没有第三条路**。所以这一格现在**必填**：',
  '   图片的直接观察例外：若只描述原图可见事实/图文语义，不作规范违规断言，',
  '   `source`/`source_url` 可为 null，但必须给 `evidence_basis:"image_observation"` 和可定位的 `visual_anchor`。',
  '   ⚠️ 2026-10-22：这个例外只覆盖**纯画面事实**（姿势/物件状态/排版/水印位置）。',
  '   凡是「资质 / 年限 / 背书 / 功效 / 对比」这类**要有外部文档才立得住**的，',
  '   即使发生在图片上也**必须挑一个登记来源或给可核 URL**；报告那一格不会再把素材原文当依据印出来。',
  '   其他类型实在找不到依据 ⇒ 这条不要报；不得用占位来源冒充依据。',
  '   · `source`：如果这条判断落在某个**已登记来源**上，挑它的 id（闭集，挑不出写 `null`）；',
  '   · `source_url` + `source_name`：如果依据是闭集之外的公开规则（平台政策页、监管页面等），',
  '     **把 URL 原样写出来** —— 我会替你探一次并在卡片上标出「已核 / 本机取不到 / 未核」。',
  '     ⚠️ 只写你**确实知道**的那个地址；不确定就写 `null`，不要拼一个看起来像的。',
  '   ' + sourceMenuLines().join('\n   ').trimStart(),
  '',
  // ★★ 2026-10-14（Owner）：**模型侧只出美国市场的问题**。
  //   实测病灶（176 份合并报告 · 模型侧 685 条全扫，2026-10-14 核）：
  //     · 18 条按**中国口径**给结论。最硬的一条把中国《广告法》当判据 ——
  //       `merged-2026-10-12T08_56_07` 的模型侧写「『最好的吸奶器』属绝对化最高级表述，
  //       广告法明令禁止…极限用语」，而**同一份报告**的库侧写着
  //       「best/#1/No.1/最佳/最好…按 2026-09-09 口径放开，**海外广告允许，不再判险**」
  //       ⇒ 同一单的两轨结论**相反**。
  //     · 根因：`SYSTEM` 里从来没写过区域（美国/US/market 零命中），模型只能按
  //       「通用语义＋平台惯例」判 ⇒ 素材一有中文线索（中文社群 / 中文文件名 / WhatsApp 流转）
  //       就滑向中国。
  //   ⚠️ 最后那条分界**不能删**：本口径是「**落在**美国市场」，不是「不许出现外国」——
  //     实测另有 8 条（英国奖项摆在美国站…）落点本就是美国消费者，是**真问题**；
  //     少了这一句，模型会把它们一起删掉。这正是 Owner 2026-10-14 选的读法。
  '7. ★★ **本项目只审美国市场**（PRD 第一阶段范围）。你出的每一条都必须落在**美国市场口径**内：',
  '   判据取自**美国法规、美国平台政策**，或**「美国消费者会怎么理解」**。',
  '   · **不得援引非美国市场的合规要求** —— 中国《广告法》与「极限用语」、医疗器械广告审查批准文号、',
  '     GB 国标、英国 MHRA / ASA-CAP、欧盟法规等，**都不是本项目的判据**；也不要建议',
  '     「补中文字幕」「换算北京时间」「确认小红书 / 朋友圈是否允许」这类非美国市场的做法。',
  '   · ⚠️ 但**提到外国不等于跑题**：素材里出现外国实体（英国奖项徽章、境外平台）时，',
  '     **只要落点写的是它对美国消费者 / 美国平台的影响**，那就是美国市场的问题，照常提。',
  '     分界：**「英国奖项摆在美国站、美国消费者会误读」＝ 该提**；',
  '     **「不符合英国 CAP Code」＝ 不该提**。',
  '',
  '输出：**只输出一个 JSON 数组**，不要解释、不要 markdown 代码块。每项形如',
  '{"location":"帧 3","category":"消费者安全","severity":"REVIEW","nature":"强制",',
  ' "description":"问题描述：哪里 + 什么现象（一句话，不写判据）",',
  ' "reason":"原因：为什么这是问题（判据/危害）",',
  ' "excerpt":"逐字引用的原文","suggestion":"具体怎么改（改哪个词/换成什么/删哪句/补什么）",',
  ' "taxonomy_category":"所属类别（只能取下面 12 类之一；拿不准就写「未归类」）",',
  ' "taxonomy_subcategory":"所属子类（只能取该类子类清单里的一个；对不上写 null）",',
  ' "source":"S11 或 null","source_url":"https://… 或 null","source_name":"来源名 或 null",',
  ' "evidence_basis":"image_observation 或 external_source","visual_anchor":"图 1：可直接看到的事实/关系；非图片可为 null"}',
  `category 只能取：${CATEGORIES.join(' / ')}。`,
  // ★★ 2026-10-19（Owner：「最终输出的卡片态，**必须是 4 态**」）——
  //   PRD §5.3.2 的 SUGGEST 定义是「**存在非强制性问题**（措辞优化、轻微常识瑕疵、非核心卖点描述）」。
  //   而模型侧只给 `severity: BLOCK|REVIEW`，交给刚性合并时一律归 P1 ⇒ **SUGGEST 在生产里永远不可达**（卡片变不出第四态）。
  //   ⇒ 要它自己标一下这条到底是强制还是建议；**拿不准就写「强制」**（不把强制降级成建议，那是失真的方向）。
  '★ `nature` 只能取两个值：',
  ' · `"强制"` —— 不改就不能发（红线/违规/证据确凿的话术）；',
  ' · `"非强制"` —— **措辞优化、轻微常识瑕疵、非核心卖点描述**（PRD §5.3.2 的 SUGGEST 定义）；',
  '   这一类**不阻断发布**，只提示内容方优化。',
  ' ⚠️ 只有**一律非强制**、且没有任何强制项时，整单才会落 SUGGEST；',
  '   混进一条强制项，结论就会升到 REVIEW/BLOCK（单调性）。拿不准就写 `"强制"`。',
  // ★★ 2026-10-19（Owner：「报告里都归类了，卡上却说未归类」）：**两条轴各司其职** —
  //   `category` 是方向词（决定转谁），`taxonomy_category` 是**所属类别（12 类）**（决定卡面归类与汇总）。
  //   两个都要写；`taxonomy_category` 只能从这 12 个里选，拿不准写 `未归类`（**不许自造类名**）。
  `taxonomy_category 只能取这 12 个之一：${TAXONOMY_CLASSES.join(' / ')}。`,
  // ★★ 2026-10-19 第二次（Owner：「模型侧也需要归类，**跟知识库侧一样**」）：
  //   知识库侧的标签是 `所属类别-所属子类`；模型侧只给类别 ⇒ 卡面两种形状混着。
  //   ⇒ 子类也从固定清单里选（按类列出）；给不出就 null（卡面只印类别）。
  '`taxonomy_subcategory` 必须取自**你选的类别**的子类清单（下面按类列出）；对不上就写 null：',
  ...TAXONOMY_CLASSES.filter((c) => c !== '未归类').map(
    (c) => ` · ${c} → ${(TAXONOMY_SUBCLASSES[c] || []).join(' / ')}`),
  '⚠️ 两格必须自洽：`taxonomy_subcategory` 属于你选的 `taxonomy_category`；对不上就整格 null',
  '   （**不许自造子类名**，也不许跨类乱填）。',
].join('\n');

/**
 * Remove channel-only wrapper text from image reviews while preserving a real
 * user focus (for example, "这张能发吗" or a named safety question).
 */
export function canonicalImageAuditRequest(text = '') {
  const cleaned = String(text ?? '').replace(/^\s*\[图片\]\s*/u, '')
    .replace(/^\s*@守衡\s*/u, '').trim();
  const key = cleaned.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  const generic = new Set([
    '审查下这张图片', '审查下这张图', '审查一下这张图片', '审查一下这张图',
    '审一下这张图片', '审一下这张图', '审核下这张图片', '审核下这张图',
    '审核一下这张图片', '审核一下这张图', '检查下这张图片', '检查下这张图',
    '检查一下这张图片', '检查一下这张图', '帮我审一下这张图片', '帮我审一下这张图',
    '帮我审核一下这张图片', '帮我审核一下这张图', '帮我看下这张图片', '帮我看下这张图',
    '帮我看一下这张图片', '帮我看一下这张图', '看下这张图片', '看下这张图',
    '看一下这张图片', '看一下这张图', '看看这张图片', '看看这张图',
    '请审查这张图片', '请审查这张图', '审查图片', '审查图', '审核图片', '审核图',
    '审查一下', '审查下', '审一下', '审核一下', '审核下', '检查一下', '检查下',
    '看一下', '看下', '看看', '帮我审一下', '请审查', '请审核',
    'reviewthisimage', 'pleasereviewthisimage', 'auditthisimage', 'pleaseauditthisimage',
  ]);
  return generic.has(key) ? '' : cleaned;
}

/**
 * 拼给模型侧的那一段（**纯函数** —— 喂样本就能断言，不必真调模型）。
 * @param {{readings?:string, question?:string}} a
 * @returns {string}
 */
export function buildPrompt({ readings = '', question = '', fixNote = '', hasImages = false } = {}) {
  const q = String(question ?? '').trim();
  const r = String(readings ?? '').trim();
  return [
    q ? `【对方的话】${q}` : '',
    hasImages ? '【原图已作为本次模型输入】请逐张直接观察；可以用 image_observation + visual_anchor 报告纯视觉/语义问题，无需编造法规依据。' : '',
    '【素材的文字层读数】',
    r || '（没有读到任何文字 —— 这种情况下应当返回空数组）',
    // ★ 2026-10-19：超字数重试时的**定向纠正**（每单最多追加一次，见 `reviewModelSide`）。
    //   为什么把纠正放在**输入末尾**而不是改系统提示词：系统提示词是稳定前缀（缓存友好），
    //   而这一句是**这一次**的问题（第几条、哪一格、超几字），换了单子就得换。
    String(fixNote ?? '').trim(),
  ].filter(Boolean).join('\n');
}

/**
 * 解析模型侧的输出（**纯函数**）。只接受完整顶层 JSON 数组（可带单个围栏），并**逐条验**：
 * 类目必须在闭集里、理由必须非空、严重度只认 BLOCK/REVIEW。
 *
 * ★ 丢掉几条要**报出来**（`dropped` / `parse_audit`），不许静默吞 —— 静默吞的后果是
 *   「模型侧明明报了 5 条，合并里只有 2 条」而没有任何东西说得清另外 3 条去哪了。
 *
 * @returns {{ok:boolean, findings:Array, dropped:Array, error:string|null}}
 */
/** URL 形状清洗：只认 http(s)、去掉控制字符、限长。**不做**「像不像真的」判断。 */
export function sanitizeUrl(v) {
  const u = String(v ?? '').trim().replace(/[\u0000-\u001f\u007f\s]+/g, '');
  if (!/^https?:\/\//i.test(u) || u.length > 500) return null;
  return u;
}


/**
 * **位置归一化**（2026-10-20 加）：把模型写法收成 PRD §5.3.3 的三形态之一。
 *
 * 真单读到的三种漂移（同一张图单里同时出现）：
 *   `图 1 第 2–3 处（主标题）`  ← 范围 + 括号补语
 *   `图 1 第 4 处（奖品说明句）` ← 括号补语
 *   `图片 1（#img.1）`          ← `图片` 前缀 + 内部坐标（kb 侧旧写法，模型偶尔照抄）
 * 这里**只做可证明不丢信息的三件事**：去括号补语、范围取首个、`图片 N`→`图 N`。
 * ⚠️ **不补** `第 X 处`：给不出处的就不许编一个（`图 1` 会被出口闸
 *   `kb/l8/material_evidence_gate.py` 判红，那正是要它响的场合）。
 */
export function normalizeLocation(v) {
  let s = String(v ?? '').trim();
  if (!s) return '';
  s = s.replace(/[（(][^（）()]*[）)]/g, '').trim();          // 去括号补语（可多段）
  s = s.replace(/第\s*(\d+)\s*[–—\-~～至]\s*\d+\s*处/g, '第 $1 处');  // 范围取首个
  s = s.replace(/^图片\s*(\d+)/, '图 $1');                   // 图片 N → 图 N
  // 视频帧时间码：`[00:12]` / `00:12` ⇒ `视频 00:12`（PRD 三形态里没有方括号那一版）
  s = s.replace(/^\[?(\d{1,2}):(\d{2})\]?$/, '视频 $1:$2');
  s = s.replace(/^视频\s*\[?(\d{1,2}):(\d{2})\]?$/, '视频 $1:$2');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

export function parseFindings(text, { allowVisualNoBasis = false } = {}) {
  const s = String(text ?? '');
  const parseAudit = { input_count: null, parsed_count: 0, retained_count: 0,
    structural_errors: [], exclusions: [] };
  const fail = (error) => ({ ok: false, findings: [], dropped: [], error, parse_audit: parseAudit });
  let payload = s.trim();
  // 仅接受完整顶层数组或一个 Markdown 围栏；不能把失败对象里的 findings:[] 当成功。
  if (payload.startsWith('```')) {
    const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(payload);
    if (!fenced || fenced[1].includes('```')) return fail('输出不是单个完整 JSON 数组围栏');
    payload = fenced[1].trim();
  }
  if (!payload.startsWith('[')) return fail(payload.includes('[')
    ? '输出必须是完整顶层 JSON 数组，不能从对象或说明文字中抽取发现' : '输出里没有 JSON 数组');
  const b = payload.lastIndexOf(']');
  // ★★ 2026-10-09 实测（Owner 那张夜间图）：**输出被截断时报错了方向。**
  //   日志写 `raw=1545 字`、首 100 字是 `"[\n {\n \"location\": …` —— 它**有**数组开头，
  //   只是**没有结尾**（额度用尽被腰斩），而判据把它报成「**输出里没有 JSON 数组**」⇒
  //   查的人会往「模型没照格式写」那个方向查，永远查不到真因（额度）。
  //   与 `raw=0` 那个坑（额度被 reasoning 烧光）是**同一个形状**：报错指向错误的方向。
  //   所以先判「有没有结尾」，再判「有没有开头」。
  if (b <= 0) {
    return fail(`输出**被截断**（有数组开头、没有结尾）—— 不是「没写数组」，`
               + `多半是额度用尽被腰斩｜raw=${s.length} 字`);
  }
  let arr;
  try { arr = JSON.parse(payload); } catch (e) {
    return fail(`JSON 解析失败：${e?.message ?? e}`);
  }
  if (!Array.isArray(arr)) return fail('解析出来不是数组');
  parseAudit.input_count = arr.length;

  const findings = []; const dropped = [];
  const invalid = (i, why) => {
    parseAudit.structural_errors.push({ index: i, reason: why });
    dropped.push({ i, why, kind: 'structure_error' });
  };
  for (const [i, raw] of arr.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      invalid(i, '发现条目不是对象'); continue;
    }
    const wrongType = ['location', 'category', 'reason', 'description', 'suggestion', 'excerpt',
      'severity', 'nature', 'taxonomy_category', 'taxonomy_subcategory', 'source', 'source_url',
      'source_name', 'evidence_basis', 'visual_anchor']
      .find((key) => raw[key] != null && typeof raw[key] !== 'string');
    if (wrongType) { invalid(i, `字段 ${wrongType} 必须是文本`); continue; }
    const reason = String(raw?.reason ?? '').trim();
    // ★★ 2026-10-20（真单：那单图片报告里 `⚠ 解析丢掉 1 条：类目不在闭集："AI披露"`）——
    //   闭集里写的是 `'AI 披露'`（**带空格**），模型给的是 `'AI披露'`（无空格）⇒ `includes` 判假
    //   ⇒ **整条被丢**；而那张图的画面读数里正写着「画面有合成痕迹」，AI 披露恰恰是最该报的一条。
    //   丢的是**空格**，不是问题本身 ⇒ 进闭集前统一归一化（去所有空白，含全角；拉丁不分大小写）。
    //   ⚠️ 归一化只做「空格/大小写」这一类**零语义差别**的收口，**不**做同义词映射：
    //     把 `合规` 收成 `消费者安全` 那种才是真改判定。
    const _canonCat = (s) => String(s ?? '').replace(/[\s\u3000]+/g, '').toLowerCase();
    const rawCat = String(raw?.category ?? '').trim();
    const rawTaxonomy = String(raw?.taxonomy_category ?? '').trim();
    const taxonomyCategory = TAXONOMY_CLASSES.includes(rawTaxonomy)
      ? rawTaxonomy
      : (TAXONOMY_CLASSES.includes(rawCat) ? rawCat : null);
    const rawTaxonomySubcategory = String(raw?.taxonomy_subcategory ?? '').trim();
    const hitCategory = CATEGORIES.find((c) => _canonCat(c) === _canonCat(rawCat));
    // 模型偶尔把 A3 所属类别写进 `category`（方向类目）字段。此前闭集直接丢整条，
    // 线上一张图 4 条 KB 参考中有 3 条因此没有进入合并结果。保留原始输入并映射到
    // 最宽且不虚构的方向；所属类别仍按 A3 闭集展示。未知自由文本仍照旧 fail-closed。
    const category = hitCategory
      ?? routeCategoryFromTaxonomy(taxonomyCategory, rawTaxonomySubcategory)
      ?? rawCat;
    if (!reason) { invalid(i, '理由为空'); continue; }
    // ★★ 2026-10-27（Owner：「输出问题中包含了『全图带内部个人署名水印「Owner 5615 ROOT」』这不是问题，类似的水印都要去掉」）：
    //   截图层/文档层水印（用户名 + 工号 + ROOT 等）不是素材本身的设计内容，一律在解析层拦截并留痕。
    if (/内部个人署名水印|个人署名水印|5615\s*ROOT|Owner|截图层水印|飞书水印/.test(`${reason} ${String(raw?.description ?? '')} ${String(raw?.excerpt ?? '')}`)) {
      const why = '截图/文档层内部署名水印 —— 不是素材内容问题，按规过滤';
      dropped.push({ i, why, kind: 'rule_exclusion' });
      parseAudit.exclusions.push({ index: i, rule: 'screenshot_watermark', reason: why });
      continue;
    }
    if (!CATEGORIES.includes(category)) { invalid(i, `类目不在闭集：${JSON.stringify(category)}`); continue; }
    // ★★ 2026-10-19（Owner：「依据：必须要提供依据，为问题做支撑」）：
    //   既没有外部标准 id、也没有可核 URL ⇒ 打 `basis_missing` 标记，**由展示层决定不上卡**
    //   （不在这里丢：解析层丢会让「模型报了什么」这个读数消失，也把判据一起打穿 ——
    //    第一版就丢在这，`model_side_taxonomy` 的 4 条夹具当场全红）。
    // ★★ 2026-10-20（真单 AD-20261020-006 那张卡）：「有依据」= **能解析出登记来源**，不是"字段非空"。
    //   病灶：原先只看 `String(source).trim()` 是否非空 ⇒ 提示词教的占位值 `source:"none"`
    //   也算「有依据」⇒ `basis_missing=false` ⇒ 展示层过滤器放行 ⇒ 卡面印出
    //   「依据：独立语义复核（非条款依据，需人工核对）」—— 而那句正是
    //   Owner 2026-10-19 明令不许出现的自我否定（判它在、又说它没依据）。
    //   判据与渲染侧**同一把尺**：`resolveSourceId()`（闭集 S1–S17，见 `ext_basis.mjs`）。
    //   URL 落在 `source` 里（模型写错格）⇒ 也算有依据，并在下面归一化进 `source_url`。
    const _srcRaw = String(raw?.source ?? '').trim();
    const _srcIsUrl = /^https?:\/\//i.test(_srcRaw);
    const _hasBasis = _srcIsUrl || !!resolveSourceId(_srcRaw)
      || /^https?:\/\//i.test(String(raw?.source_url ?? ''));
    const visualAnchor = String(raw?.visual_anchor ?? '').trim();
    const visualBasis = allowVisualNoBasis
      && String(raw?.evidence_basis ?? '').trim() === 'image_observation'
      && visualAnchor.length >= 5;
    const sev = String(raw?.severity ?? '').trim().toUpperCase();
    findings.push({
      input_index: i,
      // ★★ 2026-10-20：位置先归一化（去括号/范围取首个）——模型侧三种漂移在真单里同时出现过。
      location: normalizeLocation(raw?.location) || '（未给位置）',
      category,
      // 「不由它单独定 BLOCK」在**合并**那一步执行（`dual_track.mergeFindings`）；
      // 这里如实记下它原本要的严重度 —— 不假装它没说过（§2.4.1：读数不许比输入小）。
      severity: sev === 'BLOCK' ? 'BLOCK' : 'REVIEW',
      // ★★ 2026-10-19（Owner：「卡片态必须是 4 态」）：`advisory` = PRD §5.3.2 的**非强制**
      //   （措辞优化 / 轻微常识瑕疵 / 非核心卖点描述）。
      //   它决定这条有没有资格去 P3（⇒ 整单可能落 SUGGEST）。
      //   ⚠️ 缺省 / 写错 / 不认识 ⇒ **mandatory**（不把强制降级成建议，那是失真方向）。
      // ★★ 2026-10-19（Owner：「这句判断是 review，不是 suggest」——
      //   真单：模型自己写的原因里明说「**它不构成健康或安全宣称，不改也能发布**，但表达效果较弱」，
      //   而 `nature` 却标了「强制」⇒ 整单落 REVIEW。**自述与自报打架时，以内容为准**：
      //   reason/description 里出现「不改也能发布 / 不影响发布 / 不阻断 / 非强制 / 表达效果较弱」
      //   这类**非强制信号** ⇒ 判 advisory，并把「自报了什么」留在 `nature_overridden`（不静默改）。
      //   ⚠️ 方向是单向的：只把**自述为非强制**的改成 advisory；**绝不**把自述「强制」的降级。
      // 依据缺失标记：卡面据此不列这一条（PRD §5.3.3 要求每条可引）
      basis_missing: !_hasBasis && !visualBasis,
      basis_kind: visualBasis ? 'visual_observation' : (_hasBasis ? 'external_source' : 'none'),
      evidence_basis: visualBasis ? 'image_observation' : (_hasBasis ? 'external_source' : null),
      visual_anchor: visualBasis ? visualAnchor : null,
      nature: (() => {
        const selfN = String(raw?.nature ?? '').trim() === '非强制' ? 'advisory' : 'mandatory';
        const text = `${reason} ${String(raw?.description ?? '')}`;
        const selfAdvisory = /不改(?:也|都)?能(?:发布|发|上线)|不影响(?:发布|上线)|不阻断|非强制|表达效果(?:较|偏)弱|属于建议优化/.test(text);
        if (selfN === 'mandatory' && selfAdvisory) return 'advisory';
        return selfN;
      })(),
      nature_asked: raw?.nature == null ? null : String(raw.nature).slice(0, 20),
      // 自报与内容不一致时留痕（给了什么、被怎么判），事后查得到
      nature_overridden: (() => {
        const selfN = String(raw?.nature ?? '').trim() === '非强制' ? 'advisory' : 'mandatory';
        const text = `${reason} ${String(raw?.description ?? '')}`;
        const selfAdvisory = /不改(?:也|都)?能(?:发布|发|上线)|不影响(?:发布|上线)|不阻断|非强制|表达效果(?:较|偏)弱|属于建议优化/.test(text);
        return (selfN === 'mandatory' && selfAdvisory)
          ? '自报强制，但原文明说「不改也能发布」⇒ 按非强制处理' : null;
      })(),
      reason,
      // ★★ 2026-10-17：**问题描述单列一格**（与 `reason` 分开，见上面提示词 4c）。
      //   缺了**不丢整条**（它是报告的一格，不是判定依据）⇒ 置 null，
      //   由渲染层如实说「未给问题描述」。⚠️ **不把 `reason` 搬过来顶上** ——
      //   那等于自己又把两格合成一格，而且是在源头上造假。
      description: String(raw?.description ?? '').trim() || null,
      // ★★ 2026-10-19（A3 12 类）：**只认枚举里的**；不在枚举里 ⇒ null（渲染层落「未归类」）。
      //   落 null 时把模型原话留在 `taxonomy_asked`（查得到它写了什么，不静默吞掉）。
      taxonomyCategory,
      taxonomy_asked: raw?.taxonomy_category == null ? null
        : String(raw.taxonomy_category).slice(0, 40),
      // ★★ 2026-10-19 第二次：子类**必须属于已校验通过的类别**；否则 null（不跨类、不自造）。
      taxonomySubcategory: (() => {
        const t = taxonomyCategory;
        const sub = rawTaxonomySubcategory;
        if (!TAXONOMY_CLASSES.includes(t) || !sub) return null;
        return (TAXONOMY_SUBCLASSES[t] || []).includes(sub) ? sub : null;
      })(),
      taxonomy_sub_asked: raw?.taxonomy_subcategory == null ? null
        : String(raw.taxonomy_subcategory).slice(0, 40),
      category_asked: raw?.category == null ? null : String(raw.category).slice(0, 60),
      excerpt: String(raw?.excerpt ?? '').trim() || null,
      // ★ 2026-10-09：模型侧的**可执行改法**（Owner：「不要甩给人」）。
      //   缺了不丢整条（它是补充信息，不是判定依据）；但为空时置 null，
      //   由渲染层如实说「两侧都没给修改建议」，**不许**替它编一句。
      suggestion: String(raw?.suggestion ?? '').trim() || null,
      // ★ 2026-10-13：依据来源 —— 只认**闭集里真有的** id（`resolveSourceId` 会把
      //   模型手写的 URL、乱码、不在表里的 id 一律折成 null）。链接由渲染层挂。
      source: resolveSourceId(raw?.source),
      source_asked: raw?.source == null ? null : String(raw.source).slice(0, 60),
      // ★ 模型自己给的 URL：**照收**（Owner：它有权限写）。这里只做形状清洗，
      //   「可不可信」交给 `probeUrl` 探一次，结论由渲染层如实标出。
      source_url: sanitizeUrl(raw?.source_url) || (_srcIsUrl ? sanitizeUrl(_srcRaw) : null),
      source_name: String(raw?.source_name ?? '').trim().slice(0, 80) || null,
      basis: 'model',      // 无库内依据
    });
  }
  // ★ 依据交代情况**如实报出来**（Owner 要的「必须带依据」在这条路上才看得见成效）：
  //   给 id 或 URL 算「交代了」；`none` / null 算「没给」。
  const noBasis = findings.filter((f) => !f.source && !f.source_url).length;
  parseAudit.parsed_count = findings.length;
  parseAudit.retained_count = findings.length;
  const ok = parseAudit.structural_errors.length === 0;
  return { ok, findings, dropped, raw_items: arr, parse_audit: parseAudit,
           error: ok ? null : `模型发现结构不完整：${parseAudit.structural_errors.map((x) => `第 ${x.index + 1} 条 ${x.reason}`).join('；')}`,
           basis: { total: findings.length, with_source: findings.length - noBasis, without: noBasis } };
}

/**
 * 哪几条超了 PRD §5.3.3 的字数上限（描述/原因 ≤50、建议 ≤30）。
 *
 * ★ 2026-10-19（Owner 裁定第 2 步）：判据**只从 `prd533-constraints.yaml` 读**，
 *   这里不写死 50/30 —— 写死就成了第四个「数法」（本文件已经因为三套数法栽过）。
 *   ⚠️ 字段名映射：提示词里改法那一格叫 `suggestion`，PRD 口径里叫「修改建议」。
 */
export function overLimitOf(findings = []) {
  const rows = [];
  const list = Array.isArray(findings) ? findings : [];
  list.forEach((f, i) => {
    const r = prd533Fields({
      description: f?.description,
      reason: f?.reason,
      advice: f?.suggestion,
    });
    const bad = r.rows.filter((x) => !x.ok);
    if (bad.length) rows.push({ index: i + 1, bad });
  });
  return rows;
}

/** 超这么多字以上才值得重试一次（1–2 字是数法边界，为它白烧一次调用不值）。 */
const OVER_LIMIT_SLACK = 3;

/**
 * 超字数重试的**时间预算**（毫秒）。
 *
 * ★★ 2026-10-19（Owner 的硬约束：「**你的所有修复，不能影响工作流**」）——
 *   这一条就是为它加的。重试 = **再一次完整 LLM 调用**，实测一次 7–10 s。
 *   模型侧是**与送审链并行**跑的那一路，它晚到 10 s 不会让链本身变慢，
 *   但会**拖后落表与发卡** —— 那就是在影响工作流了。
 *
 *   所以：第一轮已经花掉超过这个预算 ⇒ **不重试**。宁可让卡面那一处被压，
 *   也不拿业务正在等的时间去换一句更完整的原因。
 *   （判据 `model_side_limit.test.mjs` ⑨ 钉着：超预算 ⇒ 一次都不多调。）
 */
const OVER_LIMIT_RETRY_BUDGET_MS = Number(
  process.env.SHOUHENG_OVERLIMIT_RETRY_BUDGET_MS ?? 25000);

/**
 * `overLimitOf` 的**生产用包装**：fail-open。
 * `prd533` 的 yaml 读不到时 `checkFields` 会抛 —— 那是**辅助判据**，
 * 绝不许因为这个把模型侧整条丢掉（`try/catch` 之后返回空 = 不重试，照原样往下走）。
 */
function overLimitSafe(findings) {
  let rows;
  try { rows = overLimitOf(findings); } catch { return []; }
  return rows
    .map((r) => ({ ...r, bad: r.bad.filter((b) => (b.over ?? 0) > OVER_LIMIT_SLACK) }))
    .filter((r) => r.bad.length);
}

function excludeFindings(parsed, predicate, rule, reason) {
  const removed = parsed.findings.filter(predicate);
  if (!removed.length) return parsed;
  const findings = parsed.findings.filter((f) => !predicate(f));
  return { ...parsed, findings, parse_audit: { ...parsed.parse_audit,
    retained_count: findings.length,
    exclusions: [...parsed.parse_audit.exclusions,
      ...removed.map((f) => ({ index: f.input_index, rule, reason }))] } };
}

/** 字数重写只允许指定超限格变化；其他原始字段、顺序、条目必须相同。 */
function lengthRewriteFailure(before, after, over) {
  if (!after.ok) return after.error || '重写结果未完成解析';
  if (before.raw_items.length !== after.raw_items.length
      || before.findings.length !== after.findings.length) return '重写改变了发现条数';
  if (!isDeepStrictEqual(before.findings.map((f) => f.input_index),
                        after.findings.map((f) => f.input_index))) return '重写改变了保留条目';
  const allowed = new Map(over.map((row) => [before.findings[row.index - 1].input_index,
    new Set(row.bad.map((b) => b.key === 'advice' ? 'suggestion' : b.key))]));
  // 文本压缩还可能改变派生字段（如 reason 中“非强制”把 nature 降级），同样不能采用。
  for (let i = 0; i < before.findings.length; i++) {
    const a = before.findings[i]; const b = after.findings[i];
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!allowed.get(a.input_index)?.has(key) && !isDeepStrictEqual(a[key], b[key])) {
        return `第 ${i + 1} 条解析后的字段 ${key} 发生变化`;
      }
    }
  }
  for (let i = 0; i < before.raw_items.length; i++) {
    const a = before.raw_items[i]; const b = after.raw_items[i];
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (allowed.get(i)?.has(key)) {
        if (typeof b[key] !== 'string' || !b[key].trim()) return `第 ${i + 1} 条 ${key} 被清空`;
      } else if (!isDeepStrictEqual(a[key], b[key])) {
        return `第 ${i + 1} 条未获准改写的字段 ${key} 发生变化`;
      }
    }
  }
  const stillOver = overLimitOf(after.findings);
  for (const row of stillOver) {
    const keys = allowed.get(after.findings[row.index - 1].input_index);
    if (row.bad.some((b) => keys?.has(b.key === 'advice' ? 'suggestion' : b.key))) {
      return `第 ${row.index} 条指定改写字段仍超限`;
    }
  }
  return null;
}

/**
 * 跑模型侧那一遍。
 *
 * @param {{readings:string, question?:string, ask:Function, maxTokens?:number}} a
 *        `ask` 注入（`llm.ask`）—— 生产用它，测试喂桩。
 * @returns {Promise<{ok:boolean, findings:Array, raw?:string, dropped?:Array, ms:number, error?:string}>}
 */
// ★ 2026-10-06 实测：`maxTokens = 1200` 时**正文 0 字**（`raw.length === 0`），
//   报的是「输出里没有 JSON 数组」—— 看起来像模型不听话，其实是**额度被 reasoning 烧光了**。
//   同一个提示词、同一张图：1200 ⇒ 0 字 / 6565ms；4000 ⇒ 1038 字 / 5 条 finding / 8886ms。
//   这就是内核里记过的那个病（`agent.mjs` 的「模型烧光额度没写出正文」），
//   所以这里默认给 4000 并**在日志里报 raw 长度** —— 空正文与「没报问题」必须长得不一样。
// ★ 2026-10-09 实测：`maxTokens=4000` 时输出被**腰斩**（`raw=1545 字`、有 `[` 无 `]`）
//   ⇒ 从 4000 提到 8000，并在下面加了「截断就重试一次」。
export async function reviewModelSide({ readings, question = '', imagePaths = [], requiredImageCount = 0, ask, maxTokens = 8000,
                                        // ★ 2026-10-19：时间预算可注入（判据要在**不睡 25 秒**的前提下验它）。
                                        //   生产不传 ⇒ 用 `OVER_LIMIT_RETRY_BUDGET_MS`。
                                        retryBudgetMs = OVER_LIMIT_RETRY_BUDGET_MS } = {}) {
  const t0 = Date.now();
  const audit = { schema: 'model-review-audit/v1', selected_attempt: null, attempts: [],
    rewrite: { attempted: false, accepted: false, reason: null } };
  const imageList = Array.isArray(imagePaths) ? imagePaths.filter(Boolean) : [];
  if (Number(requiredImageCount) > imageList.length) {
    return { ok: false, findings: [], ms: Date.now() - t0, audit,
      error: `原图未完整交给模型侧（要求 ${Number(requiredImageCount)} 张，实际 ${imageList.length} 张）` };
  }
  const noRead = !String(readings ?? '').trim() && imageList.length === 0;
  // 「没读到任何文字」时**不调模型**：那是确定性的事实，问一次模型只会换来编造。
  if (noRead) return { ok: true, findings: [], ms: 0, audit, skipped: '文字层是空的 —— 模型侧无需跑，也不会编' };
  if (typeof ask !== 'function') return { ok: false, findings: [], ms: 0, audit, error: '没有可用的 llm.ask' };
  try {
    // ★ 2026-10-16：**判定这一跳必须确定** —— 温度 0（原先吃 `ask` 的默认 0.2，
    //   实测同一条素材两次跑出的问题零重合）。见 `llm.mjs::ask` 那段注释。
    const prompt = buildPrompt({ readings, question, hasImages: imageList.length > 0 });
    // 推理模型的 max_tokens 同时覆盖 reasoning 与正文；曾实测 reasoning 烧完整个预算，正文为 0。
    // 模型侧需要结构化结论，禁用隐藏推理预算，避免“请求成功但空正文”伪装成格式错误。
    const askOptions = { system: SYSTEM, maxTokens, temperature: 0,
      ...(imageList.length ? { imagePaths: imageList } : {}), thinking: { type: 'disabled' } };
    // OCR 判据只把“重复平铺”形状标成截图层水印。若模型仍把同一水印列为隐私/遮挡/误认问题，
    // 从最终 findings 中确定性排除；没有该来源标记时不滤，保留对真实成品水印的审查。
    const hasScreenshotWatermark = imageList.length > 0
      && /【图\s*\d+\s*的截图层水印判读】/.test(String(readings ?? ''));
    const removeScreenshotWatermarkFindings = (parsed) => {
      if (!hasScreenshotWatermark || !parsed?.ok || !Array.isArray(parsed.findings)) return parsed;
      const isWatermarkOnly = (f) => /水印|watermark/i.test([
        f?.description, f?.reason, f?.suggestion, f?.excerpt, f?.visual_anchor,
      ].filter(Boolean).join(' '));
      const filtered = excludeFindings(parsed, isWatermarkOnly, 'screenshot_watermark',
        'OCR 已判为截图层水印，按规排除');
      const removed = parsed.findings.length - filtered.findings.length;
      if (removed) console.log(`[agent] 🧹 OCR 已判为截图层的水印相关发现 ${removed} 条不计入素材问题`);
      return filtered;
    };
    // ★★ 2026-10-26（Owner：「The Crib CEo 这个图片上明明是大写」）：
    //   确定性过滤图片单里仅挑剔「字母大小写格式」（如 `CEo`→`CEO`、`momcozY`→`MOMCOZY`）的 OCR 伪影发现。
    //   判据：① 仅对图片单生效（`imageList.length > 0`）；
    //         ② 原因/描述/建议里明写「大写 / 小写 / 大小写」，或修改建议里的两个英文词**忽略大小写后完全相同**（如 `The Crib CEo` vs `The Crib CEO`）。
    const isVideoReading = /【视频\s*\d+\s*关键帧上的字/.test(String(readings ?? ''));
    const removeOcrCasingNoiseFindings = (parsed) => {
      if ((imageList.length === 0 && !isVideoReading) || !parsed?.ok || !Array.isArray(parsed.findings)) return parsed;
      const isCasingNoise = (f) => {
        const joined = [f?.description, f?.reason, f?.suggestion, f?.excerpt].filter(Boolean).join(' ');
        if (/写成小写|写成大写|大小写(?:不一致|不统一|错误|有误|混用|格式)|全大写|首字母(?:未|没有|应)大写/.test(joined)) {
          return true;
        }
        // 视频抽帧 OCR 常见单字符形近误读（Momeozy/Euiy/sol/cach/ilange）或 App 商店页滚屏背景文字（BM08/WNO2/Baby Sound/Moms first always）
        if (isVideoReading) {
          if (/\b(?:Momeozy|Euiy|ilange|letls|cach|motherhox|robuidste|SEISONED|Soune|BM08|WNO2|Baby\s*Sound)\b/i.test(joined)) {
            return true;
          }
          if (/拼成|拼写(?:有误|错误|不一致)|语法不完整|缺主语|口号堆砌|单帧文字过多|纯主观喜好/.test(joined) && f?.basis_missing) {
            return true;
          }
        }
        const sug = String(f?.suggestion ?? '');
        const quotes = [...sug.matchAll(/[「『“"']([A-Za-z0-9\s\-&.]{2,40})[」』”"']/g)].map((m) => m[1].trim());
        if (quotes.length >= 2 && quotes[0] !== quotes[1] && quotes[0].toLowerCase() === quotes[1].toLowerCase()) {
          return true;
        }
        return false;
      };
      const filtered = excludeFindings(parsed, isCasingNoise, 'ocr_casing_noise',
        '图片/视频 OCR 识别伪影或无依据主观挑刺，按规排除');
      const removed = parsed.findings.length - filtered.findings.length;
      if (removed) console.log(`[agent] 🧹 已过滤图片/视频 OCR 识别伪影或无依据主观挑刺发现 ${removed} 条`);
      return filtered;
    };
    const attempt = async (purpose, nextPrompt, options) => {
      let parsed; let raw = null;
      try {
        raw = String(await ask(nextPrompt, options) ?? '');
        parsed = removeOcrCasingNoiseFindings(removeScreenshotWatermarkFindings(
          parseFindings(raw, { allowVisualNoBasis: imageList.length > 0 })));
      } catch (e) {
        parsed = { ok: false, findings: [], dropped: [], error: String(e?.message ?? e),
          parse_audit: { input_count: null, parsed_count: 0, retained_count: 0,
            structural_errors: [], exclusions: [] } };
      }
      const number = audit.attempts.length + 1;
      audit.attempts.push({ number, purpose, raw, ok: parsed.ok, error: parsed.error,
        parse: structuredClone(parsed.parse_audit), selected: false });
      // 未收到输出时保持 raw 缺省；调用方用它区分传输失败与收到空正文。
      return { ...parsed, ...(raw === null ? {} : { raw }), attempt_number: number };
    };
    let p = await attempt('initial', prompt, askOptions);
    // ★ 2026-10-19：**重试预算只有一个**（截断 / 坏 JSON / 超字数 共用）。
    //   为什么：每多一次重试就多一整轮 LLM 调用，而 PRD §12 在给响应时间计时 ——
    //   一次超时被救回来、却把另一次拖成超时，等于把问题挪到别处。
    let retried = false;
    // ★★ 2026-10-09：**截断就重试一次**（额度翻倍）。不重试的话，一次腰斩就把模型侧整条丢掉，
    //   用户拿到的卡里只剩库侧条目 —— 实测那张夜间图就是这样（`raw=1545 字`、无结尾）。
    //   只对「截断」重试：真没写数组（散文）重试也没用，那是提示词问题，不该白烧一次。
    // ★★ 2026-10-17 第十三轮（真调用当场撞出来的）：
    //   **解析失败也要重试一次**，不只是「被截断」。
    //   实测：提示词加了两条规则后，一次真调用返回的 JSON 在第 7 行少了一个逗号
    //   （`Expected ',' or '}' after property value`）⇒ 不重试就**整条模型侧丢光**
    //   （卡上只剩库侧条目，而报告抬头还写着合并后的数）。第二次同样的输入就正常了。
    //   为什么不重试「没有 JSON 数组」那种：那是**没按格式写**（写了散文），重试大概率还是散文；
    //   而「坏 JSON」是**生成本身抖了一下**，同参数重采样大概率能拿到合法的。
    const _retryable = /被截断/.test(String(p.error ?? ''))
      || /JSON 解析失败/.test(String(p.error ?? ''));
    if (!p.ok && (_retryable || (imageList.length > 0 && typeof p.raw === 'string' && !p.raw.trim()))) {
      console.log(`[agent] ↻ 模型侧输出被截断，重试一次（额度 ${maxTokens} → ${maxTokens * 2}）`);
      p = await attempt('parse_retry', prompt, { ...askOptions, maxTokens: maxTokens * 2 });
      retried = true;
    }
    // ★★ 2026-10-19（Owner：「原因是不是没讲完？按 prd 要求的字数限制梳理重点输出，
    //   **不能出现截断的场景**」）—— **超字数也要重试一次**。
    //
    //   为什么必须在这里拦：渲染层按 50/30 字压，压出来的是**残句**
    //   （实测那张卡：「…而实际想表达的应是「只…」）。而「写超了」在源头**完全可修** ——
    //   把「第几条、哪一格、超了几字」告诉它，重写一遍就好，代价是一次调用；
    //   不修就是把一个可修的残句直接送到业务眼前。
    //
    //   三条边界（缺一条都会变坏）：
    //     ① 与截断/坏 JSON **共用同一次预算**（`retried`）—— 不许一单重试两次；
    //     ② 只在**超得明显**时重试（`OVER_LIMIT_SLACK`）—— 超 1–2 字是数法边界，
    //        为它白烧一次调用不值（PRD 只说 ≤N 字，没说「差一个字就重写」）；
    //     ③ **fail-open** —— 判据读不到就不重试，不许因为辅助判据丢掉整条模型侧。
    //     ④ ★ 2026-10-19（Owner：「**你的所有修复，不能影响工作流**」）：
    //        **第一轮已经超时预算就不重试**（`OVER_LIMIT_RETRY_BUDGET_MS`）。
    //        重试是又一轮 7–10 s 的调用，它拖的是**落表与发卡**的时间。
    //        「原因更完整」不值得让业务多等 —— 那是拿工作流的时延换文案质量。
    const _elapsed = Date.now() - t0;
    if (p.ok && !retried && _elapsed <= retryBudgetMs) {
      const over = overLimitSafe(p.findings);
      if (over.length) {
        const why = over.map((o) => `第 ${o.index} 条 `
          + o.bad.map((b) => `${b.label} ${b.chars} 字（上限 ${b.limit}）`).join('、')).join('；');
        console.log(`[agent] ↻ 模型侧超出 PRD §5.3.3 字数，重试一次：${why}`);
        const note = [
          '【上一版有格子超字数了 —— 只改这几格，其余一个字都不要动】',
          why,
          '请把它们压到上限以内：一句只留一层意思（描述只说现象、原因只说为什么），',
          '**不许**用「…」自己截断，写不下就删枝节。',
          '仍然返回**同样的 JSON 数组**：字段不变、条数不变、顺序不变、位置不变。',
          `上一版 JSON（仅改上述指定超限字段）：\n${p.raw}`,
        ].join('\n');
        const p2 = await attempt('length_rewrite', buildPrompt({ readings, question,
          hasImages: imageList.length > 0, fixNote: note }), askOptions);
        // ⚠️ 只有**重试确实成功**才用它；重试反而写坏了（坏 JSON / 被截断）就**保留第一版** ——
        //   否则「修字数」会把一条本来合格的模型侧结果换成坏的（这就是越修越坏的形状）。
        let rejection;
        try { rejection = lengthRewriteFailure(p, p2, over); }
        catch (e) { rejection = `重写完整性未验证：${e?.message ?? e}`; }
        audit.rewrite = { attempted: true, accepted: !rejection, reason: rejection };
        if (!rejection) p = p2;
        else console.log(`[agent] ⚠️ 超字数重试的输出不可用（${rejection}）⇒ 保留第一版`);
        retried = true;
      }
    }
    // ★ 2026-10-19：超预算而**没**重试也要看得出来 ——
    //   否则「这一条为什么没被压好」事后无从查（本仓的规矩：静默跳过比报错更坏）。
    if (p.ok && !retried && _elapsed > retryBudgetMs) {
      const overSkipped = overLimitSafe(p.findings);
      if (overSkipped.length) {
        console.log(`[agent] ⏱ 模型侧有超字数条目，但已耗时 ${_elapsed}ms > 预算 `
          + `${retryBudgetMs}ms ⇒ **不重试**（Owner：修复不能影响工作流）；`
          + '卡面会按上限压缩，逐条记录里 `truncated` 会如实标出来');
      }
    }
    // ★ 2026-10-13：模型自己写了 URL ⇒ 就地**探一次**（标出核验状态；不判「信不信」）。
    //   三条纪律：① **不阻塞结论**（探测失败只是标「未核」，不丢条目）；
    //   ② **有条数上限**（`MAX_PROBE`）——不能让 10 条 finding 拖出 10 次网络往返；
    //   ③ 只探 http(s)，探测结果进 `url_probe`，由渲染层如实印出来。
    if (p.ok && Array.isArray(p.findings)) {
      const targets = p.findings.filter((f) => f.source_url).slice(0, MAX_PROBE);
      if (targets.length) {
        const probes = await Promise.all(targets.map((f) => probeUrl(f.source_url)));
        targets.forEach((f, i) => { f.url_probe = probes[i]; });
        // 一行留痕：探了几条、各是什么状态 —— 「未核」不许静默（它会印在卡上）
        console.log('[agent] 🔗 依据链接核验：'
          + targets.map((f, i) => `${f.source_url} → ${probeLabel(probes[i])}`).join(' ｜ '));
      }
    }
    audit.selected_attempt = p.attempt_number;
    for (const row of audit.attempts) row.selected = row.number === p.attempt_number;
    return { ...p, audit, ms: Date.now() - t0 };
  } catch (e) {
    // 失败与真正零发现分开；已有尝试的原始输出仍留在审计中。
    return { ok: false, findings: [], audit, ms: Date.now() - t0, error: `${e?.message ?? e}` };
  }
}

/**
 * 把内核的媒材读数摊成**模型侧要看的文字层**（**纯函数**）。
 *
 * ★ 只给**文字层**：图上的字、关键帧上的字、音轨转写。
 *   画面本身不在这里 —— 这套系统看不到画面（PRD 把「视频深度识别」列为后续扩展），
 *   把「没有画面」喂进去只会换来模型编一段「画面描述」。所以这里给什么，
 *   提示词里就写死「不许评价画面」（见 `SYSTEM`）。
 */
export function readingsForModelSide(inbound, { userText } = {}) {
  if (!inbound) return '';
  const parts = [];
  // ★ 2026-10-06 补：**纯文案也必须进来**。
  //   原先这里只收媒材的文字层（图上字 / 帧上字 / 转写），于是纯文案单的 readings 是**空串**，
  //   `reviewModelSide` 见空即跳过 ⇒ **文案只有知识库单轨，模型侧那一遍根本没跑**。
  //   而方案要的是「每层都同时开知识库侧＋模型侧」，文案恰恰是**最常见的一态** ——
  //   漏了它，等于「双轨」只对少数带媒材的单子成立。
  //   （这个洞是 Owner 2026-10-06 追问「文案/图片/视频/链接都可以跑知识库+模型吧？」时
  //    逐态核出来的；我原来的四形态自测第①态传了 `ask: null`，**把它盖住了**。）
  //
  // ══════════════════════════════════════════════════════════════════════════
  // ★★ 2026-10-16（Owner 拿报告来问的那一条）：**「@守衡」不是素材**
  // ──────────────────────────────────────────────────────────────────────────
  //   现场：对接人那条图单，报告第 1 条写着
  //     「【本地化】素材正文（发布账号名）与图 1 主文字（品牌名 momcozY）…正文只带了**中文账号名**
  //      **@守衡**，美国消费者看不懂中文 handle…建议把正文里的 @守衡 换成品牌官方英文 handle」
  //   —— 而 **`@守衡` 是她"怎么叫我们"的动作，不是素材内容**。Owner 原话：
  //     「这是我们做飞书的提问，面对美国市场，是提供的素材能不能进美国市场，
  //       **不是指我调用守衡的方式**」。
  //
  //   根因就在这一行：`inbound.text` 是**消息原文**（含 `@守衡` 这个 mention），
  //   而它被贴上了 **【素材正文】** 这个标签 ⇒ 模型照着标签判，把调用方式当成了发布内容。
  //   ⇒ 两点都改：① 取**剥掉 @ 之后**的那份（`userText`，由 `handleMessage` 算好）；
  //     ② 标签说实话 —— 有媒材时它**是提问/说明，不是素材本身**（素材是下面那些读数）。
  //   ⚠️ 剥完为空就**一节都不印**（对方只 @ 了一下，没有正文）——
  //     不许印个空标签，更不许拿它当"正文为空"去判。
  // ══════════════════════════════════════════════════════════════════════════
  const hasMedia = !!(inbound.imageCount || inbound.videoCount
                      || (inbound.images ?? []).length || (inbound.videos ?? []).length);
  const body = String((userText === undefined ? inbound.text : userText) ?? '').trim();
  if (body) {
    parts.push(hasMedia
      ? '【对方这条消息里写的字（**这不是素材本身**，是对方的提问/说明；素材是下面的读数）】\n' + body
      : '【素材正文】\n' + body);
  }
  // 链接单：文字层就是那条链接本身（正文内容由链那一侧去读，见 model_side 的边界说明）。
  for (const u of inbound.links ?? []) {
    if (String(u ?? '').trim()) parts.push('【待审链接】\n' + String(u).trim());
  }
  for (const i of inbound.images ?? []) {
    // ★★ 2026-10-09 晚（Owner：「报告链接中有文字是删除的」那条的**第二重代价**）：
    //   这一格原先取 `i.text`，而 `i.text` 那时是 **OCR 原文、含水印**
    //   ⇒ 模型侧读数里带着「Owner / 刘华問 / 5615 RO0」，于是它把水印写成了
    //   **素材里的内容问题**：实测那份报告的建议写着「图上反复出现『5615 RO0』…
    //   看起来是设计残留或误贴」「图上出现『Owner』『刘华問』三处中文人名，若是参与
    //   用户真名，换成昵称或整行删掉」—— **让被审方去改一个图上根本不存在的元素**。
    //   ⇒ 现在 `i.text` 本身就是**摘掉水印的那份**（唯一对外文本，见 `agent.mjs` 收口注释），
    //     这里不需要再挑字段：**同一件事不许再有第二个产者各挑各的**（今天已因它栽两次）。
    const imageText = String(i?.textCalibrated ?? i?.text ?? '').trim();
    if (imageText) parts.push('【图 ' + i.index + ' 上的字（本机 OCR；若有视觉校准，以校准副本为准）】\n' + imageText);
    // OCR 的重复位置判据已把平铺水印与素材文字分开。把这项已知来源随读数交给模型，
    // 使它能将半透明截图/审阅叠加层从成品内容审查中排除，而不是只看到原图却不知道来源。
    if ((i?.wmDropped?.length ?? 0) > 0
      && ['core-tiled-at-different-positions', 'exact-repeat-no-coords'].includes(i?.wmBasis)) {
      parts.push(`【图 ${i.index} 的截图层水印判读】OCR 判据识别到重复覆盖式水印并已从素材文字中摘除；按截图/审阅叠加层处理，不作为素材问题。若遮住文字，只说明局部识读受限。`);
    }
    // ★★ 2026-10-15：**画面读数**（PRD §5.1「基础视觉识别」那一半）。
    //   为什么单列一节并把它**逐字**摊开（不压缩成一句）：模型要用它判「产品使用 / 人物行为 /
    //   场景风险」三类，压缩就等于替它挑掉了它需要的信息。三个结局必须长得不一样：
    //     · 有读数 ⇒ 摊开；
    //     · 读了但没读到（`ok:false`）⇒ **如实写「没读到」**（不是「没有画面」）；
    //     · 压根没跑（老数据/开关关掉）⇒ 什么都不写（**不许**凭空造一节说"没画面"）。
    const sc = i?.scene;
    if (sc?.ok) {
      parts.push(`【图 ${i.index} 的画面读数（视觉模型的读数，不是原图；画面结论只能依据这一节）】\n`
        + sceneBlock(sc.scene));
    } else if (sc && !sc.skipped && sc.error) {
      parts.push(`【图 ${i.index} 的画面读数：**没读到**（${sc.error}）—— 这一张的画面层是未测，`
        + '不是「没有画面」，也不许据此推断画面]');
    }
  }
  for (const v of inbound.videos ?? []) {
    if (v?.failed) continue;
    // ★★ 2026-10-09（Owner：「目前守衡输出的没有视频的时间节点 00:12 这些」）──────
    //   这一行原先**只取 `f.text`、丢掉 `t_s`** ⇒ 模型出 findings 时**看不到时间码**，
    //   而提示词第 4 条却要求它「指得出**第几帧**」—— 要它指位置，却不给它位置，
    //   实测 outcome 就是 `location` 里出现「帧 3」「（未给位置）」这类**不可核**的值。
    //   现在改走 `video.frameLine`（唯一产者）⇒ 时间码随帧一起进输入，
    //   与卡片、库侧**同源同格式**。提示词里的要求也同步改成「时间码」。
    const fr = (v.frames ?? []).map((f) => video.frameLine(f)).filter(Boolean);
    if (fr.length) parts.push('【视频 ' + v.index + ' 关键帧上的字（每行开头是该帧的时间码）】\n' + fr.join('\n'));
    const t = v.transcript ?? {};
    if (t.ok && String(t.text ?? '').trim()) parts.push('【视频 ' + v.index + ' 音轨转写】\n' + String(t.text).trim());
    // ★★ 2026-10-16：**关键帧的画面读数**（PRD §5.1 对视频写的「画面关键帧」）。
    //   与图片那条同一条纪律：三种结局分开写 —— **看过的**／**没读到的（未测）**／**没跑**。
    //   只摊「看过的那几帧」，并把**时间码**带上：模型要指位置，就得给它位置
    //   （2026-10-09 那次教训：要它指第几帧却不给它帧号，它只能编）。
    const fs2 = v.frameScene ?? [];
    if (fs2.length) {
      const body = fs2.map((s) => (s.ok
        ? `- [${Number(s.t_s ?? 0).toFixed(1)}s] ${sceneBlock(s.scene).replace(/\n/g, ' ')}`
        : `- [${Number(s.t_s ?? 0).toFixed(1)}s] **没读到**（${s.error ?? '未知'}）—— 这一帧画面是未测`))
        .join('\n');
      parts.push(`【视频 ${v.index} 关键帧的画面读数（视觉模型的读数，不是原图；只覆盖列出的时间码）】\n${body}`);
    }
  }
  return parts.join('\n\n');
}

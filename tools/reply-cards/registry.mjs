/**
 * registry.mjs —— 卡片类型登记表（唯一来源）
 *
 * 一个类型要进这张表，必须同时给出四样东西，缺一不可：
 *   1. `kind`     机器键，同时也是 cards.mjs 里构造器的键、CLI --type 的取值
 *   2. `when`     「什么时候用」——**判据**，不是描述。写不出判据的类型不该存在，
 *                 因为模型无法在两条模糊描述之间做选择，最后会全用同一个模版。
 *   3. `fields`   字段表。多一个字段就是多一个「模型可能填废话」的槽位，必须能说出用途。
 *   4. `sample`   一张真样例。样例同时是 verify 的输入和给业务看的名片。
 *
 * 这张表被 tools/verify_cards.mjs 逐条核对：构造器存在、字段被真的读、样例能过校验。
 * 因此它不会腐烂 —— 改代码不改这里，自证会红。
 */
import {
  BUILDERS, BUILDER_SOURCE_NAME, build, validateCard, collapsible, band,
  VERDICT_MAX, MAX_SECTIONS, ALLOWED_TAGS, TEMPLATES, TONE, REMOVED_IN_V2,
  BACKGROUND_STYLES,
} from './cards.mjs';
// ★ 2026-10-14：摘 markdown 符号的实现**只有一份** —— `agent/plain.mjs` 的 `plainify()`。
//   原先本文件里还有第二份（只删 `**` 与行首 `#`）—— 而「两份实现必然漂移」这件事
//   本项目已经栽过一次（见 `PMO/守衡-误答登记-20260922.md` §16.3）。
import { plainify as stripMd } from '../agent/plain.mjs';

/* ═══════════════════ ① 内容级约束（去 AI 味，机械可查） ═══════════════════ */
/*
 * 这些不是风格建议，是从 sepia 的中文标定与职业文类检查表里挑出来的、
 * **能在字符串上判真假**的几条，作用在卡片正文上：
 *
 *   connectorStack  连词串珠：「和／以及／并且／同时／此外／因此」在相邻子句里连用。
 *                   HC3-Chinese 实测密度：人 0.013 vs ChatGPT 0.036。
 *   padding         双音节填充：「进行讨论」「加以说明」「予以处理」→ 动词本身。
 *   chatbotResidue  客服残渣：开场套话、结语套话。职业文类检查第 1 条。
 *   conclusionTail  结尾总结段。检查第 7 条：内容完了就结束。
 *   hedgeStack      同一段里叠两个以上模糊限定。检查第 4 条：该下判断就下。
 *   ruleOfThree     排比三连。实测人写新闻里三顿号并列占 59%，但**排比句式**是模板。
 *
 * 反例也写在这里，因为**过度纠正本身是另一种指纹**（sepia 的标定规则）：
 * 单个「此外」、单个三顿号并列、正式语域的正式措辞，都不是 AI 味。所以下面这些
 * 只在**成串出现**时才报，单次出现只记 info。
 */

export const COPY_RULES = [
  {
    id: 'chatbotResidue',
    level: 'error',
    why: '客服残渣。同事不做开场白，也不做结语。',
    // 拆成短语数组而不是一条大正则：可读、可增删，且 verify 能逐条造正例
    phrases: [
      '好问题', '非常好的问题', '这是个好问题',
      '感谢提问', '感谢你的提问', '感谢您的提问', '感谢反馈', '感谢你的反馈', '感谢指出',
      '很高兴为您', '很高兴为你',
      '希望这对你有帮助', '希望这对您有帮助', '希望这能帮到你', '希望这个回答对你有帮助', '希望能帮到你',
      '让我来看看', '让我们来看看', '让我们来看看', '我们先来看看', '首先我们来看',
      '以上就是我的回答', '以上就是全部内容', '以上就是这些',
      '如有疑问欢迎联系', '如有任何疑问，欢迎随时联系', '如有问题请随时提问',
    ],
    re: null,
  },
  {
    id: 'conclusionTail',
    level: 'error',
    why: '结尾总结段。内容完了就结束，别回锅。',
    re: /(综上所述|总而言之|总的来说|总之[，,]|小结一下|最后(再)?(总结|归纳)一下|概括起来)/g,
  },
  {
    id: 'padding',
    level: 'error',
    why: '双音节填充。中文里动词直接用，不用「进行/加以/予以」包一层。',
    re: /(进行(一下)?(讨论|说明|分析|处理|确认|核实|查询)|加以(说明|处理|确认)|予以(处理|说明|确认|答复)|做出(决定|判断|选择)|作出(决定|判断|选择))/g,
  },
  {
    id: 'hedgeStack',
    level: 'warn',
    why: '同一段叠两个以上模糊限定。该下判断就下一个。',
    re: /(可能|或许|大概|似乎|应该是|也许|恐怕)/g,
    min: 3,
  },
  {
    id: 'ruleOfThree',
    level: 'warn',
    why: '排比三连——三段结构完全相同的短句并排。人写的是二或四，也会只写一。',
    // 三行相邻、每行长度接近、都以同样方式收尾（。或；）的短句
    detect: (text) => {
      const lines = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('|') && !l.startsWith('#') && !l.startsWith('```'));
      let runs = 0;
      for (let i = 0; i + 2 < lines.length; i++) {
        const [a, b, c] = [lines[i], lines[i + 1], lines[i + 2]];
        const len = (x) => [...x].length;
        const close = (x) => x.slice(-1);
        if (close(a) === close(b) && close(b) === close(c)
          && Math.abs(len(a) - len(b)) <= 2 && Math.abs(len(b) - len(c)) <= 2
          && len(a) < 24) runs++;
      }
      return runs;
    },
  },
  {
    id: 'connectorStack',
    level: 'warn',
    why: '连词串珠。中文靠意合，删掉连词让并列自己承担关系。',
    re: /([，,。；;]\s*)(此外|因此|然而|并且|同时|以及|而且|但是|不过)(?=[^，,。；;]{0,30}[，,。；;]\s*(此外|因此|然而|并且|同时|以及|而且|但是|不过))/g,
  },

  /* ── 结构级：内部记录泄漏 ──────────────────────────────────────────────
   * 这条不是「AI 味」，是**故障**。但它必须和 AI 味分开测，因为两者的修法不同：
   * AI 味靠改写，泄漏靠不许写。
   *
   * 实测依据：守衡真的往群里发过一条连列 27 次工具名的回复（2026-09-17），
   * 而那条 434 字的故障输出**通过了除本条以外的全部内容级检查** ——
   * 说明「读起来像不像 AI」和「该不该出现在群里」是两回事，不能合并成一把尺。
   */
  {
    id: 'internalLeak',
    level: 'error',
    why: '内部调用记录漏进了正文。内部详情只允许进折叠区，正文出现即故障。',
    detect: (text) => {
      const s = String(text);
      let n = 0;
      // 显式的内部标识
      n += (s.match(/tool_calls|tool_call_id|finishReason|reasoning_tokens|"role"\s*:\s*"tool"/g) ?? []).length;
      n += (s.match(/call_[0-9a-zA-Z]{10,}/g) ?? []).length;
      n += (s.match(/at\s+\S+\s+\(.*:\d+:\d+\)/g) ?? []).length;          // 栈帧
      // 连续三次以上同名工具（真实那条是「list_files」×19）
      for (const m of s.matchAll(/([a-z][a-z0-9_]{4,})\s*[、,，]\s*\1\s*[、,，]\s*\1/g)) n += 1;
      // 连续两个「像工具名的东西 + 括号」也可能是 trace
      n += (s.match(/([a-z][a-z0-9_]{4,})\((\d+ms)?\)[^\n]{0,40}\1\(/g) ?? []).length;
      // ★ 思考模式把**工具调用语法当成正文吐出来**（2026-09-30 实测）。
      //   本机实盘复现过：模型在正文里直接写
      //     <｜｜DSML｜｜ calls> / <｜｜DSML｜｜ invoke name="kb_search"> /
      //     <｜｜DSML｜｜ parameter name="query">吸奶器
      //   而当时 `internalLeak` 的其他几条**一条都不命中**（实测 0 命中）——
      //   它认工具名、认 call_xxx、认栈帧，唯独不认这串框架标记。漏出去的后果是
      //   群里看到一段谁也读不懂的尖括号，**比半句话更难判断"这是不是全部内容"**。
      //   判据取**带全角竖线的标记本身**，不取 `invoke` / `parameter` 这种英文词 ——
      //   它们是正常英文词，拿它们当判据会在正经回答里误报（§2.1.1：误报比不报更糟）。
      n += (s.match(/<[｜|]{1,2}\s*DSML\s*[｜|]{1,2}/g) ?? []).length;
      // ══════════════════════════════════════════════════════════════════════
      // ★★ 2026-10-09（Owner 现场那张「在吗」的截图）：**上面这些一条都不命中，
      //    而它照样把内部详情写进了正文。** 漏出去的是这两类：
      //
      //   ① **指纹 / 哈希** —— 原话：「在我这儿还是**旧版指纹** `1f871b42fa909e70…`，
      //      新版是 `bc48e2ae893ab3e7…`」。sha 是**内部标识**，业务同事拿到它没有任何用处。
      //   ② **能力自述** —— 原话：「**重拉基线那一步不在我的工具里**」。
      //      这是「我有什么工具」的自述，属内部详情；而且它后面还接了
      //      「你要我重拉，**把该跑的命令给我**」—— **把维护侧的活推回给了业务同事**。
      //
      //   判据为什么这么取（每条都要能挡住上面那两句，且不许误报正经回答）：
      //     · sha 取**连续 ≥16 位十六进制**且**不是纯数字** —— 纯数字不算，否则订单号、
      //       金额、时间戳会被误报（§2.1.1：一个会误报的检查器比没有更糟）。
      //       `1f871b42fa909e70` 是 16 位且含字母 ⇒ 命中；`20261009` 不命中。
      //     · 能力自述取「我的工具」「我这边没有…工具」这类**第一人称 + 工具**的固定搭配，
      //       不取「工具」这个词本身。
      n += (s.match(/\b(?=[0-9a-f]*[a-f])[0-9a-f]{16,}\b/g) ?? []).length;
      n += (s.match(/(我的工具|我这边.{0,6}工具|不在我的工具|我没有那个工具|没有这个工具|我的能力范围之外)/g) ?? []).length;
      return n ? Math.min(n, 9) : 0;
    },
  },
];

/** 对一段文案跑内容级检查。返回命中列表，空数组 = 干净。 */
export function lintCopy(text) {
  const hits = [];
  const src = String(text);
  for (const r of COPY_RULES) {
    if (r.detect) {
      const n = r.detect(src);
      if (n > 0) hits.push({ id: r.id, level: r.level, why: r.why, count: n, sample: `×${n}` });
      continue;
    }
    // 短语表：逐条 indexOf，比一条大正则好读也更好维护
    if (r.phrases) {
      const found = r.phrases.filter((p) => src.includes(p));
      if (found.length) hits.push({ id: r.id, level: r.level, why: r.why, count: found.length, sample: found.slice(0, 4).join(' / ') });
      continue;
    }
    const m = src.match(r.re);
    if (!m) continue;
    if (r.min && m.length < r.min) continue;
    hits.push({ id: r.id, level: r.level, why: r.why, count: m.length, sample: m.slice(0, 4).join(' / ') });
  }
  return hits;
}

/* ═══════════════════ ② 十类登记 ═══════════════════ */

export const REGISTRY = [
  {
    kind: 'query-answer',
    zh: '问答',
    when: '问的是一个**事实或结论**，一到三句话能说完。'
        + '反例：要罗列多条记录 → data-table；回答本身就长 → evidence。',
    fields: {
      title: '卡片标题。**写结论本身**，不写「关于 X 的答复」。',
      verdict: '结论，一句话，≤60 字。写不出来说明还没想清楚，先去查。',
      reasoning: '理由。可选 —— 如果结论已经自明，不要为了对称而填。',
      fields: '≤4 个短字段（置信度/窗口/证据数…）。超过 4 个说明该换 evidence。',
      evidence: '字符串数组，默认收起。',
    },
    sample: {
      title: '本群可查到的、你发过的消息：11 条',
      verdict: '**11 条**（按 senderOpenId 过滤，见的都是能看到的窗口内）。',
      reasoning: '逐条时间在折叠区。这个数字会随窗口滑动而变，原因写在边界里。',
      fields: [
        { label: '置信度', value: '查到' },
        { label: '窗口', value: '顶到 50 条上限' },
        { label: '证据', value: '11 条' },
      ],
      evidence: [
        '| # | 时间 | 你说的 |\n|---|---|---|\n| 1 | 09-15 22:38:21 | 你是做什么的？ |\n| 2 | 09-16 10:57:08 | 你是谁？ |\n| 3 | 09-16 12:26:20 | 我是谁？ |',
      ],
    },
  },
  {
    kind: 'data-table',
    zh: '数据',
    when: '回答的实体是**一堆记录**（≥3 行），每行字段相同。'
        + '反例：2 行以内用 query-answer 的 fields 就够，开表格是浪费一屏。',
    fields: {
      title: '表在数什么。写「共 N 条」比写「明细」有用。',
      verdict: '可选的一句话总述。',
      columns: '**字符串数组或 {name, display_name} 对象**。列名就是字段名。',
      rows: '二维数组或对象数组。对象数组的键必须与 columns 的 name 一致。',
      note: '表下面的一句补充。可选。',
      fields: '统计字段（总数/命中/去重后…）。可选。',
      subtitle: '给表加限定，例如「窗口：最近 50 条」。',
    },
    sample: {
      title: '本群可查到的、你发过的消息：11 条',
      subtitle: '窗口：最近 50 条 · 按 senderOpenId 过滤',
      columns: [
        { name: 'n', display_name: '#', data_type: 'text' },
        { name: 'at', display_name: '时间（北京）', data_type: 'text' },
        { name: 'what', display_name: '你说的', data_type: 'text' },
      ],
      rows: [
        ['1', '09-15 22:38:21', '你是做什么的？'],
        ['2', '09-15 22:43:02', '1'],
        ['3', '09-16 10:57:08', '你是谁？'],
        ['4', '09-16 12:26:20', '我是谁？'],
        ['5', '09-16 12:39:35', '我什么时候跟你说过话'],
      ],
      fields: [
        { label: '总数', value: '11' },
        { label: '文字', value: '10' },
        { label: '非文字', value: '1' },
      ],
      note: '*非文字那条我只知道它存在，内容看不到。*',
    },
  },
  {
    kind: 'correction',
    zh: '更正',
    when: '**发现自己前面说错了**。这是唯一必须用红头的类型 —— '
        + '群里上一句还挂在那里，更正不显眼就等于没更正。'
        + '反例：只是补充信息，不是改口 → query-answer。',
    fields: {
      wrong: '错在哪，引自己原话。不要用「可能」「或许」软化。',
      right: '正确的是什么。',
      cause: '错在哪个环节（哪一步查漏了 / 哪一步推断了）。**不是道歉，是归因**。',
    },
    sample: {
      title: '我上一条说错了',
      wrong: '「群历史只标『用户』，分辨不出谁发的」',
      right: '飞书群历史接口每条都返回 `sender.id`，数据一直在。是我们的工具层把它压成了「用户」两个字。',
      cause: '我把「我这一侧看到的残缺数据」当成了「接口的限制」，还把话说到了「该去看代码」就停住了。',
    },
  },
  {
    kind: 'capability-boundary',
    zh: '能力',
    when: '被问「你能做什么 / 你能不能做 X」。'
        + '**三栏一次说完，不分段解释**——这类问题的价值在清单，不在论证。',
    fields: {
      can: '真的能做，每条带一句边界（如「最近 50 条，不分页」）。',
      limited: '能做但有硬上限的。',
      cannot: '做不到。**直接说做不到，不要用「暂时」软化**，除非真的有计划。',
      evidence: '「做不到」的依据（哪个文件哪一节说的）。收起。',
    },
    sample: {
      title: '我能做什么',
      verdict: '按能不能做分三栏。每栏每条都带边界，不带边界的清单等于没写。',
      can: ['读当前群历史（最近 50 条，不分页）', '看群成员列表（显示名 + open_id）', '读工作区文本文件', '执行只读命令（白名单）'],
      limited: ['群历史顶到上限时我不会知道自己漏了', '成员列表没有部门/岗位',
                '图片只读得到**图上的字**，画面本身看不到'],
      cannot: ['发文件、写文件', '读文件/语音/卡片的内容（按规矩不取）', '读已撤回消息的原文', '联网'],
      evidence: '`PMO/守衡-架构说明.md` 第四节第 4 条：9 个工具全只读。',
    },
  },
  {
    kind: 'find-nothing',
    zh: '没找到',
    when: '查了但**一条都没有**。必须说清查了哪里 —— '
        + '「没找到」不带检索范围，对方无法判断该补信息还是该换个地方找。',
    fields: {
      paths: '{where, how, result} 数组。**每一处都要写**，漏写等于谎报覆盖。',
      tried: '检索动作明细（命令、关键词）。收起。',
      nextStep: '需要对方补什么。能想到就写，想不到写「不知道去哪找」。',
    },
    sample: {
      title: '这批材料没找到',
      paths: [
        { where: '工作区全库', how: '按文件名模糊匹配 `岗位卡`/`契约`/`PB-007`', result: '0 命中' },
        { where: '工作区全库', how: '全文搜索 `岗位`/`契约`/`评测`/`PB-00`', result: '仅 2 个名字带「手册」的文件' },
        { where: '顶层目录', how: '列目录', result: '11 个目录，无匹配名' },
      ],
      tried: '```bash\ngrep -rn "PB-00" --include=*.md .\nfind . -iname "*岗位*"\n```',
      nextStep: '这批材料大概在什么位置？另一个仓库、飞书云文档，还是压根还没建？',
    },
  },
  {
    kind: 'cannot-read',
    zh: '读不了',
    when: '输入是**文件/语音/卡片**、**已撤回**、掉出可见窗口，或一张图**读不出字**。'
        + '别混成一句「我读不了」。★ 附件（file/media/audio）不是「读不到」，是**按规矩不取**'
        + '（只有下载这一条通道，飞书内容禁止下载，AGENTS.md §2.6）；说成「没权限」「能力还没做」'
        + '会让对方去申请权限、找文件主人，白跑。'
        + '★ **图片 2026-10-05 起不在这一档**：人当前发来的图读**图内文字**（窄豁免），'
        + '只有「图上没字 / 这张取不到」才落到这里 —— 两种话不一样。',
    fields: {
      verdict: '哪一类。**「内容没有」「内容在我范围外」「按规矩不取」是三回事**，必须写准。',
      item: '{kind, from, at, content}。content 留空表示取不到。',
      why: '为什么读不到（技术原因，一句话）。附件要写「规矩不让」，不写「权限不够」。',
      alternative: '对方可以怎么做。附件必须给一条走得通的路。',
    },
    sample: {
      title: '这条是文件，我不取内容',
      verdict: '**我知道它存在**：类型 file、谁发的、什么时候都有。**里面是什么我不看** —— 飞书上的内容公司不让下载，附件只有下载这一条通道。',
      item: { kind: 'file', from: '周健', at: '09-16 12:49:23', content: null },
      why: '附件（xlsx/pdf/语音/视频）只有下载才读得到，而飞书内容禁止下载。**这是规矩，不是权限没给够。**（图片例外：人当前发来的图读图上的字。）',
      alternative: '把里面的文字贴过来，或者存成飞书云文档发我 —— 云文档我能直接读。',
    },
  },
  {
    kind: 'receipt',
    zh: '回执',
    when: '对方**只需要知道「收到了」**，不需要解释。'
        + '也可以在一次长回答已经发出后补一条，用来确认链路通。'
        + '★ 判断错了代价不对称：多一条回执是噪音，少一条回执对方会以为你没收到——'
        + '所以不确定时用回执，但**一次对话里不要连发两条**。',
    fields: {
      verdict: '一句话。',
      fields: '可选，≤3 个（收到时间 / 会话 / 我接下来做什么）。',
      note: '可选。',
    },
    sample: {
      title: '已收到',
      verdict: '收到了，正在查。',
      fields: [
        { label: '收到于', value: '09-18 12:06' },
        { label: '会话', value: '内容治理-守衡Agent-测试' },
      ],
      note: '*查完我直接答，不再发第二条回执。*',
    },
  },
  {
    kind: 'turn-diff',
    zh: '改口',
    when: '**同一个问题，这次答得跟上一次不一样**。'
        + '不说明就会被读成「在改口」。这是守衡真实踩过的坑：'
        + '「10 次」→「11 次」，对方连问四遍。',
    fields: {
      verdict: '差在哪，一句话。',
      before: '上一次的值。',
      after: '这一次的值。',
      cause: '为什么变（窗口滑动 / 新证据 / 上次算错）。**这三种原因的处置完全不同**。',
      fields: '可选。',
    },
    sample: {
      title: '跟上一次答得不一样：10 → 11',
      verdict: '**这个数字会变，原因不是我在改口，是窗口在滑动。**',
      before: '10 次',
      after: '11 次',
      cause: '上一条答「10 次」时最旧能看到 09-15 22:04:56；这次同一次调用已顶到 50 条上限，最旧只到 22:05:10 —— 22:04 那条刚掉出可见范围。',
      fields: [
        { label: '窗口起点', value: '22:05:10（上移 14 秒）' },
        { label: '性质', value: '窗口滑动，不是改口' },
      ],
    },
  },
  {
    kind: 'evidence',
    zh: '证据',
    when: '**结论很短、证据很长**。把结论放正文，证据全塞折叠区，默认收起。'
        + '这是「中位数 786 字」的直接解法：想一眼看完的人看标题，想核对的人点开。',
    fields: {
      verdict: '结论，短。',
      groups: '{title, content, count, expanded} 数组。**默认 expanded: false**。',
      fields: '可选。',
    },
    sample: {
      title: '截断修复确认生效',
      verdict: '1045 字，完整收尾，日志里无截断警告。',
      groups: [
        { title: '证据 · 飞书回读', count: '4 项', content: '`im.message.get` 取回原消息：`msg_type=text`、`length=1045`、`deleted=false`、结尾为完整句。' },
        { title: '证据 · 日志', count: '2 行', content: '```\n[+153.312s] 💬 回复 1045 字，耗时 16696ms\n[+154.674s] ✓ 已发送 om_x100b65964f87dca8b170a9dd77c9ddc [reply]\n```' },
      ],
    },
  },
  {
    kind: 'alert',
    zh: '告警',
    when: '**我这侧坏了**：模型调用失败、工具循环用尽、内部异常。'
        + '★ 这个类型的首要职责是**拦住内部记录**：'
        + '守衡真的往群里发过一条连列 27 次工具名的回复（2026-09-17）。'
        + '内部详情只允许出现在折叠区。',
    fields: {
      what: '发生了什么，用对方能懂的话。**不要贴栈、不要列工具名**。',
      impact: '对对方有什么影响。',
      internal: '内部详情。**只能进折叠区**，且要写明「排查用」。',
      retry: '对方可以怎么做。',
    },
    sample: {
      title: '我这侧出故障了',
      what: '刚才那条回复是故障输出，等于没答。',
      impact: '你问的那批材料，我这次没答上。',
      internal: '工具循环用尽（27 次调用），收尾分支把 `toolTrace` 拼进了回复正文。已执行：list_files ×19、run_readonly_command ×6、read_text_file ×2。',
      retry: '把问题再发一次，或告诉我材料大概在哪个位置。',
    },
  },
  {
    kind: 'decision',
    zh: '征询',
    when: '**要对方拍板**。一次只问一件 —— 这条不是模版的约定，是 AGENTS.md 第一节的硬约束。',
    fields: {
      ask: '要定的事，一句话。',
      options: '{label, cost} 数组。**每条必须写代价**；只给选项不给代价，等于把选择又推回去。',
      recommend: '我的建议 + 一句理由。没有建议就不要写这一行，不要用「供参考」占位。',
      fields: '可选。',
    },
    sample: {
      title: '有一件事要你定：卡片什么时候用',
      ask: '哪些回复该走卡片，哪些继续走纯文本？',
      options: [
        { label: '短回答走文本，其余全走卡片（推荐）', cost: '一眼能看完的问题不会被卡片撑大；代价是判别标准要写清楚，写不清就两头不讨好' },
        { label: '全走卡片', cost: '格式统一；代价是一句「收到」也要占一屏' },
        { label: '全走文本', cost: '零改动；代价是表格继续以竖线形式出现' },
      ],
      recommend: '第一条。理由是实测的：786 字的中位长度里，真正需要一眼看完的只有结论那一行。',
      fields: [{ label: '待定', value: '1 件' }],
    },
  },
];

/** kind → 登记项 */
export const BY_KIND = new Map(REGISTRY.map((r) => [r.kind, r]));

/* ═══════════════════ ③ 降级：卡片发不出去时发什么 ═══════════════════ */
/*
 * 卡片发送失败时不能「不答」。降级目标是一个**仍然可读的纯文本**，
 * 而不是把卡片 JSON 吐出来 —— 后者是 2026-09-17 那条故障的同类错误。
 *
 * 降级文案的规则：
 *   - 标题变第一行，加粗
 *   - 表格退化成 markdown 竖线表（在飞书 text 里显示为竖线，但至少每行是一行）
 *   - 折叠区**不展开**，改标「（已收起 N 条证据）」
 *   - 结尾注明「本条以纯文本发出：<原因>」，让对方知道格式为什么没生效
 */

function elementToText(el, depth = 0) {
  if (typeof el === 'string') return el;
  switch (el.tag) {
    // ★ 2026-10-14：正文 markdown 也要摘符号（原先**只有**折叠区标题那一处摘了）。
    //   这一份文本是「卡片降级成纯文本」与**台账正文**共用的 —— 而它只在出事那一跳才被看见，
    //   所以它带着星号进了群也没人会发现（§16.2 那个形状）。
    case 'markdown': return stripMd(el.content);
    case 'hr': return '———';
    case 'table': {
      const head = el.columns.map((c) => c.display_name ?? c.name);
      const rows = el.rows.map((r) => el.columns.map((c) => String(r[c.name] ?? '')));
      return [head, head.map(() => '---'), ...rows].map((r) => `| ${r.join(' | ')} |`).join('\n');
    }
    case 'column_set':
      return el.columns.map((c) => c.elements.map((e) => elementToText(e, depth + 1)).join('\n')).join('\n\n');
    case 'collapsible_panel': {
      const n = el.elements.length;
      return `（已收起 ${n} 条证据：${stripMd(el.header?.title?.content ?? '')}）`;
    }
    case 'button': return `[${el.text?.content ?? '按钮'}（当前不可点）]`;
    case 'code_block': return el.text ?? '';
    default: return '';
  }
}

/** 卡片 → 纯文本。发送降级路径用它；也是「模版到底在说什么」的可读视图。 */
export function renderText(c, reason = null) {
  const out = [];
  // ★ 2026-10-06：标题**已经自带方括号标记**时不再套第二层。
  //
  //   事故形状（Owner 2026-10-06 08:25 那条 PASS 回复）：PRD §5.3 的结论行本身长这样 ——
  //     `【审查结论：PASS】未发现已知底线风险，可转交 @… 进行 sign-off。`
  //   而这里**本来会给标题套一层** `【…】` 当标题样式 ⇒ 台账与降级文本里成了
  //     `【【审查结论：PASS】…进行 sign-off。】`
  //   卡片表头走的是 raw `plain_text`（`cards.mjs` 的 `card()`），所以群里那张卡是**对的**；
  //   出偏差的是 `renderText` 的产物 —— 它是**降级兜底**（卡片发不出去时原样进群）与**台账正文**，
  //   也就是「只在出事那一跳才看得见」的那一处。
  //   判据：标题**以 `【…】` 开头**就不加第二层（不是「整行被方括号包住」——
  //   5.3 那行的括号只包住态名，行尾还有一个句号）。
  const title = stripMd(c.header?.title?.content ?? '(无标题)');
  out.push(/^【[^】]*】/.test(title) ? title : `【${title}】`);
  for (const el of c.body?.elements ?? []) {
    const t = elementToText(el);
    if (t) out.push(t);
  }
  if (reason) out.push(`\n（本条以纯文本发出：${reason}）`);
  return out.join('\n').trim();
}

/** 卡片 → 一段话的「形状摘要」，给 verify 与名片文档用 */
export function shapeOf(c) {
  const parts = [];
  const walk = (els) => {
    for (const el of els ?? []) {
      if (el.tag === 'markdown') parts.push('markdown');
      else if (el.tag === 'hr') parts.push('hr');
      else if (el.tag === 'table') parts.push(`table(${el.rows?.length ?? 0}行)`);
      else if (el.tag === 'column_set') parts.push(`column_set(${el.columns?.length ?? 0}栏)`);
      else if (el.tag === 'collapsible_panel') parts.push(`collapsible(${el.expanded ? '展开' : '收起'})`);
      else if (el.tag === 'button') parts.push('button');
    }
  };
  walk(c.body?.elements);
  return parts.join(' · ');
}

/* ═══════════════════ ④ 自证用的小工具 ═══════════════════ */

/** 每个类型的样例卡（构建 + 校验过） */
export function sampleCards() {
  const out = {};
  for (const r of REGISTRY) out[r.kind] = build(r.kind, r.sample);
  return out;
}

export {
  build, validateCard, BUILDERS, BUILDER_SOURCE_NAME, collapsible, band,
  // 这三个上限以前只定义、不导出、不引用（grep 全仓库只有定义行）。
  // envelope.mjs 是它们现在唯一的执行点，所以必须从这里转出去。
  VERDICT_MAX, MAX_SECTIONS,
  ALLOWED_TAGS, TEMPLATES, TONE, REMOVED_IN_V2,
  // 底色闭集：执行点就在 cards.mjs 的 validateCard 里，这里转出去是给
  // verify_cards.mjs 的 J9 段喂坏样本用（进不去就证不了它会红）。
  BACKGROUND_STYLES,
};

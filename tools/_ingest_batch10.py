#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""_ingest_batch10.py —— 把 Q27–Q34 的裁定写进唯一台账（D12），并把过程中查出的 Q35 一并入队。

用途：一次性的入库脚本。Q27–Q34 由 Owner 于 2026-09-17 逐条裁定（讨论稿 §九），
      在此之前它们只存在于 `PMO/守衡-创建全景图与知识库体系-讨论稿-v1.md` ——
      也就是说**它们还不是本项目的事实**。本脚本按 D12 的格式把它们写进
      `research/governance/skeleton/legal-decisions-v1.json`：
        · 8 条决定 D29–D36（decisions）
        · 8 条已答的题 Q27–Q34（$decision_queue，保留 options/recommended/default）
        · 1 条**新提出的未决项 Q35**（入库时实测出的编号撞车，见文件内 §三 的说明）
        · 两条批次说明（$decision_queue_note 第十批 / 第十批附）

★ 不做什么（边界）：
  · **不做 Q32 的 ID 迁移**。Q32 裁定的「三套 ID 合并」是一次 ≈100+ 条的迁移，
    D34 明确要求它单独一轮做 —— 本脚本只把「口径已定」写下来。
  · 不碰任何代码、不碰其它 JSON。`--check` 只读。
★ 幂等：按 id 存在即跳过，可重复运行。
★ 写完必须自己验证：`python3 tools/verify_engine_contract.py`（全仓 171 门）
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LEDGER = ROOT / "research" / "governance" / "skeleton" / "legal-decisions-v1.json"
DRAFT = "PMO/守衡-创建全景图与知识库体系-讨论稿-v1.md（§九 待你决定的事 · Q27–Q34 的裁定）"

ANSWERED_AT = "2026-09-17"
ANSWERED_BY = "Owner"
RAISED_AT = "2026-09-17"
DISCUSSION = "PMO/守衡-创建全景图与知识库体系-讨论稿-v1.md"
LEDGER_REL = "research/governance/skeleton/legal-decisions-v1.json"

# ─────────────────────────────────────────────────────────────────────
# 一、8 条决定（D29–D36）。字段沿用 D28 的形状：
#     id / line / asked_at / question / answer / answered_by / answered_at /
#     effect / quantified_consequence? / accepted_risk? / changed_artifacts /
#     verification / $artifact?
# ─────────────────────────────────────────────────────────────────────
DECISIONS: list[dict] = [
    {
        "id": "D29",
        "line": "kb",
        "asked_at": RAISED_AT,
        "question": "Q27：知识库体系采用哪一套分类",
        "answer": "**选 A：现有 4 类（K1–K4）之上补 K6 / K7 / K8 + K0 项目空间，共 9 个库；4 类不动，只是从「全部」变成「其中一层」。**",
        "answered_by": ANSWERED_BY,
        "answered_at": ANSWERED_AT,
        "effect": "知识库的分类口径从「4 类」改为「9 库 = 4 类语料层（K1–K4）+ K6 外部标准 + K7 Agent 核心 + K8 评测 + K0 项目空间」。这条决定的关键性质是**只增不改**：K1–K4 的四张定义表、owner、待收集问题全部保持原样，因此业务侧已有的共同语言不会因为这次改造失效 —— 这是选 A 而不是选 C（推倒重来）的唯一理由。代价落在登记表侧：`知识库-v1.json` 的表结构要重建一次，重建之后「4 类」**不再是全集**。",
        "quantified_consequence": "重建前：任何按「4 类」读出的覆盖率数字仍然是对的，但**不再完整** —— K6/K7/K8/K0 的内容（外部标准、Agent 契约、评测集、项目空间）落在那 4 类的视野之外。重建后：K1–K4 的条目数不变，新增 5 个库各自从 0 起算。",
        "accepted_risk": "「9 库」是本决定新引入的层级，在 B4 落地之前它只存在于本决定与讨论稿里。期间任何写死「4 类」的检查与叙述都会变成**局部真话** —— 局部真话读起来像完整结论，这正是本项目已确诊的失败形态。因此 B4 的验收里有一条：仓库内不得再出现以「4 类」为全集口径的断言。",
        "changed_artifacts": [LEDGER_REL, DISCUSSION],
        "verification": "python3 tools/verify_engine_contract.py --only V30",
        "$artifact": "B4 交付「9 库定义表 + 登记表重建」。**落地前本决定只改口径、不改制品** —— 本条不声称任何库已经建成。",
    },
    {
        "id": "D30",
        "line": "kb",
        "asked_at": RAISED_AT,
        "question": "Q28：K7（Agent 核心知识库）的第一批 Skill 是什么",
        "answer": "**选 A：按载体切三条 —— 文本 / 图片 / 落地页；共同部分（边界声明 / 回执 / 处置层引用）抽成一份被三处引用，不复制三份。**",
        "answered_by": ANSWERED_BY,
        "answered_at": ANSWERED_AT,
        "effect": "三条 Skill 直接对应 ADR-0013 遗留 35，且全部落在引擎与基座**已经支持**的三种载体上 —— 不需要任何新的载体能力，所以这批工作没有前置技术风险。★ 本决定真正的分量不在三条文档本身：**三条 Skill 一旦成文，「造一个 Agent」这件事的操作就从改代码变成写文档。** 这是执行计划把 B4 排在第一位的原因 —— B4 做完之前，每加一个审核场景都要开发介入；做完之后它是一个文档动作。",
        "accepted_risk": "三段结构相似的文档天然会各自漂。因此「抽公共部分」是本决定的**第一条**验收、不是后续优化：如果推迟到第一次改规则时再抽，三份此时已经开始不一致，抽出来的公共部分将是三个版本中的一个。",
        "changed_artifacts": [LEDGER_REL, DISCUSSION],
        "verification": "python3 tools/verify_engine_contract.py --only V30",
        "$artifact": "B4 交付 K7 三条 Skill + 被三处引用的公共部分。**未落地前 K7 等于 0 条** —— 本决定不把「已规划的 Skill」算成「已有的 Skill」。",
    },
    {
        "id": "D31",
        "line": "kb",
        "asked_at": RAISED_AT,
        "question": "Q29：K0 项目空间的载体选哪个",
        "answer": "**选 C：两边都要 —— 飞书侧放给人看的，本地放给机器读的，两边用指纹对账。**",
        "answered_by": ANSWERED_BY,
        "answered_at": ANSWERED_AT,
        "effect": "飞书侧新增一个「项目空间」载体，本地侧一份 `PMO/项目空间.md`（其「未知清单」由脚本从三张登记表生成）。选 C 而不是 A（只做本地）的唯一理由是：K0 的落地**同时**是「第一次真正验证双账本对账机制」的机会。这条决定把落地顺序锁死：**先写对账脚本，再写内容。**",
        "quantified_consequence": "若顺序反过来（先写内容、后补对账），飞书侧与本地侧的第一次不一致将没有任何东西会红。本项目已实测过同型事故：同一组问题写在两个文件里，两处状态开始不一致 —— 那一次是靠人偶然读出来的。",
        "accepted_risk": "多一道同步维护，且它的收益要到「业务方真的会来查」时才兑现 —— 在那之前它是一笔纯成本。同时它是「新增第五个 Base」的风险承担者（Q29 的选项 B 正是这个风险，选 C 意味着**接受这个风险并给它配一个对账器**）。",
        "changed_artifacts": [LEDGER_REL, DISCUSSION],
        "verification": "python3 tools/verify_engine_contract.py --only V30（对账脚本自带反向对照：改一个字必须红）",
        "$artifact": "B4/B6 交付对账脚本 + 两侧内容。**在脚本存在之前不得写入飞书侧内容**（这是本决定的顺序约束，不是建议）。",
    },
    {
        "id": "D32",
        "line": "kb",
        "asked_at": RAISED_AT,
        "question": "Q30：飞书那 99 条表怎么处置",
        "answer": "**选 A：拆成三张表，先拆不补；「必须有原文」作为真样本的准入条件，下一步再执行。**",
        "answered_by": ANSWERED_BY,
        "answered_at": ANSWERED_AT,
        "effect": "拆表是纯结构动作，不依赖业务方供料，所以可以立刻做；真样本的准入条件收紧为「必须有原文」。这两件事被刻意分开：**结构问题当场修掉，内容问题留给下一步**。选 A 而不是 C（不拆，加一列说明）的理由是 C 等于承认一张表可以装三件事 —— 而这正是本项目反复修过的缺陷，会再犯一次。",
        "quantified_consequence": "**拆完之后真样本表会变空：56 条 → 只剩少数几条带原文的。** 这个数字是选 A 的代价，不是副作用。",
        "accepted_risk": "★ **「空白」是最不像错的错**（本项目实测：一次静默的过期快照让一个知识库被误报为空白）。所以本决定**不允许单独落地**：它必须与 D33（Q31）同批完成 —— 拆完之后的空表必须能与「已拆表但还没补料」区分，否则拆完表当晚就会复发一次同型误报。**这是 B5 的第一条验收。**",
        "changed_artifacts": [LEDGER_REL, DISCUSSION],
        "verification": "python3 tools/verify_engine_contract.py --only V30（落地后加 B5 的「空白 vs 未补料」可区分检查）",
        "$artifact": "B5 交付三张表 + 「空白 / 已拆未补料」的机器可区分标记。**与 D33 同批，不得单独落地。**",
    },
    {
        "id": "D33",
        "line": "kb",
        "asked_at": RAISED_AT,
        "question": "Q31：本地登记表与飞书实况的落差怎么修",
        "answer": "**选 A：`知识库-v1.json` 的输入从「本地快照」改为「飞书实时」，表头印每次拉取的时间戳；同时把重算结果推回飞书投影。**",
        "answered_by": ANSWERED_BY,
        "answered_at": ANSWERED_AT,
        "effect": "登记表从此不可能给出「静默过期」的数字 —— 要么是刚拉的，要么它明确地失败。方向也被修正：过去是本地算完写飞书、重算结果不回投影，于是两边各自演化；现在重算结果推回飞书，**投影成为算出来的东西，而不是手填的第二份真相**。",
        "quantified_consequence": "本次实测的直接证据：正是因为输入是快照且没人看日期，一个知识库被误报为**空白**。D26 已经把「手工刷新」判过一次（Q31 的选项 C = 现状），本次实测给出了它的代价。",
        "accepted_risk": "每次重算要联网，离线场景会失败 —— 这是**有意的**：失败得清楚，好过静默给出过期数字（与 V43a 同一条纪律：空缺必须可见）。代价是离线/CI 复跑会红，且必须红得能被人读懂。",
        "changed_artifacts": [LEDGER_REL, DISCUSSION],
        "verification": "python3 tools/verify_engine_contract.py --only V30（落地后加 B5 的离线失败可辨识检查）",
        "$artifact": "B5 交付实时拉取 + 时间戳 + 推回投影。**与 D32 同批，不得单独落地。**",
    },
    {
        "id": "D34",
        "line": "repo",
        "asked_at": RAISED_AT,
        "question": "Q32：三套未决 ID（D# / Q# / 遗留#）要不要合并",
        "answer": "**选 A：合并进 `$decision_queue` 单一编号空间；`D#` 与 `遗留#` 作为别名保留在各自制品里（不重写历史引用）。**",
        "answered_by": ANSWERED_BY,
        "answered_at": ANSWERED_AT,
        "effect": "「欠了多少决定」从「打开三个文件自己数」变成一条命令可答。别名保留是这条决定的关键设计：本仓已有大量散文与制品按 `遗留 35` 这类编号互相指认，重写它们会把一次编号迁移变成一次全仓文本改写，并污染 diff —— 那是把治理动作做成了噪声。",
        "quantified_consequence": "一次性迁移 ≈100+ 条（`D#` 16 条 + `Q#` 26 条 + ADR 遗留 ≈83 行），并要改 V30 检查：`V30c` 的编号连续性判据需扩到「别名唯一」。",
        "accepted_risk": "迁移期间三套编号同时存在 —— 这正是「两处状态不一致」最容易发生的窗口。因此本决定明确要求**不与其它入库混批**：Q27–Q34 的入库（本批）不执行迁移，迁移单独一轮做，且迁移脚本必须先有一个守恒对照：迁移前后「决定总数」必须相等，否则红。",
        "changed_artifacts": [LEDGER_REL, DISCUSSION],
        "verification": "python3 tools/verify_engine_contract.py --only V30（迁移轮另加「迁移前后总数守恒」对照）",
        "$artifact": "**迁移尚未开始。** 本条只定口径 —— 在迁移完成之前，本仓仍然有三套编号，这不是遗漏，而是本决定声明的中间状态。",
    },
    {
        "id": "D35",
        "line": "kb",
        "asked_at": RAISED_AT,
        "question": "Q33：K8 评测库要不要现在做",
        "answer": "**选 A：现在做，但只做最小可用 —— 两个独立标注人 × 50 条，出 κ；κ 不到 0.6 就先不外说「判定可靠」。**",
        "answered_by": ANSWERED_BY,
        "answered_at": ANSWERED_AT,
        "effect": "评测的可信度第一次有了一个可测量的下界。这道题在提问后被两条实测改变了形状：① 错题本 `errorbook.csv` 的 `人工复判结论/复判人/复判时间/处置码/处置人/处置日期` 六列填充率**全部 0/177**，源表 `检查人` 也是 `0/291` —— 连谁标的都不知道；② 公开数据显示**人类标注者彼此一致率只有 79%**。两条合起来的含义是：**κ 不是「验证引擎准不准」，而是「先搞清楚人工基准本身有多可信」。**",
        "quantified_consequence": "两个独立标注人 × 50 条 → 一个 κ 值。在此之前，对外只能引用 `offline_replay` 的 P/R/F1，而它**从未被独立标注验证过**。",
        "accepted_risk": "需要 2 个人 × 约半天；且**可能测出 κ 不合格**，那会推迟对外承诺。★ 两条硬约束（不满足则本决定未落地）：① **κ < 0.6 时，任何对外产物不得出现「判定可靠」字样**；② **错题本那六列至少一列不再为 0**，才算「回填机制」被修好 —— 否则任何评测集都会在第 N 天退化成一张冻结快照（六列为 0 正是这个退化的成因，而不是它的症状）。",
        "changed_artifacts": [LEDGER_REL, DISCUSSION],
        "verification": "python3 tools/verify_engine_contract.py --only V30（落地后加 K8 的两条硬约束检查：κ 门槛与六列非零）",
        "$artifact": "B7 交付最小评测集 + κ + 回填机制。**κ 未出之前，本条不授权任何「判定可靠」的对外表述。**",
    },
    {
        "id": "D36",
        "line": "engine",
        "asked_at": RAISED_AT,
        "question": "Q34：要不要补「语义模型层」（对标得出的最大架构缺口）",
        "answer": "**选 A：先只补一处 —— 对 `coverage=catch_all` 的条目加一次 LLM 语义判定，输出仍是建议（落 DP3 人工复核，不改变机器终结权）。**",
        "answered_by": ANSWERED_BY,
        "answered_at": ANSWERED_AT,
        "effect": "直接打在 54.6% 的空白上（9 个对标项目**没有一个**用纯词表做审核，全部是「确定性规则先跑 → 喂给 LLM → 决策层仲裁」；守衡今天停在第一层）。规则层不动 —— 这是选 A 而不是 B（全面补语义层）的理由：B 会动摇 `engine_version` 的可复现性，而可复现性是本项目全部回执与申诉的基础。",
        "quantified_consequence": "若三条硬约束任一未落地，本决定的效果**不是「多一层建议」**，而是让引擎的确定性声明变成不成立 —— 那时「引擎可复现」这句话本身会被模型的不确定性污染。",
        "accepted_risk": "引入模型调用与不确定性，成本与不可复现性都真实存在。三条硬约束的作用是把不确定性**关在一个可见的盒子里**，不是消除它。★ 三条硬约束（全部是验收项）：① **证据等级**：LLM 语义判定既不是 `L2-fixture` 也不是 `L3-production`，`ContentUnit` 契约里必须新增一个能表达「这条是模型说的」的字段，且**它不得与规则命中混在同一个 `hits` 数组里**（否则 V21a「机器独立拦截必须带齐最小证据集」会被模型输出污染）；② **回执可分辨**：ADR-0005 约束 5 说「没有回执的判定不算发生过」—— 现在一次判定里会同时存在确定性规则的回执与模型建议，**两者必须能在回执里分开统计**；③ **不夺终结权**：语义结果不得进 `hits`、不得改 `machine_may_finalize`，DP3 的终结权归属保持不变。",
        "changed_artifacts": [LEDGER_REL, DISCUSSION],
        "verification": "python3 tools/verify_engine_contract.py --only V21（落地后加语义层证据等级与回执可分辨检查）",
        "$artifact": "B9 交付 catch_all 语义判定 + 证据等级字段 + 回执分区。**未落地前 catch_all 仍是 54.6% 的沉默** —— 本决定不把「已决定的架构」算成「已实现的架构」。",
    },
]


def _q(qid, line, title, question, evidence, options, default, answer, record,
       covers=None):
    item = {
        "id": qid,
        "kind": "legal_question" if line in ("engine", "kb") else "governance_question",
        "line": line,
        "status": "answered",
        "owner": ANSWERED_BY,
        "raised_at": RAISED_AT,
        "title": title,
        "question": question,
        "evidence": evidence,
        "options": options,
        "default_if_unanswered": default,
        "answer": answer,
        "answered_by": ANSWERED_BY,
        "answered_at": ANSWERED_AT,
        "record": f"legal-decisions-v1.json · {record}",
        "$how": "以选择题交付（D12）：选项与推荐写在本题的 options 里；裁定后选项保留，以便追溯当时被放弃的代价。",
        "$from": DISCUSSION + " · §九",
    }
    if covers:
        item["covers_unwired_guards"] = covers
    return item


# ─────────────────────────────────────────────────────────────────────
# 二、8 条已答的题（Q27–Q34）。options 逐字取自讨论稿 §九，
#     recommended 标记保留 —— 已答项不必过 V30a，但保留它才能看出「当时推荐的是哪个」。
# ─────────────────────────────────────────────────────────────────────
QUEUE: list[dict] = [
    _q(
        "Q27", "kb",
        "知识库体系采用哪一套分类",
        "现有的知识库分类是 4 类（K1–K4）。本次实测与两份调研（AI 产品全流程方法 / 企业 Agent 知识库体系）都指出：Agent 契约、评测集、外部标准、项目空间**四类之外的东西没有家**，于是它们散落在代码、ADR 与讨论稿里。要不要在 4 类之上补库？补几个？",
        "两份调研共 36 个可核验来源、9 个对标项目，**没有一个**把知识库等同于「语料分类」；K7（Agent 核心）与 K8（评测）在 9 个项目里都是独立制品。本仓现状：`research/kb/知识库-v1.json` 只登记 4 类，而 ADR-0013 的遗留项、评测脚本、外部标准条目都在这个视野之外。",
        [
            {"key": "A", "label": "在现有 4 类之上补 K6/K7/K8 + K0 项目空间，共 9 个库；4 类不动，只是从「全部」变成「其中一层」",
             "recommended": True,
             "impact": "登记表要重建一次；好处是**不需要推翻业务侧已有的表和 owner**，共同语言不失效。"},
            {"key": "B", "label": "维持现有 4 类，只补内容不补类别",
             "recommended": False,
             "impact": "K7/K8/K6 继续没有家，Agent 契约与评测继续散在代码与 ADR 里 —— 散落本身就是本次要治的病。"},
            {"key": "C", "label": "推倒重来，改用一套全新分类（如按 Kb2Agent 的 L0–L6 分层）",
             "recommended": False,
             "impact": "业务侧已有的 4 张定义表、owner、待收集问题全部要重来，且失去与业务方的共同语言。"},
        ],
        "沉默 = 选项 A（因为它只增不改，代价最小）。",
        "A —— 4 类之上补 K6/K7/K8 + K0，共 9 个库",
        "D29",
    ),
    _q(
        "Q28", "kb",
        "K7（Agent 核心知识库）的第一批 Skill 是什么",
        "K7 要装的是「怎么造一个 Agent」的规程。第一批 Skill 怎么切？按载体切三条，还是做成一条大 Skill、内部按载体分支？",
        "ADR-0013 遗留 35 列出待补的三类载体；引擎与基座**已经支持**文本 / 图片 / 落地页三种载体（`ContentUnit` 契约当前即这三种）。现在的 `SKILL.md` 是一条大文档：改一处就要重跑全部命令。",
        [
            {"key": "A", "label": "按载体切三条：文本 / 图片 / 落地页",
             "recommended": True,
             "impact": "会出现三段结构相似的文档，需要把共同部分（边界声明、回执、处置层）抽出来复用 —— 抽晚了三份就开始漂。"},
            {"key": "B", "label": "只做一条「完整内容审查」的大 Skill，内部按载体分支",
             "recommended": False,
             "impact": "单页会很长，且和现在的 `SKILL.md` 一样，一改就要重跑全部命令。"},
            {"key": "C", "label": "不做 Skill 文档，把规程直接塞进守衡的系统提示词",
             "recommended": False,
             "impact": "规程变成代码，业务侧看不到、改不了、也无法被 `verify_skill.py` 检查 —— **退回「声明了没实现」的老路**。"},
        ],
        "沉默 = 选项 A。",
        "A —— K7 按载体切三条：文本 / 图片 / 落地页",
        "D30",
    ),
    _q(
        "Q29", "kb",
        "K0 项目空间的载体选哪个",
        "K0 要回答「这个项目现在是什么状态、还欠什么」。它放在哪：本地 Markdown、飞书 Base，还是两边都要？",
        "本项目已有四张飞书 Base，且已经实测过「同一组信息两边各写一份、两处开始不一致」的事故。同时业务方的入口在飞书，本地那份只有开发看。",
        [
            {"key": "A", "label": "本地 Markdown 一页纸（`PMO/项目空间.md`）+ 由脚本从三个登记表**生成**其中的「未知清单」",
             "recommended": True,
             "impact": "业务方看不到；好处是**可被检查**（生成物手改会红，本项目已有这套机制）。"},
            {"key": "B", "label": "搬到飞书，做成一个 Base",
             "recommended": False,
             "impact": "立刻多出第五个 Base，「统一入口」的问题没解决反而加重。"},
            {"key": "C", "label": "两边都要：飞书放给人看的、本地放给机器读的，用指纹对账",
             "recommended": False,
             "impact": "多一道同步维护；收益要到「业务方真的会来查」时才兑现。**但它同时是第一次真正验证双账本对账机制的机会。**"},
        ],
        "沉默 = 选项 A。",
        "C —— 两边都要：飞书给人看、本地给机器读，用指纹对账",
        "D31",
    ),
    _q(
        "Q30", "kb",
        "飞书那 99 条表怎么处置",
        "飞书侧一张 99 条的表里同时装着三件不同的东西（真样本 / 待收集问题 / 结构说明）。怎么处置：拆表、先补料再拆，还是不拆？",
        "99 条里只有少数几条带原文；本项目的真样本准入条件尚未写死，于是「缺原文的条目」和「真样本」在同一张表里长得一样。",
        [
            {"key": "A", "label": "拆成三张表，**先拆不补**；「必须有原文」作为真样本的准入条件，下一步执行",
             "recommended": True,
             "impact": "短期内样本表变空（真样本要补原文才算数），要接受一段「看起来更空」的时期。**拆表是纯结构动作，不需要业务方供料。**"},
            {"key": "B", "label": "先给 87 条补原文，再拆表",
             "recommended": False,
             "impact": "原文补齐依赖业务方翻历史记录，**可能拖很久，期间结构问题继续存在**。"},
            {"key": "C", "label": "不拆，在登记表里加一列「这条其实是什么」",
             "recommended": False,
             "impact": "等于承认一张表可以装三件事 —— **这正是本项目反复修的缺陷，会再犯一次**。"},
        ],
        "沉默 = 选项 A。",
        "A —— 99 条拆成三张表，先拆不补；「必须有原文」作真样本准入条件",
        "D32",
    ),
    _q(
        "Q31", "kb",
        "本地登记表与飞书实况的落差怎么修",
        "`知识库-v1.json` 的输入是**本地快照**，而飞书侧是实况。两者的落差怎么修：改成飞书实时、印快照日期，还是维持手工刷新？",
        "★ 本次实测：正因为输入是过期快照且没人看日期，一个知识库被**误报为空白**。D26 已经就刷新节奏判过一次（选了手工），本次实测给出了它的代价。另有「发现 4」的方向反转：本地算完写飞书，但重算结果不回投影。",
        [
            {"key": "A", "label": "输入从「本地快照」改为「飞书实时」+ 表头印每次拉取的时间戳 + 重算结果**推回飞书投影**",
             "recommended": True,
             "impact": "每次重算要联网；离线场景会失败 —— 但**失败得清楚**，好过静默给出过期数字。"},
            {"key": "B", "label": "维持快照输入，但在登记表里显式印出快照日期，让读者自己判断是否过期",
             "recommended": False,
             "impact": "这次就是因为没人看日期才出的问题；且**「空白」这种结论不会因为印了日期就变得可疑**。"},
            {"key": "C", "label": "不修，把刷新做成手工动作，需要时再跑",
             "recommended": False,
             "impact": "D26 已经这么判过；**本次实测证明它的代价是「一个知识库被误报为空白」**。"},
        ],
        "沉默 = 选项 A。",
        "A —— 登记表输入改飞书实时 + 表头印时间戳 + 重算结果推回飞书投影",
        "D33",
    ),
    _q(
        "Q32", "repo",
        "三套未决 ID（D# / Q# / 遗留#）要不要合并",
        "本仓现在有三套并行的未决编号：`$decision_queue` 的 `Q#`、`decisions` 的 `D#`、以及 ADR 里的 `遗留#`（≈83 行）。要不要合并进单一编号空间？",
        "D12 把「未决项写在哪」收敛成了一处，但**编号空间仍是三套**：回答「还欠多少决定」需要打开三个文件自己数。三套体系本身就是 K0 要解决的问题的一个实例。",
        [
            {"key": "A", "label": "合并进 `$decision_queue` 单一编号空间，`D#` / `遗留#` 作为别名保留在各自制品里",
             "recommended": True,
             "impact": "一次性迁移成本（约 100+ 条），且要改 V30 检查；收益是「欠了多少决定」可一条命令回答。**别名保留**是为了不把编号迁移变成一次全仓文本改写。"},
            {"key": "B", "label": "维持三套，只加一个交叉索引文件",
             "recommended": False,
             "impact": "索引本身会漂（它不在任何检查里）；且「三套体系」这件事本身就是 K0 要解决的问题。"},
            {"key": "C", "label": "不动",
             "recommended": False,
             "impact": "现状。Owner 继续需要打开三个文件才能知道欠了多少决定。"},
        ],
        "沉默 = 选项 C（= 现状）：Owner 继续需要打开三个文件才能知道欠了多少决定。",
        "A —— 三套未决 ID 合并进 $decision_queue 单一编号空间，D#/遗留# 作别名保留",
        "D34",
    ),
    _q(
        "Q33", "kb",
        "K8 评测库要不要现在做",
        "对外一直用 `offline_replay` 的 P/R/F1 说话，而它从未被独立标注验证过。K8 评测库现在做，还是先做留出集回归基线，还是暂不做？",
        "★ 两条实测改变了这道题的形状：① 错题本 `errorbook.csv` 的 `人工复判结论/复判人/复判时间/处置码/处置人/处置日期` 六列填充率**全部 0/177**，源表 `检查人` 也是 `0/291` —— **连谁标的都不知道**；② 公开数据显示**人类标注者彼此一致率只有 79%**（AI Evaluator 与人类 74%）。两条合起来：**κ 不是「验证引擎准不准」，是「先搞清楚人工基准本身有多可信」**；而本仓今天没有回填机制，那意味着任何评测集都会在第 N 天退化成一张冻结快照。",
        [
            {"key": "A", "label": "做，但只做最小可用：两个独立标注人 × 50 条，出 κ；κ 不到 0.6 就先不外说「判定可靠」",
             "recommended": True,
             "impact": "需要 2 个人 × 约半天；且**可能测出 κ 不合格**，那会推迟对外承诺。"},
            {"key": "B", "label": "先做留出集固化与回归基线（纯机器，不需人），κ 留到有真样本之后",
             "recommended": False,
             "impact": "`heldout_test.py` 已经证明过**留出集能推翻主实验**（99.2% → 32.4%），说明这类检查值得先做；但没有 κ 就不知道「人工标注本身可不可信」。"},
            {"key": "C", "label": "暂不做",
             "recommended": False,
             "impact": "继续用 `offline_replay` 的 P/R/F1 说话，而它从未被独立标注验证过。"},
        ],
        "沉默 = 选项 C：继续用 `offline_replay` 的 P/R/F1 说话，而它从未被独立标注验证过。",
        "A —— 先修回填机制 + 同时出 κ；κ < 0.6 不外说「判定可靠」",
        "D35",
    ),
    _q(
        "Q34", "engine",
        "要不要补「语义模型层」（对标得出的最大架构缺口）",
        "9 个对标项目**没有一个用纯词表做审核**，全部是「确定性规则先跑 → 喂给 LLM → 决策层仲裁」；守衡今天停在第一层，直接后果是 **catch-all 54.6%**（一半以上文案没有任何规则覆盖）与「未覆盖被读成合规」。要不要补语义层？补到什么程度？",
        "catch_all 占比 54.6%（实测）；9 个对标项目的架构均为三层。另有两处会限制实现方式：ADR-0005 约束 5「没有回执的判定不算发生过」；V21a「机器独立拦截必须带齐最小证据集（规则/位置/带/所需材料）」。",
        [
            {"key": "A", "label": "先**只补一处**：对 `coverage=catch_all` 的条目加一次 LLM 语义判定，输出**仍是建议**（落 DP3 人工复核，不改变机器终结权）",
             "recommended": True,
             "impact": "引入模型调用与不确定性，需要新的**证据等级**与**回执字段**；好处是**直接打在 54.6% 的空白上**，且不触碰已经稳定的规则层。"},
            {"key": "B", "label": "全面补语义层，让 LLM 参与所有判定",
             "recommended": False,
             "impact": "动摇 `engine_version` 的可复现性 —— 同一条文案两次运行可能结论不同，而这是本项目全部回执与申诉的基础。"},
            {"key": "C", "label": "不补，把 catch-all 明确交给人工，知识库层面的工作优先",
             "recommended": False,
             "impact": "`catch_all` 目前是「沉默的 54.6%」，转人工会让审核侧工作量翻倍；但至少语义诚实。"},
        ],
        "沉默 = 选项 C：54.6% 的文案继续停在「规则库没有覆盖它」这一步，不进任何队列。",
        "A —— 只补 catch_all 一处语义判定，输出仍是建议、落 DP3、不夺机器终结权",
        "D36",
    ),
]

# ─────────────────────────────────────────────────────────────────────
# 三、Q35 —— **入库过程中查出来的新未决项**，不是本批的输入。
#    Q32（→D34）把合并范围写成「D# / Q# / 遗留#」三套；执行这次入库时按编号扫了一遍全仓，
#    发现 `research/kb/缺口-v1.json` **自带第四套 `D#`（D1–D16）和第五套 `Q#`**，
#    与台账同名不同物。这不是我的改动造成的（撞车在我改之前就存在），
#    但它正好落在**下一轮 D34 迁移**的必经之路上：
#    迁移脚本若按 `\bD(\d+)\b` 全仓扫（最自然的实现），会把缺口表的 16 条一起改掉。
#    按本项目纪律「发现必须落在唯一该落的位置」，它在这里入队，而不是留在散文里。
# ─────────────────────────────────────────────────────────────────────
Q35 = {
    "id": "Q35",
    "kind": "governance_question",
    "line": "repo",
    "status": "open",
    "owner": "Owner（经开发转达）",
    "raised_at": "2026-09-17",
    "title": "缺口登记的 `D#` 与台账的 `D#` 同名不同物 —— 合并编号空间时怎么处置",
    "question": "Q32 裁定的合并范围是「三套未决 ID：`D#` / `Q#` / `遗留#`」（→ D34）。入库 Q27–Q34 时按编号扫了一遍全仓，实测出**这个范围漏了两套**：`research/kb/缺口-v1.json` 里的 16 条数据缺口用的是它**自己的 `D1`–`D16`**，`affects` 字段用的是它**自己的 `Q#`**（Q1/Q3/Q6/Q7/Q8/Q10）。于是同一个 `D1` 在两处指两件事：缺口表里是「源系统没有状态变更时间戳」，台账里是「`auto_reject` 是否允许机器独立拦截」。这**不是本次改动造成的**（撞车在我改之前就存在），但它落在下一轮 D34 迁移的必经之路上 —— 迁移脚本最自然的实现是 `\\bD(\\d+)\\b` 全仓扫，那会把缺口表的 16 条一起改掉。要现在定口径：合并时把哪一套改名，还是维持并存。",
    "evidence": "实测：`python3 -c \"import json;print([g['id'] for g in json.load(open('research/kb/缺口-v1.json'))['gaps']])\"` → `D1`–`D16`；`python3 tools/verify_kb.py` 的 E1 行原样打印这些编号（「引用登记编号 ['D1','D2','D3','D6','D7','D8']」），读者看到的是一串和台账同形的 `D#`。台账侧为 `decisions[].id` = `D1`–`D36`、`$decision_queue[].id` = `Q1`–`Q35`。",
    "options": [
        {"key": "A",
         "label": "缺口编号改用独立前缀（`GAP#`），16 条一次性改过去；台账的 `D#` 保持原义",
         "recommended": True,
         "impact": "要同时改 `缺口-v1.json`、`tools/kb_gaps.py`、`verify_kb.py` 的 E1 检查与 README 的引用 —— 一次文本改写，**与 D34「保留别名以免全仓改写」的原则有张力**。换来的是 `D#` 全仓只有一个意思。改名必须留别名（旧编号写进 `$renamed_from`），否则「改编号」会顺手制造一批新的悬空引用。"},
        {"key": "B",
         "label": "缺口表不动，改台账的 `D#` 加前缀（如 `DEC#`）",
         "recommended": False,
         "impact": "台账是全仓引用最密的一处（V30b/V30g 的判据、ADR、多处散文都在点名 `D#`），改写面最大 —— 等于把最贵的那个改名，去省下最便宜的那个。"},
        {"key": "C",
         "label": "维持现状，只加一句说明「两个 `D#` 不同物」",
         "recommended": False,
         "impact": "读的人仍需先判断这个 `D#` 属于哪套；且下一轮 D34 的迁移脚本若按 `\\bD(\\d+)\\b` 全仓扫，**会把缺口表的 16 条一起改掉** —— 这是本项的即时风险，不是理论风险。"},
    ],
    "default_if_unanswered": "沉默 = 选项 C（维持现状）：两套 `D#` 并存，**并且 D34 的迁移轮必须在脚本里显式排除 `research/kb/缺口-v1.json`**，否则 16 条缺口编号会被误改。把这句话写进 default，是为了让「沉默」也有一个可执行的后果，而不是一句免责声明。",
    "where": "`research/kb/缺口-v1.json`（`gaps[].id` 与 `affects`）与 `research/governance/skeleton/legal-decisions-v1.json`（`decisions[].id` / `$decision_queue[].id`）；检查 `python3 tools/verify_kb.py`（E1/E2）。",
    "$origin": "本次入库（Q27–Q34 → D29–D36）时的顺带实测，**不是**本批的输入。",
}

BATCH_NOTE = (
    "★ 2026-09-17 第十批（讨论稿 §九 · D29–D36）：Q27–Q34 八项由 Owner 逐条裁定，八个推荐项全中"
    "（A/A/C/A/A/A/A/A）。这一批与以往不同的地方：**问题在被回答之前先被实测改过形状** —— "
    "Q31 的选项 C（=现状）在本次实测里刚刚产生过一次误报（一个知识库被读成空白），"
    "Q33 则在提问后被两条实测改写（错题本六列填充率全 0、人类标注者一致率 79%），"
    "于是它的答案从「做不做评测」变成「先搞清楚人工基准可不可信」。"
    "★ 本批**只入库、不迁移**：Q32 裁定的三套 ID 合并是 ≈100+ 条的一次性迁移（→ D34），"
    "单独一轮做；混批会让「两处状态不一致」的窗口和入库动作重叠。"
    "★ 本批八条里六条是**口径决定**、只有 D29（9 库定义表）会产生制品；"
    "其余五条各自的 `$artifact` 都写明了「未落地前是什么状态」—— "
    "**决定不等于制品**，这句话在 B4 之前尤其要紧。"
    "★ 未决项会随作答而增加，这是机制在正常工作，不是没做完。"
)

BATCH_NOTE_2 = (
    "★ 2026-09-17 第十批（附）：入库 Q27–Q34 的过程**自己产出了一条新的未决项 Q35** —— "
    "按编号扫全仓时实测出 `research/kb/缺口-v1.json` 自带第四套 `D#`（D1–D16，数据缺口）"
    "与第五套 `Q#`，与台账的 `D1`–`D36` / `Q1`–`Q34` **同名不同物**。"
    "Q32（→D34）裁定的合并范围只写了三套，**漏了这一处**；而它正落在下一轮迁移的必经之路上"
    "（迁移脚本若按 `\\bD(\\d+)\\b` 全仓扫，会把缺口表 16 条一起改掉）。"
    "★ 这条不是本次改动的产物（撞车在我改之前就存在）—— 入库这个动作把它**变成可见的**，"
    "这本身就是「作答会带出新问题」的又一个实例。"
)


def main() -> int:
    check_only = "--check" in sys.argv
    # ★ 2026-09-22 补的写盘门。**这是本批唯一一次真正的写盘，目标又恰好是「唯一台账」。**
    #
    # 修之前：不带任何参数直接 `python3 tools/_ingest_batch10.py` 就会**静默改写**
    # `research/governance/skeleton/legal-decisions-v1.json`（`$decision_queue` 的唯一书写位置）。
    # 而同族的 `_ingest_batch12.py:92` / 同批的 `_migrate_ids_batch11.py:39` **都有 `--write` 门** ——
    # 只有这一个漏了。诊断 #17 点的就是它。
    #
    # 为什么这条值得专门补：一次误跑**不会报错、不会变红**，只会让唯一台账多出 8 条决定
    # 与 9 道题（而且看起来完全正常，因为那正是它本来要写的东西）——
    # 于是「这份台账是谁在什么时候因为什么改的」这个问题的答案就没了。
    # 加门之后：**默认只预演、不写盘**，写盘必须显式 `--write`。
    write = "--write" in sys.argv
    doc = json.loads(LEDGER.read_text(encoding="utf-8"))

    have_d = {d["id"] for d in doc["decisions"]}
    have_q = {q["id"] for q in doc["$decision_queue"]}
    add_d = [d for d in DECISIONS if d["id"] not in have_d]
    add_q = [q for q in QUEUE if q["id"] not in have_q]
    if Q35["id"] not in have_q:
        add_q.append(Q35)

    print(f"台账现有：{len(doc['decisions'])} 条决定 · {len(doc['$decision_queue'])} 道题")
    print(f"本次新增：{len(add_d)} 条决定 {[d['id'] for d in add_d]} · "
          f"{len(add_q)} 道题 {[q['id'] for q in add_q]}"
          f"（其中 open：{[q['id'] for q in add_q if q['status'] == 'open']}）")
    if check_only:
        return 0
    if not write:
        print("\n（预演，未写盘。加 --write 落盘）")
        return 0
    if not add_d and not add_q:
        print("已幂等，无改动。")
        return 0

    doc["decisions"].extend(add_d)
    doc["$decision_queue"].extend(add_q)
    for note in (BATCH_NOTE, BATCH_NOTE_2):
        if note not in doc["$decision_queue_note"]:
            doc["$decision_queue_note"].append(note)

    # 写盘格式必须与既有文件逐字节一致：indent=1 · ensure_ascii=False · 无尾换行
    LEDGER.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"已写入 {LEDGER.relative_to(ROOT)}")
    print(f"现在：{len(doc['decisions'])} 条决定 · {len(doc['$decision_queue'])} 道题")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

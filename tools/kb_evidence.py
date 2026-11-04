#!/usr/bin/env python3
"""
kb_evidence.py —— 需求 → 证据 映射（P1.2 / P1.3）

回答一个问题：**台账里的每一条需求，本地有没有支撑它的证据？**

「证据」在本项目里有明确所指（见 PRD 与业务侧知识库定义）：某个品线的
规则边界、卖点边界、正负样本、改写建议。这些都是**品线专属**资产，
不是"提到过这个词的文档"。

所以本脚本刻意**不用关键词全文命中**当证据 —— 那会把
`research/repos/` 的 348 个外部克隆仓库和 237 份方法论文档算成"证据"，
得出一个漂亮但无意义的覆盖率。取而代之：

  证据来源 = 指定的资产类别（可评审的清单）
  证据归属 = 该资产里是否出现**该品线的名称**

产出：
  research/kb/证据映射.json
  research/kb/缺口表.md

用法：
  python3 tools/kb_evidence.py
"""

import collections
import json
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                "research", "kb"))
import load  # noqa: E402

LEDGER = os.path.join(load.KB, "台账-v1.json")
INDEX = os.path.join(load.KB, "索引-本地资产.json")
OUT_JSON = os.path.join(load.KB, "证据映射.json")
OUT_MD = os.path.join(load.KB, "缺口表.md")

# ── 什么算「合规证据」：只认本地产出的、与内容边界直接相关的资产 ──────────
EVIDENCE_KINDS = {"决策", "需求文档", "需求知识库", "调研与审计", "蒸馏资产", "运营复盘"}
# 明确不算证据的（列出来是为了让"为什么不算"可被审查）
NON_EVIDENCE = {
    "外部参考仓库": "别人仓库的克隆，不是我们自己的判定依据",
    "方法论": "讲怎么做，不讲某品线能不能这么说",
    "技能盘点": "技能目录清点",
    "工具": "代码，不是内容证据",
    "离线复现": "验证记录",
}

# ── 品线归一：源系统的品线取值很碎（40 个），按业务实际归成 8 族 ────────
# 这张表是**决策**，写在代码里是因为它需要能被一眼看完；
# 改它等于改口径，应当同步更新 ADR-0010。
FAMILY = {
    "吸奶器": ["吸奶器", "吸奶器配件", "法兰罩", "母乳喂养", "泵乳", "泌乳护理", "哺乳",
             "乳头霜", "母乳储存", "冻奶", "吸奶文胸"],
    "婴幼儿": ["婴幼儿", "婴儿车", "婴儿推车", "婴儿背带", "婴儿秋千", "婴儿护理",
             "婴儿体重", "健康监测", "吸鼻器", "尿布桶", "摇椅", "电动秋千", "安抚椅",
             "高脚椅", "辅食椅", "高脚餐椅", "监视器"],
    "喂养":   ["喂养", "喂养电器", "奶瓶喂养", "奶瓶消毒器", "烘干", "奶瓶清洗机",
             "暖奶器", "配方奶"],
    "孕产":   ["孕期", "孕产", "孕妇枕", "孕期营养", "孕期健康", "睡眠与疼痛舒缓"],
    "家纺":   ["家纺"],
    "家居":   ["家居"],
    "服纺":   ["服纺"],
    "护肤":   ["护肤"],
}
FAMILY_ORDER = ["吸奶器", "婴幼儿", "喂养", "孕产", "家纺", "家居", "服纺", "护肤"]

# ── 已声明的品线专属证据 ────────────────────────────────────────────────
# **为什么必须手工声明、不能只靠关键词命中**
#
#   关键词法在本项目会系统性**低估**吸奶器的证据：
#   `whitelist-v1.json`、`context-guards-v1.json`、`errorbook/错题本.md`
#   里「吸奶器」出现 **0 次** —— 它们整份文档就是吸奶器专属的，所以不必自我声明。
#   反过来，`R2-adjudication-casebooks.md` 里「吸奶器」出现很多次，
#   但它是**案例调研**，不是判定依据。
#
#   所以：**声明的是权威，命中的是线索。** 两者分列，不混为一谈（ADR-0005）。
DECLARED = {
    "吸奶器": [
        ("research/governance/skeleton/rules-v1.json",
         "品线内容边界规则库 21 条；适用产品全部为吸奶器型号 W1/M5/M6/M9/Air1"),
        ("research/governance/skeleton/whitelist-v1.json",
         "安全词白名单 26 词（独立成表，ADR-0008）"),
        ("research/governance/skeleton/context-guards-v1.json",
         "语境守卫 89 词（独立成表，ADR-0009）"),
        ("research/governance/errorbook/错题本.md",
         "错题本 143 行 × 25 列，从 291 条广告明细生成"),
        ("research/governance/规范-审核规则库完整设计.md",
         "规则库骨架与自迭代 SOP"),
        ("PRD/内容治理需求文档.md",
         "21 规则 + W1 卖点表达边界 19 条 + 风险文案改写建议 52 条 + 广告明细 291 条"),
    ],
}
DECLARED_NOTE = {
    "吸奶器": ("全部本地合规证据**只覆盖吸奶器一个品线**：规则 21 条、白名单 26 词、"
             "语境守卫 89 词、错题本 143 行、卖点边界 19 条、改写建议 52 条，"
             "适用产品无一例外是吸奶器型号。"),
}


def family_of(v):
    if not v:
        return None
    s = str(v)
    for fam, keys in FAMILY.items():
        for k in keys:
            if k in s:
                return fam
    return None


def main():
    led = json.load(open(LEDGER, encoding="utf-8"))
    idx = json.load(open(INDEX, encoding="utf-8"))
    recs = [r for r in led["records"] if r["role"] != "excluded"]

    # ── 需求侧：按品线族聚合 ─────────────────────────────────
    demand = collections.defaultdict(lambda: {"n": 0, "by_table": collections.Counter(),
                                              "by_status": collections.Counter(),
                                              "overdue": 0, "no_due": 0,
                                              "examples": []})
    unmapped = collections.Counter()
    for r in recs:
        fam = family_of(r.get("product_line"))
        if not fam:
            if r.get("product_line"):
                unmapped[str(r["product_line"])] += 1
            continue
        d = demand[fam]
        d["n"] += 1
        d["by_table"][f"{r['source_system']}:{r['source_table']}"] += 1
        d["by_status"][r.get("status") or "(源表未填)"] += 1
        if r.get("date_due"):
            due = load.days_between(r["date_due"], load.today())
            if due < 0 and r.get("status") not in ("已完成",):
                d["overdue"] += 1
        else:
            d["no_due"] += 1
        if len(d["examples"]) < 3 and r.get("title"):
            d["examples"].append(r["title"][:60])

    # ── 证据侧 ────────────────────────────────────────────────
    # (a) 已声明：权威
    declared = collections.defaultdict(list)
    for fam, items in DECLARED.items():
        for path, why in items:
            declared[fam].append({"path": path, "why": why})

    # (b) 关键词线索：只作参考，不计入分级
    discovered = collections.defaultdict(list)
    for a in idx["assets"]:
        if a["kind"] not in EVIDENCE_KINDS:
            continue
        fams = {family_of(k) for k in a["keywords"]}
        fams.discard(None)
        if 0 < len(fams) <= 3:
            for fam in fams:
                discovered[fam].append({"path": a["path"], "kind": a["kind"],
                                        "title": a["title"]})

    # ── 分级：只看**已声明**的证据 ────────────────────────────
    def grade(fam):
        n = len(declared.get(fam, []))
        if n >= 3:
            return "已支撑"
        if n:
            return "部分"
        return "空白"

    rows = []
    for fam in FAMILY_ORDER:
        d = demand.get(fam, {"n": 0, "by_table": collections.Counter(),
                             "by_status": collections.Counter(), "overdue": 0,
                             "no_due": 0, "examples": []})
        dec, disc = declared.get(fam, []), discovered.get(fam, [])
        rows.append({
            "品线族": fam,
            "需求条数": d["n"],
            "已完成": d["by_status"].get("已完成", 0),
            "进行中": d["by_status"].get("进行中", 0),
            "未开始": d["by_status"].get("未开始", 0),
            "已停滞": d["by_status"].get("已停滞", 0),
            "无状态": d["by_status"].get("(源表未填)", 0),
            "无计划完成日期": d["no_due"],
            "疑似逾期": d["overdue"],
            "已声明证据数": len(dec),
            "已声明证据": dec,
            "关键词线索数": len(disc),
            "关键词线索样例": [x["path"] for x in disc[:5]],
            "证据分级": grade(fam),
            "说明": DECLARED_NOTE.get(fam),
            "需求样例": d["examples"],
        })

    doc = {
        "snapshot_id": led["snapshot_id"],
        "generated_by": "tools/kb_evidence.py",
        "evidence_kinds_included": sorted(EVIDENCE_KINDS),
        "evidence_kinds_excluded": NON_EVIDENCE,
        "family_rule": FAMILY,
        "note": ("证据分两列，不混为一谈（ADR-0005）：\n"
                 "  · **已声明证据** = 人工确认的品线专属判定依据，带理由，**分级只看这一列**；\n"
                 "  · **关键词线索** = 文本命中，仅作进一步排查的入口，不计入分级。\n"
                 "关键词法在本项目会系统性低估吸奶器证据：whitelist/context-guards/错题本里"
                 "「吸奶器」出现 0 次，因为整份文档就是吸奶器专属的，不必自我声明。"),
        "unmapped_product_lines": dict(unmapped.most_common(20)),
        "rows": rows,
        "totals": {
            "demands_mapped": sum(r["需求条数"] for r in rows),
            "demands_total": len(recs),
            "demands_unmapped": sum(unmapped.values()),
            "declared_evidence": sum(r["已声明证据数"] for r in rows),
            "lines_with_evidence": sum(1 for r in rows if r["已声明证据数"]),
            "lines_without_evidence": sum(1 for r in rows if not r["已声明证据数"]),
        },
    }
    json.dump(doc, open(OUT_JSON, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    # ── 打印 + 写缺口表 ──────────────────────────────────────
    t = doc["totals"]
    print(f"═══ 需求 → 证据 映射（快照 {led['snapshot_id']}）═══")
    print(f"  台账 {t['demands_total']} 条，按品线归入 {t['demands_mapped']} 条，"
          f"{t['demands_unmapped']} 条品线未识别")
    print(f"  已声明品线专属证据 {t['declared_evidence']} 项，覆盖 "
          f"{t['lines_with_evidence']}/{len(rows)} 个品线族\n")
    hdr = (f"  {'品线族':<8}{'需求':>5}{'完成':>5}{'在途':>5}{'未开始':>6}{'停滞':>5}"
           f"{'无状态':>6}{'无到期':>6}{'逾期':>5}{'已声明证据':>10}  分级")
    print(hdr)
    print("  " + "─" * (len(hdr) - 2))
    for r in rows:
        print(f"  {r['品线族']:<8}{r['需求条数']:>5}{r['已完成']:>5}{r['进行中']:>5}"
              f"{r['未开始']:>6}{r['已停滞']:>5}{r['无状态']:>6}{r['无计划完成日期']:>6}"
              f"{r['疑似逾期']:>5}{r['已声明证据数']:>10}  {r['证据分级']}")

    print(f"\n═══ 未识别的品线取值（{len(unmapped)} 种）═══")
    for k, v in unmapped.most_common(12):
        print(f"  {v:>4}  {k[:56]}")

    # 写缺口表
    lines = [
        "# 需求 → 证据 缺口表",
        "",
        f"> 快照 `{led['snapshot_id']}`　复算：`python3 tools/kb_evidence.py`",
        "> 口径：**已声明证据**（人工确认的品线专属判定依据，带理由）才算证据；",
        "> 关键词命中只作线索，不计入分级。理由见 `research/kb/证据映射.json` 的 `note`。",
        "",
        "## 一、按品线的需求与证据对照",
        "",
        "| 品线族 | 需求条数 | 已完成 | 进行中 | 未开始 | 已停滞 | 无状态 | 无计划完成日期 | 疑似逾期 | 已声明证据 | 分级 |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|",
    ]
    for r in rows:
        lines.append(f"| {r['品线族']} | {r['需求条数']} | {r['已完成']} | {r['进行中']} | "
                     f"{r['未开始']} | {r['已停滞']} | {r['无状态']} | {r['无计划完成日期']} | "
                     f"{r['疑似逾期']} | {r['已声明证据数']} | **{r['证据分级']}** |")
    lines += ["", "## 二、逐品线的已声明证据", ""]
    for r in rows:
        lines.append(f"### {r['品线族']}（{r['已声明证据数']} 项 · {r['证据分级']}）")
        lines.append("")
        if r["说明"]:
            lines.append(f"> {r['说明']}")
            lines.append("")
        if r["已声明证据"]:
            for e in r["已声明证据"]:
                lines.append(f"- `{e['path']}` —— {e['why']}")
        else:
            lines.append("- **无** —— 本地没有任何品线专属的规则/边界/样本资产。"
                         f"该品线有 {r['需求条数']} 条需求。")
        if r["关键词线索数"]:
            lines.append("")
            lines.append(f"<sub>关键词线索 {r['关键词线索数']} 个（仅供参考，不计入证据）："
                         + "、".join(f"`{p}`" for p in r["关键词线索样例"]) + "</sub>")
        lines.append("")
    lines += ["## 三、未识别的品线取值", "",
              "下列取值未能归入任何一个品线族，需要人工确认口径：", ""]
    for k, v in unmapped.most_common(20):
        lines.append(f"- {v} 条：`{k}`")
    lines.append("")
    open(OUT_MD, "w", encoding="utf-8").write("\n".join(lines))

    print(f"\n→ {os.path.relpath(OUT_JSON, load.REPO)}")
    print(f"→ {os.path.relpath(OUT_MD, load.REPO)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

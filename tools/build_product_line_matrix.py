#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""build_product_line_matrix.py —— 生成「品线确认表」CSV（交给产品填）

★ 为什么不生成「26 条规则 × 10 条品线 = 260 格」的全矩阵

  因为那样交出去的不是一个问题，是一份作业。而且**填错比不填更坏**：
  `product_lines` 是收窄动作，写错一个值会让规则在所有品线上静默消失（漏报）。

  所以本脚本只把**有证据表明需要问**的规则放进表里：
    · `measure_cross_line_homographs.py` 实测到「在其他品线真实文本上会命中」的规则；
    · 以及人工构造演示里已复现同形异义的规则。
  表里对每一格只问一件事：**这条规则在该品线上会不会出现同形异义？**

用法：
  python3 tools/build_product_line_matrix.py
  python3 tools/build_product_line_matrix.py --json
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKEL = ROOT / "research" / "governance" / "skeleton"
sys.path.insert(0, str(SKEL))
OUT = ROOT / "research" / "governance" / "品线确认表.csv"

# 需要问产品的规则 = 实测命中其他品线的 ∪ 构造演示复现同形异义的。
# 每条附「为什么要问」的证据，不附猜测。
TARGETS = {
    "T7.1.hospital-scenario": {
        "evidence": "代理语料实测：`新生儿` 在 64 条其他品线文本上命中。例："
                    "「Arms-Out Swaddling: A Comfortable Solution for Your Newborn's Sleep Needs」（主推品 Swaddle, Pajama）",
        "hypothesis": "`新生儿` 是婴幼儿品线的通用词，规则本意是「在医院/NICU 用过」。疑似同形异义。",
    },
    "T1.1.medical-cure": {
        "evidence": "代理语料实测：`treat` 在 36 条其他品线文本上命中。例："
                    "「The 2-Year Molars Explained: Timing, Symptoms, and Treatment.」（主推品 Finger Toothbrush）",
        "hypothesis": "`treat` 作词干匹配到 `Treatment`（名词，指话题不是功效主张）。疑似同形异义，且成因是词干匹配而非品线。",
    },
    "T2.1.2.pain-relief": {
        "evidence": "代理语料实测：`pain relief` 在 3 条其他品线文本上命中。例："
                    "「First Trimester Lower Back Ache: Your Complete Guide to Early Pregnancy Pain」",
        "hypothesis": "孕期科普内容谈疼痛，不等于产品宣称缓解疼痛。疑似同形异义。",
    },
    "T5.1.safety-claim": {
        "evidence": "代理语料实测：`safest` 在 1 条其他品线文本上命中。例："
                    "「FHSS Technology: Is It the Safest Choice for Your Baby Monitor in 2026?」",
        "hypothesis": "监护器品线谈「最安全的技术」。需产品确认该品线是否允许这类表述。",
    },
    "T3.2.lactation-consultant": {
        "evidence": "代理语料实测：`ibclc` 在 1 条其他品线文本上命中。例：「IBCLC：Postpartum Care & Early Feeding」",
        "hypothesis": "标题里提到 IBCLC（国际认证泌乳顾问）不等于产品由 IBCLC 背书。疑似同形异义。",
    },
    "T2.2.suction-claim": {
        "evidence": "构造演示：`超强吸水，柔软亲肤的四件套`（家纺）→ 判 `T2.2.suction-claim` 吸力夸大，命中词 `超强`。同型："
                    "家居「超强承重」、婴幼儿「极致呵护」、护肤「超强补水」。",
        "hypothesis": "`超强`/`极致`/`超级` 是各品线通用营销词。家纺文案里它们不是吸力主张。",
    },
    "T2.2.quiet-claim": {
        "evidence": "构造演示：`静音风扇，卧室安睡`（家居）→ 判 `T2.2.quiet-claim` 噪音主张，命中词 `静音`。",
        "hypothesis": "`静音` 是通用词（风扇、家电都用）。需产品确认哪些品线会用它。",
    },
}

FILL_GUIDE = "不适用 / 适用（留空即适用） / 不确定 —— 只在『不适用』时才写说明"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    rules = {r["rule_key"]: r
             for r in json.loads((SKEL / "rules-v1.json").read_text(encoding="utf-8"))["rules"]}
    pl = json.loads((SKEL / "product-lines-v1.json").read_text(encoding="utf-8"))
    lines = [v["value"] for v in pl["values"]]

    rows = []
    for rk, meta in TARGETS.items():
        r = rules.get(rk)
        if r is None:
            print(f"⚠ 规则 {rk} 不存在于 rules-v1.json —— 跳过", file=sys.stderr)
            continue
        kws = "、".join((r.get("match") or {}).get("keywords", [])[:6])
        for ln in lines:
            rows.append({
                "规则编号": rk,
                "规则名": r.get("topic_label", ""),
                "现行处置": r.get("disposition", ""),
                "该规则的判险词（前 6 个）": kws,
                "品线": ln,
                "为什么要问": meta["hypothesis"] if ln == lines[0] else "",
                "实测证据": meta["evidence"] if ln == lines[0] else "",
                "请填": "",
                "说明": "",
            })

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", encoding="utf-8-sig", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)

    summary = {
        "file": str(OUT.relative_to(ROOT)),
        "rules_asked": list(TARGETS),
        "product_lines": lines,
        "cells": len(rows),
        "fill_guide": FILL_GUIDE,
        "default": "留空 = 该规则适用该品线（与今天的行为一致）",
    }
    if a.json:
        print(json.dumps(summary, ensure_ascii=False, indent=2))
    else:
        print(f"已生成 {OUT.relative_to(ROOT)}")
        print(f"  问 {len(TARGETS)} 条规则 × {len(lines)} 条品线 = {len(rows)} 格")
        print(f"  填写口径：{FILL_GUIDE}")
        print(f"  默认（留空）：{summary['default']}")
        print("  ★ 表里没有其余 17 条规则：它们没有『在其他品线会命中』的证据。"
              "没有证据就不该让人填 —— 那只会制造一份没人看得懂的作业。")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""measure_cross_line_homographs.py —— 在其他品线的**真实文本**上量同形异义

★ 为什么需要它

  决定 D4（品线维度）被法务转给了产品，理由是「这个要看产品本身」。
  但如果直接把「26 条规则 × 10 条品线，请填」交出去，产品面对的是 260 格
  无处下手的表格 —— 而且**填错比不填更坏**（错字会让规则静默消失）。

  正确的问法不是「哪些规则适用你们品线」，而是：
  **「这些串在你们品线上会不会出现？出现了算不算那个主张？」**
  而这个问题可以用公司自己的语料**先量一遍**，把候选压到很小的范围。

  语料来源：`seo__英语站站内blog全表.json`（1924 条真实文章标题 / 关键词，
  覆盖 Sound Machine、baby stroller、瑜伽球、diaper pail、nursing pillow 等多条品线）。

★ 必须说清的三条限制（不要把这个脚本的输出当误报率）

  1. 这是**代理语料**：SEO 文章标题 ≠ 广告文案。它的用途是**找出同形异义**，
     不是估计误报率。标题短、关键词堆砌，命中率天然偏高。
  2. 「其他品线」是**机械口径**：`主推品`/`分类` 里不含 `pump/breast/吸奶/哺乳/M9…`
     即算其他品线。口径写在 `PUMP_HINTS` 里，可复核也可推翻。
  3. 脚本**不判断**某次命中是真问题还是同形异义 —— 它只把证据摆出来，
     连同出处（主推品 / 分类）一起。判断是产品的事。

用法：
  python3 tools/measure_cross_line_homographs.py
  python3 tools/measure_cross_line_homographs.py --top 12 --json
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKEL = ROOT / "research" / "governance" / "skeleton"
sys.path.insert(0, str(SKEL))

SNAPSHOT = (ROOT / "research" / "kb" / "_evidence"
            / "snapshot-20260916T071634Z" / "seo__英语站站内blog全表.json")
OUT_CSV = ROOT / "research" / "governance" / "品线同形异义-实测.csv"

# 「吸奶器品线」的机械口径。命中即归入吸奶器侧，不计入同形异义候选。
PUMP_HINTS = ["breast", "pump", "milk", "lactation", "nursing",
              "吸奶", "哺乳", "催乳", "奶瓶", "母乳",
              "m9", "m5", "m6", "s9", "s12", "v1 pro", "v2 pro", "air1", "air 1"]


def load_texts() -> list[dict]:
    doc = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
    out = []
    for r in doc["records"]:
        f = r.get("fields") or {}
        parts = [str(f.get(k) or "") for k in ("标题", "关键词", "中文关键词")]
        txt = " | ".join(p for p in parts if p.strip())
        if not txt.strip():
            continue
        line_vals = [str(f.get("主推品") or "")]
        cat = f.get("分类")
        if isinstance(cat, list):
            line_vals += [str(x) for x in cat]
        elif cat:
            line_vals.append(str(cat))
        out.append({
            "text": txt,
            "line": " / ".join(v for v in line_vals if v.strip()) or "(未标)",
            "title": str(f.get("标题") or ""),
        })
    return out


def is_pump(text: str, line: str) -> bool:
    blob = (text + " " + line).lower()
    return any(h in blob for h in PUMP_HINTS)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--top", type=int, default=10, help="每条规则最多列几个例子")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    import score as S
    import judge as J

    eng = J.engine()
    texts = load_texts()
    per_rule = defaultdict(lambda: {"pump": 0, "other": 0, "examples": []})
    n_other = 0
    for t in texts:
        pump = is_pump(t["text"], t["line"])
        if not pump:
            n_other += 1
        hits, _ca = eng.assess(t["text"])
        for h in hits:
            d = per_rule[h.rule_key]
            d["pump" if pump else "other"] += 1
            if not pump and len(d["examples"]) < a.top:
                d["examples"].append({
                    "matched": h.matched[:4],
                    "line": t["line"][:60],
                    "title": t["title"][:90],
                })

    rows = []
    for rk, d in sorted(per_rule.items(), key=lambda kv: -kv[1]["other"]):
        rule = eng.vocab.rules.get(rk, {})
        rows.append({
            "rule_key": rk,
            "topic_label": rule.get("topic_label", ""),
            "disposition": rule.get("disposition", ""),
            "hits_pump_side": d["pump"],
            "hits_other_lines": d["other"],
            "examples": d["examples"],
        })

    OUT_CSV.parent.mkdir(parents=True, exist_ok=True)
    with OUT_CSV.open("w", encoding="utf-8-sig", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["规则编号", "规则名", "现行处置", "吸奶器侧命中", "其他品线命中",
                    "命中词", "出处（主推品/分类）", "标题"])
        for r in rows:
            if not r["examples"]:
                w.writerow([r["rule_key"], r["topic_label"], r["disposition"],
                            r["hits_pump_side"], r["hits_other_lines"], "", "", ""])
                continue
            for e in r["examples"]:
                w.writerow([r["rule_key"], r["topic_label"], r["disposition"],
                            r["hits_pump_side"], r["hits_other_lines"],
                            ", ".join(e["matched"]), e["line"], e["title"]])

    summary = {
        "texts_total": len(texts),
        "texts_other_lines": n_other,
        "texts_pump_side": len(texts) - n_other,
        "rules_firing_on_other_lines": sum(1 for r in rows if r["hits_other_lines"]),
        "rules": rows,
    }
    if a.json:
        print(json.dumps(summary, ensure_ascii=False, indent=2))
    else:
        print(f"其他品线同形异义实测 —— 代理语料 {len(texts)} 条"
              f"（吸奶器侧 {summary['texts_pump_side']} / 其他品线 {n_other}）")
        print(f"  在『其他品线』上产生命中的规则：{summary['rules_firing_on_other_lines']} 条")
        print(f"  {'规则':<28}{'其他品线':>8}{'吸奶器侧':>8}  例子")
        for r in rows:
            if not r["hits_other_lines"]:
                continue
            ex = r["examples"][0] if r["examples"] else {}
            print(f"  {r['rule_key']:<28}{r['hits_other_lines']:>8}{r['hits_pump_side']:>8}"
                  f"  [{', '.join(ex.get('matched', []))}] {ex.get('line','')[:34]}")
            print(f"  {'':<28}{'':>16}  {ex.get('title','')[:76]}")
        print(f"\n  明细 CSV：{OUT_CSV.relative_to(ROOT)}")
        print("  ★ 这是代理语料（SEO 标题），用途是找同形异义，不是误报率。")
    return 0


if __name__ == "__main__":
    sys.exit(main())

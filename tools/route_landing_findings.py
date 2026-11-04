#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""route_landing_findings.py —— 把 C 批的一致性问题**分成两路派出去**（D20 · 回答 Q15）

★ 它治的是「能力产出了、通路没建」：C 批查出了两类不一致，写在一份报告里，
  而报告不会通知任何人。D20 之后责任人是有的（文案侧 Roxie / 页面侧 Rikka），
  所以这一步只做一件事：**把发现变成两份带收件人的待办**。

★ 两路的划分**不是按严重程度，是按「要不要先判」**：

  · **跨 locale 参数/认证不一致 → 页面侧（Rikka）**：
    同一个产品在 de./fr./uk. 站自报不同 mmHg/dB —— 无论以谁为准，
    **至少有一个站是错的**。这一条不需要法务先判，可以直接核实。
  · **「广告有、页面无」→ 法务判定**：
    广告里写了、页面没写，可能是页面漏写，也可能是文案夸大 ——
    C 批报告自己写明「是否构成问题由法务判断」。这一路**不改任何东西**，
    只把材料整理好送进去。

★ 判据不在这里重写：`参数或认证不一致` 与 `至少一项广告声明未在落地页出现`
  都直接读 `一致性分析.json`（由 `tools/lp_consistency.py` 产出）。
  在第二个地方重算同一个判据，就是本项目已经出过三次事的那种「两处真相」。

用法：
  python3 tools/route_landing_findings.py           # 重建两份路由表
  python3 tools/route_landing_findings.py --check   # 只核对，不写
"""
import argparse
import csv
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LAND = ROOT / "research" / "landing"
SRC = LAND / "一致性分析.json"
SITES = ROOT / "research" / "governance" / "skeleton" / "_data" / "site-owners.csv"
OUT_JSON = LAND / "整改路由.json"
OUT_SITE = LAND / "整改路由-页面侧.csv"
OUT_LEGAL = LAND / "整改路由-待法务判定.csv"

SITE_FIELDS = ["产品handle", "涉及站点数", "涉及站点", "不一致项", "逐站取值",
               "责任人", "责任人出处", "送达状态", "为什么不需要先判"]
LEGAL_FIELDS = ["广告record_id", "广告名称", "风险等级", "命中规则", "落地页",
                "未在页面出现的声明数", "声明明细", "责任人", "为什么先判",
                "待法务回答的问题"]


def load_site_owner() -> dict:
    """页面侧责任人**只从 site-owners.csv 读** —— 路由目标只有一处书写位置。"""
    with SITES.open(encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))
    main = next((r for r in rows if r["域名"] == "momcozy.com"), None)
    if main is None:
        raise SystemExit("❌ site-owners.csv 里没有 momcozy.com 这一行 —— 页面侧无收件人")
    return main


def build() -> dict:
    src = json.loads(SRC.read_text(encoding="utf-8"))
    owner = load_site_owner()
    name, addr = owner["责任人"], (owner["飞书open_id"] or "").strip()
    deliverable = addr.startswith("ou_")
    # ★ 2026-09-16（D23）：Owner 就 Q17 选了「暂不填地址，站点侧只记录不送达」。
    #   所以这里的「不可送达」**不再是待办，是决定** —— 文字必须让下一个人读得出来。
    #   判据没变（V41b 仍要求地址不可用时逐行写出「不可送达」），变的是它的含义。
    status = ("可送达" if deliverable else
              f"★ 不可送达（已决定，非待办）：责任人已定（{name}），但投递地址=「{addr}」"
              f"—— Owner 2026-09-16 就 Q17 选 D（D23）：站点侧只记录、不送达；见 Q16/Q17")

    A = src["表A_广告vs落地页"]
    B = src["表B_跨locale一致性"]

    site_rows = []
    for c in B["逐产品"]:
        diffs = c.get("参数或认证不一致") or []
        if not diffs:
            continue
        items = []
        vals = []
        for d in diffs:
            items.append(d["参数"])
            vals.append(d["参数"] + "：" + " / ".join(
                f"{site.split('.')[0] or 'www'}={','.join(v)}"
                for site, v in d["各地区取值"].items()))
        site_rows.append({
            "产品handle": c["handle"],
            "涉及站点数": c["locale数"],
            "涉及站点": " ".join(c["地区站"]),
            "不一致项": " + ".join(items),
            "逐站取值": "；".join(vals),
            "责任人": name,
            "责任人出处": "research/governance/skeleton/_data/site-owners.csv",
            "送达状态": status,
            "为什么不需要先判": "同一产品在不同地区站自报不同取值 —— 无论以谁为准，至少有一个站是错的",
        })

    legal_rows = []
    for a in A["逐条"]:
        miss = a.get("页面上没有的") or []
        legal_rows.append({
            "广告record_id": a["广告record_id"],
            "广告名称": a["广告名称"],
            "风险等级": a.get("风险等级") or "",
            "命中规则": a.get("命中规则") or "",
            "落地页": a.get("落地页") or "",
            "未在页面出现的声明数": len(miss),
            "声明明细": "；".join(f"{m.get('类型')}:{m.get('广告中的表述')}" for m in miss),
            "责任人": "法务（经 Owner 转达）",
            "为什么先判": "广告写了、页面没写：可能是页面漏写，也可能是文案夸大 —— 改错方向会把对的改错",
            "待法务回答的问题": "这一条构成问题吗？构成的话，以页面为准（改文案）还是以文案为准（改页面）？",
        })

    doc = {
        "$decision": "D20 · Owner 2026-09-16 选择的「分两路」",
        "$source": "research/landing/一致性分析.json（由 tools/lp_consistency.py 产出）",
        "$note": ("本文件是 C 批发现的路由落点，不是新的判据：两类问题各自的判据都直接读上面那份来源。"
                  "两路的分界不是严重程度，是**要不要先判** —— 见各自的「为什么」列。"),
        "$delivery_mode": ("★ 两路的**送达**状态不一样，别混读：法务侧经 Owner 转达（可送达，33 条）；"
                           "站点侧**只记录、不送达**（4 条）—— 这是 Owner 2026-09-16 的决定（Q17 → D23），"
                           "不是遗漏。站点侧的责任人（Rikka）只有姓名、没有可用地址，"
                           "而本应用**没有按姓名找人的能力**（8 条通道逐条实测，见 tools/lark_people.py）。"
                           "要改这个状态：把地址填进 site-owners.csv 的「飞书open_id」列，"
                           "或改用 Q17 的 A/B/C 任一方案。"),
        "页面侧": {
            "路径": "跨 locale 参数/认证不一致 → 核实并统一",
            "收件人": name,
            "收件人出处": "research/governance/skeleton/_data/site-owners.csv",
            "送达状态": status,
            "条数": len(site_rows),
            "跨locale产品总数": B["跨 locale 产品数"],
            "$其余产品": (f"另有 {B['跨 locale 产品数'] - len(site_rows)} 个跨 locale 产品**未检出**参数/认证不一致 —— "
                          "注意这是「未发现」，不是「已核实一致」：本批只比了 mmHg / dB / 认证词三类。"),
            "逐条": site_rows,
        },
        "法务侧": {
            "路径": "「广告有、页面无」→ 法务判定是否构成问题、以谁为准",
            "收件人": "法务（经 Owner 转达）",
            "条数": len(legal_rows),
            "可对照广告数": A["可对照的广告数"],
            "口径": A["口径说明"],
            "逐条": legal_rows,
        },
    }
    return doc


def write(doc: dict) -> None:
    OUT_JSON.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    with OUT_SITE.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=SITE_FIELDS)
        w.writeheader()
        w.writerows(doc["页面侧"]["逐条"])
    with OUT_LEGAL.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=LEGAL_FIELDS)
        w.writeheader()
        w.writerows(doc["法务侧"]["逐条"])


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="只核对现存产物是否与来源一致")
    a = ap.parse_args()
    doc = build()
    if a.check:
        cur = json.loads(OUT_JSON.read_text(encoding="utf-8")) if OUT_JSON.exists() else None
        same = cur == doc
        print(f"{'✅' if same else '❌'} 整改路由.json 与来源一致：{same}")
        return 0 if same else 1
    write(doc)
    print(f"页面侧（{doc['页面侧']['收件人']}）：{doc['页面侧']['条数']} 条 → {OUT_SITE.relative_to(ROOT)}")
    print(f"  送达状态：{doc['页面侧']['送达状态']}")
    print(f"法务侧（判定是否构成问题）：{doc['法务侧']['条数']} 条 → {OUT_LEGAL.relative_to(ROOT)}")
    print(f"  {doc['页面侧']['$其余产品']}")
    print(f"机器读：{OUT_JSON.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

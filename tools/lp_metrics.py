#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
lp_metrics.py —— 落地页三项指标（批次 C · 只读）

## 这个脚本回答什么
把 `lp_fetch.py` 的事实与 `lp_extract.py` 的要素，收敛成法务验证表第二层的
**三个数字**。指标名逐字沿用法务文档，不改词：

    内容获取成功率 · 页面/素材识别完整度 · 处理耗时

## 一条不能破的规矩
**分母是全部 URL，失败项不进垃圾桶。**
本项目已吃过教训：把「读不到的 10 条材料」从材料表的分母里剔掉之后，
「收集了 15 条」看起来像成功，实际可用 5 条。
所以这里的每一个百分比都带 `分母` 字段，且失败档逐条列出 URL。

## 用法
  python3 tools/lp_metrics.py            # 打印 + 落 指标.json
  python3 tools/lp_metrics.py --md       # 额外生成 Markdown 表格片段
"""
import argparse
import json
import pathlib
import statistics
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
LAND = ROOT / "research/landing"
OUT = LAND / "指标.json"

# 成功档：拿到了可提取正文的页面
SUCCESS = {"ok", "ok_structured"}
FAIL_LABEL = {
    "empty": "HTTP 200 但正文为空（JS 渲染壳 / 空页）",
    "blocked": "被拒绝（401/403/429）",
    "http_error": "HTTP 非 200（4xx/5xx）",
    "error": "网络错误 / 超时 / DNS",
    "robots_disallowed": "robots.txt 禁止（未发请求）",
}
SIX = ["title", "body_text", "images", "claims", "links", "locale_signals"]


def pct(n, d):
    return round(100.0 * n / d, 1) if d else None


def percentiles(vals):
    if not vals:
        return {}
    v = sorted(vals)
    def p(q):
        i = min(len(v) - 1, max(0, int(round(q * (len(v) - 1)))))
        return v[i]
    return {"n": len(v), "p50": p(.50), "p90": p(.90), "p95": p(.95),
            "min": v[0], "max": v[-1], "mean": int(statistics.mean(v))}


def classify(fetch_rec, ext_rec):
    """把 tier_raw 细化为最终档位。empty 需要正文长度才能判，所以在这里定型。"""
    t = fetch_rec["tier_raw"]
    if t in ("blocked", "http_error", "error", "robots_disallowed"):
        return t
    h = (ext_rec or {}).get("html")
    if not h or h["body_chars"] < 200:
        return "empty"
    return "ok_structured" if t == "ok_structured" else "ok"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--md", action="store_true")
    args = ap.parse_args()

    fdoc = json.loads((LAND / "抓取结果.json").read_text(encoding="utf-8"))
    edoc = json.loads((LAND / "要素提取.json").read_text(encoding="utf-8"))
    ext = {r["url_key"]: r for r in edoc["results"]}
    rows = []
    for r in fdoc["results"]:
        e = ext.get(r["url_key"])
        rows.append({"url_key": r["url_key"], "url": r["url"], "domain": r["domain"],
                     "kind": r["kind"], "ad_refs": r.get("ad_refs", 0),
                     "tier": classify(r, e),
                     "attempts": r["attempts"], "fetch_tier_raw": r["tier_raw"],
                     "html_chars": (e or {}).get("html", {}).get("body_chars") if e and e.get("html") else 0,
                     "six": (e or {}).get("six"), "structured": bool((e or {}).get("structured"))})

    N = len(rows)
    ok = [r for r in rows if r["tier"] in SUCCESS]
    tiers = {}
    for r in rows:
        tiers[r["tier"]] = tiers.get(r["tier"], 0) + 1

    # ── 指标 1：内容获取成功率
    m1 = {
        "分母": N,
        "成功": len(ok),
        "成功率_pct": pct(len(ok), N),
        "分档": tiers,
        "失败明细": [{"tier": r["tier"], "url_key": r["url_key"],
                      "说明": FAIL_LABEL.get(r["tier"], "")}
                     for r in rows if r["tier"] not in SUCCESS],
        "分域名": {},
        "分类型": {},
    }
    for key, field in (("分域名", "domain"), ("分类型", "kind")):
        agg = {}
        for r in rows:
            k = r[field]
            a = agg.setdefault(k, {"分母": 0, "成功": 0})
            a["分母"] += 1
            if r["tier"] in SUCCESS:
                a["成功"] += 1
        for k, a in agg.items():
            a["成功率_pct"] = pct(a["成功"], a["分母"])
        m1[key] = dict(sorted(agg.items(), key=lambda x: -x[1]["分母"]))

    # ── 指标 2：页面/素材识别完整度（只在成功页面上算，并显式声明）
    have_six = [r for r in ok if r["six"]]
    m2 = {
        "分母_成功页面": len(ok),
        "有要素记录的页面": len(have_six),
        "声明": "完整度只在获取成功的页面上计算；失败页面不计入本指标的分母。",
        "逐要素": {},
        "完整度": {},
    }
    if have_six:
        for k in SIX:
            n = sum(1 for r in have_six if r["six"][k])
            m2["逐要素"][k] = {"达成": n, "分母": len(have_six), "覆盖率_pct": pct(n, len(have_six))}
        vals = [sum(r["six"].values()) / len(SIX) for r in have_six]
        m2["完整度"] = {"均值": round(statistics.mean(vals), 3),
                        "中位": round(statistics.median(vals), 3),
                        "六要素齐全": sum(1 for v in vals if v == 1.0),
                        "分母": len(have_six)}
        bc = sorted(r["html_chars"] for r in have_six)
        m2["正文长度"] = {"中位": bc[len(bc)//2], "p10": bc[len(bc)//10], "max": bc[-1]}

    # ── 指标 3：处理耗时
    html_t = [a["elapsed_ms"] for r in rows for a in r["attempts"]
              if a["label"] == "html" and a["status"] == 200]
    st_t = [a["elapsed_ms"] for r in rows for a in r["attempts"]
            if a["label"] == "structured" and a.get("json_ok")]
    html_b = [a["bytes"] for r in rows for a in r["attempts"]
              if a["label"] == "html" and a["status"] == 200]
    st_b = [a["bytes"] for r in rows for a in r["attempts"]
            if a["label"] == "structured" and a.get("json_ok")]
    m3 = {
        "HTML 路径": percentiles(html_t),
        "结构化端点路径": percentiles(st_t),
        "HTML 字节": {"中位": sorted(html_b)[len(html_b)//2] if html_b else None, "n": len(html_b)},
        "结构化字节": {"中位": sorted(st_b)[len(st_b)//2] if st_b else None, "n": len(st_b)},
        "抓取总墙钟秒": fdoc["manifest"].get("total_wall_seconds"),
        "说明": "耗时 = 单次 GET 的 wall time，含重定向；不含解析。",
        "分轮次": [{"轮次": p.get("kind"), "尝试": p.get("attempted"),
                    "成功": p.get("succeeded"), "墙钟秒": p.get("wall_seconds"),
                    "起始全局间隔秒": p.get("start_global_gap_sec"),
                    "成功_pct": pct(p.get("succeeded") or 0, p.get("attempted") or 1),
                    "说明": p.get("note")}
                   for p in fdoc["manifest"].get("passes", [])],
    }
    if html_t and st_t:
        m3["体积倍数_HTML/结构化"] = round(
            (sorted(html_b)[len(html_b)//2]) / max(1, sorted(st_b)[len(st_b)//2]), 1)
        m3["耗时倍数_HTML/结构化"] = round(
            statistics.median(html_t) / max(1, statistics.median(st_t)), 1)

    # ── 规格外但必须一起看的：广告引用集中度
    top = sorted(rows, key=lambda r: -r["ad_refs"])[:10]
    extra = {
        "广告引用总数": fdoc["manifest"]["total_ad_refs"],
        "唯一 URL 数": N,
        "平均每页被引用": round(fdoc["manifest"]["total_ad_refs"] / N, 2) if N else None,
        "被引用最多的页面": [{"url_key": r["url_key"], "ad_refs": r["ad_refs"],
                              "tier": r["tier"]} for r in top],
    }

    doc = {"snapshot": edoc["snapshot"], "指标1_内容获取成功率": m1,
           "指标2_页面素材识别完整度": m2, "指标3_处理耗时": m3,
           "引用集中度": extra, "逐URL": rows}
    OUT.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")

    # ── 打印
    print(f"快照 {edoc['snapshot']}   URL 总数 {N}（来自 {extra['广告引用总数']} 条广告引用）")
    print(f"\n【指标 1】内容获取成功率  {m1['成功']}/{N} = {m1['成功率_pct']}%")
    for t, c in sorted(tiers.items(), key=lambda x: -x[1]):
        mark = "✅" if t in SUCCESS else "❌"
        print(f"   {mark} {t:<18s} {c:3d}  {FAIL_LABEL.get(t,'')}")
    print("\n   分域名:")
    for k, a in m1["分域名"].items():
        print(f"     {k:<22s} {a['成功']:3d}/{a['分母']:<3d} {a['成功率_pct']:5.1f}%")
    print("   分类型:")
    for k, a in m1["分类型"].items():
        print(f"     {k:<22s} {a['成功']:3d}/{a['分母']:<3d} {a['成功率_pct']:5.1f}%")

    print(f"\n【指标 2】识别完整度（分母 {m2['分母_成功页面']} 个成功页面）")
    for k, a in m2["逐要素"].items():
        print(f"   {k:<16s} {a['达成']:3d}/{a['分母']:<3d} {a['覆盖率_pct']:5.1f}%")
    if m2["完整度"]:
        c = m2["完整度"]
        print(f"   完整度均值 {c['均值']}  中位 {c['中位']}  六要素齐全 {c['六要素齐全']}/{c['分母']}")

    print(f"\n【指标 3】处理耗时")
    for k in ("HTML 路径", "结构化端点路径"):
        p = m3[k]
        if p:
            print(f"   {k:<14s} n={p['n']:<3d} P50 {p['p50']:>6d}ms  P90 {p['p90']:>6d}ms  "
                  f"P95 {p['p95']:>6d}ms  max {p['max']:>7d}ms")
    if "体积倍数_HTML/结构化" in m3:
        print(f"   HTML 体积是结构化端点的 {m3['体积倍数_HTML/结构化']}×，"
              f"耗时是 {m3['耗时倍数_HTML/结构化']}×")
    print(f"\n【关键对照】同一个站点、同一批 URL、同一份 UA，只有节流策略不同：")
    for p in m3["分轮次"]:
        print(f"   {p['轮次']:<14s} {p['成功']}/{p['尝试']} = {p['成功_pct']}%   "
              f"全局间隔 {p['起始全局间隔秒']}s   墙钟 {p['墙钟秒']}s")
    print(f"\n→ {OUT.relative_to(ROOT)}")

    if args.md:
        print("\n\n<!-- Markdown 片段 -->")
        print(f"| 指标 | 读数 | 分母 |")
        print(f"|---|---:|---:|")
        print(f"| 内容获取成功率 | **{m1['成功率_pct']}%** | {N} |")
        if m2["完整度"]:
            print(f"| 识别完整度（均值） | **{m2['完整度']['均值']}** | {m2['分母_成功页面']} |")
        if m3["HTML 路径"]:
            print(f"| 处理耗时 P50（HTML） | **{m3['HTML 路径']['p50']} ms** | {m3['HTML 路径']['n']} |")
        if m3["结构化端点路径"]:
            print(f"| 处理耗时 P50（结构化） | **{m3['结构化端点路径']['p50']} ms** | {m3['结构化端点路径']['n']} |")
    return 0


if __name__ == "__main__":
    sys.exit(main())

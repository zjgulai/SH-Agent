#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
lp_consistency.py —— 跨载体 / 跨版本一致性（批次 C · 只读）

## 这个脚本回答什么
法务文档里两处原文：

> 上线后持续监测：公司实际对外发布了什么、有没有法务未看到的风险、
> 　发布后是否发生未经审核的变化
> 整改与闭环：一个地方发现的风险，其他版本、页面和渠道是否同步整改

本脚本把这两句话变成两张可复算的表：

**表 A · 广告文案 vs 落地页** —— 广告里说了、落地页上没有的声明。
　　广告与落地页是两个独立载体，投放时受同一套合规标准约束。
　　「广告说 A、落地页说 B」是最难被发现的一类不一致，因为它需要同时看两个系统。

**表 B · 跨 locale 版本一致性** —— 同一产品在不同地区站的参数与认证声明。
　　这批 URL 里有 10 个产品横跨 2–10 个地区站，是现成的跨版本测试集。
　　**数字类声明（mmHg / dB / 认证）跨语言应当一致**：翻译会变，参数不会。

## 边界（不越界）
本脚本**只做差集，不做判定**（ADR-0005）。
「广告有、页面无」是**事实**；它是否构成违规、是否要整改，由法务判断。
报告里出现的每个差异都带原始片段，便于人工核对。
"""
import argparse
import json
import pathlib
import re
import sys
from collections import defaultdict

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from lp_extract import CLAIM_RE, CLAIM_PATTERNS  # noqa: E402  唯一词形定义，不重复维护

ROOT = pathlib.Path(__file__).resolve().parent.parent
LAND = ROOT / "research/landing"
LIVE = ROOT / "research/live/snapshot-20260916T050845Z.json"
OUT = LAND / "一致性分析.json"

# 参数类声明：必须跨语言逐字一致（数字不翻译）
PARAM_RE = {
    "mmHg": re.compile(r"(\d{2,4})\s?mmHg", re.I),
    "dB": re.compile(r"(\d{2,3})\s?dB", re.I),
    "认证词": re.compile(r"\b(FDA|CE|FCC|CPSIA|ASTM|GREENGUARD)\b"),
}


def field(f, k):
    x = f.get(k)
    if isinstance(x, list):
        return "".join((y.get("text") or y.get("link") or "")
                       for y in x if isinstance(y, dict)) or ""
    if isinstance(x, dict):
        return x.get("link") or x.get("text") or ""
    return x or ""


def claims_of(text):
    return {k: sorted({m.group(0).strip() for m in rx.finditer(text)}) for k, rx in CLAIM_RE.items()
            if rx.search(text)}


def params_of(text):
    out = {}
    for k, rx in PARAM_RE.items():
        got = sorted({m.group(1) if m.groups() else m.group(0) for m in rx.finditer(text)})
        if got:
            out[k] = got
    return out


def norm(s: str) -> str:
    """规范化后再比：去掉空白/连字符/下划线、统一小写。

    ★ 为什么必须有这一步：第一版用 `t.lower() in page` 严格子串匹配，
    实测 65 项「缺失声明」里有 **13 项（20%）是假阳性** ——
    广告写 `45dB`、页面写 `45 dB`；广告写 `300 mmHg`、页面写 `300mmHg`。
    不做规范化，就会把「写法差异」当成「内容缺失」报给法务。
    """
    return re.sub(r"[\s\-–—_]+", "", s.lower())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--md", action="store_true")
    args = ap.parse_args()

    ext = {r["url_key"]: r for r in json.loads(
        (LAND / "要素提取.json").read_text(encoding="utf-8"))["results"]}
    live = json.loads(LIVE.read_text(encoding="utf-8"))
    ads = live["sources"]["ad_copy"]["records"]

    # ── 表 A：广告 vs 落地页
    pairs = []
    for a in ads:
        f = a["fields"]
        url = field(f, "落地页URL").strip()
        if not url:
            continue
        # url_key 的口径必须与 lp_fetch.py 一致：netloc + path（去尾斜杠、去 query）
        key = url.split("://", 1)[-1].split("?")[0].rstrip("/")
        e = ext.get(key)
        ad_text = " | ".join(x for x in [field(f, "Primary Text"), field(f, "Headline")] if x)
        if not ad_text or not e or not e.get("html"):
            continue
        page_text = e["html"]["body_text"]
        page_strict = page_text.lower()
        page_norm = norm(page_text)
        ad_claims = claims_of(ad_text)
        ad_params = params_of(ad_text)

        def probe(t):
            return {"落地页是否出现_严格": t.lower() in page_strict,
                    "落地页是否出现": norm(t) in page_norm}

        rows = []
        for ct, terms in ad_claims.items():
            for t in terms:
                rows.append({"类型": ct, "广告中的表述": t, **probe(t)})
        for pk, terms in ad_params.items():
            for t in terms:
                rows.append({"类型": "参数_" + pk, "广告中的表述": t, **probe(t)})
        if not rows:
            continue
        pairs.append({
            "广告record_id": a["record_id"], "广告名称": field(f, "广告名称")[:70],
            "风险等级": field(f, "风险等级"), "命中规则": field(f, "命中规则")[:60],
            "落地页": key, "落地页tier": e["tier_raw"],
            "广告文案": ad_text[:300],
            "声明总数": len(rows),
            "页面上没有的": [r for r in rows if not r["落地页是否出现"]],
            "严格口径下没有的": [r for r in rows if not r["落地页是否出现_严格"]],
        })

    only_ad = [p for p in pairs if p["页面上没有的"]]
    only_ad_strict = [p for p in pairs if p["严格口径下没有的"]]
    miss_counter = defaultdict(int)
    for p in only_ad:
        for r in p["页面上没有的"]:
            miss_counter[f"{r['类型']} :: {r['广告中的表述']}"] += 1

    # 广告已有规则命中、且落地页缺该类声明的
    risky = [p for p in only_ad if p["命中规则"]]

    # ── 表 B：跨 locale（同 handle 不同域名）
    groups = defaultdict(list)
    for k, e in ext.items():
        if e["kind"] == "product" and e.get("html") and "/" not in e.get("handle", "/"):
            groups[e["handle"]].append(e)
    multi = {h: v for h, v in groups.items() if len({x["domain"] for x in v}) > 1}
    cross = []
    for h, items in sorted(multi.items(), key=lambda x: -len(x[1])):
        per = {}
        for e in items:
            txt = e["html"]["body_text"] + " " + json.dumps(e["html"]["claims"], ensure_ascii=False)
            per[e["domain"]] = {"参数": params_of(txt),
                                "认证": sorted({m.group(0) for m in PARAM_RE["认证词"].finditer(txt)}),
                                "title": e["html"]["title"][:120],
                                "正文长度": e["html"]["body_chars"],
                                "tier": e["tier_raw"]}
        # 参数差异：同一参数名在不同地区站取值集合不同
        diffs = []
        for pk in ("mmHg", "dB"):
            sets = {d: set(v["参数"].get(pk, [])) for d, v in per.items()}
            nonempty = {d: s for d, s in sets.items() if s}
            if len(nonempty) > 1 and len({frozenset(s) for s in nonempty.values()}) > 1:
                diffs.append({"参数": pk,
                              "各地区取值": {d: sorted(s) for d, s in nonempty.items()}})
        certs = {d: set(v["认证"]) for d, v in per.items()}
        nonempty_c = {d: s for d, s in certs.items() if s}
        if len(nonempty_c) > 1 and len({frozenset(s) for s in nonempty_c.values()}) > 1:
            diffs.append({"参数": "认证词",
                          "各地区取值": {d: sorted(s) for d, s in nonempty_c.items()}})
        cross.append({"handle": h, "locale数": len(per),
                      "地区站": sorted(per.keys()), "逐站": per,
                      "参数或认证不一致": diffs})

    inconsistent = [c for c in cross if c["参数或认证不一致"]]

    doc = {
        "来源": "research/live/snapshot-20260916T050845Z.json + research/landing/要素提取.json",
        "表A_广告vs落地页": {
            "可对照的广告数": len(pairs),
            "至少一项广告声明未在落地页出现的广告数": len(only_ad),
            "严格子串口径下的同一数字": len(only_ad_strict),
            "口径说明": "严格口径用 t.lower() in page，会把『45dB vs 45 dB』这类写法差异"
                        "误报为内容缺失（实测假阳性率 20%）。正式口径先做规范化再比。",
            "其中广告本身已命中规则的": len(risky),
            "未在落地页出现的声明计数": dict(sorted(miss_counter.items(), key=lambda x: -x[1])[:40]),
            "逐条": only_ad,
        },
        "表B_跨locale一致性": {
            "跨 locale 产品数": len(cross),
            "参数或认证不一致的产品数": len(inconsistent),
            "逐产品": cross,
        },
    }
    OUT.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")

    A, B = doc["表A_广告vs落地页"], doc["表B_跨locale一致性"]
    print("【表 A】广告文案 vs 落地页")
    print(f"   可对照广告 {A['可对照的广告数']} 条"
          f"（广告文案与落地页正文都取到的才计入）")
    print(f"   至少一项广告声明未在落地页出现：{A['至少一项广告声明未在落地页出现的广告数']} 条"
          f"（严格子串口径会报 {A['严格子串口径下的同一数字']} 条 —— 差的就是写法差异造成的假阳性）")
    print(f"   其中广告本身已命中规则：{A['其中广告本身已命中规则的']} 条")
    if A["未在落地页出现的声明计数"]:
        print("   出现最多的缺失声明：")
        for k, v in list(A["未在落地页出现的声明计数"].items())[:10]:
            print(f"     {v:3d}×  {k}")
    print(f"\n【表 B】跨 locale 版本一致性")
    print(f"   跨 locale 产品 {B['跨 locale 产品数']} 个；"
          f"参数或认证不一致 {B['参数或认证不一致的产品数']} 个")
    for c in B["逐产品"]:
        flag = "⚠️ " if c["参数或认证不一致"] else "   "
        print(f"   {flag}{c['locale数']} locale  {c['handle'][:58]}")
        for d in c["参数或认证不一致"]:
            print(f"        {d['参数']}: " +
                  " | ".join(f"{k}={','.join(v)}" for k, v in d["各地区取值"].items()))
    print(f"\n→ {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

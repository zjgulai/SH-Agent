#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
lp_extract.py —— 落地页要素提取（批次 C · 只读）

## 这个脚本回答什么
法务验证表第二层的第二问：**页面/素材识别完整度**。
它对 `lp_fetch.py` 落下的原始响应做解析，提取六类要素：

    title · body_text · images · claims · links · locale_signals

## 为什么不是直接上 bs4
本机没有第三方 HTML 库，而本项目已确立「不加依赖也能跑」的惯例
（`lark_probe.py` 用 urllib 直连、`offline_replay.py` 用标准库解析）。
`html.parser` 是标准库，对 Shopify 的静态 HTML 足够。
**代价写在明处**：JS 渲染出来的内容抓不到，这在报告里会体现为 `body_chars` 偏小，
而不是被悄悄忽略。

## 一个关键区分
本脚本**只提取，不判定**（ADR-0005）。
`claims` 是「页面上出现了哪些声明性表述」的**清单**，
不是「这些声明是否合规」的结论。是否违规属于批次 B，不在这里做。

## 用法
  python3 tools/lp_extract.py            # 从最新快照的全部原始响应提取
  python3 tools/lp_extract.py --show 3   # 附带打印前 3 个页面的要素摘要
"""
import argparse
import gzip
import html as htmlmod
import json
import pathlib
import re
import sys
from html.parser import HTMLParser

ROOT = pathlib.Path(__file__).resolve().parent.parent
LAND = ROOT / "research/landing"
FETCH = LAND / "抓取结果.json"
OUT = LAND / "要素提取.json"

SKIP_TAGS = {"script", "style", "noscript", "svg", "template", "iframe"}
BLOCK_TAGS = {"p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6",
              "section", "article", "td", "th", "blockquote", "figcaption"}

# 声明性表述的**词形清单**（不是判定规则）。
# 只回答「页面上有没有这类表述」，不下「是否违规」的结论 —— 见文件头。
CLAIM_PATTERNS = {
    "certification": r"\b(FDA|CE|FCC|CPSIA|ASTM|GREENGUARD|BPA[- ]?free|HSA|FSA|IBCLC)\b",
    "medical": r"\b(hospital[- ]grade|medical[- ]grade|medical device|clinically|therapeutic|prescription)\b",
    # ★ 2026-09-17（B1）修正：原式为
    #     r"\b(100%|never|always|guaranteed|best|#1|number one|no\.?\s?1|ultimate|perfect)\b"
    #   末尾那个 \b 让 `100%` 与 `#1` **永远匹配不上** —— `%` 与 `#` 都是非单词字符，
    #   它们后面紧跟空格时不存在单词边界。实测：`'100% safe'` → 不命中；`'#1 brand'` → 不命中。
    #   真语料上：21,424 条非空 alt 里漏 7 条；**92 个页面正文里 3 个**含 `100%`/`#1`
    #   而抽不出来。`tools/lp_consistency.py` 用的是同一个正则，所以批次 C 的
    #   「广告文案 vs 落地页」一致性分析受同一缺陷影响 —— 见 base/README.md B1 节。
    #   修法：把「以符号结尾」的备选从 \b 里拿出来单独写。
    "absolute": r"(?:\b(?:never|always|guaranteed|best|number one|no\.?\s?1|ultimate|perfect)\b"
                r"|(?<![\w%])100\s?%|(?<![\w#])#\s?1\b)",
    "performance": r"\b(\d{2,4}\s?mmHg|\d{2,3}\s?dB|\d+\s?(?:hours?|hrs?|minutes?|mins?)\b|\d+\s?(?:oz|ml)\b)",
    "comparative": r"\b(vs\.?|versus|better than|compared to|unlike|#1 brand|world'?s first|award[- ]winning)\b",
    "health": r"\b(increase milk supply|boost milk|treat|prevent|relieve|cure|pain[- ]?free|painless)\b",
}
CLAIM_RE = {k: re.compile(v, re.I) for k, v in CLAIM_PATTERNS.items()}

LOCALE_RE = {
    "hreflang": re.compile(r'<link[^>]+hreflang=["\']([^"\']+)["\'][^>]*>', re.I),
    "og_locale": re.compile(r'<meta[^>]+property=["\']og:locale["\'][^>]+content=["\']([^"\']+)["\']', re.I),
    "lang_attr": re.compile(r'<html[^>]+lang=["\']([^"\']+)["\']', re.I),
    "currency": re.compile(r'"currency"\s*:\s*"([A-Z]{3})"'),
    "shopify_locale": re.compile(r'Shopify\.locale\s*=\s*["\']([^"\']+)["\']'),
}
JSONLD_RE = re.compile(
    r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>', re.I | re.S)


class Extract(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.title, self._in_title = "", False
        self.text_parts, self._skip = [], 0
        self.metas, self.links, self.imgs = {}, [], []
        self.jsonld_raw = []
        self._in_jsonld = False

    def handle_starttag(self, tag, attrs):
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag in SKIP_TAGS:
            self._skip += 1
        if tag == "title":
            self._in_title = True
        elif tag == "meta":
            k = (a.get("property") or a.get("name") or "").lower()
            if k and a.get("content"):
                self.metas.setdefault(k, a["content"])
        elif tag == "a" and a.get("href"):
            self.links.append({"href": a["href"],
                               "text": "", "rel": a.get("rel", "")})
            self._last_a = self.links[-1]
        elif tag == "img":
            self.imgs.append({"src": a.get("src") or a.get("data-src") or "",
                              "alt": a.get("alt", ""),
                              "width": a.get("width", ""), "height": a.get("height", "")})
        elif tag == "script" and "ld+json" in (a.get("type") or "").lower():
            self._in_jsonld = True
            self.jsonld_raw.append("")
        if tag in BLOCK_TAGS:
            self.text_parts.append("\n")

    def handle_endtag(self, tag):
        if tag in SKIP_TAGS and self._skip:
            self._skip -= 1
        if tag == "title":
            self._in_title = False
        if tag == "script":
            self._in_jsonld = False
        if tag in BLOCK_TAGS:
            self.text_parts.append("\n")

    def handle_data(self, data):
        if self._in_jsonld and self.jsonld_raw:
            self.jsonld_raw[-1] += data
        if self._in_title:
            self.title += data
        if not self._skip:
            s = data.strip()
            if s:
                self.text_parts.append(s)
                if getattr(self, "_last_a", None) is not None and not self._last_a["text"]:
                    self._last_a["text"] = s[:120]


def clean_text(parts):
    t = " ".join(parts)
    t = re.sub(r"[ \t\u00a0]+", " ", t)
    t = re.sub(r"\n\s*\n+", "\n", t)
    return t.strip()


def read_raw(evdir, rel):
    fp = evdir / rel
    if not fp.exists():
        return b""
    with gzip.open(fp, "rb") as f:
        return f.read()


def analyze_html(body: bytes):
    txt = body.decode("utf-8", "replace")
    p = Extract()
    try:
        p.feed(txt)
    except Exception as e:                      # 解析器对畸形 HTML 宽容，但别静默
        p.parse_error = f"{type(e).__name__}: {str(e)[:80]}"
    body_text = clean_text(p.text_parts)
    claims = {}
    for k, rx in CLAIM_RE.items():
        hits = sorted({m.group(0).strip() for m in rx.finditer(body_text)})
        if hits:
            claims[k] = hits[:25]
    locale = {}
    for k, rx in LOCALE_RE.items():
        got = sorted(set(rx.findall(txt)))[:12]
        if got:
            locale[k] = got
    jsonld = []
    for raw in p.jsonld_raw[:6]:
        try:
            j = json.loads(raw.strip())
            if isinstance(j, dict):
                jsonld.append({"@type": j.get("@type"), "name": (j.get("name") or "")[:120]})
            elif isinstance(j, list):
                jsonld.extend({"@type": x.get("@type"), "name": (x.get("name") or "")[:120]}
                              for x in j if isinstance(x, dict))
        except Exception:
            pass
    return {
        "title": htmlmod.unescape(p.title.strip())[:300],
        "meta_description": (p.metas.get("description") or p.metas.get("og:description") or "")[:400],
        "og_title": (p.metas.get("og:title") or "")[:300],
        "body_text": body_text,
        "body_chars": len(body_text),
        "images": p.imgs,
        "image_count": len(p.imgs),
        "image_alt_nonempty": sum(1 for i in p.imgs if (i["alt"] or "").strip()),
        "links": p.links,
        "link_count": len(p.links),
        "claims": claims, "claim_types": sorted(claims.keys()),
        "locale_signals": locale, "jsonld": jsonld,
    }


def analyze_structured(body: bytes):
    try:
        j = json.loads(body.decode("utf-8", "replace"))
    except Exception:
        return None
    if not isinstance(j, dict):
        return None
    desc = re.sub(r"<[^>]+>", " ", j.get("description") or "")
    desc = htmlmod.unescape(re.sub(r"\s+", " ", desc)).strip()
    return {
        "title": (j.get("title") or "")[:300],
        "vendor": j.get("vendor"), "type": j.get("type"), "handle": j.get("handle"),
        "description_text": desc, "description_chars": len(desc),
        "variants": [{"title": v.get("title"), "price": v.get("price"),
                      "available": v.get("available")} for v in (j.get("variants") or [])][:40],
        "variant_count": len(j.get("variants") or []),
        "image_count": len(j.get("images") or []),
        "tags": (j.get("tags") or [])[:30],
        "published_at": j.get("published_at"),
    }


def six_elements(e):
    """六类要素的达成判定 —— 完整度的分子就是这里为 True 的个数。"""
    return {
        "title": bool(e["html"]["title"]),
        "body_text": e["html"]["body_chars"] >= 200,
        "images": e["html"]["image_count"] > 0,
        "claims": bool(e["html"]["claim_types"]) or bool(e.get("structured")),
        "links": e["html"]["link_count"] > 0,
        "locale_signals": bool(e["html"]["locale_signals"]),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--show", type=int, default=0)
    ap.add_argument("--snapshot", default=None, help="指定快照目录名，默认取 MANIFEST 里的")
    args = ap.parse_args()

    if not FETCH.exists():
        print(f"✗ 找不到 {FETCH}，先跑 tools/lp_fetch.py", file=sys.stderr)
        return 2
    doc = json.loads(FETCH.read_text(encoding="utf-8"))
    snaps = sorted((LAND / "_evidence").glob("snapshot-*"))
    if not snaps:
        print("✗ 没有快照目录", file=sys.stderr)
        return 2
    evdir = (LAND / "_evidence" / args.snapshot) if args.snapshot else snaps[-1]
    print(f"快照: {evdir.name}")

    out, missing = [], 0
    for r in doc["results"]:
        rec = {"url_key": r["url_key"], "url": r["url"], "domain": r["domain"],
               "kind": r["kind"], "handle": r.get("handle", ""), "tier_raw": r["tier_raw"],
               "ad_refs": r.get("ad_refs", 0), "html": None, "structured": None,
               "six": None, "parse_error": None}
        for a in r["attempts"]:
            if not a.get("stored"):
                continue
            body = read_raw(evdir, a["stored"])
            if not body:
                missing += 1
                continue
            if a["label"] == "html":
                rec["html"] = analyze_html(body)
                rec["html_sha256"] = a.get("sha256")
                rec["html_bytes"] = a.get("bytes")
            else:
                rec["structured"] = analyze_structured(body)
        if rec["html"]:
            rec["six"] = six_elements(rec)
        out.append(rec)

    payload = {
        "snapshot": evdir.name,
        "total": len(out),
        "extracted": sum(1 for r in out if r["html"]),
        "raw_missing": missing,
        "results": out,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")

    ok = [r for r in out if r["six"]]
    full = [r for r in ok if all(r["six"].values())]
    print(f"提取成功 {payload['extracted']}/{payload['total']}"
          f"（原始文件缺失 {missing}）")
    print(f"六要素齐全 {len(full)}/{len(ok)}")
    if ok:
        import statistics
        print("\n逐要素覆盖率（分母=%d 个提取成功的页面）:" % len(ok))
        for k in ["title", "body_text", "images", "claims", "links", "locale_signals"]:
            n = sum(1 for r in ok if r["six"][k])
            print(f"  {k:<16s} {n:3d}/{len(ok)}  {100*n/len(ok):5.1f}%")
        print("\n完整度（六要素达成数 / 6）:")
        vals = [sum(r["six"].values()) / 6 for r in ok]
        print(f"  均值 {statistics.mean(vals):.3f}  中位 {statistics.median(vals):.3f}"
              f"  最低 {min(vals):.3f}")
        print("\n正文长度:")
        bc = sorted(r["html"]["body_chars"] for r in ok)
        print(f"  中位 {bc[len(bc)//2]:,} 字符  P10 {bc[len(bc)//10]:,}  max {bc[-1]:,}")
    print(f"\n→ {OUT.relative_to(ROOT)}")

    if args.show:
        for r in out[:args.show]:
            print(f"\n── {r['url_key'][:80]}")
            if not r["html"]:
                print("   （无 HTML）"); continue
            h = r["html"]
            print(f"   title      : {h['title'][:90]}")
            print(f"   body_chars : {h['body_chars']:,}")
            print(f"   images     : {h['image_count']}（有 alt {h['image_alt_nonempty']}）")
            print(f"   links      : {h['link_count']}")
            print(f"   claims     : {json.dumps(h['claims'], ensure_ascii=False)[:220]}")
            print(f"   locale     : {json.dumps(h['locale_signals'], ensure_ascii=False)[:160]}")
            print(f"   six        : {r['six']}")
            if r["structured"]:
                s = r["structured"]
                print(f"   structured : 变体 {s['variant_count']} · 图 {s['image_count']} · "
                      f"描述 {s['description_chars']} 字 · vendor={s['vendor']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""
kb_index.py —— 本地资产索引（P1.1）

把仓库里已产出的文档、脚本、调研、决策全部索引起来，供「需求 → 证据」映射使用。

**关键词表从台账里长出来，不从脑子里长出来**：品线与类别取自 `台账-v1.json`
的实际取值集合，再补一小组领域术语。这样索引的覆盖范围可以被复算，
而不是靠作者记得要搜哪些词。

产出：
  research/kb/索引-本地资产.json

用法：
  python3 tools/kb_index.py
  python3 tools/kb_index.py --top 20
"""

import argparse
import collections
import hashlib
import json
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                "research", "kb"))
import load  # noqa: E402

OUT = os.path.join(load.KB, "索引-本地资产.json")

# 索引范围：仓库根下的相对目录 → 资产类别
ROOTS = {
    "ADR": "决策",
    "PRD": "需求文档",
    "PMO": "运营复盘",
    "research/governance": "调研与审计",
    "research/method": "方法论",
    "research/distill": "蒸馏资产",
    "research/replay": "离线复现",
    "research/kb": "需求知识库",
    "research/repos": "外部参考仓库",
    "tools": "工具",
    "skills-inventory": "技能盘点",
}
SKIP_DIRS = {"_evidence", "_scratch", "node_modules", ".git", "__pycache__", "assets"}
SKIP_NAMES = {"LATEST.json", "MANIFEST.json"}
DOC_EXT = {".md", ".py", ".json", ".yml", ".yaml", ".csv", ".txt"}

# 补充领域术语（台账里抽样不出来的概念词）
DOMAIN_TERMS = [
    # 规则机制
    "规则库", "白名单", "语境守卫", "豁免词", "检测关键词", "错题本", "红线", "边界类型",
    "两段式", "宽召回", "降噪", "误报", "假阴性", "严重等级",
    # 平台与法规
    "Google", "Meta", "Amazon", "TikTok", "FDA", "FTC", "广告法", "断货", "医疗宣称",
    # 内容形态
    "视频", "平面", "图片", "文案", "UGC", "红人", "达人", "KOL", "二创", "素材",
    # 工程
    "飞书", "多维表格", "Base", "快照", "溯源", "指纹", "双账本",
]


def head_title(text, path):
    for line in text.splitlines()[:40]:
        m = re.match(r"^#\s+(.+)$", line.strip())
        if m:
            return m.group(1).strip()[:120]
    return os.path.basename(path)


def headings(text, limit=12):
    out = []
    for line in text.splitlines():
        m = re.match(r"^(#{1,3})\s+(.+)$", line.strip())
        if m:
            out.append(m.group(2).strip()[:80])
        if len(out) >= limit:
            break
    return out


# 占位值 —— 它们在台账里是有意义的事实（"未分类"本身要能被看见），
# 但作为检索关键词只会污染索引，所以只在关键词表里剔除。
PLACEHOLDER_VALUES = {
    "翼果未分类，后续文章已进行分类", "无法归结到品线", "无匹配类别", "多品线",
    "翼果未分类", "无法归结到站点", "不适用", "其他", "未知",
}


def ledger_terms():
    """从台账实际取值里长出关键词表。

    切分规则的两个坑（都是实测踩出来的）：
      · **不能按 `/` 切** —— `孕期睡眠/不适` 是一个完整品类名，切开会造出「不适」这种假关键词；
      · **不能收句子** —— PSEO 的 `品类` 字段里 283 条写的是
        `翼果未分类，后续文章已进行分类`，那是把一句话写进了分类字段（见结构分析 §四·4）。
    """
    doc = json.load(open(os.path.join(load.KB, "台账-v1.json"), encoding="utf-8"))
    recs = [r for r in doc["records"] if r["role"] != "excluded"]
    terms = {}
    for field in ("product_line", "category"):
        vals = collections.Counter()
        for r in recs:
            v = r.get(field)
            if not v:
                continue
            if str(v).strip() in PLACEHOLDER_VALUES:
                continue                                     # 整值就是占位，切开也没意义
            for part in re.split(r"[;；,，、]", str(v)):     # 注意：不含 "/"
                part = part.strip()
                if not (2 <= len(part) <= 12):
                    continue
                if part in PLACEHOLDER_VALUES:
                    continue
                if re.search(r"[，。！？；：]", part):        # 含句读 → 是句子不是词
                    continue
                vals[part] += 1
        terms[field] = [k for k, n in vals.most_common(40) if n >= 2]
    return terms


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--top", type=int, default=15)
    a = ap.parse_args()

    led = ledger_terms()
    vocab = sorted(set(led["product_line"]) | set(led["category"]) | set(DOMAIN_TERMS))
    vocab = [v for v in vocab if v]
    print(f"关键词表：{len(vocab)} 个（品线 {len(led['product_line'])} · "
          f"类别 {len(led['category'])} · 领域 {len(DOMAIN_TERMS)}）")

    assets = []
    by_kind = collections.Counter()
    for root, kind in ROOTS.items():
        base = os.path.join(load.REPO, root)
        if not os.path.isdir(base):
            continue
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
            for fn in filenames:
                if fn in SKIP_NAMES or os.path.splitext(fn)[1].lower() not in DOC_EXT:
                    continue
                p = os.path.join(dirpath, fn)
                rel = os.path.relpath(p, load.REPO)
                try:
                    raw = open(p, "rb").read()
                    text = raw.decode("utf-8", errors="replace")
                except OSError:
                    continue
                hits = [v for v in vocab if v in text]
                assets.append({
                    "path": rel,
                    "kind": kind,
                    "ext": os.path.splitext(fn)[1].lower(),
                    "title": head_title(text, rel),
                    "headings": headings(text),
                    "bytes": len(raw),
                    "lines": text.count("\n") + 1,
                    "sha256_12": hashlib.sha256(raw).hexdigest()[:12],
                    "keywords": hits,
                    "n_keywords": len(hits),
                })
                by_kind[kind] += 1

    assets.sort(key=lambda x: (-x["n_keywords"], -x["bytes"]))

    kw_index = collections.defaultdict(list)
    for x in assets:
        for k in x["keywords"]:
            kw_index[k].append(x["path"])

    doc = {
        "generated_by": "tools/kb_index.py",
        "repo": load.REPO,
        "roots": ROOTS,
        "vocab_size": len(vocab),
        "vocab_from_ledger": led,
        "asset_count": len(assets),
        "by_kind": dict(by_kind),
        "keyword_index": {k: v for k, v in sorted(kw_index.items())},
        "assets": assets,
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=1)

    print(f"\n═══ 索引结果 ═══")
    print(f"  资产 {len(assets)} 个")
    for k, v in by_kind.most_common():
        print(f"    {k:<14} {v:>5}")

    print(f"\n═══ 按关键词覆盖（前 {a.top}）═══")
    for k, v in sorted(kw_index.items(), key=lambda kv: -len(kv[1]))[:a.top]:
        print(f"  {k:<12} {len(v):>4} 个资产")

    zero = [k for k in vocab if not kw_index.get(k)]
    print(f"\n═══ 零覆盖关键词（{len(zero)} 个）═══")
    print("  " + " · ".join(zero[:40]))

    print(f"\n═══ 关键词最密的 8 个资产 ═══")
    for x in assets[:8]:
        print(f"  {x['n_keywords']:>3}  {x['path'][:70]}")

    print(f"\n→ {os.path.relpath(OUT, load.REPO)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

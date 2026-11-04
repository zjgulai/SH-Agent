#!/usr/bin/env python3
"""
kb_analyze.py —— 需求知识库 · 结构分析（只读）

对最近一次快照做结构分析，产出 `research/kb/结构分析.json`，回答四个问题：

  1. **字段可比性** —— 各需求类表的字段填充率与取值分布，供人工定归一映射
  2. **状态词表**   —— 各表的进度/状态字段到底有哪些取值，哪些是同一个状态的不同叫法
  3. **空壳表**     —— 有表名、有条数、但字段全空的表（命名暗示有内容，实际没有）
  4. **重复候选**   —— 跨表/跨系统标题归一后重复的记录

**本脚本不做归一决策**，只把事实摊开。映射写在 `schema-v1.json`，由人review。

用法：
  python3 tools/kb_analyze.py           # 分析 + 打印报告
  python3 tools/kb_analyze.py --json    # 只输出 JSON 路径
"""

import collections
import json
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                "research", "kb"))
import load  # noqa: E402

OUT = os.path.join(load.KB, "结构分析.json")

# 字段角色：**精确名匹配**。
# 早期版本用 `hint in field` 子串匹配，结果 "进展" 命中了自由文本字段「最新进展记录」，
# 把 42 条进展记录当成状态取值混进了状态词表 —— 归一化最怕的就是这种"看起来对"的污染。
STATUS_FIELDS = {"进度", "状态", "进展", "审核状态", "任务状态"}
PRIORITY_FIELDS = {"优先级", "重要紧急程度", "需求优先级判断"}
TITLE_FIELDS = {"任务名", "需求内容", "任务描述", "文章链接", "关键字"}
# 层级字段：飞书的「单向/双向关联」字段，指回同一张表或父表
LINK_FIELDS = {"Parent items", "父记录", "父记录 2", "父项"}


def pick(fields, names):
    return [f for f in fields if f in names]


def link_of(v):
    """解析飞书关联字段 → (父记录 id, 父记录标题)；无父返回 (None, None)。

    飞书关联字段的形态：`[{"record_ids": [...], "table_id": "...", "text": "父标题", ...}]`
    顶层记录（没有父）拿到的是 `[{"table_id": "...", "text_arr": [], "type": "text"}]` ——
    **字段填充率 100%，但它是空的**。只看填充率会把 26 个顶层项目误判成"都有父"。
    """
    if not isinstance(v, list) or not v:
        return None, None
    for it in v:
        if not isinstance(it, dict):
            continue
        ids = it.get("record_ids") or it.get("link_record_ids") or []
        txt = it.get("text") or (it.get("text_arr") or [None])[0]
        if ids or txt:
            return (ids[0] if ids else None), (str(txt) if txt else None)
    return None, None


def profile_table(t):
    n = len(t.records)
    prof = []
    for f in t.fields:
        vals = t.values(f)
        nn = [v for v in vals if v not in (None, "")]
        uniq = sorted({str(v) for v in nn})
        prof.append({
            "field": f,
            "fill": round(len(nn) / n, 4) if n else 0.0,
            "nonempty": len(nn),
            "distinct": len(uniq),
            "top": collections.Counter(str(v) for v in nn).most_common(8) if len(uniq) <= 30 else None,
            "samples": [str(v)[:60] for v in nn[:3]],
        })
    return {"system": t.system, "table": t.name, "kind": t.kind, "records": n,
            "fields": prof}


def norm_title(s):
    if not s:
        return None
    s = str(s).lower()
    s = re.sub(r"[\s\u200b-\u200f\u2060\ufeff]+", "", s)
    s = re.sub(r"[（）()【】\[\]「」《》<>《》\-_/\\|,，.。:：;；!！?？'\"“”‘’*#~`]+", "", s)
    return s or None


def main():
    snap = load.snapshot()
    report = {
        "snapshot_id": snap.snapshot_id,
        "taken_at_utc": snap.taken_at,
        "generated_by": "tools/kb_analyze.py",
        "visibility_gaps": [
            {"table": t.name, "system": t.system, "why": why}
            for t, why in snap.visibility_gaps()
        ],
        "tables": [],
        "status_vocab": {},
        "empty_shells": [],
        "duplicate_candidates": [],
        "timezone_note": (
            "飞书日期字段是毫秒时间戳，代表 Asia/Shanghai 的零点。"
            "实测 1785340800000 → UTC 2026-07-29 16:00 / +08 2026-07-30 00:00。"
            "按 UTC 解读会让所有日期整体早一天。load.as_date() 已固定用 +08。"
        ),
    }

    # ── 1. 逐表剖面 ──────────────────────────────────────────
    for t in sorted(snap.all(), key=lambda x: (x.system, x.name)):
        if t.excluded:
            report["tables"].append({
                "system": t.system, "table": t.name, "kind": "excluded",
                "records": 0, "reason": t.reason,
                "fields_seen": t.fields,
            })
            continue
        report["tables"].append(profile_table(t))

    ledger = snap.ledger_tables()

    # ── 2. 空壳表：有条数但所有字段填充率 = 0 ────────────────
    for t in snap.all():
        if t.excluded or not t.records:
            continue
        fills = [t.fill(f) for f in t.fields]
        if fills and max(fills) == 0:
            report["empty_shells"].append({
                "system": t.system, "table": t.name, "records": len(t.records),
                "fields": t.fields,
                "note": f"{len(t.records)} 条记录、{len(t.fields)} 个字段，全部为空 —— 表名暗示有内容，实际零信息",
            })

    # ── 2b. 层级结构：哪些表不是平表，而是「项目 → 子任务」两层 ──────
    # 必须**遍历所有**疑似关联字段：平面看板的 `父记录` 34 条全是空关联，
    # 真正的层级在 `父记录 2` 里。只看第一个字段会漏掉整张表的层级
    # （生成台账时才发现的，见 ADR-0010 §三）。
    for t in ledger:
        lf = pick(t.fields, LINK_FIELDS)
        if not lf:
            continue
        tops, children = 0, 0
        for r in t.records:
            has = any(load.link_of(r["fields"].get(f))[0] for f in lf)
            children += 1 if has else 0
            tops += 0 if has else 1
        if not children:
            continue
        used = [f for f in lf
                if any(load.link_of(r["fields"].get(f))[0] for r in t.records)]
        report.setdefault("hierarchy", []).append({
            "system": t.system, "table": t.name, "link_field": " / ".join(used),
            "total": len(t.records),
            "top_level": tops, "children": children,
            "note": (f"「{' / '.join(used)}」是有效的关联字段 —— "
                     f"这是一张 {tops} 项目 + {children} 子任务的两层表，"
                     f"当成 {len(t.records)} 条平铺需求会高估需求数"),
        })

    # ── 3. 状态词表：每张需求类表的进度/状态取值全量 ──────────
    for t in ledger:
        for f in pick(t.fields, STATUS_FIELDS):
            vals = t.nonempty(f)
            if not vals:
                continue
            report["status_vocab"].setdefault(f, {})[f"{t.system}:{t.name}"] = {
                "field": f, "fill": round(t.fill(f), 4),
                "values": dict(collections.Counter(str(v) for v in vals).most_common()),
            }

    # ── 4. 重复候选 ──────────────────────────────────────────
    # 必须区分两种情况，否则报出来的全是噪声：
    #   (a) **同名子任务** —— 不同项目下的「内容诊断」「平面设计」，是 WBS 节点，不是重复需求
    #   (b) **真重复**     —— 同标题 + 同 SKU + 同提需日期，才算同一件事被提了两次
    child_ids = set()
    for h in report.get("hierarchy", []):
        ht = snap[(h["system"], h["table"])]
        for r in ht.records:
            pid, _ = link_of(r["fields"].get(h["link_field"]))
            if pid:
                child_ids.add((h["system"], h["table"], r["record_id"]))

    def composite_key(t, r):
        tf = pick(t.fields, TITLE_FIELDS)
        if not tf:
            return None
        title = norm_title(load.flat(r["fields"].get(tf[0])))
        if not title or len(title) < 4:
            return None
        sku = norm_title(load.flat(r["fields"].get("SKU")) or
                         load.flat(r["fields"].get("产品SKU")))
        date = ""
        for d in ("提需日期", "需求提交时间", "具体日期", "开始日期", "提交时间"):
            if d in t.fields:
                date = load.as_date(r["fields"].get(d)) or ""
                break
        return f"{title}|{sku or ''}|{date}"

    buckets = collections.defaultdict(list)
    for t in ledger:
        for r in t.records:
            if (t.system, t.name, r["record_id"]) in child_ids:
                continue                      # 排除子任务：它们是 WBS 节点
            k = composite_key(t, r)
            if k:
                buckets[k].append({
                    "system": t.system, "table": t.name,
                    "record_id": r["record_id"],
                    "raw": str(load.flat(r["fields"].get(pick(t.fields, TITLE_FIELDS)[0])))[:70],
                })
    dups = {k: v for k, v in buckets.items() if len(v) > 1}
    cross = {k: v for k, v in dups.items() if len({x["table"] for x in v}) > 1}
    report["duplicate_candidates"] = [
        {"key": k, "n": len(v), "tables": sorted({x["table"] for x in v}), "items": v}
        for k, v in sorted(dups.items(), key=lambda kv: -len(kv[1]))[:200]
    ]
    report["duplicate_summary"] = {
        "demand_records_scanned": sum(len(t.records) for t in ledger),
        "child_rows_excluded": len(child_ids),
        "duplicate_keys": len(dups),
        "cross_table_keys": len(cross),
        "records_involved": sum(len(v) for v in dups.values()),
    }

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=1)

    # ── 打印报告 ──────────────────────────────────────────────
    print(f"快照 {snap.snapshot_id}\n")
    print("═══ 空壳表（有名有行，零信息）═══")
    for e in report["empty_shells"]:
        print(f"  {e['system']:<9} {e['table']:<24} {e['records']:>3} 条 × {len(e['fields'])} 字段 —— 全空")

    print("\n═══ 层级结构（不是平表）═══")
    for h in report.get("hierarchy", []):
        print(f"  {h['system']}:{h['table']}  →  {h['top_level']} 项目 + {h['children']} 子任务"
              f"  （关联字段「{h['link_field']}」）")

    print("\n═══ 状态词表（需求类 + 审核类）═══")
    merged = collections.Counter()
    for fld, tables in report["status_vocab"].items():
        print(f"\n  ── 字段「{fld}」出现在 {len(tables)} 张表 ──")
        for tk, info in tables.items():
            vs = " | ".join(f"{k}×{v}" for k, v in info["values"].items())
            print(f"    {tk:<34} 填充{info['fill']:>5.0%}  {vs}")
            merged.update(info["values"])
    print(f"\n  状态取值合并：{dict(merged.most_common())}")

    print("\n═══ 优先级字段取值 ═══")
    for t in ledger:
        for f in pick(t.fields, PRIORITY_FIELDS):
            vals = t.nonempty(f)
            if vals:
                c = collections.Counter(str(v) for v in vals)
                print(f"  {t.system}:{t.name:<26} [{f}] 填充{t.fill(f):>5.0%}  "
                      f"{dict(c.most_common())}")

    ds = report["duplicate_summary"]
    print(f"\n═══ 重复候选（已排除子任务）═══")
    print(f"  扫描 {ds['demand_records_scanned']} 条需求/审核记录，"
          f"排除 {ds['child_rows_excluded']} 条 WBS 子任务")
    print(f"  同标题+同SKU+同日期 的键：{ds['duplicate_keys']} 个"
          f"（跨表 {ds['cross_table_keys']} 个），涉 {ds['records_involved']} 条")
    for d in report["duplicate_candidates"][:8]:
        print(f"    ×{d['n']}  {d['items'][0]['raw'][:50]}   ← {', '.join(d['tables'])}")

    print(f"\n→ {os.path.relpath(OUT, load.REPO)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

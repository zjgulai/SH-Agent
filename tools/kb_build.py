#!/usr/bin/env python3
"""
kb_build.py —— 需求知识库 · 台账生成器（本地分析账本）

把最近一次快照按 `research/kb/schema-v1.json` 的规则投影成台账。
**本脚本不做任何映射决策** —— 映射、状态归一、排除范围全部来自 schema。
改口径改 schema，不改这里。

产出：
  research/kb/台账-v1.json    归一化台账（含覆盖报告）
  research/kb/覆盖报告.json   每张源表「进了多少 / 为什么没进」

用法：
  python3 tools/kb_build.py
  python3 tools/kb_build.py --quiet     # 只写文件不打印报告
"""

import hashlib
import json
import os
import sys
import collections

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                "research", "kb"))
import load  # noqa: E402

SCHEMA = os.path.join(load.KB, "schema-v1.json")
LEDGER = os.path.join(load.KB, "台账-v1.json")
COVERAGE = os.path.join(load.KB, "覆盖报告.json")

# 状态归一索引：raw → 归一
def status_index(schema):
    idx = {}
    for norm, raws in schema["status_normalization"].items():
        for r in raws:
            idx[r.strip().casefold()] = norm
    return idx


def normalize_status(raw, idx):
    if raw in (None, ""):
        return None
    return idx.get(str(raw).strip().casefold())


def fingerprint(rec, fields):
    payload = {f: rec.get(f) for f in fields}
    blob = json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str).encode()
    return hashlib.sha256(blob).hexdigest()


def build_table(snap, spec, idx):
    t = snap[(spec["system"], spec["name"])]
    m = spec["map"]
    link_fields = spec.get("hierarchy") or []

    rows = []
    consumed = set(v for v in m.values() if v) | set(link_fields)
    extra_cols = set(spec.get("extra_columns") or [])
    if spec.get("extra_flag"):
        extra_cols.add(spec["extra_flag"]["field"])

    for r in t.records:
        f = r["fields"]

        # 层级：任一关联字段命中即为子任务
        parent_id = parent_title = None
        for lf in link_fields:
            pid, ptitle = load.link_of(f.get(lf))
            if pid:
                parent_id, parent_title = pid, ptitle
                break

        title = load.flat(f.get(m["title"])) if m.get("title") else None
        title_source = "verbatim"
        if not title:
            synth = spec.get("title_synthesis")
            if synth:
                title = synth.format(**{k: (load.flat(f.get(k)) or "?") for k in f})
                title_source = "synthesized"
            else:
                title = None
                title_source = "missing"

        def g(key):
            col = m.get(key)
            return load.flat(f.get(col)) if col else None

        status_raw = g("status_raw")
        rec = {
            "record_key": f"{spec['system']}:{spec['table_id']}:{r['record_id']}",
            "source_system": spec["system"],
            "source_table": spec["name"],
            "source_table_id": spec["table_id"],
            "source_record_id": r["record_id"],
            "role": spec["role"],
            "level": "child" if parent_id else "top",
            "parent_record_id": parent_id,
            "parent_title": parent_title,
            "title": title,
            "title_source": title_source,
            "category": g("category"),
            "product_line": g("product_line"),
            "sku": g("sku"),
            "status_raw": status_raw,
            "status": normalize_status(status_raw, idx),
            "priority_raw": g("priority_raw"),
            "priority_scale": m.get("priority_scale"),
            "priority": g("priority_raw"),
            "requester": g("requester"),
            "owner": g("owner"),
            "date_submitted": load.as_date(f.get(m["date_submitted"])) if m.get("date_submitted") else None,
            "date_due": load.as_date(f.get(m["date_due"])) if m.get("date_due") else None,
            "date_done": load.as_date(f.get(m["date_done"])) if m.get("date_done") else None,
            "due_source": None,
            "deliverable": g("deliverable"),
            "notes": g("notes"),
            "extras": {},
        }

        if spec.get("extra_flag"):
            ef = spec["extra_flag"]
            v = load.flat(f.get(ef["field"]))
            rec["due_source"] = "flagged" if v else None
            rec["extras"][ef["field"]] = v
            if "延期" in str(v or ""):
                rec["overdue_flagged"] = True

        for c in extra_cols:
            if c not in consumed:
                rec["extras"][c] = load.flat(f.get(c))
        # 其它未消费字段
        for k, v in f.items():
            if k not in consumed and k not in rec["extras"]:
                rec["extras"][k] = load.flat(v)

        rec["fingerprint"] = fingerprint(rec, [x for x in
                                               ["title", "product_line", "sku", "status_raw",
                                                "priority_raw", "owner", "requester",
                                                "date_submitted", "date_due", "date_done"]])
        rows.append(rec)
    return rows


def main():
    quiet = "--quiet" in sys.argv
    schema = json.load(open(SCHEMA, encoding="utf-8"))
    snap = load.snapshot()
    idx = status_index(schema)

    ledger, coverage = [], []
    for spec in schema["tables"]:
        rows = build_table(snap, spec, idx)
        ledger.extend(rows)
        coverage.append({
            "system": spec["system"], "table": spec["name"], "role": spec["role"],
            "source_records": len(snap[(spec["system"], spec["name"])].records),
            "in_ledger": len(rows),
            "top": sum(1 for r in rows if r["level"] == "top"),
            "child": sum(1 for r in rows if r["level"] == "child"),
            "included": True,
        })

    # 未进台账的表也必须出现在覆盖报告里（ADR-0010 §五）
    for t in snap.all():
        if any(c["table"] == t.name and c["system"] == t.system for c in coverage):
            continue
        coverage.append({
            "system": t.system, "table": t.name, "kind": t.kind,
            "source_records": t.fetched or 0, "in_ledger": 0, "included": False,
            "reason": ("含敏感字段，整体排除（ADR-0003）" if t.excluded
                       else "非需求/审核类，不进台账（仍列入覆盖报告）"),
        })

    # 被排除的敏感表：留一条占位，避免"凭空消失"
    for spec in schema.get("excluded_tables", []):
        ledger.append({
            "record_key": f"{spec['system']}:{spec['table_id']}:__EXCLUDED__",
            "source_system": spec["system"], "source_table": spec["name"],
            "source_table_id": spec["table_id"], "source_record_id": None,
            "role": "excluded", "level": "top", "title": f"⛔ {spec['name']}（未纳管）",
            "title_source": "synthesized", "status": None, "status_raw": None,
            "notes": spec["reason"], "extras": {"placeholder": spec.get("placeholder")},
            "fingerprint": hashlib.sha256(spec["name"].encode()).hexdigest()[:16],
        })

    stats = {
        "ledger_records": len(ledger),
        "real_records": sum(1 for r in ledger if r["role"] != "excluded"),
        "top": sum(1 for r in ledger if r["level"] == "top" and r["role"] != "excluded"),
        "child": sum(1 for r in ledger if r["level"] == "child"),
        "by_system": dict(collections.Counter(r["source_system"] for r in ledger
                                              if r["role"] != "excluded")),
        "by_role": dict(collections.Counter(r["role"] for r in ledger)),
        "by_status": dict(collections.Counter(
            r["status"] if r["status"] else ("(源表未填状态)" if not r["status_raw"] else "(有值但未归一)")
            for r in ledger if r["role"] != "excluded")),
        "by_status_raw": dict(collections.Counter(r["status_raw"] or "(空)" for r in ledger
                                                  if r["role"] != "excluded")),
        "unnormalized_status": sorted({r["status_raw"] for r in ledger
                                       if r["status_raw"] and not r["status"]
                                       and r["role"] != "excluded"}),
        "title_missing": sum(1 for r in ledger if not r.get("title")),
        "title_synthesized": sum(1 for r in ledger if r.get("title_source") == "synthesized"),
        "no_owner": sum(1 for r in ledger if not r.get("owner") and r["role"] != "excluded"),
        "no_date_due": sum(1 for r in ledger if not r.get("date_due") and r["role"] != "excluded"),
        "source_records_total": sum(c["source_records"] for c in coverage),
    }

    out = {
        "schema_version": schema["schema_version"],
        "snapshot_id": snap.snapshot_id,
        "snapshot_taken_at_utc": snap.taken_at,
        "generated_by": "tools/kb_build.py",
        "authority": schema["authority"],
        "stats": stats,
        "records": ledger,
    }
    with open(LEDGER, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    with open(COVERAGE, "w", encoding="utf-8") as f:
        json.dump({"snapshot_id": snap.snapshot_id, "stats": stats,
                   "coverage": sorted(coverage, key=lambda c: (c["system"], c["table"]))},
                  f, ensure_ascii=False, indent=1)

    if quiet:
        return 0

    print(f"快照 {snap.snapshot_id}\n")
    print("═══ 覆盖报告（每张源表的去向）═══")
    print(f"  {'系统':<9}{'表':<26}{'源条数':>7}{'进台账':>7}{'顶层':>6}{'子任务':>7}  说明")
    for c in sorted(coverage, key=lambda c: (c["system"], c["table"])):
        if c["included"]:
            print(f"  {c['system']:<9}{c['table']:<26}{c['source_records']:>7}"
                  f"{c['in_ledger']:>7}{c['top']:>6}{c['child']:>7}  ✅")
        else:
            print(f"  {c['system']:<9}{c['table']:<26}{c['source_records']:>7}{'—':>7}"
                  f"{'—':>6}{'—':>7}  {c['reason']}")
    print(f"\n  源记录合计 {stats['source_records_total']} → 台账 {stats['real_records']} 条"
          f"（顶层 {stats['top']} + 子任务 {stats['child']}）+ 1 条排除占位")

    print("\n═══ 台账状态分布 ═══")
    for k, v in sorted(stats["by_status"].items(), key=lambda kv: -kv[1]):
        print(f"  {k:<10} {v:>5}")
    if stats["unnormalized_status"]:
        print(f"  ⚠️ 未归一：{stats['unnormalized_status']}")

    print("\n═══ 归一前原文（保留验证）═══")
    for k, v in sorted(stats["by_status_raw"].items(), key=lambda kv: -kv[1]):
        print(f"  {k:<14} {v:>5}")

    print("\n═══ 缺口读数（决定哪些结论只能说在子集上）═══")
    print(f"  无标题            {stats['title_missing']}")
    print(f"  标题为合成        {stats['title_synthesized']}")
    print(f"  无负责人          {stats['no_owner']}")
    print(f"  无计划完成日期    {stats['no_date_due']}  / {stats['real_records']}"
          f"  → 逾期率只能建在其余 {stats['real_records'] - stats['no_date_due']} 条上")

    print(f"\n→ {os.path.relpath(LEDGER, load.REPO)}")
    print(f"→ {os.path.relpath(COVERAGE, load.REPO)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""
live_snapshot.py —— 把飞书云端数据拉成本地可复算的快照（只读）

为什么需要它：
  之前所有治理分析（research/governance/*）读的是 `PRD/内容治理需求文档.md`
  —— 那是 09-15 手工复制的一份**冻结副本**。副本会漂移，而且无法自动化复跑。

  本脚本直接读飞书 API，产出带 **内容哈希** 的快照，
  让「我们分析的是哪一版数据」这件事变成可验证的事实，而不是记忆。

产出：
  research/live/snapshot-<UTC时间戳>.json    原始数据 + 元信息
  research/live/LATEST.json                  指向最新快照的指针

用法：
  python3 tools/live_snapshot.py
  python3 tools/live_snapshot.py --quiet      # 只打印摘要
"""
import hashlib
import json
import os
import sys
import time
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__))))
from lark_find import token, _req, BASE  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "research", "live")

# 数据源登记表：每张表都是「业务侧真实在用的」
SOURCES = [
    {
        "key": "ad_copy",
        "label": "广告文案明细",
        "app_token": "Lk3Qb8y2QaVyZns6gprcVNE9nA0",
        "table_id": "tblcbk4XiW6471YN",
    },
    {
        "key": "boundary_rules",
        "label": "品线内容边界规则库",
        "app_token": "Lk3Qb8y2QaVyZns6gprcVNE9nA0",
        "table_id": "tblD1MiUK1v5fdjD",
    },
    {
        "key": "w1_claims",
        "label": "W1卖点表达边界",
        "app_token": "Lk3Qb8y2QaVyZns6gprcVNE9nA0",
        "table_id": "tblqUTAKFkWheU49",
    },
    {
        "key": "rewrite_lib",
        "label": "风险文案改写建议库",
        "app_token": "Lk3Qb8y2QaVyZns6gprcVNE9nA0",
        "table_id": "tblLxUfPz4Wqp2na",
    },
    {
        "key": "kb_materials",
        "label": "内容治理知识库·材料收集",
        "app_token": "GnRZbIuXraCzf0sGr2UcmZ62nfc",
        "table_id": "tblMGtPfe8ZUsEdP",
    },
    {
        "key": "kb_samples",
        "label": "内容治理知识库·正面和负面样本",
        "app_token": "GnRZbIuXraCzf0sGr2UcmZ62nfc",
        "table_id": "tbld8qE92YaY38Yz",
    },
]


def fetch_all(t, app_token, table_id):
    """翻页取全量。返回 (records, api_total)。"""
    items, page_token = [], None
    api_total = None
    while True:
        url = (f"{BASE}/bitable/v1/apps/{app_token}/tables/{table_id}"
               f"/records?page_size=500")
        if page_token:
            url += f"&page_token={page_token}"
        r = _req(url, t)
        if r.get("code") != 0:
            return None, f"code={r.get('code')} msg={r.get('msg')}"
        d = r["data"]
        if api_total is None:
            api_total = d.get("total")
        items.extend(d.get("items", []))
        if not d.get("has_more"):
            break
        page_token = d.get("page_token")
        if not page_token:
            break
    return items, api_total


def canonical_hash(records):
    """
    内容指纹：只取 fields + record_id，按键排序后哈希。
    刻意排除 last_modified_time —— 否则「有人打开表点了下保存」也会造成哈希变化，
    把「内容变了」和「元数据动了」混为一谈。
    """
    canon = []
    for it in records:
        canon.append({
            "record_id": it.get("record_id"),
            "fields": it.get("fields", {}),
        })
    canon.sort(key=lambda x: x["record_id"] or "")
    blob = json.dumps(canon, ensure_ascii=False, sort_keys=True).encode()
    return hashlib.sha256(blob).hexdigest()


def main():
    quiet = "--quiet" in sys.argv
    t = token()
    ts = datetime.now(timezone.utc)
    stamp = ts.strftime("%Y%m%dT%H%M%SZ")

    snap = {
        "schema": "live-snapshot/v1",
        "captured_at_utc": ts.isoformat(),
        "captured_at_local": ts.astimezone().isoformat(),
        "captured_by": "tools/live_snapshot.py (飞书应用身份 tenant_access_token)",
        "note": (
            "全部数字都是**应用身份**（守衡 app）所见的数字，不是表的真实总量。"
            "应用只能读到被显式授权的记录，因此 api_total 本身也是被权限过滤后的值 —— "
            "它既不等于表的总行数，也无法用来推算丢失了多少。"
            "要拿真实总量，必须由有权限的人在飞书里导出或截图。"
        ),
        "sources": {},
    }

    print("=" * 78)
    print("飞书云端 → 本地快照")
    print("=" * 78)
    for s in SOURCES:
        recs, api_total = fetch_all(t, s["app_token"], s["table_id"])
        if recs is None:
            print(f"  {s['label']:32s} ❌ {api_total}")
            snap["sources"][s["key"]] = {
                "label": s["label"], "error": api_total,
                "app_token": s["app_token"], "table_id": s["table_id"],
            }
            continue
        h = canonical_hash(recs)
        snap["sources"][s["key"]] = {
            "label": s["label"],
            "app_token": s["app_token"],
            "table_id": s["table_id"],
            "api_total": api_total,
            "read_count": len(recs),
            "content_sha256": h,
            "records": recs,
        }
        mismatch = "" if api_total == len(recs) else f"  ⚠ 接口 total({api_total}) ≠ 实读({len(recs)})"
        print(f"  {s['label']:32s} 实读 {len(recs):4d} 条"
              f"  sha256={h[:12]}…{mismatch}")

    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, f"snapshot-{stamp}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(snap, f, ensure_ascii=False, indent=2)

    pointer = os.path.join(OUT_DIR, "LATEST.json")
    with open(pointer, "w", encoding="utf-8") as f:
        json.dump({
            "latest": os.path.basename(path),
            "captured_at_utc": snap["captured_at_utc"],
            "sources": {
                k: {"read_count": v.get("read_count"),
                    "api_total": v.get("api_total"),
                    "content_sha256": v.get("content_sha256")}
                for k, v in snap["sources"].items()
            },
        }, f, ensure_ascii=False, indent=2)

    print()
    print(f"  快照 → {os.path.relpath(path, ROOT)}")
    print(f"  指针 → {os.path.relpath(pointer, ROOT)}")
    print("=" * 78)
    return 0


if __name__ == "__main__":
    sys.exit(main())

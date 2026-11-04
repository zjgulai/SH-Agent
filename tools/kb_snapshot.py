#!/usr/bin/env python3
"""
kb_snapshot.py —— 需求知识库 · 源系统全量快照（**只读**）

从飞书拉取两套在跑的需求/任务系统的全部数据表，落成本地 JSON 快照 + MANIFEST。

设计约束（见 research/kb/需求知识库-建设方案.md §三 / §四）：
  1. 全程只读，绝不写源系统。
  2. `资源账号管理`（含「密码」字段）整体排除，只在 MANIFEST 留占位记录。
  3. 分页必须拉完；同时记录 `reported_total` 与 `fetched` 的差 —— 应用身份读到的是
     被权限过滤后的子集，两者不等必须在 MANIFEST 里显式标出，否则台账会「不全却以为全」。

用法：
  python3 tools/kb_snapshot.py               # 全量拉取，写入带时间戳的新目录
  python3 tools/kb_snapshot.py --list        # 只列源与表，不拉数据
  python3 tools/kb_snapshot.py --out DIR     # 指定输出目录
"""

import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

CRED = os.path.expanduser("~/.dsh/credentials/shouheng-lark.json")
API = "https://open.feishu.cn/open-apis"
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_OUT = os.path.join(REPO, "research", "kb", "_evidence")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
# 只共用**超时常量**：`_req` 的契约与 lark_http.call() 不同（参数序、3 次退避重试、
# HTTP 错误返回 {"code":...}），强行合并会改变失败语义 —— 理由写在 lark_http.NON_MEMBERS。
import lark_http  # noqa: E402

PAGE_SIZE = 500
RETRY = 3
RETRY_WAIT = 2.0

SOURCES = [
    {
        "system": "creative",
        "label": "【创意】需求排期与任务管理",
        "base": "OShmbLBaPam6YSsCzP0cNOyBn6f",
        "url": "https://momcozy-in.feishu.cn/base/OShmbLBaPam6YSsCzP0cNOyBn6f",
        # 含「密码」字段，按 ADR-0003 与建设方案 §三 整体排除
        "exclude_tables": ["资源账号管理"],
    },
    {
        "system": "seo",
        "label": "品线SEO任务管理系统",
        "base": "DXJ6b5cKtaXPQasoayEc74SUnog",
        "url": "https://momcozy-in.feishu.cn/base/DXJ6b5cKtaXPQasoayEc74SUnog",
        "exclude_tables": [],
    },
]


# ─────────────────────────── HTTP ───────────────────────────

def _req(url, token, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method="POST" if data else "GET")
    req.add_header("Authorization", f"Bearer {token}")
    if data:
        req.add_header("Content-Type", "application/json; charset=utf-8")
    last = None
    for attempt in range(RETRY):
        try:
            with urllib.request.urlopen(req, timeout=lark_http.TIMEOUT) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            body = e.read().decode()[:600]
            # 4xx 不重试（重试也没用），5xx 重试
            if e.code < 500:
                return {"code": e.code, "msg": body, "_http": e.code}
            last = f"HTTP {e.code}: {body}"
        except Exception as e:                       # noqa: BLE001
            last = f"{type(e).__name__}: {e}"
        if attempt < RETRY - 1:
            time.sleep(RETRY_WAIT * (attempt + 1))
    return {"code": -1, "msg": last or "unknown", "_err": last}


def token():
    c = json.load(open(CRED))
    r = _req(f"{API}/auth/v3/tenant_access_token/internal", None,
             {"app_id": c["app_id"], "app_secret": c["app_secret"]})
    if r.get("code") != 0:
        raise SystemExit(f"取 tenant_access_token 失败：{json.dumps(r, ensure_ascii=False)[:400]}")
    return r["tenant_access_token"]


def list_tables(tok, base):
    r = _req(f"{API}/bitable/v1/apps/{base}/tables?page_size=100", tok)
    if r.get("code") != 0:
        raise SystemExit(f"列表失败 base={base}：{json.dumps(r, ensure_ascii=False)[:400]}")
    return r["data"].get("items", [])


def list_fields(tok, base, table):
    r = _req(f"{API}/bitable/v1/apps/{base}/tables/{table}/fields?page_size=100", tok)
    return r["data"].get("items", []) if r.get("code") == 0 else []


def fetch_records(tok, base, table):
    """拉完分页。返回 (items, reported_total, pages, err)。"""
    items, page_token, pages = [], None, 0
    reported = None
    while True:
        q = {"page_size": PAGE_SIZE}
        if page_token:
            q["page_token"] = page_token
        url = f"{API}/bitable/v1/apps/{base}/tables/{table}/records?" + urllib.parse.urlencode(q)
        r = _req(url, tok)
        if r.get("code") != 0:
            return items, reported, pages, json.dumps(r, ensure_ascii=False)[:400]
        d = r["data"]
        items.extend(d.get("items", []))
        pages += 1
        if reported is None:
            reported = d.get("total")
        if not d.get("has_more"):
            break
        page_token = d.get("page_token")
        if not page_token:
            break
        if pages > 200:                              # 防跑飞
            return items, reported, pages, "分页超过 200 页，中止"
    return items, reported, pages, None


# ─────────────────────────── 主流程 ───────────────────────────

def canonical_hash(obj):
    blob = json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(blob).hexdigest()


def safe_name(s):
    keep = [c if (c.isalnum() or c in "-_") else "_" for c in s]
    out = "".join(keep).strip("_")
    return out[:60] or "unnamed"


def do_list(tok):
    for src in SOURCES:
        print(f"\n═══ {src['label']}  ({src['system']}) ═══")
        print(f"  base = {src['base']}")
        for t in list_tables(tok, src["base"]):
            mark = "  ⛔ 排除" if t["name"] in src["exclude_tables"] else ""
            nf = len(list_fields(tok, src["base"], t["table_id"]))
            print(f"    - {t['name']:<28} id={t['table_id']}  字段 {nf}{mark}")
    return 0


def do_snapshot(tok, out_root):
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out = os.path.join(out_root, f"snapshot-{ts}")
    os.makedirs(out, exist_ok=True)

    manifest = {
        "snapshot_id": ts,
        "taken_at_utc": datetime.now(timezone.utc).isoformat(),
        "identity": "tenant_access_token (app: 守衡)",
        "note": "应用身份读到的是被权限过滤后的子集；reported_total 与 fetched 不等即表示有不可见记录。",
        "sources": [],
    }

    grand_fetched = grand_reported = 0
    problems = []

    for src in SOURCES:
        entry = {
            "system": src["system"], "label": src["label"],
            "base": src["base"], "url": src["url"], "tables": [],
        }
        print(f"\n═══ {src['label']} ═══")
        for t in list_tables(tok, src["base"]):
            name, tid = t["name"], t["table_id"]

            if name in src["exclude_tables"]:
                # 不拉数据，但留占位 —— 「存在但未纳管」本身是必须被记录的事实
                flds = [f["field_name"] for f in list_fields(tok, src["base"], tid)]
                entry["tables"].append({
                    "name": name, "table_id": tid, "included": False,
                    "reason": "含敏感字段，按 ADR-0003 与建设方案 §三 排除",
                    "fields_seen": flds, "fetched": 0,
                })
                print(f"  ⛔ {name:<28} 排除（字段 {len(flds)} 个，含敏感列）")
                continue

            fields = [f["field_name"] for f in list_fields(tok, src["base"], tid)]
            items, reported, pages, err = fetch_records(tok, src["base"], tid)

            rec = {
                "name": name, "table_id": tid, "included": True,
                "fields": fields,
                "reported_total": reported,
                "fetched": len(items),
                "pages": pages,
                "error": err,
                "records_sha256": canonical_hash(items) if items else None,
                "records": items,
            }
            entry["tables"].append(rec)

            flag = ""
            if err:
                flag = f"  ❌ {err[:60]}"
                problems.append(f"{src['label']} / {name}: {err[:120]}")
            elif reported is not None and reported != len(items):
                flag = f"  ⚠️ 可见性缺口 reported={reported} fetched={len(items)}"
                problems.append(
                    f"{src['label']} / {name}: reported_total={reported} 但只读到 {len(items)}")
            grand_fetched += len(items)
            grand_reported += (reported or len(items))
            print(f"  ✅ {name:<28} {len(items):>5} 条 / 声明 {reported}  字段 {len(fields):>2}  "
                  f"页 {pages}{flag}")

            # 逐表落盘：大表拆文件，便于 diff
            fn = f"{src['system']}__{safe_name(name)}.json"
            with open(os.path.join(out, fn), "w", encoding="utf-8") as f:
                json.dump(rec, f, ensure_ascii=False, indent=1)
            # MANIFEST 只留摘要 —— 记录本身已在逐表文件里，不重复存一份
            rec.pop("records", None)
            rec["file"] = fn

        manifest["sources"].append(entry)

    manifest["totals"] = {
        "fetched": grand_fetched,
        "reported": grand_reported,
        "gap": grand_reported - grand_fetched,
    }
    manifest["problems"] = problems
    manifest["ok"] = not problems

    with open(os.path.join(out, "MANIFEST.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    latest = os.path.join(out_root, "LATEST.json")
    with open(latest, "w", encoding="utf-8") as f:
        json.dump({"snapshot_id": ts, "dir": os.path.relpath(out, REPO),
                   "taken_at_utc": manifest["taken_at_utc"],
                   "totals": manifest["totals"], "ok": manifest["ok"]}, f,
                  ensure_ascii=False, indent=2)

    print(f"\n{'═' * 62}")
    print(f"快照目录 : {os.path.relpath(out, REPO)}")
    print(f"合计      : 读取 {grand_fetched} 条 / 源系统声明 {grand_reported} 条"
          f"  差 {manifest['totals']['gap']}")
    if problems:
        print(f"\n⚠️  {len(problems)} 处需要解释：")
        for p in problems:
            print(f"   - {p}")
    else:
        print("✅ 无可见性缺口")
    return 0


def main():
    args = sys.argv[1:]
    tok = token()
    if "--list" in args:
        return do_list(tok)
    out = DEFAULT_OUT
    if "--out" in args:
        out = args[args.index("--out") + 1]
    os.makedirs(out, exist_ok=True)
    return do_snapshot(tok, out)


if __name__ == "__main__":
    sys.exit(main())

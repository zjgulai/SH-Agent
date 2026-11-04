#!/usr/bin/env python3
"""
migrate_kb_to_lark.py —— 把需求台账落到飞书「需求知识库」Base（操作账本）

★ 为什么必须是 app 自建的 Base（实测结论，与 ADR-0008/0009 同源）

    守衡 app 对**用户拥有的** Base 只有读权限；对**自己空间里创建的** Base 有完整写权限。
    所以「台账必须由程序化维护」这件事，只有让 app 自己拥有一个 Base 才成立。

落到两张表：
  · 需求台账   —— 1160 条归一化记录（+ 1 条敏感表占位）
  · 覆盖报告   —— 18 张源表的去向。**这是必须的**：不列出来，读者无法区分
                  「没有需求」与「需求没被记录」（ADR-0010 §五）

用法：
  python3 tools/migrate_kb_to_lark.py                     # 预演
  python3 tools/migrate_kb_to_lark.py --create-base       # 新建 Base 并打印 token
  python3 tools/migrate_kb_to_lark.py --apply             # 建表 + 写入
  python3 tools/migrate_kb_to_lark.py --apply --force     # 已存在则清空重建
  python3 tools/migrate_kb_to_lark.py --roundtrip         # 回读比对，产出验收输入
"""

import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
# HTTP 调用是**唯一实现**，不许在本文件里再抄一份（超时/头/错误形状都在那里定义）。
from lark_http import call  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
KB = ROOT / "research" / "kb"
CRED = os.path.expanduser("~/.dsh/credentials/shouheng-lark.json")
API = "https://open.feishu.cn/open-apis"
CST = timezone(timedelta(hours=8))

BASE_NAME = "需求知识库"          # 飞书 app 名不接受 / 「·」全角括号（实测 InvalidAppName）
STATE_FILE = KB / "_evidence" / "feishu-base.json"     # 记住 app_token，避免重复建
ROUNDTRIP = KB / "_evidence" / "feishu-roundtrip.json"

T_TEXT, T_SINGLE, T_DATE = 1, 3, 5


# ── HTTP：`call()` 已收编到 tools/lark_http.py（2026-09-22）──────────────
#   本文件那份与 tools/kb_materials_lark.py 的那份**逐字节相同**（sha256 302e9f0d…），
#   连超时都一样（60）。收编后唯一实现在 lark_http.call。
#   行为等价的证据：`python3 tools/lark_http.py --controls`。


def get_token():
    c = json.loads(Path(CRED).read_text())
    r = call(f"{API}/auth/v3/tenant_access_token/internal",
             {"app_id": c["app_id"], "app_secret": c["app_secret"]})
    if "tenant_access_token" not in r:
        raise SystemExit(f"❌ 取 token 失败：{json.dumps(r, ensure_ascii=False)[:300]}")
    return r["tenant_access_token"]


def txt(name):
    return {"field_name": name, "type": T_TEXT}


def sel(name, options):
    return {"field_name": name, "type": T_SINGLE,
            "property": {"options": [{"name": o} for o in options]}}


def dat(name):
    return {"field_name": name, "type": T_DATE,
            "property": {"date_formatter": "yyyy/MM/dd", "auto_fill": False}}


LEDGER_FIELDS = [
    txt("标题"), txt("记录键"), txt("来源系统"), txt("来源表"), txt("来源记录ID"),
    txt("角色"), txt("层级"), txt("父记录"), txt("类别"), txt("品线"), txt("SKU"),
    txt("状态"), txt("状态原文"), txt("优先级"), txt("优先级体系"),
    txt("提出人"), txt("负责人"),
    dat("提出日期"), dat("计划完成"), dat("实际完成"),
    txt("交付物"), txt("备注"), txt("指纹"),
]

COVERAGE_FIELDS = [
    txt("系统"), txt("表"), txt("性质"), txt("源条数"), txt("进台账"),
    txt("顶层"), txt("子任务"), txt("说明"),
]


def date_ms(iso):
    if not iso:
        return None
    d = datetime.strptime(iso, "%Y-%m-%d").replace(tzinfo=CST)
    return int(d.timestamp() * 1000)


def ledger_rows():
    doc = json.load(open(KB / "台账-v1.json", encoding="utf-8"))
    role_cn = {"demand": "需求", "review": "审核", "excluded": "已排除"}
    scale_cn = {"P0P1P2": "P0-P2", "eisenhower": "四象限"}
    rows = []
    for r in doc["records"]:
        f = {
            "标题": r.get("title") or "(无标题)",
            "记录键": r["record_key"],
            "来源系统": r["source_system"],
            "来源表": r["source_table"],
            "来源记录ID": r.get("source_record_id") or "",
            "角色": role_cn.get(r["role"], r["role"]),
            "层级": {"top": "顶层", "child": "子任务"}.get(r.get("level"), r.get("level") or ""),
            "父记录": r.get("parent_title") or "",
            "状态": r.get("status") or "",
            "状态原文": r.get("status_raw") or "",
            "优先级": r.get("priority") or "",
            "优先级体系": scale_cn.get(r.get("priority_scale"), ""),
            "提出人": r.get("requester") or "",
            "负责人": r.get("owner") or "",
            "交付物": (r.get("deliverable") or "")[:2000],
            "备注": (r.get("notes") or "")[:2000],
            "指纹": r.get("fingerprint") or "",
        }
        for k, v in (("类别", r.get("category")), ("品线", r.get("product_line")),
                     ("SKU", r.get("sku"))):
            f[k] = (v or "")[:500]
        for k, v in (("提出日期", r.get("date_submitted")), ("计划完成", r.get("date_due")),
                     ("实际完成", r.get("date_done"))):
            ms = date_ms(v)
            if ms:
                f[k] = ms
        rows.append({k: v for k, v in f.items() if v not in ("", None)})
    return rows


def coverage_rows():
    doc = json.load(open(KB / "覆盖报告.json", encoding="utf-8"))
    rows = []
    for c in doc["coverage"]:
        note = c.get("reason") or ("✅ 已进台账" if c["included"] else "")
        if c["included"]:
            note = (f"顶层 {c['top']} + 子任务 {c['child']}；"
                    f"角色 {c['role']}") if c["role"] else note
        rows.append({
            "系统": c["system"], "表": c["table"], "性质": c.get("kind") or c.get("role", ""),
            "源条数": str(c["source_records"]),
            "进台账": str(c["in_ledger"]) if c["included"] else "0",
            "顶层": str(c["top"]) if c["included"] else "—",
            "子任务": str(c["child"]) if c["included"] else "—",
            "说明": note,
        })
    return rows


def ensure_base(T, apply_):
    if STATE_FILE.exists():
        st = json.load(open(STATE_FILE, encoding="utf-8"))
        print(f"   复用已有 Base：{st['app_token']}（{st.get('name')}）")
        return st["app_token"]
    if not apply_:
        print("   （尚无 Base，--create-base 或 --apply 时创建）")
        return None
    r = call(f"{API}/bitable/v1/apps", {"name": BASE_NAME}, T)
    if r.get("code") != 0:
        raise SystemExit(f"❌ 建 Base 失败：{json.dumps(r, ensure_ascii=False)[:400]}")
    token = r["data"]["app"]["app_token"]
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    json.dump({"app_token": token, "name": BASE_NAME,
               "url": f"https://momcozy-in.feishu.cn/base/{token}",
               "created_at": datetime.now(CST).isoformat()},
              open(STATE_FILE, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print(f"   ✅ 新建 Base「{BASE_NAME}」→ {token}")
    return token


def ensure_table(T, app, name, fields, drop_if_exists=False):
    r = call(f"{API}/bitable/v1/apps/{app}/tables?page_size=100", None, T)
    if r.get("code") != 0:
        raise SystemExit(f"❌ 列不出表：{json.dumps(r, ensure_ascii=False)[:300]}")
    existing = {x["name"]: x["table_id"] for x in r["data"]["items"]}
    if name in existing:
        tid = existing[name]
        if not drop_if_exists:
            print(f"   ↷ 表「{name}」已存在（{tid}），沿用")
            return tid, False
        call(f"{API}/bitable/v1/apps/{app}/tables/{tid}", None, T, "DELETE")
        print(f"   ✕ 表「{name}」已删除（--force）")
    res = call(f"{API}/bitable/v1/apps/{app}/tables",
               {"table": {"name": name, "default_view_name": "表格", "fields": fields}}, T)
    if res.get("code") != 0:
        raise SystemExit(f"❌ 建表「{name}」失败：{json.dumps(res, ensure_ascii=False)[:400]}")
    print(f"   ✅ 建表「{name}」→ {res['data']['table_id']}")
    return res["data"]["table_id"], True


def write_rows(T, app, tid, rows, label):
    ok, bad = 0, []
    for i in range(0, len(rows), 200):
        chunk = rows[i:i + 200]
        res = call(f"{API}/bitable/v1/apps/{app}/tables/{tid}/records/batch_create",
                   {"records": [{"fields": r} for r in chunk]}, T)
        if res.get("code") != 0:
            bad.append(json.dumps(res, ensure_ascii=False)[:200])
            continue
        ok += len(res["data"]["records"])
    print(f"   {'✅' if not bad else '⚠️ '} {label} 写入 {ok}/{len(rows)} 行"
          + (f"，{len(bad)} 批失败：{bad[0][:120]}" if bad else ""))
    return ok


def fetch_all(T, app, tid):
    out, page_token = [], None
    while True:
        url = f"{API}/bitable/v1/apps/{app}/tables/{tid}/records?page_size=500"
        if page_token:
            url += f"&page_token={page_token}"
        r = call(url, None, T)
        if r.get("code") != 0:
            raise SystemExit(f"❌ 回读失败：{json.dumps(r, ensure_ascii=False)[:300]}")
        out.extend(r["data"]["items"])
        if not r["data"].get("has_more"):
            break
        page_token = r["data"].get("page_token")
    return out


def roundtrip(T, app, tid):
    """回读飞书，与台账逐条比对，产出 verify_kb.py 的 C10 输入。"""
    # 本地侧与飞书侧用同一套字段名比对：都取 ledger_rows() 的产物
    local = {}
    for r in ledger_rows():
        local[str(r["记录键"])] = r
    remote_items = fetch_all(T, app, tid)
    remote = {}
    for it in remote_items:
        f = it["fields"]
        k = f.get("记录键")
        k = k[0]["text"] if isinstance(k, list) and k and isinstance(k[0], dict) else k
        remote[str(k)] = f

    missing = sorted(set(local) - set(remote))
    extra = sorted(set(remote) - set(local))
    mismatch = []
    for k in set(local) & set(remote):
        lf, rf = local[k], remote[k]

        def rv(name):
            v = rf.get(name)
            if isinstance(v, list) and v and isinstance(v[0], dict):
                return v[0].get("text") or v[0].get("name")
            return v

        for name in ("标题", "来源记录ID", "状态", "状态原文", "指纹"):
            lvv = lf.get(name) or ""
            rvv = rv(name) or ""
            if str(lvv) != str(rvv):
                mismatch.append({"key": k, "field": name, "local": str(lvv)[:60],
                                 "feishu": str(rvv)[:60]})
                break

    result = {
        "checked_at": datetime.now(CST).isoformat(),
        "app_token": app, "table_id": tid,
        "ledger_records": len(local), "feishu_records": len(remote),
        "missing": len(missing), "extra": len(extra), "mismatch": len(mismatch),
        "missing_samples": missing[:5], "extra_samples": extra[:5],
        "mismatch_samples": mismatch[:5],
        "match": not missing and not extra and not mismatch and len(local) == len(remote),
    }
    json.dump(result, open(ROUNDTRIP, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print(f"\n═══ 飞书回读比对 ═══")
    print(f"  台账 {len(local)} 条 ／ 飞书 {len(remote)} 条")
    print(f"  缺失 {len(missing)} · 多余 {len(extra)} · 字段不符 {len(mismatch)}")
    if mismatch:
        for m in mismatch[:5]:
            print(f"    {m['field']}: 本地 {m['local']!r} ≠ 飞书 {m['feishu']!r}")
    print(f"  {'✅ 逐条一致' if result['match'] else '❌ 不一致'}")
    print(f"  → {os.path.relpath(ROUNDTRIP, ROOT)}")
    return result["match"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--create-base", action="store_true")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--roundtrip", action="store_true")
    a = ap.parse_args()

    T = get_token()
    lr, cr = ledger_rows(), coverage_rows()
    print(f"需求知识库 Base：{BASE_NAME}")
    print(f"  将写入 需求台账 {len(lr)} 行（含敏感表占位）／ 覆盖报告 {len(cr)} 行\n")

    app = ensure_base(T, a.apply or a.create_base)
    if a.create_base and not a.apply:
        return 0
    if not app:
        print("（未加 --apply，未写任何东西）")
        return 0

    if a.roundtrip:
        state = json.load(open(KB / "_evidence" / "feishu-tables.json", encoding="utf-8"))
        return 0 if roundtrip(T, app, state["需求台账"]) else 1

    if not a.apply:
        print("（未加 --apply，未写任何东西）")
        return 0

    print("① 建表")
    t_led, _ = ensure_table(T, app, "需求台账", LEDGER_FIELDS, a.force)
    t_cov, _ = ensure_table(T, app, "覆盖报告", COVERAGE_FIELDS, a.force)

    print("\n② 写记录")
    write_rows(T, app, t_led, lr, "需求台账")
    write_rows(T, app, t_cov, cr, "覆盖报告")

    json.dump({"需求台账": t_led, "覆盖报告": t_cov},
              open(KB / "_evidence" / "feishu-tables.json", "w", encoding="utf-8"),
              ensure_ascii=False, indent=2)

    url = f"https://momcozy-in.feishu.cn/base/{app}"
    print(f"\n→ {url}")
    print("   下一步：python3 tools/migrate_kb_to_lark.py --roundtrip")
    return 0


if __name__ == "__main__":
    sys.exit(main())

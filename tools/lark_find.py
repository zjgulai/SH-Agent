#!/usr/bin/env python3
"""
lark_find.py —— 用应用身份在飞书里「检索 + 读取」（只读）

发现：应用 tenant_access_token 竟然能调用 suite/docs-api/search/object，
      并且能看到 owner 是真人（周健）的文档。这是本次整合的关键通道。

用法：
  python3 tools/lark_find.py search "关键词" [count]
  python3 tools/lark_find.py read <docs_token> <docs_type>
  python3 tools/lark_find.py readdoc <docx_token>          # 直接读正文
  python3 tools/lark_find.py tables <bitable_token>        # 列出多维表格的数据表
  python3 tools/lark_find.py fields <bitable_token> <table_id>
  python3 tools/lark_find.py records <bitable_token> <table_id> [page_size]
  python3 tools/lark_find.py wiki <wiki_token>             # 解析 wiki 节点真实 obj_token
"""
import json
import os
import sys
import urllib.parse
import urllib.request
import urllib.error

from feishu_read_policy import ReadPolicyError, assert_read_allowed, blocked_resource, load_policy

CRED = os.path.expanduser("~/.dsh/credentials/shouheng-lark.json")
BASE = "https://open.feishu.cn/open-apis"


def _req(url, token, payload=None, method=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method or ("POST" if data else "GET"))
    req.add_header("Authorization", f"Bearer {token}")
    if data:
        req.add_header("Content-Type", "application/json; charset=utf-8")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return {"_http": e.code, "body": e.read().decode()[:600]}
    except Exception as e:
        return {"_err": f"{type(e).__name__}: {e}"}


def token():
    c = json.load(open(CRED))
    r = _req(f"{BASE}/auth/v3/tenant_access_token/internal", None,
             {"app_id": c["app_id"], "app_secret": c["app_secret"]})
    if r.get("code") != 0:
        raise SystemExit(f"取 token 失败：{r}")
    return r["tenant_access_token"]


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    cmd = sys.argv[1]
    # 在取凭据之前执行；脚本每次启动读盘，停读决定不依赖守护进程重启。
    try:
        policy = load_policy()
        if cmd in {"read", "readdoc", "tables", "fields", "records", "wiki"}:
            if len(sys.argv) < 3:
                print("缺少资源 token"); return 2
            assert_read_allowed(sys.argv[2], policy=policy)
    except ReadPolicyError as exc:
        print(f"停读检查拒绝读取：{exc}")
        return 2
    t = token()

    if cmd == "search":
        q = sys.argv[2]
        n = int(sys.argv[3]) if len(sys.argv) > 3 else 50
        r = _req(f"{BASE}/suite/docs-api/search/object", t, {"search_key": q, "count": n})
        if r.get("code") != 0:
            print("❌", json.dumps(r, ensure_ascii=False)[:600]); return 1
        found = r["data"].get("docs_entities", [])
        ents = [e for e in found if not blocked_resource(e.get("docs_token"), policy=policy)]
        print(f"搜索总命中 {r['data'].get('total')} 条，本页可用 {len(ents)} 条"
              f"（按停读清单排除 {len(found) - len(ents)} 条）：\n")
        for i, e in enumerate(ents, 1):
            print(f"{i:3d}. [{e.get('docs_type')}] {e.get('title')}")
            print(f"     token={e.get('docs_token')}  owner={e.get('owner_id')}")
        return 0

    if cmd == "read":
        dt, typ = sys.argv[2], sys.argv[3]
        if typ == "docx":
            r = _req(f"{BASE}/docx/v1/documents/{dt}/raw_content", t)
            print(json.dumps(r, ensure_ascii=False)[:8000])
        elif typ == "bitable":
            r = _req(f"{BASE}/bitable/v1/apps/{dt}", t)
            print(json.dumps(r, ensure_ascii=False)[:3000])
        elif typ == "wiki":
            r = _req(f"{BASE}/wiki/v2/spaces/get_node?token={dt}", t)
            print(json.dumps(r, ensure_ascii=False)[:3000])
        else:
            print(json.dumps(_req(f"{BASE}/wiki/v2/spaces/get_node?token={dt}", t), ensure_ascii=False)[:3000])
        return 0

    if cmd == "readdoc":
        r = _req(f"{BASE}/docx/v1/documents/{sys.argv[2]}/raw_content", t)
        if r.get("code") != 0:
            print("❌", json.dumps(r, ensure_ascii=False)[:500]); return 1
        # ★ 原样写出，**不补换行**（2026-09-22 改，改前是 print()）。
        #   理由：`PRD/feishu/索引-v1.json` 里的 sha256 / chars / size_bytes 记的是
        #   raw_content **本身**的读数，而 verify_prd_baseline.py 的 B1–B3 拿落盘副本去比那三个数。
        #   用 print() 会多一个 "\n" —— 于是「照文档跑那条重拉命令」得到的文件永远对不上索引，
        #   B1/B2/B3 全红；下一个人会以为是自己弄坏的，而不是**这条命令复现不出文档里的数**
        #   （AGENTS.md §2.2 第 1 条：文档里的数字要能复现出来）。
        #   实测依据：2026-09-22 重拉《一页纸计划书》，print() 版落盘 2933 字 / 6541 字节，
        #   而索引口径是 2932 字 —— 差的正是这一个换行。
        sys.stdout.write(r["data"].get("content", ""))
        return 0

    if cmd == "tables":
        bt = sys.argv[2]
        r = _req(f"{BASE}/bitable/v1/apps/{bt}/tables?page_size=100", t)
        if r.get("code") != 0:
            print("❌", json.dumps(r, ensure_ascii=False)[:500]); return 1
        for it in r["data"].get("items", []):
            print(f"  table_id={it['table_id']}  name={it.get('name')}  "
                  f"records={it.get('revision')}")
        return 0

    if cmd == "fields":
        bt, tb = sys.argv[2], sys.argv[3]
        r = _req(f"{BASE}/bitable/v1/apps/{bt}/tables/{tb}/fields?page_size=100", t)
        if r.get("code") != 0:
            print("❌", json.dumps(r, ensure_ascii=False)[:500]); return 1
        for it in r["data"].get("items", []):
            print(f"  {it['field_name']}  (type={it['type']}, id={it['field_id']})")
        return 0

    if cmd == "records":
        bt, tb = sys.argv[2], sys.argv[3]
        ps = int(sys.argv[4]) if len(sys.argv) > 4 else 20
        url = (f"{BASE}/bitable/v1/apps/{bt}/tables/{tb}/records"
               f"?page_size={ps}")
        r = _req(url, t)
        if r.get("code") != 0:
            print("❌", json.dumps(r, ensure_ascii=False)[:500]); return 1
        d = r["data"]
        print(f"total={d.get('total')} has_more={d.get('has_more')} "
              f"returned={len(d.get('items', []))}")
        for it in d.get("items", [])[:5]:
            f = it.get("fields", {})
            print("  ---")
            for k, v in list(f.items())[:12]:
                sv = json.dumps(v, ensure_ascii=False)
                print(f"    {k} = {sv[:160]}")
        return 0

    if cmd == "wiki":
        r = _req(f"{BASE}/wiki/v2/spaces/get_node?token={sys.argv[2]}", t)
        print(json.dumps(r, ensure_ascii=False)[:2000])
        return 0

    print(__doc__)
    return 1


if __name__ == "__main__":
    sys.exit(main())

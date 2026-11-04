#!/usr/bin/env python3
"""
lark_probe.py —— 飞书「应用身份」能力探针（只读）

背景：本机没有 lark-cli（无 brew、无独立 node），所以云端文档的读取只能走
      守衡自己的飞书应用凭据（~/.dsh/credentials/shouheng-lark.json）。

目的：先问清楚「以应用身份，到底能看见什么」，再决定整合方案。
      不做任何写操作，不改任何文档。

用法：
  python3 tools/lark_probe.py                # 全量探针
  python3 tools/lark_probe.py <doc_token>    # 额外探测某个文档 token
"""
import json
import os
import sys
import urllib.request
import urllib.error

CRED = os.path.expanduser("~/.dsh/credentials/shouheng-lark.json")
BASE = "https://open.feishu.cn/open-apis"


def post(url, payload, token=None):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json; charset=utf-8")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return {"_http": e.code, "body": e.read().decode()[:400]}
    except Exception as e:
        return {"_err": f"{type(e).__name__}: {e}"}


def get(url, token):
    req = urllib.request.Request(url, method="GET")
    req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return {"_http": e.code, "body": e.read().decode()[:400]}
    except Exception as e:
        return {"_err": f"{type(e).__name__}: {e}"}


def brief(r, maxlen=260):
    """把响应压成一行人类可读的结论。"""
    if "_http" in r or "_err" in r:
        return f"❌ {r}"
    code = r.get("code")
    if code == 0:
        d = r.get("data", {})
        keys = list(d.keys())
        return f"✅ code=0 data keys={keys} | {json.dumps(d, ensure_ascii=False)[:maxlen]}"
    return f"⚠️ code={code} msg={r.get('msg')}"


def main():
    cred = json.load(open(CRED))
    app_id, app_secret = cred["app_id"], cred["app_secret"]

    print("=" * 70)
    print("飞书应用身份能力探针（只读）")
    print(f"app_id = {app_id[:10]}…（{cred.get('app_name')}）")
    print("=" * 70)

    tok = post(f"{BASE}/auth/v3/tenant_access_token/internal",
               {"app_id": app_id, "app_secret": app_secret})
    if tok.get("code") != 0:
        print("❌ 拿不到 tenant_access_token：", brief(tok))
        return 1
    t = tok["tenant_access_token"]
    print(f"\n① tenant_access_token：✅ 取得（长度 {len(t)}，有效期 {tok.get('expire')}s）")

    print("\n② 应用自身信息（含权限范围提示）")
    print("   ", brief(get(f"{BASE}/application/v6/applications/{app_id}?lang=zh_cn", t)))

    print("\n③ 云文档：列出应用可见的文件（drive/v1/files）")
    print("   ", brief(get(f"{BASE}/drive/v1/files?page_size=50", t)))

    print("\n④ 云空间：我的空间元信息")
    print("   ", brief(get(f"{BASE}/drive/explorer/v2/root_folder/meta", t)))

    print("\n⑤ 知识库：列出应用可见的 wiki 空间")
    print("   ", brief(get(f"{BASE}/wiki/v2/spaces?page_size=50", t)))

    print("\n⑥ 云文档搜索（search/v2，需 user 身份，预期失败）")
    print("   ", brief(post(f"{BASE}/suite/docs-api/search/object",
                          {"search_key": "内容审查", "count": 10}, t)))

    if len(sys.argv) > 1:
        dt = sys.argv[1]
        print(f"\n⑦ 指定文档 token={dt} 的三种读法")
        print("   docx raw_content:", brief(get(f"{BASE}/docx/v1/documents/{dt}/raw_content", t)))
        print("   docx meta       :", brief(get(f"{BASE}/docx/v1/documents/{dt}", t)))
        print("   wiki node       :", brief(get(f"{BASE}/wiki/v2/spaces/get_node?token={dt}", t)))
        print("   bitable meta    :", brief(get(f"{BASE}/bitable/v1/apps/{dt}", t)))

    print("\n" + "=" * 70)
    return 0


if __name__ == "__main__":
    sys.exit(main())

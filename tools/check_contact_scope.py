#!/usr/bin/env python3
"""check_contact_scope.py —— 通讯录「可见范围」扩没扩的**当场读数**（只读，不改任何东西）

## 为什么单独有它

2026-09-18 委托方分两步办了通讯录权限。这类更改最典型的失败
**不是点错了，而是点了、界面显示保存成功、数据没变** —— 本项目已经为这件事
吃过一次亏（AGENTS.md §2.2 第 3 条：不要把「界面上看得见」当成「已经生效」）。

所以扩完之后必须有一个当场读数，而且读的必须是**飞书回给你的条数**，
不是控制台的开关状态。**开关是声明，条数是证据。**

## 实测的三个阶段（这三行就是本脚本的判据来源）

| 阶段 | 授权范围 | 22 个 owner 里 |
|---|---|---|
| 扩之前 | 2 人 | 可查 1（还没名字）· 被拒 21 |
| 只补 `contact:user.base:readonly` | 2 人 | 可查 1（**有名字了**）· 被拒 21 |
| 再扩权限范围 | **22 部门 + 1 人** | 可查 **19（都有名字）**· 被拒 **3** |

**关键：最后那 3 个不是「还没扩到」。** 它们的业务码不同，可解性也不同：

  · `41012 the user is invalid error` —— open_id 已失效（人离职/被删）。
    **扩权限永久解不了**，只能换责任人。本轮恰好卡着 **2 条本租户资产**
    （`品线内容边界-机器词表`、`需求知识库`）。
  · `41050 no user authority error` 且**名下 0 条本租户资源** —— 飞书官方模板库/
    帮助内容的 owner（名下的条数之和**恰好等于全部非本租户资源**），
    它们永远不该出现在我们组织架构里。

## 所以判据是这样定的（这一点比读数更重要）

初版把「22/22 都能叫出名字」当成通过条件 —— 那个条件**永远不可能达成**，
于是这个脚本会永久报红，而**一个永远不会绿的检查等于没有检查**（AGENTS.md 里
README_TOL 那段话就是这个意思）。改成按「本租户相关」判定：

  · **本租户相关 owner** = 名下至少 1 条本租户（`core`）资源的那批。
    **它们**才必须能叫出名字；解不出的必须落到一个业务码上。
  · **非本租户 owner** = 名下 0 条本租户资源。不参与判定，但如实列出。

判定与退出码：

  | 退出码 | 含义 |
  |---|---|
  | 0 | **权限这层已到位**：本租户相关 owner 里没有一个被 `41050` 之类挡着。（可能仍有 ⚠️ 需人工转移的离职 owner —— 那是人事动作，不是权限动作） |
  | 1 | **还没到位**：本租户相关 owner 里仍有人回 `41050`（= 范围没扩到）或其它未知码 |
  | 2 | 凭据 / 索引读不到，**没测成**（不是「没到位」） |

## 用法

    python3 tools/check_contact_scope.py            # 人读
    python3 tools/check_contact_scope.py --json     # 机器读
    python3 tools/check_contact_scope.py --quiet    # 只打结论行

凭据：`~/.dsh/credentials/shouheng-lark.json`（只读用，与 feishu_index.py 同一个）
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

BASE = "https://open.feishu.cn/open-apis"
ROOT = Path(__file__).resolve().parent.parent
INDEX = ROOT / "research" / "feishu" / "资源索引-v1.json"
CRED = Path(os.path.expanduser("~/.dsh/credentials/shouheng-lark.json"))

CORE = "core"          # 本租户层（判据：域名 = momcozy-in.feishu.cn）
CODE_RANGE = "41050"   # 不在应用的通讯录权限范围内 —— **扩范围能解**
CODE_INVALID = "41012"  # open_id 已失效（离职/被删）—— **扩范围解不了**


def _call(method: str, url: str, tok: str | None, body: dict | None = None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json; charset=utf-8")
    if tok:
        req.add_header("Authorization", f"Bearer {tok}")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode()), None
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode()), f"http_{e.code}"
        except Exception:
            return {}, f"http_{e.code}"
    except Exception as e:  # 网络层
        return {}, f"net:{type(e).__name__}"


def _why(r: dict, err: str | None) -> str:
    """把一次失败压成一句话 —— **优先用飞书给的业务码，不要用 HTTP 码**。

    2026-09-18 初版这里写错过：`41050` 是随 HTTP 400 回来的，初版只留了 `http_400`，
    于是 21 条被拒的原因在输出里全变成同一句「http_400」，
    **「不在可见范围（41050）」和「我路径写错了（404）」在报告里长得一模一样** ——
    这正是 AGENTS.md §2.4.1 说的那种安静假数据。业务码必须活到人眼前。
    """
    if isinstance(r, dict) and r.get("code") is not None:
        return f"code={r.get('code')} {r.get('msg')}".strip()
    return err or "unknown"


def _kind(err: str | None) -> str:
    if not err:
        return "ok"
    if CODE_INVALID in err:
        return "invalid"
    if CODE_RANGE in err:
        return "range"
    return "other"


def token() -> tuple[str, str]:
    if not CRED.exists():
        raise SystemExit(f"✗ 凭据不存在：{CRED}")
    c = json.loads(CRED.read_text(encoding="utf-8"))
    r, err = _call("POST", f"{BASE}/auth/v3/tenant_access_token/internal", None,
                   {"app_id": c["app_id"], "app_secret": c["app_secret"]})
    if err or r.get("code") != 0:
        raise SystemExit(f"✗ 取 tenant_access_token 失败：{err} {r.get('code')} {r.get('msg')}")
    return r["tenant_access_token"], c["app_id"]


def fetch_scope(tok: str) -> tuple[list[str], list[str], str | None]:
    """把通讯录授权范围一次翻到底。

    **必须翻页**：扩范围之前只有 2 人，一页就完；扩完回的是**部门列表**且可能分页。
    不翻页的话，扩完之后这个读数会只报第一页 —— 那就成了「改完了，读数还是错的」，
    比没有读数更糟。翻页上限 200 页是防跑飞，不是口径。
    """
    users: list[str] = []
    depts: list[str] = []
    page_token = None
    for _ in range(200):
        url = f"{BASE}/contact/v3/scopes?user_id_type=open_id&page_size=50"
        if page_token:
            url += "&page_token=" + urllib.parse.quote(page_token, safe="")
        r, err = _call("GET", url, tok)
        if err or r.get("code") != 0:
            return users, depts, _why(r, err)
        d = r.get("data") or {}
        users += list(d.get("user_ids") or [])
        depts += list(d.get("department_ids") or [])
        page_token = d.get("page_token")
        if not d.get("has_more") or not page_token:
            break
    return users, depts, None


def one_user(tok: str, open_id: str) -> dict:
    """读一个人。返回 {ok, name, email, err}。绝不把失败降级成空。"""
    r, err = _call("GET", f"{BASE}/contact/v3/users/{open_id}"
                          f"?user_id_type=open_id&department_id_type=open_department_id", tok)
    if err or r.get("code") != 0:
        return {"ok": False, "name": None, "email": None, "err": _why(r, err)}
    u = (r.get("data") or {}).get("user") or {}
    return {"ok": True, "name": u.get("name"), "email": u.get("email"), "err": None}


def main() -> int:
    ap = argparse.ArgumentParser(description="通讯录可见范围读数（只读）")
    ap.add_argument("--json", action="store_true", help="机器可读输出")
    ap.add_argument("--quiet", action="store_true", help="只打结论行")
    a = ap.parse_args()

    tok, app_id = token()

    # ── ① 通讯录授权范围（翻到底） ───────────────────────────────────
    visible, dept_ids, scope_err = fetch_scope(tok)
    scopes_ok = scope_err is None
    vis_detail = [dict(open_id=o, **one_user(tok, o)) for o in visible]

    # ── ②③ 索引里真实存在的那批 owner ────────────────────────────────
    if not INDEX.exists():
        print(f"✗ 索引不存在：{INDEX}（先跑 python3 tools/feishu_index.py）", file=sys.stderr)
        return 2
    idx = json.loads(INDEX.read_text(encoding="utf-8"))
    resources = idx.get("resources", [])
    owners = sorted({x["owner"] for x in resources if x.get("owner")})
    core_n = {o: sum(1 for x in resources
                     if x.get("owner") == o and x.get("tier") == CORE) for o in owners}

    rows = []
    for o in owners:
        d = one_user(tok, o)
        rows.append({"open_id": o, "ok": d["ok"], "name": d["name"], "email": d["email"],
                     "err": d["err"], "kind": _kind(d["err"]), "core_items": core_n[o]})

    # ── 分类：只有「名下 ≥1 条本租户资源」的 owner 才参与判定 ───────────
    in_tenant = [r for r in rows if r["core_items"] > 0]
    outside = [r for r in rows if r["core_items"] == 0]
    it_named = [r for r in in_tenant if r["name"]]
    it_range = [r for r in in_tenant if r["kind"] == "range"]
    it_invalid = [r for r in in_tenant if r["kind"] == "invalid"]
    it_other = [r for r in in_tenant if r["kind"] == "other"]

    if not scopes_ok:
        verdict = "unmeasured"
    elif it_range or it_other:
        verdict = "not_yet"          # 权限/范围这层还没到位
    elif it_invalid:
        verdict = "manual"           # 权限到位，剩离职 owner 要人工转移
    else:
        verdict = "ok"

    out = {
        "app_id": app_id,
        "scopes_ok": scopes_ok, "scopes_err": scope_err,
        "visible_n": len(visible), "visible_dept_n": len(dept_ids),
        "visible": vis_detail,
        "owners_asked": len(owners),
        "owners_named": sum(1 for r in rows if r["name"]),
        "owners_denied": sum(1 for r in rows if not r["ok"]),
        "in_tenant_owners": len(in_tenant),
        "in_tenant_named": len(it_named),
        "in_tenant_range": [r["open_id"] for r in it_range],
        "in_tenant_invalid": [{"open_id": r["open_id"], "core_items": r["core_items"]}
                              for r in it_invalid],
        "in_tenant_other": [{"open_id": r["open_id"], "err": r["err"]} for r in it_other],
        "outside_owners": len(outside),
        "verdict": verdict,
    }

    if a.json:
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return 0 if verdict in ("ok", "manual") else 1

    if not a.quiet:
        print("守衡 · 通讯录可见范围读数（只读，未改任何东西）")
        print()
        print("① 通讯录授权范围  contact/v3/scopes")
        if not scopes_ok:
            print(f"   ✗ 读不到：{scope_err}")
        else:
            print(f"   授权 {len(dept_ids)} 个部门 + {len(visible)} 个人")
            for v in vis_detail:
                if v["ok"]:
                    print(f"     · {v['open_id']}  {v['email'] or '(无邮箱)'}  "
                          f"name={v['name'] or '✗ 空'}")
                else:
                    print(f"     · {v['open_id']}  ✗ {v['err']}")
        print()
        print(f"②③ 索引里那 {len(owners)} 个 owner（口径：资源索引-v1.json 的 resources[].owner 去重）")
        print(f"   拿到名字 {out['owners_named']} 个 · 查不到 {out['owners_denied']} 个")
        print()
        print(f"   ▸ 本租户相关 owner（名下 ≥1 条 core 资源）：{len(in_tenant)} 个")
        # 解不出的排最前 —— 这份输出是给人扫的，不能让 ❌ 埋在第 12 行
        for r in sorted(in_tenant, key=lambda r: (r["name"] is not None, r["open_id"])):
            tag = f"✅ {r['name']}" if r["name"] else f"❌ {r['err']}"
            print(f"       {tag}   （名下 core {r['core_items']} 条）")
        if outside:
            kinds: dict[str, int] = {}
            items = 0
            for r in outside:
                kinds[r["kind"]] = kinds.get(r["kind"], 0) + 1
                items += r["core_items"]
            print(f"   ▸ 非本租户 owner（名下 0 条 core）：{len(outside)} 个 · "
                  f"业务码 {kinds} —— 不参与判定")
        print()

    # ── 结论 ────────────────────────────────────────────────────────
    if verdict == "unmeasured":
        print(f"⚠️ 没测成：授权范围读不到（{scope_err}）。**这不是「没到位」**，别当结论用。")
        return 2

    if verdict == "not_yet":
        print(f"❌ 还没到位：本租户相关 owner {len(in_tenant)} 个，"
              f"能叫出名字 {len(it_named)} 个。")
        for r in it_range:
            print(f"   · {r['open_id']} 回 `{CODE_RANGE}`（不在通讯录权限范围内）"
                  f"—— 名下 core {r['core_items']} 条，这就是要扩那个开关的人")
        for r in it_other:
            print(f"   · {r['open_id']} 回 `{r['err']}`（**未知码**，先去查它是什么意思再动手）")
        return 1

    if verdict == "manual":
        print(f"✅ 权限这层已到位：本租户相关 owner {len(in_tenant)} 个，"
              f"能叫出名字 {len(it_named)} 个，没有一个是「范围不够」。")
        for r in it_invalid:
            print(f"   ⚠️ 但仍有一个**扩权限也解不了**的：{r['open_id']} 回 `{CODE_INVALID}`"
                  f"（open_id 已失效 = 人离职/被删），名下有 **{r['core_items']} 条本租户资产**。")
            print("      → 这不是权限动作，是人事动作：问业务「这些表现在谁负责」，"
                  "在飞书里**转移 owner**。")
        return 0

    print(f"✅ 已到位：本租户相关 owner {len(in_tenant)} 个全部叫得出名字"
          f"（全部 owner {len(owners)} 个里有 {out['owners_denied']} 个非本租户的查不到，属正常）。")
    return 0


if __name__ == "__main__":
    sys.exit(main())

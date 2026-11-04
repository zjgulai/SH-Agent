#!/usr/bin/env python3
"""migrate_vocab_to_lark.py —— 把机器词表（白名单 + 语境守卫）建到飞书独立 Base

★ 为什么是独立 Base，而不是原 Base 里的两张新表 —— 实测结论：

    守衡 app 对用户拥有的 Base `Lk3Qb8y2QaVyZns6gprcVNE9nA0` **只有读权限**：
        读  tables / fields / records   →  全部 code 0
        写  建表 / 建记录 / 删记录 / 改名 →  全部 HTTP 403 · code 91403 Forbidden
    但 app **对自己空间里创建的 Base 有完整写权限**（建表/写/删/删表/链接分享/加协作者全通过）。

    所以「词表必须由程序化维护」这件事，只有让 app 自己拥有一个 Base 才成立。
    这也顺带把机制分离做成**所有权分离**：
        人写规则 → 主 Base（app 只读，物理上改不了）
        app 维护词表 → 本 Base（人可读可编辑，但词表是程序产出的）

用法：
  python3 tools/migrate_vocab_to_lark.py                 # 预演
  python3 tools/migrate_vocab_to_lark.py --apply         # 建表 + 写入
  python3 tools/migrate_vocab_to_lark.py --apply --force # 已存在时清空重建
"""
import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
# HTTP 调用是**唯一实现**，不许在本文件里再抄一份（超时/头/错误形状都在那里定义）。
from lark_http import call  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SK = ROOT / "research/governance/skeleton"
CRED = os.path.expanduser("~/.dsh/credentials/shouheng-lark.json")
BASE = "https://open.feishu.cn/open-apis"

# 已存在的 app 自有 Base（写权限探针时创建，现复用）
APP_TOKEN = "B1oabL2veaFKbKs2hVAcvyKKnEe"
BASE_NAME = "品线内容边界-机器词表"   # 飞书 app 名不接受 `/`「·」全角括号（实测 InvalidAppName）
OWNER_OPEN_ID = "ou_TEST_USER"   # 周健（app 的创建者）

T_TEXT, T_SINGLE = 1, 3


# ── HTTP：`call()` 已收编到 tools/lark_http.py（2026-09-22）──────────────
#   本文件那份超时是 **30**，而 kb_materials_lark.py 那份是 **60** ——
#   同一个接口两套超时，就是「A 脚本成功、B 脚本失败」的来源。收编后是 lark_http.TIMEOUT。
#   行为等价的证据：`python3 tools/lark_http.py --controls`。


def get_token():
    c = json.loads(Path(CRED).read_text())
    r = call(f"{BASE}/auth/v3/tenant_access_token/internal",
             {"app_id": c["app_id"], "app_secret": c["app_secret"]})
    if "tenant_access_token" not in r:
        raise SystemExit(f"❌ 取 token 失败：{json.dumps(r, ensure_ascii=False)[:300]}")
    return r["tenant_access_token"]


def sel(name, options):
    return {"field_name": name, "type": T_SINGLE,
            "property": {"options": [{"name": o} for o in options]}}


def txt(name):
    return {"field_name": name, "type": T_TEXT}


# ── 表定义 ────────────────────────────────────────────────────────────
GUARD_FIELDS = [
    txt("守卫词"), txt("状态"), txt("语种"), txt("守卫类型"),
    txt("降级目标规则"), txt("现网来源"), txt("通道落点"), txt("未接线成因"), txt("备注"),
]
WL_FIELDS = [
    txt("白名单词"), txt("状态"), txt("语种"), txt("放行目标规则"),
    txt("现网规则编号"), txt("证据要求"), txt("与判险词冲突"), txt("隔离原因"),
]
NOTE_FIELDS = [
    txt("词表"), txt("语义"), txt("通道"), txt("规模"), txt("存放位置"), txt("不变量"),
]


def guard_rows():
    G = json.loads((SK / "context-guards-v1.json").read_text())
    st = {"active": "已接线", "pending": "待法务定性", "misrouted": "走错通道"}
    ch = {"downgrade": "manual_review（降级）",
          "pass": "⚠ auto_pass（放行）—— 违反 G3",
          "none": "未接线"}
    rows = []
    for w in G["words"]:
        rows.append({
            "守卫词": w["word"],
            "状态": st.get(w["status"], w["status"]),
            "语种": w["lang"],
            "守卫类型": w["guard_type"],
            "降级目标规则": " / ".join(w["downgrades"]),
            "现网来源": w.get("source_legacy") or "骨架独有（现网未登记）",
            "通道落点": ch.get(w["channel_verdict"], "未接线"),
            "未接线成因": w.get("wire_gap") or "",
            "备注": w.get("status_note") or "",
        })
    return rows


def wl_rows():
    W = json.loads((SK / "whitelist-v1.json").read_text())
    rows = []
    for e in W["words"]:
        rows.append({
            "白名单词": e["word"],
            "状态": "生效" if e["status"] == "active" else "隔离",
            "语种": e.get("lang", ""),
            "放行目标规则": " / ".join(e.get("exempts_rule_keys") or []) or "（无 —— 待法务定性）",
            "现网规则编号": " / ".join(e.get("exempts") or []) or "（无）",
            "证据要求": e.get("evidence_required", ""),
            "与判险词冲突": " / ".join(e.get("live_clash_with_detection") or []) or "",
            "隔离原因": e.get("quarantine_reason") or "",
        })
    return rows


def note_rows():
    G = json.loads((SK / "context-guards-v1.json").read_text())
    W = json.loads((SK / "whitelist-v1.json").read_text())
    return [
        {"词表": "判定规则词表", "语义": "词出现 → 判险（产生命中）",
         "通道": "产生命中", "规模": "24 条规则产生命中",
         "存放位置": "主 Base 的「品线内容边界规则库」（人写）",
         "不变量": "唯一产生命中的来源"},
        {"词表": "白名单表", "语义": "词出现 → **证成**主张（客观事实，第三方可复核）",
         "通道": "auto_pass（隔离词走降级）", "规模": f"{len(W['words'])} 词",
         "存放位置": "本 Base「白名单词」表 + 本地 whitelist-v1.json",
         "不变量": "W1 与判险词表互斥 ｜ W2 必须有放行目标 ｜ W3 隔离词不得放行"},
        {"词表": "语境守卫表", "语义": "词出现 → **取消/弱化**主张（否定/免责/溯源/弱化）",
         "通道": "manual_review only（**绝不放行**）", "规模": f"{len(G['words'])} 词",
         "存放位置": "本 Base「语境守卫词」表 + 本地 context-guards-v1.json",
         "不变量": "G1 与判险词表互斥 ｜ G2 必须有降级目标 ｜ G3 落放行带即违反 ｜ G4 与白名单不重名"},
        {"词表": "（历史）豁免词字段", "语义": "曾同时装上述两种机制，靠词义区分",
         "通道": "无结构 —— 由字符串决定", "规模": "94 条 = 84 守卫 + 10 白名单词",
         "存放位置": "主 Base「品线内容边界规则库」第 18 行附近的 `豁免词` 字段",
         "不变量": "**应废弃**：两种机制共用一个字段，与 `安全词` 是同一种病"},
    ]


def ensure_table(T, app, name, fields, drop_if_exists=False):
    """建表；已存在则返回它（--force 时先删重建）。"""
    r = call(f"{BASE}/bitable/v1/apps/{app}/tables?page_size=100", None, T)
    if r.get("code") != 0:
        raise SystemExit(f"❌ 列不出表：{r}")
    existing = {x["name"]: x["table_id"] for x in r["data"]["items"]}
    if name in existing:
        tid = existing[name]
        if not drop_if_exists:
            print(f"   ↷ 表「{name}」已存在（{tid}），沿用")
            return tid, False
        call(f"{BASE}/bitable/v1/apps/{app}/tables/{tid}", None, T, "DELETE")
        print(f"   ✕ 表「{name}」已删除（--force）")
    res = call(f"{BASE}/bitable/v1/apps/{app}/tables",
               {"table": {"name": name, "default_view_name": "表格", "fields": fields}}, T)
    if res.get("code") != 0:
        raise SystemExit(f"❌ 建表「{name}」失败：{json.dumps(res, ensure_ascii=False)[:300]}")
    print(f"   ✅ 建表「{name}」→ {res['data']['table_id']}")
    return res["data"]["table_id"], True


def count_rows(T, app, tid):
    """表里现在有多少行。**按行数算，不按唯一词算** —— 见下面 write_rows 的说明。"""
    n, pt = 0, None
    while True:
        u = f"{BASE}/bitable/v1/apps/{app}/tables/{tid}/records?page_size=200"
        if pt:
            u += f"&page_token={pt}"
        r = call(u, None, T)     # ★ 这个文件的 `call` 是 (url, payload, token, method) ——
                                 #   传错位会把 token 当 payload 发出去，得到 9499 Bad Request
        if r.get("code") != 0:
            raise SystemExit(f"❌ 读行数失败：{json.dumps(r, ensure_ascii=False)[:300]}")
        n += len(r["data"].get("items", []))
        if not r["data"].get("has_more"):
            return n
        pt = r["data"]["page_token"]


def write_rows(T, app, tid, rows, *, allow_append=False):
    """写词表行。★ 非空表默认**拒绝**写入，除非调用方显式 allow_append。

    ★ 为什么要有这个闸门（2026-09-16 实测踩到）：

      原实现无条件 `batch_create` —— 那是**追加**，不是**替换**。所以跑第二次时，
      整张表翻倍；而跑第一次是完全正确的。于是这个 bug 的形状是：
      **「跑一次对、跑两次错」，且第二次的输出与第一次一模一样全是 ✅。**

      实测后果：守卫表 174 行（85 词）、白名单表 56 行（30 词）、说明表 8 行（4 行），
      而当时的验证脚本报「飞书 89 条 / 字段不符 0」——因为**它比的是集合**，
      重复行在集合里自然消失了。两条缺陷叠在一起，结论就是：同步工具宣称的
      「已同步」在第二次运行时无法被它自己的工具证伪。

      所以闸门放在写入侧：非空表要么用 `--force`（删表重建），要么明确说要追加。
      默认路径不允许产生一张「看起来同步好了、实际上每行都有两三份」的表。
    """
    if not rows:
        return
    existing = count_rows(T, app, tid)
    if existing and not allow_append:
        raise SystemExit(
            f"❌ 表里已有 {existing} 行，拒绝追加（本次要写 {len(rows)} 行）。\n"
            f"   追加会让同一个词在表里出现多份，而**行数**是业务能看见的那一面。\n"
            f"   要重建请加 --force（删表重建）；确实要追加请显式传 allow_append=True。")
    ok = 0
    for i in range(0, len(rows), 200):
        chunk = rows[i:i + 200]
        res = call(f"{BASE}/bitable/v1/apps/{app}/tables/{tid}/records/batch_create",
                   {"records": [{"fields": r} for r in chunk]}, T)
        if res.get("code") != 0:
            raise SystemExit(f"❌ 写记录失败：{json.dumps(res, ensure_ascii=False)[:300]}")
        ok += len(res["data"]["records"])
    print(f"   ✅ 写入 {ok} 行（写前 {existing} 行）")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()

    T = get_token()
    app = APP_TOKEN

    print(f"机器词表 Base：{BASE}/{app}")
    print(f"名称：{BASE_NAME}")
    print()
    gr, wr, nr = guard_rows(), wl_rows(), note_rows()
    print("将要写入（目标表按**替换**语义，非追加）：")
    print(f"  · 语境守卫词  {len(gr):3d} 行（active/pending/misrouted 三态）")
    print(f"  · 白名单词    {len(wr):3d} 行（生效/隔离）")
    print(f"  · 词表分工说明 {len(nr):3d} 行")
    print(f"  · --force {'已指定（删表重建）' if a.force else '未指定（表非空时会拒绝写入）'}")
    print()

    if not a.apply:
        print("（未加 --apply，未写任何东西）")
        return 0

    # ① 改名
    r = call(f"{BASE}/bitable/v1/apps/{app}", {"name": BASE_NAME}, T, "PUT")
    print("① Base 改名：", "✅" if r.get("code") == 0 else f"⚠ {json.dumps(r, ensure_ascii=False)[:160]}")

    # ② 建表
    print("② 建表")
    t_guard, _ = ensure_table(T, app, "语境守卫词", GUARD_FIELDS, a.force)
    t_wl, _ = ensure_table(T, app, "白名单词", WL_FIELDS, a.force)
    t_note, _ = ensure_table(T, app, "词表分工说明", NOTE_FIELDS, a.force)

    # 默认表（app 建 Base 时自带）清掉，避免留一张空表
    r = call(f"{BASE}/bitable/v1/apps/{app}/tables?page_size=100", None, T)
    keep = {t_guard, t_wl, t_note}
    for x in r["data"]["items"]:
        if x["table_id"] not in keep:
            d = call(f"{BASE}/bitable/v1/apps/{app}/tables/{x['table_id']}", None, T, "DELETE")
            print(f"   ✕ 清理默认表「{x['name']}」：{'✅' if d.get('code') == 0 else d}")

    # ③ 写数据
    print("③ 写数据")
    write_rows(T, app, t_guard, gr)
    write_rows(T, app, t_wl, wr)
    write_rows(T, app, t_note, nr)

    # ④ 分享
    print("④ 共享")
    r = call(f"{BASE}/drive/v1/permissions/{app}/public?type=bitable",
             {"link_share_entity": "tenant_editable", "external_access_entity": "closed",
              "security_entity": "anyone_can_view", "comment_entity": "anyone_can_view",
              "share_entity": "anyone", "manage_collaborator_entity": "collaborator_can_view"},
             T, "PATCH")
    print("   组织内可编辑链接：", "✅" if r.get("code") == 0 else json.dumps(r, ensure_ascii=False)[:180])
    r = call(f"{BASE}/drive/v1/permissions/{app}/members?type=bitable&need_notification=false",
             {"member_type": "openid", "member_id": OWNER_OPEN_ID, "perm": "full_access"}, T)
    print("   周健 full_access：", "✅" if r.get("code") == 0 else json.dumps(r, ensure_ascii=False)[:180])

    print()
    print(f"🔗 https://momcozy-in.feishu.cn/base/{app}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

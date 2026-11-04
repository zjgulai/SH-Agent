#!/usr/bin/env python3
"""migrate_whitelist_to_lark.py —— 把白名单迁到飞书独立表（ADR-0008 决策 3 的现网部分）

现状：白名单塞在 `品线内容边界规则库` 的第 18 行（record recvuJP2Ot474u），
      与 20 条判险规则同表，`检测关键词` 字段同名。
      后果：任何「读规则库拼词表」的动作都会让「安全」去证明「有风险」。

本脚本做两步（**默认全部只预演，不写任何东西**）：
  步骤 A｜在同一个 Base 新建表「品线内容安全词白名单」并写入 26 词
  步骤 B｜把 `安全词` 那一行从规则库中删除

  ★ 步骤 A 是**新增**，可回滚（删表）。
  ★ 步骤 B 是**破坏性**操作，会影响他人正在使用的共享表，**必须显式授权**。

用法：
  python3 tools/migrate_whitelist_to_lark.py              # 只预演（默认）
  python3 tools/migrate_whitelist_to_lark.py --execute-a  # 只执行步骤 A（新增表）
  python3 tools/migrate_whitelist_to_lark.py --execute-a --execute-b   # 两步都执行
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
CRED = os.path.expanduser("~/.dsh/credentials/shouheng-lark.json")
BASE = "https://open.feishu.cn/open-apis"
APP_TOKEN = "Lk3Qb8y2QaVyZns6gprcVNE9nA0"
RULE_TABLE = "tblD1MiUK1v5fdjD"          # 品线内容边界规则库
WL_TABLE_NAME = "品线内容安全词白名单"
LEGACY_RECORD = "recvuJP2Ot474u"          # 安全词那一行
WL_JSON = ROOT / "research/governance/skeleton/whitelist-v1.json"

# Bitable 字段类型
T_TEXT, T_SINGLE, T_URL, T_MULTI = 1, 3, 15, 4


# ── HTTP：`call()` 已收编到 tools/lark_http.py（2026-09-22）──────────────
#   本文件那份是全族里**最短的超时（25）+ 最长的错误串截断（500）**。
#   超时收进 lark_http.TIMEOUT（族内最大值 60，只会变长不会变短）；
#   截断收进 lark_http.ERR_BODY_MAX（500，不变）—— 两处都写在那一个模块里。
#   行为等价的证据：`python3 tools/lark_http.py --controls`。


def get_token():
    cred = json.loads(Path(CRED).read_text())
    res = call(f"{BASE}/auth/v3/tenant_access_token/internal",
               {"app_id": cred["app_id"], "app_secret": cred["app_secret"]})
    if "tenant_access_token" not in res:
        raise SystemExit(f"❌ 取 token 失败：{json.dumps(res, ensure_ascii=False)[:300]}")
    return res["tenant_access_token"]


def build_fields():
    """新表字段。沿用规则库表的类型约定（Text/SingleSelect/Url）。"""
    return [
        {"field_name": "白名单词", "type": T_TEXT},
        {"field_name": "状态", "type": T_SINGLE,
         "property": {"options": [{"name": "生效"}, {"name": "隔离"}]}},
        {"field_name": "语言", "type": T_SINGLE,
         "property": {"options": [{"name": "en"}, {"name": "zh"}]}},
        {"field_name": "豁免的规则", "type": T_TEXT},
        {"field_name": "豁免后等级", "type": T_SINGLE,
         "property": {"options": [{"name": "auto_pass"}, {"name": "manual_review"}]}},
        {"field_name": "需证据类型", "type": T_SINGLE,
         "property": {"options": [{"name": "product_spec"}, {"name": "certificate"}]}},
        {"field_name": "可独立复核", "type": T_SINGLE,
         "property": {"options": [{"name": "是"}, {"name": "否"}]}},
        {"field_name": "隔离理由", "type": T_TEXT},
        {"field_name": "来源", "type": T_TEXT},
    ]


def build_records(wl):
    out = []
    for e in wl["words"]:
        active = e["status"] == "active"
        out.append({"fields": {
            "白名单词": e["word"],
            "状态": "生效" if active else "隔离",
            "语言": e.get("lang") or "en",
            "豁免的规则": ", ".join(e.get("exempts") or []),
            "豁免后等级": "auto_pass" if active else "manual_review",
            "需证据类型": e.get("evidence_required") or "",
            "可独立复核": "否" if not active else "是",
            "隔离理由": e.get("quarantine_reason") or "",
            "来源": f"现网 {e.get('source_legacy')}（快照 {wl['source']['snapshot']}）",
        }})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--execute-a", action="store_true", help="真正执行步骤 A（新建白名单表）")
    ap.add_argument("--execute-b", action="store_true", help="真正执行步骤 B（从规则库删除该行）")
    a = ap.parse_args()

    wl = json.loads(WL_JSON.read_text())
    recs = build_records(wl)
    active = sum(1 for r in recs if r["fields"]["状态"] == "生效")

    print("=" * 78)
    print("白名单迁移到飞书独立表 —— ADR-0008 决策 3 的现网部分")
    print("=" * 78)
    print(f"Base        : {APP_TOKEN}")
    print(f"源表        : {RULE_TABLE}（品线内容边界规则库）")
    print(f"目标表      : {WL_TABLE_NAME}（新建）")
    print(f"待迁记录    : {len(recs)} 词（生效 {active} / 隔离 {len(recs) - active}）")
    print()

    print("── 步骤 A｜新建表并写入 ──")
    print(f"字段定义（{len(build_fields())} 个）：")
    for f in build_fields():
        opts = [o["name"] for o in (f.get("property", {}).get("options") or [])]
        print(f"   {f['field_name']:<12} type={f['type']:<3} {opts if opts else ''}")
    print()
    print("样例记录（前 3 条）：")
    for r in recs[:3]:
        print("  ", json.dumps(r["fields"], ensure_ascii=False))
    print()

    print("── 步骤 B｜从规则库删除 ──")
    print(f"待删记录    : {LEGACY_RECORD}（规则编号 = 安全词，边界类型 = 安全词白名单）")
    print("   ⚠ 这是共享生产表上的破坏性操作。删除后：")
    print("      - 规则库只剩 20 条判险规则，`检测关键词` 字段不再混入白名单词")
    print("      - 依赖该行的下游（若有）会取不到「安全词」")
    print()

    if not a.execute_a and not a.execute_b:
        print("=" * 78)
        print("预演结束 —— **没有写入任何东西**。")
        print("确认后执行：")
        print("   python3 tools/migrate_whitelist_to_lark.py --execute-a            # 仅新建表（可回滚）")
        print("   python3 tools/migrate_whitelist_to_lark.py --execute-a --execute-b  # 含删除该行")
        print("=" * 78)
        return 0

    tok = get_token()
    print("✅ 已取得 tenant_access_token")
    print()

    new_table_id = None
    if a.execute_a:
        print("── 执行步骤 A ──")
        # 查重：同名表已存在则中止，避免建出两张
        lst = call(f"{BASE}/bitable/v1/apps/{APP_TOKEN}/tables?page_size=50", token=tok)
        names = [t["name"] for t in (lst.get("data", {}).get("items") or [])]
        if WL_TABLE_NAME in names:
            print(f"❌ 已存在同名表「{WL_TABLE_NAME}」—— 中止，避免重复建表。")
            print("   如需重建，请先在飞书里删除该表。")
            return 1
        res = call(f"{BASE}/bitable/v1/apps/{APP_TOKEN}/tables",
                   {"table": {"name": WL_TABLE_NAME, "default_view_name": "白名单",
                              "fields": build_fields()}}, token=tok)
        if res.get("code") != 0:
            print(f"❌ 建表失败：{json.dumps(res, ensure_ascii=False)[:400]}")
            return 1
        new_table_id = res["data"]["table_id"]
        print(f"✅ 建表成功：{WL_TABLE_NAME} → {new_table_id}")
        print(f"   字段：{[f['field_name'] for f in res['data'].get('field_details') or []] or '见上'}")
        print()

        # 分批写入（上限 500/批，这里 26 条一批足够）
        w = call(f"{BASE}/bitable/v1/apps/{APP_TOKEN}/tables/{new_table_id}/records/batch_create",
                 {"records": recs}, token=tok)
        if w.get("code") != 0:
            print(f"❌ 写入失败：{json.dumps(w, ensure_ascii=False)[:400]}")
            print(f"   表已建好（{new_table_id}），可重试写入。")
            return 1
        got = len(w["data"].get("records") or [])
        print(f"✅ 写入 {got}/{len(recs)} 条")
        print()

    if a.execute_b:
        print("── 执行步骤 B ──")
        d = call(f"{BASE}/bitable/v1/apps/{APP_TOKEN}/tables/{RULE_TABLE}/records/batch_delete",
                 {"records": [LEGACY_RECORD]}, token=tok)
        if d.get("code") != 0:
            print(f"❌ 删除失败：{json.dumps(d, ensure_ascii=False)[:400]}")
            return 1
        print(f"✅ 已从规则库删除 {LEGACY_RECORD}（安全词）")
        print()
        # 核对
        chk = call(f"{BASE}/bitable/v1/apps/{APP_TOKEN}/tables/{RULE_TABLE}/records/search",
                   {"page_size": 1}, token=tok, method="POST")
        if chk.get("code") == 0:
            tot = chk["data"].get("total")
            print(f"   核对：规则库现有 {tot} 条（原 21 条，删 1 → 期望 20）")
        print()

    print("=" * 78)
    print("✅ 迁移完成。请复核：")
    if new_table_id:
        print(f"   白名单表：https://feishu.cn/base/{APP_TOKEN}?table={new_table_id}")
    print("   规则库  ：https://feishu.cn/base/" + APP_TOKEN + "?table=" + RULE_TABLE)
    print("=" * 78)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

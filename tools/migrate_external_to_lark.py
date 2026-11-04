#!/usr/bin/env python3
"""
migrate_external_to_lark.py —— 把本地那 62 条「外部标准库」落成一张**可给法务逐条核对**的飞书表

── 为什么需要这个脚本（2026-09-22 15:29 的真实起因）

对接人在群里问：「你是否已经拉取了美国法务合规相关材料？如果是话请提供一个飞书文档链接给我，
我需要提供给法务合规同事核对确认。」

盘上的事实是：材料**已经拉了**（`research/kb/外部标准库-v1.json`，17 来源 / 62 条，
逐字原文 + 出处 URL + 抓取日期），但**飞书上没有任何载体** —— 于是那个问题当时无法被回答，
不是因为没材料，而是因为**材料和「能给人看的入口」之间缺一步**。

这一步就是本脚本。落点选「需求知识库」Base（`A437bIdQfax7dbsyrAncPpbNnjh`）：

* 它**已经**是 4 类知识库的飞书账本（`知识库分类` / `材料收集` / `收集任务` 三张表都在那儿），
  外部标准库是四类之一 —— 放进别的 Base 会造出第二个入口（本仓反复治的那个病）。
* 它的链接分享是 `tenant_editable`（2026-09-22 读 `drive/v1/permissions/{token}/public` 得到），
  **本租户内拿到链接的人可以打开** —— 这条是本脚本敢把链接给出去的前提，不是假设。
  （反例：业务侧那两个 Base 我们的应用连成员表都读不到，`1063004 User has no share permission`。）

── 三条纪律

1. **不制造第二份权威。** 每条的 `条款原文` 从本地库**逐字**搬，脚本里一个字都不改写、
   不截断、不"整理"。摘要与"对判定的意义"是研究稿里原有的字段，原样搬。
2. **未确认必须看得见。** 全库 `status=research`、`authority.ratifier=null`，
   所以每条都带一列 `我方标注 = 研究稿·未经法务确认`，并且另开四列
   （`法务结论` / `法务备注` / `确认人` / `确认日期`）**留给法务填** ——
   不确认完就不许当依据这件事，写在表结构里，不写在谁脑子里。
3. **写完必须回读。** 「开关是声明，条数是证据」：建完表不回读，等于只证明了接口返回 0。

用法：
  python3 tools/migrate_external_to_lark.py            # 预演（只读本地 + 打印计划，不发请求）
  python3 tools/migrate_external_to_lark.py --apply    # 建表 + 写 62 条 + 回读校验
"""

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lark_http import call  # noqa: E402  —— 全仓唯一 HTTP 入口，不许在这里再抄一份

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "research" / "kb" / "外部标准库-v1.json"
CRED = os.path.expanduser("~/.dsh/credentials/shouheng-lark.json")
API = "https://open.feishu.cn/open-apis"

APP_TOKEN = "A437bIdQfax7dbsyrAncPpbNnjh"     # 需求知识库（应用自建；链接分享=组织内可编辑）
TABLE_NAME = "外部标准库（待法务确认）"

T_TEXT, T_SELECT, T_MULTI, T_DATE, T_URL = 1, 3, 4, 5, 15

# ── 法域：不是「法律属性」，是**给法务一个筛子**。
#    三类各自可核，且不许把平台政策混算成法规 —— 这是这一列存在的全部理由。
#    ⚠️ 这条映射写在代码里、可复核：来源 id → 法域。改它等于改口径，要同时改下面的 F3 断言。
JURISDICTION = {
    "S1": "美国平台政策（按美国站点使用）", "S2": "美国平台政策（按美国站点使用）",
    "S3": "美国平台政策（按美国站点使用）", "S4": "美国平台政策（按美国站点使用）",
    "S5": "美国平台政策（按美国站点使用）", "S6": "美国平台政策（按美国站点使用）",
    "S7": "美国平台政策（按美国站点使用）", "S8": "美国平台政策（按美国站点使用）",
    "S9": "美国平台政策（按美国站点使用）", "S10": "美国平台政策（按美国站点使用）",
    "S17": "美国平台政策（按美国站点使用）",
    "S11": "美国 · 联邦法规/机构指南", "S12": "美国 · 联邦法规/机构指南",
    "S13": "美国 · 联邦法规/机构指南", "S14": "美国 · 联邦法规/机构指南",
    "S15": "英国（对照，非美国法）", "S16": "英国（对照，非美国法）",
}

FIELDS = [
    {"field_name": "条目ID", "type": T_TEXT},
    {"field_name": "法域", "type": T_SELECT, "property": {"options": [
        {"name": "美国 · 联邦法规/机构指南"},
        {"name": "美国平台政策（按美国站点使用）"},
        {"name": "英国（对照，非美国法）"},
    ]}},
    {"field_name": "性质", "type": T_SELECT, "property": {"options": [
        {"name": "监管指南"}, {"name": "平台政策"}, {"name": "行业标准"},
    ]}},
    {"field_name": "来源机构", "type": T_TEXT},
    {"field_name": "来源文档", "type": T_TEXT},
    {"field_name": "条款位置", "type": T_TEXT},
    {"field_name": "条款原文", "type": T_TEXT},
    {"field_name": "中文摘要", "type": T_TEXT},
    {"field_name": "出处链接", "type": T_URL},
    {"field_name": "适用渠道", "type": T_MULTI, "property": {"options": [
        {"name": x} for x in ["amazon", "meta", "google", "tiktok", "独立站", "通用"]
    ]}},
    {"field_name": "适用品线", "type": T_MULTI, "property": {"options": [
        {"name": x} for x in ["吸奶器", "婴幼儿", "喂养", "孕产", "护肤", "通用", "家居", "家纺", "服纺"]
    ]}},
    {"field_name": "关联规则", "type": T_TEXT},
    {"field_name": "对判定的意义", "type": T_TEXT},
    # ── 以下五列：前三列是**读数**（我方），后三列空白**留给法务**。
    {"field_name": "我方标注", "type": T_SELECT, "property": {"options": [
        {"name": "研究稿·未经法务确认"},
    ]}},
    {"field_name": "法务结论", "type": T_SELECT, "property": {"options": [
        {"name": "待确认"}, {"name": "确认可用"}, {"name": "需修改"}, {"name": "不适用"},
    ]}},
    {"field_name": "法务备注", "type": T_TEXT},
    {"field_name": "确认人", "type": T_TEXT},
    {"field_name": "确认日期", "type": T_DATE, "property": {"date_formatter": "yyyy/MM/dd",
                                                          "auto_fill": False}},
]


def token():
    c = json.loads(Path(CRED).read_text())
    r = call(f"{API}/auth/v3/tenant_access_token/internal",
             {"app_id": c["app_id"], "app_secret": c["app_secret"]})
    return r.get("tenant_access_token")


def load_library():
    d = json.loads(SRC.read_text(encoding="utf-8"))
    return d, {s["id"]: s for s in d["sources"]}, d["entries"]


def build_records(d, sources, entries):
    """纯函数：库 → 飞书记录。**预演与落盘走同一个函数**，否则预演就不是预演。"""
    recs = []
    for e in entries:
        s = sources[e["source_id"]]
        recs.append({"fields": {
            "条目ID": e["id"],
            "法域": JURISDICTION[e["source_id"]],
            "性质": s.get("性质") or "未分类",
            "来源机构": s.get("机构") or "",
            "来源文档": s.get("文档") or "",
            "条款位置": e.get("条款位置") or "",
            "条款原文": e.get("条款原文") or "",
            "中文摘要": e.get("摘要") or "",
            "出处链接": {"link": s.get("url") or "", "text": (s.get("url") or "")[:120]},
            "适用渠道": e.get("适用渠道") or [],
            "适用品线": e.get("适用品线") or [],
            "关联规则": "、".join(e.get("关联规则") or []) or "（无 —— 本地规则库无对应条目）",
            "对判定的意义": e.get("对判定的意义") or "",
            "我方标注": "研究稿·未经法务确认",
            "法务结论": "待确认",
        }})
    return recs


def check_library(d, entries):
    """落盘前的本地断言 —— 全部是恒等式，不通过就不许发请求。"""
    bad = []
    if len({e["id"] for e in entries}) != len(entries):
        bad.append("条目 ID 有重复")
    if any(not e.get("条款原文") for e in entries):
        bad.append("有条款原文为空")
    if any(e["source_id"] not in JURISDICTION for e in entries):
        bad.append("有来源没有法域映射")
    if d["authority"].get("ratifier") is not None:
        bad.append("ratifier 不再是 null —— 本地库的「未确认」口径变了，先改本脚本")
    if {e["status"] for e in entries} != {"research"}:
        bad.append("有条目不再是 research 状态")
    return bad


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="真建表并写入（默认只预演）")
    args = ap.parse_args()

    d, sources, entries = load_library()
    recs = build_records(d, sources, entries)
    bad = check_library(d, entries)

    print(f"源文件      {SRC}")
    print(f"条目        {len(entries)} 条 / 来源 {len(sources)} 个")
    print(f"目标 Base   {APP_TOKEN}")
    print(f"新建表      {TABLE_NAME}")
    from collections import Counter
    print("法域分布    " + " · ".join(f"{k} {v}" for k, v in
          Counter(r["fields"]["法域"] for r in recs).most_common()))
    print("关联规则空  %d 条（写成「（无 —— 本地规则库无对应条目）」）"
          % sum(1 for r in recs if r["fields"]["关联规则"].startswith("（无")))
    if bad:
        print("❌ 本地断言未过：" + "；".join(bad))
        return 2
    print("✅ 本地断言全过（ID 唯一 / 原文非空 / 法域齐 / ratifier=null / 全部 research）")

    if not args.apply:
        print("\n（预演结束。加 --apply 才会发请求。）")
        return 0

    tok = token()
    if not tok:
        print("❌ 取 token 失败")
        return 2

    lst = call(f"{API}/bitable/v1/apps/{APP_TOKEN}/tables?page_size=100", token=tok)
    names = [t["name"] for t in (lst.get("data") or {}).get("items") or []]
    if TABLE_NAME in names:
        print(f"❌ 已存在同名表「{TABLE_NAME}」—— 中止，避免建出第二张同义表。")
        return 2

    res = call(f"{API}/bitable/v1/apps/{APP_TOKEN}/tables", token=tok,
               payload={"table": {"name": TABLE_NAME, "default_view_name": "全部条目",
                                  "fields": FIELDS}})
    if res.get("code") != 0:
        print(f"❌ 建表失败：{json.dumps(res, ensure_ascii=False)[:400]}")
        return 2
    tid = res["data"]["table_id"]
    print(f"✅ 建表成功 table_id={tid}")

    # 分批写（接口上限 500 条/次，这里 62 条一次就够，仍按批写以免将来条目变多时静默截断）
    written = 0
    for i in range(0, len(recs), 100):
        chunk = recs[i:i + 100]
        r = call(f"{API}/bitable/v1/apps/{APP_TOKEN}/tables/{tid}/records/batch_create",
                 token=tok, payload={"records": chunk})
        if r.get("code") != 0:
            print(f"❌ 第 {i} 批写入失败：{json.dumps(r, ensure_ascii=False)[:400]}")
            return 2
        written += len((r.get("data") or {}).get("records") or [])
    print(f"✅ 写入 {written} 条")

    # ── 回读（不回读就等于只证明了「接口返回 0」）
    back = call(f"{API}/bitable/v1/apps/{APP_TOKEN}/tables/{tid}/records?page_size=100", token=tok)
    items = (back.get("data") or {}).get("items") or []
    print(f"回读        {len(items)} 条")
    if len(items) != len(entries):
        print(f"❌ 回读条数 {len(items)} ≠ 本地 {len(entries)} —— 有条目没落盘")
        return 2
    sample = next((x for x in items if x["fields"].get("条目ID") == "EXT-001"), None)
    local1 = next(e for e in entries if e["id"] == "EXT-001")
    if not sample or sample["fields"].get("条款原文") != local1["条款原文"]:
        print("❌ 抽检 EXT-001 原文与本地不一致")
        return 2
    print("✅ 回读一致（条数、EXT-001 原文逐字相同）")
    print(f"\n链接：https://momcozy-in.feishu.cn/base/{APP_TOKEN}?table={tid}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

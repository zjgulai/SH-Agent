#!/usr/bin/env python3
"""
migrate_rules_to_lark.py —— 把美国那 50 条落成**她指定的那张【规则库】**表

── 起因（2026-09-22 16:02，对接人在群里的原话，逐字）

    「感谢，口径目前只需要美国的，麻烦把美国相关的新建到[内容治理-知识库]这个文档的
      一个新数据表里面，命名【规则库】，为了可拓展性比如以后可以加入包含其它类型的规则，
      请重新设计规则结构后写入，谢谢！」

16:06:17 她又补一句：「已经给你开通[内容治理-知识库]的编辑权限，**请写入**」。

── 落点为什么是它，以及两个 Base 的区别（同一批数据，两个不同的用途）

| Base | token | 谁建的 | 给谁看 |
|---|---|---|---|
| 需求知识库 · 「外部标准库（待法务确认）」 | `A437bIdQfax7dbsyrAncPpbNnjh` | 应用自建 | 62 条全量、给**法务**逐条确认 |
| 内容治理-知识库 · 「规则库」 | `GnRZbIuXraCzf0sGr2UcmZ62nfc` | **业务侧** | 美国 50 条、**业务侧长期资产**，以后加内部品线规则/案例沉淀 |

**不制造第二份权威**：两处条目的 `规则ID` 都用本地库的 `EXT-0xx`（**同一个主键**），
所以一张表里的任何一行都能和另一张、以及 `research/kb/外部标准库-v1.json` 对上。
（16:04 那张卡片里提过 `EXT-US-001` 这种新主键 —— 这里**不用它**：同一批数据两个主键，
将来对账时就是两套编号。要换编号得先有人定口径。）

── 与那张卡片里给她看的结构，有三处**明写的**不同（都是「不凭空造映射」）

1. `适用渠道` / `适用品类` 沿用本地库**原有的取值**（`amazon/meta/google/tiktok/独立站/通用`、
   `吸奶器/婴幼儿/喂养/孕产/护肤/通用/家居/家纺/服纺`）。卡片里写的是「亚马逊 / 独立站 / 社媒」
   和「吸奶器 / Baby Monitor / Bottle Washer」—— 那是一次**新映射**，没人确认过，不落。
2. 多一列 `条款位置`（那张卡片里没有）。**搬是搬、砍是砍**：本地库有这一列，
   给法务核对时它是「去哪一页哪一段核」的落点，砍掉就是丢内容。
3. `确认人` 用**文本**而不是「人员」字段类型 —— 人员字段写的是 open_id，
   而这一列是留给法务**手填**的；类型选错会让手填变成一件要查 id 的事。

用法：
  python3 tools/migrate_rules_to_lark.py            # 预演（只读本地 + 打印计划，**不发任何写请求**）
  python3 tools/migrate_rules_to_lark.py --apply    # 建表 + 写 50 条 + 回读校验
退出码：0 成功 ｜ 1 有断言红 ｜ 2 环境/接口不通（未测，不许当成「没有权限」）
"""

import argparse
import json
import os
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lark_http import call  # noqa: E402  —— 全仓唯一 HTTP 入口

# 建表/写表的**唯一来源**：常量与「美国/英国」的口径都不在这里重抄一份
from migrate_external_to_lark import JURISDICTION, load_library, token  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
API = "https://open.feishu.cn/open-apis"

APP_TOKEN = "GnRZbIuXraCzf0sGr2UcmZ62nfc"     # 内容治理-知识库（业务侧 Base，她 16:06 开了编辑权限）
TABLE_NAME = "规则库"

T_TEXT, T_SELECT, T_MULTI, T_DATE, T_URL = 1, 3, 4, 5, 15

# 规则类型：这是**唯一的扩展轴** —— 以后加内部品线规则、案例沉淀只加选项，不动结构
TYPE_RULE = "外部法规"
TYPE_PLATFORM = "平台政策"
RULE_TYPE = {**{f"S{i}": TYPE_PLATFORM for i in list(range(1, 11)) + [17]},
             **{f"S{i}": TYPE_RULE for i in range(11, 15)}}

# 规则来源（单选）—— 从 sources 的机构名归一，**一次映射写在这里，可复核**
ORIGIN = {"S1": "Amazon", "S2": "Amazon", "S3": "Amazon", "S4": "Amazon", "S5": "Amazon",
          "S6": "Amazon", "S7": "Meta", "S8": "Meta", "S9": "Google", "S10": "Google",
          "S11": "FDA", "S12": "FDA", "S13": "FDA", "S14": "FTC", "S17": "TikTok"}

FIELDS = [
    {"field_name": "规则ID", "type": T_TEXT},
    {"field_name": "规则类型", "type": T_SELECT, "property": {"options": [
        {"name": TYPE_RULE}, {"name": TYPE_PLATFORM},
        {"name": "内部品线规则"}, {"name": "案例沉淀"},
    ]}},
    {"field_name": "规则来源", "type": T_SELECT, "property": {"options": [
        {"name": x} for x in ["FDA", "FTC", "Amazon", "Google", "Meta", "TikTok", "内部"]
    ]}},
    {"field_name": "来源文档", "type": T_TEXT},
    {"field_name": "条款位置", "type": T_TEXT},
    {"field_name": "来源链接", "type": T_URL},
    {"field_name": "原文逐字", "type": T_TEXT},
    {"field_name": "中文摘要", "type": T_TEXT},
    {"field_name": "法域", "type": T_SELECT, "property": {"options": [
        {"name": "美国"}, {"name": "英国"}, {"name": "其他"},
    ]}},
    {"field_name": "适用渠道", "type": T_MULTI, "property": {"options": [
        {"name": x} for x in ["amazon", "meta", "google", "tiktok", "独立站", "通用"]
    ]}},
    {"field_name": "适用品类", "type": T_MULTI, "property": {"options": [
        {"name": x} for x in ["吸奶器", "婴幼儿", "喂养", "孕产", "护肤", "通用",
                              "家居", "家纺", "服纺"]
    ]}},
    {"field_name": "对判定的意义", "type": T_TEXT},
    {"field_name": "关联现网规则", "type": T_TEXT},
    {"field_name": "状态", "type": T_SELECT, "property": {"options": [
        {"name": "研究稿"}, {"name": "已确认"}, {"name": "已失效"},
    ]}},
    {"field_name": "确认人", "type": T_TEXT},
    {"field_name": "确认日期", "type": T_DATE, "property": {"date_formatter": "yyyy/MM/dd",
                                                          "auto_fill": False}},
]


def us_entries(entries):
    """只取美国那 50 条。口径来自 `JURISDICTION`（与建表脚本**同一处**，不许在这儿再判一次）。"""
    return [e for e in entries if JURISDICTION[e["source_id"]].startswith("美国")]


def build_records(sources, entries):
    """纯函数：库 → 飞书记录。**预演与落盘走同一个函数**，否则预演就不是预演。"""
    recs = []
    for e in entries:
        s = sources[e["source_id"]]
        recs.append({"fields": {
            "规则ID": e["id"],
            "规则类型": RULE_TYPE[e["source_id"]],
            "规则来源": ORIGIN[e["source_id"]],
            "来源文档": s.get("文档") or "",
            "条款位置": e.get("条款位置") or "",
            "来源链接": {"link": s.get("url") or "", "text": (s.get("url") or "")[:120]},
            "原文逐字": e.get("条款原文") or "",
            "中文摘要": e.get("摘要") or "",
            "法域": "美国",
            "适用渠道": e.get("适用渠道") or [],
            "适用品类": e.get("适用品线") or [],
            "对判定的意义": e.get("对判定的意义") or "",
            "关联现网规则": "、".join(e.get("关联规则") or []) or "（无 —— 本地规则库无对应条目）",
            "状态": "研究稿",
        }})
    return recs


def check_local(entries, recs):
    """落盘前的本地断言 —— 全部是恒等式，不通过就不许发写请求。"""
    bad = []
    if len({e["id"] for e in entries}) != len(entries):
        bad.append("规则 ID 有重复")
    if any(not e.get("条款原文") for e in entries):
        bad.append("有原文逐字为空")
    if any(e["source_id"] not in RULE_TYPE for e in entries):
        bad.append("有来源没有规则类型映射")
    if any(e["source_id"] not in ORIGIN for e in entries):
        bad.append("有来源没有规则来源映射")
    if {e["source_id"] for e in entries} & {"S15", "S16"}:
        bad.append("混进了英国来源（S15/S16）—— 她的口径是只要美国")
    if len(recs) != len(entries):
        bad.append("记录数与条目数不等")
    if any(r["fields"]["法域"] != "美国" for r in recs):
        bad.append("有记录法域不是美国")
    return bad


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="真建表并写入（默认只预演）")
    a = ap.parse_args()

    d, sources, all_entries = load_library()
    entries = us_entries(all_entries)
    recs = build_records(sources, entries)

    print("源文件      research/kb/外部标准库-v1.json")
    print("全库        %d 条 / 来源 %d 个" % (len(all_entries), len(d["sources"])))
    print("本次口径    只取美国 → %d 条（英国 %d 条**不写**，按她 16:02 的原话）"
          % (len(entries), len(all_entries) - len(entries)))
    print("目标 Base   %s（内容治理-知识库 · 业务侧）" % APP_TOKEN)
    print("新建表      「%s」· %d 列" % (TABLE_NAME, len(FIELDS)))
    print("规则类型    " + " · ".join("%s %d" % kv for kv in
          Counter(r["fields"]["规则类型"] for r in recs).most_common()))
    print("规则来源    " + " · ".join("%s %d" % kv for kv in
          Counter(r["fields"]["规则来源"] for r in recs).most_common()))
    print("关联规则空  %d 条（写成「（无 —— 本地规则库无对应条目）」）"
          % sum(1 for r in recs if r["fields"]["关联现网规则"].startswith("（无")))

    bad = check_local(entries, recs)
    if bad:
        print("❌ 本地断言未过：" + "；".join(bad))
        return 1
    print("✅ 本地断言全过（ID 唯一 / 原文非空 / 类型与来源映射齐 / 无英国来源 / 法域全为美国）")

    if not a.apply:
        print("\n（预演结束：**一个写请求都没发**。加 --apply 才建表。）")
        return 0

    tok = token()
    if not tok:
        print("❌ 取 token 失败 →【未测】，不是「没有权限」")
        return 2

    lst = call("%s/bitable/v1/apps/%s/tables?page_size=100" % (API, APP_TOKEN), token=tok)
    if lst.get("_http"):
        print("❌ 列不出目标 Base 的表：%s" % json.dumps(lst, ensure_ascii=False)[:300])
        print("   → 这是【未测】：接口没读通，**不能读成「没有权限」**（§2.4.1 第 4 行）")
        return 2
    if lst.get("code") != 0:
        print("❌ 列不出目标 Base 的表：code=%s msg=%s" % (lst.get("code"), lst.get("msg")))
        return 2
    names = [t["name"] for t in ((lst.get("data") or {}).get("items") or [])]
    print("  目标 Base 现有 %d 张表：%s" % (len(names), "、".join(names)))
    if TABLE_NAME in names:
        print("❌ 已存在同名表「%s」—— 中止，避免建出第二张同义表。" % TABLE_NAME)
        return 1

    res = call("%s/bitable/v1/apps/%s/tables" % (API, APP_TOKEN), token=tok,
               payload={"table": {"name": TABLE_NAME, "default_view_name": "全部条目",
                                  "fields": FIELDS}})
    if res.get("code") != 0:
        print("❌ 建表失败：%s" % json.dumps(res, ensure_ascii=False)[:400])
        print("   → 若 code=1063004/99991672：把**原始 code 与 msg 原样记下来**，"
              "别自行翻译成「没权限」（可能是没加协作者、也可能是 scope）。")
        return 2
    tid = res["data"]["table_id"]
    print("✅ 建表成功 table_id=%s" % tid)

    written = 0
    for i in range(0, len(recs), 100):
        chunk = recs[i:i + 100]
        r = call("%s/bitable/v1/apps/%s/tables/%s/records/batch_create" % (API, APP_TOKEN, tid),
                 token=tok, payload={"records": chunk})
        if r.get("code") != 0:
            print("❌ 第 %d 批写入失败：%s" % (i, json.dumps(r, ensure_ascii=False)[:400]))
            return 2
        written += len((r.get("data") or {}).get("records") or [])
    print("✅ 写入 %d 条" % written)

    # ── 回读（不回读就等于只证明了「接口返回 0」）
    back = call("%s/bitable/v1/apps/%s/tables/%s/records?page_size=100" % (API, APP_TOKEN, tid),
                token=tok)
    items = (back.get("data") or {}).get("items") or []
    print("回读        %d 条" % len(items))
    if len(items) != len(entries):
        print("❌ 回读条数 %d ≠ 本地 %d —— 有条目没落盘" % (len(items), len(entries)))
        return 2
    sample = next((x for x in items if x["fields"].get("规则ID") == entries[0]["id"]), None)
    if not sample or sample["fields"].get("原文逐字") != entries[0]["条款原文"]:
        print("❌ 抽检 %s 原文与本地不一致" % entries[0]["id"])
        return 2
    print("✅ 回读一致（条数 %d、%s 原文逐字相同）" % (len(items), entries[0]["id"]))
    print("\n链接：https://momcozy-in.feishu.cn/base/%s?table=%s" % (APP_TOKEN, tid))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

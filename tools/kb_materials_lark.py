#!/usr/bin/env python3
"""
kb_materials_lark.py —— 把「4 类知识库定义 + 材料收集 + 收集任务」落到飞书

业务侧在自己的知识库 Base 里已经**定义好了 4 类知识库**（含建议字段、负责人、
需向对接人收集的问题），但只填了 15 条材料、其中 11 条没有分类、正负样本 8 条里 7 条是样例。
本脚本把这份定义**实例化**到 app 自有的「需求知识库」Base，让它可被枚举、可被追踪。

三张表：
  · 知识库分类 —— 4 类的定义 + 本地现状（每类现在到底有没有货）
  · 材料收集   —— 15 条材料 + 逐条的**实测可读性**（这是本表最有价值的一列）
  · 收集任务   —— 把业务侧写好的「需向对接人收集的问题」变成带负责人和状态的待办

★ 实测可读性为什么重要：材料收集表原本只记「链接」，不记「这条链接我到底读不
  读得到」—— 于是看起来收集了 15 条，实际可用的是少数。**这个差必须被显示出来。**

  ★ 数字一律现算，不写死在散文里（B3.0）：本文件第一版在 docstring 与 TASKS
  备注里写「可读 5 条」，而同一份 MATERIALS 的 ok 列算出来是 4 —— **同一个文件
  自相矛盾**。现在这些数字只从 MATERIALS 现算，散文只指向现算结果。

用法：
  python3 tools/kb_materials_lark.py            # 预演
  python3 tools/kb_materials_lark.py --apply    # 建表 + 写入
  python3 tools/kb_materials_lark.py --apply --force
"""

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from kb_materials_data import MATERIALS, KB_CLASSES, readable, by_class  # noqa: E402
import kb_classes  # noqa: E402
# HTTP 调用是**唯一实现**，不许在本文件里再抄一份（超时/头/错误形状都在那里定义）。
from lark_http import call  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
KB = ROOT / "research" / "kb"
CRED = os.path.expanduser("~/.dsh/credentials/shouheng-lark.json")
API = "https://open.feishu.cn/open-apis"

T_TEXT = 1
STATE = KB / "_evidence" / "feishu-base.json"
TABLES = KB / "_evidence" / "feishu-tables.json"


# ── HTTP：`call()` 已收编到 tools/lark_http.py（2026-09-22）──────────────
#   原先本文件有一份 `call(url, payload=None, token=None, method=None)`；
#   同一份函数在 4 个脚本里各有一份、**只有超时不同**（60/60/30/25），
#   后果是同一个飞书接口在慢网络上 A 脚本成功、B 脚本失败。
#   现在唯一实现在 lark_http.call，超时是 lark_http.TIMEOUT。
#   行为等价的证据：`python3 tools/lark_http.py --controls`（离线 32 组样本 + 4 个反向对照）。


def token():
    c = json.loads(Path(CRED).read_text())
    r = call(f"{API}/auth/v3/tenant_access_token/internal",
             {"app_id": c["app_id"], "app_secret": c["app_secret"]})
    return r["tenant_access_token"]


def txt(n):
    return {"field_name": n, "type": T_TEXT}


# ── 一、4 类知识库定义 —— **唯一来源是 tools/kb_classes.py** ──────────────
#   定义文本逐字取自业务侧「知识库分类说明」表；「本地现有条目 / 状态 / 缺口说明」
#   三列由 kb_classes 现算（B3.2），不在这里手抄 —— 抄一次就会漂一次。
CATEGORIES = kb_classes.category_rows()


# ── 二、材料收集 15 条 —— **数据在 kb_materials_data.py** ────────────────
#   B3.2 拆出去的理由见该文件抬头：数据与「写飞书」分开之后，kb_classes 才能
#   引用同一份材料而不绕成环。两轴分类（材料性质 / 归属知识库）也在那里。
# ── 三、收集任务：由 4 类登记表**生成**，不再手写一份 ────────────────────
#   B3.2 之前这里手抄了一份「每类缺什么」，与 CATEGORIES 里的说明重复 ——
#   同一件事写两处，正是 D12 当初要治的形状。现在唯一来源是 tools/kb_classes.py。
TASKS = kb_classes.collection_tasks()

CAT_FIELDS = [txt("知识库"), txt("要包含什么"), txt("建议字段材料"), txt("负责人"),
              txt("待收集问题"), txt("本地现有条目"), txt("状态"), txt("缺口说明")]
MAT_FIELDS = [txt("编号"), txt("材料"), txt("类型"), txt("token"), txt("来源人"),
              txt("材料性质"), txt("归属知识库"), txt("可读性"), txt("说明")]
TASK_FIELDS = [txt("目标知识库"), txt("待收集问题"), txt("负责人"), txt("状态"), txt("备注")]


def ensure_table(T, app, name, fields, drop):
    r = call(f"{API}/bitable/v1/apps/{app}/tables?page_size=100", None, T)
    if r.get("code") != 0:
        raise SystemExit(f"❌ 列不出表：{r}")
    ex = {x["name"]: x["table_id"] for x in r["data"]["items"]}
    if name in ex:
        if not drop:
            print(f"   ↷ 表「{name}」已存在，沿用")
            return ex[name]
        call(f"{API}/bitable/v1/apps/{app}/tables/{ex[name]}", None, T, "DELETE")
        print(f"   ✕ 表「{name}」已删除（--force）")
    res = call(f"{API}/bitable/v1/apps/{app}/tables",
               {"table": {"name": name, "default_view_name": "表格", "fields": fields}}, T)
    if res.get("code") != 0:
        raise SystemExit(f"❌ 建表「{name}」失败：{json.dumps(res, ensure_ascii=False)[:400]}")
    print(f"   ✅ 建表「{name}」→ {res['data']['table_id']}")
    return res["data"]["table_id"]


def write(T, app, tid, rows, label):
    res = call(f"{API}/bitable/v1/apps/{app}/tables/{tid}/records/batch_create",
               {"records": [{"fields": r} for r in rows]}, T)
    n = len(res["data"]["records"]) if res.get("code") == 0 else 0
    print(f"   {'✅' if n == len(rows) else '⚠️ '} {label} {n}/{len(rows)} 行"
          + ("" if n == len(rows) else f"  {json.dumps(res, ensure_ascii=False)[:160]}"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()

    r = readable()
    print(f"将写入 知识库分类 {len(CATEGORIES)} 行 ／ 材料收集 {len(MATERIALS)} 行 ／ "
          f"收集任务 {len(TASKS)} 行")
    print(f"材料可读性：可读 {r['readable']} / 不可读 {r['unreadable']}"
          f"（perm {r['perm']} / bad {r['bad']}）\n")
    if not a.apply:
        print("（未加 --apply，未写任何东西）")
        return 0

    T = token()
    app = json.load(open(STATE, encoding="utf-8"))["app_token"]
    tabs = json.load(open(TABLES, encoding="utf-8"))

    t1 = ensure_table(T, app, "知识库分类", CAT_FIELDS, a.force) if a.force else \
        ensure_table(T, app, "知识库分类", CAT_FIELDS, False)
    t2 = ensure_table(T, app, "材料收集", MAT_FIELDS, a.force)
    t3 = ensure_table(T, app, "收集任务", TASK_FIELDS, a.force)

    write(T, app, t1, CATEGORIES, "知识库分类")
    write(T, app, t2, MATERIALS, "材料收集")
    write(T, app, t3, [{"目标知识库": x[0], "待收集问题": x[1], "负责人": x[2],
                        "状态": x[3], "备注": x[4]} for x in TASKS], "收集任务")

    tabs.update({"知识库分类": t1, "材料收集": t2, "收集任务": t3})
    json.dump(tabs, open(TABLES, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print(f"\n→ https://momcozy-in.feishu.cn/base/{app}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

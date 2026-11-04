#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
decisions.py —— 「本仓还欠多少决定」**一条命令可答**（D34 的验收）

## 为什么单独一个工具

D34（Q32=A）裁定：三套未决 ID 合并进 `$decision_queue` 单一编号空间，
**「欠了多少决定」要从「打开三个文件自己数」变成一条命令可答。**

在那之前这句话是假的：未决项散在
  ① `$decision_queue`（法务/Owner 要答的题）
  ② `decisions[].$artifact`（已裁定、**制品未落地**的）
  ③ ADR-0013 `遗留#`（11 张表，一部分已关闭、一部分没有）

本工具读**一个**文件（`legal-decisions-v1.json`）回答上面三类，
不再去 ADR 里数 —— 那 38 件 ADR 遗留事项已由 D38 登记进 `$id_aliases.entries`。

用法：
  python3 tools/decisions.py --owe          # 还欠多少（按类、按归属）
  python3 tools/decisions.py --spaces       # 本仓有几套编号，各指什么
  python3 tools/decisions.py --find 遗留 6  # 某个编号/别名指哪一件事
"""

import argparse
import json
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LED = os.path.join(REPO, "research", "governance", "skeleton", "legal-decisions-v1.json")


def load():
    return json.load(open(LED, encoding="utf-8"))


def owe(led):
    dq = led["$decision_queue"]
    dec = led["decisions"]
    ent = led["$id_aliases"]["entries"]

    open_q = [q for q in dq if q.get("status") == "open"]
    # ★ 「制品未落地」不靠猜：决定自己的 `$artifact` 用**一句话**说明了它现在是什么状态。
    #   本工具只把它原样列出来，不做判断 —— 判断留给读的人，这与 V30d 同一条纪律。
    unlanded = [d for d in dec if d.get("$artifact")]
    legacy_open = [e for e in ent if e["status"] == "open"]
    legacy_conflict = [e for e in ent if e["status_conflict"]]

    print(f"台账 {os.path.relpath(LED, REPO)}")
    print(f"  决定 {len(dec)} 条（D1–D{dec[-1]['id'][1:]}）· 队列 {len(dq)} 题（Q1–Q{dq[-1]['id'][1:]}）")
    print()
    print(f"① 待作答的题（队列 open）          {len(open_q):>3} 题")
    for q in open_q:
        print(f"     {q['id']:<4} [{q.get('line','?'):<6}] {q.get('title','')[:52]}")
        print(f"          归属：{q.get('owner','')}")
    print()
    print(f"② ADR-0013 遗留 · 未关闭           {len(legacy_open):>3} 件"
          f"（其中状态冲突 {len(legacy_conflict)} 件）")
    by_owner = {}
    for e in legacy_open:
        by_owner.setdefault(e["owner"], []).append(e["id"])
    for o, ids in sorted(by_owner.items(), key=lambda x: -len(x[1])):
        print(f"     {len(ids):>3} 件  {o}")
    if legacy_conflict:
        print("     ⚠ 状态冲突（同一件事在两处登记、一处说关了一处说没关）："
              + "、".join(e["id"] for e in legacy_conflict))
    print()
    print(f"③ 已裁定但制品未落地（`$artifact` 有话说）  {len(unlanded):>3} 条")
    print()
    print(f"  未关闭合计 = {len(open_q)}（题） + {len(legacy_open)}（遗留） = "
          f"**{len(open_q) + len(legacy_open)}**")
    return 0


def spaces(led):
    sp = led["$id_aliases"]["spaces"]
    print(f"本仓编号空间 {len(sp)} 套（D38 登记）：")
    for k, v in sp.items():
        extra = []
        if v.get("renamed_from"):
            extra.append(f"改名前 {v['renamed_from']}")
        if v.get("landed_by"):
            extra.append(f"由 {v['landed_by']} 落地")
        if v.get("numbers"):
            extra.append(f"{v['numbers']} 个号")
        if v.get("items"):
            extra.append(f"{v['items']} 件事项")
        if v.get("refs_rewritten"):
            extra.append(f"{v['refs_rewritten']} 处引用")
        print(f"  {v['prefix']:<14} {k:<24} {' · '.join(extra)}")
        print(f"      {v['artifact']}")
    print()
    print(f"ADR 遗留事项登记 {len(led['$id_aliases']['entries'])} 件 · "
          f"别名 {sum(len(e['aliases']) for e in led['$id_aliases']['entries'])} 个")
    return 0


def find(led, needle):
    hits = []
    for e in led["$id_aliases"]["entries"]:
        if any(needle == a or needle == a.split("@")[0] for a in e["aliases"]):
            hits.append(e)
    for d in led["decisions"]:
        if needle == d["id"]:
            print(f"{d['id']}（台账决定）· {d.get('question','')[:70]}")
    for q in led["$decision_queue"]:
        if needle == q["id"]:
            print(f"{q['id']}（台账未决）· {q.get('title','')} · status={q.get('status')}")
    if not hits:
        if not any(needle == d["id"] for d in led["decisions"]) and \
           not any(needle == q["id"] for q in led["$decision_queue"]):
            print(f"「{needle}」不在登记处。")
            return 1
        return 0
    if len(hits) > 1:
        print(f"⚠ 「{needle}」指 **{len(hits)} 件**不同的事 —— 这正是撞号，必须带表域限定：")
    for e in hits:
        print(f"  {e['id']:<14} {e['status']:<7} {', '.join(e['aliases'])}")
        print(f"      行 {e['lines']} · 归属 {e['owner']}")
        print(f"      {e['key']}")
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--owe", action="store_true")
    ap.add_argument("--spaces", action="store_true")
    ap.add_argument("--find", default=None)
    a = ap.parse_args()
    led = load()
    if a.spaces:
        return spaces(led)
    if a.find:
        return find(led, a.find)
    return owe(led)


if __name__ == "__main__":
    sys.exit(main())

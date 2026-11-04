#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""tools/verify_open_items.py —— **现在有几件事在等人，等了多久**

## 为什么要有这个文件

2026-09-22 的结构性诊断把「**39/85 语境守卫词对判定零影响**」列成 P0 #4。
复核之后，那条的**可修部分已经修完了**（不是本次修的，是 09-17 那轮）：

* `ADR-0014` 把 39 个词拆成 **Q23–Q26 四道可决策的题**（认领并集守恒 18+1+2+18=39）；
* `verify_engine_contract.py` 的 **V45d** 持续守着「每个未接线词都指向一条 open 项」；
* `ADR-0009` §八 那句被读错的「与现网一致（即：不生效）」**已经有一处带日期的行内更正**，
  指向 `ADR-0014 §二`（方向反了：真实差异是 **放行 → 满档 `auto_reject`**）。

**剩下的只有一件事：等法务答题。** 而这一步在盘上**原来是不可见的** ——
`$decision_queue` 里那几条 `open` 带着 `raised_at`，但**没有任何地方把它读成"等了多久"**，
也没有任何东西会在它一直没人答的时候说一句话。全仓 grep「open 项的天数」零消费者。

这与 `AGENTS.md` §2.4.2 / §2.4.3 是同一条规矩：
**「我方的提问」也要有执行点** —— 指不出哪一行在读它，它就只是愿望。

## 本脚本**不判断**什么（明着留着）

* 它**不判红「悬置太久」**。判据是：这些题自己都写着 `default_if_unanswered`
  （沉默的后果），**沉默是一个已经写下来的答案**，不是疏忽。给天数设阈值等于
  替 Owner 定一条它没定过的政策。
* 它**只读**，不改 `legal-decisions-v1.json`，也不改 `PMO/待收清单-v1.json`。

## 断言

| 段 | 断言 |
|---|---|
| A1 | 每个 `open` 项带 `raised_at`，是 `YYYY-MM-DD`，且**不是未来日期** |
| A2 | 每个 `open` 项带 `owner` 与 `default_if_unanswered`（§2.4.2：沉默的后果必须写下来） |
| A3 | **棘轮**：`open` 项数 ≤ 现状值（只许减）—— 防止「又开了一道题而没人看见」 |
| B1–B4 | `--controls` 反向对照：缺日期 / 未来日期 / 缺沉默后果 / 超棘轮，都必须红 |

退出码：全过 **0** ／ 有红 **1** ／ 读不出 **2**（未测 ≠ 通过 ≠ 红）。

复现：
    python3 tools/verify_open_items.py
    python3 tools/verify_open_items.py --controls
"""
from __future__ import annotations

import datetime as dt
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
QUEUE = REPO / "research" / "governance" / "skeleton" / "legal-decisions-v1.json"

#: 棘轮：现状值。**2026-09-22 实测**（`python3 tools/verify_open_items.py` 自己算出来的）：
#: `$decision_queue` 里 `status == "open"` 的 **5** 条 = Q23 Q24 Q25 Q26 Q37。
#: 按 `AGENTS.md` §2.2 第 1 条 —— 这是**某时某刻的读数**，不是常量；重算方式是跑本脚本。
#:
#: ★ 2026-09-22 · 5 → 6 → 7 两次都是**故意抬的，而且抬的过程正是这条断言的用法**：
#:   Q38 = `.ua/` 的分级（Owner 已裁定选项 A 并落地）；Q39 = 418KB 压缩产物没有构建配方
#:   （ADR-0013 §三 的补记写了这件事，但**只在散文里** —— 没有任何东西会说它挂了几天、
#:   在等谁、沉默会发生什么，这正是 §2.4.2 那个形状往上浮了一层）。
#:   两次加完先跑本脚本，A3 都**当场变红**并打出「又开了题而没人看见」。
#:   棘轮只许减，所以「开新题」必须留下一次显式的动作：改这个常量。
#:   值改小（有人答完题）随时可以；改大要在这段注释里写清**为什么值得再开一道**。
#:
#: ★ **7 → 5（2026-09-22 同日）**：Q38 与 Q39 都被 Owner 答了，两条各自结案为
#:   `D39` / `D40`（`answered_at` / `answered_by` / `record` 齐备，`verify_engine_contract.py`
#:   的 V30b 会逐条查）。**这一格就是「棘轮只许减」在真实使用中的样子**：
#:   加的时候必须写清为什么（上面那段），减的时候只要真答完了就随时可以。
#:   ★ 顺带一处**本条立题时没想到的收益**：Q38/Q39 两条把「`$decision_queue` 里 open 项」
#:   当成了执行点，于是它们**必须**被真的答掉、真的记 `D#`，否则会一直挂在
#:   `python3 tools/verify_open_items.py` 的输出里带着天数 —— 这正是 §2.4.2 说的
#:   「承诺要有执行点」反过来的那一半：**待决事项也要有执行点**。
OPEN_RATCHET = 5

DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class Unreadable(Exception):
    """读不出 —— 落未测（退 2），不许当成「没有人在等」。"""


def read_open(today: dt.date) -> list:
    if not QUEUE.is_file():
        raise Unreadable(f"没有这个文件：{QUEUE}")
    try:
        d = json.loads(QUEUE.read_text(encoding="utf-8"))
    except Exception as e:  # noqa: BLE001
        raise Unreadable(f"{QUEUE} 不是合法 JSON：{e}")
    q = d.get("$decision_queue")
    if not isinstance(q, list) or not q:
        raise Unreadable("`$decision_queue` 读不出或为空 —— 口径可能改了，按未测处理")
    return q


def judge(queue: list, today: dt.date) -> dict:
    """纯函数：`--controls` 直接喂它内存样本（§2.1：反向对照只在内存里做）。"""
    problems, rows = [], []
    opens = [x for x in queue if isinstance(x, dict) and x.get("status") == "open"]

    for it in opens:
        qid, title = it.get("id", "?"), it.get("title", "")
        raw = it.get("raised_at")
        age = None
        if not raw or not DATE.match(str(raw)):
            problems.append(f"A1 {qid}：`raised_at` 缺失或不是 YYYY-MM-DD（读到 {raw!r}）—— 那就算不出等了多久")
        else:
            raised = dt.date.fromisoformat(raw)
            if raised > today:
                problems.append(f"A1 {qid}：`raised_at` = {raw} 在**未来** —— 悬置天数会是负数，这不是读数")
            else:
                age = (today - raised).days

        if not it.get("owner"):
            problems.append(f"A2 {qid}：没有 `owner` —— 不知道在等谁")
        if not it.get("default_if_unanswered"):
            problems.append(f"A2 {qid}：没有 `default_if_unanswered` —— 沉默会发生什么没写下来")
        rows.append({"id": qid, "age": age, "raised_at": raw,
                     "owner": it.get("owner", ""), "title": title})

    if len(opens) > OPEN_RATCHET:
        problems.append(f"A3 未决项 {len(opens)} 条 > 棘轮 {OPEN_RATCHET} —— 又开了题而没人看见；"
                        f"若是有意为之，改 `OPEN_RATCHET` 并在注释里写清新读数")

    rows.sort(key=lambda r: (-(r["age"] if r["age"] is not None else -1), r["id"]))
    return {"problems": problems, "rows": rows, "n": len(opens)}


def controls() -> int:
    T = dt.date(2026, 9, 22)
    good = [{"id": "Q23", "status": "open", "raised_at": "2026-09-17",
             "owner": "法务（经 Owner 转达）", "default_if_unanswered": "沉默 = 选项 C", "title": "x"}]

    def red(q):
        return bool(judge(q, T)["problems"])

    cases = [
        ("正样本：齐备的 open 项 → 必须绿", lambda: not red(good)),
        ("★ 坏样本：缺 `raised_at` → 必须红（算不出等了多久）",
         lambda: red([{**good[0], "raised_at": None}])),
        ("坏样本：`raised_at` 在未来 → 必须红（不是读数）",
         lambda: red([{**good[0], "raised_at": "2099-01-01"}])),
        ("坏样本：缺 `default_if_unanswered` → 必须红（沉默的后果没写下来）",
         lambda: red([{**good[0], "default_if_unanswered": None}])),
        ("坏样本：缺 `owner` → 必须红（不知道在等谁）",
         lambda: red([{**good[0], "owner": None}])),
        ("坏样本：open 项超过棘轮 → 必须红",
         lambda: red([{**good[0], "id": f"Q{i}"} for i in range(OPEN_RATCHET + 1)])),
        ("反向对照：把超棘轮那批减到棘轮以内 → 必须重新变绿（上面那条不是恒红）",
         lambda: not red([{**good[0], "id": f"Q{i}"} for i in range(OPEN_RATCHET)])),
        ("★ 反向对照：天数**真的**在算（09-17 → 09-22 必须是 5，不是 0）",
         lambda: judge(good, T)["rows"][0]["age"] == 5),
    ]
    bad = 0
    print("=" * 72)
    print("未决项「等了多久」· 反向对照（离线；不动盘、不联网）")
    print("=" * 72)
    for i, (name, fn) in enumerate(cases, 1):
        try:
            ok, err = bool(fn()), ""
        except Exception as e:  # noqa: BLE001
            ok, err = False, f"（抛异常 {type(e).__name__}: {e}）"
        if not ok:
            bad += 1
        print(f"  {'✅' if ok else '❌'} [{i}/{len(cases)}] {name}{err}")
    print("-" * 72)
    if bad:
        print(f"❌ {len(cases)} 项中 {bad} 项失败 —— 判据有问题，别信它")
        return 1
    print(f"✅ {len(cases)} 项全过（含「该红时红」与「该绿时绿」两侧）")
    return 0


def main(argv: list[str]) -> int:
    if "--controls" in argv:
        return controls()
    today = dt.date.today()
    for a in argv:
        if a.startswith("--today="):
            today = dt.date.fromisoformat(a.split("=", 1)[1])
    try:
        queue = read_open(today)
    except Unreadable as e:
        print(f"⚠️ 未测：{e}")
        print("   这不是「没有人在等」，是**这次没读成** —— 退 2。")
        return 2

    r = judge(queue, today)
    print("=" * 72)
    print(f"现在有几件事在等人 · 基准日 {today}（`--today=` 可注入）")
    print("=" * 72)
    print(f"  `$decision_queue` 里 open 项 **{r['n']}** 条（棘轮 {OPEN_RATCHET}）")
    print()
    for row in r["rows"]:
        age = "天数【未测】" if row["age"] is None else f"已悬置 **{row['age']} 天**"
        print(f"  · {row['id']}  {age}（{row['raised_at']}）  等：{row['owner']}")
        print(f"      {row['title']}")
    print()
    if r["problems"]:
        print(f"── 有问题 {len(r['problems'])} 处 ──")
        for p in r["problems"]:
            print(f"  ❌ {p}")
        return 1
    print("✅ 每条未决项都指得出「等了多久、在等谁、沉默会发生什么」")
    print("   ⚠️ 本脚本**不判红「悬置太久」**：沉默的后果已经写在 `default_if_unanswered` 里，")
    print("      它是一个已写下来的答案，不是疏忽。给天数设阈值等于替 Owner 定它没定过的政策。")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

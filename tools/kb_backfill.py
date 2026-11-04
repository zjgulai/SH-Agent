#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""kb_backfill.py —— 回填通道：复核结论 → 新条目 / 修正条目（T9）

## 它治的病

PRD §9 写的是「**人工复核结论回流知识库，更新规则权重和正负样本**」，
§10 的统计表里有一项叫「**知识库回流数量**」。
而在本文件之前，这一项**算不出来** —— 不是因为它是 0，是因为**没有落点**：
盘上没有任何地方记着「哪一条人的判定与引擎不一致」，于是那个数既不是 0 也不是 N，
它是一个**答不了的问题**。

## 口径：只把**源表那一侧的判定**算「人的判定」（2026-09-23 委托方裁定）

这是本模块唯一的口径，写在最前面，因为它决定了那个数是什么：

| 谁是「人的判定」 | 谁是「机器的」 |
|---|---|
| **源表**那一侧的列：`风险等级` / `处理状态` / `命中规则` / `命中片段` / `命中原因` / `检查人` —— 业务方在源表上写下的记录 | 新引擎的判定（`severity` / 处置层 / 命中规则） |

**★ 原因码只作附注，不参与「这条算不算回流」的判定。**
`_data/迁移保真度.json` 的 `轴3_分歧逐行` 里，每一条分歧都带一个原因码
（「语料缺口」「引擎新增检出」「触发物被改归属」…）—— 那些是**我方机器派生的推断**。
把推断记成「人的结论」，正是 `AGENTS.md` §2.4.3 点名的那个病：
**说出去的话比手上的依据大。** 所以它落在 `附注` 里，逐字标明「机器推断」。

## ★★ 边界：这叫「源表判定」，**不叫「复核结论」**

这一条必须写在纸面上，因为差一个字就是一次误读：

* 源表的 `处理状态` 列**逐行照抄**进本账 —— **多数写着「待人工复核」**，`检查人` 列**为空**。
  也就是说：**这条记录上还没有一次完成的人工复核**。
* 所以本账记的是「**源表记下的判定** 与 **引擎判定** 的分歧」，
  **不是**「法务/复核人的结论」。PRD §9 要的是后者，那要等真有人复核（T8 的 `检查人` 填起来）。
* **两个数永远分开报**（§2.4.3：能把「送得出去」与「已经送过」合并的人，就会把它们合并）：
  * `回流事件` = 本账行数（今天 **13**）—— PRD §10 的那个数；
  * `已落到条目` = `去向` 不是「待定」的行数（今天 **0**）。

  ★ **`去向` 由人定，不由本模块定。** 一条分歧该变成「新条目」还是「修正条目」，
  是人的判断；机器只能把它列出来、指回源表那一行。写一个规则自动判去向，
  就是拿机器的推断冒充人的结论 —— 同 §2.4.3。

## 三条设计约束（每条对应本项目踩过的坑）

1. **已有的行不许被重建抹掉，但「已不再分歧」的行必须离开主账。**
   ★ 2026-09-23 更正（Q25 落地时撞出来的）：原先这里写的是「**只增不删** …… 消失的行不删
   （它曾经发生过）」。它与 T9b 的判据**不可能同时成立** —— T9b 要求
   「账上条数 ≡ 源表列 vs 引擎列不一致的行数」，而引擎一改，重算数就会变小（实测 13 → 10），
   于是工具**达不到自己验收器要求的那个状态**。
   正确的口径：这本账是**派生量**（「现在有哪些分歧」），不是事件史 ——
   「发生过」的是**人做过那次复核**，不是**那次分歧**。所以：
     · 已有行的 `首次出现` / `次数` / **人写过的 `去向`** 一律保留（重建不许抹掉人的东西）；
     · 已不再分歧的行**移出主账**，但**不销毁** —— 追加进 `research/kb/回流-撤销-v1.jsonl`
       并写明撤销时刻与原因（`receipts.LOSS.md` 的老规矩：丢了就留一份成文的记录）；
     · ★ 若待撤销的行**有非默认 `去向`**（有人写过），**拒绝重建并退 2** ——
       那种行不能用「引擎算不出来了」当理由丢掉。
2. **逐行可回查。** 每条都带 `记录`（`records.json` 的行号）与源表原话 ——
   读者不需要相信本模块的转述，他可以自己去翻那一行。
3. **`--today=` 是 dry-run，不落盘。** （`AGENTS.md` §2.4.4：看一眼前提不能改掉将来要发生的事。）

用法：
  python3 tools/kb_backfill.py --stats          # 只读读数（PRD §10 那个数在这里）
  python3 tools/kb_backfill.py --rebuild        # 重建（幂等；只增不删）
  python3 tools/kb_backfill.py --pending        # 只列「去向待定」的那些（只读）
"""

from __future__ import annotations

import argparse
import json
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKEL = os.path.join(REPO, "research", "governance", "skeleton")
KB = os.path.join(REPO, "research", "kb")

FIDELITY = os.path.join(SKEL, "_data", "迁移保真度.json")
RECORDS = os.path.join(SKEL, "_data", "records.json")
LEDGER = os.path.join(KB, "回流-v1.jsonl")
#: ★ 2026-09-23：已不再分歧的行**移出主账但不销毁**，追加到这里并写明撤销时刻与原因。
REVOKED = os.path.join(KB, "回流-撤销-v1.jsonl")

#: `去向` 的取值域（枚举，不许自由字符串 —— 与 origin 四档、原因码同一条规矩）。
#: 「待定」是**默认值**，也是今天**唯一**用到的值：定去向是人的动作。
TARGETS = ("新条目", "修正条目", "规则权重", "正负样本", "待定")

#: 源表那一侧，本账认为属于「人的判定」的列。**逐个点名**，不用模糊匹配 ——
#: 多带一列进来，就等于把一列机器派生值记成人的结论（§2.4.3）。
SRC_COLS = ("风险等级", "处理状态", "命中规则", "命中片段", "命中原因", "检查人")


def _read_jsonl(p):
    rows = []
    if os.path.exists(p):
        for ln in open(p, encoding="utf-8").read().splitlines():
            if ln.strip():
                rows.append(json.loads(ln))
    return rows


def _write_jsonl(p, rows):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False, sort_keys=False) + "\n")


def _records():
    doc = json.load(open(RECORDS, encoding="utf-8"))
    return doc if isinstance(doc, list) else (doc.get("records") or doc.get("rows") or [])


def derived_rows():
    """**重算**当前应有哪几条回流事件。返回 `[{…}]`（不含 `首次出现`/`次数`）。

    ★ 判据 T9c 就是拿它与盘上的账逐行比 —— 所以「回流数量」是一个**算得出来的数**，
      不是记得住的数（`AGENTS.md` §2.2 第 1 条）。
    """
    fid = json.load(open(FIDELITY, encoding="utf-8"))
    recs = _records()
    out = []
    for d in (fid.get("轴3_分歧逐行") or []):
        i = d.get("i")
        r = recs[i] if isinstance(i, int) and 0 <= i < len(recs) else {}
        src = {c: r.get(c) for c in SRC_COLS}
        kinds = []
        for x in (d.get("源表有引擎无") or []):
            kinds.append(f"源表有引擎无：{x.get('原因')}")
        for x in (d.get("引擎有源表无") or []):
            kinds.append(f"引擎有源表无：{x.get('原因')}")
        out.append({
            "记录": i,
            "广告名称": d.get("广告名称"),
            "平台": d.get("平台"),
            "投放USD": d.get("投放USD"),
            "源表判定": dict(
                {"来源": "源表（业务方记录，**不是**法务复核结论）"}, **src),
            "引擎判定": {
                "命中规则": d.get("引擎_命中"),
                "severity": d.get("引擎_severity"),
                "处置层": d.get("引擎_处置层"),
            },
            "分歧": ("源表有引擎无" if d.get("源表有引擎无")
                     else ("引擎有源表无" if d.get("引擎有源表无") else "双向")),
            "附注": {
                "机器推断的原因码": kinds,
                "$note": ("原因码是**我方机器派生的推断**，不是人的结论 —— "
                          "它只作附注，不参与「这条算不算回流」的判定。"
                          "「源表判定」那六列才是源表上写下的原话。"),
            },
            "去向": "待定",
            "$去向_note": ("定去向是人的动作：这条分歧该变成「新条目」还是「修正条目」，"
                           "机器只能把它列出来、指回源表那一行。"),
        })
    out.sort(key=lambda x: (x["记录"] if isinstance(x["记录"], int) else 10 ** 9))
    return out


def merge(old_rows, new_rows, today):
    """已有的保留 `首次出现` 并 `次数+1`；新的记 `首次出现=today`；
    消失的**移出主账、记进撤销账**（见抬头第 1 条 2026-09-23 的更正）。"""
    key = lambda r: (r.get("记录"), r.get("分歧"))
    old = {key(r): r for r in old_rows}
    out = []
    for r in new_rows:
        prev = old.pop(key(r), None)
        row = dict(r)
        row["首次出现"] = (prev or {}).get("首次出现") or today
        row["次数"] = int((prev or {}).get("次数") or 0) + 1
        row["最近一次"] = today
        # 去向**不重算** —— 它是人写进去的，重建不许把它抹回「待定」。
        row["去向"] = (prev or {}).get("去向") or r.get("去向") or "待定"
        if (prev or {}).get("$去向_note"):
            row["$去向_note"] = prev["$去向_note"]
        out.append(row)
    # ★ 2026-09-23：已消失的行不再留在主账里 —— 它们进撤销账（有人写过去向的会被上面挡住）。
    dropped = [r for r in old_rows if key(r) in old]
    return out, dropped


def load_ledger():
    return _read_jsonl(LEDGER)


def _write_jsonl(path, rows):
    """追加写（撤销账）或覆盖写（主账）—— 两者都走这里，保证格式一致。"""
    with open(path, "a" if path == REVOKED else "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")


def counts(rows):
    """★ 两个数**分开**：发生过的回流事件 · 已经落到条目里的。"""
    ev = len(rows)
    landed = [r for r in rows if str(r.get("去向") or "待定") != "待定"]
    return {
        "回流事件": ev,
        "去向待定": ev - len(landed),
        "已落到条目": len(landed),
        "涉及投放USD": round(sum(float(r.get("投放USD") or 0) for r in rows), 2),
        "去向往返": {t: sum(1 for r in rows if str(r.get("去向")) == t) for t in TARGETS},
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="回填通道：复核结论 → 新条目/修正条目（T9）")
    ap.add_argument("--stats", action="store_true", help="只读读数（PRD §10 的「知识库回流数量」）")
    ap.add_argument("--rebuild", action="store_true", help="重建账本（幂等；只增不删）")
    ap.add_argument("--pending", action="store_true", help="只列「去向待定」的那些（只读）")
    ap.add_argument("--today", default=None, help="注入今天（YYYY-MM-DD）；**只影响重建，不自动落盘**")
    a = ap.parse_args()

    new = derived_rows()
    old = load_ledger()
    today = a.today or __import__("datetime").date.today().isoformat()

    if a.rebuild:
        rows, dropped = merge(old, new, today)
        # ★ 2026-09-23：待撤销的行里只要有一条**有人写过的去向**，就拒绝重建 ——
        #   「引擎算不出来了」不是丢掉人的结论的理由。
        human = [r for r in dropped if str(r.get("去向") or "待定") != "待定"]
        if human:
            print(f"❌ 拒绝重建：{len(human)} 行已不再分歧，但它们的 `去向` 是人写过的 ——")
            for r in human:
                print(f"   · 记录#{r.get('记录')} {r.get('分歧')} → 去向「{r.get('去向')}」")
            print("   处置：这些行的结论**仍然成立**（人做过那次复核），所以它们不该被引擎的改动带走。")
            print("   要么把它们并入知识库条目/规则，要么明确写出为什么作废 —— 但不能只因为重算不出来就删。")
            return 2
        if dropped:
            _write_jsonl(REVOKED, [dict(r, **{"$撤销于": today,
                                               "$撤销原因": "引擎修正后不再分歧（该行是派生量，不是事件史）"})
                                   for r in dropped])
            print(f"  ↳ {len(dropped)} 行已不再分歧 → 移出主账，记入 "
                  f"{os.path.relpath(REVOKED, REPO)}（不销毁）")
        _write_jsonl(LEDGER, rows)
        print(f"✓ 已写 {os.path.relpath(LEDGER, REPO)}：{len(rows)} 行"
              f"（重算应有 {len(new)} 条，账上原有 {len(old)} 条）")
        print(json.dumps(counts(rows), ensure_ascii=False))
        return 0

    rows = old or merge([], new, today)[0]      # ★ merge 现在返回 (rows, dropped)
    c = counts(rows)
    if a.pending:
        for r in rows:
            if str(r.get("去向") or "待定") == "待定":
                sd = r.get("源表判定") or {}
                print(f"  BF 记录#{r.get('记录')} {r.get('分歧')} · "
                      f"源表 {sd.get('命中规则')} / {sd.get('处理状态')} · "
                      f"引擎 {(r.get('引擎判定') or {}).get('命中规则')}")
        print(f"—— 去向待定 {c['去向待定']} 条 / 共 {c['回流事件']} 条")
        return 0
    if a.stats or not (a.pending or a.rebuild):
        print(f"回填通道（T9）· 账本 {os.path.relpath(LEDGER, REPO)}")
        print(f"  **回流事件 {c['回流事件']} 条**（PRD §10 的「知识库回流数量」就是这个数）"
              f" · 涉及投放 USD {c['涉及投放USD']:,.2f}")
        print(f"  去向待定 {c['去向待定']} 条 · **已落到条目 {c['已落到条目']} 条** "
              f"← 两个数分开报，不许合并")
        print(f"  ★ 口径：源表那一侧的判定算「人的判定」；原因码只作附注。"
              f"源表 `处理状态` 逐行照抄 —— 多数写着「待人工复核」，`检查人` 为空。")
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())

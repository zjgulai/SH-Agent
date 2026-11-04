#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
_ingest_batch12.py —— 第十二批入库：Q36 裁定 → D38，并把「编号空间」做成单一登记处

## 本批入库三件事

1. **Q36 裁定入队**（Owner 选 A）→ 新增决定 **D38**。ADR-0013 的局部决策编号已由
   `tools/_migrate_ids_batch12.py` 就地加 `ADR13-` 前缀（58 处 / 18 个号）。

2. **`$id_aliases`**：D34 裁定的「单一编号空间」落地形态。它登记**每一个编号空间**
   （谁产的、在哪份制品、`renamed_from` 是什么）**以及每一件 ADR `遗留` 事项**。
   ★ 别名唯一性是它能成立的前提 —— 而实测 ADR-0013 的 `遗留 6/7/8/9/10` 各指两件事
   （见 `_data/遗留对账.json` 的① 类）。所以这 5 个号在本登记处必须**带表域限定**：
   `遗留 6@五` 与 `遗留 6@8.5` 是两件事。**号本身不动** —— Owner 已按号读过并据此裁定，
   动号会让那些裁定悬空。要不要改号另立 **Q37**。

3. **批次标签对账**：实测台账 `$artifact` 的 `B#` 与讨论稿 §八 的表**两处矛盾** ——
   `D31`（K0 项目空间）写 `B4/B6`、表里是 `B7`；`D35`（K8 评测）写 `B7`、表里是 `B6`；
   `D29` 的制品「9 库定义表」在表的 `B4` 行里没有出现。本批把台账侧对齐到表
   （表是执行计划，决定写在表之前，故表为准），并新增 V31c 双向对账守它。

用法：
  python3 tools/_ingest_batch12.py            # 预演
  python3 tools/_ingest_batch12.py --write    # 落盘
"""

import json
import os
import re
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LED = os.path.join(REPO, "research", "governance", "skeleton", "legal-decisions-v1.json")
RECON = os.path.join(REPO, "research", "governance", "skeleton", "_data", "遗留对账.json")
PLAN = os.path.join(REPO, "PMO", "守衡-创建全景图与知识库体系-讨论稿-v1.md")

NOW = "2026-09-17"

# ── §八 的表：批次 → 它承接的决定（人读表；这里只抄「决定↔批次」这一列） ──
PLAN_BATCH_OF = {          # 决定号 → 讨论稿 §八 表里它落在哪个批次
    "D29": "B4", "D30": "B4",
    "D31": "B7",            # 表：B7 决策层 = K6 + K0 成库（Q29=C / Q32=A）
    "D32": "B5", "D33": "B5'",
    "D34": "B7",            # 表：B7 = 三套 ID 合并
    "D35": "B6",            # 表：B6 评测层 = K8 起手（Q33=A）
    "D36": "B9",
}

BATCH12_NOTE = (
    "★ 2026-09-17 第十二批（D38 · Q36 裁定 → ADR-0013 编号收口）：ADR-0013 的局部决策编号"
    "（`§一 D1–D9` / `§8.2 D22–D26` / `§10 D27–D30`）就地加 `ADR13-` 前缀，**58 处 / 18 个号**，"
    "台账 `D#` 一字未动。★ 裁定前的实测比初稿宽：ADR-0013 里裸写的 `D#` 不是「两义」而是**四义**"
    "（局部决策 / 台账 / 旧缺口号 / 旧检查编号引文），所以排除表**按引用给不按文件给** —— "
    "同一个文件里四种含义并存，文件级排除必然改错。★ **一处必须写下来的落差**：Q36=A 声明的收益是"
    "「裸写的 `D#` 只可能是台账」，实测**达不到** —— 改完之后 ADR-0013 里仍有 20 处裸 `D#`，"
    "它们是台账引用与历史叙述，**不该改**（改历史叙述等于把叙述改成假话）。所以收益降级成一句带白名单的话，"
    "白名单进判据（V31a）而不是留在迁移脚本的注释里。**恒真的全称句会被下一个人当成真的用。**"
    "★ `遗留#` 同批收口：实测 **11 张表 / 52 行 / 40 个号 → 38 件真实事项**（四类关系：撞号异义 5 个号、"
    "状态冲突 2 件、异号同义 6 组、源文件自述「已并入」1 处）。**号不动**（Owner 已按号读过并据此裁定），"
    "改为在表内标出哪个 `6` 是哪个 + 别名带表域限定进 `$id_aliases`；改号另立 **Q37**。"
    "★ 顺带对出**批次标签两处矛盾**（`D31` 写 B4/B6↔表 B7、`D35` 写 B7↔表 B6），已对齐并新增 V31c 双向对账。"
    "★ 未决项会随作答而增加，这是机制在正常工作，不是没做完。"
)


def alias_of(item, coll):
    """一件 ADR 遗留事项的别名列表。撞号的号必须带表域限定。

    ★ 抽成「吃两个参数」而不是读模块全局：判据（V46 组）要用**同一份**逻辑现算别名
      去和登记处比。若判据里再抄一份，两份就会漂 —— 而漂掉的那一份读起来同样像一个结论。
    """
    coll = set(coll)
    out = []
    for n in item["numbers"]:
        if n in coll:
            # 用**本行所在节的短名**做域。★ 节名有两种形态：
            #   `五、遗留`（§五 主表）与 `8.5 落进 §五「遗留」`（各节落点表）。
            #   第一版只做了 split()[0]，于是 §五 的域取成了整段「五、遗留」——
            #   别名本身是唯一的，所以自检不会红，但读起来是个错名字。
            #   **唯一性检查抓不住「名字取错但恰好不重复」**，只能靠读产物发现。
            secs = {o["section"].split()[0].split("、")[0].lstrip("§")
                    for o in item["occurrences"] if o["num"] == n}
            for s in sorted(secs):
                out.append(f"遗留 {n}@{s}")
        else:
            out.append(f"遗留 {n}")
    return out


def main():
    write = "--write" in sys.argv
    global RECON_DOC
    RECON_DOC = json.load(open(RECON, encoding="utf-8"))
    led = json.load(open(LED, encoding="utf-8"))

    # ── 1. Q36 → answered，新增 D38 ───────────────────────────────────
    q36 = next(q for q in led["$decision_queue"] if q["id"] == "Q36")
    if q36.get("status") != "answered":
        q36["status"] = "answered"
        q36["answer"] = ("A —— ADR-0013 的局部决策编号就地加自己的前缀（`ADR13-D#`），"
                         "台账 `D#` 保持原义")
        q36["answered_by"] = "Owner"
        q36["answered_at"] = NOW
        q36["record"] = "legal-decisions-v1.json · D38"

    if not any(d["id"] == "D38" for d in led["decisions"]):
        led["decisions"].append({
            "id": "D38",
            "line": "repo",
            "asked_at": NOW,
            "question": "Q36：ADR-0013 自带一套局部决策编号（实测 22 个号 / 79 处，其中 20 个与台账同号不同物）怎么处置",
            "answer": "**选 A：ADR-0013 的局部决策编号就地加自己的前缀（`ADR13-D#`），台账 `D#` 保持原义、一字不动。**",
            "answered_by": "Owner",
            "answered_at": NOW,
            "effect": ("ADR-0013 里 58 处引用被就地改写（18 个号：`D1`–`D9`、`D22`–`D30`）；"
                       "`§一` 的 9 条标题定义、`§8.2` 的 5 行表格、`§10` 的 `D27`–`D30`、"
                       "以及散在正文与异议留档里的回指全部同批改。**引文不改** —— "
                       "`§15` 里逐字引用的当年那段检查代码 `c.add(\"D2\", …)` 与当年那几次运行的"
                       "缺口号 `D1`/`D7`/`D8`/`D99` 一律保留原样：改它们会把叙述改成假话。"),
            "quantified_consequence": ("实测：ADR-0013 里裸写的 `D#` **不是两义而是四义** —— "
                                       "① 本 ADR 的局部决策 ② 台账决定（`D13`/`D14`）"
                                       "③ 旧缺口编号（§15 的 `D1`/`D7`/`D8`/`D99`）"
                                       "④ 旧检查编号引文（§15 的 `D2`/`D3`）。"
                                       "改掉 ① 之后仍留 **20 处**裸 `D#`。"),
            "accepted_risk": ("★ **Q36 选项 A 声明的收益达不到它字面上的样子。** 它写的是"
                              "「改完之后全仓裸写的 `D#`/`Q#` 只可能是台账」，而 ②③④ 那 20 处"
                              "既不该改、又确实存在。所以本条的到货形态只能是一句**带白名单的话**："
                              "「裸写的 `D#` 要么是台账，要么逐条列在白名单里，每条写明它凭什么例外。」"
                              "白名单进了判据（`verify_engine_contract.py` 的 V31a，带反向对照），"
                              "不是留在迁移脚本里的一句注释 —— 恒真的全称句会被下一个人当成真的用。"
                              "★ 另一处代价：`遗留#` 的撞号（`6/7/8/9/10` 各指两件事）**没在号上解决**，"
                              "只在表内加了标记、在别名里加了表域限定。理由是 §五 的注写着"
                              "「本轮不改号（Owner 已按 6 号读过并据此裁定）」—— 动号会让那些裁定悬空。"
                              "改号与否另立 **Q37**。"),
            "changed_artifacts": [
                "ADR/ADR-0013-基座接口冻结与仓库入库分级.md",
                "research/governance/skeleton/legal-decisions-v1.json",
                "research/governance/skeleton/_data/遗留对账.json",
                "research/governance/skeleton/_data/遗留对账.md",
                "tools/_migrate_ids_batch12.py",
                "tools/_recon_legacy.py",
                "tools/_rc_d38.py",
                "tools/verify_engine_contract.py",
            ],
            "verification": ("python3 tools/verify_engine_contract.py --only V31 && "
                             "python3 tools/_rc_d38.py && python3 tools/verify_kb.py"),
            "$artifact": ("本次迁移**已落地**。★ 但它没有拿到选项 A 字面上的收益（见 `accepted_risk`）——"
                          "本条不声称「裸 `D#` 只剩台账一义」，只声称「裸 `D#` 逐条落在白名单里」。"
                          "★ `遗留#` 的号**未改**，只加了表内标记与带域别名；改号是 **Q37**。"),
        })

    # ── 2. 批次标签对齐（台账侧，表为准） ────────────────────────────
    fixed = []
    for d in led["decisions"]:
        want = PLAN_BATCH_OF.get(d["id"])
        if not want:
            continue
        art = d.get("$artifact", "")
        cur = re.findall(r"\bB\d+'?", art)
        if cur and want not in cur:
            fixed.append({"id": d["id"], "from": cur, "to": want, "old": art[:60]})
            d["$artifact"] = re.sub(r"\bB\d+'?", want, art, count=len(cur))

    # ── 3. 单一编号空间 $id_aliases ──────────────────────────────────
    entries = []
    for it in RECON_DOC["items"]:
        al = alias_of(it, RECON_DOC["collide_numbers"])
        entries.append({
            "id": al[0],
            "aliases": al,
            "kind": "adr_legacy",
            "status": "closed" if it["closed"] else "open",
            "owner": it["occurrences"][0]["owner"],
            "artifact": "ADR/ADR-0013-基座接口冻结与仓库入库分级.md",
            "lines": [o["line"] for o in it["occurrences"]],
            "key": it["key"][:48],
            "declared_merged_into": it["merged_into"],
            "status_conflict": it["status_conflict"],
        })
    entries.sort(key=lambda e: min(int(x.split()[1].split("@")[0]) for x in e["aliases"]))

    led["$id_aliases"] = {
        "$note": [
            "★ 本块是 D34 裁定的「单一编号空间」的落地形态：**一个登记处回答「本仓有几套编号、各指什么」**。",
            "★ 别名必须唯一 —— 一个别名指两件事就不叫别名。实测 ADR-0013 的 `遗留 6/7/8/9/10` 各指两件事，",
            "  故这 5 个号在本登记处带**表域限定**（`遗留 6@五` vs `遗留 6@8.5`）。号本身未动，见 D38 的 `accepted_risk`。",
            "★ `spaces` 记的是「谁产的编号」；`entries` 记的是 ADR `遗留` 那 38 件真实事项（由 `tools/_recon_legacy.py` 去重得出）。",
            "★ 检查：`verify_engine_contract.py` 的 V31b（别名唯一）· 计数：`python3 tools/decisions.py --owe`",
        ],
        "spaces": {
            "ledger_decision": {"prefix": "D#", "authority": "本台账 decisions[].id",
                                "artifact": "research/governance/skeleton/legal-decisions-v1.json"},
            "ledger_question": {"prefix": "Q#", "authority": "本台账 $decision_queue[].id",
                                "artifact": "research/governance/skeleton/legal-decisions-v1.json"},
            "adr13_local_decision": {"prefix": "ADR13-D#", "renamed_from": "D#",
                                     "artifact": "ADR/ADR-0013-基座接口冻结与仓库入库分级.md",
                                     "landed_by": "D38", "refs_rewritten": 58, "numbers": 18},
            "kb_gap": {"prefix": "KB-GAP-#", "renamed_from": "D#",
                       "artifact": "research/kb/缺口-v1.json", "landed_by": "D37"},
            "kb_golden_question": {"prefix": "KB-Q-#", "renamed_from": "Q#",
                                   "artifact": "research/kb/查询手册.md", "landed_by": "D37"},
            "kb_check": {"prefix": "KB-CHK-#", "renamed_from": "D#",
                         "artifact": "tools/verify_kb.py", "landed_by": "D37"},
            "adr_legacy_task": {"prefix": "遗留 #", "artifact": "ADR-0013 §五 + 各节落点表（11 张表）",
                                "renamed_from": None, "numbers": 40, "items": len(entries),
                                "note": "★ 号未改；撞号的 5 个号在本登记处带表域限定。"},
        },
        "entries": entries,
    }

    # ── 4. 队列批次记录 ──────────────────────────────────────────────
    note = led["$decision_queue_note"]
    if not any("第十二批" in s for s in note):
        note.append(BATCH12_NOTE)

    # ── 自检 ────────────────────────────────────────────────────────
    bad = []
    seen = {}
    for e in entries:
        for a in e["aliases"]:
            if a in seen:
                bad.append(f"别名 {a} 同时指 {seen[a]} 与 {e['id']}")
            seen[a] = e["id"]
    ids = [q["id"] for q in led["$decision_queue"]]
    nums = [int(x[1:]) for x in ids]
    if len(ids) != len(set(ids)) or nums != list(range(1, len(nums) + 1)):
        bad.append("队列编号不唯一/不连续")
    if q36.get("record", "").split("· ")[-1] not in {d["id"] for d in led["decisions"]}:
        bad.append("Q36 回指的决定不存在")

    print(f"Q36 → {q36.get('status')} · 回指 {q36.get('record')}")
    print(f"决定数 {len(led['decisions'])}（新增 D38）· 队列 {len(ids)} 项（{ids[0]}–{ids[-1]}）")
    print(f"批次标签修正 {len(fixed)} 处：" + ("、".join(f"{f['id']} {f['from']}→{f['to']}" for f in fixed) or "无"))
    print(f"$id_aliases：{len(led['$id_aliases']['spaces'])} 个编号空间 · {len(entries)} 件 ADR 遗留事项"
          f"（未关闭 {sum(1 for e in entries if e['status']=='open')}）")
    print(f"别名总数 {len(seen)} · 冲突 {len(bad)}")
    if bad:
        print("❌ " + "；".join(bad))
        return 1
    print("✅ 自检通过（别名唯一 · 队列连续 · 回指不悬空）")

    if not write:
        print("\n（预演，未写盘。加 --write 落盘）")
        return 0
    with open(LED, "w", encoding="utf-8") as f:
        json.dump(led, f, ensure_ascii=False, indent=1)
        f.write("\n")
    print(f"\n✅ 已写盘 {os.path.relpath(LED, REPO)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

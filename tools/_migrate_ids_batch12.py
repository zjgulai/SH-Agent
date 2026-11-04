#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
_migrate_ids_batch12.py —— 第十二批 · ADR-0013 编号收口（Q36 裁定 A → D38）

## 做两件事，都不改号的含义，只改号的样子

12.1  ADR-0013 的**局部决策编号** `D1–D9` / `D22–D30` 加 `ADR13-` 前缀。
12.2  §五「遗留」里 5 个**撞号行**加表内限定标记（不改号本身，理由见下）。

## 为什么局部号要加前缀：Q36 裁定 A

裁定前的实测比初稿宽：ADR-0013 里裸写的 `D#` 不是「两义」，是**四义** ——

  ① 本 ADR 的局部决策（`§一 D1–D9`、`§8.2 D22–D26`、`§10 D27–D30`）
  ② 台账决定（`（D14）` 指「回执走哪条渠道」、`（D13）` 指「ESC-002 升级面」）
  ③ 旧**缺口**编号（§15 里讲当年那几次运行：`D1`/`D7`/`D8`/`D99`）
  ④ 旧**检查**编号引文（§15 里逐字引用当年那段代码：`c.add("D2", …)`）

所以本脚本的排除表**按引用给，不按文件给** —— 同一个文件里四种含义并存，
文件级排除必然改错（这与 Q35 evidence ⑥ 的结论是同一条，只是换了个文件）。

## ★ 一处必须写下来的落差：Q36=A 声明的收益达不到

选项 A 的 `impact` 写：「改完之后全仓**裸写的 `D#`/`Q#` 只可能是台账**」。
实测：把 ①②③④ 里的 ① 改掉之后，ADR-0013 里**仍然有裸 `D#`** —— 就是 ②③④ 那 15 处。
它们**不该被改**（②是台账、③④是历史叙述，改了就把叙述改成假话），
但它们的存续意味着那句收益只能降级成一句**带白名单的话**：

  「裸写的 `D#` 要么是台账，要么逐条列在白名单里，白名单的每一条都写明它凭什么例外。」

白名单因此进了判据（`verify_engine_contract.py` 的 V31），不再只是本脚本里的一个注释。
**这是 Q36=A 的真到货形态，不是它的缩水版** —— 恒真的全称句会被下一个人当成真的用。

用法：
  python3 tools/_migrate_ids_batch12.py            # 预演，不写盘
  python3 tools/_migrate_ids_batch12.py --write    # 落盘
  python3 tools/_migrate_ids_batch12.py --verify   # 只核当前状态（幂等检查）
"""

import hashlib
import json
import os
import re
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ADR = os.path.join(REPO, "ADR", "ADR-0013-基座接口冻结与仓库入库分级.md")
PREFIX = "ADR13-"

BARE = re.compile(r"(?<![A-Za-z0-9_#\-])D(\d{1,3})(?![0-9\-])")
ALREADY = re.compile(r"(?<![A-Za-z0-9_#\-])ADR13-D(\d{1,3})(?![0-9\-])")

# ── 排除表：按**引用**给，**按内容锚定**（不是按行号）──────────────────
#    ★ 第一版是 `{行号: {token: 理由}}`。它在落地当天就坏了一次：D38 往 §五 的注里
#      插了 3 行，底下所有行号整体后移 —— **20 条白名单里有 2 条当场错位**，
#      而 V46a 立刻报了出来（`裸 D# 23 处 · 白名单 20 条 · 行232 D38`）。
#      判据本身没坏，坏的是「行号」这个锚 —— 它假设文件只有被改号时才会变。
#    ★ 所以锚改成 `(token, near)`：`near` 是该处**独有的一段原文**。行号怎么移都不影响，
#      而改号时 `near` 里的那个号本身就会对不上 → 一样报红。
#      （与 D37 那句「排除表必须按引用给，不能按文件给」是同一条纪律的延伸：
#        **按引用给，而且按引用锚。**）
WHITELIST = [
    # (token, near —— 该处独有的一段原文, 理由)
    ("D12", "ADR-0012 · D12 收拢", "ADR-0012 的 D12（那份 ADR 自己的决策号）"),
    ("D14", "（D14），广告组查不到人", "台账 D14「被机器拦下的回执走哪条渠道送达提交人」"),
    ("D2", 'c.add("D2", "缺口显式声明"', "旧 verify_kb 检查编号（当年那段代码的逐字引文）"),
    ("D2", "`D2` **永远绿**", "同上引文的说明"),
    ("D3", "`D3` 只检查「手册里有 ≥10 节」", "旧 verify_kb 检查编号（引文）"),
    ("D1", '`_gap_lines("D1")`', "旧缺口编号（讲当年那次运行）"),
    ("D7", "（现 2 条：D7 样例判读", "旧缺口编号"),
    ("D8", "D8 制品未建）", "旧缺口编号"),
    ("D1", "反向对照 RC1a 实测：D1→D99", "旧缺口编号（RC1a 反向对照的叙述）"),
    ("D99", "反向对照 RC1a 实测：D1→D99", "同上，构造出来的悬空号"),
    ("D1", "| RC1a | `Q7` 的登记编号 D1", "旧缺口编号（RC1a 表）"),
    ("D99", "| RC1a | `Q7` 的登记编号 D1", "同上"),
    ("D1", "篡改 `缺口-v1.json` 里 D1 的量", "旧缺口编号（RC2 表）"),
    ("D2", "✅ D2old 缺口显式声明", "旧检查编号的旧写法 D2old"),
    ("D2", "引用登记编号 ['D2', 'D99']", "旧缺口编号（RC1a 输出快照）"),
    ("D99", "引用登记编号 ['D2', 'D99']", "同上"),
    ("D13", "ESC-002 分层裁定（D13）", "台账 D13「ESC-002 的升级面」"),
    ("D7", "D7 原本声明「量不可重算", "旧缺口编号"),
    ("D8", "D8 也从「制品未建」改为可重算", "旧缺口编号"),
    # ↓ 这三个是本批自己写进去的**台账引用**（§五 的注 + 两处 遗留 25 的关闭说明）。
    #   它们是`D38` —— 台账第 38 条决定。**白名单必须跟着自己写的字长**，
    #   否则每写一次正文就多一处「未登记的裸号」，而那种红会被学会忽略。
    ("D38", "第十二批（D38）实测补记", "台账 D38（本批的决定，写进 §五 的注）"),
    ("D38", "→ **已关闭（第十二批 · D38）**", "台账 D38（两处 遗留 25 的关闭说明）"),
    ("D9", "**D9 的处置口径未定**",
     "★ 悬空：既不指本 ADR 的 D9（双指纹），也不指台账 D9（FDA registered）—— "
     "它指「157 条绿标逐行还原」，而台账里没有任何一条决定的 `changed_artifacts` "
     "点名 `源表口径-风险等级-变更请求.md`。"),
]

#    另有一处**不进白名单也不进改写**：`D1-O3`（ADR-0005 的门编号，不是决策号）。
#    它由正则的 `(?![0-9\-])` 在词法层排除 —— 所以既不出现在待改集合里，也不该进白名单
#    （白名单是「改不到的例外」，它是「根本不是一个号」）。第一版把它写进白名单，
#    自检立刻报「白名单未命中」—— 那条自检值钱：它把「排除」的两种成因分开了。


def sha(p):
    return hashlib.sha256(open(p, "rb").read()).hexdigest()


def scan(lines):
    """逐个裸 D# 定位，并判它是否被白名单按 (token, near) 锚住。"""
    out = []
    for i, l in enumerate(lines, 1):
        for m in BARE.finditer(l):
            tok = m.group(0)
            hit = next((w for w in WHITELIST if w[0] == tok and w[1] in l), None)
            out.append({"line": i, "col": m.start(), "token": tok,
                        "whitelisted": hit is not None,
                        "reason": hit[2] if hit else ""})
    return out


def migrate(lines):
    """返回 (新行, 改动清单)。幂等：已是 ADR13- 的不再动。"""
    changes = []
    for i, l in enumerate(lines, 1):
        out, last = [], 0
        for m in BARE.finditer(l):
            if any(w[0] == m.group(0) and w[1] in l for w in WHITELIST):
                continue
            out.append(l[last:m.start()])
            out.append(PREFIX + m.group(0))
            changes.append({"line": i, "from": m.group(0), "to": PREFIX + m.group(0),
                            "ctx": l[max(0, m.start() - 26):m.end() + 26].strip()})
            last = m.end()
        if out:
            out.append(l[last:])
            lines[i - 1] = "".join(out)
    return lines, changes


# ── 12.2：§五 撞号行的表内限定标记 ────────────────────────────────────
#   为什么**不改号**：§五 的 6–10 与 §8.5/§9.4/§10.6 的 6–10 撞号，
#   而 §五 的注里写着「本轮不改号（Owner 已按 6 号读过并据此裁定）」。
#   动号会让那些裁定悬空 —— 那正是 D37 三条自撞的同一种病。
#   所以本批只把「哪个 6 是哪个」**写进表里**，改号另立 Q37 由 Owner 定。
#   ★ 锚按**内容**给，不按行号 —— 行号锚在落地当天就因插注而整体后移过一次。
LEGACY_ANCHORS = [
    ("~~**`content_key` 的语义与实测不符**：隔日重抓约 70% 的页面换 key~~ → **已关闭**：Owner 裁定 **A**",
     6, "§8.5 的 `遗留 6`", "§五 的「content_key 语义」"),
    ("~~组装口径 A/B/C 定案~~", 6, "§五 的 `遗留 6`", "§8.5 的「组装口径 A/B/C」"),
    ("广告组的**跳①（平台 → 存量表）不可测**", 7, "§8.5 的 `遗留 7`", "§五 的「广告组跳①不可测」"),
    ("`covers` / `does_not_cover` 只有契约、无实现", 7, "§五 的 `遗留 7`", "§8.5 的「图片/视频 covers 无实现」"),
    ("「退化占位图」（1×1，2/120）算不算素材 —— 影响识别完整度与获取成功率的",
     8, "§8.5 的 `遗留 8`", "§五 的「退化占位图」"),
    ("`base/` 是新增顶层目录，其 L1 归属需并入", 8, "§五 的 `遗留 8`", "§8.5 的「base/ 的 L1 归属」"),
    ("**A 面的模块清单靠人维护**：没有任何检查在问", 9, "§9.4 的 `遗留 9`", "§五 的「A 面模块清单」"),
    ("`judge.py:220` 那句过时的话仍在源码里", 9, "§五 的 `遗留 9`", "§9.4 的「judge.py:220 那句过时的话」"),
    ("图片 OCR 的定位**再次下调**（无偏样本 40.0% · alt",
     10, "§10.6 的 `遗留 10`", "§五 的「图片 OCR 定位下调」"),
    ("**2 条无标识广告记录**", 10, "§五 的 `遗留 10`", "§10.6 的「2 条无标识广告记录」"),
]


def anchor_legacy(lines):
    """给 10 个撞号行加表内限定标记（markdown 注释，不改渲染）。按内容找行。"""
    added = []
    for near, num, other, self_ in LEGACY_ANCHORS:
        hits = [i for i, l in enumerate(lines, 1) if near in l]
        if len(hits) != 1:
            raise AssertionError(f"锚 {near[:30]!r} 命中 {len(hits)} 行（要求恰好 1 行）")
        i = hits[0]
        if "<!-- 遗留编号撞号：" in lines[i - 1]:
            continue
        lines[i - 1] = (lines[i - 1].rstrip()
                        + f" <!-- 遗留编号撞号：本行的 `{num}` 指 {self_}，"
                          f"不是 {other}。见 _data/遗留对账.json 与 Q37。 -->")
        added.append({"line": i, "num": num})
    return lines, added


def report():
    lines = open(ADR, encoding="utf-8").read().split("\n")
    refs = scan(lines)
    wl = [r for r in refs if r["whitelisted"]]
    rn = [r for r in refs if not r["whitelisted"]]
    already = len(ALREADY.findall("\n".join(lines)))
    return {
        "total_bare": len(refs),
        "to_rename": len(rn),
        "whitelisted": len(wl),
        "already_prefixed": already,
        "renumber_lines": sorted({r["line"] for r in rn}),
        "whitelist_hits": [{"line": r["line"], "token": r["token"], "reason": r["reason"]}
                           for r in wl],
        "whitelist_unused": [f"行{k} 的 {t}" for k, v in WHITELIST.items() for t in v
                             if not any(r["line"] == k and r["token"] == t for r in refs)],
    }


def main():
    write = "--write" in sys.argv
    before = sha(ADR)
    lines = open(ADR, encoding="utf-8").read().split("\n")

    lines, changes = migrate(lines)
    lines, added = anchor_legacy(lines)

    r = report.__wrapped__() if hasattr(report, "__wrapped__") else None
    # ↑ 不用装饰器，直接对**新**内容做自检
    text = "\n".join(lines)
    still = scan(lines)
    still_bare = [x for x in still if not x["whitelisted"]]
    wl_ok = all(x["whitelisted"] for x in still)

    print(f"待改 {len(changes)} 处 · 遗留标记 {len(added)} 行 · 白名单 {len(WHITELIST)} 条")
    if still_bare:
        print(f"❌ 仍有 {len(still_bare)} 处非白名单裸 D#：")
        for x in still_bare[:10]:
            print(f"   行{x['line']} {x['token']}")
    else:
        print("✅ 改完后所有裸 D# 逐条落在白名单里")
    _now = scan(open(ADR, encoding="utf-8").read().split("\n"))
    unused = [f"{t} @ {nr[:26]!r}" for t, nr, _ in WHITELIST
              if not any(x["token"] == t and x["whitelisted"] and nr in
                         open(ADR, encoding="utf-8").read().split("\n")[x["line"] - 1]
                         for x in _now)]
    print(f"白名单未命中：{unused or '无'}")

    if not write:
        print("\n（预演，未写盘。加 --write 落盘）")
        return 0
    if still_bare:
        print("\n❌ 自检未过，拒绝写盘。")
        return 1
    open(ADR, "w", encoding="utf-8").write(text + ("\n" if not text.endswith("\n") else ""))
    after = sha(ADR)
    print(f"\n✅ 已写盘 {os.path.relpath(ADR, REPO)}")
    print(f"   sha256 {before[:16]}… → {after[:16]}…")
    return 0


if __name__ == "__main__":
    sys.exit(main())

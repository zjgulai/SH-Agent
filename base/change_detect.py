#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""change_detect.py —— 「变没变」的**判据**（B2 · Owner 裁定 = A）

## 这个模块替换掉了什么

`ContentUnit.content_key` 的文档原本写着「只吃正文指纹 —— **页面重渲染后它不变**」，
而它要回答的是「这两次看到的是不是同一个东西」。B2 把这一问放到「隔一天」的尺度上
实测：**同一批页面重抓，约 70% 换了 key**（ADR-0013 §十三.8）。

三条修法里 Owner 裁定 **A**：

    判据从「**指纹变了**」改成「**声明集合变了**」。

本模块就是那条裁定的落地物，**只做一件事**：
给定两次观测的正文，回答「合规相关的声明集合变了没有、变成了什么」。

## ★★ 它答的不是「是不是同一个东西」—— 这是 A 的全部要点

`content_key` 现在答的是「**这是哪一版正文**」。两版不同 ≠ 内容变了，
更 ≠ 合规相关的东西变了。同一个页面隔一天抓两次，key 不同是**常态**
（评论数、价格、促销横幅都在动）。

    「key 变了没有」不是变更判据。变更判据是**声明集合的差集**。

本模块 [1] 组自证守的就是这条：**两个不同的 content_key，必须能被判成
「没有合规相关变化」** —— 而旧判据在这里会天天报假警（§13.8.2 的第一版判据
「变更段里含不含词形」几乎恒为真，因为它量的是「段里出现过」，而词形在两版里都在）。

## 三值结论，中间那一档才是 A 买来的东西

    ① 同一版正文              正文逐字节相同
    ② 换了版正文 · 声明未变   ★ 把 70% 的噪声滤掉的就是这一档
    ③ 换了版正文 · 声明已变   ★ 这一档才要报给人，且差集是「几个词」，不是 17,585 个字符

## 判据具名

判据名 `claim-set-v1` 随每份判定结果一起返回。理由与 `normalization.profile`、
`composition.profile` 完全相同：**一个结论离开它的判据就没有意义**。
判据换了（词表动了、抽法改了），旧结论就必须能跟着换掉 —— 见 `--replay`。

## 用法

    python3 base/change_detect.py --selftest
    python3 base/change_detect.py --replay research/landing/_evidence/stability.json
    python3 base/change_detect.py --old a.txt --new b.txt
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "tools"))

# ★ 词形**只此一份**：`tools/lp_extract.py` 是本项目唯一的词形来源。
#   这里再写一份的后果不是「重复」，是**两份会漂移**，而漂移的那一份
#   仍然会照常输出一个看起来完整的结论。B1 已经在同一件事上栽过一次
#   （§12.4：词表里两个词永远匹配不上，而报告照常打印）。
from lp_extract import CLAIM_PATTERNS, CLAIM_RE          # noqa: E402
import lp_extract as _X                                   # noqa: E402

JUDGE = "claim-set-v1"

# 三值结论的名字。用整数编号是为了让它们能被排序、能被写进 CSV 而不会走样。
V_SAME = "① 同一版正文"
V_NEW_NO_CLAIM = "② 换了版正文 · 声明未变"
V_NEW_CLAIM = "③ 换了版正文 · 声明已变"
VERDICTS = (V_SAME, V_NEW_NO_CLAIM, V_NEW_CLAIM)


def claim_source() -> dict:
    """词形来源的自证：它是**哪一份**、有几个类别、指纹是多少。

    ★ 一个判定结果必须能回答「你用哪套词形判的」。否则词表改了之后，
      旧结论既不能复算、也不能被认出是旧的 —— 只能重抓。
      本项目已经因为这个形态重跑过一整批制品（遗留 19）。
    """
    pairs = sorted((k, rx.pattern) for k, rx in CLAIM_RE.items())
    return {"模块": str(Path(_X.__file__).resolve().relative_to(ROOT)),
            "判据": JUDGE,
            "类别数": len(CLAIM_RE),
            "类别": sorted(CLAIM_RE),
            "指纹": hashlib.sha256(
                "\n".join("%s\t%s" % (k, p) for k, p in pairs).encode()
            ).hexdigest()[:16]}


def claim_sets(text: str, claims=None) -> dict[str, set[str]]:
    """在一份**完整正文**上抽一次声明集合。

    ★ 「在完整正文上抽」这五个字是判据的一部分，不是实现细节。
      第一版判据是在**最小变更段**上找词形 —— 变更段可能长达一万七千字符，
      段里的词形在两版里都在，于是它几乎恒为真。
    """
    table = CLAIM_RE if claims is None else claims
    if not table:
        # ★ 空词表会让**每一对**正文都判成「声明未变」—— 一个恒为假的判据，
        #   而它长得和「今天什么都没变」一模一样。宁可不答。
        raise ValueError("词形表为空：这会静默地把每一条都判成「声明未变」")
    out: dict[str, set[str]] = {}
    for k, rx in table.items():
        got = {m.group(0).strip().lower() for m in rx.finditer(text or "")}
        if got:
            out[k] = got
    return out


def judge(old_text: str, new_text: str, claims=None) -> dict:
    """两次观测的正文 → 一条**可执行的**结论。

    这是本模块的全部。它不吃 `content_key`、不吃 URL、不吃时间戳 ——
    因为那些都不是「合规相关的东西变没变」的证据。
    """
    src = claim_source()
    co, cn = claim_sets(old_text, claims), claim_sets(new_text, claims)
    gone = {k: sorted(co[k] - cn.get(k, set())) for k in co if co[k] - cn.get(k, set())}
    came = {k: sorted(cn[k] - co.get(k, set())) for k in cn if cn[k] - co.get(k, set())}
    same_text = (old_text or "") == (new_text or "")
    verdict = V_SAME if same_text else (V_NEW_CLAIM if (gone or came) else V_NEW_NO_CLAIM)
    return {
        "判据": JUDGE,
        "词形来源": src,
        "结论": verdict,
        "是否触及合规表述": bool(gone or came),
        "消失的声明": gone,
        "新增的声明": came,
        # ★ 下面两个是**给人看的量**，不是判据的一部分。
        #   `差集词数` 是把「变更无法被表达成一个小 diff」变成
        #   「能给人看的就这几个词」的那一个数（§13.8.2 的 17,585 字符）。
        "旧版声明数": sum(len(v) for v in co.values()),
        "新版声明数": sum(len(v) for v in cn.values()),
        "差集词数": sum(len(v) for v in gone.values()) + sum(len(v) for v in came.values()),
        "正文相同": same_text,
    }


def judge_units(old: dict, new: dict, claims=None) -> dict:
    """吃两个 `ContentUnit`（或任何带 `text` 的 dict），把 `content_key` 摆在**它该在的位置**。

    ★★ 这里刻意把 `content_key` 放进 `身份` 而不是 `判据`：
      它答的是「这是哪一版正文」。把它当变更判据用，就是 B2 实测推翻的那个读法。
      两个 key 不同、而结论是「声明未变」—— **这是正常结果，不是矛盾。**
    """
    d = judge(old.get("text", ""), new.get("text", ""), claims)
    ok, nk = old.get("content_key"), new.get("content_key")
    d["身份"] = {
        "content_key 相同": ok == nk,
        "旧": ok, "新": nk,
        "★ 它不是判据": ("`content_key` 答的是「这是哪一版正文」。同一个页面隔一天抓两次，"
                          "key 不同是常态（评论数/价格/促销都在动）—— "
                          "所以「key 变了」不能推出「合规相关的东西变了」。"),
    }
    return d


# ------------------------------------------------------------------ 盘上证据

def replay(path: Path) -> dict:
    """对**盘上已有的观测**重放判据 —— 这是「判据改了不必重抓」那句话的兑现处。

    ★ 它同时回答一件事：**这批证据能不能用新词形重算**。
      判据要吃正文；正文不落盘，换一套词形就只剩「重抓」一条路 ——
      而重抓是联网的时间点动作，不是随时能做的。
      所以本函数**先看盘上有没有正文指针**，再决定说什么，
      而不是写死一句「不能重算」（那样它会在能重算之后继续说不能）。
    """
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    rows = raw.get("逐条") or []
    ok = [r for r in rows if r.get("verdict") in ("same", "text_changed")]
    changed = [r for r in ok if r.get("verdict") == "text_changed"]
    hits = [r for r in changed if (r.get("合规相关性") or {}).get("是否触及合规表述")]
    silent = [r for r in changed if r not in hits]
    with_text = [r for r in ok if isinstance(r.get("旧版正文"), dict)
                 and isinstance(r.get("新版正文"), dict)]
    return {
        "判据": JUDGE,
        "词形来源": claim_source(),
        "证据": str(Path(path)),
        "★ 可重算": len(with_text), "★ 不可重算": len(ok) - len(with_text),
        "快照": raw.get("snapshot"),
        "可判": len(ok),
        # ★ 两个判据并排——这正是 A 想让人看见的那张表
        "旧判据（指纹变了）": len(changed),
        "新判据（声明集合变了）": len(hits),
        "新判据判为「声明未变」": len(silent),
        "★ 新判据多滤掉的": len(changed) - len(hits),
        "$读法": ("旧判据把 %d 处变化**全都报成「内容变了」**；新判据只认其中 %d 处。"
                  "被滤掉的那 %d 处不是「没变」—— 是「变了，但变的东西与合规判定的输入无关」。"
                  "两者的处置完全相反：前者要人去看，后者不该进人的待办。"
                  % (len(changed), len(hits), len(changed) - len(hits))),
        "★ 不可重算的原因": (
            "逐条里有正文指针，可以用 `lp_stability.py --recompute` 换判据重算。"
            if len(with_text) == len(ok) and ok else
            "有 %d 条没有正文指针 —— 这批证据只能用**旧判据留下的结论**重新计数，"
            "换一套词形就要重抓。正文落盘是 §十四.5 才加的，旧轮不可补。"
            % (len(ok) - len(with_text))),
        "逐条": [{"url_key": r["url_key"], "结论": r["verdict"],
                  "合规相关性": r.get("合规相关性")} for r in changed],
    }


# ------------------------------------------------------------------ 自证

def selftest(verbose: bool = True) -> list[str]:
    """B2·A 的自证。**全绿才算完成。** 每条都带反向对照（「必红」）——
    一条永远不会红的检查等于没有检查。"""
    fails: list[str] = []

    def check(name, cond, detail=""):
        ok = bool(cond)
        if verbose:
            print(("  ✓ " if ok else "  ✗ ") + name + (("   " + detail) if detail else ""))
        if not ok:
            fails.append(name + (("  " + detail) if detail else ""))
        return ok

    print("=" * 78)
    print("B2·A 自证 · 变更判据 %s" % JUDGE)
    print("=" * 78)

    print("\n[1] ★★ A 的要点：**key 不同 ≠ 合规相关的东西变了**")
    # 同一页面、隔一天、只有评论数与价格在动 —— content_key 必然不同。
    old_u = {"text": "Wearable pump 45dB FSA eligible\nRated 4.6 out of 5 stars 1,834\n$199.99",
             "content_key": "ck" + "a" * 16, "source": {"uri": "https://x/p"}}
    new_u = {"text": "Wearable pump 45dB FSA eligible\nRated 4.6 out of 5 stars 1,835\n$169.99",
             "content_key": "ck" + "b" * 16, "source": {"uri": "https://x/p"}}
    r = judge_units(old_u, new_u)
    check("两个**不同**的 content_key → 结论必须是「② 换了版正文 · 声明未变」",
          r["结论"] == V_NEW_NO_CLAIM, r["结论"])
    check("且 `身份.content_key 相同` 为 False（key 确实变了，只是它与合规无关）",
          r["身份"]["content_key 相同"] is False)
    check("必红：这里**没有**报出任何声明变化", r["是否触及合规表述"] is False,
          "" if not r["是否触及合规表述"] else
          "它报了变化 —— 这正是「会天天报假警」的旧判据的形态")

    print("\n[2] 真的变了就必须报出来，且差集要能被人一眼看完")
    a = ("Pump with hospital-grade suction, perfect for moms, 45db quiet, "
         "FSA eligible, award-winning design")
    b = ("Pump with suction, guaranteed for moms, 45db quiet, "
         "HSA eligible, unlike other brands")
    r = judge(a, b)
    check("结论是「③ 换了版正文 · 声明已变」", r["结论"] == V_NEW_CLAIM, r["结论"])
    check("消失里有 hospital-grade（medical）与 perfect / award-winning",
          "hospital-grade" in r["消失的声明"].get("medical", [])
          and "perfect" in r["消失的声明"].get("absolute", [])
          and "award-winning" in r["消失的声明"].get("comparative", []),
          json.dumps(r["消失的声明"], ensure_ascii=False))
    check("新增里有 guaranteed（absolute）与 hsa（certification）",
          "guaranteed" in r["新增的声明"].get("absolute", [])
          and "hsa" in r["新增的声明"].get("certification", []),
          json.dumps(r["新增的声明"], ensure_ascii=False))
    check("★ 差集词数 %d 个 —— 给人看的是这几个词，不是那段一万七千字符" % r["差集词数"],
          r["差集词数"] <= 12, str(r["差集词数"]))

    print("\n[3] 必红：一个恒为真、和一个恒为假的判据都不许存在")
    # 恒为真：旧判据的形态 —— 词形在两版里都出现，它却报「变了」。
    same = "45dB quiet FSA hospital-grade award-winning"
    check("必红：两版词形完全一致 → 不许报变化（旧判据在这里恒为真）",
          judge(same, same)["结论"] == V_SAME)
    # 恒为假：空词表 —— 它会把**每一对**正文都判成「声明未变」。
    try:
        judge("hospital-grade", "nothing here", claims={})
        check("必红：空词形表必须被拒绝（否则每条都判成「声明未变」）", False,
              "它给出了结论 —— 一个恒为假的判据，和「今天什么都没变」长得一样")
    except ValueError:
        check("必红：空词形表必须被拒绝（否则每条都判成「声明未变」）", True)

    print("\n[4] 词形来源只有一份")
    check("CLAIM_RE 来自 tools/lp_extract.py，本模块不另写一份",
          claim_source()["模块"] == "tools/lp_extract.py", claim_source()["模块"])
    check("类别数 %d，与 lp_extract 一致" % len(CLAIM_PATTERNS),
          claim_source()["类别数"] == len(CLAIM_PATTERNS) == len(CLAIM_RE))
    check("本模块抽出来的声明集合与直接查 CLAIM_RE **逐条相同**",
          _agree_with_source())
    check("词形指纹非空且稳定（%s）" % claim_source()["指纹"],
          claim_source() == claim_source() and len(claim_source()["指纹"]) == 16)

    print("\n[5] 判据名随结论一起返回（否则结论离开判据就没有意义）")
    r = judge("a", "b")
    check("每条结论都带 判据 = %s" % JUDGE, r.get("判据") == JUDGE)
    check("每条结论都带词形来源与它的指纹", bool(r.get("词形来源", {}).get("指纹")))

    print("\n" + "-" * 78)
    if fails:
        print("✗ 自证未通过：%d 条" % len(fails))
    else:
        print("✓ 自证全绿")
    return fails


def _agree_with_source() -> bool:
    """本模块的抽法与直接查 `CLAIM_RE` 必须逐条相同 —— 防止悄悄加了一层加工。"""
    probe = ("Wearable pump hospital-grade perfect 45db FSA HSA FDA vs better than "
             "increase milk supply 20 hours BPA-free 100% guaranteed")
    mine = claim_sets(probe)
    ref = {}
    for k, rx in CLAIM_RE.items():
        got = {m.group(0).strip().lower() for m in rx.finditer(probe)}
        if got:
            ref[k] = got
    return mine == ref


# ------------------------------------------------------------------ CLI

def main() -> int:
    ap = argparse.ArgumentParser(description="变更判据（B2 · Owner 裁定 A）")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--selftest", action="store_true", help="自证：判据全绿 + 反向对照必红")
    g.add_argument("--replay", metavar="EVIDENCE", help="对盘上已有观测重放判据")
    g.add_argument("--pair", nargs=2, metavar=("OLD", "NEW"), help="两个正文文件")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    if a.selftest:
        return 1 if selftest() else 0

    if a.replay:
        d = replay(Path(a.replay))
        if a.json:
            print(json.dumps(d, ensure_ascii=False, indent=1))
            return 0
        print("=" * 78)
        print("判据 %s 重放 · 证据 %s" % (d["判据"], d["证据"]))
        print("=" * 78)
        print("\n快照 %s · 可判 %d 条" % (d["快照"], d["可判"]))
        print("\n  旧判据（指纹变了）        %3d 处" % d["旧判据（指纹变了）"])
        print("  新判据（声明集合变了）    %3d 处" % d["新判据（声明集合变了）"])
        print("  ★ 新判据多滤掉的          %3d 处" % d["★ 新判据多滤掉的"])
        print("\n" + d["$读法"])
        print("\n  可用新词形重算 %d / %d 条" % (d["★ 可重算"], d["可判"]))
        print("\n★ %s" % d["★ 不可重算的原因"])
        return 0

    o, n = (Path(a.pair[0]).read_text(encoding="utf-8"),
            Path(a.pair[1]).read_text(encoding="utf-8"))
    d = judge(o, n)
    if a.json:
        print(json.dumps(d, ensure_ascii=False, indent=1))
    else:
        print("判据      ", d["判据"], "· 词形来源", d["词形来源"]["模块"],
              d["词形来源"]["指纹"])
        print("结论      ", d["结论"])
        print("消失的声明", json.dumps(d["消失的声明"], ensure_ascii=False))
        print("新增的声明", json.dumps(d["新增的声明"], ensure_ascii=False))
        print("差集词数  ", d["差集词数"])
    return 0


if __name__ == "__main__":
    sys.exit(main())

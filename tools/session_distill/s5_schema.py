#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""S5 Schema 蒸馏：把案例蒸成「可执行动作 / 禁止动作 / 风险点」三类卡片。

    python3 tools/session_distill/s5_schema.py [--apply] [--selftest]

分工（**谁负责哪一半必须写清，否则会互相冒充**）
------------------------------------------------
| 谁 | 负责什么 | 判据在哪 |
|---|---|---|
| **本引擎（机械）** | ① 回验**每一条指针真的存在**（`case_id` 在判定表里、`session_id:seq` 对得上、`原话` 逐字出现在那一句里）<br>② 算 `independent_sources`（卡片指针跨了几个**不同会话**）<br>③ 算 `score` 与 `verdict`<br>④ 断言三类齐全、禁止动作 ≥1 | 本文件的 `verify_card()` |
| **起草人（模型）** | 卡片正文：可执行动作 / 禁止动作 / 风险点，以及 `predictive` / `non_obvious` 两项**作者声明** | `schema/schema-cards-v1.yaml` |

★ 起草不是判定：**卡片正文里每一句都必须挂 `依据`**，而依据由引擎回验。
★ `predictive` / `non_obvious` 两项**机器算不出来**，所以它们一律标 `作者声明·待人工`，
  不许混进「机器验过的读数」里假装可信（AGENTS.md §2.4：写进文档的每个数都要指得出出处）。

三重验证（口径抄 `蒸馏` skill：score = 三项之和 ÷ 6）
  > 0.8 → keep ｜ < 0.4 → discard ｜ 中间 → review
"""
from __future__ import annotations

import argparse
import collections
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import RUN_DIR, read_ndjson, trim, write_json, write_md_plain  # noqa: E402

CARDS_SRC = RUN_DIR / "schema" / "schema-cards-v1.yaml"
CARDS_OUT = RUN_DIR / "schema" / "Schema卡片-v1.json"
VERIFY_REPORT = RUN_DIR / "schema" / "回验报告-v1.md"

JUDGED = RUN_DIR / "正误判定-v1.ndjson"
CASES = RUN_DIR / "案例-v1.ndjson"

THREE_KINDS = ("可执行动作", "禁止动作", "风险点")


def load_tables():
    judged = {j["case_id"]: j for j in read_ndjson(JUDGED)}
    cases = {c["case_id"]: c for c in read_ndjson(CASES)}
    return judged, cases


def verify_pointer(p, judged, cases):
    """回验一条指针。返回 (ok, 说明)。**这是本脚本唯一的硬判据。**"""
    cid = p.get("case_id")
    if cid not in judged:
        return False, "case_id %r 不在判定表里" % cid
    c = cases.get(cid)
    if c is None:
        return False, "case_id %r 不在案例表里" % cid
    # 指针必须指得出「哪条会话的哪一句」
    if p.get("anchor") and p["anchor"] != "%s:%s" % (c["session_id"], c["ask_seq"]):
        return False, "anchor %r 与案例表记的 %s:%s 对不上" % (
            p["anchor"], c["session_id"], c["ask_seq"])
    # ★ 引文必须**逐字**出现在这条案例的素材或下一句人话里 —— 否则就是把话安到别人头上
    q = (p.get("quote") or "").strip()
    if not q:
        return False, "没有 quote（引文），无法回验"
    hay = (c.get("ask") or "") + "\n" + (c.get("next_human") or "")
    if q not in hay:
        return False, "引文在案例原文里找不到：%r" % trim(q, 60)
    # 判定必须真的支持这张卡片引它（反例不能拿来当"该照做"的证据）
    return True, "ok（判定=%s）" % judged[cid]["判定"]


def score_card(card, judged, cases):
    """三重验证：independent_sources 机器算，另两项由作者声明。"""
    sessions = set()
    for item in card["条目"]:
        for p in item["依据"]:
            c = cases.get(p["case_id"])
            if c:
                sessions.add(c["session_id"])
    indep = min(2, len(sessions))
    pred = int(card.get("作者声明", {}).get("predictive", 0))
    nono = int(card.get("作者声明", {}).get("non_obvious", 0))
    score = (indep + pred + nono) / 6.0
    verdict = "keep" if score > 0.8 else ("discard" if score < 0.4 else "review")
    # ★ 「≥2 处独立佐证」是**闸门**，不是分数项 —— 一条会话里说两遍不算多来源互证。
    #   只靠 1 条会话的卡片最多只能到 review，分数再高也不许 keep。
    if indep < 2 and verdict == "keep":
        verdict = "review"
    return {"independent_sources": indep, "predictive": pred, "non_obvious": nono,
            "score": round(score, 3), "verdict": verdict,
            "跨会话数": len(sessions), "会话": sorted(sessions),
            "predictive_source": "作者声明·待人工", "non_obvious_source": "作者声明·待人工",
            "independent_sources_source": "机器复算（跨不同会话计数）"}


def cross_check(card, judged, cases):
    """三类齐全 / 禁止动作 ≥1 / 不得拿「待人工复核」当正例依据 —— 契约 §一 的硬要求。"""
    errs = []
    kinds = {i["类"] for i in card["条目"]}
    for k in THREE_KINDS:
        if k not in kinds:
            errs.append("缺「%s」类" % k)
    if not [i for i in card["条目"] if i["类"] == "禁止动作"]:
        errs.append("禁止动作 0 条（契约 §一 must_include ② 要求 ≥1）")
    for i in card["条目"]:
        for p in i["依据"]:
            j = judged.get(p["case_id"])
            if j is None:
                continue
            if j["判定"] == "待人工复核":
                errs.append("条目「%s」拿『待人工复核』的案例当依据（%s）" % (trim(i["动作"], 24), p["case_id"]))
            if i["类"] == "可执行动作" and j["判定"] == "反例" and not p.get("反例可用作"):
                errs.append("可执行动作「%s」只有反例依据（%s）却没有标 `反例可用作`"
                            % (trim(i["动作"], 24), p["case_id"]))
    return errs


def selftest() -> int:
    fails, n_ck = [], [0]

    def ck(name, got, want):
        n_ck[0] += 1
        if got != want:
            fails.append("%s：得到 %r，期望 %r" % (name, got, want))

    judged = {"SC-1": {"case_id": "SC-1", "判定": "反例"},
              "SC-2": {"case_id": "SC-2", "判定": "正例"}}
    cases = {"SC-1": {"case_id": "SC-1", "session_id": "s1", "ask_seq": 3,
                      "ask": "有问题要先修复再跑", "next_human": "你怎么又复现了"},
             "SC-2": {"case_id": "SC-2", "session_id": "s2", "ask_seq": 5,
                      "ask": "同意你的建议", "next_human": "同意"}}
    ok, _ = verify_pointer({"case_id": "SC-1", "anchor": "s1:3", "quote": "有问题要先修复再跑"},
                           judged, cases)
    ck("V1 真指针过", ok, True)
    # V2 ★ 引文必须逐字 —— 换个字就不认
    ok, why = verify_pointer({"case_id": "SC-1", "quote": "有问题要先修复再跑啊"}, judged, cases)
    ck("V2 改一个字的引文必须红", ok, False)
    # V3 不存在的 case_id
    ck("V3 幽灵 case", verify_pointer({"case_id": "SC-9", "quote": "x"}, judged, cases)[0], False)
    # V4 anchor 对不上
    ck("V4 anchor 错位", verify_pointer(
        {"case_id": "SC-1", "anchor": "s1:99", "quote": "有问题要先修复再跑"}, judged, cases)[0], False)
    # V5 空引文
    ck("V5 空引文必须红", verify_pointer({"case_id": "SC-1", "quote": ""}, judged, cases)[0], False)

    base = {"id": "SCH-T", "条目": [
        {"类": "可执行动作", "动作": "x", "依据": [{"case_id": "SC-2"}]},
        {"类": "禁止动作", "动作": "y", "依据": [{"case_id": "SC-1"}]},
        {"类": "风险点", "动作": "z", "依据": [{"case_id": "SC-1"}]}],
        "作者声明": {"predictive": 2, "non_obvious": 2}}
    s = score_card(base, judged, cases)
    ck("V6 跨会话机器复算", s["independent_sources"], 2)
    ck("V6b score", s["score"], round(6 / 6.0, 3))
    ck("V6c verdict", s["verdict"], "keep")
    ck("V7 三类缺失被抓", len(cross_check({"id": "T", "条目": base["条目"][:1]}, judged, cases)) >= 2, True)
    # V8 ★ 拿「待人工复核」当依据必须红
    j2 = dict(judged); j2["SC-2"] = {"case_id": "SC-2", "判定": "待人工复核"}
    ck("V8 待复核不许当依据",
       any("待人工复核" in e for e in cross_check(base, j2, cases)), True)
    # V9 反向对照：合法卡片必须**不**报错
    ck("V9 合法卡片零错", cross_check(base, judged, cases), [])
    # V10 ★ 单会话卡片不许 keep（≥2 独立佐证是闸门，不是分数）
    one = {"id": "SCH-1", "条目": [
        {"类": "可执行动作", "动作": "x", "依据": [{"case_id": "SC-2"}]},
        {"类": "禁止动作", "动作": "y", "依据": [{"case_id": "SC-2"}]},
        {"类": "风险点", "动作": "z", "依据": [{"case_id": "SC-2"}]}],
        "作者声明": {"predictive": 2, "non_obvious": 2}}
    s1 = score_card(one, judged, cases)
    ck("V10 单会话封顶 review", (s1["independent_sources"], s1["verdict"]), (1, "review"))
    # V10b 反向对照：跨两会话的同样声明必须能 keep（否则 V10 恒真）
    ck("V10b 跨会话可 keep", score_card(base, judged, cases)["verdict"], "keep")

    if fails:
        print("❌ S5 自证未过（%d / %d 项）" % (len(fails), n_ck[0]))
        for f in fails:
            print("   " + f)
        return 1
    print("✅ S5 自证全过（%d 项反向对照）" % n_ck[0])
    return 0


def run(apply: bool):
    try:
        import yaml
    except Exception as e:
        print("✗ 需要 pyyaml：%s" % e)
        return 1
    if not CARDS_SRC.exists():
        print("✗ 卡片源文件不存在：%s" % CARDS_SRC)
        return 1
    doc = yaml.safe_load(CARDS_SRC.read_text(encoding="utf-8"))
    cards = doc.get("cards") or []
    judged, cases = load_tables()

    print("── S5 Schema 蒸馏 " + ("（--apply 真写）" if apply else "（预演，不落盘）"))
    print("   卡片数                  %d" % len(cards))

    out, bad = [], []
    for card in cards:
        ptr_ok = ptr_bad = 0
        for item in card["条目"]:
            keep = []
            for p in item["依据"]:
                ok, why = verify_pointer(p, judged, cases)
                if ok:
                    keep.append(dict(p, 回验="ok"))
                    ptr_ok += 1
                else:
                    ptr_bad += 1
                    bad.append((card["id"], trim(item["动作"], 20), p, why))
            item["依据"] = keep
        errs = cross_check(card, judged, cases)
        sc = score_card(card, judged, cases)
        out.append(dict(card, 三重验证=sc, 结构错误=errs,
                        指针回验={"过": ptr_ok, "不过": ptr_bad}))
        if errs or ptr_bad:
            bad.append((card["id"], "-", {}, "; ".join(errs)))

    kinds = collections.Counter(i["类"] for c in out for i in c["条目"])
    verdicts = collections.Counter(c["三重验证"]["verdict"] for c in out)
    print("   ── 条目分类 ──")
    for k in THREE_KINDS:
        print("     %-8s %5d" % (k, kinds.get(k, 0)))
    print("   ── 三重验证 ──")
    for k, v in verdicts.most_common():
        print("     %-8s %5d" % (k, v))
    print("   指针回验：过 %d / 不过 %d" % (
        sum(c["指针回验"]["过"] for c in out), sum(c["指针回验"]["不过"] for c in out)))

    if apply:
        CARDS_OUT.parent.mkdir(parents=True, exist_ok=True)
        write_json(CARDS_OUT, {"at": "2026-10-15", "n_cards": len(out), "cards": out})
        lines = ["# Schema 卡片回验报告 v1", "",
                 "> 生成：`python3 tools/session_distill/s5_schema.py --apply`",
                 "> 判据：每条指针的 `case_id` 必须在判定表里、`anchor` 必须与案例表一致、",
                 "> **引文必须逐字出现在那条案例的原文里**。", "",
                 "| 卡片 | 条目 | 指针过 | 指针不过 | score | verdict | 结构错误 |",
                 "|---|---|---|---|---|---|---|"]
        for c in out:
            lines.append("| %s | %d | %d | %d | %s | %s | %s |" % (
                c["id"], len(c["条目"]), c["指针回验"]["过"], c["指针回验"]["不过"],
                c["三重验证"]["score"], c["三重验证"]["verdict"],
                "；".join(c["结构错误"]) or "—"))
        lines += ["", "## 逐条不合格明细", ""]
        if bad:
            for cid, act, p, why in bad:
                lines.append("- `%s` / %s / %s → **%s**" % (cid, act, p.get("case_id", "-"), why))
        else:
            lines.append("（无）")
        # ★ `.md` 必须走 write_md_plain（python 直写会落成 +4096 信封，read 工具打不开）
        env = write_md_plain(VERIFY_REPORT, "\n".join(lines) + "\n")
        if not env["ok"]:
            print("   ✗ 回验报告落成了信封态（python %d / node %d）—— 读它的人会打不开"
                  % (env["python_bytes"], env["node_bytes"]))
            return 2
        write_json(RUN_DIR / "_evidence" / "schema-stats.json",
                   {"at": "2026-10-15", "n_cards": len(out), "kinds": dict(kinds),
                    "verdicts": dict(verdicts), "bad": len(bad)})
        print("   已写：Schema卡片-v1.json、回验报告-v1.md")
        if bad:
            print("   ⚠ 有 %d 条不合格（明细见回验报告）" % len(bad))
            return 1
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    if a.selftest:
        return selftest()
    return run(a.apply)


if __name__ == "__main__":
    sys.exit(main())

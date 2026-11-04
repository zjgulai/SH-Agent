#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""S4 分层归位：已判定案例 → 按「对应的那一层」出**入库候选**。

    python3 tools/session_distill/s4_route.py [--apply] [--selftest]

★ 先说清是哪一套 L0–L7
-----------------------
本库里有**两套**都在用 "L0…L7" 的编号，混起来会把候选投错地方：

| 编号 | 谁在用 | 目录 | 收什么 |
|---|---|---|---|
| **供给链**（本脚本用这套） | `kb/l7/registry/layers.yaml` 与全部 `kb-*` skill | `kb/l0…l7` | 源对齐 / 抽取 / 切分 / 蒸馏 / 发号 / P0 / 召回 / 报告 |
| 宿主库 tier | `kb/view/_meta/entry-schema.md`（派生视图） | `kb/view/<子库>/L0-raw…L4-contracts` | 原文 / 事实 / 判断 / 关系 / 契约 |

用户说的「知识库 L0-L7 层」= **供给链那一套**（每层绑了 skill、每层有闸门）。

归位规则（**只有能对上真实记录形状的层才投**）
----------------------------------------------
| 层 | 本轮投不投 | 依据 |
|---|---|---|
| **L0** | 投 | 送审单里出现的飞书资源引用（URL / token）是**源侧对象**，L0 的职责就是登记它 + 算指纹 |
| **L1** | 投（主） | 案例 = 素材 + 结论，正是 `kb/l1/2_内部正负样本库` 的形状 |
| **L2** | **不投** | L2 是 L1 的**切分派生**（`units.jsonl`），会话不直接产切分单元 |
| **L3** | 投 | 从**反例**聚类出的规则候选（≥2 处独立佐证才投，否则进缺口清单） |
| **L4** | **不投** | 定稿发号要人过闸（`l4/canonical`），机器只能提候选 |
| **L5** | 投（可能为空） | 从反例里聚出的 P0 模式；聚不出就**如实报 0**，不凑数 |
| **L6** | **不投** | L6 是索引层，由 L1/L2 派生（`l6_build.py`） |
| **L7** | **不投** | L7 是报告/注册表层，本轮的影响面报告本身就是它的产物 |
"""
from __future__ import annotations

import argparse
import collections
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import RUN_DIR, read_ndjson, sha256_text, trim, write_json, write_ndjson  # noqa: E402

JUDGED = RUN_DIR / "正误判定-v1.ndjson"
CASES = RUN_DIR / "案例-v1.ndjson"
ROUTED = RUN_DIR / "入库候选-v1.ndjson"
GAPS = RUN_DIR / "缺口清单-v1.ndjson"

EXTRACTOR_VERSION = "session-distill-0.1"
TODAY = "2026-10-15"
OWNER = "Owner"          # KB 登记表里的具名人（见验收契约 §一）

# 飞书资源链接 → L0 源侧对象
RE_FEISHU = re.compile(
    r"https://[\w.-]*feishu\.(?:cn|com)/(wiki|docx|docs|sheets|base|file|drive)/([A-Za-z0-9]+)")
# 素材里的 P0 / 红线词（用来给 L5 找候选 —— 只做**聚类线索**，不是判据）
P0_HINTS = (
    "医疗功效", "治疗", "预防疾病", "cure", "treat", "hospital grade", "hospital-grade",
    "best-selling", "绝对化", "first", "no.1", "#1", "最安全", "safest", "cheapest",
    "FDA", "临床", "临床证明", "clinically proven", "医生推荐", "doctor recommended",
)

# 内容形态 → kb_type（对齐 `kb/l1/2_内部正负样本库` 的 kb_type 取值）
def kb_type_of(case, judged):
    ask = case["ask"]
    if case["kind"] == "守衡送审单":
        return "internal_sample"
    if any(k in ask for k in ("文案", "广告语", "listing", "listing 文案", "社媒")):
        return "wording"
    return "review_case"


def route_case(case, judged):
    """一个案例 → 若干条候选（可能落多层）。"""
    out = []
    cid = case["case_id"]
    verdict = judged["判定"]
    sid = case["session_id"]
    anchor = "%s:%s" % (sid, case["ask_seq"])
    feishu = RE_FEISHU.findall(case["ask"] + "\n" + case["response"])

    # ── L0：送审单引用的飞书资源 = 源侧对象 ──
    for kind, token in sorted(set(feishu)):
        out.append({
            "层": "L0",
            "candidate_id": "SD-L0-%s" % sha256_text(cid + kind + token)[:12],
            "record_shape": "kb/l0/manifest.jsonl",
            "resource_key": "%s:%s" % (kind, token),
            "resource_id": "%s__%s" % (kind, token),
            "source_kind": "feishu_%s" % kind,
            "sha256_input": "url_text",
            "source_sha256": sha256_text("https://feishu/%s/%s" % (kind, token)),
            "observed_at": TODAY,
            "evidence_pointer": anchor,
            "from_case": cid,
            "note": "会话里引用了这个飞书资源；本候选只登记**对象与指纹**，不解析正文（L0 的职责边界）",
        })

    # ── L1：案例条目（主战场）──
    out.append({
        "层": "L1",
        "candidate_id": "SD-L1-%s" % sha256_text(cid)[:12],
        "record_shape": "kb/l1/2_内部正负样本库/<id>.json",
        "from_case": cid,
        "resource_id": "dsh_%s" % cid.lower(),
        "resource_key": "dsh_session:%s" % cid,
        "kb_type": kb_type_of(case, judged),
        "kb_class": "samples",
        # 「无判定对象」的条目**不建议进 2_内部正负样本库** —— 它不是样本，
        # 是过程记录。留下这个字段是为了让下游能一眼分开，而不是靠 polarity 猜。
        "建议落点": ("不进样本库（无判定对象）" if judged["判定"] == "无判定对象·过程记录"
                     else "2_内部正负样本库"),
        "source_kind": "dsh_session",
        "source_sha256": case["ask_sha256"],
        "extractor_version": EXTRACTOR_VERSION,
        "status": "provisional",
        "anchor_spec": "anchor-1.0",
        "anchor_kind": "session_seq",
        "observed_at": TODAY.replace("-", "") + "-0000",
        "source": {
            "kind": "dsh_session",
            "ref": anchor,
            "fingerprint": case["ask_sha256"],
            "captured_at": TODAY,
            "record_ids": [cid, "%s:%s" % (sid, case["ask_seq"])],
        },
        "provenance": {"anchor": "dsh-session/%s#seq.%s" % (sid, case["ask_seq"]),
                       "confidence": "确定" if judged["指针"] else "待定"},
        # ── 正负样本库的既有字段（对齐 kb/l3/candidates/sample_cases.jsonl 的口径）──
        "polarity": {"正例": "正例", "反例": "反例"}.get(verdict, "待人工复核"),
        "semantics": {"正例": "标杆：应该怎么做", "反例": "反例：不该怎么做",
                      "缺口·引擎拒答": "缺口：库对该题材无可依据条款",
                      # ★ 「无判定对象」**不是**「待人工复核」：它本来就没有正误可言，
                      #   不该进样本库等人签字。它的价值在别处（决策记录 / 流程口径）。
                      "无判定对象·过程记录": "过程记录：没有判定对象，不进样本库",
                      "待人工复核": "待人工复核", "冲突·待人工复核": "待人工复核"}.get(verdict, "待人工复核"),
        "reason_category": (judged["错型候选标签"] or [""])[0],
        "reason_analysis": trim(case["response"], 2000),
        "sample_body": trim(case["ask"], 6000),
        "char_count": case["ask_chars"],
        "evidence_strength": ("有指针（%d 条）" % judged["指针数"]) if judged["指针数"] else "无指针",
        "verdicts": judged["verdicts"],
        "layer_runs": judged["layer_runs"],
        "验证据指针": judged["指针"],
        "需人工确认": any(p.get("需人工确认") for p in judged["指针"]),
        "not_proves": "不能证明该素材**整体合规** —— 只说明这一条被这样处理过；也不能替代法务/合规意见",
        "half_life_days": 180,
        "valid_until": "2027-04-13",
        "owner": OWNER,
        "evidence_level": "L2",
        "data_level": "D1",
        "asks": ["这条素材当时是怎么判的", "同类素材该怎么处理", "这类做法有没有被人工纠正过"],
    })
    return out


def cluster_rules(routed_l1, cases, judged_by_id):
    """从**反例**里聚规则候选 —— 只有 ≥2 处独立佐证才成候选（契约 §一）。"""
    buckets = collections.defaultdict(list)
    for r in routed_l1:
        if r["polarity"] != "反例":
            continue
        j = judged_by_id[r["from_case"]]
        # 聚类键：错型标签 + 素材形态（同一条反例可能进多个桶，这是有意的）
        for tag in (j["错型候选标签"] or ["未分类"]):
            buckets[(tag, r["kb_type"])].append((r, j))
    out, gaps = [], []
    for (tag, kbt), members in sorted(buckets.items(), key=lambda kv: -len(kv[1])):
        if len(members) < 2:
            gaps.append({"层": "L3", "聚类键": "%s / %s" % (tag, kbt), "佐证数": len(members),
                         "处置": "佐证 < 2，按三重验证淘汰；登记为待补样本的缺口"})
            continue
        rid = "SD-L3-%s" % sha256_text(tag + kbt)[:12]
        out.append({
            "层": "L3",
            "candidate_id": rid,
            "record_shape": "kb/l3/candidates/rules.jsonl",
            "rule_id": rid,
            "rule_code": "",              # 发号是 L4 的动作，候选阶段留空
            "article_no": "",
            "kb_type": kbt,
            "status": "provisional",
            "rule_text": "会话蒸馏聚类：%s（%s）" % (tag, kbt),
            "reason": tag,
            "support_count": len(members),
            "evidence_units": [{"case_id": m[0]["from_case"],
                                "anchor": m[0]["provenance"]["anchor"],
                                "sha256": m[0]["source_sha256"]} for m in members],
            "evidence_pointers": [m[1]["指针"] for m in members],
            "owner": OWNER,
            "evidence_level": "L2",
            "half_life_days": 180,
            "valid_until": "2027-04-13",
            "not_proves": "不能证明这就是应该写进库的条款文本 —— 它只是「这一类做法被人工纠正过 %d 次」的聚类结果" % len(members),
        })
    return out, gaps


def cluster_p0(routed_l1, cases):
    """从反例里找 P0 模式候选 —— 聚不出就如实报 0。"""
    hits = collections.defaultdict(list)
    for r in routed_l1:
        if r["polarity"] != "反例":
            continue
        body = (r["sample_body"] + "\n" + r["reason_analysis"]).lower()
        for h in P0_HINTS:
            if h.lower() in body:
                hits[h.lower()].append(r["from_case"])
    out, gaps = [], []
    for term, cids in sorted(hits.items(), key=lambda kv: -len(kv[1])):
        if len(cids) < 2:
            gaps.append({"层": "L5", "模式": term, "佐证数": len(cids),
                         "处置": "佐证 < 2，不足以成 P0 模式；登记为待补样本的缺口"})
            continue
        out.append({
            "层": "L5",
            "candidate_id": "SD-L5-%s" % sha256_text(term)[:12],
            "record_shape": "kb/l5/p0_patterns.jsonl",
            "pattern_id": "SD-L5-%s" % sha256_text(term)[:12],
            "rule_id": "",
            "type": "session-distilled",
            "pattern_terms": [term],
            "patterns": [term],
            "regex_patterns": [],
            "match_terms": [term],
            "support_count": len(cids),
            "evidence_units": cids,
            "owner": OWNER,
            "not_proves": "不能替代 L5 的人工签发 —— 这只是「这个词在 %d 条被纠正的案例里出现过」" % len(cids),
        })
    return out, gaps


def run(apply: bool):
    judged = list(read_ndjson(JUDGED))
    cases = {c["case_id"]: c for c in read_ndjson(CASES)}
    if not judged:
        print("✗ 判定表为空 —— 先跑 s3_judge.py --apply")
        return 1
    jby = {j["case_id"]: j for j in judged}

    routed = []
    for j in judged:
        c = cases.get(j["case_id"])
        if not c:
            continue
        routed.extend(route_case(c, j))

    l1 = [r for r in routed if r["层"] == "L1"]
    rules, gaps3 = cluster_rules(l1, cases, jby)
    p0, gaps5 = cluster_p0(l1, cases)
    routed.extend(rules)
    routed.extend(p0)
    gaps = gaps3 + gaps5

    dist = collections.Counter(r["层"] for r in routed)
    pol = collections.Counter(r["polarity"] for r in l1)
    print("── S4 分层归位 " + ("（--apply 真写）" if apply else "（预演，不落盘）"))
    print("   输入案例                %d" % len(judged))
    print("   ── 候选按层 ──")
    for lay in ("L0", "L1", "L2", "L3", "L4", "L5", "L6", "L7"):
        n = dist.get(lay, 0)
        why = "" if n else "   ← 本轮不投（见脚本头「归位规则」）"
        print("     %-4s %5d%s" % (lay, n, why))
    print("   L1 候选的极性分布：")
    for k, v in pol.most_common():
        print("     %-14s %5d" % (k, v))
    print("   缺口清单（佐证不足被淘汰）%d" % len(gaps))

    if apply:
        write_ndjson(ROUTED, routed)
        write_ndjson(GAPS, gaps)
        write_json(RUN_DIR / "_evidence" / "route-stats.json",
                   {"at": TODAY, "dist": dict(dist), "polarity": dict(pol),
                    "gaps": len(gaps), "n_judged": len(judged)})
        print("   已写：入库候选-v1.ndjson（%d 行）、缺口清单-v1.ndjson（%d 行）"
              % (len(routed), len(gaps)))
    return 0


# ── 反向对照 ────────────────────────────────────────────────────────
def selftest() -> int:
    fails, n_ck = [], [0]

    def ck(name, got, want):
        n_ck[0] += 1
        if got != want:
            fails.append("%s：得到 %r，期望 %r" % (name, got, want))

    base_case = {"case_id": "SC-1", "session_id": "s1", "kind": "多轮对话", "ask_seq": 3,
                 "ask": "这段文案能不能发？https://momcozy-in.feishu.cn/wiki/Abc123def",
                 "response": "结论 REVIEW", "ask_sha256": "a" * 64, "ask_chars": 40}
    j_pos = {"case_id": "SC-1", "判定": "正例", "指针": [{"源": "③库里已有裁定"}],
             "错型候选标签": [], "verdicts": ["PASS"], "layer_runs": [], "指针数": 1}
    j_neg = dict(j_pos, 判定="反例", 错型候选标签=["人当场纠正"])
    j_none = {"case_id": "SC-1", "判定": "待人工复核", "指针": [],
              "错型候选标签": [], "verdicts": [], "layer_runs": [], "指针数": 0}

    r = route_case(base_case, j_pos)
    layers = sorted({x["层"] for x in r})
    ck("T1 投 L0+L1", layers, ["L0", "L1"])
    l1 = [x for x in r if x["层"] == "L1"][0]
    ck("T2 正例极性", l1["polarity"], "正例")
    ck("T3 反例不许被写成正例",
       [x for x in route_case(base_case, j_neg) if x["层"] == "L1"][0]["polarity"], "反例")
    # T4 ★ 无指针的案例**不许**被写成正例或反例
    ck("T4 无指针极性落待复核",
       [x for x in route_case(base_case, j_none) if x["层"] == "L1"][0]["polarity"], "待人工复核")
    # T5 必填元字段一个不少（契约 must_include ③）
    need = {"resource_id", "kb_type", "source_kind", "source_sha256", "owner",
            "evidence_level", "valid_until", "not_proves", "asks", "source",
            "half_life_days", "observed_at", "status"}
    ck("T5 元字段齐全", need - set(l1.keys()), set())
    ck("T5b source 四子键", {"kind", "ref", "fingerprint", "captured_at"} - set(l1["source"].keys()), set())
    # T6 L0 候选必须真的登记了那个飞书 token
    l0 = [x for x in r if x["层"] == "L0"][0]
    ck("T6 L0 抓到 wiki token", l0["resource_key"], "wiki:Abc123def")
    # T7 反向对照：没有飞书链接就**不许**凭空造 L0 候选
    c2 = dict(base_case); c2["ask"] = "这段文案能不能发？"
    ck("T7 无链接不造 L0", [x for x in route_case(c2, j_pos) if x["层"] == "L0"], [])
    # T8 L3/L5 的 ≥2 佐证闸门：单条不许成候选
    fake_l1 = [{"polarity": "反例", "from_case": "SC-1", "kb_type": "internal_sample",
                "sample_body": "", "reason_analysis": "",
                "source_sha256": "b" * 64,
                "provenance": {"anchor": "dsh-session/s1#seq.3", "confidence": "确定"}}]
    rules, gaps = cluster_rules(fake_l1, {"SC-1": base_case}, {"SC-1": j_neg})
    ck("T8 单佐证不成 L3 候选", rules, [])
    ck("T8b 单佐证进缺口清单", len(gaps), 1)
    # T8c 反向对照：两条同标签必须**成**候选（否则 T8 恒真）
    fake2 = fake_l1 * 2
    rules2, _ = cluster_rules(fake2, {"SC-1": base_case}, {"SC-1": j_neg})
    ck("T8c 双佐证成候选", len(rules2), 1)
    ck("T8d support_count", rules2[0]["support_count"], 2)
    # T9 P0：聚不出就报 0，不凑数
    p0, g5 = cluster_p0(fake_l1, {"SC-1": base_case})
    ck("T9 无 P0 线索报 0", p0, [])

    if fails:
        print("❌ S4 自证未过（%d / %d 项）" % (len(fails), n_ck[0]))
        for f in fails:
            print("   " + f)
        return 1
    print("✅ S4 自证全过（%d 项反向对照）" % n_ck[0])
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

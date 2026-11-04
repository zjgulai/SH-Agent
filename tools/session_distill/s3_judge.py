#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""S3 正误判定：只认三源指针，模型不单独定正误。

    python3 tools/session_distill/s3_judge.py            # 预演
    python3 tools/session_distill/s3_judge.py --apply
    python3 tools/session_distill/s3_judge.py --selftest

判据（契约 `PMO/会话蒸馏-20261015/验收契约-v1.md` §三）
--------------------------------------------------------
| 源 | 是什么 | 本轮它落在哪 |
|---|---|---|
| ① 人的原话 | 你 / 群里的人当场纠正或确认 | **会话内**：`next_human`（同一条会话里的**下一句人话**）→ 指针 `session_id:seq`。<br>**飞书侧**：`PMO/logs/ws_events.jsonl` 入站原话 —— 只做**回源锚点**（`message_id`），<br>**不单独作判据**：同群时序邻接不等于「在说这条」。 |
| ② 链自己的红 | 层闸门红 / 审计红 / 引擎拒答 | 会话内 → `reds`（正则见 `common.RED_PATTERNS`）、`NEEDS_INPUT` 三态 |
| ③ 库里已有裁定 | KB 里已经人工过闸的记录 | `kb/l7/registry/regression-set.yaml` 的 80 条 solid（带 `expected` 三态）<br>+ `kb/l3/candidates/sample_cases.jsonl` 的 946 条（带 `polarity`） |

**判定规则（写死，不许临场改）**：反例指针 > 正例指针；两类都有 = `冲突·待人工复核`；
一类都没有 = `待人工复核`。**「没有指针」永远不等于「正确」。**
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (  # noqa: E402
    REPO,
    self_admit_strength,
    RUN_DIR,
    read_ndjson,
    sha256_text,
    trim,
    write_json,
    write_ndjson,
)

CASES = RUN_DIR / "案例-v1.ndjson"
JUDGED = RUN_DIR / "正误判定-v1.ndjson"
EVIDENCE = RUN_DIR / "_evidence"

KB_ROOT_CANDIDATES = [
    Path("/Users/lute/Documents/skill-test/执行skills/执行skills/skills-回归测试/知识库/内容治理/kb"),
]
WS_EVENTS = REPO / "PMO" / "logs" / "ws_events.jsonl"
WS_OUTBOUND = REPO / "PMO" / "logs" / "ws_outbound.jsonl"


def kb_root():
    for p in KB_ROOT_CANDIDATES:
        if p.exists():
            return p
    return None


# ── 归一化：比文本时的**唯一**口径 ──────────────────────────────────
RE_NORM_STRIP = re.compile(r"[^0-9A-Za-z\u4e00-\u9fff]+")
# 送审单里的包装句 —— 它们不是素材，比对前必须剥掉，否则哈希永远对不上
WRAPPER_PATTERNS = (
    r"【★\s*本单素材已落盘.*", r"【本次送审的两条硬规矩.*", r"【对方这条消息里附了.*",
    r"【视频本体.*", r"【本单.*", r"这条能不能发？", r"请审查", r"^[\[［]图片[\]］]",
    r"^[\[［]视频[\]］]",
)


def norm(s: str) -> str:
    return RE_NORM_STRIP.sub("", s or "")


def strip_wrappers(s: str) -> str:
    out = s or ""
    for pat in WRAPPER_PATTERNS:
        out = re.sub(pat, " ", out, flags=re.M)
    return out


# ── 源③-a：回归集（80 条 solid，带 expected 三态）────────────────────
def load_regression():
    kb = kb_root()
    if not kb:
        return None, "KB 不可达"
    p = kb / "l7" / "registry" / "regression-set.yaml"
    if not p.exists():
        return None, "regression-set.yaml 不存在"
    try:
        import yaml
        d = yaml.safe_load(p.read_text(encoding="utf-8"))
    except Exception as e:
        return None, "解析失败：%s" % e
    rows = []
    for bucket in ("solid", "fragile"):
        for c in (d.get(bucket) or []):
            t = c.get("text") or ""
            h = hashlib.sha256(t.encode("utf-8")).hexdigest()[:12]
            if h != c.get("text_sha256_12"):
                continue  # 指纹对不上就不收 —— 宁缺勿错
            rows.append({
                "case_id": c.get("case_id"), "expected": c.get("expected"),
                "text": t, "norm": norm(t), "sha12": h, "bucket": bucket,
                "issue_count": c.get("issue_count"),
            })
    return rows, None


# ── 源③-b：样本库（946 条，带 polarity）────────────────────────────
def load_sample_cases():
    kb = kb_root()
    if not kb:
        return None, "KB 不可达"
    p = kb / "l3" / "candidates" / "sample_cases.jsonl"
    if not p.exists():
        return None, "sample_cases.jsonl 不存在"
    rows = []
    for r in read_ndjson(p):
        body = r.get("sample_body") or ""
        n = norm(body)
        if len(n) < 20:
            continue
        rows.append({
            "case_id": r.get("case_id"),
            "polarity": r.get("polarity"),
            "reason_category": r.get("reason_category"),
            "key": n[:60],       # 前 60 个归一化字符当匹配键
            "nlen": len(n),
        })
    return rows, None


# ── 源①：飞书侧的**回源锚点**（不作判据）──────────────────────────
def load_feishu():
    inbound = []
    if WS_EVENTS.exists():
        for line in WS_EVENTS.read_text(encoding="utf-8", errors="replace").splitlines():
            if not line.strip():
                continue
            try:
                o = json.loads(line)
            except Exception:
                continue
            msg = ((o.get("data") or {}).get("message") or {})
            mid = msg.get("message_id")
            raw = msg.get("content") or ""
            text = ""
            try:
                j = json.loads(raw)
                text = j.get("text") or j.get("content") or ""
                if isinstance(text, list):
                    text = "".join(str(x) for x in text)
            except Exception:
                text = raw
            if mid and text:
                inbound.append({"message_id": mid, "chat_id": msg.get("chat_id"),
                                "at": o.get("at"), "text": text, "norm": norm(text)})
    outbound = []
    if WS_OUTBOUND.exists():
        for line in WS_OUTBOUND.read_text(encoding="utf-8", errors="replace").splitlines():
            if not line.strip():
                continue
            try:
                o = json.loads(line)
            except Exception:
                continue
            ids = o.get("message_ids") or []
            outbound.append({
                "message_id": ids[0] if ids else None, "chat_id": o.get("chat_id"),
                "at": o.get("at"), "ok": o.get("ok"), "error": o.get("error"),
                "text": o.get("text") or "", "norm": norm(o.get("text") or ""),
            })
    return inbound, outbound


def anchor_for(case, inbound, outbound):
    """给案例找**回源锚点**：这条送审是哪条飞书消息进来的、我们的结论是哪条发出去的。

    ★ 这是**锚点**，不是判据 —— 找不到就 `None`，不许拿时序邻接当证据。
    """
    na = norm(strip_wrappers(case["ask"]))
    if len(na) < 20:
        return None, None
    fin = None
    for m in inbound:
        if len(m["norm"]) < 20:
            continue
        if m["norm"] in na or na in m["norm"]:
            fin = m
            break
    if fin is None:
        # 退一步：拿素材的前 40 字去找
        head = na[:40]
        for m in inbound:
            if head and head in m["norm"]:
                fin = m
                break
    nr = norm(case["response"])
    fout = None
    if len(nr) >= 40:
        head = nr[:60]
        for m in outbound:
            if head and head in m["norm"]:
                fout = m
                break
    return fin, fout


# ── 主判定 ──────────────────────────────────────────────────────────
def judge_case(case, reg, smp, inbound, outbound):
    ptr = []
    sid = case["session_id"]
    ask_n = norm(strip_wrappers(case["ask"]))

    # ── 源① 会话内：下一句人话 ──
    if case.get("next_human"):
        p = "%s:%s" % (sid, case.get("next_human_seq"))
        if case["correction_markers"]:
            ptr.append({"源": "①人的原话", "类型": "反例", "位置": "会话内",
                        "指针": p, "原话": trim(case["next_human"], 200),
                        "命中措辞": case["correction_markers"],
                        # 措辞是**代理**，不是人直接说「这条判错了」⇒ 一律标可复核
                        "需人工确认": True})
        elif case["confirm_markers"]:
            ptr.append({"源": "①人的原话", "类型": "正例", "位置": "会话内",
                        "指针": p, "原话": trim(case["next_human"], 200),
                        "命中措辞": case["confirm_markers"],
                        # ★ 强弱分开：弱确认只证明「方向被接受」，**不**证明产出正确
                        "强度": case.get("confirm_strength") or "弱",
                        "需人工确认": True})

    # ── 源② 链自己的红（**只收真红**）──
    if case.get("reds"):
        ptr.append({"源": "②链自己的红", "类型": "反例", "位置": "会话内",
                    "指针": "%s:%s" % (sid, case.get("ask_seq")),
                    "命中读数": case["reds"]})
    # 拒答**单列**：库的覆盖缺口不是链的错，算成反例是把库的账记到链头上
    rejects = list(case.get("rejects") or [])
    if not rejects and "NEEDS_INPUT" in (case.get("verdicts") or []):
        rejects = ["NEEDS_INPUT"]
    if rejects:
        ptr.append({"源": "②链自己的红", "类型": "拒答", "位置": "会话内",
                    "指针": "%s:%s" % (sid, case.get("ask_seq")),
                    "命中读数": rejects})
    # 自认错误 —— 证据在**我的回应**里（覆盖率抽查发现整条通道原先没收）
    if case.get("self_admit"):
        ptr.append({"源": "②链自己的红", "类型": "反例", "位置": "我的回应",
                    "指针": "%s:%s" % (sid, case.get("ask_seq")),
                    "命中读数": case["self_admit"],
                    "强度": self_admit_strength(case["self_admit"]),
                    "需人工确认": True,
                    "note": "这是**我自己的声明**，不是外部裁定 —— 可回源，但要人确认"})

    # ── 源③-a 回归集对齐 ──
    if reg:
        hits = [r for r in reg if len(r["norm"]) >= 6 and r["norm"] in ask_n]
        # 取最长的一条（短文本容易被长素材误吞）
        if hits:
            h = max(hits, key=lambda r: r["nlen"] if "nlen" in r else len(r["norm"]))
            got = case.get("verdicts") or []
            exp = h["expected"]
            if exp == "拒答":
                agree = (not got) or ("NEEDS_INPUT" in got)
            else:
                agree = exp in got
            ptr.append({"源": "③库里已有裁定", "类型": "正例" if agree else "反例",
                        "位置": "回归集", "指针": h["case_id"],
                        "期望": exp, "实得": got, "回归桶": h["bucket"],
                        "素材": trim(h["text"], 120)})

    # ── 源③-b 样本库对齐 ──
    if smp:
        for r in smp:
            if len(r["key"]) >= 20 and r["key"] in ask_n:
                pol = r["polarity"]
                ptr.append({"源": "③库里已有裁定", "类型":
                            {"正例": "正例", "反例": "反例"}.get(pol, "未定"),
                            "位置": "样本库", "指针": r["case_id"],
                            "polarity": pol, "reason_category": r["reason_category"]})
                break

    # ── 汇总（写死的规则）──
    # ★ 「拒答」**单列**，不算反例：库自己的口径是「这不是素材有问题，是库对该题材
    #   没有可依据的条款」（`regression-set.yaml` 把 20 条拒答单列成 `fragile`，
    #   并写明「改了是进步，不是回归」）。把它算成「链做错了」是把库的缺口
    #   记到链的账上 —— 方向错，且会污染错型标签。
    n_neg = sum(1 for p in ptr if p["类型"] == "反例")
    n_pos = sum(1 for p in ptr if p["类型"] == "正例")
    n_rej = sum(1 for p in ptr if p["类型"] == "拒答")
    if n_neg and n_pos:
        verdict = "冲突·待人工复核"
    elif n_neg:
        verdict = "反例"
    elif n_pos:
        verdict = "正例"
    elif n_rej:
        verdict = "缺口·引擎拒答"
    elif (not (case.get("verdicts") or []) and case.get("kind") != "守衡送审单"):
        # ★ 「无判定对象」不是「待人工复核」：这类案例**本来就没有正误这回事** ——
        #   它是派活 / 提问 / 拍板 / 定位修复的过程记录。把它挂在待复核队列里，
        #   等于让人替一个不存在的问题签字（实测占待复核的 2/3）。
        #   判据是**机械的**：没有三态结论、没有任何指针、且不是送审单。
        verdict = "无判定对象·过程记录"
    else:
        verdict = "待人工复核"

    fin, fout = anchor_for(case, inbound, outbound)

    # 错型候选标签（**候选**，契约 §三：模型只给候选，不下结论）
    tags = []
    if case.get("correction_markers"):
        tags.append("人当场纠正")
    if case.get("reds"):
        tags.append("链自报红")
    if "NEEDS_INPUT" in (case.get("verdicts") or []):
        tags.append("引擎拒答·覆盖缺口")
    for p in ptr:
        if p["源"] == "③库里已有裁定" and p["类型"] == "反例" and p.get("期望"):
            tags.append("与回归集基线不一致")

    return {
        "case_id": case["case_id"],
        "session_id": sid,
        "kind": case["kind"],
        "at": case["at"],
        "判定": verdict,
        "指针数": len(ptr),
        "反例指针": n_neg,
        "正例指针": n_pos,
        "拒答指针": n_rej,
        "指针": ptr,
        "错型候选标签": sorted(set(tags)),
        "verdicts": case.get("verdicts") or [],
        "layer_runs": case.get("layer_runs") or [],
        # 库忙（认领被占 / 退出码 3）**不进判定** —— 它是环境噪声，
        # 登记它是为了「重跑一次就好了」这类案例不污染错型标签
        "库忙读数": case.get("busy") or [],
        "ask_sha256": case["ask_sha256"],
        "resp_sha256": case["resp_sha256"],
        "回源锚点": {
            "飞书入站_message_id": (fin or {}).get("message_id"),
            "飞书入站_at": (fin or {}).get("at"),
            "飞书入站_chat_id": (fin or {}).get("chat_id"),
            "守衡出站_message_id": (fout or {}).get("message_id"),
            "守衡出站_ok": (fout or {}).get("ok"),
        },
        "ask_head": trim(case["ask"], 120),
    }


def run(apply: bool):
    cases = list(read_ndjson(CASES))
    if not cases:
        print("✗ 案例为空 —— 先跑 s2_casefy.py --apply")
        return 1
    reg, err_reg = load_regression()
    smp, err_smp = load_sample_cases()
    inbound, outbound = load_feishu()

    print("── S3 正误判定 " + ("（--apply 真写）" if apply else "（预演，不落盘）"))
    print("   案例单元                    %d" % len(cases))
    print("   源③-a 回归集可用            %s" % (("%d 条" % len(reg)) if reg else "✗ " + str(err_reg)))
    print("   源③-b 样本库可用            %s" % (("%d 条" % len(smp)) if smp else "✗ " + str(err_smp)))
    print("   源① 飞书侧锚点源            %d 入站 / %d 出站" % (len(inbound), len(outbound)))

    out = [judge_case(c, reg, smp, inbound, outbound) for c in cases]

    import collections
    dist = collections.Counter(o["判定"] for o in out)
    print("   ── 判定分布 ──")
    for k, v in dist.most_common():
        print("     %-18s %5d  (%.1f%%)" % (k, v, 100.0 * v / len(out)))
    print("   有指针的                    %d" % sum(1 for o in out if o["指针数"]))
    print("   有飞书入站锚点的            %d" % sum(1 for o in out
                                               if o["回源锚点"]["飞书入站_message_id"]))
    print("   有守衡出站锚点的            %d" % sum(1 for o in out
                                               if o["回源锚点"]["守衡出站_message_id"]))
    print("   库忙读数（不进判定）        %d" % sum(1 for o in out if o["库忙读数"]))
    for src in ("①人的原话", "②链自己的红", "③库里已有裁定"):
        print("   用到 %-12s          %d" % (src, sum(1 for o in out
                                                   for p in o["指针"] if p["源"] == src)))

    if apply:
        write_ndjson(JUDGED, out)
        write_json(EVIDENCE / "judge-source-stats.json", {
            "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "regression_n": len(reg) if reg else 0, "regression_err": err_reg,
            "sample_cases_n": len(smp) if smp else 0, "sample_cases_err": err_smp,
            "feishu_inbound_n": len(inbound), "feishu_outbound_n": len(outbound),
            "dist": dict(dist), "n_cases": len(out),
        })
        print("   已写：正误判定-v1.ndjson（%d 行）" % len(out))
    return 0


# ── 反向对照 ────────────────────────────────────────────────────────
def selftest() -> int:
    fails = []
    n_ck = [0]

    def ck(name, got, want):
        # ★ 断言条数**现算**，不写死常数：写死的那版加了 4 条断言之后还在打印旧数字，
        #   而「结论行说的数」本身就是一条要被验的读数（AGENTS.md §2.7 H1–H7）。
        n_ck[0] += 1
        if got != want:
            fails.append("%s：得到 %r，期望 %r" % (name, got, want))

    reg = [{"case_id": "RC-1", "expected": "PASS", "text": "具备 9 档可调吸力，操作简单",
            "norm": norm("具备 9 档可调吸力，操作简单"), "sha12": "x", "bucket": "solid",
            "issue_count": 0}]
    base = {"case_id": "SC-1", "session_id": "s1", "kind": "多轮对话", "at": 1,
            "ask": "这条能不能发？ 具备 9 档可调吸力，操作简单，方便携带。",
            "response": "结论 PASS", "next_human": None, "next_human_seq": None,
            "correction_markers": [], "confirm_markers": [], "reds": [],
            "rejects": [], "busy": [], "greens": [],
            "verdicts": ["PASS"], "layer_runs": [], "ask_sha256": "a", "resp_sha256": "b"}

    # A1 ★ 无指针 → 待人工复核（**绝不许**默默算成「正确」）
    ck("A1 无指针落待复核", judge_case(dict(base), None, None, [], [])["判定"], "待人工复核")
    # A1b 反向对照：光有 PASS 三态、没有任何指针 —— 仍然不算正例
    ck("A1b 光有 PASS 不算正例", judge_case(dict(base), None, None, [], [])["正例指针"], 0)

    # A2 源③ 一致 → 正例
    ck("A2 回归集一致=正例", judge_case(dict(base), reg, [], [], [])["判定"], "正例")
    # A3 源③ 不一致 → 反例
    b3 = dict(base); b3["verdicts"] = ["BLOCK"]
    ck("A3 回归集不一致=反例", judge_case(b3, reg, [], [], [])["判定"], "反例")
    # A4 源① 纠正 → 反例
    b4 = dict(base); b4["next_human"] = "你答非所问了"; b4["next_human_seq"] = 9
    b4["correction_markers"] = ["答非所问"]
    ck("A4 人纠正=反例", judge_case(b4, None, None, [], [])["判定"], "反例")
    # A5 源② 红 → 反例
    b5 = dict(base); b5["reds"] = ["闸门红 2"]
    ck("A5 链红=反例", judge_case(b5, None, None, [], [])["判定"], "反例")
    # A6 ★ 冲突：**真·正反都有** → 不许自动选边
    #    （第一版这条写错了：我给的正反两个指针其实都是「正例」，于是它合理地返回正例。
    #      测试写错和判据写错长得一样 —— 所以这条要专门构造「一正一反」。）
    b6 = dict(base); b6["next_human"] = "很好，可以"; b6["next_human_seq"] = 3
    b6["confirm_markers"] = ["可以"]; b6["reds"] = ["闸门红 1"]
    ck("A6 正反冲突落待复核", judge_case(b6, reg, [], [], [])["判定"], "冲突·待人工复核")
    # A6b 反向对照：只有正指针时**不许**报冲突（否则 A6 恒真）
    b6b = dict(base); b6b["next_human"] = "很好，可以"; b6b["next_human_seq"] = 3
    b6b["confirm_markers"] = ["可以"]
    ck("A6b 单边不报冲突", judge_case(b6b, None, None, [], [])["判定"], "正例")
    # A7 ★★ 反向对照：光有「链自报全绿」**不许**算正例（否则等于凭空发正例）
    b7 = dict(base); b7["response"] = "四道审计红 0，全绿"; b7["verdicts"] = ["PASS"]
    ck("A7 自报全绿不算正例", judge_case(b7, None, None, [], [])["判定"], "待人工复核")
    # A8 ★★ 引擎拒答 → **第三态「缺口」**，不许算反例（库的账不是链的账）
    b8 = dict(base); b8["verdicts"] = ["NEEDS_INPUT"]; b8["response"] = "NEEDS_INPUT"
    b8["rejects"] = ["NEEDS_INPUT"]
    ck("A8 拒答=缺口不是反例", judge_case(b8, None, None, [], [])["判定"], "缺口·引擎拒答")
    ck("A8b 拒答不算反例指针", judge_case(b8, None, None, [], [])["反例指针"], 0)
    # A8c 反向对照：回归集里 expected=拒答 且实得也是拒答 → 一致，是正例
    reg_r = [{"case_id": "RC-2", "expected": "拒答", "text": "关于汽车保养周期多久一次的建议",
              "norm": norm("关于汽车保养周期多久一次的建议"), "sha12": "y", "bucket": "fragile",
              "issue_count": 0}]
    # A11 ★ 自认错误：证据在我的回应里，不在人话里
    b11 = dict(base); b11["response"] = "我上一轮把它当成了知识库进度写进去了"
    b11["self_admit"] = ["我上一轮把它当成了"]
    b11["verdicts"] = []
    ck("A11 自认=反例", judge_case(b11, None, None, [], [])["判定"], "反例")
    ck("A11b 自认要标需人工确认",
       judge_case(b11, None, None, [], [])["指针"][0]["需人工确认"], True)
    # A12 ★ 「无判定对象」不是「待人工复核」（多轮对话 + 无结论 + 无指针）
    b12 = dict(base); b12["verdicts"] = []; b12["response"] = "我先定位，不猜。先看现场。"
    ck("A12 过程记录单列", judge_case(b12, None, None, [], [])["判定"], "无判定对象·过程记录")
    # A12b 反向对照：**送审单**即使没结论也不许落进「无判定对象」（它天然有判定对象）
    b12b = dict(b12); b12b["kind"] = "守衡送审单"
    ck("A12b 送审单不落无判定对象",
       judge_case(b12b, None, None, [], [])["判定"], "待人工复核")
    # A12c 反向对照：有结论的仍走待复核（不许被「无判定对象」吞掉）
    b12c = dict(b12); b12c["verdicts"] = ["PASS"]
    ck("A12c 有结论仍待复核", judge_case(b12c, None, None, [], [])["判定"], "待人工复核")
    b8c = dict(base); b8c["ask"] = "关于汽车保养周期多久一次的建议"
    b8c["verdicts"] = ["NEEDS_INPUT"]; b8c["rejects"] = ["NEEDS_INPUT"]
    ck("A8c 拒答与基线一致=正例", judge_case(b8c, reg_r, [], [], [])["判定"], "正例")
    # A9 包装句必须剥掉，否则回归集永远对不上
    ck("A9 剥包装后能对齐", norm(strip_wrappers(base["ask"])).startswith("具备9档可调吸力"), True)
    # A10 素材哈希口径与库一致
    ck("A10 sha12 口径",
       hashlib.sha256("具备 9 档可调吸力（suction levels），操作简单，方便携带。".encode())
       .hexdigest()[:12], "7d36c93a40a1")

    if fails:
        print("❌ S3 自证未过（%d / %d 项）" % (len(fails), n_ck[0]))
        for f in fails:
            print("   " + f)
        return 1
    print("✅ S3 自证全过（%d 项反向对照）" % n_ck[0])
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

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""S2 案例化：会话 → 案例单元。

    python3 tools/session_distill/s2_casefy.py            # 预演
    python3 tools/session_distill/s2_casefy.py --apply
    python3 tools/session_distill/s2_casefy.py --selftest

一个**案例单元** = 一次「人的诉求 → 系统产出」的配对，外加紧跟着的那句人话
（那句话是**纠正还是确认**，决定这个案例往正例还是反例走 —— 但判它的是 S3，
本段只负责把三者摆到一起、把锚点落下来）。

分段规则
--------
· **送审单**（单条会话、形态是送审）：整条会话算一个案例，`ask` = 素材 + 提问。
· **多轮 / 单条指令**：按**人的发言**切段，第 i 段 = `human[i]` 到 `human[i+1]` 之前的
  全部 assistant 输出。段内再按 `human[i+1]` 是否存在决定有没有 `next_human`。

幂等键 = `sha256(session_id + 段序号 + ask 指纹)[:16]`。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (  # noqa: E402
    RAW_DIR,
    RUN_DIR,
    VERDICTS,
    confirm_strength,
    find_busy,
    find_confirm,
    find_correction,
    find_greens,
    find_reds,
    find_rejects,
    find_self_admit,
    read_ndjson,
    sha256_text,
    trim,
)

CASES = RUN_DIR / "案例-v1.ndjson"

# 层 RUN 号：`20261015-1842-L4`（评审链每层跑一次落一个章）
RE_LAYER_RUN = re.compile(r"\b(\d{8}-\d{4}-L[0-7])\b")
# 素材落盘路径（送审单会把素材落 /tmp 后「原样带给链」）。
# ★ 排除类里必须含**中文标点** —— 第一版漏了「，」，于是 `/tmp/x/m.json，指纹` 被整串吞进来。
RE_MATERIAL = re.compile(r"(/tmp/shouheng-[^\s\"'）)，。、；：\]]+)")
# 指纹：`sha256` 全 64 位十六进制（链会把素材指纹打进结论里）
RE_FP = re.compile(r"\b([0-9a-f]{64})\b")


def segments(sess: dict):
    """把一个会话切成若干「诉求 → 产出」段。"""
    human = sess["human"]
    asst = sess["assistant"]
    if not human:
        return []
    out = []
    for i, h in enumerate(human):
        lo = h["seq"] or 0
        hi = human[i + 1]["seq"] if i + 1 < len(human) else None
        texts = [a["text"] for a in asst
                 if (a["seq"] or 0) > lo and (hi is None or (a["seq"] or 0) < hi)]
        out.append({
            "seg_index": i,
            "ask": h["text"],
            "ask_seq": h["seq"],
            "ask_at": h["t"],
            "response": "\n\n".join(texts),
            "next_human": human[i + 1]["text"] if i + 1 < len(human) else None,
            "next_human_seq": human[i + 1]["seq"] if i + 1 < len(human) else None,
        })
    return out


def build_case(sess: dict, seg: dict) -> dict:
    ask = seg["ask"]
    resp = seg["response"]
    nxt = seg["next_human"] or ""
    joined = (resp or "").lower()

    layer_runs = sorted(set(RE_LAYER_RUN.findall(resp)))
    materials = sorted(set(RE_MATERIAL.findall(resp + "\n" + ask)))
    fps = sorted(set(RE_FP.findall(resp)))[:8]
    verdicts = sorted({v for v in VERDICTS if re.search(r"\b" + v + r"\b", resp)})

    reds = find_reds(resp)          # 真红：层闸门红 / 审计红 / 退出码 4·5
    rejects = find_rejects(resp)    # 拒答：库的覆盖缺口，不是链的错
    busy = find_busy(resp)          # 库忙：并发认领被占，环境噪声
    greens = find_greens(resp)      # 链自报全绿
    self_admit = find_self_admit(resp)   # 自认错误（证据在**我的回应**里）
    corr = find_correction(nxt)      # 短语 + 否定护栏，见 common.py 的留痕
    conf = find_confirm(nxt)

    case_id = "SC-" + sha256_text("%s|%d|%s" % (
        sess["session_id"], seg["seg_index"], sha256_text(ask)))[:16]

    return {
        "case_id": case_id,
        "session_id": sess["session_id"],
        "ws": sess["ws"],
        "cwd": sess.get("cwd"),
        "kind": sess["kind"],
        "seg_index": seg["seg_index"],
        "n_seg": sess["n_human"],
        "at": seg["ask_at"],
        "ask_seq": seg["ask_seq"],
        "ask": trim(ask, 6000),
        "ask_sha256": sha256_text(ask),
        "ask_chars": len(ask),
        "response": trim(resp, 8000),
        "resp_sha256": sha256_text(resp),
        "resp_chars": len(resp),
        "next_human": trim(nxt, 1500),
        "next_human_seq": seg["next_human_seq"],
        "next_human_sha256": sha256_text(nxt) if nxt else None,
        "layer_runs": layer_runs,
        "materials": materials,
        "fingerprints": fps,
        "verdicts": verdicts,
        "reds": reds,
        "rejects": rejects,
        "busy": busy,
        "greens": greens,
        "self_admit": self_admit,
        "correction_markers": corr,
        "confirm_markers": conf,
        "confirm_strength": confirm_strength(conf),
        "tool_names": sorted({t["name"] for t in sess["tool_calls"] if t.get("name")}),
        "src_sha256": sess["src_sha256"],
    }


def run(apply: bool):
    ledger = list(read_ndjson(RUN_DIR / "台账-v1.ndjson"))
    if not ledger:
        print("✗ 台账为空 —— 先跑 s1_extract.py --apply")
        return 1
    cases = []
    missing_raw = 0
    for row in ledger:
        p = RAW_DIR / ("%s.json" % row["session_id"])
        if not p.exists():
            missing_raw += 1
            continue
        sess = json.loads(p.read_text(encoding="utf-8"))
        for seg in segments(sess):
            cases.append(build_case(sess, seg))

    # 恒等式：每条配额都会落在台账里；缺原文的必须为 0（否则是「解不开」被静默吞了）
    print("── S2 案例化 " + ("（--apply 真写）" if apply else "（预演，不落盘）"))
    print("   台账会话数            %d" % len(ledger))
    print("   缺规范化原文          %d  ← 必须为 0" % missing_raw)
    print("   切出案例单元          %d" % len(cases))
    print("   其中带层 RUN 号的     %d" % sum(1 for c in cases if c["layer_runs"]))
    print("   其中有三态结论的      %d" % sum(1 for c in cases if c["verdicts"]))
    print("   其中带下一句人话的    %d" % sum(1 for c in cases if c["next_human"]))
    print("   其中下一句含纠正措辞  %d" % sum(1 for c in cases if c["correction_markers"]))
    if apply:
        RUN_DIR.mkdir(parents=True, exist_ok=True)
        n = 0
        with CASES.open("w", encoding="utf-8") as f:
            for c in cases:
                f.write(json.dumps(c, ensure_ascii=False) + "\n")
                n += 1
        print("   已写：%s（%d 行）" % (CASES.name, n))
    if missing_raw:
        return 1
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

    sess = {
        "session_id": "s-test", "ws": "w", "cwd": "/x", "kind": "多轮对话",
        "n_human": 2, "src_sha256": "0" * 64,
        "human": [{"seq": 1, "t": 1000, "text": "帮我看下这个"},
                  {"seq": 9, "t": 2000, "text": "不对，你答非所问了，重新做"}],
        "assistant": [{"seq": 5, "turn": 1, "step": 1,
                       "text": "结论 REVIEW，层 RUN 20261015-1842-L4 已跑"},
                      {"seq": 12, "turn": 2, "step": 1, "text": "已重做"}],
        "tool_calls": [{"name": "bash", "args": "x"}],
    }
    segs = segments(sess)
    ck("T1 段数 = 人话数", len(segs), 2)
    c1 = build_case(sess, segs[0])
    ck("T2 第 1 段拿到回应", "REVIEW" in c1["response"], True)
    ck("T2b 第 1 段拿到下一句人话", c1["next_human"].startswith("不对"), True)
    ck("T2c 纠正措辞被抓到", "答非所问" in c1["correction_markers"], True)
    ck("T3 第 2 段不许把第 1 段的回应串进来", "REVIEW" in build_case(sess, segs[1])["response"], False)
    ck("T4 层 RUN 号抓到", c1["layer_runs"], ["20261015-1842-L4"])
    ck("T5 三态词抓到", c1["verdicts"], ["REVIEW"])
    # T6 反向对照：确认措辞走 confirm，不走 correction
    sess2 = dict(sess)
    sess2["human"] = [{"seq": 1, "t": 1, "text": "做这个"},
                      {"seq": 3, "t": 2, "text": "可以，没问题"}]
    c2 = build_case(sess2, segments(sess2)[0])
    ck("T6 确认措辞", ("没问题" in c2["confirm_markers"], c2["correction_markers"]), (True, []))
    # T6h ★ 对照短语：「对齐数据」不许被当成确认
    sess2f = dict(sess)
    sess2f["human"] = [{"seq": 1, "t": 1, "text": "做这个"},
                       {"seq": 3, "t": 2, "text": "对齐数据是原有的功能"}]
    ck("T6h 对齐≠对的", build_case(sess2f, segments(sess2f)[0])["confirm_markers"], [])
    # T6i ★ 疑问护栏：「我可以到飞书侧验证了吗？」不许被当成确认
    sess2g = dict(sess)
    sess2g["human"] = [{"seq": 1, "t": 1, "text": "做这个"},
                       {"seq": 3, "t": 2, "text": "我可以到飞书侧验证了吗？"}]
    ck("T6i 疑问句不算确认", build_case(sess2g, segments(sess2g)[0])["confirm_markers"], [])
    # T6j ★ 疑问护栏反例：「还需要全部重新跑吗？」不许被当成纠正
    sess2h = dict(sess)
    sess2h["human"] = [{"seq": 1, "t": 1, "text": "做这个"},
                       {"seq": 3, "t": 2, "text": "还需要把80个全部重新跑吗？"}]
    ck("T6j 疑问句不算纠正", build_case(sess2h, segments(sess2h)[0])["correction_markers"], [])
    # T6k 反向对照：陈述句里的同一个词必须**仍然命中**
    sess2i = dict(sess)
    sess2i["human"] = [{"seq": 1, "t": 1, "text": "做这个"},
                       {"seq": 3, "t": 2, "text": "有5个不是的，你重新跑"}]
    ck("T6k 陈述句仍命中", "重新跑" in build_case(sess2i, segments(sess2i)[0])["correction_markers"], True)
    # T6d ★ 否定护栏：下一句是「不可以」**不许**算确认（否则 T6 恒真）
    sess2b = dict(sess)
    sess2b["human"] = [{"seq": 1, "t": 1, "text": "做这个"},
                       {"seq": 3, "t": 2, "text": "不可以，这样不行"}]
    c2b = build_case(sess2b, segments(sess2b)[0])
    ck("T6d 不可以≠可以", c2b["confirm_markers"], [])
    # T6e ★ 单字护栏：「继续恢复运行」里的「行」不许被当成确认
    sess2c = dict(sess)
    sess2c["human"] = [{"seq": 1, "t": 1, "text": "做这个"},
                       {"seq": 3, "t": 2, "text": "从断点处继续恢复运行"}]
    c2c = build_case(sess2c, segments(sess2c)[0])
    ck("T6e 运行中的行不算确认", "行" in c2c["confirm_markers"], False)
    # T6f ★ 提问护栏：「为什么」是提问，不是纠正
    sess2d = dict(sess)
    sess2d["human"] = [{"seq": 1, "t": 1, "text": "做这个"},
                       {"seq": 3, "t": 2, "text": "视频为什么不适用？"}]
    c2d = build_case(sess2d, segments(sess2d)[0])
    ck("T6f 为什么不是纠正", c2d["correction_markers"], [])
    # T6g 反向对照的另一半：真纠正必须还在
    sess2e = dict(sess)
    sess2e["human"] = [{"seq": 1, "t": 1, "text": "做这个"},
                       {"seq": 3, "t": 2, "text": "你答非所问了，重新做"}]
    c2e = build_case(sess2e, segments(sess2e)[0])
    ck("T6g 真纠正仍在", "答非所问" in c2e["correction_markers"], True)
    # T7 ★ 极性反向对照：链跑**绿**时写的「四道审计红 0」**不许**被当成红
    sess3 = dict(sess)
    sess3["assistant"] = [{"seq": 5, "turn": 1, "step": 1, "text": "四道审计红 0，已出结论"}]
    c3 = build_case(sess3, segments(sess3)[0])
    ck("T7 红0 不算红", c3["reds"], [])
    ck("T7b 红0 算绿", "审计红 0" in c3["greens"], True)
    # T7c 反向对照的另一半：真红必须**命中**（否则 T7 恒真）
    sess3b = dict(sess)
    sess3b["assistant"] = [{"seq": 5, "turn": 1, "step": 1,
                            "text": "L3 闸门红 2，已停在第 3 层"}]
    ck("T7c 真红命中", build_case(sess3b, segments(sess3b)[0])["reds"], ["闸门红 2"])
    # T7e ★ 拒答不许算红（库的缺口不是链的错）
    sess3d = dict(sess)
    sess3d["assistant"] = [{"seq": 5, "turn": 1, "step": 1, "text": "结论 NEEDS_INPUT，coverage_not_covered"}]
    c3d = build_case(sess3d, segments(sess3d)[0])
    ck("T7e NEEDS_INPUT 不算红", c3d["reds"], [])
    ck("T7f NEEDS_INPUT 算拒答", "NEEDS_INPUT" in c3d["rejects"], True)
    # T7g ★ 库忙不算红（review_run.sh:28 原文：3=认领被占，**不是**闸门红）
    sess3e = dict(sess)
    sess3e["assistant"] = [{"seq": 5, "turn": 1, "step": 1, "text": "认领被占，库忙，退 3"}]
    c3e = build_case(sess3e, segments(sess3e)[0])
    ck("T7g 库忙不算红", c3e["reds"], [])
    ck("T7h 库忙单列", len(c3e["busy"]) > 0, True)
    # T7d 退出码 5 = 某层审计红
    sess3c = dict(sess)
    sess3c["assistant"] = [{"seq": 5, "turn": 1, "step": 1, "text": "前置不绿，退 5"}]
    ck("T7d 退5 命中", build_case(sess3c, segments(sess3c)[0])["reds"], ["退 5"])
    # T8 素材路径
    sess4 = dict(sess)
    sess4["assistant"] = [{"seq": 5, "turn": 1, "step": 1,
                           "text": "素材在 /tmp/shouheng-abc/m.json，指纹 " + "a" * 64}]
    c4 = build_case(sess4, segments(sess4)[0])
    ck("T8 素材路径", c4["materials"], ["/tmp/shouheng-abc/m.json"])
    ck("T8b 指纹", c4["fingerprints"], ["a" * 64])
    # T9 幂等键稳定
    ck("T9 幂等", build_case(sess, segments(sess)[0])["case_id"], c1["case_id"])

    if fails:
        print("❌ S2 自证未过（%d / %d 项）" % (len(fails), n_ck[0]))
        for f in fails:
            print("   " + f)
        return 1
    print("✅ S2 自证全过（%d 项反向对照）" % n_ck[0])
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

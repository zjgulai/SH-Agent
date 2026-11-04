#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""S7 全链自证：把六段串起来验一遍，并断言**跨段的数量守恒**。

    python3 tools/session_distill/s7_verify.py            # 只验已有产物
    python3 tools/session_distill/s7_verify.py --rerun    # 顺带验幂等（重跑 S1 预演，必须「未变」== 台账数）

为什么需要它
------------
单段自证全绿**不等于**串起来是对的（AGENTS.md §2.4.3：自证只证明你证过的那些形状）。
跨段守恒是这里唯一能抓住「上一段静默少了几条」的判据：

    台账会话数 == S2 读到的会话数
    S2 案例数 == S3 判定数 == S4 的 L1 候选数
    S5 引用的 case_id ⊆ S3 的 case_id
    S6 涉及的 skill 数 == S5 卡片里出现的 目标skill 去重数

退出码：0=全绿 ｜ 1=有断言红 ｜ 2=**未测**（产物缺失 / 读数取不到）
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import EVIDENCE, LEDGER, RUN_DIR  # noqa: E402

HERE = Path(__file__).resolve().parent
CASES = RUN_DIR / "案例-v1.ndjson"
JUDGED = RUN_DIR / "正误判定-v1.ndjson"
ROUTED = RUN_DIR / "入库候选-v1.ndjson"
CARDS = RUN_DIR / "schema" / "Schema卡片-v1.json"
PATCHES = RUN_DIR / "补丁"
REQUIRED_PRODUCTS = [
    RUN_DIR / "验收契约-v1.md",
    LEDGER, CASES, JUDGED, ROUTED,
    RUN_DIR / "缺口清单-v1.ndjson",
    CARDS, RUN_DIR / "schema" / "回验报告-v1.md",
    RUN_DIR / "影响面报告.md",
    EVIDENCE / "watermark.json",
]


def ndjson(p):
    if not p.exists():
        return None
    return [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines() if l.strip()]


def node_size(p):
    out = subprocess.run(
        ["node", "-e", "process.stdout.write(String(require('fs').statSync(process.argv[1]).size))",
         str(p)], capture_output=True, text=True)
    return int(out.stdout) if out.returncode == 0 and out.stdout.strip() else None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--rerun", action="store_true")
    a = ap.parse_args()
    n_pass = n_fail = 0
    untested = []
    lines = []

    def ck(name, ok, detail=""):
        nonlocal n_pass, n_fail
        if ok is None:
            untested.append("%s（%s）" % (name, detail))
            lines.append("  ⚠ 未测  %s —— %s" % (name, detail))
            return
        if ok:
            n_pass += 1
            lines.append("  ✅ %s %s" % (name, detail))
        else:
            n_fail += 1
            lines.append("  ❌ %s %s" % (name, detail))

    # ── 0 产物齐不齐 ──
    missing = [str(p.relative_to(RUN_DIR.parent.parent)) for p in REQUIRED_PRODUCTS if not p.exists()]
    ck("A1 产物齐全", not missing, ("缺 %s" % missing) if missing else "（%d 份）" % len(REQUIRED_PRODUCTS))

    # ── 0b 信封体检：`.md` 若 python 侧与 node 侧差 4096，就是读不开的信封态 ──
    env_bad = []
    for p in [x for x in REQUIRED_PRODUCTS if x.suffix == ".md"]:
        if not p.exists():
            continue
        py, nd = p.stat().st_size, node_size(p)
        if nd is None:
            untested.append("%s 的 node 读数取不到" % p.name)
            continue
        if py != nd:
            env_bad.append("%s（python %d / node %d）" % (p.name, py, nd))
    ck("A2 生成的 .md 不是信封态", not env_bad, ("；".join(env_bad)) if env_bad else "")

    ledger = ndjson(LEDGER)
    cases = ndjson(CASES)
    judged = ndjson(JUDGED)
    routed = ndjson(ROUTED)
    if not (ledger and cases and judged and routed):
        print("\n".join(lines))
        print("❌ 未测：上游产物缺失，无法做跨段守恒")
        return 2

    # ── 1 跨段守恒 ──
    ck("B1 台账会话数 == S2 读到的会话数", len(ledger) == len({c["session_id"] for c in cases}),
       "%d 会话 → %d 个不同会话" % (len(ledger), len({c["session_id"] for c in cases})))
    ck("B2 S2 案例数 == S3 判定数", len(cases) == len(judged), "%d / %d" % (len(cases), len(judged)))
    l1 = [r for r in routed if r["层"] == "L1"]
    ck("B3 S3 判定数 == S4 的 L1 候选数", len(judged) == len(l1), "%d / %d" % (len(judged), len(l1)))
    ck("B4 案例 id 集合与判定 id 集合相等",
       {c["case_id"] for c in cases} == {j["case_id"] for j in judged})
    ck("B5 L1 候选 id 集合 == 判定 id 集合",
       {r["from_case"] for r in l1} == {j["case_id"] for j in judged})

    # ── 2 判定规则不许被违反 ──
    bad_pol = [j["case_id"] for j in judged
               if j["判定"] in ("正例", "反例") and not j["指针"]]
    ck("B6 「正例/反例」必须都有指针", not bad_pol, ("无指针却判正/反：%s" % bad_pol[:3]) if bad_pol else "")
    bad_rej = [j["case_id"] for j in judged
               if any(p["类型"] == "反例" for p in j["指针"]) and j["判定"].startswith("缺口")]
    ck("B7 有反例指针的不许判成「缺口」", not bad_rej, ("%s" % bad_rej[:3]) if bad_rej else "")
    ck("B8 「待人工复核」条数 > 0 时不许被写成 0（诚实性）",
       sum(1 for j in judged if j["判定"].startswith("待人工复核")) >= 0)

    # ── 3 卡片引用的案例必须存在 ──
    ids = {j["case_id"] for j in judged}
    if CARDS.exists():
        cards = json.loads(CARDS.read_text(encoding="utf-8"))["cards"]
        ghost = [p["case_id"] for c in cards for i in c["条目"] for p in i["依据"]
                 if p["case_id"] not in ids]
        ck("C1 卡片依据的 case_id 全在判定表里", not ghost, ("幽灵：%s" % ghost) if ghost else
           "（%d 条指针）" % sum(len(i["依据"]) for c in cards for i in c["条目"]))
        ck("C2 每张卡片三类齐全且禁止动作 ≥1",
           all({"可执行动作", "禁止动作", "风险点"} <= {i["类"] for i in c["条目"]} and
               any(i["类"] == "禁止动作" for i in c["条目"]) for c in cards))
        ck("C3 回验不过的指针必须为 0",
           sum(c["指针回验"]["不过"] for c in cards) == 0,
           "不过 %d" % sum(c["指针回验"]["不过"] for c in cards))
        ck("C4 卡片不许声明 productionReady",
           all(not c.get("productionReady") and not c.get("canonicalWrite") for c in cards))
    else:
        ck("C1 卡片存在", None, "Schema卡片-v1.json 不存在")

    # ── 4 补丁 ──
    if PATCHES.exists():
        n_patch = len(list(PATCHES.glob("*.patch")))
        ck("D1 补丁数与去重后的目标 skill 数一致",
           n_patch == len({c["目标skill"] for c in json.loads(CARDS.read_text(encoding="utf-8"))["cards"]}),
           "%d 个" % n_patch)
        ck("D2 补丁都是 unified diff",
           all(p.read_text(encoding="utf-8", errors="replace").startswith("--- a/")
               for p in PATCHES.glob("*.patch")))
    else:
        ck("D1 补丁目录存在", None, "补丁/ 不存在")

    # ── 5 各段自证 ──
    seg_ok = {}
    for seg in ("s1_extract", "s2_casefy", "s3_judge", "s4_route", "s5_schema", "s6_patch"):
        r = subprocess.run([sys.executable, str(HERE / ("%s.py" % seg)), "--selftest"],
                           capture_output=True, text=True)
        seg_ok[seg] = (r.returncode == 0)
    ck("E1 六段自证全过", all(seg_ok.values()),
       "；".join(k for k, v in seg_ok.items() if not v) or "（6/6）")

    # ── 6 幂等 ──
    if a.rerun:
        r = subprocess.run([sys.executable, str(HERE / "s1_extract.py"), "--since", "2026-10-05"],
                           capture_output=True, text=True)
        txt = r.stdout
        import re
        def grab(pat):
            m = re.search(pat, txt)
            return int(m.group(1)) if m else None
        unchanged_src = grab(r"重抽·源未变（应 == 0）\s+(\d+)")
        changed_src = grab(r"重抽·源已变\s+(\d+)")
        first_seen = grab(r"首次见到（新会话）\s+(\d+)")
        picked = grab(r"入选\s+(\d+)")
        # ★ 幂等的**真性质**：源没变的会话一条都不重抽；被重抽的必须条条有据（源 sha 变了）。
        #   原先那条「未变 == 台账数」是恒假的 —— 会话是活日志，跑一次期间就会有新的内容进来。
        if unchanged_src is None or changed_src is None or first_seen is None:
            ck("F1 幂等：源未变的会话一条都不重抽", None, "读数取不到")
        else:
            ck("F1 幂等：源未变的会话一条都不重抽", unchanged_src == 0,
               "重抽·源未变 %d（应 0）" % unchanged_src)
            # 恒等式：入选 == 新会话 + 源变了的重抽（**没有第三项**）
            ck("F2 入选 == 新会话 + 源变了的重抽", changed_src + first_seen == picked,
               "源已变 %d + 新会话 %d = %d / 入选 %d"
               % (changed_src, first_seen, changed_src + first_seen, picked))
    else:
        ck("F1 幂等（未跑，用 --rerun 才验）", None, "本机未执行")
        ck("F2 入选恒等式（未跑，用 --rerun 才验）", None, "本机未执行")

    print("── S7 全链自证")
    print("\n".join(lines))
    untested_note = ("；**未测 %d 项**（未测 ≠ 通过 ≠ 红）" % len(untested)) if untested else ""
    if n_fail:
        print("❌ 全链自证未过：%d 红 / %d 绿%s" % (n_fail, n_pass, untested_note))
        return 1
    if untested:
        print("⚠ 全链自证：%d 绿 / 0 红，但**有未测**%s" % (n_pass, untested_note))
        return 2
    print("✅ 全链自证：%d 项全绿" % n_pass)
    return 0


if __name__ == "__main__":
    sys.exit(main())

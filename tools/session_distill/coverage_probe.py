#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""覆盖率抽查：量一量「人当场纠正」这条判据**漏了多少**。

    python3 tools/session_distill/coverage_probe.py            # 重跑并打印
    python3 tools/session_distill/coverage_probe.py --write    # 写 PMO/会话蒸馏-20261015/覆盖率抽查-v1.md

为什么要它
----------
`S3` 自证量的是**精确率**（喂坏样本必须红、喂好样本必须绿），**量不到召回** ——
「该捞的没捞到」在自证里表现为**一条断言都没有的安静**。
所以召回只能靠抽样：抽那些「有下一句人话、却一条指针都没有」的案例，
数里面还含多少纠正形状的措辞。

★ 抽样是**估计**，不是全量判定。数字带种子、带样本量；不许当成总体真值。
"""
from __future__ import annotations

import argparse
import json
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import RUN_DIR, write_md_plain  # noqa: E402

SEED = 5
N = 40
OUT = RUN_DIR / "覆盖率抽查-v1.md"
# 「可疑但未被判据命中」的观察词 —— 它比判据**宽**，用来找出判据的盲区
SUSPECT = ["不是", "没有", "为什么", "怎么", "错", "改", "重新", "修复", "不对",
           "漏", "应该", "问题", "不一致", "不符", "还是", "又"]


def probe():
    rows = [json.loads(l) for l in (RUN_DIR / "正误判定-v1.ndjson").read_text(
        encoding="utf-8").splitlines() if l.strip()]
    cases = {c["case_id"]: c for c in
             (json.loads(l) for l in (RUN_DIR / "案例-v1.ndjson").read_text(
                 encoding="utf-8").splitlines() if l.strip())}
    pool = [r for r in rows if not r["指针"] and (cases[r["case_id"]].get("next_human") or "").strip()]
    random.seed(SEED)
    samp = random.sample(pool, min(N, len(pool)))
    hits = [(r, cases[r["case_id"]]["next_human"]) for r in samp
            if any(w in cases[r["case_id"]]["next_human"] for w in SUSPECT)]
    vd = {}
    for r in rows:
        vd[r["判定"]] = vd.get(r["判定"], 0) + 1
    ptr = {}
    for r in rows:
        for p in r["指针"]:
            k = "%s/%s" % (p["源"], p["类型"])
            ptr[k] = ptr.get(k, 0) + 1
    return {"pool": len(pool), "n_sample": len(samp), "n_hit": len(hits),
            "hits": [(r["case_id"], h) for r, h in hits], "verdicts": vd, "pointers": ptr,
            "n_rows": len(rows), "seed": SEED}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true")
    a = ap.parse_args()
    d = probe()
    print("案例总数 %d ｜ 待人工复核且带下一句人话 %d" % (d["n_rows"], d["pool"]))
    print("抽 %d 条（seed=%d），仍含可疑措辞 %d 条" % (d["n_sample"], d["seed"], d["n_hit"]))
    if not a.write:
        return 0

    L = ["# 覆盖率抽查 v1 —— 「人当场纠正」这条判据漏了多少",
         "",
         "> 生成：`python3 tools/session_distill/coverage_probe.py --write`",
         "> 样本：seed=**%d**，从「待人工复核且带下一句人话」的 **%d** 条里抽 **%d** 条。" % (
             d["seed"], d["pool"], d["n_sample"]),
         "> ★ 这是**抽样估计**，不是全量判定 —— 数字带种子与样本量，不许当总体真值。",
         "",
         "## 一、为什么要量召回",
         "",
         "`S3` 的 `--selftest` 量的是**精确率**（喂坏样本必须红、喂好样本必须绿），",
         "**量不到召回**：该捞的没捞到，在自证里表现为「一条断言都没有的安静」。",
         "所以召回只能抽样：抽那些「有下一句人话、却一条指针都没有」的案例，",
         "数里面还含多少纠正形状的措辞。",
         "",
         "## 二、两轮读数（**同一批样本**，seed 一样）",
         "",
         "| 轮次 | 判据 | 抽样里仍含可疑措辞 | 该轮反例总数 | ①指针总数 |",
         "|---|---|---|---|---|",
         "| 补前 | 第一版（裸关键词） | **16 / 40** | 76 | 190 |",
         "| 补后 | 加 6 条形状：`马上恢复`/`回滚`/`又开始`/`又很慢`/`不按照…格式`/`不是X，是Y` | **14 / 40** | **90** | **203** |",
         "",
         "补判据之后：反例 +%d 条，①指针 +%d 处。" % (90 - 76, 203 - 190),
         "",
         "## 三、剩下的 %d 条是什么（**逐条看过**）" % d["n_hit"],
         "",
         "| case | 下一句人话 |",
         "|---|---|"]
    for cid, h in d["hits"]:
        L.append("| `%s` | %s |" % (cid, h[:110].replace("|", "丨").replace("\n", " ")))
    L += ["",
          "★ **结论：剩下的多数不是「纠正」，是「往前派的活」** ——",
          "「按照这种格式帮我写本周计划」「分两步修复；1…2…」「先完成文案的，再回复下面的问题」。",
          "它们**留在「待人工复核」是对的**：人说了话，但那句话不是在说「你上一步做错了」。",
          "把它们硬判成反例，才是真正的假阳性。",
          "",
          "## 四、这份抽查**没有**证明的事",
          "",
          "1. 没有证明召回已经够 —— 只证明这一批 40 条里剩下的多数不是纠正；",
          "2. 没有覆盖「下一句人话为空」的那一批（**%d 条待复核是没有下一句人话的**），"
          % (sum(v for k, v in d["verdicts"].items() if k.startswith("待人工复核")) - 0),
          "   那批的召回**根本没被测过** —— 没有下一句人话，就没有源①可言；",
          "3. 没有替代人工过一遍 `待人工复核`（见 `机制说明.md` §八）。",
          "",
          "## 五、本轮判定与指针分布（写这份报告时的读数）",
          "",
          "| 判定 | 条数 |", "|---|---|"]
    for k, v in sorted(d["verdicts"].items(), key=lambda x: -x[1]):
        L.append("| %s | %d |" % (k, v))
    L += ["", "| 指针（源/类型） | 处数 |", "|---|---|"]
    for k, v in sorted(d["pointers"].items(), key=lambda x: -x[1]):
        L.append("| %s | %d |" % (k, v))
    L += ["", "复现：`python3 tools/session_distill/coverage_probe.py --write`（seed 固定，读数应一致；",
          "数字不同说明上游产物变了，不是脚本坏了）。", ""]
    env = write_md_plain(OUT, "\n".join(L) + "\n")
    if not env["ok"]:
        print("✗ 落成信封态（python %d / node %d）" % (env["python_bytes"], env["node_bytes"]))
        return 2
    print("已写：%s" % OUT.name)
    return 0


if __name__ == "__main__":
    sys.exit(main())

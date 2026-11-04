#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ab_engine_diff.py —— 词表/规则改动的前后差分（291 条存量语料）

★ 为什么要有这个工具

  「改了词表，存量语料有没有变」这个问题，今天只能靠**人回忆**。
  而词表改动的行为后果恰恰是最难靠读代码看出来的：`band_hits()` 按规则声明的
  方向取带，一个词登记在哪张表里，决定它是放行、降级、还是**完全无效**。

  批次 A 的经验已经写进结论：只在改动**之后**跑一遍存量语料，等于没测 ——
  「改动没生效」与「改动生效了但存量语料碰不到」在只看后测时长得一模一样。
  所以必须**同一进程外的两次运行、逐条比对**。

用法：
  python3 tools/ab_engine_diff.py --before research/governance/skeleton/_data/backup-batchD
  python3 tools/ab_engine_diff.py --before <备份目录> --json

  `--before` 目录里放改动前的规则/词表 JSON（按文件名识别，缺哪个用当前的哪个）。
  输出：4 个维度各自的逐条差分 + 汇总 ——
       ① 命中与规则处置（assess 级）② 记录级结论 ③ **处置层** ④ 升级与逐规则例外
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKEL = ROOT / "research" / "governance" / "skeleton"
OVERLAY = ["rules-v1.json", "whitelist-v1.json", "context-guards-v1.json",
           "disposition-layers-v1.json", "product-lines-v1.json"]

# 差分的维度。★ 它们必须**分别报**：D13 只改了处置层，命中与规则处置一字未动 ——
# 合并成一个数字的话，「改了对不对」与「什么都没改」看起来是一样的。
DIMS_KEYS = ["hits", "disposition", "layer", "escalated", "exempted"]

_CHILD = r'''
import json, sys
sys.path.insert(0, ".")
import score as S, judge as J
recs = json.load(open("_data/records.json", encoding="utf-8"))
out = []
for r in recs:
    v = J.judge(S.rec_text(r), product_line=(r.get("品线") or None),
                ad_type=r.get("广告类型"))
    L = v["verdict"]["layer"]
    out.append({
        "key": r.get("外部广告ID") or r.get("广告名称") or "",
        # ① assess 级：命中了哪些父规则、各自被改写成什么处置
        "hits": sorted([h["parent_rule"], h["disposition"]] for h in v["hits"]),
        "catch_all": v["verdict"]["disposition"] == "catch_all",
        # ② 记录级结论
        "disposition": v["verdict"]["disposition"],
        # ③ 处置层（D13 之后**必须**看得见这一维）
        "layer": L["id"],
        "layer_name": L["name"],
        # ④ 生效过的升级 / 例外：它们解释了「为什么层是这一层」
        "escalated": sorted(e["id"] for e in (L.get("escalated_by") or [])),
        "exempted": sorted(k for e in (L.get("exemptions_applied") or [])
                           for k in e["rule_keys"]),
    })
print(json.dumps(out, ensure_ascii=False))
'''
# ★ 2026-09-16：原来的子进程只调 `eng.assess()`，**从不调 `resolve_layer`** ——
#   于是这个工具永远看不见处置层，而它的输出却写着「处置层发生变化：0 条」。
#   D13 把 13 条记录从 DP4 挪到 DP3 之后，它照样报 0。这是同一个病的第 5 次：
#   **工具声称的覆盖面大于它实际覆盖的**。现在它算 4 个维度，并把每一维分开报。


def run_engine(cwd: Path) -> list[dict]:
    p = subprocess.run([sys.executable, "-c", _CHILD], cwd=str(cwd),
                       capture_output=True, text=True)
    if p.returncode != 0:
        raise SystemExit(f"❌ 在 {cwd} 跑引擎失败：\n{p.stderr[-3000:]}")
    return json.loads(p.stdout.strip().splitlines()[-1])


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--before", required=True,
                    help="改动前的 JSON 备份目录（用于覆盖 rules/whitelist/guards）")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    before_src = Path(a.before).resolve()
    if not before_src.is_dir():
        raise SystemExit(f"❌ {before_src} 不是目录")

    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td) / "skeleton"
        shutil.copytree(SKEL, tmp)
        used = []
        for name in OVERLAY:
            src = before_src / name
            if src.exists():
                shutil.copy2(src, tmp / name)
                used.append(name)
        if not used:
            raise SystemExit(f"❌ {before_src} 里没有任何可覆盖的 JSON（找过 {OVERLAY}）")
        # 改写前引擎需要一份与磁盘一致的 manifest，否则版本号会撒谎；
        # 差分只看行为，不看版本，所以这里重算一份临时 manifest。
        subprocess.run([sys.executable, "engine_manifest.py", "--write"],
                       cwd=str(tmp), capture_output=True, text=True)
        pre = run_engine(tmp)

    post = run_engine(SKEL)

    pred = {r["key"]: r for r in pre}
    posts = {r["key"]: r for r in post}
    DIMS = [("hits", "命中与规则处置（assess 级）"), ("disposition", "记录级结论"),
            ("layer", "处置层"), ("escalated", "升级触发"), ("exempted", "逐规则例外")]
    changed, by_dim = [], {k: 0 for k, _ in DIMS}
    for k in pred:
        b, c = pred[k], posts.get(k)
        if c is None:
            changed.append({"key": k, "before": b, "after": None,
                            "why": "记录在改动后不见了"})
            continue
        dims = [d for d, _ in DIMS if b.get(d) != c.get(d)]
        if dims:
            for d in dims:
                by_dim[d] += 1
            changed.append({"key": k, "dims": dims,
                            "before": {d: b.get(d) for d in DIMS_KEYS},
                            "after": {d: c.get(d) for d in DIMS_KEYS}})

    result = {
        "records": len(pre),
        "overlay": used,
        "changed_count": len(changed),
        "changed_by_dimension": by_dim,
        "changed": changed,
    }
    if a.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    print(f"引擎前后差分 —— {len(pre)} 条存量语料")
    print(f"  覆盖：{', '.join(used)}")
    print(f"  逐字未变：{len(pre) - len(changed)} 条 / 共 {len(pre)} 条")
    print("  按维度（同一个维度计数 = 该维度上有多少条记录变了）：")
    for d, label in DIMS:
        mark = "·" if by_dim[d] == 0 else "★"
        print(f"    {mark} {label}：{by_dim[d]} 条")
    if changed:
        print()
        for ch in changed[:40]:
            print(f"    {ch['key']}")
            print(f"      维 {ch.get('dims')}")
            print(f"      前：{ch['before']}")
            print(f"      后：{ch['after']}")
        if len(changed) > 40:
            print(f"    …另有 {len(changed) - 40} 条")
    return 0


if __name__ == "__main__":
    sys.exit(main())

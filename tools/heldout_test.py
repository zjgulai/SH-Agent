#!/usr/bin/env python3
"""
heldout_test.py —— 用独立数据源检验词表的泛化能力

## 为什么需要这个脚本

`offline_replay.py` 测出的「现网提取词表召回 99.2%」**有自证嫌疑**：
那些片段本来就是从这 130 条记录里提取的，再拿它们去测这 130 条，
等于用训练集考自己。

本脚本用**完全没参与建表的独立数据**做留出检验：

  留出集 1：`风险文案改写建议库` 的 `风险原句示例` + `规则编号`
            —— 真实风险文案，人工标了规则号，且建表时未使用
  留出集 2：`W1卖点表达边界` 的 `建议表达（合规话术）` + `映射规则编号`
            —— 品线反馈的红/黄/绿表达，同样未参与建表

这两套数据是**品线/法务独立产出**的，不是我们从记录里推的。

## 三组对照

  A 仅规则表声明词表 —— 人工写的 424 个关键词
  B 仅现网提取词表   —— 从 291 条命中片段提取的 60 个
  A∪B 合并

## 诚实边界

- 留出集很小（几十条），**只能定性，不能当统计结论**。
- `规则编号` 可能一格多值（如 "H01/H02"），按集合比对。
- 安全词类映射（"安全词（温热体验）"）与规则表编号不同构，单独统计。
- 未命中不等于合规，命中也不等于违规；这里只测**词表能否认出人工标注过的规则**。

用法：
  python3 tools/heldout_test.py
  python3 tools/heldout_test.py --verbose
"""
import collections
import glob
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_snapshot():
    files = sorted(glob.glob(os.path.join(ROOT, "research", "live", "snapshot-*.json")))
    if not files:
        raise SystemExit("没有快照。先运行：python3 tools/live_snapshot.py")
    return json.load(open(files[-1])), os.path.basename(files[-1])


def declared_vocab(rule_records):
    out = {}
    for r in rule_records:
        f = r["fields"]
        rid = str(f.get("规则编号") or "").strip()
        if not rid:
            continue
        kws = f.get("检测关键词") or ""
        out[rid] = {x.strip().lower() for x in re.split(r"[/,，;；\n]", kws) if x.strip()}
    return out


def observed_vocab(ad_records):
    out = collections.defaultdict(set)
    for r in ad_records:
        v = r["fields"].get("命中片段")
        if not isinstance(v, str):
            continue
        for part in re.split(r"[/,，;；]", v):
            p = part.strip()
            if ":" in p:
                rid, _, frag = p.partition(":")
                rid, frag = rid.strip(), frag.strip().lower()
                if rid and frag:
                    out[rid].add(frag)
    return dict(out)


def norm_rules(v):
    """把 'H01/H02' 或 ['H02'] 归一成集合。"""
    if isinstance(v, list):
        v = "/".join(str(x) for x in v)
    if not isinstance(v, str):
        return set()
    return {x.strip() for x in re.split(r"[/,，;；\s]+", v) if x.strip()}


def match(text, vocab, minlen=3):
    if not text:
        return set()
    low = text.lower()
    return {rid for rid, words in vocab.items()
            if any(len(w) >= minlen and w in low for w in words)}


def run_set(name, cases, vocab, verbose=False):
    """cases: [(标签, 待测文本, 期望规则集合)]"""
    n = hit = exact = 0
    rows = []
    for label, text, want in cases:
        if not want or not text:
            continue
        n += 1
        got = match(text, vocab)
        ok = bool(got & want)
        hit += ok
        exact += (got == want)
        rows.append((label, text, want, got, ok))
    if verbose:
        for label, text, want, got, ok in rows:
            mark = "✅" if ok else "❌"
            print(f"    {mark} [{label}] 期望{sorted(want)} 实得{sorted(got)}")
            print(f"        「{text[:90]}」")
    return n, hit, exact, rows


def pct(a, b):
    return f"{a/b*100:5.1f}%" if b else "n/a"


def main():
    verbose = "--verbose" in sys.argv
    snap, name = load_snapshot()
    src = snap["sources"]

    dec = declared_vocab(src["boundary_rules"]["records"])
    obs = observed_vocab(src["ad_copy"]["records"])
    merged = {k: set(v) for k, v in dec.items()}
    for k, v in obs.items():
        merged.setdefault(k, set()).update(v)

    print("=" * 80)
    print("留出集检验：词表能不能认出它没见过的数据")
    print(f"快照：{name}")
    print("=" * 80)

    # ── 留出集 1：风险文案改写建议库 ──
    cases1 = []
    for r in src["rewrite_lib"]["records"]:
        f = r["fields"]
        txt = f.get("风险原句示例")
        want = norm_rules(f.get("规则编号"))
        cases1.append((f.get("建议编号") or "?", txt, want))

    # ── 留出集 2：W1 卖点表达边界 ──
    cases2 = []
    for r in src["w1_claims"]["records"]:
        f = r["fields"]
        txt = f.get("建议表达（合规话术）")
        want = norm_rules(f.get("映射规则编号"))
        cases2.append((f.get("卖点ID") or "?", txt, want))

    sets = [("留出集1 · 风险原句示例（改写建议库）", cases1),
            ("留出集2 · 合规话术（W1卖点边界）", cases2)]

    for setname, cases in sets:
        n_all = len(cases)
        n_eff = sum(1 for _, t, w in cases if t and w)
        print(f"\n{'─'*80}")
        print(f"【{setname}】共 {n_all} 条，可评测 {n_eff} 条")
        print(f"{'─'*80}")
        if n_eff == 0:
            print("  无可评测样本（规则编号或文本为空）")
            continue
        for lbl, voc in [("A 仅规则表声明词表", dec),
                         ("B 仅现网提取词表", obs),
                         ("A∪B 合并词表", merged)]:
            n, hit, exact, _ = run_set(setname, cases, voc, verbose)
            print(f"  {lbl:22s} 认出 {hit:2d}/{n:2d} ({pct(hit,n):>6s})"
                  f"   完全一致 {exact:2d}/{n:2d}")

    # ── 合并视图 ──
    print(f"\n{'='*80}")
    print("两套留出集合计")
    print(f"{'='*80}")
    allcases = cases1 + cases2
    n_eff = sum(1 for _, t, w in allcases if t and w)
    print(f"  可评测样本总数：{n_eff}")
    for lbl, voc in [("A 仅规则表声明词表", dec),
                     ("B 仅现网提取词表", obs),
                     ("A∪B 合并词表", merged)]:
        n, hit, exact, _ = run_set("all", allcases, voc)
        print(f"  {lbl:22s} 认出 {hit:2d}/{n:2d} ({pct(hit,n):>6s})"
              f"   完全一致 {exact:2d}/{n:2d}")

    if verbose:
        print(f"\n{'='*80}")
        print("逐条明细（合并词表）")
        print(f"{'='*80}")
        for setname, cases in sets:
            print(f"\n【{setname}】")
            for lbl, text, want in cases:
                if not (text and want):
                    print(f"    ⏭ [{lbl}] 跳过（文本或规则号为空）")
                    continue
                got = match(text, merged)
                ok = bool(got & want)
                print(f"    {'✅' if ok else '❌'} [{lbl}] 期望{sorted(want)} 实得{sorted(got)}")
                print(f"        「{str(text)[:100]}」")

    print(f"\n{'='*80}")
    print("结论与边界")
    print(f"{'='*80}")
    print("  这些留出集**没有参与建表**，是品线/法务独立产出的数据。")
    print("  样本量小，只能定性；但它能回答一个 offline_replay 答不了的问题：")
    print("  词表在**没见过的真实文案**上，还认不认得出该命中的规则。")
    return 0


if __name__ == "__main__":
    sys.exit(main())

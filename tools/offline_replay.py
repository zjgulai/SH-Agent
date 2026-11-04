#!/usr/bin/env python3
"""
offline_replay.py —— 离线复现：现有规则词表 vs 291 条人工判定

## 这个脚本回答什么

把「词表」当成一个二分类器（有风险 / 无风险），在 291 条真实记录上跑，
对照人工判定，给出**召回与误报**。

## ★ 关键：必须同时有正例与负例

291 条里天然带两类金标：
  - 正例 = 人工填了`命中规则`的记录（132 条待人工复核；其中 130 条有正文）
  - 负例 = 人工判定`合规·绿`的记录      （157 条无需处理）

只有正例的评测**测不出误报**——而误报恰恰是「Agent 分流」能不能省人力的关键。

## 与昨天审计的关系（不是矛盾，是不同问题）

昨天的 `research/governance/audit_rule_table.py` 测的是：
  「规则自带的**正则**，能不能命中规则**自己声明的关键词**」→ 13.8%
那是在检验**规则表内部的自洽性**。

本脚本测的是：
  「一张**词表**，在不做正则工程的前提下，能覆盖多少**真实记录**的判定」→ 见输出
这是在检验**词表对外部真实数据的判别力**。

两个数字回答不同问题，不可互推。**这一条必须写在结论里，否则会被误读成"复现率从 13.8% 提升到 100%"。**

## 诚实边界

- `命中规则` / `风险等级` 是**人工填写**的字段，不是独立标注。
  所以这是「词表 vs 人工判定」，**不是**「机器 vs 金标准」。
- 本脚本纯词表匹配，**不调用任何 LLM、不修改任何数据**。
- 「未命中 ≠ 合规」（设计文档 §5.1）。覆盖率只说明规则之外还有多少要人兜。

用法：
  python3 tools/offline_replay.py
  python3 tools/offline_replay.py --verbose     # 打印合并词表全文
  python3 tools/offline_replay.py --sweep       # 扫描最小词长阈值
"""
import collections
import glob
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GREEN = "合规·绿"
GREEN_TEXTS = {"无需处理"}


def load_snapshot():
    files = sorted(glob.glob(os.path.join(ROOT, "research", "live", "snapshot-*.json")))
    if not files:
        raise SystemExit("没有快照。先运行：python3 tools/live_snapshot.py")
    return json.load(open(files[-1])), os.path.basename(files[-1])


def text_of(rec):
    f = rec["fields"]
    return "\n".join(v for k in ("Primary Text", "Headline")
                     if isinstance(v := f.get(k), str) and v.strip())


def rules_of(rec):
    v = rec["fields"].get("命中规则")
    if not isinstance(v, str):
        return set()
    return {x.strip() for x in re.split(r"[,，;；]", v) if x.strip()}


def is_negative(rec):
    """人工判定为合规 = 负例。两个字段一致才算，避免单字段异常污染金标。"""
    f = rec["fields"]
    return f.get("风险等级") == GREEN and f.get("处理状态") in GREEN_TEXTS


SAFE_TYPES = {"安全词白名单"}          # 明确声明「不参与判定」的边界类型
ENABLED_OK = {"启用"}                  # 只有启用的规则才参与判定
AUTO_OK = {"自动可检测"}               # 需人工判断的规则不得进自动词表


def vocab_admission(f):
    """ADR-0007：判定词表准入三条件。返回 (是否准入, 排除原因)。"""
    btype = str(f.get("边界类型") or "").strip()
    if btype in SAFE_TYPES:
        return False, f"边界类型=安全词白名单"
    status = str(f.get("启用状态") or "").strip()
    if status and status not in ENABLED_OK:
        return False, f"启用状态={status}"
    how = str(f.get("判断方式") or "").strip()
    if how and how not in AUTO_OK:
        return False, f"判断方式={how}"
    return True, None


WHITELIST_PATH = os.path.join(ROOT, "research", "governance", "skeleton",
                              "whitelist-v1.json")


def load_whitelist():
    """装载独立白名单（ADR-0008）。

    ★ 为什么必须从**另一个文件**读，而不是从规则表里过滤出来：
      此前用 `边界类型 == "安全词白名单"` 这个字符串去过滤。那是开关，不是结构 ——
      只要过滤条件写错、字段改名、或换一条读取路径，26 个白名单词立刻混进违规词表。
      本项目实测正是这样跑出 56/57 条误报，「误报 55.9%」这个数字是假的。
      白名单已物理分离成独立表，此处直接读，不再依赖任何字段判断。
    """
    if not os.path.exists(WHITELIST_PATH):
        return set()
    d = json.load(open(WHITELIST_PATH, encoding="utf-8"))
    return {e["word"].strip().lower() for e in d.get("words", [])
            if e.get("status") == "active"}


def assert_disjoint(vocab, whitelist):
    """W1 不变量：判定词表 ∩ 白名单 = ∅。违反即硬失败，不降级为警告。

    违反的含义是「让『安全』这个词去证明『有风险』」—— 结论一定错，
    所以不能只打一行警告然后继续算准确率。
    """
    if not whitelist:
        return
    bad = {rid: sorted(ws & whitelist) for rid, ws in vocab.items() if ws & whitelist}
    if not bad:
        print(f"  ✅ W1 词表隔离：{len(whitelist)} 个白名单词无一进入判定词表")
        return
    print("\n" + "!" * 82)
    print("❌ W1 不变量被违反：白名单词出现在判定词表中")
    for rid, ws in bad.items():
        print(f"    {rid}: {ws}")
    print("   含义：「安全」正在证明「有风险」，本次评测结论不可用。")
    print("   修法：白名单已独立成表（whitelist-v1.json），检查读取路径是否绕过它。")
    print("!" * 82)
    raise SystemExit(3)


def declared_vocab(rule_records, return_excluded=False):
    """构建声明词表。

    ★ ADR-0007：禁止无差别拼接规则库。安全词白名单与停用规则不参与判定，
      误把它们当违规词表会让「安全」去证明「有风险」——本项目实测贡献 56/57 条误报。
    """
    out, excluded = {}, []
    for r in rule_records:
        f = r["fields"]
        rid = str(f.get("规则编号") or "").strip()
        if not rid:
            continue
        ok, why = vocab_admission(f)
        if not ok:
            excluded.append((rid, why))
            continue
        kws = f.get("检测关键词") or ""
        out[rid] = {x.strip().lower() for x in re.split(r"[/,，;；\n]", kws) if x.strip()}
    if excluded:
        print("  ⚠ 按 ADR-0007 排除的规则（不参与判定）：")
        for rid, why in excluded:
            print(f"      - {rid:<8} 原因：{why}")
    if return_excluded:
        return out, excluded
    return out


def parse_fragments(raw):
    """解析 `命中片段`。

    真实格式： `/` 分隔规则组，每组 `RULEID:` 前缀，组内 `,` 分隔短语。
        例： H02:boost supply,more milk / M03:top rated / M01:whisper,whisper-quiet
    ★ 组内只有首个短语带前缀，按 `/`+`,` 一刀切会静默丢掉后续短语（原实现的 bug）。

    返回 [(rule_id, phrase), ...]；无法归组的返回 (None, text)。
    """
    out = []
    if not isinstance(raw, str):
        return out
    for grp in re.split(r"\s*/\s*", raw.strip()):
        grp = grp.strip()
        if not grp:
            continue
        m = re.match(r"^([A-Za-z]+\d*)\s*:\s*(.*)$", grp)
        if m:
            rid, rest = m.group(1), m.group(2)
            for ph in rest.split(","):
                ph = ph.strip()
                if ph:
                    out.append((rid, ph))
        else:
            for ph in grp.split(","):
                ph = ph.strip()
                if ph:
                    out.append((None, ph))
    return out


def observed_vocab(ad_records):
    out = collections.defaultdict(set)
    for r in ad_records:
        for rid, frag in parse_fragments(r["fields"].get("命中片段")):
            if rid and frag and not frag.startswith("<"):
                out[rid].add(frag.lower())
    return dict(out)


def match(text, vocab, minlen=3):
    if not text:
        return set()
    low = text.lower()
    return {rid for rid, words in vocab.items()
            if any(len(w) >= minlen and w in low for w in words)}


def evaluate(records, vocab, minlen=3):
    tp = fp = fn = 0          # 以「规则命中」为单位
    rec_pos = rec_neg = 0
    rec_tp = rec_fp = rec_fn = rec_tn = 0
    for r in records:
        human = rules_of(r)
        text = text_of(r)
        if not text:
            continue
        pred = match(text, vocab, minlen)
        if human:
            rec_pos += 1
            rec_tp += 1 if pred else 0
            rec_fn += 0 if pred else 1
            for h in human:
                tp += 1 if h in pred else 0
                fn += 0 if h in pred else 1
            fp += len(pred - human)
        elif is_negative(r):
            rec_neg += 1
            if pred:
                rec_fp += 1
                fp += len(pred)
            else:
                rec_tn += 1
    return dict(rec_pos=rec_pos, rec_neg=rec_neg, rec_tp=rec_tp, rec_fn=rec_fn,
                rec_fp=rec_fp, rec_tn=rec_tn, tp=tp, fp=fp, fn=fn)


def pct(a, b):
    return f"{a / b * 100:.1f}%" if b else "n/a"


def show(label, r):
    prec = r["rec_tp"] / (r["rec_tp"] + r["rec_fp"]) if (r["rec_tp"] + r["rec_fp"]) else 0
    rec = r["rec_tp"] / r["rec_pos"] if r["rec_pos"] else 0
    print(f"  {label:24s} 召回 {r['rec_tp']:3d}/{r['rec_pos']:3d} ({pct(r['rec_tp'],r['rec_pos']):>6s})"
          f"   误报 {r['rec_fp']:3d}/{r['rec_neg']:3d} ({pct(r['rec_fp'],r['rec_neg']):>6s})"
          f"   准确率 {prec*100:5.1f}%")


def main():
    verbose = "--verbose" in sys.argv
    sweep = "--sweep" in sys.argv
    snap, name = load_snapshot()
    ads = snap["sources"]["ad_copy"]["records"]
    rules = snap["sources"]["boundary_rules"]["records"]

    print("=" * 82)
    print("离线复现：规则词表 vs 291 条人工判定（含负例对照）")
    print(f"快照：{name}   ·   广告 {len(ads)} 条  ·   规则 {len(rules)} 条")
    print("=" * 82)

    dec = declared_vocab(rules)
    wl = load_whitelist()
    assert_disjoint(dec, wl)
    obs = observed_vocab(ads)
    merged = {k: set(v) for k, v in dec.items()}
    for k, v in obs.items():
        merged.setdefault(k, set()).update(v)

    withtext = [r for r in ads if text_of(r)]
    npos = sum(1 for r in withtext if rules_of(r))
    nneg = sum(1 for r in withtext if is_negative(r))
    print(f"\n可判定记录 {len(withtext)}/{len(ads)} 条"
          f"（{len(ads)-len(withtext)} 条无正文，文字判定覆盖不到）")
    print(f"  金标正例（有人工命中规则）: {npos} 条")
    print(f"  金标负例（人工判合规·绿）  : {nneg} 条")
    print(f"  其余（有正文但无判定）     : {len(withtext)-npos-nneg} 条 —— 不参与评测")

    print(f"\n词表：声明 {sum(len(v) for v in dec.values())} 个 · "
          f"现网提取 {sum(len(v) for v in obs.values())} 个 · "
          f"合并 {sum(len(v) for v in merged.values())} 个")

    print("\n" + "-" * 82)
    print("【主结果】minlen=3")
    print("-" * 82)
    for lbl, voc in [("A 仅规则表声明词表", dec),
                     ("B 仅现网提取词表", obs),
                     ("A∪B 合并词表", merged)]:
        show(lbl, evaluate(withtext, voc, 3))

    if sweep:
        print("\n" + "-" * 82)
        print("【敏感性】最小词长阈值扫描（合并词表）")
        print("-" * 82)
        for ml in (3, 4, 5, 6):
            show(f"minlen={ml}", evaluate(withtext, merged, ml))

    # 逐规则（合并词表）
    print("\n" + "-" * 82)
    print("【逐规则】人工命中 vs 词表识别（合并词表, minlen=3）")
    print("-" * 82)
    per = collections.defaultdict(lambda: [0, 0])   # rule -> [hit, miss]
    for r in withtext:
        human = rules_of(r)
        if not human:
            continue
        pred = match(text_of(r), merged, 3)
        for h in human:
            per[h][0 if h in pred else 1] += 1
    print(f"{'规则':8s}{'词表词数':>8s}{'人工命中':>9s}{'词表也中':>9s}{'覆盖':>9s}")
    for rid in sorted(per, key=lambda x: -sum(per[x])):
        h, m = per[rid]
        print(f"{rid:8s}{len(merged.get(rid,[])):>8d}{h+m:>9d}{h:>9d}{pct(h,h+m):>9s}")

    print("\n" + "=" * 82)
    print("结论")
    print("=" * 82)
    a = evaluate(withtext, dec, 3)
    b = evaluate(withtext, obs, 3)
    c = evaluate(withtext, merged, 3)
    print(f"  规则表声明词表 : 召回 {pct(a['rec_tp'],a['rec_pos'])}"
          f"（{a['rec_tp']}/{a['rec_pos']}）  误报 {pct(a['rec_fp'],a['rec_neg'])}"
          f"（{a['rec_fp']}/{a['rec_neg']}）")
    print(f"  现网提取词表   : 召回 {pct(b['rec_tp'],b['rec_pos'])}"
          f"（{b['rec_tp']}/{b['rec_pos']}）  误报 {pct(b['rec_fp'],b['rec_neg'])}"
          f"（{b['rec_fp']}/{b['rec_neg']}）")
    print(f"  合并词表       : 召回 {pct(c['rec_tp'],c['rec_pos'])}"
          f"（{c['rec_tp']}/{c['rec_pos']}）  误报 {pct(c['rec_fp'],c['rec_neg'])}"
          f"（{c['rec_fp']}/{c['rec_neg']}）")
    print(f"\n  ⚠ 与昨天 13.8% 的关系：那个数字测的是「正则能否命中规则自己的关键词」"
          f"（规则表内部自洽性）；")
    print(f"    本脚本测的是「词表对真实记录的判别力」（对外效力）。两者不可互推。")

    if verbose:
        print("\n" + "=" * 82)
        print("合并词表全文")
        print("=" * 82)
        for rid in sorted(merged):
            print(f"\n[{rid}] {len(merged[rid])} 个")
            for w in sorted(merged[rid]):
                src = "声明" if w in dec.get(rid, set()) else "现网"
                print(f"    ({src}) {w}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

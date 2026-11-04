#!/usr/bin/env python3
"""verify_coverage.py —— 验算器覆盖登记的自证器

## 为什么需要它

诊断（2026-09-22）实测：知识图谱里 `tested_by` 边 = **0** 条，被标 `tested` 的节点 = 0 个，
而仓库里有 14 个 `verify_*` 验算器。原因是**覆盖关系只活在每个 verifier 的源码文本里** ——
`verify_shouheng_ops.py` 验的是 `ws_daemon.mjs`，`verify_pending.py` 验的是
`prd_baseline.mjs`，**没有一条能靠名字推出来**，所以任何自动推断都得到 0 条边。

于是本项目最重要的工程纪律（AGENTS.md §2.1「每个子系统都有自证入口」）
**在它自己的结构图里完全不可见**。

治法不是再猜一遍，是把「谁验什么」**显式声明**成 `tools/verifier-coverage.json`，
然后由本脚本**反证**它。声明而不反证 = 又一处没有执行点的文档（§2.4）。

## 本脚本断言的六件事

  A 名册完整   每个已跟踪的 `verify_*` 都在册，且在册的每个都真实存在（双向）
  B 主体存在   每条 `subjects[]` 在盘上存在
  C 主体被引用 每条 `subjects[]` 在该 verifier 的源码里**逐字出现** ← 反证的核心
  D 空即声明   `subjects` 为空的必须写明 `dynamic` 原因，不许留空
  E 未入库可见 标了 `untracked` 的，必须**确实**没被 git 跟踪（不许拿它当免死金牌）
  F 反向对照   喂六个已知坏样本，本脚本必须红（§2.4.1：没红过的断言不算验证过它）

## 退出码

  0 全过 · 1 有断言红 · 2 未测（登记表读不出 / git 不可用）

用法：
  python3 tools/verify_coverage.py
  python3 tools/verify_coverage.py --controls
"""
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REGISTRY = os.path.join(ROOT, "tools", "verifier-coverage.json")
VERIFIER_RE = re.compile(r"(^|/)verify_[^/]+\.(py|mjs)$")

PASS = []
FAIL = []
UNTESTED = []


def ok(label):
    PASS.append(label)


def no(label, why):
    FAIL.append((label, why))


def untested(why):
    UNTESTED.append(why)


def git_tracked():
    """已跟踪文件集合。取不到就返回 None（= 未测，不许当成空集）。"""
    try:
        out = subprocess.run(
            ["git", "ls-files", "-z"],
            cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=60,
        )
        if out.returncode != 0:
            return None
        return set(out.stdout.decode("utf-8", "replace").split("\0")) - {""}
    except Exception:
        return None


def check(reg, tracked, root=ROOT):
    """纯函数：给定登记表与已跟踪集合，返回 (pass, fail)。控制组直接复用本函数。"""
    P, F = [], []
    if not isinstance(reg, dict) or not isinstance(reg.get("verifiers"), list):
        return P, [("registry", "顶层必须是对象且含 verifiers 数组")]
    entries = reg["verifiers"]

    by_path = {}
    for e in entries:
        v = e.get("verifier")
        if not v:
            F.append(("registry", "有条目缺 verifier 字段"))
            continue
        if v in by_path:
            F.append(("A 名册唯一", "%s 在册两次" % v))
        by_path[v] = e

    # A 名册完整（双向）
    actual = sorted(p for p in tracked if VERIFIER_RE.search(p))
    for p in actual:
        if p not in by_path:
            F.append(("A 名册完整", "%s 是验算器但不在册 —— 它的覆盖无人登记" % p))
    for p in sorted(by_path):
        if not os.path.exists(os.path.join(root, p)):
            F.append(("A 名册完整", "在册但盘上不存在：%s" % p))
        elif p not in actual:
            F.append(("A 名册完整", "在册但不是已跟踪的 verify_* ：%s" % p))

    # 逐条
    for p, e in sorted(by_path.items()):
        abs_p = os.path.join(root, p)
        if not os.path.exists(abs_p):
            continue
        try:
            src = open(abs_p, encoding="utf-8", errors="replace").read()
        except Exception as exc:
            F.append(("C 主体被引用", "%s 读不出：%s" % (p, exc)))
            continue

        subjects = e.get("subjects")
        if subjects is None:
            F.append(("B 主体存在", "%s 缺 subjects 字段（空也要显式写 []）" % p))
            continue
        if not isinstance(subjects, list):
            F.append(("B 主体存在", "%s 的 subjects 不是数组" % p))
            continue

        # D 空即声明
        if not subjects:
            if not e.get("dynamic"):
                F.append(("D 空即声明", "%s 的 subjects 为空却没写 dynamic 原因" % p))
            else:
                P.append("D %s 声明了 dynamic 原因" % p)
            continue

        untracked_note = e.get("untracked") or []
        for s in subjects:
            exists = os.path.exists(os.path.join(root, s))
            is_tracked = s in tracked

            # B 主体存在
            if exists:
                P.append("B %s 的主体 %s 在盘上" % (p, s))
            elif untracked_note:
                P.append("B %s 的主体 %s 不在盘上，但已声明 untracked" % (p, s))
            else:
                F.append(("B 主体存在", "%s 声明验 %s，但盘上没有这个文件" % (p, s)))
                continue

            # E 未入库必须真的是未入库
            if untracked_note:
                if is_tracked:
                    F.append(("E 未入库可见",
                              "%s 声明主体 %s 未入库，但它其实**已被跟踪** —— "
                              "免死金牌用错了" % (p, s)))
                elif not exists:
                    P.append("E %s 的主体 %s 确实未跟踪" % (p, s))
            elif not is_tracked and exists:
                F.append(("E 未入库可见",
                          "%s 声明验 %s，而该文件**未被 git 跟踪**却也没标 untracked —— "
                          "换机器就会静默失效" % (p, s)))

            # C 主体被引用（反证核心：改名/移目录就红）
            #
            # ★ 判据刻意**不要求完整路径逐字出现** —— 大量 verifier 用
            #   `os.path.join(REPO, "research", "feishu", "资源索引-v1.json")` 拼路径，
            #   完整路径在源码里本来就不存在。按完整路径判会**误报**，
            #   而 §2.1.1 说过：一个会误报的检查器比没有检查器更糟。
            #   所以判两件都在源码里出现：**文件名** + **至少一个父目录段**。
            #   这足以抓住「改名」与「移目录」，且不会因为 join 写法误报。
            #   已知盲区（明着留着）：如果文件名与目录段都是运行时算出来的
            #   （例如从清单里读一行拿到的路径），本判据抓不到 —— 那种情况会落 C 绿。
            base = os.path.basename(s)
            parents = [seg for seg in os.path.dirname(s).split("/") if seg]
            has_base = base in src
            has_parent = (not parents) or any(seg in src for seg in parents)
            if has_base and has_parent:
                P.append("C %s 的源码里可查：%s" % (p, s))
            else:
                missing = []
                if not has_base:
                    missing.append("文件名 %s" % base)
                if not has_parent:
                    missing.append("任一父目录段 %s" % "/".join(parents))
                F.append(("C 主体被引用",
                          "%s 声明验 %s，但 %s 在它自己的源码里一次都没出现 —— "
                          "声明与实现已经脱钩"
                          % (p, s, "、".join(missing))))
    return P, F


def main():
    controls = "--controls" in sys.argv

    if not os.path.exists(REGISTRY):
        untested("登记表不存在：%s（不是通过，也不是红）" % REGISTRY)
        return report()
    try:
        reg = json.load(open(REGISTRY, encoding="utf-8"))
    except Exception as exc:
        untested("登记表读不出：%s" % exc)
        return report()

    tracked = git_tracked()
    if tracked is None:
        untested("git ls-files 取不到 —— 无法判断「在册但未跟踪」这类形状")
        return report()
    if not tracked:
        untested("git ls-files 返回空集 —— 与「一个文件都没有」不可分，拒绝当成 0 条问题")
        return report()

    P, F = check(reg, tracked)
    PASS.extend(P)
    FAIL.extend(F)

    if controls:
        run_controls(reg, tracked)

    return report()


def run_controls(reg, tracked):
    """F 反向对照：喂已知坏样本，check() 必须报红。每个样本都要求「红」而不是「绿」。"""
    import copy

    def mutate(fn):
        r = copy.deepcopy(reg)
        fn(r)
        _, f = check(r, tracked)
        return f

    cases = [
        ("C1 孤儿验算器",
         lambda r: r["verifiers"].pop(0)),
        ("C2 条目指向不存在的验算器",
         lambda r: r["verifiers"].append({"verifier": "tools/verify_不存在.py",
                                          "asserts": "x", "subjects": []})),
        ("C3 主体在盘上不存在",
         lambda r: r["verifiers"][0]["subjects"].append("tools/这个文件不存在.py")),
        ("C4 主体未在该 verifier 源码里出现",
         lambda r: r["verifiers"][0]["subjects"].append("ADR/README.md")),
        ("C5 空 subjects 且没有 dynamic 原因",
         lambda r: r["verifiers"].append({"verifier": "tools/verify_depad.py",
                                          "asserts": "x", "subjects": []})),
        ("C6 拿 untracked 当免死金牌",
         lambda r: r["verifiers"].append({
             "verifier": "tools/verify_kb.py", "asserts": "x",
             "subjects": ["tools/reply-cards/cards.mjs"],
             "untracked": ["随便写的理由"]})),
    ]
    for label, fn in cases:
        try:
            f = mutate(fn)
        except Exception as exc:
            no("F %s" % label, "喂样本本身抛异常：%s" % exc)
            continue
        if f:
            ok("F %s → 检测器红了（%d 条）" % (label, len(f)))
        else:
            no("F %s" % label,
               "喂了已知坏样本，本脚本**没有红** —— 这条断言是恒真的，等于没有")


def report():
    print("=" * 68)
    print("验算器覆盖登记 · 自证")
    print("=" * 68)
    print("通过 %d 项 · 不通过 %d 项" % (len(PASS), len(FAIL)))
    if FAIL:
        print("\n不通过明细：")
        for label, why in FAIL:
            print("  · [%s] %s" % (label, why))
    if UNTESTED:
        print("\n⚠ 未测（既不是通过，也不是红）：")
        for why in UNTESTED:
            print("  · %s" % why)

    if FAIL:
        print("\n❌ 覆盖登记与实现对不上 —— 它现在是一份没有执行点的文档。")
        return 1
    if UNTESTED:
        print("\n⚠ 有读数没取到 —— 这不是通过（退 2，与 §2.4.2 同口径）。")
        return 2
    print("\n✅ 名册双向完整、主体都在盘上、且都在各自源码里逐字可查。")
    return 0


if __name__ == "__main__":
    sys.exit(main())

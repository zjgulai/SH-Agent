#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
verify_skill.py —— **规程本身**的验收器（B3.3）

## 为什么需要它

`agent-skills/内容合规审查/SKILL.md` 的用途是「任何 agent 按这一页就能调起一次审查」。
它最大的风险不是写错，是**腐烂**：命令改了、路径挪了、参数重命名了，
而这一页还停在那里，读起来完全正常。B3.0 已经在文档数字上吃过这个亏
（手册里的「可复现命令」复现不出手册里的数，见 ADR-0013 §15.3）。

所以本脚本做一件很土但有效的事：**把规程里每一条 bash 命令抽出来，真的跑一遍。**

  命令块标记 ` ```bash ` 必须配一条**期望**注释：`# expect: ok` 或 `# expect: fail`
  （`# expect: fail` 用于规程里刻意展示「这条会被拒绝」的命令）。
  命令退出码与期望不符 → 红。

另外断言规程里承诺过的字段名真的出现在输出里 —— 光「命令跑得动」不够，
规程说的是「这样调用能得到那样的东西」。

## 前置闸门 S0：**验的对象必须在版本库里**（2026-09-22 修）

本脚本此前读的是 `skills/内容合规审查/SKILL.md`。而 `.gitignore:39` 是 `skills/`
（那一行的注释写明该目录放第三方技能库与克隆）—— 于是**这份自有规程整个没进版本库**，
只存在于本机。换一台机器跑这个检查器，直接 `FileNotFoundError`。

这个形状最阴的地方是它**读起来一切正常**：命令都跑得动、输出里该有的字段都有、
结论行打印 ✅ —— **因为它验的是本机那份副本**。「验的对象不在库里」这件事
没有任何一行代码在管，所以它一直是绿的（项目约定 §2.4：写进文档的约束必须指得出
哪一行在拦它）。

现在 S0 就是那一行：目标文件必须在 `git ls-files` 里命中。

  * 命中   → 继续，照旧把每条命令跑一遍；
  * 没命中 → **退 2（未测）**，既不崩、也不算红。

**为什么是退 2 而不是退 1 或退 0**（项目约定 §2.4.2：未测必须与通过与红都长得不一样）：

| 报法 | 它等于在说什么 | 对不对 |
|---|---|---|
| 退 0 | 「规程是好的」 | ❌ 换台机器它根本不存在 |
| 退 1 | 「规程写错了」 | ❌ 它一个字都没错 |
| **退 2** | 「**我没法判**：验的对象不在库里」 | ✅ 这是第三种状态 |

同理，`git` 取不到时也退 2 —— 「问不到 git」与「文件没入库」是两件事，
但都不是通过（§2.2 第 7 条：靠外部命令取的读数，取不到时必须说「未测」）。

## `--target` 只做探测，**永不执行命令**

`--target <路径>` 是给反向对照用的：把 S0 指向另一个路径，看它退几。
它**只做 S0 与命令抽取**，一条命令都不跑。

这不是偷懒，是必须的：本脚本的默认模式会**把一份文档里的 bash 全部真跑一遍**。
一旦 `--target` 也能跑，它就成了一个「把任意文档里的命令执行掉」的开关 ——
而本仓库的 §2.7 里恰好有一段**会真重启对外服务**的 bash，条文还专门写着
「不许被自动执行」。所以：**默认模式的目标写死在源码里，`--target` 一律不执行。**
（S0 两段共用同一份实现，探测模式下判据不会变松。）

用法：
  python3 tools/verify_skill.py
  python3 tools/verify_skill.py --verbose
  python3 tools/verify_skill.py --controls            # 反向对照：喂已知坏样本
  python3 tools/verify_skill.py --target <另一个路径>   # 只探 S0，不执行

退出码：0 全过 · 1 有断言红 · 2 未测（对象不在库里 / 不在盘上 / git 取不到）
"""

import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKILL = os.path.join(ROOT, "agent-skills", "内容合规审查", "SKILL.md")
WORKFLOW_SKILL = os.path.join(ROOT, "agent-skills", "飞书内容审核工作流", "SKILL.md")
RUNTIME_KB_ROOT = "/Users/lute/Documents/skill-test/执行skills/执行skills/skills-回归测试/知识库/内容治理"

# Each group is a behavior promise the workflow skill must make explicit. The
# verifier checks durable anchors rather than requiring one exact prose style.
WORKFLOW_REQUIREMENTS = [
    ("代码路由判据", ("review_gate.mjs", "isSubmission", "mechanismQuestion", "chainInput")),
    ("审核链接线", ("agent.mjs", "kb_review_chain")),
    ("文字输入流程", ("文字",)),
    ("图片输入流程", ("图片",)),
    ("链接输入流程", ("链接",)),
    ("问答与送审分流", ("问答", "送审")),
    ("业务状态与判定层分离", ("DP0–DP4", "PASS", "SUGGEST", "REVIEW", "BLOCK")),
    ("失败态不能变成通过", ("未测", "不可读", "不得", "PASS")),
    ("skill 不会自动驱动运行时", ("不会在运行时自动装载",)),
]


def workflow_contract_errors(md):
    """Return named workflow promises that are missing from the project skill."""
    text = str(md or "")
    return [name for name, anchors in WORKFLOW_REQUIREMENTS
            if not all(anchor in text for anchor in anchors)]


def workflow_file_errors(path=WORKFLOW_SKILL, require_tracked=True):
    """Read the workflow skill and check tracked state plus behavior anchors."""
    if not os.path.exists(path):
        return ["文件不存在"]
    if require_tracked:
        state, rel = tracking_state(path, tracked_set())
        if state != "tracked":
            return ["文件未入库" if state == "untracked" else "git 读数未测"]
    try:
        with open(path, encoding="utf-8") as f:
            return workflow_contract_errors(f.read())
    except Exception as e:
        return ["文件无法读取：%s" % e]


def runtime_kb_advice_errors():
    """The active Shouheng KB is outside this checkout; verify its live code, not a stale mirror."""
    script = os.path.join(RUNTIME_KB_ROOT, "kb", "l8", "history_advice_selftest.py")
    review = os.path.join(RUNTIME_KB_ROOT, "kb", "l7", "skills", "kb-content-review",
                          "scripts", "review.py")
    if not os.path.isfile(script) or not os.path.isfile(review):
        return ["守衡实际加载的知识库副本或 advice 自证缺失"]
    try:
        with open(review, encoding="utf-8") as f:
            source = f.read()
        if "源记录未给改法 ⇒ 按禁止/打回处理" in source:
            return ["守衡实际加载副本仍把缺失建议误写成禁止/打回"]
        env = dict(os.environ)
        env["KB_ENTRY"] = "selftest"
        env["KB_INTERP_OK"] = "1"
        p = subprocess.run([sys.executable, script], cwd=RUNTIME_KB_ROOT, env=env,
                           capture_output=True, text=True, timeout=60)
        if p.returncode != 0:
            return ["守衡实际加载副本 advice 自证失败：%s" % (p.stdout + p.stderr)[-600:]]
        if "history_advice_selftest PASS (3/3)" not in p.stdout:
            return ["守衡实际加载副本 advice 自证没有输出通过读数：%s" % (p.stdout + p.stderr)[-600:]]
        return []
    except Exception as e:
        return ["守衡实际加载副本 advice 自证未测：%s" % e]


def run_workflow_controls():
    """Prove the consistency checker accepts complete docs and rejects gaps."""
    sample = "\n".join(anchor for _, anchors in WORKFLOW_REQUIREMENTS for anchor in anchors)
    cases = [
        ("完整契约样本", sample, []),
        ("缺少代码路由判据", sample.replace("mechanismQuestion\n", ""), ["代码路由判据"]),
        ("缺少图片流程", sample.replace("图片\n", ""), ["图片输入流程"]),
        ("缺少问答分流", sample.replace("问答\n", ""), ["问答与送审分流"]),
        ("失败态可以冒充通过", sample.replace("不得\n", ""), ["失败态不能变成通过"]),
    ]
    bad = []
    for name, md, expected in cases:
        got = workflow_contract_errors(md)
        if got == expected:
            print("  ✅ %s" % name)
        else:
            print("  ❌ %s：得到 %s，预期 %s" % (name, got, expected))
            bad.append(name)
    print("工作流规程反向对照 %d 项 · 不通过 %d 项" % (len(cases), len(bad)))
    return 1 if bad else 0

# 规程承诺的字段：第一条命中的规则生效（顺序敏感 —— `--json` 那条必须先判，
# 否则人类可读形态的字段要求会套到 JSON 输出上，变成假红）
PROMISES = [
    ("--json", ["contract_version", "rule_keys_hit", "layer", "unknowns",
                "boundary_statement"]),
    ("judge_adapter.py --from-text", ["判定", "处置层", "边界声明"]),
    ("verify_base.py", ["基座自证"]),
    ("verify_engine_contract.py", ["验收"]),
    ("verify_kb.py", ["G1", "E1"]),
    ("audit_risk_label.py", ["还原账与生成块"]),
]

SKIP = ("<外部广告ID>", "<url_key>", "<临时文件>")


# ─────────────────────── S0：验的对象在不在版本库里 ───────────────────────

def tracked_set(root=None):
    """`git ls-files` 的集合。取不到就返回 **None**（= 未测）。

    None 不是空集：空集会让「问不到 git」被读成「一个文件都没入库」。
    """
    try:
        p = subprocess.run(["git", "ls-files", "-z"], cwd=root or ROOT,
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                           timeout=60)
        if p.returncode != 0:
            return None
        return set(p.stdout.decode("utf-8", "replace").split("\0")) - {""}
    except Exception:
        return None


def tracking_state(path, tracked, root=None):
    """纯函数：这个路径在不在版本库里？返回 (state, relpath)。

    state ∈ {"tracked", "untracked", "untested"}。

    ★ 刻意做成纯函数（不碰盘、不调 git），这样 `--controls` 能拿它喂样本，
      证明三态**真的分得开** —— 项目约定 §2.1.1：没红过的断言不算验证过它。
    """
    r = root or ROOT
    if tracked is None:
        return "untested", path
    rel = os.path.relpath(os.path.abspath(path), r)
    if rel == os.pardir or rel.startswith(os.pardir + os.sep):
        # 仓库之外 —— 不可能被本仓库跟踪（`--target` 的反向对照就走这一支）
        return "untracked", rel
    rel = rel.replace(os.sep, "/")
    return ("tracked" if rel in tracked else "untracked"), rel


def s0_gate(target):
    """S0 闸门。返回 (exit_code_or_None, relpath)。None = 过闸。

    默认模式与 `--target` 探测模式**共用这一份实现** —— 探测模式不许有自己的
    松判据，否则它证不了默认模式的闸门。
    """
    state, rel = tracking_state(target, tracked_set())
    rel_show = os.path.relpath(target, ROOT)

    if state == "untested":
        print("═══ 规程自证 · %s ═══" % rel_show)
        print("⚠ 未测：取不到 `git ls-files`（git 不在 / 不是仓库 / 调用失败）——")
        print("   所以「这份规程在不在版本库里」我回答不了。")
        print("   这不是通过，也不是规程写错了（退 2）。")
        return 2, rel_show

    if state == "untracked":
        print("═══ 规程自证 · %s ═══" % rel_show)
        print("⚠ 未测：验的对象**不在版本库里**（`git ls-files` 里没有 %s）。" % rel)
        print("   `git check-ignore -v <路径>` 能告诉你被哪一行忽略掉了。")
        print("   自有规程要放 `agent-skills/<名字>/SKILL.md`；`skills/` 是被忽略的第三方目录。")
        print("   这份规程现在只存在于本机 —— 换台机器这个检查器就没有对象可验。")
        print("   所以下面那些命令**一条都不跑**：跑了也只会打印 ✅，")
        print("   而那正是这件事最会骗人的地方（退 2，未测）。")
        return 2, rel_show

    if not os.path.exists(target):
        print("═══ 规程自证 · %s ═══" % rel_show)
        print("⚠ 未测：盘上没有这个文件（它在 `git ls-files` 里，但工作区里打不开）。")
        print("   拿不到验的对象 —— 既不是通过，也不是「规程写错了」（退 2）。")
        return 2, rel_show

    return None, rel_show


def run_controls():
    """反向对照：喂已知坏样本，`tracking_state` 必须分得开三态。

    整段都在内存里做，不碰任何真实文件（项目约定 §2.1：反向对照只在内存里做）。
    喂的是**合成**的已跟踪集合，所以结果与当前仓库状态无关 —— 这是有意的：
    这几条要验的是「三态分得开」，不是「此刻谁入库了」。
    """
    sample = {"agent-skills/x/SKILL.md", "tools/verify_skill.py"}
    fails = []
    n = 0

    def c(label, got, want):
        nonlocal n
        n += 1
        if got == want:
            print("  ✅ %s → %s" % (label, got))
        else:
            print("  ❌ %s → %s（应为 %s）" % (label, got, want))
            fails.append(label)

    # C1 坏样本：本轮的**真身形状** —— 自有规程放在被 .gitignore 忽略的 skills/ 下。
    c("C1 老路径 skills/内容合规审查/SKILL.md（被 .gitignore:39 忽略）",
      tracking_state(os.path.join(ROOT, "skills", "内容合规审查", "SKILL.md"),
                     sample)[0], "untracked")
    # C2 好样本：在集合里 → 必须判 tracked（否则这个判据恒报未入库，是纯误报）
    c("C2 已在集合里的路径",
      tracking_state(os.path.join(ROOT, "agent-skills", "x", "SKILL.md"),
                     sample)[0], "tracked")
    # C3 未测：git 取不到 → 必须是第三种状态，不许落进任何一边
    c("C3 git 取不到（tracked=None）", tracking_state(SKILL, None)[0], "untested")
    # C4 仓外路径 → 必然未入库
    c("C4 仓库之外的路径",
      tracking_state("/tmp/verify-skill-controls/SKILL.md", sample)[0], "untracked")

    # C5 真实集合自证活着：它必须真的含有一个我们已知入库的规程。
    #    没有这一条，`tracked_set()` 读成空集（或读了错的键）时上面四条**照旧全绿**，
    #    而真身会一律判「未入库」—— 假红与假绿同时存在，且都看不出来。
    real = tracked_set()
    if real is None:
        print("  ⚠ C5 真实 git ls-files 取不到 → 未测（不是通过）")
    else:
        probe = "agent-skills/守衡语域/SKILL.md"
        c("C5 真实集合里含 %s" % probe, probe in real, True)

    print("\n反向对照 %d 项 · 不通过 %d 项%s"
          % (n, len(fails), "（C5 未测，未计入）" if real is None else ""))
    if fails:
        print("❌ 有反向对照没红：%s" % fails)
        return 1
    if real is None:
        print("⚠ 有读数没取到（C5）—— 这不是通过（退 2）。")
        return 2
    print("✅ 三态分得开：老路径判未入库、已跟踪判入库、取不到判未测")
    return 0


# ──────────────────────────── 规程正文的命令 ────────────────────────────

def blocks(md):
    """抽出 bash 块里的**每一条**命令。

    ★ 第一版把整块当一个命令跑：于是「含占位符就跳过」会把同块里其它**能跑**的
      命令一起跳掉 —— 最主要的两条命令因此从来没被验过。逐行抽出来之后，
      占位符只影响它自己那一行。
    """
    out = []
    for m in re.finditer(r"```bash\n(.*?)```", md, re.S):
        for ln in m.group(1).split("\n"):
            if not ln.strip() or ln.strip().startswith("#"):
                continue
            exp = re.search(r"#\s*expect:\s*(ok|fail)", ln)
            out.append((ln.strip(), exp.group(1) if exp else "ok"))
    return out


def main():
    argv = sys.argv[1:]
    verbose = "--verbose" in argv

    if "--controls" in argv:
        a = run_controls()
        b = run_workflow_controls()
        return 1 if a or b else 0
    if "--workflow-controls" in argv:
        return run_workflow_controls()
    if "--workflow-check" in argv:
        errors = workflow_file_errors()
        if errors:
            print("❌ 飞书工作流 skill 不满足契约：%s" % "、".join(errors))
            return 2 if "文件未入库" in errors or "git 读数未测" in errors else 1
        print("✅ 飞书工作流 skill 与代码路由、三类输入及失败态契约一致")
        return 0

    probe = "--target" in argv
    if probe:
        i = argv.index("--target")
        if i + 1 >= len(argv):
            print("❌ --target 后面要跟一个路径")
            return 1
        target = os.path.abspath(argv[i + 1])
    else:
        target = SKILL

    code, rel = s0_gate(target)
    if code is not None:
        return code

    md = open(target, encoding="utf-8").read()
    bs = blocks(md)
    print("═══ 规程自证 · %s ═══" % rel)
    print("S0 ✅ 验的对象在版本库里")
    print("抽出 %d 个 bash 块" % len(bs))

    workflow_errors = workflow_file_errors()
    if workflow_errors:
        print("❌ 飞书工作流 skill 不满足契约：%s" % "、".join(workflow_errors))
        return 2 if "文件未入库" in workflow_errors or "git 读数未测" in workflow_errors else 1
    print("S1 ✅ 飞书工作流 skill 与代码路由、三类输入及失败态契约一致")
    runtime_advice_errors = runtime_kb_advice_errors()
    if runtime_advice_errors:
        print("S2 ❌ 守衡实际加载的知识库副本：%s" % "；".join(runtime_advice_errors))
        return 1
    print("S2 ✅ 守衡实际加载的知识库副本 advice 自证通过")

    if probe:
        # ★ 探测模式到此为止，一条命令都不跑。理由见文件头「--target 只做探测」。
        print("（--target 探测模式：不执行任何命令 —— 免得这个开关被用来")
        print("  把任意文档里的 bash 跑一遍，而本仓库 §2.7 那段会真重启对外服务）")
        return 0
    print("")

    bad, ran, skipped = [], 0, 0
    for i, (cmd, expect) in enumerate(bs, 1):
        if any(s in cmd for s in SKIP):
            skipped += 1
            print("  ⏭️  #%d 含占位符，跳过执行：%s" % (i, cmd.splitlines()[0][:60]))
            continue
        p = subprocess.run(cmd, shell=True, cwd=ROOT, capture_output=True, text=True,
                           timeout=900)
        ok = ((p.returncode == 0) == (expect == "ok"))
        out = p.stdout + p.stderr
        miss = []
        for pat, fs in PROMISES:
            if pat in cmd:
                miss = [f for f in fs if f not in out]
                break
        mark = "✅" if ok and not miss else "❌"
        print("  %s #%d expect=%s exit=%s%s　%s"
              % (mark, i, expect, p.returncode,
                 "　缺字段 " + str(miss) if miss else "", cmd.splitlines()[0][:64]))
        if verbose or not ok or miss:
            for ln in out.strip().splitlines()[:6]:
                print("        │ %s" % ln[:110])
        if not ok:
            bad.append("#%d 退出码 %s，期望 %s" % (i, p.returncode, expect))
        if miss:
            bad.append("#%d 输出里缺 %s" % (i, miss))
        ran += 1
    print("\n跑过 %d 条 · 跳过 %d 条（占位符）" % (ran, skipped))
    if bad:
        print("❌ %d 项不符：%s" % (len(bad), bad))
        return 1
    print("✅ 规程在库里，且里面每条命令都跑得动、输出里真的出现了它承诺的东西")
    return 0


if __name__ == "__main__":
    sys.exit(main())

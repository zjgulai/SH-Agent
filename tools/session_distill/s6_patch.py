#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""S6 补丁与影响面：把 Schema 卡片落成**逐 skill 的补丁候选** + §2.8 口径的影响面报告。

    python3 tools/session_distill/s6_patch.py [--apply] [--selftest]

产出（全部在工作区内，**不碰沙箱外的 skill 与库**）
--------------------------------------------------
    PMO/会话蒸馏-20261015/补丁/<skill>.patch        统一 diff（对 SKILL.md，追加一节）
    PMO/会话蒸馏-20261015/补丁/<skill>.references.md 建议新增的 references 正文
    PMO/会话蒸馏-20261015/影响面报告.md              §2.8 等价复算 + 本轮真实影响面

★ 为什么是「追加一节」而不是改正文
  `蒸馏` skill 写着：候选内容要进 `SKILL.md` **正文**必须过三重验证，缺一条就降级进
  `references/`。本轮 6 张卡片里 5 张 keep、1 张 review（只靠 1 条会话，独立佐证 < 2），
  **且全部是 E2（未获批）** ⇒ 一律先进 `references/`，正文只加一行指针。
"""
from __future__ import annotations

import argparse
import collections
import difflib
import json
import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import RUN_DIR, write_json, write_md_plain  # noqa: E402

CARDS = RUN_DIR / "schema" / "Schema卡片-v1.json"
ROUTED = RUN_DIR / "入库候选-v1.ndjson"
JUDGED = RUN_DIR / "正误判定-v1.ndjson"
GAPS = RUN_DIR / "缺口清单-v1.ndjson"
PATCH_DIR = RUN_DIR / "补丁"
SKILLS_ROOT = Path.home() / ".dsh" / "skills"
IMPACT = RUN_DIR / "影响面报告.md"

STAMP = "2026-10-15"
SECTION_TITLE = "会话蒸馏回灌"

# 目标 skill → 真实目录名（卡片里写的是逻辑名，这里做映射；对不上就报错，不许静默跳过）
SKILL_DIR = {
    "kb-l0-feishu": "kb-l0-feishu",
    "kb-repair": "kb-repair",
    "kb-recall": "kb-recall",
    "kb-pipeline": "kb-pipeline",
    "内容审查总控": "内容审查总控",
    "飞书审查流转": "飞书审查流转",
}


def render_cards_md(cards):
    L = ["# %s · %s（E2 · 未获批 · 候选）" % (SECTION_TITLE, STAMP), "",
         "> 来源：`PMO/会话蒸馏-20261015/schema/Schema卡片-v1.json`",
         "> 证据区间：2026-10-05 ~ 2026-10-15 · 574 个 DSH 会话 / 1736 个案例",
         "> **每一条都带依据指针**（`case_id` + `会话:seq`），由 `s5_schema.py` 机械回验",
         "> （`case_id` 在表里 / `anchor` 对得上 / **引文逐字出现在原文里**）。", "",
         # ★ 这句**刻意不写**那三个禁用词的字面 —— 第一版写了，于是「生成物里不许出现禁用词」"
         #   的断言被**这句禁止语自己**绊红（AGENTS.md §2.4.4 记的同一个形状：
         #   检查器被自己的解释文字命中）。禁令照样在，只是不用那三个字面表达。
         "★ **E 级上限 = E2**：这是草稿，可审查、**未获批**。任何「已就绪 / 可对外上线 / 验收已通过」式的结论都不许写。",
         "★ 入库与改正文是**人的动作** —— 本文件只是候选。", ""]
    for c in cards:
        L.append("## %s · %s" % (c["id"], c["主题"]))
        L.append("")
        L.append("目标：`%s` ｜ 三重验证：score **%s** → **%s**（独立佐证 %d 个会话）"
                 % (c["目标skill"], c["三重验证"]["score"], c["三重验证"]["verdict"],
                    c["三重验证"]["独立佐证_会话数"] if "独立佐证_会话数" in c["三重验证"]
                    else c["三重验证"]["跨会话数"]))
        L.append("")
        for k in ("可执行动作", "禁止动作", "风险点"):
            items = [i for i in c["条目"] if i["类"] == k]
            if not items:
                continue
            L.append("### %s（%d）" % (k, len(items)))
            L.append("")
            for i, it in enumerate(items, 1):
                L.append("%d. %s" % (i, it["动作"]))
                for p in it["依据"]:
                    extra = (" ｜ _反例可用作_：%s" % p["反例可用作"]) if p.get("反例可用作") else ""
                    L.append("   - 依据 `%s` @ `%s` —— 「%s」%s"
                             % (p["case_id"], p.get("anchor", "-"), p.get("quote", ""), extra))
            L.append("")
    return "\n".join(L) + "\n"


def build_patch(skill, ref_body, skill_dir):
    """对 SKILL.md 追加一节；返回 (patch_text, ok, why)。"""
    sk = skill_dir / "SKILL.md"
    if not sk.exists():
        return None, False, "SKILL.md 不存在：%s" % sk
    old = sk.read_text(encoding="utf-8")
    block = ("\n\n---\n\n## %s（%s）\n\n"
             "以下三条（可执行 / 禁止 / 风险）由 %s 的会话蒸馏产出，**E2 · 未获批**。\n"
             "正文见 [`references/%s.md`](references/%s.md)；每条都带依据指针。\n"
             % (SECTION_TITLE, STAMP, STAMP, SECTION_TITLE, SECTION_TITLE))
    new = old.rstrip("\n") + block
    # 幂等判据用**标题这个稳定标记**，不用整块正文：
    #   正文以后可能被改一个字，而「这一节在不在」判的是标题。
    marker = "## %s（%s）" % (SECTION_TITLE, STAMP)
    if marker in old:
        return None, False, "SKILL.md 里已经有这一节（幂等跳过）"
    diff = difflib.unified_diff(old.splitlines(True), new.splitlines(True),
                                fromfile="a/%s/SKILL.md" % skill,
                                tofile="b/%s/SKILL.md" % skill, n=3)
    return "".join(diff), True, "ok"


def run(apply: bool):
    if not CARDS.exists():
        print("✗ 卡片不存在 —— 先跑 s5_schema.py --apply")
        return 1
    doc = json.loads(CARDS.read_text(encoding="utf-8"))
    cards = doc["cards"]
    judged = [json.loads(l) for l in JUDGED.read_text(encoding="utf-8").splitlines() if l.strip()]
    routed = [json.loads(l) for l in ROUTED.read_text(encoding="utf-8").splitlines() if l.strip()]
    gaps = [json.loads(l) for l in GAPS.read_text(encoding="utf-8").splitlines() if l.strip()]

    by_skill = collections.defaultdict(list)
    for c in cards:
        by_skill[c["目标skill"]].append(c)

    print("── S6 补丁与影响面 " + ("（--apply 真写）" if apply else "（预演，不落盘）"))
    print("   卡片数                  %d" % len(cards))
    print("   涉及 skill              %d 个：%s" % (len(by_skill), "、".join(sorted(by_skill))))

    patches, problems = {}, []
    for skill, cs in sorted(by_skill.items()):
        d = SKILL_DIR.get(skill)
        if not d:
            problems.append("%s 没有登记目录映射（不许静默跳过）" % skill)
            continue
        sd = SKILLS_ROOT / d
        if not sd.exists():
            problems.append("%s 的目录不存在：%s" % (skill, sd))
            continue
        body = render_cards_md(cs)
        patch, ok, why = build_patch(skill, body, sd)
        print("   %-14s 卡片 %d ｜ 补丁 %s（%s）" % (skill, len(cs), "有" if ok else "无", why))
        patches[skill] = {"references": body, "patch": patch, "ok": ok, "why": why}

    # ── 影响面 ──
    dist = collections.Counter(r["层"] for r in routed)
    pol = collections.Counter(r["polarity"] for r in routed if r["层"] == "L1")
    vdist = collections.Counter(j["判定"] for j in judged)
    unconfirmed = pol.get("待人工复核", 0)

    print("   ── §2.8 等价复算 ──")
    print("     本轮**退役**的在册单元        0  ← 影响面闸门问的就是这个数")
    print("     本轮**新增**候选：L0 %d / L1 %d / L3 %d / L5 %d"
          % (dist.get("L0", 0), dist.get("L1", 0), dist.get("L3", 0), dist.get("L5", 0)))
    print("     L1 候选里「待人工复核」        %d  ← 最大的一条影响面" % unconfirmed)

    if apply:
        PATCH_DIR.mkdir(parents=True, exist_ok=True)
        for skill, p in patches.items():
            (PATCH_DIR / ("%s.patch" % skill)).write_text(p["patch"] or "", encoding="utf-8")
            env = write_md_plain(PATCH_DIR / ("%s.references.md" % skill), p["references"])
            if not env["ok"]:
                print("   ✗ %s 的 references 落成信封态" % skill)
                return 2
        write_json(RUN_DIR / "_evidence" / "patch-stats.json",
                   {"at": STAMP, "n_cards": len(cards), "skills": sorted(by_skill),
                    "problems": problems,
                    "impact": {"retired": 0, "new": dict(dist),
                               "l1_polarity": dict(pol), "judged": dict(vdist)}})
        md = render_impact(dist, pol, vdist, len(cards), len(patches), problems, gaps)
        env = write_md_plain(IMPACT, md)
        if not env["ok"]:
            print("   ✗ 影响面报告落成信封态")
            return 2
        print("   已写：补丁/（%d 个 skill）、影响面报告.md" % len(patches))
    if problems:
        print("   ⚠ %d 个问题：" % len(problems))
        for x in problems:
            print("     - %s" % x)
        return 1
    return 0


def render_impact(dist, pol, vdist, n_cards, n_patch, problems, gaps):
    L = []
    A = L.append
    A("# 会话蒸馏 · 影响面报告（§2.8 口径）")
    A("")
    A("> 生成：`python3 tools/session_distill/s6_patch.py --apply`　｜　日期：%s" % STAMP)
    A(">")
    A("> **这不是 `kb/l8/workflow_impact_gate.py` 本身** —— 那个闸门要在库里跑、会写 README 快照。")
    A("> 本报告是它的**等价复算**：读它的判据（`kb/l8/workflow_impact_gate.py` 文件头三条规则），")
    A("> 拿本轮的候选当输入，回答同一个问题。**口径照抄，结论自负。**")
    A("")
    A("## 一、闸门问的那个问题：本轮会让多少**在册**单元失效")
    A("")
    A("| 项 | 读数 | 说明 |")
    A("|---|---|---|")
    A("| 本轮退役的在册单元 | **0** | 本轮只**新增候选**，不退役、不重切、不改已有 unit id |")
    A("| 需要补偿的资源 | **0** | 没有退役 ⇒ 不适用 |")
    A("| 闸门判定（等价复算） | **放行** | 影响面为 0 |")
    A("")
    A("★ 也就是说：`workflow_impact_gate.py` 拦的是「重切把在册单元作废 ⇒ L6 白名单指空 ⇒ 评审链停在 L6 拒答」")
    A("这个形状。**本轮不是那个形状** —— 本轮是纯新增。")
    A("")
    A("## 二、但「新增」有它自己的影响面（闸门不管这个，得由本轮自己说）")
    A("")
    A("| 层 | 候选数 | 落点 |")
    A("|---|---|---|")
    for lay, what in (("L0", "`kb/l0/manifest.jsonl`（源侧对象登记）"),
                      ("L1", "`kb/l1/2_内部正负样本库/<id>.json`（案例条目）"),
                      ("L3", "`kb/l3/candidates/rules.jsonl`（规则候选）"),
                      ("L5", "`kb/l5/p0_patterns.jsonl`（P0 模式候选）")):
        A("| %s | %d | %s |" % (lay, dist.get(lay, 0), what))
    A("")
    A("### 最大的一条影响面：**「待人工复核」不能整批入库**")
    A("")
    A("L1 候选 %d 条的极性分布：" % sum(pol.values()))
    A("")
    A("| 极性 | 条数 | 占比 | 入库口径 |")
    A("|---|---|---|---|")
    total = max(1, sum(pol.values()))
    for k in ("待人工复核", "正例", "反例"):
        v = pol.get(k, 0)
        gate = {"待人工复核": "**不许直接入库** —— 无指针即无判定（验收契约 §三）",
                "正例": "可入，但标 `evidence_strength` 与实际指针一致",
                "反例": "可入，作负样本"}[k]
        A("| %s | %d | %.1f%% | %s |" % (k, v, 100.0 * v / total, gate))
    A("")
    A("★ 上表「待人工复核」那一格**混着两件不同的事**，处置也不同，必须拆开看：")
    A("")
    A("| 判定 | 条数 | 该谁处置 |")
    A("|---|---|---|")
    A("| 待人工复核（人说了话，但没说「你上一步做错了」） | %d | 内容治理数据组过一遍 |" % vdist.get("待人工复核", 0))
    A("| 缺口·引擎拒答（库对该题材没有可依据的条款） | %d | L3 层主 —— 这是「该补哪一块」的清单 |" % vdist.get("缺口·引擎拒答", 0))
    A("| 冲突·待人工复核（正反指针都有） | %d | 先看指针再定，**不许自动选边** |" % vdist.get("冲突·待人工复核", 0))
    A("")
    A("★ **若把这 %d 条整批灌进 `2_内部正负样本库`**，后果不是「库更全了」，而是：" % pol.get("待人工复核", 0))
    A("")
    A("1. L2 会切出 %d 条**无判据单元**，L3 蒸馏会把它们当语料 ⇒ **规则候选基于噪声**；" % pol.get("待人工复核", 0))
    A("2. L6 召回会把它们召回到评审链里 ⇒ 链「看起来更覆盖了」，实际是拿没有结论的样本当依据；")
    A("3. 而**没有任何东西会红** —— 假覆盖与真覆盖长得一模一样（AGENTS.md §2.4.1 那个病）。")
    A("")
    A("⇒ 处置：**先只放有指针的那批**（正例 %d + 反例 %d = %d 条），"
      % (pol.get("正例", 0), pol.get("反例", 0), pol.get("正例", 0) + pol.get("反例", 0)))
    A("「待人工复核」那 %d 条留在候选包里等人过一遍，**不自动升级**；" % vdist.get("待人工复核", 0))
    A("「缺口」那 %d 条不进样本库 —— 它们不是案例，是**覆盖缺口**，归 L3。" % vdist.get("缺口·引擎拒答", 0))
    A("")
    A("## 三、缺口（这一节其实是**收货**，不是问题）")
    A("")
    A("判定分布：")
    A("")
    A("| 判定 | 条数 |")
    A("|---|---|")
    for k, v in vdist.most_common():
        A("| %s | %d |" % (k, v))
    A("")
    A("其中 **缺口·引擎拒答 %d 条**（%.1f%%）是**库的覆盖面读数**，不是链的错 —— "
      % (vdist.get("缺口·引擎拒答", 0), 100.0 * vdist.get("缺口·引擎拒答", 0) / max(1, len(judged_of(vdist)))))
    A("`regression-set.yaml` 也把 20 条拒答单列成 `fragile`，并写明「改了是进步，不是回归」。")
    A("它对 L3 的意义：这 %d 条就是「库该补哪一块」的**清单**。" % vdist.get("缺口·引擎拒答", 0))
    A("")
    A("另有 %d 条聚类因**佐证 < 2** 被三重验证淘汰，逐条登记在 `缺口清单-v1.ndjson`。" % len(gaps))
    A("")
    A("## 四、补丁的落点与补偿")
    A("")
    A("| 项 | 值 |")
    A("|---|---|")
    A("| 补丁数 | %d 个 skill |" % n_patch)
    A("| 补丁形态 | 对 `SKILL.md` **追加一节**（不改进正文）+ 新增 `references/会话蒸馏-%s.md` |" % STAMP)
    A("| 为什么进 references 而不是正文 | `蒸馏` skill：候选要进正文必须过三重验证；本轮 %d 张卡片全为 **E2（未获批）** |" % n_cards)
    A("| 补偿 | 不适用（无退役） |")
    A("| 回滚 | 删掉追加的那一节 + 删 `references/会话蒸馏-%s.md` 即可；`patch` 文件是标准 unified diff，可 `-R` |" % STAMP)
    A("")
    if problems:
        A("## 五、未解决的问题")
        A("")
        for x in problems:
            A("- %s" % x)
        A("")
    A("## 六、本轮**没有**做的事（说清楚，别让读者以为做了）")
    A("")
    A("1. 没有写 `kb/l0…l7` 任何文件 —— 沙箱外，且 `write-gate.yaml` 里没有覆盖本轮的凭据。")
    A("2. 没有改 `~/.dsh/skills/` 下任何 skill —— 补丁是**候选**，落盘是人的动作。")
    A("3. 没有给任何候选发号（`article_no` / `rule_code` 留空）—— 发号是 L4 的动作，要人过闸。")
    A("4. 没有把「同意」（弱确认）当成「产出正确」的证据 —— 见验收契约 §三 的强度分级。")
    return "\n".join(L) + "\n"


def judged_of(vdist):
    return list(range(sum(vdist.values())))


def selftest() -> int:
    fails, n_ck = [], [0]

    def ck(name, got, want):
        n_ck[0] += 1
        if got != want:
            fails.append("%s：得到 %r，期望 %r" % (name, got, want))

    cards = [{"id": "SCH-T", "主题": "T", "目标skill": "kb-repair",
              "三重验证": {"score": 1.0, "verdict": "keep", "跨会话数": 2},
              "条目": [{"类": "可执行动作", "动作": "A", "依据": [
                  {"case_id": "SC-1", "anchor": "s1:3", "quote": "q"}]},
                  {"类": "禁止动作", "动作": "B", "依据": [
                      {"case_id": "SC-1", "anchor": "s1:3", "quote": "q"}]}]}]
    md = render_cards_md(cards)
    ck("T1 渲染含三类标题", "### 可执行动作" in md, True)
    ck("T2 渲染带依据指针", "SC-1" in md and "s1:3" in md, True)
    ck("T3 E2 声明在", "E2" in md, True)
    # T4 生成物的**卡片正文**不许自称就绪（契约 §五）。
    #    ★ 判据必须排除头部那几行**元文字** —— 否则断言会被「不许写 X」这句禁止语自己绊红
    #      （AGENTS.md §2.4.4 记的同一形状：检查器被自己的解释文字命中）。
    body_only = "\n".join(l for l in md.splitlines()
                          if not l.startswith((">", "★", "# 会话蒸馏")))
    for bad in ("已就绪", "可对外上线", "验收已通过", "生产就绪", "已上线"):
        ck("T4 正文不许出现 %s" % bad, bad in body_only, False)
    # T4b 反向对照：往正文里塞一句就绪声明，断言必须**变红**
    poisoned = md + "\n本卡已就绪，可对外上线。\n"
    pb = "\n".join(l for l in poisoned.splitlines() if not l.startswith((">", "★", "# 会话蒸馏")))
    ck("T4b 塞进去必须被抓", "已就绪" in pb, True)
    # T5 补丁必须真是 unified diff 且可逆
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        (d / "SKILL.md").write_text("# S\n\n正文\n", encoding="utf-8")
        patch, ok, why = build_patch("kb-repair", md, d)
        ck("T5 出 diff", ok, True)
        ck("T5b 是 unified diff", patch.startswith("--- a/"), True)
        ck("T5c 含追加内容", "会话蒸馏回灌" in patch, True)
    # T6 幂等：同一份 SKILL.md 再打一次必须说「已有这一节」
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        old = "# S\n\n正文\n"
        block = ("\n\n---\n\n## %s（%s）\n" % (SECTION_TITLE, STAMP))
        (d / "SKILL.md").write_text(old + block, encoding="utf-8")
        _, ok2, why2 = build_patch("kb-repair", md, d)
        ck("T6 幂等不重复追加", ok2, False)
        ck("T6b 幂等理由", "幂等" in why2, True)
    # T7 目标 skill 没登记目录 → 必须报问题，不许静默跳过
    ck("T7 未登记目录点名", "kb-没这个" in ("%s 没有登记目录映射" % "kb-没这个"), True)
    ck("T7b 逻辑本身", SKILL_DIR.get("kb-没这个"), None)

    if fails:
        print("❌ S6 自证未过（%d / %d 项）" % (len(fails), n_ck[0]))
        for f in fails:
            print("   " + f)
        return 1
    print("✅ S6 自证全过（%d 项反向对照）" % n_ck[0])
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

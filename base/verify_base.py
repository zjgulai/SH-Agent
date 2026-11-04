#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""verify_base.py —— 基座第⑤面：自证（ADR-0013 D1 / 异议一）

一句话：**把「基座是好的」这句话，变成一条能红的命令。**

    python3 base/verify_base.py          # 全绿退出 0，有红退出 2

--------------------------------------------------------------------------
六个面
--------------------------------------------------------------------------

  A 各模块自证      **每一个交付的模块**的 --selftest 必须各自退出 0
                   （B2 起：`media.py` 与 `text_stage.py` 也进来了 —— 在此之前
                   B1 那 20 项自证写了，但没有任何东西会去跑它）
  B L1 自足性       ★ ADR-0013 异议一承诺的那条检查
  C 分级一致性      .gitignore 的每条规则都必须被登记表认领，且**在 ADR §三 里有出处**
  D 产物完备性      盘上实际存在的 L2 文件，要么被登记，要么命中登记的模式
  E 版本控制        仓库存在、有提交历史、工作区状态如实报告
  F 反向对照        故意做坏登记表 / .gitignore，检查必须红

--------------------------------------------------------------------------
★ B 面：异议一原文
--------------------------------------------------------------------------

> **B0.5 的 `verify_base.py` 必须包含一条检查：L2 的每个关键产物都能在 L1 里
> 找到它的「生成脚本 + 输入指纹」，找不到即红。** 若该检查做不到，本分级即失效，
> D7 需重议。

**「做不到」这件事必须先说清，不能假装做到了。** 三类 L2 的性质根本不同：

| 类 | 含义 | 判据 |
|---|---|---|
| `derived` | 可复算：给生成脚本 + 输入，跑出来是同一份 | **必须有** git 跟踪的生成脚本 + 可追溯的输入 |
| `derived_l2_generator` | ★ **可复算，但生成脚本自己不在 L1**（2026-09-22 新增） | ★ **判据不成立，而且这是「降级」不是「不适用」** —— 见下 |
| `addressed` | 内容寻址：文件名就是指纹，自证 | 判据不适用 —— 它自己证明自己 |
| `primary` | **本身是账本，不可复算** | ★ **判据不适用**，且必须写清为什么 |
| `runtime` | 进程运行态（日志、会话） | 判据不适用；但**必须在 ADR §三 里有出处** |
| `vendored` | 别人管的（含自己的 .git） | 判据不适用 |

**`derived_l2_generator` 这一类是 2026-09-22 新加的，加它的理由值得单独记。**

Q38 的裁定（Owner：`.ua/` **只收正文**）把 9 个 `.cjs` 复现入口移出了 L1 —— 于是
`.ua/dispatch/` 与 `.ua/intermediate/` 这两个「机器生成、可复算」的产物**忽然失去了
L1 里的生成脚本**。异议一那条判据（生成脚本在 L1 + 输入可追溯）对它们**不再成立**。

**这件事有两种处理方式，而只有一种是对的**：把它悄悄归进「判据不适用」
（`runtime` / `vendored` 那种），等于**把一次降级写成了一条中性说明** ——
读的人会以为「这一格本来就查不了」，而真相是「它本来查得了，是我们自己把它弄丢的」。
所以给它一个**自己的类名**，B 面单独计数、单独打印，并且有两条反向对照盯着它：

* 生成脚本**连盘上都没有** ⇒ 红（那是假的）；
* 生成脚本**其实已被跟踪** ⇒ 红（**降级是暂时的，不许留成常设** ——
  一条「因为它不在 L1 所以不查」的规则，在它回到 L1 之后会变成一张免死金牌）。

`primary` 这一类则是本检查最该说清的地方。ADR-0013 §三 把 `receipts.jsonl` 判为 L2，
给的理由是「**追加型账本**：只会增长，不需要 diff 与回滚」——
**不是**「可复算」。一条回执记录的是「当时判了什么」，L1 里**没有第二份**，
所以异议一那条判据（生成脚本 + 输入指纹）在它身上**根本不成立**。
把 L2 笼统说成「机器生成的、可复算的」，正是 L2 那一节自己的**判据**写过头了：
它列了四类理由（可复算 / 内容寻址 / 追加型账本 / 别人管的），
而异议一那条检查只对你**第一类**成立。本模块把这个区分做成 `class` 字段，
**不许不写**。

--------------------------------------------------------------------------
★ C 面：`.gitignore` 自己的警告，已经发生过一次
--------------------------------------------------------------------------

`.gitignore` 头部写着：

> ★ 改动本文件 = 改动分级 = 需回到 ADR-0013 §三 同步，否则台账与制品会漂移。

**已经漂移了。** 本模块第一次跑就抓到：`.gitignore` 里有两条规则
（`PMO/logs/`、`PMO/shouheng-state/`）**在 ADR-0013 §三 里一个字都没有**。
所以 C 面不只查「规则被登记了吗」，还查「登记的那条**在 ADR 里有没有出处**」——
没有出处 ⇒ 红，并点名是哪条规则、它盖住了什么。
"""
from __future__ import annotations

import argparse
import io
import json
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
ADR = ROOT / "ADR" / "ADR-0013-基座接口冻结与仓库入库分级.md"
GITIGNORE = ROOT / ".gitignore"

CONTRACT_VERSION = "verify-base-v1"

# ──────────────────────────────────────────────────────────────────
#  登记表：仓库里每一个「不入历史」的位置，逐条写清它是什么、凭什么、谁生成
#
#  `class` 必填（五类见文件头）；`derived` 必须给 generator + inputs；
#  所有类**都必须**给 `adr_ref` —— 指向 ADR-0013 §三 里的出处。
#  `adr_ref=None` 表示**台账里没有它** ⇒ C 面红。
# ──────────────────────────────────────────────────────────────────
REGISTRY = [
    # ── 结构性诊断工作目录（2026-09-22 · Q38 裁定：Owner 最终裁定「只收正文」）──
    #   ★ L1 只收那 10 份正文（+ 入口 README），**9 个 `.cjs` 复现入口留在 L2**。
    #     这条裁定顺手造成一次降级：下面两条 `derived` 的生成脚本因此不在 L1 ——
    #     故改判 `derived_l2_generator`（新增类，B 面单独计数、单独打印 + 两条反向对照）。
    {"rules": [".ua/dispatch/"],
     "class": "derived_l2_generator", "adr_ref": "§三 L2 · `.ua/` 里除 `*.md` / `.*` 配置之外的一切",
     "generator": ".ua/gen-dispatch.cjs",
     "inputs": [".ua/.understandignore"],
     "why": "43 批喂给模型的分批输入 + `dispatch/data/` 的四个图（后者由 `gen-phase45.cjs` 产出）。"
            "★ **降级**（2026-09-22，Q38「只收正文」）：这两个 `.cjs` 生成脚本**不在 L1**，"
            "所以异议一那条判据（L1 里找得到生成脚本）对它**不再成立** —— 本格据实记为"
            "`derived_l2_generator`，不许混进「判据不适用」。可复算性本身没变（脚本在盘上、"
            "输入在 L1），丢的是**换台机器之后的**可复算性。"},
    {"rules": [".ua/intermediate/"],
     "class": "derived_l2_generator", "adr_ref": "§三 L2 · `.ua/` 里除 `*.md` / `.*` 配置之外的一切",
     "generator": ".ua/assemble.cjs",
     "inputs": [".ua/dispatch/"],
     "why": "组装中间图（`assembled-graph.json`）。输入是上面那条已登记的 L2 产物。"
            "★ 与上一条同因同判：生成脚本 `.ua/assemble.cjs` 按 Q38 留在 L2。"},
    {"rules": [".ua/knowledge-graph.json", ".ua/fingerprints.json"],
     "class": "vendored", "adr_ref": "§三 L2 · `.ua/` 里除 `*.md` / `.*` 配置之外的一切",
     "why": "由**第三方管线**（Understand-Anything，装在 gitignored 的 `skills/` 里）直接写出："
            "1362 节点 / 2657 边的图谱与 455 个文件的指纹。本仓给不出生成脚本 —— "
            "判据不适用（与 §三 那条「别人管的」同类）。★ 结论（正文）已在 L1，"
            "这两个文件是那次运行的产物，不是新证据。"},
    {"rules": [".ua/.trash-1790050761/"],
     "class": "runtime", "adr_ref": "§三 L2 · `.ua/` 里除 `*.md` / `.*` 配置之外的一切",
     "why": "Understand-Anything 覆盖文件时留下的回收站（11MB / 占 `.ua/` 总量 69%）。"
            "进程跑完留下的东西，判据不适用；**不做删除** —— 删别人工具的数据不是本次的授权。"},
    # ★ 9 个复现入口（2026-09-22 · Q38 改判「只收正文」的直接结果）。
    #   为什么**逐条列、不用 `.ua/*.cjs` 通配**：与本节其余各条同一条道理 ——
    #   通配会把日后新出现的脚本静默吞掉，而这里要的恰恰是「新东西必须被看见」。
    #   为什么给 `why` 而不是留空：这一组不是因为判据不适用才留在盘上，
    #   而是**一次治理裁定**（正文进历史、入口留盘），而它有一条**可核的代价**：
    #   正文里那些 `node .ua/xxx.cjs` 命令换台机器就指向不存在的文件 ——
    #   逐条登记在 `tools/verify_doc_reachability.py` 的 `ON_DISK_ONLY`（G 段）。
    {"rules": [".ua/adr-status-check.cjs", ".ua/assemble.cjs", ".ua/doc-reachability.cjs",
               ".ua/duplication-check.cjs", ".ua/gen-dispatch.cjs", ".ua/gen-phase45.cjs",
               ".ua/graph-diagnosis.cjs", ".ua/reference-census.cjs", ".ua/runtime-surface.cjs"],
     "class": "primary", "adr_ref": "§三 L2 · `.ua/` 里除 `*.md` / `.*` 配置之外的一切（Q38 改判：只收正文）",
     "why": "**本仓没有第二份**：这 9 个是一次性写出来的诊断脚本，只在 `.ua/` 下存在，"
            "没有任何生成器能再产出它们 —— 与 `receipts.jsonl` 同属「L1 里找不到第二份」那一类，"
            "所以 `derived` 的判据（生成脚本 + 输入指纹）对它不适用。"
            "★ 与 `primary` 的定义有一处**刻意的偏差**，写在这里而不是含糊过去：它们是**代码**、"
            "不是账本。之所以仍归这一类，是因为现有五类里只有它表达「L1 里没有第二份」；"
            "而真正的理由是一次**治理裁定**（Owner：`.ua/` 只收正文），不是技术判据 ——"
            "把它写成 `derived` 会让 B 面去找一个不存在的生成器，写成 `vendored` 则是说谎"
            "（它不是别人管的）。"},
    # ── derived：可复算 ────────────────────────────────────────────
    {"rules": ["research/governance/skeleton/_data/records.json"],
     "class": "derived", "adr_ref": "§三 L2 · `skeleton/_data/records.json`",
     "generator": "research/governance/skeleton/build_rules.py",
     "inputs": ["PRD/内容治理需求文档.md"],
     "why": "291 条广告记录。源表在 PRD（L1）+ 生成脚本在 L1 + 飞书可重拉。"},
    {"rules": ["research/governance/skeleton/_data/rules_raw.json"],
     "class": "derived", "adr_ref": "§三 L2 · `rules_raw.json`",
     "generator": "research/governance/skeleton/build_rules.py",
     "inputs": ["PRD/内容治理需求文档.md"],
     "why": "21 条规则的原始抽取。同上。"},
    # ★ 2026-09-17（D9 执行）：源表「风险等级」列的逐行还原账。
    #   它是**跑引擎跑出来的**，所以语料或规则/词表任一改动都会让它过期 ——
    #   制品自带输入指纹，V44b 与 kb_facts 都会在指纹对不上时直接报红。
    {"rules": ["research/governance/skeleton/_data/风险等级-还原.json"],
     "class": "derived", "adr_ref": "§三 L2 落地澄清（同 records.json，下游可复算视图）",
     "generator": "research/governance/audit_risk_label.py",
     "inputs": ["research/governance/skeleton/_data/records.json"],
     "why": "157 条「合规·绿」的真实构成（55 无文案 / 99 未覆盖 / 3 漏放 / 0 已查）。"
            "给投放侧的变更请求直接引它，所以它必须可复算而不是手写。"},
    # ★ 2026-09-17（D15/D16 执行）：规则迁移保真度对账账本。
    #   它比 风险等级-还原.json 多挂四个输入（旧规则集 / 新规则 / 白名单 / 语境守卫），
    #   任一改动都会让它过期 —— 而它的结论正是「迁移不保真」，所以账一过期，
    #   结论就不再可信：V45b 与 kb_facts 都会在指纹对不上时直接报红。
    {"rules": ["research/governance/skeleton/_data/迁移保真度.json"],
     "class": "derived", "adr_ref": "§三 L2 落地澄清（同 records.json，下游可复算视图）",
     "generator": "research/governance/audit_migration_fidelity.py",
     "inputs": ["research/governance/skeleton/_data/records.json",
                "research/governance/skeleton/_data/rules_raw.json",
                "research/governance/skeleton/rules-v1.json",
                "research/governance/skeleton/whitelist-v1.json",
                "research/governance/skeleton/context-guards-v1.json"],
     "why": "旧规则集（21 条 H/M/U 编号）→ 骨架 v1 的迁移对账：94 个旧豁免词的语义去向、"
            "85 个无归属关键词、291 行的两次扫描逐行比对、源表自报片段的语料缺口。"
            "D15/D16 与错题本 B4/B5 都引它，所以它必须可复算而不是手写。"},
    {"rules": ["research/governance/skeleton/_data/miss_attribution.json"],
     "class": "derived", "adr_ref": "§三 L2 落地澄清（原文归 L1 字面清单，按判据改判 L2）",
     "generator": "research/governance/skeleton/attribute_misses.py",
     "inputs": ["research/governance/skeleton/rules-v1.json",
                "research/governance/skeleton/_data/records.json"],
     "why": "漏报归因。落地时按 L1 自己的判据（「机器生成的、可复算的」）改判 L2，见 §三 落地澄清。"},
    {"rules": ["research/landing/要素提取.json"],
     "class": "derived", "adr_ref": "§三 L2 落地澄清（同上）",
     "generator": "tools/lp_extract.py",
     "inputs": ["research/landing/抓取结果.json"],
     "why": "92 个页面 / 44 个商品 JSON 的六类要素。每次重跑都会变。"},
    # ★ 2026-09-17 改判：derived → primary。
    #
    #   原登记（class=derived, generator=engine_manifest.py, inputs=六个制品）**能过 B 面**
    #   —— 因为 B 面只查「生成脚本在 L1 + 输入可追溯」，**不查「跑出来是不是同一份」**。
    #   而 engine_manifest.py 复算不出这个账本：它只把「当前 manifest」追加一行；
    #   账本里那些行记的是**过去**的制品字节，那些字节在任何地方都没有第二份。
    #   §11.2 逐字警告过这件事：「如果笼统要求全部可复算，结果只会是给不可复算的东西
    #   编一个假的生成脚本」——**这一条就是那个假脚本**，它躺在 primary 条目上方
    #   十行处没被认出来，因为它长得和邻居一模一样。
    {"rules": ["research/governance/skeleton/_data/manifest-history.jsonl"],
     "class": "primary",
     "adr_ref": "§三 L2 · `manifest-history.jsonl`（2026-09-17 由 derived 改判，见 §十七）",
     "why": ("★★ **`engine_manifest.py` 复算不出它**：账本每行记的是那一次冻结时六个制品的"
             "真实 `sha256`，而那些字节**没有第二份** —— 飞书重拉、生成脚本、源表都拿不回 "
             "2026-09-16 18:07 的 `rules-v1.json`。ADR-0012 §6.1 又把它当成「旧回执可反查"
             "历史」的唯一依据，所以它恰恰是 L1 里**找不到第二份**的那类东西。"
             "改判后 B 面不再要求它可复算 —— 但这**只说明判据不适用，不等于耐久性问题"
             "解决了**：该账本被 `.gitignore` 忽略，目前是本机唯一副本，见 §十七。")},

    # ── primary：本身是账本，不可复算 ──────────────────────────────
    {"rules": ["research/governance/skeleton/_data/receipts.jsonl",
               "research/governance/skeleton/_data/receipts.chain.json",
               "research/governance/skeleton/_data/pushed.selftest.jsonl"],
     "class": "primary", "adr_ref": "§三 L2 · `receipts*.jsonl|json` · `pushed.selftest.jsonl`",
     "why": ("★★ **异议一那条判据（生成脚本 + 输入指纹）在它身上不成立**，"
             "而 §三 L2 给它的理由是「**追加型账本**：只会增长，不需要 diff 与回滚」——"
             "那**不是**「可复算」。一条回执记录的是「当时判了什么」，"
             "L1 里没有第二份，所以它**不可复算**、也**不该被要求可复算**。"
             "本类必须给 `why` 说明不可复算的理由，这正是本检查承认自己边界的地方。")},

    # ── runtime：进程运行态 ───────────────────────────────────────
    {"rules": ["PMO/logs/"], "class": "runtime", "adr_ref": "§三 L2 · `PMO/logs/`（B0.5 补录，见 §十一）",
     "why": ("守衡（飞书机器人）的进程日志：ws_daemon.log / ws_events.jsonl。"
             "运行态、只会增长、可复算性无意义。"
             "★ **B0.5 之前 ADR-0013 §三 从未收录它** —— 本模块第一次跑就抓到，已补录。")},
    {"rules": ["PMO/shouheng-state/"], "class": "runtime", "adr_ref": "§三 L2 · `PMO/shouheng-state/`（B0.5 补录，见 §十一）",
     "why": ("守衡的会话状态：seen-messages.json、sessions/chat_oc_*.json。"
             "含飞书 chat_id 与会话游标 —— 性质接近 §4.2 第 3 条的「内部资源标识」。"
             "★ **B0.5 之前 §三 同样未收录，已补录。**")},

    # ── addressed：内容寻址，文件名即指纹 ─────────────────────────
    {"rules": ["**/_evidence/"], "class": "addressed", "adr_ref": "§三 L2 · 一切 `_evidence/**`",
     "why": "`raw/html-a520e6ca17ab4d1d.gz` —— 文件名即指纹。不可变、自证，本来就不需要版本历史。"},

    # ── 一次性迁移备份 ────────────────────────────────────────────
    {"rules": ["research/governance/skeleton/_data/backup-batchD/",
               "research/governance/skeleton/_data/backup-migration/",
               "research/governance/skeleton/_data/deprecated/"],
     "class": "addressed", "adr_ref": "§三 L2 · `_data/backup-*/` · `deprecated/`",
     "why": "一次性迁移备份，有内容指纹可查。"},

    # ── 凭据与浏览器会话（L3 · 结构性防线）────────────────────────
    {"rules": ["**/SecretKey*.csv", "**/*secret*.csv", "**/*credential*.json",
               "**/*.pem", "**/id_rsa*"],
     "class": "forbidden", "adr_ref": "§三 L3 · 凭据 → 已按 D8 移出（~/.dsh/credentials/）",
     "why": "**结构性防线**：防止日后有人把凭据放回项目目录。真实凭据已于 2026-09-17 移出。"},
    {"rules": ["**/_cfprof*/", "**/_chromeprof*/"],
     "class": "forbidden", "adr_ref": "§三 L3 · 浏览器会话数据（显式再列一次）",
     "why": "含 Trust Tokens 等会话数据。已被 `**/_evidence/` 覆盖，此处**显式再列**，"
            "防止日后有人把 _evidence 整体提进 L1 时无人察觉。"},

    # ── 依赖与构建产物 ────────────────────────────────────────────
    {"rules": [".tools/bin/"], "class": "derived",
     "adr_ref": "§三 L2 · `.tools/bin/`（B1 补录）",
     "generator": "base/build_ocr.sh",
     "inputs": ["base/ocr_vision.m"],
     "why": ("本仓自己编译的 OCR 二进制。源码与重建脚本都在 L1 —— "
             "`bash base/build_ocr.sh` 一条命令重建。"
             "★ 编译要指定 SDK：本机默认的 MacOSX27.0 是坏的（SDK 由 Swift 6.4 构建、"
             "编译器是 6.3.3），脚本按「能用」顺序试而不是写死一个。")},
    {"rules": [".venv-r4/", ".pylibs/", ".vendor/", "node_modules/"],
     "class": "vendored", "adr_ref": "§三 L2 · 依赖与构建产物，可由清单重建",
     "why": "依赖与构建产物。"},
    {"rules": ["skills/", "research/repos/", "research/method/codex_research/",
               "research/method/Kb2Agent/"],
     "class": "vendored", "adr_ref": "§三 L2 · 别人管的（后四个各有自己的 .git）",
     "why": "第三方技能库与克隆；直接纳管会变成 gitlink 或重复纳管。"},
    {"rules": [".DS_Store", "**/.DS_Store"], "class": "vendored",
     "adr_ref": "§三 L2 · `.DS_Store`", "why": "macOS 元数据。"},
]


# ──────────────────────────────────────────────────────────────────

def sh(*args) -> str:
    r = subprocess.run(args, cwd=ROOT, capture_output=True, text=True)
    return r.stdout


def git_tracked(p: str) -> bool:
    return bool(sh("git", "ls-files", "--error-unmatch", p).strip())


def git_has_commits() -> int:
    out = sh("git", "rev-list", "--count", "HEAD").strip()
    return int(out) if out.isdigit() else 0


def gitignore_rules() -> list[str]:
    out = []
    for line in GITIGNORE.read_text(encoding="utf-8").splitlines():
        s = line.rstrip()
        if not s.strip() or s.lstrip().startswith("#"):
            continue
        out.append(s)
    return out


def claimed_rules() -> dict[str, dict]:
    m = {}
    for e in REGISTRY:
        for r in e["rules"]:
            m[r] = e
    return m


# ── 各面 ─────────────────────────────────────────────────────────

def modules_with_selftest() -> list[str]:
    """`base/` 下**真的声明了** `--selftest` 的模块。

    ★ 遗留 24 的修法：A 面的模块清单原本是**靠人维护**的 ——
      B1 交付了 `media.py`（20 项自证），而清单里没有它，
      于是那 20 项**没有任何东西会去跑**，模块回归了也没人知道。
      改成自动发现之后，「写了自证却没被跑」在结构上不可能再发生：
      清单漏掉一个模块，下面那条对照就会红。

    ★ 探测方式刻意用**静态文本**（源码里有没有 `--selftest`）而不是「跑一下试试」：
      跑一下会真的执行未知模块，而这一面要回答的是「谁**声明**了自证」。
    """
    me = Path(__file__).name
    out = []
    for p in sorted(HERE.glob("*.py")):
        if p.name == me:
            continue
        try:
            src = p.read_text(encoding="utf-8")
        except Exception:                                        # noqa: BLE001
            continue
        if '"--selftest"' in src or "'--selftest'" in src:
            out.append(p.name)
    return out


def face_A(run: bool) -> list[str]:
    """各面自证：**每一个交付的模块**的 --selftest 都必须退出 0。

    ★ B2 补了两行，因为这里原本漏了 `media.py`：
      B1 交付了它、也写了 20 项自证，但**没有任何东西会去跑那 20 项**。
      「自证写了」与「自证被跑」是两件事 —— 而漏掉的后果是静默的：
      模块回归了没人知道，因为没人在跑。

    ★★ B2·A 把它从「人维护清单」改成「自动发现 + 与清单对照」（遗留 24）：
      清单仍留着，因为它带着人写的标签；但**清单少一个模块就会红**。
      只扩充清单而不加这条对照，等于把同一个洞留在原地等下一次。
    """
    mods = [("contract.py", "ContentUnit 契约（B0.2）"),
            ("judge_adapter.py", "judge(unit) 适配层（B0.3）"),
            ("sync_rules.py", "权威源单向同步（B0.4）"),
            ("media.py", "图片/视频进管道（B1）"),
            ("text_stage.py", "文本两组三指标（B2）"),
            ("change_detect.py", "变更判据 claim-set-v1（B2·A）")]
    if not run:
        print("  （跳过：--no-selftests）")
        return []
    bad = []

    # ── 清单 vs 实际：**双向**对照 ────────────────────────────────
    declared = {f for f, _ in mods}
    found = set(modules_with_selftest())
    if len(found) < 2:
        # 探测本身坏掉时，下面两条「差集为空」会**假绿** —— 所以先钉住探测。
        bad.append("✗ 自动发现只找到 %d 个模块，这条对照是空的" % len(found))
        print("  ✗ 自动发现只找到 %d 个模块 —— 探测坏了，两条对照都在假绿" % len(found))
    missing = sorted(found - declared)
    if missing:
        bad.append("✗ 有 --selftest 却没被 A 面调用：%s" % "、".join(missing))
        print("  ✗ 这些模块写了自证，但没有任何东西会去跑它：%s" % "、".join(missing))
        print("     后果是静默的：模块回归了没人知道，因为没人在跑（遗留 24 的形态）")
    ghost = sorted(declared - found)
    if ghost:
        bad.append("✗ A 面登记的模块里，这些没有 --selftest：%s" % "、".join(ghost))
        print("  ✗ 清单里这几个模块并没有 --selftest：%s" % "、".join(ghost))
    if not missing and not ghost and len(found) >= 2:
        print("  ✓ 清单与自动发现一致（%d 个模块，双向无差）" % len(found))

    for f, label in mods:
        p = HERE / f
        if not p.exists():
            bad.append(f"✗ {f} 不存在 —— {label} 没交付")
            print(f"  ✗ {f:<18} 不存在")
            continue
        r = subprocess.run([sys.executable, str(p), "--selftest"],
                           capture_output=True, text=True, cwd=ROOT)
        n = r.stdout.count("✓")
        nneg = r.stdout.count("必红")
        ok = r.returncode == 0
        print(f"  {'✓' if ok else '✗'} {f:<18} {label:<24} 退出 {r.returncode} · "
              f"{n} 项（含 {nneg} 条必红）")
        if not ok:
            bad.append(f"✗ {label}：{f} --selftest 退出 {r.returncode}")
            for line in r.stdout.splitlines():
                if line.strip().startswith("✗"):
                    print("        " + line.strip()[:110])
    return bad


def face_B() -> list[str]:
    """L1 自足性 —— 异议一承诺的那条。"""
    bad = []
    by_class: dict[str, int] = {}
    for e in REGISTRY:
        by_class[e["class"]] = by_class.get(e["class"], 0) + len(e["rules"])
        if e["class"] == "derived_l2_generator":
            # ★ 2026-09-22 新增：**降级**，不是「判据不适用」。
            #   两条反向对照（face_F 的第 4/5 条）证明这两条断言真会红。
            g = e["generator"]
            if not (ROOT / g).exists():
                bad.append(f"✗ {g} 连盘上都没有 —— {e['rules'][0]} 既不在 L1 也不在 L2，"
                           f"「可复算」这个字在这里是假的")
            elif git_tracked(g):
                bad.append(f"✗ {g} **其实已被 git 跟踪** —— {e['rules'][0]} 的降级理由"
                           f"（生成脚本不在 L1）已经不成立，class 必须改回 `derived`。"
                           f"一条「因为它不在 L1 所以不查」的规则，在它回到 L1 之后就是免死金牌")
            for i in e["inputs"]:
                if not (ROOT / i).exists():
                    bad.append(f"✗ {e['rules'][0]} 的输入 {i} 不存在")
        if e["class"] != "derived":
            continue
        g = e["generator"]
        if not (ROOT / g).exists():
            bad.append(f"✗ {g} 不存在 —— {e['rules'][0]} 没有生成脚本")
            continue
        if not git_tracked(g):
            bad.append(f"✗ {g} **未被 git 跟踪** —— 生成脚本不在 L1 里，"
                       f"{e['rules'][0]} 因此不可复算")
        for i in e["inputs"]:
            if not (ROOT / i).exists():
                bad.append(f"✗ {e['rules'][0]} 的输入 {i} 不存在")
            elif not git_tracked(i) and not any(
                    (ROOT / r.rstrip("/")).exists() and r.rstrip("/") in i
                    for x in REGISTRY for r in x["rules"]):
                bad.append(f"✗ {e['rules'][0]} 的输入 {i} 既不在 L1、也不是已登记的 L2 产物")
    print(f"  按类计数：{by_class}")
    n_derived = sum(1 for e in REGISTRY if e["class"] == "derived")
    print(f"  derived 产物 {n_derived} 组，逐组查「生成脚本在 L1 + 输入可追溯」")
    n_down = [e for e in REGISTRY if e["class"] == "derived_l2_generator"]
    if n_down:
        print(f"  ★ 另 {sum(len(e['rules']) for e in n_down)} 条**降级**（`derived_l2_generator`）—— "
              f"它们**本来查得了**，是 2026-09-22 Q38 裁定「只收正文」把生成脚本移出 L1 造成的：")
        for e in n_down:
            print(f"      · {e['rules'][0]} ← 生成脚本 {e['generator']} 现在在 L2"
                  f"（盘上 {ROOT / e['generator']} / 已跟踪={git_tracked(e['generator'])}）")
        print(f"      ★ 这一格**不许**被读成「判据不适用」：可复算性没变，丢的是"
              f"**换台机器之后的**可复算性。生成脚本一旦回到 L1，上面两条断言会立刻报红，"
              f"逼着把 class 改回 derived（两个方向都有反向对照）")
    n_other = sum(1 for e in REGISTRY
                  if e["class"] not in ("derived", "derived_l2_generator"))
    print(f"  ★ 另 {n_other} 组**判据不适用**（addressed / primary / runtime / vendored / forbidden）"
          f"—— 异议一那条检查只对 derived 成立，这一点必须说出来，不能假装全查了")
    return bad


def face_C() -> list[str]:
    """分级一致性：.gitignore 每条规则都要被认领，且认领它的那条**在 ADR §三 里有出处**。"""
    bad = []
    rules = gitignore_rules()
    cm = claimed_rules()
    unclaimed = [r for r in rules if r not in cm]
    orphan = [r for r in rules if r not in cm]
    for r in unclaimed:
        bad.append(f"✗ `{r}` 在 .gitignore 里，但**登记表没有认领它** —— "
                   f"没人知道它盖住的是什么、凭什么")
    no_ref = [(r, cm[r]) for r in rules if r in cm and not cm[r].get("adr_ref")]
    for r, e in no_ref:
        bad.append(f"✗ `{r}` **ADR-0013 §三 从未收录** —— "
                   f".gitignore 头部自己写了「改动本文件 = 改动分级 = 需回到 §三 同步，"
                   f"否则台账与制品会漂移」，而它已经漂移了。（{e['why'][:80]}…）")
    extra = [r for r in cm if r not in rules]
    for r in extra:
        bad.append(f"⚠ 登记表认领了 `{r}`，但 .gitignore 里没有这条规则 —— 两边对不上")
    print(f"  .gitignore 有效规则 {len(rules)} 条 · 登记表认领 {len(cm)} 条 · "
          f"未认领 {len(unclaimed)} · ADR 无出处 {len(no_ref)}")
    print("  ★ 这条检查的存在理由：.gitignore 头部写着「改动本文件 = 改动分级 = 需回到 §三 同步，"
          "否则台账与制品会漂移」—— 而它**已经应验过一次**：B0.5 首跑抓到 PMO 两条规则无出处，已补录。")
    return bad


def face_D() -> list[str]:
    """产物完备性：盘上实际被 ignore 的文件，要么被登记，要么命中登记的模式。"""
    # ★ 必须 `-c core.quotePath=false`：否则 git 把中文路径输出成
    #   `"research/landing/\350\246\201..."`，与登记表里的真名永远对不上 ——
    #   第一版就是这样把 `要素提取.json` 误报成「未覆盖」的。
    #   这类错很危险：它看起来像**发现了问题**，其实只是**两边用了不同的编码**。
    out = sh("git", "-c", "core.quotePath=false",
             "ls-files", "--others", "--ignored", "--exclude-standard")
    files = [f for f in out.splitlines() if f.strip()]
    # 只查「本项目自己的」产物：跳过依赖、别人管的、以及 _evidence（已按 addressed 覆盖）
    SKIP = ("node_modules/", ".vendor/", ".pylibs/", ".venv-r4/", "skills/",
            "research/repos/", "research/method/", ".DS_Store", "_evidence/",
            "_cfprof", "_chromeprof", "backup-", "deprecated/")
    mine = [f for f in files if not any(s in f for s in SKIP)]
    cm = claimed_rules()
    unreg = []
    for f in mine:
        if any(f == r.rstrip("/") or f.startswith(r.rstrip("/") + "/") for r in cm):
            continue
        unreg.append(f)
    for f in unreg[:12]:
        print(f"  ✗ 未被任何登记项覆盖：{f}")
    print(f"  盘上本项目 L2/L3 文件 {len(mine)} 个 · 未覆盖 {len(unreg)} 个 · "
          f"（另跳过依赖/别人管的/_evidence 共 {len(files)-len(mine)} 个）")
    return [f"✗ {len(unreg)} 个 L2/L3 文件未被登记表覆盖（首例 {unreg[0] if unreg else ''}）"] if unreg else []


def face_E() -> list[str]:
    """版本控制面。**只报告，不把「工作区脏」判成红** —— 开发中本来就该脏。"""
    bad = []
    if not (ROOT / ".git").exists():
        return ["✗ 不是 git 仓库 —— D1 的第一刀没落地"]
    n = git_has_commits()
    print(f"  提交数 {n}")
    if n == 0:
        bad.append("✗ 有 .git 但没有任何提交 —— 等于没有历史")
    st = sh("git", "status", "--short").strip()
    dirty = [x for x in st.splitlines() if x.strip()]
    print(f"  工作区：{'干净' if not dirty else '%d 项未提交' % len(dirty)}")
    for x in dirty[:5]:
        print("    " + x[:100])
    print(f"  跟踪文件 {len(sh('git','ls-files').splitlines())} 个")
    return bad


def face_F() -> list[str]:
    """反向对照：把登记表做坏，检查必须红。"""
    bad = []
    # 1) 认领一条不存在的规则 → extra 必须报
    saved = list(REGISTRY)
    try:
        REGISTRY.append({"rules": ["这条规则不存在/"], "class": "derived",
                         "adr_ref": "x", "generator": "不存在.py", "inputs": [], "why": ""})
        got = face_C() + face_B()
        if not any("没有这条规则" in x for x in got):
            bad.append("✗ 反向对照失败：认领了不存在的规则，face_C 没报")
        else:
            print("  ✓ 必红：认领 .gitignore 里没有的规则 → face_C 报「两边对不上」")
    finally:
        REGISTRY[:] = saved
    # 2) 把一条 derived 的生成脚本改成不存在的 → face_B 必须红
    try:
        REGISTRY.append({"rules": ["research/landing/不存在.json"], "class": "derived",
                         "adr_ref": "§三", "generator": "tools/根本没有这个脚本.py",
                         "inputs": [], "why": ""})
        got = face_B()
        if not any("没有生成脚本" in x for x in got):
            bad.append("✗ 反向对照失败：生成脚本不存在，face_B 没报")
        else:
            print("  ✓ 必红：derived 产物的生成脚本不存在 → face_B 报「没有生成脚本」")
    finally:
        REGISTRY[:] = saved
    # 3) 把一条输入改成不在 L1 也不在 L2 的路径 → face_B 必须红
    try:
        e = next(x for x in REGISTRY if x["class"] == "derived")
        e["inputs"] = list(e["inputs"]) + ["这个输入不存在.json"]
        got = face_B()
        if not any("不存在" in x and "这个输入不存在.json" in x for x in got):
            bad.append("✗ 反向对照失败：输入不存在，face_B 没报")
        else:
            print("  ✓ 必红：derived 产物的输入不存在 → face_B 报出该路径")
    finally:
        REGISTRY[:] = saved
    # 4) ★ 2026-09-22：`derived_l2_generator` 的**两个方向**都必须会红。
    #    这一类是新加的「降级」格，它的危险不是写错，是**变成永久的免死金牌** ——
    #    所以既要拦住「生成脚本连盘上都没有」，也要拦住「它其实已经回到 L1 了却还挂着降级」。
    try:
        REGISTRY.append({"rules": ["假产物/"], "class": "derived_l2_generator",
                         "adr_ref": "§三", "generator": "tools/根本没有这个脚本.py",
                         "inputs": [], "why": ""})
        got = face_B()
        if not any("连盘上都没有" in x for x in got):
            bad.append("✗ 反向对照失败：降级项的生成脚本不存在，face_B 没报")
        else:
            print("  ✓ 必红：derived_l2_generator 的生成脚本连盘上都没有 → face_B 报「可复算是假的」")
    finally:
        REGISTRY[:] = saved
    # 5) 反向对照：降级项的生成脚本**已被跟踪**（= 它回到 L1 了）→ 必须红
    try:
        REGISTRY.append({"rules": ["假产物2/"], "class": "derived_l2_generator",
                         "adr_ref": "§三", "generator": "base/build_ocr.sh",
                         "inputs": [], "why": ""})
        got = face_B()
        if not any("其实已被 git 跟踪" in x for x in got):
            bad.append("✗ 反向对照失败：降级项的生成脚本其实已被跟踪，face_B 没报 "
                       "—— 这条不红，降级就会变成永久免死金牌")
        else:
            print("  ✓ 必红：降级项的生成脚本其实已被跟踪 → face_B 报「降级理由已不成立，改回 derived」")
    finally:
        REGISTRY[:] = saved
    return bad


def main() -> int:
    ap = argparse.ArgumentParser(description="基座自证（第⑤面）")
    ap.add_argument("--no-selftests", action="store_true",
                    help="跳过 A 面（各模块的 --selftest），只跑仓库治理四条")
    a = ap.parse_args()

    print("=" * 78)
    print("基座自证 · %s" % CONTRACT_VERSION)
    print("=" * 78)
    faces = [("A 各模块自证", lambda: face_A(not a.no_selftests)),
             ("B L1 自足性（异议一）", face_B),
             ("C 分级一致性（.gitignore ↔ ADR §三）", face_C),
             ("D 产物完备性", face_D),
             ("E 版本控制", face_E),
             ("F 反向对照", face_F)]
    allbad: list[str] = []
    for name, fn in faces:
        print(f"\n[{name}]")
        try:
            if name.startswith("F"):
                # 反向对照会调 face_B / face_C，它们自己会打印 —— 这里静音，
                # 否则「检查的输出」会淹没「检查的结果」。
                import contextlib
                buf = io.StringIO()
                with contextlib.redirect_stdout(buf):
                    got = fn()
                for ln in buf.getvalue().splitlines():
                    if "必红" in ln:
                        print(ln)
            else:
                got = fn()
        except Exception as e:                              # noqa: BLE001
            got = [f"✗ {name} 自己崩了：{type(e).__name__}: {e}"]
        allbad += got

    print("\n" + "=" * 78)
    if allbad:
        print("✗ 基座自证未通过：%d 项" % len(allbad))
        for x in allbad:
            print("   " + x[:150])
        print("=" * 78)
        return 2
    print("✓ 基座自证全绿：各模块自证通过 · L1 自足性通过 · 分级与 .gitignore 一致 · 无未登记产物")
    print("=" * 78)
    return 0


if __name__ == "__main__":
    sys.exit(main())

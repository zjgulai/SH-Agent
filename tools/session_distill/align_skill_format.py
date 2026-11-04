#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""P2 格式对齐：给 L0–L7 的 14 个 skill 补齐 creator Schema 的**结构件**。

    python3 tools/session_distill/align_skill_format.py            # 预演
    python3 tools/session_distill/align_skill_format.py --apply    # 真写

冻结令（Owner 2026-10-15 定）：**description 与正文断言语义逐字保留。**
所以本脚本**一个字节都不写 SKILL.md** —— 全部动作都在 SKILL.md 之外：

  ① 补 `.skill-meta/manifest.yaml`（如实登记：非 creator 创建、Iron Law 未跑）
  ② 补 `README.md`（极简，指向 SKILL.md）
  ③ 空的 `references/` 加 `.gitkeep`
  ④ 修「引用了不存在的文件」—— 建出被引用但缺失的 `references/自生长台账.md`
  ⑤ 同步装载位（源 → 装位，`cp -p`）

**不做的**（逐条写明理由，不是漏做）：
  · 不动 `agents/`、`vendor/`  —— validator 不认本项目的约定目录；删了会破坏 DSH 侧
  · 不改 description          —— Owner 冻结令；那 11 项不合规**保留并登记**
  · 不拆 `kb-pipeline` 正文   —— 把正文搬进 references/ 会改变「常加载什么」= 改行为
  · 不改第二人称              —— 属正文，冻结令覆盖

退出码：0=全过 ｜ 1=有红 ｜ 2=未测
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import datetime

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
LAND = os.path.join(REPO, "PMO", "会话蒸馏-20261015", "落地")
KB = "/Users/lute/Documents/skill-test/执行skills/执行skills/skills-回归测试/知识库/内容治理"
DESK = "/Users/lute/Desktop/skill/内容治理中文skill"
SLOT = os.path.expanduser("~/.dsh/skills")
VALIDATE = os.path.expanduser("~/.dsh/skills/root-skills-creator/scripts/validate-skill.py")
DAY = datetime.date.today().strftime("%Y-%m-%d")

# (装位目录名, 源目录)
TARGETS = [(n, os.path.join(DESK, n)) for n in (
    "内容审查总控", "送审登记", "证据源维护", "文案合规审查", "产品宣称核验",
    "图片安全审查", "视频安全审查", "美国本地化审查", "AI溯源与权利审查",
    "审查裁决", "审查报告与记忆", "审查流程评测", "飞书审查流转",
)] + [("kb-pipeline", os.path.join(KB, "kb/l7/skills/kb-pipeline"))]

README_TMPL = """# {name}

> 本文件由 `align_skill_format.py` 生成（{day}），只为满足 Universal Skill Schema 的
> 「README.md 建议」一条。**权威入口是 [`SKILL.md`](./SKILL.md)** —— 触发词、判断与边界全在那里。

- 装位：`~/.dsh/skills/{name}/`
- 结构登记：[`.skill-meta/manifest.yaml`](./.skill-meta/manifest.yaml)
"""

LEDGER_TMPL = """# 自生长台账

> 由 `kb/l8/skill_growth.py` 自动追加。**这是唯一由机器写入的文件之一** ——
> 它只记「哪一轮长了什么、回验过没过、闸门结果」，不改任何指令。
>
> 本文件在 2026-10-15 由 `align_skill_format.py` **预建**：因为 `SKILL.md` 的追加节
> 引用了它，而它当时还不存在 —— 那是一条「引用了不存在的文件」，
> 被 `root-skills-creator/scripts/validate-skill.py` 当场抓到。

| 日期 | 轮 | 新卡片 | 指针回验过 | 指针不过 | skills_check 第3类 | 结果 |
|---|---|---|---|---|---|---|
"""


def sha(s):
    return hashlib.sha256(s.encode()).hexdigest()


def read(p):
    with open(p, encoding="utf-8", errors="replace") as f:
        return f.read()


def write_cp(p, s):
    """★ 走 cp 通道落盘 —— python 直写 .md/.yaml 在本机会落成 +4096 信封。"""
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = p + ".tmp-nosuffix"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(s)
    subprocess.run(["/bin/cp", tmp, p], check=True)
    os.unlink(tmp)


def frontmatter(path):
    t = read(path)
    m = re.match(r"^---\n(.*?)\n---", t, flags=re.S)
    return m.group(1) if m else ""


def fm_get(fm, key):
    m = re.search(r"^%s:\s*(.*)$" % re.escape(key), fm, flags=re.M)
    if not m:
        return ""
    v = m.group(1).strip()
    return v.strip('"')


def dirs_of(src):
    out = {}
    for d in ("scripts", "references", "examples", "tests", "evals", "assets",
              "agents", "vendor", "eval-reports", "registry", "templates"):
        p = os.path.join(src, d)
        if not os.path.isdir(p):
            continue
        files = sorted(x for x in os.listdir(p) if not x.startswith("."))
        out[d] = {"exists": True, "count": len(files), "files": files[:20]}
    return out


def manifest_for(name, src):
    fm = frontmatter(os.path.join(src, "SKILL.md"))
    ver = fm_get(fm, "version") or "0.0.0"
    desc = fm_get(fm, "description")
    if not desc:
        m = re.search(r"^description:\s*\|?\s*\n((?:[ \t]+.*\n)+)", fm, flags=re.M)
        desc = (m.group(1).strip().splitlines()[0] if m else "")[:200]
    return {
        "skill": {
            "name": name,
            "version": ver,
            "structure_version": "1.0",
            "created_at": "未登记",
            "updated_at": DAY,
            "created_by": "**未登记 —— 本 skill 不是 root-skills-creator 创建的**（登记表里唯一有 creator 署名的是 kb-l0-feishu）",
            "format_aligned_at": DAY,
            "format_aligned_by": "tools/session_distill/align_skill_format.py",
            "description": desc[:300],
        },
        "directories": dirs_of(src),
        "gates": {
            "iron_law_red": "pending — **未跑**（本 skill 从未走过 Iron Law）",
            "iron_law_green": "pending",
            "iron_law_refactor": "pending",
            "eval_track_c": "pending — 走 root-skills-eval",
            "pre_launch_checklist": "pending — 10 项未逐项审",
        },
        "known_nonconformance": [
            "description 未按 CSO 口径补触发条件 /（AI溯源与权利审查）超 1024 字符 —— "
            "**Owner 2026-10-15 冻结令：description 是 DSH 的路由开关，一律不改**；本项保留并登记",
            "`agents/`（与 `vendor/`）不是 Universal Skill Schema 的允许目录，但**是本项目的约定目录**，故保留",
            "（仅 kb-pipeline）正文 10788 字符 > complex 上限 8000 —— 搬进 references/ 会改变"
            "「常加载什么」，属改行为，故不拆",
        ],
        "note": (
            "本文件由 `align_skill_format.py` 于 %s 生成，目的是让 14 个 L0–L7 skill 的**结构件一致**。\n"
            "★ 它**如实登记 pending**，不是「通过门禁」—— 有 `.skill-meta/` 只说明缺口可见，"
            "不代表质量达标（对照 kb-l0-feishu：有 manifest，iron_law 五项至今 pending）。\n"
            "★ 生成过程**一个字节都没写 SKILL.md**。" % DAY
        ),
    }


def manifest_yaml(m):
    import yaml

    class Dumper(yaml.SafeDumper):
        pass

    def str_presenter(dumper, data):
        if "\n" in data:
            return dumper.represent_scalar("tag:yaml.org,2002:str", data, style="|")
        return dumper.represent_scalar("tag:yaml.org,2002:str", data)

    Dumper.add_representer(str, str_presenter)
    return yaml.dump(m, Dumper=Dumper, allow_unicode=True, sort_keys=False, width=100)


def validate(src):
    r = subprocess.run([sys.executable, VALIDATE, src, "--json"], capture_output=True, text=True)
    try:
        d = json.loads(r.stdout)
    except Exception:
        return None
    return d


def run(apply):
    n_pass = n_fail = 0
    before, after = {}, {}
    actions = []
    for name, src in TARGETS:
        if not os.path.isdir(src):
            print("✗ %s：源目录不存在 %s" % (name, src))
            n_fail += 1
            continue
        sk = os.path.join(src, "SKILL.md")
        fm_before = frontmatter(sk)
        before[name] = sha(fm_before + "\x00" + read(sk))
        v = validate(src)
        before[name + "|v"] = (len(v.get("errors") or []), len(v.get("warnings") or [])) if v else None

        todo = []
        # ① manifest
        mp = os.path.join(src, ".skill-meta", "manifest.yaml")
        if not os.path.exists(mp):
            todo.append("+.skill-meta/manifest.yaml")
            if apply:
                write_cp(mp, manifest_yaml(manifest_for(name, src)))
        # ② README
        rp = os.path.join(src, "README.md")
        if not os.path.exists(rp):
            todo.append("+README.md")
            if apply:
                write_cp(rp, README_TMPL.format(name=name, day=DAY))
        # ③ 空 references/ 加 .gitkeep
        refd = os.path.join(src, "references")
        if os.path.isdir(refd) and not [x for x in os.listdir(refd) if not x.startswith(".")]:
            todo.append("+references/.gitkeep")
            if apply:
                write_cp(os.path.join(refd, ".gitkeep"), "")
        # ④ 补齐被引用但不存在的文件
        skt = read(sk)
        for m in re.finditer(r"`?(references/[^\s`\]]+\.md)`?", skt):
            rel = m.group(1)
            # ★ 护栏：SKILL.md 里会出现**缩写引用**（`references/…-2-judgments.md`），
            #   而真名是 `references/us-locale-baseline-2-judgments.md` 且**存在**。
            #   照着缩写建文件会造出一个名字里带省略号的垃圾 —— creator 的 validator
            #   也在这条上误报（它同样把缩写当路径）。含 `…` 或 `*` 的一律跳过。
            if "…" in rel or "*" in rel or rel.count("/") != 1:
                continue
            if not os.path.exists(os.path.join(src, rel)):
                todo.append("+%s（被 SKILL.md 引用但不存在）" % rel)
                if apply:
                    if "自生长台账" in rel:
                        write_cp(os.path.join(src, rel), LEDGER_TMPL)
                    else:
                        write_cp(os.path.join(src, rel),
                                 "# %s\n\n> 本文件由 `align_skill_format.py` 预建："
                                 "`SKILL.md` 引用了它但它不存在。**内容待补。**\n" % os.path.basename(rel))
        # ⑤ 同步装载位
        slot = os.path.join(SLOT, name)
        if apply and not os.path.islink(slot):
            for rel in ("README.md", ".skill-meta/manifest.yaml"):
                s = os.path.join(src, rel)
                if os.path.exists(s):
                    t = os.path.join(slot, rel)
                    os.makedirs(os.path.dirname(t), exist_ok=True)
                    subprocess.run(["/bin/cp", "-p", s, t], check=True)
            if os.path.isdir(os.path.join(src, "references")):
                for x in os.listdir(os.path.join(src, "references")):
                    s = os.path.join(src, "references", x)
                    if os.path.isfile(s):
                        t = os.path.join(slot, "references", x)
                        os.makedirs(os.path.dirname(t), exist_ok=True)
                        subprocess.run(["/bin/cp", "-p", s, t], check=True)

        fm_after = frontmatter(sk)
        after[name] = sha(fm_after + "\x00" + read(sk))
        same = (before[name] == after[name])
        actions.append((name, todo, same))

    print("── P2 格式对齐 " + ("（--apply 真写）" if apply else "（预演，不落盘）"))
    print("%-16s %-6s %s" % ("skill", "冻结", "动作"))
    for name, todo, same in actions:
        print("%-16s %-6s %s" % (name, "✅" if same else "❌改了SKILL", "；".join(todo) or "（已齐）"))
        if same:
            n_pass += 1
        else:
            n_fail += 1

    print("")
    print("★ 冻结令断言（description + 正文逐字未变）：%d/%d" % (n_pass, n_pass + n_fail))
    if apply:
        print("")
        print("── 复跑 creator 的验证器（前后对比）")
        for name, src in TARGETS:
            v = validate(src)
            b = before.get(name + "|v")
            if not v or not b:
                print("   %-16s ⚠ 未测" % name)
                continue
            a = (len(v.get("errors") or []), len(v.get("warnings") or []))
            flag = "✅" if a[0] == 0 else "❌"
            print("   %-16s %s errors %d→%d  warnings %d→%d" % (name, flag, b[0], a[0], b[1], a[1]))
    return 1 if n_fail else 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()
    return run(a.apply)


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""_migrate_ids_batch11.py —— D37 落地：KB 线自有编号一律加 `KB-` 前缀。

只做一件事，台账的 `D#` / `Q#` **一字不动**：

    · 数据缺口     `D#`  →  `KB-GAP-#`
    · 黄金问题     `Q#`  →  `KB-Q-#`
    · verify_kb 检查 `D#` →  `KB-CHK-#`

## 为什么不能按文件排除

D37 的 `accepted_risk` 写明了理由，这里再写一遍因为它就是这个脚本的形状：

  · 台账 `D1`–`D16` 与缺口 `D1`–`D16` **完全重叠** → 范围规则分不开；
  · `knowledge库-v1.json` 一个文件里缺口 `D3`、台账 `D28`、黄金问题 `Q10` 并存
    → 文件规则分不开；
  · `research/kb/索引-本地资产.json` 的 10 处 `D#/Q#` **没有一处是编号**
    （`FF D8 FF` 是 JPEG 魔数，`规则 D1` 是文档里的规则标签），
    `research/kb/台账-v1.json` 的 6 处 `D8` 全是**产品型号**
    → 「扫出来的」与「真的是」之间差着一遍逐句读。

所以本脚本用**行号锚定**替换：每一处都点名在哪一行、把哪个 token 换掉，
行号对不上就中止。`--write` 之前先跑默认模式，逐处核对。

## 用法

    python3 tools/_migrate_ids_batch11.py          # 只打印将改什么（不改盘）
    python3 tools/_migrate_ids_batch11.py --write  # 落盘

幂等：已含 `KB-GAP-` / `KB-Q-` / `KB-CHK-` 的文件会被识别为已迁移并跳过。
"""

import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WRITE = "--write" in sys.argv

KB = "research/kb"

# ── 全文件正则规则：(pattern, repl, 预期命中数或 None) ────────────────────
REGEX_RULES = {
    f"{KB}/缺口-v1.json": [
        (r'"id": "D(\d+)"', r'"id": "KB-GAP-\1"', 16),
        (r'"affects": \[([^\]]*)\]',
         lambda m: '"affects": [' + re.sub(r'"([DQ])(\d+)"',
                                           lambda x: '"KB-%s-%s"' % ("GAP" if x.group(1) == "D" else "Q",
                                                                     x.group(2)),
                                           m.group(1)) + ']', 16),
    ],
    f"{KB}/知识库-v1.json": [
        (r'"缺口编号": "D(\d+)"', r'"缺口编号": "KB-GAP-\1"', 4),
        (r'黄金问题 Q10', r'黄金问题 KB-Q-10', 1),
    ],
    f"{KB}/外部标准库-v1.json": [
        (r'〔缺口:D(\d+)〕', r'〔缺口:KB-GAP-\1〕', 1),
    ],
    f"{KB}/README.md": [
        (r'〔缺口:D(\d+)〕', r'〔缺口:KB-GAP-\1〕', 18),
        (r'G3（D1/D3）', r'G3（KB-CHK-1/KB-CHK-3）', 1),
        (r'（C1–C10 / D1,D3 / E1–E5）', r'（C1–C10 / KB-CHK-1,KB-CHK-3 / E1–E5）', 1),
    ],
    "tools/kb_facts.py": [
        (r'(?<![A-Za-z0-9_#-])D(\d+)(?![0-9])', r'KB-GAP-\1', 14),
    ],
    "tools/kb_gaps.py": [
        (r'"id": "D(\d+)"', r'"id": "KB-GAP-\1"', 16),
        (r'"affects": \[([^\]]*)\]',
         lambda m: '"affects": [' + re.sub(r'"([DQ])(\d+)"',
                                           lambda x: '"KB-%s-%s"' % ("GAP" if x.group(1) == "D" else "Q",
                                                                     x.group(2)),
                                           m.group(1)) + ']', 16),
    ],
}

# ── 行号锚定规则：{文件: [(行号, 原 token, 新 token), …]} ─────────────────
# 行号 = 迁移**前**的 1-based 行号（替换不增删行，故锚定有效）。
LINE_RULES = {
    # ── `〔缺口:X〕` 标记是**活指针**，登记的编号改了它们就悬空 ──────────────
    #   ★ 只改这一种形态，外加**同句里紧跟着指同一件事**的裸编号。
    #   ★ ADR-0013 里的裸 `D#` **不动**：它自带一套局部决策编号（`§一 D1–D9`、
    #     `§8.2 D22–D30`），与台账 `D1`–`D37` 完全无关 —— 在那一套怎么处置定下来
    #     之前动手，等于把一次改名做两遍。已记为新的未决项（见 Q36）。
    "ADR/ADR-0013-基座接口冻结与仓库入库分级.md": [
        (1564, '〔缺口:D2〕', '〔缺口:KB-GAP-2〕'),
        (1675, '〔缺口:D9〕', '〔缺口:KB-GAP-9〕'),
        (1691, '〔缺口:D8〕', '〔缺口:KB-GAP-8〕'),
        (1691, '把 D8 从登记表里删掉', '把 KB-GAP-8 从登记表里删掉'),
    ],
    "research/governance/源表口径-风险等级-变更请求.md": [
        (3,   '〔缺口:D9〕', '〔缺口:KB-GAP-9〕'),
        (161, '〔缺口:D15〕', '〔缺口:KB-GAP-15〕'),
        (162, '（D15 的原表述', '（KB-GAP-15 的原表述'),
    ],
    "research/governance/端到端送审-演练报告.md": [
        (76,  '〔缺口:D9〕', '〔缺口:KB-GAP-9〕'),
        (99,  '缺口 `D15`', '缺口 `KB-GAP-15`'),
    ],
    # ★ kb_classes.py 是**生成器**：第一遍迁移漏了它，于是 `python3 tools/kb_classes.py`
    #   又把裸 `D#` 写了回去 —— 只扫制品、不扫生成器，迁移就会被下一次重算悄悄回滚。
    "tools/kb_classes.py": [
        (55,  '"缺口": "D8"', '"缺口": "KB-GAP-8"'),
        (63,  '"缺口": "D7"', '"缺口": "KB-GAP-7"'),
        (69,  '"缺口": "D6"', '"缺口": "KB-GAP-6"'),
        (75,  '"缺口": "D3"', '"缺口": "KB-GAP-3"'),
        (210, '黄金问题 Q10', '黄金问题 KB-Q-10'),
        # ★ L139 / L207 的 `D28` **故意不改** —— 那是台账决定（kb 线）。
    ],
    f"{KB}/缺口-v1.json": [
        (37,  '"why": "Q7 原先的理由是', '"why": "KB-Q-7 原先的理由是'),
        (169, '执行 D9 时把', '执行 KB-GAP-9 时把'),
        (169, '经 D15 逐行对账', '经 KB-GAP-15 逐行对账'),
        (169, '显示名（见 D15）', '显示名（见 KB-GAP-15）'),
        (290, '"why": "D9 逐行还原时', '"why": "KB-GAP-9 逐行还原时'),
        (317, '这正是 D9 那类合并计数病', '这正是 KB-GAP-9 那类合并计数病'),
        # ★ L290 `即 D3 法务定案的那次修正` **故意不改** —— 台账 D3 =
        #   「4 个走错通道的词（FDA 注册 / silent mode / 静音模式 / suction settings）
        #   迁入白名单表」，正是这句话说的那件事。注意：同一个文件里 `D9`/`D15` 是缺口，
        #   `D3` 是台账 —— **这就是「范围规则分不开」的现场**。
    ],
    "tools/kb_gaps.py": [
        (9,   'c.add("D2", "缺口显式声明"', 'c.add("KB-CHK-2", "缺口显式声明"'),
        (13,  '在 `Q7` 明确打印', '在 `KB-Q-7` 明确打印'),
        (16,  '而 `Q7` 那句', '而 `KB-Q-7` 那句'),
        (26,  '· `Q7` 的 GAP 声明', '· `KB-Q-7` 的 GAP 声明'),
        (95,  '"why": "Q7 原先的理由是', '"why": "KB-Q-7 原先的理由是'),
        (192, '执行 D9 时把', '执行 KB-GAP-9 时把'),
        (195, '经 D15 逐行对账', '经 KB-GAP-15 逐行对账'),
        (202, '显示名（见 D15）', '显示名（见 KB-GAP-15）'),
        (317, '"why": "D9 逐行还原时', '"why": "KB-GAP-9 逐行还原时'),
        (378, '这正是 D9 那类合并计数病', '这正是 KB-GAP-9 那类合并计数病'),
        # ★ L327 `即 D3 法务定案的那次修正` **故意不改** —— 经查台账 D3 =
        #   「4 个走错通道的词（FDA 注册 / silent mode / 静音模式 / suction settings）
        #   迁入白名单表」，正是这句话说的那件事。这是台账编号。
    ],
    "tools/kb_query.py": [
        (148, '_gap_lines("D1")', '_gap_lines("KB-GAP-1")'),
        (150, '_gap_lines("D2"', '_gap_lines("KB-GAP-2"'),
        (160, '把 D1 换成', '把 KB-GAP-1 换成'),
        (161, 'D99，E1 仍然全绿', 'KB-GAP-99，E1 仍然全绿'),
    ],
    "tools/verify_kb.py": [
        (25,  '见 §D2 的历史', '见 §KB-CHK-2 的历史'),
        (183, '── D1-D3 G3 可用性', '── KB-CHK-1–KB-CHK-3 G3 可用性'),
        (203, '这正是原来的 D2 想守', '这正是原来的 KB-CHK-2 想守'),
        (209, 'Q7 产出的是一个', 'KB-Q-7 产出的是一个'),
        (211, '#   D1 守「有没有结论」', '#   KB-CHK-1 守「有没有结论」'),
        (212, 'c.add("D1", "黄金问题全部产出结论"', 'c.add("KB-CHK-1", "黄金问题全部产出结论"'),
        (218, '取代原先恒为 True 的 D2', '取代原先恒为 True 的 KB-CHK-2'),
        (402, '把 D8 从登记表里删掉', '把 KB-GAP-8 从登记表里删掉'),
        (403, '_d8 = reg.get("D8")', '_gap8 = reg.get("KB-GAP-8")'),
        (407, 'f"〔缺口:D8〕（{_d8.get(\'status\') if _d8 else \'—\'}）',
              'f"〔缺口:KB-GAP-8〕（{_gap8.get(\'status\') if _gap8 else \'—\'}）'),
        (409, '登记表里没有 D8', '登记表里没有 KB-GAP-8'),
        (466, 'c.add("D3", "查询手册"', 'c.add("KB-CHK-3", "查询手册"'),
        (469, 'c.add("D1", "黄金问题可答"', 'c.add("KB-CHK-1", "黄金问题可答"'),
    ],
}

# ── 明确不动、且必须在残余扫描里被认出来的台账引用 ───────────────────────
#   ★ 判据不是「硬编码一张允许清单」，而是「**它必须在台账里真实存在**」——
#     所以这里改成读台账。别名区（`$renamed_from` / `RENAMED_FROM`）要整段
#     剥掉再扫，否则台账 `D1`–`D16` 会让缺口旧编号蒙混过关，判据变恒真。
LEDGER_FILE = "research/governance/skeleton/legal-decisions-v1.json"

EXEMPT_REGIONS = {
    f"{KB}/缺口-v1.json": [('"$renamed_from": {', "\n },")],
    "tools/kb_gaps.py": [("RENAMED_FROM = {", "\n}")],
}

# 残余扫描**故意跳过**的文件：它们的裸 `D#` 不是漏改，是另有主人。
#   ADR-0013 自带局部决策编号（`§一 D1–D9`、`§8.2 D22–D30`），与台账无关；
#   它还逐字引用了当年那段有缺陷的检查代码（`c.add("D2", …)`）——
#   在引文里改编号会把引文改成假话。这两件事都已记为未决项 Q36，
#   在裁定之前不动它们。
NO_LEFTOVER_SCAN = {
    "ADR/ADR-0013-基座接口冻结与仓库入库分级.md":
        "自带局部决策编号 D1–D9 / D22–D30；另有逐字引用的旧代码。待 Q36 裁定。",
}


def ledger_ids():
    d = json.load(open(os.path.join(ROOT, LEDGER_FILE), encoding="utf-8"))
    return ({x["id"] for x in d["decisions"]}
            | {x["id"] for x in d["$decision_queue"]})


def strip_exempt(path, text):
    for start, end in EXEMPT_REGIONS.get(path, []):
        i = text.find(start)
        if i < 0:
            continue
        j = text.find(end, i)
        if j > 0:
            text = text[:i] + text[j + len(end):]
    return text

# 已迁移标记：任一出现即认为该文件已处理过
DONE_MARKERS = ("KB-GAP-", "KB-Q-", "KB-CHK-")


def already_done(text):
    return any(m in text for m in DONE_MARKERS)


def plan_one(path):
    """返回 (新文本, [(行号, 旧片段, 新片段)], [错误])"""
    full = os.path.join(ROOT, path)
    text = open(full, encoding="utf-8").read()
    msgs, errs = [], []

    for pat, repl, expect in REGEX_RULES.get(path, []):
        n = len(re.findall(pat, text))
        if expect is not None and n != expect:
            errs.append(f"{path}: 规则 {pat!r} 命中 {n} 处，预期 {expect} 处 —— 盘上内容变了，中止")
            continue
        msgs.append(f"{path}: 正则 {pat!r} × {n}")
        text = re.sub(pat, repl, text)

    lines = text.split("\n")
    for lineno, old, new in LINE_RULES.get(path, []):
        i = lineno - 1
        if i >= len(lines):
            errs.append(f"{path}: L{lineno} 超出文件长度")
            continue
        if old not in lines[i]:
            errs.append(f"{path}: L{lineno} 找不到 {old!r}\n        实际：{lines[i][:110]!r}")
            continue
        lines[i] = lines[i].replace(old, new)
        msgs.append(f"{path}: L{lineno}  {old!r} → {new!r}")
    return "\n".join(lines), msgs, errs


def main():
    targets = sorted(set(REGEX_RULES) | set(LINE_RULES))
    all_msgs, all_errs, writes = [], [], []

    for path in targets:
        full = os.path.join(ROOT, path)
        if not os.path.exists(full):
            all_errs.append(f"{path}: 文件不存在")
            continue
        if already_done(open(full, encoding="utf-8").read()):
            all_msgs.append(f"{path}: ⏭ 已迁移过，跳过")
            continue
        new, msgs, errs = plan_one(path)
        all_msgs += msgs
        all_errs += errs
        if not errs:
            writes.append((full, new))

    if all_errs:
        print("❌ 预检未通过，**不写任何文件**：\n")
        for e in all_errs:
            print("   " + e)
        return 1

    print("── 计划 ──")
    for m in all_msgs:
        print("   " + m)

    # 残余扫描：改完之后，这几个文件里剩下的裸 D#/Q# 必须**都在台账里存在**
    print("\n── 残余裸 D#/Q#（必须都是台账编号；别名区已剥掉）──")
    _led = ledger_ids()
    left_ok = True
    for path in targets:
        if path in NO_LEFTOVER_SCAN:
            print(f"   ⏭ {path}\n      跳过：{NO_LEFTOVER_SCAN[path]}")
            continue
        full = os.path.join(ROOT, path)
        text = next((n for f, n in writes if f == full),
                    open(full, encoding="utf-8").read())
        found = sorted({m.group(0) for m in re.finditer(
            r'(?<![A-Za-z0-9_#-])([DQ])(\d{1,3})(?![0-9])', strip_exempt(path, text))})
        extra = [t for t in found if t not in _led]
        flag = "✅" if not extra else "❌"
        if extra:
            left_ok = False
        print(f"   {flag} {path}: 剩 {found or '无'}"
              + (f"　★ 不在台账里：{extra}" if extra else ""))

    if not left_ok:
        print("\n❌ 残余扫描发现非台账编号，**不写任何文件**")
        return 1

    if not WRITE:
        print(f"\n（dry-run）将改写 {len(writes)} 个文件。加 --write 落盘。")
        return 0

    for full, new in writes:
        open(full, "w", encoding="utf-8").write(new)
        print(f"   ✎ {os.path.relpath(full, ROOT)}")
    print(f"\n✅ 已改写 {len(writes)} 个文件")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

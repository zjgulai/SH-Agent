#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
verify_agents_budget.py —— `AGENTS.md` 的工作区指令预算 + 「搬走了的东西还在不在」

── 为什么要有这个文件（`AGENTS.md` §2.4：写进文档的每一个上限，必须指得出哪一行在拦它）

`AGENTS.md` 顶到工作区指令预算（**65536 字节**）时，**注入版会被截掉尾部** ——
而尾部正是 §2.6 红线与 §2.7 重启闸门。这是实测过一次的，记录在
`PMO/填充态-环境特性-实测史.md` 的抬头。

但在此之前，**全仓没有任何一行代码在拦这个上限**：2026-09-22 实测，
`grep -rn 65536 tools/` 只命中两个无关的 `余量`。也就是说这条上限此前是
**一句写在别处的话**，越界方式是**静默的** —— 不报错、不变红，只是注入给 agent 的
宪法少了一截尾巴，而没有任何人会发现。这正是 §2.4 点名的那个病，
这次长在**宪法自己身上**。

── 两半判定，缺一半都不算数

  ① **预算**：本文件超 65536 → 红；余量不足**写一条教训**（实测 3288 字节）→ 也红。
     3288 不是拍的：§2.4.7 那一节加进去时，文件从 60102 涨到 63390，净增 3288。
     **余量小于它，就意味着「下一条教训写不进去了」** —— 那是个现在就该知道的事。

  ② **搬运完整**（§2.4「搬是搬，砍是砍 —— 一个字符不丢」）：
     2026-09-22 把 §2.1 里那段填充态材料搬进了 `PMO/填充态-环境特性-实测史.md`。
     实测发现**搬运只做了一半**：正文同时存在于两个文件，预算被白白占着。
     而更早一次单独比对时还发现 AGENTS.md 那份多一个从句
     （「首次全仓库扫出 332 个（含本文件）」），**照直删就会丢掉一个实测读数**。

     所以这里断言两件相反的事，**成对才有意义**：
       · 那份文件里**逐字含**特征串（没搬丢）；
       · 本文件里**一个都不含**（确实删了，不是两份并存）。
     只断言其中一条，另一个方向就是恒真的。

退出码：0 全过 ｜ 1 红 ｜ 2 未测（读不到文件 —— **未测不许和通过长得一样**）

用法：
  python3 tools/verify_agents_budget.py            # 查真的 AGENTS.md
  python3 tools/verify_agents_budget.py --controls # 反向对照：喂合成尺寸，证判据会红
  python3 tools/verify_agents_budget.py --file X   # 换个文件查（自证用，默认 AGENTS.md）
"""
from __future__ import annotations

import argparse
import os
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_TARGET = os.path.join(REPO_ROOT, 'AGENTS.md')
#: 被搬出去的那一份（指针就写在 §2.1 表下面）
EXTRACTED = os.path.join(REPO_ROOT, 'PMO', '填充态-环境特性-实测史.md')

#: 工作区指令预算。来源：`PMO/填充态-环境特性-实测史.md` 抬头记的实测读数。
BUDGET = 65536
#: 实测：§2.4.7 那一节的净增量（60102 → 63390）。余量小于它 = 写不下下一条教训。
LESSON = 3288

#: 搬运完整性的探针。挑的是那句**差点被丢掉**的从句与几个只属于那段正文的记号。
#:
#: ★ `落盘配方` **不在这个列表里**，单列在下面 —— 原因是本文件第一版就栽在这上面：
#:   指针那句正文里写着「……以及「落盘配方」—— 已搬到 ……」，于是「本文件里不许出现它」
#:   这条断言**被指针自己打红了**。这正是 §2.4.4 记过的第三次翻车
#:   （「扫描器被它自己的解释文字绊倒」），第三次出现，形状一模一样。
#:   判据要么排除指针区，要么换个只活在正文里的记号 —— 这里选后者，因为它更粗、更不会骗人。
PROBES = ['首次全仓库扫出', '三次更正', '二次更正', '4119']
#: 只用来证「那份里有」的探针：它们的词面**在指针里也会出现**，所以证不了「这份里没有」。
PROBES_EXTRACT_ONLY = ['落盘配方']


def judge(size: int | None, *, budget: int = BUDGET, lesson: int = LESSON) -> tuple[int, str]:
    """纯函数：给一个字节数，回退出码与一句话。`size=None` 表示**没测到**。"""
    if size is None:
        return 2, '读不到文件 —— 未测（不是通过，也不是红）'
    if size > budget:
        return 1, (f'{size} 字节 > 预算 {budget}，**已越线 {size - budget}** —— '
                   f'注入版正在被截掉尾部（尾部 = §2.6 红线 + §2.7 重启闸门）')
    margin = budget - size
    if lesson > 0 and margin < lesson:
        return 1, (f'余量只剩 {margin} 字节 < 一条教训的 {lesson} —— '
                   f'**再写一节 §2.4.x 就会越线**，而越线是静默的（先腾地方，或先合并）')
    # ⚠️ `lesson=0` 是把两条规则**分开测**用的（见 `controls()`）——
    #    这里必须挡住 `margin // lesson`，否则反向对照自己 ZeroDivisionError。
    #    第一版没挡，`--controls` 直接崩；**真判定是绿的，崩的是自证** ——
    #    与实际生产无关的写法，在自证里照样要当成 bug 修。
    tail = f'够写 {margin // lesson} 条教训' if lesson > 0 else '教训规则已关闭'
    return 0, f'{size} 字节 · 余量 {margin}（{tail}）'


def read_text(path: str) -> str | None:
    try:
        with open(path, encoding='utf-8') as f:
            return f.read()
    except Exception:
        return None


def check(target: str) -> tuple[int, list[tuple[str, bool, str]]]:
    """跑真判定。回 (退出码, [(断言名, 过没过, 说明)])。"""
    rows: list[tuple[str, bool, str]] = []

    tgt = read_text(target)
    if tgt is None:
        rows.append(('B1 能读到目标文件', False, f'读不到 {target} → 未测'))
        return 2, rows
    size = os.path.getsize(target)
    code, why = judge(size)
    rows.append(('B1 预算与余量', code == 0, why))
    if code == 2:
        return 2, rows

    # ── 搬运完整性：两半，成对 ────────────────────────────────────────────
    src = read_text(EXTRACTED)
    rows.append(('B2 被搬去的那份存在', src is not None, EXTRACTED))
    if src is None:
        return 2, rows

    missing = [p for p in PROBES + PROBES_EXTRACT_ONLY if p not in src]
    rows.append(('B3 那份里**逐字**含着探针（没搬丢）', not missing,
                 '缺：' + '、'.join(missing) if missing
                 else f'{len(PROBES) + len(PROBES_EXTRACT_ONLY)} 个探针全在'))

    left = [p for p in PROBES if p in tgt]
    rows.append(('B4 本文件里**一个都不含**（确实删了，不是两份并存）', not left,
                 '仍残留：' + '、'.join(left) if left
                 else f'{len(PROBES)} 个探针 0 残留 —— 那段正文只存在于一处'))

    # ── 指针不许断 ────────────────────────────────────────────────────────
    fname = os.path.basename(EXTRACTED)
    rows.append(('B5 本文件里有指回那一份的指针（否则读的人找不到）', fname in tgt,
                 fname if fname in tgt else f'正文里没有 `{fname}` 这几个字'))

    return (0 if all(ok for _, ok, _ in rows) else 1), rows


def verdict(n_red: int, n_untested: int) -> str:
    """结论行**自己不许撒谎**（与 `verify_shouheng_ops.py` 的 H1–H7 同一条）。"""
    if n_untested:
        return '⚠ 有未测 —— 这不是通过'
    return '❌ 有红 —— 预算或搬运完整性有问题' if n_red else '✅ 全过'


def controls() -> int:
    """反向对照：喂**合成**尺寸，证明判据既会红也会闭嘴。"""
    cases = [
        ('超一个字节 → 必须红', judge(BUDGET + 1), 1),
        # ★ 边界要**把两条规则分开**才证得了：`judge(BUDGET)` 会走「余量不足一条教训」
        #   那一支（余量 0），红是对的 —— 本文件第一版把期望写成 0，当场被自己的对照打红。
        #   那不是代码错，是我把两条独立规则混在一个用例里测了。
        ('恰好等于预算 + 关掉教训那条规则 → **不许**红（边界是 `>` 不是 `≥`）',
         judge(BUDGET, lesson=0), 0),
        ('恰好等于预算（教训规则开着）→ 必须红：余量 0，写不下任何东西',
         judge(BUDGET), 1),
        ('余量恰好等于一条教训 → 不许红', judge(BUDGET - LESSON), 0),
        ('余量比一条教训少 1 字节 → 必须红', judge(BUDGET - LESSON + 1), 1),
        ('读不到（None）→ 必须是 2 未测，**不许**是 0', judge(None), 2),
    ]
    ok = True
    for name, (code, why), want in cases:
        good = code == want
        ok &= good
        print(f'  {"✅" if good else "❌"} {name} —— 得 {code}（要 {want}）：{why}')

    # 行为级：真的造一个超预算的文件跑一遍完整判定。
    # ★ 后缀用 `.txt`，**不是 `.md`** —— 本环境里 Python 写 `.md` 会进填充态
    #   （stat 比真实内容多 4096），那样这个自证就会用**被污染的读数**去验预算。
    #   一个验字节数的检查器，自己先被字节数骗一次，那就白写了。
    import tempfile
    tmpdir = tempfile.mkdtemp(prefix='agents-budget-')
    big = os.path.join(tmpdir, 'big.txt')
    with open(big, 'w', encoding='utf-8') as f:
        f.write('x' * (BUDGET + 1))
    real = os.path.getsize(big)             # ★ 用外部读数，不信自己刚写的那个数
    code, _rows = check(big)
    good = code == 1 and real == BUDGET + 1
    ok &= good
    print(f'  {"✅" if good else "❌"} 行为级：造一个 {real} 字节的文件 → 判定退 {code}（要 1）')
    return 0 if ok else 1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--controls', action='store_true', help='反向对照（离线、不碰 AGENTS.md）')
    ap.add_argument('--file', default=DEFAULT_TARGET, help='要查的文件（默认 AGENTS.md）')
    args = ap.parse_args()

    if args.controls:
        print('反向对照：喂合成尺寸 —— 该红时必须红，该闭嘴时必须闭嘴')
        rc = controls()
        print('-' * 72)
        print('✅ 反向对照全过' if rc == 0 else '❌ 反向对照有失败 —— 判据是坏的')
        return rc

    code, rows = check(args.file)
    print('=' * 72)
    print(f'AGENTS.md 指令预算与搬运完整性 —— {args.file}')
    print(f'  预算 {BUDGET} 字节 · 一条教训 {LESSON} 字节 · 被搬去的那份 {os.path.relpath(EXTRACTED, REPO_ROOT)}')
    print('=' * 72)
    for name, ok, why in rows:
        print(f'  {"✅" if ok else "❌"} {name}\n      {why}')
    n_red = sum(1 for _, ok, _ in rows if not ok)
    print('-' * 72)
    print(verdict(n_red, 1 if code == 2 else 0))
    if code == 0 and n_red:
        return 1                      # 防御：结论行与明细不许不一致
    return code


if __name__ == '__main__':
    sys.exit(main())

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
_rc_d38.py —— 第十二批（D38）的反向对照：**逐条证明判据会红**

## 为什么必须有它

D37 落地当天出了三条「迁移自己制造的新病」，**没有一条会自己喊**：
漏扫生成器、改完正则匹配不上新编号（判据变成恒真）、打印分组按前缀猜（整段消失且退出码仍 0）。
第十二批改的是同一类东西（编号），所以同一类病会再来一次。

本脚本对**真文件**注入缺陷 → 跑**真判据** → 断言它以**预期那句话**报红 → 逐字节还原 → 复核 sha256。
★ 只断言「退出码非 0」是不够的：恒真的判据也会因为别的检查红而让整体非 0。
  每一条都断言**预期的那句话**出现，才证明是**这条**判据抓到的。

★ 最后一条断言是最容易被省、也最值钱的：**全部还原之后，全量验收必须重新全绿。**
  没有它，「绿」可能只是判据坏了 —— 而那是本项目修过不止一次的病。

用法：
  python3 tools/_rc_d38.py
  python3 tools/_rc_d38.py -v
"""

import hashlib
import json
import os
import re
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from depad import depad, external_size  # noqa: E402  —— cp 往返 + 外部 stat，理由见下面的「还原」段

ADR = os.path.join(REPO, "ADR", "ADR-0013-基座接口冻结与仓库入库分级.md")
LED = os.path.join(REPO, "research", "governance", "skeleton", "legal-decisions-v1.json")
PLAN = os.path.join(REPO, "PMO", "守衡-创建全景图与知识库体系-讨论稿-v1.md")
RECON = os.path.join(REPO, "research", "governance", "skeleton", "_data", "遗留对账.json")

VERBOSE = "-v" in sys.argv


def sha(p):
    return hashlib.sha256(open(p, "rb").read()).hexdigest()


def run(cmd):
    r = subprocess.run(cmd, shell=True, cwd=REPO, capture_output=True, text=True)
    return r.stdout + r.stderr


def sub_once(path, old, new):
    """只在**恰好命中一次**时改写；命中 0 次或多次直接抛 —— 后者说明锚点不够特异。"""
    s = open(path, encoding="utf-8").read()
    n = s.count(old)
    if n != 1:
        raise AssertionError(f"锚点在 {os.path.basename(path)} 里命中 {n} 次（要求恰好 1 次）: {old[:60]!r}")
    open(path, "w", encoding="utf-8").write(s.replace(old, new))


# ── 注入清单：(文件, 说明, 注入函数, 判据命令, 预期出现在输出里的那句话) ──
def injections():
    return [
        ("往 ADR-0013 新写一处非白名单的裸 `D5`",
         lambda: sub_once(ADR, "## 六、异议留档", "## 六、异议留档\n\n（本批新写的裸 D5，未被白名单登记）\n"),
         "python3 tools/verify_engine_contract.py --only V46",
         "D5"),

        ("把 ADR 一处白名单号改掉（`D14` 是台账引用，改了就成未命中）",
         lambda: sub_once(ADR, "（D14），广告组查不到人", "（ADR13-D14），广告组查不到人"),
         "python3 tools/verify_engine_contract.py --only V46",
         "白名单未被命中"),

        ("把 ADR 的 `ADR13-` 前缀抹掉一处（回到撞号状态）",
         lambda: sub_once(ADR, "### ADR13-D1 · 第一刀", "### D1 · 第一刀"),
         "python3 tools/verify_engine_contract.py --only V46",
         "D1"),

        ("台账里造一个重复别名（把 `遗留 7@8.5` 改成 `遗留 7@五`）",
         # ★ 必须改 **aliases 数组里的那一行**，不能改 `id` —— 第一版改的是 `id`，
         #   而 `id` 只是 aliases[0] 的一份拷贝，唯一性判据扫的是 aliases 数组，
         #   于是注入**什么也没抽掉**、判据报绿，而我把这记成了「检查没抓到」。
         #   这是反向对照本身的错，不是判据的错 —— V29e 与 V30e 都栽过同一跤：
         #   **反向对照必须真的能动，否则它证明的是自己没坏。**
         lambda: sub_once(LED, '     "遗留 22"', '     "遗留 21"'),
         "python3 tools/verify_engine_contract.py --only V46",
         "同时指"),

        ("台账里把撞号别名的表域限定去掉（`遗留 10@五` → `遗留 10`）",
         # ★ 第二次踩同一个坑：第一版改的是 `id`（= aliases[0] 的副本），判据扫的是
         #   `aliases` 数组，所以注入**什么也没抽掉**。而它当时报了「抓到」——
         #   因为预期字符串 `未加域` 是**消息模板里的常量**，判据绿着它也在。
         #   两件事合起来是一条：**反向对照必须真的能动，且预期必须只在判据红时出现。**
         lambda: sub_once(LED, '     "遗留 10@五"', '     "遗留 10"'),
         "python3 tools/verify_engine_contract.py --only V46",
         "未加域：['遗留 10"),

        ("台账 D35 的批次标签写回错的（B6 → B7）",
         lambda: sub_once(LED, "B6 交付最小评测集", "B7 交付最小评测集"),
         "python3 tools/verify_engine_contract.py --only V46",
         "vs 表"),

        ("台账 D34 拿掉批次标签（表里认领了它，它却不标）",
         lambda: sub_once(LED, "批次：**B7**（讨论稿 §八：K6 + K0 成库）", "批次：见讨论稿 §八"),
         "python3 tools/verify_engine_contract.py --only V46",
         "台账却没标批次"),

        ("讨论稿 §八 的 B7 行拿掉 Q 引用（表侧断链）",
         lambda: sub_once(PLAN, "**K6 + K0 成库**（Q29=C / Q32=A）", "**K6 + K0 成库**（已裁定）"),
         "python3 tools/verify_engine_contract.py --only V46",
         "无人认领"),

        ("Q36 回指一个不存在的决定（D99）",
         lambda: sub_once(LED, '"record": "legal-decisions-v1.json · D38"',
                          '"record": "legal-decisions-v1.json · D99"'),
         "python3 tools/verify_engine_contract.py --only V30",
         "D99"),

        ("把对账产物的撞号集合清空（V46b 的撞号来源被抽掉）",
         lambda: sub_once(RECON, '"collide_numbers": [', '"collide_numbers_unused": ['),
         "python3 tools/verify_engine_contract.py --only V46",
         "对账产物结构不全"),

        # ── 下面两条是 D38 落地**当天自己踩出来的**，所以各留一个对照 ──
        ("把对账产物变成过期快照（源指纹对不上）",
         lambda: sub_once(RECON, '"source_sha256": "', '"source_sha256": "0000'),
         "python3 tools/verify_engine_contract.py --only V46",
         "源已变"),

        ("登记处造一个悬空别名（`遗留 20` → `遗留 99`，ADR 里没有 99）",
         lambda: sub_once(LED, '     "遗留 20"', '     "遗留 99"'),
         "python3 tools/verify_engine_contract.py --only V46",
         "悬空别名"),
    ]


def main():
    results = []
    for name, inject, cmd, expect in injections():
        # ★ 还原用**内存快照**，不用 `git checkout`。
        #   本批的改动还没提交，`git checkout -- <file>` 会把整批工作一起回滚 ——
        #   一个「还原工具」顺手毁掉被验的东西，比不还原更坏。
        snap = {p: open(p, "rb").read() for p in (ADR, LED, PLAN, RECON)}
        try:
            inject()
        except AssertionError as e:
            results.append((name, False, f"注入失败（锚点问题）：{e}"))
            continue
        out = run(cmd)
        hit = expect in out
        if VERBOSE and not hit:
            print(out[-1500:])
        results.append((name, hit, f"预期「{expect}」→ {'抓到' if hit else '❌ 没抓到'}"))
        # ── 逐字节还原 ──
        for p, blob in snap.items():
            if open(p, "rb").read() != blob:
                with open(p, "wb") as f:
                    f.write(blob)
            if open(p, "rb").read() != blob:
                results.append((f"  ↳ 还原 {os.path.basename(p)}", False, "❌ 还原后与快照不一致"))
            # ★ 2026-09-22 补：**还原本身也是一次 Python 写盘**，而快照里的 `ADR` 与 `PLAN`
            #   都是 `.md` —— 实测「Python 写 `.md`」会让 `stat` 比真实内容多 4096，
            #   于是这份文件对 `read` 工具来说**变成了打不开的**（内容是对的、sha256 一致，
            #   所以它不报错、也不会被本脚本的任何断言抓到）。见 `AGENTS.md` §2.1 的
            #   2026-09-22 二次更正：填充**只**命中 `.md` / `.sh`。
            #   也就是说：这份反向对照每跑一次，就把它为验证判据而改过的那几份 **`.md`**
            #   弄成打不开的样子。修法是补一次 cp 往返（§2.1：非要动盘就事后 depad），
            #   并在填充还在时报出来 —— 不许静默。
            why = depad(p)
            if why:
                results.append((f"  ↳ depad {os.path.basename(p)}", False, why))
            else:
                ext, real = external_size(p), os.path.getsize(p)
                if ext is not None and ext != real:
                    results.append((f"  ↳ depad {os.path.basename(p)}", False,
                                    f"❌ 仍在填充态：stat {ext} vs 真实 {real}"))

    # ── 关键收尾：还原之后，全量验收必须重新全绿 ──
    full = run("python3 tools/verify_engine_contract.py")
    m = re.search(r"验收 (\d+)/(\d+)", full)
    allgreen = bool(m) and m.group(1) == m.group(2)
    results.append(("还原后全量验收重新全绿", allgreen,
                    f"{m.group(0) if m else '未取到计数'}"))

    ok = sum(1 for _, o, _ in results if o)
    print(f"\n{'=' * 70}\n第十二批反向对照 {ok}/{len(results)}\n{'=' * 70}")
    for n, o, d in results:
        print(f"  {'✅' if o else '❌'} {n}\n        {d}")
    return 0 if ok == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())

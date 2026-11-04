#!/usr/bin/env python3
"""
verify_depad.py —— 常驻检查：仓库里有没有「read 工具打不开」的文件

## 这个文件为什么存在

2026-09-18 实测到一个环境缺陷，最小复现：

    printf 'hello world ascii only\n' > a.md    # 外部命令写
    stat -f '%z' a.md   →  23      ✅ read 工具打得开
    printf 'hello world ascii only\n' > b.md    # 同样内容
    stat -f '%z' b.md   →  4119    ❌ read 工具报 "binary file"（多 4096）

同一份内容、同一个目录，**只要文件是用 Python 写出来的**，`stat` 报的大小就会
比真实内容多 **4096 字节**，DSH 的 `read` 工具据此把文件判成 `binary file`，
正文一个字都读不出来。

实测矩阵（2026-09-18，同一份 69 字节内容）：

    python3 -c "... print(...)" > f      → stat 4165  ❌ 被填充
    python3 -c "open(f,'w').write(...)"  → stat 4165  ❌ 被填充
    python3 script.py                    → stat 4165  ❌ 被填充
    node -e "fs.writeFileSync(...)"      → stat   69  ✅ 正常
    node script.mjs                      → stat   69  ✅ 正常
    printf / cat / dd / cp               → stat   69  ✅ 正常
    DSH 的 write / edit 工具              → stat   69  ✅ 正常

**是 Python 专属的。** 别记成「子进程写出的都算」—— `cp` 也是子进程，它不填充，
而这正是本工具用来修的手段。

**内容本身是对的。** `python open().read()` 与 `shasum -a 256` 读到的字节完全一致，
只有 `stat` 在撒谎。所以这不是数据损坏，是**视图不一致** —— 但后果一样严重：
**一个读不出来的文档，等于不存在。**

全仓库首次扫出 **308 个**文件处于这个状态，包括 `AGENTS.md`（真实 4909B / stat 9005B）
和 `research/governance/_evidence/` 下几十份一手资料。

## 为什么必须让外部命令来修

既然只有「外部进程的写路径」会触发填充，绕开办法也就只有一条：
**让外部命令把它重写一遍**（`cp` 就够）。本工具的 `--fix` 就做这件事，
而且对每个文件做 **sha256 前后比对**，内容变一个字节就报错退出 ——
修「读数」绝不能顺手改「内容」。

## 为什么不能「反正能跑就行」

本项目的生成物是给人读的。生成物读不出来，README 里那句「改数字的唯一方式是重跑脚本」
就没人验证得了 —— 又回到「界面上看得见 ≠ 已经生效」那条老病（AGENTS.md 2.2 第 3 条）。

## 用法

    python3 tools/verify_depad.py            # 只检查（退出码非 0 = 有文件打不开）
    python3 tools/verify_depad.py -v         # 列出每一个
    python3 tools/verify_depad.py --fix      # 修（cp 往返 + sha256 断言）
    python3 tools/verify_depad.py --fix -v   # 修并逐个打印
"""

from __future__ import annotations

import hashlib
import os
import subprocess
import sys
from collections import Counter

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 只查这些后缀 —— 二进制资产（png/xlsx/zip）没有「读得出来」这回事
EXTS = (".md", ".py", ".mjs", ".js", ".cjs", ".ts", ".json", ".yml", ".yaml",
        ".txt", ".csv", ".tsv", ".sh", ".toml", ".cfg", ".ini", ".html", ".css")
# 不进这些目录 —— 依赖、虚拟环境、浏览器缓存不是我们的内容
SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv-r4", ".pylibs",
             ".vendor", ".tools", "_chromeprof_cdp", ".mypy_cache", ".pytest_cache"}

PAD = 4096                       # 实测的固定差值
BATCH = 400                      # 一条 stat 命令最多带多少个路径


def walk_targets():
    out = []
    for root, dirs, files in os.walk(REPO):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for f in files:
            if f.endswith(EXTS):
                out.append(os.path.join(root, f))
    return out


def stat_sizes(paths):
    """用**外部** stat 批量取大小 —— 这是唯一能看到填充的视角。

    python 自己的 os.stat 走的是逻辑视图（返回真实大小），看不到填充，
    所以这里必须开子进程。这不是绕远路，是这个缺陷的定义本身。
    """
    seen = {}
    for i in range(0, len(paths), BATCH):
        chunk = paths[i:i + BATCH]
        try:
            r = subprocess.run(["stat", "-f", "%z\t%N", *chunk],
                               capture_output=True, text=True, timeout=120)
        except Exception as e:
            print(f"⚠️ stat 调用失败（{type(e).__name__}）—— 本工具无法判断，不当作通过")
            return None
        for line in r.stdout.splitlines():
            size, _, path = line.partition("\t")
            if size.strip().isdigit():
                seen[path.strip().strip("'")] = int(size)
    return seen


def scan():
    """→ (padded, other) ；padded = 差恰好 +4096 的；other = 其他不一致（要人看）"""
    targets = walk_targets()
    seen = stat_sizes(targets)
    if seen is None:
        return None, None, len(targets)
    padded, other = [], []
    for p in targets:
        real = os.path.getsize(p)
        s = seen.get(p)
        if s is None:
            continue                       # /N 在部分平台不可靠，取不到就不判
        if s == real:
            continue
        (padded if s - real == PAD else other).append((p, real, s))
    return padded, other, len(targets)


def fix(padded, verbose):
    ok, bad = 0, []
    for p, real, s in padded:
        before = hashlib.sha256(open(p, "rb").read()).hexdigest()
        tmp = p + ".depad.tmp"
        try:
            subprocess.run(["cp", p, tmp], check=True, capture_output=True)
            subprocess.run(["mv", tmp, p], check=True, capture_output=True)
        except Exception as e:
            if os.path.exists(tmp):
                os.remove(tmp)
            bad.append((p, f"{type(e).__name__}: {e}"))
            continue
        after = hashlib.sha256(open(p, "rb").read()).hexdigest()
        if before != after:
            bad.append((p, f"❌ 内容被改动！{before[:16]} → {after[:16]}"))
            continue
        ok += 1
        if verbose:
            print(f"  ✅ {os.path.relpath(p, REPO)}  {s}B → {os.path.getsize(p)}B")
    return ok, bad


def main():
    verbose = "-v" in sys.argv
    do_fix = "--fix" in sys.argv
    print("=" * 72)
    print("depad 检查 —— 仓库里有没有「read 工具打不开」的文件")
    print("=" * 72)

    padded, other, n = scan()
    if padded is None:
        print("❌ 无法完成检查（stat 不可用）。不当作通过。")
        return 2

    print(f"扫描 {n} 个文本文件 · 被填充 {len(padded)} 个 · 其他不一致 {len(other)} 个")
    if padded:
        print(f"\n被填充的（stat 比真实内容多 {PAD}B → read 工具报 binary file）：")
        for p, real, s in padded[:40 if not verbose else len(padded)]:
            print(f"  {os.path.relpath(p, REPO)}   真实 {real}B · stat {s}B")
        if not verbose and len(padded) > 40:
            print(f"  …另有 {len(padded) - 40} 个（-v 看全部）")
    if other:
        print(f"\n⚠️ 差值**不是** {PAD} 的 {len(other)} 个 —— 这可能是另一回事，需要人看：")
        for p, real, s in other[:20]:
            print(f"  {os.path.relpath(p, REPO)}   真实 {real}B · stat {s}B  (差 {s - real})")

    if do_fix and padded:
        print(f"\n修复 {len(padded)} 个（cp 往返，逐个 sha256 前后比对）…")
        ok, bad = fix(padded, verbose)
        print(f"\n修好 {ok} 个；失败或内容变动 {len(bad)} 个")
        for p, why in bad:
            print(f"  ❌ {os.path.relpath(p, REPO)}：{why}")
        if bad:
            return 1
        # 修完必须复验 —— 不复验就等于「界面上看得见当成已经生效」
        padded2, _, _ = scan()
        print(f"复验：剩余被填充 {len(padded2)} 个")
        if padded2:
            return 1
        print("✅ 全部清除")
        return 0

    if padded or other:
        if not do_fix:
            print("\n修复：python3 tools/verify_depad.py --fix")
        return 1
    print("\n✅ 没有打不开的文件")
    return 0


if __name__ == "__main__":
    sys.exit(main())

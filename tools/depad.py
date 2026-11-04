#!/usr/bin/env python3
"""tools/depad.py —— 「去填充」的唯一实现：Python 写的生成物，做完 cp → mv 往返

## 这个模块为什么存在

本机有一个环境缺陷：**用 Python 写出来的文件，`stat` 报的大小会比真实内容多 4096 字节**，
DSH 的 `read` 工具据此把文件判成 `binary file`，正文一个字都读不出来。
内容本身是对的（`python open().read()` 读得出、`shasum -a 256` 对得上），
所以这是**视图不一致**，不是数据损坏 —— 但后果一样严重：**一个读不出来的文档，等于不存在。**

绕开办法只有一条：**让外部命令把它重写一遍**（`cp` 就够）。本模块做这件事，
并对每个文件做 **sha256 前后比对** —— 修「读数」绝不能顺手改「内容」。

`tools/verify_depad.py` 是**检查器**（扫全仓、报有几个被填充、`--fix` 批量修）；
本模块是**库**（给生成器在写完那一刻就地调用）。两者用同一套 cp 往返 + sha256 手法，
但一个是 CLI、一个是可 import 的函数，刻意不互相 import。

## ★ 实测的触发条件 —— 与 AGENTS.md §2.1 那张表**不完全一致，以本节的读数为准**

2026-09-22 实测（23 字节同一内容，写在新建的空目录里，用**外部** `stat -f %z` 读）：

| 写出方式 | `.md` | `.sh` | `.json` `.txt` `.py` `.mjs` `.yml` … |
|---|---|---|---|
| Python `open(...,'w').write()` | **4119** ❌ | **4119** ❌ | 23 ✅ |
| Python `print(...)` + shell 重定向 | **4119** ❌ | 未测 | 未测 |
| shell `printf` | 23 ✅ | 23 ✅ | 23 ✅ |
| shell `cp` | 23 ✅ | 未测 | 未测 |
| Node `fs.writeFileSync` | 23 ✅ | 未测 | 23 ✅ |

后缀是**单独一维**，不是「凡 Python 写的都会」：

```
f_00.md         stat 4119   python 读 23   ← 填充
f_11.sh         stat 4119   python 读 23   ← 填充
f_01.markdown   stat   23   ✅       （注意：`.markdown` 不填充，只有 `.md`）
f_05.json       stat   23   ✅
f_08.py         stat   23   ✅
f_12.bash       stat   23   ✅       （`.bash`/`.zsh` 不填充，只有 `.sh`）
（复现：见下方「复现命令」）
```

两个条件**同时**成立才填充：**① 写入进程是 Python；② 后缀 ∈ {`.md`, `.sh`}**。
与大小无关：50000 字节的 `.md` → stat 54096（差仍是 4096），同样大小的 `.json` → 50000。

**这条与 AGENTS.md §2.1 的差别要说清楚，否则会误导下一个人**：§2.1 写的是
「凡是 Python 脚本生成的文件，写完做一次 cp → mv 往返」—— 方向是对的、做了不会有坏处，
但**它多算了后缀这一维**。实测的后果是：`tools/verify_depad.py` 的 `EXTS` 里
有 15 个后缀（`.py .mjs .js .cjs .ts .json .yml .yaml .txt .csv .tsv .toml .cfg .ini .html .css`）
**永远不会命中填充** —— 它们留在表里不造成误报，但会让人以为「扫了 17 类」。
（`verify_depad.py` 是检查器，本模块无权改它的口径；此处只记录读数。）

**所以本模块的定位**：对 `.md` / `.sh` 生成物，它是**必需**的；
对其它后缀，它是**廉价的保险**（一次 cp + 一次 sha256，代价可忽略），
且如果环境的后缀集合将来变宽，它已经在那儿了。

## 复现命令

```bash
rm -rf /tmp/pd && mkdir -p /tmp/pd && cd /tmp/pd
python3 -c "open('a.md','w').write('hello world ascii only\\n')"
python3 -c "open('a.json','w').write('hello world ascii only\\n')"
printf 'hello world ascii only\\n' > a_shell.md
stat -f '%z %N' a.md a.json a_shell.md     # → 4119 / 23 / 23
```

## 用法

    from depad import depad
    err = depad("/abs/path/to/生成物.md")   # None = 正常；str = 失败原因（别吞掉它）
"""
from __future__ import annotations

import hashlib
import os
import subprocess

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def sha256(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def depad(path):
    """让**外部命令**把 `path` 重写一遍（cp → mv），消掉环境的 +4096 填充。

    返回 `None` 表示「已经正常 / 修好了」；返回 `str` 表示失败原因。
    **调用方不许把返回值吞掉** —— 修不动就要出声，否则又回到「界面上看得见当成已经生效」。

    内容不变由 sha256 前后比对保证：一个字节不同就抛 AssertionError，
    绝不「顺手」把生成物的内容改了。
    """
    if not os.path.exists(path):
        return None
    before = sha256(path)
    tmp = path + ".depad.tmp"
    try:
        subprocess.run(["cp", path, tmp], check=True, capture_output=True)
        subprocess.run(["mv", tmp, path], check=True, capture_output=True)
    except Exception as e:                       # cp/mv 不可用时不致命，但必须出声
        if os.path.exists(tmp):
            os.remove(tmp)
        return "depad 失败（%s）：%s" % (type(e).__name__, os.path.relpath(path, REPO))
    after = sha256(path)
    if before != after:
        raise AssertionError(
            "depad 改动了内容！%s %s → %s" % (path, before[:16], after[:16]))
    return None


def external_size(path):
    """用**外部** `stat` 取大小 —— 这是唯一能看到填充的视角。

    `os.path.getsize()` 走 Python 自己的逻辑视图（返回真实大小），**看不到填充**，
    所以判据必须开子进程。取不到时返回 `None`（= 未测，不许当成 0）。
    """
    try:
        r = subprocess.run(["stat", "-f", "%z", path],
                           capture_output=True, text=True, timeout=30)
    except Exception:
        return None
    s = r.stdout.strip()
    return int(s) if s.isdigit() else None

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""verify_browser_ext_artifact.py —— L1 里那件 418KB 产物的**配方**：跑一遍，逐字节对回去

## 这个文件为什么存在

结构性诊断 P2 #20 量到：`ADR-0013` §三 把 `dsh-browser-ext/**` 整目录划进 L1，
理由是「会被人改，改了要能回滚」；而其中 `dsh-browser-ext/panel/assets/index.js`
是**压缩产物**，它的源码在 gitignored 的 `.vendor/` 里。于是那份 418KB 的产物进了 L1
（有历史、能 diff 二进制），而「它是怎么从源码构建出来的」这个仓库回答不了 ——
**「回滚」在这里只能回滚到一个没人能重建的黑盒。**

ADR-0013 §三 那条 2026-09-22 补记把两条出路留给了 Owner，`Q39` 是它的执行点。
Owner 裁定 **选项 A：构建配方入库、产物留在 L1**。本文件就是那份配方，以及它的自证。

而选项 A 的 `impact` 里写着一句必须兑现的话：

> 代价是要**先确认那份配方真的跑得通**（`.vendor/` 里的源码 + 一个构建命令
> + 一次 sha256 对得上产物的校验），否则收进来的是一份「看起来像配方」的散文 ——
> 那正是 §2.4 点名的形状。

所以本文件不是一段说明，是**那条命令本身**。

## 配方（两条，无省略 —— 这一节就是入库的「配方」）

```bash
cd .vendor/dsh-browser-main/extensions/dsh-browser
PATH="$PWD/node_modules/.bin:$PATH" node scripts/build.mjs      # ① 重建 → dist/
```

```bash
diff -r .vendor/dsh-browser-main/extensions/dsh-browser/dist dsh-browser-ext   # ② 逐字节对回去
```

配方**只依赖 `.vendor/` 里那份源码**（`dsh-browser-main`，第三方，自带 `node_modules`），
不装任何新依赖、不联网。**实测（2026-09-22）**：配方跑 0.8–1.5 秒，
`diff -r` 退出 **0**，**16 个文件逐个字节相等** —— `dsh-browser-ext/manifest.json` ·
`background.js` · `content.js` · `panel/index.html` · `panel/assets/{index.js,index.css,deepseek-256.png}` ·
`_locales/{en,zh_CN,zh_TW}/messages.json` · `assets/icons/` 七个图标；其中
`dsh-browser-ext/panel/assets/index.js` = **418,664 字节**，`sha256` 前 16 位 `645b9302929c8d43`。

裁决记录在 `ADR/ADR-0013-基座接口冻结与仓库入库分级.md` §三 的那条补记里
（原来只有散文，`Q39` 是给它补的执行点）。

## ★ 为什么不把那个 sha256 写进代码当闸门

因为那会造出**第二处真相**（V30d 的教训：正确的不变量是「只有一处」，不是「两处相等」）。
闸门比的是**构建产物 ↔ L1 里那份**：一边是这一跑现场产出的，一边是版本库里那一份。
写死一个常量只会多出一个需要人工同步的数字，而它红了的时候你还得先判断
「是产物变了还是常量过期了」—— 那正是本仓反复治过的病。

## 断言

  A1 前置条件：配方目录、`node`、`node_modules/.bin/vite` 都在
     —— **缺任何一个 → 未测（退 2）**。`.vendor/` 不在盘上换台机器就是如此，
     L2 的定义就是「可由清单重建」，所以那**不是红，是没测到**
  A2 L1 侧那 16 个文件**都在、且都被 git 跟踪**（「产物在 L1」是本器全部立论的前提；
     不成立就没有「回滚」可言）
  A3 配方退出码必须是 0（构建失败时下面那条比对会**顺便**红，但那是巧合，不是判据）
  A4 **逐文件 sha256 相等，且两侧文件集合相等**（多一个、少一个、内容变一个都红）
  A5 分母：文件数 == `EXPECTED_FILES`（16）—— 两侧同时少一个文件时 A4 会恒真，
     这一条是防那个的。数变了要**显式**改这里的常量
  B1–B7 `--controls`：纯函数喂合成清单，正反两侧 + 两条未测路径都证

## 本器**会**动盘上的什么（§2.4.4：每一个进自证表的命令都要答得出这句）

只写 `.vendor/dsh-browser-main/extensions/dsh-browser/dist/` ——
**那是构建产物目录本身，且整棵 `.vendor/` 被 `.gitignore:35` 忽略**。
仓库里被跟踪的任何文件**一个字节都不动**：L1 侧是纯读。
（`--controls` 完全不碰盘，也不跑构建。）

## 退出码

  0 配方跑通且逐字节相等 ／ 1 有断言红 ／ **2 未测**（配方跑不了：`.vendor/` 或 `node` 不在）
  —— 未测 ≠ 通过 ≠ 红

## 用法

    python3 tools/verify_browser_ext_artifact.py
    python3 tools/verify_browser_ext_artifact.py --controls
    python3 tools/verify_browser_ext_artifact.py --no-build   # 只查 A2/A5（离线、快）
"""
from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

#: 配方所在（**L2**：`.vendor/` 被 `.gitignore:35` 忽略）。它不在盘上 ⇒ 未测。
RECIPE_DIR = REPO / ".vendor" / "dsh-browser-main" / "extensions" / "dsh-browser"
#: 产物所在（**L1**：整目录入历史 —— 这正是本器存在的前提）。
L1_DIR = REPO / "dsh-browser-ext"
#: 配方名（`package.json` 的 `build` 脚本就是它）。
BUILD_SCRIPT = "scripts/build.mjs"

#: 2026-09-22 实测读数（`find dsh-browser-ext -type f | wc -l`）。
#: ★ 这是**某时某刻的读数，不是常量** —— 扩展真加了文件就改这里，并在本节写明新读数。
#: 它拦的是「两侧同时少了一个文件」：那种情况下 A4 会恒真，而 A5 不会。
EXPECTED_FILES = 16

#: 构建超时（**Python 的 subprocess 超时**，不是 shell 的 `timeout` —— 
#: 后者在 macOS 上根本不存在，见 `AGENTS.md` §2.2 第 5 条）。
BUILD_TIMEOUT_S = 300


def sha256_of(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def scan(root: Path) -> dict:
    """目录 → {相对路径: sha256}。**二进制也照收**（.png/.ico 就在里面）。"""
    out = {}
    for p in sorted(root.rglob("*")):
        if p.is_file() and not p.is_symlink():
            out[str(p.relative_to(root))] = sha256_of(p)
    return out


# ── 纯函数：判据（`--controls` 直接喂内存样本，不碰盘） ──────────────────────

def compare(l1: dict, built: dict, expected_files: int = EXPECTED_FILES) -> dict:
    """两份「相对路径 → sha256」的清单逐条比。返回 problems / rows / n。

    A4 与 A5 都在这里 —— 抽成纯函数是为了 `--controls` 能在内存里做反向对照
    （`AGENTS.md` §2.1：反向对照只在内存里做）。
    """
    problems, rows = [], []
    only_l1 = sorted(set(l1) - set(built))
    only_built = sorted(set(built) - set(l1))
    changed = sorted(k for k in set(l1) & set(built) if l1[k] != built[k])

    for k in only_l1:
        problems.append(f"A4 L1 有、配方产物里没有：{k} —— 这一份**重建不出来**")
    for k in only_built:
        problems.append(f"A4 配方产物里有、L1 没有：{k} —— L1 里少了一份应入库的产物")
    for k in changed:
        problems.append(f"A4 内容不同：{k}\n         L1   {l1[k][:16]}…\n"
                        f"         配方 {built[k][:16]}…")

    for k in sorted(set(l1) & set(built)):
        rows.append({"path": k, "same": l1[k] == built[k], "sha": l1[k]})

    if len(l1) != len(built):
        problems.append(f"A4 文件数不同：L1 {len(l1)} 个 · 配方 {len(built)} 个")
    if not l1 or not built:
        # 分母为 0 的比对恒真 —— 那是「看着像读过」的假精度，必须自己塌掉。
        problems.append(f"A5 分母为空：L1 {len(l1)} 个 · 配方 {len(built)} 个 —— "
                        f"空集比空集永远相等，这条读数不算数")
    elif len(l1) != expected_files:
        problems.append(f"A5 文件数 {len(l1)} != 钉住的 {expected_files} —— "
                        f"若扩展真的增删了文件，改 `EXPECTED_FILES` 并在注释里写清新读数；"
                        f"若不是，那就是有产物被悄悄删了（两侧同删时 A4 抓不到）")
    return {"problems": problems, "rows": rows, "n": len(l1)}


def preconditions(recipe_dir: Path, node_bin: str | None) -> list:
    """未测的两条来路。**返回非空 ⇒ 退 2**（不是红，也不是绿）。"""
    miss = []
    if not recipe_dir.is_dir():
        miss.append(f"配方目录不在盘上：{recipe_dir}（`.vendor/` 被 `.gitignore:35` 忽略 —— "
                    f"换台机器就是这样，**L2 的定义如此**）")
        return miss
    if not (recipe_dir / BUILD_SCRIPT).is_file():
        miss.append(f"配方脚本不在：{recipe_dir / BUILD_SCRIPT}")
    if not (recipe_dir / "node_modules" / ".bin" / "vite").exists():
        miss.append(f"配方缺 `node_modules/.bin/vite`（构建器不在，跑不了配方）")
    if not node_bin:
        miss.append("`node` 不在 PATH 上")
    return miss


# ── 反向对照 ─────────────────────────────────────────────────────────────────

def controls() -> int:
    GOOD = {"manifest.json": "a" * 64, "background.js": "b" * 64, "content.js": "c" * 64}
    N = len(GOOD)

    def red(l1, built, n=N):
        return bool(compare(l1, built, n)["problems"])

    def msg(l1, built, n=N):
        return "\n".join(compare(l1, built, n)["problems"])

    cases = [
        ("正样本：两侧完全相同 → 必须绿", lambda: not red(GOOD, dict(GOOD))),
        ("★ 坏样本：内容改一个字节 → 必须红，且点名是哪个文件",
         lambda: red(GOOD, {**GOOD, "background.js": "b" * 63 + "X"})
         and "background.js" in msg(GOOD, {**GOOD, "background.js": "b" * 63 + "X"})),
        ("坏样本：配方产物少一个文件 → 必须红",
         lambda: red(GOOD, {k: v for k, v in GOOD.items() if k != "content.js"})),
        ("坏样本：配方产物多一个文件 → 必须红",
         lambda: red(GOOD, {**GOOD, "extra.js": "d" * 64})),
        ("★ 坏样本：两侧**同时**少一个文件 → A4 会恒真，A5（分母）必须把它抓住",
         lambda: red({k: v for k, v in GOOD.items() if k != "content.js"},
                     {k: v for k, v in GOOD.items() if k != "content.js"})),
        ("坏样本：两侧都是空集 → 必须红（空集比空集永远相等，那是假精度）",
         lambda: red({}, {})),
        ("反向对照：上面那些不是恒红 —— 把改动还原回去必须重新变绿",
         lambda: not red(GOOD, dict(GOOD))),
        ("★ 未测路径①：配方目录不存在 → `preconditions` 必须报，且退 2 不是退 1",
         lambda: bool(preconditions(Path("/nonexistent/.vendor/ext"), "/usr/bin/node"))),
        ("★ 未测路径②：`node` 不在 PATH → 必须报未测（不是「跑完了、没问题」）",
         lambda: bool(preconditions(RECIPE_DIR, None))),
        ("反向对照：本机现场的前置条件**现在应当齐备**（上面两条不是恒真）",
         lambda: not preconditions(RECIPE_DIR, shutil.which("node"))),
    ]
    bad = 0
    print("=" * 72)
    print("418KB 产物的配方 · 反向对照（离线；不跑构建、不碰盘）")
    print("=" * 72)
    for i, (name, fn) in enumerate(cases, 1):
        try:
            ok, err = bool(fn()), ""
        except Exception as e:  # noqa: BLE001
            ok, err = False, f"（抛异常 {type(e).__name__}: {e}）"
        if not ok:
            bad += 1
        print(f"  {'✅' if ok else '❌'} [{i}/{len(cases)}] {name}{err}")
    print("-" * 72)
    if bad:
        print(f"❌ {len(cases)} 项中 {bad} 项失败 —— 判据有问题，别信它")
        return 1
    print(f"✅ {len(cases)} 项全过（含「该红时红」「该绿时绿」「未测 ≠ 红」三侧）")
    return 0


# ── 构建 ─────────────────────────────────────────────────────────────────────

def build() -> tuple:
    """跑配方。返回 (ok, log)。**只写 `.vendor/.../dist/`**（L2 构建产物目录）。"""
    env = dict(os.environ)
    env["PATH"] = str(RECIPE_DIR / "node_modules" / ".bin") + os.pathsep + env.get("PATH", "")
    try:
        r = subprocess.run(["node", BUILD_SCRIPT], cwd=str(RECIPE_DIR), env=env,
                           capture_output=True, text=True, timeout=BUILD_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        return False, f"配方超时（>{BUILD_TIMEOUT_S}s）—— 这不是红，是没跑完"
    return r.returncode == 0, (r.stdout or "") + (r.stderr or "")


def main(argv: list) -> int:
    if "--controls" in argv:
        return controls()

    no_build = "--no-build" in argv
    print("=" * 72)
    print("L1 里那件 418KB 产物：配方跑一遍，逐字节对回去（Q39 选项 A）")
    print("=" * 72)

    # ── A2 · L1 侧：存在 + 被跟踪 ────────────────────────────────────────
    if not L1_DIR.is_dir():
        print(f"❌ A2 L1 目录不存在：{L1_DIR} —— 产物根本没入库，本器的立论不成立")
        return 1
    l1 = scan(L1_DIR)
    try:
        tracked = set(subprocess.run(["git", "ls-files", "-z", "dsh-browser-ext"],
                                     cwd=str(REPO), capture_output=True, timeout=60)
                      .stdout.decode("utf-8", "replace").split("\0")) - {""}
    except Exception:  # noqa: BLE001
        tracked = None
    if tracked is None:
        print("⚠️ 未测：git 取不到已跟踪集合 —— 无法回答「产物在不在 L1」，退 2")
        return 2
    untracked = sorted(k for k in l1 if f"dsh-browser-ext/{k}" not in tracked)
    if untracked:
        print(f"❌ A2 有 {len(untracked)} 个文件**没被 git 跟踪**（换台机器就没了）：")
        for k in untracked[:5]:
            print(f"     {k}")
        print("   「回滚」的前提是它在 L1 —— 这一条不成立，后面几条就没有意义")
        return 1
    print(f"✅ A2 L1 侧 {len(l1)} 个文件都在且都被跟踪"
          f"（其中 panel/assets/index.js = {os.path.getsize(L1_DIR / 'panel/assets/index.js')} 字节）")

    # ── A1 · 前置条件：缺任何一个都是**未测** ────────────────────────────
    miss = preconditions(RECIPE_DIR, shutil.which("node"))
    if miss:
        print("⚠️ 未测（退 2，**不是红也不是绿**）—— 配方跑不了：")
        for m in miss:
            print(f"     · {m}")
        print("   ★ 这一档的含义：**没测到**，不是「产物是好的」。")
        print("     L2 的定义就是「可由清单重建」，所以配方不在盘上是这个分级的正常状态，")
        print("     而它在这里的后果是：**「可重建」这句话在本机此刻无法兑现**。")
        return 2
    print(f"✅ A1 配方齐备：{RECIPE_DIR.relative_to(REPO)}"
          f"（node = {shutil.which('node')}）")

    if no_build:
        print("\n（--no-build：跳过 A3/A4/A5，只报 A1/A2。**这不是通过** —— 别把它读成绿。）")
        return 0

    # ── A3 · 跑配方 ─────────────────────────────────────────────────────
    print("\n── 跑配方 ──")
    print(f"   cd {RECIPE_DIR.relative_to(REPO)} && node {BUILD_SCRIPT}")
    ok, log = build()
    tail = [ln for ln in log.splitlines() if ln.strip()][-3:]
    for ln in tail:
        print(f"   │ {ln[:120]}")
    if not ok:
        print("❌ A3 配方退出非 0 —— 构建没跑通，下面的比对不算数")
        return 1
    print("✅ A3 配方退出 0（构建产物在 .vendor/…/dist/，L2；仓库里被跟踪的东西一个字节没动）")

    # ── A4/A5 · 逐字节对回去 ────────────────────────────────────────────
    built = scan(RECIPE_DIR / "dist")
    r = compare(l1, built)
    print(f"\n── 逐文件 sha256（{r['n']} 个）──")
    for row in r["rows"]:
        print(f"   {'✅' if row['same'] else '❌'} {row['sha'][:16]}…  {row['path']}")
    print()
    if r["problems"]:
        print(f"❌ 有 {len(r['problems'])} 处不一致 —— 配方跑出来的东西 != L1 里那份：")
        for p in r["problems"]:
            print(f"     {p}")
        return 1
    h = built.get("panel/assets/index.js", "")[:16]
    print(f"✅ A4 {r['n']} 个文件逐字节相等 · A5 分母 {r['n']} == 钉住的 {EXPECTED_FILES}")
    print(f"   ★ 于是「回滚」不再指向一个黑盒：`panel/assets/index.js`（418,664 字节 · "
          f"sha256 {h}…）可以由上面那两条命令重建并**核对**。")
    print("   ★ 本器**不**把那个 sha256 写死 —— 闸门比的是「配方产出的 ↔ L1 里那份」，")
    print("     写死常量只会多出第二处真相（V30d：正确的不变量是「只有一处」）。")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

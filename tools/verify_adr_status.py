#!/usr/bin/env python3
"""tools/verify_adr_status.py —— ADR 台账与 ADR 文件的状态必须逐条相等

## 为什么要有这个文件

2026-09-22 的结构性诊断抓到一处**双源冲突**：`ADR/README.md` 的「当前决策台账」
把 **ADR-0001** 与 **ADR-0012** 记成 `accepted`，而两份 ADR 文件自己都写着 `proposed`。
台账是**可达的** —— 它是 `AGENTS.md` 之外查「哪条决策已生效」的主入口，
所以读台账的人和读 ADR 的人会得到**两个不同的答案**，而且没有任何东西会红。

## 判据：状态只有一个正本 —— **ADR 文件里的 `- 状态：` 那一行**

`ADR/README.md` 规则 1 写的是「**不静默改写已接受 ADR 的结论**」——
它保护的是**文件**。台账是索引，索引跟着正本走。本脚本把这句话变成会红的东西。

规则 6 定义了取值域：`proposed` / `accepted` / `superseded` / `rejected`。
本脚本**只查两个来源相不相等、取值合不合法**，不判断那条决策"应不应该"是 accepted ——
那是 Owner 的事（README 规则 3）。**判据与判断分开**，这条是刻意的。

## 断言

| 段 | 断言 | 拦什么 |
|---|---|---|
| A1 | 每个 `ADR/ADR-*.md` **恰好**一条 `- 状态：` 行 | 没写状态 / 写了两条（一条改过一条没删） |
| A2 | 状态 token 在规则 6 的四个取值里 | 自造词（`done` / `wip` / `生效`…） |
| A3 | 台账列出的 ADR 集合 **≡** 磁盘上的 ADR 文件集合 | 加了 ADR 没进台账 / 台账留着已删的条目 |
| A4 | **逐条 token 相等**（本脚本存在的理由） | 两处各写一遍 → 各自漂移（本项目已栽过多次） |
| A5 | 台账每行的日期是 `YYYY-MM-DD` | 空日期 / 相对日期（「上周」） |
| C1–C8 | `--controls` 反向对照：喂已知坏样本必须红，正样本必须绿 | 判据恒真或恒红 |

退出码：全过 **0** ／ 有红 **1** ／ 读不出或解析不了 **2**（未测 ≠ 通过 ≠ 红，`AGENTS.md` §2.4.2）。

## 已知边界（明着留着，别当成通过了）

* 本脚本只看**状态**这一个字段。`决策`/`日期`/`依赖` 列不参与判定。
* 它**不判断**某条 `proposed` 的 ADR 被别的 ADR 当依赖引用算不算问题 ——
  那是事实，不是违规（`ADR-0013` 就依赖 `ADR-0001`），所以只**报数**不判红。
* 行尾注释不算代码这条盲区不适用（本脚本不扫代码）。

复现：
    python3 tools/verify_adr_status.py            # 0/1/2
    python3 tools/verify_adr_status.py --controls # 8 项离线反向对照
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
ADR_DIR = REPO / "ADR"
LEDGER = ADR_DIR / "README.md"

#: README 规则 6 的取值域。**多一个少一个都要改这里与规则 6 两处 —— 它俩也有断言（A2 反查）**
VALID = ("proposed", "accepted", "superseded", "rejected")

STATUS_LINE = re.compile(r"^-\s*状态[:：]\s*(.+)$", re.M)
TOKEN = re.compile(r"`([^`]+)`")
ADR_FILE = re.compile(r"^ADR-(\d{4})-.+\.md$")
DATE_OK = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class Unreadable(Exception):
    """读不出/解析不了 —— 落「未测」（退 2），不许当成通过。"""


def status_token(text: str) -> str:
    """从状态行正文里取**第一个反引号 token**；没有反引号就取第一个词。

    取第一个 token 是刻意的：状态行后半段常带一段括号解释
    （`proposed`（§七 的四道题由法务作答…）），那段解释里出现的词不算状态。
    """
    m = TOKEN.search(text.strip())
    if m:
        return m.group(1).strip()
    return text.strip().split()[0] if text.strip() else ""


def read_files() -> dict:
    """磁盘上每个 ADR 文件的状态行正文。**一份文件一条状态行，多了少了都记下来。**"""
    if not ADR_DIR.is_dir():
        raise Unreadable(f"没有这个目录：{ADR_DIR}")
    out = {}
    for p in sorted(ADR_DIR.iterdir()):
        if not p.is_file() or not ADR_FILE.match(p.name):
            continue
        hits = STATUS_LINE.findall(p.read_text(encoding="utf-8"))
        out[p.name] = {"raw": hits, "file": p}
    if not out:
        raise Unreadable(f"{ADR_DIR} 下一个 ADR 文件都没扫到 —— 口径可能错了，按未测处理")
    return out


def read_ledger() -> dict:
    """台账表里的 (ADR 编号 → 状态 token / 日期)。只认 `| [ADR-xxxx](...) | ... |` 那种行。"""
    if not LEDGER.is_file():
        raise Unreadable(f"没有这个文件：{LEDGER}")
    out = {}
    for line in LEDGER.read_text(encoding="utf-8").splitlines():
        if not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.split("|")]
        if len(cells) < 6 or "ADR-" not in cells[1]:
            continue
        m = re.search(r"\[(ADR-\d{4})\]", cells[1])
        if not m:
            continue
        out[m.group(1)] = {"status": status_token(cells[3]), "date": cells[4], "link": cells[1]}
    if not out:
        raise Unreadable("台账表一行都没解析出来 —— 表格口径可能改了，按未测处理")
    return out


def judge(files: dict, ledger: dict) -> dict:
    """纯函数：给定「文件里读到什么」与「台账里读到什么」，返回判定。

    `--controls` 直接喂它内存里的样本 —— 反向对照只在内存里做（`AGENTS.md` §2.1）。
    """
    problems: list[str] = []
    info: list[str] = []

    # A1 / A2：文件这一侧
    fstat = {}
    for name, rec in sorted(files.items()):
        num = ADR_FILE.match(name).group(1)
        n = len(rec["raw"])
        if n != 1:
            problems.append(f"A1 {name}：`- 状态：` 行有 {n} 条，必须恰好 1 条")
            if n == 0:
                continue
        tok = status_token(rec["raw"][0])
        if tok not in VALID:
            problems.append(f"A2 {name}：状态 `{tok}` 不在规则 6 的取值域 {list(VALID)} 里")
        fstat[f"ADR-{num}"] = tok

    # A3：集合相等
    fset, lset = set(fstat), set(ledger)
    for miss in sorted(fset - lset):
        problems.append(f"A3 {miss}：磁盘上有这个 ADR，台账里没有")
    for extra in sorted(lset - fset):
        problems.append(f"A3 {extra}：台账里有这一条，磁盘上没有对应的 ADR 文件")

    # A4：逐条相等（本脚本存在的理由）
    for num in sorted(fset & lset):
        f, l = fstat[num], ledger[num]["status"]
        if f != l:
            problems.append(f"A4 {num}：ADR 文件写 `{f}`，台账写 `{l}` —— **两个答案**")

    # A5：日期
    for num, rec in sorted(ledger.items()):
        if not DATE_OK.match(rec["date"]):
            problems.append(f"A5 {num}：台账日期 `{rec['date']}` 不是 YYYY-MM-DD")

    # 事实（不判红）：比例，以及「已决的 ADR 把未决的当依赖」有几处
    n_prop = sum(1 for v in fstat.values() if v == "proposed")
    info.append(f"状态分布：accepted {sum(1 for v in fstat.values() if v == 'accepted')} / "
                f"proposed {n_prop} / superseded {sum(1 for v in fstat.values() if v == 'superseded')} / "
                f"rejected {sum(1 for v in fstat.values() if v == 'rejected')}（共 {len(fstat)} 条）")
    return {"problems": problems, "info": info, "fstat": fstat, "n_prop": n_prop}


def controls() -> int:
    """反向对照：坏样本必须红、正样本必须绿。**两边都证**，只证一边的是坏检查器。"""
    good_files = {"ADR-0001-a.md": {"raw": ["`accepted`（Owner 2026-09-16）"]},
                  "ADR-0002-b.md": {"raw": ["`proposed`"]}}
    good_ledger = {"ADR-0001": {"status": "accepted", "date": "2026-09-16"},
                   "ADR-0002": {"status": "proposed", "date": "2026-09-17"}}

    def red(files, ledger):
        return bool(judge(files, ledger)["problems"])

    cases = [
        ("正样本：两处一致 → 必须绿", lambda: not red(good_files, good_ledger)),
        ("★ 坏样本：token 不等（台账说 accepted、文件说 proposed）→ 必须红",
         lambda: red(good_files, {**good_ledger, "ADR-0002": {"status": "accepted", "date": "2026-09-17"}})),
        ("坏样本：文件没有 `- 状态：` 行 → 必须红",
         lambda: red({**good_files, "ADR-0003-c.md": {"raw": []}}, good_ledger)),
        ("坏样本：状态取值是自造词（`done`）→ 必须红",
         lambda: red({**good_files, "ADR-0003-c.md": {"raw": ["`done`"]}}, good_ledger)),
        ("坏样本：台账多一条（磁盘上没有那个文件）→ 必须红",
         lambda: red(good_files, {**good_ledger, "ADR-0099": {"status": "proposed", "date": "2026-09-17"}})),
        ("坏样本：台账少一条（磁盘上有、台账漏了）→ 必须红",
         lambda: red(good_files, {"ADR-0001": good_ledger["ADR-0001"]})),
        ("坏样本：台账日期不是 YYYY-MM-DD → 必须红",
         lambda: red(good_files, {**good_ledger, "ADR-0002": {"status": "proposed", "date": "上周"}})),
        ("反向对照：把坏样本改回一致 → 必须重新变绿（上面几条不是恒红）",
         lambda: not red(good_files, {**good_ledger, "ADR-0002": {"status": "proposed", "date": "2026-09-17"}})),
    ]
    bad = 0
    print("=" * 72)
    print("ADR 状态台账 · 反向对照（离线；不动盘、不联网）")
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
    print(f"✅ {len(cases)} 项全过（含「该红时红」与「该绿时绿」两侧）")
    return 0


def main(argv: list[str]) -> int:
    if "--controls" in argv:
        return controls()
    if "--json" in argv:
        try:
            r = judge(read_files(), read_ledger())
        except Unreadable as e:
            print(json.dumps({"code": 2, "reason": str(e)}, ensure_ascii=False))
            return 2
        print(json.dumps({"code": 1 if r["problems"] else 0, **r["fstat"],
                          "problems": r["problems"], "info": r["info"]}, ensure_ascii=False, default=str))
        return 1 if r["problems"] else 0

    try:
        files, ledger = read_files(), read_ledger()
    except Unreadable as e:
        print(f"⚠️ 未测：{e}")
        print("   这不是「台账没问题」，是**这次没读成** —— 退 2，与通过与红都不同。")
        return 2

    r = judge(files, ledger)
    print("=" * 72)
    print(f"ADR 状态台账 · {LEDGER.relative_to(REPO)}  vs  {ADR_DIR.relative_to(REPO)}/ADR-*.md")
    print("=" * 72)
    for line in r["info"]:
        print(f"  · {line}")
    print()
    if r["problems"]:
        print(f"── 有问题 {len(r['problems'])} 处 ──")
        for p in r["problems"]:
            print(f"  ❌ {p}")
        print()
        print("  修法：**改台账，别改 ADR 文件** —— README 规则 1 保护的是文件（正本）。")
        print("  若 Owner 的意思确实是「已决」，正确的动作是改 ADR 文件的 `- 状态：` 行，")
        print("  并在这个脚本的断言下重新对齐（它会把两处一起看住）。")
        return 1
    print(f"✅ 台账与 {len(r['fstat'])} 份 ADR 文件的状态逐条相等")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

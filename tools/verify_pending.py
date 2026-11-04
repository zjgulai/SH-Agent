#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
verify_pending.py —— 「待收清单」的判据（`PMO/待收清单-v1.json`）

## 为什么有这个东西

2026-09-21 我在汇报里说过一句「**她那边两件仍然欠着**」。对账之后：

| 我说的 | 盘上实际是什么 |
|---|---|
| 她欠「对接人统一入口」 | 她原话是**条件句**（「如果需要明确」）且只说「我计划」 |
| 她欠「三条线上两版都没有的内容」 | 她**从未提过**这三条；那是我方的问题 |

「欠」这个字把**我方要问的问题**和**对方说会给的东西**并成了一种东西 ——
这违反本项目那句自检：**「这句话比我的输入大吗？」**（`AGENTS.md` §2.4.1）。

所以这张清单不是台账，是**防止这句话再被说大的判据**：

* **C2**：性质不是「我方待问」的条目，**必须指得出上游原话**（message / file / outbound 指针）。
* **C3**：性质是「我方待问」的条目，**不许有任何一条指针被标成上游原话**。
      —— 这两条合起来，正好拦住本轮那句话的形状。

## 第二个作用：到期

`PRD/PRD差异对照-20260921.md` §五 记着上游 09-18 的承诺「其它已跟业务沟通接下来两周
陆续整理提供」（→ 2026-10-02），而同一行下面**它自己写着「到期没人会提醒」**。
本文件与 `tools/agent/prd_baseline.mjs` 的 `checkPending` 就是那个提醒。

## 退出码（口径同 `AGENTS.md` §2.4.2：未测必须与通过与红都长得不一样）

| 码 | 含义 |
|---|---|
| **0** | 结构全过，且**没有**到期未收 |
| **1** | 红：结构违规，**或**有到期未收 |
| **2** | **未测** —— 清单读不出/不是合法 JSON。**不许**当成绿 |

## 用法

```bash
python3 tools/verify_pending.py                 # 人读报告
python3 tools/verify_pending.py --json          # 机器读（给 prd_baseline.mjs 的触发者用）
python3 tools/verify_pending.py --today=2026-10-03   # 注入「今天」，用于到期判据的复现
python3 tools/verify_pending.py --controls      # 离线反向对照：判据两边都要会响
```
"""
from __future__ import annotations

import json
import os
import re
import shutil
import sys
import tempfile
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
LIST_PATH = REPO / "PMO" / "待收清单-v1.json"
EVENT_LOG = REPO / "PMO" / "logs" / "ws_events.jsonl"
# 外发台账：我们自己发出去的消息落在这里（判据与写入在 tools/agent/outbound.mjs）。
# 与 EVENT_LOG 是一对 —— 一个是「听进来的」，一个是「说出去的」，宁可都缺，不可只有一个。
OUTBOUND_LOG = REPO / "PMO" / "logs" / "ws_outbound.jsonl"

BJ = timezone(timedelta(hours=8))

ALLOWED_性质 = {"承诺", "条件承诺", "我方待问"}
ALLOWED_状态 = {"open", "partial", "done", "dropped"}
ALLOWED_角色 = {"上游原话", "我方提问", "本地旧件", "无"}
ALLOWED_到期日来源 = {"原话明示", "我方推算"}
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# 承诺类必须指得出上游原话；这两组互为反面
承诺类 = {"承诺", "条件承诺"}


def bj_today() -> date:
    return datetime.now(BJ).date()


def _squash(s: str) -> str:
    """去掉全部空白再比 —— 中文文本里空格是排版，不是内容。"""
    return re.sub(r"\s+", "", str(s or ""))


def load_list(path: Path = LIST_PATH):
    """读清单。**读不出就是未测（退 2），不是红** —— 「我没读到」≠「清单有问题」。"""
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None, f"清单不存在：{path}"
    except OSError as e:
        return None, f"清单读不出：{e}"
    try:
        d = json.loads(raw)
    except json.JSONDecodeError as e:
        return None, f"清单不是合法 JSON：{e}"
    if not isinstance(d, dict) or not isinstance(d.get("items"), list):
        return None, "清单结构不对：顶层必须是含 items 数组的对象"
    return d, None


# ─────────────────────────── 指针（出处）可核 ───────────────────────────

def message_text(message_id: str):
    """从**入站**事件落盘里取一条群消息的正文。取不到回 None。"""
    try:
        with EVENT_LOG.open(encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or message_id not in line:
                    continue
                try:
                    d = json.loads(line)
                except json.JSONDecodeError:
                    continue
                m = (d.get("data") or {}).get("message") or {}
                if m.get("message_id") != message_id:
                    continue
                c = m.get("content") or ""
                try:
                    return json.loads(c).get("text", c)
                except (json.JSONDecodeError, AttributeError):
                    return c
    except OSError:
        return None
    return None


def outbound_text(message_id: str):
    """从**外发台账**（`PMO/logs/ws_outbound.jsonl`）取一条**我们自己发出去**的消息正文。

    ★ 为什么需要第三种指针（2026-09-22 加）：`kind:message` 查的是**入站**事件日志，
    我们自己发出去的消息**永远不会出现在里面**（实测 0 命中）。于是「我方问过什么」
    在盘上一直没有可判据的落点 —— 2026-09-22 14:39 那次误答的直接成因之一就是这个：
    她答的那句话是我方 14:37 手发的，**盘上零痕迹**。
    台账（`tools/agent/outbound.mjs`）补上了那一半，这个函数就是它的读取口。

    取不到回 `None`（**不是空串**）；记录在但正文是空的，回 `""` —— 后者会让 quote 校验失败，
    这正是我们要的：**一条空记录不该能满足任何指针**。
    """
    try:
        with OUTBOUND_LOG.open(encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or message_id not in line:
                    continue
                try:
                    d = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if message_id in (d.get("message_ids") or []):
                    return d.get("text") or ""
    except OSError:
        return None
    return None


def outbound_sent_at(message_id: str):
    """外发台账里那条消息的**时刻**（ISO 串）。取不到回 `None`（未测，不猜）。

    与 `outbound_text` 同源同解析，只是取 `at` 而不是 `text` —— F 段（该不该补问）要的
    正是这个时刻，而它**只能来自台账**：清单里没有、也不该有「问于何时」这个字段。
    写进去就成了第二个事实源，台账一改、清单不跟，两处早晚漂移（§2.4.1 那个形状）。
    """
    try:
        with OUTBOUND_LOG.open(encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or message_id not in line:
                    continue
                try:
                    d = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if message_id in (d.get("message_ids") or []):
                    return d.get("at") or None
    except OSError:
        return None
    return None


# ────────── F 段：「问出去两个工作日了还没回」—— 该补问一次 ──────────

# 「满 N 个工作日」。**只跳周六日** —— 本仓没有节假日表，也不打算编一张：
# 编了就得有人维护，而维护不动的假日历会把「该问」推迟成「忘了问」。
# 早一天问，代价是一句话；晚一周问，代价是那件事一直悬着。
NAG_WORKDAYS = 2


def working_days_between(d0: date, d1: date) -> int:
    """`d0` **之后**到 `d1`（含）之间有几个工作日。`d1 <= d0` 回 0。纯函数。"""
    if d1 <= d0:
        return 0
    n, d = 0, d0
    while d < d1:
        d += timedelta(days=1)
        if d.weekday() < 5:
            n += 1
    return n


def ask_nags(items: list, today: date, at_of=None) -> list:
    """该「补问一次」的条目。三件**同时**成立才进：

      ① `状态` 还开着（open / partial）—— 关掉的、作废的不追；
      ② `outbound` 指针**恰好一条** —— **0 条 = 还没问过**（那是 D 段的事，红在自证里）；
         **≥2 条 = 已经问过不止一次**，不再自动补。
         ★ 这一条让「每条只补一次」**结构上**成立：靠数清单里的指针，不靠某个状态变量
           记着自己说过没有 —— 状态变量会被抹（§2.4.3 那个 `p_*` 被覆盖的真事故），
           而指针在清单里、进 git。
      ③ 那一条已经过了 ≥`NAG_WORKDAYS` 个工作日。

    取不到时刻（台账读不出 / 那条不在台账里）→ **不进**。**没测到 ≠ 该问。**
    """
    if at_of is None:
        return []
    out = []
    for it in items:
        if not isinstance(it, dict):
            continue
        if it.get("状态") not in {"open", "partial"}:
            continue
        outs = [p for p in (it.get("出处") or [])
                if isinstance(p, dict) and p.get("kind") == "outbound"]
        if len(outs) != 1:
            continue
        at = at_of(outs[0].get("message_id"))
        if not at:
            continue
        try:
            d = datetime.fromisoformat(str(at).replace("Z", "+00:00")).astimezone(BJ).date()
        except ValueError:
            continue
        n = working_days_between(d, today)
        if n >= NAG_WORKDAYS:
            out.append({"id": it.get("id"), "事项": it.get("事项"), "问于": str(d),
                        "工作日": n, "问题": outs[0].get("quote") or ""})
    return out


def check_pointer(p: dict) -> str | None:
    """核一条指针。回 None = 通过，回字符串 = 错误说明。**每条都必须能指回盘上的东西。**"""
    if not isinstance(p, dict):
        return "指针不是对象"
    kind = p.get("kind")
    role = p.get("角色")
    if role not in ALLOWED_角色:
        return f"角色非法：{role!r}（只许 {sorted(ALLOWED_角色)}）"

    if kind == "message":
        mid, quote = p.get("message_id"), p.get("quote")
        if not mid or not quote:
            return "message 指针缺 message_id 或 quote"
        text = message_text(mid)
        if text is None:
            return f"消息 {mid} 在 {EVENT_LOG.name} 里查不到"
        if _squash(quote) not in _squash(text):
            return f"quote 不是 {mid} 的逐字内容：{quote[:24]}…"
        return None

    if kind == "file":
        rel, quote = p.get("path"), p.get("quote")
        if not rel or not quote:
            return "file 指针缺 path 或 quote"
        fp = REPO / rel
        if not fp.exists():
            return f"文件不存在：{rel}"
        try:
            body = fp.read_text(encoding="utf-8", errors="replace")
        except OSError as e:
            return f"文件读不出：{rel}（{e}）"
        if _squash(quote) not in _squash(body):
            return f"quote 不在 {rel} 里：{quote[:24]}…"
        return None

    if kind == "outbound":
        # ★ 2026-09-22 加的第三种指针：**我方发出去的消息**。
        #   与 kind:message 的差别只有一处 —— 查的是外发台账，不是入站事件日志。
        #   为什么必须单开一种而不是指台账文件：`kind:file` 只证明「这串字出现在那个文件里」，
        #   **不证明它属于那一条 message_id** —— 台账里有很多条消息，
        #   一个文件指针没法把 quote 绑到具体哪一条上。
        mid, quote = p.get("message_id"), p.get("quote")
        if not mid or not quote:
            return "outbound 指针缺 message_id 或 quote"
        text = outbound_text(mid)
        if text is None:
            # 分辨办法必须写在报错里，否则下一个人只会反复试
            return (f"外发 {mid} 在 {OUTBOUND_LOG.name} 里查不到 —— 若它确实发过，"
                    f"用 `node tools/outbound_ledger.mjs --backfill {mid}` 补记（只读飞书）")
        if not _squash(text):
            return f"外发 {mid} 的记录**正文是空的** —— 一条空记录不该能满足任何指针"
        if _squash(quote) not in _squash(text):
            return f"quote 不是外发 {mid} 的逐字内容：{quote[:24]}…"
        return None

    if kind == "none":
        if not str(p.get("why") or "").strip():
            return "none 指针必须写 why（为什么这条没有可核出处）"
        return None

    return f"指针 kind 非法：{kind!r}"


# ─────────────────────────── 单条判据 ───────────────────────────

def validate_item(it: dict, ptr_check=check_pointer) -> list[str]:
    """一条的全部结构判据。回错误列表（空 = 通过）。纯函数，可喂假样本。"""
    errs: list[str] = []
    i = it.get("id") or "(无 id)"
    for k in ("id", "事项", "性质", "谁说的", "出处", "状态", "怎么核"):
        if k not in it:
            errs.append(f"{i}: 缺字段 {k}")

    if it.get("性质") not in ALLOWED_性质:
        errs.append(f"{i}: 性质非法 {it.get('性质')!r}")
    if it.get("状态") not in ALLOWED_状态:
        errs.append(f"{i}: 状态非法 {it.get('状态')!r}")

    ptrs = it.get("出处")
    if not isinstance(ptrs, list) or not ptrs:
        errs.append(f"{i}: 出处必须是非空数组")
        ptrs = []
    for p in ptrs:
        e = ptr_check(p)
        if e:
            errs.append(f"{i}: {e}")

    roles = {p.get("角色") for p in ptrs if isinstance(p, dict)}

    # ★ C2 / C3 —— 这一对就是「她欠着」那句话的判据
    if it.get("性质") in 承诺类:
        if "上游原话" not in roles:
            errs.append(f"{i}: 性质是「{it.get('性质')}」，却没有任何一条「上游原话」指针 "
                        f"—— 承诺必须指得出原话")
    elif it.get("性质") == "我方待问":
        bad = [p for p in ptrs if isinstance(p, dict) and p.get("角色") == "上游原话"]
        if bad:
            errs.append(f"{i}: 性质是「我方待问」，却有一条指针被标成「上游原话」"
                        f" —— 不许把我方的问题写成对方的承诺")

    # ★ D —— 「我方待问」**必须真的问出去过**（2026-09-22 加）。
    #   C3 只管「不许把我方的问题写成对方的承诺」，**没有人管「到底问了没有」**：
    #   一条 `性质: 我方待问` 的条目，出处全是 kind:file（或只有一份本地旧件），
    #   照样能永远 open 而全绿 —— 而我方的提问**不会自己飞到群里去**。
    #   实测（加这条之前）：P-02 出处两条全是 kind:file、零 outbound，verify_pending.py 退 0。
    #   所以判据是硬的：它必须在外发台账里指得出一条 message_id。
    if it.get("性质") == "我方待问" and it.get("状态") in {"open", "partial"}:
        if not any(isinstance(p, dict) and p.get("kind") == "outbound" for p in ptrs):
            errs.append(
                f"{i}: 性质是「我方待问」、状态还是「{it.get('状态')}」，却**没有任何 outbound 指针**"
                f" —— 「我问过」这件事在盘上指不出来。发出去之后把 message_id 与逐字 quote"
                f" 记成一条 kind:outbound 指针（判据见 check_pointer 的 outbound 那一段）")

    # ★ 到期日：要么有日子，要么明说为什么没有 —— 不许两样都没有
    due = it.get("到期日")
    if due is None:
        if not str(it.get("无到期日原因") or "").strip():
            errs.append(f"{i}: 到期日为 null 却没写「无到期日原因」—— 悬着的项必须说清为什么悬着")
    else:
        if not DATE_RE.match(str(due)):
            errs.append(f"{i}: 到期日格式不对（要 YYYY-MM-DD）：{due!r}")
        if it.get("到期日来源") not in ALLOWED_到期日来源:
            errs.append(f"{i}: 到期日来源非法 {it.get('到期日来源')!r}"
                        f"（必须区分「原话明示」与「我方推算」）")
        if not str(it.get("到期日依据") or "").strip():
            errs.append(f"{i}: 有到期日却没写「到期日依据」—— 日子从哪来的要说得出")

    # ★ 关掉一条也必须带依据，不许手一划就没了
    if it.get("状态") == "done":
        fin = it.get("完成依据")
        if not isinstance(fin, list) or not fin:
            errs.append(f"{i}: 状态是 done 却没有「完成依据」")
        else:
            for p in fin:
                if isinstance(p, dict) and p.get("kind") == "none":
                    errs.append(f"{i}: 完成依据里不许出现 none 指针 —— 关掉一条要有东西可核")
                e = ptr_check(p)
                if e:
                    errs.append(f"{i}: 完成依据 {e}")
    if it.get("状态") == "dropped" and not str(it.get("作废原因") or "").strip():
        errs.append(f"{i}: 状态是 dropped 却没写「作废原因」")

    return errs


def overdue_items(items: list[dict], today: date) -> list[dict]:
    """到期未收的条目。判据三件同时成立：状态未收、有到期日、今天 ≥ 到期日。"""
    out = []
    for it in items:
        if it.get("状态") not in {"open", "partial"}:
            continue
        due = it.get("到期日")
        if not due or not DATE_RE.match(str(due)):
            continue
        d = date.fromisoformat(str(due))
        if today >= d:
            out.append({
                "id": it.get("id"),
                "事项": it.get("事项"),
                "状态": it.get("状态"),
                "到期日": str(due),
                "过期天数": (today - d).days,
                "谁说的": it.get("谁说的"),
                "到期日来源": it.get("到期日来源"),
                "原话": next((p.get("quote") for p in (it.get("出处") or [])
                              if isinstance(p, dict) and p.get("角色") == "上游原话"), None),
                "怎么核": it.get("怎么核"),
            })
    out.sort(key=lambda x: x["到期日"])
    return out


# ───────────────────── E 段：被引用的条目存不存在 ─────────────────────

# 只匹配 `P-` + 两位数字。刻意**不会**命中 `PB-001`（P 与 - 之间隔着 B）与
# `..._PDP-06.jpg`（`P-06` 前面是 `D`，不是词边界）—— 这两条都真的在盘上。
REF_RE = re.compile(r"\bP-\d{2}\b")

# ★★ 命名空间边界：**这个仓库里 `P-` 前缀被两套台账同时占用了。**
#
# 2026-09-22 实测（加这条判据的当天就撞上）：`PMO/守衡-内容推送与被at登记-*.md` 那份台账
# 用的是 `P-10` … `P-34` 当**它自己的行号**（「推送」与「被 @」逐条登记），
# 与待收清单完全是两回事。第一版扫描器没设边界，于是当场报了 22 条**假红**
# （P-10…P-34「被引用但清单里没有」）—— 而那 22 条一条错都没有，错的是判据。
# `AGENTS.md` §2.1.1 那句话在这里第二次应验：**一个会误报的检查器比没有检查器更糟。**
#
# 实测两套的实际占位：本清单这一段（`REF_MIN`…`REF_MAX`，即 01–09）在整个仓库里
# **只**出现在真正引用待收清单的地方（8 个文件，逐个看过），另一个台账从第 10 号起。
# 所以边界就画在这儿 ——
# **画在证据说的地方，不猜。**
#
# 代价是清单最多 9 条。这不是限制，是一个**必须显式做的决定**：
# 要超过 9 条，先给待收清单换一套不撞车的命名空间（例如 `RC-01`），再把引用一起改；
# 那时把这段注释与 `REF_MIN/REF_MAX` 一起删掉。`judge()` 的 E2 会在这件事发生时变红，
# 而不是让你悄悄踩进撞车区间。
REF_MIN, REF_MAX = 1, 9


def in_ns(i) -> bool:
    """这个 id 是否落在**本检查器敢判**的区间内。落在撞车区间的一律不判（不猜）。"""
    m = re.fullmatch(r"P-(\d{2})", str(i or ""))
    return bool(m) and REF_MIN <= int(m.group(1)) <= REF_MAX


# 扫描范围：**只扫会把 P-xx 当条目编号用的那些文本**。
# 为什么不扫 .json / .txt / 数据目录：research/ 下有商品 JSON（`..._PDP-06.jpg` 那种），
# 把整棵数据树拉进来只会更慢、更容易误报，而它要防的错误不在那里。
SCAN_EXTS = (".md", ".py", ".mjs", ".sh")
SCAN_SKIP = {"node_modules", ".git", ".vendor", "skills", "shouheng-state",
             "__pycache__", ".venv", "dist", "build"}
SCAN_MAX_BYTES = 512 * 1024


def scan_referenced_ids(root: Path = REPO) -> dict:
    """全仓找出所有被引用的 `P-xx`，回 `{id: [相对路径, ...]}`（只收 `in_ns` 认的）。

    ★ 治的是 2026-09-22 实测到的一个真事故：**P-06 被四份文档指着，而清单里从来没有这一条。**
      `verify_pending.py` 一直退 0 —— 它只验「已有的条目」，从不验「被引用的条目存不存在」。
      同一个病（§2.4：写下的东西必须有执行点），这次长在**索引**上。
    """
    found: dict[str, list[str]] = {}
    # ★ 用 `os.walk` 并**剪枝**，不用 `rglob('*')`：后者会一路走进 `.git` / `node_modules`
    #   才在循环里被跳过 —— 实测 6.8 秒，而它慢的正是那些**永远不会被收**的目录。
    #   剪枝后同一个判据是亚秒级。慢的检查器会被跳过，被跳过的检查器等于不存在。
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in SCAN_SKIP)
        for fn in sorted(filenames):
            p = Path(dirpath) / fn
            if p.suffix not in SCAN_EXTS:
                continue
            rel = p.relative_to(root)
            if p.resolve() == LIST_PATH.resolve():
                continue                  # 清单自己是**定义**这些 id 的地方，不是引用
            try:
                if p.stat().st_size > SCAN_MAX_BYTES:
                    continue
                txt = p.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            for m in set(REF_RE.findall(txt)):
                if not in_ns(m):
                    continue              # 撞车区间：不判（见 REF_MIN/REF_MAX 那段）
                found.setdefault(m, []).append(str(rel))
    return {k: sorted(v) for k, v in sorted(found.items())}


def judge(items: list[dict], today: date, ptr_check=check_pointer, refs=None, at_of=None) -> dict:
    """整份清单的判定。纯逻辑（除 ptr_check / at_of 可能读盘），`--controls` 对它做反向对照。

    `refs` = 「全仓引用了哪些 P-xx」（`scan_referenced_ids()` 的产物，或 controls 造的假样本）。
    `at_of` = 「那条外发是什么时候发的」（`outbound_sent_at`，或 controls 造的假样本）。
    两个都传 None 就**不查那一段** —— 于是这个函数对 controls 仍然是纯的，真跑时由 `main()` 传真。
    """
    struct: list[str] = []
    ids = [it.get("id") for it in items if isinstance(it, dict)]
    for dup in {x for x in ids if ids.count(x) > 1}:
        struct.append(f"id 重复：{dup}")
    for it in items:
        if not isinstance(it, dict):
            struct.append("条目不是对象")
            continue
        struct.extend(validate_item(it, ptr_check))

    # ★ E —— 被引用的条目**必须在清单里**（2026-09-22 加）。
    #   实测事故：P-06 被四份文档指着（AGENTS.md 一处、verify_lark_share.py 两处、
    #   验收文档五处），而清单里从来没有这一条，全绿。**「指着一个不存在的落点」
    #   和不指是同一种病，只是一个更安静。** 折进 struct_errors 是有意的：
    #   daemon 那条链路只读 overdue 与 struct_errors 两个键（见 prd_baseline.mjs），
    #   单开一个键它看不见。
    dangling: list[str] = []
    if refs:
        have = {x for x in ids if x}
        for rid, files in sorted(refs.items()):
            if rid in have:
                continue
            where = "、".join(files[:3]) + ("…" if len(files) > 3 else "")
            dangling.append(f"{rid} 被 {len(files)} 个文件引用，清单里没有这一条：{where}")
            struct.append(dangling[-1])

    # ★ E2 —— 清单**自己**不许长进撞车区间（2026-09-22 加）。
    #   与 E1 是一对：E1 管「被引用的条目要在」，E2 管「在的那一条不许是无法判定的 id」。
    #   没有 E2，清单加到第 10 条时会**安静地**进入 `P-10`+，而扫描器恰好不判那一段 ——
    #   于是 E1 会从「护着」变成「对新增条目完全不设防」，且没有任何东西会红。
    for it in items:
        if not isinstance(it, dict):
            continue
        i = it.get("id")
        if i and not in_ns(i):
            struct.append(
                f"{i}: id 不在本检查器敢判的区间内（P-{REF_MIN:02d}–P-{REF_MAX:02d}）"
                f" —— 这一段是**另一套台账**"
                f"（PMO/守衡-内容推送与被at登记-*.md）的编号区间，引用检查在这里不敢判（会误报）。"
                f"要加第 10 条：先给待收清单换命名空间（如 RC-01）并把引用一起改，"
                f"再放宽 verify_pending.py 的 REF_MIN/REF_MAX。**别把 id 写成 P-10 就往下走。**")

    od = overdue_items(items, today)
    # ★ F 段：**不进 `code`** —— 「问了还没回」不是清单的毛病，也不是违约，只是该再问一句。
    #   把它折进退 1 会让 daemon 那条「清单坏了」的话术被拿来冒充一句催问（§2.4.3 的形状）。
    nag = ask_nags(items, today, at_of)
    code = 1 if (struct or od) else 0
    return {"code": code, "struct_errors": struct, "dangling": dangling,
            "overdue": od, "nag": nag, "total": len(items)}


# ─────────────────────────── 报告 ───────────────────────────

def report(items: list[dict], today: date, res: dict) -> None:
    print("=" * 72)
    print(f"待收清单 · {LIST_PATH.relative_to(REPO)} · 今天（北京时间）{today}")
    print("=" * 72)

    print("\n── A 段：结构判据 ──")
    if res["struct_errors"]:
        for e in res["struct_errors"]:
            print(f"  ❌ {e}")
    else:
        print(f"  ✅ {res['total']} 条全过（含四侧：承诺必须指得出原话 / 我方待问不许标成上游原话"
              f" / **我方待问必须真的问出去过** / **被引用的条目必须在清单里**）")

    print("\n── B 段：条目 ──")
    for it in items:
        due = it.get("到期日") or "无到期日"
        mark = "⏳" if any(o["id"] == it.get("id") for o in res["overdue"]) else "·"
        print(f"  {mark} {it.get('id')}  [{it.get('性质')}/{it.get('状态')}]  到期 {due}")
        print(f"      {it.get('事项')}")
        print(f"      谁说的：{it.get('谁说的')}")

    print("\n── C 段：到期 ──")
    if res["overdue"]:
        for o in res["overdue"]:
            over = "今天到期" if o["过期天数"] == 0 else f"已过 {o['过期天数']} 天"
            print(f"  ⏳ {o['id']} {o['事项']} —— 到期 {o['到期日']}（{over}）")
            if o.get("原话"):
                print(f"      原话：「{o['原话']}」")
            print(f"      到期日来源：{o['到期日来源']}"
                  + ("（**我方推算的日期**，到点是问一句，不是判违约）"
                     if o["到期日来源"] == "我方推算" else ""))
    else:
        print("  ✅ 没有到期未收")

    print("\n── F 段：问出去还没回的（该补问一次） ──")
    nag = res.get("nag") or []
    if nag:
        for n in nag:
            print(f"  ⏳ {n['id']} {n['事项']} —— {n['问于']} 问的，已过 {n['工作日']} 个工作日")
            if n.get("问题"):
                print(f"      问的是：「{n['问题']}」")
        print("      补问只发一次：清单里那条 `outbound` 指针变成 2 条之后，这条就不再多说。")
    else:
        print("  ✅ 没有「问了两个工作日还没回」的条目"
              + ("（或 F 段这次没测到 —— 台账读不出时不猜）" if res.get("code") == 2 else ""))

    print("\n" + "-" * 72)
    nxt = [o for o in res["overdue"]]
    if nxt:
        d = min(date.fromisoformat(o["到期日"]) for o in nxt)
        print(f"❌ 退 1：{len(nxt)} 件到期未收（最早 {d}）")
    elif res["struct_errors"]:
        print(f"❌ 退 1：结构有 {len(res['struct_errors'])} 处违规")
    else:
        upcoming = sorted(it["到期日"] for it in items
                          if it.get("到期日") and it.get("状态") in {"open", "partial"})
        tail = f"；最近一个到期日 {upcoming[0]}" if upcoming else ""
        print(f"✅ 退 0：结构全过、没有到期未收{tail}")


# ─────────────────────────── 反向对照 ───────────────────────────

def controls() -> int:
    """判据两边都要会响：该红时红，该绿时绿。**没红过的断言不算验证过它。**"""
    T = date(2026, 9, 21)
    base = load_list()[0]
    p01 = base["items"][0]          # 真实的「条件承诺」样本
    p02 = base["items"][1]          # 真实的「我方待问」样本
    p03 = base["items"][2]          # 真实的「承诺 + 有我方推算到期日」样本
    p05 = base["items"][4]          # 真实的 kind:outbound 指针样本（我方 15:42 问的那句）
    p06 = base["items"][5]          # 真实的「我方待问 + 恰好一条 outbound」样本（P-06）

    def cp(o, **kw):
        d = json.loads(json.dumps(o))
        d.update(kw)
        return d

    def raw(o, **kw):
        d = json.loads(json.dumps(o))
        d.update(kw)
        return d

    def no_err(o):
        return validate_item(o) == []

    def has_err(o, needle):
        return any(needle in e for e in validate_item(o))

    fake = lambda p: None  # 不读盘的指针检查器（反向对照只在内存里做）

    def scan_tmp(text: str) -> set:
        """把一段文本写进临时目录、跑一遍 E 段扫描器，回它命中的 id 集合。
        用临时目录是为了**证明扫描器本身会不会误报** —— 只喂真盘证明不了这一点
        （真盘上恰好没有坏样本，于是「照单全收」和「判得准」长得一样）。"""
        d = Path(tempfile.mkdtemp(prefix="vp-scan-"))
        (d / "sample.md").write_text(text, encoding="utf-8")
        try:
            return set(scan_referenced_ids(d))
        finally:
            shutil.rmtree(d, ignore_errors=True)

    cases = [
        ("真实样本 P-01（条件承诺）→ 必须过", lambda: no_err(p01)),
        ("真实样本 P-02（我方待问）→ 必须过", lambda: no_err(p02)),
        ("真实样本 P-03（承诺 + 推算到期日）→ 必须过", lambda: no_err(p03)),

        ("★ 性质=承诺 却只有 none 指针 → 必须红",
         lambda: has_err(cp(p03, 出处=[{"kind": "none", "角色": "无", "why": "我觉得她说过"}]),
                         "承诺必须指得出原话")),
        ("★ 反向对照：同一条把「上游原话」指针加回来 → 必须绿（上面那条不是恒红）",
         lambda: no_err(cp(p03))),
        ("★ 性质=我方待问 却有一条被标成上游原话 → 必须红（**这就是本轮那句「她欠着」的形状**）",
         lambda: has_err(cp(p02, 出处=p02["出处"] + [{"kind": "message", "角色": "上游原话",
                                                      "message_id": "om_x100b643ed45a84a4c3b4fa6f80e9c37",
                                                      "quote": "对接人如果需要明确"}]),
                         "不许把我方的问题写成对方的承诺")),

        ("到期日 null 且没写原因 → 必须红",
         lambda: has_err(cp(p01, 无到期日原因=None), "悬着的项必须说清")),
        ("有到期日却没写「到期日依据」→ 必须红",
         lambda: has_err(cp(p03, 到期日依据=None), "日子从哪来的要说得出")),
        ("有到期日却把来源写成「我猜的」→ 必须红",
         lambda: has_err(cp(p03, 到期日来源="我猜的"), "到期日来源非法")),
        ("到期日写成 2026/10/02 → 必须红",
         lambda: has_err(cp(p03, 到期日="2026/10/02"), "格式不对")),

        ("状态=done 但没有完成依据 → 必须红",
         lambda: has_err(cp(p03, 状态="done"), "却没有「完成依据」")),
        ("状态=done 但完成依据是 none 指针 → 必须红",
         lambda: has_err(cp(p03, 状态="done",
                            完成依据=[{"kind": "none", "角色": "无", "why": "她说收到了"}]),
                         "不许出现 none 指针")),
        ("状态=dropped 但没写作废原因 → 必须红",
         lambda: has_err(cp(p03, 状态="dropped"), "却没写「作废原因」")),
        ("状态=随便写 → 必须红", lambda: has_err(cp(p03, 状态="大概吧"), "状态非法")),

        ("★ 真实消息里把 quote 改一个字 → 指针必须红（拿真盘做反向对照）",
         lambda: (lambda q: check_pointer({"kind": "message", "角色": "上游原话",
                                           "message_id": "om_x100b643ed45a84a4c3b4fa6f80e9c37",
                                           "quote": q}) is not None)(
             p01["出处"][0]["quote"].replace("统一入口", "统一入口页"))),
        ("反向对照：**没改**的真 quote → 必须过（上面那条不是恒红）",
         lambda: check_pointer(p01["出处"][0]) is None),
        ("message_id 不存在 → 必须红",
         lambda: check_pointer({"kind": "message", "角色": "上游原话",
                                "message_id": "om_不存在", "quote": "随便"}) is not None),

        # ★ kind:outbound（2026-09-22 加）—— 「我方发出去的话」的指针。
        #   这四条是它的正反两侧：真实那条必须过；quote 改一个字、id 不存在、缺 id 都必须红。
        #   没有这一组，「我方外发有落点了」就只是一句声明（§2.4.2：承诺要有执行点）。
        ("★ outbound 指针：P-05 的真指针（15:42:25 那条）→ 必须过",
         lambda: check_pointer(p05["出处"][0]) is None),
        ("★ outbound 指针：quote 改一个字 → 必须红",
         lambda: check_pointer({**p05["出处"][0],
                                "quote": p05["出处"][0]["quote"].replace("谁来确认", "谁来确定")})
                 is not None),
        ("outbound 指针：message_id 不存在 → 必须红，且报错里要给出 backfill 办法",
         lambda: (lambda e: e is not None and "--backfill" in e)(
             check_pointer({**p05["出处"][0], "message_id": "om_x不存在"}))),
        ("outbound 指针：缺 message_id → 必须红（只给 quote 等于没绑到具体哪一条）",
         lambda: check_pointer({"kind": "outbound", "角色": "我方提问",
                                "quote": p05["出处"][0]["quote"]}) is not None),
        ("file 指针的 quote 不在文件里 → 必须红",
         lambda: check_pointer({"kind": "file", "角色": "本地旧件",
                                "path": "PRD/内容治理需求文档.md",
                                "quote": "这句话在文档里不存在"}) is not None),
        ("file 指针指向不存在的文件 → 必须红",
         lambda: check_pointer({"kind": "file", "角色": "本地旧件",
                                "path": "PRD/没有这个文件.md", "quote": "x"}) is not None),
        ("none 指针没写 why → 必须红",
         lambda: check_pointer({"kind": "none", "角色": "无", "why": ""}) is not None),
        ("角色写成没有的词 → 必须红",
         lambda: check_pointer({"kind": "none", "角色": "好像是上游",
                                "why": "x"}) is not None),

        ("到期判据：open + 到期日=昨天 → 必须进到期表",
         lambda: [o["id"] for o in overdue_items([cp(p03, 到期日="2026-09-20")], T)] == ["P-03"]),
        ("到期判据：**今天**到期 → 必须进（当天就算到期）",
         lambda: [o["id"] for o in overdue_items([cp(p03, 到期日="2026-09-21")], T)] == ["P-03"]),
        ("反向对照：open + 到期日=明天 → 必须不进（上面两条不是恒红）",
         lambda: overdue_items([cp(p03, 到期日="2026-09-22")], T) == []),
        ("反向对照：done + 到期日=昨天 → 必须不进（关掉的条不再提醒）",
         lambda: overdue_items([cp(p03, 到期日="2026-09-20", 状态="done",
                                   完成依据=p03["出处"])], T) == []),
        ("partial + 到期日=昨天 → 必须进（部分收到仍算没齐）",
         lambda: [o["id"] for o in overdue_items([cp(p03, 到期日="2026-09-20", 状态="partial")], T)]
                 == ["P-03"]),
        ("无到期日的条目永远不进到期表（P-01 的现状）",
         lambda: overdue_items([p01], date(2030, 1, 1)) == []),

        ("id 重复 → 必须红",
         lambda: "id 重复" in " ".join(judge([p01, cp(p01)], T, fake)["struct_errors"])),
        ("整份清单干净 + 今天 09-21（未到期）→ 退 0",
         lambda: judge([p01, p02, p03], T, fake)["code"] == 0),
        ("同一份清单 + 今天 10-03（已过期）→ 退 1，且只有 P-03",
         lambda: (lambda r: r["code"] == 1 and [o["id"] for o in r["overdue"]] == ["P-03"])(
             judge([p01, p02, p03], date(2026, 10, 3), fake))),
        ("★ 只要结构违规就退 1（哪怕没有到期未收）",
         lambda: judge([cp(p03, 状态="大概吧")], T, fake)["code"] == 1),
        ("清单读不出 → 必须是「未测」，不是红也不是绿",
         lambda: load_list(REPO / "PMO" / "没有这个清单.json")[1] is not None),

        # ★ D 段（2026-09-22 加）—— 「我方待问」必须真的问出去过。
        #   正反两侧都要有：改红容易，难的是**不许把已经问过的那条也判红**。
        ("★ D：「我方待问 + open」而出处全是 kind:file → 必须红"
         "（这就是 P-02 在 17:34 之前的真实形状）",
         lambda: (lambda o: has_err(o, "没有任何 outbound 指针"))(
             cp(p02, 出处=[p for p in p02["出处"] if p.get("kind") != "outbound"]))),
        ("★ D 反向对照：同一条把 outbound 指针加回来 → 必须绿（上面那条不是恒红）",
         lambda: no_err(p02)),
        ("D：我方待问但状态已 done → 不再追着要 outbound（关了就不问了）",
         lambda: no_err(cp(p02, 状态="done", 完成依据=[p02["出处"][-1]]))),
        ("D 反向对照：承诺类条目没有 outbound → **不许**被这条判红（它只管我方待问）",
         lambda: no_err(cp(p03, 出处=[p for p in p03["出处"] if p.get("kind") != "outbound"]))),
        ("D 反向对照：我方待问但出处是空的 → 「出处必须非空」必须报出来"
         "（这是更根本的那一条，别被 D 的话盖过去）",
         lambda: any("出处必须是非空数组" in x for x in validate_item(cp(p02, 出处=[])))),

        # ★ E 段（2026-09-22 加）—— 被引用的条目必须在清单里。
        #   来历：P-06 被四份文档指着，清单里从来没有这一条，而 verify_pending 一直退 0。
        ("★ E：文档引用了 P-99 而清单里没有该条 → 必须红，且报错点得出是哪个文件",
         lambda: (lambda r: r["code"] == 1
                  and any("P-99" in e and "fake.md" in e for e in r["dangling"]))(
             judge([p01, p03], T, fake, refs={"P-99": ["fake.md"]}))),
        ("★ E 反向对照：引用的 P-03 就在清单里 → 必须绿（上面那条不是恒红）",
         lambda: judge([p01, p03], T, fake, refs={"P-03": ["fake.md"]})["code"] == 0),
        ("E：不传 refs 时**不查**引用（judge 对 controls 仍是纯的）",
         lambda: judge([p01, p03], T, fake)["dangling"] == []),
        ("★ E：扫描器从**真盘**上读得到 P-06 —— 它确实被四份文档引用着",
         lambda: "P-06" in scan_referenced_ids()),
        ("E：扫描器抓得住正常引用",
         lambda: scan_tmp("见 PMO/待收清单-v1.json 的 P-06。\n") == {"P-06"}),
        ("★ E 反向对照：扫描器**不许**把 `PDP-06` / `PB-007` 当成条目编号"
         "（两者都真的在盘上；一个会误报的检查器比没有检查器更糟）",
         lambda: scan_tmp("US_Aug2026_PDP-06.jpg\nPB-007 手册原文\n") == set()),
        ("E 反向对照：清单文件自己不算「引用」（它是**定义**这些 id 的地方）",
         lambda: scan_referenced_ids(LIST_PATH.parent.parent).get("P-06") is not None),

        # ★★ E 段的**假红**这一侧（2026-09-22 当天就踩到，必须留成断言）。
        #   第一版扫描器没有命名空间边界，当场把 PMO/守衡-内容推送与被at登记-*.md 里
        #   **它自己的行号** P-10…P-34 报成「被引用但清单里没有」×22 条。
        #   这四条钉住「宁可少查，也不误报」。
        ("★★ E 反向对照：`P-10`…`P-34`（另一套台账的行号）**不许**被当成待收清单的引用",
         lambda: scan_tmp("".join(f"| P-{n} | 09-16 | 推送 | 群 |\n" for n in range(10, 35))) == set()),
        ("★★ 反向对照：真盘上那份『内容推送与被at登记』的 25 个行号，扫描器一个都不许收",
         lambda: not any(n in scan_referenced_ids()
                         for n in ["P-10", "P-16", "P-24", "P-29", "P-34"])),
        ("★ E2：清单里出现 P-10 → **必须红**（命名空间撞车；改红是为了逼一次显式决定）",
         lambda: any("不在本检查器敢判的区间内" in e
                     for e in judge([cp(p01, id="P-10")], T, fake)["struct_errors"])),
        #   ★ 这里刻意**不写字面量**（区间最后一个 id）：本文件自己也在扫描范围内
        #     —— 它确实会引用条目 —— 写一个不在清单里的字面量，E1 就会把这个检查器
        #     **自己**报成「引用了不存在的条目」。
        #     第一版就是这么写的，跑出一条自指的假红；第二版把成因写进注释，
        #     **注释里又把这个字面量写了一遍**，于是假红原样复现 —— §2.4.4 记过同一个形状
        #     （判据被它自己的解释文字绊倒）。**注释不算代码，但扫描器不认这句话。**
        ("★ E2 反向对照：id 取区间内**最后一个**（REF_MAX）→ 不许被 E2 判红"
         "（上面那条不是恒红）",
         lambda: not any("不在本检查器敢判的区间内" in e
                         for e in judge([cp(p01, id=f"P-{REF_MAX:02d}")], T, fake)["struct_errors"])),
        ("★ E2：清单长过 9 条时必须**自己说出来**，而不是安静地不判",
         lambda: (lambda r: r["code"] == 1 and len(r["dangling"]) == 0
                  and any("不在本检查器敢判的区间内" in e for e in r["struct_errors"]))(
             judge([cp(p01, id="P-10")], T, fake, refs={}))),

        # ★ F 段（2026-09-22 加）—— 「问出去两个工作日了还没回」该补问一次。
        #   这一段的难点全在**边界**上：多推一次是打扰真人，少推一次是事情永远悬着。
        #   所以下面每一条「该推」都配一条「不该推」。
        ("F：工作日数 —— 周五 → 下周一 = 1（跳掉周六日）",
         lambda: working_days_between(date(2026, 9, 18), date(2026, 9, 21)) == 1),
        ("F：工作日数 —— 周五 → 下周二 = 2",
         lambda: working_days_between(date(2026, 9, 18), date(2026, 9, 22)) == 2),
        ("F：工作日数 —— 周六起算也算：周六 → 下周一 = 1",
         lambda: working_days_between(date(2026, 9, 19), date(2026, 9, 21)) == 1),
        ("F 反向对照：同一天 = 0（上面几条不是恒 ≥1）",
         lambda: working_days_between(date(2026, 9, 21), date(2026, 9, 21)) == 0),
        ("F 反向对照：今天早于问的那天 = 0，不许回负数",
         lambda: working_days_between(date(2026, 9, 22), date(2026, 9, 21)) == 0),
        ("★ F：四条都成立（还开着 / 恰好一条 outbound / 已过 2 个工作日）→ 必须进补问表",
         lambda: [n["id"] for n in ask_nags([p06], T, lambda _m: "2026-09-17T09:00:00.000Z")]
                 == ["P-06"]),
        ("★ F 反向对照：**今天刚问的** → 不许进（上面那条不是恒进）",
         lambda: ask_nags([p06], T, lambda _m: "2026-09-21T01:00:00.000Z") == []),
        ("★ F 反向对照：**指针有两条**（已经问过不止一次）→ 不许再自动补"
         "（这就是「每条只补一次」的判据本身）",
         lambda: ask_nags([p05], T, lambda _m: "2026-09-17T09:00:00.000Z") == []),
        ("★ F 反向对照：**零条 outbound**（还没问过）→ 不进补问表 —— 那是 D 段要红的事，"
         "两条判据不许互相冒充",
         lambda: ask_nags([p03], T, lambda _m: "2026-09-17T09:00:00.000Z") == []),
        ("★ F：状态已 done → 不许进（关了就不再追）",
         lambda: ask_nags([cp(p06, 状态="done", 完成依据=[p06["出处"][0]])], T,
                          lambda _m: "2026-09-17T09:00:00.000Z") == []),
        ("★ F：**取不到时刻**（台账读不出 / 那条不在台账里）→ 不进 —— 没测到 ≠ 该问",
         lambda: ask_nags([p06], T, lambda _m: None) == []),
        ("F 反向对照：不传 at_of（纯函数模式）→ 恒空，controls 不会被真台账污染",
         lambda: ask_nags([p06], T, None) == []),
        ("★ F：真盘上今天（09-22）**补问表必须是空的** —— 那三条都是今天 17:34 才问的",
         lambda: ask_nags(base["items"], date(2026, 9, 22), lambda _m: "2026-09-22T09:34:50.256Z")
                 == []),
        ("★ F 拿真盘做正向：把这批「问于 09-17」→ 三条并进补问表（它确实会响，不是恒空）",
         lambda: sorted(n["id"] for n in ask_nags(base["items"], T,
                                                  lambda _m: "2026-09-17T09:00:00.000Z"))
                 == ["P-01", "P-02", "P-06"]),
        ("★ F：`nag` **不许**折进 `code` —— 「问了还没回」不是清单坏了，"
         "否则 daemon 会拿「清单坏了」的话术去冒充一句催问",
         lambda: judge([p06], T, fake, refs={}, at_of=lambda _m: "2026-09-17T09:00:00.000Z")
                 ["code"] == 0),
    ]

    print("=" * 72)
    print("verify_pending · 反向对照（离线；只读盘上既有文件，不写盘、不联网、不发消息）")
    print("=" * 72)
    bad = 0
    for i, (name, fn) in enumerate(cases, 1):
        try:
            ok = bool(fn())
            err = ""
        except Exception as e:  # noqa: BLE001
            ok, err = False, f"（抛异常 {type(e).__name__}: {e}）"
        if not ok:
            bad += 1
        print(f"  {'✅' if ok else '❌'} [{i:2}/{len(cases)}] {name}{err}")
    print("-" * 72)
    if bad:
        print(f"❌ {len(cases)} 项中 {bad} 项失败 —— 判据有问题，别信它")
        return 1
    print(f"✅ {len(cases)} 项全过（含「该红时红」与「该绿时绿」两侧）")
    return 0


# ─────────────────────────── CLI ───────────────────────────

def main(argv: list[str]) -> int:
    if "--controls" in argv:
        return controls()

    today = bj_today()
    for a in argv:
        if a.startswith("--today="):
            today = date.fromisoformat(a.split("=", 1)[1])

    data, err = load_list()
    if err:
        # ★ 未测 —— 与「通过」和「红」都长得不一样
        if "--json" in argv:
            print(json.dumps({"code": 2, "reason": err, "overdue": [], "struct_errors": [],
                              "total": 0, "today": str(today)}, ensure_ascii=False))
        else:
            print(f"⚠️ 未测：{err}")
            print("   这不是「没有待收」，是「这次没读成」—— 清单在盘上，去看一眼。")
        return 2

    items = [x for x in data["items"] if isinstance(x, dict)]
    res = judge(items, today, refs=scan_referenced_ids(), at_of=outbound_sent_at)
    res["today"] = str(today)

    if "--json" in argv:
        print(json.dumps(res, ensure_ascii=False))
        return res["code"]

    report(items, today, res)
    if res["struct_errors"]:
        print("\n  清单本身有问题，先修 PMO/待收清单-v1.json，再看到期那一段。")
    return res["code"]


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
verify_outbound.py —— 「守衡说出去的话，落下来了吗」

要验的东西（一句话）：**守衡说过的话，两处都看得见吗？**
① 它自己的**会话记忆**（对方回复时它知不知道自己在跟哪一句对话）；
② 盘上一本只增不删的**外发台账**（「我方发出的消息」能不能被指出来）。

它守的是一次**真实的外部误答**（2026-09-22，全过程见 `PMO/守衡-误答登记-20260922.md`）：

```
14:37:55  我方主动推送问「117 条签核归谁？」   ← send_once.mjs 发的，盘上零痕迹（只 stdout 一个 id）
14:39:34  她在【话题里】回「归我」
14:39:51  守衡答「收到，那三条过期内容归你」   ← 它不知道自己在 14:37 问过什么，答非所问
```

两条根因分别对应 `PMO/守衡-误答登记-20260922.md` §3.1（出站不进会话记忆）与 §五 第 5 条
（出站无留痕）。**本检查器只管这两条**；「她答的是哪一句」（丢 `parent_id`）在
`tools/verify_reply_context.py` 里，别把这边变绿读成那边也好了。

---

## 各段在验什么

| 段 | 验什么 | 靠什么 |
|---|---|---|
| **A** | 判据本身对：什么该折进记忆、什么不该 | 跑 `agent/outbound.mjs` 的纯函数，**台账指向临时目录**（离线） |
| **B** | 判据**真的接在链路上** | 读 `ws_daemon.mjs` / `agent.mjs` / `send_once.mjs` 源码，要求**到达分支与赋值** |
| **C** | B 段那些扫描器**自己会红** | 在内存里把源码改坏，同一个扫描器必须报红 |
| **D** | 拿**真实台账 + 真实会话**做回归 | 那句问话必须「已在记忆里 **或** 在补记清单里」—— 两处都缺席就是事故重演 |
| **E** | 结论行自己不许撒谎 + 自证不许改真数据 | `verdict()` 纯函数 + 真实台账前后比对 |
| **G** | 读回正文那半边：post / interactive / text 各自读得对不对 | 跑 `feishu.mjs` 的 `bodyToText`，喂**真实 payload** |

## 已知盲区（明着留着，别当成已经证过）

* **B/C 是静态的。** 它们证明源码里有那条调用、坏样本会被抓到，
  **不证明**运行时真的走到 —— 走到它需要一次真的主动推送 + 一次真的回复。
  运行时那一半由 **D 段**用真实数据顶住；D 段只覆盖「台账里已经有的那几条」。
* **折进记忆这件事本身，在重启之前不会发生**（`ws_daemon.mjs` 还在跑旧代码）。
  D3 断言的是「**修复后的代码**会把那句问话补上」，**不是**「守衡现在记得了」。
  这两句话差一个重启，见 `PMO/守衡-误答登记-20260922.md` §7.2 的读数方法。
* **卡片正文读不回来**（飞书那个接口只回占位文案）。G2 断言的是「**说得准**」，
  不是「读得到」—— 见 `bodyToText` 的 `interactive` 分支。

用法：
  python3 tools/verify_outbound.py            # 全跑
  python3 tools/verify_outbound.py --offline  # 跳过要读真实文件的 D/H 段（→ 未测，退 2）
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DAEMON = ROOT / "tools" / "ws_daemon.mjs"
AGENT = ROOT / "tools" / "agent" / "agent.mjs"
OUTBOUND = ROOT / "tools" / "agent" / "outbound.mjs"
FEISHU = ROOT / "tools" / "agent" / "feishu.mjs"
SEND_ONCE = ROOT / "tools" / "send_once.mjs"
LEDGER = ROOT / "PMO" / "logs" / "ws_outbound.jsonl"
INCIDENT_CHAT = "oc_TEST_GROUP"
INCIDENT_SESSION = ROOT / "PMO" / "shouheng-state" / "sessions" / f"chat_{INCIDENT_CHAT}.json"

# ★ H 段的分界线：**「台账开始记录投递事实（`extra.delivery`）」这一刻**。
#   取法（可复算）：`ws_daemon.mjs` 的 `replyTo` / `safeSend` 加上那两行的那次编辑
#   （2026-10-14 北京时间约 15:0x ⇒ 07:00Z）。
#
#   ★★ 这条分界线**纠正了我自己写的第一版判据**：第一版直接拿「台账正文里有没有 `**`」
#   判红，于是它把 `06:44:02Z` 那条判成了泄漏 —— **而飞书侧读回来是 0 个星号**
#   （`GET /im/v1/messages/{id}`，类型 `post`）。台账存的是**模型原文**，
#   而摘符号发生在**发送那一跳**：**「台账那行带星号」≠「对方看到星号」**。
#   ⇒ 判据改成断**投递事实**：要么台账正文本来就干净，要么这条记录里
#   写着 `extra.delivery.starsRemoved`（真的摘过）。两者都没有才是红。
#
#   历史记录（分界线之前）**不回改台账**（§D 段纪律），故单列豁免。
#   若将来重构这一段，把这条时刻往后挪**必须同时说明为什么**，否则它就成了一把
#   会自动豁免新泄漏的橡皮尺（与 `LEGACY_UNKNOWN_SOURCES` 同一种风险）。
STAR_FIX_AT = "2026-10-14T07:00:00Z"

# 本次事故那两条真实外发（读数取自 PMO/守衡-误答登记-20260922.md §一/§四，逐字）
INCIDENT_OUR_MSG = "om_x100b64166aff2ca8b487459d2f76acb"   # 14:37:55 我方问「117 条签核归谁」
INCIDENT_OUR_FIX = "om_x100b6416cc300890b15041c1568cac7"   # 15:03:11 那条更正
INCIDENT_QUESTION_FRAGMENT = "117 条的拆分方案"
# 台账里那两条的发出时刻（**北京**，接口 `create_time` 读出来的，不是我手记的两行字）
INCIDENT_AT_PREFIX = {INCIDENT_OUR_MSG: "2026-09-22T06:37:55", INCIDENT_OUR_FIX: "2026-09-22T07:03:11"}

OFFLINE = "--offline" in sys.argv
results = []   # (id, ok, msg)
untested = []  # (id, msg)


def check(cid, ok, msg):
    results.append((cid, bool(ok), msg))
    return bool(ok)


def cannot_test(cid, msg):
    """采不到证据时用它。`check(cid, True, ...)` 是把没测说成没问题（§2.4.2 明令禁止）；
    `check(cid, False, ...)` 是把没测冤枉成坏了（§2.4.1 第 5 行）。"""
    untested.append((cid, msg))


def verdict(n_fail, n_untested):
    """0 = 全过 ｜ 1 = 有红 ｜ 2 = **有未测**（既不是通过，也不是红）"""
    if n_fail:
        tail = f"；另有 {n_untested} 项未测（见 ⚠ 行）" if n_untested else ""
        return 1, f"❌ {n_fail} 项红{tail}"
    if n_untested:
        return 2, f"⚠ {n_untested} 项未测 —— 这不是通过（退 2，与 §2.4.2 同口径）"
    return 0, "✅ 全过"


def strip_comments(src: str) -> str:
    """去掉块注释与行尾 `//` 注释再扫。

    不这么做，**解释这件事的注释会把判据自己骗过去**（§2.4.4 第三版就是被自己的解释文字绊倒的）。
    已知盲区：字符串字面量里的 `//` 也会被切掉；本文件扫的那几个文件里没有这种字面量。

    ★★ 顺序必须**先 `//` 后 `/*`**（2026-10-06 修，实测踩到）。
      原先是反的，后果不是"少去一点注释"，而是**判据自己吞掉整段源码**：
      `agent.mjs` 第 926 行有一句**行注释**，正文里引用了当时那句错话 ——
      `「附件（文件/语音/**视频**）我不取」`，其中 `语音/` 与 `**视频**` **拼出了一个 `/**`**。
      非贪婪的 `/*…*/` 于是在**下游**才找到配对的 `*/`，一口气删掉 **33848 字符**
      （实测：57210 → 23362），B1 的四个锚点全变 -1 ——
      报出来的是「折进记忆那一步没接在链路上」，而**真正发生的事是判据把源码吃了**。
      先切行注释，这个 `/**` 就随那一行一起没了；块注释里的 `//` 被先切掉也无害（那一段本来就要删）。
      ⚠️ 这条修改只会让它**更严**（原先够不着的锚点现在够得着、B/C 那些反向对照也才真的跑得到），
        不是放宽：改完 `C1/C2` 的坏样本从「模式没匹配上」变成**真的改到了源码**。
    """
    s = "\n".join(re.sub(r"//.*$", "", ln) for ln in src.splitlines())
    return re.sub(r"/\*[\s\S]*?\*/", "", s)


def read(p: Path) -> str:
    try:
        return p.read_text(encoding="utf-8")
    except OSError:
        return ""


def sha256(p: Path) -> str | None:
    try:
        return hashlib.sha256(p.read_bytes()).hexdigest()
    except OSError:
        return None


def _at_matches_ledger(folded: list, ledger: Path) -> bool:
    """折进来的每一条，`at` 必须**逐字等于**台账里它自己那条记录的 `at`。

    比的是「发出那一刻」，不是「现在」—— 用 `!= now` 那种判据是假精度（一次调用里 now 只有一个值，
    任何非空值都能过）。这里拿台账本身当基准。
    """
    try:
        recs = [json.loads(x) for x in ledger.read_text(encoding="utf-8").splitlines() if x.strip()]
    except (OSError, json.JSONDecodeError):
        return False
    by_id = {mid: r.get("at") for r in recs for mid in (r.get("message_ids") or [])}
    return all(m.get("at") and m["at"] == by_id.get((m.get("ids") or [None])[0]) for m in folded)


def run_node(script: str, ledger: Path | None = None, timeout=40):
    """跑一段 ESM，要求最后一行是可解析的 JSON。回 (ok, 结果或错误串)。"""
    env = dict(os.environ)
    if ledger is not None:
        env["SHOUHENG_OUTBOUND_LEDGER"] = str(ledger)
    try:
        p = subprocess.run(["node", "--input-type=module", "-e", script],
                           cwd=str(ROOT), capture_output=True, text=True, timeout=timeout, env=env)
    except FileNotFoundError:
        return False, "找不到 node"
    except subprocess.TimeoutExpired:
        return False, f"node 超时（{timeout}s）"
    if p.returncode != 0:
        return False, (p.stderr or p.stdout).strip()[:500]
    try:
        return True, json.loads(p.stdout.strip().splitlines()[-1])
    except (json.JSONDecodeError, IndexError):
        return False, f"node 没打出可解析的 JSON：{p.stdout.strip()[:300]}"


# ══════════════════════════════════════════════════════════════════════
# B 段用的扫描器 —— 抽成函数，好让 C 段拿同一个扫描器去扫坏样本
# ══════════════════════════════════════════════════════════════════════
# 「能直接发消息」的两种调用形状。谁出现在这个名单里，谁就必须能说清留痕在哪。
RAW_SEND_RE = re.compile(r"\.im\.message\.(?:create|reply)\s*\(")          # 自己建客户端直连
FEISHU_SEND_RE = re.compile(r"(?:feishu\.)?(?:sendMarkdown|replyMarkdown|replyCard|sendTextWithMentions|sendCard)\s*\(")

# ★ 发送者总表：全仓**能发消息**的文件必须**恰好**是这些。
#   判据不是「允许」，是两个方向都要成立：
#     · 表外的出现了 → 多了一条没人知道在哪儿记账的出口（B16）；
#     · 表内的不再发送 → 这张表开始变成过期白名单，掩护下一个偷偷加进来的（B17）。
#   `records` 非空的，还必须在文件里**真的找到那一行记账代码**（B19）——
#   否则「它在记账」这句话就只是一句声明。
SEND_OWNERS = {
    "tools/ws_daemon.mjs": {
        "records": "recordOutbound(chatId, sent",
        "why": "daemon：replyTo（回答某一条）与 safeSend（主动说出去的话）—— 两处都记账",
    },
    "tools/send_once.mjs": {
        "records": "outbound.recordSend(",
        "why": "人工手发 CLI：走 feishu.sendMarkdown，记 source=manual",
    },
    "tools/agent/feishu.mjs": {
        # ★ 2026-10-26：这一格从 None 变成下面这行 —— 它现在**确实**留痕了，
        #   但留的不是业务台账，而是**物理留痕** `PMO/logs/feishu_sends.jsonl`：
        #   每一条真打到飞书的消息一行，带 `caller`（哪个文件哪一行调的）与 `pid`。
        #   为什么不在这层写业务台账：那张台账的 `source` 决定**折不折进会话记忆**，
        #   而探针卡 / 卡片 CLI / 自检样本发的是样例 —— 记进去就是污染记忆
        #   （下面那几条 `records: None` 的理由说的正是这件事）。
        #   这次事故缺的只是「谁发的」：`ws_outbound.jsonl` 查得到「发了什么」，
        #   查不到「哪个进程发的」。判据在 `tools/agent/send_trace.test.mjs`（8 条，含 4 条反向对照）。
        "records": "notePhysicalSend({",
        "why": "物理层本身：所有发送最终都落在它这里（全仓**七个**文件共用这一个 `client`）。"
               "业务台账在它上面一层（daemon / send_once / 批跑器 / re_review_reply 各自记账）；"
               "它这层只记**物理留痕**（谁发的、哪个 pid、哪一行），供归因用，不参与任何决策",
    },
    # ★ 2026-10-26 登记：B16 一直在报「全仓有表外发送者」—— 就是它，从 10-15 起漏在表外。
    #   它**本来就记账**（`outbound.recordSend`，source=reply / chain-ack），漏的是**登记**：
    #   「全仓每条出口都有人负责」这张表实际上少了这一条 ⇒ 又一个
    #   「名字出现过 ≠ 它拦得住」（`why` 说得再对，没登记就等于没人管）。
    "tools/re_review_reply.mjs": {
        "records": "outbound.recordSend(",
        "why": "人手动重发某条评审结论（`--msg <id>`）：走与 daemon 同一条形态链"
               "（`toCardOrText` 成形 ＋ `feishu.replyCard/replyMarkdown` 发送 ＋ `outbound.recordSend` 留痕）；"
               "台账指回真台账，状态目录隔离（不污染去重表与会话记忆）",
    },
    # ★ 2026-10-26 登记：留痕层自己的自证。它调的 `im.message.create/reply` 是
    #   `fakeClient()` 造的桩（一个字节都不发网络）⇒ 不进业务台账，与
    #   `test_agent.mjs`（把 client 换成本地捕获器）同一类。
    "tools/agent/send_trace.test.mjs": {
        "records": None,
        "why": "留痕层自证：`installSendTrace(假 client)` —— 桩、不发网络；8 条断言"
               "（含 4 条反向对照：不装就没行 / 抛错照旧抛 / caller 跳过本文件帧 / 重复装不记两行）；"
               "`SHOUHENG_SEND_TRACE` 在导入前就指到临时目录（§2.4.4，不写真留痕）",
    },
    "tools/reply-cards/index.mjs": {
        "records": None,
        "why": "`sendCard`：只被 reply-cards/cli.mjs 与探针调用；daemon 走 envelope + feishu.replyCard，**不经它**",
    },
    "tools/reply-cards/cli.mjs": {
        "records": None,
        "why": "卡片 CLI：发的是样例卡（正文自带「可忽略」），**不是守衡对外说的话** —— 与探针同一类",
    },
    "tools/probe_cards.mjs": {
        "records": None,
        "why": "卡片渲染探针：发的是自检样本，**不是守衡对外说的话**，进台账反而会污染它的记忆",
    },
    "tools/probe_cards2.mjs": {"records": None, "why": "同上（第二轮探针）"},
    "tools/test_agent.mjs": {
        "records": None,
        "why": "内核自证：**它调 feishu 的发送函数是打桩的**（把 `client.im.message.*` 换成本地捕获器，"
               "见第 3 组「真发一次（网络打桩）」）—— 一次网络都不发，所以没有台账可记。"
               "★ 2026-10-14 登记（它原先不在表里，B16 因此报红）：它之所以看起来像发送者，"
               "是因为发星星那条行为级断言**必须真的走到发送那一跳**才证明得了 —— "
               "那正是「判据要走进那一跳」的代价，不是它偷偷开了第二条发送路。",
    },
    "tools/ws_test.mjs": {"records": None, "why": "2026-09-15 长连接联调脚本：回一句固定回执，一次性工具"},
    # ★ 2026-10-13 补登记：B16 一直在报「表外出现了发送者」—— 就是它。
    #   它不是偷偷长出来的出口，是一个**人眼探针**：枚举 6 张候选卡（表头配色 / 元素级
    #   色带两套路子）发到测试群，让委托方挑一张；默认**干跑**，加 `--send` 才真发。
    #   归到探针这一类（同 `probe_cards*.mjs`）：发的是自检样例，不是守衡对外说的话，
    #   进台账反而会污染它的记忆。★ 它**发完不撤回**（发之前自己会打印这一句）。
    # ★ 2026-10-13 加：本机批跑器 —— 它**确实在守衡的名义下说话**（用守衡自己的身份发卡），
    #   所以它必须进这张表，且必须真的记账（B19 会到文件里找下面那一行）。
    #   与 `ws_daemon` 的区别只有一处：daemon 发的是「回答某一条」，它发的是「新的一条」。
    "tools/batch_review_runner.mjs": {
        "records": "recordSend({",
        "why": "本机批跑器：逐条走送审那条路（handleMessage → runSubmissionGate），"
               "再用守衡自己的身份把结论发进会话；每条都写 outbound 台账（source=batch-review）",
    },
    "tools/probe_receipt_color.mjs": {
        "records": None,
        "why": "回执配色人眼探针（2026-10-06）：颜色没有离线判据，只能发出来看；默认干跑，--send 才发",
    },
}


def top_level_function_names(src: str) -> list:
    return [(m.group(1), m.start()) for m in
            re.finditer(r"^(?:export\s+)?(?:async\s+)?function\s+(\w+)", src, re.M)]


def enclosing_function(src: str, pos: int) -> str | None:
    name = None
    for nm, at in top_level_function_names(src):
        if at < pos:
            name = nm
        else:
            break
    return name


def call_arg_texts(src: str, fname: str) -> list:
    """取出 `fname(...)` 每一次调用的**顶层实参**文本（按顶层逗号切）。跳过函数定义那一处。

    为什么不用正则 `\\(([^)]*)\\)`：实参里含括号与模板串（`safeSend(chatId, \\`…\\`)`），
    正则会在第一个 `)` 就断掉，于是「第 3 个实参」根本取不到 —— 而取不到时
    最容易写成「**没传也算过了**」。
    """
    out = []
    for m in re.finditer(r"(?<![\w.])" + re.escape(fname) + r"\s*\(", src):
        # 跳过定义：`function safeSend(`
        head = src[max(0, m.start() - 40):m.start()]
        if re.search(r"function\s+$", head) or re.search(r"function\s+\w*\s*$", head):
            continue
        i = m.end()
        depth = 1
        args, cur = [], ""
        quote = None
        while i < len(src) and depth > 0:
            c = src[i]
            if quote:
                cur += c
                if c == quote and src[i - 1] != "\\":
                    quote = None
            elif c in "\"'`":
                quote = c
                cur += c
            elif c == "(":
                depth += 1
                cur += c
            elif c == ")":
                depth -= 1
                if depth == 0:
                    break
                cur += c
            elif c == "," and depth == 1:
                args.append(cur.strip())
                cur = ""
            else:
                cur += c
            i += 1
        if cur.strip():
            args.append(cur.strip())
        out.append(args)
    return out


def scan_wiring(daemon: str, agent: str, send_once: str) -> dict:
    """扫三个文件（已去注释）。回 {检查号: (通过?, 说明)}。"""
    out = {}

    # ── daemon：发送的**归属**与**记账** ──
    # ★ 判据盯的是 `feishu.sendMarkdown / replyCard / …` 这一层（daemon 真正用的那一层），
    #   **不是** `.im.message.*`：daemon 从不自己建客户端，写 `.im.message.*`
    #   会让这条断言在真源码上**一个都不匹配 → 恒真**（第一版就是这样，
    #   实测 B4 报「一个都没有」而 B5 空转绿）。§2.4：名字出现过 ≠ 拦得住；
    #   这里是它的反面 —— **一个都匹配不上 ≠ 没有违规**。
    raw_owners = sorted({enclosing_function(daemon, m.start())
                         for m in FEISHU_SEND_RE.finditer(daemon)} - {None})
    out["B4"] = (raw_owners == ["replyTo", "safeSend"],
                 f"daemon 里能发消息的顶层函数**恰好**是 replyTo 与 safeSend"
                 f"（实测 {raw_owners or '一个都没有'}）—— 多一个就是多一条不记账的出口")

    # 每个带发送的函数体里必须出现记账调用
    bodies_ok, missing, checked = True, [], 0
    fns = top_level_function_names(daemon)
    for idx, (nm, at) in enumerate(fns):
        end = fns[idx + 1][1] if idx + 1 < len(fns) else len(daemon)
        body = daemon[at:end]
        if FEISHU_SEND_RE.search(body):
            checked += 1
            if "recordOutbound(chatId, sent" not in body:
                bodies_ok = False
                missing.append(nm)
    # ★ `checked == 0` 必须报红，不许当成「没有不合规的」—— 扫描器一个都没扫到时，
    #   它报的「漏的：无」与「真的都合规」长得一模一样（§2.2 第 5 条那个 `timeout` 的坑）。
    out["B5"] = (bodies_ok and checked > 0,
                 f"带发送的每个函数体里都调了记账（检查了 {checked} 个；漏的：{missing or '无'}）")

    # replyTo：记账必须**在 return 之前**，而且出口只有一个（多出口 = 漏记的形状）
    rt = daemon[daemon.find("async function replyTo"):daemon.find("async function safeSend")] \
        if "async function replyTo" in daemon else ""
    if not rt:
        out["B6"] = (False, "找不到 replyTo")
    else:
        n_rec = len(re.findall(r"recordOutbound\(\s*chatId\s*,\s*sent", rt))
        n_ret = len(re.findall(r"^\s*return\b", rt, re.M))
        pos_rec = rt.find("recordOutbound(chatId, sent")
        pos_last_ret = [m.start() for m in re.finditer(r"^\s*return\b", rt, re.M)][-1] if n_ret else -1
        out["B6"] = (n_rec == 1 and n_ret == 1 and 0 <= pos_rec < pos_last_ret,
                     f"replyTo 里记账恰好一次、且在**唯一那个 return** 之前"
                     f"（实测记账×{n_rec} / return×{n_ret}）—— 多出口就是漏记的形状")

    # safeSend 的 source 是**必填**（没有默认值）—— 给默认值会让「忘了传」静默记成别的东西
    m = re.search(r"async\s+function\s+safeSend\s*\(([^)]*)\)", daemon)
    if not m:
        out["B7"] = (False, "找不到 safeSend 的定义")
    else:
        params = [x.strip() for x in m.group(1).split(",")]
        out["B7"] = (len(params) >= 3 and "=" not in params[2].split("//")[0],
                     f"safeSend 的第 3 个形参 `source` **没有默认值**（实测形参：{params}）—— "
                     f"少传一个会记成 unknown:，那在台账里看得见")

    # 每个 safeSend 调用点都必须传够参数
    sites = call_arg_texts(daemon, "safeSend")
    bad = [a for a in sites if len(a) < 3]
    out["B8"] = (bool(sites) and not bad,
                 f"{len(sites)} 个 safeSend 调用点都传了 source（漏传的：{bad or '无'}）")

    # replyTo 的 source 形参：**必须有默认值，且原样传进 recordOutbound**（2026-09-22 改）
    # 原先这里断言的是源码里有 `source: 'reply'` 这个字面量 —— 加了补发（`resend`）之后，
    # 来源成了一个**传进来的参数**，那个字面量移到形参默认值上去了。判据跟着判据的对象走：
    # 现在要证明的是「参数**到达了**记账那一行」，而不是「某个字面量出现过」（§2.4.4 第三版）。
    m = re.search(r"async\s+function\s+replyTo\s*\(([^)]*)\)", daemon)
    if not m:
        out["B9"] = (False, "找不到 replyTo 的定义")
    else:
        params = [x.strip() for x in m.group(1).split(",")]
        has_default = len(params) >= 5 and "'reply'" in params[4]
        rt_body = daemon[daemon.find("async function replyTo"):daemon.find("async function safeSend")]
        passes = bool(re.search(r"recordOutbound\(\s*chatId\s*,\s*sent\s*,\s*\{[^}]*\bsource\b", rt_body))
        out["B9"] = (has_default and passes,
                     f"`replyTo` 的 `source` 形参带默认值 `'reply'`（实测形参：{params}）"
                     f"且**原样传进** `recordOutbound`（到达记账行 = {passes}）—— "
                     f"少传一个参数会静默记成别的东西")

    # ★ 补发这条出口（Q1-1f，2026-09-22 加）：**新发送路径必须自证留痕**。
    #   补发是唯一会「主动往群里再发一条」的新路径，而它走的仍是 `replyTo`
    #   （形态决策一处做，§2.5）—— 所以「谁能发消息」那张表不用加行，
    #   但**必须有人断言**：这条出口真的经过 replyTo，且带着 `source='resend'`。
    resend_sites = [a for a in call_arg_texts(daemon, "replyTo") if any("resend" in x for x in a)]
    retry_wired = bool(re.search(r"retryQueue\.runTick\s*\(", daemon)) \
                  and bool(re.search(r"retryQueue\.enqueue\s*\(", daemon)) \
                  and bool(re.search(r"answer:\s*\(it\)\s*=>\s*handleMessage\(it\.event", daemon))
    out["B20"] = (bool(resend_sites) and retry_wired,
                  f"补发那条出口真的走 `replyTo` 且记 `source='resend'`"
                  f"（调用点 {len(resend_sites)} 个）；接线三件齐：入队 / 每拍补一条 / 重放内核"
                  f"（={retry_wired}）")

    # ── agent：折进记忆那一步真的在锁里、且在用户轮/上文块之前 ──
    lock_at = agent.find("withLock(key, async () => {")
    user_at = agent.find("mem.append(sess, { role: 'user'")
    quote_at = agent.find("const parentId = parentIdOf(msg)")
    fold_at = agent.find("foldInto(sess,")
    if lock_at < 0 or user_at < 0 or fold_at < 0 or quote_at < 0:
        out["B1"] = (False, f"找不到锚点：withLock={lock_at} foldInto={fold_at} "
                            f"用户轮={user_at} 上文块={quote_at}")
        out["B2"] = (False, "锚点缺失，无从判断顺序")
    else:
        out["B1"] = (lock_at < fold_at < user_at,
                     "`foldInto` 在**锁里**、且在**这一轮用户消息之前**"
                     "（在锁外会与回复循环抢同一个会话文件；在用户轮之后 = 先答后问）")
        # 必须在 §5.5（引用上文）之前：折进来之后再问「上文在不在历史里」，那条问话就已经在了，
        # 同一个上文不会既进历史又进引用块 —— 引两遍是噪音，还会让模型以为问了两遍。
        out["B2"] = (fold_at < quote_at,
                     "`foldInto` 在**引用上文那一段之前**（否则同一个上文会既进历史又进引用块）")

    for cid, needle, why in [
        ("B10", "补记外发", "补了 N 条时记一行日志"),
        ("B11", "补记外发：无新增", "没有要补的时记一行**不同**的日志"),
        ("B12", "补记外发未测", "读数采不到时明说**未测**（不许与「没有要补的」同一句话）"),
    ]:
        out[cid] = (needle in agent, why)

    out["B13"] = (bool(re.search(r"outboundFold\.folded", agent)) and
                  bool(re.search(r"outbound\.\s*\{|outbound:\s*\{", agent)),
                  "折了几条**被用到了**（日志 + 返回给 daemon 的 meta）—— 算了不用等于没做")

    # ── send_once：不许自己建客户端 ──
    out["B14"] = ("new Lark.Client" not in send_once and not RAW_SEND_RE.search(send_once),
                  "send_once.mjs 不再自己建客户端/直连发送——走 agent/feishu.mjs 这一条物理层")
    out["B15"] = (bool(re.search(r"outbound\.recordSend\(", send_once)) and
                  bool(re.search(r"source:\s*'manual'", send_once)),
                  "手发的消息记了台账，且来源标成 manual")

    return out


def scan_failures(daemon: str, agent: str, send_once: str) -> list:
    return [k for k, (ok, _) in scan_wiring(daemon, agent, send_once).items() if not ok]


BACKUP_PATH_RE = re.compile(r"(^|/)(\.backups?|__pycache__|\.git)(/|$)|(^|/)[^/]*\.bak([.-]|$)|~$|\.orig$|\.swp$")


def is_backup_artifact(rel: str) -> bool:
    """备份 / 临时件 **不是活路径**（不会被 import、不会跑）⇒ 不参与「谁是发送者」的双向对齐。

    ★ 为什么单列这条（2026-10-14 实测）：`tools/.backups/batch-runner-media-…/batch_review_runner.mjs`
      是别会话留的**备份副本**，B16 一直把它当「表外的新发送者」报红，复核 C8 跟着红。
      把它登记进总表是**错的**：那会给一条**不会运行**的路径发通行证，
      而总表的用意恰恰是「每条**活**出口都要有人负责」。
      ⇒ 口径：**只登记活代码；备份件在扫描阶段就排除**，而不是靠总表豁免。
      反向对照见 C9（纯函数三例）与 C10（真造一遍：备份处不报、正常处必报）。
    """
    return bool(BACKUP_PATH_RE.search(rel or ""))


def scan_repo_senders(owners: dict | None = None, skip_backups: bool = True) -> dict:
    """全仓扫「谁能发消息」，与那张总表**双向**对齐。回 {检查号: (通过?, 说明)}。

    三件事分开报，因为它们坏起来的样子完全不同：
      · 表外出现了发送者 → 多了一条没记账的出口；
      · 表内的不再发送   → 白名单开始过期（掩护下一个偷偷加进来的）；
      · 标了「记账」的找不到那一行 → 「它在记账」只是一句声明。
    """
    table = SEND_OWNERS if owners is None else owners
    found = set()
    for p in sorted((ROOT / "tools").rglob("*.mjs")):
        if "node_modules" in p.parts:
            continue
        rel = p.relative_to(ROOT).as_posix()
        if skip_backups and is_backup_artifact(rel):
            continue
        src = strip_comments(read(p))
        if RAW_SEND_RE.search(src) or FEISHU_SEND_RE.search(src):
            found.add(rel)

    unknown = sorted(found - set(table))
    stale = sorted(set(table) - found)
    unrecorded = []
    for rel, spec in table.items():
        if spec.get("records") and spec["records"] not in read(ROOT / rel):
            unrecorded.append(rel)

    return {
        "B16": (not unknown,
                f"全仓能发消息的文件都在总表里（表外的：{unknown or '无'}；"
                f"共 {len(found)} 个）"),
        "B17": (not stale,
                f"总表里每一条都**还活着**（已经不发消息的：{stale or '无'}）"
                f"—— 过期的白名单会掩护下一个偷偷加进来的发送路径"),
        "B19": (not unrecorded,
                f"标了「记账」的文件里都**真的找得到**那一行记账代码"
                f"（找不到的：{unrecorded or '无'}）"),
    }


# ══════════════════════════════════════════════════════════════════════
# 读源码（B/C 段共用）
# ══════════════════════════════════════════════════════════════════════
daemon_raw, agent_raw, send_once_raw = read(DAEMON), read(AGENT), read(SEND_ONCE)
code_ok = bool(daemon_raw and agent_raw and send_once_raw)
daemon, agent, send_once = (strip_comments(daemon_raw), strip_comments(agent_raw),
                            strip_comments(send_once_raw))

# 真台账的指纹：**自证一个字节都不许写它**（§2.4.4）。末尾 E6 复核。
LEDGER_SHA_BEFORE = sha256(LEDGER)

# ══════════════════════════════════════════════════════════════════════
# A 段 · 判据本身（离线纯函数，台账指向临时目录）
# ══════════════════════════════════════════════════════════════════════
print("A 判据本身：什么该折进会话记忆、什么不该（离线，台账在临时目录）")

TMPDIR = Path(tempfile.mkdtemp(prefix="verify_outbound_"))
TMP_LEDGER = TMPDIR / "ws_outbound.jsonl"
MARKER = "VERIFY_OUTBOUND_SHOULD_NEVER_REACH_THE_REAL_LEDGER"

A_SCRIPT = """
import * as ob from './tools/agent/outbound.mjs';
const CHAT = 'oc_test';
const ledgerAtStart = ob.ledgerPath();     // 开头就记下 —— 末尾那次改 env 会把它指走
const put = (o) => ob.recordSend(o);
put({chatId: CHAT, messageIds: ['om_q1'], text: 'MARKER 问一句归谁', source: 'manual'});
put({chatId: CHAT, messageIds: ['om_rep'], text: '这是回复循环发的', source: 'reply'});
put({chatId: CHAT, messageIds: [], text: '这条没发出去', source: 'proactive-baseline', ok: false});
put({chatId: CHAT, messageIds: ['om_e'], text: '   ', source: 'manual'});
put({chatId: CHAT, messageIds: ['om_said'], text: '已经在记忆里的话', source: 'manual'});
put({chatId: 'oc_other', messageIds: ['om_x'], text: '别的群的话', source: 'manual'});
put({chatId: CHAT, messageIds: ['om_u'], text: '来源没登记的话', source: 'whoops'});
put({chatId: CHAT, messageIds: ['om_q2'], text: 'MARKER 第二句', source: 'manual'});

const sess = {key: 'chat_' + CHAT, messages: [{role: 'assistant', content: '已经在记忆里的话'}]};
const plan = ob.foldPlan(sess, CHAT);
const before = sess.messages.length;
const r1 = ob.foldInto(sess, CHAT);
const r2 = ob.foldInto(sess, CHAT);           // 幂等
const folded = sess.messages.slice(before).map((m) => ({
  role: m.role, content: m.content, at: m.at,
  ids: m.outbound?.message_ids ?? [], source: m.outbound?.source,
}));

// 「读不出台账」必须与「没有要补的」长得不一样
const broken = ob.foldPlan({key: 'k', messages: []}, CHAT, {maxBytes: 10});
// 「台账还不存在」：把路径改到一个没有文件的子目录（`ledgerPath()` 是惰性求值，改得动）
process.env.SHOUHENG_OUTBOUND_LEDGER = "__NOLEDGER__";
const noFile = ob.foldPlan({key: 'k', messages: []}, 'oc_never_seen');
delete process.env.SHOUHENG_OUTBOUND_LEDGER;

console.log(JSON.stringify({
  entries: plan.entries.map((e) => e.message_ids[0]),
  skipped: plan.skipped,
  untested: plan.untested,
  missing: plan.missing,
  foldedCount: r1.folded,
  againCount: r2.folded,
  againSkipped: r2.plan.skipped,
  folded,
  brokenUntested: broken.untested, brokenTruncated: broken.truncated,
  noFileMissing: noFile.missing, noFileUntested: noFile.untested, noFileEntries: noFile.entries.length,
  unknownSource: ob.SOURCES.includes('whoops'),
  // ★ 折/不折必须是 SOURCES 的**显式分类**（2026-09-22 加）：漏一个来源的后果不是「文档旧了」，
  //   而是它的消息要么被折两遍（补发 `resend` 正是这样撞上的：内核已 append 过回答，
  //   再折一次 = 同一个回答在记忆里出现两遍），要么永远进不了记忆（14:39 那次误答的那一半）。
  partition: {
    sources: [...ob.SOURCES],
    unclassified: [...ob.SOURCES].filter((s) => !ob.FOLDING.has(s) && !ob.NON_FOLDING.has(s)),
    both: [...ob.SOURCES].filter((s) => ob.FOLDING.has(s) && ob.NON_FOLDING.has(s)),
    ghost: [...ob.FOLDING, ...ob.NON_FOLDING].filter((s) => !ob.SOURCES.includes(s)),
  },
  unclassifiedCounted: plan.skipped.unclassified,
  alreadySaidSub: ob.alreadySaid([{role: 'assistant', content: '这个归我处理'}], '归我'),
  alreadySaidExact: ob.alreadySaid([{role: 'assistant', content: '归我'}], '归我'),
  alreadySaidUser: ob.alreadySaid([{role: 'user', content: '归我'}], '归我'),
  ledger: ledgerAtStart,
}));
"""

a_ok, a = run_node(A_SCRIPT.replace("__NOLEDGER__", str(TMPDIR / "no_such_dir" / "none.jsonl")),
                   ledger=TMP_LEDGER)
if not a_ok:
    cannot_test("A", f"跑不了 outbound.mjs：{a}")
    a = {}

if a:
    check("A1", a["entries"] == ["om_q1", "om_u", "om_q2"],
          "该折的是「主动推送的那几条」（含来源没登记的那条）—— "
          "回复类/发失败/空白/已在记忆里/别的群 都不折")
    check("A2", a["skipped"]["isReply"] >= 1,
          "**来源是 `reply` 的不折** —— 回复循环已经 append 过，再折一遍就是同一个回答出现两遍")
    check("A3", a["skipped"]["failed"] >= 1,
          "**`ok:false` 的不折** —— 发失败的消息没出现在群里，折进去等于让它「记得自己说过一句"
          "别人根本没看见的话」")
    check("A4", a["skipped"]["empty"] >= 1 and a["skipped"]["notThisChat"] >= 1,
          "空白正文不折；**别的群的不折**（`notThisChat` 真的会数 —— 恒为 0 的计数器不是读数）")
    check("A5", a["skipped"]["alreadySaid"] >= 1,
          "正文逐字已在记忆里的不折")
    check("A6", a["againCount"] == 0 and a["againSkipped"]["alreadyFolded"] >= 3,
          "**幂等**：同一份会话连折两次，第二次一条都不折（靠 `message_id` 认得出折过）")

    fl = a["folded"]
    check("A7", all(m["role"] == "assistant" for m in fl) and all(m["ids"] for m in fl),
          "折进来的是 `assistant` 轮，且带 `outbound.message_ids`（下次认得出、事后可审计）")
    check("A8", [m["content"] for m in fl] == ["MARKER 问一句归谁", "来源没登记的话", "MARKER 第二句"],
          "折进来的**顺序 = 台账文件顺序**（= 时间顺序），不是倒序也不是随机")
    check("A9", _at_matches_ledger(a["folded"], TMP_LEDGER),
          "`at` 用的是**发出那一刻**（台账里那一条的 `at`），不是「现在」"
          "—— 历史里的时间必须是真的，否则纪要/回溯全歪")
    check("A10", a["untested"] is None and a["missing"] is False,
          "台账读得出、没有坏行、没截断 → **不许报未测**（反向对照：未测不是恒有的）")
    check("A11", bool(a["brokenUntested"]) and a["brokenTruncated"] is True,
          "**只读了尾部 → 报未测**，不许当成「没有要补的」"
          "（后者正是 14:39 那次误答的形状：看不见 = 以为没有）")
    check("A12", a["noFileMissing"] is True and a["noFileEntries"] == 0,
          "台账还不存在 → `missing=true` 且 0 条（**与「读不出」分开**）")
    check("A13", a["unknownSource"] is False,
          "`whoops` 不在 SOURCES 里 —— 所以它会以 `unknown:whoops` 记进台账，"
          "而 H 段拿**真台账**断言这类值一个都不许有")
    check("A14", a["alreadySaidSub"] is False and a["alreadySaidExact"] is True and a["alreadySaidUser"] is False,
          "`alreadySaid` **只认逐字相等的 assistant 轮**：子串不算、用户轮不算"
          "—— 折记忆与「要不要引上文」两个判据刻意不同，两边判错的代价不对称")
    check("A15", Path(a["ledger"]).resolve() == TMP_LEDGER.resolve(),
          "**env 覆盖真的生效**：自证写的是临时台账，不是真台账（§2.4.4）")
    check("A16", TMP_LEDGER.exists() and TMP_LEDGER.read_text(encoding="utf-8").count("\n") == 8,
          "临时台账里恰好 8 行（8 次 recordSend 各一行）—— 不多不少")
    pa = a["partition"]
    check("A17", not pa["unclassified"] and not pa["both"] and not pa["ghost"],
          f"`SOURCES` 被 `FOLDING` / `NON_FOLDING` **恰好切成两半**（没分类的："
          f"{pa['unclassified'] or '无'}；两边都有的：{pa['both'] or '无'}；"
          f"表里有、`SOURCES` 里没有的：{pa['ghost'] or '无'}）—— "
          f"实测 {len(pa['sources'])} 个来源")
    check("A18", a["unclassifiedCounted"] >= 1 and "om_u" in a["entries"],
          "来源没分类的（`unknown:whoops`）**照样折**（它确实发到群里了）**且被计数**"
          "—— 漏分类既不静默通过，也不静默丢记忆")

# ══════════════════════════════════════════════════════════════════════
# B 段 · 装配真的接上了吗（静态，要求到达分支与赋值）
# ══════════════════════════════════════════════════════════════════════
print("\nB 装配真的接上了吗（读源码；要求**到达调用与赋值**，不是「名字出现过」）")

if not code_ok:
    cannot_test("B", "读不到 ws_daemon.mjs / agent.mjs / send_once.mjs 中的一个或多个")
else:
    for cid, (ok, msg) in scan_wiring(daemon, agent, send_once).items():
        check(cid, ok, msg)
for cid, (ok, msg) in scan_repo_senders().items():
    check(cid, ok, msg)

# source 字面量必须都在 SOURCES 里（打错一个字母会被记成 unknown:，只有 H 段能看出来）
_src_ok, sources = run_node("import * as ob from './tools/agent/outbound.mjs';"
                            "console.log(JSON.stringify(ob.SOURCES));", ledger=TMP_LEDGER)
if not _src_ok:
    cannot_test("B18", f"读不到 SOURCES：{sources}")
else:
    # ★ 两种写法都要收：对象字面量（`source: 'x'`）与**位置实参**（`safeSend(…, 'x')` /
    #   `replyTo(…, 'resend')`）。第一版只收前者 —— 而 2026-09-22 之后 daemon 的
    #   `replyTo` 改成了「来源是传进来的参数、字面量在形参默认值上」，于是它一个都收不到，
    #   报的是「实测 []」：**一个恒空的读数看起来像「干净」**。收不到必须与「没有」分开。
    used = set(re.findall(r"source:\s*'([^']+)'", daemon))
    for a in call_arg_texts(daemon, "safeSend"):
        if len(a) >= 3 and re.fullmatch(r"'[^']+'", a[2].strip()):
            used.add(a[2].strip().strip("'"))
    for a in call_arg_texts(daemon, "replyTo"):
        if len(a) >= 5 and re.fullmatch(r"'[^']+'", a[4].strip()):
            used.add(a[4].strip().strip("'"))
    bogus = sorted(used - set(sources))
    check("B18", bool(used) and not bogus,
          f"daemon 里写的 source（对象字段 + 位置实参两种写法）都在 SOURCES 里"
          f"（实测 {sorted(used)}；不在册的：{bogus or '无'}）")

# ══════════════════════════════════════════════════════════════════════
# C 段 · 反向对照：**同一个扫描器**扫坏样本，必须红
# ══════════════════════════════════════════════════════════════════════
print("\nC 反向对照：把源码改坏，B 段那些扫描器必须报红（全在内存里，不碰盘）")

if not code_ok:
    cannot_test("C", "没有源码，无法构造坏样本")
else:
    MUTATIONS = [
        ("C1", "B1",
         "补记那一步整个删掉（回到「出站不进记忆」的原样）",
         lambda d, g, s: (d, g.replace("      outboundFold = foldInto(sess, chatId);\n",
                                       "      outboundFold = {folded: 0, plan: {entries: [], untested: null}};\n"), s)),
        ("C2", "B2",
         "把补记挪到**引用上文那一段之后**（同一个上文会既进历史又进引用块）",
         lambda d, g, s: (d, g.replace("      outboundFold = foldInto(sess, chatId);\n", "", 1).replace(
             "    const userTurn = chatType === 'group'",
             "    outboundFold = foldInto(sess, chatId);\n    const userTurn = chatType === 'group'", 1), s)),
        ("C3", "B5",
         "`safeSend` 记账那行删掉（主动推送又不留痕了）",
         lambda d, g, s: (d.replace("    recordOutbound(chatId, sent, { text, source, chatType });", ""), g, s)),
        ("C4", "B6",
         "`replyTo` 记账挪到 return 之后（写成够不着的代码）",
         lambda d, g, s: (d.replace(
             "  recordOutbound(chatId, sent, { text, source, replyTo: messageId, chatType });\n  return sent;",
             "  return sent;\n  recordOutbound(chatId, sent, { text, source, replyTo: messageId });"), g, s)),
        ("C10", "B9",
         "`replyTo` 把 `source` 从记账那一行里漏掉（记成默认值以外的别的东西 / 记不上）",
         lambda d, g, s: (d.replace(
             "recordOutbound(chatId, sent, { text, source, replyTo: messageId, chatType })",
             "recordOutbound(chatId, sent, { text, replyTo: messageId, chatType })"), g, s)),
        ("C11", "B20",
         "补发那条出口改成**绕过 replyTo**（自己发 —— 于是它不留痕、也不走形态决策）",
         lambda d, g, s: (re.sub(
             r"send:\s*\(it,\s*text(?:,\s*opts)?\)\s*=>\s*replyTo\([^;]+\),",
             "send: (it, text) => feishu.sendMarkdown(it.chat_id, text),",
             d, count=1), g, s)),
        ("C5", "B7",
         "给 `safeSend` 的 source 加默认值（忘传也静默记成别的东西）",
         lambda d, g, s: (d.replace("async function safeSend(chatId, text, source, chatType = null)",
                                    "async function safeSend(chatId, text, source = 'manual', chatType = null)"), g, s)),
        ("C6", "B14",
         "`send_once.mjs` 改回自己 `new Lark.Client`（又一条不记账的通道）",
         lambda d, g, s: (d, g, "import * as Lark from '@larksuiteoapi/node-sdk';\n"
                                "const client = new Lark.Client({});\n"
                                "const r = await client.im.message.create({});")),
        ("C9", "B8",
         "`safeSend` 调用点少传一个参数（source 缺位 → 静默记成 unknown:）",
         # ★ 2026-09-23：这个模式此前匹配的是 `safeSend(target, …)`，而源码里那个变量
         #   早已改名成 `to` —— 于是 `replace` 什么也没替换，`d2 == d`，
         #   这条对照变成**空的**（`AGENTS.md` §2.4.1：「一条对照不响了，它就成了一句话」）。
         #   现在按**区分度最高的那一段**匹配（`, r.say, '<来源>');`），
         #   变量叫什么名字都不影响 —— 围着变量名写的假设正是它当初失效的原因。
         lambda d, g, s: (d.replace(", r.say, 'proactive-baseline');", ", r.say);"), g, s)),
    ]
    for cid, target, why, mutate in MUTATIONS:
        try:
            d2, g2, s2 = mutate(daemon, agent, send_once)
        except Exception as e:  # noqa: BLE001
            check(cid, False, f"坏样本「{why}」构造时抛了 {type(e).__name__}: {e}")
            continue
        if (d2, g2, s2) == (daemon, agent, send_once):
            check(cid, False, f"坏样本「{why}」**没能改到源码**（模式没匹配上）—— 这条对照是空的")
            continue
        failed = scan_failures(d2, g2, s2)
        check(cid, target in failed,
              f"坏样本「{why}」→ `{target}` 报红（实际报红：{failed or '一个都没有'}）")

    # 例外表：塞一条已经不发消息的文件进去，B17 必须红
    _bad_table = dict(SEND_OWNERS)
    _bad_table["tools/verify_cards.mjs"] = {"records": None, "why": "（坏样本：它根本不发消息）"}
    r_stale = scan_repo_senders(_bad_table)
    check("C7", not r_stale["B17"][0],
          "坏样本「例外表里塞一条已经不发消息的文件」→ B17 报红"
          "（否则这张表会变成一张过期的白名单，掩护下一个偷偷加进来的发送路径）")

    # 反向对照的反向对照：不去动源码时，扫描器必须全绿
    check("C8", scan_failures(daemon, agent, send_once) == []
                and scan_repo_senders()["B16"][0] and scan_repo_senders()["B17"][0],
          "**没改的真源码 → 一个都不报**（上面那些不是恒红）")

    # ★ 2026-10-14 加：备份件不算「活出口」（B16 当天就是被一份备份副本顶红的）
    check("C9", is_backup_artifact("tools/.backups/x/y.mjs")
                and is_backup_artifact("tools/agent/agent.mjs.bak-pre-parentfetch-20261009")
                and not is_backup_artifact("tools/agent/agent.mjs"),
          "纯函数三例：`.backups/` 目录 ｜ `.bak-` 后缀 ｜ **正常源码不受影响**")

    # C10 = 把缺陷**真造一遍**：备份处**不许**报、正常处**必须**报（否则「跳过」就成了恒绿的挡箭牌）
    _c10_ok, _c10_msg = False, "未跑"
    _bak = ROOT / "tools" / ".backups" / "__selftest__" / "fake_sender.mjs"
    _real = ROOT / "tools" / "__selftest_fake_sender.mjs"
    try:
        for _f in (_bak, _real):
            _f.parent.mkdir(parents=True, exist_ok=True)
            _f.write_text("client.im.message.create({ receive_id: chatId });\n", encoding="utf-8")
        _on = scan_repo_senders()
        _off = scan_repo_senders(skip_backups=False)
        _c10_ok = (not any("__selftest__" in m for m in _on["B16"][1].split("表外的：[")[-1].split("]")[0].split(", "))
                   and "__selftest_fake_sender.mjs" in _on["B16"][1]
                   and not _on["B16"][0]
                   and "__selftest__" in _off["B16"][1])
        _c10_msg = "备份处不报 ✅ ｜ 正常处必报 ✅" if _c10_ok else f"在线={_on['B16']} ｜ 关跳过={_off['B16']}"
    except Exception as _e:                                      # noqa: BLE001
        _c10_msg = repr(_e)
    finally:
        for _f in (_bak, _real):
            try:
                _f.unlink()
            except OSError:
                pass
        try:
            _bak.parent.rmdir()
        except OSError:
            pass
    check("C10", _c10_ok, "**反向对照（真造一遍）**：备份件不报、真源码必报 —— " + _c10_msg)

# ══════════════════════════════════════════════════════════════════════
# D 段 · 拿真实台账 + 真实会话跑一遍（回归测试）
# ══════════════════════════════════════════════════════════════════════
# ★ 历史遗留的「来源未登记」记录（2026-10-13 收）
#
#   台账是**流水账**：写进去的就是当时发生的事，**不许回改**（回改等于把审计线索抹掉）。
#   2026-10-05 那 9 条 `unknown:chain-ack` 是真事 —— 当天「送审回执」这个来源**还没登记进
#   `SOURCES`**（`outbound.mjs` 里留着那一刻的注释：字符串先用了，闭集随后才补上），
#   于是它们被**如实**记成了 unknown。这恰好说明闭集起了作用。
#
#   可 D7 的用意是「**发现新的**发送路径绕过 SOURCES」。9 条 8 天前的历史记录不构成这个
#   信号，却让 D7 天天红 —— 红久了就没人看了（同一个病本仓记过多次）。
#   ⇒ 口径收窄成：**该来源登记生效之后**还出现 unknown:，才算红。
#     边界取**实测值**：台账里第一条以登记名写下的时刻（不是随手挑的日期）。
#     反向对照见 D7b–D7d：同一条来源、时间挪到边界之后**必须红**。
LEGACY_UNKNOWN_SOURCES = {
    "unknown:chain-ack": "2026-10-05T23:46:24Z",
    # 2026-10-23 加 `chain-progress`（中途进度提示）时先用了字面量、2026-10-26 补进 SOURCES；
    # 登记前落下的 12 条（最晚 2026-10-26T10:36:19.193Z）是当时的真实记录，保留不回改。
    "unknown:chain-progress": "2026-10-26T10:36:20Z",
}


def unknown_source_problems(entries, legacy=None):
    """纯判据：把台账记录分成「新的未登记来源」与「登记生效前的历史遗留」。

    抽成纯函数是为了让反向对照能**离线喂合成台账**（§2.1：反向对照不落盘）。
    """
    legacy = LEGACY_UNKNOWN_SOURCES if legacy is None else legacy
    fresh, n_legacy = [], 0
    for e in entries:
        src = str(e.get("source", ""))
        if not src.startswith("unknown:"):
            continue
        cut = legacy.get(src)
        if cut and str(e.get("at") or "") < cut:
            n_legacy += 1
        else:
            fresh.append(e)
    return fresh, n_legacy


# ══════════════════════════════════════════════════════════════════════
print("\nD 回归：拿 2026-09-22 那次误答的真实数据跑一遍，被答的那句话必须不再缺席")

if OFFLINE:
    cannot_test("D", "`--offline`：没读真台账/真会话")
elif not LEDGER.exists():
    cannot_test("D1", f"台账还不存在（{LEDGER.relative_to(ROOT)}）—— 跑一次 "
                      f"`node tools/outbound_ledger.mjs --backfill <id>` 或等守衡重启后发一条")
elif not INCIDENT_SESSION.exists():
    cannot_test("D", f"读不到会话档 {INCIDENT_SESSION.relative_to(ROOT)}")
else:
    entries = None
    try:
        entries = [json.loads(x) for x in LEDGER.read_text(encoding="utf-8").splitlines() if x.strip()]
    except (OSError, json.JSONDecodeError) as e:
        cannot_test("D1", f"真台账读不出：{type(e).__name__}: {e}")

    if entries is not None:
        by_id = {}
        for e in entries:
            for mid in e.get("message_ids") or []:
                by_id[mid] = e
        check("D1", len(entries) > 0,
              f"真台账读得出，共 {len(entries)} 条")
        check("D2", INCIDENT_OUR_MSG in by_id and INCIDENT_OUR_FIX in by_id,
              "台账里有 14:37:55 那一问与 15:03:11 那条更正（`om_x100b64166aff…` / `om_x100b6416cc30…`）"
              "—— 修复之前这两条在盘上零痕迹")
        for mid, prefix in INCIDENT_AT_PREFIX.items():
            got = (by_id.get(mid) or {}).get("at") or ""
            check(f"D3 {mid[-6:]}", got.startswith(prefix),
                  f"{mid[-6:]} 的时刻是**接口读出来的** {prefix}…（实测 {got or '（没有这条）'}）"
                  f"—— 文档里那两个时刻原先是我手抄的")

        # ★ 本段最有价值的一条：把事故的原样输入喂回去
        sess = json.loads(INCIDENT_SESSION.read_text(encoding="utf-8"))
        sq = lambda s: re.sub(r"\s+", "", str(s or ""))  # noqa: E731
        frag0 = re.sub(r"\s+", "", INCIDENT_QUESTION_FRAGMENT)
        in_session = any(frag0 in sq(m.get("content")) for m in sess.get("messages") or [])
        script = f"""
import fs from 'node:fs';
import * as ob from './tools/agent/outbound.mjs';
const sess = JSON.parse(fs.readFileSync({json.dumps(str(INCIDENT_SESSION))}, 'utf8'));
const plan = ob.foldPlan(sess, {json.dumps(INCIDENT_CHAT)});
console.log(JSON.stringify({{
  folded: plan.entries.map((e) => e.text),
  ids: plan.entries.flatMap((e) => e.message_ids ?? []),
  untested: plan.untested, missing: plan.missing,
}}));
"""
        ok_d, d = run_node(script)      # 不传 ledger：读**真台账**，只读
        if not ok_d:
            cannot_test("D4", f"跑不了 foldPlan：{d}")
        else:
            # 两边都要 squash —— 第一版只 squash 了正文，带空格的搜索串永远搜不到，
            # 于是 D4 在「明明补记清单里就有那一句」的情况下报红。
            frag = sq(INCIDENT_QUESTION_FRAGMENT)
            in_plan = any(frag in sq(t) for t in d["folded"])
            check("D4", in_session or in_plan,
                  f"**把事故原样喂回去**：14:37 那句问话「已在会话记忆里」或「在补记清单里」"
                  f"（实测：在记忆里={in_session}／在补记里={in_plan}／补记条数={len(d['folded'])}）"
                  f"—— 两处都缺席就是 14:39 那次误答会原封不动再来一遍"
                  + ("　⚠ 注意：**代码已落盘、未重启**，此刻它在「补记清单」里而不是记忆里"
                     if (not in_session and in_plan) else ""))
            check("D5", d["missing"] is False and d["untested"] is None,
                  "真台账读得出、没有坏行 → 不许报未测")

    if entries is not None:
        # D7：台账里不许出现「来源没登记」—— 那是有人加了发送路径却忘了在 SOURCES 里登记。
        # 这类记录**照样会折进记忆**（宁可记住也不要丢），但它意味着发送面在悄悄长大。
        unknown, n_legacy = unknown_source_problems(entries)
        check("D7", not unknown,
              (f"真台账里没有**新的**来源未登记记录（实测 0 条；另有 {n_legacy} 条历史遗留 —— "
               f"写在来源登记生效之前，台账不回改，见 LEGACY_UNKNOWN_SOURCES）")
              if not unknown else
              f"真台账里有 {len(unknown)} 条 source=unknown:… —— 有发送路径没登记来源："
              f"{sorted({e.get('source') for e in unknown})}"
              + (f"（另有 {n_legacy} 条历史遗留不计）" if n_legacy else ""))

        # D7b–D7d ★ 收窄口径**不许**变成免罪符：喂合成台账，证明这一刀只切历史。
        for _cid, _name, _rows, _want_fresh in [
            ("D7b", "历史遗留（登记生效**前**）→ 不算红",
             [{"source": "unknown:chain-ack", "at": "2026-10-05T02:16:16Z"}], 0),
            ("D7c", "★ 同一条来源、时间挪到登记生效**之后** → 必须红",
             [{"source": "unknown:chain-ack", "at": "2026-10-06T00:00:00Z"}], 1),
            ("D7d", "★ 表外的**新**来源（时间再早也不放过）→ 必须红",
             [{"source": "unknown:whoops", "at": "2026-01-01T00:00:00Z"}], 1),
        ]:
            _fresh, _leg = unknown_source_problems(_rows)
            check(_cid, len(_fresh) == _want_fresh,
                  f"{_name}（新的 {len(_fresh)} 条 / 期望 {_want_fresh}；历史 {_leg} 条）")

        # D8：台账里**不应该**出现「发失败的回复」被当成发出去的话 —— 折记忆那一侧由 A3 保证，
        # 这里断言台账自己把 ok 标出来了（否则 A3 那个判据在真实数据上无从下手）。
        noflag = [e for e in entries if "ok" not in e]
        check("D8", not noflag,
              f"台账每条都带 `ok` 字段（实测缺 {len(noflag)} 条）—— 没有它，"
              f"「这条到底发出去没有」只能靠猜，而折记忆正是靠它决定折不折")

# ══════════════════════════════════════════════════════════════════════
# G 段 · 读回正文：post / interactive / text 各自读得对不对
# ══════════════════════════════════════════════════════════════════════
print("\nG 读回正文：post / interactive / text（喂真实 payload）")

# 这两段 payload 是 2026-09-22 **从飞书原样回读**的（`GET /im/v1/messages/{id}`）
REAL_POST = json.dumps({
    "title": "", "content": [[{"tag": "text", "text": "我这边调用模型失败了，没法回答这个问题。", "style": []}],
                             [{"tag": "text", "text": " ", "style": []}],
                             [{"tag": "text", "text": "失败原因：网络错误: fetch failed", "style": []}]],
}, ensure_ascii=False)
REAL_CARD_STUB = json.dumps({
    "title": "已收到",
    "elements": [[{"tag": "img", "image_key": "img_v3_02ad_x"},
                  {"tag": "text", "text": "请升级至最新版本客户端，以查看内容"},
                  {"tag": "text", "text": ""}]],
}, ensure_ascii=False)

G_SCRIPT = f"""
import * as feishu from './tools/agent/feishu.mjs';
const out = {{
  post: feishu.bodyToText('post', {json.dumps(REAL_POST)}),
  cardStub: feishu.bodyToText('interactive', {json.dumps(REAL_CARD_STUB)}),
  cardReal: feishu.bodyToText('interactive', JSON.stringify({{header: {{title: {{content: '收据'}}}},
      elements: [{{tag: 'div', text: {{content: '三条过期内容归对接人处置'}}}}]}})),
  text: feishu.bodyToText('text', JSON.stringify({{text: '归我'}})),
  file: feishu.bodyToText('file', JSON.stringify({{file_key: 'x'}})),
  badPost: feishu.bodyToText('post', 'not json'),
}};
console.log(JSON.stringify(out));
"""
g_ok, g = run_node(G_SCRIPT, ledger=TMP_LEDGER)
if not g_ok:
    cannot_test("G", f"跑不了 feishu.mjs：{g}")
else:
    check("G1", g["post"]["parsed"] and "失败原因：网络错误" in (g["post"]["text"] or ""),
          "**真实 post payload 逐字读得出来** —— 在修之前，守衡读自己的历史时这里显示的是"
          "「我没法看到里面的内容」（而 `sendMarkdown` 发的**全是 post**）")
    check("G2", g["cardStub"]["parsed"] is False and "请升级至最新版本客户端" not in (g["cardStub"]["text"] or "")
                and "已收到" in (g["cardStub"]["note"] or ""),
          "卡片存根**不被当成内容交出去**，且说清「接口不返回卡片正文」+ 报出能读到的标题"
          "—— 把占位文案当卡片内容，比说「看不到」更坏：**它看起来像内容**")
    check("G3", g["cardReal"]["parsed"] and "非逐字原文" in (g["cardReal"]["text"] or "")
                and "三条过期内容归对接人处置" in (g["cardReal"]["text"] or ""),
          "真含文字结构的卡片 → 重建出来，且**标明是重建**（卡片存的是结构，不是一段正文）")
    check("G4", g["text"]["text"] == "归我" and g["text"]["parsed"], "text 类型照旧读得出")
    check("G5", g["file"]["parsed"] is False and "不取" not in (g["file"]["text"] or ""),
          "附件类型在这里报「没有正文读取通道」—— 附件那句「按规矩不取」由调用方给（见 "
          "verify_cards.mjs N 段），这里不抢它的话")
    check("G6", g["badPost"]["parsed"] is False and bool(g["badPost"]["note"]),
          "解析失败 → `parsed:false` 且带原因（**与「解析出来是空的」分开**，§2.4.1 第 1 行）")

    # 两个读取入口必须走**同一份**解析（两处各写一份 = 同一个形状两个实现，必然漂移）
    c_get = len(re.findall(r"bodyToText\(", strip_comments(read(FEISHU))))
    check("G7", c_get >= 3,
          f"`feishu.mjs` 里 `bodyToText` 被调用 {c_get} 次（定义 1 + 两个读取出口）"
          f"—— 保证 `getMessage` 与 `listRecentMessages` 用同一份解析")

# ══════════════════════════════════════════════════════════════════════
# E 段 · 结论行自己不许撒谎 + 自证不许改真数据
# ══════════════════════════════════════════════════════════════════════
print("\nE 结论行自己不许撒谎（未测 ≠ 通过 ≠ 红）+ 自证没有写真实台账")

check("E1", verdict(0, 0)[0] == 0, "全过 → 退 0")
check("E2", verdict(3, 0)[0] == 1, "有红 → 退 1")
check("E3", verdict(0, 2)[0] == 2, "**有未测 → 退 2**（不许当成通过）")
check("E4", "未测" in verdict(0, 1)[1] and "✅" not in verdict(0, 1)[1],
      "未测的文案说「未测」且不带 ✅（不把没测说成没问题）")
check("E5", "未测" in verdict(2, 1)[1],
      "**有红时也必须报出有未测** —— 否则只看最后一行的人会以为「其余都验过了」")

# E6：自证写的东西一个字节都不许落到真台账上（§2.4.4：自证有副作用比没有自证更糟）
real_txt = read(LEDGER)
check("E6", MARKER not in real_txt,
      "自证用的标记串**没有出现在真台账里**（八次 recordSend 全落在临时目录）")
if sha256(LEDGER) == LEDGER_SHA_BEFORE:
    check("E7", True, f"真台账在本次自证期间**一个字节都没变**"
                      f"（sha256 {str(LEDGER_SHA_BEFORE)[:12] if LEDGER_SHA_BEFORE else '（台账还不存在）'}…）")
else:
    # 变了不一定是自证干的（守衡重启后可能真的发了消息）—— 所以只报**未测**，
    # 并说清怎么分辨。把这种情形判成红，就是 §2.1.1 那种「会误报的检查器」。
    cannot_test("E7", "真台账在本次自证期间变了（sha256 前后不一致）—— 可能是守衡真的发了消息"
                      "（重启后）也可能是自证写到了真数据。分辨方法：看台账最后一条的来源与时刻，"
                      "E6 已单独断言自证的标记串不在里面")

shutil.rmtree(TMPDIR, ignore_errors=True)

# ══════════════════════════════════════════════════════════════════════
# H 段 · 台账里的 markdown 星号：按**发送形态**分账（2026-10-14 Owner 拿私聊截图来问）
# ══════════════════════════════════════════════════════════════════════
# 起因：Owner 在私聊里看到的回答是 `1. **能查的我查完再说** —— …`，星号**字面**显示出来。
#
# 真因（可复算）：`replyMarkdown()`（「回复某条消息」那条路，**最常走**的一条）
# 把 markdown 原文直接塞进 `msg_type: 'text'`，一个字都不转；而
# `sendMarkdown()` 那条路转富文本(post)，本来就干净。
# ⇒ 台账里 24 条 `mode: 'reply'` **全部**带星号；`mode: 'text'` 1 条（2026-09-30 一条降级告警）。
#
# ★ 这一段的判据按**发送形态**分账，因为「台账里有没有星号」**不等于**
#   「对方看到没看到星号」：
#     · `post` —— 正文被转成 bold 节点，`**` **不会**字面显示（台账存的是原文，故带星号是正常的）；
#     · `card` / `reply-card` —— 卡片正文用 markdown 渲染（卡片模版里本来就有加粗标签）；
#     · `reply` / `text` —— **飞书按纯文本渲染**，星号会**字面显示** ⇒ 这一类必须为 0。
#   把四类混在一起数，会得出一个既吓人又不准的数（实测「492 条」），
#   而它指不出该修哪儿 —— §2.4.1 那个病的形状。
#
# ★ 想同时收掉卡片那一半（`reply-card` 340 条，含回执卡里那句
#   `本次按**美国市场**口径审查`）是**另一个决定**：卡片 markdown 的加粗是渲染得出来的，
#   摘掉它等于把卡片正文的加粗一起去掉。**Owner 未定，故这里只报读数、不判红。**
print("\nH 台账里的 markdown 星号：按发送形态分账（纯文本那两类必须为 0）")

# 纯文本形态：飞书把它们按字面渲染 ⇒ 星号会被看见
LITERAL_TEXT_MODES = ("reply", "text", "reply-text")


def asterisk_by_mode(entries):
    """纯判据：把台账按发送形态分账，回 (带星号条数, 各形态总数, 该修的那几条)。

    「该修的那几条」的口径（★ 这一条是踩过坑才定下来的）：
      纯文本形态（飞书**按字面渲染**）**且**台账正文带 `**` **且**这条记录说得出
      「我摘过」时**不算**泄漏 —— 因为台账存的是模型原文，摘符号在发送那一跳发生。
      判据要断的是**投递事实**：`extra.delivery.starsRemoved`（daemon 记的读数）。
      **没有这个读数**又不干净 ⇒ 才是真的要修。
    """
    counts, totals = {}, {}
    for e in entries:
        mode = str(e.get("mode") or "?")
        totals[mode] = totals.get(mode, 0) + 1
        if "*" in str(e.get("text") or ""):
            counts[mode] = counts.get(mode, 0) + 1

    def stars_in_text(e):
        return "*" in str(e.get("text") or "")

    def delivery(e):
        d = ((e.get("extra") or {}).get("delivery") or {})
        return d if isinstance(d, dict) else {}

    literal_hits = [e for e in entries
                    if str(e.get("mode") or "") in LITERAL_TEXT_MODES
                    and stars_in_text(e)
                    and not (delivery(e).get("starsRemoved") or 0) > 0]
    return counts, totals, literal_hits


if OFFLINE:
    cannot_test("H", "`--offline`：没读真台账")
elif not LEDGER.exists():
    cannot_test("H1", "台账还不存在 —— 没法按形态分账")
else:
    try:
        _h_entries = [json.loads(x) for x in LEDGER.read_text(encoding="utf-8").splitlines() if x.strip()]
    except (OSError, json.JSONDecodeError) as e:
        cannot_test("H1", f"真台账读不出：{type(e).__name__}: {e}")
    else:
        _counts, _totals, _literal = asterisk_by_mode(_h_entries)
        _render = " ｜ ".join(f"{m}={_counts.get(m, 0)}/{_totals.get(m, 0)}" for m in sorted(_totals))
        # H1：纯文本形态那两类，**修复之后**不许再有新的（历史那 25 条留着，台账不回改）
        _traced = [e for e in _literal if str(e.get("at") or "") >= STAR_FIX_AT]
        check("H1", not _traced,
              f"纯文本形态（{'/'.join(LITERAL_TEXT_MODES)}，飞书按字面渲染）里，"
              f"**说不清「摘没摘」的带星号记录**一条都没有（历史 {len(_literal) - len(_traced)} 条豁免；"
              f"分界线后仍说不清的有 {len(_traced)} 条，最晚 "
              f"{max((str(e.get('at')) for e in _traced), default='（无）')}）"
              f" —— 判定口径：台账正文干净 **或** 记着 `extra.delivery.starsRemoved`"
              f"（台账存原文、摘符号在发送那一跳，两者不是一回事）")
        # H2：分账读数本身要**看得出来是哪几类**（否则「492 条」这种数指不出该修哪儿）
        check("H2", bool(_totals),
              f"按发送形态分账读得出：{_render}（post / card 走渲染，`**` 不会字面显示；"
              f"纯文本形态才会）")
        # H3：反向对照 —— 判据自己会红（喂一条修复之后的假记录）
        _fake = [{"at": "2099-01-01T00:00:00Z", "mode": "reply", "text": "**新的泄漏**"}]
        _c2, _t2, _l2 = asterisk_by_mode(_fake)
        check("H3", len(_l2) == 1,
              "反向对照：喂一条「修复之后、reply 形态、带星号、**没有投递读数**」的假记录 "
              "→ 判据必须认出来（否则 H1 恒真）")
        # H5：反向对照的另一面 —— 同一条记录**带上**投递读数就不该判红（否则判据会误报真身）
        _fake2 = [{"at": "2099-01-01T00:00:00Z", "mode": "reply", "text": "**摘过了**",
                   "extra": {"delivery": {"starsRemoved": 4, "sentHasStar": False}}}]
        _c5, _t5, _l5 = asterisk_by_mode(_fake2)
        check("H5", len(_l5) == 0,
              "反向对照：带 `extra.delivery.starsRemoved` 的记录**不算**泄漏 "
              "—— 不然「台账存原文」这件事会让判据天天误报（第一版就误报过）")
        # H4：反向对照 —— post 形态**不算**泄漏（这就是分账的理由）
        _c3, _t3, _l3 = asterisk_by_mode([{"at": "2099-01-01T00:00:00Z", "mode": "post", "text": "**a**"}])
        check("H4", len(_l3) == 0,
              "反向对照：post 形态带星号**不算**泄漏（正文转 bold 节点，不字面显示）"
              "—— 混在一起数会把这条判成红的，那是误报")

# ── 结论 ────────────────────────────────────────────────────────────────
n_fail = sum(1 for _, ok, _ in results if not ok)
print("\n" + "=" * 74)
for cid, ok, msg in results:
    print(f"  {'✅' if ok else '❌'} {cid}  {msg}")
for cid, msg in untested:
    print(f"  ⚠ {cid}  {msg}")
print("=" * 74)
_code, _line = verdict(n_fail, len(untested))
print(_line)
print(f"   （共 {len(results)} 项断言，{n_fail} 项红，{len(untested)} 项未测）")
sys.exit(_code)

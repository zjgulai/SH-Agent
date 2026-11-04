#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
verify_reply_context.py —— 「这条消息在回复哪一句」有没有真的被接上

要验的东西（一句话）：**当有人在话题里回守衡一句短话时，守衡看得见自己在答什么吗？**

它守的是一次**真实的外部误答**（2026-09-22，全过程见 `PMO/守衡-误答登记-20260922.md`）：

```
14:37:55  我方主动推送问「117 条签核归谁？」
14:39:34  她在【话题里】回「归我」   ← 事件里 parent_id / root_id 都指着我方那条
14:39:51  守衡答「收到，那三条过期内容归你」  ← 答非所问，发出去了
```

根因两条，这个检查器管**第二条**：
`ws_daemon.mjs` 的 `onMessage` 从不读 `parent_id` / `root_id` ——
**飞书把线索完整送来了，是我们丢的**。
（第一条「主动推送不进会话记忆」**已于 2026-09-22 晚修**，执行点是
`tools/verify_outbound.py`；它**仍然不在本检查器范围内** —— 两个器各守一条根因，别互相代证。）

---

## 各段在验什么

| 段 | 验什么 | 靠什么 |
|---|---|---|
| **A** | 判据本身对：什么算「有上文」、什么不算 | 跑 `agent/thread.mjs` 的纯函数（**离线**，无网络无凭据） |
| **B** | 判据**真的接在链路上**了 | 读 `agent.mjs` 源码，要求**到达分支与赋值**，不是「名字出现过」 |
| **C** | B 段那些扫描器**自己会红** | 在内存里把源码改坏，同一个扫描器必须报红 |
| **D** | 拿**真实那一条事件**跑一遍，必须还原出被答的那句话 | 事件日志 + 一次只读回读 |
| **E** | 结论行自己不许撒谎 | `verdict()` 纯函数 |

## 已知盲区（明着留着，别当成已经证过）

* **B/C 是静态的。** 它们证明「源码里有分支、有赋值、坏样本会被抓到」，
  **不证明**那段代码在运行时真的被走到 —— 走到它需要一条真话题回复。
  运行时那一半由 **D 段**用真实事件顶住；但 D 段只覆盖「回读得到」这一条路径，
  **覆盖不到「回读失败」那一支**（要等一次真的读不到才会被走到）。
* **D 段要联网。** 联不上 → 报 ⚠ 未测、**退 2**，不许当成通过（与 §2.4.2 的 L3 同口径）。
* **它不验「主动推送进不进会话记忆」**（根因一）。那一条**已于 2026-09-22 晚修好**
  （代码在盘上、未生效），执行点在 `tools/verify_outbound.py` ——
  **两个器各守一条根因，谁变绿都不给另一条作证**。
  当时的登记见 `PMO/守衡-误答登记-20260922.md` §3.1 与 §八。

用法：
  python3 tools/verify_reply_context.py            # 全跑（含 D 段的只读回读）
  python3 tools/verify_reply_context.py --offline  # 跳过 D 段 → D 记未测，退 2
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
AGENT = ROOT / "tools" / "agent" / "agent.mjs"
FEISHU = ROOT / "tools" / "agent" / "feishu.mjs"
EVENTS = ROOT / "PMO" / "logs" / "ws_events.jsonl"

# 本次事故那两条真实消息（读数取自 PMO/logs/ws_events.jsonl，逐字）
INCIDENT_HER_MSG = "om_x100b641664a9a4b0ddae530b0285118"      # 她：「@守衡 归我」
INCIDENT_OUR_MSG = "om_x100b64166aff2ca8b487459d2f76acb"      # 我方：117 条签核那一问
INCIDENT_QUESTION_FRAGMENT = "117 条的拆分方案"

results = []   # (id, ok, msg)
untested = []  # (id, msg)


def check(cid, ok, msg):
    results.append((cid, bool(ok), msg))
    return bool(ok)


def cannot_test(cid, msg):
    """采不到证据时用它。`check(cid, True, ...)` 是把没测说成没问题（§2.4.2 明令禁止）；
    `check(cid, False, ...)` 是把没测冤枉成坏了（§2.4.1 第 5 行）。
    未测必须与通过与红**都长得不一样**。"""
    untested.append((cid, msg))


def verdict(n_fail, n_untested):
    """结论行拆成纯函数，好让 E 段直接断言「这句话不许撒谎」。

    0 = 全过 ｜ 1 = 有红 ｜ 2 = **有未测**（既不是通过，也不是红）
    """
    if n_fail:
        tail = f"；另有 {n_untested} 项未测（见 ⚠ 行）" if n_untested else ""
        return 1, f"❌ {n_fail} 项红{tail}"
    if n_untested:
        return 2, f"⚠ {n_untested} 项未测 —— 这不是通过（退 2，与 §2.4.2 同口径）"
    return 0, "✅ 全过"


def run_node(script: str, timeout=30):
    """跑一段 ESM，要求它把结果打成 JSON。回 (ok, 解析后的对象或错误串)。"""
    try:
        p = subprocess.run(["node", "--input-type=module", "-e", script],
                           cwd=str(ROOT), capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError:
        return False, "找不到 node"
    except subprocess.TimeoutExpired:
        return False, f"node 超时（{timeout}s）"
    if p.returncode != 0:
        return False, (p.stderr or p.stdout).strip()[:400]
    try:
        return True, json.loads(p.stdout.strip().splitlines()[-1])
    except (json.JSONDecodeError, IndexError):
        return False, f"node 没打出可解析的 JSON：{p.stdout.strip()[:200]}"


def strip_comments(src: str) -> str:
    """去掉整行与行尾 `//` 注释再扫。

    不这么做，**解释这个分支的注释会把判据自己骗过去** ——
    §2.4.4 记着这件事：那个判据的第三版就是被它自己的解释文字绊倒的。
    （已知盲区：字符串字面量里的 `//` 也会被切掉；本文件里没有这种字面量。）
    """
    return "\n".join(re.sub(r"//.*$", "", ln) for ln in src.splitlines())


# ══════════════════════════════════════════════════════════════════════
# B 段用的扫描器 —— 抽成函数，好让 C 段拿同一个扫描器去扫坏样本
# ══════════════════════════════════════════════════════════════════════
def scan_wiring(code: str) -> dict:
    """扫 `agent.mjs`（已去注释）。回 {检查号: (通过?, 说明)}。

    ★ 判据刻意要求**到达分支与赋值**，不是「标识符出现过」——
      §2.4 点名的那个病（`MAX_SECTIONS` 只出现在 import 行，J1 却是绿的）
      在防它的判据里活了下来。一条只查名字的断言，在有 import / re-export 的地方**恒真**。
    """
    out = {}

    out["B1"] = (bool(re.search(r"const\s+parentId\s*=\s*parentIdOf\(\s*msg\s*\)", code)),
                 "`parentId` 由 `parentIdOf(msg)` 算出并绑定")

    out["B2"] = (bool(re.search(r"if\s*\(\s*parentId\s*\)", code)),
                 "`parentId` **真的进了条件分支**（只是在源码里出现过不算）")

    out["B3"] = (bool(re.search(r"await\s+feishu\.getMessage\(\s*parentId\s*\)", code)),
                 "拿它去 `feishu.getMessage(...)` 回读，且传的是同一个变量")

    out["B4"] = (bool(re.search(r"alreadyInHistory\(sess\.messages,\s*parent\.text\)", code)),
                 "回读到的正文过一遍 `alreadyInHistory` 去重")

    err_branch = re.search(r"if\s*\(\s*parent\?\.error\s*\)\s*\{(.*?)\n\s*\}\s*else", code, re.S)
    if not err_branch:
        out["B5"] = (False, "有独立的「回读失败」分支（与「不是回复」分开）")
    else:
        body = err_branch.group(1)
        out["B5"] = (True, "有独立的「回读失败」分支（与「不是回复」分开）")
        out["B6"] = ("parentBlock" in body,
                     "**失败分支里也赋了 `parentBlock`** —— 不许悄悄退回「没有上文」"
                     "（那正是 14:39 那次误答的成因）")
        out["B7"] = ("未测" in body, "失败分支明说「未测」，不把读不到说成没问题")

    out["B8"] = (bool(re.search(r"引用上文未测", code)) and
                 bool(re.search(r"引用上文跳过", code)) and
                 bool(re.search(r"↩\s*引用上文", code)),
                 "三种情形在日志里各有一句且互不相同（未测 / 跳过 / 引了）")

    out["B9"] = (bool(re.search(r"parentBlock\s*\?\s*`\$\{parentBlock\}\\n\\n\$\{userTurn\}`\s*:\s*userTurn", code)),
                 "`parentBlock` **接进了这一轮的 `userTurn`**（拼出来却不 append 等于没做）")

    return out


def scan_feishu(code: str) -> dict:
    """扫 `feishu.mjs`（已去注释）：那一次回读本身对不对。

    ★ 这一半是 §2.4.1 说的「接口调通了、`code=0`、没报错，但字段名/口径读错了」。
      `message.get` 返回的是 `data.items[]`（与 `message.list` 同形状）——
      按 `data.message` 读会拿到 `undefined`，**而且不报错**。
      最像事故的是最后一条：批量接口的「0 张表」就是这么来的。
    """
    out = {}

    out["B10"] = (bool(re.search(r"export\s+async\s+function\s+getMessage\s*\(", code)),
                  "`feishu.mjs` 导出了 `getMessage`（按 id 回读单条）")

    out["B11"] = (bool(re.search(r"client\.im\.message\.get\(\s*\{\s*path:\s*\{\s*message_id", code)),
                  "走的是 `client.im.message.get({ path: { message_id } })`")

    out["B12"] = (bool(re.search(r"r\?\.data\?\.items\s*\?\?\s*\[\]", code)),
                  "**从 `data.items[]` 取，不是 `data.message`** —— 取错形状不报错，只会静默拿到空")

    out["B13"] = (bool(re.search(r"items\.length\s*\)?\s*\{[^}]*error", code, re.S)),
                  "**`code=0` 但 items 为空时报 error**，不静默当成「内容是空的」"
                  "（§2.4.1 第 1 行那个坑：core 层「0 张表」）")

    out["B14"] = (bool(re.search(r"items\[0\]", code)),
                  "真的取了那一条并解析正文（拿到数组却不用，等于没读）")

    return out


def scan_failures(code: str, feishu_code: str = "") -> list:
    """回「没过的那些」检查号。两半都扫 —— 只扫一半会让 C 段的反向对照漏掉 feishu 那几条。"""
    bad = [k for k, (ok, _) in scan_wiring(code).items() if not ok]
    if feishu_code:
        bad += [k for k, (ok, _) in scan_feishu(feishu_code).items() if not ok]
    return bad


# ══════════════════════════════════════════════════════════════════════
# A 段 · 判据本身（离线纯函数）
# ══════════════════════════════════════════════════════════════════════
print("A 判据本身：什么算「有上文」（离线纯函数，不碰网络）")

a_ok, a_out = run_node("""
import { parentIdOf, alreadyInHistory } from './tools/agent/thread.mjs';
const out = {
  real:      parentIdOf({ message_id: 'om_her', parent_id: 'om_our', root_id: 'om_our' }),
  prefersParent: parentIdOf({ message_id: 'x', parent_id: 'om_parent', root_id: 'om_root' }),
  fallbackRoot:  parentIdOf({ message_id: 'x', root_id: 'om_root' }),
  notReply:  parentIdOf({ message_id: 'x' }),
  selfRef:   parentIdOf({ message_id: 'x', parent_id: 'x' }),
  emptyStr:  parentIdOf({ message_id: 'x', parent_id: '   ' }),
  noMsg:     parentIdOf(null),
  inHistGroup: alreadyInHistory([{ role: 'user', content: '【对接人】归我' }], '归我'),
  inHistP2P:   alreadyInHistory([{ role: 'user', content: '归我' }], '归我'),
  inHistBot:   alreadyInHistory([{ role: 'assistant', content: '收到，那三条归你。' }], '收到，那三条归你。'),
  notInHist:   alreadyInHistory([{ role: 'user', content: '【对接人】归我' }], '那三条过期内容'),
  substringNotHit: alreadyInHistory([{ role: 'user', content: '【李】这个归我处理' }], '归我'),
  toolNotCounted:  alreadyInHistory([{ role: 'tool', content: '归我' }], '归我'),
};
console.log(JSON.stringify(out));
""")

if not a_ok:
    cannot_test("A", f"跑不了 thread.mjs 纯函数：{a_out}")
else:
    check("A1", a_out["real"] == "om_our",
          "真实事件形状 → 取到被回复的那一条（`parent_id`）")
    check("A2", a_out["prefersParent"] == "om_parent",
          "**优先 `parent_id` 而不是 `root_id`** —— 两者不同值时取直接父级"
          "（本次事故里两者恰好同值，别把巧合当等价）")
    check("A3", a_out["fallbackRoot"] == "om_root",
          "只有 `root_id` 时退而用它（反向对照：A2 不是恒出 `om_parent`）")
    check("A4", a_out["notReply"] is None, "不是回复 → None")
    check("A5", a_out["selfRef"] is None,
          "**指向自己 → None**（否则会自己引用自己）")
    check("A6", a_out["emptyStr"] is None, "空白串 → None（不当成一条消息 id）")
    check("A7", a_out["noMsg"] is None, "消息对象都没有 → None（不抛）")
    check("A8", a_out["inHistGroup"] and a_out["inHistP2P"] and a_out["inHistBot"],
          "已在会话历史里（群「【名字】正文」/ 私聊 / 机器人自己的回复）→ 认得出")
    check("A9", not a_out["notInHist"], "不在历史里 → 认不出（该引就引）")
    check("A10", not a_out["substringNotHit"],
          "**子串不算命中**：「这个归我处理」里含「归我」，但它不是那一条 —— "
          "用 includes 会让「已经在了」大面积误判")
    check("A11", not a_out["toolNotCounted"],
          "工具结果不算会话历史（它不进模型的上文位）")

# ══════════════════════════════════════════════════════════════════════
# B 段 · 装配真的接上了吗（静态，要求到达分支与赋值）
# ══════════════════════════════════════════════════════════════════════
print("\nB 装配真的接上了吗（读源码；要求**到达分支与赋值**，不是「名字出现过」）")

raw = AGENT.read_text(encoding="utf-8") if AGENT.exists() else ""
feishu_raw = FEISHU.read_text(encoding="utf-8") if FEISHU.exists() else ""
if not raw:
    cannot_test("B", f"读不到 {AGENT.relative_to(ROOT)}")
    code = ""
else:
    code = strip_comments(raw)
    for cid, (ok, msg) in scan_wiring(code).items():
        check(cid, ok, msg)

if not feishu_raw:
    cannot_test("B10–B14", f"读不到 {FEISHU.relative_to(ROOT)}")
    feishu_code = ""
else:
    feishu_code = strip_comments(feishu_raw)
    for cid, (ok, msg) in scan_feishu(feishu_code).items():
        check(cid, ok, msg)

# ══════════════════════════════════════════════════════════════════════
# C 段 · 反向对照：**同一个扫描器**扫坏样本，必须红
# ══════════════════════════════════════════════════════════════════════
print("\nC 反向对照：把源码改坏，B 段那些扫描器必须报红（全在内存里，不碰盘）")

if not code:
    cannot_test("C", "没有源码，无法构造坏样本")
else:
    MUTATIONS = [
        ("C1", "B2", "`if (parentId)` 变成永假 —— 算了但不用",
         lambda c: c.replace("if (parentId) {", "if (false) {")),
        ("C2", "B1", "`parentId` 写死成 null —— 根本没去读 parent_id",
         lambda c: re.sub(r"const\s+parentId\s*=\s*parentIdOf\(\s*msg\s*\)",
                          "const parentId = null;", c)),
        ("C3", "B6", "回读失败时静默退回「没有上文」",
         lambda c: re.sub(r"(if\s*\(\s*parent\?\.error\s*\)\s*\{).*?(\n\s*\}\s*else)",
                          r"\1\2", c, flags=re.S)),
        ("C4", "B9", "拼好的 parentBlock 不接进 userTurn",
         lambda c: c.replace(
             "const turnContent = parentBlock ? `${parentBlock}\\n\\n${userTurn}` : userTurn;",
             "const turnContent = userTurn;")),
        ("C5", "B3", "回读了，但读的是 `msg.message_id`（读成自己那条）",
         lambda c: c.replace("await feishu.getMessage(parentId)",
                             "await feishu.getMessage(msg.message_id)")),
    ]
    for cid, target, why, mutate in MUTATIONS:
        bad = mutate(code)
        if bad == code:
            check(cid, False,
                  f"坏样本「{why}」**没能改到源码** —— 这条对照是空的（模式没匹配上）")
            continue
        failed = scan_failures(bad, feishu_code)
        check(cid, target in failed,
              f"坏样本「{why}」→ `{target}` 报红"
              f"（实际报红：{failed or '一个都没有'}）")

    # ★ 最容易发生、也最像「没问题」的一种：`message.get` 返回的是 `data.items[]`，
    #   按 `data.message` 读会拿到 undefined，**而且不报错**（§2.4.1 第 1 行）。
    FEISHU_MUTATIONS = [
        ("C7", "B12", "按 `data.message` 读（取错形状，静默拿到空）",
         lambda c: c.replace("r?.data?.items ?? []", "r?.data?.message ? [r.data.message] : []")),
        ("C8", "B13", "`items` 为空时不报错，静默当空消息",
         lambda c: re.sub(r"if\s*\(!items\.length\)\s*\{.*?\n\s{4}\}",
                          "if (!items.length) { return { text: '' }; }", c, flags=re.S)),
        ("C9", "B11", "改用 `message.list` 拿最近消息（读的不是被回复的那条）",
         lambda c: c.replace("client.im.message.get({ path: { message_id: messageId } })",
                             "client.im.message.list({ params: {} })")),
    ]
    if not feishu_code:
        cannot_test("C7–C9", "没有 feishu.mjs 源码，无法构造它那一半的坏样本")
    else:
        for cid, target, why, mutate in FEISHU_MUTATIONS:
            bad_f = mutate(feishu_code)
            if bad_f == feishu_code:
                check(cid, False,
                      f"坏样本「{why}」**没能改到源码** —— 这条对照是空的（模式没匹配上）")
                continue
            failed = scan_failures(code, bad_f)
            check(cid, target in failed,
                  f"坏样本「{why}」→ `{target}` 报红"
                  f"（实际报红：{failed or '一个都没有'}）")

    # 反向对照的反向对照：不去动源码时，扫描器必须全绿。
    # 没有这一条，上面那些可能只是因为「扫描器恒红」而通过。
    check("C6", scan_failures(code, feishu_code) == [],
          "**没改的真源码 → 一个都不报**（上面那些不是恒红）")

# ══════════════════════════════════════════════════════════════════════
# D 段 · 拿真实那一条事件跑一遍（回归测试）
# ══════════════════════════════════════════════════════════════════════
print("\nD 回归：拿 2026-09-22 那条真实事件跑一遍，必须还原出被答的那句话")

OFFLINE = "--offline" in sys.argv
her_msg_obj = None

if not EVENTS.exists():
    cannot_test("D", f"读不到 {EVENTS.relative_to(ROOT)}")
else:
    with EVENTS.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or INCIDENT_HER_MSG not in line:
                continue
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                continue
            m = (d.get("data") or {}).get("message") or {}
            if m.get("message_id") == INCIDENT_HER_MSG:
                her_msg_obj = m
                break
    if her_msg_obj is None:
        cannot_test("D1", f"事件日志里找不到 {INCIDENT_HER_MSG} —— 无法做回归")

if her_msg_obj is not None:
    ok_d, out_d = run_node(
        "import { parentIdOf } from './tools/agent/thread.mjs';\n"
        f"const msg = {json.dumps(her_msg_obj)};\n"
        "console.log(JSON.stringify({ parentId: parentIdOf(msg) }));"
    )
    if not ok_d:
        cannot_test("D1", f"跑不了纯函数：{out_d}")
    else:
        check("D1", out_d["parentId"] == INCIDENT_OUR_MSG,
              f"真实事件上，判据还原出被答的那一条 == 我方那条问话（{INCIDENT_OUR_MSG}）")

    if OFFLINE:
        cannot_test("D2", "`--offline`：没做回读，所以「被答的那句话取不取得到」**未测**")
        cannot_test("D3", "同上（D2 未测，D3 无从判断）")
    else:
        # 这一次只读请求由 Python 侧发（`tools/shouheng.py` 已有 GET 通道）。
        # 任何失败都算**未测**，不算红 —— 断网不等于这条链路坏了（§2.4.1 第 5 行）。
        try:
            sys.path.insert(0, str(ROOT / "tools"))
            from shouheng import Shouheng
            r = Shouheng().call("GET", f"/im/v1/messages/{INCIDENT_OUR_MSG}")
            items = r.get("items") or []
            if not items:
                cannot_test("D2", "回读 code=0 但 items 为空 —— 这是「读不到」，不是「内容是空的」")
                cannot_test("D3", "同上（D2 未测，D3 无从判断）")
            else:
                body = json.loads(items[0].get("body", {}).get("content", "{}"))
                text = body.get("text", "")
                check("D2", INCIDENT_QUESTION_FRAGMENT in text,
                      f"**回读得到被答的那句话**，且正是 117 条那一问（{len(text)} 字）")
                check("D3", text.count(INCIDENT_QUESTION_FRAGMENT) == 1,
                      "那句话只出现一次（不是碰巧撞上的片段）")
        except Exception as e:  # noqa: BLE001
            cannot_test("D2", f"回读不了 {INCIDENT_OUR_MSG}：{type(e).__name__}: {e}")
            cannot_test("D3", "同上（D2 未测，D3 无从判断）")

# ══════════════════════════════════════════════════════════════════════
# E 段 · 结论行自己不许撒谎
# ══════════════════════════════════════════════════════════════════════
print("\nE 结论行自己不许撒谎（未测 ≠ 通过 ≠ 红）")
check("E1", verdict(0, 0)[0] == 0, "全过 → 退 0")
check("E2", verdict(3, 0)[0] == 1, "有红 → 退 1")
check("E3", verdict(0, 2)[0] == 2, "**有未测 → 退 2**（不许当成通过）")
check("E4", "未测" in verdict(0, 1)[1] and "✅" not in verdict(0, 1)[1],
      "未测的文案说「未测」且不带 ✅（不把没测说成没问题）")
check("E5", "未测" in verdict(2, 1)[1],
      "**有红时也必须报出有未测** —— 否则只看最后一行的人会以为「其余都验过了」")

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
if n_fail:
    print(f"   （共 {len(results)} 项断言，{n_fail} 项红）")
sys.exit(_code)

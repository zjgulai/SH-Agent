#!/usr/bin/env python3
"""
kb_gap_ledger.py —— 逐条缺口账（T17 · C6 移植）

## 一句话

**每一次「一条知识没能被任何东西消费」都要留下一行，而且带原因码。**

不是「没进库就算了」，是「没进库，因为 X，第 N 次」。
形状照蓝本的 `extraction_drops`（Utopia `0003`，13 个原因码，按文档清）：
**原因码是枚举，不许自由字符串** —— 自由字符串等于没有原因码。

## 它给谁一个执行点

**G-11b**：62 条外部标准今天「一条判定也没支撑过」这件事，此前只能靠
全仓 `grep EXT-0` 才发现。落成本账之后，它是 **62 行 `unused`** ——
一句可以被机器否证的话。

## 一行是什么

`research/kb/缺口账-v1.jsonl`，一行一个 JSON 对象：

    {"库", "条目ID", "通道", "原因码", "首次出现", "次数", "最近一次"}   + 可选 "$引用者"

键是 **(库, 条目ID, 通道)**。三者的含义与取值域见下面三个常量。
`$引用者` 不是计划里列的字段，是落盘时加的：`cited_by` 若只说「有人引用了」而不说
**是谁**，读的人还得自己去规则表里找一遍 —— 而这一步恰恰是这本账要省掉的。
以 `$` 开头表示它是**派生读数**（重算即得），不是入账的事实。

### 「只增不删」在这里是什么意思

**行不许消失。** 不是「文件只能追加」—— 那样 `次数` 与 `最近一次` 就没法更新了。
具体是：

* 一个键一旦入账，**永远留在账上**；它的 `原因码` 可以从 `unused` 翻成
  `cited_by`（这正是这本账要报的进展），但行不会被删掉。
* `首次出现` 一经写下**不再改变**；`最近一次` 与 `次数` 每次重算时承接旧值再推进。
* 删掉一行 → 键集合不再等于应有集合 → `T17` 立刻红（见 `verify_kb.py`）。

### `次数` 数的是**天**，不是**次**

同一日历日重算多少次，`次数` 都只加 1。理由是硬的：如果按「调用次数」计，
那么 `build(现账, 今天) == 现账` 这条**可重算判据就会因为重算本身而失效** ——
检查一个东西的动作会改变它要检查的对象（`AGENTS.md` §2.4.4 那个病）。
按天计，`build` 就是纯函数，判据才立得住。

## ★ `通道` 今天恒为 `rules`，这不是填错

`推论三`（`PMO/守衡-知识库GAP分析与第一性原理决策-20260922.md`）：四类知识库
不是「四个库」，是「四条可寻址的证据通道」。本账的 `通道` 记的是**消费链路**：

| 通道 | 谁在消费 | 今天活着吗 |
|---|---|---|
| `rules` | `rules-v1.json` 的规则层 | ✅ 读得到，26 条规则 |
| `engine` | 判定引擎的回执（`evidence_ref`） | ❌ 盘上没有带 `evidence_ref` 的回执 |
| `shouheng` | 守衡在群里答话时引的条款 | ❌ 同上 |
| `kb_query` | 黄金问题 / 查询手册 | ❌ 十条问题一条也没引外部条款 |

`通道` 这一列今天 62 行**全是** `rules`，因为**只有它是活的** —— 其余三条
连一行都没有，而这正是本条纪律要的结果：**未测的通道不许出否定结论。**

> ★ 这条规矩来自 `AGENTS.md` §2.4.1 第 4 行：
> **否定结论的输入不是「我采的那条通道里没有」，而是「所有通道都采过，且每一条都自证活着」。**
> 所以 `unused` 这个否定结论**只对活着的通道出**。`channel_liveness()` 就是那份自证，
> 而 `verify_kb.py` 的 `T17b` 断言「账上出现的每个通道都必须活着」——
> 谁在 `engine` 还没接线的时候先写了 `engine` 的行，谁就会红。

## 为什么 `unused` 不看条目自己的 `关联规则`

48 条条目自己写着 `关联规则: ["T6.1.regulatory-status"]`。**这不算 `cited_by`。**

G-11c 说的正是反方向断着：`rules-v1.json` 的字段并集里**没有任何字段指向外部法规**。
条目自己声称的关联，没有任何消费者认账 —— 拿它当 `cited_by`，这本账就会报
「48 条已被引用 / 14 条未引用」，**把真正要说的那句话藏起来**，而且它是自问自答：
条目声明了一条边，账就相信这条边。

所以 `cited_by` 的判据是**反向指针**：`rules-v1.json` 里有规则的
`external_ref[]` 指得出这个 `条目ID`。

**第一次读数**（T3 落地前）：0 条反向指针 → **62 行全 `unused`**，与计划里那句
「有了这本账，它会是 62 行 `unused`」逐字吻合。
**T3 落地后**：90 条 `external_ref` → **48 行 `cited_by` / 14 行 `unused`**。
那次翻面是本账**正面判据的唯一一次真实触发** —— 不是构造的对照，是真数据自己翻的。
剩下 14 条正是归入 7 个候选规则族的空白条目（它们本来就没有规则可挂）。

> ★★ **`cited_by` 的含义边界，别读大了**：它说的是「**规则层认账了**」，
> **不是**「已经有一条判定支撑过了」。后者属于 `通道=engine`，
> 而那条通道今天**还没接线**（盘上没有带 `evidence_ref` 的回执）——
> 所以它连行都还没出。把「48 条被引用」读成「48 条已经支撑过判定」，
> 就是 `AGENTS.md` §2.4.3 那个病：**说出去的话比手上的依据大。**

用法：
  python3 tools/kb_gap_ledger.py                  # 续记到今天并写盘
  python3 tools/kb_gap_ledger.py --today=YYYY-MM-DD   # 只看会写成什么样（**dry-run，不落盘**）
  python3 tools/kb_gap_ledger.py --stats          # 只打印分组读数
"""

import argparse
import collections
import datetime
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                "research", "kb"))
import load  # noqa: E402

REPO = load.REPO
KB = load.KB
LEDGER_PATH = os.path.join(KB, "缺口账-v1.jsonl")
EXT_PATH = os.path.join(KB, "外部标准库-v1.json")
RULES_PATH = os.path.join(REPO, "research", "governance", "skeleton", "rules-v1.json")
CLASSES_PATH = os.path.join(KB, "知识库-v1.json")

# ── 三个取值域（枚举，不许自由字符串）────────────────────────────────
#
# `库`：与 `知识库-v1.json` 的 `classes[].知识库` **必须逐个相等**。
# 这里写死一份是为了让「加了一类库却没加进本账」变成一条会红的断言
# （见 `verify_kb.py` T17b），而不是靠读代码的人记得同步。
LIBS = ("外部标准库", "内部正面与负面样本库", "措辞表达库", "产品描述库")

# `通道`：消费链路。见模块抬头那张表。
CHANNELS = ("rules", "engine", "shouheng", "kb_query")

# `原因码`：枚举。加新码必须同时在 `REASON_MEANING` 里写清它是什么意思 ——
# 一个只有代号没有含义的原因码，读的人还是不知道发生了什么。
REASONS = ("unused", "cited_by")
REASON_MEANING = {
    "unused": "该通道里没有任何东西指向这个条目 —— 它是孤儿（G-11b）",
    "cited_by": "该通道里指得出引用它的东西；行保留在账上是为了记住它曾经是缺口",
}

FIELDS = ("库", "条目ID", "通道", "原因码", "首次出现", "次数", "最近一次")


def today_bj():
    """北京时间日历日。与 `verify_pending.py` 的 `BJ` 同一口径。"""
    return (datetime.datetime.now(datetime.timezone.utc)
            + datetime.timedelta(hours=8)).date().isoformat()


# ── 通道活性自证 ─────────────────────────────────────────────────────

def channel_liveness(rules_path=RULES_PATH, receipts_path=None):
    """每条通道此刻**采得到吗**。返回 {通道: {"alive": bool, "proof": str}}.

    ★ 这一节就是 `AGENTS.md` §2.4.1 第 4 行的执行点：
      一条通道活着，**不给另一条通道作证**。所以这里是四条**各自**采一遍，
      不是「我读了规则表，所以四条都活着」。

    ★ 而且活性不是「开关状态」，是**条数**（§2.4.1 可操作结论 3）：
      「文件存在」不算活，「读出来非空」才算。
    """
    out = {}

    # ── rules：规则表 ────────────────────────────────────────────
    try:
        rules = json.load(open(rules_path, encoding="utf-8"))["rules"]
        n = len(rules)
        has_field = any("external_ref" in r for r in rules)
        out["rules"] = {
            "alive": n > 0,
            "proof": (f"rules-v1.json 读出 {n} 条规则"
                      + ("，且 external_ref 字段已在用" if has_field
                         else "，但**没有一条规则带 external_ref** —— "
                              "所以「某条目被引用」这个肯定结论今天一条也出不来")),
            "n": n,
        }
    except (OSError, KeyError, json.JSONDecodeError) as e:
        out["rules"] = {"alive": False, "proof": f"rules-v1.json 读不出：{e}", "n": 0}

    # ── engine：判定回执 —— ★ 2026-09-23（T4）起**真的去数**，不再硬编码 ──
    #   §2.4.1 那句话在这里的形态：「活性不是开关状态，是条数」。
    #   T4 之前这一格写死 `alive: False` + 「接线在 T4/T15（W2–W3）」——
    #   那是一句**当时的读数**，而 T4 落地之后它不会自己更新（§2.4.1 第 5 行：
    #   一个会过期的读数，没有任何东西在它过期时变红）。所以改成去账本里数。
    #   ★ 它数的**不是**「引擎支持不支持」，是「盘上有没有一份能拿来扫的东西」。
    _rec_p = os.path.normpath(os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..",
        "research", "governance", "skeleton", "_data", "receipts.jsonl"))
    n_rec = n_incontract = 0
    cited_ids = set()
    try:
        for ln in open(_rec_p, encoding="utf-8").read().splitlines():
            if not ln.strip():
                continue
            n_rec += 1
            try:
                rc = json.loads(ln)
            except json.JSONDecodeError:
                continue
            refs = rc.get("evidence_ref")
            if isinstance(refs, list) and refs:
                n_incontract += 1
                cited_ids |= {r.get("条目ID") for r in refs if isinstance(r, dict)}
    except OSError as e:
        out["engine"] = {"alive": False, "proof": f"回执账本读不出：{e}", "n": 0}
    else:
        out["engine"] = {
            "alive": n_incontract > 0,
            "proof": (f"账本 {n_rec} 条回执，其中 **{n_incontract}** 条带 `evidence_ref`"
                      f"（共引用 {len(cited_ids)} 个外部条目）"
                      if n_incontract else
                      f"账本 {n_rec} 条回执，**一条也没带 `evidence_ref`** —— "
                      f"T4 的接线已通（判据 T4a/T4b/V48 全绿），"
                      f"但**还没有一条真判定走过它**（守衡下一次调 `judge_copy` 才会写下第一条）。"
                      f"所以这是**未测**，不是「扫过、没有」"),
            "n": n_incontract,
        }

    # ── shouheng：守衡群内答话的引用 —— 仍然未接线 ────────────────────
    out["shouheng"] = {
        "alive": False,
        "proof": "守衡在群里答话时**没有任何机器可读的引用落点**（对话日志里没有条款地址）"
                 "—— **未测**（不是「扫过、没有」）。它要等 T15 那条链路",
        "n": 0,
    }

    # ── kb_query：黄金问题 ──────────────────────────────────────
    man = os.path.join(KB, "查询手册.md")
    try:
        txt = open(man, encoding="utf-8").read()
        n_ref = txt.count("EXT-")
        out["kb_query"] = {
            "alive": n_ref > 0,
            "proof": (f"查询手册含 {n_ref} 处 `EXT-` 引用"
                      if n_ref else
                      "查询手册十条问题里**一处也没引外部条目** —— 未测"),
            "n": n_ref,
        }
    except OSError as e:
        out["kb_query"] = {"alive": False, "proof": f"查询手册读不出：{e}", "n": 0}

    return out


# ── 反向指针：谁在引用外部条目 ────────────────────────────────────────

def cited_index(rules_path=RULES_PATH):
    """扫出「哪些条目 ID 被某个消费者指到了」。返回 {条目ID: [(库, 通道, 引用者)]}.

    ★ 只认**反向指针** —— 即别的制品里写着的 `条目ID`。条目自己的 `关联规则`
      不算（理由见模块抬头）。这条判据也顺手把「条目自己声明了、规则那侧没有」
      这种单边关系暴露出来：它不会让账变绿，只会因为 T3 的双向一致性检查变红。

    ★ 采的是**结构化字段** `external_ref[]`，不是全仓 grep `EXT-`。
      理由是 §2.4.1 第 3 行：grep 出来的命中可能来自散文、注释、别的文件的历史记录 ——
      那不是「被引用」，那是「被提到过」。本仓已经因为混这两者出过事。
    """
    out = collections.defaultdict(list)
    try:
        rules = json.load(open(rules_path, encoding="utf-8"))["rules"]
    except (OSError, KeyError, json.JSONDecodeError):
        return out, "rules-v1.json 读不出 —— 本次一个肯定结论也出不来"
    refs_seen = 0
    for r in rules:
        for ref in (r.get("external_ref") or []):
            if not isinstance(ref, dict):
                continue
            refs_seen += 1
            eid = ref.get("条目ID")
            if eid:
                out[eid].append(("外部标准库", "rules", r.get("rule_key")))

    # ── engine 通道（★ 2026-09-23 / T4 起真的去扫）─────────────────────
    #   T4 之前回执里没有 `evidence_ref`，所以这一条**采不到**，`engine` 是未测。
    #   现在采得到了 —— 而**采得到就必须采**：`desired_rows()` 只对**活着**的通道出行，
    #   而 `channel_liveness()` 现在报 engine=活。若这里不扫，「有判定引用过它」
    #   在账上就永远是假，**那是一条假否定结论**（比不出行更糟）。
    #
    #   ★★ 通道必须**逐条带上**（`("外部标准库", "engine", run_id)`），
    #      因为同一个条目 ID 可以被两条通道各自引用。把它们混在一个集合里，
    #      `rules` 那一行会因为**一条回执**引过它而翻成 `cited_by` ——
    #      那正是「一条通道活着给另一条通道作证」的反面（§2.4.1 第 4 行）。
    rec_p = os.path.join(REPO, "research", "governance", "skeleton", "_data", "receipts.jsonl")
    n_rec = n_eng = 0
    try:
        for ln in open(rec_p, encoding="utf-8").read().splitlines():
            if not ln.strip():
                continue
            n_rec += 1
            try:
                rc = json.loads(ln)
            except json.JSONDecodeError:
                continue
            for ref in (rc.get("evidence_ref") or []):
                if not isinstance(ref, dict):
                    continue
                eid = ref.get("条目ID")
                if eid:
                    n_eng += 1
                    out[eid].append(("外部标准库", "engine", rc.get("run_id")))
    except OSError as e:
        return out, (f"扫过 {len(rules)} 条规则 → {refs_seen} 条 external_ref；"
                     f"回执账本读不出（{e}）—— **engine 通道这一格是未测**，"
                     f"不是「扫过、没有」")

    return out, (f"扫过 {len(rules)} 条规则 → {refs_seen} 条 external_ref；"
                 f"扫过 {n_rec} 条回执 → {n_eng} 处 engine 引用")


# ── 建账 / 续记 ──────────────────────────────────────────────────────

def ext_entries(ext_path=EXT_PATH):
    """外部标准库的条目表。文件不在时返回 `(None, 原因)` —— 不返回空表。

    ★ 「文件不在」与「文件里 0 条」是两件事：前者是未测，后者是一个读数。
      返回空表会把前者伪装成后者，于是 62 行 `unused` 会被写成 0 行、看着像「都引用上了」。
    """
    if not os.path.exists(ext_path):
        return None, f"{os.path.relpath(ext_path, REPO)} 不存在 —— 未测"
    try:
        doc = json.load(open(ext_path, encoding="utf-8"))
    except json.JSONDecodeError as e:
        return None, f"{os.path.relpath(ext_path, REPO)} 解析失败：{e}"
    return doc.get("entries") or [], f"{os.path.relpath(ext_path, REPO)} 读出 {len(doc.get('entries') or [])} 条"


def desired_rows(ext_path=EXT_PATH, rules_path=RULES_PATH, today=None):
    """算出「今天这本账应该长什么样」。返回 `(rows, notes)`。

    `rows` 是**不含承接字段**（首次出现/次数/最近一次）的部分 —— 那三个由
    `build()` 从旧账里承接，理由见模块抬头「只增不删」。
    """
    today = today or today_bj()
    notes = []
    live = channel_liveness(rules_path=rules_path, receipts_path=None)
    entries, ext_note = ext_entries(ext_path)
    notes.append(ext_note)
    if entries is None:
        return None, notes, live

    cited, cite_note = cited_index(rules_path=rules_path)
    notes.append(cite_note)
    # ★ 未测与「扫过、0 命中」必须在输出里长得不一样（§2.4.1 可操作结论 1）。
    notes.append(f"反向指针命中：{len(cited)} 个条目 ID"
                 + ("（这是**真的 0**：规则表读出来了，只是没有一条 external_ref）"
                    if not cited and live.get("rules", {}).get("alive")
                    else ""))
    notes.append("通道活性：" + "；".join(f"{k}={'活' if v['alive'] else '未测'}"
                                          for k, v in live.items()))

    rows = []
    for e in entries:
        eid = e.get("id")
        for ch in CHANNELS:
            if not live.get(ch, {}).get("alive"):
                # ★ 通道没活着 → **不出行**。出了行就等于对它下了否定结论，
                #   而否定结论的输入必须是「采过且活着」（§2.4.1 第 4 行）。
                continue
            who = cited.get(eid) or []
            hit = [w for w in who if w[1] == ch]
            rows.append({
                "库": "外部标准库",
                "条目ID": eid,
                "通道": ch,
                "原因码": "cited_by" if hit else "unused",
                "$引用者": [w[2] for w in hit],
            })
    return rows, notes, live


def build(existing=None, ext_path=EXT_PATH, rules_path=RULES_PATH, today=None):
    """续记：`desired_rows` + 从 `existing` 承接 `首次出现/次数/最近一次`。

    返回 `(doc_or_None, notes, live)`；`doc` 是 `{"rows": [...]}`，行已按
    `(库, 条目ID, 通道)` 排序，因此**同输入必得同输出**（可重算判据的前提）。
    """
    today = today or today_bj()
    rows, notes, live = desired_rows(ext_path=ext_path,
                                     rules_path=rules_path, today=today)
    if rows is None:
        return None, notes, live

    prev = {}
    for r in (existing or {}).get("rows", []) or []:
        prev[(r.get("库"), r.get("条目ID"), r.get("通道"))] = r

    out = []
    for r in rows:
        k = (r["库"], r["条目ID"], r["通道"])
        old = prev.get(k)
        if old is None:
            r["首次出现"] = today
            r["次数"] = 1
        else:
            r["首次出现"] = old.get("首次出现") or today      # ★ 一经写下不再改变
            r["次数"] = int(old.get("次数") or 0) + (0 if old.get("最近一次") == today else 1)
        r["最近一次"] = today
        out.append(r)
    out.sort(key=lambda r: (r["库"], r["条目ID"], r["通道"]))
    return {"rows": out}, notes, live


def load_ledger(path=LEDGER_PATH):
    """读账。**读不出就返回 None**，不许静默返回空账 ——
    空账会让「62 行 unused」变成「0 行」，而后者读起来像「都引用上了」。"""
    if not os.path.exists(path):
        return None, f"{os.path.relpath(path, REPO)} 不存在"
    rows = []
    for i, ln in enumerate(open(path, encoding="utf-8"), 1):
        ln = ln.strip()
        if not ln:
            continue
        try:
            rows.append(json.loads(ln))
        except json.JSONDecodeError as e:
            return None, f"{os.path.relpath(path, REPO)} 第 {i} 行不是 JSON：{e}"
    return {"rows": rows}, f"{os.path.relpath(path, REPO)} 读出 {len(rows)} 行"


def dump(doc):
    """账本 → 文本。字段顺序固定，好让 diff 读得出人话。

    ★ `load_ledger(dump(x))` 必须**逐字等于** `x` —— `T17d` 的可重算判据建在这上面。
      第一版就栽在这里：`dump` 写的是 `$引用者`，`build` 里存的是 `_引用者`，
      于是「读回来再写一遍」多出一个字段，可重算判据**每次跑都红**。
      一个不恒等的往返，会让下游所有比对都变成噪声。
    """
    lines = []
    for r in doc["rows"]:
        o = {k: r[k] for k in FIELDS}
        if r.get("$引用者"):
            o["$引用者"] = r["$引用者"]
        lines.append(json.dumps(o, ensure_ascii=False))
    return "\n".join(lines) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--today", default=None,
                    help="注入日历日。★ 注入日一律 dry-run，不落盘（AGENTS.md §2.4.3 的坑）")
    ap.add_argument("--stats", action="store_true")
    a = ap.parse_args()

    old, note = load_ledger()
    print(f"旧账：{note}")
    doc, notes, live = build(existing=old, today=a.today)
    for n in notes:
        print(f"  · {n}")

    if doc is None:
        print("❌ 建不出账 —— 明细见上。**未测不等于通过。**")
        return 2

    cnt = collections.Counter(r["原因码"] for r in doc["rows"])
    print(f"新账应含 {len(doc['rows'])} 行：" +
          "、".join(f"{k} {v}" for k, v in sorted(cnt.items())))
    assert sum(cnt.values()) == len(doc["rows"]), "分组之和 ≠ 总行数 —— 建账自己就坏了"

    if a.stats:
        return 0

    want = dump(doc)
    if a.today:
        # ★ 注入日 dry-run：不落盘。第一版落了状态，于是「看一眼 10-03 会说什么」
        #   把 10-03 那天真正该说的话提前用掉了（§2.4.3）。
        print(f"（--today={a.today} 是 dry-run，未落盘）")
        print(want[:400] + ("…" if len(want) > 400 else ""))
        return 0

    have = open(LEDGER_PATH, encoding="utf-8").read() if os.path.exists(LEDGER_PATH) else None
    if have == want:
        print("✅ 账已是最新，无需改写")
        return 0
    with open(LEDGER_PATH, "w", encoding="utf-8") as fh:
        fh.write(want)
    print(f"✅ 已写 {os.path.relpath(LEDGER_PATH, REPO)}（{len(doc['rows'])} 行）")
    return 0


if __name__ == "__main__":
    sys.exit(main())

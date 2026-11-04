#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
_recon_legacy.py —— ADR-0013 `遗留#` 的对账表（第十二批 · 12.2 的前置件）

## 为什么先有它

D34 裁定「三套未决 ID 合并进 `$decision_queue` 单一编号空间，`D#`/`遗留#` 作别名保留」。
别名要成立，先得满足一个前提：**每个别名只能指一件事**。
而实测发现 ADR-0013 的 `遗留#` 不满足这个前提 —— 同一份文件里 `遗留 6` 有两个含义。

所以本脚本**只读**，做一件事：把 `遗留#` 的 52 行摊平成「真实集合」，
并逐条判出三类关系：

  ① 撞号异义（same number, different item）—— 别名不唯一的来源，必须拆
  ② 重号同义（same number, same item）—— 同一件事在两个表里各写了一遍
  ③ 异号同义（different numbers, same item）—— 一件事有两个号，靠人记对应关系

本脚本**不改任何文件**。它是「先出对账表再改文」里那张表。
改文由 `tools/_migrate_ids_batch12.py` 做，且它必须读本脚本的产物。

用法：
  python3 tools/_recon_legacy.py            # 人读
  python3 tools/_recon_legacy.py --json     # 机器读
  python3 tools/_recon_legacy.py --write    # 落盘 _data/遗留对账.json + 遗留对账.md
"""

import hashlib
import json
import os
import re
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ADR = os.path.join(REPO, "ADR", "ADR-0013-基座接口冻结与仓库入库分级.md")
OUT_JSON = os.path.join(REPO, "research", "governance", "skeleton", "_data", "遗留对账.json")
OUT_MD = os.path.join(REPO, "research", "governance", "skeleton", "_data", "遗留对账.md")


# ── 解析 ────────────────────────────────────────────────────────────────

def _sections(lines):
    """行号 → 最近的 `##`/`###` 标题。用于给每张表标出它属于哪一节。"""
    out, cur = {}, "(文首)"
    for i, l in enumerate(lines, 1):
        m = re.match(r"^(#{2,3})\s+(.*)$", l)
        if m:
            cur = m.group(2).strip()
        out[i] = cur
    return out


def parse(path=ADR):
    lines = open(path, encoding="utf-8").read().split("\n")
    sec = _sections(lines)
    tables, cur = [], None
    for i, l in enumerate(lines, 1):
        # ★ 尾部注释必须**先剥掉**再匹配。
        #   第一版没有这一步，而 `_migrate_ids_batch12.py` 恰好往 10 个撞号行的行尾
        #   追加了 `<!-- 遗留编号撞号：… -->` —— 行正则要求以 `|` 结尾，于是那 10 行
        #   **整个消失**：52 行 → 42 行、撞号集合 → 空。
        #   而这与 D37 的三条自撞是同一形态：**改的是编号，坏的是围着编号写的假设**
        #   （这次坏的是「表格行以 `|` 结尾」这条格式假设）。
        l = re.sub(r"\s*<!--.*?-->\s*$", "", l)
        if re.match(r"^\|\s*#\s*\|\s*遗留\s*\|", l):
            cur = {"header_line": i, "section": sec[i], "rows": []}
            tables.append(cur)
            continue
        if cur is None:
            continue
        m = re.match(r"^\|\s*(\d+)\s*\|(.*)\|\s*$", l)
        if m:
            cells = [c.strip() for c in m.group(2).split("|")]
            owner = cells[-1] if cells else ""
            text = "|".join(cells[:-1]).strip() if len(cells) > 1 else m.group(2).strip()
            cur["rows"].append({"line": i, "num": int(m.group(1)),
                                "text": text, "owner": owner})
        elif not l.startswith("|") and l.strip():
            cur = None
    return lines, tables


# ── 文本归一（判「是不是同一件事」用） ──────────────────────────────────

# ★ 实测：「已关闭」在这个文件里有**三种写法**，没有一种统一形式 ——
#   ① 删除线 + `→ **已关闭**（…）`（§五 / §13.12 那种）
#   ② 只把「归属」列写成 `—`（§五 6/9、§13.12 17/19/20/24、§14.9 27/28）
#   ③ 只在正文末尾写「已修，旧轮不可补」（§14.9 27）
#   判「关没关」若只看其中一种，就会把 ② ③ 读成未关闭。
#   本脚本三种都认，并把「靠哪种认出来的」记进产物 —— 这个字段本身就是证据。
_CLOSED_TAIL = re.compile(r"→\s*\*\*已(?:关闭|结|定位|修|并入|查过)[^\n]*")
_CLOSED_ANY = re.compile(r"→\s*\*\*已(?:关闭|结|定位|修|并入|查过)")
# ③ 那种写法的尾巴：「。已修，旧轮不可补」/「。已修，从下一轮起生效；旧轮不可补」
_CLOSED_TAIL_PLAIN = re.compile(r"[。；;]\s*已修[，,][^\n]*$")


def normalize(text):
    t = text
    t = re.sub(r"~~(.*?)~~", r"\1", t)          # 删除线里去取原话
    # ★ 顺序要紧：`**` 必须在**这两条之前**还在。
    #   第一版把它们写在 `replace("**","")` 之后，于是 `→ **已关闭**` 已经变成
    #   `→ 已关闭`，`_CLOSED_TAIL` 一处也匹配不上 —— 判据被自己的前置步骤拆掉了。
    #   这与 D37 那条 `〔缺口:([A-Za-z0-9_]+)〕` 匹配不上 `KB-GAP-1` 是同一形态。
    t = _CLOSED_TAIL.sub("", t)                  # 去掉「→ 已关闭（…）」那一整截
    t = _CLOSED_TAIL_PLAIN.sub("", t)
    t = t.replace("**", "").replace("`", "")
    t = re.sub(r"[（(]§[^）)]*[）)]", "", t)
    t = re.sub(r"[\s，。、：:；;·—–\-（）()\[\]【】「」“”\"'…]", "", t)
    return t[:60]


def close_evidence(text, owner):
    """返回「凭什么判它关了」；空串 = 判未关闭。"""
    if "~~" in text:
        return "删除线"
    if _CLOSED_ANY.search(text):
        return "关闭箭头"
    if owner.strip() in ("—", "-"):
        return "归属列空"
    if owner.strip().startswith("已"):
        return "归属列已结"
    if re.search(r"(?<!不)已修[，,]", text):
        return "正文已修"
    return ""


def is_closed(text, owner=""):
    return bool(close_evidence(text, owner))


def _bigrams(s):
    return {s[i:i + 2] for i in range(len(s) - 1)} or {s}


def _sim(a, b):
    """字符二元组 Jaccard。用于把「同一件事的两份不同措辞」合并。
    ★ 用 Jaccard 而不是编辑距离：这两份副本的差别是**插入了一截**
      （「→ 已关闭（13.4：三件全部复查…）」），长度差很大但主干逐字相同。"""
    A, B = _bigrams(a), _bigrams(b)
    return len(A & B) / len(A | B)


def _contain(a, b):
    """较短的那条有多大比例被较长的那条包含。
    ★ 为什么还要这一条：有的副本是对另一条的**扩写**（「…未复查」→「…已关闭（13.4：三件全部复查）」），
      Jaccard 被长度差稀释到 0.5 以下，但主干是逐字包含关系。"""
    A, B = _bigrams(a), _bigrams(b)
    if min(len(A), len(B)) < 12:
        return 0.0
    return len(A & B) / min(len(A), len(B))


SIM_THRESHOLD = 0.55
CONTAIN_THRESHOLD = 0.80

# ★ 第三种关系：源文件**自己写明了**「已并入 N」。
#   这不是相似度能推出来的 —— 它是一条声明的关系，必须照抄，不能猜。
_MERGED_INTO = re.compile(r"已并入\s*(\d+)")


def _merged_into(text, owner):
    m = _MERGED_INTO.search(text) or _MERGED_INTO.search(owner)
    return int(m.group(1)) if m else None


def _cluster(flat):
    """先按归一化原文精确聚，再把高相似 / 高包含的簇并起来（并的时候记账，供人复核）。"""
    exact = {}
    for r in flat:
        exact.setdefault(normalize(r["text"]), []).append(r)

    keys = sorted(exact)
    parent = list(range(len(keys)))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    merges = []
    for i in range(len(keys)):
        for j in range(i + 1, len(keys)):
            s, c = _sim(keys[i], keys[j]), _contain(keys[i], keys[j])
            pre = len(keys[i]) >= 6 and keys[i][:6] == keys[j][:6]
            if s >= SIM_THRESHOLD or c >= CONTAIN_THRESHOLD or pre:
                ri, rj = find(i), find(j)
                if ri != rj:
                    parent[rj] = ri
                    merges.append({"a": keys[i][:46], "b": keys[j][:46],
                                   "jaccard": round(s, 3), "containment": round(c, 3),
                                   "by": ("jaccard" if s >= SIM_THRESHOLD else
                                          "containment" if c >= CONTAIN_THRESHOLD else
                                          "共前 6 字")})

    groups = {}
    for i, k in enumerate(keys):
        groups.setdefault(find(i), []).extend(exact[k])
    return groups, merges


def recon(path=ADR):
    lines, tables = parse(path)
    flat = []
    for t in tables:
        for r in t["rows"]:
            flat.append({"table_line": t["header_line"], "section": t["section"], **r})

    groups, merges = _cluster(flat)

    items = []
    for members in groups.values():
        nums = sorted({m["num"] for m in members})
        ocs = [{"num": m["num"], "line": m["line"],
                "table_line": m["table_line"], "section": m["section"],
                "closed": is_closed(m["text"], m["owner"]),
                "closed_evidence": close_evidence(m["text"], m["owner"]),
                "owner": m["owner"], "text": m["text"]}
               for m in sorted(members, key=lambda x: x["line"])]
        items.append({
            "key": normalize(ocs[0]["text"]),
            "numbers": nums,
            "occurrences": ocs,
            # ★ 状态冲突：同一件事的两处登记一个说关闭、一个说没关。
            #   这不是措辞差异 —— 它是「同一件事在两处有不同状态」，
            #   正是本项目一直在治的那一类，故单列一类。
            "status_conflict": len({o["closed"] for o in ocs}) > 1,
            "closed": all(o["closed"] for o in ocs),
            # ★ 源文件自己声明的并入关系（照抄，不猜）
            "merged_into": next((m for m in (_merged_into(o["text"], o["owner"])
                                             for o in ocs) if m), None),
        })
    items.sort(key=lambda x: (min(x["numbers"]), x["key"]))

    by_num = {}
    for it in items:
        for n in it["numbers"]:
            by_num.setdefault(n, []).append(it)

    # ★ 撞号 = 一个号指**两件不同的事**。同一件事的重复登记不算。
    collide = {n: v for n, v in by_num.items() if len(v) > 1}

    return {
        "source": os.path.relpath(path, REPO),
        "source_sha256": hashlib.sha256(open(path, "rb").read()).hexdigest(),
        "source_lines": len(lines),
        "tables": len(tables),
        "rows": len(flat),
        "distinct_numbers": len(by_num),
        "number_range": [min(by_num), max(by_num)],
        "unique_items": len(items),
        "items": items,
        "cluster_merges": merges,
        "collide_numbers": sorted(collide),
        "collide": {str(n): [it["key"][:40] for it in v] for n, v in sorted(collide.items())},
        "status_conflicts": [{"numbers": it["numbers"], "key": it["key"],
                              "detail": [{"line": o["line"], "section": o["section"],
                                          "closed": o["closed"]} for o in it["occurrences"]]}
                             for it in items if it["status_conflict"]],
        "multi_numbered": [{"numbers": it["numbers"], "key": it["key"],
                            "places": len(it["occurrences"])}
                           for it in items
                           if len(it["numbers"]) > 1 or len(it["occurrences"]) > 1],
        "absorbed": [{"numbers": it["numbers"], "key": it["key"],
                      "into": it["merged_into"]}
                     for it in items if it["merged_into"]],
        "open_items": [it for it in items if not it["closed"]],
        "closed_items": [it for it in items if it["closed"]],
    }


# ── 输出 ────────────────────────────────────────────────────────────────

def render_md(r):
    L = []
    L.append("# ADR-0013 `遗留#` 对账表")
    L.append("")
    L.append("> **只读产物**，由 `python3 tools/_recon_legacy.py --write` 生成，不要手改。")
    L.append("> 它是第十二批 12.2 的**前置件**：改文之前必须先有它（顺序约束，同 D31）。")
    L.append("")
    L.append(f"- 源：`{r['source']}`（{r['source_lines']} 行）")
    L.append(f"- 表：**{r['tables']} 张** · 行：**{r['rows']} 行** · "
             f"编号：**{r['distinct_numbers']} 个**（{r['number_range'][0]}–{r['number_range'][1]}）")
    L.append(f"- 去重后**真实事项：{r['unique_items']} 件**"
             f"（未关闭 {len(r['open_items'])} · 已关闭 {len(r['closed_items'])}）")
    L.append(f"- 聚类合并：{len(r['cluster_merges'])} 处（相似度阈值 {SIM_THRESHOLD}，逐处列在 JSON 的 "
             f"`cluster_merges` 里供复核）")
    L.append("")
    L.append("## ① 撞号异义 —— 同一个号指**两件不同的事**（别名不唯一的来源，必须拆）")
    L.append("")
    if r["collide"]:
        L.append("| 号 | 它指过的不同事项 |")
        L.append("|---|---|")
        for n in r["collide_numbers"]:
            L.append(f"| `遗留 {n}` | " + "<br>".join(f"· {k}" for k in r["collide"][str(n)]) + " |")
    else:
        L.append("（无）")
    L.append("")
    L.append("## ② 状态冲突 —— 同一件事在两处登记，一处说关闭、一处说没关")
    L.append("")
    if r["status_conflicts"]:
        L.append("| 号 | 事项 | 冲突的两处 |")
        L.append("|---|---|---|")
        for c in r["status_conflicts"]:
            ds = "<br>".join(f"行{d['line']}（{d['section'][:14]}）：{'已关闭' if d['closed'] else '未关闭'}"
                             for d in c["detail"])
            L.append(f"| {', '.join('`遗留 %d`' % n for n in c['numbers'])} | {c['key'][:40]} | {ds} |")
    else:
        L.append("（无）")
    L.append("")
    L.append("## ③ 异号 / 重号同义 —— 同一件事有多个号或多处登记")
    L.append("")
    if r["multi_numbered"]:
        L.append("| 号 | 出现处数 | 事项 |")
        L.append("|---|---|---|")
        for m in r["multi_numbered"]:
            L.append(f"| {', '.join('`遗留 %d`' % n for n in m['numbers'])} | {m['places']} | {m['key'][:44]} |")
    else:
        L.append("（无）")
    L.append("")
    L.append("## ④ 真实集合（去重后逐条）")
    L.append("")
    L.append("| 号 | 状态 | 归属 | 事项 | 出现于 |")
    L.append("|---|---|---|---|---|")
    for it in r["items"]:
        nums = ", ".join("`遗留 %d`" % n for n in it["numbers"])
        where = ", ".join(f"行{o['line']}" for o in it["occurrences"])
        st = "**状态冲突**" if it["status_conflict"] else ("已关闭" if it["closed"] else "**未关闭**")
        L.append(f"| {nums} | {st} | {it['occurrences'][0]['owner'][:18]} | "
                 f"{it['key'][:44]} | {where} |")
    L.append("")
    return "\n".join(L) + "\n"


def is_fresh(path=OUT_JSON):
    """盘上那份对账产物还新不新鲜。抽出来是为了判据（V46e）能直接调它。"""
    if not os.path.exists(path):
        return False, "产物不存在"
    doc = json.load(open(path, encoding="utf-8"))
    now = hashlib.sha256(open(ADR, "rb").read()).hexdigest()
    if doc.get("source_sha256") != now:
        return False, (f"源已变（ADR sha256 {now[:12]}… vs 产物记的 "
                       f"{str(doc.get('source_sha256'))[:12]}…）")
    return True, "新鲜"


def main():
    r = recon()
    if "--check" in sys.argv:
        ok, why = is_fresh()
        print(("✅ " if ok else "❌ ") + f"{os.path.relpath(OUT_JSON, REPO)}：{why}")
        return 0 if ok else 1
    if "--write" in sys.argv:
        os.makedirs(os.path.dirname(OUT_JSON), exist_ok=True)
        with open(OUT_JSON, "w", encoding="utf-8") as f:
            json.dump(r, f, ensure_ascii=False, indent=1)
            f.write("\n")
        with open(OUT_MD, "w", encoding="utf-8") as f:
            f.write(render_md(r))
        print(f"✅ 已落盘 {os.path.relpath(OUT_JSON, REPO)}")
        print(f"✅ 已落盘 {os.path.relpath(OUT_MD, REPO)}")
    if "--json" in sys.argv:
        print(json.dumps({k: v for k, v in r.items() if k != "items"},
                         ensure_ascii=False, indent=1))
        return
    print(render_md(r))


if __name__ == "__main__":
    sys.exit(main())

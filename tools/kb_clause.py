#!/usr/bin/env python3
"""
kb_clause.py —— 条款层词汇：地址 / 指纹 / 来源分级（T18 · T19）

本模块是**条款层**的唯一定义处。它回答三个问题，各对应一条移植项：

| 问 | 答案长什么样 | 移植自 |
|---|---|---|
| 这条条款**叫什么** | `clause_no`（条文号，稳定地址） | T2（C1 的地址面） |
| 这条条款**被引用之后还算数吗** | 变更指纹 + `stale` 判定 | **T18（C1，Utopia `0053`）** |
| 这条证据**是怎么来的** | `origin` 四档 + PASS 收窄 | **T19（C2）** |

## 为什么这三样放在同一个模块里

因为它们是**同一个坐标系**：指纹要哈希「库名 + 条文号 + 正文」，地址要指得出
「库名 + 条文号」才能回查，而 `origin` 是这条地址上挂的**可信度**。
分三个文件写，就会出现三份「条文号长什么样」的定义 —— 而本仓已经因为
「同一件事两份来源」出过四次事（`D12` 的 `why_it_matters`）。

## ★ 两套标识：身份与 token（照搬 Utopia 的教训）

* **身份** = `EXT-001`。稳定，**不随改名变**。`rules-v1.json` 的 `external_ref`
  与回执的 `evidence_ref` 都记它，用来回查「这是哪一条」。
* **token** = `clause_no`，形如 `S1-01`。**由来源与出现序派生**，给人读、给 API 用。

蓝本的原话是 `ontology.md:173`：**从标签派生的 key 会在改名时断，而 IRI 是名字不是地址。**
所以这里两套都留：`clause_no` 派生了没关系，它**断了会被判据抓住**
（`index_problems()` 断言 `clause_no` 必须等于按当前位置重算的值）——
派生 + 比对 = 顺序一变就红，而不是静默指向别人。

## ★ 指纹哈希的是什么（`0053` 的形状）

    库名 + 来源ID + 条文号 + 条款原文

**只哈希「决策当时考虑过的输入」**。改了其中任意一个字节 → 指纹变 → 引用它的规则
标记 `stale`。这比时间戳准：时间戳看不见「条款被改了一个字」，
而改一个字恰恰是法务最常做的动作。

**条款位置（`条款位置` 自由文本）不进指纹** —— 它是描述，不是内容；
改描述不该让引用失效，否则整理一次措辞就会让 26 条规则全部变 stale，
那会让人开始无视这个信号（比没有信号更糟，`AGENTS.md` §2.1.1）。

## ★ `origin` 四档

| 档 | 什么意思 | 能不能单独把结论推到 PASS |
|---|---|---|
| `stated` | 原文照读（网页正文、API 返回的文本、飞书文档原话） | ✅ |
| `ocr` | 图片里的文字，经 OCR 取出 | ❌ |
| `transcribed` | 音视频转写 | ❌ |
| `described` | 模型对画面的**转述**（不是画面里的字） | ❌ |

PRD §5.2 说了图片走「OCR + 基础视觉识别」、视频走「字幕/旁白 + 关键帧 + OCR」，
**但没说 OCR 出来的字在证据链里比正文低一档** —— 这一档现在在这里。

蓝本 `extraction.rs:97` 的 `DESCRIBED_CEILING = LOW_CONFIDENCE_BELOW - 0.05`
是同一个判断的更细版本（`described` 连「关掉一条旧事实」都不许）。
本模块只实现 PRD 缺的那一档：**`origin != 'stated'` 的证据不许单独支撑 PASS。**

用法（不单独跑，被 verifier 与 judge 调用）：
  python3 tools/kb_clause.py            # 打印当前条款层读数
  python3 tools/kb_clause.py --assign   # 把缺失的 clause_no 写回制品（一次性迁移）
"""

import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                "research", "kb"))
import load  # noqa: E402

REPO = load.REPO
KB = load.KB
EXT_PATH = os.path.join(KB, "外部标准库-v1.json")
RULES_PATH = os.path.join(REPO, "research", "governance", "skeleton", "rules-v1.json")

LIB_NAME = "外部标准库"

# ── origin 四档 ──────────────────────────────────────────────────────
# ★ **不在这里定义。** 唯一来源是引擎侧的 `evidence_origin.py` ——
#   它同时是 PASS 收窄（`may_finalize_pass`）的家，而收窄是**判定的规矩**，
#   不是知识库的规矩。本模块只是**复用**它，免得出现两份「四档是哪四档」。
sys.path.insert(0, os.path.join(REPO, "research", "governance", "skeleton"))
import evidence_origin as EO  # noqa: E402

ORIGINS = EO.ORIGINS
ORIGIN_MEANING = EO.ORIGIN_MEANING
PASS_ORIGINS = EO.PASS_ORIGINS

# ── 条款地址（T4）────────────────────────────────────────────────────
# ★ 同上：**地址的形状不在这里定义。** T4 之后回执要在 `judge()` 内部产出
#   `evidence_ref`，而本仓的依赖方向是单向的（tools → skeleton，反向一次都没有），
#   所以地址词汇的家搬到了引擎侧 `clause_ref.py`，本模块**转发**它 ——
#   与上面转发 `ORIGINS` 是同一种做法，不是第二份定义。
#   复现：`grep -rn "^import \|^from " research/governance/skeleton/*.py | grep tools` → 0 命中。
import clause_ref as CR  # noqa: E402

REF_FIELDS = CR.REF_FIELDS
build_index = CR.load_index
clause_fp = CR.clause_fp
clause_link = CR.clause_link
ref_problems = CR.ref_problems
evidence_ref_of = CR.evidence_ref_of
evidence_refs = CR.evidence_refs
evidence_ref_problems = CR.evidence_ref_problems

#: 证据引用比普通地址多一样：**它是怎么读到的**（T19）。
# ★ `EVIDENCE_REF_FIELDS` / `evidence_ref_of` / `evidence_refs` / `evidence_ref_problems`
#   全部转发自 `clause_ref.py`（见抬头「条款地址」那一段）。

# ── T4 的转发：回执那一侧的证据块（产出 + 判据都在引擎侧）────────────
load_library = CR.load_library
source_of = CR.source_of
evidence_refs_of_rules = CR.evidence_refs_of_rules
ratification = CR.ratification
unconfirmed_notice = CR.unconfirmed_notice
evidence_block = CR.evidence_block
evidence_block_problems = CR.evidence_block_problems
receipt_evidence_problems = CR.receipt_evidence_problems
block_of = CR.block_of
BLOCK_FIELDS = CR.BLOCK_FIELDS
BLOCK_AUX_FIELDS = CR.BLOCK_AUX_FIELDS
EVIDENCE_STATUS = CR.EVIDENCE_STATUS


# ── 条文号（**本模块自有**：这里是「从位置派生地址」这条规矩的家）────────

def derived_clause_no(entry, ordinal):
    """`S1-01` 形状。**派生的**，所以 `index_problems()` 要拿它跟盘上的值比。"""
    return f"{entry.get('source_id')}-{ordinal:02d}"


def derive_all(entries):
    """按 (source_id, 文件内出现序) 派生条文号 → `{条目ID: 条文号}`。"""
    seen = {}
    out = {}
    for e in entries:
        sid = e.get("source_id")
        seen[sid] = seen.get(sid, 0) + 1
        out[e.get("id")] = derived_clause_no(e, seen[sid])
    return out


def index_problems(ext_doc):
    """条款层自身的完整性。**每一条都能指得出「改坏了会怎样」。**

    1. `clause_no` 无空值、无重复（T2 的判据：唯一率 100%、无空值）
    2. `clause_no` 必须等于按当前位置派生的值 —— 顺序一变就红，
       而不是静默指向别人（这正是「派生 key 会断」那条教训的执行点）
    3. `source_id` 必须指得出一个真实来源（悬空来源 = 引用不上原文）
    4. `origin` 必带且在那四档内
    5. `变更指纹` 必须等于重算值
    """
    bad = []
    entries = (ext_doc or {}).get("entries") or []
    sources = {s.get("id") for s in ((ext_doc or {}).get("sources") or [])}
    derived = derive_all(entries)

    nos = [e.get("clause_no") for e in entries]
    n_null = sum(1 for n in nos if not (isinstance(n, str) and n.strip()))
    if n_null:
        bad.append(f"{n_null} 条没有 clause_no（PRD §5.3 的「第 X 条」写不出来）")
    dup = sorted({n for n in nos if n and nos.count(n) > 1})
    if dup:
        bad.append(f"clause_no 不唯一：{dup[:5]}")

    for e in entries:
        eid = e.get("id", "?")
        if e.get("source_id") not in sources:
            bad.append(f"{eid}: source_id={e.get('source_id')!r} 不在 sources 里（悬空来源）")
        want = derived.get(eid)
        if e.get("clause_no") and want and e["clause_no"] != want:
            bad.append(f"{eid}: clause_no={e['clause_no']!r} ≠ 按当前位置派生的 {want!r}"
                       f"　（条目被移动过？移动会让已有引用指向别人 —— 要么改回位置，"
                       f"要么显式接受一次地址迁移）")
        o = e.get("origin")
        if o not in ORIGINS:
            bad.append(f"{eid}: origin={o!r} 不在四档内"
                       if o else f"{eid}: 没有 origin —— 一条证据不许不声明它是怎么来的")
        fp = clause_fp(e, CR.source_of(ext_doc, e.get("source_id")))
        if e.get("变更指纹") != fp:
            bad.append(f"{eid}: 变更指纹 {e.get('变更指纹')!r} ≠ 重算 {fp!r}")
    return bad


# ── T18：引用 → 条款，以及「还算数吗」────────────────────────────────

def rule_ref_problems(rule, index):
    """一条规则的 `external_ref` 整体。含 T3 的**空着不算**：
    每条 `rule_key` 要么至少一条 `external_ref`，要么显式 `no_external_basis` + 理由。
    """
    bad = []
    rk = rule.get("rule_key", "?")
    refs = rule.get("external_ref")
    if refs is None:
        if not str(rule.get("no_external_basis") or "").strip():
            bad.append(("悬空", f"{rk}: 既没有 external_ref，也没有 no_external_basis —— "
                                f"「这条规则依据什么」空着不算答案"))
        return bad
    if not refs:
        if not str(rule.get("no_external_basis") or "").strip():
            bad.append(("悬空", f"{rk}: external_ref 是空数组却没有 no_external_basis"))
        return bad
    if str(rule.get("no_external_basis") or "").strip():
        bad.append(("悬空", f"{rk}: 既有 external_ref 又声称 no_external_basis —— 二者互斥"))
    for ref in refs:
        bad += ref_problems(ref, index, where=rk)
    return bad


def rules_ref_problems(rules_doc, index, rules=None):
    """全表。顺带查**双向一致**：条目说「我关联到规则 X」而规则 X 不认账（或反过来）→ 红。

    ★ 这一条是 T17 里那句「条目自己声明的不算 cited_by」的另一半：
      单边声明不会让缺口账变绿，但它会**在这里**变红 —— 于是「单边」这件事
      既不会被当成「已引用」骗过去，也不会被无声放过。
    """
    bad = []
    rs = rules if rules is not None else (rules_doc or {}).get("rules") or []
    back = {}
    for r in rs:
        for ref in (r.get("external_ref") or []):
            if isinstance(ref, dict) and ref.get("条目ID"):
                back.setdefault(ref["条目ID"], set()).add(r.get("rule_key"))
        bad += rule_ref_problems(r, index)
    for e in index["entries"]:
        eid = e.get("id")
        fwd = set(e.get("关联规则") or [])
        bwd = back.get(eid, set())
        if fwd != bwd:
            bad.append(("单边", f"{eid}: 条目声明关联 {sorted(fwd) or '无'}，"
                                f"规则侧认账 {sorted(bwd) or '无'} —— 两边对不上。"
                                f"（单向声明不是引用，T17 的缺口账按「反向指针」记）"))
    return bad


# ── T19 的转发：证据分级与 PASS 收窄 ─────────────────────────────────

def evidence_problems(refs, where=""):
    """每条 `evidence_ref` 必带 `origin`，且在那四档内。**实现只有一处**，在引擎侧。"""
    return EO.evidence_problems(refs, where=where)


def may_finalize_pass(refs):
    """**一条判定能不能被这些证据单独推到 PASS。** 返回 `(bool, 为什么)`。

    ★ 实现唯一来源在引擎侧 `evidence_origin.py` —— 因为收窄发生在 `judge()`
      内部（`disposition` 已算出、`layer` 还没解析的那一步）。这里只做转发，
      免得「什么算 PASS 的证据」出现两份定义。
    """
    return EO.may_finalize_pass(refs)


def _dump_ext(doc):
    """按制品**原本的**序列化格式写回（indent=1、无尾换行）。

    ★ 手写格式而不是「随便 dump 一下」：`F3` 与 `E6` 都逐字读这个文件，
      而 `verify_depad.py` 会在文件被环境撑到 4096 倍数时报警 ——
      一次整文件重排会让 diff 变成 62 条而不是 62 行字段，
      下次出事时没人看得出改了什么。
    """
    return json.dumps(doc, ensure_ascii=False, indent=1)


def _dump_rules(doc):
    return json.dumps(doc, ensure_ascii=False, indent=2) + "\n"


def _insert_after(d, anchor, key, value):
    """把 `key` 插到 `anchor` 之后，保持其余键序不动。`anchor` 不在则追加在末尾。"""
    if key in d:
        d[key] = value
        return d
    out = {}
    for k, v in d.items():
        out[k] = v
        if k == anchor:
            out[key] = value
    if key not in out:
        out[key] = value
    d.clear()
    d.update(out)
    return d


def assign(ext_path=EXT_PATH, rules_path=RULES_PATH, dry=False):
    """**一次性迁移**：把 `clause_no` / `变更指纹` / `origin` 写进条目，
    并把 `external_ref` 反向写进规则表。可重复运行（幂等）。

    ★ 反向边**是从条目的 `关联规则` 派生的**，不是我另编一份关系。
      所以这条迁移不产生新知识，只把已经写下的单边关系补成双边 ——
      而补完之后 `rules_ref_problems()` 的「两边对不上」就有了对象。
    """
    ext = json.load(open(ext_path, encoding="utf-8"))
    derived = derive_all(ext.get("entries") or [])
    changed_e = 0
    for e in ext.get("entries") or []:
        src = CR.source_of(ext, e.get("source_id"))
        if e.get("clause_no") != derived[e["id"]]:
            e["clause_no"] = derived[e["id"]]
            changed_e += 1
        _insert_after(e, "条款原文", "clause_no", e["clause_no"])
        fp = clause_fp(e, src)
        if e.get("变更指纹") != fp:
            changed_e += 1
        _insert_after(e, "clause_no", "变更指纹", fp)
        if e.get("origin") != "stated":
            changed_e += 1
        #   origin 的理由要写在制品里，不能只写在代码里 ——
        #   读 JSON 的人（法务）看不到代码。这 62 条全部是**网页正文照读**：
        #   17 个来源的 `性质` 全是平台政策/监管指南/行业标准，无一条经 OCR 或转写。
        if "origin" not in e:
            _insert_after(e, "变更指纹", "origin", "stated")

    idx = build_index(ext)
    rules = json.load(open(rules_path, encoding="utf-8"))
    back = {}
    for e in ext.get("entries") or []:
        for rk in (e.get("关联规则") or []):
            back.setdefault(rk, []).append(e)
    changed_r = 0
    for r in rules["rules"]:
        rk = r.get("rule_key")
        es = back.get(rk, [])
        if es:
            want = [{"库名": LIB_NAME, "条目ID": e["id"], "条文号": e["clause_no"],
                     "链接": clause_link(e, idx["sources"].get(e.get("source_id"))),
                     "指纹": e["变更指纹"]} for e in es]
            want.sort(key=lambda x: x["条目ID"])
            if r.get("external_ref") != want:
                changed_r += 1
            _insert_after(r, "evidence_required", "external_ref", want)
            r.pop("no_external_basis", None)
        else:
            if r.get("external_ref"):
                changed_r += 1
            r.pop("external_ref", None)
            note = r.get("no_external_basis")
            if not str(note or "").strip():
                # ★ 空着不算答案（T3 的判据）—— 每条没有外部依据的规则都要说清为什么。
                note = ("本规则不引外部条款："
                        + ("规则已停用（enabled=false），不产生命中"
                           if r.get("enabled") is False else
                           "它是 permit/topic_only 节点，不是禁止性规则，不产生命中"))
                changed_r += 1
            _insert_after(r, "evidence_required", "no_external_basis", note)

    print(f"条目改动 {changed_e} 处 · 规则改动 {changed_r} 处"
          f"（有依据的规则 {len(back)} 条 / 26）")
    if dry:
        print("（--dry-run，未落盘）")
        return 0
    open(ext_path, "w", encoding="utf-8").write(_dump_ext(ext))
    open(rules_path, "w", encoding="utf-8").write(_dump_rules(rules))
    print(f"✅ 已写 {os.path.relpath(ext_path, REPO)} 与 {os.path.relpath(rules_path, REPO)}")
    return 0


def main():
    if "--assign" in sys.argv:
        return assign(dry="--dry-run" in sys.argv)
    ext = json.load(open(EXT_PATH, encoding="utf-8"))
    rules = json.load(open(RULES_PATH, encoding="utf-8"))
    idx = build_index(ext)
    ip = index_problems(ext)
    rp = rules_ref_problems(rules, idx)
    print(f"条款层：{len(idx['entries'])} 条 · 来源 {len(idx['sources'])} 个")
    print(f"  clause_no 唯一率：{len(idx['by_no'])}/{len(idx['entries'])}"
          f"　origin 分布：" + str({o: sum(1 for e in idx['entries'] if e.get('origin') == o)
                                    for o in ORIGINS}))
    print(f"  条款层自身问题 {len(ip)} 条" + (f"：{ip[:4]}" if ip else " ✅"))
    print(f"  规则侧引用问题 {len(rp)} 条" + (f"：{rp[:4]}" if rp else " ✅"))
    erefs = evidence_refs(ext)
    ep = [m for r in erefs for m in evidence_ref_problems(r, idx)]
    ok, why = EO.may_finalize_pass(erefs)
    print(f"  证据引用 {len(erefs)} 条 · 问题 {len(ep)} 条" + (f"：{ep[:3]}" if ep else " ✅"))
    print(f"  这 {len(erefs)} 条证据能不能单独支撑 PASS：{'可以' if ok else '不可以'} —— {why}")
    return 1 if (ip or rp or ep) else 0


if __name__ == "__main__":
    sys.exit(main())

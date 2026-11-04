#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""verify_engine_contract.py —— 判定引擎稳定契约的验收器（批次 A）

★ 设计原则与本项目既有验收器一致：**每一条都要能红**。

  一条只会在「全绿」时才被跑过的检查，等于没有检查。
  所以本文件里凡是有分支的检查，都在注释里写明「什么情况下它会红」。

★ 与 `tools/verify_landing.py`（批次 C）的分工：
  C 验的是**能不能拿到内容**；A 验的是**拿到内容后判得对不对、说得清不清楚**。

用法：
  python3 tools/verify_engine_contract.py            # 全量
  python3 tools/verify_engine_contract.py --json
  python3 tools/verify_engine_contract.py --only V7  # 单条
"""
from __future__ import annotations

import argparse
import contextlib
import copy
import hashlib
import io
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKEL = ROOT / "research" / "governance" / "skeleton"
sys.path.insert(0, str(SKEL))

import judge as J  # noqa: E402
import score as S  # noqa: E402
import engine_manifest as EM  # noqa: E402
import evidence_origin as EO  # noqa: E402
import matcher as _mm  # noqa: E402

RESULTS: list[tuple[str, bool, str]] = []


def check(vid: str, title: str, ok: bool, detail: str = ""):
    # Python's `and` can return the final evidence value, such as a timestamp.
    # Keep its truth value, while guaranteeing the public result is a boolean.
    ok = bool(ok)
    RESULTS.append((vid, ok, f"{title}" + (f" — {detail}" if detail else "")))
    print(f"  {'✓' if ok else '✗'} {vid}  {title}" + (f"\n        {detail}" if detail else ""))
    return ok


# 契约必须提供的字段（题面：「判定/命中规则编号/位置/降级证据/规则与词表版本/边界声明」）
REQUIRED_TOP = ["contract_version", "input", "verdict", "hits", "suggestion",
                "versions", "boundary_statement", "receipt"]
REQUIRED_VERDICT = ["disposition", "severity", "topic", "hit_count", "rules_hit",
                    "layer"]
REQUIRED_HIT = ["rule_key", "parent_rule", "topic", "severity", "disposition",
                "disposition_declared", "matched", "band", "rule_version",
                # ★ evidence_required 是 D1（机器可独立拦截）的义务之一：
                #   拦截必须说得出「凭什么能撤」——即需要哪份证明材料。
                "evidence_required"]
REQUIRED_VERSIONS = ["engine_version", "code_version", "rule_version", "vocab_version",
                     "layers_version", "contract_version", "topic_tree_version"]
REQUIRED_LAYER = ["id", "name", "who", "final_action", "machine_may_finalize"]

# 存量语料基线（`score.py` 在 291 条记录上的混淆矩阵；改造前后必须逐字一致）
#
# ★ 2026-09-23 变更一次（Q25 = 选项 A），**是变好，且是显式收紧**：
#   非主张词形遮罩（`matcher.mask_non_claims()`）让 3 条记录不再因裸 `treat` 命中 T1.1 ——
#   那 3 条本来就是误拦（语料实测 6 处 `treat yourself` 全是「Treat yourself to total comfort!」）。
#     precision 0.970 → 0.983 · f1 0.966 → 0.972 · recall 0.962 **不变** · catch_all 159 → 162
#   `catch_all` 上升不是退步：那 3 条从「被一条不成立的规则命中」变成「规则库确实没覆盖它」——
#   这是**如实**，而不是把未覆盖读成已检查（§catch_all 的注释）。recall 未动说明没漏放。
BASELINE = {"precision": 0.983, "recall": 0.962, "f1": 0.972,
            "catch_all": 162, "records": 291}

# 2026-10-21 Owner 裁定、10-26 实现：排名表达仅作非阻断提示。
# 来源：PMO/守衡-排名放开与报告后台语言-20261021.md §三；
# 10-26 落地：97a2ac57 的 rules-v1.json / T3.4.ranking-superlative。
# 旧语料标签没有这条新提示。旧 BASELINE 保持不变，另外逐条验证新增行为，
# 不把「提示新增」混算成「旧风险规则误报」，也不排除任何别的规则。
RANKING_RULE = "T3.4.ranking-superlative"


def historical_engine():
    doc = json.loads((SKEL / "rules-v1.json").read_text(encoding="utf-8"))
    doc["rules"] = [r for r in doc["rules"] if r["rule_key"] != RANKING_RULE]
    return S.Engine(doc, J.load_vocab())


def corpus_metrics(recs, eng):
    tp = fp = fn = ca = 0
    for r in recs:
        hits, is_ca = eng.assess(S.rec_text(r))
        new = {h.parent_rule for h in hits}
        old = set(r["_hit_rules"])
        ca += bool(is_ca)
        tp += len(new & old)
        fp += len(new - old)
        fn += len(old - new)
    precision = tp / (tp + fp) if tp + fp else 0
    recall = tp / (tp + fn) if tp + fn else 0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0
    return {"precision": round(precision, 3), "recall": round(recall, 3),
            "f1": round(f1, 3), "catch_all": ca, "records": len(recs)}


@contextlib.contextmanager
def using_engine(eng):
    previous = J._ENGINE
    try:
        J._ENGINE = eng
        yield
    finally:
        J._ENGINE = previous


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--only", default=None)
    a = ap.parse_args()

    # ★ `--json` 必须真的是机器可读的。原实现把人类可读的头与逐项输出一起打到
    #   stdout，尾部再追一段 JSON —— 于是 `... --json | jq` 直接解析失败，
    #   而「一个名叫 json 却不能喂给 json 解析器的开关」正是本项目反复在治的那类假接口。
    #   现在 --json 时把人读输出收进内存丢弃，stdout 只有 JSON。
    _human = io.StringIO()
    _sink = contextlib.redirect_stdout(_human) if a.json else contextlib.nullcontext()
    _sink.__enter__()

    # ★★ 2026-09-23（T4/T15）：**自证不许有副作用** —— `AGENTS.md` §2.4.4 的执行点。
    #
    #   这一整套检查会真的调 `judge(receipt=True)`（V7、V47、V48…），
    #   而回执是往 `_data/receipts.jsonl` **追加**的。生产账本只增不删、还带前缀哈希链 ——
    #   一次「跑个自证」，本来就可能永久地往审计账本里塞进几条测试记录。
    #   （这正是 `receipts.LOSS.md` 记的那次事故的形状：一条测试回执进了真账本，
    #     而账本当时没有任何字段能把它认出来。）
    #
    #   所以这里在**跑任何检查之前**把账本原样拍下来，在**全部跑完之后**逐字节比回去。
    #   ★ 为什么不是「断言源码里每个 judge 调用都传了 receipt_path」：那是文本断言，
    #     一个换行或一个别名就能骗过它（§2.4：名字出现过 ≠ 拦得住）。
    #     比字节是**行为级**的 —— 少了它，这一整套检查就从「量具」变成了「参与者」。
    _LEDGER_SNAP = None
    try:
        _LEDGER_SNAP = (SKEL / "_data" / "receipts.jsonl").read_bytes()
    except OSError as _e:                                     # noqa: BLE001
        _LEDGER_SNAP = f"<读不出：{_e}>".encode()

    print("=" * 74)
    print("判定引擎 · 稳定契约验收（批次 A）")
    print("=" * 74)

    CASES = {
        "reject": "FDA approved wearable breast pump",
        "downgrade": "Our pump does not treat any disease",
        # ★ 2026-09-23（Q23=A）：原样本是 `does not cure` —— 它在这一轮**被接通了**，
        #   于是「本可降级但守卫未接线」这条路上**一个实例都没有了**（V8a/V8c 转红）。
        #   换成仍未接线的 `relieves engorgement`（目标规则同为 T1.1），机制same，实例仍在。
        "near_miss": "Our pump treats engorgement and relieves engorgement",
        "pass_band": "FDA approved and FDA cleared wearable breast pump",
        "no_match": "Buy our lovely organic cotton baby blanket, soft and warm",
        "stem": "Painlessly pump with high efficiency",
        "multi": "FDA approved pump that does not treat any disease, whisper quiet",
    }
    R = {k: J.judge(v, product_line="吸奶器", locale="en") for k, v in CASES.items()}

    def want(vid, cond, title, detail=""):
        if a.only and not vid.startswith(a.only):
            return
        check(vid, title, cond, detail)

    # ── V1 契约完整性 ───────────────────────────────────────────────
    if not a.only or a.only.startswith("V1"):
        miss = [k for k in REQUIRED_TOP if k not in R["reject"]]
        check("V1a", "契约顶层字段齐备（8 项）", not miss, f"缺 {miss}" if miss else
              "判定/规则编号/位置/证据/版本/边界/建议/回执")
        mv = [k for k in REQUIRED_VERDICT if k not in R["reject"]["verdict"]]
        check("V1b", "verdict 字段齐备（含处置层）", not mv, f"缺 {mv}" if mv else
              f"layer={R['reject']['verdict']['layer']['id']} {R['reject']['verdict']['layer']['name']}")
        mh = [k for k in REQUIRED_HIT if k not in R["reject"]["hits"][0]]
        check("V1c", "命中项字段齐备（含 matched[].position）", not mh, f"缺 {mh}" if mh else
              "position / matched_text / band 均在")
        mver = [k for k in REQUIRED_VERSIONS if k not in R["reject"]["versions"]]
        check("V1d", "规则与词表版本齐备（含 ADR-0005 的 agent_version）", not mver,
              f"缺 {mver}" if mver else
              f"数据 {R['reject']['versions']['engine_version']} / "
              f"代码 {R['reject']['versions']['code_version']} / "
              f"{R['reject']['versions']['rule_version']}")
        check("V1e", "version 覆盖面＝『谁用哪版规则跑哪版代码』三段齐全",
              all(R["reject"]["versions"].get(k) for k in
                  ("engine_version", "code_version", "rule_version", "vocab_version")),
              "改一行契约代码 → code_version 变；改一个规则词 → engine_version 变")

    # ── V2 位置不变量：逐字可核（ADR-0008 §四）────────────────────────
    # 会红的情况：偏移算错、大小写折叠改变长度、前缀匹配下用词干当片段。
    if not a.only or a.only.startswith("V2"):
        bad, total, unlocated = [], 0, 0
        for key, text in CASES.items():
            for h in R[key]["hits"]:
                for m in h["matched"] + h["band"]["evidence"]:
                    total += 1
                    p = m["position"]
                    if not p["located"]:
                        unlocated += 1
                        continue
                    frag = text[p["start"]:p["end"]]
                    if frag != m["matched_text"] or m["matched_text"] not in text:
                        bad.append((key, m["matched_text"], p, frag))
        check("V2a", f"全部 {total} 处命中片段都是原文连续子串",
              not bad and total > 0,
              f"违反 {len(bad)} 处 {bad[:2]}" if bad else
              f"含断言 text[start:end] == matched_text；未定位 {unlocated} 处")
        check("V2b", "定位失败时给出成因而不是猜一个位置",
              all(m["position"].get("reason") or m["position"]["located"]
                  for k in CASES for h in R[k]["hits"]
                  for m in h["matched"] + h["band"]["evidence"]))

    # ── V3 词干 vs 原文的差值必须可见 ────────────────────────────────
    # 会红的情况：又退回只报关键词（下游拿词干回原文搜会搜不到）。
    # ★ 判据是**大小写敏感的**「词干是否真的出现在原文里」——
    #   旧实现给 `matched=['painlessly','painless']`，而原文里根本没有 `painless`
    #   （只有 `Painlessly`）。把两边都小写再比会漏掉这个差别（第一版就是这么漏的）。
    if not a.only or a.only.startswith("V3"):
        ms = R["stem"]["hits"][0]["matched"]
        missing = [m["matched_keyword"] for m in ms
                   if m["matched_keyword"] not in CASES["stem"]]
        check("V3", "前缀匹配下『词干 ≠ 原文写法』被显式暴露",
              bool(missing)
              and all(m["matched_text"] in CASES["stem"] for m in ms),
              f"原文 {CASES['stem']!r}；词干 {sorted(m['matched_keyword'] for m in ms)} "
              f"中有 {missing} **不在原文里**；原文片段 "
              f"{sorted({m['matched_text'] for m in ms})} 全部可核")

    # ── V4 未命中 ≠ 合规（ADR-0005 约束 3）──────────────────────────
    if not a.only or a.only.startswith("V4"):
        nm = R["no_match"]
        check("V4a", "零命中 → disposition=catch_all（不与 auto_pass 合并）",
              nm["verdict"]["disposition"] == "catch_all",
              nm["verdict"]["disposition"])
        check("V4b", "零命中 → suggestion 不是『直接发布』",
              nm["suggestion"] == "转人工", f"suggestion={nm['suggestion']!r}")
        check("V4c", "零命中 → unknowns 显式写明覆盖率不足",
              any("不是合规" in u or "不等于合规" in u for u in nm["boundary_statement"]["unknowns"]),
              f"unknowns 共 {len(nm['boundary_statement']['unknowns'])} 条")
        check("V4d", "未命中时报为『未覆盖』而非『未发现问题』",
              "没有覆盖它" in json.dumps(nm["verdict"], ensure_ascii=False))

    # ── V5 处置聚合取最严 ───────────────────────────────────────────
    if not a.only or a.only.startswith("V5"):
        m = R["multi"]["verdict"]
        ds = {h["disposition"] for h in R["multi"]["hits"]}
        check("V5", "多条命中时 disposition 取最严",
              len(ds) > 1 and m["disposition"] == "auto_reject",
              f"各命中 {sorted(ds)} → 记录级 {m['disposition']}")
        worst = max(R["reject"]["hits"], key=lambda x: x["severity"])
        check("V5b", "记录级 severity 取最严", m["severity"] == "L4", m["severity"])

    # ── V6 分层映射是数据驱动，不是硬编码 ────────────────────────────
    # 会红的情况：把层级名/落点写死在 judge.py 里（法务改表不生效 → 违反 ADR-0008 §三）。
    if not a.only or a.only.startswith("V6"):
        orig = J.LAYERS_PATH
        try:
            lay = json.loads(orig.read_text(encoding="utf-8"))
            lay["mapping"]["catch_all"]["layer_id"] = "L4"
            lay["layers"].append({"id": "L9", "name": "测试层", "who": "测试",
                                  "can_finalize": True, "meaning": "验收用"})
            lay["mapping"]["auto_reject"]["layer_id"] = "L9"
            tmp = Path(tempfile.mkdtemp()) / "layers.json"
            tmp.write_text(json.dumps(lay, ensure_ascii=False), encoding="utf-8")
            J.LAYERS_PATH = tmp
            j2 = J.judge(CASES["no_match"])
            j3 = J.judge(CASES["reject"])
            ok = (j2["verdict"]["layer"]["id"] == "L4"
                  and j3["verdict"]["layer"]["name"] == "测试层")
            check("V6", "改映射表即改处置层（无需改代码）", ok,
                  f"catch_all→{j2['verdict']['layer']['id']}，auto_reject→{j3['verdict']['layer']['name']}")
        finally:
            J.LAYERS_PATH = orig
        after = J.judge(CASES["reject"])["verdict"]["layer"]["id"]
        check("V6b", "还原映射表后恢复原状", after == "DP2", f"恢复为 {after}")

    # ── V7 回执（ADR-0005 约束 5）──────────────────────────────────
    if not a.only or a.only.startswith("V7"):
        tmpdir = Path(tempfile.mkdtemp())
        rp = tmpdir / "r.jsonl"
        rc = J.judge(CASES["reject"], receipt=True, receipt_path=rp,
                     origin="test")["receipt"]
        need = ["run_id", "input_sha256", "rule_version", "engine_version",
                "code_version", "vocab_version"]
        check("V7a", "回执含 ADR-0005 约束 5 要求的字段",
              all(k in rc for k in need), f"{need}")
        check("V7a2", "回执带来源标记（审计日志要分得出测试与真判定）",
              rc.get("origin") == "test"
              and J.judge(CASES["no_match"], receipt=True,
                          receipt_path=tmpdir / "r2.jsonl")["receipt"]["origin"] == "cli",
              "显式传入为 'test'；默认 'cli'；守衡传 'shouheng'")
        recomp = hashlib.sha256(CASES["reject"].encode()).hexdigest()
        check("V7b", "input_sha256 可独立复算",
              rc["input_sha256"] == recomp, rc["input_sha256"][:16] + "…")
        vd = J.judge(CASES["reject"])
        vd_core = {k: v for k, v in vd.items() if k != "receipt"}
        digest = hashlib.sha256(json.dumps(vd_core, ensure_ascii=False,
                                           sort_keys=True).encode()).hexdigest()
        check("V7c", "verdict_digest 把回执钉在**结论**上（不只是输入）",
              rc["verdict_digest"] == digest, digest[:16] + "…")
        blob = rp.read_text(encoding="utf-8")
        # ★★ 2026-09-23（T4）：这一条原先是对**整行**做固定词表扫描，而 T4 之后
        #    回执里多了一类**设计上就该在**的文本：条款地址（库名/条目ID/条文号/链接）。
        #    平台政策页的 slug 天然带 `breast-pumps`、`it-really-fda-approved` 这种词，
        #    于是「只存 sha256」这句**正确的结论**会被**公开链接**报成泄漏。
        #
        #    ★ 处置不是把词表放宽（那会让判据在真正要紧的词上失明 —— §2.4.1），
        #      而是把扫描区域收窄到一个**说得清的对象**：排除的只有 `evidence_ref[]`
        #      里那四个**派生字段** —— 而 `clause_ref.ref_problems()` 现在断言它们
        #      逐条等于按条目重算的值（含 `链接`），所以那几个字段里藏不了东西。
        #      排除发生在哪几个键上，下面逐条说清楚。
        _scan = json.loads(blob.strip().split("\n")[-1])
        _n_ref = len(_scan.get("evidence_ref") or [])
        _addr = []
        for _r in (_scan.get("evidence_ref") or []):
            _addr += [str(_r.pop(_k, "")) for _k in ("库名", "条目ID", "条文号", "链接")]
        if _n_ref:
            _scan["evidence_ref"] = f"<{_n_ref} 条条款地址：四个派生字段已单独逐条校验>"
        scan_text = json.dumps(_scan, ensure_ascii=False)
        leaked = [w for w in ("FDA", "approved", "breast", "pump") if w in scan_text]
        check("V7d", "回执不落原文与片段（ADR-0008 决策 2）—— 扫描区域**只**排除条款地址那四个派生字段",
              (not leaked) and bool(_addr) and all(_addr),
              (f"其余字段零泄漏；排除的 {_n_ref} 条地址（{len(_addr)} 个字段全部非空）"
               f"逐条等于按条目重算的值 —— 由 `ref_problems()` 的「链接也必须是派生值」守着"
               if not leaked else f"❌ 排除的地址字段之外仍有泄漏 {leaked}"))
        lines = [json.loads(x) for x in blob.strip().split("\n") if x.strip()]
        check("V7e", "回执为追加式（append-only）且逐行可解析",
              len(lines) == 1 and lines[0]["run_id"] == rc["run_id"])
        J.judge(CASES["reject"], receipt=True, receipt_path=rp)
        n2 = len([x for x in rp.read_text(encoding="utf-8").strip().split("\n") if x.strip()])
        check("V7f", "第二次判定追加而不是覆盖", n2 == 2, f"{n2} 行")

    # ── V8 未接线守卫必须具名可见 ───────────────────────────────────
    # 会红的情况：「红线」与「本可降级但因词形未补全而成了红线」被渲染成同一行。
    #
    # ★★ 2026-09-23（Q26 = 选项 A）：这一组**两次**失去真实样本，处置都是「换样本 / 改构造式」，
    #   而不是放宽断言 —— 记下来，因为它是「断言转红 ≠ 引擎坏了」的稳定来源：
    #     · Q23 接通 18 个词 → 原样本 `does not cure` 被接通；
    #     · Q26 接通 16 个词 → 换上的样本 `relieves engorgement` **也被接通**；
    #     · 剩下 2 个法语词（`soulage/soulager les engorgements`）**构造不出 near-miss**
    #       （目标规则 T1.1 的匹配词是 en/zh，法语词与它不共现）。
    #   于是改成**构造式**：临时替换 `judge.unwired_guards()` 注入一个未接线守卫，
    #   断言机制仍会具名报出、且带成因。断言测的是**机制**，不是某个具体的词。
    if not a.only or a.only.startswith("V8"):
        _nm_word = {"word": "ZZ 未接线守卫样本", "status": "pending",
                    "downgrades": ["T1.1.medical-cure"],
                    "effect": "auto_reject → manual_review",
                    "wire_gap": "自证构造的成因（非 None —— 这条断言要的不是「未接线」四个字）",
                    "status_note": "自证构造"}
        _txt_nm = "Our pump treats engorgement and ZZ 未接线守卫样本"
        _orig_unwired = J.unwired_guards
        try:
            J.unwired_guards = lambda: [_nm_word]
            _r_nm = J.judge(_txt_nm, product_line="吸奶器", locale="en")
        finally:
            J.unwired_guards = _orig_unwired
        _h_nm = _r_nm["hits"][0] if _r_nm["hits"] else {}
        nm = _h_nm.get("unwired_guard_near_miss", [])
        names = {x["word"] for x in nm}
        _real_unwired = J.unwired_guards()
        check("V8a", "『本可降级但守卫未接线』被具名报出（★ 构造式 —— 今天无真实实例）",
              "ZZ 未接线守卫样本" in names and _h_nm.get("disposition") == "auto_reject",
              f"报出 {sorted(names)} · 该命中仍是 {_h_nm.get('disposition')}（未接线 → 不改写处置）· "
              f"今天真实未接线守卫 {len(_real_unwired)} 个、其中能共现的 0 个")
        gap = next((x.get("wire_gap") for x in nm if x["word"] == "ZZ 未接线守卫样本"), None)
        check("V8c", "给出缺口成因（不是只说『未接线』）", bool(gap), str(gap))
        check("V8b", "对照：**已接线**的同一族词确实会降级（真实数据，`does not treat` 由 Q23 接通）",
              R["downgrade"]["hits"][0]["disposition"] == "manual_review",
              f"does not treat（已接线）→ {R['downgrade']['hits'][0]['disposition']}")

    # ── V9 放行带会响（正对照）────────────────────────────────────
    # 会红的情况：pass_of 又变成零调用者 —— 缺陷 1 回归。存量语料**测不出**它，
    # 因为 291 条里没有一条同时含判险词与放行词（实测 0 次）。所以必须用构造用例。
    if not a.only or a.only.startswith("V9"):
        ph = R["pass_band"]["hits"][0]
        check("V9a", "放行带可触发：band.kind == 'pass'",
              ph["band"]["kind"] == "pass",
              f"{ph['disposition_declared']} → {ph['disposition']}（{ph['band']['effect']}）")
        check("V9b", "放行带证据带位置与原文片段",
              bool(ph["band"]["evidence"]) and ph["band"]["evidence"][0]["position"]["located"],
              f"{ph['band']['evidence'][0]['matched_text']!r}"
              f" @{ph['band']['evidence'][0]['position']['start']}")
        check("V9c", "对照：只有豁免词、无判险词时不产生命中（合规表达不该被记一笔）",
              J.judge("FDA cleared wearable breast pump")["verdict"]["disposition"] == "catch_all",
              "FDA cleared 单独出现 → 零命中。它落 CATCH-ALL 而非『合规』桶")

    # ── V10 边界声明永不为空（ADR-0005 约束 1）─────────────────────
    if not a.only or a.only.startswith("V10"):
        empt = [k for k in CASES if not R[k]["boundary_statement"]["unknowns"]]
        check("V10a", "所有用例的 unknowns 都非空（ADR-0005 约束 1 不允许空数组）",
              not empt, f"空的：{empt}" if empt else
              f"每例 {min(len(R[k]['boundary_statement']['unknowns']) for k in CASES)}–"
              f"{max(len(R[k]['boundary_statement']['unknowns']) for k in CASES)} 条")
        has = R["reject"]["boundary_statement"]["rule_coverage"]
        check("V10b", "边界声明给出可复核的覆盖计量",
              has["guards_declared"] > has["guards_active"] > 0,
              f"守卫 声明{has['guards_declared']} / 生效{has['guards_active']} / "
              f"未接线{has['guards_unwired']}")
        langs = J.judge("Brustpumpe", locale="de")["boundary_statement"]["unknowns"]
        check("V10c", "非 en/zh 语种额外声明词表覆盖不均",
              any("语种覆盖不均" in u for u in langs))

    # ── V11 版本可追溯：制品一变，版本就变 ───────────────────────────
    # 会红的情况：版本号变成手写字符串（第一次忘记改就开始撒谎）。
    if not a.only or a.only.startswith("V11"):
        tmp = Path(tempfile.mkdtemp()) / "skel"
        shutil.copytree(SKEL, tmp, ignore=shutil.ignore_patterns("_data", "__pycache__"))
        # ★ 2026-09-17 补：**先建立干净基线**。
        #
        #   V11b 原先只断言「改动后 --check 红」。可是副本是从真目录拷的 ——
        #   真目录一旦漂移（manifest 落后于制品），副本**拷出来就已经是红的**，
        #   于是 V11b 在「什么都不做」时也满足判据 = **假绿**。
        #   实测（2026-09-17，真目录 manifest 落后 3 个制品时）：副本未做任何改动，
        #   `--check` 已是 exit=1。也就是说这个门恰好在它最该起作用的时候失效了。
        #   修法：先 --write 固化副本，断言基线为 0，再改动。这样红才是**我这一改**造成的。
        subprocess.run([sys.executable, "engine_manifest.py", "--write"], cwd=tmp,
                       capture_output=True, text=True)
        base = subprocess.run([sys.executable, "engine_manifest.py", "--check"], cwd=tmp,
                              capture_output=True, text=True)
        v0 = subprocess.run([sys.executable, "engine_manifest.py", "--json"], cwd=tmp,
                            capture_output=True, text=True)
        e0 = json.loads(v0.stdout)["engine_version"]
        p = tmp / "rules-v1.json"
        doc = json.loads(p.read_text(encoding="utf-8"))
        doc["rules"][0]["severity"] = "L2"          # 改动一个字节级别的内容
        p.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
        v1 = subprocess.run([sys.executable, "engine_manifest.py", "--json"], cwd=tmp,
                            capture_output=True, text=True)
        e1 = json.loads(v1.stdout)["engine_version"]
        ck = subprocess.run([sys.executable, "engine_manifest.py", "--check"], cwd=tmp,
                            capture_output=True, text=True)
        check("V11a", "规则内容一变，engine_version 就变",
              e0 != e1, f"{e0} → {e1}")
        check("V11b", "manifest 落后于制品时 --check 硬失败（且基线已证干净）",
              base.returncode == 0 and ck.returncode == 1 and "sha256 不符" in ck.stderr,
              f"基线={base.returncode} 改动后={ck.returncode}")
        again = json.loads(subprocess.run([sys.executable, "engine_manifest.py", "--json"],
                                          cwd=tmp, capture_output=True, text=True).stdout)
        check("V11c", "同内容重算版本号稳定（可复现）", again["engine_version"] == e1)
        shutil.rmtree(tmp, ignore_errors=True)

        # ★ 2026-09-17 加 V11d：**对真目录**跑 --check。
        #
        #   V11a–V11c 全部在临时副本里跑（cwd=tmp），所以它们在原理上**看不见真目录的漂移**：
        #   副本是拷出来的，拷贝那一刻是什么状态，门就测什么状态。
        #   实测的代价（2026-09-17）：真目录的 manifest 从 2026-09-16 18:07 起就落后
        #   三个制品（rules / disposition_layers / product_lines 在 18:22–18:50 被改过），
        #   而**六套验收全绿**，这个红躲了整整一天。
        #   反向对照由上面加固后的 V11b 提供 —— 同一条命令、同一种漂移、已证能红且因果干净。
        real = subprocess.run([sys.executable, "engine_manifest.py", "--check"], cwd=SKEL,
                              capture_output=True, text=True)
        # 这一条不是恒真的：它把「门检查的那份 manifest」与「引擎真的读的那份」绑在一起。
        # 引擎是本模块从真 SKEL 导入的，所以两者必须相等 —— 一旦有人把 SKEL 指到副本、
        # 或引擎改了取版本的路径，这里会红，而不是静默退化成 V11b 的重复。
        real_ver = json.loads((SKEL / "engine-manifest.json").read_text(encoding="utf-8"))["engine_version"]
        stamp = J.judge(CASES["multi"])["versions"]["engine_version"]
        check("V11d", "**真目录**的制品与 manifest 一致，且引擎盖在判定上的版本就是它",
              real.returncode == 0 and stamp == real_ver,
              f"check exit={real.returncode} · manifest={real_ver} · 判定盖的={stamp}"
              + ("" if real.returncode == 0 else
                 "；跑 --write 重新固化并提交（ADR-0002：改判定制品必须同时冻结版本）"))

    # ── V12 确定性 ─────────────────────────────────────────────────
    if not a.only or a.only.startswith("V12"):
        a1 = json.dumps(J.judge(CASES["multi"]), ensure_ascii=False, sort_keys=True)
        a2 = json.dumps(J.judge(CASES["multi"]), ensure_ascii=False, sort_keys=True)
        check("V12a", "同输入两次判定逐字一致（无时间/随机依赖）", a1 == a2,
              f"{len(a1)} 字节")
        r1 = J.judge(CASES["multi"], receipt=True, receipt_path=Path(tempfile.mkdtemp()) / "r.jsonl")
        check("V12b", "发回执时才引入时间，且时间不进 verdict",
              json.dumps(J.judge(CASES["multi"]), ensure_ascii=False, sort_keys=True) == a2
              and r1["receipt"]["issued_at"])

    # ── V13 存量语料零回归 ──────────────────────────────────────────
    if not a.only or a.only.startswith("V13"):
        recs = json.loads((SKEL / "_data" / "records.json").read_text(encoding="utf-8"))
        got = corpus_metrics(recs, historical_engine())
        current = corpus_metrics(recs, J.engine())
        # 反向对照：真的停掉一条旧医疗规则，原基线必须红。
        mutated = historical_engine()
        mutated.rules = [r for r in mutated.rules if r["rule_key"] != "T2.1.2.pain-relief"]
        mutation = corpus_metrics(recs, mutated)
        check("V13", "历史风险口径保持原混淆矩阵；已授权排名提示另验，不重写旧基线",
              got == BASELINE and mutation != BASELINE,
              f"历史口径 {got} vs 基线 {BASELINE}；含新提示的源标签一致率 {current}；"
              f"停掉医疗规则的反向对照={'红' if mutation != BASELINE else '失效'}")

    # ── V14 匹配原语只有一份实现 ────────────────────────────────────
    # 会红的情况：有人在 score.py 里又写一份查找逻辑（本项目已因此出过两次事）。
    # ★ 检查用 AST 找**真实调用**，不在源码文本里搜字符串 ——
    #   第一版就是文本匹配，把「文档字符串里引用旧代码」误判成违规（V14c 假红）。
    #   一个会误报的检查最后一定会被关掉，那比没有检查更糟。
    if not a.only or a.only.startswith("V14"):
        import ast

        def call_names(path: Path) -> set[str]:
            """收集**真实调用**的名字。属性调用记成 `模块.函数`，裸调用记成 `函数`。

            ★ 第一版把属性调用的 `.attr` 当成完整名，于是 `_m.find_literal(...)`
              看起来叫 `find_literal` 而不叫 `_find_literal` —— 检查自己写错了，
              却报成代码违规。所以这里把限定名拼出来。
            """
            out = set()
            for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
                if not isinstance(node, ast.Call):
                    continue
                f = node.func
                if isinstance(f, ast.Attribute):
                    base = f.value.id if isinstance(f.value, ast.Name) else None
                    out.add(f"{base}.{f.attr}" if base else f.attr)
                elif isinstance(f, ast.Name):
                    out.add(f.id)
            return out

        calls = call_names(SKEL / "score.py")
        check("V14a", "score.py 的 _find_literal 已委托 matcher（无第二份实现）",
              "_m.find_literal" in calls and "_find_literal" not in calls,
              f"score.py 内的匹配调用：{sorted(c for c in calls if 'literal' in c or 'match' in c)}")
        check("V14b", "score.py 不再自己调 re.search / re.finditer 做规则匹配",
              not ({"re.search", "re.finditer", "re.match"} & calls),
              "匹配全部走 matcher（re.compile 仅用于解析主题树）")
        jcalls = call_names(SKEL / "judge.py")
        check("V14c", "judge.py 不自建匹配（只经 score.Engine.assess）",
              "eng.assess" in jcalls and not ({"_m.find_literal_all", "_m.find_matches",
                                               "_m.match_text", "find_literal_all",
                                               "find_matches", "match_text"} & jcalls),
              "判定与契约分离")

    # ── V15 ADR-0005 约束 2：机器不替人过门 ─────────────────────────
    # ★ 同样修过一次假红：第一版在整份输出里搜「无需处理」，结果逮到了
    #   judge.py 自己写的那句「机器不能把任何状态改成『无需处理』」——
    #   一句**否定**被当成了违规。检查的是取值，不是字符串。
    if not a.only or a.only.startswith("V15"):
        allowed_sug = {"直接发布", "转人工", "需修改"}
        bad_sug = {k: R[k]["suggestion"] for k in CASES if R[k]["suggestion"] not in allowed_sug}
        check("V15a", "suggestion 恒为 ADR-0005 约束 1 的三个允许值之一",
              not bad_sug, f"越界 {bad_sug}" if bad_sug else
              f"取值分布 {sorted({R[k]['suggestion'] for k in CASES})}")
        final_states = {"已通过", "无需处理", "已放行", "审核通过", "已发布"}
        got = {R[k]["verdict"]["disposition"] for k in CASES}
        check("V15a2", "disposition 从不取业务终态（机器无权封状态）",
              not (got & final_states) and got <= set(J.DISPOSITION_PRECEDENCE) | {"catch_all"},
              f"实际取值 {sorted(got)}")
        jsrc = (SKEL / "judge.py").read_text(encoding="utf-8")
        check("V15b", "judge.py 不写任何业务记录状态字段",
              not re.search(r'["\']处理状态["\']\s*[:=]', jsrc),
              "只产出建议与证据，不改记录")
        ap = [k for k in CASES if R[k]["verdict"]["disposition"] == "auto_pass"]
        check("V15c", "auto_pass 的处置层不是机器终结（退回提交人）",
              all(R[k]["verdict"]["layer"]["machine_may_finalize"] is False for k in ap)
              and R["pass_band"]["verdict"]["layer"]["id"] == "DP1",
              f"layer={R['pass_band']['verdict']['layer']['id']} "
              f"{R['pass_band']['verdict']['layer']['name']}")

    # ── V16 分级映射表的权威性与待决项必须可见 ──────────────────────
    if not a.only or a.only.startswith("V16"):
        lay = json.loads((SKEL / "disposition-layers-v1.json").read_text(encoding="utf-8"))
        # ★ 这一条 2026-09-16 改过极性，原因值得留下：
        #   原来断言 `status == "proposed"`。法务确认（D1）之后它变红 ——
        #   变红本身是对的（世界变了，检查应声而红），但断言**固定值**是错的写法：
        #   它把「今天处于哪个阶段」写死进检查，于是每次阶段推进都得改检查，
        #   而改检查的人很可能顺手把它删掉。
        #   正确的断言是**一致性**：无论 proposed 还是 ratified，输出里的标记
        #   必须与表的真实状态一致；且 ratified 必须留下确认人与日期。
        st = lay.get("status")
        out_st = R["reject"]["verdict"]["layer"]["table_status"]
        ratified_ok = (st != "ratified") or bool(lay.get("decided_by") and lay.get("decided_at"))
        check("V16a", "映射表权威性状态如实透传到输出（ratified 必须有确认人与日期）",
              st == out_st and ratified_ok,
              f"表 status={st} · 输出 table_status={out_st} · "
              f"decided_by={lay.get('decided_by')} · decided_at={lay.get('decided_at')}")
        # ★ 2026-09-16（D12）：原断言 `len($open_questions_for_legal) >= 4`。
        #   它守的是「表里还留着未决问题」，但它**默许了第二份副本存在** ——
        #   而两处已经真实地不一致了（台账只有 Q7，本表留着 Q1–Q7）。
        #   现在改成守**单一书写位置**：本表不得自带问题数组，只能放指针 + ID 索引。
        #   「不留副本」的完整断言在 V30d（它同时管派生的 ID 索引）；本条的职责是
        #   「表里必须有一个指得出未决清单的指针」，免得未决状态在本表里被静默当已定。
        check("V16b", "映射表把未决问题交给台账，不在本表里静默当已定（D12）",
              bool(lay.get("$decision_queue_ref"))
              and "$open_questions_for_legal" not in lay,
              f"ref={lay.get('$decision_queue_ref')!r}（清单与状态以台账为准，见 V30d）")
        # ★ 2026-09-16（D8）：原断言 `len(layers) == 4`。D5 加了 DP0 之后它变红。
        #   和 V16a 同一种错写法：把**当时的数量**写进检查，于是每次加一层都要改检查，
        #   而改检查的人可能顺手把断言删掉。改成检查**引用完整性** —— 那才是真正要守的东西：
        #   每一处指向层级的 id 都必须指向一个真实存在的层级。层级数量本身不是不变量。
        _ids = {l["id"] for l in lay["layers"]}
        _refs = ({m["layer_id"] for m in lay["mapping"].values()}
                 | {p["layer_id"] for p in lay.get("preconditions", [])}
                 | {e["to_layer_id"] for e in lay.get("escalate_if", [])})
        _dangling = sorted(_refs - _ids)
        check("V16c", "层级引用完整（mapping/preconditions/escalate 指向的层都必须存在）",
              not _dangling
              and {"DP0", "DP1", "DP2", "DP3", "DP4"} <= _ids
              and all("can_finalize" in l for l in lay["layers"]),
              (f"层级 {'/'.join(l['id'] for l in lay['layers'])}"
               + (f" · ❌ 悬空引用 {_dangling}" if _dangling else " · 无悬空引用")))
        check("V16e", "层级 ID 不与风险等级同名（这两个命名空间语义相反）",
              not any(str(l["id"]).startswith("L") for l in lay["layers"])
              and all(str(m).startswith("L") for m in
                      {r.get("severity") for r in json.loads(
                          (SKEL / "rules-v1.json").read_text(encoding="utf-8"))["rules"]}),
              "层级 " + "/".join(l["id"] for l in lay["layers"])
              + " · 风险等级 L0–L5（severity）—— 前缀不同，同一份 verdict 里不再撞名")
        check("V16f", "每一行都点名了一条决定（表级 status 不再替每一行背书）",
              all("$decision" in m for m in lay["mapping"].values())
              and all("$decision" in l for l in lay["layers"])
              and bool(lay.get("ratification_scope")),
              "mapping 行 " + str(sum(1 for m in lay["mapping"].values() if "$decision" in m))
              + f"/{len(lay['mapping'])} · ratification_scope="
              + str(sorted((lay.get("ratification_scope") or {}).keys())))
        check("V16d", "未知 disposition 不会被静默放行",
              J.resolve_layer("不存在的档", [], lay)["machine_may_finalize"] is False
              and "未在分层表中定义" in J.resolve_layer("不存在的档", [], lay)["name"])

    # ── V17 品线维度：机制必须是「活的」 ─────────────────────────────
    # 会红的情况：product_line 被收下却完全没用，且没有任何东西提示调用方 ——
    # 下游会以为「传了品线 = 判得更准」，而实际什么都没发生。
    if not a.only or a.only.startswith("V17"):
        plain = J.judge(CASES["reject"])
        withpl = J.judge(CASES["reject"], product_line="吸奶器")
        check("V17a", "未声明品线时，传与不传结果一致（不假装过滤）",
              plain["verdict"]["disposition"] == withpl["verdict"]["disposition"],
              f"两者均为 {withpl['verdict']['disposition']}")
        u0 = withpl["boundary_statement"]["unknowns"][0]
        check("V17b", "边界声明区分『支持但没填』与『不支持』",
              ("机制已就绪" in u0 and "数据未填" in u0 and "product_lines" in u0),
              u0[:96] + "…")

        # 注入一条品线归属，证明过滤机制是活的（而不是永远返回全集）。
        # ★ 注入走的是**产品唯一该写的位置**（product-lines-v1.json 的 assignments），
        #   不是往 rules-v1.json 里塞 —— 引擎对后者会硬失败（两处真相）。
        rules_doc = json.loads((SKEL / "rules-v1.json").read_text(encoding="utf-8"))
        eng2 = S.Engine(rules_doc, J.engine().vocab)
        eng2.line_assignments = {"T6.1.regulatory-status": ["暖奶器"]}
        eng2._apply_line_assignments()
        n_all = len(eng2.rules_for(None))
        n_matched = len(eng2.rules_for("暖奶器"))
        n_other = len(eng2.rules_for("吸奶器"))
        check("V17c", "规则一旦声明 product_lines，过滤立刻生效",
              n_matched == n_all and n_other == n_all - 1,
              f"全集 {n_all} · 声明 暖奶器 → {n_matched} · 其他品线 吸奶器 → {n_other}"
              f"（T6.1 被正确排除，未声明的 {n_all - 1} 条仍适用全部品线）")
        h_other, _ = eng2.assess(CASES["reject"], product_line="吸奶器")
        h_hit, _ = eng2.assess(CASES["reject"], product_line="暖奶器")
        check("V17d", "过滤改变的是判定结果本身（不是只改一行说明）",
              len(h_other) == 0 and len(h_hit) == 1,
              f"吸奶器 → {len(h_other)} 命中；暖奶器 → {len(h_hit)} 命中")
        j1 = J.judge(CASES["reject"], product_line="暖奶器")
        check("V17e", "judge 层把品线透传到了引擎",
              "暖奶器" in J.judge(CASES["reject"], product_line="暖奶器")["input"]["product_line"],
              f"contract 记录 product_line；过滤发生在 Engine.rules_for")

    # ══════════════════════════════════════════════════════════════════
    # V20–V23 ｜ 2026-09-16 法务四项决定的落地验收
    #   共同原则：**台账说的必须与制品里有的逐条一致**。
    #   一个只写不改的台账，比没有台账更坏 —— 它会把「我们决定过」变成一句无法核对的声明。
    # ══════════════════════════════════════════════════════════════════
    LEDGER = SKEL / "legal-decisions-v1.json"

    # ── V20 决策台账 ↔ 制品一致性 ───────────────────────────────────
    if not a.only or a.only.startswith("V20"):
        led = json.loads(LEDGER.read_text(encoding="utf-8")) if LEDGER.exists() else {}
        ids = [d.get("id") for d in led.get("decisions") or []]
        check("V20a", "决策台账存在且 ID 连续无重复（决定只增不改，改动靠新增一条）",
              bool(ids) and ids == [f"D{i}" for i in range(1, len(ids) + 1)],
              f"{len(ids)} 条：{', '.join(ids)}")
        # 会红的情况：新增一条决定却忘了写验证命令（于是它永远不会被跑）
        nogate = [d["id"] for d in led.get("decisions") or []
                  if not str(d.get("verification") or "").strip()]
        check("V20b", "每条决定都写明验证方式（决定不能只有结论没有检查）",
              not nogate, f"缺验证方式：{nogate}" if nogate else "D1–D4 均有 verification")
        # 会红的情况：义务被标成 met 却没有证据，或 unmet 却没有主人/原因
        bad_ob = []
        for d in led.get("decisions") or []:
            for ob in d.get("obligations") or []:
                if ob.get("status") == "met" and not str(ob.get("evidence") or "").strip():
                    bad_ob.append(f"{ob.get('id')}: met 但无证据")
                if ob.get("status") == "unmet" and not (ob.get("owner") or ob.get("why_not_implemented_here")):
                    bad_ob.append(f"{ob.get('id')}: unmet 但无责任人/无原因")
        check("V20c", "义务清单自洽（met 有证据 / unmet 有主人或有原因）",
              not bad_ob, f"{bad_ob}" if bad_ob else
              "D1-O3a（申诉政策）met 有证据 · D1-O3b（送达管道）unmet 有 owner + 原因")

        # D1 ↔ 处置表
        layers = json.loads((SKEL / "disposition-layers-v1.json").read_text(encoding="utf-8"))
        row = (layers.get("mapping") or {}).get("auto_reject") or {}
        check("V20d", "D1 落地：处置表 ratified 且 auto_reject 允许机器独立拦截",
              layers.get("status") == "ratified" and row.get("machine_may_finalize") is True,
              f"status={layers.get('status')} · machine_may_finalize={row.get('machine_may_finalize')}"
              f" · decided_at={layers.get('decided_at')}")

        # D3 ↔ 词表：台账说迁了 4 个词，两张表必须真的是这个状态
        wl = json.loads((SKEL / "whitelist-v1.json").read_text(encoding="utf-8"))
        gd = json.loads((SKEL / "context-guards-v1.json").read_text(encoding="utf-8"))
        moved = [("FDA 注册", "T6.1.regulatory-status"), ("silent mode", "T2.2.quiet-claim"),
                 ("静音模式", "T2.2.quiet-claim"), ("suction settings", "T2.2.suction-claim")]
        wlmap = {w["word"]: w for w in wl["words"]}
        gdwords = {w["word"] for w in gd["words"]}
        mig = [w for w, _ in moved]
        check("V20e", "D3 落地：4 个词已在白名单表且已从守卫表移除",
              all(w in wlmap for w in mig) and not (set(mig) & gdwords),
              f"白名单命中 {sum(1 for w in mig if w in wlmap)}/4 · "
              f"守卫表残留 {sorted(set(mig) & gdwords)}")
        wrong_target = [w for w, rk in moved
                        if rk not in (wlmap.get(w, {}).get("exempts_rule_keys") or [])]
        check("V20f", "D3 落地：4 个词的 exempts 指回原规则（没有迁到别处）",
              not wrong_target, f"{wrong_target}" if wrong_target else
              "指回 T6.1 / T2.2.quiet-claim / T2.2.suction-claim")
        check("V20g", "D3 的迁移留下了可追溯来源（$migrated_from + $decision）",
              all(wlmap.get(w, {}).get("$migrated_from") and wlmap.get(w, {}).get("$decision")
                  for w in mig),
              "每条都记了从哪来、按哪条决定来的")

    # ── V21 D1 的后果：机器独立拦截必须留下可申诉的最小证据集 ─────────
    # 会红的情况：某天有人把 evidence_required 或 position 从命中项里去掉 ——
    # 那时「机器可以独立拦下」就变成「机器可以独立拦下且说不出凭什么」。
    if not a.only or a.only.startswith("V21"):
        h = R["reject"]["hits"][0]
        need = ["rule_key", "parent_rule", "matched", "band", "evidence_required"]
        missing = [k for k in need if k not in h]
        check("V21a", "机器独立拦截的判定带齐最小证据集（规则/位置/带/所需材料）",
              not missing, f"缺 {missing}" if missing else
              f"{h['rule_key']} · 位置 {h['matched'][0]['position']} · 需 {h['evidence_required']!r}")
        lay = R["reject"]["verdict"]["layer"]
        check("V21b", "判定自己声明了终结权归属（谁能否终结、是否需要人看）",
              "machine_may_finalize" in lay and "human_must_see" in lay,
              f"{lay['id']} {lay['name']} · 机器可终结={lay['machine_may_finalize']} · "
              f"人必须看={lay['human_must_see']}")
        # ★ 会红的情况：有人把 _layer_note 写死回一句静态免责声明。
        #   分层表 ratified 之后仍说「未经确认」，是把已授权的映射说成草案 —— 同样在骗读者。
        note = lay.get("$table_note", "")
        check("V21c", "层级权威性说明随表状态变（ratified 时不再自称草案）",
              (lay.get("table_status") == "ratified" and "不得作为业务承诺引用" not in note)
              or (lay.get("table_status") != "ratified" and "不得作为业务承诺引用" in note),
              note[:100] + "…")

    # ── V22 D2：T6.1 放行带维持不变，且残留风险有据可查 ───────────────
    if not a.only or a.only.startswith("V22"):
        r61 = next(r for r in J.engine().rules if r["rule_key"] == "T6.1.regulatory-status")
        band = r61["downgrade_band"]
        check("V22a", "D2 落地：T6.1 落点仍是 auto_reject → auto_pass",
              band["effect"].replace(" ", "") == "auto_reject→auto_pass",
              f"effect={band['effect']!r} · 带词 {band['keywords']}")
        # 会红的情况：有人把残留风险那段注释删了 —— 于是「同现即放行」的后果又变回一句抽象描述。
        check("V22b", "D2 的字面后果留在规则里（不只是写在报告里）",
              "文本级" in (band.get("$decision") or ""),
              (band.get("$decision") or "")[:88] + "…")
        # 正向控制：不带带词时仍然拦截（证明放行不是无条件放行）
        bare = J.judge("FDA approved wearable breast pump")["verdict"]["disposition"]
        both = J.judge("FDA approved wearable breast pump. FDA cleared.")["verdict"]["disposition"]
        check("V22c", "放行是有条件的：裸主张仍拦截，同现才放行",
              bare == "auto_reject" and both == "auto_pass",
              f"裸主张 {bare} · 同现 {both}")

    # ── V23 D4：品线取值域与「未知值不静默过滤」 ─────────────────────
    if not a.only or a.only.startswith("V23"):
        pl = json.loads((SKEL / "product-lines-v1.json").read_text(encoding="utf-8"))
        domain = {v["value"] for v in pl["values"]}
        check("V23a", "品线取值域存在且标注了权威性（status/authority 非空）",
              bool(pl.get("status")) and bool(pl.get("authority")) and len(domain) > 0,
              f"status={pl.get('status')} authority={pl.get('authority')} 取值 {len(domain)} 项")
        eng = J.engine()
        # ★ 会红的情况：有人把 rules_for 改回「未知值就过滤」——
        #   一个错字会让所有声明了品线的规则静默消失 = 一次没有提示的漏报。
        rules_doc = json.loads((SKEL / "rules-v1.json").read_text(encoding="utf-8"))
        eng2 = S.Engine(rules_doc, eng.vocab)
        eng2.line_assignments = {"T2.2.suction-claim": ["吸奶器"]}
        eng2._apply_line_assignments()
        n_all = len(eng2.rules_for(None))
        n_pump = len(eng2.rules_for("吸奶器"))      # 声明里的品线 → 保留
        n_other = len(eng2.rules_for("家纺"))       # 声明外的品线 → 滤掉
        n_typo = len(eng2.rules_for("吸奶器s"))     # 错字 → 取值域外 → 不滤
        check("V23b", "未知品线值 **不过滤**（错字不得变成静默漏报）",
              n_typo == n_all and n_pump == n_all and n_other == n_all - 1,
              f"全集 {n_all} · 声明内品线 {n_pump}（保留）· 声明外品线 {n_other}（滤掉 1）"
              f"· 错字 {n_typo}（不滤）")
        rep = eng2.line_filter("吸奶器s")
        check("V23c", "未知值必须在判定里显形（不是安静地放过去）",
              rep["value_verified"] is False and "不在取值域内" in rep["reason"],
              rep["reason"][:96] + "…")
        # 反方向：归属声明了取值域外的值 → 必须点名
        eng3 = S.Engine(rules_doc, eng.vocab)
        eng3.line_assignments = {"T2.2.quiet-claim": ["吸奶器s"]}
        eng3._apply_line_assignments()
        bad = eng3.unknown_declared_lines()
        check("V23d", "规则声明的品线值必须在取值域内（越界即点名，属漏报成因）",
              any(x["rule_key"] == "T2.2.quiet-claim" for x in bad),
              f"检出 {bad}")
        j3 = J.judge("超强吸力", product_line="吸奶器")
        hit_unknown = any("漏报成因" in u for u in j3["boundary_statement"]["unknowns"])
        real = J.judge("超强吸力", product_line="吸奶器")
        check("V23e", "取值域内声明时不产生误报（越界检查本身不能常红）",
              not any("漏报成因" in u for u in real["boundary_statement"]["unknowns"]),
              "当前 rules-v1.json 无越界声明 —— 这是本项的反向对照")
        # 机制正对照：构造一条声明 → 过滤真的改变判定结果
        h_pump, _ = eng2.assess("超强吸力", product_line="吸奶器")
        h_other, _ = eng2.assess("超强吸水，柔软亲肤的四件套", product_line="家纺")
        h_pump_other, _ = eng2.assess("超强吸水，柔软亲肤的四件套", product_line="吸奶器")
        check("V23f", "品线过滤改变的是判定本身（家纺不再判成吸力夸大）",
              len(h_pump) == 1 and len(h_other) == 0 and len(h_pump_other) == 1,
              f"吸奶器「超强吸力」→{len(h_pump)} 命中 · 家纺「超强吸水」→{len(h_other)} 命中 "
              f"（同一句话在吸奶器上仍是 {len(h_pump_other)} 命中）")
        # ★ 会红的情况：有人把 product_lines 写回 rules-v1.json（两个 Owner 改同一个文件）。
        try:
            S.Engine({"rules": [dict(next(r for r in rules_doc["rules"]
                                         if r["rule_key"] == "T6.1.regulatory-status"),
                                    product_lines=["吸奶器"])],
                      "catch_all": rules_doc["catch_all"]}, eng.vocab)
            stray_blocked, why = False, "没有报错（两处真相会同时生效）"
        except SystemExit as e:
            stray_blocked, why = True, str(e).splitlines()[0][:70]
        check("V23h", "品线归属只有一个书写位置（写回规则文件会被硬挡）",
              stray_blocked, why)
        check("V23g", "品线归因有出处（取值域来自现有业务表，不是发明的）",
              len(pl.get("$provenance", {}).get("sources") or []) >= 5,
              f"{len(pl.get('$provenance', {}).get('sources') or [])} 张来源表 + "
              f"{len(pl.get('$placeholders_excluded') or [])} 个占位符已排除")

    # ══ V24–V29 · 2026-09-16 第二批决定（D5–D11）═════════════════════
    #
    # ★ 这一批的共同难点：**其中五条在存量语料上不可见。**
    #   DP1 出口（D6）走 0 条；D9 的两个词在 291 条里出现 0 次；DP0（D5）的 59 条
    #   恰好是「判定本身没变」的那批；ESC-003（D7）本来就关闭。
    #   于是「接好了」与「根本没走到这条路」在只看存量时会长得一模一样 ——
    #   所以每一组都配**构造正对照**，并用「反向对照」（抽掉配置后必须变红）证明
    #   这些断言不是恒真的。只断言「现在是绿的」，等于什么都没断言。
    _led = json.loads(LEDGER.read_text(encoding="utf-8")) if LEDGER.exists() else {}
    _lay = json.loads((SKEL / "disposition-layers-v1.json").read_text(encoding="utf-8"))

    # ── V24 逐项授权归属（D8 的机制本身）──────────────────────────
    if not a.only or a.only.startswith("V24"):
        _dec = {d["id"]: d for d in _led.get("decisions") or []}
        _scope = _lay.get("ratification_scope") or {}
        _named = set(_scope.get("legal_confirmed") or []) | set(_scope.get("owner_decided") or [])
        check("V24a", "分层表点名的每条决定都在台账里存在（点名不得悬空）",
              bool(_named) and _named <= set(_dec),
              f"点名 {sorted(_named)} · 台账 {sorted(_dec)} · 悬空 {sorted(_named - set(_dec))}")
        def _by(i):        # 台账里两条路径的字段名不同（法务那条是转达，记 answered_by）
            return str(_dec.get(i, {}).get("answered_by")
                       or _dec.get(i, {}).get("decided_by") or "")
        _misattributed = [i for i in (_scope.get("owner_decided") or [])
                          if "法务" in _by(i)]
        check("V24b", "逐项授权归属与台账一致（不得把 Owner 的决定记成法务的）",
              all(_by(i) for i in _named) and not _misattributed
              and not (set(_scope.get("legal_confirmed") or [])
                       & set(_scope.get("owner_decided") or [])),
              "法务确认 " + str(_scope.get("legal_confirmed"))
              + " · Owner 决定 " + str(_scope.get("owner_decided"))
              + " · 待法务复核 " + str(_scope.get("pending_legal_review"))
              + (f" · ❌ 归属错误 {_misattributed}" if _misattributed else ""))
        # 每一行的 $decision 里提到的 ID 必须真实存在 —— 否则「这一行谁定的」答不出来
        import re as _re2
        _cited = set()
        for blob in list(_lay["mapping"].values()) + list(_lay["layers"]) \
                + list(_lay.get("preconditions") or []):
            for m in _re2.finditer(r"\bD(\d{1,2})\b", str(blob.get("$decision") or "")):
                _cited.add("D" + m.group(1))
        check("V24c", "mapping / layers / preconditions 每一行都点名了真实存在的决定",
              bool(_cited) and _cited <= set(_dec),
              f"引用 {sorted(_cited)} · 悬空 {sorted(_cited - set(_dec))}")

    # ── V25 DP1 出口（D6）：机器说的不是「通过」──────────────────
    if not a.only or a.only.startswith("V25"):
        _p = J.judge("FDA approved wearable breast pump. FDA cleared.")
        _pL = _p["verdict"]["layer"]
        _ob = _pL.get("outbound") or {}
        check("V25a", "DP1 结论必须带出口通知（人必须知道机器说了什么，不是收到沉默）",
              _pL["id"] == "DP1" and _ob.get("required") is True
              and _ob.get("must_reach") is True and bool(_ob.get("notice")),
              f"layer={_pL['id']} · to={_ob.get('to')} · kind={_ob.get('kind')}")
        # ★ 禁用语检查不能是「子串出现即红」：模板里那句「**不是**『判定通过』」本身
        #   就含「通过」两个字 —— 而它恰恰是在**否认**通过。朴素的子串匹配会把
        #   最正确的那句话判成违规，于是下一个人只会去改模板、把否认也删掉。
        #   所以先把**否定域**（不是「…」/ 非「…」）整段剥掉，再看禁用语。
        def _asserts(text: str, banned: list) -> list:
            stripped = re.sub(r'(不是|并非|非)\s*[「『"\'(][^」』"\')]*[」』"\')]', '', text)
            stripped = re.sub(r'(不是|并非|非)[^，。；\n]*', '', stripped)
            return [w for w in banned if w in stripped]

        _banned = _asserts(_ob.get("notice") or "", _ob.get("must_not_say") or [])
        _control = _asserts("本判定已通过，无需处理。", _ob.get("must_not_say") or [])
        check("V25b", "出口通知里不含把机器动作读成审批的词（否定域不算）",
              bool(_ob.get("must_not_say")) and not _banned,
              f"禁用语 {_ob.get('must_not_say')} · 断言性命中 {_banned}")
        check("V25e", "反向对照：把「已通过」写进通知，V25b 真的会红（不是恒真）",
              len(_control) >= 2, f"注入「本判定已通过，无需处理。」→ 命中 {_control}")
        check("V25c", "通知措辞说清「未发现拦截理由」而不是「判定通过」",
              "未发现" in (_ob.get("notice") or "")
              and "不是「判定通过」" in (_ob.get("notice") or ""),
              (_ob.get("notice") or "")[:80] + "…")
        # 反向对照：抽掉出口配置后必须真的没有出口，否则 V25a 是恒真的
        _tmp = json.loads(json.dumps(_lay))
        _tmp["mapping"]["auto_pass"].pop("outbound", None)
        _tp = Path(tempfile.mkdtemp()) / "layers.json"
        _tp.write_text(json.dumps(_tmp, ensure_ascii=False), encoding="utf-8")
        _orig_lp = J.LAYERS_PATH
        try:
            J.LAYERS_PATH = _tp
            _neg = J.judge("FDA approved wearable breast pump. FDA cleared.")
        finally:
            J.LAYERS_PATH = _orig_lp
        check("V25d", "反向对照：删掉出口配置后出口真的消失（V25a 不是恒真）",
              _neg["verdict"]["layer"].get("outbound") is None,
              "删掉 auto_pass.outbound → layer.outbound=None（不是凭空合成一个默认出口）")

    # ── V26 DP0 路由与空白清单（D5）──────────────────────────────
    if not a.only or a.only.startswith("V26"):
        _e = J.judge("")
        _eL = _e["verdict"]["layer"]
        check("V26a", "无文案输入落 DP0（不落审查队列、不落法务）",
              _eL["id"] == "DP0" and _e["verdict"]["blank_register"]["enters"] is False,
              f"layer={_eL['id']} {_eL['name']} · 清单={_e['verdict']['blank_register']['enters']}"
              f" · 前置={(_eL.get('precondition_applied') or {}).get('id')}")
        check("V26b", "DP0 机器不得终结（否则「不可判」会变成一条移出审查的通道）",
              _eL["machine_may_finalize"] is False and _eL["can_finalize"] is False,
              f"machine_may_finalize={_eL['machine_may_finalize']}")
        _ob0 = _eL.get("outbound") or {}
        check("V26c", "DP0 的出口禁止说「合规」（今天这 59 条写的正是 合规·绿/无需处理）",
              "合规" in (_ob0.get("must_not_say") or [])
              and _e["suggestion"] == "转人工",
              f"must_not_say={_ob0.get('must_not_say')} · suggestion={_e['suggestion']}")
        _n = J.judge("Momcozy Official | Best-Value Wearable Pump | Shop Now")
        check("V26d", "有文案的零命中仍落 DP3 且进空白清单（D5 只拆路，不改含义）",
              _n["verdict"]["layer"]["id"] == "DP3"
              and _n["verdict"]["blank_register"]["enters"] is True,
              f"layer={_n['verdict']['layer']['id']} · "
              f"清单={_n['verdict']['blank_register']['enters']}")
        # 保留 Q25 的 59/103 基线；新增提示让有依据的表达退出空白清单。
        # 每个退出都要能指出唯一新增规则，并保持非阻断；不能只把 103 改成当前数。
        _recs = json.loads((SKEL / "_data" / "records.json").read_text(encoding="utf-8"))
        _current26 = [J.judge(S.rec_text(r), ad_type=r.get("广告类型") or None)
                      for r in _recs]
        with using_engine(historical_engine()):
            _historical26 = [J.judge(S.rec_text(r), ad_type=r.get("广告类型") or None)
                             for r in _recs]
        _dp0 = sum(r["verdict"]["layer"]["id"] == "DP0" for r in _current26)
        _blank = sum(r["verdict"]["blank_register"]["enters"] for r in _current26)
        _old_dp0 = sum(r["verdict"]["layer"]["id"] == "DP0" for r in _historical26)
        _old_blank = sum(r["verdict"]["blank_register"]["enters"] for r in _historical26)
        _exits26, _bad26 = [], []
        for i, (before, after) in enumerate(zip(_historical26, _current26)):
            old_blank = before["verdict"]["blank_register"]["enters"]
            new_blank = after["verdict"]["blank_register"]["enters"]
            if old_blank and not new_blank:
                _exits26.append(i)
                if ({h["rule_key"] for h in after["hits"]} != {RANKING_RULE}
                        or after["verdict"]["disposition"] != "auto_pass_with_note"):
                    _bad26.append(i)
            elif not old_blank and new_blank:
                _bad26.append(i)
        check("V26e", "原 DP0/空白基线不变；当前退出空白的每条只由已授权非阻断排名提示解释",
              _dp0 == _old_dp0 == 59 and _old_blank == 103
              and _blank + len(_exits26) == _old_blank and bool(_exits26) and not _bad26,
              f"历史 DP0={_old_dp0}、空白={_old_blank}；当前 DP0={_dp0}、空白={_blank}；"
              f"新增提示解释退出 {len(_exits26)} 条（行索引 {_exits26}）；异常 {_bad26}")

    # ── V27 ESC-003 关闭，且关闭有实测依据（D7）────────────────────
    if not a.only or a.only.startswith("V27"):
        _esc3 = next(e for e in _lay["escalate_if"] if e["id"] == "ESC-003")
        check("V27a", "ESC-003 维持关闭",
              _esc3.get("$enabled") is False, "$enabled=false")
        _why = " ".join(_esc3.get("$measurement_that_keeps_it_off") or [])
        check("V27b", "关闭理由带实测数字（关闭必须有测量依据，不是一句 policy）",
              all(k in _why for k in ("28 条", "5 条", "DP4 从 31 涨到 36")),
              "含触发面 28 / 净新增 5 / DP4 31→36")
        # 反向对照：打开它必须真的改变层级 —— 否则这个开关是死配置
        _t2 = json.loads(json.dumps(_lay))
        next(e for e in _t2["escalate_if"] if e["id"] == "ESC-003")["$enabled"] = True
        _tp2 = Path(tempfile.mkdtemp()) / "layers.json"
        _tp2.write_text(json.dumps(_t2, ensure_ascii=False), encoding="utf-8")
        _multi = ("More Milk with strong suction. Whisper-Quiet under 46dB. "
                  "Don't Miss This Week's Deal.")
        _before = J.judge(_multi)["verdict"]["layer"]["id"]
        _orig_lp2 = J.LAYERS_PATH
        try:
            J.LAYERS_PATH = _tp2
            _after = J.judge(_multi)["verdict"]["layer"]["id"]
        finally:
            J.LAYERS_PATH = _orig_lp2
        check("V27c", "反向对照：打开 ESC-003 会真的改变层级（开关是活的）",
              _after == "DP4" and _before != "DP4",
              f"关闭 {_before} → 打开 {_after}（同一条多主题文案）")

    # ── V28 申诉块与回执出口（D10）───────────────────────────────
    if not a.only or a.only.startswith("V28"):
        _ar = J.judge("More Milk with strong suction")
        _ap = ((_ar["verdict"]["layer"].get("outbound") or {}).get("appeal") or {})
        _fields = ["channel", "owner", "owner_layer_id", "sla_workdays",
                   "overturn_requires", "escalate_to_layer_id"]
        _miss = [f for f in _fields if not _ap.get(f)]
        check("V28a", "拦截结论带完整申诉块（入口 / 责任人 / 时限 / 撤销依据 / 升级对象）",
              _ap.get("available") is True and not _miss,
              f"受理={_ap.get('owner')}（{_ap.get('owner_layer_id')}） · "
              f"时限={_ap.get('sla_workdays')} 工作日 · 缺 {_miss}")
        _rp2 = Path(tempfile.mkdtemp()) / "r.jsonl"
        _rc = J.judge("More Milk with strong suction", receipt=True,
                      receipt_path=_rp2, origin="test")["receipt"]
        _ol = _rc.get("obligations") or {}
        import hashlib as _h
        _dig_ok = (_ol.get("notice_sha256")
                   == _h.sha256((_ol.get("notice") or "").encode("utf-8")).hexdigest())
        check("V28b", "回执留存出口义务（三个月后拿回执能查到谁受理、几天、凭什么撤）",
              bool(_ol.get("appeal")) and bool(_ol.get("notice")) and _dig_ok
              and _ol.get("must_reach") is True,
              f"notice_sha256 自洽={_dig_ok} · must_reach={_ol.get('must_reach')} · "
              f"to={_ol.get('to')}")
        # ★ 「政策已定」与「送达已实现」必须分开记账 —— 合并记账就是这次要治的病
        _d1 = next(d for d in _led.get("decisions") or [] if d["id"] == "D1")
        _obs = {o.get("id"): o for o in _d1.get("obligations") or []}
        _split = [k for k, o in _obs.items() if "申诉" in str(o.get("what") or "")]
        check("V28c", "D1 的申诉义务拆成「政策」与「送达」两条独立记账",
              len(_split) >= 2
              and any(_obs[k].get("status") == "met" for k in _split)
              and any(_obs[k].get("status") == "unmet" for k in _split),
              f"{sorted(_split)} → "
              + "；".join(f"{k}={_obs[k].get('status')}" for k in sorted(_split)))
        # ★ 2026-09-16（D14）：这条检查原来断言两处都含固定字符串「送达管道未实现」。
        #   D14 之后缺的东西从「没有管道」变成「没有责任人」，那句话不再准确 ——
        #   于是检查红了。**变红是对的**（世界变了），但断言**固定措辞**是错的写法：
        #   它逼着人为了过检查而保留一句过时的话。改成断言**两处说的是同一件事**。
        # ★ 2026-09-16（D19）：同一件事又往前走了一格 —— 责任人填了，于是缺的东西从
        #   「没有责任人」变成「还没有真的发过」。检查第三次变红，仍然是对的。
        #   现在断言：两处都认「送得出去」（点名责任人映射表与地址出处）**且**都点出
        #   「还没有真的发过」（D1-O3c / Q14）—— 少说任何一半都会红。
        _blob = json.dumps({"lay": _lay, "led": _led}, ensure_ascii=False)
        _obs_d1 = {o["id"]: o for o in next(d for d in _led["decisions"]
                                            if d["id"] == "D1")["obligations"]}
        _o3b, _o3c = _obs_d1["D1-O3b"], _obs_d1["D1-O3c"]
        check("V28d", "分层表与台账对「送达」的说法一致：都认了「送得出去」、也都点出「还没送过」",
              "account-owners.csv" in _blob and "责任人" in _blob
              and _o3b["status"] == "met" and _o3c["status"] == "unmet"
              and "D1-O3c" in _blob and "Q14" in _blob
              and "已经送过" in _blob,
              f"D1-O3b={_o3b['status']}（送得出去）· D1-O3c={_o3c['status']}（已送过）· "
              f"两处均点名责任人映射；均未宣布送达已发生")

    # ── V29 D9：FDA 逐词落点（放行带 vs 降级带）────────────────────
    if not a.only or a.only.startswith("V29"):
        _V = J.engine().vocab
        _rk = "T6.1.regulatory-status"
        _passw = {w.lower() for w in _V.pass_of(_rk)}
        _downw = {w.lower() for w in _V.downgrade_of(_rk)}
        check("V29a", "D9 落地：`FDA registered`/`FDA 注册` 已移出放行带、落在降级带",
              "fda registered" in _downw and "fda 注册" in _downw
              and "fda registered" not in _passw and "fda 注册" not in _passw,
              f"放行带 {sorted(_passw)} · 降级带 {sorted(_downw)}")
        _cl = J.judge("FDA approved wearable breast pump. FDA cleared.")
        check("V29b", "D2 语义逐字未变：`… FDA cleared` 仍 auto_pass / DP1",
              _cl["verdict"]["disposition"] == "auto_pass"
              and _cl["verdict"]["layer"]["id"] == "DP1",
              f"{_cl['verdict']['disposition']} / {_cl['verdict']['layer']['id']}")
        _rg = J.judge("FDA approved wearable breast pump. FDA registered facility.")
        check("V29c", "D9 收紧方向生效：`… FDA registered` 由 auto_pass 变 manual_review",
              _rg["verdict"]["disposition"] == "manual_review"
              and _rg["verdict"]["layer"]["id"] == "DP3",
              f"{_rg['verdict']['disposition']} / {_rg['verdict']['layer']['id']}"
              f" · 带={_rg['hits'][0]['band']['effect']}")
        _both = J.judge("FDA approved device. FDA cleared. FDA registered.")
        check("V29d", "两个带同现时取降级（保守：宁可多一次人工，不赌一次放行）",
              _both["verdict"]["disposition"] == "manual_review"
              and _both["hits"][0]["band"]["kind"] == "downgrade"
              and bool(_both["hits"][0]["band"]["non_decisive_words"]),
              f"{_both['verdict']['disposition']} · 决定性词="
              f"{_both['hits'][0]['band']['words']} · 非决定性词="
              f"{_both['hits'][0]['band']['non_decisive_words']}")
        # 反向对照：抽掉逐词覆盖，`FDA registered` 必须回到放行 —— 否则覆盖是空的
        _rules = json.loads((SKEL / "rules-v1.json").read_text(encoding="utf-8"))
        for _r2 in _rules["rules"]:
            if _r2["rule_key"] == _rk:
                _r2["downgrade_band"].pop("keyword_effect_overrides", None)
        _tp3 = Path(tempfile.mkdtemp()) / "skeleton_neg"
        import shutil as _sh
        _sh.copytree(SKEL, _tp3)
        (_tp3 / "rules-v1.json").write_text(json.dumps(_rules, ensure_ascii=False),
                                            encoding="utf-8")
        _out = subprocess.run(
            [sys.executable, "-c",
             "import json,sys; sys.path.insert(0,'.'); import judge as J;"
             "r=J.judge('FDA approved wearable breast pump. FDA registered facility.');"
             "print(r['verdict']['disposition'])"],
            cwd=str(_tp3), capture_output=True, text=True)
        check("V29e", "反向对照：删掉逐词覆盖后 `FDA registered` 回到 auto_pass（覆盖是活的）",
              _out.returncode == 0 and _out.stdout.strip() == "auto_pass",
              f"删掉 keyword_effect_overrides → {( _out.stdout.strip() or _out.stderr.strip()[-120:])}")


    # ══ V30 · 2026-09-16（D12）未决事项的交付形态 ═══════════════════
    #   「预留的事情」过去以散文形态散落在 ADR §6.2、分层表的 $note、报告正文里。
    #   两个后果都实测到了：①读的人要自己解析、排序、估算代价，于是问题被推迟；
    #   ②同一组问题写在两个文件里，两处状态已经开始不一致。
    #   这一组守的不是「有没有记录」，是**记录能不能被直接决策**。
    if not a.only or a.only.startswith("V30"):
        _led = json.loads((SKEL / "legal-decisions-v1.json").read_text(encoding="utf-8"))
        _lay = json.loads((SKEL / "disposition-layers-v1.json").read_text(encoding="utf-8"))
        _dq = _led.get("$decision_queue") or []
        _dec_ids = {d["id"] for d in _led.get("decisions", [])}

        def _queue_problems(items: list) -> list:
            """一条未决项要能被直接决策，必须齐五样。抽成函数是为了 V30e 能对同一判据做反向对照。"""
            bad = []
            for q in items:
                if q.get("status") != "open":
                    continue
                qid = q.get("id", "?")
                opts = q.get("options") or []
                if not q.get("owner"):
                    bad.append(f"{qid}: 没有 owner（没人负责的账不算未决项）")
                if len(opts) < 2:
                    bad.append(f"{qid}: 选项少于 2 个（不是选择题）")
                rec = [o for o in opts if o.get("recommended")]
                if len(rec) != 1:
                    bad.append(f"{qid}: 推荐项 {len(rec)} 个（必须恰好 1 个 —— "
                               f"0 个是把选择成本推回给人，多个是没做推荐）")
                for o in opts:
                    if not (o.get("impact") or "").strip():
                        bad.append(f"{qid}: 选项 {o.get('key')} 没写代价/影响")
                dflt = (q.get("default_if_unanswered") or "").strip()
                if not dflt:
                    bad.append(f"{qid}: 没写 default_if_unanswered（沉默的后果不可知）")
                elif "沉默" not in dflt:
                    bad.append(f"{qid}: default 没写明「沉默」意味着什么")
                elif not any(f"选项 {o.get('key')}" in dflt for o in opts):
                    bad.append(f"{qid}: default 没有指向任何一个具体选项"
                               f"（沉默必须等价于某个选项，包括「什么都不做」那个）")
            return bad

        _prob = _queue_problems(_dq)
        _open = [q for q in _dq if q.get("status") == "open"]
        check("V30a", "每条未决项都是可选的题（owner / ≥2 选项 / 恰好 1 个推荐 / 选项带代价 / 写明沉默的后果）",
              not _prob, f"{len(_open)} 项未决 · " + ("；".join(_prob) if _prob else "五样齐备"))

        _b = []
        for q in _dq:
            if q.get("status") != "answered":
                continue
            for f in ("answer", "answered_by", "answered_at", "record"):
                if not (q.get(f) or "").strip():
                    _b.append(f"{q['id']}: 缺 {f}")
            _cited = set(re.findall(r"\bD(\d+)\b", q.get("record") or ""))
            for c in sorted(_cited):
                if f"D{c}" not in _dec_ids:
                    _b.append(f"{q['id']}: record 点名的 D{c} 在台账里不存在（悬空引用）")
        check("V30b", "已答项可追溯（答案/答者/日期/回指决定齐备，且回指不悬空）",
              not _b, f"{sum(1 for q in _dq if q.get('status') == 'answered')} 项已答 · "
                      + ("；".join(_b) if _b else "全部指向真实存在的决定"))

        _ids = [q["id"] for q in _dq]
        _nums = sorted(int(m.group(1)) for i in _ids if (m := re.fullmatch(r"Q(\d+)", i)))
        check("V30c", "队列编号唯一且连续（决定只增不改，问题也只增不删）",
              len(_ids) == len(set(_ids)) and _nums == list(range(1, len(_nums) + 1)),
              f"{len(_ids)} 项 · Q{_nums[0]}–Q{_nums[-1]}"
              + ("；" + "；".join(f"重复/空号 {i}" for i in set(_ids) if _ids.count(i) > 1)
                 if len(_ids) != len(set(_ids)) else ""))

        # ★ 2026-09-16 二次修正：第一版要求「分层表的 ID 索引 == 台账的 ID 集合」。
        #   新增一条 Q13 之后它立刻红了 —— 而它红的方式说明**检查本身在维护第二处真相**：
        #   每加一个问题都要改两个文件，等于把「两处真相」写进了检查里。
        #   正确的不变量是「只有一处」，不是「两处相等」。
        _copies = [k for k in _lay if k == "$open_questions_for_legal"
                   or k == "$decision_queue_ids"]
        check("V30d", "单一书写位置：分层表只放指针，**不得自带任何问题副本**（含派生的 ID 索引）",
              bool(_lay.get("$decision_queue_ref")) and not _copies
              and "$open_questions_for_legal" not in _led,
              f"ref={_lay.get('$decision_queue_ref')!r} · 副本键 {_copies or '无'}"
              + f" · 台账 {len(_ids)} 项（状态以台账为准）")

        # 反向对照：抽掉推荐标记 / 清空某条 default，判据必须真的变红，否则 V30a 是恒真
        # ★ 第一版这个对照本身是**空操作**：它把 options[0] 的 recommended 设成 False，
        #   而那一项本来就是 False（推荐在 C 上）—— 于是什么也没抽掉，检查却报了绿。
        #   这与 V29e 是同一类错误：**反向对照必须真的能动，否则它证明的是自己没坏**。
        # ★ 2026-09-16 二次修正（D24）：Q1–Q18 全部结案、队列**清空**之后，这里用
        #   `next(q for q in _mut if status=="open")` 取样本 —— 直接 StopIteration 崩了。
        #   也就是说：**这个反向对照只在「有未决项」时才跑得动**，而队列清空是个好状态。
        #   修法不是加个 if 跳过（那等于「没问题时就不检查」，正是本项目一直在治的病），
        #   而是让对照**自带样本**：拿任意一条（已答的也行）复制成 open 的变体再抽。
        _seed = next((q for q in _dq if q.get("options")), None)
        _mut = copy.deepcopy([_seed]) if _seed else []
        if _mut:
            _mut[0]["status"] = "open"          # 判据只看 open 项，所以样本必须拨成 open
            for _o in _mut[0]["options"]:
                _o["recommended"] = False
        _p1 = _queue_problems(_mut)
        _mut2 = copy.deepcopy([_seed]) if _seed else []
        if _mut2:
            _mut2[0]["status"] = "open"
            _mut2[0]["default_if_unanswered"] = "再说。"
        _p2 = _queue_problems(_mut2)
        check("V30e", "反向对照：抽掉推荐项、或让 default 不指向任何选项，V30a 都会红（不是恒真）"
                      "—— 样本自备，队列清空时也跑得动",
              bool(_seed) and any("推荐项 0 个" in p for p in _p1)
              and any("沉默" in p for p in _p2),
              f"样本={_seed.get('id') if _seed else '★无（连一条带选项的都没有）'}"
              f"（当前 open 项 {len(_open)} 条） · 抽推荐 → {_p1[:1]} · 空 default → {_p2[:1]}")

        _dang = []
        for q in _open:
            _w = q.get("where") or ""
            _f = re.search(r"[\w\u4e00-\u9fff][\w\u4e00-\u9fff\-/]*\.(?:json|md|py|csv|yml|yaml|txt|sh)", _w)
            if not _f:
                _dang.append(f"{q['id']}: where 里没有可解析的文件名（{_w[:40]}）")
                continue
            _p = Path(_f.group(0))
            if not (_p if _p.is_absolute() else (SKEL / _p)).exists() \
               and not (ROOT / _p).exists():
                _dang.append(f"{q['id']}: where 点名的文件不存在 —— {_f.group(0)}")
        check("V30f", "每条未决项都指得出「去哪里看」（where 点名的文件真实存在，不是悬空引用）",
              not _dang, "；".join(_dang) if _dang else f"{len(_open)} 项全部可解析")

        # ── V30g · 2026-09-17（B3.1 · D27）：台账扩成全仓台账之后的新失败形态 ──
        #   D12 把「未决项写在哪」收敛成一处；Q21/D27 把这一处从「法务/引擎」扩成
        #   「本仓所有线」。于是多了一种过去不存在的错法：**线的混淆** ——
        #   知识库线的题指回一条引擎线的决定，或者新条目干脆忘了标线。
        #   两种都让「这是谁的决定」在阅读时消失，而它消失得没有任何声响。
        _LINES = {"engine", "kb", "repo"}
        _dec_by_id = {x["id"]: x for x in _led.get("decisions", [])}
        _line_bad = []
        for x in _led.get("decisions", []):
            if x.get("line") not in _LINES:
                _line_bad.append(f"{x['id']}: line={x.get('line')!r} 不在 {sorted(_LINES)}")
        for q in _dq:
            if q.get("line") not in _LINES:
                _line_bad.append(f"{q['id']}: line={q.get('line')!r} 不在 {sorted(_LINES)}")
            if q.get("status") != "answered":
                continue
            for c in re.findall(r"\bD(\d+)\b", q.get("record") or ""):
                dd = _dec_by_id.get(f"D{c}")
                if dd is not None and dd.get("line") != q.get("line"):
                    _line_bad.append(f"{q['id']}({q.get('line')}) 指回 D{c}"
                                     f"({dd.get('line')}) —— 不同线")
        check("V30g", "每条问题与每条规定都标了归属线，且已答项指回的决定与它同线（D27）",
              not _line_bad, f"{len(_dq)} 题 / {len(_dec_by_id)} 决定 · "
                             + ("；".join(_line_bad) if _line_bad
                                else "全部标线且同线 · "
                                     + str(sorted({q.get("line") for q in _dq}))))

        # 反向对照：把一条已答项的 line 掰弯，V30g 必须真的变红
        _seed2 = next((q for q in _dq if q.get("status") == "answered" and q.get("record")), None)
        _bad2 = []
        if _seed2:
            _m = copy.deepcopy(_seed2)
            _m["line"] = "engine" if _seed2.get("line") != "engine" else "kb"
            _m["id"] = "Q-mut"
            for c in re.findall(r"\bD(\d+)\b", _m.get("record") or ""):
                dd = _dec_by_id.get(f"D{c}")
                if dd is not None and dd.get("line") != _m.get("line"):
                    _bad2.append("不同线")
        check("V30h", "反向对照：把已答项的 line 掰弯，V30g 的判据必须报「不同线」（不是恒真）",
              bool(_seed2) and bool(_bad2),
              f"样本={_seed2.get('id') if _seed2 else '★无'} · 掰弯后 → {_bad2 or '★没抓住'}")


    # ══ V31–V37 · 2026-09-16 第三批（D13–D18）═══════════════════════
    #   六项决定全部落在「升级面 / 声明与实现一致 / 键结构 / 命名 / 取值域 / 送达」
    #   这六处**存量语料看不见的地方**，所以每一组都配了反向对照。
    # ── V31 D13：ESC-002 的升级面（逐规则例外）──────────────────────
    if not a.only or a.only.startswith("V31"):
        _lay2 = json.loads((SKEL / "disposition-layers-v1.json").read_text(encoding="utf-8"))
        _e2 = next(e for e in _lay2["escalate_if"] if e["id"] == "ESC-002")
        _ex = set(_e2.get("exempt_rule_keys") or [])
        _MO = {r["rule_key"] for r in json.loads(
            (SKEL / "rules-v1.json").read_text(encoding="utf-8"))["rules"]
            if r.get("evaluability") == "manual_only"}
        check("V31a", "D13 落地：ESC-002 声明了逐规则例外，且点名了决定",
              _ex == {"T3.2.lactation-consultant", "T7.2.pain-scenario"}
              and "D13" in str(_e2.get("$exempt_decision") or ""),
              f"豁免 {sorted(_ex)} · 决定 {_e2.get('$exempt_decision')!r}")
        check("V31b", "例外的对象真的声明了 manual_only（否则是无的放矢的死声明）",
              _ex <= _MO, f"豁免都在 manual_only 集合内：{_ex <= _MO} · manual_only={sorted(_MO)}")

        _ib = J.judge("Momcozy M5 | Free 1-on-1 IBCLC Session | 30-Day Returns")
        _L = _ib["verdict"]["layer"]
        _exm = _L.get("exemptions_applied") or []
        check("V31c", "例外在结果里显形（分得出「没命中」与「命中了但被豁免」）",
              _L["id"] != "DP4" and bool(_exm)
              and _exm[0].get("would_have_gone_to") == "DP4"
              and "T3.2.lactation-consultant" in _exm[0].get("rule_keys", []),
              f"层={_L['id']} · 例外={[(x['id'], x['rule_keys'], x['would_have_gone_to']) for x in _exm]}")

        _ho = J.judge("Momcozy Official | Hospital-Grade at Home | -300 mmHg Strong Suction")
        check("V31d", "未豁免的 T7.1 仍然升 DP4（分层不是把整条升级关掉）",
              _ho["verdict"]["layer"]["id"] == "DP4"
              and any(e["id"] == "ESC-002" for e in
                      _ho["verdict"]["layer"].get("escalated_by") or []),
              f"层={_ho['verdict']['layer']['id']} · 升级={[e['id'] for e in _ho['verdict']['layer'].get('escalated_by') or []]}")

        # 反向对照：抽掉豁免，同一条 IBCLC 文案必须回到 DP4
        _tmp2 = Path(tempfile.mkdtemp()) / "sk_esc"
        shutil.copytree(SKEL, _tmp2)
        _l3 = json.loads((_tmp2 / "disposition-layers-v1.json").read_text(encoding="utf-8"))
        for _x in _l3["escalate_if"]:
            if _x["id"] == "ESC-002":
                _x["exempt_rule_keys"] = []
        (_tmp2 / "disposition-layers-v1.json").write_text(
            json.dumps(_l3, ensure_ascii=False), encoding="utf-8")
        _o2 = subprocess.run(
            [sys.executable, "-c",
             "import sys; sys.path.insert(0,'.'); import judge as J;"
             "print(J.judge('Momcozy M5 | Free 1-on-1 IBCLC Session | 30-Day Returns')"
             "['verdict']['layer']['id'])"],
            cwd=str(_tmp2), capture_output=True, text=True)
        check("V31e", "反向对照：抽掉 exempt_rule_keys 后同一文案回到 DP4（例外是活的，不是恒真）",
              _o2.returncode == 0 and _o2.stdout.strip() == "DP4",
              f"抽掉豁免 → {(_o2.stdout.strip() or _o2.stderr.strip()[-120:])}")

    # ── V32 D17：声明必须被读（`escalation` 块里不得有死键）─────────
    if not a.only or a.only.startswith("V32"):
        _R = json.loads((SKEL / "rules-v1.json").read_text(encoding="utf-8"))
        _KNOWN = {"when_cooccurring_with", "to_severity", "to_disposition", "reason"}
        _dead = []
        _src = (SKEL / "score.py").read_text(encoding="utf-8")
        for _r in _R["rules"]:
            for _k in (_r.get("escalation") or {}):
                if _k.startswith("$"):
                    continue
                if _k not in _KNOWN or _k not in _src:
                    _dead.append(f"{_r['rule_key']}.{_k}")
        check("V32a", "D17 落地：`escalation` 里没有声明了却没人读的键",
              not _dead, f"死键 {_dead}" if _dead else "唯一被读的键集：when_cooccurring_with / to_* / reason")

        # 正面对照：升级确实是活的（不是把整块删掉了事）
        _esc = J.judge("Say goodbye to cold, painful pumping and endless dishwashing!")
        check("V32b", "正面证据：共现升级仍然生效（删声明没有连功能一起删）",
              any(h.get("escalated") for h in _esc["hits"]),
              f"escalated={[h['rule_key'] for h in _esc['hits'] if h.get('escalated')]}")

        # 反向对照：塞回一个死键，判据必须红
        _R2 = copy.deepcopy(_R)
        _R2["rules"][0].setdefault("escalation", {})["within_chars"] = 60
        _dead2 = [f"{r['rule_key']}.{k}" for r in _R2["rules"]
                  for k in (r.get("escalation") or {})
                  if not k.startswith("$") and (k not in _KNOWN or k not in _src)]
        check("V32c", "反向对照：塞回 `within_chars` 后 V32a 会红（不是恒真）",
              bool(_dead2), f"塞回后死键 {_dead2[:2]}")

    # ── V33 D18：逐词覆盖的键结构（通道 → 词）──────────────────────
    if not a.only or a.only.startswith("V33"):
        _R = json.loads((SKEL / "rules-v1.json").read_text(encoding="utf-8"))
        _bad_shape, _collide = [], []
        for _r in _R["rules"]:
            _ov = (_r.get("downgrade_band") or {}).get("keyword_effect_overrides") or {}
            for _k, _v in _ov.items():
                if not isinstance(_v, dict):
                    _bad_shape.append(f"{_r['rule_key']}.{_k}")
            _down = {str(x).lower() for x in (_ov.get("downgrade") or {})}
            _pass = {str(x).lower() for x in (_ov.get("pass") or {})}
            if _down & _pass:
                _collide.append(f"{_r['rule_key']}: {sorted(_down & _pass)}")
        check("V33a", "D18 落地：覆盖是「通道 → 词」两层结构",
              not _bad_shape, f"旧形状 {_bad_shape}" if _bad_shape else "全部两层")
        check("V33b", "同一规则的同一覆盖词不得同时出现在两个通道（键里有通道这一维才有意义）",
              not _collide, f"跨通道重复 {_collide}" if _collide else "无重复")

        # 硬失败：旧形状必须在装载判定时炸，而不是被静默跳过
        _tmp3 = Path(tempfile.mkdtemp()) / "sk_ov"
        shutil.copytree(SKEL, _tmp3)
        _r3 = json.loads((_tmp3 / "rules-v1.json").read_text(encoding="utf-8"))
        for _r in _r3["rules"]:
            _b = _r.get("downgrade_band") or {}
            if _b.get("keyword_effect_overrides"):
                _b["keyword_effect_overrides"] = {"FDA registered": "auto_reject → manual_review"}
        (_tmp3 / "rules-v1.json").write_text(json.dumps(_r3, ensure_ascii=False), encoding="utf-8")
        _o3 = subprocess.run(
            [sys.executable, "-c",
             "import sys; sys.path.insert(0,'.'); import judge as J;"
             "print(J.judge('FDA approved device. FDA registered facility.')['verdict']['disposition'])"],
            cwd=str(_tmp3), capture_output=True, text=True)
        # ★ 第一版这条检查写错了：它要求错误信息里出现「旧形状」（score.band_hits 的措辞），
        #   而实际先开枪的是**装载期**的 `vocab.assert_channels` OV0（退出码 3）。
        #   两道闸门都在，装载期那道先响 —— 这是更想要的次序（装载即失败，不是首次使用才失败）。
        #   断言错在「要求某一句话」，而不是「要求拒绝」。
        _o3s = _o3.stdout + _o3.stderr
        _guard = ("OV0" if "OV0" in _o3s else ("旧形状" if "旧形状" in _o3s else "无"))
        check("V33c", "反向对照：旧形状的覆盖被**硬失败**（不兼容、不静默跳过）",
              _o3.returncode != 0 and _guard != "无",
              f"退出码={_o3.returncode} · 拦下它的是 {_guard} 闸门"
              + ("（装载期不变量，比使用期更早）" if _guard == "OV0" else ""))

        # 放行通道的覆盖不是装饰：给它加一条 pass 覆盖，落点必须真的变
        _tmp4 = Path(tempfile.mkdtemp()) / "sk_pass"
        shutil.copytree(SKEL, _tmp4)
        _r4 = json.loads((_tmp4 / "rules-v1.json").read_text(encoding="utf-8"))
        for _r in _r4["rules"]:
            if _r["rule_key"] == "T6.1.regulatory-status":
                _r["downgrade_band"]["keyword_effect_overrides"] = {
                    "pass": {"FDA cleared": "auto_pass → manual_review"}}
        (_tmp4 / "rules-v1.json").write_text(json.dumps(_r4, ensure_ascii=False), encoding="utf-8")
        _o4 = subprocess.run(
            [sys.executable, "-c",
             "import sys; sys.path.insert(0,'.'); import judge as J;"
             "print(J.judge('FDA approved wearable breast pump. FDA cleared.')"
             "['verdict']['disposition'])"],
            cwd=str(_tmp4), capture_output=True, text=True)
        check("V33d", "放行通道的逐词覆盖真的生效（通道这一维不是装饰）",
              _o4.returncode == 0 and _o4.stdout.strip() == "manual_review",
              f"加 pass 覆盖后 → {(_o4.stdout.strip() or _o4.stderr.strip()[-120:])}")

    # ── V34 D15：层级名不得同名反义 ────────────────────────────────
    if not a.only or a.only.startswith("V34"):
        _lay2 = json.loads((SKEL / "disposition-layers-v1.json").read_text(encoding="utf-8"))
        _names = {l["id"]: l["name"] for l in _lay2["layers"]}
        check("V34a", "D15 落地：DP3 的 `name` 字符串本身已改（不只改了注释）",
              _names.get("DP3") == "内容审核员复核",
              f"DP3.name={_names.get('DP3')!r} · 原名={next((l.get('$former_name') for l in _lay2['layers'] if l['id']=='DP3'), None)!r}")
        check("V34b", "四个层级名互不相同，且不再有任何一个等于旧表「人工复核」（同名反义）",
              len(set(_names.values())) == len(_names) and "人工复核" not in set(_names.values()),
              f"{_names}")
        _neg = dict(_names)
        _neg["DP3"] = "人工复核"
        check("V34c", "反向对照：把 DP3 名改回「人工复核」，V34b 会红（不是恒真）",
              (len(set(_neg.values())) != len(_neg) or "人工复核" in set(_neg.values())),
              "改回旧名 → 判据命中")

    # ── V35 D16：品线取值域部分确认（先只确认吸奶器）────────────────
    if not a.only or a.only.startswith("V35"):
        _pl = json.loads((SKEL / "product-lines-v1.json").read_text(encoding="utf-8"))
        _conf = [v for v in _pl["values"] if v.get("$confirmed")]
        check("V35a", "D16 落地：状态是「部分确认」而不是「已确认」（确认一部分不等于确认）",
              _pl.get("status") == "partially_confirmed"
              and bool(_pl.get("decided_by")) and bool(_pl.get("decided_at")),
              f"status={_pl.get('status')} · {_pl.get('decided_by')} @ {_pl.get('decided_at')}")
        check("V35b", "恰好一个取值被确认，且是「吸奶器」（覆盖 289/291 的那一个）",
              len(_conf) == 1 and _conf[0]["value"] == "吸奶器",
              f"已确认 {[v['value'] for v in _conf]} / 共 {len(_pl['values'])} 个取值")
        _real = {k: v for k, v in _pl["assignments"].items() if not k.startswith("$")}
        check("V35c", "`assignments` 保持为空 = 不收窄（收窄写错的后果是整条品线静默漏报）",
              not _real, f"实际归属 {list(_real)}" if _real else "无实际归属（= 适用全部品线）")
        # ★ 第一版这条也写错了：它拿**已确认的**「家纺」去测未知值路径 ——
        #   而 家纺 本来就在取值域里。改错字去测，才第一次看见真问题：
        #   `$unknown_value_policy` 声明了「不在取值域内要写明」，而 `_boundary`
        #   从来没调用过 `line_value_known()`，于是错字与合法取值得到逐字相同的声明。
        #   已修（judge._boundary），这条检查现在守的就是它。
        _typo = J.judge("超强吸水，柔软亲肤的四件套", product_line="吸奶器X")
        _known = J.judge("超强吸水，柔软亲肤的四件套", product_line="家纺")
        _t_s, _k_s = json.dumps(_typo["boundary_statement"], ensure_ascii=False), \
            json.dumps(_known["boundary_statement"], ensure_ascii=False)
        check("V35d", "错字取值必须在边界声明里显形（且合法取值不得出现这段话）",
              "不在取值域内" in _t_s and "不在取值域内" not in _k_s,
              f"错字「吸奶器X」→ {'已写明' if '不在取值域内' in _t_s else '❌ 未写明'} · "
              f"合法「家纺」→ {'❌ 也写了（噪声）' if '不在取值域内' in _k_s else '未写（对）'}")
        _neg_conf = [dict(x) for x in _pl["values"]]
        next(x for x in _neg_conf if x["value"] != "吸奶器")["$confirmed"] = {"by": "（反向对照）"}
        _n2 = len([x for x in _neg_conf if x.get("$confirmed")])
        check("V35e", "反向对照：多确认一个取值时 V35b 会红（`恰好一个`不是恒真）",
              _n2 != 1, f"假设再确认一个 → 已确认计数 {_n2}（V35b 要求 == 1）")

    # ── V36 D14：送达管道（回执可路由 + 未映射即硬失败）────────────
    if not a.only or a.only.startswith("V36"):
        _rp = Path(tempfile.mkdtemp()) / "r36.jsonl"
        _blk = J.judge("This device will cure your disease and heal you fast.",
                       receipt=True, receipt_path=_rp, origin="test",
                       ad_account="Momcozy-Angel-FR", ad_id="GG-x")
        _rt = ((_blk["receipt"].get("obligations") or {}).get("route") or {})
        check("V36a", "D14 落地：回执带**可解析的路由键**（`to` 是角色，`route.key` 才是「查得到谁」）",
              _rt.get("key") == "Momcozy-Angel-FR" and _rt.get("kind") == "ad_account"
              and _rt.get("$status") == "ready",
              f"route={ {k: _rt.get(k) for k in ('key', 'kind', '$status')} }")
        _no = J.judge("This device will cure your disease.", receipt=True,
                      receipt_path=Path(tempfile.mkdtemp()) / "r36b.jsonl", origin="test")
        _rt2 = ((_no["receipt"].get("obligations") or {}).get("route") or {})
        check("V36b", "没传路由键时如实记账（`no_route_key`），而不是假装送得出去",
              _rt2.get("$status") == "no_route_key" and _rt2.get("key") is None,
              f"$status={_rt2.get('$status')}")

        import csv as _csv
        _accts = {(r.get("广告账号") or "").strip() for r in
                  json.loads((SKEL / "_data" / "records.json").read_text(encoding="utf-8"))}
        with (SKEL / "_data" / "account-owners.csv").open(encoding="utf-8-sig", newline="") as _f:
            _rows = {r["广告账号"].strip() for r in _csv.DictReader(_f)}
        _miss = {a for a in _accts if a and a not in _rows}
        check("V36c", "责任人映射表覆盖语料里出现的每一个广告账号（一个不漏，否则漏的那批无处可去）",
              not _miss and ("（账号名为空）" in _rows),
              f"语料 {len([a for a in _accts if a])} 个账号 · 表 {len(_rows)} 行 · 缺 {sorted(_miss)}"
              + (" · 空账号行已列" if "（账号名为空）" in _rows else " · ❌ 空账号行缺失"))

        # ★ 这一条的第一版是 `(a and b) or c` —— 括号一省，`退出码 == 0` 单独就能让它绿。
        #   而生产账本当时**一条可送达的回执都没有**，退出码本来就是 0 —— 于是一条恒真检查
        #   占住了「未映射即硬失败」这个最关键的覆盖位。硬失败的反向对照现在落在 V39c/d，
        #   这里只留**正面**证据：生产账本的状态必须被完整报出来（含不可送达的旧回执）。
        _o5 = subprocess.run([sys.executable, "tools/push_receipts.py", "--status"],
                             cwd=str(ROOT), capture_output=True, text=True)
        _prod = [json.loads(x) for x in
                 (SKEL / "_data" / "receipts.jsonl").read_text(encoding="utf-8").splitlines()
                 if x.strip()]
        _legacy_prod = [rc for rc in _prod if "obligations" not in rc]
        _m_leg = re.search(r"不可送达的旧回执 (\d+) 条", _o5.stdout)
        check("V36d", "生产账本状态被完整报出：待送/缺路由计数 + **不可送达的旧回执单独计数**"
                      "（「待送 0」不许当「一切正常」）",
              _o5.returncode == 0 and "待送" in _o5.stdout
              and (not _legacy_prod or (bool(_m_leg)
                                        and int(_m_leg.group(1)) == len(_legacy_prod))),
              f"退出码={_o5.returncode} · 旧回执（无 obligations 块）{len(_legacy_prod)} 条 · "
              f"工具印出 {_m_leg.group(1) if _m_leg else '（未印）'}")

        _d1 = next(x for x in (json.loads((SKEL / "legal-decisions-v1.json")
                                          .read_text(encoding="utf-8"))["decisions"]) if x["id"] == "D1")
        _obs = {o["id"]: o for o in _d1["obligations"]}
        _o3b, _o3c = _obs.get("D1-O3b"), _obs.get("D1-O3c")
        # ★ 三层必须分开记：政策已定（O3a）· 送得出去（O3b）· 已经送过（O3c）。
        #   合并任意两层，结论就会比事实大一级 —— 这正是本轮反复在治的病。
        check("V36e", "「送得出去」与「已经送过」分开记账（O3b met 且声明了它不主张什么 / O3c unmet 且有主人）",
              _o3b is not None and _o3c is not None
              and _o3b["status"] == "met" and bool(_o3b.get("evidence"))
              and "does_not_claim" in json.dumps(_o3b, ensure_ascii=False)
              and _o3c["status"] == "unmet" and "Q14" in (_o3c.get("owner") or ""),
              f"O3b={_o3b['status']} · O3c={_o3c['status']}"
              f"（owner={(_o3c.get('owner') or '')[:18]}…）")

    # ── V37 回执账本完整性（前缀哈希链 · 事故后加的机制）────────────
    if not a.only or a.only.startswith("V37"):
        _D = SKEL / "_data"
        _cur = (_D / "receipts.jsonl").read_text(encoding="utf-8")
        _ch = json.loads((_D / "receipts.chain.json").read_text(encoding="utf-8"))["chain"]

        def _prefix(n):
            _ls = _cur.splitlines()[:n]
            return ("\n".join(_ls) + "\n") if _ls else ""

        _broken = [e["n"] for e in _ch
                   if hashlib.sha256(_prefix(e["n"]).encode()).hexdigest() != e["sha256"]]
        check("V37a", "回执账本只追加：前缀哈希链逐环校验通过（截断/改写/覆盖都会红）",
              not _broken and len(_cur.splitlines()) >= _ch[-1]["n"],
              f"{len(_ch)} 环 · 当前 {len(_cur.splitlines())} 行 · 断链 {_broken}")

        _tests = [l for l in _cur.splitlines()
                  if l.strip() and json.loads(l).get("origin") == "test"]
        check("V37b", "生产账本里没有测试回执（本次事故的直接成因）",
              not _tests, f"{len(_tests)} 条 origin=test" if _tests else "0 条")
        check("V37c", "反向对照：账本被截断一行后链会断（不是恒真）",
              (len(_ch) == 0)
              or hashlib.sha256(("\n".join(_cur.splitlines()[:max(0, _ch[-1]["n"] - 1)])
                                 + "\n").encode()).hexdigest() != _ch[-1]["sha256"],
              "截断一行的哈希与链上最后一环不同")
        check("V37d", "已知的账本损坏有留档（不只是在会话里说了一句）",
              (_D / "receipts.LOSS.md").exists(),
              "「4 条回执不可恢复」已写进 _data/receipts.LOSS.md")


    # ── V38 回归工具必须看得见处置层（工具自己的一次事故）─────────────
    #   `ab_engine_diff.py` 的子进程原先只调 `eng.assess()`，从不调 `resolve_layer`，
    #   却把汇总行写成「处置层发生变化：N 条」。D13 把 13 条从 DP4 挪到 DP3 之后，
    #   它照样报 0 —— **一个声称覆盖处置层的工具，覆盖不到处置层**。
    #   这一组用「只抽掉 D13 豁免」的对照制品跑它一次，从输出里断言三件事。
    if not a.only or a.only.startswith("V38"):
        _bd = Path(tempfile.mkdtemp()) / "before_d13"
        _bd.mkdir()
        _l4 = json.loads((SKEL / "disposition-layers-v1.json").read_text(encoding="utf-8"))
        for _x in _l4["escalate_if"]:
            if _x["id"] == "ESC-002":
                _x["exempt_rule_keys"] = []
        (_bd / "disposition-layers-v1.json").write_text(
            json.dumps(_l4, ensure_ascii=False, indent=2), encoding="utf-8")
        _o6 = subprocess.run(
            [sys.executable, "tools/ab_engine_diff.py", "--before", str(_bd), "--json"],
            cwd=str(ROOT), capture_output=True, text=True)
        try:
            _res = json.loads(_o6.stdout)
        except Exception:                                     # noqa: BLE001
            _res = None
        _bd2 = (_res or {}).get("changed_by_dimension") or {}
        check("V38a", "回归工具确实计算了处置层（抽掉 D13 豁免后，`处置层` 维度必须非零）",
              bool(_res) and _bd2.get("layer", 0) > 0,
              f"layer={_bd2.get('layer')} · assess 级={_bd2.get('hits')} · "
              f"disposition={_bd2.get('disposition')} · 例外={_bd2.get('exempted')}"
              + ("" if _res else f" · ❌ 工具输出不可解析：{_o6.stderr[-160:]}"))
        check("V38b", "D13 只动处置层：assess 级与记录级结论一字未变（分层不是改判定）",
              bool(_res) and _bd2.get("hits", 1) == 0 and _bd2.get("disposition", 1) == 0
              and _bd2.get("layer") == 13,
              f"抽掉豁免 → layer {_bd2.get('layer')} 条换层（应为 13）· "
              f"hits {_bd2.get('hits')} · disposition {_bd2.get('disposition')}")
        # ★ 这一条的第一版是 `(a - b) == (a - b)` —— 一个**恒真的废检查**。
        #   废检查比没有检查更坏：它占着「已覆盖」的位置。改成查真东西：
        #   同一个工具的人读输出与机器输出必须给出**同一个数字**。
        #   （linter 印出的「14 词」与它自己算出的 16 词不一致，就是这个病的最小形态。）
        _o7 = subprocess.run(
            [sys.executable, "tools/ab_engine_diff.py", "--before", str(_bd)],
            cwd=str(ROOT), capture_output=True, text=True)
        _m = re.search(r"逐字未变：(\d+) 条 / 共 (\d+) 条", _o7.stdout)
        _m2 = re.search(r"处置层：(\d+) 条", _o7.stdout)
        _tot = (_res or {}).get("records", 0)
        _ch = (_res or {}).get("changed_count", -1)
        check("V38c", "人读输出与机器输出的数字一致（防止汇总行印出一个它自己没算过的数）",
              bool(_res) and bool(_m) and int(_m.group(1)) == _tot - _ch
              and int(_m.group(2)) == _tot
              and bool(_m2) and int(_m2.group(1)) == _bd2.get("layer", -1),
              f"JSON：{_tot} 条 / 变化 {_ch} / layer {_bd2.get('layer')} · "
              f"人读：未变 {_m.group(1) if _m else '?'} / 共 {_m.group(2) if _m else '?'} / "
              f"处置层 {_m2.group(1) if _m2 else '?'}")

    # ══ V39 · 2026-09-16（D19）责任人映射：送达的最后一块 ═════════════
    #   D1-O3 被拆成三条记账：政策已定（O3a）· 送得出去（O3b）· 已经送过（O3c）。
    #   这一组守的是 O3b：**「有人」和「有地址」是两件事**，而「表里填了名字」
    #   与「消息真能到那个人手上」又是第三件事。所以每一条正面证据都配了反向对照 ——
    #   因为本组最重要的行为是**硬失败**，而硬失败只能靠造出那个条件来证明。
    if not a.only or a.only.startswith("V39"):
        import csv as _csv2
        _D = SKEL / "_data"

        def _owners_rows(path: Path) -> list:
            with path.open(encoding="utf-8-sig", newline="") as f:
                return list(_csv2.DictReader(f))

        _rows = _owners_rows(_D / "account-owners.csv")
        _nobody = [r.get("广告账号") for r in _rows if not (r.get("责任人") or "").strip()]
        _bad = [r.get("广告账号") for r in _rows
                if not re.match(r"^ou_[0-9a-f]{32}$", (r.get("飞书open_id") or "").strip())]
        _noev = [r.get("广告账号") for r in _rows if not (r.get("责任人证据") or "").strip()]
        check("V39a", "D19 落地：12 个广告账号都有责任人、都有**可用形状**的投递地址、且地址写明了出处",
              len(_rows) == 12 and not _nobody and not _bad and not _noev,
              f"{len(_rows)} 行 · 无责任人 {_nobody or '无'} · 无/坏地址 {_bad or '无'} · "
              f"无出处 {_noev or '无'}")

        # ── 端到端：用**真语料里真被机器拦下的一条**生成回执，再走一遍真路由 ──
        def _mk_ledger(dst: Path, *, with_account: bool = True):
            """临时账本（生产账本一行不动）。返回所选记录，找不到就返回 None。"""
            for r in json.loads((_D / "records.json").read_text(encoding="utf-8")):
                txt = ((r.get("Primary Text") or "") + "\n" + (r.get("Headline") or "")).strip()
                if not txt or not (r.get("广告账号") or ""):
                    continue
                kw = {"ad_account": r["广告账号"], "ad_id": r.get("外部广告ID")} \
                    if with_account else {"ad_id": r.get("外部广告ID")}
                L = J.judge(txt, **kw)["verdict"]["layer"]
                if L["id"] == "DP2" and L.get("machine_may_finalize"):
                    J.judge(txt, origin="test", receipt=True, receipt_path=dst, **kw)
                    return r
            return None

        def _push(*args, ledger: Path, pushed: Path, owners: Path | None = None):
            cmd = [sys.executable, "tools/push_receipts.py",
                   "--receipts", str(ledger), "--pushed", str(pushed)]
            if owners is not None:
                cmd += ["--owners", str(owners)]
            return subprocess.run(cmd, cwd=str(ROOT), capture_output=True, text=True)

        def _tmp_owners(path: Path, rows: list):
            with path.open("w", encoding="utf-8", newline="") as f:
                w = _csv2.writer(f)
                w.writerow(["广告账号", "责任人", "飞书open_id"])
                w.writerows(rows)

        _T = Path(tempfile.mkdtemp())
        _led = _T / "r.jsonl"
        _pushed = _T / "p.jsonl"
        _rec = _mk_ledger(_led)
        _o = _push(ledger=_led, pushed=_pushed)
        rec_acct = (_rec or {}).get("广告账号")
        _roxy = next((r for r in _rows if r.get("广告账号") == rec_acct), None)
        check("V39b", "端到端：真记录的真回执 → 路由键 → 解析到真人 + 真地址（预演里印出来）",
              _rec is not None and _o.returncode == 0 and _roxy is not None
              and "Roxie" in _o.stdout
              and (_roxy.get("飞书open_id") or "") in _o.stdout
              and "待送 1" in _o.stdout,
              f"记录「{(_rec or {}).get('广告名称', '?')[:26]}」· 账号 {rec_acct} · "
              f"退出码={_o.returncode} · 输出含责任人/地址="
              f"{('Roxie' in _o.stdout) and ((_roxy or {}).get('飞书open_id', '') in _o.stdout)}")

        # ── 三条反向对照：把「送不出去」的条件真的造出来 ──
        # ★ 第一版这里写的是 `_o_e = _tmp_owners(...)` —— 而 `_tmp_owners` 没有返回值，
        #   于是 `--owners` 拿到的永远是生产表，「反向对照」跑的是正面路径：
        #   四条全绿、全是假的。**一个写错的反向对照比没有对照更坏**，因为它证明的是
        #   「检查能过」，不是「行为正确」。现在路径与写入分开写，写错就变红。
        _p_e = _T / "own_empty.csv"
        _tmp_owners(_p_e, [("Momcozy-Angel-FR", "", "")])
        _r_e = _push(ledger=_led, pushed=_pushed, owners=_p_e)
        check("V39c", "反向对照：责任人清空 → 推送工具**硬失败**（退出码 2），不静默跳过",
              _r_e.returncode == 2 and "责任人未填" in _r_e.stdout,
              f"退出码={_r_e.returncode} · "
              f"{next((l.strip() for l in _r_e.stdout.splitlines() if '责任人未填' in l), '(无提示)')[:70]}")

        _p_n = _T / "own_noaddr.csv"
        _tmp_owners(_p_n, [("Momcozy-Angel-FR", "Roxie（成员A）", "")])
        _r_n = _push(ledger=_led, pushed=_pushed, owners=_p_n)
        check("V39d", "反向对照：有责任人但**没有投递地址** → 同样硬失败（有名字 ≠ 送得到）",
              _r_n.returncode == 2 and "有责任人但无投递地址" in _r_n.stdout,
              f"退出码={_r_n.returncode}")

        _p_b = _T / "own_bad.csv"
        _tmp_owners(_p_b, [("Momcozy-Angel-FR", "Roxie（成员A）", "user@example.com")])
        _r_b = _push(ledger=_led, pushed=_pushed, owners=_p_b)
        check("V39d2", "反向对照：地址形状不对 → 本地就拦下，不等飞书 API 报错",
              _r_b.returncode == 2 and "地址形状不对" in _r_b.stdout,
              f"退出码={_r_b.returncode}")

        # ── 「待送 0」不许当「一切正常」：旧回执必须显形（含反向对照）──
        _leg_led = _T / "legacy.jsonl"
        _leg_led.write_text(json.dumps({"run_id": "jr-legacy-0000", "origin": "shouheng",
                                        "issued_at": "2026-09-15T00:00:00+00:00"},
                                       ensure_ascii=False) + "\n", encoding="utf-8")
        _r_l = _push(ledger=_leg_led, pushed=_pushed)
        check("V39e", "反向对照：账本里只有一条**没有 obligations 块的旧回执**时，"
                      "工具必须说「不可送达」而不是「待送 0」",
              "不可送达的旧回执 1 条" in _r_l.stdout and "jr-legacy-0000" in _r_l.stdout,
              f"退出码={_r_l.returncode} · "
              f"{next((l.strip() for l in _r_l.stdout.splitlines() if '旧回执' in l), '(无)')[:60]}")

        # ── 空账号兜底：能送，但必须**看得见**；而有账号名却查不到人时**不得**兜底 ──
        _led2 = _T / "r2.jsonl"
        _mk_ledger(_led2, with_account=False)
        _r_f = _push(ledger=_led2, pushed=_pushed)
        _p_x = _T / "own_unknown.csv"
        _tmp_owners(_p_x, [("别的账号", "Roxie（成员A）",
                            "ou_TEST_USER"),
                           ("（账号名为空）", "Roxie（成员A）",
                            "ou_TEST_USER")])
        _r_x = _push(ledger=_led, pushed=_pushed, owners=_p_x)
        check("V39f", "空账号兜底**可见**（ad_id 路由打印并计数）；"
                      "但有账号名而表里查不到人时**不得**兜底，必须硬失败",
              _r_f.returncode == 0 and "空账号兜底 1" in _r_f.stdout
              and _r_x.returncode == 2 and "责任人未填" in _r_x.stdout,
              f"兜底路径退出码={_r_f.returncode}（{'含兜底计数' if '空账号兜底 1' in _r_f.stdout else '未计数'}）"
              f" · 未知账号退出码={_r_x.returncode}")

        # ── V39g D21：自检实发的留痕必须**自己说明它不是真实送达** ──────
        #   这份留痕会被当成「有没有真的发过」的证据。它若与真实送达混在一起，
        #   等于**伪造一次送达** —— 而本项目刚因为「把声明当成事实」查了一整轮。
        def _selftest_problems(rows: list) -> list:
            bad = []
            for r in rows:
                if r.get("$selftest") is not True:
                    bad.append(f"{r.get('run_id')}: 自检留痕没有 `$selftest` 标记"
                               f"（会被读成真实送达）")
                if r.get("code") != 0:
                    bad.append(f"{r.get('run_id')}: 没有记录飞书返回码（code={r.get('code')}）")
                if not str(r.get("redirected_to") or "").startswith("ou_"):
                    bad.append(f"{r.get('run_id')}: 没有记录重定向到谁（无法核收件人不是责任人）")
                if r.get("redirected_to") and r.get("redirected_to") == r.get("to"):
                    bad.append(f"{r.get('run_id')}: 收件人与责任人同名（那就不是自检）")
            return bad

        _st_p = _D / "pushed.selftest.jsonl"
        _st = [json.loads(x) for x in _st_p.read_text(encoding="utf-8").splitlines() if x.strip()] \
            if _st_p.exists() else []
        _prod_pushed = _D / "pushed.jsonl"
        _prod_ids = {json.loads(x).get("run_id") for x in
                     _prod_pushed.read_text(encoding="utf-8").splitlines() if x.strip()} \
            if _prod_pushed.exists() else set()
        _st_problems = _selftest_problems(_st)
        check("V39g", "D21 落地：自检实发有留痕（code 0 + 收件人 + `$selftest` 标记），"
                      "且**不与真实送达混在一起**",
              bool(_st) and not _st_problems
              and not ({r.get("run_id") for r in _st} & _prod_ids),
              f"{len(_st)} 条自检留痕 · code={[r.get('code') for r in _st]} · "
              f"{'；'.join(_st_problems) if _st_problems else '标记齐备 · 与生产已推送记录无交集'}")

    # ══ V40 · 2026-09-16（D19）独立站侧：责任人落表，缺口显形 ═══════════
    #   Owner 给的不只是广告账号负责人，还有**独立站负责人 Rikka**。这条信息必须落在
    #   一个地方并且**带上它的缺口**：她只有名字、没有投递地址。
    #   本组守两件事：① 表覆盖语料里出现的每个站点，一个不漏；
    #   ② 缺口是**写出来的**（「（未定）」+ 说明），不是留空的 —— 留空与「已备好」长得一样。
    if not a.only or a.only.startswith("V40"):
        import csv as _csv3
        _site_p = SKEL / "_data" / "site-owners.csv"
        _met = json.loads((ROOT / "research" / "landing" / "指标.json").read_text(encoding="utf-8"))
        _domains = set((_met.get("指标1_内容获取成功率") or {}).get("分域名") or {})
        with _site_p.open(encoding="utf-8-sig", newline="") as f:
            _srows = list(_csv3.DictReader(f))
        with (SKEL / "_data" / "account-owners.csv").open(encoding="utf-8-sig", newline="") as f:
            _acct_keys = {r["广告账号"].strip() for r in _csv3.DictReader(f)}

        def _cov_problems(rows: list, domains: set) -> list:
            """V40a 的判据。抽成函数是为了 V40d 能对**同一判据**做反向对照。"""
            bad = []
            have = {r["域名"].strip() for r in rows}
            miss = sorted(domains - have)
            if miss:
                bad.append(f"语料里有、表里没有的域名：{miss}")
            if len(rows) != len(domains):
                bad.append(f"行数 {len(rows)} ≠ 语料域名数 {len(domains)}")
            return bad

        def _gap_problems(rows: list) -> list:
            """V40b 的判据：地址要么是可用的 open_id，要么是**写出来的**「（未定）」。留空最坏。"""
            bad = []
            for r in rows:
                a = (r.get("飞书open_id") or "").strip()
                if not a:
                    bad.append(f"{r['域名']}: 地址留空（留空与「已备好」长得一样）")
                elif a != "（未定）" and not re.match(r"^ou_[0-9a-f]{32}$", a):
                    bad.append(f"{r['域名']}: 地址既不是可用 open_id 也不是显式未定 —— {a[:16]}")
                if "Q16" not in (r.get("备注") or ""):
                    bad.append(f"{r['域名']}: 没写明缺口指向哪里（Q16）")
            return bad

        _rikka = [r for r in _srows if r["域名"].endswith("momcozy.com")]
        _cp, _gp = _cov_problems(_srows, _domains), _gap_problems(_rikka)
        check("V40a", "独立站侧路由表覆盖语料里出现的每一个落地页域名（含非 momcozy 的那一个）",
              bool(_domains) and not _cp,
              f"语料 {len(_domains)} 个域名 · 表 {len(_srows)} 行 · "
              + ("；".join(_cp) if _cp else "一个不漏"))

        check("V40b", "Rikka 的责任人已落表；她的**投递地址缺口是显式的**"
                      "（写「（未定）」并写明指向 Q16，而不是留空装作已备）",
              bool(_rikka) and not _gp,
              f"{len(_rikka)} 行写 Rikka · " + ("；".join(_gp) if _gp else "缺口显式（（未定）+ Q16）"))

        _dup = sorted({r["域名"].strip() for r in _srows} & _acct_keys)
        check("V40c", "两张路由表的路由键不相交（账号名 vs 域名 —— 同一个键不能有两个责任人）",
              not _dup, f"{len(_acct_keys)} 个账号键 ∩ {len(_srows)} 个域名键 = {_dup or '空'}")

        # ★ 反向对照必须真的动得了：这一版第一次写出来时，它是 `"" == "（未定）"` 取反 ——
        #   一个恒真的废检查（V38c 犯过同样的错）。改成对**同一对判据**喂两份坏数据。
        _m1 = [r for r in (dict(x) for x in _srows) if r["域名"] != "uk.momcozy.com"]
        _m2 = [dict(r) for r in _srows]
        next(r for r in _m2 if r["域名"] == "de.momcozy.com")["飞书open_id"] = ""
        _cp1, _gp2 = _cov_problems(_m1, _domains), _gap_problems(
            [r for r in _m2 if r["域名"].endswith("momcozy.com")])
        check("V40d", "反向对照：漏一个域名 / 把「（未定）」改成留空，V40a 与 V40b 的判据都会红",
              any("uk.momcozy.com" in p for p in _cp1)
              and any("留空" in p for p in _gp2),
              f"抽掉 uk → {_cp1[:1]} · 留空 de 的地址 → {_gp2[:1]}")

    # ══ V41 · 2026-09-16（D20）两路整改：发现要变成带收件人的待办 ═══════
    #   C 批的产出此前只有一份报告 —— 而报告不会通知任何人。D20 把发现分成两路：
    #   页面侧（Rikka）与法务判定侧。本组守三件事：
    #   ① 两路合起来**一条不漏**地覆盖来源里的全部发现（判据不在这里重写，直接读来源）；
    #   ② 收件人**只有一处书写位置**（site-owners.csv），且**不可送达这件事逐行写出来**；
    #   ③ 两路不许串（法务侧的收件人不能是 Rikka）。
    if not a.only or a.only.startswith("V41"):
        _rt_p = ROOT / "research" / "landing" / "整改路由.json"
        _rt = json.loads(_rt_p.read_text(encoding="utf-8")) if _rt_p.exists() else {}
        _src = json.loads((ROOT / "research" / "landing" / "一致性分析.json")
                          .read_text(encoding="utf-8"))
        with (SKEL / "_data" / "site-owners.csv").open(encoding="utf-8-sig", newline="") as f:
            _site_rows2 = list(_csv3.DictReader(f))
        _owner_row = next((r for r in _site_rows2 if r["域名"] == "momcozy.com"), {})
        _owner_addr = (_owner_row.get("飞书open_id") or "").strip()

        def _route_problems(doc: dict, src: dict, owner_addr: str) -> list:
            """V41a–V41c 的判据。抽成函数是为了 V41d 能对同一判据做反向对照。"""
            bad = []
            site, legal = doc.get("页面侧") or {}, doc.get("法务侧") or {}
            want_site = [c["handle"] for c in (src.get("表B_跨locale一致性") or {})
                         .get("逐产品", []) if c.get("参数或认证不一致")]
            got_site = [r["产品handle"] for r in site.get("逐条") or []]
            if got_site != want_site:
                bad.append(f"页面侧条目与来源不一致：{len(got_site)} 条 vs 应有 {len(want_site)} 条")
            want_legal = [a["广告record_id"] for a in
                          (src.get("表A_广告vs落地页") or {}).get("逐条", [])]
            got_legal = [r["广告record_id"] for r in legal.get("逐条") or []]
            if got_legal != want_legal:
                bad.append(f"法务侧条目与来源不一致：{len(got_legal)} 条 vs 应有 {len(want_legal)} 条")
            if set(got_site) & set(got_legal):
                bad.append("两路出现同一条（同一个键不能有两个人接）")
            # 收件人：页面侧必须等于 site-owners.csv 里的责任人，且送达状态与该地址一致
            if site.get("收件人") != _owner_row.get("责任人"):
                bad.append(f"页面侧收件人 {site.get('收件人')!r} ≠ site-owners.csv 的"
                           f"{_owner_row.get('责任人')!r}（路由目标必须只有一处）")
            _can = owner_addr.startswith("ou_")
            _st = site.get("送达状态") or ""
            if _can and "不可送达" in _st:
                bad.append("地址已可用，路由表却仍写「不可送达」")
            if not _can and "不可送达" not in _st:
                bad.append("地址不可用，路由表却没写「不可送达」—— 路由表会读成「已派出」")
            for r in site.get("逐条") or []:
                if "不可送达" not in (r.get("送达状态") or "") and not _can:
                    bad.append(f"{r['产品handle']}: 行内没有写送达状态")
            for r in legal.get("逐条") or []:
                if "法务" not in (r.get("责任人") or ""):
                    bad.append(f"{r['广告record_id']}: 法务侧的收件人不是法务（两路串了）")
                if not (r.get("声明明细") or "").strip():
                    bad.append(f"{r['广告record_id']}: 没有声明明细（法务看不出凭什么判）")
                if "构成问题" not in (r.get("待法务回答的问题") or ""):
                    bad.append(f"{r['广告record_id']}: 没写清要法务回答什么")
            return bad

        _rp = _route_problems(_rt, _src, _owner_addr)
        check("V41a", "D20 落地：两路合起来覆盖来源里的全部发现（页面侧 4 个产品 / 法务侧 33 条），"
                      "且没有一条被两路同时接走",
              bool(_rt) and not _rp,
              f"页面侧 {(_rt.get('页面侧') or {}).get('条数')} 条 · "
              f"法务侧 {(_rt.get('法务侧') or {}).get('条数')} 条 · "
              + ("；".join(_rp) if _rp else "两路与来源逐条一致"))

        check("V41b", "页面侧收件人**只有一处书写位置**（site-owners.csv），"
                      "且「不可送达」这件事**逐行写出来**（不是留在会话里）",
              bool(_rt) and (_rt.get("页面侧") or {}).get("收件人")
              == _owner_row.get("责任人")
              and (("不可送达" in ((_rt.get("页面侧") or {}).get("送达状态") or ""))
                   if not _owner_addr.startswith("ou_") else True),
              f"收件人={(_rt.get('页面侧') or {}).get('收件人')} · "
              f"地址={_owner_addr or '（空）'} · "
              f"状态={((_rt.get('页面侧') or {}).get('送达状态') or '')[:34]}…")

        _legal_blob = json.dumps((_rt.get("法务侧") or {}).get("逐条") or [], ensure_ascii=False)
        check("V41c", "两路不许串：法务侧每条都带声明明细与「要法务回答什么」，"
                      "收件人是法务而不是页面责任人",
              bool(_legal_blob) and "Rikka" not in _legal_blob
              and "待法务回答的问题" in json.dumps(_rt, ensure_ascii=False),
              f"法务侧 {(_rt.get('法务侧') or {}).get('条数')} 条 · "
              f"含页面责任人姓名={'Rikka' in _legal_blob}")

        # 反向对照：抽掉一个产品 / 把「不可送达」抹成「可送达」，判据都必须红
        _mut_a = json.loads(json.dumps(_rt, ensure_ascii=False))
        _mut_a["页面侧"]["逐条"] = _mut_a["页面侧"]["逐条"][:-1]
        _mut_b = json.loads(json.dumps(_rt, ensure_ascii=False))
        if not _owner_addr.startswith("ou_"):
            _mut_b["页面侧"]["送达状态"] = "可送达"
        else:                                    # 地址可用时用另一条判据：法务侧串人
            _mut_b["法务侧"]["逐条"][0]["责任人"] = "Rikka（林建纯）"
        _p_a, _p_b = _route_problems(_mut_a, _src, _owner_addr), \
            _route_problems(_mut_b, _src, _owner_addr)
        check("V41d", "反向对照：抽掉一个页面侧产品 / 抹掉「不可送达」（或把两路串起来），"
                      "V41a–V41c 的判据都会红",
              bool(_p_a) and bool(_p_b),
              f"抽掉一条 → {_p_a[:1]} · 抹掉缺口 → {_p_b[:1]}")

    # ══ V42 · 2026-09-16（D22）投递地址层：阴性结论必须先有阳性对照 ═════
    #   起因：Owner 给了 Rikka 的**姓名**（不是地址），触发一次"按姓名找人"。找的过程中
    #   我写了一个恒真扫描 —— 用 created_by / last_modified_by 扫 6000+ 条记录说"零命中"，
    #   其实那两个字段在响应里**恒为 null**，扫描根本没有输入。
    #   所以本组守的不是"找到了没有"，而是**"看不见"这个结论本身可不可信**：
    #   ① 解析器必须先自证看得见（锚点可解析、字典够规模），否则拒绝给否定结论；
    #   ② 空字典 → 必须回 unverifiable，**不许**回 not_found（哪怕调用方说 verified=True）；
    #   ③ 姓名只有一个、地址为空时，路由表必须继续硬失败 —— 禁止"按姓名猜地址"。
    if not a.only or a.only.startswith("V42"):
        import csv as _csv4                      # V41 块里的 _csv3 是局部导入，这里要自带
        import importlib.util as _ilu
        _spec = _ilu.spec_from_file_location("lark_people", ROOT / "tools" / "lark_people.py")
        _lp = _ilu.module_from_spec(_spec)
        _spec.loader.exec_module(_lp)
        _pp = SKEL / "_data" / "lark-visible-people.csv"
        _people = []
        if _pp.exists():
            with _pp.open(encoding="utf-8", newline="") as f:
                _rdr = _csv4.reader(f)
                next(_rdr, None)                       # 第 1 行是采集元信息
                _hdr = next(_rdr, [])
                for _row in _rdr:
                    _d = dict(zip(_hdr, _row))
                    if (_d.get("姓名") or _d.get("邮箱")):
                        _people.append({"姓名": _d.get("姓名", ""), "en_name": _d.get("en_name", ""),
                                        "邮箱": _d.get("邮箱", ""), "open_id": _d.get("open_id", ""),
                                        "出处": _d.get("出处", "")})
        # ★ 2026-09-21 修：`verify_resolver` 改成**每条通道各自自证**之后，
        #   这里还按旧签名只传 people 一个参数 → stat 为空 → 通道二、三一律
        #   被读成「没采到」→ V42a/V42b 恒红（174/176）。
        #   根因不在这一行，在产物：写 CSV 的元信息行当时没记第三条通道的读数。
        #   现在读数由 `lark_people.CHANNELS` 现算，这里用**同一个解析器**读回来
        #   （单一解析点，见 §2.5）。
        _stat = _lp.parse_meta(_pp)
        _ok, _why = _lp.verify_resolver(_people, _stat)
        _neg = _lp.resolve("林建纯", _people, verified=_ok, why=_why)
        # site 侧地址自己读一遍（V41 块里的 _owner_addr 是那一段的局部变量）
        with (SKEL / "_data" / "site-owners.csv").open(encoding="utf-8-sig", newline="") as f:
            _site_now = list(_csv4.DictReader(f))
        _own_now = next((r for r in _site_now if r["域名"] == "momcozy.com"), {})
        _can = (_own_now.get("飞书open_id") or "").strip().startswith("ou_")
        check("V42a", "投递地址层：解析器先自证看得见（锚点可解析 + 字典够规模）——"
                      "没有这一步，任何「查无此人」都是恒真结论",
              _ok and bool(_people),
              f"{_why} · 字典文件={'有' if _pp.exists() else '★缺'} · {len(_people)} 人")
        check("V42b", "阴性结论成立：Owner 给的是**姓名**，本应用确实看不见她（不是搜不到），"
                      "而页面侧路由因此仍为硬失败 —— 有名字 ≠ 送得到",
              _neg["status"] == "not_found" and _ok and not _can,
              f"resolve={_neg['status']} · 阳性对照={'过' if _ok else '未过'} · "
              f"site 地址={'可用' if _can else '（未定）'}")
        # 反向对照：把字典抽空 —— 必须变成"无法作答"，而不是"查无此人"
        _v_empty = _lp.resolve("林建纯", [], verified=True, why="反例")
        _v_anchor = _lp.verify_resolver([p for p in _people if p["姓名"] != _lp.ANCHOR["name"]])
        check("V42c", "反向对照：字典抽空 → 必须回 unverifiable（**不许**回 not_found，"
                      "哪怕调用方传 verified=True）；锚点被抽掉 → 阳性对照必须红",
              _v_empty["status"] == "unverifiable" and _v_anchor[0] is False,
              f"空字典 → {_v_empty['status']} · 抽掉锚点 → {_v_anchor[1][:40]}")


    # ══ V43 · 2026-09-16（D24）路由目标不许有**静默空缺** ═══════════════
    #   起因：`www.amazon.de` 那一行的责任人是「（未定）」而没有指向任何未决项 ——
    #   D19 只定了「广告账号 → Roxie、独立站 → Rikka」，亚马逊站内商品页两边都不对口。
    #   这不是错误，是**没有人接的一行**：它在表里安静地待着，直到 Owner 就 Q18 定了归口（D24）。
    #   本组把地址列已有的那条纪律（V40b：要么可用、要么显式「（未定）」+ 指向题）
    #   原样搬到责任人口径上，并把反向对照做足：留空要红、指针悬空也要红。
    if not a.only or a.only.startswith("V43"):
        import csv as _csv5
        _led2 = json.loads((SKEL / "legal-decisions-v1.json").read_text(encoding="utf-8"))
        _qids = {q["id"] for q in (_led2.get("$decision_queue") or [])}
        with (SKEL / "_data" / "site-owners.csv").open(encoding="utf-8-sig", newline="") as f:
            _orows = list(_csv5.DictReader(f))

        def _owner_problems(rows: list, known_q: set) -> list:
            """V43a 的判据。抽成函数是为了 V43b 能对**同一判据**做反向对照。"""
            bad = []
            for r in rows:
                n = (r.get("责任人") or "").strip()
                note = r.get("备注") or ""
                if not n:
                    bad.append(f"{r['域名']}: 责任人留空（留空与「已备好」长得一样）")
                    continue
                if n == "（未定）":
                    ptr = re.findall(r"Q\d+", note)
                    if not ptr:
                        bad.append(f"{r['域名']}: 责任人「（未定）」却没指向任何未决项"
                                   f"—— 一个没人接又没登记的行，等于静默空缺")
                    elif not (set(ptr) & known_q):
                        bad.append(f"{r['域名']}: 指向的 {ptr} 不在队列里（悬空指针）")
            return bad

        _op = _owner_problems(_orows, _qids)
        check("V43a", "每一个路由目标要么有责任人，要么这个空缺是**可决策的未决项**"
                      "（「（未定）」必须指向队列里真实存在的题）—— 见 D24：`www.amazon.de` 归口已定",
              bool(_orows) and not _op,
              f"{len(_orows)} 行 · " + ("；".join(_op) if _op else
                                        f"全部有主（{len({r['责任人'] for r in _orows})} 种责任人）"))
        # 反向对照：留空要红；「（未定）」指向一个不存在的题号也要红（两种不同的坏法）
        _m1 = [dict(r) for r in _orows]
        _m1[0]["责任人"] = ""
        _m2 = [dict(r) for r in _orows]
        _m2[0]["责任人"], _m2[0]["备注"] = "（未定）", "见 Q99（不存在的题）"
        _p1, _p2 = _owner_problems(_m1, _qids), _owner_problems(_m2, _qids)
        check("V43b", "反向对照：责任人留空 → 必红；「（未定）」指向不存在的题号 → 也必红",
              bool(_p1) and bool(_p2),
              f"留空 → {_p1[:1]} · 悬空指针 → {_p2[:1]}")


    # ── V44（D9 执行 · 2026-09-17）源表「合规·绿」与引擎结论的一致性 ──────
    #   背景：源表 157 条 `合规·绿` 带着 53.8% 的投放金额，其中 **0 条**是
    #   「已查且通过」—— 55 条无文案、99 条规则够不着、3 条规则其实命中了。
    #   D9 交付的变更请求与逐行还原账都建立在这三条断言上，所以它们必须成门。
    #
    #   ★ V44c 是**棘轮**，不是「必须为 0」。今天的坏值（3 条漏放 / 盲区率 43.1%）
    #     是已登记的现状，不是本门要制造的红色；本门守的是**不许更坏**，
    #     并在变好时提示把棘轮一起收紧。一个要求「今天立刻为 0」的门会在
    #     修好之前一直红，然后所有人学会忽略它 —— 那就是没有门。
    _rl_path = SKEL / "_data" / "风险等级-还原.json"
    _rec_path = SKEL / "_data" / "records.json"

    # V44a：没有可判文本的记录，不能被判成任何一种「放行」
    _recs_raw = json.loads(_rec_path.read_text(encoding="utf-8"))
    _no_text = [r for r in _recs_raw
                if not S.rec_text(r).strip()
                and any((r.get(f) or "").strip()
                        for f in ("广告名称", "外部广告ID", "广告账号", "平台"))]
    _bad_layer = []
    for r in _no_text:
        v = J.judge(S.rec_text(r), product_line=(r.get("品线") or None),
                    ad_type=r.get("广告类型"))
        L = v["verdict"]["layer"]["id"]
        if L != "DP0" or v["verdict"]["disposition"] == "auto_pass_with_note":
            _bad_layer.append(f"{r.get('广告名称') or r.get('外部广告ID')}: {L}")
    # 反向对照 ①：空串与纯空白都必须落 DP0 —— 判据必须对「空」的各种写法一致
    _mut = [J.judge(t)["verdict"]["layer"]["id"] for t in ("", "   ", "\n\t ")]
    # 反向对照 ②：**有**文本但没有命中规则时**不许**落 DP0。没有这一条，
    #   「DP0 由空文本决定」与「DP0 由没有命中决定」在只看正例时长得一模一样 ——
    #   而后者会让所有未覆盖记录被误判成「不可审」，正好是 D9 那个病反过来犯。
    _pos = [J.judge(t)["verdict"]["layer"]["id"]
            for t in ("hello world", "普通文案，没有任何规则词")]
    check("V44a", "没有可判文本的记录一律落 DP0，且**不得**出现任何形式的放行"
                  "（对照：有文本但没命中的**不许**落 DP0）",
          not _bad_layer and set(_mut) == {"DP0"} and "DP0" not in _pos,
          f"{len(_no_text)} 条无文案广告全部 DP0；空串/纯空白/换行 → {sorted(set(_mut))}；"
          f"有文本无命中 → {sorted(set(_pos))}"
          + (f"；❌ {_bad_layer[:3]}" if _bad_layer else ""))

    # V44b：还原账必须新鲜，且两个守恒等式必须闭合
    _rl = json.loads(_rl_path.read_text(encoding="utf-8")) if _rl_path.exists() else None
    _fp_now = hashlib.sha256(_rec_path.read_bytes()).hexdigest()
    _fp_ok = bool(_rl) and _rl.get("source_sha256") == _fp_now
    _t = (_rl or {}).get("totals", {})
    _rows = (_rl or {}).get("rows", [])
    #   ① 可审内容三值必须恰好铺满语料（少一条 = 有记录没被归类，没人会看见）
    _part = _t.get("可审_有文案", 0) + _t.get("可审_无文案", 0) + _t.get("可审_未读到", 0)
    #   ② 绿标三桶必须恰好等于绿标总数（这正是 D9 那个「还原出来了」的等式）
    _buckets = (_t.get("绿标_无文案", 0) + _t.get("绿标_规则未覆盖", 0)
                + _t.get("绿标_规则命中了", 0))
    _cons = (_part == len(_recs_raw) == _t.get("records")
             and _buckets == _t.get("绿标_条数"))
    # 反向对照：把一条记录的 `可审内容` 抹掉，守恒等式**必须**当场断掉。
    #   抽成内联函数是为了让「判据对不对」与「制品对不对」分开报 ——
    #   否则等式恒真也看不出来（这是本项目第 5 次遇到同一个形态）。
    def _partition_ok(rows):
        s_ = {x.get("可审内容") for x in rows}
        return (sum(1 for x in rows if x.get("可审内容") == "有文案")
                + sum(1 for x in rows if x.get("可审内容") == "无文案")
                + sum(1 for x in rows if x.get("可审内容") == "未读到")) == len(rows) \
            and s_ <= {"有文案", "无文案", "未读到"}
    _m_rows = [dict(x) for x in _rows]
    if _m_rows:
        _m_rows[0]["可审内容"] = None            # 抹掉一条
    _m2_rows = [dict(x) for x in _rows]
    if _m2_rows:
        _m2_rows[0]["可审内容"] = "待定"          # 造一个第五种取值
    _ctrl = (bool(_rows) and _partition_ok(_rows)
             and not _partition_ok(_m_rows) and not _partition_ok(_m2_rows))
    check("V44b", "源表绿标的逐行还原账新鲜，且两个守恒等式闭合"
                  "（可审内容铺满语料 · 绿标三桶等于绿标总数）",
          _fp_ok and _cons and bool(_rows) and _ctrl,
          f"指纹{'一致' if _fp_ok else '❌对不上'}；"
          f"可审内容 {_t.get('可审_有文案')}+{_t.get('可审_无文案')}"
          f"+{_t.get('可审_未读到')}={_part} vs {len(_recs_raw)}；"
          f"绿标三桶={_buckets} vs {_t.get('绿标_条数')}；"
          f"反向对照：抹掉一条→守恒断 · 造第五种取值→守恒断 → {'成立' if _ctrl else '❌判据恒真'}",
          )

    # V44c：棘轮 —— 不许更坏；变好时提示收紧
    _RATCHET_HIT, _RATCHET_BLIND = 3, 0.431
    _hit, _blind = _t.get("绿标_规则命中了"), _t.get("盲区率")
    # 反向对照：把两个坏值各推高一格，本门**必须**红 —— 否则棘轮是摆设
    _ratchet_red = ((_hit is None or _hit + 1 > _RATCHET_HIT)
                    and (_blind is None or _blind + 0.001 > _RATCHET_BLIND))
    _relax = []
    if _hit is not None and _hit < _RATCHET_HIT:
        _relax.append(f"引擎命中·源表未命中 {_hit} < {_RATCHET_HIT}")
    if _blind is not None and _blind < _RATCHET_BLIND:
        _relax.append(f"盲区率 {_blind:.1%} < {_RATCHET_BLIND:.1%}")
    check("V44c", f"棘轮：绿标「引擎命中·源表未命中」≤ {_RATCHET_HIT} 且盲区率 ≤ {_RATCHET_BLIND:.1%}"
                  f"（只许变好；变好时必须收紧本门的阈值）",
          (_hit is not None and _hit <= _RATCHET_HIT
           and _blind is not None and _blind <= _RATCHET_BLIND)
          and _ratchet_red,
          f"引擎命中·源表未命中 {_hit}/{_RATCHET_HIT} · 盲区率 {_blind:.1%}/{_RATCHET_BLIND:.1%}"
          + (" · " + (f"★ 已改善：{('；'.join(_relax))} —— 本门转红是**故意的**："
                       f"请把阈值收紧到当前值再提交，否则这条门守的是一个过期的现状"
                       if _relax else
                       f"反向对照：各推高一格 → {'必红' if _ratchet_red else '❌棘轮不咬'}")))


    # ── V45（D15/D16 执行 · 2026-09-17）规则迁移的保真度 ──────────────────
    #   背景：D15 立案时写的是「源表的规则扫描漏放 3 条」——**那是一句错话**。
    #   逐行对账之后真相反过来了：源表那次放行是**对的**，错的是我们自己的迁移。
    #   旧规则 H01 有一条豁免词 `treat yourself`，旧语义是**放行**；迁移把它搬进
    #   语境守卫表并改成**降级** —— 同一个短语，旧系统拿它免责、新系统拿它定罪。
    #
    #   ★ 这一门守的不是「那 3 条」，是**这类错误的形状**：
    #     迁移错了之后，每一条规则单看都自洽，静态检查原理上看不见它。
    #     所以判据必须建在**两份账的对账**上，而不是任何单份制品上。
    #
    #   ★ V45c 同样是棘轮。甲类 14 个词是已登记的现状，本门守「不许更多」。
    _mf_path = SKEL / "_data" / "迁移保真度.json"
    _mf = json.loads(_mf_path.read_text(encoding="utf-8")) if _mf_path.exists() else None
    _mf_missing = _mf is None

    # V45a：语义前提必须成立 + 豁免词去向守恒
    #   ★ 轴 0 是整个结论的地基：如果旧 `exceptions` 的语义不是「放行」，
    #     那么「迁移翻了语义」这句话本身就不成立，后面全部作废。所以它必须自己成门，
    #     而且必须**每跑一次都重新实测**（同批次天然对照），不是抄一句文档。
    _a0 = (_mf or {}).get("轴0_例外语义证据", {})
    _sem_ok = bool(_a0.get("成立")) and bool(_a0.get("对照组"))
    _d = ((_mf or {}).get("轴1_例外漂移", {}) or {}).get("去向分布", {}) or {}
    _live = ((_mf or {}).get("totals", {}) or {}).get("旧豁免词总数")
    _sum_dest = (_d.get("语境守卫", 0) + _d.get("白名单", 0) + _d.get("无归属", 0))
    # 反向对照：抹掉一个去向桶，守恒必须断
    _d2 = dict(_d)
    if _d2:
        _k0 = sorted(_d2)[0]
        _d2[_k0] = max(0, _d2[_k0] - 1)
    _sum_dest2 = (_d2.get("语境守卫", 0) + _d2.get("白名单", 0) + _d2.get("无归属", 0))
    _ctrl_a = bool(_d) and _sum_dest2 != _live
    check("V45a", "迁移的语义前提**每跑一次都实测**（同批次天然对照：含豁免词的绿、"
                  "不含的红），且 94 个旧豁免词的三个去向之和等于总数",
          (not _mf_missing) and _sem_ok and _live is not None
          and _sum_dest == _live and _ctrl_a,
          (f"账不在盘上 ❌（修复：python3 research/governance/audit_migration_fidelity.py）"
           if _mf_missing else
           f"对照 {len(_a0.get('对照组') or [])} 组 · 前提{'成立' if _sem_ok else '❌不成立（结论全部作废）'}"
           f" · 去向 {_d.get('语境守卫', 0)}+{_d.get('白名单', 0)}+{_d.get('无归属', 0)}"
           f"={_sum_dest} vs {_live}"
           f" · 反向对照：减一个去向桶→守恒断 {'成立' if _ctrl_a else '❌判据恒真'}"))

    # V45b：账本新鲜（5 个输入指纹）+ 逐行对账守恒
    _fp = (_mf or {}).get("source_sha256", {}) or {}
    _stale = []
    for _n, _rel in [("records.json", "_data/records.json"),
                     ("rules_raw.json", "_data/rules_raw.json"),
                     ("rules-v1.json", "rules-v1.json"),
                     ("whitelist-v1.json", "whitelist-v1.json"),
                     ("context-guards-v1.json", "context-guards-v1.json")]:
        _p = SKEL / _rel
        if not _p.exists():
            continue
        if _fp.get(_n) != hashlib.sha256(_p.read_bytes()).hexdigest():
            _stale.append(_n)
    _a3 = (_mf or {}).get("轴3_逐行对账", {}) or {}
    _scan_cons = (_a3.get("两次扫描一致", 0) + _a3.get("有分歧", 0)) == _a3.get("记录数")
    _cons_ok = bool(((_mf or {}).get("守恒") or {}).get("逐行_一致加分歧等于总数"))
    # 反向对照：把一致数减一，守恒必须断
    _ctrl_b = (_a3.get("两次扫描一致", 0) - 1 + _a3.get("有分歧", 0)) != _a3.get("记录数")
    check("V45b", "迁移对账账本对 5 个输入都新鲜，且逐行对账守恒"
                  "（两次扫描一致数 + 分歧数 = 记录数）",
          (not _mf_missing) and not _stale and _scan_cons and _cons_ok and _ctrl_b,
          f"指纹{'全部一致' if not _stale else '❌过期：' + ','.join(_stale)}；"
          f"一致 {_a3.get('两次扫描一致')} + 分歧 {_a3.get('有分歧')}"
          f" = {_a3.get('记录数')}；"
          f"反向对照：一致数减一→守恒断 {'成立' if _ctrl_b else '❌判据恒真'}")

    # V45c：实测三桶的守恒 + 棘轮
    #   ★ 这一门原本守的是「甲类「根本不是主张却被降级」≤ 14」——**那个分类已撤回**：
    #     它建立在 `guard_type`（机器推导、自带「待法务确认」标注）之上，
    #     且把源表写明的三层设计压成了两层。取而代之的是**实测**：
    #     把 36 个「自身就会命中本规则」的旧豁免词逐个喂给引擎，看它拿到什么带。
    #     实测不需要相信任何分类字段，只需要相信引擎自己的输出。
    _a1m = ((_mf or {}).get("轴1_例外漂移", {}) or {})
    _n_self = _a1m.get("自我触发词数")
    _n_pass, _n_down = _a1m.get("仍放行_条数"), _a1m.get("变成降级_条数")
    _n_gone = _a1m.get("满档判险_无带_条数")
    # 守恒：三桶之和必须等于自我触发词数（漏一类就断）
    # ★ 2026-09-23 起是**四**桶：Q25 的准入过滤让一部分自我触发词**不再让规则命中**
    #   （既不放过、也不降级、也不是满档判险）—— 见 `audit_migration_fidelity.py` 的 `idle`。
    _n_idle = _a1m.get("准入过滤_不命中_条数")
    _mig_cons = (None not in (_n_self, _n_pass, _n_down, _n_gone, _n_idle)
                 and _n_pass + _n_down + _n_gone + _n_idle == _n_self)
    # 反向对照：把「仍放行」减一，守恒必须断
    _mig_ctrl = (_n_pass is not None
                 and _n_pass - 1 + (_n_down or 0) + (_n_gone or 0) + (_n_idle or 0) != _n_self)
    # 棘轮：满档判险（最重的一桶）与已发生的假阳性都只许减不许增
    #
    # ★ 2026-09-23 收紧一次（Q25 = 选项 A）：迁移回归假阳性 **3 → 0**。
    #   非主张词形遮罩（`treat yourself` 不再因裸 `treat` 命中 T1.1）把那 3 条假阳性消掉了；
    #   同时「变成降级」13 → 12（那个词从守卫表移除，不再有降级可算）。
    #   本门**自己报红要求收紧** —— 这正是它设计的样子：不收紧就等于守着一个过期的现状。
    _N_GONE, _N_FP = 3, 0
    _n_fp = (((_mf or {}).get("totals", {}) or {}).get("分歧_迁移回归_假阳性"))
    _ctrl_c = ((_n_gone is None or _n_gone + 1 > _N_GONE)
               and (_n_fp is None or _n_fp + 1 > _N_FP))
    _relax_mf = []
    if _n_gone is not None and _n_gone < _N_GONE:
        _relax_mf.append(f"满档判险 {_n_gone} < {_N_GONE}")
    if _n_fp is not None and _n_fp < _N_FP:
        _relax_mf.append(f"假阳性 {_n_fp} < {_N_FP}")
    check("V45c", f"实测三桶守恒（仍放行 + 变成降级 + 满档判险 = 自我触发词数），"
                  f"且棘轮：满档判险 ≤ {_N_GONE} 个、迁移回归假阳性 ≤ {_N_FP} 条",
          _mig_cons and _mig_ctrl
          and (_n_gone is not None and _n_gone <= _N_GONE)
          and (_n_fp is not None and _n_fp <= _N_FP) and _ctrl_c,
          f"实测 {_n_pass} 放行 + {_n_down} 降级 + {_n_gone} 满档判险 + {_n_idle} 准入过滤 = "
          f"{(_n_pass or 0) + (_n_down or 0) + (_n_gone or 0) + (_n_idle or 0)} vs 自我触发 {_n_self}"
          f" · 假阳性 {_n_fp}/{_N_FP} · "
          + (f"★ 已改善：{('；'.join(_relax_mf))} —— 本门转红是**故意的**："
             f"请把阈值收紧到当前值再提交，否则这条门守的是一个过期的现状"
             if _relax_mf else
             f"反向对照：减一个放行→守恒断 {'成立' if _mig_ctrl else '❌判据恒真'} · "
             f"各推高一格 → {'必红' if _ctrl_c else '❌棘轮不咬'}")
          + "　（仍放行只有 2 个词，说明旧语义整体消失了；这两个是 D3 法务定案的成果）")


    # ── V45d · 2026-09-17：未接线的词必须指向一个**可决策的**未决项 ──────────
    #   起因（本次查出的真正根因）：39 个未接线守卫词在表里挂着
    #   `status_note="待法务定性"`，而 `$decision_queue` 里 22 项**全部 answered、
    #   0 项 open** —— 也就是说「待法务定性」这件事**从来没有被写进唯一该写的位置**（D12）。
    #   更坏的是 ADR-0009 §八 把它读成「未接线期间它们的降级效果与现网一致（即：不生效）」，
    #   而旧 `豁免词` 的语义是**放行**（V45a 每次实测）。于是 39 个词被遗忘，
    #   而遗忘的形态是一句读起来像结论的话。
    #
    #   ★ 本门与 V43a 同形：空缺本身允许存在，但**空缺必须指向一个可决策的未决项**。
    #     不指向 = 遗忘（红）；指向 = 待决（绿）。两者在制品上看不出差别，只有查得出。
    _gdoc = json.loads((SKEL / "context-guards-v1.json").read_text(encoding="utf-8"))
    _unwired = sorted(x["word"] for x in _gdoc["words"] if not x.get("wired"))
    _ldoc = json.loads((SKEL / "legal-decisions-v1.json").read_text(encoding="utf-8"))
    _qitems = _ldoc.get("$decision_queue") or []
    _qby = {q["id"]: q for q in _qitems}
    _dec_ids = {x["id"] for x in _ldoc.get("decisions", [])}

    # 判据抽成函数 —— 反向对照必须打在同一判据上，否则对照证明的是另一个东西
    def _unwired_problems(words: list, items: list) -> list:
        bad = []
        for w in words:
            cov = [q for q in items if w in (q.get("covers_unwired_guards") or [])]
            if len(cov) > 1:
                bad.append(f"{w}: 被 {len(cov)} 条未决项同时认领（定位不唯一）")
                continue
            if cov and cov[0].get("status") == "open":
                continue
            # 另一种合法形态：决定已经答了，直接写在词条里（不必再挂未决项）
            row = next((x for x in _gdoc["words"] if x["word"] == w), {})
            blob = f"{row.get('wire_gap') or ''} {row.get('status_note') or ''}"
            cited = ({f"Q{n}" for n in re.findall(r"\bQ(\d+)\b", blob)} & set(_qby)) \
                | ({f"D{n}" for n in re.findall(r"\bD(\d+)\b", blob)} & _dec_ids)
            if any((_qby[i].get("status") == "answered") if i in _qby else True
                   for i in cited):
                continue
            bad.append(f"{w}: 既没有被任何 open 的未决项认领，词条里也没点名一条已答的 "
                       f"Q/D —— 这不是「待决」，是「遗忘」")
        return bad

    _uprob = _unwired_problems(_unwired, _qitems)
    # 守恒：认领并集必须**恰好**等于未接线集合（缺口与多余都算断）
    _claimed = [w for q in _qitems for w in (q.get("covers_unwired_guards") or [])]
    _gap = [w for w in _unwired if w not in set(_claimed)]
    _stale = [w for w in _claimed if w not in set(_unwired)]
    # 反向对照：真正抽掉一条认领，判据必须变红，否则本条是恒真
    _mut = copy.deepcopy(_qitems)
    for _q in _mut:
        if _q.get("covers_unwired_guards"):
            _q["covers_unwired_guards"] = _q["covers_unwired_guards"][1:]
            break
    _mut_claimed = {y for q in _mut for y in (q.get("covers_unwired_guards") or [])}
    _ctrl_u = bool(_unwired_problems(_unwired, _mut)) or any(
        w for w in _unwired if w not in _mut_claimed)
    _N_UNWIRED = 2
    _relax_u = (f"未接线 {len(_unwired)} < {_N_UNWIRED}" if len(_unwired) < _N_UNWIRED else "")
    check("V45d", f"每个未接线的守卫词都指向一条**可决策的**未决项（被 ≥1 条 open 认领，"
                  f"或词条点名一条已答的 Q/D）；认领并集恰好等于未接线集合；未接线 ≤ {_N_UNWIRED}",
          not _uprob and not _gap and not _stale and _ctrl_u
          and len(_unwired) <= _N_UNWIRED,
          f"未接线 {len(_unwired)} 个 · open 未决项 "
          f"{sum(1 for q in _qitems if q.get('status') == 'open')} 条 · "
          f"认领 {len(_claimed)} 个（缺口 {len(_gap)} / 多余 {len(_stale)}）· "
          + ("；".join(_uprob[:2]) if _uprob else "逐词可决策")
          + ("　★ 已改善：" + _relax_u + " —— 本门转红是故意的：请把阈值收紧到当前值再提交"
             if _relax_u else "")
          + f"　反向对照：抽掉一条认领 → {'必红' if _ctrl_u else '❌判据恒真'}")


    # ══ V46 · 2026-09-17（D38 · Q36 裁定 A）编号空间收口 ══════════════════
    #   本仓的编号不是一个平面。Q35（→D37）处置了 KB 线自有编号，Q36（→D38）处置了
    #   ADR-0013 的局部决策编号。两次都撞上同一件事：**改的是编号，坏的是围着编号写的假设。**
    #
    #   这一组守的不是「改成了什么样」，是**「还有哪些号是别人的」必须逐条写下来**。
    #   Q36 选项 A 声明的收益是「裸写的 `D#` 只可能是台账」—— 实测**达不到**：改完之后
    #   ADR-0013 里仍有 20 处裸 `D#`（台账引用 + 旧缺口号 + 旧检查编号引文），它们不该改。
    #   所以到货形态只能是一句带白名单的话，而白名单必须在判据里，不能留在迁移脚本的注释里。
    #   **恒真的全称句会被下一个人当成真的用。**
    if not a.only or a.only.startswith("V46"):
        import importlib.util as _ilu

        _spec = _ilu.spec_from_file_location(
            "_mb12", str(ROOT / "tools" / "_migrate_ids_batch12.py"))
        _mb12 = _ilu.module_from_spec(_spec)
        _spec.loader.exec_module(_mb12)

        # ★ 白名单是 `(token, near, 理由)` 的列表，**按内容锚定**，不是按行号。
        #   第一版是 `{行号: {token: 理由}}`，落地当天就因为往 §五 的注里插了 3 行而
        #   整体错位、2 条当场失效。判据当时**报了出来** —— 那正是它该有的样子。
        _wl = _mb12.WHITELIST
        _adr13_lines = (ROOT / "ADR" / "ADR-0013-基座接口冻结与仓库入库分级.md") \
            .read_text(encoding="utf-8").split("\n")

        def _hit(tok, line, wl):
            return any(w[0] == tok and w[1] in line for w in wl)

        def _stray(wl):
            """白名单之外还剩下的裸 `D#`。抽出来是为了反向对照能对同一判据做。"""
            return [f"行{i} {m.group(0)}" for i, l in enumerate(_adr13_lines, 1)
                    for m in _mb12.BARE.finditer(l) if not _hit(m.group(0), l, wl)]

        _bare = [(i, m.group(0)) for i, l in enumerate(_adr13_lines, 1)
                 for m in _mb12.BARE.finditer(l)]
        _stray_now = _stray(_wl)
        _unused = [f"{t} @ {nr[:24]!r}" for t, nr, _ in _wl
                   if not any(_hit(t, l, [(t, nr, "")]) for l in _adr13_lines)]
        # 反向对照：**从白名单里抽掉一条**，那一处裸 `D#` 必须当场变成「没理由的」。
        _victim = _wl[0] if _wl else None
        _stray_mut = _stray(_wl[1:]) if _victim else []
        check("V46a", "ADR-0013 里裸写的 `D#` 逐条落在白名单里，且白名单无未命中项"
                      "（每条按内容锚定、写明它凭什么例外）",
              not _stray_now and not _unused and len(_stray_mut) > len(_stray_now),
              f"裸 `D#` {len(_bare)} 处 · 白名单 {len(_wl)} 条（按内容锚） · "
              + ("全部有理由" if not _stray_now else "；".join(_stray_now[:3]))
              + (f"；❌ 白名单未被命中 {_unused[:2]}" if _unused else "")
              + f"　反向对照：抽掉 {_victim[0]} → "
              + (f"报出 {_stray_mut[:1]}" if len(_stray_mut) > len(_stray_now) else "❌判据恒真"))

        # ── V46b · 别名唯一（D34 的「单一编号空间」能不能成立，全看这一条）──
        #   ★ 这里**自己加载**台账，不沿用 V30 组里那个 `_led`。
        #     第一版写的是 `locals().get("_led") or json.loads(...)` —— 结果 V30 到 V46 之间
        #     有别的组把 `_led` 重新绑成了 `Path`（存的是路径，不是文档），于是 `--only V46`
        #     单跑没问题、**全量跑直接 AttributeError 崩掉**。
        #     这正是本项目反复撞见的那一类：**围着名字写的假设**。修法不是改个名，
        #     是让这一段不依赖任何环境状态 —— 自己读自己那份。
        _led = json.loads((SKEL / "legal-decisions-v1.json").read_text(encoding="utf-8"))
        _ia = _led.get("$id_aliases") or {}
        _ent = _ia.get("entries") or []
        _seen, _dup = {}, []
        for _e in _ent:
            for _al in _e.get("aliases") or []:
                if _al in _seen:
                    _dup.append(f"{_al} 同时指 {_seen[_al]} 与 {_e['id']}")
                _seen[_al] = _e["id"]
        _conf = [e["id"] for e in _ent if e.get("status_conflict")]
        # ★ 撞号的号必须带表域限定 —— 一个不带 `@` 的撞号别名就是「别名不唯一」的种子。
        #   撞号集合取自对账产物：它是**算出来的**，不是这里抄一份（抄一份就会漂）。
        # ── 撞号集合**现算**，不从盘上的产物读 ──────────────────────────
        #   ★ 这条是踩出来的：D38 往 10 个撞号行的行尾追加了 `<!-- … -->` 注释，
        #     而对账解析器的行正则要求以 `|` 结尾 —— 那 10 行因此整个消失（52→42 行），
        #     撞号集合变成空。**而 V46b 当时是绿的**，因为它读的是迁移**之前**落盘的
        #     `_data/遗留对账.json`。判据吃了一份过期快照，于是它守的东西已经不存在了，
        #     它还在报平安。这与 D37 的三条自撞同形，解法 E5 早就写过：**守「制品本身没过期」**。
        #     这里更进一步：判据用**现算**，产物只作人读的那一份（另由 V46e 守新鲜度）。
        import importlib.util as _ilu2
        _rspec = _ilu2.spec_from_file_location("_recon_legacy",
                                               str(ROOT / "tools" / "_recon_legacy.py"))
        _recon_mod = _ilu2.module_from_spec(_rspec)
        _rspec.loader.exec_module(_recon_mod)
        _live = _recon_mod.recon()
        _coll = set(_live["collide_numbers"])
        _recon_why = ""
        if not _coll:
            _recon_why = ("❌ 现算的撞号集合是空的 —— ADR 里 `遗留 6–10` 的撞号要么被修好了，"
                          "要么解析器又读不到那些行了（后者更可能）。")
        _unscoped = [a for e in _ent for a in (e.get("aliases") or [])
                     if "@" not in a
                     and (a.split()[1].split("@")[0].isdigit()
                          and int(a.split()[1].split("@")[0]) in _coll)]
        # ── 别名必须指向**还存在的号**（悬空引用那一类）────────────────
        #   ★ 登记处是一份**制品**；ADR 是另一份。两者会各自演化 ——
        #     删掉 ADR 里某一行、或改掉某个号，登记处就多出一个指不到东西的别名。
        #     这正是 Q35 evidence ⑦ 那条已经断掉的引用（`kb_query.py` 的抬头写着
        #     「会被 verify_kb.py 的 D4 抓住」，而那条检查现名 E4）的同一形态：
        #     **编号空间一动、引用就断，而且没有任何检查发现它。**
        #   别名的算法只有一份（`_ingest_batch12.alias_of`），判据直接调它。
        _bspec = _ilu2.spec_from_file_location(
            "_ingest_batch12", str(ROOT / "tools" / "_ingest_batch12.py"))
        _ing = _ilu2.module_from_spec(_bspec)
        _bspec.loader.exec_module(_ing)
        _live_alias = {a for it in _live["items"] for a in _ing.alias_of(it, _coll)}
        _reg_alias = {a for e in _ent for a in (e.get("aliases") or [])}
        _dangling = sorted(_reg_alias - _live_alias)      # 登记了，ADR 里没有
        _unreg = sorted(_live_alias - _reg_alias)         # ADR 里有，没登记

        check("V46b", "单一编号空间：别名唯一 · 撞号带域限定 · 且每个别名都指得到 ADR 里现存的号",
              not _dup and not _unscoped and not _dangling and not _unreg
              and _ia.get("spaces") and not _recon_why,
              (_recon_why or
               f"{len(_ia.get('spaces') or {})} 个编号空间 · {len(_ent)} 件 ADR 遗留 · "
               f"别名 {len(_seen)} 个 · 撞号 {sorted(_coll)}（现算） · 状态冲突 {_conf or '无'}"
               + ("" if not (_dup or _unscoped) else "；" + "；".join(
                   (_dup + [f"未加域：{_unscoped[:3]}"])[:3]))
               + (f"；❌ 悬空别名 {_dangling[:3]}" if _dangling else "")
               + (f"；❌ 未登记 {_unreg[:3]}" if _unreg else "")))

        # ── V46e · 对账产物必须新鲜**且结构完整**（它是人读的那一份；判据本身已改成现算）──
        #   ★ 「指纹一致」只管「源变没变」，管不了「产物本身被改坏」。
        #     实测：把产物里的 `collide_numbers` 键改个名，指纹照样对得上 ——
        #     而那份产物已经不能回答它该回答的问题了。**空缺必须可见。**
        _recon_art = SKEL / "_data" / "遗留对账.json"
        _need = ["collide_numbers", "items", "rows", "unique_items",
                 "collide", "status_conflicts", "source_sha256"]
        _missing_keys = []
        if _recon_art.exists():
            _art = json.loads(_recon_art.read_text(encoding="utf-8"))
            _missing_keys = [k for k in _need if k not in _art]
        _struct_ok = not _missing_keys
        _fresh_ok, _fresh_why = _recon_mod.is_fresh(str(_recon_art))
        check("V46e", "`_data/遗留对账.json` 与其源 ADR 同代**且结构完整**（不是过期快照、不是被改坏的产物）",
              _fresh_ok and _struct_ok,
              (f"{_fresh_why} · 现算 {_live['rows']} 行 / {_live['unique_items']} 件 · "
               f"产物记 {len(_ia.get('entries') or [])} 件")
              + (f"；❌ 对账产物结构不全，缺 {_missing_keys}" if _missing_keys else ""))

        # ── V46c · 批次标签双向对账（台账 `$artifact` ↔ 讨论稿 §八 的表）──
        #   实测：这两处**早就对不上了** —— `D31` 写 B4/B6、表里是 B7；`D35` 写 B7、表里是 B6。
        #   而「下一批做什么」这个问题正是靠这两处回答的。两处不一致 = 这个问题有两个答案。
        _plan = (ROOT / "PMO" / "守衡-创建全景图与知识库体系-讨论稿-v1.md") \
            .read_text(encoding="utf-8")
        _q2d = {q["id"]: (q.get("record") or "").split("· ")[-1]
                for q in _led.get("$decision_queue", []) if q.get("status") == "answered"}
        _plan_of = {}          # 决定 → 表里它落在哪个批次
        for _ln in _plan.split("\n"):
            _m = re.match(r"^\|\s*\*\*(B\d+'?)\*\*", _ln)
            if not _m:
                continue
            for _q in re.findall(r"\bQ(\d+)\b", _ln):
                _d = _q2d.get(f"Q{_q}")
                if _d:
                    _plan_of.setdefault(_d, set()).add(_m.group(1))
        _mism, _orphan = [], []
        # ★ 表只覆盖 B4–B10（B0–B3 已落地，没有行）。所以「台账标了 B3」不是漂移，
        #   是**已经做完的批次**。第一版没有这条豁免，于是 D28 的 `B3.2` 被当成孤儿报了出来 ——
        #   那不是判据抓到了错，是判据不知道表有下界。**一条会把正常状态报成错的判据，
        #   会被学会忽略，和恒真一样坏**（同 §16.5 那条 F3 的豁免理由）。
        _tbl_min = min(int(b[1:].rstrip("'")) for b in
                       {m.group(1) for ln in _plan.split("\n")
                        for m in [re.match(r"^\|\s*\*\*(B\d+'?)\*\*", ln)] if m})
        for _d in _led.get("decisions", []):
            _art = _d.get("$artifact") or ""
            _lab = set(re.findall(r"\bB\d+'?", _art))
            _want = _plan_of.get(_d["id"])
            if _lab and _want and not (_lab & _want):
                _mism.append(f"{_d['id']}: 台账 {sorted(_lab)} vs 表 {sorted(_want)}")
            if _lab and not _want and any(int(x[1:].rstrip("'")) >= _tbl_min for x in _lab):
                _orphan.append(f"{_d['id']} 标了 {sorted(_lab)}，但表里没有任何批次认领它")
        _plan_orphan = [f"{d} 表里排在 {sorted(b)}，台账却没标批次"
                        for d, b in _plan_of.items() if d not in
                        {x["id"] for x in _led.get("decisions", []) if
                         re.search(r"\bB\d+'?", x.get("$artifact") or "")}]
        check("V46c", "批次标签双向对账：台账 `$artifact` 的 `B#` 与讨论稿 §八 的表逐条互相点名",
              not _mism and not _orphan and not _plan_orphan,
              f"表里认领了 {len(_plan_of)} 条决定 · "
              + ("逐条对上" if not (_mism or _orphan or _plan_orphan)
                 else "；".join((_mism + _orphan + _plan_orphan)[:3])))

        # 反向对照：从表里删掉 B6 那一行的 Q 引用，`D35` 必须当场变成「无人认领」
        _plan_mut = re.sub(r"^\|\s*\*\*B6\*\*.*$", "", _plan, count=1, flags=re.M)
        _plan_of_mut = {}
        for _ln in _plan_mut.split("\n"):
            _m = re.match(r"^\|\s*\*\*(B\d+'?)\*\*", _ln)
            if not _m:
                continue
            for _q in re.findall(r"\bQ(\d+)\b", _ln):
                _d = _q2d.get(f"Q{_q}")
                if _d:
                    _plan_of_mut.setdefault(_d, set()).add(_m.group(1))
        _caught = [d["id"] for d in _led.get("decisions", [])
                   if re.search(r"\bB\d+'?", d.get("$artifact") or "")
                   and d["id"] not in _plan_of_mut]
        check("V46d", "反向对照：从表里删掉一个批次行，V46c 的判据必须报出「无人认领」",
              "D35" in _caught, f"删掉 B6 行后无人认领：{_caught or '❌没抓住'}")

    # ── V47（T19 · C2 移植）证据来源分级：非「原文照读」不许单独把结论推到 PASS ──
    #
    #   这一步是 T19 从「写在文档里的规矩」变成「会红的断言」的那一跳。
    #   ★ 为什么它必须长在**引擎契约**里、而不是只长在 `verify_kb.py`：
    #     收窄发生在 `judge()` 内部（`disposition` 已算出、`layer` 还没解析的那一步），
    #     所以它的对象是**一次真实判定**。在 KB 侧只能验「形状对不对」，
    #     验不了「结论真的被压下来了没有」。
    #
    #   ★ 今天这条检查的**正例方向不会触发**（文字输入一律 stated），
    #     但它不是恒真：`described` 那一路是端到端跑出来的真判定，会真的变红。
    if not a.only or a.only.startswith("V47"):
        import evidence_origin as _EO

        _pass_text = CASES["pass_band"]        # V22c 已证：这条裸判是 auto_pass
        _r_stated = J.judge(_pass_text, product_line="吸奶器", locale="en")
        _r_desc = J.judge(_pass_text, product_line="吸奶器", locale="en",
                          evidence_origin="described")
        _r_ocr = J.judge(_pass_text, product_line="吸奶器", locale="en",
                         evidence_origin="ocr")

        check("V47a", "判定输入自带证据来源，且只在那四档内（与回执来源 `origin` 不是一回事）",
              (_r_stated["input"].get("evidence_origin") in _EO.ORIGINS
               and _r_stated["input"].get("evidence_origin") != _r_stated["input"].get("origin")),
              f"input.evidence_origin={_r_stated['input'].get('evidence_origin')!r} · "
              f"四档 {list(_EO.ORIGINS)} · 与回执来源取值域交集 "
              f"{sorted(set(_EO.ORIGINS) & set(_EO.RECEIPT_ORIGINS)) or '空'}")

        # 正例：原文照读时必须照旧放行 —— 少了它，这条判据写成 `return manual_review` 也会绿。
        check("V47b", "正例：原文照读的正常路径**照旧放行**（收窄不许误伤既有判定）",
              _r_stated["verdict"]["disposition"] == "auto_pass",
              f"{_pass_text[:28]!r} → {_r_stated['verdict']['disposition']}")

        # ★ 判据 ② 的端到端形态：同一句话，只是读到它的方式不同。
        check("V47c", f"★ 同一条文案，证据来源换成非 stated → 结论从 auto_pass 落到 manual_review"
                      f"（{len(_EO.ORIGINS) - len(_EO.PASS_ORIGINS)} 档各自点名）",
              _r_desc["verdict"]["disposition"] == "manual_review"
              and _r_ocr["verdict"]["disposition"] == "manual_review",
              f"stated → {_r_stated['verdict']['disposition']} · "
              f"ocr → {_r_ocr['verdict']['disposition']} · "
              f"described → {_r_desc['verdict']['disposition']} · "
              f"收窄记录 {(_r_desc['verdict'].get('origin_narrowed') or {}).get('from')}"
              f"→{( _r_desc['verdict'].get('origin_narrowed') or {}).get('why', '')[:44]}…")

        # 收窄之后，下游全都要跟着走对：处置层、建议、边界声明三处都得是「人看」那一档。
        _lay = _r_desc["verdict"]["layer"]
        check("V47d", "收窄之后处置层/建议/边界声明三处同步落到「需要人看」"
                      "（只改一个 disposition 字段会留下自相矛盾的回执）",
              _lay.get("machine_may_finalize") is False
              and all("证据来源收窄" in str(u) for u in
                      _r_desc["boundary_statement"].get("unknowns") or []
                      if "证据来源收窄" in str(u))
              and any("证据来源收窄" in str(u)
                      for u in _r_desc["boundary_statement"].get("unknowns") or []),
              f"layer={_lay.get('id')} machine_may_finalize={_lay.get('machine_may_finalize')} · "
              f"unknowns 含收窄说明 "
              f"{any('证据来源收窄' in str(u) for u in _r_desc['boundary_statement'].get('unknowns') or [])}")

        # ★★ 两个 origin 不许混 —— 落这一步时**当场撞到**的名字冲突。
        #     `judge()` 里原本已有一个 `origin`，含义是**回执来源**（cli/batch/shouheng/test），
        #     它是 `push_receipts.py` 那道「测试不许进生产账本」闸门的依据。
        #     证据来源若也叫 `origin`，把 `origin="stated"` 写进回执顶层，
        #     那道闸门会照常放行，而**没有任何东西会红**。
        with tempfile.TemporaryDirectory() as _t47:
            _rc47 = J.judge(_pass_text, product_line="吸奶器", locale="en",
                            receipt=True, receipt_path=Path(_t47) / "r.jsonl",
                            issued_at="2026-09-23T00:00:00+00:00",
                            origin="test")["receipt"]
        _mix_now = _EO.receipt_origin_problems(_rc47)
        _mix_a = _EO.receipt_origin_problems({"origin": "stated", "evidence_origin": "described"})
        _mix_b = _EO.receipt_origin_problems({"origin": "cli", "evidence_origin": "test"})
        check("V47e", "★★ 两个 origin 不许混：回执来源与证据来源取值域互斥，两个方向都拦",
              not _mix_now and _mix_a and _mix_b
              and _rc47.get("origin") in _EO.RECEIPT_ORIGINS
              and _rc47.get("evidence_origin") in _EO.ORIGINS,
              f"真回执 origin={_rc47.get('origin')!r} · evidence_origin="
              f"{_rc47.get('evidence_origin')!r} · 取值域交集 "
              f"{sorted(set(_EO.ORIGINS) & set(_EO.RECEIPT_ORIGINS)) or '空'}；"
              f"反向对照：把 stated 写进回执 origin → {'报红' if _mix_a else '❌没报红'}；"
              f"把 test 写进证据来源 → {'报红' if _mix_b else '❌没报红'}")

    # ── V48（T4）回执 → 条款 → 原文：这一跳的**产出点唯一在 judge() 内部** ──
    #
    #   ★ 为什么长在引擎契约里：T4 的判据是「任一判定回执能反查到条款」——
    #     它的对象是**一份真回执**，而在 KB 侧（`verify_kb.py` 的 T4a–T4d）
    #     验的是「块的结构与解引用对不对」。两侧各验一半，与 T19 的 V47/T19 同一种切法。
    #
    #   ★ 判据原文点名的那条反向对照（**塞一条不存在的条目 ID 必须红**）在
    #     `T4a` 里，这里放的是它验不到的那一半：这个块**只能由 judge() 产出**
    #     （做成入参的话，四个调用方里只要有一个不传，那条回执就永远点不开依据）。
    #   ★ 这一段同时装着 V47f 与 V48a–d（两者共用同一份条款库与同一个 `_CR`）——
    #     所以 `--only` 必须两条前缀都认，否则 `--only V47` 会**安静地跳过 V47f**，
    #     而输出照样写「全绿」（一个把检查关掉却看不出来的开关，比没有开关更糟）。
    if not a.only or a.only.startswith(("V47", "V48")):
        import clause_ref as _CR

        _lib_doc, _lib_idx, _lib_prob = _CR.load_library()
        _rules48 = json.loads((SKEL / "rules-v1.json").read_text(encoding="utf-8"))["rules"]
        with tempfile.TemporaryDirectory() as _t48:
            _r48 = J.judge(CASES["reject"], product_line="吸奶器", receipt=True,
                           receipt_path=Path(_t48) / "r.jsonl", origin="test",
                           issued_at="2026-09-23T00:00:00+00:00")
        _rc48 = _r48["receipt"]
        _p48 = _CR.receipt_evidence_problems(_rc48, _lib_idx, rules=_rules48)
        check("V48a", "★ 回执 → 条款：真回执逐条解引用得上，且引用带全（与命中规则一致）",
              (not _p48) and _rc48.get("evidence_status") == "ok"
              and len(_rc48.get("evidence_ref") or []) > 0
              and _rc48.get("rule_keys_hit") == sorted({h["rule_key"] for h in _r48["hits"]}),
              f"{_rc48['run_id']}：命中 {_rc48.get('rule_keys_hit')} → "
              f"{len(_rc48.get('evidence_ref') or [])} 条引用、问题 {len(_p48)} 条 · "
              f"evidence_status={_rc48.get('evidence_status')!r}"
              + ("" if not _p48 else f" ❌ {_p48[:2]}"))

        # ★ 反向对照（判据原文点名的那一条）：条目 ID 改成不存在的 → 必须红。
        _fake48 = json.loads(json.dumps(_rc48, ensure_ascii=False))
        _fake48["evidence_ref"][0]["条目ID"] = "EXT-999"
        _c48 = _CR.receipt_evidence_problems(_fake48, _lib_idx, rules=_rules48)
        check("V48b", "反向对照：回执里塞一条不存在的条目 ID 必须红（凭空关联）",
              len(_c48) > 0 and any("不存在" in m for _, m in _c48),
              f"EXT-999 → {_c48[:1]}")

        # ★ 读不到条款库 ≠ 没有依据：那种情况必须落「未测」，不许留一个空数组。
        #   （`AGENTS.md` §2.2 第 7 条：靠外部文件取的读数，取不到时不许空着，也不许当 0。）
        _blk_na = _CR.evidence_block(["T1.1.medical-cure"], _rules48, None,
                                     library_problem="（自证注入）条款库读不出来")
        _ok_na = _CR.evidence_block_problems(_blk_na, _lib_idx, rule_keys=["T1.1.medical-cure"],
                                             rules=_rules48)
        _bad_na = _CR.evidence_block_problems(
            {**_blk_na, "evidence_unavailable_reason": None}, _lib_idx,
            rule_keys=["T1.1.medical-cure"], rules=_rules48)
        check("V48c", "条款库读不到 → `evidence_status=unavailable` + 理由（不是空数组），"
                      "且不许与引用并存",
              _blk_na["evidence_status"] == "unavailable"
              and _blk_na["evidence_ref"] == [] and (not _ok_na) and len(_bad_na) > 0
              and _CR.evidence_block_problems(
                  {**_blk_na, "evidence_ref": _rc48["evidence_ref"]}, _lib_idx) != [],
              f"注入后 status={_blk_na['evidence_status']!r} · 引用 "
              f"{len(_blk_na['evidence_ref'])} 条 · 判据 {len(_ok_na)} 问题；"
              f"反向对照：抹掉理由 → {'✅报红' if _bad_na else '❌没报红'}")

        # ★ 这个制品只在写回执时产生 —— 不写回执的判定（291 条语料那条路径）一字不动。
        _no48 = J.judge(CASES["reject"], product_line="吸奶器")
        check("V48d", "证据块只在 `receipt=True` 时产出（不写回执的判定路径一字不动）",
              "evidence_ref" not in _no48 and "ratified" not in _no48
              and _no48["verdict"]["disposition"] == _r48["verdict"]["disposition"],
              f"无回执时顶层键含 evidence_ref？{'evidence_ref' in _no48} · "
              f"两次 disposition 均 {_no48['verdict']['disposition']}")

        # ★★ V47f（T4 接线）：收窄的**第二扇门** —— 所引条款的来源。
        #    端到端做法：把条款库**临时换成一份只改了 `origin` 的副本**
        #    （`origin` 不进变更指纹，所以别的字段一个字都不用动），
        #    再跑一次同一条判定。今天 62 条全是 `stated`，所以这一路**平时不会触发**
        #    —— 但它不是恒真：下面这条就是真的走通了「条款来源 → 收窄」那一跳。
        _orig_ext = _CR.EXT_PATH
        try:
            import tempfile as _tf47
            _lib47 = json.loads(json.dumps(_lib_doc, ensure_ascii=False))
            for _e in _lib47.get("entries") or []:
                _e["origin"] = "ocr"
            _p47 = Path(_tf47.mkdtemp()) / "lib-ocr.json"
            _p47.write_text(json.dumps(_lib47, ensure_ascii=False, indent=1), encoding="utf-8")
            _CR.EXT_PATH = _p47
            _r_ocr_clause = J.judge(_pass_text, product_line="吸奶器", locale="en")
            _r_both = J.judge(_pass_text, product_line="吸奶器", locale="en",
                              evidence_origin="ocr")
        finally:
            _CR.EXT_PATH = _orig_ext
        _r_restored = J.judge(_pass_text, product_line="吸奶器", locale="en")
        _nar = _r_ocr_clause["verdict"].get("origin_narrowed") or {}
        # 反向对照：两扇门各自点名 —— 材料 ocr 那一次必须记 gate=material，
        # 条款 ocr 这一次必须记 gate=cited_clauses，两样都 ocr 记 both。
        # 合成一扇门的话这三者会长得一样（而且第一组会被判成放行）。
        check("V47f", "★ T4 接线：所引条款的来源也参与收窄（**并列的第二扇门**，不与材料来源合并）",
              _r_ocr_clause["verdict"]["disposition"] == "manual_review"
              and _nar.get("gate") == "cited_clauses"
              and _nar.get("cited_origins") == ["ocr"]
              and (_r_desc["verdict"].get("origin_narrowed") or {}).get("gate") == "material"
              and ((_r_both["verdict"].get("origin_narrowed") or {}).get("gate")) == "both"
              and _r_restored["verdict"]["disposition"] == _r_stated["verdict"]["disposition"],
              f"条款库临时改成 origin=ocr → {_r_ocr_clause['verdict']['disposition']}"
              f"（gate={_nar.get('gate')!r}、条款来源 {_nar.get('cited_origins')}）· "
              f"材料 ocr 那次 gate={(_r_desc['verdict'].get('origin_narrowed') or {}).get('gate')!r} · "
              f"两样都 ocr → {_r_both['verdict']['disposition']}"
              f"（gate={(_r_both['verdict'].get('origin_narrowed') or {}).get('gate')!r}）· "
              f"库换回原文 → {_r_restored['verdict']['disposition']}"
              + "　★ 合并成一扇门会**放松**今天的口径："
                "「材料 OCR + 条款 stated」会被判成放行，而那正是门一要挡的那一组")

    # ── V49 自证不许有副作用（§2.4.4 的执行点）──────────────────────────
    #   快照在 main() 一开始就拍了（跑任何检查之前）。这里逐字节比回去。
    if not a.only:
        _now = None
        try:
            _now = (SKEL / "_data" / "receipts.jsonl").read_bytes()
        except OSError as _e:                                 # noqa: BLE001
            _now = f"<读不出：{_e}>".encode()
        _rolled = _now != _LEDGER_SNAP
        check("V49", "★ 跑完这一整套自证，生产回执账本**一字节未变**（自证不许有副作用）",
              not _rolled,
              ("生产账本逐字节一致 —— 每一处 `judge(receipt=True)` 都写在自己的临时路径上"
               if not _rolled else
               f"❌ 账本被自证改动了：{len(_LEDGER_SNAP)}B → {len(_now)}B —— "
               f"有检查把回执写进了生产账本（`receipts.LOSS.md` 记的就是这个形状）"))
        # ★ 反向对照：**只差一个空行**时，V49 必须红 —— 而「去掉首尾空白再比」的写法
        #   会把它放过。这一条同时证明 V49 比的是**字节**，不是规范化之后的文本
        #   （`AGENTS.md` §2.1.1：判据要比内容，不能比一个看着像读过的近似量）。
        _onebyte = _LEDGER_SNAP + b"\n"
        _ctrl49 = (_onebyte != _now) and (_onebyte.strip() == _now.strip())
        check("V49c", "反向对照：账本只多一个空行，V49 就会红（它比的是字节，不是 strip 过的文本）",
              _ctrl49,
              f"多一个空行：字节不等 {'✅' if _onebyte != _now else '❌'} · "
              f"而 strip 之后相等 {'✅（所以 strip 式写法会漏掉它）' if _onebyte.strip() == _now.strip() else '❌'}")

    # ── V50–V53（Q43）旧回执的可追溯性：键的不对称 + 那句话的执行点 ──────
    #   起因两件，且是**同一个形状的两半**：
    #   ① `archive_previous()` 按 (engine_version, code_version) **成对**判、成对写，
    #      而 `resolve_version()` 曾**只按 engine_version 单键**反查、正序取第一条命中 ——
    #      历史里并存两条同 ev 记录时（本机实测已有两次）会取到**旧的那条**，
    #      `code_version` 悄悄是错的，而返回的东西看起来完全正常。
    #   ② `--check` 失败时那段提示**对使用者承诺**「重新固化不会让旧回执失效：
    #      resolve_version() 可按 engine_version 反查历史」—— 而那个函数**全仓零调用点**：
    #      一句对外说过的话，没有任何东西在跑它（AGENTS.md §2.4.2）。
    if not a.only or a.only.startswith("V5"):
        _T50 = Path(tempfile.mkdtemp())
        _hist = _T50 / "history.jsonl"
        _man = _T50 / "manifest.json"
        # 合成账本：**两条同 ev 不同 cv** —— 就是本机真实踩到的那个形状
        _hist.write_text("\n".join(json.dumps(r) for r in [
            {"engine_version": "ev1111", "code_version": "cvOLD"},
            {"engine_version": "ev1111", "code_version": "cvNEW"},
        ]) + "\n", encoding="utf-8")
        _man.write_text(json.dumps({"engine_version": "ev2222", "code_version": "cvCUR"}),
                        encoding="utf-8")

        _old = EM.resolve_version("ev1111", "cvOLD", manifest_path=_man, history_path=_hist)
        _new = EM.resolve_version("ev1111", "cvNEW", manifest_path=_man, history_path=_hist)
        check("V50", "★ 成对反查：同一个 engine_version 的两条历史记录**各取各的**"
                     "（取错那条就是 Q43 修掉的错读数）",
              _old["n"] == 1 and (_old["match"] or {}).get("code_version") == "cvOLD"
              and _new["n"] == 1 and (_new["match"] or {}).get("code_version") == "cvNEW",
              f"cv=cvOLD → {(_old['match'] or {}).get('code_version')} · "
              f"cv=cvNEW → {(_new['match'] or {}).get('code_version')}")

        _single = EM.resolve_version("ev1111", manifest_path=_man, history_path=_hist)
        check("V51", "★ 只给 engine_version 时**不许挑第一条**：命中 2 条必须 ambiguous + match=None",
              _single["n"] == 2 and _single["ambiguous"] is True and _single["match"] is None,
              f"n={_single['n']} ambiguous={_single['ambiguous']} match={_single['match']} —— "
              f"旧实现会静默返回最早那条（cvOLD），于是 code_version 是错的")

        _miss = EM.resolve_version("evNOPE", "cvNOPE", manifest_path=_man, history_path=_hist)
        _unread = EM.resolve_version("ev1111", "cvOLD", manifest_path=_man,
                                     history_path=_T50 / "不存在的账本.jsonl")
        check("V52", "★「没有」与「未测」必须分开：账本读不出 → history_readable=False，"
                     "不是「查过了，没有」",
              _miss["n"] == 0 and _miss["history_readable"] is True
              and _unread["n"] == 0 and _unread["history_readable"] is False,
              f"账本在 → readable={_miss['history_readable']}(n={_miss['n']}) · "
              f"账本不在 → readable={_unread['history_readable']}(n={_unread['n']})")

        # ★ 反向对照：账本里有**解析不了的行**时，同样不许声称「历史我都查过了」——
        #   「跳过坏行 + 报告一切正常」是这一类工具最典型的静默失败。
        _badhist = _T50 / "bad.jsonl"
        _badhist.write_text('{"engine_version": "ev1111", "code_version": "cvOLD"}\n{坏行\n',
                            encoding="utf-8")
        _bad = EM.resolve_version("ev1111", "cvOLD", manifest_path=_man, history_path=_badhist)
        check("V52b", "反向对照：账本有解析不了的行 → 同样落未测"
                      "（不许跳过坏行还说自己查过了）",
              _bad["history_readable"] is False and _bad["n"] == 1,
              f"readable={_bad['history_readable']}（成对已命中 1 条仍不声称查全，坏行=1）· "
              f"{_bad['note'][:60]}…")

        # ── V53：**执行点** —— push_receipts 真的在用它，而且是**行为级**分类，
        #   不是「源码里出现过 resolve_version」那种文本存在性断言（§2.4 点名的假执行点）。
        sys.path.insert(0, str(ROOT / "tools"))
        import push_receipts as PR                                        # noqa: PLC0415

        _rc_ok = {"run_id": "jr-ok", "engine_version": "ev1111", "code_version": "cvOLD"}
        _rc_gone = {"run_id": "jr-gone", "engine_version": "evNOPE", "code_version": "cvNOPE"}
        _tr_ok = PR.traceability([_rc_ok], manifest_path=_man, history_path=_hist)
        _tr_gone = PR.traceability([_rc_gone], manifest_path=_man, history_path=_hist)
        _tr_unt = PR.traceability([_rc_gone], manifest_path=_man,
                                  history_path=_T50 / "无.jsonl")
        check("V53", "★ 执行点：可追溯性真的被分成 ok / gone / **未测** 三类"
                     "（而不是只写在文档与提示里）",
              len(_tr_ok["ok"]) == 1 and len(_tr_gone["gone"]) == 1
              and len(_tr_unt["untested"]) == 1 and len(_tr_unt["gone"]) == 0,
              f"命中 → ok={len(_tr_ok['ok'])} · 不在且账本在 → gone={len(_tr_gone['gone'])} · "
              f"不在且账本读不出 → untested={len(_tr_unt['untested'])}"
              f"（gone={len(_tr_unt['gone'])} —— ★ 这里若是 1，就是把「未测」报成了「没有」）")

        _o53 = subprocess.run([sys.executable, "tools/push_receipts.py", "--status"],
                              cwd=str(ROOT), capture_output=True, text=True)
        check("V53b", "反向对照：真跑一次 `--status`，那一行读数必须真的打得出来"
                      "（证明它不只是自证里成立）",
              _o53.returncode == 0 and "可追溯" in _o53.stdout,
              f"rc={_o53.returncode} · 输出含「可追溯」={'可追溯' in _o53.stdout}")

        # ── V54（Q44）门二「**没问过**」与「问过没意见」必须长得不一样 ──────────────
        #   门二的开口条件是「**确实引用了条款**才判」，理由是对的：没有依据 ≠ 依据很弱。
        #   于是 PASS 档里那条**自己声明不引外部条款**（`no_external_basis`）的规则一旦被命中，
        #   这一路是「门二没问过」—— 而它此前与「门二问过、没意见」在产出里**一模一样**
        #   （两边都没有 `origin_narrowed`）。§2.4.2 的口径：**未测不许与通过长得一样**。
        _rules54 = json.loads((SKEL / "rules-v1.json").read_text(encoding="utf-8"))["rules"]
        _bykey54 = {r.get("rule_key"): r for r in _rules54}

        def _undeclared54(rows):
            """PASS 档 + 引用集为空 + **没有**显式声明 `no_external_basis` 的规则。"""
            return sorted(r["rule_key"] for r in rows
                          if r.get("disposition") in J.PASS_DISPOSITIONS
                          and not (r.get("external_ref") or [])
                          and not (r.get("no_external_basis") or "").strip())

        _nobasis54 = sorted(r["rule_key"] for r in _rules54
                            if r.get("disposition") in J.PASS_DISPOSITIONS
                            and not (r.get("external_ref") or []))
        # ★ 反向对照：喂一条**故意不声明**的同形规则，上面那个谓词必须指得出来 ——
        #   否则「声明齐全」会因为谓词恒假而恒真（§2.4 点名的病）。
        _bogus54 = {"rule_key": "TX.synthetic-undeclared", "disposition": "auto_pass",
                    "external_ref": [], "no_external_basis": ""}
        check("V54a", "★ PASS 档里「不引外部条款」的规则必须**显式声明**"
                      "（逐条点名：`T9.objective-parameter`），否则「没有依据」会被读成「依据很弱」",
              not _undeclared54(_rules54)
              and _undeclared54([_bogus54]) == ["TX.synthetic-undeclared"]
              and "T9.objective-parameter" in _nobasis54,
              f"今天这一类共 {len(_nobasis54)} 条：{_nobasis54} · 未声明的："
              f"{_undeclared54(_rules54) or '无'} · 反向对照（喂一条不声明的）→ "
              f"{_undeclared54([_bogus54])}")

        # Q44 的「无真实命中」前提已被 10-26 的排名提示明确改变。
        # 守的契约仍是：不引外部依据须如实标未测，新增提示不能吞掉既有风险。
        _recs54 = json.loads((SKEL / "_data" / "records.json").read_text(encoding="utf-8"))
        _hit54, _bad54 = set(), []
        _historical54 = historical_engine()
        for i, _r54 in enumerate(_recs54):
            _t54 = S.rec_text(_r54)
            before, _ = _historical54.assess(_t54)
            after, _ = J.engine().assess(_t54)
            # 除点名新增的规则外，每一项命中/档位/位置都必须逐字段不变。
            if [vars(h) for h in before] != [vars(h) for h in after if h.rule_key != RANKING_RULE]:
                _bad54.append((i, "旧规则输出变化"))
            for h in after:
                if h.rule_key in _nobasis54:
                    _hit54.add(h.rule_key)
                    if h.rule_key != RANKING_RULE or h.disposition != "auto_pass_with_note":
                        _bad54.append((i, "未经解释的新放行规则"))
            if after and all(h.rule_key == RANKING_RULE for h in after):
                result = J.judge(_t54)
                gate = result["verdict"].get("clause_gate") or {}
                if gate.get("status") != "untested" or gate.get("rules") != [RANKING_RULE]:
                    _bad54.append((i, "无外部依据却未标未测"))
        # 固定语义对照：放开族不阻断；非排名惯用语不乱命中；真正医疗风险仍拒绝。
        positives = ["m5 pro是最好的吸奶器", "the best breast pump", "No.1 wearable pump", "销量第一"]
        negatives = ["最好在收到货后联系客服", "尽力做到最好", "best practice", "best regards"]
        risky = ["the best breast pump for pain relief", "FDA approved, the best pump",
                 "Our pump cures mastitis and is the best"]
        _positive54 = all(J.judge(t)["verdict"]["disposition"] == "auto_pass_with_note"
                          for t in positives)
        _negative54 = all(RANKING_RULE not in {h["rule_key"] for h in J.judge(t)["hits"]}
                          for t in negatives)
        _risky54 = all(J.judge(t)["verdict"]["disposition"] == "auto_reject" for t in risky)
        check("V54b", "真实无外部依据命中须标未测；排名只作提示，医疗风险与非排名对照不变",
              _hit54 == {RANKING_RULE} and not _bad54 and _positive54 and _negative54 and _risky54,
              f"真实命中规则 {sorted(_hit54)}；逐行异常 {_bad54[:4]}；"
              f"排名正例={_positive54} / 非排名反例={_negative54} / 医疗风险反例={_risky54}")

        _nb54 = _nobasis54[0]
        _k54 = {_nb54: _bykey54[_nb54]}
        _st_hit = EO.cited_gate_status(cited=[], evidence_status="ok",
                                       hit_rule_keys=[_nb54], rules_by_key=_k54)
        _st_cited = EO.cited_gate_status(cited=[{"origin": "stated"}], evidence_status="ok",
                                         hit_rule_keys=[_nb54], rules_by_key=_k54)
        _st_other = EO.cited_gate_status(cited=[], evidence_status="ok",
                                         hit_rule_keys=["T8.2.urgency-scarcity"],
                                         rules_by_key=_k54)
        check("V54c", "★ 门二三态可判：命中「声明不引外部条款」的规则 → 落 `untested` 并点名；"
                      "**引用集非空**、或命中的是别的规则 → 不作声（两条反向对照）",
              (_st_hit or {}).get("status") == "untested"
              and (_st_hit or {}).get("rules") == [_nb54]
              and _st_cited is None and _st_other is None,
              f"命中它 → {(_st_hit or {}).get('status')} {(_st_hit or {}).get('rules')} · "
              f"引用集非空 → {_st_cited}（应为 None） · 命中别的规则 → {_st_other}（应为 None）")

        # ★★ 端到端：证明它**真的接在判定路径上** —— 用一份**内存里**合成的规则表
        #    （一个带关键词、`auto_pass`、声明了 `no_external_basis` 的规则），
        #    把进程内单例临时换掉跑一次 `judge()`，再**无条件换回来**。
        #    不碰盘上任何制品（§2.4.4）；这也是 §2.4.7 那条方法上的教训：
        #    判据要真的走进那一跳，而不是断言「源码里出现过这个名字」。
        _synth54 = copy.deepcopy(json.loads(
            (SKEL / "rules-v1.json").read_text(encoding="utf-8")))
        _synth54["rules"].append({
            "rule_key": "T9.synthetic-q44-no-basis",
            "parent_rule": "自证合成（Q44）", "topic": "T9", "topic_label": "产品参数（客观可测）",
            "modality": "permit", "severity": "L0", "disposition": "auto_pass",
            "evaluability": "manual_only",
            "match": {"keywords": ["ZZ_SYNTHETIC_Q44"], "patterns": [], "languages": ["en"]},
            "downgrade_band": {"keywords": [], "effect": "none"},
            "evidence_required": "product_spec",
            "no_external_basis": "自证合成：故意声明不引外部条款",
            "source_legacy": "自证", "detection_layer": "native",
        })
        _eng_orig = J._ENGINE
        try:
            J._ENGINE = S.Engine(_synth54, J.load_vocab())
            _r54 = J.judge("ZZ_SYNTHETIC_Q44", origin="test")
            _r54_clean = J.judge("a plain sentence with no rule in it", origin="test")
        finally:
            J._ENGINE = _eng_orig
        _cg54 = (_r54.get("verdict") or {}).get("clause_gate")
        check("V54d", "★ 接线（端到端）：命中这类规则时 `verdict.clause_gate` 真的出现且是 `untested`；"
                      "普通判定里**不许**凭空多出这个字段",
              isinstance(_cg54, dict) and _cg54.get("status") == "untested"
              and _cg54.get("rules") == ["T9.synthetic-q44-no-basis"]
              and "clause_gate" not in ((_r54_clean.get("verdict") or {}))
              and (_r54["verdict"]["disposition"] == "auto_pass"),
              f"合成规则命中 → clause_gate={_cg54} · disposition="
              f"{_r54['verdict']['disposition']}（门二未判，所以**不**收窄）· "
              f"普通判定里有这个字段吗={'clause_gate' in (_r54_clean.get('verdict') or {})}（应为否）")

        # ── V55（Q45）那句「未经法务确认」必须**机器产出**，不靠模型记性 ──────────
        #   此前它只在两处：回执（机器产出）与 `judge_copy` 的工具说明（**要求模型转述**）。
        #   而 Q22 要防的「一次研究被读成一次法务裁定」发生在**回答**里 —— 回答那一侧
        #   取决于模型当轮记不记得。选项 A：写进 `boundary_statement.unknowns`
        #   （与既有「每次都读 unknowns」的规矩接上），且**只在确实引用了未确认条款时加**。
        _r55 = J.judge("Buy our breast pump, it cures mastitis and is FDA cleared!",
                       origin="test")
        _u55 = _r55["boundary_statement"]["unknowns"]
        _q55 = [u for u in _u55 if "Q45" in u]
        _notice55 = (_r55.get("receipt") or {}).get("unconfirmed_notice")
        _plain55 = J.judge("Our bottle washer has a 6-cup capacity.", origin="test")
        _u55b = _plain55["boundary_statement"]["unknowns"]
        check("V55a", "★ 引用了未确认条款的判定，`boundary_statement.unknowns` 里必须有这条"
                      "（机器产出 —— 不再取决于模型当轮记不记得）",
              len(_q55) == 1 and "EXT-" in _q55[0],
              f"{len(_q55)} 条 · 点名了外部标准编号={'EXT-' in (_q55[0] if _q55 else '')} · "
              f"unknowns 共 {len(_u55)} 条")
        check("V55b", "★ 反向对照：**零命中**（没引用任何条款）的判定**不许**带这条 —— "
                      "否则它会变成一个天天响的信号（§2.1.1）",
              not any("Q45" in u for u in _u55b),
              f"零命中判定的 unknowns {len(_u55b)} 条，含 Q45 的 "
              f"{sum(1 for u in _u55b if 'Q45' in u)} 条（应为 0）")
        # ★ 同源要在**真写了回执**的那一次上比 —— 第一版这里没传 `receipt=True`，
        #   于是 `unconfirmed_notice` 是 None、「同源」根本无从比（判据自己先说清这一点）。
        with tempfile.TemporaryDirectory() as _t55d:
            _r55c = J.judge("Buy our breast pump, it cures mastitis and is FDA cleared!",
                            origin="test", receipt=True,
                            receipt_path=Path(_t55d) / "r.jsonl")
        _q55c = [u for u in _r55c["boundary_statement"]["unknowns"] if "Q45" in u]
        _notice55 = (_r55c.get("receipt") or {}).get("unconfirmed_notice")
        check("V55c", "★ 同源（§2.4.5）：boundary 里那一句只是**前缀 + 回执的原文**，"
                      "不是另写一句 —— 两处各写一句迟早会有一句先改",
              bool(_notice55) and len(_q55c) == 1 and _q55c[0].endswith(_notice55),
              f"boundary 那条以回执 notice 结尾="
              f"{bool(_q55c and _notice55 and _q55c[0].endswith(_notice55))}"
              f" · notice {len(_notice55 or '')} 字")

        # ★ 语料规模上的反向对照：**不是每条都带上它**（否则「只在引用了未确认条款时加」
        #   这半句是空的）。这里给的是一个**比例读数**，不是一个写死的常量。
        _n55 = _t55 = 0
        for _r55x in _recs54:
            _tx55 = ((_r55x.get("Primary Text") or "") + "\n"
                     + (_r55x.get("Headline") or "")).strip()
            if not _tx55:
                continue
            _t55 += 1
            if any("Q45" in u for u in
                   J.judge(_tx55, origin="test")["boundary_statement"]["unknowns"]):
                _n55 += 1
        check("V55d", "★ 规模上的反向对照：带上这条的判定既**不是全部**也不是零"
                      "（「只在引用了未确认条款时加」这半句因此不是空话）",
              0 < _n55 < _t55,
              f"语料有文本的 {_t55} 条里 {_n55} 条带上它（{_n55 / max(_t55, 1) * 100:.1f}%）"
              f" —— ★ 这就是「天天响的信号」的量，Q45 选项 A 的代价是**量出来的**")

        # ── V56（Q42）「P1/P2 零落点」必须**量得出来**，不能只是一句登记 ──────────
        #   Q42 = 选项 A：本轮只登记不建。选项 A 的原文要的是「一条**带判据**的缺口」——
        #   所以这里把「零落点」写成一条会红的断言：**判定路径上没有任何语义层调用**。
        #   ★ 它红了的那一刻，正是**回去改验收表那一行**的时刻 —— 而不是悄悄多出一层，
        #     让「P0–P3 四层配置完成」在没人注意的情况下自己变绿。
        _JUDGE_MODULES = ("judge.py", "score.py", "matcher.py", "severity.py",
                          "evidence_origin.py", "clause_ref.py", "engine_manifest.py")
        _SEM_RE = re.compile(
            r"^\s*(?:import|from)\s+(?:openai|anthropic|deepseek|dashscope|zhipuai)\b"
            r"|api\.openai\.com|api\.anthropic\.com|dashscope\.aliyuncs\.com"
            r"|/chat/completions|/v1/messages")

        def _sem_hits(mods, base=None):
            """判定路径上的语义层调用。`#` 之后不算代码（同 `verify_shouheng_ops.py` 的 C5、
            `verify_cards.mjs` 的 J1a —— 同一条读法，而不是各自打补丁）。"""
            out = []
            for _m in mods:
                _p = (base or SKEL) / _m
                if not _p.exists():
                    continue
                for _i, _ln in enumerate(_p.read_text(encoding="utf-8").splitlines(), 1):
                    if _SEM_RE.search(_ln.split("#", 1)[0]):
                        out.append(f"{_m}:{_i}")
            return out

        _hits56 = _sem_hits(_JUDGE_MODULES)
        _T56 = Path(tempfile.mkdtemp())
        (_T56 / "judge.py").write_text(
            "# 这是一条注释：import openai 写在注释里不算代码\nimport openai\n", encoding="utf-8")
        _ctrl56 = _sem_hits(("judge.py",), base=_T56)
        check("V56", "★ Q42=A 的判据：「P1/P2 零落点」是**量出来的** —— 判定路径上没有任何语义层调用"
                     "（它红了就是有人建了语义层，那一刻回去改验收表那一行）",
              not _hits56 and _ctrl56 == ["judge.py:2"],
              f"扫 {len(_JUDGE_MODULES)} 个判定模块 → 命中 {_hits56 or '无'}（应为空）· "
              f"反向对照（喂一个「注释里写 import openai + 真 import openai」的合成模块）→ "
              f"{_ctrl56}（必须只报第 2 行 —— 注释不算代码）")

        # ── V57（Q24）「不是守卫的词」必须被剔除、并单独登记 ────────────────────
        #   Q24 = 选项 A。判据不是「它长得像不像守卫」，而是**它就是所在规则要抓的那个主张**：
        #   旧系统 `exceptions` 的语义是**放行** —— 所以写着它的文案在旧系统里是**放行**的，
        #   那是**旧规则的一条假阴孔**。今天没出事只因为它 `wired=false`（拿不到带 → 按满档判险）：
        #   这个洞是**被意外关上的，不是被决定关上的**。
        #
        #   ★ 本块**自己加载**它要的两份数据：`_gdoc` / `_qitems` 属于 V43 那个 gate 的局部量，
        #     `--only V57` 时它们不存在 —— 这是写的时候按作用域推出来的，不是跑出来的。
        _g57 = json.loads((SKEL / "context-guards-v1.json").read_text(encoding="utf-8"))
        _w57 = {w["word"]: w for w in _g57["words"]}
        _fn57 = ((_g57.get("$false_negative_words") or {}).get("items") or [])
        _q57 = json.loads((SKEL / "legal-decisions-v1.json").read_text(
            encoding="utf-8")).get("$decision_queue") or []

        check("V57a", "★ Q24=A：`乳腺炎治疗设备` 已从守卫表**剔除**，并登记为「旧规则假阴孔」"
                      "（带 why + 决定指针）—— 它**就是 H02 要抓的那个主张**，不是免责声明",
              "乳腺炎治疗设备" not in _w57
              and len(_fn57) == 1 and _fn57[0].get("word") == "乳腺炎治疗设备"
              and _fn57[0].get("kind") == "旧规则假阴孔"
              and bool(_fn57[0].get("why")) and _fn57[0].get("decision") == "Q24",
              f"守卫表 {len(_w57)} 词（不含它）· 假阴孔清单 "
              f"{[(i.get('word'), i.get('decision')) for i in _fn57]}")

        def _homeless57(words, false_neg, items):
            """★ Q24 的 impact 点名的代价（「回头查旧表还有没有同类」）落成判据 —— 但**只管未接线的那半**。

            ★ 第一版把「已接线」的未归类词也算进来，于是报了 `treat yourself` / `gently` 两个
              「无归宿」—— 而它们其实是 `wired=true` / `active`。也就是说：**判据比它声称的宽**，
              它会误报（§2.1.1：会误报的检查器比没有检查器更糟）。现在分两半，各用各的口径：

                · **未接线**的未归类词 → 必须有归宿（与 V45d 同一条口径：被一条未决项认领，
                  或词条自己点名一条已答的 Q/D）；
                · **已接线**的未归类词 → 由 V57c 管（它已经在生效，问题是「谁对它负责」）。
            """
            fn = {i.get("word") for i in false_neg}
            claimed = {w for q in items for w in (q.get("covers_unwired_guards") or [])}
            bad = []
            for w in words:
                if w.get("guard_type") != "未归类" or w["word"] in fn or w.get("wired"):
                    continue
                if w["word"] in claimed:
                    continue
                blob = f"{w.get('wire_gap') or ''} {w.get('status_note') or ''}"
                if re.search(r"\b[QD]\d+\b", blob):
                    continue
                bad.append(w["word"])
            return sorted(bad)

        _unclass = [w for w in _w57.values() if w.get("guard_type") == "未归类"]
        _unwired_uc = [w for w in _unclass if not w.get("wired")]
        _homeless = _homeless57(list(_w57.values()), _fn57, _q57)
        _ctrl57 = _homeless57(
            [{"word": "ZZ 合成主张词", "guard_type": "未归类", "wired": False}],
            _fn57, _q57) == ["ZZ 合成主张词"]
        check("V57b", "★ 同类互查（Q24 的 impact 点名的代价）：每个**未接线**的 `未归类` 词都有归宿 —— "
                      "被一条未决项认领、或词条自己点名一条已答的 Q/D；**无归宿 = 遗忘**",
              not _homeless and _ctrl57 and len(_unwired_uc) > 0,
              f"未归类 {len(_unclass)} 个（未接线 {len(_unwired_uc)}：{[w['word'] for w in _unwired_uc]}）· "
              f"无归宿 {_homeless or '无'} · 反向对照（喂一个合成词）→ {_ctrl57}")

        # ★ V57c：未归类**且已接线**的词 —— 它已经在生效，所以问题不是「忘了认领」，
        #   而是「**谁对它负责**」。判据：至少有一条未决项在它的文本里点过这个名字。
        #   （今天 `treat yourself` 被 Q25 点名；`gently` 原先**谁都没提过** —— 这一条就是为它加的。）
        _blob57 = json.dumps(_q57, ensure_ascii=False)
        _wired_uc = [w["word"] for w in _unclass if w.get("wired")]
        _orphan57 = [w for w in _wired_uc if w not in _blob57]
        _ctrl57c = ("ZZ 合成主张词" not in _blob57) and ("gently" in _blob57)
        check("V57c", "★ 未归类**且已接线**（在生效）的词，必须至少有一条未决项点过它的名字 —— "
                      "「一个语义档没定的词正在生效，而没人对它负责」是这条要拦的",
              not _orphan57 and _ctrl57c,
              f"已接线且未归类 {len(_wired_uc)} 个：{_wired_uc} · 没有任何未决项提到的："
              f"{_orphan57 or '无'} · 反向对照（一个不存在的名字必须不在文本里）→ {_ctrl57c}")

        # ── V58（Q25）非主张词形走**准入过滤**，不是第三个通道 ──────────────────
        #   A 的要点：既不放行、也不降级 —— **不该让规则因这个词形而命中**。
        _nc58 = (_g57.get("$non_claims") or {}).get("entries") or []
        _ap58 = (_g57.get("$admission_pending") or {}).get("items") or []
        check("V58a", "★ Q25=A：非主张清单只收「**确实是另一个主张**」的词形；从守卫表移除的词要么在这里、"
                      "要么在「定性待法务」区 —— 两处都指得出一条真实的决定",
              bool(_nc58) and all(e.get("status") and e.get("decision") for e in _nc58)
              and len(_ap58) == 2
              and all(i.get("status") == "pending_legal" and i.get("decision") for i in _ap58)
              and not ({"treat yourself", "or cure", "or treat"} & set(_w57)),
              f"非主张 {[e['phrase'] for e in _nc58]} · 定性待法务 {[i['word'] for i in _ap58]} · "
              f"守卫表 {len(_w57)} 词（三者都不在里面）")

        _r58a = J.judge("Treat yourself to total comfort!", origin="test")
        _r58b = J.judge("prevent or cure mastitis", origin="test")
        _h58a = sorted({h["rule_key"] for h in _r58a["hits"]})
        _h58b = sorted({h["rule_key"] for h in _r58b["hits"]})
        check("V58b", "★ 行为级：`Treat yourself to total comfort!` **不再**命中 `T1.1.medical-cure`"
                      "（那 3 条误拦从根上消失），而 `prevent or cure mastitis` **仍然**命中"
                      "（证明过滤器不是把这条规则关掉）",
              "T1.1.medical-cure" not in _h58a and "T1.1.medical-cure" in _h58b,
              f"treat yourself → {_h58a or '零命中（落 catch_all）'} · prevent or cure → {_h58b}")

        _txt58 = "a cure or cure b"
        _m58 = _mm.mask_non_claims(_txt58, "T1.1.medical-cure",
                                   [{"rule": "T1.1.medical-cure", "phrase": "or cure", "suppress": "cure"}])
        _m58b = _mm.mask_non_claims("x cure y", "T9.别的规则",
                                    [{"rule": "T1.1.medical-cure", "phrase": "or cure", "suppress": "cure"}])
        check("V58c", "★ 遮罩必须**逐规则**且**等长**：别的规则拿到的还是原文本；长度一个字节都不许变"
                      "（变了会让位置读数与 `input_sha256` 失真）",
              len(_m58) == len(_txt58) and _m58.count("\x00") == 4 and _m58b == "x cure y",
              f"命中规则：{len(_m58)} 字节（原 {len(_txt58)}）· 遮掉 4 个字节 · "
              f"别的规则拿到的是否原样={_m58b == 'x cure y'}")

        # ── V59（Q46）守卫表是**手工维护的契约**，那个脚本不再能覆盖它 ──────────────
        #   背景：`build_context_guards.py` 的 `wired` 按 `downgrade_band.keywords` 重算，而那批词
        #   在 ADR-0008 分表时已搬进本表 → 重算恒为 0，入库是 79。实测跑一次 353 插入/457 删除，
        #   而输出照样打印「✅ 已写入」。与 §2.1 的 `readdoc > 文件` 同一个形状。
        _doc59 = " ".join((_g57.get("derivation_note") or []))
        check("V59a", "★ Q46=A：守卫表表头必须**如实声明**它是手工维护的契约（不再是生成物），"
                      "且指得出「真源就是本表自己」",
              ("手工维护" in _doc59) and ("一次性迁移" in _doc59)
              and ("真源" in (_g57.get("source") or {}).get("$now", "")),
              f"derivation_note 含「手工维护」={'手工维护' in _doc59}、"
              f"含「一次性迁移」={'一次性迁移' in _doc59} · source.$now 指得出真源="
              f"{'真源' in (_g57.get('source') or {}).get('$now', '')}")

        # ★ 行为级（§2.4.2：承诺要有执行点）：真跑一次那个脚本，**必须拒写**且表一字节未变。
        _gp59 = SKEL / "context-guards-v1.json"
        _before59 = _gp59.read_bytes()
        _o59 = subprocess.run([sys.executable, "research/governance/skeleton/build_context_guards.py"],
                              cwd=str(ROOT), capture_output=True, text=True)
        check("V59b", "★ 行为级：脚本在不带 `--force` 时**拒绝写盘（退 2）**，且守卫表一字节未变 —— "
                      "「重算不出就覆盖」这条路已经被封住",
              _o59.returncode == 2 and _gp59.read_bytes() == _before59
              and "拒绝写盘" in (_o59.stdout + _o59.stderr),
              f"退出码={_o59.returncode}（应 2）· 表字节未变={_gp59.read_bytes() == _before59} · "
              f"输出含「拒绝写盘」={'拒绝写盘' in (_o59.stdout + _o59.stderr)}")

        # ── V60（Q47）「未接线」必须在**表里**写明原因，而不是只活在账本里 ──────────
        #   Q47 = 选项 A：先补 `guard_type`（法务定性）再谈接线；定性之前维持 `wired=false`
        #   **并在表里写明原因**。判据落在后半句上：读表的人不该需要先读账本才知道为什么。
        _fr60 = [w for w in _w57.values()
                 if w["word"] in ("soulage les engorgements", "soulager les engorgements")]
        _bad60 = [w["word"] for w in _fr60
                  if w.get("wired") or "Q47" not in ((w.get("status_note") or "")
                                                     + (w.get("wire_gap") or ""))
                  or "不会生效" not in (w.get("status_note") or "")]
        check("V60", "★ Q47=A：两个法语守卫词**维持未接线**，且**表里**写明原因（点名 Q47 + 说清"
                     "「它今天在任何语句里都不会生效」）—— 读表的人不该需要先读账本",
              len(_fr60) == 2 and not _bad60,
              f"命中 {len(_fr60)} 条 · 不合格 {_bad60 or '无'} · "
              f"两条的 wire_gap 都点名 Q47={'Q47' in ((_fr60[0].get('wire_gap') or '') if _fr60 else '')}")

    ok = sum(1 for _, o, _ in RESULTS if o)
    n = len(RESULTS)
    if a.json:
        _sink.__exit__(None, None, None)     # 人读输出到此为止，stdout 只剩 JSON
    else:
        print()
        print("=" * 74)
        print(f"验收 {ok}/{n}  {'全绿' if ok == n else '★ 有红项'}")
        print("=" * 74)
    if a.json:
        print(json.dumps({"passed": ok, "total": n,
                          "items": [{"id": i, "ok": o, "title": t} for i, o, t in RESULTS]},
                         ensure_ascii=False, indent=2))
    return 0 if ok == n else 1


if __name__ == "__main__":
    sys.exit(main())

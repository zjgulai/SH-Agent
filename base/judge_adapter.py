#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""judge_adapter.py —— 基座的第②面：`judge(unit)`（ADR-0013 D1）

一句话：**`ContentUnit` → 一份判定，且这份判定知道自己在什么边界内成立。**

    judge_unit(unit) = judge(unit.text, **unit.routing)   ← 引擎一行没改
                       + 边界声明订正
                       + 回执挂上「哪份原件 / 哪版正文」

--------------------------------------------------------------------------
★ 这一层为什么必须存在（不是「一层薄封装」）
--------------------------------------------------------------------------

`judge(text, …)` 已经建成了（ADR-0012）。那为什么还要一层？

**因为 `judge()` 的边界声明里有一句话，在 ContentUnit 出现之后变成了假话。**

`skeleton/judge.py:220` 的 `unknowns` 里写着（写死在源码里）：

    **未覆盖的载体**：本判定只看文本。图片、视频、落地页正文、A+ 详情页均不在输入内。
    批次 C 已产出落地页正文的获取能力，但**尚未接入本引擎**。

同一句话还以**机器可读**的形式出现在 `boundary_statement.not_covered_carriers`
（`["图片", "视频", "落地页正文", "A+ 详情页"]`）里。

在 `ContentUnit` 之前，这句话是真的。之后，当一个 `landing_page` unit 进判定时，
**它逐字是假的** —— 那份判定的输入就是落地页正文。而 `judge.py` 自己
（`_layer_note()` 的注释）已经立过这条原则：

    ★ 一句写死的免责声明迟早会变成假话。

这正是那句话的实例。**而「边界声明说错了边界」比没有边界声明更坏**：
一份声称「落地页不在输入内」的判定，会让读的人以为这次审查根本没看落地页，
于是要么重复劳动，要么据此做出错误的覆盖结论。

**订正的方向有两条，本层只走一条**：

  ✗ 改 `judge.py` 里那两处 —— 那是改引擎。ADR-0013 D1 要的是「在引擎**前面**立信封」，
    而且 `_boundary()` 有一批验收脚本（`verify_engine_contract.py` 161 项）盯着。
  ✓ **在适配层订正** —— unit 知道自己是哪种载体，也只有它知道。
    订正动作本身进 `boundary_statement.$corrections`，**留痕，不静默改写**。

--------------------------------------------------------------------------
★ 回执：`judge()` 的回执答不了「哪份原件」
--------------------------------------------------------------------------

`skeleton/judge.py:485` 的 `build_receipt()` 只存 `input_sha256`（= 正文指纹）。
这对**广告文案**够用：正文就是原件。对**落地页**不够 —— 同一段正文可以来自
无数份 HTML（实测：4 个页面各取两次，原件指纹变 4/4，正文变 0/4）。

所以适配层的回执在引擎那份之上加一个 `unit` 块：
`raw_sha256` / `text_sha256` / `kind` / `uri` / 归一化档位 / 组装口径 / 文本化边界。
**它仍然不含原文与片段** —— ADR-0008 决策 2 与 ADR-0012 §3.3 那条约束没有被绕过，
加的全是指纹、版本名与边界文字。

**实现上的一个取舍（值得写下来）**：回执的 `obligations` 块（D6/D10 的出口声明）
由 `judge()` 内部从分层表生成，本层**不重写**。
重写就等于把一份**法务所有**的契约字段抄成第二份实现，两份迟早不一致。
做法是让 `judge()` 照常生成完整回执，只是把它写到临时路径，然后由本层
补上 `unit` 块、再经**生产闸门**（`append_receipt`，含哈希链与 origin 检查）落到真账本。

--------------------------------------------------------------------------
不变量
--------------------------------------------------------------------------

  J1  unit 合法（`contract.validate()` 全过）
  J2  **正文原样到达引擎**：`result["input"]["text_sha256"] == unit.fingerprint.text_sha256`
      且 `result["input"]["chars"] == unit.fingerprint.text_chars`
      —— 这条证明 unit 的正文没有被中间任何一层改写。对不上就说明有东西动过它。
  J3  边界声明里**不再**声称本次的载体未被覆盖
  J4  边界声明**新增**了本次载体的文本化边界（`covers` / `does_not_cover`）
  J5  回执（若发）带 `unit` 块，且仍不含原文与片段
  J6  一次判定 = 一条回执（不重复追加）

用法：
  from judge_adapter import judge_unit
  r = judge_unit(unit)
  r["verdict"]["disposition"], r["boundary_statement"]["unknowns"]

命令行：
  python3 base/judge_adapter.py --selftest
  python3 base/judge_adapter.py --from-record GG-xxxx
  python3 base/judge_adapter.py --from-url-key momcozy.com/products/…
  python3 base/judge_adapter.py --boundary-report     # 边界声明订正前后对照
"""
from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "research" / "governance" / "skeleton"))

import contract as C                                    # noqa: E402
import judge as J                                       # noqa: E402

CONTRACT_VERSION = "judge-unit-v1"

# 引擎写死那句「未覆盖的载体」，在这里被按前缀认出来。
_UNCOVERED_PREFIX = "**未覆盖的载体**"

# 载体 → 引擎边界声明里那条**已经过时**的说法所涉及的条目
CARRIER_ENTRY = {
    "landing_page": "落地页正文",
    "structured_json": "落地页正文",
}
# 载体 → 订正后的说法（**必须是可行动的**：说清现在覆盖到哪、还差什么）
CARRIER_CORRECTED = {
    "landing_page": (
        "**载体：落地页正文——已接入，但只覆盖到文字那一层。**"
        "本次判定的输入是 HTML 提取出来的正文（含图内 alt 与 JSON-LD 中的文字）。"
        "★ **不含画面语义**（构图、画面暗示功效、品牌调性），"
        "也**抓不到 JS 运行时渲染出来的内容**（本仓用标准库 `html.parser`，不上浏览器）。"
        "所以「落地页这个载体已覆盖」这句话，正确读法是"
        "「**它的文字部分已覆盖，画面部分仍未覆盖**」。"),
    "structured_json": (
        "**载体：商品 JSON（`<页面>.js`）——已接入。**"
        "本次判定的输入是 Shopify 商品接口的 `title` 与 `description` 正文。"
        "★ 它与同一个页面的 HTML 是**两份不同的原件**，"
        "两者的正文可能不一致 —— 那本身是一条值得看的差集，不是噪声。"),
}


# ---------------------------------------------------------------- 边界订正

def correct_boundary(result: dict, unit: dict) -> list[str]:
    """把引擎边界声明里**因 ContentUnit 而变成假话**的那些句子订正掉。

    返回订正记录（进 `boundary_statement.$corrections`）——
    **静默改写边界声明，比不订正更坏**：读的人会以为引擎本来就这么说的。
    """
    b = result.get("boundary_statement")
    if not isinstance(b, dict):
        return []
    kind = unit["source"]["kind"]
    entry = CARRIER_ENTRY.get(kind)
    corr: list[str] = []
    unknowns = b.get("unknowns") or []

    # ── 1) 把那条过时的「未覆盖的载体」整条换掉（只对真的不成立的载体做）──
    if entry is not None:
        hit = [i for i, s in enumerate(unknowns)
               if isinstance(s, str) and s.startswith(_UNCOVERED_PREFIX)]
        if hit:
            unknowns[hit[0]] = CARRIER_CORRECTED[kind]
            corr.append(
                f"unknowns[{hit[0]}] 「{_UNCOVERED_PREFIX}…」→ 已按载体 {kind} 改写。"
                "原句声称落地页正文未接入本引擎 —— 而本次判定的输入就是它。"
                "★ 不改 `judge.py` 里的那句话：那是改引擎，且有一批验收脚本盯着它。")
        else:
            # 找不到就**大声说**，不要安静地放过 —— 找不到说明引擎的措辞变了，
            # 于是本层的订正逻辑正在悄悄失效。
            corr.append(
                f"★ **订正失败**：`boundary_statement.unknowns` 里找不到以 "
                f"「{_UNCOVERED_PREFIX}」开头的条目。引擎措辞可能已变，本层订正逻辑失效 —— "
                f"**本次边界声明仍含过时说法，读它的人会被误导。**")

        # ── 2) 机器可读的那份清单也要改 ──────────────────────────
        ncc = b.get("not_covered_carriers")
        if isinstance(ncc, list) and entry in ncc:
            b["not_covered_carriers"] = [x for x in ncc if x != entry]
            corr.append(f"not_covered_carriers 移除 {entry!r}（本次的输入就是它）")
        elif isinstance(ncc, list):
            corr.append(f"★ not_covered_carriers 里本来就没有 {entry!r} —— 清单与 unknowns 不一致")

    # ── 3) 加进本次载体**真实的**边界 ────────────────────────────
    # ★ 对所有载体都加，不只是「引擎说错话」的那些。
    #   两句边界答的是不同的问题：
    #     引擎那句   「**引擎**覆盖哪些载体」—— 对广告文案仍然为真
    #     本块这句   「**这一次判定的输入**是什么、覆盖到哪」—— 每个 unit 都要有自己的答案
    #   对一条广告文案，后者是「字段原样拿来、无损、没看图/视频/落地页」，
    #   这不是前者的复述。
    tf = unit.get("textification") or {}
    if tf:
        unknowns.append(
            "**本次判定的输入与它的边界**（" + str(tf.get("extractor")) + "，"
            + ("有损" if tf.get("lossy") else "无损") + "）：覆盖到 —— "
            + "；".join(tf.get("covers") or []) + "。**覆盖不到** —— "
            + "；".join(tf.get("does_not_cover") or []) + "。"
            + "★ 只报「识别完整度 X%」而不写这一条，等于把没覆盖的部分记成已覆盖"
              "（ADR-0013 异议二）。")
        corr.append("unknowns 追加本次输入的 covers / does_not_cover")
    # ── 4) 「取不到正文」与「结构上没有正文」必须分得开 ──────────
    # ★ 第一版这里只判了 `not has_text`，于是它对**那 59 条 PLA 广告**也说
    #   「本条落 DP0 的原因与 PLA 那 59 条不同」—— 而它自己就是其中一条。
    #   **本层为了订正一句假话而写出的新句子，第一版就是假的。**
    #   被本文件自己的 [J3] 断言抓到。原因按**载体**分，不按「有没有文本」分：
    if not unit.get("has_text"):
        if kind in ("landing_page", "structured_json", "image", "video"):
            unknowns.append(
                "★★ **本条落 DP0，但原因与 PLA 那 59 条不同。**"
                f"载体是 `{kind}`，它**不是结构上没有文本**，而是"
                "**这一次没有取到 / 没提取出正文**。两者都走 DP0，性质与处置都不同："
                "前者（PLA）不用管，后者要重取、换提取方式，或记为一次获取失败 —— "
                "**它不是「这份内容没什么可看的」。**")
            corr.append("unknowns 追加「取不到 ≠ 没有」（本条正文为空且载体非文案）")
        elif kind == "free_text":
            unknowns.append(
                "★ **本条落 DP0，原因是调用方给的就是一段空文本** —— "
                "既不是 PLA 那种结构上没有文本，也不是抓取失败。")
            corr.append("unknowns 追加「调用方给的是空文本」")
        # ad_text：引擎那句 DP0 说明本来就是为它写的（明写「全部是 Google 产品广告」），
        # 所以**不加**任何东西 —— 不为了显得完整而制造冗余。

    if corr:
        b["$corrections"] = corr
        b["$corrections_note"] = (
            "★ 本块由 `base/judge_adapter.py` 写入。引擎的边界声明是**按文本载体**写的，"
            "`ContentUnit` 让别的载体也能进来之后，其中一句会变成假话。"
            "订正**留痕而不静默** —— 读的人有权知道哪句被改过、为什么。")
    return corr


# ---------------------------------------------------------------- 主契约

def judge_unit(unit: dict, *, receipt: bool = False, receipt_path: Path | None = None,
               issued_at: str | None = None, origin: str = "base") -> dict:
    """★ 基座第②面的稳定契约：`ContentUnit` → 判定。

    **引擎一行没改**：正文与路由原样交给 `judge()`，判定本身仍由它做。
    本层只做三件引擎做不了的事：订正边界、挂上双指纹、把「取不到 ≠ 没有」分开。
    """
    problems = C.validate(unit)
    if problems:
        raise ValueError("拒绝判定不合法的 unit：\n  - " + "\n  - ".join(problems))

    kw = C.to_judge_kwargs(unit)

    if receipt:
        # 让 judge() 照常生成**完整**回执（含 obligations —— 那是法务所有的字段，
        # 本层不重写第二份实现），但写到临时路径；补上 unit 块后再经生产闸门落账。
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td) / "receipt.jsonl"
            res = J.judge(**kw, receipt=True, receipt_path=tmp,
                          issued_at=issued_at, origin=origin)
            rc = res.get("receipt")
    else:
        res = J.judge(**kw, receipt=False, origin=origin)
        rc = None

    corr = correct_boundary(res, unit)

    res["unit"] = {
        "contract_version": unit["contract_version"],
        "unit_id": unit["unit_id"],
        "content_key": unit["content_key"],
        "kind": unit["source"]["kind"],
        "uri": unit["source"]["uri"],
        "raw_sha256": unit["fingerprint"]["raw_sha256"],
        "raw_bytes": unit["fingerprint"]["raw_bytes"],
        "raw_verified": unit["source"].get("raw_verified"),
        "text_sha256": unit["fingerprint"]["text_sha256"],
        "normalization_profile": unit["normalization"]["profile"],
        "composition_profile": unit["composition"]["profile"],
        "textification": unit["textification"],
        "$why": ("引擎的回执只存 `input_sha256`（正文指纹）—— 对广告够用，"
                 "对落地页不够：同一段正文可以来自无数份 HTML"
                 "（实测 raw 变 4/4 而正文变 0/4）。"
                 "本块补的是「哪份原件 / 哪版正文 / 覆盖到哪」，"
                 "**仍然不含原文与片段**（ADR-0008 决策 2 / ADR-0012 §3.3）。"),
    }
    res["contract_version"] = CONTRACT_VERSION

    if rc is not None:
        rc["unit"] = res["unit"]
        rc["boundary_corrections"] = corr
        dest = receipt_path or J.RECEIPTS_PATH
        J.append_receipt(rc, dest)          # ★ 走生产闸门：origin 检查 + 前缀哈希链
        res["receipt"] = rc
        res["$receipt_written_to"] = str(dest)
    return res


# ---------------------------------------------------------------- 自证

def selftest(verbose: bool = True) -> list[str]:
    fails: list[str] = []

    def check(name, cond, detail=""):
        ok = bool(cond)
        if verbose:
            print(("  ✓ " if ok else "  ✗ ") + name + (("   " + detail) if detail else ""))
        if not ok:
            fails.append(name + (("  " + detail) if detail else ""))
        return ok

    print("=" * 78)
    print("B0.3 自证 · judge(unit) 适配层（%s）" % CONTRACT_VERSION)
    print("=" * 78)

    ads, pages = C.units_from_corpus()

    print("\n[J1] 语料面：427 个 unit 全部进得去 judge")
    results, errs = [], []
    for u in ads + pages:
        try:
            results.append((u, judge_unit(u)))
        except Exception as e:                           # noqa: BLE001
            errs.append(f"{u['unit_id']} {type(e).__name__}: {e}")
    check("全部判定成功：%d / %d" % (len(results), len(ads) + len(pages)), not errs, errs[:2])

    print("\n[J2] 正文原样到达引擎（unit 的正文没有被中间任何一层改写）")
    bad = [(u["unit_id"], r["input"]["text_sha256"], u["fingerprint"]["text_sha256"])
           for u, r in results
           if r["input"]["text_sha256"] != u["fingerprint"]["text_sha256"]]
    check("text_sha256 逐个相等", not bad, bad[:2])
    badn = [u["unit_id"] for u, r in results
            if r["input"]["chars"] != u["fingerprint"]["text_chars"]]
    check("字符数逐个相等", not badn, badn[:2])
    check("引擎自己算的 input_sha256 就是 unit 的 text_sha256",
          all(r["input"]["text_sha256"] == u["fingerprint"]["text_sha256"] for u, r in results),
          "两个独立实现算出同一个数 —— 正文确实原样到达")

    print("\n[J3] 边界声明：不再声称本次的载体未被覆盖")
    stale = [(u["unit_id"], s) for u, r in results
             for s in r["boundary_statement"]["unknowns"]
             if isinstance(s, str) and s.startswith(_UNCOVERED_PREFIX)]
    check("广告 unit 保留原句（对它们仍是真的）：%d 条" % len(stale),
          len(stale) == len(ads), "★ 订正只对**真的不成立**的载体做，不是无差别删掉")
    page_stale = [u["unit_id"] for u, r in results
                  if u["source"]["kind"] in CARRIER_ENTRY
                  and any(isinstance(s, str) and s.startswith(_UNCOVERED_PREFIX)
                          for s in r["boundary_statement"]["unknowns"])]
    check("落载体 unit 全部已订正：%d 条残留" % len(page_stale), not page_stale)
    n_ncc = sum(1 for u, r in results
                if u["source"]["kind"] in CARRIER_ENTRY
                and "落地页正文" not in (r["boundary_statement"].get("not_covered_carriers") or []))
    check("not_covered_carriers 里的「落地页正文」已移除：%d / %d"
          % (n_ncc, sum(1 for u, _ in results if u["source"]["kind"] in CARRIER_ENTRY)),
          n_ncc == sum(1 for u, _ in results if u["source"]["kind"] in CARRIER_ENTRY))
    check("订正留痕（$corrections，不静默改写）",
          all(r["boundary_statement"].get("$corrections")
              for u, r in results if u["source"]["kind"] in CARRIER_ENTRY))
    ad_corr = [c for u, r in results if u["source"]["kind"] not in CARRIER_ENTRY
               for c in (r["boundary_statement"].get("$corrections") or [])]
    check("广告 unit 的订正里**没有**载体改写（引擎那句对广告仍然为真）",
          ad_corr and not any("已按载体" in c for c in ad_corr),
          "★ 只追加「本次输入是什么」，不改写引擎的原句")
    # ★ 这条断言是补的：本层第一版对那 59 条 PLA 广告也说
    #   「本条落 DP0 的原因与 PLA 那 59 条不同」—— 而它自己就是其中一条。
    #   为了订正一句假话而写出的新句子，第一版就是假的。
    pla_corr = [c for u, r in results
                if u["source"]["kind"] == "ad_text" and not u["has_text"]
                for c in (r["boundary_statement"].get("$corrections") or [])]
    check("59 条 PLA 空文案**不**被告知「你与 PLA 那 59 条不同」",
          not any("取不到" in c for c in pla_corr),
          "原因按载体分，不按「有没有文本」分 —— 这条断言守着本层自己别制造假话")

    print("\n[J4] 边界声明新增本次输入的文本化边界（ADR-0013 异议二）")
    has_cov = [u for u, r in results
               if any("本次判定的输入与它的边界" in s for s in r["boundary_statement"]["unknowns"])]
    check("含 covers / does_not_cover 的判定：%d / %d" % (len(has_cov), len(results)),
          len(has_cov) == len(results),
          "对所有载体都加：引擎那句答「引擎覆盖什么」，本块答「这一次的输入是什么」")
    lpp = [u for u, r in results
           if u["source"]["kind"] == "landing_page"
           and any("不含画面语义" in s for s in r["boundary_statement"]["unknowns"])]
    check("落地页判定明写「不含画面语义」：%d / %d"
          % (len(lpp), sum(1 for u, _ in results if u["source"]["kind"] == "landing_page")),
          len(lpp) == sum(1 for u, _ in results if u["source"]["kind"] == "landing_page"),
          "只报「识别完整度 X%」而不写这条，等于把画面风险记成已覆盖")

    print("\n[J5] 回执：挂上双指纹，且仍不含原文与片段")
    with tempfile.TemporaryDirectory() as td:
        rp = Path(td) / "rc.jsonl"
        u0 = next(u for u in pages if u["source"]["kind"] == "landing_page")
        r0 = judge_unit(u0, receipt=True, receipt_path=rp)
        rc = r0["receipt"]
        check("回执带 unit 块", isinstance(rc.get("unit"), dict))
        check("回执的 unit 块同时有两个指纹",
              rc["unit"]["raw_sha256"] != rc["unit"]["text_sha256"])
        check("回执的 unit 块带锚定「哪版正文」的两个档位名",
              rc["unit"]["normalization_profile"] and rc["unit"]["composition_profile"])
        check("回执保留引擎原有的 obligations（本层不重写第二份实现）",
              "obligations" in rc, "出口声明是法务所有的字段")
        blob = json.dumps(rc, ensure_ascii=False)
        body = u0["text"][200:260]
        check("回执不含原文片段", body not in blob, "抽查正文中段 60 字符")
        check("回执含 verdict_digest（把回执钉在结论上，不只在输入上）",
              bool(rc.get("verdict_digest")))
        check("回执写到了指定路径，生产账本未被触碰",
              rp.exists() and len(rp.read_text(encoding="utf-8").strip().splitlines()) == 1)
        check("一次判定 = 一条回执（不重复追加）",
              len(rp.read_text(encoding="utf-8").strip().splitlines()) == 1)
        check("写完把 receipt 挂回结果体", r0["receipt"] is rc)

    print("\n[J6] 反向对照：坏输入必须红")
    for label, mut in (
            ("正文被改而指纹没改", lambda u: {**u, "text": u["text"] + "X"}),
            ("kind 越域", lambda u: {**u, "source": {**u["source"], "kind": "hologram"}}),
            ("routing 含 judge 不认的键",
             lambda u: {**u, "routing": dict(u["routing"], 不存在的键="x")})):
        base = next(x for x in ads if len(x["composition"]["parts"]) >= 2)
        try:
            judge_unit(mut(base))
            check("必红：%s → 被拒（不拿坏信封去判定）" % label, False, "它被放行了")
        except ValueError as e:
            check("必红：%s → 被拒（不拿坏信封去判定）" % label, "不合法" in str(e) or "不认识的键" in str(e),
                  str(e).splitlines()[-1][:60])
    # 引擎措辞变了的对照：把前缀改掉，订正必须**说出来**而不是安静放过
    u1 = next(u for u in pages if u["source"]["kind"] == "landing_page")
    r1 = judge_unit(u1)
    saved = r1["boundary_statement"]["unknowns"]
    r1["boundary_statement"]["unknowns"] = [s for s in saved
                                            if not (isinstance(s, str)
                                                    and s.startswith(_UNCOVERED_PREFIX))]
    r1["boundary_statement"].pop("$corrections", None)
    corr = correct_boundary(r1, u1)
    check("必红：找不到那段措辞时**大声报订正失败**（不静默放过）",
          any("订正失败" in c for c in corr), corr[0][:70] if corr else "没有任何订正记录")

    print("\n" + "=" * 78)
    if fails:
        print("✗ B0.3 自证未通过：%d 项" % len(fails))
        for f in fails:
            print("   - " + f)
    else:
        print("✓ B0.3 自证全绿：%d 个 unit 进判定，边界声明按载体订正，回执挂双指纹"
              % len(results))
    print("=" * 78)
    return fails


def boundary_report() -> None:
    """订正前后对照 —— 给人看的，不是给断言看的。"""
    ads, pages = C.units_from_corpus()
    u = next(x for x in pages if x["source"]["kind"] == "landing_page")
    raw = J.judge(**C.to_judge_kwargs(u))
    fixed = judge_unit(u)
    old = [s for s in raw["boundary_statement"]["unknowns"]
           if isinstance(s, str) and s.startswith(_UNCOVERED_PREFIX)]
    new = [s for s in fixed["boundary_statement"]["unknowns"]
           if "载体：落地页正文" in s]
    print("=" * 78)
    print("单元：", u["unit_id"], "·", u["source"]["uri"][:64])
    print("=" * 78)
    print("\n【订正前】引擎原话（对一个落地页 unit 而言是**假的**）\n")
    print("  " + (old[0] if old else "（无）"))
    print("\n【订正后】适配层写入\n")
    print("  " + (new[0] if new else "（无）"))
    print("\n【机器可读清单】")
    print("  订正前 not_covered_carriers =",
          raw["boundary_statement"].get("not_covered_carriers"))
    print("  订正后 not_covered_carriers =",
          fixed["boundary_statement"].get("not_covered_carriers"))
    print("\n【订正记录（留痕）】")
    for c in fixed["boundary_statement"].get("$corrections", []):
        print("  · " + c)
    print("\n【新增：本次输入的边界（covers / does_not_cover）】")
    for s in fixed["boundary_statement"]["unknowns"]:
        if "本次判定的输入与它的边界" in s:
            print("  " + s)
    print()


def main() -> int:
    ap = argparse.ArgumentParser(description="judge(unit) 适配层（基座第②面）")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--selftest", action="store_true")
    g.add_argument("--boundary-report", action="store_true")
    g.add_argument("--from-text", metavar="TEXT")
    g.add_argument("--from-record", metavar="AD_ID")
    g.add_argument("--from-url-key", metavar="URL_KEY")
    ap.add_argument("--product-line", default=None)
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    if a.selftest:
        return 1 if selftest() else 0
    if a.boundary_report:
        boundary_report()
        return 0
    if a.from_text:
        u = C.from_text(a.from_text, product_line=a.product_line)
    elif a.from_record:
        rec = next((r for r in C.load_ad_records() if r.get("外部广告ID") == a.from_record), None)
        if rec is None:
            print("找不到广告ID：" + a.from_record, file=sys.stderr)
            return 2
        u = C.from_ad_record(rec)
    else:
        fetch, ext, ev = C.load_landing()
        rec = next((r for r in fetch["results"] if r["url_key"] == a.from_url_key), None)
        if rec is None:
            print("找不到 url_key：" + a.from_url_key, file=sys.stderr)
            return 2
        u = C.from_landing_page(rec, ext.get(rec["url_key"]), evidence_dir=ev)

    r = judge_unit(u)
    if a.json:
        print(json.dumps(r, ensure_ascii=False, indent=2))
    else:
        print(J.render(r))
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""text_stage.py —— 文本进管道的第①面（B2 · 补齐**两组**文本的三指标）

    python3 base/text_stage.py --selftest     # 离线自证
    python3 base/text_stage.py --report       # 两组文本的三指标 + 与图片/视频的合表
    python3 base/text_stage.py --timing       # 只测第三个数（真的跑一遍，不是读常数）

--------------------------------------------------------------------------
★ 这一层补的是哪块缺口
--------------------------------------------------------------------------

ADR-0013 D3 要求「打样覆盖**文字、图片、视频**三类」。B1 做完了图片（`media.py`），
视频如实报「没有数字」。**文字这一类一直没有自己的三个数字** —— 它被认为「已经通了，
所以不用量」。这个想法本身就是要防的那个形态：**跑得通 ≠ 量过了**。

而且「文字」不是一个载体，是**两组来源完全不同的语料**：

| 组 | 来源 | 分母 | 「获取」是什么意思 |
|---|---|---|---|
| **A 广告文案** | 存量记录表（内部导出） | **291 条记录** | 把表读成 unit —— 不是抓取 |
| **B 落地页 HTML** | 批次 C 联网抓取 | **92 个 URL** | 从站点取回内容 —— 是抓取 |

**把这两组混成一个「文字类」百分比是错的**：A 的失败原因是「字段本来就没有」
（结构化广告的文案不在文本字段里），B 的失败原因是「站点不给你」。两者的处置完全不同。

--------------------------------------------------------------------------
★ 落进这一层时量出来的三件事
--------------------------------------------------------------------------

**① 广告组的「100%」是世界上最像样的一个假数字。**
   291/291 条记录都读成了 unit，报出去就是「内容获取成功率 100%」。
   而它只说明**表读得动**：59 条（20.3%）记录**正文为空**，一个字都没有。
   所以本模块报的第一个数是 **有可判正文的比例**（232/291 = 79.7%），
   并把「表读得动」单独记为一个跳次 —— 两个数分开，各自回答自己的问题。

**② 落地页组的 100% 与 30.4% 必须成对读，这一条已经有了（批次 C），
   但没有进「三指标」这个口径。** 本模块把它编进指标本身，而不是留在报告正文里。

**③ 第三个数字「处理耗时」对文本档还漏了一问：重跑能不能得到一样的数。**
   法务表的三个数是给「工具能不能稳定获取并处理」用的，`稳定` 是关键词。
   批次 C 的 100% 是 2026-09-16 那个时点的事实。本模块把
   `tools/lp_stability.py` 的实测接进来（有则用、无则明说没有），
   因为**一个没有复现性声明的百分比会被读成「这个数明天还是这个数」。**
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "tools"))

import contract as C                                       # noqa: E402
import judge_adapter as JA                                 # noqa: E402
import media as M                                          # noqa: E402

CONTRACT_VERSION = "text-v1"
LAND = ROOT / "research" / "landing"

# 广告组里「有信息」的判据（与 `04-内部证据-字段可用性与平台抽样偏差.md` 的剖面同一套：
# 空、`-`、`—`、`/` 都算没有）
EMPTY = {"", "-", "—", "–", "/", "N/A", "n/a", "无"}


def filled(v) -> bool:
    return str(v).strip() not in EMPTY if v is not None else False


def pct(n, d):
    return round(100.0 * n / d, 1) if d else None


def percentiles(v):
    if not v:
        return {}
    v = sorted(v)

    def p(q):
        # ★ `round(..., 3)`：广告档的「建 unit」是 **0.02ms 级**的数，不圆会打出
        #   `0.024666999999992112` 这种浮点尾巴 —— 看起来像精度，其实是误差。
        return round(v[min(len(v) - 1, max(0, int(round(q * (len(v) - 1)))))], 3)
    return {"n": len(v), "p50": p(.5), "p90": p(.9), "p95": p(.95),
            "min": round(v[0], 3), "max": round(v[-1], 3),
            "mean": round(sum(v) / len(v), 3)}


# ================================================================== A 组：广告文案

# 「这一条记录有没有可判正文」是 A 组的成败判据。**按字段定，不按记录定** ——
# 一条记录在表里读得动，与它有没有内容，是两个问题。
AD_TEXT_FIELDS = ("Primary Text", "Headline")


def stage_ads(records: list[dict] | None = None, *, timing: bool = False) -> dict:
    """A 组（广告文案）的三个数字。**分母 = 291 条记录，空文案逐条在案。**"""
    recs = records if records is not None else C.load_ad_records()
    n = len(recs)

    units, t_build = [], []
    for r in recs:
        t0 = time.perf_counter()
        units.append(C.from_ad_record(r))
        t_build.append((time.perf_counter() - t0) * 1000)

    has_text = [u for u in units if u["has_text"]]
    empty = [u for u in units if not u["has_text"]]
    # 空文案的构成：**要说得出是哪些**，否则「59 条没有文案」读起来像抓取失败
    why = {}
    for r in recs:
        if not any(filled(r.get(f)) for f in AD_TEXT_FIELDS):
            k = (r.get("广告类型") or "（广告类型为空）").strip() or "（广告类型为空）"
            why[k] = why.get(k, 0) + 1

    # ── 一 · 内容获取成功率 ────────────────────────────────────────
    acquire = {
        "指标": "内容获取成功率",
        "值": pct(len(has_text), n),
        "分子": len(has_text), "分母": n,
        "★ 判据": "**记录里有可判正文**（`Primary Text` / `Headline` 至少一个非空）。"
                  "不是「记录读进来了没有」。",
        "$分母口径": (
            "★ 本档有**两跳**，只有第二跳可测：\n"
            "  跳① 广告平台 → 存量记录表：**不可测**。表是内部导出的，"
            "仓里没有任何关于「平台上有多少条广告、其中多少条进了表」的记录。"
            "在这一跳上写任何百分比都是编的。\n"
            "  跳② 存量记录表 → unit：**291/291 = 100%**。\n"
            "**把跳②的 100% 报成「内容获取成功率」是本档最容易犯的错**："
            "它只说明表读得动，与「内容拿到没有」无关 —— 而 59 条记录的正文是空的。"
            "所以 `值` 报的是跳②里**真的有正文**的那一部分。"),
        "跳①_平台到存量表": {
            "值": None, "$status": "cannot_measure",
            "$why": "表是给定的。没有任何记录能支撑一个百分比 —— 见 `$分母口径`。",
        },
        "跳②_存量表到unit": {"值": 100.0, "分子": n, "分母": n,
                              "$只说明": "表读得动。**不是内容覆盖率。**"},
        "失败档": why,
        "$失败档说什么": (
            "空文案不是「抓取失败」，是**结构化广告的文案不在文本字段里**："
            "产品广告（Google PLA / Shopping）的标题、价格、卖点由平台按商品feed拼装，"
            "没有 Primary Text / Headline 这两个字段。**它们的文案在图片与商品标题里**，"
            "所以这 59 条要去看图片档 —— 而不是记成「无内容」。"),
    }

    # ── 二 · 识别完整度 ───────────────────────────────────────────
    # 与批次 C 的六类要素同一形态：**逐字段的达成率**，不是拍一个总分。
    fields = ["广告名称", "平台", "广告系列Campaign", "广告账号", "广告组", "广告类型",
              "品线", "投放地区", "文案语种", "Primary Text", "Headline", "落地页URL",
              "风险等级", "处理状态", "抓取状态", "投放状态",
              "近7天费用USD", "近7天展示", "近7天点击",
              "命中原因", "命中片段", "命中规则", "修改建议", "检查人", "外部广告ID"]
    per = {}
    for f in fields:
        k = sum(1 for r in recs if filled(r.get(f)))
        per[f] = {"达成": k, "分母": n, "覆盖率_pct": pct(k, n)}
    vals = [sum(1 for f in fields if filled(r.get(f))) / len(fields) for r in recs]
    recognize = {
        "指标": "页面/素材识别完整度",
        "值": round(statistics.mean(vals), 3),
        "分子": None, "分母": n,
        "$值口径": ("**25 个字段的达成率均值**（0–1）。与批次 C 的「六类要素完整度」"
                    "同一形态：逐项列出，不拍一个总分。"
                    "★ 均值会被 21 个几乎全满的采集段字段抬起来 —— "
                    "**所以下面三段的分段读法比这个均值有用**。"),
        "逐字段": per,
        "三段剖面": _profile_sections(per, n),
        "完整度": {"均值": round(statistics.mean(vals), 3),
                   "中位": round(statistics.median(vals), 3),
                   "25 字段全满": sum(1 for v in vals if v == 1.0), "分母": n},
        "$边界": ("★★ **本数字只覆盖记录表里的文本字段，不含图片、视频、落地页正文。**"
                  "这 59 条空文案广告的「素材」在图片里 —— 图片档（`media.py`）"
                  "覆盖的是落地页上的图，**不是广告素材本身**，两者不是同一批图。"),
    }

    # ── 三 · 处理耗时 ─────────────────────────────────────────────
    t3 = {"指标": "处理耗时", "单位": "毫秒",
          "建 unit（291 条）": percentiles(t_build),
          "$口径": ("`建 unit` = `contract.from_ad_record()` 一条记录的墙钟，"
                    "含双指纹计算与拼接。**不含**把它写进任何库的时间。")}
    if timing:
        t_judge, np_ = [], 0
        for u in has_text:
            t0 = time.perf_counter()
            JA.judge_unit(u)
            t_judge.append((time.perf_counter() - t0) * 1000)
            np_ += 1
        t3["判定（有正文的 %d 条）" % np_] = percentiles(t_judge)
        t3["$口径"] += (" `判定` = `judge_unit()` 一次调用的墙钟，"
                        "含引擎判定 + 边界订正 + 双指纹挂载（不含回执落账）。")
    else:
        t3["判定"] = {"$status": "not_measured",
                      "$why": "`--report` 不跑判定（291 次调用会拖慢报告）；"
                              "用 `--timing` 实测。"}
    return {"contract_version": CONTRACT_VERSION,
            "组": "A · 广告文案", "来源": "存量记录表（skeleton/_data/records.json）",
            "一_内容获取成功率": acquire,
            "二_识别完整度": recognize,
            "三_处理耗时": t3,
            "样本": {"总数": n, "有可判正文": len(has_text), "正文为空": len(empty)},
            "$note": ("★ 分母是全部 291 条记录，空文案的 59 条**逐条在案**（`失败档` 按类型聚合，"
                      "`--report` 打印明细）。沿批次 C 的规矩：失败项不进垃圾桶。")}


def _profile_sections(per: dict, n: int) -> dict:
    """三段剖面 —— 批次 C 的 04 号证据量出的形状，这里**从记录实时重算**。

    ★ 为什么值得单列：单调递减的阶梯里，**断崖的位置**比任何一个单点数值有信息量。
      断崖在「采集段 → 治理段」之间，说明流程是自左向右搭的，搭到「谁负责」停下了。
    """
    segs = {
        "采集段": ["广告名称", "平台", "品线", "外部广告ID", "文案语种"],
        "维度段": ["广告系列Campaign", "广告账号", "广告组", "广告类型", "数据日期"],
        "正文段": ["Primary Text", "Headline", "落地页URL"],
        "分析段": ["命中原因", "命中片段", "命中规则", "修改建议"],
        "治理段": ["检查人"],
    }
    out = {}
    for name, fs in segs.items():
        fs = [f for f in fs if f in per]
        if not fs:
            continue
        rng = [per[f]["覆盖率_pct"] for f in fs]
        out[name] = {"字段数": len(fs), "区间": [min(rng), max(rng)],
                     "零填充字段": [f for f in fs if per[f]["达成"] == 0]}
    out["$读法"] = ("★ **断崖的位置比数值有信息量。** 采集段的字段几乎全满，"
                    "治理段停下 —— 说明流程是从左向右搭起来的，搭到「谁负责」这一步停了。"
                    "（首测见 `04-内部证据-字段可用性与平台抽样偏差.md`，本函数每次从记录重算。）")
    return out


# ================================================================== B 组：落地页 HTML

def stage_landing() -> dict:
    """B 组（落地页 HTML）的三个数字。

    ★ **读数不重算。** 三个数的唯一产地是 `tools/lp_metrics.py`（批次 C）。
      在第二个地方重算同一个判据，就是本项目已出过三次事的「两处真相」。
      本函数只做两件 `lp_metrics.py` 没做的事：
        ① 把它整成与 A 组 / 图片档同一形状的三指标；
        ② 补上「**复现性**」—— 第三个数的读法里缺的那一问。
    """
    p = LAND / "指标.json"
    if not p.exists():
        return {"组": "B · 落地页 HTML", "$status": "cannot_measure",
                "$why": "缺 %s —— 先跑 `python3 tools/lp_metrics.py`。"
                        % p.relative_to(ROOT)}
    m = json.loads(p.read_text(encoding="utf-8"))
    m1, m2, m3 = (m["指标1_内容获取成功率"], m["指标2_页面素材识别完整度"],
                  m["指标3_处理耗时"])
    rounds = m3.get("分轮次") or []
    worst = min((r for r in rounds if r.get("成功_pct") is not None),
                key=lambda r: r["成功_pct"], default=None)

    acquire = {
        "指标": "内容获取成功率",
        "值": m1["成功率_pct"], "分子": m1["成功"], "分母": m1["分母"],
        "$分母口径": (
            "**分母 = URL 总数 92，不是成功数**（沿批次 C 的规矩）。"
            "★ 本档的 `值` **必须与「首轮成功率」成对读** —— 见 `成对读数`。"
            "它是「获取策略 × 站点防护」的联合结果，**不是站点的属性**。"),
        "成对读数": {
            "首轮": ({"成功_pct": worst["成功_pct"], "成功": worst["成功"],
                      "尝试": worst["尝试"], "全局间隔秒": worst["起始全局间隔秒"],
                      "轮次": worst["轮次"]} if worst else None),
            "终值": {"成功_pct": m1["成功率_pct"], "成功": m1["成功"], "分母": m1["分母"]},
            "$为什么必须成对": (
                "同一个站点、同一批 URL、同一份 UA，**唯一变量是节流策略**："
                "首轮只有同域名 1.2s 间隔、无全局节流 → 30.4%；"
                "改成全局 6s → 100%。**只报终值会同时冤枉站点、掩盖真问题。**"),
        },
        "分域名": m1.get("分域名"), "分类型": m1.get("分类型"),
        "失败档": {r["tier"]: r["说明"] for r in (m1.get("失败明细") or [])} or {},
    }

    per = {k: {"达成": v["达成"], "分母": v["分母"], "覆盖率_pct": v["覆盖率_pct"]}
           for k, v in (m2.get("逐要素") or {}).items()}
    recognize = {
        "指标": "页面/素材识别完整度",
        "值": (m2.get("完整度") or {}).get("均值"),
        "分母": m2.get("分母_成功页面"),
        "$值口径": ("**六类要素达成率的均值**（title / body_text / images / claims / "
                    "links / locale_signals）。" + (m2.get("声明") or "")),
        "逐字段": per,
        "完整度": m2.get("完整度"),
        "正文长度": m2.get("正文长度"),
        "$边界": ("★ 六类要素的「达成」判据是**结构性的**（正文 ≥200 字符、"
                  "抽到 ≥1 条链接…），不是「内容对不对」。"
                  "`claims` 那一类的达成 = 页面上至少出现一个声明词形 —— "
                  "**零声明也会让这一类不达成**，所以 90/92 里的 2 个不是抓取问题。"),
    }

    timing = {
        "指标": "处理耗时", "单位": "毫秒",
        "HTML 路径": m3.get("HTML 路径"),
        "结构化端点路径": m3.get("结构化端点路径"),
        "$口径": m3.get("说明"),
        "体积倍数_HTML/结构化": m3.get("体积倍数_HTML/结构化"),
        "耗时倍数_HTML/结构化": m3.get("耗时倍数_HTML/结构化"),
    }

    return {"contract_version": CONTRACT_VERSION,
            "组": "B · 落地页 HTML", "来源": "批次 C 抓取（快照 %s）" % m.get("snapshot"),
            "一_内容获取成功率": acquire,
            "二_识别完整度": recognize,
            "三_处理耗时": timing,
            "三之补_复现性": reproducibility(),
            "样本": {"总数": m1["分母"], "成功": m1["成功"]},
            "$来源": "research/landing/指标.json —— **本模块不重算，只整形状**。"}


def reproducibility() -> dict:
    """★ 第三个数缺的那一问：**重跑能不能得到一样的数。**

    `tools/lp_stability.py` 的实测（有则用，无则明说没有）。
    ★ 这一问不是洁癖：法务表第二层问的是「工具能否**稳定**获取并处理」，
      「稳定」两个字必须由某一个数字来回答。没有它，
      100% 与 0.996 会被读成「这个数明天还是这个数」。
    """
    p = LAND / "_evidence" / "stability.json"
    if not p.exists():
        return {"$status": "cannot_measure",
                "$why": ("还没测。跑 `python3 tools/lp_stability.py`（联网，全局 6s 间隔）。"
                         "**在测出来之前，本档的 100% 与 0.996 都只对快照日成立，"
                         "而这一条必须写在数字旁边，不能留在别处。**"),
                "$已知的一条": ("V4 抽检 3 个 URL 时，**1 个的提取后正文指纹变了** —— "
                                "变化点是评论数 `1,835` → `1,836`（B2 实测，见 ADR-0013 §十三）。")}
    d = json.loads(p.read_text(encoding="utf-8"))
    return {
        "实测时间": d.get("measured_at"), "快照": d.get("snapshot"),
        "重抓": {"取": d["样本"]["取"], "可判": d["样本"]["可判"],
                 "失败": d["样本"]["重抓失败"], "全局间隔秒": d.get("global_gap_s")},
        "原始 HTML sha256 一致": d.get("原始 HTML sha256 一致"),
        "提取后正文 sha256 一致": d.get("提取后正文 sha256 一致"),
        "正文可复现率_pct": d.get("正文可复现率_pct"),
        "变化归因": d.get("变化归因"),
        "静态暴露面": d.get("静态暴露面"),
        "$读法": d.get("$这一组数的读法"),
    }


# ================================================================== 合表

def carrier_table(timing: bool = False) -> dict:
    """三档合表：**文字（两组）· 图片 · 视频**。ADR-0013 D3 要的正是这三类。

    ★ 文字**必须分两行**。A 组的失败原因是「字段本来就没有」，
      B 组的失败原因是「站点不给你」—— 处置完全不同，混成一个数就没法派活。
    """
    ads = stage_ads(timing=timing)
    land = stage_landing()
    img_rows = M.load_rows()
    img = M.measure(img_rows) if img_rows else {"$status": "no_sample"}
    vid = M.video_stage()

    def row(name, st):
        if st.get("$status"):
            return {"载体": name, "三个数字": None, "$status": st["$status"]}
        a, r, t = st["一_内容获取成功率"], st["二_识别完整度"], st["三_处理耗时"]
        return {
            "载体": name,
            "获取成功率": "%s%% (%s/%s)" % (a["值"], a["分子"], a["分母"]),
            "识别完整度": r.get("值"),
            "处理耗时": _pick_p50(t),
            "$边界": (r.get("$边界") or "").split("。")[0][:60],
        }

    return {
        "contract_version": CONTRACT_VERSION,
        "AD": "0013 D3 —— 打样覆盖文字、图片、视频三类",
        "文字(两组)": {
            "A · 广告文案": row("A · 广告文案", ads),
            "B · 落地页 HTML": row("B · 落地页 HTML", land),
            "$为什么分两行": ("两组的「获取」根本不是同一件事：A 是把内部表读成 unit，"
                              "B 是从站点抓回来。**失败原因与处置都不同，混读会掩盖两边的真问题。**"),
        },
        "图片": row("图片（落地页素材 OCR）", img) if not img.get("$status")
                else {"载体": "图片", "三个数字": None, "$status": img.get("$status")},
        "视频": row("视频", vid),
        "$note": ("★ **ADR-0013 D3 要的三类里，文字与图片都有数字了，视频没有。**"
                  "视频那一格写的是 `cannot_measure` 与原因，不是一个 0 —— "
                  "0 会被读成「测了，是零」。\n"
                  "★ 文字**占两行**：A 与 B 的「获取」不是同一件事，失败原因与处置都不同。"),
    }


def _pick_p50(t: dict) -> dict:
    out = {}
    for k, v in (t or {}).items():
        if k.startswith("$") or not isinstance(v, dict):
            continue
        if v.get("p50") is not None:
            out[k] = "%s p50=%sms" % (k, v["p50"])
    return out


# ================================================================== 自证

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
    print("B2 自证 · 文本档两组的三指标（%s）" % CONTRACT_VERSION)
    print("=" * 78)

    print("\n[1] A 组：分母是全部记录，空文案必须逐条在案")
    ads = stage_ads()
    a, r = ads["一_内容获取成功率"], ads["二_识别完整度"]
    check("A 组分母 = 记录总数 %d" % ads["样本"]["总数"],
          a["分母"] == ads["样本"]["总数"],
          "★ 分母写成「有正文的条数」会让成功率恒为 100%")
    check("空文案的数量 = 总数 − 有正文数", a["失败档"] and
          sum(a["失败档"].values()) == ads["样本"]["正文为空"],
          "空 %d 条：%s" % (ads["样本"]["正文为空"], a["失败档"]))
    check("报出来的不是「表读得动」那个 100%", a["值"] < 100.0,
          "值=%s%%（跳② = %s%%）" % (a["值"], a["跳②_存量表到unit"]["值"]))
    check("跳① 不可测被显式写成 cannot_measure（不是省略）",
          a["跳①_平台到存量表"]["值"] is None
          and a["跳①_平台到存量表"]["$status"] == "cannot_measure")
    check("空文案的原因说清了「不是抓取失败」", "不是「抓取失败」" in a["$失败档说什么"])

    print("\n[2] A 组：三段剖面的断崖位置必须由记录**重算**出来，不抄文档")
    prof = r["三段剖面"]
    check("五个段都在", all(k in prof for k in ("采集段", "维度段", "正文段", "分析段", "治理段")))
    check("治理段零填充字段非空（断崖的位置就是它）",
          prof["治理段"]["零填充字段"] == ["检查人"],
          str(prof["治理段"]["零填充字段"]))
    check("采集段区间下界 ≥ 正文段区间上界 —— 阶梯单调，断崖在中间",
          prof["采集段"]["区间"][0] >= prof["正文段"]["区间"][1],
          "采集 %s vs 正文 %s" % (prof["采集段"]["区间"], prof["正文段"]["区间"]))
    try:
        fake = _profile_sections({"检查人": {"达成": 291, "分母": 291, "覆盖率_pct": 100.0},
                                  "广告名称": {"达成": 291, "分母": 291, "覆盖率_pct": 100.0}},
                                 291)
        check("必红：把检查人填满 → 治理段零填充字段应为空（判据真的在判）",
              fake["治理段"]["零填充字段"] == [],
              "★ 一条永远为真的检查等于没有检查")
    except Exception as e:                                     # noqa: BLE001
        check("必红：把检查人填满 → 治理段零填充字段应为空", False, str(e)[:80])

    print("\n[3] B 组：读数不重算 —— 值必须与 lp_metrics.py 的制品逐字相等")
    land = stage_landing()
    if land.get("$status"):
        check("B 组可读", False, land.get("$why", "")[:100])
    else:
        m = json.loads((LAND / "指标.json").read_text(encoding="utf-8"))
        check("获取成功率取自制品，不是重算",
              land["一_内容获取成功率"]["值"] == m["指标1_内容获取成功率"]["成功率_pct"],
              str(land["一_内容获取成功率"]["值"]))
        check("★ 100% 与首轮成功率成对出现（这一条是这一档的全部意义）",
              land["一_内容获取成功率"]["成对读数"]["首轮"]["成功_pct"] < 100.0,
              "首轮 %s%%" % land["一_内容获取成功率"]["成对读数"]["首轮"]["成功_pct"])
        check("成对读数写了「唯一变量是节流策略」",
              "唯一变量是节流策略" in land["一_内容获取成功率"]["成对读数"]["$为什么必须成对"])
        check("识别完整度带边界（六类要素的达成是结构性判据）",
              "结构性的" in (land["二_识别完整度"]["$边界"] or ""))

    print("\n[4] 第三个数必须带复现性 —— 没有就写「没有」")
    rp = reproducibility()
    if rp.get("$status") == "cannot_measure":
        check("未测时显式 cannot_measure，且带一句已知事实",
              bool(rp["$why"]) and bool(rp["$已知的一条"]),
              "★ 静默省略会让 100% 被读成「明天还是 100%」")
    else:
        check("实测：正文可复现率有数、且归因到具体形态",
              rp["正文可复现率_pct"] is not None,
              "可复现 %s%% / %s 个" % (rp["正文可复现率_pct"], rp["重抓"]["可判"]))
        check("静态暴露面与实测率分列（两个数不许互相冒充）",
              rp["静态暴露面"]["分母"] == 92 and rp["重抓"]["可判"] <= rp["重抓"]["取"],
              "暴露面分母 %s vs 实测分母 %s" % (rp["静态暴露面"]["分母"], rp["重抓"]["可判"]))

    print("\n[5] 合表：三档两类有数字、视频如实说没有")
    t = carrier_table()
    check("文字分两行（A/B 不合并成一个「文字类」）",
          "A · 广告文案" in t["文字(两组)"] and "B · 落地页 HTML" in t["文字(两组)"])
    check("A 与 B 的获取成功率不相等 —— 它们本来就不是同一件事",
          t["文字(两组)"]["A · 广告文案"]["获取成功率"]
          != t["文字(两组)"]["B · 落地页 HTML"]["获取成功率"],
          "%s vs %s" % (t["文字(两组)"]["A · 广告文案"]["获取成功率"],
                        t["文字(两组)"]["B · 落地页 HTML"]["获取成功率"]))
    check("视频档是 cannot_measure，不是 0",
          t["视频"]["三个数字"] is None and t["视频"]["$status"] == "cannot_measure")

    print("\n" + "=" * 78)
    if fails:
        print("✗ B2 自证未通过：%d 项" % len(fails))
        for f in fails:
            print("   - " + f)
    else:
        print("✓ B2 自证全绿：两组文本各有三个数 · 空文案不进垃圾桶 · 复现性有数或明说没有")
    print("=" * 78)
    return fails


# ================================================================== 命令

def cmd_report(do_timing: bool) -> int:
    ads = stage_ads(timing=do_timing)
    land = stage_landing()

    def three(st, title):
        print("\n" + "─" * 78)
        print(title)
        print("─" * 78)
        a, r, tt = st["一_内容获取成功率"], st["二_识别完整度"], st["三_处理耗时"]
        print("\n【一】%s  %s%%  (%s/%s)" % (a["指标"], a["值"], a["分子"], a["分母"]))
        print("      " + (a.get("$分母口径") or "").replace("\n", "\n      "))
        if a.get("成对读数"):
            w = a["成对读数"]["首轮"]
            print("      ★ 成对读数：首轮 %s%%（%s/%s，全局间隔 %ss） → 终值 %s%%" % (
                w["成功_pct"], w["成功"], w["尝试"], w["全局间隔秒"], a["值"]))
        if a.get("失败档"):
            print("      失败档：%s" % a["失败档"])
        print("\n【二】%s  %s   (分母 %s)" % (r["指标"], r["值"], r["分母"]))
        for k, v in (r.get("逐字段") or {}).items():
            if v.get("覆盖率_pct") is not None and v["覆盖率_pct"] < 100.0:
                print("      %-22s %4d/%-4d %5.1f%%" % (k, v["达成"], v["分母"],
                                                        v["覆盖率_pct"]))
        if r.get("三段剖面"):
            print("      三段剖面：")
            for k, v in r["三段剖面"].items():
                if k.startswith("$"):
                    continue
                print("        %-6s %d 字段  区间 %s  零填充 %s" % (
                    k, v["字段数"], v["区间"], v["零填充字段"]))
        print("\n【三】%s（毫秒）" % tt["指标"])
        for k, v in tt.items():
            if k.startswith("$") or not isinstance(v, dict) or v.get("p50") is None:
                continue
            print("      %-22s p50=%-6s p90=%-6s max=%-8s n=%s" % (
                k, v["p50"], v.get("p90"), v.get("max"), v.get("n")))
        print("      " + (tt.get("$口径") or ""))

    print("=" * 78)
    print("B2 · 文本档两组的三指标（法务验证表第二层口径）")
    print("=" * 78)
    three(ads, "【A 组】广告文案   来源：存量记录表 · 分母 %d 条记录" % ads["样本"]["总数"])
    if land.get("$status"):
        print("\n【B 组】" + land["$why"])
    else:
        three(land, "【B 组】落地页 HTML   来源：批次 C 抓取 · 分母 92 个 URL")

    rp = land.get("三之补_复现性") if not land.get("$status") else reproducibility()
    print("\n" + "─" * 78)
    print("【三之补】复现性 —— 第三个数缺的那一问（重跑能不能得到一样的数）")
    print("─" * 78)
    if rp.get("$status") == "cannot_measure":
        print("  **没有数字。** " + rp["$why"])
        print("  已知的一条：" + rp["$已知的一条"])
    else:
        print("  重抓 %d 个（可判 %d，失败 %d，全局间隔 %ss）  实测于 %s" % (
            rp["重抓"]["取"], rp["重抓"]["可判"], rp["重抓"]["失败"],
            rp["重抓"]["全局间隔秒"], rp["实测时间"]))
        print("  原始 HTML sha256 一致 %s · **提取后正文 sha256 一致 %s → 可复现率 %s%%**" % (
            rp["原始 HTML sha256 一致"], rp["提取后正文 sha256 一致"],
            rp["正文可复现率_pct"]))
        if rp.get("变化归因"):
            print("  变化归因：%s" % rp["变化归因"])
        e = rp.get("静态暴露面") or {}
        print("  静态暴露面（另一件事）：92 页里含波动片段 %s 页 = %s%%  逐形态 %s" % (
            e.get("含波动片段的页面"), e.get("占比_pct"), e.get("逐形态")))
        print("  " + (rp.get("$读法") or "").replace("\n", "\n  "))

    print("\n" + "=" * 78)
    print("【合表】ADR-0013 D3 —— 文字 / 图片 / 视频")
    print("=" * 78)
    t = carrier_table()
    for grp in ("文字(两组)", "图片", "视频"):
        v = t[grp]
        if grp == "文字(两组)":
            for k in ("A · 广告文案", "B · 落地页 HTML"):
                print("  %-22s 获取 %-16s 完整度 %-7s 耗时 %s" % (
                    k, v[k]["获取成功率"], v[k]["识别完整度"],
                    list(v[k]["处理耗时"].values())[:1]))
        elif v.get("$status") and v.get("三个数字", "x") is None:
            print("  %-22s **%s** —— 不是 0" % (v["载体"], v["$status"]))
        else:
            print("  %-22s 获取 %-16s 完整度 %-7s" % (
                v["载体"], v["获取成功率"], v["识别完整度"]))
    print("\n" + t["$note"])
    print("=" * 78)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="文本档两组的三指标（B2）")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--selftest", action="store_true")
    g.add_argument("--report", action="store_true")
    g.add_argument("--timing", action="store_true", help="报告 + 实测判定耗时")
    a = ap.parse_args()
    if a.selftest:
        return 1 if selftest() else 0
    return cmd_report(a.timing)


if __name__ == "__main__":
    sys.exit(main())

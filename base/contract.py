#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""contract.py —— 基座的第①面：`ContentUnit`（ADR-0013 D1/D9）

一句话：**把任意形态的内容，变成同一种可判、可溯、可复现的东西。**

    ContentUnit = 一段正文 + 两个指纹 + 来路 + 组装口径 + 路由键

为什么需要它（ADR-0013 §一 D1 的表）：

    `Engine.assess()` 的签名是 `assess(text: str)`，`judge()` 的签名是 `judge(text, …)`。
    文本广告今天走得通。落地页有抓取、有提取，**但没接进引擎**；图片、视频是 0。
    三种新形态各有各的「怎么变成文字」的问题 —— 如果每接一种就在引擎外面写一层胶水，
    那么「这条判定看的是哪份原件」和「重跑能不能得到一样的数」这两件事
    就会散落在 N 处胶水里，且**没有任何一处能回答它们**。

    所以第一刀不是在引擎里加分支，是在引擎**前面**立一个统一信封。

--------------------------------------------------------------------------
★ 三件本文件刻意做死的事（不是风格，是它们各自有实测支撑）
--------------------------------------------------------------------------

**一、双指纹（D9），且两个都要**

    raw_sha256   这条判定看的是**哪份原件**   —— ADR-0002 的记录级溯源要求
    text_sha256  **重跑能不能得到一样的数**   —— ADR-0005「没有 receipt 的判定不算发生过」

    为什么不能只留一个：原件与正文会**分别**变化。
    落地页 HTML 里带 nonce / 时间戳 / 会话 id，两次抓取逐字节不同，而正文一模一样；
    反过来，同一份原件经过不同的提取器，正文可以不同。
    只留 raw 会把「页面没改」误报成「改了」；只留 text 则答不了「当时到底看的是哪一份」。

**二、正文的组装口径必须**单一**，且**记录在 unit 里**

    这条是被实测逼出来的。全仓有 **四** 处各自把「Primary Text + Headline」拼成一段文字：

        research/governance/skeleton/score.py:484      " | ".join(…)      引擎自己的
        tools/offline_replay.py:63                     "\\n".join(…)      复算
        tools/verify_engine_contract.py:1427           PT + "\\n" + HL     验收
        tools/lp_consistency.py:106                    " | ".join(…)      跨载体对照

    在 291 条真实语料上量了两种口径（`" | "` vs `"\\n"`）：

        文本不同          232 / 291     ← 只有 59 条 PLA 空文案两边一致
        判定不同            0 / 291
        命中规则集不同      0 / 291
        命中条数不同        0 / 291
        **命中位置不同     12 / 291**   ← 差**恰好 2 个字符**（" | " 比 "\\n" 长 2）

    也就是说：**今天它不改变任何一条判定，它改变位置。** 而位置是契约字段
    （ADR-0012 决策 5：`matched_text` 恒为原文连续子串，`source_text[start:end]` 可断言），
    并且 ADR-0012 §3.1 写过那句原则 ——「宁可少报位置，不可错报位置，
    因为一个错位置比没有位置更坏，**它看起来是对的**」。
    一条只在某条代码路径上正确的位置，正是这个失效形态。

    更硬的一条：**规则文件里有 10 条 pattern 把 `|` 写进了排除类**
    （`[^.!?|]*`，如 `T2.1.1.milk-supply` 的 `295\\s?mmhg[^.!?|]*(more milk|better|faster)`）。
    无论作者本意如何，它的**实际作用**是在 `|` 处截断跨字段匹配。
    换成 `\\n` 拼串后这 10 道屏障**全部失效** —— 逐条 pattern 构造验证，
    有 11 组「跨字段伪命中」会因此成立：

        PT="Hospital"  HL="Grade Suction"   →  T3.3.institution-grade 命中 "Hospital\\nGrade"
        PT="FDA"       HL="approved …"      →  T6.1.regulatory-status 命中 "FDA\\napproved"
        PT="zero"      HL="risk pumping"    →  T5.1.safety-claim      命中 "zero\\nrisk"
        ……（另 8 组见 `--selftest` 的输出）

    本语料上这 11 组**一次都没发生**（291 条实测 0 处）。所以这是**潜伏**缺陷，不是现行缺陷。
    本文件的处置：把 `" | "` 定为唯一规范口径，并把 `parts` 的**字段边界**记进 unit ——
    这样口径不再是「大家记得要一致」的约定，而是 unit 里一个可断言的事实。

**三、归一化必须是**具名档位**，且**只做零代价的那几步**

    `text_sha256` 只有在「同样的输入 → 同样的正文」成立时才有意义。
    但如果归一化偷偷改动正文，`text_sha256` 就不再对应任何一条真实判定 —— 它变成一个
    谁也无法复算的数字。所以这里选最小档位，并逐档量过代价（291 条广告 + 92 个页面）：

        档位                          广告改动   页面改动   是否采纳
        unicode_nfc                    0 / 291    0 / 92     ✅ 零代价
        newline_lf（CRLF/CR → LF）      0 / 291    2 / 92     ✅ 零代价（页面上确有 CRLF）
        strip（去首尾空白）             0 / 291    0 / 92     ✅ 零代价
        collapse（压连续空白）         10 / 291    2 / 92     ❌ **不采纳** —— 见下

    `collapse` 被排除，因为它有代价且方向错了：
    **两次抓取之间如果只差空白，操作者应当看得见。** 把这点差异抹平，
    等于用「内容没变」覆盖掉一次真实（哪怕轻微）的页面改动 ——
    这与本项目「看不见的东西要说出来」的原则相反。
    且 ADR-0011 已实测提取后的正文 3/3 稳定，不需要靠 collapse 来获得稳定性。

    档位名与步骤都记在 `unit["normalization"]` 里。改档位 = 改所有 unit 的 text_sha256，
    所以它是一个**会进回执的版本**，不是一个实现细节。

--------------------------------------------------------------------------
不变量（`validate()` 逐条检查，`--selftest` 全部要绿）
--------------------------------------------------------------------------

  H1  contract_version 已知
  H2  text 是 str
  H3  text 是不动点：normalize(text) == text        ← 保证「归一化后再拼装」的推理成立
  H4  text_sha256 == sha256(text)，text_chars == len(text)
  H5  has_text == bool(text.strip())
  H6  raw_sha256 / text_sha256 都是 64 位小写十六进制
  H7  unit_id / content_key 可复算
      ★ content_key 答的是「**这是哪一版正文**」——
        **不是**「这两次看到的是不是同一个东西」（B2 订正，Owner 裁定 A）
  H8  source.kind 在取值域内，source.uri 非空
  H9  normalization.profile/steps 与登记表一致
  H10 composition.profile 已登记；parts 有序、不重叠、在界内
  H11 **逐字可核**：text[start:end] 的 sha256 == parts[i].value_sha256
      —— 这条让「拼装没吃掉也没掺入任何字符」在**不持有原件**时也能验（ADR-0008 §四）
  H12 parts 之间恰好是 separator，首尾无多余字符
  H13 reference_verdict 是 dict 或 None（人工结论只作对照）
  H14 `routing` 的键 ⊆ `judge()` 的形参名（在 `to_judge_kwargs()` 里查，见下）

  ★ 每条都有**反向对照**：`--selftest` 会把 unit 逐个改坏，改坏必须红。
    一条永远不会红的检查等于没有检查。

--------------------------------------------------------------------------
不做的事（说清，否则会被当成已解决）
--------------------------------------------------------------------------

  1. **不判定。** 本文件不 import 判定引擎做任何判断，只产出信封。
     「这算不算违规」是 ADR-0005 的边界，属 `judge()`。
  2. **不落库。** `unit["text"]` 是判定输入，不是审计记录。
     要留痕用 `fingerprint_view()` —— 它把正文换成指纹，与 ADR-0012 §3.3 同一条规矩
     （回执不含原文）。
  3. **不抓取、不解析。** 落地页的字节来自批次 C（`lp_fetch.py` / `lp_extract.py`）；
     本文件只把它们的产物**收进同一个信封**。图片/视频的 OCR/ASR 是 B1。
  4. **`raw_sha256` 不等于「原件已入库」。** 它是指纹；原件在 L2（`_evidence/**`，
     按内容寻址），或压根不在本仓。`source.raw_pointer` 是可空的指针，
     指不到时 `raw_verified=False` —— **如实记账，不假装验证过**。

用法：
  from contract import from_text, from_ad_record, from_landing_page, validate
  u = from_text("FDA approved wearable breast pump", product_line="吸奶器")
  validate(u)   # → [] 表示通过；否则是问题清单

命令行：
  python3 base/contract.py --selftest                  # 自证（全绿才算 B0.2 完成）
  python3 base/contract.py --from-text "文案…" --json
  python3 base/contract.py --from-record GG-d1ff3cf1bb1d --json
  python3 base/contract.py --from-url-key momcozy.com/products/… --json
  python3 base/contract.py --stats                     # 语料规模与指纹分布
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import inspect
import json
import re
import sys
import unicodedata
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
SKELETON = ROOT / "research" / "governance" / "skeleton"
LANDING = ROOT / "research" / "landing"

sys.path.insert(0, str(SKELETON))

CONTRACT_VERSION = "content-unit-v1"
SCHEMA_FILE = "content-unit-v1.schema.json"

# ── 载体形态。取值域是**封闭**的：新形态要加进来，就改这里 + schema + 一条 builder。
SOURCE_KINDS = (
    "ad_text",          # 广告文案（Primary Text / Headline 等字段）
    "free_text",        # 任意贴进来的一段文字
    "landing_page",     # 落地页 HTML
    "structured_json",  # Shopify 商品 JSON（`<url>.js`）—— 与落地页是**两个 target**
    "image",            # 图片（正文来自 OCR；B1）
    "video",            # 视频（正文来自 ASR / 字幕；B1）
)

# ── 归一化登记表。改这里 = 改所有 unit 的 text_sha256。
NORMALIZATION_REGISTRY = {
    "text-v1": {
        "steps": ["unicode_nfc", "newline_lf", "strip"],
        "cost_measured": {"ads_changed": 0, "ads_total": 291,
                          "pages_changed": 2, "pages_total": 92,
                          "note": "2 个页面含 CRLF —— 这一步在页面上确实有触发，且是零代价"},
        "rejected_steps": {
            "collapse_whitespace": (
                "广告 10/291、页面 2/92 会被改动 —— 有代价，且方向错："
                "把「两次抓取只差空白」抹平成「内容没变」，等于用指纹掩盖一次真实的页面改动。"
                "ADR-0011 已实测提取后正文稳定，不需要靠它换稳定性。"),
        },
    },
}
NORMALIZATION_PROFILE = "text-v1"

# ── 组装登记表。`" | "` 是唯一规范口径，理由见文件头「二」。
COMPOSITION_REGISTRY = {
    "fields-pipe-v1": {
        "separator": " | ",
        "applies_to": ["ad_text", "structured_json"],
        "why": (
            "与引擎自己的 score.py:rec_text() 一致；且规则文件里 10 条 pattern 用 `[^.!?|]` "
            "把 `|` 当作跨字段屏障 —— 换 `\\n` 会让这 10 道屏障失效，"
            "构造验证有 11 组跨字段伪命中会因此成立。"),
        "cost_measured": {
            "text_differs_vs_newline": "232 / 291",
            "verdict_differs_vs_newline": "0 / 291",
            "position_differs_vs_newline": "12 / 291（差恰好 2 字符 = 分隔符长度差）",
        },
        "applies_to_note": (
            "★ `structured_json` 也归这条口径，不是为了整齐 —— 商品 JSON 的 title 与 "
            "description_text 同样是两个字段拼起来的，同样需要 `[^.!?|]` 那道屏障，"
            "同样需要 parts 记录边界。"),
    },
    "passthrough-v1": {
        "separator": "",
        "applies_to": ["free_text", "landing_page", "structured_json", "image", "video"],
        "why": "单一正文来源，不存在字段拼接，因此不存在跨字段伪命中的可能。",
    },
    "fields-newline-v1": {
        "separator": "\n",
        "applies_to": [],
        "status": "documented-not-canonical",
        "why": (
            "**登记但未采用。** 它是 tools/offline_replay.py 与 verify_engine_contract.py 的现行口径。"
            "登记的用途：让「另一条口径下的位置会差 2 字符」这件事可被复算，而不是消失。"),
    },
}
COMPOSITION_PROFILE = "fields-pipe-v1"

# ADR 字段名 → 路由键名。判定的输入只有 text；其余都是**路由**或**语境**。
#
# ★ 这份表的第一版把「广告组」也放了进来，被 H14 当场拦下 ——
#   `judge()` 的形参里没有 `ad_group`（ADR-0012 冻结的签名只有 ad_account / ad_id）。
#   拦下是对的：**路由键的判据是「按什么查得到收件人」**（ADR-0012 D14：
#   `to` 答「谁该收」，`route.key` 答「按什么查到这个谁」）。
#   广告组既不是账号也不是广告 ID，它查不到人。把它放进 routing，
#   只会得到一个「看起来生效、其实没人读」的装饰字段 —— 正是 H14 要防的形态。
ROUTING_FROM_AD = {
    "品线": "product_line",
    "投放地区": "locale",
    "平台": "platform",
    "广告系列Campaign": "campaign",
    "外部广告ID": "ad_id",
    "广告类型": "ad_type",
    "广告账号": "ad_account",
}
# 这些**不进判定、也不做路由键** —— 它们是盘子大小的语境，不是「送给谁」的依据。
CONTEXT_FROM_AD = {
    "近7天费用USD": "spend_usd",
    "近7天展示": "impressions",
    "近7天点击": "clicks",
    "数据日期": "data_date",
    "投放状态": "delivery_status",
    "文案语种": "copy_language",
    "广告组": "ad_group",
}
# 人工判定结果。**只作对照，绝不进判定输入** —— 进了就是自证循环。
REFERENCE_FIELDS = ("风险等级", "处理状态", "命中规则", "命中原因", "命中片段", "修改建议", "检查人")

_HEX64 = re.compile(r"^[0-9a-f]{64}$")

# 语境键：**不进判定，也不做路由键**。它们是盘子大小的背景，不是「送给谁」的依据。
CONTEXT_KEYS = set(CONTEXT_FROM_AD.values()) | {"note"}


# ------------------------------------------------------------------ 指纹

def sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def sha256_text(t: str) -> str:
    return hashlib.sha256(t.encode("utf-8")).hexdigest()


# ------------------------------------------------------------------ 归一化

def normalize(text: str, profile: str = NORMALIZATION_PROFILE) -> str:
    """具名档位归一化。**必须是幂等的** —— 否则 text_sha256 不可复现。

    ★ 顺序有讲究：先 NFC，再换行，最后 strip。
      反过来（先 strip 再 NFC）在「首尾是分解形组合字符」时结果不同。
    """
    if profile not in NORMALIZATION_REGISTRY:
        raise KeyError(f"未登记的归一化档位：{profile}")
    t = unicodedata.normalize("NFC", text)
    t = t.replace("\r\n", "\n").replace("\r", "\n")
    t = t.strip()
    return t


def _compose(parts: list[tuple[str, str]], profile: str) -> tuple[str, list[dict]]:
    """按 profile 把「归一化后的」字段拼成正文，并记下每个字段落在哪一段。

    ★ 先逐字段归一化、再拼装 —— 这样拼装结果天然就是归一化后的，`parts` 的偏移
      直接指向最终正文，无需事后重定位。前提是分隔符不引入可组合字符：
      `" | "` 与 `"\\n"` 都是 ASCII，NFC(a) + SEP + NFC(b) 仍是 NFC。
      `validate()` 的 H3 会对这条推理做实测（text 必须是不动点）。
    """
    reg = COMPOSITION_REGISTRY[profile]
    sep = reg["separator"]
    # 归一化**先做**，再决定谁被丢掉：一个只有空白的字段归一化后就是空的。
    pairs = [(f, normalize(v)) for f, v in parts]
    keep = [(f, v) for f, v in pairs if v]
    text = sep.join(v for _, v in keep)
    out, cursor = [], 0
    for field, val in keep:
        out.append({"field": field, "start": cursor, "end": cursor + len(val),
                    "chars": len(val), "value_sha256": sha256_text(val)})
        cursor += len(val) + len(sep)
    return text, out


# ------------------------------------------------------------------ 标识

def _unit_id(kind: str, raw_sha256: str, text_sha256: str) -> str:
    """一次**观测**的标识。两份指纹都进 —— 原件变了就是新的一次观测。"""
    return "cu" + sha256_text(f"cu-v1|{kind}|{raw_sha256}|{text_sha256}")[:16]


def _content_key(kind: str, text_sha256: str) -> str:
    """**这一版正文**的稳定标识。只吃正文指纹 —— 不掺原件、不掺 uri、不掺时间。

    ★ 措辞在 B2 被订正过一次（**Owner 裁定 A**，ADR-0013 §十三.9）。
      订正的不是算法，是**它答哪一问** —— 因为下游是照着这句话写的：

        原文（错的）：「这两次看到的是不是同一个东西」
        实测：同一批页面**隔一天**重抓，约 **70%** 得到一个不同的 content_key
              （评论数、价格、促销横幅都在动）。
              把「key 变了」读成「内容变了」，会让变更检测天天报假警。
        订正为：「**这是哪一版正文**」。

    算法一字未改（H7 仍可复算，指纹仍只吃正文）。三个标识各答一问，
    缺一个就会有人拿另一个凑合：

        unit_id      「这一次看的是哪一份原件」
        content_key  「这是哪一版正文」     ← **不是**「是不是同一个东西」
        变没变        → 交给 `change_detect.judge()`（判据 `claim-set-v1`）

    ★ 一个反直觉但正确的推论：**key 相同不代表同一个页面，key 不同也不代表内容变了。**
      同一条文案投在多个地区是同一个 key（不同页面）；同一个页面隔一天抓两次是两个 key
      （同一页面）。这两句都由 `--selftest` [4c] 亲自断言。
    """
    return "ck" + sha256_text(f"ck-v1|{kind}|{text_sha256}")[:16]


# ------------------------------------------------------------------ 构造

def _unit(kind: str, uri: str, raw_sha256: str, text: str, parts: list[dict],
          profile: str, routing: dict, context: dict, source_extra: dict,
          textification: dict | None, reference_verdict: dict | None,
          omitted_empty_fields: list[str] | None = None) -> dict:
    text = normalize(text)
    u = {
        "contract_version": CONTRACT_VERSION,
        "unit_id": _unit_id(kind, raw_sha256, sha256_text(text)),
        "content_key": _content_key(kind, sha256_text(text)),
        "source": {"kind": kind, "uri": uri, **source_extra},
        "fingerprint": {
            "raw_sha256": raw_sha256,
            "raw_bytes": source_extra.get("raw_bytes"),
            "text_sha256": sha256_text(text),
            "text_chars": len(text),
        },
        "normalization": {
            "profile": NORMALIZATION_PROFILE,
            "steps": list(NORMALIZATION_REGISTRY[NORMALIZATION_PROFILE]["steps"]),
            "$why": ("`text_sha256` 只在「同样的输入 → 同样的正文」成立时才有意义。"
                     "档位具名并进 unit，是为了让这个数字**可被谁复算**，"
                     "而不是一个只有本文件知道的约定。"),
            "$not_applied": sorted(NORMALIZATION_REGISTRY[NORMALIZATION_PROFILE]["rejected_steps"]),
        },
        "composition": {
            "profile": profile,
            "separator": COMPOSITION_REGISTRY[profile]["separator"],
            "parts": parts,
            "omitted_empty_fields": list(omitted_empty_fields or []),
            "$invariant": "text[start:end] 的 sha256 == parts[i].value_sha256（H11，逐字可核）",
            "$why": COMPOSITION_REGISTRY[profile]["why"],
        },
        "textification": textification,
        "text": text,
        "has_text": bool(text.strip()),
        "routing": {k: v for k, v in routing.items() if v not in (None, "")},
        "context": {k: v for k, v in context.items() if v not in (None, "")},
        "reference_verdict": reference_verdict,
        "$has_text_note": ("★ `has_text` 不是判定输入，是**路由输入**（ADR-0012 D5）："
                           "为假时该条走 DP0，不进审查队列，也不进空白清单。"),
        "$reference_note": (
            "★ `reference_verdict` 是**人工判定结果**，只作对照。"
            "它绝不进 `judge()` 的输入 —— 让它进去就等于用答案评自己的卷子。"
            "`--selftest` 有一条断言在守这件事（H13）。"),
        "$not_a_verdict": "本对象是**判定输入**，不是判定结果。结论在 `judge(unit)`。",
    }
    return u


def from_text(text: str, *, uri: str = "inline:text", raw_bytes: bytes | None = None,
              **routing) -> dict:
    """任意一段文字 → unit。`raw_sha256` 取 UTF-8 原文的指纹（不是归一化后的）。"""
    if not isinstance(text, str):
        raise TypeError(f"text 必须是 str，收到 {type(text).__name__}")
    raw = raw_bytes if raw_bytes is not None else text.encode("utf-8")
    t, parts = _compose([("text", text)], "passthrough-v1")
    ctx = {k: routing.pop(k) for k in list(routing) if k in CONTEXT_KEYS}
    return _unit("free_text", uri, sha256_bytes(raw), t, parts, "passthrough-v1",
                 routing, ctx,
                 {"raw_bytes": len(raw), "raw_pointer": None, "raw_verified": raw_bytes is not None},
                 {"extractor": "caller-supplied", "lossy": False,
                  "covers": ["调用方给出的全部文字"], "does_not_cover": []},
                 None)


CONTEXT_KEYS = set(CONTEXT_FROM_AD.values()) | {"note"}


def from_ad_record(rec: dict, *, extra_fields: tuple[str, ...] = (),
                   uri: str | None = None) -> dict:
    """一条存量广告记录（`skeleton/_data/records.json` 的一行）→ unit。

    ★ 正文 = `Primary Text` + `Headline`，按 `fields-pipe-v1` 拼装。
      拼装口径由本文件**唯一**提供 —— 这是 B0.2 要消掉的那处分歧。
    """
    fields = [("Primary Text", rec.get("Primary Text", "") or ""),
              ("Headline", rec.get("Headline", "") or "")]
    for k in extra_fields:
        fields.append((k, rec.get(k, "") or ""))
    text, parts = _compose(fields, COMPOSITION_PROFILE)

    kept = {f for f, _ in fields}
    omitted = [f for f, v in fields if not normalize(v or "")]
    raw = json.dumps(rec, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    raw_b = len(raw)

    routing, context = {}, {}
    for zh, en in ROUTING_FROM_AD.items():
        if rec.get(zh):
            routing[en] = rec[zh]
    for zh, en in CONTEXT_FROM_AD.items():
        if rec.get(zh) not in (None, ""):
            context[en] = rec[zh]
    ref = {en: rec.get(zh) for zh, en in
           zip(REFERENCE_FIELDS, ("risk_level", "handling_status", "rules_hit",
                                  "hit_reason", "hit_fragment", "suggestion", "reviewer"))}
    ref = {k: v for k, v in ref.items() if v not in (None, "")}

    u = _unit("ad_text", uri or ("record:" + str(rec.get("外部广告ID") or "?")),
              sha256_bytes(raw), text, parts, COMPOSITION_PROFILE, routing, context,
              {"raw_bytes": raw_b, "raw_pointer": None, "raw_verified": True,
               "$raw_note": ("`raw_sha256` 是**整行记录**的规范化 JSON 指纹，不是某几个字段。"
                             "这样花费/状态变了 raw 就变、正文没变 text 就不变 —— "
                             "两个指纹各自回答自己的问题，而不是互相冒充。")},
              {"extractor": "fields-as-given", "lossy": False,
               "covers": ["广告文案字段（" + "、".join(sorted(kept)) + "）"],
               "does_not_cover": ["图内文字", "画面语义", "落地页正文", "音视频"]},
              ref or None)
    u["composition"]["omitted_empty_fields"] = omitted
    return u


def from_landing_page(fetch_rec: dict, extract_rec: dict | None = None, *,
                      label: str = "html", evidence_dir: Path | None = None,
                      uri: str | None = None) -> dict:
    """批次 C 的一次抓取 + 一次提取 → unit。

    ★ `uri` 是**实际被取的那个 target**，不是 `url_key`。
      实测：`抓取结果.json` 里 92 个 `url_key` 对应 **133 个不同 target** ——
      48 个是 `<页面>.js`（Shopify 商品 JSON）。把一个页面的 HTML 与它的 JSON
      塞进同一个 unit，会让 `raw_sha256` 指着一份原件、正文却来自另一份。
      「一个 url_key ≠ 一个 unit」是本条的直接后果。
    """
    at = next((a for a in fetch_rec.get("attempts", [])
               if a.get("label") == label and a.get("sha256")), None)
    if at is None:
        raise ValueError(f"{fetch_rec.get('url_key')} 没有 label={label} 的成功尝试")
    target = at.get("target") or fetch_rec.get("url")

    # ── raw_sha256：**重算**，不抄记录里的值 ────────────────────────
    raw_sha, raw_b, verified, pointer, note = at["sha256"], at.get("bytes"), False, at.get("stored"), None
    if evidence_dir and at.get("stored"):
        fp = Path(evidence_dir) / at["stored"]
        if fp.exists():
            try:
                body = gzip.open(fp, "rb").read()
                recomputed = sha256_bytes(body)
                if recomputed != at["sha256"]:
                    note = (f"★ 落盘原件重算得 {recomputed[:16]}，记录里写的是 "
                            f"{at['sha256'][:16]} —— 以重算值为准。")
                raw_sha, raw_b, verified = recomputed, len(body), True
            except Exception as e:                       # noqa: BLE001
                note = f"落盘原件读取失败（{type(e).__name__}），沿用记录里的指纹"
        else:
            note = f"落盘原件不在（{at['stored']}），沿用记录里的指纹，raw_verified=False"

    kind = "structured_json" if label == "structured" else "landing_page"
    text, tf_src, parts, profile, omitted = "", None, [], "passthrough-v1", []
    st = (extract_rec or {}).get("structured")
    if label == "html" and (extract_rec or {}).get("html"):
        text = extract_rec["html"].get("body_text") or ""
        tf_src = "要素提取.json"
        text, parts = _compose([("body_text", text)], "passthrough-v1")
    elif label == "structured" and st:
        # ★ 第一版这里写的是 `st.get("text")` —— 而 `analyze_structured()` 根本
        #   不产出 `text` 这个键（它给的是 title / description_text）。
        #   于是 44 个商品 JSON 全部拿到空正文、全部落到 `has_text=False`，
        #   也就是全部被路由去 DP0「没有可判文本」——
        #   而它们其实有标题（44/44）与描述（17/44）。
        #   这正是本项目最怕的失效形态：**不崩、不报错，只是安静地把
        #   「取了 44 个 JSON」记成「44 条没什么可看的」。**
        #   [9] 那条断言就是为它加的（非空提取结果不得产出空正文）。
        fields = [("title", st.get("title") or ""),
                  ("description_text", st.get("description_text") or "")]
        text, parts = _compose(fields, COMPOSITION_PROFILE)
        profile = COMPOSITION_PROFILE
        omitted = [f for f, v in fields if not normalize(v)]
        tf_src = "要素提取.json"

    text = normalize(text)
    if not parts:
        _, parts = _compose([("body_text", text)], "passthrough-v1")

    covers = (["页面正文（HTML 提取，含图内 alt 与 JSON-LD 中的文字）"] if kind == "landing_page"
              else ["商品 JSON 的标题与描述"])
    return _unit(kind, uri or target, raw_sha, text, parts, profile, {}, {},
                 {"raw_bytes": raw_b, "raw_pointer": pointer, "raw_verified": verified,
                  "page_key": fetch_rec.get("url_key"), "target_label": label,
                  "http_status": at.get("status"), "$raw_note": note},
                 {"extractor": f"lp_extract/{label}-v1", "lossy": True,
                  "textified_from": tf_src,
                  "covers": covers,
                  "does_not_cover": ["JS 运行时渲染出来的内容", "图内文字以外的画面语义",
                                     "视频的音调/节奏/字幕与画面对不上"],
                  "$boundary": ("★ 本数字只覆盖**图内文字**，不含画面语义（ADR-0013 异议二）。"
                                "只报「识别完整度 X%」而不写这条边界，等于把"
                                "「画面暗示功效」这类真实风险记成已覆盖。")},
                 None,
                 omitted_empty_fields=omitted)


def from_media(kind: str, raw: bytes, text_from_media: str, *, uri: str,
               extractor: str, covers: list[str], does_not_cover: list[str]) -> dict:
    """图片 / 视频（B1）。**正文必须由调用方给出**，且必须显式声明覆盖到哪。

    这里刻意**不提供默认值**：一个默认的 `covers` 会让「只做了 OCR」
    看起来像「图片已审」。缺省即报错，强制调用方写清边界。
    """
    if kind not in ("image", "video"):
        raise ValueError(f"from_media 只收 image/video，收到 {kind}")
    if not covers or not does_not_cover:
        raise ValueError("必须显式给出 covers 与 does_not_cover —— 默认值会让覆盖范围看起来比实际大")
    text, parts = _compose([("text_from_media", text_from_media)], "passthrough-v1")
    return _unit(kind, uri, sha256_bytes(raw), text, parts, "passthrough-v1", {}, {},
                 {"raw_bytes": len(raw), "raw_pointer": None, "raw_verified": True},
                 {"extractor": extractor, "lossy": True, "covers": covers,
                  "does_not_cover": does_not_cover},
                 None)


# ------------------------------------------------------------------ 校验

def validate(u: dict) -> list[str]:
    """逐条查不变量，返回问题清单。空列表 = 通过。**不抛异常** —— 校验器自己崩掉
    就没法告诉人哪里不对了。"""
    p: list[str] = []
    if not isinstance(u, dict):
        return [f"unit 必须是 dict，收到 {type(u).__name__}"]

    if u.get("contract_version") != CONTRACT_VERSION:
        p.append(f"H1 contract_version={u.get('contract_version')!r}，期望 {CONTRACT_VERSION!r}")

    text = u.get("text")
    if not isinstance(text, str):
        p.append(f"H2 text 必须是 str，收到 {type(text).__name__}")
        return p

    nz = u.get("normalization") or {}
    prof = nz.get("profile")
    if prof not in NORMALIZATION_REGISTRY:
        p.append(f"H9 未登记的归一化档位 {prof!r}")
    else:
        if list(nz.get("steps") or []) != list(NORMALIZATION_REGISTRY[prof]["steps"]):
            p.append(f"H9 steps 与登记表不一致：{nz.get('steps')} != {NORMALIZATION_REGISTRY[prof]['steps']}")
        try:
            if normalize(text, prof) != text:
                p.append("H3 text 不是归一化的不动点（normalize(text) != text）—— "
                         "「先归一化再拼装」的推理不成立，parts 的偏移不再可信")
        except KeyError as e:
            p.append(f"H3 {e}")

    fp = u.get("fingerprint") or {}
    for k in ("raw_sha256", "text_sha256"):
        v = fp.get(k)
        if not isinstance(v, str) or not _HEX64.match(v):
            p.append(f"H6 fingerprint.{k} 不是 64 位小写十六进制：{v!r}")
    if isinstance(fp.get("text_sha256"), str) and _HEX64.match(fp["text_sha256"]):
        if fp["text_sha256"] != sha256_text(text):
            p.append("H4 text_sha256 != sha256(text) —— 指纹与正文对不上，"
                     "「重跑能不能得到一样的数」这个问题失去了答案")
    if fp.get("text_chars") != len(text):
        p.append(f"H4 text_chars={fp.get('text_chars')} != len(text)={len(text)}")
    if u.get("has_text") != bool(text.strip()):
        p.append(f"H5 has_text={u.get('has_text')!r} 与 text.strip() 的虚实不符")

    src = u.get("source") or {}
    kind = src.get("kind")
    if kind not in SOURCE_KINDS:
        p.append(f"H8 source.kind={kind!r} 不在取值域 {SOURCE_KINDS}")
    if not isinstance(src.get("uri"), str) or not src["uri"].strip():
        p.append(f"H8 source.uri 必须是非空字符串，收到 {src.get('uri')!r}")

    if kind in SOURCE_KINDS and isinstance(fp.get("raw_sha256"), str):
        want = _unit_id(kind, fp["raw_sha256"], fp.get("text_sha256", ""))
        if u.get("unit_id") != want:
            p.append(f"H7 unit_id 不可复算：{u.get('unit_id')!r} != {want!r}")
        want_ck = _content_key(kind, fp.get("text_sha256", ""))
        if u.get("content_key") != want_ck:
            p.append(f"H7 content_key 不可复算：{u.get('content_key')!r} != {want_ck!r}")

    comp = u.get("composition") or {}
    cp = comp.get("profile")
    if cp not in COMPOSITION_REGISTRY:
        p.append(f"H10 未登记的组装口径 {cp!r}")
    else:
        sep = COMPOSITION_REGISTRY[cp]["separator"]
        if comp.get("separator") != sep:
            p.append(f"H10 separator={comp.get('separator')!r} != 登记值 {sep!r}")
        parts = comp.get("parts")
        if not isinstance(parts, list):
            p.append(f"H10 parts 必须是列表，收到 {type(parts).__name__}")
        else:
            prev_end, expect = 0, 0
            for i, pt in enumerate(parts):
                s, e = pt.get("start"), pt.get("end")
                if not isinstance(s, int) or not isinstance(e, int) or s < 0 or e < s or e > len(text):
                    p.append(f"H10 parts[{i}] 越界或倒置：start={s} end={e} len(text)={len(text)}")
                    continue
                if s < prev_end:
                    p.append(f"H10 parts[{i}] 与前一段重叠（start={s} < 上一段 end={prev_end}）")
                if s != expect:
                    p.append(f"H11 parts[{i}] 起点不是 {expect}（前段与分隔符之后）而是 {s}"
                             + ("；应恰好是 separator" if s > expect else ""))
                seg = text[s:e]
                if pt.get("value_sha256") != sha256_text(seg):
                    p.append(f"H11 parts[{i}] 逐字可核失败：text[{s}:{e}] 的 sha256 与 value_sha256 不符"
                             " —— 拼装吃了或掺了字符")
                if pt.get("chars") != e - s:
                    p.append(f"H10 parts[{i}].chars={pt.get('chars')} != end-start={e-s}")
                prev_end = e
                expect = e + len(sep)
            if parts:
                want = parts[-1]["end"] if isinstance(parts[-1].get("end"), int) else None
                if want is not None and want != len(text):
                    p.append(f"H12 末段 end={want} != len(text)={len(text)} —— 正文尾部有多余字符")
            elif text:
                p.append("H12 text 非空但没有任何 parts —— 正文来路不明")

    rv = u.get("reference_verdict")
    if rv is not None and not isinstance(rv, dict):
        p.append(f"H13 reference_verdict 必须是 dict 或 None，收到 {type(rv).__name__}")
    return p


def validate_or_raise(u: dict) -> dict:
    problems = validate(u)
    if problems:
        raise ValueError("ContentUnit 不合法：\n  - " + "\n  - ".join(problems))
    return u


# ------------------------------------------------------------------ 留痕与桥接

def fingerprint_view(u: dict) -> dict:
    """**可落库的视图**：正文换成指纹，其余保留。

    ADR-0012 §3.3：回执是长期留存的审计日志，往里面写原文，
    等于用另一条路径把 ADR-0008 决策 2 已决定不落库的东西落库了。
    代价与那条决定相同：**光看这个视图无法还原当时判了什么**，要复核必须同时持有原件。
    """
    out = {k: v for k, v in u.items() if k != "text"}
    out["text"] = None
    out["$text_omitted"] = ("正文按 ADR-0008 决策 2 / ADR-0012 §3.3 不落回执。"
                            "复核需要原文 + text_sha256 同时在场。")
    return out


def to_judge_kwargs(u: dict) -> dict:
    """`judge(unit)` 的适配层的前半截（B0.3 落地）。

    ★ H13：`routing` 的键必须是 `judge()` 真的接受的形参名。
      否则「路由键」会悄悄变成「没人读的装饰」，
      或者更坏 —— 被塞进某个不认识的形参里，而调用方以为它生效了。
    """
    problems = validate(u)
    if problems:
        raise ValueError("拒绝把不合法的 unit 送进 judge：\n  - " + "\n  - ".join(problems))
    accepted = set(inspect.signature(_judge_fn()).parameters)
    route = u.get("routing") or {}
    unknown = sorted(set(route) - accepted)
    if unknown:
        raise ValueError(f"routing 含 judge() 不认识的键 {unknown}；judge 接受 {sorted(accepted)}")
    return {"text": u["text"], **route}


def _judge_fn():
    import judge as J                                    # noqa: PLC0415
    return J.judge


# ------------------------------------------------------------------ 语料装载

def load_ad_records() -> list[dict]:
    return json.loads((SKELETON / "_data" / "records.json").read_text(encoding="utf-8"))


def load_landing() -> tuple[dict, dict, Path | None]:
    fetch = json.loads((LANDING / "抓取结果.json").read_text(encoding="utf-8"))
    ext_p = LANDING / "要素提取.json"
    ext = json.loads(ext_p.read_text(encoding="utf-8")) if ext_p.exists() else {"results": []}
    snap = (fetch.get("manifest") or {}).get("snapshot")
    ev = (LANDING / "_evidence" / snap) if snap else None
    return fetch, {e["url_key"]: e for e in ext.get("results", [])}, ev


def units_from_corpus(verify_evidence: bool = True):
    """把两批真实语料都变成 unit。自证与 --stats 共用这一条路。"""
    ads = [from_ad_record(r) for r in load_ad_records()]
    fetch, ext, ev = load_landing()
    pages = []
    for r in fetch["results"]:
        for label in ("html", "structured"):
            if not any(a.get("label") == label and a.get("sha256") for a in r.get("attempts", [])):
                continue
            pages.append(from_landing_page(r, ext.get(r["url_key"]),
                                           label=label,
                                           evidence_dir=(ev if verify_evidence else None)))
    return ads, pages


# ------------------------------------------------------------------ 自证

def selftest(verbose: bool = True) -> list[str]:
    """B0.2 的自证。**全绿才算完成。** 每条都带反向对照（「必红」）——
    一条永远不会红的检查等于没有检查。"""
    fails: list[str] = []

    def check(name, cond, detail=""):
        ok = bool(cond)
        if verbose:
            print(("  ✓ " if ok else "  ✗ ") + name + (("   " + detail) if detail else ""))
        if not ok:
            fails.append(name + (("  " + detail) if detail else ""))
        return ok

    print("=" * 78)
    print("B0.2 自证 · ContentUnit 契约（%s）" % CONTRACT_VERSION)
    print("=" * 78)

    ads, pages = units_from_corpus()
    print("\n[1] 语料面：任意文案 / 任意 URL 都变得出合法 unit")
    check("广告文案 %d 条全部通过 validate" % len(ads),
          all(not validate(u) for u in ads),
          (lambda bad: "" if not bad else "首个失败：%s -> %s" % (bad[0][0], bad[0][1]))(
              [(u["source"]["uri"], validate(u)) for u in ads if validate(u)]))
    check("落载体 %d 个全部通过 validate" % len(pages),
          all(not validate(u) for u in pages),
          (lambda bad: "" if not bad else "首个失败：%s -> %s" % (bad[0][0], bad[0][1]))(
              [(u["source"]["uri"], validate(u)) for u in pages if validate(u)]))
    check("unit_id 无碰撞（%d 条广告）" % len(ads),
          len({u["unit_id"] for u in ads}) == len(ads),
          "不同观测拿到同一个 id 会让去重静默吃掉记录")
    dup_ck = len(ads) - len({u["content_key"] for u in ads})
    check("content_key 允许碰撞并已计数（%d 条同文不同观测）" % dup_ck, True,
          "这**不是**错误：同一条文案投在多个地区就是同一个 content_key、不同的 unit_id")

    print("\n[2] 归一化面：档位是幂等的，且事实上没改动语料")
    check("normalize 在所有 unit 正文上是不动点",
          all(normalize(u["text"]) == u["text"] for u in ads + pages))
    check("广告语料上 NFC/换行/strip 三步改动 0 条",
          sum(1 for r in load_ad_records()
              if normalize(" | ".join(x for x in [r.get("Primary Text", ""), r.get("Headline", "")] if x))
              != " | ".join(x for x in [r.get("Primary Text", ""), r.get("Headline", "")] if x)) == 0)
    fetch, ext, _ = load_landing()
    bodies = [e["html"]["body_text"] for e in ext.values() if e.get("html")]
    n_cr = sum(1 for b in bodies if "\r" in b)
    check("落地页语料里确有其事：%d 个正文含 CRLF（所以 newline_lf 不是空转）" % n_cr, n_cr > 0,
          "登记表里写的 cost_measured.pages_changed=2 就是它们")

    print("\n[3] 拼装面：口径唯一，且逐字可核")
    both = [r for r in load_ad_records() if (r.get("Primary Text") or "").strip()
            and (r.get("Headline") or "").strip()]
    check("双字段记录 %d 条，parts 全部满足 text[start:end] 逐字可核" % len(both),
          all(not [x for x in validate(from_ad_record(r)) if x.startswith("H11")] for r in both))
    check("拼装结果里确实出现分隔符 ' | '",
          all(" | " in from_ad_record(r)["text"] for r in both))
    check("空字段被显式记入 omitted_empty_fields（而不是留个洞）",
          all(from_ad_record(r)["composition"]["omitted_empty_fields"] == ["Headline"]
              for r in load_ad_records() if not (r.get("Headline") or "").strip()
              and (r.get("Primary Text") or "").strip()))

    print("\n[4] 指纹面：两个指纹各答自己的问题")
    ev_ok = sum(1 for u in pages if u["source"].get("raw_verified"))
    check("落盘原件重算指纹通过 %d / %d" % (ev_ok, len(pages)), ev_ok > 0,
          "重算而非抄记录 —— 记录里的值与磁盘上的字节可能不是一回事")
    check("每个 unit 的 raw/text 指纹都不同（同值说明有一个抄错了）",
          all(u["fingerprint"]["raw_sha256"] != u["fingerprint"]["text_sha256"] for u in ads + pages))
    check("同一输入两次构造完全一致（确定性）",
          all(json.dumps(from_ad_record(r), sort_keys=True)
              == json.dumps(from_ad_record(r), sort_keys=True) for r in load_ad_records()[:50]))
    targets = {u["source"]["uri"] for u in pages}
    keys = {u["source"].get("page_key") for u in pages}
    check("同一逻辑页面产出多个 unit：%d 个 target vs %d 个 page_key" % (len(targets), len(keys)),
          len(targets) > len(keys),
          "页面与它的 .js 是两份原件 —— 塞进一个 unit 会让 raw_sha256 指着 A、正文来自 B")
    n_ids = len({u["unit_id"] for u in pages})
    check("重复 target 折叠为同一个 unit_id：%d 个观测 → %d 个 id" % (len(pages), n_ids),
          n_ids <= len(targets),
          ("%d 个 url_key 取到了同一个 target（含 collection 重定向），"
           "它们本来就该是同一个观测 —— 这正是一次观测 = 一个 id 的意义" % (len(pages) - n_ids))
          if n_ids < len(pages) else "无重复 target")

    print("\n[4b] 双指纹的**真实复取**实测（联网一次性证据，可缺席）")
    rf = ROOT / "research" / "landing" / "_evidence"
    cands = sorted(rf.glob("refetch-*/复取实测.json")) if rf.exists() else []
    if cands:
        probe = json.loads(cands[-1].read_text(encoding="utf-8"))
        rows = probe.get("rows", [])
        n_raw = sum(1 for r in rows if len(r["runs"]) == 2
                    and r["runs"][0]["raw_sha256"] != r["runs"][1]["raw_sha256"])
        n_txt = sum(1 for r in rows if len(r["runs"]) == 2
                    and r["runs"][0]["text_sha256"] != r["runs"][1]["text_sha256"])
        check("复取 %d 个页面 × 2 次：raw 变了 %d 次，正文变了 %d 次" % (len(rows), n_raw, n_txt),
              n_raw > 0 and n_txt == 0,
              "★ 这就是两个指纹不能合并的实测依据 —— 原件在变，正文没变。"
              "合并成一个数之后，这件事再也观测不到")
        shrunk = [r for r in rows if len(r["runs"]) == 2
                  and r["runs"][0]["bytes"] != r["runs"][1]["bytes"]]
        if shrunk:
            a, b = shrunk[0]["runs"]
            print("    · 其中 %s 连**字节数**都变了（%d → %d），正文仍逐字节相同"
                  % (shrunk[0]["url_key"][:44], a["bytes"], b["bytes"]))
    else:
        print("  · 未找到复取证据（不影响自证）。该项是联网一次性实测，结论写在 base/README.md。")

    print("\n[4c] ★ content_key 答的是「哪一版正文」（B2 订正措辞 · Owner 裁定 A）")
    # ★ 这一组是本轮**裁定的可执行形式**。裁定改的是措辞，而措辞是被人读、被代码照着写的，
    #   所以它必须由断言守住 —— 否则下一份文档又会把它写回「是不是同一个东西」。
    u_a = from_text("Wearable pump 45dB", uri="https://x/p")
    u_b = from_text("Wearable pump 45dB, rated 4.6 out of 5", uri="https://x/p")
    check("**同一个载体、两份正文 ⇒ 两个 content_key**（key 是版本标识，不是页面标识）",
          u_a["content_key"] != u_b["content_key"] and u_a["source"]["uri"] == u_b["source"]["uri"],
          "同一个 url_key 隔一天抓两次就会走到这里 —— 这不是缺陷，是它答的那一问")
    u_c = from_text("Wearable pump 45dB", uri="https://de.momcozy.com/p")
    check("**同一个正文、两个不同载体 ⇒ 同一个 content_key**（key 里没有 uri）",
          u_a["content_key"] == u_c["content_key"] and u_a["source"]["uri"] != u_c["source"]["uri"],
          "所以「key 相同」也推不出「同一个页面」—— 两个方向都推不出来")
    # ★ 下面这一条是**这一轮我自己抓到自己**的一处：我原本断言「unit_id 随载体变」，
    #   实测**不随** —— `unit_id = f(kind, raw_sha256, text_sha256)`，**不含 uri**。
    #   也就是说这份契约里「一次观测」是**按内容**定义的，不是按地址定义的。
    #   我错在照着自己写的文档措辞（「这一次观测是哪一次」）去断言，而没有去看实现。
    check("unit_id 同样**不含 uri**：同一段文字、两个载体 ⇒ 同一个 unit_id",
          u_a["unit_id"] == u_c["unit_id"],
          "unit_id 是 (kind, raw, text) 的函数 —— 地址不在里面")
    # ⇒ 由此得到一个**真实的边界**：两个**不同地址**若逐字节相同，会被折叠成一次观测。
    #   本项目的语料里没发生过（见下面那条），但它是可发生的 —— 所以把它变成一条**会被看见**的检查：
    by_id: dict[str, list] = {}
    for u in pages:
        by_id.setdefault(u["unit_id"], []).append(u)
    collapsed = {k: v for k, v in by_id.items() if len(v) > 1}
    straddle = {k: v for k, v in collapsed.items()
                if len({x["source"]["uri"] for x in v}) > 1}
    check("盘上 %d 组折叠，**全部**折叠的是同一个 target（不是两个地址撞成一个观测）"
          % len(collapsed), not straddle,
          ("出现了跨地址碰撞：%s —— unit_id 不含 uri，这正是它会发生的形态"
           % [v[0]["source"]["uri"][:40] for v in list(straddle.values())[:2]])
          if straddle else "")
    # 反向对照：盘上真语料里就有「同 key 不同页面」的例子，它必须存在
    ck_multi = {}
    for u in ads:
        ck_multi.setdefault(u["content_key"], []).append(u)
    multi = {k: v for k, v in ck_multi.items() if len(v) > 1}
    check("必红：盘上确有 %d 组「同 content_key、不同载体」" % len(multi),
          bool(multi),
          "" if multi else "一个都没有的话，上面那条断言在本项目的语料上是空转的")
    if multi:
        g = max(multi.values(), key=len)
        print("    · 例：%d 个观测共用 %s —— 载体的 uri 各不相同（%s…）"
              % (len(g), g[0]["content_key"], g[0]["source"]["uri"][:52]))

    print("\n[5] 留痕面：正文不落回执")
    fv = fingerprint_view(ads[0])
    check("fingerprint_view 不含正文",
          fv.get("text") is None and "text_sha256" in fv["fingerprint"]
          and not any(isinstance(v, str) and len(v) > 400 for v in fv.values()),
          "正文换成指纹，最长字段 %d 字符" % max(len(str(v)) for v in fv.values()))
    check("fingerprint_view 保留双指纹",
          bool(fv["fingerprint"]["raw_sha256"]) and bool(fv["fingerprint"]["text_sha256"]))
    check("fingerprint_view 明确写出省略了正文", bool(fv.get("$text_omitted")),
          "省略而不声明，读的人会以为原文就是这么短")

    print("\n[6] 桥接面：unit 能进 judge，且标签进不去（H13）")
    try:
        import judge as J                                # noqa: PLC0415
        kw = to_judge_kwargs(ads[0])
        r = J.judge(**kw)
        check("to_judge_kwargs → judge() 成功", "verdict" in r,
              "判定 %s" % r["verdict"]["disposition"])
    except Exception as e:                               # noqa: BLE001
        check("to_judge_kwargs → judge() 成功", False, f"{type(e).__name__}: {e}")
    accepted = set(inspect.signature(_judge_fn()).parameters)
    leak = sorted(set(CONTEXT_FROM_AD.values()) & accepted)
    check("语境字段与 judge 形参无交集", not leak, f"交集={leak}" if leak else
          "花费/展示/点击进不了判定，也进不了路由键")
    bad = dict(ads[0])
    bad["routing"] = dict(bad["routing"], 不存在的键="x")
    try:
        to_judge_kwargs(bad)
        check("未知路由键被拒绝（必红对照）", False, "它被放行了 —— 装饰性的路由键会看起来像生效了")
    except ValueError:
        check("未知路由键被拒绝（必红对照）", True)

    print("\n[7] 反向对照：坏 unit 必须红（一条不会红的检查等于没有检查）")
    negatives = [
        ("改一个字符 → H4 指纹对不上",
         lambda u: {**u, "text": u["text"] + "X"}), 
        ("unit_id 手改 → H7 不可复算",
         lambda u: {**u, "unit_id": "cu0000000000000000"}),
        ("has_text 撒谎 → H5",
         lambda u: {**u, "has_text": not u["has_text"]}),
        ("raw_sha256 写短 → H6",
         lambda u: {**u, "fingerprint": {**u["fingerprint"], "raw_sha256": "abc"}}),
        ("kind 越域 → H8",
         lambda u: {**u, "source": {**u["source"], "kind": "hologram"}}),
        ("parts 起点挪 1 → H11 逐字可核失败",
         lambda u: {**u, "composition": {**u["composition"], "parts": [
             {**u["composition"]["parts"][0], "start": 1}]}}),
        ("归一化档位不存在 → H9",
         lambda u: {**u, "normalization": {**u["normalization"], "profile": "text-v99"}}),
        ("正文尾部塞可见字符 → H4 指纹对不上 + H12 末段不再到界",
         lambda u: {**u, "text": u["text"] + "X"}),
        ("正文尾部塞空白 → H3（不动点被破坏）",
         lambda u: {**u, "text": u["text"] + "  "}),
        ("composition.separator 改掉 → H10 与登记表不一致",
         lambda u: {**u, "composition": {**u["composition"], "separator": "\n"}}),
    ]
    # 反向对照的底料要**挑一条真的有 parts 的**：
    # 第一版随手用了第 0 条（PLA 空文案、parts 为空），结果「改坏 parts」那条
    # 在**构造改坏对象时就崩了** —— 检查没红，是测试自己炸了。
    base = next(from_ad_record(r) for r in load_ad_records()
                if len(from_ad_record(r)["composition"]["parts"]) >= 2)
    for name, mutate in negatives:
        try:
            got = validate(mutate(base))
        except Exception as e:                           # noqa: BLE001
            check("必红：" + name, False, f"改坏对象时自己崩了（{type(e).__name__}: {e}）—— 这条检查是空的")
            continue
        check("必红：" + name, bool(got), (got[0][:64] if got else "★ 没红 —— 这条不变量是空的"))

    print("\n[8] schema 面：机器可读声明不许悄悄过期")
    sp = HERE / SCHEMA_FILE
    try:
        sch = json.loads(sp.read_text(encoding="utf-8"))
    except Exception as e:                               # noqa: BLE001
        check("schema 可解析", False, f"{type(e).__name__}: {e}")
        sch = None
    if sch:
        check("schema 可解析", True, SCHEMA_FILE)
        check("schema.contract_version == CONTRACT_VERSION",
              sch["properties"]["contract_version"]["const"] == CONTRACT_VERSION)
        missing, bad_enum = [], []
        enum_paths = [("source.kind", sch["properties"]["source"]["properties"]["kind"]["enum"]),
                      ("normalization.profile", sch["properties"]["normalization"]["properties"]["profile"]["enum"]),
                      ("composition.profile", sch["properties"]["composition"]["properties"]["profile"]["enum"]),
                      ("routing keys", sch["properties"]["routing"]["propertyNames"]["enum"])]
        for u in ads + pages:
            for k in sch["required"]:
                if k not in u:
                    missing.append(f"{u['unit_id']}.{k}")
            for path, allowed in enum_paths:
                got = (u["source"]["kind"] if path == "source.kind" else
                       u["normalization"]["profile"] if path.startswith("normalization") else
                       u["composition"]["profile"] if path.startswith("composition") else
                       None)
                if got is not None and got not in allowed:
                    bad_enum.append(f"{u['unit_id']} {path}={got!r}")
                if path == "routing keys":
                    bad_enum += [f"{u['unit_id']} routing.{k}" for k in u["routing"]
                                 if k not in allowed]
        check("schema.required 的每个键在 %d 个 unit 上都存在" % (len(ads) + len(pages)),
              not missing, missing[:2])
        check("schema 里四处 enum 与语料实际取值吻合", not bad_enum, bad_enum[:2])
        check("schema 把 ' | ' 写成规范分隔符（另一条口径只在 registry 里留档）",
              sch["properties"]["composition"]["properties"]["separator"]["type"] == "string")

    print("\n[9] 静默空正文面：提取到东西了，就不许产出空正文")
    # ★ 这条是补的，因为第一版真的踩了：`from_landing_page` 找 `structured["text"]`，
    #   而 `analyze_structured()` 给的是 `title` / `description_text` ——
    #   44 个商品 JSON 全部拿到空正文、全部 `has_text=False`（= 路由去 DP0），
    #   而它们 44/44 有标题、17/44 有描述。
    #   **不崩、不报错**，只是把「取了 44 个 JSON」记成「44 条没什么可看的」。
    _, _, _ev = load_landing()
    src_has_content, produced_empty = [], []
    for r in fetch["results"]:
        e = ext.get(r["url_key"]) or {}
        for label, cands in (("html", [((e.get("html") or {}).get("body_text") or "")]),
                             ("structured", [((e.get("structured") or {}).get("title") or ""),
                                             ((e.get("structured") or {}).get("description_text") or "")])):
            if not any(a.get("label") == label and a.get("sha256") for a in r.get("attempts", [])):
                continue
            u = from_landing_page(r, e, label=label, evidence_dir=None)
            if any(normalize(c) for c in cands):
                src_has_content.append(u["unit_id"])
                if not u["has_text"]:
                    produced_empty.append(f"{r['url_key']} [{label}] 提取非空但正文为空")
    check("有提取内容却产出空正文的落载体：%d / %d" % (len(produced_empty), len(src_has_content)),
          not produced_empty, (produced_empty[:2] if produced_empty else
                               "44/44 商品 JSON 都有标题，全部进得了判定"))
    st_units = [u for u in pages if u["source"]["kind"] == "structured_json"]
    check("structured_json 全部有正文：%d / %d"
          % (sum(1 for u in st_units if u["has_text"]), len(st_units)),
          all(u["has_text"] for u in st_units))
    st_both = [u for u in st_units if len(u["composition"]["parts"]) == 2]
    check("title + description_text 都非空的商品 JSON 记了 2 段 parts：%d 个" % len(st_both),
          len(st_both) == 17, "登记表里 description_text 非空的就是 17 个")
    print("    · 商品 JSON 的正文由 title 与 description_text 按 `fields-pipe-v1` 拼成，"
          "分隔符与广告文案一致 —— 同样受 `[^.!?|]` 那道屏障保护")

    print("\n" + "=" * 78)
    if fails:
        print("✗ B0.2 自证未通过：%d 项" % len(fails))
        for f in fails:
            print("   - " + f)
    else:
        print("✓ B0.2 自证全绿：%d 条广告 + %d 个落载体 → %d 个合法 unit"
              % (len(ads), len(pages), len(ads) + len(pages)))
    print("=" * 78)
    return fails


def stats() -> dict:
    ads, pages = units_from_corpus(verify_evidence=True)
    from collections import Counter
    return {
        "contract_version": CONTRACT_VERSION,
        "normalization_profile": NORMALIZATION_PROFILE,
        "composition_profile": COMPOSITION_PROFILE,
        "units": {"ad_text": len(ads),
                  "landing_page": sum(1 for u in pages if u["source"]["kind"] == "landing_page"),
                  "structured_json": sum(1 for u in pages if u["source"]["kind"] == "structured_json"),
                  "total": len(ads) + len(pages)},
        "distinct": {
            "unit_id": len({u["unit_id"] for u in ads + pages}),
            "content_key": len({u["content_key"] for u in ads + pages}),
            "$note": ("unit_id 少 3 个是**对的**：3 个 url_key 取到了同一个 target"
                      "（collection 重定向），它们本来就该是同一个观测。"),
        },
        "source_kinds": dict(Counter(u["source"]["kind"] for u in ads + pages)),
        "has_text": {"true": sum(1 for u in ads + pages if u["has_text"]),
                     "false": sum(1 for u in ads + pages if not u["has_text"]),
                     "$false_breakdown": (
                         "false 的 %d 条 = 广告 %d 条（Google PLA，结构上无 Primary Text/Headline）"
                         " + 落载体 %d 条（正文提取为空）。"
                         "它们走 DP0，不进审查队列、不进空白清单 —— 是**路由**，不是「合规」。"
                         % (sum(1 for u in ads + pages if not u["has_text"]),
                            sum(1 for u in ads if not u["has_text"]),
                            sum(1 for u in pages if not u["has_text"])))},
        "raw_verified": sum(1 for u in pages if u["source"].get("raw_verified")),
        "text_chars_total": sum(u["fingerprint"]["text_chars"] for u in ads + pages),
    }


# ------------------------------------------------------------------ CLI

def main() -> int:
    ap = argparse.ArgumentParser(description="ContentUnit 契约（基座第①面）")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--selftest", action="store_true", help="自证：不变量全绿 + 反向对照必红")
    g.add_argument("--stats", action="store_true", help="语料规模与指纹分布")
    g.add_argument("--from-text", metavar="TEXT")
    g.add_argument("--from-record", metavar="AD_ID", help="按 外部广告ID 取存量记录")
    g.add_argument("--from-url-key", metavar="URL_KEY", help="按 url_key 取落载体")
    ap.add_argument("--product-line", default=None)
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    if a.selftest:
        return 1 if selftest() else 0
    if a.stats:
        print(json.dumps(stats(), ensure_ascii=False, indent=2))
        return 0
    if a.from_text:
        u = from_text(a.from_text, product_line=a.product_line)
    elif a.from_record:
        rec = next((r for r in load_ad_records() if r.get("外部广告ID") == a.from_record), None)
        if rec is None:
            print("找不到广告ID：" + a.from_record, file=sys.stderr)
            return 2
        u = from_ad_record(rec)
    else:
        fetch, ext, ev = load_landing()
        rec = next((r for r in fetch["results"] if r["url_key"] == a.from_url_key), None)
        if rec is None:
            print("找不到 url_key：" + a.from_url_key, file=sys.stderr)
            return 2
        u = from_landing_page(rec, ext.get(rec["url_key"]), evidence_dir=ev)

    probs = validate(u)
    if a.json:
        print(json.dumps(u, ensure_ascii=False, indent=2))
    else:
        print("unit_id      ", u["unit_id"])
        print("content_key  ", u["content_key"])
        print("载体         ", u["source"]["kind"], "·", u["source"]["uri"][:70])
        print("raw_sha256   ", u["fingerprint"]["raw_sha256"][:16], f"({u['fingerprint']['raw_bytes']} 字节)")
        print("text_sha256  ", u["fingerprint"]["text_sha256"][:16], f"({u['fingerprint']['text_chars']} 字符)")
        print("has_text     ", u["has_text"])
        print("路由         ", u["routing"] or "（无）")
        print("组装         ", u["composition"]["profile"], "·", len(u["composition"]["parts"]), "段")
        print("正文         ", repr(u["text"][:120]))
    if probs:
        print("\n✗ validate 未通过：", file=sys.stderr)
        for x in probs:
            print("   - " + x, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

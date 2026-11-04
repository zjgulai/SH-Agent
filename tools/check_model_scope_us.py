#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
check_model_scope_us.py —— 模型侧还守着「只审美国市场」吗？（**只读巡检**）

## 为什么要有它

2026-10-14（Owner 定稿）：模型侧口径 = **问题必须落在美国市场**
（美国消费者 / 美国平台 / 美国法规视角）。执行点是
`tools/agent/model_side.mjs` 的 `SYSTEM` 硬约束第 **7** 条。

**但提示词改动没有失败信号。** 这正是本项目反复吃过的形状
（AGENTS.md：「散文没有失败信号；判据才有」）—— 提示词里写上一句，
模型今天听、三个月后不听，**没有任何东西会红**。
所以补这一条把「模型侧有没有再跑出非美国口径的结论」变成可读的数。

## 病灶实测（基线的来源，2026-10-14 全扫）

`PMO/shouheng-state/merged-reports/`：**176 份报告 · 780 条条目**，抽取后按侧分：

| | 条数 | 其中含非美国辖区 |
|---|---|---|
| 模型侧 | 685 | **26**（中国大陆 18 ／ 英国 6 ／ 欧盟 2） |
| 库侧 | 77 | 4（判据全是库内条款，中国词只出现在**模型生成的建议**里） |

最硬的一条把中国《广告法》当判据 —— `merged-2026-10-12T08_56_07.592Z-1791795367592`：

    模型侧：「『最好的吸奶器』属绝对化最高级表述，**广告法明令禁止**…极限用语」
    库侧（同一份报告）：「best/#1/No.1/最佳/最好…按 2026-09-09 口径放开，
                        **海外广告允许，不再判险**」
    ⇒ **同一单的两轨结论相反。**

## 判据边界（写清楚，免得被当成它做不到的事）

  · **判据级 vs 建议级 —— 这两个数必须分开看**（实测出来的区分，不是修辞）：
    2026-10-14 核那 26 条非美国条目，**判据行没有一条引非美国法规**
    （22 条是「无库内依据」、3 条引 Amazon/Google 平台政策）。
    ⇒ 真正的越界只在**极少数把非美国规则写进 `原因`** 的条目上（如那条中国《广告法》）；
    多数只是**改法里顺口提了一句**（如「补一行北京时间」）。
    所以：**判据级 = 硬信号**，建议级 = 提示。混成一个数，
    会把「改法里提了一句北京时间」和「拿中国广告法当判据」说成同一件事。
  · **只扫 `原因` 与 `建议`** —— 这两段才是模型/引擎**自己写的话**。
    **不扫 `excerpt` 与 `依据`**：那两段是逐字引用（素材原文 / 库内条款原文），
    素材本身就可能含这些词，扫它们必然误报。
  · **它是巡检，不是闸门** —— 不拦审查、不改结论、不碰 PASS 判定。做成闸门需要**另一套设计**：
    `dual_track.mjs` 的 ⑥b 明写「模型侧跑成了、没报东西 ⇒ 仍必须能 PASS」，
    所以「丢弃 > 0」必须与「跑成了没报东西」分开，否则会开出一条 fail-open 路
    （PASS 是唯一的放行态）。这里**只报数**。
  · **提到外国 ≠ 跑偏** —— 本口径是「**落在**美国市场」，不是「不许出现外国」。
    实测那 8 条英国/欧盟条目落点本就是美国消费者
    （「Mother&Baby 是英国奖项，而来源页是美国站，美国消费者会误读」）⇒ **那是真问题，不算命中**。
    所以词表**只收中国独有制度词**，不收「英国 / 欧盟 / 德国」。
  · **命中 ≠ 一定跑偏**：词表查的是**线索**（「中文社群」这类词本身也可能是**美国境内**的
    中文受众）。这一条是**给人看的线索**，不是判定 —— 明细里会印出命中原话供人一眼分辨。

## 用法

    python3 tools/check_model_scope_us.py              # 巡检（与基线比，有新增就红）
    python3 tools/check_model_scope_us.py --freeze     # 人看过之后，把当前命中冻成新基线
    python3 tools/check_model_scope_us.py --selftest   # 反向对照（纯内存，不碰盘）
    python3 tools/check_model_scope_us.py --detail     # 连命中明细一起打印

退出码：0 无新增 / 1 **有新增命中** / 2 **未测**（找不到报告目录 —— 既不是通过也不是红）。
"""
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPORTS = ROOT / "PMO" / "shouheng-state" / "merged-reports"
BASELINE = ROOT / "PMO" / "shouheng-state" / "us-scope-baseline.json"

# ── 词表：**只收中国独有的词**，且分两档 ───────────────────────────────
#
# 两档是实测分出来的，不是修辞（2026-10-14 核 26 条非美国条目）：
#   · **法规级** —— 非美国的**法规/制度**词。命中它 = 拿别国法条当判据，
#     这是最硬的一种越界（实测只有 1 条：中国《广告法》）。
#   · **市场级** —— 非美国**市场语境**词（中文社群、北京时间、中国平台）。
#     命中它 = 这条问题被定性成了非美国市场的问题（实测 12 条），
#     口径同样越界，但不涉法条，性质比法规级轻。
#   合成一个数会把「拿中国广告法判违规」和「建议补一行北京时间」说成同一件事。
#
# ⚠️ 绝不往里加「英国 / 欧盟 / 德国 / MHRA / CAP Code」—— 见文件头「判据边界」：
#    那些词出现在**美国视角**的问题里是正常的（跨境奖项误导美国消费者），
#    加进来就会把真问题一起报成跑偏。这条边界是 Owner 2026-10-14 亲自定的口径。
MARKERS = [
    # 法规级
    ("广告法（中国）", r"广告法", "法规级"),
    ("极限用语（中国广告法概念）", r"极限用语", "法规级"),
    ("医疗器械广告审查", r"医疗器械广告审查", "法规级"),
    ("广告审查批准文号", r"广告审查批准文号", "法规级"),
    ("批准文号", r"批准文号", "法规级"),
    ("中国国标 GB", r"\bGB\s?\d{4,}", "法规级"),
    ("市场监督管理", r"市场监督管理", "法规级"),
    # 市场级
    ("小红书", r"小红书", "市场级"),
    ("朋友圈", r"朋友圈", "市场级"),
    ("抖音", r"抖音", "市场级"),
    ("微信社群/公众号/视频号", r"微信社群|微信公众号|视频号", "市场级"),
    ("北京时间", r"北京时间", "市场级"),
    ("中国大陆/简体中文市场", r"中国大陆|简体中文市场|中文社群|中文字幕", "市场级"),
]
GROUP_OF = {name: grp for name, _pat, grp in MARKERS}
PAT_OF = {name: pat for name, pat, _grp in MARKERS}

# 条目形状（两种报告格式共用）：`N.【类目】位置 —— **标记**`
ITEM = re.compile(r"^(\d+)\.【([^】]+)】(.*?)——\s*\*\*(.+?)\*\*", re.M)
RE_REASON = re.compile(r"\*\*原因\*\*：(.+?)(?=\n\s*\*\*|\Z)", re.S)
RE_ADVICE = re.compile(r"\*\*建议\*\*：(.+?)(?=\n\s*\*\*|\Z)", re.S)


def side_of(marker: str):
    """标记 → '模型侧' / '库侧' / None。两种格式的标记词都认。"""
    m = marker.strip()
    if m.startswith("无库内") or m.startswith("模型侧"):
        return "模型侧"
    if m.startswith("有库内") or m.startswith("知识库侧"):
        return "库侧"
    return None


def china_hits(text: str):
    return [name for name, pat, _grp in MARKERS if re.search(pat, text)]


def groups_of(words):
    return sorted({GROUP_OF[w] for w in words if w in GROUP_OF})


def show_path(p: Path) -> str:
    """印给人看的路径。**不在仓内就退回绝对路径** —— 生产里 BASELINE 恒在仓内，
    所以 `relative_to(ROOT)` 从来没炸过；是 R12 拿临时目录真跑一遍才把它问出来的
    （`ValueError: ... is not in the subpath of ...`）。判据抓出来的第一个缺陷
    不是被测对象的，是这条判据自己的运行环境假设。"""
    try:
        return str(Path(p).relative_to(ROOT))
    except ValueError:
        return str(p)


def snippet(text: str, words):
    """把命中的**那一小段原话**截出来 —— 没有它，看明细的人无法在几秒内判断是真跑偏还是误报。"""
    for w in words:
        pat = PAT_OF.get(w)
        if not pat:
            continue
        m = re.search(pat, text)
        if m:
            a, b = max(0, m.start() - 40), min(len(text), m.end() + 40)
            return ("…" if a else "") + text[a:b] + ("…" if b < len(text) else "")
    return ""


def parse_report(path: Path):
    """抽一份报告里的条目。**附录整段跳过** —— 那是检索读数，不是结论。"""
    raw = path.read_text(encoding="utf-8", errors="replace")
    body = raw.split("## 附录")[0]
    out = []
    ms = list(ITEM.finditer(body))
    for i, m in enumerate(ms):
        end = ms[i + 1].start() if i + 1 < len(ms) else len(body)
        block = body[m.start():end]
        reason = RE_REASON.search(block)
        advice = RE_ADVICE.search(block)
        out.append({
            "file": path.name,
            "cat": m.group(2).strip(),
            "loc": m.group(3).strip(),
            "marker": m.group(4).strip(),
            "side": side_of(m.group(4)),
            "reason": re.sub(r"\s+", " ", reason.group(1)).strip() if reason else "",
            "advice": re.sub(r"\s+", " ", advice.group(1)).strip() if advice else "",
        })
    return out


def dedupe_reports():
    """`merged-X.md` 与 `merged-X.full.md` 是同一份的两态 ⇒ 按基名去重，**优先取 .full.md**（超集）。

    ⚠️ 第一版这里写错过一次：`full_bases - plain_names` 拿「去了扩展名的基名」去减
       「带 .md 的文件名」，两边永远不相等 ⇒ 116 份全部被误报成「只有 full、没有 plain」。
       判据要比较**同一种东西**。
    """
    by = {}
    for p in sorted(REPORTS.glob("merged-*.md")):
        base = p.name[:-8] if p.name.endswith(".full.md") else p.name[:-3]
        if base not in by or p.name.endswith(".full.md"):
            by[base] = p
    return [by[k] for k in sorted(by)]


def scan():
    files = dedupe_reports()
    items, hits = [], []
    for p in files:
        for it in parse_report(p):
            items.append(it)
            # ★ 两个维度都要看，缺一个就会把性质不同的事说成一件：
            #   · **词类**（法规级／市场级）—— 拿别国法条当判据，比"按别国市场语境定性"重；
            #   · **段位**（原因段／建议段）—— 命中词落在 `原因` 里 = 这条问题的**定性本身**
            #     就是非美国口径；只在 `建议` 里 = 改法顺口提了一句。
            #   实测（2026-10-14 · 176 份）：法规级只有 1 条（中国《广告法》，落在原因段），
            #   市场级 22 条。混成一个数，那条最该修的会被 22 条噪声淹没。
            wr = china_hits(it["reason"])
            wa = china_hits(it["advice"])
            words = sorted(set(wr + wa))
            if it["side"] and words:
                level = "判据段" if wr else "建议段"
                grps = groups_of(words)
                seed = (f"{it['file']}|{level}|{'/'.join(grps)}|{'/'.join(words)}|"
                        f"{re.sub(r'[^0-9A-Za-z一-鿿]', '', it['reason'])[:60]}")
                hits.append({**it, "words": words, "level": level, "groups": grps,
                             "words_reason": wr, "words_advice": wa,
                             "fp": hashlib.sha1(seed.encode()).hexdigest()[:16]})
    return files, items, hits


# ── 反向对照（纯内存，不碰盘）────────────────────────────────────────────
def selftest() -> int:
    checks = []

    def ck(cid, ok, msg):
        checks.append((cid, bool(ok), msg))

    # R1 阳性：把中国《广告法》当判据 ⇒ 必须命中
    t = "「最好的吸奶器」属绝对化最高级表述，广告法明令禁止在广告中使用「最好」这类极限用语"
    ck("R1", "广告法（中国）" in china_hits(t), "按中国《广告法》判 ⇒ 命中（这就是那条真病灶）")

    # R2 阳性：中国国标
    ck("R2", "中国国标 GB" in china_hits("把测试标准（如 EN 15883 / GB 17988 适用项）补进详情页"),
       "提到 GB 国标 ⇒ 命中")

    # R3 阳性：中国平台 / 北京时间
    ck("R3", china_hits("若这条要投在电商详情页、小红书或朋友圈，还需先确认") != [],
       "提到小红书/朋友圈 ⇒ 命中")
    ck("R4", "北京时间" in china_hits("在英文时间下加一行中文时间，例如「北京时间 9月26日 01:00」"),
       "建议换算北京时间 ⇒ 命中")

    # ★★ R5 阴性（**最重要的一条**）：英国奖项摆在美国站、落点是美国消费者 ⇒ **不许命中**
    uk = ("Mother&Baby Awards 是英国母婴媒体的奖项，而来源页标注为美国站，"
          "贴片却未标颁奖地区，美国消费者会误读成本土奖项")
    ck("R5", china_hits(uk) == [],
       "★反向对照：英国奖项摆在美国站（落点=美国消费者）⇒ **不命中** —— "
       "这是 Owner 选的口径「落在美国市场」，不是「不许出现外国」")

    # R6 阴性：正常美国依据
    us = "Amazon Ads《Claims and substantiation》：比较性宣称需有实证，建议同屏标出信息来源"
    ck("R6", china_hits(us) == [], "反向对照：纯美国平台依据 ⇒ 不命中")

    # R7 阴性：欧盟/德国的**对照**用法也不许命中（词表里就不该有这些词）
    eu = "该表述在部分市场（如欧盟、法国）对接触婴幼儿食品的部件有额外限制"
    ck("R7", china_hits(eu) == [], "★反向对照：欧盟/法国作对照 ⇒ 不命中（词表不收这些词）")

    # R8 结构：标记词必须能分侧（分错侧会把库侧的问题算到模型侧头上）
    ck("R8", side_of("无库内依据 · 建议转人工") == "模型侧"
             and side_of("模型侧（无库内依据）") == "模型侧"
             and side_of("有库内条款依据") == "库侧"
             and side_of("知识库侧") == "库侧"
             and side_of("这不是素材有问题，是库对该题材没有可依据的条款") is None,
       "两种报告格式的标记词都能分对侧")

    # R9 结构：`excerpt` / `依据` 不在扫描面内（扫它们必然误报）
    #
    # ★★ 第一版这条**假红**，原因是**自指**：判据写的是「整个文件里不许出现
    #    `it["excerpt"]`」，而**断言的这句字面量本身就写在文件里** ⇒ 恒不成立。
    #    这正是本项目那个反复出现的形状（判据把自己的存在当成了被测对象）。
    #    修法：只在 `scan()` 的**函数体内**找 —— 判据要指向代码，不指向文件全文。
    src = Path(__file__).read_text(encoding="utf-8")
    body_m = re.search(r"def scan\(\):(.*?)\ndef ", src, re.S)
    scan_body = body_m.group(1) if body_m else ""
    ck("R9", 'china_hits(it["reason"])' in scan_body
             and 'china_hits(it["advice"])' in scan_body
             and 'it["excerpt"]' not in scan_body and 'it["basis"]' not in scan_body,
       "扫描面只有 原因 + 建议（不含 excerpt / 依据 —— 那两段是逐字引用）")

    # R11 ★ 两个维度都要分得开（混成一个数会把「拿中国广告法判违规」和
    #     「建议补一行北京时间」说成同一件事）
    #     ⚠️ 第一版这里把「市场级」写成了「法规级」，当场假红 —— 断言写错方向，
    #     与 R9 的自指假红是同一类（判据自己有问题，却看起来像被测对象有问题）。
    ck("R11", groups_of(china_hits(t)) == ["法规级"]
             and groups_of(china_hits("建议补一行北京时间")) == ["市场级"],
       "词类分得开：中国《广告法》= 法规级；「北京时间」= 市场级")
    ck("R11b", "判据段" if china_hits("广告法明令禁止极限用语") else "建议段" == "判据段",
       "段位分得开：命中词落在原因段 ⇒ 判据段（这条问题的定性本身就是非美国口径）")

    # ★★ R12 端到端：**基线判红那条路必须真的走得通**
    #    前面 R1–R11 全是词表与结构的单点断言 —— 它们证明不了「有新命中时会红」。
    #    而「有新命中时红」正是这个巡检存在的全部理由（跑一次绿一次、永远绿的巡检
    #    等于注释）。所以这里用临时语料真跑一遍：冻结 → 只加一份新的违规报告 → 必须红。
    #    **全程在 tempfile 里，不碰 PMO/shouheng-state 的任何真文件。**
    #    ⚠️ `main()` 会把整份报告打到 stdout ⇒ 这里必须吞掉，否则自测输出会被它淹掉。
    import contextlib
    import io
    import shutil
    import tempfile
    global REPORTS, BASELINE
    saved = (REPORTS, BASELINE)
    try:
        tmp = Path(tempfile.mkdtemp(prefix="us-scope-selftest-"))
        (tmp / "reports").mkdir()
        REPORTS, BASELINE = tmp / "reports", tmp / "baseline.json"

        def mk(name, reason):
            (REPORTS / name).write_text(
                "# 报告\n\n1.【合规】素材正文  —— **模型侧**（无库内依据）\n"
                f"   **原因**：{reason}\n   **建议**：改一下。\n", encoding="utf-8")

        def quiet(args):
            with contextlib.redirect_stdout(io.StringIO()):
                return main(args)

        mk("merged-A.md", "比较性宣称需有实证（Amazon Ads 政策）")      # 干净
        ck("R12a", quiet(["--freeze"]) == 0, "冻结基线（临时语料 · 1 份干净报告）")
        ck("R12b", quiet([]) == 0, "★反向对照：语料没变 ⇒ **不红**（否则这条尺子恒红）")
        mk("merged-B.md", "「最好」属绝对化最高级，广告法明令禁止…极限用语")  # 新增违规
        ck("R12c", quiet([]) == 1, "★正规对照：**新增一份含中国《广告法》判据的报告 ⇒ 必须红**")
        mk("merged-C.md", "只给 ET 时区，建议补一行北京时间")               # 新增市场级
        ck("R12d", quiet([]) == 1, "★正规对照：新增**市场级**命中同样判红（不只盯法规级）")
    finally:
        REPORTS, BASELINE = saved
        shutil.rmtree(tmp, ignore_errors=True)

    # R10 去重：同一份报告的两态只算一次
    ck("R10", dedupe_reports() and len({p.name[:-8] if p.name.endswith('.full.md') else p.name[:-3]
                                        for p in dedupe_reports()}) == len(dedupe_reports()),
       "`merged-X.md` 与 `merged-X.full.md` 按基名去重（第一版在这里把 116 份误报成孤儿）")

    n_fail = sum(1 for _, ok, _ in checks if not ok)
    print("=" * 74)
    for cid, ok, msg in checks:
        print(f"  {'✅' if ok else '❌'} {cid}  {msg}")
    print("=" * 74)
    print(f"  反向对照 {len(checks) - n_fail}/{len(checks)} 过"
          + ("" if not n_fail else f" ｜ **{n_fail} 项红**"))
    return 1 if n_fail else 0


def main(argv) -> int:
    if "--selftest" in argv:
        return selftest()

    freeze = "--freeze" in argv
    detail = "--detail" in argv

    if not REPORTS.is_dir():
        print(f"⚠ 未测：找不到报告目录 {REPORTS}")
        print("   （这不是「通过」—— 没有报告可查，等于这条读数不存在）")
        return 2

    files, items, hits = scan()
    model_items = [x for x in items if x["side"] == "模型侧"]
    kb_items = [x for x in items if x["side"] == "库侧"]
    m_hits = [h for h in hits if h["side"] == "模型侧"]
    k_hits = [h for h in hits if h["side"] == "库侧"]

    print("── 模型侧美国口径巡检（只读）──────────────────────────────")
    print(f"  报告        {len(files)} 份（已按基名去重，优先 .full.md）")
    print(f"  条目        {len(items)} 条 ｜ 模型侧 {len(model_items)} ｜ 库侧 {len(kb_items)}")
    hard = [h for h in hits if "法规级" in h["groups"]]
    hard_r = [h for h in hard if h["level"] == "判据段"]
    market = [h for h in hits if "市场级" in h["groups"]]
    market_r = [h for h in market if h["level"] == "判据段"]
    print(f"  命中        {len(hits)} 条")
    print(f"              法规级 {len(hard)}（其中落在**原因段** {len(hard_r)} —— 拿别国法条当判据，最硬）")
    print(f"              市场级 {len(market)}（其中落在**原因段** {len(market_r)} —— 问题的定性本身就是非美国口径）")
    print(f"              模型侧 {len(m_hits)} ｜ 库侧 {len(k_hits)}")

    if not hits:
        print("  ✅ 没有命中中国独有制度词 —— 模型侧没有跑出非美国口径的结论")

    new = []
    if freeze:
        BASELINE.parent.mkdir(parents=True, exist_ok=True)
        BASELINE.write_text(json.dumps(
            {"frozen_at": __import__("datetime").datetime.now().isoformat(timespec="seconds"),
             "reports": len(files), "hits": sorted(h["fp"] for h in hits)},
            ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"  ✎ 已把当前 {len(hits)} 条命中冻成基线：{show_path(BASELINE)}")
    elif BASELINE.exists():
        base = json.loads(BASELINE.read_text(encoding="utf-8"))
        known = set(base.get("hits") or [])
        new = [h for h in hits if h["fp"] not in known]
        print(f"  基线        {len(known)} 条（冻结于 {base.get('frozen_at', '?')}）"
              f" ｜ 本次新增 **{len(new)}** 条")
    else:
        print(f"  ⚠ 还没有基线（{show_path(BASELINE)}）—— 本次只报数，不判红")
        print("     人看过之后跑一次 --freeze 把它冻上，之后就能判「有没有新增」。")

    if (detail or new) and hits:
        show = new if new else hits
        print("\n  命中明细" + ("（仅新增）" if new else ""))
        for h in sorted(show, key=lambda x: ("法规级" not in x["groups"],
                                             x["level"] != "判据段",
                                             x["side"] != "模型侧")):
            print(f"   · [{h['side']}·{'/'.join(h['groups'])}·{h['level']}] {h['file']}")
            print(f"     类别 {h['cat']}｜位置 {h['loc'][:40]}｜词 {'/'.join(h['words'])}")
            # ★ 命中词在哪一段 —— 不印这行，看明细的人无法判断是真跑偏还是误报
            #   （库侧那 4 条命中词在**建议**里，只印「原因」就完全看不出为什么命中）
            for field, txt, ws in (("原因", h["reason"], h["words_reason"]),
                                   ("建议", h["advice"], h["words_advice"])):
                if ws:
                    print(f"     {field}命中「{'/'.join(ws)}」：{snippet(txt, ws)}")
        if len(show) > 40:
            print(f"   … 另有 {len(show) - 40} 条")

    print("=" * 74)
    if new:
        hard_new = [h for h in new if "法规级" in h["groups"]]
        print(f"  ❌ 有 **{len(new)}** 条新增命中（其中法规级 {len(hard_new)} 条）"
              f" —— 提示词口径可能漂了，回看 tools/agent/model_side.mjs 的 `SYSTEM` 第 7 条")
        return 1
    print("  ✅ 无新增")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

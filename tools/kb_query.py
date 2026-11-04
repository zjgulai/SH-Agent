#!/usr/bin/env python3
"""
kb_query.py —— 需求知识库 · 黄金问题查询（G3 验收）

建设方案 §七 定义了 10 条黄金问题，作为「可用性」的验收门：
**不读代码就能回答这 10 个问题**，否则台账只是把飞书表格搬了个家。

本脚本把每条问题做成一条可复现命令。答不出来的问题会被标成 GAP —— 
**答不出来不是失败，假装答得出来才是。**

用法：
  python3 tools/kb_query.py              # 全部 10 条
  python3 tools/kb_query.py 3            # 只跑第 3 条
  python3 tools/kb_query.py --md         # 生成查询手册
"""

import collections
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                "research", "kb"))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import load  # noqa: E402

LEDGER = os.path.join(load.KB, "台账-v1.json")
EVIDENCE = os.path.join(load.KB, "证据映射.json")
ANALYSIS = os.path.join(load.KB, "结构分析.json")
MANUAL = os.path.join(load.KB, "查询手册.md")

IN_FLIGHT = ("进行中", "未开始", "已停滞")


def load_all():
    led = json.load(open(LEDGER, encoding="utf-8"))
    return led, [r for r in led["records"] if r["role"] != "excluded"]


# ── 十条黄金问题 ────────────────────────────────────────────

def q1(led, rs):
    """现在总共有多少条在跑的需求？分别来自哪些系统？"""
    out = [f"台账共 {len(rs)} 条（顶层 {sum(1 for r in rs if r['level']=='top')} + "
           f"子任务 {sum(1 for r in rs if r['level']=='child')}）"]
    run = [r for r in rs if r.get("status") in IN_FLIGHT]
    out.append(f"在跑（进行中 + 未开始 + 已停滞）：{len(run)} 条")
    for sysname in ("creative", "seo"):
        s = [r for r in rs if r["source_system"] == sysname]
        sr = [r for r in s if r.get("status") in IN_FLIGHT]
        out.append(f"  {sysname:<9} 共 {len(s):>4} 条，在跑 {len(sr):>4} 条")
    for t, n in collections.Counter(r["source_table"] for r in run).most_common():
        out.append(f"    · {t:<24} {n:>4}")
    return out


def q2(led, rs):
    """哪些需求逾期未交付？逾期多久？"""
    today = load.basis_date()
    cand = [r for r in rs if r.get("date_due") and r.get("status") != "已完成"]
    over = []
    for r in cand:
        d = load.days_between(r["date_due"], today)
        if d > 0:
            over.append((d, r))
    over.sort(key=lambda x: -x[0])
    out = [f"有计划完成日期且未完成的 {len(cand)} 条中，逾期 {len(over)} 条"
           f"（基准日 {today}）"]
    out.append("⚠️ 基准日取**快照日**，不取墙钟今天 —— 逾期是数据的属性，不是提问"
               "时刻的属性。否则同一条命令每天给出不同的数，而手册里写下的那个数"
               "第二天就复现不出来（B3.0 实测：09-16 写 30 条，09-17 跑出 33 条）。"
               "要知道今天的逾期，重新拉快照。")
    out.append("⚠️ 全量 1160 条里只有 189 条有计划完成日期 —— "
               "**逾期率只能建在这个子集上，不能外推**")
    for d, r in over[:12]:
        out.append(f"  {d:>4} 天  [{r['source_system']}] {str(r['title'])[:44]:<46}"
                   f" 负责人={r.get('owner') or '—'} 状态={r.get('status') or '—'}")
    if len(over) > 12:
        out.append(f"  … 另 {len(over)-12} 条")
    return out


def q3(led, rs):
    """每个品线各压了多少需求？哪条品线最紧？"""
    ev = json.load(open(EVIDENCE, encoding="utf-8"))
    out = [f"{'品线族':<8}{'总需求':>7}{'在跑':>7}{'已停滞':>7}{'无状态':>7}{'证据':>6}  分级"]
    for row in ev["rows"]:
        fam = row["品线族"]
        out.append(f"{fam:<8}{row['需求条数']:>7}{row['进行中']+row['未开始']+row['已停滞']:>7}"
                   f"{row['已停滞']:>7}{row['无状态']:>7}{row['已声明证据数']:>6}"
                   f"  {row['证据分级']}")
    un = ev["totals"]["demands_unmapped"]
    out.append(f"\n另有 {un} 条品线未识别（PSEO「翼果未分类」283 条为主）")
    return out


def q4(led, rs):
    """每个跟进人/剪辑师手上各有多少条在跑？"""
    run = [r for r in rs if r.get("status") in IN_FLIGHT and r.get("owner")]
    c = collections.Counter()
    for r in run:
        for who in str(r["owner"]).split(";"):
            who = who.strip()
            if who:
                c[who] += 1
    out = [f"在跑且填了负责人的 {len(run)} 条，涉及 {len(c)} 人"]
    for who, n in c.most_common(15):
        out.append(f"  {n:>4}  {who}")
    return out


def q5(led, rs):
    """哪些需求在多个系统里重复出现？"""
    an = json.load(open(ANALYSIS, encoding="utf-8"))
    ds = an["duplicate_summary"]
    out = [f"扫描 {ds['demand_records_scanned']} 条，排除 {ds['child_rows_excluded']} 条 WBS 子任务",
           f"同标题+同SKU+同日期 的重复键 {ds['duplicate_keys']} 个，涉 {ds['records_involved']} 条",
           f"**跨表重复 {ds['cross_table_keys']} 个** —— creative 与 seo 是两条互不重叠的线"]
    for d in an["duplicate_candidates"][:6]:
        out.append(f"  ×{d['n']}  {d['items'][0]['raw'][:46]}  ← {', '.join(d['tables'])}")
    return out


def q6(led, rs):
    """哪些需求已完成但没有产出物？"""
    done = [r for r in rs if r.get("status") == "已完成"]
    noout = [r for r in done if not r.get("deliverable")]
    out = [f"已完成 {len(done)} 条，其中产出物字段为空 {len(noout)} 条"
           f"（{len(noout)/len(done):.0%}）"]
    for t, n in collections.Counter(r["source_table"] for r in noout).most_common():
        tot = sum(1 for r in done if r["source_table"] == t)
        out.append(f"  {t:<24} {n:>4} / {tot:<4} 完成项无产出物")
    out.append("⚠️ 「产出物字段为空」≠「没有产出物」—— 可能只是没填。"
               "这张表回答的是**可追溯性**，不是实际交付情况。")
    return out


def q7(led, rs):
    """哪些需求卡在同一状态超过阈值？"""
    stuck = [r for r in rs if r.get("status") == "已停滞"]
    out = [f"显式标记「已停滞」的：{len(stuck)} 条"]
    for r in stuck:
        out.append(f"    {str(r['title'])[:60]}  [{r['source_table']}]")
    out.append("")
    out.append("❌ **GAP：无法回答「卡在同一状态超过 N 天」**")
    # ★ 这句「已登记」过去是散文，没有任何落点（B3.0 抓到）。现在它是**读出来的**：
    #   登记表里没有对应条目，这里就打「未登记」，E1 检查随之变红。
    out.extend(_gap_lines("KB-GAP-1"))
    out.append("   同一族还有一条：四个疑似「开始时间」字段的语义未确认 ——")
    out.extend(_gap_lines("KB-GAP-2", indent="   "))
    out.append("   （为什么不能用它们替代：语义未确认时把「排期没到」算成「卡住了」，"
               "正是这个项目一直在防的那类错误。）")
    return out


def _gap_lines(gid, indent="   "):
    """把登记表里的一条缺口渲染成结论行。**语句由登记表决定，不由散文决定。**

    ★ 未登记时**也必须打印标记**。第一版在这里返回了一句不带 `〔缺口:…〕` 的
      「未登记」，于是悬空检查永远不会触发 —— 反向对照 RC1a 实测：把 KB-GAP-1 换成
      KB-GAP-99，E1 仍然全绿，只有恰好也变了的 E4 报了红。**标记就是引用本身**，
      引用不成立时更要留下能被检查的痕迹。
    """
    reg = _gaps()
    g = reg.get(gid)
    if g is None:
        return [f"{indent}⚠️ **未登记**〔缺口:{gid}〕缺口 {gid} 不在 缺口-v1.json 里"
                f" ——「已登记」这句话当前是假的"]
    qty = json.dumps(g["量"], ensure_ascii=False) if "量" in g else "量不可重算（已声明理由）"
    return [f"{indent}→ 已登记 〔缺口:{gid}〕{g['title']}　[{qty}]"
            f"　责任人={g['owner']}　状态={g['status']}",
            f"{indent}  复算：{g['复算']}"]


def _gaps():
    """读**盘上**的登记表，不是现算一份。

    「已登记」指的是「写下来了」，所以必须读制品。现算一份会让这句话永远为真 ——
    B3.0 第一版就是这样：`kb_gaps.build()` 每次现算，于是「登记表里有没有这一条」
    这个问题被自己回答了，检查恒绿。（同一轮里 E2 也犯了同样的错，见 verify_kb。）
    """
    path = os.path.join(load.KB, "缺口-v1.json")
    if not os.path.exists(path):
        return {}
    return {g["id"]: g for g in json.load(open(path, encoding="utf-8"))["gaps"]}


def q8(led, rs):
    """本地已有证据能支撑哪些需求？哪些需求零证据？"""
    ev = json.load(open(EVIDENCE, encoding="utf-8"))
    t = ev["totals"]
    out = [f"已声明品线专属证据 {t['declared_evidence']} 项，"
           f"覆盖 {t['lines_with_evidence']}/{len(ev['rows'])} 个品线族"]
    for row in ev["rows"]:
        mark = "✅" if row["已声明证据数"] else "❌"
        out.append(f"  {mark} {row['品线族']:<8} 证据 {row['已声明证据数']:>2}  "
                   f"对应需求 {row['需求条数']:>4} 条  {row['证据分级']}")
    zero = sum(r["需求条数"] for r in ev["rows"] if not r["已声明证据数"])
    out.append(f"\n**零证据品线共 {zero} 条需求，占已归入品线的 "
               f"{zero/t['demands_mapped']:.0%}**")
    out.append("本地全部合规证据只覆盖吸奶器一个品线。")
    return out


def q9(led, rs):
    """哪些需求类型反复出现、具备规则化/自动化潜力？"""
    c = collections.Counter(r["category"] for r in rs if r.get("category"))
    out = ["按类别（需求类型 / 性质 / 渠道）统计："]
    for k, n in c.most_common(16):
        out.append(f"  {n:>4}  {k}")
    names = collections.Counter()
    for r in rs:
        t = str(r.get("title") or "")
        for sep in ("：", ":"):
            if sep in t:
                names[t.split(sep)[0].strip()[:20]] += 1
                break
    out.append("\n标题前缀反复出现（疑似可模板化的批量作业）：")
    for k, n in names.most_common(10):
        if n >= 3:
            out.append(f"  {n:>4}  {k}")
    return out


def q10(led, rs):
    """4 类知识库各有多少条、缺什么、谁负责？"""
    # ★ B3.2 起读**盘上的 4 类登记表**（生成物），不再读 kb_materials_lark 里
    #   手抄的那份 CATEGORIES —— 手抄的现状会漂，而这一问的全部内容就是现状。
    import kb_classes
    path = os.path.join(load.KB, "知识库-v1.json")
    doc = json.load(open(path, encoding="utf-8")) if os.path.exists(path) else None
    if doc is None:
        return ["❌ **GAP：4 类登记表不存在**（`research/kb/知识库-v1.json`）",
                "   复算：python3 tools/kb_classes.py"]
    m = doc["材料收集"]
    out = [f"材料收集 {m['总数']} 条：可程序读取 {m['可程序读取']} / 不可读 {m['不可读']}"
           f"　未分类 {m['未分类']}",
           f"  按性质：{json.dumps(m['按性质'], ensure_ascii=False)}",
           f"  按归属：{json.dumps(m['按归属'], ensure_ascii=False)}",
           ""]
    for c in doc["classes"]:
        out.append(f"── {c['知识库']}  【{c['状态']}】〔缺口:{c['缺口编号']}〕")
        out.append(f"   负责人：{c['负责人']}")
        out.append(f"   现有：  {c['本地现有条目']}")
        out.append(f"   缺口：  {c['缺口说明']}")
    # 反向对照：登记表与现算必须一致，否则这一问在念一份过期的稿子
    if kb_classes.build() != doc:
        out.append("")
        out.append("⚠️ **登记表已过期**（与 kb_classes.build() 不一致）——"
                   "修复：python3 tools/kb_classes.py")
    return out


QUESTIONS = [
    ("多少条在跑、来自哪些系统", q1),
    ("哪些逾期、逾期多久", q2),
    ("每个品线压了多少、哪条最紧", q3),
    ("每个负责人手上多少条", q4),
    ("哪些需求跨系统重复", q5),
    ("哪些已完成但没有产出物", q6),
    ("哪些卡在同一状态超过阈值", q7),
    ("哪些需求有证据、哪些零证据", q8),
    ("哪些需求类型可规则化", q9),
    ("4 类知识库各有多少、缺什么、谁负责", q10),
]


def render_manual(led, sections):
    """渲染查询手册全文。**抽成函数是为了让验收器能重算一遍再逐字比对** ——
    生成物只检查「有 10 节」是不够的：手册会腐烂，而腐烂是静默的。"""
    md = ["# 需求知识库 · 查询手册", "",
          f"> 快照 `{led['snapshot_id']}`　台账 "
          f"{sum(1 for r in led['records'] if r['role'] != 'excluded')} 条",
          f"> 基准日 `{load.basis_date()}`（= 快照日，不是今天）",
          "> 每条问题配一条可复现命令：`python3 tools/kb_query.py <N>`",
          "",
          "> ⚠️ **本文件是生成物**：`python3 tools/kb_query.py --md` 重写它。",
          "> 手改会被 `tools/verify_kb.py` 的 E4 逐字比对抓住。", ""]
    for i, name, lines in sections:
        # ★ D37：标题带前缀。裸写的黄金问题编号与台账未决项同名不同物 ——
        #   命令行入口保持数字（`kb_query.py 7`），因为它是一个**地址**不是一个编号。
        md.append(f"## KB-Q-{i}. {name}")
        md.append("")
        md.append(f"```bash\npython3 tools/kb_query.py {i}\n```")
        md.append("")
        md.append("```")
        md.extend(lines)
        md.append("```")
        md.append("")
    md.append("## 一页纸速查")
    md.append("")
    md.append("| # | 问题 | 一句话答案 |")
    md.append("|---|---|---|")
    for i, name, lines in sections:
        md.append(f"| {i} | {name} | {lines[0][:70]} |")
    md.append("")
    return "\n".join(md)


def main():
    want = None
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if args:
        want = int(args[0])
    led, rs = load_all()

    print(f"═══ 需求知识库 · 黄金问题（快照 {led['snapshot_id']}）═══\n")
    sections = []
    for i, (name, fn) in enumerate(QUESTIONS, 1):
        if want and i != want:
            continue
        lines = fn(led, rs)
        print(f"KB-Q-{i}. {name}")
        for l in lines:
            print(f"   {l}")
        print()
        sections.append((i, name, lines))

    if "--md" in sys.argv:
        open(MANUAL, "w", encoding="utf-8").write(render_manual(led, sections))
        print(f"→ {os.path.relpath(MANUAL, load.REPO)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

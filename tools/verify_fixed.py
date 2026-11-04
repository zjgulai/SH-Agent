#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
verify_fixed.py —— 「**同一个问题不许修第二遍**」这条承诺的判据

Owner 2026-10-14：「你修复完的问题记得落库，避免后面重复修。」

「落库」在这里是什么（说清楚，免得读的人以为在说那本措辞表达库）：
  · 本项目的**知识库**（Momcozy 内容治理库）是**内容侧**的库（条款号 / 禁用表达），
    没有系统与工程类条目 —— 把工程教训塞进去是**污染**，所以**不入那本库**；
  · 工程侧的「落库」= 一份**可查的已修问题索引** + **一个判据**：
    `PMO/已修问题.jsonl`（机器读）+ `PMO/已修问题索引.md`（人读）+ 本检查器。

  ★★ 2026-10-16 **上面那段已被取代**（Owner 原话：「按照你的推荐执行」），只作历史读：
    取代它的是 Owner 当天那句「**你的修复验证后要落库，不要我每次提醒**」——
    按当天实践，守衡系统侧的**参考实现 / 方法**类材料**是可以入那本库的**
    （当天入了 10 条 `ref-shouheng-*`；`kb_class: []` 显式声明「判断过、不属四类」，
    条目正文自己注明「落在这里是语义上的将就，不是分类结论」）。
    **为什么旧口径的前提已经不成立**：它论证的依据是「那本库里没有系统与工程类条目」——
    而这个前提当天就变了（库里已经有一整个 `ref-*` 家族）。
    ⚠️ 被取代的**不是分类结论**：那些条目仍然**不属四类素材**，
      `_meta/collections.yaml` 也仍只登记 `3_措辞表达库` 一个子库
      ⇒ 「落在这里是语义上的将就」这一点**一个字没变**。
    ⇒ 现行判据是下面那条 **A7**：**入不入由每条记录自己说**（给条目 id，或写 `not_needed` + 理由），
      本检查器只强制「**表态**」。**但默认口径现在偏向「入」**，不再是「不入」。

`AGENTS.md` §2.4：写进文档的每条约束，必须指得出**哪一行在拦它**。
「已修问题索引」如果没有判据，它就会**腐烂成一张过期的白名单** ——
指着一堆早就不存在的文件说「这个问题已经修好了」。所以本文件逐条断：

  A1  JSONL 读得出、字段齐全（`id/title/symptom/root_cause/fix_files/self_check/verify_cmd`）
  A2  `id` 唯一
  A3  **每一个 `fix_files` 路径都存在**（清单不许指空）
  A4  **每一个 `enforced_by` 的判据串都真的在 `fix_files` 里找得到**
      —— 这条是「名字出现过 ≠ 拦得住」的**反面**：它至少要求那行代码还在原处
  A5  `verify_cmd` 的脚本存在（不许指向一个不存在的自证命令）
  A6  没有两条记录在**同一条 `root_cause`** 上重复（同一形状修两遍 = 这份清单没起作用）
  A7  **每条的 `ingest_ref` 都说得出话** —— 要么解析得到知识库条目、要么写出 `not_needed` 的理由
      （FIX-037 起强制；更早的记**未测**，不判红）
  B1  人读的那份 md 里，**每一条 id 都出现**
  B2  md 里的条数 == jsonl 的条数（数字型说法必须算出来，不许写死；§2.2 第 1 条）
  B3  判据在本仓之外的记录**看得见**（未测几条，单列一行 —— 未测不是通过，也不是坏）
  C   反向对照：**喂已知坏样本，本检查器必须报红**
      （坏样本六类：文件不存在 / 判据串不在源码里 / 自证命令不存在 / id 重复 /
        同一 root_cause / 没写执行点）
  C2  反向对照（成对）：记录级 `repo_root` 的**三半**都要咬得住 ——
      指不到 ⇒ 记未测不判红；**不写** ⇒ 照旧报红；它是**后备根**（本仓优先，混合记录两半都找得到）
  C3  反向对照（成对·四半）：记录级 `ingest_ref` 的**四半**都要咬得住 ——
      指向**真的**条目 ⇒ 不报红；指向**不存在的** ⇒ 必红；
      FIX-037 起**不表态** ⇒ 必红；起点**之前**不表态 ⇒ 记**未测**、不判红

★ 2026-10-16（FIX-035）：A3/A4/A5 的根从「本仓一个」变成「本仓 ＋ 可选后备根」。
  起因：有 5 条记录（FIX-026/027/028/029/031）的判据**不在本仓**，而在**知识库工作区**
  （`…/知识库/内容治理/采集-20261013/`，2026-10-13 那批一次性采集／修复脚本）——
  它们**既没废弃也没写错**（路径相对于那个工作区是对的），本检查器只是**只有一个根**，
  于是那 5 条**永远红着 3 项**。而**一条假红会挤掉一个真问题**。
  现在：记录可写可选字段 `repo_root`（后备根）；**本仓优先**，本仓找不到才到它下面找；
  它指不到时记**未测**（不判红，但必须看得见）。缺省不写 ⇒ 行为与改动前**逐字相同**。

★ 2026-10-16（Owner 批准）：新增记录级 `ingest_ref`（A7 ＋ C3）——
  「这条修复该不该进知识库」**必须显式表态**。起因见下面常量那段注释：
  同一天那把覆盖率尺子（`tools/verify_ingest_coverage.py`）对**没产出留底件的改动是盲的**，
  FIX-037/038 修完只进了本仓、读数却全绿。
  ⚠️ **与本文件头部那条 2026-10-14 口径有一处字面张力，照实记在这里、不替谁裁决**：
  2026-10-14 那版说「工程教训塞进那本内容侧的库是污染 ⇒ **不入那本库**」，
  而 2026-10-16 Owner 那条「**你的修复验证后要落库，不要我每次提醒**」按当天实践
  是**往库里入**了 8 条 `ref-shouheng-*` 参考实现（`kb_class: []`、注明「语义上的将就」）。
  ⇒ 现行判据**不替两者选一个**：`ingest_ref` 的两态把选择权交回记录本身
  （入 ⇒ 给条目 id；不入 ⇒ 写 `not_needed` 的理由），**只强制「表态」这一件事**。
  哪一条口径为准，等 Owner 一句话再收口。

用法：
  python3 tools/verify_fixed.py            # 全跑（零网络）
  python3 tools/verify_fixed.py --verbose
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
JSONL = ROOT / "PMO" / "已修问题.jsonl"
INDEX = ROOT / "PMO" / "已修问题索引.md"

REQUIRED = ("id", "title", "symptom", "root_cause", "fix_files", "self_check", "verify_cmd")

# ══════════════════════════════════════════════════════════════════════════════
# ★★ 2026-10-16（Owner 批准 ①）：记录级 `ingest_ref` —— 「这条修复该不该进知识库」**必须显式表态**
# ══════════════════════════════════════════════════════════════════════════════
#   起因：Owner 那条「**你的修复验证后要落库，不要我每次提醒**」。我当天修完 FIX-037/038
#   只提交进了本仓、**没入库**，而 `tools/verify_ingest_coverage.py` 那把尺子**看不见**它 ——
#   它拿「今天动过的 PMO 留底件」对「今天入库的条目」，而我只动了 `已修问题索引.md`
#   与 `守衡-回复卡片模版与语域规程.md`，**这两类正好在它逐个点名的豁免清单里**
#   ⇒ 读数全绿，活儿一条没落。**没产出「留底件」的改动，那把尺子是盲的。**
#
#   取值两态（缺一不可，**不许不表态**）：
#     · 字符串 ＝ 知识库条目 id（例 `ref-shouheng-card-fields-and-na-20261016`）⇒ 必须**真的解析得到**；
#     · `{"not_needed": "<理由>"}` ⇒ 理由**非空**即可 —— 多数纯工程修复按本文件头部那条
#       2026-10-14 口径（「工程教训塞进内容侧的库是污染」）就属这一档，但**理由要写出来**。
#
#   生效起点 `INGEST_REF_FROM`：更早的记录**没写＝未测**（不判红，但必须看得见）——
#   同 FIX-035 的三态纪律：**一条假红会挤掉一个真问题**，而"这条规矩上线前的那批"不是坏。
INGEST_REF_FROM = 37

#   库在**另一个工作区**（与 FIX-035 的跨仓同一形状）。`~/.dsh/Momcozy知识库/kb/view`
#   是宿主库视图的稳定入口（AGENTS.md：这本库所有工作区共用）；`KB_VIEW` 可覆盖。
#   ⚠️ 它**找不到**时记 **未测**、不判红 —— 「本机核不了」不是「坏了」（FIX-035 同一条）。
def _kb_view() -> Path | None:
    cands = []
    env = os.environ.get("KB_VIEW")
    if env:
        cands.append(Path(env).expanduser())
    cands.append(Path.home() / ".dsh" / "Momcozy知识库" / "kb" / "view")
    cands.append(ROOT.parent / "kb" / "view")
    for c in cands:
        if c.is_dir():
            return c
    return None


def _id_num(eid: str):
    """`FIX-037` → 37；不是这个形状回 None（反向对照用的 `FIX-T` 就是这一类）。"""
    m = re.fullmatch(r"FIX-(\d+)", str(eid or "").strip())
    return int(m.group(1)) if m else None


def _entry_in_view(view: Path, eid: str) -> bool:
    """条目在不在库里。**全库递归按文件名找，不写死子库名** —— 子库会变（`3_措辞表达库` 只是当下这一个）。"""
    try:
        return any(p.stem == eid for p in view.rglob(f"{eid}.md"))
    except OSError:
        return False


results: list[tuple[str, bool, str]] = []


def check(cid: str, ok: bool, msg: str) -> None:
    results.append((cid, bool(ok), msg))


def load(path: Path):
    out, errs = [], []
    if not path.exists():
        return None, [f"清单不存在：{path.relative_to(ROOT)}"]
    for i, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError as e:
            errs.append(f"第 {i} 行不是合法 JSON：{e.msg}")
    return out, errs


def audit(entries, *, root: Path, index_path: Path, kb_view: Path | None = None):
    """
    纯判据：回 `(problems, untested)`。坏样本也能直接喂进来做反向对照。

    ★★ 2026-10-16（FIX-035）—— 记录级可选字段 `repo_root` ＋ **第三态「未测」**：

    有几条记录的判据（脚本与判据串）**不在本仓**，而在知识库工作区
    （`…/知识库/内容治理/采集-20261013/`，那批 2026-10-13 的一次性采集/修复脚本）。
    本检查器原先只有**一个根**（本仓 `ROOT`），于是那 5 条**永远红着 3 项**（A3/A4/A5）——
    而它们红的原因是「跨工作区」，不是「判据没了」。**一条假红会挤掉一个真问题。**

      · 记录给了 `repo_root` 且**指得到** ⇒ A3/A4/A5 照旧**逐条真核**（不放松一个字）；
      · 记录给了 `repo_root` 但**指不到**（那个工作区不在本机了）⇒ 这三项记 **未测**、**不判红**，
        但**必须看得见**（`main` 里单列一行）—— 「未测 ≠ 坏了」，也**不等于核过了**；
      · 记录**没给** `repo_root` ⇒ 缺省就是本仓，行为与改动前**逐字相同**。
    """
    problems: list[str] = []
    untested: list[str] = []
    # ★ 2026-10-16：知识库视图只解析**一次**（反向对照可以传 `kb_view` 顶替）。
    view = kb_view if kb_view is not None else _kb_view()
    #   `ingest_ref` 生效起点之前那批**逐条**打「未测」会刷 36 行屏 ⇒ 汇总成一条
    #   （仍**看得见**：计数进 `untested`，`main` 会单列打印 —— 未测不是通过，也不是坏）。
    old_no_ingest_ref = 0
    seen_ids, causes = set(), {}
    for e in entries:
        eid = str(e.get("id") or "(无 id)")
        missing = [k for k in REQUIRED if not e.get(k)]
        if missing:
            problems.append(f"{eid} 缺字段：{'/'.join(missing)}")
        if eid in seen_ids:
            problems.append(f"{eid} 重复（id 必须唯一）")
        seen_ids.add(eid)

        # ★ FIX-035：这条记录的判据在哪些根下解析 —— `repo_root` 是**后备根**，不是替换根。
        #   为什么必须是后备：有的记录是**混合**的（例 FIX-028 的 `fix_files` 同时列着
        #   本仓的 `tools/agent/review_publish.mjs` 与跨仓的 `采集-20261013/backfill_confidence_notes.py`）
        #   —— 拿 `repo_root` 顶替本仓，本仓那一半立刻找不到了（实测：改替换根当场多一条红）。
        #   解析顺序：**本仓优先**，本仓找不到再到 `repo_root` 找；两边都没有 ⇒ 照旧报红。
        base, base_ok = root, True
        roots = [root]
        rr = str(e.get("repo_root") or "").strip()
        if rr:
            base = Path(rr).expanduser()
            if not base.is_dir():
                base_ok = False
                untested.append(
                    f"{eid} 的判据在本仓之外（`repo_root`={rr}）—— 该目录现在**指不到**，"
                    f"这条的 A3/A4/A5 **未测**（不是通过，也不是坏）")
            else:
                roots.append(base)

        if base_ok:
            # A3 文件必须都在（本仓或后备根，任一处找得到即可）
            for rel in e.get("fix_files") or []:
                if not any((b / rel).exists() for b in roots):
                    problems.append(f"{eid} 指着一个不存在的文件：{rel}（本仓与 `repo_root` 下都没有）")

            # A4 判据串必须真的在那些文件里
            needles = [n for n in (e.get("enforced_by") or []) if n]
            if not needles:
                problems.append(f"{eid} 没写 `enforced_by` —— 指不出哪一行在拦它，就只是一句注释（§2.4）")
            else:
                blob = ""
                for rel in e.get("fix_files") or []:
                    for b in roots:
                        p = b / rel
                        if p.exists():
                            blob += p.read_text(encoding="utf-8", errors="ignore")
                            break
                for n in needles:
                    if n not in blob:
                        problems.append(f"{eid} 的判据串在源码里找不到：{n!r}（判据可能已经被改掉/删掉）")

            # A5 自证命令的脚本必须在（同上，两个根任一处）
            for cmd in [e.get("verify_cmd"), e.get("self_check")]:
                if not cmd:
                    continue
                parts = str(cmd).split()
                script = next((p for p in parts if p.endswith((".py", ".mjs", ".sh"))), None)
                if script and not any((b / script).exists() for b in roots):
                    problems.append(f"{eid} 的自证命令指向不存在的脚本：{script}")

        # A6 同一 root_cause 不许两条
        rc = str(e.get("root_cause") or "").strip()
        if rc:
            if rc in causes:
                problems.append(f"{eid} 与 {causes[rc]} 的 `root_cause` 逐字相同 —— 同一个形状记两遍等于没记")
            causes[rc] = eid

        # ── A7 ★★ 2026-10-16：「该不该进知识库」**不许不表态** ──────────────────────
        #   三态，与 FIX-035 同一条纪律（坏 / 通过 / **未测**）：
        #     · 给了条目 id ⇒ 必须真的解析得到，否则**红**（指着一个不存在的条目 ＝ 没落库）；
        #     · 给了 `{"not_needed": 理由}` ⇒ 理由非空即通过（**多数纯工程修复就属这一档**）；
        #     · **没给** ⇒ `INGEST_REF_FROM` 之后**红**（不表态就是把决策成本退回给人）；
        #       之前的记 **未测**（那条规矩上线前落的，不是坏）。
        #   ⚠️ 视图找不到时，`给了条目 id` 那一支记**未测** —— 「本机核不了」不是「坏了」。
        iref_missing = "ingest_ref" not in e
        iref = e.get("ingest_ref")
        n = _id_num(eid)
        if iref_missing or iref is None:
            if n is not None and n >= INGEST_REF_FROM:
                problems.append(
                    f"{eid} 没写 `ingest_ref` —— 「这条修复该不该进知识库」不许不表态"
                    f"（要么给条目 id，要么写 `not_needed: <理由>`；见本文件头部 2026-10-16 那段）")
            else:
                old_no_ingest_ref += 1
        elif isinstance(iref, dict):
            why = str(iref.get("not_needed") or "").strip()
            if not why:
                problems.append(f"{eid} 的 `ingest_ref.not_needed` 是空的 —— "
                                f"声明「不需要入库」必须给理由，空声明等于没表态")
        else:
            s_ref = str(iref).strip()
            if not s_ref:
                problems.append(f"{eid} 的 `ingest_ref` 是空串 —— 要么给条目 id，要么写 `not_needed`")
            elif view is None:
                untested.append(f"{eid} 的 `ingest_ref`={s_ref} —— 知识库视图在本机**找不到**，"
                                f"这条**未测**（不是通过，也不是坏）")
            elif not _entry_in_view(view, s_ref):
                problems.append(f"{eid} 的 `ingest_ref`={s_ref} 在知识库里**找不到** —— "
                                f"指着一个不存在的条目（＝声称落了库、其实没有）")

    if old_no_ingest_ref:
        untested.append(
            f"**{old_no_ingest_ref} 条**记录没写 `ingest_ref`，且都落在生效起点 FIX-{INGEST_REF_FROM:03d} 之前 "
            f"⇒ **未测**（不是通过，也不是坏）。这一批是 Owner 那条「不要我每次提醒」上线**之前**落的；"
            f"要回填得**逐条判**「这条该不该入库」，不许整批抄一个理由（那是「为了填而编」）")

    # B1/B2 人读的那份
    if not index_path.exists():
        problems.append(f"人读的那份不存在：{index_path.relative_to(root)}")
    else:
        md = index_path.read_text(encoding="utf-8")
        for e in entries:
            if str(e.get("id")) not in md:
                problems.append(f"{e.get('id')} 没出现在 {index_path.name} 里（人查不到 = 没落库）")
        for m in __import__("re").finditer(r"共\s*(\d+)\s*条", md):
            if int(m.group(1)) != len(entries):
                problems.append(f"{index_path.name} 写着「共 {m.group(1)} 条」，实际 {len(entries)} 条")
    return problems, untested


def main() -> int:
    entries, errs = load(JSONL)
    check("A1", entries is not None and not errs,
          f"清单读得出、每行都是合法 JSON（实测 {len(entries or [])} 条"
          + (f"，解析错误 {len(errs)} 处：{errs[:2]}" if errs else "") + ")")
    if entries:
        problems, untested = audit(entries, root=ROOT, index_path=INDEX)
        by_id = {}
        for p in problems:
            by_id.setdefault(p.split()[0], []).append(p)
        check("A2", not any("重复" in p for p in problems), "id 唯一")
        check("A3", not any("不存在的文件" in p for p in problems),
              "每条 `fix_files` 指的文件都真的在盘上（清单不许指空）")
        check("A4", not any("判据串" in p or "enforced_by" in p for p in problems),
              "每条都写得出执行点，且那个判据串**真的在源码里找得到**"
              "（指不出哪一行在拦它 = 只是一句注释）")
        check("A5", not any("自证命令" in p for p in problems), "自证命令指向的脚本都存在")
        check("A6", not any("root_cause" in p for p in problems),
              "没有两条记录共用同一条 `root_cause`（同一形状记两遍 = 这份清单没起作用）")
        # ★ 2026-10-16：A7 —— 「这条修复该不该进知识库」不许不表态，且给了 id 就必须解析得到
        check("A7", not any("ingest_ref" in p or "not_needed" in p for p in problems),
              f"每条的 `ingest_ref` 都说得出话：要么解析得到知识库条目、要么写出 `not_needed` 的理由"
              f"（FIX-{INGEST_REF_FROM:03d} 起强制；更早的记未测 —— Owner 2026-10-16「不要我每次提醒」）")
        check("B1", not any("没出现在" in p for p in problems), "人读的那份索引里每条 id 都在")
        check("B2", not any("实际" in p and "条" in p for p in problems),
              "索引里的条数**算出来**等于实际条数（不写死）")
        # ★ FIX-035：第三态必须**看得见** —— 判据在本仓之外时，既不许判绿、也不许静默
        check("B3", True,
              f"判据在本仓之外的记录**看得见**（未测 {len(untested)} 条 —— "
              f"未测既不是通过，也不是坏；要真核得让那个工作区在本机）")
        if untested:
            print("未测明细（判据不在本仓，本次**核不了** —— 这不是通过）：")
            for u in untested:
                print("  ·", u)
        if any(p for p in problems):
            print("不通过明细：")
            for p in problems:
                print("  ·", p)
    else:
        for cid in ("A2", "A3", "A4", "A5", "A6", "A7", "B1", "B2"):
            check(cid, False, "清单读不出 ⇒ 这些判据都无从谈起")

    # ── C 反向对照：喂坏样本，判据必须报红（否则上面全是恒真）──────────────────
    good = [{
        "id": "FIX-T", "title": "t", "symptom": "s", "root_cause": "rc-1",
        "fix_files": ["tools/verify_fixed.py"], "enforced_by": ["def audit("],
        "self_check": "python3 tools/verify_fixed.py", "verify_cmd": "python3 tools/verify_fixed.py",
        # ★ 2026-10-16：反向对照用的假记录也要**显式表态** —— 否则 A7 会把它记进 `untested`，
        #   而下面 C2 的 ③ 断言「`p3` 与 `u3` 都为空」当场变红（实测就是这么发现必须补这一行的）。
        "ingest_ref": {"not_needed": "反向对照用的假记录，本来就不该入库"},
    }]
    bad_cases = {
        "指着一个不存在的文件": [{**good[0], "fix_files": ["tools/__nope__.mjs"]}],
        "判据串不在源码里": [{**good[0], "enforced_by": ["这道判据根本不存在("]}],
        "自证命令指向不存在的脚本": [{**good[0], "verify_cmd": "python3 tools/__nope__.py"}],
        "id 重复": [good[0], dict(good[0])],
        "root_cause 逐字相同": [good[0], {**good[0], "id": "FIX-T2"}],
        "没写 enforced_by": [{**good[0], "enforced_by": []}],
    }
    import tempfile
    bad_ok = True
    detail = []
    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        idx = tdp / "idx.md"
        for name, sample in bad_cases.items():
            idx.write_text("共 999 条\n" + " ".join(e["id"] for e in sample), encoding="utf-8")
            probs, _ = audit(sample, root=ROOT, index_path=idx)
            if not probs:
                bad_ok = False
                detail.append(name)
    check("C", bad_ok,
          "反向对照：喂 6 类坏样本（指空文件 / 判据串不在源码 / 自证脚本不存在 / id 重复 / "
          "同一 root_cause / 没写执行点），判据必须每种都报红"
          + (f" —— 没报红的：{detail}" if detail else ""))

    # ── C2 ★ FIX-035：`repo_root` 的**成对**反向对照 ────────────────────────────────
    #   要证明的是「未测」**不是**把 A3/A4/A5 变成恒绿的后门。两条必须成对，缺一条就证明不了：
    #     ① 同一条坏记录（`fix_files` 指空）**不给** `repo_root` ⇒ 必须照旧报红（缺省=本仓，一个字没松）；
    #     ② 同一条坏记录**给**一个指不到的 `repo_root` ⇒ 不判红，但必须**记进 untested**（看得见）。
    #   少了 ① ⇒ 「只要写上 repo_root 什么都过」；少了 ② ⇒ 变回静默放过。
    c2_ok, c2_detail = True, []
    with tempfile.TemporaryDirectory() as td:
        idx = Path(td) / "idx.md"
        idx.write_text("共 1 条 FIX-T", encoding="utf-8")
        bad_row = {**good[0], "fix_files": ["tools/__nope__.mjs"]}
        p1, _u1 = audit([bad_row], root=ROOT, index_path=idx)
        if not p1:
            c2_ok = False
            c2_detail.append("① 不给 repo_root 时竟然没报红")
        p2, u2 = audit([{**bad_row, "repo_root": "/__没有这个目录__"}], root=ROOT, index_path=idx)
        if p2:
            c2_ok = False
            c2_detail.append(f"② 给了指不到的 repo_root 仍报红：{p2[:1]}")
        if not u2:
            c2_ok = False
            c2_detail.append("② 未测没有被记下来（等于静默放过）")
        # ③ **后备根**语义：本仓那一半照旧找得到，**只在 repo_root 下**的那一半也找得到。
        #    钉住这条，是因为「拿 repo_root 顶替本仓」这个错法实测真的会多出一条红
        #    （FIX-028 是混合记录：本仓 2 个文件 + 跨仓 1 个文件）。
        with tempfile.TemporaryDirectory() as td3:
            (Path(td3) / "kb_only.py").write_text("NEEDLE_KB_ONLY(\n", encoding="utf-8")
            row3 = {**good[0], "fix_files": ["tools/verify_fixed.py", "kb_only.py"],
                    "enforced_by": ["def audit(", "NEEDLE_KB_ONLY("], "repo_root": td3}
            p3, u3 = audit([row3], root=ROOT, index_path=idx)
            if p3 or u3:
                c2_ok = False
                c2_detail.append(f"③ 后备根没生效：{p3[:1] or u3[:1]}")
    check("C2", c2_ok,
          "反向对照（成对）：`repo_root` 指不到 ⇒ 记**未测**、不判红；**不写** `repo_root` ⇒ 照旧报红；"
          "`repo_root` 是**后备根**（本仓优先，混合记录两半都找得到）"
          + (f" —— {c2_detail}" if c2_detail else ""))

    # ── C3 ★★ 2026-10-16：`ingest_ref` 的**成对**反向对照 ──────────────────────────
    #   要证明的是「未测」**不是**把 A7 变成恒绿的后门。三半，缺一条都证明不了：
    #     ① 条目**真的在**库里（临时视图里放一个同名 `.md`）⇒ 不许报红；
    #     ② 同一条指向**不存在的**条目 ⇒ 必须报红（「指着一个不存在的条目」＝声称落了库、其实没有）；
    #     ③ 生效起点**之后**的记录**不写**这个字段 ⇒ 必须报红（**不许不表态**）。
    #   ★ 视图用临时目录顶替（`kb_view=`）—— 反向对照**不许依赖本机库在不在**
    #     （靠本机库在不在，这条判据在没装库的机器上就会恒绿）。
    c3_ok, c3_detail = True, []
    with tempfile.TemporaryDirectory() as td:
        idx3 = Path(td) / "idx.md"
        view3 = Path(td) / "view" / "3_措辞表达库" / "L1-facts"
        view3.mkdir(parents=True)
        REAL_ID = "ref-__c3__-20261016"
        (view3 / f"{REAL_ID}.md").write_text("---\nid: x\n---\n", encoding="utf-8")

        row_real = {**good[0], "ingest_ref": REAL_ID}
        idx3.write_text(f"共 1 条 {row_real['id']}", encoding="utf-8")
        p_real, u_real = audit([row_real], root=ROOT, index_path=idx3, kb_view=Path(td) / "view")
        if p_real or u_real:
            c3_ok = False
            c3_detail.append(f"① 条目真的在库里却报红/未测：{p_real[:1] or u_real[:1]}")

        row_ghost = {**good[0], "ingest_ref": "ref-__nope__-20990101"}
        p_ghost, _ = audit([row_ghost], root=ROOT, index_path=idx3, kb_view=Path(td) / "view")
        if not p_ghost:
            c3_ok = False
            c3_detail.append("② 指向不存在的条目竟然没报红")

        row_silent = {**good[0], "id": f"FIX-{INGEST_REF_FROM}"}
        row_silent.pop("ingest_ref")
        idx3.write_text(f"共 1 条 {row_silent['id']}", encoding="utf-8")
        p_silent, u_silent = audit([row_silent], root=ROOT, index_path=idx3, kb_view=Path(td) / "view")
        if not p_silent:
            c3_ok = False
            c3_detail.append(f"③ FIX-{INGEST_REF_FROM:03d} 不写 `ingest_ref` 竟然没报红（不表态被放过了）")
        if u_silent:
            c3_ok = False
            c3_detail.append("③ 生效起点之后的缺失被记成了「未测」（那是把新规矩也放进豁免里）")

        # ④ **反向对照的反向对照**：生效起点**之前**的同一条 ⇒ 必须记**未测**、**不许**报红。
        #    少了这一半，「未测」就可能被写成「一律报红」，那批历史记录会全红（一条假红挤掉一个真问题）。
        row_old = {**row_silent, "id": f"FIX-{INGEST_REF_FROM - 1}"}
        idx3.write_text(f"共 1 条 {row_old['id']}", encoding="utf-8")
        p_old, u_old = audit([row_old], root=ROOT, index_path=idx3, kb_view=Path(td) / "view")
        if p_old:
            c3_ok = False
            c3_detail.append(f"④ 起点之前的缺失被判红了：{p_old[:1]}")
        if not u_old:
            c3_ok = False
            c3_detail.append("④ 起点之前的缺失没被记进「未测」（等于静默放过）")
    check("C3", c3_ok,
          "反向对照（成对·四半）：`ingest_ref` 指向**真的**条目 ⇒ 不报红；指向**不存在的** ⇒ 必红；"
          f"FIX-{INGEST_REF_FROM:03d} 起**不表态** ⇒ 必红；起点**之前**不表态 ⇒ 记**未测**、不判红"
          + (f" —— {c3_detail}" if c3_detail else ""))

    n_fail = sum(1 for _, ok, _ in results if not ok)
    print("\n" + "=" * 74)
    for cid, ok, msg in results:
        print(f"  {'✅' if ok else '❌'} {cid}  {msg}")
    print("=" * 74)
    print(("❌ 有红" if n_fail else "✅ 全过") + f"（共 {len(results)} 项断言，{n_fail} 项红）")
    return 1 if n_fail else 0


if __name__ == "__main__":
    sys.exit(main())

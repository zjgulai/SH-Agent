#!/usr/bin/env python3
"""
verify_kb.py —— 需求知识库 · G1 验收器（机器可判定）

G1「存在性」的验收标准（建设方案 §二）：
    台账条数 = 各源系统可读条数之和；逐条回读比对 零丢失 / 零重复 / 零字段错位

本脚本把这句话拆成可执行的检查项，任何一项失败即退出码非 0。
**独立于生成器**：直接从快照原值与 schema 重算，不调用 tools/kb_build.py 的内部函数。

检查项：
  C1 计数守恒      台账真实条数 == 覆盖报告中所有 included 表的源条数之和
  C2 主键唯一      record_key 无重复
  C3 溯源可解      每条台账记录都能在快照里按 (系统,表,record_id) 找到
  C4 原文保真      status_raw / title(verbatim) 与快照原值逐条一致
  C5 状态归一      归一结果与 schema 声明一致；无"有值但未归一"
  C6 层级守恒      顶层 + 子任务 == 总数；子任务必须有 parent_record_id
  C7 覆盖完整      快照里每张表都出现在覆盖报告中（进或不进都要有理由）
  C8 敏感排除      排除表有占位记录，且其记录未进台账
  C9 可复现        台账的 fingerprint 重算一致
  C10 飞书回读     （若已落库）飞书条数与台账一致 —— 未落库时 SKIP，不算通过

★ E 组（B3.0 新增）守的是**治理**，不是数字：
  E1 缺口登记引用完整  每处 GAP 结论都必须带 〔缺口:ID〕，且该 ID 在 缺口-v1.json 里真实存在
                      —— 取代原先那条写成 `True` 的恒真检查（见 §KB-CHK-2 的历史）
  E2 缺口量可重算     每条缺口的「量」都要在 kb_facts 里重算对上；算不出来的必须显式声明
  E3 台账与快照同代    台账的 snapshot_id 必须等于当前快照 —— 基准日建在这上面
  E4 文档可重算        README 事实块与查询手册都必须是重算结果，手改/过期即红

用法：
  python3 tools/verify_kb.py
  python3 tools/verify_kb.py --json      # 机器可读
"""

import contextlib
import hashlib
import io
import json
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                "research", "kb"))
import load  # noqa: E402

SCHEMA = os.path.join(load.KB, "schema-v1.json")
LEDGER = os.path.join(load.KB, "台账-v1.json")
COVERAGE = os.path.join(load.KB, "覆盖报告.json")
ROUNDTRIP = os.path.join(load.KB, "_evidence", "feishu-roundtrip.json")


class Checks:
    def __init__(self):
        self.items = []

    def add(self, cid, name, ok, detail, skipped=False):
        self.items.append({"id": cid, "name": name,
                           "status": "SKIP" if skipped else ("PASS" if ok else "FAIL"),
                           "detail": detail})

    @property
    def failed(self):
        return [i for i in self.items if i["status"] == "FAIL"]

    @property
    def skipped(self):
        return [i for i in self.items if i["status"] == "SKIP"]


def main():
    as_json = "--json" in sys.argv
    schema = json.load(open(SCHEMA, encoding="utf-8"))
    ledger_doc = json.load(open(LEDGER, encoding="utf-8"))
    cov_doc = json.load(open(COVERAGE, encoding="utf-8"))
    snap = load.snapshot()
    c = Checks()

    records = ledger_doc["records"]
    real = [r for r in records if r["role"] != "excluded"]
    placeholder = [r for r in records if r["role"] == "excluded"]

    # ── C1 计数守恒 ──────────────────────────────────────────
    included = [x for x in cov_doc["coverage"] if x["included"]]
    expect = sum(x["source_records"] for x in included)
    c.add("C1", "计数守恒", len(real) == expect,
          f"台账 {len(real)} 条 vs 覆盖报告 included 源条数之和 {expect}")

    # ── C2 主键唯一 ──────────────────────────────────────────
    keys = [r["record_key"] for r in records]
    dup = [k for k, n in __import__("collections").Counter(keys).items() if n > 1]
    c.add("C2", "主键唯一", not dup, f"{len(keys)} 个键，重复 {len(dup)} 个" +
          (f"：{dup[:3]}" if dup else ""))

    # ── C3 溯源可解 ──────────────────────────────────────────
    missing = []
    srcmap = {}
    for spec in schema["tables"]:
        t = snap[(spec["system"], spec["name"])]
        for r in t.records:
            srcmap[(spec["system"], spec["table_id"], r["record_id"])] = r
    for r in real:
        k = (r["source_system"], r["source_table_id"], r["source_record_id"])
        if k not in srcmap:
            missing.append(r["record_key"])
    c.add("C3", "溯源可解", not missing,
          f"{len(real)} 条全部命中快照" if not missing else f"{len(missing)} 条指向不存在的源记录")

    # ── C4 原文保真 ──────────────────────────────────────────
    title_bad, status_bad, verbatim = [], [], 0
    for r in real:
        src = srcmap[(r["source_system"], r["source_table_id"], r["source_record_id"])]
        spec = next(s for s in schema["tables"]
                    if s["table_id"] == r["source_table_id"])
        m = spec["map"]
        if m.get("status_raw"):
            if load.flat(src["fields"].get(m["status_raw"])) != r["status_raw"]:
                status_bad.append(r["record_key"])
        if m.get("title") and r["title_source"] == "verbatim":
            verbatim += 1
            if load.flat(src["fields"].get(m["title"])) != r["title"]:
                title_bad.append(r["record_key"])
    ok4 = not title_bad and not status_bad
    c.add("C4", "原文保真", ok4,
          f"status_raw {len(real)} 条一致；verbatim 标题 {verbatim} 条一致"
          if ok4 else f"标题 {len(title_bad)} 条、状态 {len(status_bad)} 条与源不一致")

    # ── C5 状态归一 ──────────────────────────────────────────
    idx = {}
    for norm, raws in schema["status_normalization"].items():
        for x in raws:
            idx[x.strip().casefold()] = norm
    bad_norm = [r["record_key"] for r in real
                if r["status_raw"] and idx.get(str(r["status_raw"]).strip().casefold()) != r["status"]]
    unnorm = sorted({r["status_raw"] for r in real if r["status_raw"] and not r["status"]})
    c.add("C5", "状态归一", not bad_norm and not unnorm,
          f"归一后取值 {sorted({r['status'] for r in real if r['status']})}；"
          f"未归一 {len(unnorm)} 个" + (f"：{unnorm}" if unnorm else ""))

    # ── C6 层级守恒 ──────────────────────────────────────────
    top = sum(1 for r in real if r["level"] == "top")
    child = sum(1 for r in real if r["level"] == "child")
    orphan = [r["record_key"] for r in real if r["level"] == "child" and not r["parent_record_id"]]
    c.add("C6", "层级守恒", top + child == len(real) and not orphan,
          f"顶层 {top} + 子任务 {child} = {top + child}；无父的子任务 {len(orphan)}")

    # ── C7 覆盖完整 ──────────────────────────────────────────
    cov_keys = {(x["system"], x["table"]) for x in cov_doc["coverage"]}
    snap_keys = {(t.system, t.name) for t in snap.all()}
    uncovered = sorted(snap_keys - cov_keys)
    noreason = [f"{x['system']}:{x['table']}" for x in cov_doc["coverage"]
                if not x["included"] and not x.get("reason")]
    c.add("C7", "覆盖完整", not uncovered and not noreason,
          f"快照 {len(snap_keys)} 张表全部有覆盖记录；未进台账且无理由的 {len(noreason)} 张")

    # ── C8 敏感排除 ──────────────────────────────────────────
    excl_specs = schema.get("excluded_tables", [])
    excl_ids = {s["table_id"] for s in excl_specs}
    leaked = [r["record_key"] for r in real if r["source_table_id"] in excl_ids]
    have_ph = len(placeholder) == len(excl_specs)
    c.add("C8", "敏感排除", not leaked and have_ph,
          f"排除 {len(excl_specs)} 张表，占位 {len(placeholder)} 条，泄漏 {len(leaked)} 条")

    # ── C9 指纹可复算 ────────────────────────────────────────
    def fp(r):
        payload = {f: r.get(f) for f in ["title", "product_line", "sku", "status_raw",
                                         "priority_raw", "owner", "requester",
                                         "date_submitted", "date_due", "date_done"]}
        return hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True,
                                         default=str).encode()).hexdigest()
    fp_bad = [r["record_key"] for r in real if fp(r) != r["fingerprint"]]
    c.add("C9", "指纹可复算", not fp_bad,
          f"{len(real)} 条指纹重算一致" if not fp_bad else f"{len(fp_bad)} 条指纹不符")

    # ── C10 飞书回读 ─────────────────────────────────────────
    if os.path.exists(ROUNDTRIP):
        rt = json.load(open(ROUNDTRIP, encoding="utf-8"))
        c.add("C10", "飞书回读", rt.get("match", False),
              f"飞书 {rt.get('feishu_records')} 条 vs 台账 {len(real)} 条；"
              f"缺失 {rt.get('missing')} / 多余 {rt.get('extra')} / 字段不符 {rt.get('mismatch')}")
    else:
        c.add("C10", "飞书回读", False,
              f"未找到 {os.path.relpath(ROUNDTRIP, load.REPO)}（落库后生成）", skipped=True)

    # ── KB-CHK-1–KB-CHK-3 G3 可用性：10 条黄金问题 ───────────────────────
    try:
        sys.path.insert(0, os.path.join(load.REPO, "tools"))
        import kb_query
        import kb_gaps
        import kb_facts
        empty = []
        gaps = []
        unregistered = []
        for i, (name, fn) in enumerate(kb_query.QUESTIONS, 1):
            try:
                lines = fn(ledger_doc, real)
            except Exception as e:                            # noqa: BLE001
                empty.append(f"Q{i}({type(e).__name__})")
                continue
            if not lines or not any(str(x).strip() for x in lines):
                empty.append(f"Q{i}")
            if any("GAP" in str(x) for x in lines):
                gaps.append(f"Q{i}")
            # ★ 每处 GAP 都必须带登记标记，且标记里的编号必须真实存在（E1）。
            #   这正是原来的 KB-CHK-2 想守、却写成 `True` 而永远守不住的东西。
            #   判据写成「**声明 GAP 的那条问题**至少有一处标记」，而不是「每行」——
            #   后者会把 GAP 的标题行本身算成违规（第一版就误报了）。
            if any("GAP" in str(x) for x in lines) and \
                    not any("〔缺口:" in str(x) for x in lines):
                unregistered.append(f"Q{i}: 声明了 GAP 却没有任何登记标记")
        # ★ 名字里的「可答」会把「产出结论」读成「答得出来」。KB-Q-7 产出的是一个
        #   **登记过的 GAP**（不是答案）。所以这一条的文案必须把两者分开写：
        #   KB-CHK-1 守「有没有结论」，E1 守「结论里的空缺有没有落点」。
        c.add("KB-CHK-1", "黄金问题全部产出结论", not empty,
              (f"{len(kb_query.QUESTIONS)} 条全部产出结论 —— 其中 {len(gaps)} 条"
               f"（{gaps if gaps else '无'}）的结论是**登记过的 GAP**，不是答案；"
               f"「可答」的完整口径见 E1/E2"
               if not empty else f"{len(empty)} 条连结论都没有：{empty}"))

        # ── E1 缺口登记引用完整（取代原先恒为 True 的 KB-CHK-2）─────────
        #   ★ 一律读**盘上**的登记表：`kb_gaps.build()` 现算一份会让「登记表里
        #     有没有这一条」被自己回答 —— 第一版就是这样，检查恒绿。
        gap_path = os.path.join(load.KB, "缺口-v1.json")
        gap_doc = json.load(open(gap_path, encoding="utf-8")) if os.path.exists(gap_path) else None
        reg = {g["id"]: g for g in (gap_doc or {}).get("gaps", [])}
        seen_ids = set()
        missing = []
        for i, (name, fn) in enumerate(kb_query.QUESTIONS, 1):
            try:
                txt = "\n".join(str(x) for x in fn(ledger_doc, real))
            except Exception:                                 # noqa: BLE001
                continue
            # ★ D37：字符类必须含 `-`。改名后编号是 `KB-GAP-1`，而
            #   `[A-Za-z0-9_]+` 匹配不到连字符 —— 结果是**一处也匹配不上**，
            #   `seen_ids` 空、`missing` 空，E1 变成恒真。改名当天实测到过这一幕。
            for m in re.findall(r"〔缺口:([A-Za-z0-9_-]+)〕", txt):
                seen_ids.add(m)
                if m not in reg:
                    missing.append(m)
        if gap_doc is None:
            missing.append("<缺口-v1.json 不存在>")
        e1_bad = list(unregistered) + missing
        c.add("E1", "缺口登记引用完整", not e1_bad,
              f"声明 GAP {len(gaps)} 处（{gaps if gaps else '无'}）；"
              f"引用登记编号 {sorted(seen_ids)}，登记表 {len(reg)} 条，"
              f"悬空 {len(missing)} 条"
              + (f"；无标记 {len(unregistered)} 处" if unregistered else "")
              + ("　✅ 每处 GAP 都指得出落点" if not e1_bad else ""))

        # ── E2 缺口的「量」必须可重算 ────────────────────────────
        facts = kb_facts.compute(snap)
        bad_qty, checked, unrecomp = [], 0, []
        for g in reg.values():
            if "量_unrecomputable" in g:
                unrecomp.append(g["id"])
                if "量" in g:
                    bad_qty.append(f"{g['id']}: 同时给了量又说不可重算")
                continue
            if "量" not in g:
                bad_qty.append(f"{g['id']}: 既没有量也没有量_unrecomputable —— 没人能核")
                continue
            for k, v in g["量"].items():
                checked += 1
                if k not in facts:
                    bad_qty.append(f"{g['id']}.{k}: kb_facts 里没有这个键")
                elif facts[k] != v:
                    bad_qty.append(f"{g['id']}.{k}: 登记 {v} vs 重算 {facts[k]}")
        c.add("E2", "缺口量可重算", not bad_qty,
              f"可重算键 {checked} 个全部对上；声明不可重算 {len(unrecomp)} 条"
              f"（{unrecomp}）" + ("" if not bad_qty else f"；❌ {bad_qty}"))

        # ── E5 缺口登记新鲜度 ────────────────────────────────────
        #   E1/E2 读的是盘上的制品，所以还必须有一条守「制品本身没过期」。
        #   没有它，改一次材料表却忘了重跑 kb_gaps.py，E1/E2 会全绿。
        want_gap = json.dumps(kb_gaps.build(facts, snap), ensure_ascii=False, indent=1) + "\n"
        have_gap = open(gap_path, encoding="utf-8").read() if os.path.exists(gap_path) else None
        c.add("E5", "缺口登记新鲜", have_gap == want_gap,
              (f"{os.path.relpath(gap_path, load.REPO)} 与重算一致（{len(reg)} 条）"
               if have_gap == want_gap else
               "❌ 登记表已过期 —— 修复：python3 tools/kb_gaps.py"))

        # ── E7 外部承诺到期（2026-09-21 新增）────────────────────
        #   起因：KB-GAP-6 在 2026-09-21 登记进一条**外部承诺**（上游「两周内」提供
        #   其余品线规则，换算到期日 2026-10-02）。登记本身不产生约束力 ——
        #   承诺方到期没交，得有东西会响。
        #
        #   为什么这条必须长在**验收器里**，而不只是 kb_gaps.py 里打印一句：
        #   到期时需要的是「下一次任何人做 KB 相关改动都会撞见它」，
        #   而不是「有人恰好手动跑了那个脚本」。E5 只比内容，**跑不到 check_due
        #   的退出码** —— 所以没有这一条，那个逾期信号就只是脚本里的一段打印，
        #   即 `AGENTS.md` §2.4 说的「注释，不是约束」。
        #
        #   反向对照（AGENTS.md §2.4.1：没红过的断言不算验证过）：把 check_due 的
        #   `today` 推到 2026-10-03 即返回 2，本条随之变红。五情形实测（到期前 /
        #   到期当天 / 逾期 1 天 / 已填完成于 / due 写成非日期）复现：
        #     python3 -c "import importlib.util,datetime; \
        #       s=importlib.util.spec_from_file_location('g','tools/kb_gaps.py'); \
        #       m=importlib.util.module_from_spec(s); s.loader.exec_module(m); \
        #       print(m.check_due(m.build(), today=datetime.date(2026,10,3)))"
        _buf = io.StringIO()
        with contextlib.redirect_stdout(_buf):
            _due = kb_gaps.check_due(gap_doc or {})
        c.add("E7", "外部承诺未逾期", _due == 0,
              ("在途外部承诺均未到期"
               if _due == 0 else
               "⏰ 有承诺逾期未交付（明细见下；修复前先核『是不是我把到期日算错了』）\n     "
               + _buf.getvalue().strip().replace("\n", "\n     ")))

        # ── E3 台账与快照同代（基准日、数字都建在这上面）──────────
        c.add("E3", "台账与快照同代",
              ledger_doc["snapshot_id"] == snap.snapshot_id,
              f"台账 {ledger_doc['snapshot_id']} vs 快照 {snap.snapshot_id}；"
              f"基准日 {load.basis_date(snap)}")

        # ── E4 文档事实块与查询手册都不许腐烂 ────────────────────
        want = kb_facts.render(facts)
        readme = os.path.join(load.KB, "README.md")
        have = kb_facts.current_block(open(readme, encoding="utf-8").read()) \
            if os.path.exists(readme) else None
        manual = os.path.join(load.KB, "查询手册.md")
        manual_have = open(manual, encoding="utf-8").read() if os.path.exists(manual) else None
        manual_want = kb_query.render_manual(
            ledger_doc, [(i, n, fn(ledger_doc, real))
                         for i, (n, fn) in enumerate(kb_query.QUESTIONS, 1)])
        c.add("E4", "文档可重算", have == want and manual_have == manual_want,
              f"README 事实块 {'一致' if have == want else '❌已过期'}；"
              f"查询手册 {'一致' if manual_have == manual_want else '❌已过期'}"
              f"（修复：python3 tools/kb_facts.py && python3 tools/kb_query.py --md）")

        # ── E6 跨命名空间撞车守护（D37）───────────────────────────
        #   D37 落地当天实测出三条，共性是同一件事：**改的是编号，坏的是围着编号
        #   写的那些假设** —— ① 漏扫生成器 `kb_classes.py`，重算一次就把裸 `D#`
        #   写了回去；② E1 的 `〔缺口:([A-Za-z0-9_]+)〕` 匹配不上 `KB-GAP-1` 的
        #   连字符，于是一处也找不到、**判据变成恒真**；③ 打印分组按
        #   `id.startswith("D")`，改完 G3 整段消失且不报错。三条没有一条会自己喊。
        #
        #   所以这条判据不问「改对了吗」，只问**现在还认不认得出谁是谁**：
        #     (a) KB 线的**登记处**（缺口 `gaps[].id`、`affects`、验收检查编号）
        #         一律不得出现裸 `D#`/`Q#` —— 这是根因，完全可判定；
        #     (b) KB 线的文档与脚本里，裸写的 `D#`/`Q#` 必须**逐条等于清单里那几条**
        #         台账引用 —— 多一条少一条都红，于是「新写一个裸 `D#`」会被抓住。
        #   ★ 别名区（`$renamed_from` / `RENAMED_FROM`）整段剥掉再扫：台账
        #     `D1`–`D16` 与缺口旧编号**完全重叠**，不剥就等于放过全部撞车，
        #     这条判据也会变成恒真 —— 而恒真正是本仓一直在治的病。
        _ledger_p = os.path.join(load.REPO, "research", "governance",
                                 "skeleton", "legal-decisions-v1.json")
        try:
            _lg = json.load(open(_ledger_p, encoding="utf-8"))
            _lid = ({d["id"] for d in _lg["decisions"]}
                    | {q["id"] for q in _lg["$decision_queue"]})
        except Exception:                                     # noqa: BLE001
            _lid = set()

        # (a) 登记处不得有裸编号
        _bare = re.compile(r'^(?:[DQ]\d+)$')
        _reg_bad = []
        _gap_now = json.load(open(os.path.join(load.KB, "缺口-v1.json"), encoding="utf-8"))
        for _g in _gap_now.get("gaps", []):
            if _bare.match(str(_g.get("id"))):
                _reg_bad.append(f"缺口 id 裸写：{_g['id']}")
            for _a in (_g.get("affects") or []):
                if _bare.match(str(_a)):
                    _reg_bad.append(f"{_g['id']}.affects 裸写：{_a}")
        for _i in c.items:
            if _bare.match(_i["id"]):
                _reg_bad.append(f"验收检查编号裸写：{_i['id']}")

        # (b) 文档与脚本里的裸编号必须逐条等于这张清单
        #   ★ 本文件（`verify_kb.py`）**故意不在扫描范围内**：这张清单本身写在
        #     它里面，扫它就成了自指 —— 清单里加一条，实际值也跟着加一条，
        #     判据永远是绿的。自指的检查不是检查。（它自己的**检查编号**仍由
        #     (a) 管着，那一条没有自指问题。）
        #   ★ `查询手册.md` 的 `D28` 是**台账**决定（先结构化 R1，法务只做确认/否决），
        #     由 `知识库-v1.json` 的「缺口说明」渲染进来 —— 台账引用，应当保留。
        _kb_scan = [
            (os.path.join(load.KB, "README.md"), []),
            (os.path.join(load.KB, "知识库-v1.json"), ["D28"]),
            (os.path.join(load.KB, "外部标准库-v1.json"), []),
            (os.path.join(load.KB, "查询手册.md"), ["D28"]),
            (os.path.join(load.KB, "缺口-v1.json"), ["D3", "D37"]),
            (os.path.join(load.REPO, "tools", "kb_gaps.py"), ["D3", "D37"]),
            (os.path.join(load.REPO, "tools", "kb_facts.py"), []),
            (os.path.join(load.REPO, "tools", "kb_query.py"), ["D37"]),
            (os.path.join(load.REPO, "tools", "kb_classes.py"), ["D28"]),
        ]
        _exempt = [('"$renamed_from": {', "\n },"), ("RENAMED_FROM = {", "\n}")]

        def _strip(text):
            for _s, _e in _exempt:
                _i = text.find(_s)
                if _i < 0:
                    continue
                _j = text.find(_e, _i)
                if _j > 0:
                    text = text[:_i] + text[_j + len(_e):]
            return text

        def _bare_ids(text):
            return sorted({m.group(0) for m in re.finditer(
                r"(?<![A-Za-z0-9_#-])([DQ])(\d{1,3})(?![0-9])", _strip(text))})

        def _cmp(name, text, exp):
            """一条文件的裸编号是否**恰好**等于清单。抽出来是为了反向对照能对同一判据做。"""
            got = _bare_ids(text)
            bad = [] if got == sorted(exp) else \
                [f"{name}：实际 {got or '无'} ≠ 清单 {sorted(exp) or '无'}"]
            return bad + [f"{name}：{t} 不在台账里" for t in got if t not in _lid]

        _doc_bad = []
        for _p, _exp in _kb_scan:
            if not os.path.exists(_p):
                _doc_bad.append(f"{os.path.basename(_p)} 不存在")
                continue
            _doc_bad += _cmp(os.path.basename(_p),
                             open(_p, encoding="utf-8").read(), _exp)

        # 反向对照：**对同一个判据函数**注入一个裸缺口编号，它必须报红。
        #   （第一版这里只断言「正则能匹配到东西」—— 那证明的是正则没坏，
        #     不是判据会红。与 V30e / F4 是同一类要求。）
        _readme_p = os.path.join(load.KB, "README.md")
        _ctrl = _cmp("反向对照", open(_readme_p, encoding="utf-8").read() + "\n〔缺口:D8〕", [])
        _ctrl_ok = any("D8" in _x for _x in _ctrl)

        _e6_bad = _reg_bad + _doc_bad
        c.add("E6", "跨命名空间撞车守护：KB 线自有编号必须带前缀，裸 `D#`/`Q#` 必须逐条等于台账引用清单（D37）",
              not _e6_bad and _ctrl_ok,
              (f"登记处 0 处裸编号；{len(_kb_scan)} 个文件的裸编号与台账引用清单逐条相等；"
               f"反向对照：塞入 〔缺口:D8〕 → {'判据报红' if _ctrl_ok else '❌没报红'}"
               if not _e6_bad else "；".join(_e6_bad[:4])))

        # ── F 组（B3.2）· 4 类知识库实例化 ────────────────────────
        #   守三件事：① 登记表是重算出来的（不是手抄的现状）
        #            ② 材料的两轴分类里没有「待分类」这种混合取值
        #            ③ 外部标准库的条目引用完整、身份标清
        import kb_classes
        import kb_materials_data as md

        want4 = json.dumps(kb_classes.build(), ensure_ascii=False, indent=1) + "\n"
        p4 = os.path.join(load.KB, "知识库-v1.json")
        have4 = open(p4, encoding="utf-8").read() if os.path.exists(p4) else None
        _c4 = json.loads(have4) if have4 else {"classes": []}
        bad4 = [c["知识库"] for c in _c4.get("classes", [])
                if not c.get("缺口编号") or not str(c.get("状态") or "").strip()]
        c.add("F1", "4 类登记表可重算", have4 == want4 and not bad4,
              (f"{len(_c4.get('classes', []))} 类 · 与重算一致 · 每类标了状态与缺口编号"
               if have4 == want4 and not bad4 else
               ("❌ 登记表已过期（python3 tools/kb_classes.py）" if have4 != want4
                else f"❌ 缺状态/缺口编号：{bad4}")))

        # ★ 判据抽成函数，反向对照才能对同一判据做变异（V30 的 _queue_problems 同理）
        def _axis_problems(mats):
            return [f"#{m['编号']} 归属知识库={m['归属知识库']!r}"
                    for m in mats
                    if m.get("归属知识库") in (None, "", "待分类", "未分类")
                    or m.get("材料性质") in (None, "", "待分类", "未分类")]

        _ax = _axis_problems(md.MATERIALS)
        c.add("F2", "材料两轴分类无「待分类」",
              not _ax,
              f"{len(md.MATERIALS)} 条 · 材料性质 {len(set(m['材料性质'] for m in md.MATERIALS))} 类"
              f" · 归属知识库 {len(set(m['归属知识库'] for m in md.MATERIALS))} 类"
              f" · 待分类 {len(_ax)} 条"
              + (f" ❌ {_ax[:3]}" if _ax else "　（「—」是完整答案：它就不是知识材料）"))

        def _ext_problems(entries, src_ids, fams=None, rule_keys=None):
            """★ B3.5（外部标准库落盘）：从只查「引用完整」扩到查「**归组完整**」。

            研究稿交付时有一个字段 `若无法关联规则` 用来记「这条对不上我们哪条
            规则、该归到哪个候选族」，但 14 条空白条目里它**全是 null** ——
            7 个候选规则族只写在交付说明的散文里，落盘制品里没有。
            下游（法务）读 JSON 是看不到族的。散文里的结论没有键可挂，
            就等于没有。故本检查要求：**空白必落族号，族号必有定义，
            引用的规则键必须真实存在**。
            """
            bad = []
            valid_fam = {f["id"] for f in (fams or [])}
            for e in entries:
                eid = e.get("id", "?")
                if e.get("source_id") not in src_ids:
                    bad.append(f"{eid}: source_id={e.get('source_id')!r} 不在 sources 里（悬空引用）")
                # ★ 判据踩过的坑：「未确认」这三个字在实际标记
                #   「研究稿·未经法务确认」里**并不连续出现**，子串匹配恒为真，
                #   于是**每一条都会被误判成缺标记**。这条检查此前从未跑过真实数据
                #   （F3 一直是 SKIP，因为制品不存在），落盘当天才暴露。
                _mk = str(e.get("未确认标记") or "")
                if e.get("status") == "research" and not (_mk and "未" in _mk and "确认" in _mk):
                    bad.append(f"{eid}: status=research 却没有「未经法务确认」标记 —— 研究会被读成裁定")
                if e.get("status") == "ratified" and not (e.get("确认人") and e.get("确认日期")):
                    bad.append(f"{eid}: status=ratified 却没有确认人与日期")
                if e.get("status") not in ("research", "ratified"):
                    bad.append(f"{eid}: status={e.get('status')!r} 既不是 research 也不是 ratified")
                linked = e.get("关联规则") or []
                if not linked:
                    fam = e.get("若无法关联规则")
                    if not fam:
                        bad.append(f"{eid}: 关联规则为空却没有族号 —— 「我们规则库没有这条」只写在散文里，制品里读不到")
                    elif valid_fam and fam not in valid_fam:
                        bad.append(f"{eid}: 族号 {fam!r} 不在 候选规则族 里（悬空归组）")
                if rule_keys is not None:
                    for k in linked:
                        if k not in rule_keys:
                            bad.append(f"{eid}: 引用了规则库里不存在的规则键 {k!r}（凭空关联）")
            return bad

        def _fam_problems(fams, entries):
            """族的成员必须真实存在，且**并集恰好等于**空白条目集。"""
            bad = []
            ids = {e.get("id") for e in entries}
            blank = {e.get("id") for e in entries if not (e.get("关联规则") or [])}
            seen = set()
            for f in fams or []:
                for m in f.get("成员") or []:
                    if m not in ids:
                        bad.append(f"{f.get('id')}: 成员 {m} 不在条目里")
                    if m in seen:
                        bad.append(f"{m}: 被归进多个族")
                    seen.add(m)
            if fams and seen != blank:
                bad.append(f"族的成员并集与空白条目集不等：族有而条目没有 {sorted(seen - blank)}；"
                           f"空白却没归族 {sorted(blank - seen)}")
            return bad

        # 规则库（引擎侧）的规则键 —— 用来查外部条款是否引了不存在的规则
        _rp = os.path.join(load.REPO, "research", "governance", "skeleton", "rules-v1.json")
        _rule_keys = None
        if os.path.exists(_rp):
            _rule_keys = {r["rule_key"] for r in
                          json.load(open(_rp, encoding="utf-8"))["rules"]}

        _extp = os.path.join(load.KB, "外部标准库-v1.json")
        _ext = json.load(open(_extp, encoding="utf-8")) if os.path.exists(_extp) else None
        if _ext is None:
            # ★ 制品不在时**不能直接红到底**：一个长期恒红的检查会被学会忽略，
            #   和恒真一样坏。这里的纪律是「红可以变成 SKIP，但前提是这个空缺
            #   已经被登记成缺口」—— 把 KB-GAP-8 从登记表里删掉，本条立刻变红。
            _gap8 = reg.get("KB-GAP-8")
            c.add("F3", "外部标准库条目引用完整",
                  bool(_d8),
                  (f"⏭️ 制品 `外部标准库-v1.json` 未建立，但已在登记表里记为 "
                   f"〔缺口:KB-GAP-8〕（{_gap8.get('status') if _gap8 else '—'}）—— 跳过不算通过"
                   if _d8 else
                   "❌ 制品不存在，**且登记表里没有 KB-GAP-8** —— 空缺既没做也没登记"),
                  skipped=bool(_d8))
        else:
            _fams = _ext.get("候选规则族") or []
            _e_bad = _ext_problems(_ext.get("entries", []),
                                   {x["id"] for x in _ext.get("sources", [])},
                                   fams=_fams, rule_keys=_rule_keys)
            _f_bad = _fam_problems(_fams, _ext.get("entries", []))
            _all_bad = _e_bad + _f_bad
            _n = len(_ext.get("entries", []))
            _blank = [e for e in _ext.get("entries", []) if not (e.get("关联规则") or [])]
            c.add("F3", "外部标准库条目引用与归组完整", not _all_bad,
                  f"{_n} 条 / 来源 {len(_ext.get('sources', []))} 个"
                  f" · research {sum(1 for e in _ext.get('entries', []) if e.get('status') == 'research')}"
                  f" / ratified {sum(1 for e in _ext.get('entries', []) if e.get('status') == 'ratified')}"
                  f" · 空白 {len(_blank)} 条归入 {len(_fams)} 族（并集相等）"
                  f" · 规则键引用 {len(_rule_keys) if _rule_keys else '—'} 个键内"
                  + (f" ❌ {_all_bad[:3]}" if _all_bad else "　（来源指得出、身份标清、空白有族）"))

        # 反向对照：判据必须能红 —— 抽掉 source、抹掉未确认标记、把状态写歪，三种都要抓住
        _probe = _ext_problems(
            [{"id": "X1", "source_id": "S-nope", "status": "research", "未确认标记": ""},
             {"id": "X2", "source_id": "S1", "status": "ratified"},
             {"id": "X3", "source_id": "S1", "status": "probably-fine",
              "未确认标记": "研究稿·未经法务确认"},
             # ★ B3.5 新增三种：空白不落族 / 引了不存在的规则键 / 悬空归组
             {"id": "X4", "source_id": "S1", "status": "research",
              "未确认标记": "研究稿·未经法务确认", "关联规则": [], "若无法关联规则": None},
             {"id": "X5", "source_id": "S1", "status": "research",
              "未确认标记": "研究稿·未经法务确认", "关联规则": ["T9.不存在"]},
             {"id": "X6", "source_id": "S1", "status": "research",
              "未确认标记": "研究稿·未经法务确认", "关联规则": [], "若无法关联规则": "F99"},
             # ★ 正例对照：一条**完全合规**的条目必须一条问题都不产生。
             #   只验反例是不够的 —— 判据写成恒真时反例照样被抓（它们各有别的理由），
             #   而正例会被误伤。上面那个「未确认」子串 bug 正是这样漏过去的。
             {"id": "X7", "source_id": "S1", "status": "research",
              "未确认标记": "研究稿·未经法务确认", "关联规则": [], "若无法关联规则": "F1"}],
            {"S1"}, fams=[{"id": "F1", "成员": ["EXT-017"]}], rule_keys={"T6.1.regulatory-status"})
        _fam_probe = _fam_problems([{"id": "F1", "成员": ["EXT-017", "EXT-404"]}],
                                   [{"id": "EXT-017", "关联规则": []}])
        _axis_probe = _axis_problems([{"编号": "x", "材料性质": "知识材料", "归属知识库": "待分类"}])
        #   断言用「每个变异体都被点到名」，不断言问题的条数 —— 条数是实现的副产品，
        #   而 X2 恰好会触发不止一条理由。第一版断言了 ==3，于是它自己红了。
        _hit = {str(x).split(":")[0] for x in _probe}
        c.add("F4", "反向对照：F2/F3 的判据真的会红（不是恒真）",
              _hit == {"X1", "X2", "X3", "X4", "X5", "X6"} and "X7" not in _hit
              and len(_fam_probe) == 2 and len(_axis_probe) == 1,
              f"六反例（悬空来源 / 缺未确认标记 / 状态非法 / 空白不落族 / "
              f"引不存在的规则键 / 悬空归组）→ 点中 {sorted(_hit)}；"
              f"一正例 X7 未被误伤；"
              f"族成员不存在且并集不等 → 抓住 {len(_fam_probe)}/2；"
              f"材料「待分类」→ 抓住 {len(_axis_probe)}/1")

        # ── T 组 · 移植项（T17 逐条缺口账 / T18 引用失效 / T19 origin 分级）──
        #   三条都来自 `PMO/守衡-Utopia结合方案-20260923.md` §四，本条文件是它们的执行层。
        #   共同形态：**把一条原来靠人记住的纪律，变成一条会红的断言。**
        import kb_gap_ledger as GL

        _led = GL.load_ledger()
        _led_rows = (_led[0] or {}).get("rows") or [] if _led[0] else []
        _ext_entries = _ext.get("entries", []) if _ext else []
        _cited, _cite_note = GL.cited_index()
        _live = GL.channel_liveness()

        def _ledger_problems(rows, entries, cited, live):
            """★ 判据抽成纯函数，反向对照才能对**同一个判据**做变异。

            这是本仓反复吃过亏的地方（`V30` 的 `_queue_problems`、`F3` 的
            `_ext_problems` 同理）：写成一段内联 `if`，反向对照就只能另写一份
            相似的判断 —— 而验的已经不是同一条判据了。

            返回 `[(类, 说明)]`。**分类不是为了好看**：每一类各有一条反向对照守着
            （见下面 `_ctl`），而每条检查的结论行只在自己那一类的对照也响了之后才准变绿
            —— 否则删掉一条判据，结论行会照旧写着「正反两面一致」（结论行撒谎）。
            """
            bad = []
            # ① 键唯一 + 三个取值域是枚举（自由字符串 = 没有原因码）
            _k = __import__("collections").Counter(
                (r.get("库"), r.get("条目ID"), r.get("通道")) for r in rows)
            for k, n in _k.items():
                if n > 1:
                    bad.append(("枚举", f"键重复 {k} ×{n}"))
            for r in rows:
                if r.get("库") not in GL.LIBS:
                    bad.append(("枚举", f"{r.get('条目ID')}: 库={r.get('库')!r} 不在取值域"))
                if r.get("通道") not in GL.CHANNELS:
                    bad.append(("枚举", f"{r.get('条目ID')}: 通道={r.get('通道')!r} 不在取值域"))
                if r.get("原因码") not in GL.REASONS:
                    bad.append(("枚举", f"{r.get('条目ID')}: 原因码={r.get('原因码')!r} 是自由字符串"))
            # ② 恒等式：分项之和 == 总数（改写 `AGENTS.md` §2.4.1 可操作结论 2）
            _cnt = __import__("collections").Counter(
                r["原因码"] for r in rows if r.get("原因码") in GL.REASONS)
            if sum(_cnt.values()) != len(rows):
                bad.append(("枚举", f"Σ(各原因码计数)={sum(_cnt.values())} ≠ 总行数={len(rows)}"
                                    f"　（有 {len(rows) - sum(_cnt.values())} 行落不进任何一组）"))
            # ③ 逐条覆盖 + 正反一致
            _ids = {e.get("id") for e in entries}
            _idx = {}
            for r in rows:
                _idx.setdefault((r.get("库"), r.get("条目ID"), r.get("通道")), []).append(r)
            for eid in sorted(x for x in _ids if x):
                hit = _idx.get(("外部标准库", eid, "rules")) or []
                if len(hit) != 1:
                    bad.append(("覆盖", f"{eid}: 恰需一行（库=外部标准库·通道=rules），实得 {len(hit)} 行"))
                    continue
                # ★ 只认 **rules 通道**的反向指针来定这一行的原因码。
                #   `cited` 现在同时装着 engine 通道（回执）的引用 ——
                #   不按通道过滤的话，一条**回执**引过它就会让**规则那一行**翻成
                #   `cited_by`。那正是「一条通道活着给另一条通道作证」（§2.4.1 第 4 行），
                #   而且是**静默**的：账看起来更绿了。
                _rules_hit = [w for w in (cited.get(eid) or []) if w[1] == "rules"]
                want = "cited_by" if _rules_hit else "unused"
                if hit[0].get("原因码") != want:
                    bad.append(("覆盖", f"{eid}: 账上说 {hit[0].get('原因码')!r}，反向指针实际是 {want!r}"))
            for r in rows:
                if r.get("库") == "外部标准库" and r.get("条目ID") not in _ids:
                    bad.append(("覆盖", f"{r.get('条目ID')}: 不在外部标准库里 —— 凭空一行"))
            # ④ ★ 通道必须活着才准出否定结论（§2.4.1 第 4 行）
            for ch in sorted({r.get("通道") for r in rows}):
                if not (live.get(ch) or {}).get("alive"):
                    bad.append(("活性", f"通道 {ch} 此刻没活着，账上却有它的行 —— "
                                        f"否定结论比输入大（{(live.get(ch) or {}).get('proof', '无自证')}）"))
            return bad

        # ── 反向对照 + 正例对照 ──────────────────────────────────────
        #   ★ 只验反例是不够的（§2.4.1 的 X7 教训）：反例各有别的理由也会被抓住，
        #     而判据写成恒真时反例照样红。所以下面必须有一条**正例**。
        def _ctl(rows, cited=None, entries=None):
            return {k for k, _ in _ledger_problems(
                rows, entries if entries is not None else _ext_entries,
                cited if cited is not None else _cited, _live)}

        _lp = _ledger_problems(_led_rows, _ext_entries, _cited, _live)
        _cnt_all = __import__("collections").Counter(r.get("原因码") for r in _led_rows)

        _c_enum = _ctl([dict(_led_rows[0], 原因码="不知道")] + _led_rows[1:]) \
            if _led_rows else set()
        #   ★ 每个反例**各自点名**。第一版只断言「触发过的类别集合 == {覆盖}」——
        #     实测无效：删掉「恰一行」那条判据后，「凭空一行」还在触发「覆盖」，
        #     集合照旧相等，两个变异体全绿。**集合相等不等于每条对照都响了。**
        _c_named = {}
        if _led_rows:
            _c_named["自由原因码"] = _c_enum
            _c_named["未测通道出结论"] = _ctl(_led_rows + [dict(_led_rows[0], 通道="shouheng")])
        if _ext_entries and _led_rows:
            _c_named["凭空一行"] = _ctl(_led_rows + [dict(_led_rows[0], 条目ID="EXT-999")])
            #   ★ 「删一行」必须删**点名的那一行**，不许写 `_led_rows[1:]`。
            #     2026-09-23（T4/T15 · engine 通道接了进来）当场踩到：行是按
            #     `(库, 条目ID, 通道)` 排的，`engine` 排在 `rules` 前面，于是
            #     「删第 0 行」删掉的是 `EXT-001 · engine` —— 而覆盖判据看的是
            #     `通道=rules` 那一行，**它一条问题也不报**，这条对照安静地变成了恒真。
            #     （这正是本节开头那段话的第二次发生：**一条随世界变好而失效的对照**。）
            _i_rules = next((i for i, r in enumerate(_led_rows)
                             if r.get("通道") == "rules"
                             and r.get("条目ID") == _ext_entries[0].get("id")), None)
            _c_named["删一行"] = _ctl(_led_rows[:_i_rules] + _led_rows[_i_rules + 1:]
                                      if _i_rules is not None else _led_rows)
            #   ★ 这两个对照**必须按当前事实构造**，不能写死「把第一行改成 cited_by」。
            #     第一版就是写死的：T3 落地后 EXT-001 真的成了 `cited_by`，
            #     于是那个「变异体」与真身一模一样，判据自然不报错 ——
            #     **一条随世界变好而失效的反向对照，会安静地变成恒真。**
            #     现在两边各取一行真实的、方向相反的行来造反，两个方向都验。
            _truth = {("外部标准库", e.get("id"), "rules"):
                      ("cited_by" if _cited.get(e.get("id")) else "unused")
                      for e in _ext_entries}
            def _flip(idx, to):
                rows = [dict(r) for r in _led_rows]
                rows[idx] = dict(rows[idx], 原因码=to)
                return rows
            _i_un = next((i for i, r in enumerate(_led_rows)
                          if _truth.get((r.get("库"), r.get("条目ID"), r.get("通道")))
                          == "unused"), None)
            _i_ci = next((i for i, r in enumerate(_led_rows)
                          if _truth.get((r.get("库"), r.get("条目ID"), r.get("通道")))
                          == "cited_by"), None)
            if _i_un is not None:
                _c_named["谎称被引用"] = _ctl(_flip(_i_un, "cited_by"))
            if _i_ci is not None:
                _c_named["谎报没被引用"] = _ctl(_flip(_i_ci, "unused"))
        _ctl_cov = {k: v for k, v in _c_named.items()
                    if k in ("凭空一行", "删一行", "谎称被引用", "谎报没被引用")}
        # ★ 正例：某条目真的有了反向指针 → 它的行必须翻成 cited_by 且**不再红**
        _pos_cited, _pos_rows = dict(_cited), [dict(r) for r in _led_rows]
        if _ext_entries and _pos_rows:
            _pos_cited[_ext_entries[0]["id"]] = [("外部标准库", "rules", "T0.probe")]
            _pos_rows[0] = dict(_pos_rows[0], 原因码="cited_by")
        _pos_bad = _ledger_problems(_pos_rows, _ext_entries, _pos_cited, _live) if _pos_rows else []

        def _bad_of(cat):
            return [m for k, m in _lp if k == cat]

        c.add("T17a", "逐条缺口账：恒等式与取值域",
              not _bad_of("枚举") and "枚举" in _c_named.get("自由原因码", set()),
              (f"{len(_led_rows)} 行 · Σ(各原因码计数) == 总行数 · 三个取值域全部命中枚举（"
               + "、".join(f"{k} {v}" for k, v in sorted(_cnt_all.items(), key=str)) + "）"
               f" · 反向对照：自由原因码 → {'判据报红' if '枚举' in _c_enum else '❌没报红'}"
               if not _bad_of("枚举") else f"❌ {_bad_of('枚举')[:3]}"))

        #   「谎称被引用」与「谎报没被引用」各需一种事实才构造得出；**至少两条对照
        #   都必须跑到**，否则这条检查会因为「构造不出反例」而静默变绿。
        _b_ctl_ok = ({"凭空一行", "删一行"} <= set(_ctl_cov)
                     and len(_ctl_cov) >= 3
                     and all("覆盖" in v for v in _ctl_cov.values()))
        c.add("T17b", "逐条缺口账：62 条逐条有落点，正反两面一致",
              not _bad_of("覆盖") and _b_ctl_ok and not _pos_bad,
              (f"{len(_ext_entries)} 条外部标准逐条恰一行（库=外部标准库·通道=rules）；"
               f"cited_by ⇔ 反向指针（{_cite_note}）；"
               f"反向对照：" + "、".join(
                   f"{k}{'✅' if '覆盖' in v else '❌'}" for k, v in _ctl_cov.items())
               + "（各自点名，不是「集合相等」）" + "；"
               f"正例（真注入反向指针 → 该行翻 cited_by）→ "
               f"{'不误伤 ✅' if not _pos_bad else f'❌ 误伤 {_pos_bad[:2]}'}"
               if not _bad_of("覆盖") else f"❌ {_bad_of('覆盖')[:4]}"))

        _c_live = _c_named.get("未测通道出结论", set())
        c.add("T17c", "逐条缺口账：只对活着的通道下否定结论",
              not _bad_of("活性") and "活性" in _c_live,
              (f"通道活性：" + "、".join(f"{k}={'活' if v['alive'] else '未测'}"
                                          for k, v in _live.items())
               + f"；`unused` 只对活着的通道出 —— 反向对照：给未测通道塞一行 → "
                 f"{'判据报红' if '活性' in _c_live else '❌没报红'}"
               if not _bad_of("活性") else f"❌ {_bad_of('活性')[:3]}"))

        # 可重算：同一日历日重建必须逐字相同（承接字段不许自己长出来）
        _same_day = max((r.get("最近一次") or "") for r in _led_rows) if _led_rows else None
        _re = GL.build(existing=_led[0], today=_same_day)[0] if _same_day else None
        _re_txt = GL.dump(_re) if _re else None
        _have_txt = GL.dump({"rows": _led_rows})
        #   承接对照：把最近一次拨到昨天再重建 → 次数 +1、首次出现不变
        _yest = (__import__("datetime").date.fromisoformat(_same_day)
                 - __import__("datetime").timedelta(days=1)).isoformat() if _same_day else None
        _carry = GL.build(existing={"rows": [dict(r, 最近一次=_yest) for r in _led_rows]},
                          today=_same_day)[0]["rows"] if _yest else []
        _carry_ok = bool(_carry) and all(
            r["次数"] == o["次数"] + 1 and r["首次出现"] == o["首次出现"]
            for r, o in zip(_carry, _led_rows))
        c.add("T17d", "逐条缺口账：可重算（同一日重建逐字相同；跨日只许 次数+1、首次出现不动）",
              _re_txt == _have_txt and _carry_ok,
              (f"以账内最近一次 {_same_day} 重建 → 与盘上逐字相同（{len(_led_rows)} 行）；"
               f"跨日重建 → 次数各 +1、首次出现不变 ✅"
               if _re_txt == _have_txt and _carry_ok else
               "❌ 账与重建不一致 —— 修复：python3 tools/kb_gap_ledger.py"))

        # ── T18 · 条款变更 → 引用失效（C1 移植，蓝本 `0053`）──────────────
        import kb_clause as CL

        _rules_doc = None
        if os.path.exists(_rp):
            _rules_doc = json.load(open(_rp, encoding="utf-8"))
        _cidx = CL.build_index(_ext) if _ext else None
        _ip = CL.index_problems(_ext) if _ext else ["外部标准库不在盘上"]
        _rrp = CL.rules_ref_problems(_rules_doc, _cidx) if (_ext and _rules_doc) else \
            [("悬空", "rules-v1.json 或外部标准库不在盘上")]

        def _mut_ext(fn):
            """深拷贝外部标准库再变异 —— **绝不碰盘上的制品**（§2.4.4）。"""
            import copy as _c
            d = _c.deepcopy(_ext)
            for e in d["entries"]:
                fn(e)
            return d

        # T18a · 条款层自身：地址唯一、与位置一致、指纹可重算
        _c18a = {
            "clause_no 重号": _mut_ext(lambda e: e.update(clause_no="S1-01")),
            "顺序被挪": _mut_ext(lambda e: e.update(clause_no="S9-99")),
            "指纹被改": _mut_ext(lambda e: e.update(变更指纹="sha256:0000000000000000")),
        }
        _a18a = {}
        for _k, _d in _c18a.items():
            _msgs = CL.index_problems(_d)
            _a18a[_k] = any(("不唯一" in _m) or ("≠ 按当前位置" in _m) or ("变更指纹" in _m)
                            for _m in _msgs)
        c.add("T18a", "条款层：条文号唯一且与位置一致，变更指纹可重算",
              (not _ip) and all(_a18a.values()),
              (f"{len(_cidx['entries'])} 条 · clause_no 唯一率 "
               f"{len(_cidx['by_no'])}/{len(_cidx['entries'])} · 指纹逐条重算一致"
               f"；反向对照：" + "、".join(f"{k}{'✅' if v else '❌'}" for k, v in _a18a.items())
               if not _ip else f"❌ {_ip[:3]}"))

        # T18b · 引用不悬空 + 双向一致
        _c18b = {}
        if _cidx and _rules_doc:
            _c18b["凭空关联"] = CL.ref_problems(
                {"库名": "外部标准库", "条目ID": "EXT-999", "条文号": "S9-99",
                 "指纹": "sha256:x"}, _cidx, where="probe")
            _c18b["条文号指错"] = CL.ref_problems(
                {"库名": "外部标准库", "条目ID": "EXT-001", "条文号": "S1-99",
                 "指纹": _cidx["by_id"]["EXT-001"]["变更指纹"]}, _cidx, where="probe")
            import copy as _c2
            _rd = _c2.deepcopy(_rules_doc)
            _rd["rules"][0]["external_ref"] = []
            _rd["rules"][0].pop("no_external_basis", None)
            _c18b["凭空多一条边"] = CL.rules_ref_problems(_rd, _cidx)
        _a18b = {k: len(v) > 0 for k, v in _c18b.items()}
        c.add("T18b", "条款层↔规则层：每条引用指得到，且两边互为反面（单边声明即红）",
              (not _rrp) and all(_a18b.values()) and len(_a18b) == 3,
              (f"24 条规则带 external_ref、2 条声明 no_external_basis；"
               f"62 条条目的「我关联到谁」与规则侧「谁认账」逐条相等"
               f"；反向对照：" + "、".join(f"{k}{'✅' if v else '❌'}" for k, v in _a18b.items())
               if not _rrp else f"❌ {_rrp[:3]}"))

        # T18c · ★ C1 里真正的新东西：条款改了 → 引用失效
        _c18c = {}
        if _cidx:
            _ref = CL.evidence_ref_of(_cidx["by_id"]["EXT-001"], _cidx)
            _c18c["原样"] = CL.ref_problems(_ref, _cidx, where="probe")
            _d3 = _mut_ext(lambda e: e.update(条款原文=(e.get("条款原文") or "") + ".")
                           if e.get("id") == "EXT-001" else None)
            _i3 = CL.build_index(_d3)
            _c18c["改一个字节"] = CL.ref_problems(_ref, _i3, where="probe")
        _a18c = ((not _c18c.get("原样"))
                 and any(k == "失效" for k, _ in _c18c.get("改一个字节", [])))
        c.add("T18c", "★ 条款被改动 → 引用它的规则标记 stale（改一个字节必须红）",
              _a18c,
              ("条款正文改一个字节 → 该引用报 `失效`（stale）；不改 → 一条问题也不报。"
               "★ 这是 C1 移植里唯一真正的新东西：T2/T3 给的是「指针」与「条文号」，"
               "它给的是「接了之后它会失效吗」"
               if _a18c else f"❌ 改一个字节没报失效：{_c18c.get('改一个字节', [])[:2]}"))

        # ── T19 · 证据 origin 分级与 PASS 收窄（C2 移植）────────────────
        _erefs = CL.evidence_refs(_ext) if _ext else []
        _ep = [m for r in _erefs for m in CL.evidence_ref_problems(r, _cidx)] if _cidx else []
        _c19a = {}
        if _cidx:
            _probe = CL.evidence_ref_of(_cidx["by_id"]["EXT-001"], _cidx)
            _c19a["自由来源"] = CL.evidence_ref_problems(
                dict(_probe, origin="大概是正文吧"), _cidx, where="probe")
            _c19a["没有来源"] = CL.evidence_ref_problems(
                {k: v for k, v in _probe.items() if k != "origin"}, _cidx, where="probe")
            _c19a["来源写成回执来源"] = CL.evidence_ref_problems(
                dict(_probe, origin="cli"), _cidx, where="probe")
        _a19a = {k: len(v) > 0 for k, v in _c19a.items()}
        c.add("T19a", "证据来源：每条 evidence_ref 必带 origin，取值只在四档内（连回执来源也不许混）",
              (not _ep) and all(_a19a.values()) and len(_a19a) == 3,
              (f"{len(_erefs)} 条证据引用逐条带 origin，全部落在那四档内；"
               f"反向对照：" + "、".join(f"{k}{'✅' if v else '❌'}" for k, v in _a19a.items())
               + "；正例：62 条真证据全部通过"
               if not _ep else f"❌ {_ep[:3]}"))

        # T19b · ★ 判据 ②：origin != stated 不许单独把结论推到 PASS
        def _pass_probe(origins):
            return CL.may_finalize_pass([{"origin": o} for o in origins])
        _c19b = {o: _pass_probe([o]) for o in ("ocr", "transcribed", "described")}
        _pos19b = _pass_probe(["stated"])
        _empty19b = _pass_probe([])
        _mixed19b = _pass_probe(["ocr", "stated"])
        c.add("T19b", "★ 非「原文照读」的证据不许单独把结论推到 PASS（三档各自点名）",
              (not any(ok for ok, _ in _c19b.values())) and _pos19b[0]
              and (not _empty19b[0]) and _mixed19b[0],
              "三档各自单独支撑 PASS → " +
              "、".join(f"{o}{'❌竟然可以' if ok else '✅被挡'}" for o, (ok, _) in _c19b.items())
              + f"；正例 stated → {'✅可以' if _pos19b[0] else '❌被误伤'}"
              + f"；空证据集 → {'✅挡住（没有证据≠无需证据）' if not _empty19b[0] else '❌竟然放行'}"
              + f"；混有 stated → {'✅可以（弱证据只作补充）' if _mixed19b[0] else '❌被误伤'}")

        # T19c · 两个 origin 不许混（落本模块时当场撞到的名字冲突）
        _c19c = {
            "回执来源写成证据来源": CL.EO.receipt_origin_problems(
                {"origin": "stated", "evidence_origin": "described"}),
            "证据来源写成回执来源": CL.EO.receipt_origin_problems(
                {"origin": "cli", "evidence_origin": "test"}),
        }
        _a19c = {k: len(v) > 0 for k, v in _c19c.items()}
        _pos19c = CL.EO.receipt_origin_problems({"origin": "batch", "evidence_origin": "ocr"})
        c.add("T19c", "两个 origin 不许混：回执来源（cli/batch/shouheng/test）与证据来源四档互斥",
              all(_a19c.values()) and (not _pos19c)
              and not (set(CL.EO.ORIGINS) & set(CL.EO.RECEIPT_ORIGINS)),
              "取值域交集为空；反向对照：" +
              "、".join(f"{k}{'✅' if v else '❌'}" for k, v in _a19c.items())
              + "；正例（batch + ocr 这一对合法组合）→ "
              + ("不误伤 ✅" if not _pos19c else f"❌ 误伤 {_pos19c[:1]}")
              + "　★ `judge()` 里原本已有一个 `origin`，含义是**回执来源** —— "
                "证据来源因此叫 `evidence_origin`")

        # ── T4 · 回执 → 条款 → 原文（PRD §5.3 的「依据《文档名》第 X 条」）──
        #   判据原文：「任一判定回执能反查到条款；反向对照：塞一条不存在的条目 ID 必须红」。
        #   ★ 这一段**真的起一次 judge()**，不是对函数做单元测试 —— 先前的教训是
        #     「跑通了接口 ≠ 接线接上了」（§2.4.1）。
        _rules_p = os.path.join(load.REPO, "research", "governance", "skeleton", "rules-v1.json")
        _rules_doc = json.load(open(_rules_p, encoding="utf-8")) if os.path.exists(_rules_p) else {}
        _rules_all = _rules_doc.get("rules") or []
        _T4_REAL = None
        _T4_CASES = {}
        try:
            import tempfile as _tf
            from pathlib import Path as _P
            sys.path.insert(0, os.path.join(load.REPO, "research", "governance", "skeleton"))
            import judge as _J
            _tmpd = _P(_tf.mkdtemp())
            for _lbl, _txt in (("reject", "This device will cure your disease."),
                               ("pass", "Our breast pump is FDA approved and FDA cleared for safety."),
                               ("catchall", "今日天气不错，适合出门散步。")):
                _T4_CASES[_lbl] = _J.judge(
                    _txt, product_line="吸奶器", receipt=True,
                    receipt_path=_tmpd / (_lbl + ".jsonl"),
                    origin="test", issued_at="2026-09-23T00:00:00+00:00")["receipt"]
            _T4_REAL = _J
        except Exception as e:                                # noqa: BLE001
            c.add("T4a", "回执 → 条款：任一判定回执能反查到条款（地址不悬空、指纹可重算）",
                  False, f"❌ 起 judge() 失败：{type(e).__name__}: {e}")

        if _T4_REAL is not None and _cidx:
            _rc = _T4_CASES["reject"]
            _p_real = CL.receipt_evidence_problems(_rc, _cidx, rules=_rules_all)

            # 反向对照：**逐条点名**，不写「集合相等」（第一版就是这么写的，实测无效）。
            _ctl4 = {}

            def _mut4(fn):
                # ★ **深拷贝**：`block_of()` 是浅拷贝，`b["evidence_ref"]` 与真回执指向
                #   同一个 list —— 第一版没拷，于是「反向对照」把真回执改坏了，
                #   紧接着的正例判据就红在了一个**自己造出来的**变异体上。
                #   这正是 `AGENTS.md` §2.4.4：**自证有副作用，跑一次自证改掉了它要保护的东西。**
                b = json.loads(json.dumps(CL.block_of(_rc), ensure_ascii=False))
                fn(b)
                return CL.evidence_block_problems(b, _cidx,
                                                  rule_keys=_rc["rule_keys_hit"],
                                                  rules=_rules_all)

            _ctl4["凭空条目ID"] = _mut4(lambda b: b["evidence_ref"][0].__setitem__("条目ID", "EXT-999"))
            _ctl4["条文号指错"] = _mut4(lambda b: b["evidence_ref"][0].__setitem__("条文号", "S1-99"))
            _ctl4["指纹被改"] = _mut4(lambda b: b["evidence_ref"][0].__setitem__(
                "指纹", "sha256:0000000000000000"))
            _ctl4["引用整段抹掉"] = _mut4(lambda b: b.__setitem__("evidence_ref", []))
            _ctl4["来源自由字符串"] = _mut4(lambda b: b["evidence_ref"][0].__setitem__(
                "origin", "大概是正文吧"))
            _a4 = {k: len(v) > 0 for k, v in _ctl4.items()}
            # 正例：真回执不许被误伤（少了它，判据写成 `return [("悬空","永远")]` 也会绿）
            _pos4 = CL.evidence_block_problems(
                CL.block_of(_rc), _cidx, rule_keys=_rc["rule_keys_hit"], rules=_rules_all)
            c.add("T4a", "回执 → 条款：任一判定回执能反查到条款（地址不悬空、指纹可重算、引用带全）",
                  (not _p_real) and all(_a4.values()) and (not _pos4) and len(_a4) == 5,
                  (f"真回执 {_rc['run_id']}（命中 {_rc['rule_keys_hit']}）→ 逐条解引用 "
                   f"{len(_rc['evidence_ref'])} 条引用，问题 0 条；"
                   f"反向对照：" + "、".join(f"{k}{'✅' if v else '❌没报红'}" for k, v in _a4.items())
                   + f"；正例（同一条真回执）→ {'不误伤 ✅' if not _pos4 else f'❌ 误伤 {_pos4[:1]}'}"
                   + "　★ 零命中那条（catch_all）引用为空，且 `$ratified_note` 说明它为什么是假")
                  if not _p_real and not _pos4 else f"❌ 真回执自身没过：{(_p_real or _pos4)[:3]}")

            # ── T4b · `ratified` 是**算出来的**，未确认声明必须**逐条点名** ──
            _b4 = {}
            _b4["手写 ratified=True"] = _mut4(lambda b: b.__setitem__("ratified", True))
            _b4["抹掉未确认声明"] = _mut4(lambda b: b.__setitem__("unconfirmed_notice", None))
            _b4["声明不点名"] = _mut4(lambda b: b.__setitem__(
                "unconfirmed_notice", "★ 本判定引用的部分外部标准未经法务确认。"))
            _b4["零引用不解释"] = CL.evidence_block_problems(
                {**CL.block_of(_T4_CASES["catchall"]), "$ratified_note": None},
                _cidx, rule_keys=[], rules=_rules_all)
            _a4b = {k: len(v) > 0 for k, v in _b4.items()}
            # 正例：把被引用的条目临时改成 ratified → 不许再要声明（否则判据成了「永远要声明」）
            _flip = {i: dict(e) for i, e in _cidx["by_id"].items()}
            for _r in _rc["evidence_ref"]:
                _flip[_r["条目ID"]]["status"] = "ratified"
            _idx_rat = {"by_id": _flip, "by_no": _cidx["by_no"],
                        "sources": _cidx["sources"], "entries": _cidx["entries"]}
            _blk_rat = CL.CR.evidence_block(_rc["rule_keys_hit"], _rules_all, _idx_rat)
            _pos4b = CL.evidence_block_problems(_blk_rat, _idx_rat,
                                                rule_keys=_rc["rule_keys_hit"], rules=_rules_all)
            c.add("T4b", "★ `ratified` 必须是**派生**的、未确认声明必须**逐条点名**",
                  all(_a4b.values()) and len(_a4b) == 4 and (not _pos4b)
                  and _blk_rat["ratified"] is True and not _blk_rat["unconfirmed_notice"],
                  "反向对照：" + "、".join(f"{k}{'✅' if v else '❌没报红'}" for k, v in _a4b.items())
                  + f"；正例（被引用的条目临时改成 ratified）→ ratified="
                    f"{_blk_rat['ratified']}、声明 {_blk_rat['unconfirmed_notice']!r}、判据"
                  + ("不误伤 ✅" if not _pos4b else f"❌ 误伤 {_pos4b[:1]}")
                  + "　★ 62 条今天**全部** research —— 所以 `ratified` 若写成手填的 false，"
                    "法务确认第一条之后没有任何东西会红（§2.4.1 第 5 行）")

        # ── T4c · 账本里那些**真**回执逐条反查 + 契约边界 ─────────────────
        _led_p = os.path.join(load.REPO, "research", "governance", "skeleton",
                              "_data", "receipts.jsonl")
        _rows4 = []
        if os.path.exists(_led_p):
            for _ln in open(_led_p, encoding="utf-8").read().splitlines():
                if _ln.strip():
                    try:
                        _rows4.append(json.loads(_ln))
                    except Exception:                          # noqa: BLE001
                        _rows4.append({"_坏行": _ln[:60]})
        # 契约边界：`evidence_origin` 与 T4 的证据块是**同一批**加进回执的（2026-09-23），
        # 所以「带 evidence_origin」= 在契约内。在此之前写的回执不许被要求带上它 ——
        # 那是要求历史带上一个当时还不存在的字段。
        _in4 = [r for r in _rows4 if "evidence_origin" in r]
        _pre4 = [r for r in _rows4 if "evidence_origin" not in r]
        _bad4 = [] if not _cidx else [m for r in _in4
                                      for m in CL.receipt_evidence_problems(r, _cidx, rules=_rules_all)]
        # 反向对照：往**临时回执**里塞一条契约内、条目 ID 是假的 —— 逐条反查必须红。
        _fake4 = json.loads(json.dumps(_T4_CASES.get("reject") or {}, ensure_ascii=False))
        if _fake4:
            _fake4["evidence_ref"][0]["条目ID"] = "EXT-404"
        _ctl4c = CL.receipt_evidence_problems(_fake4, _cidx, rules=_rules_all) \
            if (_fake4 and _cidx) else []
        c.add("T4c", "★ 真回执账本逐条反查（含**契约边界**：契约之前的回执不许被要求带上它）",
              (not _bad4) and len(_ctl4c) > 0,
              (f"账本 {len(_rows4)} 条：契约内 **{len(_in4)}** 条（问题 {len(_bad4)} 条）、"
               f"契约之前 {len(_pre4)} 条"
               + (f"（{str(_pre4[0].get('issued_at', '?'))[:10]}，那时还没有这个字段）"
                  if _pre4 else "")
               + f"；反向对照：塞一条条目ID不存在的契约内回执 → "
                 f"{'✅报红' if _ctl4c else '❌没报红'}"
               + ("　★ 契约内是 0 条 —— 「真回执能反查」这句今天由 T4a 的端到端那条**证着**；"
                  "账本这一支是**空的**，不是绿的（§2.2 第 7 条）" if not _in4 else ""))
              if not _bad4 else f"❌ 账本里契约内的回执有 {len(_bad4)} 个问题：{_bad4[:2]}")

        # ── T4d · 依赖方向单向 + 「没有外部依据」要留痕 ────────────────────
        #   ★ 条款地址的家在引擎侧 `clause_ref.py`，理由正是这条方向：
        #     回执在 `judge()` 内部产出，而 skeleton 不许 import tools/。
        _skel = os.path.join(load.REPO, "research", "governance", "skeleton")
        _rev = []
        for _f in sorted(os.listdir(_skel)):
            if not _f.endswith(".py"):
                continue
            for _ln in open(os.path.join(_skel, _f), encoding="utf-8").read().splitlines():
                _s = _ln.split("#")[0]
                if re.search(r"^\s*(import|from)\s+.*\btools\b", _s) or \
                   re.search(r"import\s+(kb_clause|kb_gap_ledger|verify_kb)\b", _s):
                    _rev.append(f"{_f}: {_ln.strip()[:60]}")
        _nobasis = [r["rule_key"] for r in _rules_all
                    if not r.get("external_ref")
                    and str(r.get("no_external_basis") or "").strip()]
        _abs = CL.CR.evidence_refs_of_rules(_nobasis, _rules_all)
        _blk_abs = CL.CR.evidence_block(_nobasis, _rules_all, _cidx) if _cidx else {}
        _ctl4d = {}
        if _cidx:
            _b = CL.block_of(_T4_CASES["pass"])
            _ctl4d["抹掉 absence 的理由"] = CL.evidence_block_problems(
                {**_b, "evidence_absence": [{"规则": "T9.objective-parameter", "理由": "  "}]},
                _cidx, rule_keys=_T4_CASES["pass"]["rule_keys_hit"], rules=_rules_all)
            _ctl4d["命中的规则一条不带"] = CL.evidence_block_problems(
                {**_b, "evidence_ref": [], "evidence_absence": []},
                _cidx, rule_keys=_T4_CASES["pass"]["rule_keys_hit"], rules=_rules_all)
        _a4d = {k: len(v) > 0 for k, v in _ctl4d.items()}
        c.add("T4d", "依赖方向单向（skeleton 不 import tools/）+「本来就没有外部依据」要留痕",
              (not _rev) and all(_a4d.values()) and len(_a4d) == 2
              and len(_abs[1]) == len(_blk_abs.get("evidence_absence") or []),
              (f"`research/governance/skeleton/` 下逐文件扫反向 import tools/ → **{len(_rev)} 处**"
               f"（这就是地址词汇必须住在引擎侧的理由）；"
               f"声明 `no_external_basis` 的规则 {len(_abs[1])} 条 → 逐条带理由进 "
               f"`evidence_absence`；反向对照："
               + "、".join(f"{k}{'✅' if v else '❌没报红'}" for k, v in _a4d.items()))
              if not _rev else f"❌ skeleton 反向 import 了 tools/：{_rev[:3]}")

        # ── T9 · 回填通道：复核结论 → 新条目/修正条目（PRD §9/§10）──────────
        #   判据原文：「PRD §10「知识库回流数量」能算出一个**非零**的数」。
        #   口径（2026-09-23 委托方裁定）：**只把源表那一侧的判定算「人的判定」**，
        #   原因码只作附注 —— 把机器推断记成人的结论，正是 §2.4.3 那个病。
        import kb_backfill as BF

        _bf_rows = BF.load_ledger()
        _bf_new = BF.derived_rows()
        _bf_recs = BF._records()

        # T9a · 每条都指得出**人的原话**（逐字来自源表，可自己去翻那一行）
        def _src_problems(rows, recs):
            bad = []
            for r in rows:
                i = r.get("记录")
                if not isinstance(i, int) or not (0 <= i < len(recs)):
                    bad.append(("悬空", f"回流 记录={i!r} 指不到 records.json 的任何一行"))
                    continue
                want = {c: recs[i].get(c) for c in BF.SRC_COLS}
                got = {c: (r.get("源表判定") or {}).get(c) for c in BF.SRC_COLS}
                if got != want:
                    diff = [c for c in BF.SRC_COLS if got.get(c) != want.get(c)]
                    bad.append(("原话", f"记录#{i} 的源表列 {diff} 与 records.json 不一致 —— "
                                        f"「人的原话」必须是**照抄**，不是转述"))
                src = str((r.get("源表判定") or {}).get("来源") or "")
                if "源表" not in src:
                    bad.append(("口径", f"记录#{i} 的判定来源写成 {src!r} —— "
                                        f"它不是源表上写下的那一栏"))
                if "不是" not in src or "法务" not in src:
                    bad.append(("口径", f"记录#{i} 没有明写「这**不是**法务复核结论」—— "
                                        f"差这一个字就是一次误读（PRD §9 要的是复核结论）"))
                if "机器" not in str((r.get("附注") or {}).get("$note") or ""):
                    bad.append(("口径", f"记录#{i} 的附注没有标明原因码是**机器推断**"))
            return bad

        _p9a = _src_problems(_bf_rows, _bf_recs) if _bf_rows else [("空", "账本为空")]
        _c9a = {}
        if _bf_rows:
            def _mut9a(i, **kw):
                rs = json.loads(json.dumps(_bf_rows, ensure_ascii=False))
                for k, v in kw.items():
                    if k == "来源":
                        rs[i]["源表判定"]["来源"] = v
                    elif k == "附注":
                        rs[i]["附注"]["$note"] = v
                    else:
                        # ★ 全部落在 `源表判定` 里 —— 判据比的就是这一块。
                        #   第一版写成了 `rs[i][k] = v`（顶层），于是那个「变异体」
                        #   根本没碰被判据比对的数据，反向对照**根本没测到东西**，
                        #   而它照样印出「❌没报红」—— 一条空转的对照。
                        rs[i]["源表判定"][k] = v
                return _src_problems(rs, _bf_recs)
            _c9a["源表原文被转述"] = _mut9a(0, **{"命中片段": ["（转述过的片段）"]})
            _c9a["判定来源不是源表"] = _mut9a(0, 来源="法务复核结论（口头）")
            _c9a["没写明不是法务结论"] = _mut9a(0, 来源="源表")
            _c9a["附注没标机器推断"] = _mut9a(0, 附注="原因是语料缺口")
        _a9a = {k: len(v) > 0 for k, v in _c9a.items()}
        c.add("T9a", "★ 每条回流都指得出**源表那一行**，且明写「这不是法务复核结论」",
              (not _p9a) and all(_a9a.values()) and len(_a9a) == 4,
              (f"{len(_bf_rows)} 条回流逐条指回 records.json；"
               f"反向对照：" + "、".join(f"{k}{'✅' if v else '❌没报红'}" for k, v in _a9a.items())
               + f"　★ 源表 `处理状态` 逐行照抄："
                 + "、".join(f"{v} {n} 条" for v, n in
                             sorted(__import__("collections").Counter(
                                 (r.get("源表判定") or {}).get("处理状态")
                                 for r in _bf_rows).items(), key=lambda x: -x[1]))
                 + f"；`检查人` 非空 "
                 f"{sum(1 for r in _bf_rows if str((r.get('源表判定') or {}).get('检查人') or '').strip())} 条")
              if not _p9a else f"❌ {_p9a[:3]}")

        # T9b · ★ 原因码只作**附注**，不参与「这条算不算回流」的判定
        def _divergence_rows(fid, recs):
            """只按**源表的列 vs 引擎的列**算分歧 —— **一个原因码都不看**。"""
            out = []
            for d in (fid.get("轴3_分歧逐行") or []):
                src_hit = set(d.get("源表_命中") or [])
                eng_hit = set(d.get("引擎_命中") or [])
                if src_hit != eng_hit:
                    out.append((d.get("i"), tuple(sorted(src_hit)), tuple(sorted(eng_hit))))
            return out

        _fid = json.load(open(BF.FIDELITY, encoding="utf-8"))
        # ★ 归一化：`records.json` 的 `命中规则` 是**字符串**（`'U01'` / `'H02,M03,U03'`），
        #   而 `_hit_rules` 与引擎那一侧是**列表**。第一版直接 `sorted(字符串)`，
        #   于是它把 `'U01'` 拆成了 `('0','1','U')` —— 判据与账**永远不相等**，
        #   而报错文字照样印着「13 行 ≡ 13 条」（两个 13 是分别数出来的，不是比出来的）。
        def _hitlist(v):
            if isinstance(v, (list, tuple)):
                return tuple(sorted(str(x) for x in v))
            return tuple(sorted(x for x in re.split(r"[,，/、\s]+", str(v or "")) if x))

        _want9b = _divergence_rows(_fid, _bf_recs)
        _got9b = [(r.get("记录"), _hitlist((r.get("源表判定") or {}).get("命中规则")),
                   _hitlist((r.get("引擎判定") or {}).get("命中规则")))
                  for r in _bf_rows]
        # 反向对照：**只有机器原因码、源表那一行根本没记过命中** → 不许算一条回流
        _fake_div = {"轴3_分歧逐行": [{"i": 0, "源表_命中": ["U01"], "引擎_命中": ["U01"],
                                      "源表有引擎无": [{"原因": "★ 机器自己觉得该回流"}]}]}
        _ctl9b = _divergence_rows(_fake_div, _bf_recs)
        # 反向对照②：把原因码整块改成自由字符串 —— 「算不算回流」这个数**不许动**
        _rs9b = json.loads(json.dumps(_bf_rows, ensure_ascii=False))
        for r in _rs9b:
            r["附注"]["机器推断的原因码"] = ["（随便写的）"]
        _after9b = [(r.get("记录"), _hitlist((r.get("源表判定") or {}).get("命中规则")),
                     _hitlist((r.get("引擎判定") or {}).get("命中规则"))) for r in _rs9b]
        _fid_ids = {d.get("i") for d in (_fid.get("轴3_分歧逐行") or [])}
        _led_ids = {r.get("记录") for r in _bf_rows}
        c.add("T9b", "★ 原因码只作**附注**：回流条数 ≡ 源表列 vs 引擎列不一致的行数（一个原因码都不看）",
              _want9b == _got9b and (not _ctl9b) and _after9b == _got9b
              and _fid_ids == _led_ids and len(_want9b) > 0,
              f"源表列 vs 引擎列不一致 {len(_want9b)} 行 ≡ 账上 {len(_got9b)} 条；"
              f"反向对照①：源表两列相同、只有机器原因码说该回流 → "
              f"{'✅不算一条' if not _ctl9b else '❌竟然算了'}；"
              f"反向对照②：把全部原因码改成自由字符串 → 回流条数"
              f"{'不动 ✅' if _after9b == _got9b else '❌变了'}")

        # T9c · 可重算 + 只增不删（同一日重建逐字相同；跨日只许 次数+1）
        _merged, _mdropped = BF.merge(_bf_rows, _bf_new, (os.environ.get("KB_T9_TODAY") or "2026-09-23"))
        _same_today = [(r.get("记录"), r.get("次数"), r.get("首次出现")) for r in _merged]
        _cross, _ = BF.merge(_bf_rows, _bf_new, "2026-09-24")

        def _content(r):
            return {k: r.get(k) for k in ("记录", "分歧", "源表判定", "引擎判定")}

        _content_ok = [_content(a) for a in _merged] == [_content(b) for b in _bf_new]
        _once_ok = all(b["次数"] == a["次数"] + 1 and b["首次出现"] == a["首次出现"]
                       for a, b in zip(_bf_rows, _cross))
        # 反向对照：把一条的去向改成自由字符串 / 「人写进去的去向」必须扛得住重建
        _c9c = {}
        _rs9c = json.loads(json.dumps(_bf_rows, ensure_ascii=False))
        _rs9c[0]["去向"] = "大概是新条目吧"
        _c9c["去向自由字符串"] = [r for r in _rs9c if r.get("去向") not in BF.TARGETS]

        def _lost_targets(old, merged):
            """重建**丢掉**了哪些人写过的去向。抽成纯函数，反向对照才能对同一条判据做变异。"""
            want = {r.get("记录"): r.get("去向") for r in old
                    if r.get("去向") not in (None, "待定")}
            got = {r.get("记录"): r.get("去向") for r in merged}
            return [k for k, v in want.items() if got.get(k) != v]

        _rs9d = json.loads(json.dumps(_bf_rows, ensure_ascii=False))
        _rs9d[0]["去向"] = "新条目"
        _keep_ok = not _lost_targets(_rs9d, BF.merge(_rs9d, _bf_new, "2026-09-24")[0])
        # ★ 反向对照：把旧账里的去向**抽掉**（模拟「重建时被重算」那个 bug），
        #   同一条判据必须报出来 —— 否则「保住了去向」这句话是恒真的。
        _stripped9d = [({k: v for k, v in r.items() if k != "去向"}) for r in _rs9d]
        _c9c["重建重算掉去向"] = _lost_targets(_rs9d, BF.merge(_stripped9d, _bf_new, "2026-09-24")[0])
        c.add("T9c", "回填账本可重算（同一日逐行相同；跨日只许 次数+1、首次出现不动）"
                     "且**已有的行不许被抹掉、人写过的去向不许丢**"
                     "（2026-09-23 更正：原先写「只增不删」，它与 T9b 的「条数 ≡ 重算」不可能同时成立；"
                     "已不再分歧的行移出主账、记入 `回流-撤销-v1.jsonl`，有非默认去向时**拒绝重建**）",
              _content_ok and _once_ok and all(_c9c.values()) and _keep_ok
              and len(_same_today) == len(_bf_rows),
              f"重算 {len(_bf_new)} 条 与账上 {len(_bf_rows)} 条逐行同内容；跨日 → 次数各 +1、"
              f"首次出现不动；人写过的去向 → {'原样保住 ✅' if _keep_ok else '❌被重建抹掉'}；"
              f"反向对照：" + "、".join(f"{k}{'✅报红' if v else '❌没报红'}" for k, v in _c9c.items()))

        # T9d · ★ 两个数**分开**报：发生过的回流 ≠ 已经落到条目里的
        _c9d = BF.counts(_bf_rows)
        c.add("T9d", "★ 两个数分开：「回流事件」（PRD §10 的数）与「已落到条目」不许合并",
              _c9d["回流事件"] == len(_bf_rows) > 0
              and _c9d["回流事件"] == _c9d["去向待定"] + _c9d["已落到条目"]
              and set(_c9d["去向往返"]) == set(BF.TARGETS),
              f"**回流事件 {_c9d['回流事件']}**（非零 ✅）· 去向待定 {_c9d['去向待定']} · "
              f"已落到条目 {_c9d['已落到条目']} · 涉及投放 USD {_c9d['涉及投放USD']:,.2f}；"
              f"恒等式 事件 = 待定 + 已落 ✅　★ 去向由**人**定，机这一侧只把它列出来")

        manual = os.path.join(load.KB, "查询手册.md")
        n_sec = 0
        if os.path.exists(manual):
            n_sec = open(manual, encoding="utf-8").read().count("\n## KB-Q-")
        c.add("KB-CHK-3", "查询手册", n_sec >= 10,
              f"{os.path.relpath(manual, load.REPO)} 含 {n_sec} 条问题（需 ≥10）")
    except Exception as e:                                    # noqa: BLE001
        c.add("KB-CHK-1", "黄金问题可答", False, f"导入 kb_query 失败：{e}")

    # ── 汇总 ─────────────────────────────────────────────────
    result = {
        "schema_version": ledger_doc["schema_version"],
        "snapshot_id": ledger_doc["snapshot_id"],
        "ledger_records": len(real),
        "checks": c.items,
        "failed": len(c.failed),
        "skipped": len(c.skipped),
        "pass": not c.failed,
    }
    if as_json:
        print(json.dumps(result, ensure_ascii=False, indent=1))
    else:
        print(f"═══ 验收 · 需求知识库（{ledger_doc['schema_version']}）═══")
        print(f"快照 {ledger_doc['snapshot_id']}　台账 {len(real)} 条 + {len(placeholder)} 条占位")
        print("　G1 存在性：")
        for i in c.items:
            if i["id"].startswith("C"):
                mark = {"PASS": "✅", "FAIL": "❌", "SKIP": "⏭️ "}[i["status"]]
                print(f"  {mark} {i['id']:<4}{i['name']:<10} {i['detail']}")
        print("　G3 可用性：")
        for i in c.items:
            if i["id"].startswith("KB-CHK-"):
                mark = {"PASS": "✅", "FAIL": "❌", "SKIP": "⏭️ "}[i["status"]]
                print(f"  {mark} {i['id']:<4}{i['name']:<10} {i['detail']}")
        print("　F 组 · 4 类知识库实例化（B3.2）：")
        for i in sorted((x for x in c.items if x["id"].startswith("F")),
                        key=lambda x: x["id"]):
            mark = {"PASS": "✅", "FAIL": "❌", "SKIP": "⏭️ "}[i["status"]]
            print(f"  {mark} {i['id']:<4}{i['name']:<10} {i['detail']}")
        print("　T 组 · 移植项（T17 逐条缺口账 / T18 引用失效 / T19 origin 分级）：")
        for i in sorted((x for x in c.items if x["id"].startswith("T")),
                        key=lambda x: x["id"]):
            mark = {"PASS": "✅", "FAIL": "❌", "SKIP": "⏭️ "}[i["status"]]
            print(f"  {mark} {i['id']:<5}{i['name']} {i['detail']}")
        print("　E 组 · 治理（缺口登记 / 文档可重算）：")
        for i in sorted((x for x in c.items if x["id"].startswith("E")),
                        key=lambda x: x["id"]):
                mark = {"PASS": "✅", "FAIL": "❌", "SKIP": "⏭️ "}[i["status"]]
                print(f"  {mark} {i['id']:<4}{i['name']:<10} {i['detail']}")
        print()
        if c.failed:
            print(f"❌ {len(c.failed)} 项失败：{[i['id'] for i in c.failed]}")
        elif c.skipped:
            print(f"⚠️  无失败，但有 {len(c.skipped)} 项跳过 —— 尚未完整通过")
        else:
            print("✅ G1 + G3 全部通过")
    return 1 if c.failed else 0


if __name__ == "__main__":
    sys.exit(main())

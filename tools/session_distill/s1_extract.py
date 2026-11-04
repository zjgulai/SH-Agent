#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""S1 抽取：DSH 会话 → 规范化原文 + 会话台账。

    python3 tools/session_distill/s1_extract.py --since 2026-10-05            # 预演
    python3 tools/session_distill/s1_extract.py --since 2026-10-05 --apply    # 落盘
    python3 tools/session_distill/s1_extract.py --selftest

默认**预演**（一个字节都不落盘），加 `--apply` 才写。
沿用本仓的干跑纪律（`kb/l7/registry/layers.yaml` 的 `dry_run_note`）：
**闸门早于本脚本的第一个副作用**（建目录 / 写文件）—— 干跑的第一承诺是零副作用。

输出
----
L2（被 `.gitignore:50` 的 `**/_evidence/` 覆盖）
    `PMO/会话蒸馏-20261015/_evidence/raw/<session_id>.json`   逐会话规范化原文
    `PMO/会话蒸馏-20261015/_evidence/watermark.json`          水位线
L1  `PMO/会话蒸馏-20261015/台账-v1.ndjson`                     一会话一行

幂等键 = `(session_id, sha256(源文件字节))`。会话文件是**活日志**、会随对话继续增长
⇒ sha 变了就是「这条会话长了」，要重抽；sha 没变就跳过。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import zstandard
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (  # noqa: E402
    EVIDENCE,
    LEDGER,
    RAW_DIR,
    SESSIONS_ROOT,
    WATERMARK,
    WS_AUDIT,
    WS_KB_PROJECT,
    WS_SANDBOX_PREFIX,
    assistant_texts,
    assistant_tool_calls,
    find_verdicts,
    is_human_message,
    now_iso,
    read_ndjson,
    sha256_bytes,
    trim,
    user_text,
    write_json,
    write_ndjson,
)

JOURNAL_LIMIT = 20000   # 单段文本入库上限（原文全量另存 raw/，台账里只留够判读的）
MAX_SESSIONS = 0        # 0 = 不设上限


# ── 分类：这条会话是干什么的 ────────────────────────────────────────
def classify(sess: dict) -> str:
    """按**第一条人话**的形状分类。这是给读的人用的粗分，不是判据。"""
    humans = sess["human"]
    if not humans:
        return "无人类消息"
    first = humans[0]["text"]
    if len(humans) > 1:
        return "多轮对话"
    # 单条会话
    if first.startswith("【") or "对方这条消息里附了" in first or first.startswith("[图片]"):
        return "守衡送审单"
    if first.startswith("[视频]") or "【视频本体" in first:
        return "守衡送审单"
    if "素材已落盘" in first or "这条能不能发" in first or "请审查" in first:
        return "守衡送审单"
    # 有标题/正文两段式的商品页送审
    if len(first) > 2000:
        return "守衡送审单"
    return "单条指令"


def extract_one(path: Path, ws: str) -> dict:
    """把一条会话文件解成规范化记录。返回 None 表示解不开（坏文件/写到一半）。"""
    b = path.read_bytes()
    try:
        text = zstandard.ZstdDecompressor().stream_reader(open(path, "rb")).read().decode(
            "utf-8", "replace"
        )
    except Exception as e:  # 写到一半 / 截断
        return {"_error": "%s: %s" % (type(e).__name__, e), "_bytes": len(b)}

    meta = {"session_id": path.parent.name, "ws": ws, "cwd": None,
            "created_at": None, "depth": None, "preset": None}
    human, assistant, tools, results = [], [], [], []
    n_lines = 0
    bad_lines = 0

    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        n_lines += 1
        try:
            rec = json.loads(line)
        except Exception:
            bad_lines += 1
            continue
        t = rec.get("type")
        if t == "session":
            meta["cwd"] = rec.get("cwd")
            meta["created_at"] = rec.get("createdAt")
            meta["depth"] = rec.get("delegationDepth")
            meta["preset"] = rec.get("agentPreset")
        elif is_human_message(rec):
            human.append({"seq": rec.get("seq"), "t": rec.get("time"),
                          "text": trim(user_text(rec), JOURNAL_LIMIT)})
        elif t == "assistant/message":
            for txt in assistant_texts(rec):
                assistant.append({"seq": rec.get("seq"),
                                  "turn": (rec.get("data") or {}).get("turn"),
                                  "step": (rec.get("data") or {}).get("step"),
                                  "text": trim(txt, JOURNAL_LIMIT)})
            for tc in assistant_tool_calls(rec):
                tools.append({"seq": rec.get("seq"), "name": tc["name"], "args": tc["args"]})
        elif t == "tool/result":
            d = rec.get("data") or {}
            s = json.dumps(d, ensure_ascii=False)
            results.append({"seq": rec.get("seq"), "head": trim(s, 3000)})

    if not human:
        return {"_skip": "无人类消息"}

    meta.update({
        "mtime": int(path.stat().st_mtime),
        "src_bytes": len(b),
        "src_sha256": sha256_bytes(b),
        "n_lines": n_lines,
        "bad_lines": bad_lines,
        "n_human": len(human),
        "n_assistant": len(assistant),
        "n_tool_calls": len(tools),
        "human": human,
        "assistant": assistant,
        "tool_calls": tools,
        "tool_results": results,
    })
    meta["kind"] = classify(meta)
    meta["verdicts_mentioned"] = sorted({v for a in assistant for v in find_verdicts(a["text"])})
    return meta


def load_watermark() -> dict:
    if WATERMARK.exists():
        try:
            return json.loads(WATERMARK.read_text(encoding="utf-8"))
        except Exception:
            return {"processed": {}}
    return {"processed": {}}


def run(since: float, apply: bool, limit: int = 0, quiet: bool = False):
    t0 = time.time()
    cand = []
    counters = {"扫到会话文件": 0, "沙箱（排除）": 0, "其它工作区（排除）": 0,
                "太旧（排除）": 0, "解不开": 0, "无人类消息（排除）": 0,
                "子 agent（排除）": 0, "入选": 0, "未变（跳过）": 0,
                # ★ 幂等的**真判据**。原先我拿「未变 == 台账数」当幂等断言，
                #   而会话是**活日志** —— 跑一次期间就有 8 条长出了新内容，
                #   于是那条断言恒不可能为真。恒假的断言比没有断言更糟：
                #   它会让人开始不看报告。真正可证伪的性质是右边这两条。
                "重抽·源已变": 0, "重抽·源未变（应 == 0）": 0, "首次见到（新会话）": 0}
    wm = load_watermark()
    processed = wm.get("processed", {})
    new_processed = dict(processed)

    for ws_dir in sorted(SESSIONS_ROOT.iterdir()):
        if not ws_dir.is_dir():
            continue
        ws = ws_dir.name
        in_scope = (WS_AUDIT in ws) or (WS_KB_PROJECT in ws)
        is_sandbox = ws.startswith(WS_SANDBOX_PREFIX)
        for path in sorted(ws_dir.glob("*/session.jsonl.zstd")):
            counters["扫到会话文件"] += 1
            if is_sandbox:
                counters["沙箱（排除）"] += 1
                continue
            if not in_scope:
                counters["其它工作区（排除）"] += 1
                continue
            if path.stat().st_mtime < since:
                counters["太旧（排除）"] += 1
                continue
            sid = path.parent.name
            sha = sha256_bytes(path.read_bytes())
            key = "%s@%s" % (sid, sha)
            if key in processed and not limit:
                counters["未变（跳过）"] += 1
                continue
            # 这个 session_id 以前处理过吗？处理过 ⇒ 这次是**重抽**，必须是因为源变了
            prev_shas = {v.get("sha256") for k, v in processed.items()
                         if k.split("@", 1)[0] == sid}
            # 三种来路必须分得开：**新会话** / **源变了的重抽** / **源没变的重抽**。
            # 最后一种是唯一的 bug 形状；前两种都是正常的。
            if not prev_shas:
                counters["首次见到（新会话）"] += 1
            elif sha in prev_shas:
                counters["重抽·源未变（应 == 0）"] += 1
            else:
                counters["重抽·源已变"] += 1
            sess = extract_one(path, ws)
            if "_error" in sess:
                counters["解不开"] += 1
                sess = {"session_id": sid, "ws": ws, "_error": sess["_error"],
                        "_bytes": sess["_bytes"], "src_sha256": sha}
            elif "_skip" in sess:
                counters["无人类消息（排除）"] += 1
                new_processed[key] = {"at": now_iso(), "skip": sess["_skip"], "sha256": sha}
                continue
            elif (sess.get("depth") or 0) > 0:
                counters["子 agent（排除）"] += 1
                new_processed[key] = {"at": now_iso(), "skip": "子 agent", "sha256": sha}
                continue
            else:
                counters["入选"] += 1
                new_processed[key] = {"at": now_iso(), "mtime": sess["mtime"],
                                      "sha256": sha, "kind": sess["kind"]}
            cand.append(sess)
            if limit and len(cand) >= limit:
                break
        if limit and len(cand) >= limit:
            break

    if not quiet:
        print("── S1 抽取 " + ("（--apply 真写）" if apply else "（预演，不落盘）"))
        for k, v in counters.items():
            print("   %-22s %d" % (k, v))
        print("   用时 %.1fs" % (time.time() - t0))

    if apply:
        RAW_DIR.mkdir(parents=True, exist_ok=True)
        for sess in cand:
            if "_error" in sess:
                continue
            write_json(RAW_DIR / ("%s.json" % sess["session_id"]), sess)
        rows = []
        for sess in cand:
            if "_error" in sess:
                continue
            rows.append({
                "session_id": sess["session_id"],
                "ws": sess["ws"],
                "cwd": sess["cwd"],
                "kind": sess["kind"],
                "created_at": sess["created_at"],
                "mtime": sess["mtime"],
                "n_human": sess["n_human"],
                "n_assistant": sess["n_assistant"],
                "n_tool_calls": sess["n_tool_calls"],
                "chars_human": sum(len(h["text"]) for h in sess["human"]),
                "src_bytes": sess["src_bytes"],
                "src_sha256": sess["src_sha256"],
                "verdicts_mentioned": sess["verdicts_mentioned"],
                "first_human": trim(sess["human"][0]["text"], 160),
                "raw_ref": "PMO/会话蒸馏-20261015/_evidence/raw/%s.json" % sess["session_id"],
            })
        # 台账必须**累积**：增量跑时不能把上一轮的行丢掉
        old = {r["session_id"]: r for r in read_ndjson(LEDGER)}
        for r in rows:
            old[r["session_id"]] = r
        n = write_ndjson(LEDGER, [old[k] for k in sorted(old)])
        wm["processed"] = new_processed
        wm["last_run_at"] = now_iso()
        wm["last_since"] = time.strftime("%Y-%m-%d", time.localtime(since))
        write_json(WATERMARK, wm)
        print("   已写：台账 %d 行（本轮新增/更新 %d）" % (n, len(rows)))
        return counters, n
    return counters, len(cand)


# ── 反向对照 ────────────────────────────────────────────────────────
def selftest() -> int:
    """自证：拿**构造的**记录喂判据，正反各一遍。"""
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from common import is_human_message, find_verdicts
    fails = []
    n_ck = [0]

    def ck(name, got, want):
        # ★ 断言条数**现算**，不写死常数：写死的那版加了 4 条断言之后还在打印旧数字，
        #   而「结论行说的数」本身就是一条要被验的读数（AGENTS.md §2.7 H1–H7）。
        n_ck[0] += 1
        if got != want:
            fails.append("%s：得到 %r，期望 %r" % (name, got, want))

    # T1 人话判据：role=user 但 source.kind != user —— 必须**不**算人话
    ck("T1 系统注入不算人话",
       is_human_message({"type": "user/message", "data": {
           "role": "user", "source": {"kind": "plugin"},
           "content": [{"type": "text", "text": "Current runtime context: ..."}]}}), False)
    # T2 反向对照：source.kind=user 但以系统前缀开头 —— 也必须挡掉
    ck("T2 前缀黑名单",
       is_human_message({"type": "user/message", "data": {
           "source": {"kind": "user"},
           "content": [{"type": "text", "text": "<system-reminder> 你好"}]}}), False)
    # T3 真·人话必须**通过**（否则 T1/T2 恒真）
    ck("T3 真·人话通过",
       is_human_message({"type": "user/message", "data": {
           "source": {"kind": "user"},
           "content": [{"type": "text", "text": "这条能不能发？"}]}}), True)
    # T4 空文本不算
    ck("T4 空文本不算",
       is_human_message({"type": "user/message", "data": {
           "source": {"kind": "user"}, "content": [{"type": "text", "text": "   "}]}}), False)
    # T5 三态词只做出现性统计，不做子串误命中
    ck("T5 BLOCK 边界", find_verdicts("结论是 BLOCK。"), ["BLOCK"])
    ck("T5b BLOCKED 不该命中", find_verdicts("BLOCKED"), [])
    ck("T5c NEEDS_INPUT", find_verdicts("状态：NEEDS_INPUT ｜ 问题数：0"), ["NEEDS_INPUT"])
    # T6 分类器：两条以上人话 = 多轮对话
    ck("T6 多轮",
       classify({"human": [{"text": "a"}, {"text": "b"}]}), "多轮对话")
    ck("T6b 送审单",
       classify({"human": [{"text": "【对方这条消息里附了图，共 1 张。…"}]}), "守衡送审单")
    ck("T6c 单条指令",
       classify({"human": [{"text": "守衡输出的pass结论跟prd格式不符，你修复下"}]}), "单条指令")

    if fails:
        print("❌ S1 自证未过（%d / %d 项）" % (len(fails), n_ck[0]))
        for f in fails:
            print("   " + f)
        return 1
    print("✅ S1 自证全过（%d 项反向对照）" % n_ck[0])
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", default="2026-10-05", help="起始日期 YYYY-MM-DD（按会话文件 mtime）")
    ap.add_argument("--apply", action="store_true", help="真写；不带即预演")
    ap.add_argument("--limit", type=int, default=0, help="只处理前 N 条（调试用）")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    if a.selftest:
        return selftest()
    since = time.mktime(time.strptime(a.since, "%Y-%m-%d"))
    counters, n = run(since, a.apply, a.limit)
    return 0


if __name__ == "__main__":
    sys.exit(main())

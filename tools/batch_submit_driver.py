#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""batch_submit_driver.py —— 把一张表里的待审素材**逐条**喂给守衡。

── 为什么要这个驱动（而不是让守衡自己读表跑）────────────────────────────────

  守衡没有批量入口，而且**一轮最多 6 次工具调用**（`agent/config.mjs` 的
  `maxToolIters`，默认 6）⇒ 一条消息最多推进约 5 条。更要紧的是：
  让它自己读表、逐条调 `kb_review_chain`，那条路**绕开送审闸门**
  （`review_gate.mjs` 的闸门只对「到达的消息」跑）⇒ PRD §5.3 那套
  （结论行进抬头 / 双轨合并计数 / 兜底建卡）**不生效**，人看到的是模型转述工具输出。

  ⇒ 要那套生效，每条必须**像正常送审一样进来**：这个驱动就干这一件事。

── 它的形状 ────────────────────────────────────────────────────────────────

  读表 → 逐条 `lark-cli im +messages-send --as user` → **等这条答完**再发下一条
  → 进度落盘（可续跑）→ 结束打印每条耗时。

  为什么**串行**、不并发：KB 侧有全局命令锁 `kb/.work/.kb.lock`，
  一次灌 80 条只会收获一堆「库忙」；串行还顺带得到干净的一问一答时间线。

  配对方式：台账 `PMO/logs/ws_outbound.jsonl` 的 `reply_to` == 我们发出去那条的
  `message_id`（回执卡 `source=chain-ack` 要跳过，只认 `source=reply` 的最终回答）。
  ⇒ **素材逐字发，不加任何前缀**：配对靠 message_id，不靠正文里的标记。

── 边界（写清楚，免得下一个人以为它是守衡的发送面）──────────────────────────

  · 它**以「用户」身份**发消息（`--as user`），不是以守衡身份；
    因此它**不进守衡的出站台账**，也不在 `verify_outbound.py` 的发送者总表
    （`SEND_OWNERS`）覆盖范围内 —— 那张表管的是「谁能以**守衡**的名义说话」。
  · 它**不写任何业务数据**：只读表 + 发消息。回填结论是另一件事（另写、要人点头）。
  · 目标会话、表、条目范围全部由命令行给出，默认值只写在这一个地方。

用法：
  python3 tools/batch_submit_driver.py --dry-run --limit 5     # 只打印要发什么
  python3 tools/batch_submit_driver.py --limit 5              # 真发 5 条（试跑）
  python3 tools/batch_submit_driver.py --limit 0              # 全部（0 = 不限）
  python3 tools/batch_submit_driver.py --status               # 看进度，不发
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LARK = os.path.expanduser("~/.dsh/bin/lark-cli")
LEDGER = os.path.join(ROOT, "PMO/logs/ws_outbound.jsonl")
STATE = os.path.join(ROOT, "PMO/shouheng-state/batch-submit.json")

# ── 默认值：只写在这一个地方（表、会话、字段名）────────────────────────────
DEF_BASE = "RY2UbCRjXaeeWwscUPScVN5AnQc"       # 「内容治理问题描述」那个 Base
DEF_TABLE = "tblavfbMDMeRsulo"                 # 「内容治理数据采集」（80 行）
DEF_CHAT = "oc_TEST_P2P"   # 与守衡的私聊
FIELD_TEXT = "采集数据"                         # 素材原文
FIELD_ID = "内容 ID"
FIELD_STATE = "状态"
SEND_AS = "user"                               # ★ 以用户身份发（见文件头「边界」）

WAIT_TIMEOUT_S = 1800        # 单条等 30 分钟（实测链 4~10 分钟，留足余量）
POLL_S = 5


def run(cmd: list[str]) -> tuple[int, str, str]:
    p = subprocess.run(cmd, capture_output=True, text=True, cwd=ROOT)
    return p.returncode, p.stdout, p.stderr


def load_state() -> dict:
    if os.path.exists(STATE):
        try:
            return json.load(open(STATE, encoding="utf-8"))
        except Exception:
            pass
    return {"items": {}}


def save_state(st: dict) -> None:
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    # 原子写：中途被打断也不留半份 JSON（队列要能续跑，半份 JSON 等于全丢）
    tmp = STATE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(st, f, ensure_ascii=False, indent=2, sort_keys=True)
    os.replace(tmp, STATE)


def read_rows(base: str, table: str, as_id: str = "user") -> list[dict]:
    """读表。

    ★ 用 `lark-cli base +record-list --format json`，**不**用 `lark_find.py records`：
      后者打的是给人看的转储（实测头一行是 `total=80 has_more=False returned=80`），
      拿它当机器接口会当场抛「不是 JSON」—— 而**报错的位置在解析处、根因在选型**，
      下一个人会去改解析。JSON 那份是**位置式**的：`data.fields` 与每行按序对齐。
    """
    code, out, err = run([LARK, "base", "+record-list", "--base-token", base,
                          "--table-id", table, "--page-size", "200",
                          "--as", as_id, "--format", "json"])
    if code != 0:
        raise SystemExit(f"读表失败（rc={code}）：{(err or out)[:400]}")
    try:
        d = (json.loads(out) or {}).get("data") or {}
    except json.JSONDecodeError:
        raise SystemExit(f"读表返回的不是 JSON：{out[:300]}")
    fields = d.get("fields") or []
    if FIELD_TEXT not in fields or FIELD_ID not in fields:
        raise SystemExit(f"表里没有预期字段（{FIELD_ID} / {FIELD_TEXT}）；实际字段：{fields}")
    i_id, i_txt, i_st = fields.index(FIELD_ID), fields.index(FIELD_TEXT), fields.index(FIELD_STATE)

    def cell(row, i):
        v = row[i] if i < len(row) else None
        if isinstance(v, list):
            return "".join(x.get("text", "") if isinstance(x, dict) else str(x) for x in v)
        return "" if v is None else str(v)

    ids = d.get("record_id_list") or []
    rows = []
    for n, row in enumerate(d.get("data") or []):
        rows.append({"record_id": ids[n] if n < len(ids) else None,
                     "content_id": cell(row, i_id), "state": cell(row, i_st),
                     "text": cell(row, i_txt)})
    if d.get("has_more"):
        print(f"⚠ 表里还有下一页没读（has_more=true，本次读到 {len(rows)} 行）—— "
              f"分页没做，别把它当成「表里只有这些」", file=sys.stderr)
    return rows


def send_one(chat: str, text: str, idem: str, dry: bool) -> dict:
    cmd = [LARK, "im", "+messages-send", "--as", SEND_AS, "--chat-id", chat,
           "--text", text, "--idempotency-key", idem[:50], "--format", "json"]
    if dry:
        cmd.append("--dry-run")
    code, out, err = run(cmd)
    if code != 0:
        return {"ok": False, "error": (err or out)[:400]}
    try:
        d = json.loads(out)
    except json.JSONDecodeError:
        return {"ok": False, "error": f"发送返回非 JSON：{out[:200]}"}
    mid = (((d or {}).get("data") or {}).get("message_id")
           or ((d or {}).get("data") or {}).get("message", {}).get("message_id"))
    return {"ok": bool(d.get("ok")) and (bool(mid) or dry), "message_id": mid,
            "raw_ok": d.get("ok"), "error": None if d.get("ok") else json.dumps(d, ensure_ascii=False)[:300]}


def wait_answer(message_id: str, since_off: int, timeout_s: int) -> dict | None:
    """等这条的**最终回答**落地（跳过 chain-ack 回执）。返回台账那一行。"""
    t0 = time.time()
    while time.time() - t0 < timeout_s:
        time.sleep(POLL_S)
        try:
            with open(LEDGER, "rb") as f:
                f.seek(since_off)
                chunk = f.read().decode("utf-8", "replace")
        except OSError:
            continue
        for line in chunk.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                e = json.loads(line)
            except json.JSONDecodeError:
                continue
            if e.get("reply_to") == message_id and e.get("source") == "reply":
                return e
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=DEF_BASE)
    ap.add_argument("--table", default=DEF_TABLE)
    ap.add_argument("--chat", default=DEF_CHAT)
    ap.add_argument("--limit", type=int, default=5, help="发多少条（0 = 不限）")
    ap.add_argument("--dry-run", action="store_true", help="只打印要发什么，不真发")
    ap.add_argument("--status", action="store_true", help="只看进度，不发")
    ap.add_argument("--timeout", type=int, default=WAIT_TIMEOUT_S)
    a = ap.parse_args()

    rows = read_rows(a.base, a.table)
    st = load_state()
    done = st["items"]

    if a.status:
        for r in rows:
            d = done.get(r["content_id"] or r["record_id"]) or {}
            print(f"  {r['content_id']:<22} {r['state']:<6} "
                  f"{'已答 ' + str(d.get('secs')) + 's' if d.get('answered_at') else ('已发待答' if d.get('sent_at') else '未发')}")
        n_ans = sum(1 for d in done.values() if d.get("answered_at"))
        print(f"共 {len(rows)} 行 ｜ 已发 {len(done)} ｜ 已答 {n_ans}")
        return 0

    # 只跑「有待审素材、且还没答过」的行
    todo = [r for r in rows
            if (r["text"] or "").strip()
            and not (done.get(r["content_id"] or r["record_id"]) or {}).get("answered_at")]
    if a.limit:
        todo = todo[:a.limit]
    if not todo:
        print("没有要发的行（都答过了？）")
        return 0

    print(f"待发 {len(todo)} 条 ｜ 会话 {a.chat} ｜ 身份 {SEND_AS} ｜ "
          f"{'干跑' if a.dry_run else '真发'}")
    t_all = time.time()
    for i, r in enumerate(todo, 1):
        key = r["content_id"] or r["record_id"]
        body = (r["text"] or "").strip()
        print(f"\n[{i}/{len(todo)}] {key} ｜ 素材 {len(body)} 字 ｜ 表内状态 {r['state']}")
        if a.dry_run:
            print("   —— 将逐字发送（前 160 字）：", body[:160].replace("\n", " ⏎ "))
            continue

        off = os.path.getsize(LEDGER) if os.path.exists(LEDGER) else 0
        sent = send_one(a.chat, body, f"batch-{key}", dry=False)
        if not sent["ok"]:
            print("   ❌ 没发出去：", sent["error"])
            done[key] = {"record_id": r["record_id"], "error": sent["error"], "at": time.time()}
            save_state(st)
            continue
        mid = sent["message_id"]
        print(f"   ↑ 已发 message_id={mid}，等它答…")
        t0 = time.time()
        ans = wait_answer(mid, off, a.timeout)
        secs = round(time.time() - t0, 1)
        if ans is None:
            print(f"   ⏱ {secs}s 内没等到回答（超时）—— 记下来，可续跑")
            done[key] = {"record_id": r["record_id"], "message_id": mid,
                         "sent_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "timeout": True, "secs": secs}
        else:
            print(f"   ✅ {secs}s ｜ mode={ans.get('mode')} ｜ chars={ans.get('chars')} ｜ "
                  f"{(ans.get('text') or '').splitlines()[0][:70]}")
            done[key] = {"record_id": r["record_id"], "message_id": mid,
                         "sent_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                         "answered_at": ans.get("at"), "secs": secs,
                         "mode": ans.get("mode"), "chars": ans.get("chars"),
                         "answer_head": (ans.get("text") or "").splitlines()[0][:120]}
        save_state(st)

    if not a.dry_run:
        ok = [d for d in done.values() if d.get("answered_at")]
        ss = sorted(d["secs"] for d in ok if d.get("secs"))
        print(f"\n本轮结束 ｜ 累计已答 {len(ok)} 条 ｜ 总耗时 {round(time.time()-t_all,1)}s")
        if ss:
            mid = ss[len(ss)//2]
            print(f"单条耗时：最快 {ss[0]}s ｜ 中位 {mid}s ｜ 最慢 {ss[-1]}s "
                  f"⇒ 跑满 80 条预计 ≈ {round(mid*80/3600,1)} 小时（按中位算）")
    return 0


if __name__ == "__main__":
    sys.exit(main())

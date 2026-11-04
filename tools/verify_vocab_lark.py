#!/usr/bin/env python3
"""verify_vocab_lark.py —— 机器词表「飞书 ↔ 本地」逐词回读比对（只读）

为什么必须回读：写入返回 `code 0` 只证明**请求被接受**，不证明**内容等于本地**。
字段类型不符会被静默转换、单选选项不匹配会新建选项、长文本会被截断 ——
这些都返回成功。所以验收必须以**读回来的值**为准。

比对对象：
  飞书「语境守卫词」表  ←→  research/governance/skeleton/context-guards-v1.json
  飞书「白名单词」表    ←→  research/governance/skeleton/whitelist-v1.json

用法：
  python3 tools/verify_vocab_lark.py
  python3 tools/verify_vocab_lark.py --json
"""
import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
# HTTP 调用是**唯一实现**，不许在本文件里再抄一份（超时/头/错误形状都在那里定义）。
from lark_http import get_json, post_json_strict  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SK = ROOT / "research/governance/skeleton"
CRED = os.path.expanduser("~/.dsh/credentials/shouheng-lark.json")
BASE = "https://open.feishu.cn/open-apis"
APP = "B1oabL2veaFKbKs2hVAcvyKKnEe"


# ── HTTP：`call()` 已收编到 tools/lark_http.py（2026-09-22）──────────────
#   本文件那份的**契约与另外四份不同**：只 GET、不带 Content-Type、
#   只在 HTTPError 时返回 dict（超时/连接错误**原样抛出**，因为调用方靠它崩掉报错）。
#   所以它对应的不是 lark_http.call()，而是 lark_http.get_json() —— 逐条保留那个契约。
#   token() 同理：原来「一个异常都不吞」，现在用 post_json_strict()。
#   行为等价的证据：`python3 tools/lark_http.py --controls`。


def token():
    c = json.loads(Path(CRED).read_text())
    return post_json_strict(f"{BASE}/auth/v3/tenant_access_token/internal",
                            {"app_id": c["app_id"], "app_secret": c["app_secret"]}
                            )["tenant_access_token"]


def fetch(T, tid):
    out, pt = [], None
    while True:
        u = f"{BASE}/bitable/v1/apps/{APP}/tables/{tid}/records?page_size=200"
        if pt:
            u += f"&page_token={pt}"
        r = get_json(u, T)
        if r.get("code") != 0:
            raise SystemExit(f"❌ 读 {tid} 失败：{json.dumps(r, ensure_ascii=False)[:300]}")
        out += r["data"].get("items", [])
        if not r["data"].get("has_more"):
            return out
        pt = r["data"]["page_token"]


def _counts(rows, key):
    """每一行按 `key` 列计数。**用行计数，不用集合** —— 集合会把重复吃掉。"""
    import collections
    return collections.Counter(flat((r.get("fields") or {}).get(key)) for r in rows)


def flat(v):
    if v is None:
        return ""
    if isinstance(v, str):
        return v
    if isinstance(v, list):
        return " ".join(flat(x) for x in v)
    if isinstance(v, dict):
        return str(v.get("text") or v.get("name") or "")
    return str(v)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    T = token()
    tabs = {x["name"]: x["table_id"]
            for x in get_json(f"{BASE}/bitable/v1/apps/{APP}/tables?page_size=50", T)["data"]["items"]}
    report = {"tables": {}, "ok": True}

    # ── 语境守卫词 ────────────────────────────────────────────────
    G = json.loads((SK / "context-guards-v1.json").read_text())
    st = {"active": "已接线", "pending": "待法务定性", "misrouted": "走错通道"}
    # ★ 2026-09-16：原来这里是一句 dict 推导 —— `{词: 字段 for r in fetch(...)}`。
    #   它按**词**建索引，于是同一个词的第二行、第三行被静默覆盖：重复永远看不见。
    #   而迁移脚本默认是 `batch_create`（追加），跑第二次就会整表翻倍 ——
    #   两条缺陷叠起来，「同步成功」在第二次运行时无法被自己的工具证伪。
    #   改成先留原始行，再单独数行数与唯一词数。
    raw_g = fetch(T, tabs["语境守卫词"])
    live_g = {flat(r["fields"].get("守卫词")): r["fields"] for r in raw_g}
    local_g = {w["word"]: w for w in G["words"]}
    dup_g = {k: v for k, v in _counts(raw_g, "守卫词").items() if v > 1}

    print("① 语境守卫词：逐词比对")
    miss = sorted(set(local_g) - set(live_g))
    extra = sorted(set(live_g) - set(local_g))
    mism = []
    for w, e in local_g.items():
        f = live_g.get(w)
        if not f:
            continue
        want = {"状态": st.get(e["status"], e["status"]), "语种": e["lang"],
                "守卫类型": e["guard_type"],
                "降级目标规则": " / ".join(e["downgrades"]),
                "现网来源": e.get("source_legacy") or "骨架独有（现网未登记）"}
        for k, v in want.items():
            got = flat(f.get(k))
            if got != v:
                mism.append({"词": w, "字段": k, "本地": v, "飞书": got})
    print(f"   本地 {len(local_g)} 词 ｜ 飞书 {len(raw_g)} 行（唯一 {len(live_g)} 词）")
    print(f"   重复行 {len(dup_g)} 词：{list(dup_g.items())[:6]}{' …' if len(dup_g) > 6 else ''}"
          + ("   ★ 行数 ≠ 唯一词数，说明迁移是**追加**上去的（应当 --force 重建）"
             if dup_g else ""))
    print(f"   仅本地有 {len(miss)}：{miss[:6]}{' …' if len(miss) > 6 else ''}")
    print(f"   仅飞书有 {len(extra)}：{extra[:6]}{' …' if len(extra) > 6 else ''}")
    print(f"   字段不符 {len(mism)}")
    for m in mism[:8]:
        print(f"      {m['词']:<22} {m['字段']}：本地={m['本地']!r} 飞书={m['飞书']!r}")
    report["tables"]["语境守卫词"] = {"local": len(local_g), "lark": len(live_g),
                                      "lark_rows": len(raw_g), "duplicates": dup_g,
                                      "only_local": miss, "only_lark": extra,
                                      "field_mismatch": mism}

    # ── 白名单词 ─────────────────────────────────────────────────
    W = json.loads((SK / "whitelist-v1.json").read_text())
    raw_w = fetch(T, tabs["白名单词"])          # 同上：留原始行，重复才有形
    live_w = {flat(r["fields"].get("白名单词")): r["fields"] for r in raw_w}
    local_w = {e["word"]: e for e in W["words"]}
    dup_w = {k: v for k, v in _counts(raw_w, "白名单词").items() if v > 1}

    print("\n② 白名单词：逐词比对")
    miss_w = sorted(set(local_w) - set(live_w))
    extra_w = sorted(set(live_w) - set(local_w))
    mism_w = []
    for w, e in local_w.items():
        f = live_w.get(w)
        if not f:
            continue
        want = {"状态": "生效" if e["status"] == "active" else "隔离", "语种": e.get("lang", ""),
                "证据要求": e.get("evidence_required", ""),
                "隔离原因": e.get("quarantine_reason") or ""}
        for k, v in want.items():
            got = flat(f.get(k))
            if got != v:
                mism_w.append({"词": w, "字段": k, "本地": v, "飞书": got})
    print(f"   本地 {len(local_w)} 词 ｜ 飞书 {len(raw_w)} 行（唯一 {len(live_w)} 词）")
    print(f"   重复行 {len(dup_w)} 词：{list(dup_w.items())[:6]}{' …' if len(dup_w) > 6 else ''}")
    print(f"   仅本地有 {len(miss_w)}：{miss_w}")
    print(f"   仅飞书有 {len(extra_w)}：{extra_w}")
    print(f"   字段不符 {len(mism_w)}")
    for m in mism_w[:8]:
        print(f"      {m['词']:<22} {m['字段']}：本地={m['本地']!r} 飞书={m['飞书']!r}")
    report["tables"]["白名单词"] = {"local": len(local_w), "lark": len(live_w),
                                    "lark_rows": len(raw_w), "duplicates": dup_w,
                                    "only_local": miss_w, "only_lark": extra_w,
                                    "field_mismatch": mism_w}

    # ★ 重复行必须让验证**失败**：一张每行都有两份的表，逐词比对是「一致」的，
    #   但业务看到的是双倍的行数 —— 而业务看的就是行数。
    report["ok"] = not (miss or extra or mism or miss_w or extra_w or mism_w
                        or dup_g or dup_w)
    print()
    if report["ok"]:
        print("结论：✅ 飞书与本地逐词一致（回读值，非写入返回码）")
    elif dup_g or dup_w:
        print("结论：❌ 飞书表内存在**重复行** —— 逐词比对一致，但行数翻倍。"
              "迁移是追加语义，请用 `--apply --force` 删表重建。")
    else:
        print("结论：❌ 存在不一致 —— 见上")
    if a.json:
        print(json.dumps(report, ensure_ascii=False, indent=1))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())

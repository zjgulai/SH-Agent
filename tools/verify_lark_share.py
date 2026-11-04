#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
verify_lark_share.py —— 「外部标准库（待法务确认）」那张表，**别人点得开吗**？

## 它治的是什么（2026-09-22）

15:42 我们把表链接发进了群。链接能不能被打开，当时唯一的依据是**接口读数**：

    drive/v1/permissions/{token}/public  →  link_share_entity = tenant_editable

这是一句**声明**，不是一次**实测**。而本仓已经栽过一次「开关是声明、条数是证据」
（`AGENTS.md` §2.4.1 第 3 行：通讯录 scope 授权了、接口 `code=0`，但可见范围只有 2 人）。
所以这份读数必须变成一个每次可重跑的判据 —— 这份脚本就是它。

## 三个真实对象，天然构成三态反向对照（2026-09-22 实测，同租户/同接口/同一次会话）

| Base | `link_share_entity` | 读法 |
|---|---|---|
| `A437bIdQfax7dbsyrAncPpbNnjh`（需求知识库 —— 表建在这） | `tenant_editable` | 组织内拿到链接**可编辑** ✅ |
| `Lk3Qb8y2QaVyZns6gprcVNE9nA0`（吸奶器广告文案·品线内容边界风控） | `tenant_readable` | 组织内**只读** |
| `GnRZbIuXraCzf0sGr2UcmZ62nfc`（内容治理-知识库） | **`closed`** | **链接分享已关 —— 拿到链接也打不开** ❌ |

**不需要造假样本**：后两个是真红、真黄。它们同时是「这个判据会不会红」的证明 ——
一个从没红过的断言，不算验证过它。

## 这个脚本**证不到**的那一段，明着写在输出里

* 接口能证到「组织内可编辑」；证不到「她的客户端下确实点开了」。**那只有人能证。**
* `tenant_editable` 只覆盖**本租户**。而她要把表给的是**法务合规同事** ——
  法务若是租户外的账号，链接等于没给（该文档 `external_access=true` / `invite_external=true`，
  加协作者是可行的，但需要对方账号）。**这一条机器答不了**，只能问 → 待收清单 **P-06**。
* 「她在本租户」这一步：可读到的是「她那条消息带的 `tenant_key`」；而「表也在该租户」
  是**结构性**的（自建应用不能跨租户建 Base），**不是**本脚本读出来的。输出里会这么写，
  不许把它读成「接口证明了同一租户」。

用法：
  python3 tools/verify_lark_share.py                 # 目标表 + 两个真实对照 + 表存在性 + 条数恒等
  python3 tools/verify_lark_share.py --controls      # 离线：喂合成 permission_public，断言三态分得开
  python3 tools/verify_lark_share.py --token <t>     # 只读某个 token（拿来亲眼看它会不会红）
退出码：0 = 绿 / 1 = 红 / 2 = **未测**（接口读不到 ≠ 没开分享，两者不许长一样）
"""
import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lark_http import call  # noqa: E402  —— 全仓唯一 HTTP 入口

# 建表脚本与本脚本**必须指同一张表** —— 所以常量不从这儿再抄一份，直接引用它。
# （抄一份的后果：改了一处、另一处安静地验着别的表。）
# 来源：tools/migrate_external_to_lark.py（同目录，靠上面那行 sys.path 找得到）。
from migrate_external_to_lark import APP_TOKEN, TABLE_NAME, load_library, token  # noqa: E402

API = "https://open.feishu.cn/open-apis"
ROOT = Path(__file__).resolve().parent.parent
EVENTS = ROOT / "PMO" / "logs" / "ws_events.jsonl"

# 两个**真实**反向对照 Base（口径见文件头表格）。它们的状态每次现读，不写死结论。
CTRL_READABLE = ("Lk3Qb8y2QaVyZns6gprcVNE9nA0", "吸奶器广告文案·品线内容边界风控")
CTRL_CLOSED = ("GnRZbIuXraCzf0sGr2UcmZ62nfc", "内容治理-知识库")

# 她在群里发过消息的租户（由本轮入站事件读出；下同）
HER_MSG_HINT = "美国法务合规"

results, untested = [], []


def check(cid, ok, msg):
    results.append((cid, ok, msg))
    print("  %s %-4s %s" % ("✅" if ok else "❌", cid, msg))


def cannot_test(cid, msg):
    untested.append((cid, msg))
    print("  ⚠ %-4s %s" % (cid, msg))


def verdict(n_fail, n_untested):
    """结论行拆成纯函数 —— 好让 `--controls` 直接断言**这句话本身**不许撒谎。

    | 码 | 含义 | 它**不**代表 |
    |---:|---|---|
    | 0 | 目标表 ≥ 组织内可读，且两个反向对照各自落对 | —— |
    | 1 | 目标不可打开 / 表不存在 / 条数不等 / 反向对照失效 | —— |
    | 2 | **未测**：接口读不到（权限、网络、token） | **不等于「没开分享」** |
    """
    if n_fail:
        tail = "；另有 %d 项未测（见 ⚠ 行）" % n_untested if n_untested else ""
        return 1, "❌ %d 项红%s" % (n_fail, tail)
    if n_untested:
        return 2, ("⚠ %d 项未测 —— 这不是通过（退 2，与 §2.4.2 同口径）："
                   "**读不到不等于没开分享**" % n_untested)
    return 0, "✅ 目标表组织内可打开，且三态反向对照各自落对"


# ── 判据（纯函数）：permission_public → 级别 ────────────────────────────────
LEVELS = {
    "closed": "none",
    "tenant_readable": "read",
    "tenant_editable": "edit",
    "anyone_readable": "anyone_read",
    "anyone_editable": "anyone_edit",
}
ORDER = ["none", "read", "edit", "anyone_read", "anyone_edit"]


def judge_share(perm):
    """纯函数：`permission_public` 字典 → `(级别, 说明)`。

    级别 `unknown` 与 `none` **必须分开**：前者是「我没读到」，后者是「读到了、是关的」。
    这正是 §2.4.1 第 4 行那句自检 —— 否定结论的输入必须是「读到了且是关的」，
    不能是「我没读到」。
    """
    if not isinstance(perm, dict):          # 读不到 / 字段形状不对
        return "unknown", "没有 permission_public 字段（读不到，不是「关着」）"
    v = perm.get("link_share_entity")
    if v is None:
        return "unknown", "permission_public 里没有 link_share_entity（字段口径可能变了）"
    return LEVELS.get(v, "unknown"), "link_share_entity=%s" % v


def ge(level, need):
    """级别是否达到 need。`unknown` 永远达不到 —— 未测不许自动升级成通过。"""
    return level in ORDER and need in ORDER and ORDER.index(level) >= ORDER.index(need)


def read_public(tok, target):
    """读一个 Base 的公开分享设置。回 `(perm_dict_or_None, 说明)`。None = 未测。"""
    r = call("%s/drive/v1/permissions/%s/public?type=bitable" % (API, target), token=tok)
    if r.get("_http"):
        return None, "HTTP 层失败：%s" % json.dumps(r, ensure_ascii=False)[:120]
    if r.get("code") != 0:
        return None, "code=%s msg=%s（应用读不到这份文档 → **未测**）" % (r.get("code"), r.get("msg"))
    return (r.get("data") or {}).get("permission_public"), "code=0"


# ── 离线反向对照：判据自己不许撒谎 ─────────────────────────────────────────
def controls():
    n_ok, n_case = 0, 0

    def t(name, got, want):
        nonlocal n_ok, n_case
        n_case += 1
        if got == want:
            print("  ✅ %s" % name)
            n_ok += 1
        else:
            print("  ❌ %s\n       得到 %r ≠ 期望 %r" % (name, got, want))

    print("A 三态必须分得开（喂合成 permission_public）")
    t("closed → none", judge_share({"link_share_entity": "closed"})[0], "none")
    t("tenant_readable → read", judge_share({"link_share_entity": "tenant_readable"})[0], "read")
    t("tenant_editable → edit", judge_share({"link_share_entity": "tenant_editable"})[0], "edit")
    t("不认识的值 → unknown（不许当成 none）",
      judge_share({"link_share_entity": "something_new"})[0], "unknown")
    t("字段缺失 → unknown", judge_share({})[0], "unknown")
    t("整个 data 没读回来 → unknown", judge_share(None)[0], "unknown")

    print("\nB 「达到要求」的判据")
    t("edit ≥ read（能编辑当然能打开）", ge("edit", "read"), True)
    t("read ≥ read", ge("read", "read"), True)
    t("★ none ≥ read = False（关着就是打不开）", ge("none", "read"), False)
    t("★ unknown ≥ read = False（未测不许自动升级成通过）", ge("unknown", "read"), False)

    print("\nC 结论行自己不许撒谎（喂合成计数）")
    for name, args, want_code, must, must_not in [
        ("全绿", (0, 0), 0, ["✅"], ["未测", "❌"]),
        ("★ 全是未测 → 退 2，不许说通过", (0, 3), 2, ["未测"], ["✅"]),
        ("有红", (1, 0), 1, ["1 项红"], ["✅"]),
        ("★ 又红又未测：红优先，但必须报出未测", (1, 2), 1, ["1 项红", "另有 2 项未测"], ["✅"]),
    ]:
        code, line = verdict(*args)
        n_case += 1
        bad = []
        if code != want_code:
            bad.append("退出码 %d ≠ %d" % (code, want_code))
        for m in must:
            if m not in line:
                bad.append("结论行里没有 %r" % m)
        for m in must_not:
            if m in line:
                bad.append("结论行里不该有 %r" % m)
        if bad:
            print("  ❌ %s\n       %s\n       → %s" % (name, "；".join(bad), line))
        else:
            print("  ✅ %s → 退 %d" % (name, code))
            n_ok += 1

    print("\n反向对照 %d/%d 项过" % (n_ok, n_case))
    return 0 if n_ok == n_case else 1


# ── 主流程 ────────────────────────────────────────────────────────────────
def her_tenant():
    """从入站事件里读「她那条消息」的 tenant_key，并核对全群事件同租户。"""
    if not EVENTS.exists():
        return None, "事件日志不存在：%s" % EVENTS
    keys, her = set(), None
    for ln in EVENTS.read_text(encoding="utf-8", errors="replace").splitlines():
        if not ln.strip():
            continue
        try:
            d = json.loads(ln)
        except Exception:
            continue
        k = (d.get("data") or {}).get("tenant_key")
        if k:
            keys.add(k)
        msg = ((d.get("data") or {}).get("message") or {})
        if her is None and HER_MSG_HINT in (msg.get("content") or ""):
            her = k
    return her, "全日志租户集合=%s" % (sorted(keys),)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--controls", action="store_true", help="离线反向对照，不联网")
    ap.add_argument("--token", default="", help="只读这个 Base（拿来亲眼看它会不会红）")
    a = ap.parse_args()

    print("=" * 74)
    print("飞书表分享口径自证 · 别人（含法务）点得开吗")
    print("=" * 74)

    if a.controls:
        print("\n反向对照（离线，不联网、不落盘）")
        return controls()

    target = a.token or APP_TOKEN
    only_this = bool(a.token)

    tok = token()
    if not tok:
        cannot_test("S0", "取 tenant_access_token 失败 → 本次全部未测")
        code, line = verdict(0, len(untested))
        print("\n" + line)
        return code

    print("\nS 目标表")
    perm, why = read_public(tok, target)
    lvl, desc = judge_share(perm)
    if lvl == "unknown":
        cannot_test("S1", "读不到 %s 的公开设置（%s；%s）→ 未测，"
                          "**不许当成「没开分享」**" % (target, why, desc))
    else:
        check("S1", ge(lvl, "read"),
              "%s → %s（%s）；%s" % (target, lvl, desc, why))
    if perm:
        print("       external_access=%s  invite_external=%s  share_entity=%s"
              % (perm.get("external_access"), perm.get("invite_external"), perm.get("share_entity")))
        print("       ⚠ 这三项只是**读数**：法务若在本租户之外，`tenant_*` 给不到他 —— "
              "加协作者才是一条路（见待收 P-06）")

    if not only_this:
        # S2/S3 只对「我们自己那张表」成立
        lst = call("%s/bitable/v1/apps/%s/tables?page_size=100" % (API, APP_TOKEN), token=tok)
        items = ((lst.get("data") or {}).get("items") or [])
        hit = next((t for t in items if t.get("name") == TABLE_NAME), None)
        if lst.get("code") != 0:
            cannot_test("S2", "列不出 Base 里的表：code=%s → 未测" % lst.get("code"))
        else:
            check("S2", bool(hit), "表「%s」%s在 Base 里（共 %d 张表）"
                  % (TABLE_NAME, "" if hit else "**不**", len(items)))
        if hit:
            tid = hit["table_id"]
            back = call("%s/bitable/v1/apps/%s/tables/%s/records?page_size=100"
                        % (API, APP_TOKEN, tid), token=tok)
            n_back = len(((back.get("data") or {}).get("items") or []))
            # ★ 恒等式：不写死 62，与本地库的条目数比 —— 库长了，这里跟着长
            n_local = len(load_library()[2])
            if back.get("code") != 0:
                cannot_test("S3", "回读记录失败 code=%s → 未测" % back.get("code"))
            else:
                check("S3", n_back == n_local,
                      "回读 %d 条 == 本地库 %d 条（恒等式，不写死数字）" % (n_back, n_local))
            print("       链接：https://momcozy-in.feishu.cn/base/%s?table=%s" % (APP_TOKEN, tid))

    # S4 租户：只证「她在哪个租户发消息」，并**明说**这一步证到哪为止
    her, note = her_tenant()
    if her is None:
        cannot_test("S4", "读不出她那条消息的 tenant_key（%s）→ 未测" % note)
    else:
        check("S4", True, "她那条消息带 tenant_key=%s；%s" % (her, note))
        print("       ⚠ 这只证到「她在这个租户里发消息」。「表也在该租户」是**结构性**推论"
              "（自建应用不能跨租户建 Base），**不是**本脚本读出来的 —— 别读成「接口证明了同租户」")

    # S5 两个真实反向对照：必须一个黄、一个红 —— 否则判据没有被证明会红
    print("\nS5 真实反向对照（同接口、同一次会话，现读）")
    for tag, (t2, name) in (("S5a", CTRL_READABLE), ("S5b", CTRL_CLOSED)):
        p2, why2 = read_public(tok, t2)
        l2, d2 = judge_share(p2)
        if l2 == "unknown":
            cannot_test(tag, "%s（%s）读不到（%s）→ 未测" % (name, t2, why2))
            continue
        want = "read" if tag == "S5a" else "none"
        check(tag, l2 == want,
              "%s → %s（期望 %s；%s）%s" % (name, l2, want, d2,
                                          "" if l2 == want else
                                          "  ← **反向对照样本失效**：换一个真的红样本，这不是目标的错"))

    n_fail = sum(1 for _, ok, _ in results if not ok)
    code, line = verdict(n_fail, len(untested))
    print("\n" + line)
    if n_fail:
        print("   （共 %d 项断言，%d 项红；%d 项未测）" % (len(results), n_fail, len(untested)))
    return code


if __name__ == "__main__":
    raise SystemExit(main())

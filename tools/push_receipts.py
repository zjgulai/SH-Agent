#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""push_receipts.py —— 把「必须送达提交人」的回执推给责任人（D14 · 回答 Q8；D19 补齐责任人）

★ 它治的是台账里的 `D1-O3b 送达`：D10 定了申诉政策（入口 / 责任人 / 2 个工作日
  时限 / 撤销须附理由），政策也确实写进了回执 —— 但**没有任何程序把回执推出去**，
  读不到它的提交人依然无处可去。「写了申诉方式 ≠ 能被申诉」。

★ 三条设计约束，每一条都对应本项目真实踩过的坑：

  1. **未映射即硬失败，绝不静默跳过。**
     静默跳过是这一整轮反复在治的病：一次「什么都没发生」与一次「不必发生」
     长得一模一样。所以只要有一条回执找不到责任人，整个命令非零退出。

  2. **幂等。**
     迁移飞书词表时踩过：`batch_create` 是追加，跑第二次把整张表翻倍，
     而两次的输出全是 ✅。所以本工具把已推送的 `run_id` 记进 `_data/pushed.jsonl`，
     重复运行只报告「已推送，跳过」，不重复发。

  3. **预演是默认，真发要显式 `--apply`。**
     对外发出的消息不可撤回 —— 默认不产生任何外部副作用。

★ 2026-09-16（D19）补的两件事，都是同一个病的新位置：

  · **「责任人已填」不等于「送得到」。** 有名字、没有投递地址（或地址形状不对）
    时，必须和「没人负责」一样硬失败 —— 否则这个缺口只能等飞书 API 报错才现形。
  · **「待送 0」可能是假安静。** D10 之前的旧回执没有 `obligations` 块，
    连「该不该送」都没写，于是它既不在待送里、也不在缺路由里 —— 看起来一切正常。
    现在它被单独计数并打印。

★ 2026-09-23（Q43 = 选项 A）补的**第四道硬门**，与上面三条同一个形状：

  · **「路由得到人」不等于「答得出它是按哪一版规则判的」。** 每条待送回执在送出去之前，
    按 `(engine_version, code_version)` **成对**反查一次历史 manifest，反查不回去就拒发。
    在此之前 `resolve_version()` **全仓零调用点**（于是 `engine_manifest.py --check` 那段
    「重新固化不会让旧回执失效」的提示**没有任何东西在跑它**），而且它只按
    `engine_version` 单键回查、正序取第一条 —— 历史里并存两条同 ev 不同 cv 的记录时
    （本机实测已有两次）会取到**旧的那条**，`code_version` 悄悄是错的。
    现在账本读不出时落**未测**，与「已不在」分开报（`AGENTS.md` §2.4.2 的口径）。

用法：
  python3 tools/push_receipts.py                     # 预演（默认）
  python3 tools/push_receipts.py --status            # 只看账
  python3 tools/push_receipts.py --apply             # 真发
  # 端到端自检：用临时账本 + 临时映射表，生产账本不受影响
  python3 tools/push_receipts.py --receipts /tmp/r.jsonl --owners /tmp/o.csv \
          --pushed /tmp/p.jsonl --redirect-open-id ou_xxx
"""
import argparse
import csv
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SK = ROOT / "research/governance/skeleton"
DEFAULT_RECEIPTS = SK / "_data" / "receipts.jsonl"
DEFAULT_OWNERS = SK / "_data" / "account-owners.csv"
DEFAULT_PUSHED = SK / "_data" / "pushed.jsonl"
CRED = os.path.expanduser("~/.dsh/credentials/shouheng-lark.json")
API = "https://open.feishu.cn/open-apis"

# ★ Q43 = 选项 A 的执行点：`resolve_version()` 必须**真的有人调**。
#   在此之前它全仓零调用点，而 `engine_manifest.py --check` 失败时打印的那段处置说明
#   **已经对使用者承诺过**「重新固化不会让旧回执失效」—— 一句对外说过的话，
#   没有任何东西在跑它（`AGENTS.md` §2.4.2）。下面这一行就是那句话的落点。
sys.path.insert(0, str(SK))
from engine_manifest import resolve_version           # noqa: E402

# 账号字段为空的那批记录按 `route.kind=ad_id` 落到这一行（见 account-owners.csv 的备注）。
# 它是**兜底**：每次用到都会打印并计数，不静默。
FALLBACK_KEY = "（账号名为空）"
OPEN_ID_RE = re.compile(r"^ou_[0-9a-f]{32}$")


def load_jsonl(p: Path) -> list:
    if not p.exists():
        return []
    out = []
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            out.append(json.loads(line))
    return out


def load_owners(p: Path) -> dict:
    """广告账号 → 责任人记录。表不存在就当作**全未映射**，而不是当作没有义务。"""
    if not p.exists():
        return {}
    with p.open(encoding="utf-8-sig", newline="") as f:
        return {r["广告账号"].strip(): r for r in csv.DictReader(f)}


def plan(receipts_path: Path, owners_path: Path, pushed_path: Path) -> dict:
    """★ 分类即账：每一类都要能单独看见。

    旧回执（无 obligations 块）**不是**「待送 0」的一部分 —— 它不可送达，
    而这个事实必须比「无事可做」更响。
    """
    pushed_ids = {r.get("run_id") for r in load_jsonl(pushed_path)}
    owners = load_owners(owners_path)
    out = {"todo": [], "fallback": [], "no_key": [], "unmapped": [],
           "no_address": [], "bad_address": [], "legacy": [], "done": []}
    for rc in load_jsonl(receipts_path):
        ob = rc.get("obligations")
        if ob is None:
            out["legacy"].append(rc)
            continue
        if not ob.get("must_reach"):
            continue
        route = (ob.get("route") or {})
        key = (route.get("key") or "").strip()
        kind = route.get("kind")
        if not key:
            out["no_key"].append(rc)
            continue
        row = owners.get(key)
        via_fallback = False
        if row is None and kind == "ad_id":
            # 只有「没有账号可查」才兜底；**有账号名但表里没有这一行**是缺人，不是兜底。
            row = owners.get(FALLBACK_KEY)
            via_fallback = row is not None
        if row is None or not (row.get("责任人") or "").strip():
            out["unmapped"].append((rc, key, kind))
            continue
        addr = (row.get("飞书open_id") or "").strip()
        if not addr or addr == "（未定）":
            out["no_address"].append((rc, key, row))
            continue
        if not OPEN_ID_RE.match(addr):
            out["bad_address"].append((rc, key, row, addr))
            continue
        if rc.get("run_id") in pushed_ids:
            out["done"].append(rc)
            continue
        (out["fallback"] if via_fallback else out["todo"]).append((rc, key, row))
    return out


def traceability(receipts: list, *, manifest_path=None, history_path=None) -> dict:
    """★ Q43 = 选项 A 的执行点：每条**待送**回执送出去之前，核一次
    「当时那份规则集还查得到吗」。

    在此之前，`engine_manifest.py --check` 失败时那段提示对使用者承诺过
    「重新固化不会让旧回执失效」—— 而那只是一句话：`resolve_version()` 全仓零调用点，
    且它当时只按 `engine_version` 单键回查、正序取第一条命中（于是并存两条同 ev 记录时
    会取到旧的那条，`code_version` 悄悄是错的）。

    四分类，因为它们**必须长得不一样**（`AGENTS.md` §2.4.2 的「未测 ≠ 通过 ≠ 红」）：

      ok          成对命中 ≥1 条 → 当时那份规则集还在（同一对重归档过就会 >1，等价）
      gone        一条都不命中，**且账本读得出** → 真的没了（这是红，必须响）
      untested    一条都不命中，但**账本读不出** → 未测。★ 不许混进 gone，更不许混进 ok
      no_version  回执里压根没有 engine_version/code_version → 无从核（也单独响）

    判据（自证 V53）：喂一条 (ev, cv) 都不存在的回执 → 必须落 gone 并让命令退 2；
    喂一个读不出的账本路径 → 必须落 untested，**不是** gone。
    """
    out = {"ok": [], "gone": [], "untested": [], "no_version": []}
    for rc in receipts:
        ev, cv = rc.get("engine_version"), rc.get("code_version")
        if not ev or not cv:
            out["no_version"].append(rc)
            continue
        r = resolve_version(ev, cv, manifest_path=manifest_path, history_path=history_path)
        if r["n"] >= 1:
            out["ok"].append((rc, r))
        elif r["history_readable"]:
            out["gone"].append((rc, r))
        else:
            out["untested"].append((rc, r))
    return out


def token() -> str:
    c = json.loads(Path(CRED).read_text())
    body = json.dumps({"app_id": c["app_id"], "app_secret": c["app_secret"]}).encode()
    req = urllib.request.Request(f"{API}/auth/v3/tenant_access_token/internal", data=body)
    req.add_header("Content-Type", "application/json; charset=utf-8")
    with urllib.request.urlopen(req, timeout=30) as x:
        r = json.loads(x.read())
    if "tenant_access_token" not in r:
        raise SystemExit(f"❌ 取 token 失败：{json.dumps(r, ensure_ascii=False)[:300]}")
    return r["tenant_access_token"]


def send(tok: str, open_id: str, text: str) -> dict:
    body = json.dumps({"receive_id": open_id, "msg_type": "text",
                       "content": json.dumps({"text": text}, ensure_ascii=False)},
                      ensure_ascii=False).encode()
    req = urllib.request.Request(f"{API}/im/v1/messages?receive_id_type=open_id", data=body)
    req.add_header("Content-Type", "application/json; charset=utf-8")
    req.add_header("Authorization", "Bearer " + tok)
    try:
        with urllib.request.urlopen(req, timeout=30) as x:
            return json.loads(x.read())
    except urllib.error.HTTPError as e:
        return {"_http": e.code, "body": e.read().decode()[:400]}
    except Exception as e:                                   # noqa: BLE001
        return {"_err": f"{type(e).__name__}: {e}"}


def notice_text(rc: dict, header: str = "") -> str:
    ob = rc["obligations"]
    ap = ob.get("appeal") or {}
    lines = [
        header + f"【判定回执 · {rc.get('run_id')}】",
        "",
        ob.get("notice") or "（通知正文缺失）",
        "",
        f"层级：{ob.get('layer_id')} {ob.get('layer_name')}",
        # ★ 这里原本还有一行 `规则：{rc.get('rule_keys')}` —— 而回执里**从来没有**
        #   这个字段（build_receipt 不写它），于是那一行永远印出占位符「（见回执）」，
        #   指向的还是同一张回执。**规则编号本来就在上面的通知正文里**
        #   （notice_template 的 `{rule_keys}` 占位符），所以这一行是纯粹的噪声：
        #   又一处「读一个不存在的字段」。删掉它，而不是给回执补一个字段 ——
        #   与 D17 同一条判据：没有行为需要的声明，删声明。
        "",
        "如不服此结论：",
        f"  入口：{ap.get('entry') or '回复本条消息'}",
        f"  受理人：{ap.get('owner') or '?'}（{ap.get('owner_layer_id') or '?'}）",
        f"  时限：{ap.get('sla_workdays') or '?'} 个工作日",
        f"  撤销须附理由并留痕；涉及规则本身才转 DP4。",
        "",
        f"回执指纹：{rc.get('verdict_digest', '')[:16]}",
        "（本消息不含广告原文，原文核验请用回执指纹。）",
    ]
    return "\n".join(lines)


def main() -> int:
    ap_ = argparse.ArgumentParser()
    ap_.add_argument("--apply", action="store_true", help="真的发送（默认只预演）")
    ap_.add_argument("--status", action="store_true", help="只看账")
    ap_.add_argument("--receipts", default=str(DEFAULT_RECEIPTS), help="回执账本（自检可换成临时账本）")
    ap_.add_argument("--owners", default=str(DEFAULT_OWNERS), help="责任人映射表")
    ap_.add_argument("--pushed", default=str(DEFAULT_PUSHED), help="幂等记录（已推送的 run_id）")
    ap_.add_argument("--redirect-open-id", default=None,
                     help="★ 自检用：把全部消息改发到这一个 open_id（屏幕上会显著标注）")
    a = ap_.parse_args()

    receipts_p, owners_p, pushed_p = Path(a.receipts), Path(a.owners), Path(a.pushed)
    p = plan(receipts_p, owners_p, pushed_p)
    todo_all = p["todo"] + p["fallback"]
    print(f"回执账本：{receipts_p}")
    print(f"  待送 {len(p['todo'])} · 空账号兜底 {len(p['fallback'])} · 已推送 {len(p['done'])}"
          f" · 缺路由键 {len(p['no_key'])} · 责任人未填 {len(p['unmapped'])}"
          f" · 有责任人但无地址 {len(p['no_address'])} · 地址形状不对 {len(p['bad_address'])}")
    if p["legacy"]:
        # ★ 这一行是 D19 加的：旧回执不可送达，而它以前既不进待送也不进缺路由 ——
        #   「待送 0」于是看起来像「一切正常」。
        print(f"  ★ 不可送达的旧回执 {len(p['legacy'])} 条（没有 `obligations` 块："
              f"D10 之前的产物，连「该不该送」都没写）")
        for rc in p["legacy"]:
            print(f"      run_id {rc.get('run_id')} · origin={rc.get('origin')}"
                  f" · issued_at={(rc.get('issued_at') or '')[:19]}")

    # ★ Q43：可追溯性是**读数**，所以每次运行都打出来（不然它没机会被证伪）。
    tr = traceability([rc for rc, *_ in todo_all])
    print(f"  可追溯 {len(tr['ok'])} · 规则集已不在 {len(tr['gone'])}"
          f" · **未测** {len(tr['untested'])} · 无版本号 {len(tr['no_version'])}"
          f"（成对反查 (engine_version, code_version) —— 见 Q43）")

    if a.status:
        for rc, key, kind in p["unmapped"]:
            print(f"    ⚠ 未映射：{kind or '?'} `{key}` <- run_id {rc.get('run_id')}")
        for rc, key, row in p["no_address"]:
            print(f"    ⚠ 有责任人但无地址：{row.get('责任人')}（{key}）"
                  f" <- run_id {rc.get('run_id')}")
        for rc in p["no_key"]:
            print(f"    ⚠ 无路由键：run_id {rc.get('run_id')}（判定时未传 ad_account / ad_id）")
        for rc, r in tr["gone"]:
            print(f"    ⚠ 规则集已不在：run_id {rc.get('run_id')} · "
                  f"ev={rc.get('engine_version')} cv={rc.get('code_version')} —— {r['note']}")
        for rc, r in tr["untested"]:
            print(f"    ⚠ ★ 未测：run_id {rc.get('run_id')} —— {r['note']}")
        return 0

    # ★ 硬门：送不出去必须响。三条各自说清缺的是什么（人 / 地址 / 路由键）。
    if p["no_key"] or p["unmapped"] or p["no_address"] or p["bad_address"]:
        print()
        print("❌ 拒绝发送：存在无法路由的回执 —— 静默跳过会让「送不出去」看起来像「已送达」。")
        for rc, key, kind in p["unmapped"]:
            print(f"   · 责任人未填：{kind or '?'} `{key}`"
                  f"（请填 {owners_p} 的「责任人」列）")
        for rc, key, row in p["no_address"]:
            print(f"   · 有责任人但无投递地址：{row.get('责任人')}（{key}）"
                  f"—— 请填「飞书open_id」列；★ 有名字 ≠ 送得到")
        for rc, key, row, addr in p["bad_address"]:
            print(f"   · 地址形状不对：{row.get('责任人')}（{key}）`{addr[:12]}…`"
                  f"—— 期望 `ou_` + 32 位十六进制")
        for rc in p["no_key"]:
            print(f"   · 无路由键：run_id {rc.get('run_id')} —— "
                  f"调用 judge() 时需传 ad_account=<广告账号>")
        print()
        print("   这不是工具故障，是**如实记账**。")
        return 2

    if not todo_all:
        print("✅ 没有待送达的回执（或全部已推送）")
        return 0

    # ★ 第二道硬门（Q43）：路由通了，但如果**当时那份规则集已经反查不回去**，
    #   这条回执送出去之后，将来没人答得出「它是按哪一版规则判的」——
    #   而 `engine_manifest --check` 那段提示已经承诺过「重新固化不会让旧回执失效」。
    #   ★「未测」与「已不在」在这里**必须分开报**，且都不许静默放行。
    if tr["gone"] or tr["untested"] or tr["no_version"]:
        print()
        print("❌ 拒绝发送：有回执的**规则集反查不回去** —— 送出去也答不出「按哪一版判的」。")
        for rc, r in tr["gone"]:
            print(f"   · 规则集已不在：run_id {rc.get('run_id')} · "
                  f"ev={rc.get('engine_version')} cv={rc.get('code_version')} —— {r['note']}")
        for rc, r in tr["untested"]:
            print(f"   · ★ 未测：run_id {rc.get('run_id')} —— {r['note']}")
            print("     ★「未测」不是「没有」：处置是**去把账本找回来**，不是改这里。")
        for rc in tr["no_version"]:
            print(f"   · 回执里没有 engine_version / code_version：run_id {rc.get('run_id')}")
        print()
        print("   这不是工具故障，是**如实记账**（与上面那道路由门同一条口径："
              "「未测」不许和「通过与红」长得一样）。")
        return 2

    if p["fallback"]:
        print()
        print(f"  ⚠ 其中 {len(p['fallback'])} 条走**空账号兜底**（源记录 `广告账号` 字段为空，"
              f"按 `route.kind=ad_id` 落到 `{FALLBACK_KEY}` 行）：")
        for rc, key, row in p["fallback"]:
            print(f"      run_id {rc.get('run_id')} → {row.get('责任人')}")

    if a.redirect_open_id:
        print()
        print(f"  ★★ 重定向自检模式：全部 {len(todo_all)} 条改发到 "
              f"{a.redirect_open_id}（**不是**责任人的真实地址；生产账本不受影响）")

    if not a.apply:
        print()
        for rc, key, owner in todo_all:
            dest = a.redirect_open_id or owner.get("飞书open_id")
            print(f"[预演] → {owner['责任人']}（{key}）→ {dest}")
            print("        " + notice_text(
                rc, header=("[自检] " if a.redirect_open_id else "")
            ).replace("\n", "\n        ")[:400])
            print()
        print(f"预演完成：{len(todo_all)} 条将发送。加 --apply 真发。")
        return 0

    tok = token()
    ok = 0
    with pushed_p.open("a", encoding="utf-8") as f:
        for rc, key, owner in todo_all:
            dest = a.redirect_open_id or (owner.get("飞书open_id") or "").strip()
            hdr = "[自检 · 非真实送达对象] " if a.redirect_open_id else ""
            r = send(tok, dest, notice_text(rc, header=hdr))
            if r.get("code") == 0:
                ok += 1
                _rec = {"run_id": rc.get("run_id"), "to": owner["责任人"],
                        "at": rc.get("issued_at"), "key": key,
                        "code": r.get("code")}
                if a.redirect_open_id:
                    # ★ 自检实发必须**自己说明它不是真实送达**：这份留痕会被当成
                    #   「有没有真的发过」的证据，混进真实送达里就等于伪造一次送达。
                    _rec.update({"redirected_to": a.redirect_open_id,
                                 "$selftest": True,
                                 "$why": ("端到端自检：验证管道能不能真把消息送到人手上。"
                                          "收件人**不是**责任人本人，因此不计入真实送达。")})
                else:
                    _rec.update({"redirected_to": None})
                f.write(json.dumps(_rec, ensure_ascii=False) + "\n")
                print(f"  ✓ 已送达 {owner['责任人']}（{key}）"
                      + (f" [重定向到 {a.redirect_open_id}]" if a.redirect_open_id else ""))
            else:
                print(f"  ✗ 失败 {owner['责任人']}（{key}）："
                      f"{json.dumps(r, ensure_ascii=False)[:200]}")
    print(f"\n送达 {ok}/{len(todo_all)}。已推送的 run_id 记在 {pushed_p}，重复运行不会重发。")
    return 0 if ok == len(todo_all) else 1


if __name__ == "__main__":
    sys.exit(main())

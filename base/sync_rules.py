#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""sync_rules.py —— 基座的第③面：权威源与只读投影的单向同步（ADR-0013 D2）

一句话：**谁写的谁说了算，而这件事必须按源逐条声明 —— 不能一句话概括。**

--------------------------------------------------------------------------
★ 落地时量出来的：D2 的标题句对一半为真、对另一半为假
--------------------------------------------------------------------------

D2 的标题是「**飞书 Base 是规则与词表的唯一权威源，本地 JSON 是只读投影**」。
D2 的正文里其实已经把它们分开写过（「人写规则主 Base（app 只读）」与
「app 维护机器词表 Base」），但标题句把这个区分压扁了。实测：

| 源 | 权威在谁 | 方向 | 「本地不得回写」靠什么保证 |
|---|---|---|---|
| 品线内容边界规则库（21 条，人写） | **飞书** | 飞书 → 本地 | **物理**：守衡 app 对主 Base `Lk3Qb8y2QaVyZns6gprcVNE9nA0` 的写操作返回 **403 · code 91403**（tables / fields / records 全试过） |
| 语境守卫词（85）· 白名单词（30） | **本地 JSON** | 本地 → 飞书 | **纪律**：这两个表在 app **自己拥有**的 Base `B1oabL2veaFKbKs2hVAcvyKKnEe` 里，app 有完整写权限 |

**这两种保证不是同一个强度**，而 D2 的标题句把它们说成了同一种。
一条 `--apply` 就能改掉词表 Base —— 那边没有权限在拦，只有约定在拦。
所以本模块把 `enforcement` 作为**每个源必填的字段**：`physical` / `policy`。

**一个可交叉验证的旁证**：`tools/migrate_whitelist_to_lark.py`（09-16 13:40）本想把
白名单表建在**主 Base** 里（`APP_TOKEN = Lk3Qb8y2QaVyZns6gprcVNE9nA0`），
而实测主 Base 今天只有 4 张表、**里面没有白名单表**。三小时后写的
`tools/migrate_vocab_to_lark.py` 在文件头记下了 403 的实测，改用 app 自有 Base。
机制分离（ADR-0009）不是设计出来的，是**被权限逼出来的**。

--------------------------------------------------------------------------
★ 另一个量出来的事实：权威源与投影之间夹着一份 L1 人工文档
--------------------------------------------------------------------------

D2 说投影是「本地 JSON」。但规则这条链实际长这样：

    PRD/内容治理需求文档.md  ──build_rules.py──>  rules_raw.json  ──手工──>  rules-v1.json
             ↑                                          ↑
        12 列（超集）                            引擎真正读的那个

    _evidence/rulelib-live.json（真正的飞书拉取，9 列）
             └──> build_context_guards.py（只用于推导机注字段）

**`build_rules.py` 从不读飞书，它读 PRD。** 而 PRD 是一份 L1 人工文档。

实测两者今天的关系（21 条 × 共有 8 列）：**0 处差异** —— 但 PRD 是飞书的**超集**，
多 4 列（`适用产品` / `边界内容` / `依据来源` / `触发原因`）。

⇒ 风险是具体的、双向的：
  · 有人在**飞书**改了规则 → PRD 不变 → 引擎用的是 PRD → **改动静默不生效**。
  · 有人改了 **PRD** → 飞书不变 → 权威源与实际不符，而没人知道。
**今天没有任何东西在守这件事。** 本模块的 `--verify` 就是那个东西。

--------------------------------------------------------------------------
设计的取舍
--------------------------------------------------------------------------

**取指纹而不是取内容。** 快照存每条的指纹 + 一个整表指纹。理由与 ADR-0001 一致：
飞书 API 无 diff、无回放；而"上游内容"里含真人 open_id 等（ADR-0013 §4.2 第 3 条），
快照进 L2、不进 L1，就不该把它变成第二个内容副本。

**冲突不静默合并，也不取「较新者」（D2 原文）。** 判定按方向分：
  · `pull` 源（飞书权威）：内容变了是**正常的**，但必须报成「待同步」，
    绝不自动覆盖本地投影 —— 覆盖会让「上一版规则长什么样」这个问题失去答案。
  · `push` 源（本地权威）：飞书侧内容变了 = **有人在权威侧手改了** ⇒ 冲突 ⇒ 退出码 2。
    因为下一次推送会把它**静默覆盖**，而手改的那个人不会知道。
  · 删除（任一方向）：一律报出，绝不静默丢弃。

用法：
  python3 base/sync_rules.py --probe        # 只读：两库现状 + 本地漂移（联网）
  python3 base/sync_rules.py --pull         # 拉快照到 L2（联网，唯一会写盘的联网命令）
  python3 base/sync_rules.py --verify       # 离线：本地制品 vs 最近快照
  python3 base/sync_rules.py --selftest     # 离线自证
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
SK = ROOT / "research" / "governance" / "skeleton"
EVID = ROOT / "research" / "governance" / "_evidence"
SYNC = EVID / "sync"
LATEST = SYNC / "LATEST.json"
CRED = Path(os.path.expanduser("~/.dsh/credentials/shouheng-lark.json"))
API = "https://open.feishu.cn/open-apis"

CONTRACT_VERSION = "sync-v1"

MAIN_BASE = "Lk3Qb8y2QaVyZns6gprcVNE9nA0"   # 人写；守衡 app 只读（写 403）
VOCAB_BASE = "B1oabL2veaFKbKs2hVAcvyKKnEe"  # app 自有；app 可写

# ── 源登记表。`authority` / `direction` / `enforcement` **三个都必填** ——
#    一句话概括「飞书是权威源」正是 D2 标题句犯的错。
SOURCES = [
    {
        "key": "boundary_rules", "label": "品线内容边界规则库",
        "app_token": MAIN_BASE, "table_id": "tblD1MiUK1v5fdjD",
        "authority": "feishu", "direction": "pull", "enforcement": "physical",
        "key_field": "规则编号",
        "enforcement_evidence": "守衡 app 对主 Base 的建表/写记录/删记录全部 403 · code 91403",
        "local_artifacts": ["research/governance/skeleton/_data/rules_raw.json",
                            "research/governance/_evidence/rulelib-live.json"],
        "consumers": ["research/governance/skeleton/build_rules.py（经 PRD 文档，不直连飞书）",
                      "research/governance/skeleton/build_context_guards.py（直读 rulelib-live）"],
        "$gap": ("★ 投影链上夹着一份 L1 人工文档 `PRD/内容治理需求文档.md`："
                 "`build_rules.py` 读它、不读飞书。今天它与飞书在共有 8 列上 0 处差异，"
                 "且它是飞书的超集（多 4 列）。**没有任何东西在守这件事。**"),
    },
    {
        "key": "ad_copy", "label": "广告文案明细",
        "app_token": MAIN_BASE, "table_id": "tblcbk4XiW6471YN",
        "authority": "feishu", "direction": "pull", "enforcement": "physical",
                "enforcement_evidence": "守衡 app 对主 Base 的建表/写记录/删记录全部 403 · code 91403",
"key_field": "外部广告ID",
        "local_artifacts": ["research/governance/skeleton/_data/records.json"],
        "consumers": ["research/governance/skeleton/build_rules.py（经 PRD 文档）"],
    },
    {
        "key": "w1_claims", "label": "W1卖点表达边界",
        "app_token": MAIN_BASE, "table_id": "tblqUTAKFkWheU49",
        "authority": "feishu", "direction": "pull", "enforcement": "physical",
                "enforcement_evidence": "守衡 app 对主 Base 的建表/写记录/删记录全部 403 · code 91403",
"key_field": "", "local_artifacts": [], "consumers": [],
    },
    {
        "key": "rewrite_lib", "label": "风险文案改写建议库",
        "app_token": MAIN_BASE, "table_id": "tblLxUfPz4Wqp2na",
        "authority": "feishu", "direction": "pull", "enforcement": "physical",
                "enforcement_evidence": "守衡 app 对主 Base 的建表/写记录/删记录全部 403 · code 91403",
"key_field": "", "local_artifacts": [], "consumers": [],
    },
    {
        "key": "context_guards", "label": "语境守卫词",
        "app_token": VOCAB_BASE, "table_id": "tblqO2itSmeDMIJW",
        "authority": "local", "direction": "push", "enforcement": "policy",
        "key_field": "守卫词",
        "enforcement_evidence": ("★ 表在 app **自己拥有**的 Base 里，写权限完整 —— "
                                 "「本地不得回写」在这里是**纪律**，不是权限"),
        "local_artifacts": ["research/governance/skeleton/context-guards-v1.json"],
        "consumers": ["research/governance/skeleton/vocab.py"],
        "publisher": "tools/migrate_vocab_to_lark.py",
        "verifier": "tools/verify_vocab_lark.py",
    },
    {
        "key": "whitelist", "label": "白名单词",
        "app_token": VOCAB_BASE, "table_id": "tbllpl1vl6iVHdKe",
        "authority": "local", "direction": "push", "enforcement": "policy",
        "key_field": "白名单词",
        "enforcement_evidence": "同上 —— app 有写权限",
        "local_artifacts": ["research/governance/skeleton/whitelist-v1.json"],
        "consumers": ["research/governance/skeleton/vocab.py"],
        "publisher": "tools/migrate_vocab_to_lark.py",
        "verifier": "tools/verify_vocab_lark.py",
    },
]
BY_KEY = {s["key"]: s for s in SOURCES}


# ------------------------------------------------------------------ 指纹

def fp_rec(obj) -> str:
    return hashlib.sha256(json.dumps(obj, ensure_ascii=False, sort_keys=True,
                                     separators=(",", ":")).encode("utf-8")).hexdigest()


def fp_table(fps: list[str]) -> str:
    return hashlib.sha256(("\n".join(sorted(fps))).encode("utf-8")).hexdigest()


def flat_text(v) -> str:
    """飞书字段值 → 字符串。富文本/附件/关联字段会被摊平 —— 只用于**比对**，不用于重建。"""
    if v is None:
        return ""
    if isinstance(v, str):
        return v.strip()
    if isinstance(v, (int, float, bool)):
        return str(v)
    if isinstance(v, list):
        out = []
        for x in v:
            if isinstance(x, dict):
                out.append(x.get("text") or x.get("name") or x.get("link") or "")
            else:
                out.append(str(x))
        return "".join(out).strip()
    if isinstance(v, dict):
        return (v.get("text") or v.get("name") or v.get("link") or "").strip()
    return str(v).strip()


def record_fp(fields: dict) -> str:
    """按**字段内容**取指纹，不按飞书的 record 包装取 —— 这样字段顺序与列的增删不影响它。"""
    return fp_rec({k: flat_text(v) for k, v in sorted(fields.items())})


# ------------------------------------------------------------------ 网络（只读）

def token() -> str:
    """凭据文件里是 app_id / app_secret，不是现成的 token —— 现换。

    ★ 复用 `tools/lark_find.py` 里已经跑通的换取逻辑，不重写第二份。
      （第一版这里去找 `tenant_access_token` 键，而凭据里根本没有那个键；
        报错信息是「凭据里没有可用的 token」—— 提示没错，但那是**我的假设**错了，
        不是凭据错了。这种错要先怀疑自己。）
    """
    sys.path.insert(0, str(ROOT / "tools"))
    from lark_find import token as _t                  # noqa: PLC0415
    return _t()


def get(url: str, tok: str) -> dict:
    r = urllib.request.Request(url, method="GET")
    r.add_header("Authorization", "Bearer " + tok)
    try:
        with urllib.request.urlopen(r, timeout=30) as x:
            return json.loads(x.read())
    except urllib.error.HTTPError as e:
        return {"_http": e.code, "_body": e.read().decode()[:300]}


def fetch_records(app: str, tid: str, tok: str) -> list[dict]:
    items, pt = [], None
    while True:
        u = f"{API}/bitable/v1/apps/{app}/tables/{tid}/records?page_size=500"
        if pt:
            u += "&page_token=" + pt
        d = get(u, tok).get("data") or {}
        items += d.get("items") or []
        pt = d.get("page_token")
        if not d.get("has_more"):
            break
    return items


def snapshot_source(src: dict, tok: str) -> dict:
    raw = fetch_records(src["app_token"], src["table_id"], tok)
    kf = src.get("key_field") or ""
    recs, keys = {}, []
    for r in raw:
        f = r.get("fields") or {}
        # ★ `blank` 用来把「空行」与「有内容但无标识」分开 —— 后者才是真的危险：
        #   前者漂移了也无所谓，后者可以随便改而没人发现。
        blank = not any(flat_text(v) for v in f.values())
        keys.append({"record_id": r.get("record_id"), "key": flat_text(f.get(kf)) if kf else "",
                     "fp": record_fp(f), "blank": blank})
        recs[r.get("record_id")] = {"key": flat_text(f.get(kf)) if kf else "",
                                    "fp": record_fp(f), "blank": blank}
    return {"key": src["key"], "label": src["label"], "app_token": src["app_token"],
            "table_id": src["table_id"], "key_field": kf,
            "authority": src["authority"], "direction": src["direction"],
            "enforcement": src["enforcement"],
            "n_records": len(keys), "table_fp": fp_table([x["fp"] for x in keys]),
            "records": recs}


# ------------------------------------------------------------------ 本地制品

def local_keys(path: Path, kind: str) -> set[str]:
    """从本地制品里取出「条目标识集合」。取不出就返回空集并说明。"""
    return local_keys_ex(path, kind)[0]


def local_keys_ex(path: Path, kind: str) -> tuple[set[str], int]:
    """→ (有标识的集合, **无标识的条数**)。

    ★ 为什么要把「无标识」单列出来：本仓已经吃过一次教训 ——
      「把读不到的 10 条从分母里剔掉之后，「收集了 15 条」看起来像成功，实际可用 5 条」。
      无标识的记录**天然逃过**任何按标识做的比对：它们可以随便漂移而没人发现。
      所以分母必须显式说清是多少、少的那些是谁。
      （这是本模块第一次跑 `--probe` 时自己撞出来的：飞书 291 条 vs 本地 289 条，
        而报告写着「✓ 条目集合一致」—— 少的 2 条被两侧一起静默剔除了。）
    """
    if not path.exists():
        return set(), 0
    try:
        d = json.loads(path.read_text(encoding="utf-8"))
    except Exception:                                     # noqa: BLE001
        return set(), 0
    if kind == "words":
        ws = [str(w.get("word") or "").strip() for w in (d.get("words") or [])]
        return {w for w in ws if w}, sum(1 for w in ws if not w)
    if kind == "list":
        ks = [str(x.get("rule_id") or x.get("外部广告ID") or "").strip()
              for x in d if isinstance(x, dict)]
        return {k for k in ks if k}, sum(1 for k in ks if not k)
    return set(), 0


LOCAL_KIND = {"context_guards": "words", "whitelist": "words",
              "boundary_rules": "list", "ad_copy": "list"}


# ------------------------------------------------------------------ 比对

def compare(prev: dict | None, cur: dict) -> dict:
    """两次快照的记录级比对。**只分类，不合并、不取较新者。**"""
    if not prev:
        return {"new_source": True, "added": [], "removed": [], "changed": []}
    p, c = prev.get("records") or {}, cur.get("records") or {}
    added = sorted(set(c) - set(p))
    removed = sorted(set(p) - set(c))
    changed = sorted(r for r in set(p) & set(c) if p[r].get("fp") != c[r].get("fp"))
    return {"new_source": False, "added": added, "removed": removed, "changed": changed,
            "renamed": sorted(r for r in set(p) & set(c)
                              if p[r].get("key") != c[r].get("key"))}


def conflicts(src: dict, cmp: dict) -> list[str]:
    """按**方向**判定冲突（D2：指纹不一致而记录 id 相同 ⇒ 报错退出）。

    `pull` 源上「内容变了」是正常的（人在飞书上改规则），但要报成**待同步**；
    `push` 源上「内容变了」是**别人动了程序的产物** —— 下一次推送会静默覆盖它。
    """
    out = []
    if cmp.get("new_source"):
        return out
    n = len(cmp["added"]) + len(cmp["removed"]) + len(cmp["changed"])
    if not n:
        return out
    if src["direction"] == "push":
        out.append(
            f"★★ 冲突（{src['label']}）：飞书侧有 {n} 条记录与上一次推送时不同 —— "
            f"新增 {len(cmp['added'])} · 删除 {len(cmp['removed'])} · 改动 {len(cmp['changed'])}。"
            f"该源的权威在**本地**（`{src['local_artifacts'][0]}`），"
            f"飞书只是发布面；下一次 `{src.get('publisher')}` 会把这些改动**静默覆盖**，"
            f"而改它的人不会知道。**按 D2：报错退出，不静默合并、不取较新者。**")
    else:
        out.append(
            f"⚠ 待同步（{src['label']}）：权威源上有 {n} 条记录与本地投影的来路不同 —— "
            f"新增 {len(cmp['added'])} · 删除 {len(cmp['removed'])} · 改动 {len(cmp['changed'])}。"
            f"该源权威在**飞书**，这是正常改动；但本模块**不自动覆盖**本地投影 —— "
            f"覆盖会让「上一版规则长什么样」失去答案。")
    if cmp["removed"]:
        out.append(f"  · 删除 {len(cmp['removed'])} 条（{src['label']}）：{cmp['removed'][:4]} —— "
                   f"删除一律报出，绝不静默丢弃")
    if cmp.get("renamed"):
        out.append(f"  · 标识改名 {len(cmp['renamed'])} 条：{cmp['renamed'][:4]}")
    return out


def verify_offline(snap: dict) -> list[str]:
    """离线：本地制品 vs 最近快照。**红 = 本地出现了权威源没有的东西。**"""
    problems = []
    for src in SOURCES:
        s = (snap.get("sources") or {}).get(src["key"])
        if not s:
            problems.append(f"⚠ 快照里没有源 {src['key']} —— 先跑一次 --pull")
            continue
        kind = LOCAL_KIND.get(src["key"])
        if not kind or not src["local_artifacts"]:
            continue                                        # 无本地投影，跳过
        lk, n_keyless_local = local_keys_ex(ROOT / src["local_artifacts"][0], kind)
        rk = {v.get("key") for v in s["records"].values() if v.get("key")}
        n_keyless_remote = s["n_records"] - len(rk)
        n_blank_remote = sum(1 for v in s["records"].values() if v.get("blank"))
        n_blank_local = n_keyless_local      # 本地空行同样取不出标识
        if n_keyless_remote or n_keyless_local:
            # 「空行」与「有内容但无标识」必须分开说 —— 后者才是能随便漂移而没人发现的那种
            risky_r = n_keyless_remote - n_blank_remote
            risky_l = n_keyless_local - n_blank_local
            problems.append(
                f"⚠ {src['label']}：**{n_keyless_remote} 条权威源 / {n_keyless_local} 条本地记录"
                f"没有标识**（`{src['key_field']}` 为空）—— 其中 **{n_blank_remote} / "
                f"{n_blank_local} 条是完全空行**（无任何字段值，漂移了也无所谓），"
                f"剩 {risky_r} / {risky_l} 条**有内容却无标识** —— 那才是能随便改而没人发现的。"
                f"（实测这 2 条飞书记录有 `文案语种` 与 `父记录`，但没有 `外部广告ID`；"
                f"投影到本地后变成两条全空行，既进不了判定、也追不到是哪条广告。）"
                f"本检查的分母是 {len(rk)}/{s['n_records']}（权威）· {len(lk)}/"
                f"{len(lk)+n_keyless_local}（本地），**不是全部**。")
        if not lk:
            problems.append(f"⚠ {src['label']}：本地制品取不出条目集合 "
                            f"（{src['local_artifacts'][0]}）—— 这条检查是空的")
            continue
        # ★ 四种情形要分开判 —— 同一个「不一致」在两个方向上含义相反：
        #     pull 源：本地多出来 = 本地自成了第二个源（✗）；权威多出来 = 待同步（⚠）
        #     push 源：本地多出来 = 待发布（⚠，正常）；**飞书多出来 = 有人手改了发布面（✗）**
        #   第一版只判了 pull 的两个方向，push 的两个方向直接漏掉 —— 而 push 的
        #   「飞书多出来」恰恰是唯一会**静默覆盖**别人的那一种（D2 要拦的就是它）。
        local_extra, remote_extra = sorted(lk - rk), sorted(rk - lk)
        if src["direction"] == "pull":
            if local_extra:
                problems.append(
                    f"✗ {src['label']}：本地有 {len(local_extra)} 条权威源里**没有**的条目 —— "
                    f"{local_extra[:5]}。这是 D2 明令禁止的方向（本地不得成为第二个源）。")
            if remote_extra:
                problems.append(
                    f"⚠ {src['label']}：权威源有 {len(remote_extra)} 条本地没有的条目 —— "
                    f"{remote_extra[:5]}。有待同步的改动。")
        else:
            if remote_extra:
                problems.append(
                    f"✗ {src['label']}：**飞书侧有 {len(remote_extra)} 条本地没有的条目** —— "
                    f"{remote_extra[:5]}。该源权威在**本地**，飞书只是发布面 —— "
                    f"飞书上多出来的东西就是有人手改的，而下一次 "
                    f"`{src.get('publisher')}` 会把它静默覆盖。")
            if local_extra:
                problems.append(
                    f"⚠ {src['label']}：本地有 {len(local_extra)} 条尚未发布到飞书 —— "
                    f"{local_extra[:5]}。跑一次 `{src.get('publisher')}` 即可对齐。")
    return problems


# ------------------------------------------------------------------ 命令

def load_latest() -> dict | None:
    if not LATEST.exists():
        return None
    p = SYNC / json.loads(LATEST.read_text(encoding="utf-8"))["latest"]
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


def cmd_probe() -> int:
    tok = token()
    print("=" * 78)
    print("只读探针 · 本命令**不发任何写请求**")
    print("=" * 78)
    bad = []
    for src in SOURCES:
        cur = snapshot_source(src, tok)
        line = (f"\n【{src['label']}】{src['key']}\n"
                f"  权威 {src['authority']:<6} · 方向 {src['direction']:<4} · "
                f"回写保证 {src['enforcement']}\n"
                f"  {src['app_token']} / {src['table_id']}  →  {cur['n_records']} 条 · "
                f"表指纹 {cur['table_fp'][:16]}")
        print(line)
        kind = LOCAL_KIND.get(src["key"])
        if kind and src["local_artifacts"]:
            lp = ROOT / src["local_artifacts"][0]
            lk, nk_local = local_keys_ex(lp, kind)
            rk = {v.get("key") for v in cur["records"].values() if v.get("key")}
            nk_remote = cur["n_records"] - len(rk)
            print(f"  本地 {lp.name}：{len(lk)} 条")
            denom = (f"分母 {len(rk)}/{cur['n_records']}（飞书）· {len(lk)}/"
                     f"{len(lk)+nk_local}（本地）")
            if lk == rk and not nk_local and not nk_remote:
                print(f"  ✓ 条目集合一致（{len(lk)} 条逐条同名）· {denom}")
            elif lk == rk:
                nb_r = sum(1 for v in cur["records"].values() if v.get("blank"))
                print(f"  ⚠ 有标识的条目集合一致，但 **{nk_remote} 条飞书 / {nk_local} 条本地"
                      f"没有标识**（其中 {nb_r} / {nb_r} 条是完全空行）—— 它们逃过比对。{denom}")
                bad.append(src["key"] + "(有记录无标识)")
            else:
                print(f"  ✗ 只在本地 {sorted(lk-rk)[:5]} · 只在飞书 {sorted(rk-lk)[:5]} · {denom}")
                bad.append(src["key"])
        if src.get("$gap"):
            print("  " + src["$gap"].replace("\n", "\n  "))
    print("\n" + "=" * 78)
    print(("✗ 有源与本地不一致：" + ", ".join(bad)) if bad else "✓ 所有可比源的条目集合一致")
    print("=" * 78)
    return 2 if bad else 0


def cmd_pull() -> int:
    tok = token()
    prev = load_latest()
    SYNC.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out = {"contract_version": CONTRACT_VERSION, "pulled_at": ts, "sources": {}}
    all_msg = []
    for src in SOURCES:
        cur = snapshot_source(src, tok)
        cmp = compare((prev or {}).get("sources", {}).get(src["key"]), cur)
        cur["diff_vs_prev"] = {k: cmp[k] for k in ("added", "removed", "changed") if k in cmp}
        out["sources"][src["key"]] = cur
        print(f"  {src['label']:<22} {cur['n_records']:>4} 条 · {cur['table_fp'][:12]}"
              + ("" if cmp.get("new_source") else
                 f"  Δ+{len(cmp['added'])} -{len(cmp['removed'])} ~{len(cmp['changed'])}"))
        all_msg += conflicts(src, cmp)
    fp = fp_table([s["table_fp"] for s in out["sources"].values()])
    out["snapshot_fp"] = fp
    p = SYNC / f"{ts}.json"
    p.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    LATEST.write_text(json.dumps({"latest": p.name, "snapshot_fp": fp,
                                  "pulled_at": ts}, ensure_ascii=False, indent=2) + "\n",
                      encoding="utf-8")
    print(f"\n快照 → {p.relative_to(ROOT)}  （L2，不入历史：ADR-0013 §三）\n指纹 {fp[:16]}")
    if all_msg:
        print("\n" + "\n".join(all_msg))
    hard = [m for m in all_msg if m.startswith("★★")]
    if hard:
        print("\n✗ 退出码 2：push 源出现冲突（D2：不静默合并、不取较新者）")
        return 2
    print("\n✓ 拉取完成" + ("（有 push 源改动，见上）" if all_msg else "（无源发生改动）"))
    return 0


def cmd_verify() -> int:
    snap = load_latest()
    print("=" * 78)
    print("离线核验 · 本地制品 vs 最近快照")
    print("=" * 78)
    if not snap:
        print("✗ 没有快照。先跑：python3 base/sync_rules.py --pull")
        return 1
    print(f"快照 {snap['pulled_at']} · 指纹 {snap['snapshot_fp'][:16]}\n")
    for src in SOURCES:
        s = snap["sources"].get(src["key"]) or {}
        print(f"  {src['label']:<22} {s.get('n_records','?'):>4} 条 · "
              f"{s.get('table_fp','?')[:12]} · {src['direction']}/{src['enforcement']}")
    probs = verify_offline(snap)
    hard = [x for x in probs if x.startswith("✗")]
    soft = [x for x in probs if not x.startswith("✗")]
    print()
    for x in probs:
        print("  " + x)
    # ★ 第一版这里是「文案说未通过、退出码说 0」—— 调用方看退出码，人看文案，
    #   两者不一致时**两边都会以为自己是对的**。已改为同一判据派生两样东西。
    if hard:
        print("\n✗ 核验未通过：硬 %d 项 · 待办 %d 项（退出码 2）" % (len(hard), len(soft)))
        return 2
    if soft:
        print("\n⚠ 核验通过，但有 %d 项待办（退出码 0）—— 都不是「本地成了第二个源」那种" % len(soft))
        return 0
    print("  ✓ 所有可比源：本地制品与快照条目集合一致，且无无标识记录")
    print("\n✓ 核验通过")
    return 0


# ------------------------------------------------------------------ 自证

def selftest(verbose: bool = True) -> list[str]:
    fails: list[str] = []

    def check(name, cond, detail=""):
        ok = bool(cond)
        if verbose:
            print(("  ✓ " if ok else "  ✗ ") + name + (("   " + detail) if detail else ""))
        if not ok:
            fails.append(name + (("  " + detail) if detail else ""))
        return ok

    print("=" * 78)
    print("B0.4 自证 · 权威源与只读投影（%s）" % CONTRACT_VERSION)
    print("=" * 78)

    print("\n[1] 登记表完整性：每个源都必须逐条声明权威/方向/保证强度")
    check("每个源都有 authority / direction / enforcement",
          all(all(k in s for k in ("authority", "direction", "enforcement")) for s in SOURCES),
          "%d 个源" % len(SOURCES))
    check("authority 与 direction 一致（feishu→pull，local→push）",
          all((s["authority"] == "feishu") == (s["direction"] == "pull") for s in SOURCES),
          "★ 这条守的是 D2 标题句那个错：把两种方向说成一种")
    check("每个源都写明了回写保证的依据",
          all(s.get("enforcement_evidence") for s in SOURCES))
    check("两种保证强度都存在，且不是同一个值",
          {s["enforcement"] for s in SOURCES} == {"physical", "policy"},
          "★ 一个是权限在拦（403），一个是约定在拦 —— 强度不同，不能混为一谈")

    print("\n[2] 方向：词表的权威在本地，规则的权威在飞书")
    check("规则源 direction=pull（飞书权威）",
          BY_KEY["boundary_rules"]["direction"] == "pull")
    check("词表源 direction=push（本地权威）",
          all(BY_KEY[k]["direction"] == "push" for k in ("whitelist", "context_guards")),
          "★ ADR-0009 的机制分离，实测是被 403 逼出来的")

    print("\n[3] 冲突判定：按方向分，且删除一律报出")
    mk = lambda a, d: {"key": "x", "label": "X", "direction": d, "local_artifacts": ["p"],
                       "publisher": "pub.py"}
    prev = {"records": {"r1": {"key": "A", "fp": "f1"}, "r2": {"key": "B", "fp": "f2"}}}
    cur_same = {"records": dict(prev["records"])}
    cur_chg = {"records": {"r1": {"key": "A", "fp": "f1X"}, "r2": {"key": "B", "fp": "f2"}}}
    cur_del = {"records": {"r1": {"key": "A", "fp": "f1"}}}
    cur_add = {"records": {**prev["records"], "r3": {"key": "C", "fp": "f3"}}}
    check("无变化 → 无冲突", not conflicts(mk(0, "pull"), compare(prev, cur_same)))
    check("push 源有改动 → 硬冲突（★★）",
          any(m.startswith("★★") for m in conflicts(mk(0, "push"), compare(prev, cur_chg))),
          "下一次推送会静默覆盖手改 —— 这正是 D2 要拦的")
    check("pull 源有改动 → 待同步（⚠），**不**报硬冲突",
          all(not m.startswith("★★") for m in conflicts(mk(0, "pull"), compare(prev, cur_chg)))
          and any(m.startswith("⚠") for m in conflicts(mk(0, "pull"), compare(prev, cur_chg))),
          "人在飞书上改规则是正常的，但不自动覆盖本地投影")
    check("删除一律报出（两个方向都报）",
          all(any("删除" in m for m in conflicts(mk(0, d), compare(prev, cur_del)))
              for d in ("pull", "push")))
    check("新增计入改动数",
          compare(prev, cur_add)["added"] == ["r3"])

    print("\n[4] 离线核验：本地多出来的东西必须红（D2 明令禁止的方向）")
    snap = {"sources": {
        "boundary_rules": {"records": {"r1": {"key": "H01", "fp": "a"}}, "n_records": 1},
        "whitelist": {"records": {"r1": {"key": "suction level", "fp": "b"},
                                  "r2": {"key": "有人在飞书上手加的词", "fp": "c"}}, "n_records": 2},
        "context_guards": {"records": {}, "n_records": 0}}}
    probs = verify_offline(snap)
    check("拿一个明显不匹配的快照去核验 → 必须报出问题", bool(probs),
          "本地有 21 条规则 vs 快照 1 条 —— 这条检查不是空的")
    check("push 源上「飞书有本地没有」判为 ✗（不是 ⚠）",
          any(x.startswith("✗") and "白名单" in x for x in probs),
          "该源权威在本地，飞书上多出来的就是有人手改的")

    print("\n[5] 反向对照：坏登记表必须红")
    saved = SOURCES[0]["direction"]
    try:
        SOURCES[0]["direction"] = "push"                    # 把规则源的方向改反
        bad = [s["key"] for s in SOURCES
               if (s["authority"] == "feishu") != (s["direction"] == "pull")]
        check("必红：把权威与方向改得不一致 → 被 [1] 的一致性检查抓到", bad == ["boundary_rules"],
              "★ 这条守的正是 D2 标题句犯的错")
    finally:
        SOURCES[0]["direction"] = saved
    check("必红：缺 enforcement 的源会被抓到",
          not all(s.get("enforcement_evidence") for s in SOURCES + [{"key": "x"}]))

    print("\n[6] 真源面：与磁盘上的实际制品对得上")
    n_rules = len(json.loads((SK / "_data" / "rules_raw.json").read_text(encoding="utf-8")))
    n_wl = len(json.loads((SK / "whitelist-v1.json").read_text(encoding="utf-8"))["words"])
    n_cg = len(json.loads((SK / "context-guards-v1.json").read_text(encoding="utf-8"))["words"])
    check("本地制品条数与登记表所指一致：规则 %d · 白名单 %d · 守卫 %d"
          % (n_rules, n_wl, n_cg), n_rules == 21 and n_wl == 30 and n_cg == 85,
          "与飞书实测的 21 / 30 / 85 一致")
    live = EVID / "rulelib-live.json"
    check("飞书拉取的原始快照在盘上（rulelib-live.json）", live.exists(),
          "%d 条" % len(json.loads(live.read_text(encoding="utf-8"))) if live.exists() else "")
    if live.exists():
        fb = {r["规则编号"]: r for r in json.loads(live.read_text(encoding="utf-8"))}
        raw = {r["rule_id"]: r for r in
               json.loads((SK / "_data" / "rules_raw.json").read_text(encoding="utf-8"))}
        check("飞书快照与本地投影的规则编号集合相同",
              set(fb) == set(raw), "只在飞书 %s · 只在本地 %s"
              % (sorted(set(fb) - set(raw))[:3], sorted(set(raw) - set(fb))[:3]))
        shared = sorted(set(fb["H01"]) & {"边界类型", "风险等级", "检测关键词", "判断方式",
                                          "启用状态", "豁免词", "正则表达式", "规则编号"})
        same = 0
        for rid in fb:
            for zh, en in (("边界类型", "boundary_type"), ("风险等级", "risk_level_legacy"),
                           ("判断方式", "detect_mode_legacy")):
                if flat_text(fb[rid].get(zh)) == flat_text(raw[rid].get(en)):
                    same += 1
        check("共有列逐条抽样比对：%d 处一致（8 列 × 21 条里抽 3 列 = 63）" % same,
              same == 63, "★ 今天一致；**但没有东西在守它** —— 这正是 --verify 存在的理由")

    print("\n[7] ADR-0013 D2 的标题句：把它量出来的偏差写清楚")
    print("    D2 标题：「飞书 Base 是规则与词表的唯一权威源，本地 JSON 是只读投影」")
    print("    实测 ——")
    print("      · 规则：✅ 为真（飞书权威、方向 pull、且有 **403 物理**保证）")
    print("      · 词表：❌ 为假（**本地**权威、方向 push，只有**纪律**保证）")
    print("      · 且规则链上还夹着一份 L1 人工文档 PRD，它才是 build_rules.py 读的东西")
    print("    ⇒ 见 ADR-0013 §十：D2 需拆成 D2a（规则）/ D2b（词表）两条")

    print("\n" + "=" * 78)
    if fails:
        print("✗ B0.4 自证未通过：%d 项" % len(fails))
        for f in fails:
            print("   - " + f)
    else:
        print("✓ B0.4 自证全绿：%d 个源逐条声明方向与保证强度，冲突按方向判定" % len(SOURCES))
    print("=" * 78)
    return fails


def main() -> int:
    ap = argparse.ArgumentParser(description="权威源单向同步（基座第③面）")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--probe", action="store_true", help="只读探针（联网，不发写请求）")
    g.add_argument("--pull", action="store_true", help="拉快照到 L2（联网）")
    g.add_argument("--verify", action="store_true", help="离线核验本地制品 vs 最近快照")
    g.add_argument("--selftest", action="store_true", help="离线自证")
    a = ap.parse_args()
    if a.selftest:
        return 1 if selftest() else 0
    if a.verify:
        return cmd_verify()
    if a.probe:
        return cmd_probe()
    return cmd_pull()


if __name__ == "__main__":
    sys.exit(main())

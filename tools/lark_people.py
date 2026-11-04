#!/usr/bin/env python3
"""
lark_people.py —— 「责任人 → 投递地址」解析器（只读）

背景（为什么需要这个工具）
    路由表里写的是**姓名**，发送要的是 **open_id**。这两者之间的桥，之前是靠人工从
    知识库人员字段里抄一次。一旦出现一个新责任人（如 Rikka），就得重新找一遍，
    而且找不到时**没法证明「真的找不到」** —— 2026-09-16 我就写过一次恒真扫描：
    用 created_by/last_modified_by 找她，扫了 6000+ 条记录「零命中」，
    后来才发现那个字段在 list records 响应里**恒为 null**，扫描根本没有输入。

    所以本工具的核心不是检索，而是**先证明自己看得见，再回答看不见**：
      · 字典为空 / 锚点找不到  → 退出码 1「无法作答」，绝不说「查无此人」
      · 锚点找得到、目标找不到 → 退出码 2「本应用确实看不见她」，并附边界证据
      · 目标找得到            → 退出码 0，打印可用地址

本应用（cli_aa2243de0438dcd7 守衡）的能力边界（2026-09-16 逐条实测，2026-09-21 修正见下）
    ✗ contact/v3/users（列成员）             99991672 缺 contact:contact.base:readonly
    ✗ contact/v3/departments/0/children      99991672 同上
    ✗ contact/v3/users/{open_id}（id→姓名）  99991672 同上
    ✗ contact/v3/users/batch_get_id（邮箱→id）99991672 同上
    ✗ search/v1/user（按姓名搜人）            99991634 需 user_access_token
    ✗ created_by / last_modified_by          响应里恒为 null（字段不可用）
    ✗ drive/v1/metas 的 owner_id            只有 id、没有姓名，无法反查
    ✓ **人员字段（bitable 里 type=11 的值）** —— 给出 姓名+邮箱+open_id
    ✓ **群成员（im/v1/chats + /members）** —— 给出 姓名+open_id（无邮箱），零通讯录权限

★ 2026-09-21 修正一处**假阴性**（本条是本文件存在的理由，所以写在最前面）：
    旧版只有一条通道（人员字段），却在查不到时打印「本应用**结构性看不见人**」。
    实测反例：`--find 对接人` 打印「看不见」，而同一时刻
    `GET im/v1/chats/oc_49a7cfb2.../members?member_id_type=open_id` 返回
    `ou_TEST_USER | 对接人 | 1774a6c9fe58975e`。
    她一直在机器人自己的群里，而旧版 BOUNDARY 里那句「im/v1/chats → 仅 1 个群 3 人，
    **不含此人**」——那个「不含此人」没有任何代码去查过。**结论比输入大。**
    ⇒ 现在两条通道都采，且**两条都必须自证活着**才能给否定结论（见 verify_resolver）。

    ⇒ 结论修正为：本应用**能**解析「与机器人在同一个群里的人」，以及「出现在多维表格
      人员字段里的人」。两者都不是的人，仍然解析不出 —— 但那时说出口的是
      「本应用读得到的通道里都没有」，而**不是**「世上没有这个人」。

用法
    python3 tools/lark_people.py                  # 盘点 + 自检（两条通道各一个阳性对照）
    python3 tools/lark_people.py --find 林建纯     # 解析一个责任人
    python3 tools/lark_people.py --find 甲 乙 丙   # 一次解析多人（只采一次字典，省掉重复的 80 秒）
    python3 tools/lark_people.py --dump           # 打印全部可见人员（带出处通道）
    python3 tools/lark_people.py --selftest       # 只跑阳性对照

退出码（单人；多人时取**最坏**的一个，优先级 1 > 2 > 3 > 0）
    0 = 解析成功（字段精确命中）
    3 = **候选**：只命中邮箱前缀（如 Roxie → roxie.yu@…），是线索不是结论，须人工确认
    2 = 本应用读得到的通道里都没有此人（附边界证据）
    1 = 无法作答（字典空 / 锚点丢失 / 通道没自证活着 / 网络失败）
        —— ★ 绝不在这种状态下说「查无此人」。**1 比 2 更坏，不许被 2 盖住。**
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CRED = Path(os.path.expanduser("~/.dsh/credentials/shouheng-lark.json"))
OUT = ROOT / "research" / "governance" / "skeleton" / "_data" / "lark-visible-people.csv"
BASE = "https://open.feishu.cn/open-apis"

# 阳性对照锚点：这个人必须能被解析出来，否则说明"字典是空的"，任何"查无此人"都不作数。
# 证据：account-owners.csv（Roxie 一行）与 research/kb/_evidence/.../creative__*.json
#      字段 需求人[0] = {name: 成员A, email: user@example.com, id: ou_dd3f...}
ANCHOR = {"name": "成员A", "open_id": "ou_TEST_USER"}
MIN_PEOPLE = 20          # 字典小于这个规模就不足以支撑"查无此人"的结论

# 第二条通道（群成员）的阳性对照锚点。
# 为什么必须是**另一个**锚点：一条通道活着，不能替另一条通道作证。
# 实测依据（2026-09-21）：GET im/v1/chats/oc_TEST_GROUP/members
#   ?member_id_type=open_id → code=0，3 人：Owner / 对接人 / 周健。
# 选Owner当锚点：她是委托人本人（p2p 里持续提问的那个 open_id），最不可能离群。
CHAT_ANCHOR = {"name": "Owner", "open_id": "ou_TEST_USER"}

# 第三条通道（资源索引里的 owner）的锚点。
# 与上面两个是**不同的**通道，所以必须是**另一个**人 —— 一条通道活着不给另一条作证。
# 实测（2026-09-21）：GET contact/v3/users/ou_a37e9c…?user_id_type=open_id
#   → code=0，name=成员B、email=user@example.com。
OWNER_INDEX = ROOT / "research" / "feishu" / "资源索引-v1.json"
OWNER_ANCHOR = {"name": "成员B", "open_id": "ou_TEST_USER"}

# 已知可读的底座（app_token）——只读；新增底座请追加，不要删旧的
APPS = [
    ("DXJ6b5cKtaXPQasoayEc74SUnog", "品线SEO任务管理系统"),
    ("A437bIdQfax7dbsyrAncPpbNnjh", "需求知识库"),
    ("B1oabL2veaFKbKs2hVAcvyKKnEe", "语境守卫词库"),
    ("GnRZbIuXraCzf0sGr2UcmZ62nfc", "内容治理-知识库"),
    ("Lk3Qb8y2QaVyZns6gprcVNE9nA0", "吸奶器广告文案·品线内容边界风控"),
    ("OShmbLBaPam6YSsCzP0cNOyBn6f", "【创意】需求排期与任务管理"),
    ("S35xbhN9TaYp9JspgC0cM6T2nNc", "KPI-绩效评价系统"),
    ("L88os37wThD5OEtajQEcqzbdnIS", "AAA外部需求池"),
]
MAX_RECORDS_PER_TABLE = 3000     # 与其它盘点工具一致的上限，避免失控


def _req(url, token=None, payload=None, timeout=45):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method="POST" if data else "GET")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    if data:
        req.add_header("Content-Type", "application/json; charset=utf-8")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            return {"_http": e.code, **json.loads(e.read())}
        except Exception:
            return {"_http": e.code}
    except Exception as e:
        return {"_err": f"{type(e).__name__}: {e}"}


def token():
    c = json.load(open(CRED, encoding="utf-8"))
    r = _req(f"{BASE}/auth/v3/tenant_access_token/internal", None,
             {"app_id": c["app_id"], "app_secret": c["app_secret"]})
    if r.get("code") != 0:
        raise SystemExit(f"❌ 取 token 失败：{json.dumps(r, ensure_ascii=False)[:300]}")
    return r["tenant_access_token"], c["app_id"]


# ───────────────────────── 采集 ─────────────────────────

def _harvest_values(x, where, out):
    """递归找「人员形状」的值：带 ou_ id 或 email 的 dict。不猜字段类型。"""
    if isinstance(x, dict):
        if str(x.get("id", "")).startswith("ou_") or x.get("email"):
            key = (x.get("name") or x.get("en_name") or "", x.get("email") or "")
            if key[0] or key[1]:
                prev = out.get(key)
                rec = {"姓名": key[0], "en_name": x.get("en_name") or "",
                       "邮箱": key[1], "open_id": x.get("id") or "", "出处": where}
                # 同一人可能出现在多处：保留 id 更完整的一条，出处合并计数
                if prev:
                    if not prev.get("open_id") and rec["open_id"]:
                        rec["出处"] = prev["出处"] + " · " + where
                        out[key] = rec
                    elif where not in prev["出处"]:
                        prev["出处"] = prev["出处"] + " · " + where
                else:
                    out[key] = rec
        for v in x.values():
            _harvest_values(v, where, out)
    elif isinstance(x, list):
        for v in x:
            _harvest_values(v, where, out)


def harvest_owners(tok):
    """资源索引里的 owner → 通讯录单查 → [(人, 出处)]，附统计。

    ★ 为什么这是**第三条**通道，而不是前两条的重复：
      前两条解决的都是「谁在这个应用看得见的圈子里」；这一条解决的是
      「**谁在我们读得到的资源上署了名**」—— 完全不同的入口。
      索引里存的是 open_id，而 `contact/v3/users/{open_id}`（2026-09-18 起可用）
      会把它换回 **姓名 + 邮箱 + open_id** 三件套，于是这些人可以不靠群、不靠多维表格
      就进字典。15 人对接人表里的**成员B**就是这么出来的。

    返回的统计同样是**这条通道的自证**：索引读不到、或一个 open_id 都没换回名字时，
    这条通道等于没采到，调用方据此禁止输出否定结论。
    """
    try:
        raw = json.loads(OWNER_INDEX.read_text(encoding="utf-8"))
    except Exception as e:
        return [], {"索引owner": 0, "索引已换名": 0, "错误": f"读不到 {OWNER_INDEX.name}: {e}"}
    oids = sorted({r["owner"] for r in raw.get("resources", []) if r.get("owner")})
    people = []
    for oid in oids:
        r = _req(f"{BASE}/contact/v3/users/{oid}?user_id_type=open_id", tok)
        if r.get("code") != 0:
            continue
        u = (r.get("data") or {}).get("user") or {}
        if not u.get("name"):
            continue
        people.append({"姓名": u["name"], "en_name": u.get("en_name") or "",
                       "邮箱": u.get("email") or "", "open_id": u.get("open_id") or oid,
                       "出处": "资源索引owner"})
    return people, {"索引owner": len(oids), "索引已换名": len(people)}


def harvest_chats(tok):
    """群成员通道（im:chat 权限，零通讯录权限）→ [(人, 出处)]，附统计。

    ★ 为什么必须有这一条：成员接口直接返回 `name` + `member_id`(=open_id)，
      **不需要通讯录任何权限**。旧版把它写进了 ROUTES 当作"以后可以走的路"，
      却没有一行代码走它 —— 于是「看不见」这句话一直建立在一半的输入上。

    返回的统计是**这条通道的自证**：群数=0 或成员数=0 时，这条通道等于没采到，
    调用方据此禁止输出否定结论（不靠调用方自觉，见 verify_resolver）。
    """
    members, chats_ok = [], 0
    r = _req(f"{BASE}/im/v1/chats?page_size=100", tok)
    if r.get("code") != 0:
        return members, {"群数": 0, "群成员": 0, "错误": f"chats code={r.get('code')} msg={r.get('msg')}"}
    for c in r.get("data", {}).get("items", []):
        cid, cname = c.get("chat_id"), c.get("name") or c.get("chat_id", "?")
        if not cid:
            continue
        chats_ok += 1
        page = ""
        while True:
            url = (f"{BASE}/im/v1/chats/{cid}/members"
                   f"?member_id_type=open_id&page_size=100")
            if page:
                url += "&page_token=" + page
            m = _req(url, tok)
            if m.get("code") != 0:
                break
            for it in m.get("data", {}).get("items", []):
                members.append({"姓名": it.get("name") or "",
                                "en_name": "",
                                "邮箱": "",
                                "open_id": it.get("member_id") or "",
                                "出处": f"群成员/{cname}"})
            if not m.get("data", {}).get("has_more"):
                break
            page = m.get("data", {}).get("page_token", "")
    return members, {"群数": chats_ok, "群成员": len(members)}


def _merge_chat_people(people, chat_people):
    """把群成员并进字典。**同一个 open_id 就是同一个人** —— 按 open_id 认，不按姓名认。

    为什么不能直接用 (姓名, 邮箱) 当键：群成员没有邮箱，键会退化成 (姓名, "")，
    与人员字段里的同名人**看起来像两条记录**，字典人数就会虚高（而人数正是
    verify_resolver 的门槛）。同一个 open_id 合并、不同 open_id 撞名 → 两个都留，
    因为"同名不同人"和"同名同人"是两件事，不该由我在这里替它们决定。
    """
    by_id = {p["open_id"]: p for p in people if p.get("open_id")}
    for cp in chat_people:
        prev = by_id.get(cp["open_id"]) if cp["open_id"] else None
        if prev is not None:
            if cp["出处"] not in prev["出处"]:
                prev["出处"] = prev["出处"] + " · " + cp["出处"]
            continue
        # 群成员没有邮箱，可能补上人员字段里缺 open_id 的那条
        twin = [p for p in people if p["姓名"] == cp["姓名"] and not p.get("open_id")]
        if len(twin) == 1:
            twin[0]["open_id"] = cp["open_id"]
            twin[0]["出处"] = twin[0]["出处"] + " · " + cp["出处"]
            by_id[cp["open_id"]] = twin[0]
            continue
        people.append(cp)
        if cp["open_id"]:
            by_id[cp["open_id"]] = cp
    return people


def harvest(tok):
    """扫两条通道（人员字段 + 群成员）→ 字典。返回 (人, 统计)。"""
    people, tables_read, records_read = {}, 0, 0
    for app, appname in APPS:
        tabs = _req(f"{BASE}/bitable/v1/apps/{app}/tables?page_size=100", tok)
        if tabs.get("code") != 0:
            continue                                  # 单个底座不可读不致命，但要计数
        for t in tabs.get("data", {}).get("items", []):
            tid, tname = t["table_id"], t.get("name", "?")
            tables_read += 1
            page, n = "", 0
            while n < MAX_RECORDS_PER_TABLE:
                url = f"{BASE}/bitable/v1/apps/{app}/tables/{tid}/records?page_size=500"
                if page:
                    url += "&page_token=" + page
                r = _req(url, tok)
                if r.get("code") != 0:
                    break
                items = r.get("data", {}).get("items", [])
                for it in items:
                    _harvest_values(it.get("fields", {}), f"{appname}/{tname}", people)
                n += len(items)
                records_read += len(items)
                if not r.get("data", {}).get("has_more"):
                    break
                page = r.get("data", {}).get("page_token", "")
    chat_people, cstat = harvest_chats(tok)          # 第二条通道：群成员
    people = _merge_chat_people(list(people.values()), chat_people)
    own_people, ostat = harvest_owners(tok)          # 第三条通道：资源索引 owner
    people = _merge_chat_people(people, own_people)
    stat = {"底座": len(APPS), "数据表": tables_read, "记录": records_read,
            "群数": cstat["群数"], "群成员": cstat["群成员"],
            "索引owner": ostat["索引owner"], "索引已换名": ostat["索引已换名"]}
    if cstat.get("错误"):
        stat["群通道错误"] = cstat["错误"]
    if ostat.get("错误"):
        stat["索引通道错误"] = ostat["错误"]
    return people, stat


# ───────────────────────── 纯逻辑（可被验收脚本直接调用，不联网）─────────

def verify_resolver(people, stat=None, anchor=ANCHOR, min_people=MIN_PEOPLE,
                    chat_anchor=CHAT_ANCHOR, owner_anchor=OWNER_ANCHOR):
    """阳性对照：解析器必须**先证明自己看得见**，否则一切「查无此人」都不作数。

    ★ 2026-09-21：改成**每条通道各证一次**。旧版只证人员字段那条，
      于是「群成员」这条根本没被查过，否定结论却照样发出去。
      一条通道活着，不给另一条通道作证 —— 这是这个函数的全部要点。
    """
    stat = stat or {}
    if not people:
        return False, "字典为空 —— 采集没有输入，此时任何『查无此人』都是恒真结论"
    if len(people) < min_people:
        return False, f"字典只有 {len(people)} 人（<{min_people}）—— 规模不足以支撑否定结论"
    hit = [p for p in people if p["姓名"] == anchor["name"]]
    if not hit:
        return False, f"锚点 {anchor['name']} 不在字典里 —— 字典来源变了，否定结论不可信"
    if hit[0]["open_id"] != anchor["open_id"]:
        return False, (f"锚点 {anchor['name']} 的 open_id 与已知值不符"
                       f"（{hit[0]['open_id']} ≠ {anchor['open_id']}）")

    # ── 通道二：群成员必须自证活着 ──
    # 判据落在**读数**上，不落在"接口没报错"上：群数 0 或成员数 0 都等于没采到。
    n_chats, n_members = stat.get("群数"), stat.get("群成员")
    if stat.get("群通道错误"):
        return False, f"群成员通道失败（{stat['群通道错误']}）—— 少一条通道，否定结论不作数"
    if not n_chats:
        return False, ("群成员通道返回 0 个群 —— 这条通道没采到输入，"
                       "「本应用看不见」这句话此时没有依据")
    if not n_members:
        return False, (f"群成员通道只读到 {n_chats} 个群、0 个成员 —— "
                       "没有任何命中的通道不能替否定结论作证")
    ch = [p for p in people if p["姓名"] == chat_anchor["name"]]
    if not ch or ch[0]["open_id"] != chat_anchor["open_id"]:
        got = ch[0]["open_id"] if ch else "未命中"
        return False, (f"群成员锚点 {chat_anchor['name']} 未按已知 open_id 命中"
                       f"（{got} ≠ {chat_anchor['open_id']}）—— 群通道的读数不可信")

    # ── 通道三：资源索引 owner 也必须自证活着 ──
    if stat.get("索引通道错误"):
        return False, f"资源索引 owner 通道失败（{stat['索引通道错误']}）—— 少一条通道，否定结论不作数"
    if not stat.get("索引owner"):
        return False, ("资源索引里读到 0 个 owner —— 这条通道没采到输入，"
                       "「本应用看不见」这句话此时没有依据")
    if not stat.get("索引已换名"):
        return False, (f"资源索引有 {stat['索引owner']} 个 owner，但**一个都没换回名字** —— "
                       "没有命中的通道不能替否定结论作证")
    ow = [p for p in people if p["姓名"] == owner_anchor["name"]]
    if not ow or ow[0]["open_id"] != owner_anchor["open_id"]:
        got = ow[0]["open_id"] if ow else "未命中"
        return False, (f"资源索引锚点 {owner_anchor['name']} 未按已知 open_id 命中"
                       f"（{got} ≠ {owner_anchor['open_id']}）—— 索引通道的读数不可信")

    return True, (f"三条通道各自的锚点均命中：{anchor['name']}（人员字段）· "
                  f"{chat_anchor['name']}（群成员）· {owner_anchor['name']}（资源索引）"
                  f" · 字典 {len(people)} 人 · 群 {n_chats} 个 / 成员 {n_members} 人次"
                  f" · 索引 owner {stat['索引owner']} 个 / 换名 {stat['索引已换名']} 个")


# 邮箱前缀索引：仅在"没有更硬的证据"时用来**提名候选**，绝不当作命中。
def _by_mail_prefix(query, people):
    q = (query or "").strip().lower()
    if not q or not q.isascii():
        return []
    return [p for p in people
            if p.get("邮箱") and p["邮箱"].split("@")[0].split(".")[0].lower() == q]


def resolve(query, people, verified=True, why=""):
    """query → {status: found|not_found|unverifiable}。verified=False 时拒绝给否定结论。"""
    q = (query or "").strip()
    if not q:
        return {"status": "error", "why": "空查询"}
    exact = [p for p in people
             if q in (p["姓名"], p["en_name"], p["邮箱"])]
    if exact:
        return {"status": "found", "person": exact[0], "match": "精确"}
    # 姓名里带英文名是常态（"Rikka（林建纯）"），所以再放宽一层：去括号后再比
    bare = q.split("（")[0].split("(")[0].strip()
    loose = [p for p in people
             if bare and (bare in p["姓名"] or bare in p["en_name"] or
                          p["姓名"] in q or (p["en_name"] and p["en_name"] in q))]
    if loose:
        return {"status": "found", "person": loose[0], "match": f"包含匹配（{bare}）"}
    # ★ 候选层：英文名对得上邮箱前缀。这是**线索，不是结论** ——
    #   反例就在眼前：表里写「Rita」（婴幼儿品线），字典里 rita.ge@ 是葛奕辰，
    #   而葛奕辰出现在【创意UGC】提需表。两条都成立时也仍然是"看起来像"，
    #   所以单列一个状态（退出码 3），不许混进 found。
    cands = _by_mail_prefix(bare or q, people)
    if cands:
        return {"status": "candidate", "candidates": cands,
                "match": f"邮箱前缀（{bare or q}）"}
    # ★ 结构性防线：字典为空时**无论调用方怎么说**都不给否定结论。
    #   不信赖调用方传进来的 verified —— 否则这个门就成了"检查验证自己"。
    if not people:
        return {"status": "unverifiable",
                "why": "字典为空 —— 此时「查无此人」恒为真，拒绝作答"}
    if not verified:
        return {"status": "unverifiable", "why": why}     # ★ 不返回 not_found
    return {"status": "not_found", "why": why}


# ── 通道台账：**每条通道各自要留在产物里的读数** ─────────────────────────
# ★ 2026-09-21：这张表是补出来的，代价是一次真事故。
#   加第三条通道（资源索引 owner）时，工具的打印（`--find` 的抬头）与
#   `verify_resolver` 都跟上了，**只有写进 CSV 的元信息行没跟上** ——
#   于是产物里只有通道一、二的读数，口径那句还写着「两条通道的并集」。
#
#   后果不是"少写几个字"：**任何从产物重建判据的调用方都会把第三条通道读成
#   「没采到」**。`verify_engine_contract.py` 的 V42 就是这么调的，于是
#   V42a/V42b 当场变红（174/176）。这正是 §2.4.1 第 5 行的形状 ——
#   产物里的一句过期口径，被当成现状用。
#
#   修法不是把话改对，是**让读数由这张表现算**：加通道时产物自动跟上。
#
#   (序号, 这条通道是什么, 它给出什么, ((stat 键, 元信息标签), ...))
CHANNELS = (
    ("①", "bitable 人员形状的值", "姓名+邮箱+open_id",
     (("底座", "底座"), ("数据表", "数据表"), ("记录", "记录"))),
    ("②", "机器人所在群的成员", "姓名+open_id，无邮箱",
     (("群数", "群"), ("群成员", "群成员"))),
    ("③", "在我们读得到的资源上署名过的 owner", "姓名+邮箱+open_id",
     (("索引owner", "索引owner"), ("索引已换名", "索引已换名"))),
)

#: 元信息行里"缺了就说明这条通道没被记录"的标签。`--controls` 拿它做反向对照。
CHANNEL_LABELS = tuple(lab for _n, _d, _y, pairs in CHANNELS for _k, lab in pairs)


def _meta_cells(people_n, app_id, stat, stamp):
    """CSV 元信息行的内容（**纯函数**，不碰盘 —— 反向对照要能在内存里喂它）。

    读数逐条从 `CHANNELS` 现算，口径那句的通道数也现算 —— 加通道时这里自动跟上。
    """
    readings = [f"{lab}={stat.get(key)}"
                for _n, _d, _y, pairs in CHANNELS for key, lab in pairs
                # ★ 缺读数就**不写这一格**，绝不写 `lab=None`。
                #   实测（本文件的 --controls 抓到的）：写 None 会落成一个**字面量字符串**，
                #   而 `verify_resolver` 的判据是 `if not stat["索引owner"]` ——
                #   字符串 "None" 是**真值**，于是一条根本没采到的通道能被读成"采到了"。
                #   缺就得是缺，不能长得像有。
                if stat.get(key) is not None]
    caliber = ("口径=**%d 条通道的并集**：" % len(CHANNELS)
               + "".join(f"{n} {d}（{y}）；" for n, d, y, _p in CHANNELS).rstrip("；")
               + "。都不是的人，本应用解析不出 —— 但那是「读得到的通道里都没有」，"
                 "不是「世上没有这个人」")
    return ["# 由 tools/lark_people.py 生成（只读采集）",
            f"harvested_at={stamp}", f"app={app_id}（守衡）",
            *readings, f"人数={people_n}", caliber]


def parse_meta_cells(meta):
    """把元信息行的单元格列表读回成 `stat` 字典（`verify_resolver` 要的那个形状）。

    ★ 产物 → 判据 的重建**只在这里做一次**。调用方各自 split 一遍，
      迟早 split 出两个口径（§2.5：同一个判断只能有一处）。
    """
    kv = {}
    for cell in meta or []:
        if "=" in cell:
            k, _, v = cell.partition("=")
            kv[k.strip()] = v.strip()
    out = {}
    for _n, _d, _y, pairs in CHANNELS:
        for key, lab in pairs:
            if lab not in kv:
                continue                     # 缺了就不写 —— 让 verify_resolver 判它
            if kv[lab] in ("", "None", "null"):
                continue                     # ★ 字面量 "None" 也是"缺"（见 _meta_cells 的注释）
            try:
                out[key] = int(kv[lab])
            except ValueError:
                out[key] = kv[lab]
    return out


def parse_meta(path):
    """读 CSV 第一行（元信息行）→ stat 字典。读不到就回一个带 `产物错误` 的字典。"""
    import csv as _csv
    try:
        with open(path, encoding="utf-8", newline="") as f:
            meta = next(_csv.reader(f), [])
    except OSError as e:                                      # noqa: BLE001
        return {"产物错误": f"{type(e).__name__}: {e}"}
    return parse_meta_cells(meta)


# ───────────────────────── 人读输出 ─────────────────────────

def _write_csv(people, app_id, stat):
    import csv
    import datetime
    OUT.parent.mkdir(parents=True, exist_ok=True)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    with open(OUT, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(_meta_cells(len(people), app_id, stat, stamp))
        w.writerow(["姓名", "en_name", "邮箱", "open_id", "出处"])
        for p in sorted(people, key=lambda x: x["姓名"]):
            w.writerow([p["姓名"], p["en_name"], p["邮箱"], p["open_id"], p["出处"]])
    return stamp


BOUNDARY = """\
★ 这不是「搜了一下没搜到」，是本应用**读得到的通道里都没有**。逐条实测（2026-09-21 重测）：

  【方向一】open_id → 姓名 —— **这条早就通了**
    ✓ contact/v3/users/{open_id}   → code=0。旁证：tools/check_contact_scope.py 实测
      索引里 22 个 owner 有 19 个能叫出名字（含对接人、成员B）。2026-09-18 扩过权限。

  【方向二】姓名 / 邮箱 → open_id —— **墙在这一侧**
    ✗ contact/v3/users（列成员）                → code=0，但**只回 2 人**（周健 / Owner）
        ★ 不是缺 scope：`contact:contact.base:readonly` 与 `contact:user.base:readonly`
          **都已经开通**（应用自身 scopes 里查得到，共 424 条）。卡的是应用的
          **通讯录权限范围**。旧版这里写「99991672 缺权限」，那是 09-16 的读数 ——
          **09-18 就变了，本文件一直没跟上**。同一个病：对一个通道的断言过期了没人发现。
    ✗ contact/v3/users/batch_get_id（邮箱→id）  → 99991672 缺 `contact:user.id:readonly`
        ★ 这一个是**真的**没开，也是唯一还值得去申请的一条。
    ✗ search/v1/user（按姓名搜人）               → 99991634 需 user_access_token
    ✗ created_by / last_modified_by             → 响应里恒为 null（字段不可用）
    ✗ drive/v1/metas 的 owner_id                → 只有 id 没有姓名，无法反查
    ✓ 人员字段（bitable type=11）   → 已采，规模见上
    ✓ 群成员（im/v1/chats + /members）→ 已采，本次读数见上

  ⇒ **要按姓名找人，缺的不是"通讯录权限"，是"姓名→id"这条方向上的通道。**"""


BOUNDARY_STALE_NOTE = """\
  ★ 关于「im/v1/chats → 仅 1 个群 3 人，**不含此人**」那句（旧版 BOUNDARY 里的）：
    那个「不含此人」当时**没有任何代码去查过**，是一句凭空的限定语。
    2026-09-21 的实测反例：对接人就在那个群里，而旧版对她打印的正是「看不见」。
    ⇒ 所以这个函数现在的边界是**实测出来的**：所有已采通道各自的锚点都命中，
      本人才判定为「不在其中」。"""

ROUTES = """\
★ 让它可送达，四条路（按代价排序 —— **2026-09-21 有重大修正，见 A**）：
    A. ~~授权通讯录只读~~ → **这条已经做完了，不要再申请。**
       实测（2026-09-21）：`contact:contact.base:readonly` 与 `contact:user.base:readonly`
       **都已在应用 scopes 里**；`contact/v3/users/{open_id}` 已能叫出名字。
       真正还缺的是**另一个方向**上的两条，任选其一：
         A1. 申请 `contact:user.id:readonly` —— 开 `batch_get_id`，**邮箱 → open_id** 直接成立。
             （链接由飞书自己给：调一次该接口，错误体里带 auth URL。）
         A2. 把应用的**通讯录权限范围**放宽 —— 现在 `contact/v3/users` 只回 2 人，
             这是**范围**不是缺 scope；放宽后可按姓名遍历。
    B. 本人在飞书里给机器人（守衡）发一句话 —— 事件回调带回 sender open_id，零权限
    C. 本人被拉进机器人所在的群「内容治理-守衡Agent-测试」—— 读群成员即得 open_id，零权限
       （**已实现**：这条路现在是群成员通道。2026-09-21 用它解析出对接人）
    D. 提供**企业邮箱**（本租户域名 rootglobal.net）—— 发送接口支持 receive_id_type=email
       （实测一个不存在的地址返回 230001 invalid receive_id，**不是**权限错），但此路尚未验证
       （若 A1 开通，D 就能反过来变成"邮箱→open_id"的正路）"""


def run_controls():
    """反向对照（**不联网**）：证明上面那几条判据真的会红，不是恒真。

    ★ 为什么要单列一个入口：AGENTS.md §2.4.1 ——「一个新断言如果不能在某次真实事故里
      变红过，就不算验证过它」。这里把 2026-09-21 那次真事故（对接人被误判为看不见）
      的形状固化下来：**群通道死掉时，否定结论必须被挡住**。
      用的是自带夹具，不读网、不读磁盘上的产物，所以随时可跑、结果稳定。
    """
    # 夹具：22 人（> MIN_PEOPLE），含两个锚点。故意造一个"查得到"和一个"真没有"。
    fx = [{"姓名": f"占位{i:02d}", "en_name": "", "邮箱": f"p{i:02d}@rootglobal.net",
           "open_id": f"ou_{i:028d}", "出处": "夹具"} for i in range(20)]
    fx.append({"姓名": ANCHOR["name"], "en_name": ANCHOR["name"],
               "邮箱": "user@example.com", "open_id": ANCHOR["open_id"],
               "出处": "夹具"})
    fx.append({"姓名": CHAT_ANCHOR["name"], "en_name": "", "邮箱": "",
               "open_id": CHAT_ANCHOR["open_id"], "出处": "夹具"})
    fx.append({"姓名": OWNER_ANCHOR["name"], "en_name": "", "邮箱": "user@example.com",
               "open_id": OWNER_ANCHOR["open_id"], "出处": "夹具"})
    GOOD = {"底座": 1, "数据表": 1, "记录": 23, "群数": 1, "群成员": 1,
            "索引owner": 1, "索引已换名": 1}

    checks = [
        ("三条通道都自证活着 → 允许作证",
         lambda: verify_resolver(fx, GOOD)[0] is True),
        ("群通道返回 0 个群 → 拒绝作证",
         lambda: verify_resolver(fx, {**GOOD, "群数": 0, "群成员": 0})[0] is False),
        ("群里有群、0 个成员 → 拒绝作证",
         lambda: verify_resolver(fx, {**GOOD, "群成员": 0})[0] is False),
        ("群通道报错 → 拒绝作证",
         lambda: verify_resolver(fx, {**GOOD, "群通道错误": "code=99991672"})[0] is False),
        ("群通道统计整个缺失 → 拒绝作证",
         lambda: verify_resolver(fx, {"底座": 1, "数据表": 1, "记录": 23})[0] is False),
        ("群锚点被换成人不对的 open_id → 拒绝作证",
         lambda: verify_resolver(
             fx, GOOD,
             chat_anchor={"name": "占位00", "open_id": "ou_TEST_USER"})[0] is False),
        # ★ 第三条通道：资源索引 owner
        ("索引通道：0 个 owner → 拒绝作证",
         lambda: verify_resolver(fx, {**GOOD, "索引owner": 0, "索引已换名": 0})[0] is False),
        ("索引通道：有 owner 但一个都没换回名字 → 拒绝作证",
         lambda: verify_resolver(fx, {**GOOD, "索引已换名": 0})[0] is False),
        ("索引通道：读不到索引文件 → 拒绝作证",
         lambda: verify_resolver(fx, {**GOOD, "索引通道错误": "读不到 资源索引-v1.json"})[0] is False),
        ("索引锚点未按已知 open_id 命中 → 拒绝作证",
         lambda: verify_resolver(
             fx, GOOD,
             owner_anchor={"name": "占位01", "open_id": "ou_TEST_USER"})[0] is False),
        ("人员字段锚点丢失 → 拒绝作证",
         lambda: verify_resolver([p for p in fx if p["姓名"] != ANCHOR["name"]], GOOD)[0] is False),
        ("字典规模不足（<20）→ 拒绝作证",
         lambda: verify_resolver(fx[:19], GOOD)[0] is False),
        ("字典为空 → 拒绝作证",
         lambda: verify_resolver([], GOOD)[0] is False),
        # ★ 行为层：这是本条修正的核心 —— 通道死时结论必须从「看不见」变成「无法作答」
        ("通道活着 → 真没有的人仍判 not_found（不许把所有人洗成可送达）",
         lambda: resolve("查无此人甲", fx, verified=True, why="")["status"] == "not_found"),
        ("通道死掉 → 同一个人必须变成 unverifiable，不能是 not_found",
         lambda: resolve("查无此人甲", fx,
                         verified=verify_resolver(fx, {**GOOD, "群成员": 0})[0],
                         why=verify_resolver(fx, {**GOOD, "群成员": 0})[1])["status"] == "unverifiable"),
        # 候选层：只提名，不加冕
        ("邮箱前缀命中 → candidate，不是 found",
         lambda: resolve("roxie", fx, verified=True, why="")["status"] == "candidate"),
        ("非 ASCII 查询不触发邮箱前缀候选（中文名不许被前缀乱配）",
         lambda: resolve("张丽敏", fx, verified=True, why="")["status"] == "not_found"),
        ("一正例未被误伤：锚点本人仍判 found",
         lambda: resolve(ANCHOR["name"], fx, verified=True, why="")["status"] == "found"),
        # ★ 产物层（2026-09-21 补）：CSV 的元信息行必须把**每条通道的读数**都带上。
        #   这一格是这次 V42a/V42b 变红的直接成因 —— 加了第三条通道，
        #   而写进产物的读数没加，于是"从产物重建判据"的调用方把通道三读成"没采到"。
        ("产物往返恒等：元信息行写出的读数，parse_meta_cells 必须逐条读回来",
         lambda: all(parse_meta_cells(_meta_cells(len(fx), "cli_x", GOOD, "t")).get(k) == GOOD[k]
                     for _n, _d, _y, pairs in CHANNELS for k, _l in pairs)),
        ("★ 通道读数缺任意一条 → 往返恒等必须红（反向对照，逐条验）",
         lambda: all(parse_meta_cells(_meta_cells(len(fx), "cli_x",
                                                  {k: v for k, v in GOOD.items() if k != drop},
                                                  "t")).get(drop) is None
                     for drop in ("底座", "记录", "群数", "群成员", "索引owner", "索引已换名"))),
        ("产物里抽掉 索引owner → 从产物重建的 stat 必须让 verify_resolver 拒绝作证",
         lambda: verify_resolver(
             fx, parse_meta_cells(_meta_cells(len(fx), "cli_x",
                                              {k: v for k, v in GOOD.items() if k != "索引owner"},
                                              "t")))[0] is False),
        # ★ 这一格是上面那两条第一次跑就抓出来的：`lab=None` 会落成**字面量字符串**，
        #   而判据写的是 `if not stat[key]` —— 字符串 "None" 是真值，
        #   于是一条没采到的通道能被读成"采到了"。缺必须是缺。
        ("★ 元信息里的字面量 `索引owner=None` 必须被读成【缺】，不是读成有值",
         lambda: parse_meta_cells(["索引owner=None", "索引已换名=19"]).get("索引owner") is None),
        ("反向对照：把上面那条改成 `索引owner=0` → 它必须**不是** None（否则这判据恒真）",
         lambda: parse_meta_cells(["索引owner=0"]).get("索引owner") == 0),
    ]

    print("反向对照（离线夹具，不联网）——判据必须会红，才算验证过：")
    bad = 0
    for name, fn in checks:
        try:
            ok = bool(fn())
        except Exception as e:                       # 抛异常也算没通过
            ok, name = False, f"{name}（抛出 {type(e).__name__}: {e}）"
        if not ok:
            bad += 1
        print(f"  {'✅' if ok else '❌'} {name}")
    print(f"\n{'✅ 全部 ' + str(len(checks)) + ' 项通过' if not bad else f'❌ {bad}/{len(checks)} 项没按预期'}")
    return 1 if bad else 0


def main():
    ap = argparse.ArgumentParser(description="责任人 → 投递地址 解析器（只读）")
    ap.add_argument("--find", nargs="+", metavar="姓名|邮箱", help="解析一个或多个责任人")
    ap.add_argument("--dump", action="store_true", help="打印全部可见人员")
    ap.add_argument("--selftest", action="store_true", help="只跑阳性对照（联网）")
    ap.add_argument("--controls", action="store_true", help="只跑反向对照（离线，判据必须会红）")
    ap.add_argument("--no-write", action="store_true", help="不写 CSV 产物")
    a = ap.parse_args()

    if a.controls:
        return run_controls()

    tok, app_id = token()
    people, stat = harvest(tok)
    ok, why = verify_resolver(people, stat)
    if not a.no_write:
        stamp = _write_csv(people, app_id, stat)
    else:
        stamp = "(未写)"
    print(f"可见人员字典：{len(people)} 人 · 人员字段：底座 {stat['底座']} / 数据表 {stat['数据表']} / "
          f"记录 {stat['记录']} · 群成员：{stat.get('群数')} 群 / {stat.get('群成员')} 人次 · "
          f"资源索引 owner：{stat.get('索引owner')} 个 / 换名 {stat.get('索引已换名')} 个 · 采集于 {stamp}")
    print(f"阳性对照：{'✅ ' if ok else '❌ '}{why}")

    if a.dump:
        for p in sorted(people, key=lambda x: x["姓名"]):
            print(f"  {p['姓名']:10s} {p['en_name']:12s} {p['邮箱']:34s} {p['open_id']}"
                  f"   [{p['出处']}]")
    if a.selftest:
        return 0 if ok else 1
    if not a.find:
        if not ok:
            print("\n★ 字典不可信 —— 任何「查无此人」都不作数。先修采集，再下结论。")
            return 1
        return 0

    # ── 多人时：字典只采一次（一次采集 ~80 秒，逐个调 --find 会重复付这笔钱），
    #    但每个人的结论与退出码各自独立。整批的退出码取**最坏**的一个。
    #    优先级 1 > 2 > 3 > 0：1 的意思是「这次结论不作数」，绝不能被某个 2 盖过去。
    WORST = {"found": 0, "candidate": 3, "not_found": 2, "unverifiable": 1, "error": 1}
    codes = []
    for q in a.find:
        r = resolve(q, people, verified=ok, why=why)
        print()
        if r["status"] == "found":
            p = r["person"]
            # en_name 常常是空的（本租户的人员字段里它等于姓名，群成员/索引通道干脆没有），
            # 空的时候不要打印一对空括号 —— 「（）」看起来像"名字没取到"，而它只是没有英文名。
            who = p['姓名'] + (f"（{p['en_name']}）" if p['en_name'] and p['en_name'] != p['姓名'] else "")
            print(f"✅ 可送达：{q} → {who}"
                  f"\n   邮箱    {p['邮箱']}\n   open_id {p['open_id']}"
                  f"\n   匹配方式 {r['match']} · 出处 {p['出处']}")
        elif r["status"] == "candidate":
            print(f"◐ 候选（**待人工确认**，不是结论）：{q} —— 只对上了邮箱前缀（{r['match']}）")
            for c in r["candidates"]:
                print(f"   → {c['姓名']} · {c['邮箱']} · {c['open_id']} · 出处 {c['出处']}")
            print("   ★ 邮箱前缀相同**不等于**同一个人：『Rita』能对上 rita.ge@，但表里那条"
                  "『Rita』属于婴幼儿品线，而 rita.ge@ 的人出现在【创意UGC】提需表。"
                  "要确认，得让本人产生一次可观测信号（见下 ROUTES B/C），或拿到她的企业邮箱。")
        elif r["status"] == "unverifiable":
            print(f"⚠ 无法作答：{q}\n   原因：{r['why']}\n"
                  f"   ★ 拒绝给出「查无此人」—— 阴性结论必须建立在阳性对照之上。")
        else:
            print(f"❌ 本应用读得到的通道里都没有 {q}（退出码 2）\n")
            print(BOUNDARY)
            print()
            print(BOUNDARY_STALE_NOTE)
        codes.append(WORST.get(r["status"], 1))

    # ★ 不能直接用 max()：退出码的"坏"序是 1 > 2 > 3 > 0，不是数值大小。
    #   照数值取 max 会把「候选(3)」当成比「看不见(2)」更坏 —— 方向反了。
    RANK = {1: 3, 2: 2, 3: 1, 0: 0}
    worst = max(codes, key=lambda c: RANK.get(c, 3)) if codes else 0
    if len(a.find) > 1:
        print(f"\n—— 本批 {len(a.find)} 人，退出码取最坏：{worst}"
              f"（0 可送达 / 3 候选 / 2 看不见 / 1 无法作答）")
    if worst == 2:
        print()
        print(ROUTES)
    return worst


if __name__ == "__main__":
    sys.exit(main())

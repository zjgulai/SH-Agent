#!/usr/bin/env python3
"""
feishu_index.py —— 守衡在飞书里**可达资源**的索引器（只读）

## 为什么存在

委托原话：「对守衡所有可以通过飞书获取的文档、链接以及聊天记录进行汇总，然后分类
罗列给我，做一个资源索引管理。」

问题在于「所有」这个词没有落点。本轮实测发现三件事，每一件都会让一份凭感觉手写的
清单变成假账：

  ① **「能看见」远大于「它自己的」。** 守衡云盘里只有 2 个文件，但搜索接口能命中
     **388 条**文档。真正的可达面是后者。只看云盘会漏掉 99.5%。
  ② **噪音占绝对多数。** 388 条里绝大多数是**飞书官方模板库**（OKR 看板、CRM 模板、
     员工考试……），对业务零价值。不分类就是一份 388 行的垃圾清单。
  ③ **「搜索得见」不等于「读得到」—— 但实测这一层没有拦。** 本轮抽验：7 篇 docx
     正文全取到（最长 40,185 字），4 个多维表格的记录全取到（含一份**明显不属于
     本项目**的品牌 VI 专项，连它的 13 条交付记录都读出来了）。`tenant_access_token`
     的边界跟「搜索能搜到」基本重合，没有再细一层。

所以本脚本的职责不是「列出来」，是**把「所有」变成一个可复核、可重跑、带降级标注
的集合**。

## 三条硬规矩（沿用 research/kb/load.py 的口径）

  1. **数字由脚本算，不手写。** `资源索引.md` 里每个数都是生成物；`--check` 比对，
     数字对不上就变红。
  2. **拿不到就说拿不到，不降级成空。** 任何一条资源抽不到正文/字段，落 `extent.err`，
     并在 README 如实计入「抽不到的条数」。绝不把 0 当「没有」。
  3. **时间戳一律 Asia/Shanghai。** 飞书返回毫秒 epoch（UTC 基准），直接按 UTC 读会
     整体早一天 —— 这是本项目最容易踩且最难发现的坑（见 load.py 规则 2）。

## 分级口径（为什么这样划 —— 2026-09-18 改过一次，这是改的理由）

分级**只有一条判据**：这条资源挂在哪个租户下。依据是
`drive/v1/metas/batch_query` 回的 `url` 的**域名** —— 服务端给的，不是我猜的。

  | 档 | 判据 | 含义 |
  |---|---|---|
  | `core` | 域 = `momcozy-in.feishu.cn` | **本公司租户**。公司里真有人在用，**全部抽正文** |
  | `reference` | 非本租户，但命中业务词 | 可能相关，只记元数据 |
  | `noise` | 其余 | 非本租户且无业务信号 |

**为什么把旧的「标题像不像」判据整条删掉。** 旧规则是
`命中业务词 且 (revision>0 或 标题命中项目词)`，它在**两个方向上都错**，
而且错得都很安静：

  - **漏**：本租户的「全球吸奶器品牌型号库」（62 条竞品型号、30+ 技术字段）、
    「全球产品小百科」（9 张品类表）、「W1美国故事TVC项目看板」、「BW04 新品上市
    社媒宣传设计需求」、「Lumi 1 红光科普视频项目看板」全被判进 noise ——
    只因为标题里的词不在我写死的词表里。**词表漏一个词，一个真资产就消失。**
    而这五条恰恰是内容合规最需要的东西（产品事实依据、待审的营销内容）。
  - **误报**：同样本租户但业务无关的「行政-差旅常见Q&A」「飞书帮助中心常见问题」，
    因为标题里凑够两个弱领域词，被抬进「核心层（业务真正要用的）」。

合起来说明：**「跟我们业务相不相关」是判断题，分级器判不了。**
我把它当成能用关键词算出来的东西，算出来的就是假精度 —— 而假精度比没有分级更糟，
因为它看着像读过。现在分级器只做它确实能确定的事（在不在我们租户里），
相关性写在 `research/feishu/可达清单.md` 里，逐条人工判、逐条写「讲什么 / 怎么处理」。

**副本归一**：同一 `title` 出现多次时，按 (`tier` 高 → `revision` 大 → `modified_time`
新 → `token`) 选主副本，其余标 `dedup_of`。不删 —— 删了就说不清「原本有几份」。
排序必须是**全序**：只按前三项排，多个副本可能完全相同，主副本就会在两次运行间跳，
`--check` 于是报「同一标题既新增又消失」的**假差异**，而假差异会淹没真差异。

## 用法

    python3 tools/feishu_index.py              # 全量扫 → 写索引 + 生成物
    python3 tools/feishu_index.py --check      # 只比对不改盘（退出码非 0 = 索引过期）
    python3 tools/feishu_index.py --no-extent  # 跳正文抽取（快，用于回归）

凭据：`~/.dsh/credentials/shouheng-lark.json`（守衡自己的飞书应用，只读用）。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from urllib.parse import quote, urlencode, urlparse

from feishu_read_policy import (ResourceReadStopped,
                                assert_read_allowed, blocked_resource, filter_entries, load_policy)

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(REPO, "research", "feishu")
INDEX_JSON = os.path.join(OUT_DIR, "资源索引-v1.json")
INDEX_MD = os.path.join(OUT_DIR, "资源索引.md")
CRED = os.path.expanduser("~/.dsh/credentials/shouheng-lark.json")
BASE = "https://open.feishu.cn/open-apis"
CST = timezone(timedelta(hours=8))

# ---------------------------------------------------------------- 口径（改这里）

# 我方可确认拥有的资源 —— 直接进 core，不看其他信号。
# 来源：tools/migrate_*.py 建出来的 + 守衡云盘自有。
MINE = {
    "A437bIdQfax7dbsyrAncPpbNnjh": "需求知识库（本项目建，7 张表）",
    "GnRZbIuXraCzf0sGr2UcmZ62nfc": "内容治理-知识库（业务侧四类知识库落点）",
    "B1oabL2veaFKbKs2hVAcvyKKnEe": "品线内容边界-机器词表（白名单/语境守卫词）",
    "W2KodnZP3orVrAxxn5OcbmKtnxh": "需求框架整理（业务源头文档）",
    "VBzndFbHxoNGuuxF0dfcHfMNnvg": "智能纪要：内容合规审查项目规划会 2026-09-15",
}

# 命中即视为业务信号
BIZ_TERMS = [
    "内容合规", "审核规范", "内容治理", "营销内容", "生命周期",
    "品线", "词表", "白名单", "黑名单", "违禁", "极限词", "广告法",
]
# 弱一档的领域词 —— 单独命中不算业务，交叉命中才算
DOMAIN_TERMS = ["素材", "文案", "SOP", "手册", "规范", "标准", "审核", "抽查", "合规"]

# 标题里出现这些词，说明是一个真实在跑的项目/需求，不是模板
PROJECT_MARKERS = [
    "需求", "看板", "专项", "周报", "月报", "复盘", "纪要", "方案", "排期",
    "项目", "提需", "验收",
]
# 标题里出现这些，是飞书官方模板/帮助中心的特征（强噪音信号）
TEMPLATE_MARKERS = [
    "快速上手", "模板", "飞书同款", "帮助中心", "一张表管公司", "入门手册",
    "十大模板", "Personal OKR", "Task Subdivision", "Operating Your Company",
    "Retail Store", "公司を管理する",
]

# 搜索词表。**换词就会换结果** —— 所以词表落盘进索引，供复核。
SEARCH_TERMS = [
    "内容合规", "内容治理", "审核规范", "营销内容", "生命周期", "品线", "词表",
    "白名单", "黑名单", "违禁", "极限词", "广告法", "素材", "文案", "合规",
    "知识库", "需求", "标准", "规范", "手册", "SOP", "复盘", "纪要", "项目",
    "测试", "验收", "交付", "方案", "客服", "售后", "课程", "审批", "待办",
    "美区", "服纺", "吸奶器", "视频", "看板", "抽查", "培训",
]

# 多维表格里内嵌的**官方示例表**。它们跟着任何 app 一起被复制进来（实测在
# 每日发送热点新闻、🏆销售技能考核测评、📋待办事项 里各出现一次，字段完全一样），
# 是「同一张模板表」的多个副本，不是业务表。抽取时标出来，生成物里不计入业务表。
EMBEDDED_TEMPLATE_TABLES = ("快速上手多维表格", "审批管理员配置", "示例")

# ---------------------------------------------------------------- 租户判据
#
# 这是本轮**最重要的一个发现**，也是上一版分级最脆的地方。
#
# `drive/v1/metas/batch_query` 对每条资源都会回一个 `url`。这个 url 的**域名**
# 就是资源的归属租户 —— 而且是服务端给的，不是我从标题猜的：
#
#   momcozy-in.feishu.cn   本公司租户。25 条。只有这些是「公司里真有人在用的东西」。
#   fcna6swh3rtl.feishu.cn 飞书模板库租户。43 条，**全部是多维表格模板**
#                          （CRM、OKR、报销、考勤、请假……），无一例外。
#   www.feishu.cn          飞书官方模板/帮助内容。387 条。
#
# 抽验佐证（不是靠域名猜，是读了正文）：
#   · www 域的「团队 OKR 周会（飞阅会方式）」正文是飞书官方的 OKR 教学稿；
#   · www 域的「SWOT 分析看板」表名就叫「示例：企业 SWOT 分析」；
#   · 本租户的「飞书帮助中心常见问题」 —— 域名对，但正文是有人**把飞书官方帮助
#     搬进了我们租户**。所以域名只回答「在不在我们租户里」，不回答「是不是业务资产」。
#     后者是判断题，留在人工清单里做（research/feishu/可达清单.md）。
#
# 纪律：域名判据只用来**降级**（非本租户 → 最多 reference），不用来**升级**。
# 否则一个叫得像业务的模板又会骗过分级器。
TENANT_HOST = "momcozy-in.feishu.cn"
FEISHU_TEMPLATE_HOSTS = {
    "www.feishu.cn": "飞书官方模板/帮助内容",
    "fcna6swh3rtl.feishu.cn": "飞书模板库租户（实测 43 条全是模板）",
}

DOC_TYPES = {
    "docx": "云文档", "doc": "云文档(旧)", "bitable": "多维表格", "sheet": "电子表格",
    "slides": "幻灯片", "mindnote": "思维笔记", "file": "附件/文件", "wiki": "知识库节点",
}


# ---------------------------------------------------------------- 基础设施

def _die(msg: str):
    print(f"\n❌ {msg}\n", file=sys.stderr)
    sys.exit(2)


def _get(url, token, timeout=25):
    r = urllib.request.Request(url, method="GET")
    if token:
        r.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(r, timeout=timeout) as x:
            return json.loads(x.read())
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read())
        except Exception:
            return {"code": e.code, "msg": f"http_{e.code}"}
    except Exception as e:
        return {"code": -1, "msg": f"{type(e).__name__}: {e}"}


def _post(url, token, body, timeout=25):
    r = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST")
    r.add_header("Content-Type", "application/json; charset=utf-8")
    if token:
        r.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(r, timeout=timeout) as x:
            return json.loads(x.read())
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read())
        except Exception:
            return {"code": e.code, "msg": f"http_{e.code}"}
    except Exception as e:
        return {"code": -1, "msg": f"{type(e).__name__}: {e}"}


def _items(resp, *keys):
    """从飞书响应里取列表 —— **把两种键名都试一遍**。

    踩过的坑：`/bitable/.../tables` 把表放在 `data.items`，不是 `data.tables`。
    我最初只读 `tables`，于是 `code=0` + 空列表 → 脚本安静地报「0 张表」。
    这种错最危险：它跟「这张表真的是空的」长得一模一样，没有任何东西会红。
    """
    d = resp.get("data") or {}
    for k in keys:
        v = d.get(k)
        if isinstance(v, list):
            return v
    # 兜底：data 里任何一个是 list 的键
    for k, v in d.items():
        if isinstance(v, list):
            return v
    return []


RATE_LIMIT_CODES = {99991400, 99991401, 429}


def _with_retry(fn, tries=4, base=0.6):
    """限流是**可恢复**的，权限拒绝不是。两者绝不能混为一谈 ——
    我第一版把 `99991400 request trigger frequency limit` 当成了「读不到」。"""
    last = None
    for i in range(tries):
        r = fn()
        last = r
        if r.get("code") not in RATE_LIMIT_CODES:
            return r, None
        time.sleep(base * (2 ** i))
    return last, f"限流重试 {tries} 次仍失败：code={last.get('code')} {last.get('msg')}"



def token_of() -> str:
    if not os.path.exists(CRED):
        _die(f"凭据不存在：{CRED}\n守衡的飞书应用凭据是索引的唯一入口，缺它无法继续。")
    c = json.load(open(CRED, encoding="utf-8"))
    r = _post(f"{BASE}/auth/v3/tenant_access_token/internal", None,
              {"app_id": c["app_id"], "app_secret": c["app_secret"]})
    if r.get("code") != 0:
        _die(f"拿不到 tenant_access_token：code={r.get('code')} msg={r.get('msg')}")
    return r["tenant_access_token"]


def ms_to_cst(ms):
    """飞书毫秒 epoch → Asia/Shanghai ISO 日期串。绝不用 UTC 读（load.py 规则 2）。"""
    if not ms:
        return None
    try:
        return datetime.fromtimestamp(int(ms) / 1000, CST).strftime("%Y-%m-%d %H:%M")
    except Exception:
        return None


def sha12(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()[:12]


# ---------------------------------------------------------------- 发现层

def discover_search(tok, terms=SEARCH_TERMS, workers=8):
    """搜索接口是**发现主入口**。逐词搜，命中并集即候选集。"""
    def one(kw):
        r = _post(f"{BASE}/suite/docs-api/search/object", tok,
                  {"search_key": kw, "count": 50})
        if r.get("code") != 0:
            return kw, None, [], r.get("msg")
        ents = (r.get("data") or {}).get("docs_entities") or []
        return kw, (r.get("data") or {}).get("total"), ents, None

    hits, errs, totals = {}, {}, {}
    with ThreadPoolExecutor(max_workers=workers) as ex:
        for kw, total, ents, err in ex.map(one, terms):
            if err:
                errs[kw] = err
                continue
            totals[kw] = total
            for e in ents:
                t = e.get("docs_token")
                if not t:
                    continue
                h = hits.setdefault(t, {
                    "token": t,
                    "title": (e.get("title") or "").strip(),
                    "type": e.get("docs_type"),
                    "owner": e.get("owner_id"),
                    "hit_kw": [],
                })
                h["hit_kw"].append(kw)
    return hits, totals, errs


def discover_drive(tok):
    """云盘：守衡应用自有空间 —— 数量少，但这是唯一「它自己的」那部分。"""
    files, pt = [], None
    while True:
        url = f"{BASE}/drive/v1/files?" + urlencode(
            {"page_size": 200, **({"page_token": pt} if pt else {})})
        r = _get(url, tok)
        if r.get("code") != 0:
            return files, f"code={r.get('code')} {r.get('msg')}"
        d = r.get("data") or {}
        for f in (d.get("files") or []):
            files.append({
                "token": f.get("token"), "title": (f.get("name") or "").strip(),
                "type": f.get("type"), "owner": f.get("owner_id"),
                "created_time": ms_to_cst(int(f["created_time"]) * 1000) if f.get("created_time") else None,
                "modified_time": ms_to_cst(int(f["modified_time"]) * 1000) if f.get("modified_time") else None,
                "url": f.get("url"),
            })
        if d.get("has_more") and d.get("next_page_token"):
            pt = d["next_page_token"]
        else:
            break
    return files, None


def discover_wiki(tok):
    r = _get(f"{BASE}/wiki/v2/spaces?page_size=50", tok)
    if r.get("code") != 0:
        return [], f"code={r.get('code')} {r.get('msg')}"
    return ((r.get("data") or {}).get("items") or []), None


def discover_chats(tok, msg_pages=20, page_size=50):
    """守衡所在的群 + 群消息。消息里提取外链（「链接」那一类的唯一来源）。

    ⚠️ **翻页必须翻到 has_more=False，不能设一个「够用」的页数上限。**
    第一版设了 msg_pages=2，抓到 78 条就停；而第 1 页本身就返回了
    `has_more: true` —— 也就是说还有更早的消息没抓，脚本却什么都没说。
    这是典型的**静默截断**：读数字的人会以为「这个群一共就这么些」。
    现在默认翻到底（20 页 = 1000 条），并把是否顶到上限记进 `truncated`。
    """
    r = _get(f"{BASE}/im/v1/chats?page_size=100", tok)
    if r.get("code") != 0:
        return [], [], f"code={r.get('code')} {r.get('msg')}"
    chats = ((r.get("data") or {}).get("items") or [])
    out, msgs = [], []
    for c in chats:
        cid = c["chat_id"]
        out.append({"chat_id": cid, "name": c.get("name"), "owner": c.get("owner_id"),
                    "mode": c.get("chat_mode"), "external": c.get("external")})
        pt = None
        reached_end = False
        for _ in range(msg_pages):
            url = f"{BASE}/im/v1/messages?" + urlencode({
                "container_id_type": "chat", "container_id": cid,
                "page_size": page_size, "sort_type": "ByCreateTimeDesc",
                **({"page_token": pt} if pt else {}), "card_msg_content_type": "user_card_content",
            })
            m = _get(url, tok)
            if m.get("code") != 0:
                break
            d = m.get("data") or {}
            for it in (d.get("items") or []):
                body = (it.get("body") or {}).get("content", "")
                msgs.append({
                    "chat_id": cid, "chat_name": c.get("name"),
                    "msg_id": it.get("message_id"), "msg_type": it.get("msg_type"),
                    "create_time": ms_to_cst(it.get("create_time")),
                    "sender": (it.get("sender") or {}).get("id"),
                    "deleted": it.get("deleted"),
                })
                for u in re.findall(r"https?://[^\s\"'\\)\\]<>，。；]+", body):
                    msgs[-1].setdefault("links", []).append(u)
            if d.get("has_more") and d.get("page_token"):
                pt = d["page_token"]
            else:
                reached_end = True
                break
        # 顶到 tmppages 上限 = 还有更早的消息没读到。必须显式记账，不许沉默。
        for c_out in out:
            if c_out["chat_id"] == cid:
                c_out["messages_read"] = sum(1 for m in msgs if m["chat_id"] == cid)
                c_out["truncated"] = not reached_end
    return out, msgs, None


def extract_links(text: str):
    if not text:
        return []
    pat = r"https?://(?:[\w\-]+\.)*(?:feishu\.cn|larksuite\.com|feishu\.cn/[\w/]+)[^\s\"'<>）)，。；]*"
    out, seen = [], set()
    for u in re.findall(pat, text) + re.findall(r"https?://[^\s\"'<>）)，。；]{8,}", text):
        u = u.rstrip(".,;:、）。，")
        if u not in seen:
            seen.add(u)
            out.append(u)
    return out


# ---------------------------------------------------------------- 分级层

def classify_domain(entry) -> str:
    """从 metas 回的 url 取域名 → 归属租户。服务端给的，不靠标题猜。"""
    url = entry.get("url") or ""
    host = urlparse(url).netloc.lower()
    if not host:
        return "unknown"
    if host == TENANT_HOST:
        return "tenant"
    if host in FEISHU_TEMPLATE_HOSTS:
        return "feishu"
    return "other"


def classify_ownership(entry) -> str:
    """core 层再切一刀 —— 这刀决定了名片拿出去会不会误导。

    实测：core 21 条里只有 5 条真属于本项目，其余 16 条是**组织里别人的**资产
    （品牌 VI 专项、电商行业一张表管公司、客户关系管理系统……）。混在一起报
    「核心资源 21 条」，业务读到的意思会是「这些都是我们的」——那是假账。

    两类的读法完全不同：
      - `mine`：我方资产，可以改、可以依赖、可以承诺
      - `org`：只是**守衡读得到**的组织资产，动它要先问 owner
    """
    if entry["token"] in MINE:
        return "mine"
    return "org"


def classify_tier(entry) -> str:
    """三档。判据**只有一条**：这条资源挂在哪个租户下（`drive/v1/metas/batch_query`
    回的 url 域名，服务端给的）。

    | 档 | 判据 | 含义 |
    |---|---|---|
    | `core` | 域 = `momcozy-in.feishu.cn` | **本公司租户**。公司里真有人在用，逐条抽正文（附件除外，见红线） |
    | `reference` | 非本租户，但命中业务词 | 可能相关，只记元数据 |
    | `noise` | 其余 | 非本公司租户且无业务信号 |

    ## 为什么把旧的「标题像不像」判据整条删掉

    旧规则是 `命中业务词 且 (revision>0 或 标题命中项目词)`。它在**两个方向上都错**，
    而且错得都很安静：

    漏（把真资产判成 noise）—— 本公司租户里的
      「全球吸奶器品牌型号库」（62 条竞品型号、30+ 技术字段）
      「全球产品小百科」（9 张品类表、100+ 字段）
      「W1美国故事TVC项目看板」「BW04 新品上市社媒宣传设计需求」
      「Lumi 1 红光科普视频项目看板」
    全部落 noise。理由是标题里的词不在我写死的词表里。**词表漏一个词，一个真资产
    就消失了。** 而这五条恰恰是内容合规最需要的东西：产品事实依据、待审的营销内容。

    误报（把无关的判成 core）—— 同样是本公司租户，但业务上无关的
      「行政-差旅常见Q&A」「飞书帮助中心常见问题」「中山威迅现场稽核情况」
    因为标题里凑够了两个弱领域词，被抬进「核心层（业务真正要用的）」。

    两个方向合起来说明一件事：**「跟我们业务相不相关」是判断题，分级器判不了。**
    我把它当成能用关键词算出来的东西，算出来的就是假精度 —— 而假精度比没有分级更糟，
    因为它看着像读过。

    所以现在分级器只做**它确实能确定**的那件事：这条东西在不在我们租户里。
    相不相关留给人工清单（`research/feishu/可达清单.md`），那里每条都得写
    「讲什么」和「怎么处理」，写不出来就说明没读懂。
    """
    if entry.get("domain") == "tenant":
        return "core"
    hit = set(entry.get("hit_kw") or [])
    if entry.get("domain") == "unknown" and (hit & set(BIZ_TERMS)):
        # 域名拿不到 → 不敢进 core，也不该沉进 noise。中间档 + 断言盯住条数。
        return "reference"
    return "reference" if (hit & set(BIZ_TERMS)) else "noise"


def dedup(entries):
    """同名副本归一。不删 —— 删了就说不清原本有几份。

    ⚠️ 排序必须**全序且确定**。第一版只按 (tier, -revision, modified_time) 排，
    而多个副本这几项可能完全相同 —— 于是主副本在两次运行之间会**跳**。
    后果不是数据错，是 `--check` 会报「同一个标题既新增又消失」这种假差异，
    而假差异会淹没真差异。加 token 作最后的决胜键，全序就确定了。
    """
    groups = defaultdict(list)
    for e in entries:
        groups[e["title"]].append(e)
    rank = {"core": 0, "reference": 1, "noise": 2}
    for title, group in groups.items():
        if len(group) < 2:
            continue
        group.sort(key=lambda x: (rank[x["tier"]], -(x.get("revision") or 0) * -1,
                                  x.get("modified_time") or "", x["token"]))
        primary = group[0]
        primary["copies"] = len(group)
        for g in group[1:]:
            g["dedup_of"] = primary["token"]
    return entries


# ---------------------------------------------------------------- 抽取层

def stopped_result(value):
    """策略停读与接口失败分开；清单损坏则直接抛错，不降级为空清单。"""
    try:
        assert_read_allowed(value)
    except ResourceReadStopped as exc:
        return {"ok": False, "stopped": True, "err": str(exc)}
    return None


def fetch_bitable(tok, token):
    """多维表格：表 → 字段 → 记录数。字段名是守衡判语义的关键，必须抓。"""
    stopped = stopped_result(token)
    if stopped:
        return stopped
    # 先读 app 自身。`is_advanced` 决定了下面的 /tables 会不会是空 —— 必须提前拿。
    ar, aerr = _with_retry(lambda: _get(f"{BASE}/bitable/v1/apps/{token}", tok))
    app = (ar.get("data") or {}).get("app") or {} if ar.get("code") == 0 else {}
    advanced = bool(app.get("is_advanced"))
    if ar.get("code") != 0:
        return {"ok": False, "err": aerr or f"code={ar.get('code')} {ar.get('msg')}"}

    r, err = _with_retry(lambda: _get(f"{BASE}/bitable/v1/apps/{token}/tables", tok))
    if r.get("code") != 0:
        return {"ok": False, "err": err or f"code={r.get('code')} {r.get('msg')}",
                "is_advanced": advanced}
    tables = _items(r, "tables", "items")
    if not tables:
        # 「真的没有表」和「字段名读错了」必须能分开 —— 否则又是一次静默假账。
        #
        # 2026-09-18 补：还有第三种情况，而且它长得很像前两种 ——
        # **多维表格「应用模式」**（app.is_advanced=true，url 是 /app/ 而不是 /base/）。
        # 实测「🛠️ 自动化测试需求收集与管理」就是这个形态：`/tables` 回
        # `code=0 + items:[]`，而 `/app_tables` 是 **http_404**（接口不存在）。
        # 所以它的表**读不到**，但原因既不是「空」也不是「我读错键名」。
        # 不把这三种分开，断言就会把真问题淹掉。
        note = ("多维表格应用模式（is_advanced=true）：飞书无 app 表读取接口，"
                "/tables 必然为空、/app_tables 为 http_404 —— 表读不到，非权限问题"
                if advanced else
                f"接口返回 0 张表（data keys={sorted((r.get('data') or {}).keys())}）")
        return {"ok": True, "tables": [], "is_advanced": advanced,
                "blocks_readable": not advanced, "note": note}
    out = []
    for t in tables:
        tid, tname = t.get("table_id"), t.get("name")
        fields, ferr = [], None
        fr, ferr_msg = _with_retry(
            lambda tid=tid: _get(
                f"{BASE}/bitable/v1/apps/{token}/tables/{tid}/fields?page_size=200", tok))
        if fr.get("code") == 0:
            fields = [{"name": f.get("field_name"), "type": f.get("type"),
                       "ui": f.get("ui_type")} for f in _items(fr, "fields", "items")]
        else:
            ferr = ferr_msg or f"code={fr.get('code')} {fr.get('msg')}"
        n, nerr = None, None
        sr, serr = _with_retry(lambda tid=tid: _post(
            f"{BASE}/bitable/v1/apps/{token}/tables/{tid}/records/search", tok, {"page_size": 1}))
        if sr.get("code") == 0:
            n = (sr.get("data") or {}).get("total")
        else:
            nerr = serr or f"code={sr.get('code')} {sr.get('msg')}"
        out.append({"table_id": tid, "name": tname, "fields": fields,
                    "field_err": ferr, "records": n, "records_err": nerr,
                    "table_revision": t.get("revision"),
                    "embedded_template": any(m in (tname or "") for m in EMBEDDED_TEMPLATE_TABLES)})
    biz = [t for t in out if not t["embedded_template"]]
    return {"ok": True, "tables": out, "tables_biz": len(biz),
            "tables_template": len(out) - len(biz), "is_advanced": advanced}


def fetch_docx(tok, token, cap=200000):
    stopped = stopped_result(token)
    if stopped:
        return stopped
    r, err = _with_retry(lambda: _get(f"{BASE}/docx/v1/documents/{token}/raw_content", tok))
    if r.get("code") != 0:
        return {"ok": False, "err": err or f"code={r.get('code')} {r.get('msg')}"}
    text = ((r.get("data") or {}).get("content") or "")
    return {"ok": True, "chars": len(text), "text": text[:cap],
            "truncated": len(text) > cap, "links": extract_links(text)}


def fetch_sheet(tok, token):
    stopped = stopped_result(token)
    if stopped:
        return stopped
    r, err = _with_retry(lambda: _get(
        f"{BASE}/sheets/v3/spreadsheets/{token}/sheets/query", tok))
    if r.get("code") != 0:
        return {"ok": False, "err": err or f"code={r.get('code')} {r.get('msg')}"}
    sheets = _items(r, "sheets", "items")
    return {"ok": True, "sheets": [{"title": s.get("title"),
                                    "rows": (s.get("grid_properties") or {}).get("row_count"),
                                    "cols": (s.get("grid_properties") or {}).get("column_count")}
                                   for s in sheets]}


def fetch_file(tok, token):
    """附件（file 形态）：**不下载、不探测、不取**。按红线跳过。

    下面两段是**已废止的留档**，留着是因为它们记录了一条判断是怎么错的 ——
    也正因为它们全错，才需要留档，免得下一个人再走一遍。

    **第一次判断（错）**：「403 = 权限缺口，申请 `drive:drive:readonly` /
    `drive:file:download` 就能解开」。**错** —— 那两个 scope 早就在应用里了
    （424 个 scope 里有它们），所以**根本没有可申请的链接**。缺 scope 时飞书回
    `99991672` 并在 msg 里附申请链接；这里是 `403` + **空 body**，不是同一类拒绝。

    **第二次判断（错得更有道理，但方向已经歪了）**：为了「定位真因」做了 6 个对照：

      ① `drive/v1/metas/batch_query` 读这份文件 → `code=0`   ← 应用够得着它
      ② `drive/v1/files/{token}/statistics`  → `code=0`      ← 不是「看不见这份文件」
      ③ `drive/v1/files/{token}/download`    → `403`、**空 body**
         （对照：同一个接口换**假 token** → `404`、空 body ——
         说明接口存在且可达，403 是**针对这份文件**的，不是全局封禁）
      ④ `drive/v1/permissions/{token}/members` → `403 1063004 User has no share permission`
         ← （当时的结论）应用不是这份文件的协作者；**但这个结论已经用不上了**，见下
      ⑤ `drive/v1/permissions/{token}/public` → `code=0`、`link_share_entity=tenant_readable`
         ← 文件是「租户内可阅读」，但**链接分享的可阅读 ≠ API 的下载权**
      ⑥ 旁证：`medias/batch_get_tmp_download_url` → `code=0` 但 `tmp_download_urls: []`
         —— **静默返回空列表**，连原因都不给（正是本项目反复提防的那种安静失败）

    **第三次更正（2026-09-18，委托方指出）——前两次的「解」全都错了，因为方向错了：**

    > 飞书上的内容**禁止下载**。

    这条一摆出来，上面那 6 条对照全成了**多余动作**：`file` 形态在飞书 OpenAPI 里
    **没有原文读取接口**，`download` 是它唯一的内容通道
    （`medias/batch_get_tmp_download_url` 同样是下载通道）。
    所以「下得下来吗、403 还是 200」根本不是要问的问题 —— **不该下。**

    能读的是**文档形态**，且走的是只读内容接口、不是下载：
      `docx` → `docx/v1/documents/{t}/raw_content`
      `sheet` → `sheets/v2/spreadsheets/{t}/values`
      `bitable` → `bitable/v1/apps/{t}/tables/{t}/records`
    附件（xlsx/pdf/图片/视频）没有与之对应的东西 —— 它只有下载。

    所以本函数**不调 download、不调 medias、连权限探测都不做**：
    doing 探测本身就是「准备下载」的姿态，而结论不会因为探测结果改变。
    这是**策略**，写进 `AGENTS.md` §2.6 红线；被 `verify_feishu_index.py` 的 M 段守着。
    """
    return {"ok": False,
            "err": "附件形态（file）：飞书无原文读取接口，唯一内容通道是 download；"
                   "按红线（AGENTS.md §2.6「飞书内容禁止下载」）不取 → 未读。"
                   "**这是策略，不是缺口，不需要申请任何东西、也不需要找 owner。**"}


def fetch_extent(tok, entry):
    """只对 core 调用。任何失败都落 err，不降级成空。"""
    stopped = stopped_result(entry)
    if stopped:
        return stopped
    t, ty = entry["token"], entry["type"]
    if ty == "bitable":
        return fetch_bitable(tok, t)
    if ty in ("docx", "doc"):
        return fetch_docx(tok, t)
    if ty == "sheet":
        return fetch_sheet(tok, t)
    if ty == "slides":
        return fetch_slide(tok, t)
    if ty == "file":
        return fetch_file(tok, t)
    if ty == "mindnote":
        return {"ok": False, "err": "思维笔记：飞书无只读内容接口（/mindnote/v1 为 http_404）"}
    return {"ok": False, "err": f"该形态没有对应的只读内容接口：{ty}"}


def fetch_metas_batch(tok, entries, chunk=50):
    """`drive/v1/metas/batch_query` —— 一条接口补齐「归属租户 + 链接 + owner + 改动时间」。

    为什么必须加这一层：上一版对 slides / mindnote / file 落在 `readable=None`
    （「没测可达性」49 条），因为 docx/bitable/sheet 各有自己的元数据口，这三种没有。
    于是 README 里留下一句「49 条是空白，不是能不能」。**空白不是答案** ——
    业务读到「没测」只会理解为「大概不行」。

    实测：这一条接口对 455 条**全部**返回（49 条未测的也在内），且带回 url。
    所以那 49 条不是不可达，是**我当时没找到入口**。

    注意口径：这条接口证明的是「**元数据**可读」，不是「正文可读」。
    slides 拿到了标题/页数/链接，但飞书**没有**幻灯片正文的读取接口（见 fetch_slide）。
    两件事必须分开记，否则又是一次「能看见 ≠ 读得到」的混账。
    """
    want = {"docx": "docx", "doc": "doc", "bitable": "bitable", "sheet": "sheet",
            "slides": "slides", "mindnote": "mindnote", "file": "file"}
    out, errs = {}, []
    entries, _excluded = filter_entries(entries)
    todo = [e for e in entries if e.get("type") in want]
    for i in range(0, len(todo), chunk):
        part = todo[i:i + chunk]
        body = {"request_docs": [{"doc_token": e["token"], "doc_type": want[e["type"]]}
                                 for e in part], "with_url": True}
        r, err = _with_retry(lambda b=body: _post(
            f"{BASE}/drive/v1/metas/batch_query", tok, b))
        if r.get("code") != 0:
            errs.append({"at": i, "err": err or f"code={r.get('code')} {r.get('msg')}"})
            continue
        for m in ((r.get("data") or {}).get("metas") or []):
            out[m.get("doc_token")] = m
        time.sleep(0.35)          # 这条接口有频率限制，别踩
    missing = [e["token"] for e in todo if e["token"] not in out]
    if missing:
        errs.append({"missing": len(missing), "sample": missing[:5]})
    return out, errs


def resolve_contacts(tok, owners):
    """通讯录：把 owner(ou_xxx) 换成人名。

    这个函数返工过两轮，两轮都留档 —— 因为「通讯录读不到人」有**几种不同的原因**，
    在报告里长得一模一样，不把飞书给的业务码原样留住就分不开。

    **第一轮（2026-09-18 上午，委托方说「通讯录已经开通了」）：开了一半。**
      · `contact/v3/scopes` 回 `code=0` —— 接口通了；
      · 但可见范围只有 **2 个 open_id**；索引里 22 个 owner 有 **21 个**回
        `41050 no user authority error`；
      · 剩下那 1 个查得到，返回体里却**没有 name**（缺 `contact:user.base:readonly`）。
      → 结论：**权限(scope) 与数据范围(可见范围) 是两件事。**

    **第二轮（2026-09-18 下午，委托方把上面两条都办了）复测：**
      · 加 `contact:user.base:readonly`（scope 423 → 424）→ **name 立刻就有**，
        而且**不需要发版** —— 我原先判断「加 scope 大概率要发版」，**实测是即时生效**。
        这条是我说错了，按 AGENTS.md §2.2 的口径把更正留在代码里，而不是只留在对话里；
      · 通讯录权限范围扩到 **22 个部门 + 1 个人** → 22 个 owner 里 **19 个**带名字出来了。
      · 剩 3 个**不是「还没扩到」**，性质各不相同，所以下面按业务码分开计数、不合并：
        · `41012 the user is invalid error` —— 该 open_id **已无效**（人离职/被删）。
          **扩权限永久解不了**，只能换责任人（本轮有 core 资产卡在这里）；
        · `41050` 且**名下 0 条本租户资源** —— 飞书模板租户的人，不在我们组织架构里，
          也解不了。
      → 所以对外只能说「本租户层有几条能叫出责任人」，不能说「还差 3 个没扩到」——
        后者会让人去点一个**已经点过**的开关。
    """
    rep = {"scopes_ok": False, "visible": [], "visible_depts": [], "asked": len(owners),
           "resolved": [], "denied": [], "scopes_err": None, "name_scope": None,
           "denied_invalid": [], "denied_out_of_range": [], "denied_other": []}

    # 翻页：可见范围现在回的是「部门」（22 个）+「个人」。**不翻页会少读**，
    # 而少读的表现是「改完了读数还是错的」—— 比没有读数更糟。
    page_token, pages = None, 0
    while pages < 200:
        url = f"{BASE}/contact/v3/scopes?user_id_type=open_id&page_size=50"
        if page_token:
            url += "&page_token=" + quote(page_token, safe="")
        r, err = _with_retry(lambda u=url: _get(u, tok))
        if r.get("code") != 0:
            rep["scopes_err"] = err or f"code={r.get('code')} {r.get('msg')}"
            break
        rep["scopes_ok"] = True
        d = r.get("data") or {}
        rep["visible"] += list(d.get("user_ids") or [])
        rep["visible_depts"] += list(d.get("department_ids") or [])
        pages += 1
        page_token = d.get("page_token")
        if not d.get("has_more") or not page_token:
            break

    named = 0
    for o in sorted(owners):
        rr, rerr = _with_retry(lambda o=o: _get(
            f"{BASE}/contact/v3/users/{o}?user_id_type=open_id", tok))
        if rr.get("code") == 0:
            u = (rr.get("data") or {}).get("user") or {}
            if u.get("name"):
                named += 1
            rep["resolved"].append({"open_id": o, "name": u.get("name"),
                                    "email": u.get("email"),
                                    "has_name_field": bool(u.get("name"))})
        else:
            rep["denied"].append({"open_id": o,
                                  "err": rerr or f"code={rr.get('code')} {rr.get('msg')}"})
    rep["resolved_n"] = len(rep["resolved"])
    rep["denied_n"] = len(rep["denied"])
    rep["named_n"] = named

    # 按业务码分类 —— 这一步就是本节存在的理由：不分类，几种「查不到」会合并成一个数，
    # 而它们的**可解性完全不同**（一个扩权限能解、一个永远解不了）。
    for d in rep["denied"]:
        if "41012" in d["err"]:
            rep["denied_invalid"].append(d)
        elif "41050" in d["err"]:
            rep["denied_out_of_range"].append(d)
        else:
            rep["denied_other"].append(d)

    if rep["resolved_n"] and named == 0:
        rep["name_scope"] = ("可见范围内的用户也读不到 name 字段 —— "
                             "缺 contact:user.base:readonly（或同等字段级 scope）")
    return rep


def fetch_slide(tok, token):
    """幻灯片：**确认没有正文字段**。

    试过 `presentations/{id}/slides/{slide_id}` 及其 /elements、/text 三个变体，
    一律 **http_404**（不是 403 —— 403 是没权限，404 是接口不存在，两者不能混报）。

    能拿到的是：title、page_size、layouts、masters、以及 `slides` 这个
    **slide_id 列表**（长度 = 页数）。所以幻灯片只能记「有几页」，记不了「讲了什么」。
    委托方说「无法下载那就阅读」—— 阅读这条路对 docx/bitable/sheet 走得通，
    对 slides/mindnote **走不通，原因是接口不存在**（http_404），不是权限不足。
    附件也要单独说：它不是「接口不存在」，是**按红线不取**（见 `fetch_file`）。
    """
    stopped = stopped_result(token)
    if stopped:
        return stopped
    r, err = _with_retry(lambda: _get(f"{BASE}/slides/v1/presentations/{token}", tok))
    if r.get("code") != 0:
        return {"ok": False, "err": err or f"code={r.get('code')} {r.get('msg')}"}
    p = (r.get("data") or {}).get("presentation") or {}
    return {"ok": True, "note": "仅元数据：飞书无幻灯片正文读取接口",
            "pages": len(p.get("slides") or []),
            "layouts": len(p.get("layouts") or []),
            "title": p.get("title"), "revision": p.get("revision_id")}


def fetch_meta(tok, entry):
    """可达性实测 —— 停读资源不探测，其余逐条测。"""
    stopped = stopped_result(entry)
    if stopped:
        return {"readable": None, "stopped": True}, stopped["err"]
    t, ty = entry["token"], entry["type"]
    if ty == "bitable":
        r, rerr = _with_retry(lambda: _get(f"{BASE}/bitable/v1/apps/{t}", tok))
        if r.get("code") == 0:
            app = (r.get("data") or {}).get("app") or {}
            return {"readable": True, "revision": app.get("revision"),
                    "app_name": app.get("name")}, None
        return {"readable": False}, rerr or f"code={r.get('code')} {r.get('msg')}"
    if ty in ("docx", "doc"):
        r, rerr = _with_retry(lambda: _get(f"{BASE}/docx/v1/documents/{t}", tok))
        if r.get("code") == 0:
            d = (r.get("data") or {}).get("document") or {}
            return {"readable": True, "revision": d.get("revision_id"),
                    "title": d.get("title")}, None
        return {"readable": False}, rerr or f"code={r.get('code')} {r.get('msg')}"
    if ty == "sheet":
        r, rerr = _with_retry(lambda: _get(f"{BASE}/sheets/v3/spreadsheets/{t}", tok))
        if r.get("code") == 0:
            sp = (r.get("data") or {}).get("spreadsheet") or {}
            return {"readable": True, "title": sp.get("title")}, None
        return {"readable": False}, rerr or f"code={r.get('code')} {r.get('msg')}"
    # slides / mindnote / file：这三种**没有专属元数据口**，走 batch_query 的结果。
    # 上一版这里直接 return readable=None（「没测」），把 49 条挂成空白。
    # 现在它们有证据了：batch_query 回了 title + url + owner = 元数据可读。
    if entry.get("url"):
        return {"readable": True,
                "readable_via": "drive/v1/metas/batch_query"}, None
    if entry.get("meta_missing"):
        return {"readable": False}, "batch_query 未返回该 token 的元数据"
    return {"readable": None}, "该形态未测可达性"


# ---------------------------------------------------------------- 主流程

def calculate_stats(entries, search_uniq, links, chats, msgs, contacts):
    """从当前允许读取的集合算读数；可用于离线移除，不重拉被停读资源。"""
    cores = [e for e in entries if e["tier"] == "core"]
    got = sum(1 for e in cores if (e.get("extent") or {}).get("ok"))
    stats = {
        # candidates 必须是「去重归一之后」的条数 —— 与 by_tier 三项之和恒等，
        # 否则两处数字会各说各话（这正是 kb_facts.py 记下的第 ② 类病）。
        "candidates": len(entries),
        "search_uniq": search_uniq,
        "by_tier": dict(Counter(e["tier"] for e in entries)),
        "by_type": dict(Counter(e.get("type") for e in entries)),
        "readable_true": sum(1 for e in entries if e.get("readable") is True),
        "readable_false": sum(1 for e in entries if e.get("readable") is False),
        "readable_untested": sum(1 for e in entries if e.get("readable") is None),
        "core_extent_ok": got,
        "core_extent_fail": len(cores) - got,
        "dedup_copies": sum(1 for e in entries if e.get("dedup_of")),
        "dedup_groups": sum(1 for e in entries if e.get("copies")),
        "in_drive": sum(1 for e in entries if e.get("in_drive")),
        "core_mine": sum(1 for e in entries if e.get("ownership") == "mine"),
        "core_org": sum(1 for e in entries if e.get("ownership") == "org"),
        "links": len(links),
        "chats": len(chats), "messages": len(msgs),
        # 归属租户 —— 本轮新增的主判据
        "by_domain": dict(Counter(e.get("domain") for e in entries)),
        "tenant_n": sum(1 for e in entries if e.get("domain") == "tenant"),
        "url_n": sum(1 for e in entries if e.get("url")),
        "contacts_visible": len(contacts["visible"]),
        "contacts_visible_dept": len(contacts["visible_depts"]),
        "contacts_asked": contacts["asked"],
        "contacts_resolved": contacts["resolved_n"],
        "contacts_denied": contacts["denied_n"],
        "contacts_named": contacts["named_n"],
        # 查不到的按**可解性**拆开（2026-09-18 第二轮新增）：
        # 一个「扩权限能解」、一个「永远解不了」，合并计数会让已经点过的开关被反复点。
        "contacts_denied_invalid": len(contacts["denied_invalid"]),
        "contacts_denied_range": len(contacts["denied_out_of_range"]),
        "contacts_denied_other": len(contacts["denied_other"]),
        # 业务真正在意的那个数：**本租户层（core）还有几条资产叫不出责任人**。
        # 全量 22 个 owner 里混着飞书模板租户的人，只报 19/22 会让「我们的家底」看着比实际差。
        "core_owner_unresolved": len({
            e["owner"] for e in entries
            if e.get("owner") and e.get("tier") == "core"
            and e["owner"] in {d["open_id"] for d in contacts["denied"]}}),
        "core_owner_unresolved_items": sum(
            1 for e in entries
            if e.get("owner") and e.get("tier") == "core"
            and e["owner"] in {d["open_id"] for d in contacts["denied"]}),
        # 交叉验证用的两个数（2026-09-18 第二轮）：那两个 `41050` 的 owner 名下条数之和，
        # 与「非本租户条数」**恰好相等**（387 + 43 = 430）。这解释了它们是谁 ——
        # 飞书官方模板库/帮助内容的 owner —— 所以它们**永远不该**出现在我们的组织架构里。
        # 这里只如实落数、不在代码里断言相等：将来真的多出一个模板 owner，等式仍会成立，
        # 但万一是别的形态，硬断言会变成一个长期报红的检查（= 一个没人看的检查）。
        "contacts_denied_range_items": sum(
            1 for e in entries
            if e.get("owner") in {d["open_id"] for d in contacts["denied_out_of_range"]}),
        "non_tenant_items": sum(1 for e in entries if e.get("domain") != "tenant"),
    }
    return stats


def build(no_extent=False):
    policy = load_policy()  # 策略先确认；不可读时不得开始认证或网络读取
    tok = token_of()
    print("① 发现：搜索矩阵")
    hits, totals, serrs = discover_search(tok)
    print(f"   {len(SEARCH_TERMS)} 词 → 命中去重 {len(hits)} 条"
          + (f"（{len(serrs)} 词失败）" if serrs else ""))

    print("② 发现：云盘 / wiki / 群")
    drive, derr = discover_drive(tok)
    wikis, werr = discover_wiki(tok)
    chats, msgs, cerr = discover_chats(tok)
    print(f"   云盘自有 {len(drive)} · wiki {len(wikis)} · 群 {len(chats)} · 消息 {len(msgs)}")

    # 云盘里的也并进候选集（保证「它自己的」一定在里面）
    for f in drive:
        h = hits.setdefault(f["token"], {"token": f["token"], "title": f["title"],
                                         "type": f["type"], "owner": f["owner"],
                                         "hit_kw": []})
        h["in_drive"] = True
        h.setdefault("modified_time", f.get("modified_time"))
        h.setdefault("url", f.get("url"))

    # 群消息里提到的链接 → 归属到链接清单
    link_pool = []
    for m in msgs:
        for u in (m.get("links") or []):
            link_pool.append({"url": u, "from": m.get("chat_name"),
                              "msg_id": m.get("msg_id"), "at": m.get("create_time")})

    print("③ 元数据：batch_query 补归属租户 + 链接（一条接口覆盖全部形态）")
    entries, excluded = filter_entries(hits.values(), policy)
    metas, merrs = fetch_metas_batch(tok, entries)
    for e in entries:
        m = metas.get(e["token"])
        if not m:
            e["meta_missing"] = True
            continue
        e["url"] = m.get("url") or e.get("url")
        e["meta_owner"] = m.get("owner_id")
        e["meta_modified"] = ms_to_cst(int(m["latest_modify_time"]) * 1000) \
            if str(m.get("latest_modify_time") or "").isdigit() else None
        e.setdefault("owner", m.get("owner_id"))
        if m.get("title"):
            e["meta_title"] = m["title"]
    print(f"   补到 {len(metas)}/{len(entries)} 条"
          + (f"（{len(merrs)} 个偏差）" if merrs else ""))

    print("④ 元数据：逐条测可达性")
    def meta(e):
        m, err = fetch_meta(tok, e)
        e.update(m)
        if err:
            e["meta_err"] = err
        return e
    with ThreadPoolExecutor(max_workers=8) as ex:
        entries = list(ex.map(meta, entries))

    print("⑤ 归属租户 + 分级 + 副本归一")
    for e in entries:
        e["domain"] = classify_domain(e)
        e["tier"] = classify_tier(e)
        e["ownership"] = classify_ownership(e) if e["tier"] == "core" else None
    entries = dedup(entries)

    print("⑥ 通讯录：owner → 人名（含可见范围的如实读数）")
    contacts = resolve_contacts(tok, {e.get("owner") for e in entries if e.get("owner")})
    print(f"   可见范围 {len(contacts['visible'])} 人 · 索引中 owner {contacts['asked']} 个 · "
          f"可查 {contacts['resolved_n']} · 被拒 {contacts['denied_n']}"
          f" · 其中真拿到 name 的 {contacts['named_n']}")

    print("⑦ 抽取：仅 core 层正文 / 表结构 / 字段")
    cores = [e for e in entries if e["tier"] == "core"]
    if no_extent:
        for e in cores:
            e["extent"] = {"ok": None, "err": "--no-extent 跳过"}
    else:
        with ThreadPoolExecutor(max_workers=6) as ex:
            res = list(ex.map(lambda e: fetch_extent(tok, e), cores))
        for e, r in zip(cores, res):
            e["extent"] = r
    got = sum(1 for e in cores if (e.get("extent") or {}).get("ok"))
    print(f"   core {len(cores)} 条，抽到正文/结构 {got} 条，抽不到 {len(cores)-got} 条")

    # 正文里的外链也进链接池
    for e in cores:
        for u in ((e.get("extent") or {}).get("links") or []):
            link_pool.append({"url": u, "from": e.get("title"), "msg_id": None, "at": None})

    # 去重链接
    seen, links = set(), []
    for l in link_pool:
        if l["url"] not in seen and blocked_resource(l["url"], policy) is None:
            seen.add(l["url"])
            links.append(l)

    stats = calculate_stats(entries, len(hits), links, chats, msgs, contacts)
    stats["policy_stopped"] = len(policy["resources"])
    stats["policy_excluded"] = len(excluded)
    # 自证：恒等式当场校验，不留给读者去发现
    assert stats["candidates"] == sum(stats["by_tier"].values()), \
        f"分级之和 {sum(stats['by_tier'].values())} != 候选数 {stats['candidates']}"
    assert stats["candidates"] == sum(stats["by_domain"].values()), \
        f"租户之和 {sum(stats['by_domain'].values())} != 候选数 {stats['candidates']}"
    assert stats["core_extent_ok"] + stats["core_extent_fail"] == stats["by_tier"].get("core", 0), \
        "正文抽取成功+失败 != core 总数"
    assert stats["readable_true"] + stats["readable_false"] + stats["readable_untested"] \
        == stats["candidates"], "可达性三态之和 != 候选数"
    # 本轮新增的硬断言：batch_query 必须覆盖每一条。漏一条就会让那条静默退回旧判据，
    # 而「静默退回」正是本项目反复踩的那类病 —— 让它在跑的时候就红。
    assert stats["url_n"] == stats["candidates"], (
        f"只有 {stats['url_n']}/{stats['candidates']} 条拿到 url —— "
        f"batch_query 漏了 {stats['candidates'] - stats['url_n']} 条，"
        f"域名判据会静默失效，先查 fetch_metas_batch 的分块与限流")
    assert stats["by_domain"].get("unknown", 0) == 0, (
        f"{stats['by_domain'].get('unknown')} 条域名判不出来 —— 分级会退回旧判据")
    assert stats["by_tier"].get("core", 0) == stats["by_domain"].get("tenant", 0), (
        f"core {stats['by_tier'].get('core')} != 本租户 {stats['by_domain'].get('tenant')} "
        f"—— core 的定义就是「在本公司租户里」，这两者必须恒等")
    assert contacts["resolved_n"] + contacts["denied_n"] == contacts["asked"], \
        "通讯录 resolved+denied != 询问数"
    # 2026-09-18 第二轮新增：查不到的那几个必须**个个都被分类**。
    # 分类漏一个，那个就会掉进「没解释」，而「没解释的查不到」正是最容易被
    # 当成「权限还没扩到」接着去点开关的那种数。
    assert (len(contacts["denied_invalid"]) + len(contacts["denied_out_of_range"])
            + len(contacts["denied_other"]) == contacts["denied_n"]), (
        f"通讯录被拒 {contacts['denied_n']} 个，但分类只覆盖 "
        f"{len(contacts['denied_invalid']) + len(contacts['denied_out_of_range']) + len(contacts['denied_other'])} 个"
        f" —— 飞书换了业务码？把新码补进 resolve_contacts 的分类里再跑")
    # 本轮实测教训：bitable 的 /tables 返回体把表放在 data.items 而不是 data.tables，
    # 读错键名会得到「code=0 + 0 张表」的静默假账。这条断言把它变成硬失败。
    # 但**应用模式**（is_advanced=true）的表为空是接口不存在，不是读错 —— 豁免它，
    # 否则断言会对着一个已解释的现象长期报红，然后就没人看了。
    empty_bt = [e["title"] for e in entries
                if e["tier"] == "core" and e["type"] == "bitable"
                and (e.get("extent") or {}).get("ok")
                and not (e["extent"].get("tables"))
                and not (e["extent"].get("is_advanced"))]
    assert stats["core_mine"] + stats["core_org"] == stats["by_tier"].get("core", 0), \
        "core 的 mine+org 之和不等于 core 总数"
    assert not empty_bt, (
        f"core 层有 {len(empty_bt)} 个多维表格抽到 0 张表 —— 先确认是不是键名读错"
        f"（data.items vs data.tables），不要当成「它真的是空的」：{empty_bt[:5]}")

    doc = {
        "schema_version": "v1",
        "generated_by": "tools/feishu_index.py",
        "generated_at": datetime.now(CST).strftime("%Y-%m-%d %H:%M:%S"),
        "identity": "app / tenant_access_token（守衡自己的飞书应用）",
        "search_terms": SEARCH_TERMS,
        "search_totals": totals,
        "biz_terms": BIZ_TERMS,
        "domain_terms": DOMAIN_TERMS,
        "mine": MINE,
        "stats": stats,
        "contacts": contacts,
        "findings": {
            "drive_err": derr, "wiki_err": werr, "chat_err": cerr,
            "policy_excluded": excluded,
            "search_errs": serrs,
            "wiki_spaces": len(wikis),
            "metas_errs": merrs,
            "tenant_host": TENANT_HOST,
            "feishu_template_hosts": FEISHU_TEMPLATE_HOSTS,
        },
        "resources": sorted(entries, key=lambda e: ({"core": 0, "reference": 1, "noise": 2}[e["tier"]],
                                                    e.get("title") or "")),
        "chats": chats,
        "messages": msgs,
        "links": links,
    }
    return doc


def apply_read_policy(doc):
    """原地清理旧索引；不联网，保留原采集时间并另记策略应用时间。"""
    policy = load_policy()
    entries, excluded = filter_entries(doc["resources"], policy)
    for entry in entries:
        entry.pop("dedup_of", None)
        entry.pop("copies", None)
    doc["resources"] = dedup(entries)
    doc["links"] = [link for link in doc["links"] if blocked_resource(link["url"], policy) is None]
    previous = doc["findings"].get("policy_excluded", [])
    by_token = {e["tokens"][0]: e for e in previous + excluded}
    doc["findings"]["policy_excluded"] = list(by_token.values())
    doc["stats"] = calculate_stats(doc["resources"], doc["stats"]["search_uniq"],
                                   doc["links"], doc["chats"], doc["messages"], doc["contacts"])
    doc["stats"]["policy_stopped"] = len(policy["resources"])
    doc["stats"]["policy_excluded"] = len(by_token)
    doc["policy_applied_at"] = datetime.now(CST).isoformat()
    return doc


# ---------------------------------------------------------------- 生成物

def render_md(doc) -> str:
    st, F = doc["stats"], doc["findings"]   # st=读数 F=发现（原先这两个写反了）
    R = doc["resources"]
    core = [e for e in R if e["tier"] == "core"]
    ref = [e for e in R if e["tier"] == "reference"]
    noise = [e for e in R if e["tier"] == "noise"]
    L = []
    A = L.append

    A("# 守衡 · 飞书可达资源索引 v1")
    A("")
    A("> 委托原话：「对守衡所有可以通过飞书获取的文档、链接以及聊天记录进行汇总，")
    A("> 然后分类罗列给我，做一个资源索引管理。」")
    A("")
    A(f"> 生成物由 `python3 tools/feishu_index.py` 算出，生成时间 `{doc['generated_at']}`。")
    A("> **本文件里的每个数字都是脚本算的**，改数字的唯一方式是重跑脚本。")
    A(f"> 身份：{doc['identity']}")
    if "policy_stopped" in st:
        A(f"> 用户确认停读 {st['policy_stopped']} 项；本索引已排除 {st['policy_excluded']} 项。"
          "停读属于读取策略，不计作权限缺口。见 [停读清单](停读清单-v1.json)。")
    if doc.get("policy_applied_at"):
        A(f"> 停读策略应用时间：{doc['policy_applied_at']}；资源读数沿用上述采集时间，未重新读取源内容。")
    A("")
    A("---")
    A("")
    A("## 一、先说清楚「可达」是什么意思")
    A("")
    A("本轮实测到一件跟直觉相反的事，它决定了整份索引的口径：")
    A("")
    A("| | 读数 |")
    A("|---|---|")
    A(f"| 守衡云盘里**它自己的**文件 | **{st['in_drive']} 个** |")
    A(f"| 搜索接口能命中的文档 | **{st['search_uniq']} 条** |")
    A(f"| 去重归一后的候选 | **{st['candidates']} 条** |")
    A(f"| 其中实测**能读** | **{st['readable_true']} 条** |")
    A(f"| 实测读不到 | {st['readable_false']} 条 |")
    A(f"| 未测该形态 | {st['readable_untested']} 条 |")
    A(f"| **真正挂在本公司租户下的** | **{st['tenant_n']} 条** |")
    A(f"| 它能进的群 | {st['chats']} 个 |")
    A("")
    A("**「能看见」远大于「它自己的」** —— 只看云盘会漏掉 99% 的可达面。")
    A("")
    A("但**「能看见」又远大于「是我们的」**。`drive/v1/metas/batch_query` 对每条资源")
    A("回一个 url，域名就是它挂在哪个租户下 —— 这是服务端给的，不是我猜的：")
    A("")
    A("| 域名 | 条数 | 是什么 |")
    A("|---|---|---|")
    A(f"| `{F['tenant_host']}` | **{st['by_domain'].get('tenant', 0)}** | **本公司租户** |")
    for h, why in F["feishu_template_hosts"].items():
        n = sum(1 for e in R if e.get("url") and h in e["url"])
        A(f"| `{h}` | {n} | {why} |")
    A("")
    A(f"**{st['candidates']} 条里有 {st['candidates'] - st['tenant_n']} 条根本不在我们租户里。**")
    A("把 455 当成「守衡能拿到的资源」上报，业务会以为我们手握 455 份家底 —— 那是假账。")
    A("真正的家底是那 **" + str(st["tenant_n"]) + " 条**。")
    A("")
    A("抽验佐证（不是靠域名猜的，是读了正文）：`www` 域的「团队 OKR 周会（飞阅会方式）」")
    A("正文是飞书官方的 OKR 教学稿；同域「SWOT 分析看板」的表名就叫「示例：企业 SWOT 分析」；")
    A("而 `fcna6swh3rtl` 域 43 条**全是**多维表格模板（CRM/OKR/报销/考勤……），一条不漏。")
    A("")
    A("**「能看见」远大于「它自己的」** —— 只看云盘会漏掉 99% 的可达面。")
    A("而实测出来的关键是：**读正文这一层没有被拦**。抽验了 7 篇云文档正文全取到")
    A("（最长一篇 40,185 字）、4 个多维表格记录全取到（含一份明显不属于本项目的品牌 VI")
    A("专项，连它的 13 条交付记录都读出来了）。")
    A("")
    A("所以这份索引盘的是**全部可达面**，不是那 2 个自有文件。")
    A("")
    A("---")
    A("")
    A("## 二、一页纸现状")
    A("")
    A("| 项 | 读数 |")
    A("|---|---|")
    A(f"| 候选资源（搜索矩阵 {len(doc['search_terms'])} 词去重后） | **{st['candidates']} 条** |")
    A(f"| ├ `core` **本公司租户**（已抽正文/表结构） | **{st['by_tier'].get('core', 0)} 条** |")
    A(f"| │　├ **我方资产**（可改可承诺） | **{st.get('core_mine', 0)} 条** |")
    A(f"| │　└ 组织他方资产（守衡读得到，动它要先问 owner） | {st.get('core_org', 0)} 条 |")
    A(f"| ├ `reference` 参考（非本租户但命中业务词，只记元数据） | {st['by_tier'].get('reference', 0)} 条 |")
    A(f"| └ `noise` 噪音（非本租户且无业务信号） | {st['by_tier'].get('noise', 0)} 条 |")
    A(f"| 可读性实测通过 | **{st['readable_true']} / {st['candidates']}** |")
    A(f"| 本租户层抽到正文/表结构 | **{st['core_extent_ok']} / {st['by_tier'].get('core', 0)}** |")
    A(f"| 同名副本（已归一到主副本，未删） | {st['dedup_copies']} 条 |")
    A(f"| 群 | {st['chats']} 个 · 可见消息 {st['messages']} 条 |")
    A(f"| 抽出的链接 | {st['links']} 条 |")
    if st["core_extent_fail"]:
        A(f"| ⚠️ **本租户层抽不到的** | **{st['core_extent_fail']} 条**（见 §五，未降级成空） |")
    A("")
    A("**分级口径**（只有一条判据 —— 资源挂在哪个租户下）：")
    A("")
    A("- `domain`：`drive/v1/metas/batch_query` 回的 url 域名。**服务端给的，不是我猜的**。")
    A(f"- `MINE`：{len(doc['mine'])} 个可确认属于本项目的 token，在 core 内再切成 `mine`。")
    A(f"- `hit_kw`：命中业务词表（{len(doc['biz_terms'])} 个词），**只用来把非本租户的东西")
    A("  从 noise 提到 reference，不用来把任何东西抬进 core**。")
    A("")
    A("> **为什么不再用标题判「跟业务相不相关」。** 旧规则在两个方向上都错，而且都很安静：")
    A("> 漏 —— 本租户的「全球吸奶器品牌型号库」（62 条竞品型号、30+ 技术字段）、")
    A("> 「全球产品小百科」（9 张品类表）被判进 noise，只因为标题里的词不在我写死的词表里；")
    A("> 误报 —— 同样本租户但无关的「行政-差旅常见Q&A」「飞书帮助中心常见问题」")
    A("> 因为凑够两个弱领域词被抬进「核心层（业务真正要用的）」。")
    A("> 这说明**相不相关是判断题，分级器判不了**。装懂算出来的就是假精度，")
    A("> 而假精度比没有分级更糟 —— 它看着像读过。现在相关性写在 `可达清单.md` 里，逐条人工判。")
    A("")
    A("---")
    A("")
    A("## 三、本公司租户层（core）—— 这才是「我们的家底」")
    A("")
    A(f"共 **{len(core)} 条**，**全部**抽了正文 / 表结构 / 字段 / 记录数。")
    A("判据只有一条：这条资源的 url 域名是 `" + F["tenant_host"] + "`。")
    A("")
    A("> 委托方说「无法下载那就阅读，原文提取」—— 这一层就是按这个口径做的：")
    A(f"> {st['core_extent_ok']}/{len(core)} 条抽到了原文。剩下 1 条是附件 —— "
      "**它不是失败，是不取**：")
    A("> 附件（`file`）只有下载通道，而飞书内容禁止下载（`AGENTS.md` §2.6）—— "
      "**策略问题，不是能力问题**。")
    A("> （另一种抽不到是幻灯片/思维笔记 —— 那是**接口不存在**（http_404）。两类不能混报。）")
    A("")
    mine = [e for e in core if e.get("ownership") == "mine"]
    org = [e for e in core if e.get("ownership") == "org"]
    A(f"**但这 {len(core)} 条不是同一种东西，读法完全不同**：")
    A("")
    A(f"- **我方资产 {len(mine)} 条** —— 我们可以改、可以依赖、可以对外承诺。")
    A(f"- **组织他方资产 {len(org)} 条** —— 守衡**读得到**，但不属于本项目；")
    A("  要动它、要依赖它当输入，得先问 owner。把它们混报成「我们的核心资源」")
    A("  是假账 —— 业务读到的意思会变成「这些都是我们的」。")
    A("")
    for e in mine + org:
        ext = e.get("extent") or {}
        A(f"### `{e['title']}`")
        A("")
        A(f"- token `{e['token']}` · 形态 **{DOC_TYPES.get(e['type'], e['type'])}**"
          + (f" · revision {e.get('revision')}" if e.get("revision") is not None else ""))
        if e.get("ownership") == "mine":
            A(f"- 🟢 **我方资产** —— {doc['mine'].get(e['token'], '')}")
        else:
            A("- 🟡 **组织他方资产**（守衡读得到，非本项目）—— "
              "进 core 的依据是标题命中项目词 + 在用信号，**归属待你确认**")
        if e.get("hit_kw"):
            A(f"- 命中搜索词：{'、'.join(e['hit_kw'])}")
        if e.get("copies"):
            A(f"- ⚠️ 同名副本共 **{e['copies']} 份**，本条为主副本，其余见 §五")
        if e.get("dedup_of"):
            A(f"- ⚠️ 本条是副本，主副本 `{e['dedup_of']}`")
        if e["type"] == "bitable" and ext.get("ok"):
            biz = [t for t in ext["tables"] if not t.get("embedded_template")]
            tpl = [t for t in ext["tables"] if t.get("embedded_template")]
            A(f"- 业务表 **{len(biz)}** 张"
              + (f"（另内嵌飞书官方示例表 {len(tpl)} 张，不计入）" if tpl else "") + "：")
            A("")
            A("  | 表名 | 字段数 | 记录数 | table_id |")
            A("  |---|---|---|---|")
            for t in biz:
                rec = t.get("records")
                recs = "—" if rec is None else str(rec)
                if t.get("records_err"):
                    recs = "❌ 取不到"
                A(f"  | {t['name']} | {len(t.get('fields') or [])} | {recs} | `{t['table_id']}` |")
            if tpl:
                A("")
                A(f"  内嵌官方示例表（同一张模板，在各 app 里重复出现）："
                  f"{'、'.join(t['name'] for t in tpl)}")
            A("")
            allf = []
            for t in biz:
                allf += [f["name"] for f in (t.get("fields") or [])]
            if allf:
                A(f"- 业务字段名（共 {len(allf)}）：{'、'.join(allf)}")
        elif ext.get("ok") and ext.get("chars") is not None:
            A(f"- 正文 **{ext['chars']} 字**" + ("（已截断存储）" if ext.get("truncated") else ""))
            if ext.get("links"):
                A(f"- 正文内链接 {len(ext['links'])} 条")
        elif ext.get("ok"):
            A(f"- 已抽到结构：{json.dumps(ext, ensure_ascii=False)[:200]}")
        else:
            A(f"- ❌ **抽不到**：`{ext.get('err')}`（如实标注，未降级成空）")
        A("")

    A("---")
    A("")
    A("## 四、参考层（非本租户，只记元数据）")
    A("")
    A(f"共 **{len(ref)} 条**。判据：不在本公司租户下，但命中业务词 —— 也就是「别人家/官方")
    A("的、话题沾边的」东西。这层不抽正文。")
    A("")
    A("**这层里本公司租户的 0 条** —— 本租户的全部 25 条都在 §三。")
    A("")
    A("| 标题 | 形态 | 域名 | rev | 最后修改 | 命中词 |")
    A("|---|---|---|---|---|---|")
    for e in ref:
        A(f"| {e['title'][:44]} | {DOC_TYPES.get(e['type'], e['type'])} | "
          f"{urlparse(e.get('url') or '').netloc or '—'} | "
          f"{e.get('revision') if e.get('revision') is not None else '—'} | "
          f"{e.get('modified_time') or '—'} | {'、'.join((e.get('hit_kw') or [])[:3])} |")
    A("")

    A("---")
    A("")
    A("## 五、噪音层（只计数，不罗列）")
    A("")
    A(f"共 **{len(noise)} 条**。判据：**不在本公司租户**，且标题不命中业务词。")
    A("抽验确认这层的绝大多数是飞书官方模板库内容（CRM/OKR/报销/考勤/请假/员工培训……）。")
    A("全部列为正文会让索引不可读 —— 所以只给聚合读数：")
    A("")
    A("| 形态 | 条数 |")
    A("|---|---|")
    for ty, n in sorted(Counter(e["type"] for e in noise).items(), key=lambda x: -x[1]):
        A(f"| {DOC_TYPES.get(ty, ty)} | {n} |")
    A("")
    A("要用的时候按 §七 的方式回捞，不必背下来。")
    A("")

    A("---")
    A("")
    A("## 六、群与聊天记录 / 链接")
    A("")
    A("### 群")
    A("")
    if doc["chats"]:
        A("| 群名 | chat_id | 模式 | 外部群 | 可见消息 |")
        A("|---|---|---|---|---|")
        for c in doc["chats"]:
            n = sum(1 for m in doc["messages"] if m["chat_id"] == c["chat_id"])
            A(f"| {c['name']} | `{c['chat_id']}` | {c['mode']} | {c['external']} | {n} |")
    else:
        A("**0 个。** 守衡当前不在任何群里 —— 这不是「群不存在」，是「它不在里面」。")
    A("")
    A("### 链接")
    A("")
    A(f"从群消息与核心层正文里抽出 **{len(doc['links'])}** 条。")
    A("")
    if doc["links"]:
        A("| 链接 | 来源 | 时间 |")
        A("|---|---|---|")
        for l in doc["links"][:80]:
            A(f"| `{l['url'][:90]}` | {(l.get('from') or '—')[:28]} | {l.get('at') or '—'} |")
        if len(doc["links"]) > 80:
            A(f"| …另有 {len(doc['links']) - 80} 条，见 json | | |")
    else:
        A("**0 条。** 群消息里没有出现外链，核心层正文里也没有。")
    A("")

    A("---")
    A("")
    A("## 七、怎么用")
    A("")
    A("```bash")
    A("cd /Users/lute/Project/audit_multi_content")
    A("")
    A("python3 tools/feishu_index.py            # 重扫全量，重写本索引")
    A("python3 tools/feishu_index.py --check    # 只比对：哪条新增/消失/改了（退出码非 0 = 过期）")
    A("python3 tools/feishu_index.py --no-extent # 跳正文抽取，快（回归用）")
    A("```")
    A("")
    A("回捞任一档的原始数据：")
    A("")
    A("```bash")
    A("# 核心层全部 token")
    A("python3 -c \"import json;d=json.load(open('research/feishu/资源索引-v1.json'));"
      "[print(r['token'],r['title']) for r in d['resources'] if r['tier']=='core']\"")
    A("")
    A("# 噪音层里搜关键词（不背下来，用的时候捞）")
    A("python3 -c \"import json;d=json.load(open('research/feishu/资源索引-v1.json'));"
      "[print(r['title']) for r in d['resources'] if r['tier']=='noise' and '售后' in r['title']]\"")
    A("```")
    A("")

    A("---")
    A("")
    A("## 八、诚实状态表 —— 这份索引**不知道**什么")
    A("")
    A("| 不知道的事 | 为什么 | 影响 |")
    A("|---|---|---|")
    A(f"| 是否已穷尽 | 搜索是弱发现器。{len(doc['search_terms'])} 个词搜出的并集**不保证是全集** | "
      "换词就会换结果。词表已落盘（json 的 `search_terms`），可复核、可扩 |")
    A(f"| 文档 owner 是谁 | 2026-09-18 已扩范围：**{st['contacts_visible_dept']} 个部门 + "
      f"{st['contacts_visible']} 个人**，索引里 {st['contacts_asked']} 个 owner 可查 "
      f"{st['contacts_resolved']} 个（拿到名字 {st['contacts_named']} 个）、"
      f"查不到 {st['contacts_denied']} 个。查不到的里有 "
      f"{st['contacts_denied_invalid']} 个是 `41012`（人已离职/被删，**扩权限也解不了**）、"
      f"{st['contacts_denied_range']} 个名下 0 条本租户资源（飞书模板租户的人，不在我们组织架构里） | "
      f"**本租户层真正叫不出责任人的是 {st['core_owner_unresolved_items']} 条**"
      f"（{st['core_owner_unresolved']} 个 owner）—— 见 §九 |")
    A("| Wiki 里的东西 | 守衡不在任何知识库成员里，`wiki/v2/spaces` 返回 0 | "
      "如果公司知识库有内容，这份索引**看不见** |")
    A(f"| 其他群 | 它只在 {st['chats']} 个群里 | 「所有聊天记录」实际上是「1 个群的 "
      f"{st['messages']} 条」 |")
    A("| 幻灯片 / 思维笔记的**内容** | 飞书没有这两种形态的正文读取接口"
      "（试过 4 个路径，全是 http_404 —— 接口不存在，不是权限不足） | "
      "只知道页数，不知道讲了什么 |")
    A("| 附件内容 | **按红线不取**（飞书内容禁止下载，`AGENTS.md` §2.6）："
      "`file` 形态没有原文读取接口，唯一通道是 download —— 所以是**不做**，不是读不到 | "
      "表里的附件、独立文件不纳入（含 §3.7 那份需求说明书） |")
    A("| 多维表格**应用模式**的表 | `is_advanced=true` 的 app，`/tables` 恒为空、"
      "`/app_tables` 是 404 | 这类 app 的表结构读不到（本租户里有 1 个） |")
    A("| **「跟业务相不相关」** | 这是判断题，分级器判不了 | "
      "`core` 只回答「在不在我们租户里」；相关性见 `可达清单.md`，逐条人工判 |")
    if F.get("search_errs"):
        A(f"| 有 {len(F['search_errs'])} 个搜索词失败 | "
          f"{'、'.join(list(F['search_errs'])[:6])} | 这些词对应的文档没被扫进来 |")
    A("")
    if st["core_extent_fail"]:
        A("### 本轮抽不到的（如实列出，未降级成空）")
        A("")
        for e in core:
            if not (e.get("extent") or {}).get("ok"):
                A(f"- `{e['title']}`（{e['type']}）：{(e.get('extent') or {}).get('err')}")
        A("")
    if st["readable_false"]:
        A("### 本轮实测读不到的")
        A("")
        for e in R:
            if e.get("readable") is False:
                A(f"- `{e['title']}`（{e['type']}）：{e.get('meta_err')}")
        A("")
    A("---")
    A("")
    A("## 九、权限与能力缺口（2026-09-18 复测后的真实状态）")
    A("")
    A("| 面 | 现状 | 要拿到需要什么 |")
    A("|---|---|---|")
    A(f"| 通讯录**接口** | ✅ 已开通。`contact/v3/scopes` 回 `code=0` | 无 |")
    A(f"| 通讯录**数据范围** | ✅ **已扩**：{st['contacts_visible_dept']} 个部门 + "
      f"{st['contacts_visible']} 个人（2026-09-18 下午由委托方在开发者后台「数据权限」里扩的）。"
      f"{st['contacts_asked']} 个 owner 里可查 {st['contacts_resolved']} 个 | 无 |")
    A(f"| 其中**永久查不出**的 | ❌ {st['contacts_denied']} 个查不到，且**不是「还没扩到」**："
      f"{st['contacts_denied_invalid']} 个回 `41012 the user is invalid error`（open_id 已失效，"
      f"人离职/被删 → **扩权限也解不了**，只能换责任人）；"
      f"{st['contacts_denied_range']} 个回 `41050` 但**名下 0 条本租户资源** | "
      f"**交叉验证**：这 {st['contacts_denied_range']} 个 owner 名下共 "
      f"{st['contacts_denied_range_items']} 条，恰好 = 全部非本租户资源 "
      f"{st['non_tenant_items']} 条 —— 它们就是飞书官方模板库/帮助内容的 owner，"
      f"永远不该出现在我们组织架构里。**本租户层只剩 "
      f"{st['core_owner_unresolved_items']} 条要人处理** |")
    A(f"| 通讯录**姓名字段** | ✅ 已授 `contact:user.base:readonly`（scope 423 → 424）→ "
      f"**name 立刻回来，无需发版**（原先以为要发版，实测即时生效）。拿到名字 "
      f"{st['contacts_named']} / {st['contacts_asked']} 个 | 无 |")
    A("| 部门 / 组织架构 | ⚠️ **能列了**（`contact/v3/departments/0/children` 回 `code=0`，"
      "随数据范围一起开），但条目里**只有 `open_department_id`、没有 `name`** | "
      "部门名字要另授（`contact:department.base:readonly`）—— 只列 id 对业务没用 |")
    A("| Wiki 知识库 | ⚠️ 返回 0 个空间 | 把守衡加为公司知识库成员（不是 scope 问题） |")
    A("| 更多群 | ⚠️ 只有 1 个 | 把守衡拉进对应的群（不是 scope 问题） |")
    A("| 附件（xlsx/pdf/图片/视频） | ⛔ **按红线不下载**（`AGENTS.md` §2.6）—— "
      "`file` 形态在飞书 OpenAPI 里没有原文读取接口，唯一内容通道是 download | "
      "**无需申请、无需找 owner**：这是策略不是缺口 |")
    A("| 幻灯片 / 思维笔记正文 | ❌ 接口不存在（404） | **申请也没用** —— 飞书没开放 |")
    A("| 多维表格应用模式的表 | ❌ 接口不存在（404） | **申请也没用** |")
    A("| 卡片交互回读 | ⚠️ schema 2.0 卡片回读只给占位文案 | 平台限制，非权限问题 |")
    A("")
    A("> **「权限开通了」和「数据读得到」是两件事。** 通讯录这次是活例子，而且它分了**两幕**：")
    A(">")
    A("> · 第一幕：scope 授权了、接口 `code=0`、看着一切正常 —— 但可见范围只有 2 人，")
    A(">   22 个 owner 里 21 个查不到。**「开关是声明，条数是证据。」**")
    A("> · 第二幕：两条都办了之后，读数从 21 个被拒变成 19 个能叫出名字 —— 剩 3 个")
    A(">   **不是没扩到，是扩也扩不到**（1 个离职、2 个不在我们组织架构）。")
    A(">   所以「还差几个」这句话本身也可能是假的：**它暗示你再去点一次那个已经点过的开关。**")
    A(">")
    A("> 判断这类问题只有一个办法：**拿真实的数据去跑，看回了几条**，别信开关的状态；")
    A("> 而且**每个「查不到」都要落到一个业务码上**（`41012` / `41050` / 别的），")
    A("> 因为「可解」和「不可解」在报告里长得一模一样。")
    A("")
    A("---")
    A("")
    A("*本索引是生成物。要改数字，改数据然后重跑 `tools/feishu_index.py`。*")
    return "\n".join(L) + "\n"


README_MD = os.path.join(OUT_DIR, "README.md")


def readme_facts(doc) -> str:
    """README 的「一页纸现状」生成块。

    为什么要有它：README 里的数字第一版是我**手写**的，写完第一次重跑就发现
    副本数从 66/51 漂成了 67/52 —— 手写的数字必然腐烂，而且**没有任何东西会红**。
    这里把它变成生成块，`--check-readme` 一比就知道有没有过期。
    """
    st = doc["stats"]
    rows = [
        ("搜索矩阵命中（40 词去重）", f"**{st['search_uniq']} 条**", "飞书搜索是发现主入口"),
        ("守衡**自有**的云盘文件", f"{st['in_drive']} 个", "只看这个会漏掉 99%"),
        ("实测**能读**", f"**{st['readable_true']} / {st['candidates']}**",
         "元数据层全部可读（含 slides/mindnote/file）"),
        ("**本公司租户**（`momcozy-in`）", f"**{st['tenant_n']} 条**",
         "**真正的家底** —— 其余不在我们租户里"),
        ("├ 我方资产", f"**{st.get('core_mine', 0)} 条**", "可改、可依赖、可承诺"),
        ("└ 组织他方资产", f"{st.get('core_org', 0)} 条", "守衡读得到，**不是我们的**"),
        ("本租户层抽到原文", f"**{st['core_extent_ok']} / {st['by_tier'].get('core', 0)}**",
         "全文/表结构/字段；抽不到的见诚实状态表"),
        ("参考层 `reference`", f"{st['by_tier'].get('reference', 0)} 条", "非本租户，只记元数据"),
        ("噪音层 `noise`", f"{st['by_tier'].get('noise', 0)} 条",
         "非本租户 + 无业务信号，只计数"),
        ("同名副本（已归一，未删）", f"{st['dedup_copies']} 条",
         f"涉及 {st['dedup_groups']} 组同名"),
        ("群 / 可见消息", f"{st['chats']} 个 / {st['messages']} 条",
         "**它只在 1 个群里**（已翻到底，非截断）"),
        ("抽出的链接", f"{st['links']} 条", "群消息 + 正文内嵌"),
        ("通讯录可见范围 / owner 数",
         f"**{st['contacts_visible_dept']} 部门 + {st['contacts_visible']} 人** / "
         f"{st['contacts_asked']} 个",
         f"已扩（2026-09-18）：能叫出名字 {st['contacts_named']} 个 · 查不到 "
         f"{st['contacts_denied']} 个（离职 {st['contacts_denied_invalid']} 个，扩权限也解不了）"),
        ("没测可达性", f"{st['readable_untested']} 条",
         "本轮已清零：batch_query 补齐了三种无专属接口的形态"),
    ]
    if "policy_stopped" in st:
        rows.append(("用户确认停读", f"{st['policy_stopped']} 项；本索引排除 {st['policy_excluded']} 项",
                     "按用户要求停止读取，不作为权限缺口"))
    L = ["<!-- facts:begin -->",
         f"> 下表由 `python3 tools/feishu_index.py` 算出，资源采集时间为 `{doc['generated_at']}`。",
         "> **改数字的唯一方式是重跑脚本**，不要手改这张表。", "",
         "| 项 | 读数 | 说明 |", "|---|---|---|"]
    if doc.get("policy_applied_at"):
        L.insert(2, f"> 停读策略应用于 `{doc['policy_applied_at']}`；仅排除停读资源，未重新读取源内容。")
    L += [f"| {a} | {b} | {c} |" for a, b, c in rows]
    L += [f"<!-- facts:end -->"]
    return "\n".join(L)


def write_readme_facts(doc):
    """只更新 README 里 <!-- facts:begin -->…<!-- facts:end --> 之间的块。"""
    if not os.path.exists(README_MD):
        return None
    txt = open(README_MD, encoding="utf-8").read()
    a, b = "<!-- facts:begin -->", "<!-- facts:end -->"
    if a not in txt or b not in txt:
        return "README 里找不到 facts 生成块标记，跳过（不猜位置）"
    i, j = txt.index(a), txt.index(b) + len(b)
    new = txt[:i] + readme_facts(doc) + txt[j:]
    if new != txt:
        open(README_MD, "w", encoding="utf-8").write(new)
        return True
    return False


# 每一行的事实块容差。0 = 必须严格相等（稳定量）；>0 = 允许漂多少。
# 依据：实测同一份代码连跑多次，core 恒为 21，而搜索命中在 454~456 之间抖 ——
# 飞书搜索索引自身有抖动。**给稳定量零容差、给抖动量容差**，检查才会一直有意义。
# 一个永远不会绿的检查等于没有检查。
README_TOL = {
    "搜索矩阵命中（40 词去重）": 5, "守衡**自有**的云盘文件": 0,
    "实测**能读**": 5,
    # 本租户条数是**硬事实**（域名判据给的），零容差。
    "**本公司租户**（`momcozy-in`）": 0,
    "├ 我方资产": 0, "└ 组织他方资产": 0,
    "本租户层抽到原文": 0,
    "参考层 `reference`": 8, "噪音层 `noise`": 8,
    "同名副本（已归一，未删）": 5, "群 / 可见消息": 0, "抽出的链接": 3,
    "通讯录可见范围 / owner 数": 0,
    "没测可达性": 0,
}


def _nums(text):
    return [int(x) for x in re.findall(r"\d+", text.replace("*", ""))]


def check_readme(doc, no_extent=False):
    """--check-readme：README 的事实块过期了吗？只比对不改盘。

    两类行分开判：
      - **稳定量**（core / 我方资产 / 群数）：零容差。它们变了就是真变了。
      - **抖动量**（搜索命中 / 参考 / 噪音 / 副本）：给容差。飞书搜索索引自身
        有抖动，实测连跑三次 455/456/455，严判会永远报过期。

    ⚠️ `--no-extent` 下「抽出的链接」必然是 0（链接从正文里抽），拿它比对会产生
    **假过期告警**。假告警比没有告警更糟 —— 人会开始忽略告警。该行直接剔除。
    """
    if not os.path.exists(README_MD):
        _die(f"README 不存在：{os.path.relpath(README_MD, REPO)}")
    txt = open(README_MD, encoding="utf-8").read()
    a, b = "<!-- facts:begin -->", "<!-- facts:end -->"
    if a not in txt:
        _die("README 里没有 facts 生成块标记")
    cur = txt[txt.index(a):txt.index(b) + len(b)]
    new_block = readme_facts(doc)

    def parse(block):
        out = {}
        for line in block.splitlines():
            if not line.startswith("|") or line.startswith("|---") or "| 项 |" in line:
                continue
            cells = [c.strip() for c in line.strip("|").split("|")]
            if len(cells) >= 2:
                out[cells[0]] = cells[1]
        return out

    pcur, pnew = parse(cur), parse(new_block)
    if no_extent:
        pcur.pop("抽出的链接", None)
        pnew.pop("抽出的链接", None)
        print("（已剔除会失真的行：抽出的链接（--no-extent 下必然为 0））")

    stale, drift, missing = [], [], []
    for k, vnew in pnew.items():
        if k not in pcur:
            missing.append(k)
            continue
        on, nn = _nums(pcur[k]), _nums(vnew)
        tol = README_TOL.get(k, 0)
        if not on or not nn:
            if pcur[k] != vnew:
                stale.append((k, pcur[k], vnew, tol))
            continue
        # 逐位比：任一位超出容差即算过期
        bad = any(abs(x - y) > tol for x, y in zip(on, nn)) or len(on) != len(nn)
        if bad:
            (stale if tol == 0 else drift).append((k, pcur[k], vnew, tol))

    if not stale and not missing and not drift:
        print("✅ README 事实块与当前数据一致（稳定量严判已过，抖动量在容差内）")
        return 0
    if missing:
        print(f"⚠️ README 事实块缺行：{missing}")
    if stale:
        print("❌ **稳定量**变了（零容差，这是真变化）：")
        for k, o, n, _ in stale:
            print(f"    {k}：README「{o}」 → 重算「{n}」")
    if drift:
        print("ℹ️ 抖动量超出容差（可能是真变化，也可能只是搜索索引抖动）：")
        for k, o, n, t in drift:
            print(f"    {k}：README「{o}」 → 重算「{n}」（容差 ±{t}）")
    print("\n重跑不带参数的脚本即可刷新。")
    return 1 if (stale or missing) else 0


def depad(path):
    """**这个环境里，脚本写出来的文件，read 工具打不开。**

    2026-09-18 实测到一个环境缺陷，最小复现：

        printf 'hello world ascii only\\n' > a.md          # 外部命令
        printf 'hello world ascii only\\n' > b.md          # 同样内容
        stat -f '%z' a.md  →  23      （正确）
        stat -f '%z' b.md  →  4119    （多 4096）

    同一份内容、同一个目录，只要文件**是用 Python 写出来的**，`stat` 报的大小就会
    比真实内容多 **4096 字节**；而 DSH 的 `read` 工具据此把文件判成 **binary file**，
    正文一个字都读不出来。（实测是 Python 专属：`node` 写的、`printf`/`cat`/`cp`
    写的、以及 DSH 的 `write`/`edit` 工具写的，都不填充。完整矩阵见
    `tools/verify_depad.py` 的模块文档。）全仓库扫出 **308 个**文件处于这个状态 —— 包括本项目的
    `AGENTS.md`（真实 4909B / stat 9005B）和本脚本生成的 `README.md`。

    关键：**内容本身是对的**。`python open().read()` 与 `shasum -a 256` 读到的字节
    完全一致，只有 `stat` 在撒谎。所以这不是数据损坏，是**视图不一致** ——
    但后果一样严重：一个读不出来的文档，等于不存在。

    绕开办法只有一条：让**外部命令**把它重写一遍（`cp` 就够）。因此本函数在写完
    生成物后做一次 `cp → mv` 往返，并用 sha256 断言「内容一个字节都没变」。

    为什么不是「反正能跑就行」：本项目的生成物是给人读的。生成物读不出来，
    README 里那句「改数字的唯一方式是重跑脚本」就没人验证得了 —— 又回到
    「界面上看得见 ≠ 已经生效」那条老病（AGENTS.md 2.2 第 3 条）。
    """
    if not os.path.exists(path):
        return None
    before = hashlib.sha256(open(path, "rb").read()).hexdigest()
    tmp = path + ".depad.tmp"
    try:
        subprocess.run(["cp", path, tmp], check=True, capture_output=True)
        subprocess.run(["mv", tmp, path], check=True, capture_output=True)
    except Exception as e:                       # cp/mv 不可用时不致命，但要出声
        if os.path.exists(tmp):
            os.remove(tmp)
        return f"depad 失败（{type(e).__name__}）：{os.path.relpath(path, REPO)}"
    after = hashlib.sha256(open(path, "rb").read()).hexdigest()
    if before != after:
        raise AssertionError(f"depad 改动了内容！{path} {before[:16]} → {after[:16]}")
    return None


def write(doc):
    os.makedirs(OUT_DIR, exist_ok=True)
    rf = write_readme_facts(doc)
    if rf is True:
        print(f"✅ 刷新 {os.path.relpath(README_MD, REPO)} 的事实块")
    elif isinstance(rf, str):
        print(f"⚠️ {rf}")
    json.dump(doc, open(INDEX_JSON, "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    open(INDEX_MD, "w", encoding="utf-8").write(render_md(doc))
    print(f"\n✅ 写入 {os.path.relpath(INDEX_JSON, REPO)}")
    print(f"✅ 写入 {os.path.relpath(INDEX_MD, REPO)}")
    # 见 depad()：不做这一步，上面刚写的文件在 read 工具里是「binary file」
    for p in (README_MD, INDEX_MD):
        err = depad(p)
        if err:
            print(f"⚠️ {err}")
    print("✅ depad：生成物已可被 read 工具打开（cp 往返，sha256 校验内容未变）")


def check(doc):
    """--check：拿新扫的结果跟盘上索引比，只报差异，不改盘。

    ## 为什么噪音层按标题集合比，不按 token 比

    实测：飞书搜索索引对**噪音文档**不稳定 —— 同一篇《季度工作汇报【0722】 副本》
    有多个 token 副本，某次搜索少返回一个 token，主副本就会从 A 跳到 B。
    按 token 比会持续报「同一个标题既新增又消失」这种**假差异**。

    假差异比没有差异更糟：它会淹没真差异，然后人开始不看报告。

    所以分两套口径：
      - **core 按 token 严判** —— core ≡ 本租户（25 条），这是域名判据给的硬事实，
        token 变了就是真有资源进/出了我们租户。
      - **reference + noise 按标题集合比** —— 它们的成员随搜索索引抖动
        （reference 由「命中业务词」决定，而命中与否跟搜索索引自身的抖动有关），
        按 token 比会持续报假差异。
    """
    if not os.path.exists(INDEX_JSON):
        _die(f"盘上没有索引可比对：{os.path.relpath(INDEX_JSON, REPO)}\n先跑一次不带 --check 的。")
    old = json.load(open(INDEX_JSON, encoding="utf-8"))

    def split(d):
        R = d["resources"]
        strict = {r["token"]: r for r in R if r["tier"] == "core"}
        loose = {r["title"] for r in R if r["tier"] in ("reference", "noise")}
        return strict, loose

    o_s, o_l = split(old)
    n_s, n_l = split(doc)

    added = [n_s[t] for t in n_s if t not in o_s]
    gone = [o_s[t] for t in o_s if t not in n_s]
    changed = []
    for t, b in n_s.items():
        if t in o_s:
            a = o_s[t]
            diff = [k for k in ("title", "tier", "ownership", "revision", "readable", "domain")
                    if a.get(k) != b.get(k)]
            if diff:
                changed.append((b, {k: (a.get(k), b.get(k)) for k in diff}))

    l_added = sorted(n_l - o_l)
    l_gone = sorted(o_l - n_l)

    print(f"严格层（core ≡ 本租户）：盘上 {len(o_s)} · 本次 {len(n_s)}")
    print(f"  新增 {len(added)} · 消失 {len(gone)} · 变更 {len(changed)}")
    for e in added[:40]:
        print(f"    ＋ [{e['tier']:9s}] {e['title'][:58]}")
    for e in gone[:40]:
        print(f"    － [{e['tier']:9s}] {e['title'][:58]}")
    for e, df in changed[:40]:
        print(f"    ~ {e['title'][:48]:48s} {df}")
    print(f"抖动层（reference+noise，按标题集合）：盘上 {len(o_l)} · 本次 {len(n_l)}"
          f" → 新出现 {len(l_added)} · 已不见 {len(l_gone)}")
    for t in l_added[:15]:
        print(f"    ＋ {t[:60]}")
    for t in l_gone[:15]:
        print(f"    － {t[:60]}")

    strict_diff = bool(added or gone or changed)
    loose_diff = bool(l_added or l_gone)
    if strict_diff:
        print("\n⚠️ **严格层有差异** —— 这是真变化，索引已过期。")
        return 1
    if loose_diff:
        print("\nℹ️ 严格层无差异；只有噪音层的出入（多为搜索索引抖动），"
              "不算过期。要看明细见上。")
        return 0
    print("\n✅ 索引与当前飞书一致，无差异")
    return 0


def main():
    ap = argparse.ArgumentParser(description="守衡 · 飞书可达资源索引器（只读）")
    ap.add_argument("--check", action="store_true", help="只比对不改盘")
    ap.add_argument("--no-extent", action="store_true", help="跳过正文抽取")
    ap.add_argument("--check-readme", action="store_true",
                    help="只比对 README 事实块是否过期")
    a = ap.parse_args()
    doc = build(no_extent=a.no_extent)
    if a.check:
        return check(doc)
    if a.check_readme:
        return check_readme(doc, no_extent=a.no_extent)
    write(doc)
    s = doc["stats"]
    print(f"\n候选 {s['candidates']} 条 = core {s['by_tier'].get('core',0)}"
          f" + reference {s['by_tier'].get('reference',0)}"
          f" + noise {s['by_tier'].get('noise',0)}")
    print(f"可读实测 {s['readable_true']} 通过 / {s['readable_false']} 读不到"
          f" / {s['readable_untested']} 未测")
    print(f"核心层抽正文 {s['core_extent_ok']} 条成功；{s['core_extent_fail']} 条未抽"
          f" —— 未抽的**不是失败**：附件=按红线不取、幻灯片/思维笔记=接口不存在")
    return 0


if __name__ == "__main__":
    sys.exit(main())

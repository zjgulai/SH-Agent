#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""lp_stability.py —— 落地页「正文指纹」的**复现性**实测（B2 · 回答 V4 抛出的那一问）

## 这个脚本为什么存在

`tools/verify_landing.py` 的 **V4** 默认重抓 3 个 URL 做抽检，本轮的运行结果：

    ❌ 提取后正文指纹也在变：一致 2 / 变化 1
       正文级指纹不稳会动摇 ADR-0002，需先查清原因

V4 的问法是对的，但它**只负责把灯点亮，不负责说出原因**（3 个样本也说不出来）。
本脚本把那一问接过来，做三件事：

1. **放大样本**：重抓 N 个 URL，分别比 ① 原始 HTML 的 sha256 ② 提取后正文的 sha256。
2. **定位分歧点**：对每一处不一致，逐字符找出**第一个分歧位置**，并把两侧上下文打出来。
   —— 不满足于「变了」，要说出**变的是哪几个字**。
3. **归因到可枚举的形态**：把分歧片段匹配到一组**波动形态**（评论数 / 价格 / 促销码 / 库存 …）。

## 这一问为什么重要（不是洁癖）

ADR-0002 定的口径是：原始 HTML 的 sha256 会因每次请求唯一的 reqid 与埋点脚本而变，
所以「内容指纹」要建立在**提取后的正文**上。这条推理没错，但它推出的是一个**假设**：

    假设：提取后的正文 → 重抓不变。

本轮实测**推翻了这个假设**：变化的不是 reqid，是**评论数**（`1,835` → `1,836`）。
于是 `ContentUnit.content_key`（契约里写着「只吃正文指纹 —— 页面重渲染后它不变」）
对这类页面**每次观测都会给出一个新的 key**，而它本该回答的是
「这两次看到的是不是同一个东西」。

★ 这不是「指纹算错了」，是**一个从未被实测过的断言**。本项目已出过三次同一形态的事：
  断言写在文档里、代码也按它写了，但**没有一条检查问过它是否成立**。

## 用法

    python3 tools/lp_stability.py                # 重抓 20 个（默认），落盘证据
    python3 tools/lp_stability.py -n 6           # 小样本
    python3 tools/lp_stability.py --analyze-only # 不联网，只对盘上已有证据归因

★ 节流沿批次 C 的结论：**全局 6s 间隔**。第一遍抓取用 1.2s 同域名间隔 → 30.4% 成功；
  续抓改成全局 6s → 100%。这里的样本是故意的联网动作，**不许**为了快而调小。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

import lp_extract as X          # noqa: E402
import lp_fetch as F            # noqa: E402

# ★★ 变更判据**只留一份**，而且它在 `base/change_detect.py`（判据名 `claim-set-v1`，
#   Owner 裁定 A 的落地物）。本脚本原本自带一个 `claim_relevance()` ——
#   同样的取差集逻辑写两遍的后果不是「重复」，是**两份会漂移**，
#   而漂移之后两边仍然各自输出一份看起来完整的结论。
sys.path.insert(0, str(ROOT / "base"))
import change_detect as CD      # noqa: E402

LAND = ROOT / "research" / "landing"
OUT = LAND / "_evidence" / "stability.json"

# ------------------------------------------------------------------ 波动形态

# ★ 这一组不是「猜」出来的，是把实测分歧片段归类后**收敛**出来的形态。
#   每一条都要能指名道姓地说出「它会随什么而变」。
VOLATILE_FORMS = [
    ("评论数", r"Rated\s+[\d.]+\s+out of 5 stars\s*\n?\s*([\d,]+)",
     "买家评价条数 —— 每多一条评价就 +1，与合规判定无关"),
    ("价格", r"(?:US)?\$\s?([\d,]+\.\d{2})",
     "售价 —— 促销/汇率/区域定价变动"),
    ("折扣码", r"[Cc]ode:\s*([A-Z0-9]{3,})",
     "促销码与折扣幅度 —— 营销活动排期"),
    ("库存/余量", r"(\d+)\s+left in stock", "库存余量"),
    ("销量/热度", r"([\d,]+)\+?\s+(?:sold|Sold|bought)", "销量计数"),
    ("倒计时", r"\b(\d{1,2}:\d{2}:\d{2})\b", "页面内倒计时"),
]


def first_diff(a: str, b: str) -> dict:
    """★ 把两侧的差异**收窄到最小变更段**，而不是「从某一点起全都不一样」。

    第一版只找「第一个不同的字符」，然后把两侧各 90/110 字符的窗口打出来 ——
    实测下来 20 个样本里有 **9 个归不了因**，因为真正变的那几个字在窗口之外，
    窗口里显示的是**没变**的上下文。这不是归因能力不够，是**取证方法不对**：

        共同前缀 + 共同后缀 一剪，剩下的就是**逐字变掉的那一段**。

    本函数回三段：`只在新版出现` / `只在旧版出现`（两者之一常为空，即纯增删），
    以及它们在两侧的位置。**不猜形态，先把事实钉死。**
    """
    n, m = len(a), len(b)
    p = 0
    while p < n and p < m and a[p] == b[p]:
        p += 1
    s = 0
    while s < n - p and s < m - p and a[n - 1 - s] == b[m - 1 - s]:
        s += 1
    old_seg = a[p:n - s] if s else a[p:]
    new_seg = b[p:m - s] if s else b[p:]
    return {
        "at": p,
        "只在新版出现": new_seg[:400],
        "只在旧版出现": old_seg[:400],
        "新段长": len(new_seg), "旧段长": len(old_seg),
        "len_old": n, "len_new": m, "delta": m - n,
        "前缀相同": p, "后缀相同": s,
        # 保留原窗口：收窄后的段若仍然很长（结构性改动），窗口能给出上下文
        "old_ctx": a[max(0, p - 60):p + 160],
        "new_ctx": b[max(0, p - 60):p + 160],
    }


def _tokens(s: str) -> list[str]:
    return re.findall(r"[\w\u00c0-\u024f\u4e00-\u9fff$#%.,:/-]+", s or "")


def attribute(d: dict) -> list[dict]:
    """把收窄后的变更段归因到波动形态。

    ★ 两级归因，**第二级不能省**：
      ① 已知形态（评论数 / 价格 / 折扣码 …）—— 给人看的标签；
      ② **逐词差集**（旧段有哪些词、新段有哪些词）—— 给不知道形态的那些用。
      第一版只有 ①，于是「未归因」成了垃圾桶。② 让每一条都至少说得出
      「少了一个 X、多了一个 Y」，哪怕 X 的形态是本次第一次见。
    """
    old_seg, new_seg = d.get("只在旧版出现", ""), d.get("只在新版出现", "")
    out = []
    for name, rx, why in VOLATILE_FORMS:
        mo, mn = re.search(rx, old_seg), re.search(rx, new_seg)
        if mo and mn and mo.group(0) != mn.group(0):
            out.append({"形态": name, "旧": mo.group(0).strip()[:70],
                        "新": mn.group(0).strip()[:70], "$为什么会变": why})
    if out:
        return out

    # ── ② 逐词差集：不依赖形态表 ──────────────────────────────────
    to, tn = _tokens(old_seg), _tokens(new_seg)
    gone = [t for t in to if t not in tn]
    came = [t for t in tn if t not in to]
    if not (gone or came):
        return []
    # 数字型差异单列 —— 它是「会随时间变」的最强信号
    num = [x for x in (gone + came) if re.fullmatch(r"[\d.,$#%]+", x)]
    return [{
        "形态": "数字/计数" if num and len(num) >= max(1, (len(gone) + len(came)) // 2)
                else "文本片段",
        "旧段": old_seg[:120], "新段": new_seg[:120],
        "少了的词": gone[:8], "多了的词": came[:8],
        "$为什么会变": ("**本次未命中已知波动形态**，但两段逐词差集是可核的。"
                        "若同一形态反复出现，应把它补进 `VOLATILE_FORMS` —— "
                        "形态表是长出来的，不是一次想全的。"),
    }]


# ------------------------------------------------------------------ 掩码与合规相关性

# ★★ 这一节回答的是「所以呢」。
#
#   「正文变了 68%」本身不构成一个可执行的结论 —— 法务真正要问的是：
#     **变的是不是合规相关的东西？**
#   两个可能的答案，处置完全相反：
#     · 变的全是评论数/价格/促销码 → **指纹该修**（加一层掩码），业务无感知
#     · 变里含合规相关表述        → **指纹是对的**，这是真的内容改动，必须报
#   不做这一问就报「68% 不可复现」，等于把一个**工具缺陷**说成**业务风险**。

def masked(text: str) -> str:
    """把**已知会随时间变、且与合规判定无关**的片段替换成占位符。

    ★ 口径要写死：只掩**形态明确**的那几类（评论数 / 库存 / 倒计时）。
      **价格与折扣码不掩** —— 它们看起来像噪声，但促销幅度本身就是一条
      可能被判定为「绝对化 / 比较性」的表述（`SAVE 20%`）。把价格掩掉，
      就等于让「本周降价了」这件事对合规审查隐身。这个取舍必须写出来。
    """
    t = text or ""
    t = re.sub(r"(Rated\s+[\d.]+\s+out of 5 stars\s*\n?\s*)[\d,]+", r"\g<1><REVIEWS>", t)
    t = re.sub(r"\d+\s+left in stock", "<STOCK> left in stock", t)
    t = re.sub(r"\b\d{1,2}:\d{2}:\d{2}\b", "<TIMER>", t)
    return t


def claim_relevance(old_bt: str, new_bt: str) -> dict:
    """★★ 合规相关表述**有没有真的变** —— 这一问才是「所以呢」。

    ★ 判据本体在 `base/change_detect.py`（`claim-set-v1`），这里只是调用它。
      本脚本原先自带一份同样的取差集逻辑；两处各写一份的后果不是「重复」，
      是**两份会漂移**，而漂移之后两边仍各自输出一份看起来完整的结论。
      现在唯一的判据在基座里、带名字、带词形指纹、带自证 —— 这里不再有第二份。

    保留这个函数名，是因为**盘上已有的证据里就是这个名字**
    （`逐条[].合规相关性`）。改名会让旧证据读不出来，而旧证据是这个项目的账。
    """
    d = CD.judge(old_bt, new_bt)
    d["$口径"] = ("在**完整正文**上抽声明后取差集（判据 %s）；"
                  "不是「变更段里含不含词形」。" % CD.JUDGE)
    return d


def volatile_exposure(rows: list[dict]) -> dict:
    """**盘上快照**里有多少页面含波动片段 —— 静态暴露面，不是实测不稳定率。

    ★ 两个数不能互相冒充：
      · 本函数 = 「**有多少页面暴露在这种风险下**」（分母 92，一次算完）
      · 重抓实测 = 「**实际变了几个**」（分母 N，依赖抽到的页面与抓取间隔）
      把前者当后者报，会得出「一半以上的页面不可复现」这种没有测过的结论。
    """
    n_hit, per_form = 0, {}
    for r in rows:
        bt = ((r.get("html") or {}).get("body_text") or "")
        hit = [name for name, rx, _ in VOLATILE_FORMS if re.search(rx, bt)]
        for h in hit:
            per_form[h] = per_form.get(h, 0) + 1
        if hit:
            n_hit += 1
    return {"分母": len(rows), "含波动片段的页面": n_hit,
            "占比_pct": round(100.0 * n_hit / len(rows), 1) if rows else None,
            "逐形态": per_form,
            "$口径": ("**这是暴露面，不是实测不稳定率。** 「页面里有会变的片段」"
                      "与「重抓时它真的变了」是两件事：价格一个月不动，"
                      "两次抓取之间就不会产生分歧。")}


# ------------------------------------------------------------------ 正文落盘

# ★★ 为什么要把两版正文存下来：`--analyze-only` 能重算**计数**，
#   但不能重算**判据** —— 判据要吃正文。词表已经改过一次
#   （B1 §12.4：两个词永远匹配不上，导致批次 C 的一整批制品要重跑）。
#   证据里不留正文，词表再动一次就又是「重抓」，而重抓是联网的时间点动作，
#   不是随时能做的。
#
#   落盘沿 ADR-0011 §一.5 的口径：**内容寻址 + gzip**，文件名就是正文指纹。
#   于是跨轮的去重是免费的，而「这份正文是哪一份」由文件名自证。
TEXT_DIR = LAND / "_evidence" / "stability-text"


def store_text(text: str) -> dict:
    """把一份正文落盘，返回**指针**。已经存在就不重写（内容寻址）。"""
    import gzip
    sha = hashlib.sha256(text.encode()).hexdigest()
    TEXT_DIR.mkdir(parents=True, exist_ok=True)
    p = TEXT_DIR / (sha[:16] + ".txt.gz")
    if not p.exists():
        with gzip.open(p, "wb") as f:
            f.write(text.encode())
    return {"sha256": sha, "path": str(p.relative_to(ROOT)), "chars": len(text)}


def load_text(ptr: dict) -> str:
    """按指针把正文读回来，并**当场重算指纹** —— 不核指纹的读回等于相信文件名。"""
    import gzip
    with gzip.open(ROOT / ptr["path"], "rb") as f:
        b = f.read()
    got = hashlib.sha256(b).hexdigest()
    if got != ptr["sha256"]:
        raise ValueError("正文与指针不符：%s 里读到 %s，指针说 %s"
                         % (ptr["path"], got[:16], ptr["sha256"][:16]))
    return b.decode()


# ------------------------------------------------------------------ 重抓

def pick_targets(n: int) -> list[dict]:
    """抽样：从快照批里**等距取** n 个可判 URL。

    ★ 抽出来单独成函数，是为了让「每轮抓的是同一批」这句话**可被检查**：
      多轮账里记着每轮的 URL 名单，而这张名单必须与今天这个函数算出来的对上。
      抽样口径一旦被改动（比如改成按域名随机），
      「N 轮 = N 次重复测量、独立样本仍是 M 个」这个说法就当场失效 ——
      而它失效时，累计读数不会有任何变化。
    """
    fetch = json.loads((LAND / "抓取结果.json").read_text(encoding="utf-8"))
    cand = [r for r in fetch["results"] if r["tier_raw"].startswith("ok")]
    # ★ 抽样口径：**等距取**，不是取前 N 个。前 N 个全落在同一个域名/同一种页面上，
    #   会让「变了几个」变成「au.momcozy.com 变了几个」。
    step = max(1, len(cand) // max(1, n))
    return cand[::step][:n]


def refetch(n: int, global_gap: float) -> dict:
    fetch = json.loads((LAND / "抓取结果.json").read_text(encoding="utf-8"))
    ext = {e["url_key"]: e for e in
           json.loads((LAND / "要素提取.json").read_text(encoding="utf-8"))["results"]}
    pacer = F.Pacer(global_gap=global_gap, domain_gap=1.5)
    cache: dict = {}

    picked = pick_targets(n)

    rows, t0 = [], time.time()
    print("重抓 %d 个 URL（全局间隔 %.1fs，预计 %.0fs）—— 沿批次 C 的节流结论\n"
          % (len(picked), global_gap, len(picked) * global_gap))
    for i, r in enumerate(picked, 1):
        at = next((x for x in r["attempts"] if x["label"] == "html" and x.get("sha256")), None)
        e = ext.get(r["url_key"])
        if not at or not e or not (e.get("html") or {}).get("body_text"):
            continue
        dom = urllib.parse.urlparse(r["url"]).netloc
        pacer.wait(dom)
        st, fin, body, hdr, el, err = F.http_get(r["url"])
        pacer.hit(dom)
        row = {"url_key": r["url_key"], "url": r["url"], "status": st, "error": err,
               "bytes": len(body), "fetch_ms": el, "pacer_gap": round(pacer.global_gap, 1)}
        if err or st != 200 or not body:
            row["verdict"] = "refetch_failed"
            rows.append(row)
            print("  [%2d/%2d] ✗ %-58s %s" % (i, len(picked), r["url_key"][:58], err or st))
            continue
        raw_same = hashlib.sha256(body).hexdigest() == at["sha256"]
        old_bt = e["html"]["body_text"]
        new_bt = X.analyze_html(body)["body_text"]
        txt_same = hashlib.sha256(new_bt.encode()).hexdigest() == \
            hashlib.sha256(old_bt.encode()).hexdigest()
        row.update(raw_same=raw_same, text_same=txt_same,
                   old_len=len(old_bt), new_len=len(new_bt))
        # ★ 两版正文都落盘（内容寻址）。同文的行会自动共用同一份文件。
        row["旧版正文"] = store_text(old_bt)
        row["新版正文"] = store_text(new_bt)
        # ★ 判据**每一行都算**，不只是变了的那些 ——
        #   判据名必须随**每一条**结论一起落盘；只给变了的行挂判据名，
        #   会让「这一行是谁判的」在没变的行上无法回答。
        row["合规相关性"] = claim_relevance(old_bt, new_bt)
        if not txt_same:
            d = first_diff(old_bt, new_bt)
            row["diff"] = d
            row["归因"] = attribute(d)
            row["掩码后一致"] = (hashlib.sha256(masked(new_bt).encode()).hexdigest()
                                 == hashlib.sha256(masked(old_bt).encode()).hexdigest())
        row["verdict"] = "same" if txt_same else "text_changed"
        rows.append(row)
        mark = "=" if txt_same else "≠"
        print("  [%2d/%2d] %s 正文%s  原始HTML%s  %+d 字" % (
            i, len(picked), mark, "一致" if txt_same else "**变了**",
            "同" if raw_same else "异", len(new_bt) - len(old_bt)), flush=True)
        if not txt_same:
            for a in row["归因"]:
                if "旧" in a:
                    print("         ← %s：%r → %r" % (a["形态"], a["旧"], a["新"]))
                else:
                    print("         ← %s：−%s  +%s" % (a["形态"],
                                                      a.get("少了的词"), a.get("多了的词")))
            if not row["归因"]:
                print("         ← **未归因**（逐词差集也空 —— 差异只在标点/空白）")

    # ★ 写盘前拦一道：判据名没落到每一行上，就不许写。
    jbad = judge_name_problems(rows)
    if jbad:
        raise AssertionError("这些行没带判据名，拒绝写盘：\n  " + "\n  ".join(jbad[:5]))

    # ★ 联网只负责把网页取回来；**汇总在 summarize() 里，可以单独对盘上的行跑**
    #   （`--analyze-only`）。判据改了不必重抓，这是抽出来的全部理由。
    return summarize(rows, {
        "measured_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "snapshot": (fetch.get("manifest") or {}).get("snapshot"),
        "global_gap_s": global_gap,
        "elapsed_s": round(time.time() - t0, 1),
        "picked_n": len(picked),
        "exposure": volatile_exposure(list(ext.values())),
        "mask_note": ("掩 `Rated … out of 5 stars <N>` / `N left in stock` / `HH:MM:SS`。"
                      "**价格与折扣码不掩** —— 促销幅度本身可能是被判定的表述。"),
    })


def judge_name_problems(rows: list[dict]) -> list[str]:
    """写盘前的后置断言：**每一条可判的行都必须带判据名**。

    ★ 这是「一个结论离开它的判据就没有意义」的可执行形式。
      它放在**写盘前**，而不是放在事后检查里：事后检查只能告诉你证据已经坏了。
    """
    bad = []
    for r in rows:
        if r.get("verdict") not in ("same", "text_changed"):
            continue
        j = r.get("合规相关性") or {}
        if j.get("判据") != CD.JUDGE:
            bad.append("%s：合规相关性.判据 = %r" % (r.get("url_key", "?")[:44], j.get("判据")))
    return bad


def summarize(rows: list[dict], meta: dict) -> dict:
    """★ 汇总**必须能对盘上已有的行单独跑**。

    第一版把汇总写死在 `refetch()` 里，后果实测过两次：
      · `size_class()` 的 `len()` bug 在**一轮 20 个抓完之后**才抛 —— 166 秒白做；
      · 判据改了（「变更段含词形」→「声明集合取差集」）之后，**旧证据没法用新口径重算**，
        只能再花 166 秒重抓一遍。

    抽出来之后，判据怎么改都能对**已落盘的行**重算，联网只做一件事：把网页取回来。
    """
    ok_rows = [r for r in rows if r.get("verdict") in ("same", "text_changed")]

    same = [r for r in ok_rows if r["text_same"]]
    raw_same = [r for r in ok_rows if r.get("raw_same")]
    forms = {}
    for r in ok_rows:
        for a in r.get("归因") or []:
            forms[a["形态"]] = forms.get(a["形态"], 0) + 1
    changed = [r for r in ok_rows if r["verdict"] == "text_changed"]
    masked_same = [r for r in ok_rows
                   if r["verdict"] == "same" or r.get("掩码后一致")]
    compliance = [r for r in changed if (r.get("合规相关性") or {}).get("是否触及合规表述")]

    def span_class(r):
        """按**变更跨度**分档 —— 首个分歧点与最后一个分歧点之间的距离。

        ★★ 第一版这里叫「变更规模」，是个**误导的名字**，改名的理由值得写下来：
          实测 14 处正文变化里 **12 处跨度 >500 字符**，其中一处在 Δ 只有 −301 字
          的情况下跨度是 **17,585 字符**。那不是「改动很大」，是**页面被重排了** ——
          首尾分歧之间夹着大量根本没变的内容。

          ⇒ 正确读法不是「改得多」，而是「**改动无法被表达成一个小 diff**」。
            这直接决定处置方式：想在界面上给法务指「这里变了」，做不到
            （要标 17,585 个字符）。**能给人看的是声明集合的差集 —— 4 个词。**

        ★ `新段长`/`旧段长` 是字符数（int），第一版对它写了 `len()` ——
          在第一轮 20 个样本跑完之后才抛 `TypeError`，**一整轮的联网抓取白做**。
          教训不是「小心 len」，是**聚合阶段不该在抓取之后才第一次被执行**。
          这也是 `summarize()` 被从 `refetch()` 里抽出来的直接原因。
        """
        d = r.get("diff") or {}
        n = max(d.get("新段长") or 0, d.get("旧段长") or 0)
        return ("① 跨度 ≤30 字（局部替换）" if n <= 30 else
                "② 跨度 31–500 字" if n <= 500 else
                "③ 跨度 >500 字（**页面重排，diff 无法表达**）")
    spans = {}
    for r in changed:
        spans[span_class(r)] = spans.get(span_class(r), 0) + 1
    return {
        "measured_at": meta.get("measured_at"),
        "snapshot": meta.get("snapshot"),
        "global_gap_s": meta.get("global_gap_s"),
        "elapsed_s": meta.get("elapsed_s"),
        "样本": {"取": meta.get("picked_n"), "可判": len(ok_rows),
                 "重抓失败": len(rows) - len(ok_rows)},
        # ★ 这一轮的 URL 名单必须落进账里：合并多轮时要能回答
        #   「这是 N 个页面的 N 次重复测量，还是 N×M 个页面」——
        #   前者才是事实（抽样确定性等距，每轮都是同一批）。
        "本轮 URL": [r["url_key"] for r in ok_rows],
        # ★ 逐条摘要：只有总数的话，「两轮都是 6/20」并不说明两轮**判的是同一批**。
        #   有了它，跨轮可以逐项对照 —— 那才是「重跑能不能得到一样的数」
        #   在**判定**这一层上的答案（指纹那一层已经量过：30%）。
        "逐条摘要": [{"url_key": r["url_key"], "正文一致": bool(r["text_same"]),
                      "触及合规": bool((r.get("合规相关性") or {}).get("是否触及合规表述")),
                      "判据": (r.get("合规相关性") or {}).get("判据")}
                     for r in ok_rows],
        "原始 HTML sha256 一致": len(raw_same),
        "提取后正文 sha256 一致": len(same),
        "正文变化": len(ok_rows) - len(same),
        "正文可复现率_pct": round(100.0 * len(same) / len(ok_rows), 1) if ok_rows else None,
        "变化归因": forms,
        "★ 掩码后一致": len(masked_same),
        "★ 掩码后可复现率_pct": round(100.0 * len(masked_same) / len(ok_rows), 1) if ok_rows else None,
        "★ 变更跨度分档": spans,
        "★ 变更触及合规表述": len(compliance),
        "★ 变更触及合规表述的页面": [
            {"url_key": r["url_key"],
             "命中": {"消失的声明": r["合规相关性"]["消失的声明"],
                      "新增的声明": r["合规相关性"]["新增的声明"]}}
            for r in compliance],
        "逐条": rows,
        "静态暴露面": meta.get("exposure"),
        "掩码定义": meta.get("mask_note"),
        "$这一组数的读法": (
            "★ **分母是「本次抽到并可判的 URL 数」，不是 92。** 重抓是联网的时间点动作，"
            "它的结论只对「这个间隔、这批页面」成立。要外推到 92 个页面，"
            "得先假设它们与抽样同分布 —— 本脚本不替调用方做这个假设。\n"
            "★ 两个不同的数必须分开：`正文可复现率` 是**实测**；`静态暴露面` 是"
            "**有多少页面处于风险下**。把后者当前者，会得出没测过的结论。"),
    }


def _aggregate(runs: list[dict]) -> dict:
    """多轮合并读数 —— **单轮的 30% 与三轮合并的 30% 不是同一个结论**，
    后者才谈得上「这个口径大约多久失效一次」。

    ★★ B2 修复：这里原本会把**当前这一轮**再算一遍。
      `main()` 里写的是 `_aggregate(d["runs"] + [cur])`，而 `d["runs"]` 的末尾
      **已经是 `cur`** —— 于是**一轮 20 个观测被算成两轮 40 个**。
      盘上只有一条观测账，累计却写着「轮数 2 / 可判合计 40 / 变更触及合规 10」。
      而 §13.8 与 README 引用的正是这个 40 与这个 10。

      它危险的地方是**长得完全像一份更厚的证据**：
      「40 次观测里 10 次真变化」比「20 次里 5 次」可信得多 —— 而它是同一个数。
      百分比没被它带偏（两轮分母相同，30.0% 与 30.0%），
      **被带偏的是「这个结论有多少证据托底」**，而那正是本脚本存在的理由。

      修两处，且**不靠「调用点写对」**：
        ① 调用点改成 `_aggregate(d["runs"])`；
        ② 本函数自己**拒绝把同一轮算两遍**（同 `measured_at` 出现两次即报错）。
           本项目的教训是断言要能在下游独立成立 —— 一条只在调用点写对时才成立的
           检查，下一次有人复制那行 `+ [cur]` 就又没了。
    """
    if not runs:
        return {}
    stamps = [r.get("measured_at") for r in runs]
    dup = sorted({s for s in stamps if s and stamps.count(s) > 1})
    if dup:
        raise ValueError(
            "拒绝合并：同一轮被算了两次（measured_at 重复：%s）。"
            "累计读数只有在「一轮 = 一条账」时才有意义。" % dup)
    j = sum(r["样本"]["可判"] for r in runs)
    s = sum(r["提取后正文 sha256 一致"] for r in runs)
    raw = sum(r["原始 HTML sha256 一致"] for r in runs)
    mk = sum(r.get("★ 掩码后一致") or 0 for r in runs)
    cp = sum(r.get("★ 变更触及合规表述") or 0 for r in runs)
    forms = {}
    for r in runs:
        for k, v in (r.get("变化归因") or {}).items():
            forms[k] = forms.get(k, 0) + v
    keys = {u for r in runs for u in (r.get("本轮 URL") or [])}
    return {"轮数": len(runs), "可判合计": j,
            "原始 HTML 一致": "%d/%d" % (raw, j),
            "正文一致": "%d/%d" % (s, j),
            "正文可复现率_pct": round(100.0 * s / j, 1) if j else None,
            "★ 掩码后可复现率_pct": round(100.0 * mk / j, 1) if j else None,
            "★ 变更触及合规表述": cp,
            "变化归因合计": forms,
            # ★★ 「可判合计」是**观测次数**，不是**独立样本数**。
            #   抽样是等距确定性的，所以每一轮抓的是**同一批 20 个 URL**：
            #   轮数增加的是「同一批页面被重复测量的次数」，不是页面数。
            #   两个数分开报，是为了让「40 次观测」不被读成「40 个页面」。
            "★ 有效独立样本": len(keys) or None,
            "$读法": ("★ **合并的是「同一快照、不同时间点」的多次观测。** 每次重抓都是"
                      "一次独立的对照：拿快照日的正文与「今天」的正文比。"
                      "所以轮数越多，「两个时间点之间正文会变的页面占多少」估得越准 —— "
                      "而它衡量的仍然是**这一点时间跨度内**的变化，不是「永远」。\n"
                      "★ **`可判合计` 是观测次数，不是样本数。** 抽样确定性等距，"
                      "每轮抓的是同一批 URL ⇒ N 轮 × M 个 = N×M 次**重复测量**，"
                      "独立样本仍是 M 个。别把它读成「我测了 40 个页面」。")}


# ------------------------------------------------------------------ 多轮账

# ★ 每轮存进 `runs` 的字段**只在这里写一次**。
#   原本同一份字段清单在 `main()` 里抄了两遍（一次 append、一次 aggregate），
#   而两份清单漂移是迟早的事 —— 漂移的后果是某一轮少算了一个数，**表照常打印**。
#   抽成一个函数之后，抄第二遍这件事在结构上就不可能了。
ROUND_FIELDS = ("measured_at", "样本", "原始 HTML sha256 一致",
                "提取后正文 sha256 一致", "正文可复现率_pct",
                "★ 掩码后一致", "★ 掩码后可复现率_pct",
                "★ 变更触及合规表述", "变化归因", "elapsed_s", "本轮 URL",
                "逐条摘要")


def _round_entry(d: dict) -> dict:
    """把一轮的读数折成**一条账**。"""
    return {k: d.get(k) for k in ROUND_FIELDS}


# ★ `_aggregate` 真的会读的键。与 ROUND_FIELDS 分开写是**故意的**：
#   两张清单只要不完全重合，就说明某轮账里某个数会静默变成 None，
#   而 `_aggregate` 会照常把它当 0 算进分母 —— 表照常打印。
AGGREGATE_READS = ("measured_at", "样本", "原始 HTML sha256 一致",
                   "提取后正文 sha256 一致", "★ 掩码后一致",
                   "★ 变更触及合规表述", "变化归因", "本轮 URL")


def round_account_problems(entry: dict) -> list[str]:
    """一条轮次账缺了什么 —— **缺一个数就不许入账**。

    静默缺字段的后果是分母变小、分子不变，而屏幕上一个字都不说。
    所以这里把「账不完整」变成一条**写入前就拦下**的检查。
    """
    bad = []
    for k in AGGREGATE_READS:
        if k not in ROUND_FIELDS:
            bad.append(f"ROUND_FIELDS 里没有 {k!r} —— 它会被折成 None 并当 0 算")
        elif entry.get(k) is None:
            bad.append(f"{k!r} 是 None —— 这一轮的账不完整")
    if not (entry.get("样本") or {}).get("可判"):
        bad.append("样本.可判 为 0/缺失 —— 一条没有分母的账")
    return bad


def _reanalyze(raw: dict) -> dict:
    """用**当前判据**对盘上已有的观测重算顶层汇总。不联网、**不追加账**。

    抽成独立函数是为了**能跑两遍**：自证里要断言「重算两次之后 `累计`
    一个字都不变」—— 幂等性只有在同一个输入能被调用两次时才验得了。
    """
    meta = {k: raw.get(k) for k in ("measured_at", "snapshot", "global_gap_s",
                                    "elapsed_s")}
    meta["picked_n"] = (raw.get("样本") or {}).get("取")
    meta["exposure"] = raw.get("静态暴露面")
    meta["mask_note"] = raw.get("掩码定义")
    d = summarize(raw["逐条"], meta)
    # ★ `runs` 是**每轮观测**的历史：重算**只读不写**。
    #   这里若 append 一次，同一批观测就会被算两遍 —— 那正是本轮修掉的那个缺陷，
    #   而它上一次出现时，屏幕上什么都没说。
    runs = raw.get("runs") or []
    d["runs"] = runs
    d["累计"] = _aggregate(runs)
    d["reanalyzed_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    d["reanalyzed_note"] = ("★ 顶层汇总由 `--analyze-only` 用**当前判据**重算；"
                            "`逐条`（原始观测）与 `runs`（轮次账）都没有被改动。")
    return d


def recompute(raw: dict, write_back: bool = False) -> dict:
    """不用联网，用**当前判据**对盘上每一行重算一遍。

    ★ 这是「判据改了不必重抓」那句话的兑现处，也是**正文必须落盘**的理由：
      `--analyze-only` 只能重算**计数**（它读的是旧判据留下的结论），
      要换一套词形重算，判据就得吃得到正文。

    ★ 重算**不改写**旧结论，除非显式 `write_back`；改写时会把原判据名记进
      `判据变更历史` —— 一份被换过判据的结论，必须能说出它前身是什么判据判的。
    """
    rows = raw.get("逐条") or []
    can, cannot, agree, disagree, missing = 0, [], 0, [], 0
    for r in rows:
        o, n = r.get("旧版正文"), r.get("新版正文")
        if not (isinstance(o, dict) and isinstance(n, dict)):
            cannot.append(r.get("url_key"))
            continue
        can += 1
        old_j = r.get("合规相关性") or {}
        new_j = claim_relevance(load_text(o), load_text(n))
        if not old_j.get("判据"):
            # ★ 没有旧结论的行：同文行本来就没算过判据（判据「每一行都算」是后加的）。
            #   对这种行，重算不是「对答案」，是**补上它一直缺的那个字段** ——
            #   所以它不该被算进「一致/不一致」，而要单独出声。
            missing += 1
            if write_back:
                r["合规相关性"] = new_j
                r.setdefault("判据补录", []).append(
                    {"补录于": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                     "判据": new_j["判据"],
                     "$为什么": ("该行在本轮之前没有判据结论（判据『每一行都算』是后加的）；"
                                 "重算用两版正文把它补上，正文来自内容寻址的落盘副本。")})
            continue
        same = (old_j.get("消失的声明") == new_j.get("消失的声明")
                and old_j.get("新增的声明") == new_j.get("新增的声明"))
        if same:
            agree += 1
        else:
            disagree.append({"url_key": r.get("url_key"),
                             "旧判据结论": {"消失": old_j.get("消失的声明"),
                                            "新增": old_j.get("新增的声明")},
                             "新判据结论": {"消失": new_j.get("消失的声明"),
                                            "新增": new_j.get("新增的声明")}})
        if write_back and not same:
            hist = r.setdefault("判据变更历史", [])
            hist.append({"由": old_j.get("判据") or "（未记，判据名是本轮才要求落盘的）",
                         "改为": new_j.get("判据"), "重算于": time.strftime(
                             "%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
            r["合规相关性"] = new_j
    return {"判据": CD.JUDGE, "词形来源": CD.claim_source(),
            "逐条": len(rows), "可重算": can, "不可重算": len(cannot),
            "不可重算的 URL": cannot[:10],
            "逐项一致": agree, "逐项不一致": len(disagree),
            "不一致明细": disagree[:10],
            "无旧结论可对（已补录）": missing,
            "已回写": bool(write_back)}


def _repair_ledger(raw: dict) -> tuple[dict, list[str]]:
    """给**旧账**补上它缺的字段 —— **先逐条断言，再写盘**；对不上就拒绝。

    ★ 为什么需要它：`runs` 的字段清单是后来才加上 `本轮 URL` 的，
      盘上那条旧账因此没有名单，`有效独立样本` 会静默变成 None。
      （这与本轮另外两个错同形：字段清单是「长出来的」，
      而**长出来之前写下的账不会自己补齐**。）

    ★ 为什么敢补：`runs` 里最后一条的 `measured_at` 与顶层 `逐条` 的
      同 ⇒ 它们同属一轮，而 `逐条` 里就有那一轮的 URL 名单。这是**可证的**，不是猜的。
      所以这里先断言三个数逐一相符，任何一项对不上就拒绝写盘 ——
      沿用 `media.py --reattach-weights` 的做法：
      **猜参数会让账错得很安静，所以参数必须显式来自可核的来源。**
    """
    runs = raw.get("runs") or []
    if not runs:
        return raw, ["盘上没有轮次账，没有可补的"]
    if runs[-1].get("本轮 URL"):
        return raw, ["最后一条账已有 URL 名单，不需要补"]
    rows = raw.get("逐条") or []
    ok_rows = [r for r in rows if r.get("verdict") in ("same", "text_changed")]
    last, notes = runs[-1], []
    same_n = sum(1 for r in ok_rows if r.get("text_same"))
    for name, a, b in (("measured_at", last.get("measured_at"), raw.get("measured_at")),
                       ("可判", (last.get("样本") or {}).get("可判"), len(ok_rows)),
                       ("正文一致", last.get("提取后正文 sha256 一致"), same_n)):
        if a != b:
            return raw, ["拒绝补账：%s 对不上（账里 %r ≠ 逐条 %r）—— 不是同一轮" % (name, a, b)]
        notes.append("%s 相符（%r）" % (name, a))
    last["本轮 URL"] = [r["url_key"] for r in ok_rows]
    last["$补账"] = ("★ 本轮 URL 由 `--repair-ledger` 补入：该条账的 measured_at 与顶层"
                     "逐条相同 ⇒ 同属一轮；并已断言 measured_at/可判/正文一致 三项逐一相符。")
    return raw, notes + ["补入 %d 个 url_key" % len(last["本轮 URL"])]


def selftest(verbose: bool = True) -> list[str]:
    """B2 自证。**全绿才算完成。** 每条都带反向对照（「必红」）——
    一条永远不会红的检查等于没有检查。

    这一套守的是**账**。本脚本存在的理由是「这个数明天还是不是这个数」，
    所以它自己报出来的每个数也必须**可复算、且不会自己长大**。
    """
    fails: list[str] = []

    def check(name, cond, detail=""):
        ok = bool(cond)
        if verbose:
            print(("  ✓ " if ok else "  ✗ ") + name + (("   " + detail) if detail else ""))
        if not ok:
            fails.append(name + (("  " + detail) if detail else ""))
        return ok

    print("=" * 78)
    print("B2 自证 · 落地页正文指纹复现性（账本 + 判据）")
    print("=" * 78)

    def rnd(tag, same, hits, judged):
        return {"measured_at": tag, "样本": {"取": 20, "可判": judged,
                                             "重抓失败": 20 - judged},
                "原始 HTML sha256 一致": 0, "提取后正文 sha256 一致": same,
                "正文可复现率_pct": round(100.0 * same / judged, 1),
                "★ 掩码后一致": same,
                "★ 掩码后可复现率_pct": round(100.0 * same / judged, 1),
                "★ 变更触及合规表述": hits, "变化归因": {}, "elapsed_s": 1.0,
                "本轮 URL": [f"u{i}" for i in range(judged)]}

    print("\n[1] 轮次账：一轮就是一轮")
    r1 = rnd("T1", 6, 5, 20)
    a1 = _aggregate([r1])
    check("一轮 → 轮数 1、可判合计 20、正文一致 6", (a1["轮数"], a1["可判合计"],
                                                a1["正文一致"]) == (1, 20, "6/20"),
          "得到 %s" % ((a1["轮数"], a1["可判合计"], a1["正文一致"]),))
    check("有效独立样本 = 20（不是「20 个页面 × 1 轮」以外的任何数）",
          a1["★ 有效独立样本"] == 20, str(a1["★ 有效独立样本"]))

    # ★★ 这一条是**本轮修掉的那个缺陷**的回归闸门。
    #   原来的 `main()` 写的是 `_aggregate(d["runs"] + [cur])`，而 `d["runs"]`
    #   末尾已经是 `cur` —— 一轮被算两遍，40 与 10 就是这么来的。
    try:
        dup = _aggregate([r1, r1])
        check("必红：同一轮喂两次 → 必须拒绝合并", False,
              "它默默算出了「轮数 %s / 可判合计 %s」—— 这正是缺陷复发的形态"
              % (dup["轮数"], dup["可判合计"]))
    except ValueError:
        check("必红：同一轮喂两次 → 必须拒绝合并", True, "拒绝得对（不再自增）")

    print("\n[2] 合并是**重算**，不是各轮百分比取平均")
    r2 = rnd("T2", 1, 1, 10)
    r3 = rnd("T3", 1, 0, 5)
    a2 = _aggregate([r2, r3])
    # 1/10 = 10.0% 与 1/5 = 20.0% 的平均是 15.0%；重算 2/15 = 13.3%
    check("两轮 1/10 + 1/5 → 合并 2/15 = 13.3%（**不是** 10% 与 20% 的平均 15.0%）",
          a2["正文一致"] == "2/15" and a2["正文可复现率_pct"] == 13.3,
          "得到 %s / %s%%" % (a2["正文一致"], a2["正文可复现率_pct"]))

    print("\n[3] 账的完整性：缺一个数就不许入账")
    real = None
    if OUT.exists():
        raw = json.loads(OUT.read_text(encoding="utf-8"))
        meta = {"measured_at": raw.get("measured_at"), "snapshot": raw.get("snapshot"),
                "global_gap_s": raw.get("global_gap_s"), "elapsed_s": raw.get("elapsed_s"),
                "picked_n": (raw.get("样本") or {}).get("取"),
                "exposure": raw.get("静态暴露面"), "mask_note": raw.get("掩码定义")}
        real = _round_entry(summarize(raw["逐条"], meta))
        check("盘上那一轮折成账后**没有缺项**", round_account_problems(real) == [],
              str(round_account_problems(real)))
        bp = round_account_problems({})
        check("必红：空账必须被拦下（不是当成一轮分母 0 的账）", bool(bp),
              bp and ("拦下了 %d 项" % len(bp)) or "空账被放行了 —— 这条检查是空的")
        miss = dict(real)
        miss["★ 变更触及合规表述"] = None
        bm = round_account_problems(miss)
        check("必红：少一个数（触及合规表述 = None）必须被拦下",
              any("变更触及合规表述" in x for x in bm),
              bm and bm[0] or "它被放行了 —— 分子会静默变 0")

    print("\n[4] 幂等：重算两次，累计一个字都不变")
    if real is not None:
        raw = json.loads(OUT.read_text(encoding="utf-8"))
        d1 = _reanalyze(raw)
        d2 = _reanalyze(d1)
        check("`--analyze-only` 幂等（累计逐字节相同）",
              json.dumps(d1["累计"], ensure_ascii=False, sort_keys=True)
              == json.dumps(d2["累计"], ensure_ascii=False, sort_keys=True))
        check("重算**不追加**轮次账：runs 长度 %d 不变"
              % len(raw.get("runs") or []),
              len(d1["runs"]) == len(raw.get("runs") or []),
              "%d → %d" % (len(raw.get("runs") or []), len(d1["runs"])))

    print("\n[5] 抽样：每轮抓的是不是同一批")
    try:
        keys_20 = [r["url_key"] for r in pick_targets(20)]
        check("抽样是确定性的：连算两次得到同一张名单",
              keys_20 == [r["url_key"] for r in pick_targets(20)])
        if real is not None and real.get("本轮 URL"):
            inb = len(set(real["本轮 URL"]) & set(keys_20))
            check("账里那一轮的 URL 名单 ⊆ 今天算出来的名单（%d/%d 命中）"
                  % (inb, len(real["本轮 URL"])),
                  inb == len(real["本轮 URL"]),
                  "" if inb == len(real["本轮 URL"]) else
                  "抽样口径被改过了 —— 「N 轮 = N 次重复测量」这个说法随之失效")
    except FileNotFoundError as e:
        check("盘上有快照语料", False, str(e))

    print("\n[5b] 正文落盘：内容寻址 + 读回时**当场重算指纹**")
    probe = "hospital-grade pump\nRated 4.6 out of 5 stars 1,834\n$199.99"
    ptr = store_text(probe)
    check("落盘指针就是正文指纹（%s…）" % ptr["sha256"][:12],
          ptr["sha256"] == hashlib.sha256(probe.encode()).hexdigest())
    check("读回来逐字节相同（gzip 往返）", load_text(ptr) == probe)
    check("重复落盘不新建文件（内容寻址，跨轮去重免费）",
          store_text(probe)["path"] == ptr["path"])
    bad = dict(ptr); bad["sha256"] = "0" * 64
    try:
        load_text(bad)
        check("必红：指针与实际内容不符时必须**拒绝读回**", False,
              "它照常返回了内容 —— 不核指纹的读回等于相信文件名")
    except ValueError:
        check("必红：指针与实际内容不符时必须**拒绝读回**", True)

    print("\n[6] 判据：声明集合取差集（**不是**「变更段里含词形」）")
    # ① 旧判据的形态 —— 必须被本判据判成「没变」。
    #   旧判据问的是「变更段里含不含合规词形」，而 45dB 与 FSA 在**新旧两版里都在**，
    #   于是它几乎恒为真。这条正向断言就是那个错的回归闸门。
    same_txt = "Up to 25% Off 45dB quiet FSA eligible hospital-grade pump"
    v = claim_relevance(same_txt, same_txt)
    check("必红：两版词形都在 → 判「**没有**合规相关变化」（旧判据在这里会报假警）",
          v["是否触及合规表述"] is False, json.dumps(v, ensure_ascii=False)[:90])
    # ② 真的撤了一条声明
    v = claim_relevance("hospital-grade wearable pump", "wearable pump")
    check("撤掉 hospital-grade → 消失的声明里有 medical/hospital-grade",
          "hospital-grade" in v["消失的声明"].get("medical", []),
          json.dumps(v["消失的声明"], ensure_ascii=False)[:90])
    # ③ 真的加了一条
    v = claim_relevance("wearable pump", "guaranteed wearable pump")
    check("新增 guaranteed → 新增的声明里有 absolute/guaranteed",
          "guaranteed" in v["新增的声明"].get("absolute", []),
          json.dumps(v["新增的声明"], ensure_ascii=False)[:90])

    print("\n[7] 掩码口径：写了「价格不掩」就要断言它")
    check("评论数被掩掉", "<REVIEWS>" in masked("Rated 4.6 out of 5 stars\n1,835"))
    price_kept = "$199.99" in masked("Only $199.99 today")
    check("必红：价格**不掩** —— `$199.99` 必须原样留着", price_kept,
          "" if price_kept else
          "价格被掩掉了：促销幅度本身可能是一条被判定的表述，掩掉它等于让它对审查隐身")

    print("\n[8] 重算：判据换了不必重抓")
    if OUT.exists():
        rc = recompute(json.loads(OUT.read_text(encoding="utf-8")))
        check("盘上证据**可重算**的行：%d / %d（不可重算 %d）"
              % (rc["可重算"], rc["逐条"], rc["不可重算"]),
              rc["可重算"] == rc["逐条"] or rc["可重算"] > 0,
              "一行都读不回来 ⇒ 证据里没有正文（%s）" % (rc["不可重算的 URL"][:3] or "—"))
        check("用当前判据重算 → 与盘上结论逐项一致 %d / %d" % (rc["逐项一致"], rc["可重算"]),
              rc["可重算"] > 0 and rc["逐项不一致"] == 0,
              "可重算 0 行 —— 这条在**空转**（没有正文就没有一致可言）"
              if rc["可重算"] == 0 else
              json.dumps(rc["不一致明细"][:2], ensure_ascii=False)[:160])
        rows8 = [r for r in (json.loads(OUT.read_text(encoding="utf-8")).get("逐条") or [])
                 if r.get("verdict") in ("same", "text_changed")]
        named8 = [r for r in rows8 if (r.get("合规相关性") or {}).get("判据") == CD.JUDGE]
        check("带判据名的行 %d / %d（**有结论文的行必须带判据名**）"
              % (len(named8), len(rows8)), len(named8) == len(rows8),
              "" if len(named8) == len(rows8) else
              "有行没带判据名 —— 判据『每一行都算』是后加的，"
              "此后由 `judge_name_problems()` 在**写盘前**拦截")

    print("\n" + "-" * 78)
    if fails:
        print("✗ 自证未通过：%d 条" % len(fails))
    else:
        print("✓ 自证全绿")
    return fails


def main() -> int:
    ap = argparse.ArgumentParser(description="落地页正文指纹复现性实测（B2）")
    ap.add_argument("-n", type=int, default=20, help="重抓多少个 URL（默认 20）")
    ap.add_argument("--global-gap", type=float, default=6.0, help="全局节流间隔秒（别调小）")
    ap.add_argument("--analyze-only", action="store_true", help="不联网，只读盘上证据")
    ap.add_argument("--recompute", action="store_true",
                    help="不联网，用当前判据对盘上每一行重算（判据改了不必重抓）")
    ap.add_argument("--write-back", action="store_true",
                    help="与 --recompute 合用：把重算结果写回证据，并记下原判据名")
    ap.add_argument("--repair-ledger", action="store_true",
                    help="给旧账补 URL 名单（先断言再写盘，对不上就拒绝）")
    ap.add_argument("--selftest", action="store_true",
                    help="自证：聚合账本与判据全绿 + 反向对照必红")
    a = ap.parse_args()

    if a.selftest:
        return 1 if selftest() else 0

    if a.recompute:
        if not OUT.exists():
            print("盘上还没有 stability.json。", file=sys.stderr)
            return 1
        raw = json.loads(OUT.read_text(encoding="utf-8"))
        rc = recompute(raw, write_back=a.write_back)
        print("=" * 78)
        print("重算 · 判据 %s（词形指纹 %s）" % (rc["判据"], rc["词形来源"]["指纹"]))
        print("=" * 78)
        print("\n  逐条 %d 行 · 可重算 %d · **不可重算 %d**" % (
            rc["逐条"], rc["可重算"], rc["不可重算"]))
        if rc["不可重算"]:
            print("    不可重算的行没有落正文（判据改成「必须落正文」之前的旧证据）：")
            for u in rc["不可重算的 URL"][:6]:
                print("      · %s" % u)
        print("  用当前判据重算 → **逐项一致 %d / %d**" % (rc["逐项一致"], rc["可重算"]))
        if rc["无旧结论可对（已补录）"]:
            print("  另有 %d 行**没有旧判据结论可对**（同文行原先不算判据）→ %s"
                  % (rc["无旧结论可对（已补录）"],
                     "已补录" if a.write_back else "未补录（加 --write-back）"))
        for x in rc["不一致明细"][:6]:
            print("    ≠ %s" % x["url_key"][:56])
            print("        旧判据 %s" % json.dumps(x["旧判据结论"], ensure_ascii=False))
            print("        新判据 %s" % json.dumps(x["新判据结论"], ensure_ascii=False))
        if a.write_back and (rc["逐项不一致"] or rc["无旧结论可对（已补录）"]):
            OUT.write_text(json.dumps(raw, ensure_ascii=False, indent=1), encoding="utf-8")
            print("\n  → 已回写：改写 %d 行（记下原判据名）· 补录 %d 行（原本没有判据名）"
                  % (rc["逐项不一致"], rc["无旧结论可对（已补录）"]))
        elif a.write_back:
            print("\n  → 没有需要回写的行")
        else:
            print("\n  （未回写。要写回请加 --write-back —— 证据的改写必须是显式动作。）")
        return 0

    if a.repair_ledger:
        if not OUT.exists():
            print("盘上还没有 stability.json。", file=sys.stderr)
            return 1
        raw, notes = _repair_ledger(json.loads(OUT.read_text(encoding="utf-8")))
        for x in notes:
            print("  " + x)
        if any(x.startswith("拒绝") for x in notes):
            print("✗ 没有写盘", file=sys.stderr)
            return 1
        OUT.write_text(json.dumps(raw, ensure_ascii=False, indent=1), encoding="utf-8")
        print("→ 已写回 %s" % OUT.relative_to(ROOT))
        return 0

    if a.analyze_only:
        if not OUT.exists():
            print("盘上还没有 stability.json，先跑一次联网版。")
            return 1
        raw = json.loads(OUT.read_text(encoding="utf-8"))
        # ★ 用**当前判据**对盘上已有的行重算 —— 判据改过之后旧证据仍可用。
        #   这正是把 summarize() 从 refetch() 里抽出来的全部理由：
        #   联网只负责把网页取回来，怎么算与取不取是两件事。
        d = _reanalyze(raw)
        OUT.write_text(json.dumps(d, ensure_ascii=False, indent=1), encoding="utf-8")
    else:
        d = refetch(a.n, a.global_gap)
        # ★ 多轮累积：单轮 20 个的分母太小，说不出「可复现率大约是多少」。
        #   每一轮都是独立的时间点观测，合起来才够。**不覆盖、只追加。**
        prev_runs = []
        if OUT.exists():
            try:
                prev_runs = json.loads(OUT.read_text(encoding="utf-8")).get("runs") or []
            except Exception as e:                              # noqa: BLE001
                # ★ 这里原本写的是静默 `d["runs"] = []`：读不动历史就**当作没有历史**，
                #   累计分母悄悄缩水，而屏幕上没有任何一行说这件事。
                print("!! 读不动盘上的 runs（%s: %s）—— 本轮只按「只有这一轮」记账，"
                      "累计分母会变小。" % (type(e).__name__, e), file=sys.stderr)
                prev_runs = []
        entry = _round_entry(d)
        # ★ 账不完整就**不许入账**：缺字段会被当 0 算进分母，而表照常打印。
        bad = round_account_problems(entry)
        if bad:
            print("!! 本轮读数不足以入账：", file=sys.stderr)
            for x in bad:
                print("   - " + x, file=sys.stderr)
            return 1
        d["runs"] = (prev_runs + [entry])[-10:]
        try:
            d["累计"] = _aggregate(d["runs"])
        except ValueError as e:
            # ★ 宁可停下来喊，也不要打印一个「看起来更厚」的错数。
            print("!! " + str(e), file=sys.stderr)
            return 1
        OUT.parent.mkdir(parents=True, exist_ok=True)
        OUT.write_text(json.dumps(d, ensure_ascii=False, indent=1), encoding="utf-8")

    print("\n" + "=" * 78)
    print("落地页正文指纹复现性（快照 %s）" % d["snapshot"])
    print("=" * 78)
    s = d["样本"]
    print("\n重抓 %d 个，可判 %d 个，失败 %d 个  用时 %.0fs（全局间隔 %.1fs）" % (
        s["取"], s["可判"], s["重抓失败"], d["elapsed_s"], d["global_gap_s"]))
    print("\n  原始 HTML sha256  一致 %d/%d" % (d["原始 HTML sha256 一致"], s["可判"]))
    print("  提取后正文 sha256 一致 %d/%d  → **可复现率 %s%%**" % (
        d["提取后正文 sha256 一致"], s["可判"], d["正文可复现率_pct"]))
    agg = d.get("累计") or {}
    if agg.get("轮数", 0) > 1:
        print("\n  ★ 累计（%d 轮独立观测合并 —— 单轮分母太小，说不出「大约多少」）：" % agg["轮数"])
        print("    原始 HTML 一致 %s · 正文一致 %s → **正文可复现率 %s%%**" % (
            agg["原始 HTML 一致"], agg["正文一致"], agg["正文可复现率_pct"]))
        print("    变化归因合计：%s" % agg["变化归因合计"])
        print("    " + agg["$读法"])
    if d["变化归因"]:
        print("\n  变化归因：")
        for k, v in sorted(d["变化归因"].items(), key=lambda x: -x[1]):
            print("    %-10s %d 次" % (k, v))
    if d.get("★ 掩码后可复现率_pct") is not None:
        print("\n  ★ 所以呢（这一节才是可执行的结论）：")
        print("    ① 假设检验：把「评论数/库存/倒计时」掩成占位符后再比指纹 ——")
        print("       一致 %s/%s → **掩码后可复现率 %s%%**（未掩码 %s%%）" % (
            d["★ 掩码后一致"], s["可判"], d["★ 掩码后可复现率_pct"],
            d["正文可复现率_pct"]))
        if d["★ 掩码后一致"] == d["提取后正文 sha256 一致"]:
            print("       ✗ **假设被否**：掩码一个也没救回来。"
                  "「变化都是评论数那种小计数器」这个想法**不成立** ——")
            print("         变化里包含**真的内容改动**（促销横幅换版）。见下面的规模分档。")
        print("    ② 变更跨度分档（首个分歧 → 最后一个分歧之间的距离）：")
        for k, v in sorted((d.get("★ 变更跨度分档") or {}).items()):
            print("         %-28s %d 处" % (k, v))
        print("    ③ **合规相关表述真的变了吗**（在完整正文上抽声明后取差集）：%s 处" % (
            d["★ 变更触及合规表述"]))
        for x in (d.get("★ 变更触及合规表述的页面") or [])[:6]:
            print("         %s" % x["url_key"][:56])
            print("            消失 %s / 新增 %s" % (x["命中"]["消失的声明"], x["命中"]["新增的声明"]))
        if not d["★ 变更触及合规表述"]:
            print("       ★ **本次 %d 处变更里，声明集合一处都没变。**" % (
                s["可判"] - d["提取后正文 sha256 一致"]))
            print("         读法：这些「变化」对法务是噪声 —— 而当前口径会把它报成「正文变了」。")
    exp = d["静态暴露面"]
    print("\n  静态暴露面（另一件事，别与上面的率混读）：")
    print("    92 个页面里含波动片段的：%d/%d = %s%%" % (
        exp["含波动片段的页面"], exp["分母"], exp["占比_pct"]))
    for k, v in sorted(exp["逐形态"].items(), key=lambda x: -x[1]):
        print("      %-10s %d 页" % (k, v))
    print("\n" + d["$这一组数的读法"])
    print("→ %s" % OUT.relative_to(ROOT))
    print("=" * 78)
    return 0


if __name__ == "__main__":
    sys.exit(main())

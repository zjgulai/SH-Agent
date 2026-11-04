#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""外部标准库条款原文 · 独立复核（不信研究稿的自述）

背景：研究稿交付时声明「62 条条款原文逐条用脚本比对过当天真实抓取的页面
文本，0 条失配」，但仓库里只留下成品 JSON —— **没有任何页面文本留档**。
那是一句没有物证的过程声明：换个人、换一天，无法重跑，也无法反驳。

本脚本把它变成可重算的东西：
  1. 自己按来源清单抓一遍，页面文本钉成快照
     research/kb/_evidence/外部标准库/S{n}.txt（含 url / UA / http / 长度 / 取法）
     ★ 该目录按 ADR-0013 §三属证据层（`**/_evidence/` 不入 git），
       所以「新克隆的仓库」没有快照 —— 那时跑默认模式（现场抓）而不是 --offline。
  2. 逐条核对「条款原文」是否为该来源快照的去空白子串
  3. 抓不到或没快照的来源 → 其条目记 UNVERIFIABLE，**不计入命中**

★ 实测到的环境事实（写下来，因为它们互相矛盾，猜不出来）：
  · FDA  朴素 UA → 200；**伪装浏览器 UA → 404（10 字节）**
  · FTC  朴素 UA → 403；**伪装浏览器 UA → 200**
  · Meta 两种 UA 都 200，但正文不在 HTML 里 —— 只剥标签仅得 41 字符；
         正文在 Next.js 内嵌数据块里
  所以抓取序列是「先浏览器 UA、文本太薄再退朴素 UA」，并把**实际生效的
  UA 写进快照抬头**。取法不按来源记录，逐字核对就不可复现 —— 这正是本
  脚本要修的那个洞。

命中还分两级，避免「在一大堆内嵌字符串里凑上」被当成可见正文：
  visible  = 命中剥标签后的 HTML 正文
  embedded = 只在内嵌数据块（window.__scV2Content / __NEXT_DATA__ 等）里命中

用法：
  python3 tools/verify_external.py              # 抓取 + 核对（默认，落快照）
  python3 tools/verify_external.py --offline    # 只用已钉快照，不联网
  python3 tools/verify_external.py --only S11,S12
退出码：0 = 全部条目命中；1 = 有失配，或有条目不可复核。
"""
import argparse
import hashlib
import html as _html
import json
import os
import re
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DRAFT = os.path.join(ROOT, "research/kb/外部标准库-v1.json")
# ★ 可用 SHOUHENG_SNAPDIR 覆盖：让「归档 + 漂移」这条**会动盘**的路径
#   能在临时副本上做反向对照 —— 否则测它就得拿真快照试，而真快照是证据（§2.1 那条事故）。
SNAPDIR = os.environ.get("SHOUHENG_SNAPDIR") or os.path.join(ROOT, "research/kb/_evidence/外部标准库")
RUNS = os.path.join(SNAPDIR, "_runs.jsonl")   # ★ append-only：每轮真抓一条，供两轮之间的漂移对比
# 仓内已钉住的证据树：抬头带 `URL:` 的抓取件可按下述方式复用
PIN_ROOTS = ("research/governance/_evidence",)
PIN_URL = re.compile(r"^(?:Source URL|URL|SOURCE_URL)\s*:\s*(\S+)", re.M)
PIN_DATE = re.compile(r"^(?:Fetch date|FETCH_DATE|FETCHED)\s*:\s*(\S+)", re.M)
BUA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
PLAIN = "curl/8"
# 内嵌数据块的变量名（Amazon 用 scV2Content，Meta 用 __NEXT_DATA__）
BLOBS = ("window.__scV2Content", "__NEXT_DATA__", "__APOLLO_STATE__",
         "__NUXT__", "application/json")


# ---------- 内嵌数据块 ----------

def _brace_slice(s, start):
    """从 s[start] == '{' 起做括号配平（跳过字符串与转义），返回完整 JSON 文本。"""
    depth, i, n, instr, esc = 0, start, len(s), False, False
    while i < n:
        c = s[i]
        if instr:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                instr = False
        else:
            if c == '"':
                instr = True
            elif c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    return s[start:i + 1]
        i += 1
    return None


def _leaves(o, out):
    if isinstance(o, dict):
        for v in o.values():
            _leaves(v, out)
    elif isinstance(o, list):
        for v in o:
            _leaves(v, out)
    elif isinstance(o, str):
        out.append(o)


def embedded_text(body):
    """页面内嵌 JSON 数据块里的全部叶子字符串。"""
    out = []
    for name in BLOBS:
        for m in re.finditer(re.escape(name), body):
            b = body.find("{", m.end())
            if b < 0:
                continue
            blob = _brace_slice(body, b)
            if not blob:
                continue
            try:
                leaves = []
                _leaves(json.loads(blob), leaves)
                out.extend(leaves)
            except Exception:
                pass
    if not out:  # 退路：任何 <script type="application/json"> 块
        for m in re.finditer(r'(?is)<script[^>]+application/json[^>]*>(.*?)</script>', body):
            try:
                leaves = []
                _leaves(json.loads(m.group(1).strip()), leaves)
                out.extend(leaves)
            except Exception:
                pass
    return out


# ---------- 取页面 ----------

def _curl(url, ua):
    r = subprocess.run(["curl", "-sS", "-L", "--max-time", "45", "-A", ua,
                        "-w", "\n__HTTP__%{http_code}", url],
                       capture_output=True, text=True, errors="replace")
    body, code = r.stdout, ""
    m = re.search(r"__HTTP__(\d{3})\s*$", body)
    if m:
        code, body = m.group(1), body[:m.start()]
    return code, body


def fetch(url):
    """先浏览器 UA，文本太薄再退朴素 UA —— 两种来源的要求正好相反。"""
    tried = []
    for ua, label in ((BUA, "browser-UA"), (PLAIN, "plain-UA")):
        code, body = _curl(url, ua)
        tried.append("%s:%s" % (label, code))
        if code == "200" and len(body) > 20000:
            return code, body, label, "; ".join(tried)
        time.sleep(0.6)
    return code, body, label, "; ".join(tried)


def _strip_markup(s):
    """去标记，且不引入原文没有的空格。

    ★ 两个坑，都会把「引文逐字正确」误判成失配（本脚本第一版两个都踩了）：
      · 把**所有**标签都换成空格 → `"<em>Decreases` 变成 `" Decreases`
      · 不删 HTML 注释 → Next.js 在相邻文本节点间插 `<!-- -->`，
        `Contain<!-- -->s` 于是卡在第 8 个字符上
    所以：注释删掉；块级标签换空格（保住词间边界）；行内标签换空串。
    """
    s = re.sub(r"(?s)<!--.*?-->", "", s)
    s = re.sub(r"(?is)</?(?:p|div|li|ul|ol|br|tr|td|th|h[1-6]|section|article"
               r"|table|blockquote|dd|dt|dl|hr)\b[^>]*>", " ", s)
    return re.sub(r"(?s)<[^>]+>", "", s)


def extract(body):
    """HTML → (可见正文, 内嵌数据块叶子串)"""
    vis = re.sub(r"(?is)<(script|style|noscript)[^>]*>.*?</\1>", " ", body)
    return _strip_markup(vis), _strip_markup(" \n ".join(embedded_text(body)))


# ---------- 仓内已钉证据 ----------
# ★ 为什么需要这条腿：Meta 的 policy 页是纯客户端 SPA（正文走 /api/graphql/），
#   今天在本机**没有任何匿名取法**能拿到正文（实测：朴素/浏览器 UA、无斜杠、
#   _fb_noscript、en-gb、print、amp、Firecrawl 渲染、浏览器桥 —— 全部只得到
#   标题与 JS bundle）。但这类页面**早就以证据件形式钉在仓里**了。
#   「今天抓不到」不等于「不可复核」：对着钉住的抓取件核，反而比对着会变的
#   线上页核更硬 —— 只要抬头写明 URL 与抓取日，且 URL 与引用来源一致。

def pin_index():
    """→ {规范URL: [(相对路径, 抓取日), ...]}"""
    idx = {}
    for r in PIN_ROOTS:
        for dp, _dn, fn in os.walk(os.path.join(ROOT, r)):
            for f in fn:
                p = os.path.join(dp, f)
                try:
                    if os.path.getsize(p) > 4_000_000:
                        continue
                    head = open(p, encoding="utf-8", errors="replace").read(3000)
                except Exception:
                    continue
                m = PIN_URL.search(head)
                if not m:
                    continue
                url = m.group(1).rstrip(".,);").rstrip("/")
                d = PIN_DATE.search(head)
                idx.setdefault(url, []).append(
                    (os.path.relpath(p, ROOT), d.group(1) if d else "?"))
    return idx


_PIN_CACHE = {}


def pin_texts(path):
    if path not in _PIN_CACHE:
        body = open(os.path.join(ROOT, path), encoding="utf-8", errors="replace").read()
        vis = re.sub(r"(?is)<(script|style|noscript)[^>]*>.*?</\1>", " ", body)
        _PIN_CACHE[path] = norm(_strip_markup(vis))
    return _PIN_CACHE[path]


# ---------- 比对 ----------

def norm(s):
    s = _html.unescape(s)
    for a, b in (("\u00a0", " "), ("\u2009", " "), ("\u202f", " "),
                 ("\u200b", ""), ("\ufeff", "")):
        s = s.replace(a, b)
    return re.sub(r"\s+", " ", s).strip()


def fold(s):
    """把排版形态折叠成 ASCII —— 用于区分「逐字命中」与「只差弯引号」。"""
    for a, b in (("\u2019", "'"), ("\u2018", "'"), ("\u201c", '"'),
                 ("\u201d", '"'), ("\u2013", "-"), ("\u2014", "-"),
                 ("\u2026", "..."), ("\u02bc", "'")):
        s = s.replace(a, b)
    return s


def ws_fold(s):
    """再折一层**空格位置**。

    ★ 抓取侧剥标签时为保住词间边界，常把标签换成空格；转录时若照抄，
    就会在标点前留下原文没有的空格（`Comparative claims :`、`as “ tests`）。
    这是转录杂质，不是内容差异 —— 但要**报出来让人改**，不能悄悄放过。
    """
    # ★★ 2026-10-13 修：左引号那一条**必须在 `fold()` 之前**跑。
    #   原先它排在 `fold()` 之后 —— 而 `fold()` 已经把弯引号折成直引号
    #   （`\u201c` → `"`），于是这条正则里的 `[\u201c\u2018]` **永远匹配不到**，
    #   那两个分支是**死代码**。代价实测（EXT-040，报了很久的一条"失配"）：
    #     抓取件 `as “tests` ↔ 引文 `as “ tests` —— 只差一个空格，本该判 `ws`
    #     （"转录杂质，应改"），却因为折不动而落进 `miss`（"引文对不上"），
    #     告警于是说成「上游改了，或我们抄错了，先别拿它当依据」——
    #     比真相（一个空格）严重得多，而**没有任何东西会觉得这句话不对**。
    #   为什么顺序反了不会自伤：直引号 `"` `'` 在这一步之后才由 `fold()` 产生，
    #   所以它们**碰不到**这条规则 —— 2026-09-22 那次「误删右引号后空格」的
    #   反向对照（`condition" is not`）逐字保住，见 `ws_selfcheck()`。
    s = re.sub(r"([(\[\u201c\u2018])\s+", r"\1", s)
    s = fold(s)
    return re.sub(r"\s+([:;,.)\]])", r"\1", s)


def classify(q, txt):
    """引文 vs 快照：`exact` / `punct`（只差弯直引号）/ `ws`（只差空格位置）/ `None`（失配）。

    抽成纯函数是为了让**反向对照能直接喂它** —— 判据自己也要被喂坏样本（§2.4.1）。
    ★ 顺序即语义：逐字 → 排版形态 → 空位形态 → 失配。**先严后宽**，
      否则一条只差空格的引文会被记成 `punct`，把真正的诊断盖掉。
    """
    if q and q in txt:
        return "exact"
    if q and fold(q) in fold(txt):
        return "punct"
    if q and ws_fold(q) in ws_fold(txt):
        return "ws"
    return None


# ══════════════════════════════════════════════════════════════════════
# 已裁决的空位差 —— 「报出来让人裁」里**人已经裁过**的那一类（2026-10-13 加）
# ══════════════════════════════════════════════════════════════════════
# `ws` 这一层的语义是「转录杂质，应改」。可杂质有两种来路：
#   ① 我们抄错了                → 改**我们的**文本（默认处置，仍要红）；
#   ② 抓取侧留下的              → 我们的文本是对的，而它逐字对的是**冻结的交付原件**：
#      那件是**被复核对象本身**，回改它等于把被复核的东西改到能过（§2.4 那个形状）。
# ②的正确处置既不是每天红一次没人管，也不是悄悄放过 —— 是**登记裁决**：
# 在这张表里写清「差在哪、为什么是杂质、凭据是什么」，输出里照旧列出来（`已裁决空位差`），
# 但不计入未通过。**判据一个字没松**：
#   · 只有 `ws`（= `ws_fold` 已机械证明差异**只在空格位置**）才可能被这张表认领；
#   · 差一个字母仍是 `None` ⇒ 失配 ⇒ 红（`ws_selfcheck()` 第 3 例钉着）；
#   · 表里的条目**现在**已经不是 `ws` 了 ⇒ 表过期 ⇒ 红（下面那段 `已过期` 判据）。
KNOWN_WS_DIFFS = {
    "EXT-040": {
        # ★ 只在**这一条证据路径**上认领。为什么必须按路径限定：同一条引文换一条路径
        #   就是另一个结论 —— 实测同一天：真抓件（`visible`）上**逐字命中**，
        #   而钉住件（HTML→markdown 的转换件）上只差一个空格。不限定路径的话，
        #   这张表会连带把「真抓件上也多出空格」这种**真问题**一起放过。
        "证据路径": ("pin:",),
        "方向": "钉住件有多余空格、在用件没有（`as “ tests` ↔ `as “tests`）",
        "为什么是杂质": "FTC 页面在 `“` 后紧跟内联标签（`“<em>tests</em>`），"
                    "HTML→markdown 转换时为保住词间边界补了一个空格。"
                    "凭据：`research/kb/_evidence/外部标准库/S14.txt`（本日真抓）与 2026-09-22 起"
                    "30 余份归档抓取件，**每一份**都是 `as “tests`（无空格）。",
        "为什么不改文本": "多余空格在**派生件**里（转换出的 `_evidence/.../ftc-hpcg-landing.md`）"
                      "与**冻结的交付原件**里（`外部标准库-研究稿-交付原件.json`，是被复核对象）；"
                      "**在用件** `外部标准库-v1.json` 已按真抓件订正"
                      "（`$provenance/整合人订正[2]`：`as “ tests` → `as “tests`），与页面逐字一致。",
        "裁决": "2026-10-13 · 判为抓取/转换杂质（逐字内容无差异）；引用以在用件为准",
    },
}


def ws_selfcheck():
    """`ws` 这一层的自证 —— **每次真跑都做**。

    为什么不放进 `--controls`：那个开关**没有任何调用方**（全仓 grep 只命中它自己的帮助文本），
    把判据放进去等于放一句注释。这里每次真跑都算，失败即让结论红（与 `hashed_bad` 同一档）。
    """
    bad = []
    cases = [
        # (名称, 引文, 快照, 期望)
        ("抓取侧在左引号后补的空格 ⇒ 空位杂质（EXT-040 的真实形状）",
         'as “tests, analyses', 'as “ tests, analyses', "ws"),
        ("★ 反向对照：直引号后的空格**不许**被折掉（2026-09-22 自伤过的那一次）",
         'condition" is not', 'condition"is not', None),
        ("★ 反向对照：改一个字母就是内容差异，不许被当成空位杂质",
         'as “tests, analyses', 'as “texts, analyses', None),
        ("标点前多一个空格（`ws_fold` 的另一支）",
         'Comparative claims:', 'Comparative claims :', "ws"),
        ("逐字命中优先于形态层（顺序不许反）",
         'as “tests', 'as “tests', "exact"),
    ]
    for name, q, txt, want in cases:
        got = classify(q, txt)
        if got != want:
            bad.append("%s：期望 %r，实际 %r" % (name, want, got))
    for eid, spec in KNOWN_WS_DIFFS.items():
        for k in ("证据路径", "方向", "为什么是杂质", "为什么不改文本", "裁决"):
            if not spec.get(k):
                bad.append("KNOWN_WS_DIFFS[%s] 缺字段 %s —— 没有凭据的裁决就是免罪符" % (eid, k))
    return bad


# ---------- 快照的保存：内容哈希 · 归档 · 漂移（2026-09-22 加） ----------
#
# 为什么要这三样：快照原先用 `open(path,"w")` **原地覆盖**。于是一次重抓就把上一轮
# 抓到的原文形态抹掉 —— 而它很可能是某条结论的**唯一物证**；更要紧的是，
# **两轮之间没有任何比较**，所以「上游改过没有」这个问题在盘上永远问不出来。
# 这正是 AGENTS.md §2.4.2 那个病的第三个实例：PRD 基线有执行点（prd_baseline.mjs），
# 外部标准库没有。这三样把它补上：哈希（可比）、归档（不丢）、清单（有对象可指）。

def body_of(text):
    """快照文件的**内容部分**（抬头之后）。哈希只比内容 ——
    抬头里的 `# fetched:` / `# ua:` 每轮都会变，比它等于每轮都「漂移」。"""
    return text.partition("\n---\n")[2]


def header_field(text, key):
    m = re.search(r"^#\s*%s\s*:\s*(.+)$" % re.escape(key), text, re.M)
    return m.group(1).strip() if m else None


def sha(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# ---------- 「内容变了」必须比字节小：剔掉每轮都变的构建号/缓存标记 ----------
#
# ★ 2026-09-22 加，代价是**一条发到群里的假警报**，值得逐字记下来。
#
# 当天的每日兜底第一次真跑，报的是「5 个来源的页面内容变了（上游改了别处）」，
# 还按 5 个来源列了「N 条引文依赖它」。而**逐字比新旧快照**之后：
#
#   S7/S8（Meta）   `mdc_common 7688265440281223304` → `…7688273004145341705`
#                   `qplTimingsServerJS …`（同一串 id）—— 是 FB 的**构建版本号**
#   S9/S10（Google）`Main menu 4268957113883546556` → `…9317642305582567200`
#                   —— 页面里的**会话/页面 token**
#   S14（FTC）      `ftc_uswds oiG6f71Ij6BjIq7adkKXWEonDCTy_bhFKpSzRGcjs1U`
#                   → `…JBxSOgNGuRTc8br7PeV9JIwmTmo-XqoNrRlEpTKM-L0` —— **uswds 资产号**
#
# 五处的字节数**一模一样**（43074 / 9387 / 113527→113526 / 113171→113175 / 119432），
# 政策正文一个字没动，62 条引文仍逐字命中。
#
# 也就是说：我把「**字节变了**」说成了「**上游改了**」——**这句话比我的输入大**。
# 这正是 AGENTS.md §2.4.1 那句自检（「这句话比我的输入大吗？」）与 §2.4.3 的形状，
# 只不过这次说出去的是**对外**的话；而抓到它的不是任何一个检查器，是**去读物证**。
#
# 修法：**原样保留快照**（它是引文核对的证据层，不许动），另算一个**归一化指纹** ——
# 只把「每轮都在变的标记」换成占位符之后再哈希。漂移比的是归一化指纹，
# 清单里的 `sha256` 仍是原文的（E4 那条恒等式照旧）。
# 判断力的落点不变：**引文是否仍逐字命中**才是真正的门（失配就红），
# 漂移只是一个提前量 —— 所以宁可对它保守（漏报），也不许它喊狼。
NONCE_PATTERNS = [
    (re.compile(r"(mdc_common|qplTimingsServerJS|__spin_r|__spin_b|__spin_t)\s+\d+"), r"\1 <build>"),
    (re.compile(r"(ftc_uswds|uswds)\s+[A-Za-z0-9_-]{20,}"), r"\1 <asset>"),
    (re.compile(r"(Main menu)\s+\d{10,}"), r"\1 <token>"),
    (re.compile(r"\b\d{15,}\b"), "<longnum>"),          # 15 位以上的连续数字：构建号/token 的通用形状
    # FB 的静态资源 id（`rsrc.php/…/AUGAnqRicBcYpy3k48qdIO5JML4`）：**又一轮真读数**——
    # 上一条规则把 `mdc_common` 挡住了之后，S7/S8 仍报「内容变了」，第一处差异就是它。
    # 形状：≥20 个 [A-Za-z0-9_-]，且**同时**含数字与**大写**字母。
    # （为什么要那两条附加条件：普通正文里 20 个字以上的词不会有这种混合形态，
    #   而 `healthcare-and-medicines-policy` 这种长连字符路径整串小写、不含数字 → 不会被吃掉。）
    (re.compile(r"\b(?=[A-Za-z0-9_-]{20,}\b)(?=[^\s]*[0-9])(?=[^\s]*[A-Z])[A-Za-z0-9_-]{20,}\b"), "<hash>"),
]


def mask_nonces(text):
    """把「每轮都变、但不是内容」的标记换成占位符。**纯函数**（`--controls` 直接喂样本）。"""
    out = text
    for pat, rep in NONCE_PATTERNS:
        out = pat.sub(rep, out)
    return out


def drift_sha(text):
    """归一化指纹：比它 = 「内容变了」；比 `sha` = 「字节变了」（含构建号）。"""
    return sha(mask_nonces(text))


# ---------- 「变的是正文，还是每轮都在变的标记」：词级分类器 ----------
#
# ★ 为什么掩码还不够（2026-09-22 第二轮实测，同一个下午）：
#   掩码挡住了 `mdc_common` 与 `Main menu <token>` 之后，S7/S8 仍然报「内容变了」。
#   再逐字比一次，剩下的差异是：
#       `AUGAnqRicBcYpy3k48qdIO5JML4` → `…JKpk`（FB 静态资源 id）
#       `comet_aa_coinflip:true` → `false`（灰度开关，每次请求随机）
#       `mount_0_0_os` → `mount_0_0_cv`（随机挂载点 id）
#   —— **这就是打地鼠**：这些页面是 JS 渲染的（S1–S8 的「可见正文」只有 6~63 字节，
#   全部内容都在内嵌数据块里），每请求都带一批随机标记。一条条加正则会永远追不上，
#   而且每加一条都在赌下一条的形状。
#
# 换一个**能说出理由**的判据：真实正文改动动的是**句子里的词**，
# 而这类标记是**孤立的整块 token**（不含空白）。所以比**词的多重集差异**：
#   · 变化的 token 全都「无空白、≤80 字符」且占比极小 → 标记类变动，不报警
#   · 否则 → 内容变了，报警
#
# ⚠️ 这条判据的**已知盲区**必须写下来，别假装它是干净的（§2.4）：
#
# **「形状」分不开「正文小改」与「页面标记」。** 我先试过按 token 形状判（「孤立、无空白、
# ≤80 字符」的算标记类），它在两处都栽了：
#   · 那个 3752 字符的 `{"link":[{"@attributes":…` 预加载清单**没有空白** → 形状合格，
#     却被长度上限挡掉，于是整页被判成「内容变了」；
#   · 反过来，FB 每次请求随机给的链路质量标签 `MODERATE → EXCELLENT`
#     **就是两个纯字母单词** —— 与「正文把 must 改成 will」**一模一样**。
# 要分开这两者就得**读懂语义**，而那不是判据能做的事。所以这一层只判**规模**。
#
# 阈值是**读数**，不是拍的：2026-09-22 同一天连跑三次真抓（17 个来源，间隔几分钟），
# JS 渲染页的自然抖动实测为 S7 0.35% / 1.62%、S8 1.59% / 0.25%，其余来源恒 0。
# 5% 是那份实测上限的 ~3 倍。复现：`python3 tools/verify_external.py` 连跑两次，
# 看「只有小幅变动」那一行的占比读数。
#
# 代价两侧都写清楚：
#   · **漏报面**：小于阈值的正文小改**不报警**（它落在自然抖动同一量级里）。
#     兜底是**引文核对本身** —— 我们引用到的 62 句是逐字比的，改了那几句就红；
#     **没被引用的句子**只能靠人过一遍。这是有界的漏报，不是「已经解决了」。
#   · **误报面**：阈值低于实测抖动就会天天喊狼，而喊狼等于把这条链路关掉 ——
#     那比不报警更坏（§2.1.1：一个会误报的检查器会让人开始不看报告）。
CHURN_RATIO_MAX = 0.05       # 变化的词占比上限：5%
CHURN_TOKEN_MAX = 80         # 单个变化 token 的长度上限


def token_diff(a, b):
    """两段文本的**词级**差异：回 `(只在旧里的词, 只在新里的词, 旧词总数, 新词总数)`。

    用多重集差分（`Counter`），所以「同一个词少出现一次」也算变化，不会被当成没变。
    """
    from collections import Counter
    ta, tb = a.split(), b.split()
    ca, cb = Counter(ta), Counter(tb)
    only_a = list((ca - cb).elements())
    only_b = list((cb - ca).elements())
    return only_a, only_b, len(ta), len(tb)


def classify_change(old_text, new_text):
    """纯函数：`'same' | 'churn' | 'content'` + 依据（样例带上，好让人自己看）。

    先掩码再比 —— 掩码处理已知形状（能把样例显示得干净些），分类器处理**没见过的**形状。
    """
    a, b = mask_nonces(old_text), mask_nonces(new_text)
    if a == b:
        return "same", {"tokens": 0, "ratio": 0.0, "samples": []}
    only_a, only_b, na, nb = token_diff(a, b)
    toks = only_a + only_b
    ratio = len(toks) / max(na, nb, 1)
    detail = {
        "tokens": len(toks),
        "ratio": round(ratio, 5),
        # 样例**必须带出去**：判据说「这只是标记类的抖动」时，人得能自己扫一眼推翻它。
        "samples": (["- " + t[:70] for t in only_a[:3]] + ["+ " + t[:70] for t in only_b[:3]]),
    }
    return ("churn" if ratio <= CHURN_RATIO_MAX else "content"), detail


def drift_of(prev, cur):
    """纯函数：两轮的 `{sid: 归一化指纹}` → `(变了, 新增, 消失)`，各自排序。

    拆成纯函数是为了让 `--controls` 能**直接喂坏样本**（§2.1：反向对照只在内存里做）。
    三个返回值必须分开：新来源出现不是「上游改了」，整轮都是新的（第一次跑）
    更不是漂移 —— 把它们混成一个数字，第一天就会报一次假漂移。
    """
    changed = sorted(s for s in set(prev) & set(cur) if prev[s] != cur[s])
    added = sorted(set(cur) - set(prev))
    gone = sorted(set(prev) - set(cur))
    return changed, added, gone


def last_run():
    """读 `_runs.jsonl` 的最后一条。

    回 `{"drift": {sid: 归一化指纹}, "raw": {sid: 原文 sha256}, "why": None|str}`。

    ★ 漂移比的是 `drift`（归一化指纹），不是 `sha256`（原文）。
    ★ 上一轮那一行如果**没有** `drift` 字段（2026-09-22 之前写的），
      整轮漂移就是**未测** —— 拿原文指纹去比归一化指纹，第一天必然全报「变了」，
      而那又是一次「字节变了说成上游改了」。`why` 非空时调用方不许报漂移。
    """
    if not os.path.exists(RUNS):
        return {"drift": {}, "raw": {}, "why": "还没有上一轮清单"}
    try:
        lines = [x for x in open(RUNS, encoding="utf-8").read().strip().split("\n") if x.strip()]
        if not lines:
            return {"drift": {}, "raw": {}, "why": "清单是空的"}
        rec = json.loads(lines[-1])
        src = rec.get("sources") or {}
        raw = {s: v.get("sha256") for s, v in src.items()}
        missing = [s for s, v in src.items() if not v.get("drift")]
        if missing:
            return {"drift": {}, "raw": raw,
                    "why": ("上一轮清单（%s）没有归一化指纹（%d 个来源）—— 这一轮不做漂移对比，"
                            "下一轮起才有" % (rec.get("at"), len(missing)))}
        return {"drift": {s: v["drift"] for s, v in src.items()}, "raw": raw, "why": None}
    except Exception as exc:  # noqa: BLE001
        return {"drift": {}, "raw": {}, "why": "清单读不出（%s）" % exc}


# ---------- 主流程 ----------

def verdict(n_live, n_miss, n_unver, n_pun, n_wsq, n_hit, n_total, n_declared=0):
    """把结论行拆成纯函数 —— 好让 `--controls` 直接断言**这句话本身**不许撒谎。

    与 `verify_prd_baseline.verdict` / `verify_shouheng_ops.verdict` 同口径，
    三种退出码语义互不相同：

    | 码 | 含义 | 它**不**代表 |
    |---:|---|---|
    | 0 | 全部条目**逐字**命中，且今天真抓过上游 | —— |
    | 1 | 有失配 / 不可复核 / 只差排版形态 | —— |
    | 2 | **未测**：今天 0 个来源被真抓（`--offline`，或全部走了已钉快照） | **不等于通过** |

    为什么「0 个来源被真抓」必须是 2 而不是 0：逐字命中在**快照**上验过，
    不等于在**上游**验过。`--offline` 报 ✅ 会说出一句当天确定错误的话
    （「今日抓取」）—— 这正是 §2.4.1 那句自检「这句话比我的输入大吗？」。

    有红且未测时，红优先（与 `verify_shouheng_ops.py` 的 H7 一致：
    **有红时也必须把未测说出来**，否则只看最后一行的人会以为其余都验过了）。
    """
    untested_note = ""
    if n_live == 0:
        untested_note = ("；**另有未测**：今日 0 个来源被真抓，"
                         "逐字命中只在快照上验过、没在上游验过")
    if n_miss or n_unver or n_pun or n_wsq:
        return 1, ("❌ 未通过：失配 %d / 不可复核 %d / 仅差排版形态 %d / 空位形态不齐 %d%s"
                   % (n_miss, n_unver, n_pun, n_wsq, untested_note))
    if n_live == 0:
        return 2, ("⚠️  今日 0 个来源被真抓（`--offline`，或全部走了已钉快照）—— "
                   "**未测**：逐字命中只在快照上验过，没在上游验过。退 2，不是通过。")
    # ★ 2026-10-13：有「已裁决的空位差」时**不许**再说「无空位差」——
    #   结论行是给人看的唯一一行，它说错就等于没查（§2.4.2）。
    if n_declared:
        return 0, ("✅ %d/%d 条在该来源快照中命中（其中 %d 条带**已裁决**的空位差："
                   "只出现在派生证据件上的空格，逐字内容无差异；裁决与凭据见 KNOWN_WS_DIFFS）"
                   % (n_hit, n_total, n_declared))
    return 0, ("✅ %d/%d 条在该来源快照中**逐字**命中（无形态差、无空位差）"
               % (n_hit, n_total))


def controls():
    """反向对照：把已知形状喂进 `verdict()`，断言结论行**不许撒谎**。

    这是 §2.4.1「没红过的断言不算验证过它」的直接落实 ——
    结论行本身也是断言，所以它也要被喂坏样本。
    全部在内存里做，不落盘、不联网（§2.1：反向对照只在内存里做）。
    """
    cases = [
        # (名称, 参数, 期望退出码, 结论行必须含, 结论行必须不含)
        ("全过（今日真抓过）", (17, 0, 0, 0, 0, 62, 62), 0, ["逐字", "命中"], ["未测", "❌"]),
        ("★ --offline：0 个来源被真抓，其余全过",
         (0, 0, 0, 0, 0, 62, 62), 2, ["未测"], ["✅", "今日抓取"]),
        ("有失配", (17, 1, 0, 0, 0, 61, 62), 1, ["失配 1"], ["✅"]),
        ("只差排版形态（punct）", (17, 0, 0, 3, 0, 59, 62), 1, ["排版形态 3"], ["✅"]),
        ("★ 又红又未测：红优先，但必须报出未测",
         (0, 1, 0, 0, 0, 61, 62), 1, ["失配 1", "另有未测"], ["✅"]),
        # ★ 2026-10-13 加：有「已裁决的空位差」时，结论行**必须说出来** ——
        #   原先这里一律印「无空位差」，而 EXT-040 恰恰带着一处（裁决过的）空位差。
        #   断言取的是那句话本身：把 `n_declared` 忽略掉 ⇒ 这一条精确变红。
        ("全过 + 1 条已裁决空位差：必须报出那条，不许写「无空位差」",
         (17, 0, 0, 0, 0, 62, 62, 1), 0, ["已裁决", "1 条"], ["无空位差", "✅ 62/62 条在该来源快照中**逐字**命中"]),
    ]
    # ★ 计数用「有几个 ❌」推出来，**不**用「用例总数 - 通过数」那种算法。
    #   原先写的是 `return 0 if n_ok == len(cases) + len(d_cases) else 1` ——
    #   加了 5 条掩码用例而没把它加进那个和式，于是屏幕上写着「15 项全过」、
    #   进程退的是 1。**结论行与退出码不一致，而没有任何东西变红**（同一小时内第二次：
    #   上一次是 main() 里的结论变量被循环变量覆盖）。判据必须让这两者由**同一个数**决定。
    n_ok, n_bad = 0, 0
    for name, args, want_code, must, must_not in cases:
        code, line = verdict(*args)
        bad = []
        if code != want_code:
            bad.append("退出码 %d ≠ 期望 %d" % (code, want_code))
        for m in must:
            if m not in line:
                bad.append("结论行里没有 %r" % m)
        for m in must_not:
            if m in line:
                bad.append("结论行里不该有 %r" % m)
        if bad:
            n_bad += 1
            print("  ❌ %s\n       %s\n       → %s" % (name, "；".join(bad), line))
        else:
            print("  ✅ %s → 退 %d" % (name, code))
            n_ok += 1
    # ── 漂移判据自己的反向对照（2026-09-22 加）：喂合成哈希对，断言三种情况分开。
    d_cases = [
        ("两轮一致 → 必须闭嘴", {"S1": "a", "S2": "b"}, {"S1": "a", "S2": "b"}, [], [], []),
        ("S1 内容变了 → 必须报出 S1", {"S1": "a", "S2": "b"}, {"S1": "c", "S2": "b"}, ["S1"], [], []),
        ("新来源出现 → 算新增，不算「上游改了」", {"S1": "a"}, {"S1": "a", "S9": "z"}, [], ["S9"], []),
        ("来源消失（本轮没覆盖到）→ 必须说，不许当成没变", {"S1": "a", "S2": "b"}, {"S1": "a"}, [], [], ["S2"]),
        ("第一次跑（上轮为空）→ 一条漂移都不许报", {}, {"S1": "a"}, [], ["S1"], []),
    ]
    # ★ 掩码的正反两面（2026-09-22 加，代价是一条发到群里的假警报）：
    #   「字节变了」不等于「上游改了」—— 必须证明这个判据两边都拦得住。
    m_cases = [
        ("只改了 FB 构建号 → 归一化后必须**没有**变化",
         "abc mdc_common 7688265440281223304 def", "abc mdc_common 7688273004145341705 def", False),
        ("只改了 Google 页面 token → 必须没有变化",
         "Main menu 4268957113883546556 true", "Main menu 9317642305582567200 true", False),
        ("只改了 uswds 资产号 → 必须没有变化",
         "ftc_uswds oiG6f71Ij6BjIq7adkKXWEonDCTy_bhFKpSzRGcjs1U modal",
         "ftc_uswds JBxSOgNGuRTc8br7PeV9JIwmTqo-XqoNrRlEpTKM-L0 modal", False),
        ("**正文真改了一个字** → 必须有变化（否则掩码把一切都吞了）",
         "Healthcare and medicines Policy: ads must not promote", 
         "Healthcare and medicines Policy: ads will not promote", True),
        ("引文那一句里的数字改了 → 必须有变化",
         "255.5 mg per dose", "355.5 mg per dose", True),
    ]
    # 分类器的边界（喂的是**实测那两页的形状**，不是想象的形状）
    c_cases = [
        ("实测自然抖动（S8 那一轮：100/6288 词 = 1.59%）→ 标记类，不报警",
         " ".join(["w%d" % i for i in range(6000)] + ["mount_0_0_os", "sIWBmi2i", "57.144.64.141"]),
         " ".join(["w%d" % i for i in range(6000)] + ["mount_0_0_cv", "YdPvn5zR", "57.144.98.141"]),
         "churn"),
        ("实测抖动上限那一档（S7 那一轮：102/6286 词 = 1.62%）→ 仍是标记类",
         " ".join(["w%d" % i for i in range(6200)] + ["mount_0_0_wq"] * 80),
         " ".join(["w%d" % i for i in range(6200)] + ["mount_0_0_T4"] * 80),
         "churn"),
        ("改掉 10% 的词 → 内容变了（阈值之上的必须报）",
         " ".join("old%d" % i for i in range(1000)),
         " ".join(["new%d" % i for i in range(100)] + ["old%d" % i for i in range(100, 1000)]),
         "content"),
        ("整段换掉 → 内容变了",
         " ".join("old%d" % i for i in range(1000)),
         " ".join("new%d" % i for i in range(1000)),
         "content"),
        ("一字不改 → same",
         "Healthcare and medicines: ads must not promote prescription drugs.",
         "Healthcare and medicines: ads must not promote prescription drugs.",
         "same"),
        ("**已知盲区，明着测**：正文改一个词（must→will）会被判成标记类 —— "
         "所以它靠的是引文核对，不是这一层",
         " ".join(["policy"] * 999 + ["must"]),
         " ".join(["policy"] * 999 + ["will"]),
         "churn"),
    ]
    for name, a_txt, b_txt, want in c_cases:
        got, _d = classify_change(a_txt, b_txt)
        if got != want:
            n_bad += 1
            print("  ❌ 分类判据 %s\n       得到 %r ≠ 期望 %r" % (name, got, want))
        else:
            print("  ✅ 分类判据 %s" % name)
            n_ok += 1
    for name, a_txt, b_txt, want_change in m_cases:
        got_change = drift_sha(a_txt) != drift_sha(b_txt)
        if got_change != want_change:
            n_bad += 1
            print("  ❌ 掩码判据 %s\n       得到「变了吗」=%s ≠ 期望 %s" % (name, got_change, want_change))
        else:
            print("  ✅ 掩码判据 %s" % name)
            n_ok += 1
    for name, prev, cur, w_ch, w_add, w_gone in d_cases:
        got = drift_of(prev, cur)
        if got != (w_ch, w_add, w_gone):
            n_bad += 1
            print("  ❌ 漂移判据 %s\n       得到 %r ≠ 期望 %r" % (name, got, (w_ch, w_add, w_gone)))
        else:
            print("  ✅ 漂移判据 %s" % name)
            n_ok += 1
    total = len(cases) + len(d_cases) + len(m_cases) + len(c_cases)
    print("\n%s 反向对照 %d/%d 项通过（含「原样必须全绿」这一条）"
          % ("✅" if not n_bad else "❌", n_ok, total))
    return 1 if n_bad else 0


def longest_prefix(q, txt):
    """引文在快照里真实存在的**最长前缀**（失配时唯一有用的诊断读数）。"""
    lo, hi = 0, len(q)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if q[:mid] in txt:
            lo = mid
        else:
            hi = mid - 1
    return q[:lo]


def miss_text(snap, pidx, srcs, sid):
    """一个来源这一轮**所有**可比对文本（快照可见正文 + 内嵌块 + 仓内钉住件）拼起来。"""
    vis, emb = snap.get(sid, ("", ""))
    txt = (vis or "") + " " + (emb or "")
    for path, _d in pidx.get(srcs[sid]["url"].rstrip("/"), []):
        txt += " " + pin_texts(path)
    return txt


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--offline", action="store_true", help="只用已钉快照，不联网")
    ap.add_argument("--only", default="", help="只处理这些来源，如 S11,S12")
    ap.add_argument("--json", action="store_true",
                    help="末尾多打一行 `JSON {...}`（机器可读清单；人读明细照旧）")
    ap.add_argument("--manifest-only", action="store_true",
                    help="**只**打那一行 JSON（供 ws_daemon 的每日兜底读）。"
                         "★ 它仍然真抓、仍然逐条核对 —— `manifest` 说的是**输出形态**，"
                         "不是「少做一半检查」；少做一半的那条路是 `--offline`，而它退 2。"
                         "⚠ 它照样写证据层（快照 + `_runs.jsonl` + 归档），见 AGENTS.md §2.4.4")
    ap.add_argument("--controls", action="store_true",
                    help="只跑结论行的反向对照（离线，不读清单、不联网）")
    a = ap.parse_args()

    if a.controls:
        return controls()

    d = json.load(open(DRAFT, encoding="utf-8"))
    srcs = {s["id"]: s for s in d["sources"]}
    entries = d["entries"]
    only = {x.strip() for x in a.only.split(",") if x.strip()}
    os.makedirs(SNAPDIR, exist_ok=True)
    # ★ 必须在写入之前读 —— 写完再读就成了「和这一轮自己比」。
    #   比的是**归一化指纹**（剔掉构建号/缓存标记），见 `mask_nonces` 上面那段实测。
    prev = last_run()
    prev_hashes, prev_why, prev_raw = prev["drift"] or None, prev["why"], prev["raw"]
    run_sources, archived, hashed_bad = {}, [], []
    prev_body, cur_body = {}, {}      # 只有「字节真的变了」的来源才有

    snap, meta = {}, {}
    for sid in sorted(srcs, key=lambda x: int(x[1:])):
        if only and sid not in only:
            continue
        path = os.path.join(SNAPDIR, sid + ".txt")
        if a.offline:
            if not os.path.exists(path):
                meta[sid] = ("(无快照)", 0, "offline")
                continue
            hdr, _, body = open(path, encoding="utf-8").read().partition("\n---\n")
            vis, _, emb = body.partition("\n===EMBEDDED===\n")
            snap[sid] = (vis, emb)
            meta[sid] = ("cached", len(vis) + len(emb), "offline")
            continue
        code, body, ua, tried = fetch(srcs[sid]["url"])
        vis, emb = extract(body)
        vis, emb = norm(vis), norm(emb)
        if code == "200" and len(vis) + len(emb) > 2000:
            snap[sid] = (vis, emb)
            meta[sid] = (code, len(vis) + len(emb), ua + "  [" + tried + "]")
            new_body = "%s\n===EMBEDDED===\n%s" % (vis, emb)
            # ★ 不许覆盖式销毁：内容变了 → 旧件先归档改名（它可能是某条结论的唯一物证）
            if os.path.exists(path):
                old = open(path, encoding="utf-8", errors="replace").read()
                if body_of(old) != new_body:
                    prev_body[sid] = body_of(old)     # 分类器要比「旧正文 vs 新正文」
                    cur_body[sid] = new_body
                    tag = re.sub(r"[^0-9T]", "", header_field(old, "fetched") or "unknown")
                    arc = os.path.join(SNAPDIR, "%s@%s.txt" % (sid, tag))
                    n = 2
                    while os.path.exists(arc):
                        arc = os.path.join(SNAPDIR, "%s@%s.%d.txt" % (sid, tag, n))
                        n += 1
                    os.rename(path, arc)
                    archived.append((sid, os.path.basename(arc)))
            with open(path, "w", encoding="utf-8") as f:
                f.write("# url: %s\n# http: %s\n# ua: %s\n# tried: %s\n"
                        "# visible=%d  embedded=%d\n# fetched: %s\n---\n%s"
                        "\n===EMBEDDED===\n%s"
                        % (srcs[sid]["url"], code, ua, tried, len(vis), len(emb),
                           time.strftime("%Y-%m-%dT%H:%M:%S"), vis, emb))
            # 恒等式：清单里记的 sha256 必须**等于落盘文件的内容 sha256**。
            # 不验这一条，清单就是一份「我打算写什么」的声明，而不是「盘上是什么」的读数。
            back = body_of(open(path, encoding="utf-8").read())
            if sha(back) != sha(new_body):
                hashed_bad.append(sid)
            run_sources[sid] = {
                "sha256": sha(new_body), "drift": drift_sha(new_body),
                "http": code, "ua": ua, "tried": tried,
                "bytes": len(vis) + len(emb),
                "entries": len([e for e in entries if e["source_id"] == sid]),
            }
        else:
            meta[sid] = (code or "ERR", len(vis) + len(emb), ua + "  [" + tried + "]")
        time.sleep(0.8)

    # 今天**真抓过**的来源数：`--offline` 下 17 行来源表全是 `offline`，这里就是 0。
    # 「逐字命中」在快照上成立，不等于在上游成立 —— 所以 0 是**未测**，不是通过。
    n_offline = len([1 for m in meta.values() if str(m[2]) == "offline"])
    n_live = len(meta) - n_offline

    # ── 清单 + 漂移（只在本轮真抓过东西时才写；`--offline` 一行都不许落）
    changed_raw, added, gone = drift_of(prev_hashes or {}, {s: v["drift"] for s, v in run_sources.items()})
    # ── 两层归类（2026-09-22）：
    #   ① 掩码已吸收（原文指纹变了、归一化指纹没变）→ 标记类，不报警；
    #   ② 归一化指纹也变了 → 交给**词级分类器**判「是正文还是标记」。
    #   `prev_why` 非空（上一轮没有归一化指纹）时**一条都不许判** —— 否则又是一次假警报。
    nonce_only, changed, churn_detail = [], [], {}
    if not prev_why:
        for sid in sorted(run_sources):
            if sid not in prev_raw or prev_raw[sid] == run_sources[sid]["sha256"]:
                continue
            if sid not in changed_raw:
                nonce_only.append(sid)
                continue
            cls, det = classify_change(prev_body.get(sid, ""), cur_body.get(sid, ""))
            if cls == "content":
                changed.append(sid)
                churn_detail[sid] = det
            else:
                nonce_only.append(sid)
                churn_detail[sid] = det
        changed = sorted(changed)
    if n_live:
        with open(RUNS, "a", encoding="utf-8") as f:
            f.write(json.dumps({"at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                                "only": sorted(only) or None, "n_live": n_live,
                                "sources": run_sources}, ensure_ascii=False, sort_keys=True) + "\n")

    hit, miss, unver, declared = [], [], [], []
    pidx = pin_index()
    for e in entries:
        sid, q = e["source_id"], norm(e.get("条款原文") or "")
        cands = []
        if sid in snap:
            vis, emb = snap[sid]
            if vis:
                cands.append(("visible", vis))
            if emb:
                cands.append(("embedded", emb))
        for path, date in pidx.get(srcs[sid]["url"].rstrip("/"), []):
            cands.append(("pin:%s@%s" % (path, date), pin_texts(path)))
        if not cands:
            unver.append((e["id"], sid, "无快照(%s)" % meta.get(sid, ("?",))[0]))
            continue
        got = None
        for where, txt in cands:
            k = classify(q, txt)          # 顺序即语义，见 classify() 的注释
            if k:
                got = (where, k)
                break
        if got:
            # ★ 已裁决的空位差：**照旧进 `hit`**（它是命中，只是带一处空位杂质，
            #   计数必须加得起来），但**不进 `wsq`** —— 那一份才驱动红。
            hit.append((e["id"], sid) + got)
            if (got[1] == "ws" and e["id"] in KNOWN_WS_DIFFS
                    and str(got[0]).startswith(tuple(KNOWN_WS_DIFFS[e["id"]]["证据路径"]))):
                declared.append((e["id"], sid, got[0]))
        else:
            miss.append((e["id"], sid, q, None))

    # ── 计数与结论（**在人读明细之前**算好）：`--manifest-only` 要在它们之前就能返回。
    n_vis = len([h for h in hit if h[2] == "visible"])
    n_emb = len([h for h in hit if h[2] == "embedded"])
    n_pin = len([h for h in hit if h[2].startswith("pin:")])
    n_pun = len([h for h in hit if h[3] == "punct"])
    # ★ 这两个列表原先在**人读明细**里才算（`wsq` / `pun`），而 `verdict()` 用得到它们 ——
    #   算到前面来。两处各算一遍就会各自漂移。
    wsq = [h for h in hit if h[3] == "ws" and h[0] not in KNOWN_WS_DIFFS]
    pun = [h for h in hit if h[3] == "punct"]

    # ★ 判据自证（每次真跑都做）：自证本身不过 ⇒ 结论红，且**压过**其余读数
    #   （与 `hashed_bad` 同一档：判据不可信时，别的读数是空的）。
    selfcheck_bad = list(ws_selfcheck())
    # ★ 登记表不许变成免罪符：某条**现在**已经不是 `ws` 了（逐字命中 / 或压根没命中）
    #   ⇒ 这张表过期了，必须删掉那一条 —— 否则它会一直替一条早已修好的条目挡红。
    _declared_ids = {d[0] for d in declared}
    declared_unobserved = []
    for eid, spec in KNOWN_WS_DIFFS.items():
        if eid in _declared_ids:
            continue
        # ★ 登记表**过期**只有一种表现：这一条现在在**登记路径之外**也成了空位差
        #   （说明杂质不只在那一个派生件里 ⇒ 该重新裁一次）。
        #   ⚠️ **不**拿「真抓件上逐字命中」判过期：那正是本登记存在的理由（它本来就对得上），
        #      拿它判过期会**天天误报** —— 实测 `--offline` 下就是这样红的，
        #      而会误报的检查器比没有更糟（§2.1.1）。
        stray = [h for h in hit if h[0] == eid and h[3] == "ws"
                 and not str(h[2]).startswith(tuple(spec["证据路径"]))]
        if stray:
            selfcheck_bad.append("KNOWN_WS_DIFFS[%s] 的登记不覆盖这条路径：%s —— "
                                 "杂质出现在登记之外的证据件上，重新裁一次" % (eid, stray[0][2]))
        else:
            declared_unobserved.append(eid)
    # `verdict()` 是纯函数，放在这里没有副作用。
    code, line = verdict(n_live, len(miss), len(unver), len(pun), len(wsq),
                         len(hit), len(entries), len(declared))
    if hashed_bad:          # 清单自身的恒等式先于一切结论：清单不可信，别的读数是空的
        code, line = 1, "❌ 清单里的 sha256 与落盘文件的内容 sha256 不一致（%s）" % "、".join(hashed_bad)
    elif selfcheck_bad:     # 判据自己的自证不过 —— 与上面同一档
        code, line = 1, ("❌ 判据自证不过（%d 项）：%s" % (len(selfcheck_bad), "；".join(selfcheck_bad)))

    # ── 机器可读清单（2026-09-22 加，Q4-4d）：`ws_daemon` 的每日兜底读这一行。
    #    「上游改过没有」是一个**每天都要问一次**的问题，而它此前只有人能问（计划 §4.1 A3）。
    report = {
        "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "offline": bool(a.offline), "only": sorted(only) or None,
        "n_live": n_live, "n_offline": n_offline,
        "sources": {sid: {"http": v["http"], "sha256": v["sha256"], "drift": v["drift"],
                          "bytes": v["bytes"], "entries": v["entries"],
                          "changed": sid in changed, "nonce_only": sid in nonce_only}
                    for sid, v in sorted(run_sources.items(), key=lambda kv: int(kv[0][1:]))},
        "changed": sorted(changed), "added": sorted(added), "gone": sorted(gone),
        "nonce_only": sorted(nonce_only),
        # 分类依据：变了几个词、占比多少、样例前几条 —— 判据要能被审计，不能只有一句中文
        "churn_detail": {sid: churn_detail[sid] for sid in sorted(churn_detail)},
        "drift_untested": prev_why,
        "archived": {sid: name for sid, name in archived},
        "entries": {"total": len(entries), "hit": len(hit), "visible": n_vis,
                    "embedded": n_emb, "pin": n_pin, "punct": n_pun, "ws": len(wsq),
                    "declared_ws": len(declared),
                    "miss": len(miss), "unverifiable": len(unver)},
        # ★ 已裁决的空位差：连裁决一起给出，读的人不必去翻源码才知道凭什么放过
        "declared_ws_diffs": [{"id": eid, "source_id": sid, "where": where,
                               "方向": KNOWN_WS_DIFFS[eid]["方向"],
                               "裁决": KNOWN_WS_DIFFS[eid]["裁决"]} for eid, sid, where in declared],
        "selfcheck": {"bad": selfcheck_bad},
        "miss": [{"id": eid, "source_id": sid, "prefix": longest_prefix(q, miss_text(snap, pidx, srcs, sid))}
                 for eid, sid, q, _ in miss],
        "unverifiable": [{"id": eid, "source_id": sid, "why": why} for eid, sid, why in unver],
        "hashed_bad": sorted(hashed_bad),
        "verdict": {"code": code, "line": line},
    }
    if a.manifest_only:
        # ★ **只**打这一行：上面的来源表/漂移段/明细全都不打 —— 调用方要的是可解析的读数，
        #   掺进人读文本就得靠正则去捞，那正是「读错字段却安静产出假数据」的形状（§2.4.1）。
        print(json.dumps(report, ensure_ascii=False, sort_keys=True))
        return code

    print("=" * 80)
    print("来源抓取")
    print("=" * 80)
    for sid in sorted(srcs, key=lambda x: int(x[1:])):
        if only and sid not in only:
            continue
        # ★ 这里原来叫 `code` —— 而 `code` 在**上面**已经是「结论退出码」了。
        #   加 `--manifest-only` 时我把结论挪到了这张表之前，于是这个循环变量把结论**覆盖掉**：
        #   屏幕上最后一行写着「退 2，不是通过」，进程真实退出码却是 `sys.exit('cached')` → 1
        #   （Python 对非 int 的 exit 参数会把它打到 stderr 并退 1）。
        #   **结论行与退出码不一致，而没有任何东西变红。** 这就是 §2.2 第 6 条
        #   （`$?` 取到的不是你以为是那个）的同一个形状，只是换成了 Python 变量。
        hcode, ln, note = meta.get(sid, ("-", 0, "-"))
        n = len([e for e in entries if e["source_id"] == sid])
        print("%s%-4s http=%-5s text=%-8d 条目=%-3d %s"
              % ("OK " if sid in snap else "!! ", sid, hcode, ln, n, note[:62]))
    print()

    # ── 漂移段（2026-09-22 加）：上游改过没有 —— 这是此前**完全没有**的读数。
    #    在此之前快照是覆盖写的，所以「上一轮长什么样」在盘上不存在，这个问题问不出来。
    if n_live:
        if prev_hashes is None:
            print("· 这一轮不做漂移对比：%s（**未测**，不是「没变」）"
                  % (prev_why or "首次记录清单（%s）" % os.path.basename(RUNS)))
        else:
            if nonce_only:
                print("· 另有 %d 个来源**只有标记类变动**（构建号/缓存号/灰度开关）：%s —— 不计入漂移"
                      % (len(nonce_only), "、".join(nonce_only)))
                for sid in nonce_only[:3]:
                    det = churn_detail.get(sid) or {}
                    if det.get("samples"):
                        print("    %s：变了 %d 个词（占 %.4f%%）　%s"
                              % (sid, det.get("tokens", 0), 100 * det.get("ratio", 0),
                                 " ｜ ".join(det["samples"][:2])))
            note2 = "、".join("%s（%d 条依赖它）" % (s, len([e for e in entries if e["source_id"] == s]))
                             for s in changed)
            print("· 与上次抓取相比：内容变了 %d 个来源%s；本轮新覆盖 %d；本轮未覆盖 %d"
                  % (len(changed), ("：" + note2) if note2 else "", len(added), len(gone)))
            if changed:
                print("  ⚠ 变了不等于我们抄错：条目仍逐字命中 = 上游改了别处；失配 = 见下面明细")
        for sid, name in archived:
            print("  ↳ %s 的旧快照已归档改名：%s" % (sid, name))
    if hashed_bad:
        print("\n❌ 清单里的 sha256 与落盘文件的内容 sha256 不一致（%s）—— "
              "清单不可信，先修这个再看别的结论" % "、".join(hashed_bad))
        return 1

    print("=" * 80)
    # ★ 口径必须自己说出来：`--offline` 下写「今日抓取」是一句**当天确定错误**的话。
    src_desc = ("今日抓取" if n_live else
                "**已钉快照（今日 0 个来源被真抓 —— 上游本次未测）**")
    print("逐条核对：命中 %d（%s：可见正文 %d / 仅内嵌数据块 %d；仓内钉住证据 %d）"
          "  已裁决空位差 %d  失配 %d  不可复核 %d  —— 共 %d 条"
          % (len(hit), src_desc, n_vis, n_emb, n_pin, len(declared), len(miss), len(unver), len(entries)))
    # 加法必须闭合：命中 + 失配 + 不可复核 == 全部条目。差一条就说明分类里有东西掉了。
    if len(hit) + len(miss) + len(unver) != len(entries):
        print("⚠ 计数不闭合：命中 %d + 失配 %d + 不可复核 %d ≠ 共 %d 条"
              % (len(hit), len(miss), len(unver), len(entries)))
    print("=" * 80)
    if n_pin:
        print("\n· 靠仓内钉住证据命中的（今日无匿名取法拿到正文，改对钉住抓取件核）：")
        for eid, sid, where, _ in [h for h in hit if h[2].startswith("pin:")]:
            print("    %-8s %-3s %s" % (eid, sid, where[4:]))
    if declared_unobserved:
        print("\n· ⚠ 已裁决登记表里这些本轮**没观察到空位差**（可能未测、也可能派生件已修好）—— "
              "若杂质出现在登记之外的证据件上，会判「登记不覆盖」：%s" % "、".join(declared_unobserved))
    if declared:
        print("\n· 已裁决的空位差（不是内容差异；裁决与凭据见 `tools/verify_external.py` 的 KNOWN_WS_DIFFS）：")
        for eid, sid, where in declared:
            print("    %s（%s，%s）%s" % (eid, sid, where, KNOWN_WS_DIFFS[eid]["方向"]))
    if wsq:
        print("\n· 空位形态不齐（标点前/引号后多了原文没有的空格）—— 属转录杂质，应改：")
        for eid, sid, where, _ in wsq:
            print("    %s（%s，%s）" % (eid, sid, where))
    if pun:
        print("\n· 仅差排版形态（页面是弯引号，引文写成直引号）—— 逐字引用应当改回页面形态：")
        for eid, sid, where, _ in pun:
            print("    %s（%s，%s）" % (eid, sid, where))
    if miss:
        print("\n❌ 失配明细（最长可匹配前缀 = 引文在快照中真实存在的部分）")
        for eid, sid, q, _ in miss:
            txt = miss_text(snap, pidx, srcs, sid)
            print("\n  %s（%s）" % (eid, sid))
            print("    引文：%s" % q[:160])
            print("    快照中能对上的只到：%r" % longest_prefix(q, txt)[-70:])
    if unver:
        print("\n⚠ 不可复核（来源未取到快照）")
        for eid, sid, why in unver:
            print("    %s（%s）%s" % (eid, sid, why))
    print()
    # ★ 门必须能红：`punct` / `ws` 是**诊断层**，不是通过层。
    #   第一版把它们算作命中，于是在同一轮里掩盖了我自己造成的一次回归
    #   （批量空格正则删掉了右引号后的空格，条目从 exact 掉到 ws，而 exit 仍是 0）。
    #   逐字引用是这库的全部价值 —— 差一个字符就该红，并且要红得说明差在哪一层。
    #
    # ★ 第二版修的（2026-09-22）：**`--offline` 下 0 个来源被真抓，却退 0 报 ✅**，
    #   汇总行还写着「今日抓取：可见正文 38」。这与 `AGENTS.md` §2.4.2 记的那次事故
    #   是同一个形状 —— 那个脚本第一次运行就把「一次网络都没发」报成了「16 项全过」。
    #   同一个病活在同一个仓库的另一个检查器里。修法同款：结论行拆成纯函数，
    #   让反向对照能**直接断言这句话本身不许撒谎**。
    print(line)
    if a.json:
        print("JSON " + json.dumps(report, ensure_ascii=False, sort_keys=True))
    # ★ 「结论行说的」必须与「真退出去的」是同一个数。
    #   2026-09-22 实测过一次不一致：结论变量 `code` 被下面循环的同名变量覆盖成 `'cached'`，
    #   屏幕上写着「退 2」，`sys.exit('cached')` 实际退 1，而**没有任何东西变红**。
    #   一个不会红的检查器比没有检查器更糟（§2.1.1）—— 所以这里加一道最便宜的闸。
    if not isinstance(code, int):
        raise SystemExit("verify_external: 结论退出码被别的变量覆盖了：%r" % (code,))
    return code


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""会话蒸馏 · 公共常量与工具。

运行解释器：本仓约定 `python3`（系统 3.9.6，实测带 `zstandard`）。
本机**没有 `zstd` CLI**（AGENTS.md §2.2 第 5 条那类坑：它不在时输出是空的、rc=127，
和「扫完了、没命中」长得一模一样）—— 所以一律走 Python 的 `zstandard`，不走 shell。

产物分级（依据 ADR-0013 §三，不新增分级）：
  L1 入历史      → `PMO/会话蒸馏-20261015/`（契约 / 台账 / 判定 / 候选 / 卡片 / 补丁 / 报告）
  L2 入盘不入历史 → 该目录下的 `_evidence/`（已被 `.gitignore:50` 的 `**/_evidence/` 覆盖）
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
SESSIONS_ROOT = Path.home() / ".dsh" / "sessions"

RUN_DIR = REPO / "PMO" / "会话蒸馏-20261015"
EVIDENCE = RUN_DIR / "_evidence"          # L2 · 被 .gitignore 覆盖
RAW_DIR = EVIDENCE / "raw"                # 逐会话规范化原文
WATERMARK = EVIDENCE / "watermark.json"   # 水位线：跑到哪儿了

LEDGER = RUN_DIR / "台账-v1.ndjson"        # L1
JUDGED = RUN_DIR / "正误判定-v1.ndjson"     # L1
ROUTED = RUN_DIR / "入库候选-v1.ndjson"     # L1

# ── 会话来源筛选 ──────────────────────────────────────────────────
# 工作区标识（DSH 把 cwd 里的 `/` 与不可打印字符转义成 `-<HEX>-`）
WS_AUDIT = "audit_multi_content"
WS_KB_PROJECT = "~77E5~8BC6~5E93"   # 「知识库」三个字的转义

# 临时沙箱（子 agent / 评测出题）—— **本轮排除**：
# 它们的「用户」是出题脚本扮演的、每条会话只有一句话，收进来等于把出题噪声当对话案例。
WS_SANDBOX_PREFIX = "--private-tmp-"

# ── 系统注入前缀黑名单 ─────────────────────────────────────────────
# 会话里 `source.kind == 'user'` 的记录**不全是人话** —— DSH 把系统提示、
# 技能目录、运行时快照也写成 user/message。判据是 source.kind，不是 role。
# 这份名单抄自 `skill-test/self-distiller/pipeline/common.py` 的 SYSTEM_PREFIXES，
# 它在那边是 S2b 误杀复查时从残留里挖出来的，漏一条就会把系统提示当成你说的话。
SYSTEM_PREFIXES = (
    "You are a DSH",
    "Current runtime context",
    "<system-reminder>",
    "<skill_content",
    "<available_skills>",
    "<noema-memory>",
    "[genui-action]",
    "<command-",
    "A skill is a reusable",
    "You are repeating",
    "Background subagent",
    "This is an automatically generated checkpoint",
    "<goal_round>",
    "background job ",
    "# AGENTS.md",
    "Workspace instruction budget",
)

# ── 「人当场纠正 / 确认」的措辞（源①）──────────────────────────────
# ★★ 第一版是裸关键词表，抽样时当场抓到三类**假阳性**，全是判据写错（不是数据问题）：
#   · `为什么` —— 「视频为什么不适用？」是**提问**，不是纠正 ⇒ 已删。
#   · `行`     —— 「继续恢复运**行**」/「执**行**」里全是它 ⇒ 单字一律不收。
#   · `可以`   —— 「**不**可以」被读成了确认 ⇒ 加否定护栏 `CONFIRM_NEGATION`。
#   一条判据的假阳性会**凭空产出正例**，而假正例与真正例长得一模一样、没有任何东西会红
#   （AGENTS.md §2.4.1）。所以这里一律收**短语**，且确认要过否定护栏。
CORRECTION_PATTERNS = (
    r"答非所问", r"回答?错", r"不对", r"错了", r"搞错",
    r"不符合?", r"没按", r"没有按", r"没按照",
    r"怎么又", r"复现", r"重新(?:做|输出|生成|跑|发|来|写)",
    r"有问题", r"跑偏", r"遗漏", r"漏了", r"没说清?", r"没写",
    r"我说的是", r"不是这个意思", r"不是我要的", r"再说一遍", r"重新检查",
    r"变成纯文本", r"格式不符", r"没生效", r"没有生效", r"还是老样子",
    # ── 以下六条是**覆盖率抽查**（`覆盖率抽查-v1.md`）补的 ──
    #   抽检「待人工复核且带下一句人话」的 40 条，16 条含我的判据漏掉的纠正措辞，
    #   其中几条是硬纠正。补的是**形状**，不是把可疑词一股脑塞进来。
    r"马上恢复", r"回滚到?", r"立即恢复",          # 命令式恢复 = 明确纠正
    r"又开始", r"又(?:是)?很慢", r"又慢了",          # 回归类（"又开始弹chrome了"）
    r"不按(?:照)?[^，。！？]{0,8}(?:格式|要求|prd|PRD|规则)",
    r"不是[^，。！？]{0,14}[，,]是",                 # 「不是 X，是 Y」纠正读法
)
CONFIRM_PATTERNS = (
    # 强确认：人在**评价产出**（「你做得对」）
    r"没问题", r"可以了", r"可以的", r"对的", r"正是", r"就这样", r"很好",
    r"通过了", r"已通过", r"审核通过", r"验收通过",
    # 弱确认：人在**同意方案**（「照这个做」）—— 它确认的是方向，不是产出质量
    r"同意", r"照这个", r"就这样做", r"收到了", r"明白了",
    # ★ 「通过」曾写成裸词 ⇒ 匹配到「提高**通过**率」「L0 层本来就**通过**评测了」⇒ 收成完整短语。
    # ★ 强弱必须分开：把「同意你的建议」当「你产出正确」的证据，是**把方向认可读成质量认可**。
    # ★ 「对的?」曾写成允许省略「的」⇒ 匹配到「**对**齐数据…」；
    #   「可以了?」同理 ⇒ 匹配到「我**可以**到飞书侧验证了**吗**？」。
    #   单字级通配在中文里等于没有判据 —— 一律收成完整短语。
    # ★ 「继续」「开始执行」曾在表里，实测是**指令不是确认**
    #   （「从断点处继续恢复运行」被读成「人确认做得对」）⇒ 已删。
)
# 强确认（评价产出）与弱确认（同意方案）分表 —— 它们证明的**不是同一件事**
CONFIRM_STRONG = (
    r"没问题", r"可以了", r"可以的", r"对的", r"正是", r"就这样", r"很好",
    r"通过了", r"已通过", r"审核通过", r"验收通过",
)
# ── 自认错误（源② 的第三种读数）──────────────────────────────────
# ★ 加它的起因是**覆盖率抽查**（`覆盖率抽查-v1.md`）：抽 611 条「链没给结论、人也没纠正」的案例，
#   发现里面藏着真纠正 —— 但**证据在我的回应里，不在人的话里**：
#     人：「「80 条」不是prd的任务，不要理」
#     我：「我上一轮把它当成了知识库进度写进去了——那是操作批次，不是这张表要跟的功能」
#   我原来的判据只看**人话**，于是这一类（自认）**一条都收不到**。
#   它是可回源的（引文逐字在 response 里），但它是**我自己的声明**，不是外部裁定
#   ⇒ 一律标 `需人工确认`，不单独定正误（验收契约 §三）。
SELF_ADMIT_PATTERNS = (
    r"我(?:上一轮|刚才|之前|前面|上一步|此前)[^。！？]{0,26}"
    r"(?:做错|搞错|弄错|写错|判错|错了|误|不该|当成|漏了|没按|下了结论)",
    r"我(?:确实|的确|这里)?(?:说错|写错|判错|搞错|漏了|弄错了)",
    r"我把它当成",
    r"公平的质疑",
    r"你说得对",
    r"这(?:是|属于)我(?:的)?(?:错|问题|疏忽)",
)

# 疑问护栏：命中的措辞若落在**疑问小句**里，一律不算
#   ——「视频为什么不适用？」「还需要把 80 个全部重新跑吗？」都是提问，不是纠正。
QUESTION_RE = re.compile(r"[？?]|吗[，。！!]?$|呢[，。！!]?$")
# 否定护栏：命中它的下一句**一律不算确认**（否则「不可以」=「可以」）
CONFIRM_NEGATIONS = (
    r"不可以", r"不行", r"不同意", r"没通过", r"不能", r"不要", r"不用",
    r"不需要", r"不对", r"没好", r"没完成", r"还有问题",
)
# 兼容旧名（别的脚本仍可能 import）
CORRECTION_MARKERS = CORRECTION_PATTERNS
CONFIRM_MARKERS = CONFIRM_PATTERNS

# ── 「链自己的红」（源②）────────────────────────────────────────────
# ★ 这里踩过一次**极性读反**的坑，留痕（2026-10-15，S2 自证 T7 抓到的）：
#   第一版把 `红 0` / `审计红` 写成了红灯标记 —— 而链跑**绿**的时候写的正是
#   「四道审计红 0」。于是「全绿」会被判成「红」，方向正好相反。
#   判据改成：**红 + 非零数**才是红；`红 0` 单独收进 GREEN_PATTERNS。
#
# ★★ 同日第二次、第三次同形状的错（S3 跑完看分布才发现的，1119 处「红」里真红只有 25 处）：
#   · `NEEDS_INPUT` / `coverage_not_covered` 被当成红 —— 它们是**拒答**，
#     库自己的口径是「这不是素材有问题，是库对该题材没有可依据的条款」
#     （`regression-set.yaml` 把 20 条拒答单列成 `fragile`：「改了是进步，不是回归」）。
#   · `库忙` / `认领被占` / 退出码 3 被当成红 —— `kb/l8/review_run.sh:28` 原文：
#     「3=认领被占（库忙 —— **不是**闸门红）」。
#   ⇒ 三类信号**各自单列**，谁也不许冒充谁。判据的极性错一次，
#     整份分布就整体反向，而它看起来只是一行正则。
RED_PATTERNS = (
    r"(?:闸门|审计|gate)\s*红\s*[:：=]?\s*([1-9]\d*)",   # 「审计红 2」「闸门红：1」
    r"退\s*[45]\b", r"退出码\s*[45]\b", r"exit\s*[45]\b",  # 层闸门红 / 审计红
    r"退\s*1\b",                                          # 基线漂移 / 到期未收
)
# 拒答（引擎说「我判不了」）—— **不是**链的错，是库的覆盖缺口
REJECT_PATTERNS = (
    r"\bNEEDS_INPUT\b",
    r"coverage_not_covered",
    r"覆盖缺口",
    r"(?:被|遭)\s*拒\s*答",
)
# 库忙（并发认领被占）—— **不是**红，也不是拒答；它是环境噪声，单独登记
BUSY_PATTERNS = (
    r"认领被占", r"库忙",
    r"退\s*3\b", r"退出码\s*3\b", r"exit\s*3\b",
)
GREEN_PATTERNS = (
    r"(?:闸门|审计|gate)\s*红\s*[:：=]?\s*0\b",
    r"四道审计红\s*0", r"全绿", r"闸门全绿",
)

VERDICTS = ("PASS", "REVIEW", "BLOCK", "NEEDS_INPUT")


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def sha256_text(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def read_ndjson(path: Path):
    if not path.exists():
        return
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                yield json.loads(line)


def write_ndjson(path: Path, rows) -> int:
    """整份重写（这些台账都是**派生物**，可由上游重算，不需要 append-only）。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with path.open("w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
            n += 1
    return n


def write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)


def write_md_plain(path: Path, text: str) -> dict:
    """往 `.md` 写正文，**并自证没落成 +4096 信封**。

    为什么不能直接 `path.write_text()`（2026-10-15 实测踩到）：
    python 的 `open(p,"w")` 在这台机器上写 `.md` 会落成 **4096 字节信封**
    （python 侧 getsize 7787 / node 侧 readFileSync 3691，差值恒 4096），
    于是 `read` 工具与宿主 Electron 侧读到的都是信封 —— 「文件看起来是好的」，
    而读它的人打不开。配方（仓里 `PMO/填充态-环境特性-实测史.md` 记的那条）：
    **python 写无扩展名临时件 → `/bin/cp` 落到目标 → 两个通道读回比对**。

    返回 `{"python_bytes":…, "node_bytes":…, "ok": bool}`；`ok=False` 时**不要**当成功。
    """
    import subprocess, tempfile
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".mdplain-", dir=str(path.parent))
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
    subprocess.run(["/bin/cp", tmp, str(path)], check=True)
    os.unlink(tmp)
    py_bytes = path.stat().st_size
    out = subprocess.run(
        ["node", "-e", "process.stdout.write(String(require('fs').statSync(process.argv[1]).size))",
         str(path)], capture_output=True, text=True, check=True).stdout
    node_bytes = int(out)
    return {"python_bytes": py_bytes, "node_bytes": node_bytes,
            "ok": py_bytes == node_bytes and py_bytes > 0}


def is_human_message(rec: dict) -> bool:
    """人话的判据是 `data.source.kind == 'user'`，**不是** `role == 'user'`。

    实测：DSH 把系统提示、技能目录、运行时快照也写成 `user/message`，
    它们的 `source.kind` 是 `plugin` / `system` 等。只看 role 会把整份系统提示
    当成你说的话（`self-distiller` 的 F1/F2 就是为这个加的）。
    """
    if rec.get("type") != "user/message":
        return False
    data = rec.get("data") or {}
    src = data.get("source") or {}
    if src.get("kind") != "user":
        return False
    parts = []
    for c in data.get("content") or []:
        if c.get("type") == "text":
            parts.append(c.get("text") or "")
    text = "\n".join(parts).strip()
    if not text:
        return False
    for p in SYSTEM_PREFIXES:
        if text.startswith(p):
            return False
    return True


def user_text(rec: dict) -> str:
    data = rec.get("data") or {}
    return "\n".join(
        (c.get("text") or "") for c in (data.get("content") or []) if c.get("type") == "text"
    ).strip()


def assistant_texts(rec: dict):
    """取 assistant/message 里的正文（丢掉 reasoning 与 tool-call，它们不是结论）。"""
    msg = (rec.get("data") or {}).get("message") or {}
    out = []
    for c in msg.get("content") or []:
        if c.get("type") == "text":
            t = (c.get("text") or "").strip()
            if t:
                out.append(t)
    return out


def assistant_tool_calls(rec: dict):
    msg = (rec.get("data") or {}).get("message") or {}
    out = []
    for c in msg.get("content") or []:
        if c.get("type") == "tool-call":
            out.append({"name": c.get("name"), "args": (c.get("arguments") or "")[:400]})
    return out


def trim(s: str, n: int) -> str:
    return s if len(s) <= n else s[:n] + "…"


def find_verdicts(text: str):
    """从一段文本里找三态结论词 —— 只做**出现性**统计，不当判据用。"""
    return [v for v in VERDICTS if re.search(r"\b" + v + r"\b", text)]


def _matches(patterns, text):
    out = []
    for pat in patterns:
        m = re.search(pat, text)
        if m:
            out.append(m.group(0))
    return sorted(set(out))


def find_reds(text: str):
    """源② 的**真红**读数（层闸门红 / 审计红 / 退出码 4·5 / 退 1）。"""
    return _matches(RED_PATTERNS, text)


def find_rejects(text: str):
    """**拒答**读数 —— 引擎说「我判不了」。它是库的覆盖缺口，不是链的错。"""
    return _matches(REJECT_PATTERNS, text)


def find_busy(text: str):
    """**库忙**读数（认领被占 / 退出码 3）—— 环境噪声，既不是红也不是拒答。"""
    return _matches(BUSY_PATTERNS, text)


def find_greens(text: str):
    """链自报全绿的读数 —— 它和红是**两回事**，收在同一处免得再读反一次。"""
    return _matches(GREEN_PATTERNS, text)


def _clauses(text: str):
    """按句末标点切小句 —— 判「这句是不是提问」的最小单位。"""
    return [c for c in re.split(r"[。！!？?；;\n]+", text or "") if c.strip()]


def _matches_declarative(patterns, text):
    """只在**陈述小句**里匹配：落在疑问小句里的命中一律丢掉。

    ★ 加它的起因是抽检抓到的两个假阳性：
      ① 判反例 —— 下一句是「视频为什么**不适用**？」，是提问不是纠正；
      ② 判正例 —— 下一句是「我还**可以**到飞书侧验证了**吗**？」，也是提问。
    提问与结论在中文里靠标点分，不靠措辞分 —— 所以护栏必须落在小句上。
    """
    out = []
    for c in _clauses(text):
        if QUESTION_RE.search(c):
            continue
        out.extend(_matches(patterns, c))
    return sorted(set(out))


def find_correction(text: str):
    """人当场纠正的措辞。返回命中的**短语**（不是单字），且只收陈述句。"""
    return _matches_declarative(CORRECTION_PATTERNS, text)


def confirm_strength(markers):
    """把确认措辞分成「评价产出」与「同意方案」——**强弱的对象不同，不能混**。"""
    strong = [m for m in markers if any(re.fullmatch(p, m) for p in CONFIRM_STRONG)]
    return "强" if strong else ("弱" if markers else None)


# 弱自认：可能是「同意你新提的点」而不是「我上一步错了」—— 实测 171 条里 79 条是这一类
SELF_ADMIT_WEAK = (r"你说得对", r"公平的质疑")


def self_admit_strength(hits):
    """强 = 明说「我上一轮错了」；弱 = 「你说得对」这类，需人扫一眼。"""
    if not hits:
        return None
    return "弱" if all(any(re.fullmatch(w, h) for w in SELF_ADMIT_WEAK) for h in hits) else "强"


def find_self_admit(text: str):
    """在**我的回应**里找自认错误的句子 —— 它是源② 的补充读数，不是独立判据。"""
    return _matches(SELF_ADMIT_PATTERNS, text)


def find_confirm(text: str):
    """人当场确认的措辞。

    两道护栏，缺一条都会凭空产出正例：
      ① **否定护栏** —— 整句里有「不可以 / 不行 / 不同意 / 没通过 …」⇒ 整句不算确认；
      ② **疑问护栏** —— 命中落在疑问小句里 ⇒ 丢掉。
    """
    if not text:
        return []
    if _matches(CONFIRM_NEGATIONS, text):
        return []
    return _matches_declarative(CONFIRM_PATTERNS, text)

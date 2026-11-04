#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
verify_prd_baseline.py —— 上游 PRD 基线漂移检测（只读）

## 为什么需要它（2026-09-21）

2026-09-21 11:51 上游在群里明确说《内容审查 Agent PRD》v1.0
**「我后续会基于评估重新修改」**。也就是说：

> **这份基线会漂，是一件已经被预告的事，不是假设。**

而当时仓库里有的是：

| 有什么 | 在哪 |
|---|---|
| 拉正文的命令 | `python3 tools/lark_find.py readdoc <docx_token>` |
| 记了指纹的文件 | `PRD/feishu/索引-v1.json`（token / 字数 / sha256 / 字节数） |
| **会在它改版时变红的东西** | **没有** —— 那两个 sha256 全仓零消费者（grep 只命中它自己） |

所以「改版后重新拉一次基线并记新指纹」当时是一句**没有执行点的承诺**
（`AGENTS.md` §2.4：写进文档的每一条约束，必须能指出是哪一行在拦它）。
本脚本就是那一行。

## 三层判据，且**未测与通过必须长得不一样**（§2.4.1 第 4 行）

| 层 | 判据 | 要联网 | 红了说明什么 |
|---|---|---|---|
| **L1 结构** | 索引可解析、字段齐、副本存在 | 否 | 索引本身坏了/被改残了 |
| **L2 副本 = 指纹** | 落盘文件的 sha256 / 字节数 / 正文字数 == 索引读数 | 否 | **本地这一份被人动过**（或被 +4096 填充，见 §2.1） |
| **L3 上游 = 指纹** | 重拉 `raw_content` 的 sha256 == 索引读数 | 是 | **上游改版了** ← 本脚本存在的理由 |

**退出码**：`0` 全绿（含 L3 已测）· `1` 有红 · `2` **L3 未测**（网络/凭据不可用）。
`2` 不是通过 —— 把「我没测」报成「没问题」，正是 §2.4.1 那张表第 4 行的病。

## ★ 本脚本**只报不改**

红的动作是**人去重拉并记新指纹**，不是脚本自己把索引改成新值。
自动改写等于把「漂移」这件事抹掉 —— 而漂移本身就是本脚本要交出来的那个事实
（同 `verify_depad.py` 的 `--fix` 不同：那里的修复不销毁证据，这里会）。

## ★ 本脚本的盲区（写出来，免得它被当成「基线没问题」的全部证据）

它比的是**内容**（sha256 / 字数 / 字节数）。而本环境还有另一类故障是**内容对、视图不对**：
用 **Python 写出**的文件，shell 侧（`ls -l` / `wc -c` / `stat -f %z`）报的字节数会比
Python 实读的多 **4096**，`read` 工具据此判成 `binary file` —— **正文一个字读不出来**（§2.1）。
**B1–B3 对这类文件全是绿的**，因为字节确实没变。

**实测（2026-09-21，本脚本自己的反向对照干出来的）**：为了验证 B1 会红，我用
`Path.write_bytes()` 把 `PRD/feishu/内容审查Agent-PRD-v1.0.md` 改一个字节再改回来。
sha256 复原了、本脚本全绿 —— **但那个文件已经变成填充态**：

```
ls -l : 18710    wc -c : 18710    stat -f %z : 18710
python open().read() : 14614      索引 size_bytes : 14614      sha256 一致
```

是 `verify_depad.py` 抓到的，不是本脚本。**所以：动过 `PRD/feishu/` 之后必须另跑
`python3 tools/verify_depad.py`。**（更稳的做法：反向对照只在内存里做 —— `--controls` 就是
这么设计的；非要动盘就用 shell 的 `cp`/`sed`，别用 Python。）

用法：
  python3 tools/verify_prd_baseline.py              # L1 + L2 + L3
  python3 tools/verify_prd_baseline.py --offline    # 只 L1 + L2（不联网；**退出码 2**，L3 未测）
  python3 tools/verify_prd_baseline.py --controls   # 离线反向对照：断言每条判据真会红
  python3 tools/verify_prd_baseline.py -v           # 逐条打印通过项
"""

import argparse
import datetime
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE_DIR = ROOT / "PRD" / "feishu"
INDEX = BASE_DIR / "索引-v1.json"
CRED = Path(os.path.expanduser("~/.dsh/credentials/shouheng-lark.json"))
API = "https://open.feishu.cn/open-apis"

REQUIRED_FIELDS = ("file", "obj_token", "sha256", "chars", "size_bytes")


# ─────────────────────────── 纯判据（可离线喂样本，controls 靠它） ───────────────────────────

def judge(rec, disk, live):
    """纯函数：给定「索引读数 rec / 落盘字节 disk / 现场正文 live」，逐条判定。

    ★ 为什么拆成纯函数：反向对照要能在**不联网、不动盘**的前提下把已知坏样本喂进来，
      证明每条判据真会红。一个不会红的断言不算验证过它（§2.4.1）。
      `disk=None` = 副本不存在；`live=None` = 没测（未测 ≠ 通过）。
    """
    out = []          # (组, 断言名, ok, 详情)

    # ── L1 结构
    out.append(("L1", "A1 索引项有 obj_token", bool(rec.get("obj_token")),
                f"obj_token={rec.get('obj_token')!r}"))
    out.append(("L1", "A2 索引项有非空 sha256",
                isinstance(rec.get("sha256"), str) and len(rec.get("sha256") or "") == 64,
                f"sha256={str(rec.get('sha256'))[:16]}…"))
    out.append(("L1", "A3 索引项字段齐",
                all(k in rec for k in REQUIRED_FIELDS),
                "缺：" + (", ".join(k for k in REQUIRED_FIELDS if k not in rec) or "无")))
    out.append(("L1", "A4 副本存在", disk is not None, "PRD/feishu/" + str(rec.get("file"))))

    dsha = hashlib.sha256(disk).hexdigest() if disk is not None else None

    # ── L2 副本 = 指纹（离线）
    out.append(("L2", "B1 副本 sha256 = 索引指纹", disk is not None and dsha == rec.get("sha256"),
                f"索引 {str(rec.get('sha256'))[:16]}… / 落盘 {(dsha or '—')[:16]}…"))
    out.append(("L2", "B2 副本字节数 = size_bytes",
                disk is not None and len(disk) == rec.get("size_bytes"),
                f"索引 {rec.get('size_bytes')} / 落盘 {len(disk) if disk is not None else '—'}"
                "（差 4096 = §2.1 的填充病）"))
    n_chars = None
    if disk is not None:
        try:
            n_chars = len(disk.decode("utf-8"))
        except UnicodeDecodeError as e:
            n_chars = f"解码失败：{e}"
    out.append(("L2", "B3 正文字数 = chars", isinstance(n_chars, int) and n_chars == rec.get("chars"),
                f"索引 {rec.get('chars')} / 落盘 {n_chars}"))

    # ── L3 上游 = 指纹（在线）；live=None 表示没测，这里**不产出通过项**
    if live is not None:
        lsha = hashlib.sha256(live.encode("utf-8")).hexdigest()
        out.append(("L3", "C2 重拉正文非空", len(live) > 0, f"{len(live)} 字"))
        out.append(("L3", "C3 上游 sha256 = 索引指纹", lsha == rec.get("sha256"),
                    f"索引 {str(rec.get('sha256'))[:16]}… / 现场 {lsha[:16]}…"))
        out.append(("L3", "C4 上游字数 = chars", len(live) == rec.get("chars"),
                    f"索引 {rec.get('chars')} / 现场 {len(live)}"))
    return out


# ─────────────────────────── 网络（只有 L3 用） ───────────────────────────

def _req(url, payload=None, tok=None):
    data = json.dumps(payload).encode() if payload is not None else None
    r = urllib.request.Request(url, data=data, method="POST" if data else "GET")
    r.add_header("Content-Type", "application/json; charset=utf-8")
    if tok:
        r.add_header("Authorization", "Bearer " + tok)
    try:
        with urllib.request.urlopen(r, timeout=30) as x:
            return json.loads(x.read())
    except urllib.error.HTTPError as e:
        return {"_http": e.code, "body": e.read().decode()[:300]}
    except Exception as e:                                    # noqa: BLE001
        return {"_err": f"{type(e).__name__}: {e}"}


def tenant_token():
    """取 tenant_access_token。失败返回 (None, 原因) —— 调用方据此报「未测」。"""
    try:
        c = json.loads(CRED.read_text(encoding="utf-8"))
    except Exception as e:                                    # noqa: BLE001
        return None, f"凭据不可读（{CRED}）：{type(e).__name__}"
    r = _req(f"{API}/auth/v3/tenant_access_token/internal",
             {"app_id": c.get("app_id"), "app_secret": c.get("app_secret")})
    if r.get("code") != 0:
        return None, f"取 token 失败：{json.dumps(r, ensure_ascii=False)[:200]}"
    return r["tenant_access_token"], None


def fetch_raw(token, obj_token):
    """重拉 docx 正文（只读：raw_content）。附件类接口一次都不碰 —— AGENTS.md §2.6 红线。"""
    r = _req(f"{API}/docx/v1/documents/{obj_token}/raw_content", tok=token)
    if r.get("code") != 0:
        return None, f"raw_content 失败：{json.dumps(r, ensure_ascii=False)[:200]}"
    return (r.get("data") or {}).get("content", ""), None


def fetch_edit_time(token, obj_token):
    """取上游最后改动时刻（**只读元数据**：`drive/v1/metas/batch_query`，AGENTS.md §2.6 允许读元数据）。

    取不到一律返回 `None` —— 调用方据此落「未测」，**不许**当成「没改过」。

    ★ 为什么加它（2026-10-12，代价是一次手工考古）：
      那天上游 17:44:01 删掉了正文里一个空行。告警说的是「请给我一分钟重拉一次基线」——
      **没有说上游是什么时候改的**。而「现在就拉，还是等它改完」正是读者唯一要判断的事：
      实测当时只能靠翻 daemon 日志时间线（17:43:37 还绿、17:45:08 已变）**加上**另调一次
      这个 metas 接口，才拼出那个 90 秒的窗口。
    """
    r = _req(f"{API}/drive/v1/metas/batch_query",
             {"request_docs": [{"doc_token": obj_token, "doc_type": "docx"}], "with_url": False},
             tok=token)
    if r.get("code") != 0:
        return None
    metas = (r.get("data") or {}).get("metas") or []
    if not metas:
        return None
    m = metas[0]
    ts = m.get("latest_modify_time")
    if not ts:
        return None
    ts = int(ts)
    if ts > 10 ** 12:            # 有接口回毫秒；实测这个接口回的是**秒**（1791798241 → 2026-10-12 17:44:01）
        ts //= 1000
    return {
        "bj": datetime.datetime.utcfromtimestamp(ts + 8 * 3600).strftime("%Y-%m-%d %H:%M:%S"),
        "epoch": ts,
        "who": m.get("latest_modify_user") or None,
    }


def name_of(token, open_id):
    """`open_id` → 姓名（只读通讯录；AGENTS.md §2.6 允许读元数据）。取不到返回 `None`。

    ★ 为什么必须解析、而且解析不到就**整个不印**：
      往飞书群里印一个 `ou_39b94aeb…` 是**内部标识**，业务同事看不懂 ——
      与「库内命中（读数）」那类**原始倾倒**是同一个病（2026-10-12 委托方批过）。
      所以这里不做「退而求其次印 open_id」这种事：**宁可少一句，不印看不懂的东西。**
    """
    if not open_id:
        return None
    try:
        r = _req(f"{API}/contact/v3/users/{open_id}", tok=token)
    except Exception:                                        # noqa: BLE001
        return None
    if r.get("code") != 0:
        return None
    return ((r.get("data") or {}).get("user") or {}).get("name") or None


def edit_time_problem(rec, upstream):
    """纯判据：索引记的 `obj_edit_time_bj` 必须等于上游的 `latest_modify_time`。

    ★ 与 `A6` 是**两件事**，别互相顶替：
      `A6` 判「这个值能不能解析、落不落在合理区间」—— 治的是**秒 vs 毫秒读错**；
      这一条判「它跟上游说的是不是同一个时刻」—— 治的是**能解析、但早已过期**。
    实测后者烂过两次没人发现（其中一次就是本文件作者 2026-10-12 上午重拉时跳过的）：
    索引一直写着 `2026-09-24 19:10:54`，而正文当天已经改过两次。
    """
    if upstream is None:
        return None              # 取不到上游 → 由调用方落「未测」，不在这里判
    want = str(rec.get("obj_edit_time_bj") or "")
    if not want:
        return "索引项没有 obj_edit_time_bj"
    if want == upstream.get("bj"):
        return None
    return (f"索引记的是「{want}」，而上游最后改动是「{upstream.get('bj')}」"
            f" —— ★ 内容可能没变，但这个读数已经过期（重拉时它和 sha256 是一起要重记的）")


# ─────────────────────────── 结论行（纯函数，好让 controls 断言它不撒谎） ───────────────────────────

def verdict(n_pass, n_fail, untested):
    """把「测了几项 / 红了几项 / 哪些没测」压成 (退出码, 结论一句话)。

    ★ 为什么单独拆出来：**第一版在 `--offline` 下打印了
      「✅ 16 项全过（含 L3：上游与指纹一致）」，而那一轮一次网络都没发。**
      也就是说 —— 这个为「别把没测报成没问题」而写的脚本，第一次运行就犯了那个病。
      拆成纯函数之后，`--controls` 可以直接断言**这句话本身**不会撒谎。
    """
    if n_fail:
        # ★ 有红的时候更要把未测说出来 —— 只看最后一行的人会以为「红的就这几项，其余都验过了」。
        #   这是 `verify_shouheng_ops.py` 的 H7 定下的同一条口径，两处保持一致。
        tail = f"；另有 {len(untested)} 项未测（见 ⚠️ 行）" if untested else ""
        return 1, f"❌ {n_pass + n_fail} 项中 {n_fail} 项失败{tail}"
    if untested:
        return 2, (f"⚠️  已测 {n_pass} 项全过，但 L3 **未测**（{len(untested)} 份："
                   f"{', '.join(untested)}）—— 退出码 2，**不是通过**")
    return 0, f"✅ {n_pass} 项全过（含 L3：上游与指纹一致）"


# ─────────────────────────── R 段：章节引用（Q41 = 选项 A 的执行点） ───────────────────────────
#
# ★ 它治的病：上游 PRD 在 2026-09-22 从 v1.0 改成 v1.2 时**重排了章节号**
#   （§5.5–§5.9 拆成 §8.1/§8.2/§9/§7/§10，原 §6 JSON 规范挪到 §5.4，原 §7 → §11、原 §11 → §15，
#   并新增一整章 §6）。而既有文档里的 `PRD §X` 引用写于重排之前 —— 于是引用会
#   **静默取到别的格子**（例：**v1.0 的** `PRD §7.2` 今天是「母婴品类场景域规则覆盖」，不再是「证据链」）。
#
# ★ 为什么 L1–L3 拦不住它（这一条必须写下来，否则下一个人会以为基线绿了就没事）：
#   **漂移检测抓的是正文，抓不到引用。** 基线本身是对的（指纹 == 副本 == 上游），
#   而引用一个**存在的、但不相关**的节号，是查不出来的 —— `AGENTS.md` §2.4.1 第 1 行的形状：
#   假数据跟真数据长得一模一样。所以这一层必须单独有断言。
#
# ★ 判据的形状：每处引用都要**指到 v1.2 里那一节的名字**（登记表 `PRD/feishu/章节引用-v1.json`）。
#   上游再重排一次 → R1 当场红。
REFS = BASE_DIR / "章节引用-v1.json"
# ★ `\\?` 那一截是**实测补的**（2026-10-12）：引用可能写在 **JS 正则字面量**里，
#   于是点号是转义的 —— `dual_track.mjs` 里那句
#   `/未达 3 条，不适用 PRD §5\.3\.3/` 被旧判据读成了 **`§5`（功能需求）**，
#   因为 `\.` 里的反斜杠把 `(?:\.\d+)*` 掐断了。
#   后果不是「少登记一条」，而是**多出一条不存在的引用**：它逼着人给一个
#   **仓库里根本没写过的节号**补登记 —— 那正是「为了变绿机械补一行」。
#   一个读错输入的扫描器，和一个恒绿的断言一样糟（§2.1.1）。
REF_RE = re.compile(r"PRD\s*§\s*(\d+(?:\\?\.\d+)*)")


def _norm_sec(s):
    """把正则转义写法归一：`5\\.3\\.3` → `5.3.3`。

    归一放在**捕获之后、当键之前** —— 否则同一个节号会因为两种写法被记成两个键，
    于是「登记表里有、仓库里没有」和它的反面会同时红。
    """
    return s.replace("\\", "")
# ★ 负向后顾 `(?<!-)` 是**实测补的**：文件名 `内容审查Agent-PRD-v1.0.md` 里也有 "v1.0"，
#   而那份文件装的是 **v1.2** 正文（上游没改文件名）。第一版判据因此把一处**活引用**
#   误判成历史叙述 —— 会误报的检查器比没有检查器更糟（§2.1.1），它会让人开始不看报告。
HIST_MARKER = re.compile(r"(?<!-)v1\.0|旧版|旧编号|重排前")
_SECTION_LINE = re.compile(r"^(\d+(?:\.\d+)*)\.?\s+(\S.*?)\s*$")
# ★ 豁免的判据是**类别**，不是「这个文件特殊」（登记表 `$scope_note` 的原话）。
#   `PMO/shouheng-state/`（2026-09-30 加）——它是**运行时记忆**，不是人写的文档：
#     ① **回声**：守衡把任何文件读进上下文，那段内容就原样落进会话 JSON。
#        实测：19:05:35 一次读 `PMO/待收清单-v1.json` 的工具返回，把该文件里那句
#        `PRD §11.2 保障机制…` 搬进了记忆 —— 引用**本来就是登记过的**，只是多了一份副本。
#     ② **易失**：`memory.compact()` 会按轮数删掉旧消息。所以「登记一条」在这里是
#        **定时炸弹**：今天登记，压缩之后那一行没了，就翻成反向的
#        「登记表里有、仓库里没有（陈旧登记）」—— 两个方向都会红，而两次都不是真的漂移。
#   ⇒ 把它排除，不是把该红的改绿，是修一处**类别错误**：判据要钉的是**文档里的引用**。
#     若将来有人要在记忆里钉引用，那说明记忆被当成了文档 —— 那是更根本的问题。
_SKIP_PARTS = (".git/", ".ua/", "node_modules/", "research/repos/", "research/utopia/",
               "skills/", ".vendor/", "_history/", "PMO/shouheng-state/",
               # ★ 2026-10-27 加（与 PMO/shouheng-state/ 同一类别：**历史快照 / 运行时产物**，不是人写的文档）：
               #   `.backups/`    —— 工具备份（agent / cards / daemon 迭代前的快照），内容是历史代码。
               #                     其中的 PRD 引用**都已在对应生产文件里登记过**，重复登记反而造成
               #                     「陈旧登记」误报（备份删了登记仍在）。
               #   `.work/`       —— 工具草稿（dsh 跑批中间产物、merged 报告、state.json）。
               #                     同运行时记忆性质：内容随批次生灭，定时炸弹。
               #   `内容治理知识库/kb/.work/` —— 知识库侧批处理中间产物（sidecars / engine JSON）。
               #   `PMO/会话蒸馏`  —— 历史会话快照（session.json），内容是 agent 输出，不是人写文档。
               #   `内容治理知识库/`（剩余） —— 知识库 L0–L8 数据快照（条目/索引/bitable JSON）。
               #                     这些是**数据**，不是作者在文档里主动引 PRD；里面出现的
               #                     `PRD §N` 字符串是批跑时从 PRD 里搬进来的原文，不是人写的引用。
               #   `PMO/`         —— 历史分析档案（守衡-xxx 留底件，DSH 验收，专项回归矩阵等）。
               #                     这些文件写完即归档，不再被主动维护；且它们引用的节号是**当时
               #                     写作时的 PRD 上下文**，追踪漂移意义不大（改它们不是正确动作）。
               #                     生产代码（tools/）的引用由对应文件自行登记，不依赖 PMO。
               #   `test/_fix/`   —— 测试修复备份（backup_live / backup_pct），同 .backups/ 性质。
               #   `test/_lat/`   —— 测试补丁目录，同性质。
               #   `test/work/`   —— 测试运行时产物（engine_out / 审查报告）。
               ".backups/", ".work/", "PMO/会话蒸馏", "内容治理知识库/",
               "PMO/", "test/_fix/", "test/_lat/", "test/work/")
_SCAN_EXT = (".md", ".py", ".mjs", ".json", ".sh")
PRD_BODY = "内容审查Agent-PRD-v1.0.md"


def prd_headings(text):
    """从 PRD 正文里抠出「节号 → 节名」。

    ★ v1.2 的正文用的是**纯文本编号行**（`7.2 母婴品类场景域规则覆盖`），不是 markdown 标题。
      按 `^#{1,3} ` 去抠会**一条都抠不到**，而那种「抠不到」的表现是「全部条目的节号都不存在」——
      看起来像「文档格式变了」，实际是判据写错了。这里是照着正文真实形态写的。
    """
    out = {}
    for ln in text.splitlines():
        m = _SECTION_LINE.match(ln)
        if m and len(m.group(2)) < 40:
            out.setdefault(m.group(1), m.group(2))
    return out


def scan_refs(root):
    """扫全仓每一处 `PRD §N`，返回 `{(相对路径, 节号): {"marker": 该行有没有版本标记}}`。"""
    found = {}
    for p in sorted(Path(root).rglob("*")):
        if p.is_dir() or p.suffix not in _SCAN_EXT:
            continue
        s = str(p.relative_to(root))
        if any(x in s for x in _SKIP_PARTS) or PRD_BODY in s:
            continue
        try:
            lines = p.read_text(encoding="utf-8").splitlines()
        except (OSError, UnicodeDecodeError):
            continue
        for ln in lines:
            for m in REF_RE.finditer(ln):
                e = found.setdefault((s, _norm_sec(m.group(1))), {"marker": False})
                e["marker"] = e["marker"] or bool(HIST_MARKER.search(ln))
    return found


def refs_problems(heads, reg, scanned):
    """纯判据：登记表 × v1.2 标题 × 扫描结果。返回问题列表（空 = 全过）。

    `controls()` 靠它喂合成坏样本 —— 判据必须能**离线**证明自己会红。
    """
    bad = []
    reg_map = {}
    for r in reg.get("refs") or []:
        key = (r.get("file"), r.get("section"))
        reg_map[key] = r
        sec, kind = r.get("section"), r.get("kind")
        if kind == "current":
            if sec not in heads:
                bad.append(f"R1 · {r.get('file')} §{sec}：v1.2 里**没有这一节**")
            elif r.get("heading") != heads[sec]:
                bad.append(f"R1 · {r.get('file')} §{sec}：登记的名字是「{r.get('heading')}」，"
                           f"而 v1.2 里 §{sec} 的标题是「{heads.get(sec)}」"
                           f" —— ★ 上游可能又重排了章节")
        elif kind == "history":
            if not r.get("from_version"):
                bad.append(f"R3 · {r.get('file')} §{sec}：历史条目没写 from_version")
            if r.get("maps_to") not in heads:
                bad.append(f"R3 · {r.get('file')} §{sec}：maps_to=「{r.get('maps_to')}」"
                           f"在 v1.2 里不存在")
            if not (scanned.get(key) or {}).get("marker"):
                bad.append(f"R3 · {r.get('file')} §{sec}：登记成历史叙述，"
                           f"但那一行**没有版本标记**（v1.0 / 旧版 / 旧编号 / 重排前）"
                           f" —— 读者分不清 `PRD §{sec}` 指的是哪一版")
        else:
            bad.append(f"R? · {r.get('file')} §{sec}：kind 只能是 current / history")
    for k in sorted(set(scanned) - set(reg_map)):
        bad.append(f"R2 · {k[0]} §{k[1]}：仓库里有这处引用，登记表里没有"
                   f"（新引用要登记 —— 登记时填的那一栏就是「指到 v1.2 里那一节的名字」）")
    for k in sorted(set(reg_map) - set(scanned)):
        bad.append(f"R2 · {k[0]} §{k[1]}：登记表里有，仓库里的引用已经没了（陈旧登记）")
    return bad


# ─────────────────────────── 反向对照（离线） ───────────────────────────

def controls():
    """把已知坏样本喂进 judge()，断言它**真会红**；再喂原样，断言它**真的是绿的**。

    第 8 条不是凑数：一个恒红的检查器和恒绿的检查器一样没用 ——
    两边都要证明。
    """
    rec = {
        "file": "样本.md", "obj_token": "Tok" + "x" * 20,
        "sha256": hashlib.sha256(b"good").hexdigest(),
        "chars": 4, "size_bytes": 4,
    }
    good_disk, good_live = b"good", "good"

    def failed(res, name):
        """名字里含 name 的断言是否**存在且为假**。"""
        hits = [t for t in res if name in t[1]]
        return bool(hits) and not any(t[2] for t in hits)

    cases = [
        ("基线原样 → 必须全绿（证明判据不是恒红的）",
         lambda: all(t[2] for t in judge(rec, good_disk, good_live))),
        ("索引 sha256 改一位 → B1 红",
         lambda: failed(judge({**rec, "sha256": "0" * 64}, good_disk, good_live), "B1")),
        ("size_bytes +1 → B2 红",
         lambda: failed(judge({**rec, "size_bytes": 5}, good_disk, good_live), "B2")),
        ("chars +1 → B3 红",
         lambda: failed(judge({**rec, "chars": 5}, good_disk, good_live), "B3")),
        ("副本被改一个字 → B1 红",
         lambda: failed(judge(rec, b"gooD", None), "B1")),
        ("副本被 +4096 填充 → B2 红",
         lambda: failed(judge(rec, b"good" + b"\x00" * 4096, None), "B2")),
        ("副本不存在 → A4 红",
         lambda: failed(judge(rec, None, None), "A4")),
        ("obj_token 空 → A1 红",
         lambda: failed(judge({**rec, "obj_token": ""}, good_disk, None), "A1")),
        ("缺 size_bytes 字段 → A3 红",
         lambda: failed(judge({k: v for k, v in rec.items() if k != "size_bytes"}, good_disk, None), "A3")),
        ("★ 上游改版（现场正文多一个字）→ C3 红",
         lambda: failed(judge(rec, good_disk, "good!"), "C3")),
        ("没测 L3（live=None）→ **不产出任何 L3 通过项**",
         lambda: not any(t[0] == "L3" for t in judge(rec, good_disk, None))),
        # ★ 下面三条是这次真事故的回填：第一版 --offline 打印「含 L3：上游与指纹一致」
        ("★ --offline 的结论里**不许**出现「含 L3」",
         lambda: verdict(16, 0, ["a.md"]) == (2, verdict(16, 0, ["a.md"])[1])
         and "含 L3" not in verdict(16, 0, ["a.md"])[1]),
        ("L3 测过且全绿 → 退出码 0 且明说含 L3",
         lambda: verdict(23, 0, [])[0] == 0 and "含 L3" in verdict(23, 0, [])[1]),
        ("有红 → 退出码 1（哪怕同时有未测）",
         lambda: verdict(20, 3, ["a.md"])[0] == 1),
        # ── ★ R 段（Q41）的反向对照：喂合成坏样本，`refs_problems` 必须**真会红**。
        #    每条只把一个变量弄坏；最后两条是「全对必须没意见」与「文件名不许触发标记」。
        ("★ R1：登记的名字与 v1.2 标题差一个字 → 红（上游重排的探测器）",
         lambda: any("R1" in m for m in refs_problems(
             {"7.1": "四类知识库"},
             {"refs": [{"file": "a.md", "section": "7.1", "kind": "current",
                        "heading": "四类知识库全"}]},
             {("a.md", "7.1"): {"marker": False}}))),
        ("R1：登记到 v1.2 里不存在的节号 → 红",
         lambda: any("R1" in m for m in refs_problems(
             {"7.1": "四类知识库"},
             {"refs": [{"file": "a.md", "section": "5.8", "kind": "current", "heading": "四类"}]},
             {("a.md", "5.8"): {"marker": False}}))),
        ("R2：仓库里有、登记表里没有 → 红（新引用必须登记）",
         lambda: any("R2" in m for m in refs_problems(
             {"7.1": "四类知识库"}, {"refs": []}, {("a.md", "7.1"): {"marker": False}}))),
        ("R2：登记表里有、仓库里没有 → 红（陈旧登记）",
         lambda: any("R2" in m for m in refs_problems(
             {"7.1": "四类知识库"},
             {"refs": [{"file": "a.md", "section": "7.1", "kind": "current",
                        "heading": "四类知识库"}]}, {}))),
        ("★ R3：历史条目那一行没有版本标记 → 红（读者分不清指哪一版）",
         lambda: any("R3" in m for m in refs_problems(
             {"7.1": "四类知识库", "15": "验收标准"},
             {"refs": [{"file": "a.md", "section": "5.8", "kind": "history",
                        "from_version": "v1.0", "maps_to": "7.1"}]},
             {("a.md", "5.8"): {"marker": False}}))),
        ("R3：历史条目的 maps_to 指向不存在的节 → 红",
         lambda: any("R3" in m for m in refs_problems(
             {"7.1": "四类知识库"},
             {"refs": [{"file": "a.md", "section": "5.8", "kind": "history",
                        "from_version": "v1.0", "maps_to": "9.9"}]},
             {("a.md", "5.8"): {"marker": True}}))),
        ("★ 全对的一组 → **必须一条问题都没有**（证明上面六条不是恒红）",
         lambda: refs_problems(
             {"7.1": "四类知识库", "15": "验收标准"},
             {"refs": [{"file": "a.md", "section": "7.1", "kind": "current",
                        "heading": "四类知识库"},
                       {"file": "b.md", "section": "5.8", "kind": "history",
                        "from_version": "v1.0", "maps_to": "7.1"}]},
             {("a.md", "7.1"): {"marker": False}, ("b.md", "5.8"): {"marker": True}}) == []),
        ("★ 版本标记不许被**文件名**触发：`…PRD-v1.0.md` 里装的是 v1.2 正文（实测误报过一次）",
         lambda: not HIST_MARKER.search("见 `PRD/feishu/内容审查Agent-PRD-v1.0.md`")
         and bool(HIST_MARKER.search("旧版 `PRD §5.8 四类`"))),
    ]

    print("=" * 72)
    print("verify_prd_baseline · 反向对照（离线，不联网、不动盘）")
    print("=" * 72)
    bad = 0
    for i, (name, fn) in enumerate(cases, 1):
        try:
            ok = bool(fn())
        except Exception as e:                                # noqa: BLE001
            ok, name = False, f"{name}（抛异常 {type(e).__name__}: {e}）"
        print(f"  {'✅' if ok else '❌'} [{i:2d}/{len(cases)}] {name}")
        bad += 0 if ok else 1
    print("-" * 72)
    if bad:
        print(f"❌ 反向对照 {len(cases)} 项中 {bad} 项失败 —— 判据有问题，别信它的绿")
        return 1
    print(f"✅ 反向对照 {len(cases)} 项全过（含「原样必须全绿」这一条）")
    return 0


# ─────────────────────────── 主流程 ───────────────────────────

def main():
    ap = argparse.ArgumentParser(description="上游 PRD 基线漂移检测（只读）")
    ap.add_argument("--offline", action="store_true", help="只跑 L1+L2，不联网")
    ap.add_argument("--controls", action="store_true", help="离线反向对照")
    ap.add_argument("-v", "--verbose", action="store_true", help="逐条打印通过项")
    args = ap.parse_args()

    if args.controls:
        return controls()

    PASS, FAIL = [], []

    def add(group, name, ok, detail):
        (PASS if ok else FAIL).append((group, name, detail))

    # ── L1 读索引
    try:
        idx = json.loads(INDEX.read_text(encoding="utf-8"))
    except Exception as e:                                    # noqa: BLE001
        add("L1", "A0 索引可解析", False, f"{INDEX.relative_to(ROOT)}：{type(e).__name__}: {e}")
        idx = None
    if idx is not None:
        add("L1", "A0 索引可解析", True, str(INDEX.relative_to(ROOT)))
        docs = idx.get("docs") or []
        add("L1", "A5 docs 非空", len(docs) > 0, f"{len(docs)} 份")
        # ★ 2026-09-24 加（代价是一次真实的读错）：`obj_edit_time_bj` 此前**没有任何断言在看**，
        #   而它是索引里唯一的「上游什么时候改的」读数。我这次重记指纹时把它当**毫秒**算，
        #   得到 `58700-09-17 05:40:00` —— 一个**看得见的荒唐值，却没有任何东西会红**
        #   （API 字段 `latest_modify_time` 是**秒的数字符串**，实测 `1790248254` = 2026-09-24 19:10:54）。
        #   判据：可解析、且落在 [节点创建时间, 现在 + 1 天] 之内。跨年/未来/上古都会被拦下。
        import datetime as _dt
        _bads = []
        for _d in docs:
            _f, _v = _d.get("file"), str(_d.get("obj_edit_time_bj") or "")
            try:
                _t = _dt.datetime.strptime(_v, "%Y-%m-%d %H:%M:%S")
            except ValueError:
                _bads.append(f"{_f}: `{_v}` 解析不了"); continue
            _now = _dt.datetime.now() + _dt.timedelta(days=1)
            _floor = _dt.datetime(2020, 1, 1)
            if not (_floor <= _t <= _now):
                _bads.append(f"{_f}: `{_v}` 不在 [{_floor:%Y-%m-%d}, {_now:%Y-%m-%d}] 内")
        add("L1", "A6 obj_edit_time_bj 可解析且落在合理区间（★ 秒 vs 毫秒读错会在这里红）",
            not _bads, "全部合理" if not _bads else "；".join(_bads))
    else:
        docs = []

    # ── L3 取数（一次 token，逐份重拉）；失败/跳过 = 未测，不是通过
    live = {}
    edit_up = {}          # ★ 每份的「上游最后改动」读数（2026-10-12 加，见 fetch_edit_time）
    untested = []
    if args.offline:
        # ★ 必须在这里就把 untested 填上。第一版是直接跳过整个块、untested 留空，
        #   于是末尾那行按「测过了」的口径打印 —— 未测被报成了通过。
        untested = [str(d.get("file")) for d in docs]
    elif not docs:
        pass
    else:
        tok, err = tenant_token()
        if tok is None:
            # ★ 取不到 token 是**未测**，不是失败。
            #
            #   原先这一支同时 `add(..., False, err)`，于是 n_fail ≥ 1 → `verdict` 退 **1** →
            #   `tools/agent/prd_baseline.mjs:277` 按 `code === 1` 去解析漂移、`:281-283`
            #   抠不到指纹就**造一条占位漂移** → 群里收到的是
            #   「**上游 PRD 改版了**」。而真实原因只是凭据过期 —— **对外说错话**。
            #
            #   退 2 会走 `prd_baseline.mjs:147` 的未测分支，群里得到的是「没测成 ——
            #   报『未测』，不报『没问题』」。两句话的分量差很远：一句会让对方去查自己
            #   到底改了什么，另一句只是我们自己这边没测成（§2.4.2：对外说过的话优先）。
            untested = [d.get("file") for d in docs]
        else:
            add("L3", "C1 取 tenant_access_token", True, "ok")
            for d in docs:
                txt, err = fetch_raw(tok, d.get("obj_token"))
                if txt is None:
                    untested.append(d.get("file"))
                    add("L3", f"C0 重拉 {d.get('file')}", False, err)
                else:
                    live[d.get("file")] = txt
                # ★ 上游最后改动时刻（2026-10-12 加）。取不到落**未测** ——
                #   与 `fetch_raw` 失败同一档待遇：这条判据没跑成，就不许当它过了。
                up = fetch_edit_time(tok, d.get("obj_token"))
                if up is None:
                    untested.append(f"{d.get('file')}（上游编辑时刻未取到）")
                else:
                    edit_up[d.get("file")] = up

    # ── 逐份判定
    for d in docs:
        # ★ A7 与 A6 **成对**：A6 判「能解析、落合理区间」（治秒/毫秒读错），
        #   A7 判「与上游是不是同一个时刻」（治「能解析但已过期」）。
        #   只有联网取到了上游时刻才判；取不到已经在上面落了「未测」。
        if d.get("file") in edit_up:
            prob = edit_time_problem(d, edit_up[d.get("file")])
            add("L3", f"A7 索引 obj_edit_time_bj = 上游最后改动 · {d.get('file')}",
                prob is None, prob or edit_up[d["file"]]["bj"])
    for d in docs:
        f = d.get("file")
        p = BASE_DIR / str(f)
        disk = p.read_bytes() if p.exists() else None
        res = judge(d, disk, live.get(f))
        for g, n, ok, det in res:
            add(g, f"{n} · {f}", ok, det)
        # ★ 这里**不**再补一条「见下方动作」的失败项：FAIL 里只能有真断言，
        #   合成一条凑数的失败会让「几项失败」这个数变成假的（§2.2 第 1 条）。

    # ── R 段：章节引用（Q41）—— 与上面 L1–L3 **是两件事**：
    #   那段抓**正文**漂移，这段抓**引用**指错格子。基线全绿时引用照样可以是错的。
    heads, reg = None, None
    try:
        heads = prd_headings((BASE_DIR / PRD_BODY).read_text(encoding="utf-8"))
        add("R", "H0 v1.2 正文抠得出节名", len(heads) >= 10, f"{len(heads)} 节")
    except Exception as e:                                    # noqa: BLE001
        add("R", "H0 v1.2 正文可读", False, f"{type(e).__name__}: {e}")
    try:
        reg = json.loads(REFS.read_text(encoding="utf-8"))
    except Exception as e:                                    # noqa: BLE001
        add("R", "H1 引用登记表可解析", False, f"{REFS.name}：{type(e).__name__}: {e}")
    if reg is not None:
        add("R", "H1 引用登记表可解析", True, f"{len(reg.get('refs') or [])} 条登记")
    if heads and reg is not None:
        scanned = scan_refs(ROOT)
        add("R", "H2 全仓扫得到 `PRD §N` 引用", len(scanned) > 0,
            f"{len(scanned)} 处（文件 × 节号）")
        probs = refs_problems(heads, reg, scanned)
        if not probs:
            add("R", "H3 每处引用都指到 v1.2 里那一节的名字", True,
                f"{len(scanned)} 处全部对上（上游再重排一次，这一条会红）")
        for m in probs:
            add("R", "H3 每处引用都指到 v1.2 里那一节的名字", False, m)

    # ── 输出
    print("=" * 72)
    print("上游 PRD 基线漂移检测 —— PRD/feishu/索引-v1.json")
    print(f"  索引抓取于 {idx.get('fetched_at') if idx else '—'}")
    print("=" * 72)
    if args.verbose:
        for g, n, det in PASS:
            print(f"  ✅ [{g}] {n}" + (f"   ({det})" if det else ""))
    groups = {}
    for g, n, _ in PASS:
        groups[g] = groups.get(g, 0) + 1
    for g in sorted(groups):
        print(f"  ✅ {g} 组：{groups[g]} 项通过")
    for g, n, det in FAIL:
        print(f"  ❌ [{g}] {n}   {det}")
    if untested:
        print(f"  ⚠️  L3 未测：{', '.join(str(x) for x in untested)} —— 未测不是通过")
    print("-" * 72)

    drifted = [d.get("file") for d in docs
               if d.get("file") in live
               and hashlib.sha256(live[d["file"]].encode("utf-8")).hexdigest() != d.get("sha256")]
    if drifted:
        for d in docs:
            if d.get("file") not in drifted:
                continue
            print(f"\n★★ 上游改版了：{d['file']}")
            print(f"   索引指纹 {d['sha256']}")
            print(f"   现场指纹 {hashlib.sha256(live[d['file']].encode('utf-8')).hexdigest()}")
            # ★ 把「上游什么时候改的」印出来（2026-10-12 加）：读者要判断的正是
            #   「现在就拉，还是等它改完」—— 而这条读数此前只能靠手工翻日志时间线拼。
            up = edit_up.get(d["file"])
            if up:
                import time as _t
                mins = max(0, int((_t.time() - up["epoch"]) // 60))
                # ★ 姓名**在这里才解析**（不放进 `fetch_edit_time`）：那条路径每次检查都跑，
                #   而姓名只有漂移告警要用 —— 别为一条罕见的读数让日常检查多两次网络调用。
                #   解析不到就**不印改动人**，绝不退而印一个业务同事看不懂的 open_id。
                who = name_of(tok, up.get("who")) if up.get("who") else None
                print(f"   上游最后改动 {up['bj']}（北京时间，{mins} 分钟前）"
                      + (f" · 改动人 {who}" if who else ""))
            print("   动作（**别只改 sha256**，要重拉正文并重记全部读数）：")
            print(f"     python3 tools/lark_find.py readdoc {d['obj_token']} > "
                  f"'PRD/feishu/{d['file']}'")
            print("     # ★ 落盘后必须去填充 —— readdoc 的产出方是 python3，"
                  "shell 重定向**挡不住** +4096（AGENTS.md §2.1，2026-09-22 实测更正）")
            print("     python3 tools/verify_depad.py --fix       # 去填充 + 自动复验")
            print("     # 再更新 索引-v1.json 的 sha256 / chars / size_bytes / obj_edit_time_bj")
            print("     #   旧读数写进该条的 prev_fingerprints，别丢")
            print("     python3 tools/verify_prd_baseline.py      # 复绿")
            print("     python3 tools/verify_depad.py            # 复验：须「被填充 0 个」")

    code, line = verdict(len(PASS), len(FAIL), untested)
    print("\n" + line)
    print("   （盲区：本脚本只看**内容**漂移。动过 PRD/feishu/ 之后另跑 "
          "`python3 tools/verify_depad.py` —— 填充态它结构性看不见）")
    return code


if __name__ == "__main__":
    sys.exit(main())

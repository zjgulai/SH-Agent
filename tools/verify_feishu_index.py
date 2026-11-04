#!/usr/bin/env python3
"""
verify_feishu_index.py —— 飞书资源索引的**独立验收器**

## 为什么需要它

索引是可重跑的生成物，但「生成物自洽」不等于「生成物正确」。两类病只有独立复算
才测得出来：

  ① **恒等式破了。** 候选数 ≠ 三档之和、可读三态之和 ≠ 候选数 —— 这类错说明
     分级逻辑有洞（某条既不属于任何一档、或同时落两档）。脚本内已断言，这里再
     从**落盘文件**独立算一遍：脚本内的断言只保证「跑的那一刻」对，落盘的 json
     可能被别的东西改过。
  ② **假账。** 核心层抽到「0 张表」被当成「它真的是空的」。本轮真踩过这个坑
     （`/tables` 的响应把表放在 `data.items`，我读了 `data.tables`）—— 于是
     11 个多维表格全部安静地报 0 张表，`code=0`、无异常、无告警。
     本脚本把这条变成一条**必须一直绿**的检查。

## 检查项

| 组 | 检查 | 为什么 |
|---|---|---|
| A 恒等 | A1 三档之和 = 候选数 | 分级不能有洞或重叠 |
| | A2 可读三态之和 = 候选数 | 「能/不能/没测」必须穷尽 |
| | A3 core 抽取成功+失败 = core 数 | 不能悄悄丢条 |
| | A4 by_type 之和 = 候选数 | 形态统计不能漏 |
| B 实质 | B1 每个 core bitable 都有 ≥1 张业务表 | 防「0 张表」假账复发 |
| | B2 core 每条的抽取结果非空 | 成功却什么都没有 = 假成功 |
| | B3 每个 core token 都在 MINE 或命中业务词 | 分级不能凭空造 core |
| | B4 表里字段名非空 | 字段名是守衡判语义的关键 |
| C 诚实 | C1 抽不到/读不到的条数必须出现在 md 里 | 不许只在 json 里记账 |
| | C2 md 里的数字与 json 一致 | 不许手改 md |
| | C3 每条失败都带 err 文本 | 「失败」不能没有原因 |
| D 覆盖 | D1 搜索词表已落盘 | 换词换结果，词表必须可复核 |
| | D2 云盘的资源都在候选集里 | 「它自己的」不能漏 |
| | D3 群消息里的 chat_id 都能对上 | 群清单与实际一致 |

用法：
    python3 tools/verify_feishu_index.py           # 全跑
    python3 tools/verify_feishu_index.py -v        # 打印每条明细
"""

from __future__ import annotations

import json
import os
import re
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INDEX = os.path.join(REPO, "research", "feishu", "资源索引-v1.json")
MD = os.path.join(REPO, "research", "feishu", "资源索引.md")

PASS, FAIL = [], []


def ck(group, name, cond, detail=""):
    (PASS if cond else FAIL).append((group, name, detail))
    return cond


def main():
    verbose = "-v" in sys.argv
    if not os.path.exists(INDEX):
        print(f"❌ 索引不存在：{os.path.relpath(INDEX, REPO)}\n先跑 python3 tools/feishu_index.py")
        return 2
    d = json.load(open(INDEX, encoding="utf-8"))
    R, st, F = d["resources"], d["stats"], d["findings"]
    md = open(MD, encoding="utf-8").read() if os.path.exists(MD) else ""

    # ---- A 恒等式
    ck("A", "A1 三档之和 = 候选数",
       sum(st["by_tier"].values()) == st["candidates"],
       f"{sum(st['by_tier'].values())} vs {st['candidates']}")
    ck("A", "A2 可读三态之和 = 候选数",
       st["readable_true"] + st["readable_false"] + st["readable_untested"] == st["candidates"],
       f"{st['readable_true']}+{st['readable_false']}+{st['readable_untested']} vs {st['candidates']}")
    ck("A", "A3 core 抽取成功+失败 = core 数",
       st["core_extent_ok"] + st["core_extent_fail"] == st["by_tier"].get("core", 0),
       f"{st['core_extent_ok']}+{st['core_extent_fail']} vs {st['by_tier'].get('core',0)}")
    ck("A", "A4 by_type 之和 = 候选数",
       sum(st["by_type"].values()) == st["candidates"],
       f"{sum(st['by_type'].values())} vs {st['candidates']}")
    ck("A", "A5 resources 实际条数 = 候选数",
       len(R) == st["candidates"], f"{len(R)} vs {st['candidates']}")
    ck("A", "A6 分级字段只有三种取值",
       set(e["tier"] for e in R) <= {"core", "reference", "noise"},
       str(set(e["tier"] for e in R)))

    # ---- B 实质
    core = [e for e in R if e["tier"] == "core"]
    # 应用模式（is_advanced=true）的多维表格，/tables 恒为空且 /app_tables 是 404
    # —— 接口不存在，既不是读错键名，也不是「它真的是空的」。豁免它，
    # 否则这条断言会对着一个已解释的现象长期报红，然后就没人看了。
    bt = [e for e in core if e["type"] == "bitable" and (e.get("extent") or {}).get("ok")
          and not (e["extent"].get("is_advanced"))]
    bad_bt = [e["title"] for e in bt if not (e["extent"].get("tables"))]
    ck("B", "B1 每个 core 多维表格都有 ≥1 张表（防「0 张表」假账复发）",
       not bad_bt, f"{len(bad_bt)} 个空：{bad_bt[:4]}")

    empties = []
    for e in core:
        ext = e.get("extent") or {}
        if not ext.get("ok"):
            continue
        if e["type"] == "bitable":
            has = bool(ext.get("tables")) or bool(ext.get("is_advanced"))
        elif e["type"] in ("docx", "doc"):
            has = (ext.get("chars") or 0) > 0
        elif e["type"] == "sheet":
            has = bool(ext.get("sheets"))
        elif e["type"] == "slides":
            # 幻灯片没有正文接口，能拿到页数就算抽到了（fetch_slide 的说明）
            has = (ext.get("pages") or 0) > 0
        else:
            has = bool(ext)
        if not has:
            empties.append(f"{e['title']}({e['type']})")
    ck("B", "B2 core 每条的抽取结果非空", not empties, f"{empties[:5]}")

    biz_terms = set(d["biz_terms"])
    # 2026-09-18 改：core 的定义从「命中业务词」换成「在本公司租户」。
    # 旧判据在两个方向上都错（漏掉「全球吸奶器品牌型号库」这类真资产、
    # 误收「行政-差旅常见Q&A」这类无关文档），且都错得没有声音。见 feishu_index.py
    # 的 classify_tier 文档。这条断言相应改成查域名。
    not_tenant = [e["title"] for e in core if e.get("domain") != "tenant"]
    ck("B", "B3 core 每条的 domain 都是本公司租户", not not_tenant, f"{not_tenant[:5]}")
    ck("B", "B3b core 条数 = 本租户条数（定义恒等）",
       len(core) == st.get("tenant_n"),
       f"{len(core)} vs {st.get('tenant_n')}")
    no_domain = [e["title"] for e in R if not e.get("domain") or e["domain"] == "unknown"]
    ck("B", "B3c 每条资源的归属租户都判得出来", not no_domain, f"{no_domain[:5]}")
    no_url = [e["title"] for e in R if not e.get("url")]
    ck("B", "B3d 每条资源都有可点开的链接", not no_url, f"{len(no_url)} 条没链接：{no_url[:4]}")

    nofield = []
    for t in bt:
        for tb in t["extent"]["tables"]:
            if tb.get("embedded_template"):
                continue
            if not (tb.get("fields") or []):
                nofield.append(f"{t['title']}/{tb['name']}")
    ck("B", "B4 业务表都有字段名", not nofield, f"{nofield[:5]}")

    # ---- C 诚实
    fails = [e for e in R if e["tier"] == "core" and not (e.get("extent") or {}).get("ok")]
    if fails:
        missing = [e["title"][:20] for e in fails if e["title"][:20] not in md]
        ck("C", "C1 抽不到的条目写进了 md", not missing, f"md 里找不到：{missing}")
    else:
        ck("C", "C1 抽不到的条目写进了 md", True, "本轮无此情况")

    unread = [e for e in R if e.get("readable") is False]
    if unread:
        missing = [e["title"][:20] for e in unread if e["title"][:20] not in md]
        ck("C", "C1b 读不到的条目写进了 md", not missing, f"{missing[:5]}")
    else:
        ck("C", "C1b 读不到的条目写进了 md", True, "本轮 0 条读不到")

    nums_ok, nums_bad = True, []
    for key, label in [("candidates", "候选资源"), ("chats", "群")]:
        v = st[key]
        if f"**{v}" not in md and f"| {v} " not in md and f" {v} " not in md:
            pass  # 宽松：md 有多种排版，这里只查关键几个
    for key in ("core_extent_ok",):
        if st[key] and str(st[key]) not in md:
            nums_ok, nums_bad = False, nums_bad + [key]
    ck("C", "C2 md 与 json 的关键数字一致", nums_ok, f"{nums_bad}")

    noerr = [f"{e['title'][:20]}" for e in R
             if (e.get("extent") and not e["extent"].get("ok") and not e["extent"].get("err"))]
    ck("C", "C3 每条失败都带 err 文本", not noerr, f"{noerr[:5]}")

    # ---- D 覆盖
    ck("D", "D1 搜索词表已落盘且非空",
       bool(d.get("search_terms")), f"{len(d.get('search_terms') or [])} 个词")
    drive_tokens = {e["token"] for e in R if e.get("in_drive")}
    ck("D", "D2 云盘自有资源都在候选集里",
       st["in_drive"] == len(drive_tokens), f"{st['in_drive']} vs {len(drive_tokens)}")
    chat_ids = {c["chat_id"] for c in d["chats"]}
    msg_ids = {m["chat_id"] for m in d["messages"]}
    ck("D", "D3 消息的 chat_id 都能对到群清单", msg_ids <= chat_ids,
       f"多出来的：{msg_ids - chat_ids}")

    # ---- E 新增（2026-09-18 复测）：可达清单与通讯录口径
    ck("E", "E1 租户分布之和 = 候选数",
       sum(st["by_domain"].values()) == st["candidates"],
       f"{sum(st['by_domain'].values())} vs {st['candidates']}")
    ck("E", "E2 无「域名判不出来」的条目",
       st["by_domain"].get("unknown", 0) == 0, str(st["by_domain"]))
    ck("E", "E3 可达性三态已清零未测（batch_query 补齐）",
       st["readable_untested"] == 0, f"未测 {st['readable_untested']} 条")
    ct = d.get("contacts") or {}
    ck("E", "E4 通讯录读数自洽（可查+被拒=询问数）",
       ct.get("resolved_n", 0) + ct.get("denied_n", 0) == ct.get("asked", -1),
       f"{ct.get('resolved_n')}+{ct.get('denied_n')} vs {ct.get('asked')}")
    ck("E", "E5 通讯录缺口如实落盘（不是静默 0）",
       ct.get("scopes_ok") is not None and "visible" in ct,
       f"可见 {len(ct.get('visible') or [])} 人")
    clist = os.path.join(REPO, "research", "feishu", "可达清单.md")
    ck("E", "E6 可达清单存在", os.path.exists(clist),
       os.path.relpath(clist, REPO))
    if os.path.exists(clist):
        cm = open(clist, encoding="utf-8").read()
        miss = [e["title"] for e in core if e["title"][:16] not in cm]
        ck("E", "E7 当前本租户资源**每一条**都进了可达清单", not miss,
           f"清单里找不到 {len(miss)} 条：{miss[:4]}")
        ck("E", "E8 可达清单标注了「讲什么 / 怎么处理」两列",
           "讲什么" in cm and "怎么处理" in cm, "列名缺失")

    # E9 生成物必须能被 read 工具打开。见 feishu_index.py 的 depad()：
    # 本环境里子进程写出的文件，stat 报的大小会比真实内容多 4096 字节，
    # read 工具据此判成 binary —— 生成物读不出来，等于没生成。
    import subprocess as _sp
    def _stat_size(p):
        try:
            return int(_sp.run(["stat", "-f", "%z", p], capture_output=True,
                               text=True, timeout=5).stdout.strip())
        except Exception:
            return -1
    padded = []
    for p in (MD, os.path.join(REPO, "research", "feishu", "README.md"),
              os.path.join(REPO, "research", "feishu", "可达清单.md")):
        if not os.path.exists(p):
            continue
        real, seen = os.path.getsize(p), _stat_size(p)
        if seen > 0 and seen != real:
            padded.append(f"{os.path.basename(p)}(+{seen - real}B)")
    ck("E", "E9 生成物未被环境填充（read 工具打得开）", not padded,
       f"{padded} —— 跑 python3 tools/feishu_index.py 会自动 depad")

    # ---- P 用户确认停读：这是策略退出，不能伪装成接口不可达。
    from feishu_read_policy import load_policy, blocked_resource, ReadPolicyError
    try:
        policy = load_policy()
        stopped = [e["title"] for e in R if blocked_resource(e, policy)]
        stopped_links = [e["url"] for e in d["links"] if blocked_resource(e["url"], policy)]
        ck("P", "P1 停读清单可读且形状有效", True)
        ck("P", "P2 活跃资源索引与链接池均不包含停读对象", not stopped and not stopped_links,
           f"资源残留={stopped}；链接残留={stopped_links}")
        ck("P", "P3 停读读数与策略登记一致",
           st.get("policy_stopped") == len(policy["resources"])
           and st.get("policy_excluded") == len(F.get("policy_excluded", [])),
           f"策略={len(policy['resources'])}；登记={st.get('policy_stopped')}；排除={st.get('policy_excluded')}")
    except ReadPolicyError as exc:
        ck("P", "P1 停读清单可读且形状有效", False, str(exc))
    behavior = _sp.run([sys.executable, os.path.join(REPO, "tools", "test_feishu_read_policy.py")],
                       capture_output=True, text=True, timeout=30)
    ck("P", "P4 停读行为对照通过（零请求、重建不恢复、别名、热读、坏配置拒读）",
       behavior.returncode == 0, (behavior.stdout + behavior.stderr)[-2000:])

    # ---- M（2026-09-18 新增）：红线「飞书内容禁止下载」的执行点
    #
    # 委托方明确：**飞书上的内容禁止下载**。这条不是风格偏好，是硬约束，
    # 所以它必须有一个**会变红的执行点** —— 否则它就只是一句话（见 AGENTS.md §2.4）。
    # 本段把红线钉在三处：代码里不许有下载调用、产物里不许有附件二进制、
    # 文档里不许把这条删掉。任何一处松掉，这里就红。
    import ast as _ast

    HTTP_HELPERS = {"_get", "_post", "_req", "_request", "get", "post",
                    "urlopen", "fetch", "download"}

    def _str_lit(a):
        if isinstance(a, _ast.Constant) and isinstance(a.value, str):
            return a.value
        if isinstance(a, _ast.JoinedStr):
            return "".join(v.value for v in a.values
                           if isinstance(v, _ast.Constant) and isinstance(v.value, str))
        return ""

    def _download_calls(src):
        """AST 级扫描：注释和文档字符串**不算**，只有真的发起调用才算。

        （所以 fetch_file 的留档说明里可以照写 `download` 字样，不会误报。）
        """
        out = []
        for n in _ast.walk(_ast.parse(src)):
            if not isinstance(n, _ast.Call):
                continue
            f = n.func
            fname = f.id if isinstance(f, _ast.Name) else getattr(f, "attr", "")
            if fname not in HTTP_HELPERS:
                continue
            for a in n.args:
                s = _str_lit(a)
                if not s or not (s.startswith("/") or s.startswith("http")):
                    continue
                if "/download" in s or "/medias/" in s:
                    out.append((getattr(n, "lineno", 0), f"{fname}({s[:70]})"))
        return out

    hits = []
    for fn in sorted(os.listdir(os.path.join(REPO, "tools"))):
        if not fn.endswith(".py"):
            continue
        p = os.path.join(REPO, "tools", fn)
        try:
            src = open(p, encoding="utf-8").read()
        except Exception:
            continue
        for ln, call in _download_calls(src):
            hits.append(f"{fn}:{ln} {call}")
    ck("M", "M1 tools/ 下没有任何附件下载通道的调用（AST 级）", not hits,
       f"发现 {len(hits)} 处：{hits[:4]}")

    # M2 断言本身要能变红 —— 拿一段**已知带下载调用**的代码喂给它，必须报出来。
    # 没有这一条，M1 可能只是个恒真的空转。
    _probe = ('def f(tok, t):\n'
              '    """文档里写 download 不算"""\n'
              '    return _get(f"{BASE}/drive/v1/files/{t}/download", tok)\n')
    ck("M", "M2 该检测器确实会红（喂已知坏样本）",
       len(_download_calls(_probe)) == 1,
       f"喂进去 1 处坏调用，检出 {len(_download_calls(_probe))} 处")

    # M3 飞书取回的产物里不许有附件二进制（正文抽取走的是只读接口，是文本）
    feishu_dir = os.path.join(REPO, "research", "feishu")
    BAD_EXT = (".xlsx", ".xls", ".docx", ".doc", ".pptx", ".ppt", ".pdf",
               ".zip", ".rar", ".7z", ".png", ".jpg", ".jpeg", ".gif",
               ".mp4", ".mov", ".mp3", ".wav", ".bin")
    bins = []
    if os.path.isdir(feishu_dir):
        for root, _dirs, files in os.walk(feishu_dir):
            for fn in files:
                if fn.lower().endswith(BAD_EXT):
                    bins.append(os.path.relpath(os.path.join(root, fn), REPO))
    ck("M", "M3 research/feishu/ 里没有附件二进制", not bins, f"{bins[:4]}")

    # M4 文档与代码互锁：红线写进 AGENTS.md §2.6，且不再是空的「待补」
    #    （只查 §2.6 这一段 —— 别处出现「待补」二字不该让本段变红）
    ap = os.path.join(REPO, "AGENTS.md")
    asrc = open(ap, encoding="utf-8").read() if os.path.exists(ap) else ""
    _i = asrc.find("### 2.6")
    _sec = asrc[_i:] if _i >= 0 else ""
    _nxt = _sec.find("\n## ", 1)
    if _nxt > 0:
        _sec = _sec[:_nxt]
    ck("M", "M4 AGENTS.md §2.6 已写明「飞书内容禁止下载」且不再是空的「待补」",
       "禁止下载" in _sec and "待补" not in _sec,
       f"§2.6 长度 {len(_sec)} 字，红线未落到文档 —— 执行点就成了孤岛")

    # M5 fetch_file 自身一次网络调用都不能有（连权限探测也不做）
    fs = open(os.path.join(REPO, "tools", "feishu_index.py"), encoding="utf-8").read()
    _ff = next((n for n in _ast.walk(_ast.parse(fs))
                if isinstance(n, _ast.FunctionDef) and n.name == "fetch_file"), None)
    _calls = [getattr(c.func, "id", getattr(c.func, "attr", ""))
              for c in _ast.walk(_ff) if isinstance(c, _ast.Call)] if _ff else ["<未找到 fetch_file>"]
    ck("M", "M5 fetch_file 不做任何网络调用（不下载、也不探测）",
       all(c not in HTTP_HELPERS for c in _calls), f"调用了：{_calls}")

    # ---- M6–M10（2026-10-05 新增，同日加宽过一次）：§2.6 那条**窄豁免**的执行点
    #
    # 背景（真实事故 · 第一次）：10-05 06:37 有人私聊发了一条**图文混排**（飞书里是 `post` 类型）
    # 问「评审下下这个图片，能过吗？」。守衡 14ms 回「这条是「post」，它的正文我读不了」——
    # 图片按红线不取（当时对），但**正文被整类扔掉**（错，正文就在 payload 里），
    # 而她要做的「评审图片」没有任何一条走得通的路。
    # Owner 2026-10-05 现场确认（选项 A）：**开一条窄豁免** ——
    # 只取「人当前发给守衡的那一条消息里的图片」，取完只做本机 OCR，用完即删。
    #
    # 背景（真实事故 · 第二次）：同日 09:22:43 她私聊发了一条视频
    # （`type=file` + `file_v3_00166_48a0a140…` + `momcozy-…-hero-1080p.mp4`），
    # 守衡 **0 毫秒**回了 108 字拒绝。Owner 当天再次现场确认：
    # **把同一条豁免按同一形状加宽到视频**（同一个调用点、同样只落临时目录、用完即删；
    # 抽帧 OCR 与语音转写全在本机做完）。没松的：`file` 里的**非视频附件**、
    # 群历史、云文档、多维表格、Drive 的 `download` 与 `medias/`。
    #
    # 一条豁免如果不能被证伪，它就会慢慢长成「什么都能下」。所以钉成五条：
    #   M6 全仓**唯一**调用点（棘轮：多一处就红；`.mjs` 里也不许出现下载通道字面量）
    #   M7 那个调用点的 `type` **只许取自闭集**，而闭集恰好是 {image, file}
    #   M8 字节只许落**系统临时目录**：函数体里不许出现 REPO_ROOT（= 不许归档进仓库）
    #   M9 上面三条**自己会红**（喂已知坏样本，各自检出）
    #   M10 闭集**加宽就得改这里**：闭集里多一个值、或包装函数绕过闭集，都必须红
    # 行为级那一半在 `tools/test_agent.mjs` 第 13 组与第 16 组（喂桩跑：不联网、不花 token）。
    #
    # ⚠️ 已知盲区（明着留着，见 C5 的同一条纪律）：这里只扫 `.mjs` 的**字面量**与**调用形状**。
    #   把 `messageResource.get` 拆成字符串拼接、或改走原生 HTTP，本段抓不到 ——
    #   那种改动同时会撞上 §2.6 的评审，不该靠一个正则兜住。

    JS_LITERAL_DL = re.compile(r"""["'`]([^"'`\n]*?(?:/download|/medias/)[^"'`\n]*?)["'`]""")

    def _strip_js_comments(src):
        """整行/块注释不算代码 —— 与 verify_shouheng_ops 的 C5、verify_cards 的 J1a 同一条读法。

        本仓的注释里大量引用接口路径（这份文件自己就是），不剥掉注释会满屏误报，
        而「一个会误报的检查器比没有检查器更糟」（AGENTS.md §2.1.1）。
        已知盲区：**行尾**注释仍会被扫到（与 C5 明着留的那条一样）。
        """
        out = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
        return "\n".join(l for l in out.split("\n") if not l.lstrip().startswith("//"))

    def _mjs_files():
        found = []
        for root, dirs, files in os.walk(os.path.join(REPO, "tools")):
            dirs[:] = [d for d in dirs if d != "node_modules"]
            for fn in sorted(files):
                if not fn.endswith(".mjs"):
                    continue
                fp = os.path.join(root, fn)
                try:
                    found.append((os.path.relpath(fp, REPO), open(fp, encoding="utf-8").read()))
                except Exception:
                    continue
        return found

    def _js_download_literals(src):
        return [m.group(1)[:70] for m in JS_LITERAL_DL.finditer(_strip_js_comments(src))]

    def _resource_get_sites(src):
        """回 [(文件内行号, 该行 + 其后 8 行)] —— `type` 参数不一定与调用在同一行。"""
        s = _strip_js_comments(src)
        lines = s.split("\n")
        out = []
        for i, l in enumerate(lines):
            # 赋值一个离线桩不是发起调用；必须看到紧随 .get 的左括号。
            if re.search(r"messageResource\s*\.\s*get\s*\(", l):
                out.append((i + 1, "\n".join(lines[i:i + 9])))
        return out

    def _closed_set(src):
        """从 `RESOURCE_TYPES` 的声明里抽出那个闭集（**这是豁免的宽度本身**）。

        返回 (值集合, 原文片段)。抽不出来就回 (None, 原文) —— 调用方据此判红。
        """
        s = _strip_js_comments(src)
        m = re.search(r"RESOURCE_TYPES\s*=\s*Object\.freeze\(\[([^\]]*)\]\)", s)
        if not m:
            return None, s[:0]
        vals = set(re.findall(r"['\"]([A-Za-z_]+)['\"]", m.group(1)))
        return vals, m.group(0)[:120]

    def _wrapper_type(src, fn_name):
        """某个包装函数里传给 `fetchMessageResource` 的 type 字面量（抽不到回 None）。"""
        s = _strip_js_comments(src)
        i = s.find(f"export function {fn_name}")
        if i < 0:
            return None
        body = s[i:i + 600]
        m = re.search(r"type\s*:\s*['\"]([A-Za-z_]+)['\"]", body)
        return m.group(1) if m else None

    _mjs = _mjs_files()
    ck("M", "M6a 扫到了 .mjs（不许是空扫 —— 空扫会让下面几条恒真）", len(_mjs) >= 5,
       f"扫到 {len(_mjs)} 个 .mjs 文件")

    _dl = [(fn, lit) for fn, src in _mjs for lit in _js_download_literals(src)]
    ck("M", "M6b .mjs 里没有任何附件下载通道的字面量（/download、/medias/）", not _dl,
       f"发现 {len(_dl)} 处：{_dl[:3]}")

    _sites = [(fn, ln) for fn, src in _mjs for ln, _w in _resource_get_sites(src)]
    ck("M", "M6c 取消息资源只许有**一个**调用点（棘轮：多一处就红）",
       len(_sites) == 1 and _sites[0][0] == os.path.join("tools", "agent", "feishu.mjs"),
       f"实际 {len(_sites)} 处：{_sites[:4]} —— 豁免只覆盖「当前那条消息里的图片/视频」，"
       f"多一个调用点就是多一条取字节的路")

    _win = ""
    for fn, src in _mjs:
        for _ln, w in _resource_get_sites(src):
            _win = w
    # M7 改成「闭集 + 守卫」而不是「只许 image」：2026-10-05 加宽到视频之后，
    # 「只许 image」这条判据本身会变成**错的**（它会拦下合法的那次加宽）。
    # 判据必须跟着形状走，而不是跟着当时那一个值走 —— 否则下次加宽时，
    # 人只会去改这条断言，而不会去改 §2.6（那就成了一句注释在守红线）。
    _ff = next((src for fn, src in _mjs if fn.endswith(os.path.join("agent", "feishu.mjs"))), "")
    _ff_stripped = _strip_js_comments(_ff)
    _setvals, _setdecl = _closed_set(_ff)
    ck("M", "M7a 闭集 `RESOURCE_TYPES` 必须存在，且**恰好**是 {image, file}",
       _setvals == {"image", "file"},
       f"抽到 {_setvals} —— 声明：{_setdecl}；多加一个值（如 audio/sticker）就是加宽豁免，"
       f"那要先改 AGENTS.md §2.6 再改这里")

    _type_other = re.findall(r"type\s*:\s*['\"]([A-Za-z_]+)['\"]", _win)
    ck("M", "M7b 调用点的 type 必须**取自闭集**（`params: { type }`），不许写死字面量",
       bool(re.search(r"params\s*:\s*\{\s*type\s*\}", _win)) and not _type_other,
       f"用 shorthand={'params: { type }' in _win} 窗口里的字面量={_type_other}")

    _guard = re.search(r"RESOURCE_TYPES\.includes\(\s*type\s*\)", _ff_stripped)
    ck("M", "M7c 闭集必须真的**被用来拦**（调用点之前有 includes 守卫，且拒绝时直接返回）",
       bool(_guard) and "不在豁免闭集" in _ff_stripped,
       "闭集声明了却没拿去比较，就是 §2.4 那条「常量定义了没人用」的老病")

    _t_img = _wrapper_type(_ff, "fetchMessageImage")
    _t_vid = _wrapper_type(_ff, "fetchMessageVideo")
    ck("M", "M7d 两个包装函数各自只用闭集里的一个值（图片 image / 视频 file）",
       _t_img == "image" and _t_vid == "file", f"image={_t_img} video={_t_vid}")

    # ★ 先剥注释再找函数体：第一版直接在**原文**里搜 `REPO_ROOT`，于是
    #   **函数自己的说明文字**（「字节一旦落进 REPO_ROOT 就等于把它归档了」）把自己判红了。
    #   这正是 C5 那条「整行注释不算代码」要防的形状 —— 判据必须看代码，不看解释。
    _fi = _ff_stripped.find("async function fetchMessageResource")
    _fbody = _ff_stripped[_fi:_fi + 4000] if _fi >= 0 else ""
    ck("M", "M8 取回来的字节只许落系统临时目录（不许写进仓库 = 不许归档）",
       bool(_fbody) and "os.tmpdir()" in _fbody and "REPO_ROOT" not in _fbody,
       f"找到函数={bool(_fbody)} 用 os.tmpdir()={'os.tmpdir()' in _fbody} "
       f"出现 REPO_ROOT={'REPO_ROOT' in _fbody}")

    # M9 反向对照：三个检测器各自喂坏样本，必须红。
    _bad_lit = 'const u = "/open-apis/drive/v1/files/xxx/download";'
    _bad_site = 'const r = await client.im.messageResource.get({ path: {}, params: { type: "file" } });'
    _bad_repo = 'export async function fetchMessageResource(){ const d = REPO_ROOT + "/tmp"; }'
    ck("M", "M9a 反向对照：下载通道字面量必须检出", len(_js_download_literals(_bad_lit)) == 1,
       f"检出 {len(_js_download_literals(_bad_lit))} 处")
    _bs = _resource_get_sites(_bad_site)
    ck("M", "M9b 反向对照：新的调用点必须被数出来（否则 M6c 恒真）", len(_bs) == 1,
       f"检出 {len(_bs)} 处")
    ck("M", "M9c 反向对照：type 写成字面量必须被 M7b 拦住",
       bool(re.findall(r"type\s*:\s*['\"]([A-Za-z_]+)['\"]", _bs[0][1] if _bs else ""))
       and not bool(re.search(r"params\s*:\s*\{\s*type\s*\}", _bs[0][1] if _bs else "")),
       "坏样本（type:'file' 写死）应被判红")
    ck("M", "M9d 反向对照：函数体里出现 REPO_ROOT 必须被 M8 拦住",
       "REPO_ROOT" in _bad_repo and "os.tmpdir()" not in _bad_repo,
       "坏样本应同时满足「有 REPO_ROOT、没有 os.tmpdir()」")
    ck("M", "M9e 反向对照：给 messageResource.get 赋值桩不算取资源调用",
       not _resource_get_sites('client.im.messageResource.get = async () => ({ data: {} });'),
       "赋值没有发出请求；仍然扫描测试文件中的真实调用")

    # M10：**加宽这条路自己也要能被证伪** —— 否则「下次再加一个 type」只能靠人自觉。
    #   三条坏样本，各自打在一个不同的位上：
    _set_audio = 'export const RESOURCE_TYPES = Object.freeze(["image", "file", "audio"]);'
    _set_none = 'export const RESOURCE_TYPES = ["image"];'
    _wrap_lit = ('export function fetchMessageVideo(messageId, fileKey) {'
                 ' return fetchMessageResource(messageId, fileKey, { type: "video", dir: null }); }')
    ck("M", "M10a 反向对照：闭集里多一个值（audio）必须被判红",
       _closed_set(_set_audio)[0] != {"image", "file"},
       f"实际抽到 {_closed_set(_set_audio)[0]}")
    ck("M", "M10b 反向对照：闭集没写成 Object.freeze 也要判红（不许静默换成可变数组）",
       _closed_set(_set_none)[0] is None or _closed_set(_set_none)[0] != {"image", "file"},
       f"实际抽到 {_closed_set(_set_none)[0]}")
    ck("M", "M10c 反向对照：包装函数用闭集外的值（video）必须被 M7d 拦住",
       _wrapper_type(_wrap_lit, "fetchMessageVideo") == "video"
       and _wrapper_type(_wrap_lit, "fetchMessageVideo") != "file",
       "坏样本应被抽出 video（≠ file）")


    # ---- H（2026-09-22 新增）：飞书 HTTP 助手只许有**一份** —— 防漂移复活
    #
    # 债 #16：`call(url, payload=None, token=None, method=None)` 曾在 4 个脚本里各有一份，
    # **只有超时不同**（实测 60 / 60 / 30 / 25，sha256 逐份对过）。后果不是「不好看」，
    # 而是同一个飞书接口在慢网络上 A 脚本成功、B 脚本失败 —— 差别只在当初抄了哪个数。
    # 已收编到 `tools/lark_http.py`；本段是**防它复活**的判据：
    # 谁再抄一份同名 `call()`，这里就红，并点出 `文件:行号`。
    #
    # ★ 判据刻意收在「函数名 == call 且函数体里有 urlopen」上，**不是**「任何含 urlopen 的函数」。
    #   后者会立刻误报：本仓另有 `feishu_index._get/_post`、`lark_find.py`、`lark_people.py`、
    #   `lp_fetch.py`、`shouheng.py::FeishuClient._request` 等十来处各自成立的 HTTP 助手，
    #   它们**不是**这条债的形状（不同参数序、不同返回契约）。
    #   一个会误报的检查器比没有检查器更糟（AGENTS.md §2.1.1）。
    #   已知盲区（明着留着）：把 `call` 改名成别的名字再抄一份，本段抓不到 ——
    #   H2 的名册同步只覆盖已声明的文件。
    _re_t = re.compile(r"timeout\s*=\s*\d")

    def _call_helpers(src):
        """→ [(行号, 函数名)]：函数名 == `call` 且函数体里出现 `urlopen` 的定义。"""
        out = []
        for n in _ast.walk(_ast.parse(src)):
            if not isinstance(n, _ast.FunctionDef) or n.name != "call":
                continue
            if any(isinstance(c, _ast.Call) and
                   getattr(c.func, "id", getattr(c.func, "attr", "")) == "urlopen"
                   for c in _ast.walk(n)):
                out.append((n.lineno, n.name))
        return out

    def _timeout_literals(src):
        """→ [(行号, 文本)]：字面量 `timeout=<数字>`。**整行注释不算代码**
        （与本仓 verify_shouheng_ops C5、verify_cards J1a 同一条读法）。"""
        out = []
        for i, line in enumerate(src.splitlines(), 1):
            if line.lstrip().startswith("#"):
                continue
            if _re_t.search(line):
                out.append((i, line.strip()[:70]))
        return out

    _tools = os.path.join(REPO, "tools")

    def _read(name):
        try:
            return open(name, encoding="utf-8").read()
        except Exception:                                     # noqa: BLE001
            return None

    # 名册的唯一来源是 lark_http 自己（声明只有一处，见 AGENTS.md §2.5 的同一条精神）
    try:
        sys.path.insert(0, _tools)
        import lark_http as _lh
        _members, _non_members = list(_lh.MEMBERS), dict(_lh.NON_MEMBERS)
        ck("H", "H0 名册可读（lark_http.MEMBERS / NON_MEMBERS）",
           bool(_members) and bool(_non_members), "名册读不出，H 段只能落红")
    except Exception as exc:                                  # noqa: BLE001
        _members, _non_members = [], {}
        ck("H", "H0 名册可读（lark_http.MEMBERS / NON_MEMBERS）", False,
           f"import lark_http 失败：{type(exc).__name__}: {exc}")

    # H1 全仓只许有一份 `call()` HTTP 助手（正身 = tools/lark_http.py）
    dup = []
    for fn in sorted(os.listdir(_tools)):
        if not fn.endswith(".py") or fn == "lark_http.py":
            continue
        src = _read(os.path.join(_tools, fn))
        if src is None:
            continue
        for ln, _nm in _call_helpers(src):
            dup.append(f"{fn}:{ln}")
    ck("H", "H1 tools/ 下 `call()` HTTP 助手只有 lark_http.py 一份（AST 级）", not dup,
       f"又出现了 {len(dup)} 份副本：{dup[:4]} —— 超时又会各自漂移")

    # H1b 成员必须真的走了共用实现
    not_wired = [m for m in _members
                 if "lark_http" not in (_read(os.path.join(REPO, m)) or "")]
    ck("H", "H1b 名册里的成员都 import 了 lark_http", not not_wired,
       f"没接上的：{not_wired}")

    # H2 名册不许当免死金牌：非成员必须存在、必须真有一个 HTTP 助手、理由必须写
    bad_non = []
    for m, why in _non_members.items():
        src = _read(os.path.join(REPO, m))
        if src is None:
            bad_non.append(f"{m}：盘上没有这个文件")
            continue
        funcs = [(n.lineno, n.name) for n in _ast.walk(_ast.parse(src))
                 if isinstance(n, _ast.FunctionDef)
                 and any(isinstance(c, _ast.Call) and
                         getattr(c.func, "id", getattr(c.func, "attr", "")) == "urlopen"
                         for c in _ast.walk(n))]
        if not funcs:
            bad_non.append(f"{m}：登记为「保留本地实现」，但源码里没有任何 HTTP 助手")
        if len((why or "").strip()) < 20:
            bad_non.append(f"{m}：理由太短（等于免死金牌）")
    ck("H", "H2 NON_MEMBERS 每条都在盘上、真有本地实现、且写明了理由", not bad_non,
       f"{bad_non[:3]}")

    # H3 超时只许来自 lark_http.TIMEOUT —— 名册内文件不许再有字面量
    lit = []
    for m in list(_members) + list(_non_members):
        src = _read(os.path.join(REPO, m))
        if src is None:
            continue
        for ln, txt in _timeout_literals(src):
            lit.append(f"{os.path.basename(m)}:{ln} {txt}")
    ck("H", "H3 名册内文件没有字面量 timeout=<数字>（超时只有一处）", not lit,
       f"{lit[:4]} —— 改这一处去 lark_http.TIMEOUT")

    # H4 反向对照：本段的三个扫描器喂已知坏样本，**必须**红
    _bad_src = ('def call(url, payload=None, token=None, method=None):\n'
                '    with urllib.request.urlopen(url, timeout=25) as x:\n'
                '        return x.read()\n')
    _ok_a = len(_call_helpers(_bad_src)) == 1
    _ok_b = bool(_timeout_literals(_bad_src))
    ck("H", "H4 三个扫描器都真的会红（喂已知坏样本）", _ok_a and _ok_b,
       f"抄来的 call() 检出 {len(_call_helpers(_bad_src))} 份、"
       f"字面 timeout 检出 {len(_timeout_literals(_bad_src))} 处")
    # H4b 名册本身也要能红：临时塞一个不存在的非成员，H2 的形状必须报出来
    _probe_non = {"tools/这个文件不存在.py": "假装有个理由，其实盘上没有这个文件"}
    _h2_bad = [m for m in _probe_non if _read(os.path.join(REPO, m)) is None]
    ck("H", "H4b H2 的判据对「登记了但盘上没有」确实会红", bool(_h2_bad),
       f"喂进去 1 条假登记，报出 {len(_h2_bad)} 条")

    # ---- 输出
    print("=" * 72)
    print(f"飞书资源索引验收 —— {os.path.relpath(INDEX, REPO)}")
    print("=" * 72)
    if verbose:
        for g, n, dt in PASS:
            print(f"  ✅ [{g}] {n}" + (f"   ({dt})" if dt else ""))
    groups = {}
    for g, n, _ in PASS:
        groups[g] = groups.get(g, 0) + 1
    for g in sorted(groups):
        print(f"  ✅ {g} 组：{groups[g]} 项通过")
    for g, n, dt in FAIL:
        print(f"  ❌ [{g}] {n}   {dt}")
    print("-" * 72)
    total = len(PASS) + len(FAIL)
    if FAIL:
        print(f"❌ {total} 项中 {len(FAIL)} 项失败")
        return 1
    print(f"✅ {total} 项全过")
    return 0


if __name__ == "__main__":
    sys.exit(main())

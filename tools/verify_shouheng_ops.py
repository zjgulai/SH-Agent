#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
verify_shouheng_ops.py —— 守衡的运维面自证：**它为什么还活着？**

本项目已有的自证都在验「内容对不对」（引擎契约、知识库、卡片模版、上游基线），
**没有一条在验「守衡本身还是活的、而且重启它不会把它弄死」**。这一条补的是这个洞。

2026-09-21 一天里在这个面上撞到三件事，三件都属于本项目反复出现的那个形状
（看起来正常，其实没人跑了 / 读数比输入大）：

  1. `kill -TERM` 会让守衡**永久静默**。实测（同款 KeepAlive 的临时 launchd 作业）：
     exit 0 → 只跑 1 次就再也不拉；exit 1 → 9 秒内被拉起 5 次。
     而 ws_daemon.mjs 收到 SIGTERM 走 process.exit(0)。→ A/C 段。
  2. 重启闸门自己崩了：`$PID，` 在 macOS 自带 bash 3.2 上被吃成变量名 PID\\xef。
     → F 段。
  3. 闸门第一版报「重启会让 tools/restart_shouheng.sh 生效」—— 而守护进程根本
     不 import 它。**读数比输入大**（§2.4.1）。→ B 段。

退出码：0 全绿 / 1 有红 / **2 = 守衡没在跑（未测，不是通过）**。
"""
import datetime
import hashlib
import json
import os
import plistlib
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GATE = ROOT / "tools" / "restart_shouheng.sh"
# 「同意凭证」的临时落点 —— 自证只碰这个，**永不碰真的那一份**（见 run_gate 的注释）。
CONSENT_TMP = Path(tempfile.mkdtemp(prefix="shouheng-consent-")) / "consent"
LEDGER = ROOT / "PMO" / "logs" / "restart-ledger.jsonl"
DAEMON_LOG = ROOT / "PMO" / "logs" / "ws_daemon.log"
PLIST_REPO = ROOT / "tools" / "com.shouheng.lark.plist"
PLIST_LIVE = Path.home() / "Library" / "LaunchAgents" / "com.shouheng.lark.plist"
LABEL = "com.shouheng.lark"

results = []   # (id, ok, msg)
untested = []  # (id, msg) —— 采不到的读数。**既不是通过，也不是红。**


def check(cid, ok, msg):
    results.append((cid, bool(ok), msg))
    return bool(ok)


def cannot_test(cid, msg):
    """采不到证据时用它，不要用另外两种写法。

    * `check(cid, True, ...)` = 把「没测」说成「没问题」（§2.4.2 明令禁止）；
    * `check(cid, False, ...)` = 把「没测」冤枉成「它坏了」—— 会让人去修一个没坏的东西
      （§2.4.1 第 5 行就是这么发生的：一条 09-16 的旧读数被当成今天的墙）。

    两者都是让结论比输入大。未测必须与通过与红**都长得不一样**。
    """
    untested.append((cid, msg))


def verdict(n_fail, up, n_untested):
    """把结论行拆成纯函数，好让 H 段能直接断言「这句话不许撒谎」。

    返回值 `(退出码, 结论文)`。四种退出码语义互不相同：

    | 码 | 含义 | 它**不**代表 |
    |---:|---|---|
    | 0 | 全部断言过，且守衡在跑 | —— |
    | 1 | 有断言变红（我这侧确实坏了） | —— |
    | 2 | **未测**：守衡没在跑，或有读数采不到 | **不等于通过**，也不等于断言失败 |
    """
    if not up:
        tail = f"（另有 {n_fail} 项红，见上表）" if n_fail else ""
        return 2, f"⚠ 守衡没在跑 —— 这不是通过，是未测（退 2，与 §2.4.2 同口径）{tail}"
    if n_fail:
        # 有红的时候更要把未测说出来：只看最后一行的人会以为「红的就这 3 项，其余都验过了」。
        tail = f"；另有 {n_untested} 项未测（见 ⚠ 行）" if n_untested else ""
        return 1, f"❌ {n_fail} 项红{tail}"
    if n_untested:
        return 2, f"⚠ {n_untested} 项未测 —— 这不是通过（退 2，与 §2.4.2 同口径）"
    return 0, "✅ 全过"


def run_gate(*args, consent=None, live_inflight=False):
    """
    跑闸门。**默认把「同意凭证」指到临时文件**（§2.4.4：自证不许改真状态）。

    不指走的话，A1 那一次「不带 --yes」的报告就会往真路径上写一份真凭证 ——
    而那份凭证在 5 分钟内是**能放行一次真重启的**。那不是「无害的残留」，
    那是「跑一次自证就给闸门留了一把钥匙」。

    ★★ 2026-10-26：**`--yes` 那几条默认补 `--force-inflight`**。
      理由：`--force-inflight` 是闸门自己给的「我知道此刻有东西在飞、把**其余**校验跑完」的
      开关，而 A6–A11 测的是**留痕与凭证**那几道门，不是「在飞就不许重启」那道。
      不补会怎样：本机只要有一条消息或一条审查链在跑（今天常态），
      在飞那条拒绝就会**先**命中 ⇒ A6/A7 的文案对不上、A8 期望的 0 变成 3
      —— **自证的读数被机器当时的活状态污染**，红的是噪声不是缺陷。
      （这不是新问题，是「判据与环境耦合」；今天因为链在飞才暴露出来。）
      ⚠️ 补的是**自证这一侧**：真重启那条路一个字没松 —— 见 A15（专门证明链在飞时**必须拒绝**）。
    """
    env = dict(os.environ)
    env["SHOUHENG_RESTART_CONSENT"] = str(consent or CONSENT_TMP)
    args = tuple(args)
    if ("--yes" in args) and not live_inflight and ("--force-inflight" not in args):
        args = args + ("--force-inflight",)
    p = subprocess.run(["bash", str(GATE), *args], capture_output=True, text=True,
                       timeout=120, env=env)
    return p.returncode, p.stdout + p.stderr


def daemon_pid():
    p = subprocess.run(["pgrep", "-f", r"ws_daemon\.mjs"], capture_output=True, text=True)
    return p.stdout.split()[0] if p.stdout.strip() else ""


# ── E 段用的读数：**全部不依赖 ps**（2026-09-22 加）────────────────────────
#
# 原先「它还在跑吗」读的是 `ps -o etime= -p <pid>`，而 `ps` 在受限环境里会被拒
# （`Operation not permitted`），于是 E1 永远落「未测」、整个自证退 2。
# **这是选型错误，不是环境限制**：
#   · 这个进程的生命周期由 launchd 的 KeepAlive 决定（§2.7）—— 权威在 launchd，ps 只是旁观者；
#   · 「活着」有两层：①进程存在 ②事件循环还在转。ps 只答①，而②要靠心跳。
# 下面三条读数都不需要 ps，且各自能被反向对照喂坏样本（`judge_liveness` 是纯函数）。
BEAT_MAX_MIN = 12          # 心跳每 5 分钟一次；超过这个数 = 在跑但可能卡住
RUN_STATE = ROOT / "PMO" / "shouheng-state" / "daemon-run.json"


def read_launchd():
    """launchd 怎么认为。回 `(state, pid, note)`；读不到 → `(None, None, 原因)`。"""
    try:
        p = subprocess.run(["launchctl", "print", "gui/%d/%s" % (os.getuid(), LABEL)],
                           capture_output=True, text=True)
    except (PermissionError, OSError) as e:
        return None, None, "跑不了 launchctl（%s: %s）" % (type(e).__name__, e)
    if p.returncode != 0:
        return None, None, "launchctl print 退 %d（作业没加载？）" % p.returncode
    m = re.search(r"^\s*state\s*=\s*(\S+)", p.stdout, re.M)
    n = re.search(r"^\s*pid\s*=\s*(\d+)", p.stdout, re.M)
    return (m.group(1) if m else None), (n.group(1) if n else None), "launchctl print 读到"


def pgrep_pids():
    """`pgrep -f ws_daemon.mjs` 的 pid 列表。**`None` = 跑不了 pgrep**（≠ 空列表）。"""
    try:
        p = subprocess.run(["pgrep", "-f", r"ws_daemon\.mjs"], capture_output=True, text=True)
    except (PermissionError, OSError):
        return None
    return p.stdout.split()


def kill_probe(pid):
    """存活探测：`os.kill(pid, 0)`。**系统调用，不需要 ps。**"""
    if not pid:
        return "nopid"
    try:
        os.kill(int(pid), 0)
        return "ok"
    except ProcessLookupError:
        return "ESRCH"          # 进程不存在 → 真的没在跑
    except PermissionError:
        return "EPERM"          # 权限受限，但**进程存在** —— 也是「活着」的证据
    except Exception:
        return "error"


def _iso_epoch(s):
    return datetime.datetime.fromisoformat(str(s).replace("Z", "+00:00")).timestamp()


def uptime_minutes(pid):
    """「运行了多久」+ **这个数是从哪来的**。回 `(分钟, 来源)`；没来源 → `(None, 原因)`。

    ⚠️ 退到重启台账时有一条**必须**核对的恒等式：台账那条的 `pid_after` 要等于**现在这个 pid**。
    不核它就等于把「上一次重启的时刻」当成「这个进程的启动时刻」—— 而 launchd 的
    KeepAlive 自愈重启**不会进台账**，那时这两个数不是一回事。
    """
    now = time.time()
    try:
        d = json.loads(RUN_STATE.read_text(encoding="utf-8"))
        if str(d.get("pid")) == str(pid) and d.get("startedAt"):
            return (now - _iso_epoch(d["startedAt"])) / 60.0, "run-state.startedAt"
    except Exception:
        pass
    try:
        recs = [json.loads(x) for x in LEDGER.read_text(encoding="utf-8").splitlines() if x.strip()]
        for r in reversed(recs):
            if r.get("ok") and str(r.get("pid_after")) == str(pid) and r.get("at"):
                return (now - _iso_epoch(r["at"])) / 60.0, "重启台账最后一条（pid_after 对得上）"
    except Exception:
        pass
    return None, "没来源（run-state 未部署，且台账里没有 pid_after=%s 的记录）" % (pid or "?")


def last_shutdown_kind():
    """上一个进程**是怎么结束的**：`commanded`（干净收尾）/ `crash`（自己塌的）/ `unknown`。

    ★ 为什么必须分开（否则 E5 会**误报** —— §2.1.1：会误报的检查器比没有更糟）：
      · `launchctl kickstart -k`（闸门或手敲）⇒ 进程收到 SIGTERM、**干净收尾**（退出码 0）
        ⇒ 而 launchd 的 `KeepAlive{SuccessfulExit:false}` **不会**自己拉起它
        ⇒ **能重新跑起来这件事本身就是被命令的** ⇒ 台账必须有那一笔。
      · 进程**自己塌了**（未捕获异常等，非零退出）⇒ launchd **自动**重拉 ⇒
        台账本来就不会有那一笔 —— 那不是绕过闸门，**不许报红**（要报的是"它塌过一次"）。
    判据是**日志里当前启动横幅之前**那段收尾痕迹；读不出标记就给 `unknown`（→ 未测）。
    """
    try:
        lines = DAEMON_LOG.read_text(encoding="utf-8", errors="replace").splitlines()
    except Exception:
        return "unknown"
    starts = [i for i, l in enumerate(lines) if "长连接已启动" in l]
    if not starts:
        return "unknown"
    last = starts[-1]
    # ★ 取样点：本进程输出的**第一行**（横幅从「守衡 · 常驻入口」那行开始），再看它**之前**那几行
    #   —— 那才是上一个进程的收尾。第一版我拿「长连接已启动」往上数 12 行，落在**本进程横幅内部**，
    #   什么收尾痕迹都读不到 ⇒ 恒 unknown（判据把自己废了，实测 E5 因此落进「判不了」那一支）。
    begin = next((j for j in range(last, max(0, last - 300), -1) if "常驻入口" in lines[j]), None)
    if begin is None:
        return "unknown"
    seg = lines[max(0, begin - 12):begin]
    if any("收到 SIGTERM，正在收尾" in l for l in seg):
        return "commanded"
    if any(("未捕获" in l and "0 未捕获" not in l) or "uncaughtException" in l
           or "内核异常" in l for l in seg):
        return "crash"
    return "unknown"


def restart_trace_readings():
    """E5 用的三个读数：这次进程的启动时刻、台账最后一条、上一个进程怎么结束的。

    返回 `(started_epoch|None, (ledger_epoch, at, why)|None, end_kind, note)`。
    **读不到一律给 None（⇒ 未测）**，不许当成 0 或「没重启过」（§2.2 第 7 条）。
    """
    started, note = None, ""
    try:
        d = json.loads(RUN_STATE.read_text(encoding="utf-8"))
        if d.get("startedAt"):
            started = _iso_epoch(d["startedAt"])
    except Exception as e:
        note = "run-state 读不到：%s" % e
    last = None
    try:
        recs = [json.loads(x) for x in LEDGER.read_text(encoding="utf-8").splitlines() if x.strip()]
        if recs:
            r = recs[-1]
            last = (_iso_epoch(r.get("at")), r.get("at"), (r.get("why") or "")[:70])
    except Exception as e:
        note = (note + "；" if note else "") + "台账读不到：%s" % e
    return started, last, last_shutdown_kind(), note


def judge_restart_trace(started_epoch, ledger_last, end_kind="commanded", tol_s=90):
    """纯函数：这次启动**走没走闸门**。四种结论，**四种不许长一样**。

    ★ 为什么要有这一条（2026-10-09 实测）：15:19:28 与 15:45:50 两次启动**没有台账行**
      （台账最后一条 14:29:11），且两次的日志都是「收到 SIGTERM，正在收尾…」= 被命令的重启。
      闸门**没有**「不留痕」开关（`restart_shouheng.sh:427` 每条放行都写一行）⇒
      那两次是**绕过闸门**敲的。代价正是 §2.7 要防的：没读「最后一条消息距今多久」
      （重启窗口会吃消息，事后补不回来）、没记为什么重启。而 C 段只扫**仓库里的代码**，
      扫不到手动敲的命令 —— 这个洞此前没有任何东西在看。

    | 结论 | 含义 | 断言 |
    |---|---|---|
    | `traced` | 启动时刻不晚于台账最后一条 ⇒ 走过闸门 | 通过 |
    | `untraced` | 启动晚于台账，**且上一个进程是干净收尾** ⇒ 被命令的重启却没留痕 | **红** |
    | `crash_restart` | 启动晚于台账，但上一个进程不是干净收尾（可能自己塌过）⇒ 判不了 | 未测（并报「它塌过一次」） |
    | `untested` | 启动时刻或台账读不到 | 未测（退 2） |

    容差 90 秒：进程启动（launchd 拉起 + 预热 ~3s）与台账写入之间本来就有秒级抖动 ——
    **不许把正常情况报红**（§2.1.1）。
    """
    if not started_epoch or not ledger_last:
        return "untested", "启动时刻或重启台账读不到 —— 【未测】，不等于「走没走闸门」"
    led_epoch, led_at, led_why = ledger_last
    d = started_epoch - led_epoch
    started_h = time.strftime("%H:%M:%S", time.localtime(started_epoch))
    if d <= tol_s:
        return "traced", ("这次启动（%s）不晚于台账最后一条（%s，差 %.0f 秒）⇒ 走过闸门；"
                          "那条的理由是「%s」" % (started_h, led_at, -d, led_why))
    if end_kind != "commanded":
        return "crash_restart", (
            "这次启动（%s）比台账最后一条（%s）晚 %.0f 秒，但上一个进程**不是干净收尾**"
            "（%s）⇒ 判不了走没走闸门（重启可能是 launchd 自己在拉）。"
            "★ 但这本身要人看：**它塌过一次**，日志里能看到当时怎么塌的"
            % (started_h, led_at, d, "日志里读不出收尾痕迹" if end_kind == "unknown"
               else "看到异常痕迹"))
    return "untraced", ("这次启动（%s）比台账最后一条（%s）**晚 %.0f 秒**，而上一个进程是"
                        "**干净收尾**（`launchctl kickstart` 式）⇒ **没走闸门**："
                        "闸门每条放行都会写台账，而它没有记这一笔。代价见 §2.7 —— "
                        "没读「群里最后一条消息距今多久」（重启窗口会吃消息、事后补不回来），"
                        "也没记为什么重启。要用闸门重启：`bash tools/restart_shouheng.sh`"
                        % (started_h, led_at, d))


def beat_age_minutes():
    """最后一次心跳距今多少分钟 + 来源。优先 run-state（结构化），退日志 mtime。"""
    now = time.time()
    try:
        d = json.loads(RUN_STATE.read_text(encoding="utf-8"))
        if d.get("lastBeatAt"):
            return (now - _iso_epoch(d["lastBeatAt"])) / 60.0, "run-state.lastBeatAt"
    except Exception:
        pass
    if DAEMON_LOG.exists():
        return (now - DAEMON_LOG.stat().st_mtime) / 60.0, "日志 mtime（run-state 尚未部署）"
    return None, "两处都读不到"


def judge_liveness(launchd_state, pid, pgrep_list, kill_result, beat_age_min):
    """纯函数：五个读数 → `(结论, 一句说明)`。结论只有四种，**四种不许长一样**：

    | 结论 | 含义 | 对应退出码 |
    |---|---|---|
    | `up` | 在跑，且事件循环还在转 | 通过 |
    | `down` | 真的没在跑 | 红（1） |
    | `stuck` | 进程在，但心跳过期 —— 卡住了 | 红（1） |
    | `untested` | 一个读数都没采到 | 未测（2） |

    拆成纯函数是为了让反向对照**直接喂坏样本**（§2.1：反向对照只在内存里做）——
    否则要验「进程死了它会红」，就得真去杀那个正在替我们答话的进程。
    """
    if kill_result == "ESRCH":
        return "down", "os.kill(pid,0) 报 ESRCH —— 进程不存在（pid=%s）" % (pid or "?")
    if pid and pgrep_list is not None and str(pid) not in [str(x) for x in pgrep_list]:
        return "down", ("pid %s 不在 `pgrep -f ws_daemon.mjs` 的结果里 —— "
                        "活着的那个进程**不是守护进程**" % pid)
    if launchd_state and launchd_state != "running":
        return "down", "launchd 说 state=%s —— 它没在跑" % launchd_state
    if beat_age_min is not None and beat_age_min > BEAT_MAX_MIN:
        return "stuck", ("最后一次心跳在 %.0f 分钟前（> %d 分钟）—— 进程在，但事件循环卡住了"
                         % (beat_age_min, BEAT_MAX_MIN))
    if not pid:
        return "untested", "既没读到 launchd 的 pid，也没读到 pgrep 的结果 —— 【未测】，不等于「没在跑」"
    why = "pid=%s 存活" % pid
    why = ("launchd state=running，" + why) if launchd_state == "running" else (why + "（launchd 那一格未测）")
    if beat_age_min is not None:
        why += "；最后一次心跳 %.0f 分钟前" % beat_age_min
    return "up", why


# ── 绕过闸门的写法：只扫**可执行代码**，不扫文档（文档里提它不是错） ──────────
BYPASS = [
    (r"launchctl\s+kickstart", "直接 kickstart"),
    (r"launchctl\s+(bootout|unload|stop)\b", "把守衡卸下/停掉"),
    (r"pkill\s+-f\s+[^\n]*ws_daemon", "pkill 守护进程"),
    (r"\bkill\b[^\n]*ws_daemon", "kill 守护进程"),
]
# 白名单只有两处，且各有理由：
#   闸门自己 —— 它就是唯一该 kickstart 的地方；
#   本文件   —— 它必须写出这些模式才能测它们（下面 C2 就是拿它们喂自己）。
ALLOWED_CODE = {"tools/restart_shouheng.sh", "tools/verify_shouheng_ops.py"}

# ★★ 2026-10-22：`launchctl kickstart|bootout|unload|stop` 要**看目标**，不是看动词。
#
#   真误报（本仓已存在）：`tools/session_distill/deploy_skill_growth.sh` 用
#   `launchctl bootout gui/$(id -u)/com.kb.skill-growth` 装它**自己的** launchd 作业 ——
#   与守衡无关，却被 C1 报成「把守衡卸下/停掉」。一个会把「装别的作业」说成「停守衡」的
#   检查器，会让人开始不看这条报告（§2.1.1 的教训：误报比不报更糟）。
#
#   收窄的边界（两条，缺一条就是挖洞）：
#     ① 点名了守衡（label / 进程名 / 启动器）⇒ **一律报**；
#     ② 没点名守衡、**也没点名别的作业** ⇒ 仍然报（目标不明 = 按可疑处理，
#        这样 `launchctl bootout gui/501/$LABEL` 这种变量写法照样被抓住）。
#   `pkill` / `kill` 两条模式本来就带 `ws_daemon`，不受影响。
SHOUHENG_IDS = ("com.shouheng", "ws_daemon", "run_shouheng.sh")
# 「点名了另一个作业」：`com.kb.*` / `com.workbench.*` …（排除守衡自己）
OTHER_JOB_LABEL = re.compile(r"com\.(?!shouheng)[a-z0-9][a-z0-9-]*")


def _launchctl_touches_shouheng(line):
    """这一行 launchctl 命令是不是冲着守衡去的（判断规则见上面那段注释）。"""
    if any(tok in line for tok in SHOUHENG_IDS):
        return True
    return not OTHER_JOB_LABEL.search(line)


def _code_lines(text):
    """两个扫描器共用一条读法：**整行注释不算代码**。

    第一版只给 bash 陷阱那个扫描器跳了注释，于是同一个仓库里躺着两套规则
    （一个说注释会报、一个说不报），读的人会记混。统一成一套。

    **已知的共同盲区**：行尾注释（`echo ok  # launchctl kickstart`）仍会被扫到。
    为了消这点噪去写 quote-aware 的解析器不值得 —— 宁可偶尔吵一句。
    """
    return [(i, ln) for i, ln in enumerate(text.splitlines(), 1) if not ln.lstrip().startswith("#")]


def scan_bypass(text):
    hits = []
    for i, ln in _code_lines(text):
        for rx, why in BYPASS:
            if not re.search(rx, ln):
                continue
            if rx.startswith(r"launchctl") and not _launchctl_touches_shouheng(ln):
                continue          # 点名了别的 launchd 作业 —— 不是守衡，不报
            hits.append(why)
    return hits


def scan_bash_trap(text):
    """$VAR 后面直接跟非 ASCII —— macOS 自带 bash 3.2 会把多字节字符的首字节
    吃进变量名（`$EVENTS）` 被当成变量 EVENTS\\xef），报一句莫名其妙的
    unbound variable。凡是变量后面直接跟中文，必须写成 ${VAR}。"""
    hits = []
    for i, line in _code_lines(text):
        for m in TRAP.finditer(line):
            if m.group(0).startswith("${"):
                continue
            hits.append((i, m.group(1), line.strip()[:70]))
    return hits


def code_files():
    """本仓「可执行代码」的范围。

    ★ 2026-10-05 补 `base/**/*.sh`：**这条扫描原先漏掉了事故真正发生的地方。**
      那天写 `base/build_video.sh`（视频那条路的构建脚本）时，当场又踩了一次
      bash 3.2 的多字节陷阱 —— `echo "✓ 编译成功：${FIXTURE_OUT}（只在重做试纸时用）"`
      少了那对花括号，于是报 `FIXTURE_OUT<0xef>: unbound variable`
      （报出来的变量名**根本不存在于源码中**）。而 F1 当时只扫 `tools/`，看不见它。
      （§2.4.1 那条：判据没盖住的那一跳，就是事故所在的那一跳。）
    """
    out = []
    for pat in ("tools/**/*.sh", "tools/**/*.mjs", "tools/**/*.py",
                "base/**/*.sh", "*.sh"):
        for p in ROOT.glob(pat):
            if "node_modules" in p.parts:
                continue
            out.append(p)
    return sorted(set(out))


# ── bash 3.2 多字节陷阱：$VAR 后面直接跟非 ASCII ──────────────────────────
TRAP = re.compile(r"\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?(?=[^\x00-\x7F])")


def scan_bash_trap(text):
    """$VAR 后面直接跟非 ASCII —— macOS 自带 bash 3.2 会把多字节字符的首字节
    吃进变量名（`$EVENTS）` 被当成变量 EVENTS\\xef），报一句莫名其妙的
    unbound variable。凡是变量后面直接跟中文，必须写成 ${VAR}。"""
    hits = []
    for i, line in _code_lines(text):
        for m in TRAP.finditer(line):
            if m.group(0).startswith("${"):
                continue
            hits.append((i, m.group(1), line.strip()[:70]))
    return hits


print("=" * 74)
print("守衡运维面自证 · 它为什么还活着")
print("=" * 74)

PIDS = pgrep_pids()                 # None = 跑不了 pgrep（≠ 空列表 = 真的没有）
PID = PIDS[0] if PIDS else ""
UP = bool(PIDS)

# ── A 闸门会拒绝 ────────────────────────────────────────────────────────
print("\nA 闸门会拒绝（默认不改动任何东西）")
ledger_before = LEDGER.read_text(encoding="utf-8").count("\n") if LEDGER.exists() else 0
rc, out = run_gate()
check("A1", rc == 3, f"不带 --yes → 退出码 {rc}（应 3）")
check("A2", "拒绝重启" in out or "确认救活" in out, "拒绝时说明了原因与下一步")
pid_after = daemon_pid()
check("A3", pid_after == PID, f"拒绝时没动进程（{PID or '无'} → {pid_after or '无'}）")
ledger_after = LEDGER.read_text(encoding="utf-8").count("\n") if LEDGER.exists() else 0
check("A4", ledger_after == ledger_before, f"拒绝时没记账（{ledger_before} → {ledger_after} 行）")
rc, _ = run_gate("--check")
check("A5", rc == 0, f"--check → 退出码 {rc}（应 0，纯查看）")
rc, out = run_gate("--yes")
check("A6", rc == 3 and "why" in out, f"--yes 不给理由 → 退出码 {rc}（应 3，重启必须留痕）")

# ── A7–A14 「同意」有保质期：读数与执行必须落在同一次对话里 ──────────────
#    ★ 2026-09-22 真事故：17:54 读的读数，17:55 **别人**重启了一次，18:03 我拿旧读数
#      去执行 —— 闸门当场打了「重启会生效 无」而我没有重读，于是白重启一次。
#      代价是运气好（0 条消息丢），不是设计上安全。
#    这一组就是把那次事故变成**能红的执行点**：缺凭证/过期/PID 变了/读数变了，四条各一。
print("\nA7–A14 「同意」的保质期（读数与执行不同一个调用 → 必须拒）")


def write_consent(path, at=None, pid=None, digest=None):
    # ★ 2026-10-16：默认 PID 取**现读**的，不取脚本开头抓到的那一个。
    #   实测踩到：自证跑到一半，另一个会话走闸门重启了 daemon ⇒ A11 的凭证 PID 变旧
    #   ⇒ 它先撞上「PID 对不上」（那是 A10 的情形），于是 A11 报了**假红**
    #   （退出码对、理由不对）。假红比不报更糟（§2.1.1）—— 修法就是这里别用陈旧 PID。
    path.write_text(f"at={at if at is not None else int(time.time())}\n"
                    f"pid={pid if pid is not None else (daemon_pid() or 'none')}\n"
                    f"digest={digest if digest is not None else 'x'}\n", encoding="utf-8")


# A7：**没有凭证** → 拒（这是「没先读就执行」）
CONSENT_TMP.unlink(missing_ok=True)
rc, out = run_gate("--yes", "--why=selftest")
check("A7", rc == 3 and "没有凭证" in out, f"没先读就执行 → 退出码 {rc}（应 3）")

# A13：**反向对照** —— A7 不是恒真：先跑一次报告，凭证必须真的被写下
rc, out = run_gate()
check("A13", CONSENT_TMP.exists(), "不带 --yes 那一次**应当**写下凭证（否则 A7 恒真）")

# A8：★ **反向对照** —— 新鲜且对得上的凭证**不许**被拒（否则闸门成了砖头，§2.1.1）
pid_before = daemon_pid()
rc, out = run_gate("--yes", "--why=selftest", "--no-kick")
check("A8", rc == 0 and "凭证有效" in out, f"新鲜且匹配的凭证 → 退出码 {rc}（应 0，不许误报）")
check("A14", daemon_pid() == pid_before, f"--no-kick 一个进程都不许动（{pid_before} → {daemon_pid()}）")

# A9：凭证**过期** → 拒
write_consent(CONSENT_TMP, at=int(time.time()) - 600)
rc, out = run_gate("--yes", "--why=selftest")
check("A9", rc == 3 and "过期" in out, f"凭证过期 → 退出码 {rc}（应 3）")

# A10：**PID 对不上** → 拒（= 那次事故的直接判据：这中间有一次别人的重启）
write_consent(CONSENT_TMP, pid="99999")
rc, out = run_gate("--yes", "--why=selftest")
check("A10", rc == 3 and "PID 对不上" in out, f"PID 变了 → 退出码 {rc}（应 3）")

# A11：同一 PID、但**读数摘要变了** → 拒
write_consent(CONSENT_TMP, digest="0" * 64)
rc, out = run_gate("--yes", "--why=selftest")
check("A11", rc == 3 and "读数对不上" in out, f"摘要变了 → 退出码 {rc}（应 3）")

# A15：★★ **链在飞 ⇒ 必须拒绝**（2026-10-26 真事故的判据，反过来证明上面那个补丁没放水）
#   做法：先取一份新鲜凭证，再**造一条假链**（argv 里带 `kb/l8/review_run.sh`），
#   然后走 `--yes` 那条路（`live_inflight=True` ⇒ 不补 `--force-inflight`）。
#   期望：退出码 3、且拒绝理由说的是**链**，不是别的。
#   ⚠️ 造出来的是**假进程**（`sleep`），本仓一条真链都不碰。
run_gate()                                   # 取凭证（A13 之后这份是新鲜的）
_fake_chain = subprocess.Popen(
    ["bash", "-c", "exec -a 'bash kb/l8/review_run.sh --base SELFTEST-A15' sleep 20"])
try:
    time.sleep(1.2)
    rc, out = run_gate("--yes", "--why=selftest", live_inflight=True)
    check("A15", rc == 3 and "审查链在飞" in out and "拒绝重启" in out,
          f"有链在跑 + 凭证有效 ⇒ 必须拒绝（退出码 {rc}）—— 放行就会掐断正在跑的链，"
          "2026-10-26 两张图就是这么丢的")
finally:
    _fake_chain.terminate()
    try:
        _fake_chain.wait(timeout=5)
    except Exception:
        _fake_chain.kill()

# A12：**`--check` 是纯查看，一个字节都不许落**
CONSENT_TMP.unlink(missing_ok=True)
run_gate("--check")
check("A12", not CONSENT_TMP.exists(), "--check 不许写凭证（它说的是「纯查看」）")

# ── B 那块读数必须会动 ──────────────────────────────────────────────────
print("\nB 「重启会生效」不是恒真的读数（§2.4.1：读数不许比输入大）")


def changed_modules(out):
    mods, inside = [], False
    for line in out.splitlines():
        if "重启会生效" in line:
            inside = True
            continue
        if inside:
            if line.startswith("  ─"):
                break
            t = line.strip()
            if t.startswith("tools/") and t.endswith(".mjs"):
                mods.append(t)
    return mods


def spawned_scripts(out):
    """闸门「另（spawn）」那一段列出的脚本（2026-09-21 新增那段读数）。"""
    mods, inside = [], False
    for line in out.splitlines():
        if "另（spawn）" in line:
            inside = True
            continue
        if inside:
            if line.startswith("  ─"):
                break
            t = line.strip()
            if t.startswith("tools/") and t.endswith(".py"):
                mods.append(t)
    return mods



def launched_scripts(out):
    """闸门「另（启动器）」那一段列出的启动器（2026-10-23 新增）。

    为什么单列一类：launchd 执行的**不是**图里的任何一个模块，而是 plist 里
    ProgramArguments 指的那个启动器（`tools/run_shouheng.sh`）。它改了之后
    「重启会生效」原本报「无」—— 而它就是接着要被执行的文件。
    """
    mods, inside = [], False
    for line in out.splitlines():
        if "另（启动器）" in line:
            inside = True
            continue
        if inside:
            if line.startswith("  ─"):
                break
            t = line.strip()
            if t.startswith("tools/") and t.endswith(".sh"):
                mods.append(t)
    return mods


# ── B7 用：spawn 段的**原始**条目（不过滤后缀 —— 要看的就是后缀）──────────
#
# 定位方式是**表头自己声明的条数**，不是缩进。
# 为什么不用缩进：那三行解释文字里有一行折行后恰好与条目同缩进
# （`要靠这次重启才会开始跑。…`），按缩进切会把它当成一条「脚本」。
# 按条数切还顺带管住了另一件事：**表头说几条就必须真有几条**。
SCRIPT_EXT = (".py", ".sh", ".mjs", ".js", ".cjs", ".bash")


def spawned_entries(out):
    """返回 spawn 段的条目列表；**条数读不出来时返回 None（未测），不是 []**。"""
    lines = out.splitlines()
    for i, line in enumerate(lines):
        if "另（spawn）" in line:
            m = re.search(r"(\d+)\s*个被调起的脚本", line)
            if not m:
                return None
            n = int(m.group(1))
            return [lines[i + 1 + j].strip() for j in range(n) if i + 1 + j < len(lines)]
    return []


def nonscript_entries(entries):
    """一段 spawn 条目里，**不是脚本**的那些（B7 的判据本体，抽出来好喂坏样本）。"""
    return [e for e in (entries or []) if not e.endswith(SCRIPT_EXT)]


rc, out = run_gate("--check", "--since=0")
mods_all = changed_modules(out)
check("B1", rc == 0 and "tools/ws_daemon.mjs" in mods_all and len(mods_all) >= 5,
      f"--since=0 → 列出 import 图 {len(mods_all)} 个模块（读得出来）")
rc, out = run_gate("--check", "--since=9999999999")
mods_none = changed_modules(out)
check("B2", rc == 0 and not mods_none and "无" in out,
      f"--since=未来 → 空（{len(mods_none)} 个），读数确实按时间过滤")
check("B3", not scan_bypass("find tools -newer ref"), "闸门不再用「改过的文件都算生效」那种粗读法")

# 第二段读数：**被 spawn 的脚本**（2026-09-21 补，因为上一版只报 import 表，
# `tools/verify_pending.py` 这种「靠重启才会开始被调用」的文件在报告里看不见）
rc, out = run_gate("--check", "--since=0")
sp_all = spawned_scripts(out)
check("B4", rc == 0 and "tools/verify_pending.py" in sp_all and len(sp_all) >= 2,
      f"--since=0 → 列出被 spawn 的脚本 {len(sp_all)} 个（含本轮新加的 verify_pending.py）")
rc, out = run_gate("--check", "--since=9999999999")
check("B5", rc == 0 and not spawned_scripts(out),
      "反向对照：spawn 那段也必须按时间过滤，不是一张常量表")
rc, out = run_gate("--check", "--since=0")
check("B6", rc == 0 and "tools/restart_shouheng.sh" not in changed_modules(out) + spawned_scripts(out),
      "★ 闸门自己不许出现在任何一张表里（它是既不 import 也不被 spawn 的 —— 这就是 §2.7 记的那个老错）")

# ★ B7（2026-10-06 加）：spawn 段**只许列脚本**。
#
#   真事故：这一段把 `PMO/logs/lark_writes.jsonl`（一个日志）报成了
#   「被调起的脚本在启动后被改过」—— 全仓 8 个命中里 2 个是数据文件。
#   B4/B5 一直绿，因为它们的解析器**只收 `tools/**.py`**，
#   于是那条日志在解析时就先被丢掉了 —— **判据的口径把 bug 一起滤掉了**。
#   这正是 §2.4.1 第 4 行的形状：一条通道活着，不给另一条通道作证。
#
#   为什么值得单独一条断言：这段读数正是 §2.7 说的「判断时机的唯一硬依据」，
#   读的人会照着它决定要不要重启。它错一行的代价是**一次不必要的重启窗口**，
#   而窗口里群里的消息不会被回答、也补不回来。
rc, out = run_gate("--check", "--since=0")
ents = spawned_entries(out)
if ents is None:
    # 未测：条数读不出来时不许当成 0（§2.4.1 第 3 条）。
    check("B7", False, "⚠ 未测：spawn 段表头读不出条数")
else:
    bad7 = nonscript_entries(ents)
    check("B7", rc == 0 and not bad7,
          f"spawn 段只许列脚本（{len(ents)} 条，非脚本 {len(bad7)} 条）"
          + (f"：{bad7}" if bad7 else ""))

# B7b 反向对照：拿**真实误报的原样形状**喂同一个判据，它必须报出来。
#   少了这一条，`nonscript_entries` 写成恒返回 [] 也照样绿（§2.4 的假执行点）。
_FAKE_SPAWN = """  另（spawn）   2 个被调起的脚本在启动后被改过/新建：
                  tools/verify_pending.py
                  PMO/logs/lark_writes.jsonl
                · 脚本每次触发都是新起的进程 —— **它自己的改动不用重启就会生效**
"""
_fake_ents = spawned_entries(_FAKE_SPAWN)
check("B7b", _fake_ents is not None and len(_fake_ents) == 2
      and nonscript_entries(_fake_ents) == ["PMO/logs/lark_writes.jsonl"],
      "反向对照：喂含日志文件的坏样本必须被认出来（2026-10-06 真实误报的形状）")


# ── B8 ★ 2026-10-23 加：**启动器**也必须在读数里 ─────────────────────────
#
# 真事故：改完 `tools/run_shouheng.sh` 走闸门，它报的是
#   「重启会生效  无 —— 启动之后没有任何被 import 的模块或被调起的脚本被改过
#     （那这次重启不带来任何运行时变化，先想清楚为什么还要重启）」
# 而那个文件正是 launchd 要执行的 —— 读数比输入小，方向还劝人别重启。
rc, out = run_gate("--check", "--since=0")
la_all = launched_scripts(out)
check("B8", rc == 0 and "tools/run_shouheng.sh" in la_all and len(la_all) >= 1,
      f"--since=0 → 列出启动器 {len(la_all)} 个（含 plist ProgramArguments 指的 run_shouheng.sh）")
rc, out = run_gate("--check", "--since=9999999999")
check("B8b", rc == 0 and not launched_scripts(out),
      "反向对照：启动器那段也必须按时间过滤，不是一张常量表")
# B8c：整段「无」的判定必须把三类都算进去 —— 否则「无」会在一类有变化时照样出现
check("B8c", "启动器" in GATE.read_text(encoding="utf-8"),
      "闸门的「无变化」那句话必须提到启动器这一类（三类都空才许说「无」）")

# ── C 不许绕过闸门 ──────────────────────────────────────────────────────
print("\nC 绕过闸门的写法（全仓可执行代码）")
offenders = []
for f in code_files():
    rel = str(f.relative_to(ROOT))
    if rel in ALLOWED_CODE:
        continue
    for why in scan_bypass(f.read_text(encoding="utf-8", errors="replace")):
        offenders.append(f"{rel}: {why}")
check("C1", not offenders, f"除闸门与自证外，无人直接操作守护进程（{len(offenders)} 处）")
for o in offenders[:6]:
    print(f"      ✗ {o}")
# 反向对照：喂已知坏样本，扫描器必须红（在内存里做，不碰盘 —— §2.1）
fake = '#!/bin/bash\nlaunchctl kickstart -k gui/501/com.shouheng.lark\n'
check("C2", len(scan_bypass(fake)) == 1, "反向对照：喂一段 kickstart，扫描器报出 1 处")
fake2 = '#!/bin/bash\npkill -f ws_daemon.mjs\n'
check("C3", len(scan_bypass(fake2)) == 1, "反向对照：喂一段 pkill，扫描器报出 1 处")
check("C4", not scan_bypass('# 用 launchctl kickstart -k 重启\n'),
      "反向对照：整行注释里提它 → 不报（注释不可能被执行）")
check("C5", len(scan_bypass('echo ok  # launchctl kickstart\n')) == 1,
      "已知盲区（与 F 共用）：行尾注释仍会被扫到 —— 宁可偶尔吵，不可漏")
# ★★ 2026-10-22 三条：launchctl 要看**目标**（C1 曾把「装别的 launchd 作业」误报成停守衡）
check("C6", len(scan_bypass('launchctl bootout gui/501/com.shouheng.lark\n')) == 1,
      "反向对照：点名守衡的 bootout ⇒ 必报")
check("C7", scan_bypass('launchctl bootout "gui/$(id -u)/com.kb.skill-growth"\n') == [],
      "反向对照（成对）：点名**别的** launchd 作业 ⇒ 不报（这就是那条真误报的形状）")
check("C8", len(scan_bypass('launchctl bootout "gui/$(id -u)/$LABEL"\n')) == 1,
      "反向对照：没点名任何作业（变量目标）⇒ 仍按可疑报 —— 收窄不许把洞挖出来")

def keepalive_ok(raw):
    """崩了真的会被拉起来吗？判据只有一条：`KeepAlive.SuccessfulExit` 必须是 False。

    实测（2026-09-21，用同款配置的临时 launchd 作业）：
        脚本 exit 0 → launchd 只运行 1 次，之后再也没拉过
        脚本 exit 1 → 9 秒内被拉起 5 次
    而 ws_daemon.mjs 收到 SIGTERM 时走 process.exit(0) —— 所以这一位一旦被
    翻成 true，「崩了会自愈」就是一句空话，**而且没有任何东西会红**。
    这正是要断言它的理由：这份配置唯一的作用就是决定「它还活不活得过来」。

    拆成纯函数是为了能拿假样本喂它（本文件 D5/D6）—— 反向对照只在内存里做（§2.1）。
    """
    try:
        ka = plistlib.loads(raw).get("KeepAlive")
    except Exception:
        return False
    return isinstance(ka, dict) and ka.get("SuccessfulExit") is False


# ── D 自愈的前提还在吗 ──────────────────────────────────────────────────
print("\nD 「崩了会自愈」这个前提")
if not PLIST_LIVE.exists():
    check("D1", False, f"在跑的 plist 不存在：{PLIST_LIVE}")
else:
    h = lambda b: hashlib.sha256(b).hexdigest()[:12]
    same = PLIST_REPO.exists() and h(PLIST_REPO.read_bytes()) == h(PLIST_LIVE.read_bytes())
    check("D1", same, "仓库副本 ≡ 在跑的配置（否则你读到的不是生效的）")
    raw = PLIST_LIVE.read_bytes()
    try:
        pl = plistlib.loads(raw)
        check("D2", keepalive_ok(raw), f"KeepAlive.SuccessfulExit = {pl['KeepAlive'].get('SuccessfulExit')}（应 False）")
        check("D3", pl.get("Label") == LABEL, f"Label = {pl.get('Label')}")
        args = pl.get("ProgramArguments") or []
        runner = next((a for a in args if a.endswith(".sh")), "")
        rp = Path(runner)
        check("D4", rp.exists() and os.access(rp, os.X_OK), f"启动器存在且可执行：{runner}")
    except Exception as e:
        check("D2", False, f"plist 解不出来：{e}")
# 反向对照：喂假 plist，判据必须变红（内存里造，不碰盘）
fake_on = plistlib.dumps({"Label": LABEL, "KeepAlive": {"SuccessfulExit": True}})
check("D5", not keepalive_ok(fake_on), "反向对照：SuccessfulExit=true → 判红（那就不自愈了）")
check("D6", not keepalive_ok(plistlib.dumps({"Label": LABEL})), "反向对照：整个 KeepAlive 缺失 → 判红")

def judge_ws(rs: dict, log_tail: str, now: float) -> tuple:
    """判「守衡此刻还连着飞书吗」。回 `(结论, 说明)`，结论 ∈ ok / down / untested。

    ★ 为什么这条断言必须存在（2026-10-05 实测）：07:10 长连接断了
      （`getaddrinfo ENOTFOUND open.feishu.cn` → 之后 `timeout of 15000ms exceeded`），
      而**整个 E 段照样全绿** —— 进程活着、心跳照打、日志照写。
      也就是：**守衡对外失联，自证说「✅ 全过」。**
      这正是 §2.4.1 第 4 行那个病（否定结论不许比输入大）的镜像：
      这里是把「进程活着」当成了「还连着飞书」。

    两路输入，**先结构化、后退日志**，且都要能区分「连着」与「说不清」：
      ① `run-state.wsConnected`（2026-10-05 起由 daemon 写，权威）；
      ② 日志尾部：`ws client ready` 与断线标记（`unable to connect to the server after trying`
         ／`getaddrinfo`／`timeout of 15000ms exceeded`）**谁在后面** —— 断线标记在后 = 断了。
    两路都取不到 → **untested**（不许当成「连着」）。
    """
    if isinstance(rs, dict) and "wsConnected" in rs:
        if rs.get("wsConnected") is True:
            return "ok", "run-state.wsConnected=true（daemon 自己报的，权威）"
        down_s = rs.get("wsDownSeconds")
        err = rs.get("wsLastError") or "（没记错误）"
        if not isinstance(down_s, (int, float)):
            return "untested", "写着断线却没给断开时长 —— 读不出「断了多久」"
        mins = down_s / 60.0
        if mins >= 5:
            return "down", ("长连接已断 %.0f 分钟（最后错误：%s）—— **这段时间群里发的消息收不到**"
                            % (mins, str(err)[:80]))
        return "down", "长连接刚断 %.1f 分钟，SDK 正在重连（最后错误：%s）" % (mins, str(err)[:80])

    # 退到日志：只认**阳性**信号（看得见断线标记），看不见就说「未测」
    if not log_tail:
        return "untested", "既没有 run-state.wsConnected，也读不到日志 —— 连没连着【未测】"
    lines = [l for l in log_tail.splitlines() if l.strip()]
    last_ready = max([i for i, l in enumerate(lines) if "ws client ready" in l], default=-1)
    BAD = ("unable to connect to the server after trying", "getaddrinfo", "timeout of 15000ms exceeded")
    last_bad = max([i for i, l in enumerate(lines) if any(b in l for b in BAD)], default=-1)
    if last_bad > last_ready:
        return "down", ("日志里最后一次连接动静是**失败**（第 %d 行起）：%s"
                        % (last_bad + 1, lines[last_bad][:120]))
    if last_ready >= 0:
        return "untested", ("日志里最后一次是 `ws client ready`，但**那是过去式** —— "
                            "这条路径证明不了「此刻还连着」（这个进程比 wsConnected 这个读数还老）")
    return "untested", "日志里既没有连上过、也没有失败标记 —— 【未测】"


check("D7", not keepalive_ok(b"not a plist at all"), "反向对照：plist 解不出来 → 判红（不许静默当成通过）")

# ── E 它现在活着吗 ──────────────────────────────────────────────────────
# 2026-09-22 重写：原先 E1 读的是 `ps -o etime=`，而 `ps` 在本环境被拒 →
# 这一格**永远**是未测、整个自证恒退 2。现在四个子读数都不需要 ps，
# 且合起来由纯函数 `judge_liveness` 判 —— 它可以被喂坏样本（见 E1 的反向对照）。
print("\nE 它现在活着吗")
if UP is None:
    cannot_test("E1", "跑不了 `pgrep`（受限环境）—— 「在不在跑」【未测】，不等于「没在跑」")
elif UP:
    lstate, lpid, lnote = read_launchd()
    if lstate is None:
        cannot_test("E1a", "launchd 读不到（%s）→ 这一格未测；下面几格照给结论" % lnote)
    else:
        check("E1a", lstate == "running",
              "launchd state=%s pid=%s（权威在这里：KeepAlive 归它管）" % (lstate, lpid))
    use_pid = lpid or PID
    check("E1b", str(use_pid) in [str(x) for x in PIDS],
          "pid %s 在 `pgrep -f ws_daemon.mjs` 里（活着的确实是守护进程）" % use_pid)
    kres = kill_probe(use_pid)
    check("E1c", kres in ("ok", "EPERM"),
          "os.kill(%s,0) → %s%s" % (use_pid, kres,
                                    "（EPERM = 权限受限但进程存在）" if kres == "EPERM" else ""))
    up_min, up_src = uptime_minutes(use_pid)
    beat, beat_src = beat_age_minutes()
    if up_min is None:
        cannot_test("E1d", "运行时长【未测】：%s" % up_src)
    else:
        check("E1d", True, "已运行 %.0f 分钟（来源：%s）；最后一次心跳 %.0f 分钟前（来源：%s）"
              % (up_min, up_src, beat if beat is not None else -1, beat_src))
    concl, why = judge_liveness(lstate, use_pid, PIDS, kres, beat)
    if concl == "up":
        check("E1", True, why)
    elif concl == "untested":
        cannot_test("E1", why)
    else:
        check("E1", False, "✗ %s：%s" % (concl, why))
    log = DAEMON_LOG.read_text(encoding="utf-8", errors="replace") if DAEMON_LOG.exists() else ""
    check("E2", "长连接已启动" in log, f"日志里出现过启动横幅 {log.count('长连接已启动')} 次")
    age = (time.time() - DAEMON_LOG.stat().st_mtime) / 60 if DAEMON_LOG.exists() else 1e9
    check("E3", age < 12, f"日志 {age:.0f} 分钟前还在写（心跳每 5 分钟一次 → 没卡死）")

    # ── E4 还连着飞书吗（2026-10-05 加）──────────────────────────────────
    # 「进程活着」≠「还在答话」。断线时群里发的消息**收不到也不会补**，
    # 而那与进程死掉在盘上是同一个后果 —— 只是更难发现。
    #
    # ★★ 2026-10-09 实测补记：**重启之后的前 5 分钟，E4 必然读到 `wsConnected=false`。**
    #   `run-state.wsConnected` 是**心跳**（每 5 分钟一次）更新的 —— 进程起来 2 秒就把状态
    #   文件写了那一格，而那时长连接还没 ready，于是它写着 `false`。
    #   实测：10:33:43 重启 → 10:34、10:39:10 两次读都是 `false`（退 2），
    #   10:39:53 首个心跳落地后读到 `true`（全过 rc=0）。
    #
    #   为什么必须把这件事写在这里：**这是 E4 唯一会「对正常状态报未测」的场合。**
    #   不写下来，下一个人有两条错路可走 ——
    #     ① 把重启后的 rc=2 读成**真断线**，去查一个不存在的故障；
    #     ② 更坏：学会**无视 rc=2**，从此 E4 真的断线时也不看了
    #        （§2.1.1：一个会误报的检查器比没有检查器更糟）。
    #   正确做法是**等首个心跳**（≤5 分钟）再下结论 —— 而不是改判据把它变绿。
    _rs = {}
    try:
        if RUN_STATE.exists():
            _rs = json.loads(RUN_STATE.read_text(encoding="utf-8"))
    except Exception as _e:
        _rs = {"__err": str(_e)}
    _ws_concl, _ws_why = judge_ws(_rs, "\n".join(log.splitlines()[-400:]), time.time())
    if _ws_concl == "ok":
        check("E4", True, _ws_why)
    elif _ws_concl == "down":
        # 失联 = **未测**，不是红：与 §2.7 的口径一致（它此刻在对外失联，退 2）
        cannot_test("E4", "⚠️ " + _ws_why)
    else:
        cannot_test("E4", _ws_why)

    # E4 的反向对照：喂合成读数，四条必须各自落对（不碰真网络、不碰真状态）
    for _rs_probe, _tail_probe, _want, _name in [
        ({"wsConnected": True}, "", "ok", "run-state 说连着"),
        ({"wsConnected": False, "wsDownSeconds": 1800, "wsLastError": "getaddrinfo ENOTFOUND"},
         "", "down", "断了 30 分钟"),
        ({"wsConnected": False, "wsDownSeconds": 20, "wsLastError": "timeout"},
         "", "down", "刚断 20 秒（也算断，但文案不同）"),
        ({}, "…\n[i] [ 'ws', 'ws client ready' ]\n…\n[e] [ '[ws]', 'getaddrinfo ENOTFOUND x' ]",
         "down", "老进程：日志里最后一次动静是失败"),
        ({}, "…\n[i] [ 'ws', 'ws client ready' ]\n…", "untested",
         "老进程：日志最后是连上过 —— **不许当成「此刻连着」**"),
        ({}, "", "untested", "两路输入都空"),
        ({"wsConnected": False}, "", "untested", "说断了却没给时长"),
    ]:
        _got4, _ = judge_ws(_rs_probe, _tail_probe, time.time())
        check("E4r", _got4 == _want, "%s → %s（期望 %s）" % (_name, _got4, _want))
else:
    check("E1", False, "✗ 没有在跑 —— 群里现在没人在答话")

# E1 的反向对照：喂合成读数，四种结论必须**各自落对**（不碰真进程）
print("\nE5 这次启动**走闸门了吗**（台账里有这一笔吗）")
_rt_start, _rt_ledger, _rt_end, _rt_note = restart_trace_readings()
_rt_concl, _rt_why = judge_restart_trace(_rt_start, _rt_ledger, _rt_end)
if _rt_concl == "traced":
    check("E5", True, _rt_why)
elif _rt_concl == "untraced":
    # ★ 判红（不是未测）：读数**采到了**，结论是「这次启动没走闸门」—— 那是可归因的事实。
    check("E5", False, "✗ " + _rt_why)
elif _rt_concl == "crash_restart":
    # 不许报红（那可能是 launchd 自己拉的，凭这一条判不了）—— 但**要出声**：
    # 「它塌过一次」这件事必须有人看，否则与"一切正常"长得一样。
    cannot_test("E5", "⚠️ " + _rt_why)
else:
    cannot_test("E5", _rt_why + ("（%s）" % _rt_note if _rt_note else ""))

# E5 的反向对照：喂合成读数，三态必须各自落对（不碰真台账）
for _args, _want, _name in [
    ((1000.0, (990.0, "2026-01-01T00:00:00Z", "why")), "traced", "台账晚于/等于启动 ⇒ 走过闸门"),
    ((1000.0, (1000.0, "x", "why")), "traced", "同一秒也算走过（表与进程启动有秒级抖动）"),
    ((2000.0, (1000.0, "x", "why")), "untraced", "启动比台账晚 1000 秒 ⇒ 没走闸门"),
    ((1000.5, (1000.0, "x", "why")), "traced", "差 0.5 秒在容差内（不许把正常情况报红）"),
    ((None, (1000.0, "x", "why")), "untested", "启动时刻读不到 ⇒ 未测"),
    ((1000.0, None), "untested", "台账读不到 ⇒ 未测"),
    ((2000.0, (1000.0, "x", "why"), "commanded"), "untraced", "晚于台账 + 干净收尾 ⇒ 判红"),
    ((2000.0, (1000.0, "x", "why"), "crash"), "crash_restart",
     "晚于台账但**不是**干净收尾 ⇒ 不许判红（可能是 launchd 自己拉的）"),
    ((2000.0, (1000.0, "x", "why"), "unknown"), "crash_restart", "收尾痕迹读不出 ⇒ 也不许判红"),
]:
    _got5, _ = judge_restart_trace(*_args)
    check("E5r", _got5 == _want, "%s → %s（期望 %s）" % (_name, _got5, _want))

# E1 的反向对照：喂合成读数，四种结论必须**各自落对**（不碰真进程）
print("\nE1 的反向对照（纯函数，不碰真进程）")
for _args, _want, _name in [
    (("running", "3971", ["3971"], "ok", 1.0), "up", "正常在跑"),
    (("running", "3971", ["3971"], "EPERM", 2.0), "up", "kill 被拒(EPERM)但进程在 → 仍算活着"),
    (("running", "3971", ["3971"], "ESRCH", 1.0), "down", "进程真的没了"),
    (("running", "3971", ["9999"], "ok", 1.0), "down", "活着但不是守护进程"),
    (("exited", "3971", ["3971"], "ok", 1.0), "down", "launchd 说没在跑"),
    (("running", "3971", ["3971"], "ok", 20.0), "stuck", "在跑但心跳过期（卡住）"),
    ((None, None, [], "nopid", None), "untested", "一个读数都没采到"),
]:
    _got, _ = judge_liveness(*_args)
    check("E1r", _got == _want, "%s → %s（期望 %s）" % (_name, _got, _want))

# ── F bash 陷阱 ─────────────────────────────────────────────────────────
print("\nF macOS bash 3.2：变量后面直接跟中文")
trap_hits = []
for f in code_files():
    if f.suffix != ".sh":
        continue
    for ln, var, txt in scan_bash_trap(f.read_text(encoding="utf-8", errors="replace")):
        trap_hits.append(f"{f.relative_to(ROOT)}:{ln} ${var} → {txt}")
check("F1", not trap_hits, f"tools/ 与 base/ 下的 .sh 无此写法（{len(trap_hits)} 处）")
for t in trap_hits[:6]:
    print(f"      ✗ {t}")
check("F2", len(scan_bash_trap('echo "值 $P，中文"\n')) == 1, "反向对照：喂 $P， → 报出 1 处")
check("F3", not scan_bash_trap('echo "值 ${P}，中文"\n'), "反向对照：喂 ${P}， → 不报（花括号是正确写法）")
check("F4", not scan_bash_trap('# 说明：$EVENTS）会被吃成变量名\n'),
      "反向对照：整行注释里提它 → 不报（注释不可能被执行）")

# ── G 文档里的命令不许被自动执行 ────────────────────────────────────────
print("\nG 文档里的命令不许被自动执行（§2.7 那段 bash 里有会真重启的命令）")


def runs_doc_commands(src):
    """这个检查器会不会把 AGENTS.md 里的命令真跑一遍？

    本仓库里唯一会「把文档里的 bash 跑一遍」的是 `verify_skill.py`，它扫的是
    `skills/内容合规审查/SKILL.md`。**那个范围不许扩到 AGENTS.md** ——
    一旦扩了，§2.7 里那条 `--yes` 就会被它真执行，等于**未经同意重启守衡**。

    判据故意取得很粗：源码里出现 `AGENTS.md` 就报。因为它目前**没有任何理由**
    出现这个串（真正读 AGENTS.md 的是 `verify_feishu_index.py` 的 M4，不是它）。
    粗判据在这里是对的 —— 它只会因为「有人真的把 AGENTS.md 接进去了」而红，
    不会因为无关改动误报。
    """
    return "AGENTS.md" in src


SKILL_RUNNER = ROOT / "tools" / "verify_skill.py"
if not SKILL_RUNNER.exists():
    check("G1", False, "找不到 tools/verify_skill.py —— 那个「跑文档命令」的检查器不见了")
else:
    check("G1", not runs_doc_commands(SKILL_RUNNER.read_text(encoding="utf-8", errors="replace")),
          "verify_skill.py 的扫描范围里不含 AGENTS.md（§2.7 的 --yes 不会被它跑）")
check("G2", runs_doc_commands('SKILL = os.path.join(ROOT, "AGENTS.md")'),
      "反向对照：喂一个把 AGENTS.md 当扫描目标的假样本 → 报红")
check("G3", not runs_doc_commands('SKILL = os.path.join(ROOT, "skills", "x", "SKILL.md")'),
      "反向对照：正常的 SKILL.md 目标 → 不报")

# ── J 身份拒收的读数（2026-10-16 加）────────────────────────────────────
# 拒收是**正确行为**（不把别人的结论当本单的），所以**不加闸**；
# 要看见的是「它开始频繁发生」—— 那意味着那把锁又失效了，
# 表现是「每一单都少了库侧依据」，而卡片上只写「库侧没读数」。
# ★ 这一段的读数是**事实**（数出来的），不是判决；唯一会红的是 J3 那个计数器自证。
print("\nJ 身份拒收（读数；拒收本身是正确行为，不判红）")


def count_identity_rejects(path, since_ts=None):
    """数账本里的拒收行。坏行**单独计数**（不许悄悄吃掉，也不许当 0）。"""
    pth = Path(path)
    if not pth.exists():
        return {"n": 0, "bad": 0, "exists": False}
    n = bad = 0
    for line in pth.read_text(encoding="utf-8", errors="replace").splitlines():
        if not line.strip():
            continue
        try:
            d = json.loads(line)
        except Exception:
            bad += 1
            continue
        if since_ts is not None:
            try:
                t = datetime.datetime.fromisoformat(str(d.get("at", "")).replace("Z", "+00:00"))
            except Exception:
                bad += 1
                continue
            if t.timestamp() < since_ts:
                continue
        n += 1
    return {"n": n, "bad": bad, "exists": True}


REJECT_LOG = ROOT / "PMO" / "logs" / "identity-reject.ndjson"
try:
    _j = count_identity_rejects(REJECT_LOG)
    _j24 = count_identity_rejects(REJECT_LOG, time.time() - 86400)
    if not _j["exists"]:
        check("J1", True, "拒收账本还没出现过 ⇒ 上线以来 **0 次拒收**（这是事实，不是未测）")
    elif _j["bad"]:
        cannot_test("J1", f"⚠️ 账本里有 {_j['bad']} 行解不开 ⇒ 数不准（先看 PMO/logs/identity-reject.ndjson）")
    else:
        check("J1", True, f"身份拒收：累计 {_j['n']} 次｜最近 24 小时 {_j24['n']} 次")
    if _j24["n"] >= 3:
        check("J2", True, f"⚠️ 24 小时内拒收 {_j24['n']} 次 —— 那把锁可能在失效（打开账本看 want/got 逐字对比）")
    else:
        check("J2", True, "拒收频次正常（< 3 次/24h）—— 它是**正确行为**，只在这个数开始爬时才说明锁失效")
except Exception as _e:
    cannot_test("J1", f"⚠️ 读拒收账本抛了：{_e}")

# J3 反向对照：**计数器自己**必须会数错的时候数错（否则这一段就是个安慰）
try:
    with tempfile.NamedTemporaryFile("w", suffix=".ndjson", delete=False, encoding="utf-8") as fh:
        _tp = fh.name
        fh.write(json.dumps({"at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "where": "旁挂"}) + "\n")
        fh.write("{坏行\n")
        fh.write("\n")
    _c = count_identity_rejects(_tp)
    _c_old = count_identity_rejects(_tp, time.time() + 3600)
    _c_missing = count_identity_rejects(_tp + ".nope")
    check("J3", _c["n"] == 1 and _c["bad"] == 1 and _c_old["n"] == 0 and _c_missing["n"] == 0 and not _c_missing["exists"],
          "计数器自证：好行数对、**坏行单独计数**、时间窗外的行不算、文件不在 ⇒ 0 次且标 `exists=false`")
    os.unlink(_tp)
except Exception as _e:
    check("J3", False, f"计数器自证抛了：{_e}")

# J4/J5 域外依据被挡的读数（2026-10-16 加，与 J1/J2 同形但看**另一本账**）────────
# 为什么要有它：菜单只列美国来源，**解析也只认美国来源**（非美国 id ⇒ 不给链接、
# 按「无库内依据」写）。被挡是**正确行为**，所以不判红；要看见的是「**它开始出现**」——
# 出现就意味着它在点一个**菜单里没有**的来源（猜的），或菜单又被改宽了。
NONUS_LOG = ROOT / "PMO" / "logs" / "nonus-cite.ndjson"
try:
    _n4 = count_identity_rejects(NONUS_LOG)      # 同一把尺子：数行、坏行单独计
    if not _n4["exists"]:
        check("J4", True, "域外依据账本还没出现过 ⇒ 上线以来 **0 次被挡**（这是事实，不是未测）")
    elif _n4["bad"]:
        cannot_test("J4", f"⚠️ 账本里有 {_n4['bad']} 行解不开 ⇒ 数不准（先看 PMO/logs/nonus-cite.ndjson）")
    else:
        check("J4", True, f"域外依据被挡：累计 {_n4['n']} 次（打开账本看是哪个 id、哪个辖区）")
except Exception as _e:
    cannot_test("J4", f"⚠️ 读域外依据账本抛了：{_e}")

# J5 接线：心跳里必须**真的调**那条读数 —— 只定义不调用 ＝ 写了没人看
#   （与 `test_agent.mjs` 那条「handleMessage 必须真的调闸门」同一种断言：**接线级**。
#    它只证明读数被接上，**不证明模型真的会被挡** —— 后者在 `ext_basis.mjs --selftest`
#    里用「喂 S15 ⇒ 不给链接」＋「S15 辖区改 US ⇒ 又给链接」两条反向对照证。）
try:
    _dae = (ROOT / "tools" / "ws_daemon.mjs").read_text(encoding="utf-8")
    _tail = _dae.split("const hb = setInterval", 1)
    # 心跳体就在紧跟的那一段里；取一个足够宽的窗口（两段读数都必须落在里面）
    _win = _tail[1][:1500] if len(_tail) == 2 else ""
    check("J5",
          # ★ 判据要按**位置**分开看，别把两件事混成一句（这条断言第一版就是这么红的：
          #   我要求「心跳窗口里出现 `nonUsCiteCount()`」，而那个调用在**心跳之前**的函数体里，
          #   心跳里调的只是 `nonUsCiteLine()` —— 一个写错的判据会报出一条指向无关方向的假红）。
          "function nonUsCiteLine()" in _dae        # ① 读数函数有定义
          and "nonUsCiteCount()" in _dae             # ② 定义体里真的去读了账本
          and "nonUsCiteLine()" in _win,             # ③ **心跳里真的调了它**
          "接线：`ws_daemon.mjs` 里 `nonUsCiteLine()` 有定义（且体里真读账本），**心跳里真的调了它**")
except Exception as _e:
    check("J5", False, f"读 ws_daemon.mjs 抛了：{_e}")

# ── I 事件计数必须成对（否则重启闸门永久报「在用」）───────────────────────
#
# 病灶（2026-10-22 审计发现，还没出事故，但一定会）：
#   `restart_shouheng.sh` 的「正在处理中」判据是 `events > handled+skipped+failed+uncaught`；
#   而 `ws_daemon.mjs` 里 `bot.added` / `bot.deleted` / `card.action.trigger` 三个 handler
#   原先**只 `events++`、从不记任何 done** ⇒ 收到过一次这类事件，`events` 就永远比 `done` 多 1，
#   闸门从此**永久**报「有 1 条还没走完、现在重启会掐断它」，也就永远拒绝重启。
#   「闸门成砖头」与「闸门被绕过」是同一件事的两面：两条路都会让 §2.7 那道门失效。
print("\nI 事件计数必须成对（否则重启闸门永久报「在用」）")

_DONE_TOKENS = ("counters.handled++", "counters.skipped++",
                "counters.failed++", "counters.uncaught++")


def unaccounted_events(text):
    """每个 `counters.events++` 后面（到下一个 events++ 之前）都必须出现一次「走完」计数。

    为什么窗口取「到下一个 events++」：`counters.events++` 在本文件里**只在事件入口**出现，
    所以这个窗口恰好就是那一个 handler 的体。不做语法分析也能吃得准，且不会因为
    以后挪了缩进/换了写法就失效（本仓有过「判据按行号对齐、重构即红」的教训）。
    """
    lines = text.splitlines()
    starts = [i for i, ln in enumerate(lines) if "counters.events++" in ln]
    bad = []
    for n, i in enumerate(starts):
        end = starts[n + 1] if n + 1 < len(starts) else len(lines)
        if not any(any(tok in ln for tok in _DONE_TOKENS) for ln in lines[i:end]):
            bad.append(i + 1)          # 1-based 行号，便于人去找
    return bad


try:
    _dae2 = (ROOT / "tools" / "ws_daemon.mjs").read_text(encoding="utf-8")
    _bad = unaccounted_events(_dae2)
    check("I1", not _bad,
          "`ws_daemon.mjs` 里每个 `counters.events++` 都有配对的「走完」计数"
          f"（没配对 {len(_bad)} 处" + (f"：第 {_bad} 行）" if _bad else "）"))
    # 反向对照①：喂「只 events++、不销账」的坏样本 ⇒ 必须报出那一行
    check("I2", unaccounted_events("x() { counters.events++; log('a'); }\n") == [1],
          "反向对照：只 events++ 不销账 ⇒ 报出 1 处")
    # 反向对照②：喂「配对」的样本 ⇒ 必须闭嘴（否则这条判据恒红，等于没有）
    check("I3", unaccounted_events("a() { counters.events++; counters.skipped++; }\n") == [],
          "反向对照（成对）：events++ 与 skipped++ 在一起 ⇒ 不报")
    # 反向对照③：本仓当前是不是**真的**有三种非消息事件？少一类就说明这段判据在替不存在的代码作证
    _kinds = sum(1 for k in ("im.chat.member.bot.added_v1", "im.chat.member.bot.deleted_v1",
                             "card.action.trigger") if k in _dae2)
    check("I4", _kinds == 3,
          f"注释点名的三类非消息事件 handler 都在（{_kinds}/3）")
except Exception as _e:
    check("I1", False, f"读 ws_daemon.mjs 抛了：{_e}")

# ── H 结论行自己不许撒谎（反向对照，全在内存里，不碰盘）─────────────────
print("\nH 结论行自己不许撒谎（未测 ≠ 通过 ≠ 红）")
check("H1", verdict(0, True, 0)[0] == 0, "全过 + 在跑 → 退 0")
check("H2", verdict(3, True, 0)[0] == 1, "有红 → 退 1")
check("H3", verdict(1, False, 0)[0] == 2,
      "**没在跑 → 退 2**（此前 n_fail 分支排在前面，这个 2 是死代码，永远到不了）")
check("H4", verdict(0, True, 2)[0] == 2, "**有未测 → 退 2**（不许当成通过）")
# 文案判据要区分「说」和「否认」：未测那句里必须出现「未测」，但不许出现 ✅。
# （本项目 V25b 踩过这个坑：只查「有没有『通过』二字」会把「这不是通过」也判成撒谎。）
check("H5", "未测" in verdict(0, True, 1)[1] and "✅" not in verdict(0, True, 1)[1],
      "未测的文案说「未测」且不带 ✅（不把没测说成没问题）")
check("H6", "✅" in verdict(0, True, 0)[1] and "✅" not in verdict(0, True, 2)[1],
      "只在真的全过时才出现 ✅")
check("H7", "未测" in verdict(2, True, 1)[1],
      "**有红时也必须报出有未测** —— 否则只看最后一行的人会以为「其余都验过了」")

# ── K 重启闸门必须看得见**正在跑的审查链**（2026-10-26 真事故）────────────
#
# 病灶（当天，我自己踩的，两张图永远没等到结论）：
#   守衡对一条送审**先回执卡**、再由链异步产出结论。而 `restart_shouheng.sh` 原有那条
#   「正在处理中」判据数的是 `daemon-run.json` 里「**消息**有没有走完」——
#   回执一发，消息就算走完了，链却还在跑 ⇒ 闸门在 14:43:34 与 14:55:15 两次放行，
#   两次 kickstart 都掐断了正在跑的链；两个实例退出时逐字都是
#   `本次统计：事件 1 / 已回答 0 / 已发送 0`，群里那两张图**只有回执、没有结论**，
#   而守衡**不会**自动重试。用户看到的就是「守衡怎么不回复了」。
# ⇒ 这一组钉两件事：① 闸门真的读了链的读数（不是只在注释里提过链）；
#   ② 那个读数真的进**拒绝**分支（「名字出现过 ≠ 它拦得住」）。
print("\nK 重启闸门必须看得见正在跑的审查链")
try:
    _gate = GATE.read_text(encoding="utf-8")
    _reads = ("chains-in-flight.json" in _gate) and ("kb/l8/review_run" in _gate)
    _refuses = ('[ "$CHAIN_N" != "0" ]' in _gate) and ("exit \"$EXIT_REFUSED\"" in _gate)
    check("K1", _reads and _refuses,
          "闸门既读了链的读数（落盘 + 进程探针），也在**拒绝**分支里用了它")
    # 反向对照①：把链那一段从闸门正文里抠掉 ⇒ 必须判成「没读」
    _stripped = "\n".join(ln for ln in _gate.splitlines()
                           if "CHAIN_N" not in ln and "chains-in-flight" not in ln)
    check("K2", ("CHAIN_N" not in _stripped) and ("chains-in-flight.json" not in _stripped),
          "反向对照：把链那几行抠掉 ⇒ K1 的两半都不再成立（判据咬得住，不是恒真）")
    # 真跑一次：造一个 argv 里带 `kb/l8/review_run.sh` 的假进程 ⇒ 读数必须变「在飞」
    import subprocess as _sp
    _dummy = _sp.Popen(["bash", "-c", "exec -a 'bash kb/l8/review_run.sh --base FAKE-K' sleep 25"])
    try:
        import time as _t
        _t.sleep(1.2)
        _r1 = _sp.run(["bash", str(GATE), "--check"], cwd=str(ROOT),
                      capture_output=True, text=True, timeout=60)
        _out1 = _r1.stdout + _r1.stderr
        check("K3", ("审查链在飞" in _out1) and ("⚠" in _out1.split("审查链在飞", 1)[-1][:40]),
              "真探针：有链在跑时，闸门的读数行报「审查链在飞 ⚠」")
    finally:
        _dummy.terminate()
        try:
            _dummy.wait(timeout=5)
        except Exception:
            _dummy.kill()
    # 反向对照②：进程没了 ⇒ 读数必须回到「无」（否则这一格恒红，等于没有）
    import time as _t2
    _t2.sleep(0.6)
    _r2 = _sp.run(["bash", str(GATE), "--check"], cwd=str(ROOT),
                  capture_output=True, text=True, timeout=60)
    _out2 = _r2.stdout + _r2.stderr
    _line2 = next((ln for ln in _out2.splitlines() if "审查链在飞" in ln), "")
    check("K4", ("审查链在飞" in _out2) and ("无" in _line2),
          f"反向对照（成对）：没有链在跑 ⇒ 读数回到「无」（实得：{_line2.strip()[:60]}）")
except Exception as _e:
    check("K1", False, f"读/跑重启闸门抛了：{_e}")

# ── 结论 ────────────────────────────────────────────────────────────────
n_fail = sum(1 for _, ok, _ in results if not ok)
print("\n" + "=" * 74)
for cid, ok, msg in results:
    print(f"  {'✅' if ok else '❌'} {cid}  {msg}")
for cid, msg in untested:
    print(f"  ⚠ {cid}  {msg}")
print("=" * 74)
_code, _line = verdict(n_fail, UP, len(untested))
print(_line)
if n_fail:
    print(f"   （共 {len(results)} 项断言，{n_fail} 项红）")
sys.exit(_code)

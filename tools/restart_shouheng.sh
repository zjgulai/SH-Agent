#!/bin/bash
# ─────────────────────────────────────────────────────────────
# restart_shouheng.sh —— 守衡重启闸门
#
# 为什么需要闸门：守衡是在飞书群里**对外说话**的常驻进程。重启它不是
# 「让改动生效」这么中性的一件事 —— 重启窗口里群里发的消息不会被回答。
# 所以默认行为是**拒绝**：不带 --yes 时它只报告影响面，不改动任何东西。
#
# ★ 它拦住的第二件事比第一件更要紧：kill -TERM 会让守衡**永久静默**。
#
#   实测（2026-09-21，用与守衡同款 KeepAlive 配置的临时 launchd 作业）：
#     脚本 exit 0  →  launchd 只运行 1 次，之后再也没拉过
#     脚本 exit 1  →  9 秒内被拉起 5 次（ThrottleInterval 节流）
#
#   而 tools/ws_daemon.mjs 收到 SIGTERM 时走的是 process.exit(0)：
#     kill -TERM <pid> → 优雅退出 → 退出码 0 → launchd 按
#     KeepAlive{SuccessfulExit:false} 认定「这是正常停机」→ **不拉起**。
#   日志里只留一行「收到 SIGTERM，正在收尾… 本次统计：…」，
#   读起来完全像一次正常停机。**没有任何东西会红。**
#
#   ⇒ 唯一正确的重启方式是 launchctl kickstart -k。本脚本只用这一条。
#
# 用法：
#   bash tools/restart_shouheng.sh                 # 只报告影响面，拒绝（退 3）
#   bash tools/restart_shouheng.sh --check         # 同上，但退 0（纯查看）
#   bash tools/restart_shouheng.sh --yes --why="..."   # 真重启，必须留痕
#
# 它没在跑的时候不必问：那时这不是「重启」而是「救活」，失联每多一秒
# 都是净损失。闸门自己核这件事（不是听调用方说），并记为 mode=rescue。
# ─────────────────────────────────────────────────────────────
set -uo pipefail

LABEL="com.shouheng.lark"
DOMAIN="gui/$UID"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LEDGER="$ROOT/PMO/logs/restart-ledger.jsonl"
EVENTS="$ROOT/PMO/logs/ws_events.jsonl"
DAEMON_LOG="$ROOT/PMO/logs/ws_daemon.log"

EXIT_REFUSED=3

# ── 「同意」是有保质期的：读数与执行必须落在**同一次**对话里 ──────────
#
# ★ 2026-09-22 实测的事故，这道闸门就是为它加的：
#
#   17:54  我跑不带 --yes 的那条，读到「重启会生效：3 个模块 + 1 个脚本」，念给委托方
#   17:55  另**一个会话**自己重启了一次（台账 30696→38441），把那些改动全加载了
#   18:03  我拿 17:54 的读数去执行 --yes —— 而闸门当场打印的是「重启会生效 **无**」，
#          底下还写着「那这次重启不带来任何运行时变化，先想清楚为什么还要重启」。
#          **我没有重读，于是执行了一次零收益的重启。**
#
#   那一次代价是运气好（17:50 之后入站事件为 0，一条消息没丢）。
#   但这个形状与 §2.4.6 / §2.7 点名的病**是同一个**：
#   **一份有保质期的读数，没有任何东西在它过期时把我拦住。**
#   只不过前面几次长在状态文件上，这一次长在**闸门自己的输出**上。
#
# 所以：读数写成一份**一次性凭证**，`--yes` 必须带着它，且它必须仍然对得上。
# 三条都要过 —— 任一条不过就拒，并且**把是哪一条说清楚**（拒绝不许含糊）。
CONSENT="${SHOUHENG_RESTART_CONSENT:-$ROOT/PMO/shouheng-state/restart-consent}"
CONSENT_MAX_AGE=300          # 5 分钟。够人念完再决定，不够跨过一次别人的重启。

YES=0; CHECK=0; WHY=""; SINCE=""; NO_KICK=0; FORCE_INFLIGHT=0
for a in "$@"; do
  case "$a" in
    --yes)   YES=1 ;;
    --check) CHECK=1 ;;
    --why=*) WHY="${a#--why=}" ;;
    # --no-kick：把 --yes 那条路上**全部**校验跑完，但**不真重启**，退 0。
    # 它存在的唯一理由是让自证能断言「凭证有效这条路上不会误报」（§2.1.1：
    # 一个会误报的检查器比没有检查器更糟）。它**不会**消耗凭证，也**不动进程** ——
    # 所以它不构成绕过：它一次 kickstart 都不发。
    --no-kick) NO_KICK=1 ;;
    # ★★ 2026-10-17：**正在处理中的消息会被 kickstart 掐断**（当天真事故：14:22 那条
    #   评审跑到「建议生成」被重启掐掉，回执发出去了、正式答案永远没来；
    #   日志逐字 `本次统计：事件 2 / 已回答 0 / 已发送 0`）。
    #   所以「有消息正在处理」时**默认拒绝**；确实要硬重启的，必须显式加这个旗子。
    --force-inflight) FORCE_INFLIGHT=1 ;;
    # --since 只改「重启会生效」那块读数的参照时间，不参与要不要重启的决定。
    # 存在的理由：不加它，那块读数在最常见的时刻恒为「无」—— 恒真的读数等于没读。
    # 自证拿它做反向对照：--since=0 必须列出整个 import 图，--since=<未来> 必须为空。
    --since=*) SINCE="${a#--since=}" ;;
    -h|--help) sed -n '2,32p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "未知参数：$a" >&2; exit 2 ;;
  esac
done

# ── 读数：谁在跑 ────────────────────────────────────────────
pid_of() {
  local p
  p="$(launchctl print "$DOMAIN/$LABEL" 2>/dev/null | awk '/^[[:space:]]*pid = /{print $3; exit}')"
  [ -n "${p:-}" ] && [ "$p" != "0" ] && { echo "$p"; return; }
  pgrep -f 'ws_daemon\.mjs' 2>/dev/null | head -1
}

# 读数：**某一类会话**里最后一条消息距今多久（判断重启时机的唯一硬依据）
#
# ★ 2026-09-22 改：原先不分群和私聊，取的是事件日志里最新那一条 —— 实测当天
#   最新一条是**私聊**（`chat_type=p2p`），却被印成「群里最后一条」。那是 §2.4.1
#   那句自检：**这句话比我的输入大**。现在按 `chat_type` 分开报，两条都给人看 ——
#   **重启窗口对群和私聊都生效**，所以不能只报一条。
chat_age() {   # $1 = group | p2p
  # ⚠ ${EVENTS} 的花括号不是风格 —— macOS 自带 bash 3.2 会把紧跟变量的多字节
  #   字符首字节吃进变量名（`$EVENTS）` 被当成变量 EVENTS\xef），报一句
  #   莫名其妙的 unbound variable。凡是变量后面直接跟中文，必须加花括号。
  [ -f "$EVENTS" ] || { echo "未知"; return; }
  python3 - "$EVENTS" "$1" <<'PY' 2>/dev/null || echo "未知"
import json, sys, time
kind = sys.argv[2]
best = None
with open(sys.argv[1], encoding='utf-8', errors='replace') as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            d = json.loads(line)
        except Exception:
            continue
        m = ((d.get('data') or {}).get('message') or {})
        if (m.get('chat_type') or '') != kind:
            continue
        ts = m.get('create_time')          # 毫秒；取的是**原消息时刻**，不是重投时刻
        try:
            ts = int(ts)
        except (TypeError, ValueError):
            continue
        if best is None or ts > best:
            best = ts
if best is None:
    print('未知（这类会话没有带时间的消息）')
else:
    print('%.0f 分钟前' % ((time.time() - best / 1000) / 60))
PY
}

# 读数：哪些**运行时文件**在进程启动之后被改过 —— 即「这次重启会让什么生效」
#
# ⚠ 这里只算 ws_daemon.mjs 真正 import 得到的 .mjs。不 import 的文件重启也
#   不会进新进程，把它们算进来就是「这句话比我的输入大」（§2.4.1 记过这个病：
#   一个 file 被改过 ≠ 它会被重新加载）。上一版就是这么错的 —— 它把闸门脚本
#   自己列成了「重启会生效」。
#
# ⚠ 2026-09-21 补第二段：**被 spawn 的脚本**（`path.join(REPO_ROOT,'tools','x.py')`）。
#   它和 import 的语义**不一样**，所以分行报、不混在一起：
#     脚本每次触发都是新起的进程 → **它自己的改动不用重启就会生效**；
#     但「调用它的那一行」若是新加的（在 import 表里），那它现在**根本没被调用**，
#     得靠这次重启才会开始跑。本轮 `tools/verify_pending.py` 正是这一种 ——
#   上一版只报 import 表，于是这一条在报告里**看不见**。
runtime_changed_since() {   # $1 = 进程启动的 epoch
  python3 - "$ROOT" "$1" <<'PY'
import os, re, sys
root, epoch = sys.argv[1], float(sys.argv[2])
entry = os.path.join(root, 'tools', 'ws_daemon.mjs')
rx = re.compile(r"""from\s+['"](\.[^'"]+)['"]|import\s+['"](\.[^'"]+)['"]""")
seen, stack = set(), [entry]
while stack:
    f = stack.pop()
    if f in seen or not os.path.isfile(f):
        continue
    seen.add(f)
    for m in rx.finditer(open(f, encoding='utf-8', errors='replace').read()):
        nxt = os.path.normpath(os.path.join(os.path.dirname(f), m.group(1) or m.group(2)))
        for cand in (nxt, nxt + '.mjs', os.path.join(nxt, 'index.mjs')):
            if os.path.isfile(cand):
                stack.append(cand)
                break
changed = [os.path.relpath(f, root) for f in seen if os.stat(f).st_mtime > epoch]

# spawn 目标：图内代码按 path.join(REPO_ROOT, 'tools', '…….py') 指到的脚本
#
# ★ 2026-10-06 修口径。原判据是「`path.join(REPO_ROOT, …)` 指到的、盘上存在的文件」，
#   结果它把 **`PMO/logs/lark_writes.jsonl`（一个日志）** 报成了
#   「1 个被调起的脚本在启动后被改过」—— 实测全仓 8 个命中里有 2 个是数据文件
#   （另一个是 `PMO/shouheng-state/seen-messages.json`）。
#   这正是 AGENTS.md §2.4.1 那个病：**接口读通了，但口径读错了，于是安静地产出假数据**，
#   而这条读数恰好是 §2.7 说的「判断时机的唯一硬依据」，读的人会照着它决定要不要重启。
#   修法：**被调起的脚本必须是脚本** —— 只认脚本后缀，数据/日志/状态文件一律不算。
#   执行点：`verify_shouheng_ops.py` 的 **B7**（喂坏样本必须红）。
SPAWN_EXT = ('.py', '.sh', '.mjs', '.js', '.cjs', '.bash')
spawn_rx = re.compile(r"""path\.join\(\s*REPO_ROOT\s*,\s*((?:'[^']*'\s*,\s*)*'[^']*')""")
spawn = set()
for f in seen:
    for m in spawn_rx.finditer(open(f, encoding='utf-8', errors='replace').read()):
        p = os.path.join(root, *re.findall(r"'([^']*)'", m.group(1)))
        if os.path.isfile(p) and p.endswith(SPAWN_EXT):
            spawn.add(p)
spawned = sorted(os.path.relpath(p, root) for p in spawn if os.stat(p).st_mtime > epoch)

# 启动器：**launchd 的 ProgramArguments 直接调起的那一个**（通常是 tools/run_shouheng.sh）。
#
# ★★ 2026-10-23 实测补上：原来这一段只看「图内代码 spawn 的脚本」，
#   于是**改启动器本身**时它报的是
#     「重启会生效  无 —— 启动之后没有任何被 import 的模块或被调起的脚本被改过
#       （那这次重启不带来任何运行时变化，先想清楚为什么还要重启）」
#   而那一轮我改的正是 `tools/run_shouheng.sh`（往里加了 `set -a` 去读端点环境文件）——
#   **它就是 launchd 要执行的那个文件**，重启当然会生效。
#   这条读数是 §2.7 里「判断时机的唯一硬依据」，它说错话的代价是让人放弃一次该做的重启。
#   口径：从 plist 的 ProgramArguments 里取，**不写死文件名**（写死就又是一张常量表）。
#   ⚠ 取 basename 再对回仓库副本：plist 里写的是**绝对路径**，而这台机器的路径大小写
#     与仓库实际目录不一致（`Project` vs `project`），直接 realpath+relpath 会算出
#     `../../Project/…/tools/run_shouheng.sh` 这种读起来没有意义的相对路径。
#     plist 的 WorkingDirectory 就是 `tools/`，所以「同名文件在 tools/ 下」这个对法是稳的。
launch = set()
_plist = os.path.join(root, 'tools', 'com.shouheng.lark.plist')
if os.path.isfile(_plist):
    _src = open(_plist, encoding='utf-8', errors='replace').read()
    _m = re.search(r'<key>ProgramArguments</key>\s*<array>(.*?)</array>', _src, re.S)
    if _m:
        for _s in re.findall(r'<string>(.*?)</string>', _m.group(1)):
            _cand = os.path.join(root, 'tools', os.path.basename(_s))
            if os.path.isfile(_cand) and _cand.endswith(SPAWN_EXT):
                launch.add(_cand)
launched = sorted(os.path.relpath(p, root) for p in launch if os.stat(p).st_mtime > epoch)

print('===IMPORT===')
print('\n'.join(sorted(changed)))
print('===SPAWN===')
print('\n'.join(spawned))
print('===LAUNCH===')
print('\n'.join(launched))
PY
}

PID="$(pid_of)"
echo "── 守衡重启闸门 ──────────────────────────────────────"
if [ -n "${PID:-}" ]; then
  # ★ 2026-09-22 重写：这一块原先读 `ps -o lstart=`，而 ps 在受限环境里被拒
  #   （DSH 沙箱下 `/bin/ps: Operation not permitted`）→ 启动时刻**永远**读不到，
  #   于是下面「重启会生效」整块算不出来。而 §2.7 把那一块称作**判断时机的唯一硬依据**。
  #   **这是选型错误，不是环境限制**：pid 的权威在 launchd（`pid_of` 本来就先问它），
  #   而「什么时候启动的」有两个不需要 ps 的来源，按可信度排序：
  #     ① daemon 自写的 PMO/shouheng-state/daemon-run.json（随 step 1 落地）
  #     ② 重启台账里 `pid_after == 当前 pid` 的那一条
  #   ② 必须核一条**恒等式**：`pid_after` 要等于现在这个 pid。不核它，就会把
  #   「上一次重启的时刻」当成「这个进程的启动时刻」—— launchd 的 KeepAlive
  #   自愈重启**不进台账**，那时这两件事不是一回事。
  #   ps 留作第三顺位：能用就用（它给的 lstart 是原始读数），不能用就不提它。
  START_INFO="$(python3 - "$ROOT" "$PID" <<'PY' 2>/dev/null
import datetime, json, os, sys, time
root, pid = sys.argv[1], sys.argv[2]
def ep(s):
    return int(datetime.datetime.fromisoformat(str(s).replace('Z', '+00:00')).timestamp())
def emit(e, src):
    print('%d|%s|%s' % (e, time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(e)), src))
    raise SystemExit
try:
    d = json.load(open(os.path.join(root, 'PMO/shouheng-state/daemon-run.json'), encoding='utf-8'))
    if str(d.get('pid')) == pid and d.get('startedAt'):
        emit(ep(d['startedAt']), 'run-state.startedAt')
except SystemExit:
    raise
except Exception:
    pass
try:
    ledger = os.path.join(root, 'PMO/logs/restart-ledger.jsonl')
    recs = [json.loads(x) for x in open(ledger, encoding='utf-8') if x.strip()]
    for r in reversed(recs):
        if r.get('ok') and str(r.get('pid_after')) == pid and r.get('at'):
            emit(ep(r['at']), '重启台账最后一条（pid_after 对得上）')
except SystemExit:
    raise
except Exception:
    pass
PY
)"
  START_EPOCH="${START_INFO%%|*}"
  START_HUMAN="$(printf '%s' "${START_INFO}" | cut -d'|' -f2)"
  START_SRC="$(printf '%s' "${START_INFO}" | cut -d'|' -f3)"
  if [ -n "${START_EPOCH:-}" ]; then
    UPTIME_MIN="$(python3 -c 'import sys,time;print(int((time.time()-float(sys.argv[1]))//60))' "${START_EPOCH}" 2>/dev/null)"
    echo "  现在在跑      PID ${PID}，已运行 ${UPTIME_MIN} 分钟"
    echo "  启动于        ${START_HUMAN}（来源：${START_SRC}）"
  else
    START_RAW="$(ps -o lstart= -p "${PID}" 2>/dev/null | xargs)"
    if [ -n "${START_RAW}" ]; then
      START_EPOCH="$(printf '%s' "${START_RAW}" | xargs -I{} date -j -f '%a %b %d %T %Y' '{}' '+%s' 2>/dev/null)"
      echo "  现在在跑      PID ${PID}，已运行 $(ps -o etime= -p "${PID}" 2>/dev/null | tr -d ' ')"
      echo "  启动于        ${START_RAW}（来源：ps lstart）"
    else
      START_EPOCH=""
      echo "  现在在跑      PID ${PID}（进程在，但启动时刻三个来源都读不到 → 运行时长【未测】）"
      echo "  启动于        ⚠ 未测：run-state 未部署、台账里没有 pid_after=${PID} 的记录、ps 也被拒"
    fi
  fi
else
  START_EPOCH=""
  echo "  现在在跑      ✗ 没有在跑"
fi
echo "  最后一条消息  群 $(chat_age group) ｜ 私聊 $(chat_age p2p)"
echo "                （**重启窗口对两者都生效** —— 分不清群和私聊时，这个读数会说一句"
echo "                  比输入大的话：2026-09-22 实测，最新一条是私聊，而当时它被算成了「群里」）"
echo "  重启方式      launchctl kickstart -k $DOMAIN/$LABEL"
echo "                ⚠ 不要用 kill -TERM —— 退出码 0 会让 launchd 认为这是正常停机，不再拉起（见本文件头部实测）"
# 基准时刻：**显式 --since 优先**，否则用进程启动时刻。
# ★ 只要 --since 给了，就**不许**再被「取不到启动时刻」挡住 —— 这个开关存在的全部意义
#   就是让这块读数**可证伪**（§2.7 造它时的原话：`--since=0` 出全图、`--since=未来` 出空）。
#   把它挂在 ps 后面，等于把可证伪性又收了回去：2026-09-22 实测，ps 被拒时
#   B1/B2 两条断言同时变红 —— 而那两条正是设计来证明「这块读数会动」的。
if [ -n "${SINCE:-}" ]; then
  SINCE_USE="${SINCE}"
elif [ -n "${START_EPOCH:-}" ]; then
  SINCE_USE="${START_EPOCH}"
else
  SINCE_USE=""
fi

if [ -z "${SINCE_USE:-}" ]; then
  # 读不到基准 ≠ 没有东西会生效。这两件事在输出里必须长得不一样。
  echo "  重启会生效    ⚠ **未测** —— 读不到进程启动时刻，这块算不出来"
  echo "                （这不等于「没有东西会生效」。要算就显式给基准："
  echo "                  --since=0 出全图；--since=<epoch 秒> 出那之后改过的）"
else
  RAW="$(runtime_changed_since "${SINCE_USE}")"
  CHANGED="$(printf '%s\n' "$RAW" | sed -n '/^===IMPORT===/,/^===SPAWN===/p' | sed '1d;$d')"
  SPAWNED="$(printf '%s\n' "$RAW" | sed -n '/^===SPAWN===/,/^===LAUNCH===/p' | sed '1d;$d')"
  LAUNCHED="$(printf '%s\n' "$RAW" | sed -n '/^===LAUNCH===/,$p' | sed '1d')"
  if [ -n "$CHANGED" ] || [ -n "$SPAWNED" ] || [ -n "$LAUNCHED" ]; then
    if [ -n "$CHANGED" ]; then
      echo "  重启会生效    $(printf '%s\n' "$CHANGED" | wc -l | tr -d ' ') 个被 import 的模块在启动后被改过："
      printf '%s\n' "$CHANGED" | sed 's/^/                  /'
    else
      echo "  重启会生效    没有被 import 的模块在启动后被改过"
    fi
    if [ -n "$LAUNCHED" ]; then
      echo "  另（启动器）  $(printf '%s\n' "$LAUNCHED" | wc -l | tr -d ' ') 个启动器在启动后被改过 ——"
      printf '%s\n' "$LAUNCHED" | sed 's/^/                  /'
      echo "                它是 **launchd 直接执行的那一个**（plist 的 ProgramArguments），重启就会用新的。"
    fi
    if [ -n "$SPAWNED" ]; then
      echo "  另（spawn）   $(printf '%s\n' "$SPAWNED" | wc -l | tr -d ' ') 个被调起的脚本在启动后被改过/新建："
      printf '%s\n' "$SPAWNED" | sed 's/^/                  /'
      echo "                · 脚本每次触发都是新起的进程 —— **它自己的改动不用重启就会生效**"
      echo "                · 但「调用它的那一行」若是新加的（见上面那张表），它现在**根本没被调用**，"
      echo "                  要靠这次重启才会开始跑。逐条看清是哪一种，别整段照读。"
    fi
  else
    echo "  重启会生效    无 —— 启动之后没有任何被 import 的模块、被调起的脚本或启动器被改过"
    echo "                （那这次重启不带来任何运行时变化，先想清楚为什么还要重启）"
  fi
fi

# ── 把这次读数压成一份**一次性凭证** ────────────────────────
# 摘要覆盖「谁在跑 + 拿什么基准算的 + 算出来什么」三样 —— 也就是说：
# **凭证对不上，等价于「世界变了」**，而不是「你抄错了一个数」。
READING="pid=${PID:-none}
since=${SINCE_USE:-none}
changed=${CHANGED:-}
spawned=${SPAWNED:-}
launched=${LAUNCHED:-}"
DIGEST="$(printf '%s' "$READING" | shasum -a 256 | awk '{print $1}')"

# 只有「报告但不执行」那一次才写凭证。`--check` 是纯查看，不许留下任何东西
# （§2.4.4：写进自证表的命令，都要能回答「它跑完之后盘上有什么变了？」）。
# 已带 --yes 的那次也**不重写** —— 否则它就把自己要校验的那份凭证换掉了。
if [ "$YES" = "0" ] && [ "$CHECK" = "0" ]; then
  mkdir -p "$(dirname "$CONSENT")"
  {
    echo "at=$(date +%s)"
    echo "pid=${PID:-none}"
    echo "digest=$DIGEST"
  } > "$CONSENT"
  echo "──────────────────────────────────────────────────────"
  echo "  ⏳ 本次读数已写成凭证（$((CONSENT_MAX_AGE / 60)) 分钟内有效）："
  echo "     $CONSENT"
  echo "     要执行就现在执行：bash tools/restart_shouheng.sh --yes --why=\"<理由>\""
  echo "     ★ 过了这个时间、或这中间别人重启过，它会拒 —— 那就**重新读一遍**再决定，"
  echo "       不要绕过它。读数会过期这件事，本文件头上记着一次真事故。"
fi

# ── 没在跑：这不是重启，是救活 ──────────────────────────────
if [ -z "${PID:-}" ]; then
  echo "──────────────────────────────────────────────────────"
  echo "  它现在根本没在跑 —— 这是**救活**，不是重启。"
  echo "  失联每多一秒都是净损失，所以救活不必等人同意；但要留痕。"
  if [ "$CHECK" = "1" ] && [ "$YES" = "0" ]; then echo "  （--check：以上为查看，未做任何动作）"; exit 0; fi
  if [ "$YES" = "0" ]; then echo "  确认救活：加 --yes"; exit "$EXIT_REFUSED"; fi
  MODE="rescue"
else
  # ── 在跑：这是重启，默认拒绝 ──────────────────────────────
  # ── 正在处理中？（真事故 2026-10-17 的判据）────────────────────────────
  #   `daemon-run.json` 的计数：收到的事件数 **大于**（已回答＋已跳过＋失败＋未捕获）
  #   ⇒ 至少有一条**还没走完** —— 此刻 kickstart 就是把它掐断。
  #   为什么这个式子可靠：正常跑完时两边相等；重复消息记 `skipped`、异常记 `failed/uncaught`，
  #   都不会让它长期为真（重启后计数器归零，不会留下陈旧状态）。
  INFLIGHT="$(python3 - "$ROOT" <<'PY' 2>/dev/null
import json, os, sys
root = sys.argv[1]
try:
    d = json.load(open(os.path.join(root, 'PMO/shouheng-state/daemon-run.json'), encoding='utf-8'))
except Exception:
    print('untested|0|0'); raise SystemExit
ev = int(d.get('events') or 0)
done = sum(int(d.get(k) or 0) for k in ('handled', 'skipped', 'failed', 'uncaught'))
print(('inflight|%d|%d' if ev > done else 'idle|%d|%d') % (ev, done))
PY
)"
  _ist="${INFLIGHT%%|*}"; _rest="${INFLIGHT#*|}"
  _ev="${_rest%%|*}"; _done="${_rest#*|}"
  case "$_ist" in
    inflight) echo "  正在处理中    ⚠ **有 1 条及以上还没走完**（收到 ${_ev} ／ 走完 ${_done}）—— 现在重启会把它掐断" ;;
    idle)     echo "  正在处理中    无（收到 ${_ev} ／ 走完 ${_done}）" ;;
    *)        echo "  正在处理中    ⚠ 未测（读不到 run-state 的计数）" ;;
  esac
  # ── 审查链在飞？────────────────────────────────────────────────────────
  # ★★ 2026-10-26 真事故（那天我自己踩的，两张图永远没等到结论）：
  #   守衡对一条送审先回执卡、**再由链异步产出结论**。而上面那条判据数的是
  #   `daemon-run.json` 里「消息有没有走完」—— 回执已发、链还在跑时它可能是平衡的，
  #   于是闸门在 14:43:34 与 14:55:15 两次**放行**，两次都掐断了正在跑的链；
  #   两个实例退出时逐字都是 `本次统计：事件 1 / 已回答 0 / 已发送 0`，
  #   群里那两张图**只有回执、永远没有结论**（链目录留在 /tmp/shouheng-chain-img-*，
  #   里面只有图、没有结果）。用户看到的就是「守衡怎么不回复了」。
  # ⇒ 判据必须覆盖**链**，不能只覆盖消息。两个来源取「或」：
  #   ① 落盘读数 `PMO/shouheng-state/chains-in-flight.json` —— 正解，但它是守护进程
  #      新写的字段 ⇒ **要等下一次重启才生效**（本次先把产者加上，见 tools.mjs::spawnChain）；
  #   ② 进程探针 `kb/l8/review_run.sh` —— 链自己会跑这条脚本、argv 里带 RUN 名
  #      ⇒ 今天立刻就能拦。**探针只是补丁**，别把它当长期真源（链在起脚本之前/之后
  #      仍有一小段没被盖住，① 才是权威读数）。
  CHAIN_N=0
  CHAIN_SRC=""
  CHAINF="$ROOT/PMO/shouheng-state/chains-in-flight.json"
  if [ -f "$CHAINF" ]; then
    CN="$(python3 - "$CHAINF" <<'PY' 2>/dev/null
import json, sys, time
try:
    d = json.load(open(sys.argv[1], encoding='utf-8'))
except Exception:
    print(''); raise SystemExit
n = int(d.get('n') or 0)
at = str(d.get('at') or '')
try:
    import datetime
    t = datetime.datetime.fromisoformat(at.replace('Z', '+00:00')).timestamp()
    fresh = (time.time() - t) < 600
except Exception:
    fresh = False
print(n if (n > 0 and fresh) else '')
PY
)"
    if [ -n "${CN:-}" ]; then CHAIN_N="$CN"; CHAIN_SRC="落盘读数"; fi
  fi
  CHAIN_PID="$(pgrep -f 'kb/l8/review_run\.sh' 2>/dev/null | head -1)"
  if [ -z "$CHAIN_SRC" ] && [ -n "${CHAIN_PID:-}" ]; then
    CHAIN_N=1; CHAIN_SRC="进程探针（pid ${CHAIN_PID}）"
  fi
  if [ "$CHAIN_N" != "0" ]; then
    echo "  审查链在飞    ⚠ **${CHAIN_N} 条链还没出结论**（${CHAIN_SRC}）—— 现在重启 ⇒ 回执已发、结论永远不来"
  else
    echo "  审查链在飞    无（落盘读数与进程探针都是 0）"
  fi
  echo "──────────────────────────────────────────────────────"
  if [ "$CHECK" = "1" ] && [ "$YES" = "0" ]; then echo "  （--check：以上为查看，未做任何动作）"; exit 0; fi
  if [ "$YES" = "0" ]; then
    echo "  ✗ 拒绝重启：守衡正在对外说话，重启窗口内群里的消息不会被回答。"
    echo "    同意之后再执行：bash tools/restart_shouheng.sh --yes --why=\"<重启的理由>\""
    exit "$EXIT_REFUSED"
  fi
  if [ "$_ist" = "inflight" ] && [ "$FORCE_INFLIGHT" != "1" ]; then
    echo "  ✗ 拒绝重启：**有一条消息正在处理中**（收到 ${_ev} ／ 走完 ${_done}）。"
    echo "    现在 kickstart，它已经发出去的回执就再也等不到答案了 ——"
    echo "    2026-10-17 14:22 真发生过：'本次统计：事件 2 / 已回答 0 / 已发送 0'。"
    echo "    等它回完再重启；确需硬重启就加 --force-inflight。"
    exit "$EXIT_REFUSED"
  fi
  # ★★ 2026-10-26：**链在飞**与「消息在处理中」同罪 —— 今天两张图就是这么丢的。
  if [ "$CHAIN_N" != "0" ] && [ "$FORCE_INFLIGHT" != "1" ]; then
    echo "  ✗ 拒绝重启：**有 ${CHAIN_N} 条审查链还没出结论**（${CHAIN_SRC}）。"
    echo "    链是被 kickstart 掐断的那个 —— 掐了它，回执卡还在群里、结论永远不会来，"
    echo "    而守衡**不会**自动重试。2026-10-26 实测：两次重启各掐断一条，"
    echo "    两个实例退出时逐字都是 `本次统计：事件 1 / 已回答 0 / 已发送 0`。"
    echo "    等结论发出来再重启；确需硬重启就加 --force-inflight（那两单要重发）。"
    exit "$EXIT_REFUSED"
  fi
  if [ -z "$WHY" ]; then
    echo "  ✗ 拒绝重启：--yes 必须配 --why=\"<理由>\" —— 重启要留痕，理由就是痕迹。"
    exit "$EXIT_REFUSED"
  fi
  # ★ 凭证校验：**同意必须在同一次读数里给出**。三条各拦一种「世界变了」：
  #   缺凭证（没先读就执行）／凭证过期（读了很久才动手）／PID 对不上（中间别人重启过）。
  #   第三条是 2026-09-22 那次事故的**直接判据** —— 它不需要任何时间假设，
  #   只问一句「我同意的那个进程，还是现在这个吗？」
  if [ ! -f "$CONSENT" ]; then
    echo "  ✗ 拒绝重启：**没有凭证** —— 这一轮没有先跑过不带 --yes 的那条。"
    echo "    先读一遍：bash tools/restart_shouheng.sh"
    echo "    然后再执行（读完到执行之间别隔太久）。"
    exit "$EXIT_REFUSED"
  fi
  C_AT="$(sed -n 's/^at=//p' "$CONSENT")"
  C_PID="$(sed -n 's/^pid=//p' "$CONSENT")"
  C_DIGEST="$(sed -n 's/^digest=//p' "$CONSENT")"
  NOW_EPOCH="$(date +%s)"
  if [ -z "${C_AT:-}" ] || [ $((NOW_EPOCH - C_AT)) -gt "$CONSENT_MAX_AGE" ]; then
    echo "  ✗ 拒绝重启：**凭证已过期**（取于 ${C_AT:-未知}，上限 ${CONSENT_MAX_AGE} 秒）。"
    echo "    读数是有保质期的 —— 过期了就得**重新读一遍**，不是把旧读数再念一遍。"
    rm -f "$CONSENT" || true
    exit "$EXIT_REFUSED"
  fi
  if [ "${C_PID:-none}" != "${PID:-none}" ]; then
    echo "  ✗ 拒绝重启：**PID 对不上** —— 你同意的是 PID ${C_PID}，现在在跑的是 PID ${PID:-none}。"
    echo "    这中间有一次**别人的重启**：那些改动已经生效了，你手上这份读数已经过期。"
    echo "    重新读一遍再决定：bash tools/restart_shouheng.sh"
    rm -f "$CONSENT" || true
    exit "$EXIT_REFUSED"
  fi
  if [ "${C_DIGEST:-}" != "$DIGEST" ]; then
    echo "  ✗ 拒绝重启：**读数对不上** —— 凭证里的摘要与你这次算出来的不一致。"
    echo "    （同一台机器、同一个 PID，但「重启会生效」那份清单变了：文件在两次之间被改过。）"
    echo "    重新读一遍再决定：bash tools/restart_shouheng.sh"
    rm -f "$CONSENT" || true
    exit "$EXIT_REFUSED"
  fi
  echo "  ✓ 凭证有效  （取于 $((NOW_EPOCH - C_AT)) 秒前，PID ${C_PID} 未变，摘要一致）"
  if [ "$NO_KICK" = "1" ]; then
    echo "  （--no-kick：以上校验全过，但**没有执行 kickstart** —— 进程一个字节没动，凭证也没消耗）"
    exit 0
  fi
  MODE="restart"
fi

# ── 执行 ───────────────────────────────────────────────────
PID_BEFORE="${PID:-none}"
echo "  执行          launchctl kickstart -k $DOMAIN/$LABEL  [$MODE]"
# 凭证**一次性**：执行前就作废。放在 kickstart 之后作废的话，kickstart 失败时
# 凭证还留着，下一次 --yes 会拿一份「已经用过的同意」再试一遍 —— 那不叫同意。
rm -f "$CONSENT" || true
launchctl kickstart -k "$DOMAIN/$LABEL" || { echo "  ✗ kickstart 失败（退出码 ${?}）—— 它可能现在没在跑，或 label 不对"; exit 1; }

# 等它起来（最多 20 秒），并**证明它真的回来了** —— 只 kickstart 不验证，
# 等于把「重启完了」当成「重启好了」。
PID_AFTER=""
for _ in $(seq 1 20); do
  sleep 1
  PID_AFTER="$(pid_of)"
  [ -n "${PID_AFTER:-}" ] && [ "$PID_AFTER" != "$PID_BEFORE" ] && break
  PID_AFTER=""
done

echo "──────────────────────────────────────────────────────"
if [ -z "${PID_AFTER:-}" ]; then
  echo "  ✗ 20 秒内没看到新进程 —— 现在很可能**没人在群里答话**。"
  echo "    先看 $DAEMON_LOG 的尾部，再决定下一步。"
  RC=1
else
  echo "  ✓ 已回来      PID $PID_BEFORE → $PID_AFTER"
  BOOT="$(grep -c '长连接已启动' "$DAEMON_LOG" 2>/dev/null)"
  echo "    启动横幅在日志里出现过 $BOOT 次（每重启一次 +1，可据此核对真的是新进程）"
  RC=0
fi

# 留痕：用 shell 追加（本项目实测 —— Python 写出的文件会被 +4096 填充成 read 工具打不开，
# 账本是要给人读的，所以必须走「不会填充」的写出方式）
printf '{"at":"%s","mode":"%s","pid_before":"%s","pid_after":"%s","why":"%s","ok":%s}\n' \
  "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$MODE" "$PID_BEFORE" "${PID_AFTER:-none}" \
  "$(printf '%s' "$WHY" | tr -d '"\\')" "$([ "$RC" = 0 ] && echo true || echo false)" >> "$LEDGER"
echo "  已留痕        PMO/logs/restart-ledger.jsonl"
exit "$RC"

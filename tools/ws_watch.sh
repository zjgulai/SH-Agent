#!/usr/bin/env bash
# ws_watch.sh —— 实时盯守衡长连接事件
#
# 用法：
#   ./ws_watch.sh              # 实时跟随事件流（Ctrl-C 退出）
#   ./ws_watch.sh --start      # 确保守护进程在跑，然后跟随
#   ./ws_watch.sh --status     # 只看状态不跟随
#
# 设计说明：
#   日志路径由脚本自身位置推导（$(dirname $0)），不依赖调用时的 cwd ——
#   早期版本硬编码相对路径 ../PMO/logs/，换个目录调用就找不到日志。
#   守护进程用双重 fork 脱离（macOS 无 setsid），PPID 应为 1 才算真常驻。

set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
LOG="$HERE/../PMO/logs/ws_daemon.log"
DAEMON="$HERE/ws_daemon.mjs"

proc_pid() { pgrep -f "node ws_daemon.mjs" | tail -1; }

start_daemon() {
  if [ -n "$(proc_pid)" ]; then return 0; fi
  echo "⚠ 守护进程未运行，正在拉起…"
  mkdir -p "$(dirname "$LOG")"
  python3 - "$DAEMON" "$LOG" <<'PY'
import os, sys
daemon, log = sys.argv[1], sys.argv[2]
if os.fork() > 0: os._exit(0)          # 父进程退出
os.setsid()                             # 成为会话首领
if os.fork() > 0: os._exit(0)          # 第一子退出，第二子被 launchd 收养
f = open(log, "a")
os.dup2(f.fileno(), 1); os.dup2(f.fileno(), 2)
os.dup2(open(os.devnull).fileno(), 0)
os.execvp("node", ["node", daemon])
PY
  sleep 6
}

status() {
  local pid; pid="$(proc_pid)"
  if [ -z "$pid" ]; then echo "✗ 守护进程：未运行"; return 1; fi
  local pp; pp="$(ps -o ppid= -p "$pid" | tr -d ' ')"
  echo "✓ 守护进程 PID=$pid  PPID=$pp  $([ "$pp" = "1" ] && echo '(已脱离,常驻)' || echo '(未脱离!)')"
  echo "  运行时长: $(ps -o etime= -p "$pid" | tr -d ' ')"
  lsof -nP -p "$pid" 2>/dev/null | awk '/TCP/ {print "  长连接:   "$9}'
  echo "  已收事件: $(grep -c '★' "$LOG" 2>/dev/null || true) 条"
}

case "${1:-}" in
  --status) status ;;
  *)        start_daemon; status
            echo "=== 实时事件流（Ctrl-C 退出）==="
            tail -f "$LOG" | grep --line-buffered -E "★|✓ 已回复|✗|reconnect|error" ;;
esac

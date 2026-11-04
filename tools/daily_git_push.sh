#!/usr/bin/env bash
# tools/daily_git_push.sh —— 日更收尾：把当天的改动**提交 + 推送**到 GitHub（尺子门 + 读回校验 + 留痕）
#
# 为什么有它（Owner 2026-10-14：「在日更中设置定时任务一起推到 git」）：
#   实测：本机 90 笔提交躺了三周，远端只有建仓时那个空 README（main = 7bf2c61）。
#   「每天的操作进 GitHub」这件事**在体系里从来没接线**；本脚本就是那条线。
#
# 五条口径（每条都是踩出来的）：
#   ① **只在日更收尾跑** —— 跑到一半的中间态不许进历史（2026-10-13 实测：日更到 L5 时闸门是红的）。
#   ② **落盘前先跑尺子** —— `--ruler=<命令>`；红了 ⇒ **不提交**、留痕、退出码 3。
#   ③ **推完必须读回** —— 远端 HEAD == 本地 HEAD 才算成（本库纪律：接口成功 ≠ 数据落下来）。
#   ④ **尺子的 cwd 不许泄漏**（2026-10-15 加）—— 尺子串**由调用方传、常自带 `cd`**
#      （日更传的是 `cd '<知识库工作区>' && python3 kb/l8/workflow_smoke.py`）。原先 `eval` 在
#      **当前 shell** 执行 ⇒ cwd 被换走 ⇒ `git add -A` 落到**别的目录**上 ⇒ **当天代码没进 git**
#      （2026-10-15 03:30 那轮实测：rc=4 / add-failed / `fatal: not a git repository`）。
#      现在：尺子跑在**子 shell** 里 ＋ add 之前**硬核 cwd 仍是本仓根**（不符 ⇒ 不提交、必喊、rc=4）。
#   ⑤ **失败必喊**（2026-10-15 补齐）—— 原先只有「尺子红 / 远端领先 / push 失败 / 读回不一致」四路
#      会推飞书；`not-a-repo / add-failed / commit-failed / cwd-lost` 只写日志与台账 ⇒
#      2026-10-15 那次失败**没人被告知**。现在四路全补上。
#
# 不许做的事：
#   · 不 `push --force`；远端领先（别人推过）⇒ **停下留痕**交人处理（fail-closed）。
#   · 干净就不造空提交。 · 只调 git，不打印任何密钥（密钥在 ~/.ssh）。
#   · **自测绝不许打到生产群** —— 2026-10-15 实测踩过：`--selftest` 的 ③④ 两路**真发了飞书**
#     （既然 notify 在自测里被调到，就真的会发）。现在 selftest 里挂 `KB_ALERT_FORCE_SEND=1`
#     （本脚本已有的自证钩子），notify **只记不真发**，并由自测 ⑩ 钉住。
#
# 用法：
#   bash tools/daily_git_push.sh --why="daily-20261014-0330 收尾" [--repo <path>] [--ruler <cmd>] [--dry-run]
#   bash tools/daily_git_push.sh --selftest
#
# 退出码：0 = 已推送或干净无改动 ｜ 3 = 有改动但被尺子拦住（没提交）｜ 4 = 提交/推送/读回失败（含远端领先、cwd 跑丢）｜ 2 = 用法或环境错
set -uo pipefail

REPO="/Users/lute/Project/audit_multi_content"
PUSH_POLICY_TOOL="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/push_policy.py"
LARK="${LARK_CLI:-$HOME/.dsh/bin/lark-cli}"
# 周更收尾告警同样只许发测试群；不指定时由共享策略给默认地址。
ALERT_CHAT="${DAILY_GIT_PUSH_CHAT-}"
ALERT=1
WHY=""; RULER=""; DRY=0; SELFTEST=0; LEDGER=""

while [ $# -gt 0 ]; do
  case "$1" in
    --repo=*)   REPO="${1#--repo=}" ;;
    --repo)     shift; REPO="${1:-}" ;;
    --why=*)    WHY="${1#--why=}" ;;
    --why)      shift; WHY="${1:-}" ;;
    --ruler=*)  RULER="${1#--ruler=}" ;;
    --ruler)    shift; RULER="${1:-}" ;;
    --dry-run)  DRY=1 ;;
    --no-alert) ALERT=0 ;;
    --selftest) SELFTEST=1 ;;
    # 帮助**不写行号范围**：表头以后加一行就会错位（本库栽过"手抄清单"这类事）。
    -h|--help)  awk 'NR>1 && /^#/ { sub(/^# ?/,""); print; next } NR>1 { exit }' "$0"; exit 2 ;;
    *) echo "未知参数: $1"; exit 2 ;;
  esac
  shift
done

log() { printf '[daily-git-push %s] %s\n' "$(date '+%H:%M:%S')" "$*"; }

ledger() {   # $1=repo $2=verdict $3=detail
  [ -n "$LEDGER" ] || return 0
  mkdir -p "$(dirname "$LEDGER")" 2>/dev/null || return 0
  printf '{"at":"%s","repo":"%s","verdict":"%s","detail":"%s","why":"%s"}\n' \
    "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$1" "$2" "$3" "${WHY//\"/\'}" >> "$LEDGER" 2>/dev/null || true
}

notify() {   # $1=正文 —— 只在「拦截 / 失败」时调用；发不出去也不影响退出码
  local target policy_result policy_rc
  [ "$ALERT" = "1" ] || { log "（--no-alert：未推飞书）"; return 0; }
  if [ -n "$ALERT_CHAT" ]; then
    policy_result="$(python3 "$PUSH_POLICY_TOOL" --chat "$ALERT_CHAT" 2>&1)"; policy_rc=$?
  else
    policy_result="$(python3 "$PUSH_POLICY_TOOL" 2>&1)"; policy_rc=$?
  fi
  if [ "$policy_rc" != 0 ]; then
    log "⛔ 拒绝发送收尾告警：${policy_result}"
    ledger "$REPO" blocked alert-target-denied
    return 0
  fi
  target="$policy_result"
  if [ ! -x "$LARK" ]; then log "⚠️ 找不到 lark-cli ⇒ 告警没发出去（已进日志与台账）"; return 0; fi
  if [ "${KB_ALERT_FORCE_SEND:-0}" = "1" ]; then log "[自证] 未真发；正文长度 ${#1}"; return 0; fi
  if PATH="$HOME/.dsh/bin:$PATH" "$LARK" im +messages-send --as bot --profile dsh-kb \
       --chat-id "$target" --text "$1" >/tmp/daily_git_push.alert.log 2>&1; then
    log "  📣 已推飞书告警"
  else
    log "  ⚠️ 告警发送失败（已进日志与台账）：$(tail -1 /tmp/daily_git_push.alert.log | cut -c1-160)"
  fi
}

push_one() {   # $1=repo ⇒ 0/3/4
  local repo="$1" br head remote_head n repo_top ruler_rc cwd_top cwd_prefix cwd_now
  [ -d "$repo/.git" ] || {
    log "⛔ 不是 git 仓：$repo"; ledger "$repo" error not-a-repo
    notify "❌ 日更收尾 git：**不是 git 仓 ⇒ 未提交** ｜ 仓 ${repo} ｜ 台账 PMO/logs/daily-git-push.ndjson"; return 2; }
  cd "$repo" || return 2
  repo_top="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  br="$(git rev-parse --abbrev-ref HEAD)"
  if [ -z "$(git status --porcelain)" ]; then
    log "· $(basename "$repo")：无改动 ⇒ 跳过（不造空提交）"; ledger "$repo" clean no-changes; return 0
  fi
  n="$(git status --porcelain | wc -l | tr -d ' ')"
  log "· $(basename "$repo")：$n 条改动（分支 ${br}）"
  if [ -n "$RULER" ]; then
    log "  跑尺子：$RULER"
    # ★ 2026-10-15：尺子串**由调用方传、常自带 `cd`**（日更传的是 `cd '<知识库工作区>' && python3 …`）。
    #   原先 eval 在**当前 shell** 执行 ⇒ cwd 被换走 ⇒ 下面 `git add -A` 落到别的目录
    #   （2026-10-15 04:18 实测：add-failed、当天代码没进 git）。现在尺子跑在**子 shell** 里。
    #   KB_GIT_PUSH_SELFTEST_LEAK_CWD=1 = env-only 自证闸门（把泄漏注入回来，证明下面那道 cwd 硬核
    #   不是恒真；launchd 不会设它 —— 与 KB_ALERT_FORCE_SEND / KB_FRESHNESS_FORCE_STALE 同一套路）。
    if [ "${KB_GIT_PUSH_SELFTEST_LEAK_CWD:-0}" = "1" ]; then
      eval "$RULER" >/tmp/daily_git_push.ruler.log 2>&1; ruler_rc=$?
    else
      ( eval "$RULER" ) >/tmp/daily_git_push.ruler.log 2>&1; ruler_rc=$?
    fi
    if [ "$ruler_rc" != 0 ]; then
      log "  ⛔ 尺子红了 ⇒ **不提交** ｜ $(tail -2 /tmp/daily_git_push.ruler.log | tr '\n' ' ' | cut -c1-180)"
      ledger "$repo" blocked ruler-red; notify "⚠️ 日更收尾 git：**尺子红 ⇒ 未提交** ｜ 仓 ${repo} ｜ 尺子 ${RULER} ｜ 待提交 ${n} 条 ｜ 台账 PMO/logs/daily-git-push.ndjson"; return 3
    fi
    log "  ✅ 尺子过"
  fi
  # ★ cwd 硬核（2026-10-15）：add 之前**必须**还站在本仓根上。
  #   尺子若以任何方式换走了 cwd，这里当场拦下 —— **绝不"在别的目录上 add/commit/push"**。
  #   两条都查：① 现在这棵树还是不是本仓（换到别的仓/非仓 ⇒ 不等）
  #             ② 是不是本仓**根**（进了子目录也要拦：否则 `git add -A` 只加子目录那一块）
  #   ★ 判据**只许 git 比 git**：`pwd -P` 在 macOS 上会**照抄你 cd 时输入的大小写**，而 git 报的是另一种
  #     写法 —— `/Users/lute/Project` 与 `/Users/lute/project` 本来就是**同一个目录**（APFS 大小写不敏感）
  #     ⇒ 拿 pwd -P 去比 git 的 toplevel，**同一个仓也会被判"跑丢"**（第一版就这么假红过：桩测试全绿、
  #     真仓库一跑正例当场红）。自测 ⑪ 钉住这条：两种大小写写法都必须放行。
  cwd_top="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  cwd_prefix="$(git rev-parse --show-prefix 2>/dev/null || true)"
  cwd_now="$(pwd -P)"   # ← **只作展示**，绝不参与判据（它会照抄 cd 时输入的大小写，见上）
  if [ "$cwd_top" != "$repo_top" ] || [ -n "$cwd_prefix" ]; then
    log "  ⛔ cwd 跑丢（在 ${cwd_now}，应在 ${repo_top}）⇒ **拒绝 add/commit/push**"
    ledger "$repo" error cwd-lost
    notify "❌ 日更收尾 git：**cwd 跑丢 ⇒ 未提交**（工作目录被换到 ${cwd_now}）｜ 仓 ${repo} ｜ 待提交 ${n} 条 ｜ 台账 PMO/logs/daily-git-push.ndjson"
    return 4
  fi
  if [ "$DRY" = "1" ]; then
    log "  ⏭ --dry-run：不 add / 不 commit / 不 push"; ledger "$repo" dryrun "$n-dirty"; return 0
  fi
  if ! git add -A >/tmp/daily_git_push.add.log 2>&1; then
    log "  ⛔ git add 失败：$(tail -2 /tmp/daily_git_push.add.log | tr '\n' ' ' | cut -c1-200)"
    ledger "$repo" error add-failed
    notify "❌ 日更收尾 git：**git add 失败 ⇒ 未提交** ｜ 仓 ${repo} ｜ 待提交 ${n} 条 ｜ 末行：$(tail -1 /tmp/daily_git_push.add.log | cut -c1-140)"
    return 4
  fi
  if ! git commit -q -m "日更收尾自动提交：${WHY:-routine}（$n 个文件）" >/tmp/daily_git_push.commit.log 2>&1; then
    log "  ⛔ git commit 失败：$(tail -2 /tmp/daily_git_push.commit.log | tr '\n' ' ' | cut -c1-200)"
    ledger "$repo" error commit-failed
    notify "❌ 日更收尾 git：**git commit 失败 ⇒ 未推送** ｜ 仓 ${repo} ｜ 末行：$(tail -1 /tmp/daily_git_push.commit.log | cut -c1-140)"
    return 4
  fi
  head="$(git rev-parse HEAD)"; log "  已提交 ${head:0:9}"
  if ! git push origin "$br" >/tmp/daily_git_push.push.log 2>&1; then
    if grep -qE "non-fast-forward|fetch first|\[rejected\]" /tmp/daily_git_push.push.log; then
      log "  ⛔ 远端领先（别人推过）⇒ **不 force**，停下交人处理"; ledger "$repo" blocked remote-ahead; notify "⚠️ 日更收尾 git：**远端领先 ⇒ 未推送、未 force** ｜ 仓 ${repo} ｜ 需人处理（先 git pull --rebase 再重试）；**机器不许 force**"; return 4
    fi
    log "  ⛔ push 失败：$(tail -2 /tmp/daily_git_push.push.log | tr '\n' ' ' | cut -c1-200)"; notify "❌ 日更收尾 git：**push 失败**（rc=4）｜ 仓 ${repo} ｜ 末行：$(tail -1 /tmp/daily_git_push.push.log | cut -c1-140)"
    ledger "$repo" error push-failed; return 4
  fi
  remote_head="$(git ls-remote origin "refs/heads/$br" 2>/dev/null | awk '{print $1}')"
  if [ "$head" = "$remote_head" ]; then
    log "  ✅ 已推送并读回一致：${head:0:9}"; ledger "$repo" pushed "$head"; return 0
  fi
  log "  ⛔ 读回不一致（本地 ${head:0:9} ≠ 远端 ${remote_head:0:9}）"; ledger "$repo" error readback-mismatch; notify "❌ 日更收尾 git：**推送后读回不一致**（本地 ${head:0:9} ≠ 远端 ${remote_head:0:9}）⇒ 不算推成功"; return 4
}

selftest() {
  local P=0 F=0 tmp remote work rc before after
  local lh rh other other2 out3 out8 o2_before o2_after lc n_att remote2 cr
  chk() { if [ "$2" = "1" ]; then P=$((P+1)); printf '  ✅ %s\n' "$1"; else F=$((F+1)); printf '  ❌ %s ｜ %s\n' "$1" "$3"; fi; }
  # ★ 2026-10-15：**自测绝不许打到生产群**。下面 ③（尺子红）与 ⑧（cwd 跑丢）都会调到 notify，
  #   而 notify 默认**真发** —— 2026-10-15 实测：跑一次 `--selftest` 真发出去了一条。
  #   自证钩子只记不真发，⑩ 钉住它没被拿掉。
  export KB_ALERT_FORCE_SEND=1
  tmp="$(mktemp -d)"; remote="$tmp/remote.git"; work="$tmp/work"
  git init -q --bare "$remote" || { echo "裸远端建不起来"; return 1; }
  git init -q -b main "$work"; cd "$work" || return 1
  git config user.email user@example.com; git config user.name tester
  printf 'a\n' > a.txt; git add -A; git commit -qm init
  git remote add origin "$remote"; git push -q origin main
  LEDGER="$tmp/ledger.ndjson"; WHY="selftest"; REPO="$work"

  # ① 干净 ⇒ 跳过、不造空提交
  before="$(git rev-list --count HEAD)"; push_one "$work" >/dev/null 2>&1; rc=$?; after="$(git rev-list --count HEAD)"
  chk "① 干净仓 ⇒ rc=0 且**不造空提交**（提交数不变）" "$([ "$rc" = 0 ] && [ "$before" = "$after" ] && echo 1 || echo 0)" "rc=$rc ${before}→$after"

  # ② 脏 ⇒ 提交 + 推送 + 读回一致
  printf 'b\n' > b.txt; git add -A
  push_one "$work" >/dev/null 2>&1; rc=$?
  lh="$(git rev-parse HEAD)"; rh="$(git ls-remote origin refs/heads/main | awk '{print $1}')"
  chk "② 有改动 ⇒ rc=0 且远端 HEAD == 本地 HEAD（真推上去）" "$([ "$rc" = 0 ] && [ "$lh" = "$rh" ] && echo 1 || echo 0)" "rc=$rc $lh vs $rh"

  # ③ 尺子红 ⇒ **不提交**
  printf 'c\n' > c.txt; before="$(git rev-list --count HEAD)"
  RULER="false"; out3="$(push_one "$work" 2>&1)"; rc=$?; RULER=""; after="$(git rev-list --count HEAD)"
  chk "③ 尺子红 ⇒ rc=3 且**没有新提交**（不把坏状态钉进历史）" "$([ "$rc" = 3 ] && [ "$before" = "$after" ] && echo 1 || echo 0)" "rc=$rc ${before}→$after"

  # ④ 远端领先 ⇒ 不 force、退出 4、远端不动
  printf 'd\n' > d.txt   # ← 故意**不提交**：要测的是「提交后 push 被拒」这一步
  other="$tmp/other"; git clone -q "$remote" "$other" 2>/dev/null
  ( cd "$other" && git config user.email user@example.com && git config user.name other && printf 'x\n' > x.txt && git add -A && git commit -qm other-push && git push -q origin main )
  local rh_before rh_after; rh_before="$(git ls-remote origin refs/heads/main | awk '{print $1}')"
  push_one "$work" >/dev/null 2>&1; rc=$?; rh_after="$(git ls-remote origin refs/heads/main | awk '{print $1}')"
  chk "④ 远端领先 ⇒ rc=4、**不 force**（远端仍是别人的提交）" "$([ "$rc" = 4 ] && [ "$rh_before" = "$rh_after" ] && echo 1 || echo 0)" "rc=$rc"

  # ⑤ --dry-run ⇒ 什么都不动
  printf 'e\n' > e.txt; before="$(git rev-list --count HEAD)"
  DRY=1 push_one "$work" >/dev/null 2>&1; rc=$?; after="$(git rev-list --count HEAD)"; DRY=0
  chk "⑤ --dry-run ⇒ rc=0 且提交数不变" "$([ "$rc" = 0 ] && [ "$before" = "$after" ] && echo 1 || echo 0)" "rc=$rc ${before}→$after"

  # ⑥ 留痕：台账里有 pushed 与 blocked 两类
  local lp lb; lp="$(grep -c '"verdict":"pushed"' "$LEDGER" 2>/dev/null || echo 0)"; lb="$(grep -c '"verdict":"blocked"' "$LEDGER" 2>/dev/null || echo 0)"
  chk "⑥ 留痕：台账同时记下 pushed 与 blocked（不只记成功）" "$([ "$lp" -ge 1 ] && [ "$lb" -ge 1 ] && echo 1 || echo 0)" "pushed=$lp blocked=$lb"

  # ★ ⑦⑧ 的前置：④ 之后本仓**领先远端**（d.txt 那个提交被拒了）⇒ 不推平的话，
  #   ⑦ 测到的会是「远端领先」而不是「尺子自带 cd」（第一版 ⑦ 就栽在这上面：rc=4 是 ④ 的余波）。
  git pull -q --rebase origin main >/dev/null 2>&1; git push -q origin main >/dev/null 2>&1

  # ⑦ ★ 尺子自带 cd（= 日更的**真实调用姿势**）⇒ 仍必须提交并推送成功，且不在别处落提交
  other2="$tmp/other2"; git init -q -b main "$other2"
  ( cd "$other2" && git config user.email user@example.com && git config user.name o2 && printf 'z\n' > z.txt && git add -A && git commit -qm o2init )
  o2_before="$(git -C "$other2" rev-parse HEAD)"
  printf 'f\n' > f.txt; before="$(git rev-list --count HEAD)"
  RULER="cd '$other2' && true"
  push_one "$work" >/dev/null 2>&1; rc=$?; RULER=""
  after="$(git rev-list --count HEAD)"; o2_after="$(git -C "$other2" rev-parse HEAD)"
  lh="$(git rev-parse HEAD)"; rh="$(git ls-remote origin refs/heads/main | awk '{print $1}')"
  chk "⑦ 尺子自带 cd ⇒ rc=0、真推上去、且**没在别处落提交**" \
      "$([ "$rc" = 0 ] && [ "$lh" = "$rh" ] && [ "$before" -lt "$after" ] && [ "$o2_before" = "$o2_after" ] && echo 1 || echo 0)" \
      "rc=$rc 本仓 ${before}→$after 别处 ${o2_before:0:7}→${o2_after:0:7}"

  # ⑧ 反向对照：把 cwd 泄漏**注入回来**（env-only）⇒ 必须 rc=4、**两处都零提交**、台账记 cwd-lost
  printf 'g\n' > g.txt; before="$(git rev-list --count HEAD)"; o2_before="$(git -C "$other2" rev-parse HEAD)"
  RULER="cd '$other2' && true"; export KB_GIT_PUSH_SELFTEST_LEAK_CWD=1
  out8="$(push_one "$work" 2>&1)"; rc=$?
  unset KB_GIT_PUSH_SELFTEST_LEAK_CWD; RULER=""
  after="$(git rev-list --count HEAD)"; o2_after="$(git -C "$other2" rev-parse HEAD)"
  lc="$(grep -c '"detail":"cwd-lost"' "$LEDGER" 2>/dev/null || true)"; lc="${lc:-0}"
  chk "⑧ 反向对照：注入 cwd 泄漏 ⇒ rc=4、本地与别处**都零提交**、台账记 cwd-lost" \
      "$([ "$rc" = 4 ] && [ "$before" = "$after" ] && [ "$o2_before" = "$o2_after" ] && [ "$lc" -ge 1 ] && echo 1 || echo 0)" \
      "rc=$rc 本仓 ${before}→$after 别处 ${o2_before:0:7}→${o2_after:0:7} cwd-lost=$lc"

  # ⑨ 失败必喊：cwd 跑丢那一路必须**真的调到 notify**（没调 ⇒ 精确变红）
  chk "⑨ 失败必喊：cwd 跑丢 ⇒ notify 真被调到" \
      "$(printf '%s' "$out8" | grep -q '未真发' && echo 1 || echo 0)" \
      "$(printf '%s' "$out8" | grep 'daily-git-push' | tail -1 | cut -c1-110)"

  # ⑩ 自测不打生产群：③ 与 ⑧ 两路 notify 都必须是「只记不真发」（拿掉钩子 ⇒ 变红）
  n_att=0
  printf '%s\n%s\n' "$out3" "$out8" | grep -c '未真发' >/dev/null 2>&1 && n_att="$(printf '%s\n%s\n' "$out3" "$out8" | grep -c '未真发')"
  chk "⑩ 自测不打生产群（KB_ALERT_FORCE_SEND=1：notify 只记不真发）" \
      "$([ "${KB_ALERT_FORCE_SEND:-0}" = 1 ] && [ "$n_att" -ge 2 ] && echo 1 || echo 0)" \
      "KB_ALERT_FORCE_SEND=${KB_ALERT_FORCE_SEND:-<未设>} 自证行=$n_att"

  # ⑪ ★ 同一个仓、两种大小写写法（macOS APFS 大小写不敏感）⇒ **不许假红**
  #    旧判据拿 `pwd -P`（照抄 cd 时输入的大小写）比 git 的 toplevel（另一种写法）⇒ 同一目录也判"跑丢"。
  #    桩测试全绿、真仓库正例当场红 —— 就是这条把它钉住的。
  remote2="$tmp/remote2.git"; cr="$tmp/CaseRepo"
  git init -q --bare "$remote2"
  git init -q -b main "$cr"
  ( cd "$cr" && git config user.email user@example.com && git config user.name cr && git remote add origin "$remote2" \
    && printf 'q\n' > q.txt && git add -A && git commit -qm crinit && git push -q origin main )
  printf 'r\n' > "$cr/r.txt"          # 脏：让 push_one 有活干
  push_one "$tmp/caserepo" >/dev/null 2>&1; rc=$?     # ← 故意用小写写法指向 CaseRepo
  lh="$(git -C "$cr" rev-parse HEAD)"; rh="$(git ls-remote "$remote2" refs/heads/main | awk '{print $1}')"
  chk "⑪ 两种大小写写法指的是同一个仓 ⇒ **不许假红**（rc=0 且真推上去）" \
      "$([ "$rc" = 0 ] && [ "$lh" = "$rh" ] && echo 1 || echo 0)" "rc=$rc ${lh:0:7} vs ${rh:0:7}"

  cd /; rm -rf "$tmp"
  printf '\n反向对照：通过 %d / 失败 %d\n' "$P" "$F"
  [ "$F" = 0 ]
}

if [ "$SELFTEST" = "1" ]; then selftest; exit $?; fi
[ -n "$WHY" ] || log "⚠️ 没给 --why（提交信息会写成 routine）"
LEDGER="${DAILY_GIT_PUSH_LEDGER:-$REPO/PMO/logs/daily-git-push.ndjson}"
rc_all=0; push_one "$REPO" || rc_all=$?
log "结束 rc=$rc_all ｜ 台账：$LEDGER"
exit "$rc_all"

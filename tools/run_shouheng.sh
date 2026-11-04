#!/bin/bash
# ─────────────────────────────────────────────────────────────
# run_shouheng.sh —— 守衡的启动器（给 launchd 用）
#
# 存在的理由：launchd 不继承你的 shell 环境，PATH 里没有 node。
# 而且这台机器上并没有独立安装 node —— 唯一在 PATH 里的 node 是
# Kimi.app 内置的运行时，拿它做守护服务意味着「Kimi 一升级守衡就死」。
#
# 所以这里做运行时自动探测：按稳定性排序尝试多个候选，第一个可用的胜出。
# 想固定用某一个，设环境变量 SHOUHENG_NODE=/path/to/node 即可。
# ─────────────────────────────────────────────────────────────
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$HERE/../PMO/logs"
mkdir -p "$LOG_DIR"

find_node() {
  # 0) 显式指定优先
  if [ -n "${SHOUHENG_NODE:-}" ] && [ -x "$SHOUHENG_NODE" ]; then
    echo "$SHOUHENG_NODE"; return 0
  fi

  # 1) 系统/包管理器安装的 node（最稳定，若存在则首选）
  for p in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node \
           "$HOME/.volta/bin/node" "$HOME/.local/bin/node"; do
    [ -x "$p" ] && { echo "$p"; return 0; }
  done

  # 2) nvm / fnm 管理的版本（取最新一个）
  for d in "$HOME/.nvm/versions/node" "$HOME/.fnm/node-versions"; do
    [ -d "$d" ] || continue
    local cand
    cand="$(find "$d" -maxdepth 3 -type f -name node -perm -u+x 2>/dev/null | sort -V | tail -1)"
    [ -n "$cand" ] && [ -x "$cand" ] && { echo "$cand"; return 0; }
  done

  # 3) DSH Desktop 自带的 Electron，以 ELECTRON_RUN_AS_NODE 方式当 node 用
  #    选它是因为守衡本来就是 DSH 体系的一部分；但它是兜底，不是首选。
  local dsh="/Applications/DSH Desktop.app/Contents/MacOS/DSH Desktop"
  if [ -x "$dsh" ] && ELECTRON_RUN_AS_NODE=1 "$dsh" --version >/dev/null 2>&1; then
    echo "$dsh"; return 0
  fi

  # 4) 最后手段：PATH 里能找到什么用什么
  if command -v node >/dev/null 2>&1; then command -v node; return 0; fi

  return 1
}

NODE_BIN="$(find_node)" || {
  echo "[launcher] ✗ 找不到任何可用的 node 运行时。请安装 node，或设置 SHOUHENG_NODE。" >&2
  exit 127
}

# Electron 当 node 用时必须带这个环境变量
case "$NODE_BIN" in
  *"DSH Desktop"*) export ELECTRON_RUN_AS_NODE=1 ;;
esac

cd "$HERE"

# ── 定时任务总开关（2026-11-04 Owner 裁定：全部撤掉，不再主动推送飞书）──────────
# 默认 0：只保留长连接回话与心跳保活；基线/待收/外部库/补发/幽灵巡检全不跑。
# 要恢复定时推送：启动时显式 SHOUHENG_SCHEDULED_PUSH=1（或改回这里）。
export SHOUHENG_SCHEDULED_PUSH="${SHOUHENG_SCHEDULED_PUSH:-0}"

# ── 端点 / 密钥（2026-10-22 加）─────────────────────────────────────────
# 为什么不放 plist：plist 在**版本库**里，密钥写进去就等于提交了；也不放仓库里的 .env：
# 同一个理由。放在**用户目录**（`~/.dsh/shouheng-llm.env`，600），launchd 这边只负责读。
#   · 不设这个文件 ⇒ 什么都不变，仍用 `config.mjs` 的默认（DeepSeek 官方端点）。
#   · 设了 ⇒ 三件事一起切：地址 + 模型名 + **哪把 key**（`SHOUHENG_LLM_API_KEY`）。
#   · 文件里写错一个变量名不会报错，只会静默地用回默认 —— 所以下面把那三行**打出来**
#     （只报模型名与地址，**密钥一个字节都不打**）。
#
# ★★ 2026-10-23 实测踩过：`. 文件` **只赋 shell 变量，不导出** —— 于是
#    `exec node ws_daemon.mjs` 那个子进程**一个变量都看不到**，横幅里仍是
#    `llmBaseUrl = https://api.deepseek.com`、`llmKeyFrom = DEEPSEEK_API_KEY（凭据库）`。
#    而**上一行刚打过「端点配置 = ~/.dsh/shouheng-llm.env（base=中转站）」** ——
#    读起来像生效了（AGENTS §2.2 第 3 条：界面上看得见 ≠ 已经生效）。
#    ⇒ 必须 `set -a` 把整段包起来，并且下面**打出来的必须是"子进程会看到什么"**，
#      不是"我刚读到了什么"。
if [ -f "$HOME/.dsh/shouheng-llm.env" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$HOME/.dsh/shouheng-llm.env"

  # ★★ 2026-10-27：把同一套端点/密钥**再映射给起链的子进程**。
  #
  # 为什么：守衡自己判不了内容，它 spawn 一个 DSH agent 跑知识库那条链
  #（`tools/agent/tools.mjs` 的 `spawnChain` → `node <旧 App>/…/dsh/lib/bin.js --profile headless`）。
  # 那个子进程**不认** SHOUHENG_*，它读 DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL；
  # 都没有时回落到 `~/.dsh/.credentials.yaml` 里的那把 key。
  #
  # 实测（2026-10-27 16:2x，@守衡 连挂 4 单）：用守衡进程的原样环境跑同一条命令 ——
  #   rc=1 ｜ `dsh: AUTH: Authentication Fails, Your api key: ****b7b8 is invalid`
  # 那把 ****b7b8 就是凭据库里的 DEEPSEEK_API_KEY。⇒ 起链必败，卡片只能回「审查未完成」。
  # 补上下面三行后同一条命令 **rc=0、6.7s、正常作答**（已实测）。
  #
  # 纪律：这里是**唯一**的映射点，不许在 tools.mjs 里再抄一份；
  #       变量名拼错不会报错、只会静默回落 —— 所以启动横幅要把它打出来（下一行）。
  DEEPSEEK_API_KEY="${SHOUHENG_LLM_API_KEY:-}"
  DEEPSEEK_BASE_URL="${SHOUHENG_LLM_BASE_URL:-}"
  DEEPSEEK_DEFAULT_MODEL="${SHOUHENG_LLM_MODEL:-}"
  #
  # ★ 2026-10-27 17:1x：headless profile 也被改了（`~/.dsh/profiles/headless/cordis.patch.yml`，
  #   mtime 17:07）—— 默认模型切到 provider **`opencode-abi`**，而它的 `apiKeyEnv` 是
  #   **`OPENCODE_ABI_API_KEY`**（不是 DEEPSEEK_API_KEY）。那个变量守衡进程里没有 ⇒ 起链会以
  #   `MISSING_CREDENTIAL: llm-pi-ai: no credential for provider route "opencode-abi"; its
  #   profile resolves OPENCODE_ABI_API_KEY, which is not set` 直接失败（本机 17:1x 实测原文）。
  #   同一把 key、只是换了个变量名 ⇒ 在这里一起导出。
  #   ⚠️ 这是**防御**，不是替代：profile 改回 DEEPSEEK_* 时这行也不会害事（多一个变量而已）。
  OPENCODE_ABI_API_KEY="${SHOUHENG_LLM_API_KEY:-}"
  set +a

  echo "[launcher] 起链子进程也会看到 = DEEPSEEK_API_KEY(${#DEEPSEEK_API_KEY} 字符)｜DEEPSEEK_BASE_URL=${DEEPSEEK_BASE_URL:-（空）}｜DEEPSEEK_DEFAULT_MODEL=${DEEPSEEK_DEFAULT_MODEL:-（空）}｜OPENCODE_ABI_API_KEY(${#OPENCODE_ABI_API_KEY} 字符)" >&2
  echo "[launcher] 端点配置 = ~/.dsh/shouheng-llm.env（base=${SHOUHENG_LLM_BASE_URL:-默认}｜model=${SHOUHENG_LLM_MODEL:-默认}｜密钥=${#SHOUHENG_LLM_API_KEY} 字符）" >&2
else
  echo "[launcher] 端点配置 = 无（用 config.mjs 默认：api.deepseek.com / deepseek-flash）" >&2
fi

echo "[launcher] 运行时 = $NODE_BIN ($("$NODE_BIN" --version 2>&1))" >&2
echo "[launcher] 工作目录 = $HERE" >&2
echo "[launcher] 启动时间 = $(date '+%Y-%m-%d %H:%M:%S')" >&2

exec "$NODE_BIN" ws_daemon.mjs "$@"

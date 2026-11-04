#!/usr/bin/env bash
# 会话蒸馏 · 一键重跑（增量）
#
#   bash tools/session_distill/run_all.sh                 # 预演（一个字节都不落盘）
#   bash tools/session_distill/run_all.sh --apply         # 真写
#   bash tools/session_distill/run_all.sh --apply --since 2026-10-01
#
# ★ 本脚本**只写工作区**（`PMO/会话蒸馏-20261015/`）。它不碰：
#     · `kb/l0…l7`      —— 沙箱外，且 `kb/l7/registry/write-gate.yaml` 里没有覆盖本轮的凭据
#     · `~/.dsh/skills/` —— 沙箱外；补丁是**候选**，落盘是人的动作
#
# ★ bash 3.2 陷阱（AGENTS.md §2.2 第 4 条）：macOS 自带 bash 会吃掉「紧跟变量的中文」
#   的首字节，所以下面**凡是变量后面跟中文的地方一律写 ${VAR}**。
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "${HERE}/../.." && pwd)"
SINCE="2026-10-05"
APPLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY="--apply" ;;
    --since) SINCE="$2"; shift ;;
    *) echo "未知参数：$1"; exit 2 ;;
  esac
  shift
done

cd "${REPO}" || exit 2
PY="${PYTHON:-python3}"
FAIL=0

step() {
  echo ""
  echo "════════ $1 ════════"
  shift
  "$@" || FAIL=1
}

# 0 各段自证（先证判据，再跑数据 —— 判据坏了跑出来的数没有意义）
for seg in s1_extract s2_casefy s3_judge s4_route s5_schema s6_patch; do
  step "自证 ${seg}" "${PY}" "tools/session_distill/${seg}.py" --selftest
done

# 1..6 主链
step "S1 抽取"       "${PY}" tools/session_distill/s1_extract.py --since "${SINCE}" ${APPLY}
step "S2 案例化"     "${PY}" tools/session_distill/s2_casefy.py ${APPLY}
step "S3 正误判定"   "${PY}" tools/session_distill/s3_judge.py ${APPLY}
step "S4 分层归位"   "${PY}" tools/session_distill/s4_route.py ${APPLY}
step "S5 Schema 蒸馏" "${PY}" tools/session_distill/s5_schema.py ${APPLY}
step "S6 补丁与影响面" "${PY}" tools/session_distill/s6_patch.py ${APPLY}

# 7 全链守恒（带 --rerun：刚跑完 S1，正是验幂等的时机）
echo ""
echo "════════ S7 全链自证 ════════"
"${PY}" tools/session_distill/s7_verify.py --rerun
S7="${?}"

# 8 覆盖率抽查（重生成报告；它量的是召回，S3 自证量不到）
echo ""
echo "════════ 覆盖率抽查 ════════"
"${PY}" tools/session_distill/coverage_probe.py --write || FAIL=1

echo ""
if [ "${S7}" -eq 2 ]; then
  # ★ 「未测」必须与「通过」和「红」都长得不一样（kb 的 H1–H7 同一条纪律）。
  #   原先这里把 rc=2 当成红，等于把「我没测到」读成了「它坏了」—— 方向反了。
  echo "⚠ 全链跑完，**0 红但有未测** —— 未测 ≠ 通过 ≠ 红。上面写了哪几项没测到。"
  exit 2
fi
if [ "${S7}" -ne 0 ] || [ "${FAIL}" -ne 0 ]; then
  echo "❌ 有红 —— 别把这次的结果当成品（上面哪一段红就看哪一段）"
  exit 1
fi
echo "✅ 全链跑完，无红无未测。产物在 PMO/会话蒸馏-20261015/"
exit 0

#!/usr/bin/env bash
# 把「skill 优化」与「自生长」落到知识库侧 —— v2：**按 kb-l0-feishu §8.3 的五步来**。
#
#   bash tools/session_distill/deploy_skill_growth.sh            # 预演
#   bash tools/session_distill/deploy_skill_growth.sh --apply    # 真写
#   bash tools/session_distill/deploy_skill_growth.sh --rollback <备份目录>
#
# v1 犯了四个错，逐条记在这里（改的是判据，不是措辞）：
#   ① **假绿**：写失败时「纯追加」断言照样通过 —— 文件没变，前后自然逐字节相同。
#      修：断言必须同时验**它真的长了**（新尺寸 − 旧尺寸 == 追加块尺寸）。
#   ② **把 version 当成不许变的东西**：库的 §8.3 ③ 明确要求 bump `version` / `last_updated`。
#      真正不许变的是 `description`（触发词 = 路由）。修：只锁 description 的 sha256。
#   ③ **没走完整五步**：缺 ② CHANGELOG、③ bump、④ 验明文。修：五步齐全。
#   ④ **`skills_check.py --json` 是照抄没验的** —— 它不支持该参数，于是解析器读了个空。
#      修：解析它真实的汇总行「五类问题：1=… 2=… 3=… 4=… 5=…」。
#
# ★ bash 3.2 陷阱（AGENTS.md §2.2 第 4 条）：凡是变量后面跟中文的地方一律写 ${VAR}。
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "${HERE}/../.." && pwd)"
LAND="${REPO}/PMO/会话蒸馏-20261015/落地"
PATCHES="${REPO}/PMO/会话蒸馏-20261015/补丁"
KBPROJ="/Users/lute/Documents/skill-test/执行skills/执行skills/skills-回归测试/知识库/内容治理"
SLOT="${HOME}/.dsh/skills"
LA="$HOME/Library/LaunchAgents"
STAMP="$(date +%Y%m%d-%H%M%S)"
DAY="$(date +%Y-%m-%d)"
BAK="${LAND}/_backup-${STAMP}"
SECTION_TITLE="会话蒸馏回灌（2026-10-15）"

MAP=(
  "kb-l0-feishu:${KBPROJ}/kb/l7/skills/kb-l0-feishu"
  "kb-repair:${KBPROJ}/kb/l7/skills/kb-repair"
  "kb-recall:${KBPROJ}/kb/l7/skills/kb-recall"
  "kb-pipeline:${KBPROJ}/kb/l7/skills/kb-pipeline"
  "内容审查总控:/Users/lute/Desktop/skill/内容治理中文skill/内容审查总控"
  "飞书审查流转:/Users/lute/Desktop/skill/内容治理中文skill/飞书审查流转"
)

APPLY=0; ROLLBACK=""
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --rollback) ROLLBACK="$2"; shift ;;
    *) echo "未知参数：$1"; exit 2 ;;
  esac
  shift
done

FAIL=0
ck() { if [ "$2" = "$3" ]; then echo "   ✅ $1"; else echo "   ❌ $1（得到 $2，期望 $3）"; FAIL=1; fi; }

# 路由指纹 = frontmatter 里 **description 的值** 的 sha256。
# ★ v2 第一版用 `sed -n '/^description:/,/^[a-z_]*:/p'` 取那一段 —— 它**把结束行也吃进去了**，
#   而结束行正是 `version:`，于是「bump version」这一步必然让这个哈希变，
#   六条断言**全红**。那不是文件坏了，是判据把不该锁的东西锁了进去。
#   修法：解析 YAML，只 hash description 的**值**；顺便把 `name` 也带上（路由靠这两个）。
route_hash() {
  python3 - "$1" <<'PY'
import hashlib, re, sys
s = open(sys.argv[1], encoding="utf-8").read()
m = re.match(r'^---\n(.*?)\n---\n', s, flags=re.S)
fm = m.group(1) if m else ""
name = desc = ""
try:
    import yaml
    d = yaml.safe_load(fm) or {}
    name = str(d.get("name") or "")
    v = d.get("description")
    desc = v if isinstance(v, str) else repr(v)
except Exception:
    a = re.search(r'^name:\s*(.*)$', fm, flags=re.M)
    b = re.search(r'^description:\s*(.*?)(?=^[A-Za-z_]+:)', fm, flags=re.S | re.M)
    name = a.group(1) if a else ""
    desc = b.group(1) if b else ""
print(hashlib.sha256((name + "\x00" + desc).encode()).hexdigest())
PY
}

# ── 回滚 ───────────────────────────────────────────────────────────
if [ -n "${ROLLBACK}" ]; then
  echo "── 回滚：从 $ROLLBACK"
  for pair in "${MAP[@]}"; do
    sk="${pair%%:*}"; src="${pair#*:}"; slot="${SLOT}/${sk}"
    DM=""; [ -w "${src}" ] || { DM="$(stat -f '%Lp' "${src}")"; chmod u+w "${src}"; }
    for name in SKILL.md CHANGELOG.md; do
      if [ -f "${ROLLBACK}/${sk}/${name}" ]; then
        [ -w "${src}/SKILL.md" ] || chmod u+w "${src}/SKILL.md" 2>/dev/null
        [ -f "${src}/references/${name}" ] && { [ -w "${src}/references/${name}" ] || chmod u+w "${src}/references/${name}"; }
        if [ "${name}" = "SKILL.md" ]; then
          /bin/cp -p "${ROLLBACK}/${sk}/${name}" "${src}/${name}" 2>/dev/null
        else
          /bin/cp -p "${ROLLBACK}/${sk}/${name}" "${src}/references/${name}" 2>/dev/null
        fi
      fi
    done
    # ★ 父目录可能只读（kb-l0-feishu / kb-recall 是 dr-xr-xr-x）⇒ 先临时解锁再删；
    #   第一版直接 rm，两条 Permission denied 被 echo 的「已还原」盖过去了（假绿）。
    RM=""; [ -d "${src}/references" ] && [ ! -w "${src}/references" ] && { RM="$(stat -f '%Lp' "${src}/references")"; chmod u+w "${src}/references"; }
    rm -f "${src}/references/会话蒸馏回灌.md" || { echo "   ❌ ${sk}：回灌文件删不掉"; }
    [ -n "${RM}" ] && chmod "${RM}" "${src}/references"
    if [ -L "${slot}" ]; then :; else
      /bin/cp -p "${src}/SKILL.md" "${slot}/SKILL.md" 2>/dev/null
      rm -f "${slot}/references/会话蒸馏回灌.md"
    fi
    [ -n "${DM}" ] && chmod "${DM}" "${src}"
    echo "   已还原 ${sk}（回灌文件已移除）"
  done
  echo "✅ 回滚完成"
  exit 0
fi

# ── 前置 ───────────────────────────────────────────────────────────
echo "── 前置体检"
for pair in "${MAP[@]}"; do
  sk="${pair%%:*}"; src="${pair#*:}"; slot="${SLOT}/${sk}"
  [ -f "${src}/SKILL.md" ] || { echo "   ❌ 源里没有 SKILL.md：${src}"; FAIL=1; }
  [ -d "${slot}" ] || { echo "   ❌ 装载位不存在：${slot}"; FAIL=1; }
  [ -f "${PATCHES}/${sk}.references.md" ] || { echo "   ❌ 缺回灌正文：${sk}"; FAIL=1; }
done
for f in kb-l8-skill_growth.py kb-l7-registry-skill-growth.yaml com.kb.skill-growth.plist "skill-追加节.md"; do
  [ -f "${LAND}/${f}" ] || { echo "   ❌ 缺落地件：${f}"; FAIL=1; }
done
[ "${FAIL}" = "0" ] || { echo "✗ 前置不绿，停"; exit 1; }
echo "   ✅ 六个源 + 装载位 + 落地件齐全"

if [ "${APPLY}" = "0" ]; then
  echo ""
  echo "── 预演（**未落盘**）。每个 skill 走 §8.3 五步："
  for pair in "${MAP[@]}"; do
    sk="${pair%%:*}"; src="${pair#*:}"; slot="${SLOT}/${sk}"
    kind="实目录"; [ -L "${slot}" ] && kind="符号链接→源"
    ro="可写"; [ -w "${src}/SKILL.md" ] || ro="**只读**（临时解锁+还原）"
    echo "   · ${sk}（装位=${kind}｜源=${ro}）"
  done
  echo "   ① 备份 ② CHANGELOG ③ bump version/last_updated ④ 验明文 ⑤ 同步 + skills_check 第3类=0"
  echo "   另：新增 references/会话蒸馏回灌.md + SKILL.md 追加一节（**description 锁死不写**）"
  echo "（加 --apply 才真写）"
  exit 0
fi

mkdir -p "${BAK}"
echo ""
echo "── 备份到 ${BAK}"
for pair in "${MAP[@]}"; do
  sk="${pair%%:*}"; src="${pair#*:}"
  mkdir -p "${BAK}/${sk}"
  /bin/cp -p "${src}/SKILL.md" "${BAK}/${sk}/SKILL.md"
  [ -f "${src}/references/CHANGELOG.md" ] && /bin/cp -p "${src}/references/CHANGELOG.md" "${BAK}/${sk}/CHANGELOG.md"
done
echo "   ✅ 已备份 SKILL.md 与 CHANGELOG"

BLOCK_BYTES=$(wc -c < "${LAND}/skill-追加节.md" | tr -d ' ')

echo ""
echo "── §8.3 五步（逐个 skill）"
for pair in "${MAP[@]}"; do
  sk="${pair%%:*}"; src="${pair#*:}"; slot="${SLOT}/${sk}"
  echo "── ${sk}"

  DIRW=0; DIRMODE=""
  [ -w "${src}" ] || { DIRMODE="$(stat -f '%Lp' "${src}")"; chmod u+w "${src}"; DIRW=1; }
  FMODE=""
  [ -w "${src}/SKILL.md" ] || { FMODE="$(stat -f '%Lp' "${src}/SKILL.md")"; chmod u+w "${src}/SKILL.md"; }

  old_size=$(wc -c < "${src}/SKILL.md" | tr -d ' ')
  # ★ 只锁 description（触发词 = 路由）。version / last_updated **本来就该变**（§8.3 ③）。
  route_before=$(route_hash "${src}/SKILL.md")

  if grep -q "${SECTION_TITLE}" "${src}/SKILL.md"; then
    echo "   · SKILL.md 已有这一节，跳过追加（幂等）"
    appended=0
  else
    cat "${LAND}/skill-追加节.md" >> "${src}/SKILL.md"
    appended=1
  fi
  mkdir -p "${src}/references"
  [ -w "${src}/references" ] || chmod u+w "${src}/references"
  /bin/cp -p "${PATCHES}/${sk}.references.md" "${src}/references/会话蒸馏回灌.md"

  # ① 断言：**真的长了**（v1 的假绿就出在这里 —— 只验「前 N 字节相同」在写失败时也成立）
  new_size=$(wc -c < "${src}/SKILL.md" | tr -d ' ')
  if [ "${appended}" = "1" ]; then
    ck "纯追加且真的长了（+$((new_size - old_size)) == 追加块 ${BLOCK_BYTES}）" "$((new_size - old_size))" "${BLOCK_BYTES}"
  else
    ck "幂等：尺寸未变" "${new_size}" "${old_size}"
  fi
  head -c "${old_size}" "${src}/SKILL.md" > "${BAK}/${sk}/.head"
  if cmp -s "${BAK}/${sk}/.head" "${BAK}/${sk}/SKILL.md"; then
    echo "   ✅ 已有内容逐字节未动"
  else
    echo "   ❌ 已有内容被改动了 ⇒ 还原这个 skill"; FAIL=1
    /bin/cp -p "${BAK}/${sk}/SKILL.md" "${src}/SKILL.md"
    [ -n "${FMODE}" ] && chmod "${FMODE}" "${src}/SKILL.md"
    [ "${DIRW}" = "1" ] && chmod "${DIRMODE}" "${src}"
    continue
  fi

  # ②③ 先判「这一轮到底有没有改东西」—— 判据是 CHANGELOG 里有没有今天的记录。
  #   ★ 第一版把 bump 放在这个判据**之前**，于是**每重跑一次版本号就涨一格**，
  #     而内容一个字没变。版本号必须绑在「这次真的改了东西」上，不能绑在「这次跑过」上。
  CH="${src}/references/CHANGELOG.md"
  if [ ! -f "${CH}" ]; then printf '# CHANGELOG\n' > "${CH}"; else [ -w "${CH}" ] || chmod u+w "${CH}"; fi
  # ★ 不变式：**CHANGELOG 记的「→ Y」必须等于 SKILL.md 当前的 version**。
  #   第一版用「有没有今天的记录」当幂等判据，于是回滚把 SKILL.md 还原、CHANGELOG 没还原时，
  #   就出现「内容改了、版本号没动」—— 与 §8.3 ③ 相反的不一致，而且**没人会红**。
  #   现在判据换成上面那条不变式：不一致就对齐，一致才跳过。
  WANT="$(grep -o "version：[^ ]* → [^ ]*" "${CH}" 2>/dev/null | tail -1 | sed 's/.*→ //')"
  CUR="$(grep -m1 "^version:" "${src}/SKILL.md" 2>/dev/null | sed 's/[^0-9.]//g')"
  if [ -n "${WANT}" ] && [ "${WANT}" != "—" ] && [ "${WANT}" != "${CUR}" ]; then
    echo "   · CHANGELOG 记的是 ${WANT}、SKILL.md 是 ${CUR} ⇒ **对齐**（自愈）"
    NO_BUMP=0; FORCE_VER="${WANT}"
  elif grep -q "会话蒸馏回灌-${DAY}" "${CH}"; then
    echo "   · 版本已对齐且本轮已记过账 ⇒ 不再 bump（幂等）"
    NO_BUMP=1; FORCE_VER=""
  else
    NO_BUMP=0; FORCE_VER=""
  fi

  # ③ bump version / last_updated（§8.3 ③ 硬要求；只在「版本与账不符」时才动）
  vold=""; vnew=""
  if [ "${NO_BUMP}" = "1" ]; then
    vold="$(grep -m1 '^version:' "${src}/SKILL.md" 2>/dev/null | sed 's/[^0-9.]//g')"
    echo "   · 版本已对齐（${vold}）且本轮已记过账 ⇒ 不 bump"
  elif grep -q "^version:" "${src}/SKILL.md"; then
    vold="$(grep -m1 '^version:' "${src}/SKILL.md" | sed 's/[^0-9.]//g')"
    if [ -n "${FORCE_VER:-}" ]; then
      vnew="${FORCE_VER}"
    else
      vnew="$(python3 -c "
v = '${vold}'.split('.')
try:
    v[-1] = str(int(v[-1]) + 1)
except Exception:
    v.append('1')
print('.'.join(v))")"
    fi
    python3 - "${src}/SKILL.md" "${vnew}" "${DAY}" <<'PYB'
import os, re, subprocess, sys
p, new, day = sys.argv[1:4]
s = open(p, encoding="utf-8").read()
s = re.sub(r'^(version:\s*).*$', r'\g<1>"%s"' % new, s, count=1, flags=re.M)
if re.search(r'^last_updated:', s, flags=re.M):
    s = re.sub(r'^(last_updated:\s*).*$', r'\g<1>"%s"' % day, s, count=1, flags=re.M)
else:
    s = re.sub(r'^(version:.*)$', r'\g<1>\nlast_updated: "%s"' % day, s, count=1, flags=re.M)
# ★ 走 cp 通道落盘：**python 直写 .md/.sh 在本机会落成 +4096 信封**（本文件自己就踩过一次）
open(p + ".tmp-nosuffix", "w", encoding="utf-8").write(s)
subprocess.run(["/bin/cp", p + ".tmp-nosuffix", p], check=True)
os.unlink(p + ".tmp-nosuffix")
PYB
    echo "   ✅ version ${vold} → ${vnew}，last_updated → ${DAY}"
  else
    echo "   ⚠ 源里没有 version 字段（跳过 bump）"
  fi

  # ② CHANGELOG 追加（§8.3 ②）
  if [ "${NO_BUMP}" = "0" ]; then
    {
      printf '\n## 会话蒸馏回灌-%s\n\n' "${DAY}"
      printf -- '- 新增 `references/会话蒸馏回灌.md`（会话蒸馏候选区，E2 · 未获批）\n'
      printf -- '- `SKILL.md` 末尾**追加**一节「%s」指针（**description 未改** ⇒ 路由不变）\n' "${SECTION_TITLE}"
      printf -- '- version：%s → %s\n' "${vold:-—}" "${vnew:-—}"
    } >> "${CH}"
    echo "   ✅ CHANGELOG 已追加"
  else
    echo "   · CHANGELOG 已有本轮记录（幂等）"
  fi

  # .skill-meta/manifest.yaml 同步 bump（有才做）
  MF="${src}/.skill-meta/manifest.yaml"
  if [ -f "${MF}" ]; then
    # ★ `.skill-meta/` 是**只读目录**（dr-xr-xr-x）⇒ 连 .tmp-nosuffix 都写不进去，
    #   第一版只 chmod 了文件、没 chmod 目录，于是报 PermissionError。
    MD=""; [ -w "${src}/.skill-meta" ] || { MD="$(stat -f '%Lp' "${src}/.skill-meta")"; chmod u+w "${src}/.skill-meta"; }
    [ -w "${MF}" ] || chmod u+w "${MF}"
    python3 - "${MF}" "${vnew}" "${DAY}" <<'PY'
import os, re, subprocess, sys
p, new, day = sys.argv[1:4]
s = open(p, encoding="utf-8").read()
if new:
    s = re.sub(r'^(\s*version:\s*).*$', r'\g<1>"%s"' % new, s, count=1, flags=re.M)
s = re.sub(r'^(\s*updated_at:\s*).*$', r'\g<1>"%s"' % day, s, count=1, flags=re.M)
open(p + ".tmp-nosuffix", "w", encoding="utf-8").write(s)
subprocess.run(["/bin/cp", p + ".tmp-nosuffix", p], check=True)
os.unlink(p + ".tmp-nosuffix")
PY
    [ -n "${MD}" ] && chmod "${MD}" "${src}/.skill-meta"
    echo "   ✅ .skill-meta/manifest.yaml 已 bump"
  fi

  # ④ 验明文（防信封态）
  nb=$(node -e "process.stdout.write(String(require('fs').statSync(process.argv[1]).size))" "${src}/SKILL.md")
  pb=$(stat -f '%z' "${src}/SKILL.md")
  ck "验明文（python ${pb} == node ${nb}）" "${pb}" "${nb}"

  # ⑤ 同步装载位
  if [ -L "${slot}" ]; then
    tgt=$(readlink "${slot}")
    ck "装位符号链接指向源" "${tgt}" "${src}"
  else
    mkdir -p "${slot}/references"
    /bin/cp -p "${src}/SKILL.md" "${slot}/SKILL.md"
    /bin/cp -p "${src}/references/会话蒸馏回灌.md" "${slot}/references/会话蒸馏回灌.md"
    [ -f "${CH}" ] && /bin/cp -p "${CH}" "${slot}/references/CHANGELOG.md"
    echo "   ✅ 已同步到装载位（cp -p 逐文件）"
  fi

  # 还原只读模式
  [ -n "${FMODE}" ] && chmod "${FMODE}" "${src}/SKILL.md"
  if [ "${DIRW}" = "1" ]; then
    [ -d "${src}/references" ] && chmod "${DIRMODE}" "${src}/references"
    chmod "${DIRMODE}" "${src}"
  fi
  route_after=$(route_hash "${src}/SKILL.md")
  ck "name+description 未变（**路由不变**；version 该变就变）" "${route_after}" "${route_before}"
done
rm -f "${BAK}"/*/.head 2>/dev/null

# ── 装引擎与政策 ───────────────────────────────────────────────────
echo ""
echo "── 装自生长引擎与政策"
mkdir -p "${KBPROJ}/kb/l8" "${KBPROJ}/kb/l7/registry"
/bin/cp -p "${LAND}/kb-l8-skill_growth.py" "${KBPROJ}/kb/l8/skill_growth.py"
/bin/cp -p "${LAND}/kb-l7-registry-skill-growth.yaml" "${KBPROJ}/kb/l7/registry/skill-growth.yaml"
echo "   ✅ kb/l8/skill_growth.py + kb/l7/registry/skill-growth.yaml"
( cd "${KBPROJ}" && ./kb/kbpy l8/skill_growth.py --selftest ) || FAIL=1

# ── 装触发器 ───────────────────────────────────────────────────────
echo ""
echo "── 装触发器 com.kb.skill-growth"
mkdir -p "${LA}" "$HOME/Library/Logs/kb-skill-growth"
/bin/cp -p "${LAND}/com.kb.skill-growth.plist" "${LA}/com.kb.skill-growth.plist"
launchctl bootout "gui/$(id -u)/com.kb.skill-growth" 2>/dev/null
launchctl bootstrap "gui/$(id -u)" "${LA}/com.kb.skill-growth.plist" 2>/dev/null \
  || launchctl load "${LA}/com.kb.skill-growth.plist" 2>/dev/null
if launchctl list 2>/dev/null | grep -q "com.kb.skill-growth"; then
  echo "   ✅ 已加载（每日 04:10）"
else
  echo "   ⚠ 未在册 —— plist 已就位，手工 load"
fi
echo "   com.kb.* 在册数：$(launchctl list 2>/dev/null | grep -c 'com\.kb\.')"

# ── 关门体检（解析它**真实的**汇总行）──────────────────────────────
echo ""
echo "── 关门体检 skills_check.py"
CHECK="${BAK}/skills_check.txt"
( cd "${KBPROJ}" && ./kb/kbpy l7/scripts/skills_check.py > "${CHECK}" 2>&1 )
SUM=$(grep -o "五类问题：1=[0-9]* 2=[0-9]* 3=[0-9]* 4=[0-9]* 5=[0-9]*" "${CHECK}" | tail -1)
if [ -z "${SUM}" ]; then
  echo "   ⚠ 未测：解析不到汇总行 —— **不是通过**。原文尾部："
  tail -4 "${CHECK}" | sed 's/^/      /'
  FAIL=1
else
  echo "   ${SUM}"
  N3=$(echo "${SUM}" | sed 's/.*3=\([0-9]*\).*/\1/')
  NALL=$(echo "${SUM}" | grep -o "[0-9]*" | paste -sd+ - | bc)
  ck "第 3 类「副本不一致」== 0" "${N3}" "0"
  echo "   五类合计：${NALL}"
  if grep -q "结论：全过" "${CHECK}"; then echo "   ✅ 结论：全过"; else echo "   ❌ 结论不是「全过」"; FAIL=1; fi
fi

echo ""
if [ "${FAIL}" = "0" ]; then
  echo "✅ 落地完成（§8.3 五步齐全）。回滚点：${BAK}"
  exit 0
fi
echo "❌ 有红。回滚：bash tools/session_distill/deploy_skill_growth.sh --rollback ${BAK}"
exit 1

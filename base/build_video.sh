#!/bin/bash
# build_video.sh —— 把 video_probe.m 编译成 `.tools/bin/video_probe`
#
# 与 `build_ocr.sh` / `build_asr.sh` 同一条路子：**只用系统框架**（AVFoundation + AppKit），
# 不装 ffmpeg、不装任何包。为什么是指定 SDK 而不是默认 SDK，见 `build_ocr.sh` 顶上那段
# （默认 MacOSX27.0 SDK 是坏的：`tapi error: malformed file … arm64e.x1-macos`）。
#
# ★ 视频这条路**不需要 TCC**（AVFoundation 读本地文件不是隐私服务），
#   所以它可以像 OCR 一样**直接 exec**，不必打成 .app、不必 `open -n`。
#   这是它与 `build_asr.sh` 最大的不同 —— 别照着 ASR 那份抄。
#
# 一并编译 `video_fixture`（生成视频试纸的那个工具）。它平时不跑 —— 试纸是**本仓资产**，
# 只有要重做试纸时才用它，留在这里是为了让「试纸是怎么来的」可复现。
#
# 用法：bash base/build_video.sh [输出路径]
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
OUT="${1:-$ROOT/.tools/bin/video_probe}"
mkdir -p "$(dirname "$OUT")"
FIXTURE_OUT="$(dirname "$OUT")/video_fixture"

# 两个目标用的是同一组框架，所以放在同一个 SDK 循环里试。
for s in MacOSX15.4 MacOSX26.5 MacOSX15 MacOSX26 MacOSX.sdk; do
  SDK="/Library/Developer/CommandLineTools/SDKs/$s.sdk"
  [ -d "$SDK" ] || continue
  if clang -O2 -fobjc-arc -isysroot "$SDK" \
       -framework Foundation -framework AVFoundation -framework AppKit -framework CoreMedia \
       -o "$OUT" "$HERE/video_probe.m" 2>/tmp/build_video_err.$$; then
    if clang -O2 -fobjc-arc -isysroot "$SDK" \
         -framework Foundation -framework AVFoundation -framework AppKit \
         -framework CoreMedia -framework CoreVideo \
         -o "$FIXTURE_OUT" "$HERE/video_fixture.m" 2>/tmp/build_video_fix_err.$$; then
      echo "✓ 编译成功：$OUT  (SDK=$s)"
      echo "✓ 编译成功：${FIXTURE_OUT}（只在重做试纸时用）"
      rm -f /tmp/build_video_err.$$ /tmp/build_video_fix_err.$$
      exit 0
    fi
    echo "  ✗ video_fixture 失败：$(head -1 /tmp/build_video_fix_err.$$ | cut -c1-100)"
    rm -f "$OUT"
  fi
  echo "  ✗ SDK=$s 失败：$(head -1 /tmp/build_video_err.$$ | cut -c1-100)"
done
echo "✗ 所有候选 SDK 都编译失败。最后一次错误："
cat /tmp/build_video_err.$$ 2>/dev/null | head -20
rm -f /tmp/build_video_err.$$
exit 1

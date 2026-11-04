#!/bin/bash
# build_ocr.sh —— 把 ocr_vision.m 编译成 .tools/bin/ocr
#
# ★ 为什么要指定 SDK：本机默认 SDK（MacOSX27.0）是坏的。
#   实测报错：`tapi error: malformed file ... unknown architecture arm64e.x1-macos`
#   —— SDK 由 Swift 6.4 构建，而 CLT 里的编译器是 6.3.3，两者不匹配。
#   本脚本按「能用」顺序试几个 SDK，而不是写死一个。
#
# ★ 为什么用 Objective-C 而不用 Swift：Swift 那条路在这台机器上走不通
#   （`failed to build module 'Swift'; this SDK is not supported by the compiler`），
#   而 ObjC 只依赖 clang 与系统框架，指定旧 SDK 即可。
#
# 用法：bash base/build_ocr.sh [输出路径]
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
OUT="${1:-$ROOT/.tools/bin/ocr}"
mkdir -p "$(dirname "$OUT")"

SDKS=(MacOSX15.4 MacOSX26.5 MacOSX15 MacOSX26 MacOSX.sdk)
for s in "${SDKS[@]}"; do
  SDK="/Library/Developer/CommandLineTools/SDKs/$s.sdk"
  [ -d "$SDK" ] || continue
  if clang -O2 -fobjc-arc -isysroot "$SDK" \
       -framework Foundation -framework Vision -framework AppKit \
       -o "$OUT" "$HERE/ocr_vision.m" 2>/tmp/build_ocr_err.$$; then
    echo "✓ 编译成功：$OUT  (SDK=$s)"
    rm -f /tmp/build_ocr_err.$$
    exit 0
  fi
  echo "  ✗ SDK=$s 失败：$(head -1 /tmp/build_ocr_err.$$ | cut -c1-100)"
done
echo "✗ 所有候选 SDK 都编译失败。最后一次错误："
cat /tmp/build_ocr_err.$$ 2>/dev/null | head -20
rm -f /tmp/build_ocr_err.$$
exit 1

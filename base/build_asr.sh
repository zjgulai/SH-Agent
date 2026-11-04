#!/bin/bash
# build_asr.sh —— 把 asr_speech.m 编译成 `.tools/bin/shouheng-asr` **并打成 .app**
#
# ── 为什么必须打成 .app（这一条是实测出来的，不是照抄文档）
#
# Speech.framework 属于 **TCC 隐私服务**（`kTCCServiceSpeechRecognition`）。裸 CLI 调它，
# 进程会在 `requestAuthorization` 那一刻直接 **`Abort trap: 6`**，stderr 里写着
# `namespace:TCC … attempted to access privacy-sensitive data without a usage description`。
# 把 `NSSpeechRecognitionUsageDescription` 用链接器塞进 `__TEXT,__info_plist` 段也没用 ——
# 实测照样 abort（那个做法是 OCR 那条路用的，Vision 不在 TCC 名单里，所以它一直好使）。
#
# 现在这条路的形状是**三层**，少一层就还是 abort：
#   ① 二进制在 `.app/Contents/MacOS/` 里，`Info.plist` 里写用途说明；
#   ② 用 `open -n <app> --args …` 启动 —— LaunchServices 是发起者，TCC 才会把
#      「用途说明」算在这个 app 头上；
#   ③ 结果**写文件**，不能指望 stdout（`open` 不接管子）。
#
# ★ 判据（这张读数证明的是「直接 exec 真的不行」，不是「文档说要 open」）：
#     $ .tools/bin/ShouhengASR.app/Contents/MacOS/shouheng-asr a.wav zh-CN out.json
#     rc=134 (Abort trap: 6)，只打出了授权之前那一行
#     $ open -n .tools/bin/ShouhengASR.app --args a.wav zh-CN out.json
#     rc=0，out.json 里是 `{"ok":true,"text":"…"}`
#
# 用法：bash base/build_asr.sh [输出二进制路径]
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
OUT="${1:-$ROOT/.tools/bin/shouheng-asr}"
mkdir -p "$(dirname "$OUT")"

# ★ 为什么要指定 SDK：本机默认 SDK（MacOSX27.0）是坏的 ——
#   `tapi error: malformed file … unknown architecture arm64e.x1-macos`。
#   与 `build_ocr.sh` 同一条路子：按「能用」顺序试，不写死。
SDKS=(MacOSX15.4 MacOSX26.5 MacOSX15 MacOSX26 MacOSX.sdk)
BUILT=""
for s in "${SDKS[@]}"; do
  SDK="/Library/Developer/CommandLineTools/SDKs/$s.sdk"
  [ -d "$SDK" ] || continue
  if clang -O2 -fobjc-arc -isysroot "$SDK" \
       -framework Foundation -framework Speech \
       -o "$OUT" "$HERE/asr_speech.m" 2>/tmp/build_asr_err.$$; then
    BUILT="$s"
    break
  fi
  echo "  ✗ SDK=$s 失败：$(head -1 /tmp/build_asr_err.$$ | cut -c1-100)"
done
if [ -z "$BUILT" ]; then
  echo "✗ 所有候选 SDK 都编译失败。最后一次错误："
  cat /tmp/build_asr_err.$$ 2>/dev/null | head -20
  rm -f /tmp/build_asr_err.$$
  exit 1
fi
rm -f /tmp/build_asr_err.$$

# ── 打 bundle ──
#
# ★ `LSUIElement`（不是 `LSBackgroundOnly`）—— 这一条是实测出来的，且**只有踩过才知道**：
#   `LSBackgroundOnly` 的应用**弹不出 TCC 授权对话框**，于是 `requestAuthorization`
#   的回调**永远不来**，进程一直等到 120 秒超时后报 `timeout` ——
#   读起来像「识别太慢/模型没装」，真因在授权对话框弹不出来。
#   而 TCC 的身份对**临时签名**是按 cdhash 记的：**每重编一次二进制，授权就失效一次**
#   （`~/Library/Application Support/com.apple.TCC/TCC.db` 里那条 csreq 就对不上了）。
#   于是「重编 → 弹不出框 → 永久挂住」成了这条路最容易复现的故障。
#   读数：`sqlite3 …TCC.db "select service,client,auth_value from access where service like '%peech%'"`
#   → `kTCCServiceSpeechRecognition|local.shouheng.asr|2`；把 plist 换回 LSBackgroundOnly
#   重编一次，同一个调用就变成 120 秒后 `{"ok":false,"error":"timeout"}`。
APP="$(dirname "$OUT")/ShouhengASR.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
/bin/cp "$OUT" "$APP/Contents/MacOS/shouheng-asr"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>shouheng-asr</string>
<key>CFBundleIdentifier</key><string>local.shouheng.asr</string>
<key>CFBundleName</key><string>ShouhengASR</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>LSUIElement</key><true/>
<key>NSSpeechRecognitionUsageDescription</key><string>本机语音转写：只在本机把音频变成文字，不联网、不外传。</string>
</dict></plist>
PLIST

# ③ 结果写文件这条契约本身也要有执行点：bundle 里少一样东西，
#    症状是「群里发视频，守衡回一句『转写不出来』」，而没有任何东西会红。
for req in "Contents/MacOS/shouheng-asr" "Contents/Info.plist"; do
  [ -e "$APP/$req" ] || { echo "✗ bundle 少了 $req"; exit 1; }
done
grep -q "NSSpeechRecognitionUsageDescription" "$APP/Contents/Info.plist" \
  || { echo "✗ Info.plist 里没有用途说明 —— 那样一调就 Abort trap: 6"; exit 1; }

echo "✓ 编译成功：$OUT  (SDK=$BUILT)"
echo "✓ bundle：$APP"

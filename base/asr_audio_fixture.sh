#!/bin/sh
# asr_audio_fixture.sh —— 生成/重建**带音轨的音频试纸** `audio-sample.m4a`。
#
# 为什么要有它（2026-10-08）：视频那条路里，「画面文字定语种 ⇒ 再交给转写」这段接线
# 原来**没有试纸能钉住** ——
#   · `video-sample.mp4` 是**纯画面、没有音轨**（AVAssetWriter 只写了视频轨）⇒
#     `readVideo()` 走 `kind:'no_audio_track'`，**根本不调 `asrFn`**，接线对不对它一个字都不说；
#   · `asr-sample.wav` 是音频、不是视频 ⇒ 过不了 `probeVideo()`。
# ⇒ 于是补这一张：一个**有音轨、没有视频轨**的 m4a。它在 `readVideo()` 里
#   `has_audio=true` ⇒ 会走转写那一段；`n_frames=0` ⇒ 画面文字是空的
#   ⇒ 正好能钉住「没有画面文字时必须回默认语序」这一半。
#
# 只用本机 `say`（macOS 自带，不联网、不出机器）。**平时不用重跑**；
# 源码留在这里是为了让「这张试纸是怎么来的」可复现，而不是一张来历不明的二进制。
#
# 用法：sh base/asr_audio_fixture.sh [输出路径]
set -e
OUT="${1:-tools/agent/__fixtures__/audio-sample.m4a}"
say -o "$OUT" --data-format=aac "Shouheng audio fixture for locale wiring."
ls -la "$OUT"

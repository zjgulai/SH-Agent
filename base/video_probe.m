// video_probe.m —— 用系统 AVFoundation 读视频：**元数据 + 关键帧**（零第三方依赖）
//
// 为什么要有它（2026-10-05）：委托方要求「发视频必须打通」。本机没有 ffmpeg，
// 但系统自带 AVFoundation —— 与 `base/ocr_vision.m`（Vision OCR）、`asr_speech.m`（Speech）
// 是同一条路子：**只用系统框架**。
//
// 它做什么：
//   ① 元数据：时长 / 分辨率 / 帧率 / 有没有音轨 / 音轨声道数与采样率；
//   ② 抽帧：按时长均匀取 N 帧（默认 8），每帧写成 PNG —— 交给 ocr_vision 读**画面上的字**
//      （硬字幕、贴片文案、品牌 logo、包装上的声明，广告视频里这些往往就是被审的对象）。
//
// ★ 它**不做**语音转写：那是 `asr_speech.m` 的事，而那条路卡在「本机没有离线语音模型」
//   （详见同日记录）。两件事分开报，不许混成一句「视频读不了」。
//
// ★ 静音视频 / 纯画面视频：`has_audio=false` 是**读数**，不是失败 —— 调用方据此决定
//   要不要去找语音那条路，而不是把「没有音轨」读成「转写失败」。
//
// 用法：video_probe <视频文件> [输出目录] [帧数]
// 输出：一行 JSON
#import <Foundation/Foundation.h>
#import <AVFoundation/AVFoundation.h>
#import <AppKit/AppKit.h>
#import <stdio.h>

static NSString *jsonEscape(NSString *s) {
  NSMutableString *o = [NSMutableString stringWithCapacity:s.length + 8];
  for (NSUInteger i = 0; i < s.length; i++) {
    unichar c = [s characterAtIndex:i];
    if (c == '\\') [o appendString:@"\\\\"];
    else if (c == '"') [o appendString:@"\\\""];
    else if (c == '\n' || c == '\r' || c == '\t') [o appendString:@" "];
    else if (c < 0x20) [o appendFormat:@"\\u%04x", c];
    else [o appendFormat:@"%C", c];
  }
  return o;
}

int main(int argc, const char **argv) {
  @autoreleasepool {
    if (argc < 2) { printf("{\"ok\":false,\"error\":\"usage: video_probe <file> [outdir] [frames]\"}\n"); return 2; }
    NSString *path = [NSString stringWithUTF8String:argv[1]];
    NSString *outDir = argc >= 3 ? [NSString stringWithUTF8String:argv[2]] : @"/tmp/shouheng-video";
    int wantFrames = argc >= 4 ? atoi(argv[3]) : 8;
    if (wantFrames < 1) wantFrames = 1;
    // ★ 2026-10-28：40 → 100（配合 JS 侧 VIDEO_MAX_FRAMES=60 的升级；
    //   旧值 40 导致请求 60 帧时被截成 40，产生「60→40 限制冲突」误差）。
    if (wantFrames > 100) wantFrames = 100;

    if (![[NSFileManager defaultManager] fileExistsAtPath:path]) {
      printf("{\"ok\":false,\"error\":\"not_found\"}\n"); return 2;
    }
    [[NSFileManager defaultManager] createDirectoryAtPath:outDir
                              withIntermediateDirectories:YES attributes:nil error:NULL];

    NSDate *t0 = [NSDate date];
    NSURL *url = [NSURL fileURLWithPath:path];
    AVURLAsset *asset = [AVURLAsset URLAssetWithURL:url options:nil];

    // 同步等待资源键（CLI 里比异步回调好读；失败就如实报，不假装时长 0）
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);
    [asset loadValuesAsynchronouslyForKeys:@[@"duration", @"tracks", @"playable"]
                          completionHandler:^{ dispatch_semaphore_signal(sem); }];
    dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(30 * NSEC_PER_SEC)));

    NSError *err = nil;
    if (![asset isPlayable]) {
      printf("{\"ok\":false,\"error\":\"not_playable\"}\n"); return 1;
    }
    CMTime dur = asset.duration;
    double durS = CMTIME_IS_NUMERIC(dur) ? CMTimeGetSeconds(dur) : 0.0;

    NSArray<AVAssetTrack *> *vtracks = [asset tracksWithMediaType:AVMediaTypeVideo];
    NSArray<AVAssetTrack *> *atracks = [asset tracksWithMediaType:AVMediaTypeAudio];
    double w = 0, h = 0, fps = 0;
    if (vtracks.count > 0) {
      AVAssetTrack *v = vtracks[0];
      w = v.naturalSize.width; h = v.naturalSize.height;
      fps = v.nominalFrameRate;
    }
    int audioCh = 0; double audioRate = 0;
    if (atracks.count > 0) {
      AVAssetTrack *a = atracks[0];
      NSArray *descs = a.formatDescriptions;
      if (descs.count > 0) {
        CMAudioFormatDescriptionRef d = (__bridge CMAudioFormatDescriptionRef)descs[0];
        const AudioStreamBasicDescription *asbd = CMAudioFormatDescriptionGetStreamBasicDescription(d);
        if (asbd) { audioCh = asbd->mChannelsPerFrame; audioRate = asbd->mSampleRate; }
      }
    }

    // ── 抽帧 ──
    NSMutableArray *frames = [NSMutableArray array];
    if (vtracks.count > 0 && durS > 0) {
      AVAssetImageGenerator *gen = [[AVAssetImageGenerator alloc] initWithAsset:asset];
      gen.appliesPreferredTrackTransform = YES;      // 竖屏视频不许躺倒
      gen.requestedTimeToleranceBefore = kCMTimeZero;
      gen.requestedTimeToleranceAfter  = kCMTimeZero;
      for (int i = 0; i < wantFrames; i++) {
        // ★ 2026-10-28：首尾策略替代「中点偏移避片尾」。
        //   旧策略：t = dur * (i+0.5) / n —— 最后一帧在 dur*(n-0.5)/n，片尾盲区 = dur/(2n)
        //     （181s/60帧 → 1.5s 片尾盲区；片尾声明、广告披露全在盲区里）。
        //   新策略：首帧固定 0.5s（避开片头黑帧），尾帧固定 dur-0.3s（覆盖片尾声明），
        //     中间帧在 [0.5s, dur-0.3s] 内均匀分布。
        //     若只有 1 帧则取中间；若 2 帧则取 0.5s 和 dur-0.3s。
        double t;
        if (wantFrames == 1) {
          t = durS * 0.5;
        } else if (i == 0) {
          t = 0.5;                           // 首帧：0.5s（避开纯黑 logo 帧）
        } else if (i == wantFrames - 1) {
          t = durS - 0.3;                    // 尾帧：距片尾 0.3s（覆盖片尾声明）
          if (t <= 0.5) t = durS * 0.5;     // 极短视频兜底
        } else {
          // 中间帧：在 [0.5s, dur-0.3s] 内均匀分布
          double span = (durS - 0.3) - 0.5;
          t = 0.5 + span * (double)(i) / (double)(wantFrames - 1);
        }
        CMTime at = CMTimeMakeWithSeconds(t, 600);
        NSError *ge = nil;
        CGImageRef img = [gen copyCGImageAtTime:at actualTime:NULL error:&ge];
        if (img == NULL) continue;
        NSBitmapImageRep *rep = [[NSBitmapImageRep alloc] initWithCGImage:img];
        NSData *png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
        CGImageRelease(img);
        if (png == nil) continue;
        NSString *fp = [outDir stringByAppendingPathComponent:
                        [NSString stringWithFormat:@"frame_%02d_%.2fs.png", i, t]];
        if ([png writeToFile:fp atomically:YES]) {
          [frames addObject:@{@"path": fp, @"t_s": @(t), @"bytes": @(png.length)}];
        }
      }
    }

    long ms = (long)(-[t0 timeIntervalSinceNow] * 1000.0);
    NSData *fj = [NSJSONSerialization dataWithJSONObject:frames options:0 error:&err];
    NSString *framesJson = fj ? [[NSString alloc] initWithData:fj encoding:NSUTF8StringEncoding] : @"[]";
    printf("{\"ok\":true,\"duration_s\":%.3f,\"w\":%.0f,\"h\":%.0f,\"fps\":%.2f,"
           "\"has_audio\":%s,\"audio_channels\":%d,\"audio_rate\":%.0f,"
           "\"n_frames\":%lu,\"out_dir\":\"%s\",\"frames\":%s,\"ms\":%ld}\n",
           durS, w, h, fps,
           atracks.count > 0 ? "true" : "false", audioCh, audioRate,
           (unsigned long)frames.count, [jsonEscape(outDir) UTF8String],
           [framesJson UTF8String], ms);
    return 0;
  }
}

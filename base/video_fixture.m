// video_fixture.m —— 生成一张**视频试纸**（几 KB 的 mp4），给视频那条路当自检用
//
// 为什么要有它（2026-10-05）：`vision.mjs` 有 `ocr-sample.png`、`asr.mjs` 有
// `asr-sample.wav`，视频这条路要是没有试纸，「视频读不了」就只能在群里被人发现。
// 本机没有 ffmpeg，但 AVFoundation 也能**写**：`AVAssetWriter` + `AVAssetWriterInput`
// + `AVAssetWriterInputPixelBufferAdaptor`，画面用 AppKit 往位图上下文里画字。
//
// 它只做一件事：写一段 2 秒、640×360、10fps 的 mp4，每帧中间画同一行大字
// （`SHOUHENG VIDEO FIXTURE`）和一行帧号（`FRAME 3/20`）。
// 于是一条断言就能成立：**抽帧 → OCR 必须读得出那行大字**。
//
// ★ 试纸是**本仓资产**（`tools/agent/__fixtures__/video-sample.mp4`），
//   平时不需要重跑这个工具；它的源码留着是为了让「试纸是怎么来的」是可复现的，
//   而不是一张来历不明的二进制。
//
// 用法：video_fixture <输出mp4> [秒数] [fps]
#import <Foundation/Foundation.h>
#import <AVFoundation/AVFoundation.h>
#import <AppKit/AppKit.h>
#import <CoreVideo/CoreVideo.h>
#import <stdio.h>

static const int W = 640;
static const int H = 360;

int main(int argc, const char **argv) {
  @autoreleasepool {
    if (argc < 2) { printf("{\"ok\":false,\"error\":\"usage: video_fixture <out.mp4> [seconds] [fps]\"}\n"); return 2; }
    NSString *out = [NSString stringWithUTF8String:argv[1]];
    double seconds = argc >= 3 ? atof(argv[2]) : 2.0;
    int fps = argc >= 4 ? atoi(argv[3]) : 10;
    if (seconds <= 0) seconds = 2.0;
    if (fps <= 0) fps = 10;

    [[NSFileManager defaultManager] removeItemAtPath:out error:NULL];
    NSError *err = nil;
    AVAssetWriter *w = [AVAssetWriter assetWriterWithURL:[NSURL fileURLWithPath:out]
                                                fileType:AVFileTypeMPEG4 error:&err];
    if (w == nil) { printf("{\"ok\":false,\"error\":\"writer_init_failed\"}\n"); return 1; }

    NSDictionary *vset = @{ AVVideoCodecKey: AVVideoCodecTypeH264,
                            AVVideoWidthKey: @(W), AVVideoHeightKey: @(H) };
    AVAssetWriterInput *in = [AVAssetWriterInput assetWriterInputWithMediaType:AVMediaTypeVideo
                                                               outputSettings:vset];
    in.expectsMediaDataInRealTime = NO;
    NSDictionary *attrs = @{ (id)kCVPixelBufferPixelFormatTypeKey: @(kCVPixelFormatType_32ARGB),
                             (id)kCVPixelBufferWidthKey: @(W),
                             (id)kCVPixelBufferHeightKey: @(H) };
    AVAssetWriterInputPixelBufferAdaptor *ad =
      [AVAssetWriterInputPixelBufferAdaptor assetWriterInputPixelBufferAdaptorWithAssetWriterInput:in
                                                                       sourcePixelBufferAttributes:attrs];
    if (![w canAddInput:in]) { printf("{\"ok\":false,\"error\":\"cannot_add_input\"}\n"); return 1; }
    [w addInput:in];
    if (![w startWriting]) { printf("{\"ok\":false,\"error\":\"start_writing_failed\"}\n"); return 1; }
    [w startSessionAtSourceTime:kCMTimeZero];

    int total = (int)(seconds * fps);
    NSDictionary *big = @{ NSFontAttributeName: [NSFont boldSystemFontOfSize:40],
                           NSForegroundColorAttributeName: [NSColor blackColor] };
    NSDictionary *small = @{ NSFontAttributeName: [NSFont boldSystemFontOfSize:28],
                             NSForegroundColorAttributeName: [NSColor darkGrayColor] };
    int written = 0;
    for (int i = 0; i < total; i++) {
      while (!in.isReadyForMoreMediaData) usleep(5000);
      CVPixelBufferRef pb = NULL;
      if (CVPixelBufferPoolCreatePixelBuffer(NULL, ad.pixelBufferPool, &pb) != kCVReturnSuccess || pb == NULL) break;
      CVPixelBufferLockBaseAddress(pb, 0);
      CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
      CGContextRef ctx = CGBitmapContextCreate(CVPixelBufferGetBaseAddress(pb), W, H, 8,
                                               CVPixelBufferGetBytesPerRow(pb), cs,
                                               kCGImageAlphaPremultipliedFirst | kCGBitmapByteOrder32Big);
      CGColorSpaceRelease(cs);
      if (ctx != NULL) {
        NSGraphicsContext *gc = [NSGraphicsContext graphicsContextWithCGContext:ctx flipped:NO];
        [NSGraphicsContext saveGraphicsState];
        [NSGraphicsContext setCurrentContext:gc];
        [[NSColor whiteColor] setFill];
        NSRectFill(NSMakeRect(0, 0, W, H));
        [[NSString stringWithFormat:@"SHOUHENG VIDEO FIXTURE"] drawInRect:NSMakeRect(20, 200, W - 40, 60)
                                                               withAttributes:big];
        [[NSString stringWithFormat:@"FRAME %d/%d", i + 1, total] drawInRect:NSMakeRect(20, 140, W - 40, 44)
                                                                withAttributes:small];
        [NSGraphicsContext restoreGraphicsState];
        CGContextRelease(ctx);
      }
      CVPixelBufferUnlockBaseAddress(pb, 0);
      BOOL ok = [ad appendPixelBuffer:pb withPresentationTime:CMTimeMake(i, fps)];
      CVPixelBufferRelease(pb);
      if (!ok) break;
      written++;
    }
    [in markAsFinished];
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);
    [w finishWritingWithCompletionHandler:^{ dispatch_semaphore_signal(sem); }];
    dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(60 * NSEC_PER_SEC)));

    long bytes = (long)[[[NSFileManager defaultManager] attributesOfItemAtPath:out error:NULL] fileSize];
    printf("{\"ok\":%s,\"path\":\"%s\",\"frames\":%d,\"fps\":%d,\"w\":%d,\"h\":%d,\"bytes\":%ld}\n",
           (written > 0 && bytes > 0) ? "true" : "false", [out UTF8String], written, fps, W, H, bytes);
    return (written > 0 && bytes > 0) ? 0 : 1;
  }
}

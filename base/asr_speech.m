// asr_speech.m —— 用系统 Speech.framework 做**本机**语音转写（零第三方依赖）
//
// 为什么要有它（2026-10-05）：委托方要求「发视频必须打通」。视频要能审，第一步是
// **把声音变成字** —— 本机没有 ffmpeg、没有任何 ASR 包（whisper/faster-whisper/torch 全无），
// 但系统自带 `Speech.framework`。与 `base/ocr_vision.m` 是同一条路子：
// **只用系统框架，不装东西、不联网**。
//
// ★ `requiresOnDeviceRecognition = YES`：只走**本机识别**。这既是红线要求（内容不出机器），
//   也避免把音频发到 Apple 的服务器。代价是语言模型必须先在本机装好
//   （macOS 按需下载，实测 zh-CN / en-US 都已 `Installed = 1`），
//   装不上就报 `recognizer_unavailable`。`ondevice_supported` 是这条的读数，随结果一起回。
//
// ★ 权限（TCC）：语音识别是隐私服务。**这台机器上踩满了坑，逐条记下来**：
//   ① 裸 CLI 一调就 `Abort trap: 6`（`namespace:TCC … without a usage description`）
//      —— 必须打成 .app，`Info.plist` 里写 `NSSpeechRecognitionUsageDescription`，
//      并且**用 `open -n` 启动**（LaunchServices 当发起者，用途说明才算在这个 app 头上）。
//   ② `LSBackgroundOnly=true` 的应用**弹不出授权对话框**，`requestAuthorization` 的回调
//      **永远不来** —— 进程一直等到超时，报出来却像「识别太慢/模型没装」。改用 `LSUIElement`。
//   ③ TCC 对**临时签名**按 cdhash 记授权：重编一次二进制，旧授权对不上，
//      日志里是 `Failed to match existing code requirement for subject local.shouheng.asr`
//      紧跟 `AUTHREQ_PROMPTING`，而那时进程会一直挂着等一个没弹出来的框。
//      所以生产上**只在二进制缺失时才编译**（见 tools/agent/asr.mjs）。
//
// ★ 「安静地回空」一共踩到三处，每一处的读数都留着 —— 它们**报出来都是 `text:""`**：
//   ① `shouldReportPartialResults = NO` —— 实测会**立刻**回一个 final 但**空**的结果
//      （244~539ms），与「这段音频里没人说话」长得一模一样。
//   ② 识别器建在授权回调**里面**会被 ARC 提前释放、识别随之取消，同样回空。
//      ★ ② 只在 zh-CN 上稳定复现、en-US 一直好使 ——
//      **「一个语言能用」不给另一个语言作证**（AGENTS.md §2.4.1 第 4 行）。
//   ③ **跨线程读结果**：结果回调不在主线程上，主线程在 run loop 里空转，
//      于是「回调里写进全局缓冲区、主线程再读出来」这一步读到的是**没写进去的样子**。
//      实测的读数是 `callbacks:19, partial_max:19, final_seen:1` 而 `text:""` ——
//      也就是**识别一直在正常出字，是我读它的方式错了**。
//      修法：**结果在回调里就地成形、就地落盘**，主线程只等一个 `done`。
//      这条最值得记：前两条是「识别没跑」，这一条是「识别跑对了、我读错了」，
//      而三者在群里表现完全一样。
//
// 用法：shouheng-asr <音频或视频文件> [locale] [输出JSON路径]
//   生产走 `open -n ShouhengASR.app --args …` —— 那条路拿不到 stdout，
//   所以第三个参数是**必给**的结果落地文件。
// 输出：一行 JSON {ok, text, ms, locale, on_device, ondevice_supported, callbacks, partial_max}
#import <Foundation/Foundation.h>
#import <Speech/Speech.h>
#import <stdio.h>
#import <string.h>

static NSString *jsonEscape(NSString *src) {
  if (src == nil) src = @"";
  NSMutableString *o = [NSMutableString stringWithCapacity:src.length + 8];
  for (NSUInteger i = 0; i < src.length; i++) {
    unichar c = [src characterAtIndex:i];
    if (c == '\\') [o appendString:@"\\\\"];
    else if (c == '"') [o appendString:@"\\\""];
    else if (c == '\n' || c == '\r' || c == '\t') [o appendString:@" "];
    else if (c < 0x20) [o appendFormat:@"\\u%04x", c];
    else [o appendFormat:@"%C", c];
  }
  return o;
}

/** 把一行 JSON 同时落到结果文件与 stdout。**先落文件** —— 调用方在等这个文件。 */
static void emit(NSString *jsonLine, NSString *outPath) {
  if (outPath) [jsonLine writeToFile:outPath atomically:YES encoding:NSUTF8StringEncoding error:NULL];
  printf("%s\n", [jsonLine UTF8String]);
  fflush(stdout);
}

int main(int argc, const char **argv) {
  @autoreleasepool {
    if (argc < 2) {
      printf("{\"ok\":false,\"error\":\"usage: shouheng-asr <file> [locale] [out.json]\"}\n");
      return 2;
    }
    NSString *path = [NSString stringWithUTF8String:argv[1]];
    NSString *loc  = argc >= 3 ? [NSString stringWithUTF8String:argv[2]] : @"zh-CN";
    NSString *outPath = (argc >= 4 && strlen(argv[3]) > 0)
                      ? [NSString stringWithUTF8String:argv[3]] : nil;
    if (![[NSFileManager defaultManager] fileExistsAtPath:path]) {
      emit(@"{\"ok\":false,\"error\":\"not_found\"}", outPath);
      return 2;
    }

    NSDate *t0 = [NSDate date];

    // ★ 识别器建在 **main 作用域**（见文件头 ②）
    SFSpeechRecognizer *rec = [[SFSpeechRecognizer alloc]
      initWithLocale:[NSLocale localeWithLocaleIdentifier:loc]];
    if (rec == nil) {
      emit([NSString stringWithFormat:
        @"{\"ok\":false,\"error\":\"recognizer_unavailable(locale)\",\"locale\":\"%@\"}",
        jsonEscape(loc)], outPath);
      return 1;
    }
    BOOL onDeviceSupported = [rec supportsOnDeviceRecognition];
    BOOL available = [rec isAvailable];

    __block BOOL done = NO;
    __block BOOL emitted = NO;
    __block int cbCount = 0;
    __block int partialMax = 0;
    __block NSString *lastNonEmpty = nil;   // 兜底：final 若是空的，用最后一段非空部分结果

    // ★ 结果**在回调里就地成形、就地落盘**（见文件头 ③）—— 主线程不碰这段文字。
    void (^finish)(NSString *, NSString *, int, int) =
      ^(NSString *text, NSString *errText, int cbs, int pmax) {
        long ms = (long)(-[t0 timeIntervalSinceNow] * 1000.0);
        NSString *line;
        if (errText != nil) {
          line = [NSString stringWithFormat:
            @"{\"ok\":false,\"error\":\"%@\",\"ms\":%ld,\"locale\":\"%@\",\"ondevice_supported\":%@}",
            jsonEscape(errText), ms, jsonEscape(loc), onDeviceSupported ? @"true" : @"false"];
        } else {
          line = [NSString stringWithFormat:
            @"{\"ok\":true,\"text\":\"%@\",\"chars\":%lu,\"ms\":%ld,\"locale\":\"%@\","
             "\"on_device\":true,\"ondevice_supported\":%@,\"callbacks\":%d,\"partial_max\":%d}",
            jsonEscape(text), (unsigned long)(text ? text.length : 0), ms, jsonEscape(loc),
            onDeviceSupported ? @"true" : @"false", cbs, pmax];
        }
        emit(line, outPath);
        emitted = YES;
        done = YES;
    };

    [SFSpeechRecognizer requestAuthorization:^(SFSpeechRecognizerAuthorizationStatus st) {
      if (st != SFSpeechRecognizerAuthorizationStatusAuthorized) {
        finish(nil, [NSString stringWithFormat:@"not_authorized(status=%ld)", (long)st], 0, 0);
        return;
      }
      if (!available) { finish(nil, @"recognizer_unavailable(not_available)", 0, 0); return; }

      SFSpeechURLRecognitionRequest *req =
        [[SFSpeechURLRecognitionRequest alloc] initWithURL:[NSURL fileURLWithPath:path]];
      req.shouldReportPartialResults = YES;      // ★ 见文件头 ①
      req.requiresOnDeviceRecognition = YES;     // ★ 本机识别，不出网
      [rec recognitionTaskWithRequest:req
                        resultHandler:^(SFSpeechRecognitionResult *res, NSError *e) {
        if (e != nil) {
          finish(nil, [NSString stringWithFormat:@"%@(%ld)", [e localizedDescription], (long)e.code], cbCount, partialMax);
          return;
        }
        if (res == nil) return;
        cbCount++;
        NSString *s = [res.bestTranscription formattedString] ?: @"";
        if ((int)s.length > partialMax) partialMax = (int)s.length;
        if (s.length > 0) lastNonEmpty = s;
        if (res.isFinal) {
          NSString *t = (s.length > 0) ? s : lastNonEmpty;   // ★ 兜底见文件头 ①
          finish(t, nil, cbCount, partialMax);
        }
      }];
    }];

    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:120];
    while (!done && [deadline timeIntervalSinceNow] > 0) {
      [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode
                               beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
    }
    if (!done) {
      long ms = (long)(-[t0 timeIntervalSinceNow] * 1000.0);
      // 超时这条路要能分开报两件事：**回调一次都没来**（多半是 TCC 在等一个弹不出来的框，
      // 见文件头 ②）vs **回调来了但迟迟不 final**（音频太长）。两者引出的下一步不同。
      emit([NSString stringWithFormat:
        @"{\"ok\":false,\"error\":\"timeout\",\"ms\":%ld,\"callbacks\":%d,\"partial_max\":%d}",
        ms, cbCount, partialMax], outPath);
      return 1;
    }
    return 0;
  }
}

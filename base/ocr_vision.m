#import <Foundation/Foundation.h>
#import <Vision/Vision.h>
#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <stdio.h>
#import <stdlib.h>
#import <string.h>

// ocr_vision.m —— 直连系统 Vision.framework 的 OCR CLI
//
// ★ 2026-10-27 升级：
//   1. 注入 customWords（Momcozy / Eufy / S1 Pro / Wellness 1 / flange 等品牌与行业专有词），
//      消除系统词典把模糊边缘强行纠偏成 Momeozy / Euiy / ilange / sol / cach；
//   2. 低分辨率图像（短边 < 720px，如 576×1024 压缩视频帧）自动 2x 高质量插值放大后再送 Vision；
//   3. 双路融合（拉丁高精度 pass + 中英混合 pass）：苹果 Vision 在 zh-Hans 居首时才能读出汉字，
//      但会吃掉德/法/西语变音符（Für→Fur）并降低拉丁小字精度（wearable→wearab Le，c=0.3）。
//      因此当语言表同时含 zh 与拉丁语种时，先跑拉丁优先 pass（en-US, de-DE, fr-FR, es-ES），
//      再补跑一次 zh-Hans 捞取同位置的汉字行或更高置信度行，兼顾中英混排与欧美小语种 1.0 置信度！

static NSString *jsonEscape(NSString *s) {
  NSMutableString *o = [NSMutableString stringWithCapacity:s.length + 8];
  for (NSUInteger i = 0; i < s.length; i++) {
    unichar c = [s characterAtIndex:i];
    if (c == '\\') [o appendString:@"\\\\"];
    else if (c == '"') [o appendString:@"\\\""];
    else if (c == '\n') [o appendString:@" "];
    else if (c == '\r') [o appendString:@" "];
    else if (c == '\t') [o appendString:@" "];
    else if (c < 0x20) [o appendFormat:@"\\u%04x", c];
    else [o appendFormat:@"%C", c];
  }
  return o;
}

static NSArray<NSString *> *brandCustomWords(void) {
  static NSArray<NSString *> *words = nil;
  if (!words) {
    words = @[
      @"Momcozy", @"MOMCOZY", @"Momcozy Wellness 1", @"Wellness 1",
      @"Eufy", @"Eufy S1 Pro", @"S1 Pro", @"S2 Pro", @"M5", @"M6", @"M9", @"S12 Pro", @"V1 Pro", @"V2 Pro",
      @"DoubleFit", @"SoftPulse", @"flange", @"flanges", @"washable", @"session", @"letdown",
      @"Bereit", @"Für", @"Superkräfte", @"Nachttisch", @"Ruhigere", @"Nächte"
    ];
  }
  return words;
}

static BOOL hasCjkChar(NSString *s) {
  for (NSUInteger i = 0; i < s.length; i++) {
    unichar c = [s characterAtIndex:i];
    if (c >= 0x4E00 && c <= 0x9FFF) return YES;
  }
  return NO;
}

static CGImageRef upscaleIfLowRes(CGImageRef cg, size_t origW, size_t origH) {
  size_t minSide = origW < origH ? origW : origH;
  if (minSide <= 2 || minSide >= 720) return NULL;
  size_t newW = origW * 2;
  size_t newH = origH * 2;
  CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
  if (!cs) return NULL;
  CGContextRef ctx = CGBitmapContextCreate(NULL, newW, newH, 8, newW * 4, cs,
                                           kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);
  CGColorSpaceRelease(cs);
  if (!ctx) return NULL;
  CGContextSetInterpolationQuality(ctx, kCGInterpolationHigh);
  CGContextDrawImage(ctx, CGRectMake(0, 0, newW, newH), cg);
  CGImageRef out = CGBitmapContextCreateImage(ctx);
  CGContextRelease(ctx);
  return out;
}

static NSArray<VNRecognizedTextObservation *> *runPass(CGImageRef cg, NSArray *langs, NSError **outErr) {
  VNRecognizeTextRequest *req = [[VNRecognizeTextRequest alloc] init];
  req.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
  req.recognitionLanguages = langs;
  req.usesLanguageCorrection = YES;
  req.customWords = brandCustomWords();
  VNImageRequestHandler *h = [[VNImageRequestHandler alloc] initWithCGImage:cg options:@{}];
  if (![h performRequests:@[req] error:outErr]) return nil;
  return req.results ?: @[];
}

static NSString *ocrOne(NSString *path, NSArray *langs) {
  NSImage *img = [[NSImage alloc] initWithContentsOfFile:path];
  if (!img) return @"{\"ok\":false,\"error\":\"cannot_load_image\"}";
  CGImageRef cg = [img CGImageForProposedRect:NULL context:nil hints:nil];
  if (!cg) return @"{\"ok\":false,\"error\":\"no_cgimage\"}";
  size_t origW = CGImageGetWidth(cg);
  size_t origH = CGImageGetHeight(cg);
  CGImageRef upCg = upscaleIfLowRes(cg, origW, origH);
  CGImageRef targetCg = upCg ? upCg : cg;

  NSDate *t0 = [NSDate date];
  NSError *err = nil;
  NSArray<VNRecognizedTextObservation *> *baseObs = runPass(targetCg, langs, &err);
  if (!baseObs) {
    if (upCg) CGImageRelease(upCg);
    return [NSString stringWithFormat:
      @"{\"ok\":false,\"error\":\"perform_failed\",\"w\":%zu,\"h\":%zu}",
      origW, origH];
  }

  // 若首轮是 zh-Hans 优先且包含拉丁语种，补跑一次纯拉丁语种 pass 替换被切碎或吃掉变音符的拉丁行
  NSMutableArray<NSString *> *latinLangs = [NSMutableArray array];
  for (NSString *l in langs) {
    if (![l hasPrefix:@"zh"]) [latinLangs addObject:l];
  }
  NSArray<VNRecognizedTextObservation *> *latinObs = nil;
  if (latinLangs.count > 0 && [langs.firstObject hasPrefix:@"zh"]) {
    NSError *err2 = nil;
    latinObs = runPass(targetCg, latinLangs, &err2);
  }
  if (upCg) CGImageRelease(upCg);

  long ms = (long)(-[t0 timeIntervalSinceNow] * 1000.0);
  NSMutableArray *items = [NSMutableArray array];
  for (VNRecognizedTextObservation *obs in baseObs) {
    VNRecognizedText *top = [[obs topCandidates:1] firstObject];
    if (!top) continue;
    NSString *bestStr = top.string;
    float bestConf = top.confidence;
    CGRect bb = obs.boundingBox;
    // 对不含中文的行，按最大 IoU / 最小中心点距离匹配唯一未使用的拉丁 pass 行
    if (latinObs && !hasCjkChar(bestStr)) {
      static NSMutableSet *usedLatin = nil;
      if (!usedLatin) usedLatin = [NSMutableSet set];
      if (obs == baseObs.firstObject) [usedLatin removeAllObjects];
      double bestDist = 1e9;
      VNRecognizedTextObservation *bestLObs = nil;
      VNRecognizedText *bestLTop = nil;
      for (VNRecognizedTextObservation *lobs in latinObs) {
        if ([usedLatin containsObject:lobs]) continue;
        CGRect lbb = lobs.boundingBox;
        double dy = fabs((lbb.origin.y + lbb.size.height * 0.5) - (bb.origin.y + bb.size.height * 0.5));
        double dx = fabs(lbb.origin.x - bb.origin.x);
        if (dy < 0.018 && dx < 0.06) {
          double dist = dy * 4.0 + dx;
          if (dist < bestDist) {
            VNRecognizedText *ltop = [[lobs topCandidates:1] firstObject];
            if (ltop && ltop.confidence >= bestConf) {
              bestDist = dist;
              bestLObs = lobs;
              bestLTop = ltop;
            }
          }
        }
      }
      if (bestLObs && bestLTop) {
        [usedLatin addObject:bestLObs];
        bestStr = bestLTop.string;
        bestConf = bestLTop.confidence;
        bb = bestLObs.boundingBox;
      }
    }
    [items addObject:[NSString stringWithFormat:
      @"{\"t\":\"%@\",\"c\":%.3f,\"x\":%.4f,\"y\":%.4f,\"w\":%.4f,\"h\":%.4f}",
      jsonEscape(bestStr), bestConf, bb.origin.x, bb.origin.y,
      bb.size.width, bb.size.height]];
  }
  return [NSString stringWithFormat:
    @"{\"ok\":true,\"w\":%zu,\"h\":%zu,\"ms\":%ld,\"n\":%lu,\"lines\":[%@]}",
    origW, origH, ms, (unsigned long)items.count,
    [items componentsJoinedByString:@","]];
}

static void emit(NSString *s) {
  fputs([s UTF8String], stdout);
  fputc('\n', stdout);
  fflush(stdout);
}

int main(int argc, const char** argv) {
  @autoreleasepool {
    BOOL serve = (argc >= 2 && strcmp(argv[1], "--serve") == 0);
    NSMutableArray *langs = [NSMutableArray array];
    for (int i = 2; i < argc; i++) {
      [langs addObject:[NSString stringWithUTF8String:argv[i]]];
    }
    if (langs.count == 0) { [langs addObject:@"zh-Hans"]; [langs addObject:@"en-US"]; }

    if (!serve) {
      if (argc < 2) { fprintf(stderr, "用法: ocr <图片> [lang...]\n  或: ocr --serve [lang...]\n"); return 2; }
      emit(ocrOne([NSString stringWithUTF8String:argv[1]], langs));
      return 0;
    }

    char *line = NULL;
    size_t cap = 0;
    ssize_t n;
    while ((n = getline(&line, &cap, stdin)) != -1) {
      while (n > 0 && (line[n-1] == '\n' || line[n-1] == '\r')) line[--n] = '\0';
      if (n == 0) continue;
      if (strcmp(line, "__quit__") == 0) break;
      @autoreleasepool {
        NSString *p = [NSString stringWithUTF8String:line];
        if (!p) { emit(@"{\"ok\":false,\"error\":\"bad_path_encoding\"}"); continue; }
        emit(ocrOne(p, langs));
      }
    }
    free(line);
  }
  return 0;
}

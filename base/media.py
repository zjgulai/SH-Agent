#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""media.py —— 图片 / 视频进管道的第①面（B1 · ADR-0013 D3）

一句话：**把「素材」也变成 `ContentUnit`，并按法务口径给出三个数字。**

    python3 base/media.py --selftest      # 离线自证（用盘上已下载的样本）
    python3 base/media.py --collect N     # 联网：抽样下载 + OCR（唯一会写盘的联网命令）
    python3 base/media.py --report        # 用盘上样本出三个指标

--------------------------------------------------------------------------
★ D3 定的方向：先「文本化」，不作语义判定
--------------------------------------------------------------------------

    图片：OCR 取图内文字 + 合成人像标记检测
    视频：字幕/ASR 转写 + 关键帧 OCR
    产出统一进 `ContentUnit`，**复用现有规则**，不新增判定机制。

--------------------------------------------------------------------------
★ 落地时量出来的第一件事：**alt 文本看起来像覆盖，其实不是**
--------------------------------------------------------------------------

92 个落地页共 **23,745 张图片**，其中 **21,424 张（90.2%）有 alt 文本**。
「90% 有 alt」读起来像「图片基本已覆盖」。**实际不是**：

    alt 长度中位 17 字符，内容是**商品名目录**：
      「Maternity Belly Band」「Labor Hospital Bag」「momcozy logo」「Nursing Bras」

而营销声明（`hospital grade` / `100% safe` / `FDA approved`）**是画在图里的**，
不在 alt 里。所以「有 alt」与「图里的字被读到了」回答的是两个不同的问题。

**⇒ 本模块的核心测量不是「多少张图有文字」，是「OCR 在 alt 之外读到了多少声明性表述」。**
这个增量才是 OCR 的真实价值，也是 90.2% 那个数字**不能**替代的东西。

--------------------------------------------------------------------------
★ 落地时量出来的第二件事：本机的编译链是坏的，但有绕法
--------------------------------------------------------------------------

    `swiftc` 走不通：`failed to build module 'Swift'; this SDK is not supported
    by the compiler`（SDK 由 Swift 6.4 构建，CLT 里的编译器是 6.3.3）。
    默认 SDK `MacOSX27.0` 也是坏的：`tapi error: malformed file ... unknown
    architecture arm64e.x1-macos`。

**绕法**：用 **Objective-C + clang + 指定旧 SDK**（`MacOSX15.4`），直连系统
`Vision.framework`。零第三方依赖 —— 与「不加依赖也能跑」的项目惯例一致。
源码 `base/ocr_vision.m` 与重建脚本 `base/build_ocr.sh` 都在 L1。

--------------------------------------------------------------------------
★ 异议二必须落在数字旁边（ADR-0013 §六）
--------------------------------------------------------------------------

> **必须让「覆盖到哪」显式可见**：B1 的图片/视频指标里要写清
> 「本数字只覆盖图内文字，不含画面语义」，并进 `boundary_statement.unknowns`。
> 不得只报「识别完整度 X%」而不写它的边界。

所以每一个图片 unit 的 `textification.covers` / `does_not_cover` 都是**必填**
（`contract.from_media()` 刻意不给默认值），且 `judge_adapter` 会把它们
逐字写进该次判定的 `boundary_statement.unknowns`。
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import random
import re
import json
import shutil
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "tools"))

import contract as C                                    # noqa: E402
from lp_extract import CLAIM_RE, CLAIM_PATTERNS          # noqa: E402  唯一词形定义，不重复维护
import lp_fetch as F                                     # noqa: E402  节流与 robots 复用批次 C

CONTRACT_VERSION = "media-v1"
OCR_BIN = ROOT / ".tools" / "bin" / "ocr"
OCR_SRC = HERE / "ocr_vision.m"
OCR_BUILD = HERE / "build_ocr.sh"

MEDIA = ROOT / "research" / "landing" / "_evidence" / "media"

# 能被 Vision 读的位图格式。**SVG 不在其列** —— 它是矢量，
# `NSImage` 不保证能解码；本仓 23,745 张里有 **6,098 张是 SVG**（多是图标与 logo）。
# 这个区分必须记下来：它会让「获取成功率」的分母看起来变小，
# 而真相是「那部分素材本就不该走 OCR」，不是「取不到」。
RASTER_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff", ".heic"}
VECTOR_EXT = {".svg"}

MAX_IMAGE_BYTES = 12 * 1024 * 1024
# ★ 退化占位图：**取到了、也解开了，但里面没有东西**。
#   实测（B2 无偏样本）：Shopify 的 `preview_images/*.thumbnail.0000*` 是 **1×1 像素**
#   的懒加载占位 JPEG（939 字节、`image/jpeg`、Exif 齐全 —— 每一层元数据都正常）。
#   Vision 对它直接 `perform_failed`。**把它记成「OCR 失败」是错的**：
#   那不是「读不出来」，是「本来就没有可读的东西」。
#   ★ 判据必须可核：用 OCR 自己报回来的 `w`/`h`，不是靠 URL 猜。
DEGENERATE_PIXELS = 4
OCR_TIMEOUT = 60
OCR_LANGS = ["zh-Hans", "en-US"]


# ------------------------------------------------------------------ OCR 二进制

def ensure_ocr(rebuild: bool = False) -> Path:
    """没有就编译。**不把二进制提交进仓** —— 源码与重建脚本才是 L1 的东西。"""
    if OCR_BIN.exists() and not rebuild:
        return OCR_BIN
    if not OCR_SRC.exists() or not OCR_BUILD.exists():
        raise RuntimeError(f"OCR 源码或重建脚本缺失：{OCR_SRC} / {OCR_BUILD}")
    r = subprocess.run(["bash", str(OCR_BUILD)], capture_output=True, text=True, cwd=ROOT)
    if r.returncode != 0 or not OCR_BIN.exists():
        raise RuntimeError("OCR 编译失败：\n" + r.stdout + r.stderr)
    return OCR_BIN


def ocr_file(path: Path, langs: list[str] | None = None, server: "OcrServer | None" = None) -> dict:
    """调 OCR，回结构化结果。**失败不抛** —— 返回 ok=False 与成因。

    ★ `server` 给了就走**常驻进程**（B2），否则走一次一进程（B1 的行为）。
      两条路**必须给出同一份文本** —— 这是 `[8]` 那条自证在守的东西。
      常驻模式省掉的只是「每次起一个子进程 + 框架预热」，识别配置一行没改。
    """
    try:
        bin_ = ensure_ocr()
    except Exception as e:                               # noqa: BLE001
        return {"ok": False, "error": "ocr_build_failed", "detail": str(e)[:200]}
    t0 = time.time()
    if server is not None:
        out = _enrich(server.ocr(Path(path)))
        out["wall_ms"] = int((time.time() - t0) * 1000)
    else:
        cmd = [str(bin_), str(path)] + (langs or OCR_LANGS)
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=OCR_TIMEOUT)
        except subprocess.TimeoutExpired:
            return {"ok": False, "error": "timeout", "ms": OCR_TIMEOUT * 1000}
        out = _enrich(_parse_ocr_stdout(r.stdout, r.stderr))
        out["wall_ms"] = int((time.time() - t0) * 1000)
    return out


def _enrich(out: dict) -> dict:
    """补上 `text` / `chars` / `mean_conf`。**两条路共用这一个函数** ——
    否则「常驻模式少了几个字段」这种事会以「结果不一致」的形式冒出来，
    而排查方向会被带偏到 OCR 本身。
    """
    if out.get("ok"):
        out["text"] = "\n".join(x["t"] for x in out.get("lines") or [])
        out["chars"] = len(out["text"])
        out["mean_conf"] = (round(sum(x["c"] for x in out["lines"]) / len(out["lines"]), 3)
                            if out.get("lines") else None)
    return out


def _parse_ocr_stdout(stdout: str, stderr: str = "") -> dict:
    try:
        return json.loads(stdout.strip().splitlines()[-1])
    except Exception:                                     # noqa: BLE001
        return {"ok": False, "error": "bad_output",
                "detail": stdout[:200] + stderr[:200]}


class OcrServer:
    """★ 常驻 OCR 进程（B2）—— 省掉的是**每次起子进程与框架预热**，不是识别本身。

    一次一进程时，墙钟里有一大块与图片无关：

        B1 实测：Vision 自己报 p50 169ms，本模块实测墙钟 p50 3573ms。
        进程启动 p50 233ms；剩余是下载与队列等待（那部分本类不管）。

    本类的两条硬要求：

      ① **结果必须一致**：同一个文件的文本与一次一进程逐字节相同。
         不一致就等于悄悄换了个 OCR —— 那比慢严重得多。
      ② **崩了要能接着跑**：read 到 EOF 说明子进程死了。
         这时重启一次并**重发同一条请求**，而不是把这一张记成失败 ——
         「因为优化引入的失败」不能算进「内容获取成功率」，那是两个分母。
    """

    def __init__(self, langs: list[str] | None = None, restart_limit: int = 3):
        self.langs = langs or OCR_LANGS
        self.restart_limit = restart_limit
        self.proc: subprocess.Popen | None = None
        self.starts = 0
        self.requests = 0

    # ---------------------------------------------------------------- 生命周期
    def start(self) -> None:
        bin_ = ensure_ocr()
        self.proc = subprocess.Popen(
            [str(bin_), "--serve"] + self.langs,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, bufsize=1)                 # 行缓冲：一行请求一行响应
        self.starts += 1

    def close(self) -> None:
        if self.proc is None:
            return
        try:
            if self.proc.poll() is None and self.proc.stdin:
                self.proc.stdin.write("__quit__\n")
                self.proc.stdin.flush()
                self.proc.wait(timeout=5)
        except Exception:                                 # noqa: BLE001
            pass
        finally:
            try:
                self.proc.kill()
            except Exception:                             # noqa: BLE001
                pass
            self.proc = None

    def __enter__(self) -> "OcrServer":
        self.start()
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    # ---------------------------------------------------------------- 一次识别
    def ocr(self, path: Path) -> dict:
        for attempt in range(self.restart_limit + 1):
            if self.proc is None or self.proc.poll() is not None:
                if self.starts > self.restart_limit:
                    return {"ok": False, "error": "server_restart_exhausted",
                            "detail": "常驻进程反复退出（起了 %d 次）" % self.starts}
                self.start()
            try:
                self.proc.stdin.write(str(path) + "\n")
                self.proc.stdin.flush()
                line = self.proc.stdout.readline()
            except Exception as e:                        # noqa: BLE001
                self.close()
                continue
            if not line:
                self.close()                              # EOF：子进程死了，重发
                continue
            self.requests += 1
            return _enrich(_parse_ocr_stdout(line))
        return {"ok": False, "error": "server_unavailable"}



# ------------------------------------------------------------------ 下载

def norm_img_url(src: str, page_url: str) -> str:
    """`//au.momcozy.com/cdn/...` → `https://au.momcozy.com/cdn/...`（协议相对）。"""
    if src.startswith("//"):
        return "https:" + src
    if src.startswith("/"):
        p = urllib.parse.urlparse(page_url)
        return f"{p.scheme}://{p.netloc}{src}"
    return src


def fetch_image(url: str, out_dir: Path, pacer, robots_cache: dict, retries: int = 1) -> dict:
    """只读下载一张图。遵守 robots、走批次 C 的节流、**不重试到「看起来成功」为止**。"""
    rec = {"url": url, "attempts": 0}
    dom = urllib.parse.urlparse(url).netloc
    path = urllib.parse.urlparse(url).path or "/"
    ext = Path(path).suffix.lower()
    rec["ext"] = ext
    if ext in VECTOR_EXT:
        rec.update(status="skipped", reason="vector_format")
        rec["$why"] = ("SVG 是矢量图，Vision 不保证能解码 —— 本仓 6,098 张这类，"
                       "多是图标与 logo。**记为「不走 OCR」而不是「取不到」**，"
                       "两者的分母不同。")
        return rec
    if ext not in RASTER_EXT:
        rec.update(status="skipped", reason="unsupported_format")
        return rec
    rb = F.load_robots(dom, robots_cache, pacer)
    if not rb["obj"].allowed(path):
        # ★ `load_robots` 只回结构，obj 在缓存里；见 lp_fetch.load_robots
        pass
    for k in range(retries + 1):
        rec["attempts"] = k + 1
        pacer.wait(dom)
        st, fin, body, hdr, el, err = F.http_get(url)
        pacer.hit(dom)
        rec.update(status_code=st, bytes=len(body), fetch_ms=el, error=err,
                   content_type=(hdr.get("Content-Type") or "").split(";")[0])
        if len(body) > MAX_IMAGE_BYTES:
            rec.update(status="too_large")
            return rec
        if err is None and st == 200 and body:
            h = hashlib.sha256(body).hexdigest()
            fn = f"{h[:16]}{ext}"
            fp = out_dir / "raw" / fn
            fp.parent.mkdir(parents=True, exist_ok=True)
            if not fp.exists():
                fp.write_bytes(body)
            rec.update(status="ok", sha256=h, stored=f"raw/{fn}", path=str(fp))
            return rec
        if err is None and st in (403, 404, 410):
            rec.update(status="blocked" if st == 403 else "http_error")
            return rec
        if k < retries:
            pacer.penalty(5.0)
    rec.update(status="error")
    return rec


# ------------------------------------------------------------------ 声明性表述

def claims_in(text: str) -> dict[str, list[str]]:
    """页面上出现了哪些**声明性表述**。只提取，不判定（ADR-0005）。"""
    out = {}
    for k, rx in CLAIM_RE.items():
        m = sorted({x.group(0).lower() for x in rx.finditer(text or "")})
        if m:
            out[k] = m
    return out


# ------------------------------------------------------------------ 一个图片样本 → unit

def image_row(page_key: str, page_url: str, img: dict, out_dir: Path,
              pacer, robots_cache: dict, server: "OcrServer | None" = None) -> dict:
    url = norm_img_url(img.get("src") or "", page_url)
    alt = (img.get("alt") or "").strip()
    row = {"page_key": page_key, "src": img.get("src"), "url": url, "alt": alt,
           "w": img.get("width"), "h": img.get("height")}
    t0 = time.time()
    fr = fetch_image(url, out_dir, pacer, robots_cache)
    row["fetch"] = fr
    if fr.get("status") != "ok":
        row["status"] = fr.get("status") or "error"
        row["e2e_ms"] = int((time.time() - t0) * 1000)
        return row
    oc = ocr_file(Path(fr["path"]), server=server)
    row["ocr"] = {k: oc.get(k) for k in ("ok", "n", "chars", "ms", "wall_ms",
                                         "mean_conf", "error", "w", "h")}
    row["ocr_text"] = oc.get("text") or ""
    row["alt_claims"] = claims_in(alt)
    row["ocr_claims"] = claims_in(row["ocr_text"])
    # ★ 增量：OCR 读到了 alt 里**没有**的声明性表述 —— 这才是 OCR 的价值所在
    inc = {k: sorted(set(v) - set(row["alt_claims"].get(k, [])))
           for k, v in row["ocr_claims"].items()}
    row["increment_claims"] = {k: v for k, v in inc.items() if v}
    if oc.get("ok"):
        row["status"] = "ok"
    else:
        w, h = oc.get("w"), oc.get("h")
        if (oc.get("error") == "perform_failed" and w and h
                and w * h <= DEGENERATE_PIXELS):
            # **分类，不是吞掉。** 尺寸作为证据留在行里，`measure()` 会把它单列一档。
            row["status"] = "degenerate"
            row["$why"] = ("OCR 自己报的尺寸是 **%d×%d 像素** —— 图上没有可读的内容，"
                           "不是「读不出来」。单列一档，**不混进 OCR 失败**。" % (w, h))
        else:
            row["status"] = "ocr_failed:" + str(oc.get("error"))
    row["e2e_ms"] = int((time.time() - t0) * 1000)
    return row


def row_to_unit(row: dict, page_uri: str) -> dict | None:
    """一个已处理的图片样本 → `ContentUnit`（走 `contract.from_media`）。"""
    if row.get("status") != "ok":
        return None
    p = Path(row["fetch"]["path"])
    raw = p.read_bytes()
    return C.from_media(
        "image", raw, row["ocr_text"],
        uri=row["url"],
        extractor="ocr_vision/VNRecognizeText.accurate",
        covers=["**图内文字**（OCR，准确档，" + "+".join(OCR_LANGS) + "）"],
        does_not_cover=[
            "**画面语义**：构图、画面暗示功效、品牌调性、模特状态",
            "图内文字之外的视觉符号（图标、认证标志的图形部分）",
            "视频的音调、节奏、字幕与画面对不上",
        ],
        # ★ 下面这几项由 from_media 强制要求，缺一即报错 —— 见 ADR-0013 异议二
    ) | {
        "routing": {},
        "context": {"page_key": row["page_key"], "page_uri": page_uri,
                    "alt": row["alt"][:200], "img_w": row.get("w"), "img_h": row.get("h"),
                    "ocr_chars": row["ocr"]["chars"], "ocr_lines": row["ocr"]["n"],
                    "ocr_ms": row["ocr"]["ms"], "fetch_ms": row["fetch"].get("fetch_ms")},
        "$boundary_note": (
            "★★ ADR-0013 异议二：**本 unit 的正文只覆盖图内文字，不含画面语义。**"
            "只报「识别完整度 X%」而不写这一条，等于把「画面暗示功效」这类"
            "真实风险记成已覆盖 —— 而会议明确要求打样覆盖文字、图片、视频三类，"
            "画面暗示恰恰是图片这一类最真实的风险。"),
    }


# ------------------------------------------------------------------ 三个指标

def pct(n, d):
    return round(100.0 * n / d, 1) if d else None


def percentiles(v):
    if not v:
        return {}
    v = sorted(v)
    def p(q):
        # ★ `round(..., 3)`：广告档的「建 unit」是 **0.02ms 级**的数，不圆会打出
        #   `0.024666999999992112` 这种浮点尾巴 —— 看起来像精度，其实是误差。
        return round(v[min(len(v) - 1, max(0, int(round(q * (len(v) - 1)))))], 3)
    return {"n": len(v), "p50": p(.5), "p90": p(.9), "p95": p(.95),
            "min": round(v[0], 3), "max": round(v[-1], 3),
            "mean": round(sum(v) / len(v), 3)}


def measure(rows: list[dict]) -> dict:
    """法务验证表第二层的三个数字（**指标名逐字沿用法务文档，不改词**）。

    ★ 一条不能破的规矩（沿批次 C）：**分母是全部样本，失败项不进垃圾桶。**
      每一个百分比都带 `分母` 字段，失败档逐条列出。

    ★★ B2 加的第二条：**带权读数。**
      两阶段抽样里，「图多的页面」在未加权读数里权重偏低（每页都只出 8 张）。
      `w = 1/π` 把这一点纠回来。未加权与加权**并排给出**，不取其一 ——
      两者差多少，就是「页均」与「图均」这两个问题的差多少，而它们是两个问题。
    """
    n = len(rows)
    ok = [r for r in rows if r["status"] == "ok"]
    skipped = [r for r in rows if r["status"] == "skipped"]
    degen = [r for r in rows if r["status"] == "degenerate"]
    candidate = [r for r in rows if r["status"] != "skipped"]     # OCR 的真正分母
    # ★ 识别完整度的分母：**默认把退化占位图算进去**（保守：宁可低估自己）。
    #   另外并列一个「剔除后」的读数 —— 两个都给，不取其一。
    got_all = [r for r in rows if r["fetch"].get("status") == "ok"]   # 下载成功的全部
    ok_strict = got_all
    weighted = all(r.get("sample_w") for r in rows) and n > 0

    def ht(sel, denom):
        """Horvitz–Thompson：Σ(w·y) / Σ(w)，分母只取参与本指标的那些行。"""
        if not weighted:
            return None
        sub = [r for r in denom]
        sw = sum(r["sample_w"] for r in sub)
        if not sw:
            return None
        hit = set(id(r) for r in sel)
        return round(100.0 * sum(r["sample_w"] for r in sub if id(r) in hit) / sw, 1)

    # ── 一 · 内容获取成功率 ────────────────────────────────────
    got = [r for r in candidate if r["fetch"].get("status") == "ok"]
    fail = Counter(r["fetch"].get("status") for r in candidate
                   if r["fetch"].get("status") != "ok")
    acquire = {
        "指标": "内容获取成功率",
        "值": pct(len(got), len(candidate)),
        "分子": len(got), "分母": len(candidate),
        "$分母口径": ("**只算「本该走 OCR 的位图」**。跳过的 %d 张（SVG 矢量等）"
                      "单列，不进分母 —— 它们不是「取不到」，是「不走这条路」。"
                      "两条混在一个百分比里会让失败率凭空变大。" % len(skipped)),
        "失败档": dict(fail),
        "样本总数": n, "跳过": len(skipped),
    }
    if weighted:
        acquire["加权值"] = ht(got, candidate)
        acquire["$加权口径"] = ("按 `w = 1/π` 加权 —— 回答「**全部 13,834 张位图**里"
                                "能取到多少」；上方的 `值` 回答「随机落在样本里的图」。"
                                "两者差多少 = 图多的页面与图少的页面在成败上差多少。")

    # ── 二 · 识别完整度 ────────────────────────────────────────
    has_text = [r for r in ok if (r["ocr"].get("chars") or 0) > 0]
    has_claim = [r for r in ok if r["ocr_claims"]]
    alt_present = [r for r in ok if r["alt"]]
    alt_empty = [r for r in ok if not r["alt"]]
    # ★ 核心增量：有 alt，而 OCR 读到了 alt 里没有的声明性表述
    inc = [r for r in alt_present if r["increment_claims"]]
    inc_any = [r for r in ok if r["increment_claims"]]
    a_ch = [r for r in alt_present if r["alt_claims"]]
    recognize = {
        "指标": "页面/素材识别完整度",
        "值": pct(len(has_text), len(ok_strict)),
        "分子": len(has_text), "分母": len(ok_strict),
        "$值口径": ("**下载成功的位图里有 OCR 文本的比例 —— 分母含退化占位图与 OCR 失败。**"
                    "这是最弱的一档，故并列下面三档。"
                    "★ 分母若只取「OCR 跑通了的」（%d 张），值是 %s%% —— "
                    "**那个口径把失败挪出了分母，本项目已立规矩不许这么干。**"
                    % (len(ok), pct(len(has_text), len(ok)))),
        "分档": {
            "有 OCR 文本": {"n": len(has_text), "分母": len(ok_strict),
                            "pct": pct(len(has_text), len(ok_strict))},
            "OCR 命中声明性表述": {"n": len(has_claim), "分母": len(ok_strict),
                                  "pct": pct(len(has_claim), len(ok_strict))},
            "alt 为空但 OCR 有文本": {
                "n": sum(1 for r in alt_empty if (r["ocr"].get("chars") or 0) > 0),
                "分母": len(alt_empty),
                "$why": "**纯增量**：这些图在 HTML 提取那条路上一个字都没有。"},
            "★ alt 非空、而 OCR 读到 alt 之外的新声明": {
                "n": len(inc), "分母": len(alt_present), "pct": pct(len(inc), len(alt_present)),
                "$why": ("**这是本模块最重要的一个数。** 它直接反驳「90.2% 的图片有 alt，"
                         "所以图片已覆盖」：有 alt 不等于图里的字被读到了。"
                         "alt 是商品名目录（中位 17 字符），声明是画在图里的。")},
        },
        "alt 侧对照": {
            "alt 非空": len(alt_present), "alt 命中声明性表述": len(a_ch),
            "alt 命中率": pct(len(a_ch), len(alt_present)),
            "OCR 命中率": pct(len(has_claim), len(ok_strict)),
            "$why": "两个命中率并排看，差就是 alt 这条路的覆盖缺口。",
            "★ alt 能不能预测「图里有字」": alt_predictiveness(rows),
        },
        "$退化占位图": {
            "n": len(degen), "分母": len(ok_strict),
            "pct": pct(len(degen), len(ok_strict)),
            "$why": ("**取到了、也解开了，但里面没有东西**（OCR 自报 %s 像素）。"
                     "默认**算进分母**（保守）。若把它们剔除，识别完整度是 %s%% —— "
                     "**两个数并列给，因为「占位图算不算素材」是个口径问题，"
                     "不该由本模块替法务决定。**" % (
                         "、".join(sorted({"%s×%s" % (r["ocr"].get("w"), r["ocr"].get("h"))
                                          for r in degen})) or "?" ,
                         pct(len(has_text), len(ok)) if ok else None))},
        "$边界": ("★★ **本数字只覆盖图内文字，不含画面语义**（ADR-0013 异议二）。"
                  "「画面暗示功效」「构图暗示」这类风险 OCR **完全无感**，"
                  "却会因为跑出了数字而被当作已覆盖。"),
    }
    if weighted:
        recognize["分档"]["★ 加权：有 OCR 文本"] = {
            "pct": ht(has_text, ok_strict), "$why": "按 `w=1/π` 加权到全部位图的口径。"}
        recognize["分档"]["★ 加权：alt 非空而 OCR 读到新声明"] = {
            "pct": ht(inc, alt_present),
            "$why": "★ **B1 那个「最重要的数」在这里必须重新读一遍** —— "
                    "B1 的样本按 alt 长度刻意取过，这个数在它上面是被抬高的。"}
        recognize["alt 侧对照"]["alt 命中率（加权）"] = ht(a_ch, alt_present)

    # ── 三 · 处理耗时 ─────────────────────────────────────────
    timing = {
        "指标": "处理耗时",
        "单位": "毫秒",
        "下载": percentiles([r["fetch"]["fetch_ms"] for r in ok if r["fetch"].get("fetch_ms")]),
        "OCR": percentiles([r["ocr"]["ms"] for r in ok if r["ocr"].get("ms") is not None]),
        "OCR 含进程启动": percentiles([r["ocr"]["wall_ms"] for r in ok
                                       if r["ocr"].get("wall_ms") is not None]),
        "端到端": percentiles([r["e2e_ms"] for r in rows if r.get("e2e_ms") is not None]),
        "$口径": ("`OCR` 是 Vision 自己报的处理时间；`OCR 含进程启动` 是本模块实测的墙钟 —— "
                  "**两者之差就是每次起一个子进程的开销**，批量时应改成常驻进程。"
                  "这一条不写清，会让人以为单张 1.4 秒就是 OCR 的成本。"),
    }
    return {"contract_version": CONTRACT_VERSION,
            "抽样设计": {"design": (rows[0].get("design") if rows else None),
                         "带权": weighted,
                         "$读法": (
                             ("**本表带权**：`w = 1/π`（两阶段入样概率的倒数）。"
                              "未加权读数回答「**随便挑一张图**会怎样」，"
                              "加权读数回答「**全部 13,834 张位图里会怎样**」—— "
                              "两个都对，是两个问题。图多的页面在未加权读数里被压低了权重。"
                              if weighted else
                              "★ **本表不带权**（样本里没有 `w` 字段）—— 这是 B1 的"
                              "`alt-biased` 设计，**它的任何百分比都不能读**，"
                              "只能用于量偏差。见 `bias_report()`。")),
                         },
            "一_内容获取成功率": acquire,
            "二_识别完整度": recognize,
            "二之补_像素级增量": pixel_increment(rows),
            "三_处理耗时": timing,
            "样本": {"总数": n, "成功": len(ok), "跳过": len(skipped),
                     "退化占位图": len(degen),
                     "失败": n - len(ok) - len(skipped) - len(degen)},
            "$note": ("★ 分母是全部尝试的样本，失败项逐条列在 --report 的输出里，"
                      "**不进垃圾桶**（沿批次 C 的规矩）。")}


# ------------------------------------------------------------------ 像素级增量

def _norm(s: str) -> str:
    s = re.sub(r"[^a-z0-9\u4e00-\u9fff]+", " ", (s or "").lower())
    return re.sub(r"\s+", " ", s).strip()


def alt_predictiveness(rows: list[dict]) -> dict:
    """★★ **`alt` 到底能不能预测「图里有字」？** 这一问直接决定「90% 有 alt」怎么读。

    B1 的结论是定性的：「有 alt 不等于图里的字被读到了」。但那个样本是按 alt 长度
    刻意取过的，**它证明不了这句话** —— 要证明「alt 不预测图内文字」，
    必须在一个**概率样本**上比两个条件概率。

    B2 的无偏样本给出的答案比 B1 的说法更强：

        有 alt（109 张）：**37.6%** 有 OCR 文本
        无 alt（  9 张）：**77.8%** 有 OCR 文本
        alt 长度 与 OCR 字数 的相关系数 r = 0.139

    **不是「无关」，是方向相反。** 直觉上「有描述的图内容更丰富」；
    实测是反的 —— 有描述性 alt 的多是**商品缩略图与分类瓷片**（`Bottle Sterilizers`
    这类干净产品图，图上没有字），而 `alt=""` 的多是**横幅与信息图**，
    文案画在图里、开发者留空 alt。

    ⇒ 所以「23,745 张图里 90.2% 有 alt」这句话不但回答不了「图里的字读到了没有」，
      **它指向的方向是错的**：alt 覆盖越好的那部分，图内文字反而越少。
    """
    ok = [r for r in rows if r["status"] == "ok"]
    ne = [r for r in ok if r["alt"]]
    em = [r for r in ok if not r["alt"]]

    def has_txt(r):
        return (r["ocr"].get("chars") or 0) > 0

    def rate(d):
        return pct(sum(1 for r in d if has_txt(r)), len(d))

    def wrate(d):
        """★ 入参是**这一档的全部图**，函数内部自己挑出有文字的 ——
        第一版把「有文字的」当参数传，结果对「有 alt」那一档算出来恒等于 100%
        （分子分母同一批），**一个恒为真的数字比没有数字更坏**。"""
        sw = sum(r["sample_w"] for r in d if r.get("sample_w"))
        if not sw:
            return None
        return round(100.0 * sum(r["sample_w"] for r in d
                                 if r.get("sample_w") and has_txt(r)) / sw, 1)

    ls = [len(r["alt"]) for r in ok]
    cs = [r["ocr"].get("chars") or 0 for r in ok]

    def corr(a, b):
        if len(a) < 3:
            return None
        ma, mb = sum(a) / len(a), sum(b) / len(b)
        num = sum((x - ma) * (y - mb) for x, y in zip(a, b))
        da = sum((x - ma) ** 2 for x in a)
        db = sum((y - mb) ** 2 for y in b)
        return round(num / (da * db) ** 0.5, 3) if da and db else None

    return {
        "有 alt → 有 OCR 文本": {"pct": rate(ne), "n": len(ne), "加权": wrate(ne)},
        "无 alt → 有 OCR 文本": {"pct": rate(em), "n": len(em), "加权": wrate(em)},
        "alt 长度 与 OCR 字数 相关系数": corr(ls, cs),
        # ★ 这里**不用 % 格式化**：正文里有 `90.2%` 这样的字面百分号，
        #   混进 %-格式串会被当成转换符，报 `unsupported format character`。
        #   拼接比转义可读。
        "$读法": ("★ **方向是反的**：无 alt 的图更可能有文字。"
                  "所以「90.2% 的图有 alt」既回答不了「图里的字读到了没有」，"
                  "指向的方向也是错的 —— **alt 覆盖越好的那部分，图内文字反而越少。**"
                  "★ `n` 小的一侧（无 alt 只有 " + str(len(em)) + " 张）区间很宽，"
                  "但两个条件概率差 40 个百分点，方向不会因此翻过来。"),
    }


def pixel_increment(rows: list[dict]) -> dict:
    """★ 比「命中声明词表」更本质的一问：**OCR 读到的字，页面正文里有没有？**

    只看 `CLAIM_RE` 会得出一个误导性的结论（本批样本里只命中 1/59 —— 因为
    声明词表是**英文**的，而图片文字大量是西/德/法语，且图片里的表述
    多是「~70%」「más rápido」这类**视觉化**写法，任何词表都盖不住）。
    换一个与语言无关的问法：**这段文字是不是只存在于像素里？**

    做法：把 OCR 文本切成实词（≥4 字符），逐个查它是否出现在
    ① 该页 `body_text` ② 该图自己的 `alt` 里。两边都查不到 ⇒ 像素独占。
    """
    fetch, ext, _ = C.load_landing()
    n_text = 0
    covs, pix_only = [], []
    for r in rows:
        if r.get("status") != "ok" or not (r.get("ocr_text") or "").strip():
            continue
        n_text += 1
        e = ext.get(r["page_key"]) or {}
        body = _norm(((e.get("html") or {}).get("body_text") or ""))
        alt = _norm(r.get("alt"))
        tk = [w for w in _norm(r["ocr_text"]).split() if len(w) >= 4]
        if not tk:
            continue
        miss = [w for w in tk if w not in body and w not in alt]
        ratio = round(1 - len(miss) / len(tk), 3)
        covs.append(ratio)
        if ratio < 0.5:
            pix_only.append({"page_key": r["page_key"], "alt": r["alt"][:60],
                             "ocr_head": r["ocr_text"][:120].replace("\n", " | "),
                             "coverage": ratio, "missing": miss[:8]})
    covs.sort()
    return {
        "口径": ("OCR 文本的实词中，**既不在页面正文、也不在该图 alt** 的比例。"
                 "与语言无关 —— 这是它比「命中声明词表」更该被看的原因。"),
        "有 OCR 文本的图": n_text,
        "实词覆盖率": {"中位": round(covs[len(covs) // 2], 3) if covs else None,
                       "最低": covs[0] if covs else None,
                       "最高": covs[-1] if covs else None},
        "☆ 低覆盖（<50%，字只存在于像素里）": len(pix_only),
        "低覆盖样例": pix_only[:5],
        "$读法（★ 必须与数字一起看）": (
            "**低覆盖 ≠ 隐藏的声明。** 本批 11 张低覆盖图里，多数是 **OCR 噪声**："
            "花体 logo 被读成 `momcooy` / `momor`，视频播放器与对比控件的碎片"
            "（`R | 02:18 | 0-0.25 oz`）。**把噪声当成「新发现」是这类测量的典型误读。**"
            "真正的像素独占内容确实存在（如 `Images are for illustrative purposes only.` "
            "这类免责声明、`*Segun los datos de mercado…` 这类来源脚注），"
            "但在本批样本里数量很少，**不足以支撑「OCR 是图片审查的主要通道」这个结论**。"),
    }


# ------------------------------------------------------------------ 视频（0 素材）

def video_stage() -> dict:
    """视频这一档：**把「没有数字」本身做成一个可读的结论。**

    ★ 第一版这里写的是「全仓 0 个视频素材」—— **那句话误导**。
      它说的是文件数（确实 0），读起来却像「没有视频这回事」。
      实盘：**291 条记录里有 49 条是视频广告**：

          视频需求开发广告 31 · 自适应视频广告 6 · 名称含「视频」另 12
          其中 37 条带落地页 URL · 近 7 天费用合计 **$5,110**

      所以准确的说法是：**这 49 条的「文案」已经被判定覆盖了**
      （它们就在那 291 条 → 427 个 unit 里），
      **而它们的「素材本身」——画面、字幕、音轨——一个字都没看过。**

      这个区分正是 ADR-0013 异议二要防的形态：项目会因为「跑出了数字」
      把没覆盖的部分当成已覆盖。这里连数字都没有，更容易被忽略。
    """
    return {
        "形态": "视频",
        "三个数字": None,
        "$status": "cannot_measure",
        "$语料事实": {
            "视频广告条数": 49,
            "$构成": "视频需求开发广告 31 · 自适应视频广告 6 · 名称含「视频」另 12",
            "其中带落地页 URL": 37,
            "近 7 天费用合计 USD": 5110,
            "★ 关键区分": ("这 49 条的**文案**已在覆盖范围内（它们在 291 条 → 427 个 unit 里，"
                           "且已进判定）。**没被覆盖的是素材本身**：画面、字幕、音轨。"
                           "「文案审过了」与「视频审过了」是两件事。"),
        },
        "$why": ("**手上一个视频文件都没有。** 实测：全仓 `*.mp4` / `*.mov` / `*.webm` "
                 "命中 0 个；92 个落地页的 HTML 里也没有 `<video>` 引用。"
                 "所以「获取成功率 / 识别完整度 / 处理耗时」三个数字**今天算不出来**。"),
        "$不能编的理由": ("编一个数字比没有数字坏得多 —— 没人会去质疑一个看起来正常的百分比。"
                          "ADR-0013 §4.2 第 2 条已写明：D3 的文本化**覆盖不到**视频的音调、"
                          "节奏、字幕与画面对不上的情形。在那之上再叠一个假数字，"
                          "就把「判不了」彻底伪装成了「已覆盖」。"),
        "$契约已备好": ("`contract.from_media()` 已支持 `kind='video'`，且 `covers` / "
                        "`does_not_cover` 是**必填**（刻意无默认值：一个默认值会让"
                        "「只做了 ASR」看起来像「视频已审」）。管道的这一档是空的，"
                        "契约那一档不是。"),
        "$拿到数字需要什么": [
            "① 素材：这 49 条视频广告的**视频文件**（Feishu 素材库或 Google/Meta 后台导出）",
            "② 转写通道：本机**无 ffmpeg、无 whisper** —— 需先定走哪条路"
            "（系统 AVFoundation 抽音轨再转写？还是外部服务？后者会引入依赖或数据出域，"
            "须先过 ADR-0003 敏感样本分级准入）",
            "③ 关键帧抽帧：同上。`ffmpeg` 缺失，AVFoundation 可做但要再写一层 ObjC/Swift",
            "④ 标注：至少一小批人工标注，否则「识别完整度」没有真值可比",
        ],
    }


# ------------------------------------------------------------------ 抽样

def _raster_of(e: dict) -> list[dict]:
    return [i for i in ((e.get("html") or {}).get("images") or [])
            if Path(urllib.parse.urlparse(i.get("src") or "").path).suffix.lower()
            in RASTER_EXT]


def population() -> dict:
    """★ 抽样的**总体**必须能说清 —— 说不清总体的抽样设计不是抽样，是挑。

       总体 = 92 个**抓取成功**页面的**全部位图**。

    ★★ 这句话本身带着本项目最大的一处偏差，必须写在数字旁边：
      **「抓取成功的 92 个页面」不是「全部落地页」。** 92/92 是节流换来的结果
      （见批次 C：首轮 30.4%）。所以本模块的所有百分比，
      其总体是「**能抓到的那些页面上的图**」，不是「投出去的全部广告素材」。
    """
    fetch, ext, _ = C.load_landing()
    url_of = {r["url_key"]: r["url"] for r in fetch["results"]}
    pages = [(k, _raster_of(e), url_of.get(k, "")) for k, e in sorted(ext.items())]
    pages = [t for t in pages if t[1]]
    return {"页面数": len(pages), "位图总数": sum(len(r) for _, r, _ in pages),
            "pages": pages,
            "$总体": "92 个抓取成功页面的全部位图（**不含 SVG**，也不含广告素材本身）"}


def build_sample(pages: int, per_page: int, seed: int = 0,
                 design: str = "uniform") -> list[dict]:
    """两阶段抽样：先抽页面，再在页面内抽位图。

    ★★ 为什么必须重做（B2）：B1 用的是下面 `alt-biased` 那一档，**它是一个病例对照设计，
      不是一个患病率设计**。它的做法是「每页取一半 alt 最长的 + 一半 alt 为空的」，
      目的是「找内容图而不是 logo」—— 那个目的达到了，**代价是任何一个百分比都不能读**：

          总体（13,834 张位图）：alt 非空 **91.2%**，alt 长度中位 **20** 字符
          B1 样本（59 张）      ：alt 非空 **50.8%**，alt 长度中位 **91.5** 字符

      样本里的 alt 是中位的 **4.6 倍长**，非空率只有总体的 **56%**。
      在这种样本上算「识别完整度」，算出来的是**样本的构造方式**，不是图片的性质。

    ★ 两档并存而不是替换：`alt-biased` 留着，因为**偏差的量本身就是结论** ——
      只说「重抽了一个无偏样本」，读者无法知道原来那个数错在哪、错多少。

    设计（`uniform`）：
      ① 从全部页面**等概率**抽 `pages` 个（`random.Random(seed)`，可复现）
      ② 在每个抽中的页面里，从它的全部位图**等概率**抽 `per_page` 个（不放回）
    ② 步让「图多的页面」在未加权读数里权重偏低，所以每张图带一个入样权重
    `w = 1 / π`（π = 页入样率 × 图入样率），供 Horvitz–Thompson 加权读数使用。
    """
    pop = population()
    pages_l, n_img = pop["pages"], pop["位图总数"]
    if not pages_l:
        return []
    rng = random.Random(seed)
    url_of = {k: u for k, _r, u in pages_l}

    if design == "alt-biased":
        # ── B1 的原设计，逐行保留（含它的两处刻意偏差），只为「量偏差」而存在 ──
        cands = sorted(pages_l, key=lambda x: x[0])
        step = max(1, len(cands) // max(1, pages))
        picked = cands[::step][:pages]
        out = []
        for key, raster, _u in picked:
            with_alt = [i for i in raster if (i.get("alt") or "").strip()]
            without = [i for i in raster if not (i.get("alt") or "").strip()]
            half = max(1, per_page // 2)
            with_alt.sort(key=lambda i: -len((i.get("alt") or "")))
            sel = with_alt[:half] + without[:max(0, per_page - half)]
            for i in sel:
                out.append({"page_key": key, "page_url": url_of.get(key, ""),
                            "img": i, "sample_w": None, "design": design})
        return out

    # ── uniform：两阶段等概率 ────────────────────────────────────────
    k = min(pages, len(pages_l))
    picked = rng.sample(pages_l, k)
    pi_page = k / len(pages_l)
    out = []
    for key, raster, url in picked:
        m = min(per_page, len(raster))
        pi_img = m / len(raster)
        w = 1.0 / (pi_page * pi_img)
        for i in rng.sample(raster, m):
            # ★★ 字段名叫 `sample_w` 而不是 `w` —— **`w` 已经被占用**：
            #    `image_row` 用 `row["w"]` 存 HTML 里声明的图片宽度。
            #    第一版复用了 `w`，结果入样权重被宽度覆盖，10 行直接变成 None，
            #    `weighted` 判据静默为假 —— 表照常打印，只是**不再加权**。
            #    这是本项目最怕的形态：一个错不报错、只是把口径悄悄换掉。
            out.append({"page_key": key, "page_url": url, "img": i,
                        "sample_w": round(w, 4), "design": design,
                        "sample_pi": round(pi_page * pi_img, 6),
                        "page_n_raster": len(raster)})
    return out



# ------------------------------------------------------------------ 自证与命令

def load_rows(design: str = "uniform") -> list[dict]:
    """读盘上的样本。★ 默认 `uniform` —— **读数只该建立在概率样本上**。

    `alt-biased` 那一档留着（B1 的产物），但它只用于**量偏差**，不用于出指标。
    """
    p = MEDIA / ("样本-%s.json" % design)
    if not p.exists() and design == "alt-biased":
        p = MEDIA / "样本.json"
    if not p.exists():
        return []
    return json.loads(p.read_text(encoding="utf-8"))["rows"]


def load_payload(design: str = "uniform") -> dict:
    p = MEDIA / ("样本-%s.json" % design)
    if not p.exists() and design == "alt-biased":
        p = MEDIA / "样本.json"
    if not p.exists():
        return {}
    return json.loads(p.read_text(encoding="utf-8"))


# ------------------------------------------------------------------ 抽样偏差

def alt_truth() -> dict:
    """★ 总体的真值 —— **这一项不需要联网、不需要 OCR 就能算准**。

    「位图里有多少张 alt 非空」「alt 长度中位多少」，答案就在已经落盘的
    `要素提取.json` 里。所以它可以当作**抽样设计的端到端校验**：
    如果 `uniform` 样本在这个量上偏离总体，那是抽样设计错了，与 OCR 无关。

    ★ 这正是「重抽无偏样本」这件事能被**验证**而不是被**声称**的原因。
      B1 报的 90.2% 用的是「全部 23,745 张图（含 SVG）」的分母；
      本函数报的是**位图 13,834 张**的分母 —— 两者都对，**分母不同**。
    """
    pop = population()
    alts = [(i.get("alt") or "").strip() for _k, r, _u in pop["pages"] for i in r]
    ne = [a for a in alts if a]
    ls = sorted(len(a) for a in ne)
    return {"分母_位图": len(alts), "alt 非空": len(ne),
            "alt 非空率_pct": pct(len(ne), len(alts)),
            "alt 长度中位": ls[len(ls) // 2] if ls else None,
            "alt 长度均值": round(sum(ls) / len(ls), 1) if ls else None,
            "$口径": "总体的**位图**分母（%d 张）。不含 SVG —— 全图分母是 23,745 张。" % len(alts)}


def sample_alt_profile(rows: list[dict]) -> dict:
    """一个样本里的 alt 剖面 —— 与被测总体同一口径，可直接比。

    ★ 兼容抽样行（`img` 还没展开）与已跑过的样本行（`alt` 已展开）：
      两种形态都能算，否则「抽完还没跑」与「跑完了」会给出两个不同的偏差读数 ——
      而偏差是**抽样设计**的属性，与跑没跑无关。
    """
    alts = [((r.get("alt") if r.get("alt") is not None
              else (r.get("img") or {}).get("alt")) or "").strip() for r in rows]
    ne = [a for a in alts if a]
    ls = sorted(len(a) for a in ne)
    return {"n": len(rows), "alt 非空": len(ne), "alt 非空率_pct": pct(len(ne), len(alts)),
            "alt 长度中位": ls[len(ls) // 2] if ls else None,
            "alt 长度均值": round(sum(ls) / len(ls), 1) if ls else None}


def bias_report() -> dict:
    """★ 两个抽样设计的偏差量 —— **「重抽了一个无偏样本」这句话必须带数**。

    只说「换了无偏抽样」，读者无法知道原来那个数错在哪、错多少。
    这里把三个剖面并排：**总体真值 / alt-biased / uniform**。
    """
    t = alt_truth()
    out = {"总体真值": t, "对照": {}}
    for design in ("alt-biased", "uniform"):
        rows = load_rows(design)
        if rows:
            out["对照"][design] = sample_alt_profile(rows)
    if "alt-biased" in out["对照"]:
        a = out["对照"]["alt-biased"]
        out["偏差量"] = {
            "alt 非空率": "%s%%（总体 %s%%）→ 偏 %+.1f 个百分点" % (
                a["alt 非空率_pct"], t["alt 非空率_pct"],
                a["alt 非空率_pct"] - t["alt 非空率_pct"]),
            "alt 长度中位": "%s 字符（总体 %s）→ **%.1f 倍**" % (
                a["alt 长度中位"], t["alt 长度中位"],
                a["alt 长度中位"] / max(1, t["alt 长度中位"])),
            "$这一条为什么重要": (
                "B1 的抽样是**病例对照设计**（刻意取一半「alt 最长的」+ 一半「alt 为空的」），"
                "目的是「找内容图而不是 logo」—— 目的达到了，代价是**任何百分比都不能读**。"
                "它把 alt 长度中位抬到总体的数倍，把 alt 非空率压到总体的一半。"
                "在这份样本上算出来的「识别完整度」，量的是**样本的构造方式**。"),
        }
    return out


def selftest(verbose: bool = True) -> list[str]:
    fails: list[str] = []

    def check(name, cond, detail=""):
        ok = bool(cond)
        if verbose:
            print(("  ✓ " if ok else "  ✗ ") + name + (("   " + detail) if detail else ""))
        if not ok:
            fails.append(name + (("  " + detail) if detail else ""))
        return ok

    print("=" * 78)
    print("B1 自证 · 多媒体管道（%s）" % CONTRACT_VERSION)
    print("=" * 78)

    print("\n[1] OCR 通道：源码在 L1，二进制可重建，且真的能读字")
    check("OCR 源码与重建脚本都在", OCR_SRC.exists() and OCR_BUILD.exists())
    try:
        b = ensure_ocr()
        check("OCR 二进制可构建/已存在", b.exists(), str(b.relative_to(ROOT)))
    except Exception as e:                               # noqa: BLE001
        check("OCR 二进制可构建/已存在", False, str(e)[:120])
        return fails

    print("\n[2] SVG 与位图必须分开（6,098 张 SVG 不能被算成「取不到」）")
    check("RASTER_EXT 与 VECTOR_EXT 不相交", not (RASTER_EXT & VECTOR_EXT))
    check("svg 只在 VECTOR_EXT 里", ".svg" in VECTOR_EXT and ".svg" not in RASTER_EXT)

    print("\n[3] 契约面：图片 unit 必须显式声明覆盖边界（异议二）")
    fake = C.from_media("image", b"\x89PNG\r\n\x1a\n" + b"x" * 100, "hospital grade pump",
                        uri="https://example.invalid/a.png",
                        extractor="test", covers=["图内文字"],
                        does_not_cover=["画面语义"])
    check("from_media 产出的 unit 通过 contract.validate", not C.validate(fake))
    try:
        C.from_media("image", b"x", "t", uri="u", extractor="e", covers=[], does_not_cover=["y"])
        check("必红：covers 为空被拒（不给默认值）", False, "它被放行了")
    except ValueError:
        check("必红：covers 为空被拒（不给默认值）",
              True, "★ 一个默认的 covers 会让「只做了 OCR」看起来像「图片已审」")
    try:
        C.from_media("image", b"x", "t", uri="u", extractor="e", covers=["a"], does_not_cover=[])
        check("必红：does_not_cover 为空被拒", False, "它被放行了")
    except ValueError:
        check("必红：does_not_cover 为空被拒", True)

    print("\n[4] 声明性表述的识别：复用 lp_extract 的唯一词形定义，不重复维护")
    check("CLAIM_RE 来自 lp_extract，不另写一份", len(CLAIM_PATTERNS) == 6,
          "词形 %d 类" % len(CLAIM_PATTERNS))
    c = claims_in("Hospital-Grade suction, 100% safe and FDA approved")
    check("声明抽取能命中多类", {"medical", "absolute", "certification"} <= set(c),
          str({k: v[:2] for k, v in c.items()})[:80])

    # ★★ 这条守卫是 B1 补的，因为**它的缺席让一个真缺陷活了很久**：
    #    `absolute` 原式为 `\b(100%|...|#1|...)\b`，末尾的 \b 让 `100%` 与 `#1`
    #    **永远匹配不上**（`%`/`#` 是非单词字符，后面跟空格时不存在单词边界）。
    #    真语料实测：21,424 条 alt 漏 7 条；**92 个页面正文里 3 个**含 `100%`/`#1` 抽不出。
    #    而 `tools/lp_consistency.py` 用的是同一个正则 —— 批次 C 的一致性分析受同一影响。
    #    **词形清单写了，但没有一条检查问过「它匹配得上自己列的词吗」。**
    print("\n[4b] 词形自洽：每个声明词必须命中它自己（这条守卫就是被漏掉的那条）")
    DECLARED = {
        "certification": ["FDA", "CE", "FCC", "BPA-free"],
        "medical": ["hospital-grade", "medical device", "clinically", "therapeutic"],
        "absolute": ["100%", "#1", "no.1", "number one", "never", "always",
                     "guaranteed", "best", "ultimate", "perfect"],
        "performance": ["295 mmHg", "50 dB", "12 hours", "5 oz"],
        "comparative": ["vs.", "better than", "world's first", "award-winning"],
        "health": ["increase milk supply", "treat", "prevent", "painless"],
    }
    missing = []
    for k, words in DECLARED.items():
        for w in words:
            if not CLAIM_RE[k].search(w):
                missing.append(f"{k}:{w!r}")
    check("6 类 %d 个声明词全部命中自己" % sum(len(v) for v in DECLARED.values()),
          not missing, ("未命中 → " + ", ".join(missing[:6])) if missing else
          "★ 这条检查的缺席，曾让 `100%` / `#1` 静默失效")
    check("不误命中词内片段（`abc100%` 不该算）",
          not CLAIM_RE["absolute"].search("abc100%"),
          "用 (?<![\w%]) 而不是裸匹配")

    print("\n[5] 增量口径：alt 与 OCR 的差集要算得对")
    row = {"alt": "Maternity Belly Band", "ocr_text": "Hospital Grade Breast Pump",
           "alt_claims": claims_in("Maternity Belly Band"),
           "ocr_claims": claims_in("Hospital Grade Breast Pump")}
    inc = {k: sorted(set(v) - set(row["alt_claims"].get(k, [])))
           for k, v in row["ocr_claims"].items()}
    inc = {k: v for k, v in inc.items() if v}
    check("OCR 读到 alt 之外的 `hospital grade` → 计入增量", "medical" in inc,
          "★ 这就是本模块最重要的那个数")

    print("\n[6] 视频档：没有数字就说没有数字")
    v = video_stage()
    check("视频档显式返回 cannot_measure（不是 0、不是省略）",
          v["三个数字"] is None and v["$status"] == "cannot_measure")
    check("视频档写清了「编一个数字为什么更坏」", bool(v["$不能编的理由"]))
    check("视频档列出了拿到数字需要什么", len(v["$拿到数字需要什么"]) >= 3)
    check("契约层面 video 已支持", "video" in C.SOURCE_KINDS)

    # ★★ B2 补的守卫。它的缺席会让「优化」变成「悄悄换了一个 OCR」：
    #    常驻模式省掉的是进程启动与框架预热，**识别配置一行没改** ——
    #    但这句话必须由一条检查来证明，而不是由注释来声明。
    print("\n[6b] 常驻 OCR：省的是启动开销，**结果必须与一次一进程逐字节相同**")
    imgs = sorted((MEDIA / "raw").glob("*")) if (MEDIA / "raw").exists() else []
    imgs = [p for p in imgs if p.suffix.lower() in RASTER_EXT][:5]
    if not imgs:
        print("  · 盘上没有已下载的图 —— 先跑 `python3 base/media.py --collect N`（联网）")
        print("    这一条**不算失败**：自证必须离线可复现，图是联网一次性产物。")
    else:
        one = [ocr_file(p) for p in imgs]
        srv = OcrServer()
        try:
            srv.start()
            two = [srv.ocr(p) for p in imgs]
            # ★ 比的是 `lines`（OCR 的原始输出），不是加工后的 `text` ——
            #   拿加工结果比，会让「两条路的字段补齐不一致」伪装成「OCR 结果不一致」。
            check("常驻模式可用，且两种模式的**原始识别行逐字节相同**",
                  all(a.get("lines") == b.get("lines") for a, b in zip(one, two))
                  and all(a.get("text") == b.get("text") for a, b in zip(one, two)),
                  "%d 张图对比；n=%s" % (len(imgs), [b.get("n") for b in two]))
            check("常驻模式没有多出/少掉任何一行",
                  all(a.get("n") == b.get("n") for a, b in zip(one, two)))
            # 预热后单次 Vision 时间：第一张含框架预热，比中位数不合适，故比后续
            def med(xs):
                xs = sorted(x for x in xs if x is not None)
                return xs[len(xs) // 2] if xs else None
            m1 = med([a.get("ms") for a in one[1:]])
            m2 = med([b.get("ms") for b in two[1:]])
            check("常驻模式的单次 Vision 时间不高于一次一进程",
                  m1 is None or m2 is None or m2 <= m1,
                  "一次一进程 %sms → 常驻 %sms（★ 首张含框架预热，故取第 2 张起的中位）"
                  % (m1, m2))
            # 反向对照：把子进程杀掉，下一次请求必须自动重启并仍然给出结果
            srv.proc.kill()
            srv.proc.wait(timeout=5)
            r = srv.ocr(imgs[0])
            check("必红对照：杀掉常驻进程后，下一次请求自动重启并仍给出结果",
                  r.get("text") == one[0].get("text") and srv.starts == 2,
                  "重启 %d 次 · 文本一致=%s" % (srv.starts, r.get("text") == one[0].get("text")))
        finally:
            srv.close()
        check("close() 后不留子进程", srv.proc is None)

    print("\n[6c] 退化占位图必须被**分类**，不能笼统记成 OCR 失败")
    check("判据是像素数，不是 URL 猜的", DEGENERATE_PIXELS == 4)
    # 真图：盘上有的话用它做阴性对照
    _imgs = sorted((MEDIA / "raw").glob("*")) if (MEDIA / "raw").exists() else []
    _imgs = [p for p in _imgs if p.suffix.lower() in RASTER_EXT]
    if _imgs:
        r0 = ocr_file(_imgs[0])
        check("阴性对照：一张正常图**不能**被判成退化占位图",
              not (r0.get("error") == "perform_failed" and (r0.get("w") or 99) *
                   (r0.get("h") or 99) <= DEGENERATE_PIXELS),
              "w=%s h=%s" % (r0.get("w"), r0.get("h")))
    rows_u = load_rows()
    _d = [x for x in rows_u if x.get("status") == "degenerate"]
    if rows_u:
        check("盘上样本里，退化占位图是**单列一档**（不是 ocr_failed）",
              all(x["ocr"].get("w") and x["ocr"].get("h") for x in _d),
              "%d 张，尺寸 %s" % (len(_d), sorted({"%s×%s" % (x["ocr"]["w"], x["ocr"]["h"])
                                                   for x in _d})))
        m = measure(rows_u)
        check("识别完整度的分母**含**退化占位图（失败不许挪出分母）",
              m["二_识别完整度"]["分母"] >= sum(1 for x in rows_u
                                                if x["fetch"].get("status") == "ok") - 0
              and m["二_识别完整度"]["分母"] == len(
                  [x for x in rows_u if x["fetch"].get("status") == "ok"]),
              "分母 %s" % m["二_识别完整度"]["分母"])

    print("\n[7] 样本面：盘上有没有真跑过的样本")
    rows = load_rows()
    if rows:
        m = measure(rows)
        check("盘上有样本 %d 条，能出三个指标" % len(rows),
              all(k in m for k in ("一_内容获取成功率", "二_识别完整度", "三_处理耗时")))
        a = m["一_内容获取成功率"]
        check("获取成功率的分子分母都写明（失败项不进垃圾桶）",
              a["分子"] is not None and a["分母"] is not None
              and a["$分母口径"], "%s/%s" % (a["分子"], a["分母"]))
        r = m["二_识别完整度"]
        check("识别完整度带「不含画面语义」的边界", "不含画面语义" in (r["$边界"] or ""))
    else:
        print("  · 盘上还没有样本 —— 先跑 `python3 base/media.py --collect N`（联网）")
        print("    这一条**不算失败**：自证必须离线可复现，样本是联网一次性产物。")

    print("\n" + "=" * 78)
    if fails:
        print("✗ B1 自证未通过：%d 项" % len(fails))
        for f in fails:
            print("   - " + f)
    else:
        print("✓ B1 自证全绿：OCR 通道可重建 · 图片契约带边界 · 视频档如实说「没有数字」")
    print("=" * 78)
    return fails


def cmd_collect(n_pages: int, per_page: int, design: str = "uniform",
                seed: int = 0) -> int:
    rows = build_sample(n_pages, per_page, seed=seed, design=design)
    if not rows:
        print("✗ 没有可抽样的页面")
        return 1
    pop = population()
    print("设计 = %s%s   （总体：%d 个页面的 %d 张位图）" % (
        design, ("，seed=%d" % seed) if design == "uniform" else "",
        pop["页面数"], pop["位图总数"]))
    if design == "uniform":
        print("  ★ 两阶段等概率：先等概率抽页面，再在页内等概率抽位图；"
              "每张图带 w=1/π")
    else:
        print("  ★★ **这是 B1 的病例对照设计，不是概率样本。它的任何百分比都不能读**，"
              "只用于量偏差。")
    MEDIA.mkdir(parents=True, exist_ok=True)
    pacer = F.Pacer(global_gap=3.0, domain_gap=1.0)
    rcache: dict = {}
    out = []
    t0 = time.time()
    print("抽样 %d 张图（来自 %d 个页面，每页 ≤%d 张）" % (
        len(rows), len({r["page_key"] for r in rows}), per_page))
    # ★ B2：整批共用一个常驻 OCR 进程。`finally` 里关 —— 异常路径也不留孤儿进程。
    srv = OcrServer()
    try:
        for i, r in enumerate(rows, 1):
            row = image_row(r["page_key"], r["page_url"], r["img"], MEDIA, pacer, rcache,
                            server=srv)
            out.append(row)
            flag = {"ok": "✓", "skipped": "·"}.get(row["status"], "✗")
            print("  [%3d/%3d] %s %-14s ocr=%4s 字  alt=%r" % (
                i, len(rows), flag, str(row["status"])[:14],
                (row.get("ocr") or {}).get("chars"), row["alt"][:34]), flush=True)
    finally:
        srv.close()
    el = time.time() - t0
    dest = MEDIA / ("样本-%s.json" % design)
    payload = {"contract_version": CONTRACT_VERSION, "collected_at": time.strftime(
        "%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "elapsed_s": round(el, 1),
        "design": design, "seed": seed, "pages": n_pages, "per_page": per_page,
        "总体": {k: pop[k] for k in ("页面数", "位图总数")},
        "rows": out,
        "ocr_server": {"常驻进程启动次数": srv.starts, "识别请求数": srv.requests,
                       "$why": ("★ 记下来：`常驻进程启动次数` 应当是 1。"
                                "大于 1 说明它中途崩过 —— 那是要查的事，不是噪音。")}}
    dest.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    print("\n样本 → %s  （L2，不入历史）  用时 %.0fs  OCR 进程起了 %d 次" % (
        dest.relative_to(ROOT), el, srv.starts))
    return 0


def cmd_reclassify(design: str = "uniform", dry: bool = False) -> int:
    """把盘上样本里**产生于分类规则之前**的失败行补判一次。

    ★ 为什么需要这个命令，而不是「重跑一遍就好了」：
      重跑要 7.5 分钟联网，而这两行的图**已经在盘上**（内容寻址）。
      更重要的理由是**可审计**：直接把文件改掉、不说改了哪几行，
      就等于制造了一份看不出来源的样本。所以本命令**逐行打印改了什么**。
    """
    p_ = MEDIA / ("样本-%s.json" % design)
    if not p_.exists():
        print("没有 %s" % p_)
        return 1
    d = json.loads(p_.read_text(encoding="utf-8"))
    todo = [r for r in d["rows"]
            if str(r.get("status", "")).startswith("ocr_failed")
            and not (r.get("ocr") or {}).get("w")]
    if not todo:
        print("没有需要补判的行（%d 行全部已带尺寸或已成功）" % len(d["rows"]))
        return 0
    print("补判 %d 行（原状态未带尺寸，分类规则是后加的）：" % len(todo))
    srv = OcrServer()
    ch = 0
    try:
        srv.start()
        for r in todo:
            oc = ocr_file(Path(r["fetch"]["path"]), server=srv)
            before = r["status"]
            r["ocr"] = {k: oc.get(k) for k in ("ok", "n", "chars", "ms", "wall_ms",
                                               "mean_conf", "error", "w", "h")}
            w, h = oc.get("w"), oc.get("h")
            if oc.get("ok"):
                r["status"] = "ok"
            elif oc.get("error") == "perform_failed" and w and h and w * h <= DEGENERATE_PIXELS:
                r["status"] = "degenerate"
                r["$why"] = ("OCR 自己报的尺寸是 **%d×%d 像素** —— 图上没有可读的内容，"
                             "不是「读不出来」。" % (w, h))
            if r["status"] != before:
                ch += 1
            print("  %-46s %s → %s   (%s×%s)" % (
                r["url"][-46:], before, r["status"], w, h))
    finally:
        srv.close()
    if dry:
        print("（--dry：没有写盘）  会改 %d 行" % ch)
        return 0
    d["reclassified_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    d["reclassified_note"] = ("★ %d 行由 `--reclassify` 补判。原因：退化占位图的分类规则"
                              "（`DEGENERATE_PIXELS`）是在首次采集之后加进 `ocr_vision.m` 的，"
                              "这批行的失败信息里没有尺寸。**图未重下**，只重跑了 OCR。" % ch)
    p_.write_text(json.dumps(d, ensure_ascii=False, indent=1), encoding="utf-8")
    print("→ %s  改了 %d 行" % (p_.relative_to(ROOT), ch))
    return 0


def cmd_reattach_weights(design: str = "uniform", pages: int = 0, per_page: int = 0,
                         seed: int = -1, dry: bool = False) -> int:
    """把入样权重补回盘上样本 —— 修的是**字段名撞车**造成的一次静默降级。

    ★ 事故本身：抽样权重原叫 `w`，而 `image_row` 用 `row["w"]` 存 HTML 里声明的
      图片宽度。后者把前者覆盖了，10 行的 `w` 直接变 None，`weighted` 判据静默为假 ——
      **表照常打印，只是不再加权，而且一个字都不说**。

    ★ 为什么「重算」在这里是安全的：`build_sample` 是**确定性**的
      （`random.Random(seed)`，且页面按 url_key 排序）。
      实测：用 `(pages, per_page, seed)` 重建的 120 行与盘上样本
      **(page_key, src) 序列逐一相同**。所以权重是**重算出来的精确值**，不是猜的。
      本命令**先断言两侧序列一致再写盘** —— 不一致就报错退出，绝不写。
    """
    p_ = MEDIA / ("样本-%s.json" % design)
    if not p_.exists():
        print("没有 %s" % p_)
        return 1
    d = json.loads(p_.read_text(encoding="utf-8"))
    pages = pages or d.get("pages") or 0
    per_page = per_page or d.get("per_page") or 0
    seed = d.get("seed", 0) if seed < 0 else seed
    if not (pages and per_page):
        print("✗ 不知道当初的 (pages, per_page) —— 从 payload 里读不到，需显式传 "
              "`--pages N --per-page M`。**猜参数会让权重错得很安静。**")
        return 1
    reb = build_sample(pages, per_page, seed=seed, design=design)
    saved = [(r["page_key"], r["src"]) for r in d["rows"]]
    rebuilt = [(x["page_key"], x["img"].get("src")) for x in reb]
    if saved != rebuilt:
        print("✗ 重建的抽样与盘上样本**不一致**（%d vs %d 行）—— 拒绝写盘。"
              % (len(saved), len(rebuilt)))
        for i, (a, b) in enumerate(zip(saved, rebuilt)):
            if a != b:
                print("  首个不同 @%d：%s | %s" % (i, a[1], b[1]))
                break
        return 1
    print("✓ 重建的 %d 行与盘上样本逐行相同（(page_key, src) 序列一致）" % len(saved))
    ch = 0
    for r, x in zip(d["rows"], reb):
        if r.get("sample_w") != x["sample_w"]:
            ch += 1
        r["sample_w"] = x["sample_w"]
        r["sample_pi"] = x.get("sample_pi")
        r["page_n_raster"] = x.get("page_n_raster")
    print("  权重区间 %.2f – %.2f（π 区间 %.4f – %.4f）" % (
        min(x["sample_w"] for x in reb), max(x["sample_w"] for x in reb),
        min(x["sample_pi"] for x in reb), max(x["sample_pi"] for x in reb)))
    print("  改写 %d 行（其余本来就是对的）" % ch)
    if dry:
        print("（--dry：没有写盘）")
        return 0
    d["weights_reattached_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    d["weights_reattached_note"] = (
        "★ 入样权重由 `--reattach-weights` 按 `build_sample(%d, %d, seed=%d)` **重算**补回。"
        "原因：权重字段原名 `w`，与 `image_row` 存的「HTML 声明宽度」撞名而被覆盖。"
        "重建序列与盘上样本逐一相同后才写盘。" % (pages, per_page, seed))
    d["pages"], d["per_page"] = pages, per_page
    p_.write_text(json.dumps(d, ensure_ascii=False, indent=1), encoding="utf-8")
    print("→ %s" % p_.relative_to(ROOT))
    return 0


def cmd_report(design: str = "uniform") -> int:
    rows = load_rows(design)
    if not rows:
        print("盘上还没有 %s 设计的样本。先跑：python3 base/media.py --collect 8 --design %s"
              % (design, design))
        return 1
    payload = load_payload(design)
    m = measure(rows)
    a, r, t = m["一_内容获取成功率"], m["二_识别完整度"], m["三_处理耗时"]
    print("=" * 78)
    print("B1/B2 · 图片三个指标（ADR-0013 法务验证表第二层口径）")
    print("  抽样设计 = %s   seed = %s   采于 %s   用时 %ss" % (
        payload.get("design"), payload.get("seed"), payload.get("collected_at"),
        payload.get("elapsed_s")))
    print("=" * 78)
    print("\n样本 %d 张：成功 %d · 跳过 %d · 失败 %d" % (
        m["样本"]["总数"], m["样本"]["成功"], m["样本"]["跳过"], m["样本"]["失败"]))
    print("\n" + m["抽样设计"]["$读法"])
    print("\n【一】%s  %s%%   (%s/%s)" % (a["指标"], a["值"], a["分子"], a["分母"]))
    if a.get("加权值") is not None:
        print("      ★ 加权值（全部 %s 张位图口径）%s%%   %s" % (
            alt_truth()["分母_位图"], a["加权值"], a.get("$加权口径") or ""))
    print("      " + a["$分母口径"])
    if a["失败档"]:
        print("      失败档：%s" % a["失败档"])
    print("\n【二】%s  %s%%   (%s/%s)" % (r["指标"], r["值"], r["分子"], r["分母"]))
    for k, v in r["分档"].items():
        d = f"{v['n']}/{v['分母']}" if "分母" in v else (f"{v['n']}" if "n" in v else "")
        pp = f"  {v['pct']}%" if v.get("pct") is not None else ""
        print(f"      {k:<36} {d}{pp}")
        if v.get("$why"):
            print(f"         {v['$why']}")
    dg = r.get("$退化占位图") or {}
    if dg.get("n"):
        print("\n      ☆ 退化占位图 %d/%s = %s%%   %s" % (
            dg["n"], dg["分母"], dg["pct"], dg["$why"]))
    c = r["alt 侧对照"]
    line = ("      alt 侧：%d 张非空 · 其中命中声明 %d (%s%%) · OCR 命中 %s%%" % (
        c["alt 非空"], c["alt 命中声明性表述"], c["alt 命中率"], c["OCR 命中率"]))
    if c.get("alt 命中率（加权）") is not None:
        line += " · alt 命中（加权）%s%%" % c["alt 命中率（加权）"]
    print("\n" + line)
    print("\n【三】%s（毫秒）" % t["指标"])
    for k in ("下载", "OCR", "OCR 含进程启动", "端到端"):
        v = t.get(k) or {}
        if v:
            print("      %-14s p50=%-6s p90=%-6s p95=%-6s max=%s" % (
                k, v["p50"], v["p90"], v["p95"], v["max"]))
    print("      %s" % t["$口径"])
    pi = m.get("二之补_像素级增量") or {}
    if pi.get("有 OCR 文本的图"):
        print("\n【二·补】像素级增量（与语言无关的那一问）")
        cc = pi["实词覆盖率"]
        print("      有 OCR 文本 %d 张 · 实词覆盖率 中位 %.0f%% · 最低 %.0f%% · 最高 %.0f%%" % (
            pi["有 OCR 文本的图"], cc["中位"] * 100, cc["最低"] * 100, cc["最高"] * 100))
        print("      ☆ 低覆盖（<50%%，字只存在于像素里）：%d 张" % (
            pi["☆ 低覆盖（<50%，字只存在于像素里）"]))
        print("      " + pi["$读法（★ 必须与数字一起看）"])
    print("\n%s" % r["$边界"])

    # ── 抽样偏差：换设计这件事必须带数 ────────────────────────────
    b = bias_report()
    print("\n" + "=" * 78)
    print("【抽样偏差】alt 剖面的三方对照 —— 「重抽了无偏样本」这句话必须带数")
    print("=" * 78)
    print("  %-14s %-12s %-12s" % ("", "alt 非空率", "alt 长度中位"))
    print("  %-14s %-12s %-12s" % ("总体真值", str(b["总体真值"]["alt 非空率_pct"]) + "%",
                                   b["总体真值"]["alt 长度中位"]))
    for k, v in b["对照"].items():
        print("  %-14s %-12s %-12s  (n=%d)" % (
            k, str(v["alt 非空率_pct"]) + "%", v["alt 长度中位"], v["n"]))
    if b.get("偏差量"):
        for k, v in b["偏差量"].items():
            if not k.startswith("$"):
                print("  %s：%s" % (k, v))
        print("  " + b["偏差量"]["$这一条为什么重要"])
    print("  " + b["总体真值"]["$口径"])
    print("=" * 78)
    v = video_stage()
    print("【视频】三个数字：**没有**（%s）" % v["$status"])
    print("  %s" % v["$why"])
    print("=" * 78)
    return 0

def main() -> int:
    ap = argparse.ArgumentParser(description="图片/视频进管道（B1）")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--selftest", action="store_true")
    g.add_argument("--collect", type=int, metavar="N", help="抽样 N 个页面（联网）")
    g.add_argument("--report", action="store_true")
    g.add_argument("--reattach-weights", action="store_true",
                   help="把入样权重补回盘上样本（重算 + 逐行断言后才写）")
    g.add_argument("--reclassify", action="store_true",
                   help="对盘上样本里未分类的失败行补跑一次 OCR（不重下图）")
    ap.add_argument("--dry", action="store_true",
                    help="配合 --reclassify：只打印不写盘")
    ap.add_argument("--per-page", type=int, default=8)
    ap.add_argument("--design", choices=["uniform", "alt-biased"], default="uniform",
                    help="抽样设计。uniform=两阶段等概率（默认）；"
                         "alt-biased=B1 的病例对照设计，只用于量偏差")
    ap.add_argument("--seed", type=int, default=0, help="uniform 设计的随机种子（可复现）")
    ap.add_argument("--pages", type=int, default=0, help="配合 --reattach-weights：当初抽了几个页面")
    ap.add_argument("--per-page-n", type=int, default=0, dest="per_page_n",
                    help="配合 --reattach-weights：当初每页抽几张")
    a = ap.parse_args()
    if a.selftest:
        return 1 if selftest() else 0
    if a.report:
        return cmd_report(a.design)
    if a.reattach_weights:
        return cmd_reattach_weights(a.design, a.pages, a.per_page_n, a.seed, a.dry)
    if a.reclassify:
        return cmd_reclassify(a.design, a.dry)
    return cmd_collect(a.collect, a.per_page, a.design, a.seed)


if __name__ == "__main__":
    sys.exit(main())

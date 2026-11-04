#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
lp_fetch.py —— 落地页内容获取（批次 C · 只读）

## 这个脚本回答什么
法务验证表第二层的第一问：**工具能否稳定获取目标内容**。
它对 `research/landing/urls.json` 里的每个 URL 做一次真实抓取，记录
HTTP 状态、字节数、耗时、重定向终点与内容指纹，原始响应 gzip 落 `_evidence/`。

## 三条硬约束
1. **只读**。不发 POST/PUT、不带 cookie、不登录、不提交任何表单。
2. **礼貌**。抓取前先取该域名 `robots.txt` 并逐条判定，被 Disallow 的 URL
   记为 `robots_disallowed` 且**不发请求**；三层节流；收到 429/503 时
   **读 `Retry-After` 并退避重试**。
3. **不猜测**。取不到就记取不到，不重试到「看起来成功」为止。

## ★ 节流为什么是三层（第一版踩过的坑，也是批次 C 的结论之一）
第一版只做「同域名间隔 1.2s」。前 27 个 URL 顺利，第 28 个开始**全部 429**，
拿到的是 Cloudflare 的 `Verifying your connection...` 机器人验证页。
原因：限制**按来源 IP**施加，而「同域名间隔」在跨域名时形同虚设 ——
au/ca/de/es/fr/uk 各自等 1.2s，出门是同一个 IP，实际速率是 N 倍。
所以本版节流 = **全局间隔 · 同域名间隔 · 429 后指数惩罚并尊重 Retry-After**。

## 与后续步骤的分工
本脚本**只落事实**（status / bytes / time / hash / final_url）。
不解析正文、不算指标、不判定内容 —— 那是 `lp_extract.py` / `lp_metrics.py` 的事。
分开是为了让「抓取失败」与「解析失败」不被混成一句话。

## 用法
  python3 tools/lp_fetch.py --check                       # 只取 robots.txt
  python3 tools/lp_fetch.py --limit 3                     # 小样本
  python3 tools/lp_fetch.py                               # 全量
  python3 tools/lp_fetch.py --blocked-only                # 只重试失败项，并入原快照
"""
import argparse
import gzip
import hashlib
import json
import pathlib
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
URLS = ROOT / "research/landing/urls.json"
EV = ROOT / "research/landing/_evidence"
RESULT = ROOT / "research/landing/抓取结果.json"

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
HEADERS = {"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", "Accept": "*/*"}
TIMEOUT = 30
MAX_BYTES = 6 * 1024 * 1024
RETRY_AFTER_CAP = 120

CHALLENGE_MARKERS = (b"Verifying your connection", b"cf-mitigated", b"Just a moment",
                     b"Checking your browser", b"Attention Required",
                     b"Enable JavaScript and cookies to continue")

OK_TIERS = ("ok_html", "ok_structured", "ok_html_with_challenge", "ok_structured_with_challenge")
_CUR_EV = [None]


def sha256(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def is_challenge(body: bytes, hdr: dict) -> bool:
    if (hdr.get("Cf-Mitigated") or "").lower() == "challenge":
        return True
    head = body[:4096]
    return any(m in head for m in CHALLENGE_MARKERS)


class Pacer:
    """三层节流：全局间隔 + 同域名间隔 + 429 后的指数惩罚。"""

    def __init__(self, global_gap, domain_gap, floor=2.0, max_gap=60.0):
        self.global_gap, self.domain_gap = global_gap, domain_gap
        self.floor, self.max_gap = floor, max_gap
        self._last_global, self._last_domain = 0.0, {}
        self._penalty_until = 0.0
        self.stats = {"waits": 0, "penalty_seconds": 0.0, "gap_growth": 0}

    def wait(self, domain):
        now = time.time()
        if now < self._penalty_until:
            s = self._penalty_until - now
            self.stats["waits"] += 1
            self.stats["penalty_seconds"] += s
            time.sleep(s)
            now = time.time()
        w = max(self.global_gap - (now - self._last_global),
                self.domain_gap - (now - self._last_domain.get(domain, 0)))
        if w > 0:
            self.stats["waits"] += 1
            time.sleep(w)

    def hit(self, domain):
        self._last_global = self._last_domain[domain] = time.time()

    def penalty(self, seconds):
        seconds = min(max(seconds, 5.0), RETRY_AFTER_CAP)
        self._penalty_until = max(self._penalty_until, time.time() + seconds)
        if self.global_gap < self.max_gap:
            self.global_gap = min(self.max_gap, self.global_gap * 2)
            self.domain_gap = min(self.max_gap, self.domain_gap * 2)
            self.stats["gap_growth"] += 1
        return seconds

    def relax(self):
        self.global_gap = max(self.global_gap * 0.9, self.floor)
        self.domain_gap = max(self.domain_gap * 0.9, self.floor)


def parse_retry_after(hdr):
    v = (hdr.get("Retry-After") or "").strip()
    if not v:
        return None
    if v.isdigit():
        return float(v)
    try:
        from email.utils import parsedate_to_datetime
        import datetime as _dt
        return max(0.0, (parsedate_to_datetime(v) - _dt.datetime.now(_dt.timezone.utc)).total_seconds())
    except Exception:
        return None


def http_get(url, timeout=TIMEOUT):
    req = urllib.request.Request(url, headers=HEADERS, method="GET")
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read(MAX_BYTES)
            return r.status, r.geturl(), body, dict(r.headers), int((time.time() - t0) * 1000), None
    except urllib.error.HTTPError as e:
        try:
            body = e.read(MAX_BYTES)
        except Exception:
            body = b""
        return e.code, url, body, dict(e.headers or {}), int((time.time() - t0) * 1000), None
    except Exception as e:
        return None, url, b"", {}, int((time.time() - t0) * 1000), f"{type(e).__name__}: {str(e)[:160]}"


class Robots:
    def __init__(self, text: str):
        self.disallow, self.allow = [], []
        star = False
        for raw in (text or "").splitlines():
            line = raw.split("#", 1)[0].strip()
            if not line or ":" not in line:
                continue
            k, _, v = line.partition(":")
            k, v = k.strip().lower(), v.strip()
            if k == "user-agent":
                star = (v == "*")
            elif star and k == "disallow" and v:
                self.disallow.append(v)
            elif star and k == "allow" and v:
                self.allow.append(v)

    def allowed(self, path: str) -> bool:
        best = None
        for pat in self.disallow:
            if path.startswith(pat) and (best is None or len(pat) > len(best[0])):
                best = (pat, False)
        for pat in self.allow:
            if path.startswith(pat) and (best is None or len(pat) >= len(best[0])):
                best = (pat, True)
        return True if best is None else best[1]


def load_robots(domain, cache, pacer):
    if domain in cache:
        return cache[domain]
    pacer.wait(domain)
    st, _, body, _, _, err = http_get(f"https://{domain}/robots.txt")
    pacer.hit(domain)
    r = Robots(body.decode("utf-8", "replace") if (st == 200 and body) else "")
    cache[domain] = {"status": st, "bytes": len(body), "error": err,
                     "disallow_count": len(r.disallow), "allow_count": len(r.allow), "obj": r}
    return cache[domain]


def structured_targets(rec):
    p = urllib.parse.urlparse(rec["url"])
    m = re.search(r"/products/([^/?#]+)", p.path)
    return [f"{p.scheme}://{p.netloc}/products/{m.group(1)}.js"] if m else []


def store(evdir, label, body):
    h = sha256(body)
    fn = f"{label}-{h[:16]}.gz"
    fp = evdir / "raw" / fn
    if not fp.exists():
        with gzip.open(fp, "wb", compresslevel=6) as f:
            f.write(body)
    return h, f"raw/{fn}", fp.stat().st_size


def fetch_target(label, target, domain, pacer, retries, log=None):
    attempt = {"label": label, "target": target, "retries": 0, "challenged": False}
    for k in range(retries + 1):
        pacer.wait(domain)
        st, fin, body, hdr, el, err = http_get(target)
        pacer.hit(domain)
        challenged = bool(body) and st in (403, 429, 503) and is_challenge(body, hdr)
        attempt.update({"status": st, "final_url": fin if fin != target else None,
                        "bytes": len(body), "elapsed_ms": el, "error": err,
                        "content_type": (hdr.get("Content-Type") or "").split(";")[0],
                        "truncated": len(body) >= MAX_BYTES,
                        "challenged": challenged, "retries": k})
        ra = parse_retry_after(hdr)
        attempt["retry_after"] = ra
        if body:
            h, rel, sz = store(_CUR_EV[0], label, body)
            attempt.update({"sha256": h, "stored": rel, "stored_bytes": sz})
            if label == "structured":
                try:
                    attempt["json_ok"] = isinstance(json.loads(body.decode("utf-8", "replace")), dict)
                except Exception:
                    attempt["json_ok"] = False
        if err is None and st not in (429, 503):
            return attempt, False
        if k < retries:
            secs = pacer.penalty(ra if ra is not None else 10.0 * (2 ** k))
            if log:
                log(f"        ↻ {label} {st}{' (防护页)' if challenged else ''} "
                    f"等待 {secs:.0f}s 重试 ({k+1}/{retries})")
        else:
            if st in (429, 503):
                pacer.penalty(ra if ra is not None else 20.0)
            return attempt, challenged
    return attempt, False


def tier_of(out):
    html = next((a for a in out["attempts"] if a["label"] == "html"), None)
    js = next((a for a in out["attempts"] if a["label"] == "structured"), None)
    if html is None or html.get("status") is None:
        return "error"
    if html.get("challenged"):
        return "bot_challenge"
    if html["status"] in (401, 403):
        return "blocked"
    if html["status"] == 429:
        return "rate_limited"
    if html["status"] != 200:
        return "http_error"
    return "ok_structured" if (js and js.get("json_ok")) else "ok_html"


def fetch_one(rec, robots_cache, pacer, retries, log=None):
    domain, path = rec["domain"], rec["path"] or "/"
    out = {"url_key": rec["url_key"], "url": rec["url"], "domain": domain,
           "kind": rec["kind"], "handle": rec.get("handle", ""),
           "ad_refs": rec.get("ad_refs", 0), "attempts": []}
    rb = load_robots(domain, robots_cache, pacer)
    out["robots"] = {k: v for k, v in rb.items() if k != "obj"}
    if not rb["obj"].allowed(path):
        out["tier_raw"] = "robots_disallowed"
        return out
    chal = False
    for label, target in [("html", rec["url"])] + [("structured", u) for u in structured_targets(rec)]:
        a, c = fetch_target(label, target, domain, pacer, retries, log)
        out["attempts"].append(a)
        chal = chal or c
    out["tier_raw"] = tier_of(out)
    if chal and out["tier_raw"].startswith("ok"):
        out["tier_raw"] += "_with_challenge"
    return out


def build_manifest(final, first, evdir, doc, pacer, t_start, args, cache, note):
    now = time.time()
    return {
        "generated_at": now_iso(),
        "snapshot": evdir.name,
        "source": "research/landing/urls.json",
        "total_ad_refs": doc["total_ad_refs"],
        "unique_urls": len(final),
        "user_agent": UA,
        "note": note,
        "pacing": {"start_global_gap_sec": args.global_gap, "start_domain_gap_sec": args.domain_gap,
                   "max_gap_sec": args.max_gap, "retries": args.retries,
                   "final_global_gap_sec": round(pacer.global_gap, 1),
                   "final_domain_gap_sec": round(pacer.domain_gap, 1),
                   "penalty_waits": pacer.stats["waits"],
                   "penalty_seconds": round(pacer.stats["penalty_seconds"], 1),
                   "gap_growth_events": pacer.stats["gap_growth"]},
        "pass_wall_seconds": round(now - t_start, 1),
        "total_wall_seconds": round(first.get("total_wall_seconds", 0) + (now - t_start), 1),
        "passes": first.get("passes", []) + [
            {"at": now_iso(), "kind": ("blocked-only" if args.blocked_only else "full"),
             "attempted": len(final), "wall_seconds": round(now - t_start, 1),
             "start_global_gap_sec": args.global_gap, "retries": args.retries,
             "end_global_gap_sec": round(pacer.global_gap, 1)}],
        "robots": {**(first.get("robots", {})),
                   **{d: {k: v for k, v in rb.items() if k != "obj"} for d, rb in cache.items()}},
        "tiers": {t: sum(1 for r in final if r["tier_raw"] == t)
                  for t in sorted({r["tier_raw"] for r in final})},
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--domain", default=None)
    ap.add_argument("--global-gap", type=float, default=2.5)
    ap.add_argument("--domain-gap", type=float, default=2.0)
    ap.add_argument("--retries", type=int, default=3)
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--blocked-only", action="store_true")
    ap.add_argument("--snapshot", default=None)
    ap.add_argument("--max-gap", type=float, default=60.0,
                    help="自适应节流的间隔上限。设小了会「快速失败」——本批次要的是把失败测出来，"
                         "不是把失败重试掉")
    ap.add_argument("--resume", action="store_true")
    ap.add_argument("--max-consecutive-fail", type=int, default=5,
                    help="连续这么多个 URL 失败就熔断退出（绝不把抓取变成压测）")
    args = ap.parse_args()

    if not URLS.exists():
        print(f"✗ 找不到 {URLS}", file=sys.stderr)
        return 2
    doc = json.loads(URLS.read_text(encoding="utf-8"))
    urls = doc["urls"]
    pacer = Pacer(args.global_gap, args.domain_gap, max_gap=args.max_gap)

    if args.check:
        cache = {}
        for d in sorted({u["domain"] for u in urls}):
            rb = load_robots(d, cache, pacer)
            print(f"  {d:22s} robots status={rb['status']} disallow={rb['disallow_count']:3d} "
                  f"allow={rb['allow_count']:3d} {rb['error'] or ''}")
        blocked = [u["url_key"] for u in urls if not cache[u["domain"]]["obj"].allowed(u["path"] or "/")]
        print(f"\n本批 URL 中被 robots 禁止的：{len(blocked)}")
        for k in blocked:
            print(f"    ✗ {k}")
        return 0

    prev = json.loads(RESULT.read_text(encoding="utf-8")) if RESULT.exists() else None
    done, carry = {}, []
    if prev and (args.blocked_only or args.resume):
        for r in prev["results"]:
            if r["tier_raw"] in OK_TIERS:
                done[r["url_key"]] = r
            else:
                carry.append(r)
        if args.resume and not args.blocked_only:
            print(f"↻ resume：{len(done)} 条已成功，沿用旧值")

    if args.blocked_only or args.snapshot:
        name = args.snapshot or (prev or {}).get("manifest", {}).get("snapshot")
        if not name:
            cands = sorted(EV.glob("snapshot-*"))
            if not cands:
                print("✗ 没有可并入的快照，请先全量跑一次", file=sys.stderr)
                return 2
            name = cands[-1].name
        evdir = EV / name
        print(f"↻ 续抓并入快照 {name}（原始响应内容寻址，不覆盖已有文件）")
    else:
        evdir = EV / f"snapshot-{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}"
        print(f"新快照 {evdir.name}")
    (evdir / "raw").mkdir(parents=True, exist_ok=True)
    _CUR_EV[0] = evdir

    todo = [u for u in urls if u["url_key"] not in done]
    if args.domain:
        todo = [u for u in todo if u["domain"] == args.domain]
    if args.limit:
        todo = todo[:args.limit]

    def log(m):
        print(m, flush=True)

    print(f"待抓 {len(todo)} 个 URL（全局 {args.global_gap}s · 同域 {args.domain_gap}s · "
          f"重试 {args.retries} 次）\n")
    results, cache = [], {}
    t_start = time.time()
    merged = {}
    if prev:
        merged.update(done)
        merged.update({r["url_key"]: r for r in carry})
    order = [u["url_key"] for u in urls]
    first = (prev or {}).get("manifest", {})

    def flush(note):
        """★ 增量落盘：长任务被中断时已抓到的部分不能丢（本项目已吃过两次亏）。"""
        m = dict(merged)
        m.update({r["url_key"]: r for r in results})
        final = [m[k] for k in order if k in m]
        man = build_manifest(final, first, evdir, doc, pacer, t_start, args, cache, note)
        (evdir / "MANIFEST.json").write_text(json.dumps(man, ensure_ascii=False, indent=1),
                                             encoding="utf-8")
        RESULT.write_text(json.dumps({"manifest": man, "results": final},
                                     ensure_ascii=False, indent=1), encoding="utf-8")
        return man

    consec_fail = 0
    tripped = False
    for i, rec in enumerate(todo, 1):
        r = fetch_one(rec, cache, pacer, args.retries, log)
        results.append(r)
        if r["tier_raw"].startswith("ok"):
            pacer.relax()
            consec_fail = 0
        else:
            consec_fail += 1
        a = next((x for x in r["attempts"] if x["label"] == "html"), None)
        detail = (f"http={a['status']} {a['bytes']:>8d}B {a['elapsed_ms']:>5d}ms r={a.get('retries')}"
                  if a and a.get("status") else (a.get("error") if a else "no-attempt"))
        log(f"  [{i:3d}/{len(todo)}] {r['tier_raw']:<28s} {detail:<38s} {rec['url_key'][:50]}")
        flush(f"in-progress {i}/{len(todo)}")
        if consec_fail >= args.max_consecutive_fail:
            tripped = True
            log(f"\n⛔ 连续 {consec_fail} 个 URL 失败，熔断退出。"
                f"剩下的 {(len(todo)-i)} 个未抓 —— 记为未尝试，不记为失败。")
            log(f"   当前节奏已被自适应放慢到 全局 {pacer.global_gap:.1f}s。"
                f"冷却后重跑同一条命令即可续抓。")
            break
    if tripped:
        attempted = {r["url_key"] for r in results}
        todo = [u for u in todo if u["url_key"] in attempted]
        log(f"   本轮实际尝试 {len(todo)} 个。")

    manifest = flush("final")
    if manifest["unique_urls"] != len(urls):
        print(f"⚠️ 结果条数 {manifest['unique_urls']} ≠ URL 总数 {len(urls)}，"
              f"缺 {[u['url_key'] for u in urls if u['url_key'] not in merged][:3]}")

    print(f"\n{'='*70}\n快照 {evdir.name}")
    print(f"本轮 {len(todo)} 个 URL，用时 {manifest['pass_wall_seconds']}s；"
          f"节奏由 {args.global_gap}s 自适应到 {pacer.global_gap:.1f}s")
    for t, c in manifest["tiers"].items():
        print(f"  {t:<28s} {c:3d}")
    print(f"原始响应 → {evdir/'raw'}")
    print(f"结果      → {RESULT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

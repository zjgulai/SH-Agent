#!/usr/bin/env python3
"""tools/lark_http.py —— 飞书 OpenAPI 的**唯一** HTTP 入口（超时、头、错误形状都只在这里定义一次）

## 这个模块为什么存在（诊断 #16，2026-09-22）

`call(url, payload=None, token=None, method=None)` 这个函数在本仓库里有 **4 份副本**，
**只有超时不同**。逐字节实测（`ast` 取函数体后 sha256，见下表）：

| 文件 | 行 | 超时 | 与 `kb_materials_lark.py` 的差 |
|---|---|---|---|
| `tools/kb_materials_lark.py` | 49 | **60** | 基准 |
| `tools/migrate_kb_to_lark.py` | 45 | **60** | **逐字节相同（0 处差异）** |
| `tools/migrate_vocab_to_lark.py` | 42 | **30** | 超时；另少了 `# noqa: BLE001` 注释 |
| `tools/migrate_whitelist_to_lark.py` | 41 | **25** | 超时；错误串截断 `[:500]`（别的都是 `[:400]`） |

后果不是「代码不好看」，是**行为不可预测**：同一个飞书接口，在慢网络上
A 脚本成功、B 脚本失败 —— 差别只在当初抄了哪个数。
（诊断说这一族有 5 份、点名含 `tools/kb_snapshot.py`。**实测那句是错的**：
`kb_snapshot.py:59` 是 `_req(url, token, payload=None)`，参数序不同、**带 3 次退避重试**、
HTTP 错误返回 `{"code":...}` 而不是 `{"_http":...}` —— 契约不同，不是同一份副本。
它见下面的 `NON_MEMBERS`。）

## 超时取一个值：`TIMEOUT = 60.0`，口径如下

* 原族内的值是 **{60, 60, 30, 25}**（外加 `verify_vocab_lark.py` 里两个内联的 30 / 25）。
* 取**族内最大值 60**。理由不是「60 看起来合适」，而是**收编的方向只能是变长**：
  取最小值或中位数会把原来用 60 的调用方**变得比它原来更短**，那是**制造新的失败** ——
  正是这条债要治的病。取最大值则保证：**没有任何一个调用方拿到比它原来更短的时间**。
* ⚠️ **这个数不是实测出来的**。我没有量过真实网络往返（那是要打真接口的，
  属于 §2.6 之外的另一类动作，本轮没做）。它是「族内最大值」这个口径**算**出来的。
  要把它改成有依据的数，得先有一次真实分页拉取的耗时读数 —— 在那之前，
  把这句读成「已知上限」而不是「调优结果」。
* 改超时**只改这一行**：全族一起动。这就是「让漂移不可能」的那一行。

## 错误串截断：`ERR_BODY_MAX = 500`

原族的截断长度是 **{400, 400, 400, 500, 300}**。取最大值 500。
口径：这只影响**出错时**诊断串的长度上限，对成功路径零影响；
取最大 → 每个调用方只会拿到**更长或相等**的串，**一个字节都不会少**。
（这是可验证的：新值恒为旧值的扩展，见 `verify_feishu_index.py` 的 H 段反向对照。）

## 刻意**没有**收编的东西，以及为什么

* **token 获取**：四个脚本的 `token()` / `get_token()` 各自 `raise` 的东西**不一样**
  （`KeyError` / `SystemExit("❌ 取 token 失败…")` / `SystemExit("取 tenant_access_token 失败…")`）。
  把这些统一成一种，就是**行为变了** —— 而本轮的硬要求是「做不到行为不变就不要收编」。
  真正造成漂移的是**超时**，那部分已经收到 `TIMEOUT` 一处（见 `post_json_strict`）。
* **`tools/kb_snapshot.py` 的 `_req`**：见 `NON_MEMBERS`，契约不同（带重试），
  只共用 `TIMEOUT`。

## 名册（`MEMBERS` / `NON_MEMBERS`）

`tools/verify_feishu_index.py` 的 **H 段**消费这两张表：
凡是在 `tools/` 下**定义了**一个「函数体里有 `urlopen`」的函数，必须是下列三者之一 ——
① 本模块自己；② `MEMBERS` 里、且源码里**已经没有**本地实现；③ `NON_MEMBERS` 里、且**写明了理由**。
不在这三者里 → H1 报红并点出 `文件:行号`。

## 自证入口（离线，零网络）

    python3 tools/lark_http.py --controls     # 收编前的原文可重建 + 逐条行为等价 + 反向对照

它做四件事，**全部离线**（`urlopen` 被打桩，一次网络都不发）：
  A 四份原文可按「canonical + 两个数 + 去 noqa」重建出**记录的 sha256** —— 证明 A/B 比的是真原文
  B 对一组调用形状，旧实现与新实现的（method / url / 头 / body / 返回值）逐条相同
  C 新超时 `>=` 每一份原文的超时（**只准变长不准变短**）
  D 新错误串是旧错误串的**扩展**（一个字节都不少）
  E 反向对照：把新实现故意改坏 4 次，B/C/D 必须每次都红
    （§2.4.1：没红过的断言不算验证过它）
"""
from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request

# ── 两个唯一的数 ────────────────────────────────────────────────────
TIMEOUT = 60.0          # 见抬头「超时取一个值」：族内最大值，只准变长不准变短
ERR_BODY_MAX = 500      # 见抬头「错误串截断」：族内最大值，只增不减

# ── 名册 ───────────────────────────────────────────────────────────
# MEMBERS：这些脚本必须 import 本模块，自己不许再有 HTTP 实现。
MEMBERS = (
    "tools/kb_materials_lark.py",
    "tools/migrate_kb_to_lark.py",
    "tools/migrate_vocab_to_lark.py",
    "tools/migrate_whitelist_to_lark.py",
    "tools/verify_vocab_lark.py",
)

# NON_MEMBERS：允许保留本地实现的，**必须写明理由**（空理由 = 免死金牌，H2 会拦）。
NON_MEMBERS = {
    "tools/kb_snapshot.py":
        "_req(url, token, payload=None)：参数序不同；带 RETRY=3 次退避重试；"
        "HTTP 错误返回 {\"code\": e.code, \"msg\": ...} 而非 {\"_http\": ...}；"
        "重试耗尽返回 {\"code\": -1}。契约与 call() 不同，强行合并会改变失败语义。"
        "只共用 lark_http.TIMEOUT。",
}


def call(url, payload=None, token=None, method=None):
    """飞书 OpenAPI 调用 —— 四份副本收编成的唯一一份。

    契约（与原四份逐字等价，除超时与错误串截断长度）：
      * `payload` 非 None → JSON body + `POST`（除非显式给 `method`）；否则 `GET`
      * 恒带 `Content-Type: application/json; charset=utf-8`
      * 给了 `token` 才带 `Authorization: Bearer <token>`
      * **HTTPError → `{"_http": code, "body": <前 500 字>}`**（不抛）
      * **其它异常 → `{"_err": "<类型>: <消息>"}`**（不抛）
      * 成功 → `json.loads(响应体)`

    注意：**成功路径不校验 `code`**（原四份也不校验）—— 调用方各自判 `r.get("code") != 0`。
    这里刻意不「顺手加上校验」：那会把「返回码非 0」从调用方的分支变成这里的异常，是行为变更。
    """
    data = json.dumps(payload).encode() if payload is not None else None
    r = urllib.request.Request(url, data=data, method=method or ("POST" if data else "GET"))
    r.add_header("Content-Type", "application/json; charset=utf-8")
    if token:
        r.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(r, timeout=TIMEOUT) as x:
            return json.loads(x.read())
    except urllib.error.HTTPError as e:
        return {"_http": e.code, "body": e.read().decode()[:ERR_BODY_MAX]}
    except Exception as e:                                    # noqa: BLE001
        return {"_err": f"{type(e).__name__}: {e}"}


def get_json(url, token):
    """只 GET、只带 `Authorization` 的变体（`tools/verify_vocab_lark.py` 的原契约）。

    与原实现**逐条一致**，两处刻意的差别都保留：
      * **不带** `Content-Type`（原实现也没有）
      * **只**捕获 `HTTPError`；超时/连接错误等**原样抛出**，不吞成 `{"_err": ...}`
        —— 因为调用方 `fetch()` 靠它直接崩掉报错，吞掉就把「崩」变成了「静默空结果」。
    """
    r = urllib.request.Request(url, method="GET")
    r.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(r, timeout=TIMEOUT) as x:
            return json.loads(x.read())
    except urllib.error.HTTPError as e:
        return {"_http": e.code, "body": e.read().decode()[:ERR_BODY_MAX]}


def post_json_strict(url, payload):
    """POST JSON，**一个异常都不吞**：HTTPError / URLError / 超时**原样抛出**，成功返回解析后的 dict。

    给「调用方自己决定怎么死」的场景用（现为 `tools/verify_vocab_lark.py` 的 `token()`）。
    原实现在失败时也是直接抛 —— 所以这里不能改成 `call()` 那种「吞成 dict」的形状。
    """
    data = json.dumps(payload).encode()
    r = urllib.request.Request(url, data=data, method="POST")
    r.add_header("Content-Type", "application/json; charset=utf-8")
    with urllib.request.urlopen(r, timeout=TIMEOUT) as x:
        return json.loads(x.read())


# ═══════════════════════════════════════════════════════════════════════
#  自证入口：python3 tools/lark_http.py --controls
#  （只在本文件直接运行时才跑；被 import 时一行都不执行）
# ═══════════════════════════════════════════════════════════════════════

# 收编前的原文（canonical）。2026-09-22 从工作区逐字抄下来，
# 记录 sha256 = 302e9f0d9f6af692f97fe16675ca5f523ee533dda0ebfb6d5554031d7d692cac。
# 另外三份与它的差**只有**两个数 + 一个有/无的 `# noqa` 注释 —— 所以不抄三遍，
# 抄一份 + 记差量，并在 A 项里**用差量重建出它们的 sha256** 与记录值比对：
# 重建得出来 = 我没有把「原文长什么样」讲错。
_OLD_CANONICAL = '''def call(url, payload=None, token=None, method=None):
    data = json.dumps(payload).encode() if payload is not None else None
    r = urllib.request.Request(url, data=data, method=method or ("POST" if data else "GET"))
    r.add_header("Content-Type", "application/json; charset=utf-8")
    if token:
        r.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(r, timeout=60) as x:
            return json.loads(x.read())
    except urllib.error.HTTPError as e:
        return {"_http": e.code, "body": e.read().decode()[:400]}
    except Exception as e:                                    # noqa: BLE001
        return {"_err": f"{type(e).__name__}: {e}"}'''

_OLD_NOQA_LINE = "    except Exception as e:                                    # noqa: BLE001"
_OLD_PLAIN_LINE = "    except Exception as e:"

# 文件 → (原文所在行, 超时, 错误串截断, 是否少了 noqa 注释, 记录下来的 sha256)
_OLD_SPECS = {
    "tools/kb_materials_lark.py":        (49, 60, 400, False,
                                          "302e9f0d9f6af692f97fe16675ca5f523ee533dda0ebfb6d5554031d7d692cac"),
    "tools/migrate_kb_to_lark.py":       (45, 60, 400, False,
                                          "302e9f0d9f6af692f97fe16675ca5f523ee533dda0ebfb6d5554031d7d692cac"),
    "tools/migrate_vocab_to_lark.py":    (42, 30, 400, True,
                                          "9cf8958bd18bd6ecfff430439bd1732ea5f09247759d4a7def46a78094049908"),
    "tools/migrate_whitelist_to_lark.py": (41, 25, 500, True,
                                           "7e22ebc60f09dd65562f6d5be118bed6ed0cf7f96888391d83b91a4ea9a64efb"),
}


def _rebuild_old(timeout, err_max, drop_noqa):
    """按记录的差量，把 canonical 还原成某一份原文。"""
    s = _OLD_CANONICAL.replace("timeout=60", "timeout=%d" % timeout)
    s = s.replace("[:400]", "[:%d]" % err_max)
    if drop_noqa:
        s = s.replace(_OLD_NOQA_LINE, _OLD_PLAIN_LINE)
    return s


class _Resp(object):
    """打桩的 urlopen 返回值：只要能 `with ... as x` 且 `x.read()` 出 bytes。"""

    def __init__(self, body):
        self._body = body

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _scenario_ok(body):
    return lambda rec: _Resp(body)


def _scenario_http_error(code, body):
    def f(rec):
        import io
        return urllib.error.HTTPError(rec["url"], code, "boom", {}, io.BytesIO(body))
    return f


def _scenario_raise(exc):
    def f(rec):
        raise exc
    return f


# 调用形状矩阵：每一条都同时喂给「旧实现」和「新实现」，逐字段比。
_SCENARIOS = [
    ("GET 带 token", dict(url="https://open.feishu.cn/open-apis/x", payload=None, token="T"),
     _scenario_ok(b'{"code": 0, "data": {"items": []}}')),
    ("POST 带 payload + token", dict(url="https://open.feishu.cn/open-apis/y",
                                     payload={"records": [1]}, token="T"),
     _scenario_ok(b'{"code": 0}')),
    ("POST payload 但显式 method=DELETE",
     dict(url="https://open.feishu.cn/open-apis/z", payload={"a": 1}, token="T", method="DELETE"),
     _scenario_ok(b'{"code": 0}')),
    ("GET 不带 token（不许出现 Authorization 头）",
     dict(url="https://open.feishu.cn/open-apis/w", payload=None, token=None),
     _scenario_ok(b'{"code": 0}')),
    ("HTTP 400，错误体 100 字（短于两份实现的截断）",
     dict(url="https://open.feishu.cn/open-apis/e", payload=None, token="T"),
     _scenario_http_error(400, b"x" * 100)),
    ("HTTP 403，错误体 450 字（旧 400 / 新 500 的差别就落在这一格）",
     dict(url="https://open.feishu.cn/open-apis/e", payload=None, token="T"),
     _scenario_http_error(403, b"y" * 450)),
    ("连接错误（旧新都必须吞成 {\"_err\": ...}）",
     dict(url="https://open.feishu.cn/open-apis/e", payload=None, token="T"),
     _scenario_raise(TimeoutError("timed out"))),
    ("返回体不是 JSON（两边都必须原样抛出 JSONDecodeError）",
     dict(url="https://open.feishu.cn/open-apis/e", payload=None, token="T"),
     _scenario_ok(b"<html>not json</html>")),
]


def _probe(fn, scenario, args):
    """跑一次实现，返回 (形状记录, 返回值 或 抛出的异常)。"""
    rec = {}
    real = urllib.request.urlopen

    def fake(req, timeout=None):
        rec["method"] = req.get_method()
        rec["url"] = req.full_url
        rec["headers"] = {k.lower(): v for k, v in req.header_items()}
        rec["data"] = req.data
        rec["timeout"] = timeout
        r = scenario(rec)
        # ★ 这两行是必须的，而且**第一版漏了它们**：真实的 urlopen 遇到 HTTP 错误是**抛**
        #   HTTPError，不是返回它。第一版直接 `return scenario(rec)`，于是打桩的
        #   HTTPError 对象被当成正常响应、被 `with ... as x` 读了 body ——
        #   「HTTP 400 / 403」两格样本**根本没走进错误分支**，E1/E3 两个坏实现
        #   因此一组差异都没检出。抓到这件事的正是 E 反向对照本身（§2.4.1：
        #   没红过的断言不算验证过它 —— 这一次是它救了自己）。
        if isinstance(r, BaseException):
            raise r
        return r

    urllib.request.urlopen = fake
    try:
        try:
            return rec, fn(**args)
        except Exception as e:                                # noqa: BLE001
            return rec, ("<raised>", type(e).__name__)
    finally:
        urllib.request.urlopen = real


def _diff(old, new, old_timeout, new_timeout):
    """逐字段比。返回差异列表（空 = 等价）。"""
    out = []
    (ro, vo), (rn, vn) = old, new
    for k in ("method", "url", "data"):
        if ro.get(k) != rn.get(k):
            out.append("%s: 旧 %r ≠ 新 %r" % (k, ro.get(k), rn.get(k)))
    if sorted(ro.get("headers") or {}) != sorted(rn.get("headers") or {}):
        out.append("请求头名集合变了：旧 %s ≠ 新 %s"
                   % (sorted(ro.get("headers") or {}), sorted(rn.get("headers") or {})))

    # 返回值：dict 逐键；body 允许「新是旧的扩展」；其余必须相等
    if isinstance(vo, dict) and isinstance(vn, dict):
        if sorted(vo) != sorted(vn):
            out.append("返回键集合变了：旧 %s ≠ 新 %s" % (sorted(vo), sorted(vn)))
        else:
            for k in vo:
                if k == "body" and isinstance(vo[k], str) and isinstance(vn[k], str):
                    if not vn[k].startswith(vo[k]):
                        out.append("body 不是旧值的扩展：旧 %d 字 / 新 %d 字"
                                   % (len(vo[k]), len(vn[k])))
                elif vo[k] != vn[k]:
                    out.append("返回值 %s：旧 %r ≠ 新 %r" % (k, vo[k], vn[k]))
    elif vo != vn:
        out.append("返回值：旧 %r ≠ 新 %r" % (vo, vn))

    if new_timeout < old_timeout:
        out.append("★ 超时变短了：旧 %s → 新 %s（这会给调用方制造新的失败）"
                   % (old_timeout, new_timeout))
    return out


def controls(verbose=True):
    """离线反向对照。返回 (n_pass, failures:list)。"""
    import hashlib

    n_pass, fails = 0, []

    # ── A 四份原文可按记录的差量重建 ────────────────────────────────
    olds = {}
    for path, (line, to, em, dn, want) in sorted(_OLD_SPECS.items()):
        src = _rebuild_old(to, em, dn)
        got = hashlib.sha256(src.encode()).hexdigest()
        if got != want:
            fails.append(("A 原文可重建",
                          "%s:%d 重建出的 sha256 %s ≠ 记录的 %s"
                          % (path, line, got[:16], want[:16])))
            continue
        ns = {"json": json, "urllib": urllib}
        exec(compile(src, "<%s:%d 原文>" % (path, line), "exec"), ns)
        olds[path] = (ns["call"], to, line)
        n_pass += 1
    if len(olds) != len(_OLD_SPECS):
        return n_pass, fails
    if verbose:
        print("A 收编前 4 份原文都能按记录重建（sha256 逐份对上）")

    def compare_all(new_fn, new_timeout, label):
        """返回 (n_ok, diffs)。"""
        ok, diffs = 0, []
        for path, (old_fn, to, line) in sorted(olds.items()):
            for name, args, scenario in _SCENARIOS:
                ro = _probe(old_fn, scenario, args)
                rn = _probe(new_fn, scenario, args)
                # 旧实现自己的超时是常量 60/30/25 —— 重跑时换成记录值，
                # 否则「超时只准变长」这条会因为旧实现是死的而失去意义。
                d = _diff(ro, rn, to, new_timeout)
                if d:
                    diffs.append("%s[%s] %s → %s" % (path, name, line, "；".join(d)))
                else:
                    ok += 1
        return ok, diffs

    # ── B/C/D 新实现 vs 四份原文 ───────────────────────────────────
    ok, diffs = compare_all(call, TIMEOUT, "lark_http.call")
    if diffs:
        for d in diffs:
            fails.append(("B 行为等价", d))
    else:
        n_pass += 1
        if verbose:
            print("B/C/D %d 组样本（%d 份原文 × %d 个形状）逐字段等价；"
                  "超时只变长；错误串是旧值的扩展"
                  % (ok, len(olds), len(_SCENARIOS)))

    # ── E 反向对照：把新实现故意改坏，必须有一样红 ─────────────────
    bad_cases = []

    def _mk_default_errmax_zero():
        """坏样本 E1：HTTP 错误体截断成 0 字 —— body 不再是旧值的扩展。"""
        def bad(url, payload=None, token=None, method=None):
            data = json.dumps(payload).encode() if payload is not None else None
            r = urllib.request.Request(url, data=data,
                                       method=method or ("POST" if data else "GET"))
            r.add_header("Content-Type", "application/json; charset=utf-8")
            if token:
                r.add_header("Authorization", "Bearer " + token)
            try:
                with urllib.request.urlopen(r, timeout=TIMEOUT) as x:
                    return json.loads(x.read())
            except urllib.error.HTTPError as e:
                return {"_http": e.code, "body": ""}          # ★ 坏
            except Exception as e:                            # noqa: BLE001
                return {"_err": f"{type(e).__name__}: {e}"}
        return bad

    def _mk_drop_content_type():
        """坏样本 E2：少了 Content-Type 头。"""
        def bad(url, payload=None, token=None, method=None):
            data = json.dumps(payload).encode() if payload is not None else None
            r = urllib.request.Request(url, data=data,
                                       method=method or ("POST" if data else "GET"))
            if token:
                r.add_header("Authorization", "Bearer " + token)
            try:
                with urllib.request.urlopen(r, timeout=TIMEOUT) as x:
                    return json.loads(x.read())
            except urllib.error.HTTPError as e:
                return {"_http": e.code, "body": e.read().decode()[:ERR_BODY_MAX]}
            except Exception as e:                            # noqa: BLE001
                return {"_err": f"{type(e).__name__}: {e}"}
        return bad

    def _mk_httpcode_shape():
        """坏样本 E3：HTTP 错误返回 {"code": ...} 而不是 {"_http": ...}。"""
        def bad(url, payload=None, token=None, method=None):
            data = json.dumps(payload).encode() if payload is not None else None
            r = urllib.request.Request(url, data=data,
                                       method=method or ("POST" if data else "GET"))
            r.add_header("Content-Type", "application/json; charset=utf-8")
            if token:
                r.add_header("Authorization", "Bearer " + token)
            try:
                with urllib.request.urlopen(r, timeout=TIMEOUT) as x:
                    return json.loads(x.read())
            except urllib.error.HTTPError as e:
                return {"code": e.code, "msg": e.read().decode()[:ERR_BODY_MAX]}  # ★ 坏
            except Exception as e:                            # noqa: BLE001
                return {"_err": f"{type(e).__name__}: {e}"}
        return bad

    bad_cases = [
        ("E1 错误体截断成 0 字 → B/D 必须红", _mk_default_errmax_zero(), TIMEOUT),
        ("E2 少了 Content-Type 头 → B 必须红", _mk_drop_content_type(), TIMEOUT),
        ("E3 HTTP 错误形状变成 {\"code\": ...} → B 必须红", _mk_httpcode_shape(), TIMEOUT),
        ("E4 把超时调成 30（比原族的 60 短）→ C 必须红", call, 30.0),
    ]
    for label, fn, to in bad_cases:
        _ok, d = compare_all(fn, to, label)
        if d:
            n_pass += 1
            if verbose:
                print("  ✅ %s（检出 %d 组差异，例：%s）" % (label, len(d), d[0][:110]))
        else:
            fails.append(("E 反向对照", "%s —— 喂了坏实现却**一组差异都没检出**，"
                                       "说明 B/C/D 是恒真的，等于没有" % label))

    return n_pass, fails


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if "--controls" not in argv:
        print(__doc__)
        print("本模块是库，不是 CLI。自证入口：python3 tools/lark_http.py --controls")
        return 0
    print("=" * 72)
    print("lark_http 自证 —— 收编没改行为 + 漂移会被挡（离线，零网络）")
    print("=" * 72)
    n_pass, fails = controls()
    print("-" * 72)
    print("通过 %d 项 · 不通过 %d 项" % (n_pass, len(fails)))
    for label, why in fails:
        print("  ❌ [%s] %s" % (label, why))
    if fails:
        print("\n❌ 收编改变了行为，或者反向对照没红 —— 两者都不能放行。")
        return 1
    print("\n✅ 4 份原文可重建；%d 组样本逐字段等价；超时只变长；"
          "4 个坏实现都被检出。" % (len(_OLD_SPECS) * len(_SCENARIOS)))
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main())

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
shouheng.py —— 守衡 Feishu/Lark 客户端（0 依赖，仅标准库）

★ 定位：这是**能力层**，不是产品层。产品形态（TUI / 卡片 / 工作流）建在它上面。
   所有方法只做一件事：把一次开放平台调用变成一次可复算的函数调用。

凭据：~/.dsh/credentials/shouheng-lark.json（0600，不入库）
   { "app_id": ..., "app_secret": ..., "app_name": "守衡" }

用法：
  from shouheng import Shouheng
  s = Shouheng()
  s.chats()                       # 机器人所在群
  s.send_text(chat_id, "...")
  s.send_card(chat_id, card)      # schema 2.0 交互卡片
  s.upload_file(path)             # 上传素材 → file_key
  s.send_file(chat_id, path)
  s.pin(message_id)
  s.react(message_id, "OnIt")

命令行自检：
  python3 tools/shouheng.py --selftest     # 探测本应用实际可用的能力面
"""
from __future__ import annotations

import json
import pathlib
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = "https://open.feishu.cn/open-apis"
CRED = pathlib.Path.home() / ".dsh" / "credentials" / "shouheng-lark.json"


class FeishuError(RuntimeError):
    """开放平台返回非 0 code。保留 code/msg 以便定位是权限问题还是参数问题。"""

    def __init__(self, code, msg, payload=None):
        super().__init__(f"[{code}] {msg}")
        self.code = code
        self.msg = msg
        self.payload = payload or {}


class Shouheng:
    def __init__(self, cred_path: pathlib.Path = CRED):
        c = json.loads(pathlib.Path(cred_path).read_text())
        self.app_id = c["app_id"]
        self.app_secret = c["app_secret"]
        self.app_name = c.get("app_name", "守衡")
        self._tok = None
        self._exp = 0.0

    # ------------------------------------------------------------- 传输层
    def _request(self, method, url, payload=None, *, raw=None, ctype=None, auth=True):
        data = None
        headers = {}
        if raw is not None:
            data = raw
            headers["Content-Type"] = ctype or "application/octet-stream"
        elif payload is not None:
            data = json.dumps(payload, ensure_ascii=False).encode()
            headers["Content-Type"] = "application/json; charset=utf-8"
        if auth:
            headers["Authorization"] = "Bearer " + self.token()
        req = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            return json.load(urllib.request.urlopen(req, timeout=30))
        except urllib.error.HTTPError as e:            # 4xx 也带 JSON body，别丢
            body = e.read().decode(errors="replace")
            try:
                return json.loads(body)
            except json.JSONDecodeError:
                raise FeishuError(e.code, f"HTTP {e.code}: {body[:200]}") from None

    def call(self, method, path, payload=None, **kw):
        """业务调用：非 0 code 直接抛，避免静默失败被当成成功。"""
        r = self._request(method, BASE + path, payload, **kw)
        if r.get("code") != 0:
            raise FeishuError(r.get("code"), r.get("msg"), r)
        return r.get("data") or {}

    def try_call(self, method, path, payload=None, **kw):
        """探测调用：返回 (ok, data_or_error)。用于 --selftest，不抛。"""
        r = self._request(method, BASE + path, payload, **kw)
        if r.get("code") != 0:
            return False, {"code": r.get("code"), "msg": r.get("msg")}
        return True, r.get("data") or {}

    # ------------------------------------------------------------- 鉴权
    def token(self, refresh=False):
        if not refresh and self._tok and time.time() < self._exp:
            return self._tok
        r = self._request("POST", BASE + "/auth/v3/tenant_access_token/internal",
                          {"app_id": self.app_id, "app_secret": self.app_secret}, auth=False)
        if r.get("code") != 0:
            raise FeishuError(r.get("code"), r.get("msg"), r)
        self._tok = r["tenant_access_token"]
        self._exp = time.time() + int(r.get("expire", 7200)) - 120   # 留 2 分钟余量
        return self._tok

    # ------------------------------------------------------------- 会话
    def chats(self):
        return self.call("GET", "/im/v1/chats?page_size=100").get("items", [])

    def chat(self, chat_id):
        return self.call("GET", f"/im/v1/chats/{chat_id}")

    def members(self, chat_id):
        return self.call("GET", f"/im/v1/chats/{chat_id}/members?member_id_type=open_id&page_size=100").get("items", [])

    def find_user(self, name, chat_id=None):
        """按姓名在群成员里找 open_id（机器人拿不到通讯录全量时最实用的路径）。"""
        for m in self.members(chat_id):
            if m.get("name") == name:
                return m
        return None

    # ------------------------------------------------------------- 消息
    def send_text(self, chat_id, text, *, receive_id_type="chat_id"):
        return self.call("POST", f"/im/v1/messages?receive_id_type={receive_id_type}",
                         {"receive_id": chat_id, "msg_type": "text",
                          "content": json.dumps({"text": text}, ensure_ascii=False)})

    def send_card(self, chat_id, card, *, receive_id_type="chat_id"):
        return self.call("POST", f"/im/v1/messages?receive_id_type={receive_id_type}",
                         {"receive_id": chat_id, "msg_type": "interactive",
                          "content": json.dumps(card, ensure_ascii=False)})

    def get_message(self, message_id):
        items = self.call("GET", f"/im/v1/messages/{message_id}").get("items", [])
        return items[0] if items else None

    def recall(self, message_id):
        return self.call("DELETE", f"/im/v1/messages/{message_id}")

    def react(self, message_id, emoji="OnIt"):
        return self.call("POST", f"/im/v1/messages/{message_id}/reactions",
                         {"reaction_type": {"emoji_type": emoji}})

    def pin(self, message_id):
        return self.call("POST", "/im/v1/pins", {"message_id": message_id})

    # ------------------------------------------------------------- 素材
    def upload_image(self, path):
        import uuid
        body, ctype = _multipart(
            {"image_type": "message"},
            {"image": (pathlib.Path(path).name, pathlib.Path(path).read_bytes())},
            boundary=uuid.uuid4().hex)
        return self.call("POST", "/im/v1/images", raw=body, ctype=ctype)

    def upload_file(self, path):
        import uuid
        p = pathlib.Path(path)
        body, ctype = _multipart(
            {"file_type": "stream", "file_name": p.name},
            {"file": (p.name, p.read_bytes())},
            boundary=uuid.uuid4().hex)
        return self.call("POST", "/im/v1/files", raw=body, ctype=ctype)

    def send_file(self, chat_id, path):
        fk = self.upload_file(path).get("file_key")
        return self.call("POST", f"/im/v1/messages?receive_id_type=chat_id",
                         {"receive_id": chat_id, "msg_type": "file",
                          "content": json.dumps({"file_key": fk})})

    # ------------------------------------------------------------- 卡片工具
    @staticmethod
    def card(title, elements, *, template="blue", subtitle=None, width="fill"):
        """schema 2.0 卡片。已实测支持：markdown / hr / collapsible_panel /
        column_set / button / table / header；**不支持** note 与 action 容器。"""
        c = {"schema": "2.0", "config": {"update_multi": True, "width_mode": width},
             "header": {"template": template, "title": {"tag": "plain_text", "content": title}},
             "body": {"elements": elements}}
        if subtitle:
            c["header"]["subtitle"] = {"tag": "plain_text", "content": subtitle}
        return c


def _multipart(fields, files, boundary):
    """最小 multipart/form-data 编码器（避免为一次上传引入 requests）。"""
    out = bytearray()
    for k, v in fields.items():
        out += f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode()
    for k, (fn, blob) in files.items():
        out += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"; filename=\"{fn}\"\r\n"
                f"Content-Type: application/octet-stream\r\n\r\n").encode()
        out += blob + b"\r\n"
    out += f"--{boundary}--\r\n".encode()
    return bytes(out), f"multipart/form-data; boundary={boundary}"


# ------------------------------------------------------------------ 自检
def main():
    s = Shouheng()
    print("=" * 78)
    print("守衡 · 能力面自检")
    print("=" * 78)
    print(f"  app_id    = {s.app_id}")
    print(f"  app_name  = {s.app_name}")
    tok = s.token(refresh=True)
    print(f"  token     = 已获取（{len(tok)} 字符）")

    bot = s._request("GET", BASE + "/bot/v3/info")
    b = bot.get("bot") or {}
    print(f"  bot       = {b.get('app_name')} / {b.get('open_id')} / activate={b.get('activate_status')}")

    chats = s.chats()
    print(f"\n  所在群 {len(chats)} 个：")
    targets = []
    for c in chats:
        ms = s.members(c["chat_id"])
        names = "、".join(m.get("name", "?") for m in ms)
        print(f"    · {c.get('name')}  [{c.get('chat_id')}]  {len(ms)} 人：{names}")
        targets.append((c, ms))

    if not targets:
        print("  ✗ 机器人不在任何群里，无法继续自检")
        return 1

    chat, members = targets[0]
    cid = chat["chat_id"]

    # ★ 只读探测优先。「探测即产生副作用」的教训：本轮首跑时
    #   `POST /bitable/v1/apps` 真的在租户里建出了一张多维表格（已删除）。
    #   所以这里默认只跑只读项，写权限探测必须显式 --write-probe 才执行。
    checks = [
        ("读消息",     lambda: s.try_call("GET", f"/im/v1/messages/{_probe_mid(s, cid)}")),
        ("群信息",     lambda: s.try_call("GET", f"/im/v1/chats/{cid}")),
        ("群成员",     lambda: s.try_call("GET", f"/im/v1/chats/{cid}/members?member_id_type=open_id&page_size=10")),
        ("云空间列表", lambda: s.try_call("GET", "/drive/v1/files?page_size=1")),
        ("文档搜索",   lambda: s.try_call("POST", "/suite/docs-api/search/object", {"search_key": "守衡", "count": 1})),
        ("wiki 空间",  lambda: s.try_call("GET", "/wiki/v2/spaces?page_size=1")),
        ("根目录元信息", lambda: s.try_call("GET", "/drive/explorer/v2/root_folder/meta")),
        ("通讯录读用户", lambda: s.try_call("GET", "/contact/v3/users/" + (members[0]["member_id"] if members else "x")
                                           + "?user_id_type=open_id")),
        ("日历列表",   lambda: s.try_call("GET", "/calendar/v4/calendars")),
        ("任务列表",   lambda: s.try_call("GET", "/task/v2/tasks?page_size=1")),
        ("审批定义",   lambda: s.try_call("GET", "/approval/v4/approvals?page_size=1")),
    ]
    print("\n  能力探测（只读；★ 权限不足返回 99991672/99991663 属正常，非 bug）：")
    results = {}
    for name, fn in checks:
        try:
            ok, data = fn()
        except Exception as e:                                    # noqa: BLE001
            ok, data = False, {"code": "EXC", "msg": str(e)[:70]}
        results[name] = ok
        mark = "✓" if ok else "✗"
        detail = "" if ok else f"  {data.get('code')} {str(data.get('msg'))[:78]}"
        print(f"    {mark} {name:12s}{detail}")

    print("\n  汇总：可用 " + "、".join(k for k, v in results.items() if v))
    ng = [k for k, v in results.items() if not v]
    if ng:
        print("        待开权限 " + "、".join(ng))

    if "--write-probe" in sys.argv:
        print("\n  ⚠ 写权限探测（会产生真实资源，用完即删）")
        ok, data = s.try_call("POST", "/drive/v1/files/create_folder", {"name": "守衡自检-可删", "folder_token": ""})
        print(f"    {'✓' if ok else '✗'} 建文件夹 {data if ok else data}")
        if ok and data.get("token"):
            ok2, _ = s.try_call("DELETE", f"/drive/v1/files/{data['token']}?type=folder")
            print(f"    {'✓' if ok2 else '✗'} 删除文件夹")
    return 0


def _probe_mid(s, cid):
    """发一条探测消息拿 message_id（用于验证「读消息」能力），用完立即撤回。"""
    mid = s.send_text(cid, "〔守衡自检〕临时探测消息")["message_id"]
    s.recall(mid)
    return mid


if __name__ == "__main__":
    sys.exit(main())

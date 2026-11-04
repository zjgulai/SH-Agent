"""用户确认的飞书资源停读策略；每次使用重读文件，损坏或丢失时拒绝读取。"""
from __future__ import annotations

import json
import re
from pathlib import Path
from urllib.parse import unquote, urlparse

POLICY_PATH = Path(__file__).resolve().parents[1] / "research/feishu/停读清单-v1.json"


class ReadPolicyError(RuntimeError):
    """策略无法确认时停止读取，不能当作空名单。"""


class ResourceReadStopped(ReadPolicyError):
    stopped = True

    def __init__(self, resource):
        self.resource = resource
        super().__init__(f"已按用户确认停止读取《{resource['name']}》")


def load_policy(path=None):
    try:
        with open(path if path is not None else POLICY_PATH, encoding="utf-8") as handle:
            policy = json.load(handle)
        if not isinstance(policy, dict) or type(policy.get("schema_version")) is not int or policy["schema_version"] != 1:
            raise ValueError("schema_version 必须为 1")
        resources = policy.get("resources")
        if not isinstance(resources, list):
            raise ValueError("resources 必须为列表")
        seen = set()
        for entry in resources:
            if not isinstance(entry, dict) or not isinstance(entry.get("name"), str) or not entry["name"].strip():
                raise ValueError("停读条目缺少名称")
            if not isinstance(entry.get("url"), str) or not entry["url"].strip():
                raise ValueError("停读条目缺少链接")
            tokens = entry.get("tokens")
            if not isinstance(tokens, list) or not tokens:
                raise ValueError("停读条目缺少 token")
            for token in tokens:
                if not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9]{8,}", token):
                    raise ValueError("停读 token 格式无效")
                if token in seen:
                    raise ValueError("停读 token 重复")
                seen.add(token)
        return policy
    except (OSError, ValueError, TypeError) as exc:
        raise ReadPolicyError(f"停读清单无法读取或校验失败，暂不读取飞书资源：{exc}") from exc


def _tokens(value):
    if isinstance(value, dict):
        return set().union(*(_tokens(value.get(key)) for key in
                            ("token", "obj_token", "node_token", "url")))
    text = str(value or "").strip()
    if re.fullmatch(r"[A-Za-z0-9]{8,}", text):
        return {text}
    try:
        parsed = urlparse(text)
        if parsed.scheme not in ("http", "https"):
            return set()
        host = (parsed.hostname or "").lower()
        if not any(host == base or host.endswith("." + base)
                   for base in ("feishu.cn", "larksuite.com", "larkoffice.com")):
            return set()
        parts = [unquote(part) for part in parsed.path.split("/") if part]
        return {parts[1]} if len(parts) >= 2 else set()
    except ValueError:
        return set()


def blocked_resource(value, policy=None):
    policy = load_policy() if policy is None else policy
    tokens = _tokens(value)
    return next((entry for entry in policy["resources"]
                 if tokens.intersection(entry["tokens"])), None)


def assert_read_allowed(value, policy=None):
    resource = blocked_resource(value, policy)
    if resource is not None:
        raise ResourceReadStopped(resource)


def filter_entries(entries, policy=None):
    policy = load_policy() if policy is None else policy
    allowed, excluded, seen = [], [], set()
    for entry in entries:
        stopped = blocked_resource(entry, policy)
        if stopped is None:
            allowed.append(entry)
        elif stopped["tokens"][0] not in seen:
            seen.add(stopped["tokens"][0])
            excluded.append({key: stopped[key] for key in ("name", "url", "tokens") if key in stopped})
    return allowed, excluded

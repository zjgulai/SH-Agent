#!/usr/bin/env python3
"""外部标准库与周更通知的唯一允许目标；策略读不到时拒绝发送。"""
import argparse
import json
from pathlib import Path
import re
import sys

POLICY_PATH = Path(__file__).with_name("push-policy.json")
# 用户授权边界：登记文件也不能把格式合法的其他群/私聊伪装成测试群。
AUTHORIZED_CHAT = "oc_TEST_GROUP"


def resolve_push_target(requested=None):
    """未指定目标时使用策略群；显式目标必须精确相等，不自动改投。"""
    try:
        policy = json.loads(POLICY_PATH.read_text(encoding="utf-8"))
        if (not isinstance(policy, dict) or type(policy.get("version")) is not int
                or policy["version"] != 1
                or not isinstance(policy.get("chat_id"), str)
                or re.fullmatch(r"oc_[a-f0-9]{32}", policy["chat_id"]) is None
                or policy["chat_id"] != AUTHORIZED_CHAT
                or policy.get("chat_name") != "内容治理-守衡Agent-测试"):
            raise ValueError("策略字段不完整或格式不正确")
    except (OSError, ValueError, TypeError) as exc:
        raise ValueError("拒绝发送：推送策略不可用（%s）" % exc) from exc
    if requested is not None and requested != policy["chat_id"]:
        raise ValueError("拒绝发送：目标 %r 不在白名单，只允许 %s（%s）"
                         % (requested, policy["chat_name"], policy["chat_id"]))
    return policy["chat_id"]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--chat", help="可省略；显式目标必须与策略群一致")
    args = ap.parse_args()
    try:
        print(resolve_push_target(args.chat))
        return 0
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 4


if __name__ == "__main__":
    sys.exit(main())

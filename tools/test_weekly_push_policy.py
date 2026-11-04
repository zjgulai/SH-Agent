#!/usr/bin/env python3
"""周更三条发送腿的真实入口测试；transport 全打桩，既不发消息也不推 Git。"""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock
import push_policy

REPO = Path(__file__).resolve().parents[1]
KB_ROOT = Path(os.environ.get("WEEKLY_POLICY_KB_ROOT") or REPO / "内容治理知识库")
ALLOWED = "oc_TEST_GROUP"
PRIVATE = "oc_TEST_P2P"


def load(name):
    path = KB_ROOT / "kb/l8" / (name + ".py")
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


DIGEST = load("daily_digest")
WATCH = load("watch_review_readiness")


class WeeklyPushPolicyTests(unittest.TestCase):
    def sender(self, module, method, chat, force=False):
        calls = []
        env = {"KB_DIGEST_FORCE_SEND": "1" if force else "0",
               "KB_ALERT_FORCE_SEND": "1" if force else "0"}
        def transport(argv, **kwargs):
            calls.append(argv)
            return types.SimpleNamespace(returncode=0, stdout="{}", stderr="")
        with mock.patch.dict(os.environ, env), \
                mock.patch.object(module, "LARK", sys.executable), \
                mock.patch.object(module.subprocess, "run", side_effect=transport), \
                contextlib.redirect_stdout(io.StringIO()):
            ok, reason = getattr(module, method)("**周更测试**", chat)
        return ok, reason, calls

    def test_digest_accepts_only_test_group_at_real_sender(self):
        for chat in (ALLOWED, None, PRIVATE, "oc_other", "", " " + ALLOWED):
            with self.subTest(chat=chat):
                ok, why, calls = self.sender(DIGEST, "send", chat)
                if chat in (ALLOWED, None):
                    self.assertTrue(ok, why)
                    self.assertEqual(len(calls), 1)
                    self.assertEqual(calls[0][calls[0].index("--chat-id") + 1], ALLOWED)
                    self.assertEqual(calls[0][-1], "周更测试")
                else:
                    self.assertFalse(ok, why)
                    self.assertIn("拒绝", why)
                    self.assertEqual(calls, [])

    def test_readiness_accepts_only_test_group_at_real_sender(self):
        for chat in (ALLOWED, None, PRIVATE, "oc_other", ""):
            with self.subTest(chat=chat):
                ok, why, calls = self.sender(WATCH, "alert", chat)
                if chat in (ALLOWED, None):
                    self.assertTrue(ok, why)
                    self.assertEqual(len(calls), 1)
                    self.assertEqual(calls[0][calls[0].index("--chat-id") + 1], ALLOWED)
                else:
                    self.assertFalse(ok, why)
                    self.assertIn("拒绝", why)
                    self.assertEqual(calls, [])

    def test_selftest_mode_does_not_turn_denied_target_into_success(self):
        for module, method in ((DIGEST, "send"), (WATCH, "alert")):
            with self.subTest(sender=method):
                ok, why, calls = self.sender(module, method, PRIVATE, force=True)
                self.assertFalse(ok, why)
                self.assertEqual(calls, [])

    def test_missing_malformed_or_retargeted_policy_blocks_python_senders(self):
        fixtures = (None, "{}", "{", json.dumps({"version": 1, "chat_id": PRIVATE,
                    "chat_name": "内容治理-守衡Agent-测试"}),
                    json.dumps({"version": 1, "chat_id": "oc_" + "f" * 32,
                    "chat_name": "内容治理-守衡Agent-测试"}),
                    json.dumps({"version": 1, "chat_id": ALLOWED, "chat_name": "其他群"}))
        with tempfile.TemporaryDirectory(prefix="weekly-policy-file-") as tmp:
            policy = Path(tmp) / "policy.json"
            for fixture in fixtures:
                if fixture is None:
                    policy.unlink(missing_ok=True)
                else:
                    policy.write_text(fixture, encoding="utf-8")
                for module, method in ((DIGEST, "send"), (WATCH, "alert")):
                    with self.subTest(fixture=fixture, sender=method), \
                            mock.patch.object(push_policy, "POLICY_PATH", policy):
                        ok, why, calls = self.sender(module, method, None)
                        self.assertFalse(ok, why)
                        self.assertIn("拒绝", why)
                        self.assertEqual(calls, [])

    def digest_main(self, args, env_chat=None):
        fixture = {"align": {}, "five": []}
        calls = []
        def transport(argv, **kwargs):
            calls.append(argv)
            return types.SimpleNamespace(returncode=0, stdout="{}", stderr="")
        env = {"KB_DIGEST_CHAT": env_chat or "", "KB_DIGEST_FORCE_SEND": "0"}
        safe_write = types.SimpleNamespace(write_text=lambda *args: None)
        with mock.patch.dict(os.environ, env), \
                mock.patch.object(sys, "argv", ["daily_digest", "fixture", "--push"] + args), \
                mock.patch.object(DIGEST, "build", return_value=fixture), \
                mock.patch.object(DIGEST, "render_md", return_value="md"), \
                mock.patch.object(DIGEST, "render_push", return_value="周更"), \
                mock.patch.object(DIGEST, "_pushed_today", return_value=(False, None)), \
                mock.patch.object(DIGEST, "_remember_push") as remember, \
                mock.patch.object(DIGEST, "LARK", sys.executable), \
                mock.patch.object(DIGEST.subprocess, "run", side_effect=transport), \
                mock.patch.dict(sys.modules, {"_safe_write": safe_write}), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            rc = DIGEST.main()
        return rc, calls, remember.call_count, output.getvalue()

    def test_digest_cli_and_environment_cannot_bypass_sender_or_consume_dedup(self):
        for args, env in ((["--chat", PRIVATE], None), ([], PRIVATE),
                          (["--chat", "oc_other", "--force"], None)):
            with self.subTest(args=args, env=env):
                rc, calls, remembered, output = self.digest_main(args, env)
                self.assertEqual(rc, 4, output)
                self.assertEqual(calls, [])
                self.assertEqual(remembered, 0)
                self.assertIn("拒绝", output)

    def test_digest_default_sends_once_and_remembers_actual_group(self):
        rc, calls, remembered, output = self.digest_main([])
        self.assertEqual(rc, 0, output)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][calls[0].index("--chat-id") + 1], ALLOWED)
        self.assertEqual(remembered, 1)

    def test_readiness_cli_environment_default_and_no_false_cooldown(self):
        checks = ("check_claim", "check_credential", "check_freshness", "check_skill_links",
                  "check_layer_gates", "check_l5_stamp", "check_agents_drift",
                  "check_regression_drift", "check_drift_checker_selftest",
                  "check_l1_index_rebuilt", "check_credential_horizon",
                  "check_post_daily_writes", "check_report_link_permissions")
        for args, env_chat, allowed in (([], "", True), ([], PRIVATE, False),
                                       (["--chat", "oc_other"], "", False)):
            with self.subTest(args=args, env_chat=env_chat), contextlib.ExitStack() as stack:
                for name in checks:
                    stack.enter_context(mock.patch.object(WATCH, name, return_value=(True, {})))
                stack.enter_context(mock.patch.object(WATCH, "check_weekly_run_ran",
                                                      return_value=(None, {"reason": "fixture"})))
                stack.enter_context(mock.patch.object(WATCH, "should_alert", return_value=(True, "fixture")))
                remember = stack.enter_context(mock.patch.object(WATCH, "remember"))
                heal = stack.enter_context(mock.patch.object(WATCH, "attempt_heal"))
                stack.enter_context(mock.patch.dict(os.environ, {"KB_ALERT_CHAT": env_chat,
                                                                 "KB_ALERT_FORCE_SEND": "0"}))
                stack.enter_context(mock.patch.object(sys, "argv", ["watch", "--json", "--no-heal"] + args))
                stack.enter_context(mock.patch.object(WATCH, "LARK", sys.executable))
                transport = stack.enter_context(mock.patch.object(WATCH.subprocess, "run", return_value=
                                                types.SimpleNamespace(returncode=0, stdout="{}", stderr="")))
                output = stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
                WATCH.main()
                # 正文收口会打印诊断行；JSON 是最后一个完整对象。
                result = json.loads(output.getvalue()[output.getvalue().index("{\n"):])
                self.assertEqual(result["alert"]["sent"], allowed, result)
                self.assertEqual(remember.call_count, int(allowed))
                self.assertEqual(transport.call_count, int(allowed))
                heal.assert_not_called()
                if allowed:
                    argv = transport.call_args[0][0]
                    self.assertEqual(argv[argv.index("--chat-id") + 1], ALLOWED)
                else:
                    self.assertIn("拒绝", result["alert"]["info"])

    def shell_notify(self, chat=None, policy="valid"):
        with tempfile.TemporaryDirectory(prefix="weekly-push-policy-") as tmp:
            tmp = Path(tmp)
            tools_dir = tmp / "tools"
            tools_dir.mkdir()
            for name in ("daily_git_push.sh", "push_policy.py", "push-policy.json"):
                source = REPO / "tools" / name
                if source.exists():
                    shutil.copyfile(source, tools_dir / name)
            if policy == "missing":
                (tools_dir / "push-policy.json").unlink(missing_ok=True)
            elif policy == "invalid":
                (tools_dir / "push-policy.json").write_text("{}", encoding="utf-8")
            attempts = tmp / "attempts.jsonl"
            stub = tmp / "lark-stub"
            stub.write_text("#!" + sys.executable + "\nimport json, os, sys\n"
                            "with open(os.environ['WEEKLY_ATTEMPTS'], 'a') as f: "
                            "f.write(json.dumps(sys.argv[1:]) + '\\n')\n", encoding="utf-8")
            stub.chmod(0o755)
            env = dict(os.environ, LARK_CLI=str(stub), KB_ALERT_FORCE_SEND="0",
                       WEEKLY_ATTEMPTS=str(attempts),
                       DAILY_GIT_PUSH_LEDGER=str(tmp / "ledger.ndjson"))
            env.pop("DAILY_GIT_PUSH_CHAT", None)
            if chat is not None:
                env["DAILY_GIT_PUSH_CHAT"] = chat
            result = subprocess.run(["bash", str(tools_dir / "daily_git_push.sh"),
                                     "--repo", str(tmp / "not-a-repo"), "--why", "policy-test"],
                                    capture_output=True, text=True, env=env)
            sent = [json.loads(line) for line in attempts.read_text().splitlines()] if attempts.exists() else []
            ledger = (tmp / "ledger.ndjson").read_text()
            return result.returncode, result.stdout + result.stderr, sent, ledger

    def test_git_alert_default_and_explicit_test_group(self):
        for chat in (None, ALLOWED):
            with self.subTest(chat=chat):
                rc, output, sent, _ = self.shell_notify(chat)
                self.assertEqual(rc, 2, output)  # 原来的 not-a-repo 读数不变。
                self.assertEqual(len(sent), 1, output)
                self.assertEqual(sent[0][sent[0].index("--chat-id") + 1], ALLOWED)

    def test_git_alert_rejects_other_groups_and_private_chat(self):
        for chat in (PRIVATE, "oc_other"):
            with self.subTest(chat=chat):
                rc, output, sent, ledger = self.shell_notify(chat)
                self.assertEqual(rc, 2, output)
                self.assertEqual(sent, [])
                self.assertIn("拒绝", output)
                self.assertIn("alert-target-denied", ledger)

    def test_git_alert_missing_or_invalid_policy_cannot_fallback(self):
        for policy in ("missing", "invalid"):
            with self.subTest(policy=policy):
                rc, output, sent, ledger = self.shell_notify(policy=policy)
                self.assertEqual(rc, 2, output)
                self.assertEqual(sent, [])
                self.assertIn("拒绝", output)
                self.assertIn("alert-target-denied", ledger)


if __name__ == "__main__":
    unittest.main(verbosity=2)

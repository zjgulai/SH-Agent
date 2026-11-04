#!/usr/bin/env python3
"""停读策略行为测试：只给网络边界喂桩，不读取凭据或请求飞书。"""
import copy
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import feishu_index as index
import feishu_read_policy as policy


STOPPED = "C2cYbj5AOaJ9RlsWViYcSCdcnFc"
ALLOWED = "AllowedResourceToken123"


class ReadPolicyTests(unittest.TestCase):
    def test_wiki_alias_and_underlying_object_both_stopped(self):
        for token in ("Ils1w4cIxi8hV9kJNymchtQbnvd", "Y09adG0G4oxJhVx2iNUcG2yPnyc",
                      "O0eSwsYK3iAvEdkme5QcjVq5nDd", "PEi0bfY0jaADBusISMBcf51Angh"):
            with self.subTest(token=token):
                with self.assertRaises(policy.ResourceReadStopped):
                    policy.assert_read_allowed("https://momcozy-in.feishu.cn/wiki/" + token + "?table=x")
        self.assertIsNone(policy.blocked_resource("https://feishu.cn.evil.example/wiki/" + STOPPED))

    def test_policy_is_reread_without_process_restart(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "policy.json"
            path.write_text(json.dumps({"schema_version": 1, "resources": []}))
            with patch.object(policy, "POLICY_PATH", path):
                policy.assert_read_allowed(ALLOWED)
                path.write_text(json.dumps({"schema_version": 1, "resources": [{
                    "name": "新停读", "url": "https://momcozy-in.feishu.cn/docx/" + ALLOWED,
                    "tokens": [ALLOWED]}]}))
                with self.assertRaises(policy.ResourceReadStopped):
                    policy.assert_read_allowed(ALLOWED)

    def test_missing_or_broken_policy_stops_before_auth_or_network(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "policy.json"
            for body in (None, "{broken", '{"schema_version": 1}',
                         '{"schema_version": 1, "resources": [{"name":"x", "tokens":["Token1234"]}]}'):
                with self.subTest(body=body):
                    if body is not None:
                        path.write_text(body)
                    with patch.object(policy, "POLICY_PATH", path), \
                         patch.object(index, "token_of") as auth, patch.object(index, "_get") as get:
                        with self.assertRaises(policy.ReadPolicyError):
                            index.build()
                        with self.assertRaises(policy.ReadPolicyError):
                            index.fetch_docx("unused", ALLOWED)
                    self.assertEqual(auth.call_count, 0)
                    self.assertEqual(get.call_count, 0)

    def test_direct_content_read_stops_before_network(self):
        # 去掉任意一个 fetch 入口的闸门，本例必须因网络请求/未停读而失败。
        for reader in (index.fetch_docx, index.fetch_sheet, index.fetch_bitable,
                       index.fetch_slide):
            with self.subTest(reader=reader.__name__):
                with patch.object(index, "_get", return_value={"code": 0, "data": {}}) as get:
                    with patch.object(index, "_post", return_value={"code": 0, "data": {}}):
                        result = reader("unused", STOPPED)
                self.assertEqual(get.call_count, 0, "停读对象不能发起网络读取")
                self.assertTrue(result.get("stopped"), result)

    def test_allowed_document_still_returns_content(self):
        with patch.object(index, "_get", return_value={"code": 0, "data": {"content": "仍需读取的正文"}}) as get:
            result = index.fetch_docx("unused", ALLOWED)
        self.assertEqual(result["text"], "仍需读取的正文")
        self.assertEqual(get.call_count, 1)

    def test_dispatch_and_metadata_paths_do_not_bypass_stop(self):
        entry = {"token": STOPPED, "type": "docx"}
        alias_entry = {"token": ALLOWED, "type": "docx",
                       "url": "https://momcozy-in.feishu.cn/base/" + STOPPED}
        with patch.object(index, "_get") as get, patch.object(index, "_post") as post:
            self.assertTrue(index.fetch_extent("unused", entry)["stopped"])
            self.assertTrue(index.fetch_extent("unused", alias_entry)["stopped"])
            metadata, err = index.fetch_meta("unused", entry)
            self.assertTrue(metadata["stopped"])
            self.assertIn("停止读取", err)
            self.assertEqual(index.fetch_metas_batch("unused", [entry]), ({}, []))
        self.assertEqual(get.call_count + post.call_count, 0)

    def test_rebuild_does_not_restore_stopped_resource(self):
        entries = {
            t: {"token": t, "title": name, "type": "docx", "owner": None, "hit_kw": ["知识库"]}
            for t, name in [(STOPPED, "IT 知识库"), (ALLOWED, "保留资源")]
        }
        contacts = {"visible": [], "visible_depts": [], "asked": 0, "resolved_n": 0,
                    "denied_n": 0, "named_n": 0, "denied_invalid": [], "denied_out_of_range": [],
                    "denied_other": [], "denied": []}
        seen = []
        def metas(_tok, resources):
            seen.extend(e["token"] for e in resources)
            return {e["token"]: {"url": "https://momcozy-in.feishu.cn/docx/" + e["token"]}
                    for e in resources}, []
        with patch.object(index, "token_of", return_value="unused"), \
             patch.object(index, "discover_search", return_value=(copy.deepcopy(entries), {}, {})), \
             patch.object(index, "discover_drive", return_value=([], None)), \
             patch.object(index, "discover_wiki", return_value=([], None)), \
             patch.object(index, "discover_chats", return_value=([], [], None)), \
             patch.object(index, "fetch_metas_batch", side_effect=metas), \
             patch.object(index, "fetch_meta", return_value=({"readable": True}, None)), \
             patch.object(index, "resolve_contacts", return_value=contacts), \
             patch.object(index, "fetch_extent", return_value={"ok": True, "chars": 2, "text": "正文"}):
            with contextlib.redirect_stdout(io.StringIO()):
                result = index.build()
        self.assertEqual([r["token"] for r in result["resources"]], [ALLOWED])
        self.assertEqual(seen, [ALLOWED], "停读资源不能进入元数据批量读取")
        self.assertEqual(result["stats"]["candidates"], 1)
        self.assertEqual(result["stats"]["policy_excluded"], 1)

    def test_offline_removal_preserves_collection_time_and_is_idempotent(self):
        original = json.loads(Path(index.INDEX_JSON).read_text())
        # Inject the excluded item even after the real index has already been cleaned.
        original["resources"].append({"token": STOPPED, "title": "旧索引停读内容", "type": "docx",
                                      "tier": "core", "domain": "tenant", "ownership": "org",
                                      "readable": True, "extent": {"ok": True, "text": "旧正文"}})
        original["links"].append({"url": "https://momcozy-in.feishu.cn/base/" + STOPPED})
        with patch.object(index, "_get") as get, patch.object(index, "_post") as post:
            cleaned = index.apply_read_policy(copy.deepcopy(original))
            again = index.apply_read_policy(copy.deepcopy(cleaned))
        self.assertEqual(get.call_count + post.call_count, 0)
        self.assertEqual(cleaned["generated_at"], original["generated_at"])
        self.assertNotIn(STOPPED, [e["token"] for e in cleaned["resources"]])
        self.assertNotIn("https://momcozy-in.feishu.cn/base/" + STOPPED,
                         [e["url"] for e in cleaned["links"]])
        self.assertEqual(cleaned["resources"], again["resources"])
        self.assertEqual(cleaned["stats"], again["stats"])


if __name__ == "__main__":
    unittest.main()

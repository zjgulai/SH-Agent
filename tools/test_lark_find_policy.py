#!/usr/bin/env python3
"""守衡的命令读取入口必须在取凭据/正文前遵守停读决定。"""
import contextlib
import io
import sys
import unittest
from unittest.mock import patch

import lark_find


class ReadPolicyTests(unittest.TestCase):
    def run_cli(self, args, response):
        out = io.StringIO()
        with patch.object(sys, 'argv', ['lark_find.py', *args]), \
                patch.object(lark_find, 'token', return_value='test-only') as auth, \
                patch.object(lark_find, '_req', return_value=response) as request, \
                contextlib.redirect_stdout(out):
            rc = lark_find.main()
        return rc, out.getvalue(), auth.call_count, request.call_count

    def test_stopped_commands_never_acquire_credentials_or_read(self):
        # 去掉入口闸门会让这些调用取得凭据并请求已停读资源。
        commands = [
            ['read', 'K5Ojb4AJBaqrMQslARpcaAXenub', 'bitable'],
            ['tables', 'HPiqbafDTaJV0vsCqD0c3m0UnAe'],
            ['fields', 'C2cYbj5AOaJ9RlsWViYcSCdcnFc', 'tblTest'],
            ['records', 'DcHpb4U8jaj4H4s6JE6cJu7PnUd', 'tblTest'],
            ['read', 'Shxzb64f5agvidsu0a8cxSpMntb', 'bitable'],
            ['wiki', 'Ils1w4cIxi8hV9kJNymchtQbnvd'],
            ['readdoc', 'Y09adG0G4oxJhVx2iNUcG2yPnyc'],
            ['wiki', 'O0eSwsYK3iAvEdkme5QcjVq5nDd'],
            ['tables', 'PEi0bfY0jaADBusISMBcf51Angh'],
        ]
        for args in commands:
            with self.subTest(args=args):
                rc, out, auth, requests = self.run_cli(args, {'code': 0, 'data': {}})
                self.assertEqual(rc, 2)
                self.assertIn('停读', out)
                self.assertEqual((auth, requests), (0, 0))

    def test_retained_document_still_returns_body(self):
        rc, out, auth, requests = self.run_cli(
            ['readdoc', 'W2KodnZP3orVrAxxn5OcbmKtnxh'],
            {'code': 0, 'data': {'content': '保留的需求正文'}})
        self.assertEqual((rc, out, auth, requests), (0, '保留的需求正文', 1, 1))

    def test_search_does_not_offer_stopped_source_again(self):
        rc, out, _, requests = self.run_cli(['search', '知识库'], {
            'code': 0, 'data': {'total': 2, 'docs_entities': [
                {'docs_type': 'bitable', 'docs_token': 'C2cYbj5AOaJ9RlsWViYcSCdcnFc', 'title': 'IT 知识库'},
                {'docs_type': 'bitable', 'docs_token': 'GnRZbIuXraCzf0sGr2UcmZ62nfc', 'title': '内容治理-知识库'},
            ]}})
        self.assertEqual(rc, 0)
        self.assertNotIn('C2cYbj5AOaJ9RlsWViYcSCdcnFc', out)
        self.assertIn('GnRZbIuXraCzf0sGr2UcmZ62nfc', out)
        self.assertEqual(requests, 1)


if __name__ == '__main__':
    unittest.main()

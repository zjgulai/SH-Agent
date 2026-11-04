#!/usr/bin/env python3
"""Machine consumers receive booleans without changing assertion truth values."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('verify_engine_contract.py')


class EngineContractJsonTest(unittest.TestCase):
    def test_check_normalizes_truthy_and_falsey_values_without_changing_the_verdict(self):
        spec = importlib.util.spec_from_file_location('engine_contract_under_test', SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        for value, expected in [('2026-10-30T11:58:51+00:00', True), ('', False),
                                (1, True), (0, False), (None, False),
                                ([], False), (['evidence'], True), (False, False)]:
            with self.subTest(value=value), contextlib.redirect_stdout(io.StringIO()):
                result = module.check('fixture', 'truth-value control', value)
                stored = module.RESULTS[-1][1]
                self.assertIs(type(stored), bool)
                self.assertIs(stored, expected)
                self.assertIs(result, expected)

    def test_real_v12_json_contains_only_boolean_ok_fields(self):
        with tempfile.TemporaryDirectory(prefix='engine-contract-json-') as tmp:
            process = subprocess.run([sys.executable, str(SCRIPT), '--json', '--only', 'V12'],
                                     cwd=SCRIPT.parent.parent,
                                     env=dict(os.environ, PYTHONPYCACHEPREFIX=tmp),
                                     text=True, capture_output=True, timeout=90)
        self.assertEqual(process.returncode, 0, process.stderr)
        result = json.loads(process.stdout)
        self.assertTrue(result['items'])
        self.assertTrue(all(type(item['ok']) is bool for item in result['items']), result['items'])
        self.assertIs(next(item for item in result['items'] if item['id'] == 'V12b')['ok'], True)
        self.assertEqual(result['passed'], sum(item['ok'] for item in result['items']))


if __name__ == '__main__':
    unittest.main()

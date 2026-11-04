#!/usr/bin/env python3
"""The combined verifier must distinguish an empty run from a passing run."""
import unittest
from verify_media_workflow import classify_result, overall_status


class ResultContract(unittest.TestCase):
    def test_zero_exit_without_completed_assertions_is_untested(self):
        self.assertEqual(classify_result(0, 'started', 'unittest')['status'], 'untested')

    def test_actual_completed_unittest_is_pass(self):
        self.assertEqual(classify_result(0, 'Ran 3 tests in 0.1s\n\nOK\n', 'unittest'),
                         {'status': 'pass', 'passed': 3, 'total': 3})

    def test_skips_and_zero_tests_are_not_pass(self):
        for output in ['Ran 0 tests in 0s\n\nOK', 'Ran 3 tests in 1s\n\nOK (skipped=1)']:
            self.assertEqual(classify_result(0, output, 'unittest')['status'], 'untested')

    def test_failure_cannot_be_overridden_by_old_green_text(self):
        self.assertEqual(classify_result(1, 'Ran 3 tests in 0.1s\n\nOK', 'unittest')['status'], 'fail')

    def test_unknown_exit_and_timeout_are_untested(self):
        for code in [None, 2, -9, 137]:
            self.assertEqual(classify_result(code, '', 'unittest')['status'], 'untested')

    def test_engine_json_requires_positive_count_and_every_item(self):
        good = '{"passed":1,"total":1,"items":[{"ok":true}]}'
        self.assertEqual(classify_result(0, good, 'engine')['status'], 'pass')
        for bad in ['{}', '{"passed":0,"total":0,"items":[]}',
                    '{"passed":1,"total":1,"items":[{"ok":false}]}']:
            self.assertNotEqual(classify_result(0, bad, 'engine')['status'], 'pass')

    def test_kb_skipped_is_untested_even_if_old_script_exits_zero(self):
        self.assertEqual(classify_result(0, '{"pass":true,"failed":0,"skipped":1,"checks":[]}', 'kb')['status'], 'untested')

    def test_empty_aggregate_and_unknown_are_never_green(self):
        self.assertEqual(overall_status([]), 'untested')
        self.assertEqual(overall_status([{'status': 'pass'}, {'status': 'untested'}]), 'untested')
        self.assertEqual(overall_status([{'status': 'fail'}, {'status': 'untested'}]), 'fail')
        self.assertEqual(overall_status([{'status': 'pass'}]), 'pass')

    def test_visual_source_checks_require_actual_positive_proofs(self):
        import json
        value = {'configured_rules': 3, 'source_errors': [],
                 'rules_sha256': 'a' * 64, 'source_checks': [{'verified': True}]}
        self.assertEqual(classify_result(0, json.dumps(value), 'visual_sources')['status'], 'pass')
        for changes in [{'source_checks': []}, {'source_checks': [{'verified': False}]},
                        {'source_errors': ['changed fingerprint']}, {'configured_rules': 0}]:
            self.assertNotEqual(classify_result(0, json.dumps({**value, **changes}), 'visual_sources')['status'], 'pass')

    def test_an_earlier_green_summary_cannot_hide_later_failures(self):
        output = '自证：通过 39 / 失败 0\n自证：通过 38 / 失败 1\n'
        self.assertEqual(classify_result(0, output, 'coverage')['status'], 'fail')

    def test_an_earlier_unittest_ok_cannot_hide_later_skips(self):
        output = 'Ran 3 tests in 0.1s\n\nOK\nRan 3 tests in 0.2s\n\nOK (skipped=1)\n'
        self.assertEqual(classify_result(0, output, 'unittest')['status'], 'untested')

    def test_replay_requires_positive_checks_and_final_success(self):
        self.assertEqual(classify_result(0, 'acceptance True checks 8\n', 'replay')['status'], 'pass')
        for output in ['acceptance True checks 0\n', 'acceptance False checks 8\n',
                       'acceptance True checks 8\nacceptance False checks 8\n']:
            self.assertEqual(classify_result(0, output, 'replay')['status'], 'fail')


if __name__ == '__main__':
    unittest.main()

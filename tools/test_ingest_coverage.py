#!/usr/bin/env python3
"""A success ledger line alone must never count as a readable KB entry."""
import copy
import contextlib
import datetime as dt
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import verify_ingest_coverage as coverage


class IngestCoverageTest(unittest.TestCase):
    def setUp(self):
        self.record = {'action': 'ingest', 'stage': 'ok', 'targets': ['entry'],
                       'source_ref': '/pmo/fix.md', 'source_fingerprint': 'abc'}
        self.entries = {'entry': {'source': {'ref': '/pmo/fix.md', 'fingerprint': 'abc'},
                                  'body': 'Actual evidence', 'manifest_ok': True}}

    def test_success_record_without_entry_is_not_ingested(self):
        self.assertFalse(coverage.verified_ingest(self.record, {}))

    def test_real_entry_and_matching_source_are_covered(self):
        self.assertTrue(coverage.verified_ingest(self.record, self.entries))

    def test_rejected_missing_empty_or_mismatched_entries_are_not_covered(self):
        for change in [{'body': ''}, {'manifest_ok': False},
                       {'source': {'ref': '/different.md', 'fingerprint': 'abc'}},
                       {'source': {'ref': '/pmo/fix.md', 'fingerprint': 'old'}}]:
            with self.subTest(change=change):
                entries = copy.deepcopy(self.entries)
                entries['entry'].update(change)
                self.assertFalse(coverage.verified_ingest(self.record, entries))
        for change in [{'action': 'rejected'}, {'stage': 'gate'}, {'targets': []},
                       {'targets': ['entry', 'missing']}, {'source_fingerprint': ''}]:
            with self.subTest(change=change):
                self.assertFalse(coverage.verified_ingest({**self.record, **change}, self.entries))

    def test_native_parser_keeps_provenance_anchor_from_frontmatter(self):
        with tempfile.TemporaryDirectory(prefix='sh-ingest-anchor-') as temporary:
            view = Path(temporary)
            entry = view / 'fixture' / 'L1' / 'entry.md'
            entry.parent.mkdir(parents=True)
            entry.write_text('---\nid: entry\nsource:\n  ref: /pmo/fix.md\n'
                             '  fingerprint: abc\nprovenance:\n'
                             '  anchor: /pmo/incident.md\n---\nActual evidence\n', encoding='utf-8')
            # Only the temporary view is written. Production parser and manifest
            # builder run without touching the real KB or any credentials.
            script = """
import {pathToFileURL} from 'node:url';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
const kb = await import(pathToFileURL(path.join(os.homedir(), '.dsh/plugins/dsh-kb/lib/kb.js')));
fs.mkdirSync(path.join(process.argv[1], '_meta'), {recursive:true});
kb.writeManifest(process.argv[1]);
"""
            subprocess.run(['node', '--input-type=module', '-e', script, str(view)],
                           check=True, capture_output=True, text=True, timeout=30)
            entries = coverage.readable_entries(view)
            self.assertTrue(entries['entry']['manifest_ok'])
            self.assertEqual(entries['entry'].get('provenance', {}).get('anchor'), '/pmo/incident.md')

    def _run_anchor_coverage(self, verified):
        with tempfile.TemporaryDirectory(prefix='sh-ingest-coverage-') as temporary:
            root = Path(temporary)
            pmo = root / 'PMO'
            pmo.mkdir()
            incident = pmo / 'incident.md'
            incident.write_text('Incident evidence', encoding='utf-8')
            ledger = root / '_meta' / 'ledger.ndjson'
            ledger.parent.mkdir()
            ledger.write_text(json.dumps({**self.record, 'ts': dt.datetime.now(dt.timezone.utc).isoformat()})
                              + '\n', encoding='utf-8')
            entries = copy.deepcopy(self.entries)
            entries['entry']['manifest_ok'] = verified
            entries['entry']['provenance'] = {'anchor': str(incident)}
            out = io.StringIO()
            with patch.object(coverage, 'PMO', pmo), patch.object(coverage, 'LEDGER', ledger), \
                 patch.object(coverage, 'readable_entries', return_value=entries), \
                 patch.object(sys, 'argv', ['verify_ingest_coverage.py', '--strict']), \
                 contextlib.redirect_stdout(out):
                status = coverage.main()
            return status, out.getvalue()

    def test_verified_frontmatter_anchor_covers_pmo_when_body_does_not_repeat_it(self):
        status, output = self._run_anchor_coverage(verified=True)
        self.assertEqual(status, 0, output)
        self.assertIn('✅ incident.md', output)

    def test_unverified_entry_cannot_fake_coverage_through_provenance_anchor(self):
        status, output = self._run_anchor_coverage(verified=False)
        self.assertEqual(status, 1, output)
        self.assertNotIn('✅ incident.md', output)


if __name__ == '__main__':
    unittest.main()

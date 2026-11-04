#!/usr/bin/env python3
"""Run the media workflow contracts sequentially, retaining truthful evidence.

This does not send Feishu messages, publish reports, ingest, or restart anything.
External model/publication boundaries in the integration tests are fixtures;
the local media probe, OCR, production rule engine and card rendering are real.
"""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time

REPO = Path(__file__).resolve().parent.parent
KB = Path.home() / '.dsh/Momcozy知识库/kb'


def classify_result(code, output, kind):
    if code in (1, 3):
        return {'status': 'fail', 'reason': 'assertion_failed', 'exit': code}
    if code != 0:
        return {'status': 'untested', 'reason': 'not_completed', 'exit': code}
    try:
        if kind == 'visual_sources':
            doc = json.loads(output)
            checks = doc['source_checks']
            if (not doc['source_errors'] and doc['configured_rules'] > 0 and checks
                    and re.fullmatch('[a-f0-9]{64}', doc['rules_sha256'])
                    and all(x['verified'] is True for x in checks)):
                return {'status': 'pass', 'passed': len(checks), 'total': len(checks),
                        'configured_rules': doc['configured_rules']}
            return {'status': 'fail', 'reason': 'visual_source_proofs_incomplete'}
        if kind == 'engine':
            doc = json.loads(output)
            count = doc['total']
            items = doc['items']
            if count > 0 and len(items) == count and doc['passed'] == count and all(x['ok'] is True for x in items):
                return {'status': 'pass', 'passed': count, 'total': count}
            return {'status': 'fail' if count > 0 else 'untested', 'reason': 'inconsistent_engine_summary'}
        if kind == 'kb':
            doc = json.loads(output)
            if doc['failed']:
                return {'status': 'fail', 'reason': 'kb_assertions_failed'}
            checks = doc['checks']
            if not doc['skipped'] and checks and all(x['status'] == 'PASS' for x in checks):
                return {'status': 'pass', 'passed': len(checks), 'total': len(checks)}
            return {'status': 'untested', 'reason': 'kb_checks_skipped'}
        if kind == 'unittest':
            match = re.search(r'(?:^|\n)Ran (\d+) tests? in [^\n]+\n\nOK\s*\Z', output)
            if match and int(match[1]) > 0:
                count = int(match[1])
                return {'status': 'pass', 'passed': count, 'total': count}
        else:
            patterns = {
                'agent': r'合计：通过 (\d+) / 失败 (\d+)',
                'cards': r'通过 (\d+) 项 · 不通过 (\d+) 项',
                'workflow': r'video_workflow: (\d+)/(\d+), real network attempts=(\d+)',
                'coverage': r'自证：通过 (\d+) / 失败 (\d+)',
                'replay': r'acceptance (True|False) checks (\d+)',
            }
            matches = list(re.finditer(patterns[kind], output))
            if matches:
                match = matches[-1]
                if kind == 'replay':
                    count = int(match[2])
                    return {'status': 'pass' if match[1] == 'True' and count > 0 else 'fail',
                            'passed': count if match[1] == 'True' else 0, 'total': count}
                count = int(match[1])
                failed = int(match[2]) if kind != 'workflow' else int(count != int(match[2]) or int(match[3]) != 0)
                if failed:
                    return {'status': 'fail', 'passed': count, 'reason': 'final_summary_failed'}
                if count > 0:
                    return {'status': 'pass', 'passed': count, 'total': count}
    except (KeyError, TypeError, ValueError, json.JSONDecodeError):
        pass
    return {'status': 'untested', 'reason': 'no_complete_success_summary'}


def overall_status(results):
    states = [x.get('status') for x in results]
    if 'fail' in states:
        return 'fail'
    return 'pass' if states and all(x == 'pass' for x in states) else 'untested'


def source_hashes():
    paths = list((REPO / 'tools/agent').glob('*.mjs'))
    paths += list((REPO / 'tools/reply-cards').glob('*.mjs'))
    paths += [REPO / 'tools/test_agent.mjs', REPO / 'tools/verify_media_workflow.py',
              REPO / 'tools/agent/tools.mjs',
              REPO / 'tools/verify_engine_contract.py', REPO / 'tools/verify_kb.py',
              REPO / 'tools/test_engine_contract_json.py',
              REPO / 'tools/kb_facts.py', REPO / 'tools/kb_gaps.py',
              REPO / 'research/governance/audit_migration_fidelity.py',
              REPO / 'tools/verify_ingest_coverage.py',
              REPO / 'PMO/守衡-视频完整审查修复-20261030/engine-visual-candidate-review.py',
              KB / 'l7/skills/kb-content-review/scripts/review.py',
              KB / 'l7/skills/kb-content-review/scripts/selftest_video_review.py',
              KB / 'l7/skills/kb-content-review/scripts/selftest_coverage.py',
              KB / 'l7/review-engine/core/with_kb_evidence.py',
              KB / 'l8/negative_rule_match.py', KB / 'l8/check_negative_rule_trigger.py',
              KB / 'l8/ocr_attachments.py', KB / 'l8/apply_vision_to_l1.py',
              KB / 'l8/l2_resync_media_vision.py',
              KB / 'l8/test_visual_supply.py', KB / 'l8/l3_negative_rules.py',
              KB / 'l1/index/l1.jsonl', KB / 'l1/index/index-report.json',
              KB / 'l1/index/rebuild_l1_index.py',
              KB / 'l2/units.jsonl', KB / 'l2/retired_units.jsonl',
              KB / 'l2/manifest_l2.jsonl', KB / 'l2/index/l2.jsonl',
              KB / 'l3/candidates/negative_rules.jsonl',
              KB / 'l8/visual_rule_match.py',
              KB / 'l7/registry/visual-review-rules.json']
    paths += list((REPO / 'research/governance/skeleton').glob('*.json'))
    paths += list((KB / 'l1/2_内部正负样本库').glob('media_*.json'))
    # These are runtime rule inputs, never credentials or submitted media.
    paths += list((KB / 'l7/skills/kb-content-review').glob('**/*visual*.json'))
    return {str(p.resolve()): hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else None
            for p in sorted(set(paths))}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence-dir', type=Path,
                        help='New directory for logs and verification.json; default: a temporary directory')
    args = parser.parse_args()
    evidence = args.evidence_dir or Path(tempfile.mkdtemp(prefix='sh-media-workflow-'))
    evidence.mkdir(parents=True, exist_ok=True)
    if (evidence / 'verification.json').exists():
        parser.error('evidence directory already contains verification.json; choose a new directory')
    python = sys.executable
    script_dir = KB / 'l7/skills/kb-content-review/scripts'
    adapter = KB / 'l7/review-engine/tests'
    suites = [
        ('verifier-contract', [python, 'tools/test_media_workflow_verifier.py'], 'unittest', 30),
        ('agent', ['node', 'tools/test_agent.mjs'], 'agent', 600),
        ('video-workflow', ['node', 'tools/agent/video_workflow.test.mjs'], 'workflow', 600),
        ('cards', ['node', 'tools/verify_cards.mjs'], 'cards', 120),
        ('engine-video', [python, str(script_dir / 'selftest_video_review.py')], 'unittest', 180),
        ('visual-sources', [python, str(KB / 'l8/visual_rule_match.py'), '--check-sources', '--json'], 'visual_sources', 30),
        ('visual-supply', [python, str(KB / 'l8/test_visual_supply.py')], 'unittest', 180),
        ('incident-replay', [python, 'PMO/守衡-视频完整审查修复-20261030/engine-visual-candidate-review.py',
                             '--output', str((evidence / 'incident-replay.json').resolve())], 'replay', 180),
        ('engine-coverage', [python, str(script_dir / 'selftest_coverage.py')], 'coverage', 180),
        ('video-skill-gate', [python, str(adapter / 'test_video_skill_gate.py')], 'unittest', 180),
        ('evidence-adapter', [python, str(adapter / 'test_with_kb_evidence.py')], 'unittest', 180),
        ('legacy-engine', [python, 'tools/verify_engine_contract.py', '--json'], 'engine', 180),
        ('engine-json-contract', [python, 'tools/test_engine_contract_json.py'], 'unittest', 60),
        ('migration-contract', [python, '-W', 'ignore::ResourceWarning',
                                'research/governance/skeleton/test_migration_fidelity.py'], 'unittest', 120),
        ('kb', [python, 'tools/verify_kb.py', '--json'], 'kb', 180),
        ('ingest-contract', [python, 'tools/test_ingest_coverage.py'], 'unittest', 30),
    ]
    started = dt.datetime.now(dt.timezone.utc).isoformat()
    before = source_hashes()
    results = []
    with tempfile.TemporaryDirectory(prefix='sh-workflow-pycache-') as pycache:
        env = {**os.environ, 'PYTHONPYCACHEPREFIX': pycache, 'KB_INTERP_OK': '1',
               'KB_ENTRY': 'selftest', 'KB_NO_PUBLISH': '1',
               'SHOUHENG_WORKFLOW_EVIDENCE_DIR': str(evidence.resolve())}
        for name, command, kind, timeout in suites:
            print(f'RUN {name}', flush=True)
            began = time.monotonic()
            stdout = evidence / (name + '.stdout.log')
            stderr = evidence / (name + '.stderr.log')
            error = None
            code = None
            with stdout.open('w') as out, stderr.open('w') as err:
                try:
                    proc = subprocess.run(command, cwd=REPO, env=env, stdout=out,
                                          stderr=err, timeout=timeout, check=False)
                    code = proc.returncode
                except (OSError, subprocess.TimeoutExpired) as exc:
                    error = str(exc)
            output = stdout.read_text(errors='replace')
            if kind not in ('engine', 'kb'):
                output += '\n' + stderr.read_text(errors='replace')
            result = {'name': name, 'command': command, 'exit': code,
                      'seconds': round(time.monotonic() - began, 2),
                      'stdout': str(stdout.resolve()), 'stderr': str(stderr.resolve()),
                      **classify_result(code, output, kind)}
            if error:
                result['error'] = error
            results.append(result)
            print(f"{result['status'].upper()} {name} ({result['seconds']}s)", flush=True)
    after = source_hashes()
    changed = [p for p in sorted(set(before) | set(after)) if before.get(p) != after.get(p)]
    missing = [p for p, fingerprint in after.items() if fingerprint is None]
    if changed:
        results.append({'name': 'stable-source', 'status': 'fail', 'changed': changed})
    if missing:
        results.append({'name': 'required-source', 'status': 'untested', 'missing': missing})
    doc = {'started_at': started, 'finished_at': dt.datetime.now(dt.timezone.utc).isoformat(),
           'status': overall_status(results), 'results': results, 'source_sha256': after,
           'source_unchanged_during_verification': not changed,
           'boundaries': ['No Feishu send/publication/restart or KB ingestion.',
                          'Integration uses model/skill/publication fixtures; it is not a live model or delivery probe.',
                          'Real local video sampling/OCR, current KB engine and final card are exercised.']}
    (evidence / 'verification.json').write_text(json.dumps(doc, ensure_ascii=False, indent=2) + '\n')
    print(f"{doc['status'].upper()} — {evidence / 'verification.json'}", flush=True)
    return {'pass': 0, 'fail': 1, 'untested': 2}[doc['status']]


if __name__ == '__main__':
    sys.exit(main())

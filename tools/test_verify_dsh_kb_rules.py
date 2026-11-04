import json
import tempfile
import unittest
from pathlib import Path

from tools import verify_dsh_kb_rules as audit


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")


def valid_rule(rule_id="rule-1", rule_code="P0-A", content_type=None):
    return {
        "rule_id": rule_id,
        "rule_code": rule_code,
        "p_level": "P0",
        "risk_level": "Critical",
        "applicable_scope": {
            "product_line": ["吸奶器"],
            "channel": ["Google"],
            "content_type": content_type,
        },
        "anchor": "#source/table/record/field",
        "evidence_units": [{"unit_id": "unit-1", "source_sha256": "a" * 64}],
        "kb_version": "v1",
        "owner": "法务",
    }


def valid_pattern(rule_id="rule-1", rule_code="P0-A", pattern_id="pattern-1"):
    return {
        "rule_id": rule_id,
        "rule_code": rule_code,
        "pattern_id": pattern_id,
        "article_no": "W-1.1",
        "anchor": "#source/table/record/field",
        "source_sha256": "a" * 64,
        "evidence_units": [{"unit_id": "unit-1", "source_sha256": "a" * 64}],
    }


def fixture_root(root: Path, rules=None, external=None, patterns=None):
    write_jsonl(root / "l3/candidates/rules.jsonl", rules if rules is not None else [valid_rule(content_type=["text"])])
    write_jsonl(root / "l3/candidates/external_standard.jsonl", external or [])
    write_jsonl(root / "l5/p0_patterns.jsonl", patterns if patterns is not None else [valid_pattern()])


class VerifyDshKbRulesTests(unittest.TestCase):
    def test_complete_fixture_passes_contract(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fixture_root(root)

            result = audit.audit_kb(root)

        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["workflow_impact"], "none")
        self.assertEqual(result["checks"]["p0_code_parity"]["missing_in_fastpath"], [])
        self.assertEqual(result["findings"], [])

    def test_content_governance_root_resolves_its_kb_child(self):
        with tempfile.TemporaryDirectory() as tmp:
            content_root = Path(tmp)
            fixture_root(content_root / "kb")

            result = audit.audit_kb(content_root)

        self.assertEqual(result["status"], "pass")
        self.assertEqual(Path(result["root"]).name, "kb")

    def test_snapshot_drift_is_reported_without_mutating_or_failing_parity(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "active"
            snapshot = Path(tmp) / "snapshot"
            fixture_root(root)
            fixture_root(snapshot, patterns=[valid_pattern(pattern_id="snapshot-pattern")])

            result = audit.audit_kb(root, snapshot)

        self.assertEqual(result["snapshot_drift"]["different_files"], ["p0_patterns"])
        self.assertEqual(result["checks"]["p0_code_parity"]["missing_in_fastpath"], [])
        self.assertEqual(result["status"], "pass")

    def test_missing_and_orphan_p0_codes_are_both_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fixture_root(
                root,
                rules=[valid_rule(rule_id="rule-1", rule_code="P0-A"), valid_rule(rule_id="rule-2", rule_code="P0-B")],
                patterns=[valid_pattern(rule_code="P0-A"), valid_pattern(rule_id="rule-x", rule_code="P0-X", pattern_id="pattern-x")],
            )

            result = audit.audit_kb(root)

        check = result["checks"]["p0_code_parity"]
        self.assertEqual(check["missing_in_fastpath"], ["P0-B"])
        self.assertEqual(check["orphan_in_fastpath"], ["P0-X"])
        self.assertEqual(result["status"], "fail")

    def test_duplicate_fastpath_ids_are_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fixture_root(root, patterns=[valid_pattern(), valid_pattern(pattern_id="pattern-2")])

            result = audit.audit_kb(root)

        codes = {item["code"] for item in result["findings"]}
        self.assertIn("duplicate_p0_rule_id", codes)

    def test_malformed_source_digest_is_not_accepted_as_traceability(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bad = valid_pattern()
            bad["source_sha256"] = "not-a-sha256"
            fixture_root(root, patterns=[bad])

            result = audit.audit_kb(root)

        self.assertIn("invalid_fastpath_source_sha256", {item["code"] for item in result["findings"]})

    def test_prd_scope_gap_names_the_rule_and_dimension(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fixture_root(root, rules=[valid_rule(content_type=None)])

            result = audit.audit_kb(root)

        finding = next(item for item in result["findings"] if item["code"] == "missing_prd_metadata")
        self.assertEqual(finding["rule_id"], "rule-1")
        self.assertIn("content_type", finding["missing_fields"])

    def test_bad_jsonl_is_unmeasured_with_path_and_line(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fixture_root(root)
            bad_file = root / "l5/p0_patterns.jsonl"
            bad_file.write_text('{"ok": true}\n{broken}\n', encoding="utf-8")

            with self.assertRaises(audit.AuditInputError) as caught:
                audit.audit_kb(root)

        self.assertEqual(caught.exception.line, 2)
        self.assertIn("p0_patterns.jsonl", caught.exception.path)

    def test_runtime_root_is_read_from_tools_module_export(self):
        # The subprocess is deliberately stubbed: this unit test pins the exported
        # value contract without importing the production bot or touching DSH state.
        with tempfile.TemporaryDirectory(prefix="active kb ") as temp:
            class Completed:
                returncode = 0
                stdout = temp + "\n"
                stderr = ""

            seen = {}

            def fake_run(command, **kwargs):
                seen["command"] = command
                seen["kwargs"] = kwargs
                return Completed()

            original = audit.subprocess.run
            audit.subprocess.run = fake_run
            try:
                result = audit.discover_runtime_root(Path("/repo"))
            finally:
                audit.subprocess.run = original

        self.assertEqual(result, Path(temp).resolve())
        self.assertIn("tools.mjs", " ".join(seen["command"]))


if __name__ == "__main__":
    unittest.main()

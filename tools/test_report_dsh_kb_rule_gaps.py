import json
import contextlib
import hashlib
import io
import tempfile
import unittest
from pathlib import Path

from tools.report_dsh_kb_rule_gaps import build_report, main


class GapReportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="dsh-gap-report-")
        self.base = Path(self.tmp.name)
        self.active = self.base / "active"
        self.snapshot = self.base / "snapshot"
        self.prd = self.base / "prd.md"
        self.scenes = ["车内场景", "功效宣称与广告用语", "喂养场景", "人物、肖像与 AI",
                       "睡眠场景", "洗护与沐浴", "出行与户外", "居家与用电", "玩具与玩乐"]
        self.types = ["文字", "图片", "视频"]
        self.prd.write_text("\n".join(self.scenes + self.types), encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def write_rows(self, root, relative, rows):
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")

    def seed(self):
        active_rule = {
            "rule_id": "r-1", "rule_code": "H01", "p_level": "P0",
            "taxonomy_category": "安全", "taxonomy_subcategory": "使用姿势", "modality": "text",
            "applicable_scope": {"product_line": ["吸奶器"], "channel": ["TikTok"], "content_type": None},
            "rule_text": "active text", "risk_level": "High", "anchor": "#rule-1",
            "evidence_units": [{"unit_id": "u1", "source_sha256": "a" * 64}],
            "kb_version": "v1", "owner": "team-a",
        }
        snapshot_rule = dict(active_rule, rule_text="snapshot text")
        for root, rule in ((self.active, active_rule), (self.snapshot, snapshot_rule)):
            self.write_rows(root, "l3/candidates/rules.jsonl", [rule])
            self.write_rows(root, "l3/candidates/external_standard.jsonl", [])
            self.write_rows(root, "l5/p0_patterns.jsonl", [{
                "pattern_id": "p-1", "rule_id": "r-1", "rule_code": "H01",
                "source_sha256": "a" * 64,
            }])

    def test_reports_missing_scope_and_keeps_prd_scene_coverage_unmeasured(self):
        self.seed()
        before = {
            path: hashlib.sha256(path.read_bytes()).hexdigest()
            for path in (self.active / "l3/candidates/rules.jsonl",
                         self.snapshot / "l3/candidates/rules.jsonl")
        }
        report = build_report(self.active, self.snapshot, self.prd)
        self.assertEqual(report["counts"]["unique_rule_ids"], 1)
        self.assertEqual(report["metadata_gaps"]["by_field"]["content_type"], 1)
        self.assertEqual(report["metadata_gaps"]["rules"][0]["missing_fields"], ["content_type"])
        self.assertEqual(report["metadata_gaps"]["by_priority"]["P0"], 1)
        scope = report["taxonomy_inventory"]["explicit_scope_distribution"][0]
        self.assertEqual((scope["product_line"], scope["channel"], scope["content_type"], scope["rule_ids"]),
                         ("吸奶器", "TikTok", "<missing>", 1))
        self.assertEqual(len(report["taxonomy_inventory"]["scene_coverage"]), 9)
        self.assertTrue(all(row["status"] == "UNMEASURED" for row in report["taxonomy_inventory"]["scene_coverage"]))
        self.assertEqual(report["snapshot_row_deltas"]["rules"]["changed_ids"], ["r-1"])
        self.assertFalse(report["writes_performed"])
        for path, digest in before.items():
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), digest)

    def test_cli_refuses_to_write_report_inside_active_kb(self):
        self.seed()
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            result = main(["--root", str(self.active), "--repo-snapshot", str(self.snapshot),
                           "--prd", str(self.prd), "--output", str(self.active / "report.json")])
        self.assertEqual(result, 2)
        self.assertFalse((self.active / "report.json").exists())

    def test_prd_taxonomy_drift_is_an_input_error(self):
        self.seed()
        self.prd.write_text("文字 图片 视频", encoding="utf-8")
        with self.assertRaises(ValueError):
            build_report(self.active, self.snapshot, self.prd)

    def test_unchanged_snapshot_rows_are_not_reported_as_drift(self):
        self.seed()
        rows = [json.loads(line) for line in (self.active / "l3/candidates/rules.jsonl").read_text().splitlines()]
        self.write_rows(self.snapshot, "l3/candidates/rules.jsonl", rows)
        report = build_report(self.active, self.snapshot, self.prd)
        delta = report["snapshot_row_deltas"]["rules"]
        self.assertEqual(delta["unchanged_ids"], ["r-1"])
        self.assertEqual(delta["changed_ids"], [])


if __name__ == "__main__":
    unittest.main()

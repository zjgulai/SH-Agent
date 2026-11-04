import re
import subprocess
import sys
import unittest
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
SCRIPTS = [
    REPO / "内容治理知识库/kb/l8/p0_regression.py",
    Path("/Users/lute/Documents/skill-test/执行skills/执行skills/skills-回归测试/知识库/内容治理/kb/l8/p0_regression.py"),
]


class P0RegressionLabelTests(unittest.TestCase):
    def test_selftest_reports_actual_pattern_count_without_stale_literal(self):
        stale_count = re.compile(r"(?:11 条模式|11 条红线|这 11 条)")
        for script in SCRIPTS:
            if not script.exists():
                continue
            with self.subTest(script=str(script)):
                source = script.read_text(encoding="utf-8")
                self.assertIsNone(stale_count.search(source))
                kb_root = script.parents[1]
                patterns_path = kb_root / "l5/p0_patterns.jsonl"
                count = sum(1 for line in patterns_path.read_text(encoding="utf-8").splitlines() if line.strip())
                result = subprocess.run(
                    [sys.executable, str(script), "--selftest"],
                    text=True,
                    capture_output=True,
                    check=False,
                )
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn(f"{count} 条模式", result.stdout)


if __name__ == "__main__":
    unittest.main()

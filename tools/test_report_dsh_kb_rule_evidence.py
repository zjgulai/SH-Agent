import unittest

from tools.report_dsh_kb_rule_evidence import build_evidence_index


class RuleEvidenceIndexTests(unittest.TestCase):
    def test_rule_id_is_the_join_key_and_test_result_must_match_that_id(self):
        l3 = [
            {"rule_id": "r-p0", "rule_code": "H01", "anchor": "L3/source/1", "rule_text": "raw rule"},
            {"rule_id": "r-same-code", "rule_code": "H01", "anchor": "L3/source/2", "rule_text": "other rule"},
        ]
        external = [{"rule_id": "r-p0", "source": {"anchor": "standard/article-1"}}]
        patterns = [{
            "pattern_id": "p-1", "rule_id": "r-p0", "rule_code": "H01",
            "match_terms": [
                {"term": "verbatim phrase", "basis": "verbatim_source", "anchor": "L0/row-1"},
                {"term": "invented phrase", "basis": "equivalent_of:verbatim phrase", "anchor": "L0/row-2"},
            ],
        }]

        def evaluator(text):
            # Deliberately returns a different rule_id with the same code for one sample.
            rid = "r-same-code" if text == "verbatim phrase" else "r-p0"
            return {"hit": True, "findings": [{"rule_id": rid, "rule_code": "H01"}]}

        result = build_evidence_index(l3, external, patterns, evaluator)
        by_id = {row["rule_id"]: row for row in result["rules"]}
        self.assertEqual(set(by_id), {"r-p0", "r-same-code"})
        self.assertEqual(by_id["r-p0"]["positive_status"], "FAIL")
        self.assertEqual(by_id["r-p0"]["sample_tests"][0]["test_id"], "DSH-P0-p-1-001")
        self.assertFalse(by_id["r-p0"]["sample_tests"][0]["passed"])
        self.assertEqual(by_id["r-p0"]["sample_tests"][0]["source_anchor"], "L0/row-1")
        self.assertEqual(by_id["r-p0"]["source_anchors"], ["L3/source/1", "standard/article-1"])
        self.assertEqual(by_id["r-same-code"]["positive_status"], "UNMEASURED")

    def test_unlinked_rules_and_non_verbatim_terms_remain_unmeasured(self):
        result = build_evidence_index(
            [{"rule_id": "r-no-sample", "rule_code": "H02", "anchor": "source"}], [],
            [{"pattern_id": "p-2", "rule_id": "r-no-sample", "rule_code": "H02",
              "match_terms": [{"term": "synonym", "basis": "equivalent_of:source"}]}],
            lambda _text: {"hit": False},
        )
        row = result["rules"][0]
        self.assertEqual(row["positive_status"], "UNMEASURED")
        self.assertEqual(row["sample_tests"], [])
        self.assertEqual(result["summary"]["unmeasured_rules"], 1)


if __name__ == "__main__":
    unittest.main()

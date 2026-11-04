#!/usr/bin/env python3
"""Build a read-only, exact-rule-ID index of source samples and P0 test results."""

import argparse
import collections
import hashlib
import importlib.util
import json
import sys
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional

try:
    from tools.verify_dsh_kb_rules import AuditInputError, discover_runtime_root, load_jsonl
except ModuleNotFoundError as exc:
    if exc.name != "tools":
        raise
    from verify_dsh_kb_rules import AuditInputError, discover_runtime_root, load_jsonl


ELIGIBLE_BASES = {"verbatim_source", "verbatim_rule_text", "boundary_of_code"}
FILES = {
    "rules": "l3/candidates/rules.jsonl",
    "external_standard": "l3/candidates/external_standard.jsonl",
    "p0_patterns": "l5/p0_patterns.jsonl",
}


def _unique_id(row: Dict[str, Any]) -> Optional[str]:
    value = row.get("rule_id")
    return str(value).strip() if value is not None and str(value).strip() else None


def _normalized_root(path: Path) -> Path:
    path = Path(path).expanduser().resolve()
    if (path / "kb").is_dir() and not (path / "l3").exists():
        return (path / "kb").resolve()
    return path


def _anchors(rows: Iterable[Dict[str, Any]]) -> List[str]:
    values = set()
    for row in rows:
        for value in (row.get("anchor"), (row.get("source") or {}).get("anchor")):
            if isinstance(value, str) and value.strip():
                values.add(value.strip())
        for unit in row.get("evidence_units") or []:
            if isinstance(unit, dict) and isinstance(unit.get("anchor"), str) and unit["anchor"].strip():
                values.add(unit["anchor"].strip())
    return sorted(values)


def _findings(result: Any) -> List[Dict[str, Any]]:
    if not isinstance(result, dict):
        return []
    findings = result.get("findings")
    return [row for row in findings if isinstance(row, dict)] if isinstance(findings, list) else []


def build_evidence_index(
    rule_rows: List[Dict[str, Any]],
    external_rows: List[Dict[str, Any]],
    patterns: List[Dict[str, Any]],
    evaluator: Callable[[str], Dict[str, Any]],
) -> Dict[str, Any]:
    """Join by exact ``rule_id``; never infer a join from ``rule_code``."""
    sources: Dict[str, Dict[str, List[Dict[str, Any]]]] = collections.defaultdict(lambda: collections.defaultdict(list))
    for kind, rows in (("l3_rule", rule_rows), ("external_standard", external_rows)):
        for row in rows:
            rule_id = _unique_id(row)
            if rule_id:
                sources[rule_id][kind].append(row)

    by_rule: Dict[str, List[Dict[str, Any]]] = collections.defaultdict(list)
    for pattern in patterns:
        rule_id = _unique_id(pattern)
        if rule_id:
            by_rule[rule_id].append(pattern)

    output = []
    for rule_id in sorted(sources):
        srcs = sources[rule_id]
        pattern_rows = sorted(by_rule.get(rule_id, []), key=lambda row: str(row.get("pattern_id") or ""))
        sample_tests = []
        for pattern in pattern_rows:
            terms = []
            seen_terms = set()
            for term_row in pattern.get("match_terms") or []:
                if not isinstance(term_row, dict):
                    continue
                basis = str(term_row.get("basis") or "")
                term = str(term_row.get("term") or "").strip()
                if basis in ELIGIBLE_BASES and term and term not in seen_terms:
                    seen_terms.add(term)
                    terms.append({"term": term, "anchor": str(term_row.get("anchor") or "").strip()})
            for index, sample in enumerate(terms, 1):
                term = sample["term"]
                try:
                    result = evaluator(term)
                except Exception as exc:
                    raise AuditInputError("P0 engine evaluation failed for {}: {}".format(rule_id, exc))
                matched_ids = sorted({str(hit.get("rule_id")) for hit in _findings(result) if hit.get("rule_id")})
                sample_tests.append({
                    "test_id": "DSH-P0-{}-{:03d}".format(pattern.get("pattern_id") or "missing-pattern-id", index),
                    "pattern_id": pattern.get("pattern_id"),
                    "basis": "verbatim source/rule boundary",
                    "sample": term,
                    "source_anchor": sample["anchor"] or None,
                    "expected_rule_id": rule_id,
                    "matched_rule_ids": matched_ids,
                    "passed": rule_id in matched_ids,
                })

        if not sample_tests:
            status = "UNMEASURED"
        elif not all(test["passed"] for test in sample_tests):
            status = "FAIL"
        elif _anchors(row for kind_rows in srcs.values() for row in kind_rows):
            status = "TESTED"
        else:
            status = "PARTIAL"

        output.append({
            "rule_id": rule_id,
            "rule_codes": sorted({str(row.get("rule_code")) for rows in srcs.values() for row in rows if row.get("rule_code")}),
            "source_types": sorted(srcs),
            "source_anchors": _anchors(row for rows in srcs.values() for row in rows),
            "pattern_ids": [str(row.get("pattern_id")) for row in pattern_rows if row.get("pattern_id")],
            "sample_tests": sample_tests,
            "positive_status": status,
            "negative_status": "UNMEASURED",
            "negative_status_note": "negative boundary pairs require the separate KBH-04B owner/legal/medical decision",
        })

    counts = collections.Counter(row["positive_status"] for row in output)
    return {
        "schema_version": 1,
        "join_key": "rule_id",
        "summary": {
            "unique_rule_ids": len(output),
            "tested_rules": counts.get("TESTED", 0),
            "partial_rules": counts.get("PARTIAL", 0),
            "failed_rules": counts.get("FAIL", 0),
            "unmeasured_rules": counts.get("UNMEASURED", 0),
            "positive_cases": sum(len(row["sample_tests"]) for row in output),
            "passed_positive_cases": sum(test["passed"] for row in output for test in row["sample_tests"]),
            "negative_cases": 0,
        },
        "rules": output,
        "workflow_impact": "none",
        "writes_performed": False,
    }


def _load_runtime_evaluator(root: Path) -> Callable[[str], Dict[str, Any]]:
    fastpath = root / "l5/p0_fastpath.py"
    spec = importlib.util.spec_from_file_location("dsh_rule_evidence_p0_fastpath", fastpath)
    if spec is None or spec.loader is None:
        raise AuditInputError("cannot load active P0 fastpath: {}".format(fastpath), fastpath)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.evaluate


def create_report(root: Path, evaluator: Optional[Callable[[str], Dict[str, Any]]] = None) -> Dict[str, Any]:
    root = _normalized_root(root)
    data = {key: load_jsonl(root / rel) for key, rel in FILES.items()}
    report = build_evidence_index(
        data["rules"], data["external_standard"], data["p0_patterns"],
        evaluator or _load_runtime_evaluator(root),
    )
    report["inputs"] = {
        key: {
            "path": str(root / rel),
            "sha256": hashlib.sha256((root / rel).read_bytes()).hexdigest(),
            "rows": len(data[key]),
        }
        for key, rel in FILES.items()
    }
    return report


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="按 rule_id 构建 DSH 规则来源、正例与实际 P0 命中测试索引")
    parser.add_argument("--root", help="可选 KB 根；缺省动态读取 tools.mjs 的 KB_ROOT")
    parser.add_argument("--output", help="可选 JSON 输出路径；默认只打印到 stdout")
    parser.add_argument("--json", action="store_true", help="打印完整 JSON")
    args = parser.parse_args(argv)
    repo_root = Path(__file__).resolve().parent.parent
    try:
        root = Path(args.root).expanduser().resolve() if args.root else discover_runtime_root(repo_root)
        report = create_report(root)
    except (AuditInputError, OSError, ImportError, AttributeError) as exc:
        print("UNTESTED：{}".format(exc), file=sys.stderr)
        return 2
    encoded = json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    if args.output:
        Path(args.output).write_text(encoded, encoding="utf-8")
    if args.json:
        print(encoded, end="")
    else:
        summary = report["summary"]
        print("DSH 规则逐 rule_id 证据索引：{}".format(root))
        print("规则 {}｜正例测试 {} / 命中 {}｜TESTED {} / PARTIAL {} / FAIL {} / UNMEASURED {}".format(
            summary["unique_rule_ids"], summary["positive_cases"], summary["passed_positive_cases"],
            summary["tested_rules"], summary["partial_rules"], summary["failed_rules"], summary["unmeasured_rules"]))
        print("否定边界对照：UNMEASURED（KBH-04B）；工作流影响：none；只读：{}".format(not report["writes_performed"]))
    return 1 if report["summary"]["failed_rules"] else 0


if __name__ == "__main__":
    raise SystemExit(main())

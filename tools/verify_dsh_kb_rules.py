#!/usr/bin/env python3
"""Read-only contract audit for the DSH knowledge base used by Shouheng.

The command intentionally stays outside the per-submission review path. It reads
the runtime KB_ROOT exported by tools/agent/tools.mjs, checks PRD rule metadata
and L3-to-L5 P0 coverage, and never writes to either the runtime KB or snapshot.
"""

import argparse
import collections
import hashlib
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence


class AuditInputError(Exception):
    def __init__(self, message: str, path: Optional[Path] = None, line: Optional[int] = None):
        super().__init__(message)
        self.path = str(path) if path else None
        self.line = line


def load_jsonl(path: Path) -> List[Dict[str, Any]]:
    rows = []
    try:
        with path.open("r", encoding="utf-8") as handle:
            for line_no, raw in enumerate(handle, 1):
                if not raw.strip():
                    continue
                try:
                    row = json.loads(raw)
                except (json.JSONDecodeError, UnicodeDecodeError) as exc:
                    raise AuditInputError("invalid JSONL: {}".format(exc), path, line_no)
                if not isinstance(row, dict):
                    raise AuditInputError("JSONL row must be an object", path, line_no)
                rows.append(row)
    except OSError as exc:
        raise AuditInputError("cannot read input: {}".format(exc), path)
    return rows


def discover_runtime_root(repo_root: Path) -> Path:
    source = "import('./tools/agent/tools.mjs').then(m => process.stdout.write(String(m.KB_ROOT || '')))"
    command = ["node", "--input-type=module", "-e", source]
    try:
        result = subprocess.run(command, cwd=str(repo_root), capture_output=True, text=True, check=False)
    except OSError as exc:
        raise AuditInputError("cannot execute Node to discover KB_ROOT: {}".format(exc))
    value = result.stdout.strip()
    if result.returncode != 0 or not value:
        raise AuditInputError(
            "tools.mjs did not export a readable KB_ROOT (exit={}): {}".format(
                result.returncode, result.stderr.strip()
            )
        )
    root = Path(value).expanduser()
    if not root.is_dir():
        raise AuditInputError("runtime KB_ROOT is not a directory: {}".format(root))
    return root.resolve()


def _present(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip()) and value.strip().lower() not in ("unknown", "未测", "未知", "null")
    if isinstance(value, (list, tuple, set, dict)):
        return bool(value)
    return True


def _is_sha256(value: Any) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[0-9a-fA-F]{64}", value) is not None


def _scope(rule: Dict[str, Any]) -> Dict[str, Any]:
    scope = rule.get("applicable_scope")
    if not isinstance(scope, dict):
        scope = rule.get("scope")
    return scope if isinstance(scope, dict) else {}


def _digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _rule_index(rows: Sequence[Dict[str, Any]], findings: List[Dict[str, Any]], p0_only: bool) -> Dict[str, Dict[str, Any]]:
    grouped: Dict[str, List[Dict[str, Any]]] = {}
    for row in rows:
        if p0_only and row.get("p_level") != "P0":
            continue
        rule_id = row.get("rule_id")
        if not _present(rule_id):
            findings.append({
                "code": "missing_p0_rule_id" if row.get("p_level") == "P0" else "missing_rule_id",
                "rule_code": row.get("rule_code"),
            })
            continue
        grouped.setdefault(str(rule_id), []).append(row)
    # L3 may contain a raw row plus an enriched row for the same rule_id. Use the
    # most complete representation; keep the unique rule_id as the audit unit.
    return {
        rule_id: max(group, key=lambda row: sum(_present(value) for value in row.values()))
        for rule_id, group in grouped.items()
    }


def _check_rule_metadata(rule_id: str, rule: Dict[str, Any], findings: List[Dict[str, Any]]) -> None:
    scope = _scope(rule)
    missing = []
    required = {
        "risk_level": rule.get("risk_level"),
        "product_line": scope.get("product_line"),
        "channel": scope.get("channel"),
        "content_type": scope.get("content_type"),
        "source_anchor": rule.get("anchor"),
        "evidence_units": rule.get("evidence_units"),
        "rule_version": rule.get("rule_version") or rule.get("kb_version"),
        "owner": rule.get("owner"),
    }
    for field, value in required.items():
        if not _present(value):
            missing.append(field)
    if missing:
        findings.append({
            "code": "missing_prd_metadata",
            "rule_id": rule_id,
            "rule_code": rule.get("rule_code"),
            "missing_fields": missing,
        })


def audit_kb(root: Path, repo_snapshot: Optional[Path] = None) -> Dict[str, Any]:
    root = Path(root).expanduser().resolve()
    # tools.mjs exports the content-governance root; layer files live beneath kb/.
    # Tests and explicit --root calls may instead point directly at the KB root.
    if (root / "kb").is_dir() and not (root / "l3").exists():
        root = (root / "kb").resolve()
    if not root.is_dir():
        raise AuditInputError("KB root is not a directory: {}".format(root))

    files = {
        "rules": root / "l3/candidates/rules.jsonl",
        "external_standard": root / "l3/candidates/external_standard.jsonl",
        "p0_patterns": root / "l5/p0_patterns.jsonl",
    }
    loaded = {name: load_jsonl(path) for name, path in files.items()}
    findings: List[Dict[str, Any]] = []
    rules = loaded["rules"] + loaded["external_standard"]
    all_rules = _rule_index(rules, findings, p0_only=False)
    p0_rules = _rule_index(rules, [], p0_only=True)
    patterns = loaded["p0_patterns"]

    rule_codes = {str(row["rule_code"]) for row in p0_rules.values() if _present(row.get("rule_code"))}
    pattern_codes = {str(row["rule_code"]) for row in patterns if _present(row.get("rule_code"))}
    missing_codes = sorted(rule_codes - pattern_codes)
    orphan_codes = sorted(pattern_codes - rule_codes)
    if missing_codes or orphan_codes:
        findings.append({
            "code": "p0_code_parity",
            "missing_in_fastpath": missing_codes,
            "orphan_in_fastpath": orphan_codes,
        })

    for rule_id, rule in all_rules.items():
        _check_rule_metadata(rule_id, rule, findings)

    pattern_ids: Dict[str, int] = {}
    pattern_rule_ids: Dict[str, int] = {}
    for row in patterns:
        pattern_id = row.get("pattern_id")
        rule_id = row.get("rule_id")
        if _present(pattern_id):
            pattern_ids[str(pattern_id)] = pattern_ids.get(str(pattern_id), 0) + 1
        if _present(rule_id):
            pattern_rule_ids[str(rule_id)] = pattern_rule_ids.get(str(rule_id), 0) + 1
        missing = [field for field in ("pattern_id", "rule_id", "rule_code", "article_no", "anchor")
                   if not _present(row.get(field))]
        evidence_units = row.get("evidence_units")
        if not _present(row.get("source_sha256")) and not _present(evidence_units):
            missing.append("source_sha256_or_evidence_units")
        if missing:
            findings.append({"code": "incomplete_fastpath_trace", "rule_id": rule_id, "missing_fields": missing})
        if _present(row.get("source_sha256")) and not _is_sha256(row.get("source_sha256")):
            findings.append({"code": "invalid_fastpath_source_sha256", "rule_id": rule_id})
        if _present(rule_id) and str(rule_id) not in p0_rules:
            findings.append({"code": "fastpath_rule_not_in_l3", "rule_id": rule_id, "rule_code": row.get("rule_code")})
        elif isinstance(evidence_units, list):
            for index, evidence in enumerate(evidence_units):
                if not isinstance(evidence, dict) or not _present(evidence.get("unit_id")) or not _present(evidence.get("source_sha256")):
                    findings.append({
                        "code": "invalid_fastpath_evidence_unit",
                        "rule_id": rule_id,
                        "index": index,
                    })
                elif not _is_sha256(evidence.get("source_sha256")):
                    findings.append({"code": "invalid_fastpath_evidence_sha256", "rule_id": rule_id, "index": index})
    for value, count in sorted(pattern_ids.items()):
        if count > 1:
            findings.append({"code": "duplicate_pattern_id", "pattern_id": value, "count": count})
    for value, count in sorted(pattern_rule_ids.items()):
        if count > 1:
            findings.append({"code": "duplicate_p0_rule_id", "rule_id": value, "count": count})

    fingerprints = {
        name: {"path": str(path), "sha256": _digest(path), "rows": len(loaded[name])}
        for name, path in files.items()
    }
    snapshot = None
    snapshot_drift = None
    if repo_snapshot is not None:
        snapshot = {}
        comparisons = {}
        for name, relative in (
            ("rules", "l3/candidates/rules.jsonl"),
            ("external_standard", "l3/candidates/external_standard.jsonl"),
            ("p0_patterns", "l5/p0_patterns.jsonl"),
        ):
            path = Path(repo_snapshot) / relative
            snapshot[name] = {"path": str(path), "exists": path.is_file()}
            if path.is_file():
                snapshot[name]["sha256"] = _digest(path)
                comparisons[name] = snapshot[name]["sha256"] == fingerprints[name]["sha256"]
            else:
                comparisons[name] = None
        snapshot_drift = {"matches": comparisons, "different_files": sorted(k for k, v in comparisons.items() if v is False)}

    metadata_gaps = collections.Counter(
        field for finding in findings if finding["code"] == "missing_prd_metadata"
        for field in finding["missing_fields"]
    )

    status = "fail" if findings else "pass"
    return {
        "status": status,
        "root": str(root),
        "counts": {
            "l3_rule_rows": len(loaded["rules"]),
            "external_standard_rows": len(loaded["external_standard"]),
            "unique_p0_rule_ids": len(p0_rules),
            "unique_rule_ids": len(all_rules),
            "p0_rule_codes": len(rule_codes),
            "p0_fastpath_rows": len(patterns),
        },
        "checks": {
            "p0_code_parity": {
                "rule_codes": sorted(rule_codes),
                "fastpath_codes": sorted(pattern_codes),
                "missing_in_fastpath": missing_codes,
                "orphan_in_fastpath": orphan_codes,
            },
            "prd_metadata": {"status": "checked_by_rule_id", "unique_rules_checked": len(all_rules)},
            "prd_metadata_gaps_by_field": dict(sorted(metadata_gaps.items())),
            "fastpath_traceability": "checked",
        },
        "findings": findings,
        "fingerprints": fingerprints,
        "repo_snapshot": snapshot,
        "snapshot_drift": snapshot_drift,
        "workflow_impact": "none",
        "writes_performed": False,
    }


def _selftest() -> None:
    with tempfile.TemporaryDirectory(prefix="dsh-kb-audit-") as temp:
        root = Path(temp)
        def put(path: Path, rows: Sequence[Dict[str, Any]]) -> None:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
        rule = {
            "rule_id": "selftest-rule", "rule_code": "SELFTEST", "p_level": "P0",
            "risk_level": "Critical", "applicable_scope": {
                "product_line": ["all"], "channel": ["all"], "content_type": ["text"]},
            "anchor": "#selftest", "evidence_units": [{"unit_id": "u1", "source_sha256": "a" * 64}],
            "kb_version": "v1", "owner": "selftest",
        }
        pattern = {
            "rule_id": "selftest-rule", "rule_code": "SELFTEST", "pattern_id": "selftest-pattern",
            "article_no": "T-1", "anchor": "#selftest", "source_sha256": "a" * 64,
            "evidence_units": [{"unit_id": "u1", "source_sha256": "a" * 64}],
        }
        put(root / "l3/candidates/rules.jsonl", [rule])
        put(root / "l3/candidates/external_standard.jsonl", [])
        put(root / "l5/p0_patterns.jsonl", [pattern])
        result = audit_kb(root)
        assert result["status"] == "pass", result["findings"]
        rule["rule_code"] = "MISSING"
        put(root / "l3/candidates/rules.jsonl", [rule])
        result = audit_kb(root)
        assert any(row["code"] == "p0_code_parity" for row in result["findings"])
    print("✅ DSH KB 规则审计器自测通过（正例通过；P0 集合差异反例被捕获）")


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="只读检查 DSH 活动知识库规则契约与 PRD §6.5 元数据")
    parser.add_argument("--root", help="离线审计指定知识库根目录；省略时从 tools.mjs 读取 KB_ROOT")
    parser.add_argument("--repo-snapshot", default="内容治理知识库/kb", help="仅计算仓库快照指纹")
    parser.add_argument("--json", action="store_true", help="输出 JSON")
    parser.add_argument("--selftest", action="store_true", help="仅运行临时 fixture 自测")
    args = parser.parse_args(argv)
    if args.selftest:
        try:
            _selftest()
            return 0
        except Exception as exc:
            print("❌ selftest failed: {}".format(exc), file=sys.stderr)
            return 1

    repo_root = Path(__file__).resolve().parent.parent
    try:
        root = Path(args.root).expanduser().resolve() if args.root else discover_runtime_root(repo_root)
        snapshot = (repo_root / args.repo_snapshot).resolve() if args.repo_snapshot else None
        result = audit_kb(root, snapshot)
    except AuditInputError as exc:
        payload = {"status": "unmeasured", "error": {"message": str(exc), "path": exc.path, "line": exc.line},
                   "workflow_impact": "none", "writes_performed": False}
        print(json.dumps(payload, ensure_ascii=False, indent=2) if args.json else
              "⚠ 未测：{}".format(str(exc)), file=sys.stderr)
        return 2

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    else:
        print("DSH KB 规则审计：{}".format(result["status"].upper()))
        print("活动根：{}".format(result["root"]))
        print("L3 行 {} / 外部标准行 {} / 唯一 P0 rule_id {} / P0 规则码 {} / L5 行 {}".format(
            result["counts"]["l3_rule_rows"], result["counts"]["external_standard_rows"],
            result["counts"]["unique_p0_rule_ids"], result["counts"]["p0_rule_codes"],
            result["counts"]["p0_fastpath_rows"]))
        gaps = result["checks"]["prd_metadata_gaps_by_field"]
        if gaps:
            print("PRD §6.5 缺项（按唯一规则 ID）：{}".format(
                ", ".join("{}={}".format(key, value) for key, value in gaps.items())))
        if result["snapshot_drift"] is not None:
            drift = result["snapshot_drift"]["different_files"]
            print("仓库快照对照：{}".format("差异 " + ", ".join(drift) if drift else "文件指纹一致"))
        counts = collections.Counter(item["code"] for item in result["findings"])
        if counts:
            print("发现项：{}".format(", ".join("{}={}".format(code, count) for code, count in sorted(counts.items()))))
            for finding in result["findings"][:8]:
                print("❌ {}: {}".format(finding["code"], json.dumps(finding, ensure_ascii=False, sort_keys=True)))
            if len(result["findings"]) > 8:
                print("… 其余 {} 项见 --json 输出".format(len(result["findings"]) - 8))
        if not result["findings"]:
            print("✅ P0 集合、PRD §6.5 元数据与快路溯源契约无缺项")
        print("工作流影响：none；写入：false")
    return 0 if result["status"] == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())

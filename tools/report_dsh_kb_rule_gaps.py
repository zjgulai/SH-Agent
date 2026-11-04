#!/usr/bin/env python3
"""Build a read-only, row-level DSH KB gap and snapshot report.

This report separates facts that can be counted from judgments that require an
approved taxonomy. In particular, PRD scene coverage stays UNMEASURED until a
rule-to-scene mapping and test denominator exist.
"""

import argparse
import collections
import datetime as dt
import hashlib
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

try:
    from tools.verify_dsh_kb_rules import AuditInputError, _present, audit_kb, discover_runtime_root, load_jsonl
except ModuleNotFoundError as exc:
    if exc.name != "tools":
        raise
    from verify_dsh_kb_rules import AuditInputError, _present, audit_kb, discover_runtime_root, load_jsonl


PRD_CONTENT_TYPES = ["文字", "图片", "视频"]
PRD_SCENE_DOMAINS = [
    "车内场景", "功效宣称与广告用语", "喂养场景", "人物、肖像与 AI", "睡眠场景",
    "洗护与沐浴", "出行与户外", "居家与用电", "玩具与玩乐",
]
CONTENT_TYPE_VALUES = {"text": "文字", "image": "图片", "video": "视频"}
FILES = {
    "rules": "l3/candidates/rules.jsonl",
    "external_standard": "l3/candidates/external_standard.jsonl",
    "p0_patterns": "l5/p0_patterns.jsonl",
}


def _normalized_root(path: Path) -> Path:
    path = Path(path).expanduser().resolve()
    if (path / "kb").is_dir() and not (path / "l3").exists():
        path = (path / "kb").resolve()
    return path


def _row_key(row: Dict[str, Any], file_key: str, index: int) -> str:
    field = "pattern_id" if file_key == "p0_patterns" else "rule_id"
    value = row.get(field)
    return str(value) if _present(value) else "<missing:{}:{}>".format(field, index + 1)


def _row_signatures(root: Path, file_key: str) -> Dict[str, List[str]]:
    rows = load_jsonl(root / FILES[file_key])
    grouped = collections.defaultdict(list)
    for index, row in enumerate(rows):
        canonical = json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        grouped[_row_key(row, file_key, index)].append(hashlib.sha256(canonical.encode("utf-8")).hexdigest())
    return {key: sorted(values) for key, values in grouped.items()}


def _snapshot_delta(active: Path, snapshot: Path, file_key: str) -> Dict[str, Any]:
    left, right = _row_signatures(active, file_key), _row_signatures(snapshot, file_key)
    keys = set(left) | set(right)
    return {
        "active_only_ids": sorted(key for key in keys if key in left and key not in right),
        "snapshot_only_ids": sorted(key for key in keys if key in right and key not in left),
        "changed_ids": sorted(key for key in keys if key in left and key in right and left[key] != right[key]),
        "unchanged_ids": sorted(key for key in keys if key in left and key in right and left[key] == right[key]),
        "active_unique_ids": len(left),
        "snapshot_unique_ids": len(right),
        "active_rows": sum(len(values) for values in left.values()),
        "snapshot_rows": sum(len(values) for values in right.values()),
    }


def _unique_rules(root: Path) -> Dict[str, Dict[str, Any]]:
    grouped = collections.defaultdict(list)
    index = 0
    for file_key in ("rules", "external_standard"):
        for row in load_jsonl(root / FILES[file_key]):
            index += 1
            rule_id = row.get("rule_id")
            if _present(rule_id):
                grouped[str(rule_id)].append(row)
    return {
        rule_id: max(rows, key=lambda row: sum(_present(value) for value in row.values()))
        for rule_id, rows in grouped.items()
    }


def _validate_prd_taxonomy(prd_path: Path) -> str:
    text = Path(prd_path).read_text(encoding="utf-8")
    missing = [value for value in PRD_CONTENT_TYPES + PRD_SCENE_DOMAINS if value not in text]
    if missing:
        raise ValueError("PRD taxonomy changed; review catalog before reporting: {}".format(", ".join(missing)))
    return text


def build_report(root: Path, snapshot: Path, prd_path: Path) -> Dict[str, Any]:
    _validate_prd_taxonomy(prd_path)
    root, snapshot = _normalized_root(root), _normalized_root(snapshot)
    audit = audit_kb(root, snapshot)
    rules = _unique_rules(root)

    gap_rows = [
        {"rule_id": row["rule_id"], "rule_code": row.get("rule_code"),
         "p_level": rules.get(row["rule_id"], {}).get("p_level"),
         "missing_fields": sorted(row.get("missing_fields", []))}
        for row in audit["findings"] if row.get("code") == "missing_prd_metadata"
    ]
    gap_rows.sort(key=lambda row: (row["p_level"] or "", row["rule_code"] or "", row["rule_id"]))
    gaps_by_field = collections.Counter(field for row in gap_rows for field in row["missing_fields"])
    gaps_by_priority = collections.Counter(row["p_level"] or "<missing>" for row in gap_rows)

    categories = collections.Counter(str(row.get("taxonomy_category") or "<missing>") for row in rules.values())
    subcategories = collections.Counter(str(row.get("taxonomy_subcategory") or "<missing>") for row in rules.values())
    modalities = collections.Counter(str(row.get("modality") or "<missing>") for row in rules.values())
    explicit_content_type = collections.Counter()
    missing_content_type = 0
    scope_distribution = collections.Counter()
    for row in rules.values():
        scope = row.get("applicable_scope")
        scope = scope if isinstance(scope, dict) else {}
        scope_key = []
        for field in ("product_line", "channel", "content_type"):
            value = scope.get(field)
            if not _present(value):
                scope_key.append("<missing>")
            elif isinstance(value, (list, tuple)):
                scope_key.append("|".join(sorted(str(item) for item in value)))
            else:
                scope_key.append(str(value))
        scope_distribution[tuple(scope_key)] += 1
        value = scope.get("content_type")
        if not _present(value):
            missing_content_type += 1
            continue
        values = value if isinstance(value, list) else [value]
        for item in values:
            label = CONTENT_TYPE_VALUES.get(str(item).lower(), "UNMAPPED:{}".format(item))
            explicit_content_type[label] += 1

    deltas = {key: _snapshot_delta(root, snapshot, key) for key in FILES}
    return {
        "report_version": "1",
        "status": audit["status"],
        "generated_at_local": dt.datetime.now(dt.timezone.utc).astimezone(
            ZoneInfo("Asia/Shanghai")
        ).isoformat(timespec="seconds"),
        "source": {
            "active_root": str(root), "snapshot_root": str(snapshot), "prd": str(Path(prd_path).resolve()),
            "prd_anchor": "PRD §5.2, §7.2",
        },
        "counts": audit["counts"],
        "metadata_gaps": {
            "by_field": dict(sorted(gaps_by_field.items())),
            "by_priority": dict(sorted(gaps_by_priority.items())),
            "unique_rules_with_gaps": len(gap_rows),
            "rules": gap_rows,
        },
        "taxonomy_inventory": {
            "prd_content_types": [
                {"name": kind, "explicit_scope_rule_ids": explicit_content_type.get(kind, 0)}
                for kind in PRD_CONTENT_TYPES
            ],
            "explicit_scope_missing_rule_ids": missing_content_type,
            "legacy_modality_counts_not_equivalent_to_content_type": dict(sorted(modalities.items())),
            "explicit_scope_distribution": [
                {"product_line": key[0], "channel": key[1], "content_type": key[2], "rule_ids": count}
                for key, count in sorted(scope_distribution.items())
            ],
            "taxonomy_category_counts": dict(sorted(categories.items())),
            "taxonomy_subcategory_counts": dict(sorted(subcategories.items())),
            "scene_coverage": [
                {"name": scene, "status": "UNMEASURED",
                 "reason": "没有经批准的 rule taxonomy → PRD 场景映射，且没有该场景的应审规则/黄金样本分母。"}
                for scene in PRD_SCENE_DOMAINS
            ],
        },
        "snapshot_file_fingerprints": audit["fingerprints"],
        "snapshot_row_deltas": deltas,
        "limitations": [
            "快照行级差异仅用于定位，不裁定哪一侧权威。",
            "content_type 的 modality 旧字段单独呈现，不作为适用范围字段的替代。",
            "场景覆盖状态为 UNMEASURED，不能从 taxonomy 名称相似度推断覆盖。",
            "输入规则和仓库快照均只读；本报告不会更新规则、模式、账本或运行态。",
        ],
        "workflow_impact": "none",
        "writes_performed": False,
    }


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="生成 DSH 活动库 PRD 缺口与快照行级差异报告（只读）")
    parser.add_argument("--root", help="活动 KB 根；缺省时从 tools.mjs 读取")
    parser.add_argument("--repo-snapshot", default="内容治理知识库/kb")
    parser.add_argument("--prd", default="PRD/feishu/内容审查Agent-PRD-v1.0.md")
    parser.add_argument("--output", help="可选 JSON 报告路径；禁止写入活动库或仓库快照树")
    args = parser.parse_args(argv)
    repo_root = Path(__file__).resolve().parent.parent
    try:
        root = Path(args.root).expanduser().resolve() if args.root else discover_runtime_root(repo_root)
        snapshot = (repo_root / args.repo_snapshot).resolve()
        prd = (repo_root / args.prd).resolve()
        report = build_report(root, snapshot, prd)
    except (AuditInputError, OSError, ValueError) as exc:
        print("未测：{}".format(exc), file=sys.stderr)
        return 2

    rendered = json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    if args.output:
        output = Path(args.output).expanduser().resolve()
        for protected in (report["source"]["active_root"], report["source"]["snapshot_root"]):
            protected_path = Path(protected).resolve()
            if output == protected_path or protected_path in output.parents:
                print("未测：拒绝将报告写入活动库或仓库快照目录", file=sys.stderr)
                return 2
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(rendered, encoding="utf-8")
        print("报告已写入：{}".format(output))
    else:
        sys.stdout.write(rendered)
    return 0 if report["status"] == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())

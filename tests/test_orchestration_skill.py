"""Behavioral and contract suite for the surgical-orchestration skill."""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

import jsonschema
import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[1]
REFERENCES_DIR = REPO_ROOT / "references"
BENCHMARKS_DIR = REPO_ROOT / "benchmarks"

FORBIDDEN_PHRASES = (
    "FOLLOWING BEST PRACTICES",
    "IS THAT THE BEST YOU CAN DO?",
    "principals",
    "PRINCIPALS",
    "superpowers:",
    "surgical-orchestration-review.ts",
)


def _split_frontmatter(text: str) -> tuple[dict[str, object], str]:
    assert text.startswith("---\n"), "SKILL.md must open with YAML frontmatter"
    close = re.search(r"\n---\s*(?:\n|$)", text[3:])
    assert close is not None, "SKILL.md frontmatter must close with '---'"
    raw_fm = text[4 : close.start() + 3]
    body = text[close.end() + 3 :]
    parsed = yaml.safe_load(raw_fm)
    assert isinstance(parsed, dict)
    return {str(k): v for k, v in parsed.items()}, body


def _resolve_node_bin(tool: str) -> str:
    local = REPO_ROOT / "node_modules" / ".bin" / tool
    if local.exists():
        return str(local)
    found = shutil.which(tool)
    if found:
        return found
    msg = f"Required TypeScript tool {tool!r} not found in node_modules/.bin or PATH"
    pytest.fail(msg)
    raise AssertionError(msg)


def test_conform_gate_passes_without_drift() -> None:
    proc = subprocess.run(
        [sys.executable, "-B", str(REPO_ROOT / "scripts" / "conform.py")],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "PASS  surgical-orchestration" in proc.stdout
    assert "MIRROR DRIFT" not in proc.stdout + proc.stderr


def test_skill_markdown_budget_frontmatter_and_mermaid() -> None:
    skill_md = REPO_ROOT / "SKILL.md"
    lines = skill_md.read_text(encoding="utf-8").splitlines()
    assert len(lines) <= 250, f"SKILL.md exceeds 250-line budget ({len(lines)} lines)"

    fm, body = _split_frontmatter("\n".join(lines) + "\n")
    desc = str(fm["description"])
    assert desc.startswith("Use when")
    assert desc.endswith(".")
    assert len(desc) <= 60
    assert fm["version"] == "1.2.0"

    meta = fm.get("metadata")
    assert isinstance(meta, dict)
    hermes = meta.get("hermes")
    assert isinstance(hermes, dict)
    assert hermes.get("category") == "software-development"
    assert hermes.get("related_skills") == [
        "surgical-implementation",
        "surgical-audit",
        "surgical-investigation",
        "surgical-building",
    ]

    for heading in (
        "## Overview",
        "## When to Use",
        "## When Not to Use",
        "## Architecture",
        "## Procedure",
        "## Related Skills",
        "## Author",
        "## License",
    ):
        assert heading in body, f"Missing standard heading {heading}"

    assert "```mermaid" in body
    assert "accTitle:" in body
    assert "accDescr:" in body


def test_docs_and_references_hygiene() -> None:
    assert (REPO_ROOT / "LICENSE").is_file()
    assert (REPO_ROOT / "AGENTS.md").is_file()
    assert (REFERENCES_DIR / "pitfalls.md").is_file()
    assert not (
        REPO_ROOT / "docs" / "plans" / "2026-08-13-orchestration-benchmark.md"
    ).exists()

    parallel_push = (REFERENCES_DIR / "verify-then-sync-parallel-push.md").read_text(
        encoding="utf-8"
    )
    assert not parallel_push.startswith("---"), (
        "Reference doc must not embed skill frontmatter"
    )

    for ts_file in REFERENCES_DIR.glob("*.ts"):
        assert not ts_file.name.endswith(".test.ts"), (
            f"Test file leaked in references/: {ts_file}"
        )
        assert not ts_file.name.endswith(".spec.ts"), (
            f"Spec file leaked in references/: {ts_file}"
        )
        line_count = len(ts_file.read_text(encoding="utf-8").splitlines())
        assert line_count < 250, f"{ts_file.name} exceeds 250 LOC ({line_count})"

    for forbidden_path in (
        REFERENCES_DIR / "bench",
        REFERENCES_DIR / "package.json",
        REFERENCES_DIR / "package-lock.json",
        REFERENCES_DIR / "node_modules",
        REFERENCES_DIR / "surgical-orchestration-review.ts",
    ):
        assert not forbidden_path.exists(), (
            f"Unexpected artifact in references/: {forbidden_path}"
        )

    scan_targets = [
        REPO_ROOT / "SKILL.md",
        REPO_ROOT / "README.md",
        REPO_ROOT / "AGENTS.md",
        REPO_ROOT / "SECURITY_MODEL.md",
        *REFERENCES_DIR.glob("*.md"),
    ]
    for path in scan_targets:
        text = path.read_text(encoding="utf-8")
        for phrase in FORBIDDEN_PHRASES:
            assert phrase not in text, f"Forbidden phrase {phrase!r} found in {path}"


def test_schemas_draft_2020_12_and_strict_contracts() -> None:
    schema_files = sorted(REFERENCES_DIR.glob("*-schema.json"))
    assert len(schema_files) == 4
    for schema_path in schema_files:
        schema = json.loads(schema_path.read_text(encoding="utf-8"))
        assert schema.get("$schema") == "https://json-schema.org/draft/2020-12/schema"
        assert schema.get("unevaluatedProperties") is False
        jsonschema.Draft202012Validator.check_schema(schema)

    plan_schema = json.loads(
        (REFERENCES_DIR / "build-plan-schema.json").read_text(encoding="utf-8")
    )
    validator = jsonschema.Draft202012Validator(plan_schema)

    for plan_path in [
        REFERENCES_DIR / "build-plan.json",
        *(BENCHMARKS_DIR / "fixtures").glob("*.plan.json"),
    ]:
        plan_obj = json.loads(plan_path.read_text(encoding="utf-8"))
        validator.validate(plan_obj)

    jobcard_schema = json.loads(
        (REFERENCES_DIR / "jobcard-schema.json").read_text(encoding="utf-8")
    )
    jc_validator = jsonschema.Draft202012Validator(jobcard_schema)
    with pytest.raises(jsonschema.ValidationError):
        jc_validator.validate(
            {
                "planId": "p1",
                "overallStatus": "COMPLETED",
                "jobs": {},
                "completedHashes": [],
                "unexpectedExtra": True,
            }
        )


def test_typescript_compile_and_behavioral_suites() -> None:
    tsc = _resolve_node_bin("tsc")
    tsx = _resolve_node_bin("tsx")

    typecheck = subprocess.run(
        [tsc, "--noEmit"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert typecheck.returncode == 0, typecheck.stdout + typecheck.stderr

    for script in (
        "tests/security.test.ts",
        "tests/orchestrator.review.test.ts",
        "tests/schema-drift.test.ts",
        "tests/engine.test.ts",
    ):
        res = subprocess.run(
            [tsx, str(REPO_ROOT / script)],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        assert res.returncode == 0, f"{script} failed:\n{res.stdout}\n{res.stderr}"

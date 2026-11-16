# Surgical Orchestration (`v1.2.0`)

Multi-folder subagent orchestration skill, TypeScript runtime engine, fail-closed filesystem scope sandbox, and JSON Schema Draft `2020-12` contracts.

## Overview

`surgical-orchestration` coordinates parallel subagent execution across disjoint folder boundaries using:

- **One Parent Folder = One Agent Sandbox:** Isolated Worker/Verifier pairs capped at `MAX_CONCURRENCY = 2` with pre-slot scope checks and `try/finally` slot cleanup.
- **Deterministic Loop Prevention & Compaction:** `ContextCompactor` shrinks verified ledgers past 75% token budget (`COMPACTION_TOKEN_THRESHOLD`) and `hashDebrief` escalates repeated failure cycles.
- **`FAILED` Worker Non-Promotion & `AbortSignal`:** Failed workers short-circuit immediately before `VERIFIER` dispatch and thread cancellation signals across async subagent execution.
- **Post-Build Review & `2 + 2` Composer:** Unified `defaultClassifyFile` routes files to `FRONTEND_REVIEWER` and `BACKEND_REVIEWER` over a frozen tree, and `compose()` distills 2 recommendations + 2 suggestions.

## Repository Layout

| Path | Purpose |
| --- | --- |
| `SKILL.md` | Concise skill specification and procedure (`<= 250` lines, mirrored to agent runtimes) |
| `AGENTS.md`, `LICENSE`, `SECURITY_MODEL.md` | Agent governance, MIT license, and fail-closed security invariants |
| `references/*.ts` | Modular TypeScript engine (`engine.ts`, `subagent-manager.ts`, `review-layer.ts`, `classifier.ts`, `security.ts`, `compactor.ts`, `instructions.ts`, `test-fixer.ts`, `hermes-adapter.ts`, `debrief.ts`, `types.ts`, facade `orchestrator.ts`, CLI `surgical-orchestration.ts`) |
| `references/*-schema.json` | JSON Schema Draft `2020-12` contracts (`jobcard`, `debrief`, `subagent-exit`, `build-plan`) |
| `references/*.md` | Prompt templates, blueprint format, pitfalls, TypeScript verification, and git sync protocols |
| `tests/` | Repo-only behavioral & security suites (`security.test.ts`, `orchestrator.review.test.ts`, `schema-drift.test.ts`, `engine.test.ts`, `test_orchestration_skill.py`) |
| `benchmarks/` | Accuracy, concurrency timing, compaction token sweep, CLI runner, Playwright E2E spec, and parameter reporter |
| `scripts/` | `conform.py` (family conformance gate) and `sync-skill.sh` (8-target byte-verified skill mirror tool) |

## Quick Verification

```bash
python3 -B scripts/conform.py
npm install && npm run typecheck && npm test
npm run bench
pytest -o cache_dir=/tmp/pytest-orch -v tests/
check-jsonschema --check-metaschema references/*-schema.json
bash scripts/sync-skill.sh verify
```

Never copy `node_modules/`, `tests/`, `benchmarks/`, `package.json`, or repo-only scripts into `~/.hermes` or other runtime skill mirrors; use `bash scripts/sync-skill.sh sync`.

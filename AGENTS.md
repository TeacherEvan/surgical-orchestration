# AGENTS.md — surgical-orchestration

Guidance for AI coding agents working inside the `surgical-orchestration` repository or loading the `surgical-orchestration` skill.

## Scope & Boundaries

- This repository owns the **`surgical-orchestration`** skill (`SKILL.md`, `README.md`, `LICENSE`, `AGENTS.md`, `SECURITY_MODEL.md`, `references/`) plus repo-only verification, benchmark, CI, and packaging files (`tests/`, `benchmarks/`, `scripts/`, `.github/`, `package.json`, `tsconfig.json`, `docs/`).
- Never modify sibling repositories (such as `Surgical-Pruning/` or `Surgical-Investigation/`) unless explicitly assigned.
- Never copy `node_modules/`, `tests/`, `benchmarks/`, `.github/`, `package.json`, or repo-only scripts (`scripts/conform.py`, `scripts/sync-skill.sh`) into `~/.hermes` or other local agent skill mirrors.
- Never run `git push` unless explicitly asked by the user.

## Architecture & Invariants

1. **Pre-slot Scope Security (`references/security.ts`):** Always validate path scope via `assertScopeBoundary()` / `resolveScopedPath()` BEFORE calling `activeAgents.set(...)` in `SubagentManager`, and always release active slots inside `try/finally`. All 4 bypass vectors (multi-level symlink, dangling symlink, `\0` byte, empty/whitespace scope) and sibling-prefix escapes must throw `[SCOPE_INVALID]`. File reads inside a locked scope should use `openScopedFile()` (`O_NOFOLLOW` + `fstatSync`).
2. **Bounded Concurrency & Lifecycle (`references/engine.ts`):** Independent folder jobs execute concurrently via a worker pool capped at `MAX_CONCURRENCY = 2` (or `EngineOptions.maxConcurrency`), thread `AbortSignal` into subagent dispatch, short-circuit `FAILED` workers BEFORE dispatching `VERIFIER`, enforce debrief-hash loop detection, and run bounded `TEST_FIXER` repair passes via `references/test-fixer.ts`.
3. **JSON Schema Draft `2020-12` (`references/*-schema.json`):** Keep `jobcard-schema.json`, `debrief-schema.json`, `subagent-exit-schema.json`, and `build-plan-schema.json` strict (`"unevaluatedProperties": false`). Always convert `JobCard` `Map`/`Set` structures with `serializeJobCard()` before serializing or validating against `jobcard-schema.json`.
4. **Module & Doc Discipline:** Keep TypeScript runtime modules in `references/` focused (`< 250` LOC each) and exposed cleanly through `references/orchestrator.ts`. Keep `SKILL.md` `<= 250` lines with portable `related_skills` IDs (`^[a-z0-9-]+$`). Do not reintroduce CLI side effects on module import (`isCliEntryPoint()` guard in `references/surgical-orchestration.ts`).

## Verification Gates

Run checks cleanly without leaving cache directories in gitignored worktrees or polluting skill mirrors:

- Conformance gate: `python3 -B scripts/conform.py`
- TypeScript check & tests: `npm run typecheck && npm test`
- Benchmarks: `npm run bench`
- JSON Schema `2020-12` validation: `check-jsonschema --check-metaschema references/*-schema.json && check-jsonschema --schemafile references/build-plan-schema.json references/build-plan.json benchmarks/fixtures/*.plan.json`
- Python test suite: `pytest -o cache_dir=/tmp/pytest-orch -v tests/`
- Python lint, format & typing: `ruff check --no-cache scripts/ tests/ && ruff format --check --no-cache scripts/ tests/ && mypy --strict --cache-dir /tmp/mypy-orch scripts/`
- Shell & workflow lint: `shellcheck -x scripts/sync-skill.sh && yamllint .github/workflows/skill-ci.yml`
- Mirror verification: `bash scripts/sync-skill.sh verify`

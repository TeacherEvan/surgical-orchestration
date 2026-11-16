# Pitfalls and Lessons Learned

Hard-won debugging lessons and production edge cases captured during real `surgical-orchestration` builds and security reviews.

## Runtime & Build Lessons

- **A content-hashed build that rewrites only HTML leaves module imports stale.** Updating `index.html` to point at `app.js?v=<new>` while imported ES modules still import `./core.js?v=<old>` causes browsers to execute stale module graphs. Rewrite relative JS import specifiers against each importer's directory, iterate rewriting passes until a no-op fixed point is reached, and verify a second build produces byte-identical output.
- **Single-scope plans do not fan out Worker/Verifier pairs.** When every changed file resolves to a single parent directory, folder-level parallel subagents have no disjoint scope and trigger lock contention or duplicate debrief hashes. Build single-scope changes directly, run the gates, then dispatch read-only `FRONTEND_REVIEWER` / `BACKEND_REVIEWER` subagents for post-build review.
- **Reviewers must inspect a frozen tree.** Freeze the commit or working-tree diff before dispatching reviewers. Continuing implementation edits while reviewers run invalidates their line references and risks reverting fixes or missing new defects introduced after dispatch.
- **`FAILED` workers must never be promoted to `VERIFIER`.** If a `WORKER` fails, short-circuit the job cycle immediately, record the failure in `lastVerifierFeedback`, consume the retry attempt, and never leak a subagent slot across `[SCOPE_INVALID]` or thrown errors (`try/finally`).

## Classification & Schema Lessons

- **2026-08-13 — `convex/` prefix misclassified as `AMBIGUOUS`.** Matching `/convex/` with surrounding slashes missed top-level repo paths like `convex/payments.ts` (no leading slash), dropping them into `AMBIGUOUS`. Path heuristics in `references/classifier.ts` (`defaultClassifyFile`) must match both path-start (`dir/`) and mid-path (`/dir/`) forms, guarded by behavioral assertions in `tests/orchestrator.review.test.ts` and `benchmarks/accuracy.test.ts`.
- **2026-08-13 — Subagents require `recommendations` and `suggestions` channels.** Adding optional `recommendations?: string[]` and `suggestions?: string[]` to `SubagentResult`, preserving them in `parseSubagentResult` and `dryRunDispatcher`, and reducing them via `compose()` enforces the `2 + 2` up-chain reporting contract.
- **2026-08-13 — Framework-free TypeScript tests via `tsx` catch contract drift `tsc` misses.** `tsc` alone verifies types, whereas running `tests/security.test.ts`, `tests/orchestrator.review.test.ts`, `tests/schema-drift.test.ts`, and `tests/engine.test.ts` with `tsx` validates runtime behavior, schema alignment, and sandbox containment. See `references/verify-skill-typescript.md`.
- **2026-08-13 — Bare `tsc --noEmit <file>` omits `--types node`.** Running `tsc` without root `tsconfig.json` (`"types": ["node"]`, `"module": "Node16"`) triggers false-positive `TS2591`/`TS2339` errors on `node:*` built-ins. Always run `npm run typecheck` (`tsc --noEmit`) from the repository root.

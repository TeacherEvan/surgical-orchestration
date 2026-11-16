# Verifying Changes to Skill TypeScript

TypeScript runtime modules live in `references/*.ts`, while repository-only tests and benchmarks live at the repo root in `tests/` and `benchmarks/`.

## Repository Verification (Recommended)

Root `package.json` and `tsconfig.json` (`strict`, `module: Node16`, `moduleResolution: Node16`, `types: ["node"]`, `"type": "module"`) cover `references/**/*.ts`, `tests/**/*.ts`, and `benchmarks/**/*.ts`:

```bash
npm run typecheck
npm test
npm run bench
```

- `node_modules/` and `package-lock.json` are gitignored and **excluded** from skill mirrors by `scripts/sync-skill.sh`. Never copy `node_modules/` into `~/.hermes` or other runtime skill directories.
- `benchmarks/e2e.spec.ts` relies on optional `@playwright/test` globals and uses `benchmarks/tsconfig.e2e.json` so core `npm run typecheck` stays dependency-lean.

## Trap 1 — Bare `tsc --noEmit <file>` Lies

Running `tsc --noEmit references/orchestrator.ts` without project flags drops `--types node`, causing false `TS2591`/`TS2339` errors on `node:*` imports, `process`, and `EventEmitter`. Always run `npm run typecheck` (or pass `--strict --skipLibCheck --module node16 --moduleResolution node16 --target es2022 --types node`).

## Trap 2 — Typecheck Alone Misses Logic Bugs

A passing `tsc` check never catches regex classification drift (such as `convex/` path-start matching), schema field drift, slot leaks on thrown errors, or `FAILED` worker promotion.

Before finishing any edit under `references/`, always run all four `tsx` behavioral suites plus benchmarks:

```bash
npx tsx tests/security.test.ts
npx tsx tests/orchestrator.review.test.ts
npx tsx tests/schema-drift.test.ts
npx tsx tests/engine.test.ts
```

Every suite exits `0` on pass and `1` with explicit failing assertions otherwise. Keep `references/*.ts` modules focused (`< 250` LOC) and keep tests and fixtures strictly in `tests/` and `benchmarks/`.

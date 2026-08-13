# Verifying changes to this skill's TypeScript

The runtime is pure Node + `tsx`; there is no bundler, no test framework, no
`package.json` in the skill tree. That makes verification cheap but easy to do
wrong. Two traps, one recipe.

## Trap 1 — the default linter `tsc` lies

The skill's inline linter invokes `tsc --noEmit <file>` (no `--types node`).
Every Node builtin then errors:

```
debrief.ts(1,25): error TS2591: Cannot find name 'node:crypto'.
orchestrator.ts(267,14): error TS2339: Property 'emit' does not exist on type 'SubagentManager'.
```

These are FALSE POSITIVES. The class extends `EventEmitter`; the import is
`node:events`. They disappear the moment you add `--types node`. Never "fix"
code to satisfy the bare linter — re-run the prescribed command instead:

```bash
cd references
npx tsc --noEmit --strict --skipLibCheck --module node16 \
  --moduleResolution node16 --target es2022 --types node *.ts
```

If THIS passes, the TS is sound. The bare linter output is noise.

## Trap 2 — polluting the skill tree with node_modules

Don't `npm install` inside `references/`. The skill ships without a
`package.json`; adding one + `node_modules` is churn the next agent must revert.
Verify in an isolated temp dir:

```bash
mkdir -p /tmp/soverify && cd /tmp/soverify
cp /home/ewaldt/.hermes/skills/software-development/surgical-orchestration/references/*.ts .
npm init -y >/dev/null 2>&1
npm install --no-audit --no-fund typescript@5 @types/node >/dev/null 2>&1
npx tsc --noEmit --strict --skipLibCheck --module node16 \
  --moduleResolution node16 --target es2022 --types node *.ts
npx tsx orchestrator.review.test.ts
rm -rf /tmp/soverify
```

## Recipe — framework-free behavior test

No vitest/jest. A standalone `*.test.ts` with `assert()`-style checks:

```ts
function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error('ASSERT FAILED: ' + msg);
  console.log('  ok -', msg);
}
// ... drive the real classes with a fake dispatcher ...
main().catch((e) => { console.error(e.message); process.exit(1); });
```

Run with `npx tsx orchestrator.review.test.ts`. Exit 0 = green; non-zero = red.
This is how the `convex/` misclassification was caught — the type-checker passed,
but the test failed and pointed at the exact line.

## Why this matters

Type-checking proves the code PARSES and the types LINE UP. It does NOT prove the
classifier routes `convex/payments.ts` to BACKEND, or that the Composer returns
exactly 2+2. Only a behavior test does. When you touch `defaultClassifyFile`,
`StandardCodeReviewer.run()`, or `Composer.compose()`, add/extend an assertion in
`orchestrator.review.test.ts` — never ship a logic change on a green `tsc` alone.

# Orchestration Benchmark & Parameter-Sweep Test Suite

> **For Hermes:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a practical, repeatable test harness that measures the surgical-orchestration engine on three axes — accuracy, timing, and token use — and sweeps its four agent-completion parameters to prove different settings produce different, predictable results.

**Architecture:** A `bench/` harness injects a deterministic fake `SubagentDispatcher` into `OrchestrationEngine` / `StandardCodeReviewer` so every run is reproducible. Node drives the unit-level parameter sweeps; Playwright drives the real CLI as a subprocess and parses its stdout as the "page under test" to capture end-to-end timing and token/accuracy signals. A small JSON reporter aggregates per-run results into a comparison table.

**Tech Stack:** Node 24 + `tsx` (already present in env), TypeScript (strict, per skill's own verification command), Playwright 1.62.1 (pinned), `@types/node`. No browser app — Playwright is used in `library` mode to spawn the CLI and read its output stream.

**Effort:** ~1 week | **Surfaces touched:** 1 skill (`surgical-orchestration`) | **New tables:** 0 | **Feature flag:** none (additive bench/ dir, never imported by the engine)

---

## Milestone Timeline

### Milestone 1: Fake Dispatcher + Accuracy Fixtures (Days 1–2)
Build the controllable dispatcher and the golden plan fixtures. No timing yet — just correctness.

- `references/bench/fake-dispatcher.ts` — latency-injectable, accuracy-toggleable dispatcher
- `references/bench/fixtures/*.plan.json` — 4 canned plans (pure-FE, pure-BE, mixed, ambiguous-only)
- `references/bench/accuracy.test.ts` — classification, fan-out, loop-guard, composer 2+2

### Milestone 2: Timing Sweep (Days 2–3)
Vary concurrency + timeout; measure wall-clock; assert scaling laws hold.

- `references/bench/timing.test.ts` — run engine with `MAX_CONCURRENCY ∈ {1,2,4}` and `SUBAGENT_TIMEOUT_MS ∈ {200, 2000}`
- `references/bench/run-cli.ts` — spawns `surgical-orchestration.ts --review` via Playwright `subprocess`/child API, captures stdout + `Date.now()` deltas

### Milestone 3: Token-Use Sweep (Days 3–4)
Measure compacted ledger size vs `COMPACTION_TOKEN_THRESHOLD` and plan size.

- `references/bench/token.test.ts` — assert ledger shrinks as threshold drops; assert 4-char/token estimate is monotonic in plan size

### Milestone 4: Playwright E2E + Reporter (Days 4–5)
Real CLI through Playwright; produce the comparison table.

- `references/bench/e2e.spec.ts` — Playwright spec: launch CLI, assert output contains classification + Composer 2+2
- `references/bench/report.ts` — writes `bench/results/<stamp>.json` + human table

---

## Data Flow

### Unit sweep (Node, no browser)

```
fake-dispatcher.ts ──injects──► OrchestrationEngine / StandardCodeReviewer
        │                                  │
   (latency ms,                       runs plan, returns
    accuracy on/off)                  JobCard + ledger
        │                                  │
        └──────────── measure ◄─────────────┘
                  (wall ms, ledger bytes, pass/fail)
```

### E2E sweep (Playwright drives the real CLI)

```
Playwright ──spawn──► node surgical-orchestration.ts --review <plan>
   │                          │
   │                          ├─► prints [CODE-REVIEWER] classification
   │                          ├─► prints [COMPOSER] 2 recommendations + 2 suggestions
   │                          │
   └─◄── stdout stream ───────┘
            │
            └─► parse → { ms, lanes, recCount, suggCount } → report.ts
```

---

## Mockups

### A · Accuracy report (per fixture)

```
FIXTURE            CLASSIFY  FANOUT  LOOP-GUARD  COMPOSER-2+2  RESULT
mixed.stack        5/5 ok    2 ok     n/a        2/2 ok         PASS
ambiguous.only     3/3 ok    2 ok     n/a        2/2 ok         PASS
loop.bomb          n/a       1 ok     ESCALATED   -             PASS (guard fired)
```

### B · Parameter-sweep comparison table

```
SETTING                          WALL_MS   LEDGER_TOKENS   ACCURACY
MAX_CONCURRENCY=1, latency=50    1820      412            100%
MAX_CONCURRENCY=2, latency=50     940      412            100%   <- ~2x faster, same tokens
MAX_CONCURRENCY=4, latency=50     960      412            100%   <- cap at 2 (engine limit)
SUBAGENT_TIMEOUT_MS=200           fail@1   -              0%     <- timeout escalates
COMPACTION_THRESHOLD=0.75          -       412            -
COMPACTION_THRESHOLD=0.25          -       188            -      <- smaller ledger
```

---

## Risk Table

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Fake dispatcher diverges from real `delegate_task` semantics | Medium | High | Keep dispatcher contract identical to `SubagentDispatcher` type; assert parity in accuracy test |
| Timing flaky on loaded CI box | High | Medium | Run timing assertions as *ratios* (conc2 < conc1*0.7), not absolute ms; retries:0 locally, 2 in CI |
| Playwright CLI spawn needs `tsx` on PATH | Low | Medium | Resolve `npx tsx` absolute path in `run-cli.ts`; pin tsx 4.23.12 |
| Token estimate (bytes/4) not the real tokenizer | Low | Low | Document it is a *relative* metric; only assert monotonic deltas, never absolute "token" counts |
| Loop-guard test accidentally pleases the hash registry | Medium | Medium | Use a dispatcher that returns an IDENTICAL debrief on every attempt to force the collision path |

---

## Test Design — the three axes

### 1. Accuracy (what must be correct regardless of parameters)
Driven by `accuracy.test.ts` against `StandardCodeReviewer` + `OrchestrationEngine` with the fake dispatcher in "accurate" mode.

| ID | Assertion | Command |
|----|-----------|---------|
| A1 | `classify()` buckets FE/BE/AMBIGUOUS per `defaultClassifyFile` rules (incl. `convex/` path-start) | `npx tsx references/bench/accuracy.test.ts` |
| A2 | Exactly 2 specialised reviewers dispatched for a mixed plan; AMBIGUOUS files appear in BOTH lanes | same |
| A3 | Composer selects exactly 2 recommendations + 2 suggestions from merged subagent output | same |
| A4 | Loop-guard: a dispatcher returning identical debrief escalates the job after `MAX_REVISION_CYCLES` (no infinite loop) | same |
| A5 | `assertScopeBoundary('/evil','/scope')` throws; `assertScopeBoundary(scope,scope)` returns OK (tautology documented, not a guard) | same |

### 2. Timing (how parameters change wall-clock)
`timing.test.ts` varies `ORCHESTRATOR_CONFIG` (clone + override) and the dispatcher latency.

| Setting | Expected result |
|---------|-----------------|
| `MAX_CONCURRENCY=2` vs `=1`, latency 50ms, 4 files | conc2 wall < conc1 wall * 0.7 (parallel speedup) |
| `MAX_CONCURRENCY=4` | Wall ≈ conc2 wall (engine caps at 2; extra slots unused) |
| `SUBAGENT_TIMEOUT_MS=200`, dispatcher sleeps 500ms | Job ESCALATES; total wall ≈ timeout, not 3×500 |
| Playwright E2E `--review` on mixed plan | stdout contains `[COMPOSER] Selected recommendations (2)` |

### 3. Token use (how compaction + size change the context footprint)
`token.test.ts` calls `ContextCompactor.compact()` directly with synthetic JobCards of varying size and threshold.

| Setting | Expected result |
|---------|-----------------|
| `COMPACTION_TOKEN_THRESHOLD` 0.75 → 0.25 | ledger `estimateTokenCount` strictly decreases |
| Plan size 10 → 100 files | ledger token estimate grows monotonically |
| Verified jobs excluded | compacted ledger omits VERIFIED job bodies, keeps only hash |

---

## Parameter Investigation (the four knobs an agent must honor to finish a task)

These are read from `references/orchestrator.ts:12-17` (`ORCHESTRATOR_CONFIG`). The benchmark exists to *set* them with evidence, not默认值.

| Parameter | Current | Sweep range | What "different results" proves |
|-----------|---------|-------------|--------------------------------|
| `MAX_CONCURRENCY` | 2 | 1, 2, 4 | Wall-clock scales then plateaus at the engine cap |
| `MAX_REVISION_CYCLES` | 3 | 1, 3, 5 | Loop-guard escalation point moves; more cycles = more retries before escalate |
| `SUBAGENT_TIMEOUT_MS` | 180000 | 200, 2000, 180000 | Below real subagent latency → forced escalation; above → completes |
| `COMPACTION_TOKEN_THRESHOLD` | 0.75 | 0.25, 0.5, 0.75, 1.0 | Lower threshold = smaller ledger = fewer tokens per spawn |

**Best-practice test method:** each knob is varied *one at a time* (ceteris paribus) so the delta is attributable. The reporter writes one row per (knob,value) combo. A setting "produces a different result" iff its row differs from the baseline on at least one axis (wall_ms / ledger_tokens / accuracy). If two settings produce *identical* rows, that knob is inert at that range and the plan records it as "no effect observed — do not tune."

---

## Bite-Sized Tasks

### Task 1: Scaffold bench/ and fake dispatcher

**Files:**
- Create: `references/bench/fake-dispatcher.ts`
- Create: `references/bench/fixtures/mixed.plan.json`
- Create: `references/bench/fixtures/ambiguous.plan.json`
- Create: `references/bench/fixtures/loop-bomb.plan.json`

**Step 1: Write the fake dispatcher (latency + accuracy toggle)**
```ts
import type { SubagentDispatcher, SubagentResult } from '../orchestrator.js';
export function makeFakeDispatcher(opts: { latencyMs: number; accurate: boolean }): SubagentDispatcher {
  return async (_id, payload) => {
    if (opts.latencyMs) await new Promise((r) => setTimeout(r, opts.latencyMs));
    const ok: SubagentResult = {
      status: 'COMPLETED', filesModified: [], debrief: `did ${payload.missionId}`,
      selfAudit: 'ok',
      recommendations: opts.accurate ? ['rec A', 'rec B', 'rec C'] : [],
      suggestions: opts.accurate ? ['sug A', 'sug B', 'sug C'] : [],
    };
    return ok;
  };
}
```

**Step 2: Run tsc to confirm it compiles against the engine's types**
Run: `cd references && npx tsc --noEmit --strict --skipLibCheck --module node16 --moduleResolution node16 --target es2022 --types node bench/fake-dispatcher.ts orchestrator.ts`
Expected: no errors

**Step 3: Commit**
```bash
git add references/bench && git commit -m "bench: scaffold fake dispatcher + fixtures"
```

### Task 2: Accuracy test

**Files:**
- Create: `references/bench/accuracy.test.ts`

**Step 1: Write failing accuracy assertions (A1–A5 above)**
**Step 2: Run, expect PASS** `npx tsx references/bench/accuracy.test.ts`
**Step 3: Commit**

### Task 3: Timing sweep

**Files:**
- Create: `references/bench/timing.test.ts`
- Create: `references/bench/run-cli.ts` (Playwright subprocess launcher)

**Step 1: Write concurrency + timeout sweep; assert ratio laws**
**Step 2: Run** `npx tsx references/bench/timing.test.ts` → expect PASS
**Step 3: Commit**

### Task 4: Token-use sweep

**Files:**
- Create: `references/bench/token.test.ts`

**Step 1: Assert ledger shrinks as threshold drops; grows with plan size**
**Step 2: Run** `npx tsx references/bench/token.test.ts` → expect PASS
**Step 3: Commit**

### Task 5: Playwright E2E + reporter

**Files:**
- Create: `references/bench/e2e.spec.ts`
- Create: `references/bench/report.ts`

**Step 1: Write Playwright spec that spawns the real CLI and parses stdout**
**Step 2: Write reporter that emits `bench/results/<stamp>.json` + the comparison table**
**Step 3: Run** `npx tsx references/bench/report.ts` → expect a populated table
**Step 4: Commit**

---

## Verification (run after every task, and at the end)

```bash
cd references
# types
npx tsc --noEmit --strict --skipLibCheck --module node16 --moduleResolution node16 --target es2022 --types node *.ts bench/*.ts
# accuracy
npx tsx bench/accuracy.test.ts
# timing
npx tsx bench/timing.test.ts
# token
npx tsx bench/token.test.ts
# e2e + report
npx tsx bench/report.ts
```

All four must exit 0 and the reporter must print a table where at least one parameter row differs from baseline on wall_ms / ledger_tokens / accuracy.

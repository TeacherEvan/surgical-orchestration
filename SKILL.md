---
name: surgical-orchestration
description: "Use when coordinating multi-folder subagent builds."
version: 1.0.0
author: Hermes Agent (based on Gemini AI architectural review)
license: MIT
platforms: [linux, macos, windows]
categories: [software-development]
metadata:
  hermes:
    tags: [orchestration, subagent, multi-agent, playwright, testing, concurrency, scope-sandbox, context-compaction, loop-prevention]
    related_skills: [code-review, test-driven-development, simplify-code, plan]
---

# Surgical Orchestration

Use when coordinating multi-folder code changes via subagents: parse the build plan into directory-scoped jobs, spawn Worker + Verifier subagents (max 2 concurrent), enforce hard path-boundary sandboxing, compact context before each spawn, deduplicate via SHA-256 debrief hashing, and run Playwright tests post-verification with failure-isolation agents.

## Overview & Goal

Surgical Orchestration is an AI-driven multi-agent workflow that decomposes a build plan into directory-scoped tasks, executes them with strict concurrency and boundary controls, verifies each task through a Worker-Verifier loop, and validates the final result with Playwright tests. The core principle is: do more with less context, enforce boundaries at the tool layer, and prevent loop runaway.

**Core Principles:**
1. FOLLOWING BEST PRACTICES
2. IS THAT THE BEST YOU CAN DO?

## System Constraints & Limits

| Parameter | Limit | Enforcement Action |
|---|---|---|
| Max Concurrent Subagents | 2 | Task queue locks until active agent exits/dies |
| Directory Scope Access | 1 Parent Folder / Agent | Hard tool-level path assertion filter |
| Max Revision Cycles | 3 per folder target | Auto-escalate to Orchestrator; spawn failure log |
| Context Compaction Trigger | > 75% Token Window | Execute `compact_context()` before next spawn |
| Subagent Timeout | 180 seconds | SIGKILL subagent process, log timeout, mark failed |
| Debrief SHA-256 Deduplication | 100% Match | Immediate subagent termination to kill loops |

## Architecture Diagram

```
+-----------------------------+
|     MAIN ORCHESTRATOR       |
|  - Manages JobCard          |
|  - Enforces Scope & Memory  |
|  - Runs Context Compactor   |
+--------------+--------------+
               |
     +-------+-------+-------+
     | (Scope: Folder A)     | (Scope: Folder B)
     v                       v
+--------------------------+                   +--------------------------+
|   WORKER SUBAGENT (A)    |                   |   WORKER SUBAGENT (B)    |
| - Implement scope changes|                   | - Implement scope changes|
+------------+-------------+                   +------------+-------------+
|                                               |
                                               v
+--------------------------+                   +--------------------------+
|  VERIFIER SUBAGENT (A)   |                   |  VERIFIER SUBAGENT (B)   |
| - Review & compare edits |                   | - Review & compare edits |
+------------+-------------+                   +------------+-------------+
|                                               |
+-----------------------+-----------------------+
| (All Scopes Verified [X])
v
+-----------------------------+
|   PLAYWRIGHT TEST RUNNER    |
+--------------+--------------+
| (If Fails)
v
+-----------------------------+
|    TEST-FIXER SUBAGENT      |
| - Error Trace + README Only |
| - Single-pass debrief & die |
+-----------------------------+
```

## Agent Roles

Code map: `OrchestrationEngine` (state machine, one per build plan) owns a
`SubagentManager` (concurrency cap, timeout watchdog, spawn/terminate events),
which calls the injected `SubagentDispatcher` to actually run a subagent.

### 1. Main Orchestrator
- **Responsibility:** Parses the build plan, initializes the JobCard, spawns scope-limited subagents up to concurrency limit $C_{\\max} = 2$, compacts context before spawning, tracks SHA-256 debrief hashes, and runs integration tests.
- **Permissions:** Full repository access, process spawning authority, state tracking.

### 2. Worker Subagent
- **Responsibility:** Executes the code edits required by the build plan for exactly one assigned parent folder.
- **Permissions:** Restricted exclusively to assigned directory scope (`./path/to/folder/*`). Access to external folders will throw security violations.

### 3. Verifier Subagent
- **Responsibility:** Reviews the work completed by the Worker Subagent against the Orchestrator's instructions and best practices.
- **Permissions:** Restricted to the same single directory scope as the Worker. Emits `COMPLETED` or `FAILED`.

### 4. Test-Fixer Subagent
- **Responsibility:** Spawns only if Playwright tests fail after all folder scopes are marked verified. Operates on "Need-to-Know" context basis.
- **Permissions:** Receives only test failure log/trace, failing spec file, `README.md`, and relevant architecture spec. Must report back with a debrief and immediately exit (die).

## JobCard Schema & State Machine

The Orchestrator maintains state using a lightweight `JobCard` structure:

```json
{
  "planId": "BUILD-1754380000000",
  "overallStatus": "IN_PROGRESS",
  "jobs": {
    "JOB-001": {
      "id": "JOB-001",
      "parentFolder": "src/services/auth",
      "status": "VERIFICATION_ACTIVE",
      "attempts": 1,
      "lastVerifierFeedback": "Rotation lacks a test for the expired-token path.",
      "debriefHistory": [
        {
          "attempt": 1,
          "agentRole": "WORKER",
          "debrief": "Implemented JWT rotation and updated session cookies.",
          "hash": "de387e73f6b851f3fbba6291117bfc19422f637fdfc9e3ee7c270c547cb26649"
        }
      ]
    }
  },
  "completedHashes": [
    "de387e73f6b851f3fbba6291117bfc19422f637fdfc9e3ee7c270c547cb26649"
  ]
}
```

### State Transitions

```
[ PENDING ] ---> [ IN_PROGRESS (Worker) ] ---> [ VERIFICATION (Reviewer) ]
                     ^                             |
                     |--- (Failed: Cycle < 3) -----|
                     |
                     v (Failed: Cycle >= 3)
                [ ESCALATED ] -------------> [ VERIFIED / TICKED ]
```

1. `PENDING` → `WORKER_ACTIVE` (Orchestrator spawns Worker)
2. `WORKER_ACTIVE` → `VERIFICATION_ACTIVE` (Worker completes, Orchestrator spawns Verifier)
3. `VERIFICATION_ACTIVE` → `VERIFIED` (Verifier passes, Mark checkbox [X])
4. `VERIFICATION_ACTIVE` → `WORKER_ACTIVE` (Verifier fails, attempts < 3, Re-spawn Worker with feedback)
5. `VERIFICATION_ACTIVE` → `ESCALATED` (attempts >= 3 or duplicate hash, halt scope)

## Step-by-Step Execution Protocol

### Step 0: Investigate and write the Blueprint

Before any job exists, produce a compressed blueprint of the codebase — facts
with `path:line` evidence, an explicit `@DONE` list of things that only *look*
missing, and gates as literal commands. See
[Blueprint + Plan format](./references/blueprint-plan-format.md).

This is not ceremony. The `@DONE` section is what stops a subagent rebuilding a
shipped feature because a grep missed a renamed symbol, and the `@BAN` line is
the only instruction that travels with every mission envelope.

### Step 1: Initialization & Plan Parsing
1. Parse the build plan.
2. Group all required file modifications by their top-level parent directories.
3. Instantiate a `JobCard` entry for each unique parent folder with status `PENDING`.

### Step 2: Context Compaction Sweep
Before spawning any subagent:
1. Strip all raw stdout, long diffs, or execution logs from Orchestrator memory.
2. Retain only the current active JobCard ledger and verified debrief hashes.
3. Format the ledger as a compact Markdown block for inclusion in the subagent mission envelope:

```markdown
### ACTIVE ORCHESTRATION LEDGER
- [X] Scope: src/components/ui | Status: VERIFIED | Hash: a8f3b912
- [/] Scope: src/services/auth | Status: WORKER_ACTIVE | Attempt: 1/3
```

### Step 3: Worker & Verifier Dispatch Loop
1. Check active subagent count. If `activeCount >= 2`, wait for an active slot to free.
2. Select the next `PENDING` job.
3. Spawn Worker Subagent with:
   - Directory scope (single parent folder)
   - Mission instructions
   - Core Principles: "FOLLOWING BEST PRACTICES", "IS THAT THE BEST YOU CAN DO?"
   - Context ledger (compacted)
   - Allowed paths
   - Max tool calls
4. Upon Worker completion, store SHA-256 hash of debrief. Check for hash collisions (if duplicate hash found, terminate branch to prevent loop).
5. Spawn Verifier Subagent to review Worker's changes.
6. If Verifier signals `COMPLETED`, update job status to `VERIFIED` ([X]), trigger Context Compactor, proceed to next folder.
7. If Verifier signals `FAILED`, increment attempt count. If `attempts < 3`, repeat from Worker step with Verifier feedback. If `attempts >= 3`, mark `ESCALATED`.

### Step 4: Playwright Test Validation
1. Once all folder jobs are marked `VERIFIED` ([X]), execute Playwright integration tests.
2. If all tests pass: Mark plan `COMPLETED`.
3. If tests fail:
   - Spawn Test-Fixer Subagent with restricted scope: Test files + README.md + ARCHITECTURE DIAGRAM ONLY
   - The Test-Fixer must report back with a debrief and immediately exit (die)
   - Hash debrief to detect if same fix was already attempted

## Tool-Layer Directory Sandbox

Subagent folder boundaries must be enforced at the runtime tool layer, not
merely via prompt instructions. `assertScopeBoundary(targetPath, allowedScope,
agentId)` in `references/security.ts` is the single implementation — call it
before **every** file read/write, with the *file* as `targetPath`.

Contract:

- Resolves symlinks via `realpath`, falling back to the nearest existing parent
  for files that do not exist yet. A naive `path.resolve` comparison is
  bypassable by symlinking out of the scope.
- Throws `[SECURITY_VIOLATION]` on escape; never returns a boolean the caller
  can forget to check.
- `assertScopeBoundary(scope, scope)` is a **tautology** and proves nothing.
  Boundary checks are per-file.

The code is deliberately not duplicated here — see `references/security.ts`.

## Anti-Looping Protocol

To eliminate recursive looping (e.g., subagent repeatedly submitting the same changes or failing in identical ways):

1. **Debrief Hashing:** Each subagent debrief is hashed with SHA-256 upon completion.
2. **Hash Registry:** All hashes are stored in `JobCard.completedHashes`.
3. **Collision Detection:** Before spawning a new Worker for a retry, check if the debrief hash already exists in the registry.
4. **Loop Termination:** If a 100% hash match is found, immediately terminate the subagent branch, mark the job as `ESCALATED`, and log a failure event.

## Code Reviewer + Composer Layer (post-build strategic review)

After the Worker/Verifier loop marks every folder `VERIFIED` (or the orchestrator
is run in `--review` mode), a dedicated **Code Reviewer** performs a separate,
strategic pass. It does not re-implement verification — it adds the front/back
split and an escalation path to a Composer that delivers a bounded verdict.

### Topology

```
[ Orchestrator: folders all VERIFIED ]
              |
              v
[ CODE REVIEWER ]  (classify every changed file)
   |  FRONTEND lane  --> [ FRONTEND_REVIEWER ]
   |  BACKEND  lane  --> [ BACKEND_REVIEWER  ]
   |  AMBIGUOUS       --> included in BOTH lanes (split review)
   v
[ COMPOSER ]  (takes ALL subagent recs, selects exactly 2 + 2)
   --> 2 recommendations + 2 suggestions to the human / main agent
```

### Rules (every actor, every level)

1. **Classification first.** `StandardCodeReviewer.classify()` buckets each
   changed file as `FRONTEND` (`.tsx/.jsx/.vue/.svelte/.css/.html`, or paths
   containing `/components/`, `/ui/`, `/frontend/`), `BACKEND` (`.py/.go/.rs/.java/
   .rb/.php/.sql/.prisma`, or `/api/`, `/server/`, `/backend/`, `/services/`,
   `convex/`), or `AMBIGUOUS` (everything else). AMBIGUOUS files are sent to
   BOTH reviewers so nothing escapes review.
2. **Specialised fan-out.** One `FRONTEND_REVIEWER` and one `BACKEND_REVIEWER`
   are dispatched. Each reviews only its lane's files and returns a *summarised*
   debrief plus its own `recommendations` + `suggestions` (the subagent-to-parent
   contract; see `SubagentResult`).
3. **Code Reviewer distils.** It forwards exactly **2 recommendations + 2
   suggestions** up to the Composer (sliced from the merged subagent output).
4. **Composer decides.** The Composer receives ALL subagent recommendations and
   MUST select exactly **2 recommendations + 2 suggestions** to surface. It does
   not invent new ones; it chooses which 2 of the collected findings matter most.
5. **Same contract up the chain.** Every subagent (reviewers → Code Reviewer →
   Composer → main orchestrator) returns `recommendations`/`suggestions` to its
   parent. The main orchestrator is the only one that reports to the human.

### CLI

```bash
npx tsx surgical-orchestration.ts --review <build-plan.json>
# classifies front/back, fans out two specialised reviewers (dry-run-safe),
# then prints the Composer's selected 2 recommendations + 2 suggestions.
```

Implementation lives in `references/orchestrator.ts`
(`StandardCodeReviewer`, `CodeReviewLayer`, `Composer` is in
`references/surgical-orchestration.ts`). Unit-tested in
`references/orchestrator.review.test.ts` (REDPROOF: 12 assertions, run with
`npx tsx orchestrator.review.test.ts`).

## Subagent Mission Envelope

Each subagent receives a mission envelope consisting of a structured JSON header followed by Markdown instructions.

### JSON Header (Machine-Readable)
```json
{
  "mission_id": "TASK-MOD-004",
  "folder_scope": "./src/components/auth",
  "allowed_paths": ["./src/components/auth/*"],
  "principals": [
    "FOLLOWING BEST PRACTICES",
    "IS THAT THE BEST YOU CAN DO?"
  ],
  "max_tool_calls": 15,
  "return_schema": {
    "status": "COMPLETED | FAILED",
    "files_modified": [],
    "debrief_summary": "string"
  }
}
```

### Markdown Instructions (Human-Readable)
```markdown
SYSTEM INSTRUCTIONS: SURGICAL SUBAGENT

Scope Limit: {{ALLOWED_FOLDER_SCOPE}}
Role: {{AGENT_ROLE}} (WORKER | VERIFIER)

PRINCIPALS:
1. FOLLOWING BEST PRACTICES
2. IS THAT THE BEST YOU CAN DO?

RESTRICTIONS:
- You are strictly locked to target directory: {{ALLOWED_FOLDER_SCOPE}}.
- File operations outside this directory will throw system exceptions and terminate your session.
- Do not request context on external modules unless strictly required for interfaces.

MISSION OBJECTIVE:
{{MISSION_OBJECTIVE}}

EXIT PROTOCOL:
Upon task completion, emit a final output structured strictly as JSON:
{
  "status": "COMPLETED | FAILED",
  "files_modified": ["string"],
  "debrief": "Concise bullet points of changes made, trade-offs, and verification results.",
  "self_audit": "Answering: Is that the best I could do under best practices?"
}
After emitting this JSON, signal execution end.
```

## Orchestrator System Prompt

```markdown
SYSTEM INSTRUCTIONS: SURGICAL ORCHESTRATOR

You are the Main Orchestrator. Your objective is to parse the build plan and execute changes across directory boundaries with zero context bloat and minimal subagent prompting.

CORE RULES:
1. MAX CONCURRENCY: Maximum 2 active subagents allowed simultaneously.
2. SCOPE LOCK: Assign subagents EXACTLY 1 parent folder. Never leak cross-folder file paths.
3. LOOP PREVENTION: Track debrief SHA-256 hashes. If a debrief matches a prior state, terminate the loop instantly and modify the JobCard instruction.
4. CONTEXT PRUNING: Compress history before every agent spawn. Retain ONLY the active JobCard and verified hashes.

EXECUTION PIPELINE:
Step 1: Read build plan. Create JobCard status table.
Step 2: Spawn Worker Subagent for Target Folder A.
Step 3: Upon completion, spawn Verifier Subagent for Target Folder A.
Step 4: If verification passes -> Mark checkbox [X], trigger Context Compactor, proceed to Folder B.
Step 5: Once all checkboxes are [X], execute Playwright Test Runner.
Step 6: If tests fail -> Spawn Test-Fix SubAgent (Scope: FAILED TEST TRACE + README.md + ARCHITECTURE DIAGRAM ONLY).
```

## Context Compaction Routine

Before each spawn, reduce the orchestrator's state to the ledger only: strip raw
stdout, diffs and execution logs; keep the JobCard status table and the verified
debrief hashes. `ContextCompactor.compact(jobCard)` in `references/orchestrator.ts`
is the implementation.

Two rules that are easy to get wrong:

- **Never recompute a hash during compaction.** Reuse the digest recorded at
  dispatch time (`debriefHistory[].hash`). A second computation from the debrief
  string produces a different digest than the registry holds, so the ledger
  advertises hashes that loop detection can never match.
- **The ledger, not the transcript, is what the subagent sees.** It ships in
  `payload.contextSummary`; anything absent from it is invisible to the worker.

Rendered form for a mission envelope:

```markdown
### ACTIVE ORCHESTRATION LEDGER
- [X] Scope: src/components/ui | Status: VERIFIED | Hash: a8f3b912
- [/] Scope: src/services/auth | Status: WORKER_ACTIVE | Attempt: 1/3
```

## Failure-Mode Decision Matrix

| Failure Mode | Detection Signal | Automated Remediation |
|---|---|---|
| Infinite Review Loop | Reviewer rejects Worker output 3 times | Freeze scope; escalate failure to Orchestrator; issue architectural delta prompt |
| Duplicate Work Loop | SHA-256 hash collision on debrief payload | Force kill subagent; Orchestrator modifies target prompt strategy |
| Playwright Test Drift | Test runner fails on existing assertions | Spawn isolation agent with only trace error + README.md; rewrite tests to fit code blueprint |
| Path Traversal Escape | Security Guard Exception thrown | Terminate task branch; flag security event in JobCard |

## Using This Skill

1. **Define the build plan** — a list of changes grouped by parent directory.
2. **Initialize the JobCard** — create entries for each folder with status `PENDING`.
3. **Run the dispatch loop** — spawn Worker + Verifier pairs per folder, respecting the 2-agent concurrency cap.
4. **Compact context** before each spawn if utilization exceeds 75%.
5. **Execute Playwright tests** once all jobs are `VERIFIED`.
6. **On test failure**, spawn a Test-Fixer with need-to-know scope only.

## Hermes Integration Guide

The engine is a **library with no subagent runtime of its own**. You supply one
by passing a `SubagentDispatcher` — injection, not subclassing.

```typescript
import { OrchestrationEngine, type SubagentDispatcher } from './references/orchestrator.js';

const dispatcher: SubagentDispatcher = async (agentId, payload) => {
  const results = await delegate_task({
    goal: payload.instructions,
    context: `Mission: ${payload.missionId}\nRole: ${payload.role}\nScope: ${payload.allowedFolderScope}\nLedger: ${payload.contextSummary}`,
    role: 'leaf',
  });
  return parseSubagentResult(results[0].summary); // exported by surgical-orchestration.ts
};

const engine = new OrchestrationEngine(plan, dispatcher);
const result = await engine.run();
```

BuildPlan shape:

```json
{
  "description": "Add auth + payment features",
  "changes": [
    { "filePath": "src/components/auth/LoginForm.tsx", "description": "Add JWT refresh", "type": "modify" },
    { "filePath": "src/services/payment/StripeClient.ts", "description": "Webhook verification", "type": "add" }
  ]
}
```

Construct the engine with no dispatcher and it throws `[NO_DISPATCHER]` on the
first spawn. That is deliberate: a stub that returned a synthetic `COMPLETED`
would be hashed into the loop registry and mark unverified folders `VERIFIED`.

### Verifying a change to this skill

```bash
cd references
npx tsc --noEmit --strict --skipLibCheck --module node16 \
  --moduleResolution node16 --target es2022 --types node *.ts
npx tsx surgical-orchestration.ts --init
npx tsx surgical-orchestration.ts --dry-run build-plan.json   # walks the state machine, spawns nothing
npx tsx orchestrator.review.test.ts                          # Code Reviewer + Composer unit proof (12 assertions)
npx tsx surgical-orchestration.ts --review build-plan.json   # classify front/back, fan out, Composer 2+2
```

`--dry-run` exercises the dispatch loop, ledger compaction and hash registry
without spending a single subagent. `--review` exercises the Code Reviewer
classification, the two specialised reviewer fan-out, and the Composer's 2+2
selection.

## Pitfalls (scars, dated)

- **2026-08-05 — the guard that could not fail.** `spawnSubagent` called
  `assertScopeBoundary(scope, scope)`: a path is always inside itself, so the
  sandbox assertion was a tautology. Real enforcement is per-FILE
  (`assertScopeBoundary(file, scope)`) at the tool layer, before each write.
- **2026-08-05 — prefix matching leaked scope.** Change routing used
  `dirname(file).startsWith(job.parentFolder)`, so scope `src/auth` swallowed
  every file in `src/authz`. Use segment-aware `isInsideFolder()`.
- **2026-08-05 — the loop guard ate healthy jobs.** Hashing the bare debrief
  *string* meant two different folders emitting the same sentence collided and
  escalated. Hash the canonical payload (scope + sorted files + debrief).
  Separately, the ledger recomputed a hash that never matched the registry.
- **2026-08-05 — the timeout did not time out.** The watchdog `setTimeout` only
  emitted an event; the orchestrator stayed `await`ing a dispatcher that might
  never return. The deadline must `reject` and be `Promise.race`d.
- **2026-08-05 — a spec doc that documented code that did not exist.** A
  parallel `*-specification.md` pasted 90%+ of the TypeScript inline and named a
  class (`SurgicalOrchestrator`) absent from the sources. Duplicated code in
  prose always drifts; the source files are the specification.
- Verifier feedback is only useful if it reaches the *next* worker attempt —
  store it on the job (`lastVerifierFeedback`) and inline it into the retry
  prompt, otherwise all three cycles repeat the same mistake.
- **2026-08-10 — the orchestrator that spawned nothing.** When the blueprint's
  jobs are already implemented (feature commits on the branch + working-tree
  files present, all gates green), spawning Worker/Verifier pairs is pure waste
  and risks the loop guard escalating healthy jobs. Switch to **verify-then-sync**
  mode: run the `@GATE` set, reconcile working-tree drift (dep-bump-vs-lockfile,
  doc version drift), commit scoped source only, push, confirm `0 0`. Agent
  files (`AGENTS.md`/`CLAUDE.md`/`.agents/`/`.claude/`) are write-protected and
  excluded from the commit. See `references/verify-then-sync.md`.
- **2026-08-10 — incoherent generated state in verify-then-sync.** Reverting
  tracked drift can still ship a broken tree if a generated file references an
  *untracked* module. Concrete case: `convex codegen` regenerated
  `convex/_generated/api.d.ts` to import `../lib/log.js` because a stray
  untracked `convex/lib/log.ts` sat on disk; HEAD's `api.d.ts` did NOT reference
  it. Committing the regenerated `api.d.ts` without the source breaks the next
  `convex dev`. Before `git checkout`/commit of generated files, confirm every
  module the generated file imports is tracked-or-intended. If the "drift" is
  generated-from-stray, revert the generated file to HEAD (HEAD is coherent) and
  **quarantine** the stray source: `mkdir -p .scratch-orphans && mv <file>
  .scratch-orphans/<file>.disabled` — never commit it, never silently delete it
  (user may have intended it on another branch). Also `package-lock.json`
  spurious deletions from npm version rewrites are NOT real dep changes:
  `git checkout -- package-lock.json` and move on. Drift-classification recipe:
  `references/verify-then-sync-drift-triage.md`.

- **2026-08-11 — parallel session already pushed.** When syncing to a shared
  remote, a sibling background agent (a `delegate_task` background run or a prior
  session) may have already pushed commits to the SAME branch. `git push` is then
  rejected (non-fast-forward: "Updates were rejected because the remote contains
  work that you do not have locally"). NEVER force-push — that clobbers the
  parallel agent's work. Instead: `git fetch origin`; inspect divergence with
  `git log HEAD..origin/main` and `git diff --stat HEAD origin/main`; then
  `git rebase origin/main`. During the rebase take the remote's (`--ours`) version
  for every file the parallel agent already fixed, and KEEP ONLY your unique
  contributions (e.g. a CI stub the remote deleted, or plan/blueprint docs). For
  files needing both changes (a vitest `resolve.alias` block), manually merge to
  keep both. Verify gates green, then push. Full recipe:
  `references/verify-then-sync-parallel-push.md`.
- **2026-08-13 — generator commands collide across scopes.** Two parallel workers (concurrency cap 2) both needed the `apps/flutter` scaffold: Task 1.1 was building it while Task 1.2 ran `flutter create apps/flutter` to ensure the target existed. Both wrote the SAME shared path; the second clobbered the first's 5-platform scaffold with a linux-only copy. Directory-scope sandboxing did NOT catch this because `flutter create` regenerates an entry file at a path both agents considered in-scope. Lesson: any command that regenerates a shared entry/manifest (`flutter create`, `npm init`, `cargo new`, codegen) is a cross-scope collision risk even under 1-folder-per-agent. Rules: (a) exactly ONE agent owns the scaffold/generator step; (b) never have a second agent run a generator "to ensure the path exists" — pass the dependency as a precondition, or have the dependent job wait; (c) if two jobs share a manifest (`Cargo.toml`, `pubspec.yaml`) or a type contract (e.g. one `SignalObservation` struct), DO NOT fan out — serialize or build directly. A single tightly-coupled package is safer built by the orchestrator than by racing workers.

- **2026-08-13 — the spawn self-check was a tautology, and the fix was a lie.** `spawnSubagent` called `assertScopeBoundary(scope, scope)`: a path is always inside itself, so the assertion could never fail — the exact bug the 2026-08-05 Pitfall claims was removed. Worse, when re-read it still stood, and its own comment asserted "this deliberately no longer compares the scope to itself." The library does NOT know the individual files a host subagent will touch, so it CANNOT do per-file sandboxing; per-file enforcement is the HOST's contract (call `assertScopeBoundary(file, scope)` from the tool layer before every read/write). The library's job is only to fail closed on a missing/empty scope: throw `[SCOPE_INVALID]` when `allowedFolderScope` is unset. Verified by probe: `assertScopeBoundary('/evil/file','/scope')` correctly throws; `assertScopeBoundary(scope, scope)` returns OK (no-op).
- **2026-08-13 — `--dry-run` hung instead of walking the state machine.** `--dry-run` is documented as "spawn nothing / walk the state machine," but `run()` always ended by executing real `npx playwright test` (orchestrator.ts `runPlaywrightTests`). With no project test setup it hangs indefinitely (observed EXIT=124, 120s timeout). Fix: `OrchestrationEngine` now takes `opts.skipTests`; the CLI passes `skipTests: dryRun`, so dry-run returns SUCCESS on the state-machine walk without a live test side effect. Re-verified: dry-run now exits 0.
- **2026-08-13 — schema/code drift on the debrief payload.** `references/debrief-schema.json` declared `errorSignature` REQUIRED, but `DebriefPayload` in `debrief.ts` types it optional and `orchestrator.ts` only fills it on FAILED status. A strict JSON-schema validator would reject the normal (success) case. Fixed: dropped `errorSignature` from the schema's `required` array to match the code. Before citing any internal schema as authority, grep it against the emitting code.
- **2026-08-13 — `convex/` prefix misclassified as AMBIGUOUS.** `defaultClassifyFile` matched `/convex/` (with surrounding slashes) but real repo paths are `convex/payments.ts` with NO leading slash, so they fell through to AMBIGUOUS and escaped the BACKEND lane. A unit test (`orchestrator.review.test.ts`) caught it: added `p.startsWith('convex/')`. Lesson: path heuristics must cover both `dir/` (mid-path) and `dir/` (path-start) forms; the test is the gate, not the regex.
- **2026-08-13 — the Composer must SELECT, not INVENT.** The Composer's contract (per the user's spec) is to take ALL subagent recommendations and decide which 2 to surface — it is a reducer over collected findings, not a generator of new advice. Encoding it as `candidates.slice(0, 2)` enforces "exactly 2 recommendations + 2 suggestions" and keeps the verdict bounded for the human reader.
- **2026-08-13 — reviewers need a recommendations/suggestions channel in `SubagentResult`.** The original `SubagentResult` had only `debrief`/`selfAudit`; there was no wire for a subagent to pass its own recommendations up to the parent. Added optional `recommendations?: string[]` and `suggestions?: string[]` to `SubagentResult` so every tier (reviewers → Code Reviewer → Composer) honours the same up-chain contract.
- **2026-08-13 — the default linter `tsc` is NOT the verification gate, and its errors are false positives.** The skill's linter runs a bare `tsc --noEmit <file>` WITHOUT `--types node`, so every `node:*` import and `process`/`EventEmitter` reference errors as `TS2591`/`TS2339`. These are NOT real defects — they vanish under the skill's prescribed command (`tsc --noEmit --strict --skipLibCheck --module node16 --moduleResolution node16 --target es2022 --types node *.ts`). Always verify with the prescribed command, never the bare linter, before concluding the TS is broken. Run it in an isolated temp dir (copy `*.ts` out, `npm i -D typescript @types/node`) so you never pollute the skill tree with `node_modules`. See `references/verify-skill-typescript.md`.
- **2026-08-13 — verify skill-shipped TS with a framework-free `*.test.ts` run via `npx tsx`.** No vitest/jest needed: a standalone script with `assert()`-style checks and `process.exit(1)` on failure proves behavior end-to-end. The review test `orchestrator.review.test.ts` is the worked example — it caught the `convex/` misclassification that the type-checker could never see. Full recipe + the linter gotcha: `references/verify-skill-typescript.md`.

## References

- [Blueprint + Plan format](./references/blueprint-plan-format.md) — compressed agent-to-agent plan wire format
- [Orchestrator runtime](./references/orchestrator.ts) — state machine, dispatcher injection, compaction
- [Security sandbox](./references/security.ts) — realpath boundary enforcement
- [Debrief hashing](./references/debrief.ts) — canonical SHA-256 dedup
- [CLI entry point](./references/surgical-orchestration.ts) — delegate_task dispatcher + `--dry-run`
- [Orchestrator prompt](./references/orchestrator-prompt.md)
- [Subagent prompt](./references/subagent-prompt.md)
- [JobCard schema](./references/jobcard-schema.json) — orchestrator state ledger
- [Subagent exit schema](./references/subagent-exit-schema.json) — the JSON a subagent must emit
- [Debrief schema](./references/debrief-schema.json) — canonical hash input
- [Verify-then-sync mode](./references/verify-then-sync.md) — when the plan is already done, verify gates + commit/push/doc-sync instead of spawning workers

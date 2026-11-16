# Security Model & Threat Boundaries

`surgical-orchestration` treats LLM-generated file paths, debrief payloads, and build plans as untrusted inputs.

## Guaranteed Invariants

1. **Canonical Path Containment (`references/security.ts`):**
   - `resolveScopedPath(targetPath, allowedScope, agentId)` and `assertScopeBoundary(targetPath, allowedScope, agentId)` reject empty/whitespace strings, `\0` null bytes, dangling symlinks, any symlink segment within the scope subtree (`lstatSync` + `realpathSync`), and sibling-prefix escapes (e.g., `/workspace/job_10` vs `/workspace/job_1`) via `path.relative` containment checks.
   - All scope violations throw deterministic errors tagged `[SCOPE_INVALID] [SECURITY_VIOLATION]`.
   - `openScopedFile()` performs kernel-enforced `O_NOFOLLOW` opens (`fs.constants.O_NOFOLLOW`) and verifies the opened file descriptor matches a non-symlink regular file before returning bytes.
2. **Pre-Slot Validation & Deterministic Cleanup (`references/subagent-manager.ts`):**
   - Scope checks run **before** `activeAgents.set(...)` acquires a concurrency slot.
   - Active slots are always released in `try/finally`, preventing deadlocked concurrency pools on `[SCOPE_INVALID]` errors or dispatcher exceptions.
3. **Cancellation & Timeout Enforcement:**
   - Every subagent dispatch receives a combined `AbortSignal` wired to `SUBAGENT_TIMEOUT_MS` (or `EngineOptions.timeoutMs`) and any parent `AbortController`.
4. **Worktree Isolation for Parallel Agents:**
   - Parallel workers must run only against disjoint `parentFolder` scopes (or isolated `git worktree` checkouts when sharing build trees).
   - Single-scope plans execute linearly without fanning out Worker/Verifier pairs.
5. **Failure Non-Promotion:**
   - When a `WORKER` returns `FAILED`, `OrchestrationEngine` records the failure in `lastVerifierFeedback`, consumes the cycle budget, and short-circuits **before** spawning `VERIFIER`.
6. **Runtime Schema Discipline:**
   - Wire contracts (`jobcard-schema.json`, `debrief-schema.json`, `subagent-exit-schema.json`, `build-plan-schema.json`) enforce JSON Schema Draft `2020-12` with `"unevaluatedProperties": false`.
   - `serializeJobCard()` converts `Map`/`Set` structures to plain JSON records matching `jobcard-schema.json`.
   - CLI auto-execution in `references/surgical-orchestration.ts` is gated behind `isCliEntryPoint()`.

## Host Runtime & TOCTOU Boundary

- Node userland checks plus `O_NOFOLLOW` stop symlink traversal on direct reads via `openScopedFile()`.
- Full race isolation for arbitrary external subprocesses (compilers, test runners) still requires host OS sandboxing (`git worktree`, container filesystem mounts, or Seatbelt/Bubblewrap) enforced by the calling runtime.

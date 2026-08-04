# Surgical Orchestration

A multi-agent workflow skill for coordinating code changes across directory boundaries with strict scope locking, bounded concurrency, loop prevention, and Playwright-backed verification.

Use this when a build plan spans multiple folders and you want changes applied surgically—one scoped worker/verifier pair per directory, with orchestration state tracked explicitly and redundancies eliminated by debrief hashing.

## Core Principles

- **FOLLOWING BEST PRACTICES**
- **IS THAT THE BEST YOU CAN DO?**

## What It Does

- Parses a build plan into directory-scoped jobs
- Spawns Worker + Verifier subagents per folder, max 2 concurrent
- Enforces hard path-boundary sandboxing per subagent
- Compacts orchestrator context before each spawn
- Deduplicates work via SHA-256 debrief hashing
- Runs Playwright tests after all scopes are verified
- Spawns an isolated Test-Fixer on test failures with need-to-know context only

## Key Controls

| Parameter | Limit | Enforcement |
|---|---|---|
| Max concurrent subagents | 2 | Queue until a slot frees |
| Directory scope per agent | 1 parent folder | Tool-level path assertion |
| Max revision cycles per folder | 3 | Escalate to orchestrator on breach |
| Context compaction trigger | >75% token window | Compact before next spawn |
| Subagent timeout | 180s | Kill on breach, mark failed |
| Debrief deduplication | SHA-256 | Terminate loop on hash match |

## Repository Structure

```
surgical-orchestration/
├── SKILL.md                        # Skill entrypoint
├── README.md                       # This file
└── references/
    ├── jobcard-schema.json         # State schema
    ├── orchestrator-prompt.md      # Orchestrator system prompt
    ├── orchestrator.ts             # Runtime state machine
    └── subagent-prompt.md          # Worker/Verifier mission envelope
```

## Quick Start

1. Install or reference this skill in your agent runtime.
2. Define a build plan grouped by parent directory.
3. Initialize a JobCard with one entry per folder.
4. Run the dispatch loop:
   - Spawn Worker for a folder
   - Spawn Verifier for the same folder
   - On pass: mark verified, compact context, move on
   - On fail: retry up to 3 times, then escalate
5. Run Playwright tests after all folders are verified.
6. On test failure, spawn a Test-Fixer scoped to the failing trace, README, and architecture diagram only.

## State Machine

```
PENDING → WORKER_ACTIVE → VERIFICATION_ACTIVE
                                    ├─ VERIFIED
                                    ├─ WORKER_ACTIVE (retry)
                                    └─ ESCALATED
```

## Anti-Looping

Every debrief is SHA-256 hashed. If a new debrief matches a prior hash, the branch is killed immediately and the job is marked `ESCALATED`.

## Path Sandbox Example

```typescript
import * as path from 'path';

export function assertScopeBoundary(targetPath: string, allowedScope: string, agentId: string): void {
  const absTarget = path.resolve(targetPath);
  const absScope = path.resolve(allowedScope);
  const relative = path.relative(absScope, absTarget);
  const isInside = !relative.startsWith('..') && !path.isAbsolute(relative);

  if (!isInside && absTarget !== absScope) {
    throw new Error(
      `[SECURITY_VIOLATION] Subagent '${agentId}' attempted unauthorized path access: '${targetPath}'. Locked Scope: '${allowedScope}'`
    );
  }
}
```

## License

MIT

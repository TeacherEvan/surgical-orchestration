---
name: surgical-orchestration
description: "Multi-agent workflow: coordinate subagents across directory boundaries with scope locking, concurrency caps, SHA-256 loop prevention, context compaction, and Playwright test validation."
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
  "planId": "BUILD-2026-0804",
  "overallStatus": "IN_PROGRESS",
  "jobs": {
    "JOB-001": {
      "parentFolder": "/src/services/auth",
      "status": "VERIFICATION_ACTIVE",
      "attempts": 1,
      "debriefHistory": [
        {
          "attempt": 1,
          "agentRole": "WORKER",
          "debrief": "Implemented JWT rotation and updated session cookies.",
          "hash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        }
      ]
    }
  },
  "completedHashes": [
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
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

Subagent folder boundaries must be enforced at the runtime tool layer, not merely via prompt instructions. The TypeScript guard:

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

## Anti-Looping Protocol

To eliminate recursive looping (e.g., subagent repeatedly submitting the same changes or failing in identical ways):

1. **Debrief Hashing:** Each subagent debrief is hashed with SHA-256 upon completion.
2. **Hash Registry:** All hashes are stored in `JobCard.completedHashes`.
3. **Collision Detection:** Before spawning a new Worker for a retry, check if the debrief hash already exists in the registry.
4. **Loop Termination:** If a 100% hash match is found, immediately terminate the subagent branch, mark the job as `ESCALATED`, and log a failure event.

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

When context utilization hits 75%, run this state reduction logic before issuing a `spawn_agent` call:

```python
import hashlib
import json

def compact_orchestrator_context(job_card: dict, raw_history: list) -> dict:
    """
    Strips raw tool outputs and full conversation logs.
    Retains only state markers, debrief hashes, and active checklists.
    """
    compact_ledger = {
        "active_jobs": [],
        "completed_checks": [],
        "debrief_hashes": []
    }

    for item in job_card.get("tasks", []):
        if item["status"] == "VERIFIED":
            debrief_bytes = item["debrief_summary"].encode('utf-8')
            hash_sig = hashlib.sha256(debrief_bytes).hexdigest()

            compact_ledger["completed_checks"].append({
                "folder": item["parent_folder"],
                "hash": hash_sig[:8]
            })
            compact_ledger["debrief_hashes"].append(hash_sig)
        else:
            compact_ledger["active_jobs"].append({
                "folder": item["parent_folder"],
                "status": item["status"],
                "attempts": item["attempts"]
            })

    return compact_ledger
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

## References

- [TypeScript Runtime](./references/orchestrator.ts) — Production-ready state machine implementation
- [Orchestrator Prompt](./references/orchestrator-prompt.md) — Main Orchestrator system prompt
- [Subagent Prompt](./references/subagent-prompt.md) — Worker/Verifier mission envelope template
- [JobCard Schema](./references/jobcard-schema.json) — JSON schema for state tracking
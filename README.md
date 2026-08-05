# Surgical Orchestration

A multi-agent workflow skill for coordinating code changes across directory
boundaries with strict scope locking, bounded concurrency, loop prevention,
and Playwright-backed verification.

Use this when a build plan spans multiple folders and you want changes applied
surgically — one scoped worker/verifier pair per directory, with orchestration
state tracked explicitly and redundancies eliminated by debrief hashing.

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

## Architecture

`OrchestrationEngine` (state machine) owns a `SubagentManager` (concurrency
cap, timeout watchdog), which calls the injected `SubagentDispatcher` to run
subagents. The library ships no runtime — the host supplies the dispatcher.

See `SKILL.md` for the full specification and `references/` for the TypeScript
runtime, schemas, and prompt templates.

## Verifying

```bash
cd references
npx tsc --noEmit --strict --skipLibCheck --module node16 \
  --moduleResolution node16 --target es2022 --types node *.ts
```

## License

MIT

---
name: verify-then-sync parallel push
description: "Rebase onto remote when a sibling background agent already pushed to the same branch during a verify-then-sync session."
---

# Verify-then-sync: parallel session already pushed

## Trigger
You run `git push origin main` (or any shared branch) during a verify-then-sync
session and get:

```
 ! [rejected]        main -> main (fetch first)
error: failed to push some refs to '...'
hint: Updates were rejected because the remote contains work that you do
hint: not have locally.
```

A parallel actor — a `delegate_task` background run, a prior session, or another
agent on the same machine — already pushed commits to that branch.

## Rules
1. **Never force-push.** `git push --force` clobbers the parallel agent's work.
2. **Fetch, then inspect before merging.** A blind `git pull` can silently drop
   your unique contributions or produce a messy merge.
3. **Rebase your commits onto the remote, keeping only what is uniquely yours.**

## Recipe
```bash
# 1. See what the remote has that you don't
git fetch origin
git log --oneline HEAD..origin/main          # their commits
git diff --stat HEAD origin/main             # file-level divergence

# 2. Rebase your local commit(s) onto origin/main
git rebase origin/main
#   - For every file the parallel agent already fixed, take THEIR version:
#       git checkout --ours <file> && git add <file>
#     (in a rebase, --ours = the side being rebased onto = the remote/their work)
#   - For files needing BOTH changes (e.g. a vitest resolve.alias block),
#     open the file and manually merge, keeping both edits.
#   - Keep ONLY your unique contributions (a CI stub the remote deleted,
#     plan/blueprint docs, a config the remote dropped).
#   - If a stub file / doc came from your commit, `git add` it.
#   - Resolve all conflict markers, then:
GIT_EDITOR=true git rebase --continue

# 3. Verify gates are still green on the rebased tree
npx eslint . --max-warnings=0
npx vitest run

# 4. Push (now a fast-forward)
git push origin main
```

## Real case (2026-08-11, WorkFORCE repo)
A background `delegate_task` run (`bg_083426_9fc858`) had pushed 2 commits to
`origin/main` (Providers architecture + full CI repair) while this session held
an unpushed commit with duplicate source fixes + a unique CI test stub + corrected
plan docs. Resolution: rebased onto `origin/main`, took the remote's versions for
all duplicated source files (`eslint.config.mjs`, `next.config.mjs`, `package.json`,
`layout.tsx`, `LogForm*`, `tsconfig.json`, `vitest.setup.tsx`, `package-lock.json`),
manually merged `vitest.config.ts` to keep BOTH the remote's `@/convex` alias AND
the `@/convex/_generated/react` stub alias (tests need the stub), and kept the
plan/blueprint docs + stub file. Pushed clean; lint + test green.

## Pitfalls (quarantine, don't commit)
- A stray file a parallel agent created at repo root (e.g. a duplicate
  `convex.config.ts`) may be an ORPHAN. Quarantine it
  (`mkdir -p .scratch-orphans && mv <file> .scratch-orphans/<file>.disabled`), do
  not commit it; confirm the real one lives elsewhere (`convex/convex.config.ts`).
- Agent scaffolding (`.agents/`, `.claude/`, `AGENTS.md`, `CLAUDE.md`) and
  `convex/_generated/` are write-protected / gitignored — never stage them.
  `git stash push -u` them out of the way before a rebase that refuses on unstaged
  changes, then `git stash pop` after.

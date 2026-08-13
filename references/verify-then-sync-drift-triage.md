# Verify-then-Sync Drift Triage

When `git status` shows modified files but there is no feature plan (verify-then-sync
mode), classify each drift cluster BEFORE committing. The goal is to revert
regenerable churn and commit only coherent, intended source.

## Classification table

| Signal | Classification | Action |
|--------|---------------|--------|
| `package-lock.json` shows only deletions (`@swc/*` removals, `dev:` flags flipping) | Spurious npm version rewrites — NOT a real dep change | `git checkout -- package-lock.json` |
| `_generated/*.d.ts` references a module not present in HEAD's version | `convex codegen` echoed a stray untracked source file | Revert generated file to HEAD; quarantine the stray source |
| `.agents/skills/*`, `skills-lock.json`, `ai-files.state.json` modified | Output of `npx convex ai-files install` | `git checkout` the tracked ones; leave untracked `.agents/` alone (regenerable) |
| Real component / app route / convex function source diffs | Actual work | Commit scoped source only (exclude `AGENTS.md`/`CLAUDE.md`/`.agents/`/`.claude/`) |

## The incoherent-generated-state trap

A regenerated `_generated/api.d.ts` that imports `../lib/<x>.js` while
`convex/lib/<x>.ts` is **untracked** is NOT a real change — it is codegen echoing
a stray file on disk. Committing the regenerated file without the source breaks
the next `convex dev` (module not found at deploy). Verify with:

```bash
# Does HEAD's generated file already reference the module?
git show HEAD:convex/_generated/api.d.ts | grep -c "lib/<x>"
# 0  => HEAD is coherent and does NOT reference it  => the diff is codegen-from-stray
# >0 => real, intended change
```

If HEAD does NOT reference it:
```bash
git checkout -- convex/_generated/api.d.ts        # restore coherent state
mkdir -p .scratch-orphans
mv convex/lib/<x>.ts .scratch-orphans/<x>.ts.disabled   # quarantine, do not delete
```

Never commit the orphan, never silently delete it — the user may have intended
it on another branch (check `git log --all --oneline -- <path>`; if the file was
committed on a non-ancestor branch, it is orphaned in this one).

## Final coherence gate

After reconciliation:
```bash
git status --short | grep -vE "^\?\? \.agents/"   # expect empty (or only untracked .agents/)
git rev-list --left-right --count origin/<branch>...HEAD   # expect "0 0"
```
Only push when both are clean. If `main` already reads `0 0`, there is nothing to
push — the session's only job was local drift cleanup.

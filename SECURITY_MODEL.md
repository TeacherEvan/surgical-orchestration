# Security Model

## Scope boundary

`assertScopeBoundary(target, scope, agentId)` is the enforcement primitive for host-side file operations.

The important invariant is:

> A path is allowed only when its fully resolved physical path is equal to the scope or is a descendant of the scope.

Resolution must account for symlinks even when the target itself does not exist yet. `resolveRealPath()` therefore resolves the nearest existing ancestor and appends the not-yet-existing suffix.

## Host responsibility

The orchestration library cannot intercept arbitrary filesystem operations performed by an external agent runtime. The host/tool layer must call the boundary check **before every read, write, rename, delete, copy, or equivalent filesystem operation**.

The orchestration engine's `allowedFolderScope` is metadata and dispatch context; it is not by itself a filesystem sandbox.

## Timeout responsibility

The manager supplies an `AbortSignal` and aborts it at the orchestration deadline. The actual Hermes/child-process/tool adapter must honor that signal and terminate the underlying work.

A JavaScript `Promise.race()` cannot kill a running process. Treating it as process termination is unsafe and misleading.

## Fail-closed result handling

Only `COMPLETED` or `FAILED` result statuses are accepted. Malformed results are rejected rather than implicitly promoted.

A `FAILED` worker is never sent directly to the verifier as successful work. Its attempt consumes the revision budget.

## Threats still requiring host-level controls

- malicious or compromised agent tools
- shell command injection through trusted configuration fields
- Windows junction/reparse-point edge cases
- TOCTOU races between checking a path and opening it
- privileged filesystem access outside the host's process sandbox

For high-assurance deployments, combine these checks with OS/container sandboxing and least-privilege credentials.

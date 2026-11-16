import * as fs from 'node:fs';
import * as path from 'node:path';

function assertValidPathInput(value: unknown, label: string, agentId: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) {
    throw new Error(
      `[SCOPE_INVALID] [SECURITY_VIOLATION] Subagent '${agentId}' provided invalid ${label}.`,
    );
  }
}

function assertNoSymlinkSegments(baseDir: string, relativePath: string, agentId: string): void {
  if (!relativePath || relativePath === '.' || relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    return;
  }
  let current = baseDir;
  for (const segment of relativePath.split(path.sep)) {
    if (!segment || segment === '.') continue;
    current = path.join(current, segment);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new Error(
          `[SCOPE_INVALID] [SECURITY_VIOLATION] Subagent '${agentId}' attempted access through symlink component '${current}'.`,
        );
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT') {
        break;
      }
      if (err instanceof Error && err.message.includes('[SCOPE_INVALID]')) {
        throw err;
      }
      throw new Error(
        `[SCOPE_INVALID] [SECURITY_VIOLATION] Subagent '${agentId}' failed symlink inspection at '${current}': ${(err as Error).message}`,
      );
    }
  }
}

/**
 * Resolves the canonical physical path, walking up existing ancestors with
 * lstatSync + realpathSync so multi-level non-existent paths under symlinks
 * resolve cleanly and dangling symlinks fail closed.
 */
export function resolveRealPath(targetPath: string): string {
  assertValidPathInput(targetPath, 'targetPath', 'unknown');
  const absPath = path.resolve(targetPath);
  let cursor = absPath;
  const suffix: string[] = [];

  while (true) {
    try {
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink()) {
        let resolved: string;
        try {
          resolved = fs.realpathSync(cursor);
        } catch {
          throw new Error(
            `[SCOPE_INVALID] [SECURITY_VIOLATION] Dangling or unresolvable symlink detected: '${cursor}'.`,
          );
        }
        if (suffix.length > 0 && !fs.statSync(resolved).isDirectory()) {
          throw new Error(
            `[SCOPE_INVALID] [SECURITY_VIOLATION] Non-directory ancestor '${cursor}' for path '${targetPath}'.`,
          );
        }
        return suffix.length > 0 ? path.join(resolved, ...suffix.reverse()) : resolved;
      }

      if (suffix.length > 0 && !stat.isDirectory()) {
        throw new Error(
          `[SCOPE_INVALID] [SECURITY_VIOLATION] Non-directory ancestor '${cursor}' for path '${targetPath}'.`,
        );
      }

      const realCursor = fs.realpathSync(cursor);
      return suffix.length > 0 ? path.join(realCursor, ...suffix.reverse()) : realCursor;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT') {
        const parent = path.dirname(cursor);
        if (parent === cursor) {
          return absPath;
        }
        suffix.push(path.basename(cursor));
        cursor = parent;
        continue;
      }
      if (err instanceof Error && err.message.includes('[SCOPE_INVALID]')) {
        throw err;
      }
      throw new Error(
        `[SCOPE_INVALID] [SECURITY_VIOLATION] Failed to resolve path '${cursor}': ${(err as Error).message}`,
      );
    }
  }
}

/**
 * Validates that targetPath resolves strictly inside allowedScope with zero
 * symlink components, dangling symlinks, null bytes, or empty scope strings.
 * Returns the canonical resolved path for downstream safe file operations.
 */
export function resolveScopedPath(targetPath: string, allowedScope: string, agentId: string): string {
  const safeAgent = typeof agentId === 'string' && agentId.trim() !== '' ? agentId : 'unknown';
  assertValidPathInput(targetPath, 'targetPath', safeAgent);
  assertValidPathInput(allowedScope, 'allowedFolderScope', safeAgent);

  const rawScope = path.resolve(allowedScope);
  const rawTarget = path.resolve(targetPath);

  for (const leaf of [rawScope, rawTarget]) {
    try {
      if (fs.lstatSync(leaf).isSymbolicLink()) {
        throw new Error(
          `[SCOPE_INVALID] [SECURITY_VIOLATION] Subagent '${safeAgent}' cannot target symlink '${leaf}'.`,
        );
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'ENOENT') {
        if (err instanceof Error && err.message.includes('[SCOPE_INVALID]')) {
          throw err;
        }
        throw new Error(
          `[SCOPE_INVALID] [SECURITY_VIOLATION] Subagent '${safeAgent}' failed path check at '${leaf}': ${(err as Error).message}`,
        );
      }
    }
  }

  const absScope = resolveRealPath(allowedScope);
  const absTarget = resolveRealPath(targetPath);

  const relative = path.relative(absScope, absTarget);
  const isOutside =
    relative !== '' &&
    (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative));

  if (isOutside) {
    throw new Error(
      `[SCOPE_INVALID] [SECURITY_VIOLATION] Subagent '${safeAgent}' attempted unauthorized path access: '${targetPath}' (resolved: '${absTarget}'). Locked Scope: '${absScope}'`,
    );
  }

  // Reject any symlink component inside the raw or canonical scope subtree.
  assertNoSymlinkSegments(rawScope, path.relative(rawScope, rawTarget), safeAgent);
  assertNoSymlinkSegments(absScope, relative, safeAgent);

  return absTarget;
}

/**
 * Asserts that targetPath resides strictly inside allowedScope.
 * Throws [SCOPE_INVALID] [SECURITY_VIOLATION] if the boundary is breached.
 */
export function assertScopeBoundary(targetPath: string, allowedScope: string, agentId: string): void {
  resolveScopedPath(targetPath, allowedScope, agentId);
}

/**
 * Opens a scoped file with O_NOFOLLOW to defeat leaf symlink TOCTOU races.
 * Caller owns closing the returned file descriptor.
 */
export function openScopedFile(
  targetPath: string,
  allowedScope: string,
  agentId: string,
  flags: number = fs.constants.O_RDONLY,
  mode: number = 0o600,
): number {
  const safeAgent = typeof agentId === 'string' && agentId.trim() !== '' ? agentId : 'unknown';
  const verifiedPath = resolveScopedPath(targetPath, allowedScope, safeAgent);
  const noFollowFlag = fs.constants.O_NOFOLLOW ?? 0;

  let fd: number;
  try {
    fd = fs.openSync(verifiedPath, flags | noFollowFlag, mode);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ELOOP') {
      throw new Error(
        `[SCOPE_INVALID] [SECURITY_VIOLATION] Subagent '${safeAgent}' blocked by O_NOFOLLOW at '${verifiedPath}'.`,
      );
    }
    throw err;
  }

  try {
    const fdStat = fs.fstatSync(fd);
    if (fdStat.isSymbolicLink()) {
      throw new Error(
        `[SCOPE_INVALID] [SECURITY_VIOLATION] Subagent '${safeAgent}' opened symlink fd at '${verifiedPath}'.`,
      );
    }
    return fd;
  } catch (err) {
    fs.closeSync(fd);
    throw err;
  }
}

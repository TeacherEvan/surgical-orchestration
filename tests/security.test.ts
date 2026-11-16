import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  assertScopeBoundary,
  openScopedFile,
  resolveRealPath,
  resolveScopedPath,
} from '../references/security.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-surgery-security-'));
try {
  const scope = path.join(tmp, 'scope');
  const siblingEvil = path.join(tmp, 'scope-evil');
  const outside = path.join(tmp, 'outside');
  const nestedReal = path.join(scope, 'nested');

  fs.mkdirSync(scope);
  fs.mkdirSync(nestedReal);
  fs.mkdirSync(siblingEvil);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(nestedReal, 'ok.txt'), 'safe-content', 'utf-8');
  fs.writeFileSync(path.join(scope, '..foo.txt'), 'dotdot-prefix-file', 'utf-8');
  fs.writeFileSync(path.join(siblingEvil, 'secret.txt'), 'sibling-secret', 'utf-8');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside-secret', 'utf-8');

  // Symlinks: external, dangling, and internal
  fs.symlinkSync(outside, path.join(scope, 'escape'), 'dir');
  fs.symlinkSync(path.join(outside, 'missing-target.txt'), path.join(scope, 'dangling'), 'file');
  fs.symlinkSync(nestedReal, path.join(scope, 'inner-link'), 'dir');
  fs.symlinkSync(path.join(nestedReal, 'ok.txt'), path.join(scope, 'leaf-link.txt'), 'file');

  // Valid resolution & in-scope paths
  const realScope = resolveRealPath(scope);
  assert.equal(resolveRealPath(path.join(scope, 'new-file.txt')).startsWith(realScope), true);
  assert.doesNotThrow(() =>
    assertScopeBoundary(path.join(scope, 'nested', 'future.txt'), scope, 'test-agent'),
  );
  assert.doesNotThrow(() =>
    assertScopeBoundary(path.join(scope, '..foo.txt'), scope, 'test-agent'),
  );
  assert.equal(
    resolveScopedPath(path.join(nestedReal, 'ok.txt'), scope, 'test-agent'),
    path.join(realScope, 'nested', 'ok.txt'),
  );

  // Legacy symlink escape check
  assert.throws(
    () => assertScopeBoundary(path.join(scope, 'escape', 'future.txt'), scope, 'test-agent'),
    /\[SCOPE_INVALID\]/,
  );

  // BYPASS_1: multi-level non-existent descendants under symlink
  assert.throws(
    () =>
      assertScopeBoundary(
        path.join(scope, 'escape', 'nonexistent-sub', 'pwn.txt'),
        scope,
        'BYPASS_1_multilevel_symlink',
      ),
    /\[SCOPE_INVALID\]/,
  );

  // BYPASS_2: dangling symlink (both leaf and nested child)
  assert.throws(
    () => assertScopeBoundary(path.join(scope, 'dangling'), scope, 'BYPASS_2_dangling_symlink'),
    /\[SCOPE_INVALID\]/,
  );
  assert.throws(
    () =>
      assertScopeBoundary(
        path.join(scope, 'dangling', 'child.txt'),
        scope,
        'BYPASS_2_dangling_symlink',
      ),
    /\[SCOPE_INVALID\]/,
  );

  // BYPASS_3: null-byte injection in targetPath or allowedScope
  assert.throws(
    () =>
      assertScopeBoundary(
        `${path.join(scope, 'ok.txt')}\0../../etc/passwd`,
        scope,
        'BYPASS_3_null_byte',
      ),
    /\[SCOPE_INVALID\]/,
  );
  assert.throws(
    () => assertScopeBoundary(path.join(scope, 'ok.txt'), `${scope}\0/evil`, 'BYPASS_3_null_byte'),
    /\[SCOPE_INVALID\]/,
  );

  // BYPASS_4: empty or whitespace-only targetPath / allowedScope
  assert.throws(() => assertScopeBoundary('', '', 'BYPASS_4_empty_strings'), /\[SCOPE_INVALID\]/);
  assert.throws(
    () => assertScopeBoundary(path.join(scope, 'ok.txt'), '', 'BYPASS_4_empty_strings'),
    /\[SCOPE_INVALID\]/,
  );
  assert.throws(
    () => assertScopeBoundary('   ', scope, 'BYPASS_4_empty_strings'),
    /\[SCOPE_INVALID\]/,
  );

  // Sibling-prefix escape (/tmp/.../scope-evil vs /tmp/.../scope)
  assert.throws(
    () => assertScopeBoundary(path.join(siblingEvil, 'secret.txt'), scope, 'sibling-probe'),
    /\[SCOPE_INVALID\]/,
  );
  assert.throws(
    () => assertScopeBoundary(path.join(tmp, 'outside.txt'), scope, 'outside-probe'),
    /\[SCOPE_INVALID\]/,
  );

  // Internal symlink component rejection
  assert.throws(
    () => assertScopeBoundary(path.join(scope, 'inner-link', 'ok.txt'), scope, 'symlink-probe'),
    /\[SCOPE_INVALID\]/,
  );
  assert.throws(
    () => assertScopeBoundary(path.join(scope, 'leaf-link.txt'), scope, 'symlink-leaf-probe'),
    /\[SCOPE_INVALID\]/,
  );

  // O_NOFOLLOW safe open helper
  const fd = openScopedFile(path.join(nestedReal, 'ok.txt'), scope, 'open-probe');
  try {
    const content = fs.readFileSync(fd, 'utf-8');
    assert.equal(content, 'safe-content');
  } finally {
    fs.closeSync(fd);
  }
  assert.throws(
    () => openScopedFile(path.join(scope, 'leaf-link.txt'), scope, 'open-symlink-probe'),
    /\[SCOPE_INVALID\]/,
  );
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('ALL SECURITY ASSERTIONS PASSED');

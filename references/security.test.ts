import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  assertScopeBoundary,
  resolveRealPath,
} from './security.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-surgery-security-'));
const scope = path.join(tmp, 'scope');
const outside = path.join(tmp, 'outside');
fs.mkdirSync(scope);
fs.mkdirSync(outside);
fs.symlinkSync(outside, path.join(scope, 'escape'), 'dir');

assert.equal(resolveRealPath(path.join(scope, 'new-file.txt')).startsWith(scope), true);

assert.doesNotThrow(() =>
  assertScopeBoundary(path.join(scope, 'nested', 'future.txt'), scope, 'test-agent'),
);

assert.throws(
  () => assertScopeBoundary(path.join(scope, 'escape', 'future.txt'), scope, 'test-agent'),
  /SECURITY_VIOLATION/,
);

assert.throws(
  () => assertScopeBoundary(path.join(tmp, 'outside.txt'), scope, 'test-agent'),
  /SECURITY_VIOLATION/,
);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('ALL SECURITY ASSERTIONS PASSED');

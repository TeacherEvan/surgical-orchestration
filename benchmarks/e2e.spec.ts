// e2e.spec.ts (Task 5 — Playwright E2E).
// Drives the real CLI as a subprocess (the Playwright-recommended path for CLI
// automation) and asserts the review pipeline emits classification + Composer 2+2.
// Run with: npx playwright test bench/e2e.spec.ts  (global @playwright/test 1.62.1)
import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BENCH_DIR = dirname(fileURLToPath(import.meta.url));
const REF = resolve(BENCH_DIR, '..');
const FIXTURE = resolve(BENCH_DIR, 'fixtures/mixed.plan.json');
const CLI = resolve(REF, 'references/surgical-orchestration.ts');
const LOCAL_TSX = resolve(REF, 'node_modules/.bin/tsx');

test('surgical-orchestration --review classifies and composer emits 2+2', () => {
  const cmd = existsSync(LOCAL_TSX) ? LOCAL_TSX : 'tsx';
  const res = spawnSync(cmd, [CLI, '--review', FIXTURE], {
    cwd: REF,
    encoding: 'utf-8',
    timeout: 120_000,
  });
  const out = (res.stdout ?? '') + (res.stderr ?? '');
  expect(res.status, `cli exited non-zero\n${out.slice(0, 800)}`).toBe(0);
  expect(out).toContain('[CODE-REVIEWER] File classification');
  expect(out).toContain('FRONTEND');
  expect(out).toContain('BACKEND');
  expect(out).toContain('[COMPOSER] Selected recommendations (2)');
  expect(out).toContain('[COMPOSER] Selected suggestions (2)');
});

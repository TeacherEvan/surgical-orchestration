// e2e.spec.ts (Task 5 — Playwright E2E).
// Drives the real CLI as a subprocess (the Playwright-recommended path for CLI
// automation) and asserts the review pipeline emits classification + Composer 2+2.
// Run with: npx playwright test bench/e2e.spec.ts  (global @playwright/test 1.62.1)
import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const FIXTURE = resolve(__dirname, 'fixtures/mixed.plan.json');
const CLI = resolve(__dirname, '..', 'surgical-orchestration.ts');
const REF = resolve(__dirname, '..');

test('surgical-orchestration --review classifies and composer emits 2+2', () => {
  const res = spawnSync('npx', ['tsx', CLI, '--review', FIXTURE], {
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

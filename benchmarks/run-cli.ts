// run-cli.ts (Task 3, Playwright-skill substitution).
// The Playwright subprocess spawn hung the prior subagent; per the skill's own
// "use the real tool, fall back gracefully" rule we drive the CLI with
// child_process (the documented Playwright-equivalent for CLI automation) and
// assert on stdout — no browser, no hanging test runner.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BENCH_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(BENCH_DIR, '..');
const FIXTURE = resolve(BENCH_DIR, 'fixtures/mixed.plan.json');
const CLI = resolve(REPO_ROOT, 'references/surgical-orchestration.ts');
const LOCAL_TSX = resolve(REPO_ROOT, 'node_modules/.bin/tsx');

function run(): Promise<{ code: number; out: string; ms: number }> {
  return new Promise((resolvePromise) => {
    const t0 = Date.now();
    const cmd = existsSync(LOCAL_TSX) ? LOCAL_TSX : 'tsx';
    const child = spawn(cmd, [CLI, '--review', FIXTURE], { cwd: REPO_ROOT });
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (out += d.toString()));
    child.on('close', (code) => resolvePromise({ code: code ?? -1, out, ms: Date.now() - t0 }));
  });
}

async function main(): Promise<void> {
  const { code, out, ms } = await run();
  console.log(`[run-cli] exit=${code} wall=${ms}ms`);
  const hasClassify = out.includes('[CODE-REVIEWER] File classification');
  const hasComposer = out.includes('[COMPOSER] Selected recommendations (2)');
  const hasSugg = out.includes('[COMPOSER] Selected suggestions (2)');
  console.log(`[run-cli] classification=${hasClassify} composerRecs=${hasComposer} composerSuggs=${hasSugg}`);
  if (code !== 0 || !hasClassify || !hasComposer || !hasSugg) {
    console.error('[run-cli] FAILED');
    console.error(out.slice(0, 800));
    process.exit(1);
  }
  console.log('[run-cli] PASSED — real CLI review path verified via stdout');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// run-cli.ts (Task 3, Playwright-skill substitution).
// The Playwright subprocess spawn hung the prior subagent; per the skill's own
// "use the real tool, fall back gracefully" rule we drive the CLI with
// child_process (the documented Playwright-equivalent for CLI automation) and
// assert on stdout — no browser, no hanging test runner.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const FIXTURE = resolve(__dirname, 'fixtures/mixed.plan.json');
const CLI = resolve(__dirname, '../surgical-orchestration.ts');

function run(): Promise<{ code: number; out: string; ms: number }> {
  return new Promise((resolvePromise) => {
    const t0 = Date.now();
    const child = spawn('npx', ['tsx', CLI, '--review', FIXTURE], { cwd: resolve(__dirname, '..') });
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

// report.ts (Task 5 — reporter).
// Runs the engine + Code Reviewer directly with an accurate fake dispatcher across
// a baseline and a swept parameter, writes results/<stamp>.json, and prints the
// comparison table. A setting "produced a different result" iff its row differs
// from baseline on wall_ms / ledger_tokens / accuracy.
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { OrchestrationEngine, ContextCompactor, StandardCodeReviewer, ORCHESTRATOR_CONFIG, type BuildPlan, type SubagentDispatcher, type SubagentResult } from '../orchestrator.js';
import { Composer } from '../surgical-orchestration.js';
import { readFileSync } from 'node:fs';

const FIXTURE = resolve(__dirname, 'fixtures/mixed.plan.json');
const plan = JSON.parse(readFileSync(FIXTURE, 'utf-8')) as BuildPlan;

function accurateDispatcher(): SubagentDispatcher {
  return async (_id, payload) => ({
    status: 'COMPLETED',
    filesModified: [],
    debrief: `did ${payload.missionId}`,
    selfAudit: 'ok',
    recommendations: ['rec A', 'rec B', 'rec C'],
    suggestions: ['sug A', 'sug B', 'sug C'],
  } as SubagentResult);
}

async function measure(label: string, conc: number) {
  const saved = ORCHESTRATOR_CONFIG.MAX_CONCURRENCY;
  (ORCHESTRATOR_CONFIG as { MAX_CONCURRENCY: number }).MAX_CONCURRENCY = conc;
  const t0 = Date.now();
  const engine = new OrchestrationEngine(plan, accurateDispatcher(), { skipTests: true });
  const result = await engine.run();
  const reviewer = new StandardCodeReviewer(plan, accurateDispatcher());
  const outcome = await reviewer.run();
  const composer = new Composer();
  const final = composer.compose(outcome, plan);
  const wall = Date.now() - t0;
  const ledger = ContextCompactor.compact(result.jobCard);
  const ledgerTokens = Math.ceil(JSON.stringify(ledger).length / 4);
  const accuracy = final.recommendations.length === 2 && final.suggestions.length === 2 ? 100 : 0;
  (ORCHESTRATOR_CONFIG as { MAX_CONCURRENCY: number }).MAX_CONCURRENCY = saved;
  return { setting: label, wall_ms: wall, ledger_tokens: ledgerTokens, accuracy_pct: accuracy };
}

async function main() {
  const rows: Array<{ setting: string; wall_ms: number; ledger_tokens: number; accuracy_pct: number }> = [];
  rows.push(await measure('MAX_CONCURRENCY=1 (baseline)', 1));
  rows.push(await measure('MAX_CONCURRENCY=2 (engine max)', 2));

  const outDir = resolve(__dirname, 'results');
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeFileSync(resolve(outDir, `${stamp}.json`), JSON.stringify(rows, null, 2));

  console.log('\n=== Parameter-Sweep Comparison ===');
  console.log('SETTING'.padEnd(34), 'WALL_MS'.padStart(9), 'LEDGER_TOK'.padStart(12), 'ACCURACY'.padStart(9));
  for (const r of rows) {
    console.log(r.setting.padEnd(34), String(r.wall_ms).padStart(9), String(r.ledger_tokens).padStart(12), `${r.accuracy_pct}%`.padStart(9));
  }
  const diff = rows.slice(1).some((r) => r.wall_ms !== rows[0].wall_ms || r.ledger_tokens !== rows[0].ledger_tokens || r.accuracy_pct !== rows[0].accuracy_pct);
  console.log(diff ? '\nDIFFERENT RESULTS OBSERVED across settings ✓' : '\nWARN: no setting changed results');
  if (!diff) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// report.ts (Task 5 — reporter).
// Sweeps all four ORCHESTRATOR_CONFIG knobs (MAX_CONCURRENCY, MAX_REVISION_CYCLES,
// SUBAGENT_TIMEOUT_MS, COMPACTION_TOKEN_THRESHOLD) one at a time (ceteris paribus),
// writes results/<stamp>.json, and prints the comparison table. A setting
// "produced a different result" iff its row differs from the baseline on
// wall_ms / ledger_tokens / accuracy_pct.
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

type Row = { setting: string; wall_ms: number; ledger_tokens: number; accuracy_pct: number };

async function measure(label: string, override: Partial<typeof ORCHESTRATOR_CONFIG>): Promise<Row> {
  const saved = { ...ORCHESTRATOR_CONFIG };
  Object.assign(ORCHESTRATOR_CONFIG, override);
  try {
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
    return { setting: label, wall_ms: wall, ledger_tokens: ledgerTokens, accuracy_pct: accuracy };
  } finally {
    Object.assign(ORCHESTRATOR_CONFIG, saved);
  }
}

async function main() {
  const baseline = await measure('baseline (defaults)', {});

  const rows: Row[] = [baseline];
  rows.push(await measure('MAX_CONCURRENCY=1',          { MAX_CONCURRENCY: 1 as unknown as 2 }));
  rows.push(await measure('MAX_CONCURRENCY=2 (engine cap)', { MAX_CONCURRENCY: 2 as unknown as 2 }));
  rows.push(await measure('MAX_CONCURRENCY=4 (capped)', { MAX_CONCURRENCY: 4 as unknown as 2 }));
  rows.push(await measure('MAX_REVISION_CYCLES=1',      { MAX_REVISION_CYCLES: 1 as unknown as 3 }));
  rows.push(await measure('MAX_REVISION_CYCLES=3 (default)', { MAX_REVISION_CYCLES: 3 as unknown as 3 }));
  rows.push(await measure('MAX_REVISION_CYCLES=5',      { MAX_REVISION_CYCLES: 5 as unknown as 3 }));
  rows.push(await measure('SUBAGENT_TIMEOUT_MS=200',    { SUBAGENT_TIMEOUT_MS: 200 as unknown as 180000 }));
  rows.push(await measure('SUBAGENT_TIMEOUT_MS=2000',   { SUBAGENT_TIMEOUT_MS: 2000 as unknown as 180000 }));
  rows.push(await measure('SUBAGENT_TIMEOUT_MS=180000', { SUBAGENT_TIMEOUT_MS: 180000 as unknown as 180000 }));
  rows.push(await measure('COMPACTION_THRESHOLD=0.25',  { COMPACTION_TOKEN_THRESHOLD: 0.25 as unknown as 0.75 }));
  rows.push(await measure('COMPACTION_THRESHOLD=0.50',  { COMPACTION_TOKEN_THRESHOLD: 0.5 as unknown as 0.75 }));
  rows.push(await measure('COMPACTION_THRESHOLD=0.75 (default)', { COMPACTION_TOKEN_THRESHOLD: 0.75 as unknown as 0.75 }));
  rows.push(await measure('COMPACTION_THRESHOLD=1.00',  { COMPACTION_TOKEN_THRESHOLD: 1 as unknown as 0.75 }));

  const outDir = resolve(__dirname, 'results');
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeFileSync(resolve(outDir, `${stamp}.json`), JSON.stringify(rows, null, 2));

  console.log('\n=== Parameter-Sweep Comparison ===');
  console.log('SETTING'.padEnd(34), 'WALL_MS'.padStart(9), 'LEDGER_TOK'.padStart(12), 'ACCURACY'.padStart(9));
  for (const r of rows) {
    console.log(r.setting.padEnd(34), String(r.wall_ms).padStart(9), String(r.ledger_tokens).padStart(12), `${r.accuracy_pct}%`.padStart(9));
  }

  const seen = new Set<string>();
  let differing = 0;
  for (const r of rows) {
    const k = `${r.wall_ms}|${r.ledger_tokens}|${r.accuracy_pct}`;
    if (!seen.has(k)) { seen.add(k); differing++; }
  }
  console.log(`\n${differing} distinct result-patterns across ${rows.length} settings`);
  console.log(differing > 1 ? 'DIFFERENT RESULTS OBSERVED across settings ✓' : 'WARN: no setting changed results');
  if (differing <= 1) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

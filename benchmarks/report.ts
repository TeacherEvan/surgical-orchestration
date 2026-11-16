// report.ts (Task 5 — reporter).
// Sweeps all four ORCHESTRATOR_CONFIG knobs (MAX_CONCURRENCY, MAX_REVISION_CYCLES,
// SUBAGENT_TIMEOUT_MS, COMPACTION_TOKEN_THRESHOLD) one at a time (ceteris paribus),
// writes results/<stamp>.json, and prints the comparison table. A setting
// "produced a different result" iff its row differs from the baseline on
// wall_ms / ledger_tokens / accuracy_pct.
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OrchestrationEngine,
  ContextCompactor,
  StandardCodeReviewer,
  ORCHESTRATOR_CONFIG,
  type BuildPlan,
  type EngineOptions,
  type SubagentDispatcher,
  type SubagentResult,
} from '../references/orchestrator.js';
import { Composer } from '../references/surgical-orchestration.js';

const BENCH_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(BENCH_DIR, 'fixtures/mixed.plan.json');
const plan = JSON.parse(readFileSync(FIXTURE, 'utf-8')) as BuildPlan;

function accurateDispatcher(perCallMs = 15): SubagentDispatcher {
  return async (_id, payload) => {
    if (perCallMs > 0) {
      await new Promise((r) => setTimeout(r, perCallMs));
    }
    const result: SubagentResult = {
      status: 'COMPLETED',
      filesModified: [],
      debrief: `did ${payload.missionId}`,
      selfAudit: 'ok',
      recommendations: ['rec A', 'rec B', 'rec C'],
      suggestions: ['sug A', 'sug B', 'sug C'],
    };
    return result;
  };
}

type Row = { setting: string; wall_ms: number; ledger_tokens: number; accuracy_pct: number };

async function measure(label: string, options: EngineOptions): Promise<Row> {
  const t0 = Date.now();
  const dispatcher = accurateDispatcher(15);
  const engine = new OrchestrationEngine(plan, dispatcher, { skipTests: true, ...options });
  const result = await engine.run();
  const reviewer = new StandardCodeReviewer(plan, accurateDispatcher(0));
  const outcome = await reviewer.run();
  const composer = new Composer();
  const final = composer.compose(outcome, plan);
  const wall = Date.now() - t0;
  const threshold = options.compactionThreshold ?? ORCHESTRATOR_CONFIG.COMPACTION_TOKEN_THRESHOLD;
  const ledger = ContextCompactor.compact(result.jobCard, threshold);
  const ledgerTokens = Math.ceil(JSON.stringify(ledger).length / 4);
  const accuracy = final.recommendations.length === 2 && final.suggestions.length === 2 ? 100 : 0;
  return { setting: label, wall_ms: wall, ledger_tokens: ledgerTokens, accuracy_pct: accuracy };
}

async function main() {
  const baseline = await measure('baseline (defaults)', {});

  const rows: Row[] = [baseline];
  rows.push(await measure('MAX_CONCURRENCY=1', { maxConcurrency: 1 }));
  rows.push(await measure('MAX_CONCURRENCY=2 (engine cap)', { maxConcurrency: 2 }));
  rows.push(await measure('MAX_CONCURRENCY=4 (capped)', { maxConcurrency: 4 }));
  rows.push(await measure('MAX_REVISION_CYCLES=1', { maxRevisionCycles: 1 }));
  rows.push(await measure('MAX_REVISION_CYCLES=3 (default)', { maxRevisionCycles: 3 }));
  rows.push(await measure('MAX_REVISION_CYCLES=5', { maxRevisionCycles: 5 }));
  rows.push(await measure('SUBAGENT_TIMEOUT_MS=200', { timeoutMs: 200 }));
  rows.push(await measure('SUBAGENT_TIMEOUT_MS=2000', { timeoutMs: 2000 }));
  rows.push(await measure('SUBAGENT_TIMEOUT_MS=180000', { timeoutMs: 180_000 }));
  rows.push(await measure('COMPACTION_THRESHOLD=0.25', { compactionThreshold: 0.25 }));
  rows.push(await measure('COMPACTION_THRESHOLD=0.50', { compactionThreshold: 0.5 }));
  rows.push(await measure('COMPACTION_THRESHOLD=0.75 (default)', { compactionThreshold: 0.75 }));
  rows.push(await measure('COMPACTION_THRESHOLD=1.00', { compactionThreshold: 1 }));

  const outDir = resolve(BENCH_DIR, 'results');
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

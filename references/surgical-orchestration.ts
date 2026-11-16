#!/usr/bin/env node
/**
 * Surgical Orchestration CLI Entry Point
 *
 * Usage:
 *   npx tsx references/surgical-orchestration.ts <build-plan.json>
 *   npx tsx references/surgical-orchestration.ts --dry-run <build-plan.json>
 *   npx tsx references/surgical-orchestration.ts --review <build-plan.json>
 *   npx tsx references/surgical-orchestration.ts --init
 */

import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dryRunDispatcher, hermesDispatcher, parseSubagentResult } from './hermes-adapter.js';
import {
  Composer,
  ORCHESTRATOR_CONFIG,
  OrchestrationEngine,
  StandardCodeReviewer,
  type BuildPlan,
  type CodeReviewOutcome,
  type SubagentDispatcher,
} from './orchestrator.js';

export { Composer, dryRunDispatcher, hermesDispatcher, parseSubagentResult };

const SAMPLE_PLAN: BuildPlan = {
  description: 'Sample build plan for Surgical Orchestration',
  changes: [
    {
      filePath: 'src/components/auth/LoginForm.tsx',
      description: 'Add session refresh logic',
      type: 'modify',
    },
    {
      filePath: 'src/components/auth/RegisterForm.tsx',
      description: 'Add input strength meter',
      type: 'modify',
    },
    {
      filePath: 'src/services/payment/StripeClient.ts',
      description: 'Implement webhook signature verification',
      type: 'add',
    },
    {
      filePath: 'src/services/payment/PaymentProcessor.ts',
      description: 'Add idempotency key support',
      type: 'modify',
    },
  ],
};

function isValidBuildPlan(candidate: unknown): candidate is BuildPlan {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
  const obj = candidate as Record<string, unknown>;
  if (typeof obj.description !== 'string' || obj.description.trim() === '') return false;
  if (!Array.isArray(obj.changes) || obj.changes.length === 0) return false;
  return obj.changes.every((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const change = item as Record<string, unknown>;
    return (
      typeof change.filePath === 'string' &&
      change.filePath.trim() !== '' &&
      typeof change.description === 'string' &&
      change.description.trim() !== '' &&
      (change.type === 'add' || change.type === 'modify' || change.type === 'delete')
    );
  });
}

function printHelp(): void {
  console.log('Surgical Orchestration Engine (Hermes Integration)');
  console.log('');
  console.log('Usage:');
  console.log('  npx tsx references/surgical-orchestration.ts <build-plan.json>');
  console.log('  npx tsx references/surgical-orchestration.ts --dry-run <build-plan.json>');
  console.log('  npx tsx references/surgical-orchestration.ts --review <build-plan.json>');
  console.log('  npx tsx references/surgical-orchestration.ts --init');
  console.log('');
  console.log('Configuration:');
  console.log(`  MAX_CONCURRENCY: ${ORCHESTRATOR_CONFIG.MAX_CONCURRENCY}`);
  console.log(`  MAX_REVISION_CYCLES: ${ORCHESTRATOR_CONFIG.MAX_REVISION_CYCLES}`);
  console.log(`  SUBAGENT_TIMEOUT_MS: ${ORCHESTRATOR_CONFIG.SUBAGENT_TIMEOUT_MS}`);
  console.log(`  COMPACTION_TOKEN_THRESHOLD: ${ORCHESTRATOR_CONFIG.COMPACTION_TOKEN_THRESHOLD}`);
}

export async function runReview(plan: BuildPlan, dispatch: SubagentDispatcher): Promise<number> {
  const reviewer = new StandardCodeReviewer(plan, dispatch);
  const outcome: CodeReviewOutcome = await reviewer.run();

  console.log('\n[CODE-REVIEWER] File classification:');
  for (const c of outcome.classification) {
    console.log(`  ${c.lane.padEnd(10)} ${c.filePath}`);
  }

  console.log('\n[CODE-REVIEWER] Specialised reviewer summaries:');
  for (const s of outcome.reviewerSummaries) {
    console.log(`  ${s.role}: ${s.summary}`);
  }

  const composer = new Composer();
  const final = composer.compose(outcome, plan);

  console.log('\n[COMPOSER] Selected recommendations (2):');
  final.recommendations.forEach((r, i) => console.log(`  ${i + 1}. ${r}`));
  console.log('[COMPOSER] Selected suggestions (2):');
  final.suggestions.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
  return 0;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printHelp();
    return 0;
  }

  if (argv[0] === '--init') {
    if (existsSync('build-plan.json')) {
      console.error('Refusing to overwrite existing build-plan.json');
      return 1;
    }
    writeFileSync('build-plan.json', JSON.stringify(SAMPLE_PLAN, null, 2));
    console.log('Created sample build-plan.json');
    return 0;
  }

  const dryRun = argv[0] === '--dry-run';
  const review = argv[0] === '--review';
  const planArg = dryRun || review ? argv[1] : argv[0];
  if (!planArg) {
    console.error('Missing <build-plan.json>');
    return 1;
  }

  const planPath = resolve(planArg);
  if (!existsSync(planPath)) {
    console.error(`Build plan not found: ${planPath}`);
    return 1;
  }

  let parsedPlan: unknown;
  try {
    parsedPlan = JSON.parse(readFileSync(planPath, 'utf-8'));
  } catch (err) {
    console.error(`Build plan is not valid JSON: ${(err as Error).message}`);
    return 1;
  }
  if (!isValidBuildPlan(parsedPlan)) {
    console.error('Build plan failed schema validation (requires description and non-empty changes).');
    return 1;
  }

  if (review) {
    return runReview(parsedPlan, dryRunDispatcher);
  }

  console.log('[ORCHESTRATOR] Starting Surgical Orchestration...');
  console.log(`Plan: ${parsedPlan.description}`);
  console.log(`Changes: ${parsedPlan.changes.length} files`);

  const engine = new OrchestrationEngine(
    parsedPlan,
    dryRun ? dryRunDispatcher : hermesDispatcher,
    { skipTests: dryRun },
  );

  engine.on('test_fixer_requested', ({ context }: { context: string }) => {
    console.log('\n[TEST-FIXER] Context prepared for test-fixer subagent:');
    console.log(`${context.substring(0, 500)}...`);
  });

  try {
    const result = await engine.run();
    console.log('\n[ORCHESTRATOR] Final Result:', result.success ? 'SUCCESS' : 'FAILED');
    console.log(`Overall Status: ${result.jobCard.overallStatus}`);
    if (result.testResults) {
      console.log(`Playwright: ${result.testResults.passed ? 'PASSED' : 'FAILED'}`);
      if (result.testResults.failingSpecs?.length) {
        console.log(`Failing specs: ${result.testResults.failingSpecs.join(', ')}`);
      }
    }
    return result.success ? 0 : 1;
  } catch (err) {
    console.error('[ORCHESTRATOR] Fatal error:', err);
    return 1;
  }
}

function isCliEntryPoint(): boolean {
  const metaMain = (import.meta as { main?: boolean }).main;
  if (typeof metaMain === 'boolean') return metaMain;
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isCliEntryPoint()) {
  main().then((code) => {
    process.exitCode = code;
  });
}

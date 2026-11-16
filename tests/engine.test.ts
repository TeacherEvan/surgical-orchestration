import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OrchestrationEngine,
  SubagentManager,
  serializeJobCard,
  type BuildPlan,
  type JobCard,
  type SubagentDispatcher,
} from '../references/orchestrator.js';
import {
  dryRunDispatcher,
  parseSubagentResult,
} from '../references/surgical-orchestration.js';

const ROOT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

function makeEmptyCard(): JobCard {
  return {
    planId: 'TEST-CARD',
    jobs: new Map(),
    completedHashes: new Set(),
    overallStatus: 'IN_PROGRESS',
  };
}

async function testSlotCleanupOnInvalidScopeAndErrors(): Promise<void> {
  const card = makeEmptyCard();
  const mgr = new SubagentManager(card, dryRunDispatcher);

  for (const badScope of ['', '   ', 'src/\0evil']) {
    await assert.rejects(
      () =>
        mgr.spawnSubagent({
          missionId: 'M-BAD-SCOPE',
          role: 'WORKER',
          allowedFolderScope: badScope,
          instructions: 'noop',
          contextSummary: '{}',
        }),
      /\[SCOPE_INVALID\]/,
    );
    assert.equal(mgr.getActiveCount(), 0, 'invalid scope must not leak concurrency slot');
    assert.equal(mgr.canSpawn(), true, 'canSpawn remains true after [SCOPE_INVALID]');
  }

  // Error inside dispatcher must also release slot via try/finally
  const throwingMgr = new SubagentManager(card, async () => {
    throw new Error('boom');
  });
  await assert.rejects(
    () =>
      throwingMgr.spawnSubagent({
        missionId: 'M-BOOM',
        role: 'WORKER',
        allowedFolderScope: '.',
        instructions: 'noop',
        contextSummary: '{}',
      }),
    /boom/,
  );
  assert.equal(throwingMgr.getActiveCount(), 0, 'throwing dispatcher must release slot');
  console.log('  ok - slot cleanup on [SCOPE_INVALID] and dispatcher throws');
}

async function testAbortSignalAndTimeout(): Promise<void> {
  const card = makeEmptyCard();
  let observedSignal: AbortSignal | undefined;

  const slowDispatch: SubagentDispatcher = async (_id, _payload, signal) => {
    observedSignal = signal;
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { status: 'COMPLETED', filesModified: [], debrief: 'late', selfAudit: 'ok' };
  };

  const mgr = new SubagentManager(card, slowDispatch, { timeoutMs: 25 });
  await assert.rejects(
    () =>
      mgr.spawnSubagent({
        missionId: 'M-TIMEOUT',
        role: 'WORKER',
        allowedFolderScope: '.',
        instructions: 'wait',
        contextSummary: '{}',
      }),
    /\[TIMEOUT\]/,
  );
  assert.equal(observedSignal?.aborted, true, 'AbortSignal aborted on timeout');
  assert.equal(mgr.getActiveCount(), 0, 'slot released after timeout');

  // External AbortSignal cancellation
  const externalController = new AbortController();
  setTimeout(() => externalController.abort(), 15);
  await assert.rejects(
    () =>
      mgr.spawnSubagent(
        {
          missionId: 'M-ABORT',
          role: 'WORKER',
          allowedFolderScope: '.',
          instructions: 'wait',
          contextSummary: '{}',
        },
        externalController.signal,
      ),
    /\[ABORTED\]/,
  );
  assert.equal(mgr.getActiveCount(), 0, 'slot released after external abort');
  console.log('  ok - AbortSignal threading, timeout, and external abort');
}

async function testFailedWorkerShortCircuitsVerifier(): Promise<void> {
  const plan: BuildPlan = {
    description: 'short-circuit test',
    changes: [{ filePath: 'src/api/handler.ts', description: 'api', type: 'modify' }],
  };

  let workerCalls = 0;
  let verifierCalls = 0;
  let sawRetryFeedback = false;

  const dispatch: SubagentDispatcher = async (_id, payload) => {
    if (payload.role === 'VERIFIER') {
      verifierCalls++;
      return { status: 'COMPLETED', filesModified: [], debrief: 'verified', selfAudit: 'ok' };
    }
    workerCalls++;
    if (workerCalls === 2 && payload.instructions.includes('compile failure 1')) {
      sawRetryFeedback = true;
    }
    return {
      status: 'FAILED',
      filesModified: [],
      debrief: `compile failure ${workerCalls}`,
      selfAudit: `err-${workerCalls}`,
    };
  };

  const engine = new OrchestrationEngine(plan, dispatch, {
    skipTests: true,
    maxRevisionCycles: 3,
  });
  const result = await engine.run();

  assert.equal(verifierCalls, 0, 'FAILED worker must NEVER route to VERIFIER');
  assert.equal(workerCalls, 3, 'worker retried up to maxRevisionCycles=3');
  assert.equal(sawRetryFeedback, true, 'worker failure debrief fed into retry instructions');
  assert.equal(result.success, false, 'escalated job makes engine.run() report success=false');
  assert.equal(result.jobCard.overallStatus, 'ESCALATED');
  const job = result.jobCard.jobs.get('JOB-001');
  assert.equal(job?.status, 'ESCALATED');
  assert.equal(job?.attempts, 3);
  console.log('  ok - FAILED worker short-circuits VERIFIER and consumes retry budget');
}

async function testBoundedConcurrencyWorkerPool(): Promise<void> {
  const plan: BuildPlan = {
    description: 'concurrent jobs',
    changes: [
      { filePath: 'src/alpha/a.ts', description: 'a', type: 'add' },
      { filePath: 'src/beta/b.ts', description: 'b', type: 'add' },
      { filePath: 'src/gamma/c.ts', description: 'c', type: 'add' },
      { filePath: 'src/delta/d.ts', description: 'd', type: 'add' },
    ],
  };

  let active = 0;
  let maxObserved = 0;
  const dispatch: SubagentDispatcher = async (_id, payload) => {
    active++;
    if (active > maxObserved) maxObserved = active;
    await new Promise((resolve) => setTimeout(resolve, 35));
    active--;
    return {
      status: 'COMPLETED',
      filesModified: [],
      debrief: `done ${payload.missionId}`,
      selfAudit: 'ok',
    };
  };

  const engine = new OrchestrationEngine(plan, dispatch, { skipTests: true });
  const result = await engine.run();

  assert.equal(result.success, true);
  assert.equal(maxObserved, 2, `engine must execute concurrently up to MAX_CONCURRENCY=2 (saw ${maxObserved})`);

  const serialized = serializeJobCard(result.jobCard);
  assert.equal(Object.keys(serialized.jobs).length, 4);
  assert.equal(Array.isArray(serialized.completedHashes), true);
  assert.equal(serialized.completedHashes.length, 4);
  console.log('  ok - bounded concurrency MAX_CONCURRENCY=2 and serializeJobCard()');
}

async function testSpawnTestFixerAndCliImportGuard(): Promise<void> {
  const plan: BuildPlan = {
    description: 'test-fixer path',
    changes: [{ filePath: 'src/ui/App.tsx', description: 'render', type: 'modify' }],
  };

  let testRuns = 0;
  let fixerCalls = 0;
  let requestedEvents = 0;

  const dispatch: SubagentDispatcher = async (_id, payload) => {
    if (payload.role === 'TEST_FIXER') {
      fixerCalls++;
      return {
        status: 'COMPLETED',
        filesModified: ['tests/app.spec.ts'],
        debrief: 'updated selector in failing spec',
        selfAudit: 're-ran playwright check',
      };
    }
    return {
      status: 'COMPLETED',
      filesModified: [],
      debrief: `ok ${payload.missionId}`,
      selfAudit: 'ok',
    };
  };

  const engine = new OrchestrationEngine(plan, dispatch, {
    testRunner: async () => {
      testRuns++;
      return testRuns === 1
        ? { passed: false, trace: 'Error in tests/app.spec.ts:14', failingSpecs: ['tests/app.spec.ts'] }
        : { passed: true };
    },
  });
  engine.on('test_fixer_requested', () => {
    requestedEvents++;
  });

  const result = await engine.run();
  assert.equal(requestedEvents, 1, 'test_fixer_requested emitted');
  assert.equal(fixerCalls, 1, 'spawnTestFixer dispatched real TEST_FIXER subagent');
  assert.equal(testRuns, 2, 'Playwright re-ran once after TEST_FIXER COMPLETED');
  assert.equal(result.success, true, 'passing re-test completes orchestration');
  assert.equal(result.fixResult?.status, 'COMPLETED');

  // Verify parseSubagentResult malformed edge cases
  const bad = parseSubagentResult('not json at all');
  assert.equal(bad.status, 'FAILED');
  const arr = parseSubagentResult('[1, 2, 3]');
  assert.equal(arr.status, 'FAILED');

  // Verify importing surgical-orchestration.ts emits zero CLI stdout
  const stdout = execFileSync(
    process.execPath,
    ['--import', 'tsx', '-e', "import('./references/surgical-orchestration.js').then(() => console.log('IMPORT_OK'))"],
    { cwd: ROOT_DIR, encoding: 'utf-8' },
  ).trim();
  assert.equal(stdout, 'IMPORT_OK', `importing CLI module must not run main(); got ${JSON.stringify(stdout)}`);
  console.log('  ok - spawnTestFixer bounded pass, parseSubagentResult, and import guard');
}

async function main(): Promise<void> {
  await testSlotCleanupOnInvalidScopeAndErrors();
  await testAbortSignalAndTimeout();
  await testFailedWorkerShortCircuitsVerifier();
  await testBoundedConcurrencyWorkerPool();
  await testSpawnTestFixerAndCliImportGuard();
  console.log('\nALL ENGINE INVARIANT ASSERTIONS PASSED');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import { EventEmitter } from 'node:events';
import {
  ContextCompactor,
  loopGuardIsDuplicateHash,
  loopGuardRecordHash,
} from './compactor.js';
import { computeDebriefHash } from './debrief.js';
import {
  buildJobMap,
  buildVerifierInstructions,
  buildWorkerInstructions,
  executePlaywrightCommand,
  findProjectRoot,
} from './instructions.js';
import { SubagentManager } from './subagent-manager.js';
import { dispatchTestFixer } from './test-fixer.js';
import {
  ORCHESTRATOR_CONFIG,
  type BuildPlan,
  type CompactLedger,
  type EngineOptions,
  type FolderJob,
  type JobCard,
  type OrchestrationResult,
  type SubagentDispatcher,
  type SubagentResult,
  type TestResult,
} from './types.js';

export interface OrchestrationEngineOptions extends EngineOptions {
  testRunner?: (ledger: CompactLedger) => Promise<TestResult>;
}

/**
 * Multi-folder Worker/Verifier state machine with bounded concurrency,
 * canonical debrief hashing, FAILED-worker short-circuiting, and bounded
 * Test-Fixer execution.
 */
export class OrchestrationEngine extends EventEmitter {
  private jobCard: JobCard;
  protected manager: SubagentManager;
  private plan: BuildPlan;
  private skipTests: boolean;
  private maxConcurrency: number;
  private maxRevisionCycles: number;
  private compactionThreshold: number;
  private signal?: AbortSignal;
  private testRunner?: (ledger: CompactLedger) => Promise<TestResult>;

  constructor(plan: BuildPlan, dispatch?: SubagentDispatcher, opts?: OrchestrationEngineOptions) {
    super();
    this.plan = plan;
    this.skipTests = opts?.skipTests ?? false;
    this.maxConcurrency = Math.max(1, opts?.maxConcurrency ?? ORCHESTRATOR_CONFIG.MAX_CONCURRENCY);
    this.maxRevisionCycles = Math.max(
      1,
      opts?.maxRevisionCycles ?? ORCHESTRATOR_CONFIG.MAX_REVISION_CYCLES,
    );
    this.compactionThreshold =
      opts?.compactionThreshold ?? ORCHESTRATOR_CONFIG.COMPACTION_TOKEN_THRESHOLD;
    this.signal = opts?.signal;
    this.testRunner = opts?.testRunner;

    this.jobCard = {
      planId: `BUILD-${Date.now()}`,
      jobs: buildJobMap(plan),
      completedHashes: new Set(),
      overallStatus: 'IN_PROGRESS',
    };
    this.manager = new SubagentManager(this.jobCard, dispatch, {
      maxConcurrency: this.maxConcurrency,
      timeoutMs: opts?.timeoutMs,
    });
  }

  setDispatcher(dispatch: SubagentDispatcher): void {
    this.manager.setDispatcher(dispatch);
  }

  async run(): Promise<OrchestrationResult> {
    const entries = Array.from(this.jobCard.jobs.entries());
    let nextIndex = 0;
    const poolSize = Math.max(1, Math.min(this.maxConcurrency, entries.length));

    const workers = Array.from({ length: poolSize }, async () => {
      while (nextIndex < entries.length) {
        if (this.signal?.aborted) {
          throw new Error('[ABORTED] OrchestrationEngine run aborted.');
        }
        const current = entries[nextIndex++];
        if (!current) break;
        await this.executeJobLoop(current[0], current[1]);
      }
    });
    await Promise.all(workers);

    const ledger = ContextCompactor.compact(this.jobCard, this.compactionThreshold);
    const allVerified = Array.from(this.jobCard.jobs.values()).every(
      (job) => job.status === 'VERIFIED',
    );
    if (!allVerified) {
      this.jobCard.overallStatus = 'ESCALATED';
      return { success: false, jobCard: this.jobCard };
    }

    if (this.skipTests) {
      this.jobCard.overallStatus = 'COMPLETED';
      return { success: true, jobCard: this.jobCard };
    }

    this.jobCard.overallStatus = 'PLAYWRIGHT_TESTING';
    const testResult = await this.runPlaywrightTests(ledger);
    if (testResult.passed) {
      this.jobCard.overallStatus = 'COMPLETED';
      return { success: true, jobCard: this.jobCard, testResults: testResult };
    }

    return this.runTestFixerPass(testResult, ledger);
  }

  private async executeJobLoop(jobId: string, job: FolderJob): Promise<void> {
    while (job.attempts < this.maxRevisionCycles) {
      job.status = 'WORKER_ACTIVE';
      const ledger = ContextCompactor.compact(this.jobCard, this.compactionThreshold);
      const workerResult = await this.manager.spawnSubagent(
        {
          missionId: `${jobId}-W`,
          role: 'WORKER',
          allowedFolderScope: job.parentFolder,
          instructions: buildWorkerInstructions(job, this.plan),
          contextSummary: JSON.stringify(ledger),
        },
        this.signal,
      );

      const workerHash = computeDebriefHash({
        directory: job.parentFolder,
        modifiedFiles: workerResult.filesModified,
        diffHash: workerResult.debrief,
        errorSignature: workerResult.status === 'FAILED' ? workerResult.selfAudit : '',
      });

      if (loopGuardIsDuplicateHash(workerHash, this.jobCard.completedHashes)) {
        job.status = 'ESCALATED';
        return;
      }
      loopGuardRecordHash(workerHash, this.jobCard.completedHashes);

      job.debriefHistory.push({
        attempt: job.attempts + 1,
        agentRole: 'WORKER',
        debrief: workerResult.debrief,
        hash: workerHash,
      });

      // Short-circuit FAILED workers before routing to VERIFIER.
      if (workerResult.status === 'FAILED') {
        job.attempts++;
        job.lastVerifierFeedback =
          workerResult.debrief || workerResult.selfAudit || 'Worker reported FAILED status.';
        if (job.attempts >= this.maxRevisionCycles) {
          job.status = 'ESCALATED';
          return;
        }
        continue;
      }

      job.status = 'VERIFICATION_ACTIVE';
      const verifierResult = await this.manager.spawnSubagent(
        {
          missionId: `${jobId}-V`,
          role: 'VERIFIER',
          allowedFolderScope: job.parentFolder,
          instructions: buildVerifierInstructions(job, workerResult),
          contextSummary: JSON.stringify(ledger),
        },
        this.signal,
      );

      if (verifierResult.status === 'COMPLETED') {
        job.status = 'VERIFIED';
        return;
      }

      job.attempts++;
      job.lastVerifierFeedback = verifierResult.debrief;
      if (job.attempts >= this.maxRevisionCycles) {
        job.status = 'ESCALATED';
        return;
      }
    }

    job.status = 'ESCALATED';
  }

  private async runTestFixerPass(
    initialFailure: TestResult,
    ledger: CompactLedger,
  ): Promise<OrchestrationResult> {
    this.jobCard.overallStatus = 'ESCALATED';
    const fixResult = await this.spawnTestFixer(initialFailure, ledger);
    if (fixResult.status !== 'COMPLETED') {
      return { success: false, jobCard: this.jobCard, testResults: initialFailure, fixResult };
    }

    const retestResult = await this.runPlaywrightTests(ledger);
    if (retestResult.passed) {
      this.jobCard.overallStatus = 'COMPLETED';
      return { success: true, jobCard: this.jobCard, testResults: retestResult, fixResult };
    }

    this.jobCard.overallStatus = 'ESCALATED';
    return { success: false, jobCard: this.jobCard, testResults: retestResult, fixResult };
  }

  protected async runPlaywrightTests(ledger: CompactLedger): Promise<TestResult> {
    if (this.testRunner) {
      return this.testRunner(ledger);
    }
    return executePlaywrightCommand(findProjectRoot(this.plan));
  }

  protected async spawnTestFixer(
    testResult: TestResult,
    ledger: CompactLedger,
  ): Promise<SubagentResult> {
    return dispatchTestFixer({
      plan: this.plan,
      jobCard: this.jobCard,
      manager: this.manager,
      testResult,
      ledger,
      signal: this.signal,
      onRequested: (context) => {
        this.emit('test_fixer_requested', { context });
      },
    });
  }
}

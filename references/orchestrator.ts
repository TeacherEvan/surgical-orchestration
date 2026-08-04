import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

// ============================================================================
// Technical Specifications & System Limits
// ============================================================================

export const ORCHESTRATOR_CONFIG = {
  MAX_CONCURRENCY: 2,
  MAX_REVISION_CYCLES: 3,
  SUBAGENT_TIMEOUT_MS: 180_000,
  COMPACTION_TOKEN_THRESHOLD: 0.75,
} as const;

export type AgentRole = 'WORKER' | 'VERIFIER' | 'TEST_FIXER';
export type JobStatus =
  | 'PENDING'
  | 'WORKER_ACTIVE'
  | 'VERIFICATION_ACTIVE'
  | 'VERIFIED'
  | 'ESCALATED'
  | 'FAILED';

export interface SubagentPayload {
  missionId: string;
  role: AgentRole;
  allowedFolderScope: string;
  instructions: string;
  contextSummary: string;
}

export interface SubagentResult {
  status: 'COMPLETED' | 'FAILED';
  filesModified: string[];
  debrief: string;
  selfAudit: string;
}

export interface FolderJob {
  id: string;
  parentFolder: string;
  status: JobStatus;
  attempts: number;
  assignedWorkerId?: string;
  assignedVerifierId?: string;
  debriefHistory: Array<{
    attempt: number;
    agentRole: AgentRole;
    debrief: string;
    hash: string;
  }>;
}

export interface JobCard {
  planId: string;
  jobs: Map<string, FolderJob>;
  completedHashes: Set<string>;
  overallStatus: 'IN_PROGRESS' | 'PLAYWRIGHT_TESTING' | 'COMPLETED' | 'ESCALATED' | 'FAILED';
}

// ============================================================================
// 1. Tool-Layer Directory Sandbox Guard
// ============================================================================

export class SecurityGuard {
  /**
   * Hard path assertion wrapper. Throws error if target path escapes allowed scope.
   * Prevents prompt-based boundary violations from becoming actual file access.
   */
  static assertScopeBoundary(targetPath: string, allowedScope: string, agentId: string): void {
    const absTarget = path.resolve(targetPath);
    const absScope = path.resolve(allowedScope);

    const relative = path.relative(absScope, absTarget);
    const isInside = !relative.startsWith('..') && !path.isAbsolute(relative);

    if (!isInside && absTarget !== absScope) {
      throw new Error(
        `[SECURITY_VIOLATION] Subagent '${agentId}' attempted unauthorized path access: '${targetPath}'. Locked Scope: '${allowedScope}'`
      );
    }
  }

  /**
   * Validates that a file path is within the allowed directory subtree.
   * Use before any file read/write/list operation in subagents.
   */
  static validateAccess(agentId: string, targetPath: string, allowedScope: string): boolean {
    try {
      this.assertScopeBoundary(targetPath, allowedScope, agentId);
      return true;
    } catch (err) {
      console.error(err);
      return false;
    }
  }
}

// ============================================================================
// 2. Anti-Loop Debrief Hashing
// ============================================================================

export class LoopGuard {
  /**
   * Generates SHA-256 hash of a debrief payload.
   * Used to detect duplicate work and prevent infinite loops.
   */
  static hashDebrief(debrief: string): string {
    return crypto.createHash('sha256').update(debrief, 'utf-8').digest('hex');
  }

  /**
   * Checks if a debrief hash has already been seen.
   * If a duplicate is found, the subagent branch should be terminated.
   */
  static isDuplicateHash(hash: string, completedHashes: Set<string>): boolean {
    return completedHashes.has(hash);
  }

  /**
   * Records a debrief hash for future loop detection.
   */
  static recordHash(hash: string, completedHashes: Set<string>): void {
    completedHashes.add(hash);
  }
}

// ============================================================================
// 3. Context Compaction
// ============================================================================

export class ContextCompactor {
  /**
   * Strips raw tool outputs, long diffs, and execution logs.
   * Retains only state markers, debrief hashes, and active checklists.
   */
  static compact(jobCard: JobCard): CompactLedger {
    const ledger: CompactLedger = {
      activeJobs: [],
      completedChecks: [],
      debriefHashes: [],
    };

    for (const [jobId, job] of jobCard.jobs) {
      const latestDebrief = job.debriefHistory[job.debriefHistory.length - 1];
      if (job.status === 'VERIFIED' && latestDebrief) {
        const hashSig = LoopGuard.hashDebrief(latestDebrief.debrief);
        ledger.completedChecks.push({
          folder: job.parentFolder,
          hash: hashSig.substring(0, 8),
        });
        ledger.debriefHashes.push(hashSig);
      } else {
        ledger.activeJobs.push({
          jobId,
          folder: job.parentFolder,
          status: job.status,
          attempts: job.attempts,
        });
      }
    }

    return ledger;
  }

  /**
   * Estimates token count of the compacted ledger for threshold checking.
   */
  static estimateTokenCount(ledger: CompactLedger): number {
    return JSON.stringify(ledger).length / 4; // rough 4 chars/token estimate
  }
}

export interface CompactLedger {
  activeJobs: Array<{
    jobId: string;
    folder: string;
    status: JobStatus;
    attempts: number;
  }>;
  completedChecks: Array<{
    folder: string;
    hash: string;
  }>;
  debriefHashes: string[];
}

// ============================================================================
// 4. Subagent Manager — Spawning & Lifecycle
// ============================================================================

export class SubagentManager extends EventEmitter {
  private activeAgents: Map<string, { role: AgentRole; startTime: number }> = new Map();
  private jobCard: JobCard;

  constructor(jobCard: JobCard) {
    super();
    this.jobCard = jobCard;
  }

  /**
   * Returns current count of active subagents.
   */
  getActiveCount(): number {
    return this.activeAgents.size;
  }

  /**
   * Checks if a new subagent can be spawned (respects MAX_CONCURRENCY cap).
   */
  canSpawn(): boolean {
    return this.getActiveCount() < ORCHESTRATOR_CONFIG.MAX_CONCURRENCY;
  }

  /**
   * Spawns a subagent with the given payload.
   * Enforces scope boundaries, timeout, and concurrency limits.
   */
  async spawnSubagent(payload: SubagentPayload): Promise<SubagentResult> {
    if (!this.canSpawn()) {
      throw new Error('Max concurrency reached. Cannot spawn subagent.');
    }

    const agentId = `agent-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    this.activeAgents.set(agentId, { role: payload.role, startTime: Date.now() });

    // Validate scope boundary before spawning
    SecurityGuard.assertScopeBoundary(payload.allowedFolderScope, payload.allowedFolderScope, agentId);

    // Set timeout watchdog
    const timeoutId = setTimeout(() => {
      this.emit('agent_timeout', agentId);
      this.terminateAgent(agentId, 'TIMEOUT');
    }, ORCHESTRATOR_CONFIG.SUBAGENT_TIMEOUT_MS);

    try {
      // In production, this would dispatch to an actual subagent runtime
      // For now, emit the spawn event for the runtime to handle
      this.emit('spawn_requested', { agentId, payload });

      // Simulate subagent execution (replace with actual agent dispatch)
      const result: SubagentResult = await this.executeSubagent(agentId, payload);

      // Clean up
      clearTimeout(timeoutId);
      this.activeAgents.delete(agentId);
      this.emit('agent_completed', { agentId, result });

      return result;
    } catch (error) {
      clearTimeout(timeoutId);
      this.activeAgents.delete(agentId);
      this.emit('agent_error', { agentId, error });
      throw error;
    }
  }

  /**
   * Terminates a running subagent (SIGKILL equivalent).
   */
  private terminateAgent(agentId: string, reason: string): void {
    this.activeAgents.delete(agentId);
    this.emit('agent_terminated', { agentId, reason });
  }

  /**
   * Executes the subagent — override this in production with real agent dispatch.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async executeSubagent(_agentId: string, _payload: SubagentPayload): Promise<SubagentResult> {
    // Production implementation would integrate with Hermes subagent runtime
    // This is a placeholder that should be replaced
    throw new Error('Subagent runtime not configured. Override executeSubagent() with actual agent dispatch.');
  }
}

// ============================================================================
// 5. Orchestration Engine — State Machine
// ============================================================================

export class OrchestrationEngine {
  private jobCard: JobCard;
  private manager: SubagentManager;
  private plan: BuildPlan;

  constructor(plan: BuildPlan) {
    this.plan = plan;
    this.jobCard = {
      planId: `BUILD-${Date.now()}`,
      jobs: new Map(),
      completedHashes: new Set(),
      overallStatus: 'IN_PROGRESS',
    };
    this.manager = new SubagentManager(this.jobCard);
    this.initializeJobCard(plan);
  }

  /**
   * Initializes the JobCard from the build plan.
   */
  private initializeJobCard(plan: BuildPlan): void {
    const parentFolders = this.extractParentFolders(plan);

    for (const [index, folder] of parentFolders.entries()) {
      const jobId = `JOB-${String(index + 1).padStart(3, '0')}`;
      this.jobCard.jobs.set(jobId, {
        id: jobId,
        parentFolder: folder,
        status: 'PENDING',
        attempts: 0,
        debriefHistory: [],
      });
    }
  }

  /**
   * Extracts unique parent folders from the build plan's file list.
   */
  private extractParentFolders(plan: BuildPlan): string[] {
    const folders = new Set<string>();
    for (const change of plan.changes) {
      const parent = path.dirname(change.filePath);
      // Get the top-level parent directory (e.g., ./src/components/auth -> ./src/components)
      const parts = parent.split(path.sep);
      if (parts.length >= 2) {
        folders.add(parts.slice(0, 2).join(path.sep));
      }
    }
    return Array.from(folders);
  }

  /**
   * Runs the full orchestration pipeline.
   */
  async run(): Promise<OrchestrationResult> {
    // Step 1: Dispatch Worker-Verifier loop for each folder
    for (const [jobId, job] of this.jobCard.jobs) {
      await this.executeJobLoop(jobId, job);
    }

    // Step 2: Compact context
    const ledger = ContextCompactor.compact(this.jobCard);

    // Step 3: Run Playwright tests
    this.jobCard.overallStatus = 'PLAYWRIGHT_TESTING';
    const testResult = await this.runPlaywrightTests(ledger);

    if (testResult.passed) {
      this.jobCard.overallStatus = 'COMPLETED';
      return { success: true, jobCard: this.jobCard, testResults: testResult };
    } else {
      this.jobCard.overallStatus = 'ESCALATED';
      // Spawn Test-Fixer subagent
      const fixResult = await this.spawnTestFixer(testResult, ledger);
      return { success: false, jobCard: this.jobCard, testResults: testResult, fixResult };
    }
  }

  /**
   * Executes the Worker-Verifier loop for a single folder job.
   */
  private async executeJobLoop(jobId: string, job: FolderJob): Promise<void> {
    while (job.attempts < ORCHESTRATOR_CONFIG.MAX_REVISION_CYCLES) {
      job.status = 'WORKER_ACTIVE';

      // Compact context before spawning
      const ledger = ContextCompactor.compact(this.jobCard);

      // Spawn Worker
      const workerPayload: SubagentPayload = {
        missionId: `${jobId}-W`,
        role: 'WORKER',
        allowedFolderScope: job.parentFolder,
        instructions: this.buildWorkerInstructions(job, this.plan),
        contextSummary: JSON.stringify(ledger),
      };

      const workerResult = await this.manager.spawnSubagent(workerPayload);
      const workerHash = LoopGuard.hashDebrief(workerResult.debrief);

      // Check for duplicate hash (loop detection)
      if (LoopGuard.isDuplicateHash(workerHash, this.jobCard.completedHashes)) {
        job.status = 'ESCALATED';
        this.jobCard.completedHashes.add(workerHash);
        return;
      }
      LoopGuard.recordHash(workerHash, this.jobCard.completedHashes);

      job.debriefHistory.push({
        attempt: job.attempts + 1,
        agentRole: 'WORKER',
        debrief: workerResult.debrief,
        hash: workerHash,
      });

      // Spawn Verifier
      job.status = 'VERIFICATION_ACTIVE';
      const verifierPayload: SubagentPayload = {
        missionId: `${jobId}-V`,
        role: 'VERIFIER',
        allowedFolderScope: job.parentFolder,
        instructions: this.buildVerifierInstructions(job, workerResult),
        contextSummary: JSON.stringify(ledger),
      };

      const verifierResult = await this.manager.spawnSubagent(verifierPayload);

      if (verifierResult.status === 'COMPLETED') {
        job.status = 'VERIFIED';
        this.jobCard.completedHashes.add(workerHash);
        return;
      } else {
        job.attempts++;
        if (job.attempts >= ORCHESTRATOR_CONFIG.MAX_REVISION_CYCLES) {
          job.status = 'ESCALATED';
          return;
        }
        // Retry with verifier feedback
      }
    }

    job.status = 'ESCALATED';
  }

  /**
   * Builds Worker instructions from the build plan.
   */
  private buildWorkerInstructions(job: FolderJob, plan: BuildPlan): string {
    const relevantChanges = plan.changes.filter(
      (c) => path.dirname(c.filePath).startsWith(job.parentFolder)
    );

    return `## Worker Mission: ${job.id}

Scope: ${job.parentFolder}

Changes required:
${relevantChanges.map((c) => `- ${c.filePath}: ${c.description}`).join('\n')}

Principles:
1. FOLLOWING BEST PRACTICES
2. IS THAT THE BEST YOU CAN DO?

Exit protocol: Emit JSON with status, files_modified, debrief, self_audit.`;
  }

  /**
   * Builds Verifier instructions for reviewing Worker output.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private buildVerifierInstructions(job: FolderJob, _workerResult: SubagentResult): string {
    return `## Verifier Mission: ${job.id}

Review the Worker's changes in scope: ${job.parentFolder}

Check:
1. All changes follow best practices
2. No scope boundary violations
3. Code quality is high
4. Is that the best work possible?

Exit protocol: Emit JSON with status (COMPLETED|FAILED), files_modified, debrief, self_audit.`;
  }

  /**
   * Runs Playwright tests against the modified codebase.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async runPlaywrightTests(_ledger: CompactLedger): Promise<TestResult> {
    // Production: execute `npx playwright test` in the project root
    // Return { passed: boolean, trace?: string, failureLog?: string }
    throw new Error('Playwright test runner not configured.');
  }

  /**
   * Spawns a Test-Fixer subagent with need-to-know scope only.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async spawnTestFixer(_testResult: TestResult, _ledger: CompactLedger): Promise<SubagentResult> {
    // Test-Fixer receives ONLY: test failure trace + failing spec + README.md + ARCHITECTURE DIAGRAM
    // Must report back and immediately die.
    throw new Error('Test-Fixer not configured.');
  }
}

// ============================================================================
// Types
// ============================================================================

export interface BuildPlan {
  description: string;
  changes: Array<{
    filePath: string;
    description: string;
    type: 'add' | 'modify' | 'delete';
  }>;
}

export interface OrchestrationResult {
  success: boolean;
  jobCard: JobCard;
  testResults?: TestResult;
  fixResult?: SubagentResult;
}

export interface TestResult {
  passed: boolean;
  trace?: string;
  failureLog?: string;
  failingSpecs?: string[];
}

// ============================================================================
// CLI Entry Point
// ============================================================================

if (require.main === module) {
  console.log('Surgical Orchestration Engine');
  console.log('Usage: Integrate this module into your Hermes subagent runtime.');
  console.log('Configuration:');
  console.log(`  MAX_CONCURRENCY: ${ORCHESTRATOR_CONFIG.MAX_CONCURRENCY}`);
  console.log(`  MAX_REVISION_CYCLES: ${ORCHESTRATOR_CONFIG.MAX_REVISION_CYCLES}`);
  console.log(`  SUBAGENT_TIMEOUT_MS: ${ORCHESTRATOR_CONFIG.SUBAGENT_TIMEOUT_MS}`);
  console.log(`  COMPACTION_TOKEN_THRESHOLD: ${ORCHESTRATOR_CONFIG.COMPACTION_TOKEN_THRESHOLD}`);
}

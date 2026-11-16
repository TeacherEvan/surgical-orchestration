/**
 * Shared configuration, domain types, and JobCard serialization helpers.
 */

export const ORCHESTRATOR_CONFIG = {
  MAX_CONCURRENCY: 2,
  MAX_REVISION_CYCLES: 3,
  SUBAGENT_TIMEOUT_MS: 180_000,
  COMPACTION_TOKEN_THRESHOLD: 0.75,
} as const;

export type AgentRole =
  | 'WORKER'
  | 'VERIFIER'
  | 'TEST_FIXER'
  | 'CODE_REVIEWER'
  | 'FRONTEND_REVIEWER'
  | 'BACKEND_REVIEWER'
  | 'COMPOSER';

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
  /** Forwarded up the chain: a reviewer's own recommendations for the parent. */
  recommendations?: string[];
  /** Forwarded up the chain: a reviewer's own suggestions for the parent. */
  suggestions?: string[];
}

/**
 * Injectable subagent dispatch strategy. A host supplies this to wire in
 * Hermes `delegate_task`, MCP tools, or test doubles.
 */
export type SubagentDispatcher = (
  agentId: string,
  payload: SubagentPayload,
  signal?: AbortSignal,
) => Promise<SubagentResult>;

export interface DebriefEntry {
  attempt: number;
  agentRole: AgentRole;
  debrief: string;
  hash: string;
}

export interface FolderJob {
  id: string;
  parentFolder: string;
  status: JobStatus;
  attempts: number;
  assignedWorkerId?: string;
  assignedVerifierId?: string;
  /** Verifier or Worker failure reason fed into the next Worker attempt. */
  lastVerifierFeedback?: string;
  debriefHistory: DebriefEntry[];
}

export interface JobCard {
  planId: string;
  jobs: Map<string, FolderJob>;
  completedHashes: Set<string>;
  overallStatus: 'IN_PROGRESS' | 'PLAYWRIGHT_TESTING' | 'COMPLETED' | 'ESCALATED' | 'FAILED';
}

export interface SerializedJobCard {
  planId: string;
  overallStatus: JobCard['overallStatus'];
  jobs: Record<string, FolderJob>;
  completedHashes: string[];
}

/**
 * Converts in-memory Map/Set JobCard structures to the wire JSON shape
 * validated by references/jobcard-schema.json.
 */
export function serializeJobCard(jobCard: JobCard): SerializedJobCard {
  const jobs: Record<string, FolderJob> = {};
  for (const [jobId, job] of jobCard.jobs.entries()) {
    jobs[jobId] = {
      ...job,
      debriefHistory: job.debriefHistory.map((entry) => ({ ...entry })),
    };
  }
  return {
    planId: jobCard.planId,
    overallStatus: jobCard.overallStatus,
    jobs,
    completedHashes: Array.from(jobCard.completedHashes),
  };
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

export interface BuildPlanChange {
  filePath: string;
  description: string;
  type: 'add' | 'modify' | 'delete';
}

export interface BuildPlan {
  description: string;
  changes: BuildPlanChange[];
}

export interface TestResult {
  passed: boolean;
  trace?: string;
  failureLog?: string;
  failingSpecs?: string[];
}

export interface OrchestrationResult {
  success: boolean;
  jobCard: JobCard;
  testResults?: TestResult;
  fixResult?: SubagentResult;
}

export interface EngineOptions {
  skipTests?: boolean;
  maxConcurrency?: number;
  maxRevisionCycles?: number;
  timeoutMs?: number;
  compactionThreshold?: number;
  signal?: AbortSignal;
}

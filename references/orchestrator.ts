/**
 * Thin barrel module preserving all historical exports from orchestrator.ts
 * while keeping implementation split into focused <250-LOC modules.
 */

export { defaultClassifyFile, type ChangedFile, type FileLane } from './classifier.js';
export {
  ContextCompactor,
  isInsideFolder,
  loopGuardIsDuplicateHash,
  loopGuardRecordHash,
} from './compactor.js';
export { OrchestrationEngine, type OrchestrationEngineOptions } from './engine.js';
export {
  Composer,
  StandardCodeReviewer,
  compose,
  type ClassifiedFile,
  type CodeReviewLayer,
  type CodeReviewOutcome,
  type ComposerVerdict,
  type ReviewerSummary,
} from './review-layer.js';
export { SubagentManager, type SubagentManagerOptions } from './subagent-manager.js';
export {
  ORCHESTRATOR_CONFIG,
  serializeJobCard,
  type AgentRole,
  type BuildPlan,
  type BuildPlanChange,
  type CompactLedger,
  type DebriefEntry,
  type EngineOptions,
  type FolderJob,
  type JobCard,
  type JobStatus,
  type OrchestrationResult,
  type SerializedJobCard,
  type SubagentDispatcher,
  type SubagentPayload,
  type SubagentResult,
  type TestResult,
} from './types.js';

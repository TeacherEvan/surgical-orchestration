import { loopGuardIsDuplicateHash, loopGuardRecordHash } from './compactor.js';
import { computeDebriefHash } from './debrief.js';
import { buildTestFixerContext, findProjectRoot } from './instructions.js';
import type { SubagentManager } from './subagent-manager.js';
import type {
  BuildPlan,
  CompactLedger,
  JobCard,
  SubagentPayload,
  SubagentResult,
  TestResult,
} from './types.js';

/**
 * Executes a single bounded TEST_FIXER subagent pass with need-to-know context
 * and canonical debrief loop protection.
 */
export async function dispatchTestFixer(params: {
  plan: BuildPlan;
  jobCard: JobCard;
  manager: SubagentManager;
  testResult: TestResult;
  ledger: CompactLedger;
  signal?: AbortSignal;
  onRequested: (context: string) => void;
}): Promise<SubagentResult> {
  const { plan, jobCard, manager, testResult, ledger, signal, onRequested } = params;
  const projectRoot = findProjectRoot(plan);
  const ledgerJson = JSON.stringify(ledger, null, 2);
  const context = buildTestFixerContext(projectRoot, testResult, ledgerJson);
  onRequested(context);

  const payload: SubagentPayload = {
    missionId: 'TEST-FIXER-001',
    role: 'TEST_FIXER',
    allowedFolderScope: projectRoot,
    instructions:
      '## TEST_FIXER Mission\n' +
      'Scope: Failing test specs, README.md, and architecture spec ONLY.\n' +
      'Single bounded fix pass: reconcile test assertions or report failure, then exit.\n\n' +
      context +
      '\n\nExit protocol: Emit JSON with status (COMPLETED|FAILED), files_modified, debrief, self_audit.',
    contextSummary: JSON.stringify(ledger),
  };

  const fixResult = await manager.spawnSubagent(payload, signal);
  const fixHash = computeDebriefHash({
    directory: projectRoot,
    modifiedFiles: fixResult.filesModified,
    diffHash: fixResult.debrief,
    errorSignature: fixResult.status === 'FAILED' ? fixResult.selfAudit : '',
  });

  if (loopGuardIsDuplicateHash(fixHash, jobCard.completedHashes)) {
    return {
      status: 'FAILED',
      filesModified: fixResult.filesModified,
      debrief: `Duplicate Test-Fixer debrief detected; aborted loop (${fixResult.debrief}).`,
      selfAudit: 'Loop guard terminated repeated Test-Fixer attempt.',
    };
  }
  loopGuardRecordHash(fixHash, jobCard.completedHashes);
  return fixResult;
}

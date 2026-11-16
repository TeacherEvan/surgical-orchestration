import * as path from 'node:path';
import { ORCHESTRATOR_CONFIG, type CompactLedger, type JobCard } from './types.js';

/**
 * Segment-aware planning-time predicate checking whether `child` resides inside
 * `parent`. Does NOT resolve symlinks; use `assertScopeBoundary()` from
 * `./security.js` before any filesystem operation.
 */
export function isInsideFolder(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * Checks whether a canonical debrief hash has already been recorded.
 */
export function loopGuardIsDuplicateHash(hash: string, completedHashes: Set<string>): boolean {
  return completedHashes.has(hash);
}

/**
 * Records a canonical debrief hash for future loop detection.
 */
export function loopGuardRecordHash(hash: string, completedHashes: Set<string>): void {
  completedHashes.add(hash);
}

/**
 * Strips raw tool stdout, diffs, and logs; retains only active status markers
 * and recorded debrief hashes.
 */
export class ContextCompactor {
  static compact(
    jobCard: JobCard,
    threshold: number = ORCHESTRATOR_CONFIG.COMPACTION_TOKEN_THRESHOLD,
  ): CompactLedger {
    const ledger: CompactLedger = {
      activeJobs: [],
      completedChecks: [],
      debriefHashes: [],
    };

    for (const [jobId, job] of jobCard.jobs) {
      const latestDebrief = job.debriefHistory[job.debriefHistory.length - 1];
      if (job.status === 'VERIFIED' && latestDebrief) {
        ledger.completedChecks.push({
          folder: job.parentFolder,
          hash: latestDebrief.hash.substring(0, 8),
        });
        if (threshold >= 1.0) {
          ledger.debriefHashes.push(latestDebrief.hash);
        }
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

  /** Estimates token count of the compacted ledger (~4 chars/token). */
  static estimateTokenCount(ledger: CompactLedger): number {
    return JSON.stringify(ledger).length / 4;
  }
}

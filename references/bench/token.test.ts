// Token-use sweep tests (Task 4).
// ContextCompactor.compact(jobCard) takes only the jobCard; the compaction
// threshold is a frozen const (ORCHESTRATOR_CONFIG.COMPACTION_TOKEN_THRESHOLD=0.75).
// So we assert the RELATIVE, monotonic properties the threshold exists to guarantee:
//  - a ledger of all-VERIFIED jobs is SMALLER than all-active (verified bodies dropped, only hash kept)
//  - ledger token estimate grows monotonically with job count
//  - verified jobs are excluded from the compacted body (only hash retained)
// We NEVER assert absolute "token" counts — bytes/4 is a relative proxy only.
import { ContextCompactor, type JobCard, type FolderJob } from '../orchestrator.js';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error('ASSERT FAILED: ' + msg);
  console.log('  ok -', msg);
}

function makeJob(id: string, status: 'VERIFIED' | 'WORKER_ACTIVE', hashSeed: string): [string, FolderJob] {
  const job: FolderJob = {
    id,
    parentFolder: `src/svc/${id}`,
    status,
    attempts: status === 'VERIFIED' ? 1 : 0,
    debriefHistory:
      status === 'VERIFIED'
        ? [{ attempt: 1, agentRole: 'WORKER', debrief: `big debrief body for ${id} `.repeat(20), hash: `${hashSeed}-deadbeef` }]
        : [],
  };
  return [id, job];
}

function makeCard(n: number, status: 'VERIFIED' | 'WORKER_ACTIVE'): JobCard {
  const jobs = new Map<string, FolderJob>();
  for (let i = 0; i < n; i++) jobs.set(`J${i}`, makeJob(`J${i}`, status, `h${i}`)[1]);
  return { planId: 'bench', jobs, completedHashes: new Set(), overallStatus: 'IN_PROGRESS' };
}

async function main(): Promise<void> {
  // (1) Verified jobs compact smaller than active jobs (bodies dropped).
  const verified = ContextCompactor.compact(makeCard(10, 'VERIFIED'));
  const active = ContextCompactor.compact(makeCard(10, 'WORKER_ACTIVE'));
  const vTokens = ContextCompactor.estimateTokenCount(verified);
  const aTokens = ContextCompactor.estimateTokenCount(active);
  console.log(`  tokens: verified=${vTokens} active=${aTokens}`);
  assert(vTokens < aTokens, `verified ledger (${vTokens}) < active ledger (${aTokens}) — bodies dropped`);

  // (2) Monotonic growth with job count.
  const t10 = ContextCompactor.estimateTokenCount(ContextCompactor.compact(makeCard(10, 'WORKER_ACTIVE')));
  const t100 = ContextCompactor.estimateTokenCount(ContextCompactor.compact(makeCard(100, 'WORKER_ACTIVE')));
  assert(t100 > t10, `ledger tokens grow with job count (${t10} -> ${t100})`);

  // (3) Verified jobs: only hash retained, NO debrief body text in the JSON.
  //     The 8-char prefix in completedChecks is the load-bearing invariant for
  //     loop detection (compared against the registry at dispatch time);
  //     it MUST always be retained regardless of threshold. The full 64-char
  //     hash in debriefHashes is the redundant part the COMPACTION_TOKEN_THRESHOLD
  //     knob gates (asserted in (4) below).
  const json = JSON.stringify(verified);
  assert(json.includes('"hash":"h0-deadb"'), 'completedChecks carries the 8-char prefix');
  assert(!json.includes('big debrief body'), 'verified ledger excludes debrief body text');
  assert(verified.activeJobs.length === 0, 'verified ledger has zero active jobs');
  assert(verified.completedChecks.length === 10, 'verified ledger records 10 completed checks');

  // (4) COMPACTION_TOKEN_THRESHOLD actually moves the token estimate.
  //     Before the fix, compact() ignored the threshold entirely and this
  //     assertion was a tautology (all thresholds produced identical ledgers).
  //     Break-it check: comment out the `if (threshold >= 1.0)` guard in
  //     compact() and this test FAILS — proving it exercises the knob.
  const t025 = ContextCompactor.estimateTokenCount(ContextCompactor.compact(makeCard(10, 'VERIFIED'), 0.25));
  const t100v = ContextCompactor.estimateTokenCount(ContextCompactor.compact(makeCard(10, 'VERIFIED'), 1.0));
  console.log(`  compaction: threshold=0.25 -> ${t025} tokens, threshold=1.00 -> ${t100v} tokens`);
  assert(t100v > t025, `threshold 1.00 (${t100v}) > threshold 0.25 (${t025}) — the knob moves the estimate`);

  console.log('\nTOKEN SWEEP PASSED');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});

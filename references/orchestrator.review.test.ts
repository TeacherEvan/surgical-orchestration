// RED-GREEN-REFACTOR: assertions for the Code Reviewer + Composer extension.
import {
  StandardCodeReviewer,
  OrchestrationEngine,
  type BuildPlan,
  type SubagentDispatcher,
  type SubagentResult,
} from './orchestrator.js';
import { Composer } from './surgical-orchestration.js';

const PLAN: BuildPlan = {
  description: 'mixed stack',
  changes: [
    { filePath: 'src/components/Button.tsx', description: 'ui', type: 'add' },
    { filePath: 'src/app/page.tsx', description: 'ui', type: 'modify' },
    { filePath: 'src/services/payment/StripeClient.ts', description: 'api', type: 'add' },
    { filePath: 'convex/payments.ts', description: 'db', type: 'modify' },
    { filePath: 'README.md', description: 'docs', type: 'modify' },
  ],
};

// Fake dispatcher: returns deterministic reviewer output with 2 recs + 2 sugg.
const fakeDispatch: SubagentDispatcher = async (_id, payload) => {
  const isFe = payload.role === 'FRONTEND_REVIEWER';
  const out: SubagentResult = {
    status: 'COMPLETED',
    filesModified: [],
    debrief: `${payload.role} reviewed ${payload.instructions.length} chars`,
    selfAudit: 'done',
    recommendations: isFe
      ? ['FE rec A', 'FE rec B', 'FE rec C']
      : ['BE rec A', 'BE rec B', 'BE rec C'],
    suggestions: isFe
      ? ['FE sug A', 'FE sug B', 'FE sug C']
      : ['BE sug A', 'BE sug B', 'BE sug C'],
  };
  return out;
};

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error('ASSERT FAILED: ' + msg);
  console.log('  ok -', msg);
}

async function main() {
  const reviewer = new StandardCodeReviewer(PLAN, fakeDispatch);

  // 1. Classification
  const cls = reviewer.classify();
  assert(cls.get('src/components/Button.tsx') === 'FRONTEND', 'Button.tsx => FRONTEND');
  assert(cls.get('src/app/page.tsx') === 'FRONTEND', 'page.tsx => FRONTEND');
  assert(cls.get('src/services/payment/StripeClient.ts') === 'BACKEND', 'StripeClient => BACKEND');
  assert(cls.get('convex/payments.ts') === 'BACKEND', 'convex/* => BACKEND');
  assert(cls.get('README.md') === 'AMBIGUOUS', 'README.md => AMBIGUOUS');

  // 2. Run: fans out to two reviewers, each summarised
  const outcome = await reviewer.run();
  assert(outcome.reviewerSummaries.length === 2, 'two specialised reviewers dispatched');
  assert(
    outcome.reviewerSummaries.some((r) => r.role === 'FRONTEND_REVIEWER'),
    'frontend reviewer present',
  );
  assert(
    outcome.reviewerSummaries.some((r) => r.role === 'BACKEND_REVIEWER'),
    'backend reviewer present',
  );
  // Each reviewer surfaces its own 2 recs + 2 sugg (pre-merged by Code Reviewer)
  const mergedRecs = outcome.recommendations;
  const mergedSugs = outcome.suggestions;
  assert(mergedRecs.length === 2, `code reviewer forwards exactly 2 recs (got ${mergedRecs.length})`);
  assert(mergedSugs.length === 2, `code reviewer forwards exactly 2 sugg (got ${mergedSugs.length})`);

  // 3. Composer: takes ALL subagent recommendations and selects exactly 2 of each
  const composer = new Composer();
  const final = composer.compose(outcome, PLAN);
  assert(final.recommendations.length === 2, `composer selects exactly 2 recommendations (got ${final.recommendations.length})`);
  assert(final.suggestions.length === 2, `composer selects exactly 2 suggestions (got ${final.suggestions.length})`);

  // 4. Top-level directory scope: plans touching single-segment parents
  // (convex/, api/, root-level files) must produce a job for EACH one.
  // The old extractParentFolders() dropped these entirely (parts.length >= 2
  // guard), so a plan touching only convex/ produced ZERO jobs and the engine
  // reported success with an empty JobCard.
  console.log('Top-level directory scope (convex/, api/, root files)');  {
    const topPlan: BuildPlan = {
      description: 'top-level scope probe',
      changes: [
        { filePath: 'convex/payments.ts', description: 'db', type: 'modify' },
        { filePath: 'convex/auth.ts', description: 'db', type: 'modify' },
        { filePath: 'api/server.ts', description: 'api', type: 'add' },
        { filePath: 'README.md', description: 'docs', type: 'modify' },
      ],
    };
    const engine = new OrchestrationEngine(topPlan, fakeDispatch, { skipTests: true });
    const result = await engine.run();
    const folders = [...result.jobCard.jobs.values()].map((j) => j.parentFolder).sort();
    assert(
      folders.length === 3,
      `top-level plan produces 3 jobs (convex, api, README), got ${folders.length} [${folders.join(',')}]`,
    );
    assert(folders.includes('convex'), 'convex/ is its own job scope');
    assert(folders.includes('api'), 'api/ is its own job scope');
    // path.dirname('README.md') === '.', so a root-level file's scope IS the repo root.
    assert(folders.includes('.'), 'root-level README.md scope is . (repo root), got [' + folders.join(',') + ']');
    for (const job of result.jobCard.jobs.values()) {
      assert(job.status === 'VERIFIED', `job ${job.id} (${job.parentFolder}) VERIFIED, got ${job.status}`);
    }
  }

  console.log('\nALL REVIEW/COMPOSER ASSERTIONS PASSED');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});

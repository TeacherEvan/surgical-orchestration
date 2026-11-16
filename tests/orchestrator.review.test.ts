import {
  Composer,
  OrchestrationEngine,
  StandardCodeReviewer,
  compose,
  defaultClassifyFile,
  type BuildPlan,
  type SubagentDispatcher,
  type SubagentResult,
} from '../references/orchestrator.js';

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

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log('  ok -', msg);
}

async function main(): Promise<void> {
  const reviewer = new StandardCodeReviewer(PLAN, fakeDispatch);

  // 1. Unified classifier (mid-path, path-start, dual-signal AMBIGUOUS)
  const cls = reviewer.classify();
  assert(cls.get('src/components/Button.tsx') === 'FRONTEND', 'Button.tsx => FRONTEND');
  assert(cls.get('src/app/page.tsx') === 'FRONTEND', 'page.tsx => FRONTEND');
  assert(cls.get('src/services/payment/StripeClient.ts') === 'BACKEND', 'StripeClient => BACKEND');
  assert(cls.get('convex/payments.ts') === 'BACKEND', 'convex/* => BACKEND');
  assert(cls.get('README.md') === 'AMBIGUOUS', 'README.md => AMBIGUOUS');
  assert(defaultClassifyFile('components/Card.tsx') === 'FRONTEND', 'path-start components/ => FRONTEND');
  assert(defaultClassifyFile('frontend/api/route.tsx') === 'AMBIGUOUS', 'dual FE+BE => AMBIGUOUS');

  // 2. Specialised fan-out + 2+2 reduction
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
  assert(
    outcome.recommendations.length === 2,
    `code reviewer forwards exactly 2 recs (got ${outcome.recommendations.length})`,
  );
  assert(
    outcome.suggestions.length === 2,
    `code reviewer forwards exactly 2 sugg (got ${outcome.suggestions.length})`,
  );

  // 3. Composer class & pure compose() helper
  const composer = new Composer();
  const final = composer.compose(outcome, PLAN);
  assert(final.recommendations.length === 2, `composer selects 2 recs (got ${final.recommendations.length})`);
  assert(final.suggestions.length === 2, `composer selects 2 sugs (got ${final.suggestions.length})`);

  const pureVerdict = compose(
    { recommendations: ['R1', 'R2'], suggestions: ['S1'] },
    { recommendations: ['R3'], suggestions: ['S2', 'S3'] },
  );
  assert(
    pureVerdict.recommendations.length === 2 && pureVerdict.suggestions.length === 2,
    'compose() reducer selects exactly 2+2 across lanes',
  );

  // 4. Single-segment parent scopes (convex/, api/, .)
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
  assert(folders.length === 3, `top-level plan produces 3 jobs, got ${folders.length}`);
  assert(folders.includes('convex'), 'convex/ is its own job scope');
  assert(folders.includes('api'), 'api/ is its own job scope');
  assert(folders.includes('.'), 'root-level README.md scope is .');
  for (const job of result.jobCard.jobs.values()) {
    assert(job.status === 'VERIFIED', `job ${job.id} (${job.parentFolder}) VERIFIED`);
  }

  console.log('\nALL REVIEW/COMPOSER ASSERTIONS PASSED');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

// Accuracy benchmark — classification, fan-out, loop guard, composer 2+2.
//
// Verifies the Code Reviewer layer (StandardCodeReviewer), the Orchestration
// Engine loop guard, the Composer, and the scope-boundary security predicate.
//
// Run from references/:  npx tsx bench/accuracy.test.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  StandardCodeReviewer,
  OrchestrationEngine,
  type BuildPlan,
  type SubagentDispatcher,
  type SubagentResult,
} from '../orchestrator.js';
import { Composer } from '../surgical-orchestration.js';
import { assertScopeBoundary } from '../security.js';
import { makeFakeDispatcher } from './fake-dispatcher.js';

// The benchmark is run from references/ (per the plan's verification command),
// so the fixtures resolve relative to process.cwd(). We also try a
// skill-root-relative path so the file is runnable from either location.
function loadPlan(name: string): BuildPlan {
  const candidates = [
    path.join(process.cwd(), 'bench', 'fixtures', `${name}.plan.json`),
    path.join(process.cwd(), 'references', 'bench', 'fixtures', `${name}.plan.json`),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8')) as BuildPlan;
  }
  throw new Error(`fixture not found: ${name} (tried ${candidates.join(', ')})`);
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error('ASSERT FAILED: ' + msg);
  console.log('  ok -', msg);
}

async function main(): Promise<void> {
  // ---------------------------------------------------------------------- A1
  // StandardCodeReviewer.classify() buckets FE / BE / AMBIGUOUS per
  // defaultClassifyFile rules, including the convex/ path-start (a real,
  // previously-fixed bug where convex/ was misclassified).
  console.log('A1 · StandardCodeReviewer.classify()');
  {
    const plan = loadPlan('mixed');
    const reviewer = new StandardCodeReviewer(
      plan,
      makeFakeDispatcher({ latencyMs: 0, accurate: true }),
    );
    const cls = reviewer.classify();

    assert(cls.get('src/components/Button.tsx') === 'FRONTEND', 'Button.tsx => FRONTEND');
    assert(cls.get('src/app/page.tsx') === 'FRONTEND', 'page.tsx => FRONTEND');
    assert(
      cls.get('src/services/api/auth.ts') === 'BACKEND',
      'src/services/api/auth.ts => BACKEND',
    );
    assert(
      cls.get('convex/payments.ts') === 'BACKEND',
      'convex/payments.ts => BACKEND (real fixed bug: convex/ path-start)',
    );
    assert(cls.get('docs/README.md') === 'AMBIGUOUS', 'docs/README.md => AMBIGUOUS');

    let fe = 0;
    let be = 0;
    let amb = 0;
    for (const lane of cls.values()) {
      if (lane === 'FRONTEND') fe++;
      else if (lane === 'BACKEND') be++;
      else amb++;
    }
    assert(fe === 2 && be === 2 && amb === 1, `lane tally FE=${fe} BE=${be} AMB=${amb} (expect 2/2/1)`);
  }

  // ---------------------------------------------------------------------- A2
  // run() fans out exactly 2 specialised reviewers; the AMBIGUOUS file lands in
  // BOTH lanes (frontend lane = not-BACKEND, backend lane = not-FRONTEND).
  console.log('A2 · run() fans out exactly 2 specialised reviewers; AMBIGUOUS in both lanes');
  {
    const plan = loadPlan('mixed');
    const reviewer = new StandardCodeReviewer(
      plan,
      makeFakeDispatcher({ latencyMs: 0, accurate: true }),
    );
    const outcome = await reviewer.run();

    assert(outcome.reviewerSummaries.length === 2, 'exactly 2 specialised reviewers dispatched');

    const roles = outcome.reviewerSummaries.map((r) => r.role).sort();
    assert(
      roles[0] === 'BACKEND_REVIEWER' && roles[1] === 'FRONTEND_REVIEWER',
      `roles are FRONTEND_REVIEWER + BACKEND_REVIEWER (got ${roles.join(',')})`,
    );

    const fe = outcome.reviewerSummaries.find((r) => r.role === 'FRONTEND_REVIEWER')!;
    const be = outcome.reviewerSummaries.find((r) => r.role === 'BACKEND_REVIEWER')!;
    assert(
      fe.filesReviewed.includes('docs/README.md'),
      'AMBIGUOUS docs/README.md routed into FRONTEND lane',
    );
    assert(
      be.filesReviewed.includes('docs/README.md'),
      'AMBIGUOUS docs/README.md routed into BACKEND lane',
    );
  }

  // ---------------------------------------------------------------------- A3
  // Composer.compose() distils the merged subagent output into exactly
  // 2 recommendations + 2 suggestions.
  console.log('A3 · Composer.compose() distils exactly 2 recommendations + 2 suggestions');
  {
    const plan = loadPlan('mixed');
    const reviewer = new StandardCodeReviewer(
      plan,
      makeFakeDispatcher({ latencyMs: 0, accurate: true }),
    );
    const outcome = await reviewer.run();
    const composer = new Composer();
    const final = composer.compose(outcome, plan);

    assert(
      final.recommendations.length === 2,
      `composer selects exactly 2 recommendations (got ${final.recommendations.length})`,
    );
    assert(
      final.suggestions.length === 2,
      `composer selects exactly 2 suggestions (got ${final.suggestions.length})`,
    );
  }

  // ---------------------------------------------------------------------- A4
  // Loop guard: a dispatcher that returns an IDENTICAL worker debrief on every
  // call must escalate the job via the duplicate-hash (cycle-registry) path
  // instead of spinning forever. The verifier returns FAILED so the worker is
  // re-dispatched, which is what trips the collision path. Dispatcher is
  // instant (latency 0) so the run stays fast.
  console.log('A4 · loop guard — identical-debrief dispatcher escalates, no hang');
  {
    const plan = loadPlan('loop-bomb');
    let calls = 0;
    const loopDispatcher: SubagentDispatcher = async (_id, payload) => {
      calls++;
      if (payload.role === 'VERIFIER') {
        return {
          status: 'FAILED',
          filesModified: [],
          debrief: `still broken: ${payload.missionId}`,
          selfAudit: 'mismatch',
        };
      }
      const ok: SubagentResult = {
        status: 'COMPLETED',
        filesModified: [],
        debrief: `did ${payload.missionId}`,
        selfAudit: 'ok',
      };
      return ok;
    };

    const engine = new OrchestrationEngine(plan, loopDispatcher, { skipTests: true });
    const t0 = Date.now();
    const result = await engine.run();
    const elapsed = Date.now() - t0;

    let escalated = false;
    for (const job of result.jobCard.jobs.values()) {
      if (job.status === 'ESCALATED') escalated = true;
    }
    assert(escalated, 'identical-debrief dispatcher escalates the job (loop guard fired)');
    assert(
      calls > 0 && calls <= 8,
      `dispatcher terminated after bounded calls (calls=${calls}) — no infinite loop`,
    );
    assert(elapsed < 2000, `loop guard terminated fast (${elapsed}ms) — did not block`);
  }

  // ---------------------------------------------------------------------- A5
  // assertScopeBoundary guard: out-of-scope access throws; the scope===scope
  // tautology is explicitly NOT a guard and must return OK.
  console.log('A5 · assertScopeBoundary guard');
  {
    let blocked = false;
    try {
      assertScopeBoundary('/evil/file', '/scope', 'agent-x');
    } catch {
      blocked = true;
    }
    assert(blocked, 'assertScopeBoundary blocks out-of-scope path');

    let allowed = false;
    try {
      assertScopeBoundary('/scope', '/scope', 'agent-x');
    } catch {
      allowed = true;
    }
    assert(!allowed, 'assertScopeBoundary tautology (scope===scope) returns OK / no-throw');
  }

  console.log('PASS');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});

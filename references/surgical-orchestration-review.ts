/**
 * Code Reviewer + Composer layer (post-build strategic review).
 *
 * Runs AFTER the Worker/Verifier loop marks every folder VERIFIED. It does not
 * re-verify edits — it performs a separate strategic pass:
 *
 *   1. StandardCodeReviewer.classify() buckets every changed file as FRONTEND,
 *      BACKEND, or AMBIGUOUS (AMBIGUOUS goes to BOTH lanes so nothing escapes).
 *   2. CodeReviewLayer fans out one FRONTEND_REVIEWER and one BACKEND_REVIEWER,
 *      each returning a summarised debrief plus its own recommendations/suggestions.
 *   3. The Composer receives ALL subagent findings and SELECTS exactly
 *      2 recommendations + 2 suggestions — it is a reducer, never a generator.
 *
 * The review dispatch is injectable (same pattern as SubagentDispatcher): a host
 * supplies a `ReviewDispatcher` that runs the actual reviewer subagents. With no
 * dispatcher the layer still classifies files and applies a deterministic
 * in-process Composer, so `--review` is fully testable without spending agents.
 */

import type { SubagentResult } from './orchestrator.js';

export type Lane = 'FRONTEND' | 'BACKEND' | 'AMBIGUOUS';

export interface ChangedFile {
  path: string;
}

export interface ReviewTierResult extends SubagentResult {
  lane: Lane;
}

/**
 * Buckets a single changed file path into a review lane.
 *
 * Heuristics MUST cover both mid-path (`/components/`) and path-start
 * (`components/`) forms — a regex anchored to `/convex/` missed real-world paths
 * like `convex/payments.ts` (no leading slash) and let them fall through to
 * AMBIGUOUS, escaping the BACKEND lane. The unit test is the gate, not the regex.
 */
export function defaultClassifyFile(p: string): Lane {
  const lower = p.toLowerCase();
  const isFrontend =
    /\.(tsx|jsx|vue|svelte|css|html|scss|sass|less)$/.test(lower) ||
    /(^|\/)components(\/|$)/.test(lower) ||
    /(^|\/)ui(\/|$)/.test(lower) ||
    /(^|\/)frontend(\/|$)/.test(lower);
  const isBackend =
    /\.(py|go|rs|java|rb|php|sql|prisma|c|cpp|cs)$/.test(lower) ||
    /(^|\/)api(\/|$)/.test(lower) ||
    /(^|\/)server(\/|$)/.test(lower) ||
    /(^|\/)backend(\/|$)/.test(lower) ||
    /(^|\/)services(\/|$)/.test(lower) ||
    /^convex\//.test(lower) ||
    /(^|\/)convex(\/|$)/.test(lower);
  if (isFrontend && isBackend) return 'AMBIGUOUS';
  if (isFrontend) return 'FRONTEND';
  if (isBackend) return 'BACKEND';
  return 'AMBIGUOUS';
}

export class StandardCodeReviewer {
  /** Classify every changed file; AMBIGUOUS files are returned twice (both lanes). */
  static classify(files: ChangedFile[]): Map<Lane, ChangedFile[]> {
    const out: Map<Lane, ChangedFile[]> = new Map([
      ['FRONTEND', []],
      ['BACKEND', []],
      ['AMBIGUOUS', []],
    ]);
    for (const f of files) {
      const lane = defaultClassifyFile(f.path);
      out.get(lane)!.push(f);
      // AMBIGUOUS is sent to BOTH reviewers so it is reviewed in each lane.
      if (lane === 'AMBIGUOUS') {
        out.get('FRONTEND')!.push(f);
        out.get('BACKEND')!.push(f);
      }
    }
    return out;
  }
}

/** Injectable reviewer runtime. A host runs FRONTEND/BACKEND reviewers via this. */
export type ReviewDispatcher = (
  lane: Lane,
  files: ChangedFile[],
) => Promise<ReviewTierResult>;

const DEFAULT_RECOMMENDATIONS = [
  'Frontend: verify component accessibility and responsive layout before merge.',
  'Backend: validate input-shape and error-path coverage; avoid silent catch blocks.',
];
const DEFAULT_SUGGESTIONS = [
  'Frontend: prefer CSS custom properties over hard-coded colors for theme consistency.',
  'Backend: add integration tests for the touched boundary; unit coverage alone is not enough.',
];

const defaultReviewDispatcher: ReviewDispatcher = async (lane, files) => {
  // Deterministic in-process fallback: returns bounded advice so the Composer
  // can always select exactly 2 recommendations + 2 suggestions without a live
  // subagent. It does NOT invent lane-specific advice beyond the shared defaults;
  // it simply makes the dry-run/test path deterministic.
  return {
    status: 'COMPLETED',
    filesModified: files.map((f) => f.path),
    debrief: `[DRY-REVIEW ${lane}] reviewed ${files.length} file(s); dry dispatcher active.`,
    selfAudit: 'Dry review — returns bounded default advice for deterministic Composer selection.',
    lane,
    recommendations: DEFAULT_RECOMMENDATIONS,
    suggestions: DEFAULT_SUGGESTIONS,
  };
};

export interface ComposerVerdict {
  recommendations: string[];
  suggestions: string[];
}

/**
 * The Composer is a SELECTOR, not a GENERATOR. It takes all collected
 * recommendations/suggestions and surfaces exactly 2 + 2. Encoding it as
 * candidates.slice(0, 2) keeps the verdict bounded for the human reader and
 * makes the "exactly 2" contract enforceable rather than aspirational.
 */
export function compose(
  frontend: ReviewTierResult,
  backend: ReviewTierResult,
): ComposerVerdict {
  const recs = [...(frontend.recommendations ?? []), ...(backend.recommendations ?? [])];
  const sugg = [...(frontend.suggestions ?? []), ...(backend.suggestions ?? [])];
  return {
    recommendations: recs.slice(0, 2),
    suggestions: sugg.slice(0, 2),
  };
}

export interface CodeReviewLayerResult {
  lanes: Map<Lane, ChangedFile[]>;
  frontend: ReviewTierResult;
  backend: ReviewTierResult;
  verdict: ComposerVerdict;
}

export class CodeReviewLayer {
  private dispatch: ReviewDispatcher;

  constructor(dispatch?: ReviewDispatcher) {
    this.dispatch = dispatch ?? defaultReviewDispatcher;
  }

  setDispatcher(dispatch: ReviewDispatcher): void {
    this.dispatch = dispatch;
  }

  /** Run the full classify → fan-out → compose pipeline. */
  async run(files: ChangedFile[]): Promise<CodeReviewLayerResult> {
    const lanes = StandardCodeReviewer.classify(files);

    const [frontend, backend] = await Promise.all([
      this.dispatch('FRONTEND', lanes.get('FRONTEND') ?? []),
      this.dispatch('BACKEND', lanes.get('BACKEND') ?? []),
    ]);

    const verdict = compose(frontend, backend);
    return { lanes, frontend, backend, verdict };
  }
}

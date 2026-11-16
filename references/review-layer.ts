import { defaultClassifyFile, type FileLane } from './classifier.js';
import type { BuildPlan, SubagentDispatcher, SubagentResult } from './types.js';

export type { FileLane } from './classifier.js';

export interface ClassifiedFile {
  filePath: string;
  lane: FileLane;
}

export interface ReviewerSummary {
  role: 'FRONTEND_REVIEWER' | 'BACKEND_REVIEWER';
  lane: FileLane;
  filesReviewed: string[];
  summary: string;
  recommendations: string[];
  suggestions: string[];
}

export interface CodeReviewOutcome {
  classification: ClassifiedFile[];
  reviewerSummaries: ReviewerSummary[];
  recommendations: string[];
  suggestions: string[];
}

export interface ComposerVerdict {
  recommendations: string[];
  suggestions: string[];
}

export interface CodeReviewLayer {
  classify(): Map<string, FileLane>;
  run(): Promise<CodeReviewOutcome>;
}

/**
 * Pure reducer enforcing the Composer's "select exactly 2+2" contract across
 * specialised reviewer results.
 */
export function compose(
  frontend: Pick<SubagentResult, 'recommendations' | 'suggestions'>,
  backend: Pick<SubagentResult, 'recommendations' | 'suggestions'>,
): ComposerVerdict {
  const recs = [...(frontend.recommendations ?? []), ...(backend.recommendations ?? [])];
  const sugg = [...(frontend.suggestions ?? []), ...(backend.suggestions ?? [])];
  return {
    recommendations: recs.slice(0, 2),
    suggestions: sugg.slice(0, 2),
  };
}

/**
 * Classifies build-plan changes into FRONTEND, BACKEND, or AMBIGUOUS lanes,
 * dispatches specialised reviewers concurrently, and forwards bounded findings.
 */
export class StandardCodeReviewer implements CodeReviewLayer {
  private plan: BuildPlan;
  private dispatch: SubagentDispatcher;
  private classifyFn: (filePath: string) => FileLane;

  constructor(
    plan: BuildPlan,
    dispatch: SubagentDispatcher,
    classify?: (filePath: string) => FileLane,
  ) {
    this.plan = plan;
    this.dispatch = dispatch;
    this.classifyFn = classify ?? defaultClassifyFile;
  }

  classify(): Map<string, FileLane> {
    const out = new Map<string, FileLane>();
    for (const change of this.plan.changes) {
      out.set(change.filePath, this.classifyFn(change.filePath));
    }
    return out;
  }

  private async dispatchReviewer(
    role: 'FRONTEND_REVIEWER' | 'BACKEND_REVIEWER',
    lane: FileLane,
    files: string[],
  ): Promise<ReviewerSummary> {
    const result = await this.dispatch(`reviewer-${role}`, {
      missionId: `REVIEW-${role}`,
      role,
      allowedFolderScope: '.',
      instructions:
        `## ${role} Mission\n` +
        `Lane: ${lane}\n` +
        `Files to review (${files.length}):\n${files.map((f) => `- ${f}`).join('\n')}\n\n` +
        'Inspect correctness, boundary safety, error handling, and test evidence.\n' +
        'Return JSON: { status, files_modified, debrief, self_audit, recommendations:[..], suggestions:[..] }.\n' +
        'Provide up to 2 concrete recommendations and 2 suggestions for the Code Reviewer.',
      contextSummary: `Reviewing ${lane} lane; ${files.length} files.`,
    });

    return {
      role,
      lane,
      filesReviewed: files,
      summary: result.debrief,
      recommendations: result.recommendations?.slice(0, 2) ?? [],
      suggestions: result.suggestions?.slice(0, 2) ?? [],
    };
  }

  async run(): Promise<CodeReviewOutcome> {
    const classification = this.classify();
    const frontend = [...classification.entries()]
      .filter(([, lane]) => lane !== 'BACKEND')
      .map(([filePath]) => filePath);
    const backend = [...classification.entries()]
      .filter(([, lane]) => lane !== 'FRONTEND')
      .map(([filePath]) => filePath);

    const tasks: Array<Promise<ReviewerSummary>> = [];
    if (frontend.length > 0) {
      tasks.push(this.dispatchReviewer('FRONTEND_REVIEWER', 'FRONTEND', frontend));
    }
    if (backend.length > 0) {
      tasks.push(this.dispatchReviewer('BACKEND_REVIEWER', 'BACKEND', backend));
    }

    const reviewerSummaries = tasks.length > 0 ? await Promise.all(tasks) : [];
    const allRecommendations = reviewerSummaries.flatMap((r) => r.recommendations);
    const allSuggestions = reviewerSummaries.flatMap((r) => r.suggestions);

    return {
      classification: [...classification.entries()].map(([filePath, lane]) => ({ filePath, lane })),
      reviewerSummaries,
      recommendations: allRecommendations.slice(0, 2),
      suggestions: allSuggestions.slice(0, 2),
    };
  }
}

/**
 * Selects the top 2 recommendations and top 2 suggestions surfaced by the Code
 * Reviewer without inventing uncollected findings.
 */
export class Composer {
  compose(outcome: CodeReviewOutcome, _plan: BuildPlan): ComposerVerdict {
    return {
      recommendations: outcome.recommendations.slice(0, 2),
      suggestions: outcome.suggestions.slice(0, 2),
    };
  }
}

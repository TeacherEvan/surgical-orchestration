import type { SubagentDispatcher, SubagentResult } from './types.js';

type DelegateTaskFn = (args: {
  goal: string;
  context: string;
  role: 'leaf' | 'orchestrator';
}) => Promise<Array<{ summary: string }>>;

function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => String(item));
}

/**
 * Parses a subagent's final JSON debrief, preserving `recommendations` and
 * `suggestions` for up-chain Code Reviewer / Composer aggregation.
 */
export function parseSubagentResult(summary: string): SubagentResult {
  const failed = (reason: string): SubagentResult => ({
    status: 'FAILED',
    filesModified: [],
    debrief: reason,
    selfAudit: 'Unparseable subagent output; treated as failure by the orchestrator.',
  });

  const fenced = summary.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? summary).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) {
    return failed('Subagent returned no JSON object.');
  }

  let parsedUnknown: unknown;
  try {
    parsedUnknown = JSON.parse(candidate.slice(start, end + 1));
  } catch (err) {
    return failed(`Subagent JSON did not parse: ${(err as Error).message}`);
  }

  if (!parsedUnknown || typeof parsedUnknown !== 'object' || Array.isArray(parsedUnknown)) {
    return failed('Subagent JSON root must be an object.');
  }

  const parsed = parsedUnknown as Record<string, unknown>;
  const status = parsed.status === 'COMPLETED' ? 'COMPLETED' : 'FAILED';
  const rawFiles = parsed.files_modified ?? parsed.filesModified;
  const recommendations = parseStringArray(parsed.recommendations);
  const suggestions = parseStringArray(parsed.suggestions);

  return {
    status,
    filesModified: Array.isArray(rawFiles) ? rawFiles.map(String) : [],
    debrief: String(parsed.debrief ?? ''),
    selfAudit: String(parsed.self_audit ?? parsed.selfAudit ?? ''),
    ...(recommendations !== undefined ? { recommendations } : {}),
    ...(suggestions !== undefined ? { suggestions } : {}),
  };
}

/**
 * Dispatcher backed by the Hermes `delegate_task` tool.
 * Honors AbortSignal and fails loudly if `delegate_task` is unavailable.
 */
export const hermesDispatcher: SubagentDispatcher = async (agentId, payload, signal) => {
  if (signal?.aborted) {
    throw new Error(`[ABORTED] Subagent '${agentId}' cancelled before delegate_task.`);
  }

  const delegateTask = (globalThis as { delegate_task?: DelegateTaskFn }).delegate_task;
  if (typeof delegateTask !== 'function') {
    throw new Error(
      `[NO_HERMES_RUNTIME] delegate_task is unavailable for '${agentId}'. ` +
        'Run this orchestrator inside a Hermes agent session, or pass --dry-run.',
    );
  }

  const results = await delegateTask({
    goal: payload.instructions,
    context: [
      `Mission: ${payload.missionId}`,
      `Role: ${payload.role}`,
      `Scope (do not touch anything outside this folder): ${payload.allowedFolderScope}`,
      `Ledger: ${payload.contextSummary}`,
    ].join('\n'),
    role: 'leaf',
  });

  if (signal?.aborted) {
    throw new Error(`[ABORTED] Subagent '${agentId}' cancelled after delegate_task.`);
  }

  return parseSubagentResult(results[0]?.summary ?? '');
};

/**
 * Offline dispatcher for `--dry-run` and `--review`, emitting unique mission
 * debriefs and deterministic reviewer recommendations/suggestions.
 */
export const dryRunDispatcher: SubagentDispatcher = async (agentId, payload) => {
  console.log(`[DRY-RUN] ${payload.role} ${payload.missionId} -> ${payload.allowedFolderScope}`);
  const isReviewer =
    payload.role === 'FRONTEND_REVIEWER' ||
    payload.role === 'BACKEND_REVIEWER' ||
    payload.role === 'CODE_REVIEWER';

  if (isReviewer) {
    return {
      status: 'COMPLETED',
      filesModified: [],
      debrief: `DRY RUN: no edits made for ${payload.missionId} (${agentId}).`,
      selfAudit: 'Dry review — deterministic recommendations emitted for Composer verification.',
      recommendations: [
        `[${payload.role}] Verify boundary assertions and error handling on touched paths.`,
        `[${payload.role}] Confirm automated tests exercise modified contracts end-to-end.`,
      ],
      suggestions: [
        `[${payload.role}] Keep module responsibilities cohesive and under 250 lines.`,
        `[${payload.role}] Document non-obvious invariants alongside regression tests.`,
      ],
    };
  }

  return {
    status: 'COMPLETED',
    filesModified: [],
    debrief: `DRY RUN: no edits made for ${payload.missionId} (${agentId}).`,
    selfAudit: 'Dry run — no work attempted, no claim of correctness.',
  };
};

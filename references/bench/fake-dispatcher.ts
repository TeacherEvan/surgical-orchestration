import type { SubagentDispatcher, SubagentResult } from '../orchestrator.js';

/**
 * Latency-injectable, accuracy-toggleable fake dispatcher for the
 * orchestration benchmark. Mirrors the real `SubagentDispatcher` contract so it
 * can be injected into `OrchestrationEngine` / `StandardCodeReviewer` and
 * produce fully deterministic, reproducible runs.
 */
export function makeFakeDispatcher(opts: { latencyMs: number; accurate: boolean }): SubagentDispatcher {
  return async (_id, payload) => {
    if (opts.latencyMs) await new Promise((r) => setTimeout(r, opts.latencyMs));
    const ok: SubagentResult = {
      status: 'COMPLETED',
      filesModified: [],
      debrief: `did ${payload.missionId}`,
      selfAudit: 'ok',
      recommendations: opts.accurate ? ['rec A', 'rec B', 'rec C'] : [],
      suggestions: opts.accurate ? ['sug A', 'sug B', 'sug C'] : [],
    };
    return ok;
  };
}

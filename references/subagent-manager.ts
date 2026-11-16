import { EventEmitter } from 'node:events';
import { resolveRealPath } from './security.js';
import {
  ORCHESTRATOR_CONFIG,
  type AgentRole,
  type JobCard,
  type SubagentDispatcher,
  type SubagentPayload,
  type SubagentResult,
} from './types.js';

const defaultDispatcher: SubagentDispatcher = async (agentId) => {
  throw new Error(
    `[NO_DISPATCHER] Subagent runtime not configured for '${agentId}'. ` +
      'Pass a SubagentDispatcher to the OrchestrationEngine/SubagentManager constructor.',
  );
};

export interface SubagentManagerOptions {
  maxConcurrency?: number;
  timeoutMs?: number;
}

/**
 * Manages subagent lifecycle, concurrency slots, scope validation, and
 * AbortSignal-backed timeout cancellation.
 */
export class SubagentManager extends EventEmitter {
  private activeAgents: Map<string, { role: AgentRole; startTime: number }> = new Map();
  private jobCard: JobCard;
  private dispatch: SubagentDispatcher;
  private maxConcurrency: number;
  private timeoutMs: number;

  constructor(jobCard: JobCard, dispatch?: SubagentDispatcher, opts?: SubagentManagerOptions) {
    super();
    this.jobCard = jobCard;
    this.dispatch = dispatch ?? defaultDispatcher;
    this.maxConcurrency = Math.max(1, opts?.maxConcurrency ?? ORCHESTRATOR_CONFIG.MAX_CONCURRENCY);
    this.timeoutMs = Math.max(1, opts?.timeoutMs ?? ORCHESTRATOR_CONFIG.SUBAGENT_TIMEOUT_MS);
  }

  setDispatcher(dispatch: SubagentDispatcher): void {
    this.dispatch = dispatch;
  }

  getActiveCount(): number {
    return this.activeAgents.size;
  }

  getMaxConcurrency(): number {
    return this.maxConcurrency;
  }

  getJobCard(): JobCard {
    return this.jobCard;
  }

  canSpawn(): boolean {
    return this.getActiveCount() < this.maxConcurrency;
  }

  /**
   * Validates scope & capacity BEFORE reserving a concurrency slot, threads an
   * AbortSignal into the dispatcher, and releases the slot inside try/finally.
   */
  async spawnSubagent(payload: SubagentPayload, externalSignal?: AbortSignal): Promise<SubagentResult> {
    if (
      typeof payload.allowedFolderScope !== 'string' ||
      payload.allowedFolderScope.trim() === '' ||
      payload.allowedFolderScope.includes('\0')
    ) {
      throw new Error(
        `[SCOPE_INVALID] Subagent '${payload.missionId}' has invalid allowedFolderScope; refusing to dispatch.`,
      );
    }

    // Fail closed on dangling symlinks or unresolvable scope paths before consuming a slot.
    resolveRealPath(payload.allowedFolderScope);

    if (externalSignal?.aborted) {
      throw new Error(`[ABORTED] Subagent '${payload.missionId}' aborted before dispatch.`);
    }

    if (!this.canSpawn()) {
      throw new Error('Max concurrency reached. Cannot spawn subagent.');
    }

    const agentId = `agent-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    this.activeAgents.set(agentId, { role: payload.role, startTime: Date.now() });

    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let onExternalAbort: (() => void) | undefined;

    const deadline = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        const timeoutErr = new Error(
          `[TIMEOUT] Subagent '${agentId}' exceeded ${this.timeoutMs}ms.`,
        );
        controller.abort(timeoutErr);
        this.emit('agent_timeout', agentId);
        this.terminateAgent(agentId, 'TIMEOUT');
        reject(timeoutErr);
      }, this.timeoutMs);

      if (externalSignal) {
        onExternalAbort = () => {
          const abortErr = new Error(`[ABORTED] Subagent '${agentId}' cancelled by caller signal.`);
          controller.abort(abortErr);
          this.terminateAgent(agentId, 'ABORTED');
          reject(abortErr);
        };
        externalSignal.addEventListener('abort', onExternalAbort, { once: true });
      }
    });

    try {
      this.emit('spawn_requested', { agentId, payload });
      const raw = await Promise.race([
        this.dispatch(agentId, payload, controller.signal),
        deadline,
      ]);
      const result: SubagentResult = {
        ...raw,
        status: raw.status === 'COMPLETED' ? 'COMPLETED' : 'FAILED',
      };
      this.emit('agent_completed', { agentId, result });
      return result;
    } catch (error) {
      this.emit('agent_error', { agentId, error });
      throw error;
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      if (externalSignal && onExternalAbort) {
        externalSignal.removeEventListener('abort', onExternalAbort);
      }
      this.activeAgents.delete(agentId);
    }
  }

  private terminateAgent(agentId: string, reason: string): void {
    this.activeAgents.delete(agentId);
    this.emit('agent_terminated', { agentId, reason });
  }
}

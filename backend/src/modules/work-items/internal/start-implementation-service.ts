/**
 * WORK-026 (PR #29 correction) → WORK-027 refactor:
 * DefaultStartImplementationService.
 *
 * Wires the persisted ImplementationContext to the native execution path so
 * that `POST /work-items/:workItemId/start-implementation` actually starts an
 * AgentRun — there is NO production no-op path.
 *
 * WORK-027 REFACTOR: the service no longer calls the AgentGateway directly.
 * Native gateway execution now lives in exactly ONE place —
 * /agents internal NativeExecutionProvider — behind the provider-independent
 * ExecutionService boundary. The flow is:
 *
 *   route → startImplementationService.start()
 *             → ExecutionTaskService.build()   (loads WI + WO + reuses the
 *                                             route-built context, generates
 *                                             the deterministic prompt)
 *             → ExecutionService.submit()      (creates the execution record,
 *                                             dispatches NativeExecutionProvider
 *                                             → AgentGateway, audits)
 *
 * Behavior is preserved byte-for-byte from the caller's perspective:
 *   - the agent input is the JSON of the persisted ImplementationContextContent,
 *   - an AgentRun is created + finalized by the AgentGateway,
 *   - a gateway failure propagates (the route returns 502) with NO fake
 *     successful AgentRun,
 *   - the response carries { agentRunId, executionId }.
 *
 * As a WORK-027 bonus, every start-implementation now ALSO creates a native
 * execution record (benchmark foundation).
 *
 * The service does NOT mutate workflow state — that remains /workflows'
 * authority.
 */
import type { Logger } from '@platform/logger.js';
import type { ExecutionService } from '@modules/agents/index.js';
import type { ExecutionTaskService } from './execution-task-service.js';

export interface StartImplementationDeps {
  /** Builds the ExecutionTask from authoritative data (same module). */
  executionTaskService: ExecutionTaskService;
  /** Submits through the provider boundary (/agents public interface). */
  executionService: ExecutionService;
  logger: Logger;
}

export interface StartImplementationInput {
  workItemId: string;
  implementationContextId: string;
  implementationContextRevision: number;
  implementationContextKind: 'initial' | 'correction';
  executionId: string;
  /** Validated provider+model (the route validates against AgentProviderRegistry). */
  provider: string;
  model: string;
}

export interface StartImplementationResult {
  agentRunId: string;
  executionId: string;
}

export class DefaultStartImplementationService {
  constructor(private readonly deps: StartImplementationDeps) {}

  async start(input: StartImplementationInput): Promise<StartImplementationResult> {
    // 1. Build the ExecutionTask — reuses the ImplementationContext the route
    //    already built + persisted (no double revision bump). Throws the
    //    same coded errors as before when the Work Item / Work Order /
    //    context are missing.
    const built = await this.deps.executionTaskService.build({
      workItemId: input.workItemId,
      mode: 'native',
      provider: input.provider,
      model: input.model,
      executionId: input.executionId,
      implementationContextId: input.implementationContextId,
    });

    // 2. Submit through the provider boundary. For native mode this reaches
    //    the NativeExecutionProvider → AgentGateway (the unchanged native
    //    execution authority). Any gateway failure propagates — the route
    //    returns a failure response and NO fake AgentRun is recorded.
    const result = await this.deps.executionService.submit(built.task);

    if (!result.agentRunId) {
      // Native submissions must carry the persisted AgentRun id. Reaching
      // this branch means a provider returned success without an AgentRun —
      // fail loudly rather than fabricate one.
      throw new Error(
        `start-implementation-agent-run-not-persisted: executionId ${input.executionId} completed without an AgentRun`,
      );
    }

    if (built.implementationContext.id !== input.implementationContextId) {
      this.deps.logger.warn('start-implementation.context-mismatch', {
        expected: input.implementationContextId,
        actual: built.implementationContext.id,
      });
    }

    return { agentRunId: result.agentRunId, executionId: result.executionId };
  }
}

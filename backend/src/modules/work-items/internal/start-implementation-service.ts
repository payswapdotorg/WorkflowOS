/**
 * WORK-026 (PR #29 correction): DefaultStartImplementationService.
 *
 * Wires the persisted ImplementationContext to the AgentGateway so that
 * `POST /work-items/:workItemId/start-implementation` actually starts an
 * AgentRun — there is NO production no-op path.
 *
 * Owned by /work-items (it consumes the Work Item + Work Order + the
 * ImplementationContext that /work-items built). It calls the /agents
 * AgentGateway through its PUBLIC interface — it never reaches into
 * /agents internal/.
 *
 * Flow:
 *   1. Load the Work Item + latest Work Order (for scope/constraints/refs).
 *   2. Resolve the provider + model (from the caller — the route validates
 *      these against the AgentProviderRegistry before calling).
 *   3. Construct the AgentRequest.input from the persisted
 *      ImplementationContextContent (the agent receives the full context).
 *   4. Create the AgentRun row (status=pending) via AgentRunRepository.
 *   5. Call AgentGateway.execute() (which delegates to the registered
 *      AgentProviderAdapter).
 *   6. On success: updateSuccess() (status=success, commitRef/PR recorded).
 *      On failure: updateFailed() (status=failed, error recorded). The
 *      service does NOT swallow the error — it propagates to the route,
 *      which returns a failure response. No fake successful AgentRun.
 *   7. Return { agentRunId, executionId }.
 *
 * The service does NOT mutate workflow state — that remains /workflows'
 * authority. The existing WorkflowOrchestrator/convergence picks up the
 * AgentRun via its own polling / signal path.
 */
import type { Logger } from '@platform/logger.js';
import type { AgentGateway, AgentRunRepository } from '@modules/agents/index.js';
import type {
  WorkItemRepository,
  WorkOrderRepository,
} from './work-item.types.js';
import type {
  ImplementationContextRepository,
} from './implementation-context.types.js';

export interface StartImplementationDeps {
  agentGateway: AgentGateway;
  agentRunRepository: AgentRunRepository;
  workItemRepository: WorkItemRepository;
  workOrderRepository: WorkOrderRepository;
  contextRepository: ImplementationContextRepository;
  logger: Logger;
}

/**
 * Subset of DefaultAgentGateway's internals that the service needs to look up
 * the persisted AgentRun by executionId after the gateway creates it. The
 * AgentGateway.create() call is what persists the AgentRun row (NOT this
 * service — the gateway owns the AgentRun lifecycle).
 */
export interface AgentRunLookup {
  findByExecutionId(executionId: string): Promise<{ id: string; status: string; executionId: string } | null>;
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
    const { agentGateway, agentRunRepository, workItemRepository, workOrderRepository, contextRepository, logger } = this.deps;

    // 1. Load the Work Item — if it doesn't exist, this is a real error.
    const workItem = await workItemRepository.findById(input.workItemId);
    if (!workItem) {
      throw new Error(`start-implementation-work-item-not-found: ${input.workItemId}`);
    }

    // 2. Load the latest Work Order for the Work Item. The AgentRun table
    //    has a NOT NULL FK on work_order_id, so we require one to exist.
    const workOrders = await workOrderRepository.listForWorkItem(input.workItemId);
    const workOrder = workOrders.length > 0 ? workOrders[workOrders.length - 1]! : null;
    if (!workOrder) {
      throw new Error(
        `start-implementation-work-order-not-found: work item ${input.workItemId} has no Work Order. ` +
          'Generate a Work Order before starting implementation.',
      );
    }

    // 3. Load the persisted ImplementationContextContent.
    const ctx = await contextRepository.findById(input.implementationContextId);
    if (!ctx) {
      throw new Error(`start-implementation-context-not-found: ${input.implementationContextId}`);
    }

    // 4. Construct the agent input from the context. The agent receives the
    //    full ImplementationContextContent as JSON — it contains the objective,
    //    scope, requirements, criteria, dependencies, repository, prior runs,
    //    prior review findings, and instructions.
    const inputText = JSON.stringify(ctx.content, null, 2);

    // 5. Call the AgentGateway. The gateway creates the AgentRun row
    //    (status=pending) internally + updates it with the result. If the
    //    gateway rejects, it propagates — the route returns a failure
    //    response, the AgentRun is marked as 'failed' (NOT a fake success),
    //    and the workflow state is unchanged.
    const result = await agentGateway.execute({
      provider: input.provider,
      configuration: { model: input.model },
      workItemId: input.workItemId,
      workOrderId: workOrder.id,
      architectureVersionId: workItem.architectureVersionId,
      executionId: input.executionId,
      repositoryRef: ctx.content.repository?.owner && ctx.content.repository?.repository
        ? `${ctx.content.repository.owner}/${ctx.content.repository.repository}`
        : undefined,
      branch: ctx.content.repository?.implementationBranch ?? undefined,
      scope: ctx.content.scope ?? undefined,
      input: inputText,
      metadata: {
        implementationContextId: input.implementationContextId,
        implementationContextRevision: input.implementationContextRevision,
        kind: input.implementationContextKind,
      },
    });

    // 6. The gateway persisted the AgentRun. Look it up by executionId to
    //    return the agentRunId to the caller.
    const run = await agentRunRepository.findByExecutionId(input.executionId);
    if (!run) {
      // Should never happen — the gateway just created it. But if it does,
      // that's a real error, NOT a silent success.
      throw new Error(
        `start-implementation-agent-run-not-persisted: executionId ${input.executionId} did not produce an AgentRun row`,
      );
    }

    if (result.status === 'success') {
      logger.info('start-implementation.agent-run-success', {
        executionId: input.executionId,
        agentRunId: run.id,
        commitRef: result.commitRef,
        pullRequestRef: result.pullRequestRef,
      });
    } else {
      // result.error is non-null when status !== 'success'.
      const err = result.error!;
      logger.warn('start-implementation.agent-run-failed', {
        executionId: input.executionId,
        agentRunId: run.id,
        errorType: err.type,
        errorMessage: err.message,
      });
      // Propagate the failure — the route returns a failure response.
      // There is NO fake successful AgentRun.
      throw new Error(`start-implementation-agent-failed: ${err.type}: ${err.message}`);
    }

    return { agentRunId: run.id, executionId: input.executionId };
  }
}

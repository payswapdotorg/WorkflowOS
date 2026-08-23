/**
 * WORK-027: NativeExecutionProvider.
 *
 * Adapts the EXISTING native AgentGateway execution behind the provider-
 * independent ExecutionProvider abstraction. This is the ONLY place (besides
 * the /workflows orchestrator, which owns its own submission path) that turns
 * an ExecutionTask into an AgentRun — there is NO second AgentGateway and no
 * duplicated execution pathway.
 *
 * Conceptually:
 *
 *   ExecutionService → ExecutionProvider (native) → NativeExecutionProvider
 *                                                        ↓
 *                                                  AgentGateway (unchanged)
 *
 * Behavior contract (identical to the pre-WORK-027 start-implementation
 * service — existing AgentRun behavior must continue working):
 *   1. Builds the AgentRequest from the ExecutionTask. `input` is the
 *      contextPayload (JSON of the persisted ImplementationContextContent) —
 *      byte-for-byte the same agent input as before WORK-027.
 *   2. Calls AgentGateway.execute() (which creates + finalizes the AgentRun
 *      row, including retries).
 *   3. Looks up the persisted AgentRun by executionId and verifies the run
 *      actually succeeded. A gateway failure propagates — no fake success.
 *
 * This file is private to /agents (PLAT-AC-02).
 */
import type { Logger } from '@platform/logger.js';
import type {
  ExecutionProvider,
  ExecutionSubmission,
  ExecutionTask,
} from './execution.types.js';
import type { AgentGateway, AgentRunRepository } from './agent.types.js';

export interface NativeExecutionProviderDeps {
  readonly agentGateway: AgentGateway;
  readonly agentRunRepository: AgentRunRepository;
  readonly logger: Logger;
}

export class NativeExecutionProvider implements ExecutionProvider {
  readonly name = 'native';
  readonly mode = 'native' as const;

  constructor(private readonly deps: NativeExecutionProviderDeps) {}

  async submit(task: ExecutionTask): Promise<ExecutionSubmission> {
    if (!task.model) {
      throw new Error(
        `native-execution-model-required: execution ${task.executionId} has no model. ` +
          'Native execution requires a validated provider + model.',
      );
    }

    const repositoryRef =
      task.repositoryOwner && task.repositoryName
        ? `${task.repositoryOwner}/${task.repositoryName}`
        : undefined;

    // 1-2. Delegate to the AgentGateway — the single native execution
    //     authority. The gateway creates the AgentRun row and finalizes it.
    const result = await this.deps.agentGateway.execute({
      provider: task.provider,
      configuration: { model: task.model },
      workItemId: task.workItemId,
      workOrderId: task.workOrderId,
      architectureVersionId: task.architectureVersionId ?? undefined,
      executionId: task.executionId,
      repositoryRef,
      branch: task.implementationBranch ?? undefined,
      scope: task.scope ?? undefined,
      input: task.contextPayload,
      metadata: {
        executionMode: 'native',
        implementationContextId: task.implementationContextId,
        implementationContextRevision: task.implementationContextRevision,
        implementationContextKind: task.implementationContextKind,
        promptDigest: task.promptDigest,
      },
    });

    // 3. The gateway persisted the AgentRun — look it up to return the id.
    const run = await this.deps.agentRunRepository.findByExecutionId(task.executionId);
    if (!run) {
      // Should never happen — the gateway just created it. Fail loudly.
      throw new Error(
        `native-execution-agent-run-not-persisted: executionId ${task.executionId} did not produce an AgentRun row`,
      );
    }

    if (result.status !== 'success') {
      const err = result.error;
      this.deps.logger.warn('execution.native.agent-run-failed', {
        executionId: task.executionId,
        agentRunId: run.id,
        errorType: err?.type,
        errorMessage: err?.message,
      });
      // Propagate the failure — the caller returns a failure response. There
      // is NO fake successful AgentRun.
      throw new Error(
        `native-execution-agent-failed: ${err?.type ?? 'unknown'}: ${err?.message ?? 'no error detail'}`,
      );
    }

    this.deps.logger.info('execution.native.agent-run-success', {
      executionId: task.executionId,
      agentRunId: run.id,
      commitRef: result.commitRef,
      pullRequestRef: result.pullRequestRef,
    });

    return {
      executionId: task.executionId,
      provider: task.provider,
      mode: 'native',
      status: 'completed',
      agentRunId: run.id,
      commitRef: result.commitRef,
      pullRequestRef: result.pullRequestRef,
      startedAt: result.startedAt,
      completedAt: result.completedAt,
    };
  }
}

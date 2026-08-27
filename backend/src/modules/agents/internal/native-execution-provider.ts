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
 * PR #46 round 7 (the provider-operation exactly-once boundary — the
 * architect's contract option 1): for a KEYED dispatch (a task carrying a
 * `dispatchIdempotencyKey` — the cross-mode handoff dispatch ALWAYS does),
 * the native provider operation is IDENTIFIED BY THE DURABLE EXECUTION
 * IDENTITY (`wfos_agent_runs.execution_id` is UNIQUE): the operation is the
 * AgentRun creation + the ADAPTER execution, and the gateway invokes the
 * adapter only after its own run-creation succeeded. Therefore:
 *   - a keyed submit whose run ALREADY exists CONVERGES to that run (returns
 *     its submission — NO gateway call, NO second adapter invocation): the
 *     operation already happened under the same identity (an original
 *     owner's in-flight dispatch, a taken-over dispatch, or a crash retry);
 *   - the residual race (two keyed submits both pass the pre-check before
 *     either run-creation commits — one INSERT wins, the loser's create
 *     throws the UNIQUE violation) CONVERGES the loser to the winner's run
 *     instead of propagating a second-operation error;
 *   - a genuinely failed run (status 'failed'/'cancelled') does NOT converge
 *     to success — the failure propagates so the caller's failure handling
 *     records the authoritative failure outcome through the fence.
 * UNKEYED tasks (the mainline one-shot dispatch) keep the exact pre-round-7
 * behavior.
 *
 * PR #46 round 8 (the EXPLICIT DEFINITION the round-8 review requires):
 * `wfos_agent_runs` (migration 0011) IS the DURABLE NATIVE PROVIDER-OPERATION
 * LEDGER:
 *   - the run row IS the native provider operation (the run creation + the
 *     adapter execution);
 *   - `execution_id TEXT NOT NULL UNIQUE` IS the operation-key uniqueness —
 *     the keyed native dispatch derives its operation identity from the
 *     DURABLE EXECUTION IDENTITY, and the UNIQUE constraint is the durable
 *     key→operation mapping (there is structurally ONE run per execution,
 *     hence ONE native provider operation per keyed dispatch);
 *   - the run's status/refs ARE the operation result;
 *   - process-loss recovery is CONVERGE-ON-THE-EXISTING-RUN — a fresh
 *     NativeExecutionProvider INSTANCE (any actor, any process) whose keyed
 *     submit finds the run converges onto it and NEVER reaches the gateway.
 *     The crash boundary around run creation / adapter invocation is
 *     therefore closed by the run row's DURABILITY:
 *       * loss BEFORE the run-creation commits — no run exists; the next
 *         keyed dispatch creates the ONE run (the crashed actor's INSERT
 *         rolled back with its transaction);
 *       * loss AFTER the run-creation commits, before/during the adapter
 *         invocation — the run EXISTS (durable, unique); every later keyed
 *         submit converges on it (ZERO further gateway calls / adapter
 *         invocations; the run row is the operation record whether the
 *         crashed actor's adapter invocation ever ran).
 *
 * This file is private to /agents (PLAT-AC-02).
 */
import type { Logger } from '@platform/logger.js';
import type {
  ExecutionProvider,
  ExecutionSubmission,
  ExecutionTask,
} from './execution.types.js';
import type { AgentGateway, AgentRun, AgentRunRepository } from './agent.types.js';

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

    // PR #46 round 7 (the provider-operation exactly-once boundary): a KEYED
    // dispatch first checks the durable operation identity — if the
    // execution's AgentRun already exists, the provider operation ALREADY
    // happened (the original owner's dispatch is in flight at the gateway,
    // a taken-over dispatch created the run, or this is a crash retry):
    // CONVERGE to that run — NO gateway call, NO second adapter invocation.
    if (task.dispatchIdempotencyKey) {
      const existing = await this.deps.agentRunRepository.findByExecutionId(
        task.executionId,
      );
      if (existing) {
        return this.convergeToRun(task, existing, 'pre-check');
      }
    }

    const repositoryRef =
      task.repositoryOwner && task.repositoryName
        ? `${task.repositoryOwner}/${task.repositoryName}`
        : undefined;

    // 1-2. Delegate to the AgentGateway — the single native execution
    //     authority. The gateway creates the AgentRun row and finalizes it.
    //     PR #46 round 7: wrapped so the residual keyed race (the run-creation
    //     INSERT colliding on the wfos_agent_runs.execution_id UNIQUE with a
    //     concurrent/taken-over dispatch) CONVERGES to the winner's run
    //     instead of propagating a second-operation error.
    let result;
    try {
      result = await this.deps.agentGateway.execute({
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
    } catch (err) {
      // PR #46 round 7 (the provider-operation exactly-once boundary): a
      // keyed dispatch whose gateway call failed re-checks the operation
      // identity — a run that NOW exists and is NOT failed means the provider
      // operation ALREADY happened under the same durable execution identity
      // (our run-creation collided on the wfos_agent_runs.execution_id UNIQUE
      // with a concurrent/taken-over dispatch — our adapter NEVER ran — or
      // the gateway persisted a non-failed run before the error): CONVERGE to
      // it instead of propagating. A FAILED/CANCELLED run means the operation
      // ran and failed — propagate so the caller's failure handling records
      // the authoritative failure outcome through the fence.
      if (task.dispatchIdempotencyKey) {
        const run = await this.deps.agentRunRepository.findByExecutionId(
          task.executionId,
        );
        if (run && run.status !== 'failed' && run.status !== 'cancelled') {
          return this.convergeToRun(task, run, 'collision-recovery');
        }
      }
      throw err;
    }

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

  /**
   * PR #46 round 7: build the CONVERGED submission for an existing AgentRun —
   * the dispatch-level outcome of a keyed dispatch whose provider operation
   * already happened under the same durable execution identity (mirrors the
   * cross-mode service's existing-run converge semantics: a non-failed run
   * means "the run owns the execution" → the dispatch outcome is
   * 'completed' + the run binding; a failed/cancelled run reports 'failed'
   * so the caller records the authoritative failure through the fence).
   */
  private convergeToRun(
    task: ExecutionTask,
    run: AgentRun,
    via: 'pre-check' | 'collision-recovery',
  ): ExecutionSubmission {
    this.deps.logger.info('execution.native.dispatch-converged', {
      executionId: task.executionId,
      agentRunId: run.id,
      runStatus: run.status,
      via,
      dispatchIdempotencyKey: task.dispatchIdempotencyKey,
    });
    const failed = run.status === 'failed' || run.status === 'cancelled';
    return {
      executionId: task.executionId,
      provider: task.provider,
      mode: 'native',
      status: failed ? 'failed' : 'completed',
      agentRunId: run.id,
      startedAt: run.startedAt,
      completedAt: run.completedAt ?? undefined,
    };
  }
}

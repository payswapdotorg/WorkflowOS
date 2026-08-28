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
 * PR #46 round 8 (the EXPLICIT DEFINITION the round-8 review requires) +
 * round 9 (the review's exact wording): AgentRun is the durable native
 * operation ledger — `wfos_agent_runs` (migration 0011) IS the DURABLE NATIVE
 * PROVIDER-OPERATION LEDGER:
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
 *   The native ledger's mechanics are deliberately DIFFERENT from the
 *   external ledger's (PR #46 round 10): the native convergence authority is
 *   the UNIQUE constraint on the durable execution identity +
 *   converge-on-the-existing-run, NOT the external ledger's generation
 *   fencing + resolution CAS + idempotent-submission protocol. Both arms have
 *   a durable operation ledger; they do not share one mechanism.
 *
 * PR #46 round 10 (the NATIVE LIFECYCLE CONVERGENCE correction): EXISTING ≠
 * COMPLETED. `AgentRun.status` is a LIFECYCLE (pending | in_progress | success
 * | failed | cancelled), and the round-9 convergeToRun() mapped every
 * non-failed status to 'completed' — so an existing IN-PROGRESS run was
 * reported as a COMPLETED submission, letting the handoff service converge
 * the dispatch as successful while the underlying run was still executing
 * (and could still later FAIL — the manufactured success would have already
 * converged the handoff). The round-10 correction preserves the AgentRun
 * lifecycle across the convergence boundary:
 *
 *   - an existing run in a TERMINAL state converges directly: success → a
 *     completed submission; failed/cancelled → a failed submission;
 *   - an existing run in a NON-TERMINAL state (pending / in_progress) is
 *     AWAITED — awaitExistingRunTerminal() observes the durable run (polling
 *     the run repository) until it reaches a terminal state — the keyed
 *     submit then returns the TERMINAL outcome ("terminal success/failure of
 *     the existing run is eventually reflected"), NEVER a manufactured
 *     completion;
 *   - a run that stays non-terminal past the await window (a stuck run —
 *     e.g. the driver died mid-adapter and the run row is orphaned) fails
 *     CLOSED with a typed error: the keyed submit NEVER manufactures a
 *     completed outcome from the mere existence of the ledger row, and NEVER
 *     starts a second run (the execution_id UNIQUE is the ledger authority —
 *     there is structurally ONE run per execution).
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
  /**
   * PR #46 round 10: how long a keyed submit awaits an existing
   * NON-TERMINAL AgentRun (pending/in_progress) before failing closed with
   * the typed unresolved-run error. The existing run may genuinely still be
   * executing (the original owner's adapter is alive). Defaults to 60s.
   * Configurable so tests can exercise the await/timeout paths without
   * sleeping.
   */
  readonly existingRunResolutionWindowMs?: number;
  /**
   * PR #46 round 10: the poll interval of the existing-run await loop.
   * Defaults to 100ms.
   */
  readonly existingRunPollIntervalMs?: number;
}

export class NativeExecutionProvider implements ExecutionProvider {
  readonly name = 'native';
  readonly mode = 'native' as const;

  private readonly existingRunResolutionWindowMs: number;
  private readonly existingRunPollIntervalMs: number;

  constructor(private readonly deps: NativeExecutionProviderDeps) {
    this.existingRunResolutionWindowMs =
      deps.existingRunResolutionWindowMs ?? 60_000;
    this.existingRunPollIntervalMs = deps.existingRunPollIntervalMs ?? 100;
  }

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
    // PR #46 round 10: the convergence PRESERVES THE RUN LIFECYCLE — an
    // existing non-terminal run (pending/in_progress) is AWAITED until
    // terminal (never reported as completed), and a stuck run fails closed
    // (see convergeToRun).
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
      // identity — a run that NOW exists means the provider operation
      // ALREADY happened under the same durable execution identity (our
      // run-creation collided on the wfos_agent_runs.execution_id UNIQUE
      // with a concurrent/taken-over dispatch — our adapter NEVER ran — or
      // the gateway persisted the run before the error): CONVERGE to it
      // instead of propagating. PR #46 round 10: the convergence PRESERVES
      // the run lifecycle — a FAILED/CANCELLED run is the operation's
      // terminal failure (propagated by convergeToRun so the caller's
      // failure handling records the authoritative failure outcome through
      // the fence); a NON-TERMINAL run (pending/in_progress — e.g. the
      // winner's adapter still executing, or an orphaned run whose driver
      // died) is AWAITED until terminal, and a stuck run fails closed with
      // the typed unresolved error — NEVER a manufactured completion.
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
    });

    return {
      executionId: task.executionId,
      provider: task.provider,
      mode: 'native',
      status: 'completed',
      agentRunId: run.id,
      commitRef: result.commitRef,
      // PR #52 round 2 (BLOCKER 1): the agent execution contract is
      // PR-incapable — there is no provider-reported PR ref to forward.
      // (An externally observed PR reaches the execution subsystem through
      // the event-ingestion boundary, not through agent execution results.)
      pullRequestRef: null,
      startedAt: result.startedAt,
      completedAt: result.completedAt,
    };
  }

  /**
   * PR #46 round 7 + round 10: build the CONVERGED submission for an existing
   * AgentRun — the dispatch-level outcome of a keyed dispatch whose provider
   * operation already happened under the same durable execution identity.
   *
   * PR #46 round 10 (THE LIFECYCLE CORRECTION — existing ≠ completed): ONLY
   * TERMINAL run statuses map directly — success → a completed submission;
   * failed/cancelled → a failed submission (the caller records the
   * authoritative failure through the fence). A NON-TERMINAL run
   * (pending/in_progress) is AWAITED until terminal
   * ({@link awaitExistingRunTerminal}) — "terminal success/failure of the
   * existing run is eventually reflected" — and a run that stays
   * non-terminal past the await window FAILS CLOSED: this method NEVER
   * manufactures `status: 'completed'` from the mere existence of the ledger
   * row, and the keyed submit NEVER starts a second run.
   */
  private async convergeToRun(
    task: ExecutionTask,
    run: AgentRun,
    via: 'pre-check' | 'collision-recovery',
  ): Promise<ExecutionSubmission> {
    // The lifecycle gate: a non-terminal run is awaited, never reported.
    const terminal =
      run.status === 'success' ||
      run.status === 'failed' ||
      run.status === 'cancelled';
    let converged = run;
    if (!terminal) {
      converged = await this.awaitExistingRunTerminal(task, run, via);
    }
    this.deps.logger.info('execution.native.dispatch-converged', {
      executionId: task.executionId,
      agentRunId: converged.id,
      runStatus: converged.status,
      via,
      dispatchIdempotencyKey: task.dispatchIdempotencyKey,
    });
    const failed =
      converged.status === 'failed' || converged.status === 'cancelled';
    return {
      executionId: task.executionId,
      provider: task.provider,
      mode: 'native',
      status: failed ? 'failed' : 'completed',
      agentRunId: converged.id,
      startedAt: converged.startedAt,
      completedAt: converged.completedAt ?? undefined,
    };
  }

  /**
   * PR #46 round 10: AWAIT an existing NON-TERMINAL AgentRun (pending /
   * in_progress) until it reaches a TERMINAL state — the explicit
   * await/reconcile path that observes the durable AgentRun instead of
   * treating the row's existence as the operation's successful outcome.
   * The run may genuinely still be executing (the original owner's adapter
   * is alive; a UNIQUE-collision loser converges onto the winner's in-flight
   * operation). Polls the run repository until terminal.
   *
   * FAILS CLOSED when the await window elapses without a terminal state (a
   * stuck run — e.g. the driver died mid-adapter and the run row is
   * orphaned): the typed error makes the dispatch fail honestly (the
   * obligation stays pending; a later reconcile retries the convergence —
   * or the run lifecycle itself resolves). NEVER a manufactured completion,
   * NEVER a second run (the execution_id UNIQUE is the ledger authority).
   */
  private async awaitExistingRunTerminal(
    task: ExecutionTask,
    run: AgentRun,
    via: 'pre-check' | 'collision-recovery',
  ): Promise<AgentRun> {
    this.deps.logger.info('execution.native.dispatch-converge-await-existing-run', {
      executionId: task.executionId,
      agentRunId: run.id,
      runStatus: run.status,
      via,
      resolutionWindowMs: this.existingRunResolutionWindowMs,
    });
    const deadline = Date.now() + this.existingRunResolutionWindowMs;
    for (;;) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.existingRunPollIntervalMs),
      );
      const fresh = await this.deps.agentRunRepository.findByExecutionId(
        task.executionId,
      );
      if (
        fresh &&
        (fresh.status === 'success' ||
          fresh.status === 'failed' ||
          fresh.status === 'cancelled')
      ) {
        return fresh;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `native-execution-existing-run-unresolved: the existing AgentRun ${run.id} for execution ${task.executionId} is still '${fresh?.status ?? run.status}' (non-terminal) after ${this.existingRunResolutionWindowMs}ms — EXISTING ≠ COMPLETED: AgentRun is the durable native operation ledger, and a keyed submit NEVER manufactures a completed outcome from a non-terminal run and NEVER starts a second run (the execution_id UNIQUE is the ledger authority); the dispatch fails closed — retry the convergence later`,
        );
      }
    }
  }
}

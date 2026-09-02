/**
 * V2-008 — the Computer-Agent Runtime: the observation/action loop, the
 * run-plan walk, host routing, human takeover and bounded recovery.
 *
 * EVERY durable fact flows through the V2-005 command surface (the
 * recorder port); the runtime holds no durable state of its own.
 * Host routing flows through the merged V2-004 matcher (requirement sets
 * projected from the compiled plan as data — capability advertisement is
 * never authorization). The executed plan comes from the merged V2-007
 * compiler over the merged V2-003 parser, pinned against the run record's
 * version digests (fail-closed on mismatch).
 *
 * EVIDENCE TRUTH (constitution §7): a step completes ONLY when its declared
 * completion-evidence class is established. A host claim ('succeeded') is a
 * claim; the completion gate for agentic steps is the VERIFICATION
 * observation the runtime itself takes through the host protocol; the
 * post-action effect observation is what the runtime trusts — never the
 * claim string.
 *
 * ATTESTATION COMPLETION GATE: AgentAttestationPolicy.required makes
 * attestation a PRECONDITION of durable step success — support check,
 * independent V2-014 verification and the V2-005 boundary attach all run
 * BEFORE recordStepCompleted('succeeded'). A required-attestation failure
 * is a typed runtime failure (AGENT_ATTESTATION_UNAVAILABLE /
 * AGENT_ATTESTATION_REJECTED): the step is durably failed, the run cannot
 * complete on that path, and completeRun() is unreachable while the
 * required attestation is unsatisfied.
 *
 * RECOVERY HONESTY: after a failed action the effect is UNKNOWN until
 * re-observed. Recoverable failures (stale observation, target changed,
 * transient host) re-enter the loop with the failure in the decider's
 * history; the decider re-observes (fresh reality) before re-acting. The
 * runtime bounds actions AND recovery cycles; exhaustion fails the step
 * honestly (never inventing success).
 *
 * DETERMINISM: all ids are content- and order-derived (runId, stepId,
 * attempt, cycle, sequence); all clocks are injected. A re-drive of the
 * same drive inputs converges: recorder commands converge (deterministic
 * command ids), host acts converge (the invocation ledger), observations
 * re-execute fresh (reads).
 */
import { createHash } from 'node:crypto';
import type {
  AgentDecision,
  AgentFailure,
  AgentDecider,
  AttestingComputerHost,
  ComputerHostAdapter,
  ComputerAgentPolicy,
  ComputerAgentRunRecorder,
  ExecuteRunInput,
  HostInvocationRequest,
  HostInvocationResult,
  HostObservation,
  RunExecutionReport,
  StepExecutionReport,
  TakeoverSession,
  TakeoverActionResult,
  AgentActionRecord,
} from '../types.js';
import { ComputerAgentError } from '../types.js';
import type { WorkflowPrincipal, WorkflowVersion } from '../../workflow-repository/index.js';
import type { WorkflowRun, WorkflowRunHistory, RecordInvocationResult, ResumeRunResult, RecordRunEvidenceResult } from '../../workflow-runs/index.js';
import type { NodeCapabilityService, NodeMatchResult, NodeRequirementSet, NodeTrustTier } from '../../node-capability/index.js';
import type { ExecutionAttestation, ReplayRegistry } from '../../execution-attestation/index.js';
import type { WorkflowRepositoryService } from '../../workflow-repository/index.js';
import type { CompiledUnit, CompiledWorkflowPlan } from '../../workflow-compiler/index.js';
import { compileWorkflow } from '../../workflow-compiler/index.js';
import { parseWorkflowIrDocument, computeWorkflowVersionSemanticDigest } from '../../workflow-ir/index.js';
import { checkInvocationAuthorization } from './safe-action.js';
import { ageMs } from './clock.js';
import {
  buildStepStatement,
  produceStepAttestation,
  verifyStepAttestationIndependently,
  observationCommitmentOf,
  type StepAttestationMaterial,
} from './attesting.js';

// ============================================================================
// §0 Deps + class
// ============================================================================

export interface ComputerAgentRuntimeDeps {
  /** The V2-005 command surface (the real run service satisfies it structurally). */
  readonly recorder: ComputerAgentRunRecorder;
  /** The V2-004 node directory (host routing through the merged matcher). */
  readonly nodes: NodeCapabilityService;
  /** The V2-002 repository surface (read-only version fetch for the pin). */
  readonly workflowRepository: Pick<WorkflowRepositoryService, 'getVersion'>;
  /** The injected agent/host clock (fixed-format UTC). */
  readonly clock: () => string;
  /** The current attestation-freshness protocol epoch. */
  readonly epoch: number;
  /** The runtime policy (bounds, grants, attestation expectations). */
  readonly policy: ComputerAgentPolicy;
  /** Single-use replay state for the independent attestation verification path. */
  readonly replayRegistry: ReplayRegistry;
  /** Minimum host trust tier for routing (default: provisional). */
  readonly minHostTrustTier?: NodeTrustTier;
}

/** Input to the takeover-finish drive (hand back or human-completed). */
export interface FinishTakeoverInput {
  readonly mode: 'hand-back' | 'complete-step';
  readonly hosts: readonly ComputerHostAdapter[];
  readonly decider?: AgentDecider;
  readonly workflowInputs?: Readonly<Record<string, unknown>>;
}

/** Input to the resume-after-human-pause drive. */
export interface ResumeAfterHumanInput {
  readonly runId: string;
  readonly hosts: readonly ComputerHostAdapter[];
  /** The human's selected outcome (approval/decision), when applicable. */
  readonly humanOutcome?: string;
  /** The human's provided value (information step), when applicable. */
  readonly providedValue?: unknown;
  /** The acting human's user id (producer identity of the confirmation). */
  readonly humanUserId: string;
  readonly decider?: AgentDecider;
  readonly workflowInputs?: Readonly<Record<string, unknown>>;
}

const SUBWORKFLOW_FAILURE: AgentFailure = {
  code: 'AGENT_SUBWORKFLOW_UNSUPPORTED',
  detail: 'subworkflow execution is out of this runtime scope (honest typed rejection — no silent emulation)',
  recoverable: false,
};

/** One host reference in a walk (structural subset of ExecuteRunInput.hosts). */
type WalkHost = ComputerHostAdapter;

/** The mutable per-drive walk state (in-memory only — durable state is V2-005's). */
interface WalkState {
  run: WorkflowRun;
  plan: CompiledWorkflowPlan;
  history: WorkflowRunHistory;
  attemptNumber: number;
  hosts: readonly WalkHost[];
  decider: AgentDecider | undefined;
  workflowInputs: Readonly<Record<string, unknown>>;
  values: Map<string, unknown>;
  reports: StepExecutionReport[];
  humanOutcome?: string;
  humanProvidedValue?: unknown;
  /**
   * Steps completed in THIS call before the walk started (e.g. the human
   * step a resume just completed): they route successors like
   * history-completed steps, using humanOutcome where declared.
   */
  extraCompleted?: ReadonlySet<string>;
  /**
   * The walk entry override: the IN-FLIGHT step (a resume, a takeover
   * hand-back, a re-drive of a paused run) instead of plan.entry — the
   * completed prefix converges by construction and the walk continues
   * exactly where execution actually is.
   */
  entry?: string;
  /**
   * The OBSERVATION-id drive discriminator (history-derived: 1 + timeline
   * length at walk start — strictly monotonic across drives, convergent on
   * crash re-drive). Observations are READS: each drive re-executes them
   * fresh (honest reality), so their invocation ids are drive-scoped.
   * ACTS keep drive-stable ids — the host ledger converges them (never a
   * second side effect).
   */
  drive?: number;
}

/** The computer-agent runtime (see the module header). */
export class ComputerAgentRuntime {
  private readonly recorder: ComputerAgentRunRecorder;
  private readonly nodes: NodeCapabilityService;
  private readonly workflowRepository: Pick<WorkflowRepositoryService, 'getVersion'>;
  private readonly clock: () => string;
  private readonly epoch: number;
  private readonly policy: ComputerAgentPolicy;
  private readonly replayRegistry: ReplayRegistry;
  private readonly minHostTrustTier: NodeTrustTier;
  private readonly takeoverSessions = new Map<string, TakeoverSession & { seq: number; closed: boolean }>();

  constructor(deps: ComputerAgentRuntimeDeps) {
    this.recorder = deps.recorder;
    this.nodes = deps.nodes;
    this.workflowRepository = deps.workflowRepository;
    this.clock = deps.clock;
    this.epoch = deps.epoch;
    this.policy = deps.policy;
    this.replayRegistry = deps.replayRegistry;
    this.minHostTrustTier = deps.minHostTrustTier ?? 'provisional';
  }

  // ==========================================================================
  // §1 The full run drive
  // ==========================================================================

  async executeRun(principal: WorkflowPrincipal, input: ExecuteRunInput): Promise<RunExecutionReport> {
    const run = await this.loadRun(principal, input.runId);
    if (run.state !== 'requested' && run.state !== 'paused' && run.state !== 'running') {
      throw new ComputerAgentError('COMPUTER_AGENT_RUN_TERMINAL', `run ${input.runId} is ${run.state}`);
    }
    if (run.state === 'requested') {
      await this.recorder.startRun(principal, this.command(input.runId, 'start'), { runId: input.runId });
    }
    const { plan, history } = await this.resolvePlanAndHistory(principal, run);
    const attemptNumber = latestAttemptNumber(history);
    return this.walk(principal, {
      run,
      plan,
      history,
      attemptNumber,
      hosts: input.hosts,
      decider: input.decider,
      workflowInputs: input.workflowInputs ?? {},
      values: initialValues(input.workflowInputs ?? {}),
      reports: [],
      entry: run.state === 'paused' ? findPausedStep(history) ?? undefined : undefined,
    });
  }

  // ==========================================================================
  // §2 Resume after a human-step pause
  // ==========================================================================

  async resumeAfterHuman(principal: WorkflowPrincipal, input: ResumeAfterHumanInput): Promise<RunExecutionReport> {
    const run = await this.loadRun(principal, input.runId);
    if (run.state !== 'paused') {
      throw new ComputerAgentError('COMPUTER_AGENT_RUN_NOT_PAUSED', `run ${input.runId} is ${run.state}`);
    }
    const resumeOutcome = await this.recorder.resumeRun(
      principal,
      this.command(input.runId, `resume-${input.runId}`),
      { runId: input.runId },
    );
    const resume = resumeOutcome.result as ResumeRunResult;
    const { plan, history } = await this.resolvePlanAndHistory(principal, run);
    const attemptNumber = resume.attempt.attemptNumber;
    const pausedStepId = resume.resumedAtStepId ?? findPausedStep(history);
    if (pausedStepId === null) {
      throw new ComputerAgentError('COMPUTER_AGENT_INVALID_REQUEST', `run ${input.runId} has no paused step to resume`);
    }
    const unit = findUnit(plan, pausedStepId);
    if (unit && unit.executionClass === 'human') {
      // The human acted: record the human confirmation, complete the step,
      // and route the declared outcome.
      await this.recorder.recordEvidence(
        principal,
        this.command(input.runId, `human-confirm-${pausedStepId}`),
        {
          runId: input.runId,
          attemptNumber,
          stepId: pausedStepId,
          evidenceClass: 'human_confirmation',
          producerKind: 'human',
          producerId: input.humanUserId,
          contentCommitment: commitmentJson({
            outcome: input.humanOutcome ?? null,
            provided: input.providedValue ?? null,
          }),
          description: 'human outcome recorded through the human-execution pause point',
        },
      );
      const outputCommitments =
        input.providedValue !== undefined ? [commitmentJson(input.providedValue)] : [];
      await this.recorder.recordStepCompleted(
        principal,
        this.command(input.runId, `step-complete-${pausedStepId}`),
        { runId: input.runId, stepId: pausedStepId, outcome: 'succeeded', outputCommitments },
      );
    }
    return this.walk(principal, {
      run,
      plan,
      history,
      attemptNumber,
      hosts: input.hosts,
      decider: input.decider,
      workflowInputs: input.workflowInputs ?? {},
      values: initialValues(input.workflowInputs ?? {}),
      reports: [],
      humanOutcome: input.humanOutcome,
      humanProvidedValue: input.providedValue,
      extraCompleted:
        unit && unit.executionClass === 'human' ? new Set([pausedStepId]) : undefined,
      entry: pausedStepId,
    });
  }

  // ==========================================================================
  // §3 Human takeover (the human acts through the SAME host protocol)
  // ==========================================================================

  async requestTakeover(
    principal: WorkflowPrincipal,
    input: { runId: string; stepId: string; userId: string; host: ComputerHostAdapter },
  ): Promise<TakeoverSession> {
    const run = await this.loadRun(principal, input.runId);
    if (run.state !== 'paused') {
      throw new ComputerAgentError('COMPUTER_AGENT_RUN_NOT_PAUSED', `run ${input.runId} is ${run.state}`);
    }
    const session: TakeoverSession & { seq: number; closed: boolean } = {
      id: `takeover-${input.runId}-${input.stepId}`,
      runId: input.runId,
      stepId: input.stepId,
      userId: input.userId,
      nodeId: input.host.nodeId,
      seq: 0,
      closed: false,
    };
    this.takeoverSessions.set(session.id, session);
    return session;
  }

  async performTakeoverAction(
    session: TakeoverSession,
    principal: WorkflowPrincipal,
    host: ComputerHostAdapter,
    request: HostInvocationRequest,
  ): Promise<TakeoverActionResult> {
    const live = this.takeoverSessions.get(session.id);
    if (!live) {
      throw new ComputerAgentError('COMPUTER_AGENT_TAKEOVER_SESSION_NOT_FOUND', session.id);
    }
    if (live.closed) {
      throw new ComputerAgentError('COMPUTER_AGENT_TAKEOVER_SESSION_CLOSED', session.id);
    }
    // HUMAN actions: the acting human IS the authorizing actor (their
    // consent is the authorization — constitution §16); the safe-action
    // grant dimension applies to AGENT invocations, not the human's own
    // actions. Grounding/staleness still apply (the host enforces target
    // digests; the runtime enforces observation freshness below).
    if (request.kind === 'act' && request.grounding !== null) {
      // freshness of the human's grounding is enforced with the same bound
      // (the human acts on the same protocol as the agent)
      const observation = this.lookupRecentObservation(request.grounding.observationId);
      if (observation === null || ageMs(observation.observedAt, this.clock()) > this.policy.maxObservationAgeMs) {
        return {
          result: {
            ok: false,
            failure: {
              code: 'HOST_PARAMETER_INVALID',
              detail: 'takeover action grounded on a stale observation — re-observe first (the same discipline as the agent)',
            },
          },
          evidenceCommandId: 'not-recorded',
        };
      }
    }
    const actionSeq = ++live.seq;
    const run = await this.loadRun(principal, session.runId);
    // The human taking over IS execution: a paused run is RESUMED under the
    // human executor before the first recorded action (V2-005 records steps
    // and invocations only while running — the resume continues the SAME
    // attempt per the attempt rule; the command id converges on re-drive).
    let executionState = run.state;
    if (executionState === 'paused') {
      await this.recorder.resumeRun(
        principal,
        this.command(session.runId, `takeover-resume-${session.stepId}`),
        { runId: session.runId },
      );
      executionState = 'running';
    }
    if (executionState !== 'running') {
      throw new ComputerAgentError('COMPUTER_AGENT_RUN_TERMINAL', `run ${session.runId} is ${executionState}`);
    }
    const { history } = await this.resolvePlanAndHistory(principal, run);
    const attemptNumber = latestAttemptNumber(history);
    const invocationId =
      request.kind === 'act'
        ? `tak-${session.runId}-${session.stepId}-${String(actionSeq).padStart(4, '0')}`
        : takeoverObservationIdOf(session.runId, 1 + history.timeline.length, session.stepId, actionSeq);
    const invocationRequested = await this.recorder.recordInvocationRequested(
      principal,
      this.command(session.runId, `inv-${invocationId}`),
      {
        runId: session.runId,
        capability: request.capability,
        executionClass: 'agentic_computer_use',
        stepId: session.stepId,
        inputCommitments: [commitmentJson(request.kind === 'act' ? request.parameters : request.subject)],
      },
    );
    const result = await host.invoke(invocationId, request);
    await this.recorder.recordInvocationCompleted(
      principal,
      this.command(session.runId, `invc-${invocationId}`),
      {
        runId: session.runId,
        invocationId: (invocationRequested.result as RecordInvocationResult).invocation.id,
        outcome: result.ok && (result.kind !== 'acted' || result.outcome.outcome === 'succeeded') ? 'succeeded' : 'failed',
        outputCommitments: result.ok && result.kind === 'observed'
          ? [observationCommitmentOf(result.observation)]
          : [],
      },
    );
    const evidenceCommandId = this.command(session.runId, `ev-${evidenceKey(invocationId, 'takeover')}`);
    await this.recorder.recordEvidence(principal, evidenceCommandId, {
      runId: session.runId,
      attemptNumber,
      stepId: session.stepId,
      evidenceClass: request.kind === 'act' ? 'human_confirmation' : 'observation',
      producerKind: 'human',
      producerId: session.userId,
      contentCommitment: commitmentJson({
        invocationId,
        capability: request.capability,
        kind: request.kind,
        ok: result.ok,
        failure: result.ok ? null : result.failure.code,
      }),
      description: `human takeover ${request.kind} via ${request.capability}`,
    });
    if (result.ok && result.kind === 'observed') {
      this.rememberObservation(result.observation);
    }
    return { result, evidenceCommandId: evidenceCommandId.commandId };
  }

  async finishTakeover(
    principal: WorkflowPrincipal,
    session: TakeoverSession,
    input: FinishTakeoverInput,
  ): Promise<RunExecutionReport> {
    const live = this.takeoverSessions.get(session.id);
    if (!live) {
      throw new ComputerAgentError('COMPUTER_AGENT_TAKEOVER_SESSION_NOT_FOUND', session.id);
    }
    if (live.closed) {
      throw new ComputerAgentError('COMPUTER_AGENT_TAKEOVER_SESSION_CLOSED', session.id);
    }
    const run = await this.loadRun(principal, session.runId);
    if (run.state !== 'paused' && run.state !== 'running') {
      throw new ComputerAgentError('COMPUTER_AGENT_RUN_TERMINAL', `run ${session.runId} is ${run.state}`);
    }
    // resume only when still paused (takeover actions already resumed under
    // the human executor); complete-step also requires a running run.
    if (run.state === 'paused') {
      await this.recorder.resumeRun(
        principal,
        this.command(session.runId, `takeover-finish-resume-${session.stepId}`),
        { runId: session.runId },
      );
    }
    if (input.mode === 'complete-step') {
      await this.recorder.recordStepCompleted(
        principal,
        this.command(session.runId, `step-complete-${session.stepId}`),
        {
          runId: session.runId,
          stepId: session.stepId,
          outcome: 'succeeded',
          outputCommitments: [],
        },
      );
    }
    live.closed = true;
    this.takeoverSessions.delete(session.id);
    const { plan, history } = await this.resolvePlanAndHistory(principal, run);
    const attemptNumber = latestAttemptNumber(history);
    return this.walk(principal, {
      run,
      plan,
      history,
      attemptNumber,
      hosts: input.hosts,
      decider: input.decider,
      workflowInputs: input.workflowInputs ?? {},
      values: initialValues(input.workflowInputs ?? {}),
      reports: [],
      entry: session.stepId,
    });
  }

  // ==========================================================================
  // §4 The plan walk (control routing + failure policy)
  // ==========================================================================

  private async walk(principal: WorkflowPrincipal, state: WalkState): Promise<RunExecutionReport> {
    if (state.drive === undefined) {
      state.drive = 1 + state.history.timeline.length;
    }
    const completed = new Set<string>([
      ...state.history.steps.filter((step) => step.status === 'completed').map((step) => step.stepId),
      ...(state.extraCompleted ?? []),
    ]);
    const reachedInHistory = new Set<string>(state.history.steps.map((step) => step.stepId));
    const queue: string[] = [state.entry ?? state.plan.entry];
    let terminalFailure: AgentFailure | null = null;
    let pausedAtStepId: string | null = null;
    let takeoverRequested = false;

    while (queue.length > 0) {
      const unitId = queue.shift();
      if (unitId === undefined) {
        continue;
      }
      const unit = findUnit(state.plan, unitId);
      if (completed.has(unitId)) {
        // A step completed before this drive (history or this call): route
        // its declared continuation so the walk converges on the frontier
        // (never dead-ends on an already-executed prefix).
        const completedUnit = unit;
        if (completedUnit && completedUnit.executionClass === 'human') {
          if (state.humanOutcome !== undefined) {
            const outcomeEdge = completedUnit.onOutcomes.find((edge) => edge.outcome === state.humanOutcome);
            if (outcomeEdge) {
              queue.push(outcomeEdge.to);
              continue;
            }
          }
          // No explicit outcome in this walk: continue along the outcome
          // edge the durable record already REACHED (the original drive
          // started its target); all targets only in the crash window that
          // predates any successor start.
          const reached = completedUnit.onOutcomes.filter((edge) => reachedInHistory.has(edge.to));
          const targets = reached.length > 0 ? reached : completedUnit.onOutcomes;
          for (const edge of targets) {
            queue.push(edge.to);
          }
          continue;
        }
        if (completedUnit) {
          for (const successor of completedUnit.onSuccess) {
            queue.push(successor);
          }
        }
        continue;
      }
      if (!unit) {
        terminalFailure = {
          code: 'AGENT_PLAN_UNAVAILABLE',
          detail: `plan unit "${unitId}" missing`,
          recoverable: false,
        };
        break;
      }
      if (unit.executionClass === 'human') {
        // A human unit is a PAUSE POINT (V2-003): start it, pause the run
        // at it, and return — the caller drives the human outcome.
        await this.recorder.recordStepStarted(
          principal,
          this.command(state.run.id, `step-start-${unit.unit}`),
          { runId: state.run.id, stepId: unit.unit },
        );
        await this.recorder.pauseRun(principal, this.command(state.run.id, `pause-${unit.unit}`), {
          runId: state.run.id,
          atStepId: unit.unit,
        });
        pausedAtStepId = unit.unit;
        state.reports.push({
          stepId: unit.unit,
          executionClass: 'human',
          outcome: 'paused',
          actions: 0,
          observations: 0,
          attestationsAttached: 0,
          attestationsRejected: 0,
          failure: null,
          nodeId: null,
        });
        break;
      }

      const stepReport = await this.executeUnit(principal, state, unit);
      state.reports.push(stepReport);
      if (stepReport.outcome === 'paused') {
        pausedAtStepId = stepReport.stepId;
        takeoverRequested = stepReport.failure === null;
        break;
      }
      if (stepReport.outcome === 'failed') {
        const failure = stepReport.failure;
        terminalFailure = failure ?? null;
        // failure policy routing (the IR-declared policy)
        const policy = unit.failurePolicy;
        if (policy.strategy === 'failover' && unit.onFailure !== null) {
          queue.push(unit.onFailure);
          terminalFailure = null; // routed honestly along the failure edge
          continue;
        }
        if (policy.strategy === 'ignore_and_continue') {
          for (const successor of unit.onSuccess) {
            queue.push(successor);
          }
          terminalFailure = null;
          continue;
        }
        break; // fail_workflow / retry-exhausted: the run fails honestly
      }
      completed.add(unit.unit);
      if (state.humanOutcome !== undefined) {
        const outcomeEdge = unit.onOutcomes.find((edge) => edge.outcome === state.humanOutcome);
        if (outcomeEdge) {
          queue.push(outcomeEdge.to);
          continue;
        }
      }
      for (const successor of unit.onSuccess) {
        queue.push(successor);
      }
    }

    if (pausedAtStepId !== null) {
      return {
        runId: state.run.id,
        state: 'paused',
        steps: state.reports,
        pausedAtStepId,
        takeoverRequested,
        failure: null,
        outputCommitments: [],
      };
    }
    if (terminalFailure !== null) {
      await this.recorder.failRun(
        principal,
        this.command(state.run.id, 'fail'),
        { runId: state.run.id, reason: `${terminalFailure.code}: ${terminalFailure.detail}` },
      );
      return {
        runId: state.run.id,
        state: 'failed',
        steps: state.reports,
        pausedAtStepId: null,
        takeoverRequested: false,
        failure: terminalFailure,
        outputCommitments: [],
      };
    }
    const outputCommitments = resolveWorkflowOutputs(state.plan, state.values);
    await this.recorder.completeRun(
      principal,
      this.command(state.run.id, 'complete'),
      { runId: state.run.id, outputCommitments },
    );
    return {
      runId: state.run.id,
      state: 'completed',
      steps: state.reports,
      pausedAtStepId: null,
      takeoverRequested: false,
      failure: null,
      outputCommitments,
    };
  }

  // ==========================================================================
  // §5 One unit: routing, the agentic loop, the structured path
  // ==========================================================================

  private async executeUnit(
    principal: WorkflowPrincipal,
    state: WalkState,
    unit: CompiledUnit,
  ): Promise<StepExecutionReport> {
    if (unit.executionClass === 'subworkflow') {
      const report: StepExecutionReport = {
        stepId: unit.unit,
        executionClass: 'subworkflow',
        outcome: 'failed',
        actions: 0,
        observations: 0,
        attestationsAttached: 0,
        attestationsRejected: 0,
        failure: SUBWORKFLOW_FAILURE,
        nodeId: null,
      };
      await this.recorder.recordStepStarted(
        principal,
        this.command(state.run.id, `step-start-${unit.unit}`),
        { runId: state.run.id, stepId: unit.unit },
      );
      await this.recorder.recordStepCompleted(
        principal,
        this.command(state.run.id, `step-complete-${unit.unit}`),
        { runId: state.run.id, stepId: unit.unit, outcome: 'failed' },
      );
      return report;
    }
    if (unit.executionClass === 'human') {
      // unreachable (the walk handles human units) — honest guard
      throw new ComputerAgentError('COMPUTER_AGENT_INVALID_REQUEST', 'human units are pause points handled by the walk');
    }

    await this.recorder.recordStepStarted(
      principal,
      this.command(state.run.id, `step-start-${unit.unit}`),
      {
        runId: state.run.id,
        stepId: unit.unit,
        inputCommitments: [commitmentJson(resolveUnitInputs(unit, state.values, state.workflowInputs))],
      },
    );

    const host = this.routeHost(state, unit);
    if ('failure' in host) {
      await this.failStepRecord(principal, state, unit);
      return {
        stepId: unit.unit,
        executionClass: unit.executionClass,
        outcome: 'failed',
        actions: 0,
        observations: 0,
        attestationsAttached: 0,
        attestationsRejected: 0,
        failure: host.failure,
        nodeId: null,
      };
    }

    const loop = await this.runLoop(principal, state, unit, host.host);
    return loop;
  }

  private routeHost(
    state: WalkState,
    unit: CompiledUnit,
  ): { host: WalkHost } | { failure: AgentFailure } {
    const requirement: NodeRequirementSet = {
      id: `step:${unit.unit}`,
      capabilities: unit.capabilityRequirements.map((name) => ({ name })),
      placement: { required: unit.placement },
      minTrustTier: this.minHostTrustTier,
    };
    const match: NodeMatchResult = this.nodes.matchNodes(requirement);
    const preferred = match.eligibleNodes[0];
    if (preferred === undefined) {
      return {
        failure: {
          code: 'AGENT_NO_ELIGIBLE_HOST',
          detail: `no eligible host for step ${unit.unit} (capabilities [${unit.capabilityRequirements.join(', ')}], placement ${unit.placement})`,
          recoverable: false,
        },
      };
    }
    const host = state.hosts.find((candidate) => candidate.nodeId === preferred.nodeId);
    if (!host) {
      return {
        failure: {
          code: 'AGENT_HOST_NOT_CONNECTED',
          detail: `eligible host ${preferred.nodeId} has no attached adapter`,
          recoverable: false,
        },
      };
    }
    return { host };
  }

  /**
   * The bounded observation/action loop for one unit. Also the structured
   * single-invocation path for deterministic_api units (one act, verified
   * by the effect observation).
   */
  private async runLoop(
    principal: WorkflowPrincipal,
    state: WalkState,
    unit: CompiledUnit,
    host: WalkHost,
  ): Promise<StepExecutionReport> {
    if (unit.executionClass === 'agentic_computer_use' && !state.decider) {
      await this.failStepRecord(principal, state, unit);
      return {
        stepId: unit.unit,
        executionClass: 'agentic_computer_use',
        outcome: 'failed',
        actions: 0,
        observations: 0,
        attestationsAttached: 0,
        attestationsRejected: 0,
        failure: {
          code: 'AGENT_CAPABILITY_UNAUTHORIZED',
          detail: 'no decider injected for an agentic step',
          recoverable: false,
        },
        nodeId: host.nodeId,
      };
    }

    const inputs = resolveUnitInputs(unit, state.values, state.workflowInputs);
    const task = unit.executionClass === 'agentic_computer_use' ? (unit.spec as { task: string }).task : '';
    const history: AgentActionRecord[] = [];
    const evidenceReferences: string[] = [];
    const inputCommitments: string[] = [];
    const outputCommitments: string[] = [];
    const observationCommitments: string[] = [];
    let observation: HostObservation | null = null;
    let actions = 0;
    let observations = 0;
    let recoveryCycles = 0;
    let lastCapability = unit.capabilityRequirements[0] ?? unit.executionClass;
    let cycle = 0;

    // the structured deterministic path: ONE invocation, no decisions
    if (unit.executionClass === 'deterministic_api') {
      const capability = (unit.spec as { capability: string }).capability;
      const parameters = inputs;
      const invocationId = invocationIdOf(state.run.id, state.attemptNumber, unit.unit, cycle, 1);
      const authorized = checkInvocationAuthorization(this.policy.safeAction, capability, unit.unit);
      if (!authorized.ok) {
        await this.failStepRecord(principal, state, unit);
        return this.stepFailureReport(unit, host, {
          code: 'AGENT_CAPABILITY_UNAUTHORIZED',
          detail: `structured invocation of ${capability} rejected: ${authorized.reason}`,
          recoverable: false,
        });
      }
      const result = await this.invokeAndRecord(principal, state, unit, host, invocationId, {
        kind: 'act',
        capability,
        grounding: null,
        parameters,
      }, evidenceReferences, inputCommitments, observationCommitments, 'agent');
      actions += 1;
      history.push(recordOf(invocationId, capability, 'act', 'agent', result));
      lastCapability = capability;
      if (!result.ok) {
        await this.failStepRecord(principal, state, unit);
        return this.stepFailureReport(unit, host, classifyHostFailure(result.failure));
      }
      if (result.kind === 'acted') {
        if (result.outcome.outcome === 'failed') {
          await this.failStepRecord(principal, state, unit);
          return this.stepFailureReport(unit, host, {
            code: 'AGENT_HOST_PERMANENT',
            detail: `structured invocation failed: ${result.outcome.detail ?? 'no detail'}`,
            recoverable: false,
          });
        }
        if (result.outcome.effect) {
          observation = result.outcome.effect;
          observations += 1;
        }
      }
      // structured outputs: effect elements matched by output port name
      const outputs = extractStructuredOutputs(unit, observation);
      for (const [name, value] of Object.entries(outputs)) {
        state.values.set(`${unit.unit}.${name}`, value);
        outputCommitments.push(commitmentJson(value));
      }
      const completed = await this.completeStepWithAttestation(principal, state, unit, host, {
        executionClass: 'deterministic_api',
        capability,
        action: `structured invocation of ${capability}`,
        inputCommitments,
        outputCommitments,
        observationCommitments,
        evidenceReferences,
      });
      if (completed.failure !== null) {
        // the attestation completion gate FAILED: the step is durably
        // failed (never succeeded) and the typed failure propagates — the
        // walk routes it through the failure policy (completeRun is never
        // reached while a required attestation is unsatisfied).
        await this.failStepRecord(principal, state, unit);
        return {
          stepId: unit.unit,
          executionClass: 'deterministic_api',
          outcome: 'failed',
          actions,
          observations,
          attestationsAttached: completed.attached,
          attestationsRejected: completed.rejected,
          failure: completed.failure,
          nodeId: host.nodeId,
        };
      }
      return {
        stepId: unit.unit,
        executionClass: 'deterministic_api',
        outcome: 'completed',
        actions,
        observations,
        attestationsAttached: completed.attached,
        attestationsRejected: completed.rejected,
        failure: completed.failure,
        nodeId: host.nodeId,
      };
    }

    // the agentic observation/action loop (bounded)
    const decider = state.decider as AgentDecider;
    let decision: AgentDecision | null = null;
    while (actions < this.policy.maxActionsPerStep) {
      decision = await decider({
        runId: state.run.id,
        attemptNumber: state.attemptNumber,
        stepId: unit.unit,
        task,
        inputs,
        observation,
        history,
        actionsRemaining: this.policy.maxActionsPerStep - actions,
      });
      await this.recorder.recordEvidence(
        principal,
        this.command(state.run.id, `ev-${evidenceKey(`d${state.drive!}-${unit.unit}-decision-${actions}`, 'intent')}`),
        {
          runId: state.run.id,
          attemptNumber: state.attemptNumber,
          stepId: unit.unit,
          evidenceClass: 'intent',
          producerKind: 'computer_agent',
          producerId: 'workflowos/computer-agent-runtime',
          contentCommitment: commitmentJson(decision),
          description: `agent decision: ${decision.decision}`,
        },
      );

      if (decision.decision === 'fail') {
        await this.failStepRecord(principal, state, unit);
        return this.stepFailureReport(unit, host, {
          code: 'AGENT_HOST_PERMANENT',
          detail: `agent declared failure: ${decision.reason}`,
          recoverable: false,
        });
      }
      if (decision.decision === 'takeover') {
        await this.recorder.pauseRun(principal, this.command(state.run.id, `pause-${unit.unit}`), {
          runId: state.run.id,
          atStepId: unit.unit,
        });
        return {
          stepId: unit.unit,
          executionClass: 'agentic_computer_use',
          outcome: 'paused',
          actions,
          observations,
          attestationsAttached: 0,
          attestationsRejected: 0,
          failure: null,
          nodeId: host.nodeId,
        };
      }
      if (decision.decision === 'observe') {
        const invocationId = observationInvocationIdOf(state.run.id, state.attemptNumber, state.drive!, unit.unit, actions + 1);
        const authorized = checkInvocationAuthorization(this.policy.safeAction, decision.capability, unit.unit);
        if (!authorized.ok) {
          await this.failStepRecord(principal, state, unit);
          return this.stepFailureReport(unit, host, {
            code: 'AGENT_CAPABILITY_UNAUTHORIZED',
            detail: `observation of ${decision.capability} rejected: ${authorized.reason}`,
            recoverable: false,
          });
        }
        const result = await this.invokeAndRecord(principal, state, unit, host, invocationId, {
          kind: 'observe',
          capability: decision.capability,
          subject: decision.subject,
        }, evidenceReferences, inputCommitments, observationCommitments, 'agent');
        actions += 1;
        lastCapability = decision.capability;
        history.push(recordOf(invocationId, decision.capability, 'observe', 'agent', result));
        if (result.ok && result.kind === 'observed') {
          observation = result.observation;
          observations += 1;
        } else if (!result.ok) {
          const failure = classifyHostFailure(result.failure);
          if (failure.recoverable && recoveryCycles < this.policy.maxRecoveryCyclesPerStep) {
            recoveryCycles += 1;
            continue;
          }
          await this.failStepRecord(principal, state, unit);
          return this.stepFailureReport(unit, host, failure);
        }
        continue;
      }
      if (decision.decision === 'act') {
        // safe-action boundary (agent invocations require grants)
        const authorized = checkInvocationAuthorization(this.policy.safeAction, decision.capability, unit.unit);
        if (!authorized.ok) {
          await this.failStepRecord(principal, state, unit);
          return this.stepFailureReport(unit, host, {
            code: 'AGENT_CAPABILITY_UNAUTHORIZED',
            detail: `act on ${decision.capability} rejected: ${authorized.reason} (constitution §16 per-capability consent)`,
            recoverable: false,
          });
        }
        // stale-observation bound (fail-closed: re-observe before acting)
        if (decision.grounding !== null) {
          const grounded = this.lookupRecentObservation(decision.grounding.observationId);
          if (grounded === null || ageMs(grounded.observedAt, this.clock()) > this.policy.maxObservationAgeMs) {
            if (recoveryCycles < this.policy.maxRecoveryCyclesPerStep) {
              recoveryCycles += 1;
              history.push({
                invocationId: 'not-dispatched',
                capability: decision.capability,
                kind: 'act',
                by: 'agent',
                ok: false,
                failureCode: 'AGENT_OBSERVATION_STALE',
                detail: 'grounding observation stale or unknown — re-observe required',
              });
              continue;
            }
            await this.failStepRecord(principal, state, unit);
            return this.stepFailureReport(unit, host, {
              code: 'AGENT_OBSERVATION_STALE',
              detail: 'grounding observation stale and recovery budget exhausted',
              recoverable: true,
            });
          }
        }
        const invocationId = invocationIdOf(state.run.id, state.attemptNumber, unit.unit, cycle, actions + 1);
        const result = await this.invokeAndRecord(principal, state, unit, host, invocationId, {
          kind: 'act',
          capability: decision.capability,
          grounding: decision.grounding,
          parameters: decision.parameters,
        }, evidenceReferences, inputCommitments, observationCommitments, 'agent');
        actions += 1;
        lastCapability = decision.capability;
        history.push(recordOf(invocationId, decision.capability, 'act', 'agent', result));
        if (!result.ok) {
          const failure = classifyHostFailure(result.failure);
          if (failure.recoverable && recoveryCycles < this.policy.maxRecoveryCyclesPerStep) {
            recoveryCycles += 1;
            continue;
          }
          await this.failStepRecord(principal, state, unit);
          return this.stepFailureReport(unit, host, failure);
        }
        if (result.kind === 'acted') {
          // the host's claim is a CLAIM; the effect observation is the fact
          await this.recorder.recordEvidence(
            principal,
            this.command(state.run.id, `ev-${evidenceKey(invocationId, 'claim')}`),
            {
              runId: state.run.id,
              attemptNumber: state.attemptNumber,
              stepId: unit.unit,
              evidenceClass: 'claim',
              producerKind: 'computer_host',
              producerId: host.nodeId,
              contentCommitment: commitmentJson({ invocationId, capability: decision.capability, outcome: result.outcome.outcome }),
              description: `host claims ${result.outcome.outcome}: ${result.outcome.detail ?? ''}`,
            },
          );
          if (result.outcome.effect) {
            observation = result.outcome.effect;
            observations += 1;
          }
        }
        continue;
      }
      if (decision.decision === 'complete') {
        // EVIDENCE TRUTH: the claim verifies only against the runtime's own
        // verification observation — never the claim itself.
        const verifyInvocationId = `inv-${state.run.id}-a${state.attemptNumber}-d${state.drive!}-${unit.unit}-v${actions + 1}`;
        const authorized = checkInvocationAuthorization(this.policy.safeAction, decision.verify.capability, unit.unit);
        if (!authorized.ok) {
          await this.failStepRecord(principal, state, unit);
          return this.stepFailureReport(unit, host, {
            code: 'AGENT_CAPABILITY_UNAUTHORIZED',
            detail: `verification observation of ${decision.verify.capability} rejected: ${authorized.reason}`,
            recoverable: false,
          });
        }
        const result = await this.invokeAndRecord(principal, state, unit, host, verifyInvocationId, {
          kind: 'observe',
          capability: decision.verify.capability,
          subject: decision.verify.subject,
        }, evidenceReferences, inputCommitments, observationCommitments, 'agent');
        actions += 1;
        const verified = result.ok && result.kind === 'observed' && matchesExpectation(result.observation, decision.verify.expect);
        if (verified && result.kind === 'observed') {
          observation = result.observation;
          observations += 1;
          for (const [name, value] of Object.entries(decision.outputs ?? {})) {
            state.values.set(`${unit.unit}.${name}`, value);
            outputCommitments.push(commitmentJson(value));
          }
          const completed = await this.completeStepWithAttestation(principal, state, unit, host, {
            executionClass: 'agentic_computer_use',
            capability: lastCapability,
            action: `agentic completion verified by observation of ${decision.verify.subject}`,
            inputCommitments,
            outputCommitments,
            observationCommitments,
            evidenceReferences,
          });
          if (completed.failure !== null) {
            // the attestation completion gate FAILED: the step is durably
            // failed (never succeeded) and the typed failure propagates —
            // the walk routes it through the failure policy (completeRun
            // is never reached while a required attestation is unsatisfied).
            await this.failStepRecord(principal, state, unit);
            return {
              stepId: unit.unit,
              executionClass: 'agentic_computer_use',
              outcome: 'failed',
              actions,
              observations,
              attestationsAttached: completed.attached,
              attestationsRejected: completed.rejected,
              failure: completed.failure,
              nodeId: host.nodeId,
            };
          }
          return {
            stepId: unit.unit,
            executionClass: 'agentic_computer_use',
            outcome: 'completed',
            actions,
            observations,
            attestationsAttached: completed.attached,
            attestationsRejected: completed.rejected,
            failure: completed.failure,
            nodeId: host.nodeId,
          };
        }
        // the claim did NOT verify — honest record, loop continues (bounded)
        await this.recorder.recordEvidence(
          principal,
          this.command(state.run.id, `ev-${evidenceKey(verifyInvocationId, 'unverified')}`),
          {
            runId: state.run.id,
            attemptNumber: state.attemptNumber,
            stepId: unit.unit,
            evidenceClass: 'observation',
            producerKind: 'computer_agent',
            producerId: 'workflowos/computer-agent-runtime',
            contentCommitment: commitmentJson({ verified: false, expect: decision.verify.expect }),
            description: 'completion claim did not verify against the verification observation',
          },
        );
        history.push({
          invocationId: verifyInvocationId,
          capability: decision.verify.capability,
          kind: 'observe',
          by: 'agent',
          ok: false,
          failureCode: 'AGENT_COMPLETION_UNVERIFIED',
          detail: 'claim did not verify',
        });
        continue;
      }
    }

    // bounded loop exhausted — honest failure (never invented completion)
    await this.failStepRecord(principal, state, unit);
    return this.stepFailureReport(unit, host, {
      code: decision?.decision === 'complete' ? 'AGENT_COMPLETION_UNVERIFIED' : 'AGENT_MAX_ACTIONS_EXCEEDED',
      detail: `action budget exhausted (${this.policy.maxActionsPerStep}) without verified completion`,
      recoverable: false,
    });
  }

  // ==========================================================================
  // §6 Invocation + recording (the discipline core)
  // ==========================================================================

  private async invokeAndRecord(
    principal: WorkflowPrincipal,
    state: WalkState,
    unit: CompiledUnit,
    host: WalkHost,
    invocationId: string,
    request: HostInvocationRequest,
    evidenceReferences: string[],
    inputCommitments: string[],
    observationCommitments: string[],
    actor: 'agent' | 'human',
  ): Promise<HostInvocationResult> {
    const requested = await this.recorder.recordInvocationRequested(
      principal,
      this.command(state.run.id, `inv-${invocationId}`),
      {
        runId: state.run.id,
        capability: request.capability,
        executionClass: unit.executionClass === 'subworkflow' ? 'subworkflow' : unit.executionClass,
        stepId: unit.unit,
        inputCommitments: [commitmentJson(request.kind === 'act' ? request.parameters : request.subject)],
      },
    );
    inputCommitments.push(commitmentJson(request.kind === 'act' ? request.parameters : request.subject));
    const result = await host.invoke(invocationId, request);
    await this.recorder.recordInvocationCompleted(
      principal,
      this.command(state.run.id, `invc-${invocationId}`),
      {
        runId: state.run.id,
        invocationId: (requested.result as RecordInvocationResult).invocation.id,
        outcome:
          result.ok && (result.kind === 'observed' || result.outcome.outcome === 'succeeded')
            ? 'succeeded'
            : 'failed',
        outputCommitments:
          result.ok && result.kind === 'observed'
            ? [observationCommitmentOf(result.observation)]
            : result.ok && result.kind === 'acted' && result.outcome.effect
              ? [observationCommitmentOf(result.outcome.effect)]
              : [],
      },
    );
    if (result.ok && result.kind === 'observed') {
      observationCommitments.push(observationCommitmentOf(result.observation));
      this.rememberObservation(result.observation);
      const evidence = await this.recorder.recordEvidence(
        principal,
        this.command(state.run.id, `ev-${evidenceKey(invocationId, 'observation')}`),
        {
          runId: state.run.id,
          attemptNumber: state.attemptNumber,
          stepId: unit.unit,
          evidenceClass: 'observation',
          producerKind: actor === 'agent' ? 'computer_host' : 'human',
          producerId: host.nodeId,
          contentCommitment: observationCommitmentOf(result.observation),
          description: `observation of ${result.observation.subject} via ${request.capability}`,
        },
      );
      evidenceReferences.push((evidence.result as RecordRunEvidenceResult).evidence.id);
    }
    if (actor === 'human' && result.ok && result.kind === 'acted') {
      // (takeover acts are recorded by performTakeoverAction — this path is
      // agent-only for acts; observations may be shared)
    }
    return result;
  }

  /**
   * The attestation completion gate. ENFORCEMENT ORDER (the PR #142
   * blocker correction): attestation policy is enforced BEFORE the durable
   * step success — support check → independent V2-014 verification → the
   * V2-005 boundary attach — and only when every required gate passes is
   * the step recorded 'succeeded'. A required-attestation failure (no
   * attester key, independent verification rejection, boundary attach
   * rejection) returns a TYPED failure with the step NOT durably
   * succeeded; the caller fails the step honestly and the walk fails the
   * run — completeRun() is never reached on this path. Under an OPTIONAL
   * policy the honest absence/rejection is recorded and the step still
   * completes (attestation never fabricates an obligation).
   */
  private async completeStepWithAttestation(
    principal: WorkflowPrincipal,
    state: WalkState,
    unit: CompiledUnit,
    host: WalkHost,
    material: Omit<StepAttestationMaterial, 'workflowId' | 'workflowVersionId' | 'workflowVersionSemanticDigest' | 'deploymentId' | 'runId' | 'attemptNumber' | 'stepId'> & {
      executionClass: 'deterministic_api' | 'agentic_computer_use';
    },
  ): Promise<{ attached: number; rejected: number; failure: AgentFailure | null }> {
    const fullMaterial: StepAttestationMaterial = {
      workflowId: state.run.workflowId,
      workflowVersionId: state.run.versionId,
      workflowVersionSemanticDigest: state.run.versionSemanticDigest,
      deploymentId: state.run.installationId ?? 'none',
      runId: state.run.id,
      attemptNumber: state.attemptNumber,
      stepId: unit.unit,
      ...material,
    };

    // Gate 1 — attestation production where the host supports the V2-014
    // contract; HONEST absence otherwise (never fabricated, never
    // up-claimed). A REQUIRED policy makes the absence a typed failure
    // BEFORE any durable step-success record exists.
    const isAttesting =
      host.attestationSupport.supported &&
      typeof (host as AttestingComputerHost).signStatement === 'function';
    if (!isAttesting) {
      if (this.policy.attestation.required) {
        return {
          attached: 0,
          rejected: 0,
          failure: {
            code: 'AGENT_ATTESTATION_UNAVAILABLE',
            detail: `attestation required by policy but host ${host.nodeId} does not support the V2-014 contract (no attester key)`,
            recoverable: false,
          },
        };
      }
      await this.recorder.recordEvidence(
        principal,
        this.command(state.run.id, `ev-${evidenceKey(unit.unit, 'attestation-absent')}`),
        {
          runId: state.run.id,
          attemptNumber: state.attemptNumber,
          stepId: unit.unit,
          evidenceClass: 'observation',
          producerKind: 'computer_agent',
          producerId: 'workflowos/computer-agent-runtime',
          contentCommitment: commitmentJson({ host: host.nodeId, attestation: 'unavailable' }),
          description: 'honest attestation-absence record: host has no attester key (no V2-014 support)',
        },
      );
      await this.recordStepSucceeded(principal, state, unit, material);
      return { attached: 0, rejected: 0, failure: null };
    }

    const attestingHost = host as AttestingComputerHost;
    const statement = buildStepStatement(attestingHost, fullMaterial, {
      now: this.clock(),
      epoch: this.epoch,
      validityMs: this.policy.attestation.validityMs ?? 300_000,
    });
    const attestation: ExecutionAttestation = produceStepAttestation(attestingHost, statement, {
      now: this.clock(),
      epoch: this.epoch,
      validityMs: this.policy.attestation.validityMs ?? 300_000,
    });

    // Gate 2 — the INDEPENDENT verifier path (merged V2-014 verifier +
    // explicit policy) BEFORE any durable step-success record. A REQUIRED
    // policy makes a typed rejection a step failure; an optional policy
    // records the honest rejection and still completes (never auto-accepts).
    const verification = verifyStepAttestationIndependently(attestation, fullMaterial, this.policy.attestation, {
      now: this.clock(),
      epoch: this.epoch,
      replayRegistry: this.replayRegistry,
    });
    if (!verification.ok) {
      if (this.policy.attestation.required) {
        return {
          attached: 0,
          rejected: 1,
          failure: {
            code: 'AGENT_ATTESTATION_REJECTED',
            detail: `required attestation rejected by the independent V2-014 verifier: ${verification.failure.code} — ${verification.failure.detail}`,
            recoverable: false,
          },
        };
      }
      // typed rejection honored honestly — never auto-accepted
      await this.recordStepSucceeded(principal, state, unit, material);
      return { attached: 0, rejected: 1, failure: null };
    }

    // Gate 3 — the V2-005 run-boundary attach BEFORE the durable
    // step-success record. The REAL boundary RAISES its typed rejections
    // (WorkflowRunError RUN_ATTESTATION_* — durably recorded in its command
    // ledger, never returned as a value): the typed throw is honored as the
    // boundary's rejection; anything else is not a rejection and rethrows.
    try {
      const attach = await this.recorder.attachAttestation(
        principal,
        this.command(state.run.id, `att-${attestation.attestationId}`),
        {
          runId: state.run.id,
          attemptNumber: state.attemptNumber,
          stepId: unit.unit,
          attestation,
          policy: {
            ...(this.policy.attestation.maxAgeMs !== undefined
              ? { maxAgeMs: this.policy.attestation.maxAgeMs }
              : {}),
            ...(this.policy.attestation.requiredAssurance !== undefined
              ? { requiredAssurance: this.policy.attestation.requiredAssurance }
              : {}),
            ...(this.policy.attestation.trustedAttesterKeyIds !== undefined
              ? { trustedAttesterKeyIds: this.policy.attestation.trustedAttesterKeyIds }
              : {}),
          },
        },
      );
      const attachFailed = attach.result as { ok?: boolean; code?: string; message?: string };
      if (attachFailed && typeof attachFailed.ok === 'boolean' && !attachFailed.ok) {
        // V2-005 boundary typed rejection (e.g. RUN_ATTESTATION_REPLAYED)
        if (this.policy.attestation.required) {
          return {
            attached: 0,
            rejected: 1,
            failure: {
              code: 'AGENT_ATTESTATION_REJECTED',
              detail: `the V2-005 run boundary rejected the required attestation: ${attachFailed.code ?? 'RUN_ATTESTATION_REJECTED'} — ${attachFailed.message ?? ''}`,
              recoverable: false,
            },
          };
        }
        await this.recordStepSucceeded(principal, state, unit, material);
        return { attached: 0, rejected: 1, failure: null };
      }
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (typeof code === 'string' && code.startsWith('RUN_ATTESTATION')) {
        if (this.policy.attestation.required) {
          return {
            attached: 0,
            rejected: 1,
            failure: {
              code: 'AGENT_ATTESTATION_REJECTED',
              detail: `the V2-005 run boundary rejected the required attestation: ${code} — ${(err as Error).message}`,
              recoverable: false,
            },
          };
        }
        await this.recordStepSucceeded(principal, state, unit, material);
        return { attached: 0, rejected: 1, failure: null };
      }
      throw err;
    }

    // Every attestation gate passed — NOW the durable step success (a
    // required-attestation failure can never leave a succeeded step, and
    // a crash between the attach and this record converges on re-drive:
    // the attestation binding is durable, the step record is idempotent).
    await this.recordStepSucceeded(principal, state, unit, material);
    return { attached: 1, rejected: 0, failure: null };
  }

  private async recordStepSucceeded(
    principal: WorkflowPrincipal,
    state: WalkState,
    unit: CompiledUnit,
    material: { outputCommitments: readonly string[] },
  ): Promise<void> {
    await this.recorder.recordStepCompleted(
      principal,
      this.command(state.run.id, `step-complete-${unit.unit}`),
      {
        runId: state.run.id,
        stepId: unit.unit,
        outcome: 'succeeded',
        outputCommitments: material.outputCommitments,
      },
    );
  }

  private async failStepRecord(
    principal: WorkflowPrincipal,
    state: WalkState,
    unit: CompiledUnit,
  ): Promise<void> {
    await this.recorder.recordStepCompleted(
      principal,
      this.command(state.run.id, `step-complete-${unit.unit}`),
      { runId: state.run.id, stepId: unit.unit, outcome: 'failed' },
    );
  }

  private stepFailureReport(
    unit: CompiledUnit,
    host: WalkHost | null,
    failure: AgentFailure,
  ): StepExecutionReport {
    return {
      stepId: unit.unit,
      executionClass: unit.executionClass,
      outcome: 'failed',
      actions: 0,
      observations: 0,
      attestationsAttached: 0,
      attestationsRejected: 0,
      failure,
      nodeId: host ? host.nodeId : null,
    };
  }

  // ==========================================================================
  // §7 Plan resolution + run loading (pin discipline)
  // ==========================================================================

  private async loadRun(principal: WorkflowPrincipal, runId: string): Promise<WorkflowRun> {
    const run = (await this.recorder.getRun(principal, runId)) as WorkflowRun;
    if (!run || typeof run !== 'object' || typeof run.id !== 'string') {
      throw new ComputerAgentError('COMPUTER_AGENT_RUN_NOT_FOUND', `run ${runId} not found`);
    }
    return run;
  }

  private async resolvePlanAndHistory(
    principal: WorkflowPrincipal,
    run: WorkflowRun,
  ): Promise<{ plan: CompiledWorkflowPlan; history: WorkflowRunHistory }> {
    const history = (await this.recorder.getRunHistory(principal, run.id)) as WorkflowRunHistory;
    const version = (await this.workflowRepository.getVersion(principal, run.workflowId, run.versionId)) as WorkflowVersion;
    // Version content is opaque to the repository; the runtime parses it
    // through the merged V2-003 parser (fail-closed on non-IR content).
    const document = parseWorkflowIrDocument(JSON.stringify(version.content));
    if (!document.ok) {
      throw new ComputerAgentError('COMPUTER_AGENT_INVALID_REQUEST', `pinned version content is not parseable WorkflowIR: ${document.issues.map((issue) => issue.code).join(', ')}`);
    }
    const digest = computeWorkflowVersionSemanticDigest(document.document);
    if (digest.digest !== run.versionSemanticDigest) {
      throw new ComputerAgentError(
        'COMPUTER_AGENT_INVALID_REQUEST',
        `pinned version semantic digest mismatch: run pins ${run.versionSemanticDigest}, parsed document is ${digest.digest}`,
      );
    }
    const compiled = compileWorkflow(document.document);
    if (!compiled.ok) {
      throw new ComputerAgentError(
        'COMPUTER_AGENT_INVALID_REQUEST',
        `pinned version does not compile: ${compiled.diagnostics.map((diagnostic) => diagnostic.code).join(', ')}`,
      );
    }
    return { plan: compiled.artifact.plan, history };
  }

  private command(runId: string, suffix: string): { commandId: string; correlationId: string } {
    return { commandId: `cmd-agent-${runId}-${suffix}`, correlationId: `agent-${runId}` };
  }

  // ==========================================================================
  // §8 In-drive observation memory (staleness + grounding lookup)
  // ============================================================================

  private readonly recentObservations = new Map<string, HostObservation>();

  private rememberObservation(observation: HostObservation): void {
    this.recentObservations.set(observation.observationId, observation);
  }

  private lookupRecentObservation(observationId: string): HostObservation | null {
    return this.recentObservations.get(observationId) ?? null;
  }
}

// ============================================================================
// §9 Pure helpers (deterministic ids, values, expectations, classification)
// ==========================================================================

/** ACT invocation id: drive-STABLE (host-ledger convergence = at-most-once). */
function invocationIdOf(runId: string, attemptNumber: number, stepId: string, cycle: number, seq: number): string {
  return `inv-${runId}-a${attemptNumber}-${stepId}-c${cycle}-${String(seq).padStart(4, '0')}`;
}

/** OBSERVATION invocation id: drive-fresh (reads re-execute honestly). */
function observationInvocationIdOf(runId: string, attemptNumber: number, drive: number, stepId: string, seq: number): string {
  return `inv-${runId}-a${attemptNumber}-d${drive}-${stepId}-${String(seq).padStart(4, '0')}`;
}

/** Takeover OBSERVATION id: drive-fresh (the human re-observes honestly). */
function takeoverObservationIdOf(runId: string, drive: number, stepId: string, seq: number): string {
  return `tak-${runId}-d${drive}-${stepId}-${String(seq).padStart(4, '0')}`;
}

function evidenceKey(scope: string, kind: string): string {
  return `${kind}-${scope}`;
}

function commitmentJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function initialValues(inputs: Readonly<Record<string, unknown>>): Map<string, unknown> {
  const values = new Map<string, unknown>();
  for (const [name, value] of Object.entries(inputs)) {
    values.set(name, value);
  }
  return values;
}

function latestAttemptNumber(history: WorkflowRunHistory): number {
  let max = 0;
  for (const attempt of history.attempts) {
    if (attempt.attemptNumber > max) {
      max = attempt.attemptNumber;
    }
  }
  return Math.max(max, 1);
}

function findPausedStep(history: WorkflowRunHistory): string | null {
  const suspended = history.attempts.find((attempt) => attempt.state === 'suspended');
  return suspended?.pausedAtStepId ?? null;
}

function findUnit(plan: CompiledWorkflowPlan, unitId: string): CompiledUnit | undefined {
  return plan.units.find((unit) => unit.unit === unitId);
}

function recordOf(
  invocationId: string,
  capability: string,
  kind: 'observe' | 'act',
  by: 'agent' | 'human',
  result: HostInvocationResult,
): AgentActionRecord {
  if (result.ok) {
    return {
      invocationId,
      capability,
      kind,
      by,
      ok: true,
      detail: result.kind === 'observed' ? `observed ${result.observation.subject}` : result.outcome.detail,
    };
  }
  return {
    invocationId,
    capability,
    kind,
    by,
    ok: false,
    failureCode: result.failure.code,
    detail: result.failure.detail,
  };
}

function classifyHostFailure(failure: { code: string; detail: string }): AgentFailure {
  switch (failure.code) {
    case 'HOST_TARGET_CHANGED':
      return { code: 'AGENT_TARGET_CHANGED', detail: failure.detail, recoverable: true };
    case 'HOST_TARGET_NOT_FOUND':
    case 'HOST_SUBJECT_NOT_FOUND':
      return { code: 'AGENT_TARGET_NOT_FOUND', detail: failure.detail, recoverable: true };
    case 'HOST_TRANSIENT_UNAVAILABLE':
      return { code: 'AGENT_HOST_TRANSIENT', detail: failure.detail, recoverable: true };
    case 'HOST_CAPABILITY_NOT_SUPPORTED':
      return {
        code: 'AGENT_HOST_PERMANENT',
        detail: `${failure.detail} (capability advertisement is what it is — never emulated)`,
        recoverable: false,
      };
    default:
      return { code: 'AGENT_HOST_PERMANENT', detail: failure.detail, recoverable: false };
  }
}

function matchesExpectation(
  observation: HostObservation,
  expect: { elementId?: string; kind?: string; label?: string; state?: string },
): boolean {
  return observation.elements.some((element) => {
    if (expect.elementId !== undefined && element.elementId !== expect.elementId) return false;
    if (expect.kind !== undefined && element.kind !== expect.kind) return false;
    if (expect.label !== undefined && element.label !== expect.label) return false;
    if (expect.state !== undefined && element.state !== expect.state) return false;
    return true;
  });
}

function resolveUnitInputs(
  unit: CompiledUnit,
  values: Map<string, unknown>,
  workflowInputs: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const binding of unit.inputs) {
    switch (binding.binding.kind) {
      case 'literal':
        resolved[binding.name] = binding.binding.value;
        break;
      case 'workflow_input':
        resolved[binding.name] = workflowInputs[binding.binding.input];
        break;
      case 'node_output': {
        const value = values.get(`${binding.binding.node}.${binding.binding.output}`);
        resolved[binding.name] = value === undefined ? null : value;
        break;
      }
      case 'secret_ref':
        // secrets never materialize here (constitution §16) — the port
        // carries the opaque handle only
        resolved[binding.name] = `[secret_ref:${binding.binding.ref}]`;
        break;
    }
  }
  return resolved;
}

function extractStructuredOutputs(
  unit: CompiledUnit,
  observation: HostObservation | null,
): Record<string, unknown> {
  const outputs: Record<string, unknown> = {};
  if (!observation) {
    return outputs;
  }
  for (const port of unit.outputs) {
    const element = observation.elements.find((candidate) => candidate.label === port.name);
    if (element) {
      outputs[port.name] = element.state;
    }
  }
  return outputs;
}

function resolveWorkflowOutputs(plan: CompiledWorkflowPlan, values: Map<string, unknown>): string[] {
  const commitments: string[] = [];
  for (const output of plan.outputs) {
    switch (output.from.kind) {
      case 'literal':
        commitments.push(commitmentJson(output.from.value));
        break;
      case 'workflow_input': {
        const value = values.get(output.from.input);
        commitments.push(commitmentJson(value ?? null));
        break;
      }
      case 'node_output': {
        const value = values.get(`${output.from.node}.${output.from.output}`);
        commitments.push(commitmentJson(value ?? null));
        break;
      }
      case 'secret_ref':
        commitments.push(commitmentJson(`[secret_ref:${output.from.ref}]`));
        break;
    }
  }
  return commitments;
}

/**
 * WORK-069 §9 — the progressive-release decision service (the feedback
 * binding layer's runtime composition).
 *
 * It CONSUMES the authorities and executes exactly the governed
 * consequences:
 *
 *   - the validation evidence is loaded through the WORK-064 authority's
 *     public `findRun` boundary (never re-admitted, re-finalized, or
 *     re-evaluated here);
 *   - the runtime observation is read through the /runtime port (the
 *     provider-recorded deployment state);
 *   - the decision is derived by the PURE policy (decision-policy.ts);
 *   - a non-continue decision's failure evidence flows through the
 *     WORK-067 authority's public intake (ingestValidationRun for the
 *     validation-originated source / ingestObservation for the
 *     runtime-observation and evidence-gap sources) — WORK-069 NEVER
 *     creates a Work Item, transitions a workflow, or mutates code;
 *   - a recover decision invokes the EXISTING rollback authority through
 *     its port (unbound today = the typed fail-closed outcome, never a
 *     silent continue);
 *   - the decision record is persisted through the repository port and
 *     emitted through the /audit application boundary.
 *
 * CONSEQUENCE DURABILITY PROTOCOL (the PR #108 architect-review
 * correction + the 2026-09-01 re-review claim correction): the decision
 * record is the ONLY idempotency boundary for the governed consequences,
 * so it is RESERVED (insert-only, persisted through the repository
 * port) BEFORE any governed consequence executes — a halt/recover's
 * consequences run only for the reservation owner, then the completion
 * transition records their real outcomes. A `continue` reserves
 * directly as executed (it carries no governed consequences). The
 * protocol's STRENGTH is the composed adapter's boundary: under a
 * DURABLE (PostgreSQL-class) adapter a crash or a concurrent delivery
 * can never re-execute a non-idempotent consequence (a rollback
 * invocation, a signal emission) for an identity that is already
 * reserved — the next delivery that finds a reserved-but-unresolved
 * (pending) reservation fails closed with the typed
 * PR_DECISION_CONSEQUENCES_PENDING. The PRODUCTION composition binds
 * the in-memory adapter (`migrations: []`), whose reservation is
 * PROCESS-LOCAL: duplicate delivery and completion failure are guarded
 * within one process, and CROSS-PROCESS consequence idempotency is NOT
 * claimed by that composition (the durable binding point is the
 * documented future ACR at the port — see types.ts §8).
 *
 * IDEMPOTENCY: the deterministic decision identity (release, stage,
 * validation run, runtime observation, scope) — a duplicate delivery
 * returns the recorded decision and re-executes NOTHING (no duplicate
 * halt action). A same-identity/different-content re-delivery is the
 * typed PR_DECISION_IDENTITY_CONFLICT.
 */
import type { RawObservationInput } from '../../engineering-signals/index.js';
import type {
  DecideProgressiveReleaseInput,
  HaltSignalOutcome,
  PriorRolloutState,
  ProgressiveConsequencePhase,
  ProgressiveDecisionReason,
  ProgressiveReleaseDecisionRecord,
  ProgressiveReleaseDecisionResult,
  ProgressiveReleaseService,
  ProgressiveReleaseServiceDeps,
  ProgressiveRolloutStage,
  RollbackInvocationResult,
  RuntimeObservationStatus,
  RolloutRuntimeObservation,
  ValidationEvidenceStatus,
} from '../types.js';
import { ProgressiveReleaseError, PROGRESSIVE_ROLLOUT_STAGES } from '../types.js';
import { deriveProgressiveDecision, PROGRESSIVE_POLICY_VERSION } from './decision-policy.js';
import {
  deriveContentFingerprint,
  deriveDecisionIdentity,
  requireValidDecisionRequest,
  runtimeObservationReference,
} from './decision-identity.js';

export class DefaultProgressiveReleaseService implements ProgressiveReleaseService {
  constructor(private readonly deps: ProgressiveReleaseServiceDeps) {}

  async decideProgressiveRelease(
    input: DecideProgressiveReleaseInput,
  ): Promise<ProgressiveReleaseDecisionResult> {
    // 0. the request validation (typed, fail closed).
    requireValidDecisionRequest(input);
    const stage = requireStage(input.rolloutStage);
    const now = input.now ?? this.deps.now;

    // 1. load the validation evidence through the WORK-064 authority.
    const validationEvidence = await this.loadValidationEvidence(input);

    // 2. read the runtime observation through the /runtime port and
    //    classify it (missing/ambiguous/unhealthy/healthy — the typed
    //    policy input; NEVER a synthesized healthy from absence).
    const runtimeObservation = await this.readRuntimeObservation(input.projectId);
    const runtimeStatus = classifyRuntimeObservation(runtimeObservation);

    // 3. derive the deterministic identity (the runtime observation
    //    participates — new facts, new decision event).
    const { decisionId, identityFingerprint } = deriveDecisionIdentity({
      tenantId: input.tenantId,
      projectId: input.projectId,
      releaseRef: input.releaseRef,
      rolloutStage: stage,
      validationRunId: input.validationRunId,
      runtimeObservationRef: runtimeObservationReference(runtimeObservation),
    });

    // 4. the recorded rollout history (the rollout state — never a second
    //    release engine; the decision history IS the state). The identity
    //    being re-delivered is EXCLUDED: its own prior record is the SAME
    //    logical event, not prior state (a re-delivery of a halt must
    //    re-derive the same halt, not collide with itself).
    const history = (
      await this.deps.decisionRepository.listForRollout(
        input.tenantId,
        input.projectId,
        input.releaseRef,
      )
    ).filter((r) => r.decisionId !== decisionId);
    const priorRolloutState = derivePriorRolloutState(history);

    // 5. the pure derivation.
    const derivation = deriveProgressiveDecision({
      stage,
      validationEvidence,
      runtimeObservation: runtimeStatus,
      priorRolloutState,
    });
    const validationOutcomeKind =
      validationEvidence.usable && validationEvidence.run.outcome !== null
        ? validationEvidence.run.outcome.kind
        : null;
    const contentFingerprint = deriveContentFingerprint({
      identityFingerprint,
      decision: derivation.decision,
      reason: derivation.reason,
      policyVersion: PROGRESSIVE_POLICY_VERSION,
      validationOutcomeKind,
    });

    // 6. idempotency: a prior decision with this identity decides. The
    //    content fingerprint is recomputed from the CURRENT derivation —
    //    an exact match is the idempotent duplicate (no consequence is
    //    re-executed); a mismatch means the same logical decision event
    //    would carry two different outcomes (the rollout history moved
    //    underneath it) — a typed conflict, never a silent rewrite. A
    //    reserved-but-PENDING record is the typed fail-closed tombstone
    //    (its consequences are unresolved — NEVER re-executed, never a
    //    clean duplicate).
    const prior = await this.deps.decisionRepository.findById(decisionId);
    if (prior !== null) {
      return this.classifyRecordedDecision(prior, contentFingerprint, input, stage);
    }

    // 7. RESERVE the decision record FIRST — the idempotency claim
    //    (persisted to the composed boundary) that MUST precede any
    //    governed consequence (the PR #108 architect-review correction:
    //    consequences executing before the record is persisted could
    //    repeat under a crash or a concurrent delivery — signal
    //    re-emission and, once the rollback authority is bound, a
    //    repeated rollback for the same decision identity). A
    //    `continue` decision carries NO governed consequences, so it
    //    reserves directly as EXECUTED (atomically final); a halt/recover
    //    reserves as PENDING and only the reservation owner executes and
    //    completes. A concurrent delivery that loses the insert race
    //    converges to the stored record and executes NOTHING.
    const consequencePhase: ProgressiveConsequencePhase =
      derivation.decision === 'continue' ? 'executed' : 'pending';
    const reservationRecord: ProgressiveReleaseDecisionRecord = {
      decisionId,
      identityFingerprint,
      contentFingerprint,
      tenantId: input.tenantId,
      projectId: input.projectId,
      environmentId: input.environmentId,
      releaseRef: input.releaseRef,
      rolloutStage: stage,
      validationRunId: input.validationRunId,
      runtimeObservation:
        runtimeObservation === null
          ? null
          : {
              kind: runtimeObservation.kind,
              deploymentId: runtimeObservation.deploymentId,
              deploymentStatus: runtimeObservation.deploymentStatus,
            },
      decision: derivation.decision,
      reason: derivation.reason,
      explanation: derivation.explanation,
      signalOutcomes: [],
      rollback: null,
      consequencePhase,
      validationOutcomeKind,
      policyVersion: PROGRESSIVE_POLICY_VERSION,
      decidedAt: now().toISOString(),
    };
    const reservation = await this.deps.decisionRepository.reserve(reservationRecord);
    if (reservation.status === 'converged') {
      // A concurrent delivery owns the decision identity (it won the
      // insert race): the STORED record decides our semantics — we execute
      // NOTHING.
      return this.classifyRecordedDecision(reservation.record, contentFingerprint, input, stage);
    }

    // 8. execute the governed consequences — the RESERVATION OWNER ONLY
    //    (the record is already persisted to the composed boundary; a
    //    crash from here on can never cause a re-execution within that
    //    boundary — the pending tombstone is what a durable adapter's
    //    process-loss retry, and an in-process re-delivery, both see).
    const signalOutcomes: HaltSignalOutcome[] = [];
    let rollback: RollbackInvocationResult | null = null;
    if (derivation.decision === 'halt' || derivation.decision === 'recover') {
      signalOutcomes.push(...(await this.emitFailureSignals(input, stage, derivation.reason, validationEvidence, runtimeObservation, now)));
    }
    if (derivation.decision === 'recover') {
      rollback = await this.invokeRollback(input, stage, decisionId, derivation.reason);
    }

    // 9. COMPLETE the reservation: the pending → executed transition
    //    recording the REAL consequence outcomes (the record now carries
    //    what actually happened). A `continue` record was atomically final
    //    at its reservation.
    const stored: ProgressiveReleaseDecisionRecord =
      derivation.decision === 'continue'
        ? reservation.record
        : await this.deps.decisionRepository.completeDecision(decisionId, {
            signalOutcomes,
            rollback,
          });

    // 10. the /audit forensic trail (supplementary — the /audit boundary's
    //     own discipline: audit is forensic history, not authority; a
    //     write failure after persistence must not fabricate a different
    //    decision, so it propagates as a typed error while the record
    //    stays persisted).
    if (this.deps.auditWriter !== undefined) {
      await this.deps.auditWriter.write({
        projectId: input.projectId,
        eventType: 'PROGRESSIVE_RELEASE_DECISION',
        actor: 'progressive-release',
        source: 'progressive-release',
        resourceType: 'progressive_release_rollout',
        resourceId: `${input.projectId}:${input.releaseRef}`,
        afterState: {
          decisionId,
          decision: derivation.decision,
          reason: derivation.reason,
          rolloutStage: stage,
          validationRunId: input.validationRunId,
        },
        metadata: {
          decisionId,
          decision: derivation.decision,
          reason: derivation.reason,
          policyVersion: PROGRESSIVE_POLICY_VERSION,
          rollbackInvoked: rollback === null ? null : rollback.invoked,
          signalsEmitted: signalOutcomes.length,
        },
      });
    }

    this.deps.logger?.info('progressive-release.decision.decided', {
      decisionId,
      releaseRef: input.releaseRef,
      stage,
      decision: derivation.decision,
      reason: derivation.reason,
      rollbackInvoked: rollback === null ? null : rollback.invoked,
      signals: signalOutcomes.length,
    });
    return { outcome: 'decided', decision: stored };
  }

  async findDecision(decisionId: string): Promise<ProgressiveReleaseDecisionRecord | null> {
    return this.deps.decisionRepository.findById(decisionId);
  }

  async listDecisionsForRollout(
    tenantId: string,
    projectId: string,
    releaseRef: string,
  ): Promise<readonly ProgressiveReleaseDecisionRecord[]> {
    return this.deps.decisionRepository.listForRollout(tenantId, projectId, releaseRef);
  }

  // --- the recorded-decision classification (the idempotency gate) ------

  /**
   * The classification of an already-reserved record against the CURRENT
   * derivation: a content mismatch is the typed conflict (the same
   * logical decision event cannot carry two different outcomes); an
   * EXECUTED record is the idempotent duplicate (no consequence is
   * re-executed); a PENDING record is the typed fail-closed tombstone —
   * its consequence execution is unresolved (in flight or interrupted by
   * a crash/authority failure between the reservation and the
   * completion), so the re-delivery NEVER re-executes the consequences
   * and NEVER reports a clean duplicate (the PR #108 architect-review
   * correction: a decision identity cannot execute a non-idempotent
   * consequence more than once).
   */
  private classifyRecordedDecision(
    prior: ProgressiveReleaseDecisionRecord,
    contentFingerprint: string,
    input: DecideProgressiveReleaseInput,
    stage: ProgressiveRolloutStage,
  ): ProgressiveReleaseDecisionResult {
    if (prior.contentFingerprint !== contentFingerprint) {
      throw new ProgressiveReleaseError(
        'PR_DECISION_IDENTITY_CONFLICT',
        `decision ${prior.decisionId} (release '${input.releaseRef}', stage '${stage}', run '${input.validationRunId}') is already recorded as ${prior.decision}/${prior.reason} but the current facts derive a different outcome — the same logical decision event cannot carry two different outcomes; reconcile the rollout state before re-delivering`,
      );
    }
    if (prior.consequencePhase === 'executed') {
      this.deps.logger?.info('progressive-release.decision.duplicate', {
        decisionId: prior.decisionId,
        releaseRef: input.releaseRef,
        stage,
        decision: prior.decision,
      });
      return { outcome: 'duplicate', decision: prior };
    }
    throw new ProgressiveReleaseError(
      'PR_DECISION_CONSEQUENCES_PENDING',
      `decision ${prior.decisionId} (release '${prior.releaseRef}', stage '${prior.rolloutStage}', run '${prior.validationRunId}') is reserved but its governed consequences are unresolved (persisted through the composed boundary and pending — in flight, or interrupted by a crash/authority failure between the reservation and the completion); the re-delivery does NOT re-execute them and does NOT report a duplicate: reconcile the pending reservation through the governed path`,
    );
  }

  // --- the validation evidence (the WORK-064 authority consumed) ----------

  private async loadValidationEvidence(
    input: DecideProgressiveReleaseInput,
  ): Promise<ValidationEvidenceStatus> {
    const authority = this.deps.continuousValidationService;
    if (authority === undefined) {
      throw new ProgressiveReleaseError(
        'PR_VALIDATION_AUTHORITY_UNBOUND',
        'the WORK-064 continuous-validation authority is not bound (the progressive-release decision fails closed — never a silent continue)',
      );
    }
    const run = await authority.findRun(input.validationRunId);
    if (run === null) {
      return { usable: false, reason: 'HALT_VALIDATION_RUN_NOT_FOUND' };
    }
    if (run.status !== 'completed' || run.outcome === null) {
      return { usable: false, reason: 'HALT_VALIDATION_RUN_NOT_COMPLETED' };
    }
    // The binding checks: the run must be the POST_RELEASE/RELEASE run of
    // THIS rollout's release, environment, and tenant (cross-scope
    // evidence is a typed halt — §14 wrong release/environment/cross-tenant).
    if (run.mode !== 'POST_RELEASE') {
      return { usable: false, reason: 'HALT_VALIDATION_MODE_NOT_POST_RELEASE' };
    }
    if (run.trigger !== 'RELEASE') {
      return { usable: false, reason: 'HALT_VALIDATION_TRIGGER_NOT_RELEASE' };
    }
    if (run.releaseRef !== input.releaseRef) {
      return { usable: false, reason: 'HALT_VALIDATION_RELEASE_REF_MISMATCH' };
    }
    if (run.identity.tenantId !== null && run.identity.tenantId !== input.tenantId) {
      return { usable: false, reason: 'HALT_VALIDATION_TENANT_MISMATCH' };
    }
    if (run.environmentId !== input.environmentId) {
      return { usable: false, reason: 'HALT_VALIDATION_ENVIRONMENT_MISMATCH' };
    }
    return { usable: true, run };
  }

  // --- the runtime observation (the /runtime authority consumed) ----------

  private async readRuntimeObservation(projectId: string): Promise<RolloutRuntimeObservation | null> {
    if (this.deps.runtimeObservationReader === undefined) return null;
    return this.deps.runtimeObservationReader.readLatestDeploymentObservation(projectId);
  }

  // --- the failure signals (the WORK-067 authority consumed) --------------

  private async emitFailureSignals(
    input: DecideProgressiveReleaseInput,
    stage: ProgressiveRolloutStage,
    reason: ProgressiveDecisionReason,
    validationEvidence: ValidationEvidenceStatus,
    runtimeObservation: RolloutRuntimeObservation | null,
    now: () => Date,
  ): Promise<HaltSignalOutcome[]> {
    const signalAuthority = this.deps.engineeringSignalService;
    if (signalAuthority === undefined) {
      throw new ProgressiveReleaseError(
        'PR_SIGNAL_AUTHORITY_UNBOUND',
        'the WORK-067 engineering-signal authority is not bound (the halt/recover signal consequence fails closed — never a silent no-op)',
      );
    }
    const outcomes: HaltSignalOutcome[] = [];

    // (a) the validation-originated source: a COMPLETED-but-failed run's
    //     EVERY failure becomes an occurrence through the authority's own
    //     WORK-064 adapter (healthy runs record NO signal — the honest
    //     no-signal case).
    if (
      validationEvidence.usable &&
      validationEvidence.run.outcome !== null &&
      validationEvidence.run.outcome.kind !== 'healthy'
    ) {
      const result = await signalAuthority.ingestValidationRun({
        runId: validationEvidence.run.id,
        projectId: input.projectId,
        tenantId: input.tenantId,
        now,
      });
      outcomes.push(
        ...result.results.map((r) => ({
          signalId: r.signal.signalId,
          occurrenceId: r.occurrenceId,
          outcome: r.outcome,
          logicalFailureKey: r.signal.logicalFailureKey,
        })),
      );
    }

    // (b) the runtime-observation source: an unhealthy/not-ready runtime
    //     observation is a raw runtime failure through the seam (source
    //     'runtime'; the deployment record's OWN observed time — never the
    //     decision clock).
    if (
      runtimeObservation !== null &&
      (runtimeObservation.deploymentStatus === 'error' ||
        runtimeObservation.deploymentStatus === 'canceled') &&
      isRuntimeDrivenReason(reason)
    ) {
      const result = await signalAuthority.ingestObservation(
        runtimeFailureObservation(input, stage, reason, runtimeObservation),
      );
      outcomes.push({
        signalId: result.signal.signalId,
        occurrenceId: result.occurrenceId,
        outcome: result.outcome,
        logicalFailureKey: result.signal.logicalFailureKey,
      });
    }

    // (c) the evidence-gap source: a halt caused by MISSING/UNUSABLE
    //     validation evidence or a MISSING runtime observation records the
    //     evidence gap itself (source 'validation' / the requested-run
    //     reference — the rollout was asked to proceed without provable
    //     safety; that IS the engineering finding).
    if (isEvidenceGapReason(reason)) {
      const result = await signalAuthority.ingestObservation(
        evidenceGapObservation(input, stage, reason, now),
      );
      outcomes.push({
        signalId: result.signal.signalId,
        occurrenceId: result.occurrenceId,
        outcome: result.outcome,
        logicalFailureKey: result.signal.logicalFailureKey,
      });
    }

    // (d) the release correlation: when the caller recorded the release
    //     boundary time (releaseObservedAt), every produced signal is
    //     correlated to the rollout's release through the WORK-067
    //     authority's own correlation engine (recordedVia 'caller-declared';
    //     the occurrence's own recorded releaseRef remains the CAUSAL
    //     basis — the authority's provenance discipline, never an inference
    //     here). When absent, the correlation is skipped — WORK-067's
    //     fail-closed 'unavailable' assessment stays honest (never an
    //     inferred release boundary).
    if (input.releaseObservedAt !== undefined) {
      for (const outcome of outcomes) {
        await signalAuthority.correlateToReleases({
          signalId: outcome.signalId,
          releaseContexts: [
            {
              releaseRef: input.releaseRef,
              releasedAt: input.releaseObservedAt,
              projectId: input.projectId,
              recordedVia: 'caller-declared',
            },
          ],
          now,
        });
      }
    }

    return outcomes;
  }

  // --- the rollback invocation (the EXISTING authority consumed) ----------

  private async invokeRollback(
    input: DecideProgressiveReleaseInput,
    stage: ProgressiveRolloutStage,
    decisionId: string,
    reason: ProgressiveDecisionReason,
  ): Promise<RollbackInvocationResult> {
    if (this.deps.rollbackAuthority === undefined) {
      // Repository truth: no rollback authority exists today. The RECOVER
      // decision is still derived and recorded — with the rollback
      // explicitly NOT invoked and the failure signal already emitted, so
      // the governed chain sees the un-executed recovery. NEVER a silent
      // continue (fail closed, full visibility).
      return { invoked: false, reason: 'ROLLBACK_AUTHORITY_UNBOUND' };
    }
    return this.deps.rollbackAuthority.invokeRollback({
      tenantId: input.tenantId,
      projectId: input.projectId,
      releaseRef: input.releaseRef,
      rolloutStage: stage,
      decisionId,
      reason,
    });
  }
}

// --- the pure helpers --------------------------------------------------------

function requireStage(stage: string): ProgressiveRolloutStage {
  if ((PROGRESSIVE_ROLLOUT_STAGES as readonly string[]).includes(stage)) {
    return stage as ProgressiveRolloutStage;
  }
  throw new ProgressiveReleaseError(
    'PR_INPUT_STAGE_INVALID',
    `rolloutStage '${stage}' is not one of the closed vocabulary [canary, partial, full] (foreign values fail closed)`,
  );
}

/** The recorded rollout state derived from the decision history. */
export function derivePriorRolloutState(
  history: readonly ProgressiveReleaseDecisionRecord[],
): PriorRolloutState {
  let previouslyHalted = false;
  let previouslyRecovered = false;
  let highestDecidedStage: ProgressiveRolloutStage | null = null;
  for (const record of history) {
    if (record.decision === 'halt') previouslyHalted = true;
    if (record.decision === 'recover') previouslyRecovered = true;
    if (highestDecidedStage === null || stageRank(record.rolloutStage) > stageRank(highestDecidedStage)) {
      highestDecidedStage = record.rolloutStage;
    }
  }
  return { previouslyHalted, previouslyRecovered, highestDecidedStage };
}

function stageRank(stage: ProgressiveRolloutStage): number {
  return stage === 'canary' ? 0 : stage === 'partial' ? 1 : 2;
}

/**
 * The typed classification of the runtime observation (the policy input):
 * missing → unavailable; queued/building → not-ready (ambiguous); ready →
 * healthy; error/canceled → unhealthy. NEVER a healthy default from
 * absence or ambiguity (fail closed).
 */
function classifyRuntimeObservation(
  observation: RolloutRuntimeObservation | null,
): RuntimeObservationStatus {
  if (observation === null) return { state: 'unavailable' };
  switch (observation.deploymentStatus) {
    case 'ready':
      return { state: 'healthy', observation };
    case 'error':
    case 'canceled':
      return { state: 'unhealthy', observation };
    case 'queued':
    case 'building':
      return { state: 'not-ready', observation };
  }
}

/** The runtime-driven decision reasons (the runtime observation is the decisive evidence). */
function isRuntimeDrivenReason(reason: ProgressiveDecisionReason): boolean {
  return reason === 'HALT_RUNTIME_UNHEALTHY' || reason === 'RECOVER_CANARY_RUNTIME_UNHEALTHY';
}

/** The evidence-gap decision reasons (the missing/unusable evidence is the finding). */
function isEvidenceGapReason(reason: ProgressiveDecisionReason): boolean {
  return (
    reason === 'HALT_VALIDATION_RUN_NOT_FOUND' ||
    reason === 'HALT_VALIDATION_RUN_NOT_COMPLETED' ||
    reason === 'HALT_VALIDATION_MODE_NOT_POST_RELEASE' ||
    reason === 'HALT_VALIDATION_TRIGGER_NOT_RELEASE' ||
    reason === 'HALT_VALIDATION_RELEASE_REF_MISMATCH' ||
    reason === 'HALT_VALIDATION_TENANT_MISMATCH' ||
    reason === 'HALT_VALIDATION_ENVIRONMENT_MISMATCH' ||
    reason === 'HALT_RUNTIME_OBSERVATION_UNAVAILABLE' ||
    reason === 'HALT_RUNTIME_OBSERVATION_NOT_READY'
  );
}

/** The raw runtime-failure observation (source 'runtime'; the deployment record's own time). */
function runtimeFailureObservation(
  input: DecideProgressiveReleaseInput,
  stage: ProgressiveRolloutStage,
  reason: ProgressiveDecisionReason,
  observation: RolloutRuntimeObservation,
): RawObservationInput {
  return {
    source: 'runtime',
    tenantId: input.tenantId,
    projectId: input.projectId,
    environmentId: input.environmentId,
    logicalFailureKey: `progressive-release:runtime-deployment:${observation.deploymentStatus}`,
    severity: 'high',
    observedAt: observation.observedAt,
    observationRef: {
      kind: 'runtime-deployment',
      ref: observation.deploymentId,
      detail: `progressive-release ${reason} at stage '${stage}' (deployment status '${observation.deploymentStatus}')`,
    },
    raw: {
      progressiveReleaseReason: reason,
      rolloutStage: stage,
      deploymentId: observation.deploymentId,
      deploymentStatus: observation.deploymentStatus,
    },
    releaseRef: input.releaseRef,
  };
}

/** The raw evidence-gap observation (source 'validation'; the requested-run reference). */
function evidenceGapObservation(
  input: DecideProgressiveReleaseInput,
  stage: ProgressiveRolloutStage,
  reason: ProgressiveDecisionReason,
  now: () => Date,
): RawObservationInput {
  return {
    source: 'validation',
    tenantId: input.tenantId,
    projectId: input.projectId,
    environmentId: input.environmentId,
    logicalFailureKey: `progressive-release:evidence-gap:${reason}`,
    severity: 'high',
    // The decision time (the injected clock — the moment the governed
    // consumer observed the gap; deterministic under injection).
    observedAt: now().toISOString(),
    observationRef: {
      kind: 'progressive-release-request',
      ref: input.validationRunId,
      detail: `progressive-release ${reason} at stage '${stage}' (the requested validation binding is missing/unusable)`,
    },
    raw: {
      progressiveReleaseReason: reason,
      rolloutStage: stage,
      requestedValidationRunId: input.validationRunId,
      releaseRef: input.releaseRef,
    },
    releaseRef: input.releaseRef,
  };
}

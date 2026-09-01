/**
 * WORK-069 §4 — the deterministic continue/halt/recover derivation (the
 * governed-decision contract). PURE: no I/O, no clock, no randomness —
 * the decision is a total function over the RECORDED facts. Every cell of
 * the matrix is typed (PROGRESSIVE_DECISION_REASONS) and explainable.
 *
 * POLICY (documented in full — this IS the governed policy):
 *
 *   0. Rollout-state gating (the recorded history is authoritative):
 *      - a rollout whose latest recorded decision was `recover` is DONE →
 *        HALT_ROLLOUT_PREVIOUSLY_RECOVERED;
 *      - a rollout whose latest recorded decision was `halt` is STOPPED →
 *        HALT_ROLLOUT_PREVIOUSLY_HALTED;
 *      - a request whose stage is EARLIER than a previously judged stage
 *        is an invalid stage transition → HALT_INVALID_STAGE_TRANSITION.
 *   1. Evidence gating (fail closed — §14): unusable validation evidence
 *      (not found / not completed / wrong mode / wrong trigger / wrong
 *      release / wrong tenant / wrong environment) → the typed
 *      HALT_VALIDATION_* halt. Missing runtime observation →
 *      HALT_RUNTIME_OBSERVATION_UNAVAILABLE. Ambiguous runtime
 *      observation (queued/building — not yet observable) →
 *      HALT_RUNTIME_OBSERVATION_NOT_READY. NONE of these may continue.
 *   2. RECOVER (the rollback cases — the most severe first):
 *      - effect_policy_violation at ANY stage: a FORBIDDEN effect was
 *        attempted in the production rollout → RECOVER_EFFECT_POLICY_VIOLATION;
 *      - validation_failure while contained at CANARY →
 *        RECOVER_CANARY_VALIDATION_FAILURE (the canary exists to catch
 *        exactly this; rolling it back is the cheap, safe recovery);
 *      - an unhealthy runtime observation (deployment error/canceled)
 *        while contained at CANARY → RECOVER_CANARY_RUNTIME_UNHEALTHY.
 *   3. HALT (failure semantics at the exposed stages):
 *      - validation_failure at partial/full → HALT_VALIDATION_FAILURE
 *        (stop the rollout; the signal feeds the governed chain);
 *      - environment_error → HALT_VALIDATION_ENVIRONMENT_ERROR (the
 *        validation evidence itself is unusable — stop, do not roll back);
 *      - unhealthy runtime at partial/full → HALT_RUNTIME_UNHEALTHY.
 *   4. CONTINUE — the ONLY continue cell: a COMPLETED validation run with
 *      a `healthy` outcome AND a `ready` runtime observation AND every
 *      binding matched → CONTINUE_VALIDATION_HEALTHY_RUNTIME_READY.
 */
import type {
  DerivationResult,
  PriorRolloutState,
  ProgressiveRolloutStage,
  RuntimeObservationStatus,
  ValidationEvidenceStatus,
} from '../types.js';

/** The policy version recorded on every decision (reproducibility). */
export const PROGRESSIVE_POLICY_VERSION = 'work-069-progressive-release-policy-1';

/** The pure derivation (total, deterministic, explainable). */
export function deriveProgressiveDecision(input: {
  readonly stage: ProgressiveRolloutStage;
  readonly validationEvidence: ValidationEvidenceStatus;
  readonly runtimeObservation: RuntimeObservationStatus;
  readonly priorRolloutState: PriorRolloutState;
}): DerivationResult {
  const { stage, validationEvidence, runtimeObservation, priorRolloutState } = input;

  // --- 0. the recorded rollout state gates everything --------------------
  if (priorRolloutState.previouslyRecovered) {
    return {
      decision: 'halt',
      reason: 'HALT_ROLLOUT_PREVIOUSLY_RECOVERED',
      explanation:
        'the rollout was previously RECOVERED (rolled back) — a recorded recover decision ended this release rollout; a new decision requires a NEW recorded release identity, never a re-entry into a recovered rollout (fail closed)',
    };
  }
  if (priorRolloutState.previouslyHalted) {
    return {
      decision: 'halt',
      reason: 'HALT_ROLLOUT_PREVIOUSLY_HALTED',
      explanation:
        'the rollout was previously HALTED by a recorded decision — resuming this release rollout is a governed act outside this decision layer (fail closed; the halt stays authoritative)',
    };
  }
  if (
    priorRolloutState.highestDecidedStage !== null &&
    stageOrder(stage) < stageOrder(priorRolloutState.highestDecidedStage)
  ) {
    return {
      decision: 'halt',
      reason: 'HALT_INVALID_STAGE_TRANSITION',
      explanation:
        `the requested stage '${stage}' is EARLIER than the recorded stage '${priorRolloutState.highestDecidedStage}' already judged for this release — ` +
        'a progressive rollout only advances (canary → partial → full); a stage regression is an inconsistent rollout state (fail closed)',
    };
  }

  // --- 1. evidence gating (fail closed — never a silent continue) --------
  if (!validationEvidence.usable) {
    return {
      decision: 'halt',
      reason: validationEvidence.reason,
      explanation: `the POST_RELEASE validation evidence binding is unusable (${validationEvidence.reason}) — a progressive-release decision NEVER continues on missing, incomplete, or mis-scoped validation evidence (fail closed)`,
    };
  }
  if (runtimeObservation.state === 'unavailable') {
    return {
      decision: 'halt',
      reason: 'HALT_RUNTIME_OBSERVATION_UNAVAILABLE',
      explanation:
        'no runtime observation was available from the /runtime authority for this rollout — a missing observation is NEVER healthy (fail closed; missing evidence cannot become continue)',
    };
  }
  if (runtimeObservation.state === 'not-ready') {
    return {
      decision: 'halt',
      reason: 'HALT_RUNTIME_OBSERVATION_NOT_READY',
      explanation:
        `the runtime deployment observation is '${runtimeObservation.observation.deploymentStatus}' (not yet observable) — an ambiguous runtime state is a typed halt, never a continue (fail closed)`,
    };
  }

  // --- 2. the recover cases (most severe first) ---------------------------
  const outcomeKind = validationEvidence.run.outcome === null ? null : validationEvidence.run.outcome.kind;
  if (outcomeKind === 'effect_policy_violation') {
    return {
      decision: 'recover',
      reason: 'RECOVER_EFFECT_POLICY_VIOLATION',
      explanation:
        `the completed POST_RELEASE validation recorded an EFFECT POLICY VIOLATION (a FORBIDDEN effect was attempted against the production rollout at the '${stage}' stage) — the release is unsafe at every stage; the governed consequence is RECOVER (the existing rollback authority)`,
    };
  }
  if (outcomeKind === 'validation_failure' && stage === 'canary') {
    return {
      decision: 'recover',
      reason: 'RECOVER_CANARY_VALIDATION_FAILURE',
      explanation:
        'the canary-stage POST_RELEASE validation FAILED while the exposure is still contained at the canary — the canary exists to catch exactly this; the governed consequence is RECOVER (roll the canary back through the existing rollback authority)',
    };
  }
  if (runtimeObservation.state === 'unhealthy' && stage === 'canary') {
    return {
      decision: 'recover',
      reason: 'RECOVER_CANARY_RUNTIME_UNHEALTHY',
      explanation:
        `the canary-stage runtime deployment observation is UNHEALTHY ('${runtimeObservation.observation.deploymentStatus}') while the exposure is still contained at the canary — the governed consequence is RECOVER (roll the canary back through the existing rollback authority)`,
    };
  }

  // --- 3. the halt cases (failure semantics at the exposed stages) --------
  if (outcomeKind === 'validation_failure') {
    return {
      decision: 'halt',
      reason: 'HALT_VALIDATION_FAILURE',
      explanation:
        `the POST_RELEASE validation FAILED at the '${stage}' stage (the exposure has already progressed beyond the canary) — the rollout stops here; the failure evidence flows as an Engineering Signal (WORK-067 → the governed chain)`,
    };
  }
  if (outcomeKind === 'environment_error') {
    return {
      decision: 'halt',
      reason: 'HALT_VALIDATION_ENVIRONMENT_ERROR',
      explanation:
        'the POST_RELEASE validation recorded an ENVIRONMENT ERROR — the validation evidence itself is unusable (the environment failed, not necessarily the product); the rollout stops (fail closed) and the environment failure flows as an Engineering Signal',
    };
  }
  if (runtimeObservation.state === 'unhealthy') {
    return {
      decision: 'halt',
      reason: 'HALT_RUNTIME_UNHEALTHY',
      explanation:
        `the runtime deployment observation is UNHEALTHY ('${runtimeObservation.observation.deploymentStatus}') at the '${stage}' stage — the rollout stops here; the runtime failure flows as an Engineering Signal (WORK-067 → the governed chain)`,
    };
  }

  // --- 4. the only continue cell -------------------------------------------
  // outcomeKind === 'healthy' && runtimeObservation.state === 'ready'
  return {
    decision: 'continue',
    reason: 'CONTINUE_VALIDATION_HEALTHY_RUNTIME_READY',
    explanation:
      `the completed POST_RELEASE validation is HEALTHY and the runtime deployment observation is READY at the '${stage}' stage with every binding matched (release, environment, tenant, mode, trigger) — the governed consequence is CONTINUE (the existing release authority proceeds with the rollout)`,
  };
}

function stageOrder(stage: ProgressiveRolloutStage): number {
  return stage === 'canary' ? 0 : stage === 'partial' ? 1 : 2;
}

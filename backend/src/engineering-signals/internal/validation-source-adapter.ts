/**
 * WORK-067 — the WORK-064 validation-source adapter.
 *
 * Derives raw observation inputs from a COMPLETED ValidationRun — the
 * primary validation-originated signal source, consumed through the WORK-064
 * domain's own record type (the public barrel; NEVER a re-implementation
 * of admission/finalization/health). The mapping is DETERMINISTIC and
 * fail-closed:
 *
 *   - `healthy` runs produce NO observations (the honest no-signal case —
 *     NOT a silent conversion: failures ALWAYS produce observations, and
 *     a healthy outcome is itself a WORK-064 authority determination this
 *     layer never re-derives);
 *   - EVERY `validation_failure` in the outcome becomes ONE observation
 *     (per failed expectation) — nothing dropped;
 *   - `effect_policy_violation` and `environment_error` become one
 *     observation each (typed, severity-mapped, reason preserved in the
 *     raw payload);
 *   - the logical failure key is derived deterministically from the
 *     failure's identity (journey + step + expectation id — the WORK-064
 *     canonical declaration);
 *   - the severity mapping is the DOCUMENTED deterministic assessment
 *     (the WORK-041 maintenance-detector precedent — the detector's
 *     severity is its declared assessment, not an invention):
 *       validation_failure        → 'high'    (a failed product validation)
 *       effect_policy_violation   → 'critical'(a safety-boundary violation)
 *       environment_error         → 'medium'  (the check could not run)
 *   - the causal release binding is the run's RECORDED releaseRef
 *     (POST_RELEASE runs carry it; never invented here);
 *   - the scope is caller-supplied (the run record carries no project)
 *     and VALIDATED against the run's identity tenant binding
 *     (fail-closed on mismatch — no cross-tenant observation).
 */
import { EngineeringSignalError } from '../types.js';
import type { RawObservationInput, SignalSeverity } from '../types.js';
import type { ValidationRun } from '../../continuous-validation/types.js';

/** The scope a governed caller supplies for a validation-run ingestion. */
export interface ValidationObservationScope {
  readonly projectId: string;
  readonly tenantId: string;
}

/** The documented outcome-kind → severity mapping (the detector-assessment precedent). */
export const VALIDATION_OUTCOME_SEVERITY: Readonly<
  Record<'validation_failure' | 'effect_policy_violation' | 'environment_error', SignalSeverity>
> = {
  validation_failure: 'high',
  effect_policy_violation: 'critical',
  environment_error: 'medium',
};

function requireScope(scope: ValidationObservationScope): ValidationObservationScope {
  if (typeof scope.projectId !== 'string' || scope.projectId.trim() === '') {
    throw new EngineeringSignalError('SIGNAL_PROJECT_REQUIRED', 'the validation-run ingestion requires a non-empty project scope');
  }
  if (typeof scope.tenantId !== 'string' || scope.tenantId.trim() === '') {
    throw new EngineeringSignalError('SIGNAL_TENANT_REQUIRED', 'the validation-run ingestion requires a non-empty tenant scope');
  }
  return scope;
}

/**
 * Derive the raw observation inputs from a COMPLETED validation run.
 * Deterministic; typed rejections for un-completed runs and scope
 * mismatches; a healthy run yields NO observations (the honest no-signal
 * case); a failed run's EVERY failure yields one observation.
 */
export function validationRunToObservationInputs(
  run: ValidationRun,
  scope: ValidationObservationScope,
): readonly RawObservationInput[] {
  requireScope(scope);
  if (run.status !== 'completed' || run.outcome === null) {
    throw new EngineeringSignalError(
      'SIGNAL_VALIDATION_RUN_NOT_COMPLETED',
      `run ${run.id} is ${run.status} (outcome ${run.outcome === null ? 'null' : 'present'}) — only COMPLETED runs produce observations`,
    );
  }
  // The scope must match the run's own identity tenant binding (when the
  // binding carries one — the fail-closed cross-tenant guard).
  if (run.identity.tenantId !== null && run.identity.tenantId !== scope.tenantId) {
    throw new EngineeringSignalError(
      'SIGNAL_SCOPE_MISMATCH',
      `run ${run.id} is bound to tenant '${run.identity.tenantId}' but the ingestion scope declares tenant '${scope.tenantId}' (no cross-tenant observation)`,
    );
  }
  const releaseRef = run.releaseRef === undefined || run.releaseRef === null ? null : run.releaseRef;
  const observations: RawObservationInput[] = [];

  if (run.outcome.kind === 'healthy') {
    // A healthy run records NO failure signal (the honest no-signal case).
    return observations;
  }

  if (run.outcome.kind === 'validation_failure') {
    for (const failure of run.outcome.failures) {
      observations.push({
        source: 'validation',
        tenantId: scope.tenantId,
        projectId: scope.projectId,
        environmentId: run.environmentId,
        logicalFailureKey: `validation:${run.journeyId}:${failure.failedStepId}:${failure.expected.id}`,
        severity: VALIDATION_OUTCOME_SEVERITY.validation_failure,
        observedAt: failure.provenance.observedAt,
        observationRef: {
          kind: 'validation-run-failure',
          ref: run.id,
          detail: `journey ${run.journeyId} step ${failure.failedStepId} expectation ${failure.expected.id} (kind ${failure.expected.kind})`,
        },
        // The FULL failure record preserved verbatim (expected + actual +
        // provenance — the reconstructable causal chain).
        raw: failure,
        releaseRef,
      });
    }
    return observations;
  }

  if (run.outcome.kind === 'effect_policy_violation' || run.outcome.kind === 'environment_error') {
    const severity: SignalSeverity =
      run.outcome.kind === 'effect_policy_violation'
        ? VALIDATION_OUTCOME_SEVERITY.effect_policy_violation
        : VALIDATION_OUTCOME_SEVERITY.environment_error;
    observations.push({
      source: 'validation',
      tenantId: scope.tenantId,
      projectId: scope.projectId,
      environmentId: run.environmentId,
      logicalFailureKey: `validation:${run.journeyId}:${run.outcome.kind}`,
      severity,
      observedAt: run.completedAt ?? run.createdAt,
      observationRef: {
        kind: `validation-run-${run.outcome.kind}`,
        ref: run.id,
        detail: `journey ${run.journeyId} mode ${run.mode} trigger ${run.trigger}`,
      },
      raw: run.outcome,
      releaseRef,
    });
    return observations;
  }

  throw new EngineeringSignalError(
    'SIGNAL_SOURCE_UNKNOWN',
    `run ${run.id} carries an unknown outcome kind '${String((run.outcome as { kind?: unknown }).kind)}' (fail closed)`,
  );
}

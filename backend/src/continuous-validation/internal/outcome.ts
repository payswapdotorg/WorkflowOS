/**
 * WORK-064 Task 6b — the typed outcome finalization with full provenance.
 *
 * THE INVARIANT (spec/work-orders/WORK-064.md invariant 6 + required proof
 * 5; evidence-provenance-model §5): a validation failure is never silently
 * discarded, never converted into a false healthy state, and never directly
 * converted into an ungoverned code change.
 *
 * Finalization derives the typed outcome deterministically:
 *
 *   executionError → effect_policy_violation | environment_error (typed,
 *                    provenance preserved — never healthy);
 *   otherwise      → health is determined by the DECLARED SUCCESS CRITERIA
 *                    (the model contract, PR #86 review correction 2): a
 *                    criterion is satisfied iff EVERY observation it
 *                    requires has a matched result, and the run is healthy
 *                    iff EVERY declared criterion is satisfied. Any
 *                    required observation missing or unmatched is an
 *                    explicit validation_failure record (actual: null for
 *                    missing). An expectation NOT required by any criterion
 *                    is OBSERVATIONAL: an unmet observational expectation
 *                    never fails the run and never flips health — when the
 *                    run does fail, it is still recorded with full
 *                    provenance (nothing is silently dropped), and when the
 *                    run is healthy its captured actual is preserved in the
 *                    run's observations;
 *   canonical      → every result's `expected` must quote the journey's
 *                    canonical declaration EXACTLY (deep structural
 *                    equality on id/stepId/kind/description/matcher — PR
 *                    #86 review correction 1): a future executor cannot
 *                    retain an expectation's id while altering its matcher
 *                    and claiming `matched: true` — health can never be
 *                    derived from an executor-supplied expectation;
 *   derived match   → the caller-supplied `result.matched` is an ASSERTION,
 *                    never a determination (PR #86 review correction 3):
 *                    finalization independently recomputes the match with
 *                    the authoritative deterministic evaluator
 *                    (evaluateObservation: canonical expectation + actual
 *                    observation) and REJECTS any result whose asserted
 *                    `matched` contradicts the derived value. Health (and
 *                    failure) flow from the DERIVED value only — an
 *                    executor can fabricate neither a false healthy (actual
 *                    wrong + matched:true) nor a false failure (actual
 *                    right + matched:false).
 *
 * There is NO code path from an absent/invalid/unrequired-by-criteria
 * observation to a false `healthy` state: the criteria are the declared
 * health contract, and the expectations they require are verified against
 * the canonical journey declaration.
 */
import type {
  ExecutionError,
  ExpectedObservation,
  ObservationProvenance,
  ObservationResult,
  ValidationFailure,
  ValidationJourney,
  ValidationObservation,
  ValidationOutcome,
  ValidationRun,
} from '../types.js';
import { ValidationDomainError } from '../types.js';
import { deepEquals, evaluateObservation } from './observation.js';

/** The finalization input. */
export interface FinalizeValidationRunInput {
  /** The ADMITTED run being finalized. */
  readonly run: ValidationRun;
  /** The journey the run executes (must match run.journeyId). */
  readonly journey: ValidationJourney;
  /**
   * The evaluated observation results. Each result must reference the
   * journey's expectations — quoting the canonical declaration EXACTLY
   * (verified by structural equality; variants are rejected) — and its
   * `matched` field is an ASSERTION that finalization verifies against the
   * independently derived evaluation (a contradicting assertion is
   * rejected; the derived value determines the outcome).
   */
  readonly results: readonly ObservationResult[];
  /** An execution-level error reported by the executor, if any. */
  readonly executionError?: ExecutionError;
  /** Deterministic completion timestamp for tests. */
  readonly completedAt?: string;
}

/** Every expected observation of the journey, keyed by id. */
function journeyExpectations(journey: ValidationJourney): Map<string, ExpectedObservation> {
  const expectations = new Map<string, ExpectedObservation>();
  for (const step of journey.steps) {
    for (const expected of step.expectedObservations) {
      expectations.set(expected.id, expected);
    }
  }
  return expectations;
}

/**
 * Finalize a validation run: derive the typed outcome, preserve every
 * failure with full provenance, and return the immutable completed run.
 * Throws a typed {@link ValidationDomainError} on structural violations
 * (already-completed run, journey mismatch, a journey whose success
 * criteria are malformed at this boundary — health must never be vacuous,
 * foreign results, duplicated results, a result whose expectation does not
 * quote the canonical journey declaration, a result whose asserted
 * `matched` contradicts the derived evaluation, provenance mismatch,
 * invalid executionError).
 */
export function finalizeValidationRun(input: FinalizeValidationRunInput): ValidationRun {
  const { run, journey, results } = input;

  if (run.status !== 'admitted') {
    throw new ValidationDomainError(
      'FINALIZE_RUN_ALREADY_COMPLETED',
      `run ${run.id} is already ${run.status} — a run is finalized exactly once`,
    );
  }
  if (journey.id !== run.journeyId) {
    throw new ValidationDomainError(
      'FINALIZE_JOURNEY_MISMATCH',
      `the journey ${journey.id} does not match the run's journey ${run.journeyId}`,
    );
  }

  const expectations = journeyExpectations(journey);

  // The criteria-driven health determination (below) requires the declared
  // success criteria to be well-formed AT THIS BOUNDARY too (defense in
  // depth — defineValidationJourney enforces the same rules at declaration):
  // a journey with NO criteria would make health vacuous, and a criterion
  // referencing an unknown observation would be unsatisfiable without any
  // failure record. Neither may reach the determination.
  if (!Array.isArray(journey.successCriteria) || journey.successCriteria.length === 0) {
    throw new ValidationDomainError(
      'VALIDATION_JOURNEY_INVALID',
      `journey ${journey.id} declares no success criteria — health is undecidable (a valid journey declares at least one)`,
    );
  }
  for (const criterion of journey.successCriteria) {
    if (
      !criterion ||
      !Array.isArray(criterion.requiresObservationIds) ||
      criterion.requiresObservationIds.length === 0
    ) {
      throw new ValidationDomainError(
        'VALIDATION_JOURNEY_INVALID',
        `journey ${journey.id}: success criterion ${criterion?.id ?? '(unknown)'} must require at least one declared observation`,
      );
    }
    for (const observationId of criterion.requiresObservationIds) {
      if (!expectations.has(observationId)) {
        throw new ValidationDomainError(
          'VALIDATION_JOURNEY_INVALID',
          `journey ${journey.id}: success criterion ${criterion.id} references unknown observation ${observationId}`,
        );
      }
    }
  }

  // Validate the results: every result must reference a journey expectation
  // (quoting its CANONICAL declaration exactly) with provenance matching
  // THIS run. The asserted `matched` is verified against the DERIVED
  // evaluation (correction 3) and the derived value is recorded for the
  // health determination below.
  const seenExpectationIds = new Set<string>();
  const derivedMatchedById = new Map<string, boolean>();
  for (const result of results) {
    const expected = result.expected as ExpectedObservation | undefined;
    if (!expected || typeof expected.id !== 'string' || !expectations.has(expected.id)) {
      throw new ValidationDomainError(
        'FINALIZE_RESULTS_FOREIGN',
        `a result references an expectation that is not in journey ${journey.id} (${JSON.stringify(expected?.id ?? null)})`,
      );
    }
    // PR #86 review correction 1 — canonical expectation integrity: the id
    // alone proves nothing. The supplied expectation must be structurally
    // EQUAL to the canonical journey declaration (id, stepId, kind,
    // description, matcher): a variant with the same id but a different
    // matcher (or any other altered field) is rejected — it could otherwise
    // claim `matched: true` against a weakened expectation and fabricate a
    // healthy result.
    const canonical = expectations.get(expected.id) as ExpectedObservation;
    if (!deepEquals(result.expected, canonical)) {
      throw new ValidationDomainError(
        'FINALIZE_EXPECTATION_CANONICAL_MISMATCH',
        `the result for ${expected.id} does not quote the canonical expectation declared by journey ${journey.id} — an executor-supplied expectation variant can never produce health`,
      );
    }
    if (seenExpectationIds.has(expected.id)) {
      throw new ValidationDomainError(
        'FINALIZE_RESULTS_FOREIGN',
        `duplicate result for expectation ${expected.id}`,
      );
    }
    seenExpectationIds.add(expected.id);
    const provenance = result.provenance as Partial<ObservationProvenance> | undefined;
    if (
      !provenance ||
      provenance.runId !== run.id ||
      provenance.journeyId !== journey.id ||
      provenance.stepId !== expected.stepId ||
      provenance.environmentId !== run.environmentId
    ) {
      throw new ValidationDomainError(
        'OBSERVATION_PROVENANCE_INVALID',
        `the result for ${expected.id} carries provenance that does not match run ${run.id} (foreign or broken provenance is rejected)`,
      );
    }
    // PR #86 review correction 3 — derived match integrity: `matched` is an
    // executor ASSERTION, never a determination. Finalization recomputes the
    // match with the authoritative deterministic evaluator over the CANONICAL
    // expectation and the recorded actual observation, and REJECTS a result
    // whose assertion contradicts the derivation. Without this, an executor
    // could submit `expected = canonical, actual = wrong, matched: true` and
    // fabricate health (or `actual = right, matched: false` and fabricate a
    // failure) — the same false-healthy class as correction 1, through a
    // different field. The derived value (not the assertion) is what the
    // success-criteria evaluation below reads.
    const derivedMatched = evaluateObservation(canonical, result.actual ?? null);
    if (result.matched !== derivedMatched) {
      throw new ValidationDomainError(
        'FINALIZE_MATCH_ASSERTION_MISMATCH',
        `the result for ${expected.id} asserts matched=${String(result.matched)} but evaluating the canonical expectation against the recorded observation derives matched=${String(derivedMatched)} — an executor assertion can never determine health`,
      );
    }
    derivedMatchedById.set(expected.id, derivedMatched);
  }

  // Validate the execution error shape (fail closed on foreign kinds).
  let executionError: ExecutionError | undefined;
  if (input.executionError !== undefined) {
    const error = input.executionError as { kind?: unknown; reason?: unknown };
    if (
      (error.kind !== 'effect_policy_violation' && error.kind !== 'environment_error') ||
      typeof error.reason !== 'string' ||
      error.reason.trim() === ''
    ) {
      throw new ValidationDomainError(
        'FINALIZE_EXECUTION_ERROR_INVALID',
        'executionError must be { kind: effect_policy_violation | environment_error, reason: non-empty string }',
      );
    }
    executionError = input.executionError;
  }

  const completedAt =
    input.completedAt ??
    (results.reduce<string>((latest, result) => {
      const observedAt = result.provenance.observedAt ?? '';
      return observedAt > latest ? observedAt : latest;
    }, run.createdAt) || run.createdAt);

  const runProvenance = Object.freeze({
    runId: run.id,
    journeyId: journey.id,
    environmentId: run.environmentId,
    mode: run.mode,
    trigger: run.trigger,
  });

  let outcome: ValidationOutcome;
  let observations: readonly ValidationObservation[];

  if (executionError) {
    outcome = Object.freeze({
      kind: executionError.kind,
      provenance: runProvenance,
      reason: executionError.reason,
    });
    observations = results
      .map((result) => result.actual)
      .filter((actual): actual is ValidationObservation => actual !== null);
  } else {
    // The failure-recording path: every journey expectation without a
    // MATCHED result is recorded as an explicit failure (actual: null for
    // missing) — nothing is silently dropped.
    const failures: ValidationFailure[] = [];
    const matchedById = new Map<string, ObservationResult>();
    for (const result of results) {
      matchedById.set(result.expected.id, result);
    }
    for (const [expectationId, expected] of expectations) {
      const result = matchedById.get(expectationId);
      // The DERIVED match (evaluateObservation over the canonical
      // expectation — recorded during result validation above) decides, not
      // the executor's asserted `result.matched` (correction 3).
      if (result === undefined || derivedMatchedById.get(expectationId) !== true) {
        failures.push(
          Object.freeze({
            kind: 'validation_failure' as const,
            failedStepId: expected.stepId,
            expected,
            actual: result?.actual ?? null,
            provenance: Object.freeze({
              runId: run.id,
              journeyId: journey.id,
              stepId: expected.stepId,
              environmentId: run.environmentId,
              observedAt: result?.provenance.observedAt ?? completedAt,
            }),
          }),
        );
      }
    }
    observations = results
      .map((result) => result.actual)
      .filter((actual): actual is ValidationObservation => actual !== null);

    // PR #86 review correction 2 — success-criteria semantics: the declared
    // criteria (NOT the raw expectation count) determine health. A criterion
    // is satisfied iff EVERY observation it requires has a matched result;
    // the run is healthy iff EVERY declared criterion is satisfied. An
    // expectation not required by any criterion is OBSERVATIONAL: an unmet
    // observational expectation never fails the run (its record only appears
    // when the run is already failing — full provenance, no silent drop).
    const requiredObservationIds = new Set<string>();
    for (const criterion of journey.successCriteria) {
      for (const observationId of criterion.requiresObservationIds) {
        requiredObservationIds.add(observationId);
      }
    }
    const requiredFailure = failures.some((failure) =>
      requiredObservationIds.has(failure.expected.id),
    );

    if (requiredFailure) {
      // A REQUIRED observation is missing or unmatched — the run is a
      // validation_failure. A failure is NEVER silently discarded and NEVER
      // healthy; every unmet expectation (required AND observational) is
      // recorded with full provenance.
      outcome = Object.freeze({
        kind: 'validation_failure',
        provenance: runProvenance,
        failures: Object.freeze(failures),
      });
    } else {
      // Every declared criterion is satisfied → healthy. satisfiedCriteria
      // lists every declared criterion (healthy requires ALL of them).
      outcome = Object.freeze({
        kind: 'healthy',
        provenance: runProvenance,
        satisfiedCriteria: Object.freeze(journey.successCriteria.map((criterion) => criterion.id)),
      });
    }
  }

  return Object.freeze({
    ...run,
    status: 'completed',
    observations: Object.freeze(observations),
    outcome,
    completedAt,
  });
}

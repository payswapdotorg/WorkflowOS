import { describe, it, expect } from 'vitest';

/**
 * WORK-064 Task 6 — typed observations and validation outcomes with full
 * provenance (spec/work-orders/WORK-064.md invariant 6 + required proof 5;
 * spec/architecture/v1.1/evidence-provenance-model.md §5 "The
 * no-silent-healthy rule").
 *
 * THE INVARIANT: a validation failure is never silently discarded, never
 * converted into a false healthy state, and never directly converted into an
 * ungoverned code change. A missing observation is an EXPLICIT failure.
 *
 * PR #86 REVIEW CORRECTIONS (the architect's audit, 2026-08-30) — §6, §7,
 * and §8 below carry the discriminating regressions:
 *   1. canonical expectation integrity — a result must quote the journey's
 *      canonical expectation EXACTLY (id/stepId/kind/description/matcher);
 *   2. success-criteria semantics — SuccessCriterion.requiresObservationIds
 *      is the declared set that determines health; an observational
 *      expectation not required by any criterion does not fail the run;
 *   3. derived match integrity — the caller-supplied `result.matched` is an
 *      executor assertion, never a determination: finalization recomputes
 *      the match (evaluateObservation: canonical expectation × actual
 *      observation) and rejects any contradicting assertion. Neither a
 *      false healthy (wrong actual + matched:true) nor a false failure
 *      (right actual + matched:false) can be fabricated.
 */
import {
  defineValidationJourney,
  describeEnvironment,
  admitValidationRun,
  recordObservation,
  evaluateObservation,
  finalizeValidationRun,
  ValidationDomainError,
  type ValidationJourney,
  type ValidationRun,
  type ExpectedObservation,
  type ValidationObservation,
  type ObservationResult,
  type TestIdentitySource,
  type Environment,
} from '../../src/continuous-validation/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const unauthenticated: TestIdentitySource = { kind: 'unauthenticated' };

const previewEnv: Environment = describeEnvironment({
  id: 'env-preview',
  kind: 'preview',
  acceptedPolicies: ['READ_ONLY'],
});

/**
 * A two-step journey: a DOM heading and a network response. Two success
 * criteria — healthy requires BOTH.
 */
const journey: ValidationJourney = defineValidationJourney({
  id: 'journey-sign-in-page',
  name: 'The sign-in page renders',
  identityRequirement: 'unauthenticated',
  allowedModes: ['PRE_MERGE', 'POST_RELEASE', 'CONTINUOUS'],
  effectPolicy: 'READ_ONLY',
  steps: [
    {
      id: 'step-open-sign-in',
      name: 'open the sign-in page',
      expectedObservations: [
        {
          id: 'obs-heading',
          stepId: 'step-open-sign-in',
          kind: 'dom',
          description: 'the sign-in heading is visible',
          matcher: { kind: 'equals', value: 'Sign in to WorkflowOS' },
        },
      ],
    },
    {
      id: 'step-load-session',
      name: 'the session endpoint responds',
      expectedObservations: [
        {
          id: 'obs-session-status',
          stepId: 'step-load-session',
          kind: 'network',
          description: 'the session endpoint returns 401 for anonymous visitors',
          matcher: { kind: 'status_code', status: 401 },
        },
      ],
    },
  ],
  successCriteria: [
    {
      id: 'criterion-heading',
      description: 'the heading renders',
      requiresObservationIds: ['obs-heading'],
    },
    {
      id: 'criterion-session',
      description: 'the session endpoint responds',
      requiresObservationIds: ['obs-session-status'],
    },
  ],
});

const admittedRun: ValidationRun = admitValidationRun({
  journey,
  identitySource: unauthenticated,
  environment: previewEnv,
  mode: 'PRE_MERGE',
  trigger: 'PR',
  runId: 'run-prov-1',
  now: () => new Date('2026-08-30T12:00:00.000Z'),
}).run as ValidationRun;

const observedAt = '2026-08-30T12:00:01.000Z';

function observation(
  id: string,
  expected: ExpectedObservation,
  value: unknown,
): ValidationObservation {
  return recordObservation({
    id,
    kind: expected.kind,
    value,
    provenance: {
      runId: admittedRun.id,
      journeyId: journey.id,
      stepId: expected.stepId,
      environmentId: previewEnv.id,
      observedAt,
    },
  });
}

function matchedResult(
  expected: ExpectedObservation,
  actual: ValidationObservation | null,
): ObservationResult {
  return {
    expected,
    actual,
    matched: evaluateObservation(expected, actual),
    provenance: {
      runId: admittedRun.id,
      journeyId: journey.id,
      stepId: expected.stepId,
      environmentId: previewEnv.id,
      observedAt,
    },
  };
}

const headingExpected = journey.steps[0]?.expectedObservations[0] as ExpectedObservation;
const sessionExpected = journey.steps[1]?.expectedObservations[0] as ExpectedObservation;

// ---------------------------------------------------------------------------
// §1 recordObservation — the provenance guard
// ---------------------------------------------------------------------------

describe('WORK-064 observation recording — provenance guard', () => {
  it('records an observation with complete provenance', () => {
    const obs = observation('obs-1', headingExpected, 'Sign in to WorkflowOS');
    expect(obs.id).toBe('obs-1');
    expect(obs.kind).toBe('dom');
    expect(obs.provenance.runId).toBe('run-prov-1');
    expect(obs.provenance.journeyId).toBe('journey-sign-in-page');
    expect(obs.provenance.stepId).toBe('step-open-sign-in');
    expect(obs.provenance.environmentId).toBe('env-preview');
    expect(obs.provenance.observedAt).toBe(observedAt);
  });

  it('rejects an observation with missing provenance fields', () => {
    expect(() =>
      recordObservation({
        id: 'obs-x',
        kind: 'dom',
        value: 'x',
        // An empty runId is a valid-typed provenance shape — the runtime
        // guard must reject it (missing provenance).
        provenance: { runId: '', journeyId: journey.id, stepId: 'step-open-sign-in', environmentId: previewEnv.id, observedAt },
      }),
    ).toThrow(ValidationDomainError);
    expect(() =>
      recordObservation({
        id: 'obs-x',
        // @ts-expect-error — invalid kind at runtime
        kind: 'vibes',
        value: 'x',
        provenance: {
          runId: admittedRun.id,
          journeyId: journey.id,
          stepId: 'step-open-sign-in',
          environmentId: previewEnv.id,
          observedAt,
        },
      }),
    ).toThrow(ValidationDomainError);
  });
});

// ---------------------------------------------------------------------------
// §2 evaluateObservation — the deterministic matchers
// ---------------------------------------------------------------------------

describe('WORK-064 observation evaluation — deterministic matchers', () => {
  it('equals: deep structural equality', () => {
    expect(
      evaluateObservation(headingExpected, observation('a', headingExpected, 'Sign in to WorkflowOS')),
    ).toBe(true);
    expect(
      evaluateObservation(headingExpected, observation('a', headingExpected, 'Welcome back')),
    ).toBe(false);
  });

  it('exists: presence matches; absence NEVER matches', () => {
    const existsExpected: ExpectedObservation = {
      ...headingExpected,
      matcher: { kind: 'exists' },
    };
    expect(evaluateObservation(existsExpected, observation('a', existsExpected, null))).toBe(true);
    expect(evaluateObservation(existsExpected, null)).toBe(false);
  });

  it('contains_text: substring containment', () => {
    const textExpected: ExpectedObservation = {
      ...headingExpected,
      matcher: { kind: 'contains_text', text: 'WorkflowOS' },
    };
    expect(evaluateObservation(textExpected, observation('a', textExpected, 'Sign in to WorkflowOS today'))).toBe(true);
    expect(evaluateObservation(textExpected, observation('a', textExpected, 'Sign in elsewhere'))).toBe(false);
    expect(evaluateObservation(textExpected, observation('a', textExpected, 42))).toBe(false);
  });

  it('status_code: network status equality (number or {status} shape)', () => {
    expect(evaluateObservation(sessionExpected, observation('a', sessionExpected, 401))).toBe(true);
    expect(evaluateObservation(sessionExpected, observation('a', sessionExpected, { status: 401 }))).toBe(true);
    expect(evaluateObservation(sessionExpected, observation('a', sessionExpected, 500))).toBe(false);
  });

  it('a kind mismatch never matches', () => {
    const domValue = observation('a', sessionExpected, 401); // dom kind obs vs network expectation
    expect(evaluateObservation(sessionExpected, { ...domValue, kind: 'dom' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §3 finalizeValidationRun — the typed outcomes (the no-false-healthy core)
// ---------------------------------------------------------------------------

describe('WORK-064 outcome finalization — the no-false-healthy core', () => {
  it('ALL declared success criteria satisfied → healthy (with satisfiedCriteria provenance)', () => {
    const results = [
      matchedResult(headingExpected, observation('o-1', headingExpected, 'Sign in to WorkflowOS')),
      matchedResult(sessionExpected, observation('o-2', sessionExpected, 401)),
    ];
    const completed = finalizeValidationRun({
      run: admittedRun,
      journey,
      results,
      completedAt: '2026-08-30T12:00:05.000Z',
    });
    expect(completed.status).toBe('completed');
    expect(completed.outcome?.kind).toBe('healthy');
    expect(completed.outcome).toMatchObject({
      kind: 'healthy',
      satisfiedCriteria: ['criterion-heading', 'criterion-session'],
    });
    expect(completed.completedAt).toBe('2026-08-30T12:00:05.000Z');
    // The observations are preserved on the completed run:
    expect(completed.observations).toHaveLength(2);
  });

  it('a FAILED expected DOM observation yields validation_failure with full provenance', () => {
    const results = [
      matchedResult(headingExpected, observation('o-1', headingExpected, 'Welcome back')),
      matchedResult(sessionExpected, observation('o-2', sessionExpected, 401)),
    ];
    const completed = finalizeValidationRun({ run: admittedRun, journey, results });
    expect(completed.outcome?.kind).toBe('validation_failure');
    if (completed.outcome?.kind === 'validation_failure') {
      expect(completed.outcome.failures).toHaveLength(1);
      const failure = completed.outcome.failures[0];
      if (!failure) throw new Error('expected a failure record');
      expect(failure.failedStepId).toBe('step-open-sign-in');
      expect(failure.expected.id).toBe('obs-heading');
      expect(failure.actual?.value).toBe('Welcome back');
      // The full provenance chain is preserved on the failure:
      expect(failure.provenance).toMatchObject({
        runId: 'run-prov-1',
        journeyId: 'journey-sign-in-page',
        stepId: 'step-open-sign-in',
        environmentId: 'env-preview',
        observedAt,
      });
      // The run-level provenance is on the outcome:
      expect(completed.outcome.provenance).toMatchObject({
        runId: 'run-prov-1',
        journeyId: 'journey-sign-in-page',
        environmentId: 'env-preview',
        mode: 'PRE_MERGE',
        trigger: 'PR',
      });
    }
  });

  it('a MISSING observation is an EXPLICIT validation_failure — never silently healthy', () => {
    // Only the heading result is supplied; the session observation never
    // arrived. The run CANNOT be healthy.
    const results = [matchedResult(headingExpected, observation('o-1', headingExpected, 'Sign in to WorkflowOS'))];
    const completed = finalizeValidationRun({ run: admittedRun, journey, results });
    expect(completed.outcome?.kind).toBe('validation_failure');
    if (completed.outcome?.kind === 'validation_failure') {
      expect(completed.outcome.failures).toHaveLength(1);
      const failure = completed.outcome.failures[0];
      if (!failure) throw new Error('expected a failure record');
      expect(failure.expected.id).toBe('obs-session-status');
      expect(failure.actual).toBeNull(); // the explicit missing-observation record
      expect(failure.provenance.stepId).toBe('step-load-session');
    }
  });

  it('an EMPTY result set is a validation_failure, not healthy (nothing was observed)', () => {
    const completed = finalizeValidationRun({ run: admittedRun, journey, results: [] });
    expect(completed.outcome?.kind).toBe('validation_failure');
  });

  it('effect-policy rejection during execution yields effect_policy_violation', () => {
    const completed = finalizeValidationRun({
      run: admittedRun,
      journey,
      results: [],
      executionError: {
        kind: 'effect_policy_violation',
        reason: 'the executor attempted a mutation beyond the admitted READ_ONLY policy',
      },
    });
    expect(completed.outcome?.kind).toBe('effect_policy_violation');
    if (completed.outcome?.kind === 'effect_policy_violation') {
      expect(completed.outcome.reason).toContain('READ_ONLY');
      expect(completed.outcome.provenance.runId).toBe('run-prov-1');
    }
  });

  it('environment/deployment unavailability yields environment_error', () => {
    const completed = finalizeValidationRun({
      run: admittedRun,
      journey,
      results: [],
      executionError: {
        kind: 'environment_error',
        reason: 'the preview deployment was unreachable (connect timeout)',
      },
    });
    expect(completed.outcome?.kind).toBe('environment_error');
    if (completed.outcome?.kind === 'environment_error') {
      expect(completed.outcome.reason).toContain('unreachable');
      expect(completed.outcome.provenance.environmentId).toBe('env-preview');
    }
  });

  it('an invalid executionError kind is rejected (fail closed — unknown outcomes unrepresentable)', () => {
    expect(() =>
      finalizeValidationRun({
        run: admittedRun,
        journey,
        results: [],
        // @ts-expect-error — foreign error kind at runtime
        executionError: { kind: 'whoopsie', reason: 'x' },
      }),
    ).toThrow(ValidationDomainError);
  });

  it('the completed run is immutable and completed once (no double finalization)', () => {
    const completed = finalizeValidationRun({
      run: admittedRun,
      journey,
      results: [
        matchedResult(headingExpected, observation('o-1', headingExpected, 'Sign in to WorkflowOS')),
        matchedResult(sessionExpected, observation('o-2', sessionExpected, 401)),
      ],
    });
    expect(() =>
      finalizeValidationRun({ run: completed, journey, results: [] }),
    ).toThrow(ValidationDomainError);
  });
});

// ---------------------------------------------------------------------------
// §4 Provenance integrity + foreign-result rejection
// ---------------------------------------------------------------------------

describe('WORK-064 outcome finalization — provenance integrity', () => {
  it('a result whose provenance does not match the run is rejected', () => {
    const foreignResult: ObservationResult = {
      expected: headingExpected,
      actual: observation('o-1', headingExpected, 'Sign in to WorkflowOS'),
      matched: true,
      provenance: {
        runId: 'run-SOMEONE-ELSE',
        journeyId: journey.id,
        stepId: 'step-open-sign-in',
        environmentId: previewEnv.id,
        observedAt,
      },
    };
    expect(() =>
      finalizeValidationRun({ run: admittedRun, journey, results: [foreignResult] }),
    ).toThrow(ValidationDomainError);
  });

  it('a result referencing an observation NOT in the journey is rejected (foreign results)', () => {
    const foreignExpected: ExpectedObservation = {
      id: 'obs-not-in-journey',
      stepId: 'step-open-sign-in',
      kind: 'dom',
      description: 'foreign expectation',
      matcher: { kind: 'exists' },
    };
    const foreignResult: ObservationResult = {
      expected: foreignExpected,
      actual: null,
      matched: false,
      provenance: {
        runId: admittedRun.id,
        journeyId: journey.id,
        stepId: 'step-open-sign-in',
        environmentId: previewEnv.id,
        observedAt,
      },
    };
    expect(() =>
      finalizeValidationRun({ run: admittedRun, journey, results: [foreignResult] }),
    ).toThrow(ValidationDomainError);
  });

  it('a journey mismatch with the run is rejected', () => {
    const otherJourney = defineValidationJourney({
      ...journey,
      id: 'journey-somebody-elses',
    });
    expect(() =>
      finalizeValidationRun({
        run: admittedRun,
        journey: otherJourney,
        results: [],
      }),
    ).toThrow(ValidationDomainError);
  });

  it('duplicate results for the same expected observation are rejected', () => {
    const result = matchedResult(headingExpected, observation('o-1', headingExpected, 'Sign in to WorkflowOS'));
    expect(() =>
      finalizeValidationRun({ run: admittedRun, journey, results: [result, result] }),
    ).toThrow(ValidationDomainError);
  });
});

// ---------------------------------------------------------------------------
// §5 The mutation/discrimination proof (required proof 5: removing the
//    failure-recording path makes these assertions FAIL)
// ---------------------------------------------------------------------------

describe('WORK-064 no-false-healthy — the mutation-killing discriminations', () => {
  /**
   * The failure-recording path is the code that turns unmatched/missing
   * expected observations into the typed validation_failure outcome. Every
   * assertion below targets that path directly: if a future edit removes or
   * weakens it (e.g. finalizing healthy on "no results" or skipping missing
   * observations), these tests fail — the regression suite is the proof.
   */
  it('healthy is ONLY reachable when every CRITERION-REQUIRED observation has a matched result', () => {
    // In this fixture BOTH expectations are required by declared criteria
    // (criterion-heading requires obs-heading; criterion-session requires
    // obs-session-status) — so the no-false-healthy core is exercised at
    // full strength: all four failure shapes must NOT be healthy.
    const matchedHeading = matchedResult(
      headingExpected,
      observation('o-1', headingExpected, 'Sign in to WorkflowOS'),
    );
    // All four failure shapes must NOT be healthy:
    const shapes: readonly (readonly ObservationResult[])[] = [
      [], // nothing observed
      [matchedHeading], // one of two observed
      [
        matchedHeading,
        matchedResult(sessionExpected, observation('o-2', sessionExpected, 500)), // mismatched
      ],
      [
        matchedHeading,
        matchedResult(sessionExpected, null), // explicitly missing
      ],
    ];
    for (const results of shapes) {
      const completed = finalizeValidationRun({ run: admittedRun, journey, results });
      expect(completed.outcome?.kind).not.toBe('healthy');
      expect(completed.outcome?.kind).toBe('validation_failure');
    }
    // And the complete shape IS healthy:
    const completed = finalizeValidationRun({
      run: admittedRun,
      journey,
      results: [
        matchedHeading,
        matchedResult(sessionExpected, observation('o-2', sessionExpected, 401)),
      ],
    });
    expect(completed.outcome?.kind).toBe('healthy');
  });

  it('a REQUIRED observation with no matched result keeps the run a validation_failure (the criteria are the health contract)', () => {
    // The opposite-direction mutation kill for the PR #86 correction: health
    // may NEVER become "criteria ignored" — a required observation that is
    // missing or unmatched fails the run exactly as before.
    const shapes: readonly (readonly ObservationResult[])[] = [
      [], // nothing observed — every criterion unsatisfied
      [matchedResult(headingExpected, observation('o-1', headingExpected, 'Sign in to WorkflowOS'))], // one required observation missing
      [
        matchedResult(headingExpected, observation('o-1', headingExpected, 'Sign in to WorkflowOS')),
        matchedResult(sessionExpected, observation('o-2', sessionExpected, 500)), // required observation mismatched
      ],
      [
        matchedResult(headingExpected, observation('o-1', headingExpected, 'Sign in to WorkflowOS')),
        matchedResult(sessionExpected, null), // required observation explicitly missing
      ],
    ];
    for (const results of shapes) {
      const completed = finalizeValidationRun({ run: admittedRun, journey, results });
      expect(completed.outcome?.kind).not.toBe('healthy');
      expect(completed.outcome?.kind).toBe('validation_failure');
    }
  });
});

// ---------------------------------------------------------------------------
// §6 PR #86 review correction 1 — canonical expectation integrity
//    (finalizeValidationRun must resolve/compare against the CANONICAL journey
//    expectation; the id alone proves nothing)
// ---------------------------------------------------------------------------

describe('WORK-064 canonical expectation integrity — a result quotes its journey expectation EXACTLY (PR #86 review correction 1)', () => {
  /** Catch a finalize call and return the typed error's code (null when none thrown). */
  function finalizeCode(results: readonly ObservationResult[]): string | null {
    try {
      finalizeValidationRun({ run: admittedRun, journey, results });
      return null;
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationDomainError);
      return (error as ValidationDomainError).code;
    }
  }

  /**
   * The architect's exact attack shape: a future executor retains the
   * expectation ID but alters the matcher, claims `matched: true`, and
   * fabricates a healthy result. On the pre-correction code this finalized
   * HEALTHY — the discriminator for the fix.
   */
  it('a result with the RIGHT id but an ALTERED MATCHER and matched:true is REJECTED — no executor-supplied matcher can produce health', () => {
    const tampered: ExpectedObservation = {
      ...headingExpected,
      // NOT the canonical { kind: 'equals', value: 'Sign in to WorkflowOS' }:
      matcher: { kind: 'equals', value: 'Welcome back' },
    };
    const tamperedResult: ObservationResult = {
      expected: tampered,
      actual: observation('o-1', headingExpected, 'Welcome back'),
      matched: true, // the false claim the pre-correction code trusted
      provenance: {
        runId: admittedRun.id,
        journeyId: journey.id,
        stepId: 'step-open-sign-in',
        environmentId: previewEnv.id,
        observedAt,
      },
    };
    expect(
      finalizeCode([
        tamperedResult,
        matchedResult(sessionExpected, observation('o-2', sessionExpected, 401)),
      ]),
    ).toBe('FINALIZE_EXPECTATION_CANONICAL_MISMATCH');
  });

  it('a weakened matcher (exists instead of the canonical equals) is rejected even with a non-matching actual', () => {
    const weakened: ExpectedObservation = {
      ...headingExpected,
      matcher: { kind: 'exists' }, // strictly weaker than the canonical equals matcher
    };
    const weakenedResult: ObservationResult = {
      expected: weakened,
      actual: observation('o-1', headingExpected, 'Completely wrong heading'),
      matched: true, // true under the WEAKENED matcher — the fabricated match
      provenance: {
        runId: admittedRun.id,
        journeyId: journey.id,
        stepId: 'step-open-sign-in',
        environmentId: previewEnv.id,
        observedAt,
      },
    };
    expect(finalizeCode([weakenedResult])).toBe('FINALIZE_EXPECTATION_CANONICAL_MISMATCH');
  });

  it('an altered stepId, kind, or description is rejected — the WHOLE canonical shape is verified', () => {
    const base = matchedResult(
      headingExpected,
      observation('o-1', headingExpected, 'Sign in to WorkflowOS'),
    );
    const variants: ExpectedObservation[] = [
      { ...headingExpected, stepId: 'step-load-session' }, // wrong step
      { ...headingExpected, kind: 'network' }, // wrong kind
      { ...headingExpected, description: 'a different description' }, // wrong description
      { ...headingExpected, matcher: { kind: 'contains_text', text: 'Sign in' } }, // different matcher kind
    ];
    for (const variant of variants) {
      const result: ObservationResult = { ...base, expected: variant };
      expect(finalizeCode([result])).toBe('FINALIZE_EXPECTATION_CANONICAL_MISMATCH');
    }
  });

  it('a structurally EQUAL clone of the canonical expectation is accepted — the check is canonical SHAPE, not reference identity', () => {
    // A future executor may legitimately deep-copy the journey's expectation
    // (e.g. after persisting/reloading the declaration): structural equality
    // with the canonical declaration is the contract, not object identity.
    const clone: ExpectedObservation = {
      ...headingExpected,
      matcher: { ...headingExpected.matcher } as typeof headingExpected.matcher,
    };
    const clonedResult: ObservationResult = {
      expected: clone,
      actual: observation('o-1', headingExpected, 'Sign in to WorkflowOS'),
      matched: true,
      provenance: {
        runId: admittedRun.id,
        journeyId: journey.id,
        stepId: 'step-open-sign-in',
        environmentId: previewEnv.id,
        observedAt,
      },
    };
    const completed = finalizeValidationRun({
      run: admittedRun,
      journey,
      results: [
        clonedResult,
        matchedResult(sessionExpected, observation('o-2', sessionExpected, 401)),
      ],
    });
    expect(completed.outcome?.kind).toBe('healthy');
  });
});

// ---------------------------------------------------------------------------
// §7 PR #86 review correction 2 — success-criteria health semantics
//    (SuccessCriterion.requiresObservationIds is the declared set that
//    determines health; non-required expectations are OBSERVATIONAL)
// ---------------------------------------------------------------------------

describe('WORK-064 success-criteria semantics — requiresObservationIds determines health (PR #86 review correction 2)', () => {
  /**
   * A three-observation journey: obs-a and obs-b are REQUIRED by the declared
   * criterion; obs-c is OBSERVATIONAL (declared, captured, but not required
   * by any success criterion). Its matcher is `equals` so it can genuinely
   * be unmatched while having a captured actual.
   */
  const threeObsJourney = defineValidationJourney({
    id: 'journey-three-obs',
    name: 'three observations, one criterion',
    identityRequirement: 'unauthenticated',
    allowedModes: ['PRE_MERGE'],
    effectPolicy: 'READ_ONLY',
    steps: [
      {
        id: 'step-1',
        name: 'step one',
        expectedObservations: [
          { id: 'obs-a', stepId: 'step-1', kind: 'dom', description: 'a', matcher: { kind: 'exists' } },
          { id: 'obs-b', stepId: 'step-1', kind: 'dom', description: 'b', matcher: { kind: 'exists' } },
        ],
      },
      {
        id: 'step-2',
        name: 'step two',
        expectedObservations: [
          {
            id: 'obs-c',
            stepId: 'step-2',
            kind: 'dom',
            description: 'the observational marketing banner text',
            matcher: { kind: 'equals', value: 'Ship with confidence' },
          },
        ],
      },
    ],
    successCriteria: [
      { id: 'crit-1', description: 'a and b render', requiresObservationIds: ['obs-a', 'obs-b'] },
    ],
  });

  const threeObsRun = admitValidationRun({
    journey: threeObsJourney,
    identitySource: unauthenticated,
    environment: previewEnv,
    mode: 'PRE_MERGE',
    trigger: 'PR',
    runId: 'run-three-obs',
  }).run as ValidationRun;

  const expectedA = threeObsJourney.steps[0]?.expectedObservations[0] as ExpectedObservation;
  const expectedB = threeObsJourney.steps[0]?.expectedObservations[1] as ExpectedObservation;
  const expectedC = threeObsJourney.steps[1]?.expectedObservations[0] as ExpectedObservation;

  function threeObsResult(
    expected: ExpectedObservation,
    value: unknown,
    matched: boolean,
  ): ObservationResult {
    return {
      expected,
      actual: recordObservation({
        id: `o-${expected.id}`,
        kind: expected.kind,
        value,
        provenance: {
          runId: threeObsRun.id,
          journeyId: threeObsJourney.id,
          stepId: expected.stepId,
          environmentId: previewEnv.id,
          observedAt,
        },
      }),
      matched,
      provenance: {
        runId: threeObsRun.id,
        journeyId: threeObsJourney.id,
        stepId: expected.stepId,
        environmentId: previewEnv.id,
        observedAt,
      },
    };
  }

  it('criteria fully satisfied + a MISSING observational expectation → HEALTHY (an observational expectation does not fail the run)', () => {
    // obs-c has NO result at all: the declared criterion is fully satisfied
    // from obs-a/obs-b, and obs-c is required by no criterion — the run is
    // healthy. (This inverts the pre-correction pin: the old code failed
    // this run on the unmet raw expectation count.)
    const completed = finalizeValidationRun({
      run: threeObsRun,
      journey: threeObsJourney,
      results: [
        threeObsResult(expectedA, null, true),
        threeObsResult(expectedB, null, true),
      ],
    });
    expect(completed.outcome?.kind).toBe('healthy');
    if (completed.outcome?.kind === 'healthy') {
      expect(completed.outcome.satisfiedCriteria).toEqual(['crit-1']);
    }
    // The captured actuals are preserved:
    expect(completed.observations).toHaveLength(2);
  });

  it('criteria fully satisfied + an UNMATCHED observational observation → HEALTHY, the captured actual preserved with full provenance', () => {
    // obs-c IS captured but does not match its expectation: still healthy
    // (obs-c is observational), and the actual observation is preserved —
    // nothing is silently dropped.
    const completed = finalizeValidationRun({
      run: threeObsRun,
      journey: threeObsJourney,
      results: [
        threeObsResult(expectedA, null, true),
        threeObsResult(expectedB, null, true),
        threeObsResult(expectedC, 'A completely different banner', false),
      ],
    });
    expect(completed.outcome?.kind).toBe('healthy');
    expect(completed.observations).toHaveLength(3);
    const banner = completed.observations.find((o) => o.id === 'o-obs-c');
    expect(banner?.value).toBe('A completely different banner');
    expect(banner?.provenance).toMatchObject({
      runId: 'run-three-obs',
      journeyId: 'journey-three-obs',
      stepId: 'step-2',
      environmentId: 'env-preview',
    });
  });

  it('an unmet REQUIRED observation → validation_failure with the failure record (the criteria remain the health contract)', () => {
    // obs-b (REQUIRED by crit-1) has no result: the criterion is unsatisfied
    // → the run fails, exactly as the no-false-healthy core demands.
    const completed = finalizeValidationRun({
      run: threeObsRun,
      journey: threeObsJourney,
      results: [threeObsResult(expectedA, null, true)],
    });
    expect(completed.outcome?.kind).toBe('validation_failure');
    if (completed.outcome?.kind === 'validation_failure') {
      const requiredFailure = completed.outcome.failures.find((f) => f.expected.id === 'obs-b');
      expect(requiredFailure).toBeDefined();
      expect(requiredFailure?.actual).toBeNull(); // the explicit missing record
      expect(requiredFailure?.provenance.stepId).toBe('step-1');
    }
  });

  it('a failing run records EVERY unmet expectation — required AND observational — with full provenance', () => {
    // Same failing shape as above, with obs-c ALSO unmatched: the failures
    // array carries both (the required failure AND the observational miss) —
    // an unmet observational expectation is never silently discarded when
    // the run is already failing.
    const completed = finalizeValidationRun({
      run: threeObsRun,
      journey: threeObsJourney,
      results: [
        threeObsResult(expectedA, null, true),
        threeObsResult(expectedC, 'A completely different banner', false),
        // obs-b (required) missing:
      ],
    });
    expect(completed.outcome?.kind).toBe('validation_failure');
    if (completed.outcome?.kind === 'validation_failure') {
      expect(completed.outcome.failures.map((f) => f.expected.id).sort()).toEqual([
        'obs-b',
        'obs-c',
      ]);
    }
  });

  it('a hand-crafted journey with NO success criteria is rejected at the finalize boundary — health is never vacuous', () => {
    // defineValidationJourney forbids this shape at declaration; the finalize
    // boundary re-asserts it (defense in depth): with criteria-driven health,
    // an empty criteria set would otherwise make ANY run vacuously healthy.
    const noCriteriaJourney: ValidationJourney = { ...threeObsJourney, successCriteria: [] };
    let caught: unknown;
    try {
      finalizeValidationRun({ run: threeObsRun, journey: noCriteriaJourney, results: [] });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationDomainError);
    expect((caught as ValidationDomainError).code).toBe('VALIDATION_JOURNEY_INVALID');
  });

  it('a hand-crafted criterion referencing an UNKNOWN observation is rejected at the finalize boundary', () => {
    const ghostCriterionJourney: ValidationJourney = {
      ...threeObsJourney,
      successCriteria: [
        {
          id: 'crit-ghost',
          description: 'references an observation the journey does not declare',
          requiresObservationIds: ['obs-ghost'],
        },
      ],
    };
    let caught: unknown;
    try {
      finalizeValidationRun({ run: threeObsRun, journey: ghostCriterionJourney, results: [] });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationDomainError);
    expect((caught as ValidationDomainError).code).toBe('VALIDATION_JOURNEY_INVALID');
  });
});

// ---------------------------------------------------------------------------
// §8 PR #86 review correction 3 — derived match integrity
//    (`result.matched` is an executor ASSERTION; finalization derives the
//    match itself via evaluateObservation(canonicalExpected, actual) and
//    rejects any contradicting assertion — health and failure flow from the
//    DERIVED value only)
// ---------------------------------------------------------------------------

describe('WORK-064 derived match integrity — result.matched is verified, never trusted (PR #86 review correction 3)', () => {
  /** A result whose `matched` is the EXECUTOR'S ASSERTION (hand-set for the attack shapes). */
  function assertedResult(
    expected: ExpectedObservation,
    value: unknown,
    matched: boolean,
  ): ObservationResult {
    return {
      expected,
      actual: observation(`o-${expected.id}`, expected, value),
      matched, // the assertion under test — NOT derived here
      provenance: {
        runId: admittedRun.id,
        journeyId: journey.id,
        stepId: expected.stepId,
        environmentId: previewEnv.id,
        observedAt,
      },
    };
  }

  /** Catch a finalize call and return the typed error's code (null when none thrown). */
  function finalizeCode(results: readonly ObservationResult[]): string | null {
    try {
      finalizeValidationRun({ run: admittedRun, journey, results });
      return null;
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationDomainError);
      return (error as ValidationDomainError).code;
    }
  }

  it('a genuinely MATCHING actual with a matched:false assertion is REJECTED — a false FAILURE cannot be fabricated', () => {
    // The architect's direction 1: actual matches the canonical expectation,
    // the executor asserts matched:false. The pre-correction code TRUSTED the
    // assertion and finalized validation_failure (a false failure on a
    // REQUIRED observation). The correction derives the match — the
    // derivation is true — and rejects the lying assertion instead.
    expect(
      finalizeCode([
        assertedResult(headingExpected, 'Sign in to WorkflowOS', false), // the lie
        assertedResult(sessionExpected, 401, true), // honest
      ]),
    ).toBe('FINALIZE_MATCH_ASSERTION_MISMATCH');
  });

  it('a NON-matching actual with a matched:true assertion is REJECTED — a false HEALTHY cannot be fabricated', () => {
    // The architect's direction 2: the expectation is canonical, the actual
    // is WRONG, the executor asserts matched:true. The pre-correction code
    // TRUSTED the assertion and finalized HEALTHY — the remaining
    // false-healthy hole. The correction derives matched=false and rejects
    // the assertion: MUST NOT produce healthy.
    expect(
      finalizeCode([
        assertedResult(headingExpected, 'Welcome back', true), // the lie
        assertedResult(sessionExpected, 401, true), // honest
      ]),
    ).toBe('FINALIZE_MATCH_ASSERTION_MISMATCH');
  });

  it('a MISSING observation (actual: null) with a matched:true assertion is REJECTED — no-silent-healthy holds through the assertion', () => {
    // evaluateObservation(canonical, null) is ALWAYS false (the no-silent-
    // healthy rule): asserting matched:true against a missing observation is
    // a contradiction, and the boundary rejects it rather than recording a
    // fabricated match.
    const missingObserved: ObservationResult = {
      expected: headingExpected,
      actual: null,
      matched: true, // the fabricated match over a missing observation
      provenance: {
        runId: admittedRun.id,
        journeyId: journey.id,
        stepId: headingExpected.stepId,
        environmentId: previewEnv.id,
        observedAt,
      },
    };
    expect(finalizeCode([missingObserved])).toBe('FINALIZE_MATCH_ASSERTION_MISMATCH');
  });

  it('canonical expectation + correct actual + matched:true → HEALTHY (the honest path is unaffected)', () => {
    // The architect's direction 3 (the positive control): an assertion that
    // AGREES with the derivation finalizes exactly as before — honest
    // executors are not punished by the verification.
    const completed = finalizeValidationRun({
      run: admittedRun,
      journey,
      results: [
        assertedResult(headingExpected, 'Sign in to WorkflowOS', true),
        assertedResult(sessionExpected, 401, true),
      ],
    });
    expect(completed.outcome?.kind).toBe('healthy');
    if (completed.outcome?.kind === 'healthy') {
      expect(completed.outcome.satisfiedCriteria).toEqual(['criterion-heading', 'criterion-session']);
    }
  });

  it('canonical expectation + correct actual + matched:false is never silently accepted — the assertion was the only defect', () => {
    // The architect's direction 4: the false assertion must not be silently
    // accepted. The rejection is about the ASSERTION, not the data: the very
    // same canonical expectation and the very same captured actual finalize
    // healthy the moment the assertion is honest — proving the derived
    // evaluation (not the assertion) determines the outcome.
    expect(finalizeCode([assertedResult(headingExpected, 'Sign in to WorkflowOS', false)])).toBe(
      'FINALIZE_MATCH_ASSERTION_MISMATCH',
    );
    const completed = finalizeValidationRun({
      run: admittedRun,
      journey,
      results: [
        assertedResult(headingExpected, 'Sign in to WorkflowOS', true),
        assertedResult(sessionExpected, 401, true),
      ],
    });
    expect(completed.outcome?.kind).toBe('healthy');
  });

  it('an HONEST matched:false assertion is accepted — consistency, not the value, is what is verified', () => {
    // A derived-false result with an honest matched:false assertion passes
    // the verification (§7 already proves an unmet OBSERVATIONAL expectation
    // stays healthy; here the unmet expectation is REQUIRED, so the honest
    // false drives a validation_failure — the assertion is not second-
    // guessed in either direction).
    const completed = finalizeValidationRun({
      run: admittedRun,
      journey,
      results: [
        assertedResult(headingExpected, 'Completely wrong heading', false), // honest miss
        assertedResult(sessionExpected, 401, true),
      ],
    });
    expect(completed.outcome?.kind).toBe('validation_failure');
    if (completed.outcome?.kind === 'validation_failure') {
      expect(completed.outcome.failures.map((f) => f.expected.id)).toEqual(['obs-heading']);
    }
  });
});

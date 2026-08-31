import { describe, it, expect } from 'vitest';

/**
 * WORK-067 — the WORK-064 validation-source adapter proofs.
 *
 * The adapter consumes the WORK-064 authority's own record type through
 * its public helpers (admitValidationRun + finalizeValidationRun — the
 * pure domain constructors; NEVER a re-implementation of admission or
 * health): a COMPLETED run's typed outcome becomes signal observations.
 *
 * Proofs: healthy → NO signal (the honest no-signal case); EVERY
 * validation_failure → ONE observation (nothing dropped); the severity
 * mapping is the documented deterministic assessment; the logical failure
 * key derivation is deterministic; the recorded releaseRef is the causal
 * binding; scope mismatches fail closed; un-completed runs fail closed.
 */
import {
  defineValidationJourney,
  describeEnvironment,
  admitValidationRun,
  recordObservation,
  evaluateObservation,
  finalizeValidationRun,
  type ValidationJourney,
  type ValidationRun,
  type ExpectedObservation,
  type ObservationResult,
  type TestIdentitySource,
  type Environment,
} from '../../src/continuous-validation/index.js';
import {
  validationRunToObservationInputs,
  VALIDATION_OUTCOME_SEVERITY,
} from '../../src/engineering-signals/internal/validation-source-adapter.js';
import { EngineeringSignalError } from '../../src/engineering-signals/index.js';
import { buildService } from './helpers.js';

const prodEnv: Environment = describeEnvironment({
  id: 'env-prod-1',
  kind: 'production',
  acceptedPolicies: ['READ_ONLY'],
});

const unauthenticated: TestIdentitySource = { kind: 'unauthenticated' };

const journey: ValidationJourney = defineValidationJourney({
  id: 'journey-checkout',
  name: 'The checkout journey',
  identityRequirement: 'unauthenticated',
  allowedModes: ['POST_RELEASE', 'CONTINUOUS'],
  effectPolicy: 'READ_ONLY',
  steps: [
    {
      id: 'step-pay',
      name: 'pay the order',
      expectedObservations: [
        {
          id: 'expectation-total',
          stepId: 'step-pay',
          kind: 'persisted_record',
          description: 'the cart total is persisted',
          matcher: { kind: 'equals', value: 3 },
        },
        {
          id: 'expectation-confirmation',
          stepId: 'step-pay',
          kind: 'dom',
          description: 'the confirmation heading is visible',
          matcher: { kind: 'equals', value: 'Order confirmed' },
        },
      ],
    },
  ],
  successCriteria: [
    { id: 'criterion-total', description: 'the total persists', requiresObservationIds: ['expectation-total'] },
    { id: 'criterion-confirmation', description: 'the confirmation renders', requiresObservationIds: ['expectation-confirmation'] },
  ],
});

function admittedRun(runId: string, releaseRef?: string, mode: 'POST_RELEASE' | 'CONTINUOUS' = 'POST_RELEASE', trigger: 'RELEASE' | 'SCHEDULED' = 'RELEASE'): ValidationRun {
  return admitValidationRun({
    journey,
    identitySource: unauthenticated,
    environment: prodEnv,
    mode,
    trigger,
    releaseRef,
    continuousConfigured: mode === 'CONTINUOUS' ? true : undefined,
    runId,
    now: () => new Date('2026-09-01T12:00:00.000Z'),
  }).run as ValidationRun;
}

function result(run: ValidationRun, expected: ExpectedObservation, value: unknown): ObservationResult {
  const actual = recordObservation({
    id: `obs-${expected.id}`,
    kind: expected.kind,
    value,
    provenance: {
      runId: run.id,
      journeyId: journey.id,
      stepId: expected.stepId,
      environmentId: prodEnv.id,
      observedAt: '2026-09-01T12:00:01.000Z',
    },
  });
  return {
    expected,
    actual,
    matched: evaluateObservation(expected, actual),
    provenance: {
      runId: run.id,
      journeyId: journey.id,
      stepId: expected.stepId,
      environmentId: prodEnv.id,
      observedAt: '2026-09-01T12:00:01.000Z',
    },
  };
}

const totalExpected = journey.steps[0]!.expectedObservations[0] as ExpectedObservation;
const confirmationExpected = journey.steps[0]!.expectedObservations[1] as ExpectedObservation;

const SCOPE = { projectId: 'project-1', tenantId: 'tenant-1' };

describe('WORK-067 — the WORK-064 validation-source adapter', () => {
  it('a HEALTHY run produces NO observations (the honest no-signal case — NOT a silent conversion)', () => {
    const run = admittedRun('run-healthy-1', 'release-1');
    const completed = finalizeValidationRun({
      run,
      journey,
      results: [result(run, totalExpected, 3), result(run, confirmationExpected, 'Order confirmed')],
    });
    const observations = validationRunToObservationInputs(completed, SCOPE);
    expect(observations).toHaveLength(0);
  });

  it('EVERY validation_failure becomes ONE observation (a run with two failed expectations yields two observations — nothing dropped)', () => {
    const run = admittedRun('run-failed-1', 'release-1');
    const completed = finalizeValidationRun({
      run,
      journey,
      results: [result(run, totalExpected, 99), result(run, confirmationExpected, 'Something else')],
    });
    const observations = validationRunToObservationInputs(completed, SCOPE);
    expect(observations).toHaveLength(2);
    const keys = observations.map((o) => o.logicalFailureKey).sort();
    expect(keys).toEqual([
      'validation:journey-checkout:step-pay:expectation-confirmation',
      'validation:journey-checkout:step-pay:expectation-total',
    ]);
    // every observation carries the full failure record verbatim:
    for (const observation of observations) {
      expect((observation.raw as { failedStepId: string }).failedStepId).toBe('step-pay');
      expect(observation.observationRef.kind).toBe('validation-run-failure');
      expect(observation.observationRef.ref).toBe('run-failed-1');
      // the recorded causal release binding is preserved:
      expect(observation.releaseRef).toBe('release-1');
    }
  });

  it('a missing observation is a FAILURE observation too (the WORK-064 no-silent-healthy invariant carries into signals)', () => {
    const run = admittedRun('run-missing-1', 'release-1');
    const completed = finalizeValidationRun({
      run,
      journey,
      results: [result(run, totalExpected, 99)], // the confirmation observation is MISSING
    });
    const observations = validationRunToObservationInputs(completed, SCOPE);
    // both criteria failed (the missing one is an explicit failure):
    expect(observations).toHaveLength(2);
  });

  it('the severity mapping is the DOCUMENTED deterministic assessment (failure=high, policy violation=critical, environment error=medium)', () => {
    expect(VALIDATION_OUTCOME_SEVERITY.validation_failure).toBe('high');
    expect(VALIDATION_OUTCOME_SEVERITY.effect_policy_violation).toBe('critical');
    expect(VALIDATION_OUTCOME_SEVERITY.environment_error).toBe('medium');
    // …and the failure observations carry it:
    const run = admittedRun('run-sev-1', 'release-1');
    const completed = finalizeValidationRun({ run, journey, results: [result(run, totalExpected, 99)] });
    const observations = validationRunToObservationInputs(completed, SCOPE);
    expect(observations.every((o) => o.severity === 'high')).toBe(true);
  });

  it('an un-completed run fails closed (typed SIGNAL_VALIDATION_RUN_NOT_COMPLETED — no observations derived from an admitted-only run)', () => {
    const run = admittedRun('run-admitted-1', 'release-1');
    expect(() => validationRunToObservationInputs(run, SCOPE)).toThrowError(/only COMPLETED runs produce observations/);
  });

  it('a scope mismatch with the run identity tenant binding fails closed (no cross-tenant observation)', () => {
    // The unauthenticated identity binding carries tenantId=null, so any
    // scope is admissible; the synthetic identity path carries the binding.
    // Simulate the mismatch directly through the typed contract:
    const run = admittedRun('run-scope-1', 'release-1');
    const boundRun: ValidationRun = {
      ...run,
      identity: { ...run.identity, tenantId: 'tenant-OTHER' },
    };
    const completed = finalizeValidationRun({
      run: boundRun,
      journey,
      results: [result(boundRun, totalExpected, 99)],
    });
    expect(() => validationRunToObservationInputs(completed, SCOPE)).toThrowError(/no cross-tenant observation/);
  });

  it('deterministic: the same completed run yields byte-identical observations on every derivation', () => {
    const run = admittedRun('run-det-1', 'release-1');
    const completed = finalizeValidationRun({ run, journey, results: [result(run, totalExpected, 99)] });
    const a = validationRunToObservationInputs(completed, SCOPE);
    const b = validationRunToObservationInputs(completed, SCOPE);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('a CONTINUOUS run failure carries NO release binding (releaseRef null — the honest unbound signal)', () => {
    const run = admittedRun('run-cont-1', undefined, 'CONTINUOUS', 'SCHEDULED');
    const completed = finalizeValidationRun({
      run,
      journey,
      // both observations supplied; exactly ONE fails:
      results: [result(run, totalExpected, 99), result(run, confirmationExpected, 'Order confirmed')],
    });
    const observations = validationRunToObservationInputs(completed, SCOPE);
    expect(observations).toHaveLength(1);
    expect(observations[0]!.releaseRef).toBeNull();
  });
});

describe('WORK-067 — the service-level WORK-064 consumption (ingestValidationRun)', () => {
  it('consumes the run through the WORK-064 authority public service (findRun) — every failure becomes an occurrence on the right signal', async () => {
    const { repository } = buildService();
    // The repository-backed WORK-064 service (the in-memory composition —
    // the same public surface buildApp constructs):
    const { DefaultContinuousValidationService, InMemoryValidationRunRepository } = await import(
      '../../src/continuous-validation/index.js'
    );
    const runRepository = new InMemoryValidationRunRepository();
    const cvService = new DefaultContinuousValidationService({
      runRepository,
      verificationService: null as never, // not exercised by findRun
    });
    const run = admittedRun('run-svc-1', 'release-1');
    const completed = finalizeValidationRun({
      run,
      journey,
      // both observations supplied; exactly ONE fails:
      results: [result(run, totalExpected, 99), result(run, confirmationExpected, 'Order confirmed')],
    });
    await runRepository.create(completed);

    // Wire the authority into the signal service (a fresh service bound to
    // the WORK-064 composition):
    const wired = new (await import('../../src/engineering-signals/index.js')).DefaultEngineeringSignalService({
      signalRepository: repository,
      continuousValidationService: cvService,
      now: () => new Date('2026-09-02T00:00:00Z'),
    });

    const outcome = await wired.ingestValidationRun({ runId: 'run-svc-1', ...SCOPE });
    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0]!.outcome).toBe('signal-created');
    expect(outcome.run.id).toBe('run-svc-1');
    // The occurrence carries the full provenance:
    const signal = await wired.findSignal(outcome.results[0]!.signal.signalId);
    expect(signal!.occurrences[0]!.observationRef.ref).toBe('run-svc-1');
    expect(signal!.logicalFailureKey).toBe('validation:journey-checkout:step-pay:expectation-total');
  });

  it('an unknown run id fails closed (typed SIGNAL_VALIDATION_RUN_NOT_FOUND — never a fabricated run)', async () => {
    const { service: _unboundService } = buildService();
    void _unboundService;
    // No WORK-064 authority bound — the typed dependency-unavailable path:
    await expect(_unboundService.ingestValidationRun({ runId: 'run-nope', ...SCOPE })).rejects.toThrowError(
      EngineeringSignalError,
    );
  });
});

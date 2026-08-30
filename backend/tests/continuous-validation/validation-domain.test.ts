import { describe, it, expect } from 'vitest';

/**
 * WORK-064 Task 2 — the continuous-validation domain contracts.
 *
 * The closed vocabularies, the immutable domain records, and the runtime
 * constructor/guard boundaries. Every invariant here is a load-bearing
 * WORK-064 contract (spec/work-orders/WORK-064.md, "Required invariants";
 * spec/architecture/v1.1/validation-model.md).
 */
import {
  EFFECT_POLICIES,
  VALIDATION_MODES,
  VALIDATION_TRIGGERS,
  VALIDATION_OUTCOME_KINDS,
  OBSERVATION_KINDS,
  ENVIRONMENT_KINDS,
  TEST_PRINCIPAL_CLASSES,
  defineValidationJourney,
  describeEnvironment,
  ValidationDomainError,
  type ValidationRun,
  type ExpectedObservation,
  type ValidationObservation,
  type ObservationProvenance,
  type ValidationMode,
  type TestIdentityBinding,
  type ValidationOutcome,
} from '../../src/continuous-validation/index.js';

// ---------------------------------------------------------------------------
// Test fixtures (valid baselines mutated per invariant)
// ---------------------------------------------------------------------------

const validExpected: ExpectedObservation = {
  id: 'obs-signin-dashboard-heading',
  stepId: 'step-open-dashboard',
  kind: 'dom',
  description: 'the dashboard heading is visible',
  matcher: { kind: 'equals', value: 'Your projects' },
};

const validStep = {
  id: 'step-open-dashboard',
  name: 'open the dashboard',
  expectedObservations: [validExpected],
};

const validJourneyInput = {
  id: 'journey-sign-in',
  name: 'Sign in and reach the dashboard',
  identityRequirement: 'unauthenticated' as const,
  allowedModes: ['PRE_MERGE'] as const,
  effectPolicy: 'READ_ONLY' as const,
  steps: [validStep],
  successCriteria: [
    {
      id: 'criterion-dashboard-reachable',
      description: 'the dashboard renders for the visitor',
      requiresObservationIds: ['obs-signin-dashboard-heading'],
    },
  ],
};

const validEnvironmentInput = {
  id: 'env-pr-42-preview',
  kind: 'preview' as const,
  acceptedPolicies: ['READ_ONLY', 'SAFE_MUTATION', 'ISOLATED_MUTATION'] as const,
  isolatedTenantId: 'tenant-test-1',
};

// ---------------------------------------------------------------------------
// §1 The closed vocabularies (the enum contracts of the Work Order)
// ---------------------------------------------------------------------------

describe('WORK-064 domain — closed vocabularies', () => {
  it('EffectPolicy is exactly the four Work Order policies', () => {
    expect([...EFFECT_POLICIES]).toEqual([
      'READ_ONLY',
      'SAFE_MUTATION',
      'ISOLATED_MUTATION',
      'FORBIDDEN',
    ]);
  });

  it('ValidationMode is exactly the three lifecycle modes', () => {
    expect([...VALIDATION_MODES]).toEqual(['PRE_MERGE', 'POST_RELEASE', 'CONTINUOUS']);
  });

  it('ValidationTrigger is exactly the nine lifecycle triggers', () => {
    expect([...VALIDATION_TRIGGERS]).toEqual([
      'PR',
      'DEPLOYMENT',
      'RELEASE',
      'SCHEDULED',
      'RUNTIME_SIGNAL',
      'ARCHITECTURE_CHANGE',
      'SECURITY_FINDING',
      'DEPENDENCY_CHANGE',
      'USER_FEEDBACK',
    ]);
  });

  it('ValidationOutcome distinguishes the four typed outcomes — healthy is never the default', () => {
    expect([...VALIDATION_OUTCOME_KINDS]).toEqual([
      'healthy',
      'validation_failure',
      'effect_policy_violation',
      'environment_error',
    ]);
  });

  it('ObservationKind is exactly the four observation channels', () => {
    expect([...OBSERVATION_KINDS]).toEqual([
      'dom',
      'network',
      'persisted_record',
      'downstream_event',
    ]);
  });

  it('EnvironmentKind is preview / isolated / production', () => {
    expect([...ENVIRONMENT_KINDS]).toEqual(['preview', 'isolated', 'production']);
  });

  it('TestPrincipalClass is the closed synthetic classification (unauthenticated + synthetic classes)', () => {
    expect([...TEST_PRINCIPAL_CLASSES]).toEqual([
      'unauthenticated',
      'test_user',
      'test_service_account',
      'test_organization_owner',
      'test_project_member',
    ]);
  });
});

// ---------------------------------------------------------------------------
// §2 ValidationJourney construction — the declaration guards
// ---------------------------------------------------------------------------

describe('WORK-064 domain — defineValidationJourney guards', () => {
  it('accepts the valid baseline and echoes it immutably', () => {
    const journey = defineValidationJourney(validJourneyInput);
    expect(journey.id).toBe('journey-sign-in');
    expect(journey.effectPolicy).toBe('READ_ONLY');
    expect(journey.identityRequirement).toBe('unauthenticated');
    expect(journey.steps).toHaveLength(1);
    expect(journey.successCriteria).toHaveLength(1);
    expect(() => {
      // Immutability is part of the contract — mutation throws at runtime
      // (Object.freeze) and the readonly surface rejects it at compile time.
      (journey as { id: string }).id = 'mutated';
    }).toThrow();
  });

  it('rejects an empty journey identifier', () => {
    expect(() => defineValidationJourney({ ...validJourneyInput, id: '' })).toThrow(
      ValidationDomainError,
    );
  });

  it('rejects an empty journey name', () => {
    expect(() => defineValidationJourney({ ...validJourneyInput, name: '' })).toThrow(
      ValidationDomainError,
    );
  });

  it('rejects an invalid effect policy (not one of the closed set)', () => {
    expect(() =>
      defineValidationJourney({
        ...validJourneyInput,
        // @ts-expect-error — the invalid value must be rejected at RUNTIME, not just compile time
        effectPolicy: 'MUTATE_ANYTHING',
      }),
    ).toThrow(ValidationDomainError);
  });

  it('rejects an empty allowedModes set and invalid mode members', () => {
    expect(() => defineValidationJourney({ ...validJourneyInput, allowedModes: [] })).toThrow(
      ValidationDomainError,
    );
    expect(() =>
      defineValidationJourney({
        ...validJourneyInput,
        allowedModes: ['PRE_LAUNCH_PARTY' as unknown as ValidationMode],
      }),
    ).toThrow(ValidationDomainError);
  });

  it('rejects an invalid identity requirement', () => {
    expect(() =>
      defineValidationJourney({
        ...validJourneyInput,
        // @ts-expect-error — invalid member
        identityRequirement: 'whoever',
      }),
    ).toThrow(ValidationDomainError);
  });

  it('rejects a journey with no steps (nothing to observe)', () => {
    expect(() => defineValidationJourney({ ...validJourneyInput, steps: [] })).toThrow(
      ValidationDomainError,
    );
  });

  it('rejects steps with empty identifiers or empty names', () => {
    expect(() =>
      defineValidationJourney({ ...validJourneyInput, steps: [{ ...validStep, id: '' }] }),
    ).toThrow(ValidationDomainError);
    expect(() =>
      defineValidationJourney({ ...validJourneyInput, steps: [{ ...validStep, name: '' }] }),
    ).toThrow(ValidationDomainError);
  });

  it('rejects duplicate step identifiers (ambiguous provenance)', () => {
    expect(() =>
      defineValidationJourney({
        ...validJourneyInput,
        steps: [validStep, validStep],
      }),
    ).toThrow(ValidationDomainError);
  });

  it('rejects an expected observation whose stepId does not match its owning step (broken provenance)', () => {
    expect(() =>
      defineValidationJourney({
        ...validJourneyInput,
        steps: [
          {
            id: 'step-open-dashboard',
            name: 'open the dashboard',
            expectedObservations: [{ ...validExpected, stepId: 'step-somewhere-else' }],
          },
        ],
      }),
    ).toThrow(ValidationDomainError);
  });

  it('rejects an expected observation with an invalid kind or invalid matcher', () => {
    expect(() =>
      defineValidationJourney({
        ...validJourneyInput,
        steps: [
          {
            id: 'step-open-dashboard',
            name: 'open the dashboard',
            expectedObservations: [
              // @ts-expect-error — invalid kind at runtime
              { ...validExpected, kind: 'vibes' },
            ],
          },
        ],
      }),
    ).toThrow(ValidationDomainError);
    expect(() =>
      defineValidationJourney({
        ...validJourneyInput,
        steps: [
          {
            id: 'step-open-dashboard',
            name: 'open the dashboard',
            expectedObservations: [
              // @ts-expect-error — invalid matcher at runtime
              { ...validExpected, matcher: { kind: 'hopefully-true' } },
            ],
          },
        ],
      }),
    ).toThrow(ValidationDomainError);
  });

  it('rejects a success criterion referencing an unknown observation id (unprovable criterion)', () => {
    expect(() =>
      defineValidationJourney({
        ...validJourneyInput,
        successCriteria: [
          {
            id: 'criterion-impossible',
            description: 'references nothing',
            requiresObservationIds: ['obs-does-not-exist'],
          },
        ],
      }),
    ).toThrow(ValidationDomainError);
  });
});

// ---------------------------------------------------------------------------
// §3 Environment construction — the capability envelope guards
// ---------------------------------------------------------------------------

describe('WORK-064 domain — describeEnvironment guards', () => {
  it('accepts the valid baseline and echoes it immutably', () => {
    const environment = describeEnvironment(validEnvironmentInput);
    expect(environment.id).toBe('env-pr-42-preview');
    expect(environment.kind).toBe('preview');
    expect(environment.acceptedPolicies).toContain('READ_ONLY');
    expect(environment.isolatedTenantId).toBe('tenant-test-1');
    expect(environment.approvedSafeMechanism).toBe(false);
  });

  it('rejects an empty environment identifier', () => {
    expect(() => describeEnvironment({ ...validEnvironmentInput, id: '' })).toThrow(
      ValidationDomainError,
    );
  });

  it('rejects an invalid environment kind', () => {
    expect(() =>
      describeEnvironment({
        ...validEnvironmentInput,
        // @ts-expect-error — invalid kind at runtime
        kind: 'staging-ish',
      }),
    ).toThrow(ValidationDomainError);
  });

  it('rejects an empty or invalid acceptedPolicies set (fail-closed: no capability, no admission)', () => {
    expect(() => describeEnvironment({ ...validEnvironmentInput, acceptedPolicies: [] })).toThrow(
      ValidationDomainError,
    );
    expect(() =>
      describeEnvironment({
        ...validEnvironmentInput,
        // @ts-expect-error — invalid member at runtime
        acceptedPolicies: ['READ_ONLY', 'SUPER_MUTATION'],
      }),
    ).toThrow(ValidationDomainError);
  });

  it('rejects ISOLATED_MUTATION acceptance without the isolated test tenant binding', () => {
    expect(() =>
      describeEnvironment({
        ...validEnvironmentInput,
        acceptedPolicies: ['READ_ONLY', 'ISOLATED_MUTATION'],
        isolatedTenantId: undefined,
      }),
    ).toThrow(ValidationDomainError);
  });
});

// ---------------------------------------------------------------------------
// §4 The domain records carry the full provenance surface (compile-time
//    structural assertions — `bun run typecheck` enforces these)
// ---------------------------------------------------------------------------

describe('WORK-064 domain — record provenance surface (structural)', () => {
  it('ValidationRun carries journey, identity, environment, policy, observations, mode, trigger, and outcome', () => {
    // A structurally-complete ValidationRun. If the type loses any required
    // provenance field, typecheck fails here (tests are in the tsconfig).
    const run: ValidationRun = {
      id: 'run-1',
      journeyId: 'journey-sign-in',
      journeyName: 'Sign in and reach the dashboard',
      identity: {
        principalId: null,
        principalClass: 'unauthenticated',
        capabilities: [],
        tenantId: null,
        issuer: 'WORK-063',
        issuanceReason: null,
      },
      environmentId: 'env-pr-42-preview',
      environmentKind: 'preview',
      effectPolicy: 'READ_ONLY',
      mode: 'PRE_MERGE',
      trigger: 'PR',
      releaseRef: null,
      status: 'admitted',
      observations: [],
      outcome: null,
      createdAt: '2026-08-30T00:00:00.000Z',
      completedAt: null,
    };
    expect(run.id).toBe('run-1');
    expect(run.identity.principalClass).toBe('unauthenticated');
  });

  it('ObservationProvenance carries run, journey, step, environment, and timestamp', () => {
    const provenance: ObservationProvenance = {
      runId: 'run-1',
      journeyId: 'journey-sign-in',
      stepId: 'step-open-dashboard',
      environmentId: 'env-pr-42-preview',
      observedAt: '2026-08-30T00:00:01.000Z',
    };
    expect(provenance.runId).toBe('run-1');
    expect(provenance.stepId).toBe('step-open-dashboard');
  });

  it('ValidationObservation carries id, kind, value, and provenance', () => {
    const observation: ValidationObservation = {
      id: 'observation-1',
      kind: 'dom',
      value: 'Your projects',
      provenance: {
        runId: 'run-1',
        journeyId: 'journey-sign-in',
        stepId: 'step-open-dashboard',
        environmentId: 'env-pr-42-preview',
        observedAt: '2026-08-30T00:00:01.000Z',
      },
    };
    expect(observation.kind).toBe('dom');
  });

  it('TestIdentityBinding carries the WORK-063 issuer provenance', () => {
    const binding: TestIdentityBinding = {
      principalId: 'principal-1',
      principalClass: 'test_service_account',
      capabilities: ['project.read'],
      tenantId: 'tenant-test-1',
      issuer: 'WORK-063',
      issuanceReason: 'PR #42 preview validation',
    };
    expect(binding.issuer).toBe('WORK-063');
  });

  it('the typed outcome vocabulary is discriminated by kind', () => {
    const healthy: ValidationOutcome = {
      kind: 'healthy',
      provenance: {
        runId: 'run-1',
        journeyId: 'journey-sign-in',
        environmentId: 'env-pr-42-preview',
        mode: 'PRE_MERGE',
        trigger: 'PR',
      },
      satisfiedCriteria: ['criterion-dashboard-reachable'],
    };
    expect(healthy.kind).toBe('healthy');
  });
});

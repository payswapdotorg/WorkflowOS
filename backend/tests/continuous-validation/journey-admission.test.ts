import { describe, it, expect } from 'vitest';

/**
 * WORK-064 Task 5 — ValidationRun admission: the composition of identity
 * binding, environment validation, effect-policy admission, and
 * mode/trigger constraints (spec/work-orders/WORK-064.md; the lifecycle §4
 * scheduling rules; the implementation plan's pinned admission list).
 *
 * Deterministic, side-effect free — admission NEVER executes anything.
 */
import {
  defineValidationJourney,
  describeEnvironment,
  admitValidationRun,
  TRIGGER_MODE_BINDING,
  type ValidationJourney,
  type Environment,
  type ValidationMode,
  type ValidationTrigger,
  type TestIdentitySource,
} from '../../src/continuous-validation/index.js';
import type { AuthenticatedPrincipal } from '@modules/auth/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const syntheticPrincipal: AuthenticatedPrincipal = {
  externalId: 'svc-validation-runner-01',
  label: 'validation runner (test service account)',
  provider: 'apikey',
};

const unauthenticated: TestIdentitySource = { kind: 'unauthenticated' };
const synthetic: TestIdentitySource = {
  kind: 'synthetic',
  principal: syntheticPrincipal,
  principalClass: 'test_service_account',
  capabilities: ['project.read'],
  tenantId: 'tenant-preview',
  issuanceReason: 'PR #42 preview validation run',
};

const previewEnv: Environment = describeEnvironment({
  id: 'env-preview',
  kind: 'preview',
  acceptedPolicies: ['READ_ONLY', 'SAFE_MUTATION', 'ISOLATED_MUTATION'],
  isolatedTenantId: 'tenant-preview',
});

const productionEnv: Environment = describeEnvironment({
  id: 'env-production',
  kind: 'production',
  acceptedPolicies: ['READ_ONLY', 'SAFE_MUTATION'],
});

const productionTenantEnv: Environment = describeEnvironment({
  id: 'env-production-tenant',
  kind: 'production',
  acceptedPolicies: ['READ_ONLY', 'SAFE_MUTATION', 'ISOLATED_MUTATION'],
  isolatedTenantId: 'tenant-prod-test',
});

/** An unauthenticated public read journey (the sign-in-page-renders journey). */
const publicJourney: ValidationJourney = defineValidationJourney({
  id: 'journey-public-sign-in-page',
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
          id: 'obs-sign-in-heading',
          stepId: 'step-open-sign-in',
          kind: 'dom',
          description: 'the sign-in heading is visible',
          matcher: { kind: 'exists' },
        },
      ],
    },
  ],
  successCriteria: [
    {
      id: 'criterion-sign-in-visible',
      description: 'the sign-in page renders',
      requiresObservationIds: ['obs-sign-in-heading'],
    },
  ],
});

/** An authenticated SAFE_MUTATION journey (create a project as the test user). */
const createProjectJourney: ValidationJourney = defineValidationJourney({
  id: 'journey-create-project',
  name: 'Create a project',
  identityRequirement: 'authenticated',
  allowedModes: ['PRE_MERGE', 'POST_RELEASE', 'CONTINUOUS'],
  effectPolicy: 'SAFE_MUTATION',
  steps: [
    {
      id: 'step-create-project',
      name: 'create a project through the form',
      expectedObservations: [
        {
          id: 'obs-project-created',
          stepId: 'step-create-project',
          kind: 'persisted_record',
          description: 'the project record exists for the synthetic identity',
          matcher: { kind: 'exists' },
        },
      ],
    },
  ],
  successCriteria: [
    {
      id: 'criterion-project-persisted',
      description: 'the project is persisted',
      requiresObservationIds: ['obs-project-created'],
    },
  ],
});

/** An ISOLATED_MUTATION journey (mutate inside the test tenant). */
const isolatedJourney: ValidationJourney = defineValidationJourney({
  id: 'journey-isolated-mutation',
  name: 'Create a project (isolated tenant)',
  identityRequirement: 'authenticated',
  allowedModes: ['PRE_MERGE', 'POST_RELEASE', 'CONTINUOUS'],
  effectPolicy: 'ISOLATED_MUTATION',
  steps: [
    {
      id: 'step-create-project',
      name: 'create a project through the form',
      expectedObservations: [
        {
          id: 'obs-project-created',
          stepId: 'step-create-project',
          kind: 'persisted_record',
          description: 'the project record exists inside the test tenant',
          matcher: { kind: 'exists' },
        },
      ],
    },
  ],
  successCriteria: [
    {
      id: 'criterion-project-persisted',
      description: 'the project is persisted',
      requiresObservationIds: ['obs-project-created'],
    },
  ],
});

/** A FORBIDDEN-in-production journey (real checkout with a real payment). */
const forbiddenJourney: ValidationJourney = defineValidationJourney({
  id: 'journey-real-checkout',
  name: 'Real checkout (dangerous — sandbox only)',
  identityRequirement: 'authenticated',
  allowedModes: ['PRE_MERGE', 'POST_RELEASE', 'CONTINUOUS'],
  effectPolicy: 'FORBIDDEN',
  steps: [
    {
      id: 'step-checkout',
      name: 'complete a real checkout',
      expectedObservations: [
        {
          id: 'obs-checkout-confirmation',
          stepId: 'step-checkout',
          kind: 'downstream_event',
          description: 'the payment confirmation event arrives',
          matcher: { kind: 'exists' },
        },
      ],
    },
  ],
  successCriteria: [
    {
      id: 'criterion-checkout-confirmed',
      description: 'the checkout is confirmed',
      requiresObservationIds: ['obs-checkout-confirmation'],
    },
  ],
});

const baseRequest = {
  journey: publicJourney,
  identitySource: unauthenticated,
  environment: previewEnv,
  mode: 'PRE_MERGE' as const,
  trigger: 'PR' as const,
  runId: 'run-admission-1',
  now: () => new Date('2026-08-30T12:00:00.000Z'),
};

// ---------------------------------------------------------------------------
// §1 The admission happy paths
// ---------------------------------------------------------------------------

describe('WORK-064 run admission — happy paths', () => {
  it('admits an unauthenticated READ_ONLY public journey in PRE_MERGE with the full run record', () => {
    const admission = admitValidationRun(baseRequest);
    expect(admission.admitted).toBe(true);
    expect(admission.code).toBe('ADMITTED');
    expect(admission.run).not.toBeNull();
    expect(admission.run?.id).toBe('run-admission-1');
    expect(admission.run?.journeyId).toBe('journey-public-sign-in-page');
    expect(admission.run?.identity.principalClass).toBe('unauthenticated');
    expect(admission.run?.environmentId).toBe('env-preview');
    expect(admission.run?.effectPolicy).toBe('READ_ONLY');
    expect(admission.run?.mode).toBe('PRE_MERGE');
    expect(admission.run?.trigger).toBe('PR');
    expect(admission.run?.status).toBe('admitted');
    expect(admission.run?.outcome).toBeNull();
    expect(admission.run?.observations).toEqual([]);
    expect(admission.run?.createdAt).toBe('2026-08-30T12:00:00.000Z');
  });

  it('admits an authenticated SAFE_MUTATION journey with a synthetic principal', () => {
    const admission = admitValidationRun({
      journey: createProjectJourney,
      identitySource: { ...synthetic, tenantId: undefined },
      environment: previewEnv,
      mode: 'PRE_MERGE',
      trigger: 'PR',
      runId: 'run-2',
    });
    expect(admission.admitted).toBe(true);
    expect(admission.run?.identity.principalId).toBe('svc-validation-runner-01');
    expect(admission.run?.identity.principalClass).toBe('test_service_account');
  });

  it('admits an ISOLATED_MUTATION journey against the tenant-bound preview', () => {
    const admission = admitValidationRun({
      journey: isolatedJourney,
      identitySource: synthetic,
      environment: previewEnv,
      mode: 'PRE_MERGE',
      trigger: 'PR',
      runId: 'run-3',
    });
    expect(admission.admitted).toBe(true);
    expect(admission.run?.effectPolicy).toBe('ISOLATED_MUTATION');
  });

  it('admits POST_RELEASE READ_ONLY with an explicit release reference', () => {
    const admission = admitValidationRun({
      journey: publicJourney,
      identitySource: unauthenticated,
      environment: productionEnv,
      mode: 'POST_RELEASE',
      trigger: 'RELEASE',
      releaseRef: 'release-2026.08.30-01',
      runId: 'run-4',
    });
    expect(admission.admitted).toBe(true);
    expect(admission.run?.releaseRef).toBe('release-2026.08.30-01');
  });

  it('admits CONTINUOUS READ_ONLY only with explicit configuration', () => {
    const admitted = admitValidationRun({
      journey: publicJourney,
      identitySource: unauthenticated,
      environment: productionEnv,
      mode: 'CONTINUOUS',
      trigger: 'SCHEDULED',
      continuousConfigured: true,
      runId: 'run-5',
    });
    expect(admitted.admitted).toBe(true);

    const rejected = admitValidationRun({
      journey: publicJourney,
      identitySource: unauthenticated,
      environment: productionEnv,
      mode: 'CONTINUOUS',
      trigger: 'SCHEDULED',
      runId: 'run-6',
    });
    expect(rejected.admitted).toBe(false);
    expect(rejected.code).toBe('ADMISSION_CONTINUOUS_CONFIGURATION_REQUIRED');
  });
});

// ---------------------------------------------------------------------------
// §2 The rejection matrix (deterministic order, typed codes)
// ---------------------------------------------------------------------------

describe('WORK-064 run admission — rejections', () => {
  it('rejects a mode the journey does not allow', () => {
    const journey = defineValidationJourney({
      ...publicJourney,
      allowedModes: ['PRE_MERGE'],
    });
    const admission = admitValidationRun({
      ...baseRequest,
      journey,
      mode: 'POST_RELEASE',
      trigger: 'RELEASE',
      releaseRef: 'release-1',
      environment: productionEnv,
    });
    expect(admission.admitted).toBe(false);
    expect(admission.code).toBe('ADMISSION_MODE_NOT_ALLOWED');
    expect(admission.run).toBeNull();
  });

  it('rejects an invalid mode/trigger pair (the lifecycle §3 binding)', () => {
    // RELEASE trigger is POST_RELEASE-only; PR trigger is PRE_MERGE-only.
    const releaseInPreMerge = admitValidationRun({
      ...baseRequest,
      trigger: 'RELEASE',
    });
    expect(releaseInPreMerge.admitted).toBe(false);
    expect(releaseInPreMerge.code).toBe('ADMISSION_TRIGGER_MODE_MISMATCH');

    const prInPostRelease = admitValidationRun({
      ...baseRequest,
      mode: 'POST_RELEASE',
      trigger: 'PR',
      environment: productionEnv,
      releaseRef: 'release-1',
    });
    expect(prInPostRelease.admitted).toBe(false);
    expect(prInPostRelease.code).toBe('ADMISSION_TRIGGER_MODE_MISMATCH');
  });

  it('rejects an environment invalid for the mode (PRE_MERGE never runs against production)', () => {
    const admission = admitValidationRun(baseRequest);
    expect(admission.admitted).toBe(true); // baseline

    const wrongEnv = admitValidationRun({
      ...baseRequest,
      environment: productionEnv,
    });
    expect(wrongEnv.admitted).toBe(false);
    expect(wrongEnv.code).toBe('ADMISSION_ENVIRONMENT_MODE_MISMATCH');
  });

  it('rejects an identity requirement mismatch in BOTH directions', () => {
    // An authenticated journey cannot run unauthenticated:
    const noIdentity = admitValidationRun({
      ...baseRequest,
      journey: createProjectJourney,
      identitySource: unauthenticated,
    });
    expect(noIdentity.admitted).toBe(false);
    expect(noIdentity.code).toBe('ADMISSION_IDENTITY_INVALID');

    // An unauthenticated journey cannot run with a synthetic principal:
    const withIdentity = admitValidationRun({
      ...baseRequest,
      journey: publicJourney,
      identitySource: synthetic,
    });
    expect(withIdentity.admitted).toBe(false);
    expect(withIdentity.code).toBe('ADMISSION_IDENTITY_INVALID');
  });

  it('rejects when the effect-policy matrix rejects (SAFE_MUTATION against a READ_ONLY-only environment)', () => {
    const readOnlyEnv = describeEnvironment({
      id: 'env-read-only-preview',
      kind: 'preview',
      acceptedPolicies: ['READ_ONLY'],
    });
    const admission = admitValidationRun({
      ...baseRequest,
      journey: createProjectJourney,
      identitySource: { ...synthetic, tenantId: undefined },
      environment: readOnlyEnv,
    });
    expect(admission.admitted).toBe(false);
    expect(admission.code).toBe('ADMISSION_EFFECT_POLICY_REJECTED');
  });

  it('rejects a FORBIDDEN journey against production in EVERY mode (defense in depth)', () => {
    for (const mode of ['PRE_MERGE', 'POST_RELEASE', 'CONTINUOUS'] as const) {
      const trigger: ValidationTrigger = mode === 'PRE_MERGE' ? 'PR' : mode === 'POST_RELEASE' ? 'RELEASE' : 'SCHEDULED';
      const admission = admitValidationRun({
        journey: forbiddenJourney,
        identitySource: synthetic,
        environment: productionEnv,
        mode,
        trigger,
        ...(mode === 'POST_RELEASE' ? { releaseRef: 'release-1' } : {}),
        ...(mode === 'CONTINUOUS' ? { continuousConfigured: true } : {}),
      });
      expect(admission.admitted).toBe(false);
      // Deterministic order: in PRE_MERGE a production environment is
      // structurally invalid for the mode (kind mismatch fires first); in
      // POST_RELEASE/CONTINUOUS the environment kind is valid and the
      // explicit FORBIDDEN×production defense-in-depth rejection fires.
      expect(admission.code).toBe(
        mode === 'PRE_MERGE'
          ? 'ADMISSION_ENVIRONMENT_MODE_MISMATCH'
          : 'ADMISSION_FORBIDDEN_PRODUCTION_JOURNEY',
      );
    }
  });

  it('rejects POST_RELEASE without an explicit release reference (no release authority exists yet — fail closed)', () => {
    const admission = admitValidationRun({
      ...baseRequest,
      mode: 'POST_RELEASE',
      trigger: 'RELEASE',
      environment: productionEnv,
      // no releaseRef
    });
    expect(admission.admitted).toBe(false);
    expect(admission.code).toBe('ADMISSION_RELEASE_REFERENCE_REQUIRED');
  });

  it('every rejection carries a non-empty reason and echoes the request context', () => {
    const admission = admitValidationRun({
      ...baseRequest,
      environment: productionEnv,
    });
    expect(admission.admitted).toBe(false);
    expect(typeof admission.reason).toBe('string');
    expect(admission.reason.length).toBeGreaterThan(0);
    expect(admission.journey.id).toBe('journey-public-sign-in-page');
    expect(admission.environment.id).toBe('env-production');
    expect(admission.mode).toBe('PRE_MERGE');
    expect(admission.trigger).toBe('PR');
  });
});

// ---------------------------------------------------------------------------
// §3 The cross-product discrimination (plan Task 5 Step 4)
// ---------------------------------------------------------------------------

describe('WORK-064 run admission — cross-product discrimination', () => {
  const modes: readonly ValidationMode[] = ['PRE_MERGE', 'POST_RELEASE', 'CONTINUOUS'];
  const policies: readonly ('READ_ONLY' | 'SAFE_MUTATION' | 'ISOLATED_MUTATION' | 'FORBIDDEN')[] = [
    'READ_ONLY',
    'SAFE_MUTATION',
    'ISOLATED_MUTATION',
    'FORBIDDEN',
  ];

  const envForMode = (mode: ValidationMode): Environment =>
    mode === 'PRE_MERGE' ? previewEnv : productionTenantEnv;

  const triggerForMode = (mode: ValidationMode): ValidationTrigger =>
    mode === 'PRE_MERGE' ? 'PR' : mode === 'POST_RELEASE' ? 'RELEASE' : 'SCHEDULED';

  it('the full mode × policy × identity cross-product only admits what the matrix allows', () => {
    for (const mode of modes) {
      for (const policy of policies) {
        for (const identitySource of [unauthenticated, synthetic]) {
          const environment = envForMode(mode);
          const journey = defineValidationJourney({
            ...publicJourney,
            identityRequirement: identitySource.kind === 'unauthenticated' ? 'unauthenticated' : 'authenticated',
            effectPolicy: policy,
          });
          // The synthetic identity's test tenant must match the target
          // environment's isolated tenant (cross-tenant isolation):
          const tenantMatchedSynthetic: TestIdentitySource =
            environment.isolatedTenantId === null
              ? { ...synthetic, tenantId: undefined }
              : { ...synthetic, tenantId: environment.isolatedTenantId };
          const source =
            identitySource.kind === 'unauthenticated' ? identitySource : tenantMatchedSynthetic;
          const admission = admitValidationRun({
            journey,
            identitySource: source,
            environment,
            mode,
            trigger: triggerForMode(mode),
            ...(mode === 'POST_RELEASE' ? { releaseRef: 'release-x' } : {}),
            ...(mode === 'CONTINUOUS' ? { continuousConfigured: true } : {}),
            runId: `run-xproduct-${mode}-${policy}-${identitySource.kind}`,
          });

          // The expected matrix (the Work Order's safety contract):
          // - FORBIDDEN is never admitted here (neither cross-product
          //   environment declares FORBIDDEN acceptance — and production
          //   never admits it in any shape);
          // - An unauthenticated identity supports READ_ONLY only;
          // - ISOLATED_MUTATION requires the tenant binding (synthetic has it).
          const forbiddenAnywhere = policy === 'FORBIDDEN';
          const unauthenticatedMutation =
            identitySource.kind === 'unauthenticated' && policy !== 'READ_ONLY';
          const expectedAdmitted = !forbiddenAnywhere && !unauthenticatedMutation;

          expect(admission.admitted).toBe(expectedAdmitted);
          if (!expectedAdmitted) {
            expect(admission.code).not.toBe('ADMITTED');
            expect(admission.reason.length).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it('an invalid mode or trigger string fails closed', () => {
    const invalidMode = admitValidationRun({
      ...baseRequest,
      // @ts-expect-error — foreign mode at runtime
      mode: 'SOMETIME',
    });
    expect(invalidMode.admitted).toBe(false);

    const invalidTrigger = admitValidationRun({
      ...baseRequest,
      // @ts-expect-error — foreign trigger at runtime
      trigger: 'WHIM',
    });
    expect(invalidTrigger.admitted).toBe(false);
  });

  it('the trigger→mode binding table is consistent with the lifecycle §3 normative table', () => {
    expect(TRIGGER_MODE_BINDING.PR).toEqual(['PRE_MERGE']);
    expect(TRIGGER_MODE_BINDING.DEPLOYMENT).toEqual(['PRE_MERGE']);
    expect(TRIGGER_MODE_BINDING.RELEASE).toEqual(['POST_RELEASE']);
    expect(TRIGGER_MODE_BINDING.SCHEDULED).toEqual(['CONTINUOUS']);
    expect(TRIGGER_MODE_BINDING.RUNTIME_SIGNAL).toEqual(['CONTINUOUS']);
    expect(TRIGGER_MODE_BINDING.ARCHITECTURE_CHANGE).toEqual(['PRE_MERGE']);
    expect(TRIGGER_MODE_BINDING.SECURITY_FINDING).toEqual(['PRE_MERGE', 'POST_RELEASE']);
    expect(TRIGGER_MODE_BINDING.DEPENDENCY_CHANGE).toEqual(['PRE_MERGE', 'POST_RELEASE']);
    expect(TRIGGER_MODE_BINDING.USER_FEEDBACK).toEqual(['CONTINUOUS']);
  });
});

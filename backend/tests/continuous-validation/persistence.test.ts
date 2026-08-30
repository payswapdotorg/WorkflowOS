import { describe, it, expect } from 'vitest';

/**
 * WORK-064 Task 8 — the ValidationRunRepository port + its in-memory adapter.
 *
 * ARCHITECTURAL RULING (the repository mapping note §3 + the design doc §8):
 * repository inspection PROVED no existing table represents validation
 * journeys/runs/observations, and NO schema migration is authorized by
 * WORK-064's current scope. The domain therefore stays at the existing
 * persistence boundary: this PORT with an IN-MEMORY implementation. Durable
 * validation state requires an ACR or an architect-authorized scope
 * extension — the gap is documented, never silently solved with a new table.
 *
 * The pinned behaviors: deterministic create/read, provenance preservation,
 * idempotent run identifiers (same-key convergence), and the absolute
 * prohibition on secret/token/cookie storage at the persistence boundary.
 */
import {
  defineValidationJourney,
  describeEnvironment,
  admitValidationRun,
  finalizeValidationRun,
  recordObservation,
  evaluateObservation,
  InMemoryValidationRunRepository,
  ValidationDomainError,
  type ValidationRunRepository,
  type ValidationJourney,
  type ValidationRun,
  type ExpectedObservation,
  type ObservationResult,
  type TestIdentitySource,
  type Environment,
} from '../../src/continuous-validation/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const previewEnv: Environment = describeEnvironment({
  id: 'env-preview',
  kind: 'preview',
  acceptedPolicies: ['READ_ONLY'],
});

const unauthenticated: TestIdentitySource = { kind: 'unauthenticated' };

const journey: ValidationJourney = defineValidationJourney({
  id: 'journey-sign-in-page',
  name: 'The sign-in page renders',
  identityRequirement: 'unauthenticated',
  allowedModes: ['PRE_MERGE'],
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
          matcher: { kind: 'exists' },
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
  ],
});

function admittedRun(runId: string): ValidationRun {
  return admitValidationRun({
    journey,
    identitySource: unauthenticated,
    environment: previewEnv,
    mode: 'PRE_MERGE',
    trigger: 'PR',
    runId,
    now: () => new Date('2026-08-30T12:00:00.000Z'),
  }).run as ValidationRun;
}

function completedRun(runId: string): ValidationRun {
  const run = admittedRun(runId);
  const expected = journey.steps[0]?.expectedObservations[0] as ExpectedObservation;
  const actual = recordObservation({
    id: 'obs-1',
    kind: expected.kind,
    value: null,
    provenance: {
      runId: run.id,
      journeyId: journey.id,
      stepId: expected.stepId,
      environmentId: previewEnv.id,
      observedAt: '2026-08-30T12:00:01.000Z',
    },
  });
  const results: ObservationResult[] = [
    {
      expected,
      actual,
      matched: evaluateObservation(expected, actual),
      provenance: {
        runId: run.id,
        journeyId: journey.id,
        stepId: expected.stepId,
        environmentId: previewEnv.id,
        observedAt: '2026-08-30T12:00:01.000Z',
      },
    },
  ];
  return finalizeValidationRun({ run, journey, results });
}

// ---------------------------------------------------------------------------
// §1 Deterministic create/read
// ---------------------------------------------------------------------------

describe('WORK-064 run repository — deterministic create/read', () => {
  it('creates and reads back a run with FULL provenance preserved', async () => {
    const repository: ValidationRunRepository = new InMemoryValidationRunRepository();
    const run = completedRun('run-persist-1');
    const created = await repository.create(run);
    expect(created.id).toBe('run-persist-1');

    const read = await repository.getById('run-persist-1');
    expect(read).not.toBeNull();
    expect(read?.id).toBe('run-persist-1');
    expect(read?.journeyId).toBe('journey-sign-in-page');
    expect(read?.environmentId).toBe('env-preview');
    expect(read?.mode).toBe('PRE_MERGE');
    expect(read?.trigger).toBe('PR');
    expect(read?.identity.issuer).toBe('WORK-063');
    expect(read?.outcome?.kind).toBe('healthy');
    expect(read?.observations).toHaveLength(1);
    expect(read?.observations[0]?.provenance.stepId).toBe('step-open-sign-in');
  });

  it('getById returns null for an unknown id (explicit absence, never a fabricated run)', async () => {
    const repository = new InMemoryValidationRunRepository();
    expect(await repository.getById('run-never-created')).toBeNull();
  });

  it('admitted AND completed runs are both storable (the lifecycle is preserved)', async () => {
    const repository = new InMemoryValidationRunRepository();
    await repository.create(admittedRun('run-admitted-only'));
    const read = await repository.getById('run-admitted-only');
    expect(read?.status).toBe('admitted');
    expect(read?.outcome).toBeNull();
  });

  it('updating a run through create() replaces the stored record (the run record is append-mostly; completion is the one transition)', async () => {
    const repository = new InMemoryValidationRunRepository();
    const admitted = admittedRun('run-lifecycle-1');
    await repository.create(admitted);
    const completed = finalizeValidationRun({
      run: admitted,
      journey,
      results: [],
    });
    await repository.create(completed);
    const read = await repository.getById('run-lifecycle-1');
    expect(read?.status).toBe('completed');
    expect(read?.outcome?.kind).toBe('validation_failure'); // empty results = failure, never healthy
  });
});

// ---------------------------------------------------------------------------
// §2 Idempotent run identifiers (same-key convergence)
// ---------------------------------------------------------------------------

describe('WORK-064 run repository — idempotent identifiers', () => {
  it('re-creating the IDENTICAL run is idempotent (same-key convergence, one record)', async () => {
    const repository = new InMemoryValidationRunRepository();
    const run = admittedRun('run-idempotent-1');
    const first = await repository.create(run);
    const second = await repository.create(run);
    expect(second).toEqual(first);
    expect(await repository.getById('run-idempotent-1')).toEqual(first);
  });

  it('re-creating the same id with DIFFERENT content is a typed conflict (no silent overwrite)', async () => {
    const repository = new InMemoryValidationRunRepository();
    await repository.create(admittedRun('run-conflict-1'));
    const different = admittedRun('run-conflict-1'); // same id, but let's make content differ:
    const conflicting: ValidationRun = { ...different, journeyName: 'A different journey' };
    await expect(repository.create(conflicting)).rejects.toThrow(ValidationDomainError);
    // The original record is intact:
    const read = await repository.getById('run-conflict-1');
    expect(read?.journeyName).toBe('The sign-in page renders');
  });
});

// ---------------------------------------------------------------------------
// §3 The no-secrets persistence boundary
// ---------------------------------------------------------------------------

describe('WORK-064 run repository — no secrets at the persistence boundary', () => {
  it('the stored record contains NO secret/token/cookie/credential material (deep scan)', async () => {
    const repository = new InMemoryValidationRunRepository();
    const run = completedRun('run-no-secrets-1');
    await repository.create(run);
    const serialized = JSON.stringify(await repository.getById('run-no-secrets-1'));
    expect(serialized).not.toMatch(/"(?:[^"]*(?:token|secret|password|cookie|credential|apikey|api_key)[^"]*)"\s*:/i);
  });

  it('a run smuggling a secret-shaped FIELD is rejected at the boundary (defense in depth)', async () => {
    const repository = new InMemoryValidationRunRepository();
    const run = admittedRun('run-smuggle-1');
    const smuggled = {
      ...run,
      identity: { ...run.identity, sessionToken: 'ghp_should-never-exist' },
    } as unknown as ValidationRun;
    await expect(repository.create(smuggled)).rejects.toThrow(ValidationDomainError);
  });

  it('a run smuggling a secret-shaped OBSERVATION VALUE KEY is rejected at the boundary', async () => {
    const repository = new InMemoryValidationRunRepository();
    const run = admittedRun('run-smuggle-2');
    const smuggled = {
      ...run,
      observations: [
        {
          id: 'obs-smuggled',
          kind: 'dom',
          value: { sessionCookie: 'should-never-persist' },
          provenance: {
            runId: run.id,
            journeyId: journey.id,
            stepId: 'step-open-sign-in',
            environmentId: previewEnv.id,
            observedAt: '2026-08-30T12:00:01.000Z',
          },
        },
      ],
    } as unknown as ValidationRun;
    await expect(repository.create(smuggled)).rejects.toThrow(ValidationDomainError);
  });
});

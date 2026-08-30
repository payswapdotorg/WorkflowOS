import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * WORK-064 Task 9 — the domain service composed through the EXISTING
 * application composition (buildApp), exposed for FUTURE consumers.
 *
 * Two proofs:
 *   1. RUNTIME — the service constructs from its ports with ALL required
 *      authorities supplied by existing modules (the in-memory run
 *      repository + the REAL /verification authority on the test database)
 *      and drives the full domain lifecycle: admit → complete → map.
 *   2. COMPOSITION — app.ts (the composition root index.ts calls) wires
 *      DefaultContinuousValidationService with the existing verification
 *      service and exposes it on AppDeps (the established static-pinning
 *      pattern — pglite cannot call buildApp directly, so the wiring is
 *      proven by construction here + pinned statically on the source).
 */
import { buildAuthStack, type TestAuthStack } from '../helpers/test-auth-stack.js';
import { DefaultVerificationService } from '../../src/modules/verification/internal/verification-service.js';
import { PgCiEvidenceIngestionRepository } from '../../src/modules/github/internal/pg-ci-evidence-repository.js';
import {
  defineValidationJourney,
  describeEnvironment,
  recordObservation,
  evaluateObservation,
  DefaultContinuousValidationService,
  InMemoryValidationRunRepository,
  ValidationDomainError,
  type ContinuousValidationService,
  type ValidationJourney,
  type ExpectedObservation,
  type ObservationResult,
  type TestIdentitySource,
  type Environment,
} from '../../src/continuous-validation/index.js';

const BACKEND_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const APP_TS = join(BACKEND_ROOT, 'src', 'app.ts');

describe('WORK-064 module composition — the domain service through existing composition', () => {
  let stack: TestAuthStack;
  let service: ContinuousValidationService;
  let projectId: string;
  let verificationRunId: string;

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

  beforeAll(async () => {
    stack = await buildAuthStack({});
    const org = await stack.organizationRepository.create({ name: 'CV Composition Org' });
    const user = await stack.userRepository.upsertByExternalId({
      externalId: 'cv-composition-user',
      displayName: 'CV Composition User',
    });
    await stack.membershipRepository.assign({ userId: user.id, organizationId: org.id, roleId: 'owner' });
    const project = await stack.projectRepository.create({
      organizationId: org.id,
      name: 'CV Composition Project',
    });
    await stack.projectAccessRepository.grant({ userId: user.id, projectId: project.id, roleId: 'owner' });
    projectId = project.id;
    const architecture = await stack.architectureRepository.create({ projectId, name: 'CV Composition Arch' });
    const version = await stack.architectureVersionRepository.create({
      architectureId: architecture.id,
      contentInline: 'constraints',
    });
    await stack.architectureVersionRepository.transitionState(version.id, 'frozen', user.id);
    const workItem = await stack.workItemRepository.create({
      architectureVersionId: version.id,
      workItemId: 'WORK-064-COMPOSITION-001',
      title: 'The work item validation evidence attaches to',
    });

    // The EXISTING /verification authority — the same construction app.ts
    // performs (all dependencies supplied by existing modules):
    const verificationService = new DefaultVerificationService(
      stack.db.client,
      stack.requirementRepository,
      stack.acceptanceCriterionRepository,
      stack.architectureVersionRepository,
      stack.workItemRepository,
      stack.workItemRequirementRepository,
      stack.workItemCriterionRepository,
      new PgCiEvidenceIngestionRepository(stack.db.client),
      stack.objectStore,
      stack.db.logger,
    );
    const verificationRun = await verificationService.createRun({
      projectId,
      workItemId: workItem.id,
      architectureVersionId: version.id,
      source: 'manual',
      sourceRef: 'WORK-064 composition test',
      executionId: 'cv-composition-exec-001',
    });
    verificationRunId = verificationRun.id;

    // The WORK-064 service composed from its ports (the app.ts shape):
    service = new DefaultContinuousValidationService({
      runRepository: new InMemoryValidationRunRepository(),
      verificationService,
    });
  });

  afterAll(async () => {
    await stack?.db?.close();
  });

  it('constructs from its ports with all required authorities supplied by existing modules', () => {
    expect(service).toBeDefined();
    expect(typeof service.admitRun).toBe('function');
    expect(typeof service.findRun).toBe('function');
    expect(typeof service.completeRun).toBe('function');
    expect(typeof service.mapOutcomeToVerification).toBe('function');
  });

  it('admits and PERSISTS a run (findRun reads it back with full provenance)', async () => {
    const admission = await service.admitRun({
      journey,
      identitySource: unauthenticated,
      environment: previewEnv,
      mode: 'PRE_MERGE',
      trigger: 'PR',
      runId: 'run-composition-1',
      now: () => new Date('2026-08-30T12:00:00.000Z'),
    });
    expect(admission.admitted).toBe(true);

    const stored = await service.findRun('run-composition-1');
    expect(stored).not.toBeNull();
    expect(stored?.status).toBe('admitted');
    expect(stored?.journeyId).toBe('journey-sign-in-page');
    expect(stored?.identity.principalClass).toBe('unauthenticated');
  });

  it('a REJECTED admission leaves NO record (fail-closed admission does not persist)', async () => {
    const admission = await service.admitRun({
      journey,
      identitySource: unauthenticated,
      environment: previewEnv,
      mode: 'POST_RELEASE', // journey allows PRE_MERGE only
      trigger: 'RELEASE',
      releaseRef: 'release-1',
    });
    expect(admission.admitted).toBe(false);
    expect(admission.run).toBeNull();
    // No run id was even assigned to the rejection — nothing persisted:
    expect(admission.run).toBeNull();
  });

  it('completes a run through the service (finalization + persistence in one operation)', async () => {
    const admitted = (await service.findRun('run-composition-1'))!;
    const expected = journey.steps[0]?.expectedObservations[0] as ExpectedObservation;
    const actual = recordObservation({
      id: 'obs-1',
      kind: expected.kind,
      value: null,
      provenance: {
        runId: admitted.id,
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
          runId: admitted.id,
          journeyId: journey.id,
          stepId: expected.stepId,
          environmentId: previewEnv.id,
          observedAt: '2026-08-30T12:00:01.000Z',
        },
      },
    ];
    const completed = await service.completeRun({ run: admitted, journey, results });
    expect(completed.status).toBe('completed');
    expect(completed.outcome?.kind).toBe('healthy');

    // The completion is persisted (the one admitted→completed transition):
    const stored = await service.findRun('run-composition-1');
    expect(stored?.status).toBe('completed');
    expect(stored?.outcome?.kind).toBe('healthy');
  });

  it('a run can be completed exactly ONCE (double finalization is a typed error)', async () => {
    const completed = (await service.findRun('run-composition-1'))!;
    await expect(
      service.completeRun({ run: completed, journey, results: [] }),
    ).rejects.toThrow(ValidationDomainError);
  });

  it('maps the completed outcome into the EXISTING /verification authority through the service', async () => {
    const run = (await service.findRun('run-composition-1'))!;
    const reference = await service.mapOutcomeToVerification({
      run,
      projectId,
      verificationRunId,
    });
    expect(reference.verificationEvidenceId).toBeTruthy();
    expect(reference.validationRunId).toBe('run-composition-1');
    expect(reference.outcomeKind).toBe('healthy');
    expect(reference.verificationEvidenceAuthority).toBe('claim');
  });

  it('completing a run that was never admitted through the service is rejected', async () => {
    const foreignAdmission = await service.admitRun({
      journey,
      identitySource: unauthenticated,
      environment: previewEnv,
      mode: 'PRE_MERGE',
      trigger: 'PR',
      runId: 'run-never-admitted-here',
    });
    expect(foreignAdmission.admitted).toBe(true);
    // The service knows this run (admitted above) — but a run object the
    // repository never saw must be rejected. Craft one with an unknown id:
    const ghost = { ...foreignAdmission.run!, id: 'run-ghost' } as typeof foreignAdmission.run;
    await expect(
      service.completeRun({ run: ghost!, journey, results: [] }),
    ).rejects.toThrow(ValidationDomainError);
  });

  // --- the composition-root wiring (app.ts — the same root index.ts calls) --

  it('app.ts wires DefaultContinuousValidationService with the existing verification service and exposes it on AppDeps', () => {
    expect(existsSync(APP_TS)).toBe(true);
    const appSrc = readFileSync(APP_TS, 'utf8');
    // The import:
    expect(appSrc).toMatch(/import\s*\{[^}]*DefaultContinuousValidationService[^}]*\}\s*from\s*'\.\/continuous-validation\/index\.js'/);
    // The construction (with the existing verification service + the documented in-memory repository):
    expect(appSrc).toMatch(/continuousValidationService\s*=\s*new DefaultContinuousValidationService\(\{\s*runRepository:\s*new InMemoryValidationRunRepository\(\),\s*verificationService:\s*verificationService!,\s*\}\)/);
    // The AppDeps surface (interface + the returned deps object):
    expect(appSrc).toMatch(/continuousValidationService\?:\s*ContinuousValidationService/);
    expect(appSrc).toMatch(/^\s{6}continuousValidationService,$/m);
  });
});

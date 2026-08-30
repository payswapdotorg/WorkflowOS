import { describe, it, expect, beforeAll, afterAll } from 'vitest';

/**
 * WORK-064 Task 7 — binding validation evidence to the EXISTING /verification
 * authority (spec/work-orders/WORK-064.md invariant 7; evidence-provenance-
 * model §2–§4).
 *
 * The chain: raw observation → validation result → FORMAL verification
 * evidence (in /verification). The mapper CREATES claim-authority evidence
 * through the existing VerificationService.attachEvidence boundary — the
 * honest classification for synthetic agent-produced validation — and never
 * creates a parallel evidence store, never overwrites raw observations, and
 * never converts a failure into healthy.
 */
import { buildAuthStack, type TestAuthStack } from '../helpers/test-auth-stack.js';
import { DefaultVerificationService } from '../../src/modules/verification/internal/verification-service.js';
import { PgEvidenceRepository } from '../../src/modules/verification/internal/pg-verification-repository.js';
import { PgCiEvidenceIngestionRepository } from '../../src/modules/github/internal/pg-ci-evidence-repository.js';
import type { VerificationService, Evidence } from '@modules/verification/index.js';
import {
  defineValidationJourney,
  describeEnvironment,
  admitValidationRun,
  recordObservation,
  evaluateObservation,
  finalizeValidationRun,
  mapValidationOutcomeToVerification,
  ValidationDomainError,
  type ValidationJourney,
  type ValidationRun,
  type ExpectedObservation,
  type ObservationResult,
  type TestIdentitySource,
  type Environment,
} from '../../src/continuous-validation/index.js';

describe('WORK-064 — validation evidence maps into the existing /verification authority', () => {
  let stack: TestAuthStack;
  let verificationService: VerificationService;
  let evidenceRepo: PgEvidenceRepository;
  let projectId: string;
  let verificationRunId: string;

  // ----- the validation-domain fixtures -----------------------------------

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
            matcher: { kind: 'equals', value: 'Sign in to WorkflowOS' },
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

  function result(
    run: ValidationRun,
    expected: ExpectedObservation,
    value: unknown,
  ): ObservationResult {
    const actual = recordObservation({
      id: `obs-${expected.id}`,
      kind: expected.kind,
      value,
      provenance: {
        runId: run.id,
        journeyId: journey.id,
        stepId: expected.stepId,
        environmentId: previewEnv.id,
        observedAt: '2026-08-30T12:00:01.000Z',
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
        environmentId: previewEnv.id,
        observedAt: '2026-08-30T12:00:01.000Z',
      },
    };
  }

  const headingExpected = journey.steps[0]?.expectedObservations[0] as ExpectedObservation;

  function healthyRun(runId: string): ValidationRun {
    const run = admittedRun(runId);
    return finalizeValidationRun({
      run,
      journey,
      results: [result(run, headingExpected, 'Sign in to WorkflowOS')],
    });
  }

  function failedRun(runId: string): ValidationRun {
    const run = admittedRun(runId);
    return finalizeValidationRun({
      run,
      journey,
      results: [result(run, headingExpected, 'Something else rendered')],
    });
  }

  beforeAll(async () => {
    stack = await buildAuthStack({});
    const org = await stack.organizationRepository.create({ name: 'Validation Evidence Org' });
    const user = await stack.userRepository.upsertByExternalId({
      externalId: 'validation-evidence-user',
      displayName: 'Validation Evidence User',
    });
    await stack.membershipRepository.assign({ userId: user.id, organizationId: org.id, roleId: 'owner' });
    const project = await stack.projectRepository.create({
      organizationId: org.id,
      name: 'Validation Evidence Project',
    });
    await stack.projectAccessRepository.grant({ userId: user.id, projectId: project.id, roleId: 'owner' });
    projectId = project.id;
    const architecture = await stack.architectureRepository.create({ projectId, name: 'Validation Evidence Arch' });
    const version = await stack.architectureVersionRepository.create({
      architectureId: architecture.id,
      contentInline: 'constraints',
    });
    await stack.architectureVersionRepository.transitionState(version.id, 'frozen', user.id);
    const workItem = await stack.workItemRepository.create({
      architectureVersionId: version.id,
      workItemId: 'WORK-064-EVIDENCE-001',
      title: 'The work item the validation evidence attaches to',
    });

    const ciIngestionRepo = new PgCiEvidenceIngestionRepository(stack.db.client);
    verificationService = new DefaultVerificationService(
      stack.db.client,
      stack.requirementRepository,
      stack.acceptanceCriterionRepository,
      stack.architectureVersionRepository,
      stack.workItemRepository,
      stack.workItemRequirementRepository,
      stack.workItemCriterionRepository,
      ciIngestionRepo,
      stack.objectStore,
      stack.db.logger,
    );
    evidenceRepo = new PgEvidenceRepository(stack.db.client);

    const verificationRun = await verificationService.createRun({
      projectId,
      workItemId: workItem.id,
      architectureVersionId: version.id,
      source: 'manual',
      sourceRef: 'WORK-064 validation evidence mapping test',
      executionId: 'validation-evidence-exec-001',
    });
    verificationRunId = verificationRun.id;
  });

  afterAll(async () => {
    await stack?.db?.close();
  });

  it('maps a HEALTHY validation outcome to claim-authority evidence in the EXISTING /verification store', async () => {
    const run = healthyRun('run-evidence-healthy');
    const reference = await mapValidationOutcomeToVerification(
      { run, projectId, verificationRunId },
      verificationService,
    );
    // The reference points at the existing authority's evidence row:
    expect(reference.verificationEvidenceId).toBeTruthy();
    expect(reference.validationRunId).toBe('run-evidence-healthy');
    expect(reference.validationJourneyId).toBe('journey-sign-in-page');
    expect(reference.observationIds).toEqual(['obs-obs-heading']);
    expect(reference.outcomeKind).toBe('healthy');

    // The evidence row lives in /verification (retrievable through its OWN
    // repository — proof there is no parallel evidence store):
    const evidence: Evidence | null = await evidenceRepo.findById(reference.verificationEvidenceId);
    expect(evidence).not.toBeNull();
    expect(evidence?.verificationRunId).toBe(verificationRunId);
    expect(evidence?.projectId).toBe(projectId);
    // Synthetic validation is agent-produced → the manual/agent path → 'claim'
    // authority (server-side classification; never client-supplied):
    expect(evidence?.authority).toBe('claim');
    expect(evidence?.result).toBe('pass');
    expect(evidence?.provider).toBe('agent');
    // The validation provenance is preserved on the evidence metadata:
    expect(evidence?.metadata).toMatchObject({
      validationRunId: 'run-evidence-healthy',
      validationJourneyId: 'journey-sign-in-page',
      validationOutcome: 'healthy',
      environmentId: 'env-preview',
      mode: 'PRE_MERGE',
      trigger: 'PR',
    });
  });

  it('maps a FAILED validation outcome to fail evidence — the failure is NEVER converted to healthy', async () => {
    const run = failedRun('run-evidence-failed');
    const reference = await mapValidationOutcomeToVerification(
      { run, projectId, verificationRunId },
      verificationService,
    );
    expect(reference.outcomeKind).toBe('validation_failure');
    const evidence = await evidenceRepo.findById(reference.verificationEvidenceId);
    expect(evidence?.result).toBe('fail');
    expect(evidence?.authority).toBe('claim');
    // The failure provenance travels with the evidence:
    expect(evidence?.metadata).toMatchObject({
      validationOutcome: 'validation_failure',
      validationRunId: 'run-evidence-failed',
    });
    // And the run's own outcome is UNCHANGED by the mapping:
    expect(run.outcome?.kind).toBe('validation_failure');
  });

  it('maps effect_policy_violation and environment_error to blocked evidence (the check could not run)', async () => {
    const base = admittedRun('run-evidence-blocked-1');
    const violationRun = finalizeValidationRun({
      run: base,
      journey,
      results: [],
      executionError: { kind: 'effect_policy_violation', reason: 'executor attempted a mutation' },
    });
    const violationRef = await mapValidationOutcomeToVerification(
      { run: violationRun, projectId, verificationRunId },
      verificationService,
    );
    expect((await evidenceRepo.findById(violationRef.verificationEvidenceId))?.result).toBe('blocked');

    const base2 = admittedRun('run-evidence-blocked-2');
    const envRun = finalizeValidationRun({
      run: base2,
      journey,
      results: [],
      executionError: { kind: 'environment_error', reason: 'preview deployment unreachable' },
    });
    const envRef = await mapValidationOutcomeToVerification(
      { run: envRun, projectId, verificationRunId },
      verificationService,
    );
    expect((await evidenceRepo.findById(envRef.verificationEvidenceId))?.result).toBe('blocked');
    expect(envRef.outcomeKind).toBe('environment_error');
  });

  it('the mapper CANNOT overwrite raw observations (the run is immutable through the mapping)', async () => {
    const run = failedRun('run-evidence-immutable');
    const snapshot = JSON.stringify(run);
    await mapValidationOutcomeToVerification({ run, projectId, verificationRunId }, verificationService);
    // The completed run record is byte-identical after mapping:
    expect(JSON.stringify(run)).toBe(snapshot);
    // And the failure record is intact on the outcome:
    expect(run.outcome?.kind).toBe('validation_failure');
  });

  it('a FAILED mapping is explicit — it throws; nothing is silently converted', async () => {
    const run = healthyRun('run-evidence-mapping-failure');
    await expect(
      mapValidationOutcomeToVerification(
        { run, projectId, verificationRunId: 'verification-run-that-does-not-exist' },
        verificationService,
      ),
    ).rejects.toThrow();
    // The run + outcome remain untouched:
    expect(run.outcome?.kind).toBe('healthy');
  });

  it('rejects mapping an un-finalized run (no outcome to map) with a typed error', async () => {
    const run = admittedRun('run-evidence-unfinalized');
    await expect(
      mapValidationOutcomeToVerification({ run, projectId, verificationRunId }, verificationService),
    ).rejects.toThrow(ValidationDomainError);
  });

  it('rejects a run/outcome provenance mismatch with a typed error', async () => {
    const run = healthyRun('run-evidence-a');
    // Present run A's record with run B's outcome — the mapper must detect
    // the provenance break:
    const otherRun = failedRun('run-evidence-b');
    await expect(
      mapValidationOutcomeToVerification(
        { run: { ...run, outcome: otherRun.outcome }, projectId, verificationRunId },
        verificationService,
      ),
    ).rejects.toThrow(ValidationDomainError);
  });
});

/**
 * WORK-069 test helpers — deterministic fixtures for the progressive
 * release decision suite. No wall-clock reads: every clock is injected;
 * every observation time is a recorded fixture value. The authorities are
 * the REAL services (the WORK-064 service with the in-memory run
 * repository + the fake verification boundary; the WORK-067 service with
 * the in-memory signal repository) — the decision layer is exercised
 * against the authorities' true contracts, never against mocks of them.
 */
import {
  DefaultContinuousValidationService,
  InMemoryValidationRunRepository,
  defineValidationJourney,
  describeEnvironment,
  finalizeValidationRun,
  recordObservation,
  evaluateObservation,
  type ContinuousValidationService,
  type Environment,
  type ExpectedObservation,
  type ExecutionError,
  type ObservationResult,
  type TestIdentitySource,
  type ValidationJourney,
  type ValidationRun,
} from '../../src/continuous-validation/index.js';
import {
  DefaultEngineeringSignalService,
  InMemoryEngineeringSignalRepository,
  type EngineeringSignalService,
} from '../../src/engineering-signals/index.js';
import {
  DefaultProgressiveReleaseService,
  InMemoryProgressiveReleaseDecisionRepository,
  type ProgressiveReleaseService,
  type RollbackAuthority,
  type RollbackInvocationResult,
  type RolloutRuntimeObservation,
  type RuntimeObservationReader,
} from '../../src/progressive-release/index.js';
import type { AuditEventWriter, WriteAuditEventInput, AuditEvent } from '@modules/audit/index.js';
import type { AuthenticatedPrincipal } from '@modules/auth/index.js';

/** A fixed, deterministic clock (the injected-time discipline). */
export function fixedClock(startIso: string, stepMs = 0): () => Date {
  let current = Date.parse(startIso);
  return () => {
    const now = new Date(current);
    current += stepMs;
    return now;
  };
}

export const FIXED_CLOCK = fixedClock('2026-09-02T00:00:00Z');

// --- the WORK-064 authority fixtures ------------------------------------------

const syntheticPrincipal: AuthenticatedPrincipal = {
  externalId: 'svc-progressive-release-01',
  label: 'progressive release (test service account)',
  provider: 'apikey',
};

export const unauthenticated: TestIdentitySource = { kind: 'unauthenticated' };

export const syntheticTenant1: TestIdentitySource = {
  kind: 'synthetic',
  principal: syntheticPrincipal,
  principalClass: 'test_service_account',
  capabilities: ['project.read'],
  tenantId: 'tenant-1',
  issuanceReason: 'WORK-069 progressive-release decision test',
};

export const productionEnvironment: Environment = describeEnvironment({
  id: 'env-prod-rollout',
  kind: 'production',
  acceptedPolicies: ['READ_ONLY'],
});

/** The canary smoke journey (READ_ONLY, POST_RELEASE-eligible, unauthenticated). */
export const rolloutJourney: ValidationJourney = defineValidationJourney({
  id: 'journey-rollout-smoke',
  name: 'The released product smoke journey',
  identityRequirement: 'unauthenticated',
  allowedModes: ['POST_RELEASE', 'CONTINUOUS'],
  effectPolicy: 'READ_ONLY',
  steps: [
    {
      id: 'step-open-dashboard',
      name: 'open the released dashboard',
      expectedObservations: [
        {
          id: 'expectation-dashboard-heading',
          stepId: 'step-open-dashboard',
          kind: 'dom',
          description: 'the dashboard heading is visible',
          matcher: { kind: 'equals', value: 'Dashboard' },
        },
      ],
    },
  ],
  successCriteria: [
    {
      id: 'criterion-dashboard-renders',
      description: 'the dashboard renders',
      requiresObservationIds: ['expectation-dashboard-heading'],
    },
  ],
});

/** The authenticated rollout journey (a synthetic tenant-bound source). */
export const authenticatedRolloutJourney: ValidationJourney = defineValidationJourney({
  id: 'journey-rollout-authenticated',
  name: 'The released product authenticated journey',
  identityRequirement: 'authenticated',
  allowedModes: ['POST_RELEASE', 'CONTINUOUS'],
  effectPolicy: 'READ_ONLY',
  steps: [
    {
      id: 'step-open-workbench',
      name: 'open the released workbench',
      expectedObservations: [
        {
          id: 'expectation-workbench-heading',
          stepId: 'step-open-workbench',
          kind: 'dom',
          description: 'the workbench heading is visible',
          matcher: { kind: 'equals', value: 'Workbench' },
        },
      ],
    },
  ],
  successCriteria: [
    {
      id: 'criterion-workbench-renders',
      description: 'the workbench renders',
      requiresObservationIds: ['expectation-workbench-heading'],
    },
  ],
});

/** Admit a POST_RELEASE/RELEASE run through the REAL WORK-064 service. */
export async function admitPostReleaseRun(
  authority: ContinuousValidationService,
  options: {
    runId: string;
    releaseRef: string;
    identitySource?: TestIdentitySource;
    environment?: Environment;
    journey?: ValidationJourney;
    mode?: 'POST_RELEASE' | 'CONTINUOUS';
    trigger?: 'RELEASE' | 'SCHEDULED' | 'SECURITY_FINDING' | 'DEPENDENCY_CHANGE';
  },
): Promise<ValidationRun> {
  const journey = options.journey ?? rolloutJourney;
  const admission = await authority.admitRun({
    journey,
    identitySource: options.identitySource ?? unauthenticated,
    environment: options.environment ?? productionEnvironment,
    mode: options.mode ?? 'POST_RELEASE',
    trigger: options.trigger ?? 'RELEASE',
    releaseRef: options.releaseRef,
    continuousConfigured: (options.mode ?? 'POST_RELEASE') === 'CONTINUOUS' ? true : undefined,
    runId: options.runId,
    now: () => new Date('2026-09-01T12:00:00.000Z'),
  });
  if (!admission.admitted || admission.run === null) {
    throw new Error(`fixture: run ${options.runId} was not admitted (${admission.code ?? 'unknown'})`);
  }
  return admission.run;
}

function observationResult(
  run: ValidationRun,
  journey: ValidationJourney,
  value: unknown,
): ObservationResult {
  const expectation = journey.steps[0]!.expectedObservations[0] as ExpectedObservation;
  const actual = recordObservation({
    id: `obs-${expectation.id}`,
    kind: expectation.kind,
    value,
    provenance: {
      runId: run.id,
      journeyId: journey.id,
      stepId: expectation.stepId,
      environmentId: run.environmentId,
      observedAt: '2026-09-01T12:00:01.000Z',
    },
  });
  return {
    expected: expectation,
    actual,
    matched: evaluateObservation(expectation, actual),
    provenance: {
      runId: run.id,
      journeyId: journey.id,
      stepId: expectation.stepId,
      environmentId: run.environmentId,
      observedAt: '2026-09-01T12:00:01.000Z',
    },
  };
}

/**
 * Admit AND complete a POST_RELEASE run with the requested outcome kind
 * through the REAL WORK-064 authority (healthy / validation_failure /
 * effect_policy_violation / environment_error).
 */
export async function completedPostReleaseRun(
  authority: ContinuousValidationService,
  options: {
    runId: string;
    releaseRef: string;
    identitySource?: TestIdentitySource;
    environment?: Environment;
    journey?: ValidationJourney;
    mode?: 'POST_RELEASE' | 'CONTINUOUS';
    trigger?: 'RELEASE' | 'SCHEDULED' | 'SECURITY_FINDING' | 'DEPENDENCY_CHANGE';
    outcome: 'healthy' | 'validation_failure' | 'effect_policy_violation' | 'environment_error';
  },
): Promise<ValidationRun> {
  const journey = options.journey ?? rolloutJourney;
  const run = await admitPostReleaseRun(authority, { ...options, journey });
  const executionError: ExecutionError | undefined =
    options.outcome === 'effect_policy_violation'
      ? { kind: 'effect_policy_violation', reason: 'a FORBIDDEN effect was attempted against the production rollout' }
      : options.outcome === 'environment_error'
        ? { kind: 'environment_error', reason: 'the rollout environment failed during execution' }
        : undefined;
  const results =
    options.outcome === 'healthy'
      ? [observationResult(run, journey, 'Dashboard')]
      : options.outcome === 'validation_failure'
        ? [observationResult(run, journey, 'Something else')]
        : [observationResult(run, journey, 'Dashboard')];
  const completed = finalizeValidationRun({
    run,
    journey,
    results,
    executionError,
    completedAt: '2026-09-01T12:00:05.000Z',
  });
  // Persist the completion through the service's one transition:
  return authority.completeRun({ run, journey, results, executionError, completedAt: '2026-09-01T12:00:05.000Z' }).then(
    () => completed,
  );
}

// --- the fake ports (the deterministic boundary fixtures) ----------------------

/** The fake runtime observation reader (the /runtime port in tests). */
export class FakeRuntimeObservationReader implements RuntimeObservationReader {
  private observation: RolloutRuntimeObservation | null;
  constructor(observation: RolloutRuntimeObservation | null) {
    this.observation = observation;
  }
  async readLatestDeploymentObservation(): Promise<RolloutRuntimeObservation | null> {
    return this.observation;
  }
  /** Swap the recorded observation (the runtime authority recorded new facts). */
  setObservation(observation: RolloutRuntimeObservation | null): void {
    this.observation = observation;
  }
}

/** The recording fake rollback authority (the EXISTING-authority port in tests). */
export class RecordingRollbackAuthority implements RollbackAuthority {
  public readonly invocations: Array<{
    tenantId: string;
    projectId: string;
    releaseRef: string;
    rolloutStage: string;
    decisionId: string;
    reason: string;
  }> = [];
  constructor(private readonly result: RollbackInvocationResult) {}
  async invokeRollback(input: Parameters<RollbackAuthority['invokeRollback']>[0]): Promise<RollbackInvocationResult> {
    this.invocations.push({
      tenantId: input.tenantId,
      projectId: input.projectId,
      releaseRef: input.releaseRef,
      rolloutStage: input.rolloutStage,
      decisionId: input.decisionId,
      reason: input.reason,
    });
    return this.result;
  }
}

export const invokedRollback: RollbackInvocationResult = {
  invoked: true,
  rollbackRef: 'rollback-2026.09.02-001',
  note: 'the existing rollback authority executed the recorded rollback',
};

/** The recording fake audit writer (the /audit application boundary in tests). */
export class RecordingAuditWriter implements AuditEventWriter {
  public readonly events: WriteAuditEventInput[] = [];
  async write(input: WriteAuditEventInput): Promise<AuditEvent> {
    this.events.push(input);
    return {
      id: `audit-${this.events.length}`,
      organizationId: input.organizationId ?? null,
      projectId: input.projectId ?? null,
      eventType: input.eventType,
      actor: input.actor,
      source: input.source ?? 'progressive-release',
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      executionId: input.executionId ?? null,
      correlationId: input.correlationId ?? null,
      beforeState: input.beforeState ?? null,
      afterState: input.afterState ?? null,
      metadata: input.metadata ?? {},
      workItemId: input.workItemId ?? null,
      workOrderId: input.workOrderId ?? null,
      architectureVersionId: input.architectureVersionId ?? null,
      reviewId: input.reviewId ?? null,
      verificationRunId: input.verificationRunId ?? null,
      agentRunId: input.agentRunId ?? null,
      pullRequestAssociationId: input.pullRequestAssociationId ?? null,
      createdAt: new Date('2026-09-02T00:00:00Z'),
    };
  }
}

// --- the full decision stack ----------------------------------------------------

export interface DecisionTestStack {
  readonly service: ProgressiveReleaseService;
  readonly continuousValidationService: ContinuousValidationService;
  readonly engineeringSignalService: EngineeringSignalService;
  readonly decisionRepository: InMemoryProgressiveReleaseDecisionRepository;
  readonly runtimeReader: FakeRuntimeObservationReader;
  readonly rollbackAuthority: RecordingRollbackAuthority | undefined;
  readonly auditWriter: RecordingAuditWriter;
  readonly clock: () => Date;
}

/**
 * Build the full decision stack over the REAL authorities (WORK-064 +
 * WORK-067) with the deterministic port fixtures. The rollback authority
 * is UNBOUND by default (the production composition truth); bind it
 * explicitly for the rollback-consumption tests.
 */
export function buildDecisionStack(options: {
  runtimeObservation?: RolloutRuntimeObservation | null;
  rollbackAuthority?: RecordingRollbackAuthority;
  clock?: () => Date;
} = {}): DecisionTestStack {
  const clock = options.clock ?? FIXED_CLOCK;
  const continuousValidationService = new DefaultContinuousValidationService({
    runRepository: new InMemoryValidationRunRepository(),
    verificationService: new FakeVerificationBoundary(),
  });
  const engineeringSignalService = new DefaultEngineeringSignalService({
    signalRepository: new InMemoryEngineeringSignalRepository(),
    continuousValidationService,
    now: clock,
  });
  const decisionRepository = new InMemoryProgressiveReleaseDecisionRepository();
  const runtimeReader = new FakeRuntimeObservationReader(
    options.runtimeObservation === undefined
      ? {
          kind: 'deployment',
          deploymentId: 'dpl-rollout-1',
          deploymentStatus: 'ready',
          observedAt: '2026-09-01T12:10:00Z',
        }
      : options.runtimeObservation,
  );
  const auditWriter = new RecordingAuditWriter();
  const service = new DefaultProgressiveReleaseService({
    continuousValidationService,
    engineeringSignalService,
    runtimeObservationReader: runtimeReader,
    rollbackAuthority: options.rollbackAuthority,
    decisionRepository,
    auditWriter,
    now: clock,
  });
  return {
    service,
    continuousValidationService,
    engineeringSignalService,
    decisionRepository,
    runtimeReader,
    rollbackAuthority: options.rollbackAuthority,
    auditWriter,
    clock,
  };
}

/** The fake verification boundary (the evidence mapping is NOT exercised by WORK-069). */
class FakeVerificationBoundary {
  async attachEvidence(): Promise<never> {
    throw new Error('WORK-069 must never attach verification evidence');
  }
  async findOrchestrationRun(): Promise<never> {
    throw new Error('FakeVerificationBoundary.findOrchestrationRun: not used by WORK-069');
  }
  async recordOrchestrationRun(): Promise<never> {
    throw new Error('FakeVerificationBoundary.recordOrchestrationRun: not used by WORK-069');
  }
  async createRun(): Promise<never> {
    throw new Error('FakeVerificationBoundary.createRun: not used by WORK-069');
  }
  async findRun(): Promise<never> {
    throw new Error('FakeVerificationBoundary.findRun: not used by WORK-069');
  }
  async attachCiEvidence(): Promise<never> {
    throw new Error('FakeVerificationBoundary.attachCiEvidence: not used by WORK-069');
  }
  async mapEvidenceToCriterion(): Promise<never> {
    throw new Error('FakeVerificationBoundary.mapEvidenceToCriterion: not used by WORK-069');
  }
  async evaluateCriterion(): Promise<never> {
    throw new Error('FakeVerificationBoundary.evaluateCriterion: not used by WORK-069');
  }
  async evaluateForRun(): Promise<never> {
    throw new Error('FakeVerificationBoundary.evaluateForRun: not used by WORK-069');
  }
  async persistEvaluations(): Promise<never> {
    throw new Error('FakeVerificationBoundary.persistEvaluations: not used by WORK-069');
  }
  async listRunsForWorkItem(): Promise<never> {
    throw new Error('FakeVerificationBoundary.listRunsForWorkItem: not used by WORK-069');
  }
  async listRunsForProject(): Promise<never> {
    throw new Error('FakeVerificationBoundary.listRunsForProject: not used by WORK-069');
  }
  async listEvidenceForRun(): Promise<never> {
    throw new Error('FakeVerificationBoundary.listEvidenceForRun: not used by WORK-069');
  }
  async listMappingsForRun(): Promise<never> {
    throw new Error('FakeVerificationBoundary.listMappingsForRun: not used by WORK-069');
  }
  async finalizeOrchestrationRun(): Promise<never> {
    throw new Error('FakeVerificationBoundary.finalizeOrchestrationRun: not used by WORK-069');
  }
}

/** The canonical decision request fixture. */
export function decisionRequestFixture(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    environmentId: 'env-prod-rollout',
    releaseRef: 'release-2026.09.01',
    rolloutStage: 'canary',
    validationRunId: 'run-rollout-1',
    ...overrides,
  } as Parameters<ProgressiveReleaseService['decideProgressiveRelease']>[0];
}

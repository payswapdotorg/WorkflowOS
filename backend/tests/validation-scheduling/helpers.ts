import {
  defineValidationJourney,
  describeEnvironment,
  type ValidationJourney,
  type Environment,
  type TestIdentitySource,
} from '../../src/continuous-validation/index.js';
import type { AuthenticatedPrincipal } from '@modules/auth/index.js';

/**
 * WORK-066 test fixtures — journeys/environments/identity sources declared
 * under the WORK-064 authority's constructors (the scheduler CONSUMES these;
 * it never declares journeys of its own).
 */

const syntheticPrincipal: AuthenticatedPrincipal = {
  externalId: 'svc-validation-scheduler-01',
  label: 'validation scheduler (test service account)',
  provider: 'apikey',
};

export const unauthenticated: TestIdentitySource = { kind: 'unauthenticated' };

export const synthetic: TestIdentitySource = {
  kind: 'synthetic',
  principal: syntheticPrincipal,
  principalClass: 'test_service_account',
  capabilities: ['project.read'],
  tenantId: 'tenant-preview',
  issuanceReason: 'WORK-066 scheduling decision',
};

export const previewEnvironment: Environment = describeEnvironment({
  id: 'env-preview',
  kind: 'preview',
  acceptedPolicies: ['READ_ONLY', 'SAFE_MUTATION', 'ISOLATED_MUTATION'],
  isolatedTenantId: 'tenant-preview',
});

export const isolatedEnvironment: Environment = describeEnvironment({
  id: 'env-isolated',
  kind: 'isolated',
  acceptedPolicies: ['READ_ONLY', 'SAFE_MUTATION', 'ISOLATED_MUTATION'],
  isolatedTenantId: 'tenant-isolated',
});

export const productionEnvironment: Environment = describeEnvironment({
  id: 'env-production',
  kind: 'production',
  acceptedPolicies: ['READ_ONLY', 'SAFE_MUTATION'],
});

/** A READ_ONLY public smoke journey (LIGHT-eligible in every mode it allows). */
export const smokeJourney: ValidationJourney = defineValidationJourney({
  id: 'journey-smoke-sign-in-page',
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
          kind: 'dom' as const,
          description: 'the sign-in heading is visible',
          matcher: { kind: 'contains_text' as const, text: 'Sign in' },
        },
      ],
    },
  ],
  successCriteria: [
    { id: 'criterion-sign-in-renders', description: 'the sign-in page renders', requiresObservationIds: ['obs-sign-in-heading'] },
  ],
});

/** A SAFE_MUTATION journey (STANDARD+ in PRE_MERGE; CRITICAL in production modes). */
export const safeMutationJourney: ValidationJourney = defineValidationJourney({
  id: 'journey-safe-mutation-create-work-item',
  name: 'A member creates a work item',
  identityRequirement: 'authenticated',
  allowedModes: ['PRE_MERGE', 'POST_RELEASE', 'CONTINUOUS'],
  effectPolicy: 'SAFE_MUTATION',
  steps: [
    {
      id: 'step-create-work-item',
      name: 'create a work item through the form',
      expectedObservations: [
        {
          id: 'obs-work-item-created',
          stepId: 'step-create-work-item',
          kind: 'persisted_record' as const,
          description: 'the work item is persisted',
          matcher: { kind: 'equals' as const, value: 'Scheduled item' },
        },
      ],
    },
  ],
  successCriteria: [
    { id: 'criterion-item-created', description: 'the work item is created', requiresObservationIds: ['obs-work-item-created'] },
  ],
});

/** An ISOLATED_MUTATION journey (HIGH_ASSURANCE+ in PRE_MERGE only). */
export const isolatedMutationJourney: ValidationJourney = defineValidationJourney({
  id: 'journey-isolated-mutation-bulk-delete',
  name: 'A project owner bulk-deletes in the isolated sandbox',
  identityRequirement: 'authenticated',
  allowedModes: ['PRE_MERGE'],
  effectPolicy: 'ISOLATED_MUTATION',
  steps: [
    {
      id: 'step-bulk-delete',
      name: 'bulk-delete sandbox records',
      expectedObservations: [
        {
          id: 'obs-bulk-delete-count',
          stepId: 'step-bulk-delete',
          kind: 'persisted_record' as const,
          description: 'the sandbox records are deleted',
          matcher: { kind: 'exists' as const },
        },
      ],
    },
  ],
  successCriteria: [
    { id: 'criterion-bulk-delete', description: 'the bulk delete completes in isolation', requiresObservationIds: ['obs-bulk-delete-count'] },
  ],
});

/** A FORBIDDEN journey (never schedulable in any profile or mode). */
export const forbiddenJourney: ValidationJourney = defineValidationJourney({
  id: 'journey-forbidden-payment-sweep',
  name: 'The forbidden production payment sweep',
  identityRequirement: 'authenticated',
  allowedModes: ['PRE_MERGE', 'POST_RELEASE', 'CONTINUOUS'],
  effectPolicy: 'FORBIDDEN',
  steps: [
    {
      id: 'step-sweep',
      name: 'sweep production payments',
      expectedObservations: [
        {
          id: 'obs-sweep-record',
          stepId: 'step-sweep',
          kind: 'persisted_record' as const,
          description: 'the sweep record exists',
          matcher: { kind: 'exists' as const },
        },
      ],
    },
  ],
  successCriteria: [
    { id: 'criterion-sweep-recorded', description: 'the sweep is recorded', requiresObservationIds: ['obs-sweep-record'] },
  ],
});

/** The full declared registry fixture (the WORK-064 authority's journeys). */
export const declaredJourneys: readonly ValidationJourney[] = [
  smokeJourney,
  safeMutationJourney,
  isolatedMutationJourney,
  forbiddenJourney,
];

/** The deterministic fixed clock (2026-09-01T00:00:00Z). */
export const FIXED_CLOCK = (): Date => new Date('2026-09-01T00:00:00.000Z');

// ---------------------------------------------------------------------------
// The service stack — the REAL WORK-064 authority (admission through
// DefaultContinuousValidationService + the in-memory run repository) + a
// minimal FakeVerificationService (the scheduler NEVER creates verification
// evidence; the fake records attachEvidence calls so the authority tests can
// prove ZERO calls).
// ---------------------------------------------------------------------------

import {
  DefaultContinuousValidationService,
  InMemoryValidationRunRepository,
  type ContinuousValidationService,
} from '../../src/continuous-validation/index.js';
import {
  DefaultValidationScheduler,
  InMemoryScheduledTriggerClaimStore,
  type ValidationScheduler,
} from '../../src/validation-scheduling/index.js';
import type { VerificationService } from '@modules/verification/index.js';
import { createLogger } from '@platform/logger.js';

export class FakeVerificationService implements VerificationService {
  public attachCallCount = 0;
  async attachEvidence(_input: never): Promise<never> {
    this.attachCallCount += 1;
    throw new Error('the scheduler must never attach verification evidence');
  }
  async createRun(): Promise<never> {
    throw new Error('FakeVerificationService.createRun: not used by the scheduler');
  }
  async findRun(): Promise<never> {
    throw new Error('FakeVerificationService.findRun: not used by the scheduler');
  }
  async attachCiEvidence(): Promise<never> {
    throw new Error('FakeVerificationService.attachCiEvidence: not used by the scheduler');
  }
  async mapEvidenceToCriterion(): Promise<never> {
    throw new Error('FakeVerificationService.mapEvidenceToCriterion: not used by the scheduler');
  }
  async evaluateCriterion(): Promise<never> {
    throw new Error('FakeVerificationService.evaluateCriterion: not used by the scheduler');
  }
  async evaluateForRun(): Promise<never> {
    throw new Error('FakeVerificationService.evaluateForRun: not used by the scheduler');
  }
  async persistEvaluations(): Promise<never> {
    throw new Error('FakeVerificationService.persistEvaluations: not used by the scheduler');
  }
  async listRunsForWorkItem(): Promise<never> {
    throw new Error('FakeVerificationService.listRunsForWorkItem: not used by the scheduler');
  }
  async listRunsForProject(): Promise<never> {
    throw new Error('FakeVerificationService.listRunsForProject: not used by the scheduler');
  }
  async listEvidenceForRun(): Promise<never> {
    throw new Error('FakeVerificationService.listEvidenceForRun: not used by the scheduler');
  }
  async listMappingsForRun(): Promise<never> {
    throw new Error('FakeVerificationService.listMappingsForRun: not used by the scheduler');
  }
  async finalizeOrchestrationRun(): Promise<never> {
    throw new Error('FakeVerificationService.finalizeOrchestrationRun: not used by the scheduler');
  }
  async findOrchestrationRun(): Promise<never> {
    throw new Error('FakeVerificationService.findOrchestrationRun: not used by the scheduler');
  }
  async recordOrchestrationRun(): Promise<never> {
    throw new Error('FakeVerificationService.recordOrchestrationRun: not used by the scheduler');
  }
}

export interface SchedulerTestStack {
  readonly scheduler: ValidationScheduler;
  readonly continuousValidationService: ContinuousValidationService;
  readonly runRepository: InMemoryValidationRunRepository;
  readonly claimStore: InMemoryScheduledTriggerClaimStore;
  readonly verification: FakeVerificationService;
}

/** Build a scheduler stack with an INJECTABLE clock (determinism). */
export function buildSchedulerStack(now: () => Date = FIXED_CLOCK): SchedulerTestStack {
  const verification = new FakeVerificationService();
  const runRepository = new InMemoryValidationRunRepository();
  const continuousValidationService = new DefaultContinuousValidationService({
    runRepository,
    verificationService: verification as unknown as import('@modules/verification/index.js').VerificationService,
  });
  const claimStore = new InMemoryScheduledTriggerClaimStore(now);
  const scheduler = new DefaultValidationScheduler({
    continuousValidationService,
    claimStore,
    logger: createLogger({ level: 'silent', destination: { write: () => true } as unknown as NodeJS.WritableStream }),
    now,
  });
  return { scheduler, continuousValidationService, runRepository, claimStore, verification };
}

/** An authenticated READ_ONLY journey (a signed-in dashboard view — the clean synthetic-source smoke journey). */
export const authenticatedReadOnlyJourney: import('../../src/continuous-validation/index.js').ValidationJourney =
  defineValidationJourney({
    id: 'journey-authenticated-dashboard',
    name: 'The authenticated dashboard renders',
    identityRequirement: 'authenticated',
    allowedModes: ['PRE_MERGE', 'POST_RELEASE', 'CONTINUOUS'],
    effectPolicy: 'READ_ONLY',
    steps: [
      {
        id: 'step-open-dashboard',
        name: 'open the dashboard',
        expectedObservations: [
          {
            id: 'obs-dashboard-heading',
            stepId: 'step-open-dashboard',
            kind: 'dom' as const,
            description: 'the dashboard heading is visible',
            matcher: { kind: 'contains_text' as const, text: 'Dashboard' },
          },
        ],
      },
    ],
    successCriteria: [
      { id: 'criterion-dashboard-renders', description: 'the dashboard renders', requiresObservationIds: ['obs-dashboard-heading'] },
    ],
  });

/** A registry where every journey matches the synthetic identity source (the clean-admission fixture). */
export const syntheticMatchedJourneys: readonly import('../../src/continuous-validation/index.js').ValidationJourney[] = [
  authenticatedReadOnlyJourney,
  safeMutationJourney,
];

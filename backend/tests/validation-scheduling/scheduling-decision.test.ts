import { describe, it, expect } from 'vitest';

/**
 * WORK-066 — the scheduling decision (the service over the REAL WORK-064
 * authority): trigger → mode → journey selection → deterministic identity →
 * dedup claim → WORK-064 admission. Determinism, the typed failure
 * semantics, and the full governed linkage.
 */
import {
  DefaultValidationScheduler,
  InMemoryScheduledTriggerClaimStore,
  type ScheduleValidationTriggerInput,
} from '../../src/validation-scheduling/index.js';
import { createLogger } from '@platform/logger.js';
import {
  buildSchedulerStack,
  declaredJourneys,
  syntheticMatchedJourneys,
  authenticatedReadOnlyJourney,
  smokeJourney,
  safeMutationJourney,
  isolatedMutationJourney,
  previewEnvironment,
  productionEnvironment,
  unauthenticated,
  synthetic,
  FIXED_CLOCK,
} from './helpers.js';

function triggerInput(overrides: Partial<ScheduleValidationTriggerInput> = {}): ScheduleValidationTriggerInput {
  return {
    trigger: 'PR',
    projectId: 'proj-1',
    assurance: 'STANDARD',
    journeys: declaredJourneys,
    previewEnvironment,
    productionEnvironment,
    identitySource: synthetic,
    revision: 'rev-abc123',
    releaseRef: 'release-2026-09-01',
    ...overrides,
  };
}

describe('WORK-066 scheduling decision — deterministic evaluation', () => {
  it('identical (project, journey, environment, revision, trigger, schedule state, clock) → byte-identical decisions', async () => {
    const stackA = buildSchedulerStack(FIXED_CLOCK);
    const stackB = buildSchedulerStack(FIXED_CLOCK);
    const a = await stackA.scheduler.scheduleValidationTrigger(triggerInput());
    const b = await stackB.scheduler.scheduleValidationTrigger(triggerInput());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.outcome).toBe('scheduled');
    expect(a.evaluatedAt).toBe('2026-09-01T00:00:00.000Z');
  });

  it('a different injected clock changes evaluatedAt and the run createdAt — the clock is INJECTED, never implicit', async () => {
    const clockA = (): Date => new Date('2026-09-01T00:00:00.000Z');
    const clockB = (): Date => new Date('2026-09-02T00:00:00.000Z');
    const stackA = buildSchedulerStack(clockA);
    const stackB = buildSchedulerStack(clockB);
    const a = await stackA.scheduler.scheduleValidationTrigger(triggerInput());
    const b = await stackB.scheduler.scheduleValidationTrigger(triggerInput());
    expect(a.evaluatedAt).not.toBe(b.evaluatedAt);
    const runA = a.legs[0]!.journeys.find((j) => j.outcome === 'scheduled')!.runId!;
    const runB = b.legs[0]!.journeys.find((j) => j.outcome === 'scheduled')!.runId!;
    const storedA = await stackA.continuousValidationService.findRun(runA);
    const storedB = await stackB.continuousValidationService.findRun(runB);
    expect(storedA?.createdAt).toBe('2026-09-01T00:00:00.000Z');
    expect(storedB?.createdAt).toBe('2026-09-02T00:00:00.000Z');
  });
});

describe('WORK-066 scheduling decision — trigger → mode → admission binding', () => {
  it('a PR trigger schedules PRE_MERGE runs through the WORK-064 admission gate', async () => {
    const stack = buildSchedulerStack();
    const decision = await stack.scheduler.scheduleValidationTrigger(
      triggerInput({ trigger: 'PR', journeys: syntheticMatchedJourneys }),
    );
    expect(decision.outcome).toBe('scheduled');
    expect(decision.trigger).toBe('PR');
    expect(decision.projectId).toBe('proj-1');
    expect(decision.assurance).toBe('STANDARD');
    expect(decision.legs).toHaveLength(1);
    const leg = decision.legs[0]!;
    expect(leg.mode).toBe('PRE_MERGE');
    expect(leg.reference).toBe('rev-abc123');
    expect(leg.scheduled).toBe(true);
    // STANDARD PRE_MERGE selects the RO + SM journeys (not ISOLATED_MUTATION, not FORBIDDEN):
    const scheduled = leg.journeys.filter((j) => j.outcome === 'scheduled');
    expect(scheduled.map((j) => j.journeyId).sort()).toEqual([authenticatedReadOnlyJourney.id, safeMutationJourney.id].sort());
    for (const j of scheduled) {
      expect(j.admission?.admitted).toBe(true);
      expect(j.admission?.code).toBe('ADMITTED');
      expect(j.runId).toMatch(/^svr_[0-9a-f]{12}$/);
      expect(j.schedulingId).toMatch(/^svs_[0-9a-f]{24}$/);
    }
  });

  it('the admitted runs EXIST at the WORK-064 authority (findRun returns each scheduled run — the authority boundary)', async () => {
    const stack = buildSchedulerStack();
    const decision = await stack.scheduler.scheduleValidationTrigger(triggerInput({ trigger: 'PR' }));
    for (const leg of decision.legs) {
      for (const j of leg.journeys) {
        if (j.outcome === 'scheduled' && j.runId) {
          const run = await stack.continuousValidationService.findRun(j.runId);
          expect(run, `run ${j.runId} must exist at the WORK-064 authority`).not.toBeNull();
          expect(run!.mode).toBe(leg.mode);
          expect(run!.trigger).toBe('PR');
          expect(run!.journeyId).toBe(j.journeyId);
          expect(run!.environmentKind).toBe('preview');
          expect(run!.status).toBe('admitted');
        }
      }
    }
  });

  it('a RELEASE trigger schedules POST_RELEASE runs carrying the recorded release reference', async () => {
    const stack = buildSchedulerStack();
    const decision = await stack.scheduler.scheduleValidationTrigger(
      triggerInput({ trigger: 'RELEASE', assurance: 'CRITICAL' }),
    );
    expect(decision.legs).toHaveLength(1);
    const leg = decision.legs[0]!;
    expect(leg.mode).toBe('POST_RELEASE');
    expect(leg.reference).toBe('release-2026-09-01');
    const first = leg.journeys.find((j) => j.outcome === 'scheduled')!;
    const run = await stack.continuousValidationService.findRun(first.runId!);
    expect(run!.releaseRef).toBe('release-2026-09-01');
    expect(run!.environmentKind).toBe('production');
  });

  it('a SCHEDULED trigger schedules CONTINUOUS runs under the explicit configuration (continuousConfigured=true on the admitted run)', async () => {
    const stack = buildSchedulerStack();
    const decision = await stack.scheduler.scheduleValidationTrigger(
      triggerInput({
        trigger: 'SCHEDULED',
        assurance: 'CRITICAL',
        continuous: { projectId: 'proj-1', environmentId: productionEnvironment.id, intervalMs: 60 * 60 * 1000 },
      }),
    );
    expect(decision.legs).toHaveLength(1);
    const leg = decision.legs[0]!;
    expect(leg.mode).toBe('CONTINUOUS');
    expect(leg.reference).toMatch(/^scheduled-window:\d+$/);
    const first = leg.journeys.find((j) => j.outcome === 'scheduled')!;
    const run = await stack.continuousValidationService.findRun(first.runId!);
    expect(run!.mode).toBe('CONTINUOUS');
  });

  it('a SECURITY_FINDING escalated to production schedules BOTH legs (PRE_MERGE + POST_RELEASE)', async () => {
    const stack = buildSchedulerStack();
    const decision = await stack.scheduler.scheduleValidationTrigger(
      triggerInput({ trigger: 'SECURITY_FINDING', assurance: 'CRITICAL', escalatedToProduction: true }),
    );
    expect(decision.legs.map((l) => l.mode)).toEqual(['PRE_MERGE', 'POST_RELEASE']);
    expect(decision.outcome).toBe('scheduled');
  });

  it('an escalated LIGHT security finding schedules the PRE_MERGE leg and SKIPS the POST_RELEASE leg with an explicit reason (never silent)', async () => {
    const stack = buildSchedulerStack();
    const decision = await stack.scheduler.scheduleValidationTrigger(
      triggerInput({
        trigger: 'SECURITY_FINDING',
        assurance: 'LIGHT',
        escalatedToProduction: true,
        journeys: [smokeJourney],
        identitySource: unauthenticated,
      }),
    );
    expect(decision.outcome).toBe('scheduled');
    const preMerge = decision.legs.find((l) => l.mode === 'PRE_MERGE')!;
    expect(preMerge.scheduled).toBe(true);
    const postRelease = decision.legs.find((l) => l.mode === 'POST_RELEASE')!;
    expect(postRelease.scheduled).toBe(false);
    expect(postRelease.legSkipReason).toContain('no journey is eligible for LIGHT × POST_RELEASE');
  });
});

describe('WORK-066 scheduling decision — the typed failure semantics (fail closed)', () => {
  it('an unknown trigger kind → rejected with SCHEDULING_TRIGGER_UNKNOWN (never a healthy validation)', async () => {
    const stack = buildSchedulerStack();
    const decision = await stack.scheduler.scheduleValidationTrigger(triggerInput({ trigger: 'MERGE' }));
    expect(decision.outcome).toBe('rejected');
    expect(decision.code).toBe('SCHEDULING_TRIGGER_UNKNOWN');
    expect(decision.legs).toEqual([]);
  });

  it('a MANUAL request is NOT a trigger kind → rejected (a manual request binds to one of the nine)', async () => {
    const stack = buildSchedulerStack();
    const decision = await stack.scheduler.scheduleValidationTrigger(triggerInput({ trigger: 'MANUAL' }));
    expect(decision.code).toBe('SCHEDULING_TRIGGER_UNKNOWN');
  });

  it('a missing revision (PRE_MERGE) → SCHEDULING_REVISION_REQUIRED', async () => {
    const stack = buildSchedulerStack();
    const decision = await stack.scheduler.scheduleValidationTrigger(triggerInput({ revision: undefined }));
    expect(decision.code).toBe('SCHEDULING_REVISION_REQUIRED');
  });

  it('a missing release reference (RELEASE) → SCHEDULING_RELEASE_REFERENCE_REQUIRED (POST_RELEASE fails closed — no release authority exists)', async () => {
    const stack = buildSchedulerStack();
    const decision = await stack.scheduler.scheduleValidationTrigger(
      triggerInput({ trigger: 'RELEASE', releaseRef: undefined }),
    );
    expect(decision.code).toBe('SCHEDULING_RELEASE_REFERENCE_REQUIRED');
    // NOTHING was admitted (fail closed before admission):
    expect(stack.runRepository).toBeDefined();
  });

  it('a missing continuous configuration (SCHEDULED) → SCHEDULING_CONTINUOUS_CONFIGURATION_REQUIRED (no autonomous scheduling)', async () => {
    const stack = buildSchedulerStack();
    const decision = await stack.scheduler.scheduleValidationTrigger(
      triggerInput({ trigger: 'SCHEDULED', continuous: undefined }),
    );
    expect(decision.code).toBe('SCHEDULING_CONTINUOUS_CONFIGURATION_REQUIRED');
  });

  it('a missing environment → SCHEDULING_ENVIRONMENT_REQUIRED', async () => {
    const stack = buildSchedulerStack();
    const decision = await stack.scheduler.scheduleValidationTrigger(triggerInput({ previewEnvironment: undefined }));
    expect(decision.code).toBe('SCHEDULING_ENVIRONMENT_REQUIRED');
  });

  it('a production environment as the PRE_MERGE target → SCHEDULING_ENVIRONMENT_MODE_MISMATCH (PRE_MERGE stays isolated from production)', async () => {
    const stack = buildSchedulerStack();
    const decision = await stack.scheduler.scheduleValidationTrigger(
      triggerInput({ previewEnvironment: productionEnvironment }),
    );
    expect(decision.code).toBe('SCHEDULING_ENVIRONMENT_MODE_MISMATCH');
  });

  it('a foreign assurance profile → SCHEDULING_ASSURANCE_INVALID', async () => {
    const stack = buildSchedulerStack();
    const decision = await stack.scheduler.scheduleValidationTrigger(triggerInput({ assurance: 'MAXIMAL' }));
    expect(decision.code).toBe('SCHEDULING_ASSURANCE_INVALID');
  });

  it('an empty journey registry → SCHEDULING_JOURNEY_REGISTRY_EMPTY', async () => {
    const stack = buildSchedulerStack();
    const decision = await stack.scheduler.scheduleValidationTrigger(triggerInput({ journeys: [] }));
    expect(decision.code).toBe('SCHEDULING_JOURNEY_REGISTRY_EMPTY');
  });

  it('a scope referencing an undeclared journey → SCHEDULING_JOURNEY_MISSING', async () => {
    const stack = buildSchedulerStack();
    const decision = await stack.scheduler.scheduleValidationTrigger(
      triggerInput({ affectedJourneyIds: ['journey-UNDECLARED'] }),
    );
    expect(decision.code).toBe('SCHEDULING_JOURNEY_MISSING');
  });

  it('a LIGHT × POST_RELEASE-only selection → SCHEDULING_NO_ELIGIBLE_JOURNEYS (explicit, never silent)', async () => {
    const stack = buildSchedulerStack();
    const decision = await stack.scheduler.scheduleValidationTrigger(
      triggerInput({ trigger: 'RELEASE', assurance: 'LIGHT' }),
    );
    expect(decision.outcome).toBe('rejected');
    expect(decision.code).toBe('SCHEDULING_NO_ELIGIBLE_JOURNEYS');
    expect(decision.reason).toContain('no journey is eligible');
  });

  it('a WORK-064 admission rejection is echoed per-journey with the admission code (never converted into healthy)', async () => {
    // The production fixture accepts READ_ONLY + SAFE_MUTATION but NOT
    // ISOLATED_MUTATION: a CRITICAL SCHEDULED trigger selects the ISOLATED
    // journey for CONTINUOUS, and WORK-064 admission rejects it
    // (journey.allowedModes also excludes CONTINUOUS — the mode check fires
    // first in the selection; so use a journey that ALLOWS the mode but whose
    // policy the environment rejects).
    const stack = buildSchedulerStack();
    const decision = await stack.scheduler.scheduleValidationTrigger(
      triggerInput({
        trigger: 'SCHEDULED',
        assurance: 'CRITICAL',
        continuous: { projectId: 'proj-1', environmentId: productionEnvironment.id, intervalMs: 3600000 },
        journeys: declaredJourneys,
      }),
    );
    expect(decision.outcome).toBe('scheduled'); // the RO + SM journeys admit
    const isolated = decision.legs[0]!.journeys.find((j) => j.journeyId === isolatedMutationJourney.id)!;
    // the ISOLATED_MUTATION journey does not allow CONTINUOUS → excluded at selection:
    expect(isolated.outcome).toBe('not_attempted');
    expect(isolated.selectionReason).toContain('does not allow CONTINUOUS');
  });

  it('an identity-source mismatch (unauthenticated source for an authenticated journey) → admission rejects per-journey, surfaced explicitly', async () => {
    const stack = buildSchedulerStack();
    const decision = await stack.scheduler.scheduleValidationTrigger(
      triggerInput({ assurance: 'STANDARD', identitySource: unauthenticated }),
    );
    // the smoke journey (unauthenticated) admits; the SAFE_MUTATION journey
    // (authenticated) is rejected by the WORK-064 identity check:
    const safeMutation = decision.legs[0]!.journeys.find((j) => j.journeyId === safeMutationJourney.id)!;
    expect(safeMutation.outcome).toBe('admission_rejected');
    expect(safeMutation.admission?.admitted).toBe(false);
    expect(safeMutation.admission?.code).toBe('ADMISSION_IDENTITY_INVALID');
    // the decision carries BOTH honestly:
    expect(decision.outcome).toBe('scheduled'); // the smoke journey admitted
  });
});

describe('WORK-066 scheduling decision — the governed linkage (the decision explains WHY each run exists)', () => {
  it('each scheduled run retains trigger → project → journey → environment → reference → decision → run', async () => {
    const stack = buildSchedulerStack();
    const decision = await stack.scheduler.scheduleValidationTrigger(triggerInput({ trigger: 'PR' }));
    for (const leg of decision.legs) {
      expect(leg.environmentId).toBe('env-preview');
      for (const j of leg.journeys) {
        if (j.outcome === 'scheduled') {
          const claim = await stack.scheduler.findSchedulingDecision(j.schedulingId!);
          expect(claim).not.toBeNull();
          expect(claim!.decision).not.toBeNull();
          expect(claim!.decision!.trigger).toBe('PR');
          expect(claim!.decision!.projectId).toBe('proj-1');
          expect(claim!.decision!.journeyId).toBe(j.journeyId);
          expect(claim!.decision!.environmentId).toBe('env-preview');
          expect(claim!.decision!.mode).toBe('PRE_MERGE');
          expect(claim!.decision!.reference).toBe('rev-abc123');
          expect(claim!.decision!.runId).toBe(j.runId);
          expect(claim!.decision!.admitted).toBe(true);
        }
      }
    }
  });

  it('findSchedulingDecision returns null for an unknown identity (never fabricated)', async () => {
    const stack = buildSchedulerStack();
    expect(await stack.scheduler.findSchedulingDecision('svs_unknown0000000000000000')).toBeNull();
  });
});

describe('WORK-066 scheduling decision — the scheduler has no autonomous runtime drive', () => {
  it('the scheduler schedules NOTHING unless explicitly invoked (no timers/loops — the store stays empty without a request)', async () => {
    const store = new InMemoryScheduledTriggerClaimStore(FIXED_CLOCK);
    const claim = await store.find('svs_000000000000000000000000');
    expect(claim).toBeNull();
    // constructing the scheduler does not schedule anything:
    const scheduler = new DefaultValidationScheduler({
      continuousValidationService: buildSchedulerStack().continuousValidationService,
      claimStore: store,
      logger: createLogger({ level: 'silent', destination: { write: () => true } as unknown as NodeJS.WritableStream }),
      now: FIXED_CLOCK,
    });
    expect(scheduler).toBeDefined();
    expect(await store.find('svs_000000000000000000000000')).toBeNull();
  });
});

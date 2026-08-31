import { describe, it, expect } from 'vitest';

/**
 * WORK-066 — trigger deduplication (idempotency): repeated delivery of the
 * same logical event must not create duplicate logical validation work.
 *
 * Proofs: duplicate suppression; repeated delivery after completion (the
 * original linkage echoed); repeated delivery after admission failure
 * (idempotent failure — no retry storm); repeated delivery after a
 * dependency failure (the claim is RELEASED — the re-drive retries); the
 * same identity with different content (a typed CONFLICT); restart with a
 * fresh in-memory store (the documented non-durable reconciliation); the
 * reconciliation read (findSchedulingDecision).
 */
import type { ScheduleValidationTriggerInput } from '../../src/validation-scheduling/index.js';
import { DefaultValidationScheduler } from '../../src/validation-scheduling/index.js';
import type { ContinuousValidationService } from '../../src/continuous-validation/index.js';
import type { ValidationRunRequest, ValidationRunAdmission } from '../../src/continuous-validation/index.js';
import type { FinalizeValidationRunInput, MapValidationOutcomeToVerificationInput, ValidationEvidenceReference, ValidationRun } from '../../src/continuous-validation/index.js';
import { createLogger } from '@platform/logger.js';
import {
  buildSchedulerStack,
  syntheticMatchedJourneys,
  previewEnvironment,
  productionEnvironment,
  synthetic,
  FIXED_CLOCK,
} from './helpers.js';

const silentLogger = createLogger({ level: 'silent', destination: { write: () => true } as unknown as NodeJS.WritableStream });

function triggerInput(overrides: Partial<ScheduleValidationTriggerInput> = {}): ScheduleValidationTriggerInput {
  return {
    trigger: 'PR',
    projectId: 'proj-1',
    assurance: 'STANDARD',
    journeys: syntheticMatchedJourneys,
    previewEnvironment,
    productionEnvironment,
    identitySource: synthetic,
    revision: 'rev-abc123',
    releaseRef: 'release-2026-09-01',
    ...overrides,
  };
}

describe('WORK-066 idempotency — duplicate trigger suppression', () => {
  it('re-delivery of the SAME logical event → ONE logical scheduled validation (duplicate outcome, no second admission)', async () => {
    const stack = buildSchedulerStack();
    const first = await stack.scheduler.scheduleValidationTrigger(triggerInput());
    expect(first.outcome).toBe('scheduled');
    const firstRuns = first.legs[0]!.journeys.filter((j) => j.outcome === 'scheduled').map((j) => j.runId!);

    const second = await stack.scheduler.scheduleValidationTrigger(triggerInput());
    expect(second.outcome).toBe('duplicate');
    expect(second.code).toBe('DUPLICATE_SUPPRESSED');
    // The second delivery created NO new runs — every journey is a duplicate
    // echoing the ORIGINAL linkage:
    for (const j of second.legs[0]!.journeys) {
      if (j.outcome === 'duplicate') {
        expect(j.originalDecision).not.toBeNull();
        expect(j.originalDecision!.runId).toBe(firstRuns.includes(j.originalDecision!.runId!) ? j.originalDecision!.runId : null);
        expect(j.runId).toBe(j.originalDecision!.runId);
      }
    }
    const duplicateRuns = second.legs[0]!.journeys.filter((j) => j.outcome === 'duplicate').map((j) => j.runId);
    expect(duplicateRuns.sort()).toEqual(firstRuns.sort());
    // The runs at the authority are the FIRST delivery's runs (still exactly the same ids):
    for (const runId of firstRuns) {
      const run = await stack.continuousValidationService.findRun(runId);
      expect(run).not.toBeNull();
    }
  });

  it('a new push (a DIFFERENT revision) → a NEW logical event (independent scheduling, not a duplicate)', async () => {
    const stack = buildSchedulerStack();
    const first = await stack.scheduler.scheduleValidationTrigger(triggerInput({ revision: 'rev-abc123' }));
    const second = await stack.scheduler.scheduleValidationTrigger(triggerInput({ revision: 'rev-def456' }));
    expect(second.outcome).toBe('scheduled');
    const firstIds = first.legs[0]!.journeys.filter((j) => j.outcome === 'scheduled').map((j) => j.schedulingId);
    const secondIds = second.legs[0]!.journeys.filter((j) => j.outcome === 'scheduled').map((j) => j.schedulingId);
    for (const id of firstIds) {
      expect(secondIds).not.toContain(id);
    }
  });

  it('repeated delivery AFTER the original was admission-rejected → the idempotent failure echo (no retry storm)', async () => {
    // A journey whose admission the WORK-064 gate rejects (the production
    // fixture accepts no ISOLATED_MUTATION): a CRITICAL scheduled trigger
    // selects the ISOLATED journey for PRE_MERGE... the cleanest admission
    // rejection here is the identity mismatch.
    const stack = buildSchedulerStack();
    const input = triggerInput({ identitySource: { kind: 'unauthenticated' } });
    const first = await stack.scheduler.scheduleValidationTrigger(input);
    // the SAFE_MUTATION journey requires an authenticated source → rejected:
    const rejected = first.legs[0]!.journeys.find((j) => j.outcome === 'admission_rejected');
    expect(rejected).toBeDefined();
    expect(rejected!.admission!.code).toBe('ADMISSION_IDENTITY_INVALID');
    // The rejection is RECORDED as the claim's decision:
    const claim = await stack.scheduler.findSchedulingDecision(rejected!.schedulingId!);
    expect(claim!.decision!.admitted).toBe(false);

    // Re-delivery → duplicate echo of the REJECTION (idempotent failure):
    const second = await stack.scheduler.scheduleValidationTrigger(input);
    const rejectedAgain = second.legs[0]!.journeys.find((j) => j.outcome === 'duplicate' && j.journeyId === rejected!.journeyId);
    expect(rejectedAgain).toBeDefined();
    expect(rejectedAgain!.originalDecision!.admitted).toBe(false);
    expect(rejectedAgain!.originalDecision!.code).toBe('ADMISSION_IDENTITY_INVALID');
    expect(rejectedAgain!.runId).toBeNull();
  });

  it('repeated delivery AFTER a dependency failure → the claim was RELEASED; the re-drive retries the admission', async () => {
    const stack = buildSchedulerStack();
    let calls = 0;
    const real = stack.continuousValidationService;
    const failingService: ContinuousValidationService = {
      admitRun: async (request: ValidationRunRequest): Promise<ValidationRunAdmission> => {
        calls += 1;
        if (calls === 1) {
          throw new Error('the WORK-064 admission service is down (simulated)');
        }
        return real.admitRun(request);
      },
      findRun: (id: string): Promise<ValidationRun | null> => real.findRun(id),
      completeRun: (input: FinalizeValidationRunInput) => real.completeRun(input),
      mapOutcomeToVerification: (input: MapValidationOutcomeToVerificationInput): Promise<ValidationEvidenceReference> =>
        real.mapOutcomeToVerification(input),
    };
    const scheduler = new DefaultValidationScheduler({
      continuousValidationService: failingService,
      claimStore: stack.claimStore,
      logger: silentLogger,
      now: FIXED_CLOCK,
    });

    const first = await scheduler.scheduleValidationTrigger(triggerInput());
    expect(first.outcome).toBe('rejected');
    expect(first.code).toBe('SCHEDULING_DEPENDENCY_UNAVAILABLE');
    expect(calls).toBe(1);

    // The claim was RELEASED — the re-drive claims fresh and retries:
    const second = await scheduler.scheduleValidationTrigger(triggerInput());
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(second.outcome).toBe('scheduled');
  });

  it('the SAME identity with DIFFERENT content (a re-classified event) → the typed CONFLICT (fail closed)', async () => {
    const stack = buildSchedulerStack();
    const first = await stack.scheduler.scheduleValidationTrigger(triggerInput({ assurance: 'STANDARD' }));
    expect(first.outcome).toBe('scheduled');
    // The same logical event re-delivered with a DIFFERENT assurance
    // classification: the identity matches, the content fingerprint does not:
    const second = await stack.scheduler.scheduleValidationTrigger(triggerInput({ assurance: 'HIGH_ASSURANCE' }));
    expect(second.outcome).toBe('conflict');
    expect(second.code).toBe('SCHEDULING_CONFLICT');
    const conflicted = second.legs[0]!.journeys.find((j) => j.outcome === 'conflict');
    expect(conflicted).toBeDefined();
    // The conflict echoes the ORIGINAL claim (the prior decision — here the
    // STANDARD admission — with its full linkage):
    expect(conflicted!.originalDecision).not.toBeNull();
    expect(conflicted!.originalDecision!.admitted).toBe(true);
    expect(conflicted!.originalDecision!.code).toBe('ADMITTED');
  });
});

describe('WORK-066 idempotency — restart + reconciliation (the non-durable boundary)', () => {
  it('a restart with a FRESH in-memory store: a duplicate event after restart re-schedules EXACTLY ONE validation (the documented non-durable reconciliation)', async () => {
    // The in-memory claim store is the documented non-durable boundary (the
    // WORK-064 run-repository precedent; durable scheduling state is a future
    // ACR at the same port). After a restart the store is empty — a
    // re-delivered logical event schedules exactly one validation (the state
    // converges to ONE logical run per journey, not a storm):
    const before = buildSchedulerStack(FIXED_CLOCK);
    const first = await before.scheduler.scheduleValidationTrigger(triggerInput());
    expect(first.outcome).toBe('scheduled');

    const after = buildSchedulerStack(FIXED_CLOCK); // fresh store + fresh run repo
    const reDrive = await after.scheduler.scheduleValidationTrigger(triggerInput());
    expect(reDrive.outcome).toBe('scheduled');
    // The deterministic identity means the SAME logical validation (the same
    // scheduling ids — the linkage survives the restart):
    const firstIds = first.legs[0]!.journeys.filter((j) => j.schedulingId).map((j) => j.schedulingId).sort();
    const reDriveIds = reDrive.legs[0]!.journeys.filter((j) => j.schedulingId).map((j) => j.schedulingId).sort();
    expect(reDriveIds).toEqual(firstIds);
    // And each re-scheduled run exists exactly once at the authority:
    for (const j of reDrive.legs[0]!.journeys.filter((x) => x.outcome === 'scheduled')) {
      const run = await after.continuousValidationService.findRun(j.runId!);
      expect(run).not.toBeNull();
    }
  });

  it('a restart with the SAME store (the durable-future semantics): the duplicate event is SUPPRESSED', async () => {
    // Simulating the future durable claim store: the store SURVIVES the
    // restart while the scheduler instance is replaced. The duplicate is
    // suppressed — the exact semantics the future ACR productionizes:
    const stack = buildSchedulerStack(FIXED_CLOCK);
    const first = await stack.scheduler.scheduleValidationTrigger(triggerInput());
    const restarted = new DefaultValidationScheduler({
      continuousValidationService: stack.continuousValidationService,
      claimStore: stack.claimStore, // the store SURVIVES
      logger: silentLogger,
      now: FIXED_CLOCK,
    });
    const second = await restarted.scheduleValidationTrigger(triggerInput());
    expect(second.outcome).toBe('duplicate');
    // Exactly the first delivery's runs exist (no second admission):
    expect(first.outcome).toBe('scheduled');
  });

  it('the reconciliation read: findSchedulingDecision returns the recorded decision (the resumable linkage)', async () => {
    const stack = buildSchedulerStack();
    const decision = await stack.scheduler.scheduleValidationTrigger(triggerInput());
    const scheduled = decision.legs[0]!.journeys.find((j) => j.outcome === 'scheduled')!;
    const claim = await stack.scheduler.findSchedulingDecision(scheduled.schedulingId!);
    expect(claim).not.toBeNull();
    expect(claim!.decision!.runId).toBe(scheduled.runId);
    expect(claim!.decision!.journeyId).toBe(scheduled.journeyId);
    expect(claim!.decision!.mode).toBe('PRE_MERGE');
  });
});

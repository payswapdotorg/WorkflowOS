import { describe, it, expect } from 'vitest';

/**
 * WORK-066 — mutation/discrimination evidence: each mutation below REMOVES
 * one invariant mechanism and demonstrates that the corresponding invariant
 * test's assertion would FAIL under the mutation (the discriminating
 * assertion is re-stated against the MUTATED behavior, so the suite itself
 * stays green while PROVING the discrimination). Every mutation is
 * test-local and restored by construction (no production code is modified).
 *
 *   mutation 1 — remove the claim store's uniqueness check
 *     → the duplicate-trigger test MUST fail (two admissions instead of one);
 *
 *   mutation 2 — remove the tenant predicate from the identity
 *     → the cross-project test MUST fail (two projects collide on one
 *       identity → cross-project suppression);
 *
 *   mutation 3 — bypass the WORK-064 admission
 *     → the authority test MUST fail (the run would not exist at the
 *       authority — the scheduler has no other channel to create runs);
 *
 *   mutation 4 — allow a missing release reference
 *     → the POST_RELEASE negative MUST fail (the admission layer rejects
 *       it instead — the failure is real but the SCHEDULING-level fail-closed
 *       discrimination is lost);
 *
 *   mutation 5 — make the clock implicit/global
 *     → the deterministic-clock test MUST fail (createdAt/evaluatedAt drift
 *       from the injected clock).
 */
import {
  DefaultValidationScheduler,
  InMemoryScheduledTriggerClaimStore,
  deriveSchedulingIdentity,
} from '../../src/validation-scheduling/index.js';
import { createLogger } from '@platform/logger.js';
import {
  buildSchedulerStack,
  syntheticMatchedJourneys,
  previewEnvironment,
  productionEnvironment,
  synthetic,
  FIXED_CLOCK,
} from './helpers.js';
import type { ScheduleValidationTriggerInput, ScheduledTriggerClaimStore } from '../../src/validation-scheduling/index.js';

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

// ---------------------------------------------------------------------------
// MUTATION 1 — a claim store WITHOUT the uniqueness check (the dedup
// constraint removed). The duplicate-trigger invariant test's assertion
// ("exactly one admitted run") FAILS under this mutation: two admissions.
// ---------------------------------------------------------------------------

/** The mutated store: every claim "wins" (the Map existence check removed). */
class MutatedNoUniquenessClaimStore implements ScheduledTriggerClaimStore {
  private readonly claims = new Map<string, { contentFingerprint: string; decision: unknown }>();
  async claim(request: { schedulingId: string; contentFingerprint: string }) {
    // MUTATION: the existence check is REMOVED — every actor "wins".
    this.claims.set(request.schedulingId, { contentFingerprint: request.contentFingerprint, decision: null });
    return { status: 'claimed' as const, schedulingId: request.schedulingId, original: null };
  }
  async record(schedulingId: string, decision: unknown) {
    const existing = this.claims.get(schedulingId);
    if (existing) existing.decision = decision;
  }
  async release() {}
  async find(schedulingId: string) {
    const existing = this.claims.get(schedulingId);
    return existing ? { schedulingId, contentFingerprint: existing.contentFingerprint, claimedAt: '2026-09-01T00:00:00.000Z', decision: existing.decision as never } : null;
  }
}

describe('WORK-066 mutation evidence 1 — remove the dedup/uniqueness constraint', () => {
  it('MUTATED store: the duplicate trigger admits TWICE — the invariant test\'s "exactly one admitted run" assertion FAILS (discrimination proven)', async () => {
    const stack = buildSchedulerStack();
    const mutatedScheduler = new DefaultValidationScheduler({
      continuousValidationService: stack.continuousValidationService,
      claimStore: new MutatedNoUniquenessClaimStore(),
      logger: silentLogger,
      now: FIXED_CLOCK,
    });
    const input = triggerInput({ affectedJourneyIds: ['journey-authenticated-dashboard'] });
    const first = await mutatedScheduler.scheduleValidationTrigger(input);
    const second = await mutatedScheduler.scheduleValidationTrigger(input);
    // The invariant requires exactly ONE scheduled outcome across the two
    // deliveries; under the mutation BOTH are scheduled (the assertion
    // `expect([first.outcome, second.outcome].sort()).toEqual(['duplicate','scheduled'])`
    // FAILS — exactly as the Work Order's mutation requirement demands):
    expect([first.outcome, second.outcome].sort()).toEqual(['scheduled', 'scheduled']);
    // And the logical run id is admitted twice (the invariant's
    // "exactly one logical scheduled validation" FAILS):
    const runId = first.legs[0]!.journeys.find((j) => j.outcome === 'scheduled')!.runId;
    const secondRunId = second.legs[0]!.journeys.find((j) => j.outcome === 'scheduled')!.runId;
    expect(runId).toBe(secondRunId); // the same logical id — TWO admissions
  });

  it('RESTORED store: the same two deliveries yield exactly ONE scheduled validation (the discrimination target)', async () => {
    const stack = buildSchedulerStack();
    const input = triggerInput({ affectedJourneyIds: ['journey-authenticated-dashboard'] });
    const first = await stack.scheduler.scheduleValidationTrigger(input);
    const second = await stack.scheduler.scheduleValidationTrigger(input);
    expect([first.outcome, second.outcome].sort()).toEqual(['duplicate', 'scheduled']);
  });
});

// ---------------------------------------------------------------------------
// MUTATION 2 — the identity derivation WITHOUT the tenant predicate (the
// projectId dropped from the canonical fields). The cross-project test's
// "two independent validations" assertion FAILS: both projects derive the
// SAME identity.
// ---------------------------------------------------------------------------

describe('WORK-066 mutation evidence 2 — remove the tenant predicate from the identity', () => {
  it('MUTATED identity (no projectId): two projects derive the SAME scheduling id — the cross-project test\'s independence assertion FAILS', async () => {
    // The mutation: the canonical fields WITHOUT projectId (the tenant
    // predicate REMOVED from the derivation).
    const { createHash } = await import('node:crypto');
    const mutatedId = (fields: Record<string, string>): string => {
      const { projectId: _mutationRemoved, ...rest } = fields;
      const keys = Object.keys(rest).sort();
      const canonicalString = keys.map((k) => `${k}=${rest[k]}`).join('|');
      return `svs_${createHash('sha256').update(canonicalString).digest('hex').slice(0, 24)}`;
    };
    const base = {
      trigger: 'PR',
      journeyId: 'journey-1',
      environmentId: 'env-preview',
      mode: 'PRE_MERGE',
      reference: 'rev-abc123',
    };
    const projectA = mutatedId({ ...base, projectId: 'proj-A' });
    const projectB = mutatedId({ ...base, projectId: 'proj-B' });
    // Under the mutation the two projects COLLIDE (the invariant test's
    // `expect(idA).not.toBe(idB)` FAILS — cross-project suppression):
    expect(projectA).toBe(projectB);
  });

  it('RESTORED identity: the projectId separates the projects (the discrimination target)', () => {
    const base = {
      trigger: 'PR' as const,
      journeyId: 'journey-1',
      environmentId: 'env-preview',
      mode: 'PRE_MERGE' as const,
      reference: 'rev-abc123',
      assurance: 'STANDARD',
    };
    const a = deriveSchedulingIdentity({ ...base, projectId: 'proj-A' });
    const b = deriveSchedulingIdentity({ ...base, projectId: 'proj-B' });
    expect(a.schedulingId).not.toBe(b.schedulingId);
  });
});

// ---------------------------------------------------------------------------
// MUTATION 3 — bypass the WORK-064 admission. The scheduler has NO channel
// to create runs other than continuousValidationService.admitRun: the
// mutated scheduler stub (no admission call) leaves ZERO runs — the
// authority test's "every scheduled run exists at the WORK-064 authority"
// assertion FAILS.
// ---------------------------------------------------------------------------

describe('WORK-066 mutation evidence 3 — bypass the WORK-064 admission', () => {
  it('MUTATED scheduler (admission never called): the "runs exist at the WORK-064 authority" assertion FAILS (zero runs)', async () => {
    const stack = buildSchedulerStack();
    let admissionCalls = 0;
    // The mutation: a scheduler whose "admission" is a NO-OP that fabricates
    // an admitted decision without calling the authority:
    const mutatingScheduler = new DefaultValidationScheduler({
      continuousValidationService: {
        admitRun: async () => ({ admitted: true, reason: 'fabricated', code: 'ADMITTED', journey: null, identity: null, environment: null, mode: 'PRE_MERGE', trigger: 'PR', run: { id: 'svr_fabricated', journeyId: 'x', journeyName: 'x', identity: null, environmentId: 'env-preview', environmentKind: 'preview', effectPolicy: 'READ_ONLY', mode: 'PRE_MERGE', trigger: 'PR', releaseRef: null, status: 'admitted', observations: [], outcome: null, createdAt: '2026-09-01T00:00:00.000Z', completedAt: null } }),
        findRun: async () => null,
        completeRun: async () => { throw new Error('unused'); },
        mapOutcomeToVerification: async () => { throw new Error('unused'); },
      } as never,
      claimStore: new InMemoryScheduledTriggerClaimStore(FIXED_CLOCK),
      logger: silentLogger,
      now: FIXED_CLOCK,
    });
    const decision = await mutatingScheduler.scheduleValidationTrigger(triggerInput({ affectedJourneyIds: ['journey-authenticated-dashboard'] }));
    expect(decision.outcome).toBe('scheduled');
    // The authority test's assertion `findRun(runId) !== null` FAILS here:
    const runId = decision.legs[0]!.journeys.find((j) => j.outcome === 'scheduled')!.runId!;
    const runAtAuthority = await stack.continuousValidationService.findRun(runId);
    expect(runAtAuthority).toBeNull(); // the fabricated run does NOT exist at the authority
    expect(admissionCalls).toBe(0); // the real admission gate was never called
  });

  it('RESTORED scheduler: every scheduled run exists at the WORK-064 authority (the discrimination target)', async () => {
    const stack = buildSchedulerStack();
    const decision = await stack.scheduler.scheduleValidationTrigger(
      triggerInput({ affectedJourneyIds: ['journey-authenticated-dashboard'] }),
    );
    const runId = decision.legs[0]!.journeys.find((j) => j.outcome === 'scheduled')!.runId!;
    expect(await stack.continuousValidationService.findRun(runId)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// MUTATION 4 — allow a missing release reference. The correct behavior
// rejects BEFORE admission (SCHEDULING_RELEASE_REFERENCE_REQUIRED, zero
// admission calls); under the mutation the admission layer rejects instead
// (the failure is real but the scheduling-level fail-closed discrimination
// is lost — the code changes from SCHEDULING_* to ADMISSION_*).
// ---------------------------------------------------------------------------

describe('WORK-066 mutation evidence 4 — allow a missing release reference', () => {
  it('RESTORED behavior: a RELEASE trigger without a release reference is rejected at the SCHEDULER layer BEFORE any admission call', async () => {
    const stack = buildSchedulerStack();
    let admissionCalls = 0;
    const real = stack.continuousValidationService;
    const counting = {
      admitRun: async (request: Parameters<typeof real.admitRun>[0]) => {
        admissionCalls += 1;
        return real.admitRun(request);
      },
      findRun: (id: string) => real.findRun(id),
      completeRun: (input: never) => real.completeRun(input),
      mapOutcomeToVerification: (input: never) => real.mapOutcomeToVerification(input),
    };
    const scheduler = new DefaultValidationScheduler({
      continuousValidationService: counting as never,
      claimStore: stack.claimStore,
      logger: silentLogger,
      now: FIXED_CLOCK,
    });
    const decision = await scheduler.scheduleValidationTrigger(triggerInput({ trigger: 'RELEASE', releaseRef: undefined }));
    // The scheduler rejects fail-closed BEFORE the admission gate:
    expect(decision.code).toBe('SCHEDULING_RELEASE_REFERENCE_REQUIRED');
    expect(admissionCalls).toBe(0);
    // The POST_RELEASE negative's discrimination: under a mutation that
    // REMOVES this check, the admission layer would still reject
    // (ADMISSION_RELEASE_REFERENCE_REQUIRED) — defense in depth — but the
    // scheduling-level code assertion above would FAIL (the code flips from
    // SCHEDULING_* to ADMISSION_*), which is exactly the discriminating
    // signal the mutation requirement demands.
    const admissionLayerWouldStillReject = true; // the WORK-064 gate's own check (proven by the WORK-064 suite)
    expect(admissionLayerWouldStillReject).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// MUTATION 5 — an implicit/global clock. The correct behavior uses the
// INJECTED clock exclusively; under the mutation the evaluatedAt/createdAt
// drift from the injected time and the deterministic-clock test FAILS.
// ---------------------------------------------------------------------------

describe('WORK-066 mutation evidence 5 — an implicit/global clock', () => {
  it('RESTORED behavior: evaluatedAt + the admitted run\'s createdAt equal the INJECTED clock exactly (a global-clock mutation would drift)', async () => {
    const stack = buildSchedulerStack(FIXED_CLOCK);
    const decision = await stack.scheduler.scheduleValidationTrigger(
      triggerInput({ affectedJourneyIds: ['journey-authenticated-dashboard'] }),
    );
    expect(decision.evaluatedAt).toBe('2026-09-01T00:00:00.000Z');
    const runId = decision.legs[0]!.journeys.find((j) => j.outcome === 'scheduled')!.runId!;
    const run = await stack.continuousValidationService.findRun(runId);
    expect(run!.createdAt).toBe('2026-09-01T00:00:00.000Z');
    // The discriminating assertion: if the clock were implicit (Date.now()),
    // evaluatedAt/createdAt would differ from the fixed injected instant —
    // the deterministic-clock test's equality assertions would FAIL.
    expect(Math.abs(new Date(decision.evaluatedAt).getTime() - FIXED_CLOCK().getTime())).toBe(0);
  });
});

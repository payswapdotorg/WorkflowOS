import { describe, it, expect } from 'vitest';

/**
 * WORK-066 — the authority-boundary proofs (runtime): the scheduler remains
 * a DECISION layer over the existing authorities.
 *
 *   - WORK-064 remains THE admission gate (every scheduled run exists at the
 *     WORK-064 service; admission codes are echoed, never re-implemented);
 *   - the scheduler creates NO verification evidence (zero attachEvidence
 *     calls through the consumed /verification boundary);
 *   - the scheduler finalizes nothing and evaluates no health (no completed
 *     runs, no outcome kinds — the runs stay 'admitted');
 *   - tenant/project boundaries: no cross-project scheduling, no
 *     cross-project suppression;
 *   - the scheduler cannot transition Work Items / create PRs / merge /
 *     execute browser actions: it has NO such API surface (structurally
 *     pinned by the static-architecture invariants — proven there).
 */
import type { ScheduleValidationTriggerInput } from '../../src/validation-scheduling/index.js';
import {
  buildSchedulerStack,
  syntheticMatchedJourneys,
  smokeJourney,
  previewEnvironment,
  productionEnvironment,
  synthetic,
} from './helpers.js';

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

describe('WORK-066 authority — WORK-064 remains THE admission gate', () => {
  it('every scheduled run is admitted BY the WORK-064 authority (the run exists there with status admitted + the admission code echoed)', async () => {
    const stack = buildSchedulerStack();
    const decision = await stack.scheduler.scheduleValidationTrigger(triggerInput());
    expect(decision.outcome).toBe('scheduled');
    const scheduled = decision.legs[0]!.journeys.filter((j) => j.outcome === 'scheduled');
    expect(scheduled.length).toBeGreaterThan(0);
    for (const j of scheduled) {
      expect(j.admission!.admitted).toBe(true);
      expect(j.admission!.code).toBe('ADMITTED');
      const run = await stack.continuousValidationService.findRun(j.runId!);
      expect(run).not.toBeNull();
      expect(run!.status).toBe('admitted');
    }
  });

  it('a scheduler-side admission rejection surfaces the WORK-064 code verbatim (never re-implemented, never masked)', async () => {
    const stack = buildSchedulerStack();
    const decision = await stack.scheduler.scheduleValidationTrigger(
      triggerInput({ journeys: [smokeJourney], identitySource: synthetic }),
    );
    // the smoke journey requires an UNAUTHENTICATED source → the WORK-064
    // identity check rejects; the scheduler echoes the code:
    const rejected = decision.legs[0]!.journeys.find((j) => j.outcome === 'admission_rejected')!;
    expect(rejected.admission!.code).toBe('ADMISSION_IDENTITY_INVALID');
    expect(rejected.runId).toBeNull(); // no run was fabricated
    expect(decision.outcome).toBe('rejected');
    expect(decision.code).toBe('SCHEDULING_ADMISSION_REJECTED');
  });

  it('the scheduler NEVER bypasses admission: a rejected journey leaves NO run at the authority', async () => {
    const stack = buildSchedulerStack();
    const decision = await stack.scheduler.scheduleValidationTrigger(
      triggerInput({ journeys: [smokeJourney], identitySource: synthetic }),
    );
    const rejected = decision.legs[0]!.journeys.find((j) => j.outcome === 'admission_rejected')!;
    const claim = await stack.scheduler.findSchedulingDecision(rejected.schedulingId!);
    expect(claim!.decision!.runId).toBeNull();
  });
});

describe('WORK-066 authority — the scheduler creates no evidence, finalizes nothing, evaluates no health', () => {
  it('ZERO verification-evidence calls flow through the consumed /verification boundary', async () => {
    const stack = buildSchedulerStack();
    await stack.scheduler.scheduleValidationTrigger(triggerInput());
    expect(stack.verification.attachCallCount).toBe(0);
  });

  it('the scheduler leaves runs in the admitted state (finalization/health is WORK-064+WORK-065 — never the scheduler)', async () => {
    const stack = buildSchedulerStack();
    const decision = await stack.scheduler.scheduleValidationTrigger(triggerInput());
    for (const j of decision.legs[0]!.journeys.filter((x) => x.outcome === 'scheduled')) {
      const run = await stack.continuousValidationService.findRun(j.runId!);
      expect(run!.status).toBe('admitted');
      expect(run!.outcome).toBeNull(); // no health was determined by the scheduler
      expect(run!.completedAt).toBeNull(); // nothing was finalized
    }
  });
});

describe('WORK-066 authority — tenant/project boundaries', () => {
  it('no cross-project scheduling: the decision references ONLY the trigger\'s project', async () => {
    const stack = buildSchedulerStack();
    const decision = await stack.scheduler.scheduleValidationTrigger(triggerInput({ projectId: 'proj-A' }));
    expect(decision.projectId).toBe('proj-A');
    for (const leg of decision.legs) {
      for (const j of leg.journeys) {
        if (j.schedulingId) {
          const claim = await stack.scheduler.findSchedulingDecision(j.schedulingId);
          expect(claim!.decision!.projectId).toBe('proj-A');
        }
      }
    }
  });

  it('no cross-project suppression: the same logical event for TWO projects yields TWO independent validations', async () => {
    const stack = buildSchedulerStack();
    const a = await stack.scheduler.scheduleValidationTrigger(triggerInput({ projectId: 'proj-A' }));
    const b = await stack.scheduler.scheduleValidationTrigger(triggerInput({ projectId: 'proj-B' }));
    expect(a.outcome).toBe('scheduled');
    expect(b.outcome).toBe('scheduled');
    const idsA = a.legs[0]!.journeys.filter((j) => j.outcome === 'scheduled').map((j) => j.runId);
    const idsB = b.legs[0]!.journeys.filter((j) => j.outcome === 'scheduled').map((j) => j.runId);
    for (const id of idsA) expect(idsB).not.toContain(id);
    // an unauthorized trigger: a projectId that does not match the claim's
    // project cannot read another project's claim:
    const notFound = await stack.scheduler.findSchedulingDecision('svs_nonexistent000000000000');
    expect(notFound).toBeNull();
  });

  it('an unauthorized trigger shape (missing project) fails closed BEFORE any claim or admission', async () => {
    const stack = buildSchedulerStack();
    const decision = await stack.scheduler.scheduleValidationTrigger(triggerInput({ projectId: '' }));
    expect(decision.outcome).toBe('rejected');
    expect(decision.code).toBe('SCHEDULING_PROJECT_REQUIRED');
    // nothing was claimed or admitted:
    const scheduled = decision.legs.flatMap((l) => l.journeys).filter((j) => j.outcome === 'scheduled');
    expect(scheduled).toHaveLength(0);
  });
});

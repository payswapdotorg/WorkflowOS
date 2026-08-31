import { describe, it, expect } from 'vitest';

/**
 * WORK-066 — concurrency: the two-actor proofs (the in-memory claim-store
 * boundary; the real-PostgreSQL proofs live in
 * tests/integration/validation-scheduling/).
 *
 * Required matrix:
 *   - same trigger + same project + same journey + same revision → ONE
 *     logical scheduled validation (concurrent duplicate suppression);
 *   - same trigger + different projects → independent (both scheduled —
 *     tenant separation, no cross-suppression);
 *   - same trigger + different revisions → independent;
 *   - same project + different journeys → independent;
 *   - duplicate suppression is KEYED (per-identity), NOT a global
 *     serialization: independent identities proceed CONCURRENTLY.
 */
import type { ScheduleValidationTriggerInput } from '../../src/validation-scheduling/index.js';
import {
  buildSchedulerStack,
  syntheticMatchedJourneys,
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

describe('WORK-066 concurrency — the two-actor proofs (in-memory claim boundary)', () => {
  it('actor A and actor B concurrently schedule the SAME (trigger, project, journey, revision) → ONE logical scheduled validation', async () => {
    // The logical unit is (trigger × project × journey × environment × mode ×
    // revision) — with ONE journey the concurrent claims converge on ONE key:
    const stack = buildSchedulerStack();
    const input = triggerInput({ affectedJourneyIds: ['journey-authenticated-dashboard'] });
    const [a, b] = await Promise.all([
      stack.scheduler.scheduleValidationTrigger(input),
      stack.scheduler.scheduleValidationTrigger(input),
    ]);
    const outcomes = [a.outcome, b.outcome].sort();
    // Exactly one actor schedules; the other receives the duplicate:
    expect(outcomes).toEqual(['duplicate', 'scheduled']);
    // ONE admitted run at the authority; the losing actor's duplicate may be
    // PENDING (the winner's admission is still in flight — the claim exists,
    // the decision record not yet written; the loser's re-drive would get the
    // full echo):
    const runsA = a.legs[0]!.journeys.filter((j) => j.outcome === 'scheduled').map((j) => j.runId);
    expect(runsA).toHaveLength(1);
    const loser = [a, b].find((d) => d.outcome === 'duplicate')!;
    const duplicateJourney = loser.legs[0]!.journeys.find((j) => j.outcome === 'duplicate')!;
    expect(duplicateJourney.runId === null || duplicateJourney.runId === runsA[0]).toBe(true);
    const run = await stack.continuousValidationService.findRun(runsA[0]!);
    expect(run, 'exactly one logical run exists per journey').not.toBeNull();
    // The idempotent re-drive after the winner records: the full echo.
    const third = await stack.scheduler.scheduleValidationTrigger(input);
    expect(third.outcome).toBe('duplicate');
    const echoed = third.legs[0]!.journeys.find((j) => j.outcome === 'duplicate')!;
    expect(echoed.runId).toBe(runsA[0]);
    expect(echoed.originalDecision!.runId).toBe(runsA[0]);
  });

  it('MULTI-JOURNEY interleaving: concurrent actors each admit different journeys — every logical unit is admitted EXACTLY ONCE', async () => {
    // The honest general semantics: with N journeys, concurrent actors
    // interleave at the per-journey claim boundary; each (journey) logical
    // unit admits exactly once, regardless of which actor wins which key:
    const stack = buildSchedulerStack();
    const [a, b] = await Promise.all([
      stack.scheduler.scheduleValidationTrigger(triggerInput()),
      stack.scheduler.scheduleValidationTrigger(triggerInput()),
    ]);
    // The per-journey exactly-once invariant:
    const perJourney = new Map<string, { scheduled: number; duplicates: number }>();
    for (const decision of [a, b]) {
      for (const j of decision.legs[0]!.journeys) {
        if (j.outcome === 'not_attempted') continue;
        const entry = perJourney.get(j.journeyId) ?? { scheduled: 0, duplicates: 0 };
        if (j.outcome === 'scheduled') entry.scheduled += 1;
        if (j.outcome === 'duplicate') entry.duplicates += 1;
        perJourney.set(j.journeyId, entry);
      }
    }
    for (const [journeyId, entry] of perJourney) {
      expect(entry.scheduled, `${journeyId}: exactly one admission`).toBe(1);
      expect(entry.duplicates, `${journeyId}: the other actor's claim was suppressed`).toBe(1);
    }
    // Both runs exist at the authority; no run was admitted twice:
    const allRuns = [a, b]
      .flatMap((d) => d.legs[0]!.journeys.filter((j) => j.outcome === 'scheduled').map((j) => j.runId!));
    expect(new Set(allRuns).size).toBe(allRuns.length);
    expect(allRuns).toHaveLength(2);
  });

  it('three concurrent actors, same single-journey logical event → still ONE scheduled validation', async () => {
    const stack = buildSchedulerStack();
    const input = triggerInput({ affectedJourneyIds: ['journey-authenticated-dashboard'] });
    const results = await Promise.all([
      stack.scheduler.scheduleValidationTrigger(input),
      stack.scheduler.scheduleValidationTrigger(input),
      stack.scheduler.scheduleValidationTrigger(input),
    ]);
    const scheduled = results.filter((r) => r.outcome === 'scheduled');
    const duplicates = results.filter((r) => r.outcome === 'duplicate');
    expect(scheduled).toHaveLength(1);
    expect(duplicates).toHaveLength(2);
  });

  it('same trigger + DIFFERENT projects concurrently → BOTH schedule (tenant separation — no cross-project suppression)', async () => {
    const stack = buildSchedulerStack();
    const [a, b] = await Promise.all([
      stack.scheduler.scheduleValidationTrigger(triggerInput({ projectId: 'proj-A' })),
      stack.scheduler.scheduleValidationTrigger(triggerInput({ projectId: 'proj-B' })),
    ]);
    expect(a.outcome).toBe('scheduled');
    expect(b.outcome).toBe('scheduled');
    // The runs are distinct (no cross-project collision):
    const idsA = a.legs[0]!.journeys.filter((j) => j.outcome === 'scheduled').map((j) => j.runId);
    const idsB = b.legs[0]!.journeys.filter((j) => j.outcome === 'scheduled').map((j) => j.runId);
    for (const id of idsA) {
      expect(idsB).not.toContain(id);
    }
  });

  it('same trigger + DIFFERENT revisions concurrently → BOTH schedule (a new push is an independent logical event)', async () => {
    const stack = buildSchedulerStack();
    const [a, b] = await Promise.all([
      stack.scheduler.scheduleValidationTrigger(triggerInput({ revision: 'rev-1' })),
      stack.scheduler.scheduleValidationTrigger(triggerInput({ revision: 'rev-2' })),
    ]);
    expect(a.outcome).toBe('scheduled');
    expect(b.outcome).toBe('scheduled');
  });

  it('same project + DIFFERENT journeys concurrently → BOTH schedule (per-journey independence)', async () => {
    const stack = buildSchedulerStack();
    const [a, b] = await Promise.all([
      stack.scheduler.scheduleValidationTrigger(triggerInput({ affectedJourneyIds: ['journey-authenticated-dashboard'] })),
      stack.scheduler.scheduleValidationTrigger(triggerInput({ affectedJourneyIds: ['journey-safe-mutation-create-work-item'] })),
    ]);
    expect(a.outcome).toBe('scheduled');
    expect(b.outcome).toBe('scheduled');
    const aIds = a.legs[0]!.journeys.filter((j) => j.outcome === 'scheduled').map((j) => j.journeyId);
    const bIds = b.legs[0]!.journeys.filter((j) => j.outcome === 'scheduled').map((j) => j.journeyId);
    expect(aIds).toEqual(['journey-authenticated-dashboard']);
    expect(bIds).toEqual(['journey-safe-mutation-create-work-item']);
  });

  it('DISCRIMINATION — duplicate suppression is KEYED, not a global serialization: independent identities claim CONCURRENTLY', async () => {
    // Four DIFFERENT identities (two projects × two journeys) scheduled
    // concurrently ALL claim + admit — the claim store has NO global lock
    // (each key is an independent Map entry):
    const stack = buildSchedulerStack();
    const results = await Promise.all([
      stack.scheduler.scheduleValidationTrigger(triggerInput({ projectId: 'proj-A', affectedJourneyIds: ['journey-authenticated-dashboard'] })),
      stack.scheduler.scheduleValidationTrigger(triggerInput({ projectId: 'proj-B', affectedJourneyIds: ['journey-authenticated-dashboard'] })),
      stack.scheduler.scheduleValidationTrigger(triggerInput({ projectId: 'proj-A', affectedJourneyIds: ['journey-safe-mutation-create-work-item'] })),
      stack.scheduler.scheduleValidationTrigger(triggerInput({ projectId: 'proj-B', affectedJourneyIds: ['journey-safe-mutation-create-work-item'] })),
    ]);
    for (const r of results) {
      expect(r.outcome, 'an independent identity must not be suppressed or blocked by any other').toBe('scheduled');
    }
    // 4 logical validations, all distinct:
    const allRunIds = results.flatMap((r) => r.legs[0]!.journeys.filter((j) => j.outcome === 'scheduled').map((j) => j.runId));
    expect(new Set(allRunIds).size).toBe(4);
  });
});

describe('WORK-066 concurrency — the CONTINUOUS concurrent scheduler decisions', () => {
  it('two concurrent actors evaluating the SAME scheduled window → ONE validation for that window', async () => {
    const stack = buildSchedulerStack();
    const input = triggerInput({
      trigger: 'SCHEDULED',
      // STANDARD respects the affected scoping (CRITICAL selects the full
      // suite — covered by the multi-journey interleaving test above):
      assurance: 'STANDARD',
      affectedJourneyIds: ['journey-authenticated-dashboard'],
      continuous: { projectId: 'proj-1', environmentId: productionEnvironment.id, intervalMs: 60 * 60 * 1000 },
    });
    const [a, b] = await Promise.all([
      stack.scheduler.scheduleValidationTrigger(input),
      stack.scheduler.scheduleValidationTrigger(input),
    ]);
    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(['duplicate', 'scheduled']);
  });

  it('two DIFFERENT windows (the next cadence step) → independent validations (no window starvation)', async () => {
    const stack = buildSchedulerStack();
    const interval = 60 * 60 * 1000;
    const window8 = triggerInput({
      trigger: 'SCHEDULED',
      assurance: 'CRITICAL',
      continuous: { projectId: 'proj-1', environmentId: productionEnvironment.id, intervalMs: interval },
      now: (): Date => new Date(8 * interval + 1000),
    });
    const window9 = triggerInput({
      trigger: 'SCHEDULED',
      assurance: 'CRITICAL',
      continuous: { projectId: 'proj-1', environmentId: productionEnvironment.id, intervalMs: interval },
      now: (): Date => new Date(9 * interval + 1000),
    });
    const [a, b] = await Promise.all([stack.scheduler.scheduleValidationTrigger(window8), stack.scheduler.scheduleValidationTrigger(window9)]);
    expect(a.outcome).toBe('scheduled');
    expect(b.outcome).toBe('scheduled');
    expect(a.legs[0]!.reference).not.toBe(b.legs[0]!.reference);
  });
});

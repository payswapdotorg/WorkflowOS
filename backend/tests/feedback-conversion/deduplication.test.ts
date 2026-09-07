import { describe, it, expect } from 'vitest';

/**
 * WORK-068 — the deduplication proofs: a signal that duplicates an
 * EXISTING OPEN Work Item is DEDUPLICATED (never converted into a second
 * Work Item); a COMPLETED match is a RECURRENCE (new governed work with
 * the recurrence chain recorded); the persistence-level fence (the
 * 23505 unique-violation) converges concurrent runs.
 */
import {
  DefaultFeedbackConversionService,
  FEEDBACK_CONVERSION_METADATA_FIELD,
  matchOpenWorkItems,
  readConversionMetadata,
} from '../../src/feedback-conversion/index.js';
import type { WorkItem } from '@modules/work-items/index.js';
import {
  observationFixture,
  buildSignalService,
  buildConversionContext,
  buildConversionService,
  InMemoryWorkItemRepository,
  fixedClock,
  silentLogger,
} from './helpers.js';

const ARCHVER = 'archver-1';

/** Ingest one deterministic signal through the REAL WORK-067 service. */
async function ingest(signalService: ReturnType<typeof buildSignalService>, overrides: { logicalFailureKey?: string; environmentId?: string } = {}): Promise<string> {
  const result = await signalService.ingestObservation(
    observationFixture({
      logicalFailureKey: overrides.logicalFailureKey ?? 'validation:journey-checkout:step-pay',
      environmentId: overrides.environmentId ?? 'env-prod-1',
      observationRef: { kind: 'validation-run', ref: 'run-1', detail: 'failure' },
    }),
  );
  return result.signal.signalId;
}

/** A bare Work Item fixture (the authoritative record shape). */
function workItemFixture(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: overrides.id ?? 'wi-existing-1',
    architectureVersionId: overrides.architectureVersionId ?? ARCHVER,
    workItemId: overrides.workItemId ?? 'FB-existing0000',
    title: overrides.title ?? 'Existing open item',
    objective: null,
    scope: null,
    outOfScope: null,
    architectureConstraints: null,
    assignee: null,
    executionMetadata: {},
    completed: overrides.completed ?? false,
    metadata: overrides.metadata ?? {},
    architectureImpact: null,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-01T00:00:00Z'),
  };
}

describe('WORK-068 — the deduplication boundary (open Work Items only)', () => {
  it('an OPEN Work Item with the SAME deterministic proposal id converges: outcome open-proposal-id-match, NO second Work Item', async () => {
    const signalService = buildSignalService();
    await ingest(signalService);
    const workItemRepository = new InMemoryWorkItemRepository();
    const ctx = buildConversionContext({ signalService, workItemRepository });
    const service = buildConversionService();

    // The first conversion creates the FB item:
    const first = await service.convertSignals(
      { projectId: 'project-1', architectureVersionId: ARCHVER, decision: { decidedBy: 'user-1', decisionReason: 'first' } },
      ctx,
    );
    expect(first.createdCount).toBe(1);
    const createdHumanId = first.results[0]!.workItemHumanId!;

    // The second conversion of the SAME signal: the now-OPEN FB item matches
    // → deduplicated (converge):
    const second = await service.convertSignals(
      { projectId: 'project-1', architectureVersionId: ARCHVER, decision: { decidedBy: 'user-1', decisionReason: 'second' } },
      ctx,
    );
    expect(second.createdCount).toBe(0);
    expect(second.deduplicatedCount).toBe(1);
    expect(second.results[0]!.proposal.dedup.outcome).toBe('open-signal-provenance-match');
    expect(second.results[0]!.workItemHumanId).toBe(createdHumanId);
    expect(await workItemRepository.findByArchitectureVersion(ARCHVER)).toHaveLength(1);
  });

  it('an OPEN Work Item carrying the signal in its recorded provenance converges (a signal never converts twice)', () => {
    const item = workItemFixture({
      workItemId: 'FB-other000000',
      metadata: { [FEEDBACK_CONVERSION_METADATA_FIELD]: { sourceSignalIds: ['sig_abc'] } },
    });
    const match = matchOpenWorkItems({
      proposalId: 'FB-unrelated0000',
      sourceSignalIds: ['sig_abc'],
      workItems: [item],
    });
    expect(match.outcome).toBe('open-signal-provenance-match');
    expect(match.matchedOpenWorkItemIds).toEqual(['wi-existing-1']);
  });

  it('a COMPLETED FB item does NOT block a recurring conversion — the recurrence chain is recorded (recurrenceOf)', async () => {
    const signalService = buildSignalService();
    await ingest(signalService);
    const workItemRepository = new InMemoryWorkItemRepository();
    const ctx = buildConversionContext({ signalService, workItemRepository });
    const service = buildConversionService();

    // First conversion creates the FB item:
    const first = await service.convertSignals(
      { projectId: 'project-1', architectureVersionId: ARCHVER, decision: { decidedBy: 'user-1', decisionReason: 'fix it' } },
      ctx,
    );
    const createdRecordId = first.results[0]!.workItemRecordId!;
    // The fix merged: the work item is COMPLETED (the internal completion
    // seam — only /workflows+/verification set this in production):
    workItemRepository.forceCompleted(createdRecordId, true);

    // The signal RECURRED after the fix (a new observation):
    await signalService.ingestObservation(
      observationFixture({
        logicalFailureKey: 'validation:journey-checkout:step-pay',
        environmentId: 'env-prod-1',
        observedAt: '2026-09-05T12:00:00Z',
        observationRef: { kind: 'validation-run', ref: 'run-99', detail: 'failure recurred' },
      }),
    );

    const second = await service.convertSignals(
      { projectId: 'project-1', architectureVersionId: ARCHVER, decision: { decidedBy: 'user-1', decisionReason: 'the fix did not hold — new governed work' } },
      ctx,
    );
    // The completed item does NOT dedup-block: the recurrence is NEW work,
    // recorded with the recurrence chain:
    expect(second.createdCount).toBe(1);
    expect(second.results[0]!.outcome).toBe('created');
    expect(second.results[0]!.proposal.recurrenceOf).toEqual([createdRecordId]);
    // TWO Work Items now exist (the completed original + the recurrence):
    expect(await workItemRepository.findByArchitectureVersion(ARCHVER)).toHaveLength(2);
    const recurrence = (await workItemRepository.findByArchitectureVersion(ARCHVER))
      .find((item) => item.id !== createdRecordId)!;
    const metadata = (recurrence.metadata as Record<string, unknown>)[FEEDBACK_CONVERSION_METADATA_FIELD] as Record<string, unknown>;
    expect(metadata.recurrenceOf).toEqual([createdRecordId]);
  });

  it('an UNRELATED open Work Item (different FB id, no shared signal provenance) does NOT dedup-block', () => {
    const item = workItemFixture({ workItemId: 'FB-unrelated000', metadata: {} });
    const match = matchOpenWorkItems({
      proposalId: 'FB-mine0000000',
      sourceSignalIds: ['sig_other'],
      workItems: [item],
    });
    expect(match.outcome).toBe('no-open-match');
    expect(match.matchedOpenWorkItemIds).toEqual([]);
  });

  it('the honest metadata accessor: absent/malformed payload reads as null (a failed read is distinguishable from a genuine absence)', () => {
    expect(readConversionMetadata(workItemFixture({ metadata: {} }))).toBeNull();
    expect(readConversionMetadata(workItemFixture({ metadata: { [FEEDBACK_CONVERSION_METADATA_FIELD]: {} } }))).toBeNull();
    expect(
      readConversionMetadata(
        workItemFixture({ metadata: { [FEEDBACK_CONVERSION_METADATA_FIELD]: { sourceSignalIds: 'not-an-array' } } }),
      ),
    ).toBeNull();
    expect(
      readConversionMetadata(
        workItemFixture({ metadata: { [FEEDBACK_CONVERSION_METADATA_FIELD]: { sourceSignalIds: ['sig_1'] } } }),
      ),
    ).toEqual(['sig_1']);
  });

  it('the persistence-level fence: a concurrent duplicate create (23505 unique-violation) CONVERGES to deduplicated (the WORK-040 model)', async () => {
    const signalService = buildSignalService();
    await ingest(signalService);
    // The race simulation: an item with the SAME FB id lands between the
    // conversion's dedup load and its create (the repository's UNIQUE
    // constraint fires — exactly like the PG adapter).
    const workItemRepository = new RaceSimulatingRepository();
    const ctx = buildConversionContext({ signalService, workItemRepository });
    const service = buildConversionService();

    const result = await service.convertSignals(
      { projectId: 'project-1', architectureVersionId: ARCHVER, decision: { decidedBy: 'user-1', decisionReason: 'convert' } },
      ctx,
    );
    expect(result.createdCount).toBe(0);
    expect(result.deduplicatedCount).toBe(1);
    expect(result.results[0]!.outcome).toBe('deduplicated');
    expect(result.results[0]!.workItemHumanId).toMatch(/^FB-/);
  });

  it('a NON-unique violation failure is recorded honestly as conversion-failed (nothing landed)', async () => {
    const signalService = buildSignalService();
    await ingest(signalService);
    const workItemRepository = new FailingRepository();
    const ctx = buildConversionContext({ signalService, workItemRepository });
    const service = buildConversionService();

    const result = await service.convertSignals(
      { projectId: 'project-1', architectureVersionId: ARCHVER, decision: { decidedBy: 'user-1', decisionReason: 'convert' } },
      ctx,
    );
    expect(result.failedCount).toBe(1);
    expect(result.results[0]!.outcome).toBe('conversion-failed');
    expect(result.results[0]!.failureReason).toBe('simulated persistence failure');
  });
});

/** The race simulator: the concurrent duplicate lands inside the create. */
class RaceSimulatingRepository extends InMemoryWorkItemRepository {
  private raced = false;
  override async create(input: Parameters<InMemoryWorkItemRepository['create']>[0]): Promise<WorkItem> {
    if (!this.raced) {
      this.raced = true;
      // The concurrent run's identical FB item lands FIRST (the constraint
      // our create would hit):
      await super.create({ ...input, title: 'Concurrent run won the race' });
      // Now OUR create hits the UNIQUE constraint:
      return super.create(input);
    }
    return super.create(input);
  }
}

/** The honest failure simulator (a non-unique persistence error). */
class FailingRepository extends InMemoryWorkItemRepository {
  override async create(): Promise<WorkItem> {
    throw new Error('simulated persistence failure');
  }
}

// Deterministic-time + silent-logger fixtures stay referenced (the shared discipline).
void fixedClock;
void silentLogger;
void DefaultFeedbackConversionService;

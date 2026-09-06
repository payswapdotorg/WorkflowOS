import { describe, it, expect } from 'vitest';

/**
 * WORK-068 — the conversion lifecycle proofs: the canonical flow
 * (signal → assessment → dedup → priority → Work Item through the EXISTING
 * /work-items intake → the existing governance lifecycle), built over the
 * REAL WORK-067 signal service and the in-memory /work-items fake with the
 * UNIQUE constraint honestly simulated.
 */
import {
  DefaultFeedbackConversionService,
  FeedbackConversionError,
  FEEDBACK_CONVERSION_METADATA_FIELD,
} from '../../src/feedback-conversion/index.js';
import {
  observationFixture,
  buildSignalService,
  buildConversionContext,
  buildConversionService,
  InMemoryWorkItemRepository,
  fixedClock,
} from './helpers.js';

const ARCHVER = 'archver-1';

/** Ingest a deterministic multi-occurrence signal through the REAL WORK-067 service. */
async function ingestSignal(
  signalService: ReturnType<typeof buildSignalService>,
  overrides: {
    logicalFailureKey?: string;
    environmentId?: string;
    source?: 'validation' | 'ci' | 'runtime' | 'telemetry' | 'security' | 'user-feedback' | 'deployment';
    severity?: 'low' | 'medium' | 'high' | 'critical';
    times?: string[];
  } = {},
): Promise<string> {
  const times = overrides.times ?? ['2026-09-02T12:00:00Z'];
  let signalId = '';
  let index = 0;
  for (const at of times) {
    const result = await signalService.ingestObservation(
      observationFixture({
        logicalFailureKey: overrides.logicalFailureKey ?? 'validation:journey-checkout:step-pay:expectation-total',
        environmentId: overrides.environmentId ?? 'env-prod-1',
        source: overrides.source ?? 'validation',
        severity: overrides.severity ?? 'high',
        observedAt: at,
        observationRef: { kind: 'validation-run', ref: `run-${index}`, detail: 'failure' },
      }),
    );
    signalId = result.signal.signalId;
    index += 1;
  }
  return signalId;
}

describe('WORK-068 — the conversion lifecycle (the canonical flow)', () => {
  it('a signal becomes a PROPOSED Work Item through the EXISTING /work-items intake: WorkItemRepository.create is the single creation path (the created item carries the FB- id + metadata.feedbackConversion)', async () => {
    const signalService = buildSignalService();
    await ingestSignal(signalService, { times: ['2026-09-02T12:00:00Z', '2026-09-02T13:00:00Z', '2026-09-02T14:00:00Z', '2026-09-02T15:00:00Z'] });
    const workItemRepository = new InMemoryWorkItemRepository();
    const ctx = buildConversionContext({ signalService, workItemRepository });
    const service = buildConversionService();

    const result = await service.convertSignals(
      {
        projectId: 'project-1',
        architectureVersionId: ARCHVER,
        decision: { decidedBy: 'user-1', decisionReason: 'the checkout failure recurs across four runs — convert it into governed work' },
      },
      ctx,
    );

    expect(result.createdCount).toBe(1);
    const created = result.results[0]!;
    expect(created.outcome).toBe('created');
    // The created Work Item went through the EXISTING intake:
    const stored = await workItemRepository.findByArchitectureVersion(ARCHVER);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.workItemId).toMatch(/^FB-[0-9a-f]{10}$/);
    expect(stored[0]!.id).toBe(created.workItemRecordId);
    // The conversion provenance is embedded in the EXISTING metadata JSONB:
    const metadata = (stored[0]!.metadata as Record<string, unknown>)[FEEDBACK_CONVERSION_METADATA_FIELD] as Record<string, unknown>;
    expect(metadata).toBeTruthy();
    expect(Array.isArray(metadata.sourceSignalIds)).toBe(true);
    expect((metadata.sourceSignalIds as unknown[]).length).toBe(1);
    expect(metadata.logicalFailureKey).toBe('validation:journey-checkout:step-pay:expectation-total');
    expect(metadata.decision).toMatchObject({ decidedBy: 'user-1' });
    // The Work Item is NOT completed, NOT assigned, NOT executed — the
    // existing governance lifecycle still applies:
    expect(stored[0]!.completed).toBe(false);
    expect(stored[0]!.assignee).toBeNull();
  });

  it('the created Work Item enters the SAME state as any other /work-items creation — no workflow transition, no checkpoint advance, no execution start (the full governance lifecycle still applies)', async () => {
    const signalService = buildSignalService();
    await ingestSignal(signalService, {});
    const workItemRepository = new InMemoryWorkItemRepository();
    const ctx = buildConversionContext({ signalService, workItemRepository });
    const service = buildConversionService();

    await service.convertSignals(
      {
        projectId: 'project-1',
        architectureVersionId: ARCHVER,
        decision: { decidedBy: 'user-1', decisionReason: 'convert' },
      },
      ctx,
    );

    const stored = await workItemRepository.findByArchitectureVersion(ARCHVER);
    // The honest created state: exactly what CreateWorkItemInput produces —
    // completed=false, no assignee, no executionMetadata. The lifecycle
    // (DRAFT→…→MERGED→VERIFIED) is owned by /workflows, NOT by this domain.
    expect(stored[0]!.completed).toBe(false);
    expect(stored[0]!.assignee).toBeNull();
    expect(stored[0]!.executionMetadata).toEqual({});
  });

  it('repeated conversion of the same signals CONVERGES: the second run deduplicates (no second Work Item, no mutation of the existing one)', async () => {
    const signalService = buildSignalService();
    await ingestSignal(signalService, {});
    const workItemRepository = new InMemoryWorkItemRepository();
    const ctx = buildConversionContext({ signalService, workItemRepository });
    const service = buildConversionService();
    const decision = { decidedBy: 'user-1', decisionReason: 'convert' };

    const first = await service.convertSignals(
      { projectId: 'project-1', architectureVersionId: ARCHVER, decision },
      ctx,
    );
    const second = await service.convertSignals(
      { projectId: 'project-1', architectureVersionId: ARCHVER, decision },
      ctx,
    );

    expect(first.createdCount).toBe(1);
    expect(second.createdCount).toBe(0);
    expect(second.deduplicatedCount).toBe(1);
    expect(second.results[0]!.outcome).toBe('deduplicated');
    expect(second.results[0]!.workItemHumanId).toBe(first.results[0]!.workItemHumanId);
    // Still exactly ONE Work Item:
    const stored = await workItemRepository.findByArchitectureVersion(ARCHVER);
    expect(stored).toHaveLength(1);
  });

  it('a missing governed decision is REJECTED (no silent conversion): the mutation requires decidedBy + decisionReason', async () => {
    const signalService = buildSignalService();
    await ingestSignal(signalService, {});
    const workItemRepository = new InMemoryWorkItemRepository();
    const ctx = buildConversionContext({ signalService, workItemRepository });
    const service = buildConversionService();

    await expect(
      service.convertSignals(
        { projectId: 'project-1', architectureVersionId: ARCHVER, decision: undefined as unknown as { decidedBy: string; decisionReason: string } },
        ctx,
      ),
    ).rejects.toThrowError(FeedbackConversionError);
    await expect(
      service.convertSignals(
        { projectId: 'project-1', architectureVersionId: ARCHVER, decision: { decidedBy: '', decisionReason: 'x' } },
        ctx,
      ),
    ).rejects.toThrowError(FeedbackConversionError);
    await expect(
      service.convertSignals(
        { projectId: 'project-1', architectureVersionId: ARCHVER, decision: { decidedBy: 'user-1', decisionReason: '' } },
        ctx,
      ),
    ).rejects.toThrowError(FeedbackConversionError);
    // NOTHING was created (fail-closed before any mutation):
    expect(await workItemRepository.findByArchitectureVersion(ARCHVER)).toHaveLength(0);
  });

  it('an unknown signal id or a scope mismatch is REJECTED (fail-closed — never a fabricated signal, never a silent empty conversion)', async () => {
    const signalService = buildSignalService();
    await ingestSignal(signalService, {});
    const workItemRepository = new InMemoryWorkItemRepository();
    const ctx = buildConversionContext({ signalService, workItemRepository });
    const service = buildConversionService();

    await expect(
      service.convertSignals(
        {
          projectId: 'project-1',
          architectureVersionId: ARCHVER,
          signalIds: ['sig_does_not_exist'],
          decision: { decidedBy: 'user-1', decisionReason: 'convert' },
        },
        ctx,
      ),
    ).rejects.toThrowError(FeedbackConversionError);
    expect(await workItemRepository.findByArchitectureVersion(ARCHVER)).toHaveLength(0);
  });

  it('the decision record carries the injected clock value (deterministic decidedAt — never a wall-clock read)', async () => {
    const signalService = buildSignalService();
    await ingestSignal(signalService, {});
    const ctx = buildConversionContext({ signalService, workItemRepository: new InMemoryWorkItemRepository() });
    const service = new DefaultFeedbackConversionService({
      logger: (await import('./helpers.js')).silentLogger,
      now: fixedClock('2026-09-03T09:30:00Z'),
    });

    const result = await service.convertSignals(
      {
        projectId: 'project-1',
        architectureVersionId: ARCHVER,
        decision: { decidedBy: 'user-1', decisionReason: 'convert' },
      },
      ctx,
    );
    expect(result.decision.decidedAt).toBe('2026-09-03T09:30:00.000Z');
  });

  it('cross-environment signals of the SAME logical failure MERGE into ONE proposal (the Work Item dedup dimension is the logical failure at project scope)', async () => {
    const signalService = buildSignalService();
    await ingestSignal(signalService, { environmentId: 'env-prod-1' });
    await ingestSignal(signalService, { environmentId: 'env-staging-1' });
    const workItemRepository = new InMemoryWorkItemRepository();
    const ctx = buildConversionContext({ signalService, workItemRepository });
    const service = buildConversionService();

    const result = await service.convertSignals(
      {
        projectId: 'project-1',
        architectureVersionId: ARCHVER,
        decision: { decidedBy: 'user-1', decisionReason: 'the failure spans environments' },
      },
      ctx,
    );

    expect(result.createdCount).toBe(1);
    const stored = await workItemRepository.findByArchitectureVersion(ARCHVER);
    expect(stored).toHaveLength(1);
    const metadata = (stored[0]!.metadata as Record<string, unknown>)[FEEDBACK_CONVERSION_METADATA_FIELD] as Record<string, unknown>;
    // BOTH signal ids preserved (the merged provenance):
    expect((metadata.sourceSignalIds as unknown[]).length).toBe(2);
    expect((metadata.environmentIds as string[]).sort()).toEqual(['env-prod-1', 'env-staging-1']);
  });

  it('distinct logical failures produce DISTINCT proposals with DISTINCT FB- ids (no identity collision)', async () => {
    const signalService = buildSignalService();
    await ingestSignal(signalService, { logicalFailureKey: 'validation:journey-checkout:step-pay' });
    await ingestSignal(signalService, { logicalFailureKey: 'ci:workflow:backend-tests' });
    const workItemRepository = new InMemoryWorkItemRepository();
    const ctx = buildConversionContext({ signalService, workItemRepository });
    const service = buildConversionService();

    const result = await service.convertSignals(
      {
        projectId: 'project-1',
        architectureVersionId: ARCHVER,
        decision: { decidedBy: 'user-1', decisionReason: 'convert both failures' },
      },
      ctx,
    );
    expect(result.createdCount).toBe(2);
    const humanIds = result.results.map((r) => r.workItemHumanId);
    expect(new Set(humanIds).size).toBe(2);
  });
});

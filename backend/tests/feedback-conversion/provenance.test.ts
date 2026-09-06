import { describe, it, expect } from 'vitest';

/**
 * WORK-068 — the provenance-preservation proofs: every proposal records
 * its originating signal(s); the created Work Item's metadata carries the
 * full reconstructable signal→Work-Item chain (signal ids, sources,
 * environments, occurrence references — never reduced to a hash).
 */
import {
  FEEDBACK_CONVERSION_METADATA_FIELD,
  type FeedbackConversionMetadataPayload,
} from '../../src/feedback-conversion/index.js';
import {
  observationFixture,
  buildSignalService,
  buildConversionContext,
  buildConversionService,
  InMemoryWorkItemRepository,
} from './helpers.js';
import type { WorkItem } from '@modules/work-items/index.js';

const ARCHVER = 'archver-1';

/** Read the conversion metadata off a created Work Item (the typed accessor). */
function conversionMetadataOf(item: WorkItem): FeedbackConversionMetadataPayload {
  return (item.metadata as Record<string, unknown>)[FEEDBACK_CONVERSION_METADATA_FIELD] as FeedbackConversionMetadataPayload;
}

describe('WORK-068 — the provenance chain (signal → Work Item)', () => {
  it('every created Work Item carries its originating signal id + logicalFailureKey + sources + environments (no free-floating proposals)', async () => {
    const signalService = buildSignalService();
    const result = await signalService.ingestObservation(observationFixture({}));
    const signalId = result.signal.signalId;

    const workItemRepository = new InMemoryWorkItemRepository();
    const ctx = buildConversionContext({ signalService, workItemRepository });
    const service = buildConversionService();

    const conversion = await service.convertSignals(
      { projectId: 'project-1', architectureVersionId: ARCHVER, decision: { decidedBy: 'user-1', decisionReason: 'convert' } },
      ctx,
    );
    expect(conversion.createdCount).toBe(1);

    const stored = await workItemRepository.findByArchitectureVersion(ARCHVER);
    const metadata = conversionMetadataOf(stored[0]!);
    expect(metadata.sourceSignalIds).toEqual([signalId]);
    expect(metadata.logicalFailureKey).toBe('validation:journey-checkout:step-pay:expectation-total');
    expect(metadata.sourceSources).toEqual(['validation']);
    expect(metadata.environmentIds).toEqual(['env-prod-1']);
  });

  it('the occurrence provenance preserves the RAW observation references VERBATIM (each entry: the occurrence id + source + observedAt + observationRef — never reduced to a hash)', async () => {
    const signalService = buildSignalService();
    const first = await signalService.ingestObservation(
      observationFixture({ observationRef: { kind: 'validation-run', ref: 'run-1', detail: 'failure at step-pay' } }),
    );
    const second = await signalService.ingestObservation(
      observationFixture({
        observedAt: '2026-09-02T13:00:00Z',
        observationRef: { kind: 'validation-run', ref: 'run-2', detail: 'failure at step-pay again' },
      }),
    );
    expect(second.outcome).toBe('occurrence-appended');
    expect(second.signal.signalId).toBe(first.signal.signalId);

    const workItemRepository = new InMemoryWorkItemRepository();
    const ctx = buildConversionContext({ signalService, workItemRepository });
    const service = buildConversionService();

    await service.convertSignals(
      { projectId: 'project-1', architectureVersionId: ARCHVER, decision: { decidedBy: 'user-1', decisionReason: 'convert' } },
      ctx,
    );

    const stored = await workItemRepository.findByArchitectureVersion(ARCHVER);
    const metadata = conversionMetadataOf(stored[0]!);
    expect(metadata.occurrenceProvenance).toHaveLength(2);
    const refs = metadata.occurrenceProvenance.map((entry) => entry.observationRef);
    expect(refs).toEqual([
      { kind: 'validation-run', ref: 'run-1', detail: 'failure at step-pay' },
      { kind: 'validation-run', ref: 'run-2', detail: 'failure at step-pay again' },
    ]);
    expect(metadata.occurrenceCount).toBe(2);
  });

  it('the governed decision is embedded (decidedBy + decisionReason + decidedAt — the governance trail)', async () => {
    const signalService = buildSignalService();
    await signalService.ingestObservation(observationFixture({}));
    const workItemRepository = new InMemoryWorkItemRepository();
    const ctx = buildConversionContext({ signalService, workItemRepository });
    const service = buildConversionService('2026-09-03T08:00:00Z');

    await service.convertSignals(
      {
        projectId: 'project-1',
        architectureVersionId: ARCHVER,
        decision: { decidedBy: 'user-42', decisionReason: 'the payment step keeps failing — the team decided to convert it' },
      },
      ctx,
    );

    const stored = await workItemRepository.findByArchitectureVersion(ARCHVER);
    const metadata = conversionMetadataOf(stored[0]!);
    expect(metadata.decision).toEqual({
      decidedBy: 'user-42',
      decisionReason: 'the payment step keeps failing — the team decided to convert it',
      decidedAt: '2026-09-03T08:00:00.000Z',
    });
  });

  it('the advisory regression evidence is recorded VERBATIM — never promoted to a verdict, never dropped', async () => {
    const signalService = buildSignalService();
    // Absent-before + present-after → the WORK-067 advisory assessment:
    await signalService.ingestObservation(
      observationFixture({ observedAt: '2026-09-02T12:30:00Z', releaseRef: 'release-2026.09.02' }),
    );
    const signals = await signalService.listSignalsForProject('project-1');
    const correlated = await signalService.correlateToReleases({
      signalId: signals[0]!.signalId,
      releaseContexts: [
        { releaseRef: 'release-2026.09.02', releasedAt: '2026-09-02T12:00:00Z', projectId: 'project-1', recordedVia: 'caller-declared' },
      ],
    });
    expect(correlated.regression.likelyRegression).toBe(true);

    const workItemRepository = new InMemoryWorkItemRepository();
    const ctx = buildConversionContext({ signalService, workItemRepository });
    const service = buildConversionService();
    await service.convertSignals(
      { projectId: 'project-1', architectureVersionId: ARCHVER, decision: { decidedBy: 'user-1', decisionReason: 'convert' } },
      ctx,
    );

    const stored = await workItemRepository.findByArchitectureVersion(ARCHVER);
    const metadata = conversionMetadataOf(stored[0]!);
    expect(metadata.regressionOutcomes).toEqual([
      { signalId: signals[0]!.signalId, environmentId: 'env-prod-1', likelyRegression: true },
    ]);
  });

  it('the assessment, priority, backlog context, and dedup key are embedded (the full derivation record)', async () => {
    const signalService = buildSignalService();
    await signalService.ingestObservation(observationFixture({}));
    const workItemRepository = new InMemoryWorkItemRepository();
    const ctx = buildConversionContext({ signalService, workItemRepository });
    const service = buildConversionService();

    await service.convertSignals(
      { projectId: 'project-1', architectureVersionId: ARCHVER, decision: { decidedBy: 'user-1', decisionReason: 'convert' } },
      ctx,
    );

    const stored = await workItemRepository.findByArchitectureVersion(ARCHVER);
    const metadata = conversionMetadataOf(stored[0]!);
    expect(metadata.assessment).toBeTruthy();
    expect(metadata.assessment.blastRadius.band).toBe('narrow');
    expect(metadata.priority).toBe('medium');
    expect(Array.isArray(metadata.priorityFactors)).toBe(true);
    expect(metadata.backlogContext).toMatchObject({ openWorkItemCount: 0, rankAmongAssessedProposals: 1, assessedProposalCount: 1 });
    expect(metadata.dedupKey).toMatch(/^FB-[0-9a-f]{10}$/);
    expect(metadata.conversionVersion).toBe('WORK-068/1.0.0');
    expect(stored[0]!.architectureImpact).toBe('low');
  });

  it('the out-of-scope declaration preserves the WORK-068 boundary contract on the created Work Item (WORK-067/069/070 stay out of scope)', async () => {
    const signalService = buildSignalService();
    await signalService.ingestObservation(observationFixture({}));
    const workItemRepository = new InMemoryWorkItemRepository();
    const ctx = buildConversionContext({ signalService, workItemRepository });
    const service = buildConversionService();

    await service.convertSignals(
      { projectId: 'project-1', architectureVersionId: ARCHVER, decision: { decidedBy: 'user-1', decisionReason: 'convert' } },
      ctx,
    );

    const stored = await workItemRepository.findByArchitectureVersion(ARCHVER);
    expect(stored[0]!.outOfScope).toContain('WORK-067');
    expect(stored[0]!.outOfScope).toContain('WORK-069');
    expect(stored[0]!.outOfScope).toContain('WORK-070');
    // And the lifecycle boundary declaration:
    expect(stored[0]!.architectureConstraints).toContain('full governance lifecycle');
  });
});

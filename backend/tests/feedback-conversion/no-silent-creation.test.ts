import { describe, it, expect } from 'vitest';

/**
 * WORK-068 — the no-silent-creation + intake-boundary proofs:
 *
 *   * the READ surface (assessSignals) performs NO mutation of ANY
 *     authority (the mutation-detection seam: a recording repository
 *     wrapper proves the only possible writes target NOTHING);
 *   * the MUTATION surface structurally requires the governed decision
 *     (the service-contract pin: exactly two methods, both explicit);
 *   * the creation goes ONLY through WorkItemRepository.create (the
 *     single intake — no update, no completion, no dependency mutation,
 *     no workflow transition anywhere).
 */
import {
  DefaultFeedbackConversionService,
  type FeedbackConversionService,
} from '../../src/feedback-conversion/index.js';
import {
  observationFixture,
  buildSignalService,
  buildConversionContext,
  buildConversionService,
  InMemoryWorkItemRepository,
  RecordingWorkItemRepository,
  silentLogger,
} from './helpers.js';

const ARCHVER = 'archver-1';

describe('WORK-068 — the no-silent-autonomous-creation boundary', () => {
  it('the service contract exposes EXACTLY two methods (assessSignals + convertSignals) — no scheduling, no ingestion, no workflow/verification/review/execution surface', () => {
    const service: FeedbackConversionService = new DefaultFeedbackConversionService({
      logger: silentLogger,
      now: () => new Date('2026-09-03T00:00:00Z'),
    });
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(service))
      .filter((name) => name !== 'constructor')
      .sort();
    expect(methods).toEqual(['assessSignals', 'convertSignals']);
    const forbidden = [
      'transition', 'createWorkflow', 'approveReview', 'mergePullRequest', 'createPullRequest',
      'attachEvidence', 'createRun', 'evaluateCriterion', 'writeFile', 'mutateArchitecture',
      'recordEvidence', 'verify', 'schedule', 'enqueue', 'ingestObservation', 'ingestSignal',
      'startImplementation', 'markCompleted', 'update', 'addDependency',
    ];
    for (const verb of forbidden) {
      expect(methods.some((m) => m.toLowerCase().includes(verb.toLowerCase()))).toBe(false);
    }
  });

  it('assessSignals is READ-ONLY: the recording repository wrapper records ZERO create/update calls (a read-authorized caller can NEVER trigger a mutation)', async () => {
    const signalService = buildSignalService();
    await signalService.ingestObservation(observationFixture({}));
    const recording = new RecordingWorkItemRepository(new InMemoryWorkItemRepository());
    const ctx = buildConversionContext({ signalService, workItemRepository: recording });
    const service = buildConversionService();

    const assessment = await service.assessSignals(
      { projectId: 'project-1', architectureVersionId: ARCHVER },
      ctx,
    );

    // The assessment derived the proposal (with its dedup + priority)…
    expect(assessment.proposals).toHaveLength(1);
    expect(assessment.proposals[0]!.priority).toBeTruthy();
    // …but NOTHING was created (the journal stays empty — the only mutation
    // seam records zero calls):
    expect(recording.journal).toEqual([]);
    expect(await recording.findByArchitectureVersion(ARCHVER)).toHaveLength(0);
    // And the signal store is untouched (listSignalsForProject is read-only):
    expect((await signalService.listSignalsForProject('project-1'))).toHaveLength(1);
  });

  it('the conversion mutation ALWAYS re-derives the assessment: the created Work Item embedded assessment matches the read-only assessment derivation (assessment can never be skipped in the mutation path)', async () => {
    const signalService = buildSignalService();
    await signalService.ingestObservation(
      observationFixture({ observedAt: '2026-09-02T12:00:00Z' }),
    );
    await signalService.ingestObservation(
      observationFixture({ observedAt: '2026-09-02T13:00:00Z', observationRef: { kind: 'validation-run', ref: 'run-2', detail: 'again' } }),
    );
    const workItemRepository = new InMemoryWorkItemRepository();
    const ctx = buildConversionContext({ signalService, workItemRepository });
    const service = buildConversionService();

    const assessment = await service.assessSignals(
      { projectId: 'project-1', architectureVersionId: ARCHVER },
      ctx,
    );
    const conversion = await service.convertSignals(
      { projectId: 'project-1', architectureVersionId: ARCHVER, decision: { decidedBy: 'user-1', decisionReason: 'convert' } },
      ctx,
    );

    // The conversion's proposal IS the assessed proposal (re-derived
    // identically — the mutation path includes assessment by construction):
    expect(conversion.results[0]!.proposal.assessment).toEqual(assessment.proposals[0]!.assessment);
    expect(conversion.results[0]!.proposal.priority).toBe(assessment.proposals[0]!.priority);
    expect(conversion.results[0]!.proposal.identity.proposalId).toBe(assessment.proposals[0]!.identity.proposalId);
  });

  it('a signal NEVER autonomously becomes a Work Item: nothing ingests → nothing converts (no scheduler, no hook, no autonomous loop — conversion happens ONLY at the explicit decision call)', async () => {
    const signalService = buildSignalService();
    // Signals EXIST (recorded through the WORK-067 authority)…
    await signalService.ingestObservation(observationFixture({}));
    const workItemRepository = new InMemoryWorkItemRepository();
    buildConversionContext({ signalService, workItemRepository });

    // …but NO conversion decision is made. No amount of signal presence
    // creates a Work Item (there is no background drive — the ONLY mutation
    // entry point is the explicit convertSignals call):
    // (The signal service itself has no work-item surface at all — pinned
    // separately by the WORK-067 advisory-boundary suite.)
    const signals = await signalService.listSignalsForProject('project-1');
    expect(signals).toHaveLength(1);
    expect(await workItemRepository.findByArchitectureVersion(ARCHVER)).toHaveLength(0);
  });
});

describe('WORK-068 — the /work-items intake boundary (the single creation path)', () => {
  it('creation goes ONLY through WorkItemRepository.create: the journal records exactly the created inputs (no update / completion / dependency mutation anywhere)', async () => {
    const signalService = buildSignalService();
    await signalService.ingestObservation(observationFixture({}));
    const recording = new RecordingWorkItemRepository(new InMemoryWorkItemRepository());
    const ctx = buildConversionContext({ signalService, workItemRepository: recording });
    const service = buildConversionService();

    const result = await service.convertSignals(
      { projectId: 'project-1', architectureVersionId: ARCHVER, decision: { decidedBy: 'user-1', decisionReason: 'convert' } },
      ctx,
    );

    expect(result.createdCount).toBe(1);
    // Exactly ONE create call — the single intake:
    expect(recording.journal).toHaveLength(1);
    const createdInput = recording.journal[0]!;
    expect(createdInput.workItemId).toMatch(/^FB-[0-9a-f]{10}$/);
    expect(createdInput.architectureVersionId).toBe(ARCHVER);
    // No other mutation methods were called (the fake's state proves it —
    // the created item is exactly what the intake produced):
    const stored = await recording.findByArchitectureVersion(ARCHVER);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.completed).toBe(false);
  });

  it('the dedup convergence path performs NO create (the journal stays empty for an already-converted signal)', async () => {
    const signalService = buildSignalService();
    await signalService.ingestObservation(observationFixture({}));
    const recording = new RecordingWorkItemRepository(new InMemoryWorkItemRepository());
    const ctx = buildConversionContext({ signalService, workItemRepository: recording });
    const service = buildConversionService();
    const decision = { decidedBy: 'user-1', decisionReason: 'convert' };

    await service.convertSignals({ projectId: 'project-1', architectureVersionId: ARCHVER, decision }, ctx);
    expect(recording.journal).toHaveLength(1);

    await service.convertSignals({ projectId: 'project-1', architectureVersionId: ARCHVER, decision }, ctx);
    // The convergence performed NO second create:
    expect(recording.journal).toHaveLength(1);
  });
});

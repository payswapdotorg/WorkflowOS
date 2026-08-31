import { describe, it, expect } from 'vitest';

/**
 * WORK-067 — the provenance preservation proofs.
 *
 * Proof matrix §B: source preserved; raw observation preserved (reference
 * AND payload — never reduced to a hash); correlation reasoning preserved;
 * no free-floating signal. The full chain is reconstructable:
 *
 *   raw observation → signal → dedup → release correlation → regression
 *
 * The WHAT/WHERE/WHEN/WHY questions are answerable from the record alone.
 */
import { observationFixture, releaseContextFixture, buildService } from './helpers.js';

describe('WORK-067 — provenance preservation (the load-bearing invariant)', () => {
  it('the raw observation reference AND payload survive ingestion verbatim (never reduced to a hash)', async () => {
    const { service } = buildService();
    const raw = {
      failedStepId: 'step-pay',
      expected: { id: 'expectation-total', kind: 'persisted_record', description: 'cart total is persisted' },
      actual: null,
      provenance: { runId: 'run-1', journeyId: 'journey-checkout', stepId: 'step-pay', environmentId: 'env-prod-1' },
    };
    const { signal } = await service.ingestObservation(
      observationFixture({ raw, observationRef: { kind: 'validation-run', ref: 'run-1', detail: 'failure: step-pay' } }),
    );
    const occurrence = signal.occurrences[0]!;
    // The reference is preserved:
    expect(occurrence.observationRef).toEqual({ kind: 'validation-run', ref: 'run-1', detail: 'failure: step-pay' });
    // The raw payload is preserved VERBATIM (deep equality with the input):
    expect(occurrence.raw).toEqual(raw);
    // NOT reduced to a hash:
    expect(typeof occurrence.raw).toBe('object');
  });

  it('provenance survives the FULL chain: observation → dedup → release correlation → regression assessment (every stage preserves the references)', async () => {
    const { service } = buildService();
    const rawPre = { failedStepId: 'step-pay', kind: 'validation_failure', marker: 'PRE' };
    const rawPost = { failedStepId: 'step-pay', kind: 'validation_failure', marker: 'POST' };
    const first = await service.ingestObservation(
      observationFixture({
        raw: rawPre,
        observedAt: '2026-09-01T10:00:00Z',
        observationRef: { kind: 'validation-run', ref: 'run-1' },
      }),
    );
    const second = await service.ingestObservation(
      observationFixture({
        raw: rawPost,
        observedAt: '2026-09-01T14:00:00Z',
        observationRef: { kind: 'validation-run', ref: 'run-2' },
      }),
    );
    // DEDUP: one signal, both occurrences:
    expect(second.signal.signalId).toBe(first.signal.signalId);
    expect(second.signal.occurrences.map((o) => o.observationRef.ref).sort()).toEqual(['run-1', 'run-2']);

    // RELEASE CORRELATION + REGRESSION:
    const correlated = await service.correlateToReleases({
      signalId: first.signal.signalId,
      releaseContexts: [releaseContextFixture({ releasedAt: '2026-09-01T12:30:00Z' })],
    });
    // The occurrences are still fully preserved after correlation + assessment:
    expect(correlated.occurrences).toHaveLength(2);
    const byRef = new Map(correlated.occurrences.map((o) => [o.observationRef.ref, o]));
    expect(byRef.get('run-1')!.raw).toEqual(rawPre);
    expect(byRef.get('run-2')!.raw).toEqual(rawPost);
    // The assessment references the occurrence ids (the reconstructable chain):
    const assessment = correlated.regression.perRelease[0]!;
    expect([...assessment.beforeOccurrenceIds, ...assessment.afterOccurrenceIds].sort()).toEqual(
      correlated.occurrences.map((o) => o.occurrenceId).sort(),
    );
    // The severity evidence chain:
    expect(assessment.severityBefore).toBe('high');
    expect(assessment.severityAfter).toBe('high');
  });

  it('the convergence reasoning is recorded per occurrence (WHY this occurrence belongs to this signal)', async () => {
    const { service } = buildService();
    const { signal } = await service.ingestObservation(
      observationFixture({
        logicalFailureKey: 'validation:journey-checkout:step-pay:expectation-total',
        observedAt: '2026-09-01T12:00:00Z',
        observationRef: { kind: 'validation-run', ref: 'run-7' },
      }),
    );
    const reason = signal.occurrences[0]!.convergenceReason;
    expect(reason).toContain('validation:journey-checkout:step-pay:expectation-total');
    expect(reason).toContain("'validation' source");
    expect(reason).toContain('validation-run:run-7');
    expect(reason).toContain(signal.signalId);
  });

  it('the correlation reasoning is recorded per release (WHY correlated or WHY not)', async () => {
    const { service } = buildService();
    const { signal } = await service.ingestObservation(
      observationFixture({ releaseRef: 'release-A', observedAt: '2026-09-01T14:00:00Z' }),
    );
    const correlated = await service.correlateToReleases({
      signalId: signal.signalId,
      releaseContexts: [
        releaseContextFixture({ releaseRef: 'release-A', releasedAt: '2026-09-01T12:30:00Z' }),
        releaseContextFixture({ releaseRef: 'release-B', releasedAt: '2026-09-04T00:00:00Z' }),
      ],
    });
    const forA = correlated.releaseCorrelation.find((e) => e.releaseRef === 'release-A')!;
    const forB = correlated.releaseCorrelation.find((e) => e.releaseRef === 'release-B')!;
    expect(forA.reason).toContain("causal release reference 'release-A'");
    expect(forB.reason).toContain('REJECTED');
    // The assessment reasoning is explicit too:
    expect(correlated.regression.perRelease).toHaveLength(1);
    expect(correlated.regression.perRelease[0]!.reason).toContain('ABSENT before');
  });

  it('WHAT happened / WHERE it originated / WHEN / WHY correlated are all answerable from the record alone', async () => {
    const { service } = buildService();
    const { signal } = await service.ingestObservation(
      observationFixture({
        source: 'ci',
        logicalFailureKey: 'ci:workflow:backend-tests',
        observedAt: '2026-09-01T13:00:00Z',
        observationRef: { kind: 'ci-evidence', ref: 'wfos_github_ci_evidence:42' },
        raw: { workflowName: 'backend-tests', conclusion: 'failure' },
        severity: 'high',
      }),
    );
    const correlated = await service.correlateToReleases({
      signalId: signal.signalId,
      releaseContexts: [releaseContextFixture({ releasedAt: '2026-09-01T12:30:00Z' })],
    });
    const occurrence = correlated.occurrences[0]!;
    // WHAT: the logical failure + severity
    expect(correlated.logicalFailureKey).toBe('ci:workflow:backend-tests');
    expect(occurrence.severity).toBe('high');
    expect((occurrence.raw as { conclusion: string }).conclusion).toBe('failure');
    // WHERE it originated: the source + the authority reference
    expect(occurrence.source).toBe('ci');
    expect(occurrence.observationRef).toEqual({ kind: 'ci-evidence', ref: 'wfos_github_ci_evidence:42' });
    // WHEN: the recorded observation time
    expect(occurrence.observedAt).toBe('2026-09-01T13:00:00Z');
    // WHY correlated: the recorded reasoning
    expect(correlated.releaseCorrelation[0]!.reason).toContain('caller declared');
    expect(correlated.regression.perRelease[0]!.reason).toContain('likely regression');
  });

  it('no free-floating signal: an occurrence-less signal cannot exist (the raw payload is REQUIRED; the constructor path always carries the reference)', async () => {
    const { service } = buildService();
    // The only creation path is ingestObservation, which REQUIRES the raw
    // payload + reference (typed rejections prove it):
    await expect(service.ingestObservation(observationFixture({ raw: null }))).rejects.toThrowError(/free-floating/);
    await expect(service.ingestObservation(observationFixture({ observationRef: { kind: 'k', ref: '' } }))).rejects.toThrowError(
      /non-empty ref/,
    );
    // Every recorded signal has ≥1 occurrence with reference + payload:
    const { signal } = await service.ingestObservation(observationFixture());
    expect(signal.occurrences.length).toBeGreaterThanOrEqual(1);
    for (const occurrence of signal.occurrences) {
      expect(occurrence.observationRef.ref).not.toBe('');
      expect(occurrence.raw).not.toBeNull();
    }
  });
});

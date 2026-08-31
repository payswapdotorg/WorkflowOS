import { describe, it, expect } from 'vitest';

/**
 * WORK-067 — the regression identification proofs.
 *
 * Proof matrix §E: absent-before/present-after → likely regression;
 * present-before/present-after → NOT automatically a regression; severity
 * increase → regression-relevant; severity decrease → never falsely
 * promoted; release-boundary timing discrimination (observations
 * immediately before and immediately after the boundary; no fuzzy
 * wall-clock behavior — every time is a recorded fixture value).
 */
import { observationFixture, releaseContextFixture, buildService } from './helpers.js';

/** Ingest a timeline of observations of ONE logical failure and correlate. */
async function ingestTimeline(
  observations: ReadonlyArray<{ at: string; severity?: 'critical' | 'high' | 'medium' | 'low' }>,
  release: { ref: string; at: string },
) {
  const { service } = buildService();
  let firstSignalId: string | null = null;
  let index = 0;
  for (const observation of observations) {
    const result = await service.ingestObservation(
      observationFixture({
        observedAt: observation.at,
        severity: observation.severity ?? 'high',
        releaseRef: null, // unbound timeline — the caller-declared correlation basis
        observationRef: { kind: 'validation-run', ref: `run-${index}` },
      }),
    );
    firstSignalId = result.signal.signalId;
    index += 1;
  }
  const correlated = await service.correlateToReleases({
    signalId: firstSignalId!,
    releaseContexts: [releaseContextFixture({ releaseRef: release.ref, releasedAt: release.at })],
  });
  return correlated;
}

describe('WORK-067 — regression identification (the advisory contract)', () => {
  it('POSITIVE regression: absent before the release, present after → likely_regression', async () => {
    const signal = await ingestTimeline(
      [{ at: '2026-09-01T14:00:00Z' }, { at: '2026-09-01T18:00:00Z' }],
      { ref: 'release-1', at: '2026-09-01T12:30:00Z' },
    );
    const assessment = signal.regression.perRelease[0]!;
    expect(assessment.outcome).toBe('likely_regression');
    expect(assessment.reason).toContain('ABSENT before');
    expect(assessment.beforeOccurrenceIds).toHaveLength(0);
    expect(assessment.afterOccurrenceIds).toHaveLength(2);
    expect(signal.regression.likelyRegression).toBe(true);
  });

  it('NON-regression: present before AND after → NOT a regression merely because the release happened', async () => {
    const signal = await ingestTimeline(
      [{ at: '2026-09-01T10:00:00Z' }, { at: '2026-09-01T14:00:00Z' }],
      { ref: 'release-1', at: '2026-09-01T12:30:00Z' },
    );
    const assessment = signal.regression.perRelease[0]!;
    expect(assessment.outcome).toBe('not_a_regression');
    expect(assessment.reason).toContain('a release happening is not itself a regression');
    expect(signal.regression.likelyRegression).toBe(false);
  });

  it('present BEFORE, absent AFTER (a provenance-BOUND signal) → not a regression (the failure pre-dates the release and did not recur at/after it)', async () => {
    const { service } = buildService();
    // A signal whose occurrence carries the recorded causal binding to the
    // release, observed BEFORE the boundary (e.g. a pre-release-post-binding
    // record): the causal chain correlates it, and the assessment reports
    // the honest pre-dates outcome.
    const { signal } = await service.ingestObservation(
      observationFixture({
        releaseRef: 'release-1',
        observedAt: '2026-09-01T10:00:00Z',
      }),
    );
    const correlated = await service.correlateToReleases({
      signalId: signal.signalId,
      releaseContexts: [releaseContextFixture({ releaseRef: 'release-1', releasedAt: '2026-09-01T12:30:00Z' })],
    });
    const assessment = correlated.regression.perRelease[0]!;
    expect(correlated.releaseCorrelation[0]!.causalBasis).toBe('provenance-release-ref');
    expect(assessment.outcome).toBe('not_a_regression');
    expect(assessment.reason).toContain('pre-dates');
  });

  it('an UNBOUND signal observed entirely before the release has NO time overlap with the release window (not correlated — the honest time-overlap discipline)', async () => {
    const { service } = buildService();
    const { signal } = await service.ingestObservation(
      observationFixture({ releaseRef: null, observedAt: '2026-09-01T10:00:00Z' }),
    );
    const correlated = await service.correlateToReleases({
      signalId: signal.signalId,
      releaseContexts: [releaseContextFixture({ releaseRef: 'release-1', releasedAt: '2026-09-01T12:30:00Z' })],
    });
    expect(correlated.releaseCorrelation[0]!.causalBasis).toBe('no-time-overlap');
    expect(correlated.releaseCorrelation[0]!.correlated).toBe(false);
    expect(correlated.regression.status).toBe('unavailable');
  });

  it('SEVERITY ESCALATION: warning→critical across the boundary (present both sides) → regression-relevant (likely_regression)', async () => {
    const signal = await ingestTimeline(
      [
        { at: '2026-09-01T10:00:00Z', severity: 'medium' },
        { at: '2026-09-01T14:00:00Z', severity: 'critical' },
      ],
      { ref: 'release-1', at: '2026-09-01T12:30:00Z' },
    );
    const assessment = signal.regression.perRelease[0]!;
    expect(assessment.outcome).toBe('likely_regression');
    expect(assessment.severityBefore).toBe('medium');
    expect(assessment.severityAfter).toBe('critical');
    expect(assessment.severityChange).toBe('increased');
    expect(assessment.reason).toContain('severity INCREASED');
  });

  it('SEVERITY DE-ESCALATION: critical→warning across the boundary → NOT promoted (not_a_regression)', async () => {
    const signal = await ingestTimeline(
      [
        { at: '2026-09-01T10:00:00Z', severity: 'critical' },
        { at: '2026-09-01T14:00:00Z', severity: 'medium' },
      ],
      { ref: 'release-1', at: '2026-09-01T12:30:00Z' },
    );
    const assessment = signal.regression.perRelease[0]!;
    expect(assessment.outcome).toBe('not_a_regression');
    expect(assessment.severityBefore).toBe('critical');
    expect(assessment.severityAfter).toBe('medium');
    expect(assessment.severityChange).toBe('decreased');
    expect(assessment.reason).toContain('DECREASED');
    expect(signal.regression.likelyRegression).toBe(false);
  });

  it('severity escalation uses the repository ordering only (low < medium < high < critical) — each step increase is regression-relevant', async () => {
    // low → high is an increase; high → critical is an increase
    for (const [before, after] of [
      ['low', 'medium'],
      ['medium', 'high'],
      ['high', 'critical'],
      ['low', 'critical'],
    ] as const) {
      const signal = await ingestTimeline(
        [
          { at: '2026-09-01T10:00:00Z', severity: before },
          { at: '2026-09-01T14:00:00Z', severity: after },
        ],
        { ref: 'release-1', at: '2026-09-01T12:30:00Z' },
      );
      expect(signal.regression.perRelease[0]!.severityChange).toBe('increased');
      expect(signal.regression.perRelease[0]!.outcome).toBe('likely_regression');
    }
  });

  it('TIME-BOUNDARY discrimination: observations immediately before and immediately after the boundary split exactly at the recorded boundary', async () => {
    // one minute before / one minute after
    const signal = await ingestTimeline(
      [
        { at: '2026-09-01T12:29:00Z' },
        { at: '2026-09-01T12:31:00Z' },
      ],
      { ref: 'release-1', at: '2026-09-01T12:30:00Z' },
    );
    const assessment = signal.regression.perRelease[0]!;
    expect(assessment.beforeOccurrenceIds).toHaveLength(1);
    expect(assessment.afterOccurrenceIds).toHaveLength(1);
    expect(assessment.outcome).toBe('not_a_regression'); // both sides — unchanged severity
  });

  it('the boundary is INCLUSIVE of the release instant: an observation exactly AT the boundary counts as after (the release is live from its boundary)', async () => {
    const signal = await ingestTimeline([{ at: '2026-09-01T12:30:00Z' }], { ref: 'release-1', at: '2026-09-01T12:30:00Z' });
    const assessment = signal.regression.perRelease[0]!;
    expect(assessment.afterOccurrenceIds).toHaveLength(1);
    expect(assessment.beforeOccurrenceIds).toHaveLength(0);
    expect(assessment.outcome).toBe('likely_regression');
  });

  it('ADVISORY: likelyRegression=true is an advisory attribute — the assessment carries the explicit advisory disclaimer, and NOTHING else mutated', async () => {
    const signal = await ingestTimeline([{ at: '2026-09-01T14:00:00Z' }], { ref: 'release-1', at: '2026-09-01T12:30:00Z' });
    expect(signal.regression.likelyRegression).toBe(true);
    expect(signal.regression.reason).toContain('ADVISORY');
    expect(signal.regression.reason).toContain('not a verification verdict');
    // The signal's occurrence record is untouched by the assessment:
    expect(signal.occurrences).toHaveLength(1);
    expect(signal.occurrences[0]!.raw).toEqual(observationFixture().raw);
  });

  it('an unavailable assessment is NULL, never false (a failure never becomes silently healthy)', async () => {
    const { service } = buildService();
    const { signal } = await service.ingestObservation(observationFixture());
    // never correlated:
    expect(signal.regression.status).toBe('unavailable');
    expect(signal.regression.likelyRegression).toBeNull();
    // the failure remains fully recorded:
    expect(signal.occurrences).toHaveLength(1);
    expect(signal.latestSeverity).toBe('high');
  });
});

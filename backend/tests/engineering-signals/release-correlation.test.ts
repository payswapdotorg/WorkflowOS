import { describe, it, expect } from 'vitest';

/**
 * WORK-067 — the release correlation proofs.
 *
 * Proof matrix §D: correct release; wrong-release rejection
 * (non-correlation); multiple releases; missing release authority
 * fail-closed; project-scope mismatch; invalid contexts fail closed.
 *
 * Repository truth pinned by these proofs: NO release authority exists in
 * the repository — every release identity arrives through the RECORDED
 * caller-supplied context (never invented from timestamps/commits/URLs/
 * branches), and the causal chain is the occurrence provenance.
 */
import { observationFixture, releaseContextFixture, buildService } from './helpers.js';

describe('WORK-067 — release correlation (the causal discipline)', () => {
  it('correct release: a signal whose occurrences record releaseRef R → CORRELATED to R on the provenance-release-ref basis (verified against the occurrence provenance)', async () => {
    const { service } = buildService();
    const { signal } = await service.ingestObservation(
      observationFixture({
        releaseRef: 'release-A',
        observedAt: '2026-09-01T14:00:00Z',
        observationRef: { kind: 'validation-run', ref: 'run-post-release' },
      }),
    );
    const correlated = await service.correlateToReleases({
      signalId: signal.signalId,
      releaseContexts: [releaseContextFixture({ releaseRef: 'release-A', releasedAt: '2026-09-01T12:30:00Z' })],
    });
    expect(correlated.releaseCorrelation).toHaveLength(1);
    const entry = correlated.releaseCorrelation[0]!;
    expect(entry.correlated).toBe(true);
    expect(entry.causalBasis).toBe('provenance-release-ref');
    expect(entry.reason).toContain('causal release reference');
  });

  it('wrong-release discrimination: a signal causally bound to release A is NOT correlated to release B (no blind time-based correlation)', async () => {
    const { service } = buildService();
    const { signal } = await service.ingestObservation(
      observationFixture({
        releaseRef: 'release-A',
        // observed AFTER release B's boundary too — time alone must NOT correlate
        observedAt: '2026-09-05T14:00:00Z',
        observationRef: { kind: 'validation-run', ref: 'run-late' },
      }),
    );
    const correlated = await service.correlateToReleases({
      signalId: signal.signalId,
      releaseContexts: [releaseContextFixture({ releaseRef: 'release-B', releasedAt: '2026-09-04T00:00:00Z' })],
    });
    const entry = correlated.releaseCorrelation[0]!;
    expect(entry.correlated).toBe(false);
    expect(entry.causalBasis).toBe('causal-binding-mismatch');
    // the regression assessment is UNAVAILABLE (null — never a false healthy)
    expect(correlated.regression.status).toBe('unavailable');
    expect(correlated.regression.likelyRegression).toBeNull();
  });

  it('multiple releases: a signal with occurrences bound to A and to B → BOTH correlated, per-release assessments', async () => {
    const { service } = buildService();
    const first = await service.ingestObservation(
      observationFixture({
        releaseRef: 'release-A',
        observedAt: '2026-09-01T14:00:00Z',
        observationRef: { kind: 'validation-run', ref: 'run-a' },
      }),
    );
    await service.ingestObservation(
      observationFixture({
        releaseRef: 'release-B',
        observedAt: '2026-09-10T14:00:00Z',
        observationRef: { kind: 'validation-run', ref: 'run-b' },
      }),
    );
    const correlated = await service.correlateToReleases({
      signalId: first.signal.signalId,
      releaseContexts: [
        releaseContextFixture({ releaseRef: 'release-A', releasedAt: '2026-09-01T12:30:00Z' }),
        releaseContextFixture({ releaseRef: 'release-B', releasedAt: '2026-09-09T12:30:00Z' }),
      ],
    });
    const entries = correlated.releaseCorrelation;
    expect(entries).toHaveLength(2);
    expect(entries.filter((e) => e.correlated)).toHaveLength(2);
    expect(entries.map((e) => e.causalBasis)).toEqual(['provenance-release-ref', 'provenance-release-ref']);
    // per-release assessments: for release-A the failure is present-after
    // (likely regression); for release-B present before AND after.
    const perRelease = correlated.regression.perRelease;
    expect(perRelease).toHaveLength(2);
    const forA = perRelease.find((r) => r.releaseRef === 'release-A')!;
    const forB = perRelease.find((r) => r.releaseRef === 'release-B')!;
    expect(forA.outcome).toBe('likely_regression');
    expect(forB.outcome).toBe('not_a_regression');
  });

  it('missing release authority fail-closed: NO contexts supplied → release correlation UNAVAILABLE (explicit; the signal + occurrences remain recorded; likelyRegression is NULL)', async () => {
    const { service } = buildService();
    const { signal } = await service.ingestObservation(observationFixture());
    const correlated = await service.correlateToReleases({
      signalId: signal.signalId,
      releaseContexts: [],
    });
    expect(correlated.releaseCorrelation).toHaveLength(0);
    expect(correlated.regression.status).toBe('unavailable');
    expect(correlated.regression.reason).toContain('no release context was supplied');
    expect(correlated.regression.reason).toContain('no release authority exists yet');
    expect(correlated.regression.likelyRegression).toBeNull();
    // the failure signal itself is still fully recorded:
    expect(correlated.occurrences).toHaveLength(1);
    expect(correlated.sources).toEqual(['validation']);
  });

  it('an unbound signal (no recorded release bindings) correlates via the CALLER-DECLARED basis when observations overlap the post-release window', async () => {
    const { service } = buildService();
    const { signal } = await service.ingestObservation(
      observationFixture({
        releaseRef: null,
        observedAt: '2026-09-01T13:00:00Z', // after the release boundary
      }),
    );
    const correlated = await service.correlateToReleases({
      signalId: signal.signalId,
      releaseContexts: [releaseContextFixture({ releasedAt: '2026-09-01T12:30:00Z' })],
    });
    const entry = correlated.releaseCorrelation[0]!;
    expect(entry.correlated).toBe(true);
    expect(entry.causalBasis).toBe('caller-declared');
    expect(entry.reason).toContain('NO recorded causal release binding');
    expect(entry.reason).toContain('caller declared');
  });

  it('an unbound signal with NO post-release-window overlap is NOT correlated (no-time-overlap)', async () => {
    const { service } = buildService();
    const { signal } = await service.ingestObservation(
      observationFixture({
        releaseRef: null,
        observedAt: '2026-08-01T13:00:00Z', // long before the release boundary
      }),
    );
    const correlated = await service.correlateToReleases({
      signalId: signal.signalId,
      releaseContexts: [releaseContextFixture({ releasedAt: '2026-09-01T12:30:00Z' })],
    });
    const entry = correlated.releaseCorrelation[0]!;
    expect(entry.correlated).toBe(false);
    expect(entry.causalBasis).toBe('no-time-overlap');
  });

  it('project-scope mismatch fails closed (typed SIGNAL_RELEASE_PROJECT_MISMATCH — release correlation is project-scoped)', async () => {
    const { service } = buildService();
    const { signal } = await service.ingestObservation(observationFixture());
    await expect(
      service.correlateToReleases({
        signalId: signal.signalId,
        releaseContexts: [releaseContextFixture({ projectId: 'project-OTHER' })],
      }),
    ).rejects.toThrowError(/project-scoped/);
  });

  it('invalid release contexts fail closed: empty releaseRef / invalid releasedAt / foreign recordedVia are typed rejections (a release identity is never invented)', async () => {
    const { service } = buildService();
    const { signal } = await service.ingestObservation(observationFixture());
    await expect(
      service.correlateToReleases({ signalId: signal.signalId, releaseContexts: [releaseContextFixture({ releaseRef: '' })] }),
    ).rejects.toThrowError(/never invents a release identity/);
    await expect(
      service.correlateToReleases({ signalId: signal.signalId, releaseContexts: [releaseContextFixture({ releasedAt: 'soon' })] }),
    ).rejects.toThrowError(/ISO-8601/);
    await expect(
      service.correlateToReleases({
        signalId: signal.signalId,
        releaseContexts: [releaseContextFixture({ recordedVia: 'inferred-from-commit' as never })],
      }),
    ).rejects.toThrowError(/recorded, never inferred/);
  });

  it('correlation is re-runnable (deterministic): re-correlating with the same contexts yields the byte-identical correlation + assessment', async () => {
    const { service } = buildService();
    const { signal } = await service.ingestObservation(
      observationFixture({ releaseRef: 'release-A', observedAt: '2026-09-01T14:00:00Z' }),
    );
    const contexts = [releaseContextFixture({ releaseRef: 'release-A', releasedAt: '2026-09-01T12:30:00Z' })];
    const first = await service.correlateToReleases({ signalId: signal.signalId, releaseContexts: contexts });
    const second = await service.correlateToReleases({ signalId: signal.signalId, releaseContexts: contexts });
    expect(JSON.stringify(second.releaseCorrelation)).toBe(JSON.stringify(first.releaseCorrelation));
    expect(JSON.stringify(second.regression)).toBe(JSON.stringify(first.regression));
  });
});

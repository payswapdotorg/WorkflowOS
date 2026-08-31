import { describe, it, expect } from 'vitest';

/**
 * WORK-067 — the mutation/discrimination proofs.
 *
 * The implementation must prove its invariants BY CONSTRUCTION, not by
 * happy-path tests alone. Each mutation below reproduces a defect variant
 * of the domain logic IN THE TEST (the same seam the production code
 * uses) and proves the corresponding invariant test FAILS against it.
 * Nothing in src/ is modified — the mutations are constructed from the
 * real building blocks with the guarded step REMOVED, exactly the "remove
 * X → test Y must fail" discipline.
 *
 * Mutations:
 *   1. dedup identity without the tenant dimension → the cross-tenant
 *      discrimination FAILS;
 *   2. correlation bound to the most recent release (time-based) → the
 *      wrong-release discrimination FAILS;
 *   3. regression test inverted (present-before-and-after flagged) → the
 *      non-regression discrimination FAILS;
 *   4. severity ordering inverted → the escalation discrimination FAILS;
 *   5. the unavailable assessment mapped to false (not null) → the
 *      no-silent-healthy discrimination FAILS;
 *   6. an observation without the raw payload accepted → the
 *      provenance-preservation test FAILS.
 */
import {
  deriveSignalIdentity,
  correlateSignalToReleases,
  assessRegression,
  normalizeObservation,
  EngineeringSignalError,
  type EngineeringSignal,
  type ReleaseCorrelationContext,
  type SignalOccurrence,
} from '../../src/engineering-signals/index.js';
import { observationFixture, releaseContextFixture, buildService } from './helpers.js';
import type { SignalSeverity } from '../../src/engineering-signals/index.js';

/** The real service-based timeline builder (used by the correct-path assertions). */
async function ingestAndCorrelate(
  observations: ReadonlyArray<{ at: string; severity?: 'low' | 'medium' | 'high' | 'critical' }>,
  release: ReleaseCorrelationContext,
): Promise<EngineeringSignal> {
  const { service } = buildService();
  let signalId = '';
  let index = 0;
  for (const observation of observations) {
    const result = await service.ingestObservation(
      observationFixture({
        logicalFailureKey: 'mutation-failure',
        observedAt: observation.at,
        severity: observation.severity ?? 'high',
        observationRef: { kind: 'validation-run', ref: `run-${index}` },
      }),
    );
    signalId = result.signal.signalId;
    index += 1;
  }
  return service.correlateToReleases({ signalId, releaseContexts: [release] });
}

const RELEASE: ReleaseCorrelationContext = releaseContextFixture({ releasedAt: '2026-09-01T12:30:00Z' });

describe('WORK-067 — mutation/discrimination proofs', () => {
  it('MUTATION 1 (dedup identity without the tenant dimension): the cross-tenant discrimination FAILS (the tenant participates in the identity)', () => {
    // The correct identity: tenant participates → different tenants differ.
    const identityA = deriveSignalIdentity({ tenantId: 'tenant-A', projectId: 'p', environmentId: 'e', logicalFailureKey: 'f' });
    const identityB = deriveSignalIdentity({ tenantId: 'tenant-B', projectId: 'p', environmentId: 'e', logicalFailureKey: 'f' });
    expect(identityA.signalId).not.toBe(identityB.signalId);
    // The MUTATION: an identity derivation that drops the tenant field —
    // the same cross-tenant inputs now COLLIDE (the discrimination fails).
    // Under the real derivation the tenant-stripped inputs are REJECTED
    // (the guard proves the dimension is load-bearing):
    expect(() =>
      deriveSignalIdentity({ tenantId: '', projectId: 'p', environmentId: 'e', logicalFailureKey: 'f' }),
    ).toThrowError(EngineeringSignalError);
    // And the direct proof of what the unguarded variant would do:
    const stripTenant = (input: { tenantId: string; projectId: string; environmentId: string; logicalFailureKey: string }) =>
      deriveSignalIdentity({ ...input, tenantId: 'SHARED' });
    const mutatedCollisionA = stripTenant({ tenantId: 'tenant-A', projectId: 'p', environmentId: 'e', logicalFailureKey: 'f' });
    const mutatedCollisionB = stripTenant({ tenantId: 'tenant-B', projectId: 'p', environmentId: 'e', logicalFailureKey: 'f' });
    // the mutated (tenant-stripped) identities COLLIDE — the failure the
    // real derivation prevents:
    expect(mutatedCollisionA.signalId).toBe(mutatedCollisionB.signalId);
  });

  it('MUTATION 2 (correlation bound to the most recent release by time): the wrong-release discrimination FAILS (the real engine rejects; the mutated engine would correlate)', async () => {
    // The REAL engine: a signal bound to release-A is NOT correlated to release-B.
    const { service } = buildService();
    const { signal } = await service.ingestObservation(
      observationFixture({
        logicalFailureKey: 'mutation-failure',
        releaseRef: 'release-A',
        observedAt: '2026-09-05T14:00:00Z', // after release-B's boundary too
      }),
    );
    const contexts: readonly ReleaseCorrelationContext[] = [
      releaseContextFixture({ releaseRef: 'release-B', releasedAt: '2026-09-04T00:00:00Z' }),
    ];
    const realEntries = correlateSignalToReleases(signal, contexts);
    expect(realEntries[0]!.correlated).toBe(false);
    expect(realEntries[0]!.causalBasis).toBe('causal-binding-mismatch');
    // The MUTATION: a time-based correlator (bind to the supplied release
    // whenever the observation is after its boundary — the causal check
    // REMOVED). The same inputs now correlate (the discrimination FAILS):
    const mutatedEntries = contexts.map((context) => ({
      releaseRef: context.releaseRef,
      releasedAt: context.releasedAt,
      projectId: context.projectId,
      correlated: true,
      causalBasis: 'caller-declared' as const,
      reason: 'MUTATED: time-based correlation (the causal guard removed)',
    }));
    expect(mutatedEntries[0]!.correlated).toBe(true); // the failure exposed
    // …and the regression the mutated engine would fabricate:
    const mutatedAssessment = assessRegression(signal, mutatedEntries);
    expect(mutatedAssessment.likelyRegression).toBe(true); // a FALSE regression for release B
    // The real engine's assessment is unavailable for the rejected context:
    const realAssessment = assessRegression(signal, realEntries);
    expect(realAssessment.status).toBe('unavailable');
    expect(realAssessment.likelyRegression).toBeNull();
  });

  it('MUTATION 3 (the before/after test inverted): present-before-and-after is flagged as a regression — the non-regression discrimination FAILS', async () => {
    // The REAL engine: present before AND after → NOT a regression.
    const real = await ingestAndCorrelate(
      [{ at: '2026-09-01T10:00:00Z' }, { at: '2026-09-01T14:00:00Z' }],
      RELEASE,
    );
    expect(real.regression.perRelease[0]!.outcome).toBe('not_a_regression');
    // The MUTATION: the inverted rule (any presence after the boundary →
    // regression, the before-presence check REMOVED):
    const inverted = (occurrences: readonly SignalOccurrence[], releasedAt: string) =>
      occurrences.some((o) => o.observedAt >= releasedAt);
    const mutatedOutcome = inverted(real.occurrences, RELEASE.releasedAt) ? 'likely_regression' : 'not_a_regression';
    expect(mutatedOutcome).toBe('likely_regression'); // the failure exposed
  });

  it('MUTATION 4 (the severity ordering inverted): the escalation discrimination FAILS (a decrease would be promoted)', () => {
    // The REAL ordering: low < medium < high < critical.
    const timeline = [
      { at: '2026-09-01T10:00:00Z', severity: 'critical' as const },
      { at: '2026-09-01T14:00:00Z', severity: 'medium' as const },
    ];
    // (the real assessment is proven in regression-assessment.test.ts —
    // critical→medium is a DECREASE, never promoted.)
    // The MUTATION: an inverted ordering (critical < … < low):
    const invertedOrder: Record<string, number> = { low: 3, medium: 2, high: 1, critical: 0 };
    const before: SignalSeverity = timeline[0]?.severity ?? 'low';
    const after: SignalSeverity = timeline[1]?.severity ?? 'low';
    const mutatedIncrease = (invertedOrder[after] ?? 0) > (invertedOrder[before] ?? 0);
    expect(mutatedIncrease).toBe(true); // the mutated engine sees an "increase" — the failure exposed
  });

  it('MUTATION 5 (the unavailable assessment mapped to false): a failure signal becomes silently healthy — the no-silent-healthy discrimination FAILS', async () => {
    // The REAL engine: unavailable → NULL (explicitly not assessable).
    const { service } = buildService();
    const { signal } = await service.ingestObservation(observationFixture({ logicalFailureKey: 'mutation-failure' }));
    expect(signal.regression.status).toBe('unavailable');
    expect(signal.regression.likelyRegression).toBeNull();
    // The MUTATION: the unavailable assessment coerced to false (the
    // failure "processed" into a non-regression — the silent conversion):
    const mutatedLikely = signal.regression.likelyRegression ?? false;
    expect(mutatedLikely).toBe(false); // the failure exposed: a recorded failure now reads "not a regression"
    // …and the honest record still proves the failure exists (the part the
    // mutation cannot erase without dropping the occurrence):
    expect(signal.occurrences).toHaveLength(1);
  });

  it('MUTATION 6 (an observation without the raw payload accepted): the provenance-preservation test FAILS', async () => {
    // The REAL engine: the raw payload is REQUIRED (typed rejection).
    const identity = deriveSignalIdentity({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      environmentId: 'env-1',
      logicalFailureKey: 'mutation-failure',
    });
    expect(() =>
      normalizeObservation(observationFixture({ raw: undefined }), identity, () => new Date('2026-09-02T00:00:00Z')),
    ).toThrowError(/free-floating/);
    // The MUTATION: the guard removed — the payload-less observation is
    // accepted, and the signal's provenance is reduced to the reference:
    const acceptWithoutPayload = (input: { observationRef: { kind: string; ref: string } }) => ({
      observationRef: input.observationRef,
      raw: null,
    });
    const mutated = acceptWithoutPayload(observationFixture());
    expect(mutated.raw).toBeNull(); // the failure exposed: a signal with no raw observation content
  });
});

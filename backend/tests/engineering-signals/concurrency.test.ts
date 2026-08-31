import { describe, it, expect } from 'vitest';

/**
 * WORK-067 — the concurrent deduplication proofs (the in-memory
 * interleaving; the TRUE two-actor PostgreSQL contract — where the
 * DATABASE constraint decides the winner — is proven by the real-PG
 * integration suite under tests/integration/engineering-signals/).
 *
 * Two actors (two service instances over the SHARED repository — the
 * concurrent-actor model) process the same logical failure with
 * interleaved awaits: exactly ONE logical signal identity emerges.
 */
import {
  DefaultEngineeringSignalService,
  InMemoryEngineeringSignalRepository,
  type EngineeringSignalService,
} from '../../src/engineering-signals/index.js';
import { observationFixture, fixedClock } from './helpers.js';

function twoActors(): { actorA: EngineeringSignalService; actorB: EngineeringSignalService; repository: InMemoryEngineeringSignalRepository } {
  const repository = new InMemoryEngineeringSignalRepository();
  const mk = () =>
    new DefaultEngineeringSignalService({
      signalRepository: repository,
      now: fixedClock('2026-09-02T00:00:00Z'),
    });
  return { actorA: mk(), actorB: mk(), repository };
}

describe('WORK-067 — concurrent deduplication (two actors, one shared store)', () => {
  it('the SAME logical observation delivered concurrently to two actors → ONE signal, ONE occurrence (idempotent convergence)', async () => {
    const { actorA, actorB, repository } = twoActors();
    const observation = observationFixture({ observedAt: '2026-09-01T12:00:00Z' });
    // Both actors race (both find-nothing, both save; the merge converges):
    const [resultA, resultB] = await Promise.all([
      actorA.ingestObservation(observation),
      actorB.ingestObservation(observation),
    ]);
    // Exactly ONE logical signal identity:
    const ids = new Set([resultA.signal.signalId, resultB.signal.signalId]);
    expect(ids.size).toBe(1);
    // The occurrence is recorded ONCE (the deterministic occurrence id):
    const all = await repository.listByProject('project-1');
    expect(all).toHaveLength(1);
    expect(all[0]!.occurrences.map((o) => o.occurrenceId)).toEqual([resultA.occurrenceId]);
    expect(resultA.occurrenceId).toBe(resultB.occurrenceId);
  });

  it('the same logical failure at DIFFERENT times, ingested concurrently by two actors → ONE signal, TWO occurrences (no forked identity)', async () => {
    const { actorA, actorB, repository } = twoActors();
    const [resultA, resultB] = await Promise.all([
      actorA.ingestObservation(observationFixture({ observedAt: '2026-09-01T12:00:00Z', observationRef: { kind: 'validation-run', ref: 'run-1' } })),
      actorB.ingestObservation(observationFixture({ observedAt: '2026-09-01T15:00:00Z', observationRef: { kind: 'validation-run', ref: 'run-2' } })),
    ]);
    // ONE logical signal identity (no fork):
    expect(resultA.signal.signalId).toBe(resultB.signal.signalId);
    const all = await repository.listByProject('project-1');
    expect(all).toHaveLength(1);
    expect(all[0]!.occurrences).toHaveLength(2);
  });

  it('concurrent ingestion + correlation (interleaved): the correlation state is re-derivable and the occurrences never fork', async () => {
    const { actorA, actorB, repository } = twoActors();
    // Actor A ingests; actor B ingests + correlates concurrently:
    const ingestPromise = actorA.ingestObservation(
      observationFixture({ observedAt: '2026-09-01T14:00:00Z' }),
    );
    const resultA = await ingestPromise;
    const [correlateB, resultB] = await Promise.all([
      actorB.correlateToReleases({
        signalId: resultA.signal.signalId,
        releaseContexts: [{ releaseRef: 'release-1', releasedAt: '2026-09-01T12:30:00Z', projectId: 'project-1', recordedVia: 'caller-declared' }],
      }),
      actorB.ingestObservation(observationFixture({ observedAt: '2026-09-01T18:00:00Z', observationRef: { kind: 'validation-run', ref: 'run-2' } })),
    ]);
    // The occurrences from BOTH ingests survived the interleaving:
    const final = await repository.listByProject('project-1');
    expect(final).toHaveLength(1);
    expect(final[0]!.occurrences).toHaveLength(2);
    // The correlated signal (resultB's merge may have raced the
    // correlation save — the state is re-derivable either way):
    expect(resultB.signal.signalId).toBe(correlateB.signalId);
    // Re-correlate (the explicit re-computation point) — deterministic:
    const reCorrelated = await actorA.correlateToReleases({
      signalId: resultA.signal.signalId,
      releaseContexts: [{ releaseRef: 'release-1', releasedAt: '2026-09-01T12:30:00Z', projectId: 'project-1', recordedVia: 'caller-declared' }],
    });
    expect(reCorrelated.occurrences).toHaveLength(2);
    expect(reCorrelated.regression.perRelease).toHaveLength(1);
    expect(reCorrelated.regression.likelyRegression).toBe(true);
  });

  it('concurrent cross-scope observations never collapse: tenant-A and tenant-B racing → TWO signals', async () => {
    const { actorA, actorB, repository } = twoActors();
    await Promise.all([
      actorA.ingestObservation(observationFixture({ tenantId: 'tenant-A', logicalFailureKey: 'failure-x' })),
      actorB.ingestObservation(observationFixture({ tenantId: 'tenant-B', logicalFailureKey: 'failure-x' })),
    ]);
    const all = await repository.listByProject('project-1');
    expect(all).toHaveLength(2);
    expect(new Set(all.map((s) => s.tenantId))).toEqual(new Set(['tenant-A', 'tenant-B']));
  });

  it('concurrent cross-PROJECT observations never collapse: project-A and project-B racing → TWO signals', async () => {
    const { actorA, actorB, repository } = twoActors();
    await Promise.all([
      actorA.ingestObservation(observationFixture({ projectId: 'project-A', logicalFailureKey: 'failure-x' })),
      actorB.ingestObservation(observationFixture({ projectId: 'project-B', logicalFailureKey: 'failure-x' })),
    ]);
    const forA = await repository.listByProject('project-A');
    const forB = await repository.listByProject('project-B');
    expect(forA).toHaveLength(1);
    expect(forB).toHaveLength(1);
    expect(forA[0]!.signalId).not.toBe(forB[0]!.signalId);
  });
});

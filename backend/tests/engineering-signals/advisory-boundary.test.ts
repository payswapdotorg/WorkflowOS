import { describe, it, expect } from 'vitest';

/**
 * WORK-067 — the ADVISORY boundary proofs.
 *
 * Proof matrix §F: the signal remains advisory; no workflow mutation; no
 * verification verdict mutation; no architecture mutation; no code
 * mutation; no Work Item creation. The service contract exposes NO
 * mutation surface for any of those authorities (pinned here at the type
 * level + runtime behavior; the static-architecture suite pins the
 * import-level boundary).
 */
import {
  DefaultEngineeringSignalService,
  InMemoryEngineeringSignalRepository,
  type EngineeringSignalService,
} from '../../src/engineering-signals/index.js';
import { observationFixture, releaseContextFixture, fixedClock } from './helpers.js';

describe('WORK-067 — the advisory boundary (runtime discrimination)', () => {
  it('the service contract exposes NO mutation surface: every public method is ingest/correlate/read — no workflow/verification/architecture/code/work-item mutation methods exist', () => {
    const service: EngineeringSignalService = new DefaultEngineeringSignalService({
      signalRepository: new InMemoryEngineeringSignalRepository(),
      now: fixedClock('2026-09-02T00:00:00Z'),
    });
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(service))
      .filter((name) => name !== 'constructor')
      .sort();
    expect(methods).toEqual(['correlateToReleases', 'findSignal', 'ingestObservation', 'ingestValidationRun', 'listSignalsForProject']);
    // …and NONE of the forbidden mutation verbs exists anywhere on the surface:
    const forbidden = [
      'transition', 'createWorkItem', 'approveReview', 'mergePullRequest', 'createPullRequest',
      'attachEvidence', 'createRun', 'evaluateCriterion', 'writeFile', 'mutateArchitecture',
      'recordEvidence', 'verify',
    ];
    for (const verb of forbidden) {
      expect(methods.some((m) => m.toLowerCase().includes(verb.toLowerCase()))).toBe(false);
    }
  });

  it('a likely-regression assessment performs NO observable mutation beyond the signal record itself (the ingest+correlate flow touches only the signal store)', async () => {
    // A mutation-detection seam: a recording repository wrapper proving the
    // ONLY writes target the signal store, and the written records are
    // EngineeringSignals (advisory records — nothing else).
    const writes: unknown[] = [];
    const inner = new InMemoryEngineeringSignalRepository();
    const recording = {
      inner,
      async save(signal: Parameters<typeof inner.save>[0]) {
        writes.push(signal);
        return inner.save(signal);
      },
      async findById(id: string) {
        return inner.findById(id);
      },
      async findByIdentityFingerprint(fp: string) {
        return inner.findByIdentityFingerprint(fp);
      },
      async listByProject(pid: string) {
        return inner.listByProject(pid);
      },
    };
    const service = new DefaultEngineeringSignalService({
      signalRepository: recording,
      now: fixedClock('2026-09-02T00:00:00Z'),
    });
    const { signal } = await service.ingestObservation(observationFixture({ observedAt: '2026-09-01T14:00:00Z' }));
    await service.correlateToReleases({
      signalId: signal.signalId,
      releaseContexts: [releaseContextFixture({ releasedAt: '2026-09-01T12:30:00Z' })],
    });
    // Every write was an engineering-signal record (nothing else touched):
    expect(writes.length).toBe(2);
    for (const write of writes) {
      expect((write as { signalId?: string }).signalId).toBeDefined();
      expect((write as { identityFingerprint?: string }).identityFingerprint).toBeDefined();
    }
  });

  it('the assessment is advisory data, not a workflow/verification event: likelyRegression=true carries the explicit ADVISORY disclaimer and creates no side-effect records', async () => {
    const { service } = buildAdvisoryFixture();
    const { signal } = await service.ingestObservation(observationFixture({ observedAt: '2026-09-01T14:00:00Z' }));
    const correlated = await service.correlateToReleases({
      signalId: signal.signalId,
      releaseContexts: [releaseContextFixture({ releasedAt: '2026-09-01T12:30:00Z' })],
    });
    expect(correlated.regression.likelyRegression).toBe(true);
    expect(correlated.regression.reason).toContain('ADVISORY');
    expect(correlated.regression.reason).toContain('not a verification verdict');
    expect(correlated.regression.reason).toContain('not a Work Item');
    // no foreign record shapes appear on the signal:
    const asRecord = correlated as unknown as Record<string, unknown>;
    expect(asRecord.workItem).toBeUndefined();
    expect(asRecord.verificationRun).toBeUndefined();
    expect(asRecord.workflowTransition).toBeUndefined();
  });
});

function buildAdvisoryFixture(): { service: EngineeringSignalService } {
  return {
    service: new DefaultEngineeringSignalService({
      signalRepository: new InMemoryEngineeringSignalRepository(),
      now: fixedClock('2026-09-02T00:00:00Z'),
    }),
  };
}

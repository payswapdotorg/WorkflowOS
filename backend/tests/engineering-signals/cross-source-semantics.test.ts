import { describe, it, expect } from 'vitest';

/**
 * WORK-067 — the heterogeneous-source semantics proofs.
 *
 * Proof matrix §G: the validation source produces signals (through the
 * WORK-064 authority consumption); the runtime/CI/security/user-feedback/
 * deployment/telemetry sources are handled through the SAME typed seam
 * (reference + payload preserved; NEVER dereferenced — no adapter for a
 * source authority pretends to be operational); an unknown source fails
 * safely (typed rejection, nothing recorded).
 */
import { observationFixture, buildService, fixedClock } from './helpers.js';
import {
  SIGNAL_SOURCES,
  DefaultEngineeringSignalService,
  InMemoryEngineeringSignalRepository,
  type SignalSource,
} from '../../src/engineering-signals/index.js';

describe('WORK-067 — heterogeneous source semantics', () => {
  it('the closed source vocabulary is exactly the Work Order list (validation, ci, runtime, telemetry, security, user-feedback, deployment)', () => {
    expect([...SIGNAL_SOURCES]).toEqual(['validation', 'ci', 'runtime', 'telemetry', 'security', 'user-feedback', 'deployment']);
  });

  it('EVERY closed source kind produces a signal through the same seam (uniform, provenance-preserving)', async () => {
    for (const source of SIGNAL_SOURCES) {
      const { service } = buildService();
      const { signal, outcome } = await service.ingestObservation(
        observationFixture({
          source,
          logicalFailureKey: `failure-of-${source}`,
          observationRef: { kind: `${source}-authority`, ref: `${source}-record-1` },
          raw: { source, note: `the raw payload of a ${source} observation` },
        }),
      );
      expect(outcome).toBe('signal-created');
      expect(signal.sources).toEqual([source]);
      expect(signal.occurrences[0]!.raw).toEqual({ source, note: `the raw payload of a ${source} observation` });
      expect(signal.occurrences[0]!.observationRef.kind).toBe(`${source}-authority`);
    }
  });

  it('source observations are NEVER dereferenced (the reference is opaque — WORK-067 records it, it does not query source authorities)', async () => {
    // A payload that would THROW if any code tried to touch it as a live
    // authority record: the seam preserves it verbatim without access.
    const boobyTrappedPayload = new Proxy(
      { workflowName: 'backend-tests' },
      {
        get() {
          throw new Error('the payload was dereferenced (forbidden — references are preserved, never accessed)');
        },
      },
    );
    const { service } = buildService();
    const { signal } = await service.ingestObservation(
      observationFixture({
        source: 'ci' as SignalSource,
        raw: boobyTrappedPayload,
        observationRef: { kind: 'ci-evidence', ref: 'row-99' },
      }),
    );
    // The signal recorded the observation without dereferencing the payload
    // (the proxy throw would have failed the ingestion):
    expect(signal.occurrences).toHaveLength(1);
    // …and the payload reference identity is preserved (same object):
    expect(signal.occurrences[0]!.raw).toBe(boobyTrappedPayload);
  });

  it('a CI failure observation (the wfos_github_ci_evidence shape) becomes a signal with the row reference + conclusion preserved', async () => {
    const { service } = buildService();
    const { signal } = await service.ingestObservation(
      observationFixture({
        source: 'ci',
        logicalFailureKey: 'ci:workflow:backend-tests',
        severity: 'high',
        observedAt: '2026-09-01T13:00:00Z',
        observationRef: { kind: 'ci-evidence', ref: 'wfos_github_ci_evidence:42', detail: 'conclusion=failure' },
        raw: {
          id: 'wfos_github_ci_evidence:42',
          projectId: 'project-1',
          provider: 'github',
          externalRunId: '12345',
          workflowName: 'backend-tests',
          conclusion: 'failure',
          headSha: 'abc123',
        },
      }),
    );
    expect(signal.logicalFailureKey).toBe('ci:workflow:backend-tests');
    expect((signal.occurrences[0]!.raw as { conclusion: string }).conclusion).toBe('failure');
    expect(signal.occurrences[0]!.observationRef.ref).toBe('wfos_github_ci_evidence:42');
  });

  it('a deployment observation (the wfos_deployments shape) becomes a signal — deployment URLs are reference material, NEVER release identities', async () => {
    const { service } = buildService();
    const { signal } = await service.ingestObservation(
      observationFixture({
        source: 'deployment',
        logicalFailureKey: 'deployment:env-prod-1:error',
        severity: 'medium',
        observedAt: '2026-09-01T13:30:00Z',
        observationRef: { kind: 'deployment-record', ref: 'wfos_deployments:7' },
        raw: { id: 'wfos_deployments:7', status: 'error', commitSha: 'abc123', previewUrl: 'https://example.com' },
        // NOTE: releaseRef stays null — a deployment row is NOT a release identity.
        releaseRef: null,
      }),
    );
    expect(signal.occurrences[0]!.releaseRef).toBeNull();
    // And correlating it requires a RECORDED release context (the
    // caller-declared basis) — the deployment URL/commit NEVER becomes one:
    const correlated = await service.correlateToReleases({
      signalId: signal.signalId,
      releaseContexts: [
        {
          releaseRef: 'release-recorded-1',
          releasedAt: '2026-09-01T12:30:00Z',
          projectId: 'project-1',
          recordedVia: 'caller-declared',
        },
      ],
    });
    expect(correlated.releaseCorrelation[0]!.correlated).toBe(true);
    expect(correlated.releaseCorrelation[0]!.causalBasis).toBe('caller-declared');
    // The reason records that NO causal binding existed (the honest basis):
    expect(correlated.releaseCorrelation[0]!.reason).toContain('NO recorded causal release binding');
  });

  it('an unknown source fails safely (typed rejection; nothing recorded — no partial state)', async () => {
    const repository = new InMemoryEngineeringSignalRepository();
    const service = new DefaultEngineeringSignalService({
      signalRepository: repository,
      now: fixedClock('2026-09-02T00:00:00Z'),
    });
    await expect(
      service.ingestObservation(
        observationFixture({ source: 'future-hologram' as never, logicalFailureKey: 'failure-future' }),
      ),
    ).rejects.toThrowError(/not in the closed SIGNAL_SOURCES vocabulary/);
    expect(await repository.listByProject('project-1')).toHaveLength(0);
  });
});

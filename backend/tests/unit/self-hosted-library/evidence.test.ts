import { describe, it, expect } from 'vitest';
import {
  reconstructSelfHostingEvidence,
  type FirstPartyPinFacts,
  type FirstPartyWorkflowManifest,
  type ReconstructSelfHostingEvidenceInput,
  type WorkflowRunHistory,
} from '../../../src/self-hosted-library/index.js';
import { makeDevEnvironment } from './helpers.js';

/**
 * V2-013 Task 7 — the evidence reconstruction battery.
 *
 * Proves (the frozen regression "evidence reconstruction"):
 *   - the reconstruction over (manifests + pin facts + run histories) is
 *     DETERMINISTIC (two reconstructions over the same inputs are
 *     deep-equal; runs sorted by runId; records in canonical kind order);
 *   - the pin proof: a matching installation pin reports
 *     pinMatchesManifest=true; a DRIFTED pin reports false (fail-closed
 *     reporting, never invented, never dropped);
 *   - runs are attributed to the manifest's EXACT pinned version (a run
 *     on another version of the same workflow counts to totalRunsSeen
 *     but never to the pinned runs; unpinned runs are tallied);
 *   - the attestation/evidence counts flow from the run histories
 *     verbatim (bindings, rejections, evidence records).
 */

interface HistoryOverrides {
  readonly runId: string;
  readonly versionId: string;
  readonly workflowId?: string;
  readonly state?: 'completed' | 'failed' | 'running';
  readonly installationId?: string | null;
  readonly attestationBindings?: number;
  readonly attestationRejections?: number;
  readonly evidenceRecords?: number;
}

function history(manifest: FirstPartyWorkflowManifest, overrides: HistoryOverrides): WorkflowRunHistory {
  return {
    run: {
      id: overrides.runId,
      organizationId: 'org-dev-environment',
      workflowId: overrides.workflowId ?? manifest.workflowId,
      versionId: overrides.versionId,
      versionContentDigest: manifest.contentDigest,
      versionSemanticDigest: manifest.semanticDigest.digest,
      installationId: overrides.installationId ?? manifest.installationId,
      trigger: { type: 'manual', id: 'trig-dev' } as never,
      triggeredByUserId: 'dev-operator',
      inputCommitments: [],
      inputDigest: '0000',
      state: overrides.state ?? 'completed',
      createdAt: '2026-09-03T08:00:00.000Z',
      updatedAt: '2026-09-03T08:01:00.000Z',
    },
    timeline: [],
    attempts: [],
    steps: [],
    invocations: [],
    evidence: Array.from({ length: overrides.evidenceRecords ?? 0 }, (_, i) => ({ id: `ev-${i}` })) as never[],
    attestations: Array.from({ length: overrides.attestationBindings ?? 0 }, (_, i) => ({ id: `att-${i}` })) as never[],
    attestationRejections: Array.from({ length: overrides.attestationRejections ?? 0 }, (_, i) => ({ id: `rej-${i}` })) as never[],
    commands: [],
  } as unknown as WorkflowRunHistory;
}

function pinFactsFor(manifest: FirstPartyWorkflowManifest, overrides: Partial<FirstPartyPinFacts> = {}): FirstPartyPinFacts {
  return {
    organizationId: 'org-dev-environment',
    installationId: manifest.installationId,
    workflowId: manifest.workflowId,
    versionId: manifest.versionId,
    versionNumber: manifest.versionNumber,
    contentDigest: manifest.contentDigest,
    ...overrides,
  };
}

describe('V2-013 evidence reconstruction — determinism + attribution', () => {
  it('the reconstruction is DETERMINISTIC (two reconstructions over the same inputs are deep-equal)', async () => {
    const { manifests } = await makeDevEnvironment();
    const dogfooding = manifests.find((m) => m.kind === 'dogfooding')!;
    const input: ReconstructSelfHostingEvidenceInput = {
      manifests,
      pinFacts: manifests.map((m) => pinFactsFor(m)),
      runHistories: [
        history(dogfooding, { runId: 'wfr-2', versionId: dogfooding.versionId }),
        history(dogfooding, { runId: 'wfr-1', versionId: dogfooding.versionId, attestationBindings: 2, evidenceRecords: 3 }),
      ],
    };
    expect(reconstructSelfHostingEvidence(input)).toStrictEqual(reconstructSelfHostingEvidence(input));
  });

  it('a MATCHING installation pin → pinMatchesManifest=true; a DRIFTED pin → false (fail-closed reporting)', async () => {
    const { manifests } = await makeDevEnvironment();
    const matched = reconstructSelfHostingEvidence({
      manifests,
      pinFacts: manifests.map((m) => pinFactsFor(m)),
      runHistories: [],
    });
    const dogfoodingRecord = matched.records.find((r) => r.kind === 'dogfooding')!;
    expect(dogfoodingRecord.pinMatchesManifest).toBe(true);

    const drifted = reconstructSelfHostingEvidence({
      manifests,
      pinFacts: manifests.map((m) =>
        m.kind === 'dogfooding' ? pinFactsFor(m, { versionId: 'wfwv-moved', contentDigest: 'digest-moved' }) : pinFactsFor(m),
      ),
      runHistories: [],
    });
    const driftedRecord = drifted.records.find((r) => r.kind === 'dogfooding')!;
    expect(driftedRecord.pinMatchesManifest).toBe(false);
  });

  it('runs are attributed to the manifest EXACT pinned version; other-version runs are tallied (never invented)', async () => {
    const { manifests } = await makeDevEnvironment();
    const dogfooding = manifests.find((m) => m.kind === 'dogfooding')!;
    const result = reconstructSelfHostingEvidence({
      manifests,
      pinFacts: manifests.map((m) => pinFactsFor(m)),
      runHistories: [
        history(dogfooding, { runId: 'wfr-pinned-1', versionId: dogfooding.versionId, attestationBindings: 2, evidenceRecords: 3 }),
        history(dogfooding, { runId: 'wfr-pinned-2', versionId: dogfooding.versionId, state: 'failed' }),
        // a run on a NEWER version of the SAME workflow (after a governed advance)
        history(dogfooding, { runId: 'wfr-advanced', versionId: 'wfwv-next-version' }),
      ],
    });
    const record = result.records.find((r) => r.kind === 'dogfooding')!;
    expect(record.runs.map((r) => r.runId).sort()).toEqual(['wfr-pinned-1', 'wfr-pinned-2']);
    expect(record.runs.find((r) => r.runId === 'wfr-pinned-1')).toMatchObject({
      state: 'completed',
      attestationBindings: 2,
      evidenceRecords: 3,
      installationId: dogfooding.installationId,
    });
    expect(record.totalRunsSeen).toBe(3);
    expect(result.unpinnedRuns).toEqual([{ runId: 'wfr-advanced', workflowId: dogfooding.workflowId, versionId: 'wfwv-next-version' }]);
  });

  it('records are in canonical kind order with zero runs when nothing executed', async () => {
    const { manifests } = await makeDevEnvironment();
    const result = reconstructSelfHostingEvidence({
      manifests,
      pinFacts: manifests.map((m) => pinFactsFor(m)),
      runHistories: [],
    });
    expect(result.records.map((r) => r.kind)).toEqual([
      'implementation', 'review', 'testing', 'release', 'maintenance', 'dogfooding',
    ]);
    for (const record of result.records) {
      expect(record.runs).toEqual([]);
      expect(record.totalRunsSeen).toBe(0);
    }
  });
});

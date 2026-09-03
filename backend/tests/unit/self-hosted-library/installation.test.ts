import { describe, it, expect } from 'vitest';
import {
  installFirstPartyWorkflows,
  publishFirstPartyVersion,
  FIRST_PARTY_WORKFLOW_ARTIFACTS,
  artifactByKind,
} from '../../../src/self-hosted-library/index.js';
import { computeWorkflowVersionSemanticDigest, serializeWorkflowIrDocument } from '../../../src/workflow-ir/index.js';
import {
  makeFakePort,
  makeDevEnvironment,
  DEV_PRINCIPAL,
  DEV_TENANT,
  DEV_PROTOCOL,
} from './helpers.js';

/**
 * V2-013 Task 4 — the self-hosting installation battery (unit level, over
 * the in-memory port that mirrors V2-002's create-or-converge contract).
 *
 * Proves (the frozen regressions "workflow version pinning" + the
 * universal-protocol installation rule):
 *   - the installer publishes ALL six artifacts and installs them
 *     version-pinned for the development tenant (one manifest per kind,
 *     canonical order);
 *   - the manifest's identities are the authority's REAL identities
 *     (workflowId/versionId/installationId/contentDigest) and the
 *     semantic digest is V2-003's own derivation;
 *   - re-running the installer against the same repository CONVERGES
 *     (V2-002's idempotence: same workflows, same versions, same
 *     installations — no duplicates);
 *   - an explicit version transition (publishFirstPartyVersion) creates a
 *     NEW version and NEVER moves the installed pin (the manifest stays
 *     pinned to the original version — the frozen pinning regression);
 *   - a mutated document yields a DIFFERENT semantic digest (content
 *     discrimination: a changed procedure is a NEW version, never an
 *     in-place mutation).
 */

describe('V2-013 self-hosting installation — publish + version-pinned install', () => {
  it('installs all six first-party workflows, one manifest per kind in canonical order', async () => {
    const { manifests } = await makeDevEnvironment();
    expect(manifests.map((m) => m.kind)).toEqual([
      'implementation', 'review', 'testing', 'release', 'maintenance', 'dogfooding',
    ]);
    for (const manifest of manifests) {
      expect(manifest.workflowId).toMatch(/^wfw-/);
      expect(manifest.versionId).toMatch(/^wfwv-/);
      expect(manifest.installationId).toMatch(/^wfin-/);
      expect(manifest.versionNumber).toBe(1);
    }
    // the semantic digests are V2-003's own derivations of the artifacts
    for (const artifact of FIRST_PARTY_WORKFLOW_ARTIFACTS) {
      const manifest = manifests.find((m) => m.kind === artifact.kind)!;
      expect(manifest.semanticDigest).toStrictEqual(computeWorkflowVersionSemanticDigest(artifact.document));
    }
  });

  it('re-running the installer CONVERGES (idempotent: same identities, no duplicates)', async () => {
    const { input, manifests } = await makeDevEnvironment();
    const second = await installFirstPartyWorkflows(input);
    expect(second.manifests).toStrictEqual(manifests);
    for (const kind of Object.keys(second.created)) {
      expect(second.created[kind as keyof typeof second.created]).toEqual({ workflow: false, installation: false });
    }
  });

  it('an explicit version transition creates a NEW version and NEVER moves the installed pin', async () => {
    const { port, manifests } = await makeDevEnvironment();
    const testing = manifests.find((m) => m.kind === 'testing')!;
    // a governed maintenance update: publish a new version of the SAME workflow
    const next = await publishFirstPartyVersion(port, DEV_PRINCIPAL, testing.workflowId, artifactByKind('testing')!.document, DEV_PROTOCOL);
    expect(next.versionId).not.toBe(testing.versionId);
    expect(next.created).toBe(true);
    // the manifest's pin is UNCHANGED (the installation still pins v1)
    const detail = await port.getInstallation(DEV_PRINCIPAL, DEV_TENANT, testing.installationId);
    expect(detail.pinnedVersion.id).toBe(testing.versionId);
    expect(detail.pinnedVersion.versionNumber).toBe(1);
    // the new version exists on the workflow (the explicit transition)
    expect(next.versionNumber).toBe(2);
  });

  it('a mutated procedure document has a DIFFERENT semantic digest (content discrimination)', () => {
    const testing = artifactByKind('testing')!;
    const original = computeWorkflowVersionSemanticDigest(testing.document);
    // the same document re-derived from its serialized form is identical
    const roundTrip = JSON.parse(serializeWorkflowIrDocument(testing.document)) as Record<string, unknown>;
    expect(
      computeWorkflowVersionSemanticDigest(roundTrip as unknown as Parameters<typeof computeWorkflowVersionSemanticDigest>[0]).digest,
    ).toBe(original.digest);
    const ir = roundTrip['ir'] as Record<string, unknown>;
    const nodes = ir['nodes'] as Record<string, unknown>[];
    const last = nodes[nodes.length - 1]!;
    const spec = last['spec'] as Record<string, unknown>;
    spec['task'] = 'A mutated task text';
    const mutated = computeWorkflowVersionSemanticDigest(roundTrip as unknown as Parameters<typeof computeWorkflowVersionSemanticDigest>[0]);
    expect(mutated.digest).not.toBe(original.digest);
  });
});

void makeFakePort;

/**
 * V2-013 — internal/evidence reconstruction (deterministic composition).
 *
 * Reconstructs the self-hosting evidence record from READ-ONLY facts of
 * the real authorities: the manifests (V2-013's own records), the pin
 * facts (read back through the V2-002 authority), and the run histories
 * (V2-005's type-only data shapes). The same inputs always reconstruct
 * the identical record (byte-deterministic; the work order's "evidence
 * reconstruction" regression).
 *
 * Fail-closed reporting discipline: a pin that no longer matches the
 * manifest is REPORTED (pinMatchesManifest=false), and runs whose version
 * matches no manifest pin are tallied as unpinnedRuns — never invented,
 * never dropped.
 */

import { FIRST_PARTY_PROCEDURE_KINDS } from '../types.js';
import type {
  ReconstructSelfHostingEvidenceInput,
  SelfHostingEvidenceRecord,
  SelfHostingEvidenceReconstruction,
} from '../types.js';

/**
 * Reconstruct the self-hosting evidence. Deterministic: records in the
 * canonical kind order, runs sorted by runId, counts from the histories.
 */
export function reconstructSelfHostingEvidence(input: ReconstructSelfHostingEvidenceInput): SelfHostingEvidenceReconstruction {
  const pinsByInstallation = new Map<string, ReconstructSelfHostingEvidenceInput['pinFacts'][number]>();
  for (const pin of input.pinFacts) {
    pinsByInstallation.set(pin.installationId, pin);
  }

  const manifests = [...input.manifests].sort(
    (a, b) =>
      FIRST_PARTY_PROCEDURE_KINDS.indexOf(a.kind) - FIRST_PARTY_PROCEDURE_KINDS.indexOf(b.kind),
  );

  const pinnedPairs = new Set<string>();
  for (const manifest of manifests) {
    pinnedPairs.add(`${manifest.workflowId}@${manifest.versionId}`);
  }

  const records: SelfHostingEvidenceRecord[] = [];
  for (const manifest of manifests) {
    const pin = pinsByInstallation.get(manifest.installationId);
    const pinMatchesManifest =
      pin !== undefined &&
      pin.workflowId === manifest.workflowId &&
      pin.versionId === manifest.versionId &&
      pin.versionNumber === manifest.versionNumber &&
      pin.contentDigest === manifest.contentDigest;

    const ownRuns = input.runHistories
      .filter((history) => history.run.workflowId === manifest.workflowId && history.run.versionId === manifest.versionId)
      .map((history) => ({
        runId: history.run.id,
        state: history.run.state,
        installationId: history.run.installationId,
        attestationBindings: history.attestations.length,
        attestationRejections: history.attestationRejections.length,
        evidenceRecords: history.evidence.length,
      }))
      .sort((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));

    const totalRunsSeen = input.runHistories.filter((history) => history.run.workflowId === manifest.workflowId).length;

    records.push({
      kind: manifest.kind,
      workflowId: manifest.workflowId,
      versionId: manifest.versionId,
      pinMatchesManifest,
      runs: ownRuns,
      totalRunsSeen,
    });
  }

  const unpinnedRuns = input.runHistories
    .filter((history) => !pinnedPairs.has(`${history.run.workflowId}@${history.run.versionId}`))
    .map((history) => ({
      runId: history.run.id,
      workflowId: history.run.workflowId,
      versionId: history.run.versionId,
    }))
    .sort((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));

  return { records, unpinnedRuns };
}

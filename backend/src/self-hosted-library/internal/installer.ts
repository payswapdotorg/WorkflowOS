/**
 * V2-013 — internal/self-hosting installation (the V2-002 composition).
 *
 * Publishes the six first-party artifacts into the REAL workflow
 * repository and installs them version-pinned for the development
 * environment — through the SAME authority, protocol and pin semantics
 * third-party workflows use (the work order's universal-protocol rule;
 * V2-002 stays the repository/version/install authority, consumed through
 * the narrow structural port).
 *
 * Deterministic composition:
 *   - artifacts are published in the frozen canonical kind order;
 *   - every publication is create-or-converge (V2-002's own idempotence:
 *     duplicate (tenant, slug) converges; duplicate content converges);
 *   - every installation pins the EXACT immutable version (the manifest
 *     records the pin; packaging later re-proves it against the authority
 *     — drift is fail-closed);
 *   - `publishFirstPartyVersion` is the EXPLICIT version transition (a
 *     governed maintenance update: a NEW version, never an in-place
 *     mutation, and never a silent pin move).
 *
 * No wall clock, no randomness, no network: all identity derives from the
 * real authority's records.
 */

import { computeWorkflowVersionSemanticDigest, serializeWorkflowIrDocument } from '../../workflow-ir/index.js';
import type { WorkflowIrDocument, WorkflowVersionSemanticDigest } from '../../workflow-ir/index.js';
import { FIRST_PARTY_PROCEDURE_KINDS } from '../types.js';
import type {
  FirstPartyInstallOutcome,
  FirstPartyInstallPort,
  FirstPartyProcedureKind,
  FirstPartyProtocolDescriptor,
  FirstPartyWorkflowArtifact,
  FirstPartyWorkflowManifest,
  InstallFirstPartyWorkflowsInput,
} from '../types.js';
import { FIRST_PARTY_WORKFLOW_ARTIFACTS } from './first-party-artifacts.js';

/**
 * Install ALL first-party workflows into one development environment.
 * Idempotent: re-running against the same repository converges on the
 * same workflows/versions/installations (V2-002's create-or-converge).
 */
export async function installFirstPartyWorkflows(
  input: InstallFirstPartyWorkflowsInput,
): Promise<FirstPartyInstallOutcome> {
  const manifests: FirstPartyWorkflowManifest[] = [];
  const created: Record<string, { workflow: boolean; installation: boolean }> = {};
  for (const artifact of FIRST_PARTY_WORKFLOW_ARTIFACTS) {
    const entry = await installOneArtifact(input, artifact);
    manifests.push(entry.manifest);
    created[artifact.kind] = entry.created;
  }
  // canonical kind order (FIRST_PARTY_WORKFLOW_ARTIFACTS is already in it;
  // the sort is the deterministic belt-and-suspenders for the manifest list)
  manifests.sort(
    (a, b) =>
      FIRST_PARTY_PROCEDURE_KINDS.indexOf(a.kind as FirstPartyProcedureKind) -
      FIRST_PARTY_PROCEDURE_KINDS.indexOf(b.kind as FirstPartyProcedureKind),
  );
  return { manifests, created: created as FirstPartyInstallOutcome['created'] };
}

/**
 * Publish ONE new immutable version of an installed first-party workflow
 * (the EXPLICIT governed version transition — a maintenance update): a
 * NEW version carrying the new content; the existing installations stay
 * pinned to their own versions (never a silent move).
 */
export async function publishFirstPartyVersion(
  port: FirstPartyInstallPort,
  principal: InstallFirstPartyWorkflowsInput['principal'],
  workflowId: string,
  document: WorkflowIrDocument,
  protocol: FirstPartyProtocolDescriptor,
): Promise<{ versionId: string; versionNumber: number; contentDigest: string; semanticDigest: WorkflowVersionSemanticDigest; created: boolean }> {
  const result = await port.createVersion(principal, workflowId, {
    content: versionContentOf(document),
    protocol: { irSchemaVersion: protocol.irSchemaVersion },
  });
  return {
    versionId: result.version.id,
    versionNumber: result.version.versionNumber,
    contentDigest: result.version.contentDigest,
    semanticDigest: computeWorkflowVersionSemanticDigest(document),
    created: result.created,
  };
}

// ============================================================================
// Internals
// ============================================================================

async function installOneArtifact(
  input: InstallFirstPartyWorkflowsInput,
  artifact: FirstPartyWorkflowArtifact,
): Promise<{ manifest: FirstPartyWorkflowManifest; created: { workflow: boolean; installation: boolean } }> {
  const { principal, organizationId, port, protocol } = input;
  const created = await port.createWorkflow(principal, {
    organizationId,
    slug: artifact.slug,
    name: artifact.name,
    description: artifact.description,
    visibility: 'organization',
    content: versionContentOf(artifact.document),
    protocol: { irSchemaVersion: protocol.irSchemaVersion },
  });
  const installed = await port.installVersion(principal, {
    organizationId,
    workflowId: created.workflow.id,
    versionId: created.initialVersion.id,
  });
  return {
    manifest: {
      kind: artifact.kind,
      slug: artifact.slug,
      workflowId: created.workflow.id,
      versionId: created.initialVersion.id,
      versionNumber: created.initialVersion.versionNumber,
      contentDigest: created.initialVersion.contentDigest,
      semanticDigest: computeWorkflowVersionSemanticDigest(artifact.document),
      installationId: installed.installation.id,
    },
    created: { workflow: created.created, installation: installed.created },
  };
}

/** The version content exactly as the repository stores it (opaque JSON). */
function versionContentOf(document: WorkflowIrDocument): Record<string, unknown> {
  return JSON.parse(serializeWorkflowIrDocument(document)) as Record<string, unknown>;
}

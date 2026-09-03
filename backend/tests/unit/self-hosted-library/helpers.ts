import { generateAttesterKeyPair, signExecutionAttestation, verifyAttestation, InMemoryReplayRegistry } from '../../../src/execution-attestation/index.js';
import type { ExecutionStatement } from '../../../src/execution-attestation/index.js';
import type {
  FirstPartyInstallPort,
  FirstPartyWorkflowManifest,
  InstallFirstPartyWorkflowsInput,
} from '../../../src/self-hosted-library/index.js';
import { installFirstPartyWorkflows } from '../../../src/self-hosted-library/index.js';
import type { WorkflowPrincipal, WorkflowVisibility, CreateWorkflowResult, InstallVersionResult, WorkflowVersion } from '../../../src/workflow-repository/index.js';

/**
 * V2-013 — shared deterministic fixtures for the self-hosted-library battery.
 *
 * Determinism rules (the V2-015 helpers' discipline):
 *   - every clock value is a fixed ISO-8601 UTC constant (injected, never wall);
 *   - every nonce/epoch is a fixed constant;
 *   - the attester keys are REAL Ed25519 key pairs generated once per test
 *     process (real cryptography; Ed25519 key material cannot be seeded);
 *     assertions are key-NORMALIZED (they never depend on which concrete
 *     key was generated, only on relations between the generated keys).
 *
 * The in-memory port mirrors V2-002's create-or-converge contract (the
 * unit-level installation surface; the integration battery composes the
 * REAL service through the REAL routes instead).
 */

// ---------------------------------------------------------------------------
// Injected clocks / freshness material (fixed constants)
// ---------------------------------------------------------------------------

export const DEV_EXECUTED_AT = '2026-09-03T08:00:00.000Z';
export const DEV_VALID_UNTIL = '2026-09-03T08:30:00.000Z';
export const DEV_ISSUED_AT = '2026-09-03T08:00:01.000Z';
export const DEV_VERIFY_NOW = '2026-09-03T08:00:10.000Z';
export const DEV_PACKAGING_NOW = '2026-09-03T08:00:30.000Z';
export const DEV_EPOCH = 11;

// ---------------------------------------------------------------------------
// Real Ed25519 attester key material (generated once per test process)
// ---------------------------------------------------------------------------

/** The self-hosted worker node's attester (the predecessor executor). */
export const DEV_ATTESTER = generateAttesterKeyPair();
/** An unrelated attester (trust-discrimination experiments). */
export const DEV_ATTESTER_UNTRUSTED = generateAttesterKeyPair();

/** The development environment tenant. */
export const DEV_TENANT = 'org-dev-environment';
export const DEV_PRINCIPAL: WorkflowPrincipal = { userId: 'dev-operator' };
export const DEV_PROTOCOL = { irSchemaVersion: 'wfos-ir-1' };
export const DEV_RUN_ID = 'wfr-dev-dogfood-0001';

// ---------------------------------------------------------------------------
// The statement scope fixture (dynamic: bound to the manifest under test)
// ---------------------------------------------------------------------------

export interface DevStatementScope {
  readonly workflowId: string;
  readonly workflowVersionId: string;
  readonly workflowVersionSemanticDigest: string;
  readonly runId: string;
}

export interface DevStatementOverrides {
  readonly stepId: string;
  readonly nodeId: string;
  readonly action: string;
  readonly nonce: string;
  readonly causalParents?: readonly string[];
  readonly executedAt?: string;
}

/** Build a canonical dev-scope statement (deterministic). */
export function buildDevStatement(scope: DevStatementScope, overrides: DevStatementOverrides): ExecutionStatement {
  return {
    objectType: 'workflowos/execution-statement/v1',
    statementSchemaVersion: 1,
    workflowId: scope.workflowId,
    workflowVersionId: scope.workflowVersionId,
    workflowVersionSemanticDigest: scope.workflowVersionSemanticDigest,
    deploymentId: 'wfd-dev-environment-1',
    runId: scope.runId,
    attemptId: 1,
    stepId: overrides.stepId,
    nodeId: overrides.nodeId,
    workloadIdentity: 'wl_dev-self-hosted-worker-2026-09',
    executionClass: 'deterministic_api',
    capability: 'filesystem.read',
    action: overrides.action,
    inputCommitments: ['596bb3f873a14be7efc2eb66facaab3a251d21eeb06238adbd61d4c3a2537ada'],
    outputCommitments: ['c505bcc8d5877e9c5cc131b94e79943209ac14789c38178ccba866a1d6a685c5'],
    observationCommitments: ['6c1fd184dbbee5241dbc3d325a23ee6badc37c2c83db38e5e470ec70e231f0a7'],
    evidenceReferences: [`wfev-dev-${overrides.stepId}-0001`],
    causalParents: overrides.causalParents ?? [],
    authorizationContextDigest: 'abdd1e25fd7bd9ceef609bba6930114fdda7c66f9d54a0edc1abf792bd70f94b',
    placementPolicyDigest: 'dc0db0cd08b83390711e7ca0cd41b1f6f07a04dc9a4e2ba7388d83901ed1c0d6',
    nonce: overrides.nonce,
    epoch: DEV_EPOCH,
    outcome: 'succeeded',
    executedAt: overrides.executedAt ?? DEV_EXECUTED_AT,
    validUntil: DEV_VALID_UNTIL,
  };
}

/** Sign a dev-scope statement with a real Ed25519 attester key. */
export function signDevStatement(statement: ExecutionStatement): ReturnType<typeof signExecutionAttestation> {
  return signExecutionAttestation({
    statement,
    attesterPrivateKey: DEV_ATTESTER.privateKey,
    attesterPublicKeyDer: DEV_ATTESTER.publicKeyDer,
    assurance: 'software_signed',
    issuedAt: DEV_ISSUED_AT,
  });
}

/** The baseline verification of a dev-scope attestation (fresh, trusted). */
export function verifyDevAttestation(
  attestation: ReturnType<typeof signExecutionAttestation>,
  scope: DevStatementScope,
  options: { replayRegistry?: InMemoryReplayRegistry; now?: string } = {},
) {
  return verifyAttestation(attestation, {
    bindings: {
      workflowId: scope.workflowId,
      workflowVersionId: scope.workflowVersionId,
      workflowVersionSemanticDigest: scope.workflowVersionSemanticDigest,
      runId: scope.runId,
      attemptId: 1,
      stepId: attestation.statement.stepId,
      nodeId: attestation.statement.nodeId,
    },
    freshness: {
      now: options.now ?? DEV_VERIFY_NOW,
      currentEpoch: DEV_EPOCH,
      replayRegistry: options.replayRegistry ?? new InMemoryReplayRegistry(),
      maxAgeMs: 60 * 60 * 1000,
    },
    attesterKeyIds: [DEV_ATTESTER.keyId],
    requiredAssurance: 'software_signed',
  });
}

// ---------------------------------------------------------------------------
// The in-memory install port (V2-002's create-or-converge contract)
// ---------------------------------------------------------------------------

export function makeFakePort(): FirstPartyInstallPort & { versionsOf(workflowId: string): string[] } {
  const workflows = new Map<string, { organizationId: string; slug: string; name: string; description: string; visibility: WorkflowVisibility; headVersionId: string }>();
  const versions = new Map<string, { workflowId: string; versionNumber: number; contentDigest: string; content: Record<string, unknown> }>();
  const installations = new Map<string, { organizationId: string; workflowId: string; versionId: string }>();
  let seq = 0;

  const port: FirstPartyInstallPort = {
    async createWorkflow(principal, input) {
      const existing = [...workflows.entries()].find(
        ([, w]) => w.organizationId === input.organizationId && w.slug === input.slug,
      );
      if (existing) {
        const [workflowId, workflow] = existing;
        const versionId = workflow.headVersionId;
        const version = versions.get(versionId)!;
        return {
          workflow: workflowRecord(workflowId, workflow, principal),
          initialVersion: versionRecord(versionId, workflowId, version, principal),
          created: false,
        };
      }
      const workflowId = `wfw-${++seq}`;
      const versionId = `wfwv-${++seq}`;
      const contentDigest = `digest-${input.slug}-v1`;
      workflows.set(workflowId, { organizationId: input.organizationId, slug: input.slug, name: input.name, description: input.description ?? '', visibility: input.visibility, headVersionId: versionId });
      versions.set(versionId, { workflowId, versionNumber: 1, contentDigest, content: input.content });
      return {
        workflow: workflowRecord(workflowId, workflows.get(workflowId)!, principal),
        initialVersion: versionRecord(versionId, workflowId, versions.get(versionId)!, principal),
        created: true,
      };
    },
    async createVersion(principal, workflowId, input) {
      const workflow = workflows.get(workflowId);
      if (!workflow) {
        throw new Error(`workflow ${workflowId} not found`);
      }
      const versionId = `wfwv-${++seq}`;
      const nextNumber = [...versions.values()].filter((v) => v.workflowId === workflowId).length + 1;
      const contentDigest = `digest-${workflow.slug}-v${nextNumber}`;
      versions.set(versionId, { workflowId, versionNumber: nextNumber, contentDigest, content: input.content });
      workflow.headVersionId = versionId;
      return {
        version: versionRecord(versionId, workflowId, versions.get(versionId)!, principal),
        created: true,
      };
    },
    async installVersion(principal, input) {
      // mirrors the REAL V2-002 contract: the installation identity derives
      // from (organizationId, versionId) — installing a DIFFERENT version of
      // the same workflow in the same tenant yields a DISTINCT installation
      // record pinning that version (installations never re-pin; the PR #160
      // residual Blocker-2 correction's target-installation read-back depends
      // on exactly this semantics)
      const existing = [...installations.entries()].find(
        ([, i]) => i.organizationId === input.organizationId && i.versionId === input.versionId,
      );
      if (existing) {
        const [installationId, installation] = existing;
        return {
          installation: installationRecord(installationId, installation, principal),
          created: false,
        };
      }
      const installationId = `wfin-${++seq}`;
      installations.set(installationId, { organizationId: input.organizationId, workflowId: input.workflowId, versionId: input.versionId });
      return {
        installation: installationRecord(installationId, installations.get(installationId)!, principal),
        created: true,
      };
    },
    async getInstallation(principal, organizationId, installationId) {
      const installation = installations.get(installationId);
      if (!installation || installation.organizationId !== organizationId) {
        throw new Error(`installation ${installationId} not found`);
      }
      const version = versions.get(installation.versionId)!;
      return {
        installation: installationRecord(installationId, installation, principal),
        pinnedVersion: {
          id: installation.versionId,
          workflowId: version.workflowId,
          versionNumber: version.versionNumber,
          contentDigest: version.contentDigest,
          protocol: { irSchemaVersion: DEV_PROTOCOL.irSchemaVersion },
        },
      };
    },
  };

  return Object.assign(port, {
    versionsOf(workflowId: string): string[] {
      return [...versions.entries()].filter(([, v]) => v.workflowId === workflowId).map(([id]) => id);
    },
  });
}

function workflowRecord(workflowId: string, workflow: { organizationId: string; slug: string; name: string; description: string; visibility: WorkflowVisibility; headVersionId: string }, principal: WorkflowPrincipal): CreateWorkflowResult['workflow'] {
  return {
    id: workflowId,
    organizationId: workflow.organizationId,
    slug: workflow.slug,
    name: workflow.name,
    description: workflow.description,
    visibility: workflow.visibility,
    ownerUserId: principal.userId,
    forkedFromWorkflowId: null,
    forkedFromVersionId: null,
    headVersionId: workflow.headVersionId,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function versionRecord(versionId: string, workflowId: string, version: { versionNumber: number; contentDigest: string; content: Record<string, unknown> }, principal: WorkflowPrincipal): WorkflowVersion {
  return {
    id: versionId,
    workflowId,
    versionNumber: version.versionNumber,
    contentDigest: version.contentDigest,
    content: version.content,
    protocol: { irSchemaVersion: DEV_PROTOCOL.irSchemaVersion },
    parentVersionId: null,
    createdByUserId: principal.userId,
    createdAt: new Date(0),
  };
}

function installationRecord(installationId: string, installation: { organizationId: string; workflowId: string; versionId: string }, principal: WorkflowPrincipal): InstallVersionResult['installation'] {
  return {
    id: installationId,
    organizationId: installation.organizationId,
    workflowId: installation.workflowId,
    versionId: installation.versionId,
    installedByUserId: principal.userId,
    status: 'enabled' as const,
    installedAt: new Date(0),
    updatedAt: new Date(0),
  };
}

// ---------------------------------------------------------------------------
// The installed dev-environment fixture (all six manifests over the fake port)
// ---------------------------------------------------------------------------

export interface DevEnvironment {
  readonly port: FirstPartyInstallPort;
  readonly input: InstallFirstPartyWorkflowsInput;
  readonly manifests: readonly FirstPartyWorkflowManifest[];
}

/** Install the full first-party library over a fresh fake port. */
export async function makeDevEnvironment(): Promise<DevEnvironment> {
  const port = makeFakePort();
  const input: InstallFirstPartyWorkflowsInput = {
    principal: DEV_PRINCIPAL,
    organizationId: DEV_TENANT,
    port,
    protocol: DEV_PROTOCOL,
  };
  const outcome = await installFirstPartyWorkflows(input);
  return { port, input, manifests: outcome.manifests };
}

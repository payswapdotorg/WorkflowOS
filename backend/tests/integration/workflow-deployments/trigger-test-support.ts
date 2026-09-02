/**
 * V2-009 — shared integration test support (NOT a test file).
 *
 * Real PGlite + ALL migrations (incl. 0062) + the real identity stack + the
 * merged V2-002 workflow repository + the merged V2-005 run service + the
 * merged V2-004 node directory (real registration protocol) + the V2-009
 * deployment service, all over ONE shared deterministic clock (the run
 * boundary, the trigger boundary and the node directory observe the same
 * injected epoch). Mirrors the V2-005 harness discipline.
 */
import { createHash } from 'node:crypto';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import {
  DefaultWorkflowRepositoryService,
  type OrganizationMembershipResolver,
  type WorkflowRepositoryService,
} from '../../../src/workflow-repository/index.js';
import {
  DefaultWorkflowRunService,
  type WorkflowRunService,
} from '../../../src/workflow-runs/index.js';
import {
  DefaultNodeCapabilityService,
  InMemoryNodeKeyStore,
  InMemoryNodeRecordStore,
  makeSequentialNonceSource,
  computeRegistrationResponse,
  type CapabilityAdvertisement,
  type NodeCapabilityService,
  type NodeDeclaredAttributes,
  type NodePlatformClass,
  type NodeTrustTier,
} from '../../../src/node-capability/index.js';
import {
  DefaultWorkflowDeploymentService,
  formatUtcTimestamp,
  type WorkflowDeploymentService,
} from '../../../src/workflow-deployments/index.js';
import {
  createWorkflowIrBuilder,
  serializeWorkflowIrDocument,
  type WorkflowIrDocument,
  type WorkflowNode,
} from '../../../src/workflow-ir/index.js';

/** Deterministic shared clock base: 2026-09-01T12:00:00.000Z. */
export const TRIGGER_CLOCK_BASE_MS = 1788264000000;
/** Deterministic freshness epoch for the run boundary. */
export const TRIGGER_TEST_EPOCH = 7;

/** The one shared injected clock (all boundaries observe the same epoch). */
export interface SharedClock {
  /** The V2-005/V2-009 fixed-format UTC clock. */
  readonly utc: () => string;
  /** The V2-004 epoch clock. */
  readonly epoch: () => number;
  /** Advance the shared epoch (ms) — every boundary sees the advance. */
  readonly advance: (ms: number) => void;
  /** The current epoch (ms). */
  readonly now: () => number;
}

export function sharedClock(baseMs: number = TRIGGER_CLOCK_BASE_MS): SharedClock {
  let t = baseMs;
  return {
    utc: () => formatUtcTimestamp(t),
    epoch: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    now: () => t,
  };
}

/** sha-256 hex over a test value (real one-way commitment, no raw payload). */
export function commitmentOf(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

// ============================================================================
// The workflow fixture (authored through the real V2-003 builder)
// ============================================================================

const notifyNode: WorkflowNode = {
  id: 'notify_channel',
  executionClass: 'deterministic_api',
  spec: { class: 'deterministic_api', capability: 'messaging.send' },
  capabilityRequirements: ['messaging.send'],
  placement: 'cloud_allowed',
  inputs: [],
  outputs: [{ name: 'messageId', type: { kind: 'string' } }],
  failurePolicy: { strategy: 'fail_workflow' },
  completionEvidence: 'observation',
};

const approveNode: WorkflowNode = {
  id: 'approve_gate',
  executionClass: 'human',
  spec: { class: 'human', human: { kind: 'approval', instruction: 'Approve the notification.' } },
  capabilityRequirements: [],
  placement: 'device_local',
  inputs: [],
  outputs: [{ name: 'approved', type: { kind: 'boolean' } }],
  failurePolicy: { strategy: 'fail_workflow' },
  completionEvidence: 'human_confirmation',
};

/** The cloud-agnostic fixture: one cloud_allowed step (placeable anywhere). */
export function authorNotifyDocument(): WorkflowIrDocument {
  return createWorkflowIrBuilder()
    .withStart('notify_channel')
    .addWorkflowInput({ name: 'message', type: { kind: 'string' } })
    .addNode(notifyNode)
    .build();
}

/** The locality-mixed fixture: device_local approval + cloud notification. */
export function authorMixedLocalityDocument(): WorkflowIrDocument {
  return createWorkflowIrBuilder()
    .withStart('approve_gate')
    .addWorkflowInput({ name: 'message', type: { kind: 'string' } })
    .addNode(approveNode)
    .addNode(notifyNode)
    // Approval nodes route control through OUTCOME edges only (V2-007
    // compiler policy) and must cover BOTH declared outcomes.
    .addEdge({ from: 'approve_gate', to: 'notify_channel', on: { outcome: 'approved' } })
    .addEdge({ from: 'approve_gate', to: 'notify_channel', on: { outcome: 'rejected' } })
    .build();
}

/** The version content exactly as the repository stores it (opaque JSON). */
export function versionContentOf(document: WorkflowIrDocument): Record<string, unknown> {
  return JSON.parse(serializeWorkflowIrDocument(document)) as Record<string, unknown>;
}

// ============================================================================
// Device node registration (the REAL V2-004 protocol path)
// ============================================================================

/** Deterministic node key material for a test seed (real SHA-256 bytes). */
export function testNodeSecret(seed: string): Uint8Array {
  return createHash('sha256').update(`v2-009-test-node-key:${seed}`).digest();
}

export interface RegisteredNode {
  readonly nodeId: string;
  readonly sessionToken: string;
}

/** Register a node through the real protocol (enroll → challenge → HMAC → trust). */
export function registerNode(
  service: NodeCapabilityService,
  seed: string,
  platformClass: NodePlatformClass,
  options?: {
    readonly capabilities?: readonly CapabilityAdvertisement[];
    readonly trustTier?: NodeTrustTier;
    readonly attributes?: NodeDeclaredAttributes;
  },
): RegisteredNode {
  const secret = testNodeSecret(seed);
  const { nodeKeyFingerprint } = service.enrollNodeKey({ nodeKeySecret: secret });
  const challenge = service.requestRegistrationChallenge({ nodeKeyFingerprint });
  const payload = {
    nodeKeyFingerprint,
    platformClass,
    protocolVersion: 1,
    capabilities:
      options?.capabilities ?? [
        { name: 'messaging.send', version: 1, availability: 'available' as const },
      ],
    attributes: options?.attributes ?? { supportsHumanApproval: true, health: 'healthy' as const },
  };
  const response = computeRegistrationResponse({ nodeKeySecret: secret, payload, nonce: challenge.nonce });
  const session = service.completeRegistration({ ...payload, challengeNonce: challenge.nonce, response });
  service.setNodeTrustAttributes({ nodeId: session.nodeId, trustTier: options?.trustTier ?? 'trusted' });
  return { nodeId: session.nodeId, sessionToken: session.sessionToken };
}

// ============================================================================
// The full stack
// ============================================================================

export interface TriggerTestStack {
  readonly stack: TestAuthStack;
  readonly memberships: OrganizationMembershipResolver;
  readonly repository: WorkflowRepositoryService;
  readonly runs: WorkflowRunService;
  readonly nodes: NodeCapabilityService;
  readonly deployments: WorkflowDeploymentService;
  /** A FRESH isolated node directory over the SAME shared clock (placement
   *  isolation for the no-eligible-node / offline-device regressions). */
  readonly freshNodes: () => NodeCapabilityService;
  /** A deployment service over a caller-supplied node directory. */
  readonly makeDeployments: (nodes: NodeCapabilityService) => WorkflowDeploymentService;
  readonly clock: SharedClock;
  readonly orgAId: string;
  readonly orgBId: string;
  readonly ownerAId: string;
  readonly memberAId: string;
  readonly userBId: string;
  readonly teardown: () => Promise<void>;
}

export async function buildTriggerTestStack(
  setEnvSecrets: Record<string, string> = {},
): Promise<TriggerTestStack> {
  const stack = await buildAuthStack(setEnvSecrets);
  const memberships: OrganizationMembershipResolver = {
    isMember: async (userId, organizationId) =>
      (await stack.membershipRepository.findByUserAndOrganization(userId, organizationId)) !== null,
  };
  const repository = new DefaultWorkflowRepositoryService({ db: stack.db.client, memberships });
  const clock = sharedClock();

  const orgA = await stack.organizationRepository.create({ name: 'V2-009 Org A' });
  const orgB = await stack.organizationRepository.create({ name: 'V2-009 Org B' });
  const ownerA = await stack.userRepository.upsertByExternalId({
    externalId: 'v2-009-owner-a',
    displayName: 'Owner A',
  });
  const memberA = await stack.userRepository.upsertByExternalId({
    externalId: 'v2-009-member-a',
    displayName: 'Member A',
  });
  const userB = await stack.userRepository.upsertByExternalId({
    externalId: 'v2-009-user-b',
    displayName: 'User B',
  });
  await stack.membershipRepository.assign({ userId: ownerA.id, organizationId: orgA.id, roleId: 'owner' });
  await stack.membershipRepository.assign({ userId: memberA.id, organizationId: orgA.id, roleId: 'member' });
  await stack.membershipRepository.assign({ userId: userB.id, organizationId: orgB.id, roleId: 'owner' });

  const runs = new DefaultWorkflowRunService({
    db: stack.db.client,
    memberships,
    workflowRepository: repository,
    clock: { now: () => clock.utc() },
    currentEpoch: TRIGGER_TEST_EPOCH,
  });

  const nodes = new DefaultNodeCapabilityService({
    clock: clock.epoch,
    nonceSource: makeSequentialNonceSource(),
    keyStore: new InMemoryNodeKeyStore(),
    nodeStore: new InMemoryNodeRecordStore(),
    // Test-harness lease: devices stay live across the shared clock's
    // cumulative advances (the Accra wall-clock test alone advances ~20h;
    // the real platform heartbeats; the offline-device regression uses
    // ABSENCE of registration, not lease expiry).
    heartbeatLeaseTtlMs: 365 * 86_400_000,
  });

  const makeDeploymentsFor = (nodeDirectory: NodeCapabilityService) =>
    new DefaultWorkflowDeploymentService({
      db: stack.db.client,
      memberships,
      workflowRepository: repository,
      runs,
      nodes: nodeDirectory,
      clock: { now: () => clock.utc() },
    });

  const deployments = makeDeploymentsFor(nodes);

  const freshNodes = () =>
    new DefaultNodeCapabilityService({
      clock: clock.epoch,
      nonceSource: makeSequentialNonceSource(),
      keyStore: new InMemoryNodeKeyStore(),
      nodeStore: new InMemoryNodeRecordStore(),
      heartbeatLeaseTtlMs: 3_600_000,
    });

  return {
    stack,
    memberships,
    repository,
    runs,
    nodes,
    deployments,
    freshNodes,
    makeDeployments: makeDeploymentsFor,
    clock,
    orgAId: orgA.id,
    orgBId: orgB.id,
    ownerAId: ownerA.id,
    memberAId: memberA.id,
    userBId: userB.id,
    teardown: stack.teardown,
  };
}

/**
 * A fresh isolated tenant (org + owner) — every test drives the ORG-SCOPED
 * tick sweep, so per-test orgs keep the sweep's pending-retry accounting
 * isolated from sibling tests.
 */
export async function createTenant(
  support: TriggerTestStack,
  label: string,
): Promise<{ organizationId: string; ownerUserId: string }> {
  const org = await support.stack.organizationRepository.create({ name: `V2-009 ${label}` });
  const owner = await support.stack.userRepository.upsertByExternalId({
    externalId: `v2-009-${label}-owner`,
    displayName: `Owner ${label}`,
  });
  await support.stack.membershipRepository.assign({
    userId: owner.id,
    organizationId: org.id,
    roleId: 'owner',
  });
  return { organizationId: org.id, ownerUserId: owner.id };
}

/** Create + install (pin) the notify workflow v1 in a tenant (owner principal). */
export async function createPinnedNotifyWorkflow(
  support: TriggerTestStack,
  tenant: { organizationId: string; ownerUserId: string },
): Promise<{ workflowId: string; versionId: string; installationId: string }> {
  const principal = { userId: tenant.ownerUserId };
  const created = await support.repository.createWorkflow(principal, {
    organizationId: tenant.organizationId,
    slug: `notify-${tenant.organizationId.slice(0, 8)}`,
    name: 'Notify workflow',
    description: 'The V2-009 test fixture',
    visibility: 'private',
    content: versionContentOf(authorNotifyDocument()),
    protocol: { irSchemaVersion: 'test-ir-1' },
  });
  const workflowId = created.workflow.id;
  const versionId = created.workflow.headVersionId!;
  const installed = await support.repository.installVersion(principal, {
    organizationId: tenant.organizationId,
    workflowId,
    versionId,
  });
  return { workflowId, versionId, installationId: installed.installation.id };
}

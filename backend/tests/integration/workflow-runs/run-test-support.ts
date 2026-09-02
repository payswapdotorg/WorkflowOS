/**
 * V2-005 — shared integration test support (NOT a test file).
 *
 * Real PGlite + ALL migrations (incl. 0061) + the real identity stack + the
 * merged V2-002 workflow repository service + the V2-005 run service with
 * INJECTED deterministic clock/epoch. Mirrors the V2-002/V2-006 harnesses.
 */
import { createHash } from 'node:crypto';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import {
  DefaultWorkflowRepositoryService,
  type OrganizationMembershipResolver,
  type WorkflowRepositoryService,
  type WorkflowVersion,
} from '../../../src/workflow-repository/index.js';
import {
  DefaultWorkflowRunService,
  createSteppingRunClock,
  type WorkflowRunService,
  type WorkflowRunClock,
  type RunCommandEnvelope,
} from '../../../src/workflow-runs/index.js';
import {
  createWorkflowIrBuilder,
  serializeWorkflowIrDocument,
  type WorkflowIrDocument,
  type WorkflowNode,
} from '../../../src/workflow-ir/index.js';

/** Deterministic injected clock base: 2026-09-01T12:00:00.000Z. */
export const RUN_CLOCK_BASE_MS = 1788264000000;
export const RUN_CLOCK_STEP_MS = 1000;
/** Deterministic freshness epoch for the run boundary. */
export const RUN_TEST_EPOCH = 7;

/** sha-256 hex over a test value (real one-way commitment, no raw payload). */
export function commitmentOf(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Deterministic command envelopes (correlation = the trigger identity). */
export function envelope(n: number, correlationId: string): RunCommandEnvelope {
  return {
    commandId: `cmd-test-${String(n).padStart(4, '0')}`,
    correlationId,
  };
}

const fetchNode: WorkflowNode = {
  id: 'fetch_issue',
  executionClass: 'deterministic_api',
  spec: { class: 'deterministic_api', capability: 'github.repository.read' },
  capabilityRequirements: ['github.repository.read'],
  placement: 'cloud_allowed',
  inputs: [
    { name: 'repository', type: { kind: 'string' }, binding: { kind: 'literal', value: 'pectoraux/WorkflowOS' } },
    { name: 'issueUrl', type: { kind: 'string' }, binding: { kind: 'workflow_input', input: 'issueUrl' } },
  ],
  outputs: [{ name: 'issue', type: { kind: 'string' } }],
  failurePolicy: { strategy: 'fail_workflow' },
  completionEvidence: 'observation',
};

const reviewNode: WorkflowNode = {
  id: 'review_gate',
  executionClass: 'human',
  spec: { class: 'human', human: { kind: 'approval', instruction: 'Approve posting the triage summary.' } },
  capabilityRequirements: [],
  placement: 'device_local',
  inputs: [],
  outputs: [{ name: 'approved', type: { kind: 'boolean' } }],
  failurePolicy: { strategy: 'fail_workflow' },
  completionEvidence: 'human_confirmation',
};

const notifyNode: WorkflowNode = {
  id: 'notify_channel',
  executionClass: 'deterministic_api',
  spec: { class: 'deterministic_api', capability: 'messaging.send' },
  capabilityRequirements: ['messaging.send'],
  placement: 'cloud_preferred',
  inputs: [],
  outputs: [{ name: 'messageId', type: { kind: 'string' } }],
  failurePolicy: { strategy: 'fail_workflow' },
  completionEvidence: 'verification',
};

/** The canonical test workflow: 3 declared steps (deterministic/human/deterministic). */
export function authorTriageDocument(): WorkflowIrDocument {
  return createWorkflowIrBuilder()
    .withStart('fetch_issue')
    .addWorkflowInput({ name: 'issueUrl', type: { kind: 'string' } })
    .addNode(fetchNode)
    .addNode(reviewNode)
    .addNode(notifyNode)
    .addEdge({ from: 'fetch_issue', to: 'review_gate', on: 'success' })
    .addEdge({ from: 'review_gate', to: 'notify_channel', on: { outcome: 'approved' } })
    // An approval node must cover BOTH declared outcomes (V2-003
    // IR_HUMAN_OUTCOME_UNCOVERED); the rejected branch also routes to the
    // notification step — fixture-only, keeps the 3-declared-step set.
    .addEdge({ from: 'review_gate', to: 'notify_channel', on: { outcome: 'rejected' } })
    .build();
}

/** The version content exactly as the repository stores it (opaque JSON). */
export function triageVersionContent(): Record<string, unknown> {
  return JSON.parse(serializeWorkflowIrDocument(authorTriageDocument())) as Record<string, unknown>;
}

export interface WorkflowRunTestStack {
  stack: TestAuthStack;
  memberships: OrganizationMembershipResolver;
  repository: WorkflowRepositoryService;
  /** A fresh service instance over the SAME database (crash-recovery proof). */
  freshRunService: (clock?: WorkflowRunClock) => WorkflowRunService;
  orgAId: string;
  orgBId: string;
  ownerAId: string;
  memberAId: string;
  userBId: string;
  teardown: () => Promise<void>;
}

export async function buildWorkflowRunTestStack(): Promise<WorkflowRunTestStack> {
  const stack = await buildAuthStack({});
  const memberships: OrganizationMembershipResolver = {
    isMember: async (userId, organizationId) =>
      (await stack.membershipRepository.findByUserAndOrganization(userId, organizationId)) !== null,
  };
  const repository = new DefaultWorkflowRepositoryService({ db: stack.db.client, memberships });

  const orgA = await stack.organizationRepository.create({ name: 'V2-005 Org A' });
  const orgB = await stack.organizationRepository.create({ name: 'V2-005 Org B' });
  const ownerA = await stack.userRepository.upsertByExternalId({
    externalId: 'v2-005-owner-a',
    displayName: 'Owner A',
  });
  const memberA = await stack.userRepository.upsertByExternalId({
    externalId: 'v2-005-member-a',
    displayName: 'Member A',
  });
  const userB = await stack.userRepository.upsertByExternalId({
    externalId: 'v2-005-user-b',
    displayName: 'User B',
  });
  await stack.membershipRepository.assign({ userId: ownerA.id, organizationId: orgA.id, roleId: 'owner' });
  await stack.membershipRepository.assign({ userId: memberA.id, organizationId: orgA.id, roleId: 'member' });
  await stack.membershipRepository.assign({ userId: userB.id, organizationId: orgB.id, roleId: 'owner' });

  const makeService = (clock?: WorkflowRunClock) =>
    new DefaultWorkflowRunService({
      db: stack.db.client,
      memberships,
      workflowRepository: repository,
      clock: clock ?? createSteppingRunClock(RUN_CLOCK_BASE_MS, RUN_CLOCK_STEP_MS),
      currentEpoch: RUN_TEST_EPOCH,
    });

  return {
    stack,
    memberships,
    repository,
    freshRunService: makeService,
    orgAId: orgA.id,
    orgBId: orgB.id,
    ownerAId: ownerA.id,
    memberAId: memberA.id,
    userBId: userB.id,
    teardown: stack.teardown,
  };
}

/** Create the canonical triage workflow v1 in org A (owner principal). */
export async function createTriageWorkflow(
  stack: WorkflowRunTestStack,
  slug: string,
): Promise<{ workflowId: string; version: WorkflowVersion }> {
  const created = await stack.repository.createWorkflow({ userId: stack.ownerAId }, {
    organizationId: stack.orgAId,
    slug,
    name: `Triage ${slug}`,
    description: null,
    visibility: 'organization',
    content: triageVersionContent(),
    protocol: { irSchemaVersion: 'test-ir-1' },
  });
  return { workflowId: created.workflow.id, version: created.initialVersion };
}

/** A manual clock for attachment-freshness-sensitive tests. */
export function createManualClock(initial: string): WorkflowRunClock & { setNow(next: string): void } {
  let current = initial;
  return {
    now: () => current,
    setNow(next: string) {
      current = next;
    },
  };
}

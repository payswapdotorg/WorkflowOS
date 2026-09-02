import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { buildServer } from '@api/server.js';
import {
  DefaultWorkflowRepositoryService,
  type OrganizationMembershipResolver,
} from '../../../src/workflow-repository/index.js';
import {
  createWorkflowIrBuilder,
  computeWorkflowVersionSemanticDigest,
  parseWorkflowIrDocument,
  serializeWorkflowIrDocument,
} from '../../../src/workflow-ir/index.js';
import {
  DefaultTeachingSessionService,
  InMemoryTeachingSessionStore,
  createSequentialIdFactory,
  createSteppingClock,
  TEACHING_EVIDENCE_CLASS,
} from '../../../src/teaching-sessions/index.js';
import type { FastifyInstance } from 'fastify';
import type { WorkflowIrDocument } from '../../../src/workflow-ir/index.js';

/**
 * V2-006 — install-and-teach INTEGRATION test (real product paths).
 *
 * The real install path: the MERGED V2-002 workflow-repository through its
 * real Fastify route (app.inject) over a real PGlite database with all
 * migrations — a real authored WorkflowIR workflow is installed and pinned.
 *
 * The real teaching path: a TeachingSession created from the installed
 * immutable version through the V2-006 public API, then taught end-to-end
 * (lesson derivation → practice rejection/correction → checkpoint
 * confirmations → pause/resume to the exact checkpoint → independent
 * performance assessment), with the version re-read over HTTP afterwards to
 * prove teaching never mutated the installed workflow.
 */

const OPERATOR_KEY = 'raw-key-v2-006-operator';

interface VersionPayload {
  id: string;
  workflowId: string;
  versionNumber: number;
  contentDigest: string;
  content: Record<string, unknown>;
}

/** A real authored workflow: "triage an inbound support ticket" (merged V2-003 builder path). */
function authorSupportTriageDocument(): WorkflowIrDocument {
  const ticketObjectType = {
    kind: 'object',
    fields: [
      { name: 'ticketId', type: { kind: 'string' } },
      { name: 'body', type: { kind: 'string' } },
    ],
  } as const;
  return createWorkflowIrBuilder()
    .withStart('fetch_ticket')
    .addWorkflowInput({ name: 'ticketUrl', type: { kind: 'string' } })
    .addWorkflowOutput({
      name: 'messageId',
      type: { kind: 'string' },
      from: { kind: 'node_output', node: 'send_reply', output: 'messageId' },
    })
    .addNode({
      id: 'fetch_ticket',
      executionClass: 'deterministic_api',
      spec: { class: 'deterministic_api', capability: 'github.repository.read' },
      capabilityRequirements: ['github.repository.read'],
      placement: 'cloud_allowed',
      inputs: [
        { name: 'repository', type: { kind: 'string' }, binding: { kind: 'literal', value: 'pectoraux/WorkflowOS' } },
        { name: 'ticketUrl', type: { kind: 'string' }, binding: { kind: 'workflow_input', input: 'ticketUrl' } },
      ],
      outputs: [{ name: 'ticket', type: ticketObjectType }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'observation',
    })
    .addNode({
      id: 'draft_reply',
      executionClass: 'agentic_computer_use',
      spec: { class: 'agentic_computer_use', task: 'Draft a support reply and a severity classification for the ticket.' },
      capabilityRequirements: ['github.repository.read'],
      placement: 'cloud_allowed',
      inputs: [
        { name: 'ticket', type: ticketObjectType, binding: { kind: 'node_output', node: 'fetch_ticket', output: 'ticket' } },
      ],
      outputs: [
        { name: 'reply', type: { kind: 'string' } },
        { name: 'severity', type: { kind: 'string' } },
      ],
      failurePolicy: { strategy: 'retry_then_fail_workflow', maxAttempts: 2 },
      completionEvidence: 'verification',
    })
    .addNode({
      id: 'human_review',
      executionClass: 'human',
      spec: {
        class: 'human',
        human: {
          kind: 'approval',
          instruction: 'Approve sending the drafted support reply and syncing the backlog.',
        },
      },
      capabilityRequirements: [],
      placement: 'device_local',
      inputs: [],
      outputs: [{ name: 'approved', type: { kind: 'boolean' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'human_confirmation',
    })
    .addNode({
      id: 'send_reply',
      executionClass: 'deterministic_api',
      spec: { class: 'deterministic_api', capability: 'messaging.send' },
      capabilityRequirements: ['messaging.send'],
      placement: 'cloud_preferred',
      inputs: [
        { name: 'text', type: { kind: 'string' }, binding: { kind: 'node_output', node: 'draft_reply', output: 'reply' } },
        { name: 'credentials', type: { kind: 'secret' }, binding: { kind: 'secret_ref', ref: 'support-bot@secrets' } },
      ],
      outputs: [{ name: 'messageId', type: { kind: 'string' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'verification',
    })
    .addNode({
      id: 'escalate_backlog',
      executionClass: 'subworkflow',
      spec: {
        class: 'subworkflow',
        subworkflow: { workflowId: 'wf-backlog-sync', versionRef: 'wfv_0192_backlog_sync_v1' },
      },
      capabilityRequirements: ['workflow.execute'],
      placement: 'any_supported_node',
      inputs: [
        { name: 'summary', type: { kind: 'string' }, binding: { kind: 'node_output', node: 'draft_reply', output: 'severity' } },
      ],
      outputs: [{ name: 'backlogRef', type: { kind: 'string' } }],
      failurePolicy: { strategy: 'retry_then_fail_workflow', maxAttempts: 3 },
    })
    .addNode({
      id: 'log_miss',
      executionClass: 'deterministic_api',
      spec: { class: 'deterministic_api', capability: 'filesystem.write' },
      capabilityRequirements: ['filesystem.write'],
      placement: 'device_local',
      inputs: [
        { name: 'path', type: { kind: 'string' }, binding: { kind: 'literal', value: 'missed-replies.log' } },
        { name: 'content', type: { kind: 'string' }, binding: { kind: 'node_output', node: 'draft_reply', output: 'reply' } },
      ],
      outputs: [],
      failurePolicy: { strategy: 'ignore_and_continue' },
    })
    .addEdge({ from: 'fetch_ticket', to: 'draft_reply', on: 'success' })
    .addEdge({ from: 'draft_reply', to: 'human_review', on: 'success' })
    .addEdge({ from: 'human_review', to: 'send_reply', on: { outcome: 'approved' } })
    .addEdge({ from: 'human_review', to: 'escalate_backlog', on: { outcome: 'approved' } })
    .addEdge({ from: 'human_review', to: 'log_miss', on: { outcome: 'rejected' } })
    .build();
}

describe('V2-006 — install one real workflow via the real V2-002 route and teach it', () => {
  let stack: TestAuthStack;
  let server: FastifyInstance;
  let orgId: string;
  let operatorKey: string;

  beforeAll(async () => {
    stack = await buildAuthStack({
      WFOS_TEST_KEY_V2_006_A: OPERATOR_KEY,
    });
    const org = await stack.organizationRepository.create({ name: 'V2-006 Install-and-Teach Org' });
    const operator = await stack.userRepository.upsertByExternalId({
      externalId: 'v2-006-operator',
      displayName: 'V2-006 Operator',
    });
    await stack.membershipRepository.assign({ userId: operator.id, organizationId: org.id, roleId: 'owner' });
    await stack.apiKeyProvisioner.provision({
      keyId: 'v2-006-key-a', secretRef: 'WFOS_TEST_KEY_V2_006_A', externalId: 'v2-006-operator',
      label: 'V2-006 A', rawKey: OPERATOR_KEY,
    });
    orgId = org.id;
    operatorKey = OPERATOR_KEY;

    const memberships: OrganizationMembershipResolver = {
      isMember: async (userId, organizationId) =>
        (await stack.membershipRepository.findByUserAndOrganization(userId, organizationId)) !== null,
    };
    const service = new DefaultWorkflowRepositoryService({ db: stack.db.client, memberships });
    server = await buildServer({
      queue: stack.db.client as never,
      logger: stack.db.logger,
      auth: { authProvider: stack.authProvider, userRepository: stack.userRepository },
      workflowRepository: { workflowRepositoryService: service },
    });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    await stack.teardown();
  });

  it('the full real path: install → pin → teach (practice correction, pause/resume, assessment) → no mutation', async () => {
    // --- 1. INSTALL a real authored workflow through the real V2-002 route ---
    const document = authorSupportTriageDocument();
    const serialized = serializeWorkflowIrDocument(document);
    const createRes = await server.inject({
      method: 'POST',
      url: `/organizations/${orgId}/workflow-repository/workflows`,
      headers: { 'x-api-key': operatorKey },
      payload: {
        slug: 'support-ticket-triage',
        name: 'Support Ticket Triage',
        description: 'Triage an inbound support ticket and reply',
        visibility: 'private',
        content: JSON.parse(serialized) as Record<string, unknown>,
        protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
      },
    });
    expect(createRes.statusCode).toBe(201);
    const created = createRes.json() as {
      workflow: { id: string; headVersionId: string };
      initialVersion: VersionPayload;
    };
    const workflowId = created.workflow.id;
    const version1 = created.initialVersion;
    expect(version1.versionNumber).toBe(1);

    // --- 2. READ the installed immutable version back over HTTP -----------
    const readRes = await server.inject({
      method: 'GET',
      url: `/workflow-repository/workflows/${workflowId}/versions/${version1.id}`,
      headers: { 'x-api-key': operatorKey },
    });
    expect(readRes.statusCode).toBe(200);
    const versionBodyBefore = readRes.body;
    const readVersion = (readRes.json() as { version: VersionPayload }).version;

    // --- 3. PIN the session to the installed version (semantic digest via
    //        the merged V2-003 barrel, carried as data) ---------------------
    const parsed = parseWorkflowIrDocument(JSON.stringify(readVersion.content));
    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
    if (!parsed.ok) throw new Error('unreachable');
    const installedDocument = parsed.document;
    const semanticDigest = computeWorkflowVersionSemanticDigest(installedDocument);
    expect(semanticDigest.digest).toMatch(/^[0-9a-f]{64}$/);

    const teaching = new DefaultTeachingSessionService({
      idFactory: createSequentialIdFactory('ts'),
      clock: createSteppingClock(1733568000000, 1000),
      store: new InMemoryTeachingSessionStore(),
    });
    const session = teaching.createSession({
      learnerId: 'v2-006-operator',
      pinned: { workflowId, versionId: version1.id, semanticDigest },
    });

    // --- 4. TEACH: begin the lesson from the installed content ------------
    const begun = teaching.beginLesson({ sessionId: session.id, document: installedDocument });
    expect(begun.status).toBe('in_progress');
    const lesson = teaching.getLesson({ sessionId: session.id, learnerId: 'v2-006-operator' });
    expect(lesson.steps.map((step) => step.nodeId)).toEqual([
      'fetch_ticket', 'draft_reply', 'human_review', 'escalate_backlog', 'log_miss', 'send_reply',
    ]);
    // The deterministic_api step discloses its missing human-readable rationale.
    const fetchStep = lesson.steps.find((step) => step.nodeId === 'fetch_ticket')!;
    expect(fetchStep.disclosures.map((d) => d.field)).toContain('step_human_readable_semantics');

    // --- 5. PRACTICE: one deliberately INCORRECT answer, then the correct one
    const incorrect = teaching.attemptPractice({
      sessionId: session.id,
      learnerId: 'v2-006-operator',
      nodeId: 'fetch_ticket',
      answer: 'messaging.send',
    });
    expect(incorrect.outcome).toBe('incorrect');
    if (incorrect.outcome === 'incorrect') {
      expect(incorrect.declaredSemantic).toBe('github.repository.read');
    }
    const corrected = teaching.attemptPractice({
      sessionId: session.id,
      learnerId: 'v2-006-operator',
      nodeId: 'fetch_ticket',
      answer: 'github.repository.read',
    });
    expect(corrected.outcome).toBe('correct');

    // --- 6. CONFIRM checkpoints in order, pausing/resuming mid-session ----
    for (const step of lesson.steps) {
      if (step.nodeId === 'human_review') {
        const paused = teaching.pauseSession({ sessionId: session.id, learnerId: 'v2-006-operator' });
        expect(paused.status).toBe('paused');
        const resumed = teaching.resumeSession({ sessionId: session.id, learnerId: 'v2-006-operator' });
        expect(resumed.resumeCheckpointNodeId).toBe('human_review');
      }
      teaching.confirmCheckpoint({ sessionId: session.id, learnerId: 'v2-006-operator', nodeId: step.nodeId });
    }

    // --- 7. INDEPENDENT PERFORMANCE ASSESSMENT -----------------------------
    const declaredSemantics: Record<string, string> = {
      fetch_ticket: 'github.repository.read',
      draft_reply: 'Draft a support reply and a severity classification for the ticket.',
      human_review: 'Approve sending the drafted support reply and syncing the backlog.',
      send_reply: 'messaging.send',
      escalate_backlog: 'wf-backlog-sync@wfv_0192_backlog_sync_v1',
      log_miss: 'filesystem.write',
    };
    const assessment = teaching.submitIndependentPerformance({
      sessionId: session.id,
      learnerId: 'v2-006-operator',
      orderedStepIds: lesson.stepOrder,
      semanticsByStep: declaredSemantics,
    });
    expect(assessment.passed).toBe(true);
    expect(assessment.sessionStatus).toBe('completed');

    // --- 8. TEACHING EVIDENCE: distinct typed records, never execution ----
    const finalSession = teaching.getSession({ sessionId: session.id, learnerId: 'v2-006-operator' });
    expect(finalSession.evidence.length).toBe(9); // 2 practice + 6 confirmations + 1 assessment
    for (const record of finalSession.evidence) {
      expect(record.evidenceClass).toBe(TEACHING_EVIDENCE_CLASS);
    }

    // --- 9. NO MUTATION: the installed version is byte-identical after teaching
    const readAfter = await server.inject({
      method: 'GET',
      url: `/workflow-repository/workflows/${workflowId}/versions/${version1.id}`,
      headers: { 'x-api-key': operatorKey },
    });
    expect(readAfter.statusCode).toBe(200);
    expect(readAfter.body).toBe(versionBodyBefore);
    const versionAfter = (readAfter.json() as { version: VersionPayload }).version;
    expect(versionAfter.contentDigest).toBe(version1.contentDigest);
    // The pinned semantic digest still matches the unchanged installed content.
    expect(computeWorkflowVersionSemanticDigest(installedDocument).digest).toBe(semanticDigest.digest);
  });

  it('version pinning over the real route: a NEWER version exists and is REJECTED as teaching content', async () => {
    const document = authorSupportTriageDocument();
    const createRes = await server.inject({
      method: 'POST',
      url: `/organizations/${orgId}/workflow-repository/workflows`,
      headers: { 'x-api-key': operatorKey },
      payload: {
        slug: 'pinning-check',
        name: 'Pinning Check',
        visibility: 'private',
        content: JSON.parse(serializeWorkflowIrDocument(document)) as Record<string, unknown>,
        protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
      },
    });
    const created = createRes.json() as { workflow: { id: string }; initialVersion: VersionPayload };
    const workflowId = created.workflow.id;

    // Edit: a new immutable version (v2) through the real route.
    const editedDocument = createWorkflowIrBuilder()
      .withStart('observe_only')
      .addWorkflowInput({ name: 'pageUrl', type: { kind: 'string' } })
      .addNode({
        id: 'observe_only',
        executionClass: 'deterministic_api',
        spec: { class: 'deterministic_api', capability: 'browser.observe' },
        capabilityRequirements: ['browser.observe'],
        placement: 'any_supported_node',
        inputs: [
          { name: 'url', type: { kind: 'string' }, binding: { kind: 'workflow_input', input: 'pageUrl' } },
        ],
        outputs: [{ name: 'pageText', type: { kind: 'string' } }],
        failurePolicy: { strategy: 'fail_workflow' },
      })
      .build();
    const editRes = await server.inject({
      method: 'POST',
      url: `/workflow-repository/workflows/${workflowId}/versions`,
      headers: { 'x-api-key': operatorKey },
      payload: {
        content: JSON.parse(serializeWorkflowIrDocument(editedDocument)) as Record<string, unknown>,
        protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
      },
    });
    expect(editRes.statusCode).toBe(201);
    const version2 = (editRes.json() as { version: VersionPayload }).version;

    // Pin a teaching session to v1, then attempt to begin with v2 content.
    const teaching = new DefaultTeachingSessionService({
      idFactory: createSequentialIdFactory('ts'),
      clock: createSteppingClock(1733568000000, 1000),
      store: new InMemoryTeachingSessionStore(),
    });
    const v1Parsed = parseWorkflowIrDocument(JSON.stringify(created.initialVersion.content));
    if (!v1Parsed.ok) throw new Error('v1 content must parse');
    const session = teaching.createSession({
      learnerId: 'v2-006-operator',
      pinned: {
        workflowId,
        versionId: created.initialVersion.id,
        semanticDigest: computeWorkflowVersionSemanticDigest(v1Parsed.document),
      },
    });
    const v2Parsed = parseWorkflowIrDocument(JSON.stringify(version2.content));
    if (!v2Parsed.ok) throw new Error('v2 content must parse');
    let rejection: { message: string; details?: Record<string, unknown> } | null = null;
    try {
      teaching.beginLesson({ sessionId: session.id, document: v2Parsed.document });
    } catch (error) {
      rejection = error as { message: string; details?: Record<string, unknown> };
    }
    expect(rejection).not.toBeNull();
    expect(rejection!.message).toMatch(/VERSION_PIN_MISMATCH/);
    // The session is unharmed.
    const after = teaching.getSession({ sessionId: session.id, learnerId: 'v2-006-operator' });
    expect(after.status).toBe('not_started');
  });

  it('learner isolation over the real install: two operators teach the same pinned version independently', async () => {
    const document = authorSupportTriageDocument();
    const createRes = await server.inject({
      method: 'POST',
      url: `/organizations/${orgId}/workflow-repository/workflows`,
      headers: { 'x-api-key': operatorKey },
      payload: {
        slug: 'isolation-check',
        name: 'Isolation Check',
        visibility: 'private',
        content: JSON.parse(serializeWorkflowIrDocument(document)) as Record<string, unknown>,
        protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
      },
    });
    const created = createRes.json() as { workflow: { id: string }; initialVersion: VersionPayload };
    const parsed = parseWorkflowIrDocument(JSON.stringify(created.initialVersion.content));
    if (!parsed.ok) throw new Error('content must parse');
    const semanticDigest = computeWorkflowVersionSemanticDigest(parsed.document);

    const teaching = new DefaultTeachingSessionService({
      idFactory: createSequentialIdFactory('ts'),
      clock: createSteppingClock(1733568000000, 1000),
      store: new InMemoryTeachingSessionStore(),
    });
    const pinned = { workflowId: created.workflow.id, versionId: created.initialVersion.id, semanticDigest };
    const sessionA = teaching.createSession({ learnerId: 'operator-a', pinned });
    const sessionB = teaching.createSession({ learnerId: 'operator-b', pinned });
    teaching.beginLesson({ sessionId: sessionA.id, document: parsed.document });
    teaching.beginLesson({ sessionId: sessionB.id, document: parsed.document });

    teaching.confirmCheckpoint({ sessionId: sessionA.id, learnerId: 'operator-a', nodeId: 'fetch_ticket' });
    // Operator B's confirmation on A's session is rejected.
    expect(() =>
      teaching.confirmCheckpoint({ sessionId: sessionA.id, learnerId: 'operator-b', nodeId: 'draft_reply' }),
    ).toThrowError(/LEARNER_NOT_AUTHORIZED/);
    // B advances independently.
    teaching.confirmCheckpoint({ sessionId: sessionB.id, learnerId: 'operator-b', nodeId: 'fetch_ticket' });
    const a = teaching.getSession({ sessionId: sessionA.id, learnerId: 'operator-a' });
    const b = teaching.getSession({ sessionId: sessionB.id, learnerId: 'operator-b' });
    expect(a.progress.confirmedCheckpoints.map((c) => c.nodeId)).toEqual(['fetch_ticket']);
    expect(b.progress.confirmedCheckpoints.map((c) => c.nodeId)).toEqual(['fetch_ticket']);
    expect(a.evidence).toHaveLength(1);
    expect(b.evidence).toHaveLength(1);
    expect(a.id).not.toBe(b.id);
    // Neither can read the other's session.
    expect(() => teaching.getSession({ sessionId: sessionA.id, learnerId: 'operator-b' })).toThrowError(
      /LEARNER_NOT_AUTHORIZED/,
    );
  });
});

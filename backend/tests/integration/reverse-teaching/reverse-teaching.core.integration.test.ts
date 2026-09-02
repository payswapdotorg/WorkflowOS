import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { buildServer } from '@api/server.js';
import {
  DefaultWorkflowRepositoryService,
  type OrganizationMembershipResolver,
} from '../../../src/workflow-repository/index.js';
import {
  DefaultWorkflowRunService,
  createSteppingRunClock,
} from '../../../src/workflow-runs/index.js';
import {
  createWorkflowIrBuilder,
  computeWorkflowVersionSemanticDigest,
  parseWorkflowIrDocument,
  serializeWorkflowIrDocument,
} from '../../../src/workflow-ir/index.js';
import {
  DefaultReverseTeachingSessionService,
  InMemoryReverseTeachingSessionStore,
  createSequentialIdFactory,
  createSteppingClock,
} from '../../../src/reverse-teaching/index.js';
import type { FastifyInstance } from 'fastify';
import type { WorkflowIrDocument } from '../../../src/workflow-ir/index.js';

/**
 * V2-010 — install-and-reverse-teach INTEGRATION test (real product paths).
 *
 * The real install path: the MERGED V2-002 workflow-repository through its
 * real Fastify routes (app.inject) over a real PGlite database with all 62
 * migrations — a real authored WorkflowIR workflow is installed and pinned.
 *
 * The real reverse-teaching path: a reverse-teaching session created from the
 * INSTALLED version (the installation's pin: installationId + workflow +
 * version + V2-003 semantic digest), taught end-to-end through the V2-010
 * public API (lesson derivation → safety-gated ordered manual performance →
 * pause/resume → finalization), with:
 *
 *   - ZERO runs created (the execution/teaching distinction, proven through
 *     the REAL V2-005 run service on the same database — the list-runs
 *     surface stays empty after the whole lesson);
 *   - the installed version re-read over HTTP afterwards, byte-identical
 *     (teaching never mutates the installed workflow).
 */
const OPERATOR_KEY = 'raw-key-v2-010-operator';
const LEARNER_ID = 'v2-010-operator';
const RUN_TEST_EPOCH = 7;

interface VersionPayload {
  id: string;
  workflowId: string;
  versionNumber: number;
  contentDigest: string;
  content: Record<string, unknown>;
}

/** A real authored workflow: the daily customer follow-up task (the unit-fixture task, authored through the merged V2-003 builder). */
function authorDailyFollowupDocument(): WorkflowIrDocument {
  return createWorkflowIrBuilder()
    .withStart('fetch_open_tickets')
    .addWorkflowInput({ name: 'ticketQuery', type: { kind: 'string' } })
    .addWorkflowOutput({
      name: 'messageId',
      type: { kind: 'string' },
      from: { kind: 'node_output', node: 'send_followup', output: 'messageId' },
    })
    .addNode({
      id: 'fetch_open_tickets',
      executionClass: 'deterministic_api',
      spec: { class: 'deterministic_api', capability: 'github.repository.read' },
      capabilityRequirements: ['github.repository.read'],
      placement: 'cloud_allowed',
      inputs: [
        { name: 'repository', type: { kind: 'string' }, binding: { kind: 'literal', value: 'pectoraux/WorkflowOS' } },
        { name: 'query', type: { kind: 'string' }, binding: { kind: 'workflow_input', input: 'ticketQuery' } },
      ],
      outputs: [{ name: 'tickets', type: { kind: 'json' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'observation',
    })
    .addNode({
      id: 'draft_followup',
      executionClass: 'agentic_computer_use',
      spec: {
        class: 'agentic_computer_use',
        task: 'Draft a follow-up message for each open ticket in the fetched list.',
      },
      capabilityRequirements: ['github.repository.read', 'filesystem.read'],
      placement: 'cloud_allowed',
      inputs: [
        { name: 'tickets', type: { kind: 'json' }, binding: { kind: 'node_output', node: 'fetch_open_tickets', output: 'tickets' } },
      ],
      outputs: [
        { name: 'draft', type: { kind: 'string' } },
        { name: 'remainingCount', type: { kind: 'number' } },
      ],
      failurePolicy: { strategy: 'retry_then_fail_workflow', maxAttempts: 2 },
      completionEvidence: 'verification',
    })
    .addNode({
      id: 'approve_draft',
      executionClass: 'human',
      spec: {
        class: 'human',
        human: { kind: 'approval', instruction: 'Approve the drafted follow-up messages before sending.' },
      },
      capabilityRequirements: [],
      placement: 'device_local',
      inputs: [],
      outputs: [{ name: 'approved', type: { kind: 'boolean' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'human_confirmation',
    })
    .addNode({
      id: 'record_outcome',
      executionClass: 'human',
      spec: {
        class: 'human',
        human: {
          kind: 'information',
          instruction: "Record the customer's response in the shared follow-up spreadsheet.",
          provides: { name: 'response', type: { kind: 'string' } },
        },
      },
      capabilityRequirements: ['spreadsheet.edit'],
      placement: 'device_local',
      inputs: [],
      outputs: [{ name: 'response', type: { kind: 'string' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'human_confirmation',
    })
    .addNode({
      id: 'send_followup',
      executionClass: 'deterministic_api',
      spec: { class: 'deterministic_api', capability: 'messaging.send' },
      capabilityRequirements: ['messaging.send'],
      placement: 'cloud_preferred',
      inputs: [
        { name: 'text', type: { kind: 'string' }, binding: { kind: 'node_output', node: 'draft_followup', output: 'draft' } },
        { name: 'credentials', type: { kind: 'secret' }, binding: { kind: 'secret_ref', ref: 'followup-bot@secrets' } },
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
        { name: 'summary', type: { kind: 'string' }, binding: { kind: 'node_output', node: 'record_outcome', output: 'response' } },
      ],
      outputs: [{ name: 'backlogRef', type: { kind: 'string' } }],
      failurePolicy: { strategy: 'retry_then_fail_workflow', maxAttempts: 3 },
    })
    .addEdge({ from: 'fetch_open_tickets', to: 'draft_followup', on: 'success' })
    .addEdge({ from: 'draft_followup', to: 'approve_draft', on: 'success' })
    .addEdge({ from: 'approve_draft', to: 'send_followup', on: { outcome: 'approved' } })
    .addEdge({ from: 'approve_draft', to: 'record_outcome', on: { outcome: 'approved' } })
    .addEdge({ from: 'approve_draft', to: 'escalate_backlog', on: { outcome: 'rejected' } })
    .addEdge({ from: 'record_outcome', to: 'escalate_backlog', on: 'success' })
    .build();
}

describe('V2-010 — install one real workflow via the real V2-002 routes and reverse-teach it', () => {
  let stack: TestAuthStack;
  let server: FastifyInstance;
  let orgId: string;
  let operatorKey: string;

  beforeAll(async () => {
    stack = await buildAuthStack({
      WFOS_TEST_KEY_V2_010_A: OPERATOR_KEY,
    });
    const org = await stack.organizationRepository.create({ name: 'V2-010 Install-and-Reverse-Teach Org' });
    const operator = await stack.userRepository.upsertByExternalId({
      externalId: LEARNER_ID,
      displayName: 'V2-010 Operator',
    });
    await stack.membershipRepository.assign({ userId: operator.id, organizationId: org.id, roleId: 'owner' });
    await stack.apiKeyProvisioner.provision({
      keyId: 'v2-010-key-a', secretRef: 'WFOS_TEST_KEY_V2_010_A', externalId: LEARNER_ID,
      label: 'V2-010 A', rawKey: OPERATOR_KEY,
    });
    orgId = org.id;
    operatorKey = OPERATOR_KEY;

    const memberships: OrganizationMembershipResolver = {
      isMember: async (userId, organizationId) =>
        (await stack.membershipRepository.findByUserAndOrganization(userId, organizationId)) !== null,
    };
    const repository = new DefaultWorkflowRepositoryService({ db: stack.db.client, memberships });
    const runs = new DefaultWorkflowRunService({
      db: stack.db.client,
      memberships,
      workflowRepository: repository,
      clock: createSteppingRunClock(1788264000000, 1000),
      currentEpoch: RUN_TEST_EPOCH,
    });
    server = await buildServer({
      queue: stack.db.client as never,
      logger: stack.db.logger,
      auth: { authProvider: stack.authProvider, userRepository: stack.userRepository },
      workflowRepository: { workflowRepositoryService: repository },
      workflowRuns: { workflowRunService: runs },
    });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    await stack.teardown();
  });

  it('the full real path: install → pin → reverse-teach (safety gates, ordered manual performance, pause/resume) → ZERO runs → no mutation', async () => {
    // --- 1. INSTALL a real authored workflow through the real V2-002 routes ---
    const document = authorDailyFollowupDocument();
    const serialized = serializeWorkflowIrDocument(document);
    const createRes = await server.inject({
      method: 'POST',
      url: `/organizations/${orgId}/workflow-repository/workflows`,
      headers: { 'x-api-key': operatorKey },
      payload: {
        slug: 'daily-customer-followup',
        name: 'Daily Customer Follow-up',
        description: 'Fetch open tickets, draft follow-ups, approve, send and record outcomes',
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

    // --- 2. INSTALL (pin) version 1 through the real installations route ----
    const installRes = await server.inject({
      method: 'POST',
      url: `/organizations/${orgId}/workflow-repository/installations`,
      headers: { 'x-api-key': operatorKey },
      payload: { workflowId, versionId: version1.id },
    });
    expect(installRes.statusCode).toBe(201);
    const installation = (installRes.json() as { installation: { id: string; versionId: string; status: string } }).installation;
    expect(installation.versionId).toBe(version1.id);
    expect(installation.status).toBe('enabled');

    // --- 3. READ the installed immutable version back over HTTP -----------
    const readRes = await server.inject({
      method: 'GET',
      url: `/workflow-repository/workflows/${workflowId}/versions/${version1.id}`,
      headers: { 'x-api-key': operatorKey },
    });
    expect(readRes.statusCode).toBe(200);
    const versionBodyBefore = readRes.body;
    const readVersion = (readRes.json() as { version: VersionPayload }).version;

    // --- 4. PIN the reverse-teaching session to the INSTALLED version ------
    const parsed = parseWorkflowIrDocument(JSON.stringify(readVersion.content));
    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
    if (!parsed.ok) throw new Error('unreachable');
    const installedDocument = parsed.document;
    const semanticDigest = computeWorkflowVersionSemanticDigest(installedDocument);
    expect(semanticDigest.digest).toMatch(/^[0-9a-f]{64}$/);

    const teaching = new DefaultReverseTeachingSessionService({
      idFactory: createSequentialIdFactory('rt'),
      clock: createSteppingClock(1733568000000, 1000),
      store: new InMemoryReverseTeachingSessionStore(),
    });
    const session = teaching.createSession({
      learnerId: LEARNER_ID,
      pin: { installationId: installation.id, workflowId, versionId: version1.id, semanticDigest },
    });
    expect(session.status).toBe('not_started');

    // --- 5. TEACH: begin the lesson from the installed content -------------
    const begun = teaching.beginLesson({ sessionId: session.id, document: installedDocument });
    expect(begun.status).toBe('in_progress');
    expect(begun.lesson!.stepOrder).toEqual([
      'fetch_open_tickets',
      'draft_followup',
      'approve_draft',
      'record_outcome',
      'escalate_backlog',
      'send_followup',
    ]);
    // the manual view of the installed version
    const byId = new Map(begun.lesson!.steps.map((s) => [s.nodeId, s]));
    expect(byId.get('draft_followup')!.safety).toBe('safety_gated');
    expect(byId.get('draft_followup')!.sensitiveCapabilities).toEqual(['filesystem.read']);
    expect(byId.get('record_outcome')!.safety).toBe('safety_gated');

    // --- 6. the manual lesson: safety-gated ordered performance with pause --
    // (the operator/learner performs the task by hand; a safety-gated attempt
    // without the explicit acknowledgment is rejected — the negative)
    teaching.performManualStep({
      sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'fetch_open_tickets',
      mode: 'acknowledged_disclosure',
      learnerResult: 'acknowledged: the workflow performs this step itself; no manual equivalent is declared.',
    });
    let rejected = false;
    try {
      teaching.performManualStep({
        sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'draft_followup',
        mode: 'performed', learnerResult: 'premature attempt without acknowledgment',
      });
    } catch (error) {
      rejected = (error as { code?: string }).code === 'SAFETY_ACKNOWLEDGMENT_REQUIRED';
    }
    expect(rejected).toBe(true);
    teaching.acknowledgeStepSafety({ sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'draft_followup' });
    teaching.performManualStep({
      sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'draft_followup',
      mode: 'performed',
      learnerResult: 'I drafted a follow-up message for each open ticket by hand and saved them as drafts.',
    });
    teaching.performManualStep({
      sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'approve_draft',
      mode: 'performed',
      learnerResult: 'I read the drafted messages and approved them for sending.',
    });
    // pause mid-lesson and resume to the exact pending step
    teaching.pauseSession({ sessionId: session.id, learnerId: LEARNER_ID });
    const resumed = teaching.resumeSession({ sessionId: session.id, learnerId: LEARNER_ID });
    expect(resumed.resumeStepNodeId).toBe('record_outcome');
    teaching.acknowledgeStepSafety({ sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'record_outcome' });
    teaching.performManualStep({
      sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'record_outcome',
      mode: 'performed',
      learnerResult: 'I recorded "customer confirmed receipt" in the follow-up spreadsheet.',
    });
    teaching.performManualStep({
      sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'escalate_backlog',
      mode: 'acknowledged_disclosure',
      learnerResult: 'acknowledged: the manual procedure lives in the referenced subworkflow version.',
    });
    teaching.performManualStep({
      sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'send_followup',
      mode: 'acknowledged_disclosure',
      learnerResult: 'acknowledged: the workflow performs this step itself; no manual equivalent is declared.',
    });
    const finalization = teaching.finalizeLesson({ sessionId: session.id, learnerId: LEARNER_ID });
    expect(finalization.sessionStatus).toBe('completed');
    expect(finalization.performedStepCount).toBe(3);
    expect(finalization.disclosureAcknowledgedStepCount).toBe(3);

    // every evidence record is teaching evidence, pinned to the installation
    const final = teaching.getSession({ sessionId: session.id, learnerId: LEARNER_ID });
    for (const record of final.evidence) {
      expect(record.evidenceClass).toBe('teaching');
      expect(record.pin.installationId).toBe(installation.id);
      expect(record.pin.versionId).toBe(version1.id);
    }

    // --- 7. ZERO RUNS: the real V2-005 list surface on the same database ---
    const runsRes = await server.inject({
      method: 'GET',
      url: `/organizations/${orgId}/workflow-runs/runs`,
      headers: { 'x-api-key': operatorKey },
    });
    expect(runsRes.statusCode).toBe(200);
    const runsList = (runsRes.json() as { runs: unknown[] }).runs;
    expect(runsList).toEqual([]);

    // --- 8. NO MUTATION: the installed version is byte-identical -----------
    const reRead = await server.inject({
      method: 'GET',
      url: `/workflow-repository/workflows/${workflowId}/versions/${version1.id}`,
      headers: { 'x-api-key': operatorKey },
    });
    expect(reRead.statusCode).toBe(200);
    expect(reRead.body).toBe(versionBodyBefore);
    // and the installation still pins v1
    const installationDetail = await server.inject({
      method: 'GET',
      url: `/organizations/${orgId}/workflow-repository/installations/${installation.id}`,
      headers: { 'x-api-key': operatorKey },
    });
    expect(installationDetail.statusCode).toBe(200);
    const detail = installationDetail.json() as { installation: { versionId: string; status: string } };
    expect(detail.installation.versionId).toBe(version1.id);
    expect(detail.installation.status).toBe('enabled');
  });
});

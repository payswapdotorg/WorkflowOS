/**
 * IG-004 — Events + Reverse Teaching + Optimization Integration Gate.
 *
 * Frozen scope ONLY (spec/architecture/v2/work-orders/IG-004.md + Issue #147):
 * integration tests/spec/evidence. This gate composes the ALREADY-MERGED
 * capabilities V2-009 (scheduling + events + placement), V2-010 (reverse
 * teaching) and V2-011 (workflow optimization) over the SAME immutable
 * workflow/version model. No implementation redesign, no sibling rebases, no
 * drive-by fixes to any of the three modules — every surface below is
 * consumed exactly through the merged public barrels.
 *
 * The frozen objective, proven on the REAL stack (real PGlite + ALL 62
 * migrations incl. 0062 + the real identity stack + the real V2-002
 * workflow-repository routes over app.inject + the real V2-005 run routes +
 * the real V2-009 deployment service/routes + the real V2-004 node directory
 * with the real registration protocol + the V2-010 session service composed
 * on the installed pin + the V2-011 optimization service with the
 * materializer port satisfied by the REAL repository service):
 *
 *   "Verify that event/scheduled execution, human teaching, and optimization
 *    operate over the same immutable workflow/version model."
 *
 * Required proof (each its own labeled section of the main path):
 *   P1. scheduled and event-triggered runs instantiate the pinned
 *       WorkflowVersion — the run records carry the deployment's exact
 *       (workflowId, versionId) pin, V2-002's content digest and V2-003's
 *       semantic digest of the SAME installed version (event delivery and
 *       one-shot schedule tick both, through the real boundaries);
 *   P2. duplicate events converge idempotently — the SAME (source, eventId)
 *       re-delivered converges (created=false, zero new deliveries, still
 *       exactly ONE run);
 *   P3. reverse teaching derives from the installed version — the session
 *       pins the installation's exact version identity; the lesson (step
 *       order, per-step manual actionability, safety gating) is a VIEW over
 *       the installed version's content; a mismatched document is refused
 *       typed (VERSION_PIN_MISMATCH, the dedicated negative test);
 *   P4. optimization produces a proposed new version rather than mutating
 *       the source — analyze → propose (provenance pins the REAL v1
 *       identity) → approve → materialize a REAL new WorkflowVersion v2;
 *       v1 re-read byte-identical; the installation and the deployment keep
 *       pinning v1 (never an activation);
 *   P5. baseline and optimized versions remain independently addressable —
 *       both versions fetchable by id over the real routes with DISTINCT
 *       content digests, both listed, and the optimized version
 *       independently executable through the real V2-005 run boundary
 *       (its run pins v2's identity, installationId null — not activated).
 *
 * The gate deliberately composes ONE workflow + ONE installed version
 * through ALL THREE module families in a single end-to-end path: the
 * deployment pins it (V2-009), the teaching session pins it (V2-010), the
 * optimization proposal pins it (V2-011) — one immutable version model,
 * three consumers, zero mutations.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { buildServer } from '../../../src/api/server.js';
import { ApiKeyAuthProvider } from '../../../src/modules/auth/internal/api-key-auth-provider.js';
import { ApiKeyCredentialProvisioner } from '../../../src/modules/auth/internal/authorization-service.js';
import { EnvSecretStore, InMemoryQueue } from '@platform/index.js';
import { createLogger } from '@platform/logger.js';
import {
  buildTriggerTestStack,
  createTenant,
  registerNode,
  versionContentOf,
  type TriggerTestStack,
} from '../workflow-deployments/trigger-test-support.js';
import {
  createWorkflowIrBuilder,
  computeWorkflowVersionSemanticDigest,
  parseWorkflowIrDocument,
  type WorkflowIrDocument,
} from '../../../src/workflow-ir/index.js';
import { formatUtcTimestamp } from '../../../src/workflow-deployments/index.js';
import {
  DefaultReverseTeachingSessionService,
  InMemoryReverseTeachingSessionStore,
  createSequentialIdFactory as createTeachingIdFactory,
  createSteppingClock as createTeachingClock,
} from '../../../src/reverse-teaching/index.js';
import {
  DefaultWorkflowOptimizationService,
  InMemoryOptimizationProposalStore,
  createSequentialIdFactory as createOptimizationIdFactory,
  createSteppingClock as createOptimizationClock,
  type CandidateVersionMaterializer,
} from '../../../src/workflow-optimization/index.js';
import type { FastifyInstance } from 'fastify';

const API_KEY = 'ig-004-api-test-key';
const OPERATOR_EXTERNAL_ID = 'ig-004-api-operator';
/** The human learner identity for the reverse-teaching session. */
const LEARNER_ID = 'ig-004-human-learner';

interface VersionPayload {
  id: string;
  workflowId: string;
  versionNumber: number;
  contentDigest: string;
  content: Record<string, unknown>;
}

function sha256Of(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

let support: TriggerTestStack;
/** The REAL Fastify app: V2-002 + V2-005 + V2-009 routes (inject-driven). */
let app: FastifyInstance;
let operatorUserId: string;

beforeAll(async () => {
  support = await buildTriggerTestStack({
    WFOS_IG_004_API_TEST_KEY: API_KEY,
  });
  // Provision the API key through the real credential provisioner (the
  // secret lives in the env secret store — the production path).
  const operator = await support.stack.userRepository.upsertByExternalId({
    externalId: OPERATOR_EXTERNAL_ID,
    displayName: 'IG-004 API Operator',
  });
  operatorUserId = operator.id;
  const provisioner = new ApiKeyCredentialProvisioner(support.stack.db.client);
  await provisioner.provision({
    keyId: 'ig-004-api-test-key-id',
    secretRef: 'WFOS_IG_004_API_TEST_KEY',
    externalId: OPERATOR_EXTERNAL_ID,
    label: 'IG-004 API Operator',
    rawKey: API_KEY,
  });
  const authProvider = new ApiKeyAuthProvider(support.stack.db.client, new EnvSecretStore());
  app = await buildServer({
    queue: new InMemoryQueue(),
    logger: createLogger({ level: 'silent' }),
    auth: { authProvider, userRepository: support.stack.userRepository },
    workflowRepository: { workflowRepositoryService: support.repository },
    workflowRuns: { workflowRunService: support.runs },
    workflowDeployments: { workflowDeploymentService: support.deployments },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await support.teardown();
});

// ============================================================================
// The real HTTP helper (the product path — every route call is inject-driven)
// ============================================================================

async function injectJson(
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
): Promise<{ status: number; body: Record<string, unknown>; raw: string }> {
  const response = await app.inject({
    method,
    url,
    headers:
      payload === undefined
        ? { authorization: `Bearer ${API_KEY}` }
        : { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
    payload: payload as Record<string, unknown> | undefined,
  });
  return {
    status: response.statusCode,
    body: (response.json() ?? {}) as Record<string, unknown>,
    raw: response.body,
  };
}

/** A fresh tenant owned by the API-key operator (per-test org isolation —
 *  every test drives the org-scoped tick sweep). */
async function freshGateTenant(label: string) {
  const tenant = await createTenant(support, `ig4-${label}`);
  await support.stack.membershipRepository.assign({
    userId: operatorUserId,
    organizationId: tenant.organizationId,
    roleId: 'owner',
  });
  return {
    organizationId: tenant.organizationId,
    ownerUserId: operatorUserId,
    principal: { userId: operatorUserId },
  };
}

// ============================================================================
// The gate fixture: the repository ticket digest report (authored through
// the merged V2-003 builder; the scan_board agentic node declares EXACTLY
// ONE API-stable ordinary requirement — the post-correction V2-011
// invariant; the record_rejection human node carries the sensitive
// spreadsheet.edit capability so the reverse-teaching lesson exercises the
// V2-008-sensitive-capability safety gate).
// ============================================================================

/**
 * The gate fixture: the repository ticket digest report (authored through
 * the merged V2-003 builder; the scan_board agentic node declares EXACTLY
 * ONE API-stable ordinary requirement — the post-correction V2-011
 * invariant; the record_rejection human node carries the sensitive
 * spreadsheet.edit capability so the reverse-teaching lesson exercises the
 * V2-008-sensitive-capability safety gate). The optional scan-task override
 * authors a STRUCTURALLY IDENTICAL document with a different task string —
 * a different V2-003 semantic digest — for the pin-mismatch negative.
 */
function authorDigestReportDocument(scanTask?: string): WorkflowIrDocument {
  return createWorkflowIrBuilder()
    .withStart('fetch_tickets')
    .addWorkflowInput({ name: 'ticketQuery', type: { kind: 'string' } })
    .addWorkflowOutput({
      name: 'digestReport',
      type: { kind: 'string' },
      from: { kind: 'node_output', node: 'send_digest', output: 'messageId' },
    })
    .addNode({
      id: 'fetch_tickets',
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
      id: 'scan_board',
      executionClass: 'agentic_computer_use',
      spec: {
        class: 'agentic_computer_use',
        task: scanTask ?? 'Scan the repository board and summarize the open ticket digest.',
      },
      capabilityRequirements: ['github.repository.read'],
      placement: 'cloud_allowed',
      inputs: [
        { name: 'tickets', type: { kind: 'json' }, binding: { kind: 'node_output', node: 'fetch_tickets', output: 'tickets' } },
      ],
      outputs: [
        { name: 'digest', type: { kind: 'string' } },
        { name: 'openCount', type: { kind: 'number' } },
      ],
      failurePolicy: { strategy: 'retry_then_fail_workflow', maxAttempts: 2 },
      completionEvidence: 'verification',
    })
    .addNode({
      id: 'approve_digest',
      executionClass: 'human',
      spec: {
        class: 'human',
        human: { kind: 'approval', instruction: 'Approve the digest report before sending.' },
      },
      capabilityRequirements: [],
      placement: 'device_local',
      inputs: [],
      outputs: [{ name: 'approved', type: { kind: 'boolean' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'human_confirmation',
    })
    .addNode({
      id: 'record_rejection',
      executionClass: 'human',
      spec: {
        class: 'human',
        human: {
          kind: 'information',
          instruction: 'Record the digest outcome in the operations log.',
          provides: { name: 'reason', type: { kind: 'string' } },
        },
      },
      capabilityRequirements: ['spreadsheet.edit'],
      placement: 'device_local',
      inputs: [],
      outputs: [{ name: 'reason', type: { kind: 'string' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'human_confirmation',
    })
    .addNode({
      id: 'send_digest',
      executionClass: 'deterministic_api',
      spec: { class: 'deterministic_api', capability: 'messaging.send' },
      capabilityRequirements: ['messaging.send'],
      placement: 'cloud_preferred',
      inputs: [
        { name: 'text', type: { kind: 'string' }, binding: { kind: 'node_output', node: 'scan_board', output: 'digest' } },
        { name: 'credentials', type: { kind: 'secret' }, binding: { kind: 'secret_ref', ref: 'digest-bot@secrets' } },
      ],
      outputs: [{ name: 'messageId', type: { kind: 'string' } }],
      failurePolicy: { strategy: 'fail_workflow' },
      completionEvidence: 'verification',
    })
    .addEdge({ from: 'fetch_tickets', to: 'scan_board', on: 'success' })
    .addEdge({ from: 'scan_board', to: 'approve_digest', on: 'success' })
    .addEdge({ from: 'approve_digest', to: 'send_digest', on: { outcome: 'approved' } })
    .addEdge({ from: 'approve_digest', to: 'record_rejection', on: { outcome: 'approved' } })
    .addEdge({ from: 'approve_digest', to: 'record_rejection', on: { outcome: 'rejected' } })
    .build();
}

const CLOUD_POLICY = { placement: { required: 'cloud_allowed' as const }, privacy: { localOnly: false } };

/** The V2-010 session service (composed per tenant — fresh in-memory store). */
function makeTeachingService() {
  return new DefaultReverseTeachingSessionService({
    idFactory: createTeachingIdFactory('ig4-rt'),
    clock: createTeachingClock(1733568000000, 1000),
    store: new InMemoryReverseTeachingSessionStore(),
  });
}

/** The V2-011 optimization service with the materializer port satisfied by
 *  the REAL V2-002 repository service (createVersion — the exact authority
 *  behind the routes; the module never imports the repository itself). */
function makeOptimizationService() {
  const materializer: CandidateVersionMaterializer = {
    createCandidateVersion: async (input) => {
      const result = await support.repository.createVersion(
        { userId: operatorUserId },
        input.workflowId,
        {
          content: input.content,
          protocol: { irSchemaVersion: input.protocol.irSchemaVersion },
          parentVersionId: input.parentVersionId,
        },
      );
      return { versionId: result.version.id };
    },
  };
  return new DefaultWorkflowOptimizationService({
    idFactory: createOptimizationIdFactory('ig4-opt'),
    clock: createOptimizationClock(1789000000000, 1000),
    store: new InMemoryOptimizationProposalStore(),
    materializer,
  });
}

/** Create the gate fixture workflow through the REAL V2-002 routes. */
async function createDigestWorkflow(
  t: { organizationId: string },
  slug: string,
): Promise<{ workflowId: string; version: VersionPayload }> {
  const res = await injectJson('POST', `/organizations/${t.organizationId}/workflow-repository/workflows`, {
    slug,
    name: 'Repository Ticket Digest Report',
    description: 'Fetch tickets, scan the board, approve and send the digest',
    visibility: 'private',
    content: versionContentOf(authorDigestReportDocument()),
    protocol: { irSchemaVersion: 'workflowos-workflow-ir-v1' },
  });
  expect(res.status, res.raw).toBe(201);
  const created = res.body as unknown as {
    workflow: { id: string; headVersionId: string };
    initialVersion: VersionPayload;
  };
  return { workflowId: created.workflow.id, version: created.initialVersion };
}

describe('IG-004 — events, reverse teaching and optimization over ONE immutable workflow/version model', () => {
  it('the full gate path: one installed version through event/schedule triggers, human teaching and optimization (P1–P5)', async () => {
    const t = await freshGateTenant('main');
    registerNode(support.nodes, 'ig-004-main-device', 'desktop');

    // --- 0. ONE immutable WorkflowVersion, installed (pinned) + deployed ----
    const { workflowId, version: version1 } = await createDigestWorkflow(t, 'ig4-digest-report');
    expect(version1.versionNumber).toBe(1);

    const installRes = await injectJson(
      'POST',
      `/organizations/${t.organizationId}/workflow-repository/installations`,
      { workflowId, versionId: version1.id },
    );
    expect(installRes.status, installRes.raw).toBe(201);
    const installation = (
      installRes.body as unknown as { installation: { id: string; versionId: string; status: string } }
    ).installation;
    expect(installation.versionId).toBe(version1.id);
    expect(installation.status).toBe('enabled');

    // The byte-identity snapshot of v1 BEFORE any trigger/teaching/optimization.
    const v1Read = await injectJson(
      'GET',
      `/workflow-repository/workflows/${workflowId}/versions/${version1.id}`,
    );
    expect(v1Read.status).toBe(200);
    const v1BodyBefore = v1Read.raw;
    const parsed = parseWorkflowIrDocument(
      JSON.stringify((v1Read.body as unknown as { version: VersionPayload }).version.content),
    );
    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
    if (!parsed.ok) throw new Error('unreachable');
    const baselineDocument = parsed.document;
    const semanticDigest = computeWorkflowVersionSemanticDigest(baselineDocument);
    expect(semanticDigest.digest).toMatch(/^[0-9a-f]{64}$/);

    // The deployment pins the SAME exact immutable version (V2-009 pin
    // resolution through the merged V2-002 repository, plan compiled by
    // V2-007, placement compatibility checked).
    const { deployment } = await support.deployments.createDeployment(t.principal, {
      organizationId: t.organizationId,
      workflowId,
      versionId: version1.id,
      installationId: installation.id,
      name: 'ig4-digest-dep',
      placement: CLOUD_POLICY,
    });
    expect(deployment.workflowId).toBe(workflowId);
    expect(deployment.versionId).toBe(version1.id);
    expect(deployment.installationId).toBe(installation.id);

    // --- P1a. EVENT-TRIGGERED run instantiates the pinned WorkflowVersion --
    const { subscription: eventSubscription } = await support.deployments.createSubscription(t.principal, {
      deploymentId: deployment.id,
      kind: 'event',
      eventPattern: { eventType: 'file.changed' },
    });
    const eventPayload = {
      source: 'node_ig4_main_device',
      eventId: 'ig4-filechange-0001',
      eventType: 'file.changed',
      payload: { path: '/inbox/board-snapshot.txt' },
    };
    const first = await injectJson(
      'POST',
      `/organizations/${t.organizationId}/workflow-deployments/events`,
      eventPayload,
    );
    expect(first.status, first.raw).toBe(201);
    expect(first.body.created).toBe(true);
    const firstEvent = (first.body as unknown as { event: { id: string; payloadCommitment: string } }).event;
    const firstDeliveries = (first.body as unknown as {
      deliveries: { id: string; state: string; runId: string | null }[];
    }).deliveries;
    expect(firstDeliveries).toHaveLength(1);
    expect(firstDeliveries[0]!.state).toBe('delivered');
    const eventRunId = firstDeliveries[0]!.runId!;
    expect(eventRunId).toBeTruthy();

    // The run record (the REAL V2-005 surface): the pinned version identity.
    const eventRun = await support.runs.getRun(t.principal, eventRunId);
    expect(eventRun.workflowId).toBe(workflowId);
    expect(eventRun.versionId).toBe(version1.id);
    expect(eventRun.versionContentDigest).toBe(version1.contentDigest);
    expect(eventRun.versionSemanticDigest).toBe(semanticDigest.digest);
    expect(eventRun.installationId).toBe(installation.id);
    expect(eventRun.trigger.type).toBe('file_event');
    expect(eventRun.trigger.id).toBe(`evt:${firstEvent.id}:${eventSubscription.id}`);
    // event/run correlation: the run's input commitment IS the event's payload commitment
    expect(eventRun.inputCommitments).toEqual([firstEvent.payloadCommitment]);

    // --- P2. DUPLICATE EVENT converges idempotently -----------------------
    const duplicate = await injectJson(
      'POST',
      `/organizations/${t.organizationId}/workflow-deployments/events`,
      eventPayload,
    );
    expect(duplicate.status, duplicate.raw).toBe(200);
    expect(duplicate.body.created).toBe(false);
    expect(duplicate.body.matchedSubscriptionIds).toEqual([]);
    expect((duplicate.body as unknown as { deliveries: unknown[] }).deliveries).toEqual([]);

    // Exactly ONE run so far (no second side effect), ONE delivery.
    const runsAfterDuplicate = await support.runs.listRunsInOrganization(t.principal, t.organizationId);
    expect(runsAfterDuplicate).toHaveLength(1);
    expect(runsAfterDuplicate[0]!.id).toBe(eventRunId);
    const deliveries = await support.deployments.listDeliveriesForDeployment(t.principal, deployment.id);
    expect(deliveries).toHaveLength(1);

    // --- P1b. SCHEDULED run instantiates the pinned WorkflowVersion --------
    const fireAt = formatUtcTimestamp(support.clock.now() + 60_000);
    const { subscription: scheduleSubscription } = await support.deployments.createSubscription(t.principal, {
      deploymentId: deployment.id,
      kind: 'schedule',
      schedule: { kind: 'one_shot', at: fireAt },
    });
    support.clock.advance(120_000);
    const tick = await support.deployments.tick(t.principal, { organizationId: t.organizationId });
    expect(tick.occurrencesConsidered).toBe(1);
    expect(tick.deliveriesDelivered).toHaveLength(1);

    const scheduleDelivery = await support.deployments.getDelivery(t.principal, tick.deliveriesDelivered[0]!);
    expect(scheduleDelivery.state).toBe('delivered');
    expect(scheduleDelivery.scheduledAt).toBe(fireAt);
    expect(scheduleDelivery.runId).not.toBeNull();

    const scheduleRun = await support.runs.getRun(t.principal, scheduleDelivery.runId!);
    expect(scheduleRun.workflowId).toBe(workflowId);
    expect(scheduleRun.versionId).toBe(version1.id);
    expect(scheduleRun.versionContentDigest).toBe(version1.contentDigest);
    expect(scheduleRun.versionSemanticDigest).toBe(semanticDigest.digest);
    expect(scheduleRun.installationId).toBe(installation.id);
    expect(scheduleRun.trigger.type).toBe('schedule');
    expect(scheduleRun.trigger.id).toBe(`sch:${scheduleSubscription.id}:${fireAt}`);

    // Two runs total: the event run + the schedule run (both pinning v1).
    const runsAfterSchedule = await support.runs.listRunsInOrganization(t.principal, t.organizationId);
    expect(runsAfterSchedule).toHaveLength(2);

    // --- P3. REVERSE TEACHING derives from the installed version ----------
    const teaching = makeTeachingService();
    const session = teaching.createSession({
      learnerId: LEARNER_ID,
      pin: {
        installationId: installation.id,
        workflowId,
        versionId: version1.id,
        semanticDigest,
      },
    });
    expect(session.status).toBe('not_started');

    // beginLesson with the document READ FROM the installed version (the
    // digest-verified path): the lesson is a VIEW over the installed content.
    const begun = teaching.beginLesson({ sessionId: session.id, document: baselineDocument });
    expect(begun.status).toBe('in_progress');
    expect(begun.lesson!.stepOrder).toEqual([
      'fetch_tickets',
      'scan_board',
      'approve_digest',
      'record_rejection',
      'send_digest',
    ]);
    const stepsById = new Map(begun.lesson!.steps.map((step) => [step.nodeId, step]));
    expect(stepsById.get('fetch_tickets')!.actionability).toBe('system_performed');
    expect(stepsById.get('scan_board')!.actionability).toBe('agent_task');
    expect(stepsById.get('approve_digest')!.actionability).toBe('human_declared');
    expect(stepsById.get('record_rejection')!.actionability).toBe('human_declared');
    expect(stepsById.get('record_rejection')!.safety).toBe('safety_gated');
    expect(stepsById.get('record_rejection')!.sensitiveCapabilities).toEqual(['spreadsheet.edit']);
    expect(stepsById.get('send_digest')!.actionability).toBe('system_performed');

    // The safety gate (V2-008's sensitive-capability vocabulary consumed by
    // V2-010): the spreadsheet.edit step is in canonical position (its three
    // predecessors performed) but the explicit safety acknowledgment is
    // missing — performance is refused typed.
    teaching.performManualStep({
      sessionId: session.id,
      learnerId: LEARNER_ID,
      nodeId: 'fetch_tickets',
      mode: 'acknowledged_disclosure',
      learnerResult: 'acknowledged: the workflow performs this step itself; no manual equivalent is declared.',
    });
    teaching.performManualStep({
      sessionId: session.id,
      learnerId: LEARNER_ID,
      nodeId: 'scan_board',
      mode: 'performed',
      learnerResult: 'I scanned the repository board by hand and summarized the open ticket digest.',
    });
    teaching.performManualStep({
      sessionId: session.id,
      learnerId: LEARNER_ID,
      nodeId: 'approve_digest',
      mode: 'performed',
      learnerResult: 'I read the digest line and approved the report for sending.',
    });
    let safetyRejected = false;
    try {
      teaching.performManualStep({
        sessionId: session.id,
        learnerId: LEARNER_ID,
        nodeId: 'record_rejection',
        mode: 'performed',
        learnerResult: 'premature attempt without the safety acknowledgment',
      });
    } catch (error) {
      safetyRejected = (error as { code?: string }).code === 'SAFETY_ACKNOWLEDGMENT_REQUIRED';
    }
    expect(safetyRejected).toBe(true);

    // The human performs the whole manual lesson in canonical order.
    teaching.acknowledgeStepSafety({ sessionId: session.id, learnerId: LEARNER_ID, nodeId: 'record_rejection' });
    teaching.performManualStep({
      sessionId: session.id,
      learnerId: LEARNER_ID,
      nodeId: 'record_rejection',
      mode: 'performed',
      learnerResult: 'I recorded the digest outcome in the operations log spreadsheet.',
    });
    teaching.performManualStep({
      sessionId: session.id,
      learnerId: LEARNER_ID,
      nodeId: 'send_digest',
      mode: 'acknowledged_disclosure',
      learnerResult: 'acknowledged: the workflow performs this step itself; no manual equivalent is declared.',
    });
    const finalization = teaching.finalizeLesson({ sessionId: session.id, learnerId: LEARNER_ID });
    expect(finalization.sessionStatus).toBe('completed');
    expect(finalization.performedStepCount).toBe(3);
    expect(finalization.disclosureAcknowledgedStepCount).toBe(2);

    // Every teaching evidence record is TEACHING evidence, pinned to the
    // SAME installation's exact version identity (no run concept ever).
    const finalSession = teaching.getSession({ sessionId: session.id, learnerId: LEARNER_ID });
    expect(finalSession.evidence.length).toBeGreaterThan(0);
    for (const record of finalSession.evidence) {
      expect(record.evidenceClass).toBe('teaching');
      expect(record.pin.installationId).toBe(installation.id);
      expect(record.pin.versionId).toBe(version1.id);
      expect(record.pin.workflowId).toBe(workflowId);
    }

    // Teaching created ZERO runs (the execution/teaching distinction): still
    // exactly the two trigger-driven runs.
    const runsAfterTeaching = await support.runs.listRunsInOrganization(t.principal, t.organizationId);
    expect(runsAfterTeaching).toHaveLength(2);

    // --- P4. OPTIMIZATION proposes a NEW version, never a mutation --------
    const optimization = makeOptimizationService();
    const analysis = optimization.analyzeWorkflow(baselineDocument);
    expect(analysis.opportunities).toHaveLength(1);
    const opportunity = analysis.opportunities[0]!;
    expect(opportunity.kind).toBe('api_substitution');
    expect(opportunity.kind === 'api_substitution' ? opportunity.nodeId : '').toBe('scan_board');

    const proposal = optimization.createProposal({
      ownerId: t.ownerUserId,
      workflowId,
      versionId: version1.id,
      document: baselineDocument,
      opportunityNodeId: 'scan_board',
    });
    expect(proposal.status).toBe('proposed');
    // provenance pins the REAL v1 identity (V2-002's version id + V2-003's digest)
    expect(proposal.provenance.baseline.workflowId).toBe(workflowId);
    expect(proposal.provenance.baseline.versionId).toBe(version1.id);
    expect(proposal.provenance.baseline.semanticDigest).toBe(semanticDigest.digest);
    expect(proposal.comparison.correctness.equivalent).toBe(true);
    expect(proposal.comparison.negotiation.decision).toBe('accept');

    const approved = optimization.approveProposal({ proposalId: proposal.id, ownerId: t.ownerUserId });
    expect(approved.status).toBe('approved');

    // Materialization: a REAL new WorkflowVersion through the port (backed
    // by the real V2-002 repository service — the only version authority).
    const { materialization } = await optimization.materializeProposal({
      proposalId: proposal.id,
      ownerId: t.ownerUserId,
    });
    const candidateVersionId = materialization.versionId;
    expect(candidateVersionId).not.toBe(version1.id);

    const candidateRead = await injectJson(
      'GET',
      `/workflow-repository/workflows/${workflowId}/versions/${candidateVersionId}`,
    );
    expect(candidateRead.status).toBe(200);
    const candidateVersion = (candidateRead.body as unknown as { version: VersionPayload }).version;
    expect(candidateVersion.versionNumber).toBe(2);
    expect(candidateVersion.contentDigest).not.toBe(version1.contentDigest);

    // The candidate substitutes ONLY the mechanism: scan_board becomes a
    // deterministic API call; ports/bindings/failure policy verbatim; the
    // human nodes verbatim.
    const candidateParsed = parseWorkflowIrDocument(JSON.stringify(candidateVersion.content));
    expect(candidateParsed.ok, JSON.stringify(candidateParsed)).toBe(true);
    if (!candidateParsed.ok) throw new Error('unreachable');
    const candidateDocument = candidateParsed.document;
    const candidateScan = candidateDocument.ir.nodes.find((node) => node.id === 'scan_board')!;
    const baselineScan = baselineDocument.ir.nodes.find((node) => node.id === 'scan_board')!;
    expect(candidateScan.executionClass).toBe('deterministic_api');
    expect(JSON.stringify(candidateScan.spec)).toBe(
      JSON.stringify({ class: 'deterministic_api', capability: 'github.repository.read' }),
    );
    expect(JSON.stringify(candidateScan.inputs)).toBe(JSON.stringify(baselineScan.inputs));
    expect(JSON.stringify(candidateScan.outputs)).toBe(JSON.stringify(baselineScan.outputs));
    expect(JSON.stringify(candidateScan.failurePolicy)).toBe(JSON.stringify(baselineScan.failurePolicy));
    const candidateRecord = candidateDocument.ir.nodes.find((node) => node.id === 'record_rejection')!;
    const baselineRecord = baselineDocument.ir.nodes.find((node) => node.id === 'record_rejection')!;
    expect(JSON.stringify(candidateRecord.spec)).toBe(JSON.stringify(baselineRecord.spec));

    // NO MUTATION: v1 is byte-identical after the whole gate path.
    const v1ReRead = await injectJson(
      'GET',
      `/workflow-repository/workflows/${workflowId}/versions/${version1.id}`,
    );
    expect(v1ReRead.status).toBe(200);
    expect(v1ReRead.raw).toBe(v1BodyBefore);

    // NEVER ACTIVATED: the installation and the deployment keep pinning v1.
    const installationDetail = await injectJson(
      'GET',
      `/organizations/${t.organizationId}/workflow-repository/installations/${installation.id}`,
    );
    expect(installationDetail.status).toBe(200);
    const installationAfter = (
      installationDetail.body as unknown as { installation: { versionId: string; status: string } }
    ).installation;
    expect(installationAfter.versionId).toBe(version1.id);
    expect(installationAfter.status).toBe('enabled');
    const deploymentAfter = await support.deployments.getDeployment(t.principal, deployment.id);
    expect(deploymentAfter.versionId).toBe(version1.id);
    expect(deploymentAfter.enabled).toBe(true);

    // --- P5. BASELINE and OPTIMIZED versions independently addressable ----
    const baselineReRead = await injectJson(
      'GET',
      `/workflow-repository/workflows/${workflowId}/versions/${version1.id}`,
    );
    expect(baselineReRead.status).toBe(200);
    expect(
      (baselineReRead.body as unknown as { version: VersionPayload }).version.contentDigest,
    ).not.toBe(candidateVersion.contentDigest);
    const versionsList = await injectJson('GET', `/workflow-repository/workflows/${workflowId}/versions`);
    expect(versionsList.status).toBe(200);
    const versions = (versionsList.body as unknown as { versions: VersionPayload[] }).versions;
    expect(versions).toHaveLength(2);
    expect(new Set(versions.map((version) => version.versionNumber))).toEqual(new Set([1, 2]));

    // The optimized version is INDEPENDENTLY EXECUTABLE through the real
    // V2-005 boundary: its run pins v2's exact identity (installationId
    // null — the candidate is never activated by optimization).
    const candidateDigest = computeWorkflowVersionSemanticDigest(candidateDocument);
    const optimizedRunRes = await injectJson('POST', `/organizations/${t.organizationId}/workflow-runs/runs`, {
      commandId: 'cmd-ig004-optimized-run',
      correlationId: 'corr-ig004-optimized-run',
      workflowId,
      versionId: candidateVersionId,
      installationId: null,
      trigger: { type: 'manual', id: 'ig004-optimized-comparison' },
      inputCommitments: [sha256Of('ticketQuery:board-snapshot:ig004')],
    });
    expect(optimizedRunRes.status, optimizedRunRes.raw).toBe(201);
    const optimizedRun = (optimizedRunRes.body as unknown as { run: { id: string } }).run;
    const optimizedRunRecord = await support.runs.getRun(t.principal, optimizedRun.id);
    expect(optimizedRunRecord.versionId).toBe(candidateVersionId);
    expect(optimizedRunRecord.versionContentDigest).toBe(candidateVersion.contentDigest);
    expect(optimizedRunRecord.versionSemanticDigest).toBe(candidateDigest.digest);
    expect(optimizedRunRecord.installationId).toBeNull();

    // Three runs total: event run (v1) + schedule run (v1) + optimized run
    // (v2) — every one pinning an exact immutable version identity.
    const runsFinal = await support.runs.listRunsInOrganization(t.principal, t.organizationId);
    expect(runsFinal).toHaveLength(3);
  });

  it('P3 negative: reverse teaching refuses a document that is NOT the installed version (typed, fail-closed)', async () => {
    const t = await freshGateTenant('pin-mismatch');
    registerNode(support.nodes, 'ig-004-mismatch-device', 'desktop');
    const { workflowId, version: version1 } = await createDigestWorkflow(t, 'ig4-pin-mismatch-wf');

    const installRes = await injectJson(
      'POST',
      `/organizations/${t.organizationId}/workflow-repository/installations`,
      { workflowId, versionId: version1.id },
    );
    expect(installRes.status).toBe(201);
    const installation = (
      installRes.body as unknown as { installation: { id: string; versionId: string } }
    ).installation;

    const v1Read = await injectJson(
      'GET',
      `/workflow-repository/workflows/${workflowId}/versions/${version1.id}`,
    );
    expect(v1Read.status).toBe(200);
    const parsed = parseWorkflowIrDocument(
      JSON.stringify((v1Read.body as unknown as { version: VersionPayload }).version.content),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('unreachable');
    const installedDocument = parsed.document;
    const installedDigest = computeWorkflowVersionSemanticDigest(installedDocument);

    const teaching = makeTeachingService();
    const session = teaching.createSession({
      learnerId: LEARNER_ID,
      pin: {
        installationId: installation.id,
        workflowId,
        versionId: version1.id,
        semanticDigest: installedDigest,
      },
    });

    // A DIFFERENT document (the scan task mutated — a different semantic
    // digest): the lesson must derive from the INSTALLED version, never
    // from caller-supplied content. Authored structurally identical except
    // the task string (no mutation of the frozen parsed document).
    const mutated = authorDigestReportDocument('A DIFFERENT task string entirely.');
    expect(
      computeWorkflowVersionSemanticDigest(mutated).digest,
    ).not.toBe(installedDigest.digest);
    let mismatchRejected = false;
    try {
      teaching.beginLesson({ sessionId: session.id, document: mutated });
    } catch (error) {
      mismatchRejected = (error as { code?: string }).code === 'VERSION_PIN_MISMATCH';
    }
    expect(mismatchRejected).toBe(true);
    // fail-closed: the session was NOT transitioned (still not_started)
    const afterRejection = teaching.getSession({ sessionId: session.id, learnerId: LEARNER_ID });
    expect(afterRejection.status).toBe('not_started');

    // The SAME session accepts the CORRECT installed content afterwards —
    // the rejection was content-pinned, not session-corrupting.
    const begun = teaching.beginLesson({ sessionId: session.id, document: installedDocument });
    expect(begun.status).toBe('in_progress');
    expect(begun.lesson!.stepOrder).toContain('scan_board');
  });
});
